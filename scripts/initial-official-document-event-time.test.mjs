import { describe, expect, it } from "vitest";
import { initialOfficialDocumentEventTimes } from "./lib/initial-official-document.mjs";

describe("initial official document event timing", () => {
  it("keeps an old retained capture as evidence age but detects a fresh recovery in the current digest window", () => {
    const now = "2026-07-16T23:00:00.000Z";
    const candidateCreatedAt = "2026-07-16T22:45:00.123456+00:00";
    const retainedCaptureAt = "2026-06-21T14:00:00.000Z";
    const times = initialOfficialDocumentEventTimes({
      candidate: {
        created_at: candidateCreatedAt,
        new_snapshot_ref: {
          captured_at: retainedCaptureAt,
        },
        prompt_payload: {
          first_observation_attestation: {
            body: { capture: { captured_at: retainedCaptureAt } },
          },
        },
      },
    });

    const digestCutoff = new Date(Date.parse(now) - 36 * 60 * 60 * 1_000).toISOString();
    expect(times.first_observed_at).toBe(retainedCaptureAt);
    expect(times.detected_at).toBe(candidateCreatedAt);
    expect(times.recognized_at).toBe(times.detected_at);
    expect(times.generated_at).toBe(times.detected_at);
    expect(Date.parse(times.first_observed_at)).toBeLessThan(Date.parse(digestCutoff));
    expect(Date.parse(times.detected_at)).toBeGreaterThanOrEqual(Date.parse(digestCutoff));
  });

  it("fails closed instead of substituting publication time for a missing recognition time", () => {
    expect(() => initialOfficialDocumentEventTimes({
      candidate: {
        new_snapshot_ref: { captured_at: "2026-06-21T14:00:00.000Z" },
        prompt_payload: {
          first_observation_attestation: {
            body: { capture: { captured_at: "2026-06-21T14:00:00.000Z" } },
          },
        },
      },
    })).toThrow("Initial official document recognition timestamp is invalid.");
  });

  it("fails closed when a mutable snapshot time disagrees with the attested capture", () => {
    expect(() => initialOfficialDocumentEventTimes({
      candidate: {
        created_at: "2026-07-16T22:45:00.000Z",
        new_snapshot_ref: { captured_at: "2026-07-16T22:40:00.000Z" },
        prompt_payload: {
          first_observation_attestation: {
            body: { capture: { captured_at: "2026-06-21T14:00:00.000Z" } },
          },
        },
      },
    })).toThrow("Initial official document first-observation timestamp binding is invalid.");
  });
});
