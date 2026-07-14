import { describe, expect, it } from "vitest";
import { advanceVisualSnapshotPointer } from "./visual-snapshot-pointer.mjs";

describe("visual snapshot pointer CAS", () => {
  it("passes the exact prior row version and reports a lost writer", async () => {
    let call = null;
    const advanced = await advanceVisualSnapshotPointer({
      async rpc(name, args) {
        call = { name, args };
        return { data: false, error: null };
      },
    }, {
      existing: { updated_at: "2026-07-14T20:00:00.000Z" },
      snapshot: { shared_award_source_id: "source-1" },
    });
    expect(advanced).toBe(false);
    expect(call).toEqual({
      name: "advance_shared_award_visual_snapshot",
      args: {
        p_expected_exists: true,
        p_expected_updated_at: "2026-07-14T20:00:00.000Z",
        p_snapshot: { shared_award_source_id: "source-1" },
      },
    });
  });
});
