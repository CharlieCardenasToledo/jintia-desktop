mod approval;
mod capabilities;
mod claude;
mod codex;
mod config;
mod course;
mod course_state;
mod engine;
mod harnesses;
mod mcp;
mod models;
mod onboarding;
mod opencode;
mod palette;
mod paths;
mod pdfs;
mod process;
mod progress_journal;
mod release;
mod runtimes;
mod toolchain;

use models::{
    ActionResult, DependencyStatus, GeneratedPdf, InstitutionConfig, MigrationStatus,
    NotebookEntry, NotebookLmAuthStatus, OnboardingResult, PdfProjectRoot, SelfTestRecord,
    SetupStatus, TemplateMeta, WeekData,
};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn open_web_source(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Enlace de fuente no válido".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Solo se permiten fuentes web HTTP o HTTPS".to_string());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| format!("No se pudo abrir la fuente: {error}"))
}

#[tauri::command]
async fn check_dependencies() -> Vec<DependencyStatus> {
    tauri::async_runtime::spawn_blocking(capabilities::check_dependencies)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn check_skill_update_status() -> models::SkillUpdateStatus {
    tauri::async_runtime::spawn_blocking(release::check_skill_update)
        .await
        .unwrap_or(models::SkillUpdateStatus {
            installed_version: None,
            latest_npm_version: None,
            update_available: false,
        })
}

#[tauri::command]
async fn download_node_runtime(app: tauri::AppHandle) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        runtimes::download_portable_node(&app)
            .map(|_| ActionResult::ok("Node.js portable instalado correctamente."))
            .unwrap_or_else(|e| ActionResult::error(e))
    })
    .await
    .unwrap_or_else(|e| ActionResult::error(format!("{e}")))
}

#[tauri::command]
async fn get_node_runtime_status() -> serde_json::Value {
    serde_json::json!({
        "hasGlobal": runtimes::global_node_available(),
        "hasPortable": runtimes::portable_node_installed(),
        "resolvedPath": runtimes::resolve_node(),
        "version": runtimes::node_version(),
    })
}

#[tauri::command]
async fn download_python_runtime(app: tauri::AppHandle) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        runtimes::download_portable_python(&app)
            .map(|_| ActionResult::ok("Python portable instalado correctamente."))
            .unwrap_or_else(|e| ActionResult::error(e))
    })
    .await
    .unwrap_or_else(|e| ActionResult::error(format!("{e}")))
}

#[tauri::command]
async fn get_python_runtime_status() -> serde_json::Value {
    serde_json::json!({
        "hasGlobal": runtimes::global_python_available(),
        "hasPortable": runtimes::portable_python_installed(),
        "resolvedPath": runtimes::resolve_python(),
        "version": runtimes::python_version(),
    })
}

#[tauri::command]
async fn download_skill_runtime(app: tauri::AppHandle) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        runtimes::download_portable_skill(&app)
            .map(|_| ActionResult::ok("Jintia portable instalada correctamente."))
            .unwrap_or_else(|e| ActionResult::error(e))
    })
    .await
    .unwrap_or_else(|e| ActionResult::error(format!("{e}")))
}

#[tauri::command]
async fn install_notebooklm_mcp_runtime(app: tauri::AppHandle) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        runtimes::emit_dependency_progress(
            &app,
            "NotebookLM MCP",
            "resolving",
            None,
            "Comprobando el contrato de NotebookLM MCP…",
        );
        runtimes::emit_dependency_progress(
            &app,
            "NotebookLM MCP",
            "installing",
            None,
            "Instalando el paquete y sus dependencias…",
        );
        let result = runtimes::install_notebooklm_mcp()
            .map(|_| ActionResult::ok("NotebookLM MCP administrado instalado correctamente."))
            .unwrap_or_else(ActionResult::error);
        runtimes::emit_dependency_progress(
            &app,
            "NotebookLM MCP",
            if result.success { "done" } else { "error" },
            if result.success { Some(100.0) } else { None },
            &result.message,
        );
        result
    })
    .await
    .unwrap_or_else(|e| ActionResult::error(format!("No se pudo instalar NotebookLM MCP: {e}")))
}

#[tauri::command]
async fn get_skill_runtime_status() -> serde_json::Value {
    serde_json::json!({
        "hasGlobal": runtimes::global_skill_available(),
        "hasPortable": runtimes::portable_skill_installed(),
        "resolvedPath": runtimes::resolve_skill(),
    })
}

#[tauri::command]
async fn get_visual_install_profiles() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(runtimes::visual_install_profiles)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_else(|| {
            serde_json::json!({
                "version": 3,
                "disciplines": {},
                "profiles": []
            })
        })
}

