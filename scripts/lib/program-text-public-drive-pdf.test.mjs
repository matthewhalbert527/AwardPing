import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { PROGRAM_TEXT_PUBLIC_DRIVE_PDF_FILE_IDS as ids, PROGRAM_TEXT_PUBLIC_DRIVE_PDF_VERSION as version,
  programTextPublicDrivePdfIdentity, isProgramTextPublicDrivePdfTransition, isProgramTextPublicDrivePdfMetadata,
  hasProgramTextPublicDrivePdfEnvelope } from "./program-text-public-drive-pdf.mjs";
import { fetchProgramTextPublicDrivePdf } from "./program-text-public-drive-transport.mjs";
import { captureProgramTextSource, buildProgramTextCapture, validateProgramTextCapture } from "./program-text-capture.mjs";
import { programTextArtifactMap, programTextReference, validateProgramTextReference, loadProgramTextCapture } from "./program-text-artifacts.mjs";

const url = (id = ids[0], path = "download") => `https://drive.usercontent.google.com/${path}?id=${id}&export=download`;
const source = (id = ids[0], path = "uc") => ({ id: "11111111-1111-4111-8111-111111111111",
  shared_award_id: "22222222-2222-4222-8222-222222222222", url: url(id, path), title: "Public native PDF test", page_type: "pdf" });
const paragraph = "Applicants must submit the current form. The official deadline is March 26, 2027.";

// Offline native PDF fixture, with actual xref/page objects and no external URL.
function nativePdf(texts = [paragraph]) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids = texts.map((text, index) => {
    const page = 3 + index * 2, stream = text ? `BT /F1 12 Tf 50 720 Td (${text}) Tj ET` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + texts.length * 2} 0 R >> >> /Contents ${page + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    return `${page} 0 R`;
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${texts.length} >>`;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const fetched = (overrides = {}) => ({ status: 200, buffer: nativePdf(), finalUrl: url(), contentType: "application/octet-stream", ...overrides });
function fixture(overrides = {}) {
  return buildProgramTextCapture({ source: source(), final_url: url(), captured_at: "2026-10-26T23:00:00.000Z",
    acquisition: "pdf_text", extractor: { name: "pdf-parse", version }, raw_bytes: nativePdf(),
    content_type: "application/octet-stream", text: paragraph,
    blocks: [{ id: "page-1-block-1", page: 1, kind: "pdf_page", text: paragraph, start_utf16: 0, end_utf16: paragraph.length }], ...overrides });
}

describe("finite public Drive PDF URL identity", () => {
  it.each(ids)("accepts only literal two-key identities for %s", id => {
    for (const path of ["uc", "download"]) {
      expect(programTextPublicDrivePdfIdentity(url(id, path))).toEqual({ file_id: id, pathname: `/${path}` });
      expect(programTextPublicDrivePdfIdentity(`https://drive.usercontent.google.com/${path}?export=download&id=${id}`)).toEqual({ file_id: id, pathname: `/${path}` });
    }
    expect(isProgramTextPublicDrivePdfTransition(url(id, "uc"), url(id))).toBe(true);
    expect(isProgramTextPublicDrivePdfTransition(url(id), url(id))).toBe(true);
    expect(isProgramTextPublicDrivePdfTransition(url(id), url(id, "uc"))).toBe(false);
    expect(isProgramTextPublicDrivePdfTransition(url(id, "uc"), url(ids.find(other => other !== id)))).toBe(false);
  });
  it.each([
    null, 1, "", url("arbitrary-file-id"), url().replace("https:", "http:"), url().replace("usercontent", "evil"),
    url().replace("drive.usercontent.google.com", "drive.usercontent.google.com.evil.test"),
    url().replace("https://", "https://user:password@"), url().replace(".com/", ".com:443/"),
    url().replace("drive.", "DRIVE."), url().replace("/download?", "/Download?"),
    url().replace("/download?", "/uc/../download?"), url().replace("/download?", "//download?"),
    url() + "#fragment", url() + "&confirm=t", url() + "&authuser=0", url() + "&id=" + ids[0], url() + "&export=download",
    url() + "&", url() + ";", url().replace("id=", "ID="), url().replace("id=", "%69d="),
    url().replace("export=download", "export=%64ownload"), url().replace(ids[0], "%31" + ids[0].slice(1)),
    url().replace("export=download", "export=preview"), url() + "\n", " " + url(),
  ])("rejects normalized/encoded/arbitrary identity %#", value => {
    expect(programTextPublicDrivePdfIdentity(value)).toBeNull();
  });
});

