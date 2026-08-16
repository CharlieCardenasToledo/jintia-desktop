use crate::models::ActionResult;
use std::path::{Path, PathBuf};

pub fn check_migration_needed(course_path: String) -> crate::models::MigrationStatus {
    let root = PathBuf::from(course_path.trim());
    if !root.is_dir() {
        return crate::models::MigrationStatus {
            needs_migration: false,
            latex_dirs_found: 0,
            tex_files_found: 0,
            dry_run_report: None,
        };
    }

    // Contar directorios LaTeX existentes
    let semanas_dir = root.join("semanas");
    let mut latex_dirs = 0;
    let mut tex_files = 0;

    if let Ok(entries) = std::fs::read_dir(&semanas_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let latex_path = path.join("latex");
                if latex_path.is_dir() {
                    latex_dirs += 1;
                    if let Ok(tex_entries) = std::fs::read_dir(&latex_path) {
                        for tex_entry in tex_entries.flatten() {
                            if tex_entry.path().extension().and_then(|s| s.to_str()) == Some("tex")
                            {
                                tex_files += 1;
                            }
                        }
                    }
                }
            }
        }
    }

    if latex_dirs == 0 && tex_files == 0 {
        return crate::models::MigrationStatus {
            needs_migration: false,
            latex_dirs_found: 0,
            tex_files_found: 0,
            dry_run_report: None,
        };
    }

    let skill_path = match crate::runtimes::resolve_skill() {
        Some(p) => p,
        None => {
            return crate::models::MigrationStatus {
                needs_migration: true,
                latex_dirs_found: latex_dirs,
                tex_files_found: tex_files,
                dry_run_report: None,
            };
        }
    };
    let course_path_str = root.to_string_lossy().to_string();
    let args = ["migrate", &course_path_str, "--dry-run", "--json"];

    let dry_run_report = match crate::engine::run_jintia(Path::new(&skill_path), &args) {
        Ok(result) if result.success => serde_json::from_str(&result.stdout).ok(),
        _ => None,
    };

    crate::models::MigrationStatus {
        needs_migration: true,
        latex_dirs_found: latex_dirs,
        tex_files_found: tex_files,
        dry_run_report,
    }
}

pub fn run_migration(course_path: String) -> ActionResult {
    let root = PathBuf::from(course_path.trim());
    if !root.is_dir() {
        return ActionResult::error("La carpeta del proyecto no existe.");
    }

    let skill_path = match crate::runtimes::resolve_skill() {
        Some(p) => p,
        None => {
            return ActionResult::error(
                "Jintia Skill no está instalada. Ve a Configuración > Entorno.",
            )
        }
    };
    let course_path_str = root.to_string_lossy().to_string();
    let args = ["migrate", &course_path_str, "--json"];

    match crate::engine::run_jintia(Path::new(&skill_path), &args) {
        Ok(result) => {
            if result.success {
                ActionResult::ok("Proyecto migrado correctamente.")
            } else {
                ActionResult::error(format!("Error durante la migración:\n{}", result.stderr))
            }
        }
        Err(error) => ActionResult::error(error),
    }
}
