import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BASELINE_FACTS_STRONG_MODEL_FALLBACK,
  BASELINE_FACTS_STRONG_MODEL_MAX_BATCH_REQUESTS,
  BASELINE_FACTS_STRONG_MODEL_MAX_OUTPUT_TOKENS,
  baselineFactsBatchModel,
  baselineFactsEscalationDecision,
  baselineFactsGenerationConfig,
  baselineFactsMaxOutputTokensForModel,
  baselineFactsModelForSource,
  estimateBaselineFactsBatchCostUsd,
  partitionBaselineFactsEntriesByModel,
} from "./lib/baseline-facts-candidates.mjs";
import { emptyStage1ManifestSources } from "./lib/stage1-manifest-sources.mjs";
import { geminiPricePerMillion } from "./lib/gemini-batch-support.mjs";
import { GEMINI_STRONG_WORKER_MODEL, GEMINI_WORKER_MODEL } from "./lib/gemini-worker-policy.mjs";

const FLEET = "gemini-2.5-flash-lite";
const STRONG = "gemini-3.7-flash";

const worker = readFileSync(new URL("./backfill-baseline-facts.mjs", import.meta.url), "utf8");

function manifestWith(...sourceIds) {
  const manifest = emptyStage1ManifestSources();
  manifest.available = true;
  for (const id of sourceIds) manifest.sourceIds.add(id);
  return manifest;
}

function functionBody(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  if (from === -1 || to === -1) throw new Error(`Could not slice ${start} .. ${end}`);
  return text.slice(from, to);
}

describe("baseline facts model chooser", () => {
  it("routes Stage 1 manifest sources to the strong model and everything else to the fleet", () => {
    const manifest = manifestWith("stage1-source");
    expect(
      baselineFactsModelForSource({ source: { id: "stage1-source" }, manifest, fleetModel: FLEET, strongModel: STRONG }),
    ).toEqual({ model: STRONG, tier: "strong", reason: "stage1_manifest_source" });
    expect(
      baselineFactsModelForSource({ source: { id: "other-source" }, manifest, fleetModel: FLEET, strongModel: STRONG }),
    ).toEqual({ model: FLEET, tier: "fleet", reason: "fleet_source" });
  });

  it("stays on the fleet model when the manifest tables are unavailable", () => {
    const decision = baselineFactsModelForSource({
      source: { id: "stage1-source" },
      manifest: emptyStage1ManifestSources(),
      fleetModel: FLEET,
      strongModel: STRONG,
    });
    expect(decision.model).toBe(FLEET);
    expect(decision.reason).toBe("stage1_manifest_unavailable");
  });

  it("fails closed without a configured model", () => {
    expect(() =>
      baselineFactsModelForSource({ source: { id: "x" }, manifest: manifestWith(), fleetModel: "", strongModel: STRONG }),
    ).toThrow(/fleet model/);
    expect(() =>
      baselineFactsModelForSource({ source: { id: "x" }, manifest: manifestWith(), fleetModel: FLEET, strongModel: "" }),
    ).toThrow(/strong model/);
  });

  it("pins the tier models to the worker policy", () => {
    expect(GEMINI_STRONG_WORKER_MODEL).toBe("gemini-3.7-flash");
    expect(GEMINI_WORKER_MODEL).toBe("gemini-2.5-flash-lite");
    expect(BASELINE_FACTS_STRONG_MODEL_FALLBACK).toBe(GEMINI_STRONG_WORKER_MODEL);
    expect(BASELINE_FACTS_STRONG_MODEL_MAX_BATCH_REQUESTS).toBe(25);
    expect(BASELINE_FACTS_STRONG_MODEL_MAX_OUTPUT_TOKENS).toBe(4096);
    expect(worker).toContain("const geminiApiStrongModel = cleanText(GEMINI_STRONG_WORKER_MODEL) || BASELINE_FACTS_STRONG_MODEL_FALLBACK;");
  });
});

