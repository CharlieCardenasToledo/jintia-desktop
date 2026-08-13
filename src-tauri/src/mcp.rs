use crate::models::{ActionResult, NotebookLmAuthStatus, NotebookLmEntry};
use crate::paths::{
    atomic_write, backup_file, claude_code_config_path, claude_desktop_config_path, path_text,
};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use semver::{Version, VersionReq};

const AUTH_STATE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const AUTH_VALIDATION_TTL: Duration = Duration::from_secs(5 * 60);
const GOOGLE_API_AUTH_COOKIE: &[u8] = b"SAPISID";
const GOOGLE_SECURE_AUTH_COOKIES: [&[u8]; 2] = [b"__Secure-1PSID", b"__Secure-3PSID"];
static AUTH_VALIDATION: Mutex<Option<(Instant, NotebookLmAuthStatus)>> = Mutex::new(None);
static MCP_CONFIG_OPERATION: Mutex<()> = Mutex::new(());

struct ManagedMcp {
    node: PathBuf,
    bin: PathBuf,
}

fn managed_mcp() -> Result<ManagedMcp, String> {
    let node = crate::paths::portable_node_exe();
    if !node.is_file() {
        return Err("NotebookLM MCP requiere el Node.js administrado por Jintia.".to_string());
    }
    let contract = crate::release::managed_mcp_contract()?;
    if !crate::runtimes::portable_notebooklm_mcp_installed_for(&contract) {
        return Err("NotebookLM MCP no está instalado o no coincide con el contrato aprobado.".to_string());
    }
    validate_managed_node(&node, &contract.node_requirement)?;
    let package_dir = crate::runtimes::portable_notebooklm_mcp_package_dir_for(&contract.package);
    let bin = crate::runtimes::resolve_notebooklm_mcp_bin_for(&package_dir, &contract)?;
    Ok(ManagedMcp { node, bin })
}

fn server_matches_paths(server: &Value, node: &Path, bin: &Path) -> bool {
    server.get("command").and_then(Value::as_str) == node.to_str()
        && server.get("args").and_then(Value::as_array).is_some_and(|args| {
            args.len() == 1 && args[0].as_str() == bin.to_str()
        })
}

pub(crate) fn server_matches_managed_mcp(server: &Value) -> bool {
    let Ok(managed) = managed_mcp() else { return false; };
    server_matches_paths(server, &managed.node, &managed.bin)
}

fn managed_node_version(node: &std::path::Path) -> Result<Version, String> {
    let output = Command::new(node)
        .arg("--version")
        .output()
        .map_err(|error| format!("No se pudo consultar el Node administrado: {error}"))?;
    if !output.status.success() {
        return Err("El Node administrado no pudo informar su versión.".to_string());
    }
    parse_node_version(&String::from_utf8_lossy(&output.stdout))
}

fn parse_node_version(text: &str) -> Result<Version, String> {
    let version = text.trim().trim_start_matches('v');
    Version::parse(version).map_err(|error| format!("Versión inválida del Node administrado: {error}"))
}

fn validate_managed_node(node: &std::path::Path, node_requirement: &str) -> Result<(), String> {
    let requirement = VersionReq::parse(node_requirement)
        .map_err(|error| format!("Requisito Node inválido para NotebookLM MCP: {error}"))?;
    let version = managed_node_version(node)?;
    if !requirement.matches(&version) {
        return Err(format!(
            "NotebookLM MCP requiere Node {}, pero Jintia administra Node {}.",
            node_requirement, version
        ));
    }
    Ok(())
}

