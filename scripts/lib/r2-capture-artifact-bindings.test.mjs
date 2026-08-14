import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertR2CaptureArtifactIdentity,
  assertR2CaptureArtifactSlots,
  collectR2CaptureArtifactFiles,
  prepareR2CaptureArtifacts,
  projectRetainedCaptureArtifacts,
  projectRetainedCaptureArtifactsForMaterialization,
  r2CaptureArtifactBindingsSchema,
  retainedCaptureArtifactProjectionSchema,
} from "./r2-capture-artifact-bindings.mjs";
import {
  bindVisualTextGeometry,
  visualTextGeometryLayoutFingerprint,
} from "./visual-event-localization.mjs";

describe("R2 capture artifact bindings", () => {
  it("reads each artifact once and returns a deterministic exact raw-byte map", () => {
    const bodies = new Map([
      ["C:/capture/page.jpg", Buffer.from("page bytes")],
      ["C:/capture/meta.json", Buffer.from("{\"ok\":true}\n")],
    ]);
    const readFile = vi.fn((path) => bodies.get(path));

    const prepared = prepareR2CaptureArtifacts([
      {
        name: "page",
        fileName: "page.jpg",
        path: "C:/capture/page.jpg",
        contentType: "image/jpeg",
      },
      {
        name: "meta",
        fileName: "meta.json",
        path: "C:/capture/meta.json",
        contentType: "application/json; charset=utf-8",
      },
    ], { readFile });

    expect(r2CaptureArtifactBindingsSchema).toBe(
      "awardping.r2.capture-artifact-bindings.v1",
    );
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(prepared.artifacts.map((artifact) => artifact.name)).toEqual(["meta", "page"]);
    expect(Object.keys(prepared.artifactBindings)).toEqual(["meta", "page"]);
    expect(prepared.artifactBindings).toEqual({
      meta: {
        sha256: crypto.createHash("sha256").update(bodies.get("C:/capture/meta.json")).digest("hex"),
        byte_length: bodies.get("C:/capture/meta.json").length,
        content_type: "application/json; charset=utf-8",
        hash_mode: "raw_sha256",
      },
      page: {
        sha256: crypto.createHash("sha256").update(bodies.get("C:/capture/page.jpg")).digest("hex"),
        byte_length: bodies.get("C:/capture/page.jpg").length,
        content_type: "image/jpeg",
        hash_mode: "raw_sha256",
      },
    });
    expect(prepared.artifacts[0].body).toEqual(bodies.get("C:/capture/meta.json"));
  });

  it("rejects empty artifacts and duplicate slots before an upload can be published", () => {
    expect(() => prepareR2CaptureArtifacts([{
      name: "text",
      fileName: "text.txt",
      path: "empty",
      contentType: "text/plain; charset=utf-8",
    }], { readFile: () => Buffer.alloc(0) })).toThrow("is empty");

    expect(() => prepareR2CaptureArtifacts([
      { name: "page", fileName: "page.jpg", path: "one", contentType: "image/jpeg" },
      { name: "page", fileName: "other.jpg", path: "two", contentType: "image/jpeg" },
    ], { readFile: () => Buffer.from("x") })).toThrow("Duplicate");
  });

  it("requires complete kind-aware core sets and contiguous expansion pairs", () => {
    const binding = {
      sha256: "a".repeat(64),
      byte_length: 1,
      content_type: "image/jpeg",
      hash_mode: "raw_sha256",
    };
    expect(() => assertR2CaptureArtifactSlots("webpage", {
      page: binding,
      thumb: binding,
      text: binding,
      meta: binding,
      layout: binding,
      expansion_state_01: binding,
      expansion_state_01_layout: binding,
    }, { expansionStateCount: 1 })).not.toThrow();
    expect(() => assertR2CaptureArtifactSlots("webpage", {
      page: binding,
      thumb: binding,
      text: binding,
      meta: binding,
      layout: binding,
      expansion_state_02: binding,
      expansion_state_02_layout: binding,
    }, { expansionStateCount: 1 })).toThrow("contiguous");
    expect(() => assertR2CaptureArtifactSlots("webpage", {
      page: binding,
      thumb: binding,
      text: binding,
    })).toThrow("meta");
    expect(() => assertR2CaptureArtifactSlots("pdf", {
      pdf: binding,
      text: binding,
      meta: binding,
      layout: binding,
    })).toThrow("only pdf, text, and meta");
    expect(() => assertR2CaptureArtifactSlots("webpage", {
      page: binding,
      thumb: binding,
      text: binding,
      meta: binding,
    }, { layoutClaimed: true })).toThrow("without a layout artifact");
    expect(() => assertR2CaptureArtifactSlots("webpage", {
      page: binding,
      thumb: binding,
      text: binding,
      meta: binding,
      expansion_state_01: binding,
      expansion_state_01_layout: binding,
    }, { expansionStateCount: 1 })).not.toThrow();
    expect(() => assertR2CaptureArtifactSlots("webpage", {
      page: binding,
      thumb: binding,
      text: binding,
      meta: binding,
    }, { expansionStateCount: 1 })).toThrow("does not match");
  });

  it("retains captured accordion evidence even when the old transient flag is false", () => {
    const mainImageHash = "1".repeat(64);
    const expandedImageHash = "2".repeat(64);
    const mainGeometry = readyGeometry(mainImageHash, "main");
    const expandedGeometry = readyGeometry(expandedImageHash, "expansion-state-01");
    const files = collectR2CaptureArtifactFiles({
      kind: "webpage",
      persist_expansion_state_screenshots: false,
      image_hash: mainImageHash,
      page_path: "page.jpg",
      thumb_path: "thumb.jpg",
      text_path: "text.txt",
      meta_path: "meta.json",
      layout_path: "layout.json",
      layout_hash: mainGeometry.geometry_hash,
      text_geometry: mainGeometry,
      expansion_state_screenshots: [{
        state_id: "expansion-state-01",
        image_hash: expandedImageHash,
        text_hash: "4".repeat(64),
        text_length: 4,
        text_geometry: expandedGeometry,
        page_path: "expanded.jpg",
        layout_path: "expanded-layout.json",
      }],
    });
    expect(files.map((file) => file.name)).toEqual([
      "page",
      "thumb",
      "text",
      "layout",
      "meta",
      "expansion_state_01",
      "expansion_state_01_layout",
    ]);

    for (const malformedState of [
      { text_hash: "not-a-sha256", text_length: 4 },
      { text_hash: "4".repeat(64), text_length: "4" },
      { text_hash: "4".repeat(64), text_length: -1 },
    ]) {
      const malformed = collectR2CaptureArtifactFiles({
        kind: "webpage",
        image_hash: mainImageHash,
        page_path: "page.jpg",
        thumb_path: "thumb.jpg",
        text_path: "text.txt",
        meta_path: "meta.json",
        layout_path: "layout.json",
        text_geometry: mainGeometry,
        expansion_state_screenshots: [{
          state_id: "expansion-state-01",
          image_hash: expandedImageHash,
          text_geometry: expandedGeometry,
          page_path: "expanded.jpg",
          layout_path: "expanded-layout.json",
          ...malformedState,
        }],
      });
      expect(malformed.map((file) => file.name)).toEqual([
        "page",
        "thumb",
        "text",
        "layout",
        "meta",
      ]);
    }

    const unavailable = collectR2CaptureArtifactFiles({
      page_path: "page.jpg",
      thumb_path: "thumb.jpg",
      text_path: "text.txt",
      meta_path: "meta.json",
      layout_path: "layout.json",
      layout_hash: "a".repeat(64),
      text_geometry: {
        ...readyGeometry("3".repeat(64), "main"),
        availability_status: "unavailable_page_not_settled",
        unavailable_reason: "The page did not settle.",
      },
      expansion_state_screenshots: [{
        page_path: "expanded.jpg",
        layout_path: "expanded-layout.json",
      }],
    });
    expect(unavailable.map((file) => file.name)).toEqual([
      "page",
      "thumb",
      "text",
      "meta",
    ]);
  });

  it("retains independently verified accordion evidence when main geometry is unavailable", () => {
    const mainImageHash = "1".repeat(64);
    const expandedImageHash = "2".repeat(64);
    const expandedGeometry = readyGeometry(expandedImageHash, "expansion-state-01");
    const capture = {
      kind: "webpage",
      image_hash: mainImageHash,
      page_path: "page.jpg",
      thumb_path: "thumb.jpg",
      text_path: "text.txt",
      meta_path: "meta.json",
      layout_path: "layout.json",
      text_geometry: {
        availability_status: "unavailable_layout_changed_during_screenshot",
        unavailable_reason: "The page moved.",
        nodes: [],
      },
      expansion_state_screenshots: [{
        state_id: "expansion-state-01",
        image_hash: expandedImageHash,
        text_hash: "4".repeat(64),
        text_length: 4,
        text_geometry: expandedGeometry,
        page_path: "expanded.jpg",
        layout_path: "expanded-layout.json",
      }],
    };
    const projection = projectRetainedCaptureArtifacts(capture);
    expect(projection.schema).toBe(retainedCaptureArtifactProjectionSchema);
    expect(projection.layoutRetained).toBe(false);
    expect(projection.retainedExpansionStates).toHaveLength(1);
    expect(projection.manifest).toMatchObject({
      localization_status: "evidence_only_geometry_unavailable",
      authoritative: {
        layout_retained: false,
        layout_hash: null,
        expansion_state_count: 1,
      },
      diagnostics: {
        authority: "diagnostic_only",
        main_layout: {
          present: true,
          reason: "unavailable_layout_changed_during_screenshot",
        },
      },
    });
    expect(collectR2CaptureArtifactFiles(capture).map((file) => file.name)).toEqual([
      "page",
      "thumb",
      "text",
      "meta",
      "expansion_state_01",
      "expansion_state_01_layout",
    ]);
  });

  it("preserves first-pass diagnostics across destructive materialization passes", () => {
    const imageHash = "1".repeat(64);
    const capture = {
      kind: "webpage",
      captured_at: "2026-08-10T12:00:00.000Z",
      image_hash: imageHash,
      text_hash: "3".repeat(64),
      layout_hash: readyGeometry(imageHash, "main").geometry_hash,
      layout_path: "layout.json",
      text_geometry: {
        ...readyGeometry(imageHash, "main"),
        availability_status: "unavailable_layout_changed_during_screenshot",
        unavailable_reason: "The page moved.",
      },
      expansion_state_screenshots: [{
        state_id: "expansion-state-01",
        image_hash: "2".repeat(64),
        text_hash: "invalid",
        text_length: 4,
        page_path: "expanded.jpg",
        layout_path: "expanded-layout.json",
      }],
    };

    const first = projectRetainedCaptureArtifactsForMaterialization(capture, {
      identityScope: "source-1",
    });
    expect(first.manifest.diagnostics).toMatchObject({
      main_layout: {
        present: true,
        reason: "unavailable_layout_changed_during_screenshot",
        observed_geometry_hash: capture.layout_hash,
      },
      expansion_states: [{
        state_id: "expansion-state-01",
        reason: "text_hash_invalid",
      }],
      excluded_state_count: 1,
    });

    capture.layout_path = null;
    capture.layout_hash = null;
    capture.text_geometry = unavailableGeometry();
    capture.expansion_state_screenshots = [];
    const second = projectRetainedCaptureArtifactsForMaterialization(capture, {
      identityScope: "source-1",
    });
    expect(second.manifest).toEqual(first.manifest);

    capture.text_hash = "4".repeat(64);
    expect(() => projectRetainedCaptureArtifactsForMaterialization(capture, {
      identityScope: "source-1",
    })).toThrow("Capture identity changed after retained artifact materialization");
  });

  it("retains only the contiguous valid expansion prefix", () => {
    const mainImageHash = "1".repeat(64);
    const state = (index, valid = true) => {
      const suffix = String(index).padStart(2, "0");
      const imageHash = String(index + 1).repeat(64).slice(0, 64);
      return {
        state_id: `expansion-state-${suffix}`,
        image_hash: imageHash,
        text_hash: valid ? "4".repeat(64) : "invalid",
        text_length: 4,
        text_geometry: readyGeometry(imageHash, `expansion-state-${suffix}`),
        page_path: `expanded-${suffix}.jpg`,
        layout_path: `expanded-${suffix}-layout.json`,
      };
    };
    const capture = {
      kind: "webpage",
      image_hash: mainImageHash,
      layout_hash: readyGeometry(mainImageHash, "main").geometry_hash,
      text_geometry: readyGeometry(mainImageHash, "main"),
      layout_path: "layout.json",
      expansion_state_screenshots: [state(1), state(2, false), state(3)],
    };
    const projection = projectRetainedCaptureArtifacts(capture);
    expect(projection.retainedExpansionStates.map((item) => item.state_id)).toEqual([
      "expansion-state-01",
    ]);
    expect(projection.manifest.diagnostics.expansion_states).toMatchObject([
      { state_id: "expansion-state-02", reason: "text_hash_invalid" },
      { state_id: "expansion-state-03", reason: "non_contiguous_after_unretained_state" },
    ]);
  });

  it("rejects stale page and semantic text identities before upload", () => {
    const sourceId = "11111111-1111-4111-8111-111111111111";
    const capturedAt = "2026-08-10T12:00:00.000Z";
    const page = Buffer.from("page bytes");
    const textBody = Buffer.from("Eligibility text\n", "utf8");
    const imageHash = sha256(page);
    const textHash = sha256(Buffer.from("Eligibility text", "utf8"));
    const projection = retainedProjection({ kind: "webpage" });
    const capture = {
      kind: "webpage",
      captured_at: capturedAt,
      image_hash: imageHash,
      page_bytes: page.length,
      thumb_bytes: Buffer.byteLength("thumb"),
      text_hash: textHash,
      text_length: "Eligibility text".length,
      expansion_state_screenshots: [],
      retained_artifact_projection: projection,
    };
    const prepared = prepareFromBodies({
      page: ["page.jpg", "image/jpeg", page],
      thumb: ["thumb.jpg", "image/jpeg", Buffer.from("thumb")],
      text: ["text.txt", "text/plain; charset=utf-8", textBody],
      meta: ["meta.json", "application/json; charset=utf-8", Buffer.from(JSON.stringify({
        kind: "webpage",
        source: { id: sourceId },
        captured_at: capturedAt,
        image_hash: imageHash,
        page_bytes: page.length,
        thumb_bytes: Buffer.byteLength("thumb"),
        text_hash: textHash,
        text_length: "Eligibility text".length,
        retained_artifact_projection: projection,
        text_geometry: unavailableGeometry(),
        localization: unavailableLocalization(),
        files: { layout: null, expansion_states: [] },
        expansion_state_count: 0,
        expansion_state_screenshots: [],
      }))],
    });

    expect(() => assertR2CaptureArtifactIdentity(capture, prepared, { sourceId }))
      .not.toThrow();
    const missingTextLength = mutatePreparedMeta(prepared, (metadata) => {
      delete metadata.text_length;
    });
    expect(() => assertR2CaptureArtifactIdentity(capture, missingTextLength, { sourceId }))
      .toThrow("metadata text_length is missing or invalid");
    const stalePageLength = mutatePreparedMeta(prepared, (metadata) => {
      metadata.page_bytes += 1;
    });
    expect(() => assertR2CaptureArtifactIdentity(capture, stalePageLength, { sourceId }))
      .toThrow("page byte length bindings do not match");
    expect(() => assertR2CaptureArtifactIdentity({
      ...capture,
      thumb_bytes: capture.thumb_bytes + 1,
    }, prepared, { sourceId })).toThrow("thumb byte length bindings do not match");
    expect(() => assertR2CaptureArtifactIdentity({
      ...capture,
      retained_artifact_projection: retainedProjection({
        kind: "webpage",
        expansionStateCount: 1,
      }),
    }, prepared, { sourceId })).toThrow("does not match prepared artifact slots");
    const staleRawProjection = mutatePreparedMeta(prepared, (metadata) => {
      metadata.retained_artifact_projection.authoritative.expansion_state_count = 1;
    });
    expect(() => assertR2CaptureArtifactIdentity(capture, staleRawProjection, { sourceId }))
      .toThrow("raw metadata and capture retained artifact projections do not match");
    expect(() => assertR2CaptureArtifactIdentity({
      ...capture,
      image_hash: "f".repeat(64),
    }, prepared, { sourceId })).toThrow("page bytes");
    expect(() => assertR2CaptureArtifactIdentity({
      ...capture,
      text_hash: "e".repeat(64),
    }, prepared, { sourceId })).toThrow("text bytes");

    const overclaimingMeta = prepareFromBodies({
      page: ["page.jpg", "image/jpeg", page],
      thumb: ["thumb.jpg", "image/jpeg", Buffer.from("thumb")],
      text: ["text.txt", "text/plain; charset=utf-8", textBody],
      meta: ["meta.json", "application/json; charset=utf-8", Buffer.from(JSON.stringify({
        kind: "webpage",
        source: { id: sourceId },
        captured_at: capturedAt,
        image_hash: imageHash,
        page_bytes: page.length,
        thumb_bytes: Buffer.byteLength("thumb"),
        text_hash: textHash,
        text_length: "Eligibility text".length,
        layout_hash: "a".repeat(64),
        retained_artifact_projection: projection,
        text_geometry: unavailableGeometry(),
        localization: unavailableLocalization(),
        files: { layout: "sources/source/captures/capture/layout.json", expansion_states: [] },
        expansion_state_count: 0,
        expansion_state_screenshots: [],
      }))],
    });
    expect(() => assertR2CaptureArtifactIdentity(capture, overclaimingMeta, { sourceId }))
      .toThrow("claims text geometry without a retained layout artifact");
  });

  it("accepts canonical hybrid metadata with unavailable main and exact accordion evidence", () => {
    const sourceId = "33333333-3333-4333-8333-333333333333";
    const capturedAt = "2026-08-10T12:00:00.000Z";
    const page = Buffer.from("main page");
    const expanded = Buffer.from("expanded page");
    const pageHash = sha256(page);
    const expandedHash = sha256(expanded);
    const expandedLayout = readyGeometry(expandedHash, "expansion-state-01");
    const projection = retainedProjection({ kind: "webpage", expansionStateCount: 1 });
    const capture = {
      kind: "webpage",
      captured_at: capturedAt,
      image_hash: pageHash,
      page_bytes: page.length,
      thumb_bytes: Buffer.byteLength("thumb"),
      text_hash: sha256(Buffer.from("Text")),
      text_length: 4,
      layout_hash: null,
      text_geometry: {
        availability_status: "unavailable_layout_changed_during_screenshot",
        unavailable_reason: "The main page moved.",
        nodes: [],
      },
      expansion_state_screenshots: [{
        state_id: "expansion-state-01",
        image_hash: expandedHash,
        page_bytes: expanded.length,
        layout_hash: expandedLayout.geometry_hash,
        text_geometry: expandedLayout,
        text_hash: "4".repeat(64),
        text_length: 4,
      }],
      retained_artifact_projection: projection,
    };
    const pageRef = "sources/source/captures/capture/expansion-state-01.jpg";
    const layoutRef = "sources/source/captures/capture/expansion-state-01-layout.json";
    const prepared = prepareFromBodies({
      page: ["page.jpg", "image/jpeg", page],
      thumb: ["thumb.jpg", "image/jpeg", Buffer.from("thumb")],
      text: ["text.txt", "text/plain; charset=utf-8", Buffer.from("Text\n")],
      meta: ["meta.json", "application/json; charset=utf-8", Buffer.from(JSON.stringify({
        kind: "webpage",
        source: { id: sourceId },
        captured_at: capturedAt,
        image_hash: pageHash,
        page_bytes: page.length,
        thumb_bytes: Buffer.byteLength("thumb"),
        text_hash: capture.text_hash,
        text_length: capture.text_length,
        retained_artifact_projection: projection,
        layout_hash: null,
        text_geometry: {
          status: "unavailable_layout_changed_during_screenshot",
          unavailable_reason: "The main page moved.",
          geometry_hash: null,
          file: null,
          screenshot: { image_hash: null, image_ref: null },
        },
        localization: {
          status: "evidence_only_geometry_unavailable",
          exact: false,
          accounted_for: true,
          geometry_ready: false,
          unavailable_reason: "The main page moved.",
          geometry_hash: null,
          bound_image_hash: null,
        },
        expansion_state_count: 1,
        expansion_state_screenshots: [{
          state_id: "expansion-state-01",
          image_hash: expandedHash,
          page_bytes: expanded.length,
          layout_hash: expandedLayout.geometry_hash,
          text_geometry: {
            ...expandedLayout,
            file: layoutRef,
          },
          text_hash: "4".repeat(64),
          text_length: 4,
          page: pageRef,
          layout: layoutRef,
        }],
        files: {
          layout: null,
          expansion_states: [{
            state_id: "expansion-state-01",
            page: pageRef,
            layout: layoutRef,
          }],
        },
      }))],
      expansion_state_01: ["expansion-state-01.jpg", "image/jpeg", expanded],
      expansion_state_01_layout: [
        "expansion-state-01-layout.json",
        "application/json; charset=utf-8",
        Buffer.from(JSON.stringify(expandedLayout)),
      ],
    });

    expect(() => assertR2CaptureArtifactIdentity(capture, prepared, { sourceId }))
      .not.toThrow();

    const missingCount = mutatePreparedMeta(prepared, (metadata) => {
      delete metadata.expansion_state_count;
    });
    expect(() => assertR2CaptureArtifactIdentity(capture, missingCount, { sourceId }))
      .toThrow("expansion state count is missing or invalid");

    const missingPageBytes = mutatePreparedMeta(prepared, (metadata) => {
      delete metadata.expansion_state_screenshots[0].page_bytes;
    });
    expect(() => assertR2CaptureArtifactIdentity(capture, missingPageBytes, { sourceId }))
      .toThrow("expansion state 01 references do not match");

    const stalePageBytes = mutatePreparedMeta(prepared, (metadata) => {
      metadata.expansion_state_screenshots[0].page_bytes += 1;
    });
    expect(() => assertR2CaptureArtifactIdentity(capture, stalePageBytes, { sourceId }))
      .toThrow("expansion state 01 references do not match");
  });

  it("rejects stale PDF and expanded-accordion identities before upload", () => {
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const capturedAt = "2026-08-10T12:00:00.000Z";
    const pdf = Buffer.from("pdf bytes");
    const textBody = Buffer.from("PDF text\n");
    const fileHash = sha256(pdf);
    const textHash = sha256(Buffer.from("PDF text"));
    const pdfProjection = retainedProjection({ kind: "pdf" });
    const pdfCapture = {
      kind: "pdf",
      captured_at: capturedAt,
      file_hash: fileHash,
      file_bytes: pdf.length,
      text_hash: textHash,
      text_length: "PDF text".length,
      retained_artifact_projection: pdfProjection,
    };
    const pdfPrepared = prepareFromBodies({
      pdf: ["document.pdf", "application/pdf", pdf],
      text: ["text.txt", "text/plain; charset=utf-8", textBody],
      meta: ["meta.json", "application/json; charset=utf-8", Buffer.from(JSON.stringify({
        kind: "pdf",
        source: { id: sourceId },
        captured_at: capturedAt,
        file_hash: fileHash,
        file_bytes: pdf.length,
        text_hash: textHash,
        text_length: "PDF text".length,
        retained_artifact_projection: pdfProjection,
      }))],
    });
    expect(() => assertR2CaptureArtifactIdentity(pdfCapture, pdfPrepared, { sourceId }))
      .not.toThrow();
    const missingPdfLength = mutatePreparedMeta(pdfPrepared, (metadata) => {
      delete metadata.file_bytes;
    });
    expect(() => assertR2CaptureArtifactIdentity(pdfCapture, missingPdfLength, { sourceId }))
      .toThrow("pdf byte length bindings do not match");
    expect(() => assertR2CaptureArtifactIdentity({
      ...pdfCapture,
      file_hash: "d".repeat(64),
    }, pdfPrepared, { sourceId })).toThrow("pdf bytes");

    const page = Buffer.from("page");
    const expanded = Buffer.from("expanded page");
    const pageHash = sha256(page);
    const expandedHash = sha256(expanded);
    const mainLayout = readyGeometry(pageHash, "main");
    const expandedLayout = readyGeometry(expandedHash, "expansion-state-01");
    const mainGeometry = mainLayout.geometry_hash;
    const expandedGeometry = expandedLayout.geometry_hash;
    const webProjection = retainedProjection({
      kind: "webpage",
      layoutHash: mainGeometry,
      expansionStateCount: 1,
    });
    const webCapture = {
      kind: "webpage",
      captured_at: capturedAt,
      image_hash: pageHash,
      page_bytes: page.length,
      thumb_bytes: Buffer.byteLength("thumb"),
      text_hash: sha256(Buffer.from("Text")),
      text_length: 4,
      layout_hash: mainGeometry,
      text_geometry: mainLayout,
      expansion_state_screenshots: [{
        state_id: "expansion-state-01",
        image_hash: expandedHash,
        page_bytes: expanded.length,
        layout_hash: expandedGeometry,
        text_geometry: expandedLayout,
        text_hash: "4".repeat(64),
        text_length: 4,
      }],
      retained_artifact_projection: webProjection,
    };
    const webPrepared = prepareFromBodies({
      page: ["page.jpg", "image/jpeg", page],
      thumb: ["thumb.jpg", "image/jpeg", Buffer.from("thumb")],
      text: ["text.txt", "text/plain; charset=utf-8", Buffer.from("Text\n")],
      layout: ["layout.json", "application/json; charset=utf-8", Buffer.from(JSON.stringify(mainLayout))],
      meta: ["meta.json", "application/json; charset=utf-8", Buffer.from(JSON.stringify({
        kind: "webpage",
        source: { id: sourceId },
        captured_at: capturedAt,
        image_hash: pageHash,
        page_bytes: page.length,
        thumb_bytes: Buffer.byteLength("thumb"),
        text_hash: webCapture.text_hash,
        text_length: webCapture.text_length,
        layout_hash: mainGeometry,
        retained_artifact_projection: webProjection,
        text_geometry: {
          ...mainLayout,
          file: "sources/source/captures/capture/layout.json",
        },
        localization: {
          geometry_hash: mainGeometry,
          bound_image_hash: pageHash,
        },
        expansion_state_count: 1,
        expansion_state_screenshots: [{
          state_id: "expansion-state-01",
          image_hash: expandedHash,
          page_bytes: expanded.length,
          layout_hash: expandedGeometry,
          text_geometry: {
            ...expandedLayout,
            file: "sources/source/captures/capture/expansion-state-01-layout.json",
          },
          text_hash: webCapture.expansion_state_screenshots[0].text_hash,
          text_length: webCapture.expansion_state_screenshots[0].text_length,
          page: "sources/source/captures/capture/expansion-state-01.jpg",
          layout: "sources/source/captures/capture/expansion-state-01-layout.json",
        }],
        files: {
          layout: "sources/source/captures/capture/layout.json",
          expansion_states: [{
            state_id: "expansion-state-01",
            page: "sources/source/captures/capture/expansion-state-01.jpg",
            layout: "sources/source/captures/capture/expansion-state-01-layout.json",
          }],
        },
      }))],
      expansion_state_01: ["expansion-state-01.jpg", "image/jpeg", expanded],
      expansion_state_01_layout: [
        "expansion-state-01-layout.json",
        "application/json; charset=utf-8",
        Buffer.from(JSON.stringify(expandedLayout)),
      ],
    });
    expect(() => assertR2CaptureArtifactIdentity(webCapture, webPrepared, { sourceId }))
      .not.toThrow();
    const staleExpansion = structuredClone(webCapture);
    staleExpansion.expansion_state_screenshots[0].image_hash = "c".repeat(64);
    expect(() => assertR2CaptureArtifactIdentity(staleExpansion, webPrepared, { sourceId }))
      .toThrow("expansion state 01 screenshot identity");

    const staleLayout = structuredClone(mainLayout);
    staleLayout.nodes[0].text = "Mutated while retaining the stale geometry hash";
    const staleLayoutPrepared = prepareFromBodies({
      page: ["page.jpg", "image/jpeg", page],
      thumb: ["thumb.jpg", "image/jpeg", Buffer.from("thumb")],
      text: ["text.txt", "text/plain; charset=utf-8", Buffer.from("Text\n")],
      layout: [
        "layout.json",
        "application/json; charset=utf-8",
        Buffer.from(JSON.stringify(staleLayout)),
      ],
      meta: ["meta.json", "application/json; charset=utf-8", Buffer.from(JSON.stringify({
        kind: "webpage",
        source: { id: sourceId },
        captured_at: capturedAt,
        image_hash: pageHash,
        text_hash: webCapture.text_hash,
        layout_hash: mainGeometry,
      }))],
      expansion_state_01: ["expansion-state-01.jpg", "image/jpeg", expanded],
      expansion_state_01_layout: [
        "expansion-state-01-layout.json",
        "application/json; charset=utf-8",
        Buffer.from(JSON.stringify(expandedLayout)),
      ],
    });
    expect(() => assertR2CaptureArtifactIdentity(webCapture, staleLayoutPrepared, { sourceId }))
      .toThrow("main layout binding is invalid");
  });
});

