import { appLocalDataDir } from "@tauri-apps/api/path";
import {
  advanceOnboarding,
  applyInstitutionConfig,
  checkDependencies,
  checkNotebookLMAuth,
  configureMcp,
  completeOnboarding,
  downloadNodeRuntime,
  downloadPythonRuntime,
  downloadSkillRuntime,
  extractSitePalette,
  generateSyllabus,
  getActiveTemplate,
  getOnboardingStatus,
  getSetupStatus,
  getSkillPath,
  goToOnboardingStep,
  installDependency,
  installNotebookLmMcpRuntime,
  installOpenAIPlugin,
  installSkill,
  listTemplates,
  openExternal,
  pickDirectory,
  startNotebookLMAuth,
  cancelNotebookLMAuth,
  setActiveTemplate,
  getCapabilitiesProfiles,
  getDefaultCourseRoot,
  runSkillSelfTest,
  installVivliostyleCli,
  installNpmPackages,
  installProfilePackages,
  installProfileBinaries,
  saveSelfTestResult,
} from "./api.js";
import { escapeHtml } from "./dom.js";
import { state, saveConfig } from "./state.js";
import { toast } from "./toast.js";
import { ic, refreshIcons } from "./icons.js";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ThinkingOrb } from "thinking-orbs";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import claudeLogo from "./assets/claude-symbol.svg";
import notebookLmLogo from "./assets/notebooklm-logo.svg";
import geminiLogo from "./assets/gemini-icon.svg";
import googleGLogo from "./assets/google-g.svg";
import notebookLmWordmark from "./assets/notebooklm-wordmark.svg";
import { ui, cx } from "./uiClasses.js";
import { withDependencyProgress, GENERIC_DEPENDENCY_EVENT, applyDependencyProgressPresentation } from "./onboardingProgress.js";
import { runSecondaryStage, normalizeProfileInstallResult, verifyPythonInstallResult } from "./onboardingInstall.js";
import { runOperationWithFeedback, awaitPreparationWithCleanup, operationFailureResult } from "./onboardingOperation.js";
import { runCompletionHandoff } from "./onboardingCompletion.js";
import { APP_META } from "./appMeta.js";
import { BrandMark } from "./components/BrandMark.js";
import {
  capabilityStatusLabel,
  installableBlockingCapabilities,
  isOnboardingBlocking,
  normalizeCapabilities,
} from "./onboardingCapabilities.js";
import {
  clearProfileDraft,
  loadProfileDraft,
  persistProfileDraft,
  profileDraftFromConfig,
  validateProfileDraft,
} from "./onboardingDraft.js";
import { createOperationState, elapsedLabel, reduceOperationEvent } from "./onboardingLongOperation.js";

// Esquema de 5 pasos (v3 en el backend; ver migrate_status en onboarding.rs).
const TOTAL_STEPS = 5;
const LARGE_DEPENDENCIES = new Set([]);
const STEP_META = [
  { title: "Bienvenida", subtitle: "Convierte tu sílabo en guías PDF y trabaja con Claude, ChatGPT o Codex.", icon: "graduation-cap" },
  { title: "Herramientas", subtitle: "Revisa de una vez qué está listo y qué necesita Jintia.", icon: "terminal" },
  { title: "Tu perfil", subtitle: "Institución, autoría y plantilla de tus documentos.", icon: "building-2" },
  { title: "Integraciones", subtitle: "Conecta tus fuentes y el asistente con el que trabajarás.", icon: "notebook" },
  { title: "Todo listo", subtitle: "Comprobamos que ya puedes crear tu primera asignatura.", icon: "check-circle-2" },
];
let runtime = {
  status: null,
  dependencies: [],
  auth: null,
  setup: null,
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
let onboardingActionInFlight = false;
let onboardingBusyMessage = "";

function loadOnce(key, loader, force = false) {
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

function rememberSuccessfulLoad(key) {
  runtime.loads.set(key, {
    status: "fulfilled",
    promise: Promise.resolve(),
  });
}

async function prepareOnboardingStep(step, { force = false } = {}) {
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
  }
}

function warmOnboardingData(currentStep) {
  const warm = [];
  if (currentStep < 2) warm.push(prepareOnboardingStep(2));
  if (currentStep < 3) warm.push(prepareOnboardingStep(3));
  // El destino tarda varios segundos (npx/MCP); se calienta aparte de NotebookLM.
  if (currentStep < 4) warm.push(loadOnce("setup", async () => { runtime.setup = await getSetupStatus(); }));
  void Promise.allSettled(warm);
}

const BTN_PRIMARY = cx(ui.button.base, ui.button.primary, "h-11 w-full cursor-pointer px-4");
const BTN_SECONDARY = cx(ui.button.base, ui.button.secondary, "h-9 cursor-pointer px-4");
const SCROLL_THIN = "onboarding-scrollbar";
const CARD_LEAD = "max-w-md mx-auto mb-5 text-center text-gray-600 text-sm leading-relaxed";
const CALLOUT = "flex gap-2.5 items-start max-w-lg mx-auto mt-4 p-3.5 rounded-xl bg-gray-100 text-gray-600 text-xs leading-relaxed";
const INLINE_ERROR = "max-w-lg mx-auto mt-3 p-3 rounded-lg bg-red-50 border border-red-300 text-red-600 text-xs flex items-center gap-2";
// "Checking" usa vidrio (igual que las tarjetas del paso de bienvenida,
// ui.surface.cardGlass) para que ambos pasos compartan el mismo lenguaje
// visual. Ready/Missing quedan sólidos a propósito: son indicadores
// cruciales de estado (Translucent Restraint Rule, DESIGN.md), no
// contenido de paso — igual que el resto de badges de estado de la app.
const DEP_ROW_CHECKING = "border-white/20 bg-white/40";
const DEP_ROW_READY = "border-gray-900 bg-gray-50";
const DEP_ROW_MISSING = "border-red-300 bg-red-50";
// Paso 2: una tarjeta grande por herramienta (ver dependenciesStep), no una cuadrícula.
const DEP_CARD_BASE = "relative isolate flex flex-col gap-2.5 overflow-hidden p-4 rounded-xl border backdrop-blur-xl backdrop-saturate-125 shadow-sm transition-colors min-w-0 will-change-[backdrop-filter]";
const DEP_CARD_STATUS_BASE = "w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center";
const LOADING_PALETTE = [
  { hex: "#4893FC", rgb: [72, 147, 252] },
  { hex: "#749BFF", rgb: [116, 155, 255] },
  { hex: "#969DFF", rgb: [150, 157, 255] },
  { hex: "#BD99FE", rgb: [189, 153, 254] },
];

// Paleta propia del fondo ambiental del onboarding: antes reutilizaba
// LOADING_PALETTE (azules/morados de Google, pensados para el orbe de
// Gemini/NotebookLM). El primer momento de marca que ve un docente debe
// verse en el teal de Jintia (DESIGN.md), no en los colores de un servicio
// de terceros.
const ONBOARDING_AMBIENT_PALETTE = [
  { hex: "#0fa3a3" },
  { hex: "#18b6ad" },
  { hex: "#0f7f86" },
  { hex: "#34c37a" },
];

function onboardingAmbientBackground() {
  return `<div class="onboarding-ambient" aria-hidden="true">
    ${ONBOARDING_AMBIENT_PALETTE.map(({ hex }, index) => `<span class="onboarding-blob onboarding-blob--${index + 1}" style="--blob-color:${hex}"></span>`).join("")}
  </div>`;
}

let geminiOrbSequence = 0;

function geminiThinkingOrb(label) {
  const instanceId = `gemini-thinking-orb-${geminiOrbSequence += 1}`;
  const layers = [
    ["inset(0 50% 50% 0)", LOADING_PALETTE[0].hex],
    ["inset(0 0 50% 50%)", LOADING_PALETTE[1].hex],
    ["inset(50% 50% 0 0)", LOADING_PALETTE[2].hex],
    ["inset(50% 0 0 50%)", LOADING_PALETTE[3].hex],
  ];
  return createElement(
    "div",
    { className: "gemini-thinking-orb", role: "img", "aria-label": label },
    createElement(
      "svg",
      { width: 0, height: 0, "aria-hidden": "true", focusable: "false" },
      createElement(
        "defs",
        null,
        ...layers.map(([, color], index) => createElement(
          "filter",
          { id: `${instanceId}-color-${index}`, key: color, colorInterpolationFilters: "sRGB" },
          createElement("feFlood", { floodColor: color, result: "geminiColor" }),
          createElement("feComposite", {
            in: "geminiColor",
            in2: "SourceGraphic",
            operator: "in",
          }),
        )),
      ),
    ),
    ...layers.map(([clipPath], index) => createElement(ThinkingOrb, {
      key: `${instanceId}-layer-${index}`,
      state: "working",
      size: 64,
      theme: "light",
      "aria-hidden": "true",
      className: "gemini-thinking-orb__layer",
      style: {
        position: "absolute",
        inset: 0,
        width: 192,
        height: 192,
        clipPath,
        filter: `url(#${instanceId}-color-${index})`,
      },
      tabIndex: -1,
      paused: false,
      speed: 1,
      "data-orb-layer": index,
    })),
  );
}

function mountGeminiOrb(host, label) {
  const orbRoot = createRoot(host);
  orbRoot.render(geminiThinkingOrb(label));
  return () => orbRoot.unmount();
}

let stopStepOrb = null;

export function mountGeminiLoading(root, message = "Preparando tu espacio de trabajo…") {
  if (!root) return () => {};
  root.className = "fixed inset-0 z-[10000] flex items-center justify-center overflow-hidden bg-gray-50";
  root.innerHTML = `${onboardingAmbientBackground()}
    <div class="relative z-[1] flex h-full w-full max-w-3xl flex-col items-center justify-center gap-4 p-6">
      <div data-gemini-loading-orb role="status" aria-live="polite"></div>
      <p class="text-sm font-semibold text-slate-700">${escapeHtml(message)}</p>
    </div>`;

  const stopOrb = mountGeminiOrb(root.querySelector("[data-gemini-loading-orb]"), message);
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    stopOrb();
    root.replaceChildren();
    root.className = "";
  };
}

export async function renderOnboarding() {
  const root = document.getElementById("onboarding-root");
  if (!root) return;
  const stopOrbs = mountGeminiLoading(root);

  try {
    runtime.status = await getOnboardingStatus();
    const currentStep = Number(runtime.status?.currentStep || 1);
    await prepareOnboardingStep(currentStep);
    stopOrbs();
    root.className = "fixed inset-0 z-[10000] flex items-center justify-center overflow-hidden bg-gray-50";
    if (runtime.status.regressionReason) toast(runtime.status.regressionReason, "error", 12000);
    renderCurrentStep();
    warmOnboardingData(currentStep);
  } catch (error) {
    stopOrbs();
    root.className = "fixed inset-0 z-[10000] flex items-center justify-center overflow-hidden bg-gray-50";
    root.innerHTML = `${onboardingAmbientBackground()}
    <div class="relative z-[1] w-full max-w-3xl mx-auto h-full max-h-screen flex flex-col items-center justify-center p-6 text-center">
      <h1 class="text-2xl font-semibold text-gray-900 mb-2">No se pudo iniciar el onboarding</h1>
      <p class="text-gray-600 mb-5">${escapeHtml(error)}</p>
      <button class="${BTN_PRIMARY} max-w-xs" data-onboarding-action="retry"><span>Reintentar</span></button>
    </div>`;
    root.querySelector("[data-onboarding-action=retry]").addEventListener("click", () => runOnboardingOperation(
      "Reintentando el inicio…",
      renderOnboarding,
    ));
  }
}

function stepNumber() {
  return Number(runtime.status?.currentStep || 1);
}

