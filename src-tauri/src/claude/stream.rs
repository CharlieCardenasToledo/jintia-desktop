//! Parser puro (sin I/O) del NDJSON que produce
//! `claude -p ... --output-format stream-json --verbose --include-partial-messages`.
//!
//! Las formas de `system/init`, `stream_event` → `text_delta` y `result`
//! están confirmadas contra una ejecución real (`claude` CLI 2.1.229,
//! 2026-08-19, ver `tests::real_transcript_lines_are_classified_correctly`).
//! Esa transcripción real reveló tipos de línea no documentados en
//! cli-reference.md/headless.md que este parser debe ignorar sin romperse:
//! `system/hook_started`, `system/hook_progress`, `system/hook_response`,
//! `system/status`, y el evento de nivel superior `rate_limit_event`. El
//! diseño (mirar solo `event.delta.type == "text_delta"` dentro de
//! `stream_event`, en vez de enumerar cada `event.type` posible como
//! `message_start`/`content_block_start`/`content_block_stop`/
//! `message_delta`/`message_stop`) los deja caer todos en el caso ignorado
//! por construcción. El formato exacto de `result` en caso de ERROR (en vez
//! de éxito) sigue sin confirmarse contra una ejecución real; se mantiene la
//! extrapolación basada en la documentación oficial hasta poder capturar uno.

use crate::claude::models::ClaudeEvent;
use serde_json::Value;

/// Evento ya clasificado a partir de una línea NDJSON, todavía sin
/// `request_id` (que no viene en el protocolo de Claude: lo inyecta
/// `mod.rs`, que es quien sabe a qué turno corresponde este proceso).
#[derive(Debug, Clone, PartialEq)]
pub enum RawEvent {
    SystemInit { session_id: String, model: Option<String> },
    SystemApiRetry,
    TextDelta { text: String },
    ResultSuccess { session_id: Option<String>, result: Option<String> },
    ResultError { session_id: Option<String>, message: String },
}

impl RawEvent {
    pub fn event_kind(&self) -> &'static str {
        match self {
            Self::SystemInit { .. } => "system/init",
            Self::SystemApiRetry => "system/api_retry",
            Self::TextDelta { .. } => "stream_event/text_delta",
            Self::ResultSuccess { .. } => "result/success",
            Self::ResultError { .. } => "result/error",
        }
    }
}

