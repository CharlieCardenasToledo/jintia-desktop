use crate::paths;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;
use tauri::Emitter;

const NODE_VERSION: &str = "22.13.0";

fn node_download_url() -> &'static str {
    #[cfg(target_os = "windows")]
    return "https://nodejs.org/dist/v22.13.0/node-v22.13.0-win-x64.zip";

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "https://nodejs.org/dist/v22.13.0/node-v22.13.0-darwin-arm64.tar.gz";

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "https://nodejs.org/dist/v22.13.0/node-v22.13.0-darwin-x64.tar.gz";

    #[cfg(target_os = "linux")]
    return "https://nodejs.org/dist/v22.13.0/node-v22.13.0-linux-x64.tar.xz";
}

pub fn resolve_node() -> Option<String> {
    let checker = if cfg!(target_os = "windows") {
        "where.exe"
    } else {
        "which"
    };

    if Command::new(checker)
        .arg("node")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some("node".to_string());
    }

    let portable = paths::portable_node_exe();
    if portable.is_file() {
        return Some(portable.to_string_lossy().into_owned());
    }

    None
}

pub fn portable_node_installed() -> bool {
    paths::portable_node_exe().is_file()
}

pub fn node_version() -> Option<String> {
    resolve_node().and_then(|node_bin| {
        Command::new(&node_bin)
            .arg("--version")
            .output()
            .ok()
            .and_then(|output| {
                if output.status.success() {
                    String::from_utf8(output.stdout)
                        .ok()
                        .map(|v| v.trim().to_string())
                } else {
                    None
                }
            })
    })
}

pub fn download_portable_node(app: &AppHandle) -> Result<(), String> {
    let runtimes_dir = paths::portable_runtimes_dir();
    let node_dir = runtimes_dir.join("node");
    let tmp_file = runtimes_dir.join(format!(".node-download-{}.tmp", NODE_VERSION));

    fs::create_dir_all(&runtimes_dir).map_err(|e| format!("Error creando directorio: {e}"))?;

    emit_progress(app, "downloading", 0.0, "Iniciando descarga de Node.js...");

    let url = node_download_url();
    let mut response = reqwest::blocking::get(url)
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
                file.write_all(&buffer[..n])
                    .map_err(|e| format!("Error escribiendo descarga: {e}"))?;
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
                let _ = fs::remove_file(&tmp_file);
                emit_progress(app, "error", 0.0, &format!("Error en descarga: {e}"));
                return Err(format!("Error descargando: {e}"));
            }
        }
    }

    drop(file);

    emit_progress(app, "extracting", 100.0, "Extrayendo Node.js...");

    if node_dir.exists() {
        fs::remove_dir_all(&node_dir)
            .map_err(|e| format!("Error removiendo instalación anterior: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        extract_zip(&tmp_file, &runtimes_dir)?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        extract_tar(&tmp_file, &runtimes_dir)?;
    }

    let _ = fs::remove_file(&tmp_file);

    emit_progress(app, "done", 100.0, "Node.js instalado correctamente.");

    Ok(())
}

#[cfg(target_os = "windows")]
fn extract_zip(zip_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    use zip::ZipArchive;

    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("Error abriendo ZIP: {e}"))?;

    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("Error leyendo ZIP: {e}"))?;

    let mut top_dir: Option<String> = None;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Error leyendo entrada ZIP: {e}"))?;

        let outpath = dest_dir.join(file.name());

        if let Some(p) = file.name().split('/').next() {
            if top_dir.is_none() {
                top_dir = Some(p.to_string());
            }
        }

        if file.is_dir() {
            fs::create_dir_all(&outpath)
                .map_err(|e| format!("Error creando directorio: {e}"))?;
        } else {
            if let Some(p) = outpath.parent() {
                fs::create_dir_all(p)
                    .map_err(|e| format!("Error creando directorio padre: {e}"))?;
            }
            let mut outfile = fs::File::create(&outpath)
                .map_err(|e| format!("Error creando archivo: {e}"))?;
            std::io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("Error extrayendo archivo: {e}"))?;
        }
    }

    if let Some(top) = top_dir {
        let src = dest_dir.join(&top);
        let dst = dest_dir.join("node");
        if src.exists() && src != dst {
            fs::rename(&src, &dst)
                .map_err(|e| format!("Error renombrando directorio: {e}"))?;
        }
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn extract_tar(tar_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    let output = Command::new("tar")
        .arg("-xzf")
        .arg(tar_path)
        .arg("-C")
        .arg(dest_dir)
        .output()
        .map_err(|e| format!("Error ejecutando tar: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Error extrayendo tar: {}", stderr));
    }

    let entries = fs::read_dir(dest_dir)
        .map_err(|e| format!("Error leyendo directorio: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Error en entrada de directorio: {e}"))?;
        let path = entry.path();
        let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        if filename.starts_with("node-v") && path.is_dir() {
            let dst = dest_dir.join("node");
            if dst.exists() {
                fs::remove_dir_all(&dst)
                    .map_err(|e| format!("Error removiendo directorio anterior: {e}"))?;
            }
            fs::rename(&path, &dst)
                .map_err(|e| format!("Error renombrando directorio: {e}"))?;
            break;
        }
    }

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
