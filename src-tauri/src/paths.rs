use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const APP_DIR_NAME: &str = "Jintia";
const APP_DIR_LEGACY: &str = "InstructionalDesignerManager";

pub fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "No se pudo resolver la carpeta personal del usuario.".to_string())
}

pub fn app_config_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = home_dir()
        .ok()
        .map(|p| p.join("Library").join("Application Support"));
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().ok().map(|p| p.join(".config")));

    base.map(|path| path.join(APP_DIR_NAME))
        .ok_or_else(|| {
            "No se pudo resolver la carpeta de configuración de la aplicación.".to_string()
        })
}

pub fn migrate_app_dir_if_needed() {
    #[cfg(target_os = "windows")]
    {
        let appdata = match std::env::var_os("APPDATA") {
            Some(val) => PathBuf::from(val),
            None => return,
        };
        let legacy_path = appdata.join(APP_DIR_LEGACY);
        let new_path = appdata.join(APP_DIR_NAME);

        if legacy_path.exists() && !new_path.exists() {
            let _ = fs::rename(&legacy_path, &new_path);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let base = match home_dir() {
            Ok(p) => p.join("Library").join("Application Support"),
            Err(_) => return,
        };
        let legacy_path = base.join(APP_DIR_LEGACY);
        let new_path = base.join(APP_DIR_NAME);

        if legacy_path.exists() && !new_path.exists() {
            let _ = fs::rename(&legacy_path, &new_path);
        }
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let base = match std::env::var_os("XDG_CONFIG_HOME") {
            Some(path) => PathBuf::from(path),
            None => match home_dir() {
                Ok(p) => p.join(".config"),
                Err(_) => return,
            },
        };
        let legacy_path = base.join(APP_DIR_LEGACY);
        let new_path = base.join(APP_DIR_NAME);

        if legacy_path.exists() && !new_path.exists() {
            let _ = fs::rename(&legacy_path, &new_path);
        }
    }
}

pub fn skill_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?
        .join(".claude")
        .join("skills")
        .join("jintia-skill"))
}

pub fn openai_plugin_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".codex").join("plugins").join("jintia"))
}

pub fn openai_marketplace_path() -> Result<PathBuf, String> {
    Ok(home_dir()?
        .join(".agents")
        .join("plugins")
        .join("marketplace.json"))
}

pub fn legacy_skill_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?
        .join(".claude")
        .join("skills")
        .join("instructional-designer-skill"))
}

pub fn installed_skill_dir() -> Result<PathBuf, String> {
    let canonical = skill_dir()?;
    if canonical.join("SKILL.md").is_file() {
        return Ok(canonical);
    }
    let legacy = legacy_skill_dir()?;
    if legacy.join("SKILL.md").is_file() {
        return Ok(legacy);
    }
    Ok(canonical)
}

pub fn claude_desktop_config_path() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "No se pudo resolver APPDATA.".to_string())?;
        Ok(base.join("Claude").join("claude_desktop_config.json"))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(home_dir()?
            .join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude_desktop_config.json"))
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Ok(home_dir()?
            .join(".config")
            .join("Claude")
            .join("claude_desktop_config.json"))
    }
}

pub fn claude_code_config_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".claude.json"))
}

pub fn codex_config_path() -> Result<PathBuf, String> {
    let base = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or(home_dir()?.join(".codex"));
    Ok(base.join("config.toml"))
}

pub fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "La ruta no tiene carpeta padre.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("No se pudo crear {}: {error}", parent.display()))?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Nombre de archivo inválido.".to_string())?;
    let temp = parent.join(format!(".{file_name}.tmp-{}", timestamp()));

    let result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&temp)
            .map_err(|error| format!("No se pudo crear {}: {error}", temp.display()))?;
        file.write_all(bytes)
            .map_err(|error| format!("No se pudo escribir {}: {error}", temp.display()))?;
        file.sync_all()
            .map_err(|error| format!("No se pudo sincronizar {}: {error}", temp.display()))?;

        let swap = parent.join(format!(".{file_name}.swap-{}", timestamp()));
        if path.exists() {
            fs::rename(path, &swap).map_err(|error| {
                format!(
                    "No se pudo preparar el reemplazo de {}: {error}",
                    path.display()
                )
            })?;
        }
        match fs::rename(&temp, path) {
            Ok(_) => {
                if swap.exists() {
                    let _ = fs::remove_file(&swap);
                }
                Ok(())
            }
            Err(error) => {
                if swap.exists() {
                    let _ = fs::rename(&swap, path);
                }
                Err(format!("No se pudo activar {}: {error}", path.display()))
            }
        }
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Escribe únicamente cuando el contenido cambia. Devuelve `true` si hubo
/// una modificación real.
pub fn atomic_write_if_changed(path: &Path, bytes: &[u8]) -> Result<bool, String> {
    if fs::read(path).ok().as_deref() == Some(bytes) {
        return Ok(false);
    }
    atomic_write(path, bytes)?;
    Ok(true)
}

pub fn backup_file(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Nombre de archivo inválido.".to_string())?;
    let backup = path.with_file_name(format!("{name}.bak-{}", timestamp()));
    fs::copy(path, &backup)
        .map_err(|error| format!("No se pudo crear el respaldo {}: {error}", backup.display()))?;
    Ok(Some(backup))
}

