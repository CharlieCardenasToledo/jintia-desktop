use crate::engine;
use crate::models::{ActionResult, ToolchainReport};
use serde_json::Value;
use std::path::Path;

fn claude_install_args() -> [&'static str; 6] {
    [
        "install",
        "--providers=claude",
        "--scope=global",
        "--yes",
        "--adopt-existing",
        "--json",
    ]
}

fn installed_target(report: &Value) -> Option<String> {
    report
        .get("results")?
        .as_array()?
        .first()?
        .get("target")?
        .as_str()
        .map(str::trim)
        .filter(|target| !target.is_empty())
        .map(str::to_owned)
}

pub fn install_global_claude_skill() -> ActionResult {
    let skill_path = match crate::runtimes::resolve_skill() {
        Some(path) => path,
        None => return ActionResult::error("Jintia administrado no está instalado. Actualízalo desde Configuración > Entorno."),
    };
    let help = match engine::run_jintia(Path::new(&skill_path), &["--help"]) {
        Ok(result) if result.success && result.stdout.contains("--adopt-existing") => result,
        Ok(_) => return ActionResult::error("El Jintia administrado instalado no admite adopción segura de instalaciones existentes. Actualízalo desde Configuración > Entorno."),
        Err(error) => return ActionResult::error(error),
    };
    let _ = help;

    let args = claude_install_args();
    match engine::run_jintia(Path::new(&skill_path), &args) {
        Ok(result) if !result.success => ActionResult::error(if result.stderr.trim().is_empty() { result.stdout } else { result.stderr }),
        Ok(result) => match serde_json::from_str::<Value>(&result.stdout).ok().and_then(|report| installed_target(&report)) {
            Some(target) => ActionResult::ok("Jintia Skill quedó instalada para Claude Code.").with_path(target),
            None => ActionResult::error("Jintia devolvió una instalación exitosa sin un target válido."),
        },
        Err(error) => ActionResult::error(error),
    }
}

pub fn run(operation: String, target: Option<String>, json: Option<bool>, strict: Option<bool>) -> ToolchainReport {
    let skill_path = match crate::runtimes::resolve_skill() {
        Some(p) => p,
        None => return ToolchainReport::error("Jintia Skill no está instalada. Ve a Configuración > Entorno."),
    };
    let mut args: Vec<&str> = vec![&operation];

    if let Some(target) = target.as_deref() {
        args.push(target);
    } else if operation != "doctor" {
        return ToolchainReport::error(format!("{operation} requiere una ruta de archivo."));
    }

    if json.unwrap_or(true) {
        args.push("--json");
    }

    if strict.unwrap_or(false) {
        args.push("--strict");
    }

    match engine::run_jintia(Path::new(&skill_path), &args) {
        Ok(result) => {
            let report = serde_json::from_str(&result.stdout).ok();
            ToolchainReport {
                success: result.success,
                message: if result.success {
                    format!("{operation} terminó correctamente.")
                } else {
                    format!("{operation} terminó con errores.")
                },
                operation,
                stdout: result.stdout,
                stderr: result.stderr,
                exit_code: result.exit_code,
                report,
            }
        }
        Err(error) => ToolchainReport::error(error),
    }
}

/// Gestiona harnesses (proveedores IA) a través de la Skill CLI.
///
/// Operaciones válidas: status, install, update, repair, uninstall.
pub fn manage_harness(
    operation: String,
    project_path: String,
    providers: Vec<String>,
    scope: String,
    confirm: bool,
) -> ToolchainReport {
    if !["status", "install", "update", "repair", "uninstall"].contains(&operation.as_str()) {
        return ToolchainReport::error(format!("Operación de harness no permitida: {operation}"));
    }
    if !["project", "global"].contains(&scope.as_str()) {
        return ToolchainReport::error("El alcance debe ser project o global.".to_string());
    }

    let skill_path = match crate::runtimes::resolve_skill() {
        Some(p) => p,
        None => return ToolchainReport::error("Jintia Skill no está instalada. Ve a Configuración > Entorno."),
    };
    let mut args: Vec<String> = vec![
        "harness".to_string(),
        operation.clone(),
        format!("--project={project_path}"),
        format!("--scope={scope}"),
        "--json".to_string(),
    ];

    if !providers.is_empty() {
        args.push(format!("--providers={}", providers.join(",")));
    }

    if confirm {
        args.push("--yes".to_string());
    }

    let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    match engine::run_jintia(Path::new(&skill_path), &args_refs) {
        Ok(result) => {
            let report = serde_json::from_str(&result.stdout).ok();
            ToolchainReport {
                success: result.success,
                message: if result.success {
                    format!("harness {operation} terminó correctamente.")
                } else {
                    format!("harness {operation} terminó con errores.")
                },
                operation: format!("harness {operation}"),
                stdout: result.stdout,
                stderr: result.stderr,
                exit_code: result.exit_code,
                report,
            }
        }
        Err(error) => ToolchainReport::error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::{claude_install_args, installed_target};
    use serde_json::json;

    #[test]
    fn claude_install_uses_exact_adoption_contract() {
        assert_eq!(claude_install_args(), [
            "install", "--providers=claude", "--scope=global", "--yes", "--adopt-existing", "--json"
        ]);
    }

    #[test]
    fn installed_target_requires_non_empty_string_result() {
        assert_eq!(installed_target(&json!({"results": [{"target": "/managed/skill"}]})), Some("/managed/skill".to_string()));
        for report in [
            json!({}),
            json!({"results": []}),
            json!({"results": [{}]}),
            json!({"results": [{"target": ""}]}),
            json!({"results": [{"target": 42}]}),
        ] {
            assert_eq!(installed_target(&report), None);
        }
    }
}
