import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { SCRAPLING_WORKER_PROFILE, captureScraplingWorkerSource, scraplingReviewText } from "./scrapling-worker.mjs";
import { normalizeVisibleText } from "./capture-stability.mjs";
import { buildScraplingReviewDiff, parseScraplingReviewText } from "./scrapling-review-diff.mjs";
import { legacyExpansionStateCaptureCoverageFromMetadata } from "./expansion-state-descriptor-canonicalization.mjs";
import { isR2CaptureGeometryReady, projectRetainedCaptureArtifacts } from "./r2-capture-artifact-bindings.mjs";
import { buildVisualSnapshotRef } from "./visual-review-queue.mjs";
import { captureFromVisualReviewCandidate, promoteApprovedVisualBaselineLocal,
  promoteApprovedVisualBaselineR2 } from "./visual-baseline-promotion.mjs";
import { rehydrateLocalBaselineFromR2 } from "./r2-baseline-rehydration.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const roots = [];
const source = {
  id: "11111111-1111-4111-8111-111111111111",
  shared_award_id: "22222222-2222-4222-8222-222222222222",
  url: "https://example.edu/award/eligibility", page_type: "eligibility",
};
const actualPath = new URL("../../tmp/scrapling-cutover-20261015/reviewed-run-2026-10-15T21-31-52-324Z-f9a41d2f/captures/013-799dd70c-f337-4bcc-bd2a-7efb50f0c7e2.json", import.meta.url);
const samvidPath = new URL("../../tmp/scrapling-cutover-20261015/reviewed-run-2026-10-15T21-31-52-324Z-f9a41d2f/captures/102-664d38ba-c717-5d51-b7ce-9e3a27f41fec.json", import.meta.url);
const workerCode = readFileSync(new URL("../capture-visual-snapshots.mjs", import.meta.url), "utf8");

function archive() {
  const path = mkdtempSync(join(tmpdir(), "awardping-scrapling-contract-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    // Only this test's explicitly created, absolute temporary roots are removed.
    if (resolve(path) !== path || !basename(path).startsWith("awardping-scrapling-contract-")) {
      throw new Error("Unsafe test cleanup target");
    }
    rmSync(path, { recursive: true, force: true });
  }
});

async function syntheticRecord() {
  const text = "Applicants must be juniors. Application deadline: March 15, 2027. Hidden FAQ: applicants must be U.S. citizens.";
  const html = `<html><head><title>Award eligibility</title></head><body><p>Applicants must be juniors. Application deadline: March 15, 2027.</p><details><summary>Citizenship</summary><p>Hidden FAQ: applicants must be U.S. citizens.</p></details></body></html>`;
  const jpeg = await sharp({ create: { width: 1280, height: 900, channels: 3, background: "white" } }).jpeg().toBuffer();
  const capturedAt = "2026-10-15T21:31:00.000Z";
  const blocks = [{ kind: "paragraph", text, heading_path: [], list_path: [], table_row: [] }];
  return {
    schema: "awardping.scrapling-capture.v1", capture_profile: SCRAPLING_WORKER_PROFILE,
    source_id: source.id, url: source.url, final_url: source.url, captured_at: capturedAt,
    status_code: 200, content_type: "text/html", html, visible_html: `<ap-document>${text}</ap-document>`, text,
    document: { schema: "awardping.scrapling-document.v1", scope: "whole-visible-main-document",
      title: "Award eligibility", text, blocks, links: [], limitations: [] },
    html_document: { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document",
      source_url: source.url, title: "Award eligibility", text, blocks, links: [], base_hrefs: [],
      limitations: ["Hidden text may be stale."], publishable: false, visibility_verified: false },
    html_links: [], warnings: [], engine: { scrapling: "0.4.15" },
    readiness: { ready_state: "complete", fonts_status: "loaded", stable: true, samples: 3, stable_ms: 1000 },
    screenshot: { schema: "awardping.scrapling-screenshot.v1", mime_type: "image/jpeg", source_url: source.url,
      base64: jpeg.toString("base64"), sha256: hash(jpeg), byte_length: jpeg.length,
      width: 1280, height: 900, captured_at: capturedAt, full_page: true,
      geometry_status: "unavailable", alignment: "not_verified", semantics_bracketed: true,
      limitations: ["No screenshot coordinates are verified.", "No section expansion was performed."] },
  };
}

