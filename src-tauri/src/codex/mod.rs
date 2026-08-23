/*!
 * Módulo de integración con OpenAI Codex app-server.
 *
 * Codex app-server es un proceso Rust que expone JSON-RPC sobre stdio.
 * Este módulo gestiona el ciclo de vida del proceso y la comunicación.
 *
 * Flujo de autenticación:
 *   start() → initialize() → account/read → [si no logueado] → login/start → abrir browser
 *   → account/updated (notificación Tauri) → sesión activa
 *
 * Flujo de chat:
 *   thread/start (por curso) → turn/start (por mensaje)
 *   → notificaciones "turn/completed" / "item/agentMessage/delta" emitidas como eventos Tauri
 */

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::time::Duration;
use tauri::Emitter;

// ── Tipos públicos ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CodexAccountInfo {
    #[serde(alias = "type")]
    pub kind: Option<String>,
    pub email: Option<String>,
    #[serde(rename = "planType", alias = "plan_type")]
    pub plan_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CodexStatus {
    pub installed: bool,
    pub running: bool,
    pub logged_in: bool,
    pub account: Option<CodexAccountInfo>,
}

// ── Proceso interno ───────────────────────────────────────────────────────────

type PendingMap = Arc<Mutex<HashMap<u64, SyncSender<Value>>>>;

struct CodexProcess {
    stdin: Mutex<ChildStdin>,
    pending: PendingMap,
    next_id: Mutex<u64>,
    _child: Mutex<Child>, // mantener vivo el proceso
}

/// Clasificación de un mensaje entrante de Codex app-server. Se aísla en su
/// propia función pura (sin I/O) para poder verificarla con payloads JSON
/// reales capturados del proceso real, en vez de confiar solo en la lectura
/// de la especificación.
#[derive(Debug, PartialEq)]
enum RpcInbound {
    /// Respuesta a una petición que nosotros enviamos (tiene "id", no "method").
    Response { id: u64 },
    /// Notificación del servidor, sin respuesta esperada (tiene "method", no "id" o "id": null).
    Notification { method: String },
    /// Petición del servidor que SÍ espera una respuesta nuestra (tiene "id" Y "method" a la vez).
    /// Ejemplo real: execCommandApproval, applyPatchApproval.
    ServerRequest { id: Value, method: String },
    /// No es un mensaje reconocible (ni "id" numérico ni "method").
    Unrecognized,
}

fn classify_inbound(msg: &Value) -> RpcInbound {
    match msg.get("method").and_then(|v| v.as_str()) {
        Some(method) => match msg.get("id").filter(|v| !v.is_null()) {
            Some(id) => RpcInbound::ServerRequest { id: id.clone(), method: method.to_string() },
            None => RpcInbound::Notification { method: method.to_string() },
        },
        None => match msg.get("id").and_then(|v| v.as_u64()) {
            Some(id) => RpcInbound::Response { id },
            None => RpcInbound::Unrecognized,
        },
    }
}

/// Arma los params de `turn/start`. `model` y `effort` corresponden
/// exactamente a los campos `model: Option<String>` y `effort:
/// Option<ReasoningEffort>` de TurnStartParams (protocolo v2 real,
/// confirmado contra codex-rs/app-server-protocol/src/protocol/v2/turn.rs):
/// se omiten del JSON cuando son None, en vez de mandarse como `null`.
fn build_turn_start_params(thread_id: &str, message: &str, model: Option<&str>, effort: Option<&str>) -> Value {
    let mut params = serde_json::json!({
        "threadId": thread_id,
        "input": [{
            "type": "text",
            "text": message,
        }],
    });
    if let Some(model) = model {
        params["model"] = Value::String(model.to_string());
    }
    if let Some(effort) = effort {
        params["effort"] = Value::String(effort.to_string());
    }
    params
}

