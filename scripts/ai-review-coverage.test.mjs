import { describe, expect, it } from "vitest";
import {
  buildSourceAiCoverageRow,
  summarizeAiReviewCoverage,
  workerHasGeminiBlocker,
} from "./lib/ai-review-coverage.mjs";

const award = {
  id: "award-1",
  name: "Example Fellowship",
  slug: "example-fellowship",
  status: "active",
  public_facts: { overview: "Evidence-backed example fellowship facts." },
};

const acceptedFacts = {
  award_relevance: "primary",
  cycle_relevance: "current_or_upcoming",
  confidence: "high",
  evidence_quotes: ["Applications close February 1, 2027."],
};

function source(overrides = {}) {
  return {
    id: "source-1",
    shared_award_id: award.id,
    url: "https://example.edu/example-fellowship/apply",
    title: "Apply",
    display_title: "Application",
    page_type: "application",
    admin_review_status: "open",
    page_metadata_generated_at: "2026-07-08T00:00:00.000Z",
    page_metadata_model: "gemini-test",
    page_metadata: {
      baseline_facts: acceptedFacts,
      baseline_facts_metadata: {
        status: "succeeded",
        model: "gemini-test",
      },
    },
    ...overrides,
  };
}

describe("AI review coverage categorization", () => {
  it("keeps accepted, evidence-backed sources open", () => {
    const row = buildSourceAiCoverageRow(source(), award);
    expect(row.category).toBe("complete_accepted");
    expect(row.planned_action).toBe("leave_open");
    expect(row.monitor_eligible).toBe(true);
  });

  it("queues unreviewed and incomplete sources for AI review", () => {
    const unreviewed = buildSourceAiCoverageRow(
      source({
        page_metadata_generated_at: null,
        page_metadata_model: null,
        last_checked_at: "2026-07-08T00:00:00.000Z",
        page_metadata: null,
      }),
      award,
    );
    expect(unreviewed.category).toBe("unreviewed");
    expect(unreviewed.planned_action).toBe("queue_ai_review");

    const missingCycle = buildSourceAiCoverageRow(
      source({
        page_metadata: {
          baseline_facts: {
            award_relevance: "primary",
            confidence: "high",
            evidence_quotes: ["Example Fellowship application details."],
          },
        },
      }),
      award,
    );
    expect(missingCycle.category).toBe("missing_cycle_relevance");
    expect(missingCycle.planned_action).toBe("queue_ai_review");
  });

  it("moves bad open sources to review later", () => {
    const cases = [
      [{ award_relevance: "unrelated" }, "unrelated_but_open"],
      [{ award_relevance: "unclear" }, "unclear"],
      [{ quality_flags: ["sibling-program"] }, "sibling_but_open"],
      [{ quality_flags: ["access-error"] }, "access_error_but_open"],
      [{ quality_flags: ["generic-listing"] }, "generic_listing_but_open"],
      [{ cycle_relevance: "archived_or_past" }, "archived_but_open"],
      [{ cycle_relevance: "not_program_page" }, "not_program_page_but_open"],
    ];

    for (const [factOverrides, category] of cases) {
      const row = buildSourceAiCoverageRow(
        source({
          page_metadata: {
            baseline_facts: {
              ...acceptedFacts,
              ...factOverrides,
            },
          },
        }),
        award,
      );
      expect(row.category).toBe(category);
      expect(row.planned_action).toBe("move_to_review_later");
    }
  });

  it("fails completion when blockers remain and passes when coverage is clean", () => {
    const cleanRows = [buildSourceAiCoverageRow(source(), award)];
    const clean = summarizeAiReviewCoverage({ awards: [award], rows: cleanRows, pageAudits: [], workerRuns: [] });
    expect(clean.completion_passed).toBe(true);
    expect(clean.completion_blockers.open_unreviewed).toBe(0);

    const dirtyRows = [
      buildSourceAiCoverageRow(
        source({
          id: "source-2",
          page_metadata_generated_at: null,
          page_metadata_model: null,
          last_checked_at: "2026-07-08T00:00:00.000Z",
          page_metadata: null,
        }),
        award,
      ),
    ];
    const dirty = summarizeAiReviewCoverage({
      awards: [{ ...award, public_facts: null }],
      rows: dirtyRows,
      pageAudits: [{ audit_status: "failed", severity: "critical" }],
      workerRuns: [{ worker_name: "baseline", error: "Gemini credits are depleted", metadata: {} }],
    });
    expect(dirty.completion_passed).toBe(false);
    expect(dirty.completion_blockers.open_unreviewed).toBe(1);
    expect(dirty.completion_blockers.open_missing_evidence).toBe(0);
    expect(dirty.completion_blockers.public_awards_missing_facts).toBe(1);
    expect(dirty.completion_blockers.critical_page_audit_failures).toBe(1);
    expect(dirty.completion_blockers.gemini_billing_blocked).toBe(1);
  });

  it("does not treat false billing metadata or historical blockers as current", () => {
    const current = {
      worker_name: "local-baseline-facts-worker",
      ai_provider: "gemini",
      status: "running",
      started_at: "2026-07-10T18:00:00.000Z",
      error: null,
      metadata: { billing_blocked: false, blocking_reason: null },
    };
    const historical = {
      worker_name: "local-baseline-facts-worker",
      ai_provider: "gemini",
      status: "failed",
      started_at: "2026-07-09T18:00:00.000Z",
      error: "Gemini credits are depleted",
      metadata: { billing_blocked: true },
    };

    expect(workerHasGeminiBlocker(current)).toBe(false);
    const summary = summarizeAiReviewCoverage({
      awards: [award],
      rows: [buildSourceAiCoverageRow(source(), award)],
      workerRuns: [current, historical],
    });
    expect(summary.latest_gemini_billing_quota_blocker).toBeNull();
    expect(summary.completion_blockers.gemini_billing_blocked).toBe(0);
  });
});
