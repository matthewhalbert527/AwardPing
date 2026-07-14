import { describe, expect, it } from "vitest";
import {
  buildVisualReviewPromptPayload,
  buildVisualReviewPromptText,
  canonicalVisualReviewSourceUrl,
  changeDetailsFromVisualBatchResult,
  classifyVisualReviewCandidate,
  currentMonitoringPolicyAuditIdentity,
  currentVisualReviewPolicyIdentity,
  expandableSectionCandidateRejectReason,
  latestVisualReviewPolicyDecision,
  normalizeVisualBatchResult,
  normalizeVisualReviewMode,
  rebuildVisualReviewCandidateForCurrentPolicy,
  validateVisualBatchReview,
  visualReviewCandidatePolicyFreshness,
  visualReviewBatchCreateFailureDisposition,
  visualReviewBatchPollFailureDisposition,
  visualReviewCandidateSignature,
  visualReviewCandidateSignatureFromStoredCandidate,
  visualReviewEvidenceSignature,
  visualReviewEvidenceSignatureFromStoredCandidate,
  visualReviewEnclosingCaptureIdentity,
  visualReviewFailureRetryDecision,
  visualReviewSourceIdentityFreshness,
  visualReviewStaleClaimRecoveryDecision,
  visualHashFromCandidate,
} from "./lib/visual-review-queue.mjs";

const source = {
  id: "source-1",
  shared_award_id: "award-1",
  url: "https://example.edu/scholarships/example-award/apply",
  title: "Example Award Application",
  page_type: "application",
  admin_review_status: "open",
  page_metadata_generated_at: "2026-07-08T00:00:00.000Z",
  page_metadata_model: "gemini-test",
  page_metadata: {
    baseline_facts: {
      award_relevance: "primary",
      cycle_relevance: "current_or_upcoming",
      display_title: "Example Award Application",
      quality_flags: [],
    },
  },
};

const candidate = {
  id: "candidate-1",
  shared_award_source_id: "source-1",
  candidate_signature: "signature",
  deterministic_diff: {
    added_text: ["Application deadline: March 15, 2027"],
    removed_text: ["Application deadline: March 1, 2027"],
  },
  prompt_payload: {
    include_images: false,
    new_text_excerpt: "Application deadline: March 15, 2027",
    previous_text_excerpt: "Application deadline: March 1, 2027",
    monitoring_policy: currentVisualReviewPolicyIdentity(),
  },
};

function sourceFixture(overrides = {}) {
  return {
    ...source,
    ...overrides,
    page_metadata: {
      ...source.page_metadata,
      ...(overrides.page_metadata || {}),
      baseline_facts: {
        ...source.page_metadata.baseline_facts,
        ...(overrides.page_metadata?.baseline_facts || {}),
      },
    },
  };
}

