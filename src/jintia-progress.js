/**
 * jintia-progress.js — Progreso semántico de la skill en 5 fases humanas.
 *
 * `jintia ready` y `jintia plan approve` (skill/scripts/ready.js,
 * skill/runtime/core/plan-state.js) emiten una línea por transición de paso
 * por DOS vías (ver scripts/progress-events.js en el repo de la skill):
 *
 * 1. `##JINTIA-EVENT##{...}` a stderr — llega a Jintia Desktop como
 *    `part.state.output` del tool call de OpenCode, pero solo AL CERRAR el
 *    tool call (confirmado empíricamente contra un servidor real, ver
 *    abajo): sirve para no perder nada, no para verlo en vivo.
 * 2. Un journal de archivo (`<courseRoot>/.jintia/runtime/progress/
 *    <runId>.jsonl`) vigilado por un watcher nativo en Rust
 *    (`src-tauri/src/progress_journal.rs`, `notify`, no polling), que
 *    reenvía cada línea nueva como evento Tauri `"jintia-progress"` — este
 *    SÍ llega en vivo, segundo a segundo, sin pasar por OpenCode en
 *    absoluto. `startJournalListener()` de este módulo consume ese canal.
 *
 * Ambas vías alimentan el MISMO `JintiaProgressTracker.ingest()` — el
 * tracker no distingue de dónde vino un evento, solo procesa su forma
 * `{command, step, status, detail}`. La vía 1 (SSE) queda como respaldo: si
 * el journal no llegó a iniciarse (permisos, disco, etc.), sigue habiendo
 * progreso, aunque degradado a "avanza de un salto al cerrar el tool call".
 *
 * Regla de diseño no negociable: la interfaz nunca marca ✓ en una fase que
 * la skill no haya confirmado explícitamente. Concretamente:
 *   - Una fase sin NINGÚN evento propio se queda en "pendiente" (○) para
 *     siempre — nunca se fabrica un ✓ para una fase sin evidencia real (ver
 *     REGRESIÓN de fase-3 en la revisión anterior).
 *   - Una fase que SÍ tiene evidencia propia (llegó a "active" por al menos
 *     un evento real) se cierra a "done" cuando (a) su propio paso terminal
 *     reporta "ok"/"skipped", o (b) una fase posterior cualquiera empieza a
 *     reportar actividad — porque si el trabajo avanzó más allá, esta fase
 *     ya no puede seguir "en curso". (b) es necesario porque un comando
 *     (`plan approve`, `ready`) reparte sus propios pasos entre dos fases
 *     (1+2, 4+5) y el paso terminal SOLO cierra la ÚLTIMA de esas dos — sin
 *     (b), la fase interior se queda "activa" para siempre aunque el propio
 *     comando ya haya progresado más allá de ella.
 *   - Un comando SIN eventos finos (ver COARSE_COMMANDS) solo se marca
 *     "done" si su salida permite CONFIRMAR éxito (JSON parseable con un
 *     campo de estado reconocible) — OpenCode no expone el exit code del
 *     comando ejecutado (confirmado empíricamente: `state.status` del tool
 *     call es "completed" tanto si el comando exitoso como si falló), así
 *     que cerrar la fase sin poder confirmarlo sería fabricar un ✓ igual de
 *     inválido que los que esta regla prohíbe. Sin confirmación, la fase se
 *     queda "activa" (no bloqueada, no cerrada) hasta que otra señal la
 *     resuelva.
 *
 * Confirmado empíricamente (ejecución real vía el servidor OpenCode,
 * session.shell + suscripción a /event, y además contra una custom tool
 * propia usando context.metadata() — ni en la versión estable ni en el
 * build dev más reciente): OpenCode NO entrega ninguna actualización
 * incremental de una tool call mientras corre, ni por part.state.output ni
 * por metadata — todo llega de una sola vez al cerrar. Por eso el progreso
 * en vivo de este módulo depende enteramente del journal (vía 2 arriba),
 * no de nada que pase por OpenCode.
 */

