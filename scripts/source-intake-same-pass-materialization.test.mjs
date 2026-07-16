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

describe("same-pass first-observation materialization", () => {
  it("blocks facts, reconciliation, and added status until the exact candidate is verified", () => {
    const finalize = functionBody(intakeWorker, "async function finalizeReviewedRequest");
    const materialize = finalize.indexOf("ensureInitialOfficialDocumentCandidateMaterialized({");
    const facts = finalize.indexOf("factCandidateRowsFromIntake({");
    const reconciliation = finalize.indexOf("enqueueAwardReconciliation(supabase");
    const added = finalize.indexOf('status: "added"');

    expect(materialize).toBeGreaterThan(-1);
    expect(facts).toBeGreaterThan(materialize);
    expect(reconciliation).toBeGreaterThan(facts);
    expect(added).toBeGreaterThan(reconciliation);
    expect(finalize).toContain('sourceWrite.acquisition.notification_mode === "first_capture_candidate"');
  });

  it("verifies immutable scope, award, source, acquisition, URL, hash, status, and zero-charge publication", () => {
    const verify = functionBody(
      intakeWorker,
      "function verifyInitialOfficialDocumentCandidate",
    );
    const loader = functionBody(
      intakeWorker,
      "async function loadInitialOfficialDocumentCandidate",
    );

    expect(loader).toContain('.from("shared_award_visual_review_candidates")');
    expect(loader).toContain('.eq("source_acquisition_id", acquisitionId)');
    expect(loader).toContain('.eq("candidate_scope", INITIAL_OFFICIAL_DOCUMENT_SCOPE)');
    expect(verify).toContain("candidate.shared_award_id");
    expect(verify).toContain("candidate.shared_award_source_id");
    expect(verify).toContain("candidate.source_acquisition_id");
    expect(verify).toContain("candidate.source_url");
    expect(verify).toContain("candidate.new_file_hash");
    expect(verify).toContain('["succeeded", "published"]');
    expect(verify).toContain("initialOfficialDocumentPublicationDecision({");
  });

  it("reserves only the remaining source-intake lane time for the child", () => {
    const ensure = functionBody(
      intakeWorker,
      "async function ensureInitialOfficialDocumentCandidateMaterialized",
    );
    expect(ensure).toContain("deadlineAtMs - Date.now() - deadlineMarginMs");
    expect(ensure).toContain(
      "Math.min(initialDocumentMaterializationTimeoutMs, remainingLaneBudgetMs)",
    );
    expect(ensure).toContain("remainingLaneBudgetMs < 5_000");
  });

  it("runs a sealed, single-source, non-AI child and never reserves another Gemini review", () => {
    const child = functionBody(
      intakeWorker,
      "async function runInitialOfficialDocumentMaterialization",
    );

    expect(child).toContain('"--all=true"');
    expect(child).toContain('"--pdf-only=true"');
    expect(child).toContain('"--visual-review-mode=batch"');
    expect(child).toContain('"--extract-baseline-info=false"');
    expect(child).toContain('"--backfill-baseline-info=false"');
    expect(child).toContain('"--discovery-mode=false"');
    expect(child).toContain('"--r2-snapshot-sync=true"');
    expect(child).toContain("--archive-dir=");
    expect(child).toContain('"--initial-official-document-materialization=true"');
    expect(child).toContain("--initial-official-document-acquisition-id=");
    expect(child).toContain("--source-timeout-ms=");
    expect(child).not.toContain("captureIntakePage(");
    expect(child).not.toContain("reserveGeminiSpend(");
    expect(child).not.toContain("submitGemini");

    const workerName = functionBody(captureWorker, "function visualWorkerName");
    expect(workerName).toContain("initialOfficialDocumentMaterialization");
    expect(workerName).toContain("local-visual-snapshot-worker-initial-document");
  });

  it("makes the dedicated capture mode incapable of fetching the live PDF", () => {
    const dedicated = functionBody(
      captureWorker,
      "async function processInitialOfficialDocumentMaterializationOnly",
    );
    const sealed = functionBody(
      captureWorker,
      "async function materializeSealedFirstObservationCapture",
    );

    expect(dedicated).toContain("materializeSealedFirstObservationCapture(source, report)");
    expect(dedicated).toContain("maybeEnqueueInitialOfficialDocumentCandidate({");
    expect(dedicated).toContain("initialOfficialDocumentAcquisitionId");
    expect(dedicated).not.toMatch(/await\s+capturePdfSource\(/);
    expect(dedicated).not.toMatch(/await\s+fetchPdfSource\(/);
    expect(sealed).toContain("materializeFirstObservationCaptureFromAcquisition({");
    expect(sealed).not.toMatch(/await\s+capturePdfSource\(/);
    expect(sealed).not.toMatch(/await\s+fetchPdfSource\(/);
  });

  it("proves authoritative R2 state before an absent baseline can be written or rotated", () => {
    const dedicated = functionBody(
      captureWorker,
      "async function processInitialOfficialDocumentMaterializationOnly",
    );
    const recovery = dedicated.indexOf(
      "maybeRehydrateIncompleteLocalBaseline(source, baseline, report)",
    );
    const failClosed = dedicated.indexOf("if (!baseline && recovery.failClosed)");
    const sealedReplay = dedicated.indexOf(
      "materializeSealedFirstObservationCapture(source, report)",
    );
    const baselineWrite = dedicated.indexOf("writeBaseline(source, capture");
    const r2Sync = dedicated.indexOf("maybeSyncR2Snapshot(source, capture, report");

    expect(recovery).toBeGreaterThan(-1);
    expect(failClosed).toBeGreaterThan(recovery);
    expect(sealedReplay).toBeGreaterThan(failClosed);
    expect(baselineWrite).toBeGreaterThan(sealedReplay);
    expect(r2Sync).toBeGreaterThan(baselineWrite);
    expect(dedicated).toContain("baseline = recovery.baseline");
    expect(dedicated).toContain("throw authoritativeR2MissingBaselineError(recovery)");
    expect(dedicated).toContain("recovery?.quarantineResolutionSucceeded !== true");
    expect(dedicated).toContain(
      'stage: "initial_official_document_pre_publication_review_state"',
    );
    expect(dedicated).toContain('currentReviewState.admin_review_status !== "open"');
    expect(dedicated).toContain("INITIAL_OFFICIAL_DOCUMENT_REVIEW_HOLD no_sealed_publication");
    expect(dedicated).toContain("if (!baseline) {");
    expect(dedicated).toContain(
      "report.initial_official_document_materialization_only_baseline_preserved += 1",
    );
    expect(dedicated).not.toContain("initial_official_document_same_capture_baseline_repair");

    const sourceQuery = functionBody(captureWorker, "function buildSourcesQuery");
    expect(sourceQuery).toContain("admin_review_status, admin_reviewed_by");
    expect(sourceQuery).toContain("if (!sourceIdFilter)");
    expect(sourceQuery).toContain('query = query.eq("admin_review_status", "open")');
  });

  it("durably quarantines failures for retained-result replay without charge", () => {
    const quarantine = functionBody(
      intakeWorker,
      "async function recordSourceIntakeMaterializationQuarantine",
    );
    const retry = intakeWorker.slice(
      intakeWorker.indexOf("async function processRequestedReconciliationRetries"),
      intakeWorker.indexOf("async function recoverStaleInFlightRequests"),
    );

    expect(quarantine).toContain('"record_initial_official_document_quarantine"');
    expect(quarantine).toContain('failure_stage: "source_intake_same_pass_materialization"');
    expect(quarantine).toContain('retry_mode: "reconciliation_only_retained_result_replay"');
    expect(quarantine).toContain("creates_api_charge: false");
    expect(quarantine).toContain("fetches_source_url: false");
    expect(retry).toContain("validateRetainedIntakeArtifactManifest");
    expect(retry).toContain("finalizeReviewedRequest(");
    expect(retry).not.toContain("captureIntakePage(");
    expect(retry).not.toContain("reserveGeminiSpend(");
  });
});

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing ${signature}`);
  const nextAsync = source.indexOf("\nasync function ", start + signature.length);
  const nextSync = source.indexOf("\nfunction ", start + signature.length);
  const candidates = [nextAsync, nextSync].filter((value) => value >= 0);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}
