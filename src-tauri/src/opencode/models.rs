use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeInfo {
    pub course_path: String,
    pub port: u16,
    pub status: RuntimeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStatus {
    Starting,
    Ready,
    Offline,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub course_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcHealthResponse {
    pub healthy: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcSession {
    pub id: String,
    pub title: Option<String>,
    pub directory: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcMessagePart {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: Option<String>,
}

// Metadatos del mensaje (campo "info" en la respuesta de OpenCode)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcMessageInfo {
    pub id: Option<String>,
    pub role: Option<String>,
}

// Estructura real de GET /session/:id/message en OpenCode ≥1.18
// { "info": { "role": "user"|"assistant", ... }, "parts": [...] }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcMessage {
    pub info: Option<OcMessageInfo>,
    pub parts: Option<Vec<OcMessagePart>>,
}
