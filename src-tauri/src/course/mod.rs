pub mod migration;
pub mod structure;
pub mod syllabus;
pub mod welcome;

use crate::paths::safe_segment;
use std::path::{Path, PathBuf};

// ── Slug constants ────────────────────────────────────────────────────────────
const COURSE_CODE_SLUG_MAX: usize = 24;
const COURSE_NAME_SLUG_MAX: usize = 48;

// ── Slug helpers (private to the module tree) ─────────────────────────────────
fn slug_component(value: &str, max_len: usize) -> String {
    let mut slug = String::new();
    let mut separator_pending = false;

    for character in value.trim().chars() {
        let folded = match character {
            'á' | 'à' | 'ä' | 'â' | 'ã' | 'å' | 'Á' | 'À' | 'Ä' | 'Â' | 'Ã' | 'Å' => {
                Some('a')
            }
            'é' | 'è' | 'ë' | 'ê' | 'É' | 'È' | 'Ë' | 'Ê' => Some('e'),
            'í' | 'ì' | 'ï' | 'î' | 'Í' | 'Ì' | 'Ï' | 'Î' => Some('i'),
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' | 'Ó' | 'Ò' | 'Ö' | 'Ô' | 'Õ' => Some('o'),
            'ú' | 'ù' | 'ü' | 'û' | 'Ú' | 'Ù' | 'Ü' | 'Û' => Some('u'),
            'ñ' | 'Ñ' => Some('n'),
            'ç' | 'Ç' => Some('c'),
            character if character.is_ascii_alphanumeric() => Some(character.to_ascii_lowercase()),
            _ => None,
        };

        if let Some(character) = folded {
            if separator_pending && !slug.is_empty() {
                slug.push('_');
            }
            slug.push(character);
            separator_pending = false;
        } else if !slug.is_empty() {
            separator_pending = true;
        }
    }

    if slug.len() <= max_len {
        return slug;
    }

    let prefix = &slug[..max_len];
    match prefix.rfind('_') {
        Some(position) if position >= max_len / 2 => prefix[..position].to_string(),
        _ => prefix.to_string(),
    }
}

pub(super) fn course_folder_name(course_code: &str, course_name: &str) -> Result<String, String> {
    if course_code.trim().is_empty() {
        return Err("Código es obligatorio.".to_string());
    }
    if course_name.trim().is_empty() {
        return Err("Nombre es obligatorio.".to_string());
    }

    let code = slug_component(course_code, COURSE_CODE_SLUG_MAX);
    let name = slug_component(course_name, COURSE_NAME_SLUG_MAX);
    if code.is_empty() {
        return Err("El código debe contener al menos una letra o un número.".to_string());
    }
    if name.is_empty() {
        return Err("El nombre debe contener al menos una letra o un número.".to_string());
    }
    Ok(format!("{code}_{name}"))
}

pub(crate) fn course_directory(
    root: &Path,
    course_code: &str,
    course_name: &str,
) -> Result<PathBuf, String> {
    let canonical = root.join(course_folder_name(course_code, course_name)?);
    if canonical.exists() {
        return Ok(canonical);
    }

    // Las asignaturas creadas por versiones anteriores usaban "CÓDIGO Nombre".
    // Se conservan en su ubicación original para no separar sus archivos.
    if let (Ok(legacy_code), Ok(legacy_name)) = (
        safe_segment(course_code, "Código"),
        safe_segment(course_name, "Nombre"),
    ) {
        let legacy = root.join(format!("{legacy_code} {legacy_name}"));
        if legacy.exists() {
            return Ok(legacy);
        }
    }

    Ok(canonical)
}

// ── Public re-exports ─────────────────────────────────────────────────────────
pub use migration::{check_migration_needed, run_migration};
pub use structure::{create_course_structure, run_self_test, save_course_settings};
pub use syllabus::generate_syllabus;
pub use welcome::generate_welcome_guide_pdf;