describe("partition by model", () => {
  it("groups entries per model in first-seen order so one batch targets one model", () => {
    const entries = [
      { source: { id: "a" }, model: FLEET },
      { source: { id: "b" }, model: STRONG },
      { source: { id: "c" }, model: FLEET },
    ];
    const groups = partitionBaselineFactsEntriesByModel(entries);
    expect(groups.map((group) => group.model)).toEqual([FLEET, STRONG]);
    expect(groups[0].entries.map((entry) => entry.source.id)).toEqual(["a", "c"]);
    expect(groups[1].entries.map((entry) => entry.source.id)).toEqual(["b"]);
  });

  it("refuses untiered entries", () => {
    expect(() => partitionBaselineFactsEntriesByModel([{ source: { id: "a" } }])).toThrow(/no model/);
  });

  it("derives a single batch model and rejects mixed batches", () => {
    expect(baselineFactsBatchModel([{ model: STRONG }, { model: STRONG }])).toBe(STRONG);
    expect(baselineFactsBatchModel([{}, {}], FLEET)).toBe(FLEET);
    expect(() => baselineFactsBatchModel([{ model: STRONG }, { model: FLEET }])).toThrow(/mixes models/);
    expect(() => baselineFactsBatchModel([{}])).toThrow(/no model/);
  });
});

describe("escalation selection predicate", () => {
  const stage1 = manifestWith("stage1-source");
  const base = { manifest: stage1, model: FLEET, strongModel: STRONG };

  it("escalates fleet invalid JSON on Stage 1 sources only", () => {
    expect(
      baselineFactsEscalationDecision({ ...base, outcome: "invalid_json", source: { id: "stage1-source" } }),
    ).toMatchObject({ escalate: true, trigger: "invalid_json", basis: "stage1_manifest_source" });
    expect(
      baselineFactsEscalationDecision({ ...base, outcome: "invalid_json", source: { id: "other" } }),
    ).toEqual({ escalate: false, reason: "fleet_source_invalid_json" });
  });

  it("escalates unclear relevance on Stage 1 sources", () => {
    for (const reason of ["award_relevance_unclear", "cycle_relevance_unclear"]) {
      const decision = baselineFactsEscalationDecision({
        ...base,
        outcome: "rejected",
        reason,
        facts: { award_relevance: "primary", cycle_relevance: "unclear", quality_flags: [] },
        source: { id: "stage1-source" },
      });
      expect(decision).toMatchObject({ escalate: true, trigger: reason, basis: "stage1_manifest_source" });
      expect(decision.reason).toBe(`${reason}:stage1_manifest_source`);
    }
  });

  it("escalates a fleet source whose unclear verdict would otherwise be auto-cleaned to review_later", () => {
    const decision = baselineFactsEscalationDecision({
      ...base,
      outcome: "rejected",
      reason: "award_relevance_unclear",
      facts: { award_relevance: "unclear", cycle_relevance: "current_or_upcoming", quality_flags: [] },
      source: { id: "other" },
    });
    expect(decision).toMatchObject({ escalate: true, trigger: "award_relevance_unclear", basis: "review_later_disposition" });
  });

  it("does not escalate a fleet source whose unclear cycle only needs review", () => {
    const decision = baselineFactsEscalationDecision({
      ...base,
      outcome: "rejected",
      reason: "cycle_relevance_unclear",
      facts: { award_relevance: "primary", cycle_relevance: "unclear", quality_flags: [] },
      source: { id: "other" },
    });
    expect(decision).toEqual({ escalate: false, reason: "fleet_source_needs_review_only" });
  });

  it("never escalates hard rejections, accepted results, strong-model results, or a second hop", () => {
    expect(
      baselineFactsEscalationDecision({
        ...base,
        outcome: "rejected",
        reason: "award_relevance_unrelated",
        facts: { award_relevance: "unrelated", cycle_relevance: "unclear" },
        source: { id: "stage1-source" },
      }),
    ).toEqual({ escalate: false, reason: "not_escalatable_outcome" });
    expect(
      baselineFactsEscalationDecision({
        ...base,
        outcome: "rejected",
        reason: "cycle_relevance_archived_or_past",
        facts: { award_relevance: "primary", cycle_relevance: "archived_or_past" },
        source: { id: "stage1-source" },
      }),
    ).toEqual({ escalate: false, reason: "not_escalatable_outcome" });
    expect(
      baselineFactsEscalationDecision({ ...base, outcome: "accepted", source: { id: "stage1-source" } }),
    ).toEqual({ escalate: false, reason: "not_escalatable_outcome" });
    expect(
      baselineFactsEscalationDecision({ ...base, model: STRONG, outcome: "invalid_json", source: { id: "stage1-source" } }),
    ).toEqual({ escalate: false, reason: "strong_model_result" });
    expect(
      baselineFactsEscalationDecision({
        ...base,
        outcome: "invalid_json",
        source: { id: "stage1-source" },
        escalation: { escalated_from_model: FLEET, escalation_reason: "invalid_json:stage1_manifest_source" },
      }),
    ).toEqual({ escalate: false, reason: "already_escalated" });
  });
});

