import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  applyLegacyR2SnapshotPointerItem,
  assertReviewedQuarantinePrecondition,
  assertLegacyR2PointerMigrationPlan,
  blockedLegacyR2MigrationItem,
  buildLegacyR2PointerMigrationPlan,
  inspectLegacyR2SnapshotPointer,
  legacyR2CaptureVersion,
  migrationFailureQuarantineEvidence,
  sha256Bytes,
} from "./legacy-r2-snapshot-pointer-migration.mjs";
import { bindVisualTextGeometry } from "./visual-event-localization.mjs";
import {
  createR2ObjectStore,
  parseLegacyR2PointerMigrationArgs,
} from "../migrate-legacy-r2-snapshot-pointers.mjs";

const sourceId = "81fcec98-9e95-4ee5-823a-daf992371e17";
const awardId = "4c02307f-5928-4066-8f97-bd704b372184";
const sourceUrl = "https://www.marshallscholarship.org/apply/faqs/";
const bucket = "awardping-snapshots";
const builtAt = "2026-08-10T15:00:00.000Z";
const cliSource = readFileSync(
  new URL("../migrate-legacy-r2-snapshot-pointers.mjs", import.meta.url),
  "utf8",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

function sourceRow() {
  return {
    id: sourceId,
    shared_award_id: awardId,
    url: sourceUrl,
    title: "Marshall Scholarship FAQs",
    display_title: "FAQs",
    page_type: "faq",
    admin_review_status: "review_later",
  };
}

function generationFixture(name, capturedAt, marker) {
  const page = Buffer.from(`jpeg-page-${marker}`, "utf8");
  const thumb = Buffer.from(`jpeg-thumb-${marker}`, "utf8");
  const semanticText = `Eligibility wording ${marker}`;
  const text = Buffer.from(`${semanticText}\n`, "utf8");
  const hashes = {
    image_hash: sha256(page),
    text_hash: sha256(Buffer.from(semanticText, "utf8")),
  };
  const metadata = {
    capture_profile: "desktop",
    final_url: sourceUrl,
    page_title: "Frequently asked questions",
    status_code: 200,
    status_text: "OK",
    content_type: "text/html; charset=utf-8",
    text_length: semanticText.length,
    text_object_bytes: text.length,
    page_bytes: page.length,
    thumb_bytes: thumb.length,
    expansion_state_count: 0,
    expansion_state_screenshots: [],
    localization: {
      status: "evidence_only_geometry_unavailable",
      geometry_ready: false,
      accounted_for: true,
      unavailable_reason: "legacy_no_retained_geometry",
    },
  };
  const metaValue = {
    version: 1,
    kind: "webpage",
    source: {
      id: sourceId,
      shared_award_id: awardId,
      url: sourceUrl,
    },
    captured_at: capturedAt,
    capture_profile: "desktop",
    final_url: sourceUrl,
    page_title: "Frequently asked questions",
    status_code: 200,
    status_text: "OK",
    content_type: "text/html; charset=utf-8",
    image_hash: hashes.image_hash,
    text_hash: hashes.text_hash,
    text_length: semanticText.length,
    page_bytes: page.length,
    thumb_bytes: thumb.length,
    expansion_state_screenshots: [],
  };
  const meta = Buffer.from(JSON.stringify(metaValue, null, 2), "utf8");
  const prefix = `visual-snapshots/sources/${sourceId}/${name}`;
  const objectKeys = {
    page: `${prefix}/page.jpg`,
    thumb: `${prefix}/thumb.jpg`,
    text: `${prefix}/text.txt`,
    meta: `${prefix}/meta.json`,
  };
  const objects = new Map([
    [objectKeys.page, objectRecord(page, "image/jpeg")],
    [objectKeys.thumb, objectRecord(thumb, "image/jpeg")],
    [objectKeys.text, objectRecord(text, "text/plain; charset=utf-8")],
    [objectKeys.meta, objectRecord(meta, "application/json; charset=utf-8")],
  ]);
  applyArtifactBindings(metadata, objectKeys, objects);
  return { capturedAt, hashes, metadata, objectKeys, objects, semanticText, text };
}

function objectRecord(body, contentType, {
  metadata = {},
  checksumSha256 = null,
} = {}) {
  return {
    body: Buffer.from(body),
    contentType,
    metadata: { ...metadata },
    checksumSha256,
  };
}

function applyArtifactBindings(metadata, objectKeys, objects) {
  metadata.artifact_bindings_schema = "awardping.r2.capture-artifact-bindings.v1";
  metadata.artifact_bindings = Object.fromEntries(
    Object.entries(objectKeys)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([slot, key]) => {
        const record = objects.get(key);
        if (!record) throw new Error(`Missing fixture object ${key}`);
        return [slot, {
          sha256: sha256(record.body),
          byte_length: record.body.length,
          content_type: writerContentType(slot),
          hash_mode: "raw_sha256",
        }];
      }),
  );
}

function writerContentType(slot) {
  if (slot === "page" || slot === "thumb" || /^expansion_state_\d{2}$/u.test(slot)) {
    return "image/jpeg";
  }
  if (slot === "pdf") return "application/pdf";
  if (slot === "text") return "text/plain; charset=utf-8";
  if (slot === "meta" || slot === "layout" || /_layout$/u.test(slot)) {
    return "application/json; charset=utf-8";
  }
  throw new Error(`Unknown fixture slot ${slot}`);
}

function fixture() {
  const latest = generationFixture("latest", "2026-07-02T15:51:41.972Z", "latest");
  const previous = generationFixture("previous", "2026-06-25T23:16:36.042Z", "previous");
  const row = {
    shared_award_source_id: sourceId,
    shared_award_id: awardId,
    source_url: sourceUrl,
    source_title: "Marshall Scholarship FAQs",
    source_page_type: "faq",
    kind: "webpage",
    bucket,
    latest_captured_at: latest.capturedAt,
    latest_object_keys: latest.objectKeys,
    latest_hashes: latest.hashes,
    latest_metadata: latest.metadata,
    previous_captured_at: previous.capturedAt,
    previous_object_keys: previous.objectKeys,
    previous_hashes: previous.hashes,
    previous_metadata: previous.metadata,
    updated_at: "2026-07-02T15:51:54.380Z",
  };
  const objects = new Map([...latest.objects, ...previous.objects]);
  return { latest, previous, row, source: sourceRow(), objects };
}

