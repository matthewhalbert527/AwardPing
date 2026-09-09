import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeEvidencePanel } from "@/components/change-evidence-panel";
import * as snapshotViewer from "@/components/source-snapshot-viewer";
import * as changeEvidence from "@/lib/change-evidence";

type PanelProps = Parameters<typeof ChangeEvidencePanel>[0];

function changeDetails() {
  return {
    reader_summary: "Applications open on September 10, 2025.",
    before: "Applications open on September 1, 2025.",
    after: "Applications open on September 10, 2025.",
    exact_before: "Applications open on September 1, 2025.",
    exact_after: "Applications open on September 10, 2025.",
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
  };
}

function props(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    changeEventId: "change-1",
    sourceId: "source-1",
    sourceUrl: "https://example.edu/award?cycle=2027&view=all#requirements",
    sourceTitle: "Application page",
    sourcePageTypeLabel: "Deadline",
    summary: "Added date context: Applications open on September 10, 2025.",
    changeDetails: changeDetails(),
    detectedAt: "2026-05-27T20:00:00.000Z",
    ...overrides,
  };
}

function render(input: PanelProps) {
  return load(renderToStaticMarkup(createElement(ChangeEvidencePanel, input)));
}

function expectActions($: ReturnType<typeof load>, sourceUrl: string) {
  expect($("details, summary")).toHaveLength(0);
  expect($("button")).toHaveLength(1);
  expect($("button").text().trim()).toBe("Snapshot");
  expect($("button").attr("type")).toBe("button");
  expect($("a")).toHaveLength(1);
  expect($("a").text().trim()).toBe("Open source");
  expect($("a").attr("href")).toBe(sourceUrl);
  expect($("a").attr("target")).toBe("_blank");
  expect($("a").attr("rel")).toBe("noreferrer");
  expect($("[role='dialog']")).toHaveLength(0);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

afterEach(() => vi.restoreAllMocks());

describe("ChangeEvidencePanel compact evidence actions", () => {
  it.each([false, true])("shows the same two actions without repeating update content (compact=%s)", (compact) => {
    const input = deepFreeze(props({ compact }));
    const before = structuredClone(input);
    const $ = render(input);

    expectActions($, input.sourceUrl!);
    expect($("dl, dt, dd, mark, blockquote, h4, h5")).toHaveLength(0);
    for (const repeatedText of [
      input.summary!, "Applications open on September 10, 2025.",
      "Applications open on September 1, 2025.", "Current wording", "Previous wording",
      "What changed", "AI-generated description", "High confidence", "Application page",
      "Deadline", "Advisor impact", "Update advising calendars.", "Detected",
      "May 27", "2026-05-27T20:00:00.000Z",
    ]) {
      expect($("body").text()).not.toContain(repeatedText);
    }
    const withoutActions = $("body").clone();
    withoutActions.find("button, a").remove();
    expect(withoutActions.text().trim()).toBe("");
    expect(input).toEqual(before);
  });

  it.each([
    { changeEventId: "event-only", sourceId: null },
    { changeEventId: null, sourceId: "source-only" },
    { changeEventId: "event-and-source", sourceId: "source-1" },
  ])("offers one Snapshot for identifiers $changeEventId / $sourceId", (identifiers) => {
    const input = props(identifiers);
    expectActions(render(input), input.sourceUrl!);
  });

  it.each([null, undefined, ""])("offers only Open source when identifiers are %s", (missing) => {
    const input = props({ changeEventId: missing, sourceId: missing });
    const $ = render(input);
    expect($("details, summary, button")).toHaveLength(0);
    expect($("a")).toHaveLength(1);
    expect($("a").text().trim()).toBe("Open source");
    expect($("a").attr("href")).toBe(input.sourceUrl);
    expect($("body").text().trim()).toBe("Open source");
  });

  it.each([null, undefined, ""])("offers no Snapshot or source link when sourceUrl is %s", (sourceUrl) => {
    const $ = render(props({ sourceUrl }));
    expect($("details, summary, button, a")).toHaveLength(0);
    expect($("body").text().trim()).toBe("");
  });

  it("preserves event/source identity and raw evidence props for the snapshot viewer", () => {
    const viewer = vi.spyOn(snapshotViewer, "SourceSnapshotViewerButton").mockImplementation(() => (
      createElement("button", { type: "button" }, "Snapshot")
    ));
    const input = deepFreeze(props({ sourceId: null }));
    const before = structuredClone(input);
    render(input);

    expect(viewer).toHaveBeenCalledOnce();
    const received = viewer.mock.calls[0][0];
    expect(received).toMatchObject({
      changeEventId: input.changeEventId,
      sourceId: null,
      sourceUrl: input.sourceUrl,
      sourcePageTypeLabel: input.sourcePageTypeLabel,
      changeSummary: input.summary,
      changeDetectedAt: input.detectedAt,
    });
    expect(received.changeDetails).toBe(input.changeDetails);
    expect(input).toEqual(before);
  });

  it("retains only the concise first-observation caveat without claiming publication timing", () => {
    const input = deepFreeze(props({
      sourceUrl: "https://example.edu/2027-guidance.pdf",
      summary: "The publisher posted this PDF today.",
      changeDetails: {
        ...changeDetails(),
        event_kind: "new_official_document",
        change_type: "new_official_document",
        reader_summary: "The publisher posted this PDF today.",
        first_observed_at: "2026-06-21T14:00:00.000Z",
        recognized_at: "2026-07-16T18:00:00.000Z",
      },
    }));
    const before = structuredClone(input);
    const $ = render(input);

    expectActions($, input.sourceUrl!);
    expect($("p")).toHaveLength(1);
    expect($("p").text()).toBe("First retained observation; publication date not established.");
    expect($("dl, mark, blockquote, h4, h5")).toHaveLength(0);
    expect($("body").text()).not.toMatch(/publisher posted|today|Previous wording|Current wording|First retained capture|Recognized as an update|2026-06-21|2026-07-16|Applications open/);
    expect(input).toEqual(before);
  });

  it("keeps a supplied relationship caveat without restoring duplicated evidence", () => {
    // The panel does not accept comparison samples; isolate its contract for a
    // relationship warning supplied by the evidence helper, not its detection.
    const input = props();
    const relationshipNote = "The stored added and removed text appears in different parts of the page, so this update is not shown as a direct replacement.";
    const evidence = changeEvidence.buildChangeEvidence(input);
    vi.spyOn(changeEvidence, "buildChangeEvidence").mockReturnValue({ ...evidence, relationshipNote });
    const $ = render(input);

    expectActions($, input.sourceUrl!);
    expect($("p")).toHaveLength(1);
    expect($("p").text()).toBe(relationshipNote);
    expect($("body").text()).not.toContain("Applications open");
    expect($("mark, blockquote, dl, h4, h5")).toHaveLength(0);
  });
});
