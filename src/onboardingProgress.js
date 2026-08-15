// Mapea nombres canónicos de dependencia al evento Tauri que el backend emite.
export const DEPENDENCY_EVENTS = {
  "Node.js": "node-download-progress",
  "Python": "python-download-progress",
  "Jintia Skill": "skill-download-progress",
};
export const GENERIC_DEPENDENCY_EVENT = "dependency-install-progress";

const PHASE_LABELS = {
  resolving: "Comprobando requisitos…",
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

// Aplica el modo visual y accesible correcto sobre los tres elementos del componente.
// Modo determinado (percent !== null, incluido 0):
//   barWrap visible con role="progressbar" y aria-value*; track oculto sin aria-value*.
// Modo indeterminado (percent === null):
//   barWrap oculto sin rol ni aria-value*; track visible con role="status".
export function applyDependencyProgressPresentation({ track, barWrap, barFill, message, percent }) {
  if (percent !== null) {
    barFill.style.width = `${percent}%`;
    barWrap.style.display = "";
    barWrap.setAttribute("role", "progressbar");
    barWrap.setAttribute("aria-valuemin", "0");
    barWrap.setAttribute("aria-valuemax", "100");
    barWrap.setAttribute("aria-valuenow", String(percent));
    if (message !== null) barWrap.setAttribute("aria-label", message);
    track.style.display = "none";
    track.removeAttribute("aria-valuenow");
    track.removeAttribute("aria-valuemin");
    track.removeAttribute("aria-valuemax");
  } else {
    barWrap.style.display = "none";
    barFill.style.width = "0%";
    barWrap.removeAttribute("role");
    barWrap.removeAttribute("aria-valuenow");
    barWrap.removeAttribute("aria-valuemin");
    barWrap.removeAttribute("aria-valuemax");
    track.style.display = "";
    track.setAttribute("role", "status");
    track.removeAttribute("aria-valuenow");
    track.removeAttribute("aria-valuemin");
    track.removeAttribute("aria-valuemax");
    if (message !== null) track.setAttribute("aria-label", message);
  }
}

// Suscribe el listener ANTES de invocar la operación para no perder el primer evento.
// Si listen() lanza, la operación sigue con feedback indeterminado.
// Desuscribe en finally tanto en éxito como en excepción.
export async function withDependencyProgress(name, listen, operation, reporter, eventNameOverride = null) {
  const eventName = eventNameOverride ?? DEPENDENCY_EVENTS[name] ?? GENERIC_DEPENDENCY_EVENT;
  const usesGenericEvent = eventName === GENERIC_DEPENDENCY_EVENT;
  let unlisten = null;

  try {
    unlisten = await listen(eventName, ({ payload }) => {
      if (usesGenericEvent && payload?.name !== name) return;
      reporter(normalizeProgressPayload(payload));
    });
  } catch {
    // Sigue con feedback indeterminado si el registro del listener falla
  }

  try {
    return await operation();
  } finally {
    unlisten?.();
  }
}
