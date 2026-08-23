import {
  applyInstitutionConfig, checkDependencies, getVisualInstallProfiles, installDependency,
  downloadNodeRuntime, downloadPythonRuntime, downloadSkillRuntime, checkSkillUpdateStatus, installVivliostyleCli,
  configureMcp, configureCodexMcp, getSetupStatus, checkNotebookLMAuth, runNotebookLMAuth,
  installSkill, installOpenAIPlugin,
  resetOnboarding, getSkillPath, extractSitePalette, runSkillTool, detectHarnesses, manageHarnesses,
  getAiPreference,
  codexStatus, codexStart, codexStop, codexStartLogin, codexReadRateLimits,
  claudeStatus,
  claudeAuthLogin,
} from "../api.js";
import { state, saveConfig, ensureJintiaSubfolder } from "../state.js";
import { navigate } from "../router.js";
import { escapeHtml } from "../dom.js";
import { isRateLimited, formatUsagePercent, formatResetCountdown, primaryWindow } from "../codexUsage.js";
import { toast } from "../toast.js";
import { ic, refreshIcons } from "../icons.js";
import { confirm } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { ui, cx, liquidForBackground } from "../uiClasses.js";
import { withDependencyProgress } from "../onboardingProgress.js";
import { jintiaLoaderPlaceholder, mountAllJintiaLoaders } from "../components/JintiaLoader.js";

// "Instalar herramientas necesarias" solo cubre los runtimes portables necesarios
// para ejecutar la Skill; Git queda fuera aunque aparezca en la lista de abajo.
const BULK_INSTALL_TARGETS = new Set(["Node.js", "Python", "Jintia Skill", "Vivliostyle CLI"]);
const NODE_DEPENDENT_BULK_TARGETS = new Set(["Jintia Skill", "Vivliostyle CLI"]);
let _settingsSection = "inst-profile";
const _busySettingsOps = new Set();

function sectionHidden(id) {
  return _settingsSection === id ? "" : " hidden";
}

async function runSettingsOperation(button, key, busyLabel, operation) {
  if (_busySettingsOps.has(key)) return;
  _busySettingsOps.add(key);
  const original = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML = `${jintiaLoaderPlaceholder(17)}${escapeHtml(busyLabel)}`;
    mountAllJintiaLoaders(button);
  }
  try {
    return await operation();
  } finally {
    _busySettingsOps.delete(key);
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.innerHTML = original;
    }
  }
}

function settingsDependencyReporter(container, name) {
  const row = [...container.querySelectorAll("[data-settings-dependency]")]
    .find(candidate => candidate.dataset.settingsDependency === name);
  const detail = row?.querySelector("[data-dependency-detail]");
  const progress = row?.querySelector("[data-dependency-progress]");
  const fill = row?.querySelector("[data-dependency-progress-fill]");
  const value = row?.querySelector("[data-dependency-progress-value]");

  return ({ message, percent, state = "running" }) => {
    if (!row || !detail || !progress || !fill || !value) return;
    const isRunning = state === "running";
    row.setAttribute("aria-busy", String(isRunning));
    row.dataset.progressState = state;
    row.classList.toggle("ring-1", isRunning);
    row.classList.toggle("ring-path-400/40", isRunning);
    progress.classList.remove("hidden");
    if (message) detail.textContent = message;

    fill.classList.remove("bg-path-500", "bg-green-500", "bg-red-500");
    fill.classList.add(state === "success" ? "bg-green-500" : state === "error" ? "bg-red-500" : "bg-path-500");

    if (!isRunning) {
      progress.setAttribute("role", "status");
      progress.removeAttribute("aria-valuemin");
      progress.removeAttribute("aria-valuemax");
      progress.removeAttribute("aria-valuenow");
      fill.classList.remove("animate-pulse");
      fill.style.width = "100%";
      value.textContent = state === "success" ? "Listo" : "Error";
      progress.setAttribute("aria-label", message || value.textContent);
      return;
    }

    if (percent === null) {
      progress.setAttribute("role", "status");
      progress.removeAttribute("aria-valuemin");
      progress.removeAttribute("aria-valuemax");
      progress.removeAttribute("aria-valuenow");
      fill.style.width = "35%";
      fill.classList.add("animate-pulse");
      value.textContent = "En curso";
    } else {
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", "100");
      progress.setAttribute("aria-valuenow", String(percent));
      fill.classList.remove("animate-pulse");
      fill.style.width = `${percent}%`;
      value.textContent = `${Math.round(percent)}%`;
    }
    progress.setAttribute("aria-label", message || `Procesando ${name}`);
  };
}

async function runDependencyWithSettingsProgress(container, name, operation) {
  const reporter = settingsDependencyReporter(container, name);
  const row = [...container.querySelectorAll("[data-settings-dependency]")]
    .find(candidate => candidate.dataset.settingsDependency === name);
  const controls = [...(row?.querySelectorAll("button") ?? [])];
  const previousDisabled = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  reporter({ message: `Preparando ${name}…`, percent: null, state: "running" });
  try {
    const result = await withDependencyProgress(name, listen, operation, reporter);
    reporter({
      message: result?.message || (result?.success ? `${name} quedó listo.` : `No se pudo instalar ${name}.`),
      percent: result?.success ? 100 : null,
      state: result?.success ? "success" : "error",
    });
    return result;
  } catch (error) {
    reporter({ message: `No se pudo completar: ${String(error)}`, percent: null, state: "error" });
    throw error;
  } finally {
    controls.forEach((control, index) => { control.disabled = previousDisabled[index]; });
  }
}

// Convierte ecosystem a string independientemente de si es array o string
function ecosystemToStr(val) {
  if (Array.isArray(val)) return val.join("\n");
  if (typeof val === "string") return val;
  return "";
}

