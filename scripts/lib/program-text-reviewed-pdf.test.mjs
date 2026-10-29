import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { khs2027ReviewedVisiblePdf as data } from "./fixtures/khs-2027-reviewed-visible-pdf.mjs";
import { REVIEWED_VISIBLE_PDF_EXTRACTOR, REVIEWED_VISIBLE_PDF_VERSION, REVIEWED_VISIBLE_PDF_DATA_SHA256,
  reviewedVisiblePdfProfile, isReviewedVisiblePdfExtractor, reviewedVisiblePdfReferenceMatches, projectReviewedVisiblePdf } from "./program-text-reviewed-pdf.mjs";
import { captureProgramTextSource } from "./program-text-capture.mjs";
import { buildProgramTextCapture, validateProgramTextCapture } from "./program-text-capture-contract.mjs";
import { programTextArtifactMap, validateProgramTextReference } from "./program-text-artifacts.mjs";
import { buildProgramTextCollectionFailure } from "./program-text-collection-quality.mjs";

const source = { id: "c79d5081-83bb-4384-8f42-31450e80025a", shared_award_id: "141944a8-fd04-4433-b0e4-8990fae56764",
  url: "https://knight-hennessy.stanford.edu/sites/g/files/sbiybj23586/files/media/file/khs_2027_sample_app.pdf", title: "PDF sample of the application", page_type: "pdf" };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const expectedTextSha = "73de008251ee0ba9b5b6a37977533f4e42e10d193f7ac65748f1757049424c49";
const expectedBlocksSha = "fb3d950f0f5cae7482cbff9f9b17400954dc1f6e0eaefb94166b37d5343e6ca4";
const reference = () => {
  const captureId = "a".repeat(64), prefix = `program-text/sources/${source.id}/${captureId}/`;
  return { schema: "awardping.program-text-reference.v1", kind: "program_text", capture_id: captureId,
    source: { ...source }, final_url: source.url, captured_at: "2026-10-29T19:00:00.000Z", acquisition: "pdf_text",
    extractor: { name: REVIEWED_VISIBLE_PDF_EXTRACTOR, version: REVIEWED_VISIBLE_PDF_VERSION }, text_sha256: expectedTextSha,
    text_length: 36517, blocks_sha256: expectedBlocksSha, completeness: { status: "complete", reasons: [] },
    artifacts: {
      raw: { object_key: prefix + "original.pdf", sha256: data.raw.sha256, byte_length: data.raw.byte_length, content_type: "application/pdf" },
      text: { object_key: prefix + "text.txt", sha256: expectedTextSha, byte_length: 36674, content_type: "text/plain; charset=utf-8" },
      metadata: { object_key: prefix + "metadata.json", sha256: "b".repeat(64), byte_length: 500000, content_type: "application/json" },
    } };
};