function renderCurrentStep() {
  const root = document.getElementById("onboarding-root");
  if (!root || !runtime.status) return;
  stopStepOrb?.();
  stopStepOrb = null;
  if (runtime.status.completed) {
    root.remove();
    return;
  }

  const current = stepNumber();
  const stepChanged = runtime.renderedStep !== current;
  runtime.renderedStep = current;
  const meta = STEP_META[current - 1];
  root.innerHTML = `
    ${onboardingAmbientBackground()}
    <div class="absolute left-4 top-3 z-10 flex items-center gap-2.5" aria-label="Jintia">
      <div class="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm" aria-hidden="true">
        ${BrandMark({ className: "h-6 w-6", size: 24 })}
      </div>
      <div>
        <div class="text-sm font-extrabold tracking-tight text-slate-900">Jintia</div>
        <div class="text-xs text-slate-500">Diseña el camino del aprendizaje</div>
      </div>
    </div>
    <div class="absolute top-3 right-3 flex z-10" data-tauri-drag-region>
      <button class="${ui.windowControl.base}" id="onb-win-minimize" aria-label="Minimizar" title="Minimizar">${ic("minus", 16)}</button>
      <button class="${cx(ui.windowControl.base, ui.windowControl.close)}" id="onb-win-close" aria-label="Cerrar" title="Cerrar">${ic("x", 16)}</button>
    </div>
    <main class="relative z-[1] mx-auto flex h-full w-full max-w-[1500px] flex-col px-6 pb-5 pt-16 sm:px-8 xl:px-12" aria-labelledby="onboarding-title">
      <p id="onboarding-step-announcement" class="sr-only" aria-live="${stepChanged ? "polite" : "off"}" aria-atomic="true">Paso ${current} de ${TOTAL_STEPS}: ${escapeHtml(meta.title)}</p>
      <div class="flex min-h-0 flex-1 flex-col items-stretch overflow-y-auto pr-2 ${SCROLL_THIN}">
        <div class="my-auto w-full">
          <div class="mb-6 w-full border-b border-gray-200/80 pb-5 text-left">
            <p class="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-teal-700">Paso ${current} de ${TOTAL_STEPS}</p>
            <h1 id="onboarding-title" tabindex="-1" class="text-4xl font-semibold tracking-tight text-gray-900 animate-[fade-in-up_0.5s_ease-out_forwards] sm:text-5xl">${escapeHtml(meta.title)}</h1>
            <p class="mt-3 max-w-3xl text-base leading-relaxed text-gray-600 animate-[fade-in-up_0.5s_ease-out_forwards] [animation-delay:75ms]">${escapeHtml(meta.subtitle)}</p>
          </div>
          <div id="onboarding-step-content" class="w-full"></div>
        </div>
      </div>
      <div id="onboarding-bottom-nav" class="flex-shrink-0"></div>
    </main>`;

  document.getElementById("onb-win-minimize")?.addEventListener("click", () => getCurrentWindow().minimize());
  document.getElementById("onb-win-close")?.addEventListener("click", async () => {
    if (runtime.authOperation.id && runtime.authOperation.cancellable) {
      await cancelNotebookLMAuth(runtime.authOperation.id).catch(() => {});
    }
    getCurrentWindow().close();
  });

  const content = document.getElementById("onboarding-step-content");
  if (runtime.loadingStep === current) {
    content.innerHTML = loadingStep(current);
    const host = content.querySelector("[data-step-loading-orb]");
    if (host) stopStepOrb = mountGeminiOrb(host, "Preparando el siguiente paso");
  } else {
    if (current === 1) content.innerHTML = welcomeStep();
    if (current === 2) content.innerHTML = dependenciesStep();
    if (current === 3) content.innerHTML = profileStep();
    if (current === 4) content.innerHTML = connectStep();
    if (current === 5) content.innerHTML = finalStep();
  }
  document.getElementById("onboarding-bottom-nav").innerHTML = renderBottomNav(current);
  bindStepEvents(current);
  refreshIcons();
  syncOnboardingBusyState();
  if (stepChanged) requestAnimationFrame(() => document.getElementById("onboarding-title")?.focus({ preventScroll: true }));
}

function progressDots(current) {
  const maxDone = Number(runtime.status.maxCompletedStep || 0);
  return STEP_META.map((meta, index) => {
    const step = index + 1;
    const active = step === current;
    const available = step <= maxDone + 1;
    return `<button type="button" class="min-h-11 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${active ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-white/60"}" ${available ? `data-onboarding-step="${step}"` : "disabled"} data-step-index="${step}" ${active ? 'aria-current="step"' : ""}>
      <span class="mr-1 tabular-nums ${active ? "text-white/70" : "text-gray-400"}">${step}</span>${escapeHtml(meta.title)}
    </button>`;
  }).join('<span class="text-gray-300" aria-hidden="true">·</span>');
}

function openaiPluginLabel(setup) {
  const state = setup.openai_plugin_state ?? "";
  if (state === "outdated")   return "Actualizar plugin ChatGPT/Codex";
  if (state === "foreign")    return "Reparar plugin ChatGPT/Codex";
  if (state === "incomplete") return "Completar plugin ChatGPT/Codex";
  if (setup.openai_plugin_installed) return "Actualizar para ChatGPT y Codex";
  return "Preparar para ChatGPT y Codex";
}

function actionButton(label, action, disabled = false, secondary = false, iconHtml = "") {
  return `<button class="${secondary ? BTN_SECONDARY : BTN_PRIMARY}" data-onboarding-action="${action}" ${disabled ? "disabled" : ""}>${iconHtml}<span>${escapeHtml(label)}</span></button>`;
}

let footerConfig = { label: "Continuar", action: "advance", disabled: false };
function setFooter(label, action = "advance", disabled = false) {
  footerConfig = { label, action, disabled };
}

function renderBottomNav(current) {
  const canBack = current > 1;
  return `<div class="flex flex-shrink-0 flex-col items-center pt-2">
    <div id="onboarding-operation-status" class="mb-1 flex h-5 items-center justify-center gap-1.5 text-xs font-medium text-gray-500 transition-opacity ${onboardingActionInFlight ? "opacity-100" : "opacity-0"}" role="status" aria-live="polite" aria-atomic="true">
      <span class="animate-spin">${ic("loader-2", 13)}</span>
      <span data-operation-message>${escapeHtml(onboardingBusyMessage || "Procesando…")}</span>
    </div>
    <div class="flex items-center justify-center gap-3">
      <button type="button" class="onboarding-nav-arrow onboarding-nav-arrow--back liquid-control border border-white/45 bg-white/55 ${canBack ? "" : "pointer-events-none opacity-0"}" data-operation-lock="global" data-onboarding-action="back" aria-label="Paso anterior" title="Paso anterior">${ic("chevron-left", 18)}</button>
      <nav class="${cx(ui.liquid.group, "onboarding-progress relative flex flex-wrap items-center justify-center gap-1 px-1")}" aria-label="Progreso de configuración">${progressDots(current)}</nav>
      <button type="button" class="${cx(ui.button.base, ui.button.primary, "h-11 cursor-pointer pl-4 pr-3 text-[13px]")}" data-operation-lock="global" data-onboarding-action="${footerConfig.action}" ${footerConfig.disabled ? "disabled" : ""}><span>${escapeHtml(footerConfig.label)}</span>${ic("chevron-right", 16)}</button>
    </div>
  </div>`;
}

function syncOnboardingBusyState() {
  const root = document.getElementById("onboarding-root");
  if (!root) return;
  root.setAttribute("aria-busy", String(onboardingActionInFlight));

  const status = root.querySelector("#onboarding-operation-status");
  const message = status?.querySelector("[data-operation-message]");
  status?.classList.toggle("opacity-0", !onboardingActionInFlight);
  status?.classList.toggle("opacity-100", onboardingActionInFlight);
  if (message) message.textContent = onboardingBusyMessage || "Procesando…";

  root.querySelectorAll("[data-operation-lock='global']").forEach(control => {
    control.disabled = onboardingActionInFlight;
  });
}

async function runOnboardingOperation(message, operation) {
  if (onboardingActionInFlight) return;
  onboardingActionInFlight = true;
  onboardingBusyMessage = message;
  syncOnboardingBusyState();
  return await runOperationWithFeedback(operation, {
    onError: (msg) => toast(msg, "error", 9000),
    onSettled: () => {
      onboardingActionInFlight = false;
      onboardingBusyMessage = "";
      syncOnboardingBusyState();
    },
  });
}

function actionBusyMessage(action, current) {
  const messages = {
    retry: "Reintentando el inicio…",
    back: "Volviendo al paso anterior…",
    "start-auth": "Abriendo el inicio de sesión de Google…",
    "verify-auth": "Verificando la sesión de NotebookLM…",
    "save-profile-and-template": "Guardando tu institución, perfil y plantilla…",
    "install-local": "Instalando en tu proyecto local…",
    "install-openai": "Preparando Jintia para ChatGPT y Codex…",
    "configure-code": "Conectando tu proyecto local…",
    "configure-desktop": "Conectando la app de Claude…",
    "advance-target": "Comprobando el destino seleccionado…",
    complete: "Finalizando la configuración…",
  };
  if (action === "advance") {
    return current === 2
      ? "Confirmando las herramientas del entorno…"
      : `Preparando el paso ${Math.min(TOTAL_STEPS, current + 1)}…`;
  }
  return messages[action] || "Procesando la solicitud…";
}

function loadingStep(step) {
  const messages = {
    2: "Verificando las herramientas…",
    3: "Preparando tu institución, perfil y plantillas…",
    4: "Comprobando tu sesión de Google y dónde trabajarás…",
    5: "Preparando la prueba final…",
  };
  setFooter("Preparando el siguiente paso", "advance", true);
  return `<section class="flex flex-col items-center justify-center py-10" aria-live="polite">
    <div data-step-loading-orb></div>
    <p class="mt-5 text-sm font-semibold text-gray-800">${messages[step] || "Preparando el siguiente paso…"}</p>
    <p class="mt-1 text-xs text-gray-500">Puedes continuar en cuanto termine esta comprobación.</p>
  </section>`;
}

function animateStepTransition(fromStep, toStep) {
  const track = document.querySelector(".onboarding-progress");
  const origin = stepperDotFor(track, fromStep);
  const destination = stepperDotFor(track, toStep);
  return animateDotWorm(track, origin, destination);
}

// En el paso 2, el punto de entrada es la herramienta enfocada (runtime.depFocusIndex).
function stepperDotFor(track, step) {
  if (!track) return null;
  return track.querySelector(`[data-step-index="${step}"]`);
}

// Anima el nodo activo desplazándose entre dos puntos del stepper (paso
// macro o herramienta): una cápsula turquesa que recorre el camino, sin la
// oruga multi-segmento anterior — coherente con el isotipo "J-camino".
function animateDotWorm(track, origin, destination) {
  if (!track || !origin || !destination || origin === destination || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return Promise.resolve();
  }

  const trackRect = track.getBoundingClientRect();
  const originRect = origin.getBoundingClientRect();
  const destinationRect = destination.getBoundingClientRect();
  const start = originRect.left + originRect.width / 2 - trackRect.left;
  const end = destinationRect.left + destinationRect.width / 2 - trackRect.left;
  const distance = Math.abs(end - start);
  const node = document.createElement("span");
  node.className = "onboarding-progress-node";
  node.setAttribute("aria-hidden", "true");
  node.style.left = `${start}px`;
  track.appendChild(node);
  origin.style.opacity = "0";

  const keyframes = [
    { left: `${start}px`, transform: "translate(-50%, -50%) scaleX(1)" },
    { left: `${start + (end - start) * 0.5}px`, transform: "translate(-50%, -50%) scaleX(1.35)", offset: 0.5 },
    { left: `${end}px`, transform: "translate(-50%, -50%) scaleX(1)" },
  ];
  const animation = node.animate(keyframes, {
    duration: Math.min(240, 180 + distance * 0.25),
    easing: "cubic-bezier(.45, .05, .25, 1)",
    fill: "forwards",
  });
  return animation.finished.catch(() => {}).finally(() => node.remove());
}

async function showPreparedStep(fromStep, destination, { force = false, depFocusIndex } = {}) {
  // Entrar al 2 desde antes enfoca la primera herramienta; desde después, la última.
  if (destination === 2 && fromStep !== 2) {
    const sequence = dependencySequence();
    if (sequence.length > 0) {
      runtime.depFocusIndex = depFocusIndex ?? (fromStep < 2 ? 0 : sequence.length - 1);
    }
  }
  const preparation = prepareOnboardingStep(destination, { force });
  await animateStepTransition(fromStep, destination);

  let prepared = false;
  preparation.then(() => { prepared = true; }, () => { prepared = true; });
  await Promise.resolve();
  if (!prepared) {
    runtime.loadingStep = destination;
    renderCurrentStep();
  }

  await awaitPreparationWithCleanup(preparation, () => {
    runtime.loadingStep = null;
    renderCurrentStep();
  });
}

function dependencySequence() {
  return runtime.dependencies;
}

function operationPanelMarkup(operation, scope) {
  if (!operation || operation.state === "idle") return `<div data-operation-panel="${escapeHtml(scope)}"></div>`;
  const terminal = ["success", "warning", "error", "cancelled"].includes(operation.state);
  const tone = operation.state === "error" ? "border-red-200 bg-red-50 text-red-800"
    : operation.state === "success" ? "border-green-200 bg-green-50 text-green-800"
    : operation.state === "cancelled" ? "border-gray-200 bg-gray-50 text-gray-700"
    : "border-teal-200 bg-teal-50 text-teal-900";
  const elapsed = elapsedLabel(operation.startedAt);
  return `<div class="mt-3 rounded-lg border p-3 ${tone}" data-operation-panel="${escapeHtml(scope)}" role="status" aria-live="polite" aria-atomic="true">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0"><strong class="block text-sm">${escapeHtml(operation.title || "Operación")}</strong><span class="block text-xs leading-relaxed" data-operation-message>${escapeHtml(operation.message || "Preparando…")}</span></div>
      ${elapsed ? `<time class="shrink-0 text-xs tabular-nums" data-operation-elapsed>${elapsed}</time>` : '<time class="hidden shrink-0 text-xs tabular-nums" data-operation-elapsed></time>'}
    </div>
    ${operation.percent !== null ? `<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${operation.percent}"><div class="h-full bg-current transition-[width]" style="width:${operation.percent}%"></div></div>` : (!terminal ? `<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10"><div class="onboarding-indeterminate h-full w-1/3 bg-current"></div></div>` : "")}
    ${operation.technicalDetail ? `<details class="mt-2"><summary class="cursor-pointer text-xs font-semibold">Detalle técnico</summary><pre class="mt-2 whitespace-pre-wrap break-words rounded bg-gray-950 p-2 text-xs text-gray-100">${escapeHtml(operation.technicalDetail)}</pre></details>` : ""}
    <div class="mt-2 flex flex-wrap gap-2">
      ${operation.cancellable ? `<button type="button" class="${BTN_SECONDARY}" data-onboarding-action="cancel-auth">Cancelar</button>` : ""}
      ${(operation.state === "error" || operation.state === "cancelled") && scope === "notebooklm-auth" ? `<button type="button" class="${BTN_SECONDARY}" data-onboarding-action="start-auth">Reintentar</button>` : ""}
    </div>
  </div>`;
}