#[tauri::command]
async fn install_dependency(name: String, confirmed: Option<bool>) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        capabilities::install_dependency(name, confirmed.unwrap_or(false))
    })
    .await
    .unwrap_or_else(|error| {
        ActionResult::error(format!("No se pudo ejecutar la instalación: {error}"))
    })
}

#[tauri::command]
async fn get_onboarding_status() -> models::OnboardingStatus {
    onboarding::get_status()
}

#[tauri::command]
async fn advance_onboarding(step: u8, selected_target: Option<String>) -> models::OnboardingResult {
    tauri::async_runtime::spawn_blocking(move || onboarding::advance(step, selected_target))
        .await
        .unwrap_or_else(|error| models::OnboardingResult {
            success: false,
            message: format!("No se pudo avanzar el onboarding: {error}"),
            status: onboarding::get_status(),
        })
}

#[tauri::command]
async fn go_to_onboarding_step(step: u8) -> models::OnboardingResult {
    onboarding::go_to_step(step)
}

#[tauri::command]
async fn complete_onboarding() -> models::OnboardingResult {
    tauri::async_runtime::spawn_blocking(onboarding::complete)
        .await
        .unwrap_or_else(|error| models::OnboardingResult {
            success: false,
            message: format!("No se pudo finalizar el onboarding: {error}"),
            status: onboarding::get_status(),
        })
}

#[tauri::command]
async fn reset_onboarding() -> models::OnboardingResult {
    onboarding::reset()
}

#[tauri::command]
async fn get_skill_path() -> String {
    tauri::async_runtime::spawn_blocking(|| {
        crate::toolchain::agent_skills_status()
            .map(|status| status.claude.target)
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn install_skill() -> ActionResult {
    tauri::async_runtime::spawn_blocking(|| {
        let result = toolchain::install_global_agent_skills();
        if result.success {
            if let Err(error) = config::sync_existing_user_config_to_installs() {
                return ActionResult::error(format!(
                    "Las skills se instalaron, pero no se pudo sincronizar la configuración existente: {error}"
                ));
            }
        }
        result
    })
        .await
        .unwrap_or_else(|error| {
            ActionResult::error(format!("No se pudo instalar Jintia Skill: {error}"))
        })
}

#[tauri::command]
async fn install_openai_plugin() -> ActionResult {
    tauri::async_runtime::spawn_blocking(|| {
        let result = toolchain::install_openai_plugin();
        if result.success {
            if let Err(error) = config::sync_existing_user_config_to_installs() {
                return ActionResult::error(format!(
                    "El plugin se instaló, pero no se pudo sincronizar la configuración existente: {error}"
                ));
            }
        }
        result
    })
        .await
        .unwrap_or_else(|e| {
            ActionResult::error(format!("No se pudo instalar el plugin OpenAI: {e}"))
        })
}

#[tauri::command]
async fn configure_mcp(target: String) -> ActionResult {
    mcp::configure_mcp(target)
}

#[tauri::command]
async fn configure_codex_mcp() -> ActionResult {
    mcp::configure_codex_mcp()
}

#[tauri::command]
async fn apply_institution_config(config: InstitutionConfig) -> ActionResult {
    config::apply_institution(config)
}

#[tauri::command]
async fn extract_site_palette(url: String) -> Result<models::SitePalette, String> {
    palette::extract_site_palette(url).await
}

#[tauri::command]
async fn save_notebooks_config(entries: Vec<NotebookEntry>) -> ActionResult {
    config::save_notebooks(entries)
}

#[tauri::command]
async fn get_setup_status() -> SetupStatus {
    tauri::async_runtime::spawn_blocking(config::setup_status)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn check_notebooklm_auth() -> NotebookLmAuthStatus {
    tauri::async_runtime::spawn_blocking(mcp::check_auth)
        .await
        .unwrap_or_else(|error| NotebookLmAuthStatus {
            authenticated: false,
            message: format!("No se pudo verificar NotebookLM: {error}"),
        })
}

#[tauri::command]
async fn run_notebooklm_auth() -> ActionResult {
    tauri::async_runtime::spawn_blocking(mcp::start_auth)
        .await
        .unwrap_or_else(|error| {
            ActionResult::error(format!("No se pudo iniciar la autenticación: {error}"))
        })
}

#[tauri::command]
async fn start_notebooklm_auth(app: tauri::AppHandle, operation_id: String) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        let event_app = app.clone();
        mcp::start_auth_operation(operation_id, move |status| {
            let _ = event_app.emit("notebooklm-auth-progress", status);
        })
    })
    .await
    .unwrap_or_else(|error| {
        ActionResult::error(format!("No se pudo iniciar la autenticación: {error}"))
    })
}

#[tauri::command]
async fn cancel_notebooklm_auth(operation_id: String) -> ActionResult {
    mcp::cancel_auth(&operation_id)
}

#[tauri::command]
async fn list_notebooks_mcp() -> Result<Vec<models::NotebookLmEntry>, String> {
    tauri::async_runtime::spawn_blocking(mcp::list_notebooks)
        .await
        .map_err(|error| format!("No se pudo listar los notebooks: {error}"))?
}

#[tauri::command]
async fn list_account_notebooks_mcp() -> Result<Vec<models::NotebookLmEntry>, String> {
    tauri::async_runtime::spawn_blocking(mcp::list_account_notebooks)
        .await
        .map_err(|error| format!("No se pudo listar los notebooks de la cuenta: {error}"))?
}

#[tauri::command]
async fn create_course_structure(
    root_path: String,
    course_code: String,
    course_name: String,
) -> ActionResult {
    course::create_course_structure(
        root_path,
        course_code,
        course_name,
        0,     // weeks no es usado
        true,  // initialize_readme
        false, // include_graded_activities
    )
}

#[tauri::command]
async fn save_course_settings(
    course_path: String,
    course_code: String,
    course_name: String,
    include_graded_activities: Option<bool>,
) -> ActionResult {
    course::save_course_settings(
        course_path,
        course_code,
        course_name,
        include_graded_activities.unwrap_or(false),
    )
}

#[tauri::command]
async fn get_default_course_root(app: tauri::AppHandle) -> ActionResult {
    match app.path().document_dir() {
        Ok(path) => {
            let jintia_root = path.join("Jintia");
            ActionResult::ok("Carpeta de proyectos Jintia disponible.")
                .with_path(jintia_root.to_string_lossy().into_owned())
        }
        Err(error) => ActionResult::error(format!(
            "No se pudo localizar la carpeta Documentos: {error}"
        )),
    }
}

#[tauri::command]
async fn get_course_state(project_path: String) -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || course_state::read(project_path))
        .await
        .unwrap_or_else(|error| serde_json::json!({ "success": false, "message": format!("No se pudo leer el estado: {error}") }))
}

