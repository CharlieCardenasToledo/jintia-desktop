use crate::paths;
use std::fs;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::AppHandle;
use super::{try_runtime_mutation_lock, emit_dependency_progress, verify_sha256};

pub(super) static TOOLS_MUTATION_LOCK: Mutex<()> = Mutex::new(());

fn current_platform_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "win32-x64";
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "darwin-arm64";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "darwin-x64";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x64";
    #[allow(unreachable_code)]
    "unknown"
}

/// Re-exporta los tipos del contrato para que los consumidores no necesiten
/// importar `release` directamente.
pub use crate::release::BinaryPlatformSpec;

/// Devuelve la especificación de instalación para `binary_id` en la plataforma
/// actual, leyendo el contrato tipado de `release`.
///
/// - `Ok(BinaryPlatformSpec::Download(_))`: descarga automática disponible.
/// - `Ok(BinaryPlatformSpec::ManualOnly { hint })`: requiere instalación manual.
/// - `Err(_)`: el binario no está declarado en el contrato o el contrato no está disponible.
pub fn profile_binary_platform_spec(binary_id: &str) -> Result<BinaryPlatformSpec, String> {
    let contract = crate::release::managed_release_contract()?;
    let binary = contract.profile_binaries.get(binary_id).ok_or_else(|| {
        format!(
            "'{binary_id}' no está declarado en profileBinaries del contrato Jintia. \
             Actualiza Jintia desde Configuración > Entorno."
        )
    })?;
    binary.current_platform_spec.clone().ok_or_else(|| {
        let platform = current_platform_key();
        format!(
            "'{binary_id}' no tiene una especificación para esta plataforma ({platform}). \
             Instálalo manualmente desde las herramientas de tu sistema."
        )
    })
}

