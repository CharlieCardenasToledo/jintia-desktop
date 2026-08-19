/**
 * codexUsage.js — Formateo de cuota y tiempo de reinicio de Codex.
 *
 * El cálculo de "cuánto falta" está portado del algoritmo de CodexBar
 * (github.com/steipete/CodexBar, MIT — Sources/CodexBarCore/UsageFormatter.swift
 * `resetCountdownDescription`), traducido a español. La fuente de datos es
 * distinta: en vez de la API HTTP `wham/usage` que usa CodexBar, aquí se lee
 * directo del RPC `account/rateLimits/read` del propio Codex app-server
 * (mismo canal JSON-RPC que ya usa Jintia), confirmado contra una cuenta real:
 *   { rateLimits: { primary: { usedPercent, windowDurationMins, resetsAt }, ... } }
 */

/** Redondea el porcentaje de uso al estilo CodexBar: "<1%" en vez de "0%" cuando hay algo de uso mínimo. */
export function formatUsagePercent(percent) {
  const clamped = Math.min(100, Math.max(0, percent));
  if (clamped > 0 && clamped < 1) return "<1%";
  return `${Math.round(clamped)}%`;
}

/**
 * Cuenta regresiva legible hasta `resetsAtSeconds` (timestamp Unix en segundos,
 * tal como lo devuelve Codex). Puerto directo de resetCountdownDescription.
 */
export function formatResetCountdown(resetsAtSeconds, now = Date.now()) {
  if (!resetsAtSeconds) return null;
  const seconds = Math.max(0, resetsAtSeconds * 1000 - now) / 1000;
  if (seconds < 1) return "ahora";

  const totalMinutes = Math.max(1, Math.ceil(seconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) {
    if (hours > 0) return `en ${days}d ${hours}h`;
    if (minutes > 0) return `en ${days}d ${minutes}m`;
    return `en ${days}d`;
  }
  if (hours > 0) {
    if (minutes > 0) return `en ${hours}h ${minutes}m`;
    return `en ${hours}h`;
  }
  return `en ${totalMinutes}m`;
}

/**
 * Ventana principal de cuota, normalizada desde la respuesta cruda de
 * account/rateLimits/read (o de la notificación account/rateLimits/updated,
 * que tiene la misma forma bajo `rateLimits`).
 */
export function primaryWindow(rateLimitsResult) {
  return rateLimitsResult?.rateLimits?.primary || null;
}

/** true cuando la cuota de la cuenta ya no permite nuevos turnos. */
export function isRateLimited(rateLimitsResult) {
  const rl = rateLimitsResult?.rateLimits;
  if (!rl) return false;
  if (rl.rateLimitReachedType) return true;
  const window = rl.primary;
  return typeof window?.usedPercent === "number" && window.usedPercent >= 100;
}

/** Resumen corto para mostrar en un badge: "45% usado" o "Sin cupo · en 3h 20m". */
export function usageSummary(rateLimitsResult, now = Date.now()) {
  const rl = rateLimitsResult?.rateLimits;
  const window = rl?.primary;
  if (!window || typeof window.usedPercent !== "number") return null;
  const limited = isRateLimited(rateLimitsResult);
  const countdown = formatResetCountdown(window.resetsAt, now);
  if (limited) {
    return countdown ? `Sin cupo · disponible ${countdown}` : "Sin cupo de Codex";
  }
  const percent = formatUsagePercent(window.usedPercent);
  return countdown ? `${percent} usado · reinicia ${countdown}` : `${percent} usado`;
}
