export const CAPABILITY_CATEGORIES = ["core", "assistant", "integration", "optional"];

const LEGACY_IDS = {
  "Node.js": "node",
  Python: "python",
  "Jintia Skill": "jintia-skill",
  "Vivliostyle CLI": "vivliostyle",
  "NotebookLM MCP": "notebooklm-mcp",
};

export function normalizeCapability(raw = {}) {
  const installed = raw.status ? raw.status === "ready" : raw.installed === true;
  const label = raw.label || raw.name || "Componente";
  const category = CAPABILITY_CATEGORIES.includes(raw.category) ? raw.category : "optional";
  const blockingScope = raw.blockingScope ?? (raw.required ? "onboarding" : "none");
  return {
    ...raw,
    id: raw.id || LEGACY_IDS[label] || label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    label,
    name: raw.name || label,
    category,
    status: raw.status || (installed ? "ready" : "missing"),
    blockingScope,
    installable: raw.installable === true,
    requiresConsent: raw.requiresConsent ?? raw.installable === true,
    operation: raw.operation || null,
    reason: raw.reason || raw.note || "Amplía las capacidades de Jintia.",
    technicalDetail: raw.technicalDetail || raw.command || raw.version || "Sin detalle adicional.",
    installed,
  };
}

export function normalizeCapabilities(values) {
  return Array.isArray(values) ? values.map(normalizeCapability) : [];
}

export function isOnboardingBlocking(capability) {
  return capability.blockingScope === "onboarding" && capability.status !== "ready";
}

export function installableBlockingCapabilities(values) {
  return values.filter(capability => isOnboardingBlocking(capability) && capability.installable);
}

export function capabilityStatusLabel(status) {
  return ({ ready: "Listo", missing: "Falta", working: "Instalando", error: "Error" })[status] || "Falta";
}