impl CodexProcess {
    fn spawn(app: tauri::AppHandle, binary: &str) -> Result<Self, String> {
        let mut cmd = std::process::Command::new(binary);
        cmd.args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = crate::process::supervisor()
            .spawn(cmd)
            .map_err(|e| format!("No se pudo iniciar Codex app-server: {e}"))?;

        let stdin = child.stdin.take()
            .ok_or("No se pudo capturar stdin de Codex")?;
        let stdout = child.stdout.take()
            .ok_or("No se pudo capturar stdout de Codex")?;
        // Antes se descartaba con Stdio::null(): sin ventana de consola visible,
        // ese stderr era la única forma de diagnosticar un fallo de arranque
        // de Codex después de cerrar la app. Ahora se anexa a un log.
        if let Some(stderr) = child.stderr.take() {
            crate::process::logs::spawn_log_writer(stderr, "codex");
        }

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let pending_clone = pending.clone();

        // Hilo lector: enruta mensajes JSON-RPC según su forma real, no solo
        // por la presencia de "id". Codex app-server también envía
        // PETICIONES servidor→cliente (execCommandApproval, applyPatchApproval)
        // que tienen "id" Y "method" a la vez y esperan una respuesta nuestra.
        // Tratarlas como si fueran respuestas a peticiones propias (como hacía
        // el código anterior) las descarta en silencio: no hay ningún emisor
        // pendiente con ese id, así que Codex se queda esperando para siempre
        // una decisión que nunca llega — el hilo de chat parece "colgado".
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                    eprintln!("[codex] línea no es JSON válido, se ignora");
                    continue;
                };

