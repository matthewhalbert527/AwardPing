import { describe, expect, it, vi } from "vitest";
import {
  reconcileVisualSnapshotPointerAdvance,
  visualSnapshotPointerExactlyMatchesProposal,
} from "./visual-snapshot-pointer-reconciliation.mjs";

function pointer(overrides = {}) {
  return {
    shared_award_source_id: "source-1",
    shared_award_id: "award-1",
    source_url: "https://example.test/award",
    source_title: "Eligibility",
    source_page_type: "eligibility",
    kind: "webpage",
    bucket: "evidence",
    latest_captured_at: "2026-08-14T18:00:00.000Z",
    latest_object_keys: { page: "generation-3/page.jpg" },
    latest_hashes: { image_hash: "new-image" },
    latest_metadata: { capture_profile: "baseline-rich" },
    previous_captured_at: "2026-08-13T18:00:00.000Z",
    previous_object_keys: { page: "generation-2/page.jpg" },
    previous_hashes: { image_hash: "prior-image" },
    previous_metadata: { capture_profile: "baseline-rich" },
    updated_at: "2026-08-14T18:01:00.000Z",
    ...overrides,
  };
}

describe("visual snapshot pointer reconciliation", () => {
  it("commits ordinary rotation without deleting displaced evidence with unknown cross-record references", async () => {
    const existing = pointer({ latest_object_keys: { page: "generation-2/page.jpg" },
      previous_object_keys: { page: "stage1-original/page.jpg" } });
    const proposed = pointer(), before = structuredClone({ existing, proposed });
    const cleanup = vi.fn(), reload = vi.fn();
    const result = await reconcileVisualSnapshotPointerAdvance({ advance: async () => true, reload, cleanup,
      existing, proposed, uploaded: proposed.latest_object_keys });
    expect(result).toMatchObject({ committed: true, reconciled_after_ambiguous_error: false,
      cleanup: { attempted: 0, deleted: 0, failed: 0, failures: [] } });
    expect(cleanup).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect({ existing, proposed }).toEqual(before);
  });

  it("treats an RPC error followed by the exact proposed pointer as committed", async () => {
    const existing = pointer({
      latest_object_keys: { page: "generation-2/page.jpg" },
      previous_object_keys: { page: "generation-1/page.jpg" },
    });
    const proposed = pointer();
    const cleanup = vi.fn(async () => {
      throw new Error("R2 delete unavailable");
    });

    const result = await reconcileVisualSnapshotPointerAdvance({
      advance: async () => { throw new Error("RPC response was lost"); },
      reload: async () => ({
        ...proposed,
        latest_captured_at: "2026-08-14T18:00:00+00:00",
      }),
      cleanup,
      existing,
      proposed,
      uploaded: proposed.latest_object_keys,
    });

    expect(result.committed).toBe(true);
    expect(result.reconciled_after_ambiguous_error).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    expect(result.cleanup).toEqual({ attempted: 0, deleted: 0, failed: 0, failures: [] });
  });

  it("never deletes any upload after false CAS, even when absent from the winning pointer", async () => {
    const cleanup = vi.fn(async (keys) => ({
      attempted: keys.length,
      deleted: 0,
      failed: keys.length,
      failures: keys.map((key) => ({ key, message: "delete failed" })),
    }));
    const uploaded = {
      page: "loser/page.jpg",
      text: "winner/text.txt",
    };

    await expect(reconcileVisualSnapshotPointerAdvance({
      advance: async () => false,
      reload: async () => pointer({
        latest_object_keys: { page: "winner/page.jpg", text: "winner/text.txt" },
      }),
      cleanup,
      existing: pointer(),
      proposed: pointer({ latest_object_keys: uploaded }),
      uploaded,
    })).rejects.toMatchObject({
      code: "visual_snapshot_pointer_lost_cas",
      r2PointerOutcome: "lost_compare_and_set",
      r2Cleanup: { attempted: 0, deleted: 0, failed: 0, failures: [] },
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("preserves the pointer error without attempting losing-upload deletion", async () => {
    const rpcError = new Error("RPC timed out before a commit");
    const cleanup = vi.fn(async () => { throw new Error("cleanup transport failed"); });
    await expect(reconcileVisualSnapshotPointerAdvance({
      advance: async () => { throw rpcError; },
      reload: async () => pointer({ latest_hashes: { image_hash: "another-writer" } }),
      cleanup,
      existing: pointer(),
      proposed: pointer(),
      uploaded: { page: "loser/page.jpg" },
    })).rejects.toMatchObject({
      message: rpcError.message,
      code: "visual_snapshot_pointer_advance_failed",
      r2Cleanup: { attempted: 0, deleted: 0, failed: 0, failures: [] },
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("defers deletion and records every uploaded key when the pointer cannot be reloaded", async () => {
    const cleanup = vi.fn();
    await expect(reconcileVisualSnapshotPointerAdvance({
      advance: async () => false,
      reload: async () => { throw new Error("database unavailable"); },
      cleanup,
      existing: null,
      proposed: pointer(),
      uploaded: { page: "upload/page.jpg", text: "upload/text.txt" },
    })).rejects.toMatchObject({
      code: "visual_snapshot_pointer_lost_cas",
      r2PointerReloadError: "database unavailable",
      r2Cleanup: { attempted: 0, failed: 2 },
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("requires an exact full pointer projection before resolving ambiguity", () => {
    const proposed = pointer();
    expect(visualSnapshotPointerExactlyMatchesProposal({
      ...proposed,
      updated_at: "2026-08-14T13:01:00-05:00",
    }, proposed)).toBe(true);
    expect(visualSnapshotPointerExactlyMatchesProposal({
      ...proposed,
      latest_metadata: { capture_profile: "different" },
    }, proposed)).toBe(false);
  });
});
