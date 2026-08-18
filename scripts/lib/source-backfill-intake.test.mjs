import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildLowCoverageSourceIntakeRequest,
  enqueueLowCoverageSourceIntakeRequests,
  isApprovedLowCoverageSourceActivation,
  isLowCoverageSourceBackfillRequest,
  openSourceRowsForCoverage,
  requiresManualBackfillSourceActivation,
  SOURCE_BACKFILL_APPROVAL_REQUEST_REASON,
  SOURCE_BACKFILL_ONBOARDING_BATCH_ID,
  SOURCE_BACKFILL_POLICY_VERSION,
  validLowCoverageBackfillEvidence,
  validateApprovedBackfillActivationReplay,
} from "./source-backfill-intake.mjs";
import {
  buildSourceIntakeProviderInputBinding,
  buildSourceIntakeProviderResultBinding,
} from "./source-intake-provider-binding.mjs";
import { buildGeminiIntakeRequest } from "./source-intake.mjs";

const award = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Marshall Scholarship",
};
const candidate = {
  url: "HTTPS://Example.org/Apply/?b=2&a=1#eligibility",
  title: "Apply for the Marshall Scholarship",
  pageType: "application",
  score: 92,
  confidence: 0.94,
  query: "Marshall Scholarship apply eligibility",
  rank: 1,
  verification: "Official program page on the sponsor domain.",
  reason: "Contains award-specific application and eligibility text.",
};

