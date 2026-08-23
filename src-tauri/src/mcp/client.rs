use super::{managed_mcp, McpConnection};
use crate::mcp::auth::AUTH_CANCEL_REQUESTED;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub(crate) static CONNECTION: Mutex<Option<McpConnection>> = Mutex::new(None);

pub(crate) fn build_managed_mcp_server_command(
    node: &Path,
    bin: &Path,
    managed_path: &std::ffi::OsStr,
) -> Command {
    let mut command = crate::runtimes::managed_node_command(node);
    command.arg(bin).env("PATH", managed_path);
    command
}

fn receive_json(
    receiver: &mpsc::Receiver<String>,
    id: i64,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "NotebookLM MCP no respondió a la solicitud {id} dentro del tiempo esperado."
            ));
        }
        let line = match receiver.recv_timeout(remaining) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "NotebookLM MCP no respondió a la solicitud {id} dentro del tiempo esperado."
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "NotebookLM MCP cerró la conexión durante la solicitud {id}."
                ))
            }
        };
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            if value.get("id").and_then(Value::as_i64) == Some(id) {
                return Ok(value);
            }
        }
    }
}

fn receive_json_cancellable(
    receiver: &mpsc::Receiver<String>,
    id: i64,
    timeout: Duration,
) -> Result<Value, String> {
    use std::sync::atomic::Ordering;
    let deadline = Instant::now() + timeout;
    loop {
        if AUTH_CANCEL_REQUESTED.load(Ordering::SeqCst) {
            return Err(crate::mcp::auth::AUTH_CANCELLED.to_string());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "NotebookLM MCP no respondió a la solicitud {id} dentro del tiempo esperado."
            ));
        }
        match receiver.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(line) => {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if value.get("id").and_then(Value::as_i64) == Some(id) {
                        return Ok(value);
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "NotebookLM MCP cerró la conexión durante la solicitud {id}."
                ));
            }
        }
    }
}

impl McpConnection {
    pub(crate) fn spawn() -> Result<Self, String> {
        let managed = managed_mcp()?;
        let managed_path = crate::runtimes::managed_node_runtime_path()?;
        let mut cmd = build_managed_mcp_server_command(&managed.node, &managed.bin, &managed_path);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = crate::process::supervisor().spawn(cmd).map_err(|error| {
            format!("No se pudo iniciar gemini-notebook-mcp. Verifica Node.js y npx: {error}")
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "No se pudo leer la salida del MCP.".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "No se pudo escribir al MCP.".to_string())?;
        // Antes se heredaba la consola de Jintia, que en producción no existe
        // (proceso sin ventana). Sin este log, un fallo de NotebookLM sería
        // indiagnosticable una vez cerrada la app.
        if let Some(stderr) = child.stderr.take() {
            crate::process::logs::spawn_log_writer(stderr, "notebooklm-mcp");
        }
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout).lines();
            loop {
                match reader.next() {
                    Some(Ok(line)) => {
                        eprintln!("[gemini-notebook-mcp] {line}");
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    Some(Err(error)) => {
                        eprintln!("[gemini-notebook-mcp] error leyendo stdout: {error}");
                        break;
                    }
                    None => break,
                }
            }
        });

        let mut connection = McpConnection {
            child,
            stdin: Some(stdin),
            receiver,
            next_id: 1,
        };
        connection.initialize()?;
        Ok(connection)
    }

    pub(crate) fn send(&mut self, value: Value) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "La entrada estándar de NotebookLM MCP ya está cerrada.".to_string())?;
        writeln!(stdin, "{value}")
            .map_err(|error| format!("No se pudo escribir al MCP: {error}"))?;
        stdin.flush().map_err(|error| error.to_string())
    }

    pub(crate) fn initialize(&mut self) -> Result<(), String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "jintia-desktop", "version": "1.0.0" }
            }
        }))
        .map_err(|error| format!("No se pudo inicializar el MCP: {error}"))?;
        let response = receive_json(&self.receiver, id, Duration::from_secs(30))?;
        if let Some(error) = response.get("error") {
            return Err(format!("NotebookLM MCP rechazó la inicialización: {error}"));
        }
        self.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
    }

    pub(crate) fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

/// Cierra la conexión administrada de NotebookLM MCP, si hay una activa. Se
/// llama al cerrar la ventana de Jintia (lib.rs), igual que
/// `OpenCodeManager::stop_all`/`ClaudeManager::stop_all`/`CodexManager::stop_all`.
///
/// Importante: `CONNECTION` es un `static`, y Rust NUNCA ejecuta `Drop` sobre
/// statics al terminar el proceso (a diferencia de state gestionado por
/// Tauri, que sí se destruye normalmente). El `impl Drop for McpConnection`
/// (ver mcp/mod.rs) es una buena red de seguridad para cuando la conexión se
/// reemplaza en caliente, pero por sí solo NUNCA se dispara al cerrar la
/// app — de ahí la necesidad de esta llamada explícita.
pub(crate) fn shutdown() {
    if let Ok(mut guard) = CONNECTION.lock() {
        drop(guard.take());
    }
}

