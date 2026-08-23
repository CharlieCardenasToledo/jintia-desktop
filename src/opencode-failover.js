/**
 * opencode-failover.js — Failover automático de modelos para el chat de OpenCode.
 *
 * OpenCode server no tiene failover nativo entre proveedores (Claude → GPT →
 * Gemini): solo reintenta el mismo modelo con backoff (evento SSE
 * `session.status: {type:"retry"}`) y ese backoff puede quedarse mucho tiempo
 * sin llegar nunca a `session.error` — es un bug documentado del propio
 * OpenCode (SessionRetry.policy() sin límite de intentos en ciertos casos).
 * Jintia no puede esperar a que OpenCode decida solo; tiene que interceptar
 * el turno, decidir si vale la pena cambiar de modelo, y reanudarlo.
 *
 * Este módulo es intencionalmente puro (sin `invoke`, sin DOM, sin
 * `EventSource`): toda la lógica de decisión — clasificar un fallo, saber si
 * amerita cambiar de modelo, elegir el siguiente candidato, aplicar
 * cooldowns — vive aquí y es testeable con `node --test` sin levantar la app.
 * El pegamento con Tauri/SSE/DOM vive en jintia-chat.js.
 */

// ─── Clasificación de fallos ─────────────────────────────────────────────

export const FailureCategory = Object.freeze({
  MODEL_RATE_LIMIT:    "model_rate_limit",   // 429 puntual del modelo actual
  PROVIDER_QUOTA:      "provider_quota",     // cuota/billing agotada del proveedor
  PROVIDER_TIMEOUT:    "provider_timeout",   // el proveedor no respondió a tiempo
  RETRY_EXHAUSTED:     "retry_exhausted",    // OpenCode lleva demasiado reintentando el mismo modelo
  PROVIDER_UNAVAILABLE:"provider_unavailable", // 5xx / servicio caído
  MODEL_UNAVAILABLE:   "model_unavailable",  // el modelo no existe o fue retirado
  AUTH_FAILURE:        "auth_failure",       // 401/403, credenciales inválidas
  CONTEXT_OVERFLOW:    "context_overflow",   // se excedió la ventana de contexto
  SERVER_UNAVAILABLE:  "server_unavailable", // el propio servidor OpenCode no responde
  MCP_FAILURE:         "mcp_failure",        // falla de una tool (NotebookLM, etc.), no del LLM
  VALIDATION_ERROR:    "validation_error",   // error de Jintia (schema/gates), no del modelo
  UNKNOWN:             "unknown",
});

/**
 * Clasifica un fallo a partir de los campos disponibles en `session.error`
 * (o de un error HTTP local). Todos los campos son opcionales; se usa lo que
 * haya disponible.
 * @param {{statusCode?: number, name?: string, message?: string}} input
 * @returns {string} uno de FailureCategory
 */
export function classifyFailure({ statusCode, name, message } = {}) {
  const text = `${name || ""} ${message || ""}`.toLowerCase();

  // Herramientas (NotebookLM MCP u otras) — nunca es culpa del modelo elegido.
  if (/notebooklm|mcp\b|\btool\b.*(timeout|failed)/.test(text)) return FailureCategory.MCP_FAILURE;

  // Errores estructurales de Jintia (schema/gates) — no se arreglan cambiando de modelo.
  if (/jin-[a-z]+-\d{3}|bloqueado por|validate.*failed/.test(text)) return FailureCategory.VALIDATION_ERROR;

  if (statusCode === 401 || statusCode === 403 || /unauthorized|invalid api key|invalid.*credential|forbidden/.test(text)) {
    return FailureCategory.AUTH_FAILURE;
  }
  if (/context.?length|too many tokens|context.?overflow|maximum context|context window/.test(text)) {
    return FailureCategory.CONTEXT_OVERFLOW;
  }
  if (/quota|exhausted|insufficient.?balance|billing|credit/.test(text)) {
    return FailureCategory.PROVIDER_QUOTA;
  }
  if (statusCode === 429 || /rate.?limit/.test(text)) {
    return FailureCategory.MODEL_RATE_LIMIT;
  }
  if (typeof statusCode === "number" && statusCode >= 500 && statusCode <= 599) {
    return FailureCategory.PROVIDER_UNAVAILABLE;
  }
  if (/timeout|timed out|etimedout|deadline exceeded/.test(text)) {
    return FailureCategory.PROVIDER_TIMEOUT;
  }
  if (/model.*(not found|unavailable|unknown|does not exist)/.test(text)) {
    return FailureCategory.MODEL_UNAVAILABLE;
  }
  if (/econnrefused|enotfound|server.*(unreachable|down)|failed to fetch/.test(text)) {
    return FailureCategory.SERVER_UNAVAILABLE;
  }
  return FailureCategory.UNKNOWN;
}

