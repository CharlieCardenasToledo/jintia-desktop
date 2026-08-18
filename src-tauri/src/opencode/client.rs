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

    /// `model`: (providerID, modelID) opcional para sobreescribir el modelo por defecto.
    pub fn send_prompt(
        &self,
        session_id: &str,
        text: &str,
        model: Option<(&str, &str)>,
    ) -> Result<(), String> {
        let mut body = serde_json::json!({
            "parts": [{ "type": "text", "text": text }]
        });
        if let Some((provider_id, model_id)) = model {
            body["model"] = serde_json::json!({
                "providerID": provider_id,
                "modelID": model_id
            });
        }
        self.client
            .post(format!("{}/session/{}/prompt_async", self.base, session_id))
            .json(&body)
            .send()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Devuelve la lista de modelos activos con soporte de herramientas.
    pub fn list_models(&self) -> Result<Vec<super::models::OcModelEntry>, String> {
        let resp = self
            .client
            .get(format!("{}/api/model", self.base))
            .send()
            .map_err(|e| e.to_string())?
            .json::<super::models::OcModelList>()
            .map_err(|e| e.to_string())?;

        let active: Vec<_> = resp
            .data
            .into_iter()
            .filter(|m| {
                m.enabled.unwrap_or(true)
                    && m.status.as_deref() == Some("active")
                    && m.capabilities.as_ref().and_then(|c| c.tools).unwrap_or(false)
            })
            .collect();
        Ok(active)
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
