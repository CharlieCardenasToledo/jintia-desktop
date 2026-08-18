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
 *   thread/start (por curso) → turn/submit (por mensaje)
 *   → notificaciones "turn.completed" / "item.completed" emitidas como eventos Tauri
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

impl CodexProcess {
    fn spawn(app: tauri::AppHandle, binary: &str) -> Result<Self, String> {
        let mut child = std::process::Command::new(binary)
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("No se pudo iniciar Codex app-server: {e}"))?;

        let stdin = child.stdin.take()
            .ok_or("No se pudo capturar stdin de Codex")?;
        let stdout = child.stdout.take()
            .ok_or("No se pudo capturar stdout de Codex")?;

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let pending_clone = pending.clone();

        // Hilo lector: enruta respuestas por ID y emite eventos Tauri para notificaciones.
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };

                // Las respuestas tienen id numérico; las notificaciones no (o tienen null).
                let has_numeric_id = msg.get("id")
                    .map(|v| v.is_u64() || v.is_i64())
                    .unwrap_or(false);

                if has_numeric_id {
                    if let Some(id) = msg["id"].as_u64() {
                        if let Some(tx) = pending_clone.lock().unwrap().remove(&id) {
                            let _ = tx.send(msg);
                        }
                    }
                } else if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
                    // Notificación → evento Tauri con notación de puntos.
                    let event_name = format!("codex:{}", method.replace('/', "."));
                    let _ = app.emit(&event_name, &msg);
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

    /// Envía una petición JSON-RPC sin esperar respuesta (fire-and-forget).
    fn fire(&self, method: &str, params: Value) -> Result<(), String> {
        let id = self.next_id();
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
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
        result.get("id")
            .or_else(|| result.get("threadId"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| "Codex no devolvió ID de hilo".to_string())
    }

    fn turn_submit(&self, thread_id: &str, message: &str) -> Result<(), String> {
        self.fire(
            "turn/submit",
            serde_json::json!({
                "threadId": thread_id,
                "items": [{
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": message }],
                }],
            }),
        )
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
        *self.process.lock().unwrap() = None;
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
    /// que el hilo lector reenvía como evento Tauri "codex:account.updated".
    pub fn start_login(&self) -> Result<String, String> {
        let lock = self.process.lock().unwrap();
        let proc = lock.as_ref().ok_or("Codex no está iniciado")?;
        proc.login_start()
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

    pub fn submit_turn(&self, thread_id: &str, message: &str) -> Result<(), String> {
        let lock = self.process.lock().unwrap();
        let proc = lock.as_ref().ok_or("Codex no está iniciado")?;
        proc.turn_submit(thread_id, message)
    }
}
