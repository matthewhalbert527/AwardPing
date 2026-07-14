import { describe, expect, it } from "vitest";
import {
  catchupCompletionDecision,
  estimateOneTimeCatchup,
  ONE_TIME_CATCHUP_BATCH_MODE,
  ONE_TIME_CATCHUP_MODEL,
  observedSourceCostPerRequest,
  summarizeOneTimeCatchupBacklog,
} from "./lib/one-time-catchup.mjs";

const acceptedFacts = {
  award_relevance: "primary",
  cycle_relevance: "current_or_upcoming",
  confidence: "high",
  evidence_quotes: ["Applications close February 1, 2027."],
};

function acceptedSource(overrides = {}) {
  return {
    id: "source-accepted",
    shared_award_id: "award-1",
    url: "https://example.edu/example-fellowship",
    title: "Example Fellowship",
    display_title: "Homepage",
    page_type: "homepage",
    admin_review_status: "open",
    last_checked_at: "2026-07-13T00:00:00.000Z",
    page_metadata_generated_at: "2026-07-13T00:00:00.000Z",
    page_metadata_model: ONE_TIME_CATCHUP_MODEL,
    page_metadata: {
      baseline_facts: acceptedFacts,
      baseline_facts_metadata: { status: "succeeded", model: ONE_TIME_CATCHUP_MODEL },
    },
    ...overrides,
  };
}

describe("one-time catch-up planning", () => {
  it("summarizes automated source, visual, reconciliation, and audit backlog", () => {
    const awards = [
      { id: "award-1", status: "active", name: "Example Fellowship", public_facts: {} },
      { id: "award-2", status: "active", name: "Second Fellowship", public_facts: { deadline: "May 1" } },
    ];
    const sources = [
      acceptedSource(),
      acceptedSource({
        id: "source-unreviewed",
        shared_award_id: "award-2",
        url: "https://second.example.edu/apply",
        title: "Apply",
        display_title: "Application",
        page_type: "application",
        page_metadata: null,
        page_metadata_generated_at: null,
        page_metadata_model: null,
      }),
      acceptedSource({
        id: "source-bad",
        shared_award_id: "award-2",
        url: "https://second.example.edu/jobs",
        title: "Jobs",
        page_type: "other",
        page_metadata: {
          baseline_facts: {
            ...acceptedFacts,
            award_relevance: "unrelated",
            quality_flags: ["career-page"],
          },
        },
      }),
    ];
    const result = summarizeOneTimeCatchupBacklog({
      awards,
      sources,
      reconciliationQueue: [
        {
          id: "queue-1",
          shared_award_id: "award-1",
          status: "failed",
          created_at: "2026-07-13T01:00:00.000Z",
        },
      ],
      pageAudits: [
        {
          id: "audit-1",
          shared_award_id: "award-1",
          audit_kind: "deterministic",
          audit_status: "failed",
          severity: "critical",
          created_at: "2026-07-13T02:00:00.000Z",
        },
      ],
      visualSnapshotSourceIds: new Set(["source-accepted"]),
    });

    expect(result.backlog.active_awards).toBe(2);
    expect(result.backlog.source_ai_reviews).toBe(1);
    expect(result.backlog.sources_to_review_later).toBe(1);
    expect(result.backlog.reconciliation_latest_failed_awards).toBe(1);
    expect(result.backlog.awards_never_reconciled).toBe(1);
    expect(result.backlog.latest_unresolved_audit_errors).toBe(1);
    expect(result.backlog.awards_never_audited).toBe(1);
    expect(result.completion.automated_complete).toBe(false);
  });

  it("uses observed Batch spend and never changes the required provider policy", () => {
    const workerRuns = [
      {
        started_at: "2026-07-13T00:00:00.000Z",
        finished_at: "2026-07-13T00:20:00.000Z",
        metadata: {
          ai_model: ONE_TIME_CATCHUP_MODEL,
          gemini_usage: { batch_submitted_requests: 100, estimated_cost_usd: 0.2 },
        },
      },
    ];
    const forecast = estimateOneTimeCatchup({
      backlog: {
        source_ai_reviews: 1_000,
        deterministic_page_audit_candidates: 100,
        visual_review_estimated_cost_usd: 0.1,
        awards_to_seed_for_reconciliation: 1_500,
      },
      recentBaselineWorkerRuns: workerRuns,
      sourceBatchSize: 250,
      sourceParallelJobs: 4,
      pageAuditBatchSize: 100,
    });

    expect(observedSourceCostPerRequest(workerRuns)).toBe(0.002);
    expect(forecast.model).toBe("gemini-2.5-flash-lite");
    expect(forecast.gemini_mode).toBe("batch");
    expect(forecast.estimated_total_cost_usd).toBe(2.135);
    expect(forecast.source_batch_waves).toBe(1);
  });

  it("allows safe manual review only after every automated queue is drained", () => {
    const completion = catchupCompletionDecision({ latest_unresolved_audit_errors: 12 });

    expect(completion.automated_complete).toBe(true);
    expect(completion.status).toBe("complete_with_safe_manual_review");
    expect(completion.safe_manual_review_items).toBe(12);
    expect(ONE_TIME_CATCHUP_BATCH_MODE).toBe("batch");
  });

  it("includes localization repair in the forecast and completion gate", () => {
    const forecast = estimateOneTimeCatchup({
      backlog: { snapshot_localization_latest_pending: 3_000 },
      localizationShards: 3,
    });
    const completion = catchupCompletionDecision({
      snapshot_localization_audit_pending: 0,
      snapshot_localization_latest_pending: 12,
    });

    expect(forecast.snapshot_localization_sources).toBe(3_000);
    expect(forecast.estimated_snapshot_localization_hours.low).toBe(1.1);
    expect(forecast.estimated_snapshot_localization_hours.high).toBe(2.8);
    expect(completion.automated_complete).toBe(false);
    expect(completion.automated_blockers.snapshot_localization_latest_pending).toBe(12);
  });

  it("keeps catch-up open until unlocalized historical screenshots are reset", () => {
    const forecast = estimateOneTimeCatchup({
      backlog: {
        snapshot_localization_latest_pending: 211,
        snapshot_localization_work_pending: 747,
      },
      localizationShards: 3,
    });
    const completion = catchupCompletionDecision({
      snapshot_localization_historical_unavailable: 747,
    });

    expect(forecast.snapshot_localization_sources).toBe(747);
    expect(completion.automated_complete).toBe(false);
    expect(
      completion.automated_blockers.snapshot_localization_historical_unavailable,
    ).toBe(747);
  });
});
