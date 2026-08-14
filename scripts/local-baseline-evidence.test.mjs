import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectLocalBaselineEvidence,
  parseSourceIdsFileContent,
  repairLocalBaselineEvidence,
} from "./lib/local-baseline-evidence.mjs";
import {
  bindVisualTextGeometry,
  visualTextGeometryLayoutFingerprint,
} from "./lib/visual-event-localization.mjs";

const sourceId = "11111111-1111-4111-8111-111111111111";
const otherSourceId = "22222222-2222-4222-8222-222222222222";
const createdRoots = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local baseline evidence repair", () => {
  it("parses line files, JSON arrays, and source_ids objects without duplicates", () => {
    expect(parseSourceIdsFileContent(`${sourceId}\n# ignored\n${sourceId}\n${otherSourceId}`)).toEqual([
      sourceId,
      otherSourceId,
    ]);
    expect(parseSourceIdsFileContent(JSON.stringify([sourceId, otherSourceId, sourceId]))).toEqual([
      sourceId,
      otherSourceId,
    ]);
    expect(parseSourceIdsFileContent(JSON.stringify({ source_ids: [otherSourceId] }))).toEqual([
      otherSourceId,
    ]);
    expect(() => parseSourceIdsFileContent('{"repair_source_ids":[]}')).toThrow(
      "source_ids array",
    );
    expect(() => parseSourceIdsFileContent(JSON.stringify([sourceId, 7]))).toThrow(
      "must be a string",
    );
  });

  it("accepts complete current evidence and ignores non-path expansion labels", () => {
    const fixture = createWebFixture();
    const meta = readJson(fixture.metaPath);
    meta.files.expansion_state_diagnostics = [{ label: "Admissions" }];
    writeJson(fixture.metaPath, meta);

    const result = inspectLocalBaselineEvidence({
      archiveRoot: fixture.archiveRoot,
      sourceId,
    });

    expect(result.reason).toBe("current_evidence_valid");
    expect(result.evidence_complete).toBe(true);
  });

  it("accepts older true no-claim metadata only with conservative local coverage", () => {
    const fixture = createWebFixture();
    const meta = readJson(fixture.metaPath);
    for (const field of [
      "expansion_state_candidates",
      "expansion_state_attempted",
      "expansion_state_capture_limit",
      "expansion_state_capture_complete",
      "expansion_state_truncated",
      "expansion_state_truncated_count",
      "expansion_state_failures",
    ]) {
      delete meta[field];
    }
    writeJson(fixture.metaPath, meta);

    expect(inspectLocalBaselineEvidence({
      archiveRoot: fixture.archiveRoot,
      sourceId,
    })).toMatchObject({
      reason: "current_evidence_valid",
      evidence_complete: true,
    });
  });

  it("validates claimed layout files and independently retained expansion pairs", () => {
    const missingLayout = createWebFixture();
    const missingLayoutPath = join(missingLayout.captureDir, "layout.json");
    const missingLayoutRef = archiveRelative(missingLayout.archiveRoot, missingLayoutPath);
    const missingBaseline = readJson(missingLayout.baselinePath);
    missingBaseline.capture.layout = missingLayoutRef;
    writeJson(missingLayout.baselinePath, missingBaseline);
    const missingMeta = readJson(missingLayout.metaPath);
    missingMeta.layout_hash = "a".repeat(64);
    missingMeta.text_geometry = {
      geometry_hash: "a".repeat(64),
      file: missingLayoutRef,
      screenshot: { image_hash: missingMeta.image_hash },
    };
    missingMeta.files.layout = missingLayoutRef;
    writeJson(missingLayout.metaPath, missingMeta);
    expect(inspectLocalBaselineEvidence({
      archiveRoot: missingLayout.archiveRoot,
      sourceId,
    })).toMatchObject({
      reason: "previous_baseline_capture_missing",
      missing_current_evidence: ["layout"],
    });

    const hybrid = createWebFixture();
    addExactExpansionEvidence(hybrid);

    expect(inspectLocalBaselineEvidence({
      archiveRoot: hybrid.archiveRoot,
      sourceId,
    })).toMatchObject({ reason: "current_evidence_valid", evidence_complete: true });
  });

  it("fails closed when retained expansion screenshot bytes or geometry drift", () => {
    const pageDrift = createWebFixture();
    const pageEvidence = addExactExpansionEvidence(pageDrift);
    writeFileSync(pageEvidence.pagePath, "tampered screenshot", "utf8");
    expect(inspectLocalBaselineEvidence({
      archiveRoot: pageDrift.archiveRoot,
      sourceId,
    })).toMatchObject({ reason: "current_meta_expansion_page_hash_mismatch" });

    const geometryDrift = createWebFixture();
    const geometryEvidence = addExactExpansionEvidence(geometryDrift);
    const layout = readJson(geometryEvidence.layoutPath);
    layout.nodes[0].text = "Tampered while retaining the stale geometry hash";
    writeJson(geometryEvidence.layoutPath, layout);
    expect(inspectLocalBaselineEvidence({
      archiveRoot: geometryDrift.archiveRoot,
      sourceId,
    })).toMatchObject({ reason: "current_meta_expansion_layout_binding_invalid" });

    const timestampDrift = createWebFixture();
    addExactExpansionEvidence(timestampDrift);
    const meta = readJson(timestampDrift.metaPath);
    meta.expansion_state_screenshots[0].captured_at = "2026-07-14T00:00:02.000Z";
    writeJson(timestampDrift.metaPath, meta);
    expect(inspectLocalBaselineEvidence({
      archiveRoot: timestampDrift.archiveRoot,
      sourceId,
    })).toMatchObject({ reason: "current_meta_expansion_state_captured_at_mismatch" });
  });

  it("requires an explicit nonnegative expansion state count", () => {
    for (const value of [undefined, -1, 0.5]) {
      const fixture = createWebFixture();
      const meta = readJson(fixture.metaPath);
      if (value === undefined) delete meta.expansion_state_count;
      else meta.expansion_state_count = value;
      writeJson(fixture.metaPath, meta);

      expect(inspectLocalBaselineEvidence({
        archiveRoot: fixture.archiveRoot,
        sourceId,
      })).toMatchObject({ reason: "current_meta_expansion_state_count_invalid" });
    }
  });

  it("repairs a previous main layout only after verifying its exact screenshot binding", async () => {
    const fixture = createMainLayoutRepairFixture();

    const result = await repairLocalBaselineEvidence({
      archiveRoot: fixture.archiveRoot,
      sourceId,
      apply: true,
      now: "2026-07-15T00:00:00.000Z",
    });
    const repaired = readJson(fixture.baselinePath);

    expect(result).toMatchObject({ status: "repaired", decision: "repair" });
    expect(repaired.capture.layout).toBe(fixture.layoutRef);
    expect(repaired.image_hash).toBe(fixture.imageHash);
    expect(repaired.layout_hash).toBe(fixture.layout.geometry_hash);
    expect(repaired.text_geometry).toMatchObject({
      geometry_hash: fixture.layout.geometry_hash,
      file: fixture.layoutRef,
      screenshot: {
        image_hash: fixture.imageHash,
        image_ref: fixture.pageRef,
      },
    });
    expect(repaired.summary_metadata.expansion_state_capture_coverage).toMatchObject({
      schema: "awardping.expansion-state-capture-coverage.v1",
      complete: false,
      status: "incomplete_discovery",
      raw_candidate_count_exact: false,
      logical_candidate_count_exact: false,
      retained_state_count: 0,
    });
    expect(readJson(fixture.metaPath)).not.toHaveProperty(
      "expansion_state_capture_coverage",
    );
  });

  it("rejects partial or contradictory coverage claims instead of using the legacy fallback", () => {
    const partial = createWebFixture();
    const partialMeta = readJson(partial.metaPath);
    partialMeta.expansion_state_capture_status = "verified_complete";
    writeJson(partial.metaPath, partialMeta);
    expect(inspectLocalBaselineEvidence({
      archiveRoot: partial.archiveRoot,
      sourceId,
    })).toMatchObject({ reason: "current_meta_expansion_state_coverage_invalid" });

    const contradictory = createWebFixture();
    const contradictoryMeta = readJson(contradictory.metaPath);
    Object.assign(contradictoryMeta, {
      expansion_state_capture_coverage: {
        schema: "awardping.expansion-state-capture-coverage.v1",
        complete: false,
        status: "incomplete_discovery",
        raw_candidate_count: 0,
        raw_candidate_count_exact: false,
        logical_candidate_count: 0,
        logical_candidate_count_exact: false,
        attempted_count: 0,
        retained_state_count: 0,
        capture_limit: 0,
        truncated: false,
        truncated_count: 0,
        truncated_count_exact: false,
        failure_count: 0,
      },
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
    });
    writeJson(contradictory.metaPath, contradictoryMeta);
    expect(inspectLocalBaselineEvidence({
      archiveRoot: contradictory.archiveRoot,
      sourceId,
    })).toMatchObject({ reason: "current_meta_expansion_state_coverage_invalid" });
  });

  it.each([
    ["corrupt page bytes", (fixture) => {
      writeFileSync(fixture.pagePath, "tampered page bytes", "utf8");
    }, "previous_meta_page_hash_mismatch"],
    ["malformed layout JSON", (fixture) => {
      writeFileSync(fixture.layoutPath, "{", "utf8");
    }, "previous_meta_layout_json_invalid"],
    ["stale layout body", (fixture) => {
      const layout = readJson(fixture.layoutPath);
      layout.nodes[0].text = "stale geometry content";
      writeJson(fixture.layoutPath, layout);
    }, "previous_meta_layout_binding_invalid"],
    ["mismatched metadata geometry hash", (fixture) => {
      const meta = readJson(fixture.metaPath);
      meta.layout_hash = "f".repeat(64);
      writeJson(fixture.metaPath, meta);
    }, "previous_meta_layout_geometry_identity_mismatch"],
    ["mismatched localization geometry hash", (fixture) => {
      const meta = readJson(fixture.metaPath);
      meta.localization.geometry_hash = "f".repeat(64);
      writeJson(fixture.metaPath, meta);
    }, "previous_meta_layout_geometry_identity_mismatch"],
    ["stale geometry artifact path", (fixture) => {
      const meta = readJson(fixture.metaPath);
      meta.text_geometry.file = fixture.pageRef;
      writeJson(fixture.metaPath, meta);
    }, "previous_meta_layout_path_identity_mismatch"],
    ["stale localization timestamp", (fixture) => {
      const meta = readJson(fixture.metaPath);
      meta.localization.captured_at = "2026-07-14T00:00:01.000Z";
      writeJson(fixture.metaPath, meta);
    }, "previous_meta_layout_captured_at_mismatch"],
    ["mismatched previous generation", (fixture) => {
      const baseline = readJson(fixture.baselinePath);
      baseline.summary_metadata.previous_baseline.captured_at =
        "2026-07-13T00:00:00.000Z";
      writeJson(fixture.baselinePath, baseline);
    }, "previous_meta_generation_captured_at_mismatch"],
    ["mismatched page hash metadata", (fixture) => {
      const meta = readJson(fixture.metaPath);
      meta.image_hash = "f".repeat(64);
      writeJson(fixture.metaPath, meta);
    }, "previous_meta_generation_hash_mismatch"],
  ])("fails closed for %s in prior main-layout evidence", (_name, mutate, reason) => {
    const fixture = createMainLayoutRepairFixture();
    mutate(fixture);

    expect(inspectLocalBaselineEvidence({
      archiveRoot: fixture.archiveRoot,
      sourceId,
    })).toMatchObject({ status: "refused", decision: "refuse", reason });
  });

  it.each([
    ["changed semantic text", (fixture) => {
      writeFileSync(fixture.textPath, "tampered evidence\n", "utf8");
    }, "previous_meta_text_hash_mismatch"],
    ["invalid text writer framing", (fixture) => {
      writeFileSync(fixture.textPath, "evidence", "utf8");
    }, "previous_meta_text_writer_framing_invalid"],
    ["invalid UTF-8 text", (fixture) => {
      writeFileSync(fixture.textPath, Buffer.from([0xff, 0x0a]));
    }, "previous_meta_text_utf8_invalid"],
    ["changed thumbnail byte length", (fixture) => {
      writeFileSync(fixture.thumbPath, "tampered thumbnail bytes", "utf8");
    }, "previous_meta_thumb_bytes_mismatch"],
  ])("rejects corrupt prior webpage core evidence: %s", (_name, mutate, reason) => {
    const fixture = createMainLayoutRepairFixture();
    mutate(fixture);

    expect(inspectLocalBaselineEvidence({
      archiveRoot: fixture.archiveRoot,
      sourceId,
    })).toMatchObject({ status: "refused", decision: "refuse", reason });
  });

  it("rejects corrupt prior PDF bytes before repairing the baseline", () => {
    const fixture = createPdfRepairFixture();
    writeFileSync(fixture.pdfPath, "tampered PDF payload", "utf8");

    expect(inspectLocalBaselineEvidence({
      archiveRoot: fixture.archiveRoot,
      sourceId,
    })).toMatchObject({
      status: "refused",
      decision: "refuse",
      reason: "previous_meta_pdf_hash_mismatch",
    });
  });

  it("rejects a PDF retained projection with the wrong artifact kind", () => {
    const fixture = createPdfRepairFixture();
    const meta = readJson(fixture.metaPath);
    meta.retained_artifact_projection = {
      schema: "awardping.capture-retained-artifact-projection.v1",
      kind: "webpage",
      localization_status: "evidence_only_geometry_unavailable",
      authoritative: {
        layout_retained: false,
        layout_hash: null,
        expansion_state_count: 0,
      },
    };
    writeJson(fixture.metaPath, meta);

    expect(inspectLocalBaselineEvidence({
      archiveRoot: fixture.archiveRoot,
      sourceId,
    })).toMatchObject({
      status: "refused",
      decision: "refuse",
      reason: "previous_meta_retained_projection_mismatch",
    });
  });

  it.each([
    ["wrong localization status", (projection) => {
      projection.localization_status = "evidence_only_geometry_unavailable";
    }],
    ["mismatched layout hash", (projection) => {
      projection.authoritative.layout_hash = "f".repeat(64);
    }],
    ["mismatched expansion count", (projection) => {
      projection.authoritative.expansion_state_count = 1;
    }],
  ])("rejects a webpage retained projection with %s", (_name, mutate) => {
    const fixture = createMainLayoutRepairFixture();
    const meta = readJson(fixture.metaPath);
    mutate(meta.retained_artifact_projection);
    writeJson(fixture.metaPath, meta);

    expect(inspectLocalBaselineEvidence({
      archiveRoot: fixture.archiveRoot,
      sourceId,
    })).toMatchObject({
      status: "refused",
      decision: "refuse",
      reason: "previous_meta_retained_projection_mismatch",
    });
  });

  it("fails closed for malformed, mismatched, or structurally invalid current metadata", () => {
    const wrongSource = createWebFixture();
    const wrongMeta = readJson(wrongSource.metaPath);
    wrongMeta.source.id = otherSourceId;
    writeJson(wrongSource.metaPath, wrongMeta);
    expect(
      inspectLocalBaselineEvidence({ archiveRoot: wrongSource.archiveRoot, sourceId }).reason,
    ).toBe("current_meta_source_id_mismatch");

    const malformed = createWebFixture();
    writeFileSync(malformed.metaPath, "{", "utf8");
    expect(
      inspectLocalBaselineEvidence({ archiveRoot: malformed.archiveRoot, sourceId }).reason,
    ).toBe("current_meta_json_invalid");

    const invalidFiles = createWebFixture();
    const invalidMeta = readJson(invalidFiles.metaPath);
    invalidMeta.files = "../../outside";
    writeJson(invalidFiles.metaPath, invalidMeta);
    expect(
      inspectLocalBaselineEvidence({ archiveRoot: invalidFiles.archiveRoot, sourceId }).reason,
    ).toBe("current_meta_files_invalid");
  });

  it("restores generation-bound metadata only from the verified previous capture", async () => {
    const fixture = createWebFixture({ writeBaseline: false });
    const dangling = descriptorFor(fixture.archiveRoot, join(fixture.sourceDir, "captures", "new"));
    const baselinePath = join(fixture.sourceDir, "baseline.json");
    writeJson(baselinePath, baselineValue({
      descriptor: { ...dangling, ignored_path: "../../unsafe" },
      previousDescriptor: fixture.descriptor,
      facts: { award_relevance: "primary", cycle_relevance: "evergreen" },
    }));
    const danglingBaseline = readJson(baselinePath);
    danglingBaseline.summary_metadata.baseline_facts_metadata = {
      status: "newer-facts-metadata",
    };
    danglingBaseline.summary_metadata.monitoring_disposition = {
      status: "newer-monitoring-disposition",
    };
    danglingBaseline.summary_metadata.stage1_baseline_activation = {
      status: "newer-stage1-activation",
    };
    danglingBaseline.summary_metadata.retained_artifact_projection = {
      schema: "awardping.capture-retained-artifact-projection.v1",
      kind: "webpage",
      localization_status: "exact_geometry_available",
      authoritative: {
        layout_retained: true,
        layout_hash: "f".repeat(64),
        expansion_state_count: 0,
      },
    };
    writeJson(baselinePath, danglingBaseline);
    const previousMeta = readJson(fixture.metaPath);
    previousMeta.baseline_facts = {
      award_relevance: "secondary",
      cycle_relevance: "2026-cycle",
    };
    previousMeta.monitoring_disposition = {
      status: "verified-previous-disposition",
    };
    writeJson(fixture.metaPath, previousMeta);

    const result = await repairLocalBaselineEvidence({
      archiveRoot: fixture.archiveRoot,
      sourceId,
      apply: true,
      now: "2026-07-15T00:00:00.000Z",
    });
    const repaired = readJson(baselinePath);

    expect(result.status).toBe("repaired");
    expect(repaired.capture).toEqual(fixture.descriptor);
    expect(repaired.summary_metadata.baseline_facts).toEqual({
      award_relevance: "secondary",
      cycle_relevance: "2026-cycle",
    });
    expect(repaired.summary_metadata.baseline_facts_metadata).toBeNull();
    expect(repaired.summary_metadata.monitoring_disposition).toEqual({
      status: "verified-previous-disposition",
    });
    expect(repaired.summary_metadata.stage1_baseline_activation).toBeNull();
    expect(repaired.summary_metadata.local_evidence_repair.dangling_capture).not.toHaveProperty(
      "ignored_path",
    );
    expect(repaired.summary_metadata.previous_baseline_capture).toBeNull();
    expect(repaired.summary_metadata.retained_artifact_projection).toBeNull();
  });

  it("rejects a source junction that escapes the archive", () => {
    const archiveRoot = makeRoot();
    const outsideRoot = makeRoot();
    const outsideSource = join(outsideRoot, sourceId);
    mkdirSync(outsideSource, { recursive: true });
    const outsideFixture = createWebFixtureAt({ archiveRoot: outsideRoot, sourceDir: outsideSource });
    const archiveSources = join(archiveRoot, "sources");
    mkdirSync(archiveSources, { recursive: true });
    symlinkSync(outsideSource, join(archiveSources, sourceId), "junction");

    const result = inspectLocalBaselineEvidence({ archiveRoot, sourceId });

    expect(outsideFixture.baselinePath).toBeTruthy();
    expect(result.reason).toMatch(
      /^current_(?:source_symlink_outside_archive|path_outside_source)$/,
    );
    expect(result.evidence_complete).not.toBe(true);
  });

  it("rejects evidence redirected outside its capture directory", () => {
    const fixture = createWebFixture({ writeBaseline: false });
    const sibling = join(fixture.sourceDir, "captures", "sibling");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "text.txt"), "redirected", "utf8");
    const link = join(fixture.captureDir, "redirected");
    symlinkSync(sibling, link, "junction");
    const descriptor = {
      ...fixture.descriptor,
      text: archiveRelative(fixture.archiveRoot, join(link, "text.txt")),
    };
    writeJson(fixture.baselinePath, baselineValue({ descriptor }));

    const result = inspectLocalBaselineEvidence({ archiveRoot: fixture.archiveRoot, sourceId });

    expect(result.reason).toBe("current_capture_file_symlink_outside_capture_dir");
    expect(result.evidence_complete).not.toBe(true);
  });

  it("keeps the report marker on a nonzero completion audit and rejects invalid CLI values", () => {
    const archiveRoot = makeRoot();
    const idsPath = join(archiveRoot, "ids.json");
    const reportPath = join(archiveRoot, "report.json");
    writeJson(idsPath, [sourceId]);
    const cliPath = fileURLToPath(new URL("./repair-local-baseline-evidence.mjs", import.meta.url));

    const incomplete = spawnSync(process.execPath, [
      cliPath,
      `--archive-dir=${archiveRoot}`,
      `--source-ids-file=${idsPath}`,
      `--report=${reportPath}`,
      "--require-complete=true",
      "--limit=1",
    ], { encoding: "utf8" });
    expect(incomplete.status).toBe(1);
    expect(incomplete.stdout).toContain("LOCAL_BASELINE_EVIDENCE_REPORT");
    expect(existsSync(reportPath)).toBe(true);

    for (const invalidArg of ["--require-complete=maybe", "--limit=0"]) {
      const invalid = spawnSync(process.execPath, [
        cliPath,
        `--archive-dir=${archiveRoot}`,
        `--source-ids-file=${idsPath}`,
        invalidArg,
      ], { encoding: "utf8" });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toMatch(/must be true or false|must be a positive integer/);
    }
  });
});

