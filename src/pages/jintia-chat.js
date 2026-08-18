/**
 * jintia-chat.js — Chat nativo con OpenCode (Ask Jintia)
 * Plan Maestro sección 29: "Ask Jintia" dentro de una asignatura/semana.
 * Arquitectura: React UI → Tauri commands → OpenCode process → Jintia Skill
 */
import { invoke }     from "@tauri-apps/api/core";
import { ic }         from "../icons.js";
import { ui, cx }     from "../uiClasses.js";
import { state }      from "../state.js";
import { escapeHtml } from "../dom.js";
import { toast }      from "../toast.js";

// ── Estado de la página ────────────────────────────────────────────────────
let _course = null;
let _sessionId = null;
let _polling = null;
let _runtimeReady = false;
let _lastMsgCount = 0;

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

function clearFeed() {
  const feed = el("jc-activity-feed");
  if (feed) feed.innerHTML = "";
}

function appendMessage(html) {
  const feed = el("jc-activity-feed");
  if (!feed) return;
  const div = document.createElement("div");
  div.innerHTML = html;
  const node = div.firstElementChild || div;
  feed.appendChild(node);
  feed.scrollTop = feed.scrollHeight;
}

function messageHtml(msg) {
  // OpenCode ≥1.18: role está en msg.info.role, no en el nivel raíz
  const role = msg.info?.role || msg.role || "assistant";
  const text = (msg.parts || [])
    .filter(p => p.type === "text")
    .map(p => p.text || "")
    .join("\n")
    .trim();
  if (!text) return null;
  if (role === "user") {
    return `<div class="flex justify-end mb-3">
      <div class="max-w-[80%] rounded-xl bg-gray-900 px-4 py-2.5 text-sm text-white leading-relaxed">${escapeHtml(text)}</div>
    </div>`;
  }
  return `<div class="flex gap-2.5 mb-3">
    <div class="mt-0.5 h-6 w-6 rounded-full bg-brand-600 flex items-center justify-center shrink-0 text-white text-[10px] font-bold select-none">J</div>
    <div class="max-w-[80%] rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">${escapeHtml(text)}</div>
  </div>`;
}

// ── Control de botones ─────────────────────────────────────────────────────
function setSendEnabled(enabled) {
  const btn = el("jc-btn-send");
  if (btn) btn.disabled = !enabled;
}

function setAbortVisible(visible) {
  const btn = el("jc-btn-abort");
  if (btn) btn.hidden = !visible;
}

