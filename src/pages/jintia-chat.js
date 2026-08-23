/**
 * jintia-chat.js — Chat nativo con OpenCode (Ask Jintia)
 * Plan Maestro sección 29: "Ask Jintia" dentro de una asignatura/semana.
 * Arquitectura: React UI → Tauri commands → OpenCode process → Jintia Skill
 *
 * Streaming: usa SSE (GET /event) en lugar de polling. Los deltas de texto
 * llegan evento a evento (message.part.delta) y se concatenan en tiempo real.
 */
import { invoke }     from "@tauri-apps/api/core";
import { listen }     from "@tauri-apps/api/event";
import { marked }     from "marked";
import { ic, refreshIcons } from "../icons.js";
import { ui, cx }     from "../uiClasses.js";
import { state }      from "../state.js";
import { escapeHtml } from "../dom.js";
import { toast }      from "../toast.js";
import { confirmDialog } from "../confirmDialog.js";
import { collectMarkdownSources, renderSafeMarkdown } from "../chatMarkdown.js";
import {
  checkNotebookLMAuth,
  listNotebooksMcp,
  listAccountNotebooksMcp,
  saveNotebooksConfig,
  opencodeRenameSession,
  opencodeDeleteSession,
  openWebSource,
  claudeStatus,
  claudeSubmitTurn,
  claudeInterruptTurn,
} from "../api.js";
import { saveCourses, saveConfig } from "../state.js";
import { isRateLimited, usageSummary, primaryWindow } from "../codexUsage.js";
import { registerClaudeListeners, CLAUDE_MODELS } from "../ai/claudeRuntime.js";
import {
  approvalPresentation,
  changedFilesFromCodexDiff,
  commandFromCodexParams,
  isLegacyLatexCommand,
  summarizeCodexOutput,
  trimCodexTechnicalOutput,
} from "../ai/codexActivity.js";
import { jintiaLoaderPlaceholder, mountAllJintiaLoaders } from "../components/JintiaLoader.js";
import {
  classifyFailure,
  isFailoverEligible,
  FailureCategory,
  ModelHealthRegistry,
  TurnSupervisor,
} from "../opencode-failover.js";

// Configurar marked: sin modo pedantic, con saltos de línea = <br>
marked.use({ breaks: true, gfm: true });

// Ask Jintia con Claude puede leer Y editar/crear archivos del curso (Edit,
// Write), pero NO ejecutar comandos de terminal (Bash queda fuera a
// propósito: editar archivos del curso es un riesgo acotado, ejecutar
// comandos arbitrarios no). Es una allowlist cerrada SIN diálogo de
// aprobación por acción (decisión explícita: el broker de permisos con
// confirmación como el de Codex no es viable vía subproceso del CLI, ver
// cabecera de src-tauri/src/claude/mod.rs).
// IMPORTANTE: esto se pasa como `--tools` (no `--allowedTools`), confirmado
// contra el CLI real que es la única forma que de verdad restringe qué
// herramientas están disponibles en modo headless.
const CLAUDE_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Edit", "Write"];

// ── Estado de la página ────────────────────────────────────────────────────
let _course          = null;
let _sessionId       = null;
let _port            = 0;
let _sse             = null;   // EventSource activo
let _assistantEl     = null;   // <div> que recibe deltas de respuesta
let _assistantRaw    = "";     // texto acumulado en bruto para convertir a MD al final
let _currentPartType = null;   // "reasoning" | "text" | null — part activo según SSE
let _currentPartId   = null;   // cada part de texto se renderiza como un bloque independiente
let _runtimeReady    = false;
let _busy            = false;
let _composerReady   = false;
let _selectedWeek    = "";
// Modelo seleccionado: { id, providerID, name } — se carga automáticamente al conectar
let _selectedModel   = null;
// Historial de sesiones del curso activo
let _sessionsLoaded  = false;
// Proveedor de IA: "opencode" | "codex" | "claude"
let _provider        = "opencode";
// Thread activo de Codex (por curso)
let _codexThreadId   = null;
let _codexTurnId     = null;
// Funciones de cancelación de listeners Tauri para eventos Codex
let _codexUnlisten   = [];
// Promesa de la conexión Codex en curso (evita iniciar dos veces en paralelo)
let _codexConnecting = null;
// Temporizadores de vigilancia mientras se espera respuesta de un turno Codex.
let _codexWatchdogTimers = [];
// Última lectura de account/rateLimits/read (o su notificación de actualización).
let _codexRateLimits = null;
// Refresca la cuenta regresiva del badge de cuota cada minuto sin repreguntar al servidor.
let _codexRateLimitTickTimer = null;
let _codexCommandOutput = new Map();
let _codexLegacyWarningShown = false;
// Sesión activa de Claude Code (por curso) y request_id del turno en curso.
// A diferencia de Codex no hay un "thread" persistente: la continuidad la da
// el session_id que Claude devuelve y que se reenvía con --resume.
let _claudeSessionId  = null;
let _claudeRequestId  = null;
// Función de cancelación de los listeners Tauri de Claude Code (registrar/detach en bloque)
let _claudeDetach     = null;
// Promesa de la conexión Claude en curso (evita iniciar dos veces en paralelo)
let _claudeConnecting = null;
// Temporizadores de vigilancia mientras se espera respuesta de un turno Claude
let _claudeWatchdogTimers = [];
// Flag para no mostrar el picker de notebook dos veces en la misma sesión de conexión
let _notebookChecked = false;
let _sourceLinks     = new Map();
let _panelViewport   = null;
let _panelResizeHandler = null;
let _openCodeTurnStartedAt = 0;
let _openCodeProgressTimer = null;
let _lastRuntimeActivity = "";
let _runtimeActivityEl = null;
// Failover automático de modelos (ver src/opencode-failover.js). El registry
// de salud vive fuera del turno: así una conversación que descubre un modelo
// agotado evita que otra pierda tiempo reintentándolo mientras dure el
// cooldown. _turnSupervisor solo existe mientras hay un turno OpenCode activo.
const _modelHealthRegistry = new ModelHealthRegistry();
let _turnSupervisor        = null;
let _availableModels       = []; // [{id, provider_id, name}] — poblado por loadModels()
let _openCodeStallTimer    = null;
const OPENCODE_STALL_MS    = 90000; // sin actividad SSE del modelo (no de una tool) → considerarlo atascado

// Diagnóstico común de proveedores. Codex ya deja una traza detallada; estos
// registros hacen que Claude y OpenCode sean igual de observables durante una
// sesión real (y conservan las últimas entradas para soporte).
const _providerLogs = [];
function providerLog(provider, phase, detail = null) {
  const entry = { at: new Date().toISOString(), provider, phase, detail };
  _providerLogs.push(entry);
  if (_providerLogs.length > 200) _providerLogs.shift();
  globalThis.__jintiaProviderLogs = _providerLogs;
  console.info(`[jintia:${provider}] ${phase}`, detail ?? "");
}

function stopOpenCodeProgressTimer() {
  if (_openCodeProgressTimer) clearInterval(_openCodeProgressTimer);
  _openCodeProgressTimer = null;
  _openCodeTurnStartedAt = 0;
}

function appendRuntimeActivity(text, kind = "info") {
  if (!text) return;
  const feed = el("jc-activity-feed");
  if (!feed) return;
  // Aunque el texto no cambie, mover la actividad al final garantiza que
  // siempre quede debajo de la respuesta más reciente.
  _lastRuntimeActivity = text;
  const palette = kind === "error"
    ? "border-red-200 bg-red-50 text-red-800"
    : kind === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-slate-200 bg-slate-50 text-slate-600";
  let wrap = _runtimeActivityEl;
  if (!wrap || !wrap.isConnected) {
    wrap = document.createElement("div");
    wrap.id = "jc-runtime-activity";
    wrap.className = "jc-route-step mb-4 jc-msg-in";
    wrap.innerHTML = `<span class="jc-route-node grid place-items-center border-slate-200 bg-white text-slate-500" aria-hidden="true">${ic("activity", 15)}</span><div class="jc-runtime-activity-body max-w-[72ch] rounded-xl border px-3 py-2 text-xs" role="status" aria-live="polite"><span class="font-semibold">Actividad del sistema</span><span class="mx-1" aria-hidden="true">·</span><span class="jc-runtime-activity-text"></span></div>`;
    feed.appendChild(wrap);
    _runtimeActivityEl = wrap;
    refreshIcons();
  }
  if (_runtimeActivityEl?.isConnected) {
    feed.appendChild(_runtimeActivityEl);
  }
  const body = wrap.querySelector(".jc-runtime-activity-body");
  const message = wrap.querySelector(".jc-runtime-activity-text");
  if (body) body.className = `jc-runtime-activity-body max-w-[72ch] rounded-xl border px-3 py-2 text-xs ${palette}`;
  if (message) message.textContent = text;
  scrollFeed();
}

// Formatea segundos transcurridos de forma legible ("45s", "3 min",
// "3 min 20s") en vez de mostrar siempre segundos crudos en turnos largos.
function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest}s` : `${minutes} min`;
}

function startOpenCodeProgressTimer() {
  stopOpenCodeProgressTimer();
  _openCodeTurnStartedAt = Date.now();
  _openCodeProgressTimer = setInterval(() => {
    if (_provider !== "opencode" || !_busy || !_openCodeTurnStartedAt) return;
    const seconds = Math.floor((Date.now() - _openCodeTurnStartedAt) / 1000);
    if (seconds >= 15) setStatus(`Jintia Chat trabajando… ${formatElapsed(seconds)}`, "working");
    providerLog("opencode", "turn.waiting", { elapsedSeconds: seconds, sessionId: _sessionId });
  }, 15000);
}

// ── Watchdog de "modelo atascado" (time-to-first-token / actividad) ────────
// A diferencia de startOpenCodeProgressTimer (solo actualiza el texto de
// estado), este watchdog dispara el failover si el modelo actual lleva
// OPENCODE_STALL_MS sin producir ninguna señal — ni texto, ni razonamiento,
// ni una tool. Se reinicia con cada evento SSE relevante (ver handleSSE) y
// se pausa mientras hay una tool activa: NotebookLM puede tardar minutos
// investigando y eso no es culpa del modelo elegido.
function startOpenCodeStallWatchdog() {
  clearOpenCodeStallWatchdog();
  _openCodeStallTimer = setTimeout(() => {
    if (!_busy || _provider !== "opencode" || !_turnSupervisor) return;
    if (_currentPartType === "tool") return; // una tool sigue activa: no es el modelo el que está atascado
    providerLog("opencode", "turn.stalled", { sessionId: _sessionId, model: _turnSupervisor.currentModel });
    triggerOpenCodeFailover("stall", { message: "El modelo no generó actividad en el tiempo esperado." });
  }, OPENCODE_STALL_MS);
}

function clearOpenCodeStallWatchdog() {
  if (_openCodeStallTimer) clearTimeout(_openCodeStallTimer);
  _openCodeStallTimer = null;
}

// ── Helpers DOM ────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);

function setStatus(text, kind = "neutral") {
  const badge = el("jc-status-badge");
  if (!badge) return;
  const colors = {
    neutral: "border border-slate-300 bg-slate-100 text-slate-700",
    ready:   "border border-teal-200 bg-teal-50 text-teal-800",
    working: "border border-amber-300 bg-amber-50 text-amber-800",
    error:   "border border-red-300 bg-red-50 text-red-700",
  };
  badge.className = `inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${colors[kind] ?? colors.neutral}`;
  badge.dataset.kind = kind;
  badge.textContent = text;

  const connect = el("jc-btn-connect");
  if (!connect) return;
  if (kind === "ready") {
    connect.hidden = true;
  } else {
    connect.hidden = false;
    connect.disabled = kind === "working";
    const label = connect.querySelector("span");
    if (label) label.textContent = kind === "working" ? "Preparando…" : kind === "error" ? "Reintentar" : "Conectar";
  }
}

function weekLabel(value = _selectedWeek) {
  return value ? `Semana ${String(value).padStart(2, "0")}` : "Contexto general";
}

function updateContextSummary() {
  const course = el("jc-context-course");
  const week = el("jc-context-week");
  if (course) course.textContent = _course?.code || _course?.name || "Sin asignatura";
  if (week) week.textContent = weekLabel();
}

function populateWeekSelect(course = _course) {
  const select = el("jc-week-select");
  if (!select) return;
  const count = Math.min(52, Math.max(1, Number(course?.weeks) || 16));
  select.innerHTML = `<option value="">Contexto general</option>${Array.from({ length: count }, (_, index) => {
    const week = index + 1;
    return `<option value="${week}">Semana ${String(week).padStart(2, "0")}</option>`;
  }).join("")}`;
  select.value = _selectedWeek;
}

// CSS de animaciones inyectado una sola vez
let _stylesInjected = false;
function ensureChatStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    #jc-chat-shell {
      --jc-navy: #0d1b2a;
      --jc-teal: #0f7f86;
      --jc-teal-bright: #0fa3a3;
      --jc-teal-soft: #eaf8f6;
      --jc-line: #b7e5e1;
      --jc-surface: #ffffff;
      --jc-canvas: #f8fafc;
      --jc-ink: #172033;
    }
    @keyframes jc-msg-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .jc-msg-in { animation: jc-msg-in 0.2s ease-out forwards; }

    .jc-route-step { position: relative; padding-left: 2.75rem; }
    .jc-route-step::before { content: ""; position: absolute; left: 1.08rem; top: 2rem; bottom: -1.1rem; width: 1px; background: linear-gradient(var(--jc-line), rgba(183,229,225,0)); }
    .jc-route-step:last-child::before { display: none; }
    .jc-route-node { position: absolute; left: .25rem; top: .1rem; z-index: 1; display: grid; width: 1.75rem; height: 1.75rem; place-items: center; border: 1px solid var(--jc-line); border-radius: .65rem; background: var(--jc-surface); box-shadow: 0 4px 12px rgba(13,27,42,.08); }
    .jc-route-node img { width: 1.05rem; height: 1.2rem; object-fit: contain; }
    /* Variante para el indicador de "pensando": usa JintiaLoader (morph +
       giro) en vez de la marca estática, así que sustituye al ícono normal
       en vez de sumarse a él. Fondo suave para que no quede sobre blanco
       plano. */
    .jc-route-node--thinking { background: var(--jc-teal-soft); }
    .jc-message-card { width: min(100%, 72ch); border: 1px solid #e2e8f0; border-radius: 1rem; background: #fff; box-shadow: 0 3px 12px rgba(13,27,42,.045); }
    .jc-message-actions { opacity: .88; transition: opacity .15s ease; }
    .jc-message-card:hover .jc-message-actions,
    .jc-message-card:focus-within .jc-message-actions { opacity: 1; }
    .jc-source-link { cursor: pointer; text-decoration-thickness: 1px; text-underline-offset: 3px; }
    .jc-table-wrap { max-width: 100%; overflow-x: auto; margin: .75em 0; border: 1px solid #dbe4ea; border-radius: .7rem; }
    .jc-table-wrap table { margin: 0; min-width: 34rem; }

    .jc-sources-panel { min-height: 0; max-height: 100%; overflow: hidden; }
    .jc-panel-scrim { position: absolute; inset: 0; z-index: 35; border: 0; background: rgba(13,27,42,.34); backdrop-filter: blur(1px); }
    .jc-session-title { padding-right: 5.5rem; }
    .jc-icon-button { min-width: 2.25rem; min-height: 2.25rem; background: transparent; }
    .jc-message-action { min-height: 2.25rem; border: 1px solid transparent; background: transparent; }
    @media (max-width: 1279px) {
      .jc-sources-panel { position: absolute; z-index: 40; top: 0; right: 0; bottom: 0; width: min(21rem, 90vw); box-shadow: -18px 0 36px rgba(13,27,42,.16); }
      .jc-session-title { padding-right: 6.5rem; }
      .jc-icon-button { min-width: 44px; min-height: 44px; }
      .jc-message-action, .jc-touch-action, .jc-composer-action, .jc-source-link { min-height: 44px; }
      .jc-composer-action { min-width: 44px; }
    }
    @media (max-width: 840px) {
      .jc-context-controls { align-items: stretch; }
      .jc-context-field { min-width: min(100%, 13rem); flex: 1 1 12rem; }
      .jc-context-controls button, .jc-context-controls select { min-height: 44px; }
      .jc-message-actions { opacity: 1; gap: .25rem; }
    }

    /* Markdown seguro dentro de la respuesta del asistente */
    .jc-md p          { margin: 0 0 0.55em; }
    .jc-md p:last-child { margin-bottom: 0; }
    .jc-md ul, .jc-md ol { padding-left: 1.4em; margin: 0 0 0.55em; }
    .jc-md li          { margin-bottom: 0.2em; }
    .jc-md h1,.jc-md h2,.jc-md h3,.jc-md h4 { font-family: var(--font-display); font-weight: 600; margin: 1em 0 .4em; line-height: 1.3; color: #0d1b2a; }
    .jc-md h1 { font-size: 1.18em; }
    .jc-md h2 { font-size: 1.08em; }
    .jc-md h3,.jc-md h4 { font-size: 1em; }
    .jc-md code { font-family: 'Cascadia Code','Consolas',monospace; font-size: 0.85em; background: rgba(15,163,163,0.08); border: 1px solid var(--teal-border, rgba(15,163,163,0.28)); border-radius: 4px; padding: 0.1em 0.35em; color: #0f6f75; }
    .jc-md pre  { background: var(--brand-900, #132a43); border-radius: 8px; padding: 0.9em 1em; overflow-x: auto; margin: 0.5em 0; }
    .jc-md pre code { background: none; border: none; padding: 0; color: #e6fbfa; font-size: 0.82em; }
    .jc-md blockquote { border-left: 3px solid #0f7f86; margin: .7em 0; padding: .2em 0 .2em .9em; color: #475569; }
    .jc-md hr   { border: none; border-top: 1px solid var(--surface-border, rgba(15,23,42,0.10)); margin: 0.7em 0; }
    .jc-md strong { font-weight: 600; }
    .jc-md a { color: #0f6f75; text-decoration: underline; }
    .jc-md table { border-collapse: collapse; width: 100%; margin: 0.5em 0; font-size: 0.85em; }
    .jc-md th,.jc-md td { border: 1px solid var(--surface-border, rgba(15,23,42,0.10)); padding: 0.3em 0.6em; text-align: left; }
    .jc-md th { background: var(--surface-hover, #f8fafc); font-weight: 600; }

    @media (prefers-reduced-motion: reduce) {
      .jc-msg-in { animation: none; }
      .jc-message-actions { transition: none; }
    }
  `;
  document.head.appendChild(style);
}

