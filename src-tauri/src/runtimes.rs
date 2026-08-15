use crate::paths;
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, MutexGuard, TryLockError};
use serde::Deserialize;
use tauri::AppHandle;
use tauri::Emitter;
use sha2::{Digest, Sha256};
use hex;
use std::time::{SystemTime, UNIX_EPOCH};

const NODE_VERSION: &str = "22.13.0";

fn node_download_url() -> &'static str {
    #[cfg(target_os = "windows")]
    return "https://nodejs.org/dist/v22.13.0/node-v22.13.0-win-x64.zip";

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "https://nodejs.org/dist/v22.13.0/node-v22.13.0-darwin-arm64.tar.gz";

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "https://nodejs.org/dist/v22.13.0/node-v22.13.0-darwin-x64.tar.gz";

    #[cfg(target_os = "linux")]
    return "https://nodejs.org/dist/v22.13.0/node-v22.13.0-linux-x64.tar.gz";
}

// Jintia no reutiliza runtimes globales.
// Los runtimes externos pueden detectarse con fines informativos,
// pero no satisfacen los requisitos del entorno administrado.
pub fn global_node_available() -> bool {
    let checker = if cfg!(target_os = "windows") {
        "where.exe"
    } else {
        "which"
    };

    Command::new(checker)
        .arg("node")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

pub fn resolve_node() -> Option<String> {
    let portable = paths::portable_node_exe();

    if portable.is_file() {
        return Some(portable.to_string_lossy().into_owned());
    }

    None
}

pub fn portable_node_installed() -> bool {
    paths::portable_node_exe().is_file()
}

pub(crate) fn managed_node_command(
    program: impl AsRef<std::ffi::OsStr>,
) -> Command {
    let mut command = Command::new(program);
    command.env_remove("NODE_OPTIONS");
    command
}

fn build_portable_node_version_command(node: &std::path::Path) -> Command {
    let mut command = managed_node_command(node);
    command.arg("--version");
    command
}

pub fn node_version() -> Option<String> {
    resolve_node().and_then(|node_bin| {
        build_portable_node_version_command(std::path::Path::new(&node_bin))
            .output()
            .ok()
            .and_then(|output| {
                if output.status.success() {
                    let raw = if output.stdout.is_empty() { output.stderr } else { output.stdout };
                    String::from_utf8(raw)
                        .ok()
                        .map(|v| v.trim().to_string())
                        .filter(|v| node_version_text_matches_expected(v))
                } else {
                    None
                }
            })
    })
}

static NODE_RUNTIME_MUTATION_LOCK: Mutex<()> = Mutex::new(());
static PYTHON_RUNTIME_MUTATION_LOCK: Mutex<()> = Mutex::new(());
static SKILL_RUNTIME_MUTATION_LOCK: Mutex<()> = Mutex::new(());
static NOTEBOOKLM_RUNTIME_MUTATION_LOCK: Mutex<()> = Mutex::new(());

fn try_runtime_mutation_lock<'a>(
    lock: &'a Mutex<()>,
    resource: &str,
) -> Result<MutexGuard<'a, ()>, String> {
    match lock.try_lock() {
        Ok(guard) => Ok(guard),
        Err(TryLockError::WouldBlock) => Err(format!(
            "Ya hay una operación sobre {resource} en curso."
        )),
        Err(TryLockError::Poisoned(_)) => Err(format!(
            "No se pudo iniciar una operación sobre {resource}: \
             el bloqueo interno quedó invalidado. \
             Reinicia Jintia Desktop y vuelve a intentarlo."
        )),
    }
}

pub fn download_portable_node(app: &AppHandle) -> Result<(), String> {
    let _node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")?;

    let runtimes_dir = paths::portable_runtimes_dir();
    let node_dir = runtimes_dir.join("node");
    let tmp_file = runtimes_dir.join(format!(".node-download-{}.tmp", NODE_VERSION));

    fs::create_dir_all(&runtimes_dir).map_err(|e| format!("Error creando directorio: {e}"))?;

    emit_progress(app, "downloading", 0.0, "Iniciando descarga de Node.js...");

    let url = node_download_url();
    let mut response = reqwest::blocking::get(url)
        .map_err(|e| format!("Error descargando Node.js: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Error descargando Node.js: {e}"))?;

    let total_size = response
        .content_length()
        .unwrap_or(25_000_000u64);

    let mut file = fs::File::create(&tmp_file)
        .map_err(|e| format!("Error creando archivo temporal: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut buffer = [0; 1024 * 64]; // 64KB chunks

    loop {
        match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                if let Err(e) = file.write_all(&buffer[..n]) {
                    let message = format!("Error escribiendo descarga: {e}");
                    drop(file);
                    let _ = fs::remove_file(&tmp_file);
                    emit_progress(app, "error", 0.0, &message);
                    return Err(message);
                }
                downloaded += n as u64;
                let percent = (downloaded as f32 / total_size as f32) * 100.0;
                emit_progress(
                    app,
                    "downloading",
                    percent,
                    &format!("Descargando Node.js ({:.1}%)", percent),
                );
            }
            Err(e) => {
                drop(file);
                let _ = fs::remove_file(&tmp_file);
                emit_progress(app, "error", 0.0, &format!("Error en descarga: {e}"));
                return Err(format!("Error descargando: {e}"));
            }
        }
    }

    drop(file);

    emit_progress(app, "verifying", 100.0, "Verificando integridad del archivo...");
    let expected_checksum = fetch_node_checksum().map_err(|error| {
        let _ = fs::remove_file(&tmp_file);
        emit_progress(app, "error", 100.0, &error);
        error
    })?;
    verify_sha256(&tmp_file, &expected_checksum).map_err(|error| {
        let _ = fs::remove_file(&tmp_file);
        emit_progress(app, "error", 100.0, &error);
        error
    })?;

    let stage_dir = runtimes_dir.join(format!(".node-stage-{NODE_VERSION}"));
    if stage_dir.exists() {
        fs::remove_dir_all(&stage_dir).map_err(|error| {
            let _ = fs::remove_file(&tmp_file);
            let message = format!("Error limpiando staging de Node.js: {error}");
            emit_progress(app, "error", 100.0, &message);
            message
        })?;
    }
    fs::create_dir_all(&stage_dir).map_err(|error| {
        let _ = fs::remove_file(&tmp_file);
        let message = format!("Error creando staging de Node.js: {error}");
        emit_progress(app, "error", 100.0, &message);
        message
    })?;

    emit_progress(app, "extracting", 100.0, "Extrayendo Node.js...");

    let extraction_result = {
        #[cfg(target_os = "windows")]
        {
            extract_zip(&tmp_file, &stage_dir)
        }

        #[cfg(not(target_os = "windows"))]
        {
            extract_node_tar_gz(&tmp_file, &stage_dir)
        }
    };
    if let Err(error) = extraction_result {
        let _ = fs::remove_file(&tmp_file);
        let _ = fs::remove_dir_all(&stage_dir);
        emit_progress(app, "error", 100.0, &error);
        return Err(error);
    }

    let _ = fs::remove_file(&tmp_file);

    let staged_node = stage_dir.join("node");
    if let Err(error) = validate_node_runtime(&staged_node) {
        let _ = fs::remove_dir_all(&stage_dir);
        emit_progress(app, "error", 100.0, &error);
        return Err(error);
    }

    let backup_dir = runtimes_dir.join(format!(".node-backup-{}", paths::timestamp()));
    if let Err(error) = activate_staged_node_runtime(&staged_node, &node_dir, &backup_dir) {
        let _ = fs::remove_dir_all(&stage_dir);
        emit_progress(app, "error", 100.0, &error);
        return Err(error);
    }

    let _ = fs::remove_dir_all(&stage_dir);
    if backup_dir.exists() {
        let _ = fs::remove_dir_all(&backup_dir);
    }

    emit_progress(app, "done", 100.0, "Node.js instalado correctamente.");

    Ok(())
}

fn node_version_text_matches_expected(text: &str) -> bool {
    text.trim() == format!("v{NODE_VERSION}")
}

fn build_staged_node_version_command(node: &std::path::Path) -> Command {
    let mut command = managed_node_command(node);
    command.arg("--version");
    command
}

fn validate_node_runtime(prefix: &std::path::Path) -> Result<(), String> {
    let node_exe = if cfg!(target_os = "windows") {
        prefix.join("node.exe")
    } else {
        prefix.join("bin").join("node")
    };

    if !node_exe.is_file() {
        return Err(format!(
            "El runtime Node extraído no contiene el ejecutable esperado: {}",
            node_exe.display()
        ));
    }

    let output = build_staged_node_version_command(&node_exe)
        .output()
        .map_err(|error| format!("No se pudo ejecutar el Node extraído: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("El Node extraído no pudo informar su versión: {stderr}"));
    }

    let version = if output.stdout.is_empty() {
        String::from_utf8(output.stderr)
            .map_err(|error| format!("Salida inválida del Node extraído: {error}"))?
    } else {
        String::from_utf8(output.stdout)
            .map_err(|error| format!("Salida inválida del Node extraído: {error}"))?
    };

    if !node_version_text_matches_expected(&version) {
        return Err(format!("Versión de Node inesperada: {}", version.trim()));
    }

    Ok(())
}

fn activate_staged_node_runtime(
    staged_node: &std::path::Path,
    node_dir: &std::path::Path,
    backup_dir: &std::path::Path,
) -> Result<(), String> {
    let had_previous_runtime = node_dir.exists();

    if had_previous_runtime {
        fs::rename(node_dir, backup_dir)
            .map_err(|error| format!("Error preparando backup de Node.js: {error}"))?;
    }

    if let Err(error) = fs::rename(staged_node, node_dir) {
        if had_previous_runtime {
            if let Err(restore_error) = fs::rename(backup_dir, node_dir) {
                return Err(format!(
                    "Error activando Node: {error}; además no se pudo restaurar el runtime anterior: {restore_error}"
                ));
            }
        }
        return Err(format!("Error activando Node: {error}"));
    }

    if had_previous_runtime && backup_dir.exists() {
        let _ = fs::remove_dir_all(backup_dir);
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn extract_zip(zip_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    use zip::ZipArchive;
    let file = fs::File::open(zip_path).map_err(|e| format!("Error abriendo ZIP: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Error leyendo ZIP: {e}"))?;
    let mut top_dir = None;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| format!("Error leyendo entrada ZIP: {e}"))?;
        let enclosed = entry.enclosed_name().ok_or_else(|| format!("Ruta insegura en ZIP: {}", entry.name()))?;
        let outpath = dest_dir.join(&enclosed);
        if let Some(first) = enclosed.components().next() {
            if top_dir.is_none() { top_dir = Some(first.as_os_str().to_owned()); }
        }
        if entry.is_dir() {
            fs::create_dir_all(&outpath).map_err(|e| format!("Error creando directorio: {e}"))?;
        } else {
            if let Some(parent) = outpath.parent() { fs::create_dir_all(parent).map_err(|e| format!("Error creando directorio padre: {e}"))?; }
            let mut output = fs::File::create(&outpath).map_err(|e| format!("Error creando archivo: {e}"))?;
            std::io::copy(&mut entry, &mut output).map_err(|e| format!("Error extrayendo archivo: {e}"))?;
        }
    }
    if let Some(top) = top_dir {
        let src = dest_dir.join(top);
        let dst = dest_dir.join("node");
        if src.exists() && src != dst { fs::rename(src, dst).map_err(|e| format!("Error renombrando directorio: {e}"))?; }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn extract_node_tar_gz(
    tar_path: &std::path::Path,
    dest_dir: &std::path::Path,
) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use std::path::{Component, PathBuf};
    use tar::Archive;

    let file = fs::File::open(tar_path)
        .map_err(|error| format!("Error abriendo archive Node: {error}"))?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    let mut node_roots: Vec<PathBuf> = Vec::new();

    let entries = archive
        .entries()
        .map_err(|error| format!("Error leyendo archive Node: {error}"))?;

    for entry_result in entries {
        let mut entry = entry_result
            .map_err(|error| format!("Error leyendo entrada Node: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("Error leyendo ruta de entrada Node: {error}"))?
            .into_owned();

        if path.is_absolute() || path.components().any(|component| component == Component::ParentDir)
        {
            return Err(format!("Ruta insegura rechazada en archive Node: {}", path.display()));
        }

        if let Some(Component::Normal(root)) = path.components().next() {
            if root.to_string_lossy().starts_with("node-v") {
                let root = PathBuf::from(root);
                if !node_roots.contains(&root) {
                    node_roots.push(root);
                }
            }
        }

        let unpacked = entry
            .unpack_in(dest_dir)
            .map_err(|error| format!("Error extrayendo archive Node: {error}"))?;
        if !unpacked {
            return Err(format!("Ruta insegura rechazada en archive Node: {}", path.display()));
        }
    }

    if node_roots.is_empty() {
        return Err("El archive Node no contiene el directorio raíz esperado.".to_string());
    }
    if node_roots.len() > 1 {
        return Err("El archive Node contiene múltiples directorios raíz.".to_string());
    }

    let extracted_root = dest_dir.join(&node_roots[0]);
    if !extracted_root.is_dir() {
        return Err("El archive Node no contiene el directorio raíz esperado.".to_string());
    }

    let dst = dest_dir.join("node");
    if dst.exists() {
        return Err("El staging Node ya contiene un directorio node.".to_string());
    }

    fs::rename(&extracted_root, &dst)
        .map_err(|error| format!("Error normalizando runtime Node: {error}"))?;
    Ok(())
}

fn emit_progress(app: &AppHandle, phase: &str, percent: f32, message: &str) {
    let _ = app.emit(
        "node-download-progress",
        serde_json::json!({
            "phase": phase,
            "percent": percent,
            "message": message,
        }),
    );
}

// ==================== PYTHON RUNTIME ====================

const PYTHON_VERSION: &str = "3.13.15";
const PYTHON_STANDALONE_RELEASE: &str = "20260807";

fn python_standalone_target() -> Result<&'static str, String> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Ok("x86_64-pc-windows-msvc");
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Ok("aarch64-apple-darwin");
    }

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Ok("x86_64-apple-darwin");
    }

    #[allow(unreachable_code)]
    Err("Python administrado no está disponible para esta plataforma.".to_string())
}

fn python_asset_filename() -> Result<String, String> {
    let target = python_standalone_target()?;
    Ok(format!(
        "cpython-{PYTHON_VERSION}+{PYTHON_STANDALONE_RELEASE}-{target}-install_only_stripped.tar.gz"
    ))
}

struct PythonStandaloneAsset {
    filename: String,
    url: String,
    sha256: String,
}

fn python_asset_from_values(
    assets: &[serde_json::Value],
    filename: &str,
) -> Result<Option<PythonStandaloneAsset>, String> {
    let Some(asset) = assets.iter().find(|asset| {
        asset
            .get("name")
            .and_then(|value| value.as_str())
            == Some(filename)
    }) else {
        return Ok(None);
    };

    let url = asset
        .get("browser_download_url")
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("Asset '{filename}' sin browser_download_url"))?
        .to_string();

    let digest_raw = asset
        .get("digest")
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("Asset '{filename}' no tiene digest SHA-256"))?;

    let sha256 = digest_raw
        .strip_prefix("sha256:")
        .ok_or_else(|| format!("Digest inválido para '{filename}': {digest_raw}"))?
        .to_string();

    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("SHA-256 inválido para '{filename}'"));
    }

    Ok(Some(PythonStandaloneAsset {
        filename: filename.to_string(),
        url,
        sha256,
    }))
}

