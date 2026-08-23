//! Abstracción única de "proceso administrado por Jintia". Regla: ningún
//! módulo lanza OpenCode, Claude Code, Codex ni NotebookLM MCP con
//! `Command::new(...).spawn()` directo — todos pasan por
//! `process::supervisor().spawn(command)`. Eso centraliza la política de
//! producción (sin ventana de consola, agrupado en un Job Object en
//! Windows) en un solo lugar en vez de repetirla manager a manager, donde es
//! fácil que un comando nuevo la olvide (como pasó con NotebookLM y Codex:
//! ver el incidente que motivó este módulo).

pub mod background;
pub mod logs;
pub mod supervisor;
#[cfg(target_os = "windows")]
pub mod windows;

pub use supervisor::{kill_child_tree, RuntimeSupervisor};

use std::sync::OnceLock;

static SUPERVISOR: OnceLock<RuntimeSupervisor> = OnceLock::new();

/// Instancia única del supervisor de procesos, inicializada en el primer uso
/// (crea el Job Object de Windows en ese momento). No se expone como estado
/// gestionado por Tauri a propósito: así cualquier código —incluidos los
/// módulos de `mcp/` que no reciben `tauri::State`— puede llegar a él sin
/// tener que rehacer la firma de media docena de comandos.
pub fn supervisor() -> &'static RuntimeSupervisor {
    SUPERVISOR.get_or_init(RuntimeSupervisor::new)
}
