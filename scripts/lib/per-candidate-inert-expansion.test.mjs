import { describe, expect, it } from "vitest";
import {
  stage1ExpansionCaptureCoverageValid,
  summarizeExpansionStateCapture,
} from "./expansion-state-descriptor-canonicalization.mjs";

// Option E (docs/stage1-inert-expansion-candidates.md addendum, adopted
// 2026-09-01): retained states and provably-inert candidates may coexist on
// one page. Modeled on the live evidence that prompted the ruling - AMA's
// physicians-of-tomorrow page: 21 attempted, 15 opened, 6 dead controls.

const inertEntry = (index) => ({
  selector: `#button-example-${index}`,
  label: `Dead accordion ${index}`,
  attempts: 2,
  control_responded: true,
  content_never_visible: true,
});

function mixedMetadata({ retained = 15, inert = 6 } = {}) {
  const attempted = retained + inert;
  return {
    expansion_state_count: retained,
    retained_artifact_projection: {
      authoritative: { expansion_state_count: retained },
    },
    expansion_state_capture_coverage: {
      schema: "awardping.expansion-state-capture-coverage.v1",
      status: "verified_complete",
      complete: true,
      raw_candidate_count: attempted,
      raw_candidate_count_exact: true,
      logical_candidate_count: attempted,
      logical_candidate_count_exact: true,
      attempted_count: attempted,
      retained_state_count: retained,
      capture_limit: 36,
      truncated: false,
      truncated_count: 0,
      truncated_count_exact: true,
      failure_count: 0,
      inert_count: inert,
      inert_candidates: Array.from({ length: inert }, (_, i) => inertEntry(i + 1)),
    },
  };
}

describe("per-candidate inert expansion states (option E)", () => {
  it("accepts a mixed page: retained states alongside proven-inert candidates", () => {
    expect(stage1ExpansionCaptureCoverageValid("webpage", mixedMetadata())).toBe(true);
  });

  it("still accepts the all-inert page option C was adopted for", () => {
    expect(
      stage1ExpansionCaptureCoverageValid("webpage", mixedMetadata({ retained: 0, inert: 6 })),
    ).toBe(true);
  });

  it("keeps every per-candidate proof guardrail", () => {
    const weakProof = mixedMetadata();
    weakProof.expansion_state_capture_coverage.inert_candidates[0].attempts = 1;
    expect(stage1ExpansionCaptureCoverageValid("webpage", weakProof)).toBe(false);

    const unresponsive = mixedMetadata();
    unresponsive.expansion_state_capture_coverage.inert_candidates[0].control_responded = false;
    expect(stage1ExpansionCaptureCoverageValid("webpage", unresponsive)).toBe(false);

    const contentSeen = mixedMetadata();
    contentSeen.expansion_state_capture_coverage.inert_candidates[0].content_never_visible = false;
    expect(stage1ExpansionCaptureCoverageValid("webpage", contentSeen)).toBe(false);
  });

  it("rejects inert counts the proof list does not cover", () => {
    const short = mixedMetadata();
    short.expansion_state_capture_coverage.inert_candidates.pop();
    expect(stage1ExpansionCaptureCoverageValid("webpage", short)).toBe(false);
  });

  it("requires every attempted candidate to be retained or proven inert", () => {
    const unaccounted = mixedMetadata();
    unaccounted.expansion_state_capture_coverage.attempted_count += 1;
    unaccounted.expansion_state_capture_coverage.logical_candidate_count += 1;
    unaccounted.expansion_state_capture_coverage.raw_candidate_count += 1;
    expect(stage1ExpansionCaptureCoverageValid("webpage", unaccounted)).toBe(false);
  });

  it("summarizes a mixed page as verified_complete", () => {
    const summary = summarizeExpansionStateCapture(
      {
        descriptors: Array.from({ length: 21 }, (_, i) => ({ selector: `#d${i}` })),
        candidates: 21,
        descriptor_set_complete: true,
        raw_descriptor_set_complete: true,
        candidate_count_exact: true,
        truncated: false,
      },
      {
        states: Array.from({ length: 15 }, (_, i) => ({ state_id: `expansion-state-${String(i + 1).padStart(2, "0")}` })),
        failures: [],
        attempted: 21,
        inert: Array.from({ length: 6 }, (_, i) => inertEntry(i + 1)),
      },
    );
    expect(summary.capture_status).toBe("verified_complete");
    expect(summary.capture_complete).toBe(true);
  });

  it("keeps a mixed page with real failures incomplete", () => {
    const summary = summarizeExpansionStateCapture(
      {
        descriptors: Array.from({ length: 21 }, (_, i) => ({ selector: `#d${i}` })),
        candidates: 21,
        descriptor_set_complete: true,
        raw_descriptor_set_complete: true,
        candidate_count_exact: true,
        truncated: false,
      },
      {
        states: Array.from({ length: 14 }, (_, i) => ({ state_id: `expansion-state-${String(i + 1).padStart(2, "0")}` })),
        failures: [{ selector: "#broken", error: "bound_content_did_not_transition" }],
        attempted: 21,
        inert: Array.from({ length: 6 }, (_, i) => inertEntry(i + 1)),
      },
    );
    expect(summary.capture_complete).toBe(false);
    expect(summary.capture_status).toBe("incomplete_failures");
  });
});