export async function renderSettings() {
  const el = document.getElementById("p-settings");
  if (!el) return;

  el.innerHTML = `
    <div class="flex min-w-0 flex-col gap-4 [&_button]:min-h-11">

      <!-- Left nav -->
      <div class="rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
        <nav class="grid grid-cols-2 gap-2 p-1 sm:grid-cols-3 xl:grid-cols-5" aria-label="Secciones de configuración">
          <a class="${cx(ui.settingsNav.item, _settingsSection === "inst-profile" && ui.settingsNav.active)}" data-settings-nav data-section="inst-profile" href="#inst-profile" ${_settingsSection === "inst-profile" ? 'aria-current="page"' : ""}>
            ${ic("building-2", 18)} Perfil institucional
          </a>
          <a class="${cx(ui.settingsNav.item, _settingsSection === "mcp-config" && ui.settingsNav.active)}" data-settings-nav data-section="mcp-config" href="#mcp-config" ${_settingsSection === "mcp-config" ? 'aria-current="page"' : ""}>
            ${ic("share-2", 18)} Conexiones
          </a>
          <a class="${cx(ui.settingsNav.item, _settingsSection === "notebooks-section" && ui.settingsNav.active)}" data-settings-nav data-section="notebooks-section" href="#notebooks-section" ${_settingsSection === "notebooks-section" ? 'aria-current="page"' : ""}>
            ${ic("book-open", 18)} Notebooks
          </a>
          <a class="${cx(ui.settingsNav.item, _settingsSection === "environment" && ui.settingsNav.active)}" data-settings-nav data-section="environment" href="#environment" ${_settingsSection === "environment" ? 'aria-current="page"' : ""}>
            ${ic("terminal", 18)} Entorno
          </a>
          <a class="${cx(ui.settingsNav.item, _settingsSection === "app-prefs" && ui.settingsNav.active)}" data-settings-nav data-section="app-prefs" href="#app-prefs" ${_settingsSection === "app-prefs" ? 'aria-current="page"' : ""}>
            ${ic("sliders-horizontal", 18)} Preferencias
          </a>
        </nav>
      </div>

      <!-- Right panes -->
      <div class="min-w-0">


        <!-- ── Institutional Profile ── -->
        <section class="${cx(ui.surface.card, 'p-4 sm:p-5', sectionHidden("inst-profile"))}" id="inst-profile" data-settings-panel>
          <div class="mb-4 flex items-center gap-2.5 border-b border-slate-300/40 pb-3.5 text-[15px] font-bold text-app-text">
            <span class="text-teal-600">${ic("building-2", 20)}</span> Perfil institucional
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 mb-4">
            <div class="flex flex-col gap-1.5 sm:col-span-2">
              <label for="cfg-author">Nombre completo *</label>
              <input id="cfg-author" placeholder="Ej: Charlie Cárdenas Toledo" autocomplete="name" required aria-describedby="cfg-author-error"
                value="${escapeHtml(state.config?.author || "")}">
              <p id="cfg-author-error" class="hidden text-xs font-semibold text-red-700"></p>
            </div>
            <div class="flex flex-col gap-1.5">
              <label for="cfg-degree">Grado académico</label>
              <select id="cfg-degree">
                ${["","Lic.","Ing.","Arq.","Mg.","M.Sc.","MBA","Esp.","Ph.D.","Dr.","Prof."]
                  .map(v => `<option value="${v}"${state.config?.degree === v ? " selected" : ""}>${v || "Seleccionar grado…"}</option>`)
                  .join("")}
              </select>
            </div>
            <div class="flex flex-col gap-1.5">
              <label for="cfg-institution">Institución *</label>
              <input id="cfg-institution" placeholder="Ej: Universidad Internacional del Ecuador" required aria-describedby="cfg-institution-error"
                value="${escapeHtml(state.config?.institution || "")}">
              <p id="cfg-institution-error" class="hidden text-xs font-semibold text-red-700"></p>
            </div>
            <div class="flex flex-col gap-1.5">
              <label for="cfg-faculty">Facultad</label>
              <input id="cfg-faculty" placeholder="Ej: Facultad de Ingeniería"
                value="${escapeHtml(state.config?.faculty || "")}">
            </div>
            <div class="flex flex-col gap-1.5">
              <label for="cfg-career">Carrera</label>
              <input id="cfg-career" placeholder="Ej: Ingeniería en Sistemas"
                value="${escapeHtml(state.config?.career || "")}">
            </div>
            <div class="flex flex-col gap-1.5">
              <label for="cfg-color">Color institucional</label>
              <div class="mt-0.5 flex items-center gap-2.5">
                <input id="cfg-color" type="color" value="${escapeHtml(state.config?.color || "#00317e")}">
                <span class="inline-block h-5 w-5 shrink-0 rounded border border-black/20" id="cfg-color-preview" style="background:${escapeHtml(state.config?.color || "#00317e")}" aria-hidden="true"></span>
                <span class="font-mono text-[13px] font-semibold text-teal-700" id="cfg-color-label">${escapeHtml(state.config?.color || "#00317e")}</span>
              </div>
            </div>
            <div class="flex flex-col gap-1.5 sm:col-span-2">
              <label for="cfg-website">Sitio web institucional</label>
              <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <input id="cfg-website" type="url" placeholder="https://www.uide.edu.ec/"
                  value="${escapeHtml(state.config?.website || "")}">
                <button class="${cx(ui.button.base, ui.button.secondary)}" id="btn-extract-palette" type="button">
                  ${ic("palette", 15)}
                  Extraer paleta
                </button>
              </div>
              <div class="mt-1.5 text-[11.5px] text-app-muted">
                Analiza el HTML y las hojas de estilo públicas del sitio.
              </div>
            </div>
            <div id="institution-palette" class="hidden rounded-[10px] border border-slate-300/55 bg-white p-3 sm:col-span-2" aria-live="polite"></div>
          </div>
          <div class="flex flex-col gap-1.5 mb-4">
            <label for="cfg-discipline">Área del conocimiento</label>
            <select id="cfg-discipline">
              <option value="">— Selecciona tu área —</option>
              <option value="software-engineering" ${state.config?.discipline === "software-engineering" ? "selected" : ""}>Informática / Ingeniería de software</option>
              <option value="math-statistics" ${state.config?.discipline === "math-statistics" ? "selected" : ""}>Matemáticas / Estadística</option>
              <option value="electronics" ${state.config?.discipline === "electronics" ? "selected" : ""}>Electrónica / Telecomunicaciones</option>
              <option value="natural-sciences" ${state.config?.discipline === "natural-sciences" ? "selected" : ""}>Ciencias naturales</option>
              <option value="social-sciences" ${state.config?.discipline === "social-sciences" ? "selected" : ""}>Ciencias sociales / Humanidades</option>
              <option value="health" ${state.config?.discipline === "health" ? "selected" : ""}>Salud</option>
              <option value="business" ${state.config?.discipline === "business" ? "selected" : ""}>Administración / Economía</option>
              <option value="design" ${state.config?.discipline === "design" ? "selected" : ""}>Diseño / Arquitectura</option>
              <option value="general" ${state.config?.discipline === "general" ? "selected" : ""}>General / Multidisciplinar</option>
            </select>
          </div>
          <div class="flex flex-col gap-1.5 mb-4">
            <label for="cfg-ecosystem">Ecosistema digital <span class="text-app-muted">(uno por línea)</span></label>
            <textarea id="cfg-ecosystem" placeholder="Canvas LMS&#10;Sistema académico">${escapeHtml(ecosystemToStr(state.config?.ecosystem))}</textarea>
          </div>
          <div class="flex items-center justify-end gap-2">
            <button class="${cx(ui.button.base, ui.button.primary)}" id="btn-save-institution">
              ${ic("save", 15)} Guardar perfil
            </button>
          </div>
            <div id="institution-inline-error" class="mt-2.5 rounded-[7px] border border-red-700/25 bg-red-700/[0.06] px-3 py-2 text-xs text-red-700" role="alert" hidden></div>
        </section>

        <!-- ── Conexiones ── -->
        <section class="${cx(ui.surface.card, 'p-4 sm:p-5', sectionHidden("mcp-config"))}" id="mcp-config" data-settings-panel>
          <div class="mb-4 flex items-center gap-2.5 border-b border-slate-300/40 pb-3.5 text-[15px] font-bold text-app-text">
            <span class="text-teal-600">${ic("share-2", 20)}</span> Conexiones
            <span id="mcp-status-badge" class="ml-auto inline-flex items-center gap-1.5 rounded-full border border-slate-300/50 bg-slate-200/20 px-2.5 py-0.5 text-[11px] font-bold text-app-muted" role="status" aria-live="polite">
              <span class="inline-block h-1.5 w-1.5 rounded-full bg-current"></span> Verificando…
            </span>
          </div>
            <div class="flex flex-col gap-3.5">

            <!-- Target buttons -->
            <div>
              <div class="mb-2 text-[11.5px] font-semibold text-app-muted">Conectar con:</div>
              <div class="flex flex-wrap gap-2">
                <button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)} mcp-target" data-target="claude-code">
                  ${ic("terminal", 14)} Proyecto local
                </button>
                <button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)} mcp-target" data-target="desktop">
                  ${ic("users", 14)} App de Claude
                </button>
                <button class="${cx(ui.button.base, ui.button.primary, ui.button.sm)} mcp-target" data-target="both">
                  ${ic("share-2", 14)} Ambos
                </button>
                <button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)} mcp-target" data-target="codex">
                  ${ic("code-2", 14)} Codex CLI
                </button>
              </div>
            </div>
            <div id="mcp-inline-error" class="mt-2.5 rounded-[7px] border border-red-700/25 bg-red-700/[0.06] px-3 py-2 text-xs text-red-700" role="alert" hidden></div>

            <div class="mb-3.5 flex items-start gap-2 rounded-app border border-teal-600/25 bg-teal-600/[0.08] px-3.5 py-2.5 text-xs leading-relaxed text-app-text-2">
              <span class="mt-px shrink-0">${ic("info", 15)}</span>
              <span>Combina la conexión de NotebookLM con tu configuración existente y guarda un respaldo automático.</span>
            </div>

            <!-- NotebookLM Auth row -->
            <div class="flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-slate-200 bg-white px-3.5 py-3">
              <div>
                <div class="text-[13px] font-semibold text-app-text">Sesión de Google</div>
                <div id="nlm-auth-status" class="mt-0.5 text-xs text-app-muted" role="status" aria-live="polite">Verificando…</div>
              </div>
              <div class="flex gap-2">
                <button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}" id="btn-verify-nlm">
                  ${ic("refresh-cw", 14)} Verificar
                </button>
                <button class="${cx(ui.button.base, ui.button.primary, ui.button.sm)}" id="btn-auth-nlm">
                  ${ic("key", 14)} Iniciar sesión
                </button>
              </div>
            </div>

            <!-- Codex / ChatGPT row -->
            <div class="flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-slate-200 bg-white px-3.5 py-3">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 text-[13px] font-semibold text-app-text">
                  ${ic("bot", 15)} ChatGPT (Codex app-server)
                </div>
                <div id="codex-status-label" class="mt-0.5 text-xs text-app-muted" role="status" aria-live="polite">Verificando…</div>
              </div>
              <div class="flex gap-2">
                <button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}" id="btn-codex-refresh">
                  ${ic("refresh-cw", 14)} Estado
                </button>
                <button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)} hidden" id="btn-codex-stop">
                  ${ic("square", 14)} Detener
                </button>
                <button class="${cx(ui.button.base, ui.button.primary, ui.button.sm)}" id="btn-codex-login">
                  ${ic("key", 14)} Conectar ChatGPT
                </button>
              </div>
            </div>

            <!-- Panel de monitoreo de cuota de Codex -->
            <div id="codex-usage-panel" hidden class="rounded-lg border border-slate-200 bg-white px-3.5 py-3">
              <div class="mb-2 flex items-center justify-between gap-2">
                <div class="flex items-center gap-2 text-[13px] font-semibold text-app-text">${ic("gauge", 15)} Cuota de Codex</div>
                <span id="codex-usage-plan" class="text-[11px] font-semibold uppercase tracking-wide text-slate-500"></span>
              </div>
              <div class="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div id="codex-usage-bar" class="h-full rounded-full bg-teal-600 transition-all" style="width:0%"></div>
              </div>
              <div class="mt-1.5 flex items-center justify-between text-xs text-app-muted">
                <span id="codex-usage-percent">—</span>
                <span id="codex-usage-reset">—</span>
              </div>
            </div>

            <!-- Claude Code row -->
            <div class="flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-slate-200 bg-white px-3.5 py-3">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 text-[13px] font-semibold text-app-text">
                  ${ic("terminal", 15)} Claude Code (tu suscripción, sin API key)
                </div>
                <div id="claude-status-label" class="mt-0.5 text-xs text-app-muted" role="status" aria-live="polite">Verificando…</div>
              </div>
              <div class="flex gap-2">
                <button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}" id="btn-claude-refresh">
                  ${ic("refresh-cw", 14)} Estado
                </button>
                <button class="${cx(ui.button.base, ui.button.primary, ui.button.sm)}" id="btn-claude-login">
                  ${ic("key", 14)} Conectar Claude
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- ── Notebooks (solo lectura) ── -->
        <section class="${cx(ui.surface.card, 'p-4 sm:p-5', sectionHidden("notebooks-section"))}" id="notebooks-section" data-settings-panel>
          <div class="mb-4 flex items-center gap-2.5 border-b border-slate-300/40 pb-3.5 text-[15px] font-bold text-app-text">
            <span class="text-teal-600">${ic("book-open", 20)}</span> Notebooks de NotebookLM
          </div>
          <p class="mb-3.5 text-xs leading-5 text-app-muted">
            El vínculo entre una asignatura y su notebook se gestiona desde <strong>Cursos</strong> (al crearla o desde su menú "···"). Aquí solo se muestra el estado general.
          </p>
          <div id="notebook-status-summary" class="mb-3"></div>
          <div id="notebook-list" class="mb-3.5 flex flex-col gap-1.5"></div>
          <button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}" id="btn-go-to-courses">
            Ir a Cursos ${ic("arrow-right", 14)}
          </button>
        </section>

        <!-- ── Environment ── -->
        <section class="${cx(ui.surface.card, 'p-4 sm:p-5', sectionHidden("environment"))}" id="environment" data-settings-panel>
          <div class="mb-4 flex items-center gap-2.5 border-b border-slate-300/40 pb-3.5 text-[15px] font-bold text-app-text">
            <span class="text-teal-600">${ic("terminal", 20)}</span> Entorno del sistema
            <button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm, 'ml-auto')}" id="btn-refresh-deps">
              ${ic("refresh-cw", 14)} Recargar
            </button>
          </div>

          <!-- Setup status summary -->
          <div id="setup-status-bar" class="mb-3" role="status" aria-live="polite"></div>

          <!-- Deps list -->
          <div id="deps-content" class="flex flex-col gap-2" aria-live="polite">
            <div class="p-6 text-center text-slate-400">Cargando…</div>
          </div>
          <div id="deps-inline-error" class="mt-2.5 rounded-[7px] border border-red-700/25 bg-red-700/[0.06] px-3 py-2 text-xs text-red-700" role="alert" hidden></div>

          <div class="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div class="flex flex-wrap items-center gap-3">
              <div>
                <h3 class="text-sm font-bold text-app-text">Diagnóstico de la toolchain</h3>
                <p class="mt-1 text-xs text-app-muted">Ejecuta el mismo comando jintia doctor que usa la skill y conserva su reporte.</p>
              </div>
              <button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm, 'ml-auto')}" id="btn-run-toolchain-doctor">
                ${ic("shield-check", 14)} Ejecutar diagnóstico
              </button>
            </div>
            <pre id="toolchain-report" class="mt-3 max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-5 text-slate-100" aria-live="polite">Aún no se ha ejecutado.</pre>
            <div class="mt-4 grid gap-3 md:grid-cols-[10rem_minmax(0,1fr)_auto]">
              <label class="text-xs font-semibold text-app-muted">Operación
                <select id="toolchain-operation" class="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-app-text">
                  <option value="audit">Auditar curso</option>
                  <option value="validate">Validar estructura</option>
                </select>
              </label>
              <label class="text-xs font-semibold text-app-muted">Archivo objetivo
                <input id="toolchain-target" class="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-app-text" placeholder="C:\\Cursos\\mi-curso\\README.md" autocomplete="off">
              </label>
              <label class="flex items-end gap-2 pb-2 text-xs font-semibold text-app-muted"><input id="toolchain-strict" type="checkbox" class="h-4 w-4 accent-teal-700"> Estricto</label>
            </div>
            <button class="${cx(ui.button.base, ui.button.primary, 'mt-3 min-h-11')}" id="btn-run-toolchain-operation">
              ${ic("play", 17)} Ejecutar operación
            </button>
          </div>

          <div class="mb-5 rounded-xl border border-slate-200 bg-white p-4">
            <div class="flex flex-wrap items-center gap-3">
              <div>
                <h3 class="text-sm font-bold text-app-text">Entornos de agentes detectados</h3>
                <p class="mt-1 text-xs text-app-muted">Busca carpetas de Claude, Codex, Cursor y otros harnesses en el proyecto y en tu perfil.</p>
              </div>
              <button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm, 'ml-auto')}" id="btn-detect-harnesses">
                ${ic("radar", 14)} Detectar
              </button>
            </div>
            <label class="mt-3 block text-xs font-semibold text-app-muted">Proyecto a inspeccionar
              <input id="harness-project-path" class="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-app-text" placeholder="Dejar vacío para el proyecto actual" autocomplete="off">
            </label>
            <div class="mt-3 grid gap-2 md:grid-cols-[150px_auto]">
              <select id="harness-scope" class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-app-text" aria-label="Alcance"><option value="project">Proyecto</option><option value="global">Global</option></select>
              <div class="flex gap-2"><button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}" data-harness-operation="install">Instalar</button><button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}" data-harness-operation="update">Actualizar</button><button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}" data-harness-operation="repair">Reparar</button></div>
            </div>
            <div id="harness-detection-list" class="mt-3 space-y-2" aria-live="polite">
              <div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">Aún no se ha ejecutado la detección.</div>
            </div>
          </div>
        </section>

        <!-- ── Preferencias ── -->
        <section class="${cx(ui.surface.card, 'p-4 sm:p-5', sectionHidden("app-prefs"))}" id="app-prefs" data-settings-panel>
          <div class="mb-4 flex items-center gap-2.5 border-b border-slate-300/40 pb-3.5 text-[15px] font-bold text-app-text">
            <span class="text-teal-600">${ic("sliders-horizontal", 20)}</span> Preferencias
          </div>

          <!-- Modelo de IA del chat -->
          <div class="mb-3.5 rounded-lg border border-slate-200 bg-white px-3.5 py-3">
            <div class="mb-1.5 text-[11.5px] font-bold uppercase tracking-wider text-app-muted">Modelo de IA del chat</div>
            <div id="ai-pref-val" class="text-[12.5px] text-brand">Cargando…</div>
            <div class="mt-1.5 text-[11px] text-app-muted">Se configura desde el selector de modelo en el chat de Jintia. El chat abrirá automáticamente con el modelo guardado.</div>
          </div>

          <!-- Workspace root -->
          <div class="mb-3.5 rounded-lg border border-slate-200 bg-white px-3.5 py-3">
            <div class="mb-1.5 text-[11.5px] font-bold uppercase tracking-wider text-app-muted">Carpeta de cursos</div>
            <div class="flex items-center justify-between gap-3">
              <div id="workspace-root-val" class="mono break-all text-[12.5px] text-brand flex-1">${escapeHtml(state.config?.courseWorkspaceRoot || "Documentos/Jintia (por defecto)")}</div>
              <button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}" id="btn-change-workspace-root" type="button">
                ${ic("folder-open", 14)} Cambiar
              </button>
            </div>
            <div class="mt-1.5 text-[11px] text-app-muted">Carpeta raíz donde se crean todas las asignaturas por defecto.</div>
          </div>

          <!-- Skill path -->
          <div class="mb-3.5 rounded-lg border border-slate-200 bg-white px-3.5 py-3">
            <div class="mb-1.5 text-[11.5px] font-bold uppercase tracking-wider text-app-muted">Carpeta de instalación</div>
            <div id="skill-path-val" class="mono break-all text-[12.5px] text-brand">Cargando…</div>
          </div>

          <div class="flex flex-col gap-2.5">
            <label class="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white px-3.5 py-3">
              <span>
                <span class="block text-[13px] font-semibold text-app-text">Incluir «Producido con Jintia» en los documentos</span>
                <span class="mt-0.5 block text-[11.5px] leading-5 text-app-muted">Añade un crédito discreto en el colofón o la última página. Nunca sustituye ni modifica la autoría académica.</span>
              </span>
              <input id="cfg-include-jintia-credit" class="mt-1 h-4 w-4 shrink-0 accent-teal-700" type="checkbox" ${state.config?.includeJintiaCredit !== false ? "checked" : ""}>
            </label>
            <div class="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3.5 py-3">
              <div>
                <div class="text-[13px] font-semibold text-app-text">Instalar para Claude Code</div>
                <div class="mt-0.5 text-[11.5px] text-app-muted">Copia la skill a <code>~/.claude/skills/</code></div>
              </div>
              <button class="${cx(ui.button.base, ui.button.primary, ui.button.sm)}" id="btn-install-skill">
                ${ic("download", 14)} Instalar
              </button>
            </div>
            <div class="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3.5 py-3">
              <div>
                <div class="text-[13px] font-semibold text-app-text">Preparar para ChatGPT y Codex</div>
                <div class="mt-0.5 text-[11.5px] text-app-muted">Registra el plugin universal en <code>~/.codex/plugins/</code></div>
              </div>
              <button class="${cx(ui.button.base, ui.button.primary, ui.button.sm)}" id="btn-install-openai-plugin">
                ${ic("puzzle", 14)} Preparar
              </button>
            </div>
            <div class="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3">
              <div class="mb-1.5 text-[13px] font-semibold text-app-text">Volver a mostrar el asistente inicial</div>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="max-w-[62ch] text-xs leading-5 text-app-muted">No elimina el perfil, las asignaturas, los notebooks ni los archivos generados. Solo vuelve a abrir el recorrido inicial.</div>
                <button class="${cx(ui.button.base, ui.button.secondary, 'min-h-11')}" id="btn-reset-onboarding">
                  ${ic("rotate-ccw", 17)} Mostrar asistente
                </button>
              </div>
            </div>
          </div>
        </section>

      </div>
    </div>`;

  // ── Bind section nav ──────────────────────────────────────────────────────
  el.querySelectorAll("[data-settings-nav]").forEach(a => {
    a.addEventListener("click", e => {
      e.preventDefault();
      _settingsSection = a.dataset.section;
      el.querySelectorAll("[data-settings-nav]").forEach(x => {
        x.className = ui.settingsNav.item;
        x.removeAttribute("aria-current");
      });
      a.className = cx(ui.settingsNav.item, ui.settingsNav.active);
      a.setAttribute("aria-current", "page");
      el.querySelectorAll("[data-settings-panel]").forEach(panel => {
        panel.classList.toggle("hidden", panel.id !== _settingsSection);
      });
      document.getElementById(_settingsSection)?.querySelector("input, select, textarea, button")?.focus();
    });
  });

  // ── Institution ───────────────────────────────────────────────────────────
  el.querySelector("#cfg-color")?.addEventListener("input", e => {
    document.getElementById("cfg-color-label").textContent = e.target.value;
    const preview = document.getElementById("cfg-color-preview");
    if (/^#[0-9a-fA-F]{6}$/.test(e.target.value) && preview) preview.style.background = e.target.value;
  });
  el.querySelector("#btn-save-institution")?.addEventListener("click", event => {
    runSettingsOperation(event.currentTarget, "institution", "Guardando…", saveInstitution);
  });
  el.querySelector("#btn-extract-palette")?.addEventListener("click", loadInstitutionPalette);

  // ── Conexiones ────────────────────────────────────────────────────────────
  el.querySelectorAll(".mcp-target").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (_busySettingsOps.has("mcp")) return;
      _busySettingsOps.add("mcp");
      const targets = [...el.querySelectorAll(".mcp-target")];
      targets.forEach(target => { target.disabled = true; target.setAttribute("aria-busy", "true"); });
      setInlineError("mcp-inline-error", "");
      toast("Conectando…", "loading", 8000);
      try {
        if (btn.dataset.target === "both") {
          const codeResult = await configureMcp("claude-code");
          const desktopResult = await configureMcp("desktop");
          const success = codeResult.success && desktopResult.success;
          if (!success) setInlineError("mcp-inline-error", `${codeResult.message} / ${desktopResult.message}`);
          toast(success ? "Conectado en proyecto local y app de Claude" : `${codeResult.message} / ${desktopResult.message}`, success ? "success" : "error", 6000);
        } else if (btn.dataset.target === "codex") {
          const result = await configureCodexMcp();
          if (!result.success) setInlineError("mcp-inline-error", result.message);
          toast(result.message, result.success ? "success" : "error", 8000);
        } else {
          const result = await configureMcp(btn.dataset.target);
          if (!result.success) setInlineError("mcp-inline-error", result.message);
          toast(result.message, result.success ? "success" : "error", 6000);
        }
      } catch (e) {
        setInlineError("mcp-inline-error", `No se pudo completar la conexión. (${e})`);
        toast("No se pudo completar la conexión", "error", 6000);
      } finally {
        _busySettingsOps.delete("mcp");
        targets.forEach(target => { target.disabled = false; target.removeAttribute("aria-busy"); });
        loadMcpStatus();
      }
    });
  });

  el.querySelector("#btn-verify-nlm")?.addEventListener("click", verifyNlmAuth);
  el.querySelector("#btn-auth-nlm")?.addEventListener("click", runNlmAuth);
  el.querySelector("#btn-codex-refresh")?.addEventListener("click", loadCodexStatus);
  el.querySelector("#btn-codex-stop")?.addEventListener("click", async () => {
    await codexStop();
    toast("Codex detenido.", "info", 3000);
    loadCodexStatus();
  });
  el.querySelector("#btn-codex-login")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-codex-login");
    if (btn) { btn.disabled = true; btn.innerHTML = `${jintiaLoaderPlaceholder(14)} Iniciando…`; mountAllJintiaLoaders(btn); }
    try {
      const status = await codexStatus();
      if (!status.running) {
        toast("Iniciando Codex app-server…", "loading", 10000);
        const startResult = await codexStart();
        if (!startResult.success) {
          toast(startResult.message, "error", 8000);
          return;
        }
      }
      const url = await codexStartLogin();
      await import("@tauri-apps/plugin-opener").then(m => m.openUrl(url));
      toast("Se abrió la página de autenticación de ChatGPT. Completa el inicio de sesión en el navegador.", "info", 15000);
      setTimeout(loadCodexStatus, 8000);
    } catch (e) {
      toast(`No se pudo iniciar la sesión de ChatGPT: ${e}`, "error", 8000);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `${ic("key", 14)} Conectar ChatGPT`;
        refreshIcons();
      }
    }
  });
  el.querySelector("#btn-claude-refresh")?.addEventListener("click", loadClaudeStatus);
  el.querySelector("#btn-claude-login")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-claude-login");
    if (btn) { btn.disabled = true; btn.innerHTML = `${jintiaLoaderPlaceholder(14)} Abriendo…`; mountAllJintiaLoaders(btn); }
    try {
      await claudeAuthLogin();
      toast("Se abrió el navegador para iniciar sesión con Claude. Vuelve aquí y pulsa Estado cuando termines.", "info", 15000);
      setTimeout(loadClaudeStatus, 8000);
    } catch (e) {
      toast(`No se pudo iniciar sesión con Claude Code: ${e}`, "error", 8000);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = `${ic("key", 14)} Conectar Claude`; refreshIcons(); }
    }
  });
  verifyNlmAuth();
  loadMcpStatus();
  loadCodexStatus();
  loadClaudeStatus();

  // ── Notebooks ─────────────────────────────────────────────────────────────
  renderNotebookList();
  el.querySelector("#btn-go-to-courses")?.addEventListener("click", () => navigate("courses"));

  // ── Environment ───────────────────────────────────────────────────────────
  el.querySelector("#btn-refresh-deps")?.addEventListener("click", loadDeps);
  el.querySelector("#btn-run-toolchain-doctor")?.addEventListener("click", runToolchainDoctor);
  el.querySelector("#btn-run-toolchain-operation")?.addEventListener("click", runToolchainOperation);
  el.querySelector("#btn-detect-harnesses")?.addEventListener("click", detectAgentHarnesses);
  el.querySelectorAll("[data-harness-operation]").forEach(button => button.addEventListener("click", event => manageAgentHarness(event.currentTarget.dataset.harnessOperation, event)));
  loadSetupStatus();
  loadDeps();
  detectAgentHarnesses();

  // ── App Preferences ───────────────────────────────────────────────────────
  loadSkillPath();
  loadAiPreference();
  el.querySelector("#btn-change-workspace-root")?.addEventListener("click", async () => {
    const current = state.config?.courseWorkspaceRoot || undefined;
    const chosen = await pickDirectory("Selecciona la carpeta raíz de tus cursos", current);
    if (!chosen) return;
    state.config = { ...state.config, courseWorkspaceRoot: ensureJintiaSubfolder(chosen) };
    saveConfig();
    const display = el.querySelector("#workspace-root-val");
    if (display) display.textContent = state.config.courseWorkspaceRoot;
    toast("Carpeta de cursos actualizada.", "success", 3000);
  });
  el.querySelector("#cfg-include-jintia-credit")?.addEventListener("change", event => {
    const previous = state.config.includeJintiaCredit;
    state.config.includeJintiaCredit = event.target.checked;
    try {
      saveConfig();
      toast(event.target.checked ? "Crédito de Jintia activado." : "Crédito de Jintia desactivado.", "success", 2500);
    } catch (error) {
      state.config.includeJintiaCredit = previous;
      event.target.checked = previous !== false;
      toast(`No se pudo guardar la preferencia: ${error}`, "error", 6000);
    }
  });

  el.querySelector("#btn-install-skill")?.addEventListener("click", event => {
    runSettingsOperation(event.currentTarget, "install-skill", "Instalando…", async () => {
      toast("Instalando en tu proyecto local…", "loading", 20000);
      try {
        const r = await installSkill();
        toast(r.message, r.success ? "success" : "error", 6000);
        if (r.success) loadSkillPath();
      } catch (e) { toast(`No se pudo instalar: ${e}`, "error", 7000); }
    });
  });

  el.querySelector("#btn-install-openai-plugin")?.addEventListener("click", event => {
    runSettingsOperation(event.currentTarget, "install-openai-plugin", "Instalando…", async () => {
      try {
        const result = await installOpenAIPlugin();
        toast(result.message, result.success ? "success" : "error", 10000);
        if (result.success) loadSetupStatus();
      } catch (error) {
        toast(`No se pudo instalar para ChatGPT/Codex: ${error}`, "error", 7000);
      }
    });
  });

  el.querySelector("#btn-reset-onboarding")?.addEventListener("click", async () => {
    if (!await confirm("¿Volver a mostrar el asistente inicial?\nNo se eliminarán tu perfil, asignaturas, notebooks ni archivos.")) return;
    await runSettingsOperation(document.getElementById("btn-reset-onboarding"), "reset-onboarding", "Preparando…", async () => {
      try {
        const r = await resetOnboarding();
        if (!r.success) {
          toast(r.message || "No se pudo reactivar el asistente inicial", "error", 7000);
          return;
        }
        toast("Abriendo el asistente inicial…", "info", 1500);
        window.location.reload();
      } catch (error) {
        toast(`No se pudo reactivar el asistente: ${error}`, "error", 7000);
      }
    });
  });

  refreshIcons();
}