#[tauri::command]
async fn check_week_guide_exists(project_path: String, week: u32) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        course_state::week_guide_exists(project_path, week)
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
async fn detect_harnesses(
    project_path: String,
    explicit_providers: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        harnesses::detect(project_path, explicit_providers)
    })
    .await
    .map_err(|error| format!("No se pudieron detectar los harnesses: {error}"))?
}

#[tauri::command]
async fn manage_harnesses(
    operation: String,
    project_path: String,
    providers: Option<Vec<String>>,
    scope: String,
    confirm: bool,
) -> models::ToolchainReport {
    tauri::async_runtime::spawn_blocking(move || {
        toolchain::manage_harness(
            operation,
            project_path,
            providers.unwrap_or_default(),
            scope,
            confirm,
        )
    })
    .await
    .unwrap_or_else(|error| {
        models::ToolchainReport::error(format!("No se pudo gestionar el harness: {error}"))
    })
}

#[tauri::command]
async fn list_generated_pdfs(projects: Vec<PdfProjectRoot>) -> Vec<GeneratedPdf> {
    tauri::async_runtime::spawn_blocking(move || pdfs::list_generated_pdfs(projects))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn open_generated_pdf(
    app: tauri::AppHandle,
    path: String,
    projects: Vec<PdfProjectRoot>,
) -> ActionResult {
    let path = match pdfs::validated_pdf_path(&path, &projects) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    match app.opener().open_path(path.to_string_lossy(), None::<&str>) {
        Ok(()) => ActionResult::ok("PDF abierto."),
        Err(error) => ActionResult::error(format!("No se pudo abrir el PDF: {error}")),
    }
}

#[tauri::command]
async fn reveal_generated_pdf(
    app: tauri::AppHandle,
    path: String,
    projects: Vec<PdfProjectRoot>,
) -> ActionResult {
    let path = match pdfs::validated_pdf_path(&path, &projects) {
        Ok(path) => path,
        Err(error) => return ActionResult::error(error),
    };
    match app.opener().reveal_item_in_dir(path) {
        Ok(()) => ActionResult::ok("PDF localizado en su carpeta."),
        Err(error) => ActionResult::error(format!("No se pudo mostrar la carpeta: {error}")),
    }
}

#[tauri::command]
async fn generate_syllabus(
    course_path: String,
    course_code: String,
    course_name: String,
    credits: u32,
    academic_period: String,
    semester: String,
    description: String,
    weeks_data: Vec<WeekData>,
) -> ActionResult {
    course::generate_syllabus(
        course_path,
        course_code,
        course_name,
        credits,
        academic_period,
        semester,
        description,
        weeks_data,
    )
}

#[tauri::command]
async fn list_templates() -> Vec<TemplateMeta> {
    config::list_templates()
}

#[tauri::command]
async fn get_active_template() -> String {
    config::get_active_template()
}

#[tauri::command]
async fn set_active_template(template_id: String) -> ActionResult {
    config::set_active_template(template_id)
}

#[tauri::command]
async fn run_skill_tool(
    operation: String,
    target: Option<String>,
    json: Option<bool>,
    strict: Option<bool>,
) -> models::ToolchainReport {
    tauri::async_runtime::spawn_blocking(move || toolchain::run(operation, target, json, strict))
        .await
        .unwrap_or_else(|error| {
            models::ToolchainReport::error(format!("No se pudo ejecutar la toolchain: {error}"))
        })
}

#[tauri::command]
async fn check_migration_needed(project_path: String) -> MigrationStatus {
    tauri::async_runtime::spawn_blocking(move || course::check_migration_needed(project_path))
        .await
        .unwrap_or_else(|_| MigrationStatus {
            needs_migration: false,
            latex_dirs_found: 0,
            tex_files_found: 0,
            dry_run_report: None,
        })
}

#[tauri::command]
async fn run_migration(project_path: String) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || course::run_migration(project_path))
        .await
        .unwrap_or_else(|error| {
            ActionResult::error(format!("No se pudo ejecutar la migración: {error}"))
        })
}

