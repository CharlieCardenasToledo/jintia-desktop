/**
 * notebook-evidence.js — Tarjetas de evidencia de NotebookLM en Ask Jintia.
 *
 * Cuando OpenCode consulta la tool `ask_question` del MCP de NotebookLM
 * (gemini-notebooklm-mcp), el usuario debe ver la PREGUNTA EXACTA enviada
 * y, al terminar, la RESPUESTA EXACTA obtenida — sin resumir, reformular ni
 * inferir — marcada explícitamente como evidencia de fuentes. No se
 * presenta como otro turno de chat (Jintia ya dejó de ser un chatbot): es
 * una tarjeta de evidencia aparte, correlacionada por `callID` porque
 * OpenCode puede hacer varias consultas en un mismo turno y ninguna debe
 * sobrescribir a la anterior.
 *
 * Forma real verificada contra el código fuente de gemini-notebooklm-mcp
 * (src/types.ts AskQuestionResult, src/tools/handlers.ts, src/index.ts):
 * el handler devuelve `{ success, data: AskQuestionResult }` y el server
 * MCP lo envía como `{ content: [{type:"text", text: JSON.stringify(...)}],
 * structuredContent: payload }`. No hay evidencia local de qué forma
 * exacta expone OpenCode en `part.state.output` (string, objeto MCP crudo,
 * o ya desenvuelto) — por eso `unwrapAskQuestionOutput` acepta varias.
 */

import { escapeHtml } from "./dom.js";

const _cards = new Map(); // callID -> { wrap }

/** OpenCode puede prefijar el nombre de tool con el servidor MCP
 * ("notebooklm_ask_question" o similar); "ask_question" es un nombre
 * suficientemente específico como para no necesitar exigir el prefijo. */
export function isNotebookAskQuestionTool(toolName) {
  return typeof toolName === "string" && /ask_question/i.test(toolName);
}

export function unwrapAskQuestionOutput(output) {
  let value = output;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  if (value.structuredContent && typeof value.structuredContent === "object") {
    value = value.structuredContent;
  } else if (Array.isArray(value.content) && typeof value.content[0]?.text === "string") {
    try { value = JSON.parse(value.content[0].text); } catch { /* se intenta igual con el objeto original */ }
  }
  if (value.data && typeof value.data === "object") {
    return { ...value.data, _success: value.success !== false };
  }
  if (typeof value.question === "string" || typeof value.answer === "string") {
    return { ...value, _success: value.status !== "error" && value.success !== false };
  }
  if (value.success === false || value.error) {
    return { _success: false, error: value.error || "NotebookLM no pudo responder." };
  }
  return null;
}

export function sourceLabel(source) {
  const name = source.sourceName || source.source_name || "Fuente";
  const location = source.location || {};
  const where = location.page ? `p. ${location.page}` : location.slide ? `diapositiva ${location.slide}` : "";
  return where ? `${name} · ${where}` : name;
}

function ensureCard(feed, callID) {
  const existing = _cards.get(callID);
  if (existing?.wrap?.isConnected) return existing;
  const wrap = document.createElement("div");
  wrap.className = "jc-route-step mb-5 jc-msg-in";
  wrap.innerHTML = `
    <article class="jc-message-card" aria-label="Evidencia de NotebookLM">
      <div class="px-4 py-3 text-sm leading-relaxed text-slate-800">
        <div class="jc-work-label">
          <span class="jc-work-label-dot" aria-hidden="true"></span>Fuente · NotebookLM
          <span class="ml-auto rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700" data-nb-status>En curso</span>
        </div>
        <p class="mt-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">Consulta</p>
        <p class="mt-0.5 whitespace-pre-line break-words font-medium text-slate-900" data-nb-question></p>
        <p class="mt-2 text-xs text-slate-500" data-nb-progress>Consultando las fuentes del curso…</p>
        <div class="mt-3 hidden" data-nb-answer-wrap>
          <p class="text-[11px] font-bold uppercase tracking-wider text-slate-500">Respuesta de las fuentes</p>
          <p class="mt-0.5 whitespace-pre-line break-words text-sm leading-relaxed text-slate-800" data-nb-answer></p>
        </div>
        <div class="mt-3 hidden" data-nb-sources-wrap>
          <p class="text-[11px] font-bold uppercase tracking-wider text-slate-500" data-nb-sources-label></p>
          <ul class="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-600" data-nb-sources></ul>
        </div>
      </div>
    </article>`;
  feed.appendChild(wrap);
  const card = { wrap };
  _cards.set(callID, card);
  return card;
}

