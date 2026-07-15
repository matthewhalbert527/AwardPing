import { describe, expect, it } from "vitest";
import { deterministicNoiseBaselineDisposition } from "./deterministic-noise-disposition.mjs";

describe("deterministic noise baseline disposition", () => {
  it("advances a safe deterministic-noise baseline during a normal promoted scan", () => {
    expect(deterministicNoiseBaselineDisposition()).toEqual({
      advance: true,
      reason: "safe_deterministic_noise",
    });
  });

  it("never advances source-rejected evidence even when text-noise acceptance is enabled", () => {
    expect(
      deterministicNoiseBaselineDisposition({
        sourceRejected: true,
        promote: true,
        acceptTextOnlyNoise: true,
      }),
    ).toEqual({
      advance: false,
      reason: "source_rejected_preserve_last_known_good",
    });
  });

  it("preserves the last-known-good baseline when promotion is disabled", () => {
    expect(
      deterministicNoiseBaselineDisposition({
        promote: false,
        acceptTextOnlyNoise: false,
      }),
    ).toEqual({
      advance: false,
      reason: "baseline_promotion_disabled",
    });
  });

  it("does not promote when 24 noise sections were checked but a 25th change is unevaluated", () => {
    expect(
      deterministicNoiseBaselineDisposition({
        comparisonComplete: false,
        promote: true,
      }),
    ).toEqual({
      advance: false,
      reason: "unevaluated_evidence_preserve_last_known_good",
    });
  });
});
