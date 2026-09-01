import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  isExactHeldR2RepairTarget,
  rehydrateLocalBaselineFromR2,
  restoreInitialOfficialDocumentCandidateArtifactsFromR2,
} from "./r2-baseline-rehydration.mjs";
import { buildInitialOfficialDocumentCandidate } from "./initial-official-document.mjs";
import { preparePublishedInitialOfficialDocumentEvidence } from "./visual-event-evidence.mjs";
import {
  bindVisualTextGeometry,
  sha256VisualSemanticValue,
  verifyVisualScreenshotLayoutCapture,
  verifyVisualTextGeometryBinding,
} from "./visual-event-localization.mjs";
import { visualSnapshotArtifactManifest } from "./visual-review-queue.mjs";
import {
  buildLegacyRetainedProjectionProvenance,
} from "./legacy-r2-retained-projection-provenance.mjs";

const sourceId = "11111111-1111-4111-8111-111111111111";
const awardId = "22222222-2222-4222-8222-222222222222";
const bucket = "awardping-snapshots";
const capturedAt = "2026-07-15T23:00:00.000Z";
const temporaryRoots = [];
const captureWorkerSource = readFileSync(
  new URL("../capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

describe("exact R2 local-baseline rehydration", () => {
  it("admits only one exact held source into R2 repair-only processing", () => {
    const heldSource = {
      id: sourceId,
      admin_review_status: "review_later",
    };
    const exactRepair = {
      source: heldSource,
      sourceIdFilter: sourceId,
      r2SnapshotSync: true,
      r2RepairMissingSnapshots: true,
    };

    expect(isExactHeldR2RepairTarget(exactRepair)).toBe(true);
    expect(isExactHeldR2RepairTarget({
      ...exactRepair,
      sourceIdFilter: "",
    })).toBe(false);
    expect(isExactHeldR2RepairTarget({
      ...exactRepair,
      source: { ...heldSource, id: "33333333-3333-4333-8333-333333333333" },
    })).toBe(false);
    expect(isExactHeldR2RepairTarget({
      ...exactRepair,
      source: { ...heldSource, admin_review_status: "open" },
    })).toBe(false);
    expect(isExactHeldR2RepairTarget({
      ...exactRepair,
      r2SnapshotSync: false,
    })).toBe(false);
    expect(isExactHeldR2RepairTarget({
      ...exactRepair,
      r2RepairMissingSnapshots: false,
    })).toBe(false);
  });

  it("reports the operator-facing local-cache recovery counters", () => {
    for (const key of [
      "r2_rehydrate_local_cache",
      "r2_rehydrated_local",
      "r2_rehydration_refused",
      "r2_rehydration_failed",
      "r2_rehydration_quarantined",
      "r2_rehydration_quarantine_failed",
      "r2_rehydration_quarantines_resolved",
      "r2_rehydration_quarantine_resolve_failed",
      "r2_rehydration_only_completed",
    ]) {
      expect(captureWorkerSource).toMatch(
        new RegExp(`${key}:\\s*report\\.${key}`),
      );
    }
  });

  it("gates incomplete evidence before capture and again before any baseline-writing branch", () => {
    const body = sourceFunctionBody(
      captureWorkerSource,
      "processSourceUnlocked",
      "processLocalizationRepairSource",
    );
    const recovery = body.indexOf("await maybeRehydrateIncompleteLocalBaseline");
    const authoritativeFailureGate = body.indexOf("if (!baseline && recovery.failClosed)");
    const authoritativeFailureThrow = body.indexOf(
      "throw authoritativeR2MissingBaselineError(recovery)",
    );
    const repairOnlyGate = body.indexOf("recovery.quarantineRepairOnly");
    const repairOnlyLog = body.indexOf("R2_REHYDRATION_ONLY_COMPLETE", repairOnlyGate);
    const repairOnlyReturn = body.indexOf("return;", repairOnlyLog);
    const firstGate = body.indexOf("const recoveredEvidence = baseline && !baselineRefresh");
    const firstRefusal = body.indexOf("throw incompleteLocalBaselineError(recoveredEvidence, recovery)");
    const liveCapture = body.indexOf("const pdfSource = isPdfSource(source)");
    const secondGate = body.indexOf("const previous = baseline && !baselineRefresh", liveCapture);
    const refreshWriteBranch = body.indexOf("if (needsCaptureBehaviorRefresh", secondGate);

    expect(recovery).toBeGreaterThan(-1);
    expect(authoritativeFailureGate).toBeGreaterThan(recovery);
    expect(authoritativeFailureThrow).toBeGreaterThan(authoritativeFailureGate);
    expect(authoritativeFailureThrow).toBeLessThan(liveCapture);
    expect(repairOnlyGate).toBeGreaterThan(authoritativeFailureThrow);
    expect(repairOnlyLog).toBeGreaterThan(repairOnlyGate);
    expect(repairOnlyReturn).toBeGreaterThan(repairOnlyLog);
    expect(repairOnlyReturn).toBeLessThan(liveCapture);
    expect(firstGate).toBeGreaterThan(recovery);
    expect(firstRefusal).toBeGreaterThan(firstGate);
    expect(liveCapture).toBeGreaterThan(firstRefusal);
    expect(secondGate).toBeGreaterThan(liveCapture);
    expect(refreshWriteBranch).toBeGreaterThan(secondGate);
  });

  it("treats every review-later source loaded for exact repair as cache-repair-only", () => {
    const recovery = sourceFunctionBody(
      captureWorkerSource,
      "maybeRehydrateIncompleteLocalBaseline",
      "maybeRecoverIncompleteBaselineFromIntakeAcquisition",
    );

    expect(recovery).toContain('source.admin_review_status === "review_later"');
    expect(recovery).not.toContain(
      'source.admin_reviewed_by === "awardping-r2-baseline-recovery"',
    );
    const processBody = sourceFunctionBody(
      captureWorkerSource,
      "processSourceUnlocked",
      "processLocalizationRepairSource",
    );
    const holdGate = processBody.indexOf("if (recovery.quarantineRepairOnly)");
    const holdReturn = processBody.indexOf("return;", holdGate);
    const liveCapture = processBody.indexOf("const pdfSource = isPdfSource(source)");
    expect(holdGate).toBeGreaterThan(-1);
    expect(processBody.slice(holdGate, holdReturn)).not.toContain(
      "baseline &&\n    recovery.quarantineRepairOnly",
    );
    expect(holdReturn).toBeGreaterThan(holdGate);
    expect(holdReturn).toBeLessThan(liveCapture);
    expect(processBody).toContain(
      'SOURCE_REVIEW_HOLD no_live_capture reason=${recovery.failureReason || "review_later"}',
    );
    const existingHoldProtection = processBody.indexOf(
      'if (source.admin_review_status === "open" && !humanReviewOwnsSource)',
    );
    const hygieneMutation = processBody.indexOf("await markSharedSourceReviewLater");
    const recoveryCall = processBody.indexOf("await maybeRehydrateIncompleteLocalBaseline");
    expect(existingHoldProtection).toBeGreaterThan(-1);
    expect(hygieneMutation).toBeGreaterThan(existingHoldProtection);
    expect(existingHoldProtection).toBeLessThan(recoveryCall);
  });

  it("requires a resolved quarantine and a freshly open source before sealed publication", () => {
    const recovery = sourceFunctionBody(
      captureWorkerSource,
      "maybeRehydrateIncompleteLocalBaseline",
      "maybeRecoverIncompleteBaselineFromIntakeAcquisition",
    );
    const materializer = sourceFunctionBody(
      captureWorkerSource,
      "processInitialOfficialDocumentMaterializationOnly",
      "capturePdfSourceForBaseline",
    );
    expect(recovery).toContain("const quarantineResolutionSucceeded = await");
    expect(recovery).toContain("quarantineResolutionSucceeded,");
    expect(materializer).toContain("recovery?.quarantineResolutionSucceeded !== true");
    expect(materializer).toContain('stage: "initial_official_document_pre_publication_review_state"');
    expect(materializer).toContain('currentReviewState.admin_review_status !== "open"');
    expect(materializer).toContain("INITIAL_OFFICIAL_DOCUMENT_REVIEW_HOLD no_sealed_publication");
    const hold = materializer.indexOf("heldRecoveryUnresolved");
    const stop = materializer.indexOf("return;", hold);
    const sealedReplay = materializer.indexOf("await materializeSealedFirstObservationCapture");
    expect(stop).toBeGreaterThan(hold);
    expect(stop).toBeLessThan(sealedReplay);
  });

  it("never probes or captures the live URL after an authoritative missing-baseline restore failure", () => {
    const failureBranch = captureWorkerSource.indexOf(
      "if (error?.r2AuthoritativeRecoveryFailure === true)",
    );
    const quarantineCall = captureWorkerSource.indexOf(
      "await markSharedSourceR2RecoveryQuarantined(source, error, report)",
      failureBranch,
    );
    const ordinaryFailureBranch = captureWorkerSource.indexOf("} else {", quarantineCall);
    const liveProbe = captureWorkerSource.indexOf(
      "await recordBrokenSourceFailure(source, message)",
      ordinaryFailureBranch,
    );
    const missingRecordAllowance = captureWorkerSource.indexOf(
      "if (!snapshotRecordLoadFailed && missingLocalBaseline && !snapshotRecord)",
    );
    const genuineInitialAllowance = captureWorkerSource.indexOf(
      "authoritativeSnapshotPresent: false",
      missingRecordAllowance,
    );

    expect(failureBranch).toBeGreaterThan(-1);
    expect(quarantineCall).toBeGreaterThan(failureBranch);
    expect(ordinaryFailureBranch).toBeGreaterThan(quarantineCall);
    expect(liveProbe).toBeGreaterThan(ordinaryFailureBranch);
    expect(captureWorkerSource.slice(failureBranch, ordinaryFailureBranch)).not.toContain(
      "recordBrokenSourceFailure",
    );
    expect(missingRecordAllowance).toBeGreaterThan(-1);
    expect(genuineInitialAllowance).toBeGreaterThan(missingRecordAllowance);
  });

  it("records and resolves R2 proof failures only through the durable DB quarantine RPCs", () => {
    const resolveBody = sourceFunctionBody(
      captureWorkerSource,
      "maybeResolveR2BaselineRecoveryQuarantine",
      "markSharedSourceR2RecoveryQuarantined",
    );
    const recordBody = sourceFunctionBody(
      captureWorkerSource,
      "markSharedSourceR2RecoveryQuarantined",
      "markSharedSourceVisualCheckFailed",
    );

    expect(resolveBody).toContain('"resolve_r2_baseline_recovery_quarantine"');
    expect(resolveBody).toContain("creates_api_charge: false");
    expect(resolveBody).toContain("rehydrated: recovery.rehydrated === true");
    expect(resolveBody).toContain("reason: cleanText(recovery.reason)");
    expect(resolveBody).toContain("family: recovery.family || null");
    expect(resolveBody).toContain("baseline: {");
    expect(resolveBody).toContain("text_hash: baseline.text_hash || null");
    expect(resolveBody).not.toContain("recovery: {");
    expect(recordBody).toContain('"record_r2_baseline_recovery_quarantine"');
    expect(recordBody).toContain('retry_mode: "manual_exact_r2_rehydration"');
    expect(recordBody).toContain("permits_live_fetch: false");
    expect(recordBody).not.toContain('.from("shared_award_sources")');
  });

  it("atomically restores an authoritative latest baseline when the whole local source directory is missing", async () => {
    const fixture = recoveryFixture();
    const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
    rmSync(sourceDir, { recursive: true, force: true });

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: null,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
      now: "2026-07-16T01:15:00.000Z",
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      rehydrated: true,
      generation: "latest",
      restored_missing_baseline: true,
      restored_missing_source_directory: true,
      localization_status: "exact_geometry_available",
    });
    const published = JSON.parse(readFileSync(fixture.baselinePath, "utf8"));
    expect(published.summary_metadata).toMatchObject({
      reason: "r2_authoritative_local_cache_restore",
      expansion_state_capture_coverage: {
        complete: false,
        status: "incomplete_discovery",
        raw_candidate_count_exact: false,
        logical_candidate_count_exact: false,
        retained_state_count: 0,
      },
      r2_local_rehydration: {
        restored_missing_baseline: true,
        integrity: "verified_before_atomic_baseline_repoint",
      },
    });
    expect(readFileSync(join(fixture.archiveRoot, published.capture.page))).toEqual(fixture.page);
    const meta = JSON.parse(readFileSync(join(fixture.archiveRoot, published.capture.meta), "utf8"));
    expect(meta.expansion_state_capture_coverage).toEqual(
      published.summary_metadata.expansion_state_capture_coverage,
    );
    expect(fixture.snapshot.latest_metadata).not.toHaveProperty(
      "expansion_state_capture_coverage",
    );
    expect(meta.files.page).toBe(published.capture.page);
    expect(meta.text_geometry.file).toBe(published.capture.layout);
    expect(JSON.stringify(meta)).not.toContain("C:\\\\stale");
    expect(readdirSync(join(fixture.archiveRoot, "sources"))).toEqual([sourceId]);
  });

  it.each([
    ["malformed nested coverage", (meta) => {
      meta.expansion_state_capture_coverage = {
        schema: "awardping.expansion-state-capture-coverage.v1",
        complete: "true",
      };
    }],
    ["partial scalar coverage", (meta) => {
      meta.expansion_state_capture_status = "verified_complete";
    }],
  ])("rejects %s instead of synthesizing legacy coverage", async (_name, mutate) => {
    const fixture = recoveryFixture();
    const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
    rmSync(sourceDir, { recursive: true, force: true });
    const metaKey = fixture.snapshot.latest_object_keys.meta;
    const meta = JSON.parse(fixture.objects[metaKey].body.toString("utf8"));
    mutate(meta);
    const metaBytes = Buffer.from(JSON.stringify(meta), "utf8");
    fixture.objects[metaKey] = objectFixture(
      metaBytes,
      "application/json; charset=utf-8",
    );
    fixture.snapshot.latest_metadata.artifact_bindings.meta = rawArtifactBinding(
      metaBytes,
      "application/json; charset=utf-8",
    );

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: null,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      rehydrated: false,
      reason: "r2_authoritative_expansion_coverage_invalid",
    });
    expect(existsSync(sourceDir)).toBe(false);
  });

  it("rehydrates the exact legacy-v0 producer shape conservatively without pointer coverage", async () => {
    const fixture = recoveryFixture();
    const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
    rmSync(sourceDir, { recursive: true, force: true });
    const metaKey = fixture.snapshot.latest_object_keys.meta;
    const meta = JSON.parse(fixture.objects[metaKey].body.toString("utf8"));
    Object.assign(meta, {
      expansion_state_candidates: 0,
      expansion_state_attempted: 0,
      expansion_state_capture_limit: 24,
      expansion_state_capture_complete: true,
      expansion_state_truncated: false,
      expansion_state_truncated_count: 0,
      expansion_state_failures: [],
    });
    const metaBytes = Buffer.from(JSON.stringify(meta), "utf8");
    fixture.objects[metaKey] = objectFixture(
      metaBytes,
      "application/json; charset=utf-8",
    );
    fixture.snapshot.latest_metadata.artifact_bindings.meta = rawArtifactBinding(
      metaBytes,
      "application/json; charset=utf-8",
    );

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: null,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({ rehydrated: true, generation: "latest" });
    const published = JSON.parse(readFileSync(fixture.baselinePath, "utf8"));
    expect(published.summary_metadata.expansion_state_capture_coverage).toMatchObject({
      complete: false,
      status: "incomplete_discovery",
      raw_candidate_count_exact: false,
      logical_candidate_count_exact: false,
      retained_state_count: 0,
    });
    expect(fixture.snapshot.latest_metadata).not.toHaveProperty(
      "expansion_state_capture_coverage",
    );
  });

  it("restores an authoritative PDF bundle with canonical projection parity and no geometry claims", async () => {
    const fixture = pdfRecoveryFixture();
    const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
    rmSync(sourceDir, { recursive: true, force: true });

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: null,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
      now: "2026-07-16T01:15:00.000Z",
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      rehydrated: true,
      recovery_scope: "baseline_evidence",
      localization_status: "not_applicable",
      restored_missing_baseline: true,
      restored_missing_source_directory: true,
    });
    const published = JSON.parse(readFileSync(fixture.baselinePath, "utf8"));
    expect(published.capture).toMatchObject({
      dir: fixture.captureRelative,
      pdf: fixture.paths.pdf,
      text: fixture.paths.text,
      meta: fixture.paths.meta,
      page: null,
      thumb: null,
      layout: null,
      expansion_states: [],
    });
    expect(published).toMatchObject({
      file_hash: fixture.fileHash,
      text_hash: fixture.textHash,
      layout_hash: null,
      text_geometry: null,
      summary_metadata: {
        retained_artifact_projection: fixture.retainedProjection,
      },
    });
    expect(readFileSync(join(fixture.archiveRoot, published.capture.pdf))).toEqual(fixture.pdf);
    const meta = JSON.parse(readFileSync(join(fixture.archiveRoot, published.capture.meta), "utf8"));
    expect(meta.retained_artifact_projection).toMatchObject(fixture.retainedProjection);
    expect(meta.files).toMatchObject({
      pdf: fixture.paths.pdf,
      text: fixture.paths.text,
      meta: fixture.paths.meta,
      layout: null,
      expansion_states: [],
    });
    expect(meta.layout_hash).toBeNull();
    expect(meta.text_geometry).toBeNull();
  });

  it.each([
    ["PDF", pdfRecoveryFixture],
    ["webpage", recoveryFixture],
  ])("rehydrates %s raw projection absence only through exact immutable v7 provenance", async (_kind, createFixture) => {
    const fixture = createFixture();
    const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
    rmSync(sourceDir, { recursive: true, force: true });
    const bridge = bindLegacyRetainedProjectionBridge(fixture);

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: null,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
      now: "2026-07-16T01:20:00.000Z",
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      rehydrated: true,
      generation: "latest",
      restored_missing_baseline: true,
    });
    const immutableRawMeta = JSON.parse(
      fixture.objects[bridge.metaKey].body.toString("utf8"),
    );
    expect(immutableRawMeta).not.toHaveProperty("retained_artifact_projection");
    const published = JSON.parse(readFileSync(fixture.baselinePath, "utf8"));
    const restoredMeta = JSON.parse(
      readFileSync(join(fixture.archiveRoot, published.capture.meta), "utf8"),
    );
    expect(published.summary_metadata.retained_artifact_projection).toMatchObject(
      bridge.projection,
    );
    expect(restoredMeta.retained_artifact_projection).toMatchObject(bridge.projection);
  });

  it.each([
    ["wrong raw-meta hash", (fixture) => {
      fixture.snapshot.latest_metadata
        .legacy_retained_artifact_projection_provenance.raw_meta_sha256 = "f".repeat(64);
    }],
    ["wrong projection hash", (fixture) => {
      fixture.snapshot.latest_metadata
        .legacy_retained_artifact_projection_provenance.projection_sha256 = "e".repeat(64);
    }],
    ["future mutable policy identity", (fixture) => {
      fixture.snapshot.latest_metadata
        .legacy_retained_artifact_projection_provenance.policy_version = "8";
    }],
    ["different policy id", (fixture) => {
      fixture.snapshot.latest_metadata
        .legacy_retained_artifact_projection_provenance.policy_id = "future-migration";
    }],
    ["different policy hash", (fixture) => {
      fixture.snapshot.latest_metadata
        .legacy_retained_artifact_projection_provenance.policy_hash = "d".repeat(64);
    }],
    ["missing pointer projection", (fixture) => {
      delete fixture.snapshot.latest_metadata.retained_artifact_projection;
    }],
    ["partial raw projection claim", (fixture) => {
      rewriteFixtureMeta(fixture, (meta) => {
        meta.retained_artifact_projection = { schema: "partial" };
      });
    }],
    ["valid v7 provenance beside a modern raw projection", (fixture) => {
      const projection = structuredClone(
        fixture.snapshot.latest_metadata.retained_artifact_projection,
      );
      rewriteFixtureMeta(fixture, (meta) => {
        meta.retained_artifact_projection = projection;
      });
      const metaKey = fixture.snapshot.latest_object_keys.meta;
      fixture.snapshot.latest_metadata
        .legacy_retained_artifact_projection_provenance.raw_meta_sha256 = sha256(
          fixture.objects[metaKey].body,
        );
    }],
    ["pointer-only provenance copied into raw meta", (fixture) => {
      rewriteFixtureMeta(fixture, (meta) => {
        meta.legacy_retained_artifact_projection_provenance = structuredClone(
          fixture.snapshot.latest_metadata
            .legacy_retained_artifact_projection_provenance,
        );
      });
    }],
  ])("refuses the v7 raw-absence bridge with %s", async (_name, mutate) => {
    const fixture = pdfRecoveryFixture();
    const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
    rmSync(sourceDir, { recursive: true, force: true });
    bindLegacyRetainedProjectionBridge(fixture);
    mutate(fixture);

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: null,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      rehydrated: false,
      reason: "r2_authoritative_retained_projection_invalid",
    });
    expect(existsSync(sourceDir)).toBe(false);
  });

  it("requires canonical retained-artifact projection parity in pointer and raw metadata", async () => {
    const scenarios = [
      {
        name: "main pointer projection omitted",
        create: recoveryFixture,
        mutate(fixture) {
          delete fixture.snapshot.latest_metadata.retained_artifact_projection;
        },
      },
      {
        name: "main pointer projection hash mismatch",
        create: recoveryFixture,
        mutate(fixture) {
          fixture.snapshot.latest_metadata.retained_artifact_projection.authoritative.layout_hash =
            "e".repeat(64);
        },
      },
      {
        name: "main raw projection omitted",
        create: recoveryFixture,
        mutate(fixture) {
          rewriteFixtureMeta(fixture, (meta) => {
            delete meta.retained_artifact_projection;
          });
        },
      },
      {
        name: "main raw projection hash mismatch",
        create: recoveryFixture,
        mutate(fixture) {
          rewriteFixtureMeta(fixture, (meta) => {
            meta.retained_artifact_projection.authoritative.layout_hash = "f".repeat(64);
          });
        },
      },
      {
        name: "hybrid pointer projection omitted",
        create: makeHybridExpansionRecoveryFixture,
        mutate(fixture) {
          delete fixture.snapshot.latest_metadata.retained_artifact_projection;
        },
      },
      {
        name: "hybrid raw projection count mismatch",
        create: makeHybridExpansionRecoveryFixture,
        mutate(fixture) {
          rewriteFixtureMeta(fixture, (meta) => {
            meta.retained_artifact_projection.authoritative.expansion_state_count = 0;
          });
        },
      },
      {
        name: "PDF raw projection omitted",
        create: pdfRecoveryFixture,
        mutate(fixture) {
          rewriteFixtureMeta(fixture, (meta) => {
            delete meta.retained_artifact_projection;
          });
        },
      },
    ];

    for (const scenario of scenarios) {
      const fixture = scenario.create();
      const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
      rmSync(sourceDir, { recursive: true, force: true });
      scenario.mutate(fixture);

      const result = await rehydrateLocalBaselineFromR2({
        archiveRoot: fixture.archiveRoot,
        source: fixture.source,
        baseline: null,
        snapshotRecord: fixture.snapshot,
        bucket,
        client: fakeR2Client(fixture.objects),
      });

      expect(result, scenario.name).toMatchObject({
        rehydrated: false,
        reason: "r2_authoritative_retained_projection_invalid",
      });
      expect(existsSync(sourceDir), scenario.name).toBe(false);
    }
  });

  it("rejects unsafe, cross-source, cross-capture, and wrong-role authoritative local paths", async () => {
    const scenarios = [
      ["traversal", `sources/${sourceId}/captures/../page.jpg`],
      ["absolute", `C:/AwardPing/sources/${sourceId}/captures/original/page.jpg`],
      [
        "cross source",
        "sources/33333333-3333-4333-8333-333333333333/captures/2026-07-15T23-00-00-000Z/page.jpg",
      ],
      ["cross capture", `sources/${sourceId}/captures/a-different-capture/page.jpg`],
      [
        "wrong role filename",
        `sources/${sourceId}/captures/2026-07-15T23-00-00-000Z/document.pdf`,
      ],
    ];

    for (const [name, pagePath] of scenarios) {
      const fixture = recoveryFixture();
      const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
      rmSync(sourceDir, { recursive: true, force: true });
      rewriteFixtureMeta(fixture, (meta) => {
        meta.files.page = pagePath;
      });

      const result = await rehydrateLocalBaselineFromR2({
        archiveRoot: fixture.archiveRoot,
        source: fixture.source,
        baseline: null,
        snapshotRecord: fixture.snapshot,
        bucket,
        client: fakeR2Client(fixture.objects),
      });

      expect(result, name).toMatchObject({
        rehydrated: false,
        reason: "r2_authoritative_local_path_invalid",
      });
      expect(existsSync(sourceDir), name).toBe(false);
    }
  });

  it("rejects geometry references that do not use the validated original screenshot path", async () => {
    const fixture = recoveryFixture();
    const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
    rmSync(sourceDir, { recursive: true, force: true });
    rewriteFixtureMeta(fixture, (meta) => {
      meta.text_geometry.screenshot.image_ref = fixture.paths.thumb;
    });

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: null,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      rehydrated: false,
      reason: "r2_authoritative_geometry_path_mismatch",
    });
    expect(existsSync(sourceDir)).toBe(false);
  });

  it("surfaces an unavailable exact generation without replacing or rolling back the baseline", async () => {
    const fixture = recoveryFixture();
    writeBaselineFixture(fixture);
    const originalBaseline = readFileSync(fixture.baselinePath);
    fixture.snapshot.latest_captured_at = "2026-07-14T23:00:00.000Z";

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: fixture.baseline,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      rehydrated: false,
      reason: "exact_r2_generation_unavailable",
    });
    expect(readFileSync(fixture.baselinePath)).toEqual(originalBaseline);
    expect(readdirSync(join(fixture.archiveRoot, "sources", sourceId))).toEqual([
      "baseline.json",
    ]);
  });

  it("fails a whole-directory restore closed on tampered or cross-source R2 evidence", async () => {
    for (const scenario of ["tamper", "cross_source"]) {
      const fixture = recoveryFixture();
      const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
      rmSync(sourceDir, { recursive: true, force: true });
      if (scenario === "tamper") {
        const pageKey = fixture.snapshot.latest_object_keys.page;
        fixture.objects[pageKey] = objectFixture(Buffer.from("tampered page bytes"), "image/jpeg");
      } else {
        fixture.snapshot.latest_object_keys.layout = fixture.snapshot.latest_object_keys.layout.replace(
          sourceId,
          "33333333-3333-4333-8333-333333333333",
        );
      }

      const result = await rehydrateLocalBaselineFromR2({
        archiveRoot: fixture.archiveRoot,
        source: fixture.source,
        baseline: null,
        snapshotRecord: fixture.snapshot,
        bucket,
        client: fakeR2Client(fixture.objects),
      });

      expect(result).toMatchObject({
        rehydrated: false,
        reason: scenario === "tamper"
          ? "r2_object_sha256_mismatch"
          : "r2_object_key_source_mismatch",
      });
      expect(existsSync(sourceDir)).toBe(false);
    }
  });

  it("requires exact source, award, bucket, kind, and content-length identity for a missing baseline", async () => {
    const scenarios = [
      ["source", "r2_snapshot_source_mismatch"],
      ["award", "r2_snapshot_award_mismatch"],
      ["bucket", "r2_snapshot_bucket_mismatch"],
      ["kind", "r2_meta_kind_mismatch"],
      ["length", "r2_authoritative_length_binding_missing"],
    ];
    for (const [scenario, reason] of scenarios) {
      const fixture = recoveryFixture();
      const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
      rmSync(sourceDir, { recursive: true, force: true });
      let requestedBucket = bucket;
      if (scenario === "source") {
        fixture.snapshot.shared_award_source_id = "33333333-3333-4333-8333-333333333333";
      } else if (scenario === "award") {
        fixture.snapshot.shared_award_id = "33333333-3333-4333-8333-333333333333";
      } else if (scenario === "bucket") {
        requestedBucket = "wrong-bucket";
      } else if (scenario === "kind") {
        rewriteFixtureMeta(fixture, (meta) => {
          meta.kind = "pdf";
        });
      } else if (scenario === "length") {
        delete fixture.snapshot.latest_metadata.page_bytes;
      }

      const result = await rehydrateLocalBaselineFromR2({
        archiveRoot: fixture.archiveRoot,
        source: fixture.source,
        baseline: null,
        snapshotRecord: fixture.snapshot,
        bucket: requestedBucket,
        client: fakeR2Client(fixture.objects),
      });

      expect(result, scenario).toMatchObject({ rehydrated: false, reason });
      expect(existsSync(sourceDir), scenario).toBe(false);
    }
  });

  it("refuses a whole-directory restore when the local source path is already a conflicting entry", async () => {
    const fixture = recoveryFixture();
    const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
    rmSync(sourceDir, { recursive: true, force: true });
    writeFileSync(sourceDir, "do not overwrite this local conflict", "utf8");

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: null,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      rehydrated: false,
      reason: "local_source_directory_conflict",
    });
    expect(readFileSync(sourceDir, "utf8")).toBe("do not overwrite this local conflict");
  });

  it("validates and atomically publishes an exact latest generation at its original capture paths", async () => {
    const fixture = recoveryFixture();
    const previousCapture = {
      dir: `sources/${sourceId}/captures/last-known-good`,
      page: `sources/${sourceId}/captures/last-known-good/page.jpg`,
    };
    fixture.baseline.summary_metadata.previous_baseline_capture = previousCapture;
    fixture.baseline.summary_metadata.baseline_facts = { deadline: "March 15" };
    writeBaselineFixture(fixture);
    const client = fakeR2Client(fixture.objects);
    const sentLabels = [];

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: fixture.baseline,
      snapshotRecord: fixture.snapshot,
      bucket,
      client,
      sendCommand: (createCommand, label) => {
        sentLabels.push(label);
        return client.send(createCommand());
      },
      now: "2026-07-16T01:00:00.000Z",
    });

    expect(result.rehydrated, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({
      rehydrated: true,
      generation: "latest",
      artifact_count: 5,
    });
    const published = JSON.parse(readFileSync(fixture.baselinePath, "utf8"));
    expect(published.summary_metadata.previous_baseline_capture).toEqual(previousCapture);
    expect(sentLabels).toHaveLength(10);
    expect(published.summary_metadata.baseline_facts).toEqual({ deadline: "March 15" });
    expect(published.summary_metadata.r2_local_rehydration).toMatchObject({
      generation: "latest",
      integrity: "verified_before_atomic_baseline_repoint",
    });
    expect(published.capture.dir).toBe(fixture.captureRelative);
    expect(readFileSync(join(fixture.archiveRoot, published.capture.page))).toEqual(fixture.page);

    const meta = JSON.parse(readFileSync(join(fixture.archiveRoot, published.capture.meta), "utf8"));
    expect(meta.files.page).toBe(published.capture.page);
    expect(meta.files.sections_json).toBeNull();
    expect(meta.text_geometry.file).toBe(published.capture.layout);
    expect(meta.text_geometry.screenshot.image_ref).toBe(published.capture.page);
    expect(meta.browser.executable_path).toBeUndefined();
    expect(meta.expandable_sections[0].section_path).toBe("main>details:nth-of-type(1)");
    expect(JSON.stringify(meta)).not.toContain("C:\\\\stale");
    const layout = JSON.parse(readFileSync(join(fixture.archiveRoot, published.capture.layout), "utf8"));
    expect(layout.screenshot.image_ref).toBe(published.capture.page);
    expect(layout.nodes[0]).toMatchObject({
      path: "main>p:nth-of-type(1)",
      flow_path: "body>main>p:nth-of-type(1)",
    });
    expect(layout.geometry_hash).toBe(published.layout_hash);
    expect(layout.screenshot.alignment_status).toBe("verified");
    expect(layout.capture_verification).toMatchObject({
      status: "verified",
      screenshot_alignment: "verified",
    });
    expect(layout.capture_verification.restored_proof_recomputed).toBeUndefined();
    expect(readFileSync(join(fixture.archiveRoot, published.capture.layout))).toEqual(
      fixture.objects[fixture.snapshot.latest_object_keys.layout].body,
    );
    expect(verifyVisualTextGeometryBinding(layout, published.image_hash)).toMatchObject({ valid: true });
  });

  it("recomputes contradictory restored alignment and capture proof instead of preserving verified claims", async () => {
    const fixture = recoveryFixture();
    const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
    rmSync(sourceDir, { recursive: true, force: true });
    const layoutKey = fixture.snapshot.latest_object_keys.layout;
    const malformed = JSON.parse(fixture.objects[layoutKey].body.toString("utf8"));
    malformed.screenshot.pixel_height = 1200;
    malformed.screenshot.scale_y = 0.5;
    malformed.screenshot.alignment_status = "verified";
    delete malformed.geometry_hash;
    malformed.geometry_hash = sha256VisualSemanticValue(malformed);
    const malformedBody = Buffer.from(JSON.stringify(malformed), "utf8");
    fixture.objects[layoutKey] = objectFixture(
      malformedBody,
      "application/json; charset=utf-8",
    );
    fixture.snapshot.latest_metadata.artifact_bindings.layout = rawArtifactBinding(
      malformedBody,
      "application/json; charset=utf-8",
    );
    fixture.snapshot.latest_hashes.layout_hash = malformed.geometry_hash;
    fixture.snapshot.latest_metadata.layout_hash = malformed.geometry_hash;
    fixture.snapshot.latest_metadata.text_geometry = {
      ...structuredClone(malformed),
      file: fixture.paths.layout,
    };
    fixture.snapshot.latest_metadata.retained_artifact_projection.authoritative.layout_hash =
      malformed.geometry_hash;
    const metaKey = fixture.snapshot.latest_object_keys.meta;
    const meta = JSON.parse(fixture.objects[metaKey].body.toString("utf8"));
    meta.layout_hash = malformed.geometry_hash;
    meta.text_geometry = {
      ...structuredClone(malformed),
      file: fixture.paths.layout,
    };
    meta.retained_artifact_projection.authoritative.layout_hash = malformed.geometry_hash;
    const metaBody = Buffer.from(JSON.stringify(meta), "utf8");
    fixture.objects[metaKey] = objectFixture(metaBody, "application/json; charset=utf-8");
    fixture.snapshot.latest_metadata.artifact_bindings.meta = rawArtifactBinding(
      metaBody,
      "application/json; charset=utf-8",
    );

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: null,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
      now: "2026-07-16T01:15:00.000Z",
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      rehydrated: true,
      recovery_scope: "baseline_evidence_only",
      localization_recovered: false,
      localization_status: "evidence_only_geometry_verification_unavailable",
    });
    const published = JSON.parse(readFileSync(fixture.baselinePath, "utf8"));
    expect(published.layout_hash).toBeNull();
    expect(published.text_geometry).toBeNull();
    expect(published.capture.layout).toBeNull();
    const diagnosticLayoutPath = join(fixture.archiveRoot, fixture.paths.layout);
    expect(readFileSync(diagnosticLayoutPath)).toEqual(malformedBody);
    expect(published.summary_metadata.r2_local_rehydration).toMatchObject({
      localization_recovered: false,
      localization_status: "evidence_only_geometry_verification_unavailable",
      main_geometry_verified: false,
    });
    const restoredMeta = JSON.parse(
      readFileSync(join(fixture.archiveRoot, published.capture.meta), "utf8"),
    );
    expect(restoredMeta.layout_hash).toBeNull();
    expect(restoredMeta.text_geometry).toBeNull();
    expect(restoredMeta.files.layout).toBeNull();
    expect(restoredMeta.retained_artifact_projection).toMatchObject({
      authoritative: {
        layout_retained: false,
        layout_hash: null,
        expansion_state_count: 0,
      },
    });
    expect(restoredMeta.localization).toMatchObject({
      status: "unavailable",
      unavailable_reason: "evidence_only_geometry_verification_unavailable",
    });
  });

  it("selects previous only when latest does not exactly match the baseline", async () => {
    const fixture = recoveryFixture();
    fixture.snapshot.previous_captured_at = fixture.snapshot.latest_captured_at;
    fixture.snapshot.previous_hashes = fixture.snapshot.latest_hashes;
    fixture.snapshot.previous_metadata = fixture.snapshot.latest_metadata;
    fixture.snapshot.previous_object_keys = Object.fromEntries(
      Object.entries(fixture.snapshot.latest_object_keys).map(([slot, key]) => [
        slot,
        key.replace(
          "/captures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
          "/approved/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
        ),
      ]),
    );
    fixture.objects = remapObjects(
      fixture.objects,
      "/captures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      "/approved/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
    );
    fixture.snapshot.latest_captured_at = "2026-07-16T00:00:00.000Z";
    fixture.snapshot.latest_hashes = {
      ...fixture.snapshot.latest_hashes,
      image_hash: sha256("some newer page"),
    };
    writeBaselineFixture(fixture);

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: fixture.baseline,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      rehydrated: true,
      generation: "previous",
      family: "approved",
    });
    const published = JSON.parse(readFileSync(fixture.baselinePath, "utf8"));
    expect(published.capture.dir).toBe(fixture.captureRelative);
    expect(published.summary_metadata.r2_local_rehydration.generation).toBe("previous");
  });

  it("rehydrates a legacy approved generation as evidence-only when geometry was never retained", async () => {
    const fixture = recoveryFixture();
    delete fixture.snapshot.latest_metadata.artifact_bindings_schema;
    delete fixture.snapshot.latest_metadata.artifact_bindings;
    delete fixture.snapshot.latest_metadata.retained_artifact_projection;
    rewriteFixtureMeta(fixture, (meta) => {
      delete meta.retained_artifact_projection;
    });
    fixture.snapshot.latest_object_keys = Object.fromEntries(
      Object.entries(fixture.snapshot.latest_object_keys)
        .filter(([slot]) => slot !== "layout")
        .map(([slot, key]) => [
          slot,
          key.replace(
            "/captures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
            "/approved/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
          ),
        ]),
    );
    fixture.objects = remapObjects(
      Object.fromEntries(
        Object.entries(fixture.objects).filter(([key]) => !key.endsWith("/layout.json")),
      ),
      "/captures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      "/approved/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
    );
    writeBaselineFixture(fixture);

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: fixture.baseline,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      rehydrated: true,
      family: "approved",
      reason: "exact_r2_generation_rehydrated_evidence_only_geometry_unavailable",
      recovery_scope: "baseline_evidence_only",
      localization_recovered: false,
      localization_status: "evidence_only_geometry_unavailable",
    });
    const published = JSON.parse(readFileSync(fixture.baselinePath, "utf8"));
    expect(published.layout_hash).toBeNull();
    expect(published.text_geometry).toBeNull();
    expect(published.capture.layout).toBeNull();
    expect(published.summary_metadata.r2_local_rehydration).toMatchObject({
      recovery_scope: "baseline_evidence_only",
      localization_status: "evidence_only_geometry_unavailable",
      localization_recovered: false,
      legacy_approved_without_geometry: true,
    });
    const meta = JSON.parse(readFileSync(join(fixture.archiveRoot, published.capture.meta), "utf8"));
    expect(meta.text_geometry).toBeNull();
    expect(meta.localization).toMatchObject({
      status: "unavailable",
      unavailable_reason: "evidence_only_geometry_unavailable",
    });
  });

  it("restores a verified opened-accordion image and its bound text geometry", async () => {
    const fixture = recoveryFixture();
    addExpansionState(fixture);
    writeBaselineFixture(fixture);

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: fixture.baseline,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      rehydrated: true,
      artifact_count: 7,
      recovery_scope: "baseline_and_localization_evidence",
      localization_recovered: true,
      localization_status: "exact_geometry_available",
    });
    const published = JSON.parse(readFileSync(fixture.baselinePath, "utf8"));
    expect(published.capture.expansion_states).toHaveLength(1);
    const state = published.capture.expansion_states[0];
    expect(state).toMatchObject({
      state_id: "expansion-state-01",
      label: "Eligibility",
      image_hash: fixture.expansionImageHash,
      layout_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(readFileSync(join(fixture.archiveRoot, state.page))).toEqual(fixture.expansionPage);
    const layout = JSON.parse(readFileSync(join(fixture.archiveRoot, state.layout), "utf8"));
    expect(layout.screenshot.image_ref).toBe(state.page);
    expect(layout.nodes[0]).toMatchObject({
      path: "main>details:nth-of-type(1)>p",
      flow_path: "body>main>details:nth-of-type(1)>p",
    });
    expect(layout.geometry_hash).toBe(state.layout_hash);
    expect(layout.geometry_hash).toBe(fixture.expansionLayoutHash);
    expect(published.layout_hash).toBe(fixture.layoutHash);
    expect(published.summary_metadata.retained_artifact_projection).toMatchObject({
      authoritative: {
        layout_retained: true,
        layout_hash: fixture.layoutHash,
        expansion_state_count: 1,
      },
    });
    const meta = JSON.parse(readFileSync(join(fixture.archiveRoot, published.capture.meta), "utf8"));
    expect(meta.retained_artifact_projection).toMatchObject({
      authoritative: {
        layout_retained: true,
        layout_hash: fixture.layoutHash,
        expansion_state_count: 1,
      },
    });
    expect(readFileSync(join(fixture.archiveRoot, published.capture.layout))).toEqual(
      fixture.objects[fixture.snapshot.latest_object_keys.layout].body,
    );
    expect(readFileSync(join(fixture.archiveRoot, state.layout))).toEqual(
      fixture.objects[fixture.snapshot.latest_object_keys.expansion_state_01_layout].body,
    );
    expect(verifyVisualTextGeometryBinding(layout, fixture.expansionImageHash)).toMatchObject({
      valid: true,
    });
  });

  it("restores exact expansion localization when main-page geometry is explicitly unavailable", async () => {
    const fixture = makeHybridExpansionRecoveryFixture();
    const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
    rmSync(sourceDir, { recursive: true, force: true });

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: null,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
      now: "2026-07-16T01:15:00.000Z",
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      rehydrated: true,
      reason: "exact_r2_generation_rehydrated_with_exact_expansion_geometry",
      recovery_scope: "baseline_and_expansion_localization_evidence",
      localization_recovered: false,
      expansion_localization_recovered: true,
      expansion_localization_status: "exact_geometry_available",
      localization_status: "exact_expansion_geometry_available",
      restored_missing_baseline: true,
    });
    const published = JSON.parse(readFileSync(fixture.baselinePath, "utf8"));
    expect(published).toMatchObject({
      layout_hash: null,
      text_geometry: null,
      capture: {
        layout: null,
        expansion_states: [{
          state_id: "expansion-state-01",
          image_hash: fixture.expansionImageHash,
          layout_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }],
      },
      summary_metadata: {
        baseline_facts_metadata: {
          status: "verified",
          evidence_source: "retained_capture",
        },
        monitoring_disposition: {
          classification: "substantive_baseline",
          reason: "stage1_activation",
        },
        stage1_baseline_activation: {
          status: "verified",
          plan_sha256: "a".repeat(64),
        },
        retained_artifact_projection: {
          schema: "awardping.capture-retained-artifact-projection.v1",
          kind: "webpage",
          localization_status: "evidence_only_geometry_unavailable",
          authoritative: {
            layout_retained: false,
            layout_hash: null,
            expansion_state_count: 1,
          },
        },
        r2_local_rehydration: {
          localization_status: "exact_expansion_geometry_available",
          localization_recovered: false,
          expansion_localization_recovered: true,
          expansion_localization_status: "exact_geometry_available",
          main_geometry_available: false,
          main_geometry_verified: false,
          expected_expansion_states: 1,
          complete_expansion_states: 1,
          verified_expansion_states: 1,
        },
      },
    });

    const state = published.capture.expansion_states[0];
    expect(readFileSync(join(fixture.archiveRoot, state.page))).toEqual(fixture.expansionPage);
    const layout = JSON.parse(readFileSync(join(fixture.archiveRoot, state.layout), "utf8"));
    expect(verifyVisualTextGeometryBinding(layout, fixture.expansionImageHash)).toMatchObject({
      valid: true,
    });
    const meta = JSON.parse(readFileSync(join(fixture.archiveRoot, published.capture.meta), "utf8"));
    expect(meta).toMatchObject({
      layout_hash: null,
      text_geometry: null,
      localization: {
        status: "unavailable_layout_changed_during_screenshot",
        accounted_for: true,
        geometry_ready: false,
        unavailable_reason: fixture.unavailableReason,
        geometry_hash: null,
        bound_image_hash: null,
      },
      expansion_localization: {
        status: "exact_geometry_available",
        exact: true,
        geometry_ready: true,
        expected_state_count: 1,
        verified_state_count: 1,
      },
      baseline_facts_metadata: published.summary_metadata.baseline_facts_metadata,
      monitoring_disposition: published.summary_metadata.monitoring_disposition,
      stage1_baseline_activation: published.summary_metadata.stage1_baseline_activation,
      retained_artifact_projection: {
        schema: "awardping.capture-retained-artifact-projection.v1",
        kind: "webpage",
        localization_status: "evidence_only_geometry_unavailable",
        authoritative: {
          layout_retained: false,
          layout_hash: null,
          expansion_state_count: 1,
        },
      },
      r2_local_rehydration: {
        localization_status: "exact_expansion_geometry_available",
        expansion_localization_recovered: true,
      },
    });
  });

  it("refuses missing-baseline hybrid recovery unless main unavailability is explicit and non-contradictory", async () => {
    const scenarios = [
      {
        name: "pointer omission",
        mutate(fixture) {
          delete fixture.snapshot.latest_metadata.localization;
        },
      },
      {
        name: "pointer exact-localization contradiction",
        mutate(fixture) {
          fixture.snapshot.latest_metadata.localization.exact = true;
        },
      },
      {
        name: "raw metadata geometry-ready contradiction",
        mutate(fixture) {
          rewriteFixtureMeta(fixture, (meta) => {
            meta.localization.geometry_ready = true;
          });
        },
      },
      {
        name: "raw metadata layout-hash contradiction",
        mutate(fixture) {
          rewriteFixtureMeta(fixture, (meta) => {
            meta.layout_hash = "f".repeat(64);
          });
        },
      },
    ];

    for (const scenario of scenarios) {
      const fixture = makeHybridExpansionRecoveryFixture();
      const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
      rmSync(sourceDir, { recursive: true, force: true });
      scenario.mutate(fixture);

      const result = await rehydrateLocalBaselineFromR2({
        archiveRoot: fixture.archiveRoot,
        source: fixture.source,
        baseline: null,
        snapshotRecord: fixture.snapshot,
        bucket,
        client: fakeR2Client(fixture.objects),
      });

      expect(result, scenario.name).toMatchObject({
        rehydrated: false,
        reason: "r2_authoritative_layout_unavailability_invalid",
      });
      expect(existsSync(sourceDir), scenario.name).toBe(false);
    }
  });

  it("does not call hybrid expansion localization exact when restored geometry verification fails", async () => {
    const fixture = makeHybridExpansionRecoveryFixture();
    const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
    rmSync(sourceDir, { recursive: true, force: true });
    const layoutKey = fixture.snapshot.latest_object_keys.expansion_state_01_layout;
    const malformed = JSON.parse(fixture.objects[layoutKey].body.toString("utf8"));
    malformed.screenshot.pixel_height = 1300;
    malformed.screenshot.scale_y = 0.5;
    malformed.screenshot.alignment_status = "verified";
    delete malformed.geometry_hash;
    malformed.geometry_hash = sha256VisualSemanticValue(malformed);
    const malformedBody = Buffer.from(JSON.stringify(malformed), "utf8");
    fixture.objects[layoutKey] = objectFixture(
      malformedBody,
      "application/json; charset=utf-8",
    );
    const pointerState = fixture.snapshot.latest_metadata.expansion_state_screenshots[0];
    pointerState.layout_hash = malformed.geometry_hash;
    pointerState.text_geometry = {
      ...structuredClone(malformed),
      file: `${fixture.captureRelative}/expansion-state-01-layout.json`,
    };
    fixture.snapshot.latest_metadata.artifact_bindings.expansion_state_01_layout =
      rawArtifactBinding(malformedBody, "application/json; charset=utf-8");
    rewriteFixtureMeta(fixture, (meta) => {
      const rawState = meta.expansion_state_screenshots[0];
      rawState.layout_hash = malformed.geometry_hash;
      rawState.text_geometry.geometry_hash = malformed.geometry_hash;
      rawState.text_geometry.screenshot = structuredClone(malformed.screenshot);
    });

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: null,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      rehydrated: true,
      localization_status: "evidence_only_geometry_unavailable",
      localization_recovered: false,
      expansion_localization_recovered: false,
      expansion_localization_status: "unavailable",
      recovery_scope: "baseline_evidence_only",
    });
    const published = JSON.parse(readFileSync(fixture.baselinePath, "utf8"));
    expect(published.layout_hash).toBeNull();
    expect(published.text_geometry).toBeNull();
    expect(published.capture.expansion_states).toEqual([]);
    expect(published.summary_metadata.retained_artifact_projection).toMatchObject({
      authoritative: {
        layout_retained: false,
        layout_hash: null,
        expansion_state_count: 0,
      },
    });
    expect(readFileSync(
      join(fixture.archiveRoot, fixture.captureRelative, "expansion-state-01-layout.json"),
    )).toEqual(malformedBody);
    const restoredMeta = JSON.parse(
      readFileSync(join(fixture.archiveRoot, published.capture.meta), "utf8"),
    );
    expect(restoredMeta.expansion_state_count).toBe(0);
    expect(restoredMeta.expansion_state_screenshots).toEqual([]);
    expect(restoredMeta.files.expansion_states).toEqual([]);
  });

  it("refuses an expansion layout whose declared semantic hash does not bind its original body", async () => {
    const fixture = makeHybridExpansionRecoveryFixture();
    const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
    rmSync(sourceDir, { recursive: true, force: true });
    const layoutKey = fixture.snapshot.latest_object_keys.expansion_state_01_layout;
    const malformed = JSON.parse(fixture.objects[layoutKey].body.toString("utf8"));
    malformed.captured_at = "2026-07-15T23:00:01.000Z";
    const malformedBody = Buffer.from(JSON.stringify(malformed), "utf8");
    fixture.objects[layoutKey] = objectFixture(
      malformedBody,
      "application/json; charset=utf-8",
    );
    fixture.snapshot.latest_metadata.artifact_bindings.expansion_state_01_layout =
      rawArtifactBinding(malformedBody, "application/json; charset=utf-8");

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: null,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      rehydrated: false,
      reason: "r2_authoritative_expansion_layout_binding_invalid",
    });
    expect(existsSync(sourceDir)).toBe(false);
  });

  it("requires an exact manifest-wide raw artifact-binding map before hybrid recovery", async () => {
    const scenarios = [
      {
        name: "missing core binding",
        mutate(fixture) {
          delete fixture.snapshot.latest_metadata.artifact_bindings.meta;
        },
      },
      {
        name: "unexpected binding slot",
        mutate(fixture) {
          fixture.snapshot.latest_metadata.artifact_bindings.diagnostic = structuredClone(
            fixture.snapshot.latest_metadata.artifact_bindings.page,
          );
        },
      },
      {
        name: "metadata bytes differ from pointer binding",
        mutate(fixture) {
          const metaKey = fixture.snapshot.latest_object_keys.meta;
          const meta = JSON.parse(fixture.objects[metaKey].body.toString("utf8"));
          meta.stage1_baseline_activation.plan_sha256 = "b".repeat(64);
          fixture.objects[metaKey] = objectFixture(
            Buffer.from(JSON.stringify(meta), "utf8"),
            "application/json; charset=utf-8",
          );
        },
      },
    ];

    for (const scenario of scenarios) {
      const fixture = makeHybridExpansionRecoveryFixture();
      const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
      rmSync(sourceDir, { recursive: true, force: true });
      scenario.mutate(fixture);

      const result = await rehydrateLocalBaselineFromR2({
        archiveRoot: fixture.archiveRoot,
        source: fixture.source,
        baseline: null,
        snapshotRecord: fixture.snapshot,
        bucket,
        client: fakeR2Client(fixture.objects),
      });

      expect(result, scenario.name).toMatchObject({
        rehydrated: false,
        reason: "r2_authoritative_artifact_binding_invalid",
      });
      expect(existsSync(sourceDir), scenario.name).toBe(false);
    }
  });

  it("rejects negative expansion counts even when no expansion artifacts exist", async () => {
    for (const surface of ["pointer", "downloaded metadata"]) {
      const fixture = recoveryFixture();
      const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
      rmSync(sourceDir, { recursive: true, force: true });
      if (surface === "pointer") {
        fixture.snapshot.latest_metadata.expansion_state_count = -1;
      } else {
        rewriteFixtureMeta(fixture, (meta) => {
          meta.expansion_state_count = -1;
        });
      }

      const result = await rehydrateLocalBaselineFromR2({
        archiveRoot: fixture.archiveRoot,
        source: fixture.source,
        baseline: null,
        snapshotRecord: fixture.snapshot,
        bucket,
        client: fakeR2Client(fixture.objects),
      });

      expect(result, surface).toMatchObject({
        rehydrated: false,
        reason: "r2_authoritative_expansion_metadata_invalid",
      });
      expect(existsSync(sourceDir), surface).toBe(false);
    }
  });

  it("refuses incomplete or contradictory authoritative expansion bindings", async () => {
    const scenarios = [
      {
        name: "missing paired layout",
        reason: "r2_authoritative_expansion_layout_incomplete",
        mutate(fixture) {
          const key = fixture.snapshot.latest_object_keys.expansion_state_01_layout;
          delete fixture.snapshot.latest_object_keys.expansion_state_01_layout;
          delete fixture.snapshot.latest_metadata.artifact_bindings.expansion_state_01_layout;
          delete fixture.objects[key];
        },
      },
      {
        name: "raw geometry hash contradiction",
        reason: "r2_authoritative_expansion_layout_binding_invalid",
        mutate(fixture) {
          rewriteFixtureMeta(fixture, (meta) => {
            meta.expansion_state_screenshots[0].layout_hash = "e".repeat(64);
          });
        },
      },
      {
        name: "raw file-reference contradiction",
        reason: "r2_authoritative_expansion_layout_binding_invalid",
        mutate(fixture) {
          rewriteFixtureMeta(fixture, (meta) => {
            meta.files.expansion_states[0].layout = "C:\\stale\\unrelated-layout.json";
          });
        },
      },
      {
        name: "raw artifact binding contradiction",
        reason: "r2_authoritative_expansion_artifact_binding_invalid",
        mutate(fixture) {
          fixture.snapshot.latest_metadata.artifact_bindings.expansion_state_01_layout.sha256 =
            "d".repeat(64);
        },
      },
    ];

    for (const scenario of scenarios) {
      const fixture = makeHybridExpansionRecoveryFixture();
      const sourceDir = join(fixture.archiveRoot, "sources", sourceId);
      rmSync(sourceDir, { recursive: true, force: true });
      scenario.mutate(fixture);

      const result = await rehydrateLocalBaselineFromR2({
        archiveRoot: fixture.archiveRoot,
        source: fixture.source,
        baseline: null,
        snapshotRecord: fixture.snapshot,
        bucket,
        client: fakeR2Client(fixture.objects),
      });

      expect(result, scenario.name).toMatchObject({
        rehydrated: false,
        reason: scenario.reason,
      });
      expect(existsSync(sourceDir), scenario.name).toBe(false);
    }
  });

  it("fails closed when an authoritative retained accordion image has no paired layout", async () => {
    const fixture = recoveryFixture();
    addExpansionState(fixture);
    const layoutKey = fixture.snapshot.latest_object_keys.expansion_state_01_layout;
    delete fixture.snapshot.latest_object_keys.expansion_state_01_layout;
    delete fixture.snapshot.latest_metadata.artifact_bindings.expansion_state_01_layout;
    delete fixture.objects[layoutKey];
    writeBaselineFixture(fixture);

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: fixture.baseline,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      rehydrated: false,
      reason: "r2_authoritative_expansion_layout_incomplete",
    });
    expect(JSON.parse(readFileSync(fixture.baselinePath, "utf8"))).toEqual(fixture.baseline);
  });

  it("fails closed on a byte-hash mismatch and removes all staged output", async () => {
    const fixture = recoveryFixture();
    writeBaselineFixture(fixture);
    const originalBaseline = readFileSync(fixture.baselinePath);
    fixture.objects[fixture.snapshot.latest_object_keys.page] = {
      ...fixture.objects[fixture.snapshot.latest_object_keys.page],
      body: Buffer.from("tampered page bytes"),
    };

    const result = await rehydrateLocalBaselineFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      baseline: fixture.baseline,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      rehydrated: false,
      reason: "r2_object_sha256_mismatch",
    });
    expect(readFileSync(fixture.baselinePath)).toEqual(originalBaseline);
    expect(recoveryDirectories(fixture.archiveRoot)).toEqual([]);
  });

  it("rejects mutable keys and partial downloads without repointing the baseline", async () => {
    const mutable = recoveryFixture();
    writeBaselineFixture(mutable);
    const originalMutableBaseline = readFileSync(mutable.baselinePath);
    mutable.snapshot.latest_object_keys.page =
      `visual-snapshots/sources/${sourceId}/latest/page.jpg`;

    const mutableResult = await rehydrateLocalBaselineFromR2({
      archiveRoot: mutable.archiveRoot,
      source: mutable.source,
      baseline: mutable.baseline,
      snapshotRecord: mutable.snapshot,
      bucket,
      client: fakeR2Client(mutable.objects),
    });
    expect(mutableResult).toMatchObject({
      rehydrated: false,
      reason: "r2_object_key_not_immutable",
    });
    expect(readFileSync(mutable.baselinePath)).toEqual(originalMutableBaseline);

    const partial = recoveryFixture();
    writeBaselineFixture(partial);
    const originalPartialBaseline = readFileSync(partial.baselinePath);
    const missingKey = partial.snapshot.latest_object_keys.meta;
    delete partial.objects[missingKey];
    const partialResult = await rehydrateLocalBaselineFromR2({
      archiveRoot: partial.archiveRoot,
      source: partial.source,
      baseline: partial.baseline,
      snapshotRecord: partial.snapshot,
      bucket,
      client: fakeR2Client(partial.objects),
    });
    expect(partialResult).toMatchObject({
      rehydrated: false,
      reason: "r2_object_download_failed",
    });
    expect(readFileSync(partial.baselinePath)).toEqual(originalPartialBaseline);
    expect(recoveryDirectories(partial.archiveRoot)).toEqual([]);
  });
});