function pdfFixture() {
  const url = "https://www.marshallscholarship.org/media/official-guidance.pdf";
  const capturedAt = "2026-07-03T12:00:00.000Z";
  const pdf = Buffer.from("%PDF-1.7 official guidance", "utf8");
  const semanticText = "Official guidance";
  const text = Buffer.from(`${semanticText}\n`, "utf8");
  const hashes = {
    file_hash: sha256(pdf),
    text_hash: sha256(Buffer.from(semanticText, "utf8")),
  };
  const metadata = {
    final_url: url,
    page_title: "Official guidance",
    status_code: 200,
    status_text: "OK",
    content_type: "application/pdf",
    text_length: semanticText.length,
    text_object_bytes: text.length,
    file_bytes: pdf.length,
    page_count: 1,
    pdf_text_error: null,
  };
  const meta = Buffer.from(JSON.stringify({
    version: 1,
    kind: "pdf",
    source: { id: sourceId, shared_award_id: awardId, url },
    captured_at: capturedAt,
    final_url: url,
    page_title: "Official guidance",
    status_code: 200,
    status_text: "OK",
    content_type: "application/pdf",
    file_hash: hashes.file_hash,
    text_hash: hashes.text_hash,
    text_length: semanticText.length,
    file_bytes: pdf.length,
    page_count: 1,
    pdf_text_error: null,
  }), "utf8");
  const prefix = `visual-snapshots/sources/${sourceId}/latest`;
  const objectKeys = {
    pdf: `${prefix}/document.pdf`,
    text: `${prefix}/text.txt`,
    meta: `${prefix}/meta.json`,
  };
  const objects = new Map([
    [objectKeys.pdf, objectRecord(pdf, "application/pdf")],
    [objectKeys.text, objectRecord(text, "text/plain")],
    [objectKeys.meta, objectRecord(meta, "application/json")],
  ]);
  applyArtifactBindings(metadata, objectKeys, objects);
  return {
    source: { ...sourceRow(), url },
    row: {
      shared_award_source_id: sourceId,
      shared_award_id: awardId,
      source_url: url,
      source_title: "Official guidance",
      source_page_type: "guidance",
      kind: "pdf",
      bucket,
      latest_captured_at: capturedAt,
      latest_object_keys: objectKeys,
      latest_hashes: hashes,
      latest_metadata: metadata,
      previous_captured_at: null,
      previous_object_keys: {},
      previous_hashes: {},
      previous_metadata: {},
      updated_at: "2026-07-03T12:00:01.000Z",
    },
    objects,
  };
}

function geometryReference(layout, layoutRef) {
  return {
    version: layout.version,
    status: "ready",
    unavailable_reason: null,
    geometry_hash: layout.geometry_hash,
    coordinate_space: layout.coordinate_space,
    node_count: layout.node_count,
    run_count: layout.run_count,
    document: layout.document,
    viewport: layout.viewport,
    screenshot: layout.screenshot,
    file: layoutRef,
  };
}

function boundGeometry({ stateId, capturedAt, imageHash, imageRef }) {
  return bindVisualTextGeometry({
    version: 1,
    state_id: stateId,
    captured_at: capturedAt,
    coordinate_space: "document-css-pixels",
    document: { width: 1_000, height: 2_000 },
    viewport: { width: 1_000, height: 800 },
    scroll: { x: 0, y: 0 },
    device_pixel_ratio: 1,
    nodes: [{
      order: 0,
      path: "html/body/main/p",
      flow_path: "html/body/main/p",
      text: "Eligibility wording",
      separator_before: "",
      rects: [{ x: 20, y: 40, width: 200, height: 24 }],
      runs: [{
        start: 0,
        end: 19,
        text: "Eligibility wording",
        rects: [{ x: 20, y: 40, width: 200, height: 24 }],
      }],
    }],
  }, {
    capturedAt,
    imageHash,
    imageRef,
    screenshot: {
      css_width: 1_000,
      css_height: 2_000,
      pixel_width: 1_000,
      pixel_height: 2_000,
      alignment_status: "verified",
    },
  });
}

function addMainLayoutEvidence(value) {
  const generation = value.latest;
  const pageRef = `sources/${sourceId}/captures/latest/page.jpg`;
  const layoutRef = `sources/${sourceId}/captures/latest/layout.json`;
  const layout = boundGeometry({
    stateId: "main",
    capturedAt: generation.capturedAt,
    imageHash: generation.hashes.image_hash,
    imageRef: pageRef,
  });
  const layoutBody = Buffer.from(JSON.stringify(layout), "utf8");
  const layoutKey = `visual-snapshots/sources/${sourceId}/latest/layout.json`;
  value.row.latest_object_keys.layout = layoutKey;
  value.row.latest_hashes.layout_hash = layout.geometry_hash;
  value.row.latest_metadata.layout_hash = layout.geometry_hash;
  value.row.latest_metadata.text_geometry = geometryReference(layout, layoutRef);
  value.row.latest_metadata.localization = {
    status: "geometry_ready",
    accounted_for: true,
    geometry_ready: true,
    geometry_hash: layout.geometry_hash,
    bound_image_hash: generation.hashes.image_hash,
    semantic_crop_contract: "visual-exact-text-binding-v2",
    captured_at: generation.capturedAt,
  };
  value.objects.set(layoutKey, objectRecord(layoutBody, "application/json; charset=utf-8"));

  const metaRecord = value.objects.get(generation.objectKeys.meta);
  const meta = JSON.parse(metaRecord.body.toString("utf8"));
  meta.layout_hash = layout.geometry_hash;
  meta.text_geometry = geometryReference(layout, layoutRef);
  meta.localization = structuredClone(value.row.latest_metadata.localization);
  meta.files = { ...(meta.files || {}), page: pageRef, layout: layoutRef };
  value.objects.set(
    generation.objectKeys.meta,
    objectRecord(Buffer.from(JSON.stringify(meta), "utf8"), "application/json; charset=utf-8"),
  );
  applyArtifactBindings(value.row.latest_metadata, value.row.latest_object_keys, value.objects);
  return { layout, pageRef, layoutRef };
}

function addExpansionStateEvidence(value) {
  addMainLayoutEvidence(value);
  const generation = value.latest;
  const suffix = "01";
  const stateId = `expansion-state-${suffix}`;
  const page = Buffer.from("opened eligibility accordion screenshot", "utf8");
  const imageHash = sha256(page);
  const stateCapturedAt = new Date(Date.parse(generation.capturedAt) + 1_000).toISOString();
  const pageRef = `sources/${sourceId}/captures/latest/expansion-state-${suffix}.jpg`;
  const layoutRef = `sources/${sourceId}/captures/latest/expansion-state-${suffix}-layout.json`;
  const layout = boundGeometry({
    stateId,
    capturedAt: stateCapturedAt,
    imageHash,
    imageRef: pageRef,
  });
  const pageKey = `visual-snapshots/sources/${sourceId}/latest/expansion-state-${suffix}.jpg`;
  const layoutKey =
    `visual-snapshots/sources/${sourceId}/latest/expansion-state-${suffix}-layout.json`;
  const semanticText = "Opened eligibility wording";
  const textHash = sha256(Buffer.from(semanticText, "utf8"));
  const pointerState = {
    state_id: stateId,
    label: "Eligibility",
    image_hash: imageHash,
    layout_hash: layout.geometry_hash,
    text_geometry: geometryReference(layout, layoutRef),
    text_hash: textHash,
    text_length: semanticText.length,
    page_bytes: page.length,
    isolation: null,
  };
  const rawState = {
    ...structuredClone(pointerState),
    index: 0,
    page: pageRef,
    layout: layoutRef,
    captured_at: stateCapturedAt,
  };
  value.row.latest_object_keys.expansion_state_01 = pageKey;
  value.row.latest_object_keys.expansion_state_01_layout = layoutKey;
  value.row.latest_metadata.expansion_state_count = 1;
  value.row.latest_metadata.expansion_state_screenshots = [pointerState];
  value.objects.set(pageKey, objectRecord(page, "image/jpeg"));
  value.objects.set(
    layoutKey,
    objectRecord(Buffer.from(JSON.stringify(layout), "utf8"), "application/json; charset=utf-8"),
  );
  const metaRecord = value.objects.get(generation.objectKeys.meta);
  const meta = JSON.parse(metaRecord.body.toString("utf8"));
  meta.expansion_state_count = 1;
  meta.expansion_state_screenshots = [rawState];
  meta.files = {
    ...(meta.files || {}),
    expansion_states: [{ state_id: stateId, label: "Eligibility", page: pageRef, layout: layoutRef }],
  };
  value.objects.set(
    generation.objectKeys.meta,
    objectRecord(Buffer.from(JSON.stringify(meta), "utf8"), "application/json; charset=utf-8"),
  );
  applyArtifactBindings(value.row.latest_metadata, value.row.latest_object_keys, value.objects);
  return { pageKey, layoutKey, layout, pointerState, rawState };
}

