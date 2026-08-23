//! Modo de proceso interno de Jintia: "background" (producción, siempre) vs
//! "debug" (solo para quien mantiene Jintia, vía variable de entorno — nunca
//! una opción del usuario final). En background, todo proceso administrado
//! corre sin ventana de consola en Windows.

use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessMode {
    Debug,
    Background,
}

/// `JINTIA_PROCESS_MODE=debug` conserva la ventana de consola de los
/// procesos administrados (útil para depurar OpenCode/NotebookLM/Codex sin
/// pelear con logs). Cualquier otro valor (incluida su ausencia, el caso de
/// producción) usa el modo silencioso.
pub fn process_mode() -> ProcessMode {
    match std::env::var("JINTIA_PROCESS_MODE").ok().as_deref() {
        Some("debug") => ProcessMode::Debug,
        _ => ProcessMode::Background,
    }
}

/// Aplica la política de "proceso silencioso" a un `Command` antes de
/// spawnearlo. No toca stdin/stdout/stderr (eso lo decide cada caller según
/// si necesita leer al proceso) — solo evita que aparezca una ventana de
/// consola y, en Unix, aísla el proceso en su propio grupo para poder matar
/// el árbol completo después (ver `RuntimeSupervisor::spawn`).
pub fn configure_background_process(command: &mut Command, mode: ProcessMode) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        if mode != ProcessMode::Debug {
            command.creation_flags(CREATE_NO_WINDOW);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Nuevo grupo de procesos: permite matar todo el árbol con una señal
        // al grupo (ver kill_child_tree) en vez de solo al hijo directo.
        command.process_group(0);
    }
    let _ = mode; // evita "unused" en plataformas sin ninguna de las dos ramas
}
