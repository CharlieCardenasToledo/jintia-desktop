/**
 * actions.js — Manejadores de acciones, eventos y operaciones asíncronas.
 *
 * Incluye todo lo que reacciona a acciones del usuario: instalación de
 * dependencias, autenticación con NotebookLM, guardado de perfil, navegación
 * entre pasos, y el flujo de la prueba final (animateFinalStep).
 */

import {
  advanceOnboarding,
  applyInstitutionConfig,
  cancelNotebookLMAuth,
  checkDependencies,
  configureMcp,
  extractSitePalette,
  getCapabilitiesProfiles,
  getDefaultCourseRoot,
  getSetupStatus,
  goToOnboardingStep,
  installDependency,
  installNotebookLmMcpRuntime,
  installNpmPackages,
  installOpenAIPlugin,
  installProfileBinaries,
  installProfilePackages,
  installSkill,
  installVivliostyleCli,
  completeOnboarding,
  openExternal,
  pickDirectory,
  runSkillSelfTest,
  saveSelfTestResult,
  setActiveTemplate,
  startNotebookLMAuth,
  downloadNodeRuntime,
  downloadPythonRuntime,
  downloadSkillRuntime,
} from "../api.js";
import { escapeHtml } from "../dom.js";
import { state, saveConfig } from "../state.js";
import { toast } from "../toast.js";
import { ic, refreshIcons } from "../icons.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import googleGLogo from "../assets/google-g.svg";
import { normalizeCapabilities } from "../onboardingCapabilities.js";
import {
  clearProfileDraft,
  persistProfileDraft,
  profileDraftFromConfig,
  validateProfileDraft,
} from "../onboardingDraft.js";
import { createOperationState, elapsedLabel, reduceOperationEvent } from "../onboardingLongOperation.js";
import { withDependencyProgress, GENERIC_DEPENDENCY_EVENT, applyDependencyProgressPresentation } from "../onboardingProgress.js";
import { runSecondaryStage, normalizeProfileInstallResult, verifyPythonInstallResult } from "../onboardingInstall.js";
import { runOperationWithFeedback, awaitPreparationWithCleanup, operationFailureResult } from "../onboardingOperation.js";
import { runCompletionHandoff } from "../onboardingCompletion.js";
import { APP_META } from "../appMeta.js";
import { runtime, loadOnce, rememberSuccessfulLoad, prepareOnboardingStep, targetReady as _targetReady } from "./store.js";
export { targetReady } from "./store.js";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  DEP_CARD_BASE,
  DEP_CARD_STATUS_BASE,
  DEP_ROW_READY,
  DEP_ROW_MISSING,
  onboardingActionInFlight,
  onboardingBusyMessage,
  setOnboardingActionInFlight,
  setOnboardingBusyMessage,
  syncOnboardingBusyState,
  setFooter,
  stepNumber,
  animateStepTransition,
  animateDotWorm,
  hexToRgb,
  cssColorToHex,
  setBusyState,
  actionBusyMessage,
} from "./ui.js";
import { operationPanelMarkup, dependencySequence, renderOnboardingSiteAnalysis } from "./steps.js";

// ── Variables de módulo ───────────────────────────────────────────────────────
const DEP_PROGRESS_DOTS = 6;
const COMPLETION_FALLBACK = "Configuración completada. Abriendo el dashboard…";

// ── Helpers de progreso de dependencias ──────────────────────────────────────

export function beginDependencyInstallProgress(row, statusEl, detailEl, installButton) {
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

  const barWrap = document.createElement("div");
  barWrap.style.cssText = "height:2px;border-radius:1px;background:#e5e7eb;margin-top:4px;overflow:hidden;display:none";
  const barFill = document.createElement("div");
  barFill.style.cssText = "height:100%;background:var(--color-brand-600,#4f46e5);width:0%;transition:width 0.25s";
  barWrap.appendChild(barFill);
  row.appendChild(barWrap);

  return function reportDependencyProgress({ message, percent }) {
    if (message !== null) {
      if (detailEl) detailEl.textContent = message;
      setOnboardingBusyMessage(message);
      syncOnboardingBusyState();
    }
    applyDependencyProgressPresentation({ track, barWrap, barFill, message, percent });
  };
}

