import { describe, expect, it } from "vitest";
import { visualRejectionLedgerRecord } from "./visual-rejection-ledger.mjs";

const candidate = {
  id: "candidate-1",
  shared_award_source_id: "source-1",
  previous_text_hash: "old-text",
  new_text_hash: "new-text",
  previous_image_hash: "old-image",
  new_image_hash: "new-image",
  previous_file_hash: null,
  new_file_hash: null,
  deterministic_classification: "applicant_fact_change",
  deterministic_diff: {
    added_text: ["Application deadline: March 15, 2027"],
    removed_text: ["Application deadline: March 1, 2027"],
  },
  previous_snapshot_ref: {
    local_paths: { thumb: { path: "capture/previous-thumb.jpg" } },
  },
  new_snapshot_ref: {
    local_paths: { thumb: { path: "capture/new-thumb.jpg" } },
  },
  prompt_payload: {
    behavior_version: 6,
  },
};

describe("visual rejection comparison ledger", () => {
  it("stores stable rejected comparison evidence without a public baseline replacement", () => {
    const row = visualRejectionLedgerRecord({
      candidate,
      policyIdentity: { id: "policy-one", version: "1", hash: "hash-one" },
      rejectionReason: "policy_flag_no_actual_changed_fact",
      now: "2026-07-14T20:00:00.000Z",
    });

    expect(row).toMatchObject({
      shared_award_source_id: "source-1",
      candidate_id: "candidate-1",
      policy_id: "policy-one",
      policy_hash: "hash-one",
      rejection_reason: "policy_flag_no_actual_changed_fact",
      previous_text_hash: "old-text",
      new_text_hash: "new-text",
      first_rejected_at: "2026-07-14T20:00:00.000Z",
      last_seen_at: "2026-07-14T20:00:00.000Z",
      seen_count: 1,
    });
    expect(row.evidence_signature).toHaveLength(64);
    expect(row.comparison_snapshot_ref).toEqual({
      previous_snapshot_ref: candidate.previous_snapshot_ref,
      rejected_snapshot_ref: candidate.new_snapshot_ref,
    });
    expect(row).not.toHaveProperty("baseline_snapshot_ref");
    expect(row).not.toHaveProperty("promoted_to_baseline");
  });

  it("keeps evidence identity stable while policy versions remain separate ledger entries", () => {
    const first = visualRejectionLedgerRecord({
      candidate,
      policyIdentity: { id: "policy-one", version: "1", hash: "hash-one" },
      rejectionReason: "policy_rejected",
    });
    const second = visualRejectionLedgerRecord({
      candidate,
      policyIdentity: { id: "policy-two", version: "2", hash: "hash-two" },
      rejectionReason: "policy_rejected",
    });

    expect(second.evidence_signature).toBe(first.evidence_signature);
    expect(second.policy_hash).not.toBe(first.policy_hash);
  });
});
