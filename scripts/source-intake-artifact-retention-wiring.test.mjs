import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const intakeWorker = readFileSync(
  new URL("./process-source-intake-requests.mjs", import.meta.url),
  "utf8",
);
const captureWorker = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);
const publicationWorker = readFileSync(
  new URL("./process-visual-review-batch.mjs", import.meta.url),
  "utf8",
);

describe("first-observation intake artifact wiring", () => {
  it("resumes staged hash A before any URL refetch and keeps bytes out of capture metadata", () => {
    const stage = intakeWorker.slice(
      intakeWorker.indexOf("async function processCaptureStage"),
      intakeWorker.indexOf("async function submitPendingAiRequests"),
    );
    const stagedCheck = stage.indexOf("stagedRetentionRequired");
    const resume = stage.indexOf("resumeFirstObservationIntakeArtifactRetention");
    const networkCapture = stage.indexOf("captureIntakePage(normalizedUrl");
    expect(stagedCheck).toBeGreaterThan(-1);
    expect(resume).toBeGreaterThan(stagedCheck);
    expect(networkCapture).toBeGreaterThan(resume);
    expect(stage).toContain("retained_artifact_staged: stagedArtifact");
    expect(stage).toContain("artifact_bytes: undefined");
  });

  it("keeps completed retention metadata outside the capture try and persists it on the first DB-write failure", () => {
    const stage = intakeWorker.slice(
      intakeWorker.indexOf("async function processCaptureStage"),
      intakeWorker.indexOf("async function submitPendingAiRequests"),
    );
    const hoist = stage.indexOf("let completedCaptureMetadata = null");
    const captureTry = stage.indexOf("  try {");
    const retained = stage.indexOf("completedCaptureMetadata = captureMetadata");
    const primaryWrite = stage.indexOf("await requireOwnedRequestUpdate(row.id, \"capturing\"");
    const fallbackWrite = stage.indexOf("persistPostRetentionCaptureFailure({");
    expect(hoist).toBeGreaterThan(-1);
    expect(hoist).toBeLessThan(captureTry);
    expect(retained).toBeGreaterThan(captureTry);
    expect(primaryWrite).toBeGreaterThan(retained);
    expect(fallbackWrite).toBeGreaterThan(primaryWrite);
    expect(stage).toContain("captureMetadata: completedCaptureMetadata");
    expect(stage).toContain("POST_RETENTION_CAPTURE_PERSISTENCE_UNVERIFIED_REASON");
  });

  it("never generically refetches a stale protected capture with uncertain retention state", () => {
    const recovery = intakeWorker.slice(
      intakeWorker.indexOf("async function recoverStaleInFlightRequests"),
      intakeWorker.indexOf("async function loadSourceIntakeSpendReservation"),
    );
    expect(recovery).toContain("acquisition_kind,notification_mode,onboarding_batch_id,capture_metadata");
    expect(recovery).toContain("isProtectedLiveFirstCaptureRow(row) && row.status === \"capturing\"");
    expect(recovery).toContain("hasProvenRetainedCaptureMetadata(row)");
    expect(recovery).toContain("hasProvenStagedCaptureMetadata(row)");
    expect(recovery).toContain('"ai_review_pending"');
    expect(recovery).toContain('"stale_protected_capture_resuming_staged_artifact"');
    expect(recovery).toContain("POST_RETENTION_CAPTURE_PERSISTENCE_UNVERIFIED_REASON");
    expect(recovery).toContain("creates_api_charge_on_recovery: false");
    expect(recovery).toContain("downstream_review_may_charge: true");
    expect(recovery.indexOf(": protectedCapture")).toBeLessThan(
      recovery.indexOf("status_reason: `stale_${row.status}_requeued_after_worker_stop`"),
    );
  });

  it("replays an operator reconciliation retry from retained capture and accepted review without spend", () => {
    const retry = intakeWorker.slice(
      intakeWorker.indexOf("async function processRequestedReconciliationRetries"),
      intakeWorker.indexOf("async function recoverStaleInFlightRequests"),
    );
    expect(retry).toContain('"manual_reconciliation_retry_requested"');
    expect(retry).toContain("validateRetainedIntakeArtifactManifest");
    expect(retry).toContain("finalizeReviewedRequest(");
    expect(retry).toContain("creates_api_charge: false");
    expect(retry).not.toContain("captureIntakePage(");
    expect(retry).not.toContain("reserveGeminiSpend(");
    expect(retry).not.toContain("submitGemini");
    expect(retry).toContain('status_reason: "reconciliation_retry_preflight_failed_no_charge"');
    expect(retry).toContain('.eq("status_reason", "manual_reconciliation_retry_requested")');
  });

  it("recovers a crashed zero-charge replay back to the retained-result queue", () => {
    const recovery = intakeWorker.slice(
      intakeWorker.indexOf("async function recoverStaleInFlightRequests"),
      intakeWorker.indexOf("async function processCaptureStage"),
    );
    expect(recovery).toContain('.select("id,status,status_reason,updated_at,acquisition_kind,notification_mode,onboarding_batch_id,capture_metadata")');
    expect(recovery).toContain('row.status_reason === "manual_reconciliation_retry_claimed_no_charge"');
    expect(recovery).toContain('status_reason: "manual_reconciliation_retry_requested"');
    expect(recovery).toContain("stale_free_reconciliation_claims_requeued");
    expect(recovery).toContain("Use the $0 retained-result retry when offered");
  });

  it("materializes an eligible acquisition before the no-baseline write and never passes through the live downloader", () => {
    const processSource = captureWorker.slice(
      captureWorker.indexOf("async function processSourceUnlocked"),
      captureWorker.indexOf("async function processLocalizationRepairSource"),
    );
    const captureChoice = processSource.indexOf("capturePdfSourceForBaseline(source, baseline, report)");
    const baselineWrite = processSource.indexOf("writeBaseline(source, capture");
    expect(captureChoice).toBeGreaterThan(-1);
    expect(baselineWrite).toBeGreaterThan(captureChoice);

    const sealedCapture = captureWorker.slice(
      captureWorker.indexOf("async function capturePdfSourceForBaseline"),
      captureWorker.indexOf("async function capturePdfSource(source)"),
    );
    expect(sealedCapture).toContain("async function capturePdfSourceForBaseline(source, baseline, report)");
    expect(sealedCapture).toContain("materializeFirstObservationCaptureFromAcquisition");
    expect(sealedCapture).toContain("!baseline");
    expect(sealedCapture).toContain("isRetainedLiveFirstCaptureAcquisition(acquisition)");
    expect(sealedCapture).not.toContain("!baselineRefresh");
    expect(sealedCapture).not.toContain("fetchPdfSource(");
    expect(sealedCapture).toContain("record_initial_official_document_quarantine");
    expect(sealedCapture).toContain("report.initial_official_document_intake_artifact_materialized += 1");
    expect(sealedCapture).toContain("report.initial_official_document_intake_artifact_failed += 1");
  });

  it("uses acquisition R2 after rotating baseline recovery cannot restore A and protects repair runs", () => {
    const processSource = captureWorker.slice(
      captureWorker.indexOf("async function processSourceUnlocked"),
      captureWorker.indexOf("async function processLocalizationRepairSource"),
    );
    const rotating = processSource.indexOf("maybeRehydrateIncompleteLocalBaseline");
    const acquisition = processSource.indexOf("maybeRecoverIncompleteBaselineFromIntakeAcquisition");
    const completenessGuard = processSource.indexOf("incompleteLocalBaselineError");
    expect(rotating).toBeGreaterThan(-1);
    expect(acquisition).toBeGreaterThan(rotating);
    expect(completenessGuard).toBeGreaterThan(acquisition);
    expect(processSource).toContain("shouldDeferFirstCaptureBaselineRefresh");
    expect(processSource).toContain("isFirstCaptureCandidateAcquisition(source?.source_acquisition)");

    const refreshProtection = captureWorker.slice(
      captureWorker.indexOf("function isFirstCaptureCandidateAcquisition"),
      captureWorker.indexOf("async function shouldDeferFirstCaptureBaselineRefresh"),
    );
    expect(refreshProtection).toContain('notification_mode === "first_capture_candidate"');
    expect(refreshProtection).not.toContain("acquisition_kind");
    expect(refreshProtection).not.toContain("retained_artifact");

    const recovery = captureWorker.slice(
      captureWorker.indexOf("async function maybeRecoverIncompleteBaselineFromIntakeAcquisition"),
      captureWorker.indexOf("function isR2RehydrationOperationalFailure"),
    );
    expect(recovery).toContain("materializeFirstObservationCaptureFromAcquisition");
    expect(recovery).toContain("baselineFileHash !== captureFileHash");
    expect(recovery).toContain("baselineTextHash !== captureTextHash");
    expect(recovery).toContain("baselineCapturedAt !== captureCapturedAt");
    expect(recovery).toContain('reason: "intake_acquisition_exact_local_recovery"');
    expect(recovery).toContain("if (quarantineError || !quarantineId)");
    expect(recovery).toContain("durable quarantine persistence failed");
    expect(recovery).not.toContain("fetchPdfSource(");
  });

  it("falls back from rotating snapshot recovery to immutable acquisition R2", () => {
    const publication = publicationWorker.slice(
      publicationWorker.indexOf("let eventEvidence;"),
      publicationWorker.indexOf("async function recordInitialOfficialDocumentPublicationQuarantine"),
    );
    const rotating = publication.indexOf("restoreInitialOfficialDocumentCandidateArtifactsFromR2");
    const acquisition = publication.indexOf("restoreInitialOfficialDocumentCandidateArtifactsFromAcquisition");
    const evidenceRetry = publication.lastIndexOf("prepareInitialDocumentEvidence()");
    expect(rotating).toBeGreaterThan(-1);
    expect(acquisition).toBeGreaterThan(rotating);
    expect(evidenceRetry).toBeGreaterThan(acquisition);
  });
});
