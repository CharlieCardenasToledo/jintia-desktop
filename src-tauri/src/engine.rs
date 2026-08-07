use serde::de::DeserializeOwned;
use std::path::Path;
use std::process::Command;

/// Resultado de ejecutar un comando Jintia.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EngineResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Ejecuta un comando Jintia genérico y devuelve stdout/stderr sin parsear.
///
/// # Ejemplo
/// ```ignore
/// let result = run_jintia(Path::new("/path/to/skill"), &["doctor", "--json"])?;
/// println!("{}", result.stdout);
/// ```
pub fn run_jintia(skill_path: &Path, args: &[&str]) -> Result<EngineResult, String> {
    // skill_path puede ser:
    //   - La ruta directa a jintia.js (instalación portable via resolve_skill())
    //   - Un directorio que contiene bin/jintia.js (compatibilidad legacy)
    let entrypoint = if skill_path.is_file() {
        skill_path.to_path_buf()
    } else {
        skill_path.join("bin").join("jintia.js")
    };
    if !entrypoint.is_file() {
        return Err(format!(
            "La skill no está instalada en {}. Instálala antes de ejecutar la toolchain.",
            skill_path.display()
        ));
    }

    let mut cmd_args = vec![entrypoint.to_string_lossy().into_owned()];
    cmd_args.extend(args.iter().map(|s| s.to_string()));

    let node_bin = crate::runtimes::resolve_node()
        .ok_or_else(|| "Node.js no disponible. Descárgalo desde Configuración > Entorno.".to_string())?;

    // Asegurar que el directorio bin del Node portable esté en PATH
    // para que la Skill encuentre Vivliostyle y otros binarios npm globales.
    let base_path = std::env::var_os("PATH").unwrap_or_default();
    let node_bin_dir = crate::paths::portable_node_exe()
        .parent()
        .map(|p| p.to_path_buf());
    let patched_path = if let Some(dir) = node_bin_dir.filter(|d| d.exists()) {
        let mut dirs: Vec<std::path::PathBuf> = std::env::split_paths(&base_path).collect();
        if !dirs.contains(&dir) {
            dirs.insert(0, dir);
        }
        std::env::join_paths(dirs).unwrap_or(base_path)
    } else {
        base_path
    };

    match Command::new(&node_bin).args(&cmd_args).env("PATH", patched_path).output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            Ok(EngineResult {
                success: output.status.success(),
                exit_code: output.status.code(),
                stdout,
                stderr,
            })
        }
        Err(error) => Err(format!("No se pudo iniciar Node.js: {error}")),
    }
}

/// Ejecuta un comando Jintia y parsea el JSON de stdout.
///
/// Útil para comandos que devuelven `--json`. Si el parsing falla, devuelve error.
///
/// # Ejemplo
/// ```ignore
/// #[derive(serde::Deserialize)]
/// struct DoctorReport { success: bool, checks: Vec<String> }
///
/// let report: DoctorReport = run_jintia_json(
///     Path::new("/path/to/skill"),
///     &["doctor", "--json"]
/// )?;
/// ```
pub fn run_jintia_json<T: DeserializeOwned>(
    skill_path: &Path,
    args: &[&str],
) -> Result<T, String> {
    let result = run_jintia(skill_path, args)?;

    if !result.success {
        return Err(format!(
            "El comando falló con exit code {:?}. Stderr: {}",
            result.exit_code, result.stderr
        ));
    }

    serde_json::from_str::<T>(&result.stdout).map_err(|error| {
        format!(
            "No se pudo parsear la respuesta JSON: {}. Stdout: {}",
            error, result.stdout
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_result_serde() {
        let result = EngineResult {
            success: true,
            exit_code: Some(0),
            stdout: "test".to_string(),
            stderr: String::new(),
        };

        let json = serde_json::to_string(&result).unwrap();
        let deserialized: EngineResult = serde_json::from_str(&json).unwrap();

        assert!(deserialized.success);
        assert_eq!(deserialized.exit_code, Some(0));
        assert_eq!(deserialized.stdout, "test");
    }
}
