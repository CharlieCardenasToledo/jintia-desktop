/**
 * state.js — Estado global centralizado (Single Responsibility Principle)
 * Única fuente de verdad de la app. Persiste en localStorage donde corresponde.
 */

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; }
  catch { return fallback; }
}

const askJintiaMock = import.meta.env?.MODE === "mock" &&
  new URLSearchParams(globalThis.location?.search || "").get("ask-jintia") === "1";

const ASK_JINTIA_DEMO_COURSES = [{
  code: "IFT200",
  name: "Interacción Persona Computador",
  weeks: 16,
  project_path: "C:\\Mock\\Jintia\\ift200_interaccion_persona_computador",
  notebook_id: "ift200-fuentes",
  notebook_name: "IFT200 — Fuentes verificadas del curso",
  notebook_url: "https://notebook.google.com/notebook/ift200-fuentes",
}];

export const state = {
  page:          askJintiaMock ? "jintia-chat" : "courses",
  deps:          [],
  config:        load("ids_config",  {}),
  courses:       askJintiaMock ? ASK_JINTIA_DEMO_COURSES : load("ids_courses", []),
  editingCourse: undefined,
};

export function saveConfig()  { localStorage.setItem("ids_config",  JSON.stringify(state.config)); }
export function saveCourses() { localStorage.setItem("ids_courses", JSON.stringify(state.courses)); }

/**
 * Si la carpeta elegida por el usuario no es ya una carpeta "Jintia", le
 * añade una subcarpeta "Jintia" — para que el comportamiento sea el mismo
 * que el valor por defecto (Documentos/Jintia) sin importar qué carpeta raíz
 * elija el usuario, tanto en el onboarding como en Ajustes.
 */
export function ensureJintiaSubfolder(path) {
  if (!path) return path;
  const trimmed = path.replace(/[\\/]+$/, "");
  const separator = trimmed.includes("\\") ? "\\" : "/";
  const base = trimmed.split(/[\\/]/).pop() || "";
  if (base.toLowerCase() === "jintia") return trimmed;
  return `${trimmed}${separator}Jintia`;
}
