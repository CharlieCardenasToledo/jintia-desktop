/**
 * jintia-progress.js — Progreso semántico de la skill en 5 fases humanas.
 *
 * `jintia ready` y `jintia plan approve` (skill/scripts/ready.js,
 * skill/runtime/core/plan-state.js) ahora emiten una línea por transición de
 * paso a stderr, con el sentinel `##JINTIA-EVENT##` seguido de JSON (ver
 * scripts/progress-events.js en el repo de la skill). Cuando el agente
 * OpenCode ejecuta esos comandos vía su tool de shell, esa salida llega a
 * Jintia Desktop como `part.state.output` del tool call correspondiente.
 *
 * Este módulo NO intenta adivinar el progreso del texto libre del agente:
 * traduce esos eventos deterministas (que la skill ya calculaba, solo no
 * los exponía incrementalmente) a 5 fases en lenguaje humano, siguiendo el
 * mismo patrón de tarjeta dedicada que ya existe para NotebookLM en
 * notebook-evidence.js.
 *
 * No hay evidencia local de si OpenCode entrega part.state.output de forma
 * incremental mientras el comando corre o solo al cerrar el part — por eso
 * ingest() se llama tanto al abrir como al cerrar el part, y el tracker
 * degrada con gracia a "avanza la fase de un salto al cerrar" si no hay
 * nada intermedio.
 */

import { escapeHtml } from "./dom.js";

const SENTINEL = "##JINTIA-EVENT##";

/** ¿Este tool call de shell corresponde a un comando jintia instrumentado?
 * Se comprueba el contenido del comando, no el nombre de la tool (el nombre
 * exacto que usa OpenCode para su tool de shell no está verificado en este
 * repo — igual que ocurrió con ask_question, más vale anclarse en algo que
 * sí podemos leer con certeza: el propio comando). */
export function isJintiaCliCall(part) {
  const command = part?.state?.input?.command;
  // La invocación real suele ser "node bin/jintia.js ready ..." (con ".js"
  // pegado al nombre) o el binario global "jintia ready ..." — ambas formas
  // deben reconocerse.
  return typeof command === "string" && /\bjintia(?:\.js)?\s+(ready|plan\s+approve)\b/.test(command);
}

/** Extrae todos los eventos `##JINTIA-EVENT##{...}` de un blob de texto
 * mixto (salida humana + líneas de evento). Tolerante a líneas corruptas o
 * truncadas a mitad (por ejemplo si OpenCode entrega un delta parcial). */
export function extractProgressEvents(text) {
  if (typeof text !== "string" || !text.includes(SENTINEL)) return [];
  const out = [];
  for (const line of text.split("\n")) {
    const idx = line.indexOf(SENTINEL);
    if (idx === -1) continue;
    try {
      const parsed = JSON.parse(line.slice(idx + SENTINEL.length));
      if (parsed && parsed.event === "work.progress") out.push(parsed);
    } catch { /* línea parcial o corrupta: se ignora, no es un evento válido */ }
  }
  return out;
}

export const MACRO_PHASES = [
  "Comprendiendo la semana",
  "Reuniendo evidencia",
  "Diseñando la guía",
  "Revisando la calidad",
  "Preparando el documento",
];

// Traduce {command, step} → {phase (1-5), label humano}. Los nombres de
// `step` son literales exactos usados en record()/emitProgress() del lado
// de la skill (ready.js, plan-state.js) — no slugs inventados aquí.
export const PHASE_MAP = {
  "plan-approve": {
    "syllabus-hash": { phase: 1, label: "Revisando la planificación de la asignatura" },
    week:            { phase: 1, label: "Identificando el resultado de aprendizaje" },
    targets:         { phase: 1, label: "Identificando el resultado de aprendizaje" },
    alignment:       { phase: 1, label: "Diseñando la experiencia de aprendizaje" },
    workload:        { phase: 1, label: "Calculando la carga de trabajo" },
    assessment:      { phase: 1, label: "Verificando actividades calificadas" },
    evidence:        { phase: 2, label: "Reuniendo evidencia" },
  },
  ready: {
    "validate --publish":        { phase: 4, label: "Revisando estructura académica" },
    "evidence provenance":       { phase: 4, label: "Comprobando el respaldo académico" },
    "bibliography (pre-render)": { phase: 4, label: "Revisando referencias" },
    "assets (SVG)":              { phase: 4, label: "Revisando figuras y recursos" },
    render:                      { phase: 5, label: "Preparando vista previa" },
    "html lint":                 { phase: 4, label: "Revisando presentación y legibilidad" },
    "render consistency":        { phase: 4, label: "Revisando presentación y legibilidad" },
    "html content":              { phase: 4, label: "Revisando presentación y legibilidad" },
    "bibliography (post-render)":{ phase: 4, label: "Comprobando citas" },
    preflight:                   { phase: 4, label: "Revisión final" },
    "compile (PDF)":             { phase: 5, label: "Generando documento final" },
  },
};

const TERMINAL_STEP = { command: "ready", step: "compile (PDF)" };

