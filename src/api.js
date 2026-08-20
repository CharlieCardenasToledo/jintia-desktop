/**
 * api.js — Capa de abstracción sobre Tauri (Dependency Inversion Principle)
 * Las páginas dependen de este módulo, nunca de `invoke` directamente.
 * Esto permite sustituir la implementación (mock, test, etc.) sin tocar las páginas.
 */
import { invoke } from "@tauri-apps/api/core";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ALLOWED_AI_URLS, ALLOWED_EXTERNAL_URLS, APP_META } from "./appMeta.js";

export async function getRuntimeAppMeta() {
  try {
    const [name, version, tauriVersion] = await Promise.all([
      getName(),
      getVersion(),
      getTauriVersion(),
    ]);
    return { name, version, tauriVersion };
  } catch {
    return { name: APP_META.desktopName, version: "1.0.0", tauriVersion: "2" };
  }
}

export async function openExternal(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Enlace externo no válido");
  }
  const isAllowedAiUrl = ALLOWED_AI_URLS.schemes.includes(parsed.protocol);
  if (!ALLOWED_EXTERNAL_URLS.includes(url) && !isAllowedAiUrl) {
    throw new Error("Enlace externo no permitido");
  }
  return openUrl(url);
}

/**
 * Abre una cita o fuente web generada dentro de Ask Jintia sin permitir que
 * el WebView navegue fuera de la aplicación. A diferencia de `openExternal`,
 * aquí no existe una lista cerrada de destinos porque las fuentes académicas
 * pueden pertenecer a cualquier dominio; el límite de confianza es el
 * protocolo web y la apertura explícita por parte del usuario.
 */
export async function openWebSource(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Enlace de fuente no válido");
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error("Solo se permiten fuentes web HTTP o HTTPS");
  }
  return invoke("open_web_source", { url: parsed.href });
}

// ── Dependencias del sistema ─────────────────────────────────────────────
export async function checkDependencies() {
  return invoke("check_dependencies");
}

export async function installNotebookLmMcpRuntime() {
  return invoke("install_notebooklm_mcp_runtime");
}

export async function getVisualInstallProfiles() {
  return invoke("get_visual_install_profiles");
}

export async function getOnboardingStatus() {
  return invoke("get_onboarding_status");
}

export async function advanceOnboarding(step, selectedTarget) {
  return invoke("advance_onboarding", { step, selectedTarget });
}

export async function goToOnboardingStep(step) {
  return invoke("go_to_onboarding_step", { step });
}

export async function completeOnboarding() {
  return invoke("complete_onboarding");
}

export async function installDependency(name, confirmed = false) {
  return invoke("install_dependency", { name, confirmed });
}

export async function downloadNodeRuntime(app) {
  return invoke("download_node_runtime");
}

export async function downloadPythonRuntime(app) {
  return invoke("download_python_runtime");
}

export async function downloadSkillRuntime(app) {
  return invoke("download_skill_runtime");
}

export async function resetOnboarding() {
  return invoke("reset_onboarding");
}

// ── Skill y MCP ──────────────────────────────────────────────────────────
export async function getSkillPath() {
  return invoke("get_skill_path");
}

export async function installSkill() {
  return invoke("install_skill");
}

export async function installOpenAIPlugin() {
  return invoke("install_openai_plugin");
}

export async function configureMcp(target) {
  return invoke("configure_mcp", { target });
}

export async function configureCodexMcp() {
  return invoke("configure_codex_mcp");
}

export async function getSetupStatus() {
  return invoke("get_setup_status");
}

export async function applyInstitutionConfig(config) {
  return invoke("apply_institution_config", { config });
}

export async function extractSitePalette(url) {
  return invoke("extract_site_palette", { url });
}

// ── NotebookLM MCP ───────────────────────────────────────────────────────
export async function checkNotebookLMAuth() {
  return invoke("check_notebooklm_auth");
}

export async function runNotebookLMAuth() {
  return invoke("run_notebooklm_auth");
}

export async function startNotebookLMAuth(operationId) {
  return invoke("start_notebooklm_auth", { operationId });
}

export async function cancelNotebookLMAuth(operationId) {
  return invoke("cancel_notebooklm_auth", { operationId });
}

export async function saveNotebooksConfig(entries) {
  return invoke("save_notebooks_config", { entries });
}

export async function listNotebooksMcp() {
  return invoke("list_notebooks_mcp");
}

export async function listAccountNotebooksMcp() {
  return invoke("list_account_notebooks_mcp");
}

// ── Estructura de carpetas y sílabo ──────────────────────────────────────
export async function createCourseStructure({ rootPath, courseCode, courseName, weeks, initializeReadme = true, includeGradedActivities = false }) {
  return invoke("create_course_structure", { rootPath, courseCode, courseName, weeks, initializeReadme, includeGradedActivities });
}

