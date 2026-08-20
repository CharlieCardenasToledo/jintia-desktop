use crate::config;
use crate::mcp;
use crate::models::{OnboardingResult, OnboardingStatus};
use crate::paths::{app_config_dir, atomic_write, timestamp};
use std::fs;
use std::path::PathBuf;

const ONBOARDING_VERSION: u32 = 4;
const LAST_STEP: u8 = 5;

fn status_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("onboarding.json"))
}

fn load() -> OnboardingStatus {
    status_path()
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<OnboardingStatus>(&bytes).ok())
        .map(|status| {
            let mut status = migrate_status(status);
            status.current_step = status.current_step.clamp(1, LAST_STEP);
            status.max_completed_step = status.max_completed_step.min(LAST_STEP);
            status
        })
        .unwrap_or_default()
}

fn migrate_status(mut status: OnboardingStatus) -> OnboardingStatus {
    if status.version < 2 {
        // La versión 2 separa la antigua identidad institucional (paso 5)
        // en institución (5) y perfil académico (6). Los pasos posteriores
        // se desplazan una posición sin perder el progreso ya completado.
        if status.current_step >= 6 {
            status.current_step = status.current_step.saturating_add(1);
        }
        if status.max_completed_step >= 5 {
            status.max_completed_step = status.max_completed_step.saturating_add(1);
        }
        status.version = 2;
    }
    if status.version < 3 {
        // La versión 3 colapsa los antiguos 10 pasos en 5, agrupando
        // contenido puramente educativo o formularios relacionados en una
        // sola pantalla (ver map_legacy_step / map_legacy_max_completed).
        // max_completed_step se redondea hacia abajo cuando el progreso
        // viejo quedaba a mitad de un grupo fusionado, para no marcar como
        // "completo" un paso nuevo cuyas partes no se terminaron todas.
        status.current_step = map_legacy_step(status.current_step);
        status.max_completed_step = map_legacy_max_completed(status.max_completed_step);
        status.current_step = status
            .current_step
            .min(status.max_completed_step.saturating_add(1));
        status.version = 3;
    }
    if status.version < 4 {
        // La versión 4 elimina la elección de proveedor: Jintia prepara el
        // mismo contrato administrado para todos los asistentes soportados.
        status.selected_target = "both".to_string();
        status.version = ONBOARDING_VERSION;
    }
    status
}

/// Paso viejo (esquema de 10, v2) -> paso nuevo (esquema de 5, v3).
/// 1-3 → 1 (bienvenida) · 4 → 2 (herramientas) · 5-7 → 3 (institución,
/// perfil y plantilla) · 8-9 → 4 (NotebookLM y destino) · 10 → 5 (prueba).
fn map_legacy_step(old: u8) -> u8 {
    match old {
        1..=3 => 1,
        4 => 2,
        5..=7 => 3,
        8..=9 => 4,
        _ => 5,
    }
}

/// Igual que `map_legacy_step`, pero para max_completed_step: solo cuenta un
/// paso nuevo como completado si el viejo llegó hasta el ÚLTIMO paso de ese
/// grupo (ej. completar institución pero no plantilla no cuenta el paso 3
/// nuevo como terminado).
fn map_legacy_max_completed(old_max: u8) -> u8 {
    if old_max >= 10 {
        5
    } else if old_max >= 9 {
        4
    } else if old_max >= 7 {
        3
    } else if old_max >= 4 {
        2
    } else if old_max >= 3 {
        1
    } else {
        0
    }
}

fn save(status: &mut OnboardingStatus) -> Result<(), String> {
    status.last_updated = timestamp();
    let bytes = serde_json::to_vec_pretty(status).map_err(|error| error.to_string())?;
    atomic_write(&status_path()?, &bytes)
}

fn validate_environment(dependencies: &[crate::models::DependencyStatus]) -> Result<(), String> {
    let missing = dependencies.iter().find(|dependency| {
        dependency.blocking_scope == "onboarding" && dependency.status != "ready"
    });
    let Some(dependency) = missing else {
        return Ok(());
    };
    if dependency.id == "node" {
        return Err(
            "Falta instalar un componente necesario. Instálalo y pulsa “Verificar de nuevo”."
                .to_string(),
        );
    }
    if dependency.id == "python" {
        return Err("Instala Python para poder continuar.".to_string());
    }
    if dependency.id == "vivliostyle" {
        return Err(
            "Vivliostyle CLI no está disponible. Se instalará automáticamente con el Node portable."
                .to_string(),
        );
    }
    Err(format!(
        "Falta preparar {}. {}",
        dependency.label, dependency.reason
    ))
}

