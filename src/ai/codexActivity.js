const LATEX_PATTERN = /(?:^|[\\/\s"'])(?:pdf|xe|lua)?latex(?:\.exe)?\b|latex-validator|\.tex\b/i;

export function commandFromCodexParams(params = {}) {
  const item = params.item && typeof params.item === "object" ? params.item : params;
  const command = item.command ?? params.command ?? "";
  return Array.isArray(command) ? command.join(" ") : String(command || "");
}

export function cwdFromCodexParams(params = {}) {
  const item = params.item && typeof params.item === "object" ? params.item : params;
  return String(item.cwd ?? params.cwd ?? "");
}

export function isLegacyLatexCommand(command) {
  return LATEX_PATTERN.test(String(command || ""));
}

export function summarizeCodexOutput(output) {
  const text = String(output || "");
  if (/fresh TeX installation|finish the setup|MiKTeX/i.test(text)) {
    return {
      message: "Codex intentó usar una instalación de LaTeX sin configurar.",
      detail: "Jintia actual genera HTML y PDF con Vivliostyle; esta ruta parece heredada.",
      tone: "warning",
      legacy: true,
    };
  }
  if (/Acceso denegado|Access is denied|Result:\s*5/i.test(text)) {
    return {
      message: "Una herramienta no pudo escribir fuera de la carpeta permitida.",
      detail: "Codex puede pedir autorización si la acción sigue siendo necesaria.",
      tone: "warning",
      legacy: false,
    };
  }
  if (/MODULE_NOT_FOUND|Cannot find module/i.test(text)) {
    return {
      message: "No se encontró una herramienta que Codex intentó ejecutar.",
      detail: "Se conservará el detalle técnico para diagnosticar la ruta utilizada.",
      tone: "warning",
      legacy: LATEX_PATTERN.test(text),
    };
  }
  return {
    message: "Codex está ejecutando una herramienta…",
    detail: "Recibiendo información del proceso.",
    tone: "working",
    legacy: LATEX_PATTERN.test(text),
  };
}

export function approvalPresentation(params = {}) {
  const command = commandFromCodexParams(params);
  const cwd = cwdFromCodexParams(params);
  const legacy = isLegacyLatexCommand(command);
  const reason = String(params.reason || "").trim();
  const recommendation = legacy
    ? "\n\nAdvertencia de Jintia: este comando usa LaTeX/MiKTeX. El flujo editorial vigente usa guide.json, HTML y Vivliostyle; se recomienda denegarlo y pedir a Codex que use $jintia-skill."
    : "";
  return {
    title: legacy ? "Codex solicita ejecutar una herramienta heredada" : "Codex quiere ejecutar un comando",
    message: `${reason ? `${reason}\n\n` : ""}$ ${command || "(comando no especificado)"}\n\nCarpeta: ${cwd || "—"}${recommendation}`,
    legacy,
  };
}

export function changedFilesFromCodexDiff(diff) {
  const files = [];
  const seen = new Set();
  for (const match of String(diff || "").matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const path = match[2].trim();
    if (!seen.has(path)) {
      seen.add(path);
      files.push(path);
    }
  }
  return files;
}

export function trimCodexTechnicalOutput(output, maxLength = 3500) {
  const text = String(output || "").replace(/\r/g, "").trim();
  return text.length <= maxLength ? text : `…${text.slice(-maxLength)}`;
}
