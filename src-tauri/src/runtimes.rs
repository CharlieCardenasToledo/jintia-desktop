use crate::paths;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
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
    return "https://nodejs.org/dist/v22.13.0/node-v22.13.0-linux-x64.tar.xz";
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

    let version_out = Command::new(&python_exe)
        .arg("--version")
        .output()
        .map_err(|e| format!("No se pudo ejecutar python --version: {e}"))?;

    let version_text = String::from_utf8_lossy(
        if version_out.stdout.is_empty() {
            &version_out.stderr
        } else {
            &version_out.stdout
        }
    );

    if !version_text.trim().starts_with("Python 3.13.") {
        return Err(format!(
            "Versión de Python inesperada: {}",
            version_text.trim()
        ));
    }

    let pip_out = Command::new(&python_exe)
        .args(["-m", "pip", "--version"])
        .output()
        .map_err(|e| format!("No se pudo ejecutar python -m pip --version: {e}"))?;

    if !pip_out.status.success() {
        let stderr = String::from_utf8_lossy(&pip_out.stderr);
        return Err(format!("pip no está operativo: {}", stderr.trim()));
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
    let runtimes_dir = paths::portable_runtimes_dir();
    fs::create_dir_all(&runtimes_dir)
        .map_err(|e| format!("Error creando directorio: {e}"))?;

    emit_python_progress(app, "resolving", 0.0, "Resolviendo asset de Python...");

    let asset = resolve_python_asset()?;

    let tmp_archive = runtimes_dir.join(format!(".python-download-{}.tmp", PYTHON_VERSION));

    emit_python_progress(app, "downloading", 5.0, &format!("Descargando {}...", asset.filename));

    let mut response = reqwest::blocking::get(&asset.url)
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
                file.write_all(&buffer[..n])
                    .map_err(|e| format!("Error escribiendo descarga: {e}"))?;
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

    if python_dir.exists() {
        fs::rename(&python_dir, &backup_dir)
            .map_err(|e| format!("Error preparando reemplazo de Python: {e}"))?;
    }

    match fs::rename(&staged_python, &python_dir) {
        Ok(_) => {
            if backup_dir.exists() {
                let _ = fs::remove_dir_all(&backup_dir);
            }
            let _ = fs::remove_dir_all(&stage_dir);
        }
        Err(e) => {
            if backup_dir.exists() {
                let _ = fs::rename(&backup_dir, &python_dir);
            }
            let _ = fs::remove_dir_all(&stage_dir);
            return Err(format!("Error activando Python: {e}"));
        }
    }

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

fn notebooklm_lock_entry<'a>(lock: &'a serde_json::Value, package_name: &str) -> Option<&'a serde_json::Value> {
    let key = format!("node_modules/{package_name}");
    lock.get("packages")?.get(&key)
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

