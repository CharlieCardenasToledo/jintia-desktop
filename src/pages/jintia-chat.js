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
import { ic }         from "../icons.js";
import { ui, cx }     from "../uiClasses.js";
import { state }      from "../state.js";
import { escapeHtml } from "../dom.js";
import { toast }      from "../toast.js";
import {
  checkNotebookLMAuth,
  listNotebooksMcp,
  listAccountNotebooksMcp,
  saveNotebooksConfig,
  opencodeRenameSession,
  opencodeDeleteSession,
} from "../api.js";
import { saveCourses } from "../state.js";

// Configurar marked: sin modo pedantic, con saltos de línea = <br>
marked.use({ breaks: true, gfm: true });

// ── Estado de la página ────────────────────────────────────────────────────
let _course          = null;
let _sessionId       = null;
let _port            = 0;
let _sse             = null;   // EventSource activo
let _assistantEl     = null;   // <div> que recibe deltas de respuesta
let _assistantRaw    = "";     // texto acumulado en bruto para convertir a MD al final
let _reasoningEl     = null;   // <div> del <details> de cadena de pensamiento
let _currentPartType = null;   // "reasoning" | "text" | null — part activo según SSE
let _runtimeReady    = false;
let _busy            = false;
// Modelo seleccionado: { id, providerID, name } — se carga automáticamente al conectar
let _selectedModel   = null;
// Historial de sesiones del curso activo
let _sessionsLoaded  = false;
// Proveedor de IA: "opencode" | "codex"
let _provider        = "opencode";
// Thread activo de Codex (por curso)
let _codexThreadId   = null;
// Función de cancelación del listener Tauri para eventos Codex
let _codexUnlisten   = null;
// Flag para no mostrar el picker de notebook dos veces en la misma sesión de conexión
let _notebookChecked = false;

// ── Helpers DOM ────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);

function setStatus(text, kind = "neutral") {
  const badge = el("jc-status-badge");
  if (!badge) return;
  const colors = {
    neutral: "bg-gray-100 text-gray-500",
    ready:   "bg-green-100 text-green-700",
    working: "bg-amber-100 text-amber-700",
    error:   "bg-red-100 text-red-700",
  };
  badge.className = `inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${colors[kind] ?? colors.neutral}`;
  badge.textContent = text;
}