// This is the existing worker's explicit retained-artifact materialization shape,
// not a claim that preparing files alone promotes them. No geometry is fabricated.
function materialize(capture) {
  const projected = projectRetainedCaptureArtifacts(capture, { exists: existsSync });
  expect(projected.layoutRetained).toBe(false);
  const localization = {
    status: "evidence_only_geometry_unavailable", exact: false, accounted_for: true,
    geometry_ready: false, geometry_hash: null, bound_image_hash: null,
    unavailable_reason: "Exact screenshot geometry did not pass the retained localization contract.",
  };
  Object.assign(capture, { retained_artifact_projection: projected.manifest, localization });
  const metadata = JSON.parse(readFileSync(capture.meta_path, "utf8"));
  Object.assign(metadata, { retained_artifact_projection: projected.manifest, localization });
  writeFileSync(capture.meta_path, JSON.stringify(metadata));
  return capture;
}

function candidateFor(capture, archiveRoot) {
  return {
    id: "33333333-3333-4333-8333-333333333333", shared_award_source_id: capture.source.id,
    shared_award_id: capture.source.shared_award_id,
    new_text_hash: capture.text_hash, new_image_hash: capture.image_hash, deterministic_diff: {},
    new_snapshot_ref: buildVisualSnapshotRef(capture, value => relative(archiveRoot, value).replaceAll("\\", "/")),
  };
}

function remoteStub() {
  let current = null;
  const objects = new Map();
  const operations = [];
  return {
    objects, operations, get current() { return current; },
    database: {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: structuredClone(current), error: null }) }) }) }),
      async rpc(_name, args) {
        if (args.p_expected_exists !== Boolean(current) || (current && args.p_expected_updated_at !== current.updated_at)) {
          return { data: false, error: null };
        }
        current = structuredClone(args.p_snapshot);
        operations.push("pointer");
        return { data: true, error: null };
      },
    },
    client: {
      async send(command) {
        const { Key: key, Body: body, ContentType: contentType, Metadata: metadata } = command.input;
        const type = command.constructor.name;
        if (type === "PutObjectCommand") {
          objects.set(key, { body: Buffer.from(body), contentType, metadata });
          operations.push(`put:${key}`);
          return {};
        }
        if (type === "DeleteObjectCommand") {
          objects.delete(key);
          operations.push(`delete:${key}`);
          return {};
        }
        const object = objects.get(key);
        if (!object) throw new Error("Missing in-memory artifact");
        const common = { ContentLength: object.body.length, ContentType: object.contentType,
          Metadata: object.metadata, ETag: `"${createHash("md5").update(object.body).digest("hex")}"` };
        if (type === "HeadObjectCommand") return common;
        if (type === "GetObjectCommand") return { ...common, Body: object.body };
        throw new Error(`Unexpected command ${type}`);
      },
    },
  };
}

function workerBaselineReaders(archiveRoot, baseline) {
  // Execute only these actual pure wrappers with explicit local dependencies.
  // Importing the monolithic worker would run its CLI and is intentionally avoided.
  const extract = (name, next) => {
    const start = workerCode.indexOf(`function ${name}(`);
    const end = workerCode.indexOf(`\nfunction ${next}(`, start);
    if (start < 0 || end < start) throw new Error("Worker wrapper boundaries changed");
    return workerCode.slice(start, end);
  };
  const fromArchiveRelative = path => path ? join(archiveRoot, path) : null;
  const evidence = { ok: true, kind: "webpage", metaPath: fromArchiveRelative(baseline.capture.meta),
    textPath: fromArchiveRelative(baseline.capture.text), htmlPath: fromArchiveRelative(baseline.capture.html),
    pagePath: fromArchiveRelative(baseline.capture.page), thumbPath: fromArchiveRelative(baseline.capture.thumb),
    layoutPath: null, expansionStateScreenshots: [] };
  const readBaseline = new Function("baselineEvidenceStatus", "readFileSync", "readJsonIfExists",
    `return (${extract("readBaselineEvidence", "baselineEvidenceStatus")});`)(
    () => evidence, readFileSync, path => JSON.parse(readFileSync(path, "utf8")),
  );
  const captureFromBaseline = new Function("readBaselineEvidence", "hydrateRetainedBaselineGeometry", "fromArchiveRelative", "dirname",
    `return (${extract("captureFromBaseline", "buildDiffSummary")});`)(
    readBaseline, () => ({ textGeometry: null, expansionStateScreenshots: [] }), fromArchiveRelative, dirname,
  );
  return { previous: readBaseline(baseline), capture: captureFromBaseline(baseline) };
}