#[tauri::command]
async fn run_skill_self_test(
    app: tauri::AppHandle,
    operation_id: String,
) -> serde_json::Value {
    fn emit_progress(
        app: &tauri::AppHandle,
        operation_id: &str,
        phase: &str,
        percent: f64,
        message: &str,
        check: Option<&str>,
        status: Option<&str>,
        detail: Option<String>,
    ) {
        let _ = app.emit(
            "self-test-progress",
            serde_json::json!({
                "operationId": operation_id,
                "phase": phase,
                "percent": percent,
                "message": message,
                "check": check,
                "status": status,
                "detail": detail,
            }),
        );
    }

    emit_progress(
        &app,
        &operation_id,
        "preparing",
        2.0,
        "Preparando la prueba del entorno administrado…",
        None,
        None,
        None,
    );

    let event_app = app.clone();
    let event_operation_id = operation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        emit_progress(
            &event_app,
            &event_operation_id,
            "running",
            10.0,
            "Verificando el entorno y el motor de documentos…",
            None,
            None,
            Some("Comando: jintia self-test --json".to_string()),
        );
        let environment_report = course::run_self_test();
        emit_progress(
            &event_app,
            &event_operation_id,
            "report_received",
            35.0,
            "El backend recibió el diagnóstico del entorno.",
            None,
            None,
            Some(environment_report.to_string()),
        );

        let environment_ready = environment_report
            .get("ok")
            .and_then(serde_json::Value::as_bool)
            == Some(true);
        let report = if environment_ready {
            emit_progress(
                &event_app,
                &event_operation_id,
                "guide_preparing",
                45.0,
                "Creando una guía práctica para aprender a usar Jintia…",
                None,
                None,
                Some("Contenido: recorrido inicial por la plataforma.".to_string()),
            );
            let guide_report = course::generate_welcome_guide_pdf();
            emit_progress(
                &event_app,
                &event_operation_id,
                "guide_report_received",
                80.0,
                "El backend recibió el resultado de la guía de uso.",
                None,
                None,
                Some(guide_report.to_string()),
            );
            guide_report
        } else {
            environment_report
        };

        let labels = [
            ("validate", "Validación del contenido"),
            ("render", "Creación del HTML"),
            ("vivliostyle", "Renderizado PDF con Vivliostyle"),
            ("pdf", "Verificación del PDF"),
        ];
        for (index, (check, label)) in labels.iter().enumerate() {
            let Some(status) = report
                .get("checks")
                .and_then(|checks| checks.get(*check))
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            let message = if status == "passed" {
                format!("{label}: correcto.")
            } else {
                format!("{label}: {status}.")
            };
            emit_progress(
                &event_app,
                &event_operation_id,
                "check",
                84.0 + index as f64 * 4.0,
                &message,
                Some(check),
                Some(status),
                None,
            );
        }

        let passed = report.get("ok").and_then(serde_json::Value::as_bool) == Some(true);
        emit_progress(
            &event_app,
            &event_operation_id,
            if passed { "completed" } else { "error" },
            100.0,
            if passed {
                "La guía de uso de Jintia se generó correctamente."
            } else {
                "La prueba final terminó con errores."
            },
            None,
            None,
            report.get("error").map(|value| value.to_string()),
        );
        report
    })
    .await;

    result.unwrap_or_else(|error| {
        let message = format!("No se pudo completar la prueba: {error}");
        emit_progress(
            &app,
            &operation_id,
            "error",
            100.0,
            &message,
            None,
            None,
            Some(error.to_string()),
        );
        serde_json::json!({ "ok": false, "error": message })
    })
}

