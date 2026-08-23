/*!
 * Módulo de integración con el CLI `claude` (Claude Code) en modo headless.
 *
 * A diferencia de Codex (un `app-server` persistente con JSON-RPC sobre
 * stdio, ver `codex/mod.rs`), Claude Code headless no expone un servidor de
 * larga duración: cada turno es una invocación nueva de
 * `claude -p "<mensaje>" --output-format stream-json ...`, que imprime NDJSON
 * por stdout y termina. Por eso `ClaudeManager` no gestiona un único proceso
 * sino un mapa de procesos activos por `request_id` (mismo patrón que
 * `opencode/manager.rs`, que mapea procesos por curso).
 *
 * La continuidad de la conversación no depende de mantener el proceso vivo,
 * sino del `session_id` que Claude devuelve en la primera línea
 * `system/init`: turnos siguientes lo pasan de vuelta con `--resume`.
 *
 * Flags usados aquí verificados contra cli-reference.md / headless.md /
 * authentication.md (code.claude.com), y además contra ejecuciones reales
 * del CLI (`claude` 2.1.229): `-p`, `--output-format stream-json`,
 * `--verbose`, `--include-partial-messages`, `--resume`, `--model`,
 * `--append-system-prompt`, `--tools`, `--permission-mode`. NO se usa
 * `--bare` (desactivaría OAuth de suscripción, skills, MCP y CLAUDE.md) ni
 * `--dangerously-skip-permissions`.
 *
 * Hallazgo importante confirmado con llamadas reales (incluso en una
 * carpeta que el CLI nunca había visto, para descartar que fuera solo un
 * proyecto ya "de confianza"): en modo headless (`-p`, sin TTY), NI
 * `--allowedTools` NI `--permission-mode` bloquean nada — sin terminal para
 * preguntar, Claude simplemente ejecuta la herramienta pedida igual,
 * `permission_denials` queda vacío, y no hay ningún cuelgue. La única forma
 * real de restringir qué puede hacer Claude en este modo es `--tools`, que
 * quita la herramienta del conjunto DISPONIBLE para el modelo (confirmado:
 * con `--tools "Read"` el propio modelo responde que no tiene Bash
 * disponible, en vez de intentarlo). Por eso este módulo usa `--tools`, no
 * `--allowedTools`. Nota: `--tools` solo cubre el conjunto de herramientas
 * *built-in* (Bash, Edit, Write, Read, Glob, Grep, ...) — no restringe qué
 * servidores/herramientas MCP quedan disponibles (eso viene de la
 * configuración MCP global del usuario, cargada automáticamente al no usar
 * `--bare`); acotar eso queda pendiente para una iteración futura.
 */

pub mod models;
pub mod stream;

pub use models::{ClaudeStatus, ClaudeTurnRequest};

use std::collections::HashMap;
use std::io::BufRead;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

/// Construye los argumentos de `claude -p ...` para un turno. Función pura
/// (sin I/O) para poder probarla sin depender de tener el CLI instalado.
fn build_submit_args(
    request: &ClaudeTurnRequest,
    tools: Option<&[String]>,
    permission_mode: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        request.message.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    if let Some(session_id) = &request.session_id {
        args.push("--resume".to_string());
        args.push(session_id.clone());
    }
    if let Some(model) = &request.model {
        args.push("--model".to_string());
        args.push(model.clone());
    }
    if let Some(context) = &request.context {
        args.push("--append-system-prompt".to_string());
        args.push(context.clone());
    }
    if let Some(tools) = tools {
        if !tools.is_empty() {
            args.push("--tools".to_string());
            args.push(tools.join(","));
        }
    }
    if let Some(mode) = permission_mode {
        args.push("--permission-mode".to_string());
        args.push(mode.to_string());
    }
    args
}

