use crate::models::{ActionResult, DependencyStatus, WeekData};
use crate::paths::{
    atomic_write, atomic_write_if_changed, backup_file, canonical_directory, path_text,
    safe_segment, timestamp,
};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const DEPENDENCY_CACHE_TTL: Duration = Duration::from_secs(300);
static DEPENDENCY_CACHE: OnceLock<Mutex<Option<(Instant, Vec<DependencyStatus>)>>> =
    OnceLock::new();
static SYLLABUS_WRITE_OPERATION: Mutex<()> = Mutex::new(());
const COURSE_CODE_SLUG_MAX: usize = 24;
const COURSE_NAME_SLUG_MAX: usize = 48;


fn dependency_cache() -> &'static Mutex<Option<(Instant, Vec<DependencyStatus>)>> {
    DEPENDENCY_CACHE.get_or_init(|| Mutex::new(None))
}

fn invalidate_dependency_cache() {
    if let Ok(mut cache) = dependency_cache().lock() {
        *cache = None;
    }
}

fn command_exists(command: &str) -> bool {
    let checker = if cfg!(target_os = "windows") {
        "where.exe"
    } else {
        "which"
    };
    Command::new(checker)
        .arg(command)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn chrome_executable() -> Option<PathBuf> {
    if let Ok(configured) = std::env::var("CHROME_PATH") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Some(path);
        }
    }
    if cfg!(target_os = "windows") {
        for variable in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Ok(root) = std::env::var(variable) {
                let path = Path::new(&root)
                    .join("Google")
                    .join("Chrome")
                    .join("Application")
                    .join("chrome.exe");
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    ["google-chrome", "chromium", "chrome"]
        .into_iter()
        .find(|command| command_exists(command))
        .map(PathBuf::from)
}

fn version(command: &str, args: &[&str]) -> Option<String> {
    Command::new(command)
        .args(args)
        .output()
        .ok()
        .map(|output| {
            let text = if output.stdout.is_empty() {
                output.stderr
            } else {
                output.stdout
            };
            String::from_utf8_lossy(&text).into_owned()
        })
        .and_then(|text| {
            text.lines()
                .find(|line| !line.trim().is_empty())
                .map(str::trim)
                .map(str::to_string)
        })
}

pub fn check_dependencies() -> Vec<DependencyStatus> {

    let node_bin = crate::runtimes::resolve_node();
    let node = node_bin.is_some();
    let portable_node = crate::runtimes::portable_node_installed();

    let python_bin = crate::runtimes::resolve_python();
    let python = python_bin.is_some();
    let portable_python = crate::runtimes::portable_python_installed();
    let git = command_exists("git");

    let mut dependencies = vec![
        DependencyStatus {
            name: "Node.js".to_string(),
            installed: node,
            version: crate::runtimes::node_version(),
            required: true,
            installable: true,
            note: if portable_node {
                "Usando Node.js portable de Jintia.".to_string()
            } else {
                "Necesario para que la app funcione correctamente.".to_string()
            },
            command: "node --version".to_string(),
        },
        DependencyStatus {
            name: "Git".to_string(),
            installed: git,
            version: version("git", &["--version"]),
            required: false,
            installable: true,
            note: "Opcional: guarda el historial de cambios de tus cursos.".to_string(),
            command: "git --version".to_string(),
        },
        DependencyStatus {
            name: "Python".to_string(),
            installed: python,
            version: crate::runtimes::python_version(),
            required: true,
            installable: true,
            note: if portable_python {
                "Usando Python portable de Jintia.".to_string()
            } else {
                "Procesa recursos del curso (recortes bibliográficos).".to_string()
            },
            command: "python --version".to_string(),
        },
        DependencyStatus {
            name: "Jintia Skill".to_string(),
            installed: crate::runtimes::resolve_skill().is_some(),
            version: None,
            required: true,
            installable: true,
            note: if crate::runtimes::portable_skill_installed() {
                "Usando Jintia portable de esta app.".to_string()
            } else {
                "Motor editorial para renderizar guías. Descárgalo desde Configuración > Entorno.".to_string()
            },
            command: "jintia contract".to_string(),
        },
        DependencyStatus {
            name: "Vivliostyle CLI".to_string(),
            installed: crate::runtimes::resolve_vivliostyle().is_some(),
            version: crate::runtimes::vivliostyle_version(),
            required: true,
            installable: true,
            note: if crate::paths::portable_vivliostyle_bin().is_file() {
                "Usando Vivliostyle CLI administrado por Jintia.".to_string()
            } else {
                "Compilador HTML→PDF requerido por Jintia.".to_string()
            },
            command: "vivliostyle --version".to_string(),
        },
    ];

    // El compilador LaTeX es opcional. La skill puede renderizar a través de
    // Vivliostyle en lugar de LaTeX. Detección local únicamente para capacidades
    // avanzadas (plantillas LaTeX personalizadas, si existen en el futuro).
    dependencies.push(DependencyStatus {
        name: "NotebookLM MCP".to_string(),
        installed: crate::runtimes::portable_notebooklm_mcp_installed(),
        version: if crate::runtimes::portable_notebooklm_mcp_installed() { crate::release::managed_mcp_contract().ok().map(|contract| contract.version) } else { None },
        required: true,
        installable: true,
        note: "Servidor MCP administrado para consultar fuentes de NotebookLM.".to_string(),
        command: "managed Node + bin público del MCP".to_string(),
    });

    let latex = command_exists("pdflatex") && command_exists("biber");
    dependencies.push(DependencyStatus {
        name: "Compilador LaTeX".to_string(),
        installed: latex,
        version: version("pdflatex", &["--version"]),
        required: false,
        installable: true,
        note: "Opcional: plantillas LaTeX avanzadas. La skill usa HTML/Vivliostyle por defecto.".to_string(),
        command: "pdflatex --version".to_string(),
    });

    let optional_visual_tools = [
        ("Graphviz", "dot", &["-V"][..], "Redes, mapas conceptuales y grafos."),
        ("PlantUML", "plantuml", &["-version"][..], "UML y diagramas técnicos formales."),
        ("D2", "d2", &["--version"][..], "Diagramas declarativos y cronologías."),
        ("Vega-Lite CLI", "vl2svg", &["--version"][..], "Gráficos cuantitativos reproducibles."),
        ("WaveDrom", "wavedrom-cli", &["--version"][..], "Señales digitales."),
        ("Inkscape", "inkscape", &["--version"][..], "Conversión SVG, PDF y previsualizaciones."),
    ];
    dependencies.extend(optional_visual_tools.into_iter().map(
        |(name, command, version_args, note)| DependencyStatus {
            name: name.to_string(),
            installed: command_exists(command),
            version: version(command, version_args),
            required: false,
            installable: false,
            note: format!("{note} Capacidad visual opcional; Jintia aplicará un fallback cuando sea válido."),
            command: format!("{command} {}", version_args.join(" ")),
        },
    ));

    let mermaid =
        crate::runtimes::resolve_node_cli("mmdc");

    dependencies.push(DependencyStatus {
        name: "Mermaid CLI".to_string(),
        installed: mermaid.is_some(),
        version: crate::runtimes::node_cli_version(
            "mmdc",
            &["--version"],
        ),
        required: false,
        installable: false,
        note: if mermaid.is_some() {
            "Usando Mermaid CLI administrado por Jintia."
                .to_string()
        } else {
            "Flujos y decisiones simples. Capacidad visual opcional; se instala automáticamente cuando el perfil de la disciplina la requiere."
                .to_string()
        },
        command: "mmdc --version".to_string(),
    });
    let chrome = chrome_executable();
    dependencies.push(DependencyStatus {
        name: "Google Chrome".to_string(),
        installed: chrome.is_some(),
        version: None,
        required: false,
        installable: false,
        note: "Capturas HTML reproducibles en segundo plano; Jintia no abre ventanas durante el renderizado.".to_string(),
        command: chrome
            .map(|path| path_text(&path))
            .unwrap_or_else(|| "CHROME_PATH".to_string()),
    });

    if let Ok(mut cache) = dependency_cache().lock() {
        *cache = Some((Instant::now(), dependencies.clone()));
    }
    dependencies
}

/// Reutiliza la inspección que ya mostró el paso de entorno. La verificación
/// de TeX Live puede tardar varios segundos, así que repetirla inmediatamente
/// al pulsar "Continuar" no aporta una validación más fiable.
pub fn check_dependencies_cached() -> Vec<DependencyStatus> {
    if let Ok(cache) = dependency_cache().lock() {
        if let Some((checked_at, dependencies)) = cache.as_ref() {
            if checked_at.elapsed() <= DEPENDENCY_CACHE_TTL {
                return dependencies.clone();
            }
        }
    }
    check_dependencies()
}

pub fn install_dependency(name: String, _confirmed: bool) -> ActionResult {
    // Una instalación puede cambiar el estado del entorno. La siguiente
    // verificación debe inspeccionarlo de nuevo.
    invalidate_dependency_cache();

    // LaTeX es opcional. No se ofrece instalación automática.
    if name == "Compilador LaTeX" {
        return ActionResult::error("LaTeX es opcional. Instálalo manualmente según tu SO si lo necesitas.");
    }

    // Node.js se descarga como portable via comando Tauri
    if name == "Node.js" {
        return ActionResult::error("Usa el botón 'Descargar Node.js portable' en el panel de dependencias.");
    }

    // Python se descarga como portable via comando Tauri (solo Windows)
    if name == "Python" {
        return ActionResult::error("Usa el botón 'Descargar Python portable' en el panel de dependencias.");
    }

    // Jintia Skill se descarga como portable via comando Tauri
    if name == "Jintia Skill" {
        return ActionResult::error("Usa el botón 'Descargar Jintia Skill' en el panel de dependencias.");
    }
    if name == "NotebookLM MCP" {
        return crate::runtimes::install_notebooklm_mcp()
            .map(|_| ActionResult::ok("NotebookLM MCP administrado instalado correctamente."))
            .unwrap_or_else(ActionResult::error);
    }

    #[cfg(target_os = "windows")]
    {
        let package = match name.as_str() {
            "Git" => "Git.Git",
            "Python" => "Python.Python.3.13",
            _ => return ActionResult::error(format!("Dependencia desconocida: {name}")),
        };
        match Command::new("winget.exe")
            .args([
                "install",
                "--id",
                package,
                "--exact",
                "--silent",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ])
            .status()
        {
            Ok(status) if status.success() => {
                ActionResult::ok(format!("{name} instalado correctamente."))
            }
            Ok(status) => {
                ActionResult::error(format!("winget terminó con código {:?}.", status.code()))
            }
            Err(error) => ActionResult::error(format!("No se pudo ejecutar winget: {error}")),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = _confirmed;
        let instructions = if cfg!(target_os = "macos") {
            "En macOS: instala Node.js y Python con Homebrew (`brew install node python`). Reinicia la app y vuelve a verificar."
        } else {
            "En Linux: instala Node.js, npm y Python con el gestor de paquetes de tu distribución (por ejemplo `sudo apt install nodejs npm python3`). Reinicia la app y vuelve a verificar."
        };
        ActionResult::error(format!(
            "La instalación automática de {name} está disponible solo en Windows. {instructions}"
        ))
    }
}

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

fn course_folder_name(course_code: &str, course_name: &str) -> Result<String, String> {
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

fn course_directory(root: &Path, course_code: &str, course_name: &str) -> Result<PathBuf, String> {
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
        None => return ActionResult::error("Jintia Skill no está instalada. Ve a Configuración > Entorno."),
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
                ActionResult::error(format!(
                    "Error al crear el proyecto:\n{}",
                    result.stderr
                ))
            }
        }
        Err(error) => ActionResult::error(error),
    }
}