import { escapeHtml } from "./dom.js";
import { listen } from "@tauri-apps/api/event";

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
// aquí la fase de ESE paso puede pasar a "done" (o "skipped" si el paso se
// saltó deliberadamente, ej. --skip-pdf) directamente por su propio status.
// Una fase INTERIOR de ese mismo comando (ej. la fase 1 de plan-approve,
// cuyo único paso terminal declarado aquí es "evidence" — que en realidad
// es fase 2) se cierra por la regla de "fase posterior activa" en
// JintiaProgressTracker.ingest(), no por esta tabla.
const TERMINAL_STEPS = {
  ready: "compile (PDF)",
  "plan-approve": "evidence",
};

// Comandos jintia que la skill NO instrumenta con eventos finos (no tienen
// una secuencia de sub-pasos como ready/plan-approve — son operaciones de
// un solo gate). Se les da progreso de una sola fase basado en el
// contenido de su output al cerrar (ver interpretCoarseOutcome) — nunca en
// el mero hecho de que el tool call haya cerrado, porque OpenCode no
// distingue un cierre exitoso de uno fallido (confirmado: state.status es
// "completed" incluso con exit code != 0). `terminal:true` marca la fase
// como candidata a "done" SOLO si además se pudo confirmar éxito.
const COARSE_COMMANDS = {
  "plan save":      { phase: 1, label: "Guardando la planificación de la semana" },
  "plan check":     { phase: 1, label: "Revisando el estado del plan" },
  "evidence check": { phase: 2, label: "Comprobando evidencia disponible" },
  // "guide create" NO redacta la guía — recibe un draft.json que la IA ya
  // escribió antes, verifica plan/evidencia, valida el draft, y lo copia a
  // guide.json. La etiqueta refleja eso, no el momento creativo (que ya
  // ocurrió antes de esta llamada, fuera de cualquier comando jintia).
  "guide create":   { phase: 3, label: "Registrando la guía redactada" },
  "guide finalize": { phase: 3, label: "Cerrando la guía", terminal: true },
  validate:         { phase: 4, label: "Revisando estructura académica" },
  render:           { phase: 4, label: "Preparando vista previa" },
  preflight:        { phase: 4, label: "Revisión final" },
  compile:          { phase: 5, label: "Generando documento final", terminal: true },
};

/**
 * ¿El output de un comando "coarse" permite confirmar éxito o fallo? No hay
 * exit code disponible (ver arriba) — el único rastro es el propio output.
 * Los comandos de esta familia usan formas JSON heterogéneas
 * (`{status:"success"|"failed",...}` vía report.js/createReport() para
 * validate/render/preflight/compile; `{status:"saved"|"error",...}` para
 * plan save; `{ok:true|false,...}` para plan check/approve-like) — en vez
 * de mantener una lista por comando, se buscan las señales que SÍ son
 * inequívocas en cualquiera de esas formas. Si no hay salida parseable con
 * una señal reconocible, devuelve "unknown" — nunca "ok" por defecto, para
 * no fabricar una confirmación que no existe.
 */
