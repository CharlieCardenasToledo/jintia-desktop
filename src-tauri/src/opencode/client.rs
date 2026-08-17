use super::models::*;
use std::time::Duration;

pub struct OpenCodeClient {
    base: String,
    client: reqwest::blocking::Client,
}

impl OpenCodeClient {
    pub fn new(port: u16) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        Self {
            base: format!("http://127.0.0.1:{}", port),
            client,
        }
    }

    pub fn health(&self) -> Result<OcHealthResponse, String> {
        self.client
            .get(format!("{}/global/health", self.base))
            .send()
            .map_err(|e| e.to_string())?
            .json::<OcHealthResponse>()
            .map_err(|e| e.to_string())
    }

    pub fn create_session(&self, title: &str) -> Result<OcSession, String> {
        let body = serde_json::json!({ "title": title });
        self.client
            .post(format!("{}/session", self.base))
            .json(&body)
            .send()
            .map_err(|e| e.to_string())?
            .json::<OcSession>()
            .map_err(|e| e.to_string())
    }

    pub fn send_prompt(&self, session_id: &str, text: &str) -> Result<(), String> {
        let body = serde_json::json!({
            "sessionID": session_id,
            "text": text,
            "attachments": []
        });
        self.client
            .post(format!("{}/session/{}/prompt_async", self.base, session_id))
            .json(&body)
            .send()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_messages(&self, session_id: &str) -> Result<Vec<OcMessage>, String> {
        self.client
            .get(format!("{}/session/{}/message", self.base, session_id))
            .send()
            .map_err(|e| e.to_string())?
            .json::<Vec<OcMessage>>()
            .map_err(|e| e.to_string())
    }

    pub fn abort_session(&self, session_id: &str) -> Result<(), String> {
        self.client
            .post(format!("{}/session/{}/abort", self.base, session_id))
            .send()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
