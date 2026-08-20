//! Tipos del contrato Claude ↔ Tauri. Separados de `mod.rs` para no repetir
//! el error de `codex/mod.rs`, que mezcló tipos, proceso y comandos en un
//! solo archivo de ~30 KB.

use serde::{Deserialize, Serialize};

/// Estado combinado de instalación/autenticación del CLI `claude`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub version: Option<String>,
    /// `true` si `ANTHROPIC_API_KEY` está presente en el entorno. Cuando lo
    /// está, el CLI la prioriza sobre la sesión OAuth de la suscripción, así
    /// que Jintia debe advertir en vez de asumir que se está usando el plan.
    pub using_api_key: bool,
    /// Salida cruda (ya parseada) de `claude auth status`, confirmada contra
    /// una instalación real: `{ loggedIn, authMethod, apiProvider, email,
    /// orgId, orgName, subscriptionType }`. No incluye ningún token; Jintia
    /// nunca lee ni almacena credenciales, solo este resumen de cuenta.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<serde_json::Value>,
}

/// Petición de turno que llega desde el frontend vía `invoke("claude_submit_turn", { request })`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeTurnRequest {
    pub request_id: String,
    pub session_id: Option<String>,
    pub cwd: String,
    pub message: String,
    pub model: Option<String>,
    /// Contexto adicional (curso/semana) inyectado como `--append-system-prompt`.
    pub context: Option<String>,
}

/// Eventos normalizados que `stream.rs` produce a partir del NDJSON real del
/// CLI, y que `mod.rs` emite como eventos Tauri `claude:*`. El frontend nunca
/// ve el protocolo interno de Claude, solo esta forma estable.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClaudeEvent {
    SessionStarted {
        request_id: String,
        session_id: String,
        model: Option<String>,
    },
    TextDelta {
        request_id: String,
        session_id: Option<String>,
        text: String,
    },
    ApiRetry {
        request_id: String,
        session_id: Option<String>,
    },
    TurnCompleted {
        request_id: String,
        session_id: Option<String>,
        success: bool,
        result: Option<String>,
    },
    Error {
        request_id: String,
        session_id: Option<String>,
        message: String,
    },
}

impl ClaudeEvent {
    /// Nombre de evento Tauri correspondiente (`claude:session/started`, etc.),
    /// usado por `mod.rs` al emitir. Centralizado aquí para que un cambio en
    /// el mapeo no obligue a tocar el emisor.
    pub fn event_name(&self) -> &'static str {
        match self {
            ClaudeEvent::SessionStarted { .. } => "claude:session/started",
            ClaudeEvent::TextDelta { .. } => "claude:message/delta",
            ClaudeEvent::ApiRetry { .. } => "claude:system/api_retry",
            ClaudeEvent::TurnCompleted { .. } => "claude:turn/completed",
            ClaudeEvent::Error { .. } => "claude:error",
        }
    }
}

#[cfg(test)]
mod serde_shape_tests {
    use super::*;

    // `rename_all` en un enum sólo camelCasea el nombre de la variante (el
    // tag "type"); los campos de cada variante necesitan además
    // `rename_all_fields` para no quedarse en snake_case y romper el
    // contrato con el frontend, que espera camelCase en todo lo demás
    // (ClaudeStatus, ClaudeTurnRequest). Confirmado experimentalmente antes
    // de escribir claudeRuntime.js contra este contrato.
    #[test]
    fn session_started_serializes_fields_in_camel_case() {
        let event = ClaudeEvent::SessionStarted {
            request_id: "r1".to_string(),
            session_id: "s1".to_string(),
            model: Some("sonnet".to_string()),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "sessionStarted");
        assert_eq!(json["requestId"], "r1");
        assert_eq!(json["sessionId"], "s1");
        assert_eq!(json["model"], "sonnet");
    }

    #[test]
    fn text_delta_serializes_fields_in_camel_case() {
        let event = ClaudeEvent::TextDelta {
            request_id: "r1".to_string(),
            session_id: Some("s1".to_string()),
            text: "Hola".to_string(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "textDelta");
        assert_eq!(json["requestId"], "r1");
        assert_eq!(json["sessionId"], "s1");
        assert_eq!(json["text"], "Hola");
    }

    #[test]
    fn turn_completed_serializes_fields_in_camel_case() {
        let event = ClaudeEvent::TurnCompleted {
            request_id: "r1".to_string(),
            session_id: Some("s1".to_string()),
            success: true,
            result: Some("listo".to_string()),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "turnCompleted");
        assert_eq!(json["requestId"], "r1");
        assert_eq!(json["sessionId"], "s1");
        assert_eq!(json["success"], true);
        assert_eq!(json["result"], "listo");
    }
}
