import { describe, expect, it } from "vitest";
import { compareHtmlDocuments, validateHtmlDocument } from "./analyze-scrapling-html.mjs";

const sourceUrl = "https://example.edu/award?cycle=2027";
const heading = { level: 1, text: "Example Award" };

function fixture() {
  return {
    schema: "awardping.scrapling-html-document.v1",
    scope: "html-source-main-document",
    source_url: sourceUrl,
    title: "Example Award",
    text: "Example Award Apply by October 31, 2026. U.S. citizens only. Applicants must hold a bachelor's degree.",
    blocks: [
      { kind: "heading", text: "Example Award", heading_path: [heading], list_path: [], table_row: [] },
      { kind: "paragraph", text: "Apply by October 31, 2026.", heading_path: [heading], list_path: [], table_row: [] },
      { kind: "paragraph", text: "U.S. citizens only.", heading_path: [heading], list_path: [], table_row: [] },
      { kind: "paragraph", text: "Applicants must hold a bachelor's degree.", heading_path: [heading], list_path: [], table_row: [] },
    ],
    links: [{ text: "Application", raw_href: "/apply?cycle=2027", source_url: sourceUrl, base_hrefs: [], heading_path: [heading], list_path: [] }],
    base_hrefs: [],
    limitations: ["visibility_not_verified", "raw_html_main_document_only"],
    counts: { blocks: 4, links: 1 },
    publishable: false,
    visibility_verified: false,
  };
}

function expectReview(result, fields) {
  expect(result).toMatchObject({
    status: "changed_needs_review", publishable: false,
    scope: "html_source_main_document", accuracy_benchmark: false,
  });
  if (fields) expect(result.fields).toEqual(expect.arrayContaining(fields));
}

function expectUnavailable(result) {
  expect(result).toMatchObject({
    status: "unavailable", publishable: false,
    scope: "html_source_main_document", accuracy_benchmark: false,
  });
}

