/**
 * confirmDialog.js — Diálogo de confirmación en marca (Single Responsibility Principle)
 * Sustituye a window.confirm() nativo, que rompe la estética Liquid Glass de la
 * app y no puede recibir estilos. Reutiliza las mismas clases de ui.modal que
 * el resto de los modales (courses.js) para que se vea como parte del mismo sistema.
 */
import { ui, cx } from "./uiClasses.js";
import { ic, refreshIcons } from "./icons.js";
import { escapeHtml } from "./dom.js";

let _active = null; // { overlay, resolve, opener }

function closeActive(result) {
  if (!_active) return;
  const { overlay, resolve, opener } = _active;
  _active = null;
  document.removeEventListener("keydown", onKeydown, true);
  overlay.remove();
  opener?.focus?.();
  resolve(result);
}

function onKeydown(e) {
  if (!_active) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeActive(false);
    return;
  }
  if (e.key === "Tab") {
    // Focus trap simple: dos botones, Tab/Shift+Tab alterna entre ambos.
    const focusables = [..._active.overlay.querySelectorAll("button")];
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

/**
 * Muestra un diálogo de confirmación modal y devuelve una Promise<boolean>.
 * danger:true resalta la acción en rojo y enfoca "Cancelar" por defecto (evita
 * que un Enter accidental dispare una acción destructiva — igual que el
 * patrón ya usado en courses.js para eliminar un curso).
 */
export function confirmDialog({
  title = "Confirmar",
  message = "",
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  danger = false,
} = {}) {
  return new Promise(resolve => {
    // Si ya hay un diálogo abierto, se cancela para no apilar overlays.
    if (_active) closeActive(false);

    const opener = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[5300] flex items-center justify-center bg-slate-900/45 p-4";
    overlay.innerHTML = `
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message"
           class="w-full max-w-[400px] rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
        <div class="mb-3 flex items-start gap-3">
          <div class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${danger ? "bg-red-50 text-red-500" : "bg-brand-50 text-brand-600"}">
            ${ic(danger ? "trash-2" : "triangle-alert", 17)}
          </div>
          <div class="min-w-0">
            <h2 id="confirm-dialog-title" class="text-base font-bold text-app-text" style="font-family: var(--font-display, 'Syne', sans-serif);">${escapeHtml(title)}</h2>
            <p id="confirm-dialog-message" class="mt-1 whitespace-pre-line text-sm leading-relaxed text-app-muted">${escapeHtml(message)}</p>
          </div>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="${cx(ui.button.base, ui.button.ghost, "min-h-11")}" data-confirm-cancel>${escapeHtml(cancelLabel)}</button>
          <button type="button" class="${cx(ui.button.base, danger ? ui.button.danger : ui.button.primary, "min-h-11")}" data-confirm-ok>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    refreshIcons();

    overlay.addEventListener("mousedown", e => {
      if (e.target === overlay) closeActive(false);
    });
    overlay.querySelector("[data-confirm-cancel]").addEventListener("click", () => closeActive(false));
    overlay.querySelector("[data-confirm-ok]").addEventListener("click", () => closeActive(true));
    document.addEventListener("keydown", onKeydown, true);

    _active = { overlay, resolve, opener };

    // Foco inicial: en acciones destructivas, "Cancelar" evita un Enter accidental.
    const initialFocus = overlay.querySelector(danger ? "[data-confirm-cancel]" : "[data-confirm-ok]");
    requestAnimationFrame(() => initialFocus?.focus());
  });
}
