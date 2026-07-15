import { describe, expect, it } from "vitest";
import { persistVisualChangeAndReconciliation } from "./visual-change-publication.mjs";

describe("visual change publication", () => {
  it("recovers after durable event evidence exists but reconciliation was interrupted", async () => {
    let enqueueAttempts = 0;
    const dependencies = {
      publishEventWithEvidence: async () => ({
        change_event_id: "event-1",
        evidence_id: "event-1",
        inserted: enqueueAttempts === 0,
      }),
      enqueueReconciliation: async () => {
        enqueueAttempts += 1;
        return enqueueAttempts === 1 ? null : { queued: true, id: "queue-1" };
      },
    };

    const interrupted = await persistVisualChangeAndReconciliation(dependencies);
    expect(interrupted).toMatchObject({
      action: "retry",
      reason: "award_reconciliation_enqueue_failed",
      event_id: "event-1",
      evidence_id: "event-1",
      duplicate: false,
    });

    const recovered = await persistVisualChangeAndReconciliation(dependencies);
    expect(recovered).toMatchObject({
      action: "publish",
      event_id: "event-1",
      duplicate: true,
      reconciliation: { queued: true },
    });
  });

  it("does not publish when the atomic publication has no immutable evidence row", async () => {
    expect(await persistVisualChangeAndReconciliation({
      publishEventWithEvidence: async () => ({
        change_event_id: "event-without-evidence",
        evidence_id: null,
        inserted: true,
      }),
      enqueueReconciliation: async () => {
        throw new Error("must not enqueue without evidence");
      },
    })).toMatchObject({
      action: "retry",
      reason: "change_event_evidence_not_durable",
      event_id: "event-without-evidence",
    });
  });

  it("keeps enqueue failures retryable instead of terminal-publishing", async () => {
    expect(await persistVisualChangeAndReconciliation({
      publishEventWithEvidence: async () => ({
        change_event_id: "event-2",
        evidence_id: "event-2",
        inserted: true,
      }),
      enqueueReconciliation: async () => {
        throw new Error("queue unavailable");
      },
    })).toMatchObject({
      action: "retry",
      reason: "award_reconciliation_enqueue_error",
      event_id: "event-2",
      error: "queue unavailable",
    });
  });

  it("preserves empty-string hashes when resolving a duplicate non-null identity", async () => {
    const identity = {
      shared_award_id: "award-1",
      source_url: "https://example.edu/award",
      previous_hash: "",
      new_hash: "",
    };
    let resolvedIdentity = null;
    const result = await persistVisualChangeAndReconciliation({
      eventIdentity: identity,
      publishEventWithEvidence: async (receivedIdentity) => {
        resolvedIdentity = receivedIdentity;
        return {
          change_event_id: "event-empty-hashes",
          evidence_id: "event-empty-hashes",
          inserted: false,
        };
      },
      enqueueReconciliation: async () => ({ queued: true, id: "queue-empty" }),
    });
    expect(resolvedIdentity).toEqual(identity);
    expect(result).toMatchObject({
      action: "publish",
      event_id: "event-empty-hashes",
      duplicate: true,
    });
  });

  it("retries when the reconciliation queue is unavailable", async () => {
    expect(await persistVisualChangeAndReconciliation({
      publishEventWithEvidence: async () => ({
        change_event_id: "event-queue-missing",
        evidence_id: "event-queue-missing",
        inserted: true,
      }),
      enqueueReconciliation: async () => ({
        queued: false,
        reason: "queue_table_missing",
      }),
    })).toMatchObject({
      action: "retry",
      reason: "queue_table_missing",
      event_id: "event-queue-missing",
    });
  });

  it("retries a raced coalesce until the durable queue row ID resolves", async () => {
    expect(await persistVisualChangeAndReconciliation({
      publishEventWithEvidence: async () => ({
        change_event_id: "event-race",
        evidence_id: "event-race",
        inserted: true,
      }),
      enqueueReconciliation: async () => ({
        queued: false,
        coalesced: true,
        id: null,
      }),
    })).toMatchObject({
      action: "retry",
      reason: "award_reconciliation_enqueue_failed",
      event_id: "event-race",
    });
  });
});
