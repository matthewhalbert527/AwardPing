import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INITIAL_OFFICIAL_DOCUMENT_SCOPE,
  buildInitialOfficialDocumentCandidate,
  initialOfficialDocumentPublicationDecision,
  initialOfficialDocumentSourceIdentityDecision,
} from "./initial-official-document.mjs";
import {
  currentVisualReviewPolicyIdentity,
  latestVisualReviewPolicyDecision,
  rebuildInitialOfficialDocumentCandidateForCurrentPolicy,
  visualReviewCandidatePolicyFreshness,
} from "./visual-review-queue.mjs";

const applicantQuote = "Applications are due March 15, 2027.";

function eligibleInput(overrides = {}) {
  const input = {
    acquisition: {
      id: "acquisition-1",
      notification_mode: "first_capture_candidate",
    },
    review: {
      id: "review-1",
      sealed: true,
      status: "accepted",
      award_relevance: "primary",
      cycle_relevance: "current_or_upcoming",
      confidence: "high",
      evidence_quotes: [applicantQuote],
      capture_final_url: "https://example.edu/awards/2027-guidance.pdf",
    },
    source: {
      id: "source-1",
      shared_award_id: "award-1",
      url: "https://example.edu/awards/2027-guidance.pdf",
    },
    capture: {
      kind: "pdf",
      captured_at: "2026-07-16T12:00:00.000Z",
      final_url: "https://example.edu/awards/2027-guidance.pdf",
      file_hash: "a".repeat(64),
      pdf_text_error: null,
      text: `Official 2027 guidance\n\n${applicantQuote}\nApplicants must submit a transcript.`,
    },
  };
  return {
    ...input,
    ...overrides,
    acquisition: { ...input.acquisition, ...(overrides.acquisition || {}) },
    review: { ...input.review, ...(overrides.review || {}) },
    source: { ...input.source, ...(overrides.source || {}) },
    capture: { ...input.capture, ...(overrides.capture || {}) },
  };
}

