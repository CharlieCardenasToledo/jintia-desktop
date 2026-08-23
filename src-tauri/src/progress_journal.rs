//! progress_journal.rs — Progreso en vivo de la skill, sin pasar por OpenCode.
//!
//! `jintia ready`/`jintia plan approve` (repo `jintia`, scripts/progress-events.js)
//! escriben una línea JSONL por cada transición de paso en
//! `<courseRoot>/.jintia/runtime/progress/<runId>.jsonl` con
//! `fs.appendFileSync` síncrono. Se verificó empíricamente contra un
//! servidor OpenCode real (versión estable y el build `dev` más reciente)
//! que ni `part.state.output` ni `context.metadata()` de una custom tool
//! entregan nada antes de que el tool call cierre — así que el progreso en
//! vivo no puede depender de nada que pase por OpenCode. Este módulo vigila
//! ese archivo directamente con un watcher nativo de sistema de archivos
//! (`notify`, no polling) y reenvía cada línea nueva al frontend como un
//! evento Tauri normal (`AppHandle::emit`, mismo mecanismo que ya usan
//! `codex/mod.rs`, `claude/mod.rs` y el resto de `lib.rs`).
//!
//! El archivo es la fuente de verdad; el watcher solo despierta a Desktop.
//! Si un evento de modificación se pierde o llega tarde, el archivo sigue
//! creciendo y el SIGUIENTE evento (la próxima escritura) vuelve a
//! disparar una lectura desde el offset conocido — no hace falta lógica de
//! recuperación por número de secuencia para el caso común (ver plan de
//! esta feature, sección "fuera de alcance").

use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

/// Parsea las líneas COMPLETAS de `buf` (las que terminan en `\n`),
/// ignorando cualquier línea final incompleta — si el escritor todavía no
/// terminó de escribirla, no hay que consumirla ni perderla: el siguiente
/// evento de modificación la traerá completa. Las líneas que no son JSON
/// válido se descartan individualmente sin abortar el resto (un `emitProgress`
/// mal formado en el journal no debe tumbar el reenvío de los demás).
///
/// Devuelve los valores JSON parseados, en orden, y cuántos bytes de `buf`
/// corresponden a líneas completas — el llamador debe avanzar su offset
/// EXACTAMENTE esa cantidad, nunca `buf.len()` completo, o perdería para
/// siempre el resto de una línea que se estaba escribiendo a mitad de una
/// lectura.
pub fn parse_complete_lines(buf: &str) -> (Vec<Value>, usize) {
    match buf.rfind('\n') {
        None => (Vec::new(), 0),
        Some(last_newline) => {
            let complete = &buf[..=last_newline];
            let values = complete
                .lines()
                .filter_map(|line| {
                    let line = line.trim();
                    if line.is_empty() {
                        None
                    } else {
                        serde_json::from_str(line).ok()
                    }
                })
                .collect();
            (values, last_newline + 1)
        }
    }
}

type Offsets = Arc<Mutex<HashMap<PathBuf, u64>>>;

fn read_new_lines_and_emit(app: &tauri::AppHandle, course_path: &str, path: &Path, offsets: &Offsets) {
    let mut offsets_guard = match offsets.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let start = *offsets_guard.get(path).unwrap_or(&0);

    let Ok(mut file) = fs::File::open(path) else { return; };
    // Si el archivo es MÁS CORTO que el offset conocido (se recreó desde
    // cero, ej. un runId nuevo reusando por accidente el mismo nombre), se
    // relee desde el principio en vez de fallar en seek.
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let seek_from = if len < start { 0 } else { start };

    use std::io::{Seek, SeekFrom};
    if file.seek(SeekFrom::Start(seek_from)).is_err() {
        return;
    }
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return;
    }

    let (values, consumed) = parse_complete_lines(&buf);
    if consumed > 0 {
        offsets_guard.insert(path.to_path_buf(), seek_from + consumed as u64);
    }
    drop(offsets_guard);

    for value in values {
        // coursePath viaja en el payload porque puede haber más de un curso
        // con sesión activa a la vez (OpenCodeManager admite varios
        // procesos simultáneos) — sin esto, el frontend no podría distinguir
        // de qué curso viene cada evento y mezclaría el progreso de dos
        // trabajos distintos en una sola tarjeta.
        let _ = app.emit("jintia-progress", serde_json::json!({ "coursePath": course_path, "event": value }));
    }
}

fn progress_dir(course_path: &str) -> PathBuf {
    Path::new(course_path).join(".jintia").join("runtime").join("progress")
}

/// Borra los `.jsonl` existentes del journal de un curso — son efímeros
/// (solo sirven para la vista en vivo de un trabajo ya terminado), no hay
/// motivo para retenerlos entre sesiones ni para que crezcan sin límite.
fn clear_old_journals(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            let _ = fs::remove_file(path);
        }
    }
}