fn resolve_python_asset() -> Result<PythonStandaloneAsset, String> {
    let filename = python_asset_filename()?;

    let release_url = format!(
        "https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/{PYTHON_STANDALONE_RELEASE}"
    );

    let client = reqwest::blocking::Client::builder()
        .user_agent("jintia-desktop")
        .build()
        .map_err(|e| format!("No se pudo crear cliente HTTP: {e}"))?;

    let release_text = client
        .get(&release_url)
        .send()
        .map_err(|e| format!("Error consultando release de Python: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GitHub rechazó consulta de release: {e}"))?
        .text()
        .map_err(|e| format!("Error leyendo respuesta de GitHub: {e}"))?;

    let release: serde_json::Value = serde_json::from_str(&release_text)
        .map_err(|e| format!("Error parseando respuesta de GitHub: {e}"))?;

    let assets_url = release
        .get("assets_url")
        .and_then(|value| value.as_str())
        .ok_or("Respuesta de GitHub sin assets_url")?;

    for page in 1..=20 {
        let page_url = format!("{assets_url}?per_page=100&page={page}");

        let assets_text = client
            .get(&page_url)
            .send()
            .map_err(|e| format!("Error consultando assets de Python: {e}"))?
            .error_for_status()
            .map_err(|e| format!("GitHub rechazó la consulta de assets: {e}"))?
            .text()
            .map_err(|e| format!("Error leyendo assets de Python: {e}"))?;

        let assets: Vec<serde_json::Value> = serde_json::from_str(&assets_text)
            .map_err(|e| format!("Error parseando assets de Python: {e}"))?;

        if assets.is_empty() {
            break;
        }

        if let Some(asset) = python_asset_from_values(&assets, &filename)? {
            return Ok(asset);
        }
    }

    Err(format!(
        "Asset '{filename}' no encontrado en release {PYTHON_STANDALONE_RELEASE}"
    ))
}

fn extract_python_tar_gz(
    archive_path: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let file = fs::File::open(archive_path)
        .map_err(|e| format!("No se pudo abrir el runtime Python: {e}"))?;

    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);

    let canonical_dest = destination
        .canonicalize()
        .unwrap_or_else(|_| destination.to_path_buf());

    for entry in archive
        .entries()
        .map_err(|e| format!("Error leyendo entradas del archive: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("Error en entrada del archive: {e}"))?;
        let entry_path = entry
            .path()
            .map_err(|e| format!("Ruta inválida en archive: {e}"))?
            .to_path_buf();

        if entry_path.is_absolute() {
            return Err(format!(
                "Ruta absoluta rechazada en archive: {}",
                entry_path.display()
            ));
        }

        let components: Vec<_> = entry_path.components().collect();
        for component in &components {
            if matches!(component, std::path::Component::ParentDir) {
                return Err(format!(
                    "Path traversal rechazado en archive: {}",
                    entry_path.display()
                ));
            }
        }

        let out = destination.join(&entry_path);

        let canonical_out = out
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .map(|p| p.join(out.file_name().unwrap_or_default()))
            .unwrap_or_else(|| out.clone());

        if !canonical_out.starts_with(&canonical_dest) {
            return Err(format!(
                "Ruta fuera del directorio destino rechazada: {}",
                entry_path.display()
            ));
        }

        entry
            .unpack(&out)
            .map_err(|e| format!("No se pudo extraer Python: {e}"))?;
    }

    Ok(())
}

fn validate_python_runtime(prefix: &std::path::Path) -> Result<(), String> {
    let python_exe = if cfg!(target_os = "windows") {
        prefix.join("python.exe")
    } else {
        prefix.join("bin").join("python3")
    };

    if !python_exe.is_file() {
        return Err(format!(
            "Ejecutable Python no encontrado en {}",
            python_exe.display()
        ));
    }

    let version_out = managed_python_command(&python_exe)
        .arg("--version")
        .output()
        .map_err(|e| format!("No se pudo ejecutar python --version: {e}"))?;

    if !version_out.status.success() {
        let stderr = String::from_utf8_lossy(&version_out.stderr);
        return Err(format!(
            "El Python extraído no pudo informar su versión: {}",
            stderr.trim()
        ));
    }

    let version_text = String::from_utf8_lossy(
        if version_out.stdout.is_empty() {
            &version_out.stderr
        } else {
            &version_out.stdout
        }
    );

    if !python_version_text_matches_expected(&version_text) {
        return Err(format!(
            "Versión de Python inesperada: {}",
            version_text.trim()
        ));
    }

    let pip_out = managed_python_command(&python_exe)
        .args(["-m", "pip", "--version"])
        .output()
        .map_err(|e| format!("No se pudo ejecutar python -m pip --version: {e}"))?;

    if !pip_out.status.success() {
        let stderr = String::from_utf8_lossy(&pip_out.stderr);
        return Err(format!("pip no está operativo: {}", stderr.trim()));
    }

    Ok(())
}

fn python_version_text_matches_expected(text: &str) -> bool {
    text.trim() == format!("Python {PYTHON_VERSION}")
}

fn activate_staged_python_runtime(
    staged_python: &std::path::Path,
    python_dir: &std::path::Path,
    backup_dir: &std::path::Path,
    mut validate: impl FnMut(&std::path::Path) -> Result<(), String>,
) -> Result<(), String> {
    let had_previous_runtime = python_dir.exists();

    // Mueve el runtime anterior al respaldo antes de activar el nuevo.
    if had_previous_runtime {
        fs::rename(python_dir, backup_dir)
            .map_err(|e| format!("Error preparando reemplazo de Python: {e}"))?;
    }

    // Mueve el staging a la ubicación definitiva.
    if let Err(activation_error) = fs::rename(staged_python, python_dir) {
        if had_previous_runtime {
            if let Err(restore_error) = fs::rename(backup_dir, python_dir) {
                return Err(format!(
                    "Error activando Python: {activation_error}; además no se pudo restaurar el runtime anterior: {restore_error}"
                ));
            }
        }
        return Err(format!("Error activando Python: {activation_error}"));
    }

    // Valida desde la ubicación definitiva; el respaldo se conserva hasta aquí.
    if let Err(validation_error) = validate(python_dir) {
        let discard = python_dir.with_extension("invalid");
        let _ = fs::rename(python_dir, &discard);
        let _ = fs::remove_dir_all(&discard);
        if had_previous_runtime {
            if let Err(restore_error) = fs::rename(backup_dir, python_dir) {
                return Err(format!(
                    "El runtime Python activado no superó la verificación final: {validation_error}; \
                     además no se pudo restaurar el runtime anterior: {restore_error}"
                ));
            }
        }
        return Err(format!(
            "El runtime Python activado no superó la verificación final: {validation_error}"
        ));
    }

    // Solo elimina el respaldo después de que la ubicación definitiva esté validada.
    if had_previous_runtime && backup_dir.exists() {
        let _ = fs::remove_dir_all(backup_dir);
    }

    Ok(())
}

fn global_python_command() -> Option<String> {
    let checker = if cfg!(target_os = "windows") {
        "where.exe"
    } else {
        "which"
    };

    for command in ["python3", "python"] {
        if Command::new(checker)
            .arg(command)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
        {
            return Some(command.to_string());
        }
    }

    None
}

pub fn global_python_available() -> bool {
    global_python_command().is_some()
}

pub fn resolve_python() -> Option<String> {
    let portable = paths::portable_python_exe();

    if portable.is_file() {
        return Some(portable.to_string_lossy().into_owned());
    }

    None
}

pub fn portable_python_installed() -> bool {
    paths::portable_python_exe().is_file()
}

pub(crate) fn managed_python_command(python: &std::path::Path) -> Command {
    let mut command = Command::new(python);
    command.arg("-I");
    command
}

fn build_portable_python_version_command(python: &std::path::Path) -> Command {
    let mut command = managed_python_command(python);
    command.arg("--version");
    command
}

pub fn python_version() -> Option<String> {
    resolve_python().and_then(|python_bin| {
        build_portable_python_version_command(std::path::Path::new(&python_bin))
            .output()
            .ok()
            .and_then(|output| {
                if output.status.success() {
                    let raw = if output.stdout.is_empty() { output.stderr } else { output.stdout };
                    String::from_utf8(raw)
                        .ok()
                        .map(|v| v.trim().to_string())
                        .filter(|v| python_version_text_matches_expected(v))
                } else {
                    None
                }
            })
    })
}