describe("initial official document candidate artifact restore", () => {
  it("restores the exact immutable candidate paths from a hash-verified R2 generation", async () => {
    const fixture = initialDocumentRestoreFixture();
    const originalCandidate = structuredClone(fixture.candidate);

    const result = await restoreInitialOfficialDocumentCandidateArtifactsFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      candidate: fixture.candidate,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      restored: true,
      already_present: false,
      reason: "exact_candidate_r2_generation_restored",
      generation: "latest",
      family: "captures",
      artifact_count: 3,
      restored_roles: ["pdf", "text", "meta"],
    });
    for (const [role, target] of Object.entries(fixture.targets)) {
      expect(readFileSync(target)).toEqual(fixture.bodies[role]);
    }
    const evidence = await preparePublishedInitialOfficialDocumentEvidence({
      candidate: fixture.candidate,
      source: fixture.source,
      archiveRoot: fixture.archiveRoot,
      artifactStore: candidateRestoreMemoryStore(),
    });
    expect(evidence).toMatchObject({
      evidence_status: "not_applicable_new_document",
      current_capture: {
        kind: "pdf",
        full: { sha256: fixture.candidate.new_file_hash },
      },
    });
    expect(fixture.candidate).toEqual(originalCandidate);
    expect(candidateRestoreStageDirectories(fixture.archiveRoot)).toEqual([]);
  });

  it("restores acquisition-derived capture-meta.json from the unchanged remote meta slot", async () => {
    const fixture = initialDocumentRestoreFixture({ metaFileName: "capture-meta.json" });

    const result = await restoreInitialOfficialDocumentCandidateArtifactsFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      candidate: fixture.candidate,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      restored: true,
      reason: "exact_candidate_r2_generation_restored",
      restored_roles: ["pdf", "text", "meta"],
    });
    expect(fixture.snapshot.latest_object_keys.meta).toMatch(/\/meta\.json$/);
    expect(fixture.targets.meta).toMatch(/capture-meta\.json$/);
    expect(readFileSync(fixture.targets.meta)).toEqual(fixture.bodies.meta);
    expect(existsSync(join(fixture.archiveRoot, fixture.captureRelative, "meta.json"))).toBe(false);
    expect(candidateRestoreStageDirectories(fixture.archiveRoot)).toEqual([]);
  });

  it("rejects every candidate metadata basename outside the legacy and acquisition-derived pair", async () => {
    const fixture = initialDocumentRestoreFixture({ metaFileName: "candidate-metadata.json" });

    const result = await restoreInitialOfficialDocumentCandidateArtifactsFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      candidate: fixture.candidate,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      restored: false,
      reason: "candidate_restore_artifact_path_unsafe",
    });
    expect(Object.values(fixture.targets).some((target) => existsSync(target))).toBe(false);
    expect(candidateRestoreStageDirectories(fixture.archiveRoot)).toEqual([]);
  });

  it("fails closed when R2 bytes do not match the candidate-bound generation", async () => {
    const fixture = initialDocumentRestoreFixture();
    const pdfKey = fixture.snapshot.latest_object_keys.pdf;
    fixture.objects[pdfKey] = objectFixture(
      Buffer.from("%PDF-1.4\ntampered\n%%EOF\n"),
      "application/pdf",
    );

    const result = await restoreInitialOfficialDocumentCandidateArtifactsFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      candidate: fixture.candidate,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({ restored: false, reason: "r2_object_sha256_mismatch" });
    expect(Object.values(fixture.targets).some((target) => existsSync(target))).toBe(false);
    expect(candidateRestoreStageDirectories(fixture.archiveRoot)).toEqual([]);
  });

  it("rejects a cross-source immutable key before creating local output", async () => {
    const fixture = initialDocumentRestoreFixture();
    fixture.snapshot.latest_object_keys.meta = fixture.snapshot.latest_object_keys.meta.replace(
      sourceId,
      "33333333-3333-4333-8333-333333333333",
    );

    const result = await restoreInitialOfficialDocumentCandidateArtifactsFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      candidate: fixture.candidate,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({ restored: false, reason: "r2_object_key_source_mismatch" });
    expect(Object.values(fixture.targets).some((target) => existsSync(target))).toBe(false);
  });

  it("rejects traversal in a candidate path even when its byte manifest digest is unchanged", async () => {
    const fixture = initialDocumentRestoreFixture();
    fixture.candidate.new_snapshot_ref.local_paths.pdf.archive_relative =
      `sources/${sourceId}/captures/first-observation-20260715/../escape/document.pdf`;

    const result = await restoreInitialOfficialDocumentCandidateArtifactsFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      candidate: fixture.candidate,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      restored: false,
      reason: "candidate_restore_artifact_ref_invalid",
    });
    expect(Object.values(fixture.targets).some((target) => existsSync(target))).toBe(false);
  });

  it("never overwrites an existing local path with conflicting bytes", async () => {
    const fixture = initialDocumentRestoreFixture();
    mkdirSync(join(fixture.archiveRoot, fixture.captureRelative), { recursive: true });
    const conflicting = Buffer.from("an unrelated local document");
    writeFileSync(fixture.targets.pdf, conflicting);

    const result = await restoreInitialOfficialDocumentCandidateArtifactsFromR2({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      candidate: fixture.candidate,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      restored: false,
      reason: "candidate_restore_target_conflict",
    });
    expect(readFileSync(fixture.targets.pdf)).toEqual(conflicting);
    expect(existsSync(fixture.targets.text)).toBe(false);
    expect(existsSync(fixture.targets.meta)).toBe(false);
    expect(candidateRestoreStageDirectories(fixture.archiveRoot)).toEqual([]);
  });

  it("uses archive-relative identity on a replacement PC even when the old absolute paths still exist", async () => {
    const fixture = initialDocumentRestoreFixture();
    mkdirSync(join(fixture.archiveRoot, fixture.captureRelative), { recursive: true });
    for (const [role, oldPath] of Object.entries(fixture.targets)) {
      writeFileSync(oldPath, fixture.bodies[role]);
    }
    const replacementRoot = mkdtempSync(join(tmpdir(), "awardping-r2-candidate-replacement-"));
    temporaryRoots.push(replacementRoot);

    const result = await restoreInitialOfficialDocumentCandidateArtifactsFromR2({
      archiveRoot: replacementRoot,
      source: fixture.source,
      candidate: fixture.candidate,
      snapshotRecord: fixture.snapshot,
      bucket,
      client: fakeR2Client(fixture.objects),
    });

    expect(result).toMatchObject({
      restored: true,
      already_present: false,
      historical_direct_paths_ignored: {
        pdf: fixture.targets.pdf,
        text: fixture.targets.text,
        meta: fixture.targets.meta,
      },
    });
    for (const [role, body] of Object.entries(fixture.bodies)) {
      const restoredPath = join(
        replacementRoot,
        fixture.captureRelative,
        initialDocumentFileName(role),
      );
      expect(readFileSync(restoredPath)).toEqual(body);
      expect(readFileSync(fixture.targets[role])).toEqual(body);
    }
  });
});

