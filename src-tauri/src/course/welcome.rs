use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn stable_pdf_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("APPDATA"))
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        return base.join("Jintia").join("self-test-preview");
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::temp_dir().join("Jintia").join("self-test-preview")
    }
}

fn welcome_guide_json() -> Value {
    json!({
        "metadata": {
            "course": "Jintia — Asistente pedagógico",
            "week": 1,
            "topic": "Tu flujo de trabajo con Jintia",
            "outcome": "Crear asignaturas y guías didácticas con IA en minutos",
            "lang": "es"
        },
        "sections": [
            {
                "type": "orientation",
                "id": "bienvenida",
                "title": "¿Qué hace Jintia?",
                "content": "Jintia es tu asistente pedagógico. Combina inteligencia artificial, una biblioteca de conocimiento ({{keyterm:Gemini Notebook}}) y generación automática de PDFs tipográficos para que puedas preparar guías didácticas profesionales en minutos.\n\nEsta guía fue generada por Jintia durante su instalación — es una muestra de lo que podrás crear cada semana para tus asignaturas."
            },
            {
                "type": "table",
                "id": "flujo-semanal",
                "caption": "Flujo de trabajo semanal con Jintia",
                "headers": ["Paso", "Acción en Jintia", "Resultado"],
                "rows": [
                    ["1", "Crear asignatura", "Carpeta del curso lista"],
                    ["2", "Vincular notebook", "Biblioteca de conocimiento conectada"],
                    ["3", "Preguntar en el chat", "Respuestas citadas de tus fuentes"],
                    ["4", "Generar guía semanal", "PDF listo para publicar"]
                ]
            },
            {
                "type": "concept",
                "id": "ask-jintia",
                "title": "Ask Jintia: preguntas sobre tu materia",
                "content": "El chat de Jintia está conectado a tu {{keyterm:Gemini Notebook}}, un espacio donde subes libros, artículos y diapositivas de tu asignatura.\n\nCuando preguntas algo — «¿cómo explico la regresión logística a ingenieros?» — Jintia busca en TUS fuentes y cita de dónde vino cada respuesta. Sin inventar referencias ni datos."
            },
            {
                "type": "theory",
                "id": "guias-pdf",
                "title": "Guías didácticas en PDF profesional",
                "content": "Cada semana Jintia genera un documento PDF con diseño tipográfico institucional. Incluye portada, temas, resultados de aprendizaje, bibliografía formateada en APA y actividad evaluativa.\n\nPuedes elegir entre varias {{keyterm:plantillas visuales}} y personalizar colores con la identidad de tu institución."
            },
            {
                "type": "practice",
                "id": "primer-curso",
                "title": "Empieza en tres pasos",
                "content": "Desde el panel principal haz clic en {{keyterm:Nueva asignatura}}.\n\nElige la carpeta, escribe el código y nombre del curso. Jintia crea toda la estructura de archivos automáticamente.\n\nDespués ve a {{keyterm:Ask Jintia}}, vincula tu Gemini Notebook y empieza a preguntar sobre tu materia."
            },
            {
                "type": "scenario",
                "id": "caso-uso",
                "title": "Caso real: preparar una clase en 10 minutos",
                "content": "Una docente de Estadística abre Jintia el lunes por la mañana. En el chat pregunta: «Resume los supuestos de la regresión lineal con un ejemplo de datos de salud». Jintia responde con una síntesis citada de los capítulos que ella subió a su notebook.\n\nCopia la respuesta, ajusta el tono, y genera la guía de la semana 5. El PDF queda listo para sus estudiantes antes del almuerzo."
            },
            {
                "type": "assessment",
                "id": "primeros-pasos",
                "title": "Tu lista de inicio",
                "items": [
                    "Crea tu primera asignatura desde el panel principal",
                    "Vincula un notebook de Gemini Notebook al curso",
                    "Haz tu primera pregunta en Ask Jintia",
                    "Genera la guía de la semana 1 de tu asignatura"
                ]
            }
        ]
    })
}

