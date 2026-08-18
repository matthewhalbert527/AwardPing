import { createHash } from "node:crypto";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
} from "./stage1-evidence-schema-upgrade-commit.mjs";
import {
  assertStage1EvidenceSchemaUpgradeMutationAccounting,
  zeroStage1EvidenceSchemaUpgradeMutationCounts,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_FRESH_VALIDATION_PROJECTION_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY,
  stage1EvidenceSchemaUpgradeFreshValidationSha256,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REPORT_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
} from "./stage1-evidence-schema-upgrade.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_PRECOMMIT_SOURCE_AUTHORITY_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_PRECOMMIT_SOURCE_AUTHORITY_PROJECTION_KEYS,
  assertStage1EvidenceSchemaUpgradePrecommitSourceAuthority,
  buildStage1EvidenceSchemaUpgradePrecommitSourceAuthority,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME =
  "local-stage1-evidence-schema-upgrade-reviewed-exact-one-apply-audit";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_MODE =
  "dedicated_exact_one_insert_one_terminal_update";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_METADATA_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-apply-audit-metadata.v4";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_FRESH_CAPTURE_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-apply-audit-fresh-capture.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_TERMINAL_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-apply-audit-terminal.v2";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_COMPLETION_AUTHORITY_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-apply-audit-completion-authority.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RESULT_IDENTITY_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-apply-result-commit-identity.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_ACCOUNTING_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-apply-audit-accounting.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RECEIPT_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-apply-audit-receipt.v4";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RECOVERY_INSPECTION_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-apply-audit-recovery-inspection.v4";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMPLETED_AUTHORITY_AUDIT_INSPECTION_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-completed-authority-audit-inspection.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_SOURCE_AUTHORITY_SCHEMA =
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_PRECOMMIT_SOURCE_AUTHORITY_SCHEMA;

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUTHORITY_RECEIPT_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-apply-authority-receipt.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_ROW_COLUMNS =
  Object.freeze([
    "ai_provider",
    "changed_count",
    "checked_count",
    "discovered_count",
    "error",
    "failed_count",
    "finished_at",
    "id",
    "initial_count",
    "metadata",
    "started_at",
    "status",
    "unchanged_count",
    "worker_name",
  ]);

const metadataKeys = Object.freeze([
  "audit_mode",
  "authority",
  "authority_receipt",
  "authority_receipt_sha256",
  "binding",
  "execution_nonce",
  "fresh_capture",
  "kind",
  "metadata_sha256",
  "phase",
  "schema_version",
  "started_at",
  "terminal",
]);

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_SOURCE_AUTHORITY_PROJECTION_KEYS =
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_PRECOMMIT_SOURCE_AUTHORITY_PROJECTION_KEYS;

const authorityReceiptKeys = Object.freeze([
  "active_journal_sha256",
  "existing_pointer_identity",
  "local_baseline_identity",
  "r2_binding_receipt_sha256",
  "schema_version",
  "source_authority",
  "source_authority_sha256",
  "source_id",
]);

const recoveryCompletionAuthorityKeys = Object.freeze([
  "expected_disposition",
  "expires_at",
  "inspection_file_sha256",
  "inspection_sha256",
  "proposed_plan_sha256",
  "recovery_plan_file_sha256",
  "recovery_plan_sha256",
  "reviewed_at",
  "reviewer_id",
  "source_id",
  "transaction_id",
]);

const reviewedRecoveryInspectionKeys = Object.freeze([
  "evidence_observed_at",
  "evidence_sha256",
  "inspection_file_sha256",
  "inspection_sha256",
  "mode",
  "proposed_plan_sha256",
  "schema_version",
  "source_id",
  "transaction_id",
]);

const reviewedRecoveryPlanKeys = Object.freeze([
  "apply",
  "audit",
  "authority",
  "current_authority",
  "evidence_observed_at",
  "expected_disposition",
  "inspection",
  "journal",
  "operation_binding",
  "plan_sha256",
  "reviewer",
  "schema_version",
]);

const reviewedRecoveryPlanSchema =
  "awardping.stage1.evidence-schema-upgrade-reviewed-exact-transaction-recovery-plan.v1";
const reviewedRecoveryInspectionSchema =
  "awardping.stage1.evidence-schema-upgrade-reviewed-recovery-inspection.v1";

const reportBindingKeys = Object.freeze([
  "attempt_id",
  "file_sha256",
  "finished_at",
  "manifest_sha256",
  "report_schema_version",
  "stage1_report_generated_at",
  "stage1_report_schema_version",
  "stage1_report_sha256",
  "started_at",
  "worker_run_id",
]);

const auditCountKeys = Object.freeze([
  "local_worker_run_inserts",
  "local_worker_run_terminal_updates",
]);

const sourceResultKeys = Object.freeze([
  "capture_validation",
  "eligibility",
  "evaluated_at",
  "manifest_sha256",
  "mode",
  "mutation_counts",
  "pointer_journal",
  "quarantine",
  "queue_policy",
  "reason_code",
  "safety",
  "schema_version",
  "source_eligible",
  "source_id",
  "status",
  "visual_review_candidate",
]);

const sha256Pattern = /^[0-9a-f]{64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Maps the exact lowercase raw plan-file hash to the one allowed audit row.
 * This follows the repository's domain-separated SHA-256 UUID convention.
 */
export function stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(
  planFileSha256,
) {
  const planHash = requiredSha256(planFileSha256, "plan file SHA-256");
  const bytes = Buffer.from(sha256(
    `awardping:stage1-evidence-schema-upgrade:reviewed-exact-one-apply-audit:${planHash}`,
  ), "hex").subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Validates and seals the exact fresh dry-run result that authorizes the sole
 * reviewed commit. The full result is retained in running audit metadata so a
 * crash-after-mutation investigation never has to reconstruct volatile input.
 */
export function stage1EvidenceSchemaUpgradeReviewedApplyFreshCaptureEvidence({
  reviewedApplyPlan,
  captureResult,
} = {}) {
  return buildFreshCaptureEvidence({
    binding: reviewedPlanBinding(reviewedApplyPlan),
    captureResult,
  });
}

/**
 * Projects the exact live shared_award_sources authority used by the reviewed
 * source-health CAS and its response-loss readback. Volatile health fields are
 * intentionally retained: recovery may relax only the explicitly reviewed
 * health-only transition, never silently omit them from the historical seal.
 */
export function stage1EvidenceSchemaUpgradeReviewedApplySourceAuthority(source) {
  const row = requiredObject(source, "reviewed apply live source authority");
  const projection = {};
  for (const key of
    STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_SOURCE_AUTHORITY_PROJECTION_KEYS) {
    if (!Object.hasOwn(row, key) || row[key] === undefined) {
      throw new Error(`Reviewed apply live source authority is missing ${key}.`);
    }
    projection[key] = cloneJson(row[key]);
  }
  assertSourceAuthorityProjection(projection);
  return buildStage1EvidenceSchemaUpgradePrecommitSourceAuthority({
    sourceId: projection.id,
    sourceProjection: projection,
  });
}

/** Builds the exact pre-journal authority receipt persisted by audit start. */
export function stage1EvidenceSchemaUpgradeReviewedApplyAuthorityReceipt({
  source,
  localBaselineIdentity,
  existingPointerIdentity,
  r2BindingReceiptSha256,
  activeJournalSha256 = null,
} = {}) {
  const sourceAuthority = stage1EvidenceSchemaUpgradeReviewedApplySourceAuthority(source);
  const receipt = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUTHORITY_RECEIPT_SCHEMA,
    source_id: sourceAuthority.source_id,
    source_authority: cloneJson(sourceAuthority),
    source_authority_sha256: sourceAuthority.source_authority_sha256,
    local_baseline_identity: cloneJson(localBaselineIdentity),
    existing_pointer_identity: cloneJson(existingPointerIdentity),
    r2_binding_receipt_sha256: r2BindingReceiptSha256,
    active_journal_sha256: activeJournalSha256,
  };
  return assertStage1EvidenceSchemaUpgradeReviewedApplyAuthorityReceipt(receipt);
}

export function assertStage1EvidenceSchemaUpgradeReviewedApplyAuthorityReceipt(value) {
  const receipt = exactObject(
    value,
    authorityReceiptKeys,
    "reviewed apply authority receipt",
  );
  if (
    receipt.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUTHORITY_RECEIPT_SCHEMA
  ) {
    throw new Error("Reviewed apply authority receipt schema is invalid.");
  }
  const sourceAuthority = assertSourceAuthority(receipt.source_authority);
  const sourceId = requiredUuid(receipt.source_id, "authority receipt source_id");
  const baseline = exactObject(
    receipt.local_baseline_identity,
    ["byte_length", "sha256"],
    "authority receipt local baseline identity",
  );
  const pointer = exactObject(
    receipt.existing_pointer_identity,
    ["canonical_sha256", "exists", "schema_version"],
    "authority receipt existing pointer identity",
  );
  if (
    sourceAuthority.source_id !== sourceId
    || receipt.source_authority_sha256 !== sourceAuthority.source_authority_sha256
    || requiredSha256(baseline.sha256, "authority receipt baseline SHA-256")
      !== baseline.sha256
    || !Number.isSafeInteger(baseline.byte_length)
    || baseline.byte_length < 0
    || typeof pointer.exists !== "boolean"
    || (pointer.canonical_sha256 !== null
      && !sha256Pattern.test(pointer.canonical_sha256))
    || !requiredText(pointer.schema_version, "authority receipt pointer schema")
    || !sha256Pattern.test(receipt.r2_binding_receipt_sha256)
    || (receipt.active_journal_sha256 !== null
      && !sha256Pattern.test(receipt.active_journal_sha256))
  ) {
    throw new Error("Reviewed apply authority receipt identity is invalid.");
  }
  return deepFreeze(cloneJson(receipt));
}

/**
 * Identifies terminalization performed by the original reviewed apply. The
 * original plan, fresh capture, and pre-commit authority remain sealed in the
 * surrounding running metadata; this explicit variant prevents a later
 * recovery finish from being represented as that original execution.
 */
export function stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority() {
  return sealCompletionAuthority({
    mode: "fresh_reviewed_apply",
    recovery: null,
  });
}

/**
 * Projects the exact validated recovery plan authority into the durable audit
 * terminal. The recovery runtime must call this only with its already-validated
 * canonical plan and externally supplied file/self hashes.
 */
export function stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority({
  recoveryPlan,
  expectedRecoveryPlanFileSha256,
  expectedRecoveryPlanSha256,
  sourceId,
  transactionId,
} = {}) {
  const plan = exactObject(
    recoveryPlan,
    reviewedRecoveryPlanKeys,
    "reviewed recovery completion plan",
  );
  const planFileSha256 = requiredSha256(
    expectedRecoveryPlanFileSha256,
    "reviewed recovery completion plan file SHA-256",
  );
  const planSha256 = requiredSha256(
    expectedRecoveryPlanSha256,
    "reviewed recovery completion plan self SHA-256",
  );
  const planContent = cloneJson(plan);
  delete planContent.plan_sha256;
  if (
    plan.schema_version !== reviewedRecoveryPlanSchema
    || plan.plan_sha256 !== planSha256
    || planSha256 !== sha256(canonicalJson(planContent))
  ) {
    throw new Error("Reviewed recovery completion plan seal is invalid.");
  }
  const inspection = exactObject(
    plan.inspection,
    reviewedRecoveryInspectionKeys,
    "reviewed recovery completion inspection binding",
  );
  const reviewer = exactObject(
    plan.reviewer,
    ["expires_at", "reviewed_at", "reviewer_id"],
    "reviewed recovery completion reviewer",
  );
  const source = requiredUuid(
    sourceId ?? inspection.source_id,
    "reviewed recovery completion source ID",
  );
  const transaction = requiredUuid(
    transactionId ?? inspection.transaction_id,
    "reviewed recovery completion transaction ID",
  );
  const reviewedAt = requiredTimestamp(
    reviewer.reviewed_at,
    "reviewed recovery completion reviewed_at",
  );
  const expiresAt = requiredTimestamp(
    reviewer.expires_at,
    "reviewed recovery completion expires_at",
  );
  const apply = requiredObject(plan.apply, "reviewed recovery completion apply binding");
  if (
    inspection.schema_version !== reviewedRecoveryInspectionSchema
    || inspection.mode !== "inspect_and_generate_sealed_evidence"
    || inspection.source_id !== source
    || inspection.transaction_id !== transaction
    || apply.selected_source_id !== source
    || Date.parse(expiresAt) <= Date.parse(reviewedAt)
  ) {
    throw new Error("Reviewed recovery completion identity is invalid.");
  }
  for (const [value, label] of [
    [inspection.inspection_file_sha256, "inspection file"],
    [inspection.inspection_sha256, "inspection self"],
    [inspection.proposed_plan_sha256, "proposed plan"],
  ]) requiredSha256(value, `reviewed recovery completion ${label} SHA-256`);

  return sealCompletionAuthority({
    mode: "reviewed_recovery",
    recovery: {
      recovery_plan_file_sha256: planFileSha256,
      recovery_plan_sha256: planSha256,
      inspection_file_sha256: inspection.inspection_file_sha256,
      inspection_sha256: inspection.inspection_sha256,
      proposed_plan_sha256: inspection.proposed_plan_sha256,
      reviewer_id: requiredText(reviewer.reviewer_id, "reviewed recovery reviewer ID"),
      reviewed_at: reviewedAt,
      expires_at: expiresAt,
      expected_disposition: requiredText(
        plan.expected_disposition,
        "reviewed recovery expected disposition",
      ),
      source_id: source,
      transaction_id: transaction,
    },
  });
}

export function assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
  value,
  { selectedSourceId = null, finishedAt = null } = {},
) {
  const authority = exactObject(value, [
    "completion_authority_sha256",
    "mode",
    "recovery",
    "schema_version",
  ], "reviewed apply audit completion authority");
  const content = cloneJson(authority);
  delete content.completion_authority_sha256;
  if (
    content.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_COMPLETION_AUTHORITY_SCHEMA
    || !new Set(["fresh_reviewed_apply", "reviewed_recovery"]).has(content.mode)
    || authority.completion_authority_sha256 !== sha256(canonicalJson(content))
  ) throw new Error("Reviewed apply audit completion authority seal is invalid.");
  if (content.mode === "fresh_reviewed_apply") {
    if (content.recovery !== null) {
      throw new Error("Fresh reviewed apply completion cannot contain recovery authority.");
    }
    return deepFreeze(cloneJson(authority));
  }

  const recovery = exactObject(
    content.recovery,
    recoveryCompletionAuthorityKeys,
    "reviewed recovery audit completion authority",
  );
  for (const [key, label] of [
    ["recovery_plan_file_sha256", "plan file"],
    ["recovery_plan_sha256", "plan self"],
    ["inspection_file_sha256", "inspection file"],
    ["inspection_sha256", "inspection self"],
    ["proposed_plan_sha256", "proposed plan"],
  ]) requiredSha256(recovery[key], `reviewed recovery completion ${label} SHA-256`);
  const source = requiredUuid(recovery.source_id, "reviewed recovery completion source ID");
  requiredUuid(recovery.transaction_id, "reviewed recovery completion transaction ID");
  requiredText(recovery.reviewer_id, "reviewed recovery completion reviewer ID");
  requiredText(recovery.expected_disposition, "reviewed recovery completion disposition");
  const reviewedAt = requiredTimestamp(
    recovery.reviewed_at,
    "reviewed recovery completion reviewed_at",
  );
  const expiresAt = requiredTimestamp(
    recovery.expires_at,
    "reviewed recovery completion expires_at",
  );
  const finished = finishedAt === null
    ? null
    : requiredTimestamp(finishedAt, "audit completion finished_at");
  if (
    (selectedSourceId !== null && source !== selectedSourceId)
    || Date.parse(expiresAt) <= Date.parse(reviewedAt)
    || (finished !== null && (
      Date.parse(finished) < Date.parse(reviewedAt)
      || Date.parse(finished) >= Date.parse(expiresAt)
    ))
  ) throw new Error("Reviewed recovery audit completion authority is outside its exact scope.");
  return deepFreeze(cloneJson(authority));
}

