import crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureRenderedHtml } from "./lib/rendered-html-capture.mjs";
import { buildVisualSnapshotRef, visualSnapshotArtifactManifest } from "./lib/visual-review-queue.mjs";
import { compareStableCaptureHashes } from "./lib/capture-stability.mjs";
import { SOURCE_HTML_PROFILE } from "./lib/source-html-evidence.mjs";

const worker = readFileSync(new URL("./capture-visual-snapshots.mjs", import.meta.url), "utf8");
const temporaryDirectories = [];
const capturedAt = "2026-09-25T14:00:00.000Z";
const sourceUrl = "https://example.edu/award";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function functionBody(name, nextName) {
  const start = worker.indexOf(`function ${name}(`);
  const end = worker.indexOf(`function ${nextName}(`, start + 1);
  if (start < 0 || end < 0) throw new Error(`Missing worker function boundary: ${name}`);
  return worker.slice(start, end).replace(/async\s*$/, "");
}

async function captureFixture(html = '<!DOCTYPE html><html><body><h1>Award</h1><a href="/2027.pdf">Apply</a></body></html>') {
  const directory = mkdtempSync(join(tmpdir(), "awardping-html-wiring-"));
  temporaryDirectories.push(directory);
  const result = await captureRenderedHtml({
    url: () => sourceUrl,
    evaluate: async () => ({ status: "captured", html, byte_length: Buffer.byteLength(html), source_url: sourceUrl }),
  }, { capturedAt, sourceUrl });
  const metadata = {
    kind: "webpage", captured_at: capturedAt, final_url: sourceUrl,
    html_capture: result.metadata, files: { html: "page.html.txt" },
  };
  const htmlPath = join(directory, "page.html.txt");
  const metaPath = join(directory, "meta.json");
  writeFileSync(htmlPath, result.html, "utf8");
  writeFileSync(metaPath, JSON.stringify(metadata));
  return {
    directory, htmlPath, metaPath, metadata,
    capture: { ...metadata, html_path: htmlPath, meta_path: metaPath, dir: directory },
    archiveRelative: (path) => relative(directory, path).replaceAll("\\", "/"),
  };
}

