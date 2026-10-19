import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { compareScraplingCaptures, scraplingEvidenceProfile, validateScraplingCapture } from "./scrapling-capture.mjs";

const source = { id: "award-source", url: "https://example.edu/award" };
const firstTime = "2026-10-15T12:00:00.000Z";
const secondTime = "2026-10-15T12:10:00.000Z";
const heading = { level: 1, text: "Example Award" };
const fullText = "Example Award Apply by October 31, 2026. U.S. applicants only. Application";
const hash = (value) => createHash("sha256").update(value).digest("hex");
let jpeg;
beforeAll(async () => { jpeg = await sharp({ create: { width: 1280, height: 900, channels: 3, background: "white" } }).jpeg().toBuffer(); });

function fixture(capturedAt = firstTime) {
  return {
    schema: "awardping.scrapling-capture.v1",
    capture_profile: "scrapling-visible-v1",
    source_id: source.id,
    url: source.url,
    final_url: source.url,
    captured_at: capturedAt,
    status_code: 200,
    content_type: "text/html; charset=utf-8",
    html: "<!doctype html><html><body><h1>Example Award</h1><p>Apply by October 31, 2026.</p><p>U.S. applicants only.</p><a href='/apply.pdf?year=2026'>Application</a></body></html>",
    text: fullText,
    visible_html: `<ap-document>${fullText}</ap-document>`,
    document: {
      schema: "awardping.scrapling-document.v1",
      scope: "whole-visible-main-document",
      title: "Example Award",
      text: fullText,
      blocks: [
        { kind: "heading", text: "Example Award", heading_path: [heading], list_path: [], table_row: [] },
        { kind: "paragraph", text: "Apply by October 31, 2026.", heading_path: [heading], list_path: [], table_row: [] },
        { kind: "paragraph", text: "U.S. applicants only.", heading_path: [heading], list_path: [], table_row: [] },
      ],
      links: [{ text: "Application", url: "https://example.edu/apply.pdf?year=2026", heading_path: [heading], list_path: [] }],
      limitations: ["main_document_only", "no_screenshot_localization"],
      counts: { blocks: 3, links: 1 },
    },
    readiness: { ready_state: "complete", fonts_status: "loaded", stable: true, samples: 3, stable_ms: 1000 },
    warnings: [],
    engine: { scrapling: "0.4.15" },
  };
}

function pair() {
  return [fixture(firstTime), fixture(secondTime)];
}

function evidenceFixture(capturedAt = firstTime) {
  const record = fixture(capturedAt);
  record.capture_profile = scraplingEvidenceProfile;
  record.html_document = {
    schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document", source_url: record.final_url,
    publishable: false, visibility_verified: false, title: record.document.title, text: record.text,
    blocks: structuredClone(record.document.blocks), base_hrefs: [], limitations: ["HTML source is not verified visible content."],
    links: [{ text: "Application", raw_href: "/apply.pdf?year=2026", source_url: record.final_url,
      base_hrefs: [], heading_path: [heading], list_path: [] }],
  };
  record.screenshot = {
    schema: "awardping.scrapling-screenshot.v1", mime_type: "image/jpeg", source_url: record.final_url,
    base64: jpeg.toString("base64"), sha256: hash(jpeg), byte_length: jpeg.length, width: 1280, height: 900,
    captured_at: capturedAt, full_page: true, geometry_status: "unavailable", alignment: "not_verified", semantics_bracketed: true,
    limitations: ["No screenshot localization; hidden HTML is not asserted to appear in this screenshot."],
  };
  record.html_links = [{ url: "https://example.edu/apply.pdf?year=2026", raw_href: "/apply.pdf?year=2026", href_attribute: "href",
    base_url: record.final_url, text: "Application", title: "", aria_label: "", download: "", download_present: false,
    context: "", context_available: false, context_truncated: false }];
  return record;
}

