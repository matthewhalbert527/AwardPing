import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);

describe("Stage 1 first-visual-baseline activation worker wiring", () => {
  it("loads the immutable acquisition and the exact three-field source hold", () => {
    expect(worker).toContain("captureIntakePage,");
    expect(worker).toContain("evaluateStage1FirstVisualBaselineActivation,");
    expect(worker).toContain("isStage1BaselineActivationAcquisition,");
    expect(worker).toContain("isStage1PendingBaselineActivationSource,");
    expect(worker).toContain(
      '"id, admin_review_status, admin_review_note, admin_reviewed_by"',
    );
    expect(worker).toContain(
      '"id, shared_award_id, url, title, display_title, page_description, page_metadata, page_metadata_generated_at, page_metadata_model, page_type, source, reason, submitted_by_user_id, admin_review_status, admin_review_note, admin_reviewed_at, admin_reviewed_by, last_checked_at, next_check_at, consecutive_failures, last_error, created_at, shared_awards!inner(id, name, status, official_homepage)"',
    );

    const process = functionBody(
      "async function processSourceUnlocked",
      "async function processLocalizationRepairSource",
    );
    expect(process).toContain("const exactPendingStage1Activation = currentReviewState");
    expect(process).toContain("isStage1PendingBaselineActivationSource({");
    expect(process).toContain("currentReviewState.admin_review_status !== \"open\"");
    expect(process).toContain("&& !exactPendingStage1Activation");
    expect(process).toContain(
      "const pendingStage1Activation = isStage1PendingBaselineActivationSource(source)",
    );
    expect(process).toContain("suppressDiscovery: pendingStage1Activation");
    expect(process).toContain("const stage1Activation = pendingStage1Activation");

    const acquisitions = functionBody(
      "async function attachSourceAcquisitions",
      "async function loadSourcesByIds",
    );
    expect(acquisitions).toContain(
      "const exactStage1Activation = isStage1BaselineActivationAcquisition(acquisition)",
    );
    expect(acquisitions).toContain("Multiple exact Stage 1 baseline activation acquisitions");
  });

  it("durably quarantines a terminal activation capture failure", () => {
    const start = worker.indexOf("async function processQueuedSource");
    const end = worker.indexOf(
      "await maybeUpdateBaselineCoverageProgress",
      start,
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const queued = worker.slice(start, end);
    expect(queued).toContain("stage1BaselineActivationVisualCaptureFailure");
    expect(queued).toContain("isStage1PendingBaselineActivationSource(source)");
    expect(queued).toContain("isSourceTimeoutError(error)");
    expect(queued).toContain('"stage1_baseline_activation_visual_capture_failed"');
    expect(queued).toContain("persistStage1BaselineActivationFailure");
    expect(queued).toContain(
      'failureStage: "first_visual_capture_before_exact_verification"',
    );

    const process = functionBody(
      "async function processSourceUnlocked",
      "async function processLocalizationRepairSource",
    );
    expect(process).toContain("stage1BaselineActivationVisualCaptureFailure: true");
  });

  it("verifies exact retained text and visual wording before requesting prepare", () => {
    const enforce = functionBody(
      "async function enforceStage1FirstVisualBaselineActivation",
      "function attachStage1BaselineActivationVerification",
    );
    const bindingPreflight = enforce.indexOf("bindingOnly: true");
    const requiredR2 = enforce.indexOf("if (!r2SnapshotSync)");
    const comparisonCapture = enforce.indexOf("captureIntakePage(source.url");
    const exactEvaluation = enforce.indexOf(
      "const evaluation = evaluateStage1FirstVisualBaselineActivation",
    );
    const prepare = enforce.indexOf('"record_stage1_source_baseline_activation"');
    const metadata = enforce.indexOf("attachStage1BaselineActivationVerification");

    expect(bindingPreflight).toBeGreaterThan(-1);
    expect(requiredR2).toBeGreaterThan(bindingPreflight);
    expect(comparisonCapture).toBeGreaterThan(requiredR2);
    expect(exactEvaluation).toBeGreaterThan(comparisonCapture);
    expect(prepare).toBeGreaterThan(exactEvaluation);
    expect(metadata).toBeGreaterThan(prepare);
    expect(enforce).toContain("retainedComparisonCapture,");
    expect(enforce).toContain("sourceId: source.id,");
    expect(enforce).toContain("buildStage1BaselineActivationRecordRpcArgs");
    expect(enforce).not.toContain("maybeExtractBaselineFacts");
    expect(enforce).not.toContain("runGemini");
  });

  it("cannot enqueue source discoveries while producing the reviewed baseline", () => {
    const capture = functionBody(
      "async function captureSource",
      "async function captureExpansionStateEvidence",
    );
    expect(capture).toMatch(
      /\{\s*baseline = null,\s*suppressDiscovery = false,\s*networkProxy = null,\s*sourceDeadline = null,\s*\} = \{\}/u,
    );
    expect(capture.match(/!suppressDiscovery && discoveryMode/g)).toHaveLength(3);
  });

  it("restarts a fresh browser when a wrapped source boundary cannot shut down", () => {
    expect(worker).toContain("function isCaptureNetworkBoundaryError(error)");
    expect(worker).toContain('"AWARDPING_CAPTURE_CONTEXT_SHUTDOWN"');
    expect(worker).toContain('"AWARDPING_CAPTURE_PROXY_SHUTDOWN"');
    expect(worker).toContain('await restartBrowser(state, "after_failed_stage1_capture")');
  });

  it("persists locally and to R2 after prepare, then finalizes before opening success", () => {
    const process = functionBody(
      "async function processSourceUnlocked",
      "async function processLocalizationRepairSource",
    );
    const capture = process.indexOf("let capture;");
    const enforce = process.indexOf("enforceStage1FirstVisualBaselineActivation");
    const activationBranch = process.indexOf("if (stage1Activation?.verification)");
    const baselineWrite = process.indexOf("written = writeBaseline", activationBranch);
    const r2Write = process.indexOf("const r2Result = await maybeSyncR2Snapshot", baselineWrite);
    const persistenceEvidence = process.indexOf(
      "buildStage1BaselineActivationPersistenceEvidence",
      r2Write,
    );
    const markSuccess = process.indexOf(
      "markSharedSourceVisualCheckSucceeded",
      persistenceEvidence,
    );
    const finalize = process.indexOf("finalizeStage1BaselineActivation", markSuccess);
    const ordinaryPath = process.indexOf("const previous = baseline", finalize);

    expect(capture).toBeGreaterThan(-1);
    expect(enforce).toBeGreaterThan(capture);
    expect(activationBranch).toBeGreaterThan(enforce);
    expect(baselineWrite).toBeGreaterThan(activationBranch);
    expect(r2Write).toBeGreaterThan(baselineWrite);
    expect(persistenceEvidence).toBeGreaterThan(r2Write);
    expect(markSuccess).toBeGreaterThan(persistenceEvidence);
    expect(finalize).toBeGreaterThan(markSuccess);
    expect(ordinaryPath).toBeGreaterThan(finalize);

    const activationOnly = process.slice(activationBranch, ordinaryPath);
    expect(activationOnly).toContain('reason: "stage1_reviewed_baseline_activation"');
    expect(activationOnly).toContain("restoreBaselineAfterFailedStage1Activation");
    expect(activationOnly).toContain("if (!finalized) return");
    expect(activationOnly).toContain("preserveReviewedUrl: true");
    expect(activationOnly).toContain("preserveReviewedMetadata: true");
    expect(activationOnly).toContain(
      'failureStage: "source_check_metadata_before_finalization"',
    );
    expect(activationOnly).not.toContain("maybeExtractBaselineFacts");
    expect(activationOnly).not.toContain("maybeEnqueueInitialOfficialDocumentCandidate");
    expect(activationOnly).not.toContain("publishVisualChangeEvent");

    const ordinaryBaselineFacts = process.indexOf("await maybeExtractBaselineFacts", ordinaryPath);
    expect(ordinaryBaselineFacts).toBeGreaterThan(ordinaryPath);
  });

  it("requires auditable R2 bindings for finalization and durably fails closed", () => {
    const evidence = functionBody(
      "function buildStage1BaselineActivationPersistenceEvidence",
      "async function finalizeStage1BaselineActivation",
    );
    expect(evidence).toContain("localVerification.guard_sha256 !== evaluation.guard_sha256");
    expect(evidence).toContain("captureVerification.guard_sha256 !== evaluation.guard_sha256");
    expect(evidence).toContain("r2Verification.guard_sha256 !== evaluation.guard_sha256");
    expect(evidence).toContain("r2Result?.succeeded !== true");
    expect(evidence).toContain("latestHashes.text_hash !== capture.text_hash");
    expect(evidence).toContain("localRawTextSha256 !== baseline.text_hash");
    expect(evidence).toContain('!/^[0-9a-f]{64}$/.test(localNormalizedTextSha256 || "")');
    expect(evidence).toContain(
      "r2Verification.observed_normalized_text_sha256 !==",
    );
    expect(evidence).toContain("r2Verification.visual_evidence_quotes_verified !== true");
    expect(evidence).toContain("stage1RetainedArtifactProjectionParity");
    expect(evidence).toContain("!artifactProjectionParity.valid");
    expect(evidence).toContain("normalized_text_sha256: localNormalizedTextSha256");
    expect(evidence).toContain("local_baseline_written: true");
    expect(evidence).toContain("r2_sync_succeeded: true");
    expect(evidence).toContain("creates_api_charge: false");

    const projectionParity = functionBody(
      "function stage1RetainedArtifactProjectionParity",
      "async function finalizeStage1BaselineActivation",
    );
    expect(projectionParity).toContain("retained_artifact_projection_disagrees");
    expect(projectionParity).toContain("retained_expansion_projection_disagrees");
    expect(projectionParity).toContain("retained_layout_projection_disagrees");
    expect(projectionParity).toContain("unavailable_layout_projection_overclaimed");

    const finalize = functionBody(
      "async function finalizeStage1BaselineActivation",
      "async function processSourceUnlocked",
    );
    expect(finalize).toContain('"finalize_stage1_source_baseline_activation"');
    expect(finalize).toContain("buildStage1BaselineActivationFinalizeRpcArgs");
    expect(finalize).toContain("stage1BaselineActivationFinalizationReceipt");
    expect(finalize).toContain("persistStage1BaselineActivationFailure");

    const failure = functionBody(
      "async function persistStage1BaselineActivationFailure",
      "function restoreBaselineAfterFailedStage1Activation",
    );
    expect(failure).toContain('"fail_stage1_source_baseline_activation"');
    expect(failure).toContain("buildStage1BaselineActivationFailureRpcArgs");
    expect(failure).toContain("creates_api_charge: false");

    const r2 = functionBody(
      "async function maybeSyncR2Snapshot",
      "async function maybeRepairMissingR2Snapshot",
    );
    expect(r2).toContain("return { succeeded: true, ...result }");
    expect(r2).toContain("return false");

    const success = functionBody(
      "async function markSharedSourceVisualCheckSucceeded",
      "async function markSharedSourceReviewLater",
    );
    expect(success).toContain(
      "{ preserveReviewedUrl = false, preserveReviewedMetadata = false } = {}",
    );
    expect(success).toContain("const metadataUpdate = preserveReviewedMetadata");
    expect(success).toContain("if (!preserveReviewedUrl)");
    expect(success).toContain("maybeUpdateSafeRedirectUrl");
  });

  it("binds prepare verification into capture, baseline, and R2 metadata", () => {
    const attach = functionBody(
      "function attachStage1BaselineActivationVerification",
      "function failedStage1BaselineActivationEvaluation",
    );
    expect(attach).toContain("capture.stage1_baseline_activation = verification");
    expect(attach).toContain("atomicWriteJson(capture.meta_path");

    const baseline = functionBody("function writeBaseline", "function readBaselineEvidence");
    expect(baseline).toContain("stage1_baseline_activation:");
    expect(baseline).toContain("capture.stage1_baseline_activation");

    const r2Metadata = functionBody(
      "function r2CaptureMetadata",
      "function captureLocalizationMetadata",
    );
    expect(r2Metadata).toContain("stage1_baseline_activation:");
    expect(r2Metadata).toContain("capture.stage1_baseline_activation");
  });
});

function functionBody(startSignature, endSignature) {
  const start = worker.indexOf(startSignature);
  if (start < 0) throw new Error(`Missing ${startSignature}`);
  const end = worker.indexOf(endSignature, start + startSignature.length);
  if (end < 0) throw new Error(`Missing ${endSignature}`);
  return worker.slice(start, end);
}