// ── Institution ───────────────────────────────────────────────────────────────
async function saveInstitution() {
  setInlineError("institution-inline-error", "");
  const get = id => document.getElementById(id)?.value?.trim() || "";
  const author      = get("cfg-author");
  const institution = get("cfg-institution");
  clearSettingsFieldError("cfg-author");
  clearSettingsFieldError("cfg-institution");
  if (!author) {
    showSettingsFieldError("cfg-author", "Escribe tu nombre completo.");
    document.getElementById("cfg-author")?.focus();
    return;
  }
  if (!institution) {
    showSettingsFieldError("cfg-institution", "Escribe el nombre de la institución.");
    document.getElementById("cfg-institution")?.focus();
    return;
  }

  const color = document.getElementById("cfg-color")?.value || "#00317e";
  const { r, g, b } = hexToRgb(color);
  const config = {
    author,
    degree:      get("cfg-degree"),
    institution,
    faculty:     get("cfg-faculty"),
    career:      get("cfg-career"),
    color,
    website:     get("cfg-website"),
    ecosystem:   get("cfg-ecosystem").split("\n").map(s => s.trim()).filter(Boolean),
    discipline:  document.getElementById("cfg-discipline")?.value ?? "",
  };
  toast("Guardando configuración institucional…", "loading", 8000);
  try {
    const result = await applyInstitutionConfig({
      author: config.author,
      degree: config.degree,
      institution: config.institution,
      website: config.website,
      faculty: config.faculty,
      career: config.career,
      color_r: r,
      color_g: g,
      color_b: b,
      ecosystem: config.ecosystem.join("\n"),
      discipline: config.discipline,
    });
    if (result.success) {
      if (!state.config) state.config = {};
      const previous = { ...state.config };
      Object.assign(state.config, config);
      try {
        saveConfig();
      } catch (error) {
        state.config = previous;
        setInlineError("institution-inline-error", `La configuración se aplicó, pero no pudo guardarse localmente. (${error})`);
        toast("No se pudo completar el guardado local", "error", 6000);
        return;
      }
      toast("Configuración guardada", "success", 4000);
    } else {
      setInlineError("institution-inline-error", result.message);
      toast(result.message, "error");
    }
  } catch (e) { setInlineError("institution-inline-error", `Error: ${e}`); toast(`Error: ${e}`, "error"); }
}

