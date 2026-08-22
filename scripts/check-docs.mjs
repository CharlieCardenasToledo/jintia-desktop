import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ignored = new Set([".git", "node_modules", "dist", "target", ".rtfm", ".playwright-mcp", ".claude", ".codex"]);
const errors = [];

function collect(directory, extension, files = []) {
  for (const name of readdirSync(directory)) {
    if (ignored.has(name)) continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) collect(path, extension, files);
    else if (extname(name).toLowerCase() === extension) files.push(path);
  }
  return files;
}

const markdown = collect(root, ".md");

// Patrones que indican documentación que describe la arquitectura anterior
// (motor LaTeX embebido, payload de skill.lock.json, versión de MCP
// hardcodeada, invocación npm sin scope). Ver docs/architecture.md para la
// arquitectura vigente: npm install en runtime + validación de contrato,
// motor HTML + Vivliostyle CLI.
const obsolete = [
  ["pdflatex", "motor LaTeX eliminado; el motor vigente es HTML + Vivliostyle CLI"],
  ["xelatex", "motor LaTeX eliminado; el motor vigente es HTML + Vivliostyle CLI"],
  ["latex-linter", "linter LaTeX eliminado del pipeline"],
  ["Biber", "bibliografía LaTeX eliminada del pipeline (motor actual: Citation.js, del lado de la skill)"],
  ["MiKTeX", "distribución LaTeX eliminada del pipeline"],
  ["TeX Live", "distribución LaTeX eliminada del pipeline"],
  ["guia.tex", "los archivos .tex ya no forman parte del pipeline"],
  ["skill.lock.json", "artefacto eliminado; la skill se instala desde npm en runtime, no como payload embebido"],
  ["gemini-notebook-mcp@2.3.3", "versión de MCP hardcodeada y desactualizada; no fijar aquí ninguna versión, usar release/release-config.json de la skill instalada"],
];

// Documentos que registran historia (refactors completados, decisiones
// pasadas) legítimamente mencionan términos obsoletos al describir qué se
// eliminó — igual que CHANGELOG.md.
const exempt = new Set(["CHANGELOG.md", "CLAUDE.md"]);

const npmScopePattern = /(?<!@charlie\.act7\/)\bnpx jintia\b/;

for (const file of markdown) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|#)/i.test(raw)) continue;
    const pathPart = decodeURIComponent(raw.split("#", 1)[0]);
    if (!pathPart) continue;
    const target = resolve(dirname(file), pathPart);
    if (!existsSync(target)) errors.push(`${file}: enlace local inexistente: ${raw}`);
  }
  if ([...exempt].some(name => file.endsWith(name))) continue;
  for (const [term, reason] of obsolete) {
    if (text.includes(term)) errors.push(`${file}: ${reason}: ${term}`);
  }
  if (npmScopePattern.test(text)) {
    errors.push(`${file}: "npx jintia" sin scope — debe ser "npx @charlie.act7/jintia"`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Documentación válida: ${markdown.length} Markdown, sin drift conocido.`);