describe("opt-in Scrapling evidence profile", () => {
  it("seals neutral sibling-button paths without inferring headings or visibility", () => {
    const record = evidenceFixture(), old = validateScraplingCapture(structuredClone(record), { source });
    record.html_document.blocks[1].sibling_button_path = ["Applicants", "Applicants"];
    record.html_document.links[0].sibling_button_path = ["Applicants"];
    const retained = validateScraplingCapture(record, { source });
    expect(retained.html_document.blocks[1].sibling_button_path).toEqual(["Applicants", "Applicants"]);
    expect(retained.html_document.blocks[1].heading_path).toEqual([heading]);
    expect(retained.html_document.visibility_verified).toBe(false);
    expect(retained.integrity.html_document_sha256).not.toBe(old.integrity.html_document_sha256);
  });
  it.each([null, "Label", [], [null], [3], [""], ["  "], Array(101).fill("Label"), ["x".repeat(10001)]])("rejects malformed sibling-button path %j", path => {
    for (const field of ["blocks", "links"]) {
      const record = evidenceFixture(); record.html_document[field][0].sibling_button_path = path;
      expect(() => validateScraplingCapture(record, { source })).toThrow(field === "blocks" ? "invalid_html_block" : "invalid_html_link");
    }
  });

  it("seals optional FAQ ancestry without dropping it from retained evidence", () => {
    const record = evidenceFixture();
    const original = validateScraplingCapture(structuredClone(record), { source });
    record.html_document.blocks[1].details_path = ["U.S. applicants", ""];
    record.html_document.links[0].details_path = ["U.S. applicants"];
    const retained = validateScraplingCapture(record, { source });
    expect(retained.html_document.blocks[1].details_path).toEqual(["U.S. applicants", ""]);
    expect(retained.html_document.links[0].details_path).toEqual(["U.S. applicants"]);
    expect(retained.integrity.html_document_sha256).not.toBe(original.integrity.html_document_sha256);
  });

  it.each([null, "Question", [], [null], [4], Array(101).fill("Question")])("rejects malformed retained FAQ context %j", path => {
    for (const field of ["blocks", "links"]) {
      const record = evidenceFixture();
      record.html_document[field][0].details_path = path;
      expect(() => validateScraplingCapture(record, { source })).toThrow(field === "blocks" ? "invalid_html_block" : "invalid_html_link");
    }
  });

  const discloseMismatch = record => {
    record.screenshot.semantics_bracketed = false;
    record.screenshot.primary_html_captured_at = record.captured_at;
    record.screenshot.semantic_mismatches = [{ field: "visible.text", before_sha256: "a".repeat(64), after_sha256: "b".repeat(64), before_bytes: 100, after_bytes: 101 }];
    record.warnings.push("supplementary_screenshot_semantics_changed_not_aligned");
    record.screenshot.limitations.push("Supplementary screenshot content differs from the primary snapshot.");
    return record;
  };

  it("accepts a clearly disclosed supplementary screenshot mismatch without changing primary evidence", () => {
    const record = discloseMismatch(evidenceFixture());
    const primary = record.html_document;
    const result = validateScraplingCapture(record, { source });
    expect(result.html_document).toEqual(primary);
    expect(result.screenshot).toMatchObject({ semantics_bracketed: false, alignment: "not_verified", geometry_status: "unavailable" });
    expect(result.publishable).toBe(false);
  });

  it.each([
    ["missing warning", r => { r.warnings = []; }],
    ["empty mismatch details", r => { r.screenshot.semantic_mismatches = []; }],
    ["equal mismatch hashes", r => { r.screenshot.semantic_mismatches[0].after_sha256 = "a".repeat(64); }],
    ["invalid mismatch field", r => { r.screenshot.semantic_mismatches[0].field = "guessed_pixels"; }],
    ["false matched claim", r => { r.screenshot.semantics_bracketed = true; }],
    ["primary timestamp mismatch", r => { r.screenshot.primary_html_captured_at = secondTime; }],
  ])("rejects %s on supplementary screenshots", (_, change) => {
    const record = discloseMismatch(evidenceFixture());
    change(record);
    expect(() => validateScraplingCapture(record, { source })).toThrow();
  });

  it("accepts the new explicit matching contract and old strictly bracketed captures", () => {
    const record = evidenceFixture();
    expect(() => validateScraplingCapture(record, { source })).not.toThrow();
    record.screenshot.semantic_mismatches = [];
    record.screenshot.primary_html_captured_at = record.captured_at;
    expect(() => validateScraplingCapture(record, { source })).not.toThrow();
  });

  it("seals separate HTML source text and an honest bounded screenshot without granting publication", () => {
    const result = validateScraplingCapture(evidenceFixture(), { source });
    expect(result.publishable).toBe(false);
    expect(result.screenshot.geometry_status).toBe("unavailable");
    expect(result.integrity).toMatchObject({ screenshot_sha256: hash(jpeg), html_document_sha256: hash(JSON.stringify(result.html_document)) });
  });

  it.each([
    ["missing screenshot", (r) => { delete r.screenshot; }],
    ["missing HTML source document", (r) => { delete r.html_document; }],
    ["missing HTML discovery links", (r) => { delete r.html_links; }],
    ["mismatched native URL", (r) => { r.html_links[0].url = "https://example.edu/other.pdf"; }],
    ["unbounded discovery field", (r) => { r.html_links[0].title = "x".repeat(10001); }],
    ["unbounded discovery context", (r) => { r.html_links[0].context = "x".repeat(801); }],
    ["invalid context claim", (r) => { r.html_links[0].context_truncated = true; }],
    ["source mismatch", (r) => { r.html_document.source_url = "https://example.edu/other"; }],
    ["false HTML visibility", (r) => { r.html_document.visibility_verified = true; }],
    ["false publication", (r) => { r.html_document.publishable = true; }],
    ["invalid HTML block", (r) => { r.html_document.blocks[0].list_path = null; }],
    ["invalid HTML link", (r) => { r.html_document.links[0].raw_href = null; }],
    ["image source mismatch", (r) => { r.screenshot.source_url = "https://example.edu/other"; }],
    ["image hash mismatch", (r) => { r.screenshot.sha256 = "0".repeat(64); }],
    ["image byte mismatch", (r) => { r.screenshot.byte_length++; }],
    ["image dimensions mismatch", (r) => { r.screenshot.width++; }],
    ["oversized dimensions", (r) => { r.screenshot.height = 20001; }],
    ["oversized pixel count", (r) => { r.screenshot.width = 4096; r.screenshot.height = 20000; }],
    ["oversized image", (r) => { r.screenshot.byte_length = 4 * 1024 * 1024 + 1; }],
    ["noncanonical base64", (r) => { r.screenshot.base64 += "\n"; }],
    ["fabricated alignment", (r) => { r.screenshot.alignment = "verified"; }],
    ["fabricated geometry", (r) => { r.screenshot.geometry_status = "available"; }],
    ["unbracketed screenshot", (r) => { r.screenshot.semantics_bracketed = false; }],
    ["old screenshot", (r) => { r.screenshot.captured_at = "2020-01-01T00:00:00.000Z"; }],
    ["non-full screenshot", (r) => { r.screenshot.full_page = false; }],
    ["downgraded profile", (r) => { r.capture_profile = "scrapling-visible-v1"; }],
  ])("rejects %s", (_, mutate) => {
    const record = evidenceFixture();
    mutate(record);
    expect(() => validateScraplingCapture(record, { source })).toThrow();
  });

  it.each(["html_document", "screenshot"])("detects changes to sealed %s", (key) => {
    const record = validateScraplingCapture(evidenceFixture(), { source });
    record[key].limitations.push("changed after sealing");
    expect(() => validateScraplingCapture(record, { source })).toThrow("capture_integrity_mismatch");
  });

  it("seals full-HTML discovery links independently of visible links", () => {
    const record = validateScraplingCapture(evidenceFixture(), { source });
    expect(record.integrity.html_links_sha256).toBe(hash(JSON.stringify(record.html_links)));
    record.html_links[0].title = "Changed document label";
    expect(() => validateScraplingCapture(record, { source })).toThrow("capture_integrity_mismatch");
  });

  it("rejects an invalid JPEG even when its bytes and hash agree", () => {
    const record = evidenceFixture();
    const bytes = Buffer.from("not an image");
    Object.assign(record.screenshot, { base64: bytes.toString("base64"), sha256: hash(bytes), byte_length: bytes.length });
    expect(() => validateScraplingCapture(record, { source })).toThrow("invalid_screenshot");
  });

  it("holds comparisons across profiles instead of treating migration as a change", () => {
    expect(compare(fixture(firstTime), evidenceFixture(secondTime))).toMatchObject({ status: "unavailable", reason: "capture_profile_mismatch" });
  });

  it("keeps its existing comparator explicitly visible-only even when full HTML is retained", () => {
    const a = evidenceFixture(firstTime);
    const b = evidenceFixture(secondTime);
    b.html_document.text += " Hidden source requirement changed.";
    expect(compare(a, b)).toMatchObject({ status: "unchanged", scope: "observed_visible_main_document", publishable: false });
  });
});