function sealCompletionAuthority({ mode, recovery }) {
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_COMPLETION_AUTHORITY_SCHEMA,
    mode,
    recovery: cloneJson(recovery),
  };
  return deepFreeze({
    ...content,
    completion_authority_sha256: sha256(canonicalJson(content)),
  });
}

/**
 * Inserts only the dedicated reviewed-apply row. `insertRun` must perform a
 * plain insert (never an upsert) and return the complete row projection above.
 * `readRun` is used only after an ambiguous/non-exact insert response.
 */
export async function startStage1EvidenceSchemaUpgradeReviewedApplyAudit({
  reviewedApplyPlan,
  executionNonce,
  startedAt,
  captureResult,
  authorityReceipt,
  interfaces = {},
} = {}) {
  const binding = reviewedPlanBinding(reviewedApplyPlan);
  const freshCapture = buildFreshCaptureEvidence({ binding, captureResult });
  const checkedAuthorityReceipt = assertAuthorityReceiptForBinding(
    authorityReceipt,
    binding,
  );
  const authorityReceiptSha256 = sha256(canonicalJson(checkedAuthorityReceipt));
  const nonce = requiredExecutionNonce(executionNonce);
  const started = requiredTimestamp(startedAt, "audit start time");
  const insertRun = requiredFunction(interfaces.insertRun, "insertRun");
  const readRun = requiredFunction(interfaces.readRun, "readRun");
  const runId = stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(
    binding.plan.file_sha256,
  );
  if (nonce === runId) {
    throw new Error("Reviewed apply execution_nonce must differ from the deterministic audit row ID.");
  }

  const runningRow = buildRunningRow({
    binding,
    executionNonce: nonce,
    freshCapture,
    authorityReceipt: checkedAuthorityReceipt,
    authorityReceiptSha256,
    startedAt: started,
  });
  let returned;
  let insertAmbiguous = false;
  try {
    returned = await insertRun(deepFreeze(cloneJson(runningRow)));
  } catch {
    insertAmbiguous = true;
  }
  const returnedInspection = inspectAuditRow(returned, binding);
  if (isSameRunningExecution(returnedInspection, {
    nonce,
    startedAt: started,
    freshCaptureSha256: freshCapture.fresh_capture_sha256,
    authorityReceiptSha256,
  })) {
    return buildAuditReceipt({
      action: "start",
      disposition: "started",
      businessExecutionAuthorized: true,
      replay: false,
      binding,
      requestedExecutionNonce: nonce,
      inspection: returnedInspection,
      lowerBoundCounts: { local_worker_run_inserts: 1, local_worker_run_terminal_updates: 0 },
      unknownWriteCategories: [],
      responseLossPossible: false,
    });
  }
  insertAmbiguous = true;

  const readback = await safeRead(readRun, runId);
  const inspection = inspectAuditRow(readback.row, binding);
  if (isSameRunningExecution(inspection, {
    nonce,
    startedAt: started,
    freshCaptureSha256: freshCapture.fresh_capture_sha256,
    authorityReceiptSha256,
  })) {
    return buildAuditReceipt({
      action: "start",
      disposition: "started_after_insert_response_loss",
      businessExecutionAuthorized: true,
      replay: false,
      binding,
      requestedExecutionNonce: nonce,
      inspection,
      lowerBoundCounts: zeroAuditCounts(),
      unknownWriteCategories: ["local_worker_run_inserts"],
      responseLossPossible: true,
    });
  }
  if (inspection.kind === "terminal_succeeded") {
    return buildAuditReceipt({
      action: "start",
      disposition: "prior_terminal_success_replay",
      businessExecutionAuthorized: false,
      replay: true,
      binding,
      requestedExecutionNonce: nonce,
      inspection,
      lowerBoundCounts: zeroAuditCounts(),
      unknownWriteCategories: inspection.execution_nonce === nonce && insertAmbiguous
        ? ["local_worker_run_inserts"]
        : [],
      responseLossPossible: inspection.execution_nonce === nonce && insertAmbiguous,
    });
  }

  const disposition = inspection.kind === "running"
    ? inspection.execution_nonce === nonce
      ? "ambiguous_insert_running_row_mismatch"
      : "concurrent_execution_running"
    : inspection.kind === "terminal_failed"
      ? "prior_terminal_failure"
      : inspection.kind === "missing"
        ? "ambiguous_insert_row_missing"
        : "ambiguous_insert_row_mismatch";
  return buildAuditReceipt({
    action: "start",
    disposition,
    businessExecutionAuthorized: false,
    replay: false,
    binding,
    requestedExecutionNonce: nonce,
    inspection,
    lowerBoundCounts: zeroAuditCounts(),
    unknownWriteCategories: uncertainInsertCategories({ inspection, nonce, insertAmbiguous }),
    responseLossPossible: insertAmbiguous,
  });
}

/**
 * Performs the one allowed guarded running -> succeeded/failed update.
 * `updateRun` receives `{ guard, patch }`; the adapter must apply every guard
 * atomically and return the complete row projection. No supersession callback
 * exists in this interface.
 */
