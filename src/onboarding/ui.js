/**
 * ui.js — Funciones de UI pura del onboarding.
 *
 * Incluye: helpers visuales que no dependen de acciones de usuario ni del
 * grafo de navegación. Sí dependen de `runtime` (solo lectura) y de las
 * constantes de clases CSS compartidas.
 */

import { escapeHtml } from "../dom.js";
import { ic } from "../icons.js";
import { jintiaLoaderPlaceholder, mountJintiaLoader } from "../components/JintiaLoader.js";
import { ui, cx } from "../uiClasses.js";
import { runtime, STEP_META, TOTAL_STEPS } from "./store.js";

// ── Clases CSS compartidas (exportadas para que otros módulos no las dupliquen) ──
export const BTN_PRIMARY = cx(ui.button.base, ui.button.primary, "h-11 w-full cursor-pointer px-4");
export const BTN_SECONDARY = cx(ui.button.base, ui.button.secondary, "h-9 cursor-pointer px-4");
export const SCROLL_THIN = "onboarding-scrollbar";
export const CARD_LEAD = "max-w-md mx-auto mb-5 text-center text-gray-600 text-sm leading-relaxed";
export const CALLOUT = "flex gap-2.5 items-start max-w-lg mx-auto mt-4 p-3.5 rounded-xl bg-gray-100 text-gray-600 text-xs leading-relaxed";
export const INLINE_ERROR = "max-w-lg mx-auto mt-3 p-3 rounded-lg bg-red-50 border border-red-300 text-red-600 text-xs flex items-center gap-2";
export const DEP_ROW_CHECKING = "border-white/20 bg-white/40";
export const DEP_ROW_READY = "border-gray-900 bg-gray-50";
export const DEP_ROW_MISSING = "border-red-300 bg-red-50";
export const DEP_CARD_BASE = "relative isolate flex flex-col gap-2.5 overflow-hidden p-4 rounded-xl border backdrop-blur-xl backdrop-saturate-125 shadow-sm transition-colors min-w-0 will-change-[backdrop-filter]";
export const DEP_CARD_STATUS_BASE = "w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center";

const ONBOARDING_AMBIENT_PALETTE = [
  { hex: "#0fa3a3" },
  { hex: "#18b6ad" },
  { hex: "#0f7f86" },
  { hex: "#34c37a" },
];

// ── Estado local de UI (no pertenece al store compartido) ──
export let onboardingActionInFlight = false;
export let onboardingBusyMessage = "";
export function setOnboardingActionInFlight(value) { onboardingActionInFlight = value; }
export function setOnboardingBusyMessage(value) { onboardingBusyMessage = value; }

let footerConfig = { label: "Continuar", action: "advance", disabled: false };
export function setFooter(label, action = "advance", disabled = false) {
  footerConfig = { label, action, disabled };
}
export function getFooterConfig() { return footerConfig; }

export function onboardingAmbientBackground() {
  return `<div class="onboarding-ambient" aria-hidden="true">
    ${ONBOARDING_AMBIENT_PALETTE.map(({ hex }, index) => `<span class="onboarding-blob onboarding-blob--${index + 1}" style="--blob-color:${hex}"></span>`).join("")}
  </div>`;
}

export function mountLoadingMark(host) {
  if (!host) return () => {};
  const controller = mountJintiaLoader(host);
  return () => {
    controller.destroy();
    host.replaceChildren();
  };
}

export function mountJintiaLoading(root, message = "Preparando tu espacio de trabajo…") {
  if (!root) return () => {};
  root.className = "fixed inset-0 z-[10000] flex items-center justify-center overflow-hidden bg-gray-50";
  root.innerHTML = `${onboardingAmbientBackground()}
    <div class="relative z-[1] flex h-full w-full max-w-3xl flex-col items-center justify-center gap-4 p-6 text-slate-800" role="status" aria-live="polite">
      <div class="h-48 w-48" data-jintia-loading-mark aria-hidden="true"></div>
      <p class="text-sm font-semibold text-slate-700">${escapeHtml(message)}</p>
    </div>`;

  const stopLoader = mountLoadingMark(root.querySelector("[data-jintia-loading-mark]"));
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    stopLoader();
    root.replaceChildren();
    root.className = "";
  };
}

export const mountGeminiLoading = mountJintiaLoading;

