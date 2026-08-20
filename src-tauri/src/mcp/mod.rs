pub mod auth;
pub mod client;
pub mod config;
pub mod notebooks;

pub use auth::{
    cancel_auth, check_auth, start_auth, start_auth_operation,
};
pub use config::{codex_mcp_configured, configure_codex_mcp, configure_mcp};
pub use notebooks::{list_account_notebooks, list_notebooks};

use semver::{Version, VersionReq};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command};
use std::sync::mpsc;

pub(crate) struct ManagedMcp {
    pub(crate) node: PathBuf,
    pub(crate) bin: PathBuf,
}

// gemini-notebook-mcp v2.0 mantiene su navegador y perfil de Chrome persistentes
// en un `SharedContextManager` que vive en memoria mientras el proceso del
// servidor está vivo. Antes lanzábamos (y matábamos) un proceso nuevo por
// cada llamada — get_health y setup_auth terminaban en procesos distintos
// que no compartían ese estado en memoria, así que setup_auth nunca llegaba
// a completar su detección de login antes de que lo cerráramos. Ahora se
// mantiene UN solo proceso vivo, reutilizado por todas las llamadas.
pub(crate) struct McpConnection {
    pub(crate) child: Child,
    pub(crate) stdin: Option<ChildStdin>,
    pub(crate) receiver: mpsc::Receiver<String>,
    pub(crate) next_id: i64,
}

use std::thread;
use std::time::{Duration, Instant};

