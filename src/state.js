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
