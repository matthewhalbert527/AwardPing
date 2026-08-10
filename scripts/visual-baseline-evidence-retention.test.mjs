import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);
const catchupSource = readFileSync(
  new URL("./run-one-time-catchup.mjs", import.meta.url),
  "utf8",
);

function functionBody(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

function catchupFunctionBody(name, nextName) {
  const start = catchupSource.indexOf(`function ${name}`);
  const end = catchupSource.indexOf(`function ${nextName}`, start + 1);
  return catchupSource.slice(start, end === -1 ? undefined : end);
}

describe("visual baseline evidence retention", () => {
  it("absorbs safe deterministic noise without deleting its promoted evidence", () => {
    const body = functionBody("finishSafeDeterministicNoise", "reviewAndApplyCandidateChange");

    expect(body).toContain("baselinePromoted = writeBaseline");
    expect(body).toContain("deterministic_noise_absorbed");
    expect(body).toContain("monitoring_disposition");
    expect(body).toContain("noise: textOnly");
    expect(body).toContain("unchanged: textOnly");
    expect(body).toContain("if (!keepUnchanged && !baselinePromoted)");
    expect(body).toContain("deterministicNoiseBaselineDisposition");
    expect(body).toContain("if (baselinePromoted)");
    expect(body).toContain("PRESERVED last_known_good deterministic_noise");
  });

  it("routes whole-page deterministic noise through the global absorption path", () => {
    const body = functionBody("processSourceUnlocked", "processLocalizationRepairSource");
    const deterministicNoise = body.indexOf("if (!deterministic.candidate_change)");
    const absorption = body.indexOf("await finishSafeDeterministicNoise", deterministicNoise);
    const visualGate = body.indexOf("const gate = gateVisualReviewCandidateForAi", deterministicNoise);

    expect(deterministicNoise).toBeGreaterThan(-1);
    expect(absorption).toBeGreaterThan(deterministicNoise);
    expect(absorption).toBeLessThan(visualGate);
  });

  it("absorbs all-noise section changes only after queued and existing candidates are excluded", () => {
    const body = functionBody("processExpandableSectionComparison", "processOneSectionChange");
    const queuedGuard = body.indexOf("if (queued > 0)");
    const existingGuard = body.indexOf("if (absorbed > 0 || existing > 0)");
    const overflowGuard = body.indexOf("if (unreviewedSectionPairs > 0)", existingGuard);
    const preserveGuard = body.indexOf("if (preservedLastKnownGood > 0)");
    const noiseGuard = body.indexOf("if (rejectedAsNoise > 0)");
    const absorption = body.indexOf("await finishSafeDeterministicNoise", noiseGuard);

    expect(queuedGuard).toBeGreaterThan(-1);
    expect(existingGuard).toBeGreaterThan(queuedGuard);
    expect(overflowGuard).toBeGreaterThan(existingGuard);
    expect(preserveGuard).toBeGreaterThan(overflowGuard);
    expect(noiseGuard).toBeGreaterThan(preserveGuard);
    expect(absorption).toBeGreaterThan(noiseGuard);
    expect(body).toContain('if (outcome === "preserve_last_known_good")');
    expect(body).toContain('reason: "section_candidate_limit_exceeded_preserve_last_known_good"');
    expect(body).toContain("comparisonComplete: false");

    const sectionChange = functionBody("processOneSectionChange", "finishSafeDeterministicNoise");
    expect(sectionChange).toContain('outcome: "preserve_last_known_good"');
    expect(sectionChange).toContain('reason: "unconfirmed_section_presence"');
  });

  it("never deletes a PDF capture after promoting a text-equivalent file", () => {
    const body = functionBody("processPdfComparison", "capturePdfSource");

    expect(body).toContain("baselinePromoted = writeBaseline");
    expect(body).toContain("if (!keepUnchanged && !baselinePromoted)");
  });

  it("copies expandable-section evidence before an overflow capture can be cleaned up", () => {
    const copyEvidence = functionBody("copyEvidenceFiles", "writeBaseline");

    expect(copyEvidence).toContain('"previous_sections_text"');
    expect(copyEvidence).toContain('"new_sections_text"');
    expect(copyEvidence).toContain('"previous_sections_json"');
    expect(copyEvidence).toContain('"new_sections_json"');
  });

  it("defends the deletion boundary and treats dangling pointers as missing", () => {
    const removeBody = functionBody("removeGeneratedCaptureDir", "captureDirIsReferencedByCurrentBaseline");
    const coverageBody = functionBody("hasBaselineForSource", "needsMissingBaselineCompletion");
    const writeBody = functionBody("writeBaseline", "readBaselineEvidence");
    const runBody = functionBody("runOnce", "startRunHeartbeat");

    expect(removeBody).toContain("captureDirIsReferencedByCurrentBaseline");
    expect(removeBody).toContain("PRESERVE baseline_referenced_capture");
    expect(coverageBody).toContain("inspectLocalBaselineEvidence");
    expect(coverageBody).toContain("inspection.evidence_complete === true");
    expect(coverageBody).toContain("localBaselineEvidenceCache.has(source.id)");
    expect(writeBody).toContain("localBaselineEvidenceCache.set(source.id, true)");
    expect(runBody).toContain("localBaselineEvidenceCache.clear()");
  });

  it("limits the pre-review bypass to explicit evidence-capture mode", () => {
    const body = functionBody("filterMonitorableSourcesForCapture", "isSupabaseStatementTimeoutLike");

    expect(source).toContain(
      "--ai-review-evidence-capture=true requires --source-id or --source-ids-file.",
    );
    expect(body).toContain('sourceQualityDecision(source, { purpose: "discovery" })');
    expect(body).toContain('sourceQualityDecision(source, { purpose: "monitoring" })');
    expect(source).toContain(
      "sources = aiReviewEvidenceCapture\n        ? missingTargets\n        : missingTargets.filter",
    );
    expect(source).toContain("retry_known_broken=${aiReviewEvidenceCapture}");
    expect(source).toContain(
      'hygiene.action === "review_later" || !aiReviewEvidenceCapture || failures < 2',
    );
    expect(source).toContain('reason: "repeated_evidence_capture_failure"');
  });

  it("limits held-source quality bypass to exact R2 repair and fails empty exact loads closed", () => {
    const filterBody = functionBody(
      "filterMonitorableSourcesForCapture",
      "isSupabaseStatementTimeoutLike",
    );
    const exactRepairBypass = filterBody.indexOf("isExactHeldR2RepairTarget");
    const monitoringQuality = filterBody.indexOf(
      'sourceQualityDecision(source, { purpose: "monitoring" })',
    );
    expect(exactRepairBypass).toBeGreaterThan(-1);
    expect(exactRepairBypass).toBeLessThan(monitoringQuality);
    expect(filterBody).toContain("sourceIdFilter,");
    expect(filterBody).toContain("r2SnapshotSync,");
    expect(filterBody).toContain("r2RepairMissingSnapshots,");

    const runBody = functionBody("runOnce", "startRunHeartbeat");
    const load = runBody.indexOf("const loadedSources = authoritativeInventory");
    const failClosed = runBody.indexOf("Exact source load failed closed", load);
    const acquisitions = runBody.indexOf("await attachSourceAcquisitions", load);
    expect(load).toBeGreaterThan(-1);
    expect(failClosed).toBeGreaterThan(load);
    expect(failClosed).toBeLessThan(acquisitions);
    expect(runBody).toContain("loadedSources.length !== 1");
    expect(runBody).toContain("loadedSources[0]?.id !== sourceIdFilter");

    const queryBody = functionBody("buildSourcesQuery", "startWorkerRun");
    expect(queryBody).toContain("if (!includeNotDue && !sourceIdFilter)");
  });

  it("repairs and verifies local evidence before submitting source AI review", () => {
    const evidenceStage = catchupSource.indexOf(
      'runStage("source-ai-local-evidence", drainSourceAiEvidence)',
    );
    const reviewStage = catchupSource.indexOf(
      'runStage("source-ai-review", drainSourceAiReview)',
    );
    expect(evidenceStage).toBeGreaterThan(-1);
    expect(reviewStage).toBeGreaterThan(evidenceStage);
    expect(catchupSource).toContain('"--ai-review-evidence-capture=true"');
    expect(catchupSource).toContain('"--require-complete=true"');
  });

  it("re-audits local evidence inside every source AI cycle after queue-producing prep", () => {
    const reviewFunctionStart = catchupSource.indexOf("async function drainSourceAiReview");
    const evidenceFunctionStart = catchupSource.indexOf("async function drainSourceAiEvidence");
    const reviewFunction = catchupSource.slice(reviewFunctionStart, evidenceFunctionStart);
    const loopStart = reviewFunction.indexOf("for (let cycle = 1; ; cycle += 1)");
    const beforeLoop = reviewFunction.slice(0, loopStart);
    const loop = reviewFunction.slice(loopStart);
    const baselineDrain = loop.indexOf("await drainMissingVisualBaselines()");
    const evidenceDrain = loop.indexOf(
      'await drainSourceAiEvidence({ tickerStage: "source-ai-review" })',
    );
    const budgetGuard = loop.indexOf("await ensureGeminiBudget()");
    const paidReview = loop.indexOf("source-ai-review-cycle-${cycle}");

    expect(loopStart).toBeGreaterThan(-1);
    expect(beforeLoop).not.toContain("drainSourceAiEvidence");
    expect(baselineDrain).toBeGreaterThan(-1);
    expect(evidenceDrain).toBeGreaterThan(baselineDrain);
    expect(budgetGuard).toBeGreaterThan(evidenceDrain);
    expect(paidReview).toBeGreaterThan(budgetGuard);
  });

  it("keeps the source AI review stage active during its nested evidence gate", () => {
    const evidenceFunctionStart = catchupSource.indexOf("async function drainSourceAiEvidence");
    const repairFunctionStart = catchupSource.indexOf(
      "async function inspectAndRepairSourceAiEvidence",
    );
    const evidenceFunction = catchupSource.slice(evidenceFunctionStart, repairFunctionStart);
    const entrySnapshot = evidenceFunction.indexOf("const before = await liveSnapshot()");
    const entryTickerGuard = evidenceFunction.indexOf(
      "if (state.current_stage !== tickerStage)",
    );
    const entryTicker = evidenceFunction.indexOf("await updateTicker(tickerStage, before)");
    const sourceSelection = evidenceFunction.indexOf("const sourceIds = sourceAiSourceIds(before)");
    const emptyReturn = evidenceFunction.indexOf("if (!sourceIds.length) return");

    expect(evidenceFunction).toContain(
      'tickerStage = "source-ai-local-evidence"',
    );
    expect(entryTickerGuard).toBeGreaterThan(entrySnapshot);
    expect(entryTicker).toBeGreaterThan(entryTickerGuard);
    expect(sourceSelection).toBeGreaterThan(entryTicker);
    expect(emptyReturn).toBeGreaterThan(sourceSelection);
    expect(evidenceFunction.match(/updateTicker\(tickerStage/g)).toHaveLength(2);
  });

  it("preserves historical R2 pointers during an explicit latest-only refresh", () => {
    const localization = functionBody("syncR2LocalizationLatest", "syncR2BackfillLatestOnly");
    const visualReview = catchupFunctionBody("drainVisualReviewBatch", "drainPageAuditBatch");

    expect(visualReview).toContain('"--r2-snapshot-sync=true"');
    expect(localization).toContain("refreshedLatestVisualSnapshotHistory");
  });

  it("records the raw retained text-object byte length for signed R2 recovery", () => {
    const metadata = functionBody("r2CaptureMetadata", "captureLocalizationMetadata");

    expect(metadata).toContain("text_object_bytes:");
    expect(metadata).toContain("artifactBindings?.text?.byte_length || null");
    expect(source).toContain("prepareR2CaptureArtifacts(files, { readFile: readFileSync })");
  });

  it("projects unavailable geometry honestly into hashes and pointer metadata", () => {
    const hashes = functionBody("r2CaptureHashes", "r2CaptureMetadata");
    const metadata = functionBody("r2CaptureMetadata", "unavailableR2TextGeometryReference");
    const unavailableGeometry = functionBody(
      "unavailableR2TextGeometryReference",
      "r2CaptureLocalizationMetadata",
    );
    const unavailableLocalization = functionBody(
      "r2CaptureLocalizationMetadata",
      "unavailableR2Localization",
    );
    const version = functionBody("immutableR2CaptureVersion", "deleteR2Object");
    const pointer = functionBody("upsertR2SnapshotRecord", "captureR2Files");

    expect(hashes).toContain("artifactBindings.layout");
    expect(hashes).toContain("layout_hash: retainedLayoutHash");
    expect(metadata).toContain("const layoutRetained = Boolean(artifactBindings?.layout)");
    expect(metadata).toContain("unavailableR2TextGeometryReference(capture)");
    expect(unavailableGeometry).toContain("geometry_hash: null");
    expect(unavailableGeometry).toContain("image_hash: null");
    expect(unavailableLocalization).toContain("geometry_ready: false");
    expect(unavailableLocalization).toContain("bound_image_hash: null");
    expect(version).toContain("r2CaptureHashes(capture, artifactBindings)");
    expect(pointer).toContain("latest_hashes: snapshot.latestHashes");
  });

  it("refreshes an existing authoritative pointer only when explicitly forced", () => {
    const repair = functionBody("maybeRepairMissingR2Snapshot", "publishVisualChangeEvent");

    expect(repair).toContain("const snapshotAlreadyExists = existingR2SnapshotSourceIds.has(source.id)");
    expect(repair).toContain("if (snapshotAlreadyExists && !forceR2SnapshotRefresh) return false");
    expect(repair).toContain("await maybeSyncR2Snapshot");
    expect(repair).toContain("report.r2_forced_refreshes += 1");
    expect(repair).toContain("report.r2_repaired_missing += 1");
    expect(source).not.toContain("r2LatestOnlyRefresh");
    expect(source).not.toContain("r2-latest-only-refresh");
  });

  it("keeps R2 authoritative when a no-change capture rewrites localization evidence", () => {
    const sync = functionBody("maybeSyncR2Snapshot", "maybeRepairMissingR2Snapshot");
    const process = functionBody("processSourceUnlocked", "processLocalizationRepairSource");
    const localization = functionBody("processLocalizationRepairSource", "processTextOnlyComparison");

    expect(sync).toContain('"capture_behavior_refresh"');
    expect(sync).toContain('"localization_repair"');
    expect(process).toContain('reason: "capture_behavior_refresh", unchanged: true');
    expect(localization).toContain('reason: "localization_repair", unchanged: true');
  });
});
