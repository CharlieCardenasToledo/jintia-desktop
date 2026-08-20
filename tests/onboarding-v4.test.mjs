import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  installableBlockingCapabilities,
  isOnboardingBlocking,
  normalizeCapabilities,
} from "../src/onboardingCapabilities.js";
import {
  PROFILE_DRAFT_KEY,
  clearProfileDraft,
  loadProfileDraft,
  persistProfileDraft,
  profileDraftFromConfig,
  validateProfileDraft,
} from "../src/onboardingDraft.js";
import { createOperationState, elapsedLabel, reduceOperationEvent } from "../src/onboardingLongOperation.js";

const root = new URL("../", import.meta.url);

async function readOnboardingJs() {
  const parts = await Promise.all(
    ["store.js", "ui.js", "steps.js", "actions.js", "controller.js", "index.js"].map(
      f => readFile(new URL(`src/onboarding/${f}`, root), "utf8").catch(() => "")
    )
  );
  return parts.join("\n");
}

async function readMcpRs() {
  const parts = await Promise.all(
    ["mod.rs", "auth.rs", "client.rs", "config.rs", "notebooks.rs"].map(
      f => readFile(new URL(`src-tauri/src/mcp/${f}`, root), "utf8").catch(() => "")
    )
  );
  return parts.join("\n");
}

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  };
}

test("el adaptador migra DependencyStatus v1 al contrato explícito", () => {
  const [legacy] = normalizeCapabilities([{ name: "Node.js", installed: false, required: true, installable: true, note: "Motor" }]);
  assert.equal(legacy.id, "node");
  assert.equal(legacy.status, "missing");
  assert.equal(legacy.blockingScope, "onboarding");
  assert.equal(legacy.reason, "Motor");
  assert.equal(isOnboardingBlocking(legacy), true);
});

test("instalar todo selecciona solo bloqueantes instalables y no duplica listos", () => {
  const values = normalizeCapabilities([
    { id: "node", label: "Node", status: "missing", blockingScope: "onboarding", installable: true },
    { id: "python", label: "Python", status: "ready", blockingScope: "onboarding", installable: true },
    { id: "git", label: "Git", status: "missing", blockingScope: "none", installable: true },
  ]);
  assert.deepEqual(installableBlockingCapabilities(values).map(value => value.id), ["node"]);
});

test("cada capacidad opcional ofrece una acción individual honesta", async () => {
  const source = await readOnboardingJs();
  assert.match(source, /dep\.blockingScope === "none" \? "Instalar por separado"/);
  assert.match(source, /data-show-capability-details/);
  assert.match(source, /Ver cómo habilitarla/);
});

test("el borrador conserva cada campo y se limpia solo de forma explícita", () => {
  const storage = memoryStorage();
  const fallback = profileDraftFromConfig({ institution: "Inicial" }, "classic");
  const expected = { ...fallback, institution: "Universidad ñ", author: "Ana M.", career: "Software", templateId: "modern" };
  persistProfileDraft(storage, expected);
  assert.deepEqual(loadProfileDraft(storage, fallback), expected);
  assert.ok(storage.getItem(PROFILE_DRAFT_KEY));
  clearProfileDraft(storage);
  assert.equal(storage.getItem(PROFILE_DRAFT_KEY), null);
});

test("la validación del perfil identifica el primer control enfocable", () => {
  const errors = validateProfileDraft(profileDraftFromConfig());
  assert.equal(errors[0].fieldId, "onb-institution");
  assert.ok(errors.some(error => error.fieldId === "onb-template-group"));
});

test("la máquina de operaciones conserva estados, porcentaje y tiempo real", () => {
  const initial = createOperationState({ id: "op-1", startedAt: 1_000 });
  const working = reduceOperationEvent(initial, { operationId: "op-1", state: "working", phase: "verifying", percent: 42, cancellable: true });
  assert.equal(working.state, "working");
  assert.equal(working.percent, 42);
  assert.equal(working.cancellable, true);
  assert.equal(elapsedLabel(1_000, 12_000), "0:11");
});