#[tauri::command]
async fn run_welcome_guide_generation() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(course::generate_welcome_guide_pdf)
        .await
        .unwrap_or_else(|e| serde_json::json!({ "ok": false, "error": format!("{e}") }))
}

#[tauri::command]
async fn install_profile_binaries(app: tauri::AppHandle, binary_ids: Vec<String>) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        runtimes::install_profile_binaries(&app, &binary_ids)
            .map(|installed| ActionResult::ok(format!("Binarios instalados: {}.", installed.join(", "))))
            .unwrap_or_else(ActionResult::error)
    })
    .await
    .unwrap_or_else(|e| ActionResult::error(format!("{e}")))
}

#[tauri::command]
async fn save_self_test_result(record: SelfTestRecord) -> OnboardingResult {
    tauri::async_runtime::spawn_blocking(move || onboarding::save_self_test_result(record))
        .await
        .unwrap_or_else(|e| OnboardingResult {
            success: false,
            message: format!("No se pudo guardar el resultado de la prueba: {e}"),
            status: onboarding::get_status(),
        })
}

/// Qué falta instalar realmente de las herramientas recomendadas del
/// perfil disciplinar. El onboarding lo usa para no ofrecer "instalar" lo
/// que el usuario ya tiene: muestra solo lo pendiente y, si no falta nada,
/// un estado "ya instalado" en vez del botón.
#[tauri::command]
async fn check_profile_packages(
    python_packages: Vec<String>,
    node_packages: Vec<String>,
) -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || {
        let python_missing = runtimes::missing_pip_packages(&python_packages).unwrap_or(python_packages);
        let node_missing = runtimes::missing_npm_packages(&node_packages);
        serde_json::json!({
            "pythonMissing": python_missing,
            "nodeMissing": node_missing,
        })
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({ "pythonMissing": [], "nodeMissing": [] }))
}

#[tauri::command]
async fn install_profile_packages(app: tauri::AppHandle, packages: Vec<String>) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        runtimes::emit_dependency_progress(
            &app,
            "Python",
            "installing_pip",
            None,
            &format!(
                "Instalando {} paquete(s) Python del perfil…",
                packages.len()
            ),
        );
        let result = runtimes::install_pip_packages(&packages)
            .map(|_| ActionResult::ok("Paquetes del perfil instalados correctamente."))
            .unwrap_or_else(ActionResult::error);
        runtimes::emit_dependency_progress(
            &app,
            "Python",
            if result.success { "done" } else { "error" },
            if result.success { Some(100.0) } else { None },
            &result.message,
        );
        result
    })
    .await
    .unwrap_or_else(|e| ActionResult::error(format!("{e}")))
}

#[tauri::command]
async fn install_vivliostyle_cli(app: tauri::AppHandle) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        runtimes::emit_dependency_progress(
            &app,
            "Vivliostyle CLI",
            "resolving",
            None,
            "Comprobando Node.js y npm administrados…",
        );
        runtimes::emit_dependency_progress(
            &app,
            "Vivliostyle CLI",
            "installing",
            None,
            "Instalando Vivliostyle CLI desde npm…",
        );
        let result = runtimes::install_vivliostyle()
            .map(|_| ActionResult::ok("Vivliostyle CLI instalado correctamente."))
            .unwrap_or_else(ActionResult::error);
        if result.success {
            runtimes::emit_dependency_progress(
                &app,
                "Vivliostyle CLI",
                "validating",
                None,
                "Validando el ejecutable de Vivliostyle…",
            );
        }
        runtimes::emit_dependency_progress(
            &app,
            "Vivliostyle CLI",
            if result.success { "done" } else { "error" },
            if result.success { Some(100.0) } else { None },
            &result.message,
        );
        result
    })
    .await
    .unwrap_or_else(|e| ActionResult::error(format!("{e}")))
}

#[tauri::command]
async fn install_npm_packages(app: tauri::AppHandle, packages: Vec<String>) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        runtimes::emit_dependency_progress(
            &app,
            "Paquetes Node del perfil",
            "installing",
            None,
            &format!("Instalando {} paquete(s) Node del perfil…", packages.len()),
        );
        let result = runtimes::install_npm_packages(&packages)
            .map(|_| ActionResult::ok("Paquetes npm instalados correctamente."))
            .unwrap_or_else(ActionResult::error);
        runtimes::emit_dependency_progress(
            &app,
            "Paquetes Node del perfil",
            if result.success { "done" } else { "error" },
            if result.success { Some(100.0) } else { None },
            &result.message,
        );
        result
    })
    .await
    .unwrap_or_else(|e| ActionResult::error(format!("{e}")))
}

