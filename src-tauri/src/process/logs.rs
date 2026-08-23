//! Los procesos administrados (OpenCode, Claude Code, Codex, NotebookLM MCP)
//! ya no muestran ventana de consola en producción — pero eso no puede
//! significar perder su stderr con `Stdio::null()`. Diagnosticar un fallo
//! después de cerrar la app sería imposible. En vez de eso, su stderr se
//! anexa a un archivo de log bajo la carpeta de configuración de Jintia.

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::thread;

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

pub fn log_dir() -> Result<PathBuf, String> {
    let dir = crate::paths::app_config_dir()?.join("logs");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear el directorio de logs: {e}"))?;
    Ok(dir)
}

pub fn log_path(name: &str) -> Result<PathBuf, String> {
    Ok(log_dir()?.join(format!("{name}.log")))
}

/// Consume un stream (típicamente stderr de un proceso administrado) línea a
/// línea en un hilo aparte y lo anexa a `<name>.log`. Si no se puede resolver
/// o crear el directorio de logs, se ignora en silencio: perder diagnóstico
/// nunca debe tumbar el proceso que lo produce.
pub fn spawn_log_writer<R: Read + Send + 'static>(reader: R, name: &'static str) {
    thread::spawn(move || {
        let path = match log_path(name) {
            Ok(p) => p,
            Err(_) => return,
        };
        // Rotación simple: si el log ya es grande, empezar de cero en vez de
        // crecer indefinidamente en una app de escritorio de larga duración.
        if let Ok(metadata) = std::fs::metadata(&path) {
            if metadata.len() > MAX_LOG_BYTES {
                let _ = std::fs::remove_file(&path);
            }
        }
        let file = OpenOptions::new().create(true).append(true).open(&path);
        let mut file = match file {
            Ok(f) => f,
            Err(_) => return,
        };
        for line in BufReader::new(reader).lines().flatten() {
            let _ = writeln!(file, "{line}");
        }
    });
}
