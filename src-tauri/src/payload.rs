use crate::models::ActionResult;
use crate::paths::{
    app_config_dir, atomic_write, atomic_write_if_changed, canonical_directory,
    installed_skill_dir, openai_plugin_dir, path_text,
    timestamp,
};
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use zip::write::SimpleFileOptions;

static PAYLOAD_OPERATION: Mutex<()> = Mutex::new(());

fn read_valid_json(path: &Path) -> Option<Vec<u8>> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes).ok()?;
    Some(bytes)
}

fn user_config(name: &str, installed: Option<&Path>) -> Option<Vec<u8>> {
    let manager_path = app_config_dir().ok()?.join(name);
    read_valid_json(&manager_path)
        .or_else(|| installed.and_then(|root| read_valid_json(&root.join("config").join(name))))
}

fn portable_openai_plugin_sources() -> Option<(PathBuf, PathBuf, String)> {
    let package_root = crate::paths::portable_skill_npm_package_dir();
    let wrapper_src = package_root.join("openai-plugin");
    let skill_src = package_root.join("skill");
    let plugin_manifest = wrapper_src.join(".codex-plugin").join("plugin.json");
    let required = [
        package_root.join("package.json"),
        skill_src.join("package.json"),
        skill_src.join("SKILL.md"),
        skill_src.join("bin").join("jintia.js"),
        plugin_manifest.clone(),
        wrapper_src.join(".mcp.json"),
        wrapper_src.join("README.md"),
    ];
    if required.iter().any(|path| !path.is_file()) {
        return None;
    }
    let package_version = read_skill_package_version(&package_root)?;
    let skill_version = read_skill_package_version(&skill_src)?;
    let plugin_version = fs::read_to_string(plugin_manifest)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("version")?.as_str().map(str::to_string))?;
    (package_version == skill_version && skill_version == plugin_version)
        .then_some((wrapper_src, skill_src, skill_version))
}

fn read_skill_package_version(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| {
            value
                .get("version")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        })
}

fn add_bytes(zip: &mut zip::ZipWriter<fs::File>, path: &str, bytes: &[u8]) -> Result<(), String> {
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    zip.start_file(path.replace('\\', "/"), options)
        .map_err(|error| format!("No se pudo agregar {path} al ZIP: {error}"))?;
    zip.write_all(bytes)
        .map_err(|error| format!("No se pudo escribir {path} en el ZIP: {error}"))
}