function clearFeed() {
  const feed = el("jc-activity-feed");
  if (feed) feed.innerHTML = "";
}

function scrollFeed() {
  const feed = el("jc-activity-feed");
  if (feed) feed.scrollTop = feed.scrollHeight;
}

function appendMessage(html) {
  const feed = el("jc-activity-feed");
  if (!feed) return;
  const div = document.createElement("div");
  div.innerHTML = html;
  const node = div.firstElementChild || div;
  node.classList.add("jc-msg-in");
  feed.appendChild(node);
  refreshIcons();
  scrollFeed();
}

function assistantNode() {
  return `<span class="jc-route-node" aria-hidden="true"><img src="/brand/jintia-mark.svg" alt=""></span>`;
}

// Variante animada de assistantNode() solo para el indicador de "pensando":
// respeta prefers-reduced-motion por sí sola (animación definida dentro del SVG).
function thinkingNode() {
  return `<span class="jc-route-node jc-route-node--thinking" aria-hidden="true">${jintiaLoaderPlaceholder(22)}</span>`;
}

// Manejador compartido de botones "starter": rellena el compositor sin
// enviar automáticamente (el usuario revisa/edita antes de disparar el
// turno). Se usa tanto en los botones estáticos de la pantalla vacía como
// en los chips de acciones rápidas que se añaden junto al saludo.
function attachStarterHandler(button) {
  button.addEventListener("click", () => {
    if (!_composerReady) {
      toast("Selecciona y conecta una asignatura para comenzar.", "warning", 3000);
      return;
    }
    const input = el("jc-input");
    if (!input) return;
    input.value = button.dataset.jcStarter;
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
}

// Acciones rápidas ligadas a comandos reales de la skill CLI para la
// semana activa (no prompts genéricos): estado de la semana, validación
// de la guía y la compuerta de evidencia, además del flujo de generación
// ya cubierto por "Generar guía". Sin semana seleccionada no hay contexto
// suficiente para ofrecerlas.
function weekQuickActions() {
  if (!_selectedWeek || !_course) return [];
  const week = weekLabel();
  return [
    { label: "Generar guía", prompt: `Genera la guía de ${week} siguiendo el flujo de la skill: revisa el sílabo, junta evidencia, propón un plan y pide mi aprobación antes de crear archivos.` },
    { label: "Estado de la semana", prompt: `Revisa el estado de ${week} (jintia week status) y resume qué falta: plan, guía, evidencia.` },
    { label: "Validar guía activa", prompt: `Valida la guía activa de ${week} (jintia validate) y enumera los problemas que encuentres.` },
    { label: "Compuerta de evidencia", prompt: `Revisa la compuerta de evidencia de ${week} (jintia evidence check): fuentes del sílabo y NotebookLM disponibles.` },
  ];
}

function restorePrompt(text) {
  const input = el("jc-input");
  if (!input || input.value.trim()) return;
  input.value = text;
  input.dispatchEvent(new Event("input"));
  input.focus();
}

function renderSourcesPanel() {
  const panel = el("jc-sources-content");
  const chip = el("jc-source-chip-label");
  if (chip) chip.textContent = _course?.notebook_id ? "Fuentes conectadas" : "Fuentes e historial";
  if (!panel) return;

  const notebook = _course?.notebook_id
    ? `<section class="rounded-xl border border-teal-200 bg-teal-50 p-3">
        <p class="text-[11px] font-bold uppercase tracking-wider text-teal-800">Notebook conectado</p>
        <p class="mt-1 text-sm font-semibold text-slate-900">${escapeHtml(_course.notebook_name || "NotebookLM del curso")}</p>
        ${_course.notebook_url ? `<button type="button" class="jc-source-link mt-2 inline-flex items-center border-0 bg-transparent p-0 text-xs font-semibold text-teal-800 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600" data-jc-source-url="${escapeHtml(_course.notebook_url)}">Abrir NotebookLM</button>` : ""}
      </section>`
    : `<section class="rounded-xl border border-amber-200 bg-amber-50 p-3">
        <p class="text-xs font-semibold text-amber-900">No hay un notebook vinculado</p>
        <p class="mt-1 text-xs leading-relaxed text-amber-800">Conecta las fuentes del curso para obtener respuestas verificables.</p>
      </section>`;

  const sources = [..._sourceLinks.values()];
  const links = sources.length
    ? `<ol class="space-y-2">${sources.map((source, index) => `<li>
        <button type="button" class="jc-source-link w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-xs font-medium leading-relaxed text-teal-800 hover:border-teal-300" data-jc-source-url="${escapeHtml(source.url)}">
          <span class="mr-1 text-slate-400">${index + 1}.</span>${escapeHtml(source.label || source.url)}
        </button>
      </li>`).join("")}</ol>`
    : `<p class="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-xs leading-relaxed text-slate-500">Esta conversación aún no incluye enlaces citados.</p>`;

  panel.innerHTML = `${notebook}<section><h3 class="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">Enlaces citados</h3>${links}</section>`;
}

function addAssistantActions(card, body, raw) {
  const actions = document.createElement("div");
  actions.className = "jc-message-actions flex flex-wrap items-center gap-1 border-t border-slate-100 px-3 py-2";
  actions.innerHTML = `
    <button type="button" class="jc-message-action rounded-lg px-2.5 text-xs font-semibold text-slate-700 hover:border-slate-200 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600" data-jc-copy>Copiar</button>
    <button type="button" class="jc-message-action rounded-lg px-2.5 text-xs font-semibold text-slate-700 hover:border-slate-200 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600" data-jc-show-sources>Ver fuentes</button>
    <button type="button" class="jc-message-action rounded-lg px-2.5 text-xs font-semibold text-teal-800 hover:border-teal-200 hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600" data-jc-use-response>Usar como base</button>`;
  actions.querySelector("[data-jc-copy]")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(body.innerText || raw);
      toast("Respuesta copiada", "success", 1800);
    } catch {
      toast("No se pudo copiar la respuesta", "error", 3000);
    }
  });
  actions.querySelector("[data-jc-show-sources]")?.addEventListener("click", () => showSourcesPanel());
  actions.querySelector("[data-jc-use-response]")?.addEventListener("click", () => {
    const input = el("jc-input");
    if (!input) return;
    input.value = `Usa la propuesta anterior como base para ${weekLabel().toLowerCase()} y detalla los cambios.`;
    input.dispatchEvent(new Event("input"));
    input.focus();
    updateComposerState();
  });
  card.appendChild(actions);
}

function finalizeAssistantBubble(body, raw, { actions = true } = {}) {
  if (!body) return;
  body.innerHTML = renderSafeMarkdown(raw, marked);
  body.querySelectorAll("table").forEach(table => {
    if (table.parentElement?.classList.contains("jc-table-wrap")) return;
    const wrapper = document.createElement("div");
    wrapper.className = "jc-table-wrap";
    table.replaceWith(wrapper);
    wrapper.appendChild(table);
  });
  collectMarkdownSources(body).forEach(source => _sourceLinks.set(source.url, source));
  renderSourcesPanel();
  const card = body.closest(".jc-message-card");
  // Los saludos generados localmente (no son una respuesta real de la IA) no
  // llevan "Copiar / Ver fuentes / Usar como base": no hay nada que copiar
  // como respuesta ni fuentes que mostrar, y ofrecerlo confunde al usuario.
  if (actions && card && !card.querySelector(".jc-message-actions")) addAssistantActions(card, body, raw);
}

// Indicador textual de trabajo: comprensible sin depender de la animación.
function showThinkingBubble() {
  hideThinkingBubble();
  const feed = el("jc-activity-feed");
  if (!feed) return;
  const wrap = document.createElement("div");
  wrap.id = "jc-thinking";
  wrap.className = "jc-route-step mb-5 jc-msg-in";
  wrap.setAttribute("role", "status");
  wrap.innerHTML = `
    ${thinkingNode()}
    <div class="jc-message-card min-w-0 flex-1 px-4 py-3 text-sm text-slate-600">
      <div id="jc-thinking-message" class="font-medium">Jintia está consultando el contexto…</div>
      <div id="jc-thinking-detail" class="mt-1 hidden text-xs text-slate-500"></div>
      <details id="jc-thinking-technical-wrap" class="mt-2 hidden">
        <summary class="cursor-pointer text-xs font-semibold text-slate-500">Ver detalle técnico</summary>
        <pre id="jc-thinking-technical" class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-950 p-2 text-[11px] text-slate-100"></pre>
      </details>
    </div>`;
  feed.appendChild(wrap);
  mountAllJintiaLoaders(wrap);
  scrollFeed();
}

function updateThinkingActivity({ message, detail = "", technical = "", tone = "working" }) {
  if (!el("jc-thinking")) showThinkingBubble();
  const messageEl = el("jc-thinking-message");
  const detailEl = el("jc-thinking-detail");
  const technicalWrap = el("jc-thinking-technical-wrap");
  const technicalEl = el("jc-thinking-technical");
  if (messageEl) {
    messageEl.textContent = message;
    messageEl.className = `font-medium ${tone === "warning" ? "text-amber-700" : tone === "error" ? "text-red-700" : "text-slate-700"}`;
  }
  if (detailEl) {
    detailEl.textContent = detail;
    detailEl.classList.toggle("hidden", !detail);
  }
  if (technicalWrap && technicalEl) {
    technicalEl.textContent = technical;
    technicalWrap.classList.toggle("hidden", !technical);
  }
  scrollFeed();
}

function hideThinkingBubble() {
  el("jc-thinking")?.remove();
}

// Crea una burbuja de asistente vacía y retorna el elemento de texto
// que irá recibiendo los deltas SSE.
function createAssistantBubble() {
  const feed = el("jc-activity-feed");
  if (!feed) return null;
  const wrap = document.createElement("div");
  wrap.className = "jc-route-step mb-5 jc-msg-in";
  wrap.innerHTML = `
    ${assistantNode()}
    <article class="jc-message-card" aria-label="Respuesta de Jintia">
      <span class="sr-only">Jintia:</span>
      <div class="jc-md px-4 py-3 text-sm leading-relaxed text-slate-800"></div>
    </article>`;
  feed.appendChild(wrap);
  // La actividad es un estado vivo del turno: debe permanecer debajo del
  // último bloque de respuesta, incluso cuando OpenCode abre otro part.
  if (_runtimeActivityEl?.isConnected) feed.appendChild(_runtimeActivityEl);
  scrollFeed();
  return wrap.querySelector(".jc-md");
}

function messageHtml(msg) {
  const role = msg.info?.role || msg.role || "assistant";
  const text = (msg.parts || [])
    .filter(p => p.type === "text")
    .map(p => p.text || "")
    .join("\n")
    .trim();
  if (!text || role !== "user") return null;
  return `<div class="flex justify-end mb-5 jc-msg-in">
    <div class="max-w-[60ch] rounded-2xl rounded-br-md bg-brand-900 px-4 py-3 text-sm leading-relaxed text-white"><span class="sr-only">Tú: </span>${escapeHtml(text)}</div>
  </div>`;
}

// ── Control de botones ─────────────────────────────────────────────────────
function updateComposerState() {
  const btn = el("jc-btn-send");
  const inp = el("jc-input");
  const ready = (_provider === "codex" || _provider === "claude") ? _composerReady : _runtimeReady && _composerReady;
  if (inp) inp.disabled = !ready;
  if (btn) btn.disabled = !ready || _busy || !(inp?.value || "").trim();
  el("jc-activity-feed")?.setAttribute("aria-busy", String(_busy));
}

function setSendEnabled(enabled) {
  _composerReady = enabled;
  updateComposerState();
}

function setAbortVisible(visible) {
  const btn = el("jc-btn-abort");
  if (btn) btn.hidden = !visible;
}

// ── SSE streaming ──────────────────────────────────────────────────────────
function connectSSE(port) {
  disconnectSSE();
  providerLog("opencode", "sse.connect", { port });
  try {
    _sse = new EventSource(`http://127.0.0.1:${port}/event`);
    _sse.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data);
        const props = event.properties || {};
        providerLog("opencode", "sse.event", {
          type: event.type,
          sessionId: props.sessionID,
          keys: Object.keys(props),
          partType: props.part?.type,
          delta: typeof props.delta === "string" ? props.delta.slice(0, 160) : undefined,
          status: props.status?.type,
          message: props.status?.message || props.error?.message,
        });
        handleSSE(event);
      } catch (error) {
        providerLog("opencode", "sse.parse_error", { error: String(error), data: ev.data?.slice?.(0, 500) });
      }
    };
    _sse.onerror = (error) => {
      providerLog("opencode", "sse.error", { readyState: _sse?.readyState, error: String(error) });
    };
  } catch (error) {
    providerLog("opencode", "sse.connect_error", { error: String(error), port });
  }
}

function disconnectSSE() {
  if (_sse) { _sse.close(); _sse = null; }
  stopOpenCodeProgressTimer();
  clearOpenCodeStallWatchdog();
  _turnSupervisor  = null;
  _assistantEl     = null;
  _assistantRaw    = "";
  _currentPartType = null;
}

// Carga modelos disponibles desde OpenCode y puebla el selector.
// Pre-selecciona la preferencia guardada en settings; si no hay, el primero de la lista.
// Al cambiar, guarda la nueva preferencia automáticamente.
async function loadModels(coursePath) {
  try {
    const [models, savedPref] = await Promise.all([
      invoke("opencode_list_models", { coursePath }),
      invoke("get_ai_preference").catch(() => null),
    ]);
    _availableModels = models; // usado por el failover para elegir el siguiente candidato
    const sel = el("jc-model-select");
    if (!sel || !models.length) return;
    sel.innerHTML = models
      .map(m => `<option value="${escapeHtml(m.provider_id)}|${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`)
      .join("");

    // Intentar pre-seleccionar preferencia guardada; fallback al primero
    const savedKey = savedPref?.provider_id && savedPref?.model_id
      ? `${savedPref.provider_id}|${savedPref.model_id}`
      : null;
    const preferred = savedKey && models.find(m => `${m.provider_id}|${m.id}` === savedKey);
    const target = preferred || models[0];
    _selectedModel = { id: target.id, providerID: target.provider_id, name: target.name };
    sel.value = `${target.provider_id}|${target.id}`;
    sel.disabled = false;

    // Guardar si no había preferencia o si el modelo guardado ya no está disponible
    if (!preferred) {
      invoke("save_ai_preference", {
        providerId: target.provider_id,
        modelId: target.id,
        modelName: target.name,
      }).catch(() => {});
    }

    sel.onchange = () => {
      const [prov, id] = sel.value.split("|");
      const found = models.find(m => m.id === id && m.provider_id === prov);
      if (found) {
        _selectedModel = { id: found.id, providerID: found.provider_id, name: found.name };
        invoke("save_ai_preference", {
          providerId: found.provider_id,
          modelId: found.id,
          modelName: found.name,
        }).catch(() => {});
      } else {
        _selectedModel = null;
      }
    };
  } catch {
    // Si falla, queda sin modelo forzado → OpenCode usa su default
  }
}