function pdfRecoveryFixture() {
  const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-r2-pdf-rehydration-"));
  temporaryRoots.push(archiveRoot);
  const sourceDir = join(archiveRoot, "sources", sourceId);
  mkdirSync(sourceDir, { recursive: true });
  const baselinePath = join(sourceDir, "baseline.json");
  const source = {
    id: sourceId,
    shared_award_id: awardId,
    url: "https://example.edu/official-guidance.pdf",
    title: "Official Guidance",
  };
  const captureRelative = `sources/${sourceId}/captures/2026-07-15T23-00-00-000Z`;
  const paths = {
    pdf: `${captureRelative}/document.pdf`,
    text: `${captureRelative}/text.txt`,
    meta: `${captureRelative}/meta.json`,
  };
  const textValue = "Official eligibility guidance for the 2027 competition.";
  const pdf = Buffer.from(`%PDF-1.4\n${textValue}\n%%EOF\n`, "utf8");
  const text = Buffer.from(`${textValue}\n`, "utf8");
  const fileHash = sha256(pdf);
  const textHash = sha256(textValue);
  const retainedProjection = {
    schema: "awardping.capture-retained-artifact-projection.v1",
    kind: "pdf",
    localization_status: "not_applicable_pdf",
    authoritative: {
      layout_retained: false,
      layout_hash: null,
      expansion_state_count: 0,
    },
  };
  const metaValue = {
    version: 1,
    kind: "pdf",
    source: {
      id: sourceId,
      shared_award_id: awardId,
      url: source.url,
      title: source.title,
    },
    captured_at: capturedAt,
    final_url: source.url,
    file_hash: fileHash,
    text_hash: textHash,
    file_bytes: pdf.length,
    text_length: textValue.length,
    layout_hash: null,
    text_geometry: null,
    expansion_state_count: 0,
    expansion_state_screenshots: [],
    retained_artifact_projection: structuredClone(retainedProjection),
    files: {
      page: null,
      thumb: null,
      pdf: paths.pdf,
      text: paths.text,
      layout: null,
      meta: paths.meta,
      expansion_states: [],
    },
  };
  const meta = Buffer.from(JSON.stringify(metaValue), "utf8");
  const version = "dddddddddddddddddddddddddddddddd";
  const prefix = `visual-snapshots/sources/${sourceId}/captures/${version}`;
  const objectKeys = {
    pdf: `${prefix}/document.pdf`,
    text: `${prefix}/text.txt`,
    meta: `${prefix}/meta.json`,
  };
  const metadata = {
    file_bytes: pdf.length,
    text_length: textValue.length,
    retained_artifact_projection: structuredClone(retainedProjection),
    artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
    artifact_bindings: {
      pdf: rawArtifactBinding(pdf, "application/pdf"),
      text: rawArtifactBinding(text, "text/plain; charset=utf-8"),
      meta: rawArtifactBinding(meta, "application/json; charset=utf-8"),
    },
  };
  const snapshot = {
    shared_award_source_id: sourceId,
    shared_award_id: awardId,
    kind: "pdf",
    bucket,
    source_url: source.url,
    latest_captured_at: capturedAt,
    latest_object_keys: objectKeys,
    latest_hashes: {
      file_hash: fileHash,
      text_hash: textHash,
      image_hash: null,
      layout_hash: null,
    },
    latest_metadata: metadata,
    previous_captured_at: null,
    previous_object_keys: {},
    previous_hashes: {},
    previous_metadata: {},
    updated_at: "2026-07-16T00:30:00.000Z",
  };
  const objects = {
    [objectKeys.pdf]: objectFixture(pdf, "application/pdf"),
    [objectKeys.text]: objectFixture(text, "text/plain; charset=utf-8"),
    [objectKeys.meta]: objectFixture(meta, "application/json; charset=utf-8"),
  };
  return {
    archiveRoot,
    baselinePath,
    source,
    captureRelative,
    paths,
    retainedProjection,
    snapshot,
    objects,
    pdf,
    fileHash,
    textHash,
  };
}