// CSS de animaciones inyectado una sola vez
let _stylesInjected = false;
function ensureChatStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    @keyframes jc-dot-bounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-6px); opacity: 1; }
    }
    .jc-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #9ca3af; animation: jc-dot-bounce 1.3s ease-in-out infinite; }
    .jc-dot:nth-child(1) { animation-delay: 0s; }
    .jc-dot:nth-child(2) { animation-delay: 0.18s; }
    .jc-dot:nth-child(3) { animation-delay: 0.36s; }
    @keyframes jc-msg-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .jc-msg-in { animation: jc-msg-in 0.2s ease-out forwards; }

    /* Markdown rendered dentro de la burbuja del asistente */
    .jc-md p          { margin: 0 0 0.55em; }
    .jc-md p:last-child { margin-bottom: 0; }
    .jc-md ul, .jc-md ol { padding-left: 1.4em; margin: 0 0 0.55em; }
    .jc-md li          { margin-bottom: 0.2em; }
    .jc-md h1,.jc-md h2,.jc-md h3 { font-weight: 600; margin: 0.6em 0 0.3em; line-height: 1.3; }
    .jc-md h1 { font-size: 1.1em; }
    .jc-md h2 { font-size: 1.0em; }
    .jc-md h3 { font-size: 0.95em; }
    .jc-md code { font-family: ui-monospace,monospace; font-size: 0.85em; background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 4px; padding: 0.1em 0.35em; }
    .jc-md pre  { background: #1e1e2e; border-radius: 8px; padding: 0.9em 1em; overflow-x: auto; margin: 0.5em 0; }
    .jc-md pre code { background: none; border: none; padding: 0; color: #cdd6f4; font-size: 0.82em; }
    .jc-md blockquote { border-left: 3px solid #e5e7eb; margin: 0.5em 0; padding-left: 0.8em; color: #6b7280; }
    .jc-md hr   { border: none; border-top: 1px solid #e5e7eb; margin: 0.7em 0; }
    .jc-md strong { font-weight: 600; }
    .jc-md a { color: #4f46e5; text-decoration: underline; }
    .jc-md table { border-collapse: collapse; width: 100%; margin: 0.5em 0; font-size: 0.85em; }
    .jc-md th,.jc-md td { border: 1px solid #e5e7eb; padding: 0.3em 0.6em; text-align: left; }
    .jc-md th { background: #f9fafb; font-weight: 600; }

    /* Sección de cadena de pensamiento colapsable */
    .jc-reasoning summary { cursor: pointer; user-select: none; list-style: none; }
    .jc-reasoning summary::-webkit-details-marker { display: none; }
    .jc-reasoning summary::before { content: "▶"; font-size: 9px; margin-right: 4px; transition: transform 0.15s; display: inline-block; }
    .jc-reasoning[open] summary::before { transform: rotate(90deg); }
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
  scrollFeed();
}

// Burbuja de "pensando" con tres puntos animados
function showThinkingBubble() {
  hideThinkingBubble();
  const feed = el("jc-activity-feed");
  if (!feed) return;
  const wrap = document.createElement("div");
  wrap.id = "jc-thinking";
  wrap.className = "flex gap-2.5 mb-3 jc-msg-in";
  wrap.innerHTML = `
    <div class="mt-0.5 h-6 w-6 rounded-full bg-brand-600 flex items-center justify-center shrink-0 text-white text-[10px] font-bold select-none">J</div>
    <div class="rounded-xl border border-gray-200 bg-white px-4 py-3 flex items-center gap-1.5">
      <span class="jc-dot"></span><span class="jc-dot"></span><span class="jc-dot"></span>
    </div>`;
  feed.appendChild(wrap);
  scrollFeed();
}

function hideThinkingBubble() {
  el("jc-thinking")?.remove();
}

// Crea la sección colapsable de cadena de pensamiento (razonamiento del modelo).
// Retorna el <div> interno donde se acumulan los deltas de reasoning.
function createReasoningSection() {
  const feed = el("jc-activity-feed");
  if (!feed) return null;
  const details = document.createElement("details");
  details.className = "jc-reasoning mb-1.5 ml-8 jc-msg-in";
  details.innerHTML = `
    <summary class="text-[11px] text-gray-400 hover:text-gray-500 select-none">
      Cadena de pensamiento
    </summary>
    <div class="mt-1 rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-[11px] text-gray-400 font-mono leading-relaxed whitespace-pre-wrap max-h-52 overflow-y-auto"></div>`;
  feed.appendChild(details);
  scrollFeed();
  return details.querySelector("div");
}

// Crea una burbuja de asistente vacía y retorna el elemento de texto
// que irá recibiendo los deltas SSE.
function createAssistantBubble() {
  const feed = el("jc-activity-feed");
  if (!feed) return null;
  const wrap = document.createElement("div");
  wrap.className = "flex gap-2.5 mb-3 jc-msg-in";
  wrap.innerHTML = `
    <div class="mt-0.5 h-6 w-6 rounded-full bg-brand-600 flex items-center justify-center shrink-0 text-white text-[10px] font-bold select-none">J</div>
    <div class="jc-md max-w-[80%] rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-800 leading-relaxed"></div>`;
  feed.appendChild(wrap);
  scrollFeed();
  return wrap.querySelector("div:last-child");
}

function messageHtml(msg) {
  const role = msg.info?.role || msg.role || "assistant";
  const text = (msg.parts || [])
    .filter(p => p.type === "text")
    .map(p => p.text || "")
    .join("\n")
    .trim();
  if (!text || role !== "user") return null;
  return `<div class="flex justify-end mb-3">
    <div class="max-w-[80%] rounded-xl bg-gray-900 px-4 py-2.5 text-sm text-white leading-relaxed">${escapeHtml(text)}</div>
  </div>`;
}

// ── Control de botones ─────────────────────────────────────────────────────
function setSendEnabled(enabled) {
  const btn = el("jc-btn-send");
  const inp = el("jc-input");
  if (btn) btn.disabled = !enabled;
  if (inp) inp.disabled = !enabled;
}

function setAbortVisible(visible) {
  const btn = el("jc-btn-abort");
  if (btn) btn.hidden = !visible;
}

// ── SSE streaming ──────────────────────────────────────────────────────────
function connectSSE(port) {
  disconnectSSE();
  try {
    _sse = new EventSource(`http://127.0.0.1:${port}/event`);
    _sse.onmessage = (ev) => {
      try { handleSSE(JSON.parse(ev.data)); } catch {}
    };
    _sse.onerror = () => {}; // EventSource reintenta solo; silenciar en mock
  } catch {}
}

function disconnectSSE() {
  if (_sse) { _sse.close(); _sse = null; }
  _assistantEl     = null;
  _assistantRaw    = "";
  _reasoningEl     = null;
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

// ── Historial de sesiones ──────────────────────────────────────────────────
function showSessionsPanel() {
  const panel = el("jc-sessions-panel");
  if (!panel) return;
  panel.classList.remove("hidden");
  panel.classList.add("flex");
}

function hideSessionsPanel() {
  const panel = el("jc-sessions-panel");
  if (!panel) return;
  panel.classList.add("hidden");
  panel.classList.remove("flex");
}

async function loadSessions(coursePath) {
  const list = el("jc-sessions-list");
  if (!list || !coursePath) return;
  list.innerHTML = `<div class="px-3 py-2 text-[11px] text-gray-400">Cargando…</div>`;
  try {
    const sessions = await invoke("opencode_list_sessions", { coursePath });
    _sessionsLoaded = true;
    if (!sessions.length) {
      list.innerHTML = `<div class="px-3 py-2 text-[11px] text-gray-400 italic">Sin sesiones previas</div>`;
      return;
    }
    renderSessionsList(list, sessions, coursePath);
  } catch {
    list.innerHTML = `<div class="px-3 py-2 text-[11px] text-gray-400">No disponible</div>`;
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
      ? "bg-brand-100 text-brand-700"
      : "text-gray-700 hover:bg-gray-100";
    return `
      <div class="group relative flex items-center rounded-md ${baseRow} transition-colors"
           data-session-row="${escapeHtml(s.id)}">
        <button class="min-w-0 flex-1 text-left px-2.5 py-2 text-xs"
                data-session-id="${escapeHtml(s.id)}"
                title="${escapeHtml(title)}">
          <div class="truncate font-medium leading-snug">${escapeHtml(title)}</div>
          <div class="mt-0.5 font-mono text-[10px] text-gray-400 truncate">${escapeHtml(s.id.slice(0, 10))}…</div>
        </button>
        <!-- Acciones: aparecen al pasar el cursor -->
        <div class="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-0.5 bg-white/90 rounded px-0.5 shadow-sm">
          <button class="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700"
                  data-rename-session="${escapeHtml(s.id)}"
                  title="Renombrar">
            ${ic("pencil", 11)}
          </button>
          <button class="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500"
                  data-delete-session="${escapeHtml(s.id)}"
                  title="Eliminar">
            ${ic("trash-2", 11)}
          </button>
        </div>
      </div>`;
  }).join("");

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

  // Reemplazar contenido del botón principal con un input
  const titleBtn = row.querySelector("[data-session-id]");
  if (!titleBtn) return;
  const inputId = `jc-rename-input-${sessionId}`;
  row.querySelector(".hidden.group-hover\\:flex")?.classList.add("!hidden"); // ocultar acciones
  titleBtn.innerHTML = `
    <input id="${inputId}" class="w-full rounded border border-brand-400 bg-white px-1.5 py-0.5 text-xs text-gray-800 outline-none ring-2 ring-brand-200"
           value="${escapeHtml(current)}" autocomplete="off" spellcheck="false">`;
  const input = document.getElementById(inputId);
  if (!input) return;
  input.focus();
  input.select();

  async function commit() {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== current) {
      _localTitles[sessionId] = newTitle;
      saveLocalTitles();
      // Intentar renombrar en el servidor (falla silenciosamente si no está soportado)
      try {
        await opencodeRenameSession(coursePath, sessionId, newTitle);
      } catch {}
    }
    loadSessions(coursePath);
  }

  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); commit(); }
    if (e.key === "Escape") { loadSessions(coursePath); }
  });
  input.addEventListener("blur", commit);
}

async function deleteSession(sessionId, coursePath, sessions) {
  const s     = sessions.find(x => x.id === sessionId);
  const title = sessionTitle(s || { id: sessionId });
  if (!window.confirm(`¿Eliminar "${title}"?\nSe borrará el historial de esta conversación.`)) return;

  // Ocultar inmediatamente del sidebar (UX optimista)
  const row = el("jc-sessions-list")?.querySelector(`[data-session-row="${sessionId}"]`);
  row?.remove();

  // Si era la sesión activa, limpiar el feed
  if (_sessionId === sessionId) {
    _sessionId = null;
    clearFeed();
    setStatus("OpenCode listo", "ready");
    setSendEnabled(true);
  }

  // Limpiar título local si existía
  delete _localTitles[sessionId];
  saveLocalTitles();

  // Intentar eliminar en el servidor
  try {
    await opencodeDeleteSession(coursePath, sessionId);
  } catch {
    // Si la API no lo soporta, quedó oculto localmente — se recupera al recargar
  }

  // Recargar para reflejar el estado real del servidor
  await loadSessions(coursePath);
}

async function switchToSession(sessionId, coursePath) {
  if (sessionId === _sessionId) return;
  if (_busy) { toast("Espera a que Jintia termine de responder", "warning", 3000); return; }

  _sessionId       = sessionId;
  _assistantEl     = null;
  _assistantRaw    = "";
  _reasoningEl     = null;
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
        ? "bg-brand-100 text-brand-700"
        : "text-gray-700 hover:bg-gray-100"}`;
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
  setStatus("OpenCode listo", "ready");
}

// Burbuja de respuesta completa (para historial cargado, no streaming)
function appendAssistantMessage(text) {
  const feed = el("jc-activity-feed");
  if (!feed) return;
  const wrap = document.createElement("div");
  wrap.className = "flex gap-2.5 mb-3 jc-msg-in";
  wrap.innerHTML = `
    <div class="mt-0.5 h-6 w-6 rounded-full bg-brand-600 flex items-center justify-center shrink-0 text-white text-[10px] font-bold select-none">J</div>
    <div class="jc-md max-w-[80%] rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-800 leading-relaxed"></div>`;
  wrap.querySelector(".jc-md").innerHTML = marked.parse(text);
  feed.appendChild(wrap);
  scrollFeed();
}

function handleSSE(event) {
  const props = event.properties || {};

  // ── Rastrear qué part está activo (abierto/cerrado) ──────────────────
  if (event.type === "message.part.updated") {
    const part = props.part || {};
    if (part.sessionID !== _sessionId) return;
    if (!part.time?.end) {
      // Part abierto: marcar tipo activo
      _currentPartType = part.type; // "reasoning", "text", "step-start", etc.
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

    if (_currentPartType === "reasoning") {
      // Cadena de pensamiento → sección colapsable
      if (!_reasoningEl) {
        hideThinkingBubble();
        _reasoningEl = createReasoningSection();
      }
      if (_reasoningEl) {
        _reasoningEl.textContent += props.delta;
        scrollFeed();
      }

    } else if (_currentPartType === "text") {
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
      if (_assistantEl && _assistantRaw) {
        _assistantEl.innerHTML = marked.parse(_assistantRaw);
      }
      _assistantEl     = null;
      _assistantRaw    = "";
      _reasoningEl     = null;
      _currentPartType = null;
      _busy = false;
      hideThinkingBubble();
      setSendEnabled(true);
      setAbortVisible(false);
      setStatus("OpenCode listo", "ready");
    }
    // "retry" → el servidor está reintentando; mantener burbuja de pensando
    return;
  }

  // ── Error fatal de sesión ─────────────────────────────────────────────
  if (event.type === "session.error") {
    if (props.sessionID !== _sessionId) return;
    if (_assistantEl && _assistantRaw) {
      _assistantEl.innerHTML = marked.parse(_assistantRaw);
    }
    _assistantEl     = null;
    _assistantRaw    = "";
    _reasoningEl     = null;
    _currentPartType = null;
    _busy = false;
    hideThinkingBubble();
    setSendEnabled(true);
    setAbortVisible(false);
    setStatus("Error", "error");
    const msg = props.error?.message || props.message || "Error desconocido de OpenCode";
    toast("Error: " + msg, "error", 8000);
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
        <select id="jc-nb-select" class="flex-1 min-w-0 rounded-lg border border-teal-300 bg-white px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-teal-400">
          <option value="">— Selecciona un notebook —</option>
          ${notebooks.map(nb => `<option value="${escapeHtml(nb.id)}" data-url="${escapeHtml(nb.url || "")}" data-name="${escapeHtml(nb.name || nb.id)}">${escapeHtml(nb.name || nb.id)}</option>`).join("")}
        </select>
        <button id="jc-nb-save" class="${cx(ui.button.base, ui.button.primary, ui.button.sm)}" disabled>
          ${ic("link", 14)} Vincular
        </button>
        <button id="jc-nb-scan" class="${cx(ui.button.base, ui.button.ghost, ui.button.sm)}" title="Buscar más en tu cuenta Google">
          ${ic("refresh-cw", 12)} Buscar más
        </button>
        <button id="jc-nb-skip" class="${cx(ui.button.base, ui.button.ghost, ui.button.sm)} text-gray-400">
          Omitir
        </button>
      </div>
      <div id="jc-nb-scanning" class="hidden mt-2 text-[11px] text-teal-600">Buscando en tu cuenta…</div>
    </div>`;

  feed.appendChild(card);
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
    appendMessage(`<div class="flex gap-2.5 mb-3">
      <div class="mt-0.5 h-6 w-6 rounded-full bg-brand-600 flex items-center justify-center shrink-0 text-white text-[10px] font-bold select-none">J</div>
      <div class="max-w-[80%] rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-800 leading-relaxed">
        Hola, soy Jintia. Estoy listo para trabajar contigo en <strong>${escapeHtml(course?.name || course?.code || "tu asignatura")}</strong>.
        Puedes pedirme que genere, revise o valide una guía semanal.
      </div>
    </div>`);
    el("jc-input")?.focus();
  }
}

