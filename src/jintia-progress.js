/**
 * jintia-progress.js — Progreso semántico de la skill en 5 fases humanas.
 *
 * `jintia ready` y `jintia plan approve` (skill/scripts/ready.js,
 * skill/runtime/core/plan-state.js) emiten una línea por transición de paso
 * a stderr, con el sentinel `##JINTIA-EVENT##` seguido de JSON (ver
 * scripts/progress-events.js en el repo de la skill). Cuando el agente
 * OpenCode ejecuta esos comandos vía su tool de shell, esa salida llega a
 * Jintia Desktop como `part.state.output` del tool call correspondiente.
 *
 * Regla de diseño no negociable: la interfaz nunca marca ✓ en una fase que
 * la skill no haya confirmado explícitamente. Concretamente, eso significa
 * que este módulo NO rellena fases anteriores como "hechas" solo porque
 * llegó un evento de una fase posterior — si nunca se instrumentó o nunca
 * corrió ese paso en este turno, la fase se queda en "pendiente" (○), no en
 * "✓" fabricado. El precio de esta honestidad es que un turno que solo
 * ejecuta `jintia ready` (porque el plan ya se aprobó en un turno anterior)
 * muestra las fases 1-3 en ○ aunque ese trabajo ya haya ocurrido realmente
 * — es preferible a mentir con un checkmark no confirmado.
 *
 * No hay evidencia local de si OpenCode entrega part.state.output de forma
 * incremental mientras el comando corre o solo al cerrar el part — por eso
 * se alimenta tanto al abrir como al cerrar el part, y el tracker degrada
 * con gracia a "avanza la fase de un salto al cerrar" si no hay nada
 * intermedio. Sigue sin confirmarse contra una ejecución real.
 */

import { escapeHtml } from "./dom.js";

const SENTINEL = "##JINTIA-EVENT##";

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
//
// `render` vive en fase 4, no en fase 5: la cadena real de `ready` es
// validate→evidence→bibliografía→assets→render→html-lint→consistency→
// html-content→bibliografía→preflight→compile — render NO es el último
// paso antes de compile, es uno más de la verificación de calidad. Antes
// estaba mal puesto en fase 5, lo que rompía la monotonía del tracker
// (fase 5 activa, luego html-lint/preflight de fase 4 quedaban ignorados
// porque el tracker no retrocede). Con toda la cadena de calidad en fase 4
// y solo compile en fase 5, la secuencia real es monotónica sin necesitar
// lógica especial.
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
    "validate --publish":         { phase: 4, label: "Revisando estructura académica" },
    "evidence provenance":        { phase: 4, label: "Comprobando el respaldo académico" },
    "bibliography (pre-render)":  { phase: 4, label: "Revisando referencias" },
    "assets (SVG)":               { phase: 4, label: "Revisando figuras y recursos" },
    render:                       { phase: 4, label: "Preparando vista previa" },
    "html lint":                  { phase: 4, label: "Revisando presentación y legibilidad" },
    "render consistency":         { phase: 4, label: "Revisando presentación y legibilidad" },
    "html content":               { phase: 4, label: "Revisando presentación y legibilidad" },
    "bibliography (post-render)": { phase: 4, label: "Comprobando citas" },
    preflight:                    { phase: 4, label: "Revisión final" },
    "compile (PDF)":              { phase: 5, label: "Generando documento final" },
  },
};

// El último paso de cada comando que SÍ emite eventos finos: solo al llegar
// aquí una fase puede pasar a "done" (o "skipped" si el paso se saltó
// deliberadamente, ej. --skip-pdf). Antes solo existía esta noción para
// ready/compile — plan-approve nunca cerraba su fase y se quedaba "activo"
// para siempre aunque hubiera terminado con éxito.
const TERMINAL_STEPS = {
  ready: "compile (PDF)",
  "plan-approve": "evidence",
};

