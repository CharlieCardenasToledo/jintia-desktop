/**
 * tauri-event.mock.js — Reemplazo de "@tauri-apps/api/event" para el modo
 * mock (navegador, sin Tauri real).
 *
 * Antes, `listen()` devolvía un no-op que nunca llamaba al callback: cualquier
 * proveedor que dependa de eventos Tauri (Claude Code) se quedaría "pensando"
 * para siempre en modo mock. Ahora es un mini event bus real: tauri-core.mock.js
 * usa `emitMockEvent()` para simular el streaming de un turno.
 */
const listeners = new Map(); // eventName -> Set<callback>

export async function listen(eventName, callback) {
  if (!listeners.has(eventName)) listeners.set(eventName, new Set());
  listeners.get(eventName).add(callback);
  return () => {
    listeners.get(eventName)?.delete(callback);
  };
}

/** Usado solo por tauri-core.mock.js para simular eventos del backend. */
export function emitMockEvent(eventName, payload) {
  const callbacks = listeners.get(eventName);
  if (!callbacks || !callbacks.size) return;
  for (const callback of [...callbacks]) {
    callback({ event: eventName, payload });
  }
}