// ── Iniciar runtime OpenCode ───────────────────────────────────────────────
async function startRuntime(coursePath) {
  setStatus("Iniciando OpenCode…", "working");
  const connectBtn = el("jc-btn-connect");
  if (connectBtn) connectBtn.disabled = true;
  try {
    const info = await invoke("opencode_start_course", { coursePath });
    _runtimeReady = info.status === "ready";
    setStatus(_runtimeReady ? "OpenCode listo" : "Offline", _runtimeReady ? "ready" : "error");
    if (!_runtimeReady && connectBtn) connectBtn.disabled = false;
    if (!_runtimeReady) {
      console.error("[jintia-chat] opencode_start_course no retornó ready:", info);
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
    _lastMsgCount = 0;
    return true;
  } catch (err) {
    console.error("[jintia-chat] agent_create_session error:", err);
    toast("No se pudo crear la sesión: " + String(err), "error", 6000);
    return false;
  }
}

// ── Polling de mensajes ────────────────────────────────────────────────────
function startPolling() {
  if (_polling) clearInterval(_polling);
  _polling = setInterval(async () => {
    if (!_sessionId || !_course?.project_path) return;
    try {
      const msgs = await invoke("agent_get_messages", {
        coursePath: _course.project_path,
        sessionId: _sessionId,
      });
      if (msgs.length > _lastMsgCount) {
        const newMsgs = msgs.slice(_lastMsgCount);
        _lastMsgCount = msgs.length;
        for (const msg of newMsgs) {
          const html = messageHtml(msg);
          if (html) appendMessage(html);
        }
        setStatus("OpenCode listo", "ready");
        setSendEnabled(true);
        setAbortVisible(false);
      }
    } catch (err) { console.warn("[jintia-chat] poll error:", err); }
  }, 1500);
}

function stopPolling() {
  if (_polling) { clearInterval(_polling); _polling = null; }
}

// ── Enviar mensaje ─────────────────────────────────────────────────────────
async function sendMessage() {
  const input = el("jc-input");
  const text = (input?.value || "").trim();
  if (!text || !_runtimeReady) return;

  if (!_sessionId) {
    const ok = await createSession();
    if (!ok) return;
    startPolling();
  }

  input.value = "";
  input.style.height = "auto";

  appendMessage(messageHtml({ role: "user", parts: [{ type: "text", text }] }));
  // Incrementar el contador para que el polling no duplique este mensaje
  // cuando la API lo refleje (OpenCode devuelve el mensaje del usuario en GET /message)
  _lastMsgCount += 1;
  setStatus("Jintia está pensando…", "working");
  setSendEnabled(false);
  setAbortVisible(true);

  try {
    await invoke("agent_send_message", {
      coursePath: _course.project_path,
      sessionId: _sessionId,
      message: text,
    });
  } catch (err) {
    setStatus("Error al enviar", "error");
    setSendEnabled(true);
    setAbortVisible(false);
    _lastMsgCount -= 1;
    toast("Error al enviar: " + String(err), "error", 5000);
  }
}

// ── API pública ────────────────────────────────────────────────────────────
/** Llamado desde courses.js al hacer clic en el botón Jintia de un curso. */
export function setActiveCourse(course, week) {
  _course = course;
  stopPolling();
  _sessionId = null;
  _runtimeReady = false;
  _lastMsgCount = 0;

  // Sincronizar selectores si ya se renderizó la página
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
  stopPolling();
  _sessionId = null;
  _lastMsgCount = 0;
  _runtimeReady = false;

  // Usar el primer curso disponible si no hay uno activo
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

  // Restaurar curso activo en los selectores
  if (_course?.project_path) {
    const sel = el("jc-course-select");
    if (sel) sel.value = _course.project_path;
  }

  bindChatEvents();
}

function bindChatEvents() {
  // Cambio de asignatura
  el("jc-course-select")?.addEventListener("change", e => {
    const path = e.target.value;
    _course = (state.courses || []).find(c => c.project_path === path) || null;
    _sessionId = null;
    _runtimeReady = false;
    stopPolling();
    setStatus("Desconectado", "neutral");
    el("jc-btn-connect").disabled = false;
    setSendEnabled(false);
    el("jc-input").disabled = true;
    el("jc-btn-new-session").disabled = true;
  });

  // Conectar runtime
  el("jc-btn-connect")?.addEventListener("click", async () => {
    if (!_course?.project_path) {
      toast("Selecciona una asignatura primero", "warning", 3000);
      return;
    }
    const ok = await startRuntime(_course.project_path);
    if (ok) {
      el("jc-input").disabled = false;
      setSendEnabled(true);
      el("jc-btn-new-session").disabled = false;
      // Limpiar placeholder y mostrar bienvenida
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

  // Nueva sesión
  el("jc-btn-new-session")?.addEventListener("click", () => {
    stopPolling();
    _sessionId = null;
    _lastMsgCount = 0;
    clearFeed();
    setStatus("OpenCode listo", "ready");
    setSendEnabled(true);
    setAbortVisible(false);
    toast("Nueva sesión iniciada", "success", 2000);
  });

  // Textarea: auto-resize + Enter para enviar
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

  // Botón enviar
  el("jc-btn-send")?.addEventListener("click", () => sendMessage());

  // Botón abortar
  el("jc-btn-abort")?.addEventListener("click", async () => {
    if (!_sessionId || !_course?.project_path) return;
    try {
      await invoke("agent_abort", {
        coursePath: _course.project_path,
        sessionId: _sessionId,
      });
      setStatus("Cancelado", "neutral");
      stopPolling();
      setSendEnabled(true);
      setAbortVisible(false);
    } catch (err) {
      toast("No se pudo cancelar: " + String(err), "error", 4000);
    }
  });
}
