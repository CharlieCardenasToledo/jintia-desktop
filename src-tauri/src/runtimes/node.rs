use crate::paths;
use std::fs;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::Mutex;
use tauri::AppHandle;
use super::{try_runtime_mutation_lock, emit_progress, verify_sha256, fetch_node_checksum};

pub(super) static NODE_RUNTIME_MUTATION_LOCK: Mutex<()> = Mutex::new(());

pub const NODE_VERSION: &str = "22.13.0";

pub fn node_download_url() -> &'static str {
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
    // Todo lo que corre bajo el runtime Node administrado por Jintia (skill,
    // npm, engine.rs, y el MCP de NotebookLM vía build_managed_mcp_server_command)
    // es un proceso interno, nunca algo que el usuario deba ver como consola.
    crate::process::background::configure_background_process(
        &mut command,
        crate::process::background::process_mode(),
    );
    command
}

pub(super) fn build_portable_node_version_command(node: &std::path::Path) -> Command {
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

pub fn node_version_text_matches_expected(text: &str) -> bool {
    text.trim() == format!("v{NODE_VERSION}")
}

pub(super) fn build_staged_node_version_command(node: &std::path::Path) -> Command {
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

pub fn activate_staged_node_runtime(
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
pub fn extract_zip(zip_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
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
pub fn extract_node_tar_gz(
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