export async function finishStage1EvidenceSchemaUpgradeReviewedApplyAudit({
  reviewedApplyPlan,
  executionNonce,
  finishedAt,
  terminal,
  completionAuthority,
  interfaces = {},
} = {}) {
  const binding = reviewedPlanBinding(reviewedApplyPlan);
  const nonce = requiredExecutionNonce(executionNonce);
  const finished = requiredTimestamp(finishedAt, "audit finish time");
  const desiredTerminal = buildTerminal({
    terminal,
    completionAuthority,
    selectedSourceId: binding.scope.selected_source_id,
    finishedAt: finished,
  });
  const readRun = requiredFunction(interfaces.readRun, "readRun");
  const updateRun = requiredFunction(interfaces.updateRun, "updateRun");
  const runId = stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(
    binding.plan.file_sha256,
  );

  const before = await safeRead(readRun, runId);
  const beforeInspection = inspectAuditRow(before.row, binding);
  if (beforeInspection.kind === "terminal_succeeded") {
    const replay = desiredTerminal.status === "succeeded"
      && sameJson(
        beforeInspection.terminal.selected_result_commit_identity,
        desiredTerminal.selected_result_commit_identity,
      )
      && beforeInspection.terminal.completion_authority.completion_authority_sha256
        === desiredTerminal.completion_authority.completion_authority_sha256;
    return buildAuditReceipt({
      action: "finish",
      disposition: replay ? "terminal_success_replay" : "terminal_success_conflict",
      businessExecutionAuthorized: false,
      replay,
      binding,
      requestedExecutionNonce: nonce,
      inspection: beforeInspection,
      lowerBoundCounts: zeroAuditCounts(),
      unknownWriteCategories: [],
      responseLossPossible: false,
    });
  }
  if (beforeInspection.kind === "terminal_failed") {
    const replay = desiredTerminal.status === "failed"
      && sameJson(
        beforeInspection.terminal.failure,
        desiredTerminal.failure,
      )
      && beforeInspection.terminal.completion_authority.completion_authority_sha256
        === desiredTerminal.completion_authority.completion_authority_sha256;
    return buildAuditReceipt({
      action: "finish",
      disposition: replay ? "terminal_failure_replay" : "terminal_failure_conflict",
      businessExecutionAuthorized: false,
      replay,
      binding,
      requestedExecutionNonce: nonce,
      inspection: beforeInspection,
      lowerBoundCounts: zeroAuditCounts(),
      unknownWriteCategories: [],
      responseLossPossible: false,
    });
  }
  if (
    beforeInspection.kind !== "running"
    || beforeInspection.execution_nonce !== nonce
  ) {
    const disposition = beforeInspection.kind === "running"
      ? "concurrent_execution_running"
      : beforeInspection.kind === "missing"
        ? "finish_precondition_row_missing"
        : "finish_precondition_row_mismatch";
    return buildAuditReceipt({
      action: "finish",
      disposition,
      businessExecutionAuthorized: false,
      replay: false,
      binding,
      requestedExecutionNonce: nonce,
      inspection: beforeInspection,
      lowerBoundCounts: zeroAuditCounts(),
      unknownWriteCategories: [],
      responseLossPossible: false,
    });
  }
  if (Date.parse(finished) < Date.parse(beforeInspection.started_at)) {
    throw new Error("Reviewed apply audit finish time precedes its start time.");
  }

  const terminalMetadata = sealMetadata({
    ...metadataContent(beforeInspection.row.metadata),
    phase: "terminal",
    terminal: desiredTerminal,
  });
  const patch = terminalPatch({
    status: desiredTerminal.status,
    metadata: terminalMetadata,
    finishedAt: finished,
  });
  const guard = deepFreeze({
    id: runId,
    worker_name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME,
    status: "running",
    execution_nonce: nonce,
    plan_file_sha256: binding.plan.file_sha256,
    plan_sha256: binding.plan.self_sha256,
    running_metadata_sha256: beforeInspection.row.metadata.metadata_sha256,
  });

  let returned;
  let updateAmbiguous = false;
  try {
    returned = await updateRun(deepFreeze({ guard, patch }));
  } catch {
    updateAmbiguous = true;
  }
  const returnedInspection = inspectAuditRow(returned, binding);
  if (isDesiredTerminalExecution(returnedInspection, {
    nonce,
    terminal: desiredTerminal,
    finishedAt: finished,
  })) {
    return buildAuditReceipt({
      action: "finish",
      disposition: "finished",
      businessExecutionAuthorized: false,
      replay: false,
      binding,
      requestedExecutionNonce: nonce,
      inspection: returnedInspection,
      lowerBoundCounts: { local_worker_run_inserts: 0, local_worker_run_terminal_updates: 1 },
      unknownWriteCategories: [],
      responseLossPossible: false,
    });
  }
  updateAmbiguous = true;

  const after = await safeRead(readRun, runId);
  const afterInspection = inspectAuditRow(after.row, binding);
  if (isDesiredTerminalExecution(afterInspection, {
    nonce,
    terminal: desiredTerminal,
    finishedAt: finished,
  })) {
    return buildAuditReceipt({
      action: "finish",
      disposition: "finished_after_update_response_loss",
      businessExecutionAuthorized: false,
      replay: false,
      binding,
      requestedExecutionNonce: nonce,
      inspection: afterInspection,
      lowerBoundCounts: zeroAuditCounts(),
      unknownWriteCategories: ["local_worker_run_terminal_updates"],
      responseLossPossible: true,
    });
  }
  return buildAuditReceipt({
    action: "finish",
    disposition: afterInspection.kind === "running"
      ? "ambiguous_update_row_still_running"
      : "ambiguous_update_terminal_mismatch",
    businessExecutionAuthorized: false,
    replay: false,
    binding,
    requestedExecutionNonce: nonce,
    inspection: afterInspection,
    lowerBoundCounts: zeroAuditCounts(),
    unknownWriteCategories: updateAmbiguous
      ? ["local_worker_run_terminal_updates"]
      : [],
    responseLossPossible: updateAmbiguous,
  });
}

/**
 * Performs one read-only inspection of the deterministic audit row and returns
 * exact sealed evidence for either a running recovery or report-only replay of
 * a terminal result. Missing, malformed, and unreadable rows fail closed.
 */
export async function inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery({
  reviewedApplyPlan,
  interfaces = {},
} = {}) {
  const binding = reviewedPlanBinding(reviewedApplyPlan);
  const readRun = requiredFunction(interfaces.readRun, "readRun");
  const runId = stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(
    binding.plan.file_sha256,
  );
  let row;
  try {
    row = await readRun({ run_id: runId });
  } catch (cause) {
    throw Object.assign(
      new Error("Reviewed apply running audit recovery row could not be read exactly."),
      { code: "reviewed_apply_audit_recovery_read_failed", cause },
    );
  }
  const inspected = inspectAuditRow(row, binding);
  if (!new Set(["running", "terminal_succeeded", "terminal_failed"]).has(
    inspected.kind,
  )) {
    throw Object.assign(
      new Error(
        `Reviewed apply audit recovery requires one exact known row; observed ${inspected.kind}.`,
      ),
      {
        code: "reviewed_apply_audit_recovery_not_running",
        observed_kind: inspected.kind,
        observed_row_sha256: inspected.row_sha256,
      },
    );
  }
  const terminal = inspected.terminal ? cloneJson(inspected.terminal) : null;
  const status = inspected.row.status;
  const reportReplay = inspected.kind.startsWith("terminal_");
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RECOVERY_INSPECTION_SCHEMA,
    disposition: inspected.kind === "running"
      ? "running_recovery_evidence"
      : inspected.kind === "terminal_succeeded"
        ? "terminal_success_report_replay_evidence"
        : "terminal_failure_report_replay_evidence",
    row_kind: inspected.kind,
    run_id: runId,
    worker_name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME,
    status,
    execution_nonce: inspected.execution_nonce,
    started_at: inspected.started_at,
    finished_at: inspected.row.finished_at,
    plan_file_sha256: binding.plan.file_sha256,
    plan_sha256: binding.plan.self_sha256,
    selected_source_id: binding.scope.selected_source_id,
    binding: cloneJson(binding),
    fresh_capture: cloneJson(inspected.fresh_capture),
    authority_receipt: cloneJson(inspected.authority_receipt),
    authority_receipt_sha256: inspected.authority_receipt_sha256,
    terminal,
    terminal_status: terminal?.status || null,
    terminal_identity_sha256:
      terminal?.selected_result_commit_identity?.identity_sha256 || null,
    terminal_failure_sha256:
      terminal?.failure ? failureIdentitySha256(terminal.failure) : null,
    terminal_completion_authority_mode:
      terminal?.completion_authority?.mode || null,
    terminal_completion_authority_sha256:
      terminal?.completion_authority?.completion_authority_sha256 || null,
    observed_row_sha256: inspected.row_sha256,
    report_replay: reportReplay,
    business_execution_authorized: false,
    mutation_permitted: false,
    mutation_performed: false,
    creates_api_charge: false,
  };
  return deepFreeze({
    ...content,
    inspection_sha256: sha256(canonicalJson(content)),
  });
}

/**
 * Validates a completed reviewed-apply audit row without requiring the original
 * plan bytes. The row's self-sealed plan binding is treated only as historical
 * evidence; callers must independently bind it to the completed journal,
 * retained provenance, and current authority before accepting an already-
 * upgraded disposition.
 */
