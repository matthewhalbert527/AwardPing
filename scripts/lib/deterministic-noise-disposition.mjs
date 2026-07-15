export function deterministicNoiseBaselineDisposition({
  sourceRejected = false,
  promote = true,
  acceptTextOnlyNoise = false,
  comparisonComplete = true,
} = {}) {
  if (!comparisonComplete) {
    return {
      advance: false,
      reason: "unevaluated_evidence_preserve_last_known_good",
    };
  }

  if (sourceRejected) {
    return {
      advance: false,
      reason: "source_rejected_preserve_last_known_good",
    };
  }

  if (promote || acceptTextOnlyNoise) {
    return {
      advance: true,
      reason: "safe_deterministic_noise",
    };
  }

  return {
    advance: false,
    reason: "baseline_promotion_disabled",
  };
}
