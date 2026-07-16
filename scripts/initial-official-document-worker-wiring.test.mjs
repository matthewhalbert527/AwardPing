import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);
const reviewWorker = readFileSync(
  new URL("./process-visual-review-batch.mjs", import.meta.url),
  "utf8",
);

describe("initial official document worker wiring", () => {
  it("loads immutable acquisition provenance before processing sources", () => {
    expect(worker).toContain("attachSourceAcquisitions(await loadSources(limit))");
    const loader = functionBody(worker, "async function attachSourceAcquisitions");
    expect(loader).toContain('.from("shared_award_source_acquisitions")');
    expect(loader).toContain("source_acquisition:");
  });

  it("offers a genuinely new first PDF capture to the deterministic candidate path", () => {
    const processor = functionBody(worker, "async function processSourceUnlocked");
    expect(processor).toContain("const initialDocumentResult = !baseline");
    expect(processor).toContain(
      "maybeEnqueueInitialOfficialDocumentCandidate({ source, capture, report })",
    );
    expect(processor).toContain("markSharedSourceInitialDocumentQuarantined");
  });

  it("binds retries and approved recovery to the retained first baseline before checking for a later revision", () => {
    const comparison = functionBody(worker, "async function processPdfComparison");
    const unchanged = comparison.slice(0, comparison.indexOf("const diff ="));
    expect(unchanged).toContain('acquisition.notification_mode === "first_capture_candidate"');
    expect(unchanged).toContain("const firstObservedCapture = captureFromBaseline(baseline)");
    expect(unchanged).toContain("capture: firstObservedCapture");
    expect(unchanged.indexOf("captureFromBaseline(baseline)")).toBeLessThan(
      unchanged.indexOf("if (!fileChanged)"),
    );
    expect(unchanged).not.toMatch(
      /maybeEnqueueInitialOfficialDocumentCandidate\(\{[\s\S]*?\bsource,\s*\n\s*capture,\s*\n\s*report/,
    );
    expect(unchanged).toContain("removeGeneratedCaptureDir(capture.dir)");
  });

  it("suppresses first-observation publication during bulk and repair modes", () => {
    const enabled = functionBody(worker, "function initialOfficialDocumentNotificationsEnabled");
    expect(enabled).toContain("!baselineRefresh");
    expect(enabled).toContain("!completeMissingBaselines");
    expect(enabled).toContain("!localizationRepair");
    expect(enabled).toContain("!r2BackfillBaselines");
    expect(enabled).toContain("!forceR2SnapshotRefresh");
  });

  it("persists failed first-observation evidence in quarantine instead of reporting a healthy source", () => {
    const enqueue = functionBody(worker, "async function maybeEnqueueInitialOfficialDocumentCandidate");
    expect(enqueue).toContain('"record_initial_official_document_quarantine"');
    expect(enqueue).toContain("initial_official_document_quarantined");
    expect(enqueue).toContain("The next local evidence retry is automatic and free");
    expect(enqueue).toContain("maybeResolveInitialOfficialDocumentQuarantine");
    const quarantinedStatus = functionBody(
      worker,
      "async function markSharedSourceInitialDocumentQuarantined",
    );
    expect(quarantinedStatus).toContain("initial_document_quarantined:");
    expect(quarantinedStatus).not.toContain("last_error: null");
  });

  it("registers first-seen PDF links before deciding whether they are live or seed history", () => {
    const discovery = functionBody(worker, "async function maybeRecordDiscoveredPdfSources");
    expect(discovery).toContain('"register_shared_award_source_pdf_links"');
    expect(discovery).toContain('p_live_requested: discoveryIntent === "live_recurring"');
    expect(discovery).toContain("chunkArray(urls, maxPdfDiscoveryRegistrationBatchSize)");
    expect(discovery).toContain("p_scan_complete: pdfDiscovery.scanComplete === true && finalBatch");
    expect(discovery).toContain("linkProvenanceByUrl");
    expect(discovery).toContain('provenance.notification_mode === "first_capture_candidate"');
    expect(discovery).toContain("provenance.source_page_request_id");
    expect(discovery.indexOf("register_shared_award_source_pdf_links")).toBeLessThan(
      discovery.indexOf("if (!urls.length) return"),
    );
    expect(discovery.indexOf("register_shared_award_source_pdf_links")).toBeLessThan(
      discovery.indexOf("reserveDiscoveryCap"),
    );
  });

  it("leaves a blocked first scan unseeded so the first healthy historical scan remains baseline-only", () => {
    const capture = functionBody(worker, "async function captureSource");
    const validation = capture.indexOf("const invalidCapture = classifyInvalidPageCapture");
    const rejection = capture.indexOf("if (invalidCapture)");
    const evidenceWrite = capture.indexOf("writeFileSync(metaPath");
    const durableRegistration = capture.indexOf(
      "await maybeRecordDiscoveredPdfSources(source, pdfDiscoveryForRegistration, expanded, report)",
    );

    expect(validation).toBeGreaterThan(-1);
    expect(rejection).toBeGreaterThan(validation);
    expect(evidenceWrite).toBeGreaterThan(rejection);
    expect(durableRegistration).toBeGreaterThan(evidenceWrite);
    expect(capture.slice(rejection, durableRegistration)).toContain("throw new Error");
  });

  it("applies policy freshness and global suppression before preparing or publishing evidence", () => {
    const publisher = functionBody(
      reviewWorker,
      "async function publishInitialOfficialDocumentCandidate",
    );
    expect(publisher).toContain("latestVisualReviewPolicyDecision");
    expect(publisher).toContain('policyDecision.guard === "policy_freshness"');
    expect(publisher).toContain("requeueInitialDocumentCandidateForCurrentPolicy");
    expect(publisher).toContain("recordVisualRejectionLedger");
    expect(publisher.indexOf("latestVisualReviewPolicyDecision")).toBeLessThan(
      publisher.indexOf("preparePublishedInitialOfficialDocumentEvidence"),
    );
    expect(publisher.indexOf("latestVisualReviewPolicyDecision")).toBeLessThan(
      publisher.indexOf("publish_shared_award_initial_document_event"),
    );
  });

  it("restores only missing immutable candidate artifacts from the exact R2 source generation", () => {
    const publisher = functionBody(
      reviewWorker,
      "async function publishInitialOfficialDocumentCandidate",
    );
    expect(publisher).toContain("isDeterministicVisualArtifactError(error)");
    expect(publisher).toContain('error.code !== "visual_artifact_missing"');
    expect(publisher).toContain("loadInitialOfficialDocumentR2SnapshotRecord");
    expect(publisher).toContain("restoreInitialOfficialDocumentCandidateArtifactsFromR2");
    expect(publisher).toContain("candidateArtifactRestore.artifact_count");
    expect(publisher).toContain("initial_document_candidate_artifact_restore: restoreEvidence");
    expect(publisher).toContain('"candidate_artifact_recovery"');
    expect(publisher).toContain('"permanent_evidence_preparation"');
    expect(publisher).toContain("recordInitialOfficialDocumentPublicationQuarantine({");
    expect(publisher).toContain('rejection_disposition: "actionable_initial_document_quarantine"');
    expect(publisher).toContain("manual_quarantine_id: quarantineId");
    expect(publisher).toContain("creates_api_charge: false");
    expect(publisher.indexOf("restoreInitialOfficialDocumentCandidateArtifactsFromR2")).toBeLessThan(
      publisher.lastIndexOf("prepareInitialDocumentEvidence()"),
    );

    const loader = functionBody(
      reviewWorker,
      "async function loadInitialOfficialDocumentR2SnapshotRecord",
    );
    expect(loader).toContain('.from("shared_award_source_visual_snapshots")');
    expect(loader).toContain("latest_object_keys");
    expect(loader).toContain("previous_object_keys");
    expect(reviewWorker).toContain("initial_official_document_r2_restore_attempted: 0");
    expect(reviewWorker).toContain("initial_official_document_r2_artifacts_restored: 0");
    expect(reviewWorker).toContain("initial_official_document_r2_restore_failed: 0");
    const quarantine = functionBody(
      reviewWorker,
      "async function recordInitialOfficialDocumentPublicationQuarantine",
    );
    expect(quarantine).toContain('supabase.rpc(\n    "record_initial_official_document_quarantine"');
    expect(quarantine).toContain("candidate_artifact_restore: candidateArtifactRestore");
    expect(quarantine).toContain("resolves_only_after_publication: true");
  });

  it("durably quarantines publication persistence failures but not reconciliation-only retries", () => {
    const publisher = functionBody(
      reviewWorker,
      "async function publishInitialOfficialDocumentCandidate",
    );
    expect(publisher).toContain("initialDocumentPublicationPersistenceFailed(publication)");
    expect(publisher).toContain('failureStage: "publication_persistence"');
    expect(publisher).toContain('retryMode: "automatic_zero_charge_publication_retry"');
    expect(publisher).toContain(': "award_reconciliation_enqueue",');
    expect(publisher).toContain("publicationQuarantineId");
    expect(publisher).toContain('rejection_disposition: "actionable_initial_document_quarantine"');

    const classifier = functionBody(
      reviewWorker,
      "function initialDocumentPublicationPersistenceFailed",
    );
    expect(classifier).toContain("publication?.event_id");
    expect(classifier).toContain("publication?.evidence_id");
    expect(classifier).toContain("reconciliation-only");

    const quarantine = functionBody(
      reviewWorker,
      "async function recordInitialOfficialDocumentPublicationQuarantine",
    );
    expect(quarantine).toContain("publication_failure: publicationFailure");
    expect(quarantine).toContain("retry_mode: retryMode");
  });

  it("accepts only a sealed initial-document redirect and quarantines other URL drift before generic supersession", () => {
    const publisher = functionBody(reviewWorker, "async function publishCandidateResultUnlocked");
    expect(publisher).toContain("initialOfficialDocumentSourceIdentityDecision({ candidate, source })");
    expect(publisher).toContain('failureStage: "source_identity"');
    expect(publisher).toContain('status: "succeeded"');
    expect(publisher).toContain('rejection_disposition: "actionable_initial_document_quarantine"');
    expect(publisher.indexOf("initialOfficialDocumentSourceIdentityDecision")).toBeLessThan(
      publisher.indexOf("visualReviewSourceIdentityFreshness"),
    );

    const initialPublisher = functionBody(
      reviewWorker,
      "async function publishInitialOfficialDocumentCandidate",
    );
    expect(initialPublisher).toContain("decision.source_identity?.event_source_url || source.url");
    expect(initialPublisher).toContain("resolveInitialOfficialDocumentPublicationQuarantine");
  });

  it("quarantines validation failures while keeping intentional suppression non-actionable", () => {
    const publisher = functionBody(
      reviewWorker,
      "async function publishInitialOfficialDocumentCandidate",
    );
    expect(publisher).toContain("recordInitialOfficialDocumentPublicationQuarantine");
    expect(publisher).toContain('failureStage: "publication_guard"');
    expect(publisher).toContain(
      'const intentionallySuppressed = policyDecision.guard === "change_event_suppression"',
    );
    expect(publisher).toMatch(
      /const quarantineId = intentionallySuppressed\s*\? null\s*:\s*await recordInitialOfficialDocumentPublicationQuarantine/,
    );
    expect(publisher).toContain('"intentional_policy_suppression_non_actionable"');
    expect(publisher).toContain('"actionable_initial_document_quarantine"');

    const quarantine = functionBody(
      reviewWorker,
      "async function recordInitialOfficialDocumentPublicationQuarantine",
    );
    expect(quarantine).toContain('"record_initial_official_document_quarantine"');
    expect(quarantine).toContain("initial_official_document_quarantined");
    expect(quarantine).toContain("approve another paid new-page review only if");
  });

  it("refreshes stale first-observation policy through the atomic zero-charge RPC", () => {
    const requeue = functionBody(
      reviewWorker,
      "async function requeueInitialDocumentCandidateForCurrentPolicy",
    );
    expect(requeue).toContain('"refresh_shared_award_initial_document_candidate_policy"');
    expect(requeue).toContain("p_publication_claim_token: publicationClaimToken");
    expect(requeue).toContain("p_monitoring_policy_bundle:");
    expect(requeue).not.toContain('.from("shared_award_visual_review_candidates")\n    .update');
  });

  it("moves stale paid reviews back to pending before refreshing their frozen identity", () => {
    const requeue = functionBody(reviewWorker, "async function requeueCandidateForCurrentPolicy");
    expect(requeue).toContain('status: "pending"');
    expect(requeue).not.toContain("candidate_signature:");
    expect(requeue).not.toContain("prompt_payload:");
    expect(requeue).not.toContain("prompt_context:");
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
