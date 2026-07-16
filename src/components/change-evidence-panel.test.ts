import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangeEvidencePanel } from "@/components/change-evidence-panel";

describe("ChangeEvidencePanel", () => {
  it("combines summary evidence and source metadata in one update details disclosure", () => {
    const html = renderToStaticMarkup(
      createElement(ChangeEvidencePanel, {
        changeEventId: "change-1",
        sourceId: "source-1",
        sourceUrl: "https://example.edu/award",
        sourceTitle: "Application page",
        sourcePageTypeLabel: "Deadline",
        summary: "Added date context: Applications open on September 10, 2025.",
        changeDetails: {
          reader_summary: "Applications open on September 10, 2025.",
          before: "Applications open on September 1, 2025.",
          after: "Applications open on September 10, 2025.",
          section: "Deadline",
          change_type: "deadline",
          advisor_impact: "Update advising calendars.",
          is_alert_worthy: true,
          confidence: "high",
          structured_diff: {
            added_text: ["Applications open on September 10, 2025."],
            removed_text: ["Applications open on September 1, 2025."],
            likely_section: "Deadline",
            page_type: "deadline",
            date_changes: ["Added September 10, 2025"],
            amount_changes: [],
            noise_flags: [],
          },
          source: {},
          quality_flags: [],
          generated_at: "2026-05-28T20:00:00.000Z",
          generation_provider: "gemini",
          generation_status: "generated",
          generation_model: "gemini-2.5-flash-lite",
        },
        detectedAt: "2026-05-27T20:00:00.000Z",
      }),
    );

    expect(html).toContain("<summary>View change explanation</summary>");
    expect(html).toContain("What changed");
    expect(html).toContain("Source");
    expect(html).toContain("Applications open on September 10, 2025.");
    expect(html).toContain("Current wording");
    expect(html).toContain("Previous wording");
    expect(html).toContain("AI-generated description");
    expect(html).toContain("High confidence");
    expect(html).toContain("Application page");
    expect(html).toContain("Deadline");
    expect(html).toContain("Snapshot");
    expect(html).not.toContain("Open full change explanation");
    expect(html).not.toContain("/highlight/shared/change-1");
    expect(html).not.toContain("Source details");
    expect(html).not.toContain("<dt>Status</dt>");
    expect(html).not.toContain("stored snapshot text");
  });

  it("offers event-scoped evidence even when no mutable source snapshot ID is available", () => {
    const html = renderToStaticMarkup(
      createElement(ChangeEvidencePanel, {
        changeEventId: "change-1",
        sourceId: null,
        sourceUrl: "https://example.edu/award",
        sourceTitle: "Application page",
        summary: "The application deadline changed.",
      }),
    );

    expect(html).toContain("Snapshot");
  });

  it("renders a new official document as a current-only first observation", () => {
    const html = renderToStaticMarkup(
      createElement(ChangeEvidencePanel, {
        changeEventId: "change-1",
        sourceId: "source-1",
        sourceUrl: "https://example.edu/2027-guidance.pdf",
        sourceTitle: "2027 application guidance",
        summary: "The publisher posted this PDF today.",
        changeDetails: {
          event_kind: "new_official_document",
          reader_summary: "The publisher posted this PDF today.",
          before: null,
          after: "Candidates must submit two letters of recommendation.",
          exact_before: null,
          exact_after: "Candidates must submit two letters of recommendation.",
          section: "Application requirements",
          change_type: "new_official_document",
          advisor_impact: "Review the guidance before advising applicants.",
          is_alert_worthy: true,
          confidence: "high",
          structured_diff: {
            added_text: ["Candidates must submit two letters of recommendation."],
            removed_text: [],
            likely_section: "Application requirements",
            page_type: "pdf",
            date_changes: [],
            amount_changes: [],
            noise_flags: [],
          },
          source: {},
          quality_flags: [],
          first_observed_at: "2026-06-21T14:00:00.000Z",
          recognized_at: "2026-07-16T18:00:00.000Z",
          generated_at: "2026-07-16T18:00:00.000Z",
        },
        detectedAt: "2026-07-16T18:00:00.000Z",
      }),
    );

    expect(html).toContain("View first-observation explanation");
    expect(html).toContain("What AwardPing first observed");
    expect(html).toContain("New official document");
    expect(html).toContain("Wording in the document");
    expect(html).toContain("First retained capture");
    expect(html).toContain("Recognized as an update");
    expect(html).not.toContain("First observed by AwardPing");
    expect(html).toContain("does not establish when the publisher posted the document");
    expect(html).not.toContain("What changed");
    expect(html).not.toContain("Previous wording");
    expect(html).not.toContain("The publisher posted this PDF today");
  });
});
