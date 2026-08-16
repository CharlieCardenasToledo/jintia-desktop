use crate::models::ActionResult;
use crate::paths::{
    atomic_write, backup_file, claude_code_config_path, claude_desktop_config_path, path_text,
};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::Mutex;

pub(super) static MCP_CONFIG_OPERATION: Mutex<()> = Mutex::new(());

pub fn apply_managed_json_mcp_server(server: &mut Value, managed: &Value) -> Result<(), String> {
    let Some(server_object) = server.as_object() else {
        return Err(
            "mcpServers.notebooklm existente no es un objeto. Corrígelo antes de continuar."
                .to_string(),
        );
    };
    if server_object
        .get("env")
        .is_some_and(|environment| !environment.is_object())
    {
        return Err(
            "mcpServers.notebooklm.env existente no es un objeto. Corrígelo antes de continuar."
                .to_string(),
        );
    }

    let managed_object = managed.as_object().ok_or_else(|| {
        "La identidad administrada de NotebookLM MCP no es un objeto.".to_string()
    })?;
    let command = managed_object.get("command").cloned().ok_or_else(|| {
        "La identidad administrada de NotebookLM MCP no contiene command.".to_string()
    })?;
    let args = managed_object.get("args").cloned().ok_or_else(|| {
        "La identidad administrada de NotebookLM MCP no contiene args.".to_string()
    })?;
    let managed_path = managed_object
        .get("env")
        .and_then(Value::as_object)
        .and_then(|environment| environment.get("PATH"))
        .cloned()
        .ok_or_else(|| {
            "La identidad administrada de NotebookLM MCP no contiene env.PATH.".to_string()
        })?;

    let server_object = server
        .as_object_mut()
        .expect("server fue validado como objeto antes de mutarlo");
    server_object.insert("command".to_string(), command);
    server_object.insert("args".to_string(), args);
    let environment = server_object
        .entry("env".to_string())
        .or_insert_with(|| json!({}));
    environment
        .as_object_mut()
        .expect("env fue validado como objeto antes de mutarlo")
        .insert("PATH".to_string(), managed_path);
    Ok(())
}

/// Codex CLI no usa `.mcp.json`/`claude_desktop_config.json` (JSON) sino
/// `~/.codex/config.toml` (TOML) — un archivo personal grande (proyectos de
/// confianza, otros servidores MCP, plugins). Se edita con `toml_edit` en vez
/// de un parser TOML "de solo lectura + reescritura" para no reordenar ni
/// perder comentarios de secciones ajenas a `mcp_servers.notebooklm`.
pub fn apply_managed_codex_mcp_server(
    doc: &mut toml_edit::DocumentMut,
    node: &Path,
    bin: &Path,
    managed_path: &str,
) -> Result<(), String> {
    if doc.get("mcp_servers").is_some_and(|item| !item.is_table()) {
        return Err(
            "La clave mcp_servers existente no es una tabla. Corrígela antes de continuar."
                .to_string(),
        );
    }
    if doc.get("mcp_servers").is_none() {
        doc["mcp_servers"] = toml_edit::table();
    }
    if doc["mcp_servers"]
        .get("notebooklm")
        .is_some_and(|item| !item.is_table())
    {
        return Err(
            "mcp_servers.notebooklm existente no es una tabla. Corrígela antes de continuar."
                .to_string(),
        );
    }
    if doc["mcp_servers"].get("notebooklm").is_none() {
        doc["mcp_servers"]["notebooklm"] = toml_edit::table();
    }
    {
        let env = &mut doc["mcp_servers"]["notebooklm"]["env"];
        if env.is_none() {
            *env = toml_edit::table();
        }
        if !env.is_table() {
            return Err("mcp_servers.notebooklm.env existente no es una tabla. Corrígela antes de continuar.".to_string());
        }
    }

    doc["mcp_servers"]["notebooklm"]["command"] =
        toml_edit::value(node.to_string_lossy().into_owned());
    let mut args = toml_edit::Array::new();
    args.push(bin.to_string_lossy().into_owned());
    doc["mcp_servers"]["notebooklm"]["args"] = toml_edit::value(args);
    doc["mcp_servers"]["notebooklm"]["env"]["PATH"] = toml_edit::value(managed_path);
    Ok(())
}