function readyGeometry(imageHash, stateId) {
  const source = {
    version: 1,
    state_id: stateId,
    captured_at: "2026-08-10T12:00:00.000Z",
    coordinate_space: "document-css-pixels",
    document: { width: 100, height: 100 },
    viewport: { width: 100, height: 100 },
    scroll: { x: 0, y: 0 },
    device_pixel_ratio: 1,
    paint_stack: { contract: "browser-paint-stack-v1", status: "verified" },
    nodes: [{
      order: 0,
      path: null,
      flow_path: null,
      text: "Text",
      separator_before: " ",
      rects: [{ x: 1, y: 1, width: 20, height: 10, right: 21, bottom: 11 }],
      runs: [{
        start: 0,
        end: 4,
        text: "Text",
        rects: [{ x: 1, y: 1, width: 20, height: 10, right: 21, bottom: 11 }],
      }],
    }],
  };
  const fingerprint = visualTextGeometryLayoutFingerprint(source);
  source.capture_verification = {
    contract: "visual-screenshot-layout-binding-v1",
    status: "verified",
    before_fingerprint: fingerprint,
    after_fingerprint: fingerprint,
  };
  return bindVisualTextGeometry(source, {
    capturedAt: "2026-08-10T12:00:00.000Z",
    imageHash,
    screenshot: { pixel_width: 100, pixel_height: 100 },
  });
}