fn target_ready(target: &str) -> bool {
    // Desde onboarding v4 solo existe la preparación conjunta. Mantener el
    // valor explícito evita que destinos legacy o desconocidos se consideren
    // listos por accidente.
    if target != "both" {
        return false;
    }
    let setup = config::setup_status();
    setup.skill_current
        && setup.claude_skill_current
        && setup.codex_skill_current
        && setup.opencode_skill_current
        && setup.opencode_cli_installed
        && setup.mcp_claude_code_configured
        && setup.mcp_codex_configured
        && setup.openai_plugin_current
}

fn first_invalid_step(
    status: &OnboardingStatus,
    refresh_environment: bool,
) -> Option<(u8, &'static str)> {
    let dependencies = if refresh_environment {
        crate::capabilities::check_dependencies()
    } else {
        crate::capabilities::check_dependencies_cached()
    };
    if validate_environment(&dependencies).is_err() {
        // El motivo exacto se muestra en la tarjeta del paso 2;
        // este mensaje solo explica por qué se regresó a ese paso.
        return Some((
            2,
            "falta una herramienta necesaria para que la app funcione",
        ));
    }
    if !config::institution_is_configured() {
        return Some((
            3,
            "los datos de tu institución o perfil académico ya no están guardados",
        ));
    }
    if !config::theme_exists(&config::get_active_template()) {
        return Some((3, "el tema que tenías elegido ya no está disponible"));
    }
    if !target_ready(&status.selected_target) {
        return Some((
            4,
            "una o más integraciones dejaron de estar completamente configuradas",
        ));
    }
    None
}

pub fn get_status() -> OnboardingStatus {
    let mut status = load();
    if status.completed {
        if let Some((step, reason)) = first_invalid_step(&status, true) {
            status.completed = false;
            status.current_step = step;
            status.max_completed_step = step.saturating_sub(1);
            status.regression_reason = Some(format!(
                "Necesitamos revisar este punto antes de continuar: {reason}."
            ));
            let _ = save(&mut status);
        }
    }
    status
}

fn result(success: bool, message: impl Into<String>, status: OnboardingStatus) -> OnboardingResult {
    OnboardingResult {
        success,
        message: message.into(),
        status,
    }
}

pub fn go_to_step(step: u8) -> OnboardingResult {
    let mut status = get_status();
    let highest_open = (status.max_completed_step + 1).min(LAST_STEP);
    if step < 1 || step > highest_open {
        return result(
            false,
            "Completa los pasos anteriores antes de continuar.",
            status,
        );
    }
    status.current_step = step;
    if let Err(error) = save(&mut status) {
        return result(false, error, status);
    }
    result(true, "Paso actualizado.", status)
}

pub fn advance(step: u8, _selected_target: Option<String>) -> OnboardingResult {
    let mut status = get_status();
    if step != status.current_step {
        return result(
            false,
            "El estado del onboarding cambió. Vuelve a verificar el paso.",
            status,
        );
    }

    let validation = match step {
        1 => Ok(()),
        2 => validate_environment(&crate::capabilities::check_dependencies_cached()),
        3 => {
            if !config::institution_is_configured() {
                Err(
                    "Completa los datos de tu institución y tu perfil antes de continuar."
                        .to_string(),
                )
            } else if !config::theme_exists(&config::get_active_template()) {
                Err("Elige un tema para continuar.".to_string())
            } else {
                Ok(())
            }
        }
        4 => {
            let auth = mcp::check_auth();
            if !auth.authenticated {
                Err(auth.message)
            } else {
                if !target_ready("both") {
                    Err("OpenCode, Claude Code y ChatGPT (Codex) todavía no están completamente preparados.".to_string())
                } else {
                    status.selected_target = "both".to_string();
                    Ok(())
                }
            }
        }
        5 => Err("Usa el botón “Finalizar configuración”.".to_string()),
        _ => Ok(()),
    };

    if let Err(message) = validation {
        return result(false, message, status);
    }
    status.max_completed_step = status.max_completed_step.max(step);
    status.current_step = (step + 1).min(LAST_STEP);
    if let Err(error) = save(&mut status) {
        return result(false, error, status);
    }
    result(true, "Paso completado.", status)
}