/// Descarga, verifica e instala un binario de perfil en
/// `runtimes/tools/<id>/bin/`.  Si ya existe una instalación anterior la
/// reemplaza con backup y rollback en caso de fallo.
///
/// Retorna `Err` con instrucciones accionables si el binario requiere
/// instalación manual en esta plataforma.
pub fn install_profile_binary(app: &AppHandle, binary_id: &str) -> Result<(), String> {
    let _lock = try_runtime_mutation_lock(
        &TOOLS_MUTATION_LOCK,
        &format!("el binario de perfil {binary_id}"),
    )?;

    let platform_spec = profile_binary_platform_spec(binary_id)?;
    let spec = match platform_spec {
        BinaryPlatformSpec::ManualOnly { hint } => {
            return Err(format!(
                "'{binary_id}' requiere instalación manual en esta plataforma. {hint}"
            ));
        }
        BinaryPlatformSpec::Download(download_spec) => download_spec,
    };

    let tools_dir = paths::portable_tools_dir();
    fs::create_dir_all(&tools_dir)
        .map_err(|e| format!("No se pudo crear el directorio tools/: {e}"))?;

    let tmp_file = tools_dir.join(format!(".{binary_id}-download-{}.tmp", paths::timestamp()));

    emit_dependency_progress(
        app, binary_id, "downloading", None,
        &format!("Descargando {binary_id}…"),
    );

    // Descarga
    let mut response = reqwest::blocking::get(&spec.url)
        .map_err(|e| format!("Error descargando {binary_id}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Error descargando {binary_id}: {e}"))?;

    let total_size = response.content_length().unwrap_or(50_000_000);
    let mut file = fs::File::create(&tmp_file)
        .map_err(|e| format!("Error creando archivo temporal: {e}"))?;
    let mut downloaded: u64 = 0;
    let mut buffer = [0u8; 1024 * 64];
    loop {
        match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                if let Err(e) = file.write_all(&buffer[..n]) {
                    drop(file);
                    let _ = fs::remove_file(&tmp_file);
                    return Err(format!("Error escribiendo descarga de {binary_id}: {e}"));
                }
                downloaded += n as u64;
                let percent = (downloaded as f32 / total_size as f32) * 100.0;
                emit_dependency_progress(
                    app, binary_id, "downloading", Some(percent),
                    &format!("Descargando {binary_id} ({:.1}%)", percent),
                );
            }
            Err(e) => {
                drop(file);
                let _ = fs::remove_file(&tmp_file);
                return Err(format!("Error en la descarga de {binary_id}: {e}"));
            }
        }
    }
    drop(file);

    // Verificación de integridad
    emit_dependency_progress(
        app, binary_id, "verifying", None,
        &format!("Verificando integridad de {binary_id}…"),
    );
    verify_sha256(&tmp_file, &spec.sha256).map_err(|e| {
        let _ = fs::remove_file(&tmp_file);
        e
    })?;

    // Extracción a directorio de staging
    let stage_dir = tools_dir.join(format!(".{binary_id}-stage-{}", paths::timestamp()));
    fs::create_dir_all(&stage_dir)
        .map_err(|e| format!("Error creando staging de {binary_id}: {e}"))?;

    emit_dependency_progress(
        app, binary_id, "extracting", None,
        &format!("Extrayendo {binary_id}…"),
    );

    let extract_result = extract_profile_binary_archive(
        &tmp_file,
        &stage_dir,
        &spec.archive_type,
        spec.bin_subdir.as_deref(),
    );
    let _ = fs::remove_file(&tmp_file);

    if let Err(e) = extract_result {
        let _ = fs::remove_dir_all(&stage_dir);
        return Err(e);
    }

    // Activación (con rollback si ya existía una versión anterior)
    let tool_dir = paths::portable_tool_dir(binary_id);
    if tool_dir.exists() {
        let backup = tools_dir.join(format!(".{binary_id}-backup-{}", paths::timestamp()));
        fs::rename(&tool_dir, &backup)
            .map_err(|e| format!("Error preparando reemplazo de {binary_id}: {e}"))?;
        if let Err(activation_err) = fs::rename(&stage_dir, &tool_dir) {
            let _ = fs::rename(&backup, &tool_dir);
            return Err(format!("Error activando {binary_id}: {activation_err}"));
        }
        let _ = fs::remove_dir_all(&backup);
    } else {
        fs::rename(&stage_dir, &tool_dir)
            .map_err(|e| format!("Error activando {binary_id}: {e}"))?;
    }

    emit_dependency_progress(
        app, binary_id, "done", Some(100.0),
        &format!("{binary_id} instalado correctamente."),
    );
    Ok(())
}

/// Instala una lista de binarios de perfil de forma secuencial.
/// Devuelve el vector de IDs instalados con éxito; si alguno falla, incluye
/// todos los errores en el mensaje pero continúa con los demás.
pub fn install_profile_binaries(app: &AppHandle, binary_ids: &[String]) -> Result<Vec<String>, String> {
    let mut installed = Vec::new();
    let mut errors = Vec::new();

    for id in binary_ids {
        match install_profile_binary(app, id) {
            Ok(()) => installed.push(id.clone()),
            Err(e) => errors.push(format!("{id}: {e}")),
        }
    }

    if errors.is_empty() {
        Ok(installed)
    } else {
        Err(errors.join("; "))
    }
}

pub fn extract_profile_binary_archive(
    archive_path: &std::path::Path,
    dest_dir: &std::path::Path,
    archive_type: &str,
    bin_subdir: Option<&str>,
) -> Result<(), String> {
    match archive_type {
        #[cfg(target_os = "windows")]
        "zip" => extract_profile_binary_zip(archive_path, dest_dir, bin_subdir),
        #[cfg(not(target_os = "windows"))]
        "tar.gz" => extract_profile_binary_tar_gz(archive_path, dest_dir, bin_subdir),
        other => Err(format!(
            "Tipo de archivo de binario de perfil no soportado en esta plataforma: {other}"
        )),
    }
}

