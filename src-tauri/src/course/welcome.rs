use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

/// Capturas reales de la app (modo mock), incrustadas en el binario para que
/// la guía de bienvenida no dependa de ningún recurso externo ni de rutas de
/// instalación. Ver `src-tauri/resources/onboarding/`.
const SCREENSHOT_MIS_CURSOS: &[u8] = include_bytes!("../../resources/onboarding/mis-cursos.png");
const SCREENSHOT_ASK_JINTIA: &[u8] = include_bytes!("../../resources/onboarding/ask-jintia.png");
const SCREENSHOT_PDFS: &[u8] = include_bytes!("../../resources/onboarding/pdfs-generados.png");
const SCREENSHOT_PLANTILLAS: &[u8] = include_bytes!("../../resources/onboarding/plantillas.png");

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
            "course": "Guía rápida de Jintia",
            "week": 1,
            "topic": "Cómo usar la plataforma paso a paso",
            "outcome": "Configurar Jintia, crear una asignatura, trabajar con Ask Jintia y obtener una guía en PDF",
            "lang": "es"
        },
        "sections": [
            {
                "type": "orientation",
                "id": "bienvenida",
                "title": "Bienvenido a Jintia",
                "content": "Esta guía es tu primer recorrido por la plataforma. Fue creada durante la verificación inicial con el mismo flujo que Jintia utilizará en tus asignaturas: contenido estructurado, HTML, estilos editoriales, Vivliostyle y PDF.\n\nAl terminar sabrás dónde crear un curso, cómo preparar el sílabo, cómo pedir ayuda a {{keyterm:Ask Jintia}} y dónde encontrar los documentos generados."
            },
            {
                "type": "table",
                "id": "mapa-plataforma",
                "caption": "Mapa rápido de la plataforma",
                "headers": ["Sección", "Para qué sirve", "Cuándo usarla"],
                "rows": [
                    ["Mis cursos", "Crear y organizar asignaturas", "Al iniciar un curso o revisar sus semanas"],
                    ["Ask Jintia", "Trabajar con IA dentro del contexto del curso", "Para crear, revisar o validar contenido"],
                    ["PDFs generados", "Consultar los documentos de tus proyectos", "Después de producir una guía"],
                    ["Plantillas", "Elegir el diseño editorial", "Antes de generar documentos nuevos"],
                    ["Configuración", "Revisar perfil, integraciones y entorno", "Cuando necesites verificar o reparar una capacidad"]
                ]
            },
            {
                "type": "concept",
                "id": "integraciones",
                "title": "1. Elige cómo conversar con Jintia",
                "content": "Durante el onboarding, Jintia prepara OpenCode, Claude Code y ChatGPT (Codex) en el mismo equipo. Claude y ChatGPT requieren una cuenta compatible con sus funciones profesionales; OpenCode es la alternativa gratuita cuando esas sesiones no están disponibles.\n\nEn Ask Jintia puedes revisar el proveedor activo antes de enviar una solicitud. Tus archivos académicos permanecen en la carpeta del curso que elegiste."
            },
            {
                "type": "figure",
                "id": "fig-plantillas",
                "src": "figuras/plantillas.png",
                "alt": "Catálogo de plantillas de publicación de Jintia, con Jintia Clásico activo y una vista previa de la guía a la derecha.",
                "caption": "Elige el diseño editorial de tus guías desde Plantillas: institucionales o personales, con vista previa antes de generar el PDF.",
                "pagination": "atomic"
            },
            {
                "type": "practice",
                "id": "crear-asignatura",
                "title": "2. Crea tu primera asignatura",
                "content": "En el panel selecciona {{keyterm:Nueva asignatura}}. Indica el código, el nombre y la carpeta de trabajo; Jintia prepara el proyecto sin mezclarlo con otras materias.\n\nAbre el editor de sílabo y completa los datos de cada semana: unidad, temas, resultado de aprendizaje, bibliografía, horas y actividad. Al guardar, genera el README del curso; este archivo será la fuente de verdad que la IA consultará."
            },
            {
                "type": "figure",
                "id": "fig-mis-cursos",
                "src": "figuras/mis-cursos.png",
                "alt": "Panel Mis cursos de Jintia mostrando una asignatura registrada, con su período, avance del sílabo y estado del proyecto.",
                "caption": "Mis cursos: cada asignatura queda organizada con su propia carpeta, avance de sílabo y accesos directos a Ask Jintia.",
                "pagination": "atomic"
            },
            {
                "type": "concept",
                "id": "ask-jintia",
                "title": "3. Trabaja con Ask Jintia",
                "content": "Abre Ask Jintia desde la asignatura para conservar el contexto correcto. Selecciona la semana y pide una acción concreta, por ejemplo: «crea la guía de la semana 1», «revisa la alineación entre resultado y actividad» o «valida las referencias».\n\nSi conectaste NotebookLM, Jintia puede contrastar el contenido con tus fuentes. Revisa siempre el resultado antes de publicarlo y no incluyas datos personales de estudiantes."
            },
            {
                "type": "figure",
                "id": "fig-ask-jintia",
                "src": "figuras/ask-jintia.png",
                "alt": "Pantalla de Ask Jintia con el contexto de una asignatura activo, el historial de conversaciones y el cuadro de mensaje.",
                "caption": "Ask Jintia conserva el contexto de la asignatura y la semana activa, y guarda el historial de cada conversación.",
                "pagination": "atomic"
            },
            {
                "type": "theory",
                "id": "generar-pdf",
                "title": "4. Genera y revisa la guía",
                "content": "Jintia crea primero el contenido estructurado de la guía, genera el HTML, aplica el CSS de la plantilla activa y renderiza el PDF con Vivliostyle. No necesitas instalar LaTeX para el flujo habitual.\n\nCuando termine, abre {{keyterm:PDFs generados}} para revisar el documento. Si algo falla, consulta Actividad del sistema: allí verás la etapa, el tiempo transcurrido y el diagnóstico que puedes copiar."
            },
            {
                "type": "figure",
                "id": "fig-pdfs",
                "src": "figuras/pdfs-generados.png",
                "alt": "Panel PDFs generados de Jintia mostrando un documento producido para una asignatura, con opciones para abrirlo o ver su carpeta.",
                "caption": "PDFs generados reúne automáticamente las guías producidas dentro de tus proyectos preparados.",
                "pagination": "atomic"
            },
            {
                "type": "scenario",
                "id": "primer-recorrido",
                "title": "Ejemplo de primer recorrido",
                "content": "Una docente crea la asignatura «Interacción Humano-Computador», completa la semana 1 del sílabo y abre Ask Jintia desde ese curso. Solicita una guía introductoria con una actividad breve y criterios de éxito.\n\nDespués revisa las fuentes, genera el PDF con la plantilla institucional y lo abre desde PDFs generados. Si necesita modificar algo, vuelve a Ask Jintia dentro de la misma semana para conservar el contexto."
            },
            {
                "type": "assessment",
                "id": "lista-inicio",
                "title": "Comprueba que estás listo",
                "items": [
                    "Identifica las secciones Mis cursos, Ask Jintia, PDFs generados, Plantillas y Configuración",
                    "Crea una asignatura y completa al menos una semana del sílabo",
                    "Abre Ask Jintia desde el curso y confirma la semana y el proveedor activos",
                    "Genera una guía, revisa el PDF y corrige cualquier observación antes de publicarlo",
                    "Usa Ayuda o copia el diagnóstico de Actividad del sistema si una operación falla"
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

        // Volcar las capturas incrustadas junto al guide.json para que las
        // rutas relativas `figuras/*.png` declaradas en welcome_guide_json()
        // resuelvan igual que cualquier figura real de una guía.
        let figuras_dir = guide_dir.join("figuras");
        fs::create_dir_all(&figuras_dir)
            .map_err(|e| format!("No se pudo crear el directorio de figuras: {e}"))?;
        for (name, bytes) in [
            ("mis-cursos.png", SCREENSHOT_MIS_CURSOS),
            ("ask-jintia.png", SCREENSHOT_ASK_JINTIA),
            ("pdfs-generados.png", SCREENSHOT_PDFS),
            ("plantillas.png", SCREENSHOT_PLANTILLAS),
        ] {
            fs::write(figuras_dir.join(name), bytes)
                .map_err(|e| format!("No se pudo escribir la captura {name}: {e}"))?;
        }

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
            let dest_dir = stable_pdf_dir();
            fs::create_dir_all(&dest_dir)
                .map_err(|e| format!("No se pudo preparar la carpeta de la guía: {e}"))?;
            let dest = dest_dir.join("guide.pdf");
            fs::copy(&pdf_file, &dest)
                .map_err(|e| format!("No se pudo conservar la guía generada: {e}"))?;
            stable_pdf = Some(dest);
            checks.insert("pdf".into(), json!("passed"));
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