pub fn resolve_notebooklm_mcp_bin(package_dir: &std::path::Path) -> Result<PathBuf, String> {
    let contract = crate::release::managed_mcp_contract()?;
    resolve_notebooklm_mcp_bin_for(package_dir, &contract)
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

fn run_notebooklm_browser_command(node: &std::path::Path, bin: &std::path::Path, action: &str) -> Result<NotebookLmBrowserStatus, String> {
    let output = Command::new(node).arg(bin).args(["browser", action, "--json"]).output()
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

pub fn portable_notebooklm_mcp_installed() -> bool {
    let Ok(contract) = crate::release::managed_mcp_contract() else { return false; };
    portable_notebooklm_mcp_installed_for(&contract)
}

pub fn portable_notebooklm_mcp_installed_for(contract: &crate::release::ManagedMcpContract) -> bool {
    let package = paths::portable_notebooklm_mcp_package_dir().join("package.json");
    let lock = paths::portable_notebooklm_mcp_lock();
    let Ok(package) = fs::read_to_string(package) else { return false; };
    let Ok(package) = serde_json::from_str::<serde_json::Value>(&package) else { return false; };
    let Ok(lock) = fs::read_to_string(lock) else { return false; };
    let Ok(lock) = serde_json::from_str::<serde_json::Value>(&lock) else { return false; };
    package.get("name").and_then(|v| v.as_str()) == Some(contract.package.as_str())
        && package.get("version").and_then(|v| v.as_str()) == Some(contract.version.as_str())
        && notebooklm_lock_entry(&lock, &contract.package)
            .and_then(|entry| entry.get("integrity"))
            .and_then(|value| value.as_str()) == Some(contract.npm_integrity.as_str())
        && resolve_notebooklm_mcp_bin_for(&paths::portable_notebooklm_mcp_package_dir(), contract).is_ok()
        && validate_notebooklm_browser(&paths::portable_node_exe(), &paths::portable_notebooklm_mcp_package_dir(), &paths::portable_notebooklm_mcp_prefix().join("node_modules"), "status", contract).is_ok()
}

pub fn install_notebooklm_mcp() -> Result<(), String> {
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
    let package = serde_json::json!({"private": true, "dependencies": {contract.package.clone(): contract.version.clone()}});
    let result = (|| -> Result<(), String> {
        fs::write(stage.join("package.json"), serde_json::to_vec_pretty(&package).unwrap()).map_err(|e| e.to_string())?;
        let run = |args: &[&str]| -> Result<(), String> {
            let output = Command::new(&node).arg(&npm).args(args).current_dir(&stage).output().map_err(|e| e.to_string())?;
            if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).to_string()); }
            Ok(())
        };
        run(&["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"])?;
        let lock: serde_json::Value = serde_json::from_slice(&fs::read(stage.join("package-lock.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let entry = notebooklm_lock_entry(&lock, &contract.package).ok_or("El lock de NotebookLM MCP no contiene el paquete.")?;
        if entry.get("version").and_then(|v| v.as_str()) != Some(contract.version.as_str()) || entry.get("integrity").and_then(|v| v.as_str()) != Some(contract.npm_integrity.as_str()) { return Err("El integrity de NotebookLM MCP no coincide con el contrato administrado de Jintia.".to_string()); }
        run(&["ci", "--ignore-scripts", "--no-audit", "--no-fund"])?;
        let package_dir = stage.join("node_modules").join("@charlie.act7").join("gemini-notebook-mcp");
        validate_notebooklm_browser(&node, &package_dir, &stage.join("node_modules"), "install", &contract)?;
        validate_notebooklm_browser(&node, &package_dir, &stage.join("node_modules"), "status", &contract)?;
        let active = paths::portable_notebooklm_mcp_prefix();
        let backup = root.join(format!(".notebooklm-mcp-backup-{}", paths::timestamp()));
        if active.exists() { fs::rename(&active, &backup).map_err(|e| e.to_string())?; }
        if let Err(error) = fs::rename(&stage, &active) { if backup.exists() { let _ = fs::rename(&backup, &active); } return Err(error.to_string()); }
        let active_package = active.join("node_modules").join("@charlie.act7").join("gemini-notebook-mcp");
        if let Err(error) = validate_notebooklm_browser(&node, &active_package, &active.join("node_modules"), "status", &contract) {
            let _ = fs::remove_dir_all(&active);
            if backup.exists() { let _ = fs::rename(&backup, &active); }
            return Err(error);
        }
        if backup.exists() { let _ = fs::remove_dir_all(backup); }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&stage); }
    result
}

#[cfg(test)]
mod tests {
    use super::{notebooklm_lock_entry, resolve_notebooklm_mcp_bin_for};
    use std::fs;

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

    None
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

    let portable_bin = paths::portable_node_bin_dir();
    let base_path = std::env::var_os("PATH").unwrap_or_default();
    let mut path_entries = vec![portable_bin];
    for entry in std::env::split_paths(&base_path) {
        if !path_entries.contains(&entry) {
            path_entries.push(entry);
        }
    }
    let patched_path = std::env::join_paths(path_entries).ok()?;

    let output = if cfg!(target_os = "windows")
        && executable
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                ext.eq_ignore_ascii_case("cmd")
            })
    {
        Command::new("cmd")
            .arg("/C")
            .arg(&executable)
            .args(args)
            .env("PATH", &patched_path)
            .output()
            .ok()?
    } else {
        Command::new(&node)
            .arg(&executable)
            .args(args)
            .env("PATH", &patched_path)
            .output()
            .ok()?
    };

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

pub fn install_vivliostyle() -> Result<(), String> {
    let npm = npm_exe().ok_or_else(|| "Node portable no está instalado.".to_string())?;

    let node = paths::portable_node_exe();
    if !node.is_file() {
        return Err("El ejecutable Node portable no está disponible.".to_string());
    }

    let prefix = paths::portable_node_prefix();
    let portable_bin = paths::portable_node_bin_dir();

    let base_path = std::env::var_os("PATH").unwrap_or_default();
    let mut path_entries = vec![portable_bin];
    for entry in std::env::split_paths(&base_path) {
        if !path_entries.contains(&entry) {
            path_entries.push(entry);
        }
    }
    let patched_path = std::env::join_paths(path_entries)
        .map_err(|e| format!("No se pudo preparar PATH para npm portable: {e}"))?;

    let output = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .arg("/C")
            .arg(&npm)
            .arg("install")
            .arg("--global")
            .arg("--prefix")
            .arg(&prefix)
            .arg("@vivliostyle/cli")
            .env("PATH", &patched_path)
            .output()
    } else {
        Command::new(&node)
            .arg(&npm)
            .arg("install")
            .arg("--global")
            .arg("--prefix")
            .arg(&prefix)
            .arg("@vivliostyle/cli")
            .env("PATH", &patched_path)
            .output()
    }
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
    let npm = npm_exe().ok_or_else(|| "Node portable no está instalado.".to_string())?;
    let node = paths::portable_node_exe();
    if !node.is_file() {
        return Err("El ejecutable Node portable no está disponible.".to_string());
    }

    let runtimes_dir = paths::portable_runtimes_dir();
    fs::create_dir_all(&runtimes_dir)
        .map_err(|e| format!("Error creando directorio de runtimes: {e}"))?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stage = runtimes_dir.join(format!(".jintia-stage-{ts}"));

    let portable_bin = paths::portable_node_bin_dir();
    let base_path = std::env::var_os("PATH").unwrap_or_default();
    let mut path_entries = vec![portable_bin];
    for entry in std::env::split_paths(&base_path) {
        if !path_entries.contains(&entry) {
            path_entries.push(entry);
        }
    }
    let patched_path = std::env::join_paths(path_entries)
        .map_err(|e| format!("No se pudo preparar PATH para npm: {e}"))?;

    emit_skill_progress(app, "installing", 5.0, "Instalando Jintia desde npm...");

    let output = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .arg("/C")
            .arg(&npm)
            .arg("install")
            .arg("--global")
            .arg("--prefix")
            .arg(&stage)
            .arg("@charlie.act7/jintia@latest")
            .arg("--no-audit")
            .arg("--no-fund")
            .env("PATH", &patched_path)
            .output()
    } else {
        Command::new(&node)
            .arg(&npm)
            .arg("install")
            .arg("--global")
            .arg("--prefix")
            .arg(&stage)
            .arg("@charlie.act7/jintia@latest")
            .arg("--no-audit")
            .arg("--no-fund")
            .env("PATH", &patched_path)
            .output()
    }
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

    let smoke_output = Command::new(&node)
        .arg(&skill_js)
        .arg("capabilities")
        .arg("profiles")
        .arg("--json")
        .env("PATH", &patched_path)
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