function removeMainLayoutEvidence(value) {
  const generation = value.latest;
  const mainLayoutKey = generation.objectKeys.layout;
  const unavailable = {
    status: "evidence_only_geometry_unavailable",
    geometry_ready: false,
    accounted_for: true,
    unavailable_reason: "legacy_no_retained_main_geometry",
  };
  delete generation.objectKeys.layout;
  delete generation.hashes.layout_hash;
  delete generation.metadata.layout_hash;
  delete generation.metadata.text_geometry;
  generation.metadata.localization = structuredClone(unavailable);
  value.objects.delete(mainLayoutKey);

  const metaRecord = value.objects.get(generation.objectKeys.meta);
  const meta = JSON.parse(metaRecord.body.toString("utf8"));
  delete meta.layout_hash;
  delete meta.text_geometry;
  meta.localization = structuredClone(unavailable);
  if (meta.files) delete meta.files.layout;
  value.objects.set(
    generation.objectKeys.meta,
    objectRecord(Buffer.from(JSON.stringify(meta), "utf8"), "application/json; charset=utf-8"),
  );
  applyArtifactBindings(generation.metadata, generation.objectKeys, value.objects);
}

function fakeObjectStore(initialObjects) {
  const objects = new Map(
    [...initialObjects].map(([key, value]) => [key, objectRecord(value.body, value.contentType, {
      metadata: value.metadata,
      checksumSha256: value.checksumSha256,
    })]),
  );
  const puts = [];
  return {
    bucket,
    objects,
    puts,
    async readObject({ key }) {
      const value = objects.get(key);
      if (!value) {
        const error = new Error(`Missing object ${key}`);
        error.code = "r2_object_missing";
        throw error;
      }
      return {
        key,
        body: Buffer.from(value.body),
        byte_length: value.body.length,
        content_type: value.contentType,
        etag: `"${md5(value.body)}"`,
        metadata: { ...value.metadata },
        checksum_sha256: value.checksumSha256,
      };
    },
    async putObjectIfAbsent({ key, body, contentType, sha256: expectedSha256 }) {
      puts.push({ key, body: Buffer.from(body), contentType, sha256: expectedSha256 });
      if (objects.has(key)) return { created: false };
      objects.set(key, objectRecord(body, contentType, {
        metadata: { sha256: expectedSha256 },
        checksumSha256: Buffer.from(expectedSha256, "hex").toString("base64"),
      }));
      return { created: true };
    },
    seedImmutable(key, body, contentType) {
      const hash = sha256(body);
      objects.set(key, objectRecord(body, contentType, {
        metadata: { sha256: hash },
        checksumSha256: Buffer.from(hash, "hex").toString("base64"),
      }));
    },
  };
}

async function inspectedFixture() {
  const value = fixture();
  const objectStore = fakeObjectStore(value.objects);
  const inspected = await inspectLegacyR2SnapshotPointer({
    row: value.row,
    source: value.source,
    objectStore,
  });
  return { ...value, objectStore, inspected };
}