describe("strong-model generation config", () => {
  it("uses low thinking with the 4096 cap and no thinkingBudget for the strong model", () => {
    const config = baselineFactsGenerationConfig({ model: STRONG, strongModel: STRONG, fleetMaxOutputTokens: 1600 });
    // Gemini 3 guidance: temperature stays at its default 1.0.
    expect(config).toEqual({
      temperature: 1,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingLevel: "low" },
      responseMimeType: "application/json",
    });
    expect(config.thinkingConfig).not.toHaveProperty("thinkingBudget");
  });

  it("keeps the fleet request unchanged with thinking off and the configured cap", () => {
    expect(baselineFactsGenerationConfig({ model: FLEET, strongModel: STRONG, fleetMaxOutputTokens: 1600 })).toEqual({
      temperature: 0.1,
      maxOutputTokens: 1600,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
    });
    expect(baselineFactsMaxOutputTokensForModel({ model: FLEET, strongModel: STRONG, fleetMaxOutputTokens: 2400 })).toBe(2400);
    expect(baselineFactsMaxOutputTokensForModel({ model: STRONG, strongModel: STRONG, fleetMaxOutputTokens: 600 })).toBe(4096);
    expect(() => baselineFactsMaxOutputTokensForModel({ model: FLEET, strongModel: STRONG, fleetMaxOutputTokens: 0 })).toThrow();
  });
});

describe("strong-model batch cost estimate", () => {
  it("prices a batch from geminiPricePerMillion batch rates with output bounded by the cap", () => {
    const rates = geminiPricePerMillion(STRONG, "batch");
    expect(Number.isFinite(rates.input)).toBe(true);
    expect(Number.isFinite(rates.output)).toBe(true);
    const estimate = estimateBaselineFactsBatchCostUsd({
      promptTokens: 1_000_000,
      requestCount: 25,
      maxOutputTokens: 4096,
      rates,
    });
    expect(estimate.input_usd).toBeCloseTo(rates.input, 6);
    expect(estimate.max_output_tokens_total).toBe(25 * 4096);
    expect(estimate.output_usd_max).toBeCloseTo(((25 * 4096) / 1_000_000) * rates.output, 6);
    expect(estimate.total_usd_max).toBeCloseTo(estimate.input_usd + estimate.output_usd_max, 6);
    expect(() => estimateBaselineFactsBatchCostUsd({ promptTokens: 1, requestCount: 1, maxOutputTokens: 1, rates: {} })).toThrow();
  });
});

