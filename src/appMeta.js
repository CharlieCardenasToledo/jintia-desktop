import brand from "./brand.json";

/**
 * Fuente canónica de identidad y enlaces públicos de Jintia.
 * La versión de la aplicación se obtiene en ejecución desde Tauri.
 */
export const APP_META = Object.freeze({
  brandName: "Jintia",
  desktopName: "Jintia Desktop",
  skillName: "Jintia Skill",
  // La versión efectiva de la skill pertenece al paquete Jintia administrado
  // y se descubre en runtime; no se replica en Desktop.
  skillVersion: "administrada",
  creator: "Charlie Cárdenas Toledo",
  creatorUrl: "https://github.com/CharlieCardenasToledo",
  tagline: "Diseña el camino del aprendizaje.",
  originName: brand.linguisticForm,
  originLanguage: brand.language,
  originMeaning: brand.meaning,
  originAttribution: brand.originSummary,
  originDisclaimer: brand.disclaimer,
  copyright: "© 2026 Charlie Cárdenas Toledo",
  license: "MIT",
  repository: "https://github.com/CharlieCardenasToledo/jintia-desktop",
  issues: "https://github.com/CharlieCardenasToledo/jintia-desktop/issues",
  licenseUrl: "https://github.com/CharlieCardenasToledo/jintia-desktop/blob/main/LICENSE",
  privacyUrl: "https://github.com/CharlieCardenasToledo/jintia-desktop/blob/main/PRIVACY.md",
  // notebooklm.google.com sigue resolviendo (Google renombró NotebookLM a
  // "Gemini Notebook" en 2026-07 y movió el dominio canónico), pero este es
  // el que se ofrece al usuario para no mandarlo a un alias.
  notebookLmUrl: "https://notebook.google.com/",
});

export const ALLOWED_EXTERNAL_URLS = Object.freeze([
  APP_META.creatorUrl,
  APP_META.repository,
  APP_META.issues,
  APP_META.licenseUrl,
  APP_META.privacyUrl,
  APP_META.notebookLmUrl,
]);

// AI launch targets are intentionally scheme constrained. Course paths are
// encoded into each assistant's deep link — Claude Code's claude://code/new
// and the ChatGPT desktop app's codex://threads/new
// (https://learn.chatgpt.com/docs/reference/commands) — but arbitrary
// external URLs must never be accepted by the opener abstraction.
export const ALLOWED_AI_URLS = Object.freeze({
  schemes: Object.freeze(["claude:", "codex:"]),
});