/// Clasifica una línea NDJSON. `Ok(None)` significa "JSON válido pero de un
/// tipo que Ask Jintia no necesita mostrar" (p. ej. los mensajes completos
/// `assistant`/`user`, o eventos `stream_event` que no son `text_delta`).
/// `Err` significa que la línea no es JSON válido.
pub fn classify_line(line: &str) -> Result<Option<RawEvent>, String> {
    let msg: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    let msg_type = msg.get("type").and_then(Value::as_str).unwrap_or("");

    let event = match msg_type {
        "system" => match msg.get("subtype").and_then(Value::as_str) {
            Some("init") => {
                let session_id = msg
                    .get("session_id")
                    .and_then(Value::as_str)
                    .ok_or("system/init sin session_id")?
                    .to_string();
                let model = msg.get("model").and_then(Value::as_str).map(str::to_string);
                Some(RawEvent::SystemInit { session_id, model })
            }
            Some("api_retry") => Some(RawEvent::SystemApiRetry),
            _ => None,
        },
        "stream_event" => {
            let delta = msg.get("event").and_then(|e| e.get("delta"));
            let is_text_delta = delta
                .and_then(|d| d.get("type"))
                .and_then(Value::as_str)
                == Some("text_delta");
            if is_text_delta {
                let text = delta
                    .and_then(|d| d.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                Some(RawEvent::TextDelta { text })
            } else {
                None
            }
        }
        "result" => {
            let session_id = msg.get("session_id").and_then(Value::as_str).map(str::to_string);
            match msg.get("subtype").and_then(Value::as_str) {
                Some("success") => {
                    let result = msg.get("result").and_then(Value::as_str).map(str::to_string);
                    Some(RawEvent::ResultSuccess { session_id, result })
                }
                _ => {
                    let message = msg
                        .get("error")
                        .and_then(Value::as_str)
                        .or_else(|| msg.get("result").and_then(Value::as_str))
                        .unwrap_or("Claude Code terminó con error")
                        .to_string();
                    Some(RawEvent::ResultError { session_id, message })
                }
            }
        }
        _ => None,
    };

    Ok(event)
}

/// Convierte un `RawEvent` en el `ClaudeEvent` público que se emite como
/// evento Tauri, propagando el `session_id` conocido hacia adelante:
/// `system/init` es la única línea que lo declara, así que las líneas
/// posteriores (deltas, retries) heredan el que ya se vio en este turno.
pub fn to_claude_event(
    raw: RawEvent,
    request_id: &str,
    session_id: &mut Option<String>,
) -> ClaudeEvent {
    match raw {
        RawEvent::SystemInit { session_id: sid, model } => {
            *session_id = Some(sid.clone());
            ClaudeEvent::SessionStarted { request_id: request_id.to_string(), session_id: sid, model }
        }
        RawEvent::SystemApiRetry => ClaudeEvent::ApiRetry {
            request_id: request_id.to_string(),
            session_id: session_id.clone(),
        },
        RawEvent::TextDelta { text } => ClaudeEvent::TextDelta {
            request_id: request_id.to_string(),
            session_id: session_id.clone(),
            text,
        },
        RawEvent::ResultSuccess { session_id: sid, result } => {
            if sid.is_some() {
                *session_id = sid.clone();
            }
            ClaudeEvent::TurnCompleted {
                request_id: request_id.to_string(),
                session_id: session_id.clone(),
                success: true,
                result,
            }
        }
        RawEvent::ResultError { session_id: sid, message } => {
            if sid.is_some() {
                *session_id = sid.clone();
            }
            ClaudeEvent::Error {
                request_id: request_id.to_string(),
                session_id: session_id.clone(),
                message,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_system_init_and_extracts_session_id() {
        let line = r#"{"type":"system","subtype":"init","session_id":"abc-123","model":"claude-sonnet-4-5","tools":["Read","Bash"]}"#;
        assert_eq!(
            classify_line(line).unwrap(),
            Some(RawEvent::SystemInit {
                session_id: "abc-123".to_string(),
                model: Some("claude-sonnet-4-5".to_string()),
            })
        );
    }

    #[test]
    fn classifies_api_retry() {
        let line = r#"{"type":"system","subtype":"api_retry","attempt":1,"max_retries":3,"retry_delay_ms":1000,"error_status":529}"#;
        assert_eq!(classify_line(line).unwrap(), Some(RawEvent::SystemApiRetry));
    }

    #[test]
    fn classifies_text_delta_from_stream_event() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hola"}}}"#;
        assert_eq!(
            classify_line(line).unwrap(),
            Some(RawEvent::TextDelta { text: "Hola".to_string() })
        );
    }

    #[test]
    fn ignores_stream_event_that_is_not_text_delta() {
        // p. ej. content_block_start / message_stop: no aportan texto que mostrar.
        let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#;
        assert_eq!(classify_line(line).unwrap(), None);
    }

    #[test]
    fn ignores_full_assistant_message() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hola"}]},"session_id":"abc-123"}"#;
        assert_eq!(classify_line(line).unwrap(), None);
    }

    #[test]
    fn classifies_result_success() {
        let line = r#"{"type":"result","subtype":"success","session_id":"abc-123","result":"Respuesta final"}"#;
        assert_eq!(
            classify_line(line).unwrap(),
            Some(RawEvent::ResultSuccess {
                session_id: Some("abc-123".to_string()),
                result: Some("Respuesta final".to_string()),
            })
        );
    }

    #[test]
    fn classifies_result_error_subtype_as_error() {
        let line = r#"{"type":"result","subtype":"error_during_execution","session_id":"abc-123","error":"algo falló"}"#;
        assert_eq!(
            classify_line(line).unwrap(),
            Some(RawEvent::ResultError {
                session_id: Some("abc-123".to_string()),
                message: "algo falló".to_string(),
            })
        );
    }

    #[test]
    fn invalid_json_is_an_error_not_a_panic() {
        assert!(classify_line("esto no es json").is_err());
    }

    #[test]
    fn session_id_propagates_forward_from_init_to_later_deltas() {
        let mut session_id: Option<String> = None;

        let init = classify_line(
            r#"{"type":"system","subtype":"init","session_id":"abc-123","model":"claude-sonnet-4-5"}"#,
        )
        .unwrap()
        .unwrap();
        let event = to_claude_event(init, "req-1", &mut session_id);
        assert_eq!(
            event,
            ClaudeEvent::SessionStarted {
                request_id: "req-1".to_string(),
                session_id: "abc-123".to_string(),
                model: Some("claude-sonnet-4-5".to_string()),
            }
        );
        assert_eq!(session_id, Some("abc-123".to_string()));

        let delta = classify_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hola"}}}"#,
        )
        .unwrap()
        .unwrap();
        let event = to_claude_event(delta, "req-1", &mut session_id);
        assert_eq!(
            event,
            ClaudeEvent::TextDelta {
                request_id: "req-1".to_string(),
                session_id: Some("abc-123".to_string()),
                text: "Hola".to_string(),
            }
        );
    }

    #[test]
    fn real_transcript_lines_are_classified_correctly() {
        // Transcripción real (recortada de campos irrelevantes como la lista
        // completa de tools/plugins/skills, que no afectan el parseo) de
        // `claude -p "Responde solo con la palabra: prueba" --output-format
        // stream-json --verbose --include-partial-messages` contra CLI 2.1.229.
        let lines: &[(&str, Option<RawEvent>)] = &[
            (
                r#"{"type":"system","subtype":"hook_started","hook_id":"h1","hook_name":"SessionStart:startup","hook_event":"SessionStart","session_id":"s1"}"#,
                None,
            ),
            (
                r#"{"type":"system","subtype":"hook_progress","hook_id":"h1","stdout":"","session_id":"s1"}"#,
                None,
            ),
            (
                r#"{"type":"system","subtype":"hook_response","hook_id":"h1","exit_code":0,"outcome":"success","session_id":"s1"}"#,
                None,
            ),
            (
                r#"{"type":"system","subtype":"init","cwd":"C:\\curso","session_id":"s1","tools":["Read","Bash"],"model":"claude-sonnet-5","permissionMode":"default"}"#,
                Some(RawEvent::SystemInit {
                    session_id: "s1".to_string(),
                    model: Some("claude-sonnet-5".to_string()),
                }),
            ),
            (
                r#"{"type":"system","subtype":"status","status":"requesting","session_id":"s1"}"#,
                None,
            ),
            (
                r#"{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-sonnet-5","role":"assistant","content":[]}},"session_id":"s1"}"#,
                None,
            ),
            (
                r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"s1"}"#,
                None,
            ),
            (
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pr"}},"session_id":"s1"}"#,
                Some(RawEvent::TextDelta { text: "pr".to_string() }),
            ),
            (
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ueba"}},"session_id":"s1"}"#,
                Some(RawEvent::TextDelta { text: "ueba".to_string() }),
            ),
            (
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"prueba"}]},"session_id":"s1"}"#,
                None,
            ),
            (
                r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"s1"}"#,
                None,
            ),
            (
                r#"{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"}},"session_id":"s1"}"#,
                None,
            ),
            (
                r#"{"type":"stream_event","event":{"type":"message_stop"},"session_id":"s1"}"#,
                None,
            ),
            (
                r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"s1"}"#,
                None,
            ),
            (
                r#"{"is_error":false,"num_turns":1,"stop_reason":"end_turn","session_id":"s1","subtype":"success","type":"result","result":"prueba"}"#,
                Some(RawEvent::ResultSuccess {
                    session_id: Some("s1".to_string()),
                    result: Some("prueba".to_string()),
                }),
            ),
        ];

        for (line, expected) in lines {
            assert_eq!(classify_line(line).unwrap(), *expected, "línea: {line}");
        }
    }

    #[test]
    fn resume_turn_without_init_line_keeps_session_id_carried_over_from_the_request() {
        // Al reanudar con --resume, algunas versiones del CLI podrían no repetir
        // system/init con el mismo session_id. `mod.rs` inicializa `session_id`
        // con el valor de la petición antes de leer nada, así que un delta debe
        // heredarlo aunque nunca llegue un system/init en este turno.
        let mut session_id: Option<String> = Some("abc-123".to_string());

        let delta = classify_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Continuando"}}}"#,
        )
        .unwrap()
        .unwrap();
        let event = to_claude_event(delta, "req-2", &mut session_id);
        assert_eq!(
            event,
            ClaudeEvent::TextDelta {
                request_id: "req-2".to_string(),
                session_id: Some("abc-123".to_string()),
                text: "Continuando".to_string(),
            }
        );
    }
}