function setInlineError(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
}

function showSettingsFieldError(id, message) {
  const field = document.getElementById(id);
  const error = document.getElementById(`${id}-error`);
  field?.setAttribute("aria-invalid", "true");
  field?.classList.add("border-red-500");
  if (error) {
    error.textContent = message;
    error.classList.remove("hidden");
  }
}

function clearSettingsFieldError(id) {
  const field = document.getElementById(id);
  const error = document.getElementById(`${id}-error`);
  field?.removeAttribute("aria-invalid");
  field?.classList.remove("border-red-500");
  if (error) {
    error.textContent = "";
    error.classList.add("hidden");
  }
}

async function loadInstitutionPalette() {
  const urlInput = document.getElementById("cfg-website");
  const container = document.getElementById("institution-palette");
  const button = document.getElementById("btn-extract-palette");
  if (!urlInput || !container || !button) return;

  const url = urlInput.value.trim();
  if (!url) {
    toast("Escribe la URL del sitio institucional", "error");
    urlInput.focus();
    return;
  }

  button.disabled = true;
  container.classList.remove("hidden");
  container.innerHTML = `<div class="flex items-center gap-1.5 text-xs text-app-muted">${jintiaLoaderPlaceholder(16)} Analizando sitio y hojas de estilo…</div>`;
  mountAllJintiaLoaders(container);
  try {
    const result = await extractSitePalette(url);
    if (!state.config) state.config = {};
    state.config.website = url;
    saveLocalConfig();
    renderPalette(container, result.colors);
    if (result.site_name && !document.getElementById("cfg-institution")?.value.trim()) {
      document.getElementById("cfg-institution").value = result.site_name;
    }
    toast(`Paleta extraída: ${result.colors.length} colores`, "success", 3500);
  } catch (error) {
    container.innerHTML = `<div class="flex items-center gap-1.5 text-xs text-red-700">${escapeHtml(String(error))}</div>`;
    toast(`No se pudo extraer la paleta: ${error}`, "error", 6000);
  } finally {
    button.disabled = false;
  }
}