export function inspectStage1EvidenceSchemaUpgradeCompletedAuthorityAuditRow({
  row,
  expectedRunId,
  expectedSourceId,
  expectedManifestSource,
  expectedManifestSha256,
} = {}) {
  const runId = requiredUuid(expectedRunId, "completed-authority expected audit run ID");
  const sourceId = requiredUuid(
    expectedSourceId,
    "completed-authority expected selected source ID",
  );
  const manifestSha256 = requiredSha256(
    expectedManifestSha256,
    "completed-authority expected manifest SHA-256",
  );
  const manifestSource = requiredObject(
    expectedManifestSource,
    "completed-authority expected manifest source",
  );
  if (manifestSource.source_id !== sourceId) {
    throw new Error(
      "Completed Stage 1 authority expected manifest source and source ID differ.",
    );
  }
  const historicalBinding = assertHistoricalReviewedPlanBinding(
    row?.metadata?.binding,
  );
  const inspected = inspectAuditRow(row, historicalBinding);
  if (
    inspected.kind !== "terminal_succeeded"
    || inspected.row.id !== runId
    || historicalBinding.scope.selected_source_id !== sourceId
    || historicalBinding.manifest.sha256 !== manifestSha256
    || !sameJson(historicalBinding.selected.source, manifestSource)
  ) {
    throw new Error(
      "Completed Stage 1 authority requires one exact externally bound terminal-succeeded reviewed-apply audit row.",
    );
  }
  const binding = inspected.row.metadata.binding;
  const terminal = inspected.terminal;
  const resultIdentity = assertResultCommitIdentity(
    terminal.selected_result_commit_identity,
  );
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMPLETED_AUTHORITY_AUDIT_INSPECTION_SCHEMA,
    disposition: "terminal_succeeded",
    run_id: runId,
    worker_name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME,
    status: inspected.row.status,
    selected_source_id: sourceId,
    execution_nonce: inspected.execution_nonce,
    started_at: inspected.started_at,
    finished_at: inspected.row.finished_at,
    plan_file_sha256: binding.plan.file_sha256,
    plan_sha256: binding.plan.self_sha256,
    manifest_sha256: manifestSha256,
    reviewed_report_attempt_id: binding.dry_run_report.attempt_id,
    authority_receipt_sha256: inspected.authority_receipt_sha256,
    fresh_capture_sha256: inspected.fresh_capture.fresh_capture_sha256,
    fresh_capture_result_sha256: inspected.fresh_capture.capture_result_sha256,
    fresh_capture_validation_sha256:
      inspected.fresh_capture.capture_validation_sha256,
    fresh_validation_projection_sha256:
      inspected.fresh_capture.fresh_validation_projection_sha256,
    terminal_identity_sha256: resultIdentity.identity_sha256,
    terminal_result_identity: cloneJson(resultIdentity),
    terminal_commit_receipt_sha256: resultIdentity.commit_receipt_sha256,
    terminal_commit_journal_sha256: resultIdentity.commit_journal_sha256,
    terminal_mutation_accounting_sha256:
      resultIdentity.commit_mutation_accounting_sha256,
    terminal_completion_authority: cloneJson(terminal.completion_authority),
    observed_row_sha256: inspected.row_sha256,
    business_execution_authorized: false,
    mutation_permitted: false,
    mutation_performed: false,
    creates_api_charge: false,
  };
  return deepFreeze({
    ...content,
    inspection_sha256: sha256(canonicalJson(content)),
  });
}

export function assertStage1EvidenceSchemaUpgradeCompletedAuthorityAuditInspection(
  value,
) {
  const inspected = exactObject(value, [
    "authority_receipt_sha256",
    "business_execution_authorized",
    "creates_api_charge",
    "disposition",
    "execution_nonce",
    "finished_at",
    "fresh_capture_result_sha256",
    "fresh_capture_sha256",
    "fresh_capture_validation_sha256",
    "fresh_validation_projection_sha256",
    "inspection_sha256",
    "manifest_sha256",
    "mutation_performed",
    "mutation_permitted",
    "observed_row_sha256",
    "plan_file_sha256",
    "plan_sha256",
    "reviewed_report_attempt_id",
    "run_id",
    "schema_version",
    "selected_source_id",
    "started_at",
    "status",
    "terminal_commit_journal_sha256",
    "terminal_commit_receipt_sha256",
    "terminal_completion_authority",
    "terminal_identity_sha256",
    "terminal_result_identity",
    "terminal_mutation_accounting_sha256",
    "worker_name",
  ], "completed-authority audit inspection");
  const content = cloneJson(inspected);
  delete content.inspection_sha256;
  if (
    content.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMPLETED_AUTHORITY_AUDIT_INSPECTION_SCHEMA
    || content.disposition !== "terminal_succeeded"
    || content.worker_name
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME
    || content.status !== "succeeded"
    || content.business_execution_authorized !== false
    || content.mutation_permitted !== false
    || content.mutation_performed !== false
    || content.creates_api_charge !== false
    || inspected.inspection_sha256 !== sha256(canonicalJson(content))
  ) {
    throw new Error("Completed-authority audit inspection seal or state is invalid.");
  }
  for (const [field, label] of [
    [content.run_id, "run ID"],
    [content.selected_source_id, "selected source ID"],
    [content.reviewed_report_attempt_id, "reviewed report attempt ID"],
  ]) requiredUuid(field, `completed-authority audit ${label}`);
  requiredExecutionNonce(content.execution_nonce);
  requiredTimestamp(content.started_at, "completed-authority audit started_at");
  requiredTimestamp(content.finished_at, "completed-authority audit finished_at");
  for (const [field, label] of [
    [content.plan_file_sha256, "plan file"],
    [content.plan_sha256, "plan self"],
    [content.manifest_sha256, "manifest"],
    [content.authority_receipt_sha256, "authority receipt"],
    [content.fresh_capture_sha256, "fresh capture"],
    [content.fresh_capture_result_sha256, "fresh capture result"],
    [content.fresh_capture_validation_sha256, "fresh capture validation"],
    [content.fresh_validation_projection_sha256, "fresh validation projection"],
    [content.terminal_identity_sha256, "terminal identity"],
    [content.terminal_commit_receipt_sha256, "terminal commit receipt"],
    [content.terminal_commit_journal_sha256, "terminal commit journal"],
    [content.terminal_mutation_accounting_sha256, "terminal mutation accounting"],
    [content.observed_row_sha256, "observed row"],
  ]) requiredSha256(field, `completed-authority audit ${label} SHA-256`);
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
    content.terminal_completion_authority,
    {
      selectedSourceId: content.selected_source_id,
      finishedAt: content.finished_at,
    },
  );
  const resultIdentity = assertResultCommitIdentity(content.terminal_result_identity);
  if (
    content.run_id
      !== stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(content.plan_file_sha256)
    || resultIdentity.source_id !== content.selected_source_id
    || resultIdentity.identity_sha256 !== content.terminal_identity_sha256
    || resultIdentity.commit_receipt_sha256 !== content.terminal_commit_receipt_sha256
    || resultIdentity.commit_journal_sha256 !== content.terminal_commit_journal_sha256
    || resultIdentity.commit_mutation_accounting_sha256
      !== content.terminal_mutation_accounting_sha256
  ) {
    throw new Error("Completed-authority audit inspection identities disagree.");
  }
  return deepFreeze(cloneJson(inspected));
}

export function assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
  value,
) {
  const inspected = exactObject(value, [
    "authority_receipt",
    "authority_receipt_sha256",
    "binding",
    "business_execution_authorized",
    "creates_api_charge",
    "disposition",
    "execution_nonce",
    "fresh_capture",
    "finished_at",
    "inspection_sha256",
    "mutation_performed",
    "mutation_permitted",
    "observed_row_sha256",
    "plan_file_sha256",
    "plan_sha256",
    "report_replay",
    "row_kind",
    "run_id",
    "schema_version",
    "selected_source_id",
    "started_at",
    "status",
    "terminal",
    "terminal_completion_authority_mode",
    "terminal_completion_authority_sha256",
    "terminal_failure_sha256",
    "terminal_identity_sha256",
    "terminal_status",
    "worker_name",
  ], "reviewed apply audit recovery inspection");
  const content = cloneJson(inspected);
  delete content.inspection_sha256;
  const binding = requiredObject(content.binding, "reviewed apply recovery binding");
  const plan = requiredObject(binding.plan, "reviewed apply recovery plan binding");
  const scope = requiredObject(binding.scope, "reviewed apply recovery scope binding");
  if (
    content.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RECOVERY_INSPECTION_SCHEMA
    || content.worker_name
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME
    || !new Set(["running", "terminal_succeeded", "terminal_failed"]).has(
      content.row_kind,
    )
    || content.disposition !== (
      content.row_kind === "running"
        ? "running_recovery_evidence"
        : content.row_kind === "terminal_succeeded"
          ? "terminal_success_report_replay_evidence"
          : "terminal_failure_report_replay_evidence"
    )
    || content.status !== (
      content.row_kind === "running"
        ? "running"
        : content.row_kind === "terminal_succeeded" ? "succeeded" : "failed"
    )
    || content.report_replay !== content.row_kind.startsWith("terminal_")
    || content.business_execution_authorized !== false
    || content.mutation_permitted !== false
    || content.mutation_performed !== false
    || content.creates_api_charge !== false
    || !uuidV4Pattern.test(content.execution_nonce)
    || content.run_id
      !== stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(plan.file_sha256)
    || content.plan_file_sha256 !== plan.file_sha256
    || content.plan_sha256 !== plan.self_sha256
    || content.selected_source_id !== scope.selected_source_id
    || !sha256Pattern.test(content.observed_row_sha256)
    || inspected.inspection_sha256 !== sha256(canonicalJson(content))
  ) {
    throw new Error("Reviewed apply audit recovery inspection seal or identity is invalid.");
  }
  requiredTimestamp(content.started_at, "audit recovery started_at");
  if (content.row_kind === "running") {
    if (
      content.finished_at !== null
      || content.terminal !== null
      || content.terminal_status !== null
      || content.terminal_identity_sha256 !== null
      || content.terminal_failure_sha256 !== null
      || content.terminal_completion_authority_mode !== null
      || content.terminal_completion_authority_sha256 !== null
    ) {
      throw new Error("Reviewed apply running recovery inspection contains terminal evidence.");
    }
  } else {
    requiredTimestamp(content.finished_at, "audit recovery finished_at");
    const terminal = assertTerminal(content.terminal);
    assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
      terminal.completion_authority,
      {
        selectedSourceId: content.selected_source_id,
        finishedAt: content.finished_at,
      },
    );
    if (
      terminal.status !== content.status
      || content.terminal_status !== terminal.status
      || !sameTimestampInstant(content.finished_at, terminal.finished_at)
      || Date.parse(content.finished_at) < Date.parse(content.started_at)
      || (content.row_kind === "terminal_succeeded"
        ? content.terminal_identity_sha256
          !== terminal.selected_result_commit_identity?.identity_sha256
        : content.terminal_identity_sha256 !== null)
      || (content.row_kind === "terminal_failed"
        ? content.terminal_failure_sha256 !== failureIdentitySha256(terminal.failure)
        : content.terminal_failure_sha256 !== null)
      || content.terminal_completion_authority_mode
        !== terminal.completion_authority.mode
      || content.terminal_completion_authority_sha256
        !== terminal.completion_authority.completion_authority_sha256
    ) {
      throw new Error("Reviewed apply terminal recovery inspection identity is invalid.");
    }
    if (content.row_kind === "terminal_succeeded") {
      assertResultCommitIdentity(terminal.selected_result_commit_identity);
    } else {
      if (terminal.selected_result_commit_identity !== null) {
        throw new Error("Reviewed apply failed recovery inspection has a result identity.");
      }
      assertFailure(terminal.failure);
    }
  }
  assertFreshCaptureEvidence(content.fresh_capture, binding);
  const authorityReceipt = assertAuthorityReceiptForBinding(
    content.authority_receipt,
    binding,
  );
  if (
    requiredSha256(
      content.authority_receipt_sha256,
      "audit recovery authority receipt SHA-256",
    ) !== sha256(canonicalJson(authorityReceipt))
  ) {
    throw new Error("Reviewed apply audit recovery authority receipt seal is invalid.");
  }
  return deepFreeze(cloneJson(inspected));
}

