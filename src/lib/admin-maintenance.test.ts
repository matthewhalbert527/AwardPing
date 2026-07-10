import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";

vi.mock("server-only", () => ({}));

import {
  adminCommandPanelCommands,
  parseLatestWorkerReportMetadata,
  summarizeBackfillCompletion,
  summarizeAiMode,
  summarizeCaptureProfile,
  summarizeDailyWorkerHealth,
  summarizeDiscovery,
  summarizeExpandableSections,
  summarizeGeminiBatchStatus,
  summarizePreAiGate,
  summarizeSourceQuality,
  summarizeSourceQualityFastCounts,
  summarizeTextOnlyChanges,
  summarizeVisualReviewBatch,
} from "@/lib/admin-maintenance";
import type { SourceQualitySource } from "@/lib/source-quality";

type WorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];

function workerRun(metadata: Record<string, unknown>, overrides: Partial<WorkerRun> = {}): WorkerRun {
  return {
    id: "run-1",
    worker_name: "visual-snapshot-worker",
    status: "succeeded",
    ai_provider: null,
    checked_count: 0,
    changed_count: 0,
    unchanged_count: 0,
    initial_count: 0,
    discovered_count: 0,
    failed_count: 0,
    error: null,
    metadata: metadata as WorkerRun["metadata"],
    started_at: "2026-07-08T23:00:00.000Z",
    finished_at: "2026-07-08T23:05:00.000Z",
    ...overrides,
  };
}