/// Genera el PDF de bienvenida de Jintia usando el pipeline completo de la Skill
/// (content-linter → guide-renderer → vivliostyle-adapter) con contenido sobre
/// cómo funciona Jintia. Devuelve el mismo formato que `jintia self-test --json`
/// para que la UI del onboarding lo consuma sin cambios.
pub fn generate_welcome_guide_pdf() -> Value {
    let skill_bin = match crate::runtimes::resolve_skill() {
        Some(p) => PathBuf::from(p),
        None => return json!({ "ok": false, "error": "Jintia Skill no está instalada." }),
    };

    // scripts dir = <skill-root>/scripts  (skill_bin = <skill-root>/bin/jintia.js)
    let scripts_dir = match skill_bin
        .parent()
        .and_then(|p| p.parent())
        .map(|root| root.join("scripts"))
    {
        Some(dir) if dir.is_dir() => dir,
        _ => return json!({ "ok": false, "error": "Directorio de scripts de Skill no encontrado." }),
    };

    let tmp_dir = std::env::temp_dir()
        .join(format!("jintia-guide-{}-{}", crate::paths::timestamp(), std::process::id()));
    let guide_dir = tmp_dir.join("semanas").join("semana-01");

    let mut checks = serde_json::Map::new();
    let mut ok = true;
    let mut stable_pdf: Option<PathBuf> = None;

    let pipeline_result = (|| -> Result<(), String> {
        fs::create_dir_all(&guide_dir)
            .map_err(|e| format!("No se pudo crear el directorio temporal: {e}"))?;

        let guide_file = guide_dir.join("guide.json");
        let html_file  = guide_dir.join("guide.html");
        let pdf_file   = guide_dir.join("guide.pdf");

        let content_bytes = serde_json::to_vec_pretty(&welcome_guide_json())
            .map_err(|e| e.to_string())?;
        fs::write(&guide_file, &content_bytes)
            .map_err(|e| format!("No se pudo escribir guide.json: {e}"))?;

        // validate
        let linter = scripts_dir.join("content-linter.js");
        let v = crate::engine::run_node_script(
            &linter,
            &[&guide_file.to_string_lossy()],
            Some(&tmp_dir),
        );
        if v.as_ref().map(|r| r.success).unwrap_or(false) {
            checks.insert("validate".into(), json!("passed"));
        } else {
            ok = false;
            checks.insert("validate".into(), json!("failed"));
            return Ok(());
        }

        // render
        let renderer = scripts_dir.join("guide-renderer.js");
        let r = crate::engine::run_node_script(
            &renderer,
            &[
                &guide_file.to_string_lossy(),
                "--output",
                &html_file.to_string_lossy(),
            ],
            Some(&tmp_dir),
        );
        if r.as_ref().map(|r| r.success).unwrap_or(false) {
            checks.insert("render".into(), json!("passed"));
        } else {
            ok = false;
            checks.insert("render".into(), json!("failed"));
            return Ok(());
        }

        // vivliostyle
        let adapter = scripts_dir.join("vivliostyle-adapter.js");
        let c = crate::engine::run_node_script(
            &adapter,
            &[&html_file.to_string_lossy()],
            Some(&tmp_dir),
        );
        match c {
            Ok(res) if res.success => {
                checks.insert("vivliostyle".into(), json!("passed"));
            }
            Ok(res) => {
                let err_text = res.stderr + &res.stdout;
                if err_text.contains("no encontrado") {
                    checks.insert("vivliostyle".into(), json!("not_installed"));
                } else {
                    checks.insert("vivliostyle".into(), json!("failed"));
                }
                ok = false;
                return Ok(());
            }
            Err(_) => {
                ok = false;
                checks.insert("vivliostyle".into(), json!("failed"));
                return Ok(());
            }
        }

        // pdf
        if pdf_file.is_file() {
            checks.insert("pdf".into(), json!("passed"));
            let dest_dir = stable_pdf_dir();
            if fs::create_dir_all(&dest_dir).is_ok() {
                let dest = dest_dir.join("guide.pdf");
                if fs::copy(&pdf_file, &dest).is_ok() {
                    stable_pdf = Some(dest);
                }
            }
        } else {
            ok = false;
            checks.insert("pdf".into(), json!("failed"));
        }

        Ok(())
    })();

    let _ = fs::remove_dir_all(&tmp_dir);

    if let Err(e) = pipeline_result {
        return json!({ "ok": false, "error": e, "checks": Value::Object(checks) });
    }

    let mut response = json!({ "ok": ok, "checks": Value::Object(checks) });
    if let Some(pdf) = stable_pdf {
        response["pdfPath"] = json!(crate::paths::path_text(&pdf));
    }
    response
}