/**
 * Se llama cuando `ask_question` empieza a ejecutarse
 * (`message.part.updated`, part abierto, `state.status === "running"`).
 * Muestra la pregunta exacta de inmediato — sin esperar la respuesta.
 */
export function showNotebookQuestionRunning(feed, callID, input) {
  if (!feed || !callID) return;
  const question = input?.question;
  if (typeof question !== "string" || !question.trim()) return;
  const card = ensureCard(feed, callID);
  const questionEl = card.wrap.querySelector("[data-nb-question]");
  if (questionEl) questionEl.textContent = question;
}

/**
 * Se llama cuando `ask_question` termina (part cerrado, `state.status`
 * "completed" o "error"). Si la tarjeta de "running" nunca se creó (por
 * ejemplo, este evento llegó antes de que se procesara el de apertura),
 * la crea igual — la pregunta se toma de `output.question` en ese caso.
 */
export function showNotebookQuestionCompleted(feed, callID, output) {
  if (!feed || !callID) return;
  const parsed = unwrapAskQuestionOutput(output);
  const card = ensureCard(feed, callID);
  const statusEl = card.wrap.querySelector("[data-nb-status]");
  const questionEl = card.wrap.querySelector("[data-nb-question]");
  const progressEl = card.wrap.querySelector("[data-nb-progress]");
  const answerWrap = card.wrap.querySelector("[data-nb-answer-wrap]");
  const answerEl = card.wrap.querySelector("[data-nb-answer]");
  const sourcesWrap = card.wrap.querySelector("[data-nb-sources-wrap]");
  const sourcesLabelEl = card.wrap.querySelector("[data-nb-sources-label]");
  const sourcesEl = card.wrap.querySelector("[data-nb-sources]");

  if (!parsed || !parsed._success) {
    if (statusEl) {
      statusEl.textContent = "Error";
      statusEl.className = "ml-auto rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-700";
    }
    if (progressEl) {
      progressEl.textContent = parsed?.error || "No se pudo obtener evidencia de NotebookLM.";
      progressEl.className = "mt-2 text-xs text-red-600";
    }
    if (questionEl && parsed?.question && !questionEl.textContent) questionEl.textContent = parsed.question;
    return;
  }

  if (questionEl && parsed.question) questionEl.textContent = parsed.question;
  if (statusEl) {
    statusEl.textContent = "Obtenido";
    statusEl.className = "ml-auto rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-green-700";
  }
  if (progressEl) progressEl.hidden = true;
  if (answerWrap && answerEl && parsed.answer) {
    answerWrap.hidden = false;
    answerEl.textContent = parsed.answer;
  }
  if (sourcesWrap && sourcesLabelEl && sourcesEl && Array.isArray(parsed.sources) && parsed.sources.length) {
    sourcesWrap.hidden = false;
    sourcesLabelEl.textContent = `${parsed.sources.length} fuente${parsed.sources.length === 1 ? "" : "s"} utilizada${parsed.sources.length === 1 ? "" : "s"}`;
    sourcesEl.innerHTML = parsed.sources.map(s => `<li>${escapeHtml(sourceLabel(s))}</li>`).join("");
  }
}

export function resetNotebookEvidenceCards() {
  _cards.clear();
}