// ── Iniciar runtime OpenCode ───────────────────────────────────────────────
async function startRuntime(coursePath) {
  setStatus("Iniciando OpenCode…", "working");
  const connectBtn = el("jc-btn-connect");
  if (connectBtn) connectBtn.disabled = true;
  try {
    const info = await invoke("opencode_start_course", { coursePath });
    _runtimeReady = info.status === "ready";
    _port = info.port;
    if (_runtimeReady) {
      connectSSE(_port);
      loadModels(coursePath);      // sin await — paralelo
      showSessionsPanel();
      loadSessions(coursePath);    // sin await — paralelo
      autoConnectNotebook();       // sin await — aparece en el feed si hace falta
    }
    setStatus(_runtimeReady ? "OpenCode listo" : "Offline", _runtimeReady ? "ready" : "error");
    if (!_runtimeReady) {
      console.error("[jintia-chat] opencode_start_course no retornó ready:", info);
      if (connectBtn) connectBtn.disabled = false;
    }
    return _runtimeReady;
  } catch (err) {
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
    const session = await invoke("agent_create_session", {
      coursePath: _course.project_path,
      week,
    });
    _sessionId = session.id;
    // Refrescar historial con la nueva sesión
    loadSessions(_course.project_path);
    return true;
  } catch (err) {
    console.error("[jintia-chat] agent_create_session error:", err);
    toast("No se pudo crear la sesión: " + String(err), "error", 6000);
    return false;
  }
}

