import { describe, expect, it } from "vitest";
import { awardMonitoringPolicy } from "./lib/award-monitoring-policy.mjs";
import {
  buildMonitoringPromotionCanaryReport,
  buildMonitoringPromotionConfiguredRuleDraft,
  buildMonitoringPromotionHashAttestation,
  buildMonitoringPromotionRegressionReport,
  buildMonitoringPromotionRetroactiveSweepReport,
  buildMonitoringPromotionShadowReport,
  canonicalPreciseRfc3339,
  comparePreciseRfc3339,
  currentMonitoringPromotionWorkerIdentity,
} from "./lib/monitoring-feedback-promotion-verification.mjs";

const source = {
  id: "source-one",
  url: "https://example.org/award",
  title: "Example Award",
  page_type: "application",
};
const draftHash = buildMonitoringPromotionConfiguredRuleDraft(
  "fundraising_form_change",
)?.hash;

describe("monitoring feedback promotion verification", () => {
  it("canonicalizes PostgreSQL timestamps without losing microseconds", () => {
    expect(
      canonicalPreciseRfc3339("2026-07-15T20:00:02.123456+00:00"),
    ).toBe("2026-07-15T20:00:02.123456Z");
    expect(canonicalPreciseRfc3339("2026-07-15T20:00:02.1Z")).toBe(
      "2026-07-15T20:00:02.100000Z",
    );
    expect(
      canonicalPreciseRfc3339("2026-07-15T20:00:02.1+01:30"),
    ).toBe("2026-07-15T18:30:02.100000Z");
  });

  it("compares exact microsecond instants and equivalent offsets", () => {
    expect(
      comparePreciseRfc3339(
        "2026-07-15T20:00:02.000001Z",
        "2026-07-15T20:00:02.000000+00:00",
      ),
    ).toBe(1);
    expect(
      comparePreciseRfc3339(
        "2026-07-15T20:00:02.123456+01:30",
        "2026-07-15T18:30:02.123456Z",
      ),
    ).toBe(0);
  });

  it("rejects malformed or non-existent timestamp values", () => {
    for (const value of [
      "2026-02-29T20:00:02Z",
      "2026-07-15T24:00:02Z",
      "2026-07-15T20:00:02.1234567Z",
      "2026-07-15T20:00:02+00:60",
      "2026-07-15T20:00:02",
    ]) {
      expect(canonicalPreciseRfc3339(value)).toBeNull();
      expect(comparePreciseRfc3339(value, "2026-07-15T20:00:02Z")).toBeNull();
    }
  });

  it("builds a deterministic behavior draft that is stable across activation", () => {
    const draft = buildMonitoringPromotionConfiguredRuleDraft(
      "fundraising_form_change",
    );

    expect(draft).toMatchObject({
      rule: {
        id: "fundraising_form_change",
        alert_blocking: true,
      },
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(draft?.rule).not.toHaveProperty("active");
  });

  it("attests the worker revision and all three policy identities", () => {
    const identity = currentMonitoringPromotionWorkerIdentity({
      AWARDPING_WORKER_REVISION: "worker-commit",
    });

    expect(identity).toMatchObject({
      revision: "worker-commit",
      policy_hash: expect.stringMatching(/^fnv1a32x2-utf16:/),
      batch_policy_hash: expect.stringMatching(/^fnv1a32x2-utf16:/),
      suppression_policy_hash: expect.stringMatching(/^fnv1a32x2-utf16:/),
    });
  });

  it("shadow-tests feedback-suppressed evidence without treating it as collateral", () => {
    const feedbackEvent = noiseEvent("feedback-event", { suppressed_at: "2026-07-15T00:00:00Z" });
    const report = withRuleActive(false, () =>
      buildMonitoringPromotionShadowReport({
        clusterKey: "cluster-one",
        ruleId: "fundraising_form_change",
        draftHash,
        feedbackEventIds: [feedbackEvent.id],
        events: [feedbackEvent, legitimateEvent("real-update")],
        sourcesById: new Map([[source.id, source]]),
      }),
    );

    expect(report).toMatchObject({
      status: "passed",
      recurrence_matches: 1,
      legitimate_updates_suppressed: 0,
    });
    expect(report.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("counts duplicate feedback rows for one event as one shadow obligation", () => {
    const feedbackEvent = noiseEvent("shared-feedback-event", {
      suppressed_at: "2026-07-15T00:00:00Z",
    });
    const report = withRuleActive(false, () =>
      buildMonitoringPromotionShadowReport({
        clusterKey: "cluster-one",
        ruleId: "fundraising_form_change",
        draftHash,
        feedbackEventIds: [feedbackEvent.id, feedbackEvent.id],
        events: [feedbackEvent],
        sourcesById: new Map([[source.id, source]]),
      }),
    );

    expect(report).toMatchObject({
      status: "passed",
      feedback_event_count: 1,
      feedback_event_ids: [feedbackEvent.id],
      recurrence_matches: 1,
      matched_feedback_event_ids: [feedbackEvent.id],
    });
  });

  it("fails shadow testing and exposes legitimate collateral", () => {
    const collateral = noiseEvent("collateral");
    const report = withRuleActive(false, () =>
      buildMonitoringPromotionShadowReport({
        clusterKey: "cluster-one",
        ruleId: "fundraising_form_change",
        draftHash,
        feedbackEventIds: ["feedback-event"],
        events: [noiseEvent("feedback-event", { suppressed_at: "2026-07-15T00:00:00Z" }), collateral],
        sourcesById: new Map([[source.id, source]]),
      }),
    );

    expect(report.status).toBe("failed");
    expect(report.legitimate_updates_suppressed).toBe(1);
    expect(report.legitimate_updates[0]).toMatchObject({ event_id: "collateral" });
  });

  it("requires both positive and negative regression fixtures", () => {
    const { passed, incomplete } = withRuleActive(false, () => ({
      passed: buildMonitoringPromotionRegressionReport({
        clusterKey: "cluster-one",
        ruleId: "fundraising_form_change",
        draftHash,
        positiveFixtures: [noiseEvent("positive")],
        negativeFixtures: [legitimateEvent("negative")],
        sourcesById: new Map([[source.id, source]]),
      }),
      incomplete: buildMonitoringPromotionRegressionReport({
        clusterKey: "cluster-one",
        ruleId: "fundraising_form_change",
        draftHash,
        positiveFixtures: [noiseEvent("positive")],
        negativeFixtures: [],
        sourcesById: new Map([[source.id, source]]),
      }),
    }));

    expect(passed.status).toBe("passed");
    expect(incomplete.status).toBe("failed");
  });

  it("deduplicates and sorts regression positives by immutable event ID", () => {
    const eventA = noiseEvent("10000000-0000-4000-8000-000000000002");
    const eventB = noiseEvent("10000000-0000-4000-8000-000000000001");
    const report = withRuleActive(false, () =>
      buildMonitoringPromotionRegressionReport({
        clusterKey: "cluster-one",
        ruleId: "fundraising_form_change",
        draftHash,
        positiveFixtures: [eventA, eventB, { ...eventA }],
        negativeFixtures: [
          legitimateEvent("10000000-0000-4000-8000-000000000003"),
        ],
        sourcesById: new Map([[source.id, source]]),
      }),
    );

    expect(report.positive_fixture_count).toBe(2);
    expect(report.positive_fixture_event_ids).toEqual([
      eventB.id,
      eventA.id,
    ]);
    expect(
      report.fixture_results.filter((fixture) => fixture.expected === "suppressed"),
    ).toHaveLength(2);
  });

  it("checks all three app and worker identities", () => {
    const app = {
      revision: "abc",
      policy_hash: "full",
      batch_policy_hash: "batch",
      suppression_policy_hash: "suppress",
    };
    expect(
      buildMonitoringPromotionHashAttestation({
        clusterKey: "cluster-one",
        ruleId: "fundraising_form_change",
        draftHash,
        app,
        worker: { ...app, revision: "abc" },
        workerRunIds: ["worker-run-one"],
      }).status,
    ).toBe("passed");
    expect(
      buildMonitoringPromotionHashAttestation({
        clusterKey: "cluster-one",
        ruleId: "fundraising_form_change",
        draftHash,
        app,
        worker: { ...app, batch_policy_hash: "stale" },
      }).status,
    ).toBe("failed");
  });

  it("accepts only a complete scheduled three-shard canary with matching hashes", () => {
    const hashes = {
      policy_hash: "full",
      batch_policy_hash: "batch",
      suppression_policy_hash: "suppress",
    };
    const report = withRuleActive(false, () =>
      buildMonitoringPromotionCanaryReport({
        clusterKey: "cluster-one",
        ruleId: "fundraising_form_change",
        draftHash,
        monitoringDate: "2026-07-15",
        scheduledRuns: [0, 1, 2].map((shard) => scheduledRun(shard, hashes)),
        expectedHashes: hashes,
        events: [legitimateEvent("real-update")],
        sourcesById: new Map([[source.id, source]]),
      }),
    );

    expect(report).toMatchObject({
      status: "passed",
      observed_shards: 3,
      completed_shards: 3,
      policy_hashes_match: true,
      legitimate_updates_suppressed: 0,
    });
  });

  it("selects the newest canary run at microsecond precision after its gate", () => {
    const hashes = {
      policy_hash: "full",
      batch_policy_hash: "batch",
      suppression_policy_hash: "suppress",
    };
    const older = {
      ...scheduledRun(0, hashes),
      id: "run-0-older",
      started_at: "2026-07-15T23:00:00.000001Z",
    };
    const newer = {
      ...scheduledRun(0, hashes),
      id: "run-0-newer",
      started_at: "2026-07-15T23:00:00.000002+00:00",
    };
    const report = withRuleActive(false, () =>
      buildMonitoringPromotionCanaryReport({
        clusterKey: "cluster-one",
        ruleId: "fundraising_form_change",
        draftHash,
        monitoringDate: "2026-07-15",
        notBefore: "2026-07-15T23:00:00.000000Z",
        scheduledRuns: [older, newer, scheduledRun(1, hashes), scheduledRun(2, hashes)],
        expectedHashes: hashes,
      }),
    );

    expect(report.status).toBe("passed");
    expect(report.run_ids).toContain("run-0-newer");
    expect(report.run_ids).not.toContain("run-0-older");

    const atBoundary = withRuleActive(false, () =>
      buildMonitoringPromotionCanaryReport({
        clusterKey: "cluster-one",
        ruleId: "fundraising_form_change",
        draftHash,
        monitoringDate: "2026-07-15",
        notBefore: "2026-07-15T23:00:00.000001Z",
        scheduledRuns: [older, scheduledRun(1, hashes), scheduledRun(2, hashes)],
        expectedHashes: hashes,
      }),
    );
    expect(atBoundary.observed_shards).toBe(2);
    expect(atBoundary.status).toBe("failed");
  });

  it("requires a completed matching retroactive sweep", () => {
    const buildReport = (sweep = {}) =>
      buildMonitoringPromotionRetroactiveSweepReport({
        clusterKey: "cluster-one",
        ruleId: "fundraising_form_change",
        draftHash,
        app: policyIdentity("suppress"),
        worker: policyIdentity("suppress"),
        workerRunIds: ["run-activated"],
        now: "2026-07-15T20:00:02.000001Z",
        sweep: {
          complete: true,
          policy_hash: "suppress",
          scanned_count: 40,
          suppressed_count: 5,
          error_count: 0,
          cursor_complete: true,
          cursor: {
            detected_at: null,
            event_id: null,
            end_of_history: true,
          },
          run_id: "retro-run-one",
          sweep_key: "monitoring-feedback-promotion:cluster-one:cycle-one",
          state_policy_hash: "f".repeat(64),
          checkpoint_at: "2026-07-15T20:00:02.000001Z",
          last_mutation_at: "2026-07-15T20:00:02.000000Z",
          ...sweep,
        },
      });

    const completed = buildReport();
    expect(completed).toMatchObject({
      status: "completed",
      completed_at: "2026-07-15T20:00:02.000001Z",
      checkpoint_at: "2026-07-15T20:00:02.000001Z",
      last_mutation_at: "2026-07-15T20:00:02.000000Z",
    });
    expect(
      buildReport({
        checkpoint_at: "2026-07-15T20:00:02.000001+00:00",
        last_mutation_at: "2026-07-15T20:00:02.000000+00:00",
      }),
    ).toMatchObject({
      status: "completed",
      completed_at: "2026-07-15T20:00:02.000001Z",
      checkpoint_at: "2026-07-15T20:00:02.000001Z",
      last_mutation_at: "2026-07-15T20:00:02.000000Z",
    });
    expect(
      buildReport({
        last_mutation_at: "2026-07-15T20:00:02.000001Z",
      }).status,
    ).toBe("failed");
    expect(
      buildReport({
        last_mutation_at: "2026-07-15T20:00:02.000002Z",
      }).status,
    ).toBe("failed");
    expect(
      buildReport({
        cursor: {
          detected_at: "2026-07-15T18:00:00.000Z",
          event_id: "event-40",
        },
      }).status,
    ).toBe("failed");

    for (const cursor of [
      { event_id: null, end_of_history: true },
      { detected_at: null, end_of_history: true },
      { detected_at: null, event_id: null },
    ]) {
      expect(buildReport({ cursor }).status).toBe("failed");
    }

    expect(buildReport({ policy_hash: "stale" }).status).toBe("failed");
  });
});

function noiseEvent(id, overrides = {}) {
  return {
    id,
    shared_award_source_id: source.id,
    source_url: source.url,
    source_title: source.title,
    source_page_type: source.page_type,
    summary: "The donation widget changed its suggested gift amount.",
    detected_at: "2026-07-15T18:00:00.000Z",
    change_details: { is_alert_worthy: true },
    ...overrides,
  };
}

function legitimateEvent(id) {
  return {
    id,
    shared_award_source_id: source.id,
    source_url: source.url,
    source_title: source.title,
    source_page_type: source.page_type,
    summary: "The application deadline changed from March 1 to March 15.",
    detected_at: "2026-07-15T18:00:00.000Z",
    change_details: {
      is_alert_worthy: true,
      structured_diff: {
        added_text: ["Application deadline: March 15"],
        removed_text: ["Application deadline: March 1"],
      },
    },
  };
}

function scheduledRun(shard, hashes) {
  return {
    id: `run-${shard}`,
    status: "completed",
    started_at: `2026-07-15T23:0${shard}:00.000Z`,
    metadata: {
      run_identity: {
        trigger: "scheduled",
        cohort_id: "visual-nightly:2026-07-15",
        monitoring_date: "2026-07-15",
        shard_index: shard,
        shard_count: 3,
      },
      monitoring_policy_bundle: { hash: hashes.policy_hash },
      monitoring_policy: { hash: hashes.batch_policy_hash },
      suppression_policy: { hash: hashes.suppression_policy_hash },
    },
  };
}

function policyIdentity(suppressionPolicyHash) {
  return {
    revision: "revision-one",
    policy_hash: "full",
    batch_policy_hash: "batch",
    suppression_policy_hash: suppressionPolicyHash,
  };
}

function withRuleActive(active, callback) {
  const rule = awardMonitoringPolicy.policy_flags.find(
    (candidate) => candidate.id === "fundraising_form_change",
  );
  if (!rule) throw new Error("fundraising_form_change fixture is missing");
  const previous = rule.active;
  rule.active = active;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete rule.active;
    else rule.active = previous;
  }
}