pub fn configure_mcp(target: String) -> ActionResult {
    let _operation = match MCP_CONFIG_OPERATION.lock() {
        Ok(operation) => operation,
        Err(_) => {
            return ActionResult::error("El estado interno de configuración MCP está bloqueado.")
        }
    };
    let managed = match managed_mcp() {
        Ok(managed) => managed,
        Err(error) => return ActionResult::error(error),
    };
    let (path, label) = match target.as_str() {
        "desktop" => match claude_desktop_config_path() {
            Ok(path) => (path, "Claude Desktop"),
            Err(error) => return ActionResult::error(error),
        },
        "claude-code" => match claude_code_config_path() {
            Ok(path) => (path, "Claude Code"),
            Err(error) => return ActionResult::error(error),
        },
        _ => return ActionResult::error("Destino MCP no reconocido."),
    };

    let mut root = if path.exists() {
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) => {
                return ActionResult::error(format!("No se pudo leer {}: {error}", path.display()))
            }
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(object)) => Value::Object(object),
            Ok(_) => {
                return ActionResult::error(format!(
                    "{} no contiene un objeto JSON.",
                    path.display()
                ))
            }
            Err(error) => {
                return ActionResult::error(format!(
                    "La configuración existente no es JSON válido y no fue modificada: {error}"
                ))
            }
        }
    } else {
        json!({})
    };

    if root
        .get("mcpServers")
        .is_some_and(|value| !value.is_object())
    {
        return ActionResult::error(
            "La clave mcpServers existente no es un objeto. Corrígela antes de continuar.",
        );
    }
    if root.get("mcpServers").is_none() {
        root["mcpServers"] = json!({});
    }
    let previous = root.clone();
    root["mcpServers"]["notebooklm"] = json!({
        "command": managed.node.to_string_lossy(),
        "args": [
            managed.bin.to_string_lossy()
        ]
    });
    if root == previous {
        return ActionResult::ok(format!(
            "NotebookLM MCP ya estaba configurado correctamente para {label}; no se volvió a escribir."
        ))
        .with_path(path_text(&path));
    }

    let bytes = match serde_json::to_vec_pretty(&root) {
        Ok(bytes) => bytes,
        Err(error) => {
            return ActionResult::error(format!("No se pudo serializar la configuración: {error}"))
        }
    };
    let backup = match backup_file(&path) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    if let Err(error) = atomic_write(&path, &bytes) {
        return ActionResult::error(error);
    }

    let result = ActionResult::ok(format!(
        "NotebookLM MCP configurado para {label} en:\n{}\n\nReinicia {label} para aplicar el cambio.",
        path_text(&path)
    ))
    .with_path(path_text(&path));
    if let Some(backup) = backup {
        result.with_backup(path_text(&backup))
    } else {
        result
    }
}

/// Codex CLI no usa `.mcp.json`/`claude_desktop_config.json` (JSON) sino
/// `~/.codex/config.toml` (TOML) — un archivo personal grande (proyectos de
/// confianza, otros servidores MCP, plugins). Se edita con `toml_edit` en vez
/// de un parser TOML "de solo lectura + reescritura" para no reordenar ni
/// perder comentarios de secciones ajenas a `mcp_servers.notebooklm`.
pub fn configure_codex_mcp() -> ActionResult {
    let _operation = match MCP_CONFIG_OPERATION.lock() {
        Ok(operation) => operation,
        Err(_) => {
            return ActionResult::error("El estado interno de configuración MCP está bloqueado.")
        }
    };
    let managed = match managed_mcp() {
        Ok(managed) => managed,
        Err(error) => return ActionResult::error(error),
    };
    let path = match crate::paths::codex_config_path() {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };

    let text = if path.exists() {
        match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) => {
                return ActionResult::error(format!("No se pudo leer {}: {error}", path.display()))
            }
        }
    } else {
        String::new()
    };

    let mut doc = match text.parse::<toml_edit::DocumentMut>() {
        Ok(doc) => doc,
        Err(error) => {
            return ActionResult::error(format!(
                "La configuración existente no es TOML válido y no fue modificada: {error}"
            ))
        }
    };

    if doc.get("mcp_servers").is_some_and(|item| !item.is_table()) {
        return ActionResult::error(
            "La clave mcp_servers existente no es una tabla. Corrígela antes de continuar.",
        );
    }
    if doc.get("mcp_servers").is_none() {
        doc["mcp_servers"] = toml_edit::table();
    }

    // Detecta otros servidores (con cualquier otro nombre) que ya apunten a un
    // paquete de NotebookLM, para avisar de duplicados sin tocarlos.
    let stale_servers: Vec<String> = doc["mcp_servers"]
        .as_table()
        .into_iter()
        .flat_map(|table| table.iter())
        .filter(|(name, _)| *name != "notebooklm")
        .filter_map(|(name, item)| {
            let has_notebook_package = item
                .get("args")?
                .as_array()?
                .iter()
                .any(|value| {
                    value
                        .as_str()
                        .is_some_and(|text| text.contains("notebooklm-mcp") || text.contains("gemini-notebook-mcp"))
                });
            has_notebook_package.then(|| name.to_string())
        })
        .collect();

    let previous = doc.to_string();
    if doc["mcp_servers"]
        .get("notebooklm")
        .is_some_and(|item| !item.is_table())
    {
        return ActionResult::error(
            "mcp_servers.notebooklm existente no es una tabla. Corrígela antes de continuar.",
        );
    }
    if doc["mcp_servers"].get("notebooklm").is_none() {
        doc["mcp_servers"]["notebooklm"] = toml_edit::table();
    }
    doc["mcp_servers"]["notebooklm"]["command"] =
        toml_edit::value(managed.node.to_string_lossy().into_owned());
    let mut args = toml_edit::Array::new();
    args.push(managed.bin.to_string_lossy().into_owned());
    doc["mcp_servers"]["notebooklm"]["args"] = toml_edit::value(args);

    let next = doc.to_string();
    if next == previous {
        let mut message =
            "NotebookLM MCP ya estaba configurado correctamente para Codex CLI; no se volvió a escribir.".to_string();
        if !stale_servers.is_empty() {
            message.push_str(&format!(
                "\n\nAviso: mcp_servers.{} también apunta a un paquete de NotebookLM; revísalo manualmente si ya no lo necesitas.",
                stale_servers.join(", mcp_servers.")
            ));
        }
        return ActionResult::ok(message).with_path(path_text(&path));
    }

    let backup = match backup_file(&path) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    if let Err(error) = atomic_write(&path, next.as_bytes()) {
        return ActionResult::error(error);
    }

    let mut message = format!(
        "NotebookLM MCP configurado para Codex CLI en:\n{}\n\nReinicia Codex para aplicar el cambio.",
        path_text(&path)
    );
    if !stale_servers.is_empty() {
        message.push_str(&format!(
            "\n\nAviso: mcp_servers.{} también apunta a un paquete de NotebookLM; revísalo manualmente si ya no lo necesitas.",
            stale_servers.join(", mcp_servers.")
        ));
    }
    let result = ActionResult::ok(message).with_path(path_text(&path));
    if let Some(backup) = backup {
        result.with_backup(path_text(&backup))
    } else {
        result
    }
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