describe("legacy R2 snapshot pointer inspection", () => {
  it("uses the normal uploader's deterministic capture-version formula", () => {
    const { latest } = fixture();
    const normalizedHashes = {
      image_hash: latest.hashes.image_hash,
      text_hash: latest.hashes.text_hash,
      body_text_hash: null,
      main_content_hash: null,
      nav_header_footer_hash: null,
      expansion_hash: null,
      layout_hash: null,
      file_hash: null,
    };
    const expected = sha256(JSON.stringify({
      captured_at: latest.capturedAt,
      hashes: normalizedHashes,
    })).slice(0, 32);

    expect(legacyR2CaptureVersion({
      capturedAt: latest.capturedAt,
      hashes: latest.hashes,
    })).toBe(expected);
  });

  it("binds latest and previous bytes to source, metadata, hashes, lengths, and immutable keys", async () => {
    const { inspected, latest, previous } = await inspectedFixture();

    expect(inspected.item.action).toBe("migrate");
    expect(inspected.item.generations.latest.state).toBe("migrate_legacy_mutable");
    expect(inspected.item.generations.previous.state).toBe("migrate_legacy_mutable");
    expect(inspected.item.generations.latest.localization_status).toBe(
      "evidence_only_geometry_unavailable",
    );
    expect(inspected.item.generations.latest.artifacts).toHaveLength(4);
    expect(inspected.item.generations.previous.artifacts).toHaveLength(4);
    expect(inspected.item.next_object_keys.latest.page).toMatch(
      new RegExp(`^visual-snapshots/sources/${sourceId}/captures/[a-f0-9]{32}/page\\.jpg$`, "u"),
    );
    expect(inspected.bodies.get(latest.objectKeys.text)).toEqual(latest.text);
    expect(inspected.bodies.get(previous.objectKeys.text)).toEqual(previous.text);
    expect(inspected.item.next_metadata.latest).not.toHaveProperty(
      "expansion_state_capture_coverage",
    );
    expect(inspected.item.safety).toMatchObject({
      legacy_objects_deleted: false,
      events_written: false,
      live_fetch_performed: false,
      baseline_refreshed: false,
      paid_api_calls: 0,
    });
  });

  it("backfills scalar-only history as conservative coverage and never promotes it complete", async () => {
    const value = fixture();
    const metaKey = value.latest.objectKeys.meta;
    const rawMeta = JSON.parse(value.objects.get(metaKey).body.toString("utf8"));
    Object.assign(rawMeta, {
      expansion_state_candidates: 0,
      expansion_state_attempted: 0,
      expansion_state_capture_limit: 24,
      expansion_state_capture_complete: true,
      expansion_state_capture_status: "verified_complete",
      expansion_state_raw_candidates: 0,
      expansion_state_candidate_count_exact: true,
      expansion_state_truncated: false,
      expansion_state_truncated_count: 0,
      expansion_state_truncated_count_exact: true,
      expansion_state_failures: [],
      expansion_state_count: 0,
      expansion_state_screenshots: [],
    });
    value.objects.set(
      metaKey,
      objectRecord(
        Buffer.from(JSON.stringify(rawMeta), "utf8"),
        "application/json; charset=utf-8",
      ),
    );
    applyArtifactBindings(value.row.latest_metadata, value.latest.objectKeys, value.objects);

    const inspected = await inspectLegacyR2SnapshotPointer({
      row: value.row,
      source: value.source,
      objectStore: fakeObjectStore(value.objects),
    });
    expect(inspected.item.next_metadata.latest.expansion_state_capture_coverage)
      .toMatchObject({
        complete: false,
        status: "incomplete_discovery",
        raw_candidate_count_exact: false,
        logical_candidate_count_exact: false,
        retained_state_count: 0,
      });

    const legacyV0 = fixture();
    const legacyV0Key = legacyV0.latest.objectKeys.meta;
    const legacyV0Meta = JSON.parse(
      legacyV0.objects.get(legacyV0Key).body.toString("utf8"),
    );
    Object.assign(legacyV0Meta, {
      expansion_state_candidates: 0,
      expansion_state_attempted: 0,
      expansion_state_capture_limit: 24,
      expansion_state_capture_complete: true,
      expansion_state_truncated: false,
      expansion_state_truncated_count: 0,
      expansion_state_failures: [],
      expansion_state_count: 0,
      expansion_state_screenshots: [],
    });
    legacyV0.objects.set(
      legacyV0Key,
      objectRecord(
        Buffer.from(JSON.stringify(legacyV0Meta), "utf8"),
        "application/json; charset=utf-8",
      ),
    );
    applyArtifactBindings(
      legacyV0.row.latest_metadata,
      legacyV0.latest.objectKeys,
      legacyV0.objects,
    );
    const v0Inspected = await inspectLegacyR2SnapshotPointer({
      row: legacyV0.row,
      source: legacyV0.source,
      objectStore: fakeObjectStore(legacyV0.objects),
    });
    expect(v0Inspected.item.next_metadata.latest.expansion_state_capture_coverage)
      .toMatchObject({
        complete: false,
        status: "incomplete_discovery",
        retained_state_count: 0,
      });

    const incompleteProof = fixture();
    const incompleteKey = incompleteProof.latest.objectKeys.meta;
    const incompleteMeta = JSON.parse(
      incompleteProof.objects.get(incompleteKey).body.toString("utf8"),
    );
    incompleteMeta.expansion_state_count = 0;
    incompleteMeta.expansion_state_screenshots = [];
    incompleteProof.objects.set(
      incompleteKey,
      objectRecord(
        Buffer.from(JSON.stringify(incompleteMeta), "utf8"),
        "application/json; charset=utf-8",
      ),
    );
    applyArtifactBindings(
      incompleteProof.row.latest_metadata,
      incompleteProof.latest.objectKeys,
      incompleteProof.objects,
    );
    const withoutProof = await inspectLegacyR2SnapshotPointer({
      row: incompleteProof.row,
      source: incompleteProof.source,
      objectStore: fakeObjectStore(incompleteProof.objects),
    });
    expect(withoutProof.item.next_metadata.latest).not.toHaveProperty(
      "expansion_state_capture_coverage",
    );
  });

  it.each([
    ["malformed nested coverage", (meta) => {
      meta.expansion_state_capture_coverage = {
        schema: "awardping.expansion-state-capture-coverage.v1",
        complete: "true",
      };
    }],
    ["a partial scalar coverage claim", (meta) => {
      meta.expansion_state_capture_status = "verified_complete";
    }],
  ])("quarantines %s instead of preserving it as absent", async (_name, mutate) => {
    const value = fixture();
    const metaKey = value.latest.objectKeys.meta;
    const rawMeta = JSON.parse(value.objects.get(metaKey).body.toString("utf8"));
    mutate(rawMeta);
    value.objects.set(
      metaKey,
      objectRecord(
        Buffer.from(JSON.stringify(rawMeta), "utf8"),
        "application/json; charset=utf-8",
      ),
    );
    applyArtifactBindings(value.row.latest_metadata, value.latest.objectKeys, value.objects);

    await expect(inspectLegacyR2SnapshotPointer({
      row: value.row,
      source: value.source,
      objectStore: fakeObjectStore(value.objects),
    })).rejects.toMatchObject({ code: "r2_expansion_coverage_source_invalid" });
  });

  it("migrates exact retained PDF evidence without introducing webpage artifacts", async () => {
    const value = pdfFixture();
    const inspected = await inspectLegacyR2SnapshotPointer({
      row: value.row,
      source: value.source,
      objectStore: fakeObjectStore(value.objects),
    });

    expect(inspected.item.action).toBe("migrate");
    expect(inspected.item.generations.latest.artifacts.map((entry) => entry.slot)).toEqual([
      "meta",
      "pdf",
      "text",
    ]);
    expect(inspected.item.next_object_keys.latest.pdf).toMatch(/\/captures\/[a-f0-9]{32}\/document\.pdf$/u);
    expect(inspected.item.next_metadata.latest).toEqual(value.row.latest_metadata);

    const expansionPdf = pdfFixture();
    const expansionPageKey =
      `visual-snapshots/sources/${sourceId}/latest/expansion-state-01.jpg`;
    const expansionLayoutKey =
      `visual-snapshots/sources/${sourceId}/latest/expansion-state-01-layout.json`;
    expansionPdf.row.latest_object_keys.expansion_state_01 = expansionPageKey;
    expansionPdf.row.latest_object_keys.expansion_state_01_layout = expansionLayoutKey;
    expansionPdf.objects.set(expansionPageKey, objectRecord(Buffer.from("page"), "image/jpeg"));
    expansionPdf.objects.set(
      expansionLayoutKey,
      objectRecord(Buffer.from("{}"), "application/json; charset=utf-8"),
    );
    await expect(inspectLegacyR2SnapshotPointer({
      row: expansionPdf.row,
      source: expansionPdf.source,
      objectStore: fakeObjectStore(expansionPdf.objects),
    })).rejects.toMatchObject({ code: "generation_kind_ambiguous" });
  });

  it("derives only an absent raw text-object binding and rejects malformed or wrong values", async () => {
    const missing = fixture();
    const expectedLatestArtifactBindings = structuredClone(
      missing.row.latest_metadata.artifact_bindings,
    );
    delete missing.row.latest_metadata.text_object_bytes;
    delete missing.row.latest_metadata.artifact_bindings_schema;
    delete missing.row.latest_metadata.artifact_bindings;
    delete missing.row.latest_metadata.expansion_state_count;
    delete missing.row.latest_metadata.expansion_state_screenshots;
    delete missing.row.latest_metadata.localization;
    const derived = await inspectLegacyR2SnapshotPointer({
      row: missing.row,
      source: missing.source,
      objectStore: fakeObjectStore(missing.objects),
    });
    expect(derived.item.metadata_fields_to_update).toEqual(["latest_metadata"]);
    expect(derived.item.generations.latest.metadata_before).not.toHaveProperty("text_object_bytes");
    expect(derived.item.generations.latest.metadata_after).toEqual({
      ...missing.row.latest_metadata,
      text_object_bytes: missing.latest.text.length,
      artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
      artifact_bindings: expectedLatestArtifactBindings,
      expansion_state_count: 0,
      expansion_state_screenshots: [],
      localization: {
        status: "evidence_only_geometry_unavailable",
        geometry_ready: false,
        accounted_for: true,
        unavailable_reason: "legacy_no_retained_geometry",
      },
    });
    expect(derived.item.generations.previous.metadata_after).toEqual(
      missing.row.previous_metadata,
    );
    const plan = buildLegacyR2PointerMigrationPlan({
      items: [derived.item],
      selector: { mode: "exact_allowlist", source_ids: [sourceId], source_count: 1 },
      builtAt,
    });
    expect(assertLegacyR2PointerMigrationPlan(
      plan,
      plan.confirmation.plan_sha256,
      { now: "2026-08-10T16:00:00.000Z" },
    ).items[0].generations.latest.metadata_added_paths).toEqual([
      "artifact_bindings",
      "artifact_bindings_schema",
      "expansion_state_count",
      "expansion_state_screenshots",
      "localization",
      "text_object_bytes",
    ]);

    const malformed = fixture();
    malformed.row.latest_metadata.text_object_bytes = null;
    await expect(inspectLegacyR2SnapshotPointer({
      row: malformed.row,
      source: malformed.source,
      objectStore: fakeObjectStore(malformed.objects),
    })).rejects.toMatchObject({ code: "r2_text_object_bytes_binding_malformed" });

    const stringTypedLength = fixture();
    stringTypedLength.row.latest_metadata.text_length =
      String(stringTypedLength.row.latest_metadata.text_length);
    await expect(inspectLegacyR2SnapshotPointer({
      row: stringTypedLength.row,
      source: stringTypedLength.source,
      objectStore: fakeObjectStore(stringTypedLength.objects),
    })).rejects.toMatchObject({ code: "r2_length_binding_missing" });

    const mismatch = fixture();
    mismatch.row.latest_metadata.text_object_bytes += 1;
    await expect(inspectLegacyR2SnapshotPointer({
      row: mismatch.row,
      source: mismatch.source,
      objectStore: fakeObjectStore(mismatch.objects),
    })).rejects.toMatchObject({ code: "r2_text_object_bytes_binding_mismatch" });

    const conflictingLocalization = fixture();
    conflictingLocalization.row.latest_metadata.localization = {
      status: "metadata_missing",
      geometry_ready: false,
      accounted_for: false,
    };
    await expect(inspectLegacyR2SnapshotPointer({
      row: conflictingLocalization.row,
      source: conflictingLocalization.source,
      objectStore: fakeObjectStore(conflictingLocalization.objects),
    })).rejects.toMatchObject({ code: "r2_no_layout_localization_conflict" });

    const contradictoryReadyLocalization = fixture();
    contradictoryReadyLocalization.row.latest_metadata.localization = {
      status: "ready",
      geometry_ready: false,
      accounted_for: true,
      unavailable_reason: "claimed unavailable despite ready status",
    };
    await expect(inspectLegacyR2SnapshotPointer({
      row: contradictoryReadyLocalization.row,
      source: contradictoryReadyLocalization.source,
      objectStore: fakeObjectStore(contradictoryReadyLocalization.objects),
    })).rejects.toMatchObject({ code: "r2_no_layout_localization_conflict" });

    const bindingMismatch = fixture();
    bindingMismatch.row.latest_metadata.artifact_bindings.page.sha256 = "f".repeat(64);
    await expect(inspectLegacyR2SnapshotPointer({
      row: bindingMismatch.row,
      source: bindingMismatch.source,
      objectStore: fakeObjectStore(bindingMismatch.objects),
    })).rejects.toMatchObject({ code: "r2_artifact_bindings_mismatch" });

    const schemaMismatch = fixture();
    schemaMismatch.row.latest_metadata.artifact_bindings_schema = "unsupported.v0";
    await expect(inspectLegacyR2SnapshotPointer({
      row: schemaMismatch.row,
      source: schemaMismatch.source,
      objectStore: fakeObjectStore(schemaMismatch.objects),
    })).rejects.toMatchObject({ code: "r2_artifact_bindings_schema_mismatch" });
  });

  it("rejects mixed mutable/immutable generations without reading or changing R2", async () => {
    const value = fixture();
    value.row.latest_object_keys.meta =
      `visual-snapshots/sources/${sourceId}/captures/${"a".repeat(32)}/meta.json`;
    const readObject = vi.fn();

    await expect(inspectLegacyR2SnapshotPointer({
      row: value.row,
      source: value.source,
      objectStore: { bucket, readObject },
    })).rejects.toMatchObject({ code: "generation_mixed_legacy_immutable" });
    expect(readObject).not.toHaveBeenCalled();
  });

  it("refuses to verify coincident keys through a differently named bucket", async () => {
    const value = fixture();
    const objectStore = fakeObjectStore(value.objects);
    objectStore.bucket = "not-the-pointer-bucket";

    await expect(inspectLegacyR2SnapshotPointer({
      row: value.row,
      source: value.source,
      objectStore,
    })).rejects.toMatchObject({ code: "snapshot_bucket_mismatch" });
  });

  it("preserves case-sensitive path and query identity while normalizing host and fragment", async () => {
    const value = fixture();
    value.source.url = "HTTPS://WWW.MARSHALLSCHOLARSHIP.ORG/apply/FAQs/#operator-note";

    await expect(inspectLegacyR2SnapshotPointer({
      row: value.row,
      source: value.source,
      objectStore: fakeObjectStore(value.objects),
    })).rejects.toMatchObject({ code: "source_url_mismatch" });

    value.source.url = "https://www.marshallscholarship.org/apply/faqs/?Token=ABC";
    await expect(inspectLegacyR2SnapshotPointer({
      row: value.row,
      source: value.source,
      objectStore: fakeObjectStore(value.objects),
    })).rejects.toMatchObject({ code: "source_url_mismatch" });
  });

  it("rejects a malformed retained checksum instead of treating it as absent", async () => {
    const value = fixture();
    value.objects.get(value.latest.objectKeys.page).checksumSha256 = "not-a-sha256-checksum";

    await expect(inspectLegacyR2SnapshotPointer({
      row: value.row,
      source: value.source,
      objectStore: fakeObjectStore(value.objects),
    })).rejects.toMatchObject({ code: "r2_object_checksum_invalid" });
  });

  it("verifies complete main and opened-expansion geometry bindings", async () => {
    const value = fixture();
    addExpansionStateEvidence(value);

    const inspected = await inspectLegacyR2SnapshotPointer({
      row: value.row,
      source: value.source,
      objectStore: fakeObjectStore(value.objects),
    });

    expect(inspected.item.generations.latest.artifacts.map((entry) => entry.slot)).toEqual([
      "expansion_state_01",
      "expansion_state_01_layout",
      "layout",
      "meta",
      "page",
      "text",
      "thumb",
    ]);
    expect(Object.keys(inspected.item.next_metadata.latest.artifact_bindings).sort()).toEqual([
      "expansion_state_01",
      "expansion_state_01_layout",
      "layout",
      "meta",
      "page",
      "text",
      "thumb",
    ]);
    expect(
      inspected.item.next_metadata.latest.artifact_bindings.expansion_state_01_layout,
    ).toMatchObject({
      content_type: "application/json; charset=utf-8",
      hash_mode: "raw_sha256",
    });
    expect(inspected.item.generations.latest.metadata_enriched).toBe(false);
  });

  it("quarantines incomplete or conflicting main/expansion evidence claims", async () => {
    const mainKeyOnly = fixture();
    const layoutKey = `visual-snapshots/sources/${sourceId}/latest/layout.json`;
    mainKeyOnly.row.latest_object_keys.layout = layoutKey;
    mainKeyOnly.objects.set(layoutKey, objectRecord(Buffer.from("{}"), "application/json"));
    await expect(inspectLegacyR2SnapshotPointer({
      row: mainKeyOnly.row,
      source: mainKeyOnly.source,
      objectStore: fakeObjectStore(mainKeyOnly.objects),
    })).rejects.toMatchObject({ code: "sha256_missing" });

    const incomplete = fixture();
    const expansionPageKey =
      `visual-snapshots/sources/${sourceId}/latest/expansion-state-01.jpg`;
    incomplete.row.latest_object_keys.expansion_state_01 = expansionPageKey;
    incomplete.objects.set(expansionPageKey, objectRecord(Buffer.from("page"), "image/jpeg"));
    await expect(inspectLegacyR2SnapshotPointer({
      row: incomplete.row,
      source: incomplete.source,
      objectStore: fakeObjectStore(incomplete.objects),
    })).rejects.toMatchObject({ code: "r2_expansion_pair_incomplete" });

    const expansionWithoutMain = fixture();
    addExpansionStateEvidence(expansionWithoutMain);
    removeMainLayoutEvidence(expansionWithoutMain);
    await expect(inspectLegacyR2SnapshotPointer({
      row: expansionWithoutMain.row,
      source: expansionWithoutMain.source,
      objectStore: fakeObjectStore(expansionWithoutMain.objects),
    })).rejects.toMatchObject({ code: "r2_expansion_main_layout_missing" });

    const invalidUnavailableGeometry = fixture();
    invalidUnavailableGeometry.row.latest_metadata.text_geometry = { status: "ready" };
    await expect(inspectLegacyR2SnapshotPointer({
      row: invalidUnavailableGeometry.row,
      source: invalidUnavailableGeometry.source,
      objectStore: fakeObjectStore(invalidUnavailableGeometry.objects),
    })).rejects.toMatchObject({ code: "r2_no_layout_text_geometry_conflict" });

    const malformedNoLayoutHash = fixture();
    malformedNoLayoutHash.row.latest_metadata.localization.geometry_hash = 0;
    await expect(inspectLegacyR2SnapshotPointer({
      row: malformedNoLayoutHash.row,
      source: malformedNoLayoutHash.source,
      objectStore: fakeObjectStore(malformedNoLayoutHash.objects),
    })).rejects.toMatchObject({ code: "r2_main_layout_object_missing" });

    const mainClaim = fixture();
    addMainLayoutEvidence(mainClaim);
    delete mainClaim.row.latest_metadata.localization.geometry_hash;
    await expect(inspectLegacyR2SnapshotPointer({
      row: mainClaim.row,
      source: mainClaim.source,
      objectStore: fakeObjectStore(mainClaim.objects),
    })).rejects.toMatchObject({ code: "sha256_missing" });

    const contradictoryMainStatus = fixture();
    addMainLayoutEvidence(contradictoryMainStatus);
    contradictoryMainStatus.row.latest_metadata.localization.status = "unavailable";
    await expect(inspectLegacyR2SnapshotPointer({
      row: contradictoryMainStatus.row,
      source: contradictoryMainStatus.source,
      objectStore: fakeObjectStore(contradictoryMainStatus.objects),
    })).rejects.toMatchObject({ code: "r2_main_layout_localization_binding_invalid" });

    const malformedMainUnavailableReason = fixture();
    addMainLayoutEvidence(malformedMainUnavailableReason);
    malformedMainUnavailableReason.row.latest_metadata.localization.unavailable_reason = {};
    await expect(inspectLegacyR2SnapshotPointer({
      row: malformedMainUnavailableReason.row,
      source: malformedMainUnavailableReason.source,
      objectStore: fakeObjectStore(malformedMainUnavailableReason.objects),
    })).rejects.toMatchObject({ code: "r2_main_layout_localization_binding_invalid" });

    const expansionClaim = fixture();
    addExpansionStateEvidence(expansionClaim);
    expansionClaim.row.latest_metadata.expansion_state_screenshots[0].page_bytes += 1;
    await expect(inspectLegacyR2SnapshotPointer({
      row: expansionClaim.row,
      source: expansionClaim.source,
      objectStore: fakeObjectStore(expansionClaim.objects),
    })).rejects.toMatchObject({ code: "r2_positive_length_claim_mismatch" });

    const isolationClaim = fixture();
    addExpansionStateEvidence(isolationClaim);
    isolationClaim.row.latest_metadata.expansion_state_screenshots[0].isolation = {
      verified: true,
    };
    await expect(inspectLegacyR2SnapshotPointer({
      row: isolationClaim.row,
      source: isolationClaim.source,
      objectStore: fakeObjectStore(isolationClaim.objects),
    })).rejects.toMatchObject({ code: "r2_expansion_isolation_mismatch" });
  });

  it("does not label the legacy approved family Stage1-immutable", async () => {
    const value = fixture();
    const version = "a".repeat(32);
    value.row.latest_object_keys = Object.fromEntries(
      Object.entries(value.row.latest_object_keys).map(([slot, key]) => [
        slot,
        key.replace("/latest/", `/approved/${version}/`),
      ]),
    );
    const readObject = vi.fn();

    await expect(inspectLegacyR2SnapshotPointer({
      row: value.row,
      source: value.source,
      objectStore: { bucket, readObject },
    })).rejects.toMatchObject({ code: "object_key_approved_family_not_stage1" });
    expect(readObject).not.toHaveBeenCalled();
  });
});