function recoveryFixture() {
  const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-r2-rehydrate-"));
  temporaryRoots.push(archiveRoot);
  const sourceDir = join(archiveRoot, "sources", sourceId);
  mkdirSync(sourceDir, { recursive: true });
  const baselinePath = join(sourceDir, "baseline.json");
  const source = {
    id: sourceId,
    shared_award_id: awardId,
    url: "https://example.edu/award",
    title: "Example Award",
  };
  const captureRelative = `sources/${sourceId}/captures/2026-07-15T23-00-00-000Z`;
  const paths = {
    page: `${captureRelative}/page.jpg`,
    thumb: `${captureRelative}/thumb.jpg`,
    text: `${captureRelative}/text.txt`,
    layout: `${captureRelative}/layout.json`,
    meta: `${captureRelative}/meta.json`,
  };
  const page = Buffer.from("verified full-page screenshot bytes");
  const thumb = Buffer.from("verified thumbnail bytes");
  const textValue = "Application deadline: March 15, 2027";
  const text = Buffer.from(`${textValue}\n`, "utf8");
  const imageHash = sha256(page);
  const textHash = sha256(textValue);
  const screenshot = {
    css_width: 1365,
    css_height: 2400,
    pixel_width: 1365,
    pixel_height: 2400,
    alignment_status: "verified",
  };
  const rawLayoutValue = {
    version: 1,
    state_id: "main",
    captured_at: capturedAt,
    coordinate_space: "document-css-pixels",
    document: { width: 1365, height: 2400 },
    viewport: { width: 1365, height: 768 },
    scroll: { x: 0, y: 0 },
    device_pixel_ratio: 1,
    paint_stack: {
      contract: "browser-paint-stack-v1",
      status: "verified",
      sampled_rect_count: 0,
      rejected_rect_count: 0,
    },
    nodes: [geometryNode({
      text: "Applications close March 15",
      path: "main>p:nth-of-type(1)",
      flowPath: "body>main>p:nth-of-type(1)",
      y: 240,
    })],
  };
  const verifiedLayoutValue = verifyVisualScreenshotLayoutCapture({
    before: rawLayoutValue,
    after: rawLayoutValue,
    screenshot,
    stateId: "main",
  });
  const layoutValue = bindVisualTextGeometry(verifiedLayoutValue, {
    capturedAt,
    imageHash,
    imageRef: paths.page,
    screenshot,
  });
  const layout = Buffer.from(JSON.stringify(layoutValue), "utf8");
  const mainGeometryReference = {
    ...structuredClone(layoutValue),
    file: paths.layout,
  };
  const retainedProjection = {
    schema: "awardping.capture-retained-artifact-projection.v1",
    kind: "webpage",
    localization_status: "exact_geometry_available",
    authoritative: {
      layout_retained: true,
      layout_hash: layoutValue.geometry_hash,
      expansion_state_count: 0,
    },
  };
  const baseline = {
    version: 1,
    kind: "webpage",
    source: {
      id: sourceId,
      shared_award_id: awardId,
      url: source.url,
    },
    captured_at: capturedAt,
    text_hash: textHash,
    image_hash: imageHash,
    layout_hash: layoutValue.geometry_hash,
    file_hash: null,
    text_geometry: structuredClone(mainGeometryReference),
    capture: {
      dir: captureRelative,
      page: paths.page,
      thumb: paths.thumb,
      pdf: null,
      text: paths.text,
      expansion_text: null,
      sections_text: null,
      sections_json: null,
      layout: paths.layout,
      meta: paths.meta,
      expansion_states: [],
    },
    summary_metadata: {
      reason: "approved_visual_change",
      previous_baseline_capture: null,
      baseline_facts: null,
      retained_artifact_projection: structuredClone(retainedProjection),
    },
  };
  const meta = Buffer.from(JSON.stringify({
    version: 1,
    kind: "webpage",
    source: {
      id: sourceId,
      shared_award_id: awardId,
      url: source.url,
    },
    captured_at: capturedAt,
    text_hash: textHash,
    image_hash: imageHash,
    text_length: textValue.length,
    page_bytes: page.length,
    thumb_bytes: thumb.length,
    expansion_state_count: 0,
    expansion_state_screenshots: [],
    browser: { executable_path: "C:\\stale\\chrome.exe", name: "Chromium" },
    expandable_sections: [{
      section_path: "main>details:nth-of-type(1)",
      label: "Deadlines",
      text: "Applications close March 15",
    }],
    layout_hash: layoutValue.geometry_hash,
    text_geometry: structuredClone(mainGeometryReference),
    localization: {
      status: "exact_geometry_available",
      exact: true,
      accounted_for: true,
      geometry_ready: true,
      geometry_hash: layoutValue.geometry_hash,
      bound_image_hash: imageHash,
    },
    retained_artifact_projection: structuredClone(retainedProjection),
    files: {
      page: paths.page,
      thumb: paths.thumb,
      text: paths.text,
      layout: paths.layout,
      meta: paths.meta,
      expansion_states: [],
    },
  }), "utf8");
  const version = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const prefix = `visual-snapshots/sources/${sourceId}/captures/${version}`;
  const objectKeys = {
    page: `${prefix}/page.jpg`,
    thumb: `${prefix}/thumb.jpg`,
    text: `${prefix}/text.txt`,
    layout: `${prefix}/layout.json`,
    meta: `${prefix}/meta.json`,
  };
  const objects = {
    [objectKeys.page]: objectFixture(page, "image/jpeg"),
    [objectKeys.thumb]: objectFixture(thumb, "image/jpeg"),
    [objectKeys.text]: objectFixture(text, "text/plain; charset=utf-8"),
    [objectKeys.layout]: objectFixture(layout, "application/json; charset=utf-8"),
    [objectKeys.meta]: objectFixture(meta, "application/json; charset=utf-8"),
  };
  const snapshot = {
    shared_award_source_id: sourceId,
    shared_award_id: awardId,
    kind: "webpage",
    bucket,
    source_url: source.url,
    latest_captured_at: capturedAt,
    latest_object_keys: objectKeys,
    latest_hashes: {
      image_hash: imageHash,
      text_hash: textHash,
      layout_hash: layoutValue.geometry_hash,
      file_hash: null,
    },
    latest_metadata: {
      text_length: textValue.length,
      page_bytes: page.length,
      thumb_bytes: thumb.length,
      layout_hash: layoutValue.geometry_hash,
      text_geometry: structuredClone(mainGeometryReference),
      localization: {
        status: "exact_geometry_available",
        exact: true,
        accounted_for: true,
        geometry_ready: true,
        geometry_hash: layoutValue.geometry_hash,
        bound_image_hash: imageHash,
      },
      expansion_state_count: 0,
      expansion_state_screenshots: [],
      retained_artifact_projection: structuredClone(retainedProjection),
      artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
      artifact_bindings: {
        page: rawArtifactBinding(page, "image/jpeg"),
        thumb: rawArtifactBinding(thumb, "image/jpeg"),
        text: rawArtifactBinding(text, "text/plain; charset=utf-8"),
        layout: rawArtifactBinding(layout, "application/json; charset=utf-8"),
        meta: rawArtifactBinding(meta, "application/json; charset=utf-8"),
      },
    },
    previous_captured_at: null,
    previous_object_keys: {},
    previous_hashes: {},
    previous_metadata: {},
    updated_at: "2026-07-16T00:30:00.000Z",
  };
  return {
    archiveRoot,
    baselinePath,
    source,
    baseline,
    snapshot,
    objects,
    page,
    captureRelative,
    paths,
    retainedProjection,
    layoutHash: layoutValue.geometry_hash,
  };
}

