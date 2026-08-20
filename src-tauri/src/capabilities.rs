use crate::models::{ActionResult, DependencyStatus};
use crate::paths::path_text;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const DEPENDENCY_CACHE_TTL: Duration = Duration::from_secs(300);
static DEPENDENCY_CACHE: OnceLock<Mutex<Option<(Instant, Vec<DependencyStatus>)>>> =
    OnceLock::new();

fn dependency_cache() -> &'static Mutex<Option<(Instant, Vec<DependencyStatus>)>> {
    DEPENDENCY_CACHE.get_or_init(|| Mutex::new(None))
}

pub fn invalidate_dependency_cache() {
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

/// Busca un ejecutable en el directorio de herramientas administradas de Jintia
/// (runtimes/tools/<id>/bin/) antes de recurrir al PATH global del sistema.
/// Esto garantiza que check_dependencies() refleje exactamente el mismo entorno
/// con el que Jintia se ejecuta (ver engine::managed_runtime_path).
fn managed_or_system_command_exists(command: &str) -> bool {
    // Mapeo de comandos a sus IDs de herramienta administrada.
    let managed_id = match command {
        "dot" => Some("graphviz"),
        "plantuml" => Some("plantuml"),
        _ => None,
    };
    if let Some(id) = managed_id {
        if crate::paths::portable_tool_exe(id, command).is_file() {
            return true;
        }
    }
    command_exists(command)
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
    let node_version = crate::runtimes::node_version();
    let node_ready = node_version.is_some();

    let python_version = crate::runtimes::python_version();
    let python_ready = python_version.is_some();

    let vivliostyle_version = crate::runtimes::vivliostyle_version();
    let vivliostyle_ready = vivliostyle_version.is_some();

    let managed_contract = crate::release::managed_mcp_contract().ok();

    let skill_version = managed_contract.as_ref().and_then(|contract| {
        let skill_path = crate::runtimes::resolve_skill()?;
        let _: serde_json::Value = crate::engine::run_jintia_json(
            std::path::Path::new(&skill_path),
            &["capabilities", "profiles", "--json"],
        )
        .ok()?;
        Some(contract.jintia_version.clone())
    });
    let skill_ready = skill_version.is_some();

    let git = command_exists("git");

    let mut dependencies = vec![
        DependencyStatus {
            id: "node".to_string(),
            label: "Node.js".to_string(),
            category: "core".to_string(),
            status: if node_ready { "ready" } else { "missing" }.to_string(),
            blocking_scope: "onboarding".to_string(),
            requires_consent: true,
            operation: Some("download_node_runtime".to_string()),
            reason: "Ejecuta el motor editorial y las herramientas de publicación.".to_string(),
            technical_detail: format!(
                "node --version · {}",
                node_version.as_deref().unwrap_or("No encontrado")
            ),
            name: "Node.js".to_string(),
            installed: node_ready,
            version: node_version,
            required: true,
            installable: true,
            note: if node_ready {
                "Usando Node.js portable de Jintia.".to_string()
            } else {
                "Necesario para que la app funcione correctamente.".to_string()
            },
            command: "node --version".to_string(),
        },
        DependencyStatus {
            id: "git".to_string(),
            label: "Git".to_string(),
            category: "optional".to_string(),
            status: if git { "ready" } else { "missing" }.to_string(),
            blocking_scope: "none".to_string(),
            requires_consent: true,
            operation: Some("install_dependency".to_string()),
            reason: "Conserva el historial de cambios de tus asignaturas.".to_string(),
            technical_detail: "git --version".to_string(),
            name: "Git".to_string(),
            installed: git,
            version: version("git", &["--version"]),
            required: false,
            installable: true,
            note: "Opcional: guarda el historial de cambios de tus cursos.".to_string(),
            command: "git --version".to_string(),
        },
        DependencyStatus {
            id: "python".to_string(),
            label: "Python".to_string(),
            category: "core".to_string(),
            status: if python_ready { "ready" } else { "missing" }.to_string(),
            blocking_scope: "onboarding".to_string(),
            requires_consent: true,
            operation: Some("download_python_runtime".to_string()),
            reason: "Procesa bibliografía y recursos de las guías.".to_string(),
            technical_detail: format!(
                "python --version · {}",
                python_version.as_deref().unwrap_or("No encontrado")
            ),
            name: "Python".to_string(),
            installed: python_ready,
            version: python_version,
            required: true,
            installable: true,
            note: if python_ready {
                "Usando Python oficial portable de Jintia.".to_string()
            } else {
                "Procesa recursos del curso (recortes bibliográficos).".to_string()
            },
            command: "python --version".to_string(),
        },
        DependencyStatus {
            id: "jintia-skill".to_string(),
            label: "Jintia Skill".to_string(),
            category: "assistant".to_string(),
            status: if skill_ready { "ready" } else { "missing" }.to_string(),
            blocking_scope: "onboarding".to_string(),
            requires_consent: true,
            operation: Some("download_skill_runtime".to_string()),
            reason: "Da a tu asistente las instrucciones para crear materiales con Jintia."
                .to_string(),
            technical_detail: "jintia capabilities profiles --json".to_string(),
            name: "Jintia Skill".to_string(),
            installed: skill_ready,
            version: skill_version,
            required: true,
            installable: true,
            note: if skill_ready {
                "Usando Jintia portable de esta app.".to_string()
            } else {
                "Motor editorial para renderizar guías. Descárgalo desde Configuración > Entorno."
                    .to_string()
            },
            command: "jintia contract".to_string(),
        },
        DependencyStatus {
            id: "vivliostyle".to_string(),
            label: "Vivliostyle".to_string(),
            category: "core".to_string(),
            status: if vivliostyle_ready {
                "ready"
            } else {
                "missing"
            }
            .to_string(),
            blocking_scope: "onboarding".to_string(),
            requires_consent: true,
            operation: Some("install_vivliostyle_cli".to_string()),
            reason: "Convierte tus guías en documentos PDF listos para publicar.".to_string(),
            technical_detail: "vivliostyle --version".to_string(),
            name: "Vivliostyle CLI".to_string(),
            installed: vivliostyle_ready,
            version: vivliostyle_version,
            required: true,
            installable: true,
            note: if vivliostyle_ready {
                "Usando Vivliostyle CLI administrado por Jintia.".to_string()
            } else {
                "Motor HTML→PDF requerido por Jintia.".to_string()
            },
            command: "vivliostyle --version".to_string(),
        },
    ];

    // El compilador LaTeX es opcional. La skill puede renderizar a través de
    // Vivliostyle en lugar de LaTeX. Detección local únicamente para capacidades
    // avanzadas (plantillas LaTeX personalizadas, si existen en el futuro).
    let mcp_installed = managed_contract
        .as_ref()
        .is_some_and(crate::runtimes::portable_notebooklm_mcp_installed_for);
    let mcp_version = if mcp_installed {
        managed_contract
            .as_ref()
            .map(|contract| contract.version.clone())
    } else {
        None
    };
    dependencies.push(DependencyStatus {
        id: "notebooklm-mcp".to_string(),
        label: "NotebookLM MCP".to_string(),
        category: "integration".to_string(),
        status: if mcp_installed { "ready" } else { "missing" }.to_string(),
        blocking_scope: "onboarding".to_string(),
        requires_consent: true,
        operation: Some("install_notebooklm_mcp_runtime".to_string()),
        reason: "Conecta las fuentes de NotebookLM con el asistente que elijas.".to_string(),
        technical_detail: "Node administrado + ejecutable MCP verificado".to_string(),
        name: "NotebookLM MCP".to_string(),
        installed: mcp_installed,
        version: mcp_version,
        required: true,
        installable: true,
        note: "Servidor MCP administrado para consultar fuentes de NotebookLM.".to_string(),
        command: "managed Node + bin público del MCP".to_string(),
    });

    let latex = command_exists("pdflatex") && command_exists("biber");
    dependencies.push(DependencyStatus {
        id: "latex".to_string(),
        label: "Compilador LaTeX".to_string(),
        category: "optional".to_string(),
        status: if latex { "ready" } else { "missing" }.to_string(),
        blocking_scope: "none".to_string(),
        requires_consent: true,
        operation: None,
        reason: "Habilita plantillas LaTeX avanzadas; el flujo habitual usa Vivliostyle."
            .to_string(),
        technical_detail: "Instalación manual opcional: instala una distribución LaTeX de confianza y reinicia Jintia. Verificación: pdflatex --version · biber --version".to_string(),
        name: "Compilador LaTeX".to_string(),
        installed: latex,
        version: version("pdflatex", &["--version"]),
        required: false,
        installable: false,
        note: "Opcional: plantillas LaTeX avanzadas. La skill usa HTML/Vivliostyle por defecto."
            .to_string(),
        command: "pdflatex --version".to_string(),
    });

    let optional_visual_tools = [
        (
            "Graphviz",
            "dot",
            &["-V"][..],
            "Redes, mapas conceptuales y grafos.",
        ),
        (
            "PlantUML",
            "plantuml",
            &["-version"][..],
            "UML y diagramas técnicos formales.",
        ),
        (
            "D2",
            "d2",
            &["--version"][..],
            "Diagramas declarativos y cronologías.",
        ),
        (
            "Vega-Lite CLI",
            "vl2svg",
            &["--version"][..],
            "Gráficos cuantitativos reproducibles.",
        ),
        (
            "WaveDrom",
            "wavedrom-cli",
            &["--version"][..],
            "Señales digitales.",
        ),
        (
            "Inkscape",
            "inkscape",
            &["--version"][..],
            "Conversión SVG, PDF y previsualizaciones.",
        ),
    ];
    dependencies.extend(optional_visual_tools.into_iter().map(
        |(name, command, version_args, note)| {
            let available = managed_or_system_command_exists(command);
            let managed_id = match command {
                "dot" => Some("graphviz"),
                "plantuml" => Some("plantuml"),
                _ => None,
            };
            let is_managed = managed_id
                .is_some_and(|id| crate::paths::portable_tool_exe(id, command).is_file());
            let detail = if is_managed {
                format!("Usando {} administrado por Jintia.", name)
            } else {
                format!("Instalación manual opcional: usa el gestor de paquetes de tu sistema y reinicia Jintia. Verificación: {command} {}", version_args.join(" "))
            };
            DependencyStatus {
                id: name.to_ascii_lowercase().replace(' ', "_").replace('-', "_"),
                label: name.to_string(),
                category: "optional".to_string(),
                status: if available { "ready" } else { "missing" }.to_string(),
                blocking_scope: "none".to_string(),
                requires_consent: false,
                operation: None,
                reason: note.to_string(),
                technical_detail: detail,
                name: name.to_string(),
                installed: available,
                version: if available { version(command, version_args) } else { None },
                required: false,
                installable: false,
                note: format!("{note} Capacidad visual opcional; Jintia aplicará un fallback cuando sea válido."),
                command: format!("{command} {}", version_args.join(" ")),
            }
        },
    ));

    let mermaid = crate::runtimes::resolve_node_cli("mmdc");

    dependencies.push(DependencyStatus {
        id: "mermaid-cli".to_string(),
        label: "Mermaid CLI".to_string(),
        category: "optional".to_string(),
        status: if mermaid.is_some() { "ready" } else { "missing" }.to_string(),
        blocking_scope: "none".to_string(),
        requires_consent: false,
        operation: None,
        reason: "Crea flujos y diagramas sencillos cuando el perfil lo necesita.".to_string(),
        technical_detail: "Se prepara desde Herramientas recomendadas cuando el perfil lo requiere. Verificación: mmdc --version".to_string(),
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
        id: "google-chrome".to_string(),
        label: "Google Chrome".to_string(),
        category: "optional".to_string(),
        status: if chrome.is_some() { "ready" } else { "missing" }.to_string(),
        blocking_scope: "none".to_string(),
        requires_consent: false,
        operation: None,
        reason: "Permite capturas HTML reproducibles durante el renderizado.".to_string(),
        technical_detail: chrome.as_ref().map(|path| path_text(path)).unwrap_or_else(|| "CHROME_PATH".to_string()),
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

#[cfg(not(target_os = "windows"))]
fn manual_git_installation_instructions() -> &'static str {
    if cfg!(target_os = "macos") {
        "En macOS: instala Git con Homebrew (`brew install git`) o con Xcode Command Line Tools (`xcode-select --install`). Reinicia la app y vuelve a verificar."
    } else {
        "En Linux: instala Git con el gestor de paquetes de tu distribución (por ejemplo `sudo apt install git` en Debian/Ubuntu). Reinicia la app y vuelve a verificar."
    }
}

pub fn install_dependency(name: String, _confirmed: bool) -> ActionResult {
    // Una instalación puede cambiar el estado del entorno. La siguiente
    // verificación debe inspeccionarlo de nuevo.
    invalidate_dependency_cache();

    // LaTeX es opcional. No se ofrece instalación automática.
    if name == "Compilador LaTeX" {
        return ActionResult::error(
            "LaTeX es opcional. Instálalo manualmente según tu SO si lo necesitas.",
        );
    }

    // Node.js se descarga como portable via comando Tauri
    if name == "Node.js" {
        return ActionResult::error(
            "Usa el botón 'Descargar Node.js portable' en el panel de dependencias.",
        );
    }

    // Python se descarga como portable via comando Tauri (solo Windows)
    if name == "Python" {
        return ActionResult::error(
            "Usa el botón 'Descargar Python oficial portable' en el panel de dependencias.",
        );
    }

    // Jintia Skill se descarga como portable via comando Tauri
    if name == "Jintia Skill" {
        return ActionResult::error(
            "Usa el botón 'Descargar Jintia Skill' en el panel de dependencias.",
        );
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
        if name != "Git" {
            return ActionResult::error(format!("Dependencia desconocida: {name}"));
        }
        ActionResult::error(format!(
            "La instalación automática de Git está disponible solo en Windows. {}",
            manual_git_installation_instructions()
        ))
    }
}
