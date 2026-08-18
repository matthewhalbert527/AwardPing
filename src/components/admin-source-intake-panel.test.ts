import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AdminSourceIntakePanel,
  sourceIntakeActionRequiresPaidRetryConfirmation,
  type SourceIntakeRequestView,
} from "@/components/admin-source-intake-panel";

describe("admin source intake reconciliation retry", () => {
  it("requires explicit confirmation only for actions that may create a new paid review", () => {
    expect(sourceIntakeActionRequiresPaidRetryConfirmation("retry")).toBe(true);
    expect(sourceIntakeActionRequiresPaidRetryConfirmation("rerun_capture")).toBe(true);
    expect(sourceIntakeActionRequiresPaidRetryConfirmation("rerun_ai_review")).toBe(true);
    expect(sourceIntakeActionRequiresPaidRetryConfirmation("retry_reconciliation")).toBe(false);
    expect(sourceIntakeActionRequiresPaidRetryConfirmation("approve_backfill_source")).toBe(false);
    expect(sourceIntakeActionRequiresPaidRetryConfirmation("attach_to_award")).toBe(false);
    expect(sourceIntakeActionRequiresPaidRetryConfirmation("reject")).toBe(false);
  });

  it("offers only the free replay when capture and accepted review are verified", () => {
    const html = renderRequest(reconciliationRequest());

    expect(html).toContain("Replay retained result - $0");
    expect(html).toContain("No page fetch or AI charge");
    expect(html).not.toContain(">Attach<");
    expect(html).not.toContain(">Retry<");
    expect(html).not.toContain(">Rerun AI<");
  });

  it("keeps accepted review with missing evidence manual-only", () => {
    const request = reconciliationRequest();
    request.capture_metadata = {};
    const html = renderRequest(request);

    expect(html).toContain("accepted AI result exists without a completed verified capture");
    expect(html).not.toContain("Replay retained result - $0");
    expect(html).not.toContain(">Attach<");
    expect(html).not.toContain(">Retry<");
    expect(html).not.toContain(">Rerun AI<");
    expect(html).toContain(">Reject<");
  });

  it("offers capture retry before any capture or provider result and discloses charge/refetch", () => {
    const request = reconciliationRequest();
    request.status_reason = "initial_capture_failed_closed";
    request.ai_review = {};
    request.capture_metadata = {};
    const html = renderRequest(request);

    expect(html).toContain("Retry capture + review");
    expect(html).toContain("page will be fetched again");
    expect(html).toContain("may create a charge");
    expect(html).not.toContain(">Attach<");
    expect(html).not.toContain(">Rerun AI<");
  });

  it("offers exact staged-capture resume before review and discloses possible charge", () => {
    const request = reconciliationRequest();
    request.status_reason = "intake_r2_upload_failed";
    request.ai_review = {};
    request.capture_metadata = stagedCaptureMetadata(request.capture_metadata);
    const html = renderRequest(request);

    expect(html).toContain("Resume saved capture + review");
    expect(html).toContain("Resume the exact saved capture");
    expect(html).toContain("will not be fetched again");
    expect(html).toContain("may create a charge");
    expect(html).not.toContain(">Attach<");
    expect(html).not.toContain(">Rerun AI<");
  });

  it("offers AI-only review for a completed retained capture without an accepted result", () => {
    const request = reconciliationRequest();
    request.status_reason = "prior_review_rejected_safely";
    request.ai_review = {};
    const html = renderRequest(request);

    expect(html).toContain("Review saved capture with AI");
    expect(html).toContain("page will not be fetched again");
    expect(html).toContain("may create a charge");
    expect(html).not.toContain(">Attach<");
    expect(html).not.toContain("Retry capture + review");
  });

  it("keeps local saved-byte conflicts manual-only", () => {
    const request = reconciliationRequest();
    request.status_reason = "intake_local_conflict";
    request.ai_review = {};
    request.capture_metadata = {};
    const html = renderRequest(request);

    expect(html).toContain("byte, hash, length, or local-path integrity problem");
    expect(html).toContain("will not replace it with bytes fetched from the current URL");
    expect(html).not.toContain("Retry capture + review");
    expect(html).not.toContain("Resume saved capture + review");
    expect(html).not.toContain("Review saved capture with AI");
    expect(html).toContain(">Reject<");
  });

  it("offers an ordinary non-PDF matching failure a disclosed page-and-review retry", () => {
    const request = reconciliationRequest();
    request.homepage_url = "https://example.org/award-guidance";
    request.normalized_url = request.homepage_url;
    request.acquisition_kind = "admin_intake";
    request.notification_mode = "baseline_only";
    request.capture_metadata = {};
    const html = renderRequest(request);

    expect(html).toContain("Retry page + review");
    expect(html).toContain("page may be fetched again");
    expect(html).toContain("AI review may create a charge");
    expect(html).not.toContain("Replay retained result - $0");
    expect(html).not.toContain(">Attach<");
  });

  it("keeps ordinary recovery controls for a non-live stale-matching failure", () => {
    const request = reconciliationRequest();
    request.status = "failed";
    request.status_reason = "stale_matching_failed_closed_operator_retry_required";
    request.acquisition_kind = "admin_intake";
    request.notification_mode = "baseline_only";
    request.capture_metadata = {};
    const html = renderRequest(request);

    expect(html).toContain(">Retry<");
    expect(html).toContain(">Rerun AI<");
    expect(html).toContain(">Attach<");
    expect(html).not.toContain("Replay retained result - $0");
  });

  it("offers one explicit no-charge approval for reviewed low-coverage onboarding", () => {
    const html = renderRequest(manualBackfillActivationRequest());

    expect(html).toContain("Approve baseline-only source - $0");
    expect(html).toContain("paid page review is complete");
    expect(html).toContain("will not fetch the page again, rerun AI");
    expect(html).toContain("change the award homepage");
    expect(html).not.toContain(">Attach<");
    expect(html).not.toContain(">Retry<");
    expect(html).not.toContain(">Rerun AI<");
  });

  it("labels historical unbound onboarding truthfully and offers a new paid saved-capture review", () => {
    const request = manualBackfillActivationRequest();
    const aiReview = request.ai_review as Record<string, unknown>;
    request.ai_review = {
      ...aiReview,
      provider_input_binding: undefined,
      provider_result_binding: undefined,
    };
    const html = renderRequest(request);

    expect(html).toContain("historical provider result is not cryptographically bound");
    expect(html).toContain("$0 approval is blocked");
    expect(html).toContain(">Rerun AI<");
    expect(html).not.toContain("Approve baseline-only source - $0");
  });

  it("keeps a failed approved activation on the exact $0 replay instead of chargeable controls", () => {
    const request = manualBackfillActivationRequest();
    request.status_reason = "low_coverage_backfill_source_activation_preflight_failed_no_charge";
    request.notification_mode = "baseline_only";
    request.ai_review = {
      ...(request.ai_review as Record<string, unknown>),
      manual_source_activation: {
        required: false,
        approved: true,
        approved_shared_award_id: request.matched_shared_award_id,
        approved_by: "admin@awardping.com",
        approved_at: "2026-07-17T12:02:00.000Z",
        source_registered: false,
        official_homepage_changed: false,
        notification_after_approval: "baseline_only",
        backfill_discovery_evidence_sha256: "7".repeat(64),
        provider_input_digest_sha256: "f".repeat(64),
        provider_result_binding_digest_sha256: "8".repeat(64),
        provider_result_sha256: "9".repeat(64),
      },
    };
    const html = renderRequest(request);

    expect(html).toContain("Retry approved baseline-only activation - $0");
    expect(html).toContain("without fetching the page or rerunning AI");
    expect(html).not.toContain("Approve baseline-only source - $0");
    expect(html).not.toContain(">Attach<");
    expect(html).not.toContain(">Retry<");
    expect(html).not.toContain(">Rerun AI<");
  });
});

