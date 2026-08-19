use crate::paths;
use std::fs;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::Mutex;
use tauri::AppHandle;
use super::{try_runtime_mutation_lock, emit_dependency_progress, verify_sha256};

pub(super) static PYTHON_RUNTIME_MUTATION_LOCK: Mutex<()> = Mutex::new(());

const PYTHON_VERSION: &str = "3.13.15";
#[cfg(not(target_os = "windows"))]
const PYTHON_STANDALONE_RELEASE: &str = "20260807";
#[cfg(target_os = "windows")]
pub(super) const PYTHON_OFFICIAL_ARCHIVE_URL: &str =
    "https://www.python.org/ftp/python/3.13.15/python-3.13.15-amd64.zip";
#[cfg(target_os = "windows")]
pub(super) const PYTHON_OFFICIAL_ARCHIVE_SHA256: &str =
    "6479223746cdfb79d25865110d6f524ac98de081324e119af1dc3ae36bddc7a5";

#[cfg(not(target_os = "windows"))]
fn python_standalone_target() -> Result<&'static str, String> {
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
    #[cfg(target_os = "windows")]
    {
        return Ok(format!("python-{PYTHON_VERSION}-amd64.zip"));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let target = python_standalone_target()?;
        Ok(format!(
            "cpython-{PYTHON_VERSION}+{PYTHON_STANDALONE_RELEASE}-{target}-install_only_stripped.tar.gz"
        ))
    }
}

pub(super) struct PythonStandaloneAsset {
    pub(super) filename: String,
    pub(super) url: String,
    pub(super) sha256: String,
}

#[cfg(not(target_os = "windows"))]
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

pub(super) fn resolve_python_asset() -> Result<PythonStandaloneAsset, String> {
    let filename = python_asset_filename()?;

    #[cfg(target_os = "windows")]
    {
        return Ok(PythonStandaloneAsset {
            filename,
            url: PYTHON_OFFICIAL_ARCHIVE_URL.to_string(),
            sha256: PYTHON_OFFICIAL_ARCHIVE_SHA256.to_string(),
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
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
}

#[cfg(target_os = "windows")]
pub(super) fn extract_official_python_zip(
    archive_path: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let file = fs::File::open(archive_path)
        .map_err(|error| format!("No se pudo abrir el ZIP oficial de Python: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("No se pudo leer el ZIP oficial de Python: {error}"))?;

    fs::create_dir_all(destination)
        .map_err(|error| format!("No se pudo crear el staging de Python: {error}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("No se pudo leer una entrada del ZIP de Python: {error}"))?;
        let enclosed = entry.enclosed_name().ok_or_else(|| {
            format!("Ruta insegura rechazada en ZIP de Python: {}", entry.name())
        })?;
        let output_path = destination.join(enclosed);

        if entry.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("No se pudo crear un directorio de Python: {error}"))?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("No se pudo crear un directorio de Python: {error}"))?;
        }
        let mut output = fs::File::create(&output_path)
            .map_err(|error| format!("No se pudo crear un archivo de Python: {error}"))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("No se pudo extraer Python: {error}"))?;
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
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

const PYTHON_FINAL_VALIDATION_ATTEMPTS: usize = 4;
const PYTHON_FINAL_VALIDATION_DELAY_MS: u64 = 1_000;

// Windows Defender y otros antivirus pueden retener brevemente python.exe justo
// después del rename a su ubicación definitiva. La validación de staging ya
// demostró que el archive es válido; aquí toleramos únicamente ese bloqueo
// transitorio antes de decidir que el runtime debe apartarse.
pub fn retry_python_runtime_validation(
    prefix: &std::path::Path,
    attempts: usize,
    mut validate: impl FnMut(&std::path::Path) -> Result<(), String>,
    mut wait: impl FnMut(),
) -> Result<(), String> {
    let attempts = attempts.max(1);
    let mut last_error = String::new();

    for attempt in 1..=attempts {
        match validate(prefix) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error,
        }

        if attempt < attempts {
            wait();
        }
    }

    Err(format!(
        "Python no quedó operativo después de {attempts} intentos: {last_error}"
    ))
}

pub fn python_version_text_matches_expected(text: &str) -> bool {
    text.trim() == format!("Python {PYTHON_VERSION}")
}

pub fn quarantine_python_runtime(python_dir: &std::path::Path) -> Result<(), String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let quarantine = python_dir.with_extension(format!("invalid-{ts}"));
    if quarantine.exists() {
        fs::remove_dir_all(&quarantine)
            .map_err(|e| format!("no se pudo limpiar el quarantine preexistente: {e}"))?;
    }
    fs::rename(python_dir, &quarantine)
        .map_err(|e| format!("no se pudo apartar el runtime inválido: {e}"))?;
    if let Err(_cleanup_err) = fs::remove_dir_all(&quarantine) {
        // El runtime ya está apartado; python_dir está libre. El quarantine residual es no-fatal.
    }
    Ok(())
}

pub fn activate_staged_python_runtime(
    staged_python: &std::path::Path,
    python_dir: &std::path::Path,
    backup_dir: &std::path::Path,
    mut validate: impl FnMut(&std::path::Path) -> Result<(), String>,
    mut evict: impl FnMut(&std::path::Path) -> Result<(), String>,
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
        // Intentar apartar el runtime inválido. Si falla, python_dir sigue ocupado:
        // no intentar restaurar el backup encima de la ruta ocupada.
        if let Err(evict_error) = evict(python_dir) {
            return Err(format!(
                "El runtime Python activado no superó la verificación final: {validation_error}; \
                 no se pudo apartar el runtime inválido: {evict_error}"
            ));
        }
        // python_dir está libre; restaurar el runtime anterior si existía.
        if had_previous_runtime {
            if let Err(restore_error) = fs::rename(backup_dir, python_dir) {
                return Err(format!(
                    "El runtime Python activado no superó la verificación final: {validation_error}; \
                     no se pudo restaurar el runtime anterior: {restore_error}"
                ));
            }
        }
        return Err(format!(
            "El runtime Python activado no superó la verificación final: {validation_error}"
        ));
    }

    // Solo elimina el respaldo después de que la ubicación definitiva esté validada.
    if had_previous_runtime && backup_dir.exists() {
        if let Err(_) = fs::remove_dir_all(backup_dir) {}
    }

    Ok(())
}

fn global_python_candidates() -> Vec<std::path::PathBuf> {
    let checker = if cfg!(target_os = "windows") {
        "where.exe"
    } else {
        "which"
    };

    let mut candidates = Vec::new();
    #[cfg(target_os = "windows")]
    candidates.push(paths::official_python_user_exe());

    for command in ["python3", "python"] {
        if let Ok(output) = Command::new(checker)
            .arg(command)
            .output()
        {
            if output.status.success() {
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let candidate = std::path::PathBuf::from(line.trim());
                    if candidate.is_file() && !candidates.contains(&candidate) {
                        candidates.push(candidate);
                    }
                }
            }
        }
    }

    candidates
}