export function assertStage1EvidenceSchemaUpgradeReviewedApplyAuditAccounting(value) {
  const accounting = exactObject(value, [
    "accounting_sha256",
    "count_scope",
    "count_semantics",
    "evidence",
    "exact",
    "lower_bound_counts",
    "schema_version",
    "unknown_write_categories",
  ], "reviewed apply audit accounting");
  const content = cloneJson(accounting);
  delete content.accounting_sha256;
  const counts = exactObject(
    content.lower_bound_counts,
    auditCountKeys,
    "reviewed apply audit lower-bound counts",
  );
  if (auditCountKeys.some((key) => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) {
    throw new Error("Reviewed apply audit lower-bound counts are invalid.");
  }
  if (!Array.isArray(content.unknown_write_categories)) {
    throw new Error("Reviewed apply audit unknown write categories are invalid.");
  }
  const unknown = [...new Set(content.unknown_write_categories)].sort();
  if (
    content.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_ACCOUNTING_SCHEMA
    || content.count_scope !== "local_worker_runs_writes_in_this_orchestration_invocation"
    || content.count_semantics !== "confirmed_lower_bounds"
    || unknown.some((key) => !auditCountKeys.includes(key))
    || !sameJson(unknown, content.unknown_write_categories)
    || content.exact !== (unknown.length === 0)
    || !plainObject(content.evidence)
    || accounting.accounting_sha256 !== sha256(canonicalJson(content))
  ) {
    throw new Error("Reviewed apply audit accounting seal or content is invalid.");
  }
  return deepFreeze(cloneJson(accounting));
}

export function assertStage1EvidenceSchemaUpgradeReviewedApplyAuditReceipt(value) {
  const receipt = exactObject(value, [
    "action",
    "active_execution_nonce",
    "audit_mutation_accounting",
    "authority_receipt_sha256",
    "business_execution_authorized",
    "disposition",
    "fresh_capture_evidence_sha256",
    "fresh_capture_result_sha256",
    "fresh_capture_validation_sha256",
    "fresh_validation_projection_sha256",
    "observed_row_sha256",
    "plan_file_sha256",
    "plan_sha256",
    "receipt_sha256",
    "replay",
    "requested_execution_nonce",
    "run_id",
    "schema_version",
    "selected_source_id",
    "terminal_completion_authority_mode",
    "terminal_completion_authority_sha256",
    "terminal_failure_sha256",
    "terminal_identity_sha256",
    "terminal_status",
    "worker_name",
  ], "reviewed apply audit receipt");
  const content = cloneJson(receipt);
  delete content.receipt_sha256;
  if (
    content.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RECEIPT_SCHEMA
    || !["start", "finish"].includes(content.action)
    || !cleanText(content.disposition)
    || typeof content.business_execution_authorized !== "boolean"
    || typeof content.replay !== "boolean"
    || content.worker_name
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME
    || !uuidPattern.test(content.run_id)
    || !uuidV4Pattern.test(content.requested_execution_nonce)
    || (content.active_execution_nonce !== null
      && !uuidV4Pattern.test(content.active_execution_nonce))
    || !sha256Pattern.test(content.plan_file_sha256)
    || !sha256Pattern.test(content.plan_sha256)
    || !uuidPattern.test(content.selected_source_id)
    || (content.observed_row_sha256 !== null
      && !sha256Pattern.test(content.observed_row_sha256))
    || (content.terminal_identity_sha256 !== null
      && !sha256Pattern.test(content.terminal_identity_sha256))
    || (content.terminal_failure_sha256 !== null
      && !sha256Pattern.test(content.terminal_failure_sha256))
    || (content.terminal_status === "succeeded"
      && content.terminal_identity_sha256 === null)
    || (content.terminal_status !== "succeeded"
      && content.terminal_identity_sha256 !== null)
    || (content.terminal_status === "succeeded"
      && content.terminal_failure_sha256 !== null)
    || (content.terminal_status === "failed"
      && content.terminal_failure_sha256 === null)
    || (content.terminal_status === null
      && content.terminal_failure_sha256 !== null)
    || ![null, "fresh_reviewed_apply", "reviewed_recovery"].includes(
      content.terminal_completion_authority_mode,
    )
    || (content.terminal_completion_authority_sha256 !== null
      && !sha256Pattern.test(content.terminal_completion_authority_sha256))
    || ((content.terminal_status === null)
      !== (content.terminal_completion_authority_mode === null))
    || ((content.terminal_completion_authority_mode === null)
      !== (content.terminal_completion_authority_sha256 === null))
    || (content.authority_receipt_sha256 !== null
      && !sha256Pattern.test(content.authority_receipt_sha256))
    || [
      content.fresh_capture_evidence_sha256,
      content.fresh_capture_result_sha256,
      content.fresh_capture_validation_sha256,
      content.fresh_validation_projection_sha256,
    ].some((hash) => hash !== null && !sha256Pattern.test(hash))
    || new Set([
      content.fresh_capture_evidence_sha256,
      content.fresh_capture_result_sha256,
      content.fresh_capture_validation_sha256,
      content.fresh_validation_projection_sha256,
    ].map((hash) => hash === null)).size > 1
    || ![null, "succeeded", "failed"].includes(content.terminal_status)
    || receipt.receipt_sha256 !== sha256(canonicalJson(content))
  ) {
    throw new Error("Reviewed apply audit receipt seal or content is invalid.");
  }
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuditAccounting(
    content.audit_mutation_accounting,
  );
  return deepFreeze(cloneJson(receipt));
}

function reviewedPlanBinding(value) {
  const plan = requiredObject(value, "validated reviewed apply plan");
  if (plan.valid !== true) {
    throw new Error("Reviewed apply audit requires a validated reviewed apply plan.");
  }
  const planFileSha256 = requiredSha256(plan.plan_file_sha256, "plan file SHA-256");
  const planSelfSha256 = requiredSha256(plan.plan_sha256, "plan self-seal");
  const selectedSourceId = requiredUuid(plan.selected_source_id, "selected source ID");
  const deferredSourceIds = exactUuidArray(
    plan.deferred_source_ids,
    "deferred source IDs",
  );
  if (
    deferredSourceIds.length !== 8
    || deferredSourceIds.includes(selectedSourceId)
  ) {
    throw new Error("Reviewed apply audit requires one selected and eight deferred sources.");
  }
  if (plan.expected_active_journal_sha256 !== null) {
    throw new Error("Reviewed apply audit requires no active upgrade journal.");
  }
  const planDocument = requiredObject(plan.plan, "reviewed apply plan document");
  const manifest = exactObject(
    planDocument.manifest,
    ["schema_version", "sha256", "source_count"],
    "reviewed apply manifest binding",
  );
  requiredSha256(manifest.sha256, "manifest SHA-256");
  if (manifest.source_count !== 9) {
    throw new Error("Reviewed apply audit manifest binding must contain exactly nine sources.");
  }
  const report = exactObject(
    plan.report_binding,
    reportBindingKeys,
    "reviewed apply dry-run report binding",
  );
  for (const key of ["file_sha256", "manifest_sha256", "stage1_report_sha256"]) {
    requiredSha256(report[key], `dry-run report ${key}`);
  }
  if (report.manifest_sha256 !== manifest.sha256) {
    throw new Error("Reviewed apply audit report and manifest bindings differ.");
  }
  const selected = requiredObject(
    planDocument.selected,
    "reviewed apply selected binding",
  );
  const selectedSource = requiredObject(
    selected.source,
    "reviewed apply selected manifest source",
  );
  const selectedValidation = requiredObject(
    selected.validation,
    "reviewed apply selected validation binding",
  );
  const freshValidationProjectionSha256 = requiredSha256(
    plan.fresh_validation_projection_sha256,
    "fresh validation projection SHA-256",
  );
  if (
    selectedSource.source_id !== selectedSourceId
    || selectedValidation.fresh_projection_sha256
      !== freshValidationProjectionSha256
  ) {
    throw new Error("Reviewed apply selected and fresh-validation bindings differ.");
  }
  const authority = requiredObject(plan.authority, "reviewed apply authority");
  if (
    !sameJson(authority, STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY)
    || authority.worker_run_audit_mode
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_MODE
    || authority.allow_worker_run_supersession !== false
  ) {
    throw new Error("Reviewed apply audit authority mode is invalid.");
  }
  return deepFreeze({
    plan: {
      file_sha256: planFileSha256,
      self_sha256: planSelfSha256,
    },
    dry_run_report: cloneJson(report),
    manifest: cloneJson(manifest),
    scope: {
      selected_source_id: selectedSourceId,
      deferred_source_ids: deferredSourceIds,
    },
    selected: cloneJson(selected),
    fresh_validation_projection_sha256: freshValidationProjectionSha256,
    authority: cloneJson(authority),
  });
}

function assertHistoricalReviewedPlanBinding(value) {
  const binding = exactObject(value, [
    "authority",
    "dry_run_report",
    "fresh_validation_projection_sha256",
    "manifest",
    "plan",
    "scope",
    "selected",
  ], "historical reviewed apply plan binding");
  const plan = exactObject(
    binding.plan,
    ["file_sha256", "self_sha256"],
    "historical reviewed apply plan identity",
  );
  const scope = exactObject(
    binding.scope,
    ["deferred_source_ids", "selected_source_id"],
    "historical reviewed apply plan scope",
  );
  const selected = exactObject(binding.selected, [
    "acquisition",
    "activation",
    "existing_pointer_identity",
    "finalization",
    "local_baseline_identity",
    "r2",
    "recovery_evidence_sha256",
    "result",
    "source",
    "validation",
  ], "historical reviewed apply selected binding");
  const selectedResult = exactObject(selected.result, [
    "evaluated_at",
    "reason_code",
    "result_sha256",
    "schema_version",
    "status",
  ], "historical reviewed apply selected result binding");
  const selectedValidation = exactObject(selected.validation, [
    "capture_validation_sha256",
    "decision",
    "fresh_projection_schema",
    "fresh_projection_sha256",
    "reason",
    "status",
  ], "historical reviewed apply selected validation binding");
  const selectedAcquisition = exactObject(selected.acquisition, [
    "evidence_quote_count",
    "file_sha256",
    "normalized_text_sha256",
    "source_acquisition_id",
    "text_sha256",
  ], "historical reviewed apply selected acquisition binding");
  const selectedActivation = exactObject(selected.activation, [
    "binding_reason",
    "guard_sha256",
  ], "historical reviewed apply selected activation binding");
  const selectedFinalization = exactObject(selected.finalization, [
    "finalized_at",
    "receipt_sha256",
  ], "historical reviewed apply selected finalization binding");
  const localBaselineIdentity = exactObject(selected.local_baseline_identity, [
    "byte_length",
    "sha256",
  ], "historical reviewed apply local baseline identity");
  const existingPointerIdentity = exactObject(selected.existing_pointer_identity, [
    "canonical_sha256",
    "exists",
    "schema_version",
  ], "historical reviewed apply existing pointer identity");
  const selectedR2 = exactObject(selected.r2, [
    "binding_receipt_sha256",
    "bucket",
    "captured_at",
    "immutable_generation",
    "kind",
    "latest_metadata_sha256",
    "pointer_latest_hashes_sha256",
    "pointer_latest_object_keys_sha256",
    "pointer_sha256",
    "previous_pointer_projection_sha256",
    "semantic_text_sha256",
    "verified_roles_sha256",
  ], "historical reviewed apply selected R2 binding");

  requiredObject(selected.source, "historical reviewed apply manifest source");
  requiredUuid(selected.source.source_id, "historical reviewed apply source ID");
  if (
    selectedResult.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA
    || selectedResult.status !== "dry_run_ready"
    || !requiredText(selectedResult.reason_code, "historical result reason")
    || !requiredTimestamp(selectedResult.evaluated_at, "historical result evaluated_at")
    || !sha256Pattern.test(selectedResult.result_sha256)
    || selectedValidation.status !== "evaluated"
    || selectedValidation.decision !== "eligible_unchanged_upgrade"
    || selectedValidation.reason !== selectedResult.reason_code
    || selectedValidation.fresh_projection_schema
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_FRESH_VALIDATION_PROJECTION_SCHEMA
    || selectedValidation.fresh_projection_sha256
      !== binding.fresh_validation_projection_sha256
  ) {
    throw new Error("Historical reviewed apply selected result is invalid.");
  }
  for (const [hash, label] of [
    [selectedValidation.capture_validation_sha256, "capture validation"],
    [selectedValidation.fresh_projection_sha256, "fresh projection"],
    [selectedAcquisition.file_sha256, "acquisition file"],
    [selectedAcquisition.normalized_text_sha256, "acquisition normalized text"],
    [selectedActivation.guard_sha256, "activation guard"],
    [selectedFinalization.receipt_sha256, "finalization receipt"],
    [localBaselineIdentity.sha256, "local baseline"],
    [existingPointerIdentity.canonical_sha256, "existing pointer"],
    [selectedR2.binding_receipt_sha256, "R2 receipt"],
    [selectedR2.pointer_sha256, "R2 pointer"],
    [selectedR2.previous_pointer_projection_sha256, "previous R2 pointer"],
    [selectedR2.latest_metadata_sha256, "R2 metadata"],
    [selectedR2.pointer_latest_object_keys_sha256, "R2 object keys"],
    [selectedR2.pointer_latest_hashes_sha256, "R2 semantic hashes"],
    [selectedR2.verified_roles_sha256, "R2 verified roles"],
    [selectedR2.semantic_text_sha256, "R2 semantic text"],
    [selected.recovery_evidence_sha256, "recovery evidence"],
  ]) requiredSha256(hash, `historical reviewed apply ${label} SHA-256`);
  if (
    selectedAcquisition.text_sha256 !== null
    && !sha256Pattern.test(selectedAcquisition.text_sha256)
  ) {
    throw new Error("Historical reviewed apply acquisition text SHA-256 is invalid.");
  }
  requiredUuid(
    selectedAcquisition.source_acquisition_id,
    "historical reviewed apply acquisition ID",
  );
  if (
    !Number.isSafeInteger(selectedAcquisition.evidence_quote_count)
    || selectedAcquisition.evidence_quote_count <= 0
    || !requiredText(selectedActivation.binding_reason, "historical activation reason")
    || !requiredTimestamp(selectedFinalization.finalized_at, "historical finalized_at")
    || !Number.isSafeInteger(localBaselineIdentity.byte_length)
    || localBaselineIdentity.byte_length <= 0
    || existingPointerIdentity.exists !== true
    || !requiredText(existingPointerIdentity.schema_version, "historical pointer schema")
    || !requiredText(selectedR2.bucket, "historical R2 bucket")
    || !requiredText(selectedR2.captured_at, "historical R2 captured_at")
    || !requiredText(selectedR2.immutable_generation, "historical R2 generation")
    || !requiredText(selectedR2.kind, "historical R2 kind")
  ) {
    throw new Error("Historical reviewed apply selected authority is invalid.");
  }
  requiredTimestamp(selectedR2.captured_at, "historical R2 captured_at");

  const syntheticValidatedPlan = {
    valid: true,
    plan_file_sha256: plan.file_sha256,
    plan_sha256: plan.self_sha256,
    selected_source_id: scope.selected_source_id,
    deferred_source_ids: scope.deferred_source_ids,
    expected_active_journal_sha256: null,
    plan: {
      manifest: binding.manifest,
      selected,
    },
    report_binding: binding.dry_run_report,
    fresh_validation_projection_sha256:
      binding.fresh_validation_projection_sha256,
    authority: binding.authority,
  };
  const checked = reviewedPlanBinding(syntheticValidatedPlan);
  if (binding.manifest.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SCHEMA) {
    throw new Error("Historical reviewed apply manifest schema is invalid.");
  }
  const report = binding.dry_run_report;
  requiredUuid(report.attempt_id, "historical reviewed report attempt ID");
  requiredTimestamp(report.started_at, "historical reviewed report started_at");
  requiredTimestamp(report.finished_at, "historical reviewed report finished_at");
  requiredTimestamp(
    report.stage1_report_generated_at,
    "historical Stage 1 report generated_at",
  );
  if (
    report.report_schema_version !== 2
    || report.stage1_report_schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REPORT_SCHEMA
    || report.worker_run_id !== null
  ) {
    throw new Error("Historical reviewed apply dry-run report binding is invalid.");
  }
  if (!sameJson(binding, checked)) {
    throw new Error("Historical reviewed apply plan binding is not canonical.");
  }
  return checked;
}

function buildFreshCaptureEvidence({ binding, captureResult }) {
  const capture = requiredObject(
    captureResult,
    "reviewed apply exact fresh capture result",
  );
  const result = exactObject(
    cloneJson(capture),
    sourceResultKeys,
    "reviewed apply exact fresh capture result",
  );
  const validation = requiredObject(
    result.capture_validation,
    "reviewed apply fresh capture validation",
  );
  const evidence = requiredObject(
    validation.evidence,
    "reviewed apply fresh capture validation evidence",
  );
  requiredTimestamp(result.evaluated_at, "fresh capture evaluated_at");
  if (
    result.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA
    || result.mode !== "dry_run"
    || result.source_id !== binding.scope.selected_source_id
    || result.manifest_sha256 !== binding.manifest.sha256
    || result.source_eligible !== true
    || result.status !== "dry_run_ready"
    || validation.status !== "evaluated"
    || validation.decision !== "eligible_unchanged_upgrade"
    || validation.reason !== result.reason_code
    || evidence.source_id !== binding.scope.selected_source_id
    || !sameJson(
      evidence.local_baseline_identity,
      binding.selected.local_baseline_identity,
    )
    || !sameJson(
      evidence.existing_pointer_identity,
      binding.selected.existing_pointer_identity,
    )
    || !sameJson(result.pointer_journal, { status: "would_commit" })
    || !sameJson(result.visual_review_candidate, { status: "not_planned" })
    || !sameJson(result.quarantine, { status: "not_planned" })
    || !sameJson(
      result.mutation_counts,
      zeroStage1EvidenceSchemaUpgradeMutationCounts(),
    )
  ) {
    throw new Error(
      "Reviewed apply audit fresh capture is not the exact selected dry-run-ready unchanged upgrade.",
    );
  }
  const freshValidationProjectionSha256 =
    stage1EvidenceSchemaUpgradeFreshValidationSha256(result);
  if (
    freshValidationProjectionSha256
      !== binding.fresh_validation_projection_sha256
  ) {
    throw new Error(
      "Reviewed apply audit fresh capture differs from the reviewed validation projection.",
    );
  }
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_FRESH_CAPTURE_SCHEMA,
    capture_result: cloneJson(result),
    capture_result_sha256: sha256(canonicalJson(result)),
    capture_validation_sha256: sha256(canonicalJson(validation)),
    fresh_validation_projection_sha256: freshValidationProjectionSha256,
  };
  return deepFreeze({
    ...content,
    fresh_capture_sha256: sha256(canonicalJson(content)),
  });
}