function writeBaselineFixture(fixture) {
  writeFileSync(fixture.baselinePath, `${JSON.stringify(fixture.baseline, null, 2)}\n`, "utf8");
}

function addExpansionState(fixture, { stateId = "expansion-state-01" } = {}) {
  const expansionPage = Buffer.from("verified opened eligibility accordion screenshot");
  const expansionImageHash = sha256(expansionPage);
  const expansionText = "Applicants must satisfy the eligibility requirements";
  const expansionTextHash = sha256(expansionText);
  const expansionScreenshot = {
    css_width: 1365,
    css_height: 2600,
    pixel_width: 1365,
    pixel_height: 2600,
    alignment_status: "verified",
  };
  const rawExpansionLayout = {
    version: 1,
    state_id: stateId,
    captured_at: capturedAt,
    coordinate_space: "document-css-pixels",
    document: { width: 1365, height: 2600 },
    viewport: { width: 1365, height: 768 },
    scroll: { x: 0, y: 0 },
    device_pixel_ratio: 1,
    paint_stack: {
      contract: "browser-paint-stack-v1",
      status: "verified",
      sampled_rect_count: 0,
      rejected_rect_count: 0,
    },
    nodes: [geometryNode({
      text: expansionText,
      path: "main>details:nth-of-type(1)>p",
      flowPath: "body>main>details:nth-of-type(1)>p",
      y: 420,
    })],
  };
  const verifiedExpansionLayout = verifyVisualScreenshotLayoutCapture({
    before: rawExpansionLayout,
    after: rawExpansionLayout,
    screenshot: expansionScreenshot,
    stateId,
  });
  const expansionLayoutValue = bindVisualTextGeometry(verifiedExpansionLayout, {
    capturedAt,
    imageHash: expansionImageHash,
    imageRef: `${fixture.captureRelative}/expansion-state-01.jpg`,
    screenshot: expansionScreenshot,
  });
  const expansionGeometryReference = {
    ...structuredClone(expansionLayoutValue),
    file: `${fixture.captureRelative}/expansion-state-01-layout.json`,
  };
  const expansionLayout = Buffer.from(JSON.stringify(expansionLayoutValue), "utf8");
  const prefix = fixture.snapshot.latest_object_keys.page.slice(0, -"page.jpg".length);
  const pageKey = `${prefix}expansion-state-01.jpg`;
  const layoutKey = `${prefix}expansion-state-01-layout.json`;
  fixture.snapshot.latest_object_keys.expansion_state_01 = pageKey;
  fixture.snapshot.latest_object_keys.expansion_state_01_layout = layoutKey;
  fixture.snapshot.latest_metadata.expansion_state_count = 1;
  fixture.snapshot.latest_metadata.expansion_state_screenshots = [{
    state_id: stateId,
    label: "Eligibility",
    image_hash: expansionImageHash,
    layout_hash: expansionLayoutValue.geometry_hash,
    text_geometry: expansionGeometryReference,
    text_hash: expansionTextHash,
    text_length: expansionText.length,
    page_bytes: expansionPage.length,
  }];
  fixture.objects[pageKey] = objectFixture(expansionPage, "image/jpeg");
  fixture.objects[layoutKey] = objectFixture(expansionLayout, "application/json; charset=utf-8");
  fixture.snapshot.latest_metadata.artifact_bindings_schema =
    "awardping.r2.capture-artifact-bindings.v1";
  fixture.snapshot.latest_metadata.artifact_bindings = {
    ...fixture.snapshot.latest_metadata.artifact_bindings,
    expansion_state_01: rawArtifactBinding(
      expansionPage,
      "image/jpeg",
    ),
    expansion_state_01_layout: rawArtifactBinding(
      expansionLayout,
      "application/json; charset=utf-8",
    ),
  };

  const metaKey = fixture.snapshot.latest_object_keys.meta;
  const meta = JSON.parse(fixture.objects[metaKey].body.toString("utf8"));
  const expansionPagePath = `${fixture.captureRelative}/expansion-state-01.jpg`;
  const expansionLayoutPath = `${fixture.captureRelative}/expansion-state-01-layout.json`;
  meta.expansion_state_count = 1;
  meta.expansion_state_screenshots = [{
    state_id: stateId,
    index: 0,
    label: "Eligibility",
    page: expansionPagePath,
    layout: expansionLayoutPath,
    image_hash: expansionImageHash,
    layout_hash: expansionLayoutValue.geometry_hash,
    text_hash: expansionTextHash,
    text_length: expansionText.length,
    page_bytes: expansionPage.length,
    text_geometry: structuredClone(expansionGeometryReference),
  }];
  meta.files.expansion_states = [{
    state_id: stateId,
    label: "Eligibility",
    page: expansionPagePath,
    layout: expansionLayoutPath,
  }];
  const retainedProjection = {
    ...structuredClone(fixture.retainedProjection),
    authoritative: {
      ...structuredClone(fixture.retainedProjection.authoritative),
      expansion_state_count: 1,
    },
  };
  meta.retained_artifact_projection = structuredClone(retainedProjection);
  fixture.snapshot.latest_metadata.retained_artifact_projection =
    structuredClone(retainedProjection);
  fixture.baseline.summary_metadata.retained_artifact_projection =
    structuredClone(retainedProjection);
  fixture.retainedProjection = retainedProjection;
  const metaBody = Buffer.from(JSON.stringify(meta), "utf8");
  fixture.objects[metaKey] = objectFixture(metaBody, "application/json; charset=utf-8");
  fixture.snapshot.latest_metadata.artifact_bindings.meta = rawArtifactBinding(
    metaBody,
    "application/json; charset=utf-8",
  );
  fixture.expansionPage = expansionPage;
  fixture.expansionImageHash = expansionImageHash;
  fixture.expansionLayoutHash = expansionLayoutValue.geometry_hash;
  fixture.expansionTextHash = expansionTextHash;
}

