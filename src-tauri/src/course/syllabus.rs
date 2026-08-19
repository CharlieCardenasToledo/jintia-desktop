use super::course_directory;
use crate::models::{ActionResult, WeekData};
use crate::paths::{atomic_write, backup_file, canonical_directory, path_text};
use std::sync::Mutex;

static SYLLABUS_WRITE_OPERATION: Mutex<()> = Mutex::new(());

pub(super) fn bullets(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .map(|line| {
            line.trim_start_matches(|character: char| matches!(character, '-' | '*' | '•' | ' '))
                .trim()
        })
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

pub(super) fn labelled_outcomes(text: &str) -> Vec<String> {
    bullets(text)
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            if [
                "docencia:",
                "práctica:",
                "practica:",
                "autónomo:",
                "autonomo:",
            ]
            .iter()
            .any(|prefix| line.to_lowercase().starts_with(prefix))
            {
                line
            } else if index == 0 {
                format!("Docencia: {line}")
            } else {
                line
            }
        })
        .collect()
}

pub(super) fn list_block(items: Vec<String>, empty: &str) -> String {
    if items.is_empty() {
        format!("- {empty}")
    } else {
        items
            .into_iter()
            .map(|item| format!("- {item}"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub fn build_syllabus_md(
    code: &str,
    name: &str,
    credits: u32,
    academic_period: &str,
    semester: &str,
    description: &str,
    weeks: &[WeekData],
) -> Result<String, String> {
    if code.trim().is_empty() || name.trim().is_empty() {
        return Err("Código y nombre de asignatura son obligatorios.".to_string());
    }
    if weeks.is_empty() {
        return Err("Agrega al menos una semana.".to_string());
    }

    let mut output = format!(
        "# {code} — {name}\n\n**Asignatura:** {code} — {name}\n**Periodo académico ordinario:** {}\n**Créditos:** {credits}\n**Semestre:** {}\n\n## Descripción del curso\n\n{}\n\n---\n\n## Plan semanal\n\n",
        academic_period.trim(),
        semester.trim(),
        description.trim()
    );

    for week in weeks {
        if !(1..=52).contains(&week.number) {
            return Err(format!("Número de semana inválido: {}", week.number));
        }
        let topics = bullets(&week.topics);
        let title = if week.title.trim().is_empty() {
            topics
                .first()
                .cloned()
                .unwrap_or_else(|| week.unit.trim().to_string())
        } else {
            week.title.trim().to_string()
        };
        output.push_str(&format!(
            "### Semana {:02} — {}\n\n**Unidad:** {}\n\n**Tema / contenido semanal:**\n{}\n\n**Resultado de aprendizaje:**\n{}\n\n**Herramienta de aprendizaje:**\n{}\n\n**Horas:** Docencia: {} | Práctica: {} | Autónomo: {}\n\n**Actividades calificadas:**\n{}\n\n---\n\n",
            week.number,
            title,
            week.unit.trim(),
            list_block(topics, "No especificado"),
            list_block(labelled_outcomes(&week.outcomes), "No especificado"),
            list_block(bullets(&week.bibliography), "No especificada"),
            week.teaching_hours,
            week.practice_hours,
            week.autonomous_hours,
            list_block(
                week.graded_activity.as_deref().map(bullets).unwrap_or_default(),
                "Ninguna"
            )
        ));
    }
    Ok(output)
}

pub fn generate_syllabus(
    course_path: String,
    course_code: String,
    course_name: String,
    credits: u32,
    academic_period: String,
    semester: String,
    description: String,
    weeks_data: Vec<WeekData>,
) -> ActionResult {
    let _operation = match SYLLABUS_WRITE_OPERATION.lock() {
        Ok(operation) => operation,
        Err(_) => return ActionResult::error("El estado interno del sílabo está bloqueado."),
    };
    let root = match canonical_directory(&course_path) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    let course = match course_directory(&root, &course_code, &course_name) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    if let Err(error) = std::fs::create_dir_all(&course) {
        return ActionResult::error(format!("No se pudo crear carpeta del curso: {error}"));
    }

    let content = match build_syllabus_md(
        &course_code,
        &course_name,
        credits,
        &academic_period,
        &semester,
        &description,
        &weeks_data,
    ) {
        Ok(content) => content,
        Err(error) => return ActionResult::error(error),
    };
    let path = course.join("README.md");
    if std::fs::read(&path).ok().as_deref() == Some(content.as_bytes()) {
        return ActionResult::ok(format!(
            "El sílabo de prueba ya estaba actualizado; no se creó otro archivo ni respaldo.\n{}",
            path_text(&path)
        ))
        .with_path(path_text(&path));
    }
    let backup = match backup_file(&path) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    if let Err(error) = atomic_write(&path, content.as_bytes()) {
        return ActionResult::error(error);
    }

    let result = ActionResult::ok(format!(
        "Sílabo canónico generado en:\n{}",
        path_text(&path)
    ))
    .with_path(path_text(&path));
    if let Some(backup) = backup {
        result.with_backup(path_text(&backup))
    } else {
        result
    }
}