describe("low-coverage source intake", () => {
  it("counts only open sources for coverage while preserving held rows for duplicate checks", () => {
    const rows = [
      { id: "held-home", url: "https://example.org/", admin_review_status: "review_later" },
      { id: "held-apply", url: "https://example.org/apply", admin_review_status: "review_later" },
    ];
    expect(openSourceRowsForCoverage(rows)).toEqual([]);
    expect(new Set(rows.map((row) => row.url))).toEqual(new Set([
      "https://example.org/",
      "https://example.org/apply",
    ]));
    expect(openSourceRowsForCoverage([
      ...rows,
      { id: "open", url: "https://example.org/faq", admin_review_status: "open" },
    ]).map((row) => row.id)).toEqual(["open"]);
  });

  it("builds deterministic paid-review requests with manual, baseline-only onboarding provenance", () => {
    const first = buildLowCoverageSourceIntakeRequest({ award, candidate });
    const second = buildLowCoverageSourceIntakeRequest({ award, candidate });

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      matched_shared_award_id: award.id,
      submitted_url: candidate.url,
      status: "pending",
      acquisition_kind: "admin_intake",
      notification_mode: "manual_review",
      onboarding_batch_id: SOURCE_BACKFILL_ONBOARDING_BATCH_ID,
    });
    expect(first.normalized_url).toMatch(/^https:\/\/example\.org\/Apply/);
    expect(first.ai_review.backfill_discovery_evidence).toMatchObject({
      policy_version: SOURCE_BACKFILL_POLICY_VERSION,
      paid_lane: "new_page_review",
      source_activation: "manual_only",
      notification_after_approval: "baseline_only",
      matched_shared_award_id: award.id,
    });
    expect(first.ai_review.backfill_discovery_evidence.evidence_sha256).toMatch(/^[0-9a-f]{64}$/);
    const policyChanged = {
      ...first.ai_review.backfill_discovery_evidence,
      notification_after_approval: "first_capture_candidate",
    };
    expect(validLowCoverageBackfillEvidence(first.ai_review.backfill_discovery_evidence, {
      matchedAwardId: award.id,
    })).toBe(true);
    expect(validLowCoverageBackfillEvidence(policyChanged, {
      matchedAwardId: award.id,
    })).toBe(false);
    expect(first.notes).toContain("must not create/open a source or change the award official homepage automatically");
    expect(first).not.toHaveProperty("official_homepage");
    expect(first).not.toHaveProperty("shared_award_id");
    expect(requiresManualBackfillSourceActivation(first)).toBe(true);
    expect(isLowCoverageSourceBackfillRequest(first)).toBe(true);
    expect(requiresManualBackfillSourceActivation({
      ...first,
      ai_review: {},
    })).toBe(true);

    const changedAward = buildLowCoverageSourceIntakeRequest({
      award: { ...award, id: "22222222-2222-4222-8222-222222222222" },
      candidate,
    });
    expect(changedAward.id).not.toBe(first.id);
  });

  it("recognizes only an exact operator-approved award binding", () => {
    const approved = approvedRequest();
    expect(isApprovedLowCoverageSourceActivation(approved)).toBe(true);
    expect(isApprovedLowCoverageSourceActivation({
      ...approved,
      notification_mode: "manual_review",
    })).toBe(false);
    expect(isApprovedLowCoverageSourceActivation({
      ...approved,
      matched_shared_award_id: "33333333-3333-4333-8333-333333333333",
    })).toBe(false);
  });

  it("requires the request-bound, hash-bound, R2-verified capture for a free approved replay", () => {
    const request = approvedRequest();
    const capture = retainedCapture(request);
    expect(validateApprovedBackfillActivationReplay(request, capture, request.ai_review)).toMatchObject({
      retained_artifact: expect.objectContaining({
        request_id: request.id,
        file_hash: capture.capture_file_hash,
        r2_verified_at: "2026-07-17T12:01:00.000Z",
      }),
    });

    const withoutR2Proof = {
      ...capture,
      retained_artifact: { ...capture.retained_artifact, r2_verified_at: null },
    };
    expect(() => validateApprovedBackfillActivationReplay(
      request,
      withoutR2Proof,
      request.ai_review,
    )).toThrow("R2 verification timestamp");

    expect(() => validateApprovedBackfillActivationReplay(
      request,
      { ...capture, text: `${capture.text} changed` },
      request.ai_review,
    )).toThrow("do not match the immutable retained artifact");
  });

  it("treats a no-row upsert as idempotent when an exact active logical request already exists", async () => {
    const request = buildLowCoverageSourceIntakeRequest({ award, candidate });
    const supabase = sequencedSupabase([
      { data: null, error: null },
      { data: null, error: null },
      {
        data: [{
          id: "44444444-4444-4444-8444-444444444444",
          status: "pending",
          award_name: request.award_name,
          normalized_url: request.normalized_url,
        }],
        error: null,
      },
    ]);

    await expect(enqueueLowCoverageSourceIntakeRequests({
      supabase,
      requests: [request],
    })).resolves.toEqual({ enqueued: 0, alreadyPresent: 1 });
    expect(supabase.calls.some((call) => call.operations.some(
      (operation) => operation[0] === "eq" && operation[1] === "normalized_url",
    ))).toBe(true);
  });

  it("fails a no-row upsert closed when neither exact id nor active logical duplicate exists", async () => {
    const request = buildLowCoverageSourceIntakeRequest({ award, candidate });
    const supabase = sequencedSupabase([
      { data: null, error: null },
      { data: null, error: null },
      { data: [], error: null },
    ]);

    await expect(enqueueLowCoverageSourceIntakeRequests({
      supabase,
      requests: [request],
    })).rejects.toThrow("no exact id or active logical duplicate");
  });
});

