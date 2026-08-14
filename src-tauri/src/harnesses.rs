use crate::engine;
use serde_json::Value;
use std::path::Path;

/// Detecta proveedores IA instalados en el sistema vía la Skill CLI.
///
/// La Skill es la autoridad sobre qué proveedores existen y dónde.
/// Si `explicit` no está vacío, solo detecta esos proveedores específicos.
///
/// # Ejemplo
/// ```ignore
/// let result = detect("/path/to/project".to_string(), None);
/// // Devuelve JSON con lista de proveedores detectados
/// ```
fn detection_payload(report: &Value) -> Result<Value, String> {
    if report.get("status").and_then(Value::as_str) != Some("success") {
        return Err("Jintia detect devolvió un estado distinto de success.".to_string());
    }

    let data = report
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| "Jintia detect no devolvió un objeto data.".to_string())?;

    if data
        .get("schemaVersion")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err("Jintia detect devolvió data sin schemaVersion válido.".to_string());
    }
    if data.get("projectRoot").and_then(Value::as_str).is_none() {
        return Err("Jintia detect devolvió data sin projectRoot válido.".to_string());
    }
    if !data.get("providers").is_some_and(Value::is_array) {
        return Err("Jintia detect devolvió data sin providers válido.".to_string());
    }

    Ok(Value::Object(data.clone()))
}

pub fn detect(project_path: String, explicit: Option<Vec<String>>) -> Result<Value, String> {
    let mut args: Vec<String> = vec![
        "detect".to_string(),
        project_path.clone(),
        "--json".to_string(),
    ];

    if let Some(ref providers) = explicit {
        if !providers.is_empty() {
            args.push(format!("--providers={}", providers.join(",")));
        }
    }

    let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let Some(skill_path) = crate::runtimes::resolve_skill() else {
        return Err("Jintia administrado no está disponible. Instálalo o actualízalo desde Configuración > Entorno.".to_string());
    };

    let report = engine::run_jintia_json::<Value>(Path::new(&skill_path), &args_refs)?;
    detection_payload(&report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_payload_returns_data_unchanged() {
        let report = serde_json::json!({
            "status": "success",
            "data": {
                "schemaVersion": "1.1.0",
                "projectRoot": "/tmp/course",
                "source": "matrix",
                "providers": [{"id": "claude", "name": "Claude Code", "status": "installed"}]
            }
        });
        let data = detection_payload(&report).unwrap();
        assert_eq!(data, report["data"]);
    }

    #[test]
    fn detection_payload_rejects_invalid_reports() {
        let valid_data = serde_json::json!({
            "schemaVersion": "1.1.0",
            "projectRoot": "/tmp/course",
            "providers": []
        });
        let cases = [
            serde_json::json!({"status": "success"}),
            serde_json::json!({"status": "success", "data": null}),
            serde_json::json!({"status": "success", "data": {"schemaVersion": "1.1.0", "projectRoot": "/tmp"}}),
            serde_json::json!({"status": "success", "data": {"schemaVersion": "1.1.0", "projectRoot": "/tmp", "providers": {}}}),
            serde_json::json!({"status": "success", "data": {"schemaVersion": "", "projectRoot": "/tmp", "providers": []}}),
            serde_json::json!({"status": "success", "data": {"projectRoot": "/tmp/course", "providers": []}}),
            serde_json::json!({"status": "success", "data": {"schemaVersion": "1.1.0", "providers": []}}),
            serde_json::json!({"status": "success", "data": {"schemaVersion": "1.1.0", "projectRoot": 123, "providers": []}}),
            serde_json::json!({"status": "failed", "data": valid_data}),
        ];
        for report in cases {
            assert!(
                detection_payload(&report).is_err(),
                "accepted invalid report: {report}"
            );
        }
    }
}
