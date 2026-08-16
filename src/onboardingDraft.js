export const PROFILE_DRAFT_KEY = "jintia.onboarding.profileDraft.v1";

export const PROFILE_FIELDS = [
  "website", "institution", "faculty", "career", "author", "degree",
  "discipline", "colorHex", "templateId",
];

export function profileDraftFromConfig(config = {}, templateId = "") {
  return {
    website: config.website || "",
    institution: config.institution || "",
    faculty: config.faculty || "",
    career: config.career || "",
    author: config.author || "",
    degree: config.degree || "",
    discipline: config.discipline || "",
    colorHex: config.colorHex || "#00796b",
    templateId: templateId || "",
  };
}

export function loadProfileDraft(storage, fallback) {
  try {
    const parsed = JSON.parse(storage.getItem(PROFILE_DRAFT_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return { ...fallback };
    return Object.fromEntries(PROFILE_FIELDS.map(key => [key, String(parsed[key] ?? fallback[key] ?? "")]));
  } catch {
    return { ...fallback };
  }
}

export function persistProfileDraft(storage, draft) {
  const safeDraft = Object.fromEntries(PROFILE_FIELDS.map(key => [key, String(draft[key] ?? "")]));
  storage.setItem(PROFILE_DRAFT_KEY, JSON.stringify(safeDraft));
  return safeDraft;
}

export function clearProfileDraft(storage) {
  storage.removeItem(PROFILE_DRAFT_KEY);
}

export function validateProfileDraft(draft) {
  const required = [
    ["institution", "Institución"],
    ["faculty", "Facultad"],
    ["career", "Carrera"],
    ["author", "Nombre completo"],
    ["discipline", "Área del conocimiento"],
    ["templateId", "Plantilla"],
  ];
  return required
    .filter(([key]) => !String(draft[key] || "").trim())
    .map(([key, label]) => ({ key, label, fieldId: key === "templateId" ? "onb-template-group" : `onb-${key}` }));
}
