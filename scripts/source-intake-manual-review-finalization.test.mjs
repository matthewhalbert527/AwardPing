import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeGeminiIntakeResult,
  validateIntakeAiDecision,
} from "./lib/source-intake.mjs";

// Execute only this locally inspected function, never the worker entrypoint.
// Binding implementations are stubbed here: their cryptographic/retention
// contracts have separate tests. This suite covers disposition and side effects.
const worker = readFileSync(new URL("./process-source-intake-requests.mjs", import.meta.url), "utf8");
const start = worker.indexOf("async function finalizeReviewedRequest(");
const end = worker.indexOf("\nasync function finalizeLiveFirstCaptureManualReview(", start);
if (start < 0 || end <= start) throw new Error("Missing bounded intake finalizer");
const finalizerSource = worker.slice(start, end);

const accepted = {
  status: "accepted",
  detected_award_name: "Example Fellowship",
  detected_sponsor: "Example Foundation",
  source_relevance: "primary",
  cycle_relevance: "current_or_upcoming",
  page_type: "application",
  officialness: "official",
  confidence: "high",
  evidence_quotes: ["Example Fellowship applications close March 1, 2027."],
  facts: { deadline: "March 1, 2027" },
};

function harness({ apply = true, bindingError = false } = {}) {
  const report = { needs_manual_review: 0, ai_review_rejected: 0, rejected: 0 };
  const inputBinding = { fixture: "validated-input" };
  const resultBinding = { fixture: "validated-result" };
  const row = {
    id: "request-fixture",
    status: "ai_review_succeeded",
    ai_review: {
      gemini_batch_name: "batch-fixture",
      gemini_batch_request_key: "request-fixture",
      model: "model-fixture",
      provider_input_binding: inputBinding,
    },
  };
  const validateInput = vi.fn(() => {
    if (bindingError) throw new Error("fixture binding mismatch");
    return inputBinding;
  });
  const buildResult = vi.fn(() => resultBinding);
  const validateReplay = vi.fn(() => {
    if (bindingError) throw new Error("fixture binding mismatch");
    return { inputBinding, resultBinding };
  });
  const update = vi.fn(async () => row);
  // Stop positive controls at award resolution; no registration is simulated.
  const resolveAward = vi.fn(async () => ({ award: null, reason: "fixture_no_match" }));
  const registerSource = vi.fn(() => { throw new Error("Unexpected source registration"); });
  const persistFacts = vi.fn(() => { throw new Error("Unexpected fact persistence"); });
  const reconcile = vi.fn(() => { throw new Error("Unexpected reconciliation"); });
  const finalize = runInNewContext(`(${finalizerSource})`, {
    normalizeGeminiIntakeResult,
    validateIntakeAiDecision,
    objectValue: (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {},
    validateSourceIntakeProviderInputBinding: validateInput,
    buildSourceIntakeProviderResultBinding: buildResult,
    validateSourceIntakeProviderReplayBinding: validateReplay,
    requireOwnedRequestUpdate: update,
    resolveAwardForRequest: resolveAward,
    registerAcceptedSource: registerSource,
    persistSourceIntakeFactCandidates: persistFacts,
    enqueueAwardReconciliation: reconcile,
    report,
    apply,
  });
  return { finalize, row, report, update, resolveAward, registerSource, persistFacts, reconcile,
    validateInput, buildResult, validateReplay, inputBinding, resultBinding };
}

for (const mode of ["provider_result", "replay"]) {
  describe(`manual-review disposition in ${mode} finalization`, () => {
    for (const [label, facts, field] of [
      ["object description", { description: { text: "Example award" } }, "description"],
      ["unstringifiable description", { description: { toString: "not callable" } }, "description"],
      ["array description", { description: ["Example award"] }, "description"],
      ["object deadline", { deadline: { date: "2027-03-01" } }, "deadline"],
      ["unstringifiable deadline", { deadline: { toString: null } }, "deadline"],
      ["array deadline", { deadline: ["March 1", "March 15"] }, "deadline"],
      ["numeric amount", { amount: 5000 }, "amount"],
      ["unstringifiable amount", { amount: { toString: 5 } }, "amount"],
      ["false amount before valid alias", { amount: false, award_amount: "$5,000" }, "amount"],
      ["zero amount before valid alias", { amount: 0, award_amount: "$5,000" }, "amount"],
      ["empty array amount", { amount: [], award_amount: "$5,000" }, "amount"],
      ["object alias", { amount: null, award_amount: { amount: 5000 } }, "award_amount"],
      ["array alias", { amount: "", award_amount: ["$5,000"] }, "award_amount"],
      ["array facts container", [], "facts"],
      ["string facts container", "March 1", "facts"],
    ]) {
      it(`holds ${label} without replacing existing source or fact data`, async () => {
        const h = harness();
        // A provider-supplied raw field cannot hide the actual malformed facts.
        const rawResult = { ...accepted, facts, raw: { ...accepted } };
        await h.finalize(h.row, {}, {}, rawResult, { providerResultMode: mode });
        expect(h.update).toHaveBeenCalledTimes(1);
        expect(h.update.mock.calls[0][2]).toMatchObject({
          status: "needs_manual_review", status_reason: `invalid_fact_type_${field}`, worker_run_id: null,
          ai_review: { raw: rawResult, provider_input_binding: h.inputBinding, provider_result_binding: h.resultBinding },
        });
        expect(h.report).toEqual({ needs_manual_review: 1, ai_review_rejected: 0, rejected: 0 });
        expect(h.resolveAward).not.toHaveBeenCalled();
        expect(h.registerSource).not.toHaveBeenCalled();
        expect(h.persistFacts).not.toHaveBeenCalled();
        expect(h.reconcile).not.toHaveBeenCalled();
      });
    }

    it("keeps valid scalar precedence and strings unchanged", async () => {
      const h = harness();
      const rawResult = {
        ...accepted,
        facts: { description: null, deadline: "March 1; March 15", amount: "$5,000", award_amount: { unused: true } },
      };
      await h.finalize(h.row, {}, {}, rawResult, { providerResultMode: mode });
      expect(h.resolveAward).toHaveBeenCalledTimes(1);
      expect(h.update.mock.calls[0][2]).toMatchObject({ status: "matching", ai_review: { raw: rawResult } });
    });

    it.each([
      ["explicit rejection", { status: "rejected", rejection_reason: "Not this award" }, "rejected", "Not this award"],
      ["missing evidence", { evidence_quotes: [] }, "needs_manual_review", "missing_evidence_quotes"],
      ["low confidence", { confidence: "low" }, "needs_manual_review", "confidence_low"],
      ["unresolved status", { status: "needs_review" }, "needs_manual_review", "ai_status_needs_review"],
    ])("preserves %s precedence over a malformed scalar", async (_label, fields, status, reason) => {
      const h = harness();
      const rawResult = { ...accepted, ...fields, facts: { deadline: { date: "2027-03-01" } } };
      await h.finalize(h.row, {}, {}, rawResult, { providerResultMode: mode });
      expect(h.update).toHaveBeenCalledTimes(1);
      expect(h.update.mock.calls[0][2]).toMatchObject({ status, status_reason: reason, ai_review: { raw: rawResult } });
      expect(h.resolveAward).not.toHaveBeenCalled();
      expect(h.registerSource).not.toHaveBeenCalled();
      expect(h.persistFacts).not.toHaveBeenCalled();
      expect(h.reconcile).not.toHaveBeenCalled();
    });

    for (const [field, token, reason] of [
      ["source_relevance", "primary", "source_relevance_unclear"],
      ["cycle_relevance", "current_or_upcoming", "cycle_relevance_unclear"],
      ["officialness", "official", "officialness_unclear"],
      ["confidence", "high", "confidence_low"],
    ]) {
      for (const [label, malformed] of [
        ["array", [token]],
        ["punctuation", `${token}?`],
        ["NUL", `${token.slice(0, 1)}\u0000${token.slice(1)}`],
      ]) {
        it(`keeps ${field} ${label} manual before matching or persistence`, async () => {
          const h = harness();
          const rawResult = { ...accepted, [field]: malformed };
          await h.finalize(h.row, {}, {}, rawResult, { providerResultMode: mode });
          expect(h.update).toHaveBeenCalledTimes(1);
          expect(h.update.mock.calls[0][2]).toMatchObject({
            status: "needs_manual_review", status_reason: reason, worker_run_id: null,
            ai_review: { raw: rawResult, provider_input_binding: h.inputBinding, provider_result_binding: h.resultBinding },
          });
          expect(h.report).toEqual({ needs_manual_review: 1, ai_review_rejected: 0, rejected: 0 });
          expect(h.resolveAward).not.toHaveBeenCalled();
          expect(h.registerSource).not.toHaveBeenCalled();
          expect(h.persistFacts).not.toHaveBeenCalled();
          expect(h.reconcile).not.toHaveBeenCalled();
          expect(mode === "replay" ? h.validateReplay : h.validateInput).toHaveBeenCalledTimes(1);
        });
      }
    }

    for (const [label, status] of [
      ["explicit needs_review", "needs_review"],
      ["missing status", undefined],
      ["null status", null],
      ["unknown status", "looks_good"],
      ["empty status", ""],
      ["object status", {}],
      ["array containing accepted", ["accepted"]],
      ["punctuated acceptance", "accepted?"],
      ["punctuated rejection", "rejected?"],
      ["embedded null acceptance", "ac\u0000cepted"],
      ["boolean status", true],
    ]) {
      it(`keeps ${label} manual despite otherwise strong signals`, async () => {
        const h = harness();
        const rawResult = { ...accepted, status, manual_review_reason: "Confirm the application cycle." };
        await h.finalize(h.row, {}, {}, rawResult, { providerResultMode: mode });
        expect(h.update).toHaveBeenCalledTimes(1);
        expect(h.update.mock.calls[0].slice(0, 2)).toEqual([h.row.id, "ai_review_succeeded"]);
        expect(h.update.mock.calls[0][2]).toMatchObject({
          status: "needs_manual_review",
          worker_run_id: null,
          ai_review: { raw: rawResult, provider_input_binding: h.inputBinding, provider_result_binding: h.resultBinding },
        });
        expect(h.report).toEqual({ needs_manual_review: 1, ai_review_rejected: 0, rejected: 0 });
        expect(h.resolveAward).not.toHaveBeenCalled();
        expect(h.registerSource).not.toHaveBeenCalled();
        expect(h.persistFacts).not.toHaveBeenCalled();
        expect(h.reconcile).not.toHaveBeenCalled();
        expect(mode === "replay" ? h.validateReplay : h.validateInput).toHaveBeenCalledTimes(1);
      });
    }

    it("still lets explicitly accepted evidence reach award matching", async () => {
      const h = harness();
      await h.finalize(h.row, {}, {}, accepted, { providerResultMode: mode });
      expect(h.resolveAward).toHaveBeenCalledTimes(1);
      expect(h.update.mock.calls[0][2]).toMatchObject({ status: "matching" });
      expect(h.update.mock.calls[1][2]).toMatchObject({ status: "needs_manual_review", status_reason: "fixture_no_match" });
    });

    it("keeps explicit rejection terminal", async () => {
      const h = harness();
      await h.finalize(h.row, {}, {}, { ...accepted, status: "rejected", rejection_reason: "Sibling program" }, { providerResultMode: mode });
      expect(h.update).toHaveBeenCalledTimes(1);
      expect(h.update.mock.calls[0][2]).toMatchObject({ status: "rejected", status_reason: "Sibling program" });
      expect(h.report).toEqual({ needs_manual_review: 0, ai_review_rejected: 1, rejected: 1 });
      expect(h.resolveAward).not.toHaveBeenCalled();
    });

    it("does not write or match when a retained binding fails", async () => {
      const h = harness({ bindingError: true });
      await expect(h.finalize(h.row, {}, {}, { ...accepted, status: "needs_review" }, { providerResultMode: mode }))
        .rejects.toThrow("fixture binding mismatch");
      expect(h.update).not.toHaveBeenCalled();
      expect(h.resolveAward).not.toHaveBeenCalled();
      expect(h.report.needs_manual_review).toBe(0);
    });

    it("counts a manual dry run without writing or matching", async () => {
      const h = harness({ apply: false });
      await h.finalize(h.row, {}, {}, { ...accepted, status: "needs_review" }, { providerResultMode: mode });
      expect(h.report.needs_manual_review).toBe(1);
      expect(h.update).not.toHaveBeenCalled();
      expect(h.resolveAward).not.toHaveBeenCalled();
    });
  });
}

it("does not permit an unspecified provider-result mode", async () => {
  const h = harness();
  await expect(h.finalize(h.row, {}, {}, { ...accepted, status: "needs_review" }))
    .rejects.toThrow("explicit provider-result binding mode");
  expect(h.update).not.toHaveBeenCalled();
  expect(h.resolveAward).not.toHaveBeenCalled();
});

describe.each(["description", "deadline", "amount", "award_amount"])("wrong-type %s display preparation", (field) => {
  it.each([
    ["object", { text: "a proposed fact" }],
    ["array", ["March 1", "March 15"]],
    ["own toString property", { toString: null }],
    ["number", 5000],
    ["boolean", true],
  ])("does not stringify a %s and retains the original typed response", (_label, value) => {
    const raw = { ...accepted, facts: { [field]: value } };
    const normalized = normalizeGeminiIntakeResult(raw);
    expect(normalized.facts[field === "award_amount" ? "amount" : field]).toBeNull();
    expect(JSON.parse(JSON.stringify(normalized.raw))).toEqual(raw);
    expect(validateIntakeAiDecision(raw)).toEqual({
      accepted: false, manual: true, reason: `invalid_fact_type_${field}`,
    });
  });
});