describe("initial official document candidate", () => {
  it("builds a deterministic one-sided result from exact normalized PDF wording", () => {
    const decision = buildInitialOfficialDocumentCandidate(
      eligibleInput({
        review: { evidence_quotes: ["Applications   are due March 15, 2027."] },
        capture: { text: "Official guidance\nApplications are due March 15, 2027." },
      }),
    );

    expect(decision).toMatchObject({
      eligible: true,
      reason: "eligible_new_official_document_first_observed",
      candidate_scope: INITIAL_OFFICIAL_DOCUMENT_SCOPE,
      evidence_quote: applicantQuote,
      deterministic_diff: {
        candidate_scope: INITIAL_OFFICIAL_DOCUMENT_SCOPE,
        first_observation: true,
        added_text: [applicantQuote],
        removed_text: [],
        exact_before: null,
        exact_after: applicantQuote,
      },
      result: {
        change_type: "new_official_document",
        observation_kind: "first_observation",
        before: null,
        after: applicantQuote,
        exact_before: null,
        exact_after: applicantQuote,
        is_alert_worthy: true,
      },
      review_execution: {
        mode: "deterministic_from_sealed_acquisition_review",
        api_review_required: false,
        creates_api_charge: false,
      },
    });
    expect(decision.result.reader_summary).toContain("AwardPing first observed this official document");
    expect(decision.result.reader_summary).not.toMatch(/(?:changed|publisher posted|published today)/i);
  });

  it("accepts a sealed medium-confidence supporting evergreen review", () => {
    const quote = "Eligible applicants must submit two letters of recommendation.";
    const decision = buildInitialOfficialDocumentCandidate(
      eligibleInput({
        review: {
          award_relevance: undefined,
          source_relevance: "supporting",
          cycle_relevance: "evergreen",
          confidence: "medium",
          evidence_quotes: [quote],
        },
        capture: { text: quote },
      }),
    );

    expect(decision).toMatchObject({
      eligible: true,
      result: {
        source_relevance: "supporting",
        confidence: "medium",
        section: "Eligibility",
      },
    });
  });

  it("creates a stable, byte-verifiable SHA-256 first-observation attestation", () => {
    const first = buildInitialOfficialDocumentCandidate(eligibleInput());
    const second = buildInitialOfficialDocumentCandidate(eligibleInput());
    const changedCapture = buildInitialOfficialDocumentCandidate(
      eligibleInput({ capture: { file_hash: "b".repeat(64) } }),
    );

    expect(first.eligible).toBe(true);
    expect(first.first_observation_attestation).toMatchObject({
      kind: "first_observation",
      content_type: "application/json",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      body: {
        schema_version: "awardping.first_observation.v1",
        prior_evidence_state: "no_prior_baseline_supplied",
        capture: { file_sha256: "a".repeat(64) },
      },
    });
    expect(first.first_observation_attestation.sha256).toBe(second.first_observation_attestation.sha256);
    expect(first.first_observation_attestation.sha256).not.toBe(
      changedCapture.first_observation_attestation.sha256,
    );
    expect(first.first_observation_attestation.sha256).toBe(
      createHash("sha256")
        .update(first.first_observation_attestation.canonical_json, "utf8")
        .digest("hex"),
    );
    expect(first.first_observation_attestation.byte_length).toBe(
      Buffer.byteLength(first.first_observation_attestation.canonical_json, "utf8"),
    );
    expect(first.first_observation_attestation.body.statement).toContain(
      "does not assert when the publisher created or posted the document",
    );
  });

  it("binds the sealed intake review to the exact monitored PDF bytes", () => {
    const hash = "a".repeat(64);
    const direct = buildInitialOfficialDocumentCandidate(
      eligibleInput({ review: { capture_file_hash: hash } }),
    );
    const nested = buildInitialOfficialDocumentCandidate(
      eligibleInput({ acquisition: { review_seal: { capture_file_hash: hash } } }),
    );
    const mismatch = buildInitialOfficialDocumentCandidate(
      eligibleInput({ review: { capture_file_hash: "b".repeat(64) } }),
    );

    expect(direct).toMatchObject({
      eligible: true,
      reviewed_capture_file_sha256: hash,
      deterministic_diff: { reviewed_capture_file_sha256: hash },
      first_observation_attestation: {
        body: { sealed_review: { capture_file_sha256: hash } },
      },
    });
    expect(nested).toMatchObject({ eligible: true, reviewed_capture_file_sha256: hash });
    expect(mismatch).toMatchObject({
      eligible: false,
      reason: "sealed_review_capture_file_hash_mismatch",
    });
  });

  it.each([
    [
      eligibleInput({
        acquisition: { review_seal: { capture_file_hash: "b".repeat(64) } },
        review: { capture_file_hash: "a".repeat(64) },
      }),
      "sealed_review_capture_file_hash_conflict",
    ],
    [eligibleInput({ review: { capture_file_hash: "not-a-sha" } }), "sealed_review_capture_file_hash_invalid"],
    [
      eligibleInput({ review: { capture_final_url: "https://example.edu/awards/other.pdf" } }),
      "sealed_review_capture_final_url_mismatch",
    ],
  ])("rejects an invalid sealed capture binding", (input, reason) => {
    expect(buildInitialOfficialDocumentCandidate(input)).toMatchObject({ eligible: false, reason });
  });

  it.each([
    [eligibleInput({ acquisition: { notification_mode: "baseline_only" } }), "notification_mode_not_first_capture_candidate"],
    [eligibleInput({ review: { sealed: false } }), "review_not_sealed"],
    [eligibleInput({ review: { status: "needs_review" } }), "review_status_not_accepted"],
    [eligibleInput({ capture: { kind: "page" } }), "initial_document_requires_pdf_capture"],
  ])("requires the acquisition, sealed review, and PDF gates", (input, reason) => {
    expect(buildInitialOfficialDocumentCandidate(input)).toEqual({
      eligible: false,
      reason,
      candidate_scope: INITIAL_OFFICIAL_DOCUMENT_SCOPE,
    });
  });

  it.each([
    [eligibleInput({ review: { award_relevance: "unrelated" } }), "award_relevance_not_accepted_unrelated"],
    [eligibleInput({ review: { cycle_relevance: "archived_or_past" } }), "cycle_relevance_not_accepted_archived_or_past"],
    [eligibleInput({ review: { confidence: "low" } }), "confidence_not_accepted_low"],
    [
      eligibleInput({ review: { award_relevance: "primary", source_relevance: "supporting" } }),
      "review_award_relevance_conflict",
    ],
  ])("fails closed on an ineligible or contradictory review", (input, reason) => {
    expect(buildInitialOfficialDocumentCandidate(input)).toMatchObject({ eligible: false, reason });
  });

  it("requires an applicant-facing quote rather than generic official-document wording", () => {
    const quote = "Marshall Scholarship 2027 official policy document.";
    const decision = buildInitialOfficialDocumentCandidate(
      eligibleInput({
        review: { evidence_quotes: [quote] },
        capture: { text: quote },
      }),
    );

    expect(decision).toMatchObject({
      eligible: false,
      reason: "applicant_facing_evidence_quote_missing",
    });
  });

  it("recognizes an exact applicant obligation without requiring deadline wording", () => {
    const quote = "Applicants must obtain institutional endorsement before submitting.";
    const decision = buildInitialOfficialDocumentCandidate(
      eligibleInput({
        review: { evidence_quotes: [quote] },
        capture: { text: quote },
      }),
    );

    expect(decision).toMatchObject({
      eligible: true,
      evidence_quote: quote,
      result: { change_type: "new_official_document" },
    });
  });

  it("requires exact case-sensitive wording after whitespace normalization", () => {
    const decision = buildInitialOfficialDocumentCandidate(
      eligibleInput({ capture: { text: "Applications are due March 1, 2027." } }),
    );
    const caseChanged = buildInitialOfficialDocumentCandidate(
      eligibleInput({ capture: { text: applicantQuote.toLowerCase() } }),
    );

    expect(decision).toMatchObject({
      eligible: false,
      reason: "applicant_facing_evidence_quote_not_found_in_pdf_text",
    });
    expect(caseChanged).toMatchObject({
      eligible: false,
      reason: "applicant_facing_evidence_quote_not_found_in_pdf_text",
    });
  });

  it.each([
    [eligibleInput({ capture: { text: "" } }), "pdf_text_missing"],
    [eligibleInput({ capture: { pdf_text_error: "DOMMatrix is not defined" } }), "pdf_text_extraction_failed"],
    [eligibleInput({ capture: { file_hash: "not-a-sha" } }), "pdf_file_hash_invalid"],
    [eligibleInput({ capture: { captured_at: "not-a-date" } }), "capture_timestamp_invalid"],
    [eligibleInput({ source: { id: "" } }), "source_id_missing"],
  ])("refuses incomplete capture evidence", (input, reason) => {
    expect(buildInitialOfficialDocumentCandidate(input)).toMatchObject({ eligible: false, reason });
  });
});