describe("visual review queue helpers", () => {
  it("uses section identity before shared whole-page hashes for event uniqueness", () => {
    const fixture = (sectionKey, previousHash, newHash) => ({
      previous_image_hash: "shared-old-image",
      new_image_hash: "shared-new-image",
      deterministic_diff: {
        candidate_scope: "expandable_section",
        section_key: sectionKey,
        previous_section_hash: previousHash,
        new_section_hash: newHash,
      },
    });
    const eligibility = fixture("eligibility", "old-a", "new-a");
    const deadline = fixture("deadline", "old-b", "new-b");
    expect(visualHashFromCandidate(eligibility, "previous")).not.toBe(
      visualHashFromCandidate(deadline, "previous"),
    );
    expect(visualHashFromCandidate(eligibility, "new")).not.toBe(
      visualHashFromCandidate(deadline, "new"),
    );
  });

  it("treats harmless URL normalization as the same captured source identity", () => {
    expect(canonicalVisualReviewSourceUrl("HTTPS://Example.edu/apply/?utm_source=test#deadline"))
      .toBe("https://example.edu/apply");
    expect(visualReviewSourceIdentityFreshness({
      source_url: "https://example.edu/apply/",
      prompt_payload: { source: { url: "https://example.edu/apply/" } },
    }, { url: "https://example.edu/apply" })).toMatchObject({
      allowed: true,
      reason: "source_url_identity_current",
    });
  });

  it("invalidates evidence captured for a different source URL", () => {
    expect(visualReviewSourceIdentityFreshness({
      source_url: "https://example.edu/old-award",
      prompt_payload: { source: { url: "https://example.edu/old-award" } },
    }, { url: "https://example.edu/different-award" })).toEqual({
      allowed: false,
      reason: "source_url_changed_since_capture",
      captured_source_url: "https://example.edu/old-award",
      current_source_url: "https://example.edu/different-award",
    });
  });

  it("retries bounded ordinary failures but leaves missing responses for recovery", () => {
    expect(visualReviewFailureRetryDecision({
      status: "failed",
      rejection_reason: "invalid_ai_json: unexpected token",
      worker_metadata: { failure_retry_count: 1 },
    })).toMatchObject({
      retry: true,
      next_retry_count: 2,
    });
    expect(visualReviewFailureRetryDecision({
      status: "failed",
      rejection_reason: "missing_batch_response",
    })).toMatchObject({
      retry: false,
      reason: "awaiting_missing_batch_response_recovery",
    });
    expect(visualReviewFailureRetryDecision({
      status: "failed",
      rejection_reason: "provider failed",
      worker_metadata: { failure_retry_count: 3 },
    })).toMatchObject({
      retry: false,
      reason: "failure_retry_limit_reached",
    });
    expect(visualReviewFailureRetryDecision({
      status: "failed",
      rejection_reason: "manual_recovery_required_possible_external_batch_created",
    })).toMatchObject({
      retry: false,
      reason: "possible_external_batch_requires_manual_recovery",
    });
  });

  it("fails stale post-create claims closed instead of duplicating paid Batch work", () => {
    expect(visualReviewStaleClaimRecoveryDecision({
      status: "processing",
      gemini_batch_name: null,
      worker_metadata: {
        batch_display_name: "awardping-visual-review-before-post",
      },
    })).toEqual({
      action: "requeue",
      reason: "stale_claim_before_batch_create",
    });
    expect(visualReviewStaleClaimRecoveryDecision({
      status: "processing",
      gemini_batch_name: null,
      worker_metadata: {
        batch_display_name: "awardping-visual-review-crash-window",
        batch_create_started_at: "2026-07-14T20:00:00.000Z",
      },
    })).toEqual({
      action: "fail_closed",
      reason: "possible_external_batch_created",
      batch_display_name: "awardping-visual-review-crash-window",
      batch_create_started_at: "2026-07-14T20:00:00.000Z",
    });
    expect(visualReviewStaleClaimRecoveryDecision({
      status: "processing",
      gemini_batch_name: null,
      worker_metadata: {},
    })).toEqual({
      action: "requeue",
      reason: "stale_claim_before_batch_create",
    });
  });

  it("groups expandable-section siblings by their immutable enclosing capture", () => {
    const first = {
      new_text_hash: "section-a",
      new_snapshot_ref: {
        capture_dir: { archive_relative: "sources/source-1/captures/capture-1" },
      },
    };
    const second = {
      new_text_hash: "section-b",
      new_snapshot_ref: {
        capture_dir: { archive_relative: "sources/source-1/captures/capture-1" },
      },
    };
    expect(visualReviewEnclosingCaptureIdentity(first)).toBe(
      visualReviewEnclosingCaptureIdentity(second),
    );
  });

  it("fails ambiguous Batch-create POST outcomes closed", () => {
    expect(visualReviewBatchCreateFailureDisposition({
      kind: "batch_create_inline",
      httpStatus: 503,
    })).toEqual({
      action: "fail_closed",
      reason: "possible_external_batch_created",
    });
    expect(visualReviewBatchCreateFailureDisposition({
      kind: "batch_create_file",
      networkFailure: true,
    })).toEqual({
      action: "fail_closed",
      reason: "possible_external_batch_created",
    });
    expect(visualReviewBatchCreateFailureDisposition({
      kind: "batch_poll",
      httpStatus: 503,
    })).toMatchObject({ action: "retry_or_release" });
  });

  it("releases only definitively missing provider batches for bounded retry", () => {
    expect(visualReviewBatchPollFailureDisposition({
      kind: "batch_poll",
      httpStatus: 404,
    })).toEqual({
      action: "fail_for_bounded_retry",
      reason: "provider_batch_permanently_missing",
      http_status: 404,
    });
    expect(visualReviewBatchPollFailureDisposition({
      kind: "batch_poll",
      httpStatus: 410,
    })).toMatchObject({ action: "fail_for_bounded_retry" });
    expect(visualReviewBatchPollFailureDisposition({
      kind: "batch_poll",
      httpStatus: 503,
    })).toMatchObject({ action: "preserve_batch_reference" });
    expect(visualReviewBatchPollFailureDisposition({
      kind: "batch_create_inline",
      httpStatus: 404,
    })).toMatchObject({ action: "preserve_batch_reference" });
  });

  it("normalizes visual review mode values", () => {
    expect(normalizeVisualReviewMode("batch", "immediate")).toBe("batch");
    expect(normalizeVisualReviewMode("false", "batch")).toBe("none");
    expect(normalizeVisualReviewMode("true", "batch")).toBe("batch");
    expect(normalizeVisualReviewMode("immediate", "batch")).toBe("immediate");
  });

  it("builds stable signatures from hashes and deterministic diff", () => {
    const first = visualReviewCandidateSignature({
      source,
      baseline: { text_hash: "a", image_hash: "b" },
      capture: { text_hash: "c", image_hash: "d" },
      diff: { added_text: ["Application deadline: March 15, 2027"] },
      deterministic: { classification: "candidate_change" },
      behaviorVersion: 6,
    });
    const second = visualReviewCandidateSignature({
      source,
      baseline: { image_hash: "b", text_hash: "a" },
      capture: { image_hash: "d", text_hash: "c" },
      diff: { added_text: ["Application deadline: March 15, 2027"] },
      deterministic: { classification: "candidate_change" },
      behaviorVersion: 6,
    });
    expect(first).toHaveLength(64);
    expect(second).toBe(first);
  });

  it("allows the same exact transition to recur in a later capture occurrence", () => {
    const input = {
      source,
      baseline: { text_hash: "closed" },
      diff: { added_text: ["Applications are open"] },
      deterministic: { classification: "candidate_change" },
      behaviorVersion: 6,
    };
    const first = visualReviewCandidateSignature({
      ...input,
      capture: { text_hash: "open", captured_at: "2026-07-14T18:00:00.000Z" },
    });
    const nextCycle = visualReviewCandidateSignature({
      ...input,
      capture: { text_hash: "open", captured_at: "2027-07-14T18:00:00.000Z" },
    });
    expect(nextCycle).not.toBe(first);
  });

  it("incorporates monitoring policy identity into candidate signatures", () => {
    const input = {
      source,
      baseline: { text_hash: "old" },
      capture: { text_hash: "new" },
      diff: { added_text: ["Application deadline: March 15, 2027"] },
      deterministic: { classification: "candidate_change" },
      behaviorVersion: 6,
    };
    const first = visualReviewCandidateSignature({
      ...input,
      policyIdentity: { id: "award-monitoring-policy", version: "1", hash: "hash-one" },
    });
    const second = visualReviewCandidateSignature({
      ...input,
      policyIdentity: { id: "award-monitoring-policy", version: "2", hash: "hash-two" },
    });

    expect(second).not.toBe(first);
  });

  it("keeps evidence identity stable while policy identity rekeys the candidate", () => {
    const input = {
      source,
      baseline: { text_hash: "old", image_hash: "same" },
      capture: { text_hash: "new", image_hash: "same" },
      diff: { added_text: ["Application deadline: March 15, 2027"] },
      deterministic: { classification: "applicant_fact_change" },
      behaviorVersion: 6,
    };
    const evidence = visualReviewEvidenceSignature(input);
    const first = visualReviewCandidateSignature({
      ...input,
      policyIdentity: { id: "policy-one", version: "1", hash: "hash-one" },
    });
    const second = visualReviewCandidateSignature({
      ...input,
      policyIdentity: { id: "policy-two", version: "2", hash: "hash-two" },
    });

    expect(evidence).toHaveLength(64);
    expect(first).not.toBe(second);
  });

  it("includes the reviewed source baseline/localization context in evidence identity", () => {
    const baseline = { text_hash: "old", image_hash: "same" };
    const capture = { text_hash: "new", image_hash: "same", text: "Application deadline: March 15, 2027" };
    const previous = { text: "Application deadline: March 1, 2027" };
    const diff = {
      added_text: ["Application deadline: March 15, 2027"],
      removed_text: ["Application deadline: March 1, 2027"],
    };
    const deterministic = { classification: "applicant_fact_change" };
    const promptPayload = buildVisualReviewPromptPayload({
      source,
      baseline,
      previous,
      capture,
      diff,
      deterministic,
      behaviorVersion: 6,
    });
    const stored = {
      shared_award_source_id: source.id,
      source_url: source.url,
      source_title: source.title,
      source_page_type: source.page_type,
      previous_text_hash: baseline.text_hash,
      new_text_hash: capture.text_hash,
      previous_image_hash: baseline.image_hash,
      new_image_hash: capture.image_hash,
      deterministic_diff: diff,
      deterministic_classification: deterministic.classification,
      prompt_payload: promptPayload,
    };
    const original = visualReviewEvidenceSignature({
      source,
      baseline,
      capture,
      diff,
      deterministic,
      behaviorVersion: 6,
    });
    expect(visualReviewEvidenceSignatureFromStoredCandidate(stored)).toBe(original);

    const relocalizedSource = sourceFixture({
      page_metadata: {
        baseline_facts: {
          display_title: "Example Award — Official Application",
          award_relevance: "primary",
          cycle_relevance: "current_or_upcoming",
        },
      },
    });
    expect(visualReviewEvidenceSignature({
      source: relocalizedSource,
      baseline,
      capture,
      diff,
      deterministic,
      behaviorVersion: 6,
    })).not.toBe(original);
    const rebuilt = rebuildVisualReviewCandidateForCurrentPolicy(stored, {
      source: relocalizedSource,
    });
    expect(rebuilt.source_context.baseline_facts.display_title).toBe(
      "Example Award — Official Application",
    );
    expect(rebuilt.candidate_signature).not.toBe(
      visualReviewCandidateSignatureFromStoredCandidate(stored),
    );
  });

  it("separates the effective Batch identity from the full audit bundle identity", () => {
    expect(currentVisualReviewPolicyIdentity().id).toMatch(/^awardping-visual-review-batch@/);
    expect(currentMonitoringPolicyAuditIdentity().id).toMatch(/^awardping-monitoring-policy@/);
    expect(currentVisualReviewPolicyIdentity()).not.toEqual(currentMonitoringPolicyAuditIdentity());

    const input = {
      source,
      baseline: { text_hash: "old" },
      capture: { text_hash: "new" },
      diff: { added_text: ["Application deadline: March 15, 2027"] },
      deterministic: { classification: "applicant_fact_change" },
      behaviorVersion: 6,
    };
    expect(visualReviewCandidateSignature(input)).toBe(
      visualReviewCandidateSignature({
        ...input,
        policyIdentity: currentVisualReviewPolicyIdentity(),
      }),
    );
    expect(visualReviewCandidateSignature(input)).not.toBe(
      visualReviewCandidateSignature({
        ...input,
        policyIdentity: currentMonitoringPolicyAuditIdentity(),
      }),
    );
  });

  it("rekeys and rebuilds a stale stored candidate for the current effective policy", () => {
    const stalePolicy = { id: "stale-policy", version: "1", hash: "stale-hash" };
    const stored = {
      ...candidate,
      candidate_signature: "stale-signature",
      gemini_batch_request_key: "stale-signature",
      previous_text_hash: "old",
      new_text_hash: "new",
      previous_image_hash: "same",
      new_image_hash: "same",
      deterministic_classification: "applicant_fact_change",
      deterministic_diff: {
        added_text: ["Application deadline: March 15, 2027"],
        removed_text: ["Application deadline: March 1, 2027"],
      },
      prompt_payload: {
        ...candidate.prompt_payload,
        behavior_version: 6,
        monitoring_policy: stalePolicy,
      },
      worker_metadata: {
        capture_behavior_version: 6,
        monitoring_policy: stalePolicy,
      },
    };
    const rebuilt = rebuildVisualReviewCandidateForCurrentPolicy(stored);

    expect(rebuilt.monitoring_policy).toEqual(currentVisualReviewPolicyIdentity());
    expect(rebuilt.prompt_payload.monitoring_policy).toEqual(currentVisualReviewPolicyIdentity());
    expect(rebuilt.prompt_payload.monitoring_policy_bundle).toEqual(
      currentMonitoringPolicyAuditIdentity(),
    );
    expect(rebuilt.prompt_context).toContain(currentVisualReviewPolicyIdentity().hash);
    expect(rebuilt.prompt_context).not.toContain("stale-hash");
    expect(rebuilt.candidate_signature).toBe(
      visualReviewCandidateSignatureFromStoredCandidate(stored),
    );
    expect(rebuilt.candidate_signature).not.toBe(stored.candidate_signature);
    expect(visualReviewEvidenceSignatureFromStoredCandidate(stored)).toHaveLength(64);
  });

  it("rebuilds prompt policy instructions from the active policy identity", () => {
    const activePolicy = currentVisualReviewPolicyIdentity();
    const prompt = buildVisualReviewPromptText({
      source: { id: source.id, award_name: "Example Award" },
      monitoring_policy: { id: "stale-policy", version: "stale", hash: "stale-hash" },
    });

    expect(prompt).toContain(activePolicy.hash);
    expect(prompt).not.toContain("stale-hash");
  });

  it("blocks a Batch result when policy changed after submission", () => {
    expect(visualReviewCandidatePolicyFreshness({
      ...candidate,
      worker_metadata: {
        monitoring_policy: {
          id: "old-policy",
          version: "1",
          hash: "old-policy-hash",
        },
      },
    })).toMatchObject({
      allowed: false,
      reason: "policy_changed_since_batch_submission",
      active_policy: currentVisualReviewPolicyIdentity(),
    });
  });

  it.each([
    ["donation_prompt", "fundraising_form_change"],
    ["unsupported_added_text", "unsupported_structured_fact"],
    ["before_text_not_found", "unsupported_structured_fact"],
    ["after_text_already_present", "no_actual_changed_fact"],
    ["before_text_still_present", "no_actual_changed_fact"],
  ])("rejects legacy Batch noise flag %s as canonical policy %s", (alias, expected) => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_award_facts: [{
        fact: "Application deadline changed",
        before: "Application deadline: March 1, 2027",
        after: "Application deadline: March 15, 2027",
      }],
      exact_before: "Application deadline: March 1, 2027",
      exact_after: "Application deadline: March 15, 2027",
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Deadlines",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [alias],
      rejection_reason: null,
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toEqual({
      allowed: false,
      reason: `policy_flag_${expected}`,
    });
  });

  it("canonicalizes a legacy policy reason when the model already rejected it", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: false,
      is_alert_worthy: false,
      source_relevance: "primary",
      changed_award_facts: [],
      exact_before: null,
      exact_after: null,
      before: null,
      after: null,
      section: null,
      change_type: "other",
      confidence: "high",
      noise_flags: [],
      rejection_reason: "donation_prompt",
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toEqual({
      allowed: false,
      reason: "policy_flag_fundraising_form_change",
    });
  });

  it("allows a supported primary award fact change", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_award_facts: [
        {
          fact: "Application deadline changed",
          before: "Application deadline: March 1, 2027",
          after: "Application deadline: March 15, 2027",
          added_text: "Application deadline: March 15, 2027",
          removed_text: "Application deadline: March 1, 2027",
        },
      ],
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Deadlines",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
      reader_summary: "The application deadline changed from March 1 to March 15, 2027.",
      advisor_impact: "Advisors should update deadline guidance.",
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toEqual({
      allowed: true,
      reason: "approved",
    });
  });

  it("accepts the strict changed_facts and exact evidence fields", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      source_relevance_reason: "The source is the award application page.",
      changed_facts: [
        {
          fact: "Application deadline changed",
          before: "Application deadline: March 1, 2027",
          after: "Application deadline: March 15, 2027",
        },
      ],
      exact_before: "Application deadline: March 1, 2027",
      exact_after: "Application deadline: March 15, 2027",
      evidence_location: "Deadline row",
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Deadlines",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
      reader_summary: "The application deadline changed from March 1 to March 15, 2027.",
      advisor_impact: "Advisors should update deadline guidance.",
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toEqual({
      allowed: true,
      reason: "approved",
    });
  });

  it("rejects unclear source relevance", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "unclear",
      changed_award_facts: [{ fact: "Deadline changed", added_text: "Application deadline: March 15, 2027" }],
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Deadlines",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toMatchObject({
      allowed: false,
      reason: "source_relevance_unclear",
    });
  });

  it("rejects unsupported changed facts", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_award_facts: [{ fact: "Award amount changed", after: "$5,000" }],
      exact_before: "Application deadline: March 1, 2027",
      exact_after: "Application deadline: March 15, 2027",
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Funding",
      change_type: "funding",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toMatchObject({
      allowed: false,
      reason: "changed_facts_not_supported_by_evidence",
    });
  });

  it("requires the applicant-facing signal to come from deterministic text evidence", () => {
    const genericCandidate = {
      ...candidate,
      deterministic_diff: {
        added_text: ["Updated content block"],
        removed_text: ["Previous content block"],
      },
    };
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_facts: [{
        fact: "The application deadline changed to March 15, 2027",
        before: "Previous content block",
        after: "Updated content block",
      }],
      exact_before: "Previous content block",
      exact_after: "Updated content block",
      section: "Deadlines",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
      reader_summary: "The application deadline changed to March 15, 2027.",
      advisor_impact: "Update deadline guidance.",
    }, { candidate: genericCandidate, source });

    expect(validateVisualBatchReview({ candidate: genericCandidate, source, result })).toEqual({
      allowed: false,
      reason: "missing_deterministic_applicant_fact_signal",
    });
  });

  it("does not let model-authored structured diff fabricate its own evidence", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_facts: [{
        fact: "Award amount changed",
        before: "$1,000",
        after: "$50,000",
      }],
      exact_before: "$1,000",
      exact_after: "$50,000",
      evidence_location: "Funding",
      before: "$1,000",
      after: "$50,000",
      section: "Funding",
      change_type: "funding",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
      reader_summary: "The award amount changed from $1,000 to $50,000.",
      advisor_impact: "Advisors should update funding guidance.",
      structured_diff: {
        added_text: ["$50,000"],
        removed_text: ["$1,000"],
        date_changes: [],
        amount_changes: [],
        noise_flags: [],
      },
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toEqual({
      allowed: false,
      reason: "exact_before_after_not_supported_by_evidence",
    });
  });

  it("publishes only deterministic structured diff entries from a mixed valid result", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_facts: [{
        fact: "The deadline changed and the award amount rose to $50,000",
        before: "Application deadline: March 1, 2027",
        after: "Application deadline: March 15, 2027",
      }],
      exact_before: "Application deadline: March 1, 2027",
      exact_after: "Application deadline: March 15, 2027",
      evidence_location: "Funding section showing $50,000",
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Deadlines and funding",
      change_type: "funding",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
      reader_summary: "The deadline changed and the award amount rose to $50,000.",
      advisor_impact: "Tell applicants the award now pays $50,000.",
      structured_diff: {
        added_text: ["Application deadline: March 15, 2027", "$50,000"],
        removed_text: ["Application deadline: March 1, 2027", "$1,000"],
        date_changes: [],
        amount_changes: ["Added $50,000", "Removed $1,000"],
        noise_flags: [],
      },
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toEqual({
      allowed: true,
      reason: "approved",
    });

    const details = changeDetailsFromVisualBatchResult({
      candidate,
      source,
      result,
      model: "gemini-test",
    });
    expect(details.structured_diff).toMatchObject({
      added_text: candidate.deterministic_diff.added_text,
      removed_text: candidate.deterministic_diff.removed_text,
      date_changes: [],
      amount_changes: [],
    });
    expect(JSON.stringify(details.structured_diff)).not.toContain("$50,000");
    expect(JSON.stringify(details.structured_diff)).not.toContain("$1,000");
    expect(details.changed_facts).toEqual([{
      fact: "Application deadline or cycle date",
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      added_text: null,
      removed_text: null,
      visual_evidence: null,
    }]);
    expect(details.change_type).toBe("deadline");
    expect(details.reader_summary).toContain("March 15, 2027");
    expect(details.public_claims_provenance).toEqual({
      source: "deterministic_diff",
      model_narrative_published: false,
    });
    expect(JSON.stringify(details)).not.toContain("$50,000");
    expect(JSON.stringify(details)).not.toContain("$1,000");
  });

  it("rejects a high-confidence result when one critical claim lacks exact evidence", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_award_facts: [
        {
          fact: "Application deadline changed",
          before: "Application deadline: March 1, 2027",
          after: "Application deadline: March 15, 2027",
        },
        {
          fact: "Award amount changed",
          before: "$4,000",
          after: "$5,000",
        },
      ],
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Deadlines and funding",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toMatchObject({
      allowed: false,
      reason: "changed_facts_not_supported_by_evidence",
    });
  });

  it("rejects source-quality failures at publish time", () => {
    const badSource = {
      ...source,
      url: "https://example.edu/careers/job/profile/123",
    };
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_award_facts: [{ fact: "Deadline changed", added_text: "Application deadline: March 15, 2027" }],
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Deadlines",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
    }, { candidate, source: badSource });

    expect(validateVisualBatchReview({ candidate, source: badSource, result })).toMatchObject({
      allowed: false,
    });
  });

  it("keeps deterministic deadline evidence on a conditional event-page source", () => {
    const eventSource = sourceFixture({
      url: "https://example.edu/events/example-award-deadline",
      title: "Example Award deadline event",
      page_type: "event",
    });
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_facts: [{
        fact: "Application deadline changed",
        before: "Application deadline: March 1, 2027",
        after: "Application deadline: March 15, 2027",
      }],
      exact_before: "Application deadline: March 1, 2027",
      exact_after: "Application deadline: March 15, 2027",
      section: "Deadline",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
      reader_summary: "The application deadline changed.",
    }, { candidate, source: eventSource });

    expect(validateVisualBatchReview({ candidate, source: eventSource, result })).toEqual({
      allowed: true,
      reason: "approved",
    });
    expect(classifyVisualReviewCandidate({
      source: eventSource,
      diff: candidate.deterministic_diff,
      deterministic: { candidate_change: true, reason: "text_changed" },
    })).toMatchObject({
      allowed: true,
      label: "applicant_fact_change",
    });
  });

  it("rejects ACLS/JUMP AppSolutions version churn before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source,
      diff: {
        added_text: ["JUMP AppSolutions Version 5.1.7"],
        removed_text: ["JUMP AppSolutions Version 5.1.6"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "popup_modal_noise",
    });
  });

  it("rejects Ask LOC security-question pages before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source: sourceFixture({
        url: "https://ask.loc.gov/security/question",
        title: "Security Question",
      }),
      diff: {
        added_text: ["Security question answer required"],
        removed_text: ["Security question"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "access_error",
      source_rejected: true,
    });
  });

  it("rejects unclear SFFILM general FAQ sources before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source: sourceFixture({
        url: "https://sffilm.org/faq",
        title: "General FAQ",
        page_type: "faq",
        page_metadata: {
          baseline_facts: {
            award_relevance: "unclear",
            cycle_relevance: "current_or_upcoming",
          },
        },
      }),
      diff: {
        added_text: ["Frequently asked questions were reordered."],
        removed_text: ["General questions"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "source_quality_ai_review_reviewed_unclear_needs_manual_review_award_relevance_unclear",
      source_rejected: true,
    });
  });

  it("rejects Audubon popup/free app modal changes before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source: sourceFixture({
        url: "https://example.edu/audubon/scholarship/apply",
        title: "Audubon Scholarship Application",
      }),
      diff: {
        added_text: ["Download our free app to continue"],
        removed_text: ["Close"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "popup_modal_noise",
    });
  });

  it("rejects PDF file-size/hash changes with no text evidence before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source: sourceFixture({
        url: "https://example.edu/scholarships/example-award/guide.pdf",
        title: "Example Award Guide PDF",
        page_type: "pdf",
      }),
      diff: {
        added_text: [],
        removed_text: [],
      },
      deterministic: { candidate_change: true, reason: "pdf_file_hash_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "pdf_metadata_only",
    });
  });

  it("rejects fellow profile/testimonial rotation before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source,
      diff: {
        added_text: ["Featured fellow testimonial: I loved the program."],
        removed_text: ["Featured fellow testimonial: This changed my career."],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "profile_roster_rotation",
    });
  });

  it("rejects job board updates before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source: sourceFixture({
        url: "https://example.edu/careers/jobs/123",
        title: "Program Coordinator Job",
      }),
      diff: {
        added_text: ["The job posting close date changed."],
        removed_text: ["Apply now for this job."],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      source_rejected: true,
    });
  });

  it("rejects sibling PhRMA Faculty Starter Grants under the wrong award before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source: sourceFixture({
        shared_awards: { name: "PhRMA Foundation Predoctoral Fellowship" },
        title: "PhRMA Foundation Predoctoral Fellowship",
      }),
      diff: {
        added_text: ["Faculty Starter Grants application deadline: September 1, 2027"],
        removed_text: ["Faculty Starter Grants application deadline: August 15, 2027"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "sibling_program_or_cross_award",
    });
  });

  it("allows text-only deadline changes without image prompt parts by default", () => {
    const diff = {
      added_text: ["Application deadline: April 2, 2027"],
      removed_text: ["Application deadline: March 15, 2027"],
    };
    const deterministic = { candidate_change: true, reason: "award_relevant_terms_or_context" };
    const decision = classifyVisualReviewCandidate({ source, diff, deterministic });
    const payload = buildVisualReviewPromptPayload({
      source,
      baseline: { text_hash: "old", image_hash: "same" },
      previous: { text: "Application deadline: March 15, 2027", thumbPath: "previous.jpg" },
      capture: { text: "Application deadline: April 2, 2027", text_hash: "new", image_hash: "same", thumbPath: "new.jpg" },
      diff,
      deterministic: { ...deterministic, classification: decision.label },
    });

    expect(decision).toMatchObject({
      allowed: true,
      label: "applicant_fact_change",
      candidate_kind: "text_only",
    });
    expect(payload.include_images).toBe(false);
  });

  it("keeps expandable-section candidates compact and section-scoped", () => {
    const diff = {
      candidate_scope: "expandable_section",
      section_key: "eligibility",
      section_label: "Eligibility",
      section_path: "button#eligibility",
      previous_section_hash: "old-section",
      new_section_hash: "new-section",
      added_text: ["Applicants must be enrolled full time."],
      removed_text: ["Applicants must be enrolled part time."],
    };
    const deterministic = { candidate_change: true, reason: "award_relevant_terms_or_context" };
    const first = visualReviewCandidateSignature({
      source,
      baseline: { text_hash: "old-section", image_hash: "same-page" },
      capture: { text_hash: "new-section", image_hash: "same-page" },
      diff,
      deterministic,
      behaviorVersion: 8,
    });
    const second = visualReviewCandidateSignature({
      source,
      baseline: { text_hash: "old-section", image_hash: "same-page" },
      capture: { text_hash: "new-section", image_hash: "same-page" },
      diff: { ...diff, section_key: "requirements" },
      deterministic,
      behaviorVersion: 8,
    });
    const payload = buildVisualReviewPromptPayload({
      source,
      baseline: { text_hash: "old-section", image_hash: "same-page" },
      previous: { text: "Applicants must be enrolled part time." },
      capture: { text: "Applicants must be enrolled full time.", text_hash: "new-section", image_hash: "same-page" },
      diff,
      deterministic,
    });

    expect(second).not.toBe(first);
    expect(payload.include_images).toBe(false);
    expect(payload.section_context).toMatchObject({
      candidate_scope: "expandable_section",
      section_key: "eligibility",
      section_label: "Eligibility",
    });
    expect(payload.hashes).toMatchObject({
      previous_section_hash: "old-section",
      new_section_hash: "new-section",
    });
  });

  it("allows text-only award amount changes", () => {
    const decision = classifyVisualReviewCandidate({
      source,
      diff: {
        added_text: ["Award amount: $7,500"],
        removed_text: ["Award amount: $5,000"],
      },
      deterministic: { candidate_change: true, reason: "award_relevant_terms_or_context" },
    });

    expect(decision).toMatchObject({
      allowed: true,
      label: "applicant_fact_change",
      candidate_kind: "text_only",
    });
  });

  it("rejects text-only nav/footer churn before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source,
      diff: {
        added_text: ["Footer navigation: Privacy Terms Contact Facebook LinkedIn"],
        removed_text: ["Footer navigation: Privacy Terms Contact Twitter LinkedIn"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "nav_chrome_noise",
    });
  });

  it("rejects text-only timestamp/current-date churn before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source,
      diff: {
        added_text: ["Last updated July 8, 2026"],
        removed_text: ["Last updated July 7, 2026"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "nav_chrome_noise",
      reason: "timestamp_or_countdown_noise",
    });
  });

  it("reapplies the latest relative-age suppression policy before publication", () => {
    const relativeAgeCandidate = {
      ...candidate,
      deterministic_diff: {
        added_text: ["Latest news posted 9 days ago"],
        removed_text: ["Latest news posted 8 days ago"],
      },
    };
    const result = {
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      confidence: "high",
      noise_flags: [],
      changed_facts: [
        {
          fact: "Latest news recency label changed",
          added_text: "Latest news posted 9 days ago",
          removed_text: "Latest news posted 8 days ago",
        },
      ],
      exact_before: "Latest news posted 8 days ago",
      exact_after: "Latest news posted 9 days ago",
      before: "Latest news posted 8 days ago",
      after: "Latest news posted 9 days ago",
      reader_summary: "The latest news label changed from 8 days ago to 9 days ago.",
      section: "Latest news",
      change_type: "other",
      structured_diff: relativeAgeCandidate.deterministic_diff,
    };

    expect(latestVisualReviewPolicyDecision({
      candidate: relativeAgeCandidate,
      source,
      result,
    })).toMatchObject({
      allowed: false,
      reason: "policy_flag_relative_age_timestamp_churn",
      guard: "visual_review_validation",
    });
  });

  it("records active and queued policy identities in published change details", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_facts: [{ fact: "Deadline changed", added_text: "Application deadline: March 15, 2027" }],
      exact_before: "Application deadline: March 1, 2027",
      exact_after: "Application deadline: March 15, 2027",
      section: "Deadlines",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
      reader_summary: "The application deadline changed.",
    }, { candidate, source });
    const queuedPolicy = { id: "queued-policy", version: "1", hash: "queued-hash" };
    const details = changeDetailsFromVisualBatchResult({
      candidate: {
        ...candidate,
        prompt_payload: {
          ...candidate.prompt_payload,
          monitoring_policy: queuedPolicy,
        },
      },
      source,
      result,
      model: "gemini-test",
    });

    expect(details.monitoring_policy).toEqual(currentVisualReviewPolicyIdentity());
    expect(details.queued_monitoring_policy).toMatchObject(queuedPolicy);
  });

  it("rejects text-only access-denied/login text before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source,
      diff: {
        added_text: ["Access denied. Login required to continue."],
        removed_text: ["Example Award application instructions"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "access_error",
    });
  });

  it("rejects an unconfirmed expandable-section removal after AI review", () => {
    const removedText = "Application deadline: February 5, 2025.";
    const decision = validateVisualBatchReview({
      source,
      candidate: {
        ...candidate,
        deterministic_diff: {
          candidate_scope: "expandable_section",
          section_label: "What is the application deadline?",
          previous_section_hash: "old-section",
          new_section_hash: null,
          section_removal_confirmed: false,
          removed_text: [removedText],
          added_text: [],
        },
      },
      result: {
        is_true_change: true,
        is_alert_worthy: true,
        source_relevance: "primary",
        confidence: "high",
        noise_flags: [],
        changed_facts: [{ fact: "deadline", removed_text: removedText }],
        exact_before: removedText,
        exact_after: null,
        reader_summary: "The application deadline was removed.",
        section: "Application deadline",
        change_type: "removed",
      },
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "unconfirmed_expandable_section_removal",
    });
  });

  it("rejects an unconfirmed expandable-section removal before Batch submission", () => {
    expect(
      expandableSectionCandidateRejectReason({
        deterministic_diff: {
          candidate_scope: "expandable_section",
          previous_section_hash: "old-section",
          new_section_hash: null,
          section_removal_confirmed: false,
        },
      }),
    ).toBe("unconfirmed_expandable_section_removal");
  });

  it("rejects a claimed removal when the current page still contains the section", () => {
    expect(
      expandableSectionCandidateRejectReason({
        deterministic_diff: {
          candidate_scope: "expandable_section",
          previous_section_hash: "old-section",
          new_section_hash: null,
          section_removal_confirmed: true,
          section_presence_evidence: {
            current_label_present: true,
          },
        },
      }),
    ).toBe("expandable_section_still_present");
  });

  it("allows a confirmed expandable-section removal with exact evidence", () => {
    const removedText = "Application deadline: February 5, 2025.";
    const decision = validateVisualBatchReview({
      source,
      candidate: {
        ...candidate,
        deterministic_diff: {
          candidate_scope: "expandable_section",
          section_label: "What is the application deadline?",
          previous_section_hash: "old-section",
          new_section_hash: null,
          section_removal_confirmed: true,
          section_presence_evidence: {
            confirmed: true,
            current_label_present: false,
            current_body_present: false,
          },
          removed_text: [removedText],
          added_text: [],
        },
      },
      result: {
        is_true_change: true,
        is_alert_worthy: true,
        source_relevance: "primary",
        confidence: "high",
        noise_flags: [],
        changed_facts: [{ fact: "deadline", removed_text: removedText }],
        exact_before: removedText,
        exact_after: null,
        reader_summary: "The application deadline was removed.",
        section: "Application deadline",
        change_type: "removed",
      },
    });

    expect(decision).toEqual({ allowed: true, reason: "approved" });
  });
});
