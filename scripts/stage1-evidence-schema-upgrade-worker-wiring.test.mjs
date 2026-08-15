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

  it("skips worker-run writes only in dry-run and creates a durable run for apply", () => {
    const body = functionBody("runOnce", "async function runStage1EvidenceSchemaUpgradeMode");
    const isolated = body.indexOf("if (stage1EvidenceSchemaUpgrade)");
    const branchStart = body.indexOf("workerRunId = await startWorkerRun(report)", isolated + 1);
    const ordinaryStart = body.indexOf(
      "workerRunId = await startWorkerRun(report)",
      branchStart + 1,
    );
    const branch = body.slice(isolated, ordinaryStart);
    expect(branch).toContain("if (!stage1EvidenceSchemaUpgradeDryRun)");
    expect(branch).toContain("workerRunId = await startWorkerRun(report)");
    expect(branch).toContain("if (!workerRunId)");
    expect(branch).toContain("apply requires a durable local_worker_runs identity");
    expect(branch).toContain("report.worker_run_id = workerRunId");
    expect(branch).toContain("await finishWorkerRun(");
    expect(branch).toContain("return;");
  });

  it("handles isolated exceptions locally without generic source-health mutations", () => {
    const body = functionBody(
      "runStage1EvidenceSchemaUpgradeMode",
      "async function maybeWriteNightlyVisualReport",
    );
    expect(body).toContain("buildStage1EvidenceSchemaUpgradeFailureResult");
    expect(body).not.toContain("recordBrokenSourceFailure");
    expect(body).not.toContain("markSharedSourceVisualCheckFailed");
    expect(body).not.toContain("observeVisualReviewCandidateRun");
    expect(body).not.toContain("enqueueVisualReviewCandidate(");
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

  it("wires active-journal preflight before the isolated capture, commit, candidate, and quarantine adapters", () => {
    const body = functionBody(
      "stage1EvidenceSchemaUpgradeOperationInterfaces",
      "async function processLocalizationRepairSource",
    );
    const preflight = body.indexOf("async preflightActiveJournal");
    const capture = body.indexOf("async captureAndValidate");
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(capture);
    expect(body.slice(preflight, capture)).toContain(
      'status: "dry_run_recovery_required"',
    );
    expect(body.slice(preflight, capture)).toContain(
      "runStage1EvidenceSchemaUpgradeCommit",
    );
    expect(body).toContain("async captureAndValidate");
    expect(body).toContain("pendingMutationFailure: null");
    expect(body).toContain("verifyStage1EvidenceSchemaUpgradeR2Binding");
    expect(body).toContain("evaluateStage1EvidenceSchemaUpgradeCapture");
    expect(body).toContain("settleAfterTimeout: true");
    expect(body).toContain("sourceDeadline?.expired()");
    expect(body).toContain("async upgradeEvidenceSchema");
    expect(body).toContain("runStage1EvidenceSchemaUpgradeCommit");
    expect(body).toContain('if (result.status === "abandoned_old_authority")');
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
    expect(sharedSuccess).toContain('requiredAdminReviewStatus = "open"');
    expect(sharedSuccess).toContain("requiredStatus: requiredAdminReviewStatus");
    expect(sharedSuccess).not.toContain("admin_review_status:");
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