function prepareFromBodies(definitions) {
  const bodies = new Map();
  const files = Object.entries(definitions).map(([name, [fileName, contentType, body]]) => {
    const path = `C:/capture/${fileName}`;
    bodies.set(path, body);
    return { name, fileName, path, contentType };
  });
  return prepareR2CaptureArtifacts(files, { readFile: (path) => bodies.get(path) });
}

function mutatePreparedMeta(prepared, mutate) {
  const definitions = {};
  for (const artifact of prepared.artifacts) {
    let body = artifact.body;
    if (artifact.name === "meta") {
      const metadata = JSON.parse(Buffer.from(body).toString("utf8"));
      mutate(metadata);
      body = Buffer.from(JSON.stringify(metadata));
    }
    definitions[artifact.name] = [artifact.fileName, artifact.contentType, body];
  }
  return prepareFromBodies(definitions);
}

function retainedProjection({ kind, layoutHash = null, expansionStateCount = 0 }) {
  const layoutRetained = Boolean(layoutHash);
  return {
    schema: retainedCaptureArtifactProjectionSchema,
    kind,
    localization_status: kind === "pdf"
      ? "not_applicable_pdf"
      : layoutRetained
        ? "exact_geometry_available"
        : "evidence_only_geometry_unavailable",
    authoritative: {
      layout_retained: layoutRetained,
      layout_hash: layoutRetained ? layoutHash : null,
      expansion_state_count: expansionStateCount,
    },
  };
}

function unavailableGeometry() {
  return {
    status: "unavailable_layout_changed_during_screenshot",
    unavailable_reason: "The page moved.",
    geometry_hash: null,
    node_count: 0,
    run_count: 0,
    file: null,
    screenshot: { image_hash: null, image_ref: null },
  };
}

function unavailableLocalization() {
  return {
    status: "evidence_only_geometry_unavailable",
    exact: false,
    accounted_for: true,
    geometry_ready: false,
    unavailable_reason: "The page moved.",
    geometry_hash: null,
    bound_image_hash: null,
  };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