// gemini-notebook-mcp v2.0 mantiene su navegador y perfil de Chrome persistentes
// en un `SharedContextManager` que vive en memoria mientras el proceso del
// servidor está vivo. Antes lanzábamos (y matábamos) un proceso nuevo por
// cada llamada — get_health y setup_auth terminaban en procesos distintos
// que no compartían ese estado en memoria, así que setup_auth nunca llegaba
// a completar su detección de login antes de que lo cerráramos. Ahora se
// mantiene UN solo proceso vivo, reutilizado por todas las llamadas.
struct McpConnection {
    child: Child,
    stdin: Option<ChildStdin>,
    receiver: mpsc::Receiver<String>,
    next_id: i64,
}

fn build_managed_mcp_server_command(
    node: &Path,
    bin: &Path,
    managed_path: &std::ffi::OsStr,
) -> Command {
    let mut command = Command::new(node);
    command.arg(bin).env("PATH", managed_path);
    command
}

impl McpConnection {
    fn spawn() -> Result<Self, String> {
        let managed = managed_mcp()?;
        let managed_path = crate::runtimes::managed_node_runtime_path()?;
        let mut child = build_managed_mcp_server_command(
            &managed.node,
            &managed.bin,
            &managed_path,
        )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| {
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

    fn send(&mut self, value: Value) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "La entrada estándar de NotebookLM MCP ya está cerrada.".to_string())?;
        writeln!(stdin, "{value}")
            .map_err(|error| format!("No se pudo escribir al MCP: {error}"))?;
        stdin.flush().map_err(|error| error.to_string())
    }

