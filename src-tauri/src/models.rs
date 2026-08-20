use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ActionResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainReport {
    pub success: bool,
    pub message: String,
    pub operation: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<serde_json::Value>,
}

impl ToolchainReport {
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            success: false,
            message: message.into(),
            operation: String::new(),
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            report: None,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PdfProjectRoot {
    pub course_code: String,
    pub course_name: String,
    pub project_path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedPdf {
    pub course_code: String,
    pub course_name: String,
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
}

impl ActionResult {
    pub fn ok(message: impl Into<String>) -> Self {
        Self {
            success: true,
            message: message.into(),
            path: None,
            backup_path: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            success: false,
            message: message.into(),
            path: None,
            backup_path: None,
        }
    }

    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub fn with_backup(mut self, path: impl Into<String>) -> Self {
        self.backup_path = Some(path.into());
        self
    }
}

/// Contrato explícito de una capacidad de Jintia.
///
/// Los campos `name`, `installed`, `required`, `note` y `command` se conservan
/// durante la migración para clientes anteriores. El frontend nuevo toma sus
/// decisiones de `status` y `blocking_scope`, no de `required`.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityStatus {
    pub id: String,
    pub label: String,
    pub category: String,
    pub status: String,
    pub blocking_scope: String,
    pub installable: bool,
    pub requires_consent: bool,
    pub operation: Option<String>,
    pub reason: String,
    pub technical_detail: String,
    // Compatibilidad temporal con el contrato DependencyStatus v1.
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub required: bool,
    pub note: String,
    pub command: String,
}

pub type DependencyStatus = CapabilityStatus;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LongOperationStatus {
    pub operation_id: String,
    pub state: String,
    pub phase: String,
    pub message: String,
    pub percent: Option<f64>,
    pub cancellable: bool,
    pub browser_open: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct InstitutionConfig {
    pub author: String,
    pub degree: String,
    pub career: String,
    pub faculty: String,
    pub institution: String,
    #[serde(default)]
    pub website: String,
    pub color_r: u8,
    pub color_g: u8,
    pub color_b: u8,
    #[serde(default)]
    pub ecosystem: String,
    #[serde(default)]
    pub discipline: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct PaletteColor {
    pub color: String,
    pub occurrences: usize,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct SitePalette {
    pub site_name: Option<String>,
    pub colors: Vec<PaletteColor>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WeekData {
    pub number: u32,
    #[serde(default)]
    pub title: String,
    pub unit: String,
    pub topics: String,
    pub outcomes: String,
    pub bibliography: String,
    pub graded_activity: Option<String>,
    #[serde(default)]
    pub autonomous_hours: u32,
    #[serde(default)]
    pub teaching_hours: u32,
    #[serde(default)]
    pub practice_hours: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NotebookEntry {
    pub course_code: String,
    pub course_name: String,
    pub root_path: String,
    pub notebook_id: String,
    pub notebook_url: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct TemplateColors {
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub accent: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct TemplateOverrides {
    #[serde(default)]
    pub colors: Option<TemplateColors>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TemplateMeta {
    pub id: String,
    // Los temas base (jintia-clasico) declaran "name"; los que extienden otro
    // tema (jintia-cuaderno, jintia-tecnico) declaran "displayName". Sin el
    // alias, esos dos se descartaban en list_templates() por falta de "name".
    #[serde(alias = "displayName")]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub featured: bool,
    #[serde(default)]
    pub version: String,
    // Paleta propia del tema (ej. jintia-tecnico define brand/surface/accent
    // azul-grisáceo independiente del color institucional). Cuando existe,
    // tiene prioridad sobre el color primario configurado por el docente.
    #[serde(default)]
    pub overrides: Option<TemplateOverrides>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NotebookLmAuthStatus {
    pub authenticated: bool,
    pub message: String,
}

/// Entrada de la biblioteca de gemini-notebook-mcp (ver `NotebookEntry` en
/// https://github.com/CharlieCardenasToledo/gemini-notebook-mcp/blob/main/src/library/types.ts).
/// Solo se exponen los campos que la UI necesita para el selector.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NotebookLmEntry {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct SetupStatus {
    pub skill_installed: bool,
    pub skill_current: bool,
    pub skill_version: String,
    pub available_skill_version: String,
    pub claude_skill_current: bool,
    pub codex_skill_current: bool,
    pub opencode_skill_current: bool,
    pub opencode_cli_installed: bool,
    pub claude_skill_path: String,
    pub codex_skill_path: String,
    pub opencode_skill_path: String,
    pub openai_plugin_installed: bool,
    pub openai_plugin_current: bool,
    pub openai_plugin_path: String,
    /// Estado granular del plugin OpenAI tal como lo reporta `jintia plugin status --json`:
    /// "" (no disponible) | "not-installed" | "installed" | "outdated" | "incomplete" | "foreign"
    pub openai_plugin_state: String,
    pub mcp_configured: bool,
    pub mcp_desktop_configured: bool,
    pub mcp_claude_code_configured: bool,
    pub mcp_codex_configured: bool,
    pub institution_configured: bool,
    pub skill_path: String,
    pub mcp_config_path: String,
}

/// Huella de readiness persistida tras un `jintia self-test` exitoso.
///
/// `complete()` valida que los campos críticos del registro coincidan con
/// el estado actual del sistema antes de marcar el onboarding como listo.
/// Los campos marcados con `#[serde(default)]` pueden estar ausentes en
/// registros anteriores; se tratan como vacíos y no bloquean la validación.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SelfTestRecord {
    /// Versión de la skill administrada cuando se ejecutó la prueba.
    pub skill_version: String,
    /// Versión de Desktop cuando se ejecutó la prueba.
    #[serde(default)]
    pub desktop_version: String,
    /// Versión del paquete MCP cuando se ejecutó la prueba.
    #[serde(default)]
    pub mcp_version: String,
    /// Versión de Node.js activa durante la prueba (informativo).
    #[serde(default)]
    pub node_version: String,
    /// Versión de Vivliostyle activa durante la prueba (informativo).
    #[serde(default)]
    pub vivliostyle_version: String,
    /// Perfil/disciplina seleccionada al momento de la prueba.
    #[serde(default)]
    pub profile_id: String,
    /// Compatibilidad histórica. Desde onboarding v4 siempre contiene "both".
    #[serde(default)]
    pub selected_target: String,
    /// `true` solo cuando todos los checks de `jintia self-test` pasaron.
    pub passed: bool,
    /// Epoch Unix (segundos) del momento en que se guardó este registro.
    pub timestamp: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingStatus {
    pub version: u32,
    pub completed: bool,
    pub current_step: u8,
    pub max_completed_step: u8,
    pub selected_target: String,
    pub last_updated: u64,
    /// Explica por qué el sistema devolvió al usuario a un paso anterior
    /// (p. ej. una dependencia que antes estaba lista dejó de estarlo).
    /// Solo se llena en el momento en que se detecta la regresión.
    #[serde(default)]
    pub regression_reason: Option<String>,
    /// Resultado del último `jintia self-test` guardado desde el frontend.
    /// `complete()` exige que este campo exista y que `passed == true`.
    #[serde(default)]
    pub last_self_test: Option<SelfTestRecord>,
}

impl Default for OnboardingStatus {
    fn default() -> Self {
        Self {
            version: 4,
            completed: false,
            current_step: 1,
            max_completed_step: 0,
            selected_target: "both".to_string(),
            last_updated: 0,
            regression_reason: None,
            last_self_test: None,
        }
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct OnboardingResult {
    pub success: bool,
    pub message: String,
    pub status: OnboardingStatus,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatus {
    pub needs_migration: bool,
    pub latex_dirs_found: usize,
    pub tex_files_found: usize,
    pub dry_run_report: Option<serde_json::Value>,
}