function capabilityCard(dep) {
  const operation = runtime.dependencyOperations.get(dep.id);
  const status = operation && ["working", "checking"].includes(operation.state) ? "working"
    : operation?.state === "error" ? "error" : dep.status;
  const badgeTone = status === "ready" ? "bg-green-100 text-green-800"
    : status === "working" ? "bg-teal-100 text-teal-800"
    : status === "error" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800";
  const icon = status === "ready" ? "check-circle-2" : status === "working" ? "loader-2" : status === "error" ? "circle-alert" : "download";
  return `<article class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm" data-dep-row data-dep-id="${escapeHtml(dep.id)}" data-dep-name="${escapeHtml(dep.name)}">
    <div class="flex items-start gap-3">
      <span class="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${badgeTone}" data-dep-status>${ic(icon, 19)}</span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <strong class="text-sm font-bold text-gray-900">${escapeHtml(dep.label)}</strong>
          <span class="rounded-full px-2.5 py-1 text-xs font-bold ${badgeTone}">${capabilityStatusLabel(status)}</span>
        </div>
        <p class="mt-1 text-xs leading-relaxed text-gray-600">${escapeHtml(dep.reason)}</p>
        <p class="mt-1 text-xs text-gray-400">${dep.blockingScope === "onboarding" ? "Necesario para completar la preparación" : "Opcional; puedes prepararlo después"}</p>
        ${status !== "ready" && dep.installable && status !== "working" ? `<button type="button" class="${BTN_SECONDARY} mt-3" data-install-dependency="${escapeHtml(dep.name)}">${dep.blockingScope === "none" ? "Instalar por separado" : "Instalar"}</button>` : ""}
        ${status !== "ready" && !dep.installable ? `<button type="button" class="${BTN_SECONDARY} mt-3" data-show-capability-details="${escapeHtml(dep.id)}">Ver cómo habilitarla</button>` : ""}
        <details id="capability-detail-${escapeHtml(dep.id)}" class="mt-3"><summary class="cursor-pointer text-xs font-semibold text-gray-500">Detalles técnicos</summary><div class="mt-2 rounded-lg bg-gray-950 p-2.5 font-mono text-xs text-gray-200">${escapeHtml(dep.technicalDetail)}${dep.version ? `<br>${escapeHtml(dep.version)}` : ""}</div></details>
        ${operationPanelMarkup(operation, `dependency-${dep.id}`)}
      </div>
    </div>
  </article>`;
}

function dependenciesStep() {
  const missing = runtime.dependencies.filter(isOnboardingBlocking);
  const installable = installableBlockingCapabilities(runtime.dependencies);

  if (runtime.dependencies.length === 0) {
    setFooter("Continuar", "advance", true);
    return `<section class="flex items-center justify-center py-10" aria-live="polite">
      <span class="text-gray-700 animate-spin">${ic("loader-2", 26)}</span>
    </section>`;
  }

  const blockReason = missing.length ? `Falta preparar: ${missing.map(dep => dep.label).join(", ")}.` : null;
  setFooter("Continuar", "advance", missing.length > 0);
  const installLabel = installable.length === 1 ? "Instalar 1 componente necesario" : "Instalar todo lo necesario";

  return `<section>
    <div class="mb-4 flex w-full flex-col gap-3 rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p class="text-sm leading-relaxed text-teal-950"><strong>Entorno privado de Jintia.</strong> Estas instalaciones no cambian tu Python ni tu Node global.</p>
      ${installable.length ? `<button type="button" class="${BTN_PRIMARY} !w-auto shrink-0" data-onboarding-action="install-all-needed">${escapeHtml(installLabel)}</button>` : `<span class="shrink-0 rounded-full bg-green-100 px-3 py-1.5 text-xs font-bold text-green-800">Todo lo necesario está listo</span>`}
    </div>
    <div class="grid w-full gap-3 lg:grid-cols-2 2xl:grid-cols-3">${runtime.dependencies.map(capabilityCard).join("")}</div>
    ${blockReason ? `<div class="${INLINE_ERROR} !max-w-none">${ic("alert-circle", 14)} ${escapeHtml(blockReason)}</div>` : ""}
  </section>`;
}

// Inicia la UI de progreso en la tarjeta y devuelve un reporter({ message, percent })
// para actualizarla con datos reales del backend.
const DEP_PROGRESS_DOTS = 6;
function beginDependencyInstallProgress(row, statusEl, detailEl, installButton) {
  if (statusEl) {
    statusEl.className = `${DEP_CARD_STATUS_BASE} bg-neutral-100 text-neutral-400`;
    statusEl.innerHTML = `<span class="animate-spin flex">${ic("loader-2", 18)}</span>`;
  }
  if (detailEl) detailEl.textContent = "Instalando…";
  installButton?.remove();

  const track = document.createElement("div");
  track.className = "dep-progress-track mt-1 self-start";
  track.setAttribute("role", "status");
  track.setAttribute("aria-live", "polite");
  track.setAttribute("aria-label", "Instalando…");
  const dots = Array.from({ length: DEP_PROGRESS_DOTS }, () => `<span class="dep-progress-dot"></span>`).join("");
  track.innerHTML = `${dots}<span class="dep-progress-node" aria-hidden="true"></span>`;
  row.appendChild(track);

  // Barra de progreso determinado (oculta hasta recibir porcentaje real)
  const barWrap = document.createElement("div");
  barWrap.style.cssText = "height:2px;border-radius:1px;background:#e5e7eb;margin-top:4px;overflow:hidden;display:none";
  const barFill = document.createElement("div");
  barFill.style.cssText = "height:100%;background:var(--color-brand-600,#4f46e5);width:0%;transition:width 0.25s";
  barWrap.appendChild(barFill);
  row.appendChild(barWrap);

  return function reportDependencyProgress({ message, percent }) {
    if (message !== null) {
      if (detailEl) detailEl.textContent = message;
      onboardingBusyMessage = message;
      syncOnboardingBusyState();
    }
    applyDependencyProgressPresentation({ track, barWrap, barFill, message, percent });
  };
}

// Revela el estado final de la tarjeta enfocada tras un pequeño retardo
// cosmético (el chequeo real ya terminó antes de entrar al paso 2; esto solo
// mantiene la sensación de "verificando" al cambiar de herramienta).
function animateDependencyFocus(dep) {
  const card = document.querySelector("#onboarding-step-content [data-dep-row]");
  if (!card) return;
  setTimeout(() => {
    card.className = `${DEP_CARD_BASE} ${dep.installed ? DEP_ROW_READY : DEP_ROW_MISSING}`;
    const statusEl = card.querySelector("[data-dep-status]");
    const detailEl = card.querySelector(".dep-detail");
    if (statusEl) {
      statusEl.className = `${DEP_CARD_STATUS_BASE} ${dep.installed ? "bg-gray-200 text-green-700" : "bg-red-100 text-red-500"}`;
      statusEl.innerHTML = dep.installed ? ic("check-circle-2", 20) : ic("alert-circle", 20);
    }
    if (detailEl) detailEl.textContent = dep.note || (dep.installed ? "Listo" : "No encontrado");

    if (!dep.installed) {
      const btn = document.createElement("button");
      btn.className = BTN_SECONDARY + " mt-1 self-start";
      btn.dataset.installDependency = dep.name;
      btn.innerHTML = "<span>Instalar</span>";
      btn.addEventListener("click", () => requestDependencyInstall(dep.name, btn));
      card.appendChild(btn);
    } else {
      const badge = document.createElement("span");
      badge.className = "inline-flex text-xs font-semibold px-2.5 py-1 rounded-full bg-green-100 text-green-700 flex-shrink-0 self-start mt-1";
      badge.textContent = "Listo";
      card.appendChild(badge);
    }

    if (dep.command) {
      const details = document.createElement("details");
      details.className = "mt-1";
      const summary = document.createElement("summary");
      summary.className = "flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden";
      summary.innerHTML = `${ic("terminal", 13)} Ver detalle avanzado`;
      details.appendChild(summary);
      const term = document.createElement("div");
      term.className = "mt-1 px-2.5 py-2 rounded-md bg-gray-900 font-mono text-[10.5px] leading-snug";
      const resultText = dep.installed ? (dep.version || "OK") : (dep.version || "No encontrado");
      term.innerHTML = `<span class="block text-gray-400 whitespace-pre-wrap break-words"><span class="text-green-400 mr-1">$</span>${escapeHtml(dep.command)}</span><span class="block text-gray-200 whitespace-pre-wrap break-words">${escapeHtml(resultText)}</span>`;
      details.appendChild(term);
      card.appendChild(details);
    }
    refreshIcons();
    syncOnboardingBusyState();
  }, 260);
}

function revealFocusedDependency() {
  const sequence = dependencySequence();
  if (sequence.length > 0) animateDependencyFocus(sequence[runtime.depFocusIndex]);
}

// Mueve el foco entre herramientas del paso 2 sin llamar al backend.
async function moveDependencyFocus(toIndex) {
  // Guardia de reentrancia: evita animaciones superpuestas con doble clic.
  if (onboardingActionInFlight) return;
  const sequence = dependencySequence();
  const clamped = Math.min(Math.max(toIndex, 0), sequence.length - 1);
  if (clamped === runtime.depFocusIndex) return;
  onboardingActionInFlight = true;
  syncOnboardingBusyState();
  try {
    const track = document.querySelector(".onboarding-progress");
    const origin = track?.querySelector(`[data-dep-step-index="${runtime.depFocusIndex}"]`);
    const destination = track?.querySelector(`[data-dep-step-index="${clamped}"]`);
    await animateDotWorm(track, origin, destination);
    runtime.depFocusIndex = clamped;
    renderCurrentStep();
  } finally {
    onboardingActionInFlight = false;
    syncOnboardingBusyState();
  }
}

// Saltar directo a una herramienta desde otro paso macro (clic en su punto
// en la pista general estando, por ejemplo, en el paso 4): primero navega
// el backend al paso 2 y luego enfoca esa herramienta puntual.
async function jumpToDependencyTool(fromStep, toolIndex) {
  const result = await goToOnboardingStep(2);
  if (!result.success) {
    toast(result.message, "error");
    return;
  }
  runtime.status = result.status;
  await showPreparedStep(fromStep, 2, { depFocusIndex: toolIndex });
}

// Beneficios concretos por defecto; el detalle técnico/pedagógico queda en
// secciones plegables que no bloquean el avance.
function welcomeStep() {
  setFooter("Continuar", "advance", false);
  const welcomeWorkspacePath = state.config.courseRoot || "";
  const welcomeWorkspaceLabel = welcomeWorkspacePath ? escapeHtml(welcomeWorkspacePath) : "Documentos / Jintia (predeterminada)";
  return `<section class="w-full">
    <div class="mb-5 text-left">
      <p class="max-w-4xl text-lg leading-relaxed text-gray-700 sm:text-xl">Prepara una vez tu espacio de trabajo y convierte el sílabo de cada asignatura en materiales claros, consistentes y listos para publicar.</p>
    </div>
    <div class="grid gap-3 sm:grid-cols-3">
      ${[
        ["file-text", "Parte del sílabo", "Jintia organiza resultados, temas, actividades y bibliografía."],
        ["calendar-range", "Trabaja por semanas", "Mantén cada unidad trazable y lista para revisar con tu criterio docente."],
        ["file-down", "Publica en PDF", "Genera documentos con tu autoría, institución y formato elegido."],
      ].map(([icon, title, description]) => `<article class="rounded-xl border border-white/50 bg-white/65 p-5 shadow-sm backdrop-blur-xl"><span class="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-teal-100 text-teal-800">${ic(icon, 20)}</span><h2 class="text-sm font-bold text-gray-900">${title}</h2><p class="mt-1 text-xs leading-relaxed text-gray-600">${description}</p></article>`).join("")}
    </div>
    <div class="mt-4 grid gap-3 lg:grid-cols-2">
    <div class="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white/70 p-4 sm:flex-row sm:items-center">
      <span class="text-teal-700">${ic("shield-check", 20)}</span>
      <p class="flex-1 text-sm leading-relaxed text-gray-600"><strong class="text-gray-900">Tus cursos permanecen en tu equipo.</strong> Solo se usa la red cuando eliges instalar, consultar NotebookLM o analizar un sitio.</p>
    </div>
    <div class="flex flex-col gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 sm:flex-row sm:items-center">
      ${ic("folder", 18)}<div class="min-w-0 flex-1"><strong class="block text-xs text-gray-900">Carpeta de trabajo</strong><span id="onb-workspace-label" class="block truncate text-xs text-gray-500">${welcomeWorkspaceLabel}</span></div>
      <button type="button" id="onb-change-workspace" class="${BTN_SECONDARY}">${ic("folder-open", 14)} Cambiar carpeta</button>
    </div></div>
  </section>`;
}


const FIELD_INPUT = cx(ui.surface.input, "px-3 py-2 w-full");
const FIELD_LABEL = "flex flex-col gap-1.5 text-gray-700 text-xs";