pub fn save_self_test_result(mut record: crate::models::SelfTestRecord) -> OnboardingResult {
    let mut status = get_status();
    // Campos auto-rellenados desde el contrato y el estado actual del sistema.
    if let Ok(contract) = crate::release::managed_release_contract() {
        if record.skill_version.is_empty() {
            record.skill_version = contract.mcp.jintia_version.clone();
        }
        if record.mcp_version.is_empty() {
            record.mcp_version = contract.mcp.version.clone();
        }
    }
    if record.desktop_version.is_empty() {
        record.desktop_version = env!("CARGO_PKG_VERSION").to_string();
    }
    if record.selected_target.is_empty() {
        record.selected_target = status.selected_target.clone();
    }
    if record.profile_id.is_empty() {
        record.profile_id = crate::config::get_discipline();
    }
    status.last_self_test = Some(record);
    if let Err(error) = save(&mut status) {
        return result(false, error, status);
    }
    result(true, "Resultado de la prueba final guardado.", status)
}

pub fn complete() -> OnboardingResult {
    let mut status = get_status();
    if status.current_step != LAST_STEP {
        return result(
            false,
            "Completa todos los pasos antes de finalizar.",
            status,
        );
    }
    if let Some((step, reason)) = first_invalid_step(&status, false) {
        status.current_step = step;
        let _ = save(&mut status);
        return result(
            false,
            format!("Necesitamos revisar este punto antes de continuar: {reason}."),
            status,
        );
    }
    let auth = mcp::check_auth();
    if !auth.authenticated {
        status.current_step = 4;
        let _ = save(&mut status);
        return result(false, auth.message, status);
    }

    // Exigir que la prueba final haya pasado y sea vigente para la versión
    // de skill actualmente instalada.
    let self_test = match &status.last_self_test {
        Some(record) => record.clone(),
        None => {
            return result(
                false,
                "Ejecuta la prueba final antes de completar la instalación.",
                status,
            )
        }
    };
    if !self_test.passed {
        return result(
            false,
            "La prueba final no fue exitosa. Revisa las herramientas instaladas e inténtalo de nuevo.",
            status,
        );
    }
    // Validar huella de readiness — todos los campos críticos deben coincidir
    // con el estado actual del sistema.
    if let Ok(contract) = crate::release::managed_release_contract() {
        if !contract.mcp.jintia_version.is_empty()
            && !self_test.skill_version.is_empty()
            && self_test.skill_version != contract.mcp.jintia_version
        {
            return result(
                false,
                "La versión de Jintia cambió desde la última prueba. Vuelve a ejecutar la prueba final.",
                status,
            );
        }
        if !contract.mcp.version.is_empty()
            && !self_test.mcp_version.is_empty()
            && self_test.mcp_version != contract.mcp.version
        {
            return result(
                false,
                "El MCP de NotebookLM se actualizó desde la última prueba. Vuelve a ejecutar la prueba final.",
                status,
            );
        }
    }
    let current_desktop = env!("CARGO_PKG_VERSION");
    if !self_test.desktop_version.is_empty() && self_test.desktop_version != current_desktop {
        return result(
            false,
            "Desktop se actualizó desde la última prueba. Vuelve a ejecutar la prueba final.",
            status,
        );
    }
    if !self_test.selected_target.is_empty()
        && !status.selected_target.is_empty()
        && self_test.selected_target != status.selected_target
    {
        return result(
            false,
            "El destino de integración cambió desde la última prueba. Vuelve a ejecutar la prueba final.",
            status,
        );
    }
    let current_profile = crate::config::get_discipline();
    if !self_test.profile_id.is_empty()
        && !current_profile.is_empty()
        && self_test.profile_id != current_profile
    {
        return result(
            false,
            "El perfil disciplinar cambió desde la última prueba. Vuelve a ejecutar la prueba final.",
            status,
        );
    }

    status.completed = true;
    status.max_completed_step = LAST_STEP;
    if let Err(error) = save(&mut status) {
        return result(false, error, status);
    }
    result(true, "Onboarding completado.", status)
}