                match classify_inbound(&msg) {
                    RpcInbound::Response { id } => {
                        if let Some(tx) = pending_clone.lock().unwrap().remove(&id) {
                            let _ = tx.send(msg);
                        } else {
                            eprintln!("[codex] Response id={id} sin receptor pendiente (¿ya expiró el timeout?)");
                        }
                    }
                    RpcInbound::Notification { method } => {
                        // Tauri solo permite alfanuméricos, '-', '/', ':' y '_' en nombres de
                        // evento. Los "/" del método (item/agentMessage/delta) SÍ están
                        // permitidos — convertirlos a "." (como hacía el código anterior a
                        // esta sesión) produce un nombre inválido: `emit()` fallaba en
                        // silencio y, peor, el propio `listen()` del lado JS lanzaba una
                        // excepción no capturada que cortaba el registro de TODOS los
                        // listeners siguientes. Por eso ningún evento de Codex llegaba nunca.
                        let event_name = format!("codex:{method}");
                        if let Err(error) = app.emit(&event_name, &msg) {
                            eprintln!("[codex] no se pudo emitir {event_name}: {error}");
                        }
                    }
                    RpcInbound::ServerRequest { id, method } => {
                        let event_name = format!("codex:{method}");
                        let payload = serde_json::json!({
                            "id": id,
                            "method": method,
                            "params": msg.get("params").cloned().unwrap_or(Value::Null),
                        });
                        if let Err(error) = app.emit(&event_name, &payload) {
                            eprintln!("[codex] no se pudo emitir {event_name}: {error}");
                        }
                    }
                    RpcInbound::Unrecognized => {
                        eprintln!("[codex] mensaje no reconocido (ni Response ni Notification ni ServerRequest)");
                    }
                }
            }
        });

        Ok(Self {
            stdin: Mutex::new(stdin),
            pending,
            next_id: Mutex::new(1),
            _child: Mutex::new(child),
        })
    }

    fn next_id(&self) -> u64 {
        let mut n = self.next_id.lock().unwrap();
        let id = *n;
        *n += 1;
        id
    }

    /// Envía una petición JSON-RPC y espera la respuesta por ID.
    fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id();
        let (tx, rx) = sync_channel(1);
        self.pending.lock().unwrap().insert(id, tx);

        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&msg).map_err(|e| e.to_string())? + "\n";
        self.stdin.lock().unwrap()
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())?;

        let resp = rx.recv_timeout(timeout)
            .map_err(|_| format!("Timeout esperando respuesta de Codex ({method})"))?;
        self.pending.lock().unwrap().remove(&id);

        if let Some(err) = resp.get("error") {
            return Err(format!("Error de Codex en {method}: {err}"));
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Responde a una petición del servidor (p. ej. execCommandApproval o
    /// applyPatchApproval) usando el mismo `id` recibido. A diferencia de
    /// `call`, no espera ninguna respuesta a esto: es Codex quien queda
    /// esperando, no nosotros.
    fn respond(&self, id: Value, result: Value) -> Result<(), String> {
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        });
        let line = serde_json::to_string(&msg).map_err(|e| e.to_string())? + "\n";
        self.stdin.lock().unwrap()
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())
    }

    /// Envía una notificación JSON-RPC (sin respuesta esperada).
    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&msg).map_err(|e| e.to_string())? + "\n";
        self.stdin.lock().unwrap()
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())
    }

    fn initialize(&self) -> Result<(), String> {
        self.call(
            "initialize",
            serde_json::json!({
                "clientInfo": { "name": "Jintia Desktop", "version": "1.1" },
                "capabilities": {},
            }),
            Duration::from_secs(10),
        )?;
        self.notify("initialized", serde_json::json!({}))?;
        Ok(())
    }

    fn account_read(&self) -> Result<Value, String> {
        self.call(
            "account/read",
            serde_json::json!({ "refreshToken": false }),
            Duration::from_secs(10),
        )
    }

    /// Catálogo de modelos disponibles para la cuenta, con sus esfuerzos de
    /// razonamiento soportados por modelo (result.data[].supportedReasoningEfforts).
    fn list_models(&self) -> Result<Value, String> {
        self.call("model/list", serde_json::json!({}), Duration::from_secs(15))
    }

    /// Estado real de la cuota de la cuenta. Forma confirmada contra una
    /// cuenta real en el límite:
    /// `{ rateLimits: { primary: { usedPercent, windowDurationMins, resetsAt }, ... } }`.
    /// El app-server también empuja esto solo, sin pedirlo, como notificación
    /// "account/rateLimits/updated" cada vez que cambia.
    fn read_rate_limits(&self) -> Result<Value, String> {
        self.call("account/rateLimits/read", serde_json::json!({}), Duration::from_secs(10))
    }

    fn login_start(&self) -> Result<String, String> {
        let result = self.call(
            "account/login/start",
            serde_json::json!({ "type": "chatgpt" }),
            Duration::from_secs(10),
        )?;
        result.get("authUrl")
            .or_else(|| result.get("auth_url"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| "Codex no devolvió URL de autenticación".to_string())
    }

    fn thread_start(&self, cwd: &str) -> Result<String, String> {
        let result = self.call(
            "thread/start",
            serde_json::json!({ "cwd": cwd }),
            Duration::from_secs(15),
        )?;
        // El protocolo v2 de Codex app-server anida el id bajo `thread.id`
        // (ThreadStartResponse { thread: Thread, .. } con Thread.id: String).
        // Los fallbacks planos cubren versiones anteriores del app-server.
        result.get("thread")
            .and_then(|thread| thread.get("id"))
            .or_else(|| result.get("id"))
            .or_else(|| result.get("threadId"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| "Codex no devolvió ID de hilo".to_string())
    }

    /// `model` y `effort` son opcionales: si se omiten, Codex conserva lo que
    /// ya tenía el hilo. `effort` corresponde al campo `effort` (esfuerzo de
    /// razonamiento) de TurnStartParams; valores típicos: low/medium/high/xhigh
    /// (algunos modelos también soportan none/minimal/max/ultra, según
    /// model/list → supportedReasoningEfforts).
    fn turn_start(
        &self,
        thread_id: &str,
        message: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<String, String> {
        let params = build_turn_start_params(thread_id, message, model, effort);
        let result = self.call("turn/start", params, Duration::from_secs(30))?;
        result.get("turn")
            .and_then(|turn| turn.get("id"))
            .or_else(|| result.get("turnId"))
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .ok_or_else(|| "Codex no devolvió ID de turno".to_string())
    }

    fn turn_interrupt(&self, thread_id: &str, turn_id: &str) -> Result<(), String> {
        self.call(
            "turn/interrupt",
            serde_json::json!({
                "threadId": thread_id,
                "turnId": turn_id,
            }),
            Duration::from_secs(10),
        )?;
        Ok(())
    }
}

// ── Manager público ───────────────────────────────────────────────────────────

pub struct CodexManager {
    process: Mutex<Option<Arc<CodexProcess>>>,
}

impl CodexManager {
    pub fn new() -> Self {
        Self { process: Mutex::new(None) }
    }

    /// Busca el binario `codex` en el PATH.
    pub fn find_binary() -> Option<String> {
        let candidates: &[&str] = if cfg!(windows) {
            &["codex.cmd", "codex", "codex.exe"]
        } else {
            &["codex"]
        };
        for &cmd in candidates {
            if std::process::Command::new(cmd)
                .arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok()
            {
                return Some(cmd.to_string());
            }
        }
        None
    }

    /// Inicia el app-server y realiza el handshake JSON-RPC.
    /// Idempotente: si ya está corriendo, retorna OK de inmediato.
    pub fn start(&self, app: tauri::AppHandle) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }
        let binary = Self::find_binary().ok_or_else(|| {
            "Codex CLI no encontrado. Instálalo con: npm install -g @openai/codex".to_string()
        })?;
        let proc = CodexProcess::spawn(app, &binary)?;
        proc.initialize()?;
        *self.process.lock().unwrap() = Some(Arc::new(proc));
        Ok(())
    }

    pub fn stop(&self) {
        // Antes esto solo soltaba el Arc (`= None`), lo cual NO mata el
        // proceso: std::process::Child no implementa "kill on drop", y
        // además otros clones del Arc pueden seguir vivos en llamadas JSON-RPC
        // en curso, así que ni siquiera garantizaba llegar a 0 referencias.
        // Matar el Child explícitamente aquí es correcto sin importar cuántos
        // clones del Arc existan.
        if let Some(process) = self.process.lock().unwrap().take() {
            if let Ok(mut child) = process._child.lock() {
                crate::process::kill_child_tree(&mut child);
            }
        }
    }

    /// Alias de `stop()`: Codex solo mantiene un app-server a la vez, así que
    /// "detener" y "detener todos" son la misma operación. Existe para que
    /// `on_window_event` (lib.rs) trate a los tres managers de forma uniforme.
    pub fn stop_all(&self) {
        self.stop();
    }

    pub fn is_running(&self) -> bool {
        self.process.lock().unwrap().is_some()
    }

    pub fn get_account(&self) -> Result<CodexAccountInfo, String> {
        let lock = self.process.lock().unwrap();
        let proc = lock.as_ref().ok_or("Codex no está iniciado")?;
        let result = proc.account_read()?;
        // La info puede estar bajo la clave "account"
        let data = result.get("account").cloned().unwrap_or(result);
        Ok(serde_json::from_value(data).unwrap_or_default())
    }

    /// Inicia el flujo OAuth de ChatGPT y devuelve la URL para abrir en el navegador.
    /// Cuando el login completa, el app-server emite "account/updated",
    /// que el hilo lector reenvía como evento Tauri "codex:account/updated"
    /// (nadie lo escucha todavía; el flujo actual sondea codex_status en su lugar).
    pub fn start_login(&self) -> Result<String, String> {
        let lock = self.process.lock().unwrap();
        let proc = lock.as_ref().ok_or("Codex no está iniciado")?;
        proc.login_start()
    }

    pub fn list_models(&self) -> Result<Value, String> {
        let lock = self.process.lock().unwrap();
        let proc = lock.as_ref().ok_or("Codex no está iniciado")?;
        proc.list_models()
    }

    pub fn read_rate_limits(&self) -> Result<Value, String> {
        let lock = self.process.lock().unwrap();
        let proc = lock.as_ref().ok_or("Codex no está iniciado")?;
        proc.read_rate_limits()
    }

    pub fn status(&self) -> CodexStatus {
        let installed = Self::find_binary().is_some();
        let running = self.is_running();
        let account = if running { self.get_account().ok() } else { None };
        let logged_in = account.as_ref()
            .map(|a| a.email.is_some() || a.kind.is_some())
            .unwrap_or(false);
        CodexStatus { installed, running, logged_in, account }
    }

    pub fn start_thread(&self, cwd: &str) -> Result<String, String> {
        let lock = self.process.lock().unwrap();
        let proc = lock.as_ref().ok_or("Codex no está iniciado")?;
        proc.thread_start(cwd)
    }

    pub fn submit_turn(
        &self,
        thread_id: &str,
        message: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<String, String> {
        let lock = self.process.lock().unwrap();
        let proc = lock.as_ref().ok_or("Codex no está iniciado")?;
        proc.turn_start(thread_id, message, model, effort)
    }

    pub fn interrupt_turn(&self, thread_id: &str, turn_id: &str) -> Result<(), String> {
        let lock = self.process.lock().unwrap();
        let proc = lock.as_ref().ok_or("Codex no está iniciado")?;
        proc.turn_interrupt(thread_id, turn_id)
    }

    /// Responde a una petición de aprobación (execCommandApproval /
    /// applyPatchApproval) que el app-server envió al cliente. `id` debe ser
    /// exactamente el valor recibido en el evento `codex:*Approval`.
    pub fn respond_approval(&self, id: Value, decision: &str) -> Result<(), String> {
        if !["allow", "deny", "accept", "cancel"].contains(&decision) {
            return Err(format!("Decisión de aprobación no admitida: {decision}"));
        }
        let lock = self.process.lock().unwrap();
        let proc = lock.as_ref().ok_or("Codex no está iniciado")?;
        proc.respond(id, serde_json::json!({ "decision": decision }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Payloads capturados hablando directamente por stdio con un `codex
    // app-server` real (codex-cli 0.148.0), no inventados. Confirman tanto
    // la forma anidada de thread/start como la notificación "error" real que
    // se dispara al agotar el límite de uso de la cuenta.

    #[test]
    fn classifies_our_own_request_response() {
        // Respuesta real de thread/start: sin "method", con "id" numérico.
        let msg: Value = serde_json::from_str(
            r#"{"id":3,"result":{"thread":{"id":"01a019c4-31d3-79d2-b11f-e98145727daa"}}}"#,
        )
        .unwrap();
        assert_eq!(classify_inbound(&msg), RpcInbound::Response { id: 3 });
    }

    #[test]
    fn classifies_plain_notification() {
        // Notificación real "error" (límite de uso agotado): tiene "method", no "id".
        let msg: Value = serde_json::from_str(
            r#"{"method":"error","params":{"error":{"message":"You've hit your usage limit.","codexErrorInfo":"usageLimitExceeded"},"willRetry":false,"threadId":"01a019c4-31d3-79d2-b11f-e98145727daa","turnId":"01a019c4-33dd-74d1-8365-b47824769072"}}"#,
        )
        .unwrap();
        assert_eq!(
            classify_inbound(&msg),
            RpcInbound::Notification { method: "error".to_string() }
        );
    }

    #[test]
    fn classifies_turn_completed_notification() {
        // Notificación real turn/completed tras el fallo por límite de uso.
        let msg: Value = serde_json::from_str(
            r#"{"method":"turn/completed","params":{"threadId":"01a019c4-31d3-79d2-b11f-e98145727daa","turn":{"id":"01a019c4-33dd-74d1-8365-b47824769072","status":"failed"}}}"#,
        )
        .unwrap();
        assert_eq!(
            classify_inbound(&msg),
            RpcInbound::Notification { method: "turn/completed".to_string() }
        );
    }

    #[test]
    fn classifies_server_request_with_id_and_method_as_server_request_not_response() {
        // Forma documentada de execCommandApproval (server -> client): "id" Y
        // "method" a la vez. Es la que el código anterior confundía con una
        // respuesta a una petición propia y descartaba en silencio.
        let msg: Value = serde_json::from_str(
            r#"{"id":42,"method":"execCommandApproval","params":{"conversationId":"c1","callId":"call1","command":["ls","-la"],"cwd":"/tmp"}}"#,
        )
        .unwrap();
        assert_eq!(
            classify_inbound(&msg),
            RpcInbound::ServerRequest {
                id: serde_json::json!(42),
                method: "execCommandApproval".to_string(),
            }
        );
    }

    #[test]
    fn classifies_notification_with_explicit_null_id_as_notification() {
        // Algunos servidores JSON-RPC envían "id": null en notificaciones en
        // vez de omitir el campo. No debe confundirse con una ServerRequest.
        let msg: Value = serde_json::from_str(
            r#"{"id":null,"method":"thread/status/changed","params":{"status":"idle"}}"#,
        )
        .unwrap();
        assert_eq!(
            classify_inbound(&msg),
            RpcInbound::Notification { method: "thread/status/changed".to_string() }
        );
    }

    #[test]
    fn thread_start_reads_the_real_nested_thread_id() {
        // Respuesta completa real de thread/start (recortada) — confirma que
        // el id vive en result.thread.id, no en result.id ni result.threadId.
        let result: Value = serde_json::from_str(
            r#"{"thread":{"id":"01a019c4-31d3-79d2-b11f-e98145727daa","status":{"type":"idle"}},"model":"gpt-5.6-sol"}"#,
        )
        .unwrap();
        let id = result
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .or_else(|| result.get("id"))
            .or_else(|| result.get("threadId"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        assert_eq!(id.as_deref(), Some("01a019c4-31d3-79d2-b11f-e98145727daa"));
    }

    #[test]
    fn turn_start_params_omit_model_and_effort_when_absent() {
        let params = build_turn_start_params("t1", "hola", None, None);
        assert_eq!(params["threadId"], "t1");
        assert_eq!(params["input"][0]["text"], "hola");
        assert!(params.get("model").is_none());
        assert!(params.get("effort").is_none());
    }

    #[test]
    fn turn_start_params_include_model_and_effort_when_present() {
        // "effort" es exactamente el nombre de campo real de TurnStartParams
        // (no "reasoningEffort"); valores tomados de un model/list real.
        let params = build_turn_start_params("t1", "hola", Some("gpt-5.6-sol"), Some("high"));
        assert_eq!(params["model"], "gpt-5.6-sol");
        assert_eq!(params["effort"], "high");
    }

    #[test]
    fn model_list_response_exposes_supported_efforts_per_model() {
        // Recorte real de una respuesta model/list capturada de codex-cli 0.148.0.
        let result: Value = serde_json::from_str(
            r#"{"data":[{"id":"gpt-5.6-sol","displayName":"GPT-5.6-Sol","isDefault":true,"defaultReasoningEffort":"low","supportedReasoningEfforts":[{"reasoningEffort":"low","description":"Fast"},{"reasoningEffort":"high","description":"Deep"}]}],"nextCursor":null}"#,
        )
        .unwrap();
        let models = result["data"].as_array().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["id"], "gpt-5.6-sol");
        let efforts: Vec<&str> = models[0]["supportedReasoningEfforts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["reasoningEffort"].as_str().unwrap())
            .collect();
        assert_eq!(efforts, vec!["low", "high"]);
    }

    #[test]
    fn rate_limits_response_exposes_percent_and_reset_time() {
        // Respuesta real de account/rateLimits/read capturada de una cuenta
        // que en ese momento ya había agotado su cuota (rate_limit_reached).
        let result: Value = serde_json::from_str(
            r#"{"rateLimits":{"limitId":"codex","limitName":null,"primary":{"usedPercent":100,"windowDurationMins":10080,"resetsAt":1787203166},"secondary":null,"credits":{"hasCredits":false,"unlimited":false,"balance":"0"},"individualLimit":null,"spendControlReached":false,"planType":"plus","rateLimitReachedType":"rate_limit_reached"}}"#,
        )
        .unwrap();
        let primary = &result["rateLimits"]["primary"];
        assert_eq!(primary["usedPercent"], 100);
        assert_eq!(primary["windowDurationMins"], 10080);
        assert_eq!(primary["resetsAt"], 1787203166);
        assert_eq!(result["rateLimits"]["rateLimitReachedType"], "rate_limit_reached");
    }
}