function assertFreshCaptureEvidence(value, binding) {
  const freshCapture = exactObject(value, [
    "capture_result",
    "capture_result_sha256",
    "capture_validation_sha256",
    "fresh_capture_sha256",
    "fresh_validation_projection_sha256",
    "schema_version",
  ], "reviewed apply audit fresh capture evidence");
  const expected = buildFreshCaptureEvidence({
    binding,
    captureResult: freshCapture.capture_result,
  });
  if (!sameJson(freshCapture, expected)) {
    throw new Error("Reviewed apply audit fresh capture evidence seal is invalid.");
  }
  return freshCapture;
}

function assertSourceAuthority(value) {
  const authority = assertStage1EvidenceSchemaUpgradePrecommitSourceAuthority(value);
  if (
    authority.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_SOURCE_AUTHORITY_SCHEMA
  ) {
    throw new Error("Reviewed apply source authority schema is invalid.");
  }
  assertSourceAuthorityProjection(authority.projection);
  return authority;
}

function assertSourceAuthorityProjection(value) {
  const projection = exactObject(
    value,
    STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_SOURCE_AUTHORITY_PROJECTION_KEYS,
    "reviewed apply source authority projection",
  );
  const sourceId = requiredUuid(projection.id, "source authority projection id");
  const awardId = requiredUuid(
    projection.shared_award_id,
    "source authority projection shared_award_id",
  );
  const award = exactObject(
    projection.shared_awards,
    ["id", "name", "official_homepage", "status"],
    "source authority projection award",
  );
  if (
    requiredUuid(award.id, "source authority projection award id") !== awardId
    || !requiredText(projection.url, "source authority projection url")
    || !requiredText(projection.admin_review_status, "source authority admin status")
    || !Number.isSafeInteger(projection.consecutive_failures)
    || projection.consecutive_failures < 0
    || (projection.last_hash !== null && typeof projection.last_hash !== "string")
    || (projection.last_error !== null && typeof projection.last_error !== "string")
  ) {
    throw new Error("Reviewed apply source authority projection identity is invalid.");
  }
  for (const [key, required] of [
    ["created_at", true],
    ["updated_at", true],
    ["last_checked_at", false],
    ["next_check_at", false],
    ["page_metadata_generated_at", false],
    ["admin_reviewed_at", false],
  ]) {
    if (projection[key] === null && !required) continue;
    requiredTimestamp(projection[key], `source authority projection ${key}`);
  }
  if (sourceId !== projection.id) {
    throw new Error("Reviewed apply source authority projection source ID changed.");
  }
  return projection;
}

