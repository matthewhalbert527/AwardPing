import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "acorn";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import {
  SCRAPLING_WORKER_PROFILE, SCRAPLING_WORKER_PROFILE_V2,
  captureScraplingWorkerSource,
} from "./scrapling-worker.mjs";
import { parseScraplingReviewText } from "./scrapling-review-diff.mjs";
import {
  collectR2CaptureArtifactFiles, isR2CaptureGeometryReady, prepareR2CaptureArtifacts,
  projectRetainedCaptureArtifactsForMaterialization,
} from "./r2-capture-artifact-bindings.mjs";
import {
  conservativeExpansionStateCaptureCoverage, expansionStateCaptureCoverage,
  expansionStateCaptureCoverageLegacyMirrors, hasExpansionStateCaptureCoverageClaim,
  legacyExpansionStateCaptureCoverageFromMetadata,
} from "./expansion-state-descriptor-canonicalization.mjs";
import { SOURCE_HTML_PROFILE } from "./source-html-evidence.mjs";
import { atomicWriteJson } from "./visual-baseline-lock.mjs";
import { buildVisualSnapshotRef } from "./visual-review-queue.mjs";
import {
  captureFromVisualReviewCandidate, promoteApprovedVisualBaselineLocal,
  promoteApprovedVisualBaselineR2, visualBaselinePublicationDecision,
} from "./visual-baseline-promotion.mjs";
import { rehydrateLocalBaselineFromR2 } from "./r2-baseline-rehydration.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const source = {
  id: "12345678-1234-4234-8234-123456789012",
  shared_award_id: "22345678-1234-4234-8234-123456789012",
  url: "https://example.edu/synthetic-award", page_type: "eligibility", title: "Synthetic award",
};
const capturedAt = "2026-10-20T12:00:00.000Z";
const bucket = "synthetic-v2-retention";
const slots = ["html", "meta", "page", "text", "thumb"];
const profileFields = {
  capture_profile: "scrapling-evidence-v2",
  capture_behavior_name: "scrapling-evidence-v2", capture_behavior_version: 2,
};
let jpeg;
beforeAll(async () => {
  jpeg = await sharp({ create: { width: 1280, height: 900, channels: 3, background: "white" } })
    .jpeg().toBuffer();
});

function syntheticRecord({ profile = SCRAPLING_WORKER_PROFILE_V2, at = capturedAt, oldAnswer = false } = {}) {
  const answers = [
    "A campus nomination is required for each applicant; international candidates should consult their own campus office. ".repeat(80).trim(),
    "The programme admits eligible graduates in any discipline; a preliminary offer is not final admission.",
    "The deadline is stated as August only. No unstated calendar day may be inferred.",
    "Only applicants at participating institutions may use the nomination route; independent applicants use the separate route.",
    oldAnswer ? "The former synthetic rule required one reference." : "The final synthetic rule requires two references, including the campus endorsement.",
  ];
  const blocks = answers.map((text, index) => ({
    kind: "div", text, heading_path: [{ level: 2, text: "Frequently asked questions" }],
    list_path: [], table_row: [], sibling_button_path: [`Question ${index + 1}`],
  }));
  const text = answers.join(" ");
  const html = `<!doctype html><html><head><title>Synthetic award</title></head><body><main><h2>Frequently asked questions</h2>${answers.map((answer, index) => `<section><button>Question ${index + 1}</button><div>${answer}</div></section>`).join("")}<a href="/apply?audience=international&amp;cycle=2027">Apply</a></main></body></html>`;
  const htmlDocument = {
    schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document",
    source_url: source.url, title: "Synthetic award", text, publishable: false,
    visibility_verified: false, blocks,
    links: [{ text: "Apply", raw_href: "/apply?audience=international&cycle=2027",
      source_url: source.url, base_hrefs: [], heading_path: [], list_path: [] }],
    base_hrefs: [], limitations: ["Source blocks are not screenshot coordinates."],
  };
  return {
    schema: "awardping.scrapling-capture.v1", capture_profile: profile,
    source_id: source.id, url: source.url, final_url: source.url, captured_at: at,
    status_code: 200, content_type: "text/html", html,
    visible_html: `<ap-document>${text}</ap-document>`, text,
    document: { schema: "awardping.scrapling-document.v1", scope: "whole-visible-main-document",
      title: "Synthetic award", text, blocks: structuredClone(blocks),
      links: [{ text: "Apply", url: "https://example.edu/apply?audience=international&cycle=2027", heading_path: [], list_path: [] }], limitations: [] },
    html_document: htmlDocument, html_links: [], warnings: [], engine: { scrapling: "0.4.15" },
    readiness: { ready_state: "complete", fonts_status: "loaded", stable: true, samples: 3, stable_ms: 1000 },
    screenshot: {
      schema: "awardping.scrapling-screenshot.v1", mime_type: "image/jpeg", source_url: source.url,
      base64: jpeg.toString("base64"), sha256: sha(jpeg), byte_length: jpeg.length,
      width: 1280, height: 900, captured_at: at, full_page: true,
      geometry_status: "unavailable", alignment: "not_verified", semantics_bracketed: true,
      primary_html_captured_at: at, semantic_mismatches: [], limitations: [],
    },
  };
}