function transportScenario(responses) {
  const calls = [], closes = [];
  return { calls, closes, adapters: { fetchHop: vi.fn(async (requested, init, options) => {
    calls.push({ requested, init, options });
    const entry = responses[calls.length - 1];
    if (entry instanceof Error) throw entry;
    const response = new Response(entry?.body ?? nativePdf(), { status: entry?.status ?? 200,
      headers: { "content-type": "application/octet-stream", ...entry?.headers } });
    return { response, url: new URL(requested), close: async () => closes.push(requested) };
  }) } };
}

describe("separate pinned anonymous public PDF transport", () => {
  it("follows exactly the observed same-file hop with no credentials/cookie propagation", async () => {
    const s = transportScenario([{ status: 302, headers: { location: url(), "set-cookie": "private=value" }, body: "" }, {}]);
    const result = await fetchProgramTextPublicDrivePdf(url(ids[0], "uc"), { adapters: s.adapters });
    expect(s.calls.map(call => call.requested)).toEqual([url(ids[0], "uc"), url()]);
    expect(s.closes).toEqual(s.calls.map(call => call.requested));
    expect(s.calls.every(call => call.init.method === "GET" && call.init.credentials === "omit" && call.init.signal instanceof AbortSignal)).toBe(true);
    expect(s.calls[1].init.headers).toEqual({ "user-agent": "AwardPing/1.0 (+https://awardping.com)", accept: "application/pdf" });
    expect(result).toMatchObject({ status: 200, finalUrl: url(), contentType: "application/octet-stream", redirectCount: 1,
      redirectChain: [{ url: url(ids[0], "uc"), status: 302, location: url() }, { url: url(), status: 200 }] });
    expect(result.buffer.equals(nativePdf())).toBe(true);
  });
  it("accepts a directly observed canonical download in one GET", async () => {
    const s = transportScenario([{}]);
    expect((await fetchProgramTextPublicDrivePdf(url(), { adapters: s.adapters })).finalUrl).toBe(url());
    expect(s.calls).toHaveLength(1);
  });
  it.each([url(ids[1]), "https://accounts.google.com/login", url() + "&confirm=t", url().replace("google.com", "google.com.evil.test"),
    "/download?id=" + ids[0] + "&export=download", url(ids[0], "uc"), url().replace("https:", "http:")])
  ("rejects redirect %# BEFORE making a second request", async location => {
    const s = transportScenario([{ status: 302, headers: { location } }, {}]);
    await expect(fetchProgramTextPublicDrivePdf(url(ids[0], "uc"), { adapters: s.adapters })).rejects.toMatchObject({ code: "program_text_public_drive_unapproved_redirect" });
    expect(s.calls).toHaveLength(1); expect(s.closes).toHaveLength(1);
  });
  it("rejects another redirect from the canonical download before a third GET", async () => {
    const s = transportScenario([{ status: 302, headers: { location: url() } }, { status: 302, headers: { location: url() } }, {}]);
    await expect(fetchProgramTextPublicDrivePdf(url(ids[0], "uc"), { adapters: s.adapters })).rejects.toThrow("unapproved_redirect");
    expect(s.calls).toHaveLength(2); expect(s.closes).toHaveLength(2);
  });
  it("rejects any redirect from a direct canonical download", async () => {
    const s = transportScenario([{ status: 302, headers: { location: url() } }, {}]);
    await expect(fetchProgramTextPublicDrivePdf(url(), { adapters: s.adapters })).rejects.toThrow("unapproved_redirect");
    expect(s.calls).toHaveLength(1);
  });
  it.each([
    { status: 401 }, { status: 403 }, { status: 206 }, { headers: { "cf-mitigated": "challenge" } },
    { headers: { "x-amzn-waf-action": "challenge" } }, { headers: { "content-type": "text/html" }, body: "<html>Sign in or confirm</html>" },
    { headers: { "content-length": "20971521" } }, { headers: { "content-length": "not-a-number" } },
  ])("holds nonpublic/challenged/invalid response %# without retry", async response => {
    const s = transportScenario([response]);
    await expect(fetchProgramTextPublicDrivePdf(url(), { adapters: s.adapters })).rejects.toThrow();
    expect(s.calls).toHaveLength(1); expect(s.closes).toHaveLength(1);
  });
  it("uses normal streamed byte and elapsed-time bounds", async () => {
    const s = transportScenario([{ body: Buffer.alloc(2000) }]);
    await expect(fetchProgramTextPublicDrivePdf(url(), { maxBytes: 1000, adapters: s.adapters })).rejects.toThrow();
    expect(s.calls).toHaveLength(1);
    for (const options of [{ timeoutMs: 0 }, { timeoutMs: 120001 }, { maxBytes: 20971521 }]) {
      const bounded = transportScenario([{}]);
      await expect(fetchProgramTextPublicDrivePdf(url(), { ...options, adapters: bounded.adapters })).rejects.toThrow("invalid_options");
      expect(bounded.calls).toHaveLength(0);
    }
  });
  it("holds a timed-out pinned response without a second request", async () => {
    const s = transportScenario([{}]), fetchHop = s.adapters.fetchHop;
    s.adapters.fetchHop = async (...args) => { await new Promise(resolve => setTimeout(resolve, 20)); return fetchHop(...args); };
    await expect(fetchProgramTextPublicDrivePdf(url(), { timeoutMs: 10, adapters: s.adapters })).rejects.toThrow("timeout");
    expect(s.calls).toHaveLength(1); expect(s.closes).toHaveLength(1);
  });
  it("does not retry a failed pinned hop or expose its raw error", async () => {
    const s = transportScenario([new Error("SECRET network details")]);
    await expect(fetchProgramTextPublicDrivePdf(url(), { adapters: s.adapters })).rejects.toThrow("fetch_failed");
    expect(s.calls).toHaveLength(1);
  });
});