describe("reviewed migration plans", () => {
  it("requires the exact untampered, unexpired plan hash", async () => {
    const { inspected } = await inspectedFixture();
    const plan = buildLegacyR2PointerMigrationPlan({
      items: [inspected.item],
      selector: { mode: "exact_allowlist", source_ids: [sourceId], source_count: 1 },
      builtAt,
      ttlMs: 2 * 60 * 60 * 1000,
    });

    expect(assertLegacyR2PointerMigrationPlan(
      plan,
      plan.confirmation.plan_sha256,
      { now: "2026-08-10T16:00:00.000Z" },
    )).toEqual(plan);
    expect(() => assertLegacyR2PointerMigrationPlan(
      plan,
      "0".repeat(64),
      { now: "2026-08-10T16:00:00.000Z" },
    )).toThrow(/exact immutable plan hash/iu);

    const tampered = structuredClone(plan);
    tampered.items[0].source_url = "https://attacker.invalid/";
    expect(() => assertLegacyR2PointerMigrationPlan(
      tampered,
      plan.confirmation.plan_sha256,
      { now: "2026-08-10T16:00:00.000Z" },
    )).toThrow(/changed after review/iu);
    expect(() => assertLegacyR2PointerMigrationPlan(
      plan,
      plan.confirmation.plan_sha256,
      { now: "2026-08-10T18:00:00.001Z" },
    )).toThrow(/expired/iu);
  });

  it("does not persist a reviewed quarantine after pointer/source state changes", () => {
    const value = fixture();
    const item = blockedLegacyR2MigrationItem({
      sourceId,
      source: value.source,
      row: value.row,
      error: Object.assign(new Error("mixed evidence"), { code: "mixed_evidence" }),
    });
    expect(assertReviewedQuarantinePrecondition(item, {
      row: value.row,
      source: value.source,
    })).toBe(true);
    expect(() => assertReviewedQuarantinePrecondition(item, {
      row: { ...value.row, updated_at: "2026-08-10T15:00:00.000Z" },
      source: value.source,
    })).toThrow(/rebuild the dry-run/iu);
    expect(() => assertReviewedQuarantinePrecondition(item, {
      row: value.row,
      source: { ...value.source, admin_review_status: "open" },
    })).toThrow(/rebuild the dry-run/iu);

    const missingPointer = blockedLegacyR2MigrationItem({
      sourceId,
      source: value.source,
      row: null,
      error: new Error("pointer missing"),
    });
    expect(assertReviewedQuarantinePrecondition(missingPointer, {
      row: null,
      source: value.source,
    })).toBe(true);
    expect(() => assertReviewedQuarantinePrecondition(missingPointer, {
      row: value.row,
      source: value.source,
    })).toThrow(/presence changed/iu);
  });
});