function renderPalette(container, palette) {
  container.innerHTML = `
    <div class="mb-2.5 flex items-baseline justify-between gap-3 text-xs font-bold">
      <span>Colores encontrados</span>
      <span class="text-app-muted">Selecciona uno para usarlo como color institucional</span>
    </div>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5">
      ${palette.map(({ color, occurrences }) => `
        <button class="${cx(liquidForBackground(color), 'palette-swatch flex min-w-0 cursor-pointer items-center gap-2 p-1.5 text-left transition-colors hover:border-teal-400 [&_code]:text-inherit [&_small]:text-inherit')}" style="background-color:color-mix(in srgb, ${escapeHtml(color)} 32%, transparent)" type="button" data-palette-color="${escapeHtml(color)}"
          title="Usar ${escapeHtml(color)}">
          <span class="inline-block h-[31px] w-[31px] shrink-0 rounded-[7px] border border-black/15" style="background:${escapeHtml(color)}"></span>
          <span class="flex min-w-0 flex-col">
            <code class="overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px]">${escapeHtml(color)}</code>
            <small class="text-[10px] text-app-muted">${occurrences} ${occurrences === 1 ? "aparición" : "apariciones"}</small>
          </span>
        </button>`).join("")}
    </div>`;

  container.querySelectorAll("[data-palette-color]").forEach(button => {
    button.addEventListener("click", () => {
      const hex = cssColorToHex(button.dataset.paletteColor);
      if (!hex) {
        toast("El navegador no pudo convertir este color a RGB", "error");
        return;
      }
      const picker = document.getElementById("cfg-color");
      const label = document.getElementById("cfg-color-label");
      if (picker) picker.value = hex;
      if (label) label.textContent = hex;
      if (!state.config) state.config = {};
      state.config.color = hex;
      saveLocalConfig();
      container.querySelectorAll(".palette-swatch").forEach(item => item.classList.remove("selected", "border-teal-600", "shadow-[0_0_0_2px_rgba(0,121,107,0.1)]"));
      button.classList.add("selected", "border-teal-600", "shadow-[0_0_0_2px_rgba(0,121,107,0.1)]");
      toast(`Color institucional actualizado a ${hex}`, "success", 2500);
    });
  });
}

function cssColorToHex(color) {
  const probe = document.createElement("span");
  probe.style.color = "";
  probe.style.color = color;
  if (!probe.style.color) return null;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const match = computed.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (!match) return null;
  return `#${[match[1], match[2], match[3]]
    .map(value => Number(value).toString(16).padStart(2, "0"))
    .join("")}`;
}

function hexToRgb(hex) {
  const match = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return match
    ? { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) }
    : { r: 0, g: 49, b: 126 };
}

function saveLocalConfig() {
  localStorage.setItem("ids_config", JSON.stringify(state.config));
}

// ── MCP ───────────────────────────────────────────────────────────────────────
async function loadMcpStatus() {
  const badge = document.getElementById("mcp-status-badge");
  if (!badge) return;
  try {
    const status = await getSetupStatus();
    const mcpOk = status.mcp_configured;
    badge.style.background = mcpOk ? "rgba(26,127,75,0.08)" : "rgba(186,26,26,0.08)";
    badge.style.color      = mcpOk ? "var(--green)"          : "var(--red)";
    badge.style.border     = mcpOk ? "1px solid rgba(26,127,75,0.20)" : "1px solid rgba(186,26,26,0.20)";
    badge.innerHTML = `<span class="inline-block h-1.5 w-1.5 rounded-full bg-current"></span> ${mcpOk ? "Configurado" : "Sin configurar"}`;
  } catch {
    badge.textContent = "—";
  }
}

async function verifyNlmAuth() {
  const statusEl = document.getElementById("nlm-auth-status");
  if (statusEl) statusEl.textContent = "Verificando…";
  try {
    const status = await checkNotebookLMAuth();
    if (statusEl) {
      statusEl.textContent = status.authenticated
        ? `✓ Sesión activa — ${status.email || "cuenta Google"}`
        : "⚠ Sin sesión activa. El skill no podrá consultar NotebookLM.";
      statusEl.style.color = status.authenticated ? "var(--green)" : "var(--yellow)";
    }
  } catch {
    if (statusEl) { statusEl.textContent = "Error al verificar sesión"; statusEl.style.color = "var(--red)"; }
  }
}

async function runNlmAuth() {
  toast("Abriendo Chrome para autenticación…", "loading", 30000);
  try {
    const r = await runNotebookLMAuth();
    toast(r.message, r.success ? "success" : "error", 6000);
    if (r.success) verifyNlmAuth();
  } catch (e) { toast(`Error: ${e}`, "error"); }
}

