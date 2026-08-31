import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STAGE1_BASELINE_ACTIVATION_BATCH_ID,
  buildStage1BaselineActivationFailureRpcArgs,
  buildStage1BaselineActivationFinalizeRpcArgs,
  buildStage1BaselineActivationRecordRpcArgs,
  evaluateStage1FirstVisualBaselineActivation,
  isStage1PendingBaselineActivationSource,
  normalizeStage1BaselineEvidenceWords,
  normalizeStage1BaselineActivationText,
  stage1BaselineActivationGuardSha256,
  stage1BaselineActivationPersistedTextIdentity,
  stage1BaselineActivationReceipt,
  stage1BaselineActivationFinalizationReceipt,
  stage1BaselineActivationTextSha256,
} from "./stage1-baseline-activation-guard.mjs";

const sourceId = "11111111-1111-4111-8111-111111111111";
const acquisitionId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const finalUrl = "https://example.org/award/eligibility";
const retainedText = "Award eligibility\nApplicants must be enrolled full time.";

function validAcquisition() {
  const normalizedHash = stage1BaselineActivationTextSha256(retainedText);
  const acquisition = {
    id: acquisitionId,
    shared_award_source_id: sourceId,
    origin_source_page_request_id: requestId,
    acquisition_kind: "historical_import",
    notification_mode: "baseline_only",
    onboarding_batch_id: STAGE1_BASELINE_ACTIVATION_BATCH_ID,
    review_seal: {
      source_page_request_id: requestId,
      capture_file_hash: "a".repeat(64),
      capture_final_url: finalUrl,
      human_source_disposition: {
        schema_version: "awardping.stage1.baseline-source-human-disposition.v1",
        policy_version: "stage1-baseline-source-disposition-v1",
        decision: "approve_baseline_only",
        effective_source_review: {
          status: "accepted",
          source_relevance: "primary",
          cycle_relevance: "evergreen",
          officialness: "official",
          confidence: "high",
          page_type: "eligibility",
          evidence_quotes: ["Applicants must be enrolled full time."],
          exact_evidence_verified: true,
          facts: {
            description: null,
            deadline: null,
            amount: null,
            eligibility: [],
            application_materials: [],
            important_dates: [],
          },
          reviewed_roles: ["eligibility"],
        },
        activation_guard: {
          mode: "first_visual_baseline_exact_normalized_retained_text",
          onboarding_batch_id: STAGE1_BASELINE_ACTIVATION_BATCH_ID,
          notification_mode: "baseline_only",
          source_page_request_id: requestId,
          shared_award_source_id: sourceId,
          shared_award_source_acquisition_id: acquisitionId,
          evidence_packet_sha256: "c".repeat(64),
          decision_item_sha256: "d".repeat(64),
          normalized_retained_text_sha256: normalizedHash,
          retained_text_artifact: {
            store_id: "awardping-r2-production",
            bucket: "awardping-snapshots",
            key:
              `source-intake-first-observation/v1/requests/${requestId}/sha256/` +
              `${"a".repeat(64)}/text.txt`,
            sha256: "b".repeat(64),
            bytes: Buffer.byteLength(`${retainedText}\n`, "utf8"),
            r2_verified_at: "2026-08-03T16:00:00.000Z",
          },
          capture_file_sha256: "a".repeat(64),
          final_url: finalUrl,
        },
        authority: {
          monitoring: true,
          public_facts: false,
          fact_candidates: false,
          reconciliation: false,
          publication: false,
          first_observation_notification: false,
        },
        guard_sha256: null,
      },
    },
  };
  const disposition = acquisition.review_seal.human_source_disposition;
  disposition.guard_sha256 = stage1BaselineActivationGuardSha256(disposition);
  return acquisition;
}

function validCapture(text = retainedText) {
  return { text, final_url: finalUrl };
}

function validComparisonCapture(text = retainedText) {
  return {
    ok: true,
    text,
    final_url: `${finalUrl}/`,
    canonical_url: finalUrl,
    capture_method: "fetch_html",
  };
}