#[tauri::command]
async fn get_capabilities_profiles() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(|| {
        let skill_path = match crate::runtimes::resolve_skill() {
            Some(p) => p,
            None => return serde_json::Value::Null,
        };
        engine::run_jintia_json::<serde_json::Value>(
            std::path::Path::new(&skill_path),
            &["capabilities", "profiles", "--json"],
        )
        .unwrap_or(serde_json::Value::Null)
    })
    .await
    .unwrap_or(serde_json::Value::Null)
}

// ── Codex app-server commands ─────────────────────────────────────────────

#[tauri::command]
fn codex_status(manager: tauri::State<codex::CodexManager>) -> serde_json::Value {
    let s = manager.status();
    serde_json::json!({
        "installed": s.installed,
        "running": s.running,
        "logged_in": s.logged_in,
        "account": s.account,
    })
}

#[tauri::command]
fn codex_start(
    app: tauri::AppHandle,
    manager: tauri::State<codex::CodexManager>,
) -> ActionResult {
    manager
        .start(app)
        .map(|_| ActionResult::ok("Codex iniciado."))
        .unwrap_or_else(ActionResult::error)
}

#[tauri::command]
fn codex_stop(manager: tauri::State<codex::CodexManager>) {
    manager.stop();
}

#[tauri::command]
fn codex_get_account(manager: tauri::State<codex::CodexManager>) -> serde_json::Value {
    match manager.get_account() {
        Ok(a) => serde_json::json!({ "ok": true, "account": a }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
fn codex_start_login(manager: tauri::State<codex::CodexManager>) -> Result<String, String> {
    manager.start_login()
}

#[tauri::command]
fn codex_start_thread(
    cwd: String,
    manager: tauri::State<codex::CodexManager>,
) -> Result<String, String> {
    manager.start_thread(&cwd)
}

#[tauri::command]
fn codex_list_models(manager: tauri::State<codex::CodexManager>) -> Result<serde_json::Value, String> {
    manager.list_models()
}

#[tauri::command]
fn codex_read_rate_limits(manager: tauri::State<codex::CodexManager>) -> Result<serde_json::Value, String> {
    manager.read_rate_limits()
}

#[tauri::command]
fn codex_submit_turn(
    thread_id: String,
    message: String,
    model: Option<String>,
    effort: Option<String>,
    manager: tauri::State<codex::CodexManager>,
) -> Result<String, String> {
    manager.submit_turn(&thread_id, &message, model.as_deref(), effort.as_deref())
}

#[tauri::command]
fn codex_interrupt_turn(
    thread_id: String,
    turn_id: String,
    manager: tauri::State<codex::CodexManager>,
) -> Result<(), String> {
    manager.interrupt_turn(&thread_id, &turn_id)
}

#[tauri::command]
fn codex_respond_approval(
    id: serde_json::Value,
    decision: String,
    manager: tauri::State<codex::CodexManager>,
) -> Result<(), String> {
    manager.respond_approval(id, &decision)
}

// ── Claude Code CLI commands ──────────────────────────────────────────────

#[tauri::command]
fn claude_status(manager: tauri::State<claude::ClaudeManager>) -> claude::ClaudeStatus {
    manager.status()
}

#[tauri::command]
fn claude_submit_turn(
    app: tauri::AppHandle,
    request: claude::ClaudeTurnRequest,
    tools: Option<Vec<String>>,
    permission_mode: Option<String>,
    manager: tauri::State<claude::ClaudeManager>,
) -> Result<(), String> {
    manager.submit_turn(app, request, tools, permission_mode)
}

#[tauri::command]
fn claude_interrupt_turn(
    request_id: String,
    manager: tauri::State<claude::ClaudeManager>,
) -> Result<(), String> {
    manager.interrupt_turn(&request_id)
}

#[tauri::command]
fn claude_auth_login(manager: tauri::State<claude::ClaudeManager>) -> Result<(), String> {
    manager.start_login()
}

// ── OpenCode runtime commands ─────────────────────────────────────────────

#[tauri::command]
async fn get_ai_preference() -> serde_json::Value {
    let pref = config::get_ai_preference();
    serde_json::json!({
        "provider_id": pref.provider_id,
        "model_id": pref.model_id,
        "model_name": pref.model_name,
    })
}

#[tauri::command]
async fn save_ai_preference(
    provider_id: String,
    model_id: String,
    model_name: String,
) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        config::save_ai_preference(provider_id, model_id, model_name)
    })
    .await
    .unwrap_or_else(|e| ActionResult::error(format!("{e}")))
}

