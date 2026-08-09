use crate::models::ActionResult;
use crate::paths::{
    app_config_dir, atomic_write, atomic_write_if_changed, canonical_directory,
    installed_skill_dir, legacy_skill_dir, openai_marketplace_path, openai_plugin_dir, path_text,
    skill_dir, timestamp,
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

fn files_match(source: &Path, target: &Path) -> bool {
    fs::read(source).ok() == fs::read(target).ok()
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

fn materialize_openai_plugin_from_portable(
    target: &Path,
    wrapper_src: &Path,
    skill_src: &Path,
    installed: Option<&Path>,
) -> Result<(), String> {
    copy_dir_all(wrapper_src, target)?;
    copy_dir_all(skill_src, &target.join("skills").join("jintia-skill"))?;
    for name in ["institution.json", "notebooks.json"] {
        if let Some(bytes) = user_config(name, installed) {
            atomic_write(
                &target.join("skills").join("jintia-skill").join("config").join(name),
                &bytes,
            )?;
        }
    }
    Ok(())
}

fn openai_plugin_portable_matches(target: &Path) -> bool {
    let Some((wrapper_src, skill_src, managed_version)) = portable_openai_plugin_sources() else {
        return false;
    };
    let installed_skill = target.join("skills").join("jintia-skill");
    files_match(
        &wrapper_src.join(".codex-plugin").join("plugin.json"),
        &target.join(".codex-plugin").join("plugin.json"),
    ) && files_match(&wrapper_src.join(".mcp.json"), &target.join(".mcp.json"))
        && files_match(&wrapper_src.join("README.md"), &target.join("README.md"))
        && installed_skill.join("SKILL.md").is_file()
        && read_skill_package_version(&installed_skill).as_deref() == Some(&managed_version)
        && read_skill_package_version(&skill_src).as_deref() == Some(&managed_version)
}

fn register_openai_marketplace() -> Result<(), String> {
    let path = openai_marketplace_path()?;
    let mut root = if path.exists() {
        let bytes = fs::read(&path)
            .map_err(|error| format!("No se pudo leer {}: {error}", path.display()))?;
        serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|error| format!("El marketplace existente no es JSON válido: {error}"))?
    } else {
        serde_json::json!({
            "name": "jintia-local",
            "interface": { "displayName": "Jintia local" },
            "plugins": []
        })
    };
    if !root.is_object() {
        return Err("El marketplace personal no contiene un objeto JSON.".to_string());
    }
    if root.get("plugins").is_none() {
        root["plugins"] = serde_json::json!([]);
    }
    let plugins = root["plugins"]
        .as_array_mut()
        .ok_or_else(|| "La clave plugins del marketplace no es una lista.".to_string())?;
    plugins.retain(|entry| entry.get("name").and_then(|value| value.as_str()) != Some("jintia"));
    plugins.push(serde_json::json!({
        "name": "jintia",
        "source": {
            "source": "local",
            "path": "./.codex/plugins/jintia"
        },
        "policy": {
            "installation": "AVAILABLE",
            "authentication": "ON_INSTALL"
        },
        "category": "Education"
    }));
    let bytes = serde_json::to_vec_pretty(&root)
        .map_err(|error| format!("No se pudo serializar el marketplace: {error}"))?;
    atomic_write_if_changed(&path, &bytes)?;
    Ok(())
}

pub fn install_openai_plugin() -> ActionResult {
    let _operation = match PAYLOAD_OPERATION.lock() {
        Ok(operation) => operation,
        Err(_) => return ActionResult::error("El estado interno de instalación está bloqueado."),
    };
    let (wrapper_src, skill_src, managed_version) = match portable_openai_plugin_sources() {
        Some(sources) => sources,
        None => {
            return ActionResult::error(
                "El runtime Jintia administrado no incluye el plugin para ChatGPT/Codex. Actualiza Jintia desde Configuración > Entorno.",
            );
        }
    };
    let target = match openai_plugin_dir() {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    if target.exists() && openai_plugin_portable_matches(&target) {
        return match register_openai_marketplace() {
            Ok(_) => ActionResult::ok(format!(
                "Jintia ya está actualizado para ChatGPT y Codex.\n{}",
                path_text(&target)
            ))
            .with_path(path_text(&target)),
            Err(error) => ActionResult::error(error),
        };
    }
    let Some(parent) = target.parent() else {
        return ActionResult::error("Ruta del plugin inválida.");
    };
    if let Err(error) = fs::create_dir_all(parent) {
        return ActionResult::error(format!("No se pudo crear {}: {error}", parent.display()));
    }
    let stage = parent.join(format!(".jintia-plugin.stage-{}", timestamp()));
    let installed = target
        .join("skills")
        .join("jintia-skill")
        .is_dir()
        .then(|| target.join("skills").join("jintia-skill"));
    if let Err(error) = materialize_openai_plugin_from_portable(
        &stage,
        &wrapper_src,
        &skill_src,
        installed.as_deref(),
    ) {
        let _ = fs::remove_dir_all(&stage);
        return ActionResult::error(error);
    }
    let backup = parent.join(format!("jintia.backup-{}", timestamp()));
    if target.exists() {
        if let Err(error) = fs::rename(&target, &backup) {
            let _ = fs::remove_dir_all(&stage);
            return ActionResult::error(format!("No se pudo respaldar el plugin actual: {error}"));
        }
    }
    if let Err(error) = fs::rename(&stage, &target) {
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        let _ = fs::remove_dir_all(&stage);
        return ActionResult::error(format!("No se pudo activar el plugin: {error}"));
    }
    if let Err(error) = register_openai_marketplace() {
        return ActionResult::error(format!(
            "El plugin se copió, pero no pudo registrarse en ChatGPT/Codex: {error}"
        ));
    }
    let result = ActionResult::ok(format!(
        "Jintia {managed_version} quedó preparado para ChatGPT desktop y Codex.\nReinicia el cliente que usarás y activa Jintia desde Plugins.\n{}",
        path_text(&target)
    ))
    .with_path(path_text(&target));
    if backup.exists() {
        result.with_backup(path_text(&backup))
    } else {
        result
    }
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("Error creando {}: {e}", dst.display()))?;
    for entry in fs::read_dir(src)
        .map_err(|e| format!("Error leyendo {}: {e}", src.display()))?
    {
        let entry = entry.map_err(|e| format!("Error en entrada de directorio: {e}"))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Error copiando {}: {e}", src_path.display()))?;
        }
    }
    Ok(())
}

