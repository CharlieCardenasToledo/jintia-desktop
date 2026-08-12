use crate::engine;
use crate::models::{ActionResult, ToolchainReport};
use serde_json::Value;
use std::path::Path;

fn openai_plugin_status_args() -> [&'static str; 3] {
    ["plugin", "status", "--json"]
}

fn openai_plugin_install_args() -> [&'static str; 4] {
    ["plugin", "install", "--yes", "--json"]
}

const OPENAI_PLUGIN_CAPABILITY_ERROR: &str =
    "El Jintia administrado instalado no admite la gestión del plugin OpenAI. Actualízalo desde Configuración > Entorno.";

#[derive(Debug, Clone, Default)]
pub struct OpenAiPluginStatus {
    pub installed: bool,
    pub current: bool,
    pub target: String,
}

fn report_data<'a>(report: &'a Value, command: &str, operation: &str) -> Result<&'a Value, String> {
    if report.get("tool").and_then(Value::as_str) != Some("jintia")
        || report.get("command").and_then(Value::as_str) != Some(command)
        || report.get("status").and_then(Value::as_str) != Some("success")
        || report.get("exitCode").and_then(Value::as_i64) != Some(0) {
        return Err("El reporte de Jintia no cumple el contrato esperado.".into());
    }
    let data = report.get("data").ok_or("Jintia no devolvió data.")?;
    if data.get("operation").and_then(Value::as_str) != Some(operation) { return Err("La operación del reporte Jintia no coincide.".into()); }
    Ok(data)
}

fn plugin_report_error(stdout: &str, expected_command: &str) -> Option<String> {
    let report: Value = serde_json::from_str(stdout).ok()?;
    if report.get("tool").and_then(Value::as_str) != Some("jintia")
        || report.get("command").and_then(Value::as_str) != Some(expected_command)
        || report.get("status").and_then(Value::as_str) != Some("failed")
        || report.get("exitCode").and_then(Value::as_i64).is_none_or(|code| code == 0)
    {
        return None;
    }
    report
        .get("errors")?
        .as_array()?
        .iter()
        .filter_map(|error| error.get("message").and_then(Value::as_str))
        .map(str::trim)
        .find(|message| !message.is_empty())
        .filter(|message| !message.is_empty())
        .map(str::to_owned)
}

fn plugin_command_failure_message(stdout: &str, expected_command: &str) -> String {
    plugin_report_error(stdout, expected_command)
        .unwrap_or_else(|| OPENAI_PLUGIN_CAPABILITY_ERROR.to_owned())
}

fn parse_openai_plugin_status(stdout: &str) -> Result<OpenAiPluginStatus, String> {
    let report: Value = serde_json::from_str(stdout).map_err(|e| format!("Reporte JSON inválido de Jintia: {e}"))?;
    let data = report_data(&report, "plugin status", "status")?;
    let target = data.get("target").and_then(Value::as_str).ok_or("target inválido en el status del plugin.")?;
    if target.is_empty() {
        return Err("target vacío en el status del plugin.".into());
    }
    let installed = data.get("installed").and_then(Value::as_bool).ok_or("installed inválido en el status del plugin.")?;
    let current = data.get("current").and_then(Value::as_bool).ok_or("current inválido en el status del plugin.")?;
    let status = data.get("status").and_then(Value::as_str).ok_or("status inválido en el status del plugin.")?;
    if !["not-installed", "installed", "outdated", "incomplete", "foreign"].contains(&status) { return Err("estado de plugin desconocido.".into()); }
    if data.get("marketplaceConfigured").and_then(Value::as_bool).is_none() { return Err("marketplaceConfigured inválido en el status del plugin.".into()); }
    Ok(OpenAiPluginStatus { installed, current, target: target.to_owned() })
}

fn parse_openai_plugin_install(stdout: &str) -> Result<(String, String, bool), String> {
    let report: Value = serde_json::from_str(stdout).map_err(|e| format!("Reporte JSON inválido de Jintia: {e}"))?;
    let data = report_data(&report, "plugin install", "install")?;
    if data.get("installed").and_then(Value::as_bool) != Some(true) || data.get("current").and_then(Value::as_bool) != Some(true) || data.get("marketplaceConfigured").and_then(Value::as_bool) != Some(true) { return Err("Jintia no confirmó la instalación actual del plugin.".to_string()); }
    let target = data.get("target").and_then(Value::as_str).ok_or("target vacío en la instalación del plugin.")?;
    if target.is_empty() { return Err("target vacío en la instalación del plugin.".to_string()); }
    let version = data.get("version").and_then(Value::as_str).ok_or("version vacía en la instalación del plugin.")?;
    if version.is_empty() { return Err("version vacía en la instalación del plugin.".to_string()); }
    let changed = data.get("changed").and_then(Value::as_bool).ok_or("changed inválido en la instalación del plugin.")?;
    Ok((target.to_owned(), version.to_owned(), changed))
}