impl Drop for McpConnection {
    fn drop(&mut self) {
        // Cerrar stdin primero permite que el servidor procese EOF y ejecute su
        // limpieza de sesiones/contextos. Solo se fuerza la terminación si no
        // sale por sí mismo en un margen breve.
        self.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(crate) fn managed_mcp() -> Result<ManagedMcp, String> {
    let node = crate::paths::portable_node_exe();
    if !node.is_file() {
        return Err("NotebookLM MCP requiere el Node.js administrado por Jintia.".to_string());
    }
    let contract = crate::release::managed_mcp_contract()?;
    if !crate::runtimes::portable_notebooklm_mcp_installed_for(&contract) {
        return Err(
            "NotebookLM MCP no está instalado o no coincide con el contrato aprobado.".to_string(),
        );
    }
    validate_managed_node(&node, &contract.node_requirement)?;
    let package_dir = crate::runtimes::portable_notebooklm_mcp_package_dir_for(&contract.package);
    let bin = crate::runtimes::resolve_notebooklm_mcp_bin_for(&package_dir, &contract)?;
    Ok(ManagedMcp { node, bin })
}

pub(crate) fn managed_mcp_server_json(node: &Path, bin: &Path, managed_path: &str) -> Value {
    serde_json::json!({
        "command": node.to_string_lossy(),
        "args": [bin.to_string_lossy()],
        "env": {
            "PATH": managed_path,
        },
    })
}

pub(crate) fn managed_node_runtime_path_text() -> Result<String, String> {
    crate::runtimes::managed_node_runtime_path().map(|path| path.to_string_lossy().into_owned())
}

pub(crate) fn server_matches_paths(
    server: &Value,
    node: &Path,
    bin: &Path,
    managed_path: &str,
) -> bool {
    server.get("command").and_then(Value::as_str) == node.to_str()
        && server
            .get("args")
            .and_then(Value::as_array)
            .is_some_and(|args| args.len() == 1 && args[0].as_str() == bin.to_str())
        && server
            .get("env")
            .and_then(Value::as_object)
            .and_then(|env| env.get("PATH"))
            .and_then(Value::as_str)
            == Some(managed_path)
}

pub(crate) fn server_matches_managed_mcp(server: &Value) -> bool {
    let Ok(managed) = managed_mcp() else {
        return false;
    };
    let Ok(managed_path) = managed_node_runtime_path_text() else {
        return false;
    };
    server_matches_paths(server, &managed.node, &managed.bin, &managed_path)
}

pub(crate) fn build_managed_node_version_command(node: &Path) -> Command {
    let mut command = crate::runtimes::managed_node_command(node);
    command.arg("--version");
    command
}

pub(crate) fn managed_node_version(node: &std::path::Path) -> Result<Version, String> {
    let output = build_managed_node_version_command(node)
        .output()
        .map_err(|error| format!("No se pudo consultar el Node administrado: {error}"))?;
    if !output.status.success() {
        return Err("El Node administrado no pudo informar su versión.".to_string());
    }
    parse_node_version(&String::from_utf8_lossy(&output.stdout))
}

pub(crate) fn parse_node_version(text: &str) -> Result<Version, String> {
    let version = text.trim().trim_start_matches('v');
    Version::parse(version)
        .map_err(|error| format!("Versión inválida del Node administrado: {error}"))
}

pub(crate) fn validate_managed_node(
    node: &std::path::Path,
    node_requirement: &str,
) -> Result<(), String> {
    let requirement = VersionReq::parse(node_requirement)
        .map_err(|error| format!("Requisito Node inválido para NotebookLM MCP: {error}"))?;
    let version = managed_node_version(node)?;
    if !requirement.matches(&version) {
        return Err(format!(
            "NotebookLM MCP requiere Node {}, pero Jintia administra Node {}.",
            node_requirement, version
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::auth::{clear_auth_validation, remember_auth_validation};
    use crate::mcp::client::build_managed_mcp_server_command;
    use crate::mcp::config::{apply_managed_codex_mcp_server, apply_managed_json_mcp_server};
    use crate::models::NotebookLmAuthStatus;
    use serde_json::json;
    use std::fs;

    #[test]
    fn managed_mcp_server_command_uses_exact_node_and_bin() {
        let command = build_managed_mcp_server_command(
            Path::new("managed-node"),
            Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-only-bin"),
        );
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-node"));
        assert_eq!(args, [std::ffi::OsStr::new("managed-mcp-bin.js")]);
    }

    #[test]
    fn managed_mcp_server_command_uses_only_managed_path() {
        let command = build_managed_mcp_server_command(
            Path::new("managed-node"),
            Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-only-bin"),
        );
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH administrado");
        assert_eq!(path, std::ffi::OsStr::new("managed-only-bin"));
        assert!(!path.to_string_lossy().contains("host-only-bin"));
    }

    #[test]
    fn managed_mcp_server_command_removes_node_options() {
        let command = build_managed_mcp_server_command(
            Path::new("managed-node"),
            Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-only-bin"),
        );
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn managed_mcp_server_command_does_not_override_current_dir() {
        let command = build_managed_mcp_server_command(
            Path::new("managed-node"),
            Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-only-bin"),
        );
        assert!(command.get_current_dir().is_none());
    }

    #[test]
    fn managed_mcp_server_command_has_only_public_bin_argument() {
        let command = build_managed_mcp_server_command(
            Path::new("managed-node"),
            Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-only-bin"),
        );
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args.len(), 1);
        assert_eq!(args[0], std::ffi::OsStr::new("managed-mcp-bin.js"));
    }

    #[test]
    fn managed_mcp_json_server_includes_managed_path() {
        let server = managed_mcp_server_json(
            Path::new("managed-node"),
            Path::new("managed-bin.js"),
            "managed-only-bin",
        );
        assert_eq!(server["command"], "managed-node");
        assert_eq!(server["args"], json!(["managed-bin.js"]));
        assert_eq!(server["env"]["PATH"], "managed-only-bin");
    }

    #[test]
    fn managed_json_mcp_server_preserves_existing_environment() {
        let mut server = json!({
            "command": "old-node",
            "args": ["old-bin"],
            "env": {"PATH": "host-only-bin", "KEEP": "yes"},
        });
        let managed = managed_mcp_server_json(
            Path::new("managed-node"),
            Path::new("managed-bin.js"),
            "managed-only-bin",
        );
        apply_managed_json_mcp_server(&mut server, &managed).unwrap();
        assert_eq!(server["command"], "managed-node");
        assert_eq!(server["args"], json!(["managed-bin.js"]));
        assert_eq!(server["env"]["PATH"], "managed-only-bin");
        assert_eq!(server["env"]["KEEP"], "yes");
    }

    #[test]
    fn managed_json_mcp_server_preserves_unmanaged_fields() {
        let mut server = json!({
            "command": "old-node",
            "args": ["old-bin"],
            "env": {"PATH": "old-path"},
            "customField": {"nested": true},
        });
        let managed = managed_mcp_server_json(
            Path::new("managed-node"),
            Path::new("managed-bin.js"),
            "managed-only-bin",
        );
        apply_managed_json_mcp_server(&mut server, &managed).unwrap();
        assert_eq!(server["customField"], json!({"nested": true}));
    }

    #[test]
    fn managed_json_mcp_server_rejects_non_object_server() {
        let mut server = serde_json::Value::String("invalid".to_string());
        let before = server.clone();
        let managed = managed_mcp_server_json(
            Path::new("managed-node"),
            Path::new("managed-bin.js"),
            "managed-only-bin",
        );
        let error = apply_managed_json_mcp_server(&mut server, &managed).unwrap_err();
        assert!(error.contains("mcpServers.notebooklm"));
        assert_eq!(server, before);
    }

    #[test]
    fn managed_json_mcp_server_rejects_non_object_environment() {
        let mut server = json!({
            "command": "old",
            "args": [],
            "env": "invalid",
            "KEEP": "yes",
        });
        let before = server.clone();
        let managed = managed_mcp_server_json(
            Path::new("managed-node"),
            Path::new("managed-bin.js"),
            "managed-only-bin",
        );
        let error = apply_managed_json_mcp_server(&mut server, &managed).unwrap_err();
        assert!(error.contains(".env"));
        assert_eq!(server, before);
    }

    #[test]
    fn managed_json_mcp_server_is_idempotent_with_extra_fields() {
        let mut server = json!({
            "command": "managed-node",
            "args": ["managed-bin.js"],
            "env": {"PATH": "managed-only-bin", "KEEP": "yes"},
            "customField": "keep",
        });
        let managed = managed_mcp_server_json(
            Path::new("managed-node"),
            Path::new("managed-bin.js"),
            "managed-only-bin",
        );
        apply_managed_json_mcp_server(&mut server, &managed).unwrap();
        let first = server.clone();
        apply_managed_json_mcp_server(&mut server, &managed).unwrap();
        assert_eq!(server, first);
    }

    #[test]
    fn managed_node_version_command_uses_exact_managed_node() {
        let command = build_managed_node_version_command(Path::new("managed-node"));
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-node"));
        assert_eq!(args, [std::ffi::OsStr::new("--version")]);
    }

    #[test]
    fn managed_node_version_command_removes_node_options() {
        let command = build_managed_node_version_command(Path::new("managed-node"));
        let value = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("NODE_OPTIONS"))
            .expect("NODE_OPTIONS debe eliminarse explícitamente")
            .1;
        assert!(value.is_none());
    }

    #[test]
    fn managed_node_version_command_has_only_version_argument() {
        let command = build_managed_node_version_command(Path::new("managed-node"));
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args.len(), 1);
        assert_eq!(args[0], std::ffi::OsStr::new("--version"));
    }

    #[test]
    fn managed_server_matcher_requires_exact_node_bin_and_path() {
        let node = Path::new("/managed/node");
        let bin = Path::new("/managed/node_modules/@scope/pkg/bin.js");
        let managed_path = "/managed/bin";
        let valid = serde_json::json!({
            "command": "/managed/node",
            "args": ["/managed/node_modules/@scope/pkg/bin.js"],
            "env": {"PATH": managed_path},
        });
        assert!(server_matches_paths(&valid, node, bin, managed_path));
        let with_extra_env = serde_json::json!({
            "command": "/managed/node",
            "args": ["/managed/node_modules/@scope/pkg/bin.js"],
            "env": {"PATH": managed_path, "OTHER": "preserved"},
        });
        assert!(server_matches_paths(
            &with_extra_env,
            node,
            bin,
            managed_path
        ));
        for server in [
            serde_json::json!({"command": "/other/node", "args": ["/managed/node_modules/@scope/pkg/bin.js"], "env": {"PATH": managed_path}}),
            serde_json::json!({"command": "/managed/node", "args": ["/other/bin"], "env": {"PATH": managed_path}}),
            serde_json::json!({"command": "/managed/node", "args": [], "env": {"PATH": managed_path}}),
            serde_json::json!({"command": "/managed/node", "args": ["/managed/node_modules/@scope/pkg/bin.js", "--extra"], "env": {"PATH": managed_path}}),
            serde_json::json!({"command": "npx", "args": ["@scope/pkg@latest"], "env": {"PATH": managed_path}}),
            serde_json::json!({"command": "/managed/node", "args": ["@scope/pkg"], "env": {"PATH": managed_path}}),
            serde_json::json!({"args": ["/managed/node_modules/@scope/pkg/bin.js"], "env": {"PATH": managed_path}}),
            serde_json::json!({"command": "/managed/node", "args": ["/managed/node_modules/@scope/pkg/bin.js"]}),
            serde_json::json!({"command": "/managed/node", "args": ["/managed/node_modules/@scope/pkg/bin.js"], "env": {}}),
            serde_json::json!({"command": "/managed/node", "args": ["/managed/node_modules/@scope/pkg/bin.js"], "env": {"PATH": "host-only-bin"}}),
            serde_json::json!({"command": "/managed/node", "args": ["/managed/node_modules/@scope/pkg/bin.js"], "env": {"PATH": ""}}),
        ] {
            assert!(!server_matches_paths(&server, node, bin, managed_path));
        }
    }

    #[test]
    fn codex_managed_mcp_server_includes_managed_path() {
        let mut doc = "".parse::<toml_edit::DocumentMut>().unwrap();
        apply_managed_codex_mcp_server(
            &mut doc,
            Path::new("managed-node"),
            Path::new("managed-bin.js"),
            "managed-only-bin",
        )
        .unwrap();
        assert_eq!(
            doc["mcp_servers"]["notebooklm"]["command"].as_str(),
            Some("managed-node")
        );
        assert_eq!(
            doc["mcp_servers"]["notebooklm"]["args"]
                .as_array()
                .unwrap()
                .iter()
                .next()
                .and_then(toml_edit::Value::as_str),
            Some("managed-bin.js")
        );
        assert_eq!(
            doc["mcp_servers"]["notebooklm"]["env"]["PATH"].as_str(),
            Some("managed-only-bin")
        );
    }

    #[test]
    fn codex_managed_mcp_server_preserves_other_environment() {
        let mut doc = "[mcp_servers.notebooklm.env]\nEXISTING = \"keep\"\n"
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        apply_managed_codex_mcp_server(
            &mut doc,
            Path::new("managed-node"),
            Path::new("managed-bin.js"),
            "managed-only-bin",
        )
        .unwrap();
        assert_eq!(
            doc["mcp_servers"]["notebooklm"]["env"]["EXISTING"].as_str(),
            Some("keep")
        );
        assert_eq!(
            doc["mcp_servers"]["notebooklm"]["env"]["PATH"].as_str(),
            Some("managed-only-bin")
        );
    }

    #[test]
    fn codex_managed_mcp_server_rejects_non_table_environment() {
        let mut doc = "[mcp_servers.notebooklm]\nenv = \"invalid\"\n"
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        let error = apply_managed_codex_mcp_server(
            &mut doc,
            Path::new("managed-node"),
            Path::new("managed-bin.js"),
            "managed-only-bin",
        )
        .unwrap_err();
        assert!(error.contains("env"));
        assert_eq!(
            doc["mcp_servers"]["notebooklm"]["env"].as_str(),
            Some("invalid")
        );
    }

    #[test]
    fn codex_managed_mcp_server_replaces_host_path() {
        let mut doc = "[mcp_servers.notebooklm.env]\nPATH = \"host-only-bin\"\n"
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        apply_managed_codex_mcp_server(
            &mut doc,
            Path::new("managed-node"),
            Path::new("managed-bin.js"),
            "managed-only-bin",
        )
        .unwrap();
        assert_eq!(
            doc["mcp_servers"]["notebooklm"]["env"]["PATH"].as_str(),
            Some("managed-only-bin")
        );
        assert!(!doc.to_string().contains("host-only-bin"));
    }

    #[test]
    fn parses_nested_health_payload_from_mcp_text_content() {
        use crate::mcp::client::{find_bool_field, is_tool_error};
        let value = json!({
            "result": {
                "content": [{
                    "type": "text",
                    "text": "{\"success\":true,\"data\":{\"authenticated\":true}}"
                }]
            }
        });
        assert_eq!(find_bool_field(&value, "authenticated"), Some(true));
        assert!(!is_tool_error(&value));
    }

    #[test]
    fn recognizes_nested_tool_failure_and_extracts_message() {
        use crate::mcp::client::{is_tool_error, tool_error_message};
        let value = json!({
            "result": {
                "content": [{
                    "type": "text",
                    "text": "{\"success\":false,\"error\":\"Authentication failed or was cancelled\"}"
                }]
            }
        });
        assert!(is_tool_error(&value));
        assert_eq!(
            tool_error_message(&value),
            "Authentication failed or was cancelled"
        );
    }

    #[test]
    fn byte_search_finds_cookie_names_without_decoding_sqlite() {
        use crate::mcp::auth::contains_bytes;
        let data = b"sqlite-prefix-SAPISID-value-__Secure-1PSID-suffix";
        assert!(contains_bytes(data, b"SAPISID"));
        assert!(!contains_bytes(data, b"APISID3"));
    }

    #[test]
    fn finds_notebooks_array_nested_inside_mcp_text_content() {
        use crate::mcp::client::{find_array_field, is_tool_error};
        let value = json!({
            "result": {
                "content": [{
                    "type": "text",
                    "text": "{\"success\":true,\"data\":{\"notebooks\":[{\"id\":\"n8n-docs\",\"url\":\"https://notebooklm.google.com/notebook/n8n-docs\",\"name\":\"n8n Workflow Automation\",\"description\":\"docs\"}]}}"
                }],
                "isError": false
            }
        });
        let entries = find_array_field(&value, "notebooks").expect("notebooks array");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["id"], "n8n-docs");
        assert!(!is_tool_error(&value));
    }

    #[test]
    fn find_array_field_does_not_match_unrelated_arrays() {
        use crate::mcp::client::find_array_field;
        let value = json!({ "result": { "content": [{ "type": "text", "text": "{}" }] } });
        assert_eq!(find_array_field(&value, "notebooks"), None);
    }

    #[test]
    fn successful_auth_validation_is_reused() {
        let status = NotebookLmAuthStatus {
            authenticated: true,
            message: "verified".to_string(),
        };
        remember_auth_validation(&status);
        let cached = check_auth();
        assert!(cached.authenticated);
        assert!(cached.message.contains("recientemente"));
        clear_auth_validation();
    }

    #[test]
    fn configures_codex_mcp_without_disturbing_unrelated_toml_and_flags_a_stale_duplicate() {
        let dir = std::env::temp_dir().join(format!(
            "jintia-codex-mcp-test-{}",
            crate::paths::timestamp()
        ));
        fs::create_dir_all(&dir).unwrap();
        let previous_codex_home = std::env::var_os("CODEX_HOME");
        std::env::set_var("CODEX_HOME", &dir);

        fs::write(
            dir.join("config.toml"),
            "model = \"gpt-5.6-luna\"\n\n[projects.'D:\\Curso']\ntrust_level = \"trusted\"\n\n[mcp_servers.notebooklm]\ncommand = \"npx\"\nargs = [\"notebooklm-mcp@latest\"]\n\n[mcp_servers.gemini-notebook]\ncommand = \"npx\"\nargs = [\"@charlie.act7/gemini-notebook-mcp@latest\"]\n",
        )
        .unwrap();

        let managed_mcp_installed =
            crate::release::managed_mcp_contract()
                .ok()
                .is_some_and(|contract| {
                    crate::runtimes::portable_notebooklm_mcp_installed_for(&contract)
                });
        if !crate::paths::portable_node_exe().is_file() || !managed_mcp_installed {
            let result = configure_codex_mcp();
            assert!(!result.success);
            assert!(result.message.contains("Node.js administrado"));
            fs::remove_dir_all(&dir).ok();
            match previous_codex_home {
                Some(value) => std::env::set_var("CODEX_HOME", value),
                None => std::env::remove_var("CODEX_HOME"),
            }
            return;
        }

        let result = configure_codex_mcp();
        assert!(result.success, "{}", result.message);
        assert!(result.message.contains("Codex CLI"));
        assert!(
            result.message.contains("mcp_servers.gemini-notebook"),
            "avisa del servidor duplicado bajo otro nombre: {}",
            result.message
        );

        let text = fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(
            text.contains("model = \"gpt-5.6-luna\""),
            "preserva claves ajenas"
        );
        assert!(
            text.contains("[projects.'D:\\Curso']"),
            "preserva otras tablas"
        );
        assert!(text.contains("[mcp_servers.notebooklm]"));
        assert!(!text.contains(&format!("dist/{}", "index.js")));
        assert!(
            text.contains("PATH"),
            "persiste el PATH del runtime administrado"
        );
        assert!(
            !text.contains("notebooklm-mcp@latest"),
            "reemplaza el paquete viejo en notebooklm"
        );
        assert!(
            text.contains("[mcp_servers.gemini-notebook]"),
            "no toca el servidor duplicado, solo avisa"
        );

        let second = configure_codex_mcp();
        assert!(second.success);
        assert!(
            second.message.contains("ya estaba configurado"),
            "es idempotente"
        );

        fs::remove_dir_all(&dir).ok();
        match previous_codex_home {
            Some(value) => std::env::set_var("CODEX_HOME", value),
            None => std::env::remove_var("CODEX_HOME"),
        }
    }

    #[test]
    fn managed_node_versions_match_mcp_requirement() {
        let requirement = VersionReq::parse(">=22.13.0").unwrap();
        for version in ["v22.13.0", "22.14.0", "v23.0.0"] {
            assert!(requirement.matches(&parse_node_version(version).unwrap()));
        }
        assert!(!requirement.matches(&parse_node_version("v22.12.0").unwrap()));
        assert!(parse_node_version("not-a-version").is_err());
        assert!(VersionReq::parse("not-a-range").is_err());
    }
}
