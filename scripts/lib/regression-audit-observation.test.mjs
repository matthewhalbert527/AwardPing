import { describe, expect, it } from "vitest";
import {
  canAcceptedRegressionPassResolve,
  nextRegressionAuditRetryAt,
  orderRegressionAuditCandidates,
  regressionAuditObservationKey,
  regressionEvaluationRevision,
  requireRegressionEvaluation,
  shouldRegressionStateAdvance,
} from "./regression-audit-observation.mjs";

describe("regression audit observation identity", () => {
  it("deduplicates independently generated identical evidence but not material evidence changes", () => {
    const first = auditFixture("2026-07-17T01:00:00.000Z");
    const independentlyGenerated = auditFixture("2026-07-17T02:00:00.000Z");

    expect(regressionAuditObservationKey(independentlyGenerated)).toBe(
      regressionAuditObservationKey(first),
    );

    const changedEvidence = structuredClone(independentlyGenerated);
    changedEvidence.field_conflicts[0].values[0].candidate.evidence_quote =
      "The official deadline is now October 4.";
    expect(regressionAuditObservationKey(changedEvidence)).not.toBe(
      regressionAuditObservationKey(first),
    );

    const changedCandidate = structuredClone(independentlyGenerated);
    changedCandidate.public_page_snapshot.proposed_reconciled_facts.reconciliation
      .selected_candidate_ids[0] = "candidate-2";
    expect(regressionAuditObservationKey(changedCandidate)).not.toBe(
      regressionAuditObservationKey(first),
    );

    const changedCapture = structuredClone(independentlyGenerated);
    changedCapture.field_conflicts[0].values[0].candidate.extracted_at =
      "2026-07-17T00:30:00.000Z";
    expect(regressionAuditObservationKey(changedCapture)).not.toBe(
      regressionAuditObservationKey(first),
    );

    const changedCaptureBinding = structuredClone(independentlyGenerated);
    changedCaptureBinding.field_conflicts[0].values[0].candidate.captured_at =
      "2026-07-17T00:45:00.000Z";
    expect(regressionAuditObservationKey(changedCaptureBinding)).not.toBe(
      regressionAuditObservationKey(first),
    );

    const changedSignature = structuredClone(independentlyGenerated);
    changedSignature.public_page_snapshot.reconciliation_audit_signature = "signature-2";
    expect(regressionAuditObservationKey(changedSignature)).not.toBe(
      regressionAuditObservationKey(first),
    );
  });
});

describe("regression audit poison-row rotation", () => {
  it("backs off failed attempts and lets untouched catalog rows move ahead", () => {
    const now = "2026-07-17T03:00:00.000Z";
    const poisonRows = Array.from({ length: 25 }, (_, index) => ({
      id: `poison-${String(index).padStart(2, "0")}`,
      created_at: "2026-07-01T00:00:00.000Z",
      last_attempted_at: now,
      next_retry_at: nextRegressionAuditRetryAt(now, 1),
    }));
    const untouchedRows = Array.from({ length: 30 }, (_, index) => ({
      id: `fresh-${String(index).padStart(2, "0")}`,
      created_at: `2026-07-02T00:${String(index).padStart(2, "0")}:00.000Z`,
      last_attempted_at: null,
      next_retry_at: null,
    }));

    const nextBatch = orderRegressionAuditCandidates([...poisonRows, ...untouchedRows], now).slice(0, 25);
    expect(nextBatch).toHaveLength(25);
    expect(nextBatch.every((row) => row.id.startsWith("fresh-"))).toBe(true);
  });
});

describe("immutable regression evaluation revision", () => {
  it("changes for any selected source mutation and is independent of input array order", () => {
    const { award, sources } = evaluationFixture();
    const revision = regressionEvaluationRevision(award, sources);
    expect(regressionEvaluationRevision(award, [...sources].reverse())).toBe(revision);

    const changedSource = structuredClone(sources);
    changedSource[0].page_metadata.baseline_facts.deadline = "October 4, 2027";
    expect(regressionEvaluationRevision(award, changedSource)).not.toBe(revision);

    const addedSource = structuredClone(sources);
    addedSource.push({
      ...structuredClone(sources[0]),
      id: "00000000-0000-0000-0000-000000000003",
      url: "https://example.edu/award/faq",
      page_type: "faq",
    });
    expect(regressionEvaluationRevision(award, addedSource)).not.toBe(revision);
  });

  it("changes when a relevant public award field mutates", () => {
    const { award, sources } = evaluationFixture();
    const revision = regressionEvaluationRevision(award, sources);
    const changedAward = structuredClone(award);
    changedAward.public_facts.deadline = "October 4, 2027";
    expect(regressionEvaluationRevision(changedAward, sources)).not.toBe(revision);
  });

  it("fails closed on an incomplete selector envelope", () => {
    const { award, sources } = evaluationFixture();
    const revision = regressionEvaluationRevision(award, sources);
    const selected = {
      ...award,
      regression_evaluation: {
        contract_version: "stage1-regression-evaluation-v1",
        revision,
        selected_at: "2026-07-17T01:00:00.000Z",
        source_count: sources.length,
        award,
        sources,
      },
    };
    const accepted = requireRegressionEvaluation(selected);
    expect(accepted.sources).toHaveLength(2);
    expect(() => {
      accepted.sources[0].page_metadata.baseline_facts.deadline = "mutated";
    }).toThrow();

    const incomplete = structuredClone(selected);
    incomplete.regression_evaluation.source_count = 1;
    expect(() => requireRegressionEvaluation(incomplete)).toThrow(
      /source count does not match/i,
    );
  });
});

