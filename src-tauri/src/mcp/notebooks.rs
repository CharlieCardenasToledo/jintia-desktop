use crate::mcp::client::{call_tool, find_array_field, find_string_field, is_tool_error, tool_error_message};
use crate::models::NotebookLmEntry;
use serde_json::{json, Value};
use std::time::Duration;

fn parse_notebook_entries(value: &Value) -> Vec<NotebookLmEntry> {
    find_array_field(value, "notebooks")
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let id = find_string_field(entry, "id")?;
            if id.is_empty() {
                return None;
            }
            let url = find_string_field(entry, "url")
                .filter(|url| !url.is_empty())
                .unwrap_or_else(|| format!("https://notebook.google.com/notebook/{id}"));
            let name = find_string_field(entry, "name")
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| id.clone());
            let description = find_string_field(entry, "description").unwrap_or_default();
            Some(NotebookLmEntry {
                id,
                name,
                url,
                description,
            })
        })
        .collect()
}

pub fn list_notebooks() -> Result<Vec<NotebookLmEntry>, String> {
    let value = call_tool("list_notebooks", json!({}), Duration::from_secs(30))?;
    if is_tool_error(&value) {
        return Err(tool_error_message(&value));
    }
    Ok(parse_notebook_entries(&value))
}

/// A diferencia de `list_notebooks` (biblioteca local curada), esta consulta
/// el grid real de notebooks.google.com abriendo cada tarjeta para leer su id
/// desde la URL — por eso el timeout es mucho más generoso.
pub fn list_account_notebooks() -> Result<Vec<NotebookLmEntry>, String> {
    let value = call_tool(
        "list_account_notebooks",
        json!({}),
        Duration::from_secs(300),
    )?;
    if is_tool_error(&value) {
        return Err(tool_error_message(&value));
    }
    Ok(parse_notebook_entries(&value))
}
