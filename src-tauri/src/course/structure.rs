use super::course_directory;
use crate::models::ActionResult;
use crate::paths::{atomic_write, canonical_directory};
use std::path::{Path, PathBuf};

pub fn create_course_structure(
    root_path: String,
    course_code: String,
    course_name: String,
    _weeks: u32,
    _initialize_readme: bool,
    _include_graded_activities: bool,
) -> ActionResult {
    // Validar inputs básicos
    let requested_root = PathBuf::from(root_path.trim());
    if root_path.trim().is_empty() {
        return ActionResult::error("Selecciona una carpeta para guardar el proyecto.");
    }
    if !requested_root.exists() {
        if let Err(error) = std::fs::create_dir_all(&requested_root) {
            return ActionResult::error(format!(
                "No se pudo crear la carpeta de proyectos: {error}"
            ));
        }
    }

    let root = match canonical_directory(&root_path) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    let course = match course_directory(&root, &course_code, &course_name) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };

    let skill_path = match crate::runtimes::resolve_skill() {
        Some(p) => p,
        None => {
            return ActionResult::error(
                "Jintia Skill no está instalada. Ve a Configuración > Entorno.",
            )
        }
    };
    let course_path_str = course.to_string_lossy().to_string();
    let args = [
        "init",
        &course_path_str,
        "--code",
        course_code.trim(),
        "--name",
        course_name.trim(),
        "--json",
    ];

    match crate::engine::run_jintia(Path::new(&skill_path), &args) {
        Ok(result) => {
            if result.success {
                ActionResult::ok(format!(
                    "Proyecto creado en:\n{}",
                    crate::paths::path_text(&course)
                ))
                .with_path(crate::paths::path_text(&course))
            } else {
                ActionResult::error(format!("Error al crear el proyecto:\n{}", result.stderr))
            }
        }
        Err(error) => ActionResult::error(error),
    }
}

pub fn run_self_test() -> serde_json::Value {
    let skill_path = match crate::runtimes::resolve_skill() {
        Some(p) => p,
        None => {
            return serde_json::json!({ "ok": false, "error": "Jintia Skill no está disponible." })
        }
    };
    crate::engine::run_jintia_json::<serde_json::Value>(
        Path::new(&skill_path),
        &["self-test", "--json"],
    )
    .unwrap_or_else(|error| serde_json::json!({ "ok": false, "error": error }))
}

pub(super) fn write_course_settings(
    course: &Path,
    include_graded_activities: bool,
) -> Result<(), String> {
    let settings_dir = course.join(".jintia");
    std::fs::create_dir_all(&settings_dir)
        .map_err(|error| format!("no se pudo crear {}: {error}", settings_dir.display()))?;
    let settings = serde_json::json!({
        "schemaVersion": 1,
        "includeGradedActivities": include_graded_activities,
    });
    let bytes = serde_json::to_vec_pretty(&settings)
        .map_err(|error| format!("no se pudo serializar la configuración: {error}"))?;
    atomic_write(&settings_dir.join("course.json"), &bytes)
}

pub fn save_course_settings(
    course_path: String,
    course_code: String,
    course_name: String,
    include_graded_activities: bool,
) -> ActionResult {
    let root = match canonical_directory(&course_path) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    let course = match course_directory(&root, &course_code, &course_name) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    if !course.exists() {
        return ActionResult::error(format!(
            "Carpeta de la asignatura no encontrada: {}",
            course.display()
        ));
    }
    match write_course_settings(&course, include_graded_activities) {
        Ok(()) => ActionResult::ok("Configuración de la asignatura guardada."),
        Err(error) => ActionResult::error(error),
    }
}