function createWebFixture({ writeBaseline = true } = {}) {
  const archiveRoot = makeRoot();
  const sourceDir = join(archiveRoot, "sources", sourceId);
  return createWebFixtureAt({ archiveRoot, sourceDir, writeBaseline });
}

function createWebFixtureAt({ archiveRoot, sourceDir, writeBaseline = true }) {
  const captureDir = join(sourceDir, "captures", "old");
  mkdirSync(captureDir, { recursive: true });
  const pagePath = join(captureDir, "page.jpg");
  const thumbPath = join(captureDir, "thumb.jpg");
  const textPath = join(captureDir, "text.txt");
  const metaPath = join(captureDir, "meta.json");
  const pageBytes = Buffer.from("page", "utf8");
  const thumbBytes = Buffer.from("thumb", "utf8");
  const text = "evidence";
  writeFileSync(pagePath, pageBytes);
  writeFileSync(thumbPath, thumbBytes);
  writeFileSync(textPath, `${text}\n`, "utf8");
  const descriptor = descriptorFor(archiveRoot, captureDir);
  const textHash = sha256(Buffer.from(text, "utf8"));
  const imageHash = sha256(pageBytes);
  writeJson(metaPath, {
    kind: "webpage",
    source: { id: sourceId },
    captured_at: "2026-07-14T00:00:00.000Z",
    text_hash: textHash,
    text_length: text.length,
    image_hash: imageHash,
    page_bytes: pageBytes.length,
    thumb_bytes: thumbBytes.length,
    expansion_state_candidates: 0,
    expansion_state_attempted: 0,
    expansion_state_capture_limit: 24,
    expansion_state_capture_complete: true,
    expansion_state_truncated: false,
    expansion_state_truncated_count: 0,
    expansion_state_failures: [],
    expansion_state_count: 0,
    expansion_state_screenshots: [],
    files: { ...descriptor, dir: undefined },
  });
  const baselinePath = join(sourceDir, "baseline.json");
  if (writeBaseline) {
    const baseline = baselineValue({ descriptor });
    baseline.text_hash = textHash;
    baseline.text_length = text.length;
    baseline.image_hash = imageHash;
    writeJson(baselinePath, baseline);
  }
  return {
    archiveRoot,
    sourceDir,
    captureDir,
    descriptor,
    baselinePath,
    metaPath,
    pagePath,
    thumbPath,
    textPath,
  };
}

