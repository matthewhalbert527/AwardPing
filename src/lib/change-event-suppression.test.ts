import { describe, expect, it } from "vitest";
import { changeEventSuppressionDecision } from "@/lib/change-event-suppression";

const source = {
  id: "source-1",
  url: "https://example.edu/scholarships/example-award",
  title: "Example Award",
  page_type: "application",
  admin_review_status: "open",
  page_metadata_generated_at: "2026-07-08T00:00:00.000Z",
  page_metadata_model: "gemini-test",
  page_metadata: {
    baseline_facts: {
      award_relevance: "primary",
      cycle_relevance: "current_or_upcoming",
      quality_flags: [],
    },
  },
};

function event(summary: string, changeDetails: unknown = {}) {
  return {
    id: "event-1",
    shared_award_source_id: "source-1",
    source_url: source.url,
    source_title: source.title,
    source_page_type: source.page_type,
    summary,
    change_details: changeDetails,
  };
}

describe("change event suppression", () => {
  it("suppresses file size/loading time changed summaries", () => {
    expect(changeEventSuppressionDecision(event("The PDF file size and loading time changed."), source)).toMatchObject({
      suppressed: true,
      reason: "file_size_or_loading_time_noise",
    });
  });

  it("suppresses security question changes", () => {
    expect(changeEventSuppressionDecision(event("The security question changed."), source)).toMatchObject({
      suppressed: true,
      reason: "security_question_or_access_noise",
    });
  });

  it("suppresses JUMP AppSolutions version updates", () => {
    expect(changeEventSuppressionDecision(event("JUMP AppSolutions version updated from 5.1.6 to 5.1.7."), source)).toMatchObject({
      suppressed: true,
      reason: "plugin_or_version_noise",
    });
  });

  it("suppresses related content link updates", () => {
    expect(changeEventSuppressionDecision(event("Related content links were updated."), source)).toMatchObject({
      suppressed: true,
      reason: "related_content_link_noise",
    });
  });

  it("suppresses current fellows/profile content refreshes", () => {
    expect(changeEventSuppressionDecision(event("Current fellows profile content refreshed."), source)).toMatchObject({
      suppressed: true,
      reason: "profile_roster_news_noise",
    });
  });

  it("does not suppress legitimate deadline changes", () => {
    expect(
      changeEventSuppressionDecision(
        event("Application deadline changed from March 1, 2027 to March 15, 2027.", {
          is_alert_worthy: true,
          generation_status: "generated",
          change_type: "deadline",
        }),
        source,
      ),
    ).toEqual({ suppressed: false, reason: null });
  });

  it("does not suppress legitimate amount changes", () => {
    expect(
      changeEventSuppressionDecision(
        event("Award amount increased from $5,000 to $7,500.", {
          is_alert_worthy: true,
          generation_status: "generated",
          change_type: "funding",
        }),
        source,
      ),
    ).toEqual({ suppressed: false, reason: null });
  });

  it("does not suppress legitimate eligibility changes", () => {
    expect(
      changeEventSuppressionDecision(
        event("Eligibility now includes graduate students.", {
          is_alert_worthy: true,
          generation_status: "generated",
          change_type: "eligibility",
        }),
        source,
      ),
    ).toEqual({ suppressed: false, reason: null });
  });
});
