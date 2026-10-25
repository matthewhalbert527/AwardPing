import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProgramTextCapture, validateProgramTextCapture, captureProgramTextSource,
  blocksFromHtmlDocument, PROGRAM_TEXT_CAPTURE_PROFILE } from "./program-text-capture.mjs";
import { buildProgramTextComparison, buildProgramTextReviewPackets } from "./program-text-review.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
const source = { id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222", url: "https://example.org/award", title: "Example Award", page_type: "application" };
const paragraph = "The 2027 application deadline is March 15. All applicants must be enrolled full time.";
const html = Buffer.from(`<html><body><h1>Example Award</h1><p>${paragraph}</p></body></html>`);
const document = (text = paragraph) => ({ text, blocks: [{ kind: "p", text, heading_path: [{ level: 1, text: "Example Award" }], list_path: [], table_row: [] }] });
const fixture = (options = {}) => buildProgramTextCapture({ source, acquisition: "http_html", raw_bytes: html,
  content_type: "text/html; charset=utf-8", text: paragraph, blocks: blocksFromHtmlDocument(document()),
  extractor: { name: "test", version: "1" }, captured_at: "2026-10-23T01:00:00.000Z", ...options });
const clone = value => ({ ...structuredClone(value), raw_source: { ...value.raw_source, bytes: Buffer.from(value.raw_source.bytes) } });
const fetched = (overrides = {}) => ({ status: 200, buffer: html, finalUrl: source.url, contentType: "text/html; charset=utf-8", ...overrides });

describe("text capture contract", () => {
  it("retains raw source, exact text and a stable identity with no visual slots", () => {
    const capture = fixture();
    expect(capture.capture_profile).toBe(PROGRAM_TEXT_CAPTURE_PROFILE);
    expect(capture.capture_id).toBe(fixture().capture_id);
    expect(capture.raw_source.bytes.equals(html)).toBe(true);
    expect(capture.raw_source.sha256).toBe(hash(html));
    expect(capture.text_sha256).toBe(hash(paragraph));
    expect(validateProgramTextCapture(capture, { source })).toBe(capture);
    for (const key of ["screenshot", "thumbnail", "page_path", "layout", "geometry", "image_hash"]) expect(capture).not.toHaveProperty(key);
  });
  it("survives JSON object key ordering without weakening content binding", () => {
    const capture = clone(fixture());
    capture.source = Object.fromEntries(Object.entries(capture.source).reverse());
    capture.extractor = Object.fromEntries(Object.entries(capture.extractor).reverse());
    capture.blocks = capture.blocks.map(block => Object.fromEntries(Object.entries(block).reverse()));
    expect(validateProgramTextCapture(capture)).toBe(capture);
  });
  it("defends source identity, not merely award matching", () => {
    for (const next of [{ ...source, id: "33333333-3333-4333-8333-333333333333" },
      { ...source, shared_award_id: "44444444-4444-4444-8444-444444444444" }, { ...source, url: "https://example.org/other" }]) {
      expect(() => validateProgramTextCapture(fixture(), { source: next })).toThrow("source_identity_mismatch");
    }
  });
  it.each(["00000000-0000-0000-0000-000000000000", "not-an-id", "11111111-1111-4111-8111-11111111111Z"])("rejects invalid UUID %s", id => {
    expect(() => fixture({ source: { ...source, id } })).toThrow("invalid_source_identity");
  });
  it.each(["http://127.0.0.1/a", "https://example.org/a#x", "https://user:password@example.org/a", "file:///a"])("rejects unsafe URL %s", url => {
    expect(() => fixture({ source: { ...source, url } })).toThrow();
  });
  it.each(["text", "raw_source", "blocks", "metadata"])("detects changed %s", part => {
    const capture = clone(fixture());
    if (part === "text") capture.text += " altered";
    if (part === "raw_source") capture.raw_source.bytes[0] = 65;
    if (part === "blocks") capture.blocks[0].text = "invented";
    if (part === "metadata") capture.extractor.version = "2";
    expect(() => validateProgramTextCapture(capture)).toThrow();
  });
  it("does not accept a visual artifact hidden in an otherwise valid capture", () => {
    expect(() => validateProgramTextCapture({ ...fixture(), screenshot: Buffer.from("image") })).toThrow("invalid_contract");
  });
  it("requires ordered complete block coverage and exact quotes", () => {
    for (const blocks of [[], [{ id: "x", text: paragraph.slice(5), start_utf16: 5, end_utf16: paragraph.length }],
      [{ id: "x", text: paragraph.slice(0, 5), start_utf16: 0, end_utf16: 5 }],
      [{ id: "x", text: paragraph, start_utf16: 0, end_utf16: paragraph.length }, { id: "x", text: paragraph, start_utf16: 0, end_utf16: paragraph.length }]]) {
      expect(() => fixture({ blocks })).toThrow();
    }
  });
  it("preserves line breaks, duplicate text and astral UTF16 offsets", () => {
    const text = "Award 🎓\nSame sentence.\nSame sentence.";
    const blocks = [{ id: "a", text: "Award 🎓", start_utf16: 0, end_utf16: 8 },
      { id: "b", text: "Same sentence.", start_utf16: 9, end_utf16: 23 },
      { id: "c", text: "Same sentence.", start_utf16: 24, end_utf16: 38 }];
    const capture = fixture({ text, blocks });
    expect(capture.text).toBe(text);
    expect(capture.blocks.map(b => capture.text.slice(b.start_utf16, b.end_utf16))).toEqual(blocks.map(b => b.text));
  });
  it("rejects bounds that cut surrogate pairs", () => {
    expect(() => fixture({ text: "🎓", blocks: [{ id: "x", text: "\ud83c", start_utf16: 0, end_utf16: 1 }] })).toThrow();
  });
  it("permits an explicitly incomplete empty observation but never a complete one", () => {
    expect(() => fixture({ text: "", blocks: [] })).toThrow();
    expect(fixture({ text: "", blocks: [], completeness: { status: "incomplete", reasons: ["no_native_text"] } }).completeness.status).toBe("incomplete");
  });
});

function nativePdfFixture() {
  const text = "Award deadline March 15 2027. Funding is 20000 dollars annually.";
  const stream = `BT /F1 18 Tf 50 720 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n", offsets = [0];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe("real local extraction engines", () => {
  it("extracts a complete generated PDF with the real bounded native child", async () => {
    const bytes = nativePdfFixture();
    const capture = await captureProgramTextSource({ source: { ...source, page_type: "pdf" }, adapters: { fetch: async () => fetched({ buffer: bytes, contentType: "application/pdf" }) } });
    expect(capture.text).toContain("Award deadline March 15 2027");
    expect(capture.blocks[0].page).toBe(1);
    expect(capture.completeness.status).toBe("complete");
  }, 20_000);
  it.skipIf(!process.env.AWARDPING_PROGRAM_TEXT_TEST_PYTHON)("parses all body and closed FAQ/table text using real Scrapling without <main>", async () => {
    const bytes = Buffer.from("<html><body><h1>Rules</h1><div>Unstructured qualification.</div><details><summary>Who?</summary><p>US citizens only.</p></details><table><tr><th>Funding</th><td>$20,000</td></tr></table><script>IGNORE SCRIPT</script></body></html>");
    const capture = await captureProgramTextSource({ source, pythonPath: process.env.AWARDPING_PROGRAM_TEXT_TEST_PYTHON,
      adapters: { fetch: async () => fetched({ buffer: bytes }) } });
    expect(capture.text).toContain("Unstructured qualification."); expect(capture.text).toContain("US citizens only.");
    expect(capture.text).toContain("$20,000"); expect(capture.text).not.toContain("IGNORE SCRIPT");
    expect(capture.blocks.map(b => b.context?.details_path).filter(Boolean)).toContainEqual(["Who?"]);
    expect(capture.blocks.some(b => b.context?.table_row?.includes("$20,000"))).toBe(true);
  }, 20_000);
  it.skipIf(process.platform !== "win32" || !process.env.AWARDPING_PROGRAM_TEXT_TEST_POPPLER)("runs default private temporary OCR, returns text-only incomplete coverage and cleans temporary images", async () => {
    const parent = path.resolve("tmp"); await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, "program-text-ocr-test-"));
    try {
      const capture = await captureProgramTextSource({ source: { ...source, page_type: "pdf" }, acquisition: "pdf_ocr", timeoutMs: 90_000,
        ocrOptions: { popplerDirectory: process.env.AWARDPING_PROGRAM_TEXT_TEST_POPPLER, tempRoot: root },
        adapters: { fetch: async () => fetched({ buffer: nativePdfFixture(), contentType: "application/pdf" }) } });
      expect(capture.acquisition).toBe("pdf_ocr");
      expect(capture.text).toMatch(/Award|deadline/i);
      expect(capture.completeness.status).toBe("incomplete");
      expect(capture.completeness.reasons).toContain("page_1_ocr_reading_order_unverified");
      expect(await fs.readdir(root)).toEqual([]);
      expect(JSON.stringify(capture.blocks)).not.toMatch(/image_sha|\.png|bounding|geometry/);
    } finally { const actual = await fs.realpath(root); if (path.dirname(actual) !== parent || !path.basename(actual).startsWith("program-text-ocr-test-")) throw new Error("Invalid test cleanup target"); await fs.rm(actual, { recursive: true }); }
  }, 100_000);
  it.skipIf(process.platform !== "win32" || !process.env.AWARDPING_PROGRAM_TEXT_TEST_POPPLER)("cleans the private extraction directory when a local OCR tool fails", async () => {
    const parent = path.resolve("tmp"); await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, "program-text-ocr-test-"));
    try {
      await expect(captureProgramTextSource({ source: { ...source, page_type: "pdf" }, acquisition: "pdf_ocr",
        ocrOptions: { popplerDirectory: process.env.AWARDPING_PROGRAM_TEXT_TEST_POPPLER, tempRoot: root },
        adapters: { fetch: async () => fetched({ buffer: Buffer.from("%PDF-1.4\ninvalid deliberately"), contentType: "application/pdf" }) } })).rejects.toThrow();
      expect(await fs.readdir(root)).toEqual([]);
    } finally { const actual = await fs.realpath(root); if (path.dirname(actual) !== parent || !path.basename(actual).startsWith("program-text-ocr-test-")) throw new Error("Invalid test cleanup target"); await fs.rm(actual, { recursive: true }); }
  }, 30_000);
});

describe("complete HTML block projection", () => {
  it("preserves unstructured text and nested/duplicate content without dropping text", () => {
    const doc = { text: "Preface. Parent Child. Gap. Parent Child. Tail.", blocks: [
      { kind: "li", text: "Parent Child.", heading_path: [{ text: "Eligibility" }], list_path: [], table_row: [] },
      { kind: "p", text: "Child.", heading_path: [], list_path: [], table_row: [] },
      { kind: "li", text: "Parent Child.", heading_path: [{ text: "Funding" }], list_path: [], table_row: [] }] };
    const blocks = blocksFromHtmlDocument(doc);
    expect(blocks.map(b => b.text).join("")).toBe(doc.text);
    expect(blocks.filter(b => b.text === "Parent Child.")).toHaveLength(2);
    expect(blocks.find(b => b.heading === "Funding")).toBeDefined();
  });
  it("keeps table and FAQ qualification context", () => {
    const doc = { text: "Citizenship US only", blocks: [{ kind: "td", text: "Citizenship", heading_path: [], list_path: [], table_row: ["Citizenship", "US only"], details_path: ["Who is eligible?"] },
      { kind: "td", text: "US only", heading_path: [], list_path: [], table_row: ["Citizenship", "US only"] }] };
    const blocks = blocksFromHtmlDocument(doc);
    expect(blocks[0].context.table_row).toEqual(["Citizenship", "US only"]);
    expect(blocks[0].context.details_path).toEqual(["Who is eligible?"]);
  });
  it("splits long HTML wrappers and unstructured prose without clipping qualifiers", () => {
    const text = "Applicants must be enrolled full time. A prior graduate degree is not eligible. ".repeat(300);
    const blocks = blocksFromHtmlDocument({ text, blocks: [{ text, kind: "li", heading_path: [{ text: "Eligibility" }], list_path: [], table_row: [], details_path: ["Who can apply?"] }] });
    expect(blocks.map(block => block.text).join("")).toBe(text);
    expect(blocks.every(block => block.text.length <= 3500 && block.heading === "Eligibility" && block.context.details_path[0] === "Who can apply?")).toBe(true);
  });
});

describe("explicit capture adapters", () => {
  it("uses bounded public HTTP and the entire body, with no <main> requirement", async () => {
    const fetch = vi.fn(async () => fetched()), htmlExtraction = vi.fn(async () => document());
    const capture = await captureProgramTextSource({ source, adapters: { fetch, htmlExtraction } });
    expect(fetch.mock.calls[0][1]).toMatchObject({ maxBytes: 5 * 1024 * 1024, maxRedirects: 5 });
    expect(htmlExtraction.mock.calls[0][0].equals(html)).toBe(true);
    expect(capture.completeness.status).toBe("complete");
  });
  it("keeps approved same-origin redirects without rewriting requested URL", async () => {
    const capture = await captureProgramTextSource({ source, adapters: { fetch: async () => fetched({ finalUrl: "https://example.org/current" }), htmlExtraction: async () => document() } });
    expect(capture.source.url).toBe(source.url); expect(capture.final_url).toBe("https://example.org/current");
  });
  it("requires explicit approval for cross-origin redirects", async () => {
    const options = { source, adapters: { fetch: async () => fetched({ finalUrl: "https://other.org/current" }), htmlExtraction: async () => document() } };
    await expect(captureProgramTextSource(options)).rejects.toThrow("unapproved_redirect_origin");
    expect((await captureProgramTextSource({ ...options, allowedFinalUrls: ["https://other.org/current"] })).final_url).toBe("https://other.org/current");
  });
  it("does not fall back to browser or OCR after a source failure", async () => {
    const renderedHtml = vi.fn(), ocrExtraction = vi.fn();
    await expect(captureProgramTextSource({ source, adapters: { fetch: async () => { throw new Error("blocked"); }, renderedHtml, ocrExtraction } })).rejects.toThrow("blocked");
    expect(renderedHtml).not.toHaveBeenCalled(); expect(ocrExtraction).not.toHaveBeenCalled();
  });
  it("detects an application target change when the visible link label is unchanged", async () => {
    const captures = [];
    for (const suffix of ["old", "new"]) {
      const doc = { ...document(), links: [{ text: "Apply now", raw_href: `https://apply.example.org/${suffix}`, heading_path: [{ text: "How to apply" }] }], base_hrefs: [] };
      const value = await captureProgramTextSource({ source, adapters: { fetch: async () => fetched(), htmlExtraction: async () => doc } });
      captures.push(buildProgramTextCapture({ ...value, raw_bytes: value.raw_source.bytes, content_type: value.raw_source.content_type,
        captured_at: `2026-10-23T01:0${captures.length}:00.000Z` }));
    }
    expect(captures[0].blocks.at(-1)).toMatchObject({ kind: "source_link", text: "https://apply.example.org/old", context: { source_attribute: "href", link_text: "Apply now" } });
    const comparison = buildProgramTextComparison(...captures, { epoch: source.id, cycle_id: "2027" });
    expect(comparison.status).toBe("review_required");
    expect(buildProgramTextReviewPackets(comparison).status).toBe("ready");
  });
  it("does not duplicate arbitrary navigation hrefs into extracted program text", async () => {
    const doc = { ...document(), links: [{ text: "News", raw_href: "/news", heading_path: [] },
      { text: "About", raw_href: "https://scholarship.example.org/about", heading_path: [] },
      { text: "Apply", raw_href: "javascript:alert('apply')", heading_path: [] }] };
    const capture = await captureProgramTextSource({ source, adapters: { fetch: async () => fetched(), htmlExtraction: async () => doc } });
    expect(capture.text).toBe(paragraph); expect(capture.blocks.some(b => b.kind === "source_link")).toBe(false);
  });
  it.each([{ status: 403 }, { contentType: "image/png" }, { buffer: Buffer.from("<title>Just a moment</title>") },
    { buffer: Buffer.from([255, 254]) }, { contentType: "text/html; charset=windows-1252" }])("refuses unavailable/challenged/invalid source %j", async override => {
    const htmlExtraction = vi.fn(async () => document());
    await expect(captureProgramTextSource({ source, adapters: { fetch: async () => fetched(override), htmlExtraction } })).rejects.toThrow();
    expect(htmlExtraction).not.toHaveBeenCalled();
  });
  it("accepts a UTF8 BOM without changing retained bytes", async () => {
    const bytes = Buffer.concat([Buffer.from([239, 187, 191]), html]);
    const capture = await captureProgramTextSource({ source, adapters: { fetch: async () => fetched({ buffer: bytes }), htmlExtraction: async () => document() } });
    expect(capture.raw_source.bytes.equals(bytes)).toBe(true);
  });
  it("uses the existing screenshot-free browser profile for JavaScript pages", async () => {
    const renderedHtml = vi.fn(async () => ({ capture_profile: "scrapling-visible-v1", final_url: source.url,
      captured_at: "2026-10-23T01:00:00.000Z", status_code: 200, html: html.toString(), content_type: "text/html" }));
    const capture = await captureProgramTextSource({ source, acquisition: "rendered_html", adapters: { renderedHtml, htmlExtraction: async () => document() } });
    expect(renderedHtml.mock.calls[0][1].captureProfile).toBe("scrapling-visible-v1");
    expect(capture.acquisition).toBe("rendered_html"); expect(capture.raw_source.bytes.equals(html)).toBe(true);
  });
  it("records unobserved live-connection content and low text as incomplete", async () => {
    const capture = await captureProgramTextSource({ source, acquisition: "rendered_html", adapters: { renderedHtml: async () => ({
      capture_profile: "scrapling-visible-v1", final_url: source.url, captured_at: "2026-10-23T01:00:00.000Z", status_code: 200,
      html: html.toString(), content_type: "text/html", telemetry: { blocked_websockets: 1 } }), htmlExtraction: async () => document("Loading") } });
    expect(capture.completeness).toEqual({ status: "incomplete", reasons: ["insufficient_body_text", "rendered_live_content_not_observed"] });
  });
  it("rejects a screenshot-bearing response even with text attached", async () => {
    await expect(captureProgramTextSource({ source, acquisition: "rendered_html", adapters: { renderedHtml: async () => ({ capture_profile: "scrapling-evidence-v2", screenshot: {} }) } })).rejects.toThrow("invalid_rendered_adapter");
  });
  const pdf = Buffer.from("%PDF-1.4\noriginal-pdf-fixture"), pdfSource = { ...source, page_type: "pdf" };
  const pdfFetch = async () => fetched({ buffer: pdf, contentType: "application/pdf" });
  it("uses browser PDF transport only when explicitly selected, retaining the same native text/page contract", async () => {
    const fetch = vi.fn(), browserPdfFetch = vi.fn(pdfFetch);
    const capture = await captureProgramTextSource({ source: pdfSource, pdf_transport: "browser", executablePath: "C:/Chrome/chrome.exe",
      adapters: { fetch, browserPdfFetch, pdfExtraction: async () => ({ total: 1, pages: [{ num: 1, text: paragraph }] }) } });
    expect(fetch).not.toHaveBeenCalled(); expect(browserPdfFetch).toHaveBeenCalledTimes(1);
    expect(browserPdfFetch.mock.calls[0]).toEqual([source.url, { executablePath: "C:/Chrome/chrome.exe", timeoutMs: expect.any(Number),
      maxBytes: 20 * 1024 * 1024, allowedFinalUrls: [] }]);
    expect(capture.acquisition).toBe("pdf_text"); expect(capture.extractor.version).toBe("2.4.5/program-text-v1/browser-pdf-v1");
    expect(capture.raw_source.bytes.equals(pdf)).toBe(true); expect(capture.completeness.status).toBe("complete");
    expect(capture.blocks[0].page).toBe(1); expect(capture).not.toHaveProperty("screenshot");
  });
  it("does not automatically retry a blocked ordinary PDF through a browser", async () => {
    const browserPdfFetch = vi.fn();
    await expect(captureProgramTextSource({ source: pdfSource, adapters: { fetch: async () => fetched({ status: 403 }), browserPdfFetch } })).rejects.toThrow("source_unavailable");
    expect(browserPdfFetch).not.toHaveBeenCalled();
  });
  it.each(["http_html", "rendered_html", "pdf_ocr"])("rejects browser PDF transport for the unrelated %s acquisition", async acquisition => {
    const browserPdfFetch = vi.fn(), fetch = vi.fn();
    await expect(captureProgramTextSource({ source: pdfSource, acquisition, pdf_transport: "browser", adapters: { fetch, browserPdfFetch } })).rejects.toThrow("invalid_pdf_transport");
    expect(fetch).not.toHaveBeenCalled(); expect(browserPdfFetch).not.toHaveBeenCalled();
  });
  it("keeps final URL and complete page-coverage checks for browser-downloaded PDFs", async () => {
    const pdfExtraction = async () => ({ total: 2, pages: [{ num: 1, text: paragraph }] });
    await expect(captureProgramTextSource({ source: pdfSource, pdf_transport: "browser", adapters: { browserPdfFetch: pdfFetch,
      pdfExtraction } })).rejects.toThrow("pdf_page_coverage_invalid");
    await expect(captureProgramTextSource({ source: pdfSource, pdf_transport: "browser", adapters: {
      browserPdfFetch: async () => fetched({ buffer: pdf, contentType: "application/pdf", finalUrl: "https://other.example.org/plan.pdf" }), pdfExtraction } })).rejects.toThrow("unapproved_redirect_origin");
  });
  it("keeps exact native page text and page-based locators", async () => {
    const capture = await captureProgramTextSource({ source: pdfSource, adapters: { fetch: pdfFetch,
      pdfExtraction: async () => ({ total: 2, pages: [{ num: 1, text: paragraph }, { num: 2, text: "Funding is $20,000 each year." }] }) } });
    expect(capture.text).toBe(`${paragraph}\n\f\nFunding is $20,000 each year.`);
    expect(capture.blocks.map(b => b.page)).toEqual([1, 2]); expect(capture.completeness.status).toBe("complete");
  });
  it("splits long PDF pages into bounded exact text blocks without dropping content or page ownership", async () => {
    const text = "Applicants must be enrolled full time. Funding is 20000 dollars each year. ".repeat(2500);
    const capture = await captureProgramTextSource({ source: pdfSource, adapters: { fetch: pdfFetch,
      pdfExtraction: async () => ({ total: 1, pages: [{ num: 1, text }] }) } });
    expect(capture.text).toBe(text); expect(capture.blocks.map(b => b.text).join("")).toBe(text);
    expect(capture.blocks.every(b => b.page === 1 && b.text.length <= 3500)).toBe(true);
    expect(capture.blocks.length).toBeGreaterThan(40);
  });
  it("rejects missing/reordered PDF pages instead of silently truncating", async () => {
    for (const result of [{ total: 2, pages: [{ num: 1, text: paragraph }] }, { total: 1, pages: [{ num: 2, text: paragraph }] }]) {
      await expect(captureProgramTextSource({ source: pdfSource, adapters: { fetch: pdfFetch, pdfExtraction: async () => result } })).rejects.toThrow("pdf_page_coverage_invalid");
    }
  });
  it("flags sparse PDF text and unverified OCR reading order as incomplete", async () => {
    const sparse = await captureProgramTextSource({ source: pdfSource, adapters: { fetch: pdfFetch, pdfExtraction: async () => ({ total: 1, pages: [{ num: 1, text: "" }] }) } });
    expect(sparse.completeness).toEqual({ status: "incomplete", reasons: ["page_1_sparse_text"] });
    const ocr = await captureProgramTextSource({ source: pdfSource, acquisition: "pdf_ocr", adapters: { fetch: pdfFetch,
      ocrExtraction: async () => ({ total: 1, pages: [{ num: 1, text: paragraph, reading_order_verified: false }], pdf_sha256: hash(pdf), engine_version: "test" }) } });
    expect(ocr.completeness).toEqual({ status: "incomplete", reasons: ["page_1_ocr_reading_order_unverified"] });
    expect(ocr).not.toHaveProperty("image");
  });
  it("requires OCR text to bind the exact original PDF", async () => {
    await expect(captureProgramTextSource({ source: pdfSource, acquisition: "pdf_ocr", adapters: { fetch: pdfFetch,
      ocrExtraction: async () => ({ total: 1, pages: [{ num: 1, text: paragraph }], pdf_sha256: "0".repeat(64) }) } })).rejects.toThrow("ocr_original_binding_mismatch");
  });
  it("never parses a PDF into images or sends it to a provider", () => {
    const code = readFileSync(new URL("./program-text-pdf-worker.mjs", import.meta.url), "utf8");
    expect(code).toContain("parser.getText"); expect(code).not.toMatch(/getScreenshot|getImage|gemini|inlineData|fileData/);
  });
});