pub fn configure_mcp(target: String) -> ActionResult {
    let _operation = match MCP_CONFIG_OPERATION.lock() {
        Ok(operation) => operation,
        Err(_) => {
            return ActionResult::error("El estado interno de configuración MCP está bloqueado.")
        }
    };
    let managed = match super::managed_mcp() {
        Ok(managed) => managed,
        Err(error) => return ActionResult::error(error),
    };
    let managed_path = match super::managed_node_runtime_path_text() {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    let (path, label) = match target.as_str() {
        "desktop" => match claude_desktop_config_path() {
            Ok(path) => (path, "Claude Desktop"),
            Err(error) => return ActionResult::error(error),
        },
        "claude-code" => match claude_code_config_path() {
            Ok(path) => (path, "Claude Code"),
            Err(error) => return ActionResult::error(error),
        },
        _ => return ActionResult::error("Destino MCP no reconocido."),
    };

    let mut root = if path.exists() {
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) => {
                return ActionResult::error(format!("No se pudo leer {}: {error}", path.display()))
            }
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(object)) => Value::Object(object),
            Ok(_) => {
                return ActionResult::error(format!(
                    "{} no contiene un objeto JSON.",
                    path.display()
                ))
            }
            Err(error) => {
                return ActionResult::error(format!(
                    "La configuración existente no es JSON válido y no fue modificada: {error}"
                ))
            }
        }
    } else {
        json!({})
    };

    if root
        .get("mcpServers")
        .is_some_and(|value| !value.is_object())
    {
        return ActionResult::error(
            "La clave mcpServers existente no es un objeto. Corrígela antes de continuar.",
        );
    }
    if root.get("mcpServers").is_none() {
        root["mcpServers"] = json!({});
    }
    let previous = root.clone();
    let managed_server =
        super::managed_mcp_server_json(&managed.node, &managed.bin, &managed_path);
    let server = root["mcpServers"]
        .as_object_mut()
        .expect("mcpServers fue validado como objeto")
        .entry("notebooklm".to_string())
        .or_insert_with(|| json!({}));
    if let Err(error) = apply_managed_json_mcp_server(server, &managed_server) {
        return ActionResult::error(error);
    }
    if root == previous {
        return ActionResult::ok(format!(
            "NotebookLM MCP ya estaba configurado correctamente para {label}; no se volvió a escribir."
        ))
        .with_path(path_text(&path));
    }

    let bytes = match serde_json::to_vec_pretty(&root) {
        Ok(bytes) => bytes,
        Err(error) => {
            return ActionResult::error(format!("No se pudo serializar la configuración: {error}"))
        }
    };
    let backup = match backup_file(&path) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    if let Err(error) = atomic_write(&path, &bytes) {
        return ActionResult::error(error);
    }

    let result = ActionResult::ok(format!(
        "NotebookLM MCP configurado para {label} en:\n{}\n\nReinicia {label} para aplicar el cambio.",
        path_text(&path)
    ))
    .with_path(path_text(&path));
    if let Some(backup) = backup {
        result.with_backup(path_text(&backup))
    } else {
        result
    }
}

pub fn configure_codex_mcp() -> ActionResult {
    let _operation = match MCP_CONFIG_OPERATION.lock() {
        Ok(operation) => operation,
        Err(_) => {
            return ActionResult::error("El estado interno de configuración MCP está bloqueado.")
        }
    };
    let managed = match super::managed_mcp() {
        Ok(managed) => managed,
        Err(error) => return ActionResult::error(error),
    };
    let managed_path = match super::managed_node_runtime_path_text() {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    let path = match crate::paths::codex_config_path() {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };

    let text = if path.exists() {
        match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) => {
                return ActionResult::error(format!("No se pudo leer {}: {error}", path.display()))
            }
        }
    } else {
        String::new()
    };

    let mut doc = match text.parse::<toml_edit::DocumentMut>() {
        Ok(doc) => doc,
        Err(error) => {
            return ActionResult::error(format!(
                "La configuración existente no es TOML válido y no fue modificada: {error}"
            ))
        }
    };

    if doc.get("mcp_servers").is_some_and(|item| !item.is_table()) {
        return ActionResult::error(
            "La clave mcp_servers existente no es una tabla. Corrígela antes de continuar.",
        );
    }
    if doc.get("mcp_servers").is_none() {
        doc["mcp_servers"] = toml_edit::table();
    }

    // Detecta otros servidores (con cualquier otro nombre) que ya apunten a un
    // paquete de NotebookLM, para avisar de duplicados sin tocarlos.
    let stale_servers: Vec<String> = doc["mcp_servers"]
        .as_table()
        .into_iter()
        .flat_map(|table| table.iter())
        .filter(|(name, _)| *name != "notebooklm")
        .filter_map(|(name, item)| {
            let has_notebook_package = item.get("args")?.as_array()?.iter().any(|value| {
                value.as_str().is_some_and(|text| {
                    text.contains("notebooklm-mcp") || text.contains("gemini-notebook-mcp")
                })
            });
            has_notebook_package.then(|| name.to_string())
        })
        .collect();

    let previous = doc.to_string();
    if doc["mcp_servers"]
        .get("notebooklm")
        .is_some_and(|item| !item.is_table())
    {
        return ActionResult::error(
            "mcp_servers.notebooklm existente no es una tabla. Corrígela antes de continuar.",
        );
    }
    if let Err(error) =
        apply_managed_codex_mcp_server(&mut doc, &managed.node, &managed.bin, &managed_path)
    {
        return ActionResult::error(error);
    }

    let next = doc.to_string();
    if next == previous {
        let mut message =
            "NotebookLM MCP ya estaba configurado correctamente para Codex CLI; no se volvió a escribir.".to_string();
        if !stale_servers.is_empty() {
            message.push_str(&format!(
                "\n\nAviso: mcp_servers.{} también apunta a un paquete de NotebookLM; revísalo manualmente si ya no lo necesitas.",
                stale_servers.join(", mcp_servers.")
            ));
        }
        return ActionResult::ok(message).with_path(path_text(&path));
    }

    let backup = match backup_file(&path) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    if let Err(error) = atomic_write(&path, next.as_bytes()) {
        return ActionResult::error(error);
    }

    let mut message = format!(
        "NotebookLM MCP configurado para Codex CLI en:\n{}\n\nReinicia Codex para aplicar el cambio.",
        path_text(&path)
    );
    if !stale_servers.is_empty() {
        message.push_str(&format!(
            "\n\nAviso: mcp_servers.{} también apunta a un paquete de NotebookLM; revísalo manualmente si ya no lo necesitas.",
            stale_servers.join(", mcp_servers.")
        ));
    }
    let result = ActionResult::ok(message).with_path(path_text(&path));
    if let Some(backup) = backup {
        result.with_backup(path_text(&backup))
    } else {
        result
    }
}