function rawArtifactBinding(body, contentType) {
  return {
    sha256: sha256(body),
    byte_length: body.length,
    content_type: contentType,
    hash_mode: "raw_sha256",
  };
}

function makeHybridExpansionRecoveryFixture() {
  const fixture = recoveryFixture();
  addExpansionState(fixture, { stateId: "expansion-state-01" });
  const mainLayoutKey = fixture.snapshot.latest_object_keys.layout;
  delete fixture.snapshot.latest_object_keys.layout;
  delete fixture.objects[mainLayoutKey];
  delete fixture.snapshot.latest_metadata.artifact_bindings.layout;

  const unavailableReason = "The main page moved while its screenshot was captured.";
  const unavailableGeometry = {
    status: "unavailable_layout_changed_during_screenshot",
    availability_status: "unavailable_layout_changed_during_screenshot",
    unavailable_reason: unavailableReason,
    geometry_hash: null,
    node_count: 0,
    run_count: 0,
    screenshot: {
      image_hash: null,
      image_ref: null,
    },
    file: null,
  };
  const unavailableLocalization = {
    status: "unavailable_layout_changed_during_screenshot",
    exact: false,
    accounted_for: true,
    geometry_ready: false,
    unavailable_reason: unavailableReason,
    geometry_hash: null,
    bound_image_hash: null,
    semantic_crop_contract: "visual-exact-text-binding-v2",
  };
  const retainedProjection = {
    schema: "awardping.capture-retained-artifact-projection.v1",
    kind: "webpage",
    localization_status: "evidence_only_geometry_unavailable",
    authoritative: {
      layout_retained: false,
      layout_hash: null,
      expansion_state_count: 1,
    },
    diagnostics: {
      authority: "diagnostic_only",
      storage_scope: "local_capture_directory_only",
    },
  };
  fixture.snapshot.latest_hashes.layout_hash = null;
  fixture.snapshot.latest_metadata.layout_hash = null;
  fixture.snapshot.latest_metadata.text_geometry = structuredClone(unavailableGeometry);
  fixture.snapshot.latest_metadata.localization = structuredClone(unavailableLocalization);
  fixture.snapshot.latest_metadata.retained_artifact_projection = structuredClone(retainedProjection);

  rewriteFixtureMeta(fixture, (meta) => {
    meta.layout_hash = null;
    meta.text_geometry = structuredClone(unavailableGeometry);
    meta.localization = structuredClone(unavailableLocalization);
    meta.files.layout = null;
    meta.baseline_facts_metadata = {
      status: "verified",
      evidence_source: "retained_capture",
    };
    meta.monitoring_disposition = {
      classification: "substantive_baseline",
      reason: "stage1_activation",
    };
    meta.stage1_baseline_activation = {
      status: "verified",
      plan_sha256: "a".repeat(64),
    };
    meta.retained_artifact_projection = structuredClone(retainedProjection);
  });
  fixture.unavailableReason = unavailableReason;
  fixture.retainedProjection = retainedProjection;
  return fixture;
}