// ── Panel contextual: fuentes, citas e historial ───────────────────────────
function panelViewportMode() {
  if (window.matchMedia("(max-width: 840px)").matches) return "mobile";
  if (window.matchMedia("(max-width: 1279px)").matches) return "compact";
  return "wide";
}

function panelIsExplicitlyOpen(panel) {
  return Boolean(panel?.classList.contains("flex") && !panel.classList.contains("hidden"));
}

function updatePanelState() {
  const mode = panelViewportMode();
  const sourcesOpen = mode === "wide" || panelIsExplicitlyOpen(el("jc-sources-panel"));
  const scrimOpen = mode !== "wide" && sourcesOpen;
  const scrim = el("jc-panel-scrim");

  el("jc-toggle-sources")?.setAttribute("aria-expanded", String(sourcesOpen));
  if (scrim) {
    scrim.hidden = !scrimOpen;
    scrim.classList.toggle("hidden", !scrimOpen);
  }
}

function showSourcesPanel({ focus = true } = {}) {
  const panel = el("jc-sources-panel");
  if (!panel) return;
  panel.classList.remove("hidden");
  panel.classList.add("flex");
  renderSourcesPanel();
  updatePanelState();
  if (focus && panelViewportMode() !== "wide") el("jc-close-sources")?.focus();
}

function hideSourcesPanel({ restoreFocus = false } = {}) {
  const panel = el("jc-sources-panel");
  if (!panel) return;
  panel.classList.add("hidden");
  panel.classList.remove("flex");
  updatePanelState();
  if (restoreFocus) el("jc-toggle-sources")?.focus();
}

function syncPanelLayout({ force = false } = {}) {
  const mode = panelViewportMode();
  if (!force && mode === _panelViewport) {
    updatePanelState();
    return;
  }
  _panelViewport = mode;

  hideSourcesPanel();
  if (mode === "wide") showSourcesPanel({ focus: false });
  updatePanelState();
}

async function loadSessions(coursePath) {
  const list = el("jc-sessions-list");
  if (!list || !coursePath) return;
  list.innerHTML = `<div class="px-3 py-3 text-xs text-slate-400">Cargando conversaciones…</div>`;
  try {
    const sessions = await invoke("opencode_list_sessions", { coursePath });
    _sessionsLoaded = true;
    if (!sessions.length) {
      list.innerHTML = `<div class="px-3 py-4 text-xs leading-relaxed text-slate-400">Aún no hay conversaciones para esta asignatura.</div>`;
      return;
    }
    renderSessionsList(list, sessions, coursePath);
  } catch {
    list.innerHTML = `<div class="px-3 py-4 text-xs leading-relaxed text-red-700">No se pudo cargar el historial.</div>`;
  }
}

// Títulos locales: clave de sesión → título personalizado (override cliente)
const _localTitles = (() => {
  try { return JSON.parse(localStorage.getItem("jintia_session_titles") || "{}"); }
  catch { return {}; }
})();

function saveLocalTitles() {
  try { localStorage.setItem("jintia_session_titles", JSON.stringify(_localTitles)); } catch {}
}

function sessionTitle(s) {
  return _localTitles[s.id] || s.title || "Sin título";
}

function renderSessionsList(list, sessions, coursePath) {
  list.innerHTML = sessions.map(s => {
    const active  = s.id === _sessionId;
    const title   = sessionTitle(s);
    const baseRow = active
      ? "border-l-2 border-teal-700 bg-teal-50 text-slate-950"
      : "border-l-2 border-transparent text-slate-700 hover:bg-slate-100 hover:text-slate-950";
    return `
      <div class="group relative flex items-center rounded-md ${baseRow} transition-colors"
           data-session-row="${escapeHtml(s.id)}">
        <button class="jc-session-title min-h-12 min-w-0 flex-1 border-0 bg-transparent py-2 pl-3 text-left text-xs text-inherit"
                data-session-id="${escapeHtml(s.id)}"
                aria-current="${active ? "true" : "false"}"
                title="${escapeHtml(title)}">
          <div class="truncate font-semibold leading-snug">${escapeHtml(title)}</div>
          <div class="mt-0.5 text-[11px] text-slate-400">${escapeHtml(weekLabel())}</div>
        </button>
        <div class="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-lg border border-slate-200 bg-white/95 p-0.5 shadow-sm">
          <button class="jc-icon-button grid place-items-center rounded-md border-0 text-slate-600 hover:bg-slate-100 hover:text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
                  data-rename-session="${escapeHtml(s.id)}"
                  aria-label="Renombrar sesión"
                  title="Renombrar">
            ${ic("pencil", 16)}
          </button>
          <button class="jc-icon-button grid place-items-center rounded-md border-0 text-slate-600 hover:bg-red-50 hover:text-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-600"
                  data-delete-session="${escapeHtml(s.id)}"
                  aria-label="Eliminar sesión"
                  title="Eliminar">
            ${ic("trash-2", 16)}
          </button>
        </div>
      </div>`;
  }).join("");
  refreshIcons();

  // Click para cambiar de sesión
  list.querySelectorAll("[data-session-id]").forEach(btn => {
    btn.addEventListener("click", () => switchToSession(btn.dataset.sessionId, coursePath));
  });

  // Botones de renombrar
  list.querySelectorAll("[data-rename-session]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      startInlineRename(btn.dataset.renameSession, coursePath, sessions);
    });
  });

  // Botones de eliminar
  list.querySelectorAll("[data-delete-session]").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      await deleteSession(btn.dataset.deleteSession, coursePath, sessions);
    });
  });
}

function startInlineRename(sessionId, coursePath, sessions) {
  const row = el("jc-sessions-list")?.querySelector(`[data-session-row="${sessionId}"]`);
  if (!row) return;

  const s     = sessions.find(x => x.id === sessionId);
  const current = sessionTitle(s || { id: sessionId });

  // Sustituir el botón por un editor real. Un input dentro de un botón sería
  // HTML interactivo inválido y propagaría el clic que cambia de sesión.
  const titleBtn = row.querySelector("[data-session-id]");
  if (!titleBtn) return;
  const inputId = `jc-rename-input-${sessionId}`;
  row.querySelector('[data-rename-session]')?.closest("div")?.classList.add("!hidden"); // ocultar acciones
  const editor = document.createElement("div");
  editor.className = "min-h-12 min-w-0 flex-1 py-2 pl-3 pr-2";
  editor.innerHTML = `
    <input id="${escapeHtml(inputId)}" class="w-full rounded-lg border border-brand-500 bg-white px-2 py-1.5 text-xs text-slate-900 outline-none ring-2 ring-brand-500/30"
           value="${escapeHtml(current)}" autocomplete="off" spellcheck="false">`;
  titleBtn.replaceWith(editor);
  const input = document.getElementById(inputId);
  if (!input) return;
  input.focus();
  input.select();

  let settled = false;
  async function commit() {
    if (settled) return;
    settled = true;
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== current) {
      _localTitles[sessionId] = newTitle;
      saveLocalTitles();
      try {
        await opencodeRenameSession(coursePath, sessionId, newTitle);
        toast("Conversación renombrada", "success", 1800);
      } catch (error) {
        toast(`El nombre se guardó en Jintia, pero OpenCode no pudo actualizarlo: ${error}`, "warning", 5000);
      }
    }
    await loadSessions(coursePath);
  }

  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); commit(); }
    if (e.key === "Escape") { settled = true; loadSessions(coursePath); }
  });
  input.addEventListener("blur", commit);
}

async function deleteSession(sessionId, coursePath, sessions) {
  if (_busy) {
    toast("Detén o espera la respuesta antes de eliminar esta conversación.", "warning", 3500);
    return;
  }
  const s     = sessions.find(x => x.id === sessionId);
  const title = sessionTitle(s || { id: sessionId });
  const ok = await confirmDialog({
    title: `¿Eliminar "${title}"?`,
    message: "Se borrará el historial de esta conversación. Esta acción no se puede deshacer.",
    confirmLabel: "Eliminar",
    danger: true,
  });
  if (!ok) return;

  try {
    await opencodeDeleteSession(coursePath, sessionId);
  } catch (error) {
    toast(`No se pudo eliminar la conversación: ${error}`, "error", 5500);
    return;
  }

  el("jc-sessions-list")?.querySelector(`[data-session-row="${sessionId}"]`)?.remove();
  if (_sessionId === sessionId) resetConversation();
  delete _localTitles[sessionId];
  saveLocalTitles();
  toast("Conversación eliminada", "success", 1800);

  // Recargar para reflejar el estado real del servidor
  await loadSessions(coursePath);
}

async function switchToSession(sessionId, coursePath) {
  if (sessionId === _sessionId) return;
  if (_busy) { toast("Espera a que Jintia termine de responder", "warning", 3000); return; }

  _sessionId       = sessionId;
  _assistantEl     = null;
  _assistantRaw    = "";
  _currentPartType = null;
  _busy            = false;
  hideThinkingBubble();
  clearFeed();
  setSendEnabled(false);
  setStatus("Cargando historial…", "working");

  // Actualizar resaltado inmediatamente
  const list = el("jc-sessions-list");
  if (list) {
    list.querySelectorAll("[data-session-row]").forEach(row => {
      const active = row.dataset.sessionRow === sessionId;
      row.className = `group relative flex items-center rounded-md transition-colors ${active
        ? "border-l-2 border-teal-700 bg-teal-50 text-slate-950"
        : "border-l-2 border-transparent text-slate-700 hover:bg-slate-100 hover:text-slate-950"}`;
      row.querySelector("[data-session-id]")?.setAttribute("aria-current", active ? "true" : "false");
    });
  }

  try {
    const messages = await invoke("agent_get_messages", { coursePath, sessionId });
    messages.forEach(msg => {
      const role = msg.info?.role || msg.role;
      if (role === "user") {
        const html = messageHtml(msg);
        if (html) appendMessage(html);
      } else if (role === "assistant") {
        const text = (msg.parts || [])
          .filter(p => p.type === "text")
          .map(p => p.text || "")
          .join("\n")
          .trim();
        if (text) appendAssistantMessage(text);
      }
    });
  } catch (err) {
    toast("No se pudo cargar el historial: " + String(err), "error", 5000);
  }

  setSendEnabled(true);
  setStatus("Jintia Chat listo", "ready");
}

// Burbuja de respuesta completa (para historial cargado, no streaming)
function appendAssistantMessage(text, { actions = true } = {}) {
  const body = createAssistantBubble();
  finalizeAssistantBubble(body, text, { actions });
  scrollFeed();
}

// Saludo local (no proviene de la IA): mismo tratamiento visual que una
// respuesta, pero sin las acciones de respuesta (Copiar/Ver fuentes/Usar
// como base no aplican a un texto que Jintia no generó). En su lugar, si
// hay una semana activa, ofrece chips de acciones rápidas ligadas a
// comandos reales de la skill para que el usuario dispare algo útil desde
// el primer momento en vez de encontrarse un hilo vacío.
function appendGreetingMessage(text, quickActions = weekQuickActions()) {
  const body = createAssistantBubble();
  finalizeAssistantBubble(body, text, { actions: false });
  const card = body.closest(".jc-message-card");
  if (card && quickActions.length) {
    const chips = document.createElement("div");
    chips.className = "flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-3 py-2.5";
    chips.innerHTML = quickActions.map(a =>
      `<button type="button" data-jc-starter="${escapeHtml(a.prompt)}" class="jc-message-action rounded-lg px-2.5 text-xs font-semibold text-teal-800 hover:border-teal-200 hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600">${escapeHtml(a.label)}</button>`
    ).join("");
    card.appendChild(chips);
    chips.querySelectorAll("[data-jc-starter]").forEach(attachStarterHandler);
  }
  scrollFeed();
}

// Muestra el error tal como lo reporta Codex directamente en la conversación
// (igual que el propio Codex lo hace), no solo como un aviso que desaparece.
function appendErrorMessage(text) {
  const feed = el("jc-activity-feed");
  if (!feed) return;
  const wrap = document.createElement("div");
  wrap.className = "jc-route-step mb-5 jc-msg-in";
  wrap.innerHTML = `
    <span class="jc-route-node grid place-items-center" style="border-color:#fecaca;background:#fef2f2;color:#dc2626" aria-hidden="true">${ic("circle-alert", 16)}</span>
    <article class="jc-message-card" role="alert" style="border-color:#fecaca;background:#fef2f2">
      <span class="sr-only">Error de Codex:</span>
      <div class="px-4 py-3 text-sm leading-relaxed text-red-800">${escapeHtml(text)}</div>
    </article>`;
  feed.appendChild(wrap);
  refreshIcons();
  scrollFeed();
}

// Cierra el turno de la burbuja de asistente en curso: si tiene contenido
// real lo renderiza, y si quedó vacía (p. ej. un part sin deltas visibles)
// la retira del hilo en vez de dejar una tarjeta "Jintia:" fantasma.
function settleAssistantBubble() {
  if (_assistantEl) {
    if (_assistantRaw.trim()) {
      finalizeAssistantBubble(_assistantEl, _assistantRaw);
    } else {
      _assistantEl.closest(".jc-route-step")?.remove();
    }
  }
  _assistantEl = null;
  _assistantRaw = "";
}

const OPENCODE_PERMISSION_LABELS = {
  external_directory: "escribir fuera de la carpeta del curso",
  bash: "ejecutar un comando en la terminal",
  edit: "editar un archivo",
  write: "crear o editar un archivo",
  webfetch: "consultar una página web",
};

