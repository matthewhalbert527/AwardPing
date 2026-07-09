const aiSourceQualityModes = new Set([
  "ai",
  "gemini",
  "gemini-cli",
  "openai",
  "antigravity",
  "agy",
  "llm",
]);

function cleanMode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

export function sourceQualityModeRequiresAi(mode) {
  return aiSourceQualityModes.has(cleanMode(mode));
}

export function runRequiresAiFromOptions(options = {}) {
  const visualReviewMode = cleanMode(options.visualReviewMode);

  if (visualReviewMode === "immediate") return true;
  if (options.extractBaselineInfo) return true;
  if (options.backfillBaselineInfo) return true;
  if (options.submitsAiBatch || options.processesAiBatch || options.batchProcessor) return true;
  if (sourceQualityModeRequiresAi(options.sourceQualityMode)) return true;

  return false;
}

export function aiDisabledReasonForOptions(options = {}) {
  const reasons = [];
  const visualReviewMode = cleanMode(options.visualReviewMode);

  if (visualReviewMode === "none" || !visualReviewMode) {
    reasons.push("visual_review_disabled");
  } else if (visualReviewMode === "batch") {
    reasons.push("visual_review_batch_enqueue_only");
  }

  if (!options.extractBaselineInfo) reasons.push("baseline_extraction_disabled");
  if (!options.backfillBaselineInfo) reasons.push("baseline_backfill_disabled");
  if (options.localizationRepair) reasons.push("localization_repair");
  if (options.r2SnapshotSync || options.r2RepairMissingSnapshots || options.r2BackfillBaselines) {
    reasons.push("r2_capture_or_repair");
  }

  return reasons.length ? reasons.join(",") : "no_ai_calling_workflow_enabled";
}

export function selectAiProvider(requestedProvider, keys = {}) {
  const requested = cleanMode(requestedProvider || "auto");
  if (["gemini-cli", "antigravity", "agy"].includes(requested)) return keys.geminiCli ? "gemini-cli" : null;
  if (requested === "gemini") return keys.gemini ? "gemini" : null;
  if (requested === "openai") return keys.openai ? "openai" : null;
  if (requested !== "auto") return null;
  if (keys.gemini) return "gemini";
  if (keys.openai) return "openai";
  if (keys.geminiCli) return "gemini-cli";
  return null;
}

export function missingAiProviderMessage(requestedProvider) {
  const requested = cleanMode(requestedProvider || "auto");
  if (["gemini-cli", "antigravity", "agy"].includes(requested)) {
    return "AWARDPING_GEMINI_CLI_PATH must point to agy.exe when --ai-provider=gemini-cli. AI is required by this run's options; refusing to run.";
  }
  if (requested === "gemini") {
    return "GEMINI_API_KEY is required when --ai-provider=gemini. AI is required by this run's options; refusing to run.";
  }
  if (requested === "openai") {
    return "OPENAI_API_KEY is required when --ai-provider=openai. AI is required by this run's options; refusing to run.";
  }
  return "GEMINI_API_KEY, OPENAI_API_KEY, or AWARDPING_GEMINI_CLI_PATH is required by this run's options; refusing to run.";
}