export function interpretCoarseOutcome(output) {
  const text = typeof output === "string" ? output : "";
  if (!text.trim()) return "unknown";
  let data;
  try { data = JSON.parse(text); } catch { return "unknown"; }
  if (!data || typeof data !== "object") return "unknown";
  if (typeof data.status === "string") {
    if (data.status === "success" || data.status === "saved" || data.status === "approved") return "ok";
    if (data.status === "failed" || data.status === "error" || data.status === "blocked") return "blocked";
  }
  if (typeof data.ok === "boolean") return data.ok ? "ok" : "blocked";
  if (typeof data.exitCode === "number") return data.exitCode === 0 ? "ok" : "blocked";
  return "unknown";
}

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

  /** Cierra a "done" cualquier fase ANTERIOR a `idx` que ya esté "active"
   * (tiene evidencia real propia). Nunca toca una fase "pending" (sin
   * ningún evento) — esa es la línea que separa esto de la regresión de la
   * revisión anterior ("fabricar ✓ para fases sin evidencia"). Aquí la
   * evidencia sí existe: la fase ya recibió al menos un evento real: lo
   * único que faltaba confirmar es que no vendrán más eventos suyos, y eso
   * lo prueba el hecho de que el trabajo ya avanzó a una fase posterior. */
  _closeEarlierActivePhases(idx) {
    for (let i = 0; i < idx; i++) {
      if (this._phaseState[i] === "active") this._phaseState[i] = "done";
    }
  }

  ingest(events) {
    for (const evt of events) {
      const mapping = PHASE_MAP[evt?.command]?.[evt?.step];
      if (!mapping) continue;
      const idx = mapping.phase - 1;
      if (this._isClosed(idx)) continue;

      this._closeEarlierActivePhases(idx);

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

  /** Progreso de un comando SIN eventos finos (ver COARSE_COMMANDS y
   * interpretCoarseOutcome). `outcome` es "running" (tool call recién
   * abierto), "ok"/"blocked" (confirmado por el contenido del output), o
   * "unknown" (cerró pero no se pudo confirmar nada) — "running" y
   * "unknown" se tratan igual (activa, sin cerrar) porque ninguno de los
   * dos es evidencia de éxito. */
  ingestCoarse(key, outcome) {
    const mapping = COARSE_COMMANDS[key];
    if (!mapping) return this;
    const idx = mapping.phase - 1;
    if (this._isClosed(idx)) return this;

    this._closeEarlierActivePhases(idx);

    if (outcome === "blocked") {
      this._phaseState[idx] = "blocked";
      this._blockedDetail = mapping.label;
      return this;
    }
    this._phaseState[idx] = "active";
    this._currentLabel = mapping.label;
    if (outcome === "ok" && mapping.terminal) this._phaseState[idx] = "done";
    return this;
  }

  /** NotebookLM consultado (ver notebook-evidence.js): evidencia real de
   * que la fase 2 está en curso, aunque no venga de un comando jintia. No
   * la marca "done" — solo sabemos que hubo actividad, no que terminó. */
  noteEvidenceActivity() {
    const idx = 1;
    if (this._isClosed(idx)) return this;
    this._closeEarlierActivePhases(idx);
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
      // Al cerrar, OpenCode no distingue éxito de fallo en sus metadatos
      // (confirmado empíricamente) — el único rastro real es el propio
      // output, interpretado por interpretCoarseOutcome. "running" solo se
      // usa al abrir, cuando por definición aún no hay resultado que leer.
      const outcome = opening ? "running" : interpretCoarseOutcome(output);
      _tracker.ingestCoarse(coarse, outcome);
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

/**
 * Suscribe el canal de progreso EN VIVO (journal + watcher nativo, ver
 * cabecera del archivo) para un curso concreto. `getFeed` se llama en cada
 * evento (no una sola vez al suscribir) para tolerar que el feed del chat
 * se recree entre turnos — mismo patrón que `el(...)` en jintia-chat.js.
 *
 * Cada evento nativo trae `{coursePath, event}` (ver
 * src-tauri/src/progress_journal.rs) porque puede haber más de un curso con
 * sesión activa a la vez; los de un curso distinto al indicado se ignoran
 * para no mezclar el progreso de dos trabajos.
 *
 * @returns {Promise<() => void>} función para cancelar la suscripción.
 */
export async function startJournalListener(coursePath, getFeed) {
  return listen("jintia-progress", event => {
    const payload = event?.payload;
    if (!payload || payload.coursePath !== coursePath) return;
    const feed = typeof getFeed === "function" ? getFeed() : getFeed;
    if (!feed) return;
    _tracker.ingest([payload.event]);
    renderIfTouched(feed, true);
  });
}

/**
 * Extrae el reporte real de `jintia ready --json` de la salida de un tool
 * call (el shape que ya produce `createReport()` del lado de la skill,
 * confirmado en los commits `afb83a0`/`4456dd5`: `{..., data: {tool,
 * deterministicDecision, revision, ...}}`). Se usa para detectar
 * `PRECHECK_READY` + `revision.hash` y mostrar la tarjeta de vista previa/
 * aprobación — independiente de `extractProgressEvents`, que sigue
 * ocupándose solo de los eventos `##JINTIA-EVENT##` de progreso.
 * @returns {object|null}
 */
export function extractReadyReport(output) {
  const text = typeof output === "string" ? output : "";
  if (!text.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || parsed.data?.tool !== "jintia ready") return null;
  return parsed.data;
}