// Institución + perfil + plantilla en una pantalla con un único guardado
// (ver "save-profile-and-template" en performAction).
function profileStep() {
  const config = runtime.profileDraft || profileDraftFromConfig(state.config, runtime.activeTemplate);
  const value = key => escapeHtml(config[key] || "");
  const selectedTemplate = config.templateId || runtime.activeTemplate;
  const template = runtime.templates.find(item => item.id === selectedTemplate) || runtime.templates[0];
  const profileId = runtime.capabilityProfiles?.disciplines?.[config.discipline];
  const profile = profileId ? runtime.capabilityProfiles?.profiles?.[profileId] : null;
  const pythonPackages = profile?.python?.packages || [];
  const nodePackages = profile?.node?.packages || [];
  const packageCount = pythonPackages.length + nodePackages.length;
  const templateCards = runtime.templates.map(t => {
    const isSelected = t.id === selectedTemplate;
    const cardCls = isSelected
      ? "border-gray-900 bg-gray-50 shadow-[0_0_0_3px_rgba(17,24,39,0.08)]"
      : "border-gray-200 bg-white hover:border-gray-400";
    return `
    <button type="button" role="radio" aria-checked="${isSelected}" class="flex min-h-11 flex-col gap-1.5 p-4 rounded-xl border text-left cursor-pointer transition-all ${cardCls}" data-template-id="${escapeHtml(t.id)}">
      <div class="flex items-center gap-2">
        <span class="transition-colors ${isSelected ? "text-green-600" : "text-gray-400"}">${ic(isSelected ? "check-circle-2" : "circle", 18)}</span>
        <strong class="text-[13px] font-bold text-gray-900">${escapeHtml(t.name)}</strong>
      </div>
      <p class="text-xs text-gray-500 leading-relaxed m-0">${escapeHtml(t.description)}</p>
      ${t.features ? `<ul class="mt-1 pl-3.5 text-xs text-gray-400 leading-loose list-disc">${t.features.map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : ""}
    </button>`;
  }).join("");

  const sectionHeading = (index, title) => `
    <div class="flex items-center gap-2 mb-2">
      <span class="flex-shrink-0 w-6 h-6 rounded-full bg-gray-900 text-white text-xs font-bold flex items-center justify-center">${index}</span>
      <h2 class="text-xs font-bold uppercase tracking-wide text-gray-500">${title}</h2>
    </div>`;

  setFooter("Guardar y continuar", "save-profile-and-template", !template);
  return `<section class="grid w-full gap-6 lg:grid-cols-12 lg:items-start">
    <div class="lg:col-span-8 xl:col-span-5">
      ${sectionHeading(1, "Institución")}
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        <label class="${FIELD_LABEL} sm:col-span-2" for="onb-website">
          Sitio web de la institución <span class="text-gray-400 font-normal">(opcional)</span>
          <div class="flex gap-2">
            <input class="${FIELD_INPUT}" id="onb-website" type="url" value="${value("website")}" placeholder="https://www.uide.edu.ec/" aria-describedby="onb-website-hint onb-website-error">
            <button class="${BTN_SECONDARY} flex-shrink-0" id="onb-extract-palette" type="button">
              ${ic("palette", 15)} <span>Analizar</span>
            </button>
          </div>
          <span id="onb-website-hint" class="text-xs text-gray-400 font-normal">Usaremos el sitio para completar el nombre y proponer sus colores. Puedes omitir este paso.</span><span id="onb-website-error" class="text-xs text-red-700" hidden></span>
        </label>
        <div id="onb-site-analysis" class="sm:col-span-2" aria-live="polite">
          ${renderOnboardingSiteAnalysis()}
        </div>
        <label class="${FIELD_LABEL} sm:col-span-2" for="onb-discipline">Área del conocimiento
          <select class="${FIELD_INPUT}" id="onb-discipline" required aria-describedby="onb-discipline-error">
            <option value="">— Selecciona tu área —</option>
            <option value="software-engineering" ${value("discipline") === "software-engineering" ? "selected" : ""}>Informática / Ingeniería de software</option>
            <option value="math-statistics" ${value("discipline") === "math-statistics" ? "selected" : ""}>Matemáticas / Estadística</option>
            <option value="electronics" ${value("discipline") === "electronics" ? "selected" : ""}>Electrónica / Telecomunicaciones</option>
            <option value="natural-sciences" ${value("discipline") === "natural-sciences" ? "selected" : ""}>Ciencias naturales</option>
            <option value="social-sciences" ${value("discipline") === "social-sciences" ? "selected" : ""}>Ciencias sociales / Humanidades</option>
            <option value="health" ${value("discipline") === "health" ? "selected" : ""}>Salud</option>
            <option value="business" ${value("discipline") === "business" ? "selected" : ""}>Administración / Economía</option>
            <option value="design" ${value("discipline") === "design" ? "selected" : ""}>Diseño / Arquitectura</option>
            <option value="general" ${value("discipline") === "general" ? "selected" : ""}>General / Multidisciplinar</option>
          </select><span id="onb-discipline-error" class="text-xs text-red-700" hidden></span>
        </label>
        <label class="${FIELD_LABEL}" for="onb-institution">Institución<input class="${FIELD_INPUT}" id="onb-institution" value="${value("institution")}" placeholder="Universidad Ejemplo" required aria-describedby="onb-institution-error"><span id="onb-institution-error" class="text-xs text-red-700" hidden></span></label>
        <label class="${FIELD_LABEL}" for="onb-faculty">Facultad<input class="${FIELD_INPUT}" id="onb-faculty" value="${value("faculty")}" placeholder="Facultad de Ingeniería" required aria-describedby="onb-faculty-error"><span id="onb-faculty-error" class="text-xs text-red-700" hidden></span></label>
        <label class="${FIELD_LABEL}" for="onb-career">Carrera<input class="${FIELD_INPUT}" id="onb-career" value="${value("career")}" placeholder="Ingeniería de Software" required aria-describedby="onb-career-error"><span id="onb-career-error" class="text-xs text-red-700" hidden></span></label>
        <label class="${FIELD_LABEL}">Color institucional<div class="flex items-center gap-2"><input class="${FIELD_INPUT} h-9 p-1" id="onb-color" type="color" value="${escapeHtml(config.colorHex || "#00796b")}"><span id="onb-color-preview" class="inline-block h-5 w-5 shrink-0 rounded border border-black/20" style="background:${escapeHtml(config.colorHex || "#00796b")}" aria-hidden="true"></span><span id="onb-color-label" class="text-[11px] text-gray-500">${escapeHtml(config.colorHex || "#00796b")}</span></div></label>
      </div>
    </div>

    <div class="border-t border-gray-200 pt-5 lg:col-span-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0 xl:col-span-3">
      ${sectionHeading(2, "Tu perfil")}
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        <label class="${FIELD_LABEL}" for="onb-author">Nombre completo<input class="${FIELD_INPUT}" id="onb-author" value="${value("author")}" placeholder="Ana López" required aria-describedby="onb-author-error"><span id="onb-author-error" class="text-xs text-red-700" hidden></span></label>
        <label class="${FIELD_LABEL}">Grado académico <span class="text-gray-400 font-normal">(opcional)</span><input class="${FIELD_INPUT}" id="onb-degree" value="${value("degree")}" placeholder="Mgtr."></label>
      </div>
    </div>

    <div class="border-t border-gray-200 pt-5 lg:col-span-12 xl:col-span-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
      ${sectionHeading(3, "Formato del documento")}
      <div id="onb-template-group" class="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3" role="radiogroup" aria-label="Plantilla del documento" aria-describedby="onb-templateId-error">${templateCards}</div>
      <span id="onb-templateId-error" class="mt-2 block text-xs text-red-700" hidden></span>
      <div class="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><strong class="block text-sm text-gray-900">Herramientas recomendadas para tu área</strong><p class="mt-1 text-xs leading-relaxed text-gray-600">${packageCount ? `${packageCount} paquete(s): ${pythonPackages.length ? "procesamiento Python" : ""}${pythonPackages.length && nodePackages.length ? " y " : ""}${nodePackages.length ? "visualización Node" : ""}.` : "No hay paquetes adicionales para esta selección."} Se instalan dentro del entorno privado de Jintia y no modifican el sistema.</p></div>${packageCount ? `<button type="button" class="${BTN_SECONDARY} shrink-0" data-onboarding-action="prepare-profile-tools">Preparar herramientas recomendadas</button>` : ""}</div>
        ${operationPanelMarkup(runtime.dependencyOperations.get("profile-packages"), "profile-packages")}
      </div>
    </div>

    <div class="${INLINE_ERROR} !max-w-none lg:col-span-12" id="onb-form-error" hidden></div>
  </section>`;
}

function renderOnboardingSiteAnalysis() {
  if (!runtime.sitePalette?.length) return "";
  return `
    <div class="rounded-xl border border-gray-200 bg-white p-3">
      <div class="flex items-center justify-between gap-2 mb-2.5">
        <span class="text-[11.5px] font-semibold text-gray-700">Paleta detectada</span>
        ${runtime.detectedSiteName ? `<span class="text-[10.5px] text-green-600 truncate">${ic("check-circle-2", 12)} ${escapeHtml(runtime.detectedSiteName)}</span>` : ""}
      </div>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(105px,1fr))] gap-1.5">
        ${runtime.sitePalette.slice(0, 12).map(({ color, occurrences }) => `
          <button type="button" data-onb-palette-color="${escapeHtml(color)}"
            class="flex items-center gap-1.5 min-w-0 rounded-lg border border-gray-200 bg-gray-50 hover:border-gray-900 p-1.5 cursor-pointer text-left"
            title="Usar ${escapeHtml(color)}">
            <span class="w-7 h-7 rounded-md border border-black/10 flex-shrink-0" style="background:${escapeHtml(color)}"></span>
            <span class="min-w-0">
              <code class="block text-[9.5px] text-gray-700 truncate">${escapeHtml(color)}</code>
              <small class="block text-[9px] text-gray-400">${occurrences} usos</small>
            </span>
          </button>`).join("")}
      </div>
    </div>`;
}

async function analyzeInstitutionWebsite() {
  const input = document.getElementById("onb-website");
  const button = document.getElementById("onb-extract-palette");
  const area = document.getElementById("onb-site-analysis");
  const url = input?.value.trim();
  if (!url) {
    toast("Ingresa la URL de la institución o continúa sin analizarla", "error");
    input?.focus();
    return;
  }

  button.dataset.originalLabel = button.querySelector("span")?.textContent || "Analizar";
  setBusyState(button, true, "Analizando…");
  if (area) {
    area.innerHTML = `<div class="flex items-center gap-2 p-3 rounded-lg bg-gray-100 text-gray-500 text-xs">${ic("loader-2", 14)} Analizando el sitio y sus hojas de estilo…</div>`;
  }
  try {
    const result = await extractSitePalette(url);
    runtime.sitePalette = result.colors;
    runtime.detectedSiteName = result.site_name || "";
    const institution = document.getElementById("onb-institution");
    if (institution && result.site_name) institution.value = result.site_name;
    runtime.profileDraft = persistProfileDraft(localStorage, {
      ...(runtime.profileDraft || profileDraftFromConfig(state.config, runtime.activeTemplate)),
      website: url,
      institution: result.site_name || runtime.profileDraft?.institution || "",
    });
    if (area) area.innerHTML = renderOnboardingSiteAnalysis();
    bindOnboardingPaletteButtons();
    refreshIcons();
    syncOnboardingBusyState();
    toast(`Encontramos ${result.colors.length} colores${result.site_name ? " y completamos el nombre" : ""}`, "success", 4500);
  } catch (error) {
    if (area) area.innerHTML = `<div class="${INLINE_ERROR} !mt-0 !max-w-none">${ic("alert-circle", 14)} ${escapeHtml(String(error))}</div>`;
    toast(`No se pudo analizar el sitio: ${error}`, "error", 6000);
  } finally {
    setBusyState(button, false);
  }
}

function bindOnboardingPaletteButtons() {
  document.querySelectorAll("[data-onb-palette-color]").forEach(button => {
    button.addEventListener("click", () => {
      if (onboardingActionInFlight) return;
      const hex = cssColorToHex(button.dataset.onbPaletteColor);
      if (!hex) return toast("No se pudo convertir este color", "error");
      const picker = document.getElementById("onb-color");
      if (picker) picker.value = hex;
      runtime.profileDraft = persistProfileDraft(localStorage, {
        ...(runtime.profileDraft || profileDraftFromConfig(state.config, runtime.activeTemplate)),
        colorHex: hex,
      });
      document.querySelectorAll("[data-onb-palette-color]").forEach(item => item.classList.remove("border-gray-900", "ring-2", "ring-gray-900/10"));
      button.classList.add("border-gray-900", "ring-2", "ring-gray-900/10");
      toast(`Color institucional: ${hex}`, "success", 2200);
    });
  });
}

// Sesión de Google + destino en una pantalla; avanzar exige ambas (ver
// advance-target en performAction).
function connectStep() {
  const authenticated = runtime.auth?.authenticated === true;
  const statusCls = authenticated ? "border-gray-900 bg-gray-50" : "border-amber-200 bg-amber-50 hover:border-amber-300";
  const iconCls = authenticated ? "text-gray-900" : "text-amber-600";

  const setup    = runtime.setup || {};
  const skillReady = !!(setup.skill_installed && setup.skill_current);
  const selected = runtime.status.selectedTarget || state.config.onboardingTarget || "claude-code";

  // Cada destino nombra la plataforma porque usa un formato de instalación
  // distinto y el usuario debe saber exactamente cuál está preparando.
  const targets = [
    { id: "claude-code",    title: "Usar con Claude Code",          icon: "terminal",       desc: "Instala y conecta Jintia para Claude Code." },
    { id: "openai",         title: "Usar con ChatGPT y Codex",      icon: "sparkles",       desc: "Instala el plugin universal para ChatGPT desktop, Codex CLI y Codex en la app." },
    { id: "both",           title: "Usar en todos",                 icon: "laptop",         desc: "Prepara Jintia para Claude Code, ChatGPT y Codex en el mismo equipo." },
  ];

  let allReady = false;
  let actions  = "";

  if (selected === "claude-code") {
    allReady = !!(skillReady && setup.mcp_claude_code_configured);
    actions  = actionButton(setup.skill_installed ? "Actualizar skill" : "Instalar skill", "install-local", skillReady, true) +
               actionButton("Conectar con Claude Code", "configure-code", !skillReady || setup.mcp_claude_code_configured, true);

  } else if (selected === "openai") {
    allReady = !!setup.openai_plugin_current;
    actions  = actionButton(
      openaiPluginLabel(setup),
      "install-openai",
      setup.openai_plugin_current,
      true
    );
  } else { // all
    allReady = !!(skillReady && setup.mcp_claude_code_configured && setup.openai_plugin_current);
    actions  = actionButton(setup.skill_installed ? "Actualizar (proyecto local)" : "Instalar (proyecto local)", "install-local", skillReady, true) +
               actionButton(openaiPluginLabel(setup), "install-openai", setup.openai_plugin_current, true) +
               actionButton("Conectar con Claude Code", "configure-code", !setup.skill_installed || setup.mcp_claude_code_configured, true);
  }

  setFooter("Continuar al paso final", "advance-target", !authenticated || !allReady);
  return `<section class="grid w-full gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] xl:items-start">
    <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div class="flex items-center justify-between gap-2 mb-3">
        <h3 class="text-[11.5px] font-bold uppercase tracking-wide text-gray-400">Fuentes del curso</h3>
        <img src="${notebookLmWordmark}" alt="NotebookLM" class="h-4 w-auto shrink-0">
      </div>
      ${authenticated
        ? `<button class="flex items-center gap-3 w-full p-3.5 rounded-xl border border-gray-900 bg-gray-50 text-left cursor-pointer transition-colors" data-onboarding-action="verify-auth" title="Volver a verificar">
             <span class="text-gray-900 flex-shrink-0">${ic("check-circle-2", 18)}</span>
             <span class="flex flex-col gap-0.5 flex-1 min-w-0">
               <strong class="text-gray-900 text-sm">Sesión verificada</strong>
               <span class="text-gray-500 text-xs">${escapeHtml(runtime.auth?.message || "Conectado a NotebookLM.")}</span>
             </span>
             <span class="text-xs text-gray-400 flex-shrink-0 flex items-center gap-1">${ic("refresh-cw", 13)} Volver a verificar</span>
           </button>`
        : `<div class="flex items-center gap-3 w-full p-3.5 rounded-xl border border-amber-200 bg-amber-50">
             <span class="text-amber-600 flex-shrink-0">${ic("lock-keyhole", 18)}</span>
             <span class="flex flex-col gap-0.5 flex-1 min-w-0">
               <strong class="text-gray-900 text-sm">Sesión pendiente</strong>
               <span class="text-gray-500 text-xs">${escapeHtml(runtime.auth?.message || "Inicia sesión con Google para continuar.")}</span>
             </span>
           </div>`
      }
      ${!authenticated && !["working", "checking"].includes(runtime.authOperation.state)
        ? `<div class="flex justify-center mt-3">${actionButton(runtime.authOperation.state === "error" || runtime.authOperation.state === "cancelled" ? "Reintentar conexión" : "Iniciar sesión con Google", "start-auth", false, true, `<img src="${googleGLogo}" alt="" class="w-4 h-4">`)}</div>`
        : ""}
      ${operationPanelMarkup(runtime.authOperation, "notebooklm-auth")}
    </div>

    <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h3 class="text-[11.5px] font-bold uppercase tracking-wide text-gray-400 mb-3">Dónde trabajarás</h3>
      <div class="grid gap-2">
        ${targets.map(t => `
          <label class="flex items-start sm:items-center gap-3 p-3.5 rounded-xl border cursor-pointer ${t.id === selected ? "border-gray-900 bg-gray-50" : "border-gray-200 bg-white"}">
            <input type="radio" class="accent-gray-900 flex-shrink-0 mt-1 sm:mt-0" name="onboarding-target" value="${t.id}" ${t.id === selected ? "checked" : ""}>
            <span class="flex-shrink-0 text-gray-500">${ic(t.icon, 18)}</span>
            <span class="flex-1 min-w-0 flex flex-col gap-0.5"><strong class="text-gray-900 text-sm">${t.title}</strong><small class="text-gray-500 text-xs leading-snug">${t.desc}</small></span>
            <span class="flex-shrink-0 ${targetReady(t.id) ? "text-green-600" : "text-gray-300"}">${ic(targetReady(t.id) ? "check-circle-2" : "circle", 18)}</span>
          </label>`).join("")}
      </div>

      <div class="mt-4 flex justify-center flex-wrap gap-2">${actions}</div>
      ${operationPanelMarkup(runtime.targetOperation, "assistant-target")}
      ${selected === "openai" || selected === "both" ? `<p class="mt-3 text-xs leading-relaxed text-gray-500"><strong>ChatGPT y Codex:</strong> reinicia ChatGPT después de instalar y activa Jintia desde Plugins. Su disponibilidad puede depender del plan y la política del workspace.</p>` : ""}
      <div class="${INLINE_ERROR}" id="onb-target-message" hidden></div>
    </div>
  </section>`;
}

function finalStep() {
  const config = state.config || {};
  const setup  = runtime.setup || {};
  const target = runtime.status?.selectedTarget || config.onboardingTarget || "claude-code";
  const targetLabel = { "claude-code": "Usar con Claude Code", "openai": "Usar con ChatGPT y Codex", "both": "Usar en todos" }[target] || target;
  const skillReady = !!(setup.skill_installed && setup.skill_current);

  const connectionChecks = {
    "claude-code": [
      { label: "Skill local actualizada", ok: skillReady },
      { label: "Proyecto local conectado", ok: setup.mcp_claude_code_configured },
    ],
    openai: [
      { label: "Plugin ChatGPT/Codex preparado", ok: setup.openai_plugin_current },
    ],
    both: [
      { label: "Skill local actualizada", ok: skillReady },
      { label: "Proyecto local conectado", ok: setup.mcp_claude_code_configured },
      { label: "Plugin ChatGPT/Codex preparado", ok: setup.openai_plugin_current },
    ],
  };
  const checks = [
    { label: "Dependencias",        ok: runtime.dependencies.filter(d => d.required).every(d => d.installed) },
    { label: "Perfil institucional", ok: !!(config.author && config.institution) },
    { label: "Plantilla activa",     ok: !!runtime.activeTemplate },
    { label: "Sesión de Google",     ok: runtime.auth?.authenticated === true },
    ...(connectionChecks[target] || connectionChecks["claude-code"]),
  ];

  setFooter("Crear mi primera asignatura", "complete-create", true);
  return `<section>
    <div id="final-gen-area" class="mx-auto mb-6 w-full max-w-4xl">

      <!-- Carga (visible al inicio) -->
      <div id="final-loading" class="flex flex-col items-center gap-4 py-6">

        <!-- Spinner concéntrico animado -->
        <div class="relative w-[72px] h-[72px]">
          <div class="absolute inset-0 rounded-full border-[3px] border-transparent border-t-gray-900 animate-spin"></div>
          <div class="absolute inset-[9px] rounded-full border-[3px] border-transparent border-t-gray-400 [animation:spin_0.85s_linear_infinite_reverse]"></div>
          <div class="absolute inset-[18px] rounded-full bg-gray-100 flex items-center justify-center">
            <span id="gen-center-icon" class="text-gray-900">${ic("sparkles", 18)}</span>
          </div>
        </div>

        <div id="final-loading-msg" role="status" aria-live="polite" class="text-[15px] font-bold text-gray-800 text-center">Preparando la prueba…</div>
        <p class="text-xs text-gray-500 text-center -mt-2">Puedes seguir el avance sin abrir los detalles técnicos.</p>

        <!-- Barra de progreso -->
        <div class="w-full max-w-xs h-[3px] rounded-full bg-gray-200 overflow-hidden">
          <div id="gen-progress-fill" class="h-full w-0 rounded-full bg-gray-900 transition-[width] duration-500"></div>
        </div>

        <div id="final-loading-steps" class="grid w-full max-w-sm grid-cols-5 gap-1" aria-label="Progreso de la prueba">
          <div class="final-check-row flex min-w-0 flex-col items-center gap-1 text-center text-xs font-medium text-gray-500 opacity-30" data-check="0">
            <span class="flex h-7 w-7 items-center justify-center rounded-full border border-gray-200 bg-white" data-check-icon>${ic("hourglass", 15)}</span>
            <span>Validar</span>
          </div>
          <div class="final-check-row flex min-w-0 flex-col items-center gap-1 text-center text-xs font-medium text-gray-500 opacity-30" data-check="1">
            <span class="flex h-7 w-7 items-center justify-center rounded-full border border-gray-200 bg-white" data-check-icon>${ic("hourglass", 15)}</span>
            <span>Renderizar</span>
          </div>
          <div class="final-check-row flex min-w-0 flex-col items-center gap-1 text-center text-xs font-medium text-gray-500 opacity-30" data-check="2">
            <span class="flex h-7 w-7 items-center justify-center rounded-full border border-gray-200 bg-white" data-check-icon>${ic("hourglass", 15)}</span>
            <span>Vivliostyle</span>
          </div>
          <div class="final-check-row flex min-w-0 flex-col items-center gap-1 text-center text-xs font-medium text-gray-500 opacity-30" data-check="3">
            <span class="flex h-7 w-7 items-center justify-center rounded-full border border-gray-200 bg-white" data-check-icon>${ic("hourglass", 15)}</span>
            <span>PDF</span>
          </div>
          <div class="final-check-row flex min-w-0 flex-col items-center gap-1 text-center text-xs font-medium text-gray-500 opacity-30" data-check="4">
            <span class="flex h-7 w-7 items-center justify-center rounded-full border border-gray-200 bg-white" data-check-icon>${ic("hourglass", 15)}</span>
            <span>Listo</span>
          </div>
        </div>

        <details id="compile-monitor" class="w-full max-w-sm overflow-hidden rounded-xl border border-gray-200 bg-white text-left">
          <summary class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs font-semibold text-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
            <span class="flex items-center gap-2">
              <span class="text-gray-500">${ic("terminal", 15)}</span>
              Ver detalles técnicos
            </span>
            <span id="compile-elapsed" class="font-mono text-xs tabular-nums text-gray-500">00:00</span>
          </summary>
          <div class="border-t border-gray-100 px-3 pb-3 pt-2.5">
            <div id="compile-current" class="mb-2 text-xs font-medium text-gray-600">Esperando al compilador…</div>
            <pre id="compile-live-log" aria-live="polite" class="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-950 px-3 py-2.5 font-mono text-xs leading-relaxed text-gray-200">La actividad aparecerá aquí.</pre>
            <button type="button" id="btn-copy-live-diagnostic" class="mt-2 inline-flex min-h-11 items-center gap-1.5 border-0 bg-transparent p-0 text-xs font-semibold text-gray-500 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
              ${ic("copy", 14)}
              Copiar actividad
            </button>
          </div>
        </details>
      </div>

      <!-- Resultado — aparece solo tras éxito o fallo definitivo -->
      <div id="final-result-wrap" class="hidden">
        <div id="final-result-content"></div>
      </div>
    </div>

  </section>`;
}

async function animateFinalStep() {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const checkRows = document.querySelectorAll(".final-check-row");
  const msgEl     = document.getElementById("final-loading-msg");
  const fillEl    = document.getElementById("gen-progress-fill");
  const compileLogEl = document.getElementById("compile-live-log");
  const compileCurrentEl = document.getElementById("compile-current");
  const compileElapsedEl = document.getElementById("compile-elapsed");
  const compileDiagnostics = [];
  const compileStartedAt = Date.now();

  function formatElapsed(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function diagnosticText(error = "") {
    return [
      `${APP_META.desktopName} — diagnóstico de compilación`,
      `Fecha: ${new Date().toISOString()}`,
      `Skill: ${APP_META.skillVersion}`,
      `Plantilla: ${runtime.activeTemplate || "no identificada"}`,
      `Sistema: ${navigator.userAgent}`,
      error ? `Error final:\n${error}` : "",
      "Actividad:",
      compileDiagnostics.length ? compileDiagnostics.join("\n") : "Sin actividad registrada.",
    ].filter(Boolean).join("\n\n");
  }

  document.getElementById("btn-copy-live-diagnostic")?.addEventListener("click", () => {
    navigator.clipboard.writeText(diagnosticText()).then(() => toast("Actividad copiada", "success", 3000));
  });

  function setProgress(pct) {
    if (fillEl) fillEl.style.width = `${pct}%`;
  }

  function setRow(i, rowState) {
    if (!checkRows[i]) return;
    const row  = checkRows[i];
    const icon = row.querySelector("[data-check-icon]");
    row.style.opacity = "1";
    row.style.transition = reduceMotion ? "none" : "opacity .3s, color .3s";
    if (rowState === "active") {
      row.style.color  = "#111827";
      icon.innerHTML = ic("loader-2", 15);
      icon.style.animation = reduceMotion ? "none" : "spin .7s linear infinite";
      icon.style.background = "#111827";
      icon.style.borderColor = "#111827";
      icon.style.color = "#ffffff";
    } else if (rowState === "done") {
      row.style.color  = "#16a34a";
      icon.innerHTML = ic("check-circle-2", 15);
      icon.style.animation = "none";
      icon.style.background = "#f0fdf4";
      icon.style.borderColor = "#86efac";
      icon.style.color = "#16a34a";
    } else if (rowState === "error") {
      row.style.color  = "#ef4444";
      icon.innerHTML = ic("circle-x", 15);
      icon.style.animation = "none";
      icon.style.background = "#fef2f2";
      icon.style.borderColor = "#fca5a5";
      icon.style.color = "#ef4444";
    }
    refreshIcons();
  }

  function setMsg(msg) {
    if (!msgEl) return;
    msgEl.style.opacity = "0";
    msgEl.style.transition = reduceMotion ? "none" : "opacity .2s";
    setTimeout(() => {
      msgEl.textContent = msg;
      msgEl.style.opacity = "1";
    }, reduceMotion ? 0 : 150);
  }

  function showError(title, detail, errStr) {
    const loadingEl = document.getElementById("final-loading");
    const wrapEl    = document.getElementById("final-result-wrap");
    const contentEl = document.getElementById("final-result-content");
    if (loadingEl) loadingEl.style.display = "none";
    if (contentEl) contentEl.innerHTML = `
      <div class="border-[1.5px] border-red-300/60 rounded-xl p-6 text-center bg-red-50/60">
        <span class="text-red-500 block mb-2.5">${ic("circle-alert", 36)}</span>
        <div class="text-[15px] font-bold text-red-500 mb-1.5">${escapeHtml(title)}</div>
        <div class="text-[12.5px] text-gray-700 mb-3">${escapeHtml(detail)}</div>
        ${errStr ? `
          <details class="mb-3.5 overflow-hidden rounded-lg border border-red-200 bg-white/70 text-left">
            <summary class="cursor-pointer px-3 py-2 text-[11px] font-semibold text-gray-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500">Ver detalles técnicos</summary>
            <pre class="m-0 max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words border-t border-red-100 bg-gray-950 px-3 py-2.5 font-mono text-[10px] leading-relaxed text-gray-200">${escapeHtml(errStr)}</pre>
          </details>` : ""}
        <div class="flex justify-center gap-2 flex-wrap">
          <button class="${BTN_SECONDARY} text-[12.5px]" id="btn-retry-gen">
            ${ic("refresh-cw", 15)} Reintentar verificación
          </button>
          <button class="${BTN_SECONDARY} text-[12.5px]" id="btn-back-to-tools">
            ${ic("terminal", 15)} Volver a herramientas
          </button>
          <button class="${BTN_SECONDARY} text-[12.5px]" id="btn-copy-compile-report">
            ${ic("copy", 15)} Copiar diagnóstico
          </button>
          <button class="${BTN_SECONDARY} text-[12.5px]" id="btn-report-compile-error">
            ${ic("bug", 15)} Reportar problema
          </button>
        </div>
      </div>`;
    refreshIcons();
    if (wrapEl) {
      wrapEl.style.display = "block";
      wrapEl.style.opacity = "0";
      wrapEl.style.transition = reduceMotion ? "none" : "opacity .35s";
      if (reduceMotion) wrapEl.style.opacity = "1";
      else requestAnimationFrame(() => { wrapEl.style.opacity = "1"; });
    }
    document.getElementById("btn-retry-gen")?.addEventListener("click", () => {
      if (wrapEl) wrapEl.style.display = "none";
      if (loadingEl) {
        loadingEl.style.display = "flex";
        checkRows.forEach((r, i) => {
          r.style.opacity = i <= 1 ? "1" : ".3";
          r.style.color = "";
          const badge = r.querySelector("[data-check-icon]");
          badge.innerHTML = i <= 1 ? ic("check-circle-2", 15) : ic("hourglass", 15);
          if (i === 1) badge.style.color = "#16a34a";
        });
        refreshIcons();
        if (fillEl) fillEl.style.width = "25%";
      }
      void runOnboardingOperation(
        "Reintentando la prueba final…",
        animateFinalStep,
      );
    });
    document.getElementById("btn-back-to-tools")?.addEventListener("click", () => {
      void runOnboardingOperation("Abriendo el paso de herramientas…", async () => {
        const result = await goToOnboardingStep(2);
        if (result.success) {
          runtime.status = result.status;
          await showPreparedStep(5, 2);
        } else toast(result.message, "error");
      });
    });
    document.getElementById("btn-copy-compile-report")?.addEventListener("click", () => {
      navigator.clipboard.writeText(diagnosticText(errStr)).then(() => {
        toast("Diagnóstico copiado; puedes adjuntarlo al reporte", "success", 4500);
      });
    });
    document.getElementById("btn-report-compile-error")?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(diagnosticText(errStr));
      await openExternal(APP_META.issues);
      toast("Diagnóstico copiado para pegarlo en el reporte", "success", 5000);
    });
    syncOnboardingBusyState();
  }

  function showSuccess(basePath, message, pdfPath) {
    const loadingEl = document.getElementById("final-loading");
    const wrapEl    = document.getElementById("final-result-wrap");
    const contentEl = document.getElementById("final-result-content");
    if (loadingEl) loadingEl.style.display = "none";
    if (contentEl) contentEl.innerHTML = renderSyllabusDoc(pdfPath, message);
    refreshIcons();
    if (wrapEl) {
      wrapEl.style.display = "block";
      wrapEl.style.opacity = "0";
      wrapEl.style.transition = "opacity .4s";
      requestAnimationFrame(() => { wrapEl.style.opacity = "1"; });
    }
    document.querySelector("[data-onboarding-action='complete-create']").disabled = false;

    const assetUrl = convertFileSrc(pdfPath);
    document.getElementById("btn-open-pdf")?.addEventListener("click", () => window.open(assetUrl));
    document.getElementById("btn-copy-pdf-path")?.addEventListener("click", () => {
      navigator.clipboard.writeText(pdfPath).then(() => toast("Ruta copiada", "success", 3000));
    });
    syncOnboardingBusyState();
  }

  function renderSyllabusDoc(pdfPath, message) {
    const assetUrl = convertFileSrc(pdfPath);
    return `
      <div class="flex flex-col gap-4">
        <div class="flex items-start gap-3 p-4 rounded-xl bg-green-50 border border-green-200">
          <span class="text-green-600 flex-shrink-0">${ic("check-circle-2", 24)}</span>
          <div>
            <div class="font-bold text-green-600 mb-1">Documento compilado exitosamente</div>
            <div class="text-[12.5px] text-gray-700">${escapeHtml(message)}</div>
          </div>
        </div>
        <div class="border-[1.5px] border-gray-200 rounded-xl overflow-hidden bg-white">
          <iframe src="${escapeHtml(assetUrl)}" class="w-full h-[500px] border-0 block"></iframe>
        </div>
        <div class="flex gap-2">
          <button class="${BTN_SECONDARY} flex-1" id="btn-open-pdf">
            ${ic("external-link", 15)} Abrir en otra pestaña
          </button>
          <button class="${BTN_SECONDARY} flex-1" id="btn-copy-pdf-path">
            ${ic("copy", 15)} Copiar ruta
          </button>
        </div>
        <div class="text-[11px] text-gray-400 p-3 bg-black/[0.03] rounded-lg break-all">
          <strong>Archivo:</strong> ${escapeHtml(pdfPath)}
        </div>
      </div>
    `;
  }

  function showReadySuccess(syllabusPath) {
    const loadingEl = document.getElementById("final-loading");
    const wrapEl    = document.getElementById("final-result-wrap");
    const contentEl = document.getElementById("final-result-content");
    if (loadingEl) loadingEl.style.display = "none";
    const target = runtime.status?.selectedTarget || state.config.onboardingTarget || "claude-code";
    const integrationLabel = ({ "claude-code": "Claude Code", openai: "ChatGPT y Codex", both: "Claude Code, ChatGPT y Codex" })[target] || target;
    if (contentEl) contentEl.innerHTML = `
      <div class="border-[1.5px] border-green-300/60 rounded-xl p-6 text-center bg-green-50/60">
        <span class="text-green-600 block mb-2.5">${ic("check-circle-2", 36)}</span>
        <div class="text-[15px] font-bold text-green-600 mb-1.5">Todo listo para crear tu primera asignatura</div>
        <div class="text-[12.5px] text-gray-700 mb-3">El entorno Jintia, el renderizado, la generación PDF y tus integraciones superaron la comprobación.</div>
        <ul class="mx-auto mb-3 max-w-sm space-y-2 text-left text-xs text-gray-700">
          ${["Entorno privado de Jintia", "Renderizado de la guía", "Generación de PDF", `Integraciones: ${integrationLabel}`].map(label => `<li class="flex items-center gap-2">${ic("check", 14)}<span>${escapeHtml(label)}</span></li>`).join("")}
        </ul>
        <details class="mx-auto max-w-sm rounded-lg border border-green-200 bg-white/70 text-left"><summary class="min-h-11 cursor-pointer px-3 py-3 text-xs font-semibold text-gray-700">Detalles técnicos</summary><pre class="m-0 whitespace-pre-wrap break-words border-t border-green-100 p-3 text-xs text-gray-600">${escapeHtml(JSON.stringify(selfTest?.checks || {}, null, 2))}</pre></details>
        ${syllabusPath ? `<div class="text-[11px] text-gray-400 p-3 bg-black/[0.03] rounded-lg break-all text-left"><strong>Sílabo generado:</strong> ${escapeHtml(syllabusPath)}</div>` : ""}
        <button type="button" class="${BTN_SECONDARY} mt-3" data-onboarding-action="complete-dashboard">Ir al panel</button>
      </div>`;
    refreshIcons();
    if (wrapEl) {
      wrapEl.style.display = "block";
      wrapEl.style.opacity = "0";
      wrapEl.style.transition = "opacity .4s";
      requestAnimationFrame(() => { wrapEl.style.opacity = "1"; });
    }
    document.querySelector("[data-onboarding-action='complete-create']").disabled = false;
    document.querySelector("[data-onboarding-action='complete-dashboard']")?.addEventListener("click", () => handleAction("complete-dashboard", 5));
    syncOnboardingBusyState();
  }

  // ── self-test unificado via jintia self-test --json ───────────────────
  setRow(0, "active");
  setMsg("Ejecutando prueba de entorno Jintia…");
  setProgress(10);

  let selfTest;
  try {
    selfTest = await runSkillSelfTest();
  } catch (err) {
    selfTest = { ok: false, error: String(err) };
  }

  compileDiagnostics.push(`self-test: ${JSON.stringify(selfTest)}`);

  const checks = selfTest?.checks ?? {};
  const checkNames = ["validate", "render", "vivliostyle", "pdf"];
  const rowMap = { validate: 0, render: 1, vivliostyle: 2, pdf: 3 };

  // Animar filas según resultado de cada check
  for (const key of checkNames) {
    const rowIdx = rowMap[key];
    if (rowIdx === undefined) continue;
    if (checks[key] === "passed") {
      setRow(rowIdx, "done");
    } else if (checks[key] !== undefined) {
      setRow(rowIdx, "error");
    }
  }
  setProgress(90);

  if (!selfTest?.ok) {
    const vivliostyleMsg = checks.vivliostyle === "not_installed"
      ? "Vivliostyle CLI no está instalado. Instálalo desde el paso de herramientas y vuelve a intentar."
      : "La prueba de entorno falló. Revisa las herramientas instaladas.";
    showError(
      "Prueba de entorno fallida",
      vivliostyleMsg,
      selfTest?.error ?? JSON.stringify(checks)
    );
    return;
  }

  setRow(4, "active");
  setProgress(96);
  await new Promise(r => setTimeout(r, 300));

  try {
    await saveSelfTestResult({
      skillVersion: "",
      desktopVersion: "",
      mcpVersion: "",
      nodeVersion: selfTest?.nodeVersion ?? "",
      vivliostyleVersion: selfTest?.vivliostyleVersion ?? selfTest?.checks?.vivliostyleVersion ?? "",
      profileId: state.config?.discipline ?? "",
      selectedTarget: "",
      passed: true,
      timestamp: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    console.warn("No se pudo persistir el resultado de la prueba final:", err);
  }

  setRow(4, "done");
  setProgress(100);
  setMsg("¡Listo!");
  showReadySuccess(null);
}


function bindStepEvents(current) {
  const root = document.getElementById("onboarding-root");
  root.querySelector("#onb-color")?.addEventListener("input", event => {
    if (!/^#[0-9a-fA-F]{6}$/.test(event.target.value)) return;
    const preview = root.querySelector("#onb-color-preview");
    const label = root.querySelector("#onb-color-label");
    if (preview) preview.style.background = event.target.value;
    if (label) label.textContent = event.target.value;
  });
  if (current === 1) {
    root.querySelector("#onb-change-workspace")?.addEventListener("click", async () => {
      let defaultPath = state.config.courseRoot;
      if (!defaultPath) {
        const result = await getDefaultCourseRoot().catch(() => null);
        defaultPath = result?.path || undefined;
      }
      const picked = await pickDirectory("Elige la carpeta de trabajo de Jintia", defaultPath);
      if (picked) {
        state.config.courseRoot = picked;
        saveConfig();
        const label = root.querySelector("#onb-workspace-label");
        if (label) label.textContent = picked;
      }
    });
  }
  if (current === 3) {
    const fieldMap = {
      "onb-website": "website", "onb-institution": "institution", "onb-faculty": "faculty",
      "onb-career": "career", "onb-author": "author", "onb-degree": "degree",
      "onb-discipline": "discipline", "onb-color": "colorHex",
    };
    Object.entries(fieldMap).forEach(([id, key]) => {
      const control = root.querySelector(`#${id}`);
      const remember = () => {
        runtime.profileDraft = persistProfileDraft(localStorage, {
          ...(runtime.profileDraft || profileDraftFromConfig(state.config, runtime.activeTemplate)),
          [key]: control.value,
        });
        const error = root.querySelector(`#${id}-error`);
        if (error && String(control.value).trim()) error.hidden = true;
      };
      control?.addEventListener("input", remember);
      control?.addEventListener("change", remember);
    });
    root.querySelector("#onb-extract-palette")?.addEventListener("click", () => runOnboardingOperation(
      "Analizando el sitio institucional…",
      analyzeInstitutionWebsite,
    ));
    bindOnboardingPaletteButtons();
  }
  if (current === 5) {
    setTimeout(() => {
      void runOnboardingOperation(
        "Ejecutando la prueba final…",
        animateFinalStep,
      );
    }, 0);
  }
  root.querySelectorAll("[data-onboarding-step]").forEach(button => button.addEventListener("click", async () => {
    const dest = Number(button.dataset.onboardingStep);
    await runOnboardingOperation(`Abriendo el paso ${dest}…`, async () => {
      const dest = Number(button.dataset.onboardingStep);
      const result = await goToOnboardingStep(dest);
      if (result.success) {
        runtime.status = result.status;
        await showPreparedStep(current, dest);
      } else toast(result.message, "error");
    });
  }));
  root.querySelectorAll("[data-install-dependency]").forEach(button => button.addEventListener("click", () => requestDependencyInstall(button.dataset.installDependency, button)));
  root.querySelectorAll("[data-show-capability-details]").forEach(button => button.addEventListener("click", () => {
    const details = root.querySelector(`#capability-detail-${CSS.escape(button.dataset.showCapabilityDetails)}`);
    if (details) {
      details.open = true;
      details.querySelector("summary")?.focus();
    }
  }));
  root.querySelectorAll("[data-onboarding-dep-step]").forEach(dot => dot.addEventListener("click", () => {
    if (onboardingActionInFlight) return;
    const toolIndex = Number(dot.dataset.depStepIndex);
    if (current === 2) {
      moveDependencyFocus(toolIndex);
      return;
    }
    void runOnboardingOperation(`Abriendo el paso 2…`, () => jumpToDependencyTool(current, toolIndex));
  }));
  root.querySelectorAll("[data-template-id]").forEach(button => button.addEventListener("click", () => {
    if (onboardingActionInFlight) return;
    runtime.activeTemplate = button.dataset.templateId;
    runtime.profileDraft = persistProfileDraft(localStorage, {
      ...(runtime.profileDraft || profileDraftFromConfig(state.config, runtime.activeTemplate)),
      templateId: runtime.activeTemplate,
    });
    renderCurrentStep();
  }));
  root.querySelectorAll("input[name=onboarding-target]").forEach(input => input.addEventListener("change", event => {
    if (onboardingActionInFlight) return;
    const selectedTarget = event.currentTarget.value;
    state.config.onboardingTarget = selectedTarget;
    // connectStep prioriza el estado recibido del backend. Sincronizarlo aquí
    // evita que el siguiente render vuelva a marcar el destino predeterminado.
    runtime.status = {
      ...(runtime.status || {}),
      selectedTarget,
    };
    saveConfig();
    renderCurrentStep();
  }));
  root.querySelectorAll("[data-onboarding-action]").forEach(button => button.addEventListener("click", () => handleAction(button.dataset.onboardingAction, current)));
}

