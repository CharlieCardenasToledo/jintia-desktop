/**
 * controller.js — Orquesta el renderizado del onboarding.
 *
 * Exporta renderCurrentStep y renderOnboarding, que son los puntos de
 * entrada externos (importados por main.js a través de index.js).
 */

import { getOnboardingStatus, cancelNotebookLMAuth } from "../api.js";
import { escapeHtml } from "../dom.js";
import { toast } from "../toast.js";
import { ic, refreshIcons } from "../icons.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BrandMark } from "../components/BrandMark.js";
import { ui, cx } from "../uiClasses.js";
import { runtime, STEP_META, TOTAL_STEPS, prepareOnboardingStep, warmOnboardingData } from "./store.js";
import {
  onboardingAmbientBackground,
  mountGeminiOrb,
  mountGeminiLoading,
  renderBottomNav,
  syncOnboardingBusyState,
  stepNumber,
  loadingStep,
  SCROLL_THIN,
} from "./ui.js";
import {
  welcomeStep,
  dependenciesStep,
  profileStep,
  connectStep,
  finalStep,
} from "./steps.js";
import { bindStepEvents, runOnboardingOperation } from "./actions.js";

// Referencia al destructor del orbe del paso actual.
let stopStepOrb = null;

export function renderCurrentStep() {
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
      <button class="h-11 w-full cursor-pointer px-4 max-w-xs" data-onboarding-action="retry"><span>Reintentar</span></button>
    </div>`;
    root.querySelector("[data-onboarding-action=retry]").addEventListener("click", () => runOnboardingOperation(
      "Reintentando el inicio…",
      renderOnboarding,
    ));
  }
}
