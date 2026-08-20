use serde::de::DeserializeOwned;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

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
/// let result = run_jintia(Path::new("/path/to/jintia.js"), &["doctor", "--json"])?;
/// println!("{}", result.stdout);
/// ```
fn managed_entrypoint(path: &Path) -> Result<PathBuf, String> {
    if path.is_file() {
        Ok(path.to_path_buf())
    } else {
        Err(format!(
            "El ejecutable Jintia administrado no está disponible en {}.",
            path.display()
        ))
    }
}

fn managed_runtime_path(python: Option<&Path>) -> Result<OsString, String> {
    let mut dirs = vec![crate::paths::portable_node_bin_dir()];
    // Añade los bin/ de herramientas instaladas (graphviz, plantuml, etc.)
    dirs.extend(crate::paths::managed_tool_bin_dirs());
    if let Some(python_exe) = python {
        if let Some(parent) = python_exe.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    // Los directorios administrados tienen prioridad; el PATH del sistema va al final
    // para que herramientas instaladas globalmente (ej. vivliostyle via npm --global)
    // sean accesibles desde dentro del runtime Node portátil.
    dirs.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
    std::env::join_paths(dirs)
        .map_err(|error| format!("No se pudo construir el PATH administrado: {error}"))
}

/// Ejecuta un script Node.js arbitrario con el runtime administrado por Jintia.
/// Idéntico a `run_jintia` pero sin anteponer el entrypoint de la skill —
/// útil para llamar a `guide-renderer.js`, `content-linter.js`, etc. directamente.
pub fn run_node_script(script: &Path, args: &[&str], cwd: Option<&Path>) -> Result<EngineResult, String> {
    let node_bin = crate::runtimes::resolve_node().ok_or_else(|| {
        "Node.js no disponible. Descárgalo desde Configuración > Entorno.".to_string()
    })?;

    let python = crate::runtimes::resolve_python().map(PathBuf::from);
    let managed_path = managed_runtime_path(python.as_deref())?;

    let mut cmd_args = vec![script.to_string_lossy().into_owned()];
    cmd_args.extend(args.iter().map(|s| s.to_string()));

    let mut cmd = crate::runtimes::managed_node_command(&node_bin);
    cmd.args(&cmd_args)
        .env("PATH", managed_path)
        // Jintia Harness 11.6.x consulta CODEX_HOME al sincronizar los agentes
        // globales. Declararlo evita que su fallback reciba un home indefinido.
        .env("CODEX_HOME", crate::paths::codex_home_dir()?);

    if let Some(vivliostyle_bin) = crate::runtimes::resolve_vivliostyle() {
        cmd.env("JINTIA_VIVLIOSTYLE_BIN", vivliostyle_bin);
    }
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }

    match cmd.output() {
        Ok(output) => Ok(EngineResult {
            success: output.status.success(),
            exit_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }),
        Err(error) => Err(format!("No se pudo iniciar Node.js: {error}")),
    }
}

pub fn run_jintia(skill_path: &Path, args: &[&str]) -> Result<EngineResult, String> {
    let entrypoint = managed_entrypoint(skill_path)?;

    let mut cmd_args = vec![entrypoint.to_string_lossy().into_owned()];
    cmd_args.extend(args.iter().map(|s| s.to_string()));

    let node_bin = crate::runtimes::resolve_node().ok_or_else(|| {
        "Node.js no disponible. Descárgalo desde Configuración > Entorno.".to_string()
    })?;

    let python = crate::runtimes::resolve_python().map(PathBuf::from);
    let managed_path = managed_runtime_path(python.as_deref())?;

    let mut cmd = crate::runtimes::managed_node_command(&node_bin);
    cmd.args(&cmd_args)
        .env("PATH", managed_path)
        .env("CODEX_HOME", crate::paths::codex_home_dir()?);

    // La skill no usa `where.exe` para encontrar herramientas administradas —
    // pasamos la ruta absoluta directamente para evitar dependencias de PATH.
    if let Some(vivliostyle_bin) = crate::runtimes::resolve_vivliostyle() {
        cmd.env("JINTIA_VIVLIOSTYLE_BIN", vivliostyle_bin);
    }

    match cmd.output()
    {
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
///     Path::new("/path/to/jintia.js"),
///     &["doctor", "--json"]
/// )?;
/// ```
pub fn run_jintia_json<T: DeserializeOwned>(skill_path: &Path, args: &[&str]) -> Result<T, String> {
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
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "jintia-engine-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn managed_entrypoint_accepts_exact_file() {
        let root = temp_path("file");
        fs::create_dir_all(&root).unwrap();
        let entrypoint = root.join("jintia.js");
        fs::write(&entrypoint, "#!/usr/bin/env node\n").unwrap();

        let result = managed_entrypoint(&entrypoint);

        let _ = fs::remove_dir_all(&root);
        assert_eq!(result.unwrap(), entrypoint);
    }

    #[test]
    fn managed_entrypoint_rejects_directory_even_with_bin_file() {
        let root = temp_path("directory");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("jintia.js"), "#!/usr/bin/env node\n").unwrap();

        let result = managed_entrypoint(&root);

        let _ = fs::remove_dir_all(&root);
        assert!(result.is_err());
    }

    #[test]
    fn managed_entrypoint_rejects_missing_path() {
        let missing = temp_path("missing");

        let result = managed_entrypoint(&missing);

        assert!(result.is_err());
    }

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

    #[test]
    fn managed_runtime_path_starts_with_node_and_includes_python() {
        let python = PathBuf::from("managed").join("python").join("python.exe");
        let joined = managed_runtime_path(Some(&python)).unwrap();
        let dirs: Vec<PathBuf> = std::env::split_paths(&joined).collect();

        // El primer directorio siempre es el bin de Node administrado.
        assert_eq!(dirs.first().unwrap(), &crate::paths::portable_node_bin_dir());
        // El directorio padre de Python debe estar presente en algún lugar.
        assert!(
            dirs.contains(&python.parent().unwrap().to_path_buf()),
            "El directorio padre de Python no está en el PATH administrado"
        );
    }

    #[test]
    fn managed_runtime_path_without_python_starts_with_node() {
        let joined = managed_runtime_path(None).unwrap();
        let dirs: Vec<PathBuf> = std::env::split_paths(&joined).collect();

        // El primer directorio siempre es el bin de Node administrado.
        assert_eq!(dirs.first().unwrap(), &crate::paths::portable_node_bin_dir());
    }
}