describe("retained HTML document validation", () => {
  it("retains neutral sibling-button paths and compares a mixed old/new relationship as changed", () => {
    const before = fixture(), enriched = structuredClone(before);
    enriched.blocks[1].sibling_button_path = ["Applicants", "Applicants"];
    enriched.links[0].sibling_button_path = ["Applicants"];
    expect(validateHtmlDocument(enriched, { sourceUrl })).toEqual(enriched);
    expect(compareHtmlDocuments(before, enriched)).toMatchObject({ status: "changed_needs_review", fields: ["blocks", "links"], publishable: false });
  });
  it.each([null, "Label", [], [null], [3], [""], ["  "], Array(101).fill("Label"), ["x".repeat(10001)]])("rejects malformed sibling-button path %j", path => {
    for (const field of ["blocks", "links"]) {
      const record = fixture(); record[field][0].sibling_button_path = path;
      expect(() => validateHtmlDocument(record, { sourceUrl })).toThrow(field === "blocks" ? "invalid_html_block" : "invalid_html_link");
    }
  });

  it("retains optional FAQ context and still accepts older context-free evidence", () => {
    const record = fixture();
    expect(validateHtmlDocument(record, { sourceUrl })).toEqual(record);
    record.blocks[1].details_path = ["U.S. applicants", ""];
    record.links[0].details_path = ["U.S. applicants"];
    expect(validateHtmlDocument(record, { sourceUrl })).toEqual(record);
    const moved = structuredClone(record);
    delete moved.blocks[1].details_path;
    expect(compareHtmlDocuments(record, moved)).toMatchObject({ status: "changed_needs_review", fields: ["blocks"] });
  });

  it.each([null, "Question", [], [null], [4], Array(101).fill("Question")])("rejects malformed FAQ context %j", path => {
    for (const field of ["blocks", "links"]) {
      const record = fixture();
      record[field][0].details_path = path;
      expect(() => validateHtmlDocument(record, { sourceUrl })).toThrow(field === "blocks" ? "invalid_html_block" : "invalid_html_link");
    }
  });

  it("accepts complete source-bound evidence without mutating it", () => {
    const record = fixture();
    const before = structuredClone(record);
    expect(validateHtmlDocument(record, { sourceUrl })).toEqual(record);
    expect(record).toEqual(before);
  });

  it.each([
    ["missing document", () => null],
    ["wrong schema", (d) => ({ ...d, schema: "awardping.scrapling-document.v1" })],
    ["visible scope mislabeled as HTML", (d) => ({ ...d, scope: "whole-visible-main-document" })],
    ["different source", (d) => ({ ...d, source_url: "https://example.edu/another" })],
    ["missing source", (d) => ({ ...d, source_url: undefined })],
    ["empty text", (d) => ({ ...d, text: "" })],
    ["whitespace text", (d) => ({ ...d, text: "   " })],
    ["non-text content", (d) => ({ ...d, text: 2027 })],
    ["missing title", (d) => ({ ...d, title: undefined })],
    ["non-text title", (d) => ({ ...d, title: {} })],
    ["missing blocks", (d) => ({ ...d, blocks: undefined })],
    ["malformed block", (d) => ({ ...d, blocks: [null] })],
    ["missing links", (d) => ({ ...d, links: undefined })],
    ["malformed link", (d) => ({ ...d, links: [null] })],
    ["non-array bases", (d) => ({ ...d, base_hrefs: "/" })],
    ["malformed base", (d) => ({ ...d, base_hrefs: [null] })],
    ["publication enabled", (d) => ({ ...d, publishable: true })],
    ["visibility claimed", (d) => ({ ...d, visibility_verified: true })],
  ])("rejects %s with a stable error", (_label, mutate) => {
    const record = mutate(fixture());
    const errors = [];
    for (let pass = 0; pass < 2; pass += 1) {
      try { validateHtmlDocument(record, { sourceUrl }); } catch (error) { errors.push(error.message); }
    }
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeTruthy();
    expect(errors[0]).toBe(errors[1]);
  });

  it.each([
    ["missing kind", (d) => { delete d.blocks[1].kind; }],
    ["empty block text", (d) => { d.blocks[1].text = ""; }],
    ["invalid heading level", (d) => { d.blocks[1].heading_path = [{ level: 9, text: "Eligibility" }]; }],
    ["empty heading text", (d) => { d.blocks[1].heading_path = [{ level: 2, text: "" }]; }],
    ["missing list context", (d) => { delete d.blocks[1].list_path; }],
    ["non-text list context", (d) => { d.blocks[1].list_path = [10]; }],
    ["non-text table context", (d) => { d.blocks[1].table_row = [null]; }],
    ["scalar table cell", (d) => { d.blocks[1].table_cell = 2; }],
    ["null table cell", (d) => { d.blocks[1].table_cell = null; }],
    ["missing raw href", (d) => { delete d.links[0].raw_href; }],
    ["non-text raw href", (d) => { d.links[0].raw_href = 123; }],
    ["wrong link source", (d) => { d.links[0].source_url = "https://example.edu/other"; }],
    ["missing link bases", (d) => { delete d.links[0].base_hrefs; }],
    ["inconsistent link bases", (d) => { d.links[0].base_hrefs = ["/another-base/"]; }],
    ["malformed link context", (d) => { d.links[0].heading_path = [null]; }],
  ])("rejects malformed relationship: %s", (_label, mutate) => {
    const record = fixture();
    mutate(record);
    expect(() => validateHtmlDocument(record, { sourceUrl })).toThrow();
  });

  it("retains empty raw href as evidence instead of resolving or dropping it", () => {
    const record = fixture();
    record.links[0].raw_href = "";
    expect(validateHtmlDocument(record, { sourceUrl }).links[0].raw_href).toBe("");
  });

  it("rejects oversized UTF-8 text", () => {
    const record = fixture();
    record.text = "é".repeat(6 * 1024 * 1024);
    expect(() => validateHtmlDocument(record, { sourceUrl })).toThrow();
  });

  it("bounds total UTF-8 bytes even when individual text fields stay within their character limits", () => {
    const record = fixture();
    record.blocks = Array.from({ length: 12 }, () => ({ ...record.blocks[1], text: "é".repeat(230000) }));
    expect(() => validateHtmlDocument(record, { sourceUrl })).toThrow();
  });

  it.each(["https://", "https:// bad.example/", "file:///award", "http://127.0.0.1/", "https://name:secret@example.edu/award"])("rejects invalid capture source %s", (badSource) => {
    const record = fixture();
    record.source_url = badSource;
    record.links[0].source_url = badSource;
    expect(() => validateHtmlDocument(record, { sourceUrl: badSource })).toThrow();
  });
});