// ── Tests ─────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use super::syllabus::build_syllabus_md;
    use crate::models::WeekData;

    #[test]
    fn syllabus_uses_canonical_labels() {
        let markdown = build_syllabus_md(
            "IFT200",
            "Interacción",
            3,
            "Abril–Agosto 2026",
            "Abril–Agosto 2026",
            "Curso",
            &[WeekData {
                number: 1,
                title: "Fundamentos".to_string(),
                unit: "Unidad 1".to_string(),
                topics: "Tema A\nTema B".to_string(),
                outcomes: "Analizar interfaces".to_string(),
                bibliography: "Autor (2024). Libro.".to_string(),
                graded_activity: None,
                autonomous_hours: 3,
                teaching_hours: 2,
                practice_hours: 1,
            }],
        )
        .unwrap();

        assert!(markdown.contains("**Asignatura:** IFT200 — Interacción"));
        assert!(markdown.contains("**Resultado de aprendizaje:**"));
        assert!(markdown.contains("**Herramienta de aprendizaje:**"));
        assert!(markdown.contains("**Actividades calificadas:**\n- Ninguna"));
        assert!(!markdown.contains("**Resultados de aprendizaje:**"));
    }

    #[test]
    fn course_folders_use_a_short_portable_slug() {
        assert_eq!(
            course_folder_name("IFT 200", "Diseño e Interacción").unwrap(),
            "ift_200_diseno_e_interaccion"
        );
        assert_eq!(
            course_folder_name(
                "CC-05A",
                "Fundamentos profesionales para la toma de decisiones basada en evidencia"
            )
            .unwrap(),
            "cc_05a_fundamentos_profesionales_para_la_toma_de"
        );
    }

    #[test]
    fn course_folder_slug_rejects_empty_identifiers() {
        assert!(course_folder_name("", "Base de datos").is_err());
        assert!(course_folder_name("IFT200", "###").is_err());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_git_install_guidance_mentions_only_git() {
        let result = crate::capabilities::install_dependency("Git".to_string(), false);
        assert!(!result.success);
        assert!(result.message.contains("Git"));
        assert!(!result.message.contains("Node.js"));
        assert!(!result.message.contains("Python"));
        assert!(!result.message.contains("brew install node"));
        assert!(!result.message.contains("apt install nodejs"));
        #[cfg(target_os = "macos")]
        {
            assert!(result.message.contains("brew install git"));
        }
        #[cfg(target_os = "linux")]
        {
            assert!(result.message.contains("sudo apt install git"));
            assert!(result.message.contains("Debian/Ubuntu"));
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_unknown_dependency_is_rejected() {
        let result =
            crate::capabilities::install_dependency("Herramienta desconocida".to_string(), false);
        assert!(!result.success);
        assert_eq!(
            result.message,
            "Dependencia desconocida: Herramienta desconocida"
        );
        assert!(!result.message.contains("brew install git"));
        assert!(!result.message.contains("apt install git"));
    }

    #[test]
    fn syllabus_markdown_structure_is_valid() {
        let week = WeekData {
            number: 2,
            title: "Decisiones bajo incertidumbre".to_string(),
            unit: "Análisis probabilístico".to_string(),
            topics: "Riesgo\nProba bilidad".to_string(),
            outcomes: "Modelar decisiones".to_string(),
            bibliography: "Taleb (2007). Black Swan.".to_string(),
            graded_activity: Some("Análisis de caso".to_string()),
            autonomous_hours: 3,
            teaching_hours: 2,
            practice_hours: 2,
        };
        let md = build_syllabus_md(
            "IFT201",
            "Análisis de Decisiones",
            4,
            "2026-I",
            "I",
            "Pensamiento crítico.",
            &[week],
        )
        .unwrap();

        assert!(md.contains("# IFT201 — Análisis de Decisiones"));
        assert!(md.contains("### Semana 02 — Decisiones bajo incertidumbre"));
        assert!(md.contains("**Unidad:** Análisis probabilístico"));
        assert!(md.contains("**Resultado de aprendizaje:**"));
        assert!(md.contains("**Horas:**"));
    }
}
