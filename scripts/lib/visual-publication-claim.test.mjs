import { describe, expect, it } from "vitest";
import {
  acquireVisualReviewPublicationClaim,
  visualReviewPublicationClaimDecision,
} from "./visual-publication-claim.mjs";

describe("visual review publication claims", () => {
  it("allows only one of two completed-result pollers to claim side effects", async () => {
    let stored = candidateFixture();
    const firstObservation = structuredClone(stored);
    const secondObservation = structuredClone(stored);
    const compareAndSet = async ({ expected, patch }) => {
      if (
        stored.id !== expected.id ||
        stored.status !== expected.status ||
        stored.updated_at !== expected.updated_at
      ) return null;
      stored = { ...stored, ...patch };
      return structuredClone(stored);
    };

    const [first, second] = await Promise.all([
      acquireVisualReviewPublicationClaim({
        candidate: firstObservation,
        claimToken: "poller-a",
        now: "2026-07-14T21:00:00.000Z",
        candidatePatch: {
          ai_result: { is_true_change: true },
          actual_usage: { total_token_count: 42 },
        },
        compareAndSet,
      }),
      acquireVisualReviewPublicationClaim({
        candidate: secondObservation,
        claimToken: "poller-b",
        now: "2026-07-14T21:00:00.001Z",
        candidatePatch: {
          ai_result: { is_true_change: true },
          actual_usage: { total_token_count: 42 },
        },
        compareAndSet,
      }),
    ]);

    expect([first.acquired, second.acquired].filter(Boolean)).toHaveLength(1);
    expect([first, second].find((result) => !result.acquired)?.decision).toEqual({
      action: "conflict",
      reason: "publication_claim_compare_and_set_lost",
    });
    expect(stored.status).toBe("succeeded");
    expect(stored).toMatchObject({
      ai_result: { is_true_change: true },
      actual_usage: { total_token_count: 42 },
    });
    expect(["poller-a", "poller-b"]).toContain(
      stored.worker_metadata.publication_claim_token,
    );
  });

  it("blocks an active claim and permits guarded stale recovery", async () => {
    const active = candidateFixture({
      status: "succeeded",
      updated_at: "2026-07-14T21:00:00.000Z",
      worker_metadata: {
        publication_claim_token: "old-worker",
        publication_claimed_at: "2026-07-14T21:00:00.000Z",
      },
    });
    expect(visualReviewPublicationClaimDecision(active, {
      now: "2026-07-14T21:10:00.000Z",
      staleAfterMs: 30 * 60_000,
    })).toMatchObject({ action: "conflict", reason: "publication_claim_active" });

    let stored = structuredClone(active);
    const recovered = await acquireVisualReviewPublicationClaim({
      candidate: active,
      claimToken: "recovery-worker",
      now: "2026-07-14T21:31:00.000Z",
      staleAfterMs: 30 * 60_000,
      compareAndSet: async ({ expected, patch }) => {
        if (stored.updated_at !== expected.updated_at) return null;
        stored = { ...stored, ...patch };
        return structuredClone(stored);
      },
    });
    expect(recovered).toMatchObject({ acquired: true, recovered: true });
    expect(stored.worker_metadata).toMatchObject({
      publication_claim_token: "recovery-worker",
      stale_publication_claim_token: "old-worker",
      publication_claim_recovered_at: "2026-07-14T21:31:00.000Z",
    });
  });

  it("recovers a malformed column claim that has no matching claim timestamp", () => {
    expect(visualReviewPublicationClaimDecision(candidateFixture({
      status: "succeeded",
      publication_claim_token: "crashed-between-columns",
      publication_claimed_at: null,
      updated_at: "2026-07-14T21:00:00.000Z",
    }), {
      now: "2026-07-14T21:00:01.000Z",
      staleAfterMs: 30 * 60_000,
    })).toMatchObject({
      action: "recover",
      reason: "publication_claim_stale",
      stale_claim_token: "crashed-between-columns",
    });
  });

  it("serializes distinct candidates that target the same source", async () => {
    const rows = new Map([
      ["candidate-a", candidateFixture({ id: "candidate-a", shared_award_source_id: "source-1" })],
      ["candidate-b", candidateFixture({ id: "candidate-b", shared_award_source_id: "source-1" })],
    ]);
    const compareAndSet = async ({ expected, patch }) => {
      const current = rows.get(expected.id);
      if (
        !current ||
        current.status !== expected.status ||
        current.updated_at !== expected.updated_at
      ) return null;
      const sourceClaimed = [...rows.values()].some((row) =>
        row.id !== expected.id &&
        row.shared_award_source_id === current.shared_award_source_id &&
        row.publication_claim_token,
      );
      if (sourceClaimed) return null; // Mirrors the partial UNIQUE index conflict.
      const updated = { ...current, ...patch };
      rows.set(expected.id, updated);
      return structuredClone(updated);
    };

    const first = await acquireVisualReviewPublicationClaim({
      candidate: structuredClone(rows.get("candidate-a")),
      claimToken: "source-owner",
      compareAndSet,
    });
    const second = await acquireVisualReviewPublicationClaim({
      candidate: structuredClone(rows.get("candidate-b")),
      claimToken: "source-contender",
      compareAndSet,
    });
    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({
      acquired: false,
      decision: {
        action: "conflict",
        reason: "publication_claim_compare_and_set_lost",
      },
    });
    expect(rows.get("candidate-b").publication_claim_token).toBeUndefined();
  });
});

function candidateFixture(overrides = {}) {
  return {
    id: "candidate-1",
    status: "processing",
    updated_at: "2026-07-14T20:59:00.000Z",
    rejection_reason: null,
    worker_metadata: {},
    ...overrides,
  };
}