/** Categorías que ameritan cambiar de modelo/proveedor automáticamente. */
const FAILOVER_ELIGIBLE = new Set([
  FailureCategory.MODEL_RATE_LIMIT,
  FailureCategory.PROVIDER_QUOTA,
  FailureCategory.PROVIDER_TIMEOUT,
  FailureCategory.RETRY_EXHAUSTED,
  FailureCategory.PROVIDER_UNAVAILABLE,
  FailureCategory.MODEL_UNAVAILABLE,
  FailureCategory.AUTH_FAILURE,
]);

export function isFailoverEligible(category) {
  return FAILOVER_ELIGIBLE.has(category);
}

/** ¿El cooldown aplica solo al modelo, o a todo el proveedor? */
export function blockScope(category) {
  switch (category) {
    case FailureCategory.PROVIDER_QUOTA:
    case FailureCategory.AUTH_FAILURE:
    case FailureCategory.SERVER_UNAVAILABLE:
      return "provider";
    default:
      return "model";
  }
}

const MINUTE = 60_000;

/** Duración del cooldown según categoría (ms). `Infinity` = hasta acción manual. */
export function cooldownMs(category, { retryAfterMs } = {}) {
  switch (category) {
    case FailureCategory.MODEL_RATE_LIMIT:     return retryAfterMs ?? MINUTE;
    case FailureCategory.RETRY_EXHAUSTED:      return MINUTE;
    case FailureCategory.PROVIDER_TIMEOUT:     return MINUTE;
    case FailureCategory.PROVIDER_UNAVAILABLE: return 2 * MINUTE;
    case FailureCategory.PROVIDER_QUOTA:       return retryAfterMs ?? 30 * MINUTE;
    case FailureCategory.MODEL_UNAVAILABLE:    return 10 * MINUTE;
    case FailureCategory.AUTH_FAILURE:         return Infinity;
    case FailureCategory.SERVER_UNAVAILABLE:   return 30_000;
    default:                                   return 30_000;
  }
}

// ─── Circuit breaker ──────────────────────────────────────────────────────

/**
 * Registro de salud de modelos/proveedores, compartido entre turnos y
 * conversaciones mientras la app está abierta (en memoria — no persiste
 * entre reinicios). Evita que dos conversaciones distintas pierdan tiempo
 * reintentando un modelo que otra ya descubrió agotado.
 */
export class ModelHealthRegistry {
  constructor() {
    /** @type {Map<string, {cooldownUntil: number, lastCategory: string, failures: number}>} */
    this._entries = new Map();
  }

  isAvailable(providerID, modelId) {
    const now = Date.now();
    const providerEntry = this._entries.get(`provider:${providerID}`);
    if (providerEntry && providerEntry.cooldownUntil > now) return false;
    const modelEntry = this._entries.get(`model:${providerID}:${modelId}`);
    if (modelEntry && modelEntry.cooldownUntil > now) return false;
    return true;
  }

  recordFailure(providerID, modelId, category, opts) {
    const scope = blockScope(category);
    const key = scope === "provider" ? `provider:${providerID}` : `model:${providerID}:${modelId}`;
    const ms = cooldownMs(category, opts);
    const prev = this._entries.get(key);
    this._entries.set(key, {
      cooldownUntil: ms === Infinity ? Infinity : Date.now() + ms,
      lastCategory: category,
      failures: (prev?.failures || 0) + 1,
    });
  }

  reset() {
    this._entries.clear();
  }
}

// ─── Model router ─────────────────────────────────────────────────────────

/**
 * Elige el siguiente modelo candidato de una lista (tal como la devuelve
 * `opencode_list_models`: `{id, provider_id, name}`), respetando el orden
 * dado, saltando los ya intentados en este turno y los que el circuit
 * breaker marca como en cooldown.
 * @param {{id: string, provider_id: string, name: string}[]} models
 * @param {{attemptedKeys?: Set<string>, registry?: ModelHealthRegistry}} [opts]
 */