describe("legacy R2 snapshot pointer apply", () => {
  it("copies exact bytes once, verifies destinations, and CAS-updates only reviewed pointer fields", async () => {
    const { inspected, row, source, objectStore } = await inspectedFixture();
    let current = structuredClone(row);
    const compareAndSetObjectKeys = vi.fn(async (input) => {
      expect(Object.keys(input).sort()).toEqual([
        "expectedUpdatedAt",
        "latestObjectKeys",
        "metadataUpdates",
        "previousObjectKeys",
        "sourceId",
      ]);
      expect(input.expectedUpdatedAt).toBe(row.updated_at);
      expect(input.metadataUpdates).toEqual({});
      current = {
        ...current,
        latest_object_keys: structuredClone(input.latestObjectKeys),
        previous_object_keys: structuredClone(input.previousObjectKeys),
        updated_at: "2026-08-10T15:05:00.000Z",
      };
      return { advanced: true, row: current };
    });
    const loadCurrentRow = vi.fn(async () => current);

    const receipt = await applyLegacyR2SnapshotPointerItem({
      planItem: inspected.item,
      currentRow: current,
      source,
      objectStore,
      compareAndSetObjectKeys,
      loadCurrentRow,
      now: "2026-08-10T15:05:01.000Z",
    });

    expect(receipt.status).toBe("applied");
    expect(receipt.immutable_objects_uploaded).toBe(8);
    expect(objectStore.puts).toHaveLength(8);
    expect(compareAndSetObjectKeys).toHaveBeenCalledTimes(1);
    for (const put of objectStore.puts) {
      expect(sha256Bytes(put.body)).toBe(put.sha256);
      expect(put.key).toContain(`/sources/${sourceId}/captures/`);
    }

    const putsAfterFirstApply = objectStore.puts.length;
    const second = await applyLegacyR2SnapshotPointerItem({
      planItem: inspected.item,
      currentRow: current,
      source,
      objectStore,
      compareAndSetObjectKeys,
      loadCurrentRow,
      now: "2026-08-10T15:06:00.000Z",
    });
    expect(second.status).toBe("already_applied");
    expect(objectStore.puts).toHaveLength(putsAfterFirstApply);
    expect(compareAndSetObjectKeys).toHaveBeenCalledTimes(1);
  });

  it("CAS-adds only verified text bytes and truthful no-layout accounting, idempotently", async () => {
    const value = fixture();
    const expectedLatestArtifactBindings = structuredClone(value.row.latest_metadata.artifact_bindings);
    const expectedPreviousArtifactBindings = structuredClone(value.row.previous_metadata.artifact_bindings);
    delete value.row.latest_metadata.text_object_bytes;
    delete value.row.previous_metadata.text_object_bytes;
    for (const metadata of [value.row.latest_metadata, value.row.previous_metadata]) {
      delete metadata.expansion_state_count;
      delete metadata.expansion_state_screenshots;
      delete metadata.localization;
      delete metadata.artifact_bindings_schema;
      delete metadata.artifact_bindings;
    }
    const objectStore = fakeObjectStore(value.objects);
    const inspected = await inspectLegacyR2SnapshotPointer({
      row: value.row,
      source: value.source,
      objectStore,
    });
    const originalLatestMetadata = structuredClone(value.row.latest_metadata);
    const originalPreviousMetadata = structuredClone(value.row.previous_metadata);
    let current = structuredClone(value.row);
    const compareAndSetObjectKeys = vi.fn(async (input) => {
      expect(input.metadataUpdates).toEqual({
        latest_metadata: {
          ...originalLatestMetadata,
          text_object_bytes: value.latest.text.length,
          artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
          artifact_bindings: expectedLatestArtifactBindings,
          expansion_state_count: 0,
          expansion_state_screenshots: [],
          localization: {
            status: "evidence_only_geometry_unavailable",
            geometry_ready: false,
            accounted_for: true,
            unavailable_reason: "legacy_no_retained_geometry",
          },
        },
        previous_metadata: {
          ...originalPreviousMetadata,
          text_object_bytes: value.previous.text.length,
          artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
          artifact_bindings: expectedPreviousArtifactBindings,
          expansion_state_count: 0,
          expansion_state_screenshots: [],
          localization: {
            status: "evidence_only_geometry_unavailable",
            geometry_ready: false,
            accounted_for: true,
            unavailable_reason: "legacy_no_retained_geometry",
          },
        },
      });
      current = {
        ...current,
        latest_object_keys: structuredClone(input.latestObjectKeys),
        previous_object_keys: structuredClone(input.previousObjectKeys),
        ...structuredClone(input.metadataUpdates),
        updated_at: "2026-08-10T15:10:00.000Z",
      };
      return { advanced: true, row: current };
    });

    const first = await applyLegacyR2SnapshotPointerItem({
      planItem: inspected.item,
      currentRow: current,
      source: value.source,
      objectStore,
      compareAndSetObjectKeys,
      loadCurrentRow: async () => current,
    });
    expect(first.status).toBe("applied");
    expect(current.latest_metadata).toEqual({
      ...originalLatestMetadata,
      text_object_bytes: value.latest.text.length,
      artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
      artifact_bindings: expectedLatestArtifactBindings,
      expansion_state_count: 0,
      expansion_state_screenshots: [],
      localization: {
        status: "evidence_only_geometry_unavailable",
        geometry_ready: false,
        accounted_for: true,
        unavailable_reason: "legacy_no_retained_geometry",
      },
    });
    expect(current.previous_metadata).toEqual({
      ...originalPreviousMetadata,
      text_object_bytes: value.previous.text.length,
      artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
      artifact_bindings: expectedPreviousArtifactBindings,
      expansion_state_count: 0,
      expansion_state_screenshots: [],
      localization: {
        status: "evidence_only_geometry_unavailable",
        geometry_ready: false,
        accounted_for: true,
        unavailable_reason: "legacy_no_retained_geometry",
      },
    });

    const putsAfterFirstApply = objectStore.puts.length;
    const second = await applyLegacyR2SnapshotPointerItem({
      planItem: inspected.item,
      currentRow: current,
      source: value.source,
      objectStore,
      compareAndSetObjectKeys,
      loadCurrentRow: async () => current,
    });
    expect(second.status).toBe("already_applied");
    expect(objectStore.puts).toHaveLength(putsAfterFirstApply);
    expect(compareAndSetObjectKeys).toHaveBeenCalledTimes(1);
  });

  it("refuses an occupied destination with different bytes before pointer CAS", async () => {
    const { inspected, row, source, objectStore } = await inspectedFixture();
    const artifact = inspected.item.generations.latest.artifacts[0];
    objectStore.seedImmutable(
      artifact.immutable_key,
      Buffer.from("different retained evidence", "utf8"),
      artifact.content_type,
    );
    const compareAndSetObjectKeys = vi.fn();

    await expect(applyLegacyR2SnapshotPointerItem({
      planItem: inspected.item,
      currentRow: row,
      source,
      objectStore,
      compareAndSetObjectKeys,
      loadCurrentRow: async () => row,
    })).rejects.toMatchObject({ code: "immutable_destination_mismatch" });
    expect(compareAndSetObjectKeys).not.toHaveBeenCalled();
  });

  it("reloads an authoritative applied row when the successful CAS returns a discrepant projection", async () => {
    const { inspected, row, source, objectStore } = await inspectedFixture();
    const authoritative = {
      ...structuredClone(row),
      latest_object_keys: structuredClone(inspected.item.next_object_keys.latest),
      previous_object_keys: structuredClone(inspected.item.next_object_keys.previous),
      updated_at: "2026-08-10T15:20:00.000Z",
    };
    const discrepantProjection = {
      ...structuredClone(authoritative),
      latest_object_keys: {
        ...structuredClone(authoritative.latest_object_keys),
        page: `visual-snapshots/sources/${sourceId}/unexpected/page.jpg`,
      },
    };
    const loadCurrentRow = vi.fn(async () => authoritative);

    const receipt = await applyLegacyR2SnapshotPointerItem({
      planItem: inspected.item,
      currentRow: row,
      source,
      objectStore,
      compareAndSetObjectKeys: async () => ({
        advanced: true,
        row: discrepantProjection,
      }),
      loadCurrentRow,
      now: "2026-08-10T15:20:01.000Z",
    });

    expect(loadCurrentRow).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({
      status: "applied",
      snapshot_updated_at: authoritative.updated_at,
      protection: {
        pointer_advanced: true,
        last_known_good_preserved: true,
      },
    });
    expect(receipt.latest_object_keys).toEqual(authoritative.latest_object_keys);
  });

  it("carries the authoritative discrepant post-CAS row into quarantine evidence", async () => {
    const { inspected, row, source, objectStore } = await inspectedFixture();
    const returnedProjection = {
      ...structuredClone(row),
      latest_object_keys: structuredClone(inspected.item.next_object_keys.latest),
      previous_object_keys: structuredClone(inspected.item.next_object_keys.previous),
      latest_metadata: {
        ...structuredClone(row.latest_metadata),
        unexpected_post_cas_value: true,
      },
      updated_at: "2026-08-10T15:25:00.000Z",
    };
    const authoritative = {
      ...structuredClone(returnedProjection),
      latest_object_keys: {
        ...structuredClone(returnedProjection.latest_object_keys),
        page: `visual-snapshots/sources/${sourceId}/authoritative-discrepancy/page.jpg`,
      },
      updated_at: "2026-08-10T15:25:01.000Z",
    };
    const loadCurrentRow = vi.fn(async () => authoritative);

    let failure;
    try {
      await applyLegacyR2SnapshotPointerItem({
        planItem: inspected.item,
        currentRow: row,
        source,
        objectStore,
        compareAndSetObjectKeys: async () => ({
          advanced: true,
          row: returnedProjection,
        }),
        loadCurrentRow,
      });
    } catch (error) {
      failure = error;
    }

    expect(loadCurrentRow).toHaveBeenCalledOnce();
    expect(failure).toMatchObject({
      code: "snapshot_pointer_postcondition_failed",
      details: {
        post_cas_state: {
          authoritative_state: "loaded",
          pointer_advanced: true,
          last_known_good_preserved: false,
          immutable_objects_uploaded: 8,
        },
      },
    });
    expect(failure.details.post_cas_state.authoritative_snapshot).toEqual(authoritative);

    const evidence = migrationFailureQuarantineEvidence({
      item: inspected.item,
      error: failure,
      observedAt: "2026-08-10T15:25:02.000Z",
    });
    expect(evidence.protection).toMatchObject({
      pointer_advanced: true,
      last_known_good_preserved: false,
      legacy_objects_deleted: false,
    });
    expect(evidence.post_cas_state.authoritative_snapshot).toEqual(authoritative);
  });

  it("does not claim preservation when the authoritative post-CAS reload is unavailable", async () => {
    const { inspected, row, source, objectStore } = await inspectedFixture();
    let failure;
    try {
      await applyLegacyR2SnapshotPointerItem({
        planItem: inspected.item,
        currentRow: row,
        source,
        objectStore,
        compareAndSetObjectKeys: async () => ({
          advanced: true,
          row: { invalid: "projection" },
        }),
        loadCurrentRow: async () => {
          throw new Error("authoritative reload unavailable");
        },
      });
    } catch (error) {
      failure = error;
    }

    const evidence = migrationFailureQuarantineEvidence({
      item: inspected.item,
      error: failure,
      observedAt: "2026-08-10T15:30:00.000Z",
    });
    expect(failure).toMatchObject({
      code: "snapshot_pointer_postcondition_reload_failed",
      details: {
        post_cas_state: {
          authoritative_state: "unavailable",
          pointer_advanced: true,
          last_known_good_preserved: false,
        },
      },
    });
    expect(evidence.protection).toMatchObject({
      pointer_advanced: true,
      last_known_good_preserved: false,
    });
  });
});

