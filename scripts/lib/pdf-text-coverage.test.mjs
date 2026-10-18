import { describe, expect, it } from "vitest";
import { assessPdfTextCoverage, pdfTextComparisonHoldReason } from "./pdf-text-coverage.mjs";

const fileHash = "a".repeat(64);
const dense = "Applicant requirements and complete application instructions. ".repeat(4);
function capture(texts = [dense]) {
  return { file_hash: fileHash, page_count: texts.length,
    pdf_text_coverage: assessPdfTextCoverage({ total: texts.length, pages: texts.map((text, i) => ({ num: i + 1, text })) }, fileHash) };
}

describe("PDF native text diagnostics, not semantic completeness", () => {
  it("records per-page text without claiming image or complete semantic coverage", () => {
    expect(capture().pdf_text_coverage).toMatchObject({ status: "native_text_present", image_content_verified: false,
      semantic_completeness: "not_established", file_sha256: fileHash, sparse_pages: [] });
  });
  it("flags footer-only and diagram-heading pages without inventing OCR text", () => {
    const result = capture(["2027 sample application 1", dense, "Application pathways route map 13"]).pdf_text_coverage;
    expect(result.status).toBe("sparse_pages");
    expect(result.sparse_pages).toEqual([1, 3]);
    expect(result.pages[0]).not.toHaveProperty("text");
  });
  it.each([
    { total: 2, pages: [{ num: 1, text: dense }] },
    { total: 2, pages: [{ num: 1, text: dense }, { num: 1, text: dense }] },
    { total: 1, pages: [{ num: 1 }] },
    { total: 0, pages: [] },
    { total: 1001, pages: [] },
    { total: "1", pages: [{ num: 1, text: dense }] },
  ])("fails closed on incomplete/malformed page observations %j", result => {
    expect(assessPdfTextCoverage(result, fileHash).status).toBe("page_list_incomplete");
  });
  it("does not count whitespace as meaningful page text", () => {
    expect(capture([" \n\t".repeat(100)]).pdf_text_coverage.status).toBe("sparse_pages");
  });
  it("rejects a missing file binding", () => {
    expect(assessPdfTextCoverage({ total: 1, pages: [{ num: 1, text: dense }] }, null).status).toBe("page_list_incomplete");
  });
});

describe("changed PDF review holds", () => {
  it("always holds changed bytes with equal extracted text, even on otherwise readable pages", () => {
    expect(pdfTextComparisonHoldReason({ previous: capture(), capture: capture(), textChanged: false }))
      .toBe("pdf_changed_bytes_same_text_requires_visual_review");
  });
  it("allows existing review gates only with both page lists present and nonsparse", () => {
    expect(pdfTextComparisonHoldReason({ previous: capture(), capture: capture(), textChanged: true })).toBeNull();
  });
  it.each(["previous", "capture"])("holds sparse or legacy %s without auto-upgrading metadata", side => {
    const input = { previous: capture(), capture: capture(), textChanged: true };
    input[side] = capture(["page 1"]);
    expect(pdfTextComparisonHoldReason(input)).toMatch(/page_text_coverage_unverified$/);
    input[side] = { file_hash: fileHash, page_count: 1 };
    expect(pdfTextComparisonHoldReason(input)).toMatch(/page_text_coverage_unverified$/);
  });
  it.each([
    c => { c.file_hash = "b".repeat(64); },
    c => { c.page_count = 2; },
    c => { c.pdf_text_coverage.pages[0].page = 2; },
    c => { c.pdf_text_coverage.pages[0] = null; },
    c => { c.pdf_text_coverage.minimum_page_characters = 0; },
    c => { c.pdf_text_coverage.pages[0].native_text_characters = 1; },
    c => { c.pdf_text_coverage.image_content_verified = true; },
  ])("does not trust a malformed/incorrectly bound coverage flag", mutate => {
    const next = capture(); mutate(next);
    expect(pdfTextComparisonHoldReason({ previous: capture(), capture: next, textChanged: true }))
      .toBe("pdf_current_page_text_coverage_unverified");
  });
});