pub fn download_portable_python(app: &AppHandle) -> Result<(), String> {
    let _python_guard = try_runtime_mutation_lock(&PYTHON_RUNTIME_MUTATION_LOCK, "el runtime Python administrado")?;

    let runtimes_dir = paths::portable_runtimes_dir();
    fs::create_dir_all(&runtimes_dir)
        .map_err(|e| format!("Error creando directorio: {e}"))?;

    emit_python_progress(app, "resolving", 0.0, "Resolviendo asset de Python...");

    let asset = resolve_python_asset()?;

    let tmp_archive = runtimes_dir.join(format!(".python-download-{}.tmp", PYTHON_VERSION));

    emit_python_progress(app, "downloading", 5.0, &format!("Descargando {}...", asset.filename));

    let mut response = reqwest::blocking::get(&asset.url)
        .map_err(|e| format!("Error descargando Python: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Error descargando Python: {e}"))?;

    let total_size = response.content_length().unwrap_or(30_000_000u64);
    let mut file = fs::File::create(&tmp_archive)
        .map_err(|e| format!("Error creando archivo temporal: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut buffer = [0; 1024 * 64];

    loop {
        match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                if let Err(e) = file.write_all(&buffer[..n]) {
                    let message = format!("Error escribiendo descarga: {e}");
                    drop(file);
                    let _ = fs::remove_file(&tmp_archive);
                    emit_python_progress(app, "error", 0.0, &message);
                    return Err(message);
                }
                downloaded += n as u64;
                let percent = 5.0 + (downloaded as f32 / total_size as f32) * 55.0;
                emit_python_progress(
                    app,
                    "downloading",
                    percent,
                    &format!("Descargando Python ({:.1}%)", percent),
                );
            }
            Err(e) => {
                drop(file);
                let _ = fs::remove_file(&tmp_archive);
                emit_python_progress(app, "error", 0.0, &format!("Error en descarga: {e}"));
                return Err(format!("Error descargando: {e}"));
            }
        }
    }

    drop(file);

    emit_python_progress(app, "verifying", 62.0, "Verificando SHA-256...");
    verify_sha256(&tmp_archive, &asset.sha256).map_err(|e| {
        let _ = fs::remove_file(&tmp_archive);
        e
    })?;

    let stage_dir = runtimes_dir.join(format!(".python-stage-{}", PYTHON_VERSION));
    if stage_dir.exists() {
        fs::remove_dir_all(&stage_dir)
            .map_err(|e| format!("Error limpiando staging: {e}"))?;
    }
    fs::create_dir_all(&stage_dir)
        .map_err(|e| format!("Error creando staging: {e}"))?;

    emit_python_progress(app, "extracting", 65.0, "Extrayendo Python...");
    extract_python_tar_gz(&tmp_archive, &stage_dir).map_err(|e| {
        let _ = fs::remove_file(&tmp_archive);
        let _ = fs::remove_dir_all(&stage_dir);
        e
    })?;

    let _ = fs::remove_file(&tmp_archive);

    // El archive tiene estructura python/... dentro del tar
    let staged_python = stage_dir.join("python");
    if !staged_python.is_dir() {
        let _ = fs::remove_dir_all(&stage_dir);
        return Err("El archive no contiene el directorio 'python/' esperado".to_string());
    }

    emit_python_progress(app, "validating", 85.0, "Validando runtime Python...");
    validate_python_runtime(&staged_python).map_err(|e| {
        let _ = fs::remove_dir_all(&stage_dir);
        e
    })?;

    let python_dir = paths::portable_python_prefix();
    let backup_dir = runtimes_dir.join(format!(".python-backup-{}", paths::timestamp()));

    emit_python_progress(app, "activating", 92.0, "Verificando Python en su ubicación final…");

    if let Err(error) = activate_staged_python_runtime(
        &staged_python,
        &python_dir,
        &backup_dir,
        validate_python_runtime,
    ) {
        let _ = fs::remove_dir_all(&stage_dir);
        return Err(error);
    }

    let _ = fs::remove_dir_all(&stage_dir);

    emit_python_progress(app, "done", 100.0, "Python instalado correctamente.");
    Ok(())
}

fn emit_python_progress(app: &AppHandle, phase: &str, percent: f32, message: &str) {
    let _ = app.emit(
        "python-download-progress",
        serde_json::json!({
            "phase": phase,
            "percent": percent,
            "message": message,
        }),
    );
}

// ==================== PIP PACKAGES ====================

pub fn install_pip_packages(packages: &[String]) -> Result<(), String> {
    if packages.is_empty() {
        return Ok(());
    }
    let _python_guard = try_runtime_mutation_lock(&PYTHON_RUNTIME_MUTATION_LOCK, "el runtime Python administrado")?;
    let python_exe = paths::portable_python_exe();
    if !python_exe.is_file() {
        return Err("Python portable no está instalado.".to_string());
    }
    let managed_path = managed_python_runtime_path()?;
    let output = build_managed_pip_install_command(
        &python_exe,
        &managed_path,
        packages,
    )
        .output()
        .map_err(|e| format!("Error ejecutando pip: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pip install falló: {stderr}"));
    }
    Ok(())
}

fn managed_python_runtime_path() -> Result<OsString, String> {
    let prefix = paths::portable_python_prefix();
    let entries = if cfg!(target_os = "windows") {
        vec![prefix.clone(), prefix.join("Scripts")]
    } else {
        vec![prefix.join("bin")]
    };

    std::env::join_paths(entries)
        .map_err(|error| format!("No se pudo construir el PATH del Python administrado: {error}"))
}

fn build_managed_pip_install_command(
    python: &std::path::Path,
    managed_path: &std::ffi::OsStr,
    packages: &[String],
) -> Command {
    let mut command = managed_python_command(python);
    command
        .args(["-m", "pip", "install", "--quiet"])
        .args(packages)
        .env("PATH", managed_path);
    command
}

// ==================== NPM PACKAGES ====================

fn notebooklm_lock_entry<'a>(lock: &'a serde_json::Value, package_name: &str) -> Option<&'a serde_json::Value> {
    let key = format!("node_modules/{package_name}");
    lock.get("packages")?.get(&key)
}

fn notebooklm_package_dir(prefix: &std::path::Path, package: &str) -> PathBuf {
    prefix.join("node_modules").join(package)
}

pub(crate) fn portable_notebooklm_mcp_package_dir_for(package: &str) -> PathBuf {
    notebooklm_package_dir(&paths::portable_notebooklm_mcp_prefix(), package)
}