export async function saveCourseSettings({ coursePath, courseCode, courseName, includeGradedActivities = false }) {
  return invoke("save_course_settings", { coursePath, courseCode, courseName, includeGradedActivities });
}

export async function getDefaultCourseRoot() {
  return invoke("get_default_course_root");
}

export async function getCourseState(projectPath) {
  return invoke("get_course_state", { projectPath });
}

export async function checkWeekGuideExists(projectPath, week) {
  return invoke("check_week_guide_exists", { projectPath, week });
}

export async function detectHarnesses(projectPath, explicitProviders = null) {
  return invoke("detect_harnesses", { projectPath, explicitProviders });
}

export async function manageHarnesses(operation, projectPath, providers, scope = "project", confirm = false) {
  return invoke("manage_harnesses", { operation, projectPath, providers, scope, confirm });
}

// ── Biblioteca de PDFs generados ─────────────────────────────────────────
export async function listGeneratedPdfs(projects) {
  return invoke("list_generated_pdfs", { projects });
}

export async function openGeneratedPdf(path, projects) {
  return invoke("open_generated_pdf", { path, projects });
}

export async function revealGeneratedPdf(path, projects) {
  return invoke("reveal_generated_pdf", { path, projects });
}

export async function generateSyllabus(payload) {
  return invoke("generate_syllabus", payload);
}

// ── Sistema de plantillas (temas HTML de la Skill) ────────────────────────
export async function listTemplates() {
  return invoke("list_templates");
}

export async function getActiveTemplate() {
  return invoke("get_active_template");
}

export async function setActiveTemplate(templateId) {
  return invoke("set_active_template", { templateId });
}

export async function runSkillTool(operation, target = null, strict = false) {
  return invoke("run_skill_tool", { operation, target, json: true, strict });
}

export async function getCapabilitiesProfiles() {
  return invoke("get_capabilities_profiles");
}

export async function installProfilePackages(packages) {
  return invoke("install_profile_packages", { packages });
}

export async function installProfileBinaries(binaryIds) {
  return invoke("install_profile_binaries", { binaryIds });
}

export async function runSkillSelfTest(operationId = "") {
  return invoke("run_skill_self_test", { operationId });
}

export async function runWelcomeGuideGeneration() {
  return invoke("run_welcome_guide_generation");
}

export async function saveSelfTestResult(record) {
  return invoke("save_self_test_result", { record });
}

export async function installVivliostyleCli() {
  return invoke("install_vivliostyle_cli");
}

export async function installNpmPackages(packages) {
  return invoke("install_npm_packages", { packages });
}

// ── Preferencias de IA ───────────────────────────────────────────────────
export async function getAiPreference() {
  return invoke("get_ai_preference");
}

export async function saveAiPreference(providerId, modelId, modelName) {
  return invoke("save_ai_preference", { providerId, modelId, modelName });
}

export async function opencodeRenameSession(coursePath, sessionId, title) {
  return invoke("opencode_rename_session", { coursePath, sessionId, title });
}

export async function opencodeDeleteSession(coursePath, sessionId) {
  return invoke("opencode_delete_session", { coursePath, sessionId });
}

// ── Codex app-server (ChatGPT sin API key) ───────────────────────────────
export async function codexStatus() {
  return invoke("codex_status");
}

export async function codexStart() {
  return invoke("codex_start");
}

export async function codexStop() {
  return invoke("codex_stop");
}

export async function codexGetAccount() {
  return invoke("codex_get_account");
}

export async function codexStartLogin() {
  return invoke("codex_start_login");
}

export async function codexStartThread(cwd) {
  return invoke("codex_start_thread", { cwd });
}

export async function codexListModels() {
  return invoke("codex_list_models");
}

export async function codexReadRateLimits() {
  return invoke("codex_read_rate_limits");
}

export async function codexSubmitTurn(threadId, message, model = null, effort = null) {
  return invoke("codex_submit_turn", { threadId, message, model, effort });
}

export async function codexInterruptTurn(threadId, turnId) {
  return invoke("codex_interrupt_turn", { threadId, turnId });
}

export async function codexRespondApproval(id, decision) {
  return invoke("codex_respond_approval", { id, decision });
}

// ── Claude Code CLI (suscripción, sin API key) ────────────────────────────
export async function claudeStatus() {
  return invoke("claude_status");
}

export async function claudeSubmitTurn(request, tools = null, permissionMode = null) {
  return invoke("claude_submit_turn", { request, tools, permissionMode });
}

export async function claudeInterruptTurn(requestId) {
  return invoke("claude_interrupt_turn", { requestId });
}

export async function claudeAuthLogin() {
  return invoke("claude_auth_login");
}

// ── Diálogos ─────────────────────────────────────────────────────────────
export async function pickDirectory(title, defaultPath = undefined) {
  try {
    return await dialogOpen({ directory: true, title, defaultPath });
  } catch {
    return prompt(`${title} (escribe la ruta):`);
  }
}