fn portable_skill_src() -> Option<PathBuf> {
    let src = crate::paths::portable_skill_source_dir();
    src.join("bin").join("jintia.js").is_file().then_some(src)
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

fn installed_portable_matches(target: &Path) -> bool {
    let Some(src) = portable_skill_src() else {
        return false;
    };
    let src_ver = read_skill_package_version(&src);
    src_ver.is_some() && src_ver == read_skill_package_version(target)
}

pub fn install_local_skill() -> ActionResult {
    let _operation = match PAYLOAD_OPERATION.lock() {
        Ok(operation) => operation,
        Err(_) => return ActionResult::error("El estado interno de instalación está bloqueado."),
    };
    let portable_src = match portable_skill_src() {
        Some(path) => path,
        None => {
            return ActionResult::error(
                "Jintia administrado no está instalado. Instálalo primero desde Configuración > Entorno.",
            );
        }
    };
    let target = match skill_dir() {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    let parent = match target.parent() {
        Some(path) => path.to_path_buf(),
        None => return ActionResult::error("Ruta de instalación inválida."),
    };
    if let Err(error) = fs::create_dir_all(&parent) {
        return ActionResult::error(format!("No se pudo crear {}: {error}", parent.display()));
    }
    if target.exists() && installed_portable_matches(&target) {
        return ActionResult::ok(format!(
            "La skill ya estaba instalada y actualizada; no se creó otra copia ni respaldo.\n{}",
            path_text(&target)
        ))
        .with_path(path_text(&target));
    }

    let legacy = legacy_skill_dir().ok().filter(|path| path.exists());
    let migrating_legacy = !target.exists() && legacy.is_some();
    let stage = parent.join(format!(".jintia-skill.stage-{}", timestamp()));
    if let Err(error) = copy_dir_all(&portable_src, &stage) {
        let _ = fs::remove_dir_all(&stage);
        return ActionResult::error(error);
    }
    let backup = parent.join(format!("jintia-skill.backup-{}", timestamp()));
    if target.exists() {
        if let Err(error) = fs::rename(&target, &backup) {
            let _ = fs::remove_dir_all(&stage);
            return ActionResult::error(format!(
                "No se pudo respaldar la instalación actual en {}: {error}",
                backup.display()
            ));
        }
    }

    match fs::rename(&stage, &target) {
        Ok(_) => {
            let legacy_backup = if migrating_legacy {
                legacy.as_ref().and_then(|previous| {
                    let archived = parent.join(format!(
                        "instructional-designer-skill.backup-{}",
                        timestamp()
                    ));
                    fs::rename(previous, &archived).ok().map(|_| archived)
                })
            } else {
                None
            };
            let result = ActionResult::ok(if let Some(archived) = legacy_backup.as_ref() {
                format!(
                    "Jintia Skill se instaló en:\n{}\n\nLa instalación anterior quedó archivada en:\n{}",
                    path_text(&target),
                    path_text(archived)
                )
            } else if migrating_legacy {
                format!(
                    "Jintia Skill se instaló en:\n{}\n\nNo se pudo archivar la carpeta anterior; puedes retirarla manualmente después de verificar Jintia.",
                    path_text(&target)
                )
            } else {
                format!("Jintia Skill se instaló para Claude Code en:\n{}", path_text(&target))
            })
            .with_path(path_text(&target));
            if backup.exists() {
                result.with_backup(path_text(&backup))
            } else if let Some(archived) = legacy_backup {
                result.with_backup(path_text(&archived))
            } else {
                result
            }
        }
        Err(error) => {
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            let _ = fs::remove_dir_all(&stage);
            ActionResult::error(format!("No se pudo activar la nueva instalación: {error}"))
        }
    }
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
    installed_portable_matches(&path)
}

pub fn openai_plugin_is_installed() -> bool {
    openai_plugin_dir()
        .ok()
        .is_some_and(|path| path.join(".codex-plugin").join("plugin.json").is_file())
}

pub fn openai_plugin_is_current() -> bool {
    openai_plugin_dir()
        .ok()
        .is_some_and(|path| openai_plugin_portable_matches(&path))
}

pub fn openai_plugin_path() -> String {
    openai_plugin_dir()
        .map(|path| path_text(&path))
        .unwrap_or_default()
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