fn add_fs_dir_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    source: &Path,
    prefix: &str,
) -> Result<(), String> {
    let mut entries = fs::read_dir(source)
        .map_err(|error| format!("No se pudo leer {}: {error}", source.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("No se pudo leer una entrada de {}: {error}", source.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| format!("No se pudo inspeccionar {}: {error}", entry.path().display()))?;
        if file_type.is_symlink() {
            return Err(format!("No se permiten enlaces simbólicos en {}", entry.path().display()));
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let zip_path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if file_type.is_dir() {
            add_fs_dir_to_zip(zip, &path, &zip_path)?;
        } else if file_type.is_file() {
            let bytes = fs::read(&path)
                .map_err(|error| format!("No se pudo leer {}: {error}", path.display()))?;
            add_bytes(zip, &zip_path, &bytes)?;
        } else {
            return Err(format!("Entrada no compatible en {}", path.display()));
        }
    }
    Ok(())
}

fn portable_skill_export_source() -> Option<(PathBuf, String)> {
    let package_root = crate::paths::portable_skill_npm_package_dir();
    let skill_src = package_root.join("skill");
    if !package_root.join("package.json").is_file()
        || !skill_src.join("package.json").is_file()
        || !skill_src.join("SKILL.md").is_file()
        || !skill_src.join("bin").join("jintia.js").is_file()
    {
        return None;
    }
    let package_version = read_skill_package_version(&package_root)?;
    let skill_version = read_skill_package_version(&skill_src)?;
    (package_version == skill_version).then_some((skill_src, skill_version))
}

fn file_fingerprint(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("No se pudo leer {}: {error}", path.display()))?;
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

fn files_equal(left: &Path, right: &Path) -> bool {
    let same_len = fs::metadata(left)
        .ok()
        .zip(fs::metadata(right).ok())
        .is_some_and(|(left_meta, right_meta)| left_meta.len() == right_meta.len());
    same_len
        && fs::read(left)
            .ok()
            .zip(fs::read(right).ok())
            .is_some_and(|(left_bytes, right_bytes)| left_bytes == right_bytes)
}

pub fn export_skill_zip(destination_dir: String) -> ActionResult {
    let _operation = match PAYLOAD_OPERATION.lock() {
        Ok(operation) => operation,
        Err(_) => return ActionResult::error("El estado interno de exportación está bloqueado."),
    };
    let (skill_src, managed_version) = match portable_skill_export_source() {
        Some(source) => source,
        None => {
            return ActionResult::error(
                "El runtime Jintia administrado no contiene una Skill válida. Actualiza Jintia desde Configuración > Entorno.",
            );
        }
    };
    let destination = match canonical_directory(&destination_dir) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    let final_path = destination.join(format!("jintia-skill-{managed_version}.zip"));
    let installed = installed_skill_dir().ok();
    let temp_path = destination.join(format!(".jintia-skill-{}.tmp", timestamp()));
    let file = match fs::File::create(&temp_path) {
        Ok(file) => file,
        Err(error) => return ActionResult::error(format!("No se pudo crear el ZIP: {error}")),
    };

    let result = (|| -> Result<bool, String> {
        let mut zip = zip::ZipWriter::new(file);
        add_fs_dir_to_zip(&mut zip, &skill_src, "")?;

        for name in ["institution.json", "notebooks.json"] {
            if let Some(bytes) = user_config(name, installed.as_deref()) {
                add_bytes(&mut zip, &format!("config/{name}"), &bytes)?;
            }
        }
        zip.finish()
            .map_err(|error| format!("No se pudo finalizar el ZIP: {error}"))?;

        if final_path.exists() && files_equal(&temp_path, &final_path) {
            fs::remove_file(&temp_path)
                .map_err(|error| format!("No se pudo retirar el ZIP temporal: {error}"))?;
            return Ok(false);
        }
        if final_path.exists() {
            fs::remove_file(&final_path).map_err(|error| {
                format!("No se pudo reemplazar {}: {error}", final_path.display())
            })?;
        }
        fs::rename(&temp_path, &final_path)
            .map_err(|error| format!("No se pudo guardar {}: {error}", final_path.display()))?;
        Ok(true)
    })();

    match result {
        Ok(changed) => {
            let fingerprint = match file_fingerprint(&final_path) {
                Ok(fingerprint) => fingerprint,
                Err(error) => return ActionResult::error(error),
            };
            if !changed {
                if last_export_path().as_deref() != Some(path_text(&final_path).as_str()) {
                    if let Err(error) = record_export(&final_path, &fingerprint) {
                        return ActionResult::error(format!(
                            "El ZIP ya era válido, pero no se pudo registrar su ubicación: {error}"
                        ));
                    }
                }
                return ActionResult::ok(format!(
                    "El ZIP existente ya contiene la versión actual de la skill; no se volvió a crear.\n{}",
                    path_text(&final_path)
                ))
                .with_path(path_text(&final_path));
            }
            if let Err(error) = record_export(&final_path, &fingerprint) {
                return ActionResult::error(format!(
                    "El ZIP se creó en {}, pero no se pudo registrar el progreso: {error}",
                    path_text(&final_path)
                ));
            }
            ActionResult::ok(format!(
                "ZIP listo para subir en Claude > Customize > Skills:\n{}",
                path_text(&final_path)
            ))
            .with_path(path_text(&final_path))
        }
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            ActionResult::error(error)
        }
    }
}

pub fn export_openai_plugin_zip(destination_dir: String) -> ActionResult {
    let _operation = match PAYLOAD_OPERATION.lock() {
        Ok(operation) => operation,
        Err(_) => return ActionResult::error("El estado interno de exportación está bloqueado."),
    };
    let (wrapper_src, skill_src, managed_version) = match portable_openai_plugin_sources() {
        Some(sources) => sources,
        None => {
            return ActionResult::error(
                "El runtime Jintia administrado no incluye el plugin para ChatGPT/Codex. Actualiza Jintia desde Configuración > Entorno.",
            );
        }
    };
    let destination = match canonical_directory(&destination_dir) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    let final_path = destination.join(format!("jintia-openai-plugin-{managed_version}.zip"));
    let temp_path = destination.join(format!(".jintia-openai-{}.tmp", timestamp()));
    let file = match fs::File::create(&temp_path) {
        Ok(file) => file,
        Err(error) => return ActionResult::error(format!("No se pudo crear el ZIP: {error}")),
    };
    let installed = installed_skill_dir().ok();
    let result = (|| -> Result<bool, String> {
        let mut zip = zip::ZipWriter::new(file);
        add_fs_dir_to_zip(&mut zip, &wrapper_src, "")?;
        let prefix = "skills/jintia-skill";
        add_fs_dir_to_zip(&mut zip, &skill_src, prefix)?;
        for name in ["institution.json", "notebooks.json"] {
            if let Some(bytes) = user_config(name, installed.as_deref()) {
                add_bytes(&mut zip, &format!("{prefix}/config/{name}"), &bytes)?;
            }
        }
        zip.finish()
            .map_err(|error| format!("No se pudo finalizar el ZIP: {error}"))?;
        if final_path.exists() && files_equal(&temp_path, &final_path) {
            fs::remove_file(&temp_path)
                .map_err(|error| format!("No se pudo retirar el ZIP temporal: {error}"))?;
            return Ok(false);
        }
        if final_path.exists() {
            fs::remove_file(&final_path)
                .map_err(|error| format!("No se pudo reemplazar el ZIP: {error}"))?;
        }
        fs::rename(&temp_path, &final_path)
            .map_err(|error| format!("No se pudo guardar el ZIP: {error}"))?;
        Ok(true)
    })();
    match result {
        Ok(changed) => ActionResult::ok(if changed {
            format!(
                "Plugin universal exportado para ChatGPT y Codex:\n{}",
                path_text(&final_path)
            )
        } else {
            format!(
                "El plugin universal ya estaba actualizado:\n{}",
                path_text(&final_path)
            )
        })
        .with_path(path_text(&final_path)),
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            ActionResult::error(error)
        }
    }
}