// Execute only these actual producer declarations. Importing the worker entry
// point would run its CLI; neither it nor any capture/network driver is run.
const producerSource = readFileSync(new URL("../capture-visual-snapshots.mjs", import.meta.url), "utf8");
if (Buffer.byteLength(producerSource) > 4 * 1024 * 1024) throw new Error("Producer fixture source exceeds its bound.");
const producerAst = parse(producerSource, { ecmaVersion: "latest", sourceType: "module" });
const producerNames = [
  "materializeRetainedCaptureAuthority", "unavailableR2TextGeometryReference",
  "r2CaptureLocalizationMetadata", "unavailableR2Localization", "captureLocalizationMetadata",
  "jsonObjectOrEmpty", "textGeometryReference", "cleanText", "normalizeText", "nonNegativeNumber",
];
const producerDeclarations = producerNames.map(name => {
  const declarations = producerAst.body.filter(node => node.type === "FunctionDeclaration" && node.id?.name === name);
  if (declarations.length !== 1) throw new Error(`Expected exactly one producer declaration: ${name}`);
  return producerSource.slice(declarations[0].start, declarations[0].end);
}).join("\n");

function materialize(archiveRoot, capture) {
  const checked = path => {
    const result = resolve(path), rel = relative(archiveRoot, result);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Fixture I/O escaped its own archive.");
    return result;
  };
  const deps = {
    SOURCE_HTML_PROFILE, archiveRoot,
    verifyLocalSourceHtmlCapture: () => { throw new Error("Unexpected source-HTML branch."); },
    legacyExpansionStateCaptureCoverageFromMetadata, hasExpansionStateCaptureCoverageClaim,
    conservativeExpansionStateCaptureCoverage, expansionStateCaptureCoverage,
    expansionStateCaptureCoverageLegacyMirrors, projectRetainedCaptureArtifactsForMaterialization,
    isR2CaptureGeometryReady,
    existsSync: path => existsSync(checked(path)),
    readJsonIfExists: path => JSON.parse(readFileSync(checked(path), "utf8")),
    atomicWriteJson: (path, value) => atomicWriteJson(checked(path), value),
    toArchiveRelative: path => relative(archiveRoot, checked(path)).replaceAll("\\", "/"),
    rewriteMatchingBaselineRetainedProjection: () => { throw new Error("Unexpected baseline rewrite."); },
  };
  const run = new Function(...Object.keys(deps), `${producerDeclarations}\nreturn materializeRetainedCaptureAuthority;`)(...Object.values(deps));
  return run(source, capture, { rewriteMatchingBaseline: false });
}

function candidateFor(capture, archiveRoot, id = "synthetic-v2-candidate") {
  return {
    id, shared_award_source_id: source.id, new_text_hash: capture.text_hash,
    new_image_hash: capture.image_hash, new_file_hash: null,
    new_snapshot_ref: buildVisualSnapshotRef(capture, path => relative(archiveRoot, path).replaceAll("\\", "/")),
  };
}

function fakeRemote() {
  let pointer = null;
  const objects = new Map(), calls = [];
  return {
    objects, calls, get pointer() { return structuredClone(pointer); },
    supabase: {
      from(table) {
        expect(table).toBe("shared_award_source_visual_snapshots");
        return { select() { return { eq(column, id) {
          expect([column, id]).toEqual(["shared_award_source_id", source.id]);
          return { async maybeSingle() { return { data: structuredClone(pointer), error: null }; } };
        } }; } };
      },
      async rpc(name, args) {
        expect(name).toBe("advance_shared_award_visual_snapshot");
        expect(args.p_expected_exists).toBe(false);
        expect(pointer).toBeNull();
        calls.push("pointer_compare_and_set"); pointer = structuredClone(args.p_snapshot);
        return { data: true, error: null };
      },
    },
    client: { async send(command) {
      const name = command.constructor.name, input = command.input;
      expect(input.Bucket).toBe(bucket);
      calls.push(name);
      if (name === "PutObjectCommand") {
        expect(objects.has(input.Key)).toBe(false);
        const body = Buffer.from(input.Body);
        expect(input.Metadata.sha256).toBe(sha(body));
        objects.set(input.Key, { body, contentType: input.ContentType, metadata: structuredClone(input.Metadata) });
        return {};
      }
      if (!["HeadObjectCommand", "GetObjectCommand"].includes(name)) throw new Error(`Unexpected fake R2 command: ${name}`);
      const object = objects.get(input.Key);
      if (!object) throw new Error("Missing synthetic object.");
      const response = { ContentLength: object.body.length, ContentType: object.contentType,
        Metadata: structuredClone(object.metadata), ETag: `"${sha(object.body)}"` };
      return name === "GetObjectCommand" ? { ...response, Body: Buffer.from(object.body) } : response;
    } },
  };
}

