import { createHash } from "node:crypto";
import { khs2027ReviewedVisiblePdf as data } from "./fixtures/khs-2027-reviewed-visible-pdf.mjs";

// This finite projection is a reviewed transcription of one exact published
// original. It is not native extraction, OCR confidence or a generic PDF repair.
export const REVIEWED_VISIBLE_PDF_EXTRACTOR = "reviewed-visible-pdf-text";
export const REVIEWED_VISIBLE_PDF_DATA_SHA256 = "294d2e138664da88d263b831f38098dd4aa8a6719e42152cf6d1b8f2f1e9ea8d";
export const REVIEWED_VISIBLE_PDF_VERSION = "reviewed-visible-pdf-v1/" + REVIEWED_VISIBLE_PDF_DATA_SHA256;
const hash = value => createHash("sha256").update(value).digest("hex");
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const fail = reason => { throw Object.assign(new Error("Reviewed visible PDF: " + reason), { code: "program_text_reviewed_pdf_" + reason }); };
const check = (value, reason) => { if (!value) fail(reason); };
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const identity = Object.freeze({
  id: "c79d5081-83bb-4384-8f42-31450e80025a",
  shared_award_id: "141944a8-fd04-4433-b0e4-8990fae56764",
  url: "https://knight-hennessy.stanford.edu/sites/g/files/sbiybj23586/files/media/file/khs_2027_sample_app.pdf",
  title: "PDF sample of the application", page_type: "pdf",
});
const rawIdentity = Object.freeze({ sha256: "6cb6b8a4702ae4f16230ad33ef2e57c8251b517301d01709b04c7bd7465dd4b0", byte_length: 2742121, physical_pages: 20 });

export const isReviewedVisiblePdfSourceId = source => source?.id === identity.id;

export function reviewedVisiblePdfProfile(source) {
  if (!plain(source) || Object.keys(identity).some(key => source[key] !== identity[key])) return null;
  return { source: { ...identity }, raw: { ...rawIdentity }, extractor: { name: REVIEWED_VISIBLE_PDF_EXTRACTOR, version: REVIEWED_VISIBLE_PDF_VERSION } };
}

/** Either reserved half makes a malformed or transplanted profile fail closed. */
export function isReviewedVisiblePdfExtractor(extractor) {
  return extractor?.name === REVIEWED_VISIBLE_PDF_EXTRACTOR ||
    typeof extractor?.version === "string" && extractor.version.startsWith("reviewed-visible-pdf-v1/");
}