function replaceText(record, before, after) {
  record.html = record.html.replaceAll(before, after);
  record.text = record.text.replaceAll(before, after);
  record.document.text = record.document.text.replaceAll(before, after);
  for (const block of record.document.blocks) block.text = block.text.replaceAll(before, after);
}

function expectHeld(result) {
  expect(result).toMatchObject({ status: "unavailable", publishable: false });
  expect(typeof result.reason).toBe("string");
  expect(result.reason.length).toBeGreaterThan(0);
}

function compare(previous, current) {
  const seal = (record) => {
    try {
      return validateScraplingCapture(record, { source: { id: record?.source_id, url: record?.url } });
    } catch {
      // Invalid collector output has no seal and must remain unavailable.
      return record;
    }
  };
  return compareScraplingCaptures(seal(previous), seal(current));
}

describe("Scrapling capture validation", () => {
  it("requires retained visible projection and rejects a changed projection seal", () => {
    const missing = fixture();
    delete missing.visible_html;
    expect(() => validateScraplingCapture(missing, { source })).toThrow();
    const sealed = validateScraplingCapture(fixture(), { source });
    sealed.visible_html += "tampered";
    expect(() => validateScraplingCapture(sealed, { source })).toThrow();
  });
  it("accepts a complete source-bound visible document without altering the caller's evidence", () => {
    const record = fixture();
    const original = structuredClone(record);
    expect(() => validateScraplingCapture(record, { source })).not.toThrow();
    expect(record).toEqual(original);
  });

  it.each([
    ["missing record", () => null],
    ["legacy schema", (record) => ({ ...record, schema: "legacy" })],
    ["unknown capture profile", (record) => ({ ...record, capture_profile: "other" })],
    ["wrong source identity", (record) => ({ ...record, source_id: "another-source" })],
    ["wrong requested URL", (record) => ({ ...record, url: "https://example.edu/other" })],
    ["private final URL", (record) => ({ ...record, final_url: "http://127.0.0.1/" })],
    ["credentialed final URL", (record) => ({ ...record, final_url: "https://user:password@example.edu/award" })],
    ["non-default final port", (record) => ({ ...record, final_url: "https://example.edu:8443/award" })],
    ["invalid timestamp", (record) => ({ ...record, captured_at: "not-a-date" })],
    ["failed status", (record) => ({ ...record, status_code: 403 })],
    ["redirect instead of final response", (record) => ({ ...record, status_code: 302 })],
    ["PDF response", (record) => ({ ...record, content_type: "application/pdf" })],
    ["missing HTML", (record) => ({ ...record, html: "" })],
    ["missing visible text", (record) => ({ ...record, text: "" })],
    ["too little visible text", (record) => ({ ...record, text: "Error", document: { ...record.document, text: "Error" } })],
    ["missing structured document", (record) => ({ ...record, document: null })],
    ["incorrect document schema", (record) => ({ ...record, document: { ...record.document, schema: "legacy" } })],
    ["incomplete document scope", (record) => ({ ...record, document: { ...record.document, scope: "selected-fragment" } })],
    ["mismatched retained text", (record) => ({ ...record, document: { ...record.document, text: `${record.text} Omitted condition.` } })],
    ["missing blocks", (record) => ({ ...record, document: { ...record.document, blocks: null } })],
    ["empty blocks", (record) => ({ ...record, document: { ...record.document, blocks: [] } })],
    ["invalid block item", (record) => ({ ...record, document: { ...record.document, blocks: [null] } })],
    ["missing links", (record) => ({ ...record, document: { ...record.document, links: null } })],
    ["missing readiness", (record) => ({ ...record, readiness: null })],
    ["unstable content", (record) => ({ ...record, readiness: { ...record.readiness, stable: false } })],
    ["interactive document", (record) => ({ ...record, readiness: { ...record.readiness, ready_state: "interactive" } })],
    ["unloaded fonts", (record) => ({ ...record, readiness: { ...record.readiness, fonts_status: "loading" } })],
    ["missing stability duration", (record) => ({ ...record, readiness: { ...record.readiness, stable_ms: undefined } })],
    ["non-finite stability duration", (record) => ({ ...record, readiness: { ...record.readiness, stable_ms: Infinity } })],
  ])("rejects %s", (_label, mutate) => {
    expect(() => validateScraplingCapture(mutate(fixture()), { source })).toThrow();
  });

  it.each([
    ["empty block wording", (record) => { record.document.blocks[1].text = "  "; }],
    ["missing block kind", (record) => { delete record.document.blocks[1].kind; }],
    ["invalid heading level", (record) => { record.document.blocks[1].heading_path = [{ level: 7, text: "Eligibility" }]; }],
    ["missing list qualifiers", (record) => { delete record.document.blocks[1].list_path; }],
    ["non-text table qualifiers", (record) => { record.document.blocks[1].table_row = [22]; }],
    ["missing link destination", (record) => { record.document.links[0].url = ""; }],
    ["malformed link heading context", (record) => { record.document.links[0].heading_path = [null]; }],
    ["unknown engine version", (record) => { record.engine.scrapling = "0.0.0"; }],
    ["non-text warning", (record) => { record.warnings = [{ message: "hidden failure" }]; }],
    ["non-text limitation", (record) => { record.document.limitations = [false]; }],
    ["too few stability samples", (record) => { record.readiness.samples = 2; }],
    ["too short stability duration", (record) => { record.readiness.stable_ms = 999; }],
  ])("rejects %s instead of retaining incomplete evidence", (_label, mutate) => {
    const record = fixture();
    mutate(record);
    expect(() => validateScraplingCapture(record, { source })).toThrow();
  });

  it("bounds UTF-8 HTML bytes, not just JavaScript string length", () => {
    const record = fixture();
    record.html = `<html><body>${"界".repeat(2 * 1024 * 1024)}</body></html>`;
    expect(record.html.length).toBeLessThan(5 * 1024 * 1024);
    expect(Buffer.byteLength(record.html, "utf8")).toBeGreaterThan(5 * 1024 * 1024);
    expect(() => validateScraplingCapture(record, { source })).toThrow();
  });

  it("preserves Unicode, full deadline precision and applicant conditions", () => {
    const record = fixture();
    replaceText(record, "Apply by October 31, 2026.", "Beca académica: apply October 31, 2026 at 5:00 p.m. Central Time.");
    expect(() => validateScraplingCapture(record, { source })).not.toThrow();
    expect(record.document.blocks[1].text).toContain("5:00 p.m. Central Time");
    expect(record.document.blocks[2].text).toBe("U.S. applicants only.");
  });
});

