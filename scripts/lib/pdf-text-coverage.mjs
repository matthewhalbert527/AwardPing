const shaPattern = /^[a-f0-9]{64}$/;
const schema = "awardping.pdf-native-text-coverage.v1";
const minimumCharacters = 80;

/** Diagnostic only: native text presence is not proof that image/diagram content was read. */
export function assessPdfTextCoverage(result, fileHash) {
  const base = { schema, file_sha256: fileHash, semantic_completeness: "not_established",
    image_content_verified: false, minimum_page_characters: minimumCharacters };
  const total = result?.total;
  if (!shaPattern.test(fileHash || "") || !Number.isInteger(total) || total < 1 || total > 1000 ||
      !Array.isArray(result.pages) || result.pages.length !== total ||
      result.pages.some((page, i) => page?.num !== i + 1 || typeof page.text !== "string")) {
    return { ...base, status: "page_list_incomplete", total_pages: Number.isInteger(total) ? total : null,
      pages: [], sparse_pages: [] };
  }
  const pages = result.pages.map(page => ({ page: page.num,
    native_text_characters: page.text.replace(/\s/g, "").length }));
  const sparse = pages.filter(page => page.native_text_characters < minimumCharacters).map(page => page.page);
  return { ...base, status: sparse.length ? "sparse_pages" : "native_text_present", total_pages: total,
    pages, sparse_pages: sparse };
}

function coverageVerified(capture) {
  const coverage = capture?.pdf_text_coverage;
  return coverage?.schema === schema && shaPattern.test(capture.file_hash || "") &&
    coverage.file_sha256 === capture.file_hash && coverage.status === "native_text_present" &&
    coverage.semantic_completeness === "not_established" && coverage.image_content_verified === false &&
    coverage.minimum_page_characters === minimumCharacters && Number.isInteger(coverage.total_pages) &&
    coverage.total_pages > 0 && coverage.total_pages <= 1000 && coverage.total_pages === capture.page_count &&
    Array.isArray(coverage.pages) && coverage.pages.length === coverage.total_pages &&
    coverage.pages.every((page, i) => page?.page === i + 1 && Number.isInteger(page.native_text_characters) &&
      page.native_text_characters >= minimumCharacters) &&
    Array.isArray(coverage.sparse_pages) && coverage.sparse_pages.length === 0;
}

/** Changed bytes with matching text may contain image edits: never auto-reject or advance a baseline. */
export function pdfTextComparisonHoldReason({ previous, capture, textChanged } = {}) {
  if (textChanged !== true) return "pdf_changed_bytes_same_text_requires_visual_review";
  if (!coverageVerified(previous)) return "pdf_previous_page_text_coverage_unverified";
  if (!coverageVerified(capture)) return "pdf_current_page_text_coverage_unverified";
  return null;
}
