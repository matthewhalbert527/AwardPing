import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareRetainedHtmlCaptures, compareStructuredHtmlDocuments, loadRetainedHtmlCaptureRecord } from "./rendered-html-comparison.mjs";
import { MAX_STRUCTURED_HTML_BYTES } from "./structured-html-content.mjs";

const directories = [];
const sourceId = "award-source";
const sourceUrl = "https://example.edu/award";
const beforeTime = "2026-09-24T12:00:00.000Z";
const afterTime = "2026-09-25T12:00:00.000Z";
const defaultHtml = "<!doctype html><html><body><main><h1>Award</h1><p>Apply by October 1, 2026.</p></main></body></html>";
const defaultText = "Award\nApply by October 1, 2026.";
const hash = (value) => createHash("sha256").update(value).digest("hex");

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "awardping-html-comparison-"));
  directories.push(directory);
  const archiveRoot = join(directory, "archive");
  mkdirSync(archiveRoot);
  let index = 0;
  function capture({ html = defaultHtml, text = defaultText, capturedAt = index ? afterTime : beforeTime, url = sourceUrl, metadata = {} } = {}) {
    const dir = join(archiveRoot, `capture-${index++}`);
    mkdirSync(dir);
    const htmlPath = join(dir, "page.html.txt");
    const textPath = join(dir, "text.txt");
    const metaPath = join(dir, "meta.json");
    const archiveRelative = (path) => relative(archiveRoot, path).replaceAll("\\", "/");
    const meta = {
      kind: "webpage", source: { id: sourceId }, captured_at: capturedAt, final_url: url,
      status_code: 200, page_settle: { stable: true, timed_out: false }, page_readiness: { timed_out: false },
      capture_profile: "stable-daily", capture_behavior_version: 3, section_extraction_profile: "stable-daily",
      text_hash: hash(text), text_length: text.length,
      html_capture: {
        schema: "awardping.rendered-html.v1", status: "captured", reason: null,
        representation: "rendered_dom", captured_at: capturedAt, source_url: url,
        max_bytes: MAX_STRUCTURED_HTML_BYTES, sha256: hash(html), byte_length: Buffer.byteLength(html),
        screenshot_alignment: "not_verified",
      },
      files: { html: archiveRelative(htmlPath), text: archiveRelative(textPath) },
      ...metadata,
    };
    writeFileSync(htmlPath, html, "utf8");
    writeFileSync(textPath, `${text}\n`, "utf8");
    writeFileSync(metaPath, JSON.stringify(meta), "utf8");
    return { ...meta, dir, html_path: htmlPath, text_path: textPath, meta_path: metaPath };
  }
  function compare(previous, current, options = {}) {
    return compareRetainedHtmlCaptures({ previous, current, sourceId, archiveRoot, ...options });
  }
  return { directory, archiveRoot, capture, compare };
}

function rewriteMetadata(capture, mutate, { mirror = true } = {}) {
  const metadata = JSON.parse(readFileSync(capture.meta_path, "utf8"));
  mutate(metadata);
  writeFileSync(capture.meta_path, JSON.stringify(metadata));
  if (mirror) Object.assign(capture, metadata);
}

function expectUnavailable(result, reason) {
  expect(result).toMatchObject({ status: "unavailable", reason, mode: "shadow", publishable: false, changes: null });
  expect(result.screenshot_alignment).toBe("not_verified");
}