async function bundle(record, identity = source) {
  const archiveRoot = archive();
  const capture = await captureScraplingWorkerSource(identity, { archiveRoot, capture: async () => record });
  return { archiveRoot, capture, source: identity };
}

function assertPassiveCoverage(capture) {
  expect(legacyExpansionStateCaptureCoverageFromMetadata(capture, { retainedStateCount: 0 })).toMatchObject({
    complete: false, status: "skipped_profile",
    raw_candidate_count_exact: false, logical_candidate_count_exact: false,
  });
  expect(isR2CaptureGeometryReady(capture)).toBe(false);
  expect(capture.layout_hash).toBeNull();
  expect(capture.expansion_state_screenshots).toEqual([]);
}

describe("Scrapling capture to existing baseline contract", () => {
  it("marks passive expansion coverage canonically without claiming complete discovery or geometry", async () => {
    const { capture } = await bundle(await syntheticRecord());
    assertPassiveCoverage(capture);
    assertPassiveCoverage(JSON.parse(readFileSync(capture.meta_path, "utf8")));
    expect(capture.page_settle).toMatchObject({ stable: false, primary_html_semantics_stable: true });
    expect(capture.scrapling.screenshot).toMatchObject({ alignment: "not_verified", geometry_status: "unavailable" });
    expect(capture.scrapling.screenshot).not.toHaveProperty("base64");
  });

  it("does not mistake an unmaterialized bundle or unapproved candidate for promotion", async () => {
    const { capture, archiveRoot } = await bundle(await syntheticRecord());
    const candidate = candidateFor(capture, archiveRoot);
    expect(promoteApprovedVisualBaselineLocal({ candidate, source, archiveRoot, approved: false }).promoted).toBe(false);
    expect(promoteApprovedVisualBaselineLocal({ candidate, source, archiveRoot, approved: true })).toMatchObject({
      promoted: false, reason: "approved_snapshot_geometry_metadata_missing",
    });
    expect(existsSync(join(archiveRoot, "sources", source.id, "baseline.json"))).toBe(false);
  });

  it("promotes only materialized, approved exact evidence and retains HTML and caveats", async () => {
    const { capture, archiveRoot } = await bundle(await syntheticRecord());
    materialize(capture);
    const candidate = candidateFor(capture, archiveRoot);
    const reconstructed = captureFromVisualReviewCandidate(candidate, archiveRoot);
    expect(reconstructed.capture_profile).toBe(SCRAPLING_WORKER_PROFILE);
    expect(reconstructed.html_capture).toEqual(capture.html_capture);
    const promoted = promoteApprovedVisualBaselineLocal({ candidate, source, archiveRoot, approved: true });
    expect(promoted.promoted).toBe(true);
    expect(promoted.baseline).toMatchObject({ capture_profile: SCRAPLING_WORKER_PROFILE, body_text_hash: capture.body_text_hash });
    expect(promoted.baseline.capture.html).toMatch(/page\.html\.txt$/);
    assertPassiveCoverage(promoted.capture);
    expect(readFileSync(promoted.capture.html_path, "utf8")).toContain("Hidden FAQ");
    expect(parseScraplingReviewText(readFileSync(promoted.capture.text_path, "utf8"), { finalUrl: source.url }).prose).toContain("U.S. citizens");
  });

  it("round-trips through immutable in-memory R2 and a cold local cache without inventing evidence", async () => {
    const record = await syntheticRecord();
    const restored = await roundTrip(record, source);
    const nextRecord = JSON.parse(JSON.stringify(record).replaceAll("March 15", "March 16"));
    nextRecord.captured_at = "2026-10-16T21:31:00.000Z";
    nextRecord.screenshot.captured_at = nextRecord.captured_at;
    const next = await bundle(nextRecord);
    expect(buildScraplingReviewDiff({ source, baseline: restored.baseline,
      previous: restored.previous, capture: next.capture })).toMatchObject({
      status: "changed_needs_review", visible_prose_corroborated: true, publishable: false,
    });
  });

  it.each(["previous", "current"])("preserves a %s screenshot mismatch through real adapter and cold-cache contracts and holds review", async side => {
    const original = await syntheticRecord();
    const previousRecord = structuredClone(original);
    const nextRecord = JSON.parse(JSON.stringify(original).replaceAll("March 15", "March 16"));
    nextRecord.captured_at = "2026-10-16T21:31:00.000Z";
    nextRecord.screenshot.captured_at = nextRecord.captured_at;
    const mismatched = side === "previous" ? previousRecord : nextRecord;
    mismatched.screenshot.semantics_bracketed = false;
    mismatched.screenshot.primary_html_captured_at = mismatched.captured_at;
    mismatched.screenshot.semantic_mismatches = [{ field: "html_source.text",
      before_sha256: "a".repeat(64), after_sha256: "b".repeat(64), before_bytes: 100, after_bytes: 101 }];
    mismatched.screenshot.limitations.push("Content changed during the supplementary screenshot; it does not establish matching primary HTML.");
    mismatched.warnings.push("supplementary_screenshot_semantics_changed_not_aligned");
    // Baseline maintenance may retain a valid primary capture with a disclosed
    // image mismatch. It must not subsequently permit an automatic change queue.
    const restored = await roundTrip(previousRecord, source);
    const next = await bundle(nextRecord);
    const retained = side === "previous" ? restored.previous.meta : next.capture;
    expect(retained.scrapling.screenshot).toMatchObject({ semantics_bracketed: false,
      semantic_mismatches: mismatched.screenshot.semantic_mismatches,
      primary_html_captured_at: mismatched.captured_at });
    expect(retained.page_settle.screenshot_semantics_bracketed).toBe(false);
    expect(buildScraplingReviewDiff({ source, baseline: restored.baseline,
      previous: restored.previous, capture: next.capture })).toMatchObject({
      status: "manual_review_required", reason: "supplementary_screenshot_semantics_changed",
      diff: null, publishable: false, baseline_advance_allowed: false, retain_both_captures: true,
    });
  });

  it("rejects supplemental HTML tampering before promotion or upload", async () => {
    const { capture, archiveRoot } = await bundle(await syntheticRecord());
    materialize(capture);
    const candidate = candidateFor(capture, archiveRoot);
    const reconstructed = captureFromVisualReviewCandidate(candidate, archiveRoot);
    writeFileSync(capture.html_path, "<html>tampered</html>");
    expect(() => promoteApprovedVisualBaselineLocal({ candidate, source, archiveRoot, approved: true })).toThrow();
    const remote = remoteStub();
    await expect(promoteApprovedVisualBaselineR2({ candidate, source, capture: reconstructed, approved: true,
      config: { enabled: true, bucket: "test-snapshots" }, supabase: remote.database, s3Client: remote.client })).rejects.toThrow();
    expect(remote.operations).toEqual([]);
  });

  it.skipIf(!existsSync(actualPath))("replays the retained Rhodes capture through local promotion, R2, and cold restore, without changing it", async () => {
    const original = readFileSync(actualPath);
    const record = JSON.parse(original);
    const identity = { id: record.source_id, shared_award_id: "3e0c02fe-70cc-4933-81c4-b58ac4036bff", url: record.url };
    await roundTrip(record, identity);
    expect(hash(readFileSync(actualPath))).toBe(hash(original));
  }, 30000);

  it.skipIf(!existsSync(samvidPath)).each([
    ["application opening month", 6, value => value.replace("February 2027", "March 2027")],
    ["funding amount and its per-year qualifier", 13, value => value.replace("$100,000", "$120,000").replace("$50,000", "$60,000")],
  ])("admits a synthetic-only next-capture %s fixture on the retained Samvid page", (_, index, mutate) => {
    // These in-memory edits are deliberately fictional test inputs. They are NOT
    // later observations, screenshots, site changes, database updates or alerts.
    const original = readFileSync(samvidPath);
    const record = JSON.parse(original);
    const identity = { ...source, id: record.source_id, url: record.url };
    const before = record.html_document, after = structuredClone(before);
    const oldText = before.blocks[index].text, newText = mutate(oldText);
    expect(newText).not.toBe(oldText);
    after.blocks[index].text = newText;
    after.text = after.text.replace(oldText, newText);
    const meta = (document, visible, capturedAt) => {
      const value = scraplingReviewText(document);
      return { source: identity, capture_profile: record.capture_profile, final_url: record.final_url,
        captured_at: capturedAt, page_title: document.title, text: value, text_hash: hash(normalizeVisibleText(value)),
        scrapling: { visible_title: record.document.title, visible_text: visible, visible_text_sha256: hash(visible),
          visible_text_scope: "whole-visible-main-document", screenshot: { semantics_bracketed: true } } };
    };
    const baseline = meta(before, record.text, record.captured_at);
    const capture = meta(after, record.text.replace(oldText, newText), new Date(Date.parse(record.captured_at) + 86400000).toISOString());
    const result = buildScraplingReviewDiff({ source: identity, baseline, previous: { meta: baseline, text: baseline.text }, capture });
    expect(result).toMatchObject({ status: "changed_needs_review", publishable: false, baseline_advance_allowed: false });
    expect(result.diff.added_text).toEqual([newText]);
    expect(result.diff.removed_text).toEqual([oldText]);
    expect(result.diff.scrapling_semantics.current_source_prose).toContain("Toggle navigation");
    expect(hash(readFileSync(samvidPath))).toBe(hash(original));
  });
});

