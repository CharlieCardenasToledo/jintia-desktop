/**
 * index.js — Punto de entrada del módulo onboarding/.
 *
 * Re-exporta las funciones públicas que hoy exporta src/onboarding.js,
 * de modo que cualquier código que importe de "./onboarding/" o de
 * "./onboarding/index.js" recibe exactamente los mismos símbolos.
 */

export { mountGeminiLoading } from "./ui.js";
export { renderOnboarding } from "./controller.js";