pub fn canonical_directory(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() {
        return Err("Selecciona una ruta absoluta.".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("No se pudo acceder a {}: {error}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("{} no es una carpeta.", canonical.display()));
    }
    Ok(canonical)
}

pub fn safe_segment(value: &str, field: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} es obligatorio."));
    }
    if trimmed == "." || trimmed == ".." || trimmed.contains("..") {
        return Err(format!(
            "{field} contiene una secuencia de ruta no permitida."
        ));
    }
    if trimmed.chars().any(|ch| {
        ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err(format!("{field} contiene caracteres no permitidos."));
    }
    Ok(trimmed.to_string())
}

pub fn path_text(path: &Path) -> String {
    let text = path.to_string_lossy();
    // En Windows, canonicalize() antepone el prefijo de ruta extendida
    // \\?\, que no es válido dentro de una URL file:// ni útil para mostrar.
    let stripped = text.strip_prefix(r"\\?\").unwrap_or(&text);
    stripped.replace('\\', "/")
}

pub fn portable_runtimes_base_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or("LOCALAPPDATA not set")?;
        return Ok(base.join(APP_DIR_NAME));
    }

    #[cfg(not(target_os = "windows"))]
    {
        app_config_dir()
    }
}

pub fn portable_runtimes_dir() -> PathBuf {
    portable_runtimes_base_dir()
        .unwrap_or_else(|_| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
        })
        .join("runtimes")
}

pub fn portable_node_exe() -> PathBuf {
    let node_dir = portable_runtimes_dir().join("node");
    if cfg!(target_os = "windows") {
        node_dir.join("node.exe")
    } else {
        node_dir.join("bin").join("node")
    }
}

pub fn portable_node_prefix() -> PathBuf {
    portable_runtimes_dir().join("node")
}

pub fn portable_node_bin_dir() -> PathBuf {
    let prefix = portable_node_prefix();
    if cfg!(target_os = "windows") {
        prefix
    } else {
        prefix.join("bin")
    }
}

pub fn portable_vivliostyle_bin() -> PathBuf {
    portable_node_bin_dir().join(if cfg!(target_os = "windows") {
        "vivliostyle.cmd"
    } else {
        "vivliostyle"
    })
}

pub fn portable_python_exe() -> PathBuf {
    let root = portable_runtimes_dir().join("python");
    if cfg!(target_os = "windows") {
        root.join("python.exe")
    } else {
        root.join("bin").join("python3")
    }
}

pub fn portable_python_prefix() -> PathBuf {
    portable_runtimes_dir().join("python")
}

pub fn portable_skill_prefix() -> PathBuf {
    portable_runtimes_dir().join("jintia")
}

pub fn portable_skill_npm_package_dir_for(prefix: &std::path::Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        prefix
            .join("node_modules")
            .join("@charlie.act7")
            .join("jintia")
    } else {
        prefix
            .join("lib")
            .join("node_modules")
            .join("@charlie.act7")
            .join("jintia")
    }
}

pub fn portable_skill_npm_package_dir() -> PathBuf {
    portable_skill_npm_package_dir_for(&portable_skill_prefix())
}

pub fn portable_skill_npm_source_dir() -> PathBuf {
    portable_skill_npm_package_dir().join("skill")
}

pub fn portable_skill_source_dir() -> PathBuf {
    portable_skill_npm_source_dir()
}

pub fn portable_npm_cli() -> PathBuf {
    let prefix = portable_node_prefix();
    if cfg!(target_os = "windows") {
        prefix.join("node_modules").join("npm").join("bin").join("npm-cli.js")
    } else {
        prefix.join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js")
    }
}

pub fn portable_notebooklm_mcp_prefix() -> PathBuf {
    portable_runtimes_dir().join("notebooklm-mcp")
}

pub fn portable_notebooklm_mcp_lock() -> PathBuf {
    portable_notebooklm_mcp_prefix().join("package-lock.json")
}

pub fn portable_skill_bin() -> PathBuf {
    portable_skill_source_dir().join("bin").join("jintia.js")
}

pub fn migrate_runtimes_dir_if_needed() {
    #[cfg(target_os = "windows")]
    {
        let appdata = match std::env::var_os("APPDATA") {
            Some(val) => PathBuf::from(val),
            None => return,
        };
        let legacy_runtimes = appdata.join(APP_DIR_NAME).join("runtimes");
        let new_runtimes = match portable_runtimes_base_dir() {
            Ok(base) => base.join("runtimes"),
            Err(_) => return,
        };

        if legacy_runtimes.exists() && !new_runtimes.exists() {
            let _ = fs::rename(&legacy_runtimes, &new_runtimes);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unchanged_atomic_write_is_skipped() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("jintia-atomic-{unique}-{}.txt", std::process::id()));
        assert!(atomic_write_if_changed(&path, b"same").expect("first write"));
        assert!(!atomic_write_if_changed(&path, b"same").expect("unchanged write"));
        assert!(atomic_write_if_changed(&path, b"changed").expect("changed write"));
        let _ = fs::remove_file(path);
    }
}