async function roundTrip(record, identity) {
  const { capture, archiveRoot } = await bundle(record, identity);
  assertPassiveCoverage(capture);
  expect(capture.scrapling.visible_text).toBe(record.text);
  expect(capture.scrapling.visible_text_sha256).toBe(hash(record.text));
  expect(capture.scrapling.visible_title).toBe(record.document.title);
  materialize(capture);
  const candidate = candidateFor(capture, archiveRoot);
  const local = promoteApprovedVisualBaselineLocal({ candidate, source: identity, archiveRoot, approved: true });
  expect(local.promoted).toBe(true);
  const remote = remoteStub();
  const published = await promoteApprovedVisualBaselineR2({ candidate, source: identity,
    capture: local.capture, approved: true, config: { enabled: true, bucket: "test-snapshots" },
    supabase: remote.database, s3Client: remote.client });
  expect(published.promoted).toBe(true);
  expect(remote.current.latest_metadata.capture_profile).toBe(SCRAPLING_WORKER_PROFILE);
  expect(remote.current.latest_metadata.text_geometry).toBeNull();
  expect(remote.current.latest_metadata.localization.geometry_ready).toBe(false);
  for (const [slot, key] of Object.entries(remote.current.latest_object_keys)) {
    const retained = remote.objects.get(key);
    expect(remote.current.latest_metadata.artifact_bindings[slot]).toMatchObject({ sha256: hash(retained.body), byte_length: retained.body.length });
  }
  const coldArchive = archive();
  const restored = await rehydrateLocalBaselineFromR2({ archiveRoot: coldArchive, source: identity,
    baseline: null, snapshotRecord: remote.current, bucket: "test-snapshots", client: remote.client });
  expect(restored, JSON.stringify(restored)).toMatchObject({ rehydrated: true });
  const baseline = JSON.parse(readFileSync(join(coldArchive, "sources", identity.id, "baseline.json"), "utf8"));
  expect(baseline.capture_profile).toBe(SCRAPLING_WORKER_PROFILE);
  expect(baseline.body_text_hash).toBe(capture.body_text_hash);
  expect(baseline.html_capture).toEqual(capture.html_capture);
  const restoredMeta = JSON.parse(readFileSync(join(coldArchive, baseline.capture.meta), "utf8"));
  assertPassiveCoverage(restoredMeta);
  expect(restoredMeta.scrapling.screenshot).toEqual(capture.scrapling.screenshot);
  expect(restoredMeta.scrapling.visible_text).toBe(record.text);
  expect(restoredMeta.scrapling.visible_text_sha256).toBe(hash(record.text));
  const wrappers = workerBaselineReaders(coldArchive, baseline);
  expect(wrappers.previous.meta.scrapling.visible_title).toBe(record.document.title);
  expect(wrappers.previous.meta.scrapling.visible_text).toBe(record.text);
  expect(wrappers.previous.meta.scrapling.visible_text_sha256).toBe(hash(record.text));
  expect(wrappers.capture.scrapling).toEqual(restoredMeta.scrapling);
  expect(wrappers.capture.capture_profile).toBe(SCRAPLING_WORKER_PROFILE);
  expect(wrappers.capture.capture_behavior_version).toBe(1);
  expect(wrappers.capture.capture_behavior_name).toBe(SCRAPLING_WORKER_PROFILE);
  expect(restoredMeta.page_settle.stable).toBe(false);
  expect(readFileSync(join(coldArchive, baseline.capture.html))).toEqual(readFileSync(capture.html_path));
  expect(readFileSync(join(coldArchive, baseline.capture.text))).toEqual(readFileSync(capture.text_path));
  expect(remote.operations.filter(operation => operation === "pointer")).toHaveLength(1);
  return { baseline, previous: wrappers.previous };
}
