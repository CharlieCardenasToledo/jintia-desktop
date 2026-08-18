/**
 * jintia-chat.js — Chat nativo con OpenCode (Ask Jintia)
 * Plan Maestro sección 29: "Ask Jintia" dentro de una asignatura/semana.
 * Arquitectura: React UI → Tauri commands → OpenCode process → Jintia Skill
 *
 * Streaming: usa SSE (GET /event) en lugar de polling. Los deltas de texto
 * llegan evento a evento (message.part.delta) y se concatenan en tiempo real.
 */
import { invoke }     from "@tauri-apps/api/core";
import { marked }     from "marked";
import { ic }         from "../icons.js";
import { ui, cx }     from "../uiClasses.js";
import { state }      from "../state.js";
import { escapeHtml } from "../dom.js";
import { toast }      from "../toast.js";

// Configurar marked: sin modo pedantic, con saltos de línea = <br>
marked.use({ breaks: true, gfm: true });

// ── Estado de la página ────────────────────────────────────────────────────
let _course       = null;
let _sessionId    = null;
let _port         = 0;
let _sse          = null;   // EventSource activo
let _assistantEl  = null;   // <div> de texto en la burbuja que recibe deltas SSE
let _assistantRaw = "";     // texto acumulado en bruto (para convertir a MD al final)
let _reasoningEl  = null;   // <div> dentro del <details> de cadena de pensamiento
let _runtimeReady = false;
let _busy         = false;

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
  _assistantEl  = null;
  _assistantRaw = "";
  _reasoningEl  = null;
}

function handleSSE(event) {
  const props = event.properties || {};

  if (event.type === "message.part.delta") {
    if (props.sessionID !== _sessionId) return;

    if (props.field === "reasoning") {
      // Cadena de pensamiento: sección colapsable separada de la respuesta
      if (!_reasoningEl) {
        hideThinkingBubble();
        _reasoningEl = createReasoningSection();
      }
      if (_reasoningEl) {
        _reasoningEl.textContent += props.delta;
        scrollFeed();
      }

    } else if (props.field === "text") {
      // Respuesta real: burbuja principal con texto en bruto mientras llega
      if (!_assistantEl) {
        hideThinkingBubble();
        _assistantEl  = createAssistantBubble();
        _assistantRaw = "";
      }
      if (_assistantEl) {
        _assistantRaw += props.delta;
        _assistantEl.textContent = _assistantRaw; // texto plano durante el stream
        scrollFeed();
      }
    }

  } else if (event.type === "session.status") {
    if (props.sessionID !== _sessionId) return;
    const st = props.status?.type;
    // "busy" → generando; cualquier otro estado (idle, error…) → terminó
    if (st && st !== "busy") {
      // Convertir el texto acumulado a HTML Markdown al finalizar
      if (_assistantEl && _assistantRaw) {
        _assistantEl.innerHTML = marked.parse(_assistantRaw);
      }
      _assistantEl  = null;
      _assistantRaw = "";
      _reasoningEl  = null;
      _busy = false;
      hideThinkingBubble();
      setSendEnabled(true);
      setAbortVisible(false);
      setStatus(st === "error" ? "Error" : "OpenCode listo", st === "error" ? "error" : "ready");
    }
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
    if (_runtimeReady) connectSSE(_port);
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
    return true;
  } catch (err) {
    console.error("[jintia-chat] agent_create_session error:", err);
    toast("No se pudo crear la sesión: " + String(err), "error", 6000);
    return false;
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

  try {
    await invoke("agent_send_message", {
      coursePath: _course.project_path,
      sessionId: _sessionId,
      message: text,
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
  _course = course;
  disconnectSSE();
  _sessionId    = null;
  _runtimeReady = false;
  _port         = 0;
  _busy         = false;

  requestAnimationFrame(() => {
    const sel = el("jc-course-select");
    if (sel && course?.project_path) sel.value = course.project_path;
    const wSel = el("jc-week-select");
    if (wSel && week) wSel.value = String(week);
    setStatus("Desconectado", "neutral");
    setSendEnabled(false);
    const connectBtn = el("jc-btn-connect");
    if (connectBtn) connectBtn.disabled = false;
    el("jc-btn-new-session") && (el("jc-btn-new-session").disabled = true);
  });
}

// ── Renderizado principal ──────────────────────────────────────────────────
export function renderJintiaChat() {
  ensureChatStyles();
  disconnectSSE();
  _sessionId    = null;
  _runtimeReady = false;
  _port         = 0;
  _busy         = false;

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
    <div class="flex h-full flex-col">

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
        <div class="ml-auto flex items-center gap-2">
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
        <div class="mt-1.5 text-[10px] text-gray-400 text-center">
          Powered by OpenCode · Jintia Skill
        </div>
      </div>

    </div>
  `;

  if (_course?.project_path) {
    const sel = el("jc-course-select");
    if (sel) sel.value = _course.project_path;
  }

  bindChatEvents();
}

function bindChatEvents() {
  el("jc-course-select")?.addEventListener("change", e => {
    const path = e.target.value;
    _course = (state.courses || []).find(c => c.project_path === path) || null;
    disconnectSSE();
    _sessionId = null;
    _runtimeReady = false;
    _port = 0;
    _busy = false;
    setStatus("Desconectado", "neutral");
    el("jc-btn-connect").disabled = false;
    setSendEnabled(false);
    el("jc-btn-new-session").disabled = true;
  });

  el("jc-btn-connect")?.addEventListener("click", async () => {
    if (!_course?.project_path) {
      toast("Selecciona una asignatura primero", "warning", 3000);
      return;
    }
    const ok = await startRuntime(_course.project_path);
    if (ok) {
      setSendEnabled(true);
      el("jc-btn-new-session").disabled = false;
      clearFeed();
      appendMessage(`<div class="flex gap-2.5 mb-3">
        <div class="mt-0.5 h-6 w-6 rounded-full bg-brand-600 flex items-center justify-center shrink-0 text-white text-[10px] font-bold select-none">J</div>
        <div class="max-w-[80%] rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-800 leading-relaxed">
          Hola, soy Jintia. Estoy listo para trabajar contigo en <strong>${escapeHtml(_course.name || _course.code || "tu asignatura")}</strong>.
          Puedes pedirme que genere, revise o valide una guía semanal.
        </div>
      </div>`);
      el("jc-input").focus();
    }
  });

  el("jc-btn-new-session")?.addEventListener("click", () => {
    _sessionId = null;
    _assistantEl = null;
    _busy = false;
    hideThinkingBubble();
    clearFeed();
    setStatus("OpenCode listo", "ready");
    setSendEnabled(true);
    setAbortVisible(false);
    toast("Nueva sesión iniciada", "success", 2000);
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
      _assistantEl  = null;
      _assistantRaw = "";
      _reasoningEl  = null;
      _busy = false;
      setStatus("Cancelado", "neutral");
      setSendEnabled(true);
      setAbortVisible(false);
    } catch (err) {
      toast("No se pudo cancelar: " + String(err), "error", 4000);
    }
  });
}
