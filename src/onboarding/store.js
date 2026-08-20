/**
 * store.js — Estado compartido de caché y carga del onboarding.
 *
 * Exporta el objeto `runtime` (fuente de verdad de toda la sesión de
 * onboarding), y las funciones que lo gestionan: loadOnce,
 * rememberSuccessfulLoad y warmOnboardingData.
 *
 * prepareOnboardingStep también vive aquí porque depende directamente de
 * runtime y de los loaders de datos (checkDependencies, etc.).
 */

import {
  checkDependencies,
  checkNotebookLMAuth,
  claudeStatus,
  codexStart,
  codexStatus,
  getActiveTemplate,
  getCapabilitiesProfiles,
  getSetupStatus,
  listTemplates,
} from "../api.js";
import { state } from "../state.js";
import { normalizeCapabilities } from "../onboardingCapabilities.js";
import {
  loadProfileDraft,
  persistProfileDraft,
  profileDraftFromConfig,
} from "../onboardingDraft.js";
import { createOperationState } from "../onboardingLongOperation.js";

// Esquema de 5 pasos (v4 en el backend; ver migrate_status en onboarding.rs).
export const TOTAL_STEPS = 5;
export const STEP_META = [
  { title: "Bienvenida", subtitle: "Convierte tu sílabo en guías PDF y trabaja con Claude Code, ChatGPT (Codex) u OpenCode.", icon: "graduation-cap" },
  { title: "Herramientas", subtitle: "Revisa de una vez qué está listo y qué necesita Jintia.", icon: "terminal" },
  { title: "Tu perfil", subtitle: "Institución, autoría y plantilla de tus documentos.", icon: "building-2" },
  { title: "Integraciones", subtitle: "Jintia prepara tus asistentes y elige automáticamente la mejor opción disponible.", icon: "notebook" },
  { title: "Todo listo", subtitle: "Comprobamos que ya puedes crear tu primera asignatura.", icon: "check-circle-2" },
];

export const LARGE_DEPENDENCIES = new Set([]);

export const runtime = {
  status: null,
  dependencies: [],
  auth: null,
  setup: null,
  assistantAccounts: {
    claude: { installed: false, authenticated: false },
    codex: { installed: false, logged_in: false, account: null },
  },
  templates: [],
  activeTemplate: "",
  sitePalette: null,
  detectedSiteName: "",
  loads: new Map(),
  loadingStep: null,
  depFocusIndex: 0,
  profileDraft: null,
  capabilityProfiles: null,
  dependencyOperations: new Map(),
  authOperation: createOperationState({ title: "Conectar NotebookLM" }),
  targetOperation: createOperationState({ title: "Preparar integración" }),
  authElapsedTimer: null,
  renderedStep: null,
};

export function loadOnce(key, loader, force = false) {
  const existing = runtime.loads.get(key);
  if (existing && (!force || existing.status === "pending")) {
    return existing.promise;
  }
  const entry = { status: "pending", promise: null };
  entry.promise = Promise.resolve()
    .then(loader)
    .then(value => {
      entry.status = "fulfilled";
      return value;
    })
    .catch(error => {
      if (runtime.loads.get(key) === entry) runtime.loads.delete(key);
      throw error;
    });
  runtime.loads.set(key, entry);
  return entry.promise;
}

export function rememberSuccessfulLoad(key) {
  runtime.loads.set(key, {
    status: "fulfilled",
    promise: Promise.resolve(),
  });
}

export async function prepareOnboardingStep(step, { force = false } = {}) {
  if (step >= 5) {
    await Promise.all([
      prepareOnboardingStep(2, { force }),
      prepareOnboardingStep(3, { force }),
      prepareOnboardingStep(4, { force }),
    ]);
  }
  if (step === 2) {
    await loadOnce("dependencies", async () => {
      runtime.dependencies = normalizeCapabilities(await checkDependencies());
    }, force);
  }
  if (step === 3) {
    await loadOnce("templates", async () => {
      [runtime.templates, runtime.activeTemplate, runtime.capabilityProfiles] = await Promise.all([
        listTemplates(),
        getActiveTemplate(),
        getCapabilitiesProfiles().catch(() => null),
      ]);
      if (!runtime.profileDraft) {
        runtime.profileDraft = loadProfileDraft(
          localStorage,
          profileDraftFromConfig(state.config, runtime.activeTemplate),
        );
      }
      if (!runtime.profileDraft.templateId && runtime.activeTemplate) {
        runtime.profileDraft = persistProfileDraft(localStorage, {
          ...runtime.profileDraft,
          templateId: runtime.activeTemplate,
        });
      }
      runtime.activeTemplate = runtime.profileDraft.templateId || runtime.activeTemplate;
    }, force);
  }
  if (step === 4) {
    await loadOnce("notebooklm-auth", async () => {
      runtime.auth = await checkNotebookLMAuth();
    }, force);
    await loadOnce("setup", async () => {
      runtime.setup = await getSetupStatus();
    }, force);
    await loadOnce("assistant-accounts", async () => {
      const claude = await claudeStatus().catch(() => ({ installed: false, authenticated: false }));
      let codex = await codexStatus().catch(() => ({ installed: false, running: false, logged_in: false, account: null }));
      if (codex.installed && !codex.running) {
        const started = await codexStart().catch(() => ({ success: false }));
        if (started?.success) {
          codex = await codexStatus().catch(() => codex);
        }
      }
      runtime.assistantAccounts = { claude, codex };
    }, force);
  }
}

export function targetReady(target) {
  const setup = runtime.setup || {};
  const allSkillsReady = setup.skill_installed && setup.skill_current;
  void target;
  return allSkillsReady
    && setup.claude_skill_current
    && setup.codex_skill_current
    && setup.opencode_skill_current
    && setup.opencode_cli_installed
    && setup.mcp_claude_code_configured
    && setup.mcp_codex_configured
    && setup.openai_plugin_current;
}

export function warmOnboardingData(currentStep) {
  const warm = [];
  if (currentStep < 2) warm.push(prepareOnboardingStep(2));
  if (currentStep < 3) warm.push(prepareOnboardingStep(3));
  // El destino tarda varios segundos (npx/MCP); se calienta aparte de NotebookLM.
  if (currentStep < 4) warm.push(loadOnce("setup", async () => { runtime.setup = await getSetupStatus(); }));
  void Promise.allSettled(warm);
}