fn global_python_command() -> Option<String> {
    global_python_candidates()
        .into_iter()
        .find(|candidate| python_executable_version(candidate).is_some())
        .map(|candidate| candidate.to_string_lossy().into_owned())
}

pub fn global_python_available() -> bool {
    global_python_command().is_some()
}

pub fn resolve_python() -> Option<String> {
    let portable = paths::portable_python_exe();
    python_executable_version(&portable)
        .map(|_| portable.to_string_lossy().into_owned())
}

pub fn portable_python_installed() -> bool {
    paths::portable_python_exe().is_file()
}

pub(crate) fn managed_python_command(python: &std::path::Path) -> Command {
    let mut command = Command::new(python);
    command.arg("-I");
    command
}

pub(super) fn build_portable_python_version_command(python: &std::path::Path) -> Command {
    let mut command = managed_python_command(python);
    command.arg("--version");
    command
}

fn python_executable_version(python: &std::path::Path) -> Option<String> {
    build_portable_python_version_command(python)
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                let raw = if output.stdout.is_empty() {
                    output.stderr
                } else {
                    output.stdout
                };
                String::from_utf8(raw)
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| python_version_text_matches_expected(value))
            } else {
                None
            }
        })
}

pub fn python_version() -> Option<String> {
    resolve_python().and_then(|python_bin| {
        build_portable_python_version_command(std::path::Path::new(&python_bin))
            .output()
            .ok()
            .and_then(|output| {
                if output.status.success() {
                    let raw = if output.stdout.is_empty() {
                        output.stderr
                    } else {
                        output.stdout
                    };
                    String::from_utf8(raw)
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| python_version_text_matches_expected(value))
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

    emit_python_progress(app, "resolving", 0.0, "Resolviendo runtime privado de Python...");

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

    emit_python_progress(app, "extracting", 65.0, "Extrayendo Python en el entorno privado...");
    let extraction_result = {
        #[cfg(target_os = "windows")]
        {
            extract_official_python_zip(&tmp_archive, &stage_dir.join("python"))
        }

        #[cfg(not(target_os = "windows"))]
        {
            extract_python_tar_gz(&tmp_archive, &stage_dir)
        }
    };
    extraction_result.map_err(|e| {
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
        |prefix| {
            retry_python_runtime_validation(
                prefix,
                PYTHON_FINAL_VALIDATION_ATTEMPTS,
                validate_python_runtime,
                || {
                    std::thread::sleep(std::time::Duration::from_millis(
                        PYTHON_FINAL_VALIDATION_DELAY_MS,
                    ));
                },
            )
        },
        quarantine_python_runtime,
    ) {
        let _ = fs::remove_dir_all(&stage_dir);
        return Err(error);
    }

    let _ = fs::remove_dir_all(&stage_dir);

    emit_python_progress(app, "done", 100.0, "Python oficial portable instalado correctamente.");
    Ok(())
}

fn emit_python_progress(app: &AppHandle, phase: &str, percent: f32, message: &str) {
    emit_dependency_progress(app, "Python", phase, Some(percent), message);
    let _ = tauri::Emitter::emit(app,
        "python-download-progress",
        serde_json::json!({
            "phase": phase,
            "percent": percent,
            "message": message,
        }),
    );
}

pub fn install_pip_packages(packages: &[String]) -> Result<(), String> {
    if packages.is_empty() {
        return Ok(());
    }
    let _python_guard = try_runtime_mutation_lock(&PYTHON_RUNTIME_MUTATION_LOCK, "el runtime Python administrado")?;
    let python_exe = resolve_python()
        .map(std::path::PathBuf::from)
        .ok_or("Ningún runtime Python administrado está operativo.")?;
    let managed_path = managed_python_runtime_path(&python_exe)?;
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

pub fn managed_python_runtime_path(python: &std::path::Path) -> Result<std::ffi::OsString, String> {
    let prefix = python
        .parent()
        .ok_or_else(|| format!("Python no tiene directorio padre: {}", python.display()))?
        .to_path_buf();
    let entries = if cfg!(target_os = "windows") {
        vec![prefix.clone(), prefix.join("Scripts")]
    } else {
        vec![prefix.join("bin")]
    };

    std::env::join_paths(entries)
        .map_err(|error| format!("No se pudo construir el PATH del Python administrado: {error}"))
}

pub fn build_managed_pip_install_command(
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