function assertAuthorityReceiptForBinding(value, binding) {
  const receipt = assertStage1EvidenceSchemaUpgradeReviewedApplyAuthorityReceipt(value);
  if (
    receipt.source_id !== binding.scope.selected_source_id
    || receipt.active_journal_sha256 !== null
    || !sameJson(
      receipt.local_baseline_identity,
      binding.selected.local_baseline_identity,
    )
    || !sameJson(
      receipt.existing_pointer_identity,
      binding.selected.existing_pointer_identity,
    )
    || receipt.r2_binding_receipt_sha256
      !== binding.selected.r2?.binding_receipt_sha256
  ) {
    throw new Error("Reviewed apply audit authority receipt differs from plan-bound authority.");
  }
  return receipt;
}

function buildRunningRow({
  binding,
  executionNonce,
  freshCapture,
  authorityReceipt,
  authorityReceiptSha256,
  startedAt,
}) {
  const runId = stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(
    binding.plan.file_sha256,
  );
  const metadata = sealMetadata({
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_METADATA_SCHEMA,
    kind: "stage1_evidence_schema_upgrade_reviewed_exact_one_apply",
    audit_mode: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_MODE,
    execution_nonce: executionNonce,
    fresh_capture: cloneJson(freshCapture),
    authority_receipt: cloneJson(authorityReceipt),
    authority_receipt_sha256: authorityReceiptSha256,
    binding: cloneJson(binding),
    authority: cloneJson(binding.authority),
    phase: "running",
    started_at: startedAt,
    terminal: null,
  });
  return {
    id: runId,
    worker_name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME,
    status: "running",
    ai_provider: null,
    checked_count: 0,
    changed_count: 0,
    unchanged_count: 0,
    initial_count: 0,
    discovered_count: 0,
    failed_count: 0,
    error: null,
    started_at: startedAt,
    finished_at: null,
    metadata,
  };
}

function terminalPatch({ status, metadata, finishedAt }) {
  return deepFreeze({
    status,
    checked_count: 1,
    changed_count: status === "succeeded" ? 1 : 0,
    unchanged_count: 0,
    initial_count: 0,
    discovered_count: 0,
    failed_count: status === "failed" ? 1 : 0,
    error: status === "failed" ? metadata.terminal.failure.error_summary : null,
    finished_at: finishedAt,
    metadata,
  });
}

function buildTerminal({ terminal, completionAuthority, selectedSourceId, finishedAt }) {
  const value = requiredObject(terminal, "reviewed apply audit terminal input");
  const checkedCompletionAuthority =
    assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
      completionAuthority,
      { selectedSourceId, finishedAt },
    );
  let content;
  if (value.status === "succeeded") {
    exactObject(value, ["commit_receipt", "selected_result", "status"],
      "successful reviewed apply audit terminal input");
    content = {
      schema_version:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_TERMINAL_SCHEMA,
      status: "succeeded",
      finished_at: finishedAt,
      completion_authority: cloneJson(checkedCompletionAuthority),
      selected_result_commit_identity: selectedResultCommitIdentity({
        selectedSourceId,
        selectedResult: value.selected_result,
        commitReceipt: value.commit_receipt,
      }),
      failure: null,
    };
  } else if (value.status === "failed") {
    exactObject(value, ["error_code", "error_message", "status"],
      "failed reviewed apply audit terminal input");
    const errorCode = requiredText(value.error_code, "audit failure code");
    const errorMessage = requiredText(value.error_message, "audit failure message");
    content = {
      schema_version:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_TERMINAL_SCHEMA,
      status: "failed",
      finished_at: finishedAt,
      completion_authority: cloneJson(checkedCompletionAuthority),
      selected_result_commit_identity: null,
      failure: {
        error_code: errorCode.slice(0, 200),
        error_summary: errorMessage.slice(0, 1000),
        error_message_sha256: sha256(errorMessage),
      },
    };
  } else {
    throw new Error("Reviewed apply audit terminal status must be succeeded or failed.");
  }
  return deepFreeze({
    ...content,
    terminal_sha256: sha256(canonicalJson(content)),
  });
}

function selectedResultCommitIdentity({
  selectedSourceId,
  selectedResult,
  commitReceipt,
}) {
  const result = requiredObject(selectedResult, "selected apply result");
  const receipt = requiredObject(commitReceipt, "selected commit receipt");
  if (
    requiredUuid(result.source_id, "selected result source ID") !== selectedSourceId
    || result.status !== "upgraded"
    || !cleanText(result.schema_version)
  ) {
    throw new Error("Successful audit terminal selected result is not the exact upgraded source.");
  }
  const pointerJournal = exactObject(
    result.pointer_journal,
    ["receipt", "status"],
    "selected result pointer journal",
  );
  if (pointerJournal.status !== "upgraded" || !sameJson(pointerJournal.receipt, receipt)) {
    throw new Error("Successful audit terminal result does not contain the exact commit receipt.");
  }
  if (
    receipt.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA
    || requiredUuid(receipt.source_id, "commit receipt source ID") !== selectedSourceId
    || receipt.status !== "upgraded"
    || receipt.operation !== "pointer_commit"
    || receipt.creates_api_charge !== false
    || receipt.journal_archived !== true
  ) {
    throw new Error("Successful audit terminal commit receipt is invalid.");
  }
  const accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    receipt.mutation_accounting,
    { operation: "pointer_commit" },
  );
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RESULT_IDENTITY_SCHEMA,
    source_id: selectedSourceId,
    selected_result_schema_version: result.schema_version,
    selected_result_status: result.status,
    selected_result_sha256: sha256(canonicalJson(result)),
    commit_receipt_schema_version: receipt.schema_version,
    commit_receipt_status: receipt.status,
    commit_receipt_sha256: sha256(canonicalJson(receipt)),
    commit_journal_sha256: requiredSha256(
      receipt.journal_sha256,
      "commit receipt journal SHA-256",
    ),
    commit_mutation_accounting_sha256: accounting.accounting_sha256,
  };
  return deepFreeze({
    ...content,
    identity_sha256: sha256(canonicalJson(content)),
  });
}

function inspectAuditRow(row, expectedBinding) {
  if (row === null || row === undefined) return missingInspection();
  try {
    const value = exactObject(
      row,
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_ROW_COLUMNS,
      "reviewed apply audit row",
    );
    const expectedRunId = stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(
      expectedBinding.plan.file_sha256,
    );
    if (
      value.id !== expectedRunId
      || value.worker_name
        !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME
      || value.ai_provider !== null
    ) {
      throw new Error("Reviewed apply audit row identity differs.");
    }
    const metadata = assertMetadata(value.metadata, expectedBinding);
    const startedAt = requiredTimestamp(value.started_at, "audit row started_at");
    if (Date.parse(startedAt) !== Date.parse(metadata.started_at)) {
      throw new Error("Reviewed apply audit row start time differs from metadata.");
    }
    assertBaseCounts(value);
    if (value.status === "running") {
      if (
        metadata.phase !== "running"
        || metadata.terminal !== null
        || value.checked_count !== 0
        || value.changed_count !== 0
        || value.failed_count !== 0
        || value.error !== null
        || value.finished_at !== null
      ) {
        throw new Error("Reviewed apply audit running row is invalid.");
      }
      return inspection("running", value, metadata, null);
    }
    if (!['succeeded', 'failed'].includes(value.status)) {
      throw new Error("Reviewed apply audit row status is invalid.");
    }
    if (metadata.phase !== "terminal") {
      throw new Error("Reviewed apply audit terminal row metadata phase is invalid.");
    }
    const terminal = assertTerminal(metadata.terminal);
    const finishedAt = requiredTimestamp(value.finished_at, "audit row finished_at");
    assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
      terminal.completion_authority,
      {
        selectedSourceId: expectedBinding.scope.selected_source_id,
        finishedAt,
      },
    );
    if (
      terminal.status !== value.status
      || Date.parse(finishedAt) !== Date.parse(terminal.finished_at)
      || Date.parse(finishedAt) < Date.parse(startedAt)
      || value.checked_count !== 1
    ) {
      throw new Error("Reviewed apply audit terminal row differs from metadata.");
    }
    if (value.status === "succeeded") {
      if (
        value.changed_count !== 1
        || value.failed_count !== 0
        || value.error !== null
        || terminal.failure !== null
      ) {
        throw new Error("Reviewed apply audit succeeded row is invalid.");
      }
      const resultIdentity = assertResultCommitIdentity(
        terminal.selected_result_commit_identity,
      );
      if (resultIdentity.source_id !== expectedBinding.scope.selected_source_id) {
        throw new Error("Reviewed apply audit terminal source differs from the selected source.");
      }
      return inspection("terminal_succeeded", value, metadata, terminal);
    }
    if (
      value.changed_count !== 0
      || value.failed_count !== 1
      || value.error !== terminal.failure?.error_summary
      || terminal.selected_result_commit_identity !== null
    ) {
      throw new Error("Reviewed apply audit failed row is invalid.");
    }
    assertFailure(terminal.failure);
    return inspection("terminal_failed", value, metadata, terminal);
  } catch {
    return mismatchInspection(row);
  }
}

function assertMetadata(value, expectedBinding) {
  const metadata = exactObject(value, metadataKeys, "reviewed apply audit metadata");
  const content = metadataContent(metadata);
  if (
    content.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_METADATA_SCHEMA
    || content.kind !== "stage1_evidence_schema_upgrade_reviewed_exact_one_apply"
    || content.audit_mode !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_MODE
    || !uuidV4Pattern.test(content.execution_nonce)
    || !sameJson(content.binding, expectedBinding)
    || !sameJson(content.authority, expectedBinding.authority)
    || !["running", "terminal"].includes(content.phase)
    || metadata.metadata_sha256 !== sha256(canonicalJson(content))
  ) {
    throw new Error("Reviewed apply audit metadata seal or binding is invalid.");
  }
  assertFreshCaptureEvidence(content.fresh_capture, expectedBinding);
  const authorityReceipt = assertAuthorityReceiptForBinding(
    content.authority_receipt,
    expectedBinding,
  );
  if (
    requiredSha256(
      content.authority_receipt_sha256,
      "audit metadata authority receipt SHA-256",
    ) !== sha256(canonicalJson(authorityReceipt))
  ) {
    throw new Error("Reviewed apply audit authority receipt seal is invalid.");
  }
  requiredTimestamp(content.started_at, "audit metadata started_at");
  return metadata;
}