#[cfg(target_os = "windows")]
pub fn extract_profile_binary_zip(
    zip_path: &std::path::Path,
    dest_dir: &std::path::Path,
    bin_subdir: Option<&str>,
) -> Result<(), String> {
    use zip::ZipArchive;
    let file = fs::File::open(zip_path).map_err(|e| format!("Error abriendo ZIP: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Error leyendo ZIP: {e}"))?;

    // Detectar el directorio raíz del ZIP (si existe uno único)
    let mut top_dir: Option<String> = None;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("Error leyendo entrada ZIP: {e}"))?;
        if let Some(enclosed) = entry.enclosed_name() {
            if let Some(first) = enclosed.components().next() {
                let first_str = first.as_os_str().to_string_lossy().to_string();
                if !first_str.is_empty() && top_dir.is_none() {
                    top_dir = Some(first_str);
                }
            }
        }
    }

    let bin_dir = dest_dir.join("bin");
    fs::create_dir_all(&bin_dir).map_err(|e| format!("Error creando bin/: {e}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Error leyendo entrada ZIP: {e}"))?;
        let enclosed = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };

        // Eliminar el directorio raíz del ZIP si existe
        let stripped = if let Some(ref top) = top_dir {
            match enclosed.strip_prefix(top) {
                Ok(p) => p.to_path_buf(),
                Err(_) => continue,
            }
        } else {
            enclosed.clone()
        };
        if stripped.as_os_str().is_empty() {
            continue;
        }

        // Si se especifica bin_subdir, solo extraer archivos dentro de él
        // y aplanarlos directamente en dest_dir/bin/
        let target = if let Some(subdir) = bin_subdir {
            match stripped.strip_prefix(subdir) {
                Ok(relative) if !relative.as_os_str().is_empty() => bin_dir.join(relative),
                _ => continue,
            }
        } else {
            dest_dir.join(&stripped)
        };

        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| format!("Error creando directorio: {e}"))?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Error creando directorio padre: {e}"))?;
            }
            let mut out = fs::File::create(&target)
                .map_err(|e| format!("Error creando archivo: {e}"))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| format!("Error extrayendo archivo: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn extract_profile_binary_tar_gz(
    tar_path: &std::path::Path,
    dest_dir: &std::path::Path,
    bin_subdir: Option<&str>,
) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use std::path::Component;
    use tar::Archive;

    let file = fs::File::open(tar_path)
        .map_err(|e| format!("Error abriendo tar.gz de binario: {e}"))?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);

    let bin_dir = dest_dir.join("bin");
    fs::create_dir_all(&bin_dir).map_err(|e| format!("Error creando bin/: {e}"))?;

    let entries = archive
        .entries()
        .map_err(|e| format!("Error leyendo tar.gz: {e}"))?;

    for entry_result in entries {
        let mut entry = entry_result.map_err(|e| format!("Error en entrada tar.gz: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("Error leyendo ruta de entrada: {e}"))?
            .into_owned();

        if path.is_absolute()
            || path.components().any(|c| c == Component::ParentDir)
        {
            return Err(format!("Ruta insegura rechazada en tar.gz: {}", path.display()));
        }

        // Eliminar el directorio raíz si la primera componente no es "bin" o el subdir buscado
        let stripped = {
            let mut components = path.components();
            let first = components.next();
            match first {
                Some(Component::Normal(c)) => {
                    let c_str = c.to_string_lossy();
                    let is_root = bin_subdir.map_or(true, |sub| c_str != sub)
                        && c_str != "bin";
                    if is_root {
                        components.as_path().to_path_buf()
                    } else {
                        path.clone()
                    }
                }
                _ => path.clone(),
            }
        };

        let target = if let Some(subdir) = bin_subdir {
            match stripped.strip_prefix(subdir) {
                Ok(relative) if !relative.as_os_str().is_empty() => bin_dir.join(relative),
                _ => continue,
            }
        } else {
            dest_dir.join(&stripped)
        };

        if entry
            .header()
            .entry_type()
            .is_dir()
        {
            fs::create_dir_all(&target).map_err(|e| format!("Error creando dir: {e}"))?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Error creando dir padre: {e}"))?;
            }
            entry
                .unpack(&target)
                .map_err(|e| format!("Error extrayendo archivo: {e}"))?;
        }
    }
    Ok(())
}
