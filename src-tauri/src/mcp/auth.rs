use crate::mcp::client::{call_tool, call_tool_internal, is_tool_error, tool_error_message};
use crate::models::{ActionResult, LongOperationStatus, NotebookLmAuthStatus};
use serde_json::json;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

const AUTH_STATE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const AUTH_VALIDATION_TTL: Duration = Duration::from_secs(5 * 60);
const GOOGLE_API_AUTH_COOKIE: &[u8] = b"SAPISID";
const GOOGLE_SECURE_AUTH_COOKIES: [&[u8]; 2] = [b"__Secure-1PSID", b"__Secure-3PSID"];
pub(crate) static AUTH_VALIDATION: Mutex<Option<(Instant, NotebookLmAuthStatus)>> =
    Mutex::new(None);
pub(crate) static AUTH_CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);
pub(crate) static AUTH_OPERATION: Mutex<Option<String>> = Mutex::new(None);
pub(crate) const AUTH_CANCELLED: &str = "AUTH_CANCELLED";

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

pub fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
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

pub(crate) fn discard_connection() {
    if let Ok(mut guard) = crate::mcp::client::CONNECTION.lock() {
        *guard = None;
    }
}

pub(crate) fn remember_auth_validation(status: &NotebookLmAuthStatus) {
    if let Ok(mut cache) = AUTH_VALIDATION.lock() {
        *cache = Some((Instant::now(), status.clone()));
    }
}

pub(crate) fn clear_auth_validation() {
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
    use crate::mcp::client::find_bool_field;
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

fn auth_operation_status(
    operation_id: &str,
    state: &str,
    phase: &str,
    message: impl Into<String>,
    browser_open: bool,
) -> LongOperationStatus {
    LongOperationStatus {
        operation_id: operation_id.to_string(),
        state: state.to_string(),
        phase: phase.to_string(),
        message: message.into(),
        percent: None,
        cancellable: matches!(state, "working" | "checking"),
        browser_open,
    }
}

pub fn cancel_auth(operation_id: &str) -> ActionResult {
    let active = AUTH_OPERATION
        .lock()
        .ok()
        .and_then(|operation| operation.clone());
    match active {
        Some(active_id) if active_id == operation_id => {
            AUTH_CANCEL_REQUESTED.store(true, Ordering::SeqCst);
            ActionResult::ok("Cancelando la autenticación y cerrando el navegador…")
        }
        Some(_) => ActionResult::error("Hay otra autenticación activa; no se modificó."),
        None => ActionResult::ok("La autenticación ya había terminado."),
    }
}

pub fn start_auth_operation<F>(operation_id: String, emit: F) -> ActionResult
where
    F: Fn(LongOperationStatus),
{
    {
        let Ok(mut active) = AUTH_OPERATION.lock() else {
            return ActionResult::error("No se pudo reservar la operación de NotebookLM.");
        };
        if let Some(active_id) = active.as_ref() {
            return ActionResult::error(format!(
                "Ya hay una autenticación de NotebookLM activa ({active_id})."
            ));
        }
        *active = Some(operation_id.clone());
    }
    AUTH_CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    emit(auth_operation_status(
        &operation_id,
        "working",
        "opening_browser",
        "Se abrirá una ventana de Google. Inicia sesión y vuelve a Jintia.",
        true,
    ));

    // setup_auth es síncrono en gemini-notebook-mcp: bloquea sondeando la URL de la
    // ventana hasta ver notebooklm.google.com (hasta 10 min) y solo entonces
    // guarda las cookies, cierra el navegador y responde. Un timeout más corto
    // aquí (antes, 90 s) provocaba que matáramos el proceso a medio login,
    // dejando el navegador abierto y la sesión sin guardar.
    emit(auth_operation_status(
        &operation_id,
        "working",
        "waiting_for_login",
        "Esperando que completes el inicio de sesión en Google…",
        true,
    ));
    let response = call_tool_internal(
        "setup_auth",
        json!({ "show_browser": true }),
        Duration::from_secs(630),
        true,
    );
    if response.is_ok() {
        emit(auth_operation_status(
            &operation_id,
            "checking",
            "verifying",
            "Verificando la sesión guardada…",
            false,
        ));
    }
    use crate::mcp::client::find_bool_field;
    let result = match response {
        Ok(value)
            if !is_tool_error(&value) && find_bool_field(&value, "authenticated") == Some(true) =>
        {
            let status = NotebookLmAuthStatus {
                authenticated: true,
                message: "Sesión iniciada y verificada con NotebookLM.".to_string(),
            };
            remember_auth_validation(&status);
            let result = ActionResult::ok(status.message);
            emit(auth_operation_status(
                &operation_id,
                "success",
                "done",
                &result.message,
                false,
            ));
            result
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
            let result = ActionResult::ok(status.message);
            emit(auth_operation_status(
                &operation_id,
                "success",
                "done",
                &result.message,
                false,
            ));
            result
        }
        Ok(value) => {
            clear_auth_validation();
            discard_connection();
            let result = ActionResult::error(format!(
                "NotebookLM MCP no pudo iniciar la autenticación: {}",
                tool_error_message(&value)
            ));
            emit(auth_operation_status(
                &operation_id,
                "error",
                "error",
                &result.message,
                false,
            ));
            result
        }
        Err(error) if error == AUTH_CANCELLED => {
            clear_auth_validation();
            discard_connection();
            let result = ActionResult::error(
                "Autenticación cancelada. Puedes intentarlo de nuevo cuando quieras.",
            );
            emit(auth_operation_status(
                &operation_id,
                "cancelled",
                "cancelled",
                &result.message,
                false,
            ));
            result
        }
        Err(error) => {
            clear_auth_validation();
            discard_connection();
            let result = ActionResult::error(error);
            emit(auth_operation_status(
                &operation_id,
                "error",
                "error",
                &result.message,
                false,
            ));
            result
        }
    };
    AUTH_CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    if let Ok(mut active) = AUTH_OPERATION.lock() {
        if active.as_deref() == Some(operation_id.as_str()) {
            *active = None;
        }
    }
    result
}

pub fn start_auth() -> ActionResult {
    start_auth_operation("legacy-auth".to_string(), |_| {})
}
