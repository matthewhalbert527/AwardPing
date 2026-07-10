export const GEMINI_WORKER_MODEL = "gemini-2.5-flash-lite";

export function geminiWorkerModel() {
  return GEMINI_WORKER_MODEL;
}

export function normalizeGeminiBatchMode(value, { allowNone = false, context = "Gemini worker" } = {}) {
  const normalized = String(value || "batch").trim().toLowerCase();
  if (normalized === "batch") return "batch";
  if (allowNone && normalized === "none") return "none";
  const allowed = allowNone ? "batch or none" : "batch";
  throw new Error(`${context} must use Gemini API mode ${allowed}; received "${normalized || "empty"}".`);
}
