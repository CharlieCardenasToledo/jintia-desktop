import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const resources = new URL("../src-tauri/resources/", import.meta.url);
const lock = JSON.parse(await readFile(new URL("skill.lock.json", root), "utf8"));

function fail(message) {
  throw new Error(`Skill release inválida: ${message}`);
}

async function inspect(entry, label) {
  const path = new URL(entry.file, resources);
  const bytes = await readFile(path).catch(() => fail(`falta ${label}: ${fileURLToPath(path)}`));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256) fail(`${label} tiene SHA-256 ${digest}; se esperaba ${entry.sha256}`);
  if (entry.bytes !== undefined && (await stat(path)).size !== entry.bytes) {
    fail(`${label} no tiene el tamaño declarado`);
  }
  return bytes;
}

if (lock.schemaVersion !== 1) fail("schemaVersion no soportado");
if (!/^v\d+\.\d+\.\d+$/.test(lock.tag)) fail("tag debe tener formato vX.Y.Z");
if (lock.tag !== `v${lock.skillVersion}`) fail("tag y skillVersion no coinciden");

const manifestBytes = await inspect(lock.manifest, "manifest");
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.skillVersion !== lock.skillVersion) fail("la versión del manifest no coincide con el lock");
if (manifest.source?.repository !== lock.repository) fail("el repositorio del manifest no coincide con el lock");
if (JSON.stringify(manifest.mcp) !== JSON.stringify(lock.mcp)) fail("el contrato MCP no coincide con el manifest");

for (const key of ["skill", "openaiPlugin"]) {
  if (JSON.stringify(manifest.artifacts?.[key]) !== JSON.stringify(lock.artifacts?.[key])) {
    fail(`artifacts.${key} no coincide con el manifest`);
  }
  await inspect(lock.artifacts[key], `artifacts.${key}`);
}

const compatibility = new Set(manifest.compatibility);
for (const client of ["claude", "codex", "chatgpt"]) {
  if (!compatibility.has(client)) fail(`el manifest no declara compatibilidad con ${client}`);
}

console.log(`Skill ${lock.skillVersion} verificada: manifest y artefactos coinciden con skill.lock.json.`);