function rewriteFixtureMeta(fixture, mutate) {
  const metaKey = fixture.snapshot.latest_object_keys.meta;
  const meta = JSON.parse(fixture.objects[metaKey].body.toString("utf8"));
  mutate(meta);
  const body = Buffer.from(JSON.stringify(meta), "utf8");
  fixture.objects[metaKey] = objectFixture(body, "application/json; charset=utf-8");
  if (fixture.snapshot.latest_metadata.artifact_bindings?.meta) {
    fixture.snapshot.latest_metadata.artifact_bindings.meta = rawArtifactBinding(
      body,
      "application/json; charset=utf-8",
    );
  }
}

function bindLegacyRetainedProjectionBridge(fixture) {
  rewriteFixtureMeta(fixture, (meta) => {
    delete meta.retained_artifact_projection;
    delete meta.legacy_retained_artifact_projection_provenance;
  });
  const metaKey = fixture.snapshot.latest_object_keys.meta;
  const rawMetaBody = Buffer.from(fixture.objects[metaKey].body);
  const projection = structuredClone(
    fixture.snapshot.latest_metadata.retained_artifact_projection,
  );
  fixture.snapshot.latest_metadata.legacy_retained_artifact_projection_provenance =
    buildLegacyRetainedProjectionProvenance({
      rawMetaSha256: sha256(rawMetaBody),
      projectionSha256: sha256(stableJson(projection)),
    });
  return { metaKey, projection, rawMetaBody };
}

