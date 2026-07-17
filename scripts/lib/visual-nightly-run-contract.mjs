export const NIGHTLY_VISUAL_DISCOVERY_INTENT = "live_recurring";

const REPAIR_OPTION_KEYS = Object.freeze([
  "baseline_refresh",
  "complete_missing_baselines",
  "ai_review_evidence_capture",
  "localization_repair",
  "r2_backfill_baselines",
  "reset_previous_snapshot",
  "force_r2_snapshot_refresh",
]);

const TARGETED_OPTION_KEYS = Object.freeze([
  "source_id",
  "source_url",
  "award",
  "source_ids_filter_count",
  "initial_official_document_materialization",
  "initial_official_document_acquisition_id",
]);

const PARTIAL_OPTION_KEYS = Object.freeze([
  "pdf_only",
  "web_only",
  "skip_existing_baseline",
]);

/**
 * One cross-runtime contract for identifying the permanent scheduled 6 PM scan.
 * Keep this module dependency-free so both the local Node worker and the Next.js
 * server bundle can evaluate exactly the same rules.
 */
export function classifyScheduledNightlyVisualRun(input = {}) {
  const runIdentity = objectValue(input.runIdentity);
  const options = objectValue(input.options);
  const trigger = cleanKey(runIdentity.trigger || options.run_trigger);

  if (trigger !== "scheduled") {
    return classification(false, "not_scheduled");
  }

  const repairOption = REPAIR_OPTION_KEYS.find((key) => flagEnabled(options[key]));
  if (repairOption) return classification(false, "repair_run", repairOption);

  const targetedOption = TARGETED_OPTION_KEYS.find((key) => optionSet(options[key]));
  if (targetedOption) return classification(false, "targeted_run", targetedOption);

  const partialOption = PARTIAL_OPTION_KEYS.find((key) => flagEnabled(options[key]));
  if (partialOption) return classification(false, "partial_scan", partialOption);
  if (!flagEnabled(options.include_not_due)) {
    return classification(false, "partial_scan", "include_not_due");
  }
  if (nonNegativeNumber(options.limit) < 50_000) {
    return classification(false, "partial_scan", "limit");
  }

  const discoveryIntent = cleanKey(options.discovery_intent);
  const onboardingBatchId = cleanText(options.discovery_onboarding_batch_id);
  if (discoveryIntent === "historical_onboarding" || onboardingBatchId) {
    return classification(
      false,
      "historical_onboarding",
      onboardingBatchId ? "discovery_onboarding_batch_id" : "discovery_intent",
    );
  }

  if (!flagEnabled(options.discovery_mode) || discoveryIntent !== NIGHTLY_VISUAL_DISCOVERY_INTENT) {
    return classification(false, "unsupported_discovery_intent", "discovery_intent");
  }

  return classification(true, "scheduled_live_recurring_discovery");
}

export function isScheduledNightlyVisualRun(input = {}) {
  return classifyScheduledNightlyVisualRun(input).eligible;
}

function classification(eligible, reason, option = null) {
  return { eligible, reason, option };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanKey(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function flagEnabled(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  return ["1", "true", "yes", "on"].includes(cleanKey(value));
}

function optionSet(value) {
  if (typeof value === "string") return Boolean(value.trim());
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function nonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