function baselineValue({ descriptor, previousDescriptor = null, facts = null }) {
  return {
    version: 1,
    kind: "webpage",
    source: { id: sourceId, shared_award_id: "award-1" },
    captured_at: "2026-07-14T00:00:00.000Z",
    text_hash: "text-hash",
    image_hash: "image-hash",
    capture: descriptor,
    summary_metadata: {
      reason: "fixture",
      previous_baseline_capture: previousDescriptor,
      baseline_facts: facts,
      baseline_facts_metadata: facts ? { status: "succeeded" } : null,
    },
  };
}

function createPdfRepairFixture() {
  const archiveRoot = makeRoot();
  const sourceDir = join(archiveRoot, "sources", sourceId);
  const captureDir = join(sourceDir, "captures", "old-pdf");
  mkdirSync(captureDir, { recursive: true });
  const pdfPath = join(captureDir, "document.pdf");
  const textPath = join(captureDir, "text.txt");
  const metaPath = join(captureDir, "meta.json");
  const pdfBytes = Buffer.from("verified PDF payload", "utf8");
  const text = "PDF evidence";
  writeFileSync(pdfPath, pdfBytes);
  writeFileSync(textPath, `${text}\n`, "utf8");
  const descriptor = pdfDescriptorFor(archiveRoot, captureDir);
  const capturedAt = "2026-07-14T00:00:00.000Z";
  const textHash = sha256(Buffer.from(text, "utf8"));
  const fileHash = sha256(pdfBytes);
  writeJson(metaPath, {
    kind: "pdf",
    source: { id: sourceId },
    captured_at: capturedAt,
    text_hash: textHash,
    text_length: text.length,
    file_hash: fileHash,
    file_bytes: pdfBytes.length,
    files: { ...descriptor, dir: undefined },
  });

  const dangling = pdfDescriptorFor(
    archiveRoot,
    join(sourceDir, "captures", "new-pdf"),
  );
  const baselinePath = join(sourceDir, "baseline.json");
  writeJson(baselinePath, {
    version: 1,
    kind: "pdf",
    source: { id: sourceId, shared_award_id: "award-1" },
    captured_at: "2026-07-15T00:00:00.000Z",
    text_hash: "f".repeat(64),
    file_hash: "e".repeat(64),
    capture: dangling,
    summary_metadata: {
      reason: "fixture",
      previous_baseline_capture: descriptor,
      previous_baseline: {
        captured_at: capturedAt,
        text_hash: textHash,
        text_length: text.length,
        file_hash: fileHash,
        file_bytes: pdfBytes.length,
        capture: descriptor,
      },
    },
  });
  return {
    archiveRoot,
    sourceDir,
    captureDir,
    descriptor,
    baselinePath,
    metaPath,
    pdfPath,
    textPath,
  };
}