// Comandos jintia que la skill NO instrumenta con eventos finos (no tienen
// una secuencia de sub-pasos como ready/plan-approve — son operaciones de
// un solo gate). Se les da progreso de una sola fase basado únicamente en
// que el tool call abrió/cerró, no en contenido de stderr. `terminal:true`
// marca la fase como "done" al cerrar con éxito.
const COARSE_COMMANDS = {
  "plan save":      { phase: 1, label: "Guardando la planificación de la semana" },
  "plan check":     { phase: 1, label: "Revisando el estado del plan" },
  "evidence check": { phase: 2, label: "Comprobando evidencia disponible" },
  "guide create":   { phase: 3, label: "Redactando la guía" },
  "guide finalize": { phase: 3, label: "Cerrando la guía", terminal: true },
  validate:         { phase: 4, label: "Revisando estructura académica" },
  render:           { phase: 4, label: "Preparando vista previa" },
  preflight:        { phase: 4, label: "Revisión final" },
  compile:          { phase: 5, label: "Generando documento final", terminal: true },
};

function matchCoarseCommand(command) {
  if (typeof command !== "string") return null;
  for (const key of Object.keys(COARSE_COMMANDS)) {
    const pattern = new RegExp(`\\bjintia(?:\\.js)?\\s+${key.replace(" ", "\\s+")}\\b`);
    if (pattern.test(command)) return key;
  }
  return null;
}

/** ¿Este tool call de shell corresponde a un comando jintia con progreso
 * traducible (fino o de una sola fase)? Se comprueba el contenido del
 * comando, no el nombre de la tool (el nombre exacto que usa OpenCode para
 * su tool de shell no está verificado en este repo — igual que ocurrió con
 * ask_question, más vale anclarse en algo que sí podemos leer con certeza:
 * el propio comando). */
export function isJintiaCliCall(part) {
  const command = part?.state?.input?.command;
  if (typeof command !== "string") return false;
  if (/\bjintia(?:\.js)?\s+(ready|plan\s+approve)\b/.test(command)) return true;
  return matchCoarseCommand(command) !== null;
}

/** Estado acumulado de las 5 fases a lo largo de un trabajo (se reinicia
 * por cada mensaje nuevo del usuario, ver resetJintiaProgress()). Nunca
 * retrocede ni fabrica una fase anterior como completada. */
export class JintiaProgressTracker {
  constructor() {
    this._phaseState = new Array(MACRO_PHASES.length).fill("pending"); // pending|active|done|blocked|skipped
    this._currentLabel = null;
    this._blockedDetail = null;
    this._skippedDetail = null;
  }

  _isClosed(idx) {
    return ["blocked", "done", "skipped"].includes(this._phaseState[idx]);
  }

  ingest(events) {
    for (const evt of events) {
      const mapping = PHASE_MAP[evt?.command]?.[evt?.step];
      if (!mapping) continue;
      const idx = mapping.phase - 1;
      if (this._isClosed(idx)) continue;

      if (evt.status === "blocked" || evt.status === "error") {
        this._phaseState[idx] = "blocked";
        this._blockedDetail = evt.detail || mapping.label;
        continue;
      }

      this._phaseState[idx] = "active";
      this._currentLabel = mapping.label;

      const isTerminal = TERMINAL_STEPS[evt.command] === evt.step;
      if (isTerminal && evt.status === "ok") {
        this._phaseState[idx] = "done";
      } else if (isTerminal && evt.status === "skipped") {
        // Ej. `ready --skip-pdf`: deterministicDecision queda en
        // PRECHECK_READY, no READY — un ✓ aquí sería engañoso (el PDF
        // deliberadamente no se generó), así que se distingue de "done".
        this._phaseState[idx] = "skipped";
        this._skippedDetail = evt.detail || mapping.label;
      }
    }
    return this;
  }

  /** Progreso de un comando SIN eventos finos (ver COARSE_COMMANDS):
   * una sola fase, activa mientras corre, "done" solo si terminal+ok. */
  ingestCoarse(key, status) {
    const mapping = COARSE_COMMANDS[key];
    if (!mapping) return this;
    const idx = mapping.phase - 1;
    if (this._isClosed(idx)) return this;
    this._phaseState[idx] = "active";
    this._currentLabel = mapping.label;
    if (status === "ok" && mapping.terminal) this._phaseState[idx] = "done";
    return this;
  }

  /** NotebookLM consultado (ver notebook-evidence.js): evidencia real de
   * que la fase 2 está en curso, aunque no venga de un comando jintia. No
   * la marca "done" — solo sabemos que hubo actividad, no que terminó. */
  noteEvidenceActivity() {
    const idx = 1;
    if (this._isClosed(idx)) return this;
    this._phaseState[idx] = "active";
    this._currentLabel = "Reuniendo evidencia";
    return this;
  }