describe("initial official document publication", () => {
  function storedCandidate(input = eligibleInput()) {
    const built = buildInitialOfficialDocumentCandidate(input);
    if (!built.eligible) throw new Error(`Stored candidate fixture is ineligible: ${built.reason}`);
    return {
      candidate_scope: INITIAL_OFFICIAL_DOCUMENT_SCOPE,
      source_acquisition_id: "acquisition-1",
      shared_award_source_id: "source-1",
      shared_award_id: "award-1",
      source_url: built.first_observation_attestation.body.source.url,
      source_title: "2027 guidance",
      source_page_type: "pdf",
      candidate_signature: "candidate-signature",
      new_file_hash: "a".repeat(64),
      deterministic_diff: built.deterministic_diff,
      prompt_payload: {
        first_observation_attestation: built.first_observation_attestation,
        monitoring_policy: currentVisualReviewPolicyIdentity(),
        hashes: {
          first_observation_attestation_sha256: built.first_observation_attestation.sha256,
        },
        source: { award_name: "Example Award" },
      },
      new_snapshot_ref: { captured_at: "2026-07-16T12:00:00.000Z" },
      model: null,
      gemini_batch_name: null,
      actual_usage: {},
      worker_metadata: {
        monitoring_policy: currentVisualReviewPolicyIdentity(),
        evidence_signature: "evidence-signature",
      },
      result: {
        ...built.result,
        review_execution: built.review_execution,
      },
    };
  }

  const source = {
    id: "source-1",
    shared_award_id: "award-1",
    url: "https://example.edu/awards/2027-guidance.pdf",
    title: "2027 guidance",
    page_type: "pdf",
    shared_awards: { name: "Example Award" },
  };

  it("creates explicit first-observation details and hash identity", () => {
    const candidate = storedCandidate();
    const decision = initialOfficialDocumentPublicationDecision({
      candidate,
      source,
      result: candidate.result,
    });

    expect(decision).toMatchObject({
      allowed: true,
      previous_hash: candidate.prompt_payload.first_observation_attestation.sha256,
      new_hash: "a".repeat(64),
      change_details: {
        event_kind: "new_official_document",
        observation_kind: "first_observation",
        first_observation: true,
        before: null,
        after: applicantQuote,
        generation_provider: "deterministic_sealed_acquisition_review",
      },
    });
    expect(decision.change_details.reader_summary).toContain("first observed");
  });

  it("rejects a later redirect that was not bound by the sealed acquisition review", () => {
    const originalUrl = "http://www.example.edu/awards/2027-guidance.pdf";
    const finalUrl = "https://example.edu/awards/2027-guidance.pdf";
    const laterDriftUrl = "https://cdn.example.edu/awards/2027-guidance.pdf";
    expect(buildInitialOfficialDocumentCandidate(eligibleInput({
      source: { url: originalUrl },
      capture: { final_url: finalUrl },
      review: { capture_final_url: originalUrl },
    }))).toMatchObject({
      eligible: false,
      reason: "capture_final_url_not_bound_to_sealed_review",
    });

    const candidate = storedCandidate();

    expect(initialOfficialDocumentSourceIdentityDecision({
      candidate,
      source,
    })).toMatchObject({
      allowed: true,
      reason: "source_url_identity_current",
      event_source_url: source.url,
    });
    expect(initialOfficialDocumentPublicationDecision({
      candidate,
      source,
      result: candidate.result,
    })).toMatchObject({
      allowed: true,
      source_identity: { reason: "source_url_identity_current" },
      change_details: { source: { source_url: source.url } },
    });

    for (const unsealedUrl of [
      laterDriftUrl,
      `${source.url}/`,
      "https://example.edu:443/awards/2027-guidance.pdf",
      `${source.url}#requirements`,
    ]) {
      expect(initialOfficialDocumentSourceIdentityDecision({
        candidate,
        source: { ...source, url: unsealedUrl },
      })).toMatchObject({
        allowed: false,
        reason: "source_url_drift_not_acquisition_sealed",
      });
    }
    expect(initialOfficialDocumentSourceIdentityDecision({
      candidate,
      source: { ...source, id: "different-source" },
    })).toMatchObject({ allowed: false, reason: "candidate_source_identity_mismatch" });

    candidate.prompt_payload.first_observation_attestation.body.capture.final_url =
      "https://example.edu/awards/other.pdf";
    expect(initialOfficialDocumentSourceIdentityDecision({
      candidate,
      source,
    })).toMatchObject({
      allowed: false,
      reason: "first_observation_attestation_body_mismatch",
    });
  });

  it("rejects tampered attestation bytes and invented previous wording", () => {
    const tampered = storedCandidate();
    tampered.prompt_payload.first_observation_attestation.canonical_json += " ";
    expect(initialOfficialDocumentPublicationDecision({
      candidate: tampered,
      source,
      result: tampered.result,
    })).toMatchObject({ allowed: false, reason: "first_observation_attestation_hash_mismatch" });

    const invented = storedCandidate();
    invented.result.exact_before = "Old wording";
    expect(initialOfficialDocumentPublicationDecision({
      candidate: invented,
      source,
      result: invented.result,
    })).toMatchObject({ allowed: false, reason: "first_observation_must_not_claim_previous_wording" });
  });

  it("requeues stale deterministic candidates under the current policy identity without a paid review", () => {
    const candidate = storedCandidate();
    const stalePolicy = { id: "visual-review", version: "stale", hash: "stale-policy-hash" };
    candidate.prompt_payload.monitoring_policy = stalePolicy;
    candidate.worker_metadata.monitoring_policy = stalePolicy;

    const staleDecision = latestVisualReviewPolicyDecision({
      candidate,
      source,
      result: candidate.result,
    });
    expect(staleDecision).toMatchObject({
      allowed: false,
      reason: "policy_changed_since_batch_submission",
      guard: "policy_freshness",
    });

    const rebuilt = rebuildInitialOfficialDocumentCandidateForCurrentPolicy(candidate);
    expect(rebuilt).toMatchObject({
      monitoring_policy: currentVisualReviewPolicyIdentity(),
      prompt_payload: { monitoring_policy: currentVisualReviewPolicyIdentity() },
      evidence_signature: "evidence-signature",
    });
    expect(rebuilt.candidate_signature).toMatch(/^[a-f0-9]{64}$/);
    expect(rebuilt.candidate_signature).not.toBe(candidate.candidate_signature);
    expect(visualReviewCandidatePolicyFreshness({
      ...candidate,
      candidate_signature: rebuilt.candidate_signature,
      prompt_payload: rebuilt.prompt_payload,
      worker_metadata: {
        ...candidate.worker_metadata,
        monitoring_policy: rebuilt.monitoring_policy,
      },
    })).toMatchObject({ allowed: true, reason: "current_policy" });
    expect(candidate.model).toBeNull();
    expect(candidate.gemini_batch_name).toBeNull();
    expect(candidate.actual_usage).toEqual({});
  });

  it("applies global change-event suppression to first-observation details before publication", () => {
    const candidate = storedCandidate();
    const decision = initialOfficialDocumentPublicationDecision({
      candidate,
      source,
      result: candidate.result,
    });
    const monitoredSource = {
      ...source,
      page_metadata_generated_at: "2026-07-16T00:00:00.000Z",
      page_metadata_model: "sealed-intake-review",
      page_metadata: {
        baseline_facts: {
          award_relevance: "primary",
          cycle_relevance: "current_or_upcoming",
          display_title: "2027 guidance",
          quality_flags: [],
        },
      },
    };

    expect(latestVisualReviewPolicyDecision({
      candidate,
      source: monitoredSource,
      result: candidate.result,
      changeDetails: {
        ...decision.change_details,
        quality_flags: ["navigation"],
      },
    })).toMatchObject({
      allowed: false,
      reason: "quality_flag_navigation",
      guard: "change_event_suppression",
    });
  });
});