function pdfDescriptorFor(archiveRoot, captureDir) {
  return {
    dir: archiveRelative(archiveRoot, captureDir),
    page: null,
    thumb: null,
    pdf: archiveRelative(archiveRoot, join(captureDir, "document.pdf")),
    text: archiveRelative(archiveRoot, join(captureDir, "text.txt")),
    expansion_text: null,
    sections_text: null,
    sections_json: null,
    layout: null,
    meta: archiveRelative(archiveRoot, join(captureDir, "meta.json")),
  };
}

function createMainLayoutRepairFixture() {
  const fixture = createWebFixture();
  const evidence = addExactMainLayoutEvidence(fixture);
  const verifiedBaseline = readJson(fixture.baselinePath);
  const dangling = descriptorFor(
    fixture.archiveRoot,
    join(fixture.sourceDir, "captures", "new"),
  );
  const baseline = baselineValue({
    descriptor: dangling,
    previousDescriptor: structuredClone(fixture.descriptor),
  });
  baseline.summary_metadata.previous_baseline = {
    captured_at: verifiedBaseline.captured_at,
    text_hash: verifiedBaseline.text_hash,
    image_hash: verifiedBaseline.image_hash,
    capture: structuredClone(verifiedBaseline.capture),
  };
  writeJson(fixture.baselinePath, baseline);
  return { ...fixture, ...evidence };
}