#[tauri::command]
fn opencode_start_course(
    app: tauri::AppHandle,
    course_path: String,
    manager: tauri::State<opencode::OpenCodeManager>,
    journal: tauri::State<progress_journal::JournalWatcherManager>,
) -> Result<opencode::models::RuntimeInfo, String> {
    let result = manager.start(&course_path)?;
    // El watcher del journal de progreso es independiente del proceso
    // OpenCode en sí (ver progress_journal.rs) — arranca junto con la
    // sesión del curso para que esté listo desde el primer turno, y falla
    // en silencio si el sistema de archivos no coopera (es una mejora de
    // experiencia, no una garantía; el respaldo vía SSE sigue disponible).
    journal.start(app, &course_path);
    // La skill necesita la clave pública vigente para verificar firmas de
    // aprobación (revision-manager.js::checkApproval, JIN-APR-003 si
    // falta) — se refresca en cada arranque de sesión en vez de una sola
    // vez en la vida del curso, para que un curso creado antes de esta
    // función también quede cubierto sin pasos manuales.
    if let Err(error) = approval::ensure_public_key_in_course(&course_path) {
        eprintln!("No se pudo escribir la clave pública de aprobación en el curso: {error}");
    }
    Ok(result)
}

#[tauri::command]
fn grant_guide_approval(project_path: String, week: u32, hash: String) -> Result<(), String> {
    approval::grant_approval(&project_path, week, &hash)
}

#[tauri::command]
fn publish_guide(project_path: String, week: u32) -> Result<engine::EngineResult, String> {
    approval::publish(&project_path, week)
}

#[tauri::command]
fn opencode_stop_course(
    course_path: String,
    manager: tauri::State<opencode::OpenCodeManager>,
    journal: tauri::State<progress_journal::JournalWatcherManager>,
) {
    manager.stop(&course_path);
    journal.stop(&course_path);
}

#[tauri::command]
fn opencode_health(
    course_path: String,
    manager: tauri::State<opencode::OpenCodeManager>,
) -> opencode::models::RuntimeInfo {
    manager.health(&course_path)
}

#[tauri::command]
fn agent_restart_engine(
    course_path: String,
    manager: tauri::State<opencode::OpenCodeManager>,
) -> Result<opencode::models::RuntimeInfo, String> {
    manager.restart(&course_path)
}

#[tauri::command]
fn agent_create_session(
    course_path: String,
    week: Option<String>,
    manager: tauri::State<opencode::OpenCodeManager>,
) -> Result<opencode::models::SessionInfo, String> {
    let port = manager
        .get_port(&course_path)
        .ok_or_else(|| "OpenCode no está iniciado para este curso.".to_string())?;
    let client = opencode::client::OpenCodeClient::new(port);
    let title = match &week {
        Some(w) => format!("Jintia — Semana {w}"),
        None => "Jintia — Chat".to_string(),
    };
    let session = client.create_session(&title)?;
    Ok(opencode::models::SessionInfo {
        id: session.id,
        title: session.title.unwrap_or(title),
        course_path,
    })
}

#[tauri::command]
fn agent_send_message(
    course_path: String,
    session_id: String,
    message: String,
    model_provider: Option<String>,
    model_id: Option<String>,
    manager: tauri::State<opencode::OpenCodeManager>,
) -> Result<(), String> {
    let port = manager
        .get_port(&course_path)
        .ok_or_else(|| "OpenCode no está iniciado.".to_string())?;
    let model = match (&model_provider, &model_id) {
        (Some(p), Some(m)) => Some((p.as_str(), m.as_str())),
        _ => None,
    };
    opencode::client::OpenCodeClient::new(port).send_prompt(&session_id, &message, model)
}

#[tauri::command]
fn opencode_list_sessions(
    course_path: String,
    manager: tauri::State<opencode::OpenCodeManager>,
) -> Result<Vec<opencode::models::OcSession>, String> {
    let port = manager
        .get_port(&course_path)
        .ok_or_else(|| "OpenCode no está iniciado para este curso.".to_string())?;
    opencode::client::OpenCodeClient::new(port).list_sessions()
}

#[tauri::command]
fn opencode_list_models(
    course_path: String,
    manager: tauri::State<opencode::OpenCodeManager>,
) -> Result<Vec<opencode::models::OcModelEntry>, String> {
    let port = manager
        .get_port(&course_path)
        .ok_or_else(|| "OpenCode no está iniciado para este curso.".to_string())?;
    opencode::client::OpenCodeClient::new(port).list_models()
}

#[tauri::command]
fn agent_get_messages(
    course_path: String,
    session_id: String,
    manager: tauri::State<opencode::OpenCodeManager>,
) -> Result<Vec<opencode::models::OcMessage>, String> {
    let port = manager
        .get_port(&course_path)
        .ok_or_else(|| "OpenCode no está iniciado.".to_string())?;
    opencode::client::OpenCodeClient::new(port).get_messages(&session_id)
}