describe("exact reviewed visible PDF", () => {
  it("pins every one of the20original pages and both independent review records", () => {
    expect(sha(JSON.stringify(data, null, 2))).toBe(REVIEWED_VISIBLE_PDF_DATA_SHA256);
    expect(data.pages.map(page => page.page)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
    expect(data.pages.reduce((count, page) => count + page.lines.length, 0)).toBe(781);
    expect(data.review).toMatchObject({ method: "independent_agent_visible_transcription", native_extraction_claimed: false,
      ocr_engine_verification_claimed: false, human_certification_claimed: false, source_byte_verbatim: false });
    expect(data.review.primary_review_sha256).toBe("66bd23ebf2f9bc076e8d70fc2d409301c364116d005eda7c7735d83b9a8c0fe9");
    expect(data.review.independent_review_sha256).toBe("202a5547807f2afff0c2f9abc2bc8276844b751fe54bce52ad2e097d7db9e65f");
    for (const page of data.pages) {
      expect(page.original_render_sha256).toMatch(/^[a-f0-9]{64}$/); expect(page.reviewed_transcript_sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it("keeps the final-page exceptions and does not recover masked/unopened source content", () => {
    const last = data.pages.at(-1).lines.map(line => line.text).join("\n");
    expect(last).toContain("You may not edit your application after it is submitted");
    for (const literal of ["Test scores", "Recommenders", "Resume", "Degree Programs"]) expect(last).toContain(literal);
    expect(last).not.toContain("administrator");
    const page8 = data.pages[7].lines.map(line => line.text).join("\n");
    expect(page8).toContain("Your Accomplishments\nReason for Leaving");
    expect(page8).not.toMatch(/Your Accomplishments\n\d/);
    const lastCell = data.pages[18].lines.find(line => line.text === "No activities listed");
    expect(lastCell).toMatchObject({ table_cell: 1 });
    expect(data.pages[4].lines.filter(line => line.collapsed_control_label).length).toBe(9);
    expect(data.limitations.map(item => item.page)).toEqual([5, 8, 17, 19, 20]);
    const text = data.pages.flatMap(page => page.lines.map(line => line.text)).join("\n");
    expect(text).not.toContain("|"); expect(text).not.toContain("[+]");
    expect(text).not.toContain(data.limitations[1].detail);
  });
  it("accepts the exact current immutable reference without inventing OCR verification", () => {
    expect(reviewedVisiblePdfReferenceMatches(reference())).toBe(true);
    expect(() => validateProgramTextReference(reference())).not.toThrow();
    expect(reference().extractor.name).not.toContain("ocr");
  });
  it.each([
    ["source ID", ref => { ref.source.id = "c79d5081-83bb-4384-8f42-31450e80025b"; }],
    ["owner", ref => { ref.source.shared_award_id = "141944a8-fd04-4433-b0e4-8990fae56765"; }],
    ["URL", ref => { ref.source.url += "?other=1"; }],
    ["redirect", ref => { ref.final_url += "?other=1"; }],
    ["title", ref => { ref.source.title = "Other PDF"; }],
    ["page type", ref => { ref.source.page_type = "application"; }],
    ["raw SHA", ref => { ref.artifacts.raw.sha256 = "0".repeat(64); }],
    ["raw length", ref => { ref.artifacts.raw.byte_length++; }],
    ["text SHA", ref => { ref.text_sha256 = "0".repeat(64); ref.artifacts.text.sha256 = ref.text_sha256; }],
    ["blocks SHA", ref => { ref.blocks_sha256 = "0".repeat(64); }],
    ["text length", ref => { ref.text_length++; }],
    ["name", ref => { ref.extractor.name = "pdf-parse"; }],
    ["version", ref => { ref.extractor.version += "/other"; }],
    ["OCR acquisition", ref => { ref.acquisition = "pdf_ocr"; }],
  ])("rejects transplanted or changed %s", (_label, mutate) => {
    const ref = reference(); mutate(ref); expect(reviewedVisiblePdfReferenceMatches(ref)).toBe(false);
    expect(() => validateProgramTextReference(ref)).toThrow();
  });
  it("reserves either extractor half; profile reads do not expose mutable packaged state", () => {
    expect(isReviewedVisiblePdfExtractor({ name: REVIEWED_VISIBLE_PDF_EXTRACTOR, version: "forged" })).toBe(true);
    expect(isReviewedVisiblePdfExtractor({ name: "forged", version: REVIEWED_VISIBLE_PDF_VERSION })).toBe(true);
    const first = reviewedVisiblePdfProfile(source); first.raw.sha256 = "0".repeat(64); first.source.url = "https://example.org/";
    expect(reviewedVisiblePdfProfile(source).raw.sha256).toBe(data.raw.sha256);
  });
  it("does not assign a saved visible transcription to arbitrary bytes", () => {
    expect(() => projectReviewedVisiblePdf(Buffer.from("%PDF-1.7\nother original\n%%EOF"), { source })).toThrow("unreviewed_original");
    expect(reviewedVisiblePdfProfile({ ...source, shared_award_id: "141944a8-fd04-4433-b0e4-8990fae56765" })).toBeNull();
  });
  it("retains changed raw PDF bytes as an ordinary incomplete observation with no stale extraction", async () => {
    const bytes = Buffer.from("%PDF-1.7\nnew original body\n%%EOF"), pdfExtraction = vi.fn(), ocrExtraction = vi.fn();
    const capture = await captureProgramTextSource({ source, adapters: {
      fetch: async () => ({ status: 200, contentType: "application/pdf", finalUrl: source.url, buffer: bytes }), pdfExtraction, ocrExtraction } });
    expect(capture.completeness).toEqual({ status: "incomplete", reasons: ["reviewed_pdf_original_not_reviewed"] });
    expect(capture.raw_source.bytes.equals(bytes)).toBe(true); expect(capture.text).toBe(""); expect(capture.blocks).toEqual([]);
    expect(capture).not.toHaveProperty("reviewed_pdf"); expect(pdfExtraction).not.toHaveBeenCalled(); expect(ocrExtraction).not.toHaveBeenCalled();
    expect(() => validateProgramTextCapture(capture)).not.toThrow();
    expect(programTextArtifactMap(capture).find(item => item.role === "raw").body.equals(bytes)).toBe(true);
    const failure = buildProgramTextCollectionFailure({ attempt_id: "11111111-1111-4111-8111-111111111111", source,
      epoch: "22222222-2222-4222-8222-222222222222", expected_state: {}, reason_codes: ["incomplete_capture"], capture, retained_locally: true });
    expect(failure.capture_summary).toMatchObject({ raw_sha256: sha(bytes), raw_byte_length: bytes.length, retained_locally: true,
      incomplete_reason_codes: ["reviewed_pdf_original_not_reviewed"] });
    // No source text reference can be created from this quality hold.
    expect(() => validateProgramTextReference({ ...reference(), completeness: capture.completeness })).toThrow();
  });
  it("requires the declared reviewed-text acquisition before any network operation", async () => {
    const fetch = vi.fn();
    await expect(captureProgramTextSource({ source, acquisition: "pdf_ocr", adapters: { fetch } })).rejects.toThrow("invalid_reviewed_pdf_mode_or_identity");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("a changed admitted identity cannot fall back to an unrelated ordinary extractor", async () => {
    const fetch = vi.fn(), pdfExtraction = vi.fn();
    await expect(captureProgramTextSource({ source: { ...source, title: "Changed title" }, adapters: { fetch, pdfExtraction } }))
      .rejects.toThrow("invalid_reviewed_pdf_mode_or_identity");
    expect(fetch).not.toHaveBeenCalled(); expect(pdfExtraction).not.toHaveBeenCalled();
  });
  it("does not allow hand-written complete text to masquerade as new extraction for the admitted source", () => {
    const text = "A plausible invented programme instruction.";
    expect(() => buildProgramTextCapture({ source, acquisition: "pdf_text", extractor: { name: "pdf-parse", version: "forged" },
      raw_bytes: Buffer.from("%PDF-1.7\nchanged\n%%EOF"), content_type: "application/pdf", text,
      blocks: [{ id: "fake", text, start_utf16: 0, end_utf16: text.length, page: 1 }] })).toThrow("reviewed_pdf_provenance_required");
  });
});