export function animateDependencyFocus(dep) {
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

export function revealFocusedDependency() {
  const sequence = dependencySequence();
  if (sequence.length > 0) animateDependencyFocus(sequence[runtime.depFocusIndex]);
}

export function bindOnboardingPaletteButtons() {
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

export function beginAuthElapsedClock() {
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

export function refreshAuthOperationPanel() {
  const panel = document.querySelector('[data-operation-panel="notebooklm-auth"]');
  if (!panel) return;
  panel.outerHTML = operationPanelMarkup(runtime.authOperation, "notebooklm-auth");
  document.querySelector('[data-operation-panel="notebooklm-auth"] [data-onboarding-action="cancel-auth"]')
    ?.addEventListener("click", cancelNotebookLMAuthentication);
  refreshIcons();
}

export function updateProfilePackagesOperation(patch) {
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

export function updateDependencyOperation(name, patch) {
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

export function targetOperationResult(title, result) {
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

export function dependencyInstallConfirmMessage(name) {
  return `Jintia instalará ${name} dentro de su entorno privado. No modificará la instalación global de tu sistema. ¿Continuar?`;
}

export function confirmInOnboarding(message) {
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

export async function runOnboardingOperation(message, operation) {
  if (onboardingActionInFlight) return;
  setOnboardingActionInFlight(true);
  setOnboardingBusyMessage(message);
  syncOnboardingBusyState();
  return await runOperationWithFeedback(operation, {
    onError: (msg) => toast(msg, "error", 9000),
    onSettled: () => {
      setOnboardingActionInFlight(false);
      setOnboardingBusyMessage("");
      syncOnboardingBusyState();
    },
  });
}

async function requestDependencyInstall(name, button) {
  if (onboardingActionInFlight) return;
  const confirmed = await confirmInOnboarding(dependencyInstallConfirmMessage(name));
  if (!confirmed) return;
  await runOnboardingOperation(`Instalando ${name}…`, () => performDependencyInstall(name));
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
        reporter({ message: "Instalando Vivliostyle CLI…", percent: null });
        setOnboardingBusyMessage("Instalando Vivliostyle CLI…");
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
  // Lazy import to avoid circular dep at module-init time
  const { renderCurrentStep } = await import("./controller.js");
  renderCurrentStep();
  return result;
}

async function installAllNeeded() {
  const { installableBlockingCapabilities } = await import("../onboardingCapabilities.js");
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
    const { INLINE_ERROR: inlineError } = await import("./ui.js");
    if (area) area.innerHTML = `<div class="${inlineError} !mt-0 !max-w-none">${ic("alert-circle", 14)} ${escapeHtml(String(error))}</div>`;
    toast(`No se pudo analizar el sitio: ${error}`, "error", 6000);
  } finally {
    setBusyState(button, false);
  }
}

export async function startNotebookLMAuthentication() {
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
  const { renderCurrentStep } = await import("./controller.js");
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
    if (stepNumber() === 4) {
      const { renderCurrentStep } = await import("./controller.js");
      renderCurrentStep();
    }
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
    const { renderCurrentStep } = await import("./controller.js");
    renderCurrentStep();
  }
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

async function refreshTarget() {
  runtime.setup = await getSetupStatus();
  rememberSuccessfulLoad("setup");
}

async function doCompletionHandoff(message) {
  const text = (typeof message === "string" && message.trim()) ? message.trim() : COMPLETION_FALLBACK;
  await runCompletionHandoff({
    announce: () => {
      setOnboardingBusyMessage(text);
      syncOnboardingBusyState();
    },
    wait: () => new Promise(r => setTimeout(r, 1500)),
    reload: () => window.location.reload(),
  });
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

export async function showPreparedStep(fromStep, destination, { force = false, depFocusIndex } = {}) {
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
    const { renderCurrentStep } = await import("./controller.js");
    renderCurrentStep();
  }

  await awaitPreparationWithCleanup(preparation, () => {
    runtime.loadingStep = null;
    import("./controller.js").then(({ renderCurrentStep }) => renderCurrentStep());
  });
}

async function moveDependencyFocus(toIndex) {
  if (onboardingActionInFlight) return;
  const sequence = dependencySequence();
  const clamped = Math.min(Math.max(toIndex, 0), sequence.length - 1);
  if (clamped === runtime.depFocusIndex) return;
  setOnboardingActionInFlight(true);
  syncOnboardingBusyState();
  try {
    const track = document.querySelector(".onboarding-progress");
    const origin = track?.querySelector(`[data-dep-step-index="${runtime.depFocusIndex}"]`);
    const destination = track?.querySelector(`[data-dep-step-index="${clamped}"]`);
    await animateDotWorm(track, origin, destination);
    runtime.depFocusIndex = clamped;
    const { renderCurrentStep } = await import("./controller.js");
    renderCurrentStep();
  } finally {
    setOnboardingActionInFlight(false);
    syncOnboardingBusyState();
  }
}

async function jumpToDependencyTool(fromStep, toolIndex) {
  const result = await goToOnboardingStep(2);
  if (!result.success) {
    toast(result.message, "error");
    return;
  }
  runtime.status = result.status;
  await showPreparedStep(fromStep, 2, { depFocusIndex: toolIndex });
}

export async function animateFinalStep() {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const checkRows = document.querySelectorAll(".final-check-row");
  const msgEl     = document.getElementById("final-loading-msg");
  const fillEl    = document.getElementById("gen-progress-fill");
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

export function bindStepEvents(current) {
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
    import("./controller.js").then(({ renderCurrentStep }) => renderCurrentStep());
  }));
  root.querySelectorAll("input[name=onboarding-target]").forEach(input => input.addEventListener("change", event => {
    if (onboardingActionInFlight) return;
    const selectedTarget = event.currentTarget.value;
    state.config.onboardingTarget = selectedTarget;
    runtime.status = {
      ...(runtime.status || {}),
      selectedTarget,
    };
    saveConfig();
    import("./controller.js").then(({ renderCurrentStep }) => renderCurrentStep());
  }));
  root.querySelectorAll("[data-onboarding-action]").forEach(button => button.addEventListener("click", () => handleAction(button.dataset.onboardingAction, current)));
}

export async function handleAction(action, current) {
  if (action === "start-auth") return startNotebookLMAuthentication();
  if (action === "cancel-auth") return cancelNotebookLMAuthentication();
  if (action === "install-all-needed") return installAllNeeded();
  return runOnboardingOperation(
    actionBusyMessage(action, current),
    () => performAction(action, current),
  );
}

async function performAction(action, current) {
  const { renderCurrentStep, renderOnboarding } = await import("./controller.js");
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
    const ready = _targetReady(target);
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