export function progressDots(current) {
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

export function openaiPluginLabel(setup) {
  const state = setup.openai_plugin_state ?? "";
  if (state === "outdated")   return "Actualizar plugin ChatGPT/Codex";
  if (state === "foreign")    return "Reparar plugin ChatGPT/Codex";
  if (state === "incomplete") return "Completar plugin ChatGPT/Codex";
  if (setup.openai_plugin_installed) return "Actualizar para ChatGPT y Codex";
  return "Preparar para ChatGPT y Codex";
}

export function actionButton(label, action, disabled = false, secondary = false, iconHtml = "") {
  return `<button class="${secondary ? BTN_SECONDARY : BTN_PRIMARY}" data-onboarding-action="${action}" ${disabled ? "disabled" : ""}>${iconHtml}<span>${escapeHtml(label)}</span></button>`;
}

export function renderBottomNav(current) {
  const canBack = current > 1;
  return `<div class="flex flex-shrink-0 flex-col items-center pt-2">
    <div id="onboarding-operation-status" class="mb-1 flex h-5 items-center justify-center gap-1.5 text-xs font-medium text-gray-500 transition-opacity ${onboardingActionInFlight ? "opacity-100" : "opacity-0"}" role="status" aria-live="polite" aria-atomic="true">
      ${jintiaLoaderPlaceholder(13)}
      <span data-operation-message>${escapeHtml(onboardingBusyMessage || "Procesando…")}</span>
    </div>
    <div class="flex items-center justify-center gap-3">
      <button type="button" class="onboarding-nav-arrow onboarding-nav-arrow--back liquid-control border border-white/45 bg-white/55 ${canBack ? "" : "pointer-events-none opacity-0"}" data-operation-lock="global" data-onboarding-action="back" aria-label="Paso anterior" title="Paso anterior">${ic("chevron-left", 18)}</button>
      <nav class="${cx(ui.liquid.group, "onboarding-progress relative flex flex-wrap items-center justify-center gap-1 px-1")}" aria-label="Progreso de configuración">${progressDots(current)}</nav>
      <button type="button" class="${cx(ui.button.base, ui.button.primary, "h-11 cursor-pointer pl-4 pr-3 text-[13px]")}" data-operation-lock="global" data-onboarding-action="${footerConfig.action}" ${footerConfig.disabled ? "disabled" : ""}><span>${escapeHtml(footerConfig.label)}</span>${ic("chevron-right", 16)}</button>
    </div>
  </div>`;
}

export function syncOnboardingBusyState() {
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

export function stepNumber() {
  return Number(runtime.status?.currentStep || 1);
}

export function animateStepTransition(fromStep, toStep) {
  const track = document.querySelector(".onboarding-progress");
  const origin = stepperDotFor(track, fromStep);
  const destination = stepperDotFor(track, toStep);
  return animateDotWorm(track, origin, destination);
}

export function stepperDotFor(track, step) {
  if (!track) return null;
  return track.querySelector(`[data-step-index="${step}"]`);
}

export function animateDotWorm(track, origin, destination) {
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

export function loadingStep(step) {
  const messages = {
    2: "Verificando las herramientas…",
    3: "Preparando tu institución, perfil y plantillas…",
    4: "Comprobando tu sesión de Google y dónde trabajarás…",
    5: "Preparando la prueba final…",
  };
  setFooter("Preparando el siguiente paso", "advance", true);
  return `<section class="flex flex-col items-center justify-center py-10 text-gray-800" role="status" aria-live="polite">
    <div class="h-32 w-32" data-step-loading-mark aria-hidden="true"></div>
    <p class="mt-5 text-sm font-semibold text-gray-800">${messages[step] || "Preparando el siguiente paso…"}</p>
    <p class="mt-1 text-xs text-gray-500">Puedes continuar en cuanto termine esta comprobación.</p>
  </section>`;
}

export function actionBusyMessage(action, current) {
  const messages = {
    retry: "Reintentando el inicio…",
    back: "Volviendo al paso anterior…",
    "start-auth": "Abriendo el inicio de sesión de Google…",
    "verify-auth": "Verificando la sesión de NotebookLM…",
    "save-profile-and-template": "Guardando tu institución, perfil y plantilla…",
    "install-local": "Instalando en tu proyecto local…",
    "install-openai": "Preparando Jintia para ChatGPT y Codex…",
    "configure-code": "Conectando tu proyecto local…",
    "prepare-integrations": "Preparando OpenCode, Claude Code y ChatGPT con el entorno administrado de Jintia…",
    "configure-desktop": "Conectando la app de Claude…",
    "advance-target": "Comprobando todas las integraciones…",
    complete: "Finalizando la configuración…",
  };
  if (action === "advance") {
    return current === 2
      ? "Confirmando las herramientas del entorno…"
      : `Preparando el paso ${Math.min(TOTAL_STEPS, current + 1)}…`;
  }
  return messages[action] || "Procesando la solicitud…";
}

export function hexToRgb(hex) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  return match ? { r: Number.parseInt(match[1], 16), g: Number.parseInt(match[2], 16), b: Number.parseInt(match[3], 16) } : { r: 0, g: 121, b: 107 };
}

export function cssColorToHex(color) {
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

export function setBusyState(button, busy, label = "") {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  const text = button.querySelector("span");
  if (text && busy) text.textContent = label;
  if (text && !busy) text.textContent = button.dataset.originalLabel || text.textContent;
}
