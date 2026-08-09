import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const resources = new URL("../src-tauri/resources/", import.meta.url);
const lock = JSON.parse(await readFile(new URL("skill.lock.json", root), "utf8"));

function fail(message) {
  throw new Error(`Contrato MCP de Desktop inválido: ${message}`);
}

function requiredString(value, path) {
  const result = value?.[path];
  if (typeof result !== "string" || result.trim() === "") {
    fail(`${path} es obligatorio y no puede estar vacío`);
  }
  return result;
}

async function readVerifiedManifest(entry) {
  const path = new URL(entry.file, resources);
  const bytes = await readFile(path).catch(() => fail(`falta manifest: ${fileURLToPath(path)}`));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(entry.sha256) || digest !== entry.sha256) {
    fail(`manifest tiene SHA-256 ${digest}; se esperaba ${entry.sha256}`);
  }
  return bytes;
}

if (lock.schemaVersion !== 1) fail("schemaVersion no soportado");
const repository = requiredString(lock, "repository");
const manifestFile = requiredString(lock.manifest, "file");
const manifestSha256 = requiredString(lock.manifest, "sha256");
if (!/^[a-f0-9]{64}$/.test(manifestSha256)) {
  fail("manifest.sha256 debe ser SHA-256 hexadecimal de 64 caracteres");
}
const mcpPackage = requiredString(lock.mcp, "package");
const mcpVersion = requiredString(lock.mcp, "version");
const mcpNode = requiredString(lock.mcp, "node");

const manifestBytes = await readVerifiedManifest({ file: manifestFile, sha256: manifestSha256 });
let manifest;
try {
  manifest = JSON.parse(manifestBytes.toString("utf8"));
} catch (error) {
  fail(`manifest no es JSON válido: ${error.message}`);
}

if (manifest.source?.repository !== repository) {
  fail("el repositorio del manifest no coincide con el lock");
}
if (JSON.stringify(manifest.mcp) !== JSON.stringify(lock.mcp)) {
  fail("el contrato MCP no coincide con el manifest");
}

console.log(`Contrato MCP de Desktop verificado: ${mcpPackage}@${mcpVersion}.`);
