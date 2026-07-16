import { describe, expect, it } from "vitest";
import {
  buildOneTimeCatchupQuarantineSummary,
  catchupCompletionDecision,
  completionFromManualQuarantineState,
  estimateOneTimeCatchup,
  nextSourceAiStagnantCycles,
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

function completeLocalizationInventory(sourceIds = []) {
  const sourceCount = sourceIds.length;
  return {
    version: 2,
    report_type: "legacy_source_pointer_layout_maintenance",
    metric_scope: "source_pointer_layout_metadata_not_event_crop",
    verified_event_crop_metric: false,
    audited: true,
    started_at: "2026-07-15T05:00:00.000Z",
    finished_at: "2026-07-15T05:01:00.000Z",
    apply: false,
    inventory_scope: {
      kind: "all_active_open_monitorable_sources",
      requested_source_limit: 100_000,
      database_sources_loaded: sourceCount,
      truncated: false,
    },
    source_count: sourceCount,
    visual_versions_required: sourceCount * 2,
    accounted_for_versions: sourceCount * 2,
    accounted_for_percent: 100,
    repair_needed_versions: 0,
    latest_repair_needed: 0,
    previous_repair_needed: 0,
    historical_layout_unavailable: sourceCount,
    r2_meta_errors: 0,
    work_source_count: 0,
    automated_localization_complete: true,
    repair_source_ids: [],
    latest_repair_source_ids: [],
    previous_repair_source_ids: [],
    work_source_ids: [],
    historical_fallback_source_ids: sourceIds,
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
      reconciliationQueue: [
        {
          id: "reconciliation-1",
          shared_award_id: "award-1",
          status: "failed",
          created_at: "2026-07-15T03:00:00.000Z",
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
    expect(result.completion.automated_work_clear).toBe(false);
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

  it("reports clear automation separately from durable quarantined work", () => {
    const completion = catchupCompletionDecision(
      {},
      {
        quarantined_work_remaining: 12,
        quarantine_evidence_records: 20,
        historical_limitations: 7,
        historical_inventory_status: "complete",
        terminal_failures_requiring_action: 8,
        by_category: { public_page: { cases: 12 } },
      },
    );

    expect(completion.automated_work_clear).toBe(true);
    expect(completion.status).toBe("automated_work_clear");
    expect(completion.quarantined_work_remaining).toBe(12);
    expect(completion.quarantine_evidence_records).toBe(20);
    expect(completion.historical_limitations).toBe(7);
    expect(completion.terminal_failures_requiring_action).toBe(8);
    expect(completion).not.toHaveProperty("safe_manual_review_items");
    expect(ONE_TIME_CATCHUP_BATCH_MODE).toBe("batch");
  });

  it("uses the recorded durable registry state for every quarantine completion measure", () => {
    const result = completionFromManualQuarantineState(
      {
        status: "automated_work_clear",
        automated_work_clear: true,
        automated_blockers: {},
        quarantined_work_remaining: 999,
        quarantine_evidence_records: 999,
        historical_limitations: null,
        historical_inventory_status: "not_imported",
        terminal_failures_requiring_action: 999,
        quarantine_by_category: {},
      },
      {
        automated_work_clear: true,
        automated_blockers: {},
        completion_status: "automated_work_clear",
        quarantined_work_remaining: 293,
        quarantine_evidence_records: 509,
        historical_limitations: 390,
        historical_inventory_status: "complete",
        terminal_failures_requiring_action: 275,
        by_category: {
          public_page: { cases: 236 },
          visual_review: { cases: 57 },
          historical_localization: { cases: 390 },
        },
      },
    );

    expect(result).toMatchObject({
      status: "automated_work_clear",
      automated_work_clear: true,
      quarantined_work_remaining: 293,
      quarantine_evidence_records: 509,
      historical_limitations: 390,
      historical_inventory_status: "complete",
      terminal_failures_requiring_action: 275,
    });
    expect(result.quarantine_by_category.public_page.cases).toBe(236);
    expect(() =>
      completionFromManualQuarantineState({}, { automated_work_clear: true }),
    ).toThrow(/completion status contradicts/i);
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
    expect(completion.automated_work_clear).toBe(false);
    expect(completion.automated_blockers.snapshot_localization_latest_pending).toBe(12);
  });

  it("keeps previous-version metadata errors in the completion gate", () => {
    const completion = catchupCompletionDecision({
      snapshot_localization_previous_pending: 2,
    });

    expect(completion.automated_work_clear).toBe(false);
    expect(completion.automated_blockers.snapshot_localization_previous_pending).toBe(2);
  });

  it("counts pre-review evidence capture only until a source has a snapshot", () => {
    const unreviewed = acceptedSource({
      id: "source-needs-evidence",
      page_metadata: null,
      page_metadata_generated_at: null,
      page_metadata_model: null,
    });
    const withoutSnapshot = summarizeOneTimeCatchupBacklog({
      awards: [{ id: "award-1", status: "active", name: "Example Fellowship", public_facts: {} }],
      sources: [unreviewed],
    });
    const withSnapshot = summarizeOneTimeCatchupBacklog({
      awards: [{ id: "award-1", status: "active", name: "Example Fellowship", public_facts: {} }],
      sources: [unreviewed],
      visualSnapshotSourceIds: new Set([unreviewed.id]),
    });

    expect(withoutSnapshot.backlog.sources_needing_capture_baseline).toBe(1);
    expect(withoutSnapshot.backlog.monitor_eligible_missing_visuals).toBe(0);
    expect(withSnapshot.backlog.sources_needing_capture_baseline).toBe(0);
  });

  it("reports truthful historical localization fallbacks without blocking catch-up", () => {
    const forecast = estimateOneTimeCatchup({
      backlog: {
        snapshot_localization_latest_pending: 211,
        snapshot_localization_work_pending: 211,
      },
      localizationShards: 3,
    });
    const completion = catchupCompletionDecision(
      { snapshot_localization_historical_unavailable: 747 },
      {
        historical_limitations: 747,
        historical_inventory_status: "complete",
      },
    );

    expect(forecast.snapshot_localization_sources).toBe(211);
    expect(completion.automated_work_clear).toBe(true);
    expect(completion.historical_limitations).toBe(747);
    expect(completion.automated_blockers).not.toHaveProperty(
      "snapshot_localization_historical_unavailable",
    );
  });

  it("keeps historical limitations unreported until the exact source inventory exists", () => {
    const quarantine = buildOneTimeCatchupQuarantineSummary({
      snapshotLocalization: {
        audited: true,
        historical_layout_unavailable: 390,
        historical_fallback_source_ids: [],
      },
    });

    expect(quarantine.historical_limitations).toBeNull();
    expect(quarantine.historical_inventory_status).toBe("not_imported");
    expect(quarantine.by_category.historical_localization.cases).toBeNull();
  });

  it("rejects a partial or shape-less historical inventory instead of shrinking its truth", () => {
    const partial = buildOneTimeCatchupQuarantineSummary({
      snapshotLocalization: {
        audited: true,
        historical_layout_unavailable: 390,
        historical_fallback_source_ids: Array.from(
          { length: 389 },
          (_, index) => `source-${index}`,
        ),
      },
    });
    const missingFields = buildOneTimeCatchupQuarantineSummary({
      snapshotLocalization: { audited: true },
    });

    expect(partial.historical_limitations).toBeNull();
    expect(partial.historical_inventory_status).toBe("not_imported");
    expect(missingFields.historical_limitations).toBeNull();
    expect(missingFields.historical_inventory_status).toBe("not_imported");
  });

  it("groups linked page evidence and keeps retryable visual failures automated", () => {
    const result = summarizeOneTimeCatchupBacklog({
      awards: [
        { id: "award-1", status: "active", name: "Example", public_facts: {} },
      ],
      sources: [],
      pageAudits: [
        {
          id: "audit-1",
          shared_award_id: "award-1",
          audit_kind: "gemini_batch",
          audit_status: "failed",
          severity: "critical",
          created_at: "2026-07-15T01:00:00.000Z",
        },
      ],
      reconciliationQueue: [
        {
          id: "reconciliation-1",
          shared_award_id: "award-1",
          status: "failed",
          created_at: "2026-07-15T02:00:00.000Z",
        },
      ],
      visualReviewCandidates: [
        {
          id: "visual-retryable",
          shared_award_id: "award-1",
          candidate_signature: "retryable",
          status: "failed",
          rejection_reason: "invalid_ai_json",
          worker_metadata: { failure_retry_count: 1 },
          estimated_cost_usd: 0.01,
        },
        {
          id: "visual-terminal",
          shared_award_id: "award-1",
          candidate_signature: "terminal",
          status: "failed",
          rejection_reason: "invalid_ai_json",
          worker_metadata: { failure_retry_count: 3 },
          estimated_cost_usd: 0.01,
        },
      ],
      snapshotLocalization: completeLocalizationInventory([
        "source-old-1",
        "source-old-2",
      ]),
    });

    expect(result.backlog.visual_review_queue).toBe(1);
    expect(result.backlog.visual_review_retryable_failures).toBe(1);
    expect(result.backlog.visual_review_terminal_failures).toBe(1);
    expect(result.quarantine.quarantined_work_remaining).toBe(2);
    expect(result.quarantine.quarantine_evidence_records).toBe(3);
    expect(result.quarantine.terminal_failures_requiring_action).toBe(2);
    expect(result.quarantine.historical_limitations).toBe(2);
    expect(result.quarantine.by_category.public_page).toEqual({
      cases: 1,
      evidence_records: 2,
      terminal_cases: 1,
      terminal_failures: 1,
    });
  });

  it("keeps inactive-award visual failures out of automation and quarantine counts", () => {
    const result = summarizeOneTimeCatchupBacklog({
      awards: [
        { id: "award-active", status: "active", public_facts: {} },
        { id: "award-inactive", status: "inactive", public_facts: {} },
      ],
      visualReviewCandidates: [
        {
          id: "visual-inactive-terminal",
          shared_award_id: "award-inactive",
          candidate_signature: "inactive-terminal",
          status: "failed",
          rejection_reason: "invalid_ai_json",
          worker_metadata: { failure_retry_count: 3 },
        },
      ],
      snapshotLocalization: completeLocalizationInventory(),
    });

    expect(result.backlog.visual_review_terminal_failures).toBe(0);
    expect(result.quarantine.quarantined_work_remaining).toBe(0);
    expect(result.quarantine.terminal_failures_requiring_action).toBe(0);
  });

  it("counts an exhausted page-audit Batch as one terminal case", () => {
    const result = summarizeOneTimeCatchupBacklog({
      awards: [{ id: "award-1", status: "active", name: "Example", public_facts: {} }],
      pageAudits: [
        {
          id: "audit-attempt-1",
          shared_award_id: "award-1",
          audit_kind: "gemini_batch",
          audit_status: "needs_review",
          severity: "error",
          gemini_batch_request_key: "deterministic-audit-1",
          ai_result: { error: "invalid_json" },
          created_at: "2026-07-15T01:00:00.000Z",
        },
        {
          id: "audit-attempt-2",
          shared_award_id: "award-1",
          audit_kind: "gemini_batch",
          audit_status: "needs_review",
          severity: "error",
          gemini_batch_request_key: "deterministic-audit-1",
          ai_result: { error: "invalid_json" },
          created_at: "2026-07-15T02:00:00.000Z",
        },
      ],
      reconciliationQueue: [
        {
          id: "reconciliation-terminal",
          shared_award_id: "award-1",
          status: "failed",
          created_at: "2026-07-15T03:00:00.000Z",
        },
      ],
      snapshotLocalization: completeLocalizationInventory(),
    });

    expect(result.terminal_page_audit_rows).toHaveLength(1);
    expect(result.quarantine.quarantined_work_remaining).toBe(1);
    expect(result.quarantine.quarantine_evidence_records).toBe(2);
    expect(result.quarantine.terminal_failures_requiring_action).toBe(2);
    expect(result.quarantine.by_category.public_page.terminal_cases).toBe(1);
    expect(result.quarantine.by_category.public_page.terminal_failures).toBe(2);
  });

  it("does not count active or newly submitted AI batches as stagnant", () => {
    expect(
      nextSourceAiStagnantCycles({ previous: 2, before: 100, after: 90 }),
    ).toBe(0);
    expect(
      nextSourceAiStagnantCycles({
        previous: 2,
        before: 100,
        after: 100,
        activeBatches: 1,
      }),
    ).toBe(2);
    expect(
      nextSourceAiStagnantCycles({
        previous: 2,
        before: 100,
        after: 100,
        submitted: 25,
      }),
    ).toBe(2);
    expect(
      nextSourceAiStagnantCycles({ previous: 2, before: 100, after: 100 }),
    ).toBe(3);
  });
});
