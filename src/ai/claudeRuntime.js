/**
 * claudeRuntime.js — Plumbing de eventos Tauri para el proveedor "Claude Code"
 * de Ask Jintia.
 *
 * Mantiene fuera de jintia-chat.js el conocimiento de los nombres de evento
 * Tauri (`claude:session/started`, `claude:message/delta`, ...) que emite
 * `ClaudeManager` (src-tauri/src/claude/mod.rs), reflejando el enum
 * `ClaudeEvent` de src-tauri/src/claude/models.rs. jintia-chat.js solo ve
 * callbacks con el payload ya resuelto: `{ requestId, sessionId, ... }`.
 *
 * No guarda ningún estado de conversación (sessionId, requestId activo):
 * eso sigue viviendo en jintia-chat.js, igual que `_codexThreadId`/`_codexTurnId`
 * para el proveedor Codex.
 */
import { listen } from "@tauri-apps/api/event";

// Claude Code soporta los alias "sonnet"/"opus" para el modelo más reciente
// de cada familia; no se hardcodean IDs de versión concretos (p. ej.
// "claude-sonnet-4-5") porque esos cambian con cada release del CLI.
export const CLAUDE_MODELS = [
  { id: "", name: "Automático" },
  { id: "sonnet", name: "Claude Sonnet" },
  { id: "opus", name: "Claude Opus" },
];

/**
 * Registra los 5 eventos `claude:*` que emite ClaudeManager durante un turno.
 * Devuelve una función `detach()` que cancela los 5 listeners a la vez.
 *
 * @param {object} handlers
 * @param {(payload: {requestId: string, sessionId: string, model?: string}) => void} [handlers.onSessionStarted]
 * @param {(payload: {requestId: string, sessionId?: string, text: string}) => void} [handlers.onDelta]
 * @param {(payload: {requestId: string, sessionId?: string}) => void} [handlers.onRetry]
 * @param {(payload: {requestId: string, sessionId?: string, success: boolean, result?: string}) => void} [handlers.onCompleted]
 * @param {(payload: {requestId: string, sessionId?: string, message: string}) => void} [handlers.onError]
 * @returns {Promise<() => void>} detach
 */
export async function registerClaudeListeners({
  onSessionStarted = () => {},
  onDelta = () => {},
  onRetry = () => {},
  onCompleted = () => {},
  onError = () => {},
} = {}) {
  const unlistenFns = await Promise.all([
    listen("claude:session/started", (event) => onSessionStarted(event.payload)),
    listen("claude:message/delta", (event) => onDelta(event.payload)),
    listen("claude:system/api_retry", (event) => onRetry(event.payload)),
    listen("claude:turn/completed", (event) => onCompleted(event.payload)),
    listen("claude:error", (event) => onError(event.payload)),
  ]);
  return () => unlistenFns.forEach((unlisten) => unlisten());
}
