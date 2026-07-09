import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";

vi.mock("server-only", () => ({}));

import {
  parseLatestWorkerReportMetadata,
  summarizeAiMode,
  summarizeCaptureProfile,
  summarizeDiscovery,
  summarizePreAiGate,
  summarizeSourceQuality,
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
      },
    ];

    const summary = summarizeSourceQuality(sources, 7);

    expect(summary.openSources).toBe(3);
    expect(summary.monitorEligibleSources).toBe(1);
    expect(summary.publicEligibleSources).toBe(1);
    expect(summary.factEligibleSources).toBe(1);
    expect(summary.reviewLaterSources).toBe(7);
    expect(summary.rejectedByReason.map((item) => item.reason)).toEqual([
      "award_relevance_unclear",
      "url_not_monitorable",
    ]);
  });
});
