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
if (tag !== `v${manifest.skillVersion}`) throw new Error("El tag no coincide con la versión del manifest");
if (manifest.source?.repository !== current.repository) throw new Error("El manifest pertenece a otro repositorio");

const artifacts = {};
for (const key of ["skill", "openaiPlugin"]) {
  const entry = manifest.artifacts?.[key];
  if (!entry?.file || !entry?.sha256) throw new Error(`El manifest no contiene artifacts.${key}`);
  const bytes = await download(entry.file);
  if (digest(bytes) !== entry.sha256 || bytes.length !== entry.bytes) {
    throw new Error(`${entry.file} no coincide con el manifest`);
  }
  artifacts[key] = { entry, bytes };
}

await replace(manifestFile, manifestBytes);
for (const { entry, bytes } of Object.values(artifacts)) await replace(entry.file, bytes);

const next = {
  schemaVersion: 1,
  repository: current.repository,
  tag,
  skillVersion: manifest.skillVersion,
  minimumDesktopVersion: manifest.minimumDesktopVersion,
  manifest: { file: manifestFile, sha256: digest(manifestBytes) },
  mcp: manifest.mcp,
  artifacts: manifest.artifacts,
};
await writeFile(new URL("skill.lock.json", root), `${JSON.stringify(next, null, 2)}\n`);
console.log(`Jintia Desktop quedó sincronizado con ${tag}. Ejecuta npm run skill:verify y las pruebas.`);
