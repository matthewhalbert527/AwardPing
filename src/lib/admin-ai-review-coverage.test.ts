import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";

vi.mock("server-only", () => ({}));

import {
  buildSourceAiCoverageRow,
  summarizeAiReviewCoverage,
  summarizeAiReviewCoverageFromWorkerRuns,
  workerHasGeminiBlocker,
} from "@/lib/admin-ai-review-coverage";

type WorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];

function workerRun(metadata: Record<string, unknown>, overrides: Partial<WorkerRun> = {}): WorkerRun {
  return {
    id: "run-1",
    worker_name: "local-open-source-ai-coverage-backfill",
    status: "failed",
    ai_provider: "gemini",
    checked_count: 0,
    changed_count: 0,
    unchanged_count: 0,
    initial_count: 0,
    discovered_count: 0,
    failed_count: 1,
    error: null,
    metadata: metadata as WorkerRun["metadata"],
    started_at: "2026-07-09T00:00:00.000Z",
    finished_at: "2026-07-09T00:10:00.000Z",
    ...overrides,
  };
}

describe("admin AI review coverage", () => {
  it("classifies unreviewed, unclear, and unrelated open sources as blockers", () => {
    const awards = [
      { id: "award-1", name: "Example Award", slug: "example-award", status: "active", public_facts: null },
    ];
    const rows = [
      buildSourceAiCoverageRow({
        id: "source-1",
        shared_award_id: "award-1",
        admin_review_status: "open",
        url: "https://example.edu/award",
        title: "Example Award",
        page_type: "homepage",
        page_metadata: null,
      }),
      buildSourceAiCoverageRow({
        id: "source-2",
        shared_award_id: "award-1",
        admin_review_status: "open",
        url: "https://example.edu/award/faq",
        title: "FAQ",
        page_type: "faq",
        page_metadata_generated_at: "2026-07-09T00:00:00.000Z",
        page_metadata_model: "gemini-test",
        page_metadata: {
          baseline_facts: {
            award_relevance: "unclear",
            cycle_relevance: "current_or_upcoming",
            confidence: "medium",
          },
        },
      }),
      buildSourceAiCoverageRow({
        id: "source-3",
        shared_award_id: "award-1",
        admin_review_status: "open",
        url: "https://example.edu/other-award",
        title: "Other Award",
        page_type: "homepage",
        page_metadata_generated_at: "2026-07-09T00:00:00.000Z",
        page_metadata_model: "gemini-test",
        page_metadata: {
          baseline_facts: {
            award_relevance: "unrelated",
            cycle_relevance: "current_or_upcoming",
            confidence: "high",
            evidence_quotes: ["Other Award"],
          },
        },
      }),
    ];

    const summary = summarizeAiReviewCoverage({ awards, rows });

    expect(summary.completion_passed).toBe(false);
    expect(summary.unreviewed_open_sources).toBe(1);
    expect(summary.open_sources_with_award_relevance_unclear).toBe(1);
    expect(summary.open_sources_with_award_relevance_unrelated).toBe(1);
    expect(summary.completion_blockers).toMatchObject({
      open_unreviewed: 1,
      open_unclear: 1,
      open_unrelated: 1,
      public_awards_missing_facts: 1,
    });
  });

  it("detects Gemini billing and quota blockers in worker metadata", () => {
    const run = workerRun({
      billing_blocked: true,
      blocking_reason: "Gemini HTTP 429 RESOURCE_EXHAUSTED: credits are depleted",
    });

    expect(workerHasGeminiBlocker(run)).toBe(true);

    const summary = summarizeAiReviewCoverage({ workerRuns: [run] });
    expect(summary.latest_gemini_billing_quota_blocker?.blocking_reason).toContain("credits are depleted");
    expect(summary.completion_blockers.gemini_billing_blocked).toBe(1);
  });

  it("builds dashboard coverage from durable worker metadata", () => {
    const summary = summarizeAiReviewCoverageFromWorkerRuns([
      workerRun({
        kind: "open_source_ai_review_coverage_backfill",
        completion_passed: false,
        counts: {
          total_open_sources_scanned: 100,
          complete_accepted: 72,
          complete_rejected: 10,
          unreviewed: 8,
          unclear: 4,
          unrelated_but_open: 3,
          sibling_but_open: 2,
          missing_cycle_relevance: 1,
        },
      }),
    ]);

    expect(summary?.open_sources).toBe(100);
    expect(summary?.monitor_eligible_sources).toBe(72);
    expect(summary?.open_category_counts).toMatchObject({
      complete_accepted: 72,
      unreviewed: 8,
      unclear: 4,
      unrelated_but_open: 3,
    });
    expect(summary?.completion_blockers).toMatchObject({
      open_unreviewed: 8,
      open_unclear: 4,
      open_unrelated: 3,
      open_sibling: 2,
      open_missing_cycle_relevance: 1,
    });
    expect(summary?.percent_complete_open_sources).toBe(82);
  });
});