async function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "awardping-scrapling-v2-retention-"));
  const archiveRoot = join(root, "capture"), coldRoot = join(root, "cold");
  mkdirSync(archiveRoot); mkdirSync(coldRoot);
  try { await run({ root, archiveRoot, coldRoot }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

async function retainedFixture(archiveRoot) {
  const record = syntheticRecord(), originalRecord = JSON.stringify(record);
  const requests = [];
  const capture = await captureScraplingWorkerSource(source, {
    archiveRoot, captureProfile: SCRAPLING_WORKER_PROFILE_V2,
    capture: async (identity, options) => {
      expect(identity).toEqual(source); requests.push(options); return record;
    },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].captureProfile).toBe(SCRAPLING_WORKER_PROFILE_V2);
  expect(JSON.stringify(record)).toBe(originalRecord);
  const adapterMeta = JSON.parse(readFileSync(capture.meta_path, "utf8"));
  expect(capture).toMatchObject(profileFields);
  expect(adapterMeta).toMatchObject(profileFields);
  expect(adapterMeta.scrapling.screenshot).not.toHaveProperty("base64");
  const projection = materialize(archiveRoot, capture);
  expect(projection.authoritative).toEqual({ layout_retained: false, layout_hash: null, expansion_state_count: 0 });
  const prepared = prepareR2CaptureArtifacts(collectR2CaptureArtifactFiles(capture), { readFile: readFileSync });
  expect(prepared.artifacts.map(artifact => artifact.name)).toEqual(slots);
  const preparedMeta = JSON.parse(prepared.artifacts.find(artifact => artifact.name === "meta").body);
  expect(preparedMeta).toMatchObject(profileFields);
  expect(preparedMeta.localization).toMatchObject({ exact: false, accounted_for: true, geometry_ready: false });
  expect(preparedMeta.text_geometry).toBeNull();
  expect(preparedMeta.layout_hash).toBeNull();
  expect(preparedMeta.files.layout).toBeNull();
  expect(preparedMeta.expansion_state_capture_coverage.complete).toBe(false);
  const candidate = candidateFor(capture, archiveRoot);
  const reconstructed = captureFromVisualReviewCandidate(candidate, archiveRoot);
  expect(reconstructed).toMatchObject(profileFields);
  const remote = fakeRemote();
  // Trusted approval is synthetic input to this existing library API, not a
  // real semantic review, capture-profile migration or source enrollment.
  const promoted = await promoteApprovedVisualBaselineR2({
    candidate, source, capture: reconstructed, approved: true,
    supabase: remote.supabase, s3Client: remote.client, config: { enabled: true, bucket }, now: capturedAt,
  });
  expect(promoted).toMatchObject({ promoted: true, uploaded: 5 });
  return { record, capture, adapterMeta, prepared, remote };
}

describe("opt-in v2 browser evidence survives normal retained-artifact storage", () => {
  it("retains all five artifacts and v2 identity through fake R2/cold recovery without geometry or older-v1 publication", async () => withFixture(async ({ archiveRoot, coldRoot }) => {
    const f = await retainedFixture(archiveRoot);
    expect(f.record.html_document.text.length).toBeGreaterThan(8000);
    expect(f.remote.calls.filter(name => name === "PutObjectCommand")).toHaveLength(5);
    expect(f.remote.calls).not.toContain("DeleteObjectCommand");
    const pointer = f.remote.pointer;
    expect(Object.keys(pointer.latest_object_keys).sort()).toEqual(slots);
    expect(pointer.latest_metadata.capture_profile).toBe(SCRAPLING_WORKER_PROFILE_V2);
    expect(pointer.latest_metadata.localization.capture_behavior_version).toBe(2);
    const remoteMeta = JSON.parse(f.remote.objects.get(pointer.latest_object_keys.meta).body);
    expect(remoteMeta).toMatchObject(profileFields);
    expect(remoteMeta.scrapling.visible_text).toBe(f.record.text);
    expect(remoteMeta.scrapling.integrity.html_document_sha256).toBe(sha(JSON.stringify(f.record.html_document)));
    const before = new Map([...f.remote.objects].map(([key, value]) => [key, Buffer.from(value.body)]));
    const recovery = await rehydrateLocalBaselineFromR2({
      archiveRoot: coldRoot, source, baseline: null, snapshotRecord: pointer,
      bucket, client: f.remote.client, now: "2026-10-20T12:05:00.000Z",
    });
    expect(recovery).toMatchObject({ rehydrated: true, generation: "latest", restored_missing_baseline: true, restored_missing_source_directory: true });
    const baselinePath = join(coldRoot, "sources", source.id, "baseline.json");
    const baselineBytes = readFileSync(baselinePath);
    const baseline = JSON.parse(baselineBytes);
    const restoredMeta = JSON.parse(readFileSync(join(coldRoot, baseline.capture.meta), "utf8"));
    expect(baseline).toMatchObject(profileFields);
    expect(restoredMeta).toMatchObject(profileFields);
    expect(restoredMeta.scrapling).toEqual(remoteMeta.scrapling);
    expect(readFileSync(join(coldRoot, baseline.capture.html), "utf8")).toBe(f.record.html);
    expect(readFileSync(join(coldRoot, baseline.capture.page))).toEqual(jpeg);
    const restoredText = readFileSync(join(coldRoot, baseline.capture.text), "utf8");
    expect(restoredText).toBe(`${f.capture.text}\n`);
    const parsed = parseScraplingReviewText(restoredText.trimEnd(), { finalUrl: source.url });
    expect(parsed.context.blocks).toEqual(f.record.html_document.blocks);
    expect(parsed.context.links).toEqual(f.record.html_document.links);
    for (const block of f.record.html_document.blocks) expect(restoredText).toContain(block.text);
    expect(baseline.layout_hash).toBeNull(); expect(baseline.text_geometry).toBeNull();
    expect(baseline.capture.layout).toBeNull(); expect(baseline.capture.expansion_states).toEqual([]);
    expect(baseline.summary_metadata.retained_artifact_projection.authoritative.layout_retained).toBe(false);
    expect(baseline.summary_metadata.expansion_state_capture_coverage.complete).toBe(false);
    expect(restoredMeta.localization).toMatchObject({ exact: false, accounted_for: true, geometry_ready: false });
    expect(restoredMeta.scrapling.screenshot.alignment).toBe("not_verified");
    for (const [key, bytes] of before) expect(f.remote.objects.get(key).body).toEqual(bytes);

    const olderRecord = syntheticRecord({ profile: SCRAPLING_WORKER_PROFILE, at: "2026-10-19T12:00:00.000Z", oldAnswer: true });
    const older = await captureScraplingWorkerSource(source, {
      archiveRoot: coldRoot, captureProfile: SCRAPLING_WORKER_PROFILE, capture: async () => olderRecord,
    });
    materialize(coldRoot, older);
    const oldCandidate = candidateFor(older, coldRoot, "synthetic-older-v1-candidate");
    const local = promoteApprovedVisualBaselineLocal({ candidate: oldCandidate, source, archiveRoot: coldRoot, approved: true });
    expect(local).toMatchObject({ promoted: false, reason: "newer_whole_page_baseline_exists" });
    expect(visualBaselinePublicationDecision({ local })).toEqual({ action: "supersede", reason: "newer_whole_page_baseline_exists" });
    expect(readFileSync(baselinePath)).toEqual(baselineBytes);
    expect(f.remote.pointer).toEqual(pointer);
  }));

  it("rejects a corrupted retained HTML object before creating a cold baseline", async () => withFixture(async ({ archiveRoot, coldRoot }) => {
    const f = await retainedFixture(archiveRoot), pointer = f.remote.pointer;
    const htmlObject = f.remote.objects.get(pointer.latest_object_keys.html);
    htmlObject.body = Buffer.concat([htmlObject.body, Buffer.from("<!-- changed -->")]);
    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: coldRoot, source, baseline: null, snapshotRecord: pointer,
      bucket, client: f.remote.client, now: "2026-10-20T12:05:00.000Z",
    });
    expect(result.rehydrated).toBe(false);
    expect(result.reason).toBe("r2_object_sha256_mismatch");
    expect(existsSync(join(coldRoot, "sources", source.id, "baseline.json"))).toBe(false);
    expect(f.remote.calls.filter(name => name === "PutObjectCommand")).toHaveLength(5);
    expect(f.remote.calls).not.toContain("DeleteObjectCommand");
  }));
});