describe("Stage 1 first-visual-baseline activation guard", () => {
  it("proves the writer-owned trailing LF without changing semantic text hashes", () => {
    const capturedText = "Eligibility  Applicants must be enrolled.";
    expect(stage1BaselineActivationPersistedTextIdentity({
      persistedText: `${capturedText}\n`,
      capturedText,
    })).toEqual({
      text_sha256: createHash("sha256").update(capturedText).digest("hex"),
      normalized_text_sha256: stage1BaselineActivationTextSha256(capturedText),
    });
    expect(stage1BaselineActivationPersistedTextIdentity({
      persistedText: `${capturedText}\r\n`,
      capturedText,
    })).toBeNull();
    expect(stage1BaselineActivationPersistedTextIdentity({
      persistedText: `${capturedText}\n\n`,
      capturedText,
    })).toBeNull();
  });

  it("normalizes current capture text exactly like retained source-intake text", () => {
    expect(normalizeStage1BaselineActivationText("  Award\r\n\t eligibility\u0000  "))
      .toBe("Award eligibility");
    expect(stage1BaselineActivationTextSha256("A\n B"))
      .toBe(stage1BaselineActivationTextSha256("A   B\n"));
    // Case-fused block boundaries split identically on both sides of the
    // quote comparison, so extraction-path whitespace disagreements stop
    // mattering while genuinely different words still fail.
    expect(normalizeStage1BaselineEvidenceWords("Time.EligibilityAn $15,000-award"))
      .toBe("time eligibility an 15 000 award");
    expect(normalizeStage1BaselineEvidenceWords("Time.\nEligibility\nAn $15,000-award"))
      .toBe("time eligibility an 15 000 award");
    expect(normalizeStage1BaselineEvidenceWords("Eastern Time.EligibilityAn applicant"))
      .toBe(normalizeStage1BaselineEvidenceWords("Eastern Time.\nEligibility\nAn applicant"));
    expect(normalizeStage1BaselineEvidenceWords("Time.IneligibilityAn applicant"))
      .not.toBe(normalizeStage1BaselineEvidenceWords("Time.\nEligibility\nAn applicant"));
  });

  it.each([
    null,
    {
      id: acquisitionId,
      acquisition_kind: "live_discovery",
      notification_mode: "first_capture_candidate",
      onboarding_batch_id: null,
    },
    {
      id: acquisitionId,
      acquisition_kind: "historical_import",
      notification_mode: "baseline_only",
      onboarding_batch_id: "different-batch",
    },
  ])("does not affect ordinary or live acquisitions", (acquisition) => {
    expect(evaluateStage1FirstVisualBaselineActivation({ acquisition, capture: validCapture() }))
      .toMatchObject({ applies: false, allowed: true, status: "not_applicable" });
  });

  it("allows only an exact normalized hash and produces auditable verification metadata", () => {
    const result = evaluateStage1FirstVisualBaselineActivation({
      acquisition: validAcquisition(),
      capture: validCapture("Award eligibility   Applicants must be enrolled full time.\n"),
      retainedComparisonCapture: validComparisonCapture(
        "Award eligibility   Applicants must be enrolled full time.\n",
      ),
      sourceId,
      verifiedAt: "2026-08-03T17:00:00.000Z",
    });

    expect(result).toMatchObject({
      applies: true,
      allowed: true,
      status: "exact_hash_verified_pending_server_receipt",
      verification: {
        status: "exact_hash_verified_pending_server_receipt",
        source_acquisition_id: acquisitionId,
        source_page_request_id: requestId,
        shared_award_source_id: sourceId,
        expected_normalized_text_sha256: stage1BaselineActivationTextSha256(retainedText),
        observed_normalized_text_sha256: stage1BaselineActivationTextSha256(retainedText),
        retained_text_artifact: {
          sha256: "b".repeat(64),
          bucket: "awardping-snapshots",
        },
        authority: {
          fact_candidates: false,
          reconciliation: false,
          publication: false,
          first_observation_notification: false,
        },
      },
    });
    expect(result.guard_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when the first visual text differs and builds a zero-charge quarantine call", () => {
    const acquisition = validAcquisition();
    const capture = validCapture();
    const retainedComparisonCapture = validComparisonCapture("Different award text");
    const result = evaluateStage1FirstVisualBaselineActivation({
      acquisition,
      capture,
      retainedComparisonCapture,
      sourceId,
    });

    expect(result).toMatchObject({
      applies: true,
      allowed: false,
      reason: "stage1_baseline_activation_normalized_text_hash_mismatch",
    });
    expect(buildStage1BaselineActivationFailureRpcArgs({
      sourceId,
      acquisition,
      evaluation: result,
      capture,
      retainedComparisonCapture,
    })).toMatchObject({
      p_source_id: sourceId,
      p_acquisition_id: acquisitionId,
      p_request_id: requestId,
      p_reason_code: "stage1_baseline_activation_normalized_text_hash_mismatch",
      p_evidence: {
        creates_api_charge: false,
        public_event_created: false,
        baseline_written: false,
        r2_sync_succeeded: false,
        persistence_evidence: null,
        baseline_facts_requested: false,
      },
    });
  });

  it("reports preserved local and R2 evidence honestly for a post-persistence failure", () => {
    const acquisition = validAcquisition();
    const evaluation = {
      ...evaluateStage1FirstVisualBaselineActivation({
        acquisition,
        capture: validCapture(),
        retainedComparisonCapture: validComparisonCapture(),
        sourceId,
      }),
      allowed: false,
      reason: "stage1_baseline_activation_server_finalization_failed",
    };
    expect(buildStage1BaselineActivationFailureRpcArgs({
      sourceId,
      acquisition,
      evaluation,
      capture: validCapture(),
      persistenceState: validPersistenceEvidence(evaluation),
    }).p_evidence).toMatchObject({
      baseline_written: true,
      r2_sync_succeeded: true,
      creates_api_charge: false,
      persistence_evidence: {
        schema_version: "awardping.stage1.baseline-activation-persistence-evidence.v3",
        local_baseline_written: true,
        r2_sync_succeeded: true,
        creates_api_charge: false,
      },
    });
  });

  it.each([
    ["missing disposition", (row) => { delete row.review_seal.human_source_disposition; }, "disposition_missing"],
    ["wrong decision", (row) => {
      row.review_seal.human_source_disposition.decision = "keep_quarantined";
      reseal(row);
    }, "disposition_not_approved"],
    ["missing retained hash", (row) => {
      delete row.review_seal.human_source_disposition.activation_guard.normalized_retained_text_sha256;
      reseal(row);
    }, "guard_binding_malformed"],
    ["request drift", (row) => {
      row.review_seal.human_source_disposition.activation_guard.source_page_request_id =
        "44444444-4444-4444-8444-444444444444";
      reseal(row);
    }, "guard_binding_malformed"],
    ["seal drift", (row) => { row.review_seal.capture_file_hash = "f".repeat(64); }, "review_seal_mismatch"],
    ["source drift", (row) => { row.shared_award_source_id = "55555555-5555-4555-8555-555555555555"; }, "acquisition_binding_mismatch"],
    ["publication authority", (row) => {
      row.review_seal.human_source_disposition.authority.publication = true;
      reseal(row);
    }, "authority_invalid"],
    ["fact payload", (row) => {
      row.review_seal.human_source_disposition.effective_source_review.facts.deadline = "tomorrow";
      reseal(row);
    }, "effective_review_invalid"],
    ["retained R2 key", (row) => {
      row.review_seal.human_source_disposition.activation_guard.retained_text_artifact.key =
        "different/text.txt";
      reseal(row);
    }, "retained_text_artifact_invalid"],
  ])("quarantines malformed binding: %s", (_label, mutate, suffix) => {
    const acquisition = validAcquisition();
    mutate(acquisition);
    const result = evaluateStage1FirstVisualBaselineActivation({
      acquisition,
      capture: validCapture(),
      retainedComparisonCapture: validComparisonCapture(),
      sourceId,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(`stage1_baseline_activation_${suffix}`);
  });

  it("rejects an altered disposition and any extra unreviewed key", () => {
    const altered = validAcquisition();
    altered.review_seal.human_source_disposition.activation_guard.decision_item_sha256 =
      "e".repeat(64);
    expect(evaluateStage1FirstVisualBaselineActivation({
      acquisition: altered,
      capture: validCapture(),
      retainedComparisonCapture: validComparisonCapture(),
      sourceId,
    }).reason).toBe("stage1_baseline_activation_guard_sha256_mismatch");

    const broadened = validAcquisition();
    broadened.review_seal.human_source_disposition.extra_authority = "monitor_and_publish";
    reseal(broadened);
    expect(evaluateStage1FirstVisualBaselineActivation({
      acquisition: broadened,
      capture: validCapture(),
      retainedComparisonCapture: validComparisonCapture(),
      sourceId,
    }).reason).toBe("stage1_baseline_activation_disposition_keys_invalid");
  });

  it("fails closed when current final URL differs from the retained review", () => {
    const result = evaluateStage1FirstVisualBaselineActivation({
      acquisition: validAcquisition(),
      capture: { ...validCapture(), final_url: "https://example.org/different" },
      retainedComparisonCapture: validComparisonCapture(),
      sourceId,
    });
    expect(result.reason).toBe("stage1_baseline_activation_final_url_mismatch");
  });

  it("requires a positive server receipt before finalizing verification", () => {
    const acquisition = validAcquisition();
    const evaluation = evaluateStage1FirstVisualBaselineActivation({
      acquisition,
      capture: validCapture(),
      retainedComparisonCapture: validComparisonCapture(),
      sourceId,
    });
    expect(buildStage1BaselineActivationRecordRpcArgs({
      sourceId,
      acquisition,
      evaluation,
    })).toEqual({
      p_source_id: sourceId,
      p_acquisition_id: acquisitionId,
      p_observed_normalized_text_sha256: stage1BaselineActivationTextSha256(retainedText),
      p_guard_sha256: evaluation.guard_sha256,
    });
    expect(stage1BaselineActivationReceipt({ allowed: false }, evaluation).allowed).toBe(false);
    const prepared = stage1BaselineActivationReceipt({
      allowed: true,
      prepare_receipt_sha256: "e".repeat(64),
    }, evaluation);
    expect(prepared)
      .toMatchObject({
        allowed: true,
        verification: {
          status: "server_prepare_recorded",
          server_prepare_receipt: {
            allowed: true,
            prepare_receipt_sha256: "e".repeat(64),
          },
        },
      });

    const persistenceEvidence = validPersistenceEvidence(evaluation);
    expect(buildStage1BaselineActivationFinalizeRpcArgs({
      sourceId,
      acquisition,
      evaluation,
      prepareReceipt: prepared.receipt,
      persistenceEvidence,
    })).toEqual({
      p_source_id: sourceId,
      p_acquisition_id: acquisitionId,
      p_observed_normalized_text_sha256: evaluation.observed_normalized_text_sha256,
      p_guard_sha256: evaluation.guard_sha256,
      p_prepare_receipt_sha256: "e".repeat(64),
      p_persistence_evidence: persistenceEvidence,
    });
    expect(stage1BaselineActivationFinalizationReceipt({
      allowed: true,
      finalization_receipt_sha256: "f".repeat(64),
    }).allowed).toBe(true);
    expect(stage1BaselineActivationFinalizationReceipt({ allowed: true }).allowed).toBe(false);

    const driftedEvidence = {
      ...persistenceEvidence,
      source_id: "55555555-5555-4555-8555-555555555555",
    };
    expect(() => buildStage1BaselineActivationFinalizeRpcArgs({
      sourceId,
      acquisition,
      evaluation,
      prepareReceipt: prepared.receipt,
      persistenceEvidence: driftedEvidence,
    })).toThrow("requires exact local and R2 persistence evidence");

    const distinctVisualTextIdentity = {
      ...persistenceEvidence,
      local_baseline: {
        ...persistenceEvidence.local_baseline,
        normalized_text_sha256: "9".repeat(64),
      },
    };
    expect(buildStage1BaselineActivationFinalizeRpcArgs({
      sourceId,
      acquisition,
      evaluation,
      prepareReceipt: prepared.receipt,
      persistenceEvidence: distinctVisualTextIdentity,
    }).p_persistence_evidence).toBe(distinctVisualTextIdentity);

    const malformedVisualTextIdentity = {
      ...persistenceEvidence,
      local_baseline: {
        ...persistenceEvidence.local_baseline,
        normalized_text_sha256: "not-a-sha256",
      },
    };
    expect(() => buildStage1BaselineActivationFinalizeRpcArgs({
      sourceId,
      acquisition,
      evaluation,
      prepareReceipt: prepared.receipt,
      persistenceEvidence: malformedVisualTextIdentity,
    })).toThrow("requires exact local and R2 persistence evidence");
  });

  it("requires complete comparable-word evidence sequences in the visual baseline", () => {
    const acquisition = validAcquisition();
    const comparisonText =
      "Deadline.Time Eligibility—Applicants must be enrolled full-time.";
    acquisition.review_seal.human_source_disposition.effective_source_review.evidence_quotes = [
      comparisonText,
    ];
    acquisition.review_seal.human_source_disposition.activation_guard
      .normalized_retained_text_sha256 = stage1BaselineActivationTextSha256(comparisonText);
    reseal(acquisition);
    const accepted = evaluateStage1FirstVisualBaselineActivation({
      acquisition,
      capture: validCapture(
        "Deadline\nTime Eligibility Applicants must be enrolled full time.",
      ),
      retainedComparisonCapture: validComparisonCapture(comparisonText),
      sourceId,
    });
    expect(accepted.allowed).toBe(true);

    const rejected = evaluateStage1FirstVisualBaselineActivation({
      acquisition,
      capture: validCapture("Eligibility Applicants enrolled full time."),
      retainedComparisonCapture: validComparisonCapture(comparisonText),
      sourceId,
    });
    expect(rejected.reason).toBe(
      "stage1_baseline_activation_visual_evidence_quotes_missing",
    );
  });

  it("does not accept a reviewed word as a substring of a different visual word", () => {
    const acquisition = validAcquisition();
    const comparisonText = "Award eligibility";
    acquisition.review_seal.human_source_disposition.effective_source_review.evidence_quotes = [
      "Award",
    ];
    acquisition.review_seal.human_source_disposition.activation_guard
      .normalized_retained_text_sha256 = stage1BaselineActivationTextSha256(comparisonText);
    reseal(acquisition);

    const result = evaluateStage1FirstVisualBaselineActivation({
      acquisition,
      capture: validCapture("Awarded eligibility"),
      retainedComparisonCapture: validComparisonCapture(comparisonText),
      sourceId,
    });
    expect(result.reason).toBe(
      "stage1_baseline_activation_visual_evidence_quotes_missing",
    );
  });

  it("recognizes only the exact pending activation source hold", () => {
    const source = {
      source_acquisition: validAcquisition(),
      admin_review_status: "review_later",
      admin_review_note: "approved_pending_exact_first_visual_baseline",
      admin_reviewed_by: "stage1-baseline-source-disposition",
    };
    expect(isStage1PendingBaselineActivationSource(source)).toBe(true);
    expect(isStage1PendingBaselineActivationSource({
      ...source,
      admin_review_note: "stage1_baseline_activation_failed:hash_mismatch",
    })).toBe(false);
  });
});

function reseal(acquisition) {
  const disposition = acquisition.review_seal.human_source_disposition;
  disposition.guard_sha256 = stage1BaselineActivationGuardSha256(disposition);
}

function validPersistenceEvidence(evaluation) {
  const capturedAt = "2026-08-03T17:01:00.000Z";
  const textHash = "1".repeat(64);
  const imageHash = "2".repeat(64);
  return {
    schema_version: "awardping.stage1.baseline-activation-persistence-evidence.v3",
    persisted_at: "2026-08-03T17:02:00.000Z",
    source_id: sourceId,
    acquisition_id: acquisitionId,
    request_id: requestId,
    guard_sha256: evaluation.guard_sha256,
    observed_normalized_text_sha256: evaluation.observed_normalized_text_sha256,
    local_baseline_written: true,
    local_baseline: {
      archive_relative_path: `sources/${sourceId}/baseline.json`,
      captured_at: capturedAt,
      kind: "webpage",
      text_hash: textHash,
      normalized_text_sha256: evaluation.observed_normalized_text_sha256,
      image_hash: imageHash,
      file_hash: null,
      layout_hash: "3".repeat(64),
      capture_meta_path: `sources/${sourceId}/capture/meta.json`,
      activation_guard_sha256: evaluation.guard_sha256,
      activation_status: "server_prepare_recorded",
    },
    r2_sync_succeeded: true,
    r2: {
      bucket: "awardping-snapshots",
      latest_captured_at: capturedAt,
      latest_object_keys: {
        text: `visual-snapshots/sources/${sourceId}/captures/hash/text.txt`,
      },
      latest_hashes: {
        text_hash: textHash,
        image_hash: imageHash,
      },
      activation_guard_sha256: evaluation.guard_sha256,
      uploaded_object_count: 2,
    },
    creates_api_charge: false,
  };
}