    fn initialize(&mut self) -> Result<(), String> {
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

    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for McpConnection {
    fn drop(&mut self) {
        // Cerrar stdin primero permite que el servidor procese EOF y ejecute su
        // limpieza de sesiones/contextos. Solo se fuerza la terminación si no
        // sale por sí mismo en un margen breve.
        self.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

static CONNECTION: Mutex<Option<McpConnection>> = Mutex::new(None);

fn spawn_connection() -> Result<McpConnection, String> {
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

fn call_tool(tool: &'static str, arguments: Value, timeout: Duration) -> Result<Value, String> {
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
        .and_then(|_| receive_json(&connection.receiver, id, timeout));

    if result.is_err() {
        // La conexión pudo haber quedado en un estado inconsistente (p. ej.
        // el usuario abandonó el login y se agotó el tiempo): se descarta
        // para que la próxima llamada arranque un proceso limpio.
        *guard = None;
    }
    result
}

fn find_bool_field(value: &Value, field: &str) -> Option<bool> {
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

fn find_string_field(value: &Value, field: &str) -> Option<String> {
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
fn find_array_field(value: &Value, field: &str) -> Option<Vec<Value>> {
    match value {
        Value::Object(map) => {
            if let Some(Value::Array(items)) = map.get(field) {
                return Some(items.clone());
            }
            map.values().find_map(|value| find_array_field(value, field))
        }
        Value::Array(items) => items.iter().find_map(|value| find_array_field(value, field)),
        Value::String(text) => serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|value| find_array_field(&value, field)),
        _ => None,
    }
}

fn is_tool_error(value: &Value) -> bool {
    value.get("error").is_some()
        || value
            .pointer("/result/isError")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || find_bool_field(value, "success") == Some(false)
}

fn tool_error_message(value: &Value) -> String {
    find_string_field(value, "error")
        .or_else(|| find_string_field(value, "message"))
        .unwrap_or_else(|| value.to_string())
}

// gemini-notebook-mcp persiste el perfil de Chrome en una carpeta distinta
// por plataforma (ver su README): en Windows es %APPDATA%\notebooklm, sin el
// sufijo "-mcp" ni la subcarpeta "Data" que usaba el paquete anterior.
fn notebooklm_data_dir() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("notebooklm"))
    } else if cfg!(target_os = "macos") {
        env::var_os("HOME").map(PathBuf::from).map(|path| {
            path.join("Library")
                .join("Application Support")
                .join("notebooklm-mcp")
        })
    } else {
        env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share"))
            })
            .map(|path| path.join("notebooklm-mcp"))
    }
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// Workaround para gemini-notebook-mcp 2.0.0: `get_health` solo comprueba
/// browser_state/state.json, aunque el perfil persistente de Chrome ya tenga
/// una sesión válida. Si el detector perdió la pestaña durante el redirect,
/// Chrome igualmente guarda sus cookies al cerrar el contexto.
fn persistent_profile_has_recent_google_auth() -> bool {
    let Some(data_dir) = notebooklm_data_dir() else {
        return false;
    };
    let cookie_files = [
        data_dir
            .join("chrome_profile")
            .join("Default")
            .join("Network")
            .join("Cookies"),
        data_dir
            .join("chrome_profile")
            .join("Default")
            .join("Network")
            .join("Cookies-wal"),
    ];

    cookie_files.iter().any(|path| {
        let recent = fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age <= AUTH_STATE_MAX_AGE);
        if !recent {
            return false;
        }
        fs::read(path).ok().is_some_and(|bytes| {
            contains_bytes(&bytes, GOOGLE_API_AUTH_COOKIE)
                && GOOGLE_SECURE_AUTH_COOKIES
                    .iter()
                    .any(|name| contains_bytes(&bytes, name))
        })
    })
}

fn discard_connection() {
    if let Ok(mut guard) = CONNECTION.lock() {
        *guard = None;
    }
}

fn remember_auth_validation(status: &NotebookLmAuthStatus) {
    if let Ok(mut cache) = AUTH_VALIDATION.lock() {
        *cache = Some((Instant::now(), status.clone()));
    }
}

fn clear_auth_validation() {
    if let Ok(mut cache) = AUTH_VALIDATION.lock() {
        *cache = None;
    }
}

pub fn check_auth() -> NotebookLmAuthStatus {
    if let Ok(cache) = AUTH_VALIDATION.lock() {
        if let Some((checked_at, status)) = cache.as_ref() {
            if status.authenticated && checked_at.elapsed() <= AUTH_VALIDATION_TTL {
                return NotebookLmAuthStatus {
                    authenticated: true,
                    message: "Sesión ya verificada recientemente. No fue necesario consultar NotebookLM otra vez.".to_string(),
                };
            }
        }
    }
    check_auth_fresh()
}

pub fn check_auth_fresh() -> NotebookLmAuthStatus {
    let status = match call_tool("get_health", json!({}), Duration::from_secs(60)) {
        Ok(value) if !is_tool_error(&value) => match find_bool_field(&value, "authenticated") {
            Some(true) => NotebookLmAuthStatus {
                authenticated: true,
                message: "Sesión activa. NotebookLM puede consultar tus notebooks.".to_string(),
            },
            Some(false) if persistent_profile_has_recent_google_auth() => NotebookLmAuthStatus {
                authenticated: true,
                message: "Sesión activa detectada en el perfil persistente de NotebookLM.".to_string(),
            },
            Some(false) => NotebookLmAuthStatus {
                authenticated: false,
                message: "Servidor disponible, pero falta iniciar sesión en Google.".to_string(),
            },
            None => NotebookLmAuthStatus {
                authenticated: false,
                message: "El servidor respondió, pero no devolvió un estado de autenticación reconocible.".to_string(),
            },
        },
        Ok(value) => NotebookLmAuthStatus {
            authenticated: false,
            message: format!("NotebookLM MCP devolvió un error: {}", tool_error_message(&value)),
        },
        Err(error) => NotebookLmAuthStatus { authenticated: false, message: error },
    };
    remember_auth_validation(&status);
    status
}

pub fn start_auth() -> ActionResult {
    // setup_auth es síncrono en gemini-notebook-mcp: bloquea sondeando la URL de la
    // ventana hasta ver notebooklm.google.com (hasta 10 min) y solo entonces
    // guarda las cookies, cierra el navegador y responde. Un timeout más corto
    // aquí (antes, 90 s) provocaba que matáramos el proceso a medio login,
    // dejando el navegador abierto y la sesión sin guardar.
    let response = call_tool(
        "setup_auth",
        json!({ "show_browser": true }),
        Duration::from_secs(630),
    );
    match response {
        Ok(value)
            if !is_tool_error(&value) && find_bool_field(&value, "authenticated") == Some(true) =>
        {
            let status = NotebookLmAuthStatus {
                authenticated: true,
                message: "Sesión iniciada y verificada con NotebookLM.".to_string(),
            };
            remember_auth_validation(&status);
            ActionResult::ok(status.message)
        }
        Ok(_value) if persistent_profile_has_recent_google_auth() => {
            // El MCP 2.0.0 puede perder la referencia de la pestaña durante el
            // redirect. Cerramos cualquier contexto residual y usamos el
            // perfil que Chrome ya persistió como fuente de verificación.
            discard_connection();
            let status = NotebookLmAuthStatus {
                authenticated: true,
                message:
                    "Sesión iniciada. Se verificó mediante el perfil persistente de NotebookLM."
                        .to_string(),
            };
            remember_auth_validation(&status);
            ActionResult::ok(status.message)
        }
        Ok(value) => {
            clear_auth_validation();
            discard_connection();
            ActionResult::error(format!(
                "NotebookLM MCP no pudo iniciar la autenticación: {}",
                tool_error_message(&value)
            ))
        }
        Err(error) => {
            clear_auth_validation();
            ActionResult::error(error)
        }
    }
}

fn parse_notebook_entries(value: &Value) -> Vec<NotebookLmEntry> {
    find_array_field(value, "notebooks")
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let id = find_string_field(entry, "id")?;
            if id.is_empty() {
                return None;
            }
            let url = find_string_field(entry, "url")
                .filter(|url| !url.is_empty())
                .unwrap_or_else(|| format!("https://notebook.google.com/notebook/{id}"));
            let name = find_string_field(entry, "name")
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| id.clone());
            let description = find_string_field(entry, "description").unwrap_or_default();
            Some(NotebookLmEntry {
                id,
                name,
                url,
                description,
            })
        })
        .collect()
}

