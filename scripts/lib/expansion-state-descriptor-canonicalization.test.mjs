import { describe, expect, it } from "vitest";
import {
  canonicalExpansionStateCaptureCoverage,
  canonicalizeExpansionStateDescriptors,
  conservativeExpansionStateCaptureCoverage,
  expansionStateCaptureCoverage,
  expansionStateCaptureCoverageLegacyMirrors,
  expansionStateCaptureBudgetMs,
  legacyExpansionStateCaptureCoverageFromMetadata,
  MAX_EXPANSION_STATE_SCREENSHOTS,
  summarizeExpansionStateCapture,
} from "./expansion-state-descriptor-canonicalization.mjs";

describe("expansion state descriptor canonicalization", () => {
  it("grants expansion time only for discovered logical states and remains capped at 24", () => {
    expect(expansionStateCaptureBudgetMs(0)).toBe(0);
    expect(expansionStateCaptureBudgetMs(1)).toBe(120_000);
    expect(expansionStateCaptureBudgetMs(20)).toBe(1_260_000);
    expect(expansionStateCaptureBudgetMs(24)).toBe(1_500_000);
    expect(expansionStateCaptureBudgetMs(200)).toBe(1_500_000);
    expect(expansionStateCaptureBudgetMs(3, {
      operationTimeoutMs: 10_000,
      perStateTimeoutMs: 5_000,
    })).toBe(25_000);
  });

  it("reduces 33 controls to 16 real logical panels and prefers explicit ARIA controls", () => {
    const descriptors = [];
    for (let index = 1; index <= 16; index += 1) {
      const suffix = String(index);
      const panel = `#elementor-tab-content-${suffix}`;
      const logical = `logical-panels:[${JSON.stringify(panel)}]`;
      descriptors.push({
        selector: `#elementor-tab-title-${suffix}`,
        id: `elementor-tab-title-${suffix}`,
        tag: "DIV",
        role: "button",
        aria_controls: `elementor-tab-content-${suffix}`,
        state_kind: "targets",
        state_key: `targets:${panel}`,
        panel_selectors: [panel],
        logical_state_key: logical,
        logical_panel_valid: true,
      });
      descriptors.push({
        selector: `html>body>main>div:nth-of-type(${suffix})>a`,
        tag: "A",
        state_kind: "adjacent-panel",
        state_key: `adjacent-panel:${panel}`,
        panel_selectors: [panel],
        logical_state_key: logical,
        logical_panel_valid: true,
      });
    }
    descriptors.unshift({
      selector: "#eligibility-jump-link",
      tag: "A",
      href: "#elementor-tab-title-2",
      state_kind: "targets",
      panel_selectors: ["#elementor-tab-title-2"],
      logical_state_key: 'logical-panels:["#elementor-tab-title-2"]',
      logical_panel_valid: false,
    });

    const result = canonicalizeExpansionStateDescriptors({
      descriptors,
      raw_candidates: 33,
      raw_descriptor_set_complete: true,
    }, { maxControls: MAX_EXPANSION_STATE_SCREENSHOTS });

    expect(result).toMatchObject({
      raw_candidates: 33,
      candidates: 16,
      duplicate_controls_removed: 16,
      non_panel_controls_removed: 1,
      capture_limit: 24,
      descriptor_set_complete: true,
      truncated: false,
      truncated_count: 0,
    });
    expect(result.descriptors).toHaveLength(16);
    expect(result.descriptors.every((descriptor) =>
      descriptor.state_kind === "targets" &&
      descriptor.role === "button" &&
      descriptor.aria_controls)).toBe(true);
  });

  it("caps logical panels at 24 and never calls an incomplete raw scan complete", () => {
    const descriptor = (index) => ({
      selector: `#control-${index}`,
      logical_state_key: `logical-panel-${index}`,
      panel_selectors: [`#panel-${index}`],
      logical_panel_valid: true,
    });
    const complete = canonicalizeExpansionStateDescriptors({
      descriptors: Array.from({ length: 25 }, (_, index) => descriptor(index)),
      raw_descriptor_set_complete: true,
    }, { maxControls: 100 });
    expect(complete).toMatchObject({
      candidates: 25,
      capture_limit: 24,
      descriptor_set_complete: false,
      truncated: true,
      truncated_count: 1,
      truncated_count_exact: true,
    });
    expect(complete.descriptors).toHaveLength(24);
    expect(complete.isolation_descriptors).toHaveLength(25);
    expect(complete.isolation_descriptor_set_complete).toBe(true);

    const incomplete = canonicalizeExpansionStateDescriptors({
      descriptors: Array.from({ length: 20 }, (_, index) => descriptor(index)),
      raw_candidates: 700,
      raw_descriptor_set_complete: false,
    }, { maxControls: 24 });
    expect(incomplete).toMatchObject({
      candidates: 20,
      candidate_count_exact: false,
      descriptor_set_complete: false,
      truncated: true,
      truncated_count: 0,
      truncated_count_exact: false,
      isolation_descriptor_set_complete: false,
    });
    expect(incomplete.isolation_descriptors).toHaveLength(20);
  });

  it("requires one retained state per attempted logical panel before reporting complete", () => {
    const setup = canonicalizeExpansionStateDescriptors({
      descriptors: Array.from({ length: 20 }, (_, index) => ({
        selector: `#control-${index}`,
        logical_state_key: `logical-panel-${index}`,
        panel_selectors: [`#panel-${index}`],
        logical_panel_valid: true,
      })),
      raw_descriptor_set_complete: true,
    }, { maxControls: 24 });

    expect(summarizeExpansionStateCapture(setup, {
      states: Array.from({ length: 20 }, () => ({})),
      failures: [],
    })).toMatchObject({
      candidates: 20,
      attempted: 20,
      capture_complete: true,
      capture_status: "verified_complete",
    });
    expect(summarizeExpansionStateCapture(setup, {
      states: Array.from({ length: 19 }, () => ({})),
      failures: [{ selector: "#control-19" }],
    })).toMatchObject({
      candidates: 20,
      attempted: 20,
      capture_complete: false,
      capture_status: "incomplete_failures",
    });
  });

  it("treats omitted discovery exactness markers as incomplete", () => {
    const setup = canonicalizeExpansionStateDescriptors({
      descriptors: [{
        selector: "#control",
        logical_state_key: "logical-panel",
        panel_selectors: ["#panel"],
        logical_panel_valid: true,
      }],
    }, { maxControls: 24 });

    expect(setup).toMatchObject({
      raw_descriptor_set_complete: false,
      candidate_count_exact: false,
      isolation_descriptor_set_complete: false,
      descriptor_set_complete: false,
      truncated: true,
      truncated_count_exact: false,
    });
    expect(summarizeExpansionStateCapture(setup, {
      states: [{}],
      failures: [],
    })).toMatchObject({
      candidate_count_exact: false,
      capture_complete: false,
      capture_status: "incomplete_discovery",
      truncated_count_exact: false,
    });

    expect(summarizeExpansionStateCapture({
      descriptors: [{}],
      candidates: 1,
      descriptor_set_complete: true,
      raw_descriptor_set_complete: true,
      truncated: false,
      truncated_count: 0,
      truncated_count_exact: true,
    }, {
      states: [{}],
      failures: [],
    })).toMatchObject({
      candidate_count_exact: false,
      capture_complete: false,
      capture_status: "incomplete_discovery",
    });
  });

  it("persists a complete verdict only when discovery, attempts, retention, and failures all agree", () => {
    const complete = expansionStateCaptureCoverage({
      raw_candidates: 41,
      raw_candidate_count_exact: true,
      candidates: 20,
      candidate_count_exact: true,
      attempted: 20,
      capture_limit: 24,
      capture_complete: true,
      capture_status: "verified_complete",
      truncated: false,
      truncated_count: 0,
      truncated_count_exact: true,
      failures: [],
      states: Array.from({ length: 20 }, () => ({})),
    });

    expect(canonicalExpansionStateCaptureCoverage(complete, {
      expectedRetainedStateCount: 20,
    })).toEqual(complete);
    expect(complete).toMatchObject({
      complete: true,
      status: "verified_complete",
      raw_candidate_count: 41,
      logical_candidate_count: 20,
      attempted_count: 20,
      retained_state_count: 20,
      failure_count: 0,
    });
  });

  it("fails closed for truncated, failed, and post-projection partial captures", () => {
    const truncated = expansionStateCaptureCoverage({
      raw_candidates: 30,
      raw_candidate_count_exact: true,
      candidates: 30,
      candidate_count_exact: true,
      attempted: 24,
      capture_limit: 24,
      capture_complete: false,
      capture_status: "incomplete_truncated",
      truncated: true,
      truncated_count: 6,
      truncated_count_exact: true,
      failures: [],
      states: Array.from({ length: 24 }, () => ({})),
    });
    const failed = expansionStateCaptureCoverage({
      raw_candidates: 2,
      raw_candidate_count_exact: true,
      candidates: 2,
      candidate_count_exact: true,
      attempted: 2,
      capture_limit: 24,
      capture_complete: false,
      capture_status: "incomplete_failures",
      truncated: false,
      truncated_count: 0,
      truncated_count_exact: true,
      failures: [{}],
      states: [{}],
    });
    const projectedPartial = expansionStateCaptureCoverage({
      ...expansionStateCaptureCoverage({
        raw_candidates: 2,
        raw_candidate_count_exact: true,
        candidates: 2,
        candidate_count_exact: true,
        attempted: 2,
        capture_limit: 24,
        capture_complete: true,
        capture_status: "verified_complete",
        truncated: false,
        truncated_count: 0,
        truncated_count_exact: true,
        failures: [],
        states: [{}, {}],
      }),
    }, { retainedStateCount: 1 });

    expect(truncated).toMatchObject({
      complete: false,
      status: "incomplete_truncated",
      retained_state_count: 24,
    });
    expect(failed).toMatchObject({
      complete: false,
      status: "incomplete_failures",
      failure_count: 1,
      retained_state_count: 1,
    });
    expect(projectedPartial).toMatchObject({
      complete: false,
      status: "incomplete_state_count",
      attempted_count: 2,
      retained_state_count: 1,
    });
    expect(expansionStateCaptureCoverageLegacyMirrors(projectedPartial)).toMatchObject({
      expansion_state_capture_complete: false,
      expansion_state_capture_status: "incomplete_state_count",
      expansion_state_attempted: 2,
    });
  });

  it("validates legacy scalars conservatively and never promotes them from retained count", () => {
    const legacy = {
      expansion_state_candidates: 1,
      expansion_state_attempted: 1,
      expansion_state_capture_limit: 24,
      expansion_state_capture_complete: true,
      expansion_state_capture_status: "verified_complete",
      expansion_state_raw_candidates: 2,
      expansion_state_candidate_count_exact: true,
      expansion_state_truncated: false,
      expansion_state_truncated_count: 0,
      expansion_state_truncated_count_exact: true,
      expansion_state_failures: [],
      expansion_state_count: 1,
      expansion_state_screenshots: [{}],
    };
    expect(legacyExpansionStateCaptureCoverageFromMetadata(legacy, {
      retainedStateCount: 1,
    })).toMatchObject({
      complete: false,
      status: "incomplete_discovery",
      retained_state_count: 1,
    });
    const legacyV0 = {
      expansion_state_candidates: 1,
      expansion_state_attempted: 1,
      expansion_state_capture_limit: 24,
      expansion_state_capture_complete: true,
      expansion_state_truncated: false,
      expansion_state_truncated_count: 0,
      expansion_state_failures: [],
      expansion_state_count: 1,
      expansion_state_screenshots: [{}],
    };
    expect(legacyExpansionStateCaptureCoverageFromMetadata(legacyV0, {
      retainedStateCount: 1,
    })).toMatchObject({
      complete: false,
      status: "incomplete_discovery",
      raw_candidate_count_exact: false,
      logical_candidate_count_exact: false,
      retained_state_count: 1,
    });
    expect(legacyExpansionStateCaptureCoverageFromMetadata({
      expansion_state_count: 1,
      expansion_state_screenshots: [{}],
    }, { retainedStateCount: 1 })).toBeNull();
    expect(legacyExpansionStateCaptureCoverageFromMetadata({
      ...legacy,
      expansion_state_failures: [{}],
    }, { retainedStateCount: 1 })).toMatchObject({
      complete: false,
      status: "incomplete_discovery",
      failure_count: 1,
    });

    const conservative = conservativeExpansionStateCaptureCoverage({
      retainedStateCount: 1,
    });
    expect(conservative).toMatchObject({
      complete: false,
      status: "incomplete_discovery",
      raw_candidate_count_exact: false,
      logical_candidate_count_exact: false,
      retained_state_count: 1,
    });
    expect(legacyExpansionStateCaptureCoverageFromMetadata({
      ...legacy,
      expansion_state_capture_coverage: conservative,
    }, { retainedStateCount: 1 })).toBeNull();

    const canonicalComplete = expansionStateCaptureCoverage({
      raw_candidates: 2,
      raw_candidate_count_exact: true,
      candidates: 1,
      candidate_count_exact: true,
      attempted: 1,
      capture_limit: 24,
      capture_complete: true,
      capture_status: "verified_complete",
      truncated: false,
      truncated_count: 0,
      truncated_count_exact: true,
      failures: [],
      states: [{}],
    });
    expect(legacyExpansionStateCaptureCoverageFromMetadata({
      ...legacy,
      expansion_state_capture_coverage: canonicalComplete,
    }, { retainedStateCount: 1 })).toMatchObject({
      complete: true,
      status: "verified_complete",
    });
  });
});