describe("Scrapling evidence comparison", () => {
  it("recognizes equal visible and semantic evidence as unchanged, without authorizing publication", () => {
    expect(compare(...pair())).toMatchObject({ status: "unchanged", publishable: false });
  });

  it("does not confuse changed raw markup with changed visible award information", () => {
    const [previous, current] = pair();
    current.html = current.html.replace("<body>", "<body class='new-theme'><script>window.build=27;</script><p hidden>Apply yesterday</p>");
    expect(compare(previous, current)).toMatchObject({ status: "unchanged", publishable: false });
  });

  it.each([
    ["deadline date", "October 31, 2026", "November 15, 2026"],
    ["deadline year", "October 31, 2026", "October 31, 2027"],
    ["applicant qualification", "U.S. applicants only.", "International applicants only."],
    ["negated eligibility", "U.S. applicants only.", "U.S. applicants are not eligible."],
    ["deadline time", "October 31, 2026.", "October 31, 2026 at 5:00 p.m. Central Time."],
  ])("holds verified %s changes for review", (_label, before, after) => {
    const [previous, current] = pair();
    replaceText(current, before, after);
    expect(compare(previous, current)).toMatchObject({ status: "changed_needs_review", publishable: false });
  });

  it("detects changed visible text even when it is outside the extracted semantic blocks", () => {
    const [previous, current] = pair();
    current.text += " Applications have been paused for 2027.";
    current.document.text = current.text;
    current.html = current.html.replace("</body>", "<div>Applications have been paused for 2027.</div></body>");
    expect(compare(previous, current)).toMatchObject({ status: "changed_needs_review", publishable: false });
  });

  it("detects an application destination change with identical visible link text", () => {
    const [previous, current] = pair();
    current.document.links[0].url = "https://example.edu/apply.pdf?year=2027";
    current.html = current.html.replace("year=2026", "year=2027");
    expect(compare(previous, current)).toMatchObject({ status: "changed_needs_review", publishable: false });
  });

  it("detects meaning changed solely by a nested-list qualification", () => {
    const [previous, current] = pair();
    previous.document.blocks[1].list_path = ["U.S. applicants"];
    current.document.blocks[1].list_path = ["International applicants"];
    expect(compare(previous, current)).toMatchObject({ status: "changed_needs_review", publishable: false });
  });

  it("detects meaning changed solely by a heading association", () => {
    const [previous, current] = pair();
    current.document.blocks[1].heading_path = [heading, { level: 2, text: "Campus deadline" }];
    expect(compare(previous, current)).toMatchObject({ status: "changed_needs_review", publishable: false });
  });

  it("detects a table-row qualification change even with the same deadline value", () => {
    const [previous, current] = pair();
    previous.document.blocks[1].table_row = ["U.S. applicants", "October 31, 2026"];
    current.document.blocks[1].table_row = ["International applicants", "October 31, 2026"];
    expect(compare(previous, current)).toMatchObject({ status: "changed_needs_review", publishable: false });
  });

  it("detects changed table-cell associations with identical visible words", () => {
    const [previous, current] = pair();
    previous.document.blocks[1].table_cell = { colspan: 1, rowspan: 1, scope: "row", headers: "us", id: "deadline" };
    current.document.blocks[1].table_cell = { colspan: 2, rowspan: 1, scope: "row", headers: "international", id: "deadline" };
    expect(compare(previous, current)).toMatchObject({ status: "changed_needs_review", publishable: false });
  });

  it("does not deduplicate away a visible requirement occurrence", () => {
    const [previous, current] = pair();
    current.document.blocks.push(structuredClone(current.document.blocks[2]));
    current.document.counts.blocks += 1;
    expect(compare(previous, current)).toMatchObject({ status: "changed_needs_review", publishable: false });
  });

  it("does not deduplicate away a visible link occurrence", () => {
    const [previous, current] = pair();
    current.document.links.push(structuredClone(current.document.links[0]));
    current.document.counts.links += 1;
    expect(compare(previous, current)).toMatchObject({ status: "changed_needs_review", publishable: false });
  });

  it("does not reorder distinct requirement blocks before comparison", () => {
    const [previous, current] = pair();
    current.document.blocks.reverse();
    expect(compare(previous, current)).toMatchObject({ status: "changed_needs_review", publishable: false });
  });

  it.each([
    ["missing previous capture", (_previous, current) => [null, current]],
    ["missing current capture", (previous) => [previous, null]],
    ["same timestamp", (previous, current) => [previous, { ...current, captured_at: previous.captured_at }]],
    ["backward timestamp", (previous, current) => [{ ...previous, captured_at: current.captured_at }, { ...current, captured_at: previous.captured_at }]],
    ["different source", (previous, current) => [previous, { ...current, source_id: "other-source" }]],
    ["different requested URL", (previous, current) => [previous, { ...current, url: "https://example.edu/other" }]],
    ["different final page", (previous, current) => [previous, { ...current, final_url: "https://example.edu/unrelated" }]],
    ["different capture profile", (previous, current) => [previous, { ...current, capture_profile: "future-profile" }]],
    ["failed current response", (previous, current) => [previous, { ...current, status_code: 503 }]],
    ["unstable current capture", (previous, current) => [previous, { ...current, readiness: { ...current.readiness, stable: false } }]],
    ["missing current text", (previous, current) => [previous, { ...current, text: "" }]],
    ["corrupt structured document", (previous, current) => [previous, { ...current, document: {} }]],
  ])("does not report %s as unchanged or deleted", (_label, mutate) => {
    expectHeld(compare(...mutate(...pair())));
  });

  it.each(["html", "text", "document"])("rejects tampered sealed %s evidence", (field) => {
    const previous = validateScraplingCapture(fixture(firstTime), { source });
    const current = validateScraplingCapture(fixture(secondTime), { source });
    if (field === "document") current.document.title = "Wrong award";
    else current[field] += " changed after sealing";
    expectHeld(compareScraplingCaptures(previous, current));
  });

  it("requires evidence integrity rather than comparing arbitrary collector JSON", () => {
    expectHeld(compareScraplingCaptures(...pair()));
  });
});