// ── Notebooks (solo lectura: el vínculo curso↔notebook se gestiona en Cursos) ──
function renderNotebookList() {
  const list = document.getElementById("notebook-list");
  const summary = document.getElementById("notebook-status-summary");
  if (!list) return;
  const courses = state.courses;
  const connected = courses.filter(course => String(course.notebook_id || "").trim());
  if (summary) {
    summary.innerHTML = courses.length
      ? `<span class="inline-flex items-center gap-1.5 rounded-full border border-slate-300/50 bg-slate-200/20 px-2.5 py-0.5 text-[11px] font-bold text-app-muted">${ic("book-open", 14)} ${connected.length} de ${courses.length} asignaturas conectadas</span>`
      : "";
    refreshIcons();
  }
  if (!courses.length) {
    list.innerHTML = `<div class="py-4 text-center text-[13px] text-slate-400">Aún no hay asignaturas registradas.</div>`;
    return;
  }
  list.innerHTML = courses.map(course => `
    <div class="${ui.list.item}">
      <div class="${ui.list.left}">
        <span class="${course.notebook_id ? "text-brand-600" : "text-slate-300"}">${ic("book-open", 18)}</span>
        <div>
          <div class="${ui.list.label}">${escapeHtml(course.code)} — ${escapeHtml(course.name)}</div>
          <div class="${ui.list.sub}">${course.notebook_id ? escapeHtml(course.notebook_name || course.notebook_id) : "Sin conectar"}</div>
        </div>
      </div>
    </div>`).join("");
  refreshIcons();
}

// ── Environment ───────────────────────────────────────────────────────────────
async function runToolchainDoctor(event) {
  const button = event?.currentTarget;
  const output = document.getElementById("toolchain-report");
  if (!output) return;
  await runSettingsOperation(button, "toolchain-doctor", "Diagnosticando…", async () => {
    output.textContent = "Ejecutando jintia doctor…";
    try {
      const result = await runSkillTool("doctor");
      const report = result.report || result.stdout || result.message;
      output.textContent = typeof report === "string" ? report : JSON.stringify(report, null, 2);
      toast(result.success ? "Diagnóstico completado" : "El diagnóstico encontró problemas", result.success ? "success" : "error", 5000);
    } catch (error) {
      output.textContent = `No se pudo ejecutar el diagnóstico: ${error}`;
      toast("No se pudo ejecutar el diagnóstico", "error", 5000);
    }
  });
}

async function runToolchainOperation(event) {
  const button = event?.currentTarget;
  const operation = document.getElementById("toolchain-operation")?.value || "audit";
  const target = document.getElementById("toolchain-target")?.value.trim();
  const strict = Boolean(document.getElementById("toolchain-strict")?.checked);
  const output = document.getElementById("toolchain-report");
  if (!target) {
    output.textContent = "Escribe la ruta del README.md del curso.";
    toast("Falta el archivo objetivo", "error", 4000);
    document.getElementById("toolchain-target")?.focus();
    return;
  }
  await runSettingsOperation(button, "toolchain-operation", "Ejecutando…", async () => {
    output.textContent = `Ejecutando ${operation}…`;
    try {
      const result = await runSkillTool(operation, target, strict);
      const report = result.report || result.stdout || result.message;
      output.textContent = typeof report === "string" ? report : JSON.stringify(report, null, 2);
      toast(result.success ? "Operación completada" : "La operación encontró problemas", result.success ? "success" : "error", 5000);
    } catch (error) {
      output.textContent = `No se pudo ejecutar ${operation}: ${error}`;
      toast("No se pudo ejecutar la operación", "error", 5000);
    }
  });
}

async function detectAgentHarnesses(event) {
  const button = event?.currentTarget;
  const list = document.getElementById("harness-detection-list");
  if (!list) return;
  const projectPath = document.getElementById("harness-project-path")?.value.trim() || state.courses.find(course => course.project_path)?.project_path || ".";
  await runSettingsOperation(button, "harness-detection", "Detectando…", async () => {
    list.innerHTML = `<div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">Buscando entornos…</div>`;
    try {
      const result = await detectHarnesses(projectPath);
      const providers = Array.isArray(result?.providers) ? result.providers : [];
      list.innerHTML = providers.map(provider => {
        const ok = provider.status === "installed";
        const detected = provider.status !== "not-detected";
        const label = ok ? "Instalada" : detected ? "Detectado" : "No detectado";
        const classes = ok ? "border-green-200 bg-green-50 text-green-700" : detected ? "border-teal-200 bg-teal-50 text-teal-700" : "border-slate-200 bg-slate-50 text-slate-700";
        const id = typeof provider.id === "string" ? provider.id : "";
        const name = typeof provider.name === "string" ? provider.name : id || "Entorno sin nombre";
        const scope = typeof provider.scope === "string" ? provider.scope : "";
        const foundPath = typeof provider.foundPath === "string" && provider.foundPath ? provider.foundPath : "No se encontró la carpeta de configuración";
        return `<label class="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 ${classes}"><input type="checkbox" data-harness-provider value="${escapeHtml(id)}" ${id ? "" : "disabled"}><span class="font-semibold">${escapeHtml(name)}</span><span class="text-[11px] opacity-80">${escapeHtml(scope)}</span><span class="ml-auto text-[11px] font-bold uppercase tracking-wide">${label}</span><span class="basis-full text-[11px] opacity-80">${escapeHtml(foundPath)}</span></label>`;
      }).join("") || `<div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">No se encontraron entornos.</div>`;
    } catch (error) {
      list.innerHTML = "";
      list.innerHTML = `<div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">No se pudo detectar: ${escapeHtml(String(error))}</div>`;
    }
  });
}

async function manageAgentHarness(operation, event) {
  const button = event?.currentTarget || event;
  const projectPath = document.getElementById("harness-project-path")?.value.trim() || state.courses.find(course => course.project_path)?.project_path || ".";
  const providers = [...new Set(
    [...document.querySelectorAll("[data-harness-provider]:checked")]
      .map(input => input.value)
      .filter(Boolean)
  )];
  const scope = document.getElementById("harness-scope")?.value || "project";
  if (providers.length === 0) {
    toast("Selecciona al menos un entorno antes de continuar.", "error", 5000);
    return;
  }
  await runSettingsOperation(button, `harness-${operation}`, `${operation}…`, async () => {
    const result = await manageHarnesses(operation, projectPath, providers, scope, true);
    toast(result.message || `${operation} completado.`, result.success ? "success" : "error", 8000);
    await detectAgentHarnesses();
  });
}

async function loadSetupStatus() {
  const bar = document.getElementById("setup-status-bar");
  if (!bar) return;
  try {
    const status = await getSetupStatus();
    const items = [
      {
        label: status.skill_current
          ? `Skill ${status.skill_version || status.available_skill_version} actualizada`
          : status.skill_installed
            ? `Skill desactualizada · disponible ${status.available_skill_version}`
            : `Skill ${status.available_skill_version} sin instalar`,
        ok: status.skill_current
      },
      {
        label: status.openai_plugin_current
          ? `ChatGPT/Codex ${status.available_skill_version} preparado`
          : status.openai_plugin_installed
            ? "Plugin ChatGPT/Codex desactualizado"
            : "Plugin ChatGPT/Codex sin instalar",
        ok: status.openai_plugin_current
      },
      { label: "Conexión lista",       ok: status.mcp_configured },
      { label: "Institución guardada", ok: status.institution_configured },
      { label: "Sesión de Google",     ok: status.notebooklm_authenticated },
    ].filter(i => i.label);

    bar.innerHTML = `
      <div class="mb-3 flex flex-wrap gap-2">
        ${items.map(({ label, ok }) => `
          <span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold ${ok ? "border-green-200 bg-green-50 text-green-600" : "border-red-200 bg-red-50 text-red-500"}">
            ${ic(ok ? "check-circle-2" : "circle-x", 14)}
            ${escapeHtml(label)}
          </span>`).join("")}
      </div>`;
    refreshIcons();
  } catch {
    bar.innerHTML = "";
  }
}

// Compara la Jintia Skill ya instalada contra el @latest publicado en npm
// (check_skill_update_status, ver release.rs) y, si difiere, reemplaza el
// badge "OK" de esa fila por la versión disponible + un botón "Actualizar".
// Se llama después de pintar la fila (no bloquea la carga de dependencias:
// la consulta a npm puede tardar o fallar sin red, y en ese caso simplemente
// no se muestra nada nuevo).
async function refreshSkillUpdateBadge(container) {
  const row = [...container.querySelectorAll("[data-settings-dependency]")]
    .find(candidate => candidate.dataset.settingsDependency === "Jintia Skill");
  const actions = row?.querySelector("[data-dependency-actions]");
  if (!actions) return;
  let status;
  try {
    status = await checkSkillUpdateStatus();
  } catch {
    return; // sin red o falla la consulta: no hay nada que avisar, no es un error del usuario
  }
  if (!status?.updateAvailable || !status.latestNpmVersion) return;
  if (!actions.isConnected) return; // la sección pudo haberse vuelto a renderizar mientras esperábamos

  actions.innerHTML = `
    <div class="flex flex-col items-end gap-1">
      <span class="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700">Nueva versión: ${escapeHtml(status.latestNpmVersion)}</span>
      <button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}" data-update-skill>Actualizar Jintia Skill</button>
    </div>`;
  refreshIcons();

  actions.querySelector("[data-update-skill]")?.addEventListener("click", async () => {
    const btn = actions.querySelector("[data-update-skill]");
    btn.disabled = true;
    btn.textContent = "Actualizando…";
    try {
      const result = await runDependencyWithSettingsProgress(
        container,
        "Jintia Skill",
        () => downloadSkillRuntime()
      );
      if (result.success) {
        toast(result.message, "success", 5000);
        loadDeps();
        loadSetupStatus();
      } else {
        toast(result.message, "error", 6000);
      }
    } catch (e) {
      toast(`Error: ${e}`, "error", 6000);
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.textContent = "Actualizar Jintia Skill";
      }
    }
  });
}