test("NotebookLM expone operación identificada, fases y cancelación con limpieza", async () => {
  const [mcp, lib, api, onboarding] = await Promise.all([
    readMcpRs(),
    readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
    readFile(new URL("src/api.js", root), "utf8"),
    readOnboardingJs(),
  ]);
  for (const phase of ["opening_browser", "waiting_for_login", "verifying", "done", "cancelled", "error"]) assert.match(mcp, new RegExp(phase));
  assert.match(mcp, /AUTH_CANCEL_REQUESTED/);
  assert.match(mcp, /receive_json_cancellable/);
  assert.match(mcp, /discard_connection\(\)/);
  assert.match(lib, /start_notebooklm_auth[\s\S]*cancel_notebooklm_auth/);
  assert.match(api, /startNotebookLMAuth[\s\S]*cancelNotebookLMAuth/);
  assert.match(onboarding, /listen\("notebooklm-auth-progress"/);
  assert.match(onboarding, /payload\?\.operationId !== operationId/);
});

test("la prueba final transmite la actividad del backend y mantiene un cronómetro real", async () => {
  const [steps, actions, backend] = await Promise.all([
    readFile(new URL("src/onboarding/steps.js", root), "utf8"),
    readFile(new URL("src/onboarding/actions.js", root), "utf8"),
    readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  ]);
  assert.match(steps, /id="compile-current"[\s\S]*id="compile-live-log"[\s\S]*id="compile-elapsed"|id="compile-elapsed"[\s\S]*id="compile-current"[\s\S]*id="compile-live-log"/);
  const start = actions.indexOf("export async function animateFinalStep");
  const end = actions.indexOf("export function bindStepEvents", start);
  const finalFlow = actions.slice(start, end);
  const subscription = finalFlow.indexOf('listen("self-test-progress"');
  const command = finalFlow.indexOf("runSkillSelfTest(operationId)", subscription);
  assert.ok(subscription >= 0 && command > subscription, "la suscripción debe existir antes de iniciar el comando");
  assert.match(finalFlow, /window\.setInterval\(updateElapsed, 250\)/);
  assert.match(finalFlow, /window\.clearInterval\(elapsedTimer\)/);
  assert.match(finalFlow, /unlistenSelfTest\?\.\(\)/);
  assert.match(finalFlow, /compileDiagnostics\.push\(line\)/);
  assert.match(finalFlow, /payload\?\.operationId !== operationId/);
  assert.match(finalFlow, /activeFinalRunId/);
  assert.match(backend, /"self-test-progress"/);
  for (const phase of ["preparing", "running", "report_received", "guide_preparing", "guide_report_received", "check", "completed", "error"]) {
    assert.match(backend, new RegExp(`"${phase}"`));
  }
  assert.match(backend, /course::generate_welcome_guide_pdf\(\)/);
  assert.match(actions, /guía práctica para aprender a usar la plataforma/);
});

test("la guía inicial enseña el recorrido vigente de la plataforma", async () => {
  const guide = await readFile(new URL("src-tauri/src/course/welcome.rs", root), "utf8");

  for (const expected of [
    "Cómo usar la plataforma paso a paso",
    "Mis cursos",
    "Ask Jintia",
    "PDFs generados",
    "Plantillas",
    "Configuración",
    "OpenCode",
    "Claude Code",
    "ChatGPT (Codex)",
    "HTML",
    "Vivliostyle",
  ]) {
    assert.match(guide, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(guide, /preparar una clase en 10 minutos|Gemini Notebook}}|generación automática de PDFs tipográficos/);
});

test("la ayuda y el entorno simulado describen Vivliostyle como motor principal", async () => {
  const [docs, mock] = await Promise.all([
    readFile(new URL("src/pages/docs.js", root), "utf8"),
    readFile(new URL("src/mocks/tauri-core.mock.js", root), "utf8"),
  ]);

  assert.match(docs, /HTML y Vivliostyle/);
  assert.match(docs, /Actividad del sistema/);
  assert.doesNotMatch(docs, /MiKTeX|File \.sty not found|varias pasadas de LaTeX/);
  assert.match(mock, /name: "Vivliostyle CLI"[\s\S]{0,180}required: true/);
  assert.match(mock, /name: "Compilador LaTeX"[\s\S]{0,180}required: false/);
});

test("el onboarding elimina el falso skip y usa main, foco, live region y modal atrapado", async () => {
  const source = await readOnboardingJs();
  assert.doesNotMatch(source, /skip-onboarding|Saltar configuración/);
  assert.match(source, /<main[\s\S]*aria-labelledby="onboarding-title"/);
  assert.match(source, /aria-current=\"step\"/);
  assert.match(source, /aria-live=\"\$\{stepChanged/);
  assert.match(source, /background\.inert = true/);
  assert.match(source, /event\.key === "Tab"/);
  assert.match(source, /opener\?\.focus/);
});

test("la ventana inicia maximizada también durante el onboarding", async () => {
  const [config, main] = await Promise.all([
    readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"),
    readFile(new URL("src/main.js", root), "utf8"),
  ]);
  assert.equal(JSON.parse(config).app.windows[0].maximized, true);
  const maximize = main.indexOf("await getCurrentWindow().maximize()");
  const status = main.indexOf("await getOnboardingStatus()");
  assert.ok(maximize >= 0 && maximize < status);
});