function addExactMainLayoutEvidence(fixture) {
  const capturedAt = "2026-07-14T00:00:00.000Z";
  const pagePath = join(fixture.captureDir, "page.jpg");
  const layoutPath = join(fixture.captureDir, "layout.json");
  const pageRef = archiveRelative(fixture.archiveRoot, pagePath);
  const layoutRef = archiveRelative(fixture.archiveRoot, layoutPath);
  const pageBytes = readFileSync(pagePath);
  const imageHash = sha256(pageBytes);
  const geometrySource = {
    version: 1,
    state_id: "main",
    captured_at: capturedAt,
    coordinate_space: "document-css-pixels",
    document: { width: 100, height: 100 },
    viewport: { width: 100, height: 100 },
    scroll: { x: 0, y: 0 },
    device_pixel_ratio: 1,
    paint_stack: { contract: "browser-paint-stack-v1", status: "verified" },
    nodes: [{
      order: 0,
      path: "html/body/main/p",
      flow_path: "html/body/main/p",
      text: "Eligibility wording",
      separator_before: "",
      rects: [{ x: 1, y: 1, width: 20, height: 10, right: 21, bottom: 11 }],
      runs: [{
        start: 0,
        end: 19,
        text: "Eligibility wording",
        rects: [{ x: 1, y: 1, width: 20, height: 10, right: 21, bottom: 11 }],
      }],
    }],
  };
  const fingerprint = visualTextGeometryLayoutFingerprint(geometrySource);
  geometrySource.capture_verification = {
    contract: "visual-screenshot-layout-binding-v1",
    status: "verified",
    before_fingerprint: fingerprint,
    after_fingerprint: fingerprint,
  };
  const layout = bindVisualTextGeometry(geometrySource, {
    capturedAt,
    imageHash,
    imageRef: pageRef,
    screenshot: { pixel_width: 100, pixel_height: 100 },
  });
  writeJson(layoutPath, layout);

  fixture.descriptor.layout = layoutRef;
  const baseline = readJson(fixture.baselinePath);
  baseline.image_hash = imageHash;
  baseline.layout_hash = layout.geometry_hash;
  baseline.text_geometry = geometryReference(layout, layoutRef);
  baseline.capture.layout = layoutRef;
  baseline.summary_metadata.retained_artifact_projection = retainedProjection({
    layoutHash: layout.geometry_hash,
  });
  writeJson(fixture.baselinePath, baseline);

  const meta = readJson(fixture.metaPath);
  meta.image_hash = imageHash;
  meta.page_bytes = pageBytes.length;
  meta.layout_hash = layout.geometry_hash;
  meta.text_geometry = geometryReference(layout, layoutRef);
  meta.localization = {
    status: "geometry_ready",
    exact: false,
    accounted_for: true,
    geometry_ready: true,
    unavailable_reason: null,
    geometry_hash: layout.geometry_hash,
    bound_image_hash: imageHash,
    captured_at: capturedAt,
  };
  meta.files.layout = layoutRef;
  meta.retained_artifact_projection = retainedProjection({
    layoutHash: layout.geometry_hash,
  });
  writeJson(fixture.metaPath, meta);

  return { pagePath, pageRef, layoutPath, layoutRef, layout, imageHash };
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

function retainedProjection({ layoutHash = null, expansionStateCount = 0 } = {}) {
  return {
    schema: "awardping.capture-retained-artifact-projection.v1",
    kind: "webpage",
    localization_status: layoutHash
      ? "exact_geometry_available"
      : "evidence_only_geometry_unavailable",
    authoritative: {
      layout_retained: Boolean(layoutHash),
      layout_hash: layoutHash,
      expansion_state_count: expansionStateCount,
    },
  };
}

function addExactExpansionEvidence(fixture) {
  const stateId = "expansion-state-01";
  const capturedAt = "2026-07-14T00:00:01.000Z";
  const text = "Expanded eligibility wording";
  const pageBytes = Buffer.from("expanded screenshot bytes");
  const imageHash = sha256(pageBytes);
  const textHash = sha256(Buffer.from(text, "utf8"));
  const pagePath = join(fixture.captureDir, "expansion-state-01.jpg");
  const layoutPath = join(fixture.captureDir, "expansion-state-01-layout.json");
  const pageRef = archiveRelative(fixture.archiveRoot, pagePath);
  const layoutRef = archiveRelative(fixture.archiveRoot, layoutPath);
  const layout = bindVisualTextGeometry({
    version: 1,
    state_id: stateId,
    captured_at: capturedAt,
    coordinate_space: "document-css-pixels",
    document: { width: 100, height: 100 },
    viewport: { width: 100, height: 100 },
    scroll: { x: 0, y: 0 },
    device_pixel_ratio: 1,
    nodes: [{
      order: 0,
      path: "html/body/main/details/p",
      flow_path: "html/body/main/details/p",
      text,
      separator_before: "",
      rects: [{ x: 1, y: 1, width: 20, height: 10, right: 21, bottom: 11 }],
      runs: [{
        start: 0,
        end: text.length,
        text,
        rects: [{ x: 1, y: 1, width: 20, height: 10, right: 21, bottom: 11 }],
      }],
    }],
  }, {
    capturedAt,
    imageHash,
    imageRef: pageRef,
    screenshot: { css_width: 100, css_height: 100, pixel_width: 100, pixel_height: 100 },
  });
  writeFileSync(pagePath, pageBytes);
  writeJson(layoutPath, layout);

  const baseline = readJson(fixture.baselinePath);
  baseline.capture.expansion_states = [{
    state_id: stateId,
    captured_at: capturedAt,
    image_hash: imageHash,
    layout_hash: layout.geometry_hash,
    page: pageRef,
    layout: layoutRef,
  }];
  baseline.summary_metadata.retained_artifact_projection = {
    schema: "awardping.capture-retained-artifact-projection.v1",
    kind: "webpage",
    localization_status: "evidence_only_geometry_unavailable",
    authoritative: {
      layout_retained: false,
      layout_hash: null,
      expansion_state_count: 1,
    },
  };
  writeJson(fixture.baselinePath, baseline);

  const meta = readJson(fixture.metaPath);
  meta.layout_hash = null;
  meta.text_geometry = {
    status: "unavailable_layout_changed_during_screenshot",
    unavailable_reason: "The main page moved.",
    geometry_hash: null,
    node_count: 0,
    run_count: 0,
    file: null,
    screenshot: { image_hash: null, image_ref: null },
  };
  meta.localization = {
    status: "evidence_only_geometry_unavailable",
    exact: false,
    accounted_for: true,
    geometry_ready: false,
    unavailable_reason: "The main page moved.",
    geometry_hash: null,
    bound_image_hash: null,
  };
  meta.expansion_state_count = 1;
  meta.expansion_state_candidates = 1;
  meta.expansion_state_attempted = 1;
  meta.expansion_state_capture_complete = true;
  meta.expansion_state_truncated = false;
  meta.expansion_state_truncated_count = 0;
  meta.expansion_state_failures = [];
  meta.expansion_state_screenshots = [{
    state_id: stateId,
    captured_at: capturedAt,
    image_hash: imageHash,
    layout_hash: layout.geometry_hash,
    text_hash: textHash,
    text_length: text.length,
    page_bytes: pageBytes.length,
    text_geometry: { ...layout, file: layoutRef },
    page: pageRef,
    layout: layoutRef,
  }];
  meta.files.layout = null;
  meta.files.expansion_states = [{
    state_id: stateId,
    page: pageRef,
    layout: layoutRef,
  }];
  meta.retained_artifact_projection = baseline.summary_metadata.retained_artifact_projection;
  writeJson(fixture.metaPath, meta);
  return { pagePath, layoutPath, layout, imageHash };
}

function descriptorFor(archiveRoot, captureDir) {
  return {
    dir: archiveRelative(archiveRoot, captureDir),
    page: archiveRelative(archiveRoot, join(captureDir, "page.jpg")),
    thumb: archiveRelative(archiveRoot, join(captureDir, "thumb.jpg")),
    pdf: null,
    text: archiveRelative(archiveRoot, join(captureDir, "text.txt")),
    expansion_text: null,
    sections_text: null,
    sections_json: null,
    layout: null,
    meta: archiveRelative(archiveRoot, join(captureDir, "meta.json")),
  };
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "awardping-baseline-evidence-"));
  createdRoots.push(root);
  return root;
}

function archiveRelative(archiveRoot, path) {
  return relative(archiveRoot, path).replaceAll("\\", "/");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
