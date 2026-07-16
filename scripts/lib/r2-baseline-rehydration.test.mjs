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
  rehydrateLocalBaselineFromR2,
  restoreInitialOfficialDocumentCandidateArtifactsFromR2,
} from "./r2-baseline-rehydration.mjs";
import { buildInitialOfficialDocumentCandidate } from "./initial-official-document.mjs";
import { preparePublishedInitialOfficialDocumentEvidence } from "./visual-event-evidence.mjs";
import {
  bindVisualTextGeometry,
  verifyVisualTextGeometryBinding,
} from "./visual-event-localization.mjs";
import { visualSnapshotArtifactManifest } from "./visual-review-queue.mjs";

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
    const existingHoldProtection = processBody.indexOf(
      'if (source.admin_review_status === "open")',
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
      r2_local_rehydration: {
        restored_missing_baseline: true,
        integrity: "verified_before_atomic_baseline_repoint",
      },
    });
    expect(readFileSync(join(fixture.archiveRoot, published.capture.page))).toEqual(fixture.page);
    const meta = JSON.parse(readFileSync(join(fixture.archiveRoot, published.capture.meta), "utf8"));
    expect(meta.files.page).toBe(published.capture.page);
    expect(meta.text_geometry.file).toBe(published.capture.layout);
    expect(JSON.stringify(meta)).not.toContain("C:\\\\stale");
    expect(readdirSync(join(fixture.archiveRoot, "sources"))).toEqual([sourceId]);
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
        const metaKey = fixture.snapshot.latest_object_keys.meta;
        const meta = JSON.parse(fixture.objects[metaKey].body.toString("utf8"));
        meta.kind = "pdf";
        fixture.objects[metaKey] = objectFixture(
          Buffer.from(JSON.stringify(meta), "utf8"),
          "application/json; charset=utf-8",
        );
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

  it("validates and atomically publishes an exact latest generation while sanitizing paths", async () => {
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
    expect(published.capture.dir).toContain("r2-rehydrated-capture-");
    expect(readFileSync(join(fixture.archiveRoot, published.capture.page))).toEqual(fixture.page);

    const meta = JSON.parse(readFileSync(join(fixture.archiveRoot, published.capture.meta), "utf8"));
    expect(meta.files.page).toBe(published.capture.page);
    expect(meta.files.sections_json).toBeNull();
    expect(meta.text_geometry.file).toBe(published.capture.layout);
    expect(meta.text_geometry.screenshot.image_ref).toBe(published.capture.page);
    expect(meta.browser.executable_path).toBeUndefined();
    expect(JSON.stringify(meta)).not.toContain("C:\\\\stale");
    const layout = JSON.parse(readFileSync(join(fixture.archiveRoot, published.capture.layout), "utf8"));
    expect(layout.screenshot.image_ref).toBe(published.capture.page);
    expect(layout.geometry_hash).toBe(published.layout_hash);
    expect(verifyVisualTextGeometryBinding(layout, published.image_hash)).toMatchObject({ valid: true });
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
    expect(published.capture.dir).toContain("r2-rehydrated-approved-");
    expect(published.summary_metadata.r2_local_rehydration.generation).toBe("previous");
  });

  it("rehydrates a legacy approved generation as evidence-only when geometry was never retained", async () => {
    const fixture = recoveryFixture();
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
      state_id: "eligibility-open",
      label: "Eligibility",
      image_hash: fixture.expansionImageHash,
      layout_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(readFileSync(join(fixture.archiveRoot, state.page))).toEqual(fixture.expansionPage);
    const layout = JSON.parse(readFileSync(join(fixture.archiveRoot, state.layout), "utf8"));
    expect(layout.screenshot.image_ref).toBe(state.page);
    expect(layout.geometry_hash).toBe(state.layout_hash);
    expect(verifyVisualTextGeometryBinding(layout, fixture.expansionImageHash)).toMatchObject({
      valid: true,
    });
  });

  it("marks an unpaired retained accordion image as evidence-only instead of geometry-ready", async () => {
    const fixture = recoveryFixture();
    addExpansionState(fixture);
    const layoutKey = fixture.snapshot.latest_object_keys.expansion_state_01_layout;
    delete fixture.snapshot.latest_object_keys.expansion_state_01_layout;
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
      rehydrated: true,
      recovery_scope: "baseline_evidence_only",
      localization_recovered: false,
      localization_status: "evidence_only_expansion_geometry_incomplete",
    });
    const published = JSON.parse(readFileSync(fixture.baselinePath, "utf8"));
    expect(published.capture.expansion_states[0]).toMatchObject({
      page: expect.any(String),
      layout: null,
      layout_hash: null,
      text_geometry: null,
    });
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

