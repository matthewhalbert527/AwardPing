import { describe, expect, it } from "vitest";
import {
  monitoringPolicySweepCursorAfterRows,
  monitoringPolicySweepKey,
  monitoringPolicySweepKeysetFilter,
  monitoringPolicySweepStart,
} from "./change-event-sweep-state.mjs";

describe("monitoring policy sweep state", () => {
  const state = {
    policy_hash: "policy-one",
    cursor_detected_at: "2026-07-14T18:00:00.000Z",
    cursor_event_id: "00000000-0000-0000-0000-000000000123",
    scanned_count: 500,
  };

  it("resumes from a durable keyset cursor for the same effective policy", () => {
    expect(monitoringPolicySweepStart(state, "policy-one")).toEqual({
      reset: false,
      cursor: {
        detected_at: state.cursor_detected_at,
        event_id: state.cursor_event_id,
      },
      scanned_count: 500,
    });
  });

  it("restarts from the oldest event when the effective policy changes", () => {
    expect(monitoringPolicySweepStart(state, "policy-two")).toEqual({
      reset: true,
      cursor: null,
      scanned_count: 0,
    });
  });

  it("builds a deterministic timestamp-and-id keyset filter", () => {
    expect(
      monitoringPolicySweepKeysetFilter({
        detected_at: state.cursor_detected_at,
        event_id: state.cursor_event_id,
      }),
    ).toBe(
      `detected_at.gt.${state.cursor_detected_at},and(detected_at.eq.${state.cursor_detected_at},id.gt.${state.cursor_event_id})`,
    );
  });

  it("advances across bounded windows without returning to the newest rows", () => {
    const first = monitoringPolicySweepCursorAfterRows([
      { detected_at: "2026-07-01T00:00:00.000Z", id: "event-1" },
      { detected_at: "2026-07-02T00:00:00.000Z", id: "event-2" },
    ]);
    const second = monitoringPolicySweepCursorAfterRows([
      { detected_at: "2026-07-03T00:00:00.000Z", id: "event-3" },
    ], first);

    expect(first).toEqual({
      detected_at: "2026-07-02T00:00:00.000Z",
      event_id: "event-2",
    });
    expect(second).toEqual({
      detected_at: "2026-07-03T00:00:00.000Z",
      event_id: "event-3",
    });
  });

  it("uses distinct state keys for filtered sweeps", () => {
    expect(monitoringPolicySweepKey()).toBe(
      "change-event-noise:all-awards:all-sources",
    );
    expect(monitoringPolicySweepKey({ awardId: "award-1", sourceId: "source-1" })).toBe(
      "change-event-noise:award-1:source-1",
    );
  });
});
