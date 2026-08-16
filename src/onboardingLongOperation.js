export const OPERATION_STATES = [
  "idle", "checking", "needsAction", "working", "success", "warning", "error", "cancelled",
];

export function createOperationState(overrides = {}) {
  return {
    id: null,
    state: "idle",
    phase: "",
    title: "",
    message: "",
    percent: null,
    cancellable: false,
    browserOpen: false,
    startedAt: null,
    technicalDetail: "",
    ...overrides,
  };
}

export function reduceOperationEvent(previous, payload = {}) {
  const state = OPERATION_STATES.includes(payload.state) ? payload.state : previous.state;
  return {
    ...previous,
    id: payload.operationId || previous.id,
    state,
    phase: payload.phase || previous.phase,
    message: payload.message || previous.message,
    percent: Number.isFinite(payload.percent) ? Math.max(0, Math.min(100, payload.percent)) : null,
    cancellable: payload.cancellable === true,
    browserOpen: payload.browserOpen === true,
  };
}

export function elapsedLabel(startedAt, now = Date.now()) {
  if (!startedAt || now - startedAt < 10_000) return "";
  const seconds = Math.floor((now - startedAt) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