fn notebooklm_package_matches_contract(
    package: &serde_json::Value,
    lock: &serde_json::Value,
    contract: &crate::release::ManagedMcpContract,
) -> bool {
    package.get("name").and_then(|v| v.as_str()) == Some(contract.package.as_str())
        && package.get("version").and_then(|v| v.as_str()) == Some(contract.version.as_str())
        && notebooklm_lock_entry(lock, &contract.package)
            .and_then(|entry| entry.get("version"))
            .and_then(|v| v.as_str()) == Some(contract.version.as_str())
        && notebooklm_lock_entry(lock, &contract.package)
            .and_then(|entry| entry.get("integrity"))
            .and_then(|v| v.as_str()) == Some(contract.npm_integrity.as_str())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookLmBrowserStatus {
    browser: String,
    installed: bool,
    hermetic: bool,
    executable_path: Option<PathBuf>,
}

pub fn resolve_notebooklm_mcp_bin_for(package_dir: &std::path::Path, contract: &crate::release::ManagedMcpContract) -> Result<PathBuf, String> {
    let package_path = package_dir.join("package.json");
    let package: serde_json::Value = serde_json::from_slice(
        &fs::read(&package_path).map_err(|e| format!("No se pudo leer package.json del MCP: {e}"))?,
    ).map_err(|e| format!("package.json del MCP inválido: {e}"))?;
    if package.get("name").and_then(|v| v.as_str()) != Some(contract.package.as_str())
        || package.get("version").and_then(|v| v.as_str()) != Some(contract.version.as_str())
    {
        return Err("package.json del MCP no coincide con el contrato aprobado.".to_string());
    }
    let bin = package.get("bin").and_then(|value| value.as_str().map(str::to_owned).or_else(|| {
        value.get(contract.package.rsplit('/').next().unwrap_or_default())
            .and_then(|v| v.as_str()).map(str::to_owned)
    })).ok_or("El MCP no expone su bin público administrado.")?;
    if bin.trim().is_empty() || std::path::Path::new(&bin).is_absolute() || bin.split(['/', '\\']).any(|part| part == "..") {
        return Err("El bin público del MCP no es una ruta segura.".to_string());
    }
    let candidate = package_dir.join(bin);
    let root = fs::canonicalize(package_dir).map_err(|e| format!("No se pudo resolver el paquete MCP: {e}"))?;
    let resolved = fs::canonicalize(&candidate).map_err(|e| format!("El bin público del MCP no existe: {e}"))?;
    if !resolved.starts_with(&root) || !resolved.is_file() {
        return Err("El bin público del MCP escapa de su paquete o no es un archivo.".to_string());
    }
    Ok(resolved)
}

fn validate_browser_status(status: &NotebookLmBrowserStatus, managed_root: &std::path::Path) -> Result<(), String> {
    if status.browser != "chromium" || !status.installed || !status.hermetic {
        return Err("El MCP no confirmó un Chromium hermético instalado.".to_string());
    }
    let executable = status.executable_path.as_ref().ok_or("El MCP no devolvió executablePath.")?;
    if !executable.is_file() {
        return Err("El executablePath del Chromium no existe.".to_string());
    }
    let root = fs::canonicalize(managed_root).map_err(|e| format!("No se pudo resolver el runtime MCP: {e}"))?;
    let executable = fs::canonicalize(executable).map_err(|e| format!("No se pudo resolver Chromium: {e}"))?;
    if !executable.starts_with(&root) {
        return Err("El Chromium del MCP está fuera del runtime administrado.".to_string());
    }
    Ok(())
}

fn build_managed_notebooklm_browser_command(
    node: &std::path::Path,
    bin: &std::path::Path,
    managed_path: &std::ffi::OsStr,
    action: &str,
) -> Command {
    let mut command = managed_node_command(node);
    command
        .arg(bin)
        .args(["browser", action, "--json"])
        .env("PATH", managed_path);
    command
}

fn run_notebooklm_browser_command(node: &std::path::Path, bin: &std::path::Path, action: &str) -> Result<NotebookLmBrowserStatus, String> {
    let managed_path = managed_node_runtime_path()?;
    let output = build_managed_notebooklm_browser_command(node, bin, &managed_path, action)
        .output()
        .map_err(|e| format!("No se pudo ejecutar el bin público del MCP: {e}"))?;
    if !output.status.success() {
        return Err(format!("MCP browser {action} falló: {}", String::from_utf8_lossy(&output.stderr)));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("Respuesta JSON inválida de MCP browser {action}: {e}"))
}

fn validate_notebooklm_browser(node: &std::path::Path, package_dir: &std::path::Path, managed_root: &std::path::Path, action: &str, contract: &crate::release::ManagedMcpContract) -> Result<(), String> {
    let bin = resolve_notebooklm_mcp_bin_for(package_dir, contract)?;
    let status = run_notebooklm_browser_command(node, &bin, action)?;
    validate_browser_status(&status, managed_root)
}

fn build_managed_notebooklm_npm_command(
    node: &std::path::Path,
    npm_cli: &std::path::Path,
    stage: &std::path::Path,
    managed_path: &std::ffi::OsStr,
    args: &[&str],
) -> Command {
    let mut command = managed_node_command(node);
    command
        .arg(npm_cli)
        .args(args)
        .current_dir(stage)
        .env("PATH", managed_path);
    command
}

fn activate_staged_notebooklm_mcp<F>(
    stage: &std::path::Path,
    active: &std::path::Path,
    backup: &std::path::Path,
    validate_active: F,
) -> Result<(), String>
where
    F: FnOnce(&std::path::Path) -> Result<(), String>,
{
    let had_previous_runtime = active.exists();

    if had_previous_runtime {
        fs::rename(active, backup)
            .map_err(|e| format!("Error preparando reemplazo de NotebookLM MCP: {e}"))?;
    }

    if let Err(activation_error) = fs::rename(stage, active) {
        if had_previous_runtime {
            if let Err(restore_error) = fs::rename(backup, active) {
                return Err(format!(
                    "Error activando NotebookLM MCP: {activation_error}; además no se pudo restaurar el runtime anterior: {restore_error}"
                ));
            }
        }

        return Err(format!("Error activando NotebookLM MCP: {activation_error}"));
    }

    if let Err(validation_error) = validate_active(active) {
        if let Err(cleanup_error) = fs::remove_dir_all(active) {
            return Err(format!(
                "NotebookLM MCP no pasó validación post-activación: {validation_error}; además no se pudo retirar el runtime inválido: {cleanup_error}; el backup anterior se conserva en {}",
                backup.display()
            ));
        }

        if had_previous_runtime {
            if let Err(restore_error) = fs::rename(backup, active) {
                return Err(format!(
                    "NotebookLM MCP no pasó validación post-activación: {validation_error}; además no se pudo restaurar el runtime anterior: {restore_error}"
                ));
            }
        }

        return Err(format!(
            "NotebookLM MCP no pasó validación post-activación: {validation_error}"
        ));
    }

    if had_previous_runtime && backup.exists() {
        let _ = fs::remove_dir_all(backup);
    }

    Ok(())
}

pub fn portable_notebooklm_mcp_installed_for(contract: &crate::release::ManagedMcpContract) -> bool {
    let package_dir = portable_notebooklm_mcp_package_dir_for(&contract.package);
    let package = package_dir.join("package.json");
    let lock = paths::portable_notebooklm_mcp_lock();
    let Ok(package) = fs::read_to_string(package) else { return false; };
    let Ok(package) = serde_json::from_str::<serde_json::Value>(&package) else { return false; };
    let Ok(lock) = fs::read_to_string(lock) else { return false; };
    let Ok(lock) = serde_json::from_str::<serde_json::Value>(&lock) else { return false; };
    notebooklm_package_matches_contract(&package, &lock, contract)
        && resolve_notebooklm_mcp_bin_for(&package_dir, contract).is_ok()
        && validate_notebooklm_browser(&paths::portable_node_exe(), &package_dir, &paths::portable_notebooklm_mcp_prefix().join("node_modules"), "status", contract).is_ok()
}

pub fn install_notebooklm_mcp() -> Result<(), String> {
    let _mcp_guard = try_runtime_mutation_lock(&NOTEBOOKLM_RUNTIME_MUTATION_LOCK, "el runtime NotebookLM MCP administrado")?;
    let _node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")?;
    let contract = crate::release::managed_mcp_contract()?;
    let node = paths::portable_node_exe();
    let npm = paths::portable_npm_cli();
    if !node.is_file() || !npm.is_file() {
        return Err("NotebookLM MCP requiere Node.js y npm administrados por Jintia.".to_string());
    }
    let root = paths::portable_runtimes_dir();
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let stage = root.join(format!(".notebooklm-mcp-stage-{}", paths::timestamp()));
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let managed_path = managed_node_runtime_path()?;
    let package = serde_json::json!({"private": true, "dependencies": {contract.package.clone(): contract.version.clone()}});
    let result = (|| -> Result<(), String> {
        fs::write(stage.join("package.json"), serde_json::to_vec_pretty(&package).unwrap()).map_err(|e| e.to_string())?;
        let run = |args: &[&str]| -> Result<(), String> {
            let output = build_managed_notebooklm_npm_command(
                &node,
                &npm,
                &stage,
                &managed_path,
                args,
            )
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).to_string()); }
            Ok(())
        };
        run(&["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"])?;
        let lock: serde_json::Value = serde_json::from_slice(&fs::read(stage.join("package-lock.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let entry = notebooklm_lock_entry(&lock, &contract.package).ok_or("El lock de NotebookLM MCP no contiene el paquete.")?;
        if entry.get("version").and_then(|v| v.as_str()) != Some(contract.version.as_str()) || entry.get("integrity").and_then(|v| v.as_str()) != Some(contract.npm_integrity.as_str()) { return Err("El integrity de NotebookLM MCP no coincide con el contrato administrado de Jintia.".to_string()); }
        run(&["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"])?;
        let package_dir = notebooklm_package_dir(&stage, &contract.package);
        validate_notebooklm_browser(&node, &package_dir, &stage.join("node_modules"), "install", &contract)?;
        validate_notebooklm_browser(&node, &package_dir, &stage.join("node_modules"), "status", &contract)?;
        let active = paths::portable_notebooklm_mcp_prefix();
        let backup = root.join(format!(".notebooklm-mcp-backup-{}", paths::timestamp()));
        activate_staged_notebooklm_mcp(
            &stage,
            &active,
            &backup,
            |active_root| {
                let active_package = notebooklm_package_dir(active_root, &contract.package);
                validate_notebooklm_browser(
                    &node,
                    &active_package,
                    &active_root.join("node_modules"),
                    "status",
                    &contract,
                )
            },
        )
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&stage); }
    result
}

#[cfg(test)]
mod tests {
    use super::{activate_staged_node_runtime, activate_staged_notebooklm_mcp, activate_staged_python_runtime, build_managed_node_cli_version_command, build_managed_notebooklm_browser_command, build_managed_notebooklm_npm_command, build_managed_npm_install_command, build_managed_pip_install_command, build_portable_node_version_command, build_portable_python_version_command, build_staged_node_version_command, install_npm_packages, install_pip_packages, managed_node_command, managed_node_runtime_path, managed_python_command, managed_python_runtime_path, node_checksum_from_manifest, node_version_text_matches_expected, notebooklm_lock_entry, notebooklm_package_matches_contract, python_version_text_matches_expected, resolve_notebooklm_mcp_bin_for, try_runtime_mutation_lock, verify_sha256, NODE_RUNTIME_MUTATION_LOCK, NOTEBOOKLM_RUNTIME_MUTATION_LOCK, PYTHON_RUNTIME_MUTATION_LOCK, SKILL_RUNTIME_MUTATION_LOCK};
    use crate::paths;
    #[cfg(target_os = "windows")]
    use super::extract_zip;
    #[cfg(not(target_os = "windows"))]
    use super::extract_node_tar_gz;
    use std::fs;

    #[test]
    fn managed_node_command_uses_exact_program() {
        let command = managed_node_command(std::path::Path::new("managed-program"));
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-program"));
    }

    #[test]
    fn managed_node_command_removes_node_options() {
        let command = managed_node_command(std::path::Path::new("managed-program"));
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn managed_node_command_starts_without_arguments() {
        let command = managed_node_command(std::path::Path::new("managed-program"));
        assert_eq!(command.get_args().count(), 0);
    }

    #[test]
    fn managed_node_command_does_not_override_current_dir() {
        let command = managed_node_command(std::path::Path::new("managed-program"));
        assert_eq!(command.get_current_dir(), None);
    }

    #[test]
    fn managed_python_command_uses_exact_program() {
        let command = managed_python_command(std::path::Path::new("managed-python"));
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-python"));
    }

    #[test]
    fn managed_python_command_starts_with_only_isolated_mode_argument() {
        let command = managed_python_command(std::path::Path::new("managed-python"));
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, vec![std::ffi::OsStr::new("-I")]);
    }

    #[test]
    fn managed_python_command_does_not_override_current_dir() {
        let command = managed_python_command(std::path::Path::new("managed-python"));
        assert_eq!(command.get_current_dir(), None);
    }

    #[test]
    fn portable_python_version_command_uses_isolated_mode_and_version_argument() {
        let command = build_portable_python_version_command(std::path::Path::new("managed-python"));
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-python"));
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, vec!["-I", "--version"]);
    }

    #[test]
    fn runtime_install_lock_rejects_overlapping_operation() {
        let lock = std::sync::Mutex::new(());
        let guard = try_runtime_mutation_lock(&lock, "el runtime Node administrado")
            .expect("primera adquisición debe ser Ok");
        let result = try_runtime_mutation_lock(&lock, "el runtime Node administrado");
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "Ya hay una operación sobre el runtime Node administrado en curso."
        );
        drop(guard);
    }

    #[test]
    fn runtime_install_lock_allows_retry_after_guard_drop() {
        let lock = std::sync::Mutex::new(());
        let guard = try_runtime_mutation_lock(&lock, "el runtime Python administrado")
            .expect("primera adquisición debe ser Ok");
        drop(guard);
        let result = try_runtime_mutation_lock(&lock, "el runtime Python administrado");
        assert!(result.is_ok());
    }

    #[test]
    fn node_and_python_runtime_install_locks_are_independent() {
        let node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")
            .expect("lock Node debe estar libre");
        let python_guard = try_runtime_mutation_lock(&PYTHON_RUNTIME_MUTATION_LOCK, "el runtime Python administrado")
            .expect("lock Python debe estar libre mientras Node está ocupado");
        drop(node_guard);
        drop(python_guard);
    }

    #[test]
    fn skill_and_notebooklm_runtime_mutation_locks_are_independent() {
        let skill_guard = try_runtime_mutation_lock(&SKILL_RUNTIME_MUTATION_LOCK, "el runtime Jintia administrado")
            .expect("lock Skill debe estar libre");
        let mcp_guard = try_runtime_mutation_lock(&NOTEBOOKLM_RUNTIME_MUTATION_LOCK, "el runtime NotebookLM MCP administrado")
            .expect("lock NotebookLM MCP debe estar libre mientras Skill está ocupado");
        drop(skill_guard);
        drop(mcp_guard);
    }

    #[test]
    fn node_runtime_mutation_lock_is_shared_by_node_dependents() {
        let node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")
            .expect("primera adquisición debe ser Ok");
        let result = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado");
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "Ya hay una operación sobre el runtime Node administrado en curso."
        );
        drop(node_guard);
    }

    #[test]
    fn python_runtime_mutation_lock_serializes_prefix_mutations() {
        let python_guard = try_runtime_mutation_lock(&PYTHON_RUNTIME_MUTATION_LOCK, "el runtime Python administrado")
            .expect("primera adquisición debe ser Ok");
        let result = try_runtime_mutation_lock(&PYTHON_RUNTIME_MUTATION_LOCK, "el runtime Python administrado");
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "Ya hay una operación sobre el runtime Python administrado en curso."
        );
        drop(python_guard);
    }

    #[test]
    fn managed_npm_install_command_removes_node_options() {
        let command = build_managed_npm_install_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-prefix"),
            std::ffi::OsStr::new("managed-only-bin"),
            &["some-package".to_string()],
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn managed_node_runtime_path_contains_only_portable_node_bin() {
        let path = managed_node_runtime_path().unwrap();
        let entries: Vec<std::path::PathBuf> = std::env::split_paths(&path).collect();
        assert_eq!(entries, vec![paths::portable_node_bin_dir()]);
    }

    #[test]
    fn managed_python_runtime_path_contains_only_portable_python_dirs() {
        let path = managed_python_runtime_path().unwrap();
        let entries: Vec<std::path::PathBuf> = std::env::split_paths(&path).collect();
        let prefix = paths::portable_python_prefix();
        let expected = if cfg!(target_os = "windows") {
            vec![prefix.clone(), prefix.join("Scripts")]
        } else {
            vec![prefix.join("bin")]
        };

        assert_eq!(entries, expected);
    }

    #[test]
    fn managed_pip_command_uses_portable_python_module() {
        let packages = vec!["pkg-a".to_string()];
        let command = build_managed_pip_install_command(
            std::path::Path::new("managed-python"),
            std::ffi::OsStr::new("managed-python-only"),
            &packages,
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-python"));
        assert_eq!(&args[..5], ["-I", "-m", "pip", "install", "--quiet"]);
    }

    #[test]
    fn managed_pip_command_uses_python_isolated_mode() {
        let command = build_managed_pip_install_command(
            std::path::Path::new("managed-python"),
            std::ffi::OsStr::new("managed-only"),
            &[],
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(&args[..5], ["-I", "-m", "pip", "install", "--quiet"]);
    }

    #[test]
    fn managed_pip_command_uses_only_managed_path() {
        let command = build_managed_pip_install_command(
            std::path::Path::new("managed-python"),
            std::ffi::OsStr::new("managed-python-only"),
            &[],
        );
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH administrado");

        assert_eq!(path, std::ffi::OsStr::new("managed-python-only"));
        assert!(!path.to_string_lossy().contains("host-only-bin"));
    }

    #[test]
    fn managed_pip_command_preserves_package_arguments() {
        let packages = vec![
            "package-a>=1".to_string(),
            "package-b[extra]==2.0".to_string(),
        ];
        let command = build_managed_pip_install_command(
            std::path::Path::new("managed-python"),
            std::ffi::OsStr::new("managed-python-only"),
            &packages,
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(&args[5..], ["package-a>=1", "package-b[extra]==2.0"]);
    }

    #[test]
    fn install_pip_packages_empty_input_is_noop() {
        assert!(install_pip_packages(&[]).is_ok());
    }

    #[test]
    fn node_checksum_manifest_resolves_exact_asset() {
        let manifest = format!(
            "{}  node-v22.13.0-win-x64.zip\n{}  node-v22.13.0-darwin-arm64.tar.gz\n",
            "a".repeat(64),
            "b".repeat(64),
        );

        assert_eq!(
            node_checksum_from_manifest(&manifest, "node-v22.13.0-darwin-arm64.tar.gz")
                .unwrap(),
            "b".repeat(64)
        );
    }

    #[test]
    fn node_checksum_manifest_rejects_missing_asset() {
        let manifest = format!("{}  node-v22.13.0-win-x64.zip\n", "a".repeat(64));
        let error = node_checksum_from_manifest(&manifest, "node-v22.13.0-linux-x64.tar.gz")
            .unwrap_err();

        assert!(error.contains("Checksum no encontrado"));
    }

    #[test]
    fn node_checksum_manifest_rejects_malformed_sha256() {
        let short = node_checksum_from_manifest(
            "abc123  node-v22.13.0-win-x64.zip\n",
            "node-v22.13.0-win-x64.zip",
        )
        .unwrap_err();
        let non_hex = node_checksum_from_manifest(
            &format!("{}  node-v22.13.0-win-x64.zip\n", "g".repeat(64)),
            "node-v22.13.0-win-x64.zip",
        )
        .unwrap_err();

        assert!(short.contains("Checksum SHA-256 inválido"));
        assert!(non_hex.contains("Checksum SHA-256 inválido"));
    }

    #[test]
    fn node_checksum_manifest_rejects_duplicate_asset() {
        let manifest = format!(
            "{}  node-v22.13.0-win-x64.zip\n{}  node-v22.13.0-win-x64.zip\n",
            "a".repeat(64),
            "b".repeat(64),
        );
        let error = node_checksum_from_manifest(&manifest, "node-v22.13.0-win-x64.zip")
            .unwrap_err();

        assert!(error.contains("Checksum duplicado"));
    }

    #[test]
    fn verify_sha256_accepts_matching_digest() {
        let path = std::env::temp_dir().join(format!(
            "jintia-node-checksum-matching-{}",
            std::process::id()
        ));
        fs::write(&path, []).unwrap();

        let result = verify_sha256(
            &path,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
        let _ = fs::remove_file(&path);

        assert!(result.is_ok());
    }

    #[test]
    fn verify_sha256_rejects_mismatch() {
        let path = std::env::temp_dir().join(format!(
            "jintia-node-checksum-mismatch-{}",
            std::process::id()
        ));
        fs::write(&path, []).unwrap();

        let result = verify_sha256(&path, &"a".repeat(64));
        let _ = fs::remove_file(&path);

        assert!(result.unwrap_err().contains("Checksum inválido"));
    }

    fn activation_fixture(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "jintia-node-activation-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn node_activation_installs_staged_runtime_when_live_is_absent() {
        let root = activation_fixture("first");
        let staged_node = root.join("stage/node");
        let node_dir = root.join("node");
        let backup_dir = root.join("backup");
        fs::create_dir_all(&staged_node).unwrap();
        fs::write(staged_node.join("marker-new"), "new").unwrap();

        activate_staged_node_runtime(&staged_node, &node_dir, &backup_dir).unwrap();

        assert!(node_dir.join("marker-new").is_file());
        assert!(!staged_node.exists());
        assert!(!backup_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn node_activation_replaces_existing_runtime_after_staging() {
        let root = activation_fixture("replace");
        let staged_node = root.join("stage/node");
        let node_dir = root.join("node");
        let backup_dir = root.join("backup");
        fs::create_dir_all(&staged_node).unwrap();
        fs::create_dir_all(&node_dir).unwrap();
        fs::write(staged_node.join("marker-new"), "new").unwrap();
        fs::write(node_dir.join("marker-old"), "old").unwrap();

        activate_staged_node_runtime(&staged_node, &node_dir, &backup_dir).unwrap();

        assert!(node_dir.join("marker-new").is_file());
        assert!(!node_dir.join("marker-old").exists());
        assert!(!backup_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn node_activation_restores_previous_runtime_when_stage_activation_fails() {
        let root = activation_fixture("rollback");
        let staged_node = root.join("stage/node");
        let node_dir = root.join("node");
        let backup_dir = root.join("backup");
        fs::create_dir_all(&node_dir).unwrap();
        fs::write(node_dir.join("marker-old"), "old").unwrap();

        let error = activate_staged_node_runtime(&staged_node, &node_dir, &backup_dir)
            .unwrap_err();

        assert!(error.contains("Error activando Node"));
        assert!(node_dir.join("marker-old").is_file());
        assert!(!backup_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn python_activation_fixture(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "jintia-python-activation-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn python_activation_installs_staged_runtime_when_live_is_absent() {
        let root = python_activation_fixture("first");
        let staged_python = root.join("stage/python");
        let python_dir = root.join("python");
        let backup_dir = root.join("backup");
        fs::create_dir_all(&staged_python).unwrap();
        fs::write(staged_python.join("marker-new"), "new").unwrap();

        activate_staged_python_runtime(&staged_python, &python_dir, &backup_dir, |_| Ok(())).unwrap();

        assert!(python_dir.join("marker-new").is_file());
        assert!(!staged_python.exists());
        assert!(!backup_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn python_activation_replaces_existing_runtime_after_staging() {
        let root = python_activation_fixture("replace");
        let staged_python = root.join("stage/python");
        let python_dir = root.join("python");
        let backup_dir = root.join("backup");
        fs::create_dir_all(&staged_python).unwrap();
        fs::create_dir_all(&python_dir).unwrap();
        fs::write(staged_python.join("marker-new"), "new").unwrap();
        fs::write(python_dir.join("marker-old"), "old").unwrap();

        activate_staged_python_runtime(&staged_python, &python_dir, &backup_dir, |_| Ok(())).unwrap();

        assert!(python_dir.join("marker-new").is_file());
        assert!(!python_dir.join("marker-old").exists());
        assert!(!backup_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn python_activation_restores_previous_runtime_when_stage_activation_fails() {
        let root = python_activation_fixture("rollback");
        let staged_python = root.join("stage/python");
        let python_dir = root.join("python");
        let backup_dir = root.join("backup");
        fs::create_dir_all(&python_dir).unwrap();
        fs::write(python_dir.join("marker-old"), "old").unwrap();

        let error = activate_staged_python_runtime(&staged_python, &python_dir, &backup_dir, |_| Ok(()))
            .unwrap_err();

        assert!(error.contains("Error activando Python"));
        assert!(python_dir.join("marker-old").is_file());
        assert!(!backup_dir.exists());
        assert!(!python_dir.join("marker-new").exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn notebooklm_activation_fixture(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "jintia-notebooklm-activation-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn notebooklm_activation_installs_staged_runtime_when_live_is_absent() {
        let root = notebooklm_activation_fixture("first");
        let stage = root.join("stage");
        let active = root.join("active");
        let backup = root.join("backup");
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("marker-new"), "new").unwrap();
        activate_staged_notebooklm_mcp(&stage, &active, &backup, |_active| Ok(())).unwrap();
        assert!(active.join("marker-new").is_file());
        assert!(!stage.exists());
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notebooklm_activation_replaces_existing_runtime_after_validation() {
        let root = notebooklm_activation_fixture("replace");
        let stage = root.join("stage");
        let active = root.join("active");
        let backup = root.join("backup");
        fs::create_dir_all(&stage).unwrap();
        fs::create_dir_all(&active).unwrap();
        fs::write(stage.join("marker-new"), "new").unwrap();
        fs::write(active.join("marker-old"), "old").unwrap();
        activate_staged_notebooklm_mcp(&stage, &active, &backup, |active_root| {
            assert!(active_root.join("marker-new").is_file());
            Ok(())
        })
        .unwrap();
        assert!(active.join("marker-new").is_file());
        assert!(!active.join("marker-old").exists());
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notebooklm_activation_restores_previous_runtime_when_stage_move_fails() {
        let root = notebooklm_activation_fixture("stage-rollback");
        let stage = root.join("missing-stage");
        let active = root.join("active");
        let backup = root.join("backup");
        fs::create_dir_all(&active).unwrap();
        fs::write(active.join("marker-old"), "old").unwrap();
        let error = activate_staged_notebooklm_mcp(&stage, &active, &backup, |_active| Ok(())).unwrap_err();
        assert!(error.contains("Error activando NotebookLM MCP"));
        assert!(active.join("marker-old").is_file());
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notebooklm_activation_restores_previous_runtime_when_active_validation_fails() {
        let root = notebooklm_activation_fixture("validation-rollback");
        let stage = root.join("stage");
        let active = root.join("active");
        let backup = root.join("backup");
        fs::create_dir_all(&stage).unwrap();
        fs::create_dir_all(&active).unwrap();
        fs::write(stage.join("marker-new"), "new").unwrap();
        fs::write(active.join("marker-old"), "old").unwrap();
        let error = activate_staged_notebooklm_mcp(&stage, &active, &backup, |_active| {
            Err("validation failed".to_string())
        })
        .unwrap_err();
        assert!(error.contains("validation failed"));
        assert!(active.join("marker-old").is_file());
        assert!(!active.join("marker-new").exists());
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notebooklm_activation_removes_invalid_first_install() {
        let root = notebooklm_activation_fixture("invalid-first");
        let stage = root.join("stage");
        let active = root.join("active");
        let backup = root.join("backup");
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("marker-new"), "new").unwrap();
        let error = activate_staged_notebooklm_mcp(&stage, &active, &backup, |_active| {
            Err("validation failed".to_string())
        })
        .unwrap_err();
        assert!(error.contains("validation failed"));
        assert!(!active.exists());
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notebooklm_npm_command_uses_managed_node_and_npm_cli() {
        let command = build_managed_notebooklm_npm_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-stage"),
            std::ffi::OsStr::new("managed-bin"),
            &["ci"],
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-node"));
        assert_eq!(&args[..2], ["managed-npm-cli.js", "ci"]);
    }

    #[test]
    fn notebooklm_npm_command_uses_only_managed_path() {
        let command = build_managed_notebooklm_npm_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-stage"),
            std::ffi::OsStr::new("managed-only-bin"),
            &["ci"],
        );
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH administrado");
        assert_eq!(path, std::ffi::OsStr::new("managed-only-bin"));
        assert!(!path.to_string_lossy().contains("host-only-bin"));
    }

    #[test]
    fn notebooklm_npm_command_runs_inside_staging() {
        let command = build_managed_notebooklm_npm_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-stage"),
            std::ffi::OsStr::new("managed-bin"),
            &["ci"],
        );
        assert_eq!(
            command.get_current_dir(),
            Some(std::path::Path::new("managed-stage"))
        );
    }

    #[test]
    fn notebooklm_npm_command_preserves_package_lock_arguments() {
        let args = [
            "install",
            "--package-lock-only",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
        ];
        let command = build_managed_notebooklm_npm_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-stage"),
            std::ffi::OsStr::new("managed-bin"),
            &args,
        );
        let actual: Vec<_> = command.get_args().skip(1).collect();
        assert_eq!(actual, args.map(std::ffi::OsStr::new).to_vec());
    }

    #[test]
    fn notebooklm_npm_command_preserves_ci_arguments() {
        let args = [
            "ci",
            "--omit=dev",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
        ];
        let command = build_managed_notebooklm_npm_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-stage"),
            std::ffi::OsStr::new("managed-bin"),
            &args,
        );
        let actual: Vec<_> = command.get_args().skip(1).collect();
        assert_eq!(actual, args.map(std::ffi::OsStr::new).to_vec());
    }

    #[test]
    fn notebooklm_npm_command_removes_node_options() {
        let command = build_managed_notebooklm_npm_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-stage"),
            std::ffi::OsStr::new("managed-only-bin"),
            &["ci"],
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn notebooklm_browser_command_uses_managed_node_and_bin() {
        let command = build_managed_notebooklm_browser_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-bin"),
            "status",
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-node"));
        assert_eq!(args[0], "managed-mcp-bin.js");
    }

    #[test]
    fn notebooklm_browser_command_uses_only_managed_path() {
        let command = build_managed_notebooklm_browser_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-only-bin"),
            "status",
        );
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH administrado");
        assert_eq!(path, std::ffi::OsStr::new("managed-only-bin"));
        assert!(!path.to_string_lossy().contains("host-only-bin"));
    }

    #[test]
    fn notebooklm_browser_command_removes_node_options() {
        let command = build_managed_notebooklm_browser_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-only-bin"),
            "status",
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn notebooklm_browser_command_preserves_status_arguments() {
        let command = build_managed_notebooklm_browser_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-bin"),
            "status",
        );
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, [
            std::ffi::OsStr::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("browser"),
            std::ffi::OsStr::new("status"),
            std::ffi::OsStr::new("--json"),
        ]);
    }

    #[test]
    fn notebooklm_browser_command_preserves_install_arguments() {
        let command = build_managed_notebooklm_browser_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-bin"),
            "install",
        );
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, [
            std::ffi::OsStr::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("browser"),
            std::ffi::OsStr::new("install"),
            std::ffi::OsStr::new("--json"),
        ]);
    }

    #[test]
    fn notebooklm_browser_command_does_not_override_current_dir() {
        let command = build_managed_notebooklm_browser_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-bin"),
            "status",
        );
        assert!(command.get_current_dir().is_none());
    }

    #[test]
    fn node_version_text_accepts_exact_managed_version() {
        assert!(node_version_text_matches_expected("v22.13.0"));
        assert!(node_version_text_matches_expected(" v22.13.0\n"));
    }

    #[test]
    fn node_version_text_rejects_unexpected_runtime_version() {
        assert!(!node_version_text_matches_expected("v21.0.0"));
        assert!(!node_version_text_matches_expected("v22.13.1"));
        assert!(!node_version_text_matches_expected("22.13.0"));
    }

    #[test]
    fn staged_node_version_command_uses_exact_node_and_version_argument() {
        let command = build_staged_node_version_command(
            std::path::Path::new("staged-node"),
        );
        assert_eq!(command.get_program(), std::ffi::OsStr::new("staged-node"));
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, vec![std::ffi::OsStr::new("--version")]);
    }

    #[test]
    fn staged_node_version_command_removes_node_options() {
        let command = build_staged_node_version_command(
            std::path::Path::new("staged-node"),
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn staged_node_version_command_has_only_version_argument() {
        let command = build_staged_node_version_command(
            std::path::Path::new("staged-node"),
        );
        assert_eq!(command.get_args().count(), 1);
        assert_eq!(
            command.get_args().next(),
            Some(std::ffi::OsStr::new("--version"))
        );
    }

    #[test]
    fn portable_node_version_command_uses_exact_node_and_version_argument() {
        let command = build_portable_node_version_command(
            std::path::Path::new("portable-node"),
        );
        assert_eq!(command.get_program(), std::ffi::OsStr::new("portable-node"));
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, vec![std::ffi::OsStr::new("--version")]);
    }

    #[test]
    fn portable_node_version_command_removes_node_options() {
        let command = build_portable_node_version_command(
            std::path::Path::new("portable-node"),
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn portable_node_version_command_has_only_version_argument() {
        let command = build_portable_node_version_command(
            std::path::Path::new("portable-node"),
        );
        assert_eq!(command.get_args().count(), 1);
        assert_eq!(
            command.get_args().next(),
            Some(std::ffi::OsStr::new("--version"))
        );
    }

    #[test]
    fn portable_node_version_command_does_not_override_current_dir() {
        let command = build_portable_node_version_command(
            std::path::Path::new("portable-node"),
        );
        assert_eq!(command.get_current_dir(), None);
    }

    #[test]
    fn python_version_text_accepts_exact_managed_version() {
        assert!(python_version_text_matches_expected("Python 3.13.15"));
        assert!(python_version_text_matches_expected(" Python 3.13.15\n"));
    }

    #[test]
    fn python_version_text_rejects_unexpected_patch_version() {
        assert!(!python_version_text_matches_expected("Python 3.13.14"));
        assert!(!python_version_text_matches_expected("Python 3.13.16"));
        assert!(!python_version_text_matches_expected("Python 3.13.0"));
    }

    #[test]
    fn python_version_text_rejects_other_python_series() {
        assert!(!python_version_text_matches_expected("Python 3.12.15"));
        assert!(!python_version_text_matches_expected("Python 3.14.0"));
    }

    #[test]
    fn python_version_text_rejects_non_exact_version_output() {
        assert!(!python_version_text_matches_expected("Python 3.13.15rc1"));
        assert!(!python_version_text_matches_expected("Python 3.13.15 custom"));
        assert!(!python_version_text_matches_expected("3.13.15"));
    }

    #[test]
    fn disciplinary_npm_command_uses_managed_node_and_npm_cli() {
        let packages = vec!["pkg-a".to_string(), "@scope/pkg-b".to_string()];
        let managed_path = std::ffi::OsString::from("managed-bin");
        let command = build_managed_npm_install_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-prefix"),
            &managed_path,
            &packages,
        );
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-node"));
        let args: Vec<&std::ffi::OsStr> = command.get_args().collect();
        assert_eq!(args, vec![
            std::ffi::OsStr::new("managed-npm-cli.js"),
            std::ffi::OsStr::new("install"),
            std::ffi::OsStr::new("--global"),
            std::ffi::OsStr::new("--prefix"),
            std::ffi::OsStr::new("managed-prefix"),
            std::ffi::OsStr::new("pkg-a"),
            std::ffi::OsStr::new("@scope/pkg-b"),
        ]);
    }

    #[test]
    fn disciplinary_npm_command_uses_only_managed_path() {
        let managed_path = std::ffi::OsString::from("managed-only-bin");
        let command = build_managed_npm_install_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-prefix"),
            &managed_path,
            &[],
        );
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH must be explicitly managed");
        assert_eq!(path, std::ffi::OsStr::new("managed-only-bin"));
        assert!(!path.to_string_lossy().contains("host-only-bin"));
    }

    #[test]
    fn disciplinary_npm_command_preserves_package_arguments() {
        let packages = vec!["@scope/pkg@1.2.3".to_string(), "plain-package@4.5.6".to_string()];
        let command = build_managed_npm_install_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-npm-cli.js"),
            std::path::Path::new("managed-prefix"),
            std::ffi::OsStr::new("managed-bin"),
            &packages,
        );
        let args: Vec<&std::ffi::OsStr> = command.get_args().collect();
        assert_eq!(&args[5..], [
            std::ffi::OsStr::new("@scope/pkg@1.2.3"),
            std::ffi::OsStr::new("plain-package@4.5.6"),
        ]);
        assert_ne!(command.get_program(), std::ffi::OsStr::new("npm"));
        assert_ne!(command.get_program(), std::ffi::OsStr::new("npm.cmd"));
        assert_ne!(command.get_program(), std::ffi::OsStr::new("cmd"));
        assert_ne!(command.get_program(), std::ffi::OsStr::new("sh"));
        assert_ne!(command.get_program(), std::ffi::OsStr::new("bash"));
    }

    #[test]
    fn install_npm_packages_empty_input_is_noop() {
        assert!(install_npm_packages(&[]).is_ok());
    }

    #[test]
    fn managed_node_cli_version_command_uses_only_managed_path() {
        let command = build_managed_node_cli_version_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-cli"),
            std::ffi::OsStr::new("managed-only-bin"),
            &["--version"],
        );
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH must be explicitly managed");
        assert_eq!(path, std::ffi::OsStr::new("managed-only-bin"));
        assert!(!path.to_string_lossy().contains("host-only-bin"));
    }

    #[test]
    fn managed_node_cli_version_command_preserves_arguments() {
        let command = build_managed_node_cli_version_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-cli"),
            std::ffi::OsStr::new("managed-only-bin"),
            &["--version", "--verbose"],
        );
        let args: Vec<&std::ffi::OsStr> = command.get_args().collect();
        assert_eq!(&args[args.len() - 2..], [
            std::ffi::OsStr::new("--version"),
            std::ffi::OsStr::new("--verbose"),
        ]);
    }

    #[test]
    fn managed_node_cli_version_command_uses_expected_launcher() {
        let command = build_managed_node_cli_version_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new(if cfg!(target_os = "windows") {
                "managed-cli.cmd"
            } else {
                "managed-cli"
            }),
            std::ffi::OsStr::new("managed-only-bin"),
            &["--version"],
        );
        let args: Vec<&std::ffi::OsStr> = command.get_args().collect();
        if cfg!(target_os = "windows") {
            assert_eq!(command.get_program(), std::ffi::OsStr::new("cmd"));
            assert_eq!(&args[..2], [
                std::ffi::OsStr::new("/C"),
                std::ffi::OsStr::new("managed-cli.cmd"),
            ]);
        } else {
            assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-node"));
            assert_eq!(&args[..1], [std::ffi::OsStr::new("managed-cli")]);
        }
    }

    #[test]
    fn managed_node_cli_version_command_supports_vivliostyle_version() {
        let command = build_managed_node_cli_version_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new(if cfg!(target_os = "windows") {
                "vivliostyle.cmd"
            } else {
                "vivliostyle"
            }),
            std::ffi::OsStr::new("managed-only-bin"),
            &["--version"],
        );
        let args: Vec<&std::ffi::OsStr> = command.get_args().collect();
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH must be explicitly managed");
        assert_eq!(path, std::ffi::OsStr::new("managed-only-bin"));
        if cfg!(target_os = "windows") {
            assert_eq!(command.get_program(), std::ffi::OsStr::new("cmd"));
            assert_eq!(&args[..3], [
                std::ffi::OsStr::new("/C"),
                std::ffi::OsStr::new("vivliostyle.cmd"),
                std::ffi::OsStr::new("--version"),
            ]);
        } else {
            assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-node"));
            assert_eq!(&args[..2], [
                std::ffi::OsStr::new("vivliostyle"),
                std::ffi::OsStr::new("--version"),
            ]);
        }
    }

    #[test]
    fn managed_node_cli_version_command_removes_node_options() {
        let command = build_managed_node_cli_version_command(
            std::path::Path::new("managed-node"),
            std::path::Path::new("managed-cli"),
            std::ffi::OsStr::new("managed-only-bin"),
            &["--version"],
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[cfg(target_os = "windows")]
    fn zip_fixture(name: &str, entry: &str, bytes: &[u8]) -> (std::path::PathBuf, std::path::PathBuf) {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("jintia-node-zip-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let archive_path = root.join(name);
        let file = fs::File::create(&archive_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(entry, SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
        zip.finish().unwrap();
        (archive_path, root.join("dest"))
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn extract_zip_keeps_node_under_managed_runtime() {
        let (archive, dest) = zip_fixture("node.zip", "node-v22.13.0-win-x64/bin/node.exe", b"node");
        fs::create_dir_all(&dest).unwrap();
        extract_zip(&archive, &dest).unwrap();
        assert_eq!(fs::read(dest.join("node/bin/node.exe")).unwrap(), b"node");
        let root = archive.parent().unwrap();
        fs::remove_dir_all(root).ok();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn extract_zip_rejects_path_traversal() {
        let (archive, dest) = zip_fixture("unsafe.zip", "../escape.txt", b"escape");
        fs::create_dir_all(&dest).unwrap();
        assert!(extract_zip(&archive, &dest).is_err());
        assert!(!dest.parent().unwrap().join("escape.txt").exists());
        let root = archive.parent().unwrap();
        fs::remove_dir_all(&dest).ok();
        fs::remove_dir_all(root).ok();
    }

    #[cfg(not(target_os = "windows"))]
    fn tar_gz_fixture(
        name: &str,
        entries: &[(&str, &[u8])],
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        use tar::Builder;

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "jintia-node-tar-gz-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("node.tar.gz");
        let file = fs::File::create(&archive_path).unwrap();
        let encoder = GzEncoder::new(file, Compression::default());
        let mut builder = Builder::new(encoder);

        for (path, bytes) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, *path, *bytes).unwrap();
        }

        let encoder = builder.into_inner().unwrap();
        encoder.finish().unwrap();
        (archive_path, root.join("dest"))
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn node_tar_gz_extraction_normalizes_single_node_root() {
        let (archive, dest) = tar_gz_fixture(
            "normal",
            &[("node-v22.13.0-test/bin/marker", b"marker")],
        );
        fs::create_dir_all(&dest).unwrap();

        extract_node_tar_gz(&archive, &dest).unwrap();

        assert_eq!(fs::read(dest.join("node/bin/marker")).unwrap(), b"marker");
        assert!(!dest.join("node-v22.13.0-test").exists());
        fs::remove_dir_all(archive.parent().unwrap()).unwrap();
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn node_tar_gz_extraction_rejects_missing_node_root() {
        let (archive, dest) = tar_gz_fixture("missing-root", &[("unexpected-root/file", b"file")]);
        fs::create_dir_all(&dest).unwrap();

        let error = extract_node_tar_gz(&archive, &dest).unwrap_err();

        assert!(error.contains("directorio raíz esperado"));
        assert!(!dest.join("node").exists());
        fs::remove_dir_all(archive.parent().unwrap()).unwrap();
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn node_tar_gz_extraction_rejects_multiple_node_roots() {
        let (archive, dest) = tar_gz_fixture(
            "multiple-roots",
            &[
                ("node-v22.13.0-a/file", b"a"),
                ("node-v22.13.0-b/file", b"b"),
            ],
        );
        fs::create_dir_all(&dest).unwrap();

        let error = extract_node_tar_gz(&archive, &dest).unwrap_err();

        assert!(error.contains("múltiples directorios raíz"));
        assert!(!dest.join("node").exists());
        fs::remove_dir_all(archive.parent().unwrap()).unwrap();
    }

    fn contract() -> crate::release::ManagedMcpContract {
        crate::release::ManagedMcpContract { package: "@scope/pkg".into(), version: "2.3.10".into(), node_requirement: ">=22.13.0".into(), npm_integrity: "sha512-AAAA".into(), jintia_version: "11.6.10".into() }
    }

    #[test]
    fn package_and_lock_match_contract_exactly() {
        let c = contract();
        let package = serde_json::json!({"name":"@scope/pkg","version":"2.3.10"});
        let lock = serde_json::json!({"packages":{"node_modules/@scope/pkg":{"version":"2.3.10","integrity":"sha512-AAAA"}}});
        assert!(notebooklm_package_matches_contract(&package, &lock, &c));
        for (package, lock) in [
            (serde_json::json!({"name":"other","version":"2.3.10"}), lock.clone()),
            (serde_json::json!({"name":"@scope/pkg","version":"2.3.9"}), lock.clone()),
            (package.clone(), serde_json::json!({"packages":{}})),
            (package.clone(), serde_json::json!({"packages":{"node_modules/@scope/pkg":{"version":"2.3.9","integrity":"sha512-AAAA"}}})),
            (package.clone(), serde_json::json!({"packages":{"node_modules/@scope/pkg":{"version":"2.3.10","integrity":"sha512-BBBB"}}})),
        ] { assert!(!notebooklm_package_matches_contract(&package, &lock, &c)); }
    }

    #[test]
    fn notebooklm_lock_entry_resolves_scoped_package() {
        let lock = serde_json::json!({
            "lockfileVersion": 3,
            "packages": {
                "node_modules/@charlie.act7/gemini-notebook-mcp": {
                    "version": "2.3.3",
                    "integrity": "sha512-test"
                }
            }
        });
        let entry = notebooklm_lock_entry(&lock, "@charlie.act7/gemini-notebook-mcp").expect("debe resolver la clave scoped completa");
        assert_eq!(entry.get("version").and_then(|value| value.as_str()), Some("2.3.3"));
        assert_eq!(entry.get("integrity").and_then(|value| value.as_str()), Some("sha512-test"));
    }

    #[test]
    fn notebooklm_lock_entry_returns_none_when_package_is_missing() {
        let lock = serde_json::json!({ "packages": {} });
        assert!(notebooklm_lock_entry(&lock, "@charlie.act7/gemini-notebook-mcp").is_none());
    }

    #[test]
    fn resolve_notebooklm_mcp_bin_accepts_string_and_scoped_bin_object() {
        let contract = crate::release::ManagedMcpContract { package: "@charlie.act7/gemini-notebook-mcp".into(), version: "2.3.5".into(), node_requirement: ">=22.13.0".into(), npm_integrity: "sha512-test".into(), jintia_version: "11.6.8".into() };
        let root = std::env::temp_dir().join(format!("jintia-mcp-bin-test-{}", crate::paths::timestamp()));
        let package = root.join("node_modules/@charlie.act7/gemini-notebook-mcp");
        let cli = ["dist", "cli.js"].join("/");
        fs::create_dir_all(package.join("dist")).unwrap();
        fs::write(package.join(&cli), "#!/usr/bin/env node\n").unwrap();
        fs::write(package.join("package.json"), serde_json::json!({
            "name": contract.package,
            "version": contract.version,
            "bin": { "gemini-notebook-mcp": cli }
        }).to_string()).unwrap();
        assert_eq!(resolve_notebooklm_mcp_bin_for(&package, &contract).unwrap(), fs::canonicalize(package.join(&cli)).unwrap());
        fs::write(package.join("package.json"), serde_json::json!({
            "name": contract.package,
            "version": contract.version,
            "bin": cli
        }).to_string()).unwrap();
        assert!(resolve_notebooklm_mcp_bin_for(&package, &contract).is_ok());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn resolve_notebooklm_mcp_bin_rejects_escape_and_missing_bin() {
        let root = std::env::temp_dir().join(format!("jintia-mcp-bin-invalid-{}", crate::paths::timestamp()));
        let package = root.join("package");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("package.json"), serde_json::json!({
            "name": "@charlie.act7/gemini-notebook-mcp",
            "version": "2.3.5",
            "bin": { "other": "../escape.js" }
        }).to_string()).unwrap();
        let contract = crate::release::ManagedMcpContract { package: "@charlie.act7/gemini-notebook-mcp".into(), version: "2.3.5".into(), node_requirement: ">=22.13.0".into(), npm_integrity: "sha512-test".into(), jintia_version: "11.6.8".into() };
        assert!(resolve_notebooklm_mcp_bin_for(&package, &contract).is_err());
        fs::remove_dir_all(root).ok();
    }
}

pub fn resolve_vivliostyle() -> Option<PathBuf> {
    let portable = paths::portable_vivliostyle_bin();

    if portable.is_file() {
        return Some(portable);
    }

    None
}

pub fn vivliostyle_version() -> Option<String> {
    let executable = resolve_vivliostyle()?;
    let node = paths::portable_node_exe();
    if !node.is_file() {
        return None;
    }

    let managed_path = managed_node_runtime_path().ok()?;
    let output = build_managed_node_cli_version_command(
        &node,
        &executable,
        &managed_path,
        &["--version"],
    )
    .output()
    .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = if output.stdout.is_empty() {
        output.stderr
    } else {
        output.stdout
    };

    String::from_utf8(text).ok().and_then(|value| {
        value
            .lines()
            .find(|line| !line.trim().is_empty())
            .map(|line| line.trim().to_string())
    })
}

pub fn resolve_node_cli(command: &str) -> Option<PathBuf> {
    let portable_name = if cfg!(target_os = "windows") {
        format!("{command}.cmd")
    } else {
        command.to_string()
    };

    let portable = paths::portable_node_bin_dir()
        .join(portable_name);

    if portable.is_file() {
        return Some(portable);
    }

    None
}

pub fn node_cli_version(
    command: &str,
    args: &[&str],
) -> Option<String> {
    let executable = resolve_node_cli(command)?;

    let node = paths::portable_node_exe();
    if !node.is_file() {
        return None;
    }

    let managed_path = managed_node_runtime_path().ok()?;
    let output = build_managed_node_cli_version_command(
        &node,
        &executable,
        &managed_path,
        args,
    )
    .output()
    .ok()?;

    if !output.status.success() {
        return None;
    }

    let bytes = if output.stdout.is_empty() {
        output.stderr
    } else {
        output.stdout
    };

    String::from_utf8(bytes)
        .ok()
        .and_then(|value| {
            value
                .lines()
                .find(|line| {
                    !line.trim().is_empty()
                })
                .map(|line| {
                    line.trim().to_string()
                })
        })
}

pub(crate) fn managed_node_runtime_path() -> Result<OsString, String> {
    std::env::join_paths([paths::portable_node_bin_dir()])
        .map_err(|error| format!("No se pudo construir el PATH administrado de Node: {error}"))
}

fn build_managed_node_cli_version_command(
    node: &std::path::Path,
    executable: &std::path::Path,
    managed_path: &std::ffi::OsStr,
    args: &[&str],
) -> Command {
    let mut command = if cfg!(target_os = "windows")
        && executable
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
    {
        let mut command = managed_node_command("cmd");
        command.arg("/C").arg(executable);
        command
    } else {
        let mut command = managed_node_command(node);
        command.arg(executable);
        command
    };

    command
        .args(args)
        .env("PATH", managed_path);
    command
}

fn build_managed_npm_install_command(
    node: &std::path::Path,
    npm_cli: &std::path::Path,
    prefix: &std::path::Path,
    managed_path: &std::ffi::OsStr,
    packages: &[String],
) -> Command {
    let mut command = managed_node_command(node);
    command
        .arg(npm_cli)
        .arg("install")
        .arg("--global")
        .arg("--prefix")
        .arg(prefix)
        .args(packages)
        .env("PATH", managed_path);
    command
}

pub fn install_vivliostyle() -> Result<(), String> {
    let _node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")?;
    let node = paths::portable_node_exe();
    if !node.is_file() {
        return Err("El ejecutable Node portable no está disponible.".to_string());
    }

    let npm_cli = paths::portable_npm_cli();
    if !npm_cli.is_file() {
        return Err("El npm administrado por Jintia no está disponible.".to_string());
    }

    let prefix = paths::portable_node_prefix();
    let managed_path = managed_node_runtime_path()?;
    let output = managed_node_command(&node)
            .arg(&npm_cli)
            .arg("install")
            .arg("--global")
            .arg("--prefix")
            .arg(&prefix)
            .arg("@vivliostyle/cli")
            .env("PATH", managed_path)
            .output()
    .map_err(|e| format!("No se pudo ejecutar npm con el runtime portable: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("npm install @vivliostyle/cli falló: {stderr}"));
    }

    let executable = paths::portable_vivliostyle_bin();
    if !executable.is_file() {
        return Err(format!(
            "Vivliostyle fue instalado por npm pero no se encontró el ejecutable administrado en {}.",
            executable.display()
        ));
    }

    Ok(())
}

pub fn install_npm_packages(packages: &[String]) -> Result<(), String> {
    if packages.is_empty() {
        return Ok(());
    }
    let _node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")?;

    let node = paths::portable_node_exe();
    if !node.is_file() {
        return Err("El ejecutable Node portable no está disponible.".to_string());
    }

    let npm_cli = paths::portable_npm_cli();
    if !npm_cli.is_file() {
        return Err("El npm administrado por Jintia no está disponible.".to_string());
    }

    let prefix = paths::portable_node_prefix();
    let managed_path = managed_node_runtime_path()?;
    let output = build_managed_npm_install_command(
        &node,
        &npm_cli,
        &prefix,
        &managed_path,
        packages,
    )
    .output()
    .map_err(|e| {
        format!("No se pudo ejecutar npm con el runtime portable: {e}")
    })?;

    if !output.status.success() {
        let stderr =
            String::from_utf8_lossy(&output.stderr);

        return Err(format!(
            "npm install falló para el perfil disciplinar: {stderr}"
        ));
    }

    Ok(())
}

// ==================== CHECKSUM VERIFICATION ====================

fn verify_sha256(file_path: &std::path::Path, expected_hex: &str) -> Result<(), String> {
    let mut file = fs::File::open(file_path)
        .map_err(|e| format!("Error abriendo archivo para verificar: {e}"))?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 64];

    loop {
        let n = file.read(&mut buffer)
            .map_err(|e| format!("Error leyendo para checksum: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }

    let actual = hex::encode(hasher.finalize());
    let expected = expected_hex.trim().to_lowercase();

    if actual != expected {
        return Err(format!(
            "Checksum inválido. Esperado: {}…, Actual: {}…",
            &expected[..16.min(expected.len())],
            &actual[..16.min(actual.len())]
        ));
    }

    Ok(())
}

fn node_checksum_from_manifest(manifest: &str, filename: &str) -> Result<String, String> {
    let mut checksum = None;

    for line in manifest.lines() {
        let Some((candidate, candidate_filename)) = line.trim_end().split_once("  ") else {
            continue;
        };

        if candidate_filename.trim() != filename {
            continue;
        }

        if checksum.is_some() {
            return Err(format!("Checksum duplicado para {filename}"));
        }

        if candidate.len() != 64 || !candidate.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("Checksum SHA-256 inválido para {filename}"));
        }

        checksum = Some(candidate.to_ascii_lowercase());
    }

    checksum.ok_or_else(|| format!("Checksum no encontrado para {filename}"))
}

fn fetch_node_checksum() -> Result<String, String> {
    let url = format!("https://nodejs.org/dist/v{NODE_VERSION}/SHASUMS256.txt");
    let text = reqwest::blocking::get(&url)
        .map_err(|e| format!("Error descargando checksums: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Error descargando checksums: {e}"))?
        .text()
        .map_err(|e| format!("Error leyendo checksums: {e}"))?;

    let filename = node_download_url()
        .rsplit('/')
        .next()
        .ok_or_else(|| "No se pudo determinar el archivo de Node.js".to_string())?;

    node_checksum_from_manifest(&text, filename)
}

// ==================== SKILL RUNTIME ====================

pub fn portable_skill_installed() -> bool {
    paths::portable_skill_bin().is_file()
}

pub fn resolve_skill() -> Option<String> {
    let portable = paths::portable_skill_bin();
    if portable.is_file() {
        return Some(portable.to_string_lossy().into_owned());
    }
    None
}

pub fn global_skill_available() -> bool {
    let checker = if cfg!(target_os = "windows") { "where.exe" } else { "which" };
    Command::new(checker)
        .arg("jintia")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn download_portable_skill(app: &AppHandle) -> Result<(), String> {
    let _skill_guard = try_runtime_mutation_lock(&SKILL_RUNTIME_MUTATION_LOCK, "el runtime Jintia administrado")?;
    let _node_guard = try_runtime_mutation_lock(&NODE_RUNTIME_MUTATION_LOCK, "el runtime Node administrado")?;
    let node = paths::portable_node_exe();
    if !node.is_file() {
        return Err("El ejecutable Node portable no está disponible.".to_string());
    }

    let npm_cli = paths::portable_npm_cli();
    if !npm_cli.is_file() {
        return Err("El npm administrado por Jintia no está disponible.".to_string());
    }

    let runtimes_dir = paths::portable_runtimes_dir();
    fs::create_dir_all(&runtimes_dir)
        .map_err(|e| format!("Error creando directorio de runtimes: {e}"))?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stage = runtimes_dir.join(format!(".jintia-stage-{ts}"));

    let managed_path = managed_node_runtime_path()?;

    emit_skill_progress(app, "installing", 5.0, "Instalando Jintia desde npm...");

    let output = managed_node_command(&node)
            .arg(&npm_cli)
            .arg("install")
            .arg("--global")
            .arg("--prefix")
            .arg(&stage)
            .arg("@charlie.act7/jintia@latest")
            .arg("--no-audit")
            .arg("--no-fund")
            .env("PATH", &managed_path)
            .output()
    .map_err(|e| {
        let _ = fs::remove_dir_all(&stage);
        format!("No se pudo ejecutar npm: {e}")
    })?;

    if !output.status.success() {
        let _ = fs::remove_dir_all(&stage);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "npm install @charlie.act7/jintia@latest falló: {stderr}"
        ));
    }

    emit_skill_progress(app, "validating", 70.0, "Validando instalación...");

    let pkg_dir = paths::portable_skill_npm_package_dir_for(&stage);
    let skill_js = pkg_dir.join("skill").join("bin").join("jintia.js");
    let pkg_json_path = pkg_dir.join("package.json");
    let skill_md = pkg_dir.join("skill").join("SKILL.md");

    if !pkg_json_path.is_file() {
        let _ = fs::remove_dir_all(&stage);
        return Err(format!(
            "package.json no encontrado en {}",
            pkg_dir.display()
        ));
    }
    if !skill_md.is_file() {
        let _ = fs::remove_dir_all(&stage);
        return Err(format!(
            "SKILL.md no encontrado en {}",
            pkg_dir.display()
        ));
    }
    if !skill_js.is_file() {
        let _ = fs::remove_dir_all(&stage);
        return Err(format!(
            "skill/bin/jintia.js no encontrado en {}",
            pkg_dir.display()
        ));
    }

    let pkg_json = fs::read_to_string(&pkg_json_path)
        .map_err(|e| format!("Error leyendo package.json: {e}"))?;
    let pkg: serde_json::Value = serde_json::from_str(&pkg_json)
        .map_err(|e| format!("Error parseando package.json: {e}"))?;
    let name = pkg["name"].as_str().unwrap_or("");
    let version = pkg["version"].as_str().unwrap_or("").to_string();
    if name != "@charlie.act7/jintia" {
        let _ = fs::remove_dir_all(&stage);
        return Err(format!("Nombre incorrecto en package.json: {name}"));
    }
    if version.is_empty() {
        let _ = fs::remove_dir_all(&stage);
        return Err("Versión vacía en package.json".to_string());
    }

    emit_skill_progress(
        app,
        "testing",
        80.0,
        &format!("Probando Jintia {version}..."),
    );

    let smoke_output = managed_node_command(&node)
        .arg(&skill_js)
        .arg("capabilities")
        .arg("profiles")
        .arg("--json")
        .env("PATH", &managed_path)
        .output()
        .map_err(|e| {
            let _ = fs::remove_dir_all(&stage);
            format!("No se pudo ejecutar la prueba de humo: {e}")
        })?;

    if !smoke_output.status.success() {
        let _ = fs::remove_dir_all(&stage);
        let stderr = String::from_utf8_lossy(&smoke_output.stderr);
        return Err(format!("Prueba de humo falló: {stderr}"));
    }

    let smoke_stdout = String::from_utf8_lossy(&smoke_output.stdout);
    serde_json::from_str::<serde_json::Value>(&smoke_stdout).map_err(|e| {
        let _ = fs::remove_dir_all(&stage);
        format!("La prueba de humo devolvió JSON inválido: {e}")
    })?;

    crate::release::managed_mcp_contract_from(&pkg_dir, env!("CARGO_PKG_VERSION"))
        .map_err(|error| { let _ = fs::remove_dir_all(&stage); error })?;

    emit_skill_progress(app, "activating", 92.0, "Activando instalación...");

    let active = paths::portable_skill_prefix();
    let backup = runtimes_dir.join(format!(".jintia-backup-{ts}"));

    if active.exists() {
        fs::rename(&active, &backup)
            .map_err(|e| format!("Error respaldando instalación anterior: {e}"))?;
    }

    if let Err(e) = fs::rename(&stage, &active) {
        if backup.exists() {
            let _ = fs::rename(&backup, &active);
        }
        return Err(format!("Error activando nueva instalación: {e}"));
    }

    let _ = fs::remove_dir_all(&backup);

    emit_skill_progress(
        app,
        "done",
        100.0,
        &format!("Jintia {version} instalado correctamente."),
    );

    Ok(())
}

pub fn visual_install_profiles() -> Result<serde_json::Value, String> {
    let path = paths::portable_skill_source_dir()
        .join("config")
        .join("visual-install-profiles.json");

    let bytes = fs::read(&path).map_err(|e| {
        format!("No se pudo leer {}: {e}", path.display())
    })?;

    let value = serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|e| format!("Contrato visual inválido: {e}"))?;

    let version = value
        .get("version")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "El contrato visual no tiene campo 'version' numérico".to_string())?;

    if version < 3 {
        return Err(format!(
            "Versión del contrato visual demasiado antigua: {version} (mínima 3)"
        ));
    }

    let profiles = value
        .get("profiles")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "El contrato visual no tiene 'profiles' como array".to_string())?;

    let required_ids = ["minimum", "core", "full"];
    for id in required_ids {
        let found = profiles.iter().any(|p| {
            p.get("id").and_then(|v| v.as_str()) == Some(id)
        });
        if !found {
            return Err(format!("Perfil requerido '{id}' ausente en el contrato visual"));
        }
    }

    value
        .get("disciplines")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "El contrato visual no tiene 'disciplines' como objeto".to_string())?;

    Ok(value)
}

fn emit_skill_progress(app: &AppHandle, phase: &str, percent: f32, message: &str) {
    let _ = app.emit(
        "skill-download-progress",
        serde_json::json!({
            "phase": phase,
            "percent": percent,
            "message": message,
        }),
    );
}

#[cfg(test)]
mod python_activation_tests {
    use super::*;
    use std::fs;

    fn make_temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("jintia-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("crear temp dir");
        dir
    }

    fn touch_marker(dir: &std::path::Path, name: &str) {
        fs::write(dir.join(name), b"marker").expect("crear marker");
    }

    #[test]
    fn python_activation_validates_the_final_path_before_removing_backup() {
        let staged = make_temp_dir("staged");
        let python_dir = make_temp_dir("python_dir");
        let backup_dir = std::env::temp_dir().join(format!("jintia-test-backup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&backup_dir);

        touch_marker(&staged, "staged.marker");

        let mut validated_path: Option<std::path::PathBuf> = None;

        let result = activate_staged_python_runtime(&staged, &python_dir, &backup_dir, |p| {
            validated_path = Some(p.to_path_buf());
            Ok(())
        });

        assert!(result.is_ok(), "la activación debe tener éxito: {result:?}");

        let validated = validated_path.expect("el validador debe haberse llamado");
        assert_eq!(validated, python_dir, "el validador debe recibir la ruta final");

        assert!(python_dir.join("staged.marker").exists(), "el marker debe estar en python_dir");
        assert!(!staged.exists() || !staged.join("staged.marker").exists());
        assert!(!backup_dir.exists());

        let _ = fs::remove_dir_all(&python_dir);
    }

    #[test]
    fn python_activation_removes_backup_only_after_successful_validation() {
        let staged = make_temp_dir("staged2");
        let python_dir = make_temp_dir("python_dir2");
        let backup_dir = std::env::temp_dir()
            .join(format!("jintia-test-backup2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&backup_dir);

        touch_marker(&staged, "staged.marker");
        touch_marker(&python_dir, "previous.marker");

        let result = activate_staged_python_runtime(&staged, &python_dir, &backup_dir, |_| Ok(()));

        assert!(result.is_ok());
        assert!(!backup_dir.exists(), "el backup debe eliminarse tras validación exitosa");

        let _ = fs::remove_dir_all(&python_dir);
    }

    #[test]
    fn python_activation_restores_previous_runtime_when_final_validation_fails() {
        let staged = make_temp_dir("staged3");
        let python_dir = make_temp_dir("python_dir3");
        let backup_dir = std::env::temp_dir()
            .join(format!("jintia-test-backup3-{}", std::process::id()));
        let _ = fs::remove_dir_all(&backup_dir);

        touch_marker(&staged, "staged.marker");
        touch_marker(&python_dir, "previous.marker");

        let result = activate_staged_python_runtime(&staged, &python_dir, &backup_dir, |_| {
            Err("validación final falló".to_string())
        });

        assert!(result.is_err(), "debe retornar error si la validación final falla");
        assert!(result.unwrap_err().contains("verificación final"));

        assert!(python_dir.exists(), "python_dir debe existir (runtime restaurado)");
        assert!(
            python_dir.join("previous.marker").exists(),
            "el runtime anterior debe estar restaurado"
        );
        assert!(!backup_dir.exists(), "el backup no debe permanecer tras restauración");

        let _ = fs::remove_dir_all(&python_dir);
    }

    #[test]
    fn python_activation_removes_invalid_runtime_when_no_backup_exists() {
        let staged = make_temp_dir("staged4");
        let python_dir = std::env::temp_dir()
            .join(format!("jintia-test-python4-{}", std::process::id()));
        let backup_dir = std::env::temp_dir()
            .join(format!("jintia-test-backup4-{}", std::process::id()));
        let _ = fs::remove_dir_all(&python_dir);
        let _ = fs::remove_dir_all(&backup_dir);

        touch_marker(&staged, "staged.marker");

        let result = activate_staged_python_runtime(&staged, &python_dir, &backup_dir, |_| {
            Err("ejecutable no válido".to_string())
        });

        assert!(result.is_err());
        assert!(
            !python_dir.exists() || !python_dir.join("staged.marker").exists(),
            "el runtime inválido no debe permanecer en python_dir"
        );
    }
}