describe("finite native PDF capture and retained contracts", () => {
  it.each(ids)("really parses all offline native pages for %s and preserves raw MIME/URLs", async id => {
    const bytes = nativePdf([paragraph, "Funding and student participation requirements are stated on this second page."]);
    const ordinaryFetch = vi.fn(), browser = vi.fn(), ocr = vi.fn();
    const capture = await captureProgramTextSource({ source: source(id), adapters: { fetch: ordinaryFetch,
      publicDrivePdfFetch: async () => fetched({ buffer: bytes, finalUrl: url(id) }), browserPdfFetch: browser, ocrExtraction: ocr } });
    expect(capture.source.url).toBe(url(id, "uc")); expect(capture.final_url).toBe(url(id));
    expect(capture.raw_source.content_type).toBe("application/octet-stream"); expect(capture.raw_source.bytes.equals(bytes)).toBe(true);
    expect(capture.extractor).toEqual({ name: "pdf-parse", version }); expect(capture.completeness.status).toBe("complete");
    expect(capture.text).toContain("second page"); expect(new Set(capture.blocks.map(block => block.page))).toEqual(new Set([1, 2]));
    expect(ordinaryFetch).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled(); expect(ocr).not.toHaveBeenCalled();
    expect(validateProgramTextReference(programTextReference(capture)).artifacts.raw.content_type).toBe("application/octet-stream");
  }, 20_000);
  it("requires actual native parsing, not merely a PDF header and EOF", async () => {
    await expect(captureProgramTextSource({ source: source(), adapters: { publicDrivePdfFetch: async () => fetched({ buffer: Buffer.from("%PDF-1.4\nnot a real PDF\n%%EOF\n") }) } }))
      .rejects.toThrow("extractor_failed");
  }, 20_000);
  it("retains a sparse native page as incomplete and cannot establish a complete reference", async () => {
    const capture = await captureProgramTextSource({ source: source(), adapters: { publicDrivePdfFetch: async () => fetched({ buffer: nativePdf([paragraph, "X"]) }) } });
    expect(capture.completeness.status).toBe("incomplete");
    expect(capture.completeness.reasons).toContain("page_2_sparse_text");
    expect(() => validateProgramTextReference(programTextReference(capture))).toThrow("invalid_reference");
  }, 20_000);
  it("preserves an empty first native page as an explicit incomplete observation", async () => {
    const capture = await captureProgramTextSource({ source: source(), adapters: { publicDrivePdfFetch: async () => fetched({ buffer: nativePdf(["", paragraph]) }) } });
    expect(capture.completeness.status).toBe("incomplete");
    expect(capture.completeness.reasons).toContain("page_1_sparse_text");
    expect(capture.text).toContain("Applicants must submit");
    expect(() => validateProgramTextReference(programTextReference(capture))).toThrow("invalid_reference");
  }, 20_000);
  it("rejects a native result that omits one of its declared pages", async () => {
    await expect(captureProgramTextSource({ source: source(), adapters: { publicDrivePdfFetch: async () => fetched(),
      pdfExtraction: async () => ({ total: 2, pages: [{ num: 1, text: paragraph }] }) } })).rejects.toThrow("pdf_page_coverage_invalid");
  });
  it.each([Buffer.from("<html>Confirm download</html>"), Buffer.concat([Buffer.from("prefix"), nativePdf()]),
    Buffer.from(nativePdf().toString().replace("%%EOF", "")), Buffer.concat([nativePdf(), Buffer.from("unexpected trailing content")])])
  ("rejects missing magic/terminal EOF before extraction %#", async bytes => {
    const parse = vi.fn();
    await expect(captureProgramTextSource({ source: source(), adapters: { publicDrivePdfFetch: async () => fetched({ buffer: bytes }), pdfExtraction: parse } })).rejects.toThrow("invalid_pdf");
    expect(parse).not.toHaveBeenCalled();
  });
  it("rejects a mislabelled HTML/challenge body before extraction", async () => {
    const parse = vi.fn();
    await expect(captureProgramTextSource({ source: source(), adapters: { publicDrivePdfFetch: async () => fetched({ contentType: "text/html" }), pdfExtraction: parse } })).rejects.toThrow("invalid_pdf");
    expect(parse).not.toHaveBeenCalled();
  });
  it.each([
    { acquisition: "pdf_ocr" }, { acquisition: "rendered_html" }, { acquisition: "http_html" }, { pdf_transport: "browser" },
    { source: { ...source(), page_type: "application" } }, { allowedFinalUrls: ["https://example.org/approved.pdf"] },
  ])("holds incompatible acquisition %# before a request", async overrides => {
    const fetch = vi.fn(), renderedHtml = vi.fn(), browserPdfFetch = vi.fn(), publicDrivePdfFetch = vi.fn();
    await expect(captureProgramTextSource({ source: source(), ...overrides, adapters: { fetch, renderedHtml, browserPdfFetch, publicDrivePdfFetch } })).rejects.toThrow();
    for (const method of [fetch, renderedHtml, browserPdfFetch, publicDrivePdfFetch]) expect(method).not.toHaveBeenCalled();
  });
  it("does not broaden ordinary PDF MIME handling", async () => {
    const parse = vi.fn();
    await expect(captureProgramTextSource({ source: { ...source(), url: "https://example.org/rules.pdf" },
      adapters: { fetch: async () => fetched({ finalUrl: "https://example.org/rules.pdf" }), pdfExtraction: parse } })).rejects.toThrow("invalid_pdf");
    expect(parse).not.toHaveBeenCalled();
  });
  it.each([
    { source: { ...source(), url: url("not-one-of-the-three") } }, { source: { ...source(), page_type: "program" } },
    { acquisition: "pdf_ocr" }, { acquisition: "http_html" }, { final_url: url(ids[1]) }, { final_url: url(ids[0], "uc") },
    { extractor: { name: "fixture", version } }, { content_type: "image/png" },
  ])("a forged tag cannot bypass capture provenance %#", overrides => {
    expect(() => fixture(overrides)).toThrow();
  });
  it.each([
    ref => { ref.source.url = url("not-one-of-the-three"); }, ref => { ref.source.page_type = "program"; },
    ref => { ref.acquisition = "pdf_ocr"; }, ref => { ref.final_url = url(ids[1]); },
    ref => { ref.final_url = url(ids[0], "uc"); }, ref => { ref.extractor.name = "fixture"; },
    ref => { ref.extractor.version = "unverified"; }, ref => { ref.artifacts.raw.content_type = "text/html"; },
  ])("a forged tag cannot bypass reference provenance %#", mutate => {
    const ref = structuredClone(programTextReference(fixture())); mutate(ref);
    expect(() => validateProgramTextReference(ref)).toThrow();
  });
  it("strictly validates tagged page metadata without weakening incomplete retention", () => {
    expect(() => fixture({ blocks: [{ id: "block", text: paragraph, start_utf16: 0, end_utf16: paragraph.length }] })).toThrow("invalid_public_drive_pdf_pages");
    expect(() => fixture({ blocks: [{ id: "block", text: paragraph, start_utf16: 0, end_utf16: paragraph.length, page: 2, kind: "pdf_page" }] })).toThrow("invalid_public_drive_pdf_pages");
    const c = fixture(); c.raw_source.bytes[0] = 65;
    expect(() => validateProgramTextCapture(c)).toThrow();
    expect(hasProgramTextPublicDrivePdfEnvelope(nativePdf())).toBe(true);
  });
  it("cold-restores exact immutable raw/text/metadata with actual MIME and final URL", async () => {
    const capture = fixture(), ref = validateProgramTextReference(programTextReference(capture));
    const objects = new Map(programTextArtifactMap(capture).map(item => [item.binding.object_key, item.body]));
    const client = { async send(command) { const body = objects.get(command.input.Key); return { Body: Readable.from([body]), ContentLength: body.length }; } };
    const restored = await loadProgramTextCapture(ref, { client, bucket: "offline-fixture" });
    expect(restored.raw_source.bytes.equals(capture.raw_source.bytes)).toBe(true);
    expect(restored.raw_source.content_type).toBe("application/octet-stream");
    expect(restored.source.url).toBe(url(ids[0], "uc")); expect(restored.final_url).toBe(url());
    expect(isProgramTextPublicDrivePdfMetadata(ref)).toBe(true); expect(programTextReference(restored)).toEqual(ref);
    objects.get(ref.artifacts.raw.object_key)[0] ^= 1;
    await expect(loadProgramTextCapture(ref, { client, bucket: "offline-fixture" })).rejects.toThrow("remote_artifact_hash");
  });
});
