use crate::engine;
use serde_json::{json, Value};
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
pub fn detect(project_path: String, explicit: Option<Vec<String>>) -> Value {
    let mut args: Vec<String> = vec!["detect".to_string(), project_path.clone(), "--json".to_string()];

    if let Some(ref providers) = explicit {
        if !providers.is_empty() {
            args.push(format!("--providers={}", providers.join(",")));
        }
    }

    let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let Some(skill_path) = crate::runtimes::resolve_skill() else {
        return fallback_detect(&project_path, explicit);
    };

    match engine::run_jintia(Path::new(&skill_path), &args_refs) {
        Ok(result) => {
            if result.success {
                serde_json::from_str(&result.stdout)
                    .unwrap_or_else(|_| fallback_detect(&project_path, explicit))
            } else {
                fallback_detect(&project_path, explicit)
            }
        }
        Err(_) => fallback_detect(&project_path, explicit),
    }
}

/// Fallback: detección local cuando la Skill no está disponible o falla.
/// Devuelve una estructura mínima que el frontend pueda entender.
fn fallback_detect(project_path: &str, explicit: Option<Vec<String>>) -> Value {
    let project = std::path::PathBuf::from(project_path.trim());

    // Proveedores conocidos con directorios por defecto
    let default_providers = vec![
        ("claude", "Claude Code", ".claude", true),
        ("codex", "Codex CLI", ".agents", true),
        ("cursor", "Cursor", ".cursor", true),
        ("gemini", "Gemini CLI", ".gemini", false),
        ("copilot", "GitHub Copilot", ".github", true),
        ("grok", "Grok Build", ".grok", false),
        ("kiro", "Kiro", ".kiro", false),
        ("opencode", "OpenCode", ".opencode", false),
        ("pi", "Project Indigo", ".pi", false),
        ("qoder", "Qoder", ".qoder", false),
        ("trae", "Trae", ".trae", false),
        ("rovodev", "Rovo Dev", ".rovodev", false),
        ("vibe", "Mistral Vibe", ".vibe", false),
    ];

    let mut detections = Vec::new();

    for (id, name, dir, supports_hooks) in default_providers {
        let provider_path = project.join(dir);
        if explicit.is_none() && provider_path.is_dir() {
            detections.push(json!({
                "id": id,
                "name": name,
                "scope": "project",
                "foundPath": provider_path.to_string_lossy().to_string(),
                "installed": false,
                "status": "detected",
                "supportsHooks": supports_hooks,
            }));
        } else if let Some(ref providers) = explicit {
            if providers.contains(&id.to_string()) {
                detections.push(json!({
                    "id": id,
                    "name": name,
                    "scope": "project",
                    "foundPath": if provider_path.is_dir() { Some(provider_path.to_string_lossy().to_string()) } else { None },
                    "installed": false,
                    "status": if provider_path.is_dir() { "detected" } else { "not-detected" },
                    "supportsHooks": supports_hooks,
                }));
            }
        }
    }

    // Si no se detectó nada, al menos ofrecer Claude y Codex
    if detections.is_empty() {
        detections.push(json!({
            "id": "claude",
            "name": "Claude Code",
            "scope": "project",
            "foundPath": Value::Null,
            "installed": false,
            "status": "not-detected",
            "supportsHooks": true,
        }));
        detections.push(json!({
            "id": "codex",
            "name": "Codex CLI",
            "scope": "project",
            "foundPath": Value::Null,
            "installed": false,
            "status": "not-detected",
            "supportsHooks": true,
        }));
    }

    json!({
        "schemaVersion": "1.0.0",
        "projectRoot": project.to_string_lossy().to_string(),
        "providers": detections,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_returns_valid_json() {
        let result = fallback_detect("/tmp/test", None);
        assert!(result["schemaVersion"].is_string());
        assert!(result["providers"].is_array());
    }

    #[test]
    fn fallback_includes_default_providers() {
        let result = fallback_detect("/tmp/test", None);
        let providers = result["providers"].as_array().unwrap();
        // Si no hay directorios, debe al menos devolver claude y codex
        assert!(providers.len() >= 2);
    }
}