describe("regression pass ordering", () => {
  it("never lets an older pass finishing late resolve a newer failure", () => {
    expect(canAcceptedRegressionPassResolve({
      passEvaluatedAt: "2026-07-17T01:00:00.000Z",
      blockingEvaluatedAt: "2026-07-17T02:00:00.000Z",
    })).toBe(false);
    expect(canAcceptedRegressionPassResolve({
      passEvaluatedAt: "2026-07-17T02:00:00.000Z",
      blockingEvaluatedAt: "2026-07-17T02:00:00.000Z",
    })).toBe(false);
    expect(canAcceptedRegressionPassResolve({
      passEvaluatedAt: "2026-07-17T03:00:00.000Z",
      blockingEvaluatedAt: "2026-07-17T02:00:00.000Z",
    })).toBe(true);
    expect(canAcceptedRegressionPassResolve({
      passEvaluatedAt: "2026-07-17T03:00:00.000002Z",
      blockingEvaluatedAt: "2026-07-17T03:00:00.000001Z",
    })).toBe(true);

    expect(shouldRegressionStateAdvance({
      candidateEvaluatedAt: "2026-07-17T01:00:00.000Z",
      currentEvaluatedAt: "2026-07-17T02:00:00.000Z",
      candidateBlocks: false,
      currentBlocks: true,
    })).toBe(false);
    expect(shouldRegressionStateAdvance({
      candidateEvaluatedAt: "2026-07-17T02:00:00.000Z",
      currentEvaluatedAt: "2026-07-17T02:00:00.000Z",
      candidateBlocks: false,
      currentBlocks: true,
    })).toBe(false);
    expect(shouldRegressionStateAdvance({
      candidateEvaluatedAt: "2026-07-17T02:00:00.000Z",
      currentEvaluatedAt: "2026-07-17T02:00:00.000Z",
      candidateBlocks: true,
      currentBlocks: false,
    })).toBe(true);
    expect(shouldRegressionStateAdvance({
      candidateEvaluatedAt: "2026-07-17T01:00:00.000Z",
      currentEvaluatedAt: "2026-07-17T02:00:00.000Z",
      candidateBlocks: true,
      currentBlocks: false,
    })).toBe(true);
  });
});

function auditFixture(runAt) {
  const evidenceCapturedAt = "2026-07-16T20:00:00.000Z";
  return {
    audit_kind: "regression",
    audit_status: "failed",
    severity: "critical",
    findings: [{
      code: "field_conflict",
      checked_at: evidenceCapturedAt,
    }],
    suggested_fixes: [],
    field_conflicts: [{
      field_name: "deadline",
      values: [{
        candidate: {
          id: "candidate-1",
          shared_award_source_id: "source-1",
          evidence_quote: "The official deadline is October 1.",
          captured_at: evidenceCapturedAt,
          extracted_at: evidenceCapturedAt,
        },
        source: {
          id: "source-1",
          page_metadata_generated_at: evidenceCapturedAt,
          last_checked_at: evidenceCapturedAt,
        },
      }],
    }],
    source_rejections: [{ source_id: "source-2", reason: "not_official" }],
    selected_fact_summary: {
      deadline: "October 1",
      reconciliation: { generated_at: runAt },
    },
    public_page_snapshot: {
      evaluated_at: runAt,
      capture_timestamp: evidenceCapturedAt,
      observation_key: `old-${runAt}`,
      reconciliation_audit_signature: "signature-1",
      observed_public_facts: { deadline: "October 1" },
      proposed_reconciled_facts: {
        deadline: "October 1",
        reconciliation: {
          generated_at: runAt,
          selected_candidate_ids: ["candidate-1"],
        },
      },
      observation_only: true,
      applied_to_public: false,
    },
    model: "award-fact-reconciliation",
  };
}

function evaluationFixture() {
  const awardId = "00000000-0000-0000-0000-000000000001";
  const award = {
    id: awardId,
    name: "National Example Fellowship",
    slug: "national-example-fellowship",
    official_homepage: "https://example.edu/award",
    summary: "A nationally competitive fellowship.",
    public_facts: { deadline: "October 1, 2027" },
    confidence: 0.9,
    status: "active",
  };
  const source = {
    id: "00000000-0000-0000-0000-000000000002",
    shared_award_id: awardId,
    url: "https://example.edu/award",
    title: "National Example Fellowship",
    display_title: "National Example Fellowship",
    page_description: "Official fellowship guidance.",
    page_metadata: {
      baseline_facts: {
        deadline: "October 1, 2027",
        award_relevance: "primary",
      },
    },
    page_metadata_generated_at: "2026-07-16T20:00:00.000Z",
    page_metadata_model: "fixture-model",
    page_type: "homepage",
    source: "admin",
    reason: "official source",
    submitted_by_user_id: null,
    admin_review_status: "open",
    confidence: 0.9,
  };
  return {
    award,
    sources: [
      source,
      {
        ...structuredClone(source),
        id: "00000000-0000-0000-0000-000000000004",
        url: "https://example.edu/award/apply",
        page_metadata_generated_at: null,
        page_type: "application",
      },
    ],
  };
}
