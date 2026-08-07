use crate::engine;
use crate::models::ToolchainReport;
use crate::payload;
use std::path::Path;

/// Ejecuta una operación Jintia a través del Engine Adapter.
///
/// Operaciones válidas: doctor, audit, validate, compile, y otras que añada la Skill.
pub fn run(operation: String, target: Option<String>, json: Option<bool>, strict: Option<bool>) -> ToolchainReport {
    let skill_path = payload::installed_skill_path();
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

    let skill_path = payload::installed_skill_path();
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