// ── Codex (ChatGPT sin API key) ───────────────────────────────────────────

function updateProviderUI() {
  const isCodex = _provider === "codex";
  const modelSel = el("jc-model-select");
  if (modelSel) {
    modelSel.disabled = isCodex || !_runtimeReady;
    modelSel.title = isCodex ? "El modelo lo gestiona ChatGPT automáticamente" : "Modelo de IA (solo OpenCode)";
  }
  const footer = el("jc-powered-by");
  if (footer) footer.textContent = isCodex ? "Powered by OpenAI Codex · ChatGPT" : "Powered by OpenCode · Jintia Skill";
}

async function startCodexIfNeeded() {
  try {
    const s = await invoke("codex_status");
    if (!s.installed) {
      toast("Codex CLI no está instalado. Ve a Ajustes > Conexiones para instalarlo.", "error", 10000);
      return false;
    }
    if (!s.running) {
      toast("Iniciando Codex app-server…", "loading", 8000);
      const r = await invoke("codex_start");
      if (!r.success) {
        toast(`No se pudo iniciar Codex: ${r.message}`, "error", 8000);
        return false;
      }
    }
    const fresh = await invoke("codex_status");
    if (!fresh.logged_in) {
      toast("Codex activo pero sin sesión de ChatGPT. Ve a Ajustes > Conexiones > Conectar ChatGPT.", "warning", 10000);
    }
    return true;
  } catch (e) {
    toast(`Error al verificar Codex: ${e}`, "error", 8000);
    return false;
  }
}