describe("admin maintenance summaries", () => {
  it("handles old or missing worker report metadata", () => {
    const latest = parseLatestWorkerReportMetadata([]);

    expect(latest.latestVisualRun).toBeNull();
    expect(summarizeDiscovery(latest.latestVisualMetadata).discoveryCandidates).toBe(0);
    expect(summarizeTextOnlyChanges(latest.latestVisualMetadata).needsAttention).toBe(false);
    expect(summarizeCaptureProfile(latest.latestVisualMetadata).captureProfile).toBeNull();
  });

  it("parses hardened visual report fields", () => {
    const metadata = {
      kind: "visual_snapshot",
      ai_required: false,
      ai_provider: null,
      ai_disabled_reason: "pure capture",
      counts: {
        candidate_changes: 100,
        deterministic_source_rejected: 20,
        deterministic_noise_rejected: 30,
        text_only_candidates: 10,
        text_only_noise_rejected: 4,
        text_only_published_or_queued: 6,
        text_only_ignored: 2,
        visual_only_candidate_enqueued: 8,
        ai_rejected: 18,
        ai_true_changes: 12,
        discovery_mode: false,
        discovery_candidates: 3,
        discovery_rejected_by_quality: 2,
        discovery_inserted_open: 1,
        capture_profile: "stable-daily",
        expansion_screenshots_taken: 0,
        r2_uploads_skipped_unchanged: 40,
        r2_uploads_skipped_noise: 5,
        main_content_hash_changed: 12,
        chrome_only_hash_changed: 7,
        scroll_activation_wait_ms: 1500,
        visual_review_mode: "immediate",
      },
      gemini_usage: {
        pricing_mode: "batch",
        calls: 3,
      },
    };
    const latest = parseLatestWorkerReportMetadata([workerRun(metadata)]);

    expect(latest.latestVisualRun?.id).toBe("run-1");
    expect(summarizeDiscovery(metadata).standardCaptureCreatedSources).toBe(true);
    expect(summarizePreAiGate(metadata)).toMatchObject({
      candidateChanges: 100,
      deterministicSourceRejected: 20,
      deterministicNoiseRejected: 30,
      textOnlyPublishedOrQueued: 6,
      aiRejected: 18,
      trueChangesPublished: 12,
    });
    expect(summarizeTextOnlyChanges(metadata).needsAttention).toBe(true);
    expect(summarizeCaptureProfile(metadata)).toMatchObject({
      captureProfile: "stable-daily",
      r2UploadsSkippedUnchanged: 40,
      chromeOnlyHashChanged: 7,
    });
    expect(summarizeAiMode(metadata)).toMatchObject({
      aiRequired: false,
      aiProvider: null,
      aiDisabledReason: "pure capture",
      synchronousBatchPricingWarning: true,
    });
    expect(summarizeDailyWorkerHealth(metadata)).toMatchObject({
      textOnlyIgnored: 2,
      standardCaptureCreatedSources: true,
      captureProfile: "stable-daily",
    });
  });

  it("summarizes backfill completion and expandable section fields", () => {
    const backfill = summarizeBackfillCompletion({
      status: "completed_with_blockers",
      completion_passed: false,
      billing_blocked: true,
      blocking_reason: "credits are depleted",
      counts: {
        total_open_sources_scanned: 100,
        queued_for_ai_review: 12,
        submitted_to_gemini_batch: 10,
        moved_to_review_later: 5,
        awards_queued_for_reconciliation: 4,
        awards_reconciled: 3,
        public_pages_blocked: 2,
        last_known_good_preserved: 2,
      },
    });
    const sections = summarizeExpandableSections({
      counts: {
        expandable_section_extraction_enabled: true,
        section_extraction_profile: "stable-daily",
        expandable_sections_detected: 8,
        expandable_sections_extracted: 6,
        expandable_sections_changed: 1,
        section_evidence_screenshots_taken: 1,
        section_text_included_in_main_hash: true,
      },
    });

    expect(backfill).toMatchObject({
      billingBlocked: true,
      queuedForAiReview: 12,
      publicPagesBlocked: 2,
    });
    expect(sections.needsAttention).toBe(true);
    expect(sections.detected).toBe(8);
    expect(sections.extracted).toBe(6);
  });

  it("summarizes Gemini batch health and exposes admin commands", () => {
    const latest = parseLatestWorkerReportMetadata([
      workerRun(
        {
          kind: "page_audit_batch",
          batches: [{ name: "batches/page-audit" }],
        },
        { worker_name: "page-audit-batch" },
      ),
      workerRun(
        {
          kind: "source_intake",
          batches: [{ name: "batches/intake" }],
        },
        { worker_name: "source-intake-worker" },
      ),
      workerRun(
        {
          billing_blocked: true,
          blocking_reason: "Gemini prepayment credits are depleted",
        },
        { worker_name: "local-open-source-ai-coverage-backfill", error: "Gemini prepayment credits are depleted" },
      ),
    ]);
    const health = summarizeGeminiBatchStatus(latest, summarizeVisualReviewBatch([
      { status: "submitted", gemini_batch_name: "batches/visual", submitted_at: "2026-07-09T00:00:00.000Z" },
    ]));

    expect(health.billingBlocked).toBe(true);
    expect(health.latestVisualReviewBatchJob).toBe("batches/visual");
    expect(adminCommandPanelCommands().map((item) => item.command)).toContain(
      "node scripts/read-ai-review-coverage.mjs --json",
    );
  });

  it("counts visual-review batch statuses and latest batch details", () => {
    const summary = summarizeVisualReviewBatch([
      {
        status: "pending",
        estimated_cost_usd: 0.01,
      },
      {
        status: "published",
        gemini_batch_name: "batches/2",
        model: "gemini-2.5-flash",
        submitted_at: "2026-07-08T23:10:00.000Z",
        completed_at: "2026-07-08T23:20:00.000Z",
        estimated_cost_usd: 0.02,
        actual_usage: { actual_cost_usd: 0.018 },
      },
      {
        status: "failed",
        gemini_batch_name: "batches/2",
        estimated_cost_usd: 0.03,
      },
    ]);

    expect(summary.configured).toBe(true);
    expect(summary.statusCounts.pending).toBe(1);
    expect(summary.statusCounts.published).toBe(1);
    expect(summary.statusCounts.failed).toBe(1);
    expect(summary.latestBatchName).toBe("batches/2");
    expect(summary.requestCount).toBe(2);
    expect(summary.estimatedCostUsd).toBeCloseTo(0.05);
    expect(summary.actualCostUsd).toBeCloseTo(0.018);
  });

  it("reports missing visual-review candidate table without crashing", () => {
    const summary = summarizeVisualReviewBatch([], "Visual review queue not configured.");

    expect(summary.configured).toBe(false);
    expect(summary.warning).toBe("Visual review queue not configured.");
    expect(summary.statusCounts.pending).toBe(0);
  });

  it("summarizes source-quality eligibility and rejection reasons", () => {
    const sources: SourceQualitySource[] = [
      {
        url: "https://example.edu/award/apply",
        title: "Example Award Application",
        page_type: "application",
        page_metadata: {
          baseline_facts: {
            award_relevance: "primary",
            cycle_relevance: "current_or_upcoming",
          },
        },
        page_metadata_generated_at: "2026-07-08T00:00:00.000Z",
        page_metadata_model: "gemini-test",
      },
      {
        url: "https://example.edu/award/careers/job-profile",
        title: "Job profile",
        page_type: "application",
        page_metadata: {
          baseline_facts: {
            award_relevance: "primary",
            cycle_relevance: "current_or_upcoming",
          },
        },
        page_metadata_generated_at: "2026-07-08T00:00:00.000Z",
        page_metadata_model: "gemini-test",
      },
      {
        url: "https://example.edu/award/faq",
        title: "FAQ",
        page_type: "faq",
        page_metadata: {
          baseline_facts: {
            award_relevance: "unclear",
            cycle_relevance: "current_or_upcoming",
          },
        },
        page_metadata_generated_at: "2026-07-08T00:00:00.000Z",
        page_metadata_model: "gemini-test",
      },
    ];

    const summary = summarizeSourceQuality(sources, 7);

    expect(summary.openSources).toBe(3);
    expect(summary.metricMode).toBe("live_scan");
    expect(summary.monitorEligibleSources).toBe(1);
    expect(summary.publicEligibleSources).toBe(1);
    expect(summary.factEligibleSources).toBe(1);
    expect(summary.reviewLaterSources).toBe(7);
    expect(summary.rejectedByReason.map((item) => item.reason)).toEqual([
      "ai_review_reviewed_unclear_needs_manual_review_award_relevance_unclear",
      "url_not_monitorable",
    ]);
  });

  it("summarizes source-quality fast counts without implying measured eligibility", () => {
    const summary = summarizeSourceQualityFastCounts(15678, 71590);

    expect(summary.metricMode).toBe("fast_counts");
    expect(summary.openSources).toBe(15678);
    expect(summary.reviewLaterSources).toBe(71590);
    expect(summary.monitorEligibleSources).toBe(0);
    expect(summary.openRejectedSources).toBe(0);
    expect(summary.metricsWarning).toContain("not live-scanned");
    expect(summary.rejectedByReason).toEqual([]);
  });
});
