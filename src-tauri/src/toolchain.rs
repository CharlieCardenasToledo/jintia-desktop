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
    /// Valor literal del campo "status" devuelto por `jintia plugin status --json`:
    /// "not-installed" | "installed" | "outdated" | "incomplete" | "foreign"
    pub status: String,
}

#[derive(Debug, Clone, Default)]
pub struct ClaudeSkillStatus {
    pub installed: bool,
    pub current: bool,
    pub version: String,
    pub available_version: String,
    pub target: String,
}

#[derive(Debug, Clone, Default)]
pub struct AgentSkillsStatus {
    pub claude: ClaudeSkillStatus,
    pub codex: ClaudeSkillStatus,
    pub opencode: ClaudeSkillStatus,
}

#[cfg(test)]
fn claude_status_args() -> [&'static str; 4] {
    ["status", "--providers=claude", "--scope=global", "--json"]
}

fn agent_status_args() -> [&'static str; 4] {
    ["status", "--providers=claude,codex,opencode", "--scope=global", "--json"]
}

fn parse_provider_skill_status(stdout: &str, provider_id: &str) -> Result<ClaudeSkillStatus, String> {
    let report: Value = serde_json::from_str(stdout).map_err(|e| format!("Reporte JSON inválido de Jintia: {e}"))?;
    if report.get("tool").and_then(Value::as_str) != Some("jintia")
        || report.get("command").and_then(Value::as_str) != Some("status")
        || report.get("status").and_then(Value::as_str) != Some("success")
        || report.get("exitCode").and_then(Value::as_i64) != Some(0)
    { return Err("Reporte de status de harnesses incompatible.".into()); }
    let data = report.get("data").ok_or("data ausente en el status de harnesses.")?;
    if data.get("operation").and_then(Value::as_str) != Some("status") { return Err("operation inválida en el status de harnesses.".into()); }
    let providers = data.get("providers").and_then(Value::as_array).ok_or("providers inválido en el status de harnesses.")?;
    let matches: Vec<&Value> = providers.iter().filter(|p| p.get("id").and_then(Value::as_str) == Some(provider_id) && p.get("scope").and_then(Value::as_str) == Some("global")).collect();
    if matches.len() != 1 { return Err(format!("Debe existir exactamente un provider {provider_id} global.")); }
    let provider = matches[0];
    let target = provider.get("target").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("target inválido en el status Claude.")?;
    let state = provider.get("state").ok_or("state ausente en el status Claude.")?;
    let installed = state.get("installed").and_then(Value::as_bool).ok_or("installed inválido en el status Claude.")?;
    let managed = state.get("managed").and_then(Value::as_bool).ok_or("managed inválido en el status Claude.")?;
    let available = state.get("availableVersion").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("availableVersion inválido en el status Claude.")?;
    let status = state.get("status").and_then(Value::as_str).ok_or("status inválido en el status Claude.")?;
    if !["not-detected", "detected", "repair-needed", "incomplete", "outdated", "installed"].contains(&status) { return Err("status desconocido en el status Claude.".into()); }
    let version = match state.get("version") { Some(Value::String(v)) if !v.is_empty() => v.clone(), Some(Value::Null) => String::new(), _ => return Err("version inválida en el status Claude.".into()) };
    Ok(ClaudeSkillStatus { installed, current: installed && managed && status == "installed" && version == available, version, available_version: available.to_owned(), target: target.to_owned() })
}

#[cfg(test)]
fn parse_claude_skill_status(stdout: &str) -> Result<ClaudeSkillStatus, String> {
    parse_provider_skill_status(stdout, "claude")
}