async function sendMessageViaCodex(text) {
  const cwd = _course?.project_path;
  if (!cwd) return;

  const ok = await startCodexIfNeeded();
  if (!ok) {
    _busy = false;
    setSendEnabled(true);
    setAbortVisible(false);
    return;
  }

  // Obtener o crear un thread para este curso
  if (!_codexThreadId) {
    try {
      _codexThreadId = await invoke("codex_start_thread", { cwd });
    } catch (e) {
      toast(`No se pudo crear el hilo Codex: ${e}`, "error", 6000);
      _busy = false;
      setSendEnabled(true);
      setAbortVisible(false);
      return;
    }
  }

  // Suscribir a eventos de respuesta (solo una vez por hilo)
  await ensureCodexListener();

  showThinkingBubble();
  setStatus("ChatGPT está pensando…", "working");

  try {
    await invoke("codex_submit_turn", { threadId: _codexThreadId, message: text });
  } catch (e) {
    _busy = false;
    hideThinkingBubble();
    setSendEnabled(true);
    setAbortVisible(false);
    setStatus("Error", "error");
    toast(`No se pudo enviar a Codex: ${e}`, "error", 6000);
  }
}

async function ensureCodexListener() {
  if (_codexUnlisten) return;
  _codexUnlisten = await listen("codex:turn.completed", (event) => {
    const params = event.payload?.params || {};
    if (params.threadId && params.threadId !== _codexThreadId) return;

    hideThinkingBubble();
    // Extraer texto del primer mensaje del asistente
    const items = params.items || [];
    for (const item of items) {
      if (item.role !== "assistant") continue;
      const text = (item.content || [])
        .filter(c => c.type === "output_text" || c.type === "text")
        .map(c => c.text || "")
        .join("")
        .trim();
      if (text) appendAssistantMessage(text);
    }
    _busy = false;
    setSendEnabled(true);
    setAbortVisible(false);
    setStatus("ChatGPT listo", "ready");
  });
}

