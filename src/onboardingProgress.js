// Mapea nombres canónicos de dependencia al evento Tauri que el backend emite.
export const DEPENDENCY_EVENTS = {
  "Node.js": "node-download-progress",
  "Python": "python-download-progress",
  "Jintia Skill": "skill-download-progress",
};

const PHASE_LABELS = {
  downloading: "Descargando…",
  verifying: "Verificando…",
  extracting: "Extrayendo…",
  configuring: "Configurando…",
  installing: "Instalando…",
  installing_pip: "Instalando pip…",
  validating: "Validando…",
  testing: "Probando…",
  activating: "Activando…",
  done: "Listo",
  error: "Error",
};

export function normalizeProgressPayload(payload) {
  const rawMsg = payload?.message;
  const rawPhase = payload?.phase;

  const message =
    (typeof rawMsg === "string" && rawMsg.trim() ? rawMsg.trim() : null) ??
    (typeof rawPhase === "string" ? (PHASE_LABELS[rawPhase] ?? rawPhase) : null);

  const rawPercent = payload?.percent;
  const percent =
    typeof rawPercent === "number" && isFinite(rawPercent)
      ? Math.min(100, Math.max(0, rawPercent))
      : null;

  return { message, percent };
}

// Suscribe el listener ANTES de invocar la operación para no perder el primer evento.
// Si listen() lanza, la operación sigue con feedback indeterminado.
// Desuscribe en finally tanto en éxito como en excepción.
export async function withDependencyProgress(name, listen, operation, reporter) {
  const eventName = DEPENDENCY_EVENTS[name];
  let unlisten = null;

  if (eventName) {
    try {
      unlisten = await listen(eventName, ({ payload }) => {
        reporter(normalizeProgressPayload(payload));
      });
    } catch {
      // Sigue con feedback indeterminado si el registro del listener falla
    }
  }

  try {
    return await operation();
  } finally {
    unlisten?.();
  }
}