describe("rendered HTML worker integration", () => {
  it("records shadow diagnostics before materialization without replacing existing comparison gates", () => {
    const hook = worker.indexOf("attachHtmlComparisonDiagnostic(source, baseline, capture, report);");
    expect(hook).toBeGreaterThan(0);
    expect(worker.indexOf("materializeRetainedCaptureAuthority(source, capture);", hook)).toBeGreaterThan(hook);
    expect(worker).toContain("const textChanged = hashComparison.textChanged;");
    expect(worker).toContain("const screenshotChanged = hashComparison.screenshotChanged;");
    expect(worker).toContain("html_diagnostics: report.html_comparison");
    expect(functionBody("attachHtmlComparisonDiagnostic", "captureR2Files"))
      .not.toMatch(/writeBaseline|enqueueVisualReviewCandidate|markSharedSource|\.rpc\(|fetch\(/);
  });

  it("writes diagnostic metadata only to the new capture and keeps report counters content-free", () => {
    const fixture = diagnosticHookFixture();
    const capture = { kind: "webpage", captured_at: capturedAt, meta_path: "current/meta.json", text_hash: "original-text", image_hash: "original-image" };
    fixture.invoke({ id: "source-1" }, { capture: { meta: "previous/meta.json" } }, capture, fixture.report);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0].path).toBe("current/meta.json");
    expect(fixture.writes[0].metadata.html_comparison).toEqual(fixture.diagnostic);
    expect(capture.text_hash).toBe("original-text");
    expect(capture.image_hash).toBe("original-image");
    expect(fixture.report.html_comparison).toMatchObject({ checked: 1, changed: 1 });
    expect(fixture.report.html_comparison).not.toHaveProperty("changes");
  });

  it.each(["pdf", "same-webpage"])("never rewrites immutable or reused %s captures", (kind) => {
    const fixture = diagnosticHookFixture();
    const capture = { kind: kind === "pdf" ? "pdf" : "webpage", captured_at: capturedAt, meta_path: "current/meta.json" };
    fixture.invoke({ id: "source-1" }, { capture: { meta: "current/meta.json" } }, capture, fixture.report);
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.reads).toHaveLength(0);
    expect(fixture.report.html_comparison.checked).toBe(1);
  });

  it("refuses to write to metadata with a mismatched capture identity", () => {
    const fixture = diagnosticHookFixture({ metadataSourceId: "other-source" });
    expect(() => fixture.invoke({ id: "source-1" }, null, {
      kind: "webpage", captured_at: capturedAt, meta_path: "current/meta.json",
    }, fixture.report)).toThrow(/Capture identity changed/);
    expect(fixture.writes).toHaveLength(0);
  });

  it("never appends browser diagnostics to sealed source-only metadata", () => {
    const fixture = diagnosticHookFixture();
    fixture.invoke({ id: "source-1" }, null, { kind: "webpage", capture_profile: SOURCE_HTML_PROFILE }, fixture.report);
    expect(fixture.reads).toEqual([]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.report.html_comparison.checked).toBe(0);
  });

  it("captures after the accepted screenshot, before further section mutations, and before network finalization", () => {
    const capture = functionBody("captureSource", "captureStructuredVisibleTextGeometry");
    const htmlIndex = capture.indexOf("await captureRenderedHtml(page");
    expect(htmlIndex).toBeGreaterThan(capture.indexOf("verifyVisualScreenshotLayoutCapture({"));
    expect(htmlIndex).toBeLessThan(capture.indexOf("await extractExpandableSectionsForCapture(page"));
    expect(htmlIndex).toBeLessThan(capture.indexOf("await finalizeCaptureNetworkBoundary({"));
    expect(capture).toContain('if (renderedHtml.metadata.status === "captured")');
    expect(capture).toContain('writeFileSync(htmlPath, renderedHtml.html, "utf8")');
    expect(capture).toContain("html_capture: renderedHtml.metadata");
    expect(capture).toContain('html_path: renderedHtml.metadata.status === "captured" ? htmlPath : null');
  });

  it("propagates HTML through worker baseline and R2 metadata without adding it to comparison hashes", () => {
    expect(functionBody("r2CaptureMetadata", "unavailableR2TextGeometryReference")).toContain("html_capture: capture.html_capture || null");
    expect(functionBody("r2CaptureHashes", "r2CaptureMetadata")).not.toMatch(/html/);
    expect(functionBody("writeBaseline", "buildBaselineRecord")).toContain("html: capture.html_path ? toArchiveRelative(capture.html_path) : null");
    expect(functionBody("captureFromBaseline", "buildDiffSummary")).toContain("html_path: evidence.htmlPath");
  });

  it("binds supplemental HTML through the sealed metadata without changing the database's v1 manifest roles", async () => {
    const fixture = await captureFixture();
    const ref = buildVisualSnapshotRef(fixture.capture, fixture.archiveRelative);
    expect(ref.local_paths).not.toHaveProperty("html");
    expect(ref.metadata.html_capture).toEqual(fixture.metadata.html_capture);
    expect(ref.artifact_manifest.artifacts.map((artifact) => artifact.role)).toEqual(["meta"]);
    const sealedMetadataBytes = readFileSync(fixture.metaPath);
    expect(ref.local_paths.meta.sha256).toBe(crypto.createHash("sha256").update(sealedMetadataBytes).digest("hex"));
    expect(JSON.parse(sealedMetadataBytes.toString("utf8")).html_capture.sha256).toBe(fixture.metadata.html_capture.sha256);
    expect(JSON.stringify(ref)).not.toContain("<!DOCTYPE");
    expect(ref.artifact_manifest.complete).toBe(true);
  });

  it("rejects HTML changed after capture instead of sealing misleading evidence", async () => {
    const fixture = await captureFixture();
    writeFileSync(fixture.htmlPath, "<html>tampered</html>");
    expect(() => buildVisualSnapshotRef(fixture.capture, fixture.archiveRelative)).toThrow(/HTML/);
  });

  it.each(["source", "timestamp", "missing", "pdf"])("rejects mismatched %s provenance", async (kind) => {
    const fixture = await captureFixture();
    const capture = { ...fixture.capture };
    if (kind === "source") capture.final_url = "https://other.example/award";
    if (kind === "timestamp") capture.captured_at = "2026-09-24T14:00:00.000Z";
    if (kind === "missing") capture.html_path = null;
    if (kind === "pdf") capture.kind = "pdf";
    expect(() => buildVisualSnapshotRef(capture, fixture.archiveRelative)).toThrow(/HTML/);
  });

  it("retains honest unavailable metadata but no empty HTML artifact", async () => {
    const fixture = await captureFixture();
    const result = await captureRenderedHtml({
      url: () => sourceUrl,
      evaluate: async () => { throw new Error("unavailable"); },
    }, { capturedAt, sourceUrl });
    const metadata = { ...fixture.metadata, html_capture: result.metadata, files: { html: null } };
    writeFileSync(fixture.metaPath, JSON.stringify(metadata));
    const ref = buildVisualSnapshotRef({ ...fixture.capture, ...metadata, html_path: null }, fixture.archiveRelative);
    expect(ref.metadata.html_capture.status).toBe("unavailable");
    expect(ref.local_paths).not.toHaveProperty("html");
    expect(ref.artifact_manifest.artifacts.map((artifact) => artifact.role)).toEqual(["meta"]);
  });

  it("preserves legacy manifest identities without an HTML role", () => {
    const artifact = { sha256: "a".repeat(64), byte_length: 14 };
    const manifest = visualSnapshotArtifactManifest({ local_paths: { text: artifact } });
    // Stable JSON serialization sorts object keys; no new null HTML role.
    const payload = '{"artifacts":[{"byte_length":14,"role":"text","sha256":"' + "a".repeat(64) + '"}],"version":1}';
    expect(manifest.digest).toBe(crypto.createHash("sha256").update(payload).digest("hex"));
    expect(manifest.artifacts).toEqual([{ role: "text", ...artifact }]);
  });

  it("does not treat HTML-only changes as a text or screenshot update", () => {
    const oldCapture = { image_hash: "same-image", text_hash: "same-text", main_content_hash: "same-main", html_capture: { sha256: "old-html" } };
    const newCapture = { ...oldCapture, html_capture: { sha256: "new-html" } };
    expect(compareStableCaptureHashes(oldCapture, newCapture)).toMatchObject({ screenshotChanged: false, textChanged: false });
  });

  it("requires a declared HTML file on local baseline reuse, but accepts old baselines", () => {
    const paths = new Set(["page.jpg", "thumb.jpg", "text.txt", "layout.json", "meta.json"]);
    let metadata = {};
    const status = Function("fromArchiveRelative", "existsSync", "readJsonIfExists", "jsonObjectOrEmpty", "retainedCaptureArtifactProjectionSchema", "SOURCE_HTML_PROFILE",
      `${functionBody("baselineEvidenceStatus", "readRetainedBaselineLayout")}\nreturn baselineEvidenceStatus;`)(
      (path) => path || null, (path) => paths.has(path), () => metadata,
      (value) => value || {}, "awardping.capture-retained-artifact-projection.v1", SOURCE_HTML_PROFILE,
    );
    const baseline = { kind: "webpage", capture: { page: "page.jpg", thumb: "thumb.jpg", text: "text.txt", layout: "layout.json", meta: "meta.json" } };
    expect(status(baseline).ok).toBe(true);
    metadata = { html_capture: { status: "captured" } };
    expect(status(baseline)).toMatchObject({ ok: false, missing: ["html"] });
    baseline.capture.html = "page.html.txt";
    paths.add("page.html.txt");
    expect(status(baseline)).toMatchObject({ ok: true, htmlPath: "page.html.txt" });
  });
});

function diagnosticHookFixture({ metadataSourceId = "source-1" } = {}) {
  const diagnostic = { schema: "awardping.html-comparison.v1", mode: "shadow", status: "changed", reason: null, publishable: false, changes: { text_changed: true } };
  const writes = [];
  const reads = [];
  const invoke = Function("fromArchiveRelative", "compareRetainedHtmlCaptures", "archiveRoot", "baselineRefresh", "readJsonIfExists", "atomicWriteJson", "incrementCounterObject", "SOURCE_HTML_PROFILE",
    `${functionBody("attachHtmlComparisonDiagnostic", "captureR2Files")}\nreturn attachHtmlComparisonDiagnostic;`)(
    (path) => path, () => diagnostic, "archive", false,
    (path) => { reads.push(path); return { captured_at: capturedAt, source: { id: metadataSourceId } }; },
    (path, metadata) => writes.push({ path, metadata }),
    (counters, reason) => { counters[reason] = (counters[reason] || 0) + 1; },
    SOURCE_HTML_PROFILE,
  );
  return { invoke, diagnostic, writes, reads, report: { html_comparison: { checked: 0, changed: 0, unchanged: 0, first_observation: 0, unavailable: 0, reasons: {} } } };
}