pub fn agent_skills_status() -> Result<AgentSkillsStatus, String> {
    let skill = crate::runtimes::resolve_skill().ok_or("Jintia administrado no está disponible. Actualízalo desde Configuración > Entorno.")?;
    let result = engine::run_jintia(Path::new(&skill), &agent_status_args()).map_err(|e| e.to_string())?;
    if !result.success { return Err(format!("Jintia status de harnesses falló: {}", result.stderr)); }
    Ok(AgentSkillsStatus {
        claude: parse_provider_skill_status(&result.stdout, "claude")?,
        codex: parse_provider_skill_status(&result.stdout, "codex")?,
        opencode: parse_provider_skill_status(&result.stdout, "opencode")?,
    })
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
    Ok(OpenAiPluginStatus { installed, current, target: target.to_owned(), status: status.to_owned() })
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

fn agent_install_args() -> [&'static str; 6] {
    [
        "install",
        "--providers=claude,codex,opencode",
        "--scope=global",
        "--yes",
        "--adopt-existing",
        "--json",
    ]
}

fn installed_targets(report: &Value) -> Option<Vec<(String, String)>> {
    let data = report.get("data")?;
    if data.get("operation").and_then(Value::as_str) != Some("install") {
        return None;
    }
    let results = data.get("results")?.as_array()?;
    let mut targets = Vec::new();
    for provider_id in ["claude", "codex", "opencode"] {
        let matches: Vec<&Value> = results.iter()
            .filter(|item| item.get("id").and_then(Value::as_str) == Some(provider_id))
            .collect();
        if matches.len() != 1 || matches[0].get("status").and_then(Value::as_str) != Some("installed") {
            return None;
        }
        let target = matches[0].get("target")?.as_str()?.trim();
        if target.is_empty() {
            return None;
        }
        targets.push((provider_id.to_owned(), target.to_owned()));
    }
    Some(targets)
}

fn command_report_error(stdout: &str, expected_command: &str) -> Option<String> {
    let report: Value = serde_json::from_str(stdout).ok()?;
    if report.get("tool").and_then(Value::as_str) != Some("jintia")
        || report.get("command").and_then(Value::as_str) != Some(expected_command)
        || report.get("status").and_then(Value::as_str) != Some("failed")
        || report.get("exitCode").and_then(Value::as_i64).is_none_or(|code| code == 0)
    {
        return None;
    }
    let messages = report
        .get("errors")?
        .as_array()?
        .iter()
        .filter_map(|error| error.get("message").and_then(Value::as_str))
        .filter(|message| !message.trim().is_empty())
        .collect::<Vec<_>>();
    (!messages.is_empty()).then(|| messages.join(" "))
}

fn agent_install_failure_message(stdout: &str, stderr: &str) -> String {
    let detail = command_report_error(stdout, "install")
        .unwrap_or_else(|| if stderr.trim().is_empty() { stdout.to_owned() } else { stderr.to_owned() });
    if detail.contains("path\" argument must be of type string")
        && detail.contains("Received undefined")
    {
        return "No se pudo resolver la carpeta de configuración de Codex. Jintia conservará lo ya instalado y podrás reintentar sin perder datos.".to_string();
    }
    detail
}

pub fn install_global_agent_skills() -> ActionResult {
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

    let args = agent_install_args();
    match engine::run_jintia(Path::new(&skill_path), &args) {
        Ok(result) if !result.success => {
            let detail = agent_install_failure_message(&result.stdout, &result.stderr);
            ActionResult::error(format!("Jintia no pudo registrar las skills de los asistentes. {detail}"))
        }
        Ok(result) => match serde_json::from_str::<Value>(&result.stdout).ok().and_then(|report| installed_targets(&report)) {
            Some(targets) => {
                match agent_skills_status() {
                    Ok(status) if status.claude.current && status.codex.current && status.opencode.current => {
                        let summary = targets.iter().map(|(id, target)| format!("{id}: {target}")).collect::<Vec<_>>().join("\n");
                        ActionResult::ok(format!("Jintia Skill quedó instalada y verificada para Claude Code, Codex y OpenCode.\n{summary}"))
                            .with_path(targets[0].1.clone())
                    }
                    Ok(status) => {
                        let pending = [
                            (!status.claude.current).then_some("Claude Code"),
                            (!status.codex.current).then_some("Codex"),
                            (!status.opencode.current).then_some("OpenCode"),
                        ].into_iter().flatten().collect::<Vec<_>>().join(", ");
                        ActionResult::error(format!("La copia terminó, pero no se pudo verificar la instalación de: {pending}."))
                    }
                    Err(error) => ActionResult::error(format!("La copia terminó, pero falló la verificación final de las tres integraciones: {error}")),
                }
            }
            None => ActionResult::error("Jintia devolvió una instalación exitosa sin confirmar los targets de Claude, Codex y OpenCode."),
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
        agent_install_args, agent_install_failure_message, claude_status_args, command_report_error,
        installed_targets, openai_plugin_install_args,
        openai_plugin_status_args, parse_claude_skill_status, parse_openai_plugin_install, parse_openai_plugin_status,
        plugin_command_failure_message, plugin_report_error, OPENAI_PLUGIN_CAPABILITY_ERROR,
    };
    use serde_json::{json, Value};

    #[test]
    fn claude_status_uses_exact_cli_contract() {
        assert_eq!(claude_status_args(), ["status", "--providers=claude", "--scope=global", "--json"]);
    }

    #[test]
    fn claude_install_uses_exact_adoption_contract() {
        assert_eq!(agent_install_args(), [
            "install", "--providers=claude,codex,opencode", "--scope=global", "--yes", "--adopt-existing", "--json"
        ]);
    }

    #[test]
    fn agent_install_errors_are_extracted_and_known_codex_path_failure_is_explained() {
        let report = json!({
            "tool":"jintia",
            "command":"install",
            "status":"failed",
            "exitCode":1,
            "errors":[{"message":"Jintia Harness: The \"path\" argument must be of type string. Received undefined"}]
        });
        let text = report.to_string();
        assert!(command_report_error(&text, "install").is_some());
        let message = agent_install_failure_message(&text, "");
        assert!(message.contains("carpeta de configuración de Codex"));
        assert!(!message.contains("Received undefined"));
    }

    #[test]
    fn installed_targets_require_the_complete_agent_matrix() {
        let valid = json!({"data":{"operation":"install","results":[
            {"id":"claude","status":"installed","target":"/claude/skill"},
            {"id":"codex","status":"installed","target":"/codex/skill"},
            {"id":"opencode","status":"installed","target":"/opencode/skill"}
        ]}});
        assert_eq!(installed_targets(&valid).map(|items| items.len()), Some(3));
        for report in [
            json!({}),
            json!({"data":{"operation":"install","results":[]}}),
            json!({"data":{"operation":"install","results":[{"id":"claude","status":"installed","target":"/skill"}]}}),
            json!({"data":{"operation":"wrong","results":[]}}),
        ] {
            assert_eq!(installed_targets(&report), None);
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

    fn claude_report(providers: serde_json::Value) -> serde_json::Value {
        json!({"tool":"jintia","command":"status","status":"success","exitCode":0,"data":{"operation":"status","providers":providers}})
    }

    fn claude_provider(scope: &str, installed: bool, managed: bool, version: serde_json::Value, available: &str, status: &str) -> serde_json::Value {
        json!({"id":"claude","scope":scope,"target":format!("/{scope}/.claude/skills/jintia-skill"),"state":{"installed":installed,"managed":managed,"version":version,"availableVersion":available,"status":status}})
    }

    fn global_provider() -> serde_json::Value {
        claude_provider("global", true, true, json!("11.6.13"), "11.6.13", "installed")
    }

    #[test]
    fn claude_parser_selects_global_by_id_and_scope_in_any_order() {
        let project = claude_provider("project", false, false, Value::Null, "11.6.13", "detected");
        for providers in [json!([project.clone(), global_provider()]), json!([global_provider(), project])] {
            let parsed = parse_claude_skill_status(&claude_report(providers).to_string()).unwrap();
            assert!(parsed.installed && parsed.current);
            assert_eq!(parsed.version, "11.6.13");
            assert_eq!(parsed.available_version, "11.6.13");
            assert_eq!(parsed.target, "/global/.claude/skills/jintia-skill");
        }
        let providers = json!([{"id":"codex","scope":"global"},{"id":"cursor","scope":"global"},{"id":"claude","scope":"project"},global_provider(),{"id":"opencode","scope":"project"}]);
        assert!(parse_claude_skill_status(&claude_report(providers).to_string()).is_ok());
    }

    #[test]
    fn claude_parser_maps_contractual_states_and_strict_current() {
        for status in ["not-detected", "detected", "repair-needed", "incomplete", "outdated"] {
            let installed = matches!(status, "outdated" | "repair-needed");
            let report = claude_report(json!([claude_provider("global", installed, true, if installed { json!("11.6.12") } else { Value::Null }, "11.6.13", status)]));
            let parsed = parse_claude_skill_status(&report.to_string()).unwrap();
            assert_eq!(parsed.installed, installed);
            assert!(!parsed.current);
        }
        let repair_equal = parse_claude_skill_status(&claude_report(json!([claude_provider("global", true, true, json!("11.6.13"), "11.6.13", "repair-needed")])).to_string()).unwrap();
        assert!(repair_equal.installed);
        assert!(!repair_equal.current);
        assert_eq!(repair_equal.version, "11.6.13");
        assert_eq!(repair_equal.available_version, "11.6.13");
        for (managed, version, status, expected) in [(true, json!("11.6.13"), "installed", true), (false, json!("11.6.13"), "installed", false), (true, json!("11.6.12"), "installed", false), (true, Value::Null, "installed", false)] {
            let parsed = parse_claude_skill_status(&claude_report(json!([claude_provider("global", true, managed, version, "11.6.13", status)])).to_string()).unwrap();
            assert_eq!(parsed.current, expected);
        }
        let not_installed = parse_claude_skill_status(&claude_report(json!([claude_provider("global", false, false, Value::Null, "11.6.13", "not-detected")])).to_string()).unwrap();
        assert_eq!(not_installed.version, "");
    }

    #[test]
    fn claude_parser_accepts_incomplete_and_detected_without_current() {
        for status in ["detected", "incomplete"] {
            let parsed = parse_claude_skill_status(&claude_report(json!([claude_provider("global", false, false, Value::Null, "11.6.13", status)])).to_string()).unwrap();
            assert!(!parsed.installed && !parsed.current);
        }
    }

    #[test]
    fn claude_parser_rejects_invalid_outer_report_and_provider() {
        let valid = claude_report(json!([global_provider()]));
        let invalid = ["{".to_owned(), "not json".to_owned(), r#"{"tool":"jintia""#.to_owned()];
        for raw in invalid { assert!(parse_claude_skill_status(&raw).is_err()); }
        let mut invalid = Vec::new();
        for (key, value) in [("tool", json!("other")), ("command", json!("wrong")), ("status", json!("failed")), ("exitCode", json!(1))] {
            let mut report = valid.clone(); report[key] = value; invalid.push(report);
        }
        let mut missing_data = valid.clone(); missing_data.as_object_mut().unwrap().remove("data"); invalid.push(missing_data);
        let mut wrong_operation = valid.clone(); wrong_operation["data"]["operation"] = json!("wrong"); invalid.push(wrong_operation);
        let mut missing_providers = valid.clone(); missing_providers["data"].as_object_mut().unwrap().remove("providers"); invalid.push(missing_providers);
        let mut non_array = valid.clone(); non_array["data"]["providers"] = json!({}); invalid.push(non_array);
        for report in invalid { assert!(parse_claude_skill_status(&report.to_string()).is_err()); }

        let malformed = [
            json!([]),
            json!([claude_provider("project", false, false, Value::Null, "11.6.13", "detected")]),
            json!([global_provider(), global_provider()]),
        ];
        for providers in malformed { assert!(parse_claude_skill_status(&claude_report(providers).to_string()).is_err()); }
        for (field, value) in [("target", json!(42)), ("target", json!("")), ("state", Value::Null)] {
            let mut provider = global_provider(); provider[field] = value; assert!(parse_claude_skill_status(&claude_report(json!([provider])).to_string()).is_err());
        }
        let mut missing_state = global_provider();
        missing_state.as_object_mut().unwrap().remove("state");
        assert!(parse_claude_skill_status(&claude_report(json!([missing_state])).to_string()).is_err());
    }

    #[test]
    fn claude_parser_rejects_invalid_state_types_and_values() {
        let fields = [
            ("installed", json!("yes")), ("managed", json!("yes")),
            ("availableVersion", json!(11613)), ("availableVersion", json!("")),
            ("version", json!(11613)), ("version", json!(true)), ("version", json!("")),
            ("status", json!(1)), ("status", json!("foreign")),
        ];
        for (field, value) in fields {
            let mut provider = global_provider(); provider["state"][field] = value;
            assert!(parse_claude_skill_status(&claude_report(json!([provider])).to_string()).is_err());
        }
        for field in ["availableVersion", "version", "status"] {
            let mut provider = global_provider(); provider["state"].as_object_mut().unwrap().remove(field);
            assert!(parse_claude_skill_status(&claude_report(json!([provider])).to_string()).is_err());
        }
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
