use crate::paths;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;
use tauri::Emitter;
use sha2::{Digest, Sha256};
use sha1::Sha1;
use hex;

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

    emit_progress(app, "verifying", 100.0, "Verificando integridad del archivo...");
    let expected_checksum = fetch_node_checksum().unwrap_or_default();
    if !expected_checksum.is_empty() {
        verify_sha256(&tmp_file, &expected_checksum).map_err(|e| {
            let _ = fs::remove_file(&tmp_file);
            e
        })?;
    }

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

// ==================== PYTHON RUNTIME ====================

const PYTHON_VERSION: &str = "3.13.0";
const GET_PIP_URL: &str = "https://bootstrap.pypa.io/get-pip.py";

fn python_download_url() -> Option<&'static str> {
    #[cfg(target_os = "windows")]
    return Some("https://www.python.org/ftp/python/3.13.0/python-3.13.0-embed-amd64.zip");

    #[cfg(not(target_os = "windows"))]
    return None;
}

pub fn resolve_python() -> Option<String> {
    let checker = if cfg!(target_os = "windows") {
        "where.exe"
    } else {
        "which"
    };

    for cmd in &["python3", "python"] {
        if Command::new(checker)
            .arg(cmd)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return Some(cmd.to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        let portable = paths::portable_python_exe();
        if portable.is_file() {
            return Some(portable.to_string_lossy().into_owned());
        }
    }

    None
}

pub fn portable_python_installed() -> bool {
    #[cfg(target_os = "windows")]
    return paths::portable_python_exe().is_file();

    #[cfg(not(target_os = "windows"))]
    return false;
}

pub fn python_version() -> Option<String> {
    resolve_python().and_then(|python_bin| {
        Command::new(&python_bin)
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

pub fn download_portable_python(app: &AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    return Err("Python portable solo está disponible en Windows".to_string());

    #[cfg(target_os = "windows")]
    {
        let runtimes_dir = paths::portable_runtimes_dir();
        let python_dir = runtimes_dir.join("python");
        let tmp_file = runtimes_dir.join(format!(".python-download-{}.tmp", PYTHON_VERSION));

        fs::create_dir_all(&runtimes_dir)
            .map_err(|e| format!("Error creando directorio: {e}"))?;

        emit_python_progress(app, "downloading", 0.0, "Descargando Python 3.13.0...");

        let url = python_download_url()
            .ok_or("Python portable no disponible para esta plataforma")?;
        let mut response = reqwest::blocking::get(url)
            .map_err(|e| format!("Error descargando Python: {e}"))?;

        let total_size = response.content_length().unwrap_or(12_000_000u64);
        let mut file = fs::File::create(&tmp_file)
            .map_err(|e| format!("Error creando archivo temporal: {e}"))?;

        let mut downloaded: u64 = 0;
        let mut buffer = [0; 1024 * 64];

        loop {
            match response.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    file.write_all(&buffer[..n])
                        .map_err(|e| format!("Error escribiendo descarga: {e}"))?;
                    downloaded += n as u64;
                    let percent = (downloaded as f32 / total_size as f32) * 100.0;
                    emit_python_progress(
                        app,
                        "downloading",
                        percent,
                        &format!("Descargando Python ({:.1}%)", percent),
                    );
                }
                Err(e) => {
                    let _ = fs::remove_file(&tmp_file);
                    emit_python_progress(app, "error", 0.0, &format!("Error en descarga: {e}"));
                    return Err(format!("Error descargando: {e}"));
                }
            }
        }

        drop(file);

        emit_python_progress(app, "verifying", 50.0, "Verificando integridad del archivo...");
        let expected_checksum = fetch_python_checksum().unwrap_or_default();
        if !expected_checksum.is_empty() {
            verify_sha256(&tmp_file, &expected_checksum).map_err(|e| {
                let _ = fs::remove_file(&tmp_file);
                e
            })?;
        }

        emit_python_progress(app, "extracting", 55.0, "Extrayendo Python...");

        if python_dir.exists() {
            fs::remove_dir_all(&python_dir)
                .map_err(|e| format!("Error removiendo instalación anterior: {e}"))?;
        }

        extract_python_zip(&tmp_file, &runtimes_dir)?;
        let _ = fs::remove_file(&tmp_file);

        emit_python_progress(app, "configuring", 70.0, "Configurando Python...");
        enable_python_site(&python_dir)?;

        emit_python_progress(app, "installing_pip", 80.0, "Instalando pip...");
        install_python_pip(&python_dir)?;

        emit_python_progress(app, "done", 100.0, "Python instalado correctamente.");

        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn extract_python_zip(zip_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    use zip::ZipArchive;

    let file = fs::File::open(zip_path)
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
            if top_dir.is_none() && p.contains("python") {
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
        let dst = dest_dir.join("python");
        if src.exists() && src != dst {
            fs::rename(&src, &dst)
                .map_err(|e| format!("Error renombrando directorio: {e}"))?;
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn enable_python_site(python_dir: &std::path::Path) -> Result<(), String> {
    let pth_path = python_dir.join("python313._pth");

    if !pth_path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&pth_path)
        .map_err(|e| format!("Error leyendo ._pth: {e}"))?;

    let modified = content.lines()
        .map(|line| {
            if line.trim() == "#import site" {
                "import site".to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    fs::write(&pth_path, modified)
        .map_err(|e| format!("Error escribiendo ._pth: {e}"))?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn install_python_pip(python_dir: &std::path::Path) -> Result<(), String> {
    let get_pip_path = python_dir.join("get-pip.py");
    let python_exe = python_dir.join("python.exe");

    let pip_script = reqwest::blocking::get(GET_PIP_URL)
        .map_err(|e| format!("Error descargando get-pip.py: {e}"))?
        .text()
        .map_err(|e| format!("Error leyendo get-pip.py: {e}"))?;

    fs::write(&get_pip_path, &pip_script)
        .map_err(|e| format!("Error escribiendo get-pip.py: {e}"))?;

    let output = Command::new(&python_exe)
        .args(&[
            get_pip_path.to_string_lossy().as_ref(),
            "--no-warn-script-location",
        ])
        .output()
        .map_err(|e| format!("Error ejecutando get-pip.py: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("get-pip.py falló: {}", stderr));
    }

    let _ = fs::remove_file(&get_pip_path);

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
    let python_exe = paths::portable_python_exe();
    if !python_exe.is_file() {
        return Err("Python portable no está instalado.".to_string());
    }
    let output = Command::new(&python_exe)
        .args(["-m", "pip", "install", "--quiet"])
        .args(packages)
        .output()
        .map_err(|e| format!("Error ejecutando pip: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pip install falló: {stderr}"));
    }
    Ok(())
}

// ==================== NPM PACKAGES ====================

fn npm_exe() -> Option<std::path::PathBuf> {
    let node_exe = paths::portable_node_exe();
    if !node_exe.is_file() {
        return None;
    }
    let npm = node_exe
        .parent()?
        .join(if cfg!(windows) { "npm.cmd" } else { "npm" });
    if npm.exists() { Some(npm) } else { None }
}

pub fn resolve_vivliostyle() -> Option<PathBuf> {
    let portable = paths::portable_vivliostyle_bin();
    if portable.is_file() {
        return Some(portable);
    }

    let checker = if cfg!(target_os = "windows") {
        "where.exe"
    } else {
        "which"
    };

    let output = Command::new(checker)
        .arg("vivliostyle")
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| PathBuf::from(line.trim()))
}

pub fn vivliostyle_version() -> Option<String> {
    let executable = resolve_vivliostyle()?;

    let output = if cfg!(target_os = "windows")
        && executable
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd"))
    {
        Command::new("cmd")
            .arg("/C")
            .arg(&executable)
            .arg("--version")
            .output()
            .ok()?
    } else {
        Command::new(&executable)
            .arg("--version")
            .output()
            .ok()?
    };

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

pub fn install_vivliostyle() -> Result<(), String> {
    let npm = npm_exe().ok_or_else(|| "Node portable no está instalado.".to_string())?;
    let prefix = paths::portable_node_prefix();

    let output = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .arg("/C")
            .arg(&npm)
            .arg("install")
            .arg("--global")
            .arg("--prefix")
            .arg(&prefix)
            .arg("@vivliostyle/cli")
            .output()
    } else {
        Command::new(&npm)
            .arg("install")
            .arg("--global")
            .arg("--prefix")
            .arg(&prefix)
            .arg("@vivliostyle/cli")
            .output()
    }
    .map_err(|e| format!("No se pudo ejecutar npm: {e}"))?;

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

    let npm = npm_exe()
        .ok_or_else(|| "Node portable no está instalado.".to_string())?;

    let node = paths::portable_node_exe();

    if !node.is_file() {
        return Err(
            "El ejecutable Node portable no está disponible.".to_string()
        );
    }

    let prefix = paths::portable_node_prefix();
    let portable_bin = paths::portable_node_bin_dir();

    // Los procesos npm y sus scripts lifecycle deben resolver primero
    // el Node y los binarios administrados por Jintia.
    let base_path =
        std::env::var_os("PATH").unwrap_or_default();

    let mut path_entries = vec![portable_bin];

    for entry in std::env::split_paths(&base_path) {
        if !path_entries.contains(&entry) {
            path_entries.push(entry);
        }
    }

    let patched_path = std::env::join_paths(path_entries)
        .map_err(|e| {
            format!(
                "No se pudo preparar PATH para npm portable: {e}"
            )
        })?;

    let output = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .arg("/C")
            .arg(&npm)
            .arg("install")
            .arg("--global")
            .arg("--prefix")
            .arg(&prefix)
            .args(packages)
            .env("PATH", &patched_path)
            .output()
    } else {
        // Ejecutar npm explícitamente con el Node portable evita
        // depender de `#!/usr/bin/env node` y de un Node del sistema.
        Command::new(&node)
            .arg(&npm)
            .arg("install")
            .arg("--global")
            .arg("--prefix")
            .arg(&prefix)
            .args(packages)
            .env("PATH", &patched_path)
            .output()
    }
    .map_err(|e| {
        format!(
            "No se pudo ejecutar npm con el runtime portable: {e}"
        )
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

fn verify_sha1(file_path: &std::path::Path, expected_hex: &str) -> Result<(), String> {
    let mut file = fs::File::open(file_path)
        .map_err(|e| format!("Error abriendo archivo para verificar: {e}"))?;

    let mut hasher = Sha1::new();
    let mut buffer = [0u8; 1024 * 64];

    loop {
        let n = file.read(&mut buffer)
            .map_err(|e| format!("Error leyendo para checksum: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }

    let digest_result = hasher.finalize();
    let actual = hex::encode(digest_result);
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

fn fetch_node_checksum() -> Result<String, String> {
    let url = format!("https://nodejs.org/dist/v{NODE_VERSION}/SHASUMS256.txt");
    let text = reqwest::blocking::get(&url)
        .map_err(|e| format!("Error descargando checksums: {e}"))?
        .text()
        .map_err(|e| format!("Error leyendo checksums: {e}"))?;

    let filename = node_download_url()
        .rsplit('/')
        .next()
        .unwrap_or("");

    for line in text.lines() {
        let parts: Vec<&str> = line.splitn(2, "  ").collect();
        if parts.len() == 2 && parts[1].trim() == filename {
            return Ok(parts[0].trim().to_string());
        }
    }

    Err(format!("Checksum no encontrado para {filename}"))
}

#[cfg(target_os = "windows")]
fn fetch_python_checksum() -> Result<String, String> {
    let url = format!(
        "https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip.sha256"
    );
    reqwest::blocking::get(&url)
        .map_err(|e| format!("Error descargando checksum Python: {e}"))?
        .text()
        .map_err(|e| format!("Error leyendo checksum Python: {e}"))
        .and_then(|t| {
            t.split_whitespace()
                .next()
                .map(|s| s.to_string())
                .ok_or_else(|| "Checksum vacío en archivo".to_string())
        })
}

// ==================== SKILL RUNTIME ====================

pub fn portable_skill_installed() -> bool {
    paths::portable_skill_bin().is_file()
}

pub fn resolve_skill() -> Option<String> {
    // Portable administrado por Desktop tiene prioridad: versión conocida, verificada.
    let portable = paths::portable_skill_bin();
    if portable.is_file() {
        return Some(portable.to_string_lossy().into_owned());
    }

    // Fallback: jintia global en PATH (instalación manual del usuario).
    let checker = if cfg!(target_os = "windows") { "where.exe" } else { "which" };
    if Command::new(checker)
        .arg("jintia")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some("jintia".to_string());
    }

    None
}

fn fetch_npm_package_info(package: &str) -> Result<(String, String, String), String> {
    let encoded = package.replace('@', "%40").replace('/', "%2F");
    let url = format!("https://registry.npmjs.org/{}/latest", encoded);
    let response = reqwest::blocking::get(&url)
        .map_err(|e| format!("Error descargando metadata npm: {e}"))?;
    let text = response.text()
        .map_err(|e| format!("Error leyendo metadata: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Error parseando npm metadata: {e}"))?;

    let version = json["version"]
        .as_str()
        .ok_or("Version not found in npm metadata")?
        .to_string();
    let tarball = json["dist"]["tarball"]
        .as_str()
        .ok_or("Tarball URL not found in npm metadata")?
        .to_string();
    let shasum = json["dist"]["shasum"]
        .as_str()
        .unwrap_or("")
        .to_string();

    Ok((version, tarball, shasum))
}

pub fn download_portable_skill(app: &AppHandle) -> Result<(), String> {
    let runtimes_dir = paths::portable_runtimes_dir();
    let skill_dir = runtimes_dir.join("jintia");

    fs::create_dir_all(&runtimes_dir)
        .map_err(|e| format!("Error creando directorio: {e}"))?;

    emit_skill_progress(app, "detecting", 0.0, "Detectando versión de Jintia en npm...");

    let (version, tarball_url, expected_shasum) = fetch_npm_package_info("@charlie.act7/jintia")?;

    let tmp_file = runtimes_dir.join(format!(".jintia-download-{}.tmp", version));

    emit_skill_progress(app, "downloading", 5.0, &format!("Descargando Jintia {version}..."));

    let mut response = reqwest::blocking::get(&tarball_url)
        .map_err(|e| format!("Error descargando Jintia: {e}"))?;

    let total_size = response.content_length().unwrap_or(50_000_000u64);
    let mut file = fs::File::create(&tmp_file)
        .map_err(|e| format!("Error creando archivo temporal: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut buffer = [0; 1024 * 64];

    loop {
        match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                file.write_all(&buffer[..n])
                    .map_err(|e| format!("Error escribiendo descarga: {e}"))?;
                downloaded += n as u64;
                let percent = 5.0 + (downloaded as f32 / total_size as f32) * 85.0;
                emit_skill_progress(
                    app,
                    "downloading",
                    percent,
                    &format!("Descargando Jintia ({:.1}%)", percent),
                );
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp_file);
                emit_skill_progress(app, "error", 0.0, &format!("Error en descarga: {e}"));
                return Err(format!("Error descargando: {e}"));
            }
        }
    }

    drop(file);

    if !expected_shasum.is_empty() {
        emit_skill_progress(app, "verifying", 90.0, "Verificando integridad de Jintia...");
        verify_sha1(&tmp_file, &expected_shasum).map_err(|e| {
            let _ = fs::remove_file(&tmp_file);
            e
        })?;
    }

    emit_skill_progress(app, "extracting", 92.0, "Extrayendo Jintia...");

    if skill_dir.exists() {
        fs::remove_dir_all(&skill_dir)
            .map_err(|e| format!("Error removiendo instalación anterior: {e}"))?;
    }

    extract_skill_tgz(&tmp_file, &runtimes_dir)?;
    let _ = fs::remove_file(&tmp_file);

    emit_skill_progress(app, "configuring", 96.0, "Configurando Jintia...");

    #[cfg(not(target_os = "windows"))]
    {
        let jintia_bin = paths::portable_skill_bin();
        Command::new("chmod")
            .arg("+x")
            .arg(&jintia_bin)
            .output()
            .ok();
    }

    emit_skill_progress(app, "done", 100.0, "Jintia instalado correctamente.");

    Ok(())
}

fn extract_skill_tgz(tgz_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    let output = Command::new("tar")
        .arg("-xzf")
        .arg(tgz_path)
        .arg("-C")
        .arg(dest_dir)
        .output()
        .map_err(|e| format!("Error ejecutando tar: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Error extrayendo tgz: {}", stderr));
    }

    let entries = fs::read_dir(dest_dir)
        .map_err(|e| format!("Error leyendo directorio: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Error en entrada de directorio: {e}"))?;
        let path = entry.path();
        let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        if filename.starts_with("package") && path.is_dir() {
            let dst = dest_dir.join("jintia");
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
