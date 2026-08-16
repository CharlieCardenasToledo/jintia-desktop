/**
 * steps.js — Generadores de HTML para cada paso del onboarding.
 *
 * Incluye: welcomeStep, profileStep, connectStep, finalStep,
 * dependenciesStep, dependencySequence, operationPanelMarkup, capabilityCard,
 * renderOnboardingSiteAnalysis.
 */

import notebookLmWordmark from "../assets/notebooklm-wordmark.svg";
import googleGLogo from "../assets/google-g.svg";
import { escapeHtml } from "../dom.js";
import { state } from "../state.js";
import { ic } from "../icons.js";
import { elapsedLabel } from "../onboardingLongOperation.js";
import { capabilityStatusLabel, installableBlockingCapabilities, isOnboardingBlocking } from "../onboardingCapabilities.js";
import { profileDraftFromConfig } from "../onboardingDraft.js";
import { ui, cx } from "../uiClasses.js";
import { runtime, targetReady } from "./store.js";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  INLINE_ERROR,
  setFooter,
  actionButton,
  openaiPluginLabel,
} from "./ui.js";

// ── Constantes de layout del perfil ──
const FIELD_INPUT = cx(ui.surface.input, "px-3 py-2 w-full");
const FIELD_LABEL = "flex flex-col gap-1.5 text-gray-700 text-xs";

// ── Paso 1: Bienvenida ────────────────────────────────────────────────────────

export function welcomeStep() {
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

// ── Paso 2: Herramientas / Dependencias ───────────────────────────────────────

export function dependencySequence() {
  return runtime.dependencies;
}

export function operationPanelMarkup(operation, scope) {
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

export function capabilityCard(dep) {
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

export function dependenciesStep() {
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

// ── Paso 3: Perfil ────────────────────────────────────────────────────────────

export function renderOnboardingSiteAnalysis() {
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

export function profileStep() {
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

// ── Paso 4: Conectar ──────────────────────────────────────────────────────────

export function connectStep() {
  const authenticated = runtime.auth?.authenticated === true;

  const setup    = runtime.setup || {};
  const skillReady = !!(setup.skill_installed && setup.skill_current);
  const selected = runtime.status.selectedTarget || state.config.onboardingTarget || "claude-code";

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

// ── Paso 5: Final ─────────────────────────────────────────────────────────────

export function finalStep() {
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