function initialDocumentRestoreFixture({ metaFileName = "meta.json" } = {}) {
  const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-r2-candidate-restore-"));
  temporaryRoots.push(archiveRoot);
  const source = {
    id: sourceId,
    shared_award_id: awardId,
    url: "https://example.edu/2027-official-rules.pdf",
  };
  const captureRelative = `sources/${sourceId}/captures/first-observation-20260715`;
  const captureDir = join(archiveRoot, captureRelative);
  const targets = {
    pdf: join(captureDir, "document.pdf"),
    text: join(captureDir, "text.txt"),
    meta: join(captureDir, metaFileName),
  };
  const textValue = "Applicants must submit two letters of recommendation.";
  const pdf = Buffer.from(`%PDF-1.4\n${textValue}\n%%EOF\n`, "utf8");
  const text = Buffer.from(`${textValue}\n`, "utf8");
  const fileHash = sha256(pdf);
  const textHash = sha256(textValue);
  const meta = Buffer.from(JSON.stringify({
    version: 1,
    kind: "pdf",
    source: {
      id: sourceId,
      shared_award_id: awardId,
      url: source.url,
    },
    captured_at: capturedAt,
    file_hash: fileHash,
    text_hash: textHash,
    file_bytes: pdf.length,
    text_length: textValue.length,
    files: {
      pdf: targets.pdf,
      text: targets.text,
      meta: targets.meta,
    },
  }), "utf8");
  const bodies = { pdf, text, meta };
  const newSnapshotRef = {
    kind: "pdf",
    captured_at: capturedAt,
    final_url: source.url,
    file_hash: fileHash,
    text_hash: textHash,
    local_paths: Object.fromEntries(
      Object.entries(targets).map(([role, path]) => [role, {
        path,
        archive_relative: `${captureRelative}/${initialDocumentFileName(role, metaFileName)}`,
        exists: true,
        bytes: bodies[role].length,
        byte_length: bodies[role].length,
        sha256: sha256(bodies[role]),
      }]),
    ),
    capture_dir: {
      path: captureDir,
      archive_relative: captureRelative,
      exists: true,
    },
  };
  const candidateManifest = visualSnapshotArtifactManifest(newSnapshotRef);
  newSnapshotRef.artifact_manifest = candidateManifest;
  newSnapshotRef.artifact_manifest_digest = candidateManifest.digest;
  const acquisitionId = "55555555-5555-4555-8555-555555555555";
  const initialDecision = buildInitialOfficialDocumentCandidate({
    acquisition: {
      id: acquisitionId,
      notification_mode: "first_capture_candidate",
      review_seal: { capture_file_hash: fileHash },
    },
    review: {
      id: "66666666-6666-4666-8666-666666666666",
      sealed: true,
      status: "accepted",
      award_relevance: "primary",
      cycle_relevance: "current_or_upcoming",
      confidence: "high",
      evidence_quotes: [textValue],
      capture_file_hash: fileHash,
      capture_final_url: source.url,
    },
    source,
    capture: {
      kind: "pdf",
      captured_at: capturedAt,
      final_url: source.url,
      file_hash: fileHash,
      text: textValue,
    },
  });
  if (!initialDecision.eligible) {
    throw new Error(`Initial-document restore fixture failed: ${initialDecision.reason}`);
  }
  const attestation = initialDecision.first_observation_attestation;

  const candidate = {
    id: "44444444-4444-4444-8444-444444444444",
    candidate_signature: sha256("initial-document-candidate-signature"),
    candidate_scope: "initial_official_document",
    shared_award_id: awardId,
    shared_award_source_id: sourceId,
    source_acquisition_id: acquisitionId,
    previous_file_hash: attestation.sha256,
    new_file_hash: fileHash,
    new_text_hash: textHash,
    previous_snapshot_ref: {
      kind: "first_observation_attestation",
      captured_at: capturedAt,
      source_acquisition_id: acquisitionId,
      attestation_sha256: attestation.sha256,
      byte_length: attestation.byte_length,
      content_type: attestation.content_type,
    },
    new_snapshot_ref: newSnapshotRef,
    prompt_payload: {
      first_observation_attestation: structuredClone(attestation),
      new_snapshot_ref: structuredClone(newSnapshotRef),
      hashes: {
        first_observation_attestation_sha256: attestation.sha256,
        previous_file_hash: attestation.sha256,
        new_file_hash: fileHash,
        new_text_hash: textHash,
        new_artifact_manifest_digest: candidateManifest.digest,
      },
    },
  };
  const version = "cccccccccccccccccccccccccccccccc";
  const prefix = `visual-snapshots/sources/${sourceId}/captures/${version}`;
  const objectKeys = {
    pdf: `${prefix}/document.pdf`,
    text: `${prefix}/text.txt`,
    meta: `${prefix}/meta.json`,
  };
  const snapshot = {
    shared_award_source_id: sourceId,
    shared_award_id: awardId,
    kind: "pdf",
    bucket,
    source_url: source.url,
    latest_captured_at: capturedAt,
    latest_object_keys: objectKeys,
    latest_hashes: {
      file_hash: fileHash,
      text_hash: textHash,
      image_hash: null,
    },
    latest_metadata: {
      file_bytes: pdf.length,
      text_length: textValue.length,
    },
    previous_captured_at: null,
    previous_object_keys: {},
    previous_hashes: {},
    previous_metadata: {},
    updated_at: "2026-07-16T00:30:00.000Z",
  };
  const objects = {
    [objectKeys.pdf]: objectFixture(pdf, "application/pdf"),
    [objectKeys.text]: objectFixture(text, "text/plain; charset=utf-8"),
    [objectKeys.meta]: objectFixture(meta, "application/json; charset=utf-8"),
  };
  return {
    archiveRoot,
    source,
    captureRelative,
    targets,
    bodies,
    candidate,
    snapshot,
    objects,
  };
}

function initialDocumentFileName(role, metaFileName = "meta.json") {
  return role === "pdf" ? "document.pdf" : role === "text" ? "text.txt" : metaFileName;
}

function geometryNode({ text, path, flowPath, y }) {
  const width = Math.max(160, text.length * 8);
  const rect = { x: 120, y, width, height: 24, right: 120 + width, bottom: y + 24 };
  return {
    order: 0,
    path,
    flow_path: flowPath,
    text,
    separator_before: "",
    rects: [rect],
    runs: [{ start: 0, end: text.length, text, rects: [rect] }],
  };
}

function objectFixture(body, contentType) {
  return { body, contentType };
}

function fakeR2Client(objects) {
  return {
    async send(command) {
      const key = command.input.Key;
      const object = objects[key];
      if (!object) throw new Error(`No such object: ${key}`);
      const common = {
        ContentLength: object.body.length,
        ContentType: object.contentType,
        ETag: `"${createHash("md5").update(object.body).digest("hex")}"`,
        Metadata: { sha256: sha256(object.body) },
      };
      if (command.constructor.name === "HeadObjectCommand") return common;
      if (command.constructor.name === "GetObjectCommand") {
        return {
          ...common,
          Body: {
            transformToByteArray: async () => new Uint8Array(object.body),
          },
        };
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`);
    },
  };
}

function remapObjects(objects, from, to) {
  return Object.fromEntries(
    Object.entries(objects).map(([key, value]) => [key.replace(from, to), value]),
  );
}

function recoveryDirectories(archiveRoot) {
  const capturesDir = join(archiveRoot, "sources", sourceId, "captures");
  return existsSync(capturesDir)
    ? readdirSync(capturesDir).filter((name) => name.startsWith("r2-rehydrated-") || name.startsWith(".r2-rehydrate-"))
    : [];
}

function candidateRestoreStageDirectories(archiveRoot) {
  const capturesDir = join(archiveRoot, "sources", sourceId, "captures");
  return existsSync(capturesDir)
    ? readdirSync(capturesDir).filter((name) => name.startsWith(".r2-candidate-restore-"))
    : [];
}

function candidateRestoreMemoryStore() {
  const objects = new Map();
  return {
    bucket: "published-evidence-test",
    async put(value) {
      objects.set(value.key, value);
    },
    async head({ key }) {
      const value = objects.get(key);
      return {
        byte_length: value.body.length,
        content_type: value.contentType,
        sha256: value.sha256,
      };
    },
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(sortStableJsonValue(value));
}

function sortStableJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortStableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortStableJsonValue(value[key])]),
  );
}

function sourceFunctionBody(source, name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start + 1);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name} wiring.`);
  return source.slice(start, end);
}