pub fn reset() -> OnboardingResult {
    let mut status = OnboardingStatus::default();
    if let Err(error) = save(&mut status) {
        return result(false, error, status);
    }
    result(true, "Onboarding reiniciado.", status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_names_are_explicit() {
        assert!(!target_ready("unknown"));
    }

    fn dependency(name: &str, installed: bool) -> crate::models::DependencyStatus {
        let required = matches!(
            name,
            "Node.js" | "Python" | "Jintia Skill" | "Vivliostyle CLI"
        );
        let id = match name {
            "Node.js" => "node",
            "Python" => "python",
            "Jintia Skill" => "jintia-skill",
            "Vivliostyle CLI" => "vivliostyle",
            _ => "test",
        };
        crate::models::DependencyStatus {
            id: id.to_string(),
            label: name.to_string(),
            category: if required { "core" } else { "optional" }.to_string(),
            status: if installed { "ready" } else { "missing" }.to_string(),
            blocking_scope: if required { "onboarding" } else { "none" }.to_string(),
            requires_consent: true,
            operation: Some("test".to_string()),
            reason: String::new(),
            technical_detail: String::new(),
            name: name.to_string(),
            installed,
            version: None,
            required,
            installable: true,
            note: String::new(),
            command: String::new(),
        }
    }

    #[test]
    fn environment_validation_reports_node_before_the_rest() {
        let dependencies = vec![
            dependency("Node.js", false),
            dependency("Python", false),
            dependency("Vivliostyle CLI", false),
        ];
        assert!(validate_environment(&dependencies)
            .unwrap_err()
            .starts_with("Falta instalar"));
    }

    #[test]
    fn environment_validation_requires_python_and_vivliostyle_explicitly() {
        let missing_python = vec![
            dependency("Node.js", true),
            dependency("Python", false),
            dependency("Vivliostyle CLI", true),
        ];
        assert_eq!(
            validate_environment(&missing_python).unwrap_err(),
            "Instala Python para poder continuar."
        );

        let missing_vivliostyle = vec![
            dependency("Node.js", true),
            dependency("Python", true),
            dependency("Vivliostyle CLI", false),
        ];
        assert!(validate_environment(&missing_vivliostyle)
            .unwrap_err()
            .contains("Vivliostyle CLI"));

        let ready = vec![
            dependency("Node.js", true),
            dependency("Python", true),
            dependency("Vivliostyle CLI", true),
        ];
        assert!(validate_environment(&ready).is_ok());
    }

    #[test]
    fn migrates_legacy_v1_progress_all_the_way_to_five_steps() {
        let legacy = OnboardingStatus {
            version: 1,
            current_step: 8,
            max_completed_step: 7,
            ..OnboardingStatus::default()
        };
        let migrated = migrate_status(legacy);
        // v1→v2 (paso 8→9, max 7→8) y luego v2→v3 (9→4, 8→3) encadenadas.
        assert_eq!(migrated.version, 4);
        assert_eq!(migrated.current_step, 4);
        assert_eq!(migrated.max_completed_step, 3);
    }

    #[test]
    fn collapses_ten_steps_into_five_rounding_down_mid_group_progress() {
        // Completó institución (paso viejo 5) pero no llegó a plantilla (7):
        // el paso nuevo 3 (institución+perfil+plantilla) no debe contar como
        // terminado todavía, para no saltarse la validación de plantilla.
        let mid_group = OnboardingStatus {
            version: 2,
            current_step: 6,
            max_completed_step: 5,
            ..OnboardingStatus::default()
        };
        let migrated = migrate_status(mid_group);
        assert_eq!(migrated.version, 4);
        assert_eq!(migrated.max_completed_step, 2);
        assert_eq!(migrated.current_step, 3);

        // Completó institución+perfil+plantilla (paso viejo 7 alcanzado): el
        // paso nuevo 3 sí cuenta como terminado y se avanza al 4.
        let full_group = OnboardingStatus {
            version: 2,
            current_step: 8,
            max_completed_step: 7,
            ..OnboardingStatus::default()
        };
        let migrated_full = migrate_status(full_group);
        assert_eq!(migrated_full.max_completed_step, 3);
        assert_eq!(migrated_full.current_step, 4);
    }
}