function renderRequest(request: SourceIntakeRequestView) {
  return renderToStaticMarkup(createElement(AdminSourceIntakePanel, {
    initialRequests: [request],
    awardOptions: [],
  }));
}

function stagedCaptureMetadata(value: unknown) {
  const capture = value as Record<string, unknown>;
  const completed = capture.retained_artifact as Record<string, unknown>;
  return {
    ...capture,
    retained_artifact: undefined,
    retained_artifact_staged: {
      ...completed,
      r2_verified_at: null,
    },
  };
}

function reconciliationRequest(): SourceIntakeRequestView {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const fileHash = "a".repeat(64);
  const inputDigest = "f".repeat(64);
  const prefix = `source-intake-first-observation/v1/requests/${requestId}/sha256/${fileHash}`;
  return {
    id: requestId,
    award_name: "Example Award",
    homepage_url: "https://example.org/official-2027.pdf",
    normalized_url: "https://example.org/official-2027.pdf",
    intake_type: "official_source",
    status: "needs_manual_review",
    status_reason: "matching_failed_closed_operator_retry_required",
    detected_award_name: "Example Award",
    detected_sponsor: "Example Foundation",
    matched_shared_award_id: null,
    created_shared_award_id: null,
    created_source_ids: null,
    ai_review: {
      status: "accepted",
      raw: { status: "accepted", source_relevance: "primary" },
      completed_at: "2026-07-16T12:00:00.000Z",
      gemini_batch_name: "batches/source-intake-1",
      possible_external_batch_name: "batches/source-intake-1",
      submission_claim_token: "claim-terminal",
      gemini_batch_request_key: requestId,
      model: "gemini-2.5-flash-lite",
      provider_input_binding: {
        schema_version: 2,
        namespace: "source-intake-provider-input-v2",
        request_id: requestId,
        retained_capture_sha256: fileHash,
        normalized_text_sha256: "c".repeat(64),
        canonical_url: "https://example.org/official-2027.pdf",
        response_final_url: "https://example.org/official-2027.pdf",
        content_type: "application/pdf",
        retained_capture_byte_length: 1234,
        normalized_text_length: 987,
        captured_at: "2026-07-16T11:59:00.000Z",
        model: "gemini-2.5-flash-lite",
        prompt_policy: { version: 2 },
        prompt_policy_sha256: "1".repeat(64),
        request_fields_sha256: "2".repeat(64),
        deterministic_review_sha256: "3".repeat(64),
        text_excerpt_sha256: "4".repeat(64),
        system_instruction_sha256: "5".repeat(64),
        user_prompt_sha256: "6".repeat(64),
        generation_config_sha256: "7".repeat(64),
        provider_envelope_sha256: "8".repeat(64),
        provider_envelope: { request: {} },
        digest_sha256: inputDigest,
      },
      provider_result_binding: {
        schema_version: 2,
        namespace: "source-intake-provider-result-v2",
        request_id: requestId,
        input_digest_sha256: inputDigest,
        provider_batch_name: "batches/source-intake-1",
        provider_batch_request_key: requestId,
        model: "gemini-2.5-flash-lite",
        provider_result_sha256: "9".repeat(64),
        accepted_at: "2026-07-16T12:00:00.000Z",
        digest_sha256: "8".repeat(64),
      },
    },
    capture_metadata: {
      capture_file_hash: fileHash,
      canonical_url: "https://example.org/official-2027.pdf",
      retained_artifact: {
        schema_version: 1,
        namespace: "source-intake-first-observation",
        request_id: requestId,
        captured_at: "2026-07-16T11:59:00.000Z",
        final_url: "https://example.org/official-2027.pdf",
        prefix,
        file_hash: fileHash,
        file_bytes: 1234,
        text_hash: "c".repeat(64),
        text_length: 987,
        r2_bucket: "awardping-artifacts",
        r2_store_id: "account.r2.cloudflarestorage.com",
        r2_verified_at: "2026-07-16T12:01:00.000Z",
        artifacts: {
          pdf: {
            key: `${prefix}/document.pdf`,
            sha256: fileHash,
            byte_length: 1234,
            content_type: "application/pdf",
          },
          text: {
            key: `${prefix}/text.txt`,
            sha256: "d".repeat(64),
            byte_length: 988,
            content_type: "text/plain; charset=utf-8",
          },
          capture_metadata: {
            key: `${prefix}/capture.json`,
            sha256: "e".repeat(64),
            byte_length: 456,
            content_type: "application/json",
          },
        },
      },
    },
    acquisition_kind: "live_discovery",
    notification_mode: "first_capture_candidate",
    onboarding_batch_id: null,
    deterministic_review: { reason: "official_source_candidate" },
    error: "Reconciliation persistence failed.",
    created_at: "2026-07-16T11:00:00.000Z",
    updated_at: "2026-07-16T12:02:00.000Z",
    processed_at: null,
  };
}

function manualBackfillActivationRequest(): SourceIntakeRequestView {
  const request = reconciliationRequest();
  request.award_name = "Marshall Scholarship";
  request.detected_award_name = "Marshall Scholarship";
  request.matched_shared_award_id = "22222222-2222-4222-8222-222222222222";
  request.status_reason = "low_coverage_backfill_reviewed_manual_source_activation_required";
  request.acquisition_kind = "admin_intake";
  request.notification_mode = "manual_review";
  request.onboarding_batch_id = "low-coverage-source-backfill-v1";
  request.ai_review = {
    ...(request.ai_review as Record<string, unknown>),
    backfill_discovery_evidence: {
      policy_version: "low-coverage-source-backfill-v1",
      matched_shared_award_id: request.matched_shared_award_id,
      source_activation: "manual_only",
      notification_after_approval: "baseline_only",
      evidence_sha256: "7".repeat(64),
    },
    manual_source_activation: {
      required: true,
      source_registered: false,
      official_homepage_changed: false,
      notification_after_approval: "baseline_only",
    },
  };
  return request;
}