export function pickNextModel(models, { attemptedKeys = new Set(), registry } = {}) {
  for (const m of models || []) {
    const key = `${m.provider_id}|${m.id}`;
    if (attemptedKeys.has(key)) continue;
    if (registry && !registry.isAvailable(m.provider_id, m.id)) continue;
    return m;
  }
  return null;
}

// ─── Turn Supervisor ──────────────────────────────────────────────────────

/**
 * Estado de un turno de chat en curso: qué modelo se está usando, cuáles ya
 * fallaron, y si hubo efectos secundarios (herramientas/archivos) que
 * impiden simplemente repetir el prompt original desde cero.
 */
export class TurnSupervisor {
  /**
   * @param {{originalPrompt: string, initialModel: {id:string, providerID:string, name?:string}|null, sessionId: string, registry?: ModelHealthRegistry}} opts
   */
  constructor({ originalPrompt, initialModel, sessionId, registry } = {}) {
    this.turnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.sessionId = sessionId;
    this.originalPrompt = originalPrompt;
    this.currentModel = initialModel || null;
    this.attemptedKeys = new Set(
      initialModel ? [`${initialModel.providerID}|${initialModel.id}`] : [],
    );
    this.failedModels = []; // { model, category, message }
    this.hasToolSideEffects = false;
    this.registry = registry || new ModelHealthRegistry();
    this.startedAt = Date.now();
  }

  /** Marcar que el modelo actual ya ejecutó al menos una herramienta (bash, edit, tool MCP...). */
  noteToolActivity() {
    this.hasToolSideEffects = true;
  }

  /**
   * Política de intercepción de `session.status: {type:"retry"}`. No cada
   * retry amerita cambiar de modelo — un backoff corto y transitorio es
   * normal — pero sí uno que ya lleva varios intentos o cuyo próximo intento
   * está demasiado lejos.
   * @param {{attempt?: number, next?: number}} status
   */
  shouldInterceptRetry(status = {}) {
    const attempt = status.attempt ?? 0;
    const waitMs = typeof status.next === "number" ? status.next - Date.now() : 0;
    if (attempt >= 2) return true;
    if (waitMs > 15000) return true;
    return false;
  }

  /** Registra el fallo del modelo actual en el circuit breaker y en el historial del turno. */
  recordFailure(category, message, opts) {
    const m = this.currentModel;
    if (m) {
      this.registry.recordFailure(m.providerID, m.id, category, opts);
      this.failedModels.push({ model: m, category, message });
    }
  }

  /** Siguiente modelo disponible que no se haya intentado ya en este turno. */
  nextCandidate(models) {
    return pickNextModel(models, { attemptedKeys: this.attemptedKeys, registry: this.registry });
  }

  /** Avanza el turno al modelo elegido (lo marca como intentado). */
  advanceTo(model) {
    this.currentModel = model;
    this.attemptedKeys.add(`${model.providerID}|${model.id}`);
  }

  /**
   * Prompt a reenviar al siguiente modelo. Si el modelo anterior no llegó a
   * ejecutar ninguna herramienta (SAFE_REPLAY), repetir el prompt original es
   * seguro. Si ya hubo efectos secundarios (RECOVERY_CONTINUE), pedir
   * continuar en vez de repetir evita duplicar trabajo — OpenCode conserva
   * el historial de la sesión, así que el nuevo modelo puede ver lo ya hecho.
   */
  buildRecoveryPrompt() {
    if (!this.hasToolSideEffects) return this.originalPrompt;
    return [
      "Continúa el turno interrumpido desde el estado actual de la sesión.",
      "No repitas operaciones que ya hayan finalizado ni vuelvas a crear archivos existentes.",
      "Verifica el estado real de los archivos antes de modificarlos.",
      "",
      `Instrucción original del usuario: ${this.originalPrompt}`,
    ].join("\n");
  }

  /** Etiquetas legibles de por qué falló cada modelo intentado, para el mensaje final. */
  summary() {
    return this.failedModels.map(f => `${f.model?.name || f.model?.id || "?"} — ${f.message || f.category}`);
  }
}