pub fn list_notebooks() -> Result<Vec<NotebookLmEntry>, String> {
    let value = call_tool("list_notebooks", json!({}), Duration::from_secs(30))?;
    if is_tool_error(&value) {
        return Err(tool_error_message(&value));
    }
    Ok(parse_notebook_entries(&value))
}

/// A diferencia de `list_notebooks` (biblioteca local curada), esta consulta
/// el grid real de notebooks.google.com abriendo cada tarjeta para leer su id
/// desde la URL — por eso el timeout es mucho más generoso.
pub fn list_account_notebooks() -> Result<Vec<NotebookLmEntry>, String> {
    let value = call_tool("list_account_notebooks", json!({}), Duration::from_secs(300))?;
    if is_tool_error(&value) {
        return Err(tool_error_message(&value));
    }
    Ok(parse_notebook_entries(&value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_mcp_server_command_uses_exact_node_and_bin() {
        let command = build_managed_mcp_server_command(
            Path::new("managed-node"),
            Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-only-bin"),
        );
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(command.get_program(), std::ffi::OsStr::new("managed-node"));
        assert_eq!(args, [std::ffi::OsStr::new("managed-mcp-bin.js")]);
    }

    #[test]
    fn managed_mcp_server_command_uses_only_managed_path() {
        let command = build_managed_mcp_server_command(
            Path::new("managed-node"),
            Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-only-bin"),
        );
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .expect("PATH administrado");
        assert_eq!(path, std::ffi::OsStr::new("managed-only-bin"));
        assert!(!path.to_string_lossy().contains("host-only-bin"));
    }

    #[test]
    fn managed_mcp_server_command_does_not_override_current_dir() {
        let command = build_managed_mcp_server_command(
            Path::new("managed-node"),
            Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-only-bin"),
        );
        assert!(command.get_current_dir().is_none());
    }

    #[test]
    fn managed_mcp_server_command_has_only_public_bin_argument() {
        let command = build_managed_mcp_server_command(
            Path::new("managed-node"),
            Path::new("managed-mcp-bin.js"),
            std::ffi::OsStr::new("managed-only-bin"),
        );
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args.len(), 1);
        assert_eq!(args[0], std::ffi::OsStr::new("managed-mcp-bin.js"));
    }

    #[test]
    fn managed_server_matcher_requires_exact_node_and_bin() {
        let node = Path::new("/managed/node");
        let bin = Path::new("/managed/node_modules/@scope/pkg/bin.js");
        let valid = serde_json::json!({"command": "/managed/node", "args": ["/managed/node_modules/@scope/pkg/bin.js"]});
        assert!(server_matches_paths(&valid, node, bin));
        for server in [
            serde_json::json!({"command": "/other/node", "args": ["/managed/node_modules/@scope/pkg/bin.js"]}),
            serde_json::json!({"command": "/managed/node", "args": ["/other/bin"]}),
            serde_json::json!({"command": "/managed/node", "args": []}),
            serde_json::json!({"command": "/managed/node", "args": ["/managed/node_modules/@scope/pkg/bin.js", "--extra"]}),
            serde_json::json!({"command": "npx", "args": ["@scope/pkg@latest"]}),
            serde_json::json!({"command": "/managed/node", "args": ["@scope/pkg"]}),
            serde_json::json!({"args": ["/managed/node_modules/@scope/pkg/bin.js"]}),
        ] {
            assert!(!server_matches_paths(&server, node, bin));
        }
    }

    #[test]
    fn parses_nested_health_payload_from_mcp_text_content() {
        let value = json!({
            "result": {
                "content": [{
                    "type": "text",
                    "text": "{\"success\":true,\"data\":{\"authenticated\":true}}"
                }]
            }
        });
        assert_eq!(find_bool_field(&value, "authenticated"), Some(true));
        assert!(!is_tool_error(&value));
    }

    #[test]
    fn recognizes_nested_tool_failure_and_extracts_message() {
        let value = json!({
            "result": {
                "content": [{
                    "type": "text",
                    "text": "{\"success\":false,\"error\":\"Authentication failed or was cancelled\"}"
                }]
            }
        });
        assert!(is_tool_error(&value));
        assert_eq!(
            tool_error_message(&value),
            "Authentication failed or was cancelled"
        );
    }

    #[test]
    fn byte_search_finds_cookie_names_without_decoding_sqlite() {
        let data = b"sqlite-prefix-SAPISID-value-__Secure-1PSID-suffix";
        assert!(contains_bytes(data, b"SAPISID"));
        assert!(!contains_bytes(data, b"APISID3"));
    }

    #[test]
    fn finds_notebooks_array_nested_inside_mcp_text_content() {
        let value = json!({
            "result": {
                "content": [{
                    "type": "text",
                    "text": "{\"success\":true,\"data\":{\"notebooks\":[{\"id\":\"n8n-docs\",\"url\":\"https://notebooklm.google.com/notebook/n8n-docs\",\"name\":\"n8n Workflow Automation\",\"description\":\"docs\"}]}}"
                }],
                "isError": false
            }
        });
        let entries = find_array_field(&value, "notebooks").expect("notebooks array");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["id"], "n8n-docs");
        assert!(!is_tool_error(&value));
    }

    #[test]
    fn find_array_field_does_not_match_unrelated_arrays() {
        let value = json!({ "result": { "content": [{ "type": "text", "text": "{}" }] } });
        assert_eq!(find_array_field(&value, "notebooks"), None);
    }

    #[test]
    fn successful_auth_validation_is_reused() {
        let status = NotebookLmAuthStatus {
            authenticated: true,
            message: "verified".to_string(),
        };
        remember_auth_validation(&status);
        let cached = check_auth();
        assert!(cached.authenticated);
        assert!(cached.message.contains("recientemente"));
        clear_auth_validation();
    }

    #[test]
    fn configures_codex_mcp_without_disturbing_unrelated_toml_and_flags_a_stale_duplicate() {
        let dir = std::env::temp_dir().join(format!(
            "jintia-codex-mcp-test-{}",
            crate::paths::timestamp()
        ));
        fs::create_dir_all(&dir).unwrap();
        let previous_codex_home = std::env::var_os("CODEX_HOME");
        std::env::set_var("CODEX_HOME", &dir);

        fs::write(
            dir.join("config.toml"),
            "model = \"gpt-5.6-luna\"\n\n[projects.'D:\\Curso']\ntrust_level = \"trusted\"\n\n[mcp_servers.notebooklm]\ncommand = \"npx\"\nargs = [\"notebooklm-mcp@latest\"]\n\n[mcp_servers.gemini-notebook]\ncommand = \"npx\"\nargs = [\"@charlie.act7/gemini-notebook-mcp@latest\"]\n",
        )
        .unwrap();

        let managed_mcp_installed = crate::release::managed_mcp_contract()
            .ok()
            .is_some_and(|contract| crate::runtimes::portable_notebooklm_mcp_installed_for(&contract));
        if !crate::paths::portable_node_exe().is_file() || !managed_mcp_installed {
            let result = configure_codex_mcp();
            assert!(!result.success);
            assert!(result.message.contains("Node.js administrado"));
            fs::remove_dir_all(&dir).ok();
            match previous_codex_home {
                Some(value) => std::env::set_var("CODEX_HOME", value),
                None => std::env::remove_var("CODEX_HOME"),
            }
            return;
        }

        let result = configure_codex_mcp();
        assert!(result.success, "{}", result.message);
        assert!(result.message.contains("Codex CLI"));
        assert!(
            result.message.contains("mcp_servers.gemini-notebook"),
            "avisa del servidor duplicado bajo otro nombre: {}",
            result.message
        );

        let text = fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(text.contains("model = \"gpt-5.6-luna\""), "preserva claves ajenas");
        assert!(text.contains("[projects.'D:\\Curso']"), "preserva otras tablas");
        assert!(text.contains("[mcp_servers.notebooklm]"));
        assert!(!text.contains(&format!("dist/{}", "index.js")));
        assert!(text.contains("managed_mcp_contract"));
        assert!(!text.contains("notebooklm-mcp@latest"), "reemplaza el paquete viejo en notebooklm");
        assert!(text.contains("[mcp_servers.gemini-notebook]"), "no toca el servidor duplicado, solo avisa");

        let second = configure_codex_mcp();
        assert!(second.success);
        assert!(second.message.contains("ya estaba configurado"), "es idempotente");

        fs::remove_dir_all(&dir).ok();
        match previous_codex_home {
            Some(value) => std::env::set_var("CODEX_HOME", value),
            None => std::env::remove_var("CODEX_HOME"),
        }
    }

    #[test]
    fn managed_node_versions_match_mcp_requirement() {
        let requirement = VersionReq::parse(">=22.13.0").unwrap();
        for version in ["v22.13.0", "22.14.0", "v23.0.0"] {
            assert!(requirement.matches(&parse_node_version(version).unwrap()));
        }
        assert!(!requirement.matches(&parse_node_version("v22.12.0").unwrap()));
        assert!(parse_node_version("not-a-version").is_err());
        assert!(VersionReq::parse("not-a-range").is_err());
    }
}