function assertTerminal(value) {
  const terminal = exactObject(value, [
    "completion_authority",
    "failure",
    "finished_at",
    "schema_version",
    "selected_result_commit_identity",
    "status",
    "terminal_sha256",
  ], "reviewed apply audit terminal metadata");
  const content = cloneJson(terminal);
  delete content.terminal_sha256;
  if (
    content.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_TERMINAL_SCHEMA
    || !["succeeded", "failed"].includes(content.status)
    || terminal.terminal_sha256 !== sha256(canonicalJson(content))
  ) {
    throw new Error("Reviewed apply audit terminal seal or content is invalid.");
  }
  requiredTimestamp(content.finished_at, "audit terminal finished_at");
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuditCompletionAuthority(
    content.completion_authority,
    { finishedAt: content.finished_at },
  );
  return terminal;
}

function assertResultCommitIdentity(value) {
  const identity = exactObject(value, [
    "commit_journal_sha256",
    "commit_mutation_accounting_sha256",
    "commit_receipt_schema_version",
    "commit_receipt_sha256",
    "commit_receipt_status",
    "identity_sha256",
    "schema_version",
    "selected_result_schema_version",
    "selected_result_sha256",
    "selected_result_status",
    "source_id",
  ], "reviewed apply selected result/commit identity");
  const content = cloneJson(identity);
  delete content.identity_sha256;
  if (
    content.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RESULT_IDENTITY_SCHEMA
    || !uuidPattern.test(content.source_id)
    || content.selected_result_schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA
    || content.selected_result_status !== "upgraded"
    || content.commit_receipt_schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA
    || content.commit_receipt_status !== "upgraded"
    || [
      content.selected_result_sha256,
      content.commit_receipt_sha256,
      content.commit_journal_sha256,
      content.commit_mutation_accounting_sha256,
    ].some((hash) => !sha256Pattern.test(hash))
    || identity.identity_sha256 !== sha256(canonicalJson(content))
  ) {
    throw new Error("Reviewed apply selected result/commit identity is invalid.");
  }
  return identity;
}

function assertFailure(value) {
  const failure = exactObject(value, [
    "error_code",
    "error_message_sha256",
    "error_summary",
  ], "reviewed apply audit failure");
  if (
    !cleanText(failure.error_code)
    || !cleanText(failure.error_summary)
    || !sha256Pattern.test(failure.error_message_sha256)
  ) {
    throw new Error("Reviewed apply audit failure identity is invalid.");
  }
  return failure;
}

function failureIdentitySha256(value) {
  return sha256(canonicalJson(assertFailure(value)));
}

function buildAuditReceipt({
  action,
  disposition,
  businessExecutionAuthorized,
  replay,
  binding,
  requestedExecutionNonce,
  inspection,
  lowerBoundCounts,
  unknownWriteCategories,
  responseLossPossible,
}) {
  const accounting = sealAuditAccounting({
    action,
    disposition,
    lowerBoundCounts,
    unknownWriteCategories,
    responseLossPossible,
    observedRowStatus: inspection.kind,
  });
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RECEIPT_SCHEMA,
    action,
    disposition,
    business_execution_authorized: businessExecutionAuthorized,
    replay,
    run_id: stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(
      binding.plan.file_sha256,
    ),
    worker_name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME,
    requested_execution_nonce: requestedExecutionNonce,
    active_execution_nonce: inspection.execution_nonce,
    plan_file_sha256: binding.plan.file_sha256,
    plan_sha256: binding.plan.self_sha256,
    selected_source_id: binding.scope.selected_source_id,
    authority_receipt_sha256: inspection.authority_receipt_sha256,
    fresh_capture_evidence_sha256:
      inspection.fresh_capture?.fresh_capture_sha256 || null,
    fresh_capture_result_sha256:
      inspection.fresh_capture?.capture_result_sha256 || null,
    fresh_capture_validation_sha256:
      inspection.fresh_capture?.capture_validation_sha256 || null,
    fresh_validation_projection_sha256:
      inspection.fresh_capture?.fresh_validation_projection_sha256 || null,
    terminal_status: inspection.terminal?.status || null,
    terminal_identity_sha256:
      inspection.terminal?.selected_result_commit_identity?.identity_sha256 || null,
    terminal_failure_sha256:
      inspection.terminal?.failure
        ? failureIdentitySha256(inspection.terminal.failure)
        : null,
    terminal_completion_authority_mode:
      inspection.terminal?.completion_authority?.mode || null,
    terminal_completion_authority_sha256:
      inspection.terminal?.completion_authority?.completion_authority_sha256 || null,
    observed_row_sha256: inspection.row_sha256,
    audit_mutation_accounting: accounting,
  };
  return deepFreeze({
    ...content,
    receipt_sha256: sha256(canonicalJson(content)),
  });
}

function sealAuditAccounting({
  action,
  disposition,
  lowerBoundCounts,
  unknownWriteCategories,
  responseLossPossible,
  observedRowStatus,
}) {
  const counts = exactObject(
    lowerBoundCounts,
    auditCountKeys,
    "reviewed apply audit lower-bound counts",
  );
  const unknown = [...new Set(unknownWriteCategories)].sort();
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_ACCOUNTING_SCHEMA,
    count_scope: "local_worker_runs_writes_in_this_orchestration_invocation",
    count_semantics: "confirmed_lower_bounds",
    exact: unknown.length === 0,
    lower_bound_counts: cloneJson(counts),
    unknown_write_categories: unknown,
    evidence: {
      action,
      disposition,
      response_loss_possible: responseLossPossible,
      observed_row_status: observedRowStatus,
    },
  };
  return deepFreeze({
    ...content,
    accounting_sha256: sha256(canonicalJson(content)),
  });
}

function inspection(kind, row, metadata, terminal) {
  return {
    kind,
    row,
    execution_nonce: metadata.execution_nonce,
    started_at: metadata.started_at,
    fresh_capture: metadata.fresh_capture,
    authority_receipt: metadata.authority_receipt,
    authority_receipt_sha256: metadata.authority_receipt_sha256,
    terminal,
    row_sha256: sha256(canonicalJson(row)),
  };
}

function missingInspection() {
  return {
    kind: "missing",
    row: null,
    execution_nonce: null,
    started_at: null,
    fresh_capture: null,
    authority_receipt: null,
    authority_receipt_sha256: null,
    terminal: null,
    row_sha256: null,
  };
}

function mismatchInspection(row) {
  return {
    kind: "mismatch",
    row: null,
    execution_nonce: null,
    started_at: null,
    fresh_capture: null,
    authority_receipt: null,
    authority_receipt_sha256: null,
    terminal: null,
    row_sha256: jsonSha256OrNull(row),
  };
}

function isSameRunningExecution(value, {
  nonce,
  startedAt,
  freshCaptureSha256,
  authorityReceiptSha256,
}) {
  return value.kind === "running"
    && value.execution_nonce === nonce
    && sameTimestampInstant(value.started_at, startedAt)
    && value.fresh_capture?.fresh_capture_sha256 === freshCaptureSha256
    && value.authority_receipt_sha256 === authorityReceiptSha256;
}

function isDesiredTerminalExecution(value, { nonce, terminal, finishedAt }) {
  return value.execution_nonce === nonce
    && value.terminal?.status === terminal.status
    && sameTimestampInstant(value.terminal?.finished_at, finishedAt)
    && sameJson(value.terminal, terminal);
}

function sameTimestampInstant(left, right) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

function uncertainInsertCategories({ inspection, nonce, insertAmbiguous }) {
  if (!insertAmbiguous) return [];
  if (
    (inspection.kind === "running" || inspection.kind.startsWith("terminal_"))
    && inspection.execution_nonce !== nonce
  ) {
    return [];
  }
  return ["local_worker_run_inserts"];
}

async function safeRead(readRun, runId) {
  try {
    return { row: await readRun({ run_id: runId }) };
  } catch {
    return { row: null };
  }
}

function assertBaseCounts(row) {
  for (const key of [
    "checked_count",
    "changed_count",
    "unchanged_count",
    "initial_count",
    "discovered_count",
    "failed_count",
  ]) {
    if (!Number.isSafeInteger(row[key]) || row[key] < 0) {
      throw new Error("Reviewed apply audit row count is invalid.");
    }
  }
  if (
    row.unchanged_count !== 0
    || row.initial_count !== 0
    || row.discovered_count !== 0
  ) {
    throw new Error("Reviewed apply audit row contains out-of-scope counts.");
  }
}

function sealMetadata(content) {
  const basis = metadataContent(content);
  return deepFreeze({
    ...basis,
    metadata_sha256: sha256(canonicalJson(basis)),
  });
}

function metadataContent(value) {
  const content = cloneJson(value);
  delete content.metadata_sha256;
  return content;
}

function zeroAuditCounts() {
  return {
    local_worker_run_inserts: 0,
    local_worker_run_terminal_updates: 0,
  };
}

function requiredExecutionNonce(value) {
  const nonce = cleanText(value);
  if (!uuidV4Pattern.test(nonce)) {
    throw new Error("Reviewed apply execution_nonce must be a lowercase UUIDv4 supplied by the caller.");
  }
  return nonce;
}

function exactUuidArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Reviewed apply audit ${label} must be an array.`);
  const ids = value.map((item) => requiredUuid(item, label));
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Reviewed apply audit ${label} must be unique.`);
  }
  return ids;
}

function exactObject(value, keys, label) {
  const object = requiredObject(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (!sameJson(actual, expected)) {
    throw new Error(`${label} must contain exactly: ${keys.join(", ")}.`);
  }
  return object;
}

function requiredObject(value, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requiredFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`Reviewed apply audit ${label} interface is required.`);
  }
  return value;
}

function requiredSha256(value, label) {
  const hash = cleanText(value);
  if (!sha256Pattern.test(hash)) {
    throw new Error(`Reviewed apply audit ${label} must be an exact lowercase SHA-256.`);
  }
  return hash;
}

function requiredUuid(value, label) {
  const uuid = cleanText(value);
  if (!uuidPattern.test(uuid)) {
    throw new Error(`Reviewed apply audit ${label} must be a lowercase UUID.`);
  }
  return uuid;
}

function requiredTimestamp(value, label) {
  const timestamp = cleanText(value);
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`Reviewed apply audit ${label} must be an ISO timestamp.`);
  }
  return timestamp;
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`Reviewed apply audit ${label} is required.`);
  return text;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function jsonSha256OrNull(value) {
  try {
    return sha256(canonicalJson(value));
  } catch {
    return null;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