pub(crate) fn spawn_connection() -> Result<McpConnection, String> {
    match McpConnection::spawn() {
        Ok(connection) => Ok(connection),
        Err(first_error) => {
            // npx/Node puede cerrar prematuramente la primera tubería mientras
            // prepara su caché. Un único reintento acotado evita que ese EOF
            // transitorio llegue al onboarding como un fallo permanente.
            eprintln!(
                "[gemini-notebook-mcp] primer arranque falló; reintentando una vez: {first_error}"
            );
            thread::sleep(Duration::from_millis(350));
            McpConnection::spawn().map_err(|second_error| {
                format!("{second_error} El primer intento también falló: {first_error}")
            })
        }
    }
}

pub(crate) fn call_tool(
    tool: &'static str,
    arguments: Value,
    timeout: Duration,
) -> Result<Value, String> {
    call_tool_internal(tool, arguments, timeout, false)
}

pub(crate) fn call_tool_internal(
    tool: &'static str,
    arguments: Value,
    timeout: Duration,
    cancellable: bool,
) -> Result<Value, String> {
    let mut guard = CONNECTION
        .lock()
        .map_err(|_| "Estado interno de NotebookLM MCP corrupto.".to_string())?;

    if let Some(connection) = guard.as_mut() {
        if !connection.is_alive() {
            *guard = None;
        }
    }
    if guard.is_none() {
        *guard = Some(spawn_connection()?);
    }
    let connection = guard.as_mut().expect("la conexión se acaba de crear");

    let id = connection.next_id;
    connection.next_id += 1;
    let result = connection
        .send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": tool, "arguments": arguments }
        }))
        .map_err(|error| format!("No se pudo llamar {tool}: {error}"))
        .and_then(|_| {
            if cancellable {
                receive_json_cancellable(&connection.receiver, id, timeout)
            } else {
                receive_json(&connection.receiver, id, timeout)
            }
        });

    if result.is_err() {
        // La conexión pudo haber quedado en un estado inconsistente (p. ej.
        // el usuario abandonó el login y se agotó el tiempo): se descarta
        // para que la próxima llamada arranque un proceso limpio.
        *guard = None;
    }
    result
}

pub fn find_bool_field(value: &Value, field: &str) -> Option<bool> {
    match value {
        Value::Object(map) => {
            if let Some(value) = map.get(field).and_then(Value::as_bool) {
                return Some(value);
            }
            map.values().find_map(|value| find_bool_field(value, field))
        }
        Value::Array(items) => items.iter().find_map(|value| find_bool_field(value, field)),
        Value::String(text) => serde_json::from_str::<Value>(text)
            .ok()
            .as_ref()
            .and_then(|value| find_bool_field(value, field)),
        _ => None,
    }
}

pub fn find_string_field(value: &Value, field: &str) -> Option<String> {
    match value {
        Value::Object(map) => map
            .get(field)
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                map.values()
                    .find_map(|value| find_string_field(value, field))
            }),
        Value::Array(items) => items
            .iter()
            .find_map(|value| find_string_field(value, field)),
        Value::String(text) => serde_json::from_str::<Value>(text)
            .ok()
            .as_ref()
            .and_then(|value| find_string_field(value, field)),
        _ => None,
    }
}

/// Recorre el mismo sobre MCP que `find_string_field`/`find_bool_field`
/// (result.content[].text con JSON serializado adentro) buscando un array
/// bajo la clave dada. Ver `handleListNotebooks` en gemini-notebook-mcp:
/// responde `{ success, data: { notebooks: NotebookEntry[] } }`.
pub fn find_array_field(value: &Value, field: &str) -> Option<Vec<Value>> {
    match value {
        Value::Object(map) => {
            if let Some(Value::Array(items)) = map.get(field) {
                return Some(items.clone());
            }
            map.values()
                .find_map(|value| find_array_field(value, field))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|value| find_array_field(value, field)),
        Value::String(text) => serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|value| find_array_field(&value, field)),
        _ => None,
    }
}

pub fn is_tool_error(value: &Value) -> bool {
    value.get("error").is_some()
        || value
            .pointer("/result/isError")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || find_bool_field(value, "success") == Some(false)
}

pub fn tool_error_message(value: &Value) -> String {
    find_string_field(value, "error")
        .or_else(|| find_string_field(value, "message"))
        .unwrap_or_else(|| value.to_string())
}
