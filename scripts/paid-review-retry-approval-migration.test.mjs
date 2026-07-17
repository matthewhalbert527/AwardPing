import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717010000_paid_review_retry_approval.sql",
    import.meta.url,
  ),
  "utf8",
);
const worker = readFileSync(
  new URL("./process-visual-review-batch.mjs", import.meta.url),
  "utf8",
);

describe("paid review retry approval migration", () => {
  it("stores one-use exact-failure approvals for both paid lanes", () => {
    expect(migration).toContain("create table public.gemini_paid_retry_approvals");
    expect(migration).toContain("'new_page_review', 'changed_page_review'");
    expect(migration).toContain("candidate_updated_at timestamptz not null");
    expect(migration).toContain("failure_fingerprint text not null");
    expect(migration).toContain("approved_request_fingerprint text not null");
    expect(migration).toContain("authorized_provider_request_fingerprint text check");
    expect(migration).toContain("provider_request_bound_at timestamptz");
    expect(migration).toContain("where status = 'approved'");
    expect(migration).toContain("expires_at <= approved_at + interval '24 hours'");
  });

  it("atomically consumes approval and requeues exactly one candidate version", () => {
    const consume = migration.slice(
      migration.indexOf("create or replace function public.consume_visual_review_paid_retry_approval("),
    );
    expect(consume).toContain("for update;");
    expect(consume).toContain("approval.failure_fingerprint = v_failure_fingerprint");
    expect(consume).toContain("approval.approved_request_fingerprint = v_request_fingerprint");
    expect(consume).toContain("status = 'pending'");
    expect(consume).toContain("status = 'consumed'");
    expect(consume).toContain("set status = 'revoked'");
    expect(consume).toContain("candidate.updated_at = p_expected_candidate_updated_at");
    expect(consume).toContain("paid_retry_approved_request_fingerprint");
    expect(consume).toContain("paid_retry_approved_candidate_signature");
    expect(consume).toContain("paid_retry_approved_batch_request_key");
    expect(consume).toContain("paid_retry_approved_lane_key");
    expect(worker).toContain('"consume_visual_review_paid_retry_approval"');
    expect(worker).toContain('.from("gemini_paid_retry_approvals")');
    expect(worker).toContain('.eq("status", "approved")');
    expect(worker).not.toContain(
      '.from("shared_award_visual_review_candidates")\n    .select("*")\n    .eq("status", "failed")',
    );
    expect(worker).not.toContain('reason: "ordinary_failure_retryable"');
  });

  it("keeps no-charge provider recovery separate and blocks ambiguous resubmission", () => {
    expect(migration).toContain("'missing_batch_response'");
    expect(migration).toContain(
      "'manual_recovery_required_possible_external_batch_created'",
    );
    expect(worker).toContain("requeueRetryableFailures");
    expect(worker).toContain("paid_retry_approvals_required");
    expect(migration).toContain("') >= 3 then true'");
    expect(migration).toContain("') >= 0 then true'");
    expect(migration).toContain("paid_retry_approval_required");
    expect(migration).toContain(
      "public.list_monitoring_downstream_lane_status()",
    );
    expect(migration).toContain(
      "and lower(pg_catalog.btrim(coalesce(candidate.rejection_reason, ''))) =",
    );
  });

  it("exposes mutations only through service-role RPCs", () => {
    expect(migration).toContain(
      "revoke all on table public.gemini_paid_retry_approvals",
    );
    expect(migration).toContain(
      "grant execute on function public.approve_visual_review_paid_retry(",
    );
    expect(migration).toContain(
      "grant execute on function public.consume_visual_review_paid_retry_approval(",
    );
    expect(migration).toContain(
      "grant execute on function public.authorize_visual_review_paid_retry_submission(",
    );
    expect(migration).toContain(
      "grant execute on function public.invalidate_visual_review_paid_retry_for_request_drift(",
    );
    expect(migration).not.toMatch(/grant (?:insert|update|delete|all) on table public\.gemini_paid_retry_approvals to service_role/i);
  });

  it("binds approval to all request evidence and invalidates policy/source drift", () => {
    const fingerprint = migration.slice(
      migration.indexOf("create or replace function private.visual_review_paid_request_fingerprint("),
      migration.indexOf("create or replace function public.approve_visual_review_paid_retry("),
    );
    for (const field of [
      "candidate_signature",
      "gemini_batch_request_key",
      "candidate_scope",
      "shared_award_id",
      "shared_award_source_id",
      "source_acquisition_id",
      "source_url",
      "previous_snapshot_ref",
      "new_snapshot_ref",
      "previous_text_hash",
      "new_text_hash",
      "previous_image_hash",
      "new_image_hash",
      "previous_file_hash",
      "new_file_hash",
      "deterministic_diff",
      "deterministic_classification",
      "prompt_payload",
      "prompt_context",
    ]) {
      expect(fingerprint).toContain(`'${field}'`);
    }
    const invalidation = migration.slice(
      migration.indexOf("create or replace function public.invalidate_visual_review_paid_retry_for_request_drift("),
      migration.indexOf("create or replace function private.enforce_visual_review_paid_retry_transition("),
    );
    expect(invalidation).toContain("candidate_signature = p_candidate_signature");
    expect(invalidation).toContain("prompt_payload = p_prompt_payload");
    expect(invalidation).toContain("status = 'failed'");
    expect(invalidation).toContain("paid_retry_approval_request_drift");
    expect(worker).toContain('"invalidate_visual_review_paid_retry_for_request_drift"');
    expect(worker).toContain("return null;");
  });

  it("rechecks exact lane, request, claim, and unexpired approval before every charge", () => {
    const authorize = migration.slice(
      migration.indexOf("create or replace function public.authorize_visual_review_paid_retry_submission("),
      migration.indexOf("create or replace function public.invalidate_visual_review_paid_retry_for_request_drift("),
    );
    expect(authorize).toContain("v_candidate.status <> 'processing'");
    expect(authorize).toContain("p_submission_claim_token::text");
    expect(authorize).toContain("v_approval.status <> 'consumed'");
    expect(authorize).toContain("v_approval.expires_at <= v_now");
    expect(authorize).toContain("paid_retry_lane_mismatch");
    expect(authorize).toContain("private.visual_review_paid_request_fingerprint(v_candidate)");
    expect(authorize).toContain("p_expected_provider_request_fingerprint");
    expect(authorize).toContain("paid_retry_provider_request_drift");
    expect(authorize).toContain("authorized_provider_request_fingerprint =");

    const submit = worker.slice(
      worker.indexOf("async function submitCandidateChunk("),
      worker.indexOf("async function persistSubmittedClaim("),
    );
    expect(submit).toContain('stage: "before_spend_reservation"');
    expect(submit).toContain('stage: "before_provider_create"');
    expect(submit.indexOf('stage: "before_spend_reservation"')).toBeLessThan(
      submit.indexOf("reserveGeminiSpend({"),
    );
    expect(submit.indexOf("markSubmissionClaimsCreateStarted(")).toBeLessThan(
      submit.indexOf('stage: "before_provider_create"'),
    );
    expect(submit).toContain("provider_create_not_reached:paid_retry_authorization_failed");
    expect(submit).toContain('expectedStatus: "creating"');
    expect(worker).toContain("runPaidVisualProviderCreateBoundary({");
    expect(worker).toContain("paidVisualProviderRequestFingerprint({");
    expect(worker).toContain("fileToVerifiedInlineGeminiPart");
    expect(submit).toContain("laneKey,");
    expect(submit).not.toContain("GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW");
  });

  it("prevents counter-only failed-to-pending transitions", () => {
    expect(migration).toContain("private.enforce_visual_review_paid_retry_transition()");
    expect(migration).toContain("old.status = 'failed' and new.status = 'pending'");
    expect(migration).toContain("awardping.paid_retry_approval_id");
    expect(migration).toContain("rejection_reason = 'paid_retry_approval_required'");
  });

  it("validates immutable image bytes before spend reservation or provider POST", () => {
    const submit = worker.slice(
      worker.indexOf("async function submitCandidateChunk("),
      worker.indexOf("async function persistSubmittedClaim("),
    );
    expect(submit).toContain("geminiBatchRequestForCandidate(candidate)");
    expect(submit).toContain("failVisualProviderRequestEvidence(");
    expect(submit.indexOf("geminiBatchRequestForCandidate(candidate)")).toBeLessThan(
      submit.indexOf("reserveGeminiSpend({"),
    );
    expect(submit.indexOf("failVisualProviderRequestEvidence(")).toBeLessThan(
      submit.indexOf("reserveGeminiSpend({"),
    );
    expect(worker).toContain('rejection_reason: "provider_request_evidence_invalid"');
  });

  it("reports and schedules initial documents in the new-page lane only", () => {
    expect(migration).toContain(
      "candidate.candidate_scope = 'initial_official_document'",
    );
    expect(migration).toContain(
      "candidate.candidate_scope <> 'initial_official_document'",
    );
    expect(worker).toContain("applyPaidLaneCandidateScopeFilter(");
    expect(worker).toContain("GEMINI_PAID_LANES.NEW_PAGE_REVIEW");
    expect(worker).toContain("GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW");
    expect(worker).toContain('.eq("candidate_scope", INITIAL_OFFICIAL_DOCUMENT_SCOPE)');
    expect(worker).toContain('.neq("candidate_scope", INITIAL_OFFICIAL_DOCUMENT_SCOPE)');
  });
});