/// Extrae `loggedIn` de la salida ya parseada de `claude auth status`.
/// Función pura para poder probarla con el fixture real capturado, sin
/// depender de tener el CLI instalado en la máquina que corre los tests.
fn is_logged_in(auth: &Option<serde_json::Value>) -> bool {
    auth.as_ref()
        .and_then(|v| v.get("loggedIn"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

pub struct ClaudeManager {
    active: Arc<Mutex<HashMap<String, Child>>>,
}

impl ClaudeManager {
    pub fn new() -> Self {
        Self { active: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// Busca el binario `claude` en el PATH, igual que `CodexManager::find_binary`.
    pub fn find_binary() -> Option<String> {
        let candidates: &[&str] = if cfg!(windows) {
            &["claude.cmd", "claude", "claude.exe"]
        } else {
            &["claude"]
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

    fn read_version(binary: &str) -> Option<String> {
        let output = std::process::Command::new(binary)
            .arg("--version")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() { None } else { Some(text) }
    }

    /// Lee `claude auth status`, confirmado contra una instalación real (CLI
    /// 2.1.229): imprime un único objeto JSON por stdout con la forma
    /// `{ loggedIn, authMethod, apiProvider, email, orgId, orgName,
    /// subscriptionType }`, sin ningún token. `loggedIn: false` cuando no hay
    /// sesión iniciada.
    fn read_auth_status(binary: &str) -> Option<serde_json::Value> {
        let output = std::process::Command::new(binary)
            .args(["auth", "status"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        serde_json::from_slice(&output.stdout).ok()
    }

    pub fn status(&self) -> ClaudeStatus {
        let binary = Self::find_binary();
        let installed = binary.is_some();
        let version = binary.as_deref().and_then(Self::read_version);
        let auth = binary.as_deref().and_then(Self::read_auth_status);
        let authenticated = is_logged_in(&auth);
        let using_api_key = std::env::var("ANTHROPIC_API_KEY").is_ok();
        ClaudeStatus { installed, authenticated, version, using_api_key, auth }
    }

    /// Lanza un turno como proceso nuevo y emite eventos Tauri `claude:*` a
    /// medida que llegan líneas NDJSON por stdout. No bloquea: la lectura
    /// ocurre en un hilo separado, igual que el hilo lector de `codex/mod.rs`.
    pub fn submit_turn(
        &self,
        app: tauri::AppHandle,
        request: ClaudeTurnRequest,
        tools: Option<Vec<String>>,
        permission_mode: Option<String>,
    ) -> Result<(), String> {
        let binary = Self::find_binary().ok_or_else(|| {
            "Claude Code CLI no encontrado. Instálalo con: npm install -g @anthropic-ai/claude-code".to_string()
        })?;
        let args = build_submit_args(&request, tools.as_deref(), permission_mode.as_deref());

        let mut cmd = std::process::Command::new(&binary);
        cmd.args(&args)
            .current_dir(&request.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = crate::process::supervisor()
            .spawn(cmd)
            .map_err(|e| format!("No se pudo iniciar Claude Code: {e}"))?;

        let stdout = child.stdout.take().ok_or("No se pudo capturar stdout de Claude Code")?;
        let stderr = child.stderr.take();
        let request_id = request.request_id.clone();
        let mut session_id = request.session_id.clone();

        eprintln!(
            "[claude] turn started request_id={} cwd={} resume={} model={}",
            request_id,
            request.cwd,
            request.session_id.is_some(),
            request.model.as_deref().unwrap_or("auto")
        );

        if let Some(stderr) = stderr {
            let diagnostic_request_id = request_id.clone();
            std::thread::spawn(move || {
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        eprintln!("[claude][{}][stderr] {}", diagnostic_request_id, trimmed);
                    }
                }
            });
        }

        self.active.lock().unwrap().insert(request_id.clone(), child);

        let active = self.active.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match stream::classify_line(trimmed) {
                    Ok(Some(raw)) => {
                        eprintln!("[claude][{}] event={}", request_id, raw.event_kind());
                        let event = stream::to_claude_event(raw, &request_id, &mut session_id);
                        let _ = app.emit(event.event_name(), &event);
                    }
                    Ok(None) => {}
                    Err(e) => {
                        eprintln!("[claude][{}] invalid-json: {}", request_id, e);
                    }
                }
            }
            eprintln!("[claude] turn stdout closed request_id={}", request_id);
            active.lock().unwrap().remove(&request_id);
        });

        Ok(())
    }

    /// Lanza `claude auth login` (flujo OAuth de suscripción) en segundo
    /// plano y retorna de inmediato, sin esperar a que el usuario termine de
    /// iniciar sesión en el navegador — mismo patrón que
    /// `CodexManager::start_login`. A diferencia de Codex (que devuelve la
    /// URL de auth por JSON-RPC para que Jintia la abra), `claude auth login`
    /// abre el navegador por su cuenta (confirmado por `--help`: "Sign in to
    /// your Anthropic account", sin ninguna opción de imprimir la URL en vez
    /// de abrirla), así que aquí no hay URL que capturar. El llamador debe
    /// volver a consultar `status()` pasados unos segundos para confirmar si
    /// el login se completó.
    ///
    /// No probado en vivo contra una sesión real (arrancarlo mientras ya hay
    /// una sesión activa podría reiniciar el flujo de login de esa sesión, y
    /// no quise arriesgar la sesión de suscripción real usada durante el
    /// desarrollo de este módulo). El botón de Ajustes que lo use debe
    /// mostrarse solo cuando `status().authenticated` sea `false`.
    pub fn start_login(&self) -> Result<(), String> {
        let binary = Self::find_binary().ok_or_else(|| {
            "Claude Code CLI no encontrado. Instálalo con: npm install -g @anthropic-ai/claude-code".to_string()
        })?;
        std::process::Command::new(&binary)
            .args(["auth", "login"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("No se pudo iniciar sesión con Claude Code: {e}"))?;
        Ok(())
    }

    /// Detiene el proceso de un turno en curso (botón "Detener" de Ask Jintia).
    pub fn interrupt_turn(&self, request_id: &str) -> Result<(), String> {
        let mut active = self.active.lock().unwrap();
        if let Some(mut child) = active.remove(request_id) {
            crate::process::kill_child_tree(&mut child);
        }
        Ok(())
    }

    /// Mata todos los procesos `claude` activos. Se llama al cerrar la ventana
    /// de Jintia, igual que `OpenCodeManager::stop_all`, para no dejar
    /// procesos huérfanos.
    pub fn stop_all(&self) {
        let mut active = self.active.lock().unwrap();
        for (_, mut child) in active.drain() {
            crate::process::kill_child_tree(&mut child);
        }
    }
}

impl Default for ClaudeManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_request() -> ClaudeTurnRequest {
        ClaudeTurnRequest {
            request_id: "req-1".to_string(),
            session_id: None,
            cwd: "/curso".to_string(),
            message: "Hola".to_string(),
            model: None,
            context: None,
        }
    }

    #[test]
    fn first_turn_has_no_resume_flag() {
        let args = build_submit_args(&base_request(), None, None);
        assert!(!args.contains(&"--resume".to_string()));
        assert_eq!(args[0], "-p");
        assert_eq!(args[1], "Hola");
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--verbose".to_string()));
        assert!(args.contains(&"--include-partial-messages".to_string()));
    }

    #[test]
    fn follow_up_turn_passes_resume_with_session_id() {
        let mut request = base_request();
        request.session_id = Some("abc-123".to_string());
        let args = build_submit_args(&request, None, None);
        let idx = args.iter().position(|a| a == "--resume").expect("--resume presente");
        assert_eq!(args[idx + 1], "abc-123");
    }

    #[test]
    fn model_and_context_are_passed_through_when_present() {
        let mut request = base_request();
        request.model = Some("sonnet".to_string());
        request.context = Some("Asignatura: IFT200".to_string());
        let args = build_submit_args(&request, None, None);
        let model_idx = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[model_idx + 1], "sonnet");
        let ctx_idx = args.iter().position(|a| a == "--append-system-prompt").unwrap();
        assert_eq!(args[ctx_idx + 1], "Asignatura: IFT200");
    }

    #[test]
    fn model_and_context_are_omitted_when_absent() {
        let args = build_submit_args(&base_request(), None, None);
        assert!(!args.contains(&"--model".to_string()));
        assert!(!args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn tools_are_joined_with_commas() {
        // --tools, no --allowedTools: confirmado con el CLI real que
        // --allowedTools no restringe nada en modo headless (sin TTY, no hay
        // prompt que bloquear, así que Claude ejecuta la herramienta igual),
        // mientras que --tools sí quita la herramienta del conjunto
        // disponible para el modelo.
        let tools = vec!["Read".to_string(), "Glob".to_string(), "Grep".to_string()];
        let args = build_submit_args(&base_request(), Some(&tools), None);
        let idx = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[idx + 1], "Read,Glob,Grep");
    }

    #[test]
    fn empty_tools_list_omits_the_flag() {
        let tools: Vec<String> = vec![];
        let args = build_submit_args(&base_request(), Some(&tools), None);
        assert!(!args.contains(&"--tools".to_string()));
    }

    #[test]
    fn permission_mode_is_passed_through_verbatim() {
        let args = build_submit_args(&base_request(), None, Some("plan"));
        let idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[idx + 1], "plan");
    }

    // Fixture real capturado con `claude auth status` (CLI 2.1.229) en una
    // sesión con suscripción activa. Confirma la forma exacta del JSON: sin
    // token, con `loggedIn` como booleano de nivel superior.
    #[test]
    fn is_logged_in_reads_real_auth_status_payload() {
        let auth: serde_json::Value = serde_json::from_str(
            r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"user@example.com","orgId":"org-1","orgName":"Ejemplo","subscriptionType":"team"}"#,
        )
        .unwrap();
        assert!(is_logged_in(&Some(auth)));
    }

    #[test]
    fn is_logged_in_is_false_when_logged_out_or_missing() {
        let logged_out: serde_json::Value = serde_json::from_str(r#"{"loggedIn":false}"#).unwrap();
        assert!(!is_logged_in(&Some(logged_out)));
        assert!(!is_logged_in(&None));
    }
}
