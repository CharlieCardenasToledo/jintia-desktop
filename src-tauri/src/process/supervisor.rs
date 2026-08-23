//! `RuntimeSupervisor` es el único punto por el que deben pasar los procesos
//! internos de larga vida de Jintia (OpenCode, Claude Code, Codex, NotebookLM
//! MCP): configura la política de "proceso silencioso" (sin ventana, ver
//! `background.rs`) y, en Windows, asigna el proceso al Job Object común
//! (`windows.rs`) para que cerrar Jintia — incluso ante un crash — mate todo
//! el árbol sin depender de que cada manager recuerde limpiar bien.
//!
//! El supervisor NO es dueño de los `Child` que lanza: cada manager conserva
//! el suyo (para leer stdio, esperarlo, matarlo en su propio `stop()`). El
//! Job Object es la red de seguridad además de esa limpieza explícita, no un
//! sustituto de ella — por eso `stop_all()` de cada manager sigue siendo
//! necesario en `on_window_event` (ver lib.rs).

use super::background::{configure_background_process, process_mode};
use std::process::{Child, Command, Stdio};

#[cfg(target_os = "windows")]
use super::windows::JobHandle;

pub struct RuntimeSupervisor {
    #[cfg(target_os = "windows")]
    job: Option<JobHandle>,
}

impl RuntimeSupervisor {
    pub fn new() -> Self {
        #[cfg(target_os = "windows")]
        let job = match JobHandle::create() {
            Ok(job) => Some(job),
            Err(err) => {
                eprintln!("[runtime] {err} — los procesos administrados seguirán silenciosos, pero sin el Job Object de limpieza.");
                None
            }
        };
        Self {
            #[cfg(target_os = "windows")]
            job,
        }
    }

    /// Configura y lanza `command` como proceso administrado: sin ventana de
    /// consola (salvo `JINTIA_PROCESS_MODE=debug`) y, en Windows, asignado al
    /// Job Object de Jintia. `command` ya debe traer args/cwd/env/stdio
    /// configurados por el caller — este método solo añade la capa de
    /// aislamiento, nunca decide qué necesita leer o escribir el proceso.
    pub fn spawn(&self, mut command: Command) -> std::io::Result<Child> {
        configure_background_process(&mut command, process_mode());
        let child = command.spawn()?;
        #[cfg(target_os = "windows")]
        {
            if let Some(job) = &self.job {
                if let Err(err) = job.assign(&child) {
                    eprintln!("[runtime] {err}");
                }
            }
        }
        Ok(child)
    }
}

impl Default for RuntimeSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

/// Mata un proceso administrado y todo su árbol de descendientes. En Windows,
/// `taskkill /T` cubre el caso común de `cmd /c <algo>` (matar solo el
/// `Child` de Rust deja huérfano al proceso real bajo `cmd`). En Unix, se
/// apoya en que `configure_background_process` ya aisló el proceso en su
/// propio grupo (`process_group(0)`) al spawnearlo: enviar la señal al grupo
/// completo (`kill -<pid>`) alcanza también a lo que ese proceso haya
/// lanzado por su cuenta, algo que `child.kill()` por sí solo no garantiza.
pub fn kill_child_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}