describe("retained HTML comparison", () => {
  it("reports first observation without manufacturing added content", () => {
    const f = fixture();
    expect(f.compare(null, f.capture())).toMatchObject({ status: "first_observation", reason: "no_previous_capture", changes: null, publishable: false });
  });

  it("binds replay comparisons to the exact metadata bytes included in the receipt", () => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture();
    const retained = loadRetainedHtmlCaptureRecord({ metadataPath: current.meta_path, archiveRoot: f.archiveRoot });
    rewriteMetadata(current, (metadata) => { metadata.unrelated_note = "changed after record load"; });
    expectUnavailable(f.compare(previous, retained.capture), "current_metadata_changed_during_replay");
  });

  it("compares independently retained UTF-8 captures and exposes exact evidence hashes", () => {
    const f = fixture();
    const html = "<main><h1>Beca académica</h1><p>Apply by October 1, 2026.</p></main>";
    const text = "Beca académica\nApply by October 1, 2026.";
    const previous = f.capture({ html, text });
    const current = f.capture({ html, text });
    expect(Buffer.byteLength(html)).toBeGreaterThan(html.length);
    const result = f.compare(previous, current);
    expect(result).toMatchObject({ status: "unchanged", reason: null, visible_text_corroborated: true, publishable: false, visibility: "not_verified" });
    expect(result.previous).toMatchObject({ captured_at: beforeTime, html_sha256: hash(html), scope: "main" });
    expect(result.current).toMatchObject({ captured_at: afterTime, html_sha256: hash(html), scope: "main" });
    expect(result.changes).toMatchObject({ text_changed: false, links_changed: false, added_blocks: 0, removed_blocks: 0 });
  });

  it.each([
    ["deadline", "<main><h1>Award</h1><p>Apply by October 1, 2026.</p></main>", "Award Apply by October 1, 2026.", "<main><h1>Award</h1><p>Apply by October 15, 2026.</p></main>", "Award Apply by October 15, 2026.", "paragraph"],
    ["table amount", "<main><h1>Award</h1><table><tr><th>Funding</th><td>$5,000</td></tr></table></main>", "Award Funding $5,000", "<main><h1>Award</h1><table><tr><th>Funding</th><td>$7,500</td></tr></table></main>", "Award Funding $7,500", "table_row"],
    ["list eligibility", "<main><h1>Award</h1><ul><li>College juniors only.</li></ul></main>", "Award College juniors only.", "<main><h1>Award</h1><ul><li>College juniors and seniors.</li></ul></main>", "Award College juniors and seniors.", "list_item"],
    ["open section", "<main><h1>Award</h1><details open><summary>Eligibility</summary><p>Juniors only.</p></details></main>", "Award Eligibility Juniors only.", "<main><h1>Award</h1><details open><summary>Eligibility</summary><p>Juniors and seniors.</p></details></main>", "Award Eligibility Juniors and seniors.", "paragraph"],
  ])("records meaningful %s differences with structured context", (_name, beforeHtml, beforeText, afterHtml, afterText, kind) => {
    const f = fixture();
    const result = f.compare(f.capture({ html: beforeHtml, text: beforeText }), f.capture({ html: afterHtml, text: afterText }));
    expect(result).toMatchObject({ status: "changed", publishable: false });
    expect(result.changes).toMatchObject({ text_changed: true, added_blocks: 1, removed_blocks: 1 });
    expect(result.changes.examples.added_blocks[0]).toMatchObject({ kind });
    expect(result.changes.examples.added_blocks[0].heading_path).toContain("Award");
  });

  it("notices an application document destination change even when the label is identical", () => {
    const f = fixture();
    const previous = f.capture({ html: '<main><h1>Award</h1><a href="/apply.pdf?year=2026">Application</a></main>', text: "Award Application" });
    const current = f.capture({ html: '<main><h1>Award</h1><a href="/apply.pdf?year=2027">Application</a></main>', text: "Award Application" });
    const result = f.compare(previous, current);
    expect(result).toMatchObject({ status: "changed", publishable: false });
    expect(result.changes).toMatchObject({ text_changed: false, links_changed: true, added_links: 1, removed_links: 1 });
    expect(result.changes.examples.added_links[0].url).toBe("https://example.edu/apply.pdf?year=2027");
  });

  it("ignores scripts, styles, navigation, wrapper attributes, and harmless whitespace", () => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture({ html: '<html><head><style>.new { color: red }</style><script>window.counter=7</script></head><body><nav>Different menus</nav><main class="new"><div data-build="new"><h1> Award </h1><p>Apply <span>by October 1, 2026.</span></p></div></main><footer>New copyright</footer></body></html>' });
    expect(previous.html_capture.sha256).not.toBe(current.html_capture.sha256);
    expect(f.compare(previous, current)).toMatchObject({ status: "unchanged" });
  });

  it("does not compare explicitly hidden content", () => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture({ html: '<main><h1>Award</h1><p>Apply by October 1, 2026.</p><p hidden>Wrong date</p><p aria-hidden="true">Wrong amount</p><p style="display: none">Wrong eligibility</p></main>' });
    expect(f.compare(previous, current)).toMatchObject({ status: "unchanged" });
  });

  it("refuses a false unchanged result when a sole article excludes a changing award deadline", () => {
    const f = fixture();
    const previous = f.capture({ html: "<body><p>Deadline October 1.</p><article><h1>News</h1><p>Meet our scholars.</p></article></body>", text: "Deadline October 1. News Meet our scholars." });
    const current = f.capture({ html: "<body><p>Deadline October 15.</p><article><h1>News</h1><p>Meet our scholars.</p></article></body>", text: "Deadline October 15. News Meet our scholars." });
    const result = f.compare(previous, current);
    expectUnavailable(result, "pair_visible_text_change_not_explained");
    expect(result).toMatchObject({ visible_text_changed: true, previous: { scope: "article" }, current: { scope: "article" } });
    expect(result.previous.visible_text_sha256).not.toBe(result.current.visible_text_sha256);
  });

  it("does not silently dismiss changed visible text from filtered regions", () => {
    const f = fixture();
    const previous = f.capture({ html: "<body><nav>Apply by October 1.</nav><main><h1>Award</h1></main></body>", text: "Apply by October 1. Award" });
    const current = f.capture({ html: "<body><nav>Apply by October 15.</nav><main><h1>Award</h1></main></body>", text: "Apply by October 15. Award" });
    expectUnavailable(f.compare(previous, current), "pair_visible_text_change_not_explained");
  });

  it("preserves the qualification scope of nested eligibility requirements", () => {
    const f = fixture();
    const previous = f.capture({ html: "<main><h1>Award</h1><ul><li>Juniors<ul><li>Must study biology.</li></ul></li></ul></main>", text: "Award Juniors Must study biology." });
    const current = f.capture({ html: "<main><h1>Award</h1><ul><li>Juniors</li><li>Must study biology.</li></ul></main>", text: "Award Juniors Must study biology." });
    const result = f.compare(previous, current);
    expect(result).toMatchObject({ status: "changed", visible_text_changed: false, changes: { text_changed: false, structure_changed: true } });
    expect(result.changes.examples.removed_blocks[0]).toMatchObject({ text: "Must study biology.", list_path: ["Juniors"] });
  });

  it("fails closed for class-hidden prose absent from the verified visible text", () => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture({ html: '<head><style>.hidden { display:none }</style></head><main><h1>Award</h1><p>Apply by October 1, 2026.</p><p class="hidden">Deadline was cancelled.</p></main>' });
    expectUnavailable(f.compare(previous, current), "current_visible_text_not_corroborated");
  });

  it("does not use one visible occurrence to corroborate an identical hidden duplicate", () => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture({ html: '<head><style>.hidden { display:none }</style></head><main><h1>Award</h1><p>Apply by October 1, 2026.</p><p class="hidden">Apply by October 1, 2026.</p></main>' });
    expectUnavailable(f.compare(previous, current), "current_visible_text_not_corroborated");
  });

  it("detects changed heading scope even when every visible word is unchanged", () => {
    const f = fixture();
    const previous = f.capture({ html: "<main><h1>Undergraduate</h1><h2>Graduate</h2><p>Apply by October 1.</p></main>", text: "Undergraduate Graduate Apply by October 1." });
    const current = f.capture({ html: "<main><h1>Undergraduate</h1><h1>Graduate</h1><p>Apply by October 1.</p></main>", text: "Undergraduate Graduate Apply by October 1." });
    const result = f.compare(previous, current);
    expect(result).toMatchObject({ status: "changed", publishable: false });
    expect(result.changes).toMatchObject({ text_changed: false, structure_changed: true });
  });

  it("detects a deadline moving across table cells despite identical flattened words", () => {
    const f = fixture();
    const before = "<main><h1>Award</h1><table><tr><th>Round</th><th>Opens</th><th>Closes</th></tr><tr><td>Application</td><td>October 1</td><td>November 1</td></tr></table></main>";
    const after = "<main><h1>Award</h1><table><tr><th>Round</th><th>Opens</th><th>Closes</th></tr><tr><td>Application October 1</td><td>November 1</td><td></td></tr></table></main>";
    const text = "Award Round Opens Closes Application October 1 November 1";
    const result = f.compare(f.capture({ html: before, text }), f.capture({ html: after, text }));
    expect(result).toMatchObject({ status: "changed", publishable: false });
    expect(result.changes).toMatchObject({ text_changed: false, structure_changed: true });
    expect(result.changes.examples.added_blocks[0].cells.map((cell) => cell.text)).toEqual(["Application October 1", "November 1", ""]);
    expect(result.changes.examples.removed_blocks[0].cells.map((cell) => cell.text)).toEqual(["Application", "October 1", "November 1"]);
  });

  it.each(["previous", "current"])("keeps legacy %s captures on the existing fallback without inventing HTML", (side) => {
    const f = fixture();
    const captures = { previous: f.capture(), current: f.capture() };
    delete captures[side].html_path;
    expectUnavailable(f.compare(captures.previous, captures.current), `${side}_html_or_text_missing`);
  });

  it.each(["previous", "current"])("does not apply webpage comparison to a %s PDF", (side) => {
    const f = fixture();
    const captures = { previous: f.capture(), current: f.capture() };
    captures[side].kind = "pdf";
    expectUnavailable(f.compare(captures.previous, captures.current), "pdf_not_applicable");
  });

  it("does not claim changes during an explicit baseline refresh", () => {
    const f = fixture();
    expectUnavailable(f.compare(f.capture(), f.capture(), { baselineRefresh: true }), "baseline_refresh");
  });

  it.each(["capture_profile", "capture_behavior_version", "section_extraction_profile"])("rejects incompatible %s", (field) => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture({ metadata: { [field]: field === "capture_behavior_version" ? 4 : "baseline-rich" } });
    expectUnavailable(f.compare(previous, current), "pair_capture_configuration_changed");
  });

  it("requires configuration provenance instead of treating two missing values as compatible", () => {
    const f = fixture();
    const previous = f.capture({ metadata: { capture_profile: null } });
    const current = f.capture({ metadata: { capture_profile: null } });
    expectUnavailable(f.compare(previous, current), "pair_capture_configuration_changed");
  });

  it("rejects a different final page URL", () => {
    const f = fixture();
    expectUnavailable(f.compare(f.capture(), f.capture({ url: "https://example.edu/other-award" })), "pair_source_url_changed");
  });

  it.each([beforeTime, "2026-09-23T12:00:00.000Z"])("requires chronological captures rather than comparing %s to itself or the future", (capturedAt) => {
    const f = fixture();
    expectUnavailable(f.compare(f.capture(), f.capture({ capturedAt })), "pair_capture_order_invalid");
  });

  it.each([
    ["readiness timeout", { page_readiness: { timed_out: true } }],
    ["unstable layout", { page_settle: { stable: false, timed_out: false } }],
    ["settle timeout", { page_settle: { stable: true, timed_out: true } }],
    ["missing readiness", { page_readiness: null }],
  ])("does not turn %s into removals", (_label, metadata) => {
    const f = fixture();
    expectUnavailable(f.compare(f.capture(), f.capture({ metadata })), "current_capture_incomplete");
  });

  it.each([301, 403, 500, null])("rejects HTTP status %s", (status_code) => {
    const f = fixture();
    expectUnavailable(f.compare(f.capture(), f.capture({ metadata: { status_code } })), "current_http_status_not_successful");
  });

  it("rejects a block page even when its HTTP response was successful", () => {
    const f = fixture();
    expectUnavailable(f.compare(f.capture(), f.capture({ html: "<main>Verify you are human</main>", text: "Verify you are human" })), "current_blocked_page_content");
  });

  it.each(["source", "capture identity", "HTML declaration", "HTML bytes", "visible bytes", "text framing", "UTF-8", "missing file"])("rejects tampered %s without leaking an exception or file path", (kind) => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture();
    if (kind === "source") rewriteMetadata(current, (metadata) => { metadata.source.id = "other-source"; });
    if (kind === "capture identity") rewriteMetadata(current, (metadata) => { metadata.captured_at = beforeTime; }, { mirror: false });
    if (kind === "HTML declaration") rewriteMetadata(current, (metadata) => { metadata.html_capture.sha256 = "a".repeat(64); });
    if (kind === "HTML bytes") writeFileSync(current.html_path, "<main>Tampered private source content</main>");
    if (kind === "visible bytes") writeFileSync(current.text_path, "Wrong retained text\n");
    if (kind === "text framing") writeFileSync(current.text_path, `${defaultText}\n\n`);
    if (kind === "UTF-8") writeFileSync(current.html_path, Buffer.from([0xff, 0xfe]));
    if (kind === "missing file") rmSync(current.html_path);
    const result = f.compare(previous, current);
    expect(result).toMatchObject({ status: "unavailable", changes: null, publishable: false });
    expect(result.reason).toMatch(/^current_[a-z_]+$/);
    expect(JSON.stringify(result)).not.toContain(f.directory);
    expect(JSON.stringify(result)).not.toContain("Tampered private source content");
  });

  it("rejects oversized retained bytes before parsing or truncating them", () => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture();
    writeFileSync(current.html_path, Buffer.alloc(MAX_STRUCTURED_HTML_BYTES + 1, 32));
    expectUnavailable(f.compare(previous, current), "current_artifact_size_invalid");
  });

  it("rejects paths outside the archive even inside this test's owned temporary directory", () => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture();
    current.html_path = join(f.directory, "page.html.txt");
    writeFileSync(current.html_path, defaultHtml);
    expectUnavailable(f.compare(previous, current), "current_archive_path_unsafe");
  });

  it("rejects a symlinked directory escaping the archive", () => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture();
    const escaped = join(f.directory, "escaped");
    mkdirSync(escaped);
    writeFileSync(join(escaped, "page.html.txt"), defaultHtml);
    const link = join(f.archiveRoot, "linked");
    symlinkSync(escaped, link, process.platform === "win32" ? "junction" : "dir");
    current.html_path = join(link, "page.html.txt");
    expectUnavailable(f.compare(previous, current), "current_archive_path_unsafe");
  });

  it("rejects mixed capture directories even when bytes and declared hashes are identical", () => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture();
    current.html_path = previous.html_path;
    expectUnavailable(f.compare(previous, current), "current_capture_path_mismatch");
  });

  it("rejects a reference pointing to another retained file", () => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture();
    rewriteMetadata(current, (metadata) => { metadata.files.html = previous.files.html; });
    expectUnavailable(f.compare(previous, current), "current_capture_reference_mismatch");
  });

  it("reports explicitly unavailable HTML rather than parsing a stale file", () => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture();
    rewriteMetadata(current, (metadata) => { metadata.html_capture.status = "unavailable"; });
    expectUnavailable(f.compare(previous, current), "current_html_unavailable");
  });

  it("does not compare a different selected content scope", () => {
    const f = fixture();
    const previous = f.capture();
    const current = f.capture({ html: "<body><article><h1>Award</h1><p>Apply by October 1, 2026.</p></article></body>" });
    expectUnavailable(f.compare(previous, current), "pair_content_scope_changed");
  });
});

