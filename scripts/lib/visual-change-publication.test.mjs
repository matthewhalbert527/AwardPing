import { describe, expect, it } from "vitest";
import { persistVisualChangeAndReconciliation } from "./visual-change-publication.mjs";

describe("visual change publication", () => {
  it("recovers a crash after event insertion by resolving the duplicate and enqueueing", async () => {
    let event = null;
    let enqueueAttempts = 0;
    const dependencies = {
      upsertEvent: async () => {
        if (event) return null;
        event = { id: "event-1" };
        return event;
      },
      findExistingEvent: async () => event,
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

  it("does not publish when a duplicate event cannot be resolved", async () => {
    expect(await persistVisualChangeAndReconciliation({
      upsertEvent: async () => null,
      findExistingEvent: async () => null,
      enqueueReconciliation: async () => {
        throw new Error("must not enqueue without an event");
      },
    })).toMatchObject({
      action: "retry",
      reason: "change_event_identity_unresolved",
    });
  });

  it("keeps enqueue failures retryable instead of terminal-publishing", async () => {
    expect(await persistVisualChangeAndReconciliation({
      upsertEvent: async () => ({ id: "event-2" }),
      findExistingEvent: async () => null,
      enqueueReconciliation: async () => {
        throw new Error("queue unavailable");
      },
    })).toMatchObject({
      action: "retry",
      reason: "change_event_publication_error",
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
      upsertEvent: async () => null,
      findExistingEvent: async (receivedIdentity) => {
        resolvedIdentity = receivedIdentity;
        return { id: "event-empty-hashes" };
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
      upsertEvent: async () => ({ id: "event-queue-missing" }),
      findExistingEvent: async () => null,
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
      upsertEvent: async () => ({ id: "event-race" }),
      findExistingEvent: async () => null,
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