describe("migration CLI guardrails", () => {
  it("defaults to an exact dry run and requires a reviewed plan hash for apply", () => {
    expect(parseLegacyR2PointerMigrationArgs([`--source-id=${sourceId}`])).toMatchObject({
      sourceIds: [sourceId],
      ttlMinutes: 120,
    });
    expect(parseLegacyR2PointerMigrationArgs(["--limit=25"])).toMatchObject({
      limit: 25,
      sourceIds: [],
    });
    expect(() => parseLegacyR2PointerMigrationArgs([])).toThrow(/exact.*allowlist.*bounded/iu);
    expect(() => parseLegacyR2PointerMigrationArgs([
      "--apply",
      "--plan=reports/plan.json",
    ])).toThrow(/requires --plan and --confirm/iu);
    expect(() => parseLegacyR2PointerMigrationArgs([
      "--apply",
      "--plan=reports/plan.json",
      `--confirm=${"a".repeat(64)}`,
      `--source-id=${sourceId}`,
    ])).toThrow(/selectors belong in a new dry-run/iu);
    expect(() => parseLegacyR2PointerMigrationArgs([
      "--source-id=11111111-1111-4111-7111-111111111111",
    ])).toThrow(/not a UUID/iu);
  });

  it("has no live-fetch or R2-delete capability and keeps the DB write narrowly scoped", () => {
    expect(cliSource).not.toMatch(/DeleteObjectCommand/u);
    expect(cliSource).not.toMatch(/\bfetch\s*\(/u);
    expect(cliSource).toMatch(/IfNoneMatch:\s*"\*"/u);
    expect(cliSource).toMatch(/Metadata:\s*\{\s*sha256:\s*actualSha256\s*\}/u);
    expect(cliSource).toMatch(/latest_object_keys:\s*latestObjectKeys/u);
    expect(cliSource).toMatch(/previous_object_keys:\s*previousObjectKeys/u);
    expect(cliSource).toMatch(/\.\.\.metadataPatch/u);
    expect(cliSource).toMatch(/\.eq\("updated_at",\s*expectedUpdatedAt\)/u);
    expect(cliSource).toMatch(/stale_quarantine_plan_no_write/u);
    expect(cliSource).toMatch(/post_cas_state:\s*quarantine\.evidence\.post_cas_state/u);
    expect(cliSource).toMatch(/protection:\s*quarantine\.evidence\.protection/u);
    expect(cliSource).toMatch(
      /immutable_objects_uploaded:\s*\n\s*quarantine\.evidence\.post_cas_state\?\.immutable_objects_uploaded \|\| 0/u,
    );
    expect(cliSource).toMatch(
      /if \(item\.action === "quarantine_only"\)[\s\S]*assertReviewedQuarantinePrecondition[\s\S]*continue;[\s\S]*recordFailureQuarantine/u,
    );
  });

  it("treats an occupied conditional destination as resumable", async () => {
    const precondition = new Error("destination exists");
    precondition.name = "PreconditionFailed";
    precondition.$metadata = { httpStatusCode: 412 };
    const client = { send: vi.fn(async () => { throw precondition; }) };
    const objectStore = createR2ObjectStore({
      R2_BUCKET: bucket,
      R2_ENDPOINT: "https://r2.example.invalid",
    }, { client });
    const body = Buffer.from("immutable bytes", "utf8");

    await expect(objectStore.putObjectIfAbsent({
      key: `visual-snapshots/sources/${sourceId}/captures/${"a".repeat(32)}/text.txt`,
      body,
      contentType: "text/plain",
      sha256: sha256(body),
    })).resolves.toEqual({ created: false });
  });
});
