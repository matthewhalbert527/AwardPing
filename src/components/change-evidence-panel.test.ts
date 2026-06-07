import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangeEvidencePanel } from "@/components/change-evidence-panel";

describe("ChangeEvidencePanel", () => {
  it("combines summary evidence and source metadata in one update details disclosure", () => {
    const html = renderToStaticMarkup(
      createElement(ChangeEvidencePanel, {
        changeId: "change-1",
        changeKind: "shared",
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
        },
        detectedAt: "2026-05-27T20:00:00.000Z",
      }),
    );

    expect(html).toContain("<summary>Update details</summary>");
    expect(html).toContain("What changed");
    expect(html).toContain("Source");
    expect(html).toContain("Applications open on September 10, 2025.");
    expect(html).toContain("After / new text");
    expect(html).toContain("Before");
    expect(html).toContain("Application page");
    expect(html).toContain("Deadline");
    expect(html).toContain("Open highlighted version");
    expect(html).toContain("/highlight/shared/change-1");
    expect(html).not.toContain("Source details");
    expect(html).not.toContain("<dt>Status</dt>");
    expect(html).not.toContain("AwardPing does not have enough stored snapshot text");
  });
});
