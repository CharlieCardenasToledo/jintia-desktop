/**
 * toast.js — Sistema de notificaciones (Single Responsibility Principle)
 * Feedback inmediato para cada acción del usuario (Norman: Principio de Feedback).
 */
import { refreshIcons } from "./icons.js";
import { jintiaLoaderPlaceholder, mountAllJintiaLoaders } from "./components/JintiaLoader.js";

let timer;

const TYPE_ICON = {
  success: "check-circle-2",
  error:   "x-circle",
  info:    "info",
};

export function toast(msg, type = "info", ms = 3800) {
  const el = document.getElementById("toast");
  if (!el) return;

  el.replaceChildren();
  if (type === "loading") {
    // El toast de "loading" se inserta una sola vez y no desaparece por
    // timeout (se reemplaza por el toast terminal siguiente), así que es
    // seguro montar el loader oficial aquí en vez del ícono Lucide estático.
    const icon = document.createElement("span");
    icon.innerHTML = jintiaLoaderPlaceholder(15);
    const text = document.createElement("span");
    text.textContent = String(msg ?? "");
    el.append(icon, text);
    el.className = `show ${type}`;
    clearTimeout(timer);
    mountAllJintiaLoaders(el);
    return;
  }

  const iconName = TYPE_ICON[type] || "info";
  const icon = document.createElement("i");
  icon.dataset.lucide = iconName;
  icon.setAttribute("width", "15");
  icon.setAttribute("height", "15");
  const text = document.createElement("span");
  text.textContent = String(msg ?? "");
  el.append(icon, text);
  el.className = `show ${type}`;

  clearTimeout(timer);
  timer = setTimeout(() => { el.className = ""; }, ms);

  refreshIcons();
}