pub fn record_export(path: &Path, fingerprint: &str) -> Result<(), String> {
    let value = serde_json::json!({
        "schemaVersion": 1,
        "lastExportPath": path_text(path),
        "fingerprint": fingerprint,
        "exportedAt": timestamp()
    });
    let bytes = serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?;
    atomic_write(&app_config_dir()?.join("export.json"), &bytes)
}

pub fn last_export_path() -> Option<String> {
    let path = app_config_dir().ok()?.join("export.json");
    let value = serde_json::from_slice::<serde_json::Value>(&fs::read(path).ok()?).ok()?;
    let export = value.get("lastExportPath")?.as_str()?.to_string();
    Path::new(&export).is_file().then_some(export)
}

pub fn installed_skill_path() -> String {
    installed_skill_dir()
        .map(|path| path_text(&path))
        .unwrap_or_default()
}

pub fn skill_is_installed() -> bool {
    installed_skill_dir()
        .map(|path| path.join("SKILL.md").is_file())
        .unwrap_or(false)
}

pub fn installed_skill_version() -> String {
    let Ok(path) = installed_skill_dir() else {
        return String::new();
    };
    read_skill_package_version(&path)
        .or_else(|| {
            fs::read_to_string(path.join("VERSION"))
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
        .unwrap_or_default()
}

pub fn portable_skill_version() -> Option<String> {
    let pkg_path = crate::paths::portable_skill_source_dir().join("package.json");
    fs::read_to_string(&pkg_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["version"].as_str().map(|s| s.to_string()))
}

pub fn skill_is_current() -> bool {
    let Ok(path) = installed_skill_dir() else {
        return false;
    };
    if !path.join("SKILL.md").is_file() {
        return false;
    }
    let portable = crate::paths::portable_skill_source_dir();
    portable.join("bin").join("jintia.js").is_file()
        && read_skill_package_version(&portable)
            .is_some_and(|version| Some(version) == read_skill_package_version(&path))
}

pub fn sync_user_config_to_install(name: &str, bytes: &[u8]) -> Result<(), String> {
    let target = installed_skill_dir()?.join("config").join(name);
    if target.parent().is_some_and(Path::exists) {
        atomic_write_if_changed(&target, bytes)?;
    }
    let openai_target = openai_plugin_dir()?
        .join("skills")
        .join("jintia-skill")
        .join("config")
        .join(name);
    if openai_target.parent().is_some_and(Path::exists) {
        atomic_write_if_changed(&openai_target, bytes)?;
    }
    Ok(())
}

pub fn config_file_path(name: &str) -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join(name))
}
