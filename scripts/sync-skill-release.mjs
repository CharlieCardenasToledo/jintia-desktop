import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const resources = new URL("../src-tauri/resources/", import.meta.url);
const current = JSON.parse(await readFile(new URL("skill.lock.json", root), "utf8"));
const tagArgument = process.argv.find(argument => argument.startsWith("--tag="));
const tag = tagArgument?.slice("--tag=".length) || current.tag;
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Usa --tag=vX.Y.Z");

const base = `https://github.com/${current.repository}/releases/download/${tag}`;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function download(name) {
  const response = await fetch(`${base}/${name}`, { redirect: "follow" });
  if (!response.ok) throw new Error(`No se pudo descargar ${name}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function replace(name, bytes) {
  const destination = new URL(name, resources);
  const temporary = new URL(`${name}.tmp`, resources);
  await writeFile(temporary, bytes);
  await unlink(destination).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  await rename(temporary, destination);
}

await mkdir(resources, { recursive: true });
const manifestFile = "jintia-release-manifest.json";
const manifestBytes = await download(manifestFile);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (!/^\d+\.\d+\.\d+$/.test(manifest.skillVersion || "")) {
  throw new Error("El manifest no contiene una versión válida");
}
if (tag !== `v${manifest.skillVersion}`) throw new Error("El tag no coincide con la versión del manifest");
if (manifest.source?.repository !== current.repository) throw new Error("El manifest pertenece a otro repositorio");
if (!manifest.mcp || typeof manifest.mcp !== "object") throw new Error("El manifest no contiene mcp");
if (typeof manifest.mcp.package !== "string" || manifest.mcp.package.trim() === "") {
  throw new Error("El manifest no contiene mcp.package válido");
}
if (typeof manifest.mcp.version !== "string" || manifest.mcp.version.trim() === "") {
  throw new Error("El manifest no contiene mcp.version válido");
}
if (typeof manifest.mcp.node !== "string" || manifest.mcp.node.trim() === "") {
  throw new Error("El manifest no contiene mcp.node válido");
}

await replace(manifestFile, manifestBytes);

const next = {
  schemaVersion: 1,
  repository: current.repository,
  tag,
  manifest: { file: manifestFile, sha256: digest(manifestBytes) },
  mcp: manifest.mcp,
};
await writeFile(new URL("skill.lock.json", root), `${JSON.stringify(next, null, 2)}\n`);
console.log(`Jintia Desktop quedó sincronizado con ${tag}. Ejecuta npm run skill:verify y las pruebas.`);