pub fn openai_plugin_status() -> Result<OpenAiPluginStatus, String> {
    let skill = crate::runtimes::resolve_skill().ok_or("Jintia administrado no está disponible. Actualízalo desde Configuración > Entorno.")?;
    let args = openai_plugin_status_args();
    let result = engine::run_jintia(Path::new(&skill), &args).map_err(|e| e.to_string())?;
    if !result.success {
        return Err(plugin_command_failure_message(&result.stdout, "plugin status"));
    }
    parse_openai_plugin_status(&result.stdout)
}

pub fn install_openai_plugin() -> ActionResult {
    let skill = match crate::runtimes::resolve_skill() { Some(v) => v, None => return ActionResult::error("Jintia administrado no está disponible. Actualízalo desde Configuración > Entorno.") };
    let args = openai_plugin_install_args();
    match engine::run_jintia(Path::new(&skill), &args) {
        Ok(result) if !result.success => ActionResult::error(plugin_command_failure_message(&result.stdout, "plugin install")),
        Ok(result) => match parse_openai_plugin_install(&result.stdout) { Ok((target, _, _)) => ActionResult::ok("Jintia gestionó el plugin OpenAI.").with_path(target), Err(e) => ActionResult::error(e) },
        Err(e) => ActionResult::error(e),
    }
}

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
    use super::{
        claude_install_args, installed_target, openai_plugin_install_args,
        openai_plugin_status_args, parse_openai_plugin_install, parse_openai_plugin_status,
        plugin_command_failure_message, plugin_report_error, OPENAI_PLUGIN_CAPABILITY_ERROR,
    };
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

    #[test]
    fn openai_plugin_uses_exact_cli_contract() {
        assert_eq!(openai_plugin_status_args(), ["plugin", "status", "--json"]);
        assert_eq!(openai_plugin_install_args(), ["plugin", "install", "--yes", "--json"]);
    }

    #[test]
    fn openai_plugin_status_parser_is_fail_closed() {
        let valid = json!({"tool":"jintia","command":"plugin status","status":"success","exitCode":0,"data":{"operation":"status","target":"/plugin","installed":true,"current":true,"marketplaceConfigured":true,"status":"installed"}});
        assert!(parse_openai_plugin_status(&valid.to_string()).is_ok());
        let invalid_reports = [
            json!({"tool":"jintia","command":"plugin status","status":"success","exitCode":0}),
            json!({"tool":"other","command":"plugin status","status":"success","exitCode":0,"data":{}}),
            json!({"tool":"jintia","command":"wrong","status":"success","exitCode":0,"data":{}}),
            json!({"tool":"jintia","command":"plugin status","status":"failed","exitCode":1,"data":{}}),
            json!({"tool":"jintia","command":"plugin status","status":"success","exitCode":1,"data":{}}),
            json!({"tool":"jintia","command":"plugin status","status":"success","exitCode":0,"data":{"operation":"wrong"}}),
            json!({"tool":"jintia","command":"plugin status","status":"success","exitCode":0,"data":{"operation":"status","target":1,"installed":true,"current":true,"marketplaceConfigured":true,"status":"installed"}}),
            json!({"tool":"jintia","command":"plugin status","status":"success","exitCode":0,"data":{"operation":"status","target":"","installed":true,"current":true,"marketplaceConfigured":true,"status":"installed"}}),
            json!({"tool":"jintia","command":"plugin status","status":"success","exitCode":0,"data":{"operation":"status","target":"/plugin","installed":"yes","current":true,"marketplaceConfigured":true,"status":"installed"}}),
            json!({"tool":"jintia","command":"plugin status","status":"success","exitCode":0,"data":{"operation":"status","target":"/plugin","installed":true,"current":"yes","marketplaceConfigured":true,"status":"installed"}}),
            json!({"tool":"jintia","command":"plugin status","status":"success","exitCode":0,"data":{"operation":"status","target":"/plugin","installed":true,"current":true,"marketplaceConfigured":"yes","status":"installed"}}),
            json!({"tool":"jintia","command":"plugin status","status":"success","exitCode":0,"data":{"operation":"status","target":"/plugin","installed":true,"current":true,"marketplaceConfigured":true}}),
            json!({"tool":"jintia","command":"plugin status","status":"success","exitCode":0,"data":{"operation":"status","target":"/plugin","installed":true,"current":true,"marketplaceConfigured":true,"status":42}}),
            json!({"tool":"jintia","command":"plugin status","status":"success","exitCode":0,"data":{"operation":"status","target":"/plugin","installed":true,"current":true,"marketplaceConfigured":true,"status":"unknown"}}),
        ];
        for report in invalid_reports { assert!(parse_openai_plugin_status(&report.to_string()).is_err()); }
    }

    #[test]
    fn openai_plugin_install_parser_accepts_changed_boolean_and_rejects_invalid() {
        for changed in [true, false] {
            let report = json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"data":{"operation":"install","installed":true,"current":true,"marketplaceConfigured":true,"target":"/plugin","version":"11.6.13","changed":changed}});
            assert!(parse_openai_plugin_install(&report.to_string()).is_ok());
        }
        let invalid_reports = [
            json!({"tool":"other","command":"plugin install","status":"success","exitCode":0,"data":{}}),
            json!({"tool":"jintia","command":"wrong","status":"success","exitCode":0,"data":{}}),
            json!({"tool":"jintia","command":"plugin install","status":"failed","exitCode":1,"data":{}}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":1,"data":{}}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"data":{"operation":"wrong"}}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"data":{"operation":"install","installed":false,"current":true,"marketplaceConfigured":true,"target":"/plugin","version":"11.6.13","changed":true}}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"data":{"operation":"install","installed":"yes","current":true,"marketplaceConfigured":true,"target":"/plugin","version":"11.6.13","changed":true}}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"data":{"operation":"install","installed":true,"current":false,"marketplaceConfigured":true,"target":"/plugin","version":"11.6.13","changed":true}}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"data":{"operation":"install","installed":true,"current":"yes","marketplaceConfigured":true,"target":"/plugin","version":"11.6.13","changed":true}}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"data":{"operation":"install","installed":true,"current":true,"marketplaceConfigured":false,"target":"/plugin","version":"11.6.13","changed":true}}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"data":{"operation":"install","installed":true,"current":true,"marketplaceConfigured":"yes","target":"/plugin","version":"11.6.13","changed":true}}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"data":{"operation":"install","installed":true,"current":true,"marketplaceConfigured":true,"target":"","version":"11.6.13","changed":true}}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"data":{"operation":"install","installed":true,"current":true,"marketplaceConfigured":true,"target":1,"version":"11.6.13","changed":true}}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"data":{"operation":"install","installed":true,"current":true,"marketplaceConfigured":true,"target":"/plugin","version":"","changed":true}}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"data":{"operation":"install","installed":true,"current":true,"marketplaceConfigured":true,"target":"/plugin","version":1,"changed":true}}),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"data":{"operation":"install","installed":true,"current":true,"marketplaceConfigured":true,"target":"/plugin","version":"11.6.13","changed":"yes"}}),
        ];
        for report in invalid_reports { assert!(parse_openai_plugin_install(&report.to_string()).is_err()); }
    }

    #[test]
    fn openai_plugin_failed_reports_preserve_upstream_message() {
        let install = json!({"tool":"jintia","command":"plugin install","status":"failed","exitCode":1,"errors":[{"message":"fallo upstream"}]});
        let status = json!({"tool":"jintia","command":"plugin status","status":"failed","exitCode":2,"errors":[{"message":"status upstream"}]});
        assert_eq!(plugin_report_error(&install.to_string(), "plugin install").as_deref(), Some("fallo upstream"));
        assert_eq!(plugin_report_error(&status.to_string(), "plugin status").as_deref(), Some("status upstream"));
        assert_eq!(plugin_command_failure_message(&install.to_string(), "plugin install"), "fallo upstream");
        let later_install = json!({"tool":"jintia","command":"plugin install","status":"failed","exitCode":1,"errors":[{"message":" "},{"message":"fallo real upstream"}]});
        let later_status = json!({"tool":"jintia","command":"plugin status","status":"failed","exitCode":1,"errors":[{},{"message":42},{"message":""},{"message":"  "},{"message":"mensaje válido"}]});
        assert_eq!(plugin_report_error(&later_install.to_string(), "plugin install").as_deref(), Some("fallo real upstream"));
        assert_eq!(plugin_report_error(&later_status.to_string(), "plugin status").as_deref(), Some("mensaje válido"));
        assert_eq!(plugin_command_failure_message("", "plugin install"), OPENAI_PLUGIN_CAPABILITY_ERROR);
        for invalid in [
            "not json".to_owned(),
            json!({"tool":"other","command":"plugin install","status":"failed","exitCode":1,"errors":[{"message":"x"}]}).to_string(),
            json!({"tool":"jintia","command":"wrong","status":"failed","exitCode":1,"errors":[{"message":"x"}]}).to_string(),
            json!({"tool":"jintia","command":"plugin install","status":"success","exitCode":0,"errors":[{"message":"x"}]}).to_string(),
            json!({"tool":"jintia","command":"plugin install","status":"failed","exitCode":0,"errors":[{"message":"x"}]}).to_string(),
            json!({"tool":"jintia","command":"plugin install","status":"failed","exitCode":1}).to_string(),
            json!({"tool":"jintia","command":"plugin install","status":"failed","exitCode":1,"errors":[]}).to_string(),
            json!({"tool":"jintia","command":"plugin install","status":"failed","exitCode":1,"errors":[{}]}).to_string(),
            json!({"tool":"jintia","command":"plugin install","status":"failed","exitCode":1,"errors":[{"message":" "}]}).to_string(),
        ] {
            assert!(plugin_report_error(&invalid, "plugin install").is_none());
            assert_eq!(plugin_command_failure_message(&invalid, "plugin install"), OPENAI_PLUGIN_CAPABILITY_ERROR);
        }
    }
}