function projectionFromReviewedData() {
  check(hash(JSON.stringify(data, null, 2)) === REVIEWED_VISIBLE_PDF_DATA_SHA256 &&
    data.schema === "awardping.exact-reviewed-visible-pdf-data.v1" && same(data.source, identity) && same(data.raw, rawIdentity), "reviewed_data_changed");
  check(data.review.method === "independent_agent_visible_transcription" && data.review.native_extraction_claimed === false &&
    data.review.ocr_engine_verification_claimed === false && data.review.human_certification_claimed === false &&
    data.pages.length === 20 && data.review.independent_review_sha256 === "202a5547807f2afff0c2f9abc2bc8276844b751fe54bce52ad2e097d7db9e65f", "review_provenance_changed");
  let text = ""; const blocks = [], pages = [];
  for (const [index, page] of data.pages.entries()) {
    check(page.page === index + 1 && hex(page.original_render_sha256) && hex(page.reviewed_transcript_sha256) &&
      Array.isArray(page.lines) && page.lines.length > 0 && page.lines.length <= 300, "page_coverage_changed");
    if (text) text += "\n\f\n";
    const pageStart = text.length;
    for (const [lineIndex, line] of page.lines.entries()) {
      check(typeof line.text === "string" && line.text.trim() && line.text.length <= 3500 &&
        !line.text.includes("\0") && !line.text.includes("\n") && Number.isInteger(line.source_line) && line.source_line > 0, "invalid_visible_line");
      if (lineIndex) text += "\n";
      const start = text.length; text += line.text;
      blocks.push({ id: `reviewed-pdf-p${String(page.page).padStart(3, "0")}-l${String(lineIndex + 1).padStart(3, "0")}`,
        text: line.text, start_utf16: start, end_utf16: text.length, page: page.page, kind: "reviewed_pdf_text",
        context: { representation: "reviewed_visible_pdf_text", method: "independent_agent_visible_transcription",
          document_scope: "sample_application", profile_sha256: REVIEWED_VISIBLE_PDF_DATA_SHA256,
          original_render_sha256: page.original_render_sha256, reviewed_transcript_sha256: page.reviewed_transcript_sha256,
          source_line: line.source_line,
          ...(line.table_row === undefined ? {} : { table_row: line.table_row, table_cell: line.table_cell }),
          ...(line.collapsed_control_label ? { collapsed_control_label: true, unopened_content_included: false } : {}) } });
    }
    pages.push({ page: page.page, original_render_sha256: page.original_render_sha256,
      reviewed_transcript_sha256: page.reviewed_transcript_sha256, projected_text_sha256: hash(text.slice(pageStart)), lines: page.lines.length });
  }
  check(blocks.length === 781 && pages.at(-1)?.page === 20 && text.length > 30_000 && text.length < 50_000, "visible_text_coverage_changed");
  const provenance = {
    schema: "awardping.reviewed-visible-pdf-provenance.v1", profile_sha256: REVIEWED_VISIBLE_PDF_DATA_SHA256,
    source: { ...identity }, raw: { ...rawIdentity }, review: structuredClone(data.review),
    source_limitations: structuredClone(data.limitations), pages,
    projected_text_sha256: hash(text), projected_blocks_sha256: hash(JSON.stringify(canonical(blocks))),
    completeness_scope: "all_legible_visible_static_text_of_exact_original",
    hidden_or_unreadable_source_values_inferred: false,
  };
  return { text, blocks, completeness: { status: "complete", reasons: [] }, reviewed_pdf: provenance };
}

/** Recomputed from packaged reviewed text and the bytes actually collected. A
 * changed original never inherits this review, even when its URL is unchanged. */
export function projectReviewedVisiblePdf(bytes, { source, final_url = source?.url } = {}) {
  const profile = reviewedVisiblePdfProfile(source);
  check(profile && final_url === identity.url, "source_not_admitted");
  check(Buffer.isBuffer(bytes) && bytes.length === rawIdentity.byte_length && hash(bytes) === rawIdentity.sha256, "unreviewed_original");
  return projectionFromReviewedData();
}

export function reviewedVisiblePdfReferenceMatches(ref) {
  try {
    const profile = reviewedVisiblePdfProfile(ref?.source);
    if (!profile || ref.acquisition !== "pdf_text" || ref.final_url !== identity.url || !same(ref.extractor, profile.extractor) ||
      ref.artifacts?.raw?.sha256 !== rawIdentity.sha256 || ref.artifacts.raw.byte_length !== rawIdentity.byte_length) return false;
    const projected = projectionFromReviewedData();
    return ref.text_sha256 === projected.reviewed_pdf.projected_text_sha256 && ref.text_length === projected.text.length &&
      ref.blocks_sha256 === projected.reviewed_pdf.projected_blocks_sha256 &&
      ref.completeness?.status === "complete" && Array.isArray(ref.completeness.reasons) && !ref.completeness.reasons.length;
  } catch { return false; }
}

export function validateReviewedVisiblePdfCapture(capture) {
  const profile = reviewedVisiblePdfProfile(capture.source);
  check(profile && capture.acquisition === "pdf_text" && same(capture.extractor, profile.extractor), "invalid_profile");
  const expected = projectReviewedVisiblePdf(capture.raw_source.bytes, { source: capture.source, final_url: capture.final_url });
  check(capture.text === expected.text && same(capture.blocks, expected.blocks) &&
    same(capture.completeness, expected.completeness) && same(capture.reviewed_pdf, expected.reviewed_pdf), "projection_or_provenance_changed");
  return capture;
}
