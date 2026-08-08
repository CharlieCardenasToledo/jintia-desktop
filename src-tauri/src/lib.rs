mod config;
mod course;
mod course_state;
mod engine;
mod harnesses;
mod mcp;
mod models;
mod onboarding;
mod palette;
mod paths;
mod payload;
mod pdfs;
mod release;
mod runtimes;
mod toolchain;

use models::{
    ActionResult, DependencyStatus, GeneratedPdf, InstitutionConfig, MigrationStatus, NotebookEntry,
    NotebookLmAuthStatus, PdfProjectRoot, SetupStatus, TemplateMeta, WeekData,
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
async fn check_dependencies() -> Vec<DependencyStatus> {
    tauri::async_runtime::spawn_blocking(course::check_dependencies)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn download_node_runtime(app: tauri::AppHandle) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        runtimes::download_portable_node(&app)
            .map(|_| ActionResult::ok("Node.js portable instalado correctamente."))
            .unwrap_or_else(|e| ActionResult::error(e))
    }).await
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
    }).await
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
    }).await
    .unwrap_or_else(|e| ActionResult::error(format!("{e}")))
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
    serde_json::from_str(include_str!(concat!(
        env!("OUT_DIR"),
        "/jintia-skill/config/visual-install-profiles.json"
    )))
    .unwrap_or_else(|_| serde_json::json!({ "version": 1, "profiles": [] }))
}

#[tauri::command]
async fn install_dependency(name: String, confirmed: Option<bool>) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        course::install_dependency(name, confirmed.unwrap_or(false))
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
    payload::installed_skill_path()
}

#[tauri::command]
async fn install_skill() -> ActionResult {
    payload::install_local_skill()
}

#[tauri::command]
async fn export_skill_zip(destination_dir: String) -> ActionResult {
    payload::export_skill_zip(destination_dir)
}

#[tauri::command]
async fn install_openai_plugin() -> ActionResult {
    payload::install_openai_plugin()
}

#[tauri::command]
async fn export_openai_plugin_zip(destination_dir: String) -> ActionResult {
    payload::export_openai_plugin_zip(destination_dir)
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
    config::setup_status()
}

#[tauri::command]
async fn check_notebooklm_auth() -> NotebookLmAuthStatus {
    tauri::async_runtime::spawn_blocking(mcp::check_auth_fresh)
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
        0, // weeks no es usado
        true, // initialize_readme
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
    tauri::async_runtime::spawn_blocking(move || course_state::week_guide_exists(project_path, week))
        .await
        .unwrap_or(false)
}

#[tauri::command]
async fn detect_harnesses(project_path: String, explicit_providers: Option<Vec<String>>) -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || harnesses::detect(project_path, explicit_providers))
        .await
        .unwrap_or_else(|error| serde_json::json!({ "success": false, "message": format!("No se pudieron detectar los harnesses: {error}") }))
}

#[tauri::command]
async fn manage_harnesses(operation: String, project_path: String, providers: Option<Vec<String>>, scope: String, confirm: bool) -> models::ToolchainReport {
    tauri::async_runtime::spawn_blocking(move || toolchain::manage_harness(operation, project_path, providers.unwrap_or_default(), scope, confirm))
        .await
        .unwrap_or_else(|error| models::ToolchainReport::error(format!("No se pudo gestionar el harness: {error}")))
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
        .unwrap_or_else(|error| models::ToolchainReport::error(format!("No se pudo ejecutar la toolchain: {error}")))
}

#[tauri::command]
async fn check_migration_needed(project_path: String) -> models::MigrationStatus {
    tauri::async_runtime::spawn_blocking(move || course::check_migration_needed(project_path))
        .await
        .unwrap_or_else(|_| models::MigrationStatus {
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
        .unwrap_or_else(|error| ActionResult::error(format!("No se pudo ejecutar la migración: {error}")))
}

#[tauri::command]
async fn run_skill_self_test() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(course::run_self_test)
        .await
        .unwrap_or_else(|e| serde_json::json!({ "ok": false, "error": format!("{e}") }))
}

#[tauri::command]
async fn install_profile_packages(packages: Vec<String>) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        runtimes::install_pip_packages(&packages)
            .map(|_| ActionResult::ok("Paquetes del perfil instalados correctamente."))
            .unwrap_or_else(|e| ActionResult::error(e))
    })
    .await
    .unwrap_or_else(|e| ActionResult::error(format!("{e}")))
}

#[tauri::command]
async fn install_vivliostyle_cli() -> ActionResult {
    tauri::async_runtime::spawn_blocking(|| {
        runtimes::install_vivliostyle()
            .map(|_| ActionResult::ok("Vivliostyle CLI instalado correctamente."))
            .unwrap_or_else(|e| ActionResult::error(e))
    })
    .await
    .unwrap_or_else(|e| ActionResult::error(format!("{e}")))
}

#[tauri::command]
async fn install_npm_packages(packages: Vec<String>) -> ActionResult {
    tauri::async_runtime::spawn_blocking(move || {
        runtimes::install_npm_packages(&packages)
            .map(|_| ActionResult::ok("Paquetes npm instalados correctamente."))
            .unwrap_or_else(|e| ActionResult::error(e))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            check_dependencies,
            download_node_runtime,
            get_node_runtime_status,
            download_python_runtime,
            get_python_runtime_status,
            download_skill_runtime,
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
            export_skill_zip,
            install_openai_plugin,
            export_openai_plugin_zip,
            configure_mcp,
            configure_codex_mcp,
            apply_institution_config,
            extract_site_palette,
            save_notebooks_config,
            get_setup_status,
            check_notebooklm_auth,
            run_notebooklm_auth,
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
            install_profile_packages,
            install_vivliostyle_cli,
            install_npm_packages,
            run_skill_self_test,
            check_migration_needed,
            run_migration,
        ])
        .setup(|_app| {
            paths::migrate_app_dir_if_needed();
            paths::migrate_runtimes_dir_if_needed();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}
