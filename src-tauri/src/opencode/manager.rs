use super::client::OpenCodeClient;
use super::models::{RuntimeInfo, RuntimeStatus};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct OpenCodeProcess {
    child: Child,
    port: u16,
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

    fn find_opencode() -> Option<PathBuf> {
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
            }
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

    fn free_port() -> u16 {
        use std::net::TcpListener;
        TcpListener::bind("127.0.0.1:0")
            .map(|l| l.local_addr().unwrap().port())
            .unwrap_or(14200)
    }

    pub fn start(&self, course_path: &str) -> Result<RuntimeInfo, String> {
        let key = course_path.to_string();
        let work_dir = Path::new(course_path);

        // Crear AGENTS.md con contexto de Jintia si aún no existe.
        // OpenCode lo lee al iniciar para usarlo como contexto del sistema.
        let agents_file = work_dir.join("AGENTS.md");
        if !agents_file.exists() {
            let _ = std::fs::write(
                &agents_file,
                "# Jintia — Asistente Pedagógico\n\
                 \n\
                 Eres Jintia, un asistente pedagógico especializado en diseño instruccional\n\
                 universitario para docentes hispanohablantes.\n\
                 \n\
                 Responde **siempre en español**, sin excepción, independientemente del idioma\n\
                 en que te escriban. Usa un tono profesional pero cercano.\n",
            );
        }

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

        let bin = Self::find_opencode()
            .ok_or_else(|| "OpenCode no encontrado. Instálalo con: npm install -g opencode-ai".to_string())?;

        let port = Self::free_port();

        #[cfg(target_os = "windows")]
        let child = Command::new("cmd")
            .args([
                "/c",
                bin.to_str().unwrap_or("opencode.cmd"),
                "serve",
                "--hostname",
                "127.0.0.1",
                "--port",
                &port.to_string(),
            ])
            .current_dir(work_dir)
            .env("OPENCODE_DISABLE_AUTOUPDATE", "true")
            .spawn()
            .map_err(|e| format!("No se pudo iniciar OpenCode: {e}"))?;

        #[cfg(not(target_os = "windows"))]
        let child = Command::new(bin)
            .args([
                "serve",
                "--hostname",
                "127.0.0.1",
                "--port",
                &port.to_string(),
            ])
            .current_dir(work_dir)
            .env("OPENCODE_DISABLE_AUTOUPDATE", "true")
            .spawn()
            .map_err(|e| format!("No se pudo iniciar OpenCode: {e}"))?;

        // Esperar hasta 20s a que el proceso esté listo
        let client = OpenCodeClient::new(port);
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if Instant::now() > deadline {
                return Err("OpenCode tardó demasiado en arrancar (>20s).".to_string());
            }
            if client.health().map(|h| h.healthy).unwrap_or(false) {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }

        self.processes
            .lock()
            .unwrap()
            .insert(key.clone(), OpenCodeProcess { child, port });

        Ok(RuntimeInfo {
            course_path: key,
            port,
            status: RuntimeStatus::Ready,
        })
    }

    pub fn stop(&self, course_path: &str) {
        if let Some(mut proc) = self.processes.lock().unwrap().remove(course_path) {
            let _ = proc.child.kill();
        }
    }

    pub fn stop_all(&self) {
        let mut procs = self.processes.lock().unwrap();
        for (_, mut proc) in procs.drain() {
            let _ = proc.child.kill();
        }
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
}

impl Default for OpenCodeManager {
    fn default() -> Self {
        Self::new()
    }
}
