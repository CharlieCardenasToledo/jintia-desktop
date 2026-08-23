use super::client::OpenCodeClient;
use super::models::{RuntimeInfo, RuntimeStatus};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct OpenCodeProcess {
    child: Child,
    port: u16,
}

const JINTIA_AGENTS_START: &str = "<!-- jintia:ask-context:start -->";
const JINTIA_AGENTS_END: &str = "<!-- jintia:ask-context:end -->";

/// Resuelve el idioma base del curso/desktop para inyectar en AGENTS.md.
/// Prioridad: .jintia/course.json → institution.json (si tuviera lang) → settings.json → "es"
fn resolve_base_language(course_path: &Path) -> String {
    // 1. .jintia/course.json lang
    let course_cfg = course_path.join(".jintia").join("course.json");
    if let Ok(text) = std::fs::read_to_string(&course_cfg) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(lang) = v.get("lang").and_then(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                return lang;
            }
            if let Some(lang) = v.get("baseLanguage").and_then(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                return lang;
            }
        }
    }
    // 2. app_config institution.json lang
    if let Ok(dir) = crate::paths::app_config_dir() {
        let inst = dir.join("institution.json");
        if let Ok(text) = std::fs::read_to_string(&inst) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(lang) = v.get("lang").and_then(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                    return lang;
                }
                if let Some(lang) = v.get("baseLanguage").and_then(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                    return lang;
                }
            }
        }
        let settings = dir.join("settings.json");
        if let Ok(text) = std::fs::read_to_string(&settings) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(lang) = v.get("baseLanguage").and_then(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                    return lang;
                }
                if let Some(lang) = v.get("lang").and_then(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                    return lang;
                }
            }
        }
    }
    "es".to_string()
}

fn build_agents_context(lang: &str) -> String {
    format!(
        "<!-- jintia:ask-context:start -->\n## Ask Jintia\n\nUsa la skill instalada `jintia-skill` para tareas académicas de Jintia. El flujo editorial vigente es `guide.json` → HTML → Vivliostyle. No crees guías LaTeX ni ejecutes `pdflatex`. Responde siempre en {lang} con tono profesional y cercano.\n<!-- jintia:ask-context:end -->"
    )
}

pub struct OpenCodeManager {
    processes: Mutex<HashMap<String, OpenCodeProcess>>,
}

impl OpenCodeManager {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn find_opencode() -> Option<PathBuf> {
        let portable = crate::paths::portable_opencode_bin();
        if portable.is_file() {
            return Some(portable);
        }