/** Estado acumulado de las 5 fases a lo largo de un turno. Nunca retrocede:
 * una fase que llegó a "done" no vuelve a "active" aunque lleguen eventos
 * antiguos fuera de orden. */
export class JintiaProgressTracker {
  constructor() {
    this._phaseState = new Array(MACRO_PHASES.length).fill("pending"); // pending|active|done|blocked
    this._currentLabel = null;
    this._blockedDetail = null;
  }

  ingest(events) {
    for (const evt of events) {
      const mapping = PHASE_MAP[evt?.command]?.[evt?.step];
      if (!mapping) continue;
      const idx = mapping.phase - 1;

      for (let i = 0; i < idx; i++) {
        if (this._phaseState[i] !== "blocked") this._phaseState[i] = "done";
      }
      // Fase ya cerrada (bloqueada o superada por una fase posterior que ya
      // llegó a "done"): un evento fuera de orden no debe reabrirla.
      if (this._phaseState[idx] === "blocked" || this._phaseState[idx] === "done") continue;

      if (evt.status === "blocked" || evt.status === "error") {
        this._phaseState[idx] = "blocked";
        this._blockedDetail = evt.detail || mapping.label;
        continue;
      }

      this._phaseState[idx] = "active";
      this._currentLabel = mapping.label;
      if ((evt.status === "ok" || evt.status === "skipped") && evt.command === TERMINAL_STEP.command && evt.step === TERMINAL_STEP.step) {
        this._phaseState[idx] = "done";
      }
    }
    return this;
  }

  hasProgress() {
    return this._phaseState.some(s => s !== "pending");
  }

  isBlocked() {
    return this._phaseState.includes("blocked");
  }

  /** Marcador por fase para renderizado: "done"→✓, "active"→●, "blocked"→!, "pending"→○. */
  markers() {
    return this._phaseState.map(state => ({
      pending: "○", active: "●", done: "✓", blocked: "!",
    }[state]));
  }

  currentLabel() {
    return this._currentLabel;
  }

  blockedDetail() {
    return this._blockedDetail;
  }
}

// ─── Tarjeta de UI (mismo patrón que notebook-evidence.js) ──────────────────

let _tracker = new JintiaProgressTracker();
let _cardEl  = null;

function phaseRowHtml(marker, label, isCurrent) {
  const markerClass = marker === "done" ? "text-emerald-600"
    : marker === "blocked" ? "text-red-600"
    : marker === "active" ? "text-amber-600"
    : "text-slate-300";
  const textClass = isCurrent ? "font-semibold text-slate-900" : marker === "done" ? "text-slate-500" : "text-slate-400";
  return `<li class="flex items-center gap-2"><span class="${markerClass}" aria-hidden="true">${marker}</span><span class="${textClass}">${escapeHtml(label)}</span></li>`;
}

function renderCardInner(tracker) {
  const rows = MACRO_PHASES.map((label, i) => {
    const state = tracker._phaseState[i];
    const marker = { pending: "○", active: "●", done: "✓", blocked: "!" }[state];
    const displayLabel = state === "active" && tracker.currentLabel() ? tracker.currentLabel() : label;
    return phaseRowHtml(marker, displayLabel, state === "active");
  }).join("");
  const blockedNote = tracker.isBlocked() && tracker.blockedDetail()
    ? `<p class="mt-2 text-xs text-red-600">${escapeHtml(tracker.blockedDetail())}</p>`
    : "";
  return `
    <article class="jc-message-card" aria-label="Progreso de la guía">
      <div class="px-4 py-3 text-sm leading-relaxed text-slate-800">
        <div class="jc-work-label"><span class="jc-work-label-dot" aria-hidden="true"></span>Preparando la guía</div>
        <ul class="mt-2 space-y-1.5 text-xs" data-jintia-progress-list>${rows}</ul>
        ${blockedNote}
      </div>
    </article>`;
}

function ensureCard(feed) {
  if (_cardEl?.isConnected) return _cardEl;
  const wrap = document.createElement("div");
  wrap.className = "jc-route-step mb-5 jc-msg-in";
  wrap.innerHTML = renderCardInner(_tracker);
  feed.appendChild(wrap);
  _cardEl = wrap;
  return wrap;
}

/**
 * Alimenta el tracker con los eventos de progreso encontrados en `output`
 * (normalmente `part.state.input` al abrir un tool call, o
 * `part.state.output` al cerrarlo) y actualiza la tarjeta si corresponde.
 * No hace nada si no hay eventos nuevos y el tracker tampoco tenía progreso
 * previo — evita crear una tarjeta vacía para cualquier llamada de shell.
 */
export function showJintiaProgress(feed, output) {
  if (!feed) return;
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  const events = extractProgressEvents(text);
  if (events.length === 0 && !_tracker.hasProgress()) return;
  _tracker.ingest(events);
  const wrap = ensureCard(feed);
  wrap.innerHTML = renderCardInner(_tracker);
}

export function resetJintiaProgress() {
  _tracker = new JintiaProgressTracker();
  _cardEl = null;
}