/** Muestra el detalle de una petición de permiso de OpenCode y le reenvía la decisión. */
async function respondToOpenCodePermission(props) {
  const { id, permission, patterns, metadata } = props;
  const target = metadata?.filepath || metadata?.command || (patterns || [])[0] || "";
  const label = OPENCODE_PERMISSION_LABELS[permission] || `usar "${permission}"`;
  setStatus("Jintia Chat pide tu autorización…", "working");
  appendRuntimeActivity(`Jintia Chat necesita permiso para ${label}.`, "warning");
  const allowed = await confirmDialog({
    title: "Jintia Chat pide autorización",
    message: target ? `Quiere ${label}:\n${target}` : `Quiere ${label}.`,
    confirmLabel: "Permitir",
    cancelLabel: "Denegar",
    danger: true,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${_port}/permission/${id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: allowed ? "once" : "reject" }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setStatus(allowed ? "Permiso concedido, continuando…" : "Permiso denegado, continuando…", "working");
  } catch (error) {
    toast(`No se pudo responder al permiso de Jintia Chat: ${error}`, "error", 6000);
  }
}

/**
 * Pregunta estructurada de OpenCode (tool "question"): igual que un permiso,
 * detiene el turno hasta recibir respuesta. El bug que esto evita: antes,
 * el siguiente mensaje del usuario (p. ej. "continuar") se encolaba como un
 * turno nuevo pero nunca respondía a la pregunta pendiente, así que el
 * turno original se quedaba esperando para siempre. Se muestra como una
 * tarjeta interactiva en el propio hilo, no como un modal aparte, para que
 * las opciones queden documentadas junto al resto de la conversación.
 */
async function respondToOpenCodeQuestion(props) {
  const { id, questions } = props;
  const feed = el("jc-activity-feed");
  if (!feed || !Array.isArray(questions) || !questions.length) return;
  setStatus("Jintia Chat necesita tu respuesta…", "working");

  const answers = [];
  for (const q of questions) {
    const selected = await new Promise(resolve => {
      const wrap = document.createElement("div");
      wrap.className = "jc-route-step mb-5 jc-msg-in";
      wrap.innerHTML = `
        ${assistantNode()}
        <article class="jc-message-card" aria-label="Pregunta de Jintia Chat">
          <div class="px-4 py-3 text-sm leading-relaxed text-slate-800">
            <p class="text-[11px] font-bold uppercase tracking-wider text-teal-800">${escapeHtml(q.header || "Pregunta")}</p>
            <p class="mt-1 font-semibold text-slate-900">${escapeHtml(q.question || "")}</p>
            <div class="mt-3 flex flex-col gap-2" data-jc-question-options></div>
            ${q.multiple ? `<button type="button" data-jc-question-submit class="jc-message-action mt-2 self-start rounded-lg px-3 py-1.5 text-xs font-semibold text-teal-800 disabled:text-slate-400" disabled>Enviar selección</button>` : ""}
          </div>
        </article>`;
      const optionsWrap = wrap.querySelector("[data-jc-question-options]");
      const submitBtn = wrap.querySelector("[data-jc-question-submit]");
      const chosen = new Set();
      const finish = labels => {
        optionsWrap.querySelectorAll("button").forEach(b => { b.disabled = true; });
        if (submitBtn) submitBtn.disabled = true;
        resolve(labels);
      };
      (q.options || []).forEach(opt => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "jc-message-action w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:border-teal-300 hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600";
        btn.innerHTML = `<span class="block font-semibold text-slate-900">${escapeHtml(opt.label)}</span>${opt.description ? `<span class="mt-0.5 block text-xs text-slate-500">${escapeHtml(opt.description)}</span>` : ""}`;
        btn.addEventListener("click", () => {
          if (!q.multiple) { finish([opt.label]); return; }
          if (chosen.has(opt.label)) chosen.delete(opt.label); else chosen.add(opt.label);
          btn.classList.toggle("border-teal-400", chosen.has(opt.label));
          btn.classList.toggle("bg-teal-50", chosen.has(opt.label));
          if (submitBtn) submitBtn.disabled = chosen.size === 0;
        });
        optionsWrap.appendChild(btn);
      });
      submitBtn?.addEventListener("click", () => finish(Array.from(chosen)));
      feed.appendChild(wrap);
      refreshIcons();
      scrollFeed();
    });
    answers.push(selected);
  }

  try {
    const response = await fetch(`http://127.0.0.1:${_port}/question/${id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setStatus("Respuesta enviada, continuando…", "working");
  } catch (error) {
    toast(`No se pudo responder a Jintia Chat: ${error}`, "error", 6000);
  }
}

function handleSSE(event) {
  const props = event.properties || {};

  // Cualquier evento SSE real del turno activo demuestra que OpenCode sigue
  // vivo — reinicia el watchdog de "modelo atascado" (ver
  // startOpenCodeStallWatchdog). Solo el silencio total dispara el failover.
  if (_provider === "opencode" && _busy && _turnSupervisor && props.sessionID === _sessionId) {
    startOpenCodeStallWatchdog();
  }

  // ── Preguntas estructuradas: bloquean el turno igual que un permiso ────
  if (event.type === "question.asked" || event.type === "question.v2.asked") {
    if (props.sessionID !== _sessionId) return;
    respondToOpenCodeQuestion(props);
    return;
  }

  // ── Permisos: OpenCode detiene la herramienta hasta recibir respuesta ──
  // El bug que esto evita: sin este manejador, una petición de permiso
  // (p. ej. escribir fuera de la carpeta del curso) se queda esperando
  // para siempre y el turno completo se cuelga con "Jintia Chat
  // trabajando…" sin límite, sin ningún indicio de qué lo bloquea.
  if (event.type === "permission.asked" || event.type === "permission.v2.asked") {
    if (props.sessionID !== _sessionId) return;
    respondToOpenCodePermission(props);
    return;
  }

  // ── Rastrear qué part está activo (abierto/cerrado) ──────────────────
  if (event.type === "message.part.updated") {
    const part = props.part || {};
    if (part.sessionID !== _sessionId) return;
    const nextPartId = part.id || null;
    // OpenCode puede abrir varios bloques de texto durante un mismo turno
    // (por ejemplo, antes y después de una consulta MCP). No los concatenamos:
    // cada bloque representa un mensaje independiente en el hilo.
    if (part.type === "text" && nextPartId && _currentPartId && nextPartId !== _currentPartId) {
      settleAssistantBubble();
    }
    if (nextPartId) _currentPartId = nextPartId;
    if (!part.time?.end) {
      // Part abierto: marcar tipo activo
      _currentPartType = part.type; // "reasoning", "text", "step-start", etc.
      // "step-start"/"step-finish" y otros tipos internos de OpenCode son
      // marcadores de control sin contenido legible: no deben mostrarse
      // como actividad (evita filtrar nombres técnicos crudos al usuario).
      if (part.type === "reasoning" || part.type === "tool") {
        const label = part.type === "reasoning" ? "Jintia Chat está razonando…" : `Jintia Chat está usando una herramienta${part.tool ? ` (${part.tool})` : ""}…`;
        setStatus(label.replaceAll("OpenCode", "Jintia Chat"), "working");
        appendRuntimeActivity(label);
        // Desde aquí en adelante no es seguro repetir el prompt original si
        // hay que cambiar de modelo: ya se ejecutó (o se está ejecutando)
        // una herramienta que puede haber modificado archivos.
        if (part.type === "tool") _turnSupervisor?.noteToolActivity();
      }
    } else {
      // Part cerrado
      _currentPartType = null;
    }
    return;
  }

  // ── Deltas de texto: todos llegan con field="text" ────────────────────
  // La distinción reasoning vs respuesta es por _currentPartType.
  if (event.type === "message.part.delta") {
    if (props.sessionID !== _sessionId) return;
    if (props.field !== "text") return;
    if (typeof props.delta !== "string" || !props.delta) return;

    if (_currentPartType === "text") {
      // Respuesta real → burbuja principal (texto plano durante el stream)
      if (!_assistantEl) {
        hideThinkingBubble();
        _assistantEl  = createAssistantBubble();
        _assistantRaw = "";
      }
      if (_assistantEl) {
        _assistantRaw += props.delta;
        _assistantEl.textContent = _assistantRaw;
        scrollFeed();
      }
    }
    // Ignorar deltas sin part activo (step-start, step-finish, etc.)
    return;
  }

  // ── Fin de sesión (idle) ──────────────────────────────────────────────
  if (event.type === "session.status") {
    if (props.sessionID !== _sessionId) return;
    const st = props.status?.type;
    if (st === "idle") {
      providerLog("opencode", "turn.completed", { sessionId: _sessionId, elapsedSeconds: _openCodeTurnStartedAt ? Math.floor((Date.now() - _openCodeTurnStartedAt) / 1000) : null });
      stopOpenCodeProgressTimer();
      clearOpenCodeStallWatchdog();
      _turnSupervisor = null;
      appendRuntimeActivity("Jintia Chat completó la respuesta.");
      settleAssistantBubble();
      _currentPartType = null;
      _busy = false;
      hideThinkingBubble();
      setSendEnabled(true);
      setAbortVisible(false);
      setStatus("Jintia Chat listo", "ready");
    }
    if (st === "retry") {
      // Forma confirmada en el propio código fuente de OpenCode
      // (packages/schema/src/session-status-event.ts):
      // { type: "retry", attempt, message, action?: {reason, provider, title, message, label, link?}, next }
      // "next" es el timestamp (ms) del próximo reintento automático.
      const status = props.status || {};
      const waitSecs = typeof status.next === "number" ? Math.max(0, Math.round((status.next - Date.now()) / 1000)) : null;
      const base = status.action?.message || status.message || "Jintia Chat está reintentando…";

      // OpenCode puede quedarse en este estado sin llegar nunca a
      // session.error (bug documentado de su propio retry policy). No
      // esperamos a que decida solo: si ya lleva ≥2 intentos, o el próximo
      // intento está demasiado lejos, tomamos el control y cambiamos de
      // modelo en vez de dejarlo reintentar indefinidamente.
      if (_turnSupervisor?.shouldInterceptRetry(status)) {
        providerLog("opencode", "turn.retry_intercepted", { attempt: status.attempt, next: status.next, model: _turnSupervisor.currentModel });
        triggerOpenCodeFailover("retry", status);
        return;
      }

      providerLog("opencode", "turn.retry", { attempt: status.attempt, message: base, next: status.next });
      appendRuntimeActivity(`${base}${status.attempt ? ` (intento ${status.attempt})` : ""}`, "warning");
      setStatus(waitSecs !== null ? `${base} (reintenta en ${waitSecs}s)` : base, "working");
      // Solo avisar con un toast la primera vez, para no bombardear en cada
      // reintento del backoff exponencial (hasta 5 intentos automáticos).
      if (status.attempt === 1) {
        toast(status.action?.title ? `${status.action.title}: ${base}` : `Jintia Chat: ${base}`, "warning", 6000);
      }
    }
    return;
  }

  // ── Error fatal de sesión ─────────────────────────────────────────────
  if (event.type === "session.error") {
    providerLog("opencode", "turn.error_event", props);
    if (props.sessionID !== _sessionId) return;

    // Antes de rendirse: ¿este fallo amerita cambiar de modelo automáticamente?
    // MCP (NotebookLM), errores de validación de Jintia o desbordamiento de
    // contexto NO cambian de modelo — cambiarlo no arregla nada en esos casos.
    const category = classifyFailure({
      statusCode: props.error?.data?.statusCode,
      name: props.error?.name,
      message: props.error?.message || props.message,
    });
    if (_turnSupervisor && isFailoverEligible(category)) {
      providerLog("opencode", "turn.error_failover", { category, model: _turnSupervisor.currentModel });
      triggerOpenCodeFailover("error", { category, message: props.error?.message || props.message });
      return;
    }

    appendRuntimeActivity(props.error?.message || props.message || "Jintia Chat reportó un error.", "error");
    stopOpenCodeProgressTimer();
    clearOpenCodeStallWatchdog();
    _turnSupervisor = null;
    settleAssistantBubble();
    _currentPartType = null;
    _currentPartId = null;
    _busy = false;
    hideThinkingBubble();
    setSendEnabled(true);
    setAbortVisible(false);
    setStatus("Error", "error");
    const msg = props.error?.message || props.message || "Error desconocido de Jintia Chat";
    appendErrorMessage(msg);
  }
}

// ── Failover automático de modelos ──────────────────────────────────────
// Decide qué hacer cuando el turno actual falla de una forma que amerita
// cambiar de modelo (ver src/opencode-failover.js para la política exacta):
// aborta la sesión en curso, elige el siguiente modelo disponible que no se
// haya intentado ya, y reenvía el turno con ese modelo — sin que el usuario
// tenga que reescribir el prompt ni tocar el selector manualmente. Si ya no
// queda ningún candidato, muestra el diagnóstico de todos los intentos.
async function triggerOpenCodeFailover(reason, statusOrError) {
  const supervisor = _turnSupervisor;
  if (!supervisor || !_course?.project_path || !_sessionId) return;

  const category = reason === "error" && statusOrError?.category
    ? statusOrError.category
    : reason === "retry"
      ? FailureCategory.RETRY_EXHAUSTED
      : FailureCategory.PROVIDER_TIMEOUT; // reason === "stall"
  const failMessage = statusOrError?.message
    || statusOrError?.action?.message
    || (reason === "retry" ? "OpenCode lleva demasiado tiempo reintentando." : "El modelo no respondió.");
  const retryAfterMs = typeof statusOrError?.next === "number"
    ? Math.max(0, statusOrError.next - Date.now())
    : undefined;

  supervisor.recordFailure(category, failMessage, { retryAfterMs });

  stopOpenCodeProgressTimer();
  clearOpenCodeStallWatchdog();
  try {
    await invoke("agent_abort", { coursePath: _course.project_path, sessionId: _sessionId });
  } catch (err) {
    providerLog("opencode", "failover.abort_error", { error: String(err) });
  }

  const next = supervisor.nextCandidate(_availableModels);
  if (!next) {
    _busy = false;
    _turnSupervisor = null;
    if (_assistantEl && _assistantRaw) finalizeAssistantBubble(_assistantEl, _assistantRaw);
    hideThinkingBubble();
    setSendEnabled(true);
    setAbortVisible(false);
    setStatus("Error", "error");
    const lines = supervisor.summary();
    appendErrorMessage(
      `No pude completar este turno con los modelos disponibles.\n\n${lines.join("\n")}`,
    );
    return;
  }

  const previousName = supervisor.currentModel?.name || supervisor.currentModel?.id || "El modelo";
  appendRuntimeActivity(`${previousName} no está disponible (${failMessage}). Continuando con ${next.name}…`, "warning");
  toast(`Cambiando a ${next.name}…`, "warning", 5000);

  supervisor.advanceTo({ id: next.id, providerID: next.provider_id, name: next.name });
  _selectedModel = supervisor.currentModel;
  const sel = el("jc-model-select");
  if (sel) sel.value = `${next.provider_id}|${next.id}`;

  const prompt = supervisor.buildRecoveryPrompt();
  try {
    await invoke("agent_send_message", {
      coursePath: _course.project_path,
      sessionId: _sessionId,
      message: prompt,
      modelProvider: supervisor.currentModel.providerID,
      modelId: supervisor.currentModel.id,
    });
    startOpenCodeProgressTimer();
    startOpenCodeStallWatchdog();
    setStatus(`Continuando con ${next.name}…`, "working");
  } catch (err) {
    // No se pudo ni siquiera aceptar el prompt: probablemente el propio
    // servidor OpenCode dejó de responder, no el modelo. Reiniciar el motor
    // en vez de agotar el resto de la lista de modelos contra un servidor caído.
    providerLog("opencode", "failover.resend_error", { error: String(err) });
    await recoverOpenCodeServer();
  }
}

// Reinicia el proceso de OpenCode cuando el servidor mismo dejó de responder
// (no un proveedor/modelo puntual). Crea una sesión nueva (la anterior murió
// con el proceso) y, si había un turno en curso, lo reanuda con el modelo
// que el failover ya había elegido.
async function recoverOpenCodeServer() {
  const supervisor = _turnSupervisor;
  if (!_course?.project_path) return;
  appendRuntimeActivity("Jintia Chat dejó de responder. Reiniciando el motor…", "warning");
  setStatus("Reiniciando el motor…", "working");
  try {
    const info = await invoke("agent_restart_engine", { coursePath: _course.project_path });
    if (info?.status !== "ready") throw new Error(`estado del motor tras reiniciar: ${info?.status}`);
    _port = info.port;
    connectSSE(_port);
    appendRuntimeActivity("Motor recuperado.", "info");

    if (supervisor) {
      // La sesión anterior murió con el proceso: crear una nueva (misma
      // función que usa el flujo normal, incluye refrescar el historial).
      const ok = await createSession();
      if (!ok) throw new Error("no se pudo crear una sesión nueva tras reiniciar");
      supervisor.sessionId = _sessionId;
      await invoke("agent_send_message", {
        coursePath: _course.project_path,
        sessionId: _sessionId,
        message: supervisor.buildRecoveryPrompt(),
        modelProvider: supervisor.currentModel?.providerID ?? null,
        modelId: supervisor.currentModel?.id ?? null,
      });
      startOpenCodeProgressTimer();
      startOpenCodeStallWatchdog();
      showThinkingBubble();
      setStatus(`Continuando con ${supervisor.currentModel?.name || "el modelo"}…`, "working");
    } else {
      setStatus("Jintia Chat listo", "ready");
    }
  } catch (err) {
    providerLog("opencode", "failover.restart_error", { error: String(err) });
    _busy = false;
    _turnSupervisor = null;
    hideThinkingBubble();
    setSendEnabled(true);
    setAbortVisible(false);
    setStatus("Error", "error");
    appendErrorMessage("No se pudo recuperar Jintia Chat tras reiniciar el motor. Intenta de nuevo.");
  }
}

// ── Auto-conexión de notebook ─────────────────────────────────────────────
// Reutiliza la sesión de NotebookLM establecida en el onboarding.
// Si el curso ya tiene notebook_id → no hace nada.
// Si hay sesión activa y el curso no tiene notebook → muestra picker inline.
async function autoConnectNotebook() {
  if (_notebookChecked) return;
  _notebookChecked = true;

  // Curso ya vinculado: nada que hacer
  if (_course?.notebook_id) return;

  let auth;
  try {
    auth = await checkNotebookLMAuth();
  } catch {
    return; // MCP no disponible — ignorar silenciosamente
  }

  if (!auth.authenticated) {
    // Sin sesión: aviso suave en el feed, no bloquear el chat
    appendMessage(`
      <div class="ml-8 mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
        ${ic("triangle-alert", 14)}
        <span>Este curso no tiene NotebookLM vinculado y no hay sesión activa de Google. El chat funcionará sin contexto de fuentes.
          <a href="#" id="jc-nlm-goto-settings" class="ml-1 font-semibold underline">Configurar en Ajustes</a>
        </span>
      </div>`);
    document.getElementById("jc-nlm-goto-settings")?.addEventListener("click", e => {
      e.preventDefault();
      import("../router.js").then(m => m.navigate("settings"));
    });
    return;
  }

  // Hay sesión: cargar notebooks disponibles (biblioteca local primero)
  let notebooks = [];
  try {
    notebooks = await listNotebooksMcp();
  } catch {
    return;
  }

  if (!notebooks.length) return; // Sin notebooks configurados — no mostrar picker

  showNotebookPicker(notebooks);
}

function showNotebookPicker(notebooks) {
  const feed = el("jc-activity-feed");
  if (!feed) return;

  const card = document.createElement("div");
  card.id = "jc-notebook-picker";
  card.className = "mb-4 jc-msg-in";
  card.innerHTML = `
    <div class="ml-8 rounded-xl border border-teal-200 bg-teal-50 px-4 py-3">
      <div class="mb-2 flex items-center gap-2 text-[12px] font-semibold text-teal-800">
        ${ic("book-open", 14)} Vincular NotebookLM a este curso
      </div>
      <p class="mb-2.5 text-[11.5px] text-teal-700 leading-relaxed">
        Selecciona el notebook con los materiales de esta asignatura. Jintia lo usará como contexto para todas las respuestas.
      </p>
      <div class="flex items-center gap-2 flex-wrap">
        <select id="jc-nb-select" class="flex-1 min-w-0 rounded-lg border border-teal-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-400">
          <option value="">— Selecciona un notebook —</option>
          ${notebooks.map(nb => `<option value="${escapeHtml(nb.id)}" data-url="${escapeHtml(nb.url || "")}" data-name="${escapeHtml(nb.name || nb.id)}">${escapeHtml(nb.name || nb.id)}</option>`).join("")}
        </select>
        <button id="jc-nb-save" class="${cx(ui.button.base, ui.button.primary, ui.button.sm)}" disabled>
          ${ic("link-2", 14)} Vincular
        </button>
        <button id="jc-nb-scan" class="${cx(ui.button.base, ui.button.ghost, ui.button.sm)}" title="Buscar más en tu cuenta Google">
          ${ic("refresh-cw", 12)} Buscar más
        </button>
        <button id="jc-nb-skip" class="${cx(ui.button.base, ui.button.ghost, ui.button.sm)} text-slate-400">
          Omitir
        </button>
      </div>
      <div id="jc-nb-scanning" class="hidden mt-2 text-[11px] text-teal-600">Buscando en tu cuenta…</div>
    </div>`;

  feed.appendChild(card);
  refreshIcons();
  scrollFeed();

  const select = card.querySelector("#jc-nb-select");
  const saveBtn = card.querySelector("#jc-nb-save");
  const scanBtn = card.querySelector("#jc-nb-scan");
  const skipBtn = card.querySelector("#jc-nb-skip");
  const scanMsg = card.querySelector("#jc-nb-scanning");

  select?.addEventListener("change", () => {
    if (saveBtn) saveBtn.disabled = !select.value;
  });

  saveBtn?.addEventListener("click", async () => {
    const opt = select.options[select.selectedIndex];
    if (!opt?.value) return;
    const notebookId  = opt.value;
    const notebookUrl  = opt.dataset.url || "";
    const notebookName = opt.dataset.name || notebookId;
    await linkNotebookToCourse(notebookId, notebookName, notebookUrl);
    card.remove();
  });

  scanBtn?.addEventListener("click", async () => {
    if (scanMsg) scanMsg.classList.remove("hidden");
    if (scanBtn) scanBtn.disabled = true;
    try {
      const more = await listAccountNotebooksMcp();
      // Fusionar con los ya existentes en el select
      const existing = new Set([...select.options].map(o => o.value).filter(Boolean));
      more.forEach(nb => {
        if (!existing.has(nb.id)) {
          const opt = document.createElement("option");
          opt.value = nb.id;
          opt.dataset.url = nb.url || "";
          opt.dataset.name = nb.name || nb.id;
          opt.textContent = nb.name || nb.id;
          select.appendChild(opt);
        }
      });
      if (scanMsg) scanMsg.textContent = `${more.length} notebook(s) encontrados en tu cuenta.`;
    } catch (e) {
      if (scanMsg) scanMsg.textContent = `No se pudo buscar: ${e}`;
    } finally {
      if (scanBtn) scanBtn.disabled = false;
    }
  });

  skipBtn?.addEventListener("click", () => card.remove());
}

async function linkNotebookToCourse(notebookId, notebookName, notebookUrl) {
  if (!_course) return;

  // Actualizar state.courses
  const idx = state.courses.findIndex(c => c.project_path === _course.project_path);
  if (idx !== -1) {
    state.courses[idx] = {
      ...state.courses[idx],
      notebook_id:   notebookId,
      notebook_name: notebookName,
      notebook_url:  notebookUrl,
    };
    _course = state.courses[idx];

    // Persistir en localStorage (igual que courses.js)
    try { saveCourses(); } catch {}

    // Sincronizar notebooks.json en disco (para que OpenCode lo lea)
    const entries = state.courses
      .filter(c => String(c.notebook_id || "").trim() && String(c.project_path || "").trim())
      .map(c => ({
        courseCode:  c.code,
        courseName:  c.name,
        rootPath:    c.project_path,
        notebookId:  c.notebook_id,
        notebookUrl: c.notebook_url || "",
      }));
    try {
      await saveNotebooksConfig(entries);
    } catch (e) {
      toast(`Notebook vinculado, pero no se pudo actualizar notebooks.json: ${e}`, "error", 7000);
      return;
    }
  }

  toast(`NotebookLM vinculado: ${notebookName}`, "success", 4000);
  renderSourcesPanel();
}

// ── Conectar y mostrar saludo ─────────────────────────────────────────────
async function connectAndGreet(coursePath) {
  const ok = await startRuntime(coursePath);
  if (ok) {
    setSendEnabled(true);
    const newBtn = el("jc-btn-new-session");
    if (newBtn) newBtn.disabled = false;
    clearFeed();
    const course = (state.courses || []).find(c => c.project_path === coursePath) || _course;
    appendGreetingMessage(`Hola, soy Jintia. Estoy lista para trabajar contigo en **${course?.name || course?.code || "tu asignatura"}**, dentro de **${weekLabel()}**. Puedo ayudarte a preguntar, crear, revisar o validar materiales usando el contexto disponible.`);
    renderSourcesPanel();
    autoConnectNotebook();
    el("jc-input")?.focus();
  }
}

// ── Iniciar runtime OpenCode ───────────────────────────────────────────────
async function startRuntime(coursePath) {
  providerLog("opencode", "runtime.start", { coursePath });
  setStatus("Iniciando Jintia Chat…", "working");
  const connectBtn = el("jc-btn-connect");
  if (connectBtn) connectBtn.disabled = true;
  try {
    const info = await invoke("opencode_start_course", { coursePath });
    providerLog("opencode", "runtime.result", info);
    _runtimeReady = info.status === "ready";
    _port = info.port;
    if (_runtimeReady) {
      connectSSE(_port);
      loadModels(coursePath);      // sin await — paralelo
      syncPanelLayout({ force: true });
      loadSessions(coursePath);    // sin await — paralelo
    }
    setStatus(_runtimeReady ? "Jintia Chat listo" : "Offline", _runtimeReady ? "ready" : "error");
    if (!_runtimeReady) {
      console.error("[jintia-chat] opencode_start_course no retornó ready:", info);
      if (connectBtn) connectBtn.disabled = false;
    }
    return _runtimeReady;
  } catch (err) {
    providerLog("opencode", "runtime.error", { error: String(err), coursePath });
    setStatus("Error al iniciar", "error");
    console.error("[jintia-chat] opencode_start_course error:", err);
    toast(String(err), "error", 9000);
    if (connectBtn) connectBtn.disabled = false;
    return false;
  }
}

async function createSession() {
  if (!_course?.project_path) return false;
  const weekEl = el("jc-week-select");
  const week = weekEl?.value || null;
  try {
    providerLog("opencode", "session.create", { coursePath: _course.project_path, week });
    const session = await invoke("agent_create_session", {
      coursePath: _course.project_path,
      week,
    });
    _sessionId = session.id;
    providerLog("opencode", "session.created", { sessionId: _sessionId });
    // Refrescar historial con la nueva sesión
    loadSessions(_course.project_path);
    return true;
  } catch (err) {
    providerLog("opencode", "session.create_error", { error: String(err) });
    console.error("[jintia-chat] agent_create_session error:", err);
    toast("No se pudo crear la sesión: " + String(err), "error", 6000);
    return false;
  }
}

// ── Codex (ChatGPT sin API key) ───────────────────────────────────────────

function updateProviderUI() {
  const isCodex = _provider === "codex";
  const isClaude = _provider === "claude";
  const modelSel = el("jc-model-select");
  if (modelSel) {
    if (isClaude) {
      populateClaudeModels();
      modelSel.title = "Modelo de Claude Code";
    } else {
      // Para Codex, loadCodexModels() habilita el select en cuanto llega el catálogo real.
      modelSel.disabled = isCodex ? true : !_runtimeReady;
      modelSel.title = isCodex ? "Modelo de Codex (ChatGPT)" : "Modelo de IA (Jintia Chat)";
    }
  }
  const effortField = el("jc-effort-field");
  if (effortField) effortField.hidden = !isCodex;
  const detail = el("jc-engine-detail");
  if (detail) detail.textContent = isClaude
    ? "Motor: Claude Code con tu sesión de Claude. Puede leer y editar archivos de la asignatura sin pedir confirmación por cada acción."
    : isCodex
      ? "Motor: Codex con tu sesión de ChatGPT"
      : "Jintia Chat con motor OpenCode y Jintia Skill";
  const historySection = el("jc-history-section");
  if (historySection) historySection.hidden = isCodex || isClaude;
  syncPanelLayout({ force: true });
  _composerReady = isCodex || isClaude || _runtimeReady;
  updateComposerState();
}

// Puebla el selector de modelo con el catálogo fijo de Claude Code
// ("sonnet"/"opus"/automático): a diferencia de Codex no hay un comando
// model/list documentado y estable para pedirle el catálogo real al CLI.
function populateClaudeModels() {
  const modelSel = el("jc-model-select");
  if (!modelSel) return;
  modelSel.innerHTML = CLAUDE_MODELS
    .map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`)
    .join("");
  const saved = state.config?.claudeModel;
  const target = CLAUDE_MODELS.find(m => m.id === saved) || CLAUDE_MODELS[0];
  modelSel.value = target.id;
  modelSel.disabled = false;
  modelSel.onchange = () => {
    state.config = { ...state.config, claudeModel: modelSel.value };
    saveConfig();
  };
}

// Carga el catálogo real de modelos de Codex (model/list) y puebla el
// selector de modelo y, según el modelo elegido, el de esfuerzo de
// razonamiento (supportedReasoningEfforts). Preferencia persistida en
// state.config para recordarla entre sesiones, igual que includeJintiaCredit.
async function loadCodexModels() {
  const modelSel = el("jc-model-select");
  if (!modelSel) return;
  try {
    const result = await invoke("codex_list_models");
    const models = result?.data || [];
    if (!models.length) {
      modelSel.innerHTML = `<option value="">Sin modelos disponibles</option>`;
      modelSel.disabled = true;
      return;
    }
    modelSel.innerHTML = models
      .map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.displayName || m.id)}</option>`)
      .join("");

    const saved = state.config?.codexModel;
    const target = models.find(m => m.id === saved) || models.find(m => m.isDefault) || models[0];
    modelSel.value = target.id;
    modelSel.disabled = false;
    populateCodexEfforts(target);
    // Por si refreshCodexRateLimits() ya sabía que la cuenta está sin cupo
    // antes de que terminara de cargar el catálogo: no reactivar el selector.
    applyCodexRateLimitUI();

    modelSel.onchange = () => {
      const found = models.find(m => m.id === modelSel.value);
      if (!found) return;
      state.config = { ...state.config, codexModel: found.id };
      saveConfig();
      populateCodexEfforts(found);
    };
  } catch (e) {
    modelSel.innerHTML = `<option value="">No se pudo cargar</option>`;
    modelSel.disabled = true;
    console.error("[jintia-chat] codex_list_models error:", e);
  }
}

const CODEX_EFFORT_LABELS = {
  none: "Ninguno", minimal: "Mínimo", low: "Bajo", medium: "Medio",
  high: "Alto", xhigh: "Extra alto", max: "Máximo", ultra: "Ultra",
};

function populateCodexEfforts(model) {
  const effortSel = el("jc-effort-select");
  if (!effortSel) return;
  const efforts = model.supportedReasoningEfforts || [];
  if (!efforts.length) {
    effortSel.innerHTML = `<option value="">No aplica</option>`;
    effortSel.disabled = true;
    return;
  }
  effortSel.innerHTML = efforts
    .map(e => `<option value="${escapeHtml(e.reasoningEffort)}" title="${escapeHtml(e.description || "")}">${escapeHtml(CODEX_EFFORT_LABELS[e.reasoningEffort] || e.reasoningEffort)}</option>`)
    .join("");

  const saved = state.config?.codexEffort;
  const target = efforts.some(e => e.reasoningEffort === saved)
    ? saved
    : (model.defaultReasoningEffort || efforts[0].reasoningEffort);
  effortSel.value = target;
  effortSel.disabled = false;
  effortSel.onchange = () => {
    state.config = { ...state.config, codexEffort: effortSel.value };
    saveConfig();
  };
}

/**
 * Lee la cuota real de la cuenta (account/rateLimits/read) y aplica el
 * resultado a la UI: si la cuenta ya no tiene cupo, bloquea el selector de
 * modelo/esfuerzo y el envío de mensajes, mostrando cuándo vuelve a estar
 * disponible. El límite de Codex es por cuenta completa, no por modelo
 * individual — por eso se bloquea el selector entero, no una opción suelta.
 */
async function refreshCodexRateLimits() {
  try {
    _codexRateLimits = await invoke("codex_read_rate_limits");
  } catch (e) {
    console.error("[jintia-chat] codex_read_rate_limits error:", e);
    return;
  }
  applyCodexRateLimitUI();
}

function applyCodexRateLimitUI() {
  const usageEl = el("jc-codex-usage");
  const modelSel = el("jc-model-select");
  const effortSel = el("jc-effort-select");
  if (!usageEl) return;

  clearInterval(_codexRateLimitTickTimer);
  _codexRateLimitTickTimer = null;

  const summary = usageSummary(_codexRateLimits);
  if (!summary) {
    usageEl.hidden = true;
    return;
  }

  const limited = isRateLimited(_codexRateLimits);
  usageEl.hidden = false;
  usageEl.textContent = summary;
  usageEl.className = `text-xs font-semibold ${limited ? "text-red-700" : "text-slate-500"}`;

  if (modelSel) modelSel.disabled = limited || !modelSel.options.length || modelSel.options[0].value === "";
  if (effortSel && limited) effortSel.disabled = true;

  if (_provider === "codex") {
    setSendEnabled(!limited);
    if (limited) setStatus(summary, "error");
  }

  if (limited) {
    // Recalcula el texto de la cuenta regresiva sin volver a preguntarle al
    // servidor; cuando pasa la hora de reinicio, sí vuelve a consultar para
    // confirmar y reactivar el selector.
    _codexRateLimitTickTimer = setInterval(() => {
      const resetsAt = primaryWindow(_codexRateLimits)?.resetsAt;
      if (resetsAt && resetsAt * 1000 <= Date.now()) {
        void refreshCodexRateLimits();
        return;
      }
      const fresh = usageSummary(_codexRateLimits);
      if (fresh) {
        usageEl.textContent = fresh;
        if (_provider === "codex") setStatus(fresh, "error");
      }
    }, 30000);
  }
}

async function startCodexIfNeeded() {
  try {
    setStatus("Verificando Codex…", "working");
    const s = await invoke("codex_status");
    if (!s.installed) {
      setStatus("Codex no está instalado", "error");
      toast("Codex CLI no está instalado. Ve a Ajustes > Conexiones para instalarlo.", "error", 10000);
      return false;
    }
    if (!s.running) {
      setStatus("Iniciando Codex app-server…", "working");
      const r = await invoke("codex_start");
      if (!r.success) {
        setStatus("No se pudo iniciar Codex", "error");
        toast(`No se pudo iniciar Codex: ${r.message}`, "error", 8000);
        return false;
      }
    }
    setStatus("Verificando sesión de ChatGPT…", "working");
    const fresh = await invoke("codex_status");
    if (!fresh.logged_in) {
      setStatus("Codex sin sesión de ChatGPT", "error");
      toast("Codex activo pero sin sesión de ChatGPT. Ve a Ajustes > Conexiones > Conectar ChatGPT.", "warning", 10000);
    }
    return true;
  } catch (e) {
    setStatus("Error al conectar con Codex", "error");
    toast(`Error al verificar Codex: ${e}`, "error", 8000);
    return false;
  }
}

/**
 * El límite de Codex es por cuenta completa (confirmado con account/rateLimits/read
 * contra una cuenta real: un único limitId "codex" cubre todos los modelos del
 * plan) — no hay "otro modelo de Codex" al que cambiar cuando se agota. OpenCode
 * sí tiene una cuota independiente (usa las claves de API que configuró el
 * docente), así que ahí sí tiene sentido saltar automáticamente.
 */
async function fallbackToOpenCodeDueToRateLimit(reason) {
  if (_provider !== "codex") return;
  toast(reason, "warning", 9000);
  _provider = "opencode";
  state.config = { ...state.config, provider: "opencode" };
  saveConfig();
  const providerSelect = el("jc-provider-select");
  if (providerSelect) providerSelect.value = "opencode";
  resetConversation();
  updateProviderUI();
  if (_course?.project_path) await connectAndGreet(_course.project_path);
}

/**
 * Conecta con Codex de inmediato (app-server + hilo) en vez de esperar al
 * primer mensaje. Se llama al seleccionar el proveedor y, como red de
 * seguridad idempotente, también antes de enviar cada mensaje: si ya está
 * conectado, resuelve de inmediato sin volver a golpear el app-server.
 */
async function connectCodexEagerly() {
  if (_codexConnecting) return _codexConnecting;
  if (_codexThreadId) return true;

  _codexConnecting = (async () => {
    setSendEnabled(false);
    try {
      const ok = await startCodexIfNeeded();
      if (!ok) return false;

      void loadCodexModels();
      await refreshCodexRateLimits();
      if (isRateLimited(_codexRateLimits)) {
        const summary = usageSummary(_codexRateLimits) || "sin cupo";
        await fallbackToOpenCodeDueToRateLimit(`Codex ${summary}. Cambiando a OpenCode automáticamente.`);
        return false;
      }

      const cwd = _course?.project_path;
      if (!cwd) {
        setStatus("Selecciona una asignatura", "neutral");
        return false;
      }

      if (!_codexThreadId) {
        setStatus("Creando conversación con ChatGPT…", "working");
        try {
          _codexThreadId = await invoke("codex_start_thread", { cwd });
        } catch (e) {
          setStatus("No se pudo crear el hilo Codex", "error");
          toast(`No se pudo crear el hilo Codex: ${e}`, "error", 6000);
          return false;
        }
        await ensureCodexListener();
      }

      setStatus("ChatGPT listo", "ready");
      return true;
    } finally {
      setSendEnabled(true);
      _codexConnecting = null;
    }
  })();

  return _codexConnecting;
}

// Vigilante por tiempo: pase lo que pase con los eventos de Codex (proceso
// caído, evento con nombre inesperado, cuenta sin sesión, lo que sea), el
// usuario nunca debe quedarse mirando "pensando" en silencio absoluto. Se
// arma al enviar un turno y se desarma en cuanto llega cualquier evento real
// (delta, turn.completed, error, aprobación).
function startCodexThinkingWatchdog() {
  clearCodexThinkingWatchdog();
  _codexWatchdogTimers.push(setTimeout(() => {
    if (!_busy || _provider !== "codex") return;
    setStatus("Codex sigue trabajando (>20s)…", "working");
  }, 20000));
  _codexWatchdogTimers.push(setTimeout(async () => {
    if (!_busy || _provider !== "codex") return;
    toast(
      "Codex no respondió en más de un minuto. Puede que tu cuenta tenga un problema (límite de uso, sesión caducada) o que el proceso se haya caído.",
      "warning",
      12000,
    );
    try {
      const s = await invoke("codex_status");
      if (!s.running || !s.logged_in) {
        _busy = false;
        _codexTurnId = null;
        hideThinkingBubble();
        setSendEnabled(true);
        setAbortVisible(false);
        setStatus(!s.running ? "Codex se desconectó" : "Sesión de ChatGPT perdida", "error");
      }
    } catch {}
  }, 60000));
}

function clearCodexThinkingWatchdog() {
  _codexWatchdogTimers.forEach(clearTimeout);
  _codexWatchdogTimers = [];
}

async function sendMessageViaCodex(text) {
  const cwd = _course?.project_path;
  if (!cwd) return;

  // Red de seguridad: si la conexión ansiosa al elegir el proveedor falló o
  // no llegó a completarse, se reintenta aquí antes de enviar.
  const ok = await connectCodexEagerly();
  if (!ok) {
    _busy = false;
    restorePrompt(text);
    setSendEnabled(true);
    setAbortVisible(false);
    return;
  }

  showThinkingBubble();
  _codexCommandOutput = new Map();
  _codexLegacyWarningShown = false;
  setStatus("ChatGPT está pensando…", "working");
  startCodexThinkingWatchdog();

  try {
    const model = el("jc-model-select")?.value || null;
    const effort = el("jc-effort-select")?.value || null;
    const jintiaMessage = `Usa explícitamente $jintia-skill para esta solicitud de Ask Jintia. Sigue su motor editorial vigente: guide.json → HTML → Vivliostyle; no crees una guía LaTeX ni uses pdflatex.\n\nSolicitud del usuario:\n${text}`;
    const startedTurnId = await invoke("codex_submit_turn", { threadId: _codexThreadId, message: jintiaMessage, model, effort });
    if (_busy) _codexTurnId = startedTurnId;
  } catch (e) {
    _busy = false;
    restorePrompt(text);
    hideThinkingBubble();
    setSendEnabled(true);
    setAbortVisible(false);
    setStatus("Error", "error");
    toast(`No se pudo enviar a Codex: ${e}`, "error", 6000);
  }
}

async function ensureCodexListener() {
  if (_codexUnlisten.length) {
    console.log("[codex-js] ensureCodexListener: ya registrado, no se repite");
    return;
  }
  console.log("[codex-js] ensureCodexListener: registrando listeners de Codex");
  const deltaUnlisten = await listen("codex:item/agentMessage/delta", (event) => {
    console.log("[codex-js] evento item.agentMessage.delta", event.payload);
    const params = event.payload?.params || {};
    if (params.threadId !== _codexThreadId) return;
    if (_codexTurnId && params.turnId !== _codexTurnId) return;
    clearCodexThinkingWatchdog();
    hideThinkingBubble();
    if (!_assistantEl) {
      _assistantEl = createAssistantBubble();
      _assistantRaw = "";
    }
    _assistantRaw += params.delta || "";
    _assistantEl.textContent = _assistantRaw;
    scrollFeed();
  });
  const completedUnlisten = await listen("codex:turn/completed", (event) => {
    console.log("[codex-js] evento turn.completed", event.payload);
    const params = event.payload?.params || {};
    const turn = params.turn || {};
    if (params.threadId && params.threadId !== _codexThreadId) return;
    if (_codexTurnId && turn.id && turn.id !== _codexTurnId) return;

    clearCodexThinkingWatchdog();
    hideThinkingBubble();
    const failed = turn.status === "failed";
    if (_assistantEl && _assistantRaw) {
      finalizeAssistantBubble(_assistantEl, _assistantRaw);
    } else if (failed) {
      appendErrorMessage(turn.error?.message || "Codex no pudo completar esta respuesta.");
    } else {
      const text = (turn.items || [])
        .filter(item => item.type === "agentMessage")
        .map(item => item.text || "")
        .join("\n")
        .trim();
      if (text) appendAssistantMessage(text);
    }
    _assistantEl = null;
    _assistantRaw = "";
    _codexCommandOutput.clear();
    _codexTurnId = null;
    _busy = false;
    setSendEnabled(true);
    setAbortVisible(false);
    setStatus(failed ? "Error en Codex" : turn.status === "interrupted" ? "Respuesta detenida" : "ChatGPT listo", failed ? "error" : "ready");

    // Si el límite llegó a mitad de una conversación (no se detectó al
    // conectar), saltar a OpenCode ahora en vez de dejar el chat sin salida.
    if (failed && turn.error?.codexErrorInfo === "usageLimitExceeded") {
      void refreshCodexRateLimits();
      void fallbackToOpenCodeDueToRateLimit("Codex se quedó sin cupo. Cambiando a OpenCode automáticamente.");
    }
  });

  const itemStartedUnlisten = await listen("codex:item/started", (event) => {
    const params = event.payload?.params || {};
    if (params.threadId && params.threadId !== _codexThreadId) return;
    const item = params.item || {};
    if (item.type !== "commandExecution") return;
    clearCodexThinkingWatchdog();
    const command = commandFromCodexParams(params);
    updateThinkingActivity({
      message: isLegacyLatexCommand(command) ? "Codex intenta ejecutar una herramienta heredada." : "Codex está ejecutando una herramienta…",
      detail: command || "Preparando el comando.",
      technical: command,
      tone: isLegacyLatexCommand(command) ? "warning" : "working",
    });
    setStatus("Codex está ejecutando una herramienta…", "working");
  });

  const commandOutputUnlisten = await listen("codex:item/commandExecution/outputDelta", (event) => {
    const params = event.payload?.params || {};
    if (params.threadId && params.threadId !== _codexThreadId) return;
    const itemId = params.itemId || "current";
    const output = `${_codexCommandOutput.get(itemId) || ""}${params.delta || ""}`;
    _codexCommandOutput.set(itemId, output.slice(-12000));
    const summary = summarizeCodexOutput(output);
    updateThinkingActivity({ ...summary, technical: trimCodexTechnicalOutput(output) });
    setStatus(summary.message, summary.tone === "warning" ? "error" : "working");
    if (summary.legacy && !_codexLegacyWarningShown) {
      _codexLegacyWarningShown = true;
      toast("Codex intentó usar LaTeX. Jintia actual debe trabajar con guide.json, HTML y Vivliostyle.", "warning", 12000);
    }
  });

  const itemCompletedUnlisten = await listen("codex:item/completed", (event) => {
    const params = event.payload?.params || {};
    if (params.threadId && params.threadId !== _codexThreadId) return;
    const item = params.item || {};
    if (item.type !== "commandExecution") return;
    const output = item.aggregatedOutput || _codexCommandOutput.get(item.id) || "";
    const failed = item.status === "failed" || (Number.isInteger(item.exitCode) && item.exitCode !== 0);
    if (failed) {
      const summary = summarizeCodexOutput(output);
      updateThinkingActivity({
        message: summary.message || "Una herramienta de Codex terminó con error.",
        detail: summary.detail || "Codex puede corregir el problema o solicitar otra acción.",
        technical: trimCodexTechnicalOutput(output),
        tone: "warning",
      });
      setStatus("Una herramienta falló; Codex continúa revisando…", "working");
    } else {
      updateThinkingActivity({
        message: "La herramienta terminó; Codex está revisando el resultado…",
        detail: commandFromCodexParams(params),
        technical: trimCodexTechnicalOutput(output),
      });
    }
  });

  const diffUnlisten = await listen("codex:turn/diff/updated", (event) => {
    const params = event.payload?.params || {};
    if (params.threadId && params.threadId !== _codexThreadId) return;
    const files = changedFilesFromCodexDiff(params.diff);
    if (!files.length) return;
    updateThinkingActivity({
      message: `Codex preparó cambios en ${files.length} ${files.length === 1 ? "archivo" : "archivos"}.`,
      detail: files.slice(0, 4).join(" · ") + (files.length > 4 ? ` · +${files.length - 4}` : ""),
    });
  });

  // Codex también envía PETICIONES servidor→cliente cuando necesita permiso
  // para ejecutar un comando o modificar archivos. Si no se responden,
  // Codex se queda esperando para siempre y el chat parece colgado sin
  // ningún mensaje de error — por eso hay que escucharlas y contestar
  // siempre, tanto si se aprueba como si se deniega.
  const execApprovalUnlisten = await listen("codex:execCommandApproval", (event) => respondToCodexApproval(event, {
    title: "Codex quiere ejecutar un comando",
    describe: params => {
      const command = Array.isArray(params.command) ? params.command.join(" ") : (params.command || "(comando no especificado)");
      return `${params.reason ? params.reason + "\n\n" : ""}$ ${command}\n\nCarpeta: ${params.cwd || "—"}`;
    },
  }));
  const patchApprovalUnlisten = await listen("codex:applyPatchApproval", (event) => respondToCodexApproval(event, {
    title: "Codex quiere modificar archivos",
    describe: params => {
      const files = (params.fileChanges || [])
        .map(f => (typeof f === "string" ? f : f?.path || JSON.stringify(f)))
        .join("\n");
      return `${params.reason ? params.reason + "\n\n" : ""}${files || "(sin detalle de archivos)"}`;
    },
  }));
  const commandApprovalUnlisten = await listen("codex:item/commandExecution/requestApproval", (event) => {
    const presentation = approvalPresentation(event.payload?.params || {});
    return respondToCodexApproval(event, {
      title: presentation.title,
      describe: () => presentation.message,
      allowDecision: "accept",
      denyDecision: "cancel",
      legacy: presentation.legacy,
    });
  });
  const fileApprovalUnlisten = await listen("codex:item/fileChange/requestApproval", (event) => respondToCodexApproval(event, {
    title: "Codex quiere modificar archivos",
    describe: params => params.reason || "Codex solicita autorización para modificar archivos de la asignatura.",
    allowDecision: "accept",
    denyDecision: "cancel",
  }));

  const threadStatusUnlisten = await listen("codex:thread/status/changed", (event) => {
    const params = event.payload?.params || {};
    if (params.threadId && params.threadId !== _codexThreadId) return;
    if (params.status?.activeFlags?.includes("waitingOnApproval")) {
      updateThinkingActivity({
        message: "Codex está esperando tu autorización.",
        detail: "Revisa el diálogo de permiso para continuar o denegar la acción.",
        tone: "warning",
      });
      setStatus("Esperando autorización…", "working");
    }
  });

  // Notificación general de error de turno (método "error" en el protocolo
  // v2). Llega prácticamente junto con turn/completed (mismo error, casi al
  // mismo milisegundo), así que aquí solo se da el aviso más rápido posible
  // (badge de estado); es turn/completed quien de verdad cierra el turno y
  // pone el error en el chat — hacerlo también aquí duplicaría la burbuja.
  const errorUnlisten = await listen("codex:error", (event) => {
    console.log("[codex-js] evento error", event.payload);
    const params = event.payload?.params || {};
    if (params.threadId && params.threadId !== _codexThreadId) return;
    const message = params.error?.message || "Codex reportó un error.";
    if (params.willRetry) {
      toast(`Codex tuvo un problema y está reintentando: ${message}`, "warning", 6000);
      setStatus("Reintentando…", "working");
      return;
    }
    clearCodexThinkingWatchdog();
    setStatus("Error en Codex", "error");
  });

  // El app-server empuja esto solo cada vez que cambia la cuota, sin que
  // haya que volver a preguntar — así el badge se actualiza en vivo.
  const rateLimitsUnlisten = await listen("codex:account/rateLimits/updated", (event) => {
    const params = event.payload?.params || {};
    if (!params.rateLimits) return;
    _codexRateLimits = { rateLimits: params.rateLimits };
    applyCodexRateLimitUI();
  });

  _codexUnlisten = [
    deltaUnlisten, completedUnlisten, itemStartedUnlisten, commandOutputUnlisten,
    itemCompletedUnlisten, diffUnlisten, execApprovalUnlisten, patchApprovalUnlisten,
    commandApprovalUnlisten, fileApprovalUnlisten, threadStatusUnlisten,
    errorUnlisten, rateLimitsUnlisten,
  ];
}

/** Muestra el detalle de una petición de aprobación de Codex y le reenvía la decisión. */
async function respondToCodexApproval(event, {
  title,
  describe,
  allowDecision = "allow",
  denyDecision = "deny",
  legacy = false,
}) {
  const { id, params } = event.payload || {};
  if (params?.threadId && params.threadId !== _codexThreadId) return;
  clearCodexThinkingWatchdog();
  setStatus("Codex pide tu autorización…", "working");
  updateThinkingActivity({
    message: legacy ? "Codex solicita una herramienta heredada." : "Codex necesita tu autorización.",
    detail: legacy ? "Jintia recomienda denegar esta acción y continuar con Vivliostyle." : "Revisa el comando y la carpeta antes de decidir.",
    tone: "warning",
  });
  const allowed = await confirmDialog({
    title,
    message: describe(params || {}),
    confirmLabel: "Permitir",
    cancelLabel: "Denegar",
    danger: true,
  });
  try {
    await invoke("codex_respond_approval", { id, decision: allowed ? allowDecision : denyDecision });
    setStatus(allowed ? "Permiso concedido, continuando…" : "Permiso denegado, continuando…", "working");
  } catch (e) {
    toast(`No se pudo responder a Codex: ${e}`, "error", 6000);
  }
}

function teardownCodexListener() {
  _codexUnlisten.forEach(unlisten => unlisten());
  _codexUnlisten = [];
  clearInterval(_codexRateLimitTickTimer);
  _codexRateLimitTickTimer = null;
}

// ── Claude Code (suscripción de Claude, sin API key) ──────────────────────

/**
 * Contexto académico corto que se pasa como `--append-system-prompt`: deja
 * el mensaje del usuario limpio y le da a Claude la asignatura/semana activa
 * sin depender de que el usuario la repita en cada turno.
 */
function buildClaudeContext() {
  const subject = [_course?.code, _course?.name].filter(Boolean).join(" — ");
  const scope = _selectedWeek ? `Semana ${String(_selectedWeek).padStart(2, "0")}` : "Contexto general de la asignatura";
  return `Estás siendo usado desde Ask Jintia (Jintia Desktop).${subject ? ` Asignatura: ${subject}.` : ""} ${scope}. Usa la skill jintia-skill para las tareas académicas. Su motor vigente es guide.json → HTML → Vivliostyle; no generes guías LaTeX ni uses pdflatex.`;
}

async function startClaudeIfNeeded() {
  try {
    setStatus("Verificando Claude Code…", "working");
    providerLog("claude", "status.request");
    const s = await claudeStatus();
    providerLog("claude", "status.result", {
      installed: s?.installed,
      authenticated: s?.authenticated,
      version: s?.version,
      usingApiKey: s?.usingApiKey,
    });
    if (!s.installed) {
      setStatus("Claude Code no está instalado", "error");
      toast("Claude Code CLI no está instalado. Instálalo con: npm install -g @anthropic-ai/claude-code", "error", 10000);
      return false;
    }
    if (!s.authenticated) {
      setStatus("Claude Code sin sesión activa", "error");
      toast("Claude Code está instalado pero no tiene una sesión iniciada. Abre una terminal, ejecuta \"claude\" e inicia sesión con tu cuenta.", "warning", 10000);
      return false;
    }
    if (s.usingApiKey) {
      toast("Se detectó ANTHROPIC_API_KEY en el entorno: Claude Code usará esa clave de API en vez de tu sesión de suscripción.", "warning", 9000);
    }
    return true;
  } catch (e) {
    providerLog("claude", "status.error", { error: String(e) });
    setStatus("Error al conectar con Claude Code", "error");
    toast(`Error al verificar Claude Code: ${e}`, "error", 8000);
    return false;
  }
}

/**
 * A diferencia de Codex no hay un app-server que arrancar: solo hace falta
 * confirmar que el CLI está instalado y autenticado, y tener los listeners
 * de eventos registrados antes de enviar el primer turno.
 */
async function connectClaudeEagerly() {
  if (_claudeConnecting) return _claudeConnecting;

  _claudeConnecting = (async () => {
    providerLog("claude", "connect.start");
    setSendEnabled(false);
    try {
      const ok = await startClaudeIfNeeded();
      if (!ok) return false;
      await ensureClaudeListener();
      providerLog("claude", "listeners.ready");
      setStatus("Claude Code listo", "ready");
      return true;
    } finally {
      providerLog("claude", "connect.end", { ready: _composerReady });
      setSendEnabled(true);
      _claudeConnecting = null;
    }
  })();

  return _claudeConnecting;
}

// Igual que el vigilante de Codex: sin esto, si el proceso `claude` se cae o
// se cuelga sin emitir ningún evento, el usuario se queda mirando "pensando"
// para siempre sin ningún aviso.
function startClaudeThinkingWatchdog() {
  clearClaudeThinkingWatchdog();
  _claudeWatchdogTimers.push(setTimeout(() => {
    if (!_busy || _provider !== "claude") return;
    setStatus("Claude Code sigue trabajando (>20s)…", "working");
  }, 20000));
  _claudeWatchdogTimers.push(setTimeout(async () => {
    if (!_busy || _provider !== "claude") return;
    toast(
      "Claude Code no respondió en más de un minuto. El proceso puede haberse caído o la sesión puede haber caducado.",
      "warning",
      12000,
    );
    try {
      const s = await claudeStatus();
      if (!s.installed || !s.authenticated) {
        _busy = false;
        _claudeRequestId = null;
        hideThinkingBubble();
        setSendEnabled(true);
        setAbortVisible(false);
        setStatus(!s.installed ? "Claude Code no está instalado" : "Sesión de Claude perdida", "error");
      }
    } catch {}
  }, 60000));
}

function clearClaudeThinkingWatchdog() {
  _claudeWatchdogTimers.forEach(clearTimeout);
  _claudeWatchdogTimers = [];
}

async function sendMessageViaClaude(text) {
  const cwd = _course?.project_path;
  if (!cwd) return;

  // Red de seguridad: si la conexión ansiosa al elegir el proveedor falló o
  // no llegó a completarse, se reintenta aquí antes de enviar.
  const ok = await connectClaudeEagerly();
  if (!ok) {
    _busy = false;
    restorePrompt(text);
    setSendEnabled(true);
    setAbortVisible(false);
    return;
  }

  showThinkingBubble();
  setStatus("Claude Code está pensando…", "working");
  startClaudeThinkingWatchdog();

  _claudeRequestId = crypto.randomUUID();
  providerLog("claude", "turn.submit", {
    requestId: _claudeRequestId,
    sessionId: _claudeSessionId,
    cwd,
    model: el("jc-model-select")?.value || null,
    messageLength: text.length,
  });
  try {
    await claudeSubmitTurn({
      requestId: _claudeRequestId,
      sessionId: _claudeSessionId,
      cwd,
      message: text,
      model: el("jc-model-select")?.value || null,
      context: buildClaudeContext(),
    }, CLAUDE_TOOLS);
    providerLog("claude", "turn.accepted", { requestId: _claudeRequestId });
  } catch (e) {
    providerLog("claude", "turn.error", { requestId: _claudeRequestId, error: String(e) });
    _busy = false;
    _claudeRequestId = null;
    restorePrompt(text);
    hideThinkingBubble();
    clearClaudeThinkingWatchdog();
    setSendEnabled(true);
    setAbortVisible(false);
    setStatus("Error", "error");
    toast(`No se pudo enviar a Claude Code: ${e}`, "error", 6000);
  }
}

async function ensureClaudeListener() {
  if (_claudeDetach) return;
  _claudeDetach = await registerClaudeListeners({
    onSessionStarted: (payload) => {
      providerLog("claude", "event.session_started", payload);
      if (payload.requestId !== _claudeRequestId) return;
      _claudeSessionId = payload.sessionId;
    },
    onDelta: (payload) => {
      providerLog("claude", "event.delta", { requestId: payload.requestId, sessionId: payload.sessionId, textLength: payload.text?.length || 0 });
      if (payload.requestId !== _claudeRequestId) return;
      clearClaudeThinkingWatchdog();
      hideThinkingBubble();
      if (!_assistantEl) {
        _assistantEl = createAssistantBubble();
        _assistantRaw = "";
      }
      _assistantRaw += payload.text || "";
      _assistantEl.textContent = _assistantRaw;
      scrollFeed();
    },
    onRetry: (payload) => {
      providerLog("claude", "event.api_retry", payload);
      if (payload.requestId !== _claudeRequestId) return;
      toast("Claude Code tuvo un problema y está reintentando la solicitud.", "warning", 5000);
      setStatus("Reintentando…", "working");
    },
    onCompleted: (payload) => {
      providerLog("claude", "event.completed", { ...payload, result: payload.result?.slice?.(0, 300) });
      if (payload.requestId !== _claudeRequestId) return;
      clearClaudeThinkingWatchdog();
      hideThinkingBubble();
      if (payload.sessionId) _claudeSessionId = payload.sessionId;
      if (_assistantEl && _assistantRaw) {
        finalizeAssistantBubble(_assistantEl, _assistantRaw);
      } else if (!payload.success) {
        appendErrorMessage(payload.result || "Claude Code no pudo completar esta respuesta.");
      } else if (payload.result) {
        appendAssistantMessage(payload.result);
      }
      _assistantEl = null;
      _assistantRaw = "";
      _claudeRequestId = null;
      _busy = false;
      setSendEnabled(true);
      setAbortVisible(false);
      setStatus(payload.success ? "Claude Code listo" : "Error en Claude Code", payload.success ? "ready" : "error");
    },
    onError: (payload) => {
      providerLog("claude", "event.error", payload);
      if (payload.requestId !== _claudeRequestId) return;
      clearClaudeThinkingWatchdog();
      hideThinkingBubble();
      if (_assistantEl && _assistantRaw) {
        finalizeAssistantBubble(_assistantEl, _assistantRaw);
      } else {
        appendErrorMessage(payload.message || "Claude Code reportó un error.");
      }
      _assistantEl = null;
      _assistantRaw = "";
      _claudeRequestId = null;
      _busy = false;
      setSendEnabled(true);
      setAbortVisible(false);
      setStatus("Error en Claude Code", "error");
    },
  });
}

function teardownClaudeListener() {
  if (_claudeDetach) {
    _claudeDetach();
    _claudeDetach = null;
  }
  clearClaudeThinkingWatchdog();
}

// ── Enviar mensaje ─────────────────────────────────────────────────────────
async function sendMessage() {
  const input = el("jc-input");
  const text = (input?.value || "").trim();
  const ready = (_provider === "codex" || _provider === "claude") ? _composerReady : _runtimeReady;
  if (!text || !ready || _busy) return;

  if (_provider === "opencode" && !_sessionId) {
    const ok = await createSession();
    if (!ok) return;
  }

  input.value = "";
  input.style.height = "auto";
  appendMessage(messageHtml({ role: "user", parts: [{ type: "text", text }] }));
  _busy = true;
  updateComposerState();
  setAbortVisible(true);

  if (_provider === "codex") {
    await sendMessageViaCodex(text);
    return;
  }
  if (_provider === "claude") {
    await sendMessageViaClaude(text);
    return;
  }

  // Un turno nuevo, un supervisor nuevo: el failover de un turno anterior no
  // debe influir en este (aparte del circuit breaker global, que sí persiste).
  _turnSupervisor = new TurnSupervisor({
    originalPrompt: text,
    initialModel: _selectedModel,
    sessionId: _sessionId,
    registry: _modelHealthRegistry,
  });

  try {
    providerLog("opencode", "turn.submit", { coursePath: _course.project_path, sessionId: _sessionId, model: _selectedModel });
    providerLog("opencode", "turn.request", { sessionId: _sessionId, model: _selectedModel, messageLength: text.length });
    await invoke("agent_send_message", {
      coursePath: _course.project_path,
      sessionId: _sessionId,
      message: text,
      modelProvider: _selectedModel?.providerID ?? null,
      modelId: _selectedModel?.id ?? null,
    });
    startOpenCodeProgressTimer();
    startOpenCodeStallWatchdog();
    providerLog("opencode", "turn.accepted", { sessionId: _sessionId });
    showThinkingBubble();
    setStatus("Jintia está pensando…", "working");
  } catch (err) {
    providerLog("opencode", "turn.error", { error: String(err), sessionId: _sessionId });
    _turnSupervisor = null;
    _busy = false;
    restorePrompt(text);
    setSendEnabled(true);
    setAbortVisible(false);
    toast("Error al enviar: " + String(err), "error", 5000);
  }
}

// ── API pública ────────────────────────────────────────────────────────────
/** Llamado desde courses.js al hacer clic en el botón Jintia de un curso. */
export function setActiveCourse(course, week) {
  _course          = course;
  disconnectSSE();
  teardownCodexListener();
  teardownClaudeListener();
  _sessionId       = null;
  _runtimeReady    = false;
  _port            = 0;
  _busy            = false;
  _codexThreadId   = null;
  _codexTurnId     = null;
  _claudeSessionId = null;
  _claudeRequestId = null;
  _notebookChecked = false;
  _selectedWeek    = week ? String(week) : "";
  _sourceLinks.clear();

  requestAnimationFrame(() => {
    const sel = el("jc-course-select");
    if (sel && course?.project_path) sel.value = course.project_path;
    populateWeekSelect(course);
    const wSel = el("jc-week-select");
    if (wSel) wSel.value = _selectedWeek;
    updateContextSummary();
    renderSourcesPanel();
    setSendEnabled(false);
    const connectBtn = el("jc-btn-connect");
    if (connectBtn) connectBtn.disabled = true;
    el("jc-btn-new-session") && (el("jc-btn-new-session").disabled = true);
    if (course?.project_path) {
      if (_provider === "codex") prepareCodexConversation();
      else if (_provider === "claude") prepareClaudeConversation();
      else connectAndGreet(course.project_path);
    }
  });
}

// ── Renderizado principal ──────────────────────────────────────────────────
export function renderJintiaChat() {
  ensureChatStyles();
  disconnectSSE();
  teardownCodexListener();
  teardownClaudeListener();
  // El proveedor elegido persiste entre reinicios de la app; sin esto, cada
  // arranque vuelve a "opencode" en silencio y un mensaje enviado sin
  // reseleccionar Codex/Claude nunca pasa por ninguno de sus flujos ni feedback.
  _provider        = ["codex", "claude"].includes(state.config?.provider) ? state.config.provider : "opencode";
  _sessionId       = null;
  _runtimeReady    = false;
  _port            = 0;
  _busy            = false;
  _codexThreadId   = null;
  _codexTurnId     = null;
  _claudeSessionId = null;
  _claudeRequestId = null;
  _notebookChecked = false;
  _sourceLinks.clear();

  if (!_course) {
    _course = (state.courses || []).find(c => c.project_path) || null;
  }

  const weekCount = Math.min(52, Math.max(1, Number(_course?.weeks) || 16));
  const weeks = Array.from({ length: weekCount }, (_, i) => i + 1);
  const courseOptions = (state.courses || [])
    .filter(c => c.project_path)
    .map(c => `<option value="${escapeHtml(c.project_path)}">${escapeHtml([c.code, c.name].filter(Boolean).join(" · "))}</option>`)
    .join("");

  const container = el("p-jintia-chat");
  if (!container) return;

  container.innerHTML = `
    <div id="jc-chat-shell" class="relative flex h-full min-h-0 overflow-hidden bg-slate-50">

      <button id="jc-panel-scrim" type="button" class="jc-panel-scrim hidden" aria-label="Cerrar panel lateral" hidden></button>

      <div class="flex flex-1 flex-col min-w-0">
        <header class="shrink-0 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <div class="jc-context-controls flex flex-wrap items-end gap-3">
            <div class="jc-context-field min-w-[13rem] flex-1 max-w-sm"><label for="jc-course-select" class="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-600">Asignatura</label><select id="jc-course-select" class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-700/20">${courseOptions || '<option value="">Sin asignaturas preparadas</option>'}</select></div>
            <div class="jc-context-field min-w-[9rem]"><label for="jc-week-select" class="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-600">Semana</label><select id="jc-week-select" class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-700/20"><option value="">Contexto general</option>${weeks.map(w => `<option value="${w}">Semana ${String(w).padStart(2, "0")}</option>`).join("")}</select></div>
            <div class="ml-auto flex flex-wrap items-center gap-2">
              <button id="jc-toggle-sources" type="button" class="jc-touch-action inline-flex min-h-10 items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 text-xs font-bold text-teal-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600" aria-controls="jc-sources-panel" aria-expanded="false">${ic("book-open", 16)} <span id="jc-source-chip-label">Sin fuentes</span></button>
              <span id="jc-status-badge" role="status" aria-live="polite" aria-atomic="true" class="inline-flex min-h-8 items-center rounded-full border border-slate-300 bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700">Desconectado</span>
              <button id="jc-btn-connect" class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}"><span>Conectar</span></button>
              <button id="jc-btn-new-session" class="jc-touch-action ${cx(ui.button.base, ui.button.ghost, ui.button.sm)}" disabled>${ic("plus", 15)} Nueva conversación</button>
            </div>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500"><span id="jc-context-course" class="font-semibold text-slate-700"></span><span aria-hidden="true">/</span><span id="jc-context-week"></span><details class="ml-auto"><summary class="cursor-pointer font-semibold text-slate-600 hover:text-slate-900">Opciones avanzadas</summary><div class="absolute right-6 z-30 mt-2 w-72 space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xl"><div><label for="jc-provider-select" class="mb-1 block text-xs font-semibold text-slate-700">Proveedor de IA</label><select id="jc-provider-select" class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"><option value="opencode" ${_provider === "opencode" ? "selected" : ""}>OpenCode</option><option value="codex" ${_provider === "codex" ? "selected" : ""}>ChatGPT (Codex)</option><option value="claude" ${_provider === "claude" ? "selected" : ""}>Claude Code</option></select></div><div><label for="jc-model-select" class="mb-1 block text-xs font-semibold text-slate-700">Modelo</label><select id="jc-model-select" disabled class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs disabled:bg-slate-100"><option value="">Cargando modelo…</option></select></div><div id="jc-effort-field" hidden><label for="jc-effort-select" class="mb-1 block text-xs font-semibold text-slate-700">Esfuerzo de razonamiento</label><select id="jc-effort-select" disabled class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs disabled:bg-slate-100"><option value="">—</option></select></div><p id="jc-codex-usage" hidden class="text-xs font-semibold"></p><p id="jc-engine-detail" class="text-xs leading-relaxed text-slate-500"></p></div></details></div>
        </header>

        <div id="jc-activity-feed" role="log" aria-live="polite" aria-relevant="additions text" aria-busy="false" class="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div class="mx-auto flex min-h-full max-w-3xl flex-col items-center justify-center gap-5 py-10 text-center">
            <img src="/brand/jintia-mark.svg" alt="" class="h-14 w-14 rounded-2xl border border-teal-100 bg-white p-2 shadow-sm">
            <div><h2 class="text-xl font-semibold text-slate-900" style="font-family: var(--font-display, 'Syne', sans-serif);">¿Qué quieres construir hoy?</h2><p class="mt-2 max-w-xl text-sm leading-relaxed text-slate-600">Jintia combina el contexto de tu asignatura, la semana activa y las fuentes conectadas.</p></div>
            <div class="grid w-full max-w-2xl gap-2 sm:grid-cols-2">
              <button type="button" data-jc-starter="Resume los conceptos clave de esta semana usando las fuentes del curso." class="min-h-12 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-800 hover:border-teal-300 hover:bg-teal-50"><span class="text-teal-800">Preguntar</span> · conceptos clave</button>
              <button type="button" data-jc-starter="Propón una actividad práctica para esta semana." class="min-h-12 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-800 hover:border-teal-300 hover:bg-teal-50"><span class="text-teal-800">Crear</span> · actividad práctica</button>
              <button type="button" data-jc-starter="Revisa la guía activa y señala mejoras concretas." class="min-h-12 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-800 hover:border-teal-300 hover:bg-teal-50"><span class="text-teal-800">Revisar</span> · guía activa</button>
              <button type="button" data-jc-starter="Valida la guía activa y enumera los problemas que encuentres." class="min-h-12 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-800 hover:border-teal-300 hover:bg-teal-50"><span class="text-teal-800">Validar</span> · consistencia</button>
            </div>
          </div>
        </div>

        <div class="shrink-0 border-t border-slate-200 bg-white px-4 py-4 sm:px-6">
          <div class="mx-auto max-w-3xl"><label for="jc-input" class="mb-2 block text-xs font-bold text-slate-700">¿Qué quieres hacer con esta asignatura?</label><div class="flex items-end gap-2 rounded-2xl border border-slate-300 bg-white px-4 py-3 shadow-sm transition focus-within:border-teal-700 focus-within:ring-2 focus-within:ring-teal-700/20"><textarea id="jc-input" rows="1" placeholder="Ejemplo: revisa la guía y propone tres mejoras" class="flex-1 resize-none bg-transparent text-sm leading-relaxed text-slate-900 placeholder-slate-400 focus:outline-none" style="max-height: 160px; overflow-y: auto;" disabled></textarea><div class="flex shrink-0 items-center gap-2"><button id="jc-btn-abort" class="jc-composer-action inline-flex min-h-10 items-center gap-2 rounded-lg border-0 bg-transparent px-3 text-xs font-bold text-red-700 hover:bg-red-50" aria-label="Detener respuesta" hidden>${ic("square", 14)} Detener</button><button id="jc-btn-send" class="jc-composer-action ${cx(ui.button.base, ui.button.primary)} min-h-10 min-w-10" aria-label="Enviar mensaje" disabled>${ic("send", 16)}</button></div></div><p class="mt-2 text-center text-[11px] leading-relaxed text-slate-500">Enter para enviar · Shift+Enter para nueva línea · Verifica las citas antes de usar el contenido</p></div>
          </div>
      </div>

      <aside id="jc-sources-panel" aria-label="Fuentes, enlaces e historial" class="jc-sources-panel hidden w-80 shrink-0 flex-col border-l border-slate-200 bg-slate-50 xl:flex">
        <div class="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3"><div><h2 class="text-sm font-bold text-slate-900">Contexto</h2><p class="mt-0.5 text-[10px] text-slate-500">Fuentes y conversaciones</p></div><button id="jc-close-sources" type="button" class="jc-icon-button grid place-items-center rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 xl:hidden" aria-label="Cerrar contexto">${ic("x", 18)}</button></div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <div id="jc-sources-content" class="space-y-4 p-4"></div>
          <section id="jc-history-section" class="border-t border-slate-200 bg-white px-4 py-4" aria-labelledby="jc-history-title">
            <div class="mb-3 flex items-center gap-2"><span class="grid h-8 w-8 place-items-center rounded-lg bg-teal-50 text-teal-800" aria-hidden="true">${ic("route", 16)}</span><div><h3 id="jc-history-title" class="text-xs font-bold uppercase tracking-wider text-slate-700">Conversaciones</h3><p class="text-[10px] text-slate-500">Historial de esta asignatura</p></div></div>
            <label for="jc-history-search" class="sr-only">Buscar conversación</label>
            <div class="mb-2 flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 focus-within:border-teal-700 focus-within:ring-2 focus-within:ring-teal-700/20">${ic("search", 14)}<input id="jc-history-search" type="search" placeholder="Buscar conversación" class="min-h-10 min-w-0 flex-1 border-0 bg-transparent py-2 text-xs text-slate-900 placeholder-slate-400 outline-none"></div>
            <div id="jc-sessions-list" class="flex flex-col gap-0.5"><div class="px-3 py-4 text-xs leading-relaxed text-slate-500">Conecta Jintia Chat para ver el historial.</div></div>
          </section>
        </div>
      </aside>
    </div>
  `;

  if (_course?.project_path) {
    const sel = el("jc-course-select");
    if (sel) sel.value = _course.project_path;
  }

  _selectedWeek = _selectedWeek || "";
  const weekSelect = el("jc-week-select");
  if (weekSelect) weekSelect.value = _selectedWeek;

  bindChatEvents();
  const jintiaChatOption = el("jc-provider-select")?.querySelector('option[value="opencode"]');
  if (jintiaChatOption) jintiaChatOption.textContent = "Jintia Chat";
  updateContextSummary();
  renderSourcesPanel();
  updateProviderUI();
  syncPanelLayout({ force: true });

  // Auto-conectar al abrir la página si hay una asignatura disponible
  if (_course?.project_path) {
    requestAnimationFrame(() => {
      if (_provider === "codex") prepareCodexConversation();
      else if (_provider === "claude") prepareClaudeConversation();
      else connectAndGreet(_course.project_path);
    });
  }
}

function resetConversation({ announce = false } = {}) {
  stopOpenCodeProgressTimer();
  _lastRuntimeActivity = "";
  _runtimeActivityEl = null;
  _sessionId = null;
  _assistantEl = null;
  _assistantRaw = "";
  _currentPartType = null;
  _currentPartId   = null;
  _busy = false;
  _codexThreadId = null;
  _codexTurnId = null;
  _claudeSessionId = null;
  _claudeRequestId = null;
  _sourceLinks.clear();
  teardownCodexListener();
  teardownClaudeListener();
  hideThinkingBubble();
  clearFeed();
  setAbortVisible(false);
  if (_provider === "codex") {
    // No afirmar "listo" todavía: connectCodexEagerly() confirma el estado real.
    setSendEnabled(false);
    setStatus("Conectando con Codex…", "working");
  } else if (_provider === "claude") {
    // No afirmar "listo" todavía: connectClaudeEagerly() confirma el estado real.
    setSendEnabled(false);
    setStatus("Conectando con Claude Code…", "working");
  } else {
    setSendEnabled(_runtimeReady);
    setStatus(_runtimeReady ? "Jintia Chat listo" : "Desconectado", _runtimeReady ? "ready" : "neutral");
  }
  if (_course) appendGreetingMessage(`Nueva conversación para **${_course.name || _course.code || "la asignatura"}** en **${weekLabel()}**. ¿Qué quieres hacer?`);
  renderSourcesPanel();
  if (announce) toast("Nueva conversación iniciada", "success", 2000);
  el("jc-input")?.focus();
}

function prepareCodexConversation() {
  el("jc-btn-new-session") && (el("jc-btn-new-session").disabled = false);
  resetConversation();
  void connectCodexEagerly();
  autoConnectNotebook();
}

function prepareClaudeConversation() {
  el("jc-btn-new-session") && (el("jc-btn-new-session").disabled = false);
  resetConversation();
  void connectClaudeEagerly();
  autoConnectNotebook();
}

function bindChatEvents() {
  el("jc-provider-select")?.addEventListener("change", async e => {
    const previous = _provider;
    const next = e.target.value;
    if ((_sessionId || _codexThreadId || _claudeSessionId) && !await confirmDialog({
      title: "Cambiar proveedor",
      message: "El cambio iniciará una conversación nueva para evitar mezclar contextos.",
      confirmLabel: "Cambiar e iniciar",
    })) {
      e.target.value = previous;
      return;
    }
    _provider = next;
    state.config = { ...state.config, provider: next };
    saveConfig();
    resetConversation();
    updateProviderUI();
    if (_provider === "codex") {
      prepareCodexConversation();
      toast("ChatGPT activado mediante Codex.", "info", 4000);
    } else if (_provider === "claude") {
      prepareClaudeConversation();
      toast("Claude Code activado con tu sesión de Claude.", "info", 4000);
    } else if (_runtimeReady) {
      syncPanelLayout({ force: true });
      loadSessions(_course?.project_path);
    } else if (_course?.project_path) {
      connectAndGreet(_course.project_path);
    }
  });

  el("jc-course-select")?.addEventListener("change", e => {
    const path = e.target.value;
    _course = (state.courses || []).find(c => c.project_path === path) || null;
    disconnectSSE();
    teardownCodexListener();
    teardownClaudeListener();
    _sessionId       = null;
    _runtimeReady    = false;
    _port            = 0;
    _busy            = false;
    _codexThreadId   = null;
    _codexTurnId     = null;
    _claudeSessionId = null;
    _claudeRequestId = null;
    _notebookChecked = false;
    _sessionsLoaded  = false;
    _selectedWeek    = "";
    _sourceLinks.clear();
    setSendEnabled(false);
    el("jc-btn-new-session").disabled = true;
    populateWeekSelect(_course);
    updateContextSummary();
    renderSourcesPanel();
    if (_course?.project_path) {
      if (_provider === "codex") prepareCodexConversation();
      else if (_provider === "claude") prepareClaudeConversation();
      else connectAndGreet(_course.project_path);
    }
  });

  el("jc-week-select")?.addEventListener("change", async e => {
    const next = e.target.value;
    if ((_sessionId || _codexThreadId || _claudeSessionId) && !await confirmDialog({
      title: "Cambiar semana",
      message: `Se iniciará una conversación nueva para ${weekLabel(next)}.`,
      confirmLabel: "Cambiar semana",
    })) {
      e.target.value = _selectedWeek;
      return;
    }
    _selectedWeek = next;
    updateContextSummary();
    resetConversation();
  });

  el("jc-btn-connect")?.addEventListener("click", async () => {
    if (!_course?.project_path) {
      toast("Selecciona una asignatura primero", "warning", 3000);
      return;
    }
    if (_provider === "codex") prepareCodexConversation();
    else if (_provider === "claude") prepareClaudeConversation();
    else await connectAndGreet(_course.project_path);
  });

  el("jc-btn-new-session")?.addEventListener("click", () => {
    resetConversation({ announce: true });
    if (_provider === "codex") void connectCodexEagerly();
    else if (_provider === "claude") void connectClaudeEagerly();
    else if (_course?.project_path) loadSessions(_course.project_path);
  });

  el("jc-toggle-sources")?.addEventListener("click", () => showSourcesPanel({ focus: true }));
  el("jc-close-sources")?.addEventListener("click", () => hideSourcesPanel({ restoreFocus: true }));
  el("jc-panel-scrim")?.addEventListener("click", () => hideSourcesPanel({ restoreFocus: true }));
  el("jc-chat-shell")?.addEventListener("keydown", event => {
    if (event.key !== "Escape" || panelViewportMode() === "wide") return;
    if (panelIsExplicitlyOpen(el("jc-sources-panel"))) {
      event.preventDefault();
      hideSourcesPanel({ restoreFocus: true });
    }
  });

  if (_panelResizeHandler) window.removeEventListener("resize", _panelResizeHandler);
  _panelResizeHandler = () => syncPanelLayout();
  window.addEventListener("resize", _panelResizeHandler);

  document.querySelectorAll("[data-jc-starter]").forEach(attachStarterHandler);
  el("jc-history-search")?.addEventListener("input", event => {
    const query = event.target.value.trim().toLocaleLowerCase("es");
    el("jc-sessions-list")?.querySelectorAll("[data-session-row]").forEach(row => {
      row.hidden = query && !row.textContent.toLocaleLowerCase("es").includes(query);
    });
  });

  const input = el("jc-input");
  input?.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
    updateComposerState();
  });
  input?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  el("jc-btn-send")?.addEventListener("click", () => sendMessage());

  el("jc-activity-feed")?.addEventListener("click", async event => {
    const target = event.target.closest("[data-jc-source-url]");
    if (!target) return;
    try { await openWebSource(target.dataset.jcSourceUrl); }
    catch (error) { toast(`No se pudo abrir la fuente: ${error}`, "error", 5000); }
  });
  el("jc-activity-feed")?.addEventListener("keydown", event => {
    if ((event.key === "Enter" || event.key === " ") && event.target.closest("[data-jc-source-url]")) {
      event.preventDefault();
      event.target.closest("[data-jc-source-url]").click();
    }
  });
  el("jc-sources-panel")?.addEventListener("click", async event => {
    const target = event.target.closest("[data-jc-source-url]");
    if (!target) return;
    try { await openWebSource(target.dataset.jcSourceUrl); }
    catch (error) { toast(`No se pudo abrir la fuente: ${error}`, "error", 5000); }
  });

  el("jc-btn-abort")?.addEventListener("click", async () => {
    if (!_course?.project_path) return;
    try {
      if (_provider === "codex") {
        if (!_codexThreadId || !_codexTurnId) return;
        await invoke("codex_interrupt_turn", { threadId: _codexThreadId, turnId: _codexTurnId });
      } else if (_provider === "claude") {
        if (!_claudeRequestId) return;
        await claudeInterruptTurn(_claudeRequestId);
      } else {
        if (!_sessionId) return;
        await invoke("agent_abort", { coursePath: _course.project_path, sessionId: _sessionId });
        _turnSupervisor = null;
        clearOpenCodeStallWatchdog();
      }
      // Renderizar lo que haya llegado hasta el momento
      if (_assistantEl && _assistantRaw) {
        finalizeAssistantBubble(_assistantEl, _assistantRaw);
      }
      hideThinkingBubble();
      clearClaudeThinkingWatchdog();
      _assistantEl     = null;
      _assistantRaw    = "";
  _currentPartType = null;
  _currentPartId   = null;
      _busy = false;
      _codexTurnId = null;
      _claudeRequestId = null;
      setStatus("Respuesta detenida", "ready");
      setSendEnabled(true);
      setAbortVisible(false);
    } catch (err) {
      toast("No se pudo cancelar: " + String(err), "error", 4000);
    }
  });
}