describe("bounded structured HTML differences", () => {
  const block = (text, heading_path = ["Award"]) => ({ kind: "paragraph", text, heading_path });
  const document = (blocks, links = []) => ({ text: blocks.map((entry) => entry.text).join("\n"), blocks, links });

  it("retains duplicate occurrence counts instead of comparing sets", () => {
    const result = compareStructuredHtmlDocuments(document([block("Apply"), block("Apply")]), document([block("Apply")]));
    expect(result).toMatchObject({ text_changed: true, added_blocks: 0, removed_blocks: 1, order_only: false });
  });

  it("identifies reordered prose without inventing changed words", () => {
    const result = compareStructuredHtmlDocuments(document([block("First"), block("Second")]), document([block("Second"), block("First")]));
    expect(result).toMatchObject({ text_changed: true, added_blocks: 0, removed_blocks: 0, order_only: true });
  });

  it("counts duplicate links independently of unchanged prose", () => {
    const link = { text: "Application", heading_path: ["Award"], url: "https://example.edu/apply" };
    const result = compareStructuredHtmlDocuments(document([block("Application")], [link, link]), document([block("Application")], [link]));
    expect(result).toMatchObject({ text_changed: false, links_changed: true, added_links: 0, removed_links: 1 });
  });

  it.each([[17, "Date"], [1, "d".repeat(400)]])("bounds table examples for %i cells without hiding truncation", (count, text) => {
    const cells = Array.from({ length: count }, () => ({ kind: "data", text, row_span: 1, col_span: 1 }));
    const current = document([{ kind: "table_row", text: "Date", heading_path: ["Award"], cells }]);
    const result = compareStructuredHtmlDocuments(document([]), current);
    expect(result).toMatchObject({ added_blocks: 1, examples_truncated: true });
    expect(result.examples.added_blocks[0].cells.length).toBeLessThanOrEqual(16);
    expect(result.examples.added_blocks[0].cells.every((cell) => cell.text.length <= 320)).toBe(true);
  });

  it("bounds examples while preserving full change counts and explicit truncation", () => {
    const previous = document([]);
    const current = document(Array.from({ length: 9 }, (_, index) => block(`${index} ${"x".repeat(400)}`, Array.from({ length: 12 }, (_, number) => `${number} ${"h".repeat(400)}`))), [
      { text: "a".repeat(400), heading_path: ["Award"], url: `https://example.edu/${"p".repeat(400)}` },
    ]);
    const result = compareStructuredHtmlDocuments(previous, current);
    expect(result).toMatchObject({ added_blocks: 9, added_links: 1, examples_truncated: true });
    expect(result.examples.added_blocks).toHaveLength(4);
    for (const example of result.examples.added_blocks) {
      expect(example.text.length).toBeLessThanOrEqual(320);
      expect(example.heading_path).toHaveLength(8);
      expect(example.heading_path.every((heading) => heading.length <= 320)).toBe(true);
    }
    expect(result.examples.added_links[0].url.length).toBeLessThanOrEqual(320);
  });
});