function dependencyInstallConfirmMessage(name) {
  return `Jintia instalará ${name} dentro de su entorno privado. No modificará la instalación global de tu sistema. ¿Continuar?`;
}

// Diálogo de confirmación propio del onboarding: la app no tiene barra de
// título del sistema (ventana sin marco), así que un confirm() nativo de
// Tauri se ve como una ventana ajena flotando encima. Este vive dentro del
// mismo #onboarding-root, con el estilo del resto de la app.
function confirmInOnboarding(message) {
  return new Promise(resolve => {
    const root = document.getElementById("onboarding-root");
    if (!root) {
      resolve(false);
      return;
    }
    const opener = document.activeElement;
    const background = root.querySelector("main");
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/45 px-6" role="alertdialog" aria-modal="true" aria-labelledby="onboarding-confirm-message">
        <div class="w-full max-w-sm rounded-xl bg-white border border-gray-200 shadow-2xl p-5 animate-[fade-in-up_0.2s_ease-out_forwards]">
          <p id="onboarding-confirm-message" class="text-sm text-gray-700 leading-relaxed">${escapeHtml(message)}</p>
          <div class="mt-4 flex justify-end gap-2">
            <button type="button" class="${BTN_SECONDARY}" data-onboarding-confirm="cancel">Cancelar</button>
            <button type="button" class="${BTN_PRIMARY} !w-auto h-9 px-4" data-onboarding-confirm="ok">Continuar</button>
          </div>
        </div>
      </div>`;
    const overlay = wrapper.firstElementChild;
    root.appendChild(overlay);
    if (background) background.inert = true;

    const cleanup = value => {
      overlay.removeEventListener("keydown", onKeydown);
      overlay.remove();
      if (background) background.inert = false;
      opener?.focus?.();
      resolve(value);
    };
    const onKeydown = event => {
      if (event.key === "Escape") cleanup(false);
      if (event.key === "Tab") {
        const controls = [...overlay.querySelectorAll("button:not([disabled])")];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    overlay.querySelector('[data-onboarding-confirm="cancel"]').addEventListener("click", () => cleanup(false));
    overlay.querySelector('[data-onboarding-confirm="ok"]').addEventListener("click", () => cleanup(true));
    overlay.addEventListener("keydown", onKeydown);
    overlay.querySelector('[data-onboarding-confirm="ok"]').focus();
  });
}

// Punto único de entrada para instalar una dependencia: nunca instala sin
// que el usuario lo autorice explícitamente en este diálogo, sin importar
// si es una descarga grande (MiKTeX) o liviana (Node, Git, Python).
async function requestDependencyInstall(name, button) {
  if (onboardingActionInFlight) return;
  const confirmed = await confirmInOnboarding(dependencyInstallConfirmMessage(name));
  if (!confirmed) return;
  await runOnboardingOperation(`Instalando ${name}…`, () => performDependencyInstall(name));
}

function updateDependencyOperation(name, patch) {
  const dep = runtime.dependencies.find(item => item.name === name || item.id === name);
  const id = dep?.id || name;
  const previous = runtime.dependencyOperations.get(id) || createOperationState({ id, title: `Preparar ${dep?.label || name}` });
  const next = { ...previous, ...patch, id, startedAt: previous.startedAt || patch.startedAt || Date.now() };
  runtime.dependencyOperations.set(id, next);
  const panel = document.querySelector(`[data-operation-panel="dependency-${CSS.escape(id)}"]`);
  if (panel) panel.outerHTML = operationPanelMarkup(next, `dependency-${id}`);
  refreshIcons();
  return next;
}

async function installAllNeeded() {
  const pending = installableBlockingCapabilities(runtime.dependencies);
  if (!pending.length) return;
  const confirmed = await confirmInOnboarding(`Se instalarán ${pending.length} componentes dentro del entorno privado de Jintia, uno por uno. No se modificará Node ni Python global. ¿Continuar?`);
  if (!confirmed) return;
  await runOnboardingOperation("Preparando todas las herramientas necesarias…", async () => {
    for (const capability of pending) {
      const current = runtime.dependencies.find(item => item.id === capability.id);
      if (!current || current.status === "ready" || runtime.dependencyOperations.get(current.id)?.state === "working") continue;
      const result = await performDependencyInstall(current.name);
      if (!result?.success) break;
    }
  });
}

async function performDependencyInstall(name, externalReporter = null) {
  const reporter = payload => {
    const progress = updateDependencyOperation(name, {
      state: "working",
      message: payload.message || `Preparando ${name}…`,
      percent: payload.percent,
    });
    externalReporter?.(progress);
  };
  updateDependencyOperation(name, { state: "working", message: `Preparando ${name}…`, percent: null, technicalDetail: "" });
  let result;
  try {
    if (name === "Node.js") {
      result = await withDependencyProgress(name, listen, () => downloadNodeRuntime(), reporter);
      if (result.success) {
        // Hacer visible el cambio de etapa antes de que llegue su primer evento.
        reporter({ message: "Instalando Vivliostyle CLI…", percent: null });
        onboardingBusyMessage = "Instalando Vivliostyle CLI…";
        syncOnboardingBusyState();
      }
      result = await runSecondaryStage(
        result,
        () => withDependencyProgress(
          "Vivliostyle CLI",
          listen,
          () => installVivliostyleCli(),
          reporter
        )
      );
    } else if (name === "Python") {
      result = await withDependencyProgress(name, listen, () => downloadPythonRuntime(), reporter);
    } else if (name === "Vivliostyle CLI") {
      result = await withDependencyProgress(name, listen, () => installVivliostyleCli(), reporter);
    } else if (name === "Jintia Skill") {
      result = await withDependencyProgress(name, listen, () => downloadSkillRuntime(), reporter);
    } else if (name === "NotebookLM MCP") {
      result = await withDependencyProgress(name, listen, () => installNotebookLmMcpRuntime(), reporter);
    } else {
      result = await withDependencyProgress(name, listen, () => installDependency(name, true), reporter);
    }
  } catch (e) {
    result = operationFailureResult(e);
  }
  // La autoridad definitiva es checkDependencies(); solo Python concilia con ese snapshot.
  // Si el antivirus escanea el binario recién instalado puede bloquearlo unos segundos;
  // se reintenta una vez antes de declarar fallo.
  let freshDeps = normalizeCapabilities(await checkDependencies());
  if (name === "Python" && result.success) {
    const pyDep = freshDeps.find(d => d.name === "Python");
    if (!pyDep || !pyDep.installed) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      freshDeps = normalizeCapabilities(await checkDependencies());
    }
  }
  if (name === "Python") {
    result = verifyPythonInstallResult(result, freshDeps);
  }
  runtime.dependencies = freshDeps;
  updateDependencyOperation(name, {
    state: result.success ? "success" : "error",
    message: result.message,
    percent: result.success ? 100 : null,
    technicalDetail: result.success ? "" : result.message,
  });
  toast(result.message, result.success ? "success" : "error", 9000);
  renderCurrentStep();
  return result;
}

async function installDisciplinePackages(reporter = null, disciplineOverride = null) {
  const discipline = disciplineOverride ?? state.config.discipline ?? "";

  if (!discipline) {
    return {
      discipline: "",
      profileId: null,
      pythonPackages: [],
      nodePackages: [],
    };
  }

  try {
    const caps = await getCapabilitiesProfiles();

    const profileId = caps?.disciplines?.[discipline];
    const profile = profileId
      ? (caps?.profiles?.[profileId] ?? {})
      : {};

    const pipPackages = profile?.python?.packages ?? [];
    const npmPackages = profile?.node?.packages ?? [];

    if (pipPackages.length > 0) {
      const pipResult = reporter
        ? await withDependencyProgress("Python", listen, () => installProfilePackages(pipPackages), reporter, GENERIC_DEPENDENCY_EVENT)
        : await installProfilePackages(pipPackages);

      if (!pipResult?.success) {
        return {
          discipline,
          profileId: profileId ?? null,
          pythonPackages: pipPackages,
          nodePackages: npmPackages,
          failedStage: "python",
          error: pipResult?.message || "No se pudieron instalar los paquetes Python del perfil.",
        };
      }
    }

    if (npmPackages.length > 0) {
      const npmResult = reporter
        ? await withDependencyProgress("Paquetes Node del perfil", listen, () => installNpmPackages(npmPackages), reporter)
        : await installNpmPackages(npmPackages);

      if (!npmResult?.success) {
        return {
          discipline,
          profileId: profileId ?? null,
          pythonPackages: pipPackages,
          nodePackages: npmPackages,
          failedStage: "node",
          error: npmResult?.message || "No se pudieron instalar los paquetes Node del perfil.",
        };
      }
    }

    const binaryIds = (profile?.binaries ?? []).map(b => b.id).filter(Boolean);

    if (binaryIds.length > 0) {
      const binResult = reporter
        ? await withDependencyProgress("Herramientas del perfil", listen, () => installProfileBinaries(binaryIds), reporter)
        : await installProfileBinaries(binaryIds);

      if (!binResult?.success) {
        return {
          discipline,
          profileId: profileId ?? null,
          pythonPackages: pipPackages,
          nodePackages: npmPackages,
          binaryIds,
          failedStage: "binaries",
          error: binResult?.message || "No se pudieron instalar las herramientas del perfil.",
        };
      }
    }

    return {
      discipline,
      profileId: profileId ?? null,
      pythonPackages: pipPackages,
      nodePackages: npmPackages,
      binaryIds: binaryIds.length > 0 ? binaryIds : undefined,
    };
  } catch (error) {
    console.warn(
      "No se pudieron completar todas las dependencias del perfil disciplinar:",
      error
    );

    return {
      discipline,
      profileId: null,
      pythonPackages: [],
      nodePackages: [],
      error: String(error),
    };
  }
}

function beginAuthElapsedClock() {
  clearInterval(runtime.authElapsedTimer);
  runtime.authElapsedTimer = setInterval(() => {
    const label = elapsedLabel(runtime.authOperation.startedAt);
    const element = document.querySelector('[data-operation-panel="notebooklm-auth"] [data-operation-elapsed]');
    if (element && label) {
      element.textContent = label;
      element.classList.remove("hidden");
    }
  }, 1000);
}

function refreshAuthOperationPanel() {
  const panel = document.querySelector('[data-operation-panel="notebooklm-auth"]');
  if (!panel) return;
  panel.outerHTML = operationPanelMarkup(runtime.authOperation, "notebooklm-auth");
  document.querySelector('[data-operation-panel="notebooklm-auth"] [data-onboarding-action="cancel-auth"]')
    ?.addEventListener("click", cancelNotebookLMAuthentication);
  refreshIcons();
}

async function startNotebookLMAuthentication() {
  if (["working", "checking"].includes(runtime.authOperation.state)) return;
  const operationId = globalThis.crypto?.randomUUID?.() || `notebooklm-${Date.now()}`;
  runtime.authOperation = createOperationState({
    id: operationId,
    state: "working",
    phase: "opening_browser",
    title: "Conectar NotebookLM",
    message: "Se abrirá una ventana de Google. Inicia sesión y vuelve a Jintia.",
    cancellable: true,
    browserOpen: true,
    startedAt: Date.now(),
  });
  renderCurrentStep();
  beginAuthElapsedClock();
  let unlisten = null;
  try {
    unlisten = await listen("notebooklm-auth-progress", ({ payload }) => {
      if (payload?.operationId !== operationId) return;
      runtime.authOperation = reduceOperationEvent(runtime.authOperation, payload);
      if (stepNumber() === 4) refreshAuthOperationPanel();
    });
    const result = await startNotebookLMAuth(operationId);
    if (result.success) {
      runtime.auth = { authenticated: true, message: result.message };
      rememberSuccessfulLoad("notebooklm-auth");
    }
    if (!["success", "error", "cancelled"].includes(runtime.authOperation.state)) {
      runtime.authOperation = {
        ...runtime.authOperation,
        state: result.success ? "success" : "error",
        phase: result.success ? "done" : "error",
        message: result.message,
        cancellable: false,
        browserOpen: false,
      };
    }
    toast(result.message, result.success ? "success" : "error", 9000);
  } catch (error) {
    runtime.authOperation = {
      ...runtime.authOperation,
      state: "error",
      phase: "error",
      message: "No se pudo completar la conexión. Comprueba la red y vuelve a intentarlo.",
      technicalDetail: String(error),
      cancellable: false,
      browserOpen: false,
    };
  } finally {
    unlisten?.();
    clearInterval(runtime.authElapsedTimer);
    runtime.authElapsedTimer = null;
    if (stepNumber() === 4) renderCurrentStep();
  }
}

async function cancelNotebookLMAuthentication() {
  const operationId = runtime.authOperation.id;
  if (!operationId || !runtime.authOperation.cancellable) return;
  runtime.authOperation = {
    ...runtime.authOperation,
    message: "Cancelando y cerrando el proceso de NotebookLM…",
    cancellable: false,
  };
  refreshAuthOperationPanel();
  const result = await cancelNotebookLMAuth(operationId);
  if (!result.success) {
    runtime.authOperation = {
      ...runtime.authOperation,
      state: "warning",
      message: result.message,
      technicalDetail: result.message,
    };
    renderCurrentStep();
  }
}

function updateProfilePackagesOperation(patch) {
  const previous = runtime.dependencyOperations.get("profile-packages") || createOperationState({
    id: "profile-packages",
    title: "Herramientas recomendadas",
  });
  const next = { ...previous, ...patch, startedAt: previous.startedAt || patch.startedAt || Date.now() };
  runtime.dependencyOperations.set("profile-packages", next);
  const panel = document.querySelector('[data-operation-panel="profile-packages"]');
  if (panel) panel.outerHTML = operationPanelMarkup(next, "profile-packages");
  refreshIcons();
}

async function prepareProfileTools() {
  const discipline = runtime.profileDraft?.discipline || "";
  if (!discipline) {
    const field = document.getElementById("onb-discipline");
    const error = document.getElementById("onb-discipline-error");
    if (error) { error.textContent = "Selecciona un área antes de preparar sus herramientas."; error.hidden = false; }
    field?.focus();
    return;
  }
  updateProfilePackagesOperation({ state: "working", message: "Resolviendo los paquetes del perfil…", percent: null });
  const profileResult = await installDisciplinePackages(progress => updateProfilePackagesOperation({
    state: "working",
    message: progress.message || "Instalando paquetes dentro de Jintia…",
    percent: progress.percent,
  }), discipline);
  const result = normalizeProfileInstallResult(profileResult);
  updateProfilePackagesOperation({
    state: result.success ? "success" : "error",
    message: result.message,
    percent: result.success ? 100 : null,
    technicalDetail: result.success ? "" : result.message,
  });
  toast(result.message, result.success ? "success" : "error", 7000);
}

// Dentro del paso 2, las flechas Atrás/Continuar del pie primero recorren
// las herramientas (sin tocar el backend) y solo al llegar al borde -primera
// o última- hacen lo que siempre hicieron: retroceder al paso 1 o avanzar al
// 3. Así la pista de abajo se siente como una sola secuencia continua.
async function handleAction(action, current) {
  if (action === "start-auth") return startNotebookLMAuthentication();
  if (action === "cancel-auth") return cancelNotebookLMAuthentication();
  if (action === "install-all-needed") return installAllNeeded();
  return runOnboardingOperation(
    actionBusyMessage(action, current),
    () => performAction(action, current),
  );
}

function setBusyState(button, busy, label = "") {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  const text = button.querySelector("span");
  if (text && busy) text.textContent = label;
  if (text && !busy) text.textContent = button.dataset.originalLabel || text.textContent;
}

const COMPLETION_FALLBACK = "Configuración completada. Abriendo el dashboard…";

// Anuncia el mensaje terminal, mantiene el status bar visible durante el intervalo
// mínimo y recarga exactamente una vez. No elimina el root manualmente.
async function doCompletionHandoff(message) {
  const text = (typeof message === "string" && message.trim()) ? message.trim() : COMPLETION_FALLBACK;
  await runCompletionHandoff({
    announce: () => {
      onboardingBusyMessage = text;
      syncOnboardingBusyState();
    },
    wait: () => new Promise(r => setTimeout(r, 1500)),
    reload: () => window.location.reload(),
  });
}

async function performAction(action, current) {
  if (action === "retry") return renderOnboarding();
  if (action === "back") {
    const result = await goToOnboardingStep(Math.max(1, current - 1));
    if (result.success) {
      runtime.status = result.status;
      const destination = Number(result.status.currentStep);
      await showPreparedStep(current, destination);
    }
    else toast(result.message, "error");
    return;
  }
  if (action === "verify-auth") {
    await prepareOnboardingStep(4, { force: true });
    renderCurrentStep();
    return;
  }
  if (action === "save-profile-and-template") {
    const draft = runtime.profileDraft || profileDraftFromConfig(state.config, runtime.activeTemplate);
    const color = draft.colorHex;
    const rgb = hexToRgb(color);
    const discipline = draft.discipline;
    const config = {
      ...state.config,
      website: draft.website.trim(),
      institution: draft.institution.trim(),
      faculty: draft.faculty.trim(),
      career: draft.career.trim(),
      colorHex: color,
      colorR: rgb.r,
      colorG: rgb.g,
      colorB: rgb.b,
      author: draft.author.trim(),
      degree: draft.degree.trim(),
      discipline,
    };
    const errorEl = document.getElementById("onb-form-error");
    const missing = validateProfileDraft(draft);
    document.querySelectorAll("[id$='-error']").forEach(element => { element.hidden = true; });
    if (missing.length > 0) {
      errorEl.hidden = false;
      errorEl.textContent = `Completa los campos obligatorios: ${missing.map(item => item.label).join(", ")}.`;
      missing.forEach(item => {
        const fieldError = document.getElementById(`onb-${item.key}-error`);
        if (fieldError) {
          fieldError.textContent = `${item.label} es obligatorio.`;
          fieldError.hidden = false;
        }
      });
      document.getElementById(missing[0].fieldId)?.focus();
      return;
    }
    errorEl.hidden = true;
    state.config = config;
    saveConfig();
    if (discipline && !localStorage.getItem("jintia.visualProfile")) {
      const DISCIPLINE_FALLBACK = {
        "software-engineering": "core", "electronics": "core", "design": "full",
      };
      let profile = DISCIPLINE_FALLBACK[discipline] ?? "minimum";
      try {
        const caps = await getCapabilitiesProfiles();
        const fromSkill = caps?.disciplines?.[discipline];
        if (fromSkill) profile = fromSkill;
      } catch { /* skill no disponible aún — usa fallback */ }
      localStorage.setItem("jintia.visualProfile", profile);
    }
    const result = await applyInstitutionConfig({ author: config.author, degree: config.degree, institution: config.institution, website: config.website, faculty: config.faculty, career: config.career, ecosystem: config.ecosystem || "", discipline: config.discipline || "", color_r: config.colorR, color_g: config.colorG, color_b: config.colorB });
    if (!result.success) { toast(result.message, "error", 8000); return; }
    const templateResult = await setActiveTemplate(draft.templateId);
    toast(templateResult.message, templateResult.success ? "success" : "error", 7000);
    if (!templateResult.success) return;
    runtime.activeTemplate = draft.templateId;
    clearProfileDraft(localStorage);
    runtime.profileDraft = null;
    return advance(current);
  }
  if (action === "install-all-needed") return installAllNeeded();
  if (action === "prepare-profile-tools") return prepareProfileTools();
  if (action === "install-local") {
    const result = await installSkill();
    targetOperationResult("Preparar Jintia para Claude Code", result);
    toast(result.message, result.success ? "success" : "error", 9000);
    await refreshTarget(); renderCurrentStep(); return;
  }
  if (action === "install-openai") {
    const result = await installOpenAIPlugin();
    targetOperationResult("Preparar Jintia para ChatGPT y Codex", result);
    toast(result.message, result.success ? "success" : "error", 10000);
    await refreshTarget(); renderCurrentStep(); return;
  }
  if (action === "configure-code" || action === "configure-desktop") {
    const result = await configureMcp(action === "configure-code" ? "claude-code" : "desktop");
    targetOperationResult("Conectar el asistente", result);
    toast(result.message, result.success ? "success" : "error", 9000);
    await refreshTarget(); renderCurrentStep(); return;
  }
  if (action === "advance-target") {
    if (!runtime.auth?.authenticated) {
      document.getElementById("onb-target-message").hidden = false;
      document.getElementById("onb-target-message").textContent = "Verifica tu sesión de NotebookLM antes de continuar.";
      return;
    }
    await refreshTarget();
    const target = document.querySelector("input[name=onboarding-target]:checked")?.value;
    if (!target) return toast("Selecciona un destino", "error");
    const ready = targetReady(target);
    if (!ready) { document.getElementById("onb-target-message").hidden = false; document.getElementById("onb-target-message").textContent = "Completa las acciones del destino y vuelve a verificar."; return; }
    return advance(current, target);
  }
  if (action === "complete-create" || action === "complete-dashboard") {
    const result = await completeOnboarding();
    if (result.success) {
      runtime.status = result.status;
      if (action === "complete-create") sessionStorage.setItem("jintia.openCreateCourse", "true");
      toast(result.message, "success", 3000);
      await doCompletionHandoff(result.message);
    } else {
      runtime.status = result.status;
      toast(result.message, "error", 10000);
      renderCurrentStep();
    }
    return;
  }
  if (action === "advance") return advance(current);
}

async function advance(step, selectedTarget) {
  const result = await advanceOnboarding(step, selectedTarget);
  toast(result.message, result.success ? "success" : "error", 7000);
  if (result.success) {
    runtime.status = result.status;
    const next = Number(result.status.currentStep);
    await showPreparedStep(step, next);
  }
}

async function refreshTarget() {
  runtime.setup = await getSetupStatus();
  rememberSuccessfulLoad("setup");
}

function targetOperationResult(title, result) {
  const backup = result?.backupPath || result?.backup_path;
  runtime.targetOperation = {
    ...createOperationState({ title }),
    state: result?.success ? "success" : "error",
    message: result?.success
      ? `${result.message}${backup ? " Conservamos una copia de seguridad de tu configuración anterior." : ""}`
      : "No se pudo completar esta integración. Revisa la indicación y vuelve a intentarlo.",
    technicalDetail: result?.success ? (backup ? `Backup: ${backup}` : "") : (result?.message || "Error sin detalle."),
    percent: result?.success ? 100 : null,
  };
}

function targetReady(target) {
  const setup = runtime.setup || {};
  const skillReady = setup.skill_installed && setup.skill_current;
  if (target === "claude-code") return skillReady && setup.mcp_claude_code_configured;
  if (target === "openai") return !!setup.openai_plugin_current;
  return skillReady && setup.mcp_claude_code_configured && setup.openai_plugin_current;
}

function hexToRgb(hex) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  return match ? { r: Number.parseInt(match[1], 16), g: Number.parseInt(match[2], 16), b: Number.parseInt(match[3], 16) } : { r: 0, g: 121, b: 107 };
}

function cssColorToHex(color) {
  const probe = document.createElement("span");
  probe.style.color = "";
  probe.style.color = color;
  if (!probe.style.color) return null;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const match = computed.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (!match) return null;
  return `#${[match[1], match[2], match[3]].map(value => Number(value).toString(16).padStart(2, "0")).join("")}`;
}
