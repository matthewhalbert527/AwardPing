import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it, vi } from "vitest";
import { ChangeEvidencePanel } from "@/components/change-evidence-panel";

const previous = "Applications close April 1 at 5 p.m. Eastern Time, including all required documents.";
const current = "Applications close April 15 at 5 p.m. Eastern Time, including all required documents.";
function quote(text: string) { return { block_id: "deadline-1", start_utf16: 0, end_utf16: text.length, text }; }
function details() {
  return { schema: "awardping.program-change.v1", event_kind: "program_details_changed",
    summary: "The deadline moved from April 1 to April 15; the submission time and document requirement are unchanged.",
    program_changes: [{ field: "deadline", operation: "replace", summary: "The deadline moved to April 15.",
      previous_quote: quote(previous), current_quote: quote(current) }] };
}
function render(changeDetails: unknown, overrides = {}) {
  return load(renderToStaticMarkup(createElement(ChangeEvidencePanel, {
    changeEventId: "event-1", sourceId: "source-1",
    sourceUrl: "https://example.edu/application", changeDetails, ...overrides,
  })));
}

describe("program-change wording and source action", () => {
  it("offers collapsed exact wording for accepted program changes without repeating the summary or showing visuals", () => {
    const input = details(), original = structuredClone(input);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    try {
      const $ = render(input);
      expect($("details")).toHaveLength(1);
      expect($("details").attr("open")).toBeUndefined();
      expect($("summary").text()).toBe("Exact wording");
      expect($("blockquote").map((_index, node) => $(node).text()).get()).toEqual([previous, current]);
      expect($("h4").text()).toBe("Deadline");
      expect($(".program-change-quotes span").map((_index, node) => $(node).text()).get()).toEqual(["Previously", "Now"]);
      expect($.text()).not.toContain(input.summary);
      expect($("img, iframe, object, button, [role='dialog'], mark, del")).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();
      expect(input).toEqual(original);
    } finally { vi.unstubAllGlobals(); }
  });

  it("withholds legacy quotation recovery and keeps only the official source", () => {
    const $ = render({ reader_summary: "The page changed.", before: previous, after: current,
      exact_before: previous, exact_after: current, structured_diff: { added_text: [current], removed_text: [previous] } });
    expect($("details, blockquote, img, iframe, object, button")).toHaveLength(0);
    expect($.text()).toBe("Official source");
  });

  it.each(["field", "offsets", "operation", "schema", "extra"])("withholds malformed %s contract quotes", mutation => {
    const input = details();
    if (mutation === "field") input.program_changes[0].field = "alumni_profiles";
    if (mutation === "offsets") input.program_changes[0].current_quote.end_utf16++;
    if (mutation === "operation") input.program_changes[0].operation = "unproven";
    if (mutation === "schema") input.schema = "visual-event-evidence-v2";
    if (mutation === "extra") Object.assign(input, { crop: { url: "https://private.test/image.jpg" } });
    const $ = render(input);
    expect($("details, blockquote, img")).toHaveLength(0);
    expect($.text()).toBe("Official source");
  });

  it.each(["add", "remove"] as const)("does not invent the unavailable side of a %s", operation => {
    const input = details();
    Object.assign(input.program_changes[0], { operation,
      previous_quote: operation === "add" ? null : quote(previous),
      current_quote: operation === "remove" ? null : quote(current) });
    const $ = render(input);
    expect($("blockquote")).toHaveLength(1);
    expect($("blockquote").text()).toBe(operation === "add" ? current : previous);
    expect($(".program-change-quotes span").text()).toBe(operation === "add" ? "Now" : "Previously");
  });

  it("preserves exact whitespace, qualifications and literal markup without executing it", () => {
    const input = details();
    const text = 'Only if nominated:\n\tSubmit the form <script>alert("x")</script> by 5 p.m. ET.';
    input.program_changes[0].current_quote = quote(text);
    const $ = render(input);
    expect($("blockquote").last().text()).toBe(text);
    expect($("script, img, iframe, object")).toHaveLength(0);
  });

  it("uses the publisher PDF as an ordinary source link without a saved-PDF action", () => {
    const $ = render(null, { sourceUrl: "https://example.edu/guidance.pdf" });
    expect($("a")).toHaveLength(1);
    expect($("a").attr("href")).toBe("https://example.edu/guidance.pdf");
    expect($("a").attr("rel")).toBe("noreferrer");
    expect($("a").text()).toBe("Official source");
    expect($("button, iframe, object, img, details")).toHaveLength(0);
  });

  it("does not duplicate a source link provided by the parent", () => {
    const $ = render(details(), { hideSourceLink: true });
    expect($("a")).toHaveLength(0);
    expect($("details")).toHaveLength(1);
    expect(render(null, { hideSourceLink: true }).text()).toBe("");
  });

  it.each(["javascript:alert(1)", "data:text/html,test", "https://user:password@example.edu/"])(
    "does not render an unsafe source link %s", sourceUrl => {
      expect(render(null, { sourceUrl })("a")).toHaveLength(0);
    },
  );
});