#[tauri::command]
fn agent_abort(
    course_path: String,
    session_id: String,
    manager: tauri::State<opencode::OpenCodeManager>,
) -> Result<(), String> {
    let port = manager
        .get_port(&course_path)
        .ok_or_else(|| "OpenCode no está iniciado.".to_string())?;
    opencode::client::OpenCodeClient::new(port).abort_session(&session_id)
}

#[tauri::command]
fn opencode_rename_session(
    course_path: String,
    session_id: String,
    title: String,
    manager: tauri::State<opencode::OpenCodeManager>,
) -> Result<(), String> {
    let port = manager
        .get_port(&course_path)
        .ok_or_else(|| "OpenCode no está iniciado.".to_string())?;
    opencode::client::OpenCodeClient::new(port).rename_session(&session_id, &title)
}

#[tauri::command]
fn opencode_delete_session(
    course_path: String,
    session_id: String,
    manager: tauri::State<opencode::OpenCodeManager>,
) -> Result<(), String> {
    let port = manager
        .get_port(&course_path)
        .ok_or_else(|| "OpenCode no está iniciado.".to_string())?;
    opencode::client::OpenCodeClient::new(port).delete_session(&session_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(opencode::OpenCodeManager::new())
        .manage(progress_journal::JournalWatcherManager::new())
        .manage(codex::CodexManager::new())
        .manage(claude::ClaudeManager::new())
        .invoke_handler(tauri::generate_handler![
            open_web_source,
            check_dependencies,
            download_node_runtime,
            get_node_runtime_status,
            download_python_runtime,
            get_python_runtime_status,
            download_skill_runtime,
            install_notebooklm_mcp_runtime,
            get_skill_runtime_status,
            get_visual_install_profiles,
            install_dependency,
            get_onboarding_status,
            advance_onboarding,
            go_to_onboarding_step,
            complete_onboarding,
            reset_onboarding,
            get_skill_path,
            install_skill,
            install_openai_plugin,
            configure_mcp,
            configure_codex_mcp,
            apply_institution_config,
            extract_site_palette,
            save_notebooks_config,
            get_setup_status,
            check_notebooklm_auth,
            run_notebooklm_auth,
            start_notebooklm_auth,
            cancel_notebooklm_auth,
            list_notebooks_mcp,
            list_account_notebooks_mcp,
            get_default_course_root,
            get_course_state,
            check_week_guide_exists,
            detect_harnesses,
            manage_harnesses,
            list_generated_pdfs,
            open_generated_pdf,
            reveal_generated_pdf,
            create_course_structure,
            save_course_settings,
            generate_syllabus,
            list_templates,
            get_active_template,
            set_active_template,
            run_skill_tool,
            get_capabilities_profiles,
            check_profile_packages,
            install_profile_packages,
            install_vivliostyle_cli,
            install_npm_packages,
            run_skill_self_test,
            run_welcome_guide_generation,
            install_profile_binaries,
            save_self_test_result,
            check_migration_needed,
            run_migration,
            opencode_start_course,
            opencode_stop_course,
            grant_guide_approval,
            publish_guide,
            opencode_health,
            agent_restart_engine,
            check_skill_update_status,
            agent_create_session,
            agent_send_message,
            agent_get_messages,
            agent_abort,
            opencode_list_models,
            opencode_list_sessions,
            opencode_rename_session,
            opencode_delete_session,
            get_ai_preference,
            save_ai_preference,
            codex_status,
            codex_start,
            codex_stop,
            codex_get_account,
            codex_start_login,
            codex_start_thread,
            codex_list_models,
            codex_read_rate_limits,
            codex_submit_turn,
            codex_interrupt_turn,
            codex_respond_approval,
            claude_status,
            claude_submit_turn,
            claude_interrupt_turn,
            claude_auth_login,
        ])
        .setup(|_app| {
            paths::migrate_app_dir_if_needed();
            paths::migrate_runtimes_dir_if_needed();
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(mgr) = window.try_state::<opencode::OpenCodeManager>() {
                    mgr.stop_all();
                }
                if let Some(mgr) = window.try_state::<claude::ClaudeManager>() {
                    mgr.stop_all();
                }
                if let Some(mgr) = window.try_state::<codex::CodexManager>() {
                    mgr.stop_all();
                }
                if let Some(mgr) = window.try_state::<progress_journal::JournalWatcherManager>() {
                    mgr.stop_all();
                }
                // NotebookLM MCP vive en un `static` (mcp::client::CONNECTION),
                // no en state gestionado por Tauri: sin esta llamada explícita
                // su proceso sobrevive al cierre de Jintia (ver shutdown() para
                // el porqué exacto — Rust no destruye statics al salir).
                mcp::shutdown();
            }
        })
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}