  hasProgress() {
    return this._phaseState.some(s => s !== "pending");
  }

  isBlocked() {
    return this._phaseState.includes("blocked");
  }

  markers() {
    return this._phaseState.map(state => ({
      pending: "○", active: "●", done: "✓", blocked: "!", skipped: "–",
    }[state]));
  }

  currentLabel() { return this._currentLabel; }
  blockedDetail() { return this._blockedDetail; }
  skippedDetail() { return this._skippedDetail; }
}

// ─── Tarjeta de UI (mismo patrón que notebook-evidence.js) ──────────────────

let _tracker = new JintiaProgressTracker();
let _cardEl  = null;

function phaseRowHtml(marker, label, isCurrent) {
  const markerClass = marker === "✓" ? "text-emerald-600"
    : marker === "!" ? "text-red-600"
    : marker === "●" ? "text-amber-600"
    : marker === "–" ? "text-slate-400"
    : "text-slate-300";
  const textClass = isCurrent ? "font-semibold text-slate-900" : marker === "✓" ? "text-slate-500" : "text-slate-400";
  return `<li class="flex items-center gap-2"><span class="${markerClass}" aria-hidden="true">${marker}</span><span class="${textClass}">${escapeHtml(label)}</span></li>`;
}

function renderCardInner(tracker) {
  const markers = tracker.markers();
  const rows = MACRO_PHASES.map((label, i) => {
    const state = tracker._phaseState[i];
    const displayLabel = state === "active" && tracker.currentLabel() ? tracker.currentLabel() : label;
    return phaseRowHtml(markers[i], displayLabel, state === "active");
  }).join("");
  const notes = [
    tracker.isBlocked() && tracker.blockedDetail() ? `<p class="mt-2 text-xs text-red-600">${escapeHtml(tracker.blockedDetail())}</p>` : "",
    tracker.skippedDetail() ? `<p class="mt-2 text-xs text-slate-500">Documento no generado (${escapeHtml(tracker.skippedDetail())}).</p>` : "",
  ].filter(Boolean).join("");
  return `
    <article class="jc-message-card" aria-label="Progreso de la guía">
      <div class="px-4 py-3 text-sm leading-relaxed text-slate-800">
        <div class="jc-work-label"><span class="jc-work-label-dot" aria-hidden="true"></span>Preparando la guía</div>
        <ul class="mt-2 space-y-1.5 text-xs" data-jintia-progress-list>${rows}</ul>
        ${notes}
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

function renderIfTouched(feed, touched) {
  if (!touched && !_tracker.hasProgress()) return;
  const wrap = ensureCard(feed);
  wrap.innerHTML = renderCardInner(_tracker);
}

/**
 * Se llama al abrir y al cerrar un tool call de shell que invoca `jintia`.
 * `output` es `part.state.input` al abrir (normalmente sin eventos reales
 * todavía) o `part.state.output` al cerrar. `command` es el comando de
 * shell completo (`part.state.input.command`), usado para decidir el
 * progreso "de una sola fase" cuando el comando no tiene eventos finos
 * propios (ver COARSE_COMMANDS). `opening` distingue apertura de cierre
 * para esos comandos de una sola fase (running vs. ok).
 */
export function showJintiaProgress(feed, { command, output, opening = false } = {}) {
  if (!feed) return;
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  const events = extractProgressEvents(text);

  let touched = false;
  if (events.length > 0) {
    _tracker.ingest(events);
    touched = true;
  } else {
    const coarse = matchCoarseCommand(command);
    if (coarse) {
      _tracker.ingestCoarse(coarse, opening ? "running" : "ok");
      touched = true;
    }
  }
  renderIfTouched(feed, touched);
}

/** Ver JintiaProgressTracker.noteEvidenceActivity(). */
export function noteJintiaEvidenceActivity(feed) {
  if (!feed) return;
  _tracker.noteEvidenceActivity();
  renderIfTouched(feed, true);
}

/** Un trabajo (turno) nuevo empieza una tarjeta de progreso nueva — el
 * progreso pertenece al trabajo, no a toda la conversación. */
export function resetJintiaProgress() {
  _tracker = new JintiaProgressTracker();
  _cardEl = null;
}