describe("retained HTML comparison", () => {
  it("reports an identical pair as unchanged but never publishable or an accuracy benchmark", () => {
    expect(compareHtmlDocuments(fixture(), fixture())).toMatchObject({
      status: "unchanged", publishable: false,
      scope: "html_source_main_document", accuracy_benchmark: false,
    });
  });

  it.each([
    ["deadline in a closed section", "October 31, 2026", "November 30, 2026"],
    ["hidden citizenship condition", "U.S. citizens only.", "Citizens of any country may apply."],
    ["degree qualification in a collapsed answer", "must hold a bachelor's degree", "must not hold a bachelor's degree"],
  ])("detects %s retained in HTML text", (_label, before, after) => {
    const previous = fixture();
    const current = fixture();
    current.text = current.text.replace(before, after);
    for (const block of current.blocks) block.text = block.text.replace(before, after);
    expectReview(compareHtmlDocuments(previous, current), ["text", "blocks"]);
  });

  it("detects text outside selected semantic blocks", () => {
    const previous = fixture();
    const current = fixture();
    current.text += " Applicants living abroad are not eligible.";
    expectReview(compareHtmlDocuments(previous, current), ["text"]);
  });

  it.each([
    ["title", (d) => { d.title = "2028 Example Award"; }, "title"],
    ["raw href", (d) => { d.links[0].raw_href = "/apply?cycle=2028"; }, "links"],
    ["empty-query href", (d) => { d.links[0].raw_href = "?"; }, "links"],
    ["document base href", (d) => { d.base_hrefs = ["https://applications.example.edu/"]; d.links[0].base_hrefs = [...d.base_hrefs]; }, "base_hrefs"],
    ["link base context", (d) => { d.base_hrefs = ["https://applications.example.edu/"]; d.links[0].base_hrefs = [...d.base_hrefs]; }, "links"],
    ["heading relationship", (d) => { d.blocks[2].heading_path = [{ level: 2, text: "Exceptions" }]; }, "blocks"],
    ["list qualification", (d) => { d.blocks[2].list_path = ["Only renewal applicants"]; }, "blocks"],
    ["table relationship", (d) => { d.blocks[2].table_row = ["International students", "Not eligible"]; }, "blocks"],
    ["table cell span", (d) => { d.blocks[2].table_cell = { colspan: 2, rowspan: 1, scope: "row" }; }, "blocks"],
    ["link heading relationship", (d) => { d.links[0].heading_path = [{ level: 2, text: "Previous cycle" }]; }, "links"],
    ["block order", (d) => { d.blocks.reverse(); }, "blocks"],
    ["duplicate requirement", (d) => { d.blocks.push(structuredClone(d.blocks[2])); }, "blocks"],
    ["duplicate link", (d) => { d.links.push(structuredClone(d.links[0])); }, "links"],
    ["base additions", (d) => { d.base_hrefs = ["/a/", "/b/"]; d.links[0].base_hrefs = [...d.base_hrefs]; }, "base_hrefs"],
  ])("detects %s changes", (_label, mutate, field) => {
    const previous = fixture();
    const current = fixture();
    mutate(current);
    expectReview(compareHtmlDocuments(previous, current), [field]);
  });

  it("preserves order when the same two links are reversed", () => {
    const previous = fixture();
    previous.links.push({ ...structuredClone(previous.links[0]), text: "Eligibility", raw_href: "/eligibility" });
    const current = structuredClone(previous);
    current.links.reverse();
    expectReview(compareHtmlDocuments(previous, current), ["links"]);
  });

  it("preserves base order because only the first usable base controls relative destinations", () => {
    const previous = fixture();
    previous.base_hrefs = ["/a/", "/b/"];
    previous.links[0].base_hrefs = [...previous.base_hrefs];
    const current = structuredClone(previous);
    current.base_hrefs.reverse();
    current.links[0].base_hrefs = [...current.base_hrefs];
    expectReview(compareHtmlDocuments(previous, current), ["base_hrefs", "links"]);
  });

  it("ignores diagnostic counts and limitations without declaring visibility verified", () => {
    const previous = fixture();
    const current = fixture();
    current.counts = { ...current.counts, diagnostics: 12 };
    current.limitations = [...current.limitations, "closed_sections_included_without_rendering"];
    expect(compareHtmlDocuments(previous, current)).toMatchObject({ status: "unchanged", publishable: false });
    expect(current.visibility_verified).toBe(false);
  });

  it.each([
    ["missing previous", () => [null, fixture()]],
    ["missing current", () => [fixture(), null]],
    ["empty previous", () => [{}, fixture()]],
    ["empty current text", () => [fixture(), { ...fixture(), text: "" }]],
    ["different sources", () => [fixture(), { ...fixture(), source_url: "https://example.edu/other" }]],
    ["wrong schema", () => [fixture(), { ...fixture(), schema: "legacy" }]],
    ["visibility claim", () => [fixture(), { ...fixture(), visibility_verified: true }]],
    ["malformed block", () => [fixture(), { ...fixture(), blocks: [null] }]],
  ])("does not call %s unchanged", (_label, records) => {
    expectUnavailable(compareHtmlDocuments(...records()));
  });
});