function recoveryFixture() {
  const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-r2-rehydrate-"));
  temporaryRoots.push(archiveRoot);
  const sourceDir = join(archiveRoot, "sources", sourceId);
  mkdirSync(sourceDir, { recursive: true });
  const baselinePath = join(sourceDir, "baseline.json");
  const page = Buffer.from("verified full-page screenshot bytes");
  const thumb = Buffer.from("verified thumbnail bytes");
  const textValue = "Application deadline: March 15, 2027";
  const text = Buffer.from(`${textValue}\n`, "utf8");
  const imageHash = sha256(page);
  const textHash = sha256(textValue);
  const layoutValue = bindVisualTextGeometry({
    version: 1,
    state_id: "main",
    captured_at: capturedAt,
    document: { width: 1365, height: 2400 },
    viewport: { width: 1365, height: 768 },
    device_pixel_ratio: 1,
    nodes: [],
  }, {
    capturedAt,
    imageHash,
    imageRef: "C:\\stale\\page.jpg",
    screenshot: {
      css_width: 1365,
      css_height: 2400,
      pixel_width: 1365,
      pixel_height: 2400,
    },
  });
  const layout = Buffer.from(JSON.stringify(layoutValue), "utf8");
  const source = {
    id: sourceId,
    shared_award_id: awardId,
    url: "https://example.edu/award",
    title: "Example Award",
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
    text_geometry: {
      geometry_hash: layoutValue.geometry_hash,
      file: "C:\\stale\\layout.json",
      screenshot: layoutValue.screenshot,
    },
    capture: {
      dir: `sources/${sourceId}/captures/missing`,
      page: `sources/${sourceId}/captures/missing/page.jpg`,
      thumb: `sources/${sourceId}/captures/missing/thumb.jpg`,
      pdf: null,
      text: `sources/${sourceId}/captures/missing/text.txt`,
      expansion_text: null,
      sections_text: null,
      sections_json: null,
      layout: `sources/${sourceId}/captures/missing/layout.json`,
      meta: `sources/${sourceId}/captures/missing/meta.json`,
      expansion_states: [],
    },
    summary_metadata: {
      reason: "approved_visual_change",
      previous_baseline_capture: null,
      baseline_facts: null,
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
    browser: { executable_path: "C:\\stale\\chrome.exe", name: "Chromium" },
    layout_hash: layoutValue.geometry_hash,
    text_geometry: {
      geometry_hash: layoutValue.geometry_hash,
      file: "C:\\stale\\layout.json",
      screenshot: layoutValue.screenshot,
    },
    files: {
      page: "C:\\stale\\page.jpg",
      thumb: "C:\\stale\\thumb.jpg",
      text: "C:\\stale\\text.txt",
      layout: "C:\\stale\\layout.json",
      meta: "C:\\stale\\meta.json",
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
    },
    previous_captured_at: null,
    previous_object_keys: {},
    previous_hashes: {},
    previous_metadata: {},
    updated_at: "2026-07-16T00:30:00.000Z",
  };
  return { archiveRoot, baselinePath, source, baseline, snapshot, objects, page };
}

function writeBaselineFixture(fixture) {
  writeFileSync(fixture.baselinePath, `${JSON.stringify(fixture.baseline, null, 2)}\n`, "utf8");
}

function addExpansionState(fixture) {
  const expansionPage = Buffer.from("verified opened eligibility accordion screenshot");
  const expansionImageHash = sha256(expansionPage);
  const expansionLayoutValue = bindVisualTextGeometry({
    version: 1,
    state_id: "eligibility-open",
    captured_at: capturedAt,
    document: { width: 1365, height: 2600 },
    viewport: { width: 1365, height: 768 },
    device_pixel_ratio: 1,
    nodes: [{ text: "Eligibility", rect: { x: 100, y: 1400, width: 300, height: 40 } }],
  }, {
    capturedAt,
    imageHash: expansionImageHash,
    imageRef: "C:\\stale\\expansion-state-01.jpg",
    screenshot: {
      css_width: 1365,
      css_height: 2600,
      pixel_width: 1365,
      pixel_height: 2600,
    },
  });
  const expansionLayout = Buffer.from(JSON.stringify(expansionLayoutValue), "utf8");
  const prefix = fixture.snapshot.latest_object_keys.page.slice(0, -"page.jpg".length);
  const pageKey = `${prefix}expansion-state-01.jpg`;
  const layoutKey = `${prefix}expansion-state-01-layout.json`;
  fixture.snapshot.latest_object_keys.expansion_state_01 = pageKey;
  fixture.snapshot.latest_object_keys.expansion_state_01_layout = layoutKey;
  fixture.snapshot.latest_metadata.expansion_state_count = 1;
  fixture.snapshot.latest_metadata.expansion_state_screenshots = [{
    state_id: "eligibility-open",
    label: "Eligibility",
    image_hash: expansionImageHash,
    layout_hash: expansionLayoutValue.geometry_hash,
  }];
  fixture.objects[pageKey] = objectFixture(expansionPage, "image/jpeg");
  fixture.objects[layoutKey] = objectFixture(expansionLayout, "application/json; charset=utf-8");

  const metaKey = fixture.snapshot.latest_object_keys.meta;
  const meta = JSON.parse(fixture.objects[metaKey].body.toString("utf8"));
  meta.expansion_state_screenshots = [{
    state_id: "eligibility-open",
    index: 0,
    label: "Eligibility",
    page: "C:\\stale\\expansion-state-01.jpg",
    layout: "C:\\stale\\expansion-state-01-layout.json",
    image_hash: expansionImageHash,
    layout_hash: expansionLayoutValue.geometry_hash,
    text_geometry: {
      geometry_hash: expansionLayoutValue.geometry_hash,
      file: "C:\\stale\\expansion-state-01-layout.json",
      screenshot: expansionLayoutValue.screenshot,
    },
  }];
  meta.files.expansion_states = [{
    state_id: "eligibility-open",
    label: "Eligibility",
    page: "C:\\stale\\expansion-state-01.jpg",
    layout: "C:\\stale\\expansion-state-01-layout.json",
  }];
  fixture.objects[metaKey] = objectFixture(
    Buffer.from(JSON.stringify(meta), "utf8"),
    "application/json; charset=utf-8",
  );
  fixture.expansionPage = expansionPage;
  fixture.expansionImageHash = expansionImageHash;
  fixture.expansionLayoutHash = expansionLayoutValue.geometry_hash;
}

function initialDocumentRestoreFixture() {
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
    meta: join(captureDir, "meta.json"),
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
        archive_relative: `${captureRelative}/${initialDocumentFileName(role)}`,
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

function initialDocumentFileName(role) {
  return role === "pdf" ? "document.pdf" : role === "text" ? "text.txt" : "meta.json";
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

function sourceFunctionBody(source, name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start + 1);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name} wiring.`);
  return source.slice(start, end);
}
