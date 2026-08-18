import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workerPath = resolve(import.meta.dirname, "capture-visual-snapshots.mjs");
const worker = readFileSync(workerPath, "utf8");

function functionBody(name, nextName) {
  const start = worker.indexOf(`function ${name}`);
  const asyncStart = worker.indexOf(`async function ${name}`);
  const actualStart = start === -1 ? asyncStart : asyncStart === -1 ? start : Math.min(start, asyncStart);
  const end = worker.indexOf(nextName, actualStart + 1);
  if (actualStart < 0 || end < 0) throw new Error(`Unable to extract ${name}.`);
  return worker.slice(actualStart, end);
}

describe("Stage 1 evidence-schema-upgrade worker isolation", () => {
  it("routes at the first line of processSourceUnlocked and cannot reach normal capture", () => {
    const body = functionBody("processSourceUnlocked", "async function processLocalizationRepairSource");
    const route = body.indexOf("if (stage1EvidenceSchemaUpgrade)");
    const recoveryGate = body.indexOf(
      "shouldBlockOrdinaryProcessingForStage1UpgradeRecovery(source, report)",
    );
    const ordinary = body.indexOf("if (initialOfficialDocumentMaterialization)");
    const baseline = body.indexOf("const baselinePath = baselinePathForSource(source.id)");
    expect(route).toBeGreaterThan(-1);
    expect(recoveryGate).toBeGreaterThan(route);
    expect(recoveryGate).toBeLessThan(ordinary);
    expect(route).toBeLessThan(ordinary);
    expect(route).toBeLessThan(baseline);
    expect(body.slice(route, ordinary)).toContain("return runStage1EvidenceSchemaUpgradeSource");
  });

  it("fail-closes ordinary processing while an active Stage 1 recovery journal exists or is unreadable", () => {
    const loader = functionBody(
      "loadStage1EvidenceSchemaUpgradeActiveJournal",
      "function shouldBlockOrdinaryProcessingForStage1UpgradeRecovery",
    );
    const gate = functionBody(
      "shouldBlockOrdinaryProcessingForStage1UpgradeRecovery",
      "function stage1EvidenceSchemaUpgradeCommitInterfaces",
    );
    expect(loader).toContain("assertStage1EvidenceSchemaUpgradeJournal(journal)");
    expect(gate).toContain("active_upgrade_journal_unreadable");
    expect(gate).toContain("active_upgrade_journal_requires_apply_recovery");
    expect(gate).toContain("creates_api_charge: false");
    expect(gate.match(/return true;/g)).toHaveLength(2);
    expect(gate).toContain("if (!activeJournal) return false;");
    expect(gate).not.toContain("markSharedSource");
    expect(gate).not.toContain("advanceVisualSnapshotPointer");
    expect(gate).not.toContain("writeBaseline");
  });

  it("gates the standalone R2 baseline backfill before it reads or mutates baseline authority", () => {
    const body = functionBody(
      "backfillOneR2BaselineUnlocked",
      "async function processSource",
    );
    const gate = body.indexOf("shouldBlockOrdinaryProcessingForStage1UpgradeRecovery");
    const baselineRead = body.indexOf("readJsonIfExists(baselinePathForSource(source.id))");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(baselineRead);
    expect(body.slice(gate, baselineRead)).toContain("return");
  });

  it("keeps reviewed-nine dry-run write-free and routes apply away from generic worker-run supersession", () => {
    const body = functionBody("runOnce", "async function runStage1EvidenceSchemaUpgradeMode");
    const isolated = body.indexOf("if (stage1EvidenceSchemaUpgrade)");
    const ordinaryStart = body.indexOf(
      "workerRunId = await startWorkerRun(report)",
      isolated + 1,
    );
    const branch = body.slice(isolated, ordinaryStart);
    expect(branch).toContain("if (stage1EvidenceSchemaUpgradeDryRun)");
    expect(branch).toContain("await runStage1EvidenceSchemaUpgradeMode(report");
    expect(branch).toContain("await runStage1EvidenceSchemaUpgradeReviewedApplyMode(report");
    expect(branch).not.toContain("startWorkerRun(");
    expect(branch).not.toContain("finishWorkerRun(");
    expect(branch).not.toContain("markSupersededVisualWorkerRuns");
    expect(branch).toContain("return;");
  });

  it("handles isolated exceptions locally without generic source-health mutations", () => {
    const body = functionBody(
      "runStage1EvidenceSchemaUpgradeMode",
      "async function runStage1EvidenceSchemaUpgradeReviewedApplyMode",
    );
    expect(body).toContain("buildStage1EvidenceSchemaUpgradeFailureResult");
    expect(body).not.toContain("recordBrokenSourceFailure");
    expect(body).not.toContain("markSharedSourceVisualCheckFailed");
    expect(body).not.toContain("observeVisualReviewCandidateRun");
    expect(body).not.toContain("enqueueVisualReviewCandidate(");
  });

  it("canonicalizes only the live finalization timestamp while preserving exact authority identities", () => {
    const body = functionBody(
      "assertStage1EvidenceSchemaUpgradeReviewedApplyAuthority",
      "function stage1EvidenceSchemaUpgradeReviewedAuthorityError",
    );
    expect(body).toContain(
      "stage1EvidenceSchemaUpgradeCanonicalTimestamp(\n      source.source_activation_finalization?.finalized_at,\n    )",
    );
    expect(body).toContain(
      "comparePreciseRfc3339(\n      source.source_activation_finalization?.finalized_at,\n      source.source_activation_finalization?.receipt?.finalized_at,\n    ) !== 0",
    );
    expect(body).toContain(
      "comparePreciseRfc3339(\n      source.source_activation_finalization?.finalized_at,\n      source.admin_reviewed_at,\n    ) !== 0",
    );
    expect(body).toContain(
      "source.source_acquisition?.id !== expectedAcquisition.source_acquisition_id",
    );
    expect(body).toContain(
      "source.source_activation_finalization?.source_acquisition_id\n      !== expectedAcquisition.source_acquisition_id",
    );
    expect(body).toContain(
      "source.source_activation_finalization?.guard_sha256\n      !== expectedActivation.guard_sha256",
    );
    expect(body).toContain(
      "source.source_activation_finalization?.finalization_receipt_sha256\n      !== expectedFinalization.receipt_sha256",
    );
    expect(body).toContain(
      "stage1EvidenceSchemaUpgradeFinalizationReceiptSha256(\n      source.source_activation_finalization?.receipt,\n    ) !== source.source_activation_finalization?.finalization_receipt_sha256",
    );
  });

  it("holds one selected source lock across reviewed authority, fresh dry-run capture, audit, and the sole commit", () => {
    const body = functionBody(
      "runStage1EvidenceSchemaUpgradeReviewedApplyMode",
      "function assertStage1EvidenceSchemaUpgradeReviewedApplyAuthorityRequest",
    );
    expect(body).toContain("withVisualBaselineLockAsync");
    expect(body).toContain("runStage1EvidenceSchemaUpgradeReviewedApplyExecution");
    expect(body).toContain("executionNonce = crypto.randomUUID()");
    expect(body).toContain("dryRun: true");
    expect(body).toContain("assertStage1EvidenceSchemaUpgradeReviewedApplyAuthority");
    expect(body).toContain("startStage1EvidenceSchemaUpgradeReviewedApplyAudit");
    expect(body).toContain("finishStage1EvidenceSchemaUpgradeReviewedApplyAudit");
    expect(body).toContain("operationInterfaces.upgradeEvidenceSchema");
    expect(body).toContain("report.worker_run_id = expectedAuditId");
    expect(body).toContain("receipt.observed_row_sha256 !== null");
    expect(body).toContain("receipt.active_execution_nonce !== null");
    expect(body).toContain('executionReport.execution_status === "recovery_required"');
    expect(body).toContain('? "recovery_required"');
    expect(body).toContain("report.execution_status = report.status");
    expect(body).not.toContain("startWorkerRun(");
    expect(body).not.toContain("finishWorkerRun(");
    expect(body).not.toContain("enqueueVisualReviewCandidate(");
    expect(body).not.toContain("quarantineEvidenceFailure(");
  });

  it("requires exact executor callback parity for capture, audit start, and commit before mutation", () => {
    const body = functionBody(
      "runStage1EvidenceSchemaUpgradeReviewedApplyMode",
      "function assertStage1EvidenceSchemaUpgradeReviewedApplyAuthorityRequest",
    );
    const captureStart = body.indexOf("const expectedCaptureRequest = {");
    const captureCompare = body.indexOf(
      "stableJsonStringify(expectedCaptureRequest)",
      captureStart,
    );
    const captureRun = body.indexOf(
      "await runStage1EvidenceSchemaUpgradeSource({",
      captureCompare,
    );
    const captureStore = body.indexOf("freshCaptureResult = captureResult", captureRun);
    expect(captureStart).toBeGreaterThan(-1);
    expect(captureCompare).toBeGreaterThan(captureStart);
    expect(captureRun).toBeGreaterThan(captureCompare);
    expect(captureStore).toBeGreaterThan(captureRun);
    for (const field of [
      "source,",
      "manifest: stage1EvidenceSchemaUpgradeManifest",
      "manifest_source: selected.source",
      "selected_source_id: source.id",
      "plan_sha256: checkedPlan.plan_sha256",
      "expected_active_journal_sha256: null",
      "authority: checkedPlan.authority",
    ]) {
      expect(body.slice(captureStart, captureCompare)).toContain(field);
    }

    const auditStart = body.indexOf("const expectedAuditStartRequest = {");
    const auditCall = body.indexOf(
      "await startStage1EvidenceSchemaUpgradeReviewedApplyAudit({",
      auditStart,
    );
    expect(auditStart).toBeGreaterThan(captureStore);
    expect(body.slice(auditStart, auditCall)).toContain(
      "stableJsonStringify(expectedAuditStartRequest)",
    );
    expect(body.slice(auditStart, auditCall)).toContain("captureResult: freshCaptureResult");
    expect(body.slice(auditStart, auditCall)).toContain(
      "authorityReceipt: postAuthorityReceipt",
    );
    expect(body.slice(auditStart, auditCall)).toContain("startedAt: preAuditPlanRevalidatedAt");
    expect(body.slice(auditStart, auditCall)).toContain(
      "stage1EvidenceSchemaUpgradeReviewedApplyFreshCaptureEvidence",
    );
    const auditReceiptCheck = body.indexOf("receipt.run_id !== expectedAuditId", auditCall);
    const authorizedReceiptCheck = body.indexOf(
      "receipt.business_execution_authorized",
      auditReceiptCheck,
    );
    const authorityReceiptDigestCheck = body.indexOf(
      "receipt.authority_receipt_sha256",
      auditReceiptCheck,
    );
    expect(authorityReceiptDigestCheck).toBeGreaterThan(authorizedReceiptCheck);
    expect(body).toContain(
      "buildStage1EvidenceSchemaUpgradeReviewedOperationBinding",
    );
    expect(body).toContain(
      "stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256",
    );
    const finalAuthorityReceipt = body.indexOf(
      "preCommitAuthorityReceipt = currentAuthorityReceipt",
    );
    const operationBinding = body.indexOf(
      "buildStage1EvidenceSchemaUpgradeReviewedOperationBinding",
      finalAuthorityReceipt,
    );
    expect(finalAuthorityReceipt).toBeGreaterThan(-1);
    expect(operationBinding).toBeGreaterThan(finalAuthorityReceipt);
    const commitCallback = body.indexOf("async commitUnchangedUpgrade(request)");
    expect(body.slice(operationBinding, commitCallback)).toContain(
      "precommitAuthorityReceiptSha256:",
    );
    expect(body.slice(operationBinding, commitCallback)).toContain(
      "precommitSourceAuthority:",
    );
    expect(body.slice(finalAuthorityReceipt, operationBinding)).toContain(
      "if (!authorizedAuditStartReceipt)",
    );
    expect(body.slice(auditCall, body.indexOf("async commitUnchangedUpgrade(request)")))
      .toContain("authorizedAuditStartReceipt = auditExecutionAuthorized ? receipt : null");

    const commitAssert = body.indexOf(
      "assertStage1EvidenceSchemaUpgradeReviewedApplyCommitRequest({",
      commitCallback,
    );
    const mutation = body.indexOf("operationInterfaces.upgradeEvidenceSchema({", commitAssert);
    expect(commitAssert).toBeGreaterThan(commitCallback);
    expect(mutation).toBeGreaterThan(commitAssert);
    expect(body.slice(commitAssert, mutation)).toContain("expectedTransactionId");
    expect(body.slice(commitAssert, mutation)).toContain("freshCaptureResult");
    expect(body.slice(commitAssert, mutation)).toContain("reviewedOperationBinding");
    expect(body.slice(mutation)).toContain(
      "operation_binding: request.operation_binding",
    );
  });

  it("rechecks exact capture-bound authority after audit authorization and before commit", () => {
    const body = functionBody(
      "runStage1EvidenceSchemaUpgradeReviewedApplyMode",
      "function assertStage1EvidenceSchemaUpgradeReviewedApplyAuthorityRequest",
    );
    const finalPhase = body.indexOf('phase === "pre_commit"');
    const exactReload = body.indexOf(
      "await loadExactStage1EvidenceSchemaUpgradeSources()",
      finalPhase,
    );
    const finalReceipt = body.indexOf(
      "preCommitAuthorityReceipt = currentAuthorityReceipt",
      exactReload,
    );
    const commit = body.indexOf("async commitUnchangedUpgrade(request)", finalReceipt);
    expect(finalPhase).toBeGreaterThan(-1);
    expect(exactReload).toBeGreaterThan(finalPhase);
    expect(finalReceipt).toBeGreaterThan(exactReload);
    expect(commit).toBeGreaterThan(finalReceipt);
    expect(body.slice(finalPhase, exactReload)).toContain("auditExecutionAuthorized");
    expect(body.slice(finalPhase, exactReload)).toContain("postAuditPlanRevalidated");
    expect(body.slice(exactReload, finalReceipt)).toContain("preAuthorityReceipt");
    expect(body.slice(exactReload, finalReceipt)).toContain("postAuthorityReceipt");
    expect(body.slice(commit, body.length)).toContain("!preCommitAuthorityReceipt");
  });

  it("uses exact key-and-value equality for capture-bound authority and the full commit request", () => {
    const authority = functionBody(
      "assertStage1EvidenceSchemaUpgradeReviewedApplyAuthorityRequest",
      "function assertStage1EvidenceSchemaUpgradeReviewedApplyCommitRequest",
    );
    const commit = functionBody(
      "assertStage1EvidenceSchemaUpgradeReviewedApplyCommitRequest",
      "async function loadExactStage1EvidenceSchemaUpgradeSources",
    );
    expect(authority).toContain('["pre_capture", "post_capture", "pre_commit"]');
    expect(authority).toContain("capture_result: captureResult");
    expect(authority).toContain("capture_validation: captureResult.capture_validation");
    expect(authority).toContain(
      "stableJsonStringify(request) !== stableJsonStringify(expected)",
    );
    expect(authority).not.toContain("delete comparable");

    for (const field of [
      "source,",
      "manifest_source: selected.source",
      "audit_id: expectedAuditId",
      "execution_nonce: executionNonce",
      "reviewed_report_attempt_id: checkedPlan.report_binding.attempt_id",
      "transaction_id: expectedTransactionId",
      "operation_binding: reviewedOperationBinding",
      "capture_result: freshCaptureResult",
      "capture_validation: freshCaptureResult?.capture_validation",
      "expected_old_baseline: selected.local_baseline_identity",
      "expected_old_pointer_identity: selected.existing_pointer_identity",
      "expected_authoritative_r2_binding: selected.r2",
      "authority: checkedPlan.authority",
      "creates_api_charge: false",
    ]) {
      expect(commit).toContain(field);
    }
    expect(commit).toContain(
      "stableJsonStringify(request) !== stableJsonStringify(expected)",
    );
  });

  it("uses one plain audit insert and one fully guarded terminal update", () => {
    const insert = functionBody(
      "insertStage1EvidenceSchemaUpgradeReviewedApplyAuditRun",
      "async function readStage1EvidenceSchemaUpgradeReviewedApplyAuditRun",
    );
    const read = functionBody(
      "readStage1EvidenceSchemaUpgradeReviewedApplyAuditRun",
      "async function updateStage1EvidenceSchemaUpgradeReviewedApplyAuditRun",
    );
    const update = functionBody(
      "updateStage1EvidenceSchemaUpgradeReviewedApplyAuditRun",
      "async function maybeUpdateBaselineCoverageProgress",
    );
    expect(insert).toContain('.from("local_worker_runs")');
    expect(insert).toContain(".insert(row)");
    expect(insert).not.toContain("upsert");
    expect(insert).toContain("stage1EvidenceSchemaUpgradeReviewedApplyAuditProjection");
    expect(read).toContain('.eq("id", runId)');
    expect(update).toContain(".update(patch)");
    expect(update).toContain('.eq("id", guard.id)');
    expect(update).toContain('.eq("worker_name", guard.worker_name)');
    expect(update).toContain('.eq("status", guard.status)');
    expect(update).toContain('.contains("metadata"');
    expect(update).toContain("execution_nonce: guard.execution_nonce");
    expect(update).toContain("metadata_sha256: guard.running_metadata_sha256");
    expect(update).toContain("file_sha256: guard.plan_file_sha256");
    expect(update).toContain("self_sha256: guard.plan_sha256");
    expect(update).not.toContain("markSupersededVisualWorkerRuns");
  });

  it("attaches one exact service-role finalization receipt per reviewed source", () => {
    const body = functionBody(
      "attachStage1SourceActivationFinalizations",
      "async function loadSourcesByIds",
    );
    expect(body).toContain('"get_stage1_source_activation_finalizations"');
    expect(body).toContain("p_source_ids: sourceIds");
    expect(body).toContain("rows.length !== sourceIds.length");
    expect(body).toContain("row?.shared_award_source_id !== sourceIds[index]");
    expect(body).toContain("source_activation_finalization: rows[index]");
  });

  it("wires active-journal and completed-authority preflights before capture and every mutation adapter", () => {
    const body = functionBody(
      "stage1EvidenceSchemaUpgradeOperationInterfaces",
      "async function processLocalizationRepairSource",
    );
    const preflight = body.indexOf("async preflightActiveJournal");
    const completed = body.indexOf("async preflightCompletedAuthority");
    const capture = body.indexOf("async captureAndValidate");
    expect(preflight).toBeGreaterThan(-1);
    expect(completed).toBeGreaterThan(preflight);
    expect(completed).toBeLessThan(capture);
    expect(preflight).toBeLessThan(capture);
    expect(body.slice(preflight, completed)).toContain(
      'status: "dry_run_recovery_required"',
    );
    expect(body.slice(preflight, completed)).toContain(
      "runStage1EvidenceSchemaUpgradeCommit",
    );
    expect(body.match(/transactionId: activeJournal\.transaction_id/g)).toHaveLength(2);
    expect(body.match(/expectedActiveJournalSha256: activeJournal\.journal_sha256/g))
      .toHaveLength(2);
    expect(body.match(/operationBinding: null/g)).toHaveLength(2);
    expect(body).toContain("async captureAndValidate");
    expect(body).toContain("pendingMutationFailure: null");
    expect(body).toContain("verifyStage1EvidenceSchemaUpgradeR2Binding");
    expect(body).toContain("evaluateStage1EvidenceSchemaUpgradeCapture");
    expect(body).toContain('JSON.parse(state.baselineBytes.toString("utf8"))');
    expect(body).not.toContain("state.baseline = readJsonIfExists(baselinePath)");
    expect(body).toContain("local_baseline_identity:");
    expect(body).toContain("existing_pointer_identity:");
    expect(body).toContain(
      "stage1EvidenceSchemaUpgradeLocalBaselineIdentity(state.baselineBytes)",
    );
    expect(body).toContain("settleAfterTimeout: true");
    expect(body).toContain("sourceDeadline?.expired()");
    expect(body).toContain("async upgradeEvidenceSchema");
    expect(body).toContain("runStage1EvidenceSchemaUpgradeCommit");
    expect(body).toContain("expectedOldBaseline:");
    expect(body).toContain(
      "captureValidation?.evidence?.local_baseline_identity",
    );
    expect(body).toContain("expectedOldPointerIdentity:");
    expect(body).toContain(
      "stage1EvidenceSchemaUpgradeReviewedApplyAuthority\n          && requestedTransactionId",
    );
    expect(body).toContain(
      "captureValidation?.evidence?.existing_pointer_identity",
    );
    expect(body).toContain('if (result.status === "abandoned_old_authority")');
    expect(body).toContain("operation_binding: reviewedOperationBinding = null");
    expect(body).toContain("operationBinding: reviewedOperationBinding");
    expect(body).toContain("buildLatestOnlyVisualSnapshotPointerReplacement");
    expect(body).toContain("async enqueueVisualReviewCandidate");
    expect(body).toContain("stage1EvidenceSchemaUpgradeBeforeCandidateEnqueueError");
    expect(body).toContain("candidate.candidate_inserted === true");
    expect(body).toContain("candidate.observation_inserted === true");
    expect(body).toContain('code: "stage1_existing_candidate_not_actionable"');
    expect(body).toContain('"pending",');
    expect(body).toContain('"published",');
    expect(body).toContain("candidate_inserted: candidateInserted");
    expect(body).toContain("observation_inserted: observationInserted");
    expect(body).toContain("async quarantineEvidenceFailure");
    expect(body).toContain("mutation_failure: mutationFailure = null");
    expect(body).toContain("mutationFailure || state.pendingMutationFailure");
    expect(body).not.toMatch(
      /state\.recoveryReceipt = recovery\.receipt;\s*state\.activeJournal = loadStage1EvidenceSchemaUpgradeActiveJournal/u,
    );
    expect(body).not.toMatch(
      /state\.recoveryReceipt = result\.receipt \|\| null;\s*state\.activeJournal = loadStage1EvidenceSchemaUpgradeActiveJournal/u,
    );
    expect(body).toContain("persistStage1EvidenceSchemaUpgradeQuarantine");
    expect(body).not.toContain("baselineRefresh = true");
  });

  it("proves completed authority from exact current bytes, terminal audit, and archived journal without capture or mutation", () => {
    const body = functionBody(
      "stage1EvidenceSchemaUpgradeOperationInterfaces",
      "async function processLocalizationRepairSource",
    );
    const start = body.indexOf("async preflightCompletedAuthority");
    const end = body.indexOf("async captureAndValidate", start);
    const preflight = body.slice(start, end);

    expect(preflight).toContain('Buffer.from("stage1_evidence_schema_upgrade"');
    expect(preflight).toContain("loadStage1EvidenceSchemaUpgradeActiveJournal");
    expect(preflight).toContain("prepareStage1EvidenceSchemaUpgradeCaptureArtifacts");
    expect(preflight).toContain("loadStage1EvidenceSchemaUpgradeR2Artifacts");
    expect(preflight).toContain("verifyStage1EvidenceSchemaUpgradeR2Binding");
    expect(preflight).toContain("loadExactStage1EvidenceSchemaUpgradeSources");
    expect(preflight).toContain(
      "STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_HEALTH_AUTHORITY_COLUMNS",
    );
    expect(preflight).toContain("sourceHealth: currentSourceHealth");
    expect(preflight).not.toContain("sourceHealth: currentSource,");
    expect(preflight).toContain(
      "inspectStage1EvidenceSchemaUpgradeCompletedAuthorityAuditRow",
    );
    expect(preflight).toContain(
      "stage1EvidenceSchemaUpgradeReviewedApplyTransactionId",
    );
    expect(preflight).toContain("stage1EvidenceSchemaUpgradeJournalPaths");
    expect(preflight).toContain("assertStage1EvidenceSchemaUpgradeJournal");
    expect(preflight).toContain("proveStage1EvidenceSchemaUpgradeArchivedCompletion");
    expect(preflight).toContain("evaluateStage1EvidenceSchemaUpgradeCompletedAuthority");
    expect(preflight).toContain("assertStage1EvidenceSchemaUpgradeCompletedAuthorityReceipt");
    expect(preflight).toContain("const finalActiveJournal =");
    expect(preflight).toContain("const finalPointer = await loadR2SnapshotRecord");
    expect(preflight).toContain("const finalSources = await loadExactStage1EvidenceSchemaUpgradeSources");
    expect(preflight).toContain("const finalBaselineBytes = existsSync(finalBaselinePath)");
    expect(preflight).toContain("finalBaselineBytes.equals(baselineBytes)");
    expect(preflight).toContain("const finalCompletedJournal =");
    expect(preflight).toContain("const finalAuditRow =");
    expect(preflight).toContain("completed_authority_changed_during_preflight");
    expect(preflight).toContain('decision: "already_upgraded_verified"');
    expect(preflight).toContain('decision: "completed_authority_invalid"');
    expect(preflight.match(/would_(?:commit|queue_visual_candidate|quarantine): false/g))
      .toHaveLength(6);
    expect(preflight).toContain("report.checked += 1");
    expect(preflight).not.toContain("captureIntakePage(");
    expect(preflight).not.toContain("captureSource(");
    expect(preflight).not.toContain("capturePdfSourceForBaseline(");
    expect(preflight).not.toContain("runStage1EvidenceSchemaUpgradeCommit(");
    expect(preflight).not.toContain("enqueueVisualReviewCandidate(");
    expect(preflight).not.toContain("persistStage1EvidenceSchemaUpgradeQuarantine(");
    expect(preflight).not.toContain("PutObjectCommand");
  });

  it("uses the dedicated evidence-bound quarantine RPC and removes the compatibility path", () => {
    const quarantine = functionBody(
      "persistStage1EvidenceSchemaUpgradeQuarantine",
      "function stage1EvidenceSchemaUpgradeObservedJournal",
    );
    expect(worker).toContain("buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs");
    expect(worker).toContain("prepareStage1EvidenceSchemaUpgradeQuarantineValidation");
    expect(worker).toContain("stage1EvidenceSchemaUpgradeQuarantineSafeAction");
    expect(worker).toContain("stage1EvidenceSchemaUpgradeQuarantineReceipt");
    expect(quarantine).toContain(
      "const quarantineValidation = prepareStage1EvidenceSchemaUpgradeQuarantineValidation",
    );
    expect(quarantine.match(/cleanOptionalStage1EvidenceSchemaUpgradeReason/g)).toHaveLength(2);
    expect(quarantine).toContain(
      'mutationOperation\n    || (activeJournal ? "journal_recovery" : "capture_validation")',
    );
    expect(quarantine).toContain(
      '? `${mutationOperation}_mutation_failed`',
    );
    expect(quarantine).toContain("mutationErrorCode || reasonCode");
    expect(quarantine).toContain(
      "if (mutationFailure && !mutationOperation)",
    );
    expect(quarantine).toContain("validation: quarantineValidation");
    expect(quarantine).toContain("mutation_accounting: mutationFailure.mutation_accounting");
    expect(quarantine).toContain('journalObservation.status === "unavailable"');
    expect(quarantine).toContain('journalObservation.status === "absent"');
    expect(quarantine).toContain("commitRecovery,");
    expect(quarantine).toContain(
      "mutationError?.stage1EvidenceSchemaUpgradeRecovery || null",
    );
    const fallbackAction = quarantine.indexOf("const fallbackSafeAction =");
    const unavailableAction = quarantine.indexOf(
      'journalObservation.status === "unavailable"',
      fallbackAction,
    );
    const activeAction = quarantine.indexOf(": activeJournal", unavailableAction);
    const candidateAction = quarantine.indexOf(": candidateArtifacts", activeAction);
    expect(fallbackAction).toBeGreaterThan(-1);
    expect(unavailableAction).toBeGreaterThan(fallbackAction);
    expect(activeAction).toBeGreaterThan(unavailableAction);
    expect(candidateAction).toBeGreaterThan(activeAction);
    expect(quarantine.indexOf(
      "stage1EvidenceSchemaUpgradeQuarantineSafeAction",
      candidateAction,
    )).toBeGreaterThan(candidateAction);
    expect(quarantine).toContain(
      "reconcile any active journal before any new capture or retry",
    );
    expect(quarantine).toContain("candidateAccountingEvidence.candidate_signature");
    expect(quarantine).toContain(
      "Reconcile the exact visual-review candidate signature",
    );
    expect(quarantine).toContain(
      "do not enqueue a duplicate while write outcome is unknown",
    );
    expect(quarantine).toContain(
      "Verify current pointer, baseline, source-health, and archived transaction/journal state",
    );
    expect(quarantine).toContain("r2Binding: state.r2BindingReceipt");
    expect(quarantine).toContain("candidateArtifacts,");
    expect(worker).toContain(
      "reconcile this exact freshly verified journal before retrying",
    );
    expect(worker).toContain('boundary: "before_candidate_enqueue"');
    expect(worker).toContain("candidate_signature: null");
    expect(worker).toContain("response_loss_possible: false");
    expect(worker).toContain('"quarantine_stage1_evidence_schema_upgrade_failure"');
    expect(worker).not.toContain("persistStage1EvidenceSchemaUpgradeCompatibilityQuarantine");
    expect(worker).not.toContain("stage1-baseline-activation-failure-rpc");
  });

  it("preserves absent mutation operation and error codes instead of manufacturing a default reason", () => {
    const cleaner = functionBody(
      "cleanOptionalStage1EvidenceSchemaUpgradeReason",
      "function stage1EvidenceSchemaUpgradeProvenance",
    );
    expect(cleaner).toContain("cleanText(value)");
    expect(cleaner).toContain("? cleanStage1EvidenceSchemaUpgradeReason(value)");
    expect(cleaner).toContain(": null");
  });

  it("rereads the sealed active journal at the quarantine boundary instead of trusting cached state", () => {
    const quarantine = functionBody(
      "persistStage1EvidenceSchemaUpgradeQuarantine",
      "function stage1EvidenceSchemaUpgradeObservedJournal",
    );
    const observation = functionBody(
      "stage1EvidenceSchemaUpgradeObservedJournal",
      "function stage1EvidenceSchemaUpgradeRecoveryEvidence",
    );
    expect(quarantine).toContain(
      "const journalObservation = stage1EvidenceSchemaUpgradeObservedJournal(source.id, state)",
    );
    expect(quarantine).toContain("const activeJournal = journalObservation.journal");
    expect(observation).toContain("loadStage1EvidenceSchemaUpgradeActiveJournal(sourceId)");
    expect(observation).not.toContain("if (state.activeJournal) return state.activeJournal");
    expect(observation).toContain('status: journal ? "verified" : "absent"');
    expect(observation).toContain('status: "unavailable"');
    expect(observation).toContain("state.activeJournal = null");
  });

  it("counts only confirmed candidate and observation inserts in Stage 1 receipts", () => {
    const enqueue = functionBody(
      "enqueueVisualReviewCandidate",
      "async function recordVisualReviewCandidateRunObservation",
    );
    const observation = functionBody(
      "recordVisualReviewCandidateRunObservation",
      "async function queueAwardReconciliationFromSource",
    );
    expect(enqueue).toContain("candidate_inserted: true");
    expect(enqueue).toContain("candidate_inserted: false");
    expect(enqueue).toContain("observation_inserted: observation.inserted");
    expect(observation).toContain('.select("candidate_id")');
    expect(observation).toContain('status: data?.candidate_id ? "inserted" : "existing"');
    expect(observation).toContain("inserted: Boolean(data?.candidate_id)");
  });

  it("binds immutable candidate uploads to the exact bucket preserved by the authoritative pointer", () => {
    const operation = functionBody(
      "stage1EvidenceSchemaUpgradeOperationInterfaces",
      "function stage1EvidenceSchemaUpgradeFailureValidation",
    );
    const adapter = functionBody(
      "stage1EvidenceSchemaUpgradeCommitInterfaces",
      "async function persistStage1EvidenceSchemaUpgradeQuarantine",
    );
    const upload = functionBody(
      "uploadStage1EvidenceSchemaUpgradeImmutableObject",
      "function isR2PreconditionFailed",
    );
    const uploadAdapterStart = adapter.indexOf("async uploadImmutableCandidateArtifact");
    const uploadAdapterEnd = adapter.indexOf("async compareAndSwapLatestPointer", uploadAdapterStart);
    const uploadAdapter = adapter.slice(uploadAdapterStart, uploadAdapterEnd);
    expect(operation).toContain("state.r2Pointer?.bucket !== r2Bucket");
    expect(uploadAdapter).toContain("bucket !== r2Bucket");
    expect(uploadAdapter).not.toContain("state.r2Pointer");
    expect(adapter).toContain("bucket,\n        key: objectKey");
    expect(adapter).toContain("immutable: true,\n        bucket,");
    expect(upload.match(/Bucket: bucket/g)).toHaveLength(2);
    expect(upload).not.toContain("Bucket: r2Bucket");
  });

  it("keeps the upload adapter usable before fresh-flow pointer state exists during journal recovery", () => {
    const operation = functionBody(
      "stage1EvidenceSchemaUpgradeOperationInterfaces",
      "function stage1EvidenceSchemaUpgradeFailureValidation",
    );
    const adapter = functionBody(
      "stage1EvidenceSchemaUpgradeCommitInterfaces",
      "async function persistStage1EvidenceSchemaUpgradeQuarantine",
    );
    const recovery = operation.indexOf("runStage1EvidenceSchemaUpgradeCommit({");
    const freshPointerLoad = operation.indexOf("state.r2Pointer = await loadR2SnapshotRecord");
    const uploadStart = adapter.indexOf("async uploadImmutableCandidateArtifact");
    const uploadEnd = adapter.indexOf("async compareAndSwapLatestPointer", uploadStart);
    const uploadAdapter = adapter.slice(uploadStart, uploadEnd);
    expect(recovery).toBeGreaterThan(-1);
    expect(recovery).toBeLessThan(freshPointerLoad);
    expect(uploadAdapter).toContain("bucket !== r2Bucket");
    expect(uploadAdapter).not.toContain("state.r2Pointer");
  });

  it("reconciles candidate authority under an existing review_later hold without clearing it", () => {
    const adapter = functionBody(
      "stage1EvidenceSchemaUpgradeCommitInterfaces",
      "async function persistStage1EvidenceSchemaUpgradeQuarantine",
    );
    const sourceHealth = adapter.slice(adapter.indexOf("async markSourceHealthSucceeded"));
    const sharedSuccess = functionBody(
      "markSharedSourceVisualCheckSucceeded",
      "async function markSharedSourceReviewLater",
    );
    expect(sourceHealth).toContain(
      'source.admin_review_status === "review_later" ? "review_later" : "open"',
    );
    expect(sourceHealth).toContain("requiredAdminReviewStatus:");
    expect(sourceHealth).toContain("requiredSourceAuthority: source");
    expect(sharedSuccess).toContain('requiredAdminReviewStatus = "open"');
    expect(sharedSuccess).toContain("requiredStatus: requiredAdminReviewStatus");
    expect(sharedSuccess).not.toContain("admin_review_status:");
  });

  it("CAS-binds the Stage 1 source-health update to the exact source row used for authority", () => {
    const sourceHealth = functionBody(
      "markSharedSourceVisualCheckSucceeded",
      "function guardStage1EvidenceSchemaUpgradeSourceAuthorityMutation",
    );
    const authorityGuard = functionBody(
      "guardStage1EvidenceSchemaUpgradeSourceAuthorityMutation",
      "async function markSharedSourceReviewLater",
    );
    const sourceQuery = functionBody(
      "buildSourcesQuery",
      "function buildAuthoritativeSourceInventoryQuery",
    );
    const adminGuard = sourceHealth.indexOf("guardAdminReviewMutation");
    const exactSourceGuard = sourceHealth.indexOf(
      "guardStage1EvidenceSchemaUpgradeSourceAuthorityMutation",
    );
    const update = sourceHealth.indexOf('.select("id").maybeSingle()');
    expect(adminGuard).toBeGreaterThan(-1);
    expect(exactSourceGuard).toBeGreaterThan(adminGuard);
    expect(update).toBeGreaterThan(exactSourceGuard);
    expect(sourceHealth).toContain("requiredSourceAuthority = null");
    expect(sourceHealth).toContain("if (requiredSourceAuthority)");
    for (const column of [
      "updated_at",
      "shared_award_id",
      "url",
      "title",
      "display_title",
      "page_type",
      "source",
      "reason",
      "submitted_by_user_id",
      "created_at",
    ]) {
      expect(authorityGuard).toContain(`"${column}"`);
    }
    expect(authorityGuard).toContain("guarded.is(column, null)");
    expect(authorityGuard).toContain("guarded.eq(column, value)");
    expect(sourceQuery).toContain("created_at, updated_at, shared_awards!inner");
    expect(sourceQuery).toContain("last_hash, last_checked_at");
  });

  it("reconciles a response-lost source-health CAS only from an exact already-current readback", () => {
    const adapter = functionBody(
      "stage1EvidenceSchemaUpgradeCommitInterfaces",
      "async function persistStage1EvidenceSchemaUpgradeQuarantine",
    );
    const sharedSuccess = functionBody(
      "markSharedSourceVisualCheckSucceeded",
      "async function readStage1EvidenceSchemaUpgradeSourceHealth",
    );
    const readback = functionBody(
      "readStage1EvidenceSchemaUpgradeSourceHealth",
      "function stage1EvidenceSchemaUpgradeSourceHealthIdentityProjection",
    );
    const projectionAndProof = functionBody(
      "stage1EvidenceSchemaUpgradeSourceHealthIdentityProjection",
      "function guardStage1EvidenceSchemaUpgradeSourceAuthorityMutation",
    );

    expect(sharedSuccess).toContain("if (requiredSourceAuthority)");
    expect(sharedSuccess).toContain(
      "await readStage1EvidenceSchemaUpgradeSourceHealth(source.id)",
    );
    expect(sharedSuccess).toContain(
      "isStage1EvidenceSchemaUpgradeSourceHealthAlreadyCurrent",
    );
    expect(sharedSuccess).toContain('status: data ? "succeeded" : "already_current"');
    expect(sharedSuccess.indexOf("readStage1EvidenceSchemaUpgradeSourceHealth"))
      .toBeLessThan(sharedSuccess.indexOf("recordStaleAdminReviewPlan"));
    expect(sharedSuccess.indexOf('.select("id").maybeSingle()'))
      .toBeLessThan(sharedSuccess.indexOf("readStage1EvidenceSchemaUpgradeSourceHealth"));
    expect(readback).toContain('.from("shared_award_sources")');
    expect(readback).toContain("stage1EvidenceSchemaUpgradeSourceHealthReadbackColumns");
    expect(readback).toContain('.eq("id", sourceId)');
    expect(readback).toContain(".maybeSingle()");

    for (const column of [
      "page_description",
      "page_metadata",
      "page_metadata_generated_at",
      "page_metadata_model",
      "admin_review_status",
      "admin_review_note",
      "admin_reviewed_at",
      "admin_reviewed_by",
      "shared_awards",
    ]) {
      expect(worker).toContain(`"${column}"`);
    }
    expect(projectionAndProof).toContain("currentSource.last_hash === expectedLastHash");
    expect(projectionAndProof).toContain("currentSource.consecutive_failures === 0");
    expect(projectionAndProof).toContain("currentSource.last_error === null");
    expect(projectionAndProof).toContain("updatedMs === lastCheckedMs");
    expect(projectionAndProof).toContain("lastCheckedMs >= minimumCheckedMs");
    expect(projectionAndProof).toContain("nextCheckMs > lastCheckedMs");

    expect(adapter).toContain('sourceHealthStatus === "already_current" ? 0 : 1');
    expect(adapter).toContain("database_writes: sourceHealthWrites");
    expect(adapter).toContain("source_state_writes: sourceHealthWrites");
  });

  it("accepts only candidate-healthy readback state with unchanged reviewed source authority", () => {
    const proofStart = worker.indexOf(
      "const stage1EvidenceSchemaUpgradeSourceHealthIdentityColumns",
    );
    const proofEnd = worker.indexOf(
      "function guardStage1EvidenceSchemaUpgradeSourceAuthorityMutation",
      proofStart,
    );
    const proof = new Function(
      "stableJsonStringify",
      `${worker.slice(proofStart, proofEnd)}\n` +
        "return isStage1EvidenceSchemaUpgradeSourceHealthAlreadyCurrent;",
    )((value) => JSON.stringify(value));
    const requiredSourceAuthority = {
      id: "11111111-1111-4111-8111-111111111111",
      shared_award_id: "22222222-2222-4222-8222-222222222222",
      url: "https://example.test/source",
      title: "Source",
      display_title: "Reviewed source",
      page_description: "Description",
      page_metadata: { language: "en" },
      page_metadata_generated_at: "2026-08-14T00:00:00.000Z",
      page_metadata_model: "deterministic",
      page_type: "html",
      source: "official",
      reason: "reviewed",
      submitted_by_user_id: null,
      admin_review_status: "review_later",
      admin_review_note: "hold",
      admin_reviewed_at: "2026-08-14T00:00:00.000Z",
      admin_reviewed_by: "operator",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-14T00:00:00.000Z",
      shared_awards: {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Award",
        status: "active",
        official_homepage: "https://example.test",
      },
    };
    const currentSource = {
      ...structuredClone(requiredSourceAuthority),
      last_hash: "candidate-hash",
      last_checked_at: "2026-08-15T02:00:00+00:00",
      next_check_at: "2026-08-16T02:00:00.000Z",
      consecutive_failures: 0,
      last_error: null,
      updated_at: "2026-08-15T02:00:00.000Z",
    };
    const input = {
      currentSource,
      requiredSourceAuthority,
      expectedLastHash: "candidate-hash",
      minimumCheckedAt: "2026-08-15T01:59:59.000Z",
    };

    expect(proof(input)).toBe(true);
    expect(proof({
      ...input,
      currentSource: { ...currentSource, admin_review_note: "concurrent edit" },
    })).toBe(false);
    expect(proof({
      ...input,
      currentSource: { ...currentSource, page_metadata: { language: "fr" } },
    })).toBe(false);
    expect(proof({
      ...input,
      currentSource: {
        ...currentSource,
        shared_awards: { ...currentSource.shared_awards, status: "inactive" },
      },
    })).toBe(false);
    expect(proof({ ...input, expectedLastHash: "other-hash" })).toBe(false);
    expect(proof({
      ...input,
      currentSource: { ...currentSource, consecutive_failures: 1 },
    })).toBe(false);
    expect(proof({
      ...input,
      currentSource: { ...currentSource, last_error: "failure" },
    })).toBe(false);
    expect(proof({
      ...input,
      currentSource: { ...currentSource, next_check_at: currentSource.last_checked_at },
    })).toBe(false);
    expect(proof({
      ...input,
      minimumCheckedAt: "2026-08-15T02:00:00.001Z",
    })).toBe(false);
  });

  it("validates raw Stage 1 CLI flags before checking derived effective values", () => {
    const start = worker.indexOf(
      "const stage1EvidenceSchemaUpgradeSelectorContract = stage1EvidenceSchemaUpgrade",
    );
    const end = worker.indexOf("if (!supabaseUrl || !serviceRoleKey)", start);
    const contract = worker.slice(start, end);
    expect(contract).toContain("assertStage1EvidenceSchemaUpgradeCliContract({");
    expect(contract).toContain("args,\n      effectiveArgs: {");
    expect(contract).toContain("all: includeNotDue");
    expect(contract).toContain("promote,");
    expect(contract).toContain('"extract-baseline-info": extractBaselineInfo');
    expect(contract.indexOf("args,")).toBeLessThan(contract.indexOf("effectiveArgs: {"));
  });

  it("documents both CLI flags and the exact quarantine boundary", () => {
    expect(worker).toContain('"  --stage1-evidence-schema-upgrade=true"');
    expect(worker).toContain('"  --stage1-evidence-schema-upgrade-dry-run=true"');
    expect(worker).toContain('"  --capture-profile=baseline-rich"');
    expect(worker).toContain('"  --source-quality-mode=deterministic"');
    expect(worker).toContain("Churchill and Luce remain quarantined");
    expect(worker).toContain("loadStage1EvidenceSchemaUpgradeManifest(sourceIdsFile)");
  });
});