function approvedRequest() {
  const request = buildLowCoverageSourceIntakeRequest({ award, candidate });
  const capture = retainedCapture(request);
  const raw = { status: "accepted", source_relevance: "primary" };
  const model = "gemini-2.5-flash-lite";
  const providerEnvelope = buildGeminiIntakeRequest(
    request,
    capture,
    request.deterministic_review,
    model,
  );
  const providerInputBinding = buildSourceIntakeProviderInputBinding({
    request,
    capture,
    deterministicReview: request.deterministic_review,
    providerEnvelope,
    model,
  });
  const providerResultBinding = buildSourceIntakeProviderResultBinding({
    request,
    capture,
    deterministicReview: request.deterministic_review,
    inputBinding: providerInputBinding,
    rawResult: raw,
    batchName: "batches/source-backfill-1",
    batchRequestKey: request.id,
    model: "gemini-2.5-flash-lite",
    acceptedAt: "2026-07-17T12:00:00.000Z",
  });
  return {
    ...request,
    status: "ai_review_succeeded",
    status_reason: SOURCE_BACKFILL_APPROVAL_REQUEST_REASON,
    notification_mode: "baseline_only",
    ai_review: {
      ...request.ai_review,
      status: "accepted",
      raw,
      completed_at: "2026-07-17T12:00:00.000Z",
      gemini_batch_name: "batches/source-backfill-1",
      gemini_batch_request_key: request.id,
      model: "gemini-2.5-flash-lite",
      provider_input_binding: providerInputBinding,
      provider_result_binding: providerResultBinding,
      manual_source_activation: {
        required: false,
        approved: true,
        approved_shared_award_id: award.id,
        approved_by: "admin@awardping.com",
        approved_at: "2026-07-17T12:02:00.000Z",
        source_registered: false,
        official_homepage_changed: false,
        notification_after_approval: "baseline_only",
        backfill_discovery_evidence_sha256:
          request.ai_review.backfill_discovery_evidence.evidence_sha256,
        provider_input_digest_sha256: providerInputBinding.digest_sha256,
        provider_result_binding_digest_sha256: providerResultBinding.digest_sha256,
        provider_result_sha256: providerResultBinding.provider_result_sha256,
      },
    },
  };
}

function retainedCapture(request) {
  const fileHash = "a".repeat(64);
  const text = "Marshall Scholarship eligibility and application guidance.";
  const textBytes = Buffer.from(`${text}\n`, "utf8");
  const prefix = `source-intake-first-observation/v1/requests/${request.id}/sha256/${fileHash}`;
  return {
    capture_file_hash: fileHash,
    byte_length: 1234,
    captured_at: "2026-07-17T12:00:00.000Z",
    canonical_url: request.normalized_url,
    final_url: request.normalized_url,
    content_type: "text/html; charset=utf-8",
    text,
    retained_artifact: {
      schema_version: 1,
      namespace: "source-intake-first-observation",
      request_id: request.id,
      captured_at: "2026-07-17T12:00:00.000Z",
      final_url: request.normalized_url,
      prefix,
      file_hash: fileHash,
      file_bytes: 1234,
      document_content_type: "text/html; charset=utf-8",
      text_hash: sha256(text),
      text_length: text.length,
      r2_bucket: "awardping-artifacts",
      r2_store_id: "account.r2.cloudflarestorage.com",
      r2_verified_at: "2026-07-17T12:01:00.000Z",
      artifacts: {
        pdf: {
          key: `${prefix}/document.pdf`,
          sha256: fileHash,
          byte_length: 1234,
          content_type: "text/html; charset=utf-8",
        },
        text: {
          key: `${prefix}/text.txt`,
          sha256: sha256(textBytes),
          byte_length: textBytes.length,
          content_type: "text/plain; charset=utf-8",
        },
        capture_metadata: {
          key: `${prefix}/capture.json`,
          sha256: "d".repeat(64),
          byte_length: 456,
          content_type: "application/json",
        },
      },
    },
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sequencedSupabase(responses) {
  const queue = [...responses];
  const calls = [];
  const next = () => {
    if (!queue.length) throw new Error("Unexpected Supabase query");
    return Promise.resolve(queue.shift());
  };
  return {
    calls,
    from(table) {
      const call = { table, operations: [] };
      calls.push(call);
      const builder = {
        upsert(...args) { call.operations.push(["upsert", ...args]); return builder; },
        select(...args) { call.operations.push(["select", ...args]); return builder; },
        eq(...args) { call.operations.push(["eq", ...args]); return builder; },
        in(...args) { call.operations.push(["in", ...args]); return builder; },
        order(...args) { call.operations.push(["order", ...args]); return builder; },
        limit(...args) { call.operations.push(["limit", ...args]); return builder; },
        maybeSingle() { return next(); },
        then(resolve, reject) { return next().then(resolve, reject); },
      };
      return builder;
    },
  };
}