        #[cfg(target_os = "windows")]
        {
            // npm global en APPDATA\npm
            if let Ok(appdata) = std::env::var("APPDATA") {
                let candidate = PathBuf::from(appdata).join("npm").join("opencode.cmd");
                if candidate.exists() {
                    return Some(candidate);
                }
            }
            // npm global alternativo en LOCALAPPDATA
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let candidate = PathBuf::from(local).join("npm").join("opencode.cmd");
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            for dir in std::env::var("PATH").unwrap_or_default().split(':') {
                let candidate = PathBuf::from(dir).join("opencode");
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
        None
    }

    pub(crate) fn is_installed() -> bool {
        Self::find_opencode().is_some()
    }

    /// Escribe (o actualiza) `opencode.json` en el directorio del curso con la
    /// configuración del servidor MCP de NotebookLM. OpenCode lee este archivo al
    /// arrancar para registrar los servidores MCP disponibles para la Skill de Jintia.
    /// Si el MCP administrado no está instalado, se omite sin error.
    fn write_opencode_mcp_config(course_path: &Path) -> Result<(), String> {
        let managed = crate::mcp::managed_mcp()?;
        let managed_path = crate::mcp::managed_node_runtime_path_text()?;

        let config_path = course_path.join("opencode.json");
        let mut config: serde_json::Value = if config_path.exists() {
            std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
                .unwrap_or_else(|| json!({}))
        } else {
            json!({})
        };

        if !config.get("mcp").is_some_and(|v| v.is_object()) {
            config["mcp"] = json!({});
        }
        config["mcp"]["notebooklm"] = json!({
            "type": "local",
            "command": [
                managed.node.to_string_lossy().as_ref(),
                managed.bin.to_string_lossy().as_ref()
            ],
            "env": {
                "PATH": managed_path
            },
            // Sin esto, OpenCode aplica su propio timeout por defecto al
            // llamar herramientas MCP, más corto que lo que el servidor de
            // NotebookLM puede tardar en una respuesta larga (hasta 10 min
            // más margen). Sin este valor explícito, OpenCode cortaba la
            // llamada antes de que la respuesta real llegara, forzando
            // reintentos en cascada aunque el servidor MCP seguía trabajando.
            "timeout": 660_000
        });

        let bytes = serde_json::to_vec_pretty(&config)
            .map_err(|e| format!("No se pudo serializar opencode.json: {e}"))?;
        crate::paths::atomic_write(&config_path, &bytes)
    }

    /// Copia el archivo `notebooks.json` global al subdirectorio `config/` del
    /// curso para que la Skill de Jintia lo encuentre vía ruta relativa desde
    /// el CWD que usa OpenCode. Se omite silenciosamente si la fuente no existe.
    fn sync_notebooks_to_course(course_path: &Path) {
        let src = match crate::paths::app_config_dir() {
            Ok(dir) => dir.join("notebooks.json"),
            Err(_) => return,
        };
        if !src.is_file() {
            return;
        }
        let Ok(bytes) = std::fs::read(&src) else { return };
        let dest = course_path.join("config").join("notebooks.json");
        let _ = crate::paths::atomic_write_if_changed(&dest, &bytes);
    }

    /// PATH para el proceso `opencode serve`: antepone el bin del Node
    /// administrado por Jintia al PATH heredado del sistema (no lo
    /// reemplaza, a diferencia del PATH aislado que usa el MCP de
    /// NotebookLM), para que la tool bash del agente conserve acceso a git y
    /// demás utilidades normales del sistema.
    fn managed_process_path() -> std::ffi::OsString {
        let mut dirs = vec![crate::paths::portable_node_bin_dir()];
        if let Some(existing) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&existing));
        }
        std::env::join_paths(dirs).unwrap_or_default()
    }

    fn free_port() -> u16 {
        use std::net::TcpListener;
        TcpListener::bind("127.0.0.1:0")
            .map(|l| l.local_addr().unwrap().port())
            .unwrap_or(14200)
    }

    fn ensure_jintia_agents_context(course_path: &Path) -> Result<(), String> {
        let lang = resolve_base_language(course_path);
        let context = build_agents_context(&lang);
        let path = course_path.join("AGENTS.md");
        let previous = std::fs::read_to_string(&path).unwrap_or_default();
        let next = if let Some(start) = previous.find(JINTIA_AGENTS_START) {
            if let Some(relative_end) = previous[start..].find(JINTIA_AGENTS_END) {
                let end = start + relative_end + JINTIA_AGENTS_END.len();
                format!("{}{}{}", &previous[..start], context, &previous[end..])
            } else {
                format!("{}\n\n{context}\n", previous.trim_end())
            }
        } else if previous.trim().is_empty() {
            format!("# Instrucciones de la asignatura\n\n{context}\n")
        } else {
            format!("{}\n\n{context}\n", previous.trim_end())
        };
        if next != previous {
            crate::paths::atomic_write(&path, next.as_bytes())?;
        }
        Ok(())
    }

    pub fn start(&self, course_path: &str) -> Result<RuntimeInfo, String> {
        let key = course_path.to_string();
        let work_dir = Path::new(course_path);

        // OpenCode lee AGENTS.md al arrancar. El bloque administrado conserva
        // instrucciones del usuario y se actualiza cuando cambia el contrato.
        Self::ensure_jintia_agents_context(work_dir)?;

        // Inyecta opencode.json con el servidor MCP de NotebookLM para que la
        // Skill de Jintia pueda llamar ask_question directamente, sin caer en
        // el fallback de Python/patchright. Si el MCP aún no está instalado se
        // omite sin error — OpenCode arranca igualmente.
        // Se escribe siempre (incluso si OpenCode ya corre) para que el archivo
        // esté actualizado cuando el proceso se reinicie.
        let _ = Self::write_opencode_mcp_config(work_dir);
        // Copia notebooks.json al directorio del curso para que la Skill lo
        // encuentre por ruta relativa (config/notebooks.json) sin requerir que
        // el usuario haya vuelto a guardar la config desde el onboarding.
        Self::sync_notebooks_to_course(work_dir);

        // Reusar proceso existente si ya está sano
        {
            let procs = self.processes.lock().unwrap();
            if let Some(proc) = procs.get(&key) {
                let client = OpenCodeClient::new(proc.port);
                if client.health().map(|h| h.healthy).unwrap_or(false) {
                    return Ok(RuntimeInfo {
                        course_path: key,
                        port: proc.port,
                        status: RuntimeStatus::Ready,
                    });
                }
            }
        }

        // Preferimos siempre el binario del runtime Node administrado por
        // Jintia sobre una instalación global del usuario: así el agente que
        // arranca (y el PATH que le pasamos abajo) coinciden en cualquier
        // máquina con lo que la app ya verificó, en vez de depender de que
        // el usuario haya instalado opencode-ai globalmente por su cuenta.
        let bin = match Self::find_opencode() {
            Some(bin) => bin,
            None => {
                eprintln!("[opencode] binario no encontrado; instalando opencode-ai en el runtime Node administrado…");
                crate::runtimes::install_opencode()?;
                Self::find_opencode().ok_or_else(|| {
                    "OpenCode se instaló pero no se encontró el binario administrado.".to_string()
                })?
            }
        };

        let port = Self::free_port();
        eprintln!("[opencode] starting course={} binary={} port={}", work_dir.display(), bin.display(), port);

        // El proceso hereda el PATH del sistema (para que su tool bash siga
        // viendo git y demás utilidades normales), pero con el bin del Node
        // administrado por Jintia primero: cualquier `node`/`npm`/`vivliostyle`
        // que el agente invoque desde su tool bash resuelve de forma
        // consistente al mismo runtime que la app ya verificó, en lugar de
        // depender de lo que esta máquina en particular tenga instalado
        // globalmente.
        let managed_path = Self::managed_process_path();

        // El proceso no se inserta en el HashMap hasta que el health check
        // pasa, por lo que en timeout hay que matar explícitamente al Child
        // huérfano (fix P0 — procesos huérfanos). Ocultar ventana / aislar
        // grupo de procesos ya no se decide aquí: lo aplica
        // process::supervisor() de forma uniforme para todo proceso
        // administrado (OpenCode, Claude, Codex, NotebookLM MCP).
        #[cfg(target_os = "windows")]
        let mut cmd = {
            let mut cmd = Command::new("cmd");
            cmd.args([
                "/c",
                bin.to_str().unwrap_or("opencode.cmd"),
                "serve",
                "--hostname",
                "127.0.0.1",
                "--port",
                &port.to_string(),
            ]);
            cmd
        };
        #[cfg(not(target_os = "windows"))]
        let mut cmd = {
            let mut cmd = Command::new(bin);
            cmd.args(["serve", "--hostname", "127.0.0.1", "--port", &port.to_string()]);
            cmd
        };
        cmd.current_dir(work_dir)
            .env("OPENCODE_DISABLE_AUTOUPDATE", "true")
            .env("PATH", &managed_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        let mut child = crate::process::supervisor()
            .spawn(cmd)
            .map_err(|e| format!("No se pudo iniciar OpenCode: {e}"))?;

        // Esperar hasta 20s a que el proceso esté listo
        let client = OpenCodeClient::new(port);
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if Instant::now() > deadline {
                eprintln!("[opencode] startup timeout course={} port={} — killing orphan", work_dir.display(), port);
                let _ = child.kill();
                // Esperar breve para que el árbol termine
                std::thread::sleep(Duration::from_millis(200));
                return Err("OpenCode tardó demasiado en arrancar (>20s).".to_string());
            }
            if client.health().map(|h| h.healthy).unwrap_or(false) {
                break;
            }
            // Si el proceso murió prematuramente, abortar temprano
            if let Ok(None) = child.try_wait() {} else if let Ok(Some(status)) = child.try_wait() {
                eprintln!("[opencode] process exited early status={:?} course={}", status, work_dir.display());
                return Err(format!("OpenCode terminó inesperadamente (status: {status:?})."));
            }
            std::thread::sleep(Duration::from_millis(500));
        }

        self.processes
            .lock()
            .unwrap()
            .insert(key.clone(), OpenCodeProcess { child, port });

        eprintln!("[opencode] ready course={} port={}", work_dir.display(), port);

        Ok(RuntimeInfo {
            course_path: key,
            port,
            status: RuntimeStatus::Ready,
        })
    }

    fn kill_child_tree(child: &mut Child) {
        crate::process::kill_child_tree(child);
    }

    pub fn stop(&self, course_path: &str) {
        if let Some(mut proc) = self.processes.lock().unwrap().remove(course_path) {
            Self::kill_child_tree(&mut proc.child);
            // Grace period + ensure terminated
            std::thread::sleep(Duration::from_millis(100));
            let _ = proc.child.try_wait();
        }
    }

    pub fn stop_all(&self) {
        let mut procs = self.processes.lock().unwrap();
        for (_, mut proc) in procs.drain() {
            Self::kill_child_tree(&mut proc.child);
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    pub fn health(&self, course_path: &str) -> RuntimeInfo {
        let procs = self.processes.lock().unwrap();
        if let Some(proc) = procs.get(course_path) {
            let client = OpenCodeClient::new(proc.port);
            let ok = client.health().map(|h| h.healthy).unwrap_or(false);
            RuntimeInfo {
                course_path: course_path.to_string(),
                port: proc.port,
                status: if ok { RuntimeStatus::Ready } else { RuntimeStatus::Offline },
            }
        } else {
            RuntimeInfo {
                course_path: course_path.to_string(),
                port: 0,
                status: RuntimeStatus::Offline,
            }
        }
    }

    pub fn get_port(&self, course_path: &str) -> Option<u16> {
        self.processes.lock().unwrap().get(course_path).map(|p| p.port)
    }

    /// Mata el proceso administrado de este curso (si existe) y arranca uno
    /// nuevo. A diferencia de `start()`, que reutiliza el proceso si el
    /// health check ya pasa, `restart()` siempre fuerza un proceso nuevo:
    /// existe para el failover de Jintia Chat cuando el servidor de OpenCode
    /// dejó de responder (no un modelo/proveedor puntual, sino el propio
    /// proceso `opencode serve`) y un simple reintento de `prompt_async` no
    /// alcanza.
    pub fn restart(&self, course_path: &str) -> Result<RuntimeInfo, String> {
        self.stop(course_path);
        self.start(course_path)
    }
}

impl Default for OpenCodeManager {
    fn default() -> Self {
        Self::new()
    }
}