describe("backfill-baseline-facts worker wiring", () => {
  it("creates each batch job against the batch's own model, never the global fleet constant", () => {
    const body = functionBody(worker, "async function createGeminiBatchJob(", "async function uploadGeminiJsonlRequests(");
    expect(body).toContain("const batchModel = cleanText(model);");
    expect(body).toContain("encodeURIComponent(\n    batchModel,\n  )}:batchGenerateContent");
    expect(body).not.toContain("encodeURIComponent(\n    geminiApiModel,");
    expect(worker).toContain("created = await createGeminiBatchJob({ requests, displayName, mode: inputMode, model });");
  });

  it("derives the batch model from the entries and threads it through the fingerprint and metadata", () => {
    const chunk = functionBody(worker, "async function processGeminiApiBatchChunk(", "function baselineFactsWorkFingerprint(");
    expect(chunk).toContain("const model = baselineFactsBatchModel(entries, geminiApiModel);");
    expect(chunk).toContain("baselineFactsWorkFingerprint(entries, model)");
    expect(chunk).toContain("logEstimatedBaselineBatchCost({ model, entries, displayName })");
    const fingerprint = functionBody(worker, "function baselineFactsWorkFingerprint(", "async function escalateBaselineFactsEntries(");
    expect(fingerprint).toContain("model: batchModel,");
    expect(fingerprint).toContain("max_output_tokens: baselineMaxOutputTokensForModel(batchModel)");
    const apply = functionBody(worker, "async function applyGeminiApiBatchResponses(", "function geminiBatchEntryForBaselineFacts(");
    expect(apply).toContain("model: entryModel,");
    expect(apply).toContain("escalated_from_model: entry.escalation.escalated_from_model,");
    expect(apply).toContain("escalation_reason: entry.escalation.escalation_reason,");
  });

  it("chooses the model per source and keeps open chunks per model", () => {
    const targets = functionBody(worker, "async function processGeminiApiBatchTargets(", "async function recoverBaselinePreCreateReservations(");
    expect(targets).toContain("baselineFactsModelForSource({");
    expect(targets).toContain("manifest: stage1Manifest,");
    expect(targets).toContain("const openChunksByModel = new Map();");
    expect(targets).toContain("geminiBatchEntryForBaselineFacts(source, capture, { model })");
    expect(worker).toContain("stage1Manifest = await loadStage1ManifestSources(supabase);");
    expect(worker).toContain("Math.min(geminiBatchMaxRequests, BASELINE_FACTS_STRONG_MODEL_MAX_BATCH_REQUESTS)");
  });

  it("only reaches rejectFactsInSupabaseSource after the escalation pass", () => {
    const apply = functionBody(worker, "async function applyGeminiApiBatchResponses(", "function geminiBatchEntryForBaselineFacts(");
    const rejectCall = apply.indexOf("await rejectFactsInSupabaseSource(");
    expect(rejectCall).toBeGreaterThan(0);
    const invalidJsonDecision = apply.indexOf('escalationDecision("invalid_json"');
    const rejectedDecision = apply.indexOf('escalationDecision("rejected", sanity.reason, facts)');
    expect(invalidJsonDecision).toBeGreaterThan(0);
    expect(rejectedDecision).toBeGreaterThan(invalidJsonDecision);
    expect(rejectedDecision).toBeLessThan(rejectCall);
    expect(apply.indexOf("if (decision.escalate) {", rejectedDecision)).toBeLessThan(rejectCall);
    expect(apply.indexOf("continue;", rejectedDecision)).toBeLessThan(rejectCall);
    // Exactly one reject call in the batch reconcile loop.
    expect(apply.indexOf("rejectFactsInSupabaseSource(", rejectCall + "await rejectFactsInSupabaseSource(".length)).toBe(-1);
    // Rejection writes stay behind --apply.
    expect(apply.slice(rejectCall - 60, rejectCall)).toContain("if (applyUpdates) {");
  });

  it("submits the strong-model escalation batch through the same batch machinery and never in dry-run", () => {
    const escalate = functionBody(worker, "async function escalateBaselineFactsEntries(", "function markEscalationRecords(");
    expect(escalate).toContain("if (!applyUpdates) {");
    expect(escalate.indexOf("if (!applyUpdates) {")).toBeLessThan(escalate.indexOf("processGeminiApiBatchChunkGroup("));
    expect(escalate).toContain("model: geminiApiStrongModel,");
    expect(escalate).toContain("escalated_from_model: entry.model || geminiApiModel,");
    expect(escalate).toContain("escalation_reason: decision.reason,");
    expect(escalate).toContain("partitionBaselineFactsEntriesByModel(entries)");
    expect(escalate).toContain("{ waitForCompletion: true }");
    expect(worker).toContain("await escalateBaselineFactsEntries(reconciliationResult.escalations, report, runId, { parentBatchName: batchName });");
    expect(worker).toContain("await escalateBaselineFactsEntries(reconciliationResult.escalations, report, runId, { parentBatchName: job.batch_name });");
  });

  it("records finishReason and usage for invalid JSON items", () => {
    const apply = functionBody(worker, "async function applyGeminiApiBatchResponses(", "function geminiBatchEntryForBaselineFacts(");
    expect(apply).toContain("const finishReason = geminiFinishReason(response);");
    expect(apply).toContain("finish_reason: finishReason,");
    expect(apply).toContain("usage,\n          outcome: `invalid_json:");
    expect(apply).toContain("...details,");
    expect(worker).toContain("response?.candidates?.[0]?.finishReason");
  });

  it("writes the escalation note into rejected page metadata too", () => {
    const reject = functionBody(worker, "async function rejectFactsInSupabaseSource(", "async function queueAwardReconciliationFromBaselineSource(");
    expect(reject).toContain("escalated_from_model: metadata.escalated_from_model,");
    expect(reject).toContain("escalation_reason: metadata.escalation_reason || null,");
  });

  it("keeps the retirement guard ahead of any runtime setup", () => {
    expect(worker.indexOf("const PAID_PROVIDER_ENTRYPOINT_RETIRED = true")).toBeLessThan(worker.indexOf("const root ="));
  });
});