async function loadDeps() {
  const container = document.getElementById("deps-content");
  if (!container) return;
  container.innerHTML = `<div class="p-6 text-center text-slate-400">Cargando…</div>`;

  try {
    const [deps, visualProfiles] = await Promise.all([
      checkDependencies(),
      getVisualInstallProfiles()
    ]);
    const ok    = deps.filter(d => d.installed).length;
    const total = deps.length;
    const pct   = total > 0 ? Math.round((ok / total) * 100) : 0;

    const selectedProfile = localStorage.getItem("jintia.visualProfile") || "minimum";
    const profiles = visualProfiles?.profiles || [];
    const profile = profiles.find(item => item.id === selectedProfile) || profiles[0];
    const dependencyByName = new Map(deps.map(dep => [dep.name, dep]));
    const unavailable = (profile?.tools || []).filter(tool => !dependencyByName.get(tool.desktopName)?.installed);

    container.innerHTML = `
      <div class="mb-4 rounded-xl border border-slate-900/10 bg-slate-900/[0.025] p-4">
        <div class="flex flex-wrap items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-semibold text-app-text">Perfil de capacidades visuales</div>
            <div class="${ui.list.sub}">${escapeHtml(profile?.description || "")}</div>
          </div>
          <select id="visual-install-profile" class="${ui.input}" aria-label="Perfil de capacidades visuales">
            ${profiles.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === profile?.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
          </select>
        </div>
        <div class="mt-3 text-xs ${unavailable.length ? "text-amber-700" : "text-green-700"}">
          ${unavailable.length
            ? `Capacidades deshabilitadas: ${unavailable.map(tool => `${escapeHtml(tool.desktopName)} (${escapeHtml(tool.version)})`).join(", ")}. La instalación es manual y siempre requiere tu confirmación.`
            : "Todas las capacidades del perfil están disponibles."}
        </div>
      </div>
      <div class="mb-3 flex items-center gap-3">
        <span class="text-2xl font-extrabold text-path-600">${ok}</span>
        <div>
          <div class="text-[13px] font-semibold text-app-text">de ${total} dependencias instaladas</div>
          <div class="mt-1 h-1.5 w-[180px] overflow-hidden rounded-full border border-slate-900/10 bg-slate-900/[0.06]">
            <div class="h-full rounded-full bg-path-500 shadow-[0_0_10px_rgba(52,195,122,.35)] transition-[width] duration-500" style="width:${pct}%"></div>
          </div>
        </div>
        <button class="${cx(ui.button.base, ui.button.primary, ui.button.sm, 'ml-auto')}" id="btn-install-all-deps">
            ${ic("download", 14)} Instalar herramientas necesarias
        </button>
      </div>
      <div class="mb-3 hidden rounded-xl border border-path-400/25 bg-path-50/60 px-3 py-2.5" data-bulk-install-progress role="status" aria-live="polite" aria-atomic="true">
        <div class="flex items-center justify-between gap-3 text-xs">
          <span class="font-semibold text-app-text" data-bulk-progress-message>Preparando herramientas…</span>
          <span class="font-semibold tabular-nums text-path-700" data-bulk-progress-value>0 de 0</span>
        </div>
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
          <div class="h-full rounded-full bg-path-500 transition-[width] duration-300" style="width:0%" data-bulk-progress-fill></div>
        </div>
      </div>
      ${deps.map(dep => `
        <div class="${ui.list.item} mb-1.5" data-settings-dependency="${escapeHtml(dep.name)}">
          <div class="${ui.list.left}">
            <div class="h-2 w-2 shrink-0 rounded-full ${dep.installed ? "bg-green-500 shadow-[0_0_0_3px_var(--green-bg),0_0_8px_rgba(74,222,128,0.4)]" : "bg-red-500 shadow-[0_0_0_3px_var(--red-bg),0_0_8px_rgba(248,113,113,0.4)]"}"></div>
            <div class="min-w-0 flex-1">
              <div class="${ui.list.label}">${escapeHtml(dep.name)}</div>
              <div class="${ui.list.sub}" data-dependency-detail aria-live="polite" aria-atomic="true">${escapeHtml(dep.version || (dep.installed ? "Instalado" : "No instalado"))}</div>
              <div class="mt-2 hidden min-w-[220px]" data-dependency-progress aria-live="polite" aria-atomic="true">
                <div class="flex items-center gap-2">
                  <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200">
                    <div class="h-full rounded-full bg-path-500 transition-[width] duration-300" style="width:0%" data-dependency-progress-fill></div>
                  </div>
                  <span class="w-12 text-right text-[10px] font-semibold tabular-nums text-app-muted" data-dependency-progress-value>0%</span>
                </div>
              </div>
            </div>
          </div>
          <div class="${ui.list.right}" data-dependency-actions>
            ${!dep.installed && dep.installable !== false
              ? dep.name === "Node.js"
                ? `<button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}" data-download-node>Descargar Node.js portable</button>`
                : dep.name === "Python"
                  ? `<button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}" data-download-python>Descargar Python oficial portable</button>`
                  : dep.name === "Jintia Skill"
                    ? `<button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}" data-download-skill>Instalar Jintia Skill</button>`
                    : `<button class="${cx(ui.button.base, ui.button.secondary, ui.button.sm)}" data-dep-name="${escapeHtml(dep.name)}">Instalar</button>`
              : dep.installed
                ? `<span class="${ui.badge.success}">OK</span>`
                : `<span class="${ui.badge.muted}">Instalación manual</span>`}
          </div>
        </div>`).join("")}`;
    refreshIcons();

    container.querySelectorAll("[data-dep-name]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.depName;
        if (!await confirm(`Vamos a instalar ${name} en tu sistema. ¿Continuar?`)) return;
        const originalLabel = btn.textContent;
        btn.textContent = "Instalando…";
        try {
          const r = await runDependencyWithSettingsProgress(
            container,
            name,
            () => name === "Vivliostyle CLI"
              ? installVivliostyleCli()
              : installDependency(name, true)
          );
          toast(r.message, r.success ? "success" : "error", 6000);
          if (r.success) { loadDeps(); loadSetupStatus(); }
        } catch (e) {
          toast(`No se pudo instalar ${name}: ${e}`, "error");
        } finally {
          btn.textContent = originalLabel;
        }
      });
    });

    container.querySelector("[data-download-node]")?.addEventListener("click", async () => {
      const btn = container.querySelector("[data-download-node]");
      btn.disabled = true;
      btn.textContent = "Descargando…";
      try {
        const result = await runDependencyWithSettingsProgress(
          container,
          "Node.js",
          () => downloadNodeRuntime()
        );
        if (result.success) {
          toast(result.message, "success", 5000);
          loadDeps();
          loadSetupStatus();
        } else {
          toast(result.message, "error", 6000);
        }
      } catch (e) {
        toast(`Error: ${e}`, "error", 6000);
      } finally {
        btn.disabled = false;
        btn.textContent = "Descargar Node.js portable";
      }
    });

    container.querySelector("[data-download-python]")?.addEventListener("click", async () => {
      const btn = container.querySelector("[data-download-python]");
      btn.disabled = true;
      btn.textContent = "Descargando…";
      try {
        const result = await runDependencyWithSettingsProgress(
          container,
          "Python",
          () => downloadPythonRuntime()
        );
        if (result.success) {
          toast(result.message, "success", 5000);
          loadDeps();
          loadSetupStatus();
        } else {
          toast(result.message, "error", 6000);
        }
      } catch (e) {
        toast(`Error: ${e}`, "error", 6000);
      } finally {
        btn.disabled = false;
        btn.textContent = "Descargar Python oficial portable";
      }
    });

    container.querySelector("[data-download-skill]")?.addEventListener("click", async () => {
      const btn = container.querySelector("[data-download-skill]");
      btn.disabled = true;
      btn.textContent = "Instalando…";
      try {
        const result = await runDependencyWithSettingsProgress(
          container,
          "Jintia Skill",
          () => downloadSkillRuntime()
        );
        if (result.success) {
          toast(result.message, "success", 5000);
          loadDeps();
          loadSetupStatus();
        } else {
          toast(result.message, "error", 6000);
        }
      } catch (e) {
        toast(`Error: ${e}`, "error", 6000);
      } finally {
        btn.disabled = false;
        btn.textContent = "Instalar Jintia Skill";
      }
    });

    // Solo tiene sentido si la skill ya está instalada: compara contra npm
    // en segundo plano y, si hay una versión más nueva, agrega un botón
    // "Actualizar" sin bloquear el resto de la pantalla mientras responde.
    if (deps.some(d => d.name === "Jintia Skill" && d.installed)) {
      refreshSkillUpdateBadge(container);
    }

    container.querySelector("#visual-install-profile")?.addEventListener("change", event => {
      localStorage.setItem("jintia.visualProfile", event.target.value);
      loadDeps();
    });

    container.querySelector("#btn-install-all-deps")?.addEventListener("click", async event => {
      // Solo las herramientas necesarias para producir el PDF: nunca instala
      // Git aunque falte (es opcional, no lo pide este flujo simplificado).
      const targets = deps.filter(d => !d.installed && BULK_INSTALL_TARGETS.has(d.name));
      if (targets.length === 0) {
        toast("Las herramientas necesarias ya están instaladas.", "info", 3500);
        return;
      }
      const names = targets.map(d => d.name).join(", ");
      if (!await confirm(`Se instalarán las herramientas necesarias para generar tus guías: ${names}. Esto puede tardar varios minutos. ¿Continuar?`)) return;
      const bulkButton = event.currentTarget;
      const bulkProgress = container.querySelector("[data-bulk-install-progress]");
      const bulkMessage = container.querySelector("[data-bulk-progress-message]");
      const bulkValue = container.querySelector("[data-bulk-progress-value]");
      const bulkFill = container.querySelector("[data-bulk-progress-fill]");
      bulkButton.disabled = true;
      bulkProgress?.classList.remove("hidden");
      let nodeReady = deps.some(d => d.name === "Node.js" && d.installed);
      let completed = 0;
      for (const [index, dep] of targets.entries()) {
        bulkButton.textContent = `Instalando ${index + 1} de ${targets.length}…`;
        if (bulkMessage) bulkMessage.textContent = `Herramienta ${index + 1} de ${targets.length}: ${dep.name}`;
        if (bulkValue) bulkValue.textContent = `${completed} de ${targets.length}`;
        if (bulkFill) bulkFill.style.width = `${Math.round((completed / targets.length) * 100)}%`;
        if (NODE_DEPENDENT_BULK_TARGETS.has(dep.name) && !nodeReady) {
          settingsDependencyReporter(container, dep.name)({
            message: "No se instaló: primero se necesita Node.js portable.",
            percent: null,
            state: "error",
          });
          completed += 1;
          if (bulkValue) bulkValue.textContent = `${completed} de ${targets.length}`;
          if (bulkFill) bulkFill.style.width = `${Math.round((completed / targets.length) * 100)}%`;
          continue;
        }
        try {
          let r;
          if (dep.name === "Node.js") {
            r = await runDependencyWithSettingsProgress(container, dep.name, () => downloadNodeRuntime());
            nodeReady = r.success === true;
          }
          else if (dep.name === "Python") {
            r = await runDependencyWithSettingsProgress(container, dep.name, () => downloadPythonRuntime());
          }
          else if (dep.name === "Jintia Skill") {
            r = await runDependencyWithSettingsProgress(container, dep.name, () => downloadSkillRuntime());
          }
          else if (dep.name === "Vivliostyle CLI") {
            r = await runDependencyWithSettingsProgress(container, dep.name, () => installVivliostyleCli());
          }
          else r = await installDependency(dep.name, true);
          toast(r.message, r.success ? "success" : "error", 4000);
        } catch (e) {
          if (dep.name === "Node.js") nodeReady = false;
          toast(`Error en ${dep.name}: ${e}`, "error");
        }
        completed += 1;
        if (bulkValue) bulkValue.textContent = `${completed} de ${targets.length}`;
        if (bulkFill) bulkFill.style.width = `${Math.round((completed / targets.length) * 100)}%`;
      }
      if (bulkMessage) bulkMessage.textContent = "Instalación de herramientas finalizada.";
      bulkButton.textContent = "Instalación finalizada";
      loadDeps(); loadSetupStatus();
    });

  } catch (e) {
    container.innerHTML = `<div class="p-5 text-red-500">Error al cargar: ${escapeHtml(String(e))}</div>`;
  }
}