function teardownCodexListener() {
  if (_codexUnlisten) {
    _codexUnlisten();
    _codexUnlisten = null;
  }
}

// ── Enviar mensaje ─────────────────────────────────────────────────────────
async function sendMessage() {
  const input = el("jc-input");
  const text = (input?.value || "").trim();
  if (!text || !_runtimeReady || _busy) return;

  if (!_sessionId) {
    const ok = await createSession();
    if (!ok) return;
  }

  input.value = "";
  input.style.height = "auto";

  appendMessage(messageHtml({ role: "user", parts: [{ type: "text", text }] }));
  setSendEnabled(false);
  setAbortVisible(true);
  _busy = true;

  if (_provider === "codex") {
    await sendMessageViaCodex(text);
    return;
  }

  try {
    await invoke("agent_send_message", {
      coursePath: _course.project_path,
      sessionId: _sessionId,
      message: text,
      modelProvider: _selectedModel?.providerID ?? null,
      modelId: _selectedModel?.id ?? null,
    });
    showThinkingBubble();
    setStatus("Jintia está pensando…", "working");
  } catch (err) {
    _busy = false;
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
  _sessionId       = null;
  _runtimeReady    = false;
  _port            = 0;
  _busy            = false;
  _codexThreadId   = null;
  _notebookChecked = false;

  requestAnimationFrame(() => {
    const sel = el("jc-course-select");
    if (sel && course?.project_path) sel.value = course.project_path;
    const wSel = el("jc-week-select");
    if (wSel && week) wSel.value = String(week);
    setSendEnabled(false);
    const connectBtn = el("jc-btn-connect");
    if (connectBtn) connectBtn.disabled = true;
    el("jc-btn-new-session") && (el("jc-btn-new-session").disabled = true);
    if (course?.project_path) connectAndGreet(course.project_path);
  });
}

// ── Renderizado principal ──────────────────────────────────────────────────
export function renderJintiaChat() {
  ensureChatStyles();
  disconnectSSE();
  teardownCodexListener();
  _sessionId       = null;
  _runtimeReady    = false;
  _port            = 0;
  _busy            = false;
  _codexThreadId   = null;
  _notebookChecked = false;

  if (!_course) {
    _course = (state.courses || []).find(c => c.project_path) || null;
  }

  const weeks = Array.from({ length: 16 }, (_, i) => i + 1);
  const courseOptions = (state.courses || [])
    .filter(c => c.project_path)
    .map(c => `<option value="${escapeHtml(c.project_path)}">${escapeHtml(c.code || c.name)}</option>`)
    .join("");

  const container = el("p-jintia-chat");
  if (!container) return;

  container.innerHTML = `
    <div class="flex h-full">

      <!-- Sidebar de historial (oculto hasta conectar) -->
      <div id="jc-sessions-panel" class="hidden w-48 shrink-0 flex-col border-r border-gray-200 bg-gray-50">
        <div class="border-b border-gray-200 px-3 py-2.5 flex items-center justify-between">
          <span class="text-[10.5px] font-bold uppercase tracking-wider text-gray-400">Historial</span>
        </div>
        <div id="jc-sessions-list" class="flex-1 overflow-y-auto p-1 flex flex-col gap-0.5">
          <div class="px-2 py-2 text-[11px] text-gray-400 italic">Conecta para ver el historial</div>
        </div>
      </div>

      <!-- Área principal del chat -->
      <div class="flex flex-1 flex-col min-w-0">

      <!-- Barra de contexto -->
      <div class="flex flex-wrap items-center gap-3 border-b border-gray-200 bg-white px-6 py-3 shrink-0">
        <div class="flex items-center gap-2">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Asignatura</span>
          <select id="jc-course-select" class="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-brand-500">
            ${courseOptions || '<option value="">Sin asignaturas preparadas</option>'}
          </select>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Semana</span>
          <select id="jc-week-select" class="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-brand-500">
            <option value="">General</option>
            ${weeks.map(w => `<option value="${w}">Semana ${String(w).padStart(2, "0")}</option>`).join("")}
          </select>
        </div>
        <div class="ml-auto flex items-center gap-2 flex-wrap">
          <select id="jc-provider-select" title="Proveedor de IA"
            class="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-brand-500">
            <option value="opencode" ${_provider === "opencode" ? "selected" : ""}>OpenCode</option>
            <option value="codex" ${_provider === "codex" ? "selected" : ""}>ChatGPT (Codex)</option>
          </select>
          <select id="jc-model-select" disabled title="Modelo de IA (solo OpenCode)"
            class="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-40 max-w-[180px] truncate">
            <option value="">Cargando modelo…</option>
          </select>
          <span id="jc-status-badge" class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-gray-100 text-gray-500">
            Desconectado
          </span>
          <button id="jc-btn-connect" class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}">
            ${ic("zap", 14)} Conectar
          </button>
          <button id="jc-btn-new-session" class="${cx(ui.button.base, ui.button.ghost, ui.button.sm)}" disabled title="Iniciar nueva conversación">
            ${ic("refresh-cw", 14)} Nueva sesión
          </button>
        </div>
      </div>

      <!-- Feed de mensajes -->
      <div id="jc-activity-feed" class="flex-1 overflow-y-auto px-6 py-5 min-h-0">
        <div class="flex flex-col items-center justify-center h-full text-center gap-4 opacity-50 py-16">
          <div class="h-14 w-14 rounded-2xl bg-brand-50 flex items-center justify-center text-brand-600 font-bold text-2xl select-none">J</div>
          <div>
            <div class="text-sm font-semibold text-gray-700 mb-1">Ask Jintia</div>
            <div class="text-xs text-gray-500 max-w-xs leading-relaxed">
              Selecciona una asignatura, conecta y escribe lo que necesitas.<br>
              <span class="text-gray-400 mt-1 block">Ejemplos: "Genera la guía de la semana 3" · "Revisa el sílabo" · "Valida la guía"</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Input de mensaje -->
      <div class="border-t border-gray-200 bg-white px-6 py-4 shrink-0">
        <div class="flex items-end gap-2 rounded-xl border border-gray-300 bg-gray-50 px-4 py-3 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20 transition">
          <textarea
            id="jc-input"
            rows="1"
            placeholder="Escríbele a Jintia… (Enter para enviar, Shift+Enter para nueva línea)"
            class="flex-1 resize-none bg-transparent text-sm text-gray-800 placeholder-gray-400 focus:outline-none leading-relaxed"
            style="max-height: 160px; overflow-y: auto;"
            disabled
          ></textarea>
          <div class="flex items-center gap-1.5 shrink-0 pb-0.5">
            <button id="jc-btn-abort" class="${cx(ui.button.base, ui.button.ghost, ui.button.sm)} !text-red-500 hover:!text-red-700" title="Cancelar respuesta" hidden>
              ${ic("square", 14)}
            </button>
            <button id="jc-btn-send" class="${cx(ui.button.base, ui.button.primary, ui.button.sm)}" disabled>
              ${ic("send", 14)}
            </button>
          </div>
        </div>
        <div class="mt-1.5 text-[10px] text-gray-400 text-center" id="jc-powered-by">
          Powered by OpenCode · Jintia Skill
        </div>
      </div>

      </div><!-- fin área principal -->
    </div><!-- fin flex h-full -->
  `;

  if (_course?.project_path) {
    const sel = el("jc-course-select");
    if (sel) sel.value = _course.project_path;
  }

  bindChatEvents();

  // Auto-conectar al abrir la página si hay una asignatura disponible
  if (_course?.project_path) {
    requestAnimationFrame(() => connectAndGreet(_course.project_path));
  }
}

function bindChatEvents() {
  el("jc-provider-select")?.addEventListener("change", e => {
    _provider = e.target.value;
    teardownCodexListener();
    _codexThreadId = null;
    updateProviderUI();
    if (_provider === "codex") {
      toast("Modo ChatGPT activado. Asegúrate de haber conectado tu cuenta en Ajustes > Conexiones.", "info", 6000);
    }
  });

  el("jc-course-select")?.addEventListener("change", e => {
    const path = e.target.value;
    _course = (state.courses || []).find(c => c.project_path === path) || null;
    disconnectSSE();
    teardownCodexListener();
    _sessionId       = null;
    _runtimeReady    = false;
    _port            = 0;
    _busy            = false;
    _codexThreadId   = null;
    _notebookChecked = false;
    _sessionsLoaded  = false;
    setSendEnabled(false);
    el("jc-btn-new-session").disabled = true;
    hideSessionsPanel();
    if (_course?.project_path) connectAndGreet(_course.project_path);
  });

  el("jc-btn-connect")?.addEventListener("click", async () => {
    if (!_course?.project_path) {
      toast("Selecciona una asignatura primero", "warning", 3000);
      return;
    }
    await connectAndGreet(_course.project_path);
  });

  el("jc-btn-new-session")?.addEventListener("click", () => {
    _sessionId = null;
    _assistantEl = null;
    _assistantRaw = "";
    _reasoningEl = null;
    _currentPartType = null;
    _busy = false;
    teardownCodexListener();
    _codexThreadId = null;
    hideThinkingBubble();
    clearFeed();
    setStatus(_provider === "codex" ? "ChatGPT listo" : "OpenCode listo", "ready");
    setSendEnabled(true);
    setAbortVisible(false);
    toast("Nueva sesión iniciada", "success", 2000);
    if (_provider === "opencode" && _course?.project_path) loadSessions(_course.project_path);
  });

  const input = el("jc-input");
  input?.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  });
  input?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  el("jc-btn-send")?.addEventListener("click", () => sendMessage());

  el("jc-btn-abort")?.addEventListener("click", async () => {
    if (!_sessionId || !_course?.project_path) return;
    try {
      await invoke("agent_abort", {
        coursePath: _course.project_path,
        sessionId: _sessionId,
      });
      // Renderizar lo que haya llegado hasta el momento
      if (_assistantEl && _assistantRaw) {
        _assistantEl.innerHTML = marked.parse(_assistantRaw);
      }
      hideThinkingBubble();
      _assistantEl     = null;
      _assistantRaw    = "";
      _reasoningEl     = null;
      _currentPartType = null;
      _busy = false;
      setStatus("Cancelado", "neutral");
      setSendEnabled(true);
      setAbortVisible(false);
    } catch (err) {
      toast("No se pudo cancelar: " + String(err), "error", 4000);
    }
  });
}
