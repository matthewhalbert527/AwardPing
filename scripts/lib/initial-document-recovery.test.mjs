import { describe, expect, it } from "vitest";
import { initialDocumentCurrentPolicyShadow } from "./initial-document-recovery.mjs";
import {
  currentVisualReviewPolicyIdentity,
  visualReviewCandidatePolicyFreshness,
} from "./visual-review-queue.mjs";

describe("initial-document recovery current-policy shadow", () => {
  it("validates stale evidence under current policy without mutating its stored CAS identity", () => {
    const stalePolicy = {
      id: "awardping-visual-review-batch@stale",
      version: "visual-review-batch-stale",
      hash: "fnv1a32x2-utf16:0000000000000000",
    };
    const candidate = {
      id: "candidate-1",
      candidate_scope: "initial_official_document",
      source_acquisition_id: "acquisition-1",
      shared_award_source_id: "source-1",
      source_url: "https://example.edu/2027.pdf",
      candidate_signature: "a".repeat(64),
      new_file_hash: "b".repeat(64),
      new_snapshot_ref: {
        captured_at: "2026-06-15T12:00:00.000Z",
        artifact_manifest_digest: "c".repeat(64),
      },
      prompt_payload: {
        monitoring_policy: stalePolicy,
        monitoring_policy_bundle: { id: "stale-bundle", version: "stale", hash: "stale" },
        first_observation_attestation: { sha256: "d".repeat(64) },
        hashes: {
          first_observation_attestation_sha256: "d".repeat(64),
          new_file_hash: "b".repeat(64),
          new_artifact_manifest_digest: "c".repeat(64),
        },
        new_snapshot_ref: {
          captured_at: "2026-06-15T12:00:00.000Z",
          artifact_manifest_digest: "c".repeat(64),
        },
      },
      worker_metadata: {
        monitoring_policy: stalePolicy,
        evidence_signature: "e".repeat(64),
      },
    };
    const before = structuredClone(candidate);

    expect(visualReviewCandidatePolicyFreshness(candidate)).toMatchObject({
      allowed: false,
      reason: "policy_changed_since_batch_submission",
    });
    const shadow = initialDocumentCurrentPolicyShadow(candidate);
    expect(visualReviewCandidatePolicyFreshness(shadow)).toMatchObject({
      allowed: true,
      reason: "current_policy",
    });
    expect(shadow.prompt_payload.monitoring_policy).toEqual(
      currentVisualReviewPolicyIdentity(),
    );
    expect(shadow.worker_metadata.monitoring_policy).toEqual(
      currentVisualReviewPolicyIdentity(),
    );
    expect(shadow.candidate_signature).not.toBe(candidate.candidate_signature);
    expect(shadow.worker_metadata.evidence_signature).toBe(
      candidate.worker_metadata.evidence_signature,
    );
    expect(candidate).toEqual(before);
  });
});