// ── App Preferences ───────────────────────────────────────────────────────────
async function loadSkillPath() {
  const el = document.getElementById("skill-path-val");
  if (!el) return;
  try {
    const path = await getSkillPath();
    el.textContent = path || "No instalado";
    el.style.color = path ? "var(--teal)" : "var(--red)";
  } catch {
    el.textContent = "No disponible";
    el.style.color = "var(--muted)";
  }
}

async function loadAiPreference() {
  const el = document.getElementById("ai-pref-val");
  if (!el) return;
  try {
    const pref = await getAiPreference();
    const label = pref.model_name || pref.model_id;
    el.textContent = label || "Sin preferencia guardada";
    el.style.color = label ? "var(--teal)" : "var(--muted)";
  } catch {
    el.textContent = "No disponible";
    el.style.color = "var(--muted)";
  }
}

async function loadCodexStatus() {
  const label = document.getElementById("codex-status-label");
  const btnLogin = document.getElementById("btn-codex-login");
  const btnStop = document.getElementById("btn-codex-stop");
  if (!label) return;
  try {
    const s = await codexStatus();
    if (!s.installed) {
      label.textContent = "Codex CLI no instalado. Ejecuta: npm install -g @openai/codex";
      label.style.color = "var(--red)";
      if (btnLogin) btnLogin.disabled = true;
      if (btnStop) btnStop.classList.add("hidden");
      return;
    }
    if (!s.running) {
      label.textContent = "Codex instalado pero no iniciado.";
      label.style.color = "var(--muted)";
      if (btnLogin) btnLogin.disabled = false;
      if (btnStop) btnStop.classList.add("hidden");
      return;
    }
    if (s.logged_in && s.account?.email) {
      label.textContent = `Conectado — ${s.account.email}${s.account.plan_type ? ` (${s.account.plan_type})` : ""}`;
      label.style.color = "var(--green)";
      void loadCodexUsagePanel();
    } else if (s.running) {
      label.textContent = "Codex activo, sin sesión de ChatGPT.";
      label.style.color = "var(--yellow)";
      hideCodexUsagePanel();
    }
    if (btnStop) btnStop.classList.remove("hidden");
    if (btnLogin) btnLogin.disabled = false;
  } catch {
    if (label) { label.textContent = "No disponible"; label.style.color = "var(--muted)"; }
  }
}

/**
 * `claude_auth_login` no se probó en vivo contra una sesión real (arrancarlo
 * con una sesión ya activa podría reiniciar su flujo de login sin aviso),
 * así que el botón "Conectar Claude" solo se habilita cuando `authenticated`
 * es `false` — el único caso en que realmente hace falta pulsarlo.
 */
async function loadClaudeStatus() {
  const label = document.getElementById("claude-status-label");
  const btnLogin = document.getElementById("btn-claude-login");
  if (!label) return;
  try {
    const s = await claudeStatus();
    if (!s.installed) {
      label.textContent = "Claude Code CLI no instalado. Ejecuta: npm install -g @anthropic-ai/claude-code";
      label.style.color = "var(--red)";
      if (btnLogin) btnLogin.disabled = true;
      return;
    }
    if (!s.authenticated) {
      label.textContent = `Instalado${s.version ? ` (${s.version})` : ""}, sin sesión activa.`;
      label.style.color = "var(--yellow)";
      if (btnLogin) btnLogin.disabled = false;
      return;
    }
    if (btnLogin) btnLogin.disabled = true;
    const auth = s.auth || {};
    const account = [auth.email, auth.subscriptionType].filter(Boolean).join(" · ");
    label.textContent = `Conectado${account ? ` — ${account}` : ""}${s.usingApiKey ? " (usando ANTHROPIC_API_KEY, no tu suscripción)" : ""}`;
    label.style.color = s.usingApiKey ? "var(--yellow)" : "var(--green)";
  } catch {
    label.textContent = "No disponible";
    label.style.color = "var(--muted)";
  }
}

function hideCodexUsagePanel() {
  const panel = document.getElementById("codex-usage-panel");
  if (panel) panel.hidden = true;
}

/** Panel de monitoreo: cuánto queda de la cuota de Codex y cuándo se reinicia. */
async function loadCodexUsagePanel() {
  const panel = document.getElementById("codex-usage-panel");
  if (!panel) return;
  try {
    const result = await codexReadRateLimits();
    const window = primaryWindow(result);
    if (!window || typeof window.usedPercent !== "number") {
      hideCodexUsagePanel();
      return;
    }
    const limited = isRateLimited(result);
    const bar = document.getElementById("codex-usage-bar");
    const percentEl = document.getElementById("codex-usage-percent");
    const resetEl = document.getElementById("codex-usage-reset");
    const planEl = document.getElementById("codex-usage-plan");

    panel.hidden = false;
    if (bar) {
      bar.style.width = `${Math.min(100, Math.max(0, window.usedPercent))}%`;
      bar.className = `h-full rounded-full transition-all ${limited ? "bg-red-600" : "bg-teal-600"}`;
    }
    if (percentEl) {
      percentEl.textContent = `${formatUsagePercent(window.usedPercent)} usado`;
      percentEl.className = limited ? "font-semibold text-red-700" : "";
    }
    if (resetEl) {
      const countdown = formatResetCountdown(window.resetsAt);
      resetEl.textContent = countdown ? (limited ? `Disponible ${countdown}` : `Reinicia ${countdown}`) : "";
    }
    if (planEl) planEl.textContent = result?.rateLimits?.planType || "";
  } catch {
    hideCodexUsagePanel();
  }
}