struct WatcherHandle {
    // Solo se mantiene con vida para que el watcher siga activo — al hacer
    // `drop` (ver stop()), notify detiene la vigilancia automáticamente.
    _watcher: RecommendedWatcher,
}

/// Un `JournalWatcher` por curso con sesión activa — mismo patrón
/// `Mutex<HashMap<String, T>>` que ya usa `OpenCodeManager` para sus
/// procesos (`opencode/manager.rs`).
pub struct JournalWatcherManager {
    watchers: Mutex<HashMap<String, WatcherHandle>>,
}

use tauri::Emitter;

impl JournalWatcherManager {
    pub fn new() -> Self {
        Self { watchers: Mutex::new(HashMap::new()) }
    }

    /// Arranca (si no estaba ya corriendo) el watcher del journal de este
    /// curso. Falla en silencio si el sistema de archivos no coopera — el
    /// progreso en vivo es una mejora de experiencia, no una garantía; si
    /// no puede iniciarse, la skill sigue funcionando igual (el respaldo
    /// vía SSE del lado de jintia-chat.js sigue disponible).
    pub fn start(&self, app: tauri::AppHandle, course_path: &str) {
        let Ok(mut watchers) = self.watchers.lock() else { return; };
        if watchers.contains_key(course_path) {
            return;
        }

        let dir = progress_dir(course_path);
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        clear_old_journals(&dir);

        let offsets: Offsets = Arc::new(Mutex::new(HashMap::new()));
        let app_for_watcher = app.clone();
        let offsets_for_watcher = offsets.clone();
        let course_path_for_watcher = course_path.to_string();

        let watcher_result = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return; };
            if !matches!(event.kind, notify::EventKind::Create(_) | notify::EventKind::Modify(_)) {
                return;
            }
            for path in &event.paths {
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                read_new_lines_and_emit(&app_for_watcher, &course_path_for_watcher, path, &offsets_for_watcher);
            }
        });

        let Ok(mut watcher) = watcher_result else { return; };
        if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
            return;
        }

        watchers.insert(course_path.to_string(), WatcherHandle { _watcher: watcher });
    }

    /// Detiene el watcher de este curso (si había uno). No falla si no
    /// había ninguno activo — coherente con el ciclo de vida de
    /// `opencode_stop_course`, que también es idempotente.
    pub fn stop(&self, course_path: &str) {
        if let Ok(mut watchers) = self.watchers.lock() {
            watchers.remove(course_path);
        }
    }

    /// Detiene todos los watchers activos — usado al cerrar la aplicación,
    /// mismo patrón que `OpenCodeManager::stop_all()`.
    pub fn stop_all(&self) {
        if let Ok(mut watchers) = self.watchers.lock() {
            watchers.clear();
        }
    }
}

impl Default for JournalWatcherManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_complete_lines_ignora_una_linea_final_incompleta() {
        let buf = "{\"a\":1}\n{\"a\":2}\n{\"a\":3 sin terminar";
        let (values, consumed) = parse_complete_lines(buf);
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["a"], 1);
        assert_eq!(values[1]["a"], 2);
        // consumed debe apuntar justo después del segundo '\n', dejando la
        // línea incompleta sin consumir para la próxima lectura.
        assert_eq!(consumed, "{\"a\":1}\n{\"a\":2}\n".len());
    }

    #[test]
    fn parse_complete_lines_sin_ninguna_linea_completa_no_avanza_nada() {
        let (values, consumed) = parse_complete_lines("{\"a\":1} todavia escribiendo");
        assert_eq!(values.len(), 0);
        assert_eq!(consumed, 0);
    }

    #[test]
    fn parse_complete_lines_ignora_lineas_json_invalidas_sin_abortar_las_demas() {
        let buf = "{\"a\":1}\nesto no es json\n{\"a\":2}\n";
        let (values, consumed) = parse_complete_lines(buf);
        assert_eq!(values.len(), 2);
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn parse_complete_lines_ignora_lineas_vacias() {
        let buf = "{\"a\":1}\n\n{\"a\":2}\n";
        let (values, _) = parse_complete_lines(buf);
        assert_eq!(values.len(), 2);
    }

    #[test]
    fn parse_complete_lines_buffer_vacio() {
        let (values, consumed) = parse_complete_lines("");
        assert_eq!(values.len(), 0);
        assert_eq!(consumed, 0);
    }

    #[test]
    fn journal_watcher_manager_stop_es_idempotente_sin_ningun_watcher_activo() {
        let manager = JournalWatcherManager::new();
        manager.stop("curso-inexistente");
        manager.stop_all();
    }
}