pub fn run_self_test() -> serde_json::Value {
    let skill_path = match crate::runtimes::resolve_skill() {
        Some(p) => p,
        None => return serde_json::json!({ "ok": false, "error": "Jintia Skill no está disponible." }),
    };
    crate::engine::run_jintia_json::<serde_json::Value>(
        Path::new(&skill_path),
        &["self-test", "--json"],
    )
    .unwrap_or_else(|error| serde_json::json!({ "ok": false, "error": error }))
}

fn write_course_settings(course: &Path, include_graded_activities: bool) -> Result<(), String> {
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

fn bullets(text: &str) -> Vec<String> {
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

fn labelled_outcomes(text: &str) -> Vec<String> {
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

fn list_block(items: Vec<String>, empty: &str) -> String {
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

fn append_demo_week(full_content: &mut String, week: &WeekData, marginal_layout: bool) {
    full_content.push_str(
        "\\begin{mintblock}[title=Resultado de aprendizaje de la semana]\n\
         Al finalizar, podrás:\n\\begin{itemize}\n",
    );
    for line in week.outcomes.lines().filter(|line| !line.trim().is_empty()) {
        full_content.push_str(&format!("\\item {}\n", line.trim()));
    }
    full_content.push_str("\\end{itemize}\n\\end{mintblock}\n\n");
    if marginal_layout {
        full_content.push_str(
            "\\marginconcept{Criterio}{Condición explícita y observable usada para comparar alternativas.}\n",
        );
    }
    full_content.push_str(
        "\
         \\guidesection{Antes de empezar: una decisión cotidiana}\n\
         \\begin{softblock}\n\
         Una organización debe elegir una nueva plataforma para atender solicitudes de sus usuarios. \
         Una opción es económica, otra es fácil de usar y una tercera ofrece mejores controles de seguridad. \
         Cada área recomienda una alternativa distinta y la reunión termina con una frase conocida: \
         ``escojamos la que parece mejor''.\n\n\
         El problema no es la falta de opiniones. El problema es que todavía no existe una forma compartida \
         de comparar las opciones. Esta semana aprenderás a transformar una preferencia intuitiva en una \
         recomendación profesional que otra persona pueda revisar, cuestionar y mejorar.\n\n\
         \\textbf{Tiempo estimado:} 2 horas de estudio guiado, 2 horas de práctica y 4 horas de trabajo autónomo.\n\
         \\end{softblock}\n\n\
         \\guidesection{1. De la información a la evidencia}\n\
         Una decisión justificable separa tres elementos que suelen confundirse:\n\
         \\begin{accentblock}[title=Tres niveles de lectura]\n\
         \\begin{itemize}\n\
         \\item \\textbf{Dato:} registro observable sin una conclusión incorporada. Ejemplo: 38 de 50 usuarios completaron una tarea.\n\
         \\item \\textbf{Evidencia:} dato pertinente y suficientemente confiable para responder una pregunta concreta. El mismo registro es evidencia si la pregunta es cuál opción facilita completar la tarea.\n\
         \\item \\textbf{Interpretación:} explicación razonada de lo que la evidencia significa, considerando contexto y límites. En este caso, el resultado sugiere facilidad de uso, pero no demuestra seguridad ni costo total.\n\
         \\end{itemize}\n\
         \\end{accentblock}\n\n\
         Una cifra no se convierte automáticamente en evidencia. Primero debe relacionarse con la decisión, \
         provenir de una fuente identificable y permitir una comparación razonable. Pregunta siempre: \
         \\textit{¿qué decisión ayuda a tomar este dato y qué no permite concluir?}\n\n\
         \\begin{sandblock}[title=Pausa de recuperación]\n\
         Un proveedor afirma que su plataforma tiene ``95 puntos de satisfacción''. Antes de aceptar esa cifra, \
         escribe tres preguntas sobre la muestra, la forma de medición y el grupo con el que se compara.\n\
         \\end{sandblock}\n\n\
         \\guidesection{2. Comparar alternativas con criterios explícitos}\n\
         Elegir profesionalmente requiere declarar qué significa una buena decisión antes de enamorarse de una opción. \
         Un \\textbf{criterio} es una condición utilizada para comparar alternativas. Debe ser relevante, comprensible \
         y observable.\n\n\
         \\begin{accentblock}[title=Herramienta: matriz de decisión en cinco pasos]\n\
         \\begin{enumerate}\n\
         \\item Formula la decisión en una pregunta: ``¿qué plataforma conviene implementar durante el próximo año?''\n\
         \\item Define criterios antes de puntuar: accesibilidad, facilidad de uso, seguridad, costo total y soporte.\n\
         \\item Asigna a cada criterio una importancia relativa y documenta por qué.\n\
         \\item Puntúa cada alternativa con la misma escala y vincula cada puntuación con una evidencia.\n\
         \\item Revisa si un cambio pequeño en los pesos modifica la recomendación. Si la cambia, la decisión es sensible y necesita más información.\n\
         \\end{enumerate}\n\
         \\end{accentblock}\n\n\
         Cuando varios criterios tienen distinta importancia, puede utilizarse una puntuación ponderada. \
         Para cada alternativa $A_j$, se multiplica el peso $w_i$ de cada criterio por su puntuación $s_{ij}$:\n\
         \\begin{equation}\n\
         P(A_j)=\\sum_{i=1}^{n} w_i s_{ij}, \\qquad \\sum_{i=1}^{n} w_i=1\n\
         \\label{eq:puntuacion-ponderada}\n\
         \\end{equation}\n\
         La ecuación no reemplaza el juicio profesional: hace visibles sus supuestos y permite revisar cómo se obtuvo el resultado.\n\n\
         \\begin{guidetable}\n\
         \\guidetablecaption{Comparación resumida de las alternativas del caso.}{tab:comparacion-alternativas}\n\
         \\small\n\
         \\begin{tabularx}{\\textwidth}{lXXX}\n\
         \\toprule\n\
         \\textbf{Alternativa} & \\textbf{Fortaleza principal} & \\textbf{Riesgo observado} & \\textbf{Evidencia disponible} \\\\\n\
         \\midrule\n\
         A & Menor costo inicial & Más pasos para el usuario & Cotización y prueba de tareas \\\\\n\
         B & Mejor accesibilidad y uso & Costo variable por volumen & Prueba con usuarios y revisión de seguridad \\\\\n\
         C & Mayor número de funciones & Soporte en otro huso horario & Demostración del proveedor \\\\\n\
         \\bottomrule\n\
         \\end{tabularx}\n\
         \\end{guidetable}\n\n\
         La Tabla~\\ref{tab:comparacion-alternativas} permite contrastar fortalezas, riesgos y calidad de evidencia, \
         mientras la Ecuación~\\ref{eq:puntuacion-ponderada} documenta cómo combinar criterios cuando se requiere una puntuación total.\n\n\
         \\begin{softblock}[title=Ejemplo trabajado]\n\
         El comité considera que la accesibilidad y la seguridad son críticas, mientras que el precio es importante \
         pero no decisivo. La opción A cuesta menos, aunque exige más pasos para completar una solicitud. La opción B \
         obtiene mejores resultados en una prueba con usuarios y cumple los controles requeridos. La opción C ofrece \
         más funciones, pero su soporte solo está disponible en otro huso horario.\n\n\
         La recomendación preliminar favorece la opción B. No porque ``sea la mejor'' en términos absolutos, sino porque \
         responde mejor a los criterios acordados y cuenta con evidencia directa en los aspectos de mayor importancia.\n\
         \\end{softblock}\n\n\
         La Figura~\\ref{fig:ruta-decision} resume la ruta completa. Observa que la recomendación no aparece al inicio: \
         es el resultado de hacer explícitos los criterios, contrastar evidencia y comparar alternativas.\n\n\
         \\begin{guidefigure}\n\
         \\begin{tikzpicture}[\n\
           node distance=5mm,\n\
           stage/.style={draw,rounded corners=2mm,fill=softbg,draw=softline,text=ink,\n\
             minimum width=7.2cm,text width=6.5cm,minimum height=9mm,align=center,inner sep=2.5mm},\n\
           key/.style={stage,fill=weekaccent!10,draw=weekaccent,line width=.8pt},\n\
           flow/.style={-{Stealth[length=2.5mm]},line width=.8pt,draw=weekaccent}\n\
         ]\n\
         \\node[stage] (question) {\\textbf{1. Formular la decisión}\\\\Una pregunta concreta y delimitada};\n\
         \\node[stage,below=of question] (criteria) {\\textbf{2. Acordar criterios}\\\\Qué significa una buena alternativa};\n\
         \\node[stage,below=of criteria] (evidence) {\\textbf{3. Reunir evidencia}\\\\Datos pertinentes, confiables y comparables};\n\
         \\node[stage,below=of evidence] (compare) {\\textbf{4. Comparar y probar sensibilidad}\\\\Puntuaciones, pesos, riesgos y vacíos};\n\
         \\node[key,below=of compare] (recommend) {\\textbf{5. Recomendar y revisar}\\\\Decisión, razones, límites y próximo paso};\n\
         \\draw[flow] (question) -- (criteria);\n\
         \\draw[flow] (criteria) -- (evidence);\n\
         \\draw[flow] (evidence) -- (compare);\n\
         \\draw[flow] (compare) -- (recommend);\n\
         \\end{tikzpicture}\n\
         \\guidefigurecaption{Ruta de una decisión profesional justificable.}{fig:ruta-decision}\n\
         \\end{guidefigure}\n\n\
         \\guidesection{3. Sesgos, incertidumbre y límites}\n\
         Incluso una matriz ordenada puede amplificar juicios débiles. Tres riesgos son especialmente frecuentes:\n\
         \\begin{roseblock}[title=Señales de alerta]\n\
         \\begin{itemize}\n\
         \\item \\textbf{Anclaje:} la primera cifra o propuesta condiciona las comparaciones posteriores.\n\
         \\item \\textbf{Confirmación:} se buscan datos que apoyan la opción preferida y se ignoran los contrarios.\n\
         \\item \\textbf{Exceso de confianza:} se presenta una estimación como certeza y se ocultan los vacíos de información.\n\
         \\end{itemize}\n\
         \\end{roseblock}\n\n\
         La respuesta profesional no consiste en fingir certeza. Consiste en declarar los límites: qué información falta, \
         qué riesgo permanece y qué hecho haría reconsiderar la decisión. Una prueba piloto puede ser una mejor decisión \
         que una adopción total cuando la evidencia todavía es incompleta.\n\n\
         \\guidesection{4. Del análisis a una recomendación clara}\n\
         \\begin{mintblock}[title=Estructura de una recomendación profesional]\n\
         \\begin{enumerate}\n\
         \\item \\textbf{Decisión:} expresa qué se recomienda y para qué contexto.\n\
         \\item \\textbf{Razones:} conecta los criterios prioritarios con la evidencia disponible.\n\
         \\item \\textbf{Límites:} identifica supuestos, datos faltantes y posibles efectos adversos.\n\
         \\item \\textbf{Próximo paso:} propone una acción verificable, una persona responsable y una fecha de revisión.\n\
         \\end{enumerate}\n\
         \\end{mintblock}\n\n\
         \\begin{accentblock}[title=Recomendación del caso]\n\
         Se recomienda realizar un piloto de cuatro semanas con la opción B porque obtuvo mejores resultados de accesibilidad \
         y facilidad de uso, y cumple los controles de seguridad establecidos. La estimación de costos aún depende del volumen \
         real de solicitudes; por ello, el piloto debe registrar tiempos de atención, incidencias, satisfacción y costo por caso. \
         El comité revisará esos indicadores antes de autorizar la implementación completa.\n\
         \\end{accentblock}\n\n\
         \\guidesection{Transferencia a cualquier profesión}\n\
         El método no depende del sector. Una profesional de salud puede comparar intervenciones; un docente, estrategias de \
         evaluación; una ingeniera, soluciones técnicas; un abogado, cursos de acción; y un administrador, proveedores. \
         En todos los casos cambia el contenido experto, pero permanece la secuencia: formular la decisión, acordar criterios, \
         buscar evidencia, comparar alternativas, declarar incertidumbre y comunicar una recomendación revisable.\n\n\
         \\begin{sandblock}[title=Actividad calificada]\n",
    );
    if let Some(activity) = week
        .graded_activity
        .as_ref()
        .filter(|activity| !activity.trim().is_empty())
    {
        full_content.push_str(activity.trim());
    }
    full_content.push_str(
        "\n\n\\textbf{Criterios de logro:} la entrega distingue hechos de supuestos, aplica los mismos criterios a todas \
         las alternativas, vincula cada conclusión con evidencia e identifica al menos una limitación.\n\
         \\end{sandblock}\n\n\
         \\guidesection{Autoevaluación}\n\
         Antes de entregar, comprueba:\n\
         \\begin{itemize}\n\
         \\item Puedo explicar la diferencia entre dato, evidencia e interpretación.\n\
         \\item Definí los criterios antes de seleccionar una alternativa.\n\
         \\item Puedo rastrear cada puntuación hasta una fuente o una observación.\n\
         \\item Reconocí un sesgo posible y un vacío de información.\n\
         \\item Mi recomendación incluye un próximo paso verificable.\n\
         \\end{itemize}\n\n\
         \\guidesection{Referencias bibliográficas}\n\
         \\begin{softblock}\n\\begin{itemize}\n",
    );
    for line in week
        .bibliography
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        full_content.push_str(&format!("\\item {}\n", line.trim()));
    }
    full_content.push_str("\\end{itemize}\n\\end{softblock}\n\n");
}

#[cfg(test)]
mod tests {
    use super::*;

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

pub fn check_migration_needed(
    course_path: String,
) -> crate::models::MigrationStatus {
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
                            if tex_entry.path().extension().and_then(|s| s.to_str()) == Some("tex") {
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
        None => return ActionResult::error("Jintia Skill no está instalada. Ve a Configuración > Entorno."),
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
