import { createHash } from "node:crypto";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
  validateStage1EvidenceSchemaUpgradeManifest,
} from "./stage1-evidence-schema-upgrade.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT,
  assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting,
  assertStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence,
} from "./stage1-evidence-schema-upgrade-commit.mjs";
import {
  assertStage1EvidenceSchemaUpgradeMutationAccounting,
  sealStage1EvidenceSchemaUpgradeMutationAccounting,
  zeroStage1EvidenceSchemaUpgradeMutationCounts,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_DEFERRED_COUNT,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_MAX_LIFETIME_MS,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_SCHEMA,
  stage1EvidenceSchemaUpgradeFreshValidationSha256,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";
import {
  assertStage1EvidenceSchemaUpgradePrecommitSourceAuthority,
  buildStage1EvidenceSchemaUpgradeReviewedOperationBinding,
  stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RESULT_IDENTITY_SCHEMA,
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuthorityReceipt,
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuditAccounting,
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuditReceipt,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority,
  stage1EvidenceSchemaUpgradeReviewedApplyFreshCaptureEvidence,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs";
import {
  planLatestOnlyVisualSnapshotPointerReconciliation,
} from "./visual-snapshot-latest-only-reconciliation.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_EXECUTION_REPORT_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-exact-one-apply-report.v1";

const EXECUTION_AUDIT_ACCOUNTING_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-apply-execution-audit-accounting.v1";

const EXECUTION_MODE = "reviewed_exact_one_apply";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const REQUIRED_INTERFACE_NAMES = Object.freeze([
  "assertPostCaptureAuthority",
  "assertPreCaptureAuthority",
  "captureDryRun",
  "commitUnchangedUpgrade",
  "finishAudit",
  "startAudit",
]);

const ALLOWED_INTERFACE_NAMES = new Set([
  ...REQUIRED_INTERFACE_NAMES,
  "revalidatePlan",
]);

const SOURCE_RESULT_KEYS = Object.freeze([
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

const COMMIT_RECEIPT_KEYS = Object.freeze([
  "authoritative_baseline_sha256",
  "authoritative_baseline_state",
  "authoritative_pointer_sha256",
  "authoritative_pointer_state",
  "cas",
  "cleanup_debt",
  "cleanup_delete_performed",
  "context",
  "creates_api_charge",
  "journal_archived",
  "journal_phase",
  "journal_sha256",
  "mutation_accounting",
  "mutation_count_scope",
  "mutation_counts",
  "operation",
  "outcome",
  "schema_version",
  "source_health",
  "source_id",
  "status",
  "transaction_id",
]);

const AUDIT_COUNT_KEYS = Object.freeze([
  "local_worker_run_inserts",
  "local_worker_run_terminal_updates",
]);

/**
 * Executes exactly one already-reviewed, unchanged Stage 1 evidence upgrade.
 *
 * This function deliberately owns no database, R2, filesystem, browser, or
 * audit implementation. Its complete mutable surface is one commit callback
 * plus the dedicated audit insert/update callbacks. All other callbacks must
 * be read-only assertions or the representative dry-run capture.
 */
export async function runStage1EvidenceSchemaUpgradeReviewedApplyExecution({
  source,
  manifest,
  validatedPlan,
  executionNonce,
  interfaces = {},
  now = () => new Date().toISOString(),
} = {}) {
  const context = validateExecutionSelection({
    source,
    manifest,
    validatedPlan,
    executionNonce,
  });
  const io = validateInterfaces(interfaces);
  const clock = executionClock(now);
  const startedAt = clock.read();
  const zeroBusinessAccounting = zeroBusinessMutationAccounting();
  const authorityRequest = authorityAssertionRequest(context);
  let captureResult = null;
  let preAuthorityReceipt = null;
  let postAuthorityReceipt = null;

  try {
    preAuthorityReceipt = normalizeOptionalReadOnlyReceipt(
      await io.assertPreCaptureAuthority({
        ...authorityRequest,
        phase: "pre_capture",
      }),
      "pre-capture authority assertion",
    );
    assertAuthoritySourceProjection(preAuthorityReceipt, context, source);
  } catch (error) {
    return buildReport({
      context,
      startedAt,
      finishedAt: clock.read(),
      status: "selected_blocked",
      reasonCode: errorCode(error, "pre_capture_authority_failed"),
      error,
      captureResult,
      preAuthorityReceipt,
      postAuthorityReceipt,
      businessAccounting: zeroBusinessAccounting,
      auditAccounting: auditAccounting(),
      auditState: "not_started",
      commitDetail: null,
    });
  }

  try {
    captureResult = await io.captureDryRun(deepFreeze({
      mode: "dry_run",
      source: cloneJson(source),
      manifest: cloneJson(context.manifest),
      manifest_source: cloneJson(context.manifestSource),
      selected_source_id: context.sourceId,
      plan_sha256: context.planSha256,
      expected_active_journal_sha256: null,
      authority: cloneJson(context.authority),
    }));
    assertFreshReadyResult(captureResult, context);
  } catch (error) {
    return buildReport({
      context,
      startedAt,
      finishedAt: clock.read(),
      status: "selected_blocked",
      reasonCode: errorCode(error, "fresh_validation_drift"),
      error,
      captureResult,
      preAuthorityReceipt,
      postAuthorityReceipt,
      businessAccounting: zeroBusinessAccounting,
      auditAccounting: auditAccounting(),
      auditState: "not_started",
      commitDetail: null,
    });
  }

  try {
    postAuthorityReceipt = normalizeOptionalReadOnlyReceipt(
      await io.assertPostCaptureAuthority({
        ...authorityRequest,
        phase: "post_capture",
        capture_result: cloneJson(captureResult),
        capture_validation: cloneJson(captureResult.capture_validation),
      }),
      "post-capture authority assertion",
    );
    assertAuthoritySourceProjection(postAuthorityReceipt, context, source);
  } catch (error) {
    return buildReport({
      context,
      startedAt,
      finishedAt: clock.read(),
      status: "selected_blocked",
      reasonCode: errorCode(error, "post_capture_authority_failed"),
      error,
      captureResult,
      preAuthorityReceipt,
      postAuthorityReceipt,
      businessAccounting: zeroBusinessAccounting,
      auditAccounting: auditAccounting(),
      auditState: "not_started",
      commitDetail: null,
    });
  }

  let revalidatedAt;
  try {
    revalidatedAt = clock.read();
    if (io.revalidatePlan) {
      const revalidatedPlan = await io.revalidatePlan(deepFreeze({
        validated_plan: cloneJson(context.validatedPlan),
        manifest: cloneJson(context.manifest),
        selected_source_id: context.sourceId,
        now: revalidatedAt,
      }));
      assertSameValidatedPlan(revalidatedPlan, context.validatedPlan);
    }
    assertPlanReviewWindow(context.validatedPlan, revalidatedAt);
  } catch (error) {
    return buildReport({
      context,
      startedAt,
      finishedAt: clock.read(),
      status: "selected_blocked",
      reasonCode: errorCode(error, "reviewed_apply_plan_revalidation_failed"),
      error,
      captureResult,
      preAuthorityReceipt,
      postAuthorityReceipt,
      businessAccounting: zeroBusinessAccounting,
      auditAccounting: auditAccounting(),
      auditState: "not_started",
      commitDetail: null,
    });
  }

  let startReceiptRaw;
  let startReceipt;
  try {
    startReceiptRaw = await io.startAudit(deepFreeze({
      reviewedApplyPlan: cloneJson(context.validatedPlan),
      executionNonce: context.executionNonce,
      startedAt: revalidatedAt,
      captureResult: cloneJson(captureResult),
      authorityReceipt: cloneJson(postAuthorityReceipt),
    }));
    startReceipt = normalizeStartAuditReceipt(
      startReceiptRaw,
      context,
      captureResult,
      postAuthorityReceipt,
    );
  } catch (error) {
    const failedStartAccounting = auditAccountingFromInvalidReceipt(
      startReceiptRaw,
      "local_worker_run_inserts",
    );
    return buildReport({
      context,
      startedAt,
      finishedAt: clock.read(),
      status: "selected_recovery_required",
      reasonCode: errorCode(error, "audit_insert_response_unknown"),
      error,
      captureResult,
      preAuthorityReceipt,
      postAuthorityReceipt,
      businessAccounting: zeroBusinessAccounting,
      auditAccounting: failedStartAccounting,
      auditState: "insert_response_unknown",
      commitDetail: null,
    });
  }

  if (startReceipt.priorSuccess) {
    return buildReport({
      context,
      startedAt,
      finishedAt: clock.read(),
      status: "selected_blocked",
      reasonCode: "prior_success_detected_after_capture_replay_refused",
      error: new Error(
        "A prior success was discovered only after the mandatory fresh capture; this executor refuses to claim a no-capture idempotent completion.",
      ),
      captureResult,
      preAuthorityReceipt,
      postAuthorityReceipt,
      businessAccounting: zeroBusinessAccounting,
      auditAccounting: combineAuditAccounting(startReceipt.accounting),
      auditState: "prior_success_detected",
      commitDetail: null,
      auditStartReceipt: startReceipt.receipt,
    });
  }

  if (!startReceipt.businessExecutionAuthorized) {
    const auditUncertain = startReceipt.accounting.exact !== true;
    return buildReport({
      context,
      startedAt,
      finishedAt: clock.read(),
      status: auditUncertain ? "selected_recovery_required" : "selected_blocked",
      reasonCode: "reviewed_apply_audit_not_started",
      error: new Error("The dedicated exact-one audit row was not started."),
      captureResult,
      preAuthorityReceipt,
      postAuthorityReceipt,
      businessAccounting: zeroBusinessAccounting,
      auditAccounting: combineAuditAccounting(startReceipt.accounting),
      auditState: startReceipt.receipt.disposition,
      commitDetail: null,
      auditStartReceipt: startReceipt.receipt,
    });
  }

  let preCommitAuthorityReceipt = null;
  let preCommitValidationError = null;
  try {
    const preCommitRevalidationAt = clock.read();
    if (io.revalidatePlan) {
      const revalidatedPlan = await io.revalidatePlan(deepFreeze({
        validated_plan: cloneJson(context.validatedPlan),
        manifest: cloneJson(context.manifest),
        selected_source_id: context.sourceId,
        now: preCommitRevalidationAt,
      }));
      assertSameValidatedPlan(revalidatedPlan, context.validatedPlan);
    }
    assertPlanReviewWindow(context.validatedPlan, preCommitRevalidationAt);
    preCommitAuthorityReceipt = normalizeOptionalReadOnlyReceipt(
      await io.assertPostCaptureAuthority({
        ...authorityRequest,
        phase: "pre_commit",
        capture_result: cloneJson(captureResult),
        capture_validation: cloneJson(captureResult.capture_validation),
      }),
      "pre-commit authority assertion",
    );
    assertAuthoritySourceProjection(preCommitAuthorityReceipt, context, source);
    if (
      !sameJson(preCommitAuthorityReceipt, preAuthorityReceipt)
      || !sameJson(preCommitAuthorityReceipt, postAuthorityReceipt)
    ) {
      throw codeError(
        "reviewed_authority_changed_before_commit",
        "The final read-only authority proof differs from the prior reviewed authority proofs.",
      );
    }
    if (
      stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256(
        preCommitAuthorityReceipt,
      ) !== startReceipt.receipt.authority_receipt_sha256
    ) {
      throw codeError(
        "reviewed_audit_authority_binding_changed_before_commit",
        "The final authority proof differs from the exact authority receipt persisted by audit start.",
      );
    }
    assertPlanReviewWindow(context.validatedPlan, clock.read());
  } catch (error) {
    preCommitValidationError = error;
  }

  let businessAccounting = zeroBusinessAccounting;
  let commitDetail;
  let selectedStatus;
  let reasonCode;
  let commitRaw = null;
  let commitError = null;
  let failedAuditTerminalPermitted = false;

  if (preCommitValidationError) {
    commitError = preCommitValidationError;
    selectedStatus = "selected_blocked";
    reasonCode = errorCode(
      preCommitValidationError,
      "pre_commit_authority_failed",
    );
    failedAuditTerminalPermitted = true;
    commitDetail = Object.freeze({
      status: "not_started",
      result_sha256: null,
      error: errorSummary(preCommitValidationError),
      recovery_evidence: null,
    });
  } else try {
    commitRaw = await io.commitUnchangedUpgrade(commitRequest({
      context,
      source,
      captureResult,
      auditStartReceipt: startReceipt.receipt,
      persistedAuthorityReceipt: postAuthorityReceipt,
    }));
    const normalized = normalizeCommitResult(commitRaw, context);
    businessAccounting = normalized.accounting;
    commitDetail = normalized.detail;
    if (normalized.status === "upgraded") {
      selectedStatus = "selected_completed";
      reasonCode = "reviewed_unchanged_upgrade_committed";
    } else if (normalized.status === "recovery_required") {
      selectedStatus = "selected_recovery_required";
      reasonCode = "reviewed_unchanged_upgrade_recovery_required";
    } else {
      selectedStatus = "selected_blocked";
      reasonCode = "reviewed_unchanged_upgrade_old_authority_preserved";
      failedAuditTerminalPermitted = true;
    }
  } catch (error) {
    commitError = error;
    businessAccounting = mutationAccountingFromFailure(error, commitRaw);
    const rawAuthorityStatus = new Set([
      "abandoned_old_authority",
      "recovery_required",
      "upgraded",
    ]).has(commitRaw?.status);
    const exactZeroPreMutationFailure = businessAccounting.exact === true
      && Object.values(businessAccounting.lower_bound_counts)
        .every((count) => count === 0)
      && businessAccounting.evidence?.response_loss_possible !== true
      && isProvenBeforeJournalPersistence(businessAccounting)
      && !rawAuthorityStatus;
    const journalPersistenceUnresolved = hasUnresolvedJournalPersistence(
      businessAccounting,
    );
    failedAuditTerminalPermitted = exactZeroPreMutationFailure;
    selectedStatus = exactZeroPreMutationFailure
      ? "selected_blocked"
      : "selected_recovery_required";
    reasonCode = exactZeroPreMutationFailure
      ? errorCode(error, "reviewed_unchanged_upgrade_failed_before_mutation")
      : errorCode(error, "reviewed_unchanged_upgrade_authority_unresolved");
    commitDetail = Object.freeze({
      status: rawAuthorityStatus
        ? "commit_authority_unproven"
        : exactZeroPreMutationFailure
          ? "failed"
          : journalPersistenceUnresolved
            ? "journal_persistence_authority_unresolved"
          : businessAccounting.exact
            ? "confirmed_mutations_authority_unresolved"
            : "response_unknown",
      result_sha256: jsonSha256OrNull(commitRaw),
      error: errorSummary(error),
      recovery_evidence: jsonCloneOrNull(
        error?.stage1EvidenceSchemaUpgradeRecovery
        ?? error?.stage1_evidence_schema_upgrade_recovery
        ?? null,
      ),
    });
  }

  if (selectedStatus === "selected_blocked" && !failedAuditTerminalPermitted) {
    selectedStatus = "selected_recovery_required";
    reasonCode = "reviewed_unchanged_upgrade_authority_unresolved";
  }

  if (selectedStatus === "selected_recovery_required") {
    return buildReport({
      context,
      startedAt,
      finishedAt: clock.read(),
      status: selectedStatus,
      reasonCode,
      error: commitError,
      captureResult,
      preAuthorityReceipt,
      postAuthorityReceipt,
      preCommitAuthorityReceipt,
      businessAccounting,
      auditAccounting: combineAuditAccounting(startReceipt.accounting),
      auditState: "running_recovery_required",
      commitDetail,
      auditStartReceipt: startReceipt.receipt,
    });
  }

  const auditFinishedAt = clock.read();
  const completionAuthority =
    stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority();
  const auditTerminal = selectedStatus === "selected_completed"
    ? {
        status: "succeeded",
        selected_result: selectedApplyResult({
          captureResult,
          commitResult: commitRaw,
          evaluatedAt: auditFinishedAt,
        }),
        commit_receipt: cloneJson(commitRaw.receipt),
      }
    : {
        status: "failed",
        error_code: reasonCode,
        error_message: cleanText(commitError?.message)
          || `Reviewed unchanged upgrade ended ${selectedStatus}.`,
      };
  const finishRequest = deepFreeze({
    reviewedApplyPlan: cloneJson(context.validatedPlan),
    executionNonce: context.executionNonce,
    finishedAt: auditFinishedAt,
    terminal: auditTerminal,
    completionAuthority,
  });

  let finishReceiptRaw;
  let finishReceipt;
  try {
    finishReceiptRaw = await io.finishAudit(finishRequest);
    finishReceipt = normalizeFinishAuditReceipt(
      finishReceiptRaw,
      context,
      auditTerminal,
      captureResult,
      postAuthorityReceipt,
      completionAuthority,
    );
  } catch (error) {
    const failedFinishAccounting = auditAccountingFromInvalidReceipt(
      finishReceiptRaw,
      "local_worker_run_terminal_updates",
    );
    return buildReport({
      context,
      startedAt,
      finishedAt: clock.read(),
      status: "selected_recovery_required",
      reasonCode: errorCode(error, "audit_terminal_update_response_unknown"),
      error,
      captureResult,
      preAuthorityReceipt,
      postAuthorityReceipt,
      businessAccounting,
      auditAccounting: combineAuditAccounting(
        startReceipt.accounting,
        failedFinishAccounting,
      ),
      auditState: "terminal_update_response_unknown",
      commitDetail,
      preCommitAuthorityReceipt,
      auditStartReceipt: startReceipt.receipt,
      auditFinishReceipt: null,
    });
  }

  if (!finishReceipt.terminalSettled) {
    return buildReport({
      context,
      startedAt,
      finishedAt: clock.read(),
      status: "selected_recovery_required",
      reasonCode: "reviewed_apply_audit_terminal_not_settled",
      error: new Error("The dedicated exact-one audit row did not reach the requested terminal state."),
      captureResult,
      preAuthorityReceipt,
      postAuthorityReceipt,
      businessAccounting,
      auditAccounting: combineAuditAccounting(
        startReceipt.accounting,
        finishReceipt.accounting,
      ),
      auditState: finishReceipt.receipt.disposition,
      commitDetail,
      preCommitAuthorityReceipt,
      auditStartReceipt: startReceipt.receipt,
      auditFinishReceipt: finishReceipt.receipt,
    });
  }

  return buildReport({
    context,
    startedAt,
    finishedAt: clock.read(),
    status: selectedStatus,
    reasonCode,
    error: commitError,
    captureResult,
    preAuthorityReceipt,
    postAuthorityReceipt,
    businessAccounting,
    auditAccounting: combineAuditAccounting(
      startReceipt.accounting,
      finishReceipt.accounting,
    ),
    auditState: "terminal",
    commitDetail,
    preCommitAuthorityReceipt,
    auditStartReceipt: startReceipt.receipt,
    auditFinishReceipt: finishReceipt.receipt,
  });
}

function validateExecutionSelection({
  source,
  manifest,
  validatedPlan,
  executionNonce,
}) {
  const checkedManifest = validateStage1EvidenceSchemaUpgradeManifest(manifest);
  const checkedPlan = requiredObject(validatedPlan, "validated reviewed apply plan");
  if (
    checkedPlan.valid !== true
    || checkedPlan.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_SCHEMA
  ) {
    throw new Error("Reviewed exact-one execution requires one validated v2 apply plan.");
  }
  if (checkedPlan.historical_evidence_only !== false) {
    throw new Error(
      "Reviewed exact-one execution refuses historical-only apply-plan evidence.",
    );
  }
  const sourceId = requiredUuid(
    checkedPlan.selected_source_id,
    "validated reviewed source ID",
  );
  const manifestSource = checkedManifest.sources.find(
    (entry) => entry.source_id === sourceId,
  );
  if (!manifestSource) {
    throw new Error("The reviewed apply-plan selection is absent from the exact manifest.");
  }
  const sourceValue = requiredObject(source, "selected live source");
  if (
    sourceValue.id !== sourceId
    || sourceValue.shared_award_id !== manifestSource.shared_award_id
  ) {
    throw new Error("The loaded source differs from the exact reviewed selection.");
  }

  const planSha256 = requiredSha256(checkedPlan.plan_sha256, "validated plan SHA-256");
  const planFileSha256 = requiredSha256(
    checkedPlan.plan_file_sha256,
    "validated plan file SHA-256",
  );
  const deferred = requiredExactDeferred(
    checkedPlan.deferred_source_ids,
    checkedManifest.source_ids.filter((id) => id !== sourceId),
  );
  if (checkedPlan.expected_active_journal_sha256 !== null) {
    throw new Error("Reviewed exact-one execution requires no active journal.");
  }
  if (!sameJson(
    checkedPlan.authority,
    STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY,
  )) {
    throw new Error("The validated reviewed apply authority is not exact.");
  }

  const plan = requiredObject(checkedPlan.plan, "validated reviewed plan value");
  const selected = requiredObject(plan.selected, "validated selected plan binding");
  if (!sameJson(selected.source, manifestSource)) {
    throw new Error("The validated selected source binding differs from the manifest.");
  }
  const localBaselineIdentity = assertBaselineIdentity(
    selected.local_baseline_identity,
  );
  const existingPointerIdentity = assertExistingPointerIdentity(
    selected.existing_pointer_identity,
  );
  const freshValidationSha256 = requiredSha256(
    selected.validation?.fresh_projection_sha256,
    "selected fresh validation SHA-256",
  );
  if (
    requiredSha256(
      checkedPlan.fresh_validation_projection_sha256,
      "validated fresh validation SHA-256",
    ) !== freshValidationSha256
    || stage1EvidenceSchemaUpgradeFreshValidationSha256(
      checkedPlan.selected_result,
    ) !== freshValidationSha256
  ) {
    throw new Error("The validated plan fresh projection binding is inconsistent.");
  }
  if (
    checkedPlan.selected_result?.source_id !== sourceId
    || checkedPlan.selected_result?.status !== "dry_run_ready"
  ) {
    throw new Error("The validated plan does not select one dry-run-ready result.");
  }
  const reportBinding = requiredObject(
    checkedPlan.report_binding,
    "validated dry-run report binding",
  );
  const reviewedReportAttemptId = requiredUuid(
    reportBinding.attempt_id,
    "reviewed dry-run attempt ID",
  );
  const auditId = stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(
    planFileSha256,
  );
  const transactionId = stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
    sourceId,
    planSha256,
  });
  const checkedExecutionNonce = requiredUuidV4(
    executionNonce,
    "reviewed apply execution nonce",
  );
  if (checkedExecutionNonce === auditId) {
    throw new Error("The reviewed apply execution nonce must differ from its audit row ID.");
  }

  return Object.freeze({
    sourceId,
    manifest: checkedManifest,
    manifestSource: cloneJson(manifestSource),
    manifestSha256: sha256(canonicalJson(checkedManifest)),
    validatedPlan: cloneJson(checkedPlan),
    planSha256,
    planFileSha256,
    deferredSourceIds: deferred,
    authority: cloneJson(checkedPlan.authority),
    selectedBinding: cloneJson(selected),
    localBaselineIdentity: cloneJson(localBaselineIdentity),
    existingPointerIdentity: cloneJson(existingPointerIdentity),
    freshValidationSha256,
    auditId,
    reviewedReportAttemptId,
    executionNonce: checkedExecutionNonce,
    transactionId,
  });
}

function validateInterfaces(value) {
  const interfaces = requiredObject(value, "reviewed exact-one interfaces");
  const unexpected = Object.keys(interfaces).filter(
    (name) => !ALLOWED_INTERFACE_NAMES.has(name),
  );
  if (unexpected.length) {
    throw new Error(
      `Reviewed exact-one execution forbids additional interface authority: ${unexpected.sort().join(",")}.`,
    );
  }
  const missing = REQUIRED_INTERFACE_NAMES.filter(
    (name) => typeof interfaces[name] !== "function",
  );
  if (missing.length) {
    throw new Error(
      `Reviewed exact-one execution is missing interfaces: ${missing.join(",")}.`,
    );
  }
  if (
    Object.hasOwn(interfaces, "revalidatePlan")
    && typeof interfaces.revalidatePlan !== "function"
  ) {
    throw new Error("Reviewed exact-one revalidatePlan must be a function when supplied.");
  }
  return interfaces;
}

function authorityAssertionRequest(context) {
  return deepFreeze({
    source_id: context.sourceId,
    manifest_source: cloneJson(context.manifestSource),
    plan_sha256: context.planSha256,
    plan_file_sha256: context.planFileSha256,
    expected_active_journal_sha256: null,
    expected_old_baseline: cloneJson(context.localBaselineIdentity),
    expected_old_pointer_identity: cloneJson(context.existingPointerIdentity),
    expected_authoritative_r2_binding: cloneJson(context.selectedBinding.r2),
    expected_acquisition: cloneJson(context.selectedBinding.acquisition),
    expected_activation: cloneJson(context.selectedBinding.activation),
    expected_finalization: cloneJson(context.selectedBinding.finalization),
    creates_api_charge: false,
    mutation_permitted: false,
  });
}

function assertFreshReadyResult(value, context) {
  const result = requiredObject(value, "fresh Stage 1 dry-run source result");
  assertExactKeys(result, SOURCE_RESULT_KEYS, "fresh Stage 1 dry-run source result");
  requiredTimestamp(result.evaluated_at, "fresh result evaluated_at");
  if (
    result.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA
    || result.mode !== "dry_run"
    || result.source_id !== context.sourceId
    || result.manifest_sha256 !== context.manifestSha256
    || result.source_eligible !== true
    || result.status !== "dry_run_ready"
    || result.capture_validation?.status !== "evaluated"
    || result.capture_validation?.decision !== "eligible_unchanged_upgrade"
    || result.capture_validation?.reason !== result.reason_code
    || !sameJson(result.pointer_journal, { status: "would_commit" })
    || !sameJson(result.visual_review_candidate, { status: "not_planned" })
    || !sameJson(result.quarantine, { status: "not_planned" })
    || !sameJson(result.mutation_counts, zeroStage1EvidenceSchemaUpgradeMutationCounts())
  ) {
    throw codeError(
      "fresh_validation_not_exact_unchanged_upgrade",
      "Fresh validation is not one exact dry-run-ready unchanged upgrade.",
    );
  }
  const evidence = requiredObject(
    result.capture_validation.evidence,
    "fresh capture validation evidence",
  );
  if (
    evidence.source_id !== context.sourceId
    || !sameJson(evidence.local_baseline_identity, context.localBaselineIdentity)
    || !sameJson(evidence.existing_pointer_identity, context.existingPointerIdentity)
  ) {
    throw codeError(
      "fresh_authority_identity_drift",
      "Fresh validation differs from the reviewed baseline or pointer authority.",
    );
  }
  const freshSha256 = stage1EvidenceSchemaUpgradeFreshValidationSha256(result);
  if (freshSha256 !== context.freshValidationSha256) {
    throw codeError(
      "fresh_validation_projection_drift",
      "Fresh validation differs from the exact reviewed projection.",
    );
  }
  return result;
}

function assertSameValidatedPlan(value, expected) {
  const checked = requiredObject(value, "revalidated reviewed apply plan");
  if (
    checked.valid !== true
    || checked.schema_version !== expected.schema_version
    || checked.plan_sha256 !== expected.plan_sha256
    || checked.plan_file_sha256 !== expected.plan_file_sha256
    || checked.selected_source_id !== expected.selected_source_id
    || checked.expected_active_journal_sha256 !== null
    || !sameJson(checked.deferred_source_ids, expected.deferred_source_ids)
    || !sameJson(checked.reviewer, expected.reviewer)
    || !sameJson(checked.authority, expected.authority)
    || !sameJson(checked.report_binding, expected.report_binding)
    || !sameJson(checked.plan, expected.plan)
    || checked.fresh_validation_projection_sha256
      !== expected.fresh_validation_projection_sha256
  ) {
    throw codeError(
      "reviewed_apply_plan_revalidation_drift",
      "The revalidated apply plan differs from the already-reviewed plan.",
    );
  }
  return checked;
}

function assertPlanReviewWindow(validatedPlan, now) {
  const reviewer = requiredObject(
    validatedPlan.reviewer,
    "validated reviewed plan reviewer",
  );
  const reviewedAt = requiredTimestamp(reviewer.reviewed_at, "plan reviewed_at");
  const expiresAt = requiredTimestamp(reviewer.expires_at, "plan expires_at");
  const current = requiredTimestamp(now, "plan revalidation now");
  const reviewedMs = Date.parse(reviewedAt);
  const expiresMs = Date.parse(expiresAt);
  const currentMs = Date.parse(current);
  if (
    reviewedMs > currentMs
    || expiresMs <= currentMs
    || expiresMs <= reviewedMs
    || expiresMs - reviewedMs
      > STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_MAX_LIFETIME_MS
  ) {
    throw codeError(
      "reviewed_apply_plan_expired",
      "The reviewed apply plan is outside its bounded review window.",
    );
  }
}

function normalizeStartAuditReceipt(
  value,
  context,
  captureResult,
  authorityReceipt,
) {
  const receipt = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditReceipt(value);
  if (
    receipt.action !== "start"
    || receipt.run_id !== context.auditId
    || receipt.requested_execution_nonce !== context.executionNonce
    || receipt.selected_source_id !== context.sourceId
    || receipt.plan_sha256 !== context.planSha256
    || receipt.plan_file_sha256 !== context.planFileSha256
  ) {
    throw codeError(
      "dedicated_audit_start_receipt_invalid",
      "The dedicated exact-one audit start receipt is invalid.",
    );
  }
  const accounting = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditAccounting(
    receipt.audit_mutation_accounting,
  );
  const authorizedDisposition = new Set([
    "started",
    "started_after_insert_response_loss",
  ]).has(receipt.disposition);
  const freshCapture = stage1EvidenceSchemaUpgradeReviewedApplyFreshCaptureEvidence({
    reviewedApplyPlan: context.validatedPlan,
    captureResult,
  });
  if (
    receipt.business_execution_authorized !== authorizedDisposition
    || (authorizedDisposition && receipt.replay !== false)
    || (authorizedDisposition
      && receipt.active_execution_nonce !== context.executionNonce)
    || (authorizedDisposition && receipt.terminal_status !== null)
    || (authorizedDisposition && receipt.terminal_identity_sha256 !== null)
    || (authorizedDisposition && receipt.terminal_failure_sha256 !== null)
    || (authorizedDisposition
      && receipt.terminal_completion_authority_mode !== null)
    || (authorizedDisposition
      && receipt.terminal_completion_authority_sha256 !== null)
    || (authorizedDisposition
      && !auditReceiptMatchesFreshCapture(receipt, freshCapture))
    || (authorizedDisposition
      && receipt.authority_receipt_sha256
        !== stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256(
          authorityReceipt,
        ))
  ) {
    throw codeError(
      "dedicated_audit_start_authority_invalid",
      "The dedicated audit start receipt grants inconsistent business authority.",
    );
  }
  const priorSuccess = receipt.disposition === "prior_terminal_success_replay"
    && receipt.replay === true
    && receipt.business_execution_authorized === false
    && receipt.terminal_status === "succeeded"
    && requiredSha256(
      receipt.terminal_identity_sha256,
      "prior successful audit terminal identity SHA-256",
    );
  if (receipt.replay === true && !priorSuccess) {
    throw codeError(
      "prior_success_result_unsealed",
      "A replaying audit receipt is not an exact sealed prior success.",
    );
  }
  if (
    receipt.disposition === "prior_terminal_success_replay"
    && !priorSuccess
  ) {
    throw codeError(
      "prior_success_result_unsealed",
      "A prior-success disposition is not an exact sealed replay.",
    );
  }
  return deepFreeze({
    receipt,
    accounting,
    businessExecutionAuthorized: receipt.business_execution_authorized,
    priorSuccess: Boolean(priorSuccess),
  });
}

function normalizeFinishAuditReceipt(
  value,
  context,
  terminal,
  captureResult,
  authorityReceipt,
  completionAuthority,
) {
  const receipt = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditReceipt(value);
  const terminalStatus = terminal.status;
  if (
    receipt.action !== "finish"
    || receipt.run_id !== context.auditId
    || receipt.requested_execution_nonce !== context.executionNonce
    || receipt.selected_source_id !== context.sourceId
    || receipt.plan_sha256 !== context.planSha256
    || receipt.plan_file_sha256 !== context.planFileSha256
  ) {
    throw codeError(
      "dedicated_audit_finish_receipt_invalid",
      "The dedicated exact-one audit terminal receipt is invalid.",
    );
  }
  const accounting = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditAccounting(
    receipt.audit_mutation_accounting,
  );
  const freshCapture = stage1EvidenceSchemaUpgradeReviewedApplyFreshCaptureEvidence({
    reviewedApplyPlan: context.validatedPlan,
    captureResult,
  });
  const allowedDispositions = terminalStatus === "succeeded"
    ? new Set([
        "finished",
        "finished_after_update_response_loss",
        "terminal_success_replay",
      ])
    : new Set([
        "finished",
        "finished_after_update_response_loss",
        "terminal_failure_replay",
      ]);
  const expectedTerminalIdentity = auditTerminalIdentity(terminal);
  const terminalSettled = allowedDispositions.has(receipt.disposition)
    && receipt.terminal_status === terminalStatus
    && receipt.business_execution_authorized === false
    && auditReceiptMatchesFreshCapture(receipt, freshCapture)
    && receipt.authority_receipt_sha256
      === stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256(
        authorityReceipt,
      )
    && receipt.terminal_completion_authority_mode === completionAuthority.mode
    && receipt.terminal_completion_authority_sha256
      === completionAuthority.completion_authority_sha256
    && (terminalStatus === "succeeded"
      ? receipt.terminal_identity_sha256 === expectedTerminalIdentity
        && receipt.terminal_failure_sha256 === null
      : receipt.terminal_identity_sha256 === null
        && receipt.terminal_failure_sha256 === expectedTerminalIdentity);
  const terminalReplay = new Set([
    "terminal_success_replay",
    "terminal_failure_replay",
  ]).has(receipt.disposition);
  if (
    terminalSettled
    && (
      receipt.replay !== terminalReplay
      || (!terminalReplay
        && receipt.active_execution_nonce !== context.executionNonce)
    )
  ) {
    throw codeError(
      "dedicated_audit_finish_replay_invalid",
      "The dedicated exact-one audit terminal replay or execution nonce is inconsistent.",
    );
  }
  return deepFreeze({
    receipt,
    accounting,
    terminalSettled,
  });
}

function auditTerminalIdentity(terminal) {
  const value = requiredObject(terminal, "reviewed audit terminal identity input");
  if (value.status === "failed") {
    const errorCode = cleanText(value.error_code);
    const errorMessage = cleanText(value.error_message);
    if (!errorCode || !errorMessage) {
      throw new Error("Reviewed failed audit terminal identity is invalid.");
    }
    return sha256(canonicalJson({
      error_code: errorCode.slice(0, 200),
      error_summary: errorMessage.slice(0, 1000),
      error_message_sha256: sha256(errorMessage),
    }));
  }
  if (value.status !== "succeeded") {
    throw new Error("Reviewed audit terminal identity status is invalid.");
  }
  const result = requiredObject(
    value.selected_result,
    "reviewed successful audit selected result",
  );
  const commitReceipt = requiredObject(
    value.commit_receipt,
    "reviewed successful audit commit receipt",
  );
  const accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    commitReceipt.mutation_accounting,
    { operation: "pointer_commit" },
  );
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RESULT_IDENTITY_SCHEMA,
    source_id: result.source_id,
    selected_result_schema_version: result.schema_version,
    selected_result_status: result.status,
    selected_result_sha256: sha256(canonicalJson(result)),
    commit_receipt_schema_version: commitReceipt.schema_version,
    commit_receipt_status: commitReceipt.status,
    commit_receipt_sha256: sha256(canonicalJson(commitReceipt)),
    commit_journal_sha256: commitReceipt.journal_sha256,
    commit_mutation_accounting_sha256: accounting.accounting_sha256,
  };
  return sha256(canonicalJson(content));
}

function auditReceiptMatchesFreshCapture(receipt, freshCapture) {
  return receipt.fresh_capture_evidence_sha256
      === freshCapture.fresh_capture_sha256
    && receipt.fresh_capture_result_sha256
      === freshCapture.capture_result_sha256
    && receipt.fresh_capture_validation_sha256
      === freshCapture.capture_validation_sha256
    && receipt.fresh_validation_projection_sha256
      === freshCapture.fresh_validation_projection_sha256;
}

function selectedApplyResult({ captureResult, commitResult, evaluatedAt }) {
  const selected = cloneJson(captureResult);
  selected.evaluated_at = requiredTimestamp(evaluatedAt, "selected apply evaluated_at");
  selected.mode = "apply";
  selected.status = "upgraded";
  selected.pointer_journal = {
    status: "upgraded",
    receipt: cloneJson(commitResult.receipt),
  };
  selected.visual_review_candidate = { status: "not_planned", receipt: null };
  selected.quarantine = { status: "not_requested" };
  selected.mutation_counts = cloneJson(commitResult.mutation_counts);
  selected.mutation_count_certainty = cloneJson(
    commitResult.mutation_count_certainty ?? {
      exact: commitResult.mutation_accounting?.exact === true,
      count_semantics: commitResult.mutation_accounting?.exact === true
        ? "exact"
        : "confirmed_lower_bounds_with_unknown_writes",
      unknown_write_categories:
        commitResult.mutation_accounting?.unknown_write_categories ?? [],
    },
  );
  for (const key of Object.keys(zeroStage1EvidenceSchemaUpgradeMutationCounts())) {
    if (plainObject(selected.safety)) delete selected.safety[key];
  }
  return deepFreeze(selected);
}

function commitRequest({
  context,
  source,
  captureResult,
  auditStartReceipt,
  persistedAuthorityReceipt,
}) {
  const operationBinding =
    buildStage1EvidenceSchemaUpgradeReviewedOperationBinding({
      sourceId: context.sourceId,
      transactionId: context.transactionId,
      reviewedApplyPlanFileSha256: context.planFileSha256,
      reviewedApplyPlanSha256: context.planSha256,
      auditRunId: context.auditId,
      executionNonce: context.executionNonce,
      reviewedReportAttemptId: context.reviewedReportAttemptId,
      freshCaptureSha256: auditStartReceipt.fresh_capture_evidence_sha256,
      freshCaptureResultSha256:
        auditStartReceipt.fresh_capture_result_sha256,
      freshCaptureValidationSha256:
        auditStartReceipt.fresh_capture_validation_sha256,
      freshValidationProjectionSha256:
        auditStartReceipt.fresh_validation_projection_sha256,
      precommitAuthorityReceiptSha256:
        stage1EvidenceSchemaUpgradeReviewedAuthorityReceiptSha256(
          persistedAuthorityReceipt,
        ),
      precommitSourceAuthority: persistedAuthorityReceipt.source_authority,
    });
  return deepFreeze({
    source_id: context.sourceId,
    source: cloneJson(source),
    manifest_source: cloneJson(context.manifestSource),
    plan_sha256: context.planSha256,
    plan_file_sha256: context.planFileSha256,
    audit_id: context.auditId,
    execution_nonce: context.executionNonce,
    reviewed_report_attempt_id: context.reviewedReportAttemptId,
    transaction_id: context.transactionId,
    operation_binding: operationBinding,
    capture_result: cloneJson(captureResult),
    capture_validation: cloneJson(captureResult.capture_validation),
    expected_active_journal_sha256: null,
    expected_old_baseline: cloneJson(context.localBaselineIdentity),
    expected_old_pointer_identity: cloneJson(context.existingPointerIdentity),
    expected_authoritative_r2_binding: cloneJson(context.selectedBinding.r2),
    authority: cloneJson(context.authority),
    creates_api_charge: false,
  });
}

function normalizeCommitResult(value, context) {
  const result = requiredObject(value, "reviewed unchanged-upgrade commit result");
  if (
    Object.hasOwn(result, "visual_review_candidate")
    || Object.hasOwn(result, "quarantine")
    || Object.hasOwn(result, "public_fact_writes")
    || Object.hasOwn(result, "hold_clears")
  ) {
    throw codeError(
      "reviewed_commit_scope_smuggling",
      "The reviewed commit result contains forbidden mutation authority.",
    );
  }
  const status = cleanText(result.status);
  if (
    !new Set(["upgraded", "abandoned_old_authority", "recovery_required"]).has(status)
    || result.source_id !== context.sourceId
    || result.context !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT
    || result.creates_api_charge !== false
    || (result.transaction_id ?? result.receipt?.transaction_id)
      !== context.transactionId
  ) {
    throw codeError(
      "reviewed_commit_result_invalid",
      "The reviewed unchanged-upgrade commit result is invalid.",
    );
  }
  const accounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    result.mutation_accounting ?? result.receipt?.mutation_accounting,
    { operation: "pointer_commit" },
  );
  if (
    !sameJson(result.mutation_counts, accounting.lower_bound_counts)
    || accounting.lower_bound_counts.candidate_writes !== 0
    || accounting.lower_bound_counts.quarantine_writes !== 0
  ) {
    throw codeError(
      "reviewed_commit_mutation_scope_invalid",
      "The reviewed commit mutation accounting exceeds unchanged-upgrade authority.",
    );
  }
  if (status === "upgraded" && accounting.exact !== true) {
    throw codeError(
      "reviewed_commit_success_accounting_uncertain",
      "A reviewed commit cannot complete with unknown mutation accounting.",
    );
  }
  const receipt = assertExactCommitReceipt({
    value: result.receipt,
    result,
    accounting,
    context,
  });
  return Object.freeze({
    status,
    accounting,
    detail: deepFreeze({
      status,
      result_sha256: jsonSha256OrNull(result),
      receipt: cloneJson(receipt),
      error: null,
      recovery_evidence: status === "recovery_required"
        ? cloneJson(receipt)
        : null,
    }),
  });
}

function assertExactCommitReceipt({ value, result, accounting, context }) {
  const receipt = requiredObject(value, "reviewed unchanged-upgrade commit receipt");
  assertExactKeys(
    receipt,
    COMMIT_RECEIPT_KEYS,
    "reviewed unchanged-upgrade commit receipt",
  );
  const innerAccounting = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    receipt.mutation_accounting,
    { operation: "pointer_commit" },
  );
  if (
    receipt.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA
    || receipt.source_id !== context.sourceId
    || receipt.context !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT
    || receipt.operation !== "pointer_commit"
    || receipt.status !== result.status
    || receipt.creates_api_charge !== false
    || receipt.transaction_id !== context.transactionId
    || !cleanText(receipt.outcome)
    || !cleanText(receipt.journal_phase)
    || receipt.cleanup_delete_performed !== false
    || receipt.mutation_count_scope !== "confirmed_io_receipts_in_this_invocation"
    || !sameJson(receipt.mutation_counts, result.mutation_counts)
    || !sameJson(innerAccounting, accounting)
  ) {
    throw codeError(
      "reviewed_commit_receipt_invalid",
      "The reviewed unchanged-upgrade commit receipt is not exactly bound to its result.",
    );
  }
  requiredSha256(receipt.journal_sha256, "reviewed commit journal SHA-256");
  if (typeof receipt.journal_archived !== "boolean") {
    throw codeError(
      "reviewed_commit_receipt_invalid",
      "The reviewed commit journal archive state is invalid.",
    );
  }
  const reconciliationEvidence = normalizeReviewedReconciliationEvidence({
    value: result.reviewed_reconciliation_evidence,
    required: result.status !== "recovery_required",
    context,
    receipt,
  });
  const cas = assertFreshReviewedCommitCas(receipt.cas, accounting);
  const sourceHealth = assertFreshReviewedCommitSourceHealth(receipt.source_health);
  assertFreshReviewedMutationAttribution({
    accounting,
    cas,
    sourceHealth,
  });
  let journalArchiveAccounting = null;
  try {
    journalArchiveAccounting =
      assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting(
        accounting.evidence?.journal_archive,
      );
  } catch (error) {
    if (result.status !== "recovery_required") {
      throw codeError(
        "reviewed_commit_archive_accounting_invalid",
        `A terminal reviewed commit lacks sealed journal-archive accounting: ${cleanText(error?.message)}`,
      );
    }
  }
  if (
    result.status !== "recovery_required"
    && journalArchiveAccounting?.state !== "verified"
  ) {
    throw codeError(
      "reviewed_commit_archive_not_verified",
      "A terminal reviewed commit lacks acknowledged, read-back, active-absence-verified archive evidence.",
    );
  }
  if (
    result.status === "upgraded"
    && (
      receipt.outcome !== "committed_candidate"
      || receipt.journal_phase !== "completed"
      || receipt.journal_archived !== true
      || receipt.authoritative_pointer_state !== "candidate"
      || receipt.authoritative_baseline_state !== "candidate"
      || receipt.authoritative_pointer_sha256
        !== reconciliationEvidence?.candidate_pointer_identity.canonical_sha256
      || !SHA256_PATTERN.test(receipt.authoritative_baseline_sha256 || "")
      || sourceHealth === null
      || accounting.exact !== true
    )
  ) {
    throw codeError(
      "reviewed_commit_success_receipt_invalid",
      "A successful reviewed commit lacks archived exact authority evidence.",
    );
  }
  if (
    result.status !== "recovery_required"
    && !sameJson(
      receipt.cleanup_debt,
      expectedReviewedCommitCleanupDebt({
        evidence: reconciliationEvidence,
        status: result.status,
        cas,
      }),
    )
  ) {
    throw codeError(
      "reviewed_commit_cleanup_debt_invalid",
      "The reviewed commit cleanup debt differs from its exact sealed pointer authority.",
    );
  }
  if (
    result.status === "abandoned_old_authority"
    && (
      receipt.outcome !== "abandoned_old_authority"
      || receipt.journal_phase !== "completed"
      || receipt.journal_archived !== true
      || receipt.authoritative_pointer_state !== "old"
      || !new Set(["old", "both"]).has(receipt.authoritative_baseline_state)
      || receipt.authoritative_pointer_sha256
        !== context.existingPointerIdentity.canonical_sha256
      || receipt.authoritative_baseline_sha256
        !== context.localBaselineIdentity.sha256
      || receipt.source_health !== null
      || accounting.exact !== true
    )
  ) {
    throw codeError(
      "reviewed_commit_abandoned_receipt_invalid",
      "An abandoned reviewed commit lacks exact closed old-authority evidence.",
    );
  }
  return receipt;
}

function normalizeReviewedReconciliationEvidence({
  value,
  required,
  context,
  receipt,
}) {
  if ((value === null || value === undefined) && !required) return null;
  if (value === null || value === undefined) {
    throw codeError(
      "reviewed_commit_reconciliation_evidence_missing",
      "A terminal reviewed commit lacks sealed reconciliation pointer evidence.",
    );
  }
  let evidence;
  try {
    evidence = assertStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence(
      value,
    );
  } catch (error) {
    throw codeError(
      "reviewed_commit_reconciliation_evidence_invalid",
      `Reviewed reconciliation evidence is invalid: ${cleanText(error?.message)}`,
    );
  }
  if (
    evidence.source_id !== context.sourceId
    || evidence.transaction_id !== context.transactionId
    || evidence.journal_sha256 !== receipt.journal_sha256
    || evidence.old_pointer_identity.canonical_sha256
      !== context.existingPointerIdentity.canonical_sha256
  ) {
    throw codeError(
      "reviewed_commit_reconciliation_evidence_invalid",
      "Reviewed reconciliation evidence differs from the selected source, transaction, journal, or old pointer.",
    );
  }
  return evidence;
}

function assertFreshReviewedCommitCas(value, accounting) {
  const cas = requiredObject(value, "reviewed fresh-commit CAS receipt");
  assertExactKeys(cas, [
    "attempted",
    "confirmed_database_pointer_writes",
    "error_code",
    "error_message",
    "recovered",
    "returned",
    "threw",
    "write_attribution",
  ], "reviewed fresh-commit CAS receipt");
  const strictTrue = cas.attempted === true
    && cas.returned === true
    && cas.threw === false
    && cas.recovered === false
    && cas.error_code === null
    && cas.error_message === null
    && cas.confirmed_database_pointer_writes === 1
    && cas.write_attribution === "confirmed_by_strict_true_return";
  const strictFalse = cas.attempted === true
    && cas.returned === false
    && cas.threw === false
    && cas.recovered === false
    && cas.error_code === null
    && cas.error_message === null
    && cas.confirmed_database_pointer_writes === 0
    && cas.write_attribution === "confirmed_not_written_by_this_cas";
  const threw = cas.attempted === true
    && cas.returned === null
    && cas.threw === true
    && cas.recovered === false
    && Boolean(cleanText(cas.error_code))
    && Boolean(cleanText(cas.error_message))
    && cas.confirmed_database_pointer_writes === 0
    && cas.write_attribution === "unattributed_after_exception";
  if (
    (!strictTrue && !strictFalse && !threw)
    || !sameJson(accounting.evidence?.cas, cas)
    || (threw
      && !accounting.unknown_write_categories.includes("database_writes"))
  ) {
    throw codeError(
      "reviewed_commit_cas_invalid",
      "The reviewed commit CAS receipt is not an exact fresh-call outcome bound to accounting.",
    );
  }
  return cas;
}

function assertFreshReviewedCommitSourceHealth(value) {
  if (value === null) return null;
  const sourceHealth = requiredObject(
    value,
    "reviewed fresh-commit source-health receipt",
  );
  assertExactKeys(
    sourceHealth,
    ["mutation_counts", "status"],
    "reviewed fresh-commit source-health receipt",
  );
  const counts = assertExactBusinessMutationCounts(
    sourceHealth.mutation_counts,
    "reviewed fresh-commit source-health counts",
  );
  const succeeded = sourceHealth.status === "succeeded"
    && counts.database_writes === 1
    && counts.source_state_writes === 1;
  const alreadyCurrent = sourceHealth.status === "already_current"
    && counts.database_writes === 0
    && counts.source_state_writes === 0;
  if (
    (!succeeded && !alreadyCurrent)
    || counts.r2_writes !== 0
    || counts.local_baseline_writes !== 0
    || counts.candidate_writes !== 0
    || counts.quarantine_writes !== 0
  ) {
    throw codeError(
      "reviewed_commit_source_health_invalid",
      "The reviewed commit source-health status and exact mutation counts disagree.",
    );
  }
  return deepFreeze({
    status: sourceHealth.status,
    mutation_counts: cloneJson(counts),
  });
}

function assertFreshReviewedMutationAttribution({ accounting, cas, sourceHealth }) {
  const sourceCounts = sourceHealth?.mutation_counts
    ?? zeroStage1EvidenceSchemaUpgradeMutationCounts();
  if (
    accounting.lower_bound_counts.database_writes
      !== cas.confirmed_database_pointer_writes + sourceCounts.database_writes
    || accounting.lower_bound_counts.source_state_writes
      !== sourceCounts.source_state_writes
  ) {
    throw codeError(
      "reviewed_commit_mutation_attribution_invalid",
      "The reviewed commit database and source-state counts do not match its CAS and source-health receipts.",
    );
  }
}

function expectedReviewedCommitCleanupDebt({ evidence, status, cas }) {
  const candidateAuthority = status === "upgraded";
  return planLatestOnlyVisualSnapshotPointerReconciliation({
    existing: evidence.old_pointer_identity.projection,
    candidate: evidence.candidate_pointer_identity.projection,
    current: candidateAuthority
      ? evidence.candidate_pointer_identity.projection
      : evidence.old_pointer_identity.projection,
    outcome: cas.threw
      ? "ambiguous_error"
      : cas.returned === true
        ? "committed"
        : "cas_lost",
    uploadedKeys: evidence.candidate_object_keys,
  }).cleanup_debt;
}

function assertExactBusinessMutationCounts(value, label) {
  const counts = requiredObject(value, label);
  const zero = zeroStage1EvidenceSchemaUpgradeMutationCounts();
  assertExactKeys(counts, Object.keys(zero), label);
  if (Object.values(counts).some(
    (count) => !Number.isSafeInteger(count) || count < 0,
  )) {
    throw codeError(
      "reviewed_commit_mutation_counts_invalid",
      `${label} must contain exact non-negative integer counts.`,
    );
  }
  return counts;
}

function mutationAccountingFromFailure(error, rawResult) {
  const candidates = [
    error?.stage1_mutation_accounting,
    rawResult?.mutation_accounting,
    rawResult?.receipt?.mutation_accounting,
  ];
  for (const candidate of candidates) {
    try {
      return assertStage1EvidenceSchemaUpgradeMutationAccounting(candidate, {
        operation: "pointer_commit",
      });
    } catch {
      // Continue until every possible sealed accounting source is exhausted.
    }
  }
  return sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
    unknownWriteCategories: Object.keys(
      zeroStage1EvidenceSchemaUpgradeMutationCounts(),
    ),
    evidence: {
      boundary: "commit_callback_response_unknown",
      response_loss_possible: true,
    },
  });
}

function isProvenBeforeJournalPersistence(accounting) {
  const evidence = accounting?.evidence;
  const journalPersistence = evidence?.journal_persistence;
  return plainObject(evidence)
    && evidence.boundary === "before_io"
    && evidence.journal_phase === null
    && plainObject(journalPersistence)
    && sameJson(Object.keys(journalPersistence).sort(), [
      "local_journal_writes_lower_bound",
      "response_loss_possible",
      "state",
    ])
    && journalPersistence.state === "not_started"
    && journalPersistence.local_journal_writes_lower_bound === 0
    && journalPersistence.response_loss_possible === false;
}

function hasUnresolvedJournalPersistence(accounting) {
  const journalPersistence = accounting?.evidence?.journal_persistence;
  return plainObject(journalPersistence)
    && (
      journalPersistence.state !== "not_started"
      || journalPersistence.local_journal_writes_lower_bound > 0
      || journalPersistence.response_loss_possible === true
    );
}

function zeroBusinessMutationAccounting() {
  return sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
    unknownWriteCategories: [],
    evidence: {
      boundary: "before_business_mutation",
      response_loss_possible: false,
    },
  });
}

function auditAccounting() {
  return combineAuditAccounting();
}

function auditAccountingFromInvalidReceipt(value, unknownCategory) {
  try {
    return combineAuditAccounting(
      assertStage1EvidenceSchemaUpgradeReviewedApplyAuditAccounting(
        value?.audit_mutation_accounting,
      ),
    );
  } catch {
    return combinedAuditAccounting({
      counts: zeroAuditCounts(),
      unknown: [unknownCategory],
      componentSha256: [],
    });
  }
}

function combineAuditAccounting(...values) {
  const counts = zeroAuditCounts();
  const unknown = [];
  const componentSha256 = [];
  for (const value of values.filter(Boolean)) {
    if (value.schema_version === EXECUTION_AUDIT_ACCOUNTING_SCHEMA) {
      addAuditCounts(counts, value.lower_bound_counts);
      unknown.push(...value.unknown_write_categories);
      componentSha256.push(...value.component_accounting_sha256);
      continue;
    }
    const accounting =
      assertStage1EvidenceSchemaUpgradeReviewedApplyAuditAccounting(value);
    addAuditCounts(counts, accounting.lower_bound_counts);
    unknown.push(...accounting.unknown_write_categories);
    componentSha256.push(accounting.accounting_sha256);
  }
  return combinedAuditAccounting({ counts, unknown, componentSha256 });
}

function combinedAuditAccounting({ counts, unknown, componentSha256 }) {
  const lowerBoundCounts = normalizeAuditCounts(counts);
  const unknownCategories = [...new Set(unknown)].sort();
  if (unknownCategories.some((name) => !AUDIT_COUNT_KEYS.includes(name))) {
    throw new Error("Reviewed exact-one audit accounting contains an unknown category.");
  }
  const components = [...new Set(componentSha256)].sort();
  if (components.some((hash) => !SHA256_PATTERN.test(hash))) {
    throw new Error("Reviewed exact-one audit component seal is invalid.");
  }
  const content = {
    schema_version: EXECUTION_AUDIT_ACCOUNTING_SCHEMA,
    count_scope: "dedicated_local_worker_runs_writes_only",
    count_semantics: "confirmed_lower_bounds",
    exact: unknownCategories.length === 0,
    lower_bound_counts: lowerBoundCounts,
    unknown_write_categories: unknownCategories,
    component_accounting_sha256: components,
  };
  return deepFreeze({
    ...content,
    accounting_sha256: sha256(canonicalJson(content)),
  });
}

function zeroAuditCounts() {
  return {
    local_worker_run_inserts: 0,
    local_worker_run_terminal_updates: 0,
  };
}

function normalizeAuditCounts(value) {
  const counts = requiredObject(value, "reviewed execution audit counts");
  assertExactKeys(counts, AUDIT_COUNT_KEYS, "reviewed execution audit counts");
  if (AUDIT_COUNT_KEYS.some(
    (key) => !Number.isSafeInteger(counts[key]) || counts[key] < 0,
  )) {
    throw new Error("Reviewed exact-one audit counts must be non-negative integers.");
  }
  return Object.fromEntries(AUDIT_COUNT_KEYS.map((key) => [key, counts[key]]));
}

function addAuditCounts(target, addition) {
  const counts = normalizeAuditCounts(addition);
  for (const key of AUDIT_COUNT_KEYS) target[key] += counts[key];
}

function buildReport({
  context,
  startedAt,
  finishedAt,
  status,
  reasonCode,
  error,
  captureResult,
  preAuthorityReceipt,
  postAuthorityReceipt,
  preCommitAuthorityReceipt = null,
  businessAccounting,
  auditAccounting: auditMutationAccounting,
  auditState,
  commitDetail,
  auditStartReceipt = null,
  auditFinishReceipt = null,
}) {
  const completed = status === "selected_completed";
  const recoveryRequired = status === "selected_recovery_required";
  const selected = {
    source_id: context.sourceId,
    status,
    reason_code: reasonCode,
    capture_performed: captureResult !== null,
    capture_result_sha256: jsonSha256OrNull(captureResult),
    fresh_validation_projection_sha256: captureResult
      ? safeFreshProjectionSha256(captureResult)
      : null,
    capture_result: jsonCloneOrNull(captureResult),
    commit: commitDetail ? cloneJson(commitDetail) : null,
    error: error ? errorSummary(error) : null,
  };
  const report = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_EXECUTION_REPORT_SCHEMA,
    mode: EXECUTION_MODE,
    started_at: requiredTimestamp(startedAt, "execution started_at"),
    finished_at: requiredTimestamp(finishedAt, "execution finished_at"),
    status,
    execution_status: completed
      ? "completed"
      : recoveryRequired
        ? "recovery_required"
        : "blocked",
    reason_code: reasonCode,
    plan: {
      schema_version: context.validatedPlan.schema_version,
      plan_sha256: context.planSha256,
      plan_file_sha256: context.planFileSha256,
      reviewed_report_attempt_id: context.reviewedReportAttemptId,
      reviewer: cloneJson(context.validatedPlan.reviewer),
    },
    manifest_sha256: context.manifestSha256,
    selected_source_id: context.sourceId,
    selected_source_count: 1,
    deferred_source_ids: [...context.deferredSourceIds],
    deferred_source_count:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_DEFERRED_COUNT,
    evaluated_source_count: captureResult ? 1 : 0,
    completed_source_count: completed ? 1 : 0,
    blocked_source_count: completed ? 0 : 1,
    recovery_required_source_count: recoveryRequired ? 1 : 0,
    candidate_source_count: 0,
    quarantined_source_count: 0,
    public_fact_write_count: 0,
    hold_clear_count: 0,
    automated_work_clear: false,
    selected,
    authority_assertions: {
      pre_capture_receipt_sha256: jsonSha256OrNull(preAuthorityReceipt),
      post_capture_receipt_sha256: jsonSha256OrNull(postAuthorityReceipt),
      pre_commit_receipt_sha256: jsonSha256OrNull(preCommitAuthorityReceipt),
    },
    audit: {
      audit_id: context.auditId,
      execution_nonce: context.executionNonce,
      transaction_id: context.transactionId,
      state: auditState,
      start_receipt: auditStartReceipt ? cloneJson(auditStartReceipt) : null,
      finish_receipt: auditFinishReceipt ? cloneJson(auditFinishReceipt) : null,
      mutation_accounting: cloneJson(auditMutationAccounting),
    },
    business_mutation_counts: cloneJson(businessAccounting.lower_bound_counts),
    business_mutation_counts_are_exact: businessAccounting.exact,
    business_mutation_count_semantics: businessAccounting.exact
      ? "exact"
      : "confirmed_lower_bounds_with_unknown_writes",
    business_unknown_write_categories: [
      ...businessAccounting.unknown_write_categories,
    ],
    business_mutation_accounting: cloneJson(businessAccounting),
    forbidden_mutations: {
      visual_review_candidates: 0,
      quarantines: 0,
      public_facts: 0,
      hold_clears: 0,
      worker_run_supersessions: 0,
    },
    safety: {
      creates_api_charge: false,
      preserve_admin_review_status: true,
      allow_visual_review_candidate: false,
      allow_quarantine: false,
      allow_public_fact_writes: false,
      allow_hold_clearing: false,
      allow_worker_run_supersession: false,
    },
  };
  report.report_sha256 = sha256(canonicalJson(report));
  return deepFreeze(report);
}

function normalizeOptionalReadOnlyReceipt(value, label) {
  if (value === undefined || value === null) return null;
  const receipt = requiredObject(value, label);
  if (
    Object.hasOwn(receipt, "mutation_performed")
    && receipt.mutation_performed !== false
  ) {
    throw new Error(`The ${label} performed a mutation.`);
  }
  return cloneJson(receipt);
}

function assertAuthoritySourceProjection(receipt, context, source) {
  let authorityReceipt;
  let sourceAuthority;
  try {
    authorityReceipt =
      assertStage1EvidenceSchemaUpgradeReviewedApplyAuthorityReceipt(receipt);
    sourceAuthority = assertStage1EvidenceSchemaUpgradePrecommitSourceAuthority(
      authorityReceipt.source_authority,
    );
  } catch (error) {
    throw codeError(
      "reviewed_source_authority_receipt_invalid",
      `The reviewed source authority receipt is invalid: ${cleanText(error?.message) || "unknown validation failure"}`,
    );
  }
  if (
    authorityReceipt.source_id !== context.sourceId
    || sourceAuthority.source_id !== context.sourceId
    || authorityReceipt.source_authority_sha256
      !== sourceAuthority.source_authority_sha256
    || Object.entries(sourceAuthority.projection).some(
      ([key, value]) => !Object.hasOwn(source, key) || !sameJson(value, source[key]),
    )
  ) {
    throw codeError(
      "reviewed_source_authority_receipt_invalid",
      "The reviewed source authority receipt differs from the exact selected live source.",
    );
  }
  return sourceAuthority;
}

function requiredExactDeferred(value, expected) {
  if (
    !Array.isArray(value)
    || value.length
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_DEFERRED_COUNT
    || !sameJson(value, expected)
  ) {
    throw new Error("The validated plan does not defer the exact other eight sources.");
  }
  return [...value];
}

function assertBaselineIdentity(value) {
  const identity = requiredObject(value, "reviewed old baseline identity");
  assertExactKeys(identity, ["byte_length", "sha256"], "reviewed old baseline identity");
  requiredSha256(identity.sha256, "reviewed old baseline SHA-256");
  if (!Number.isSafeInteger(identity.byte_length) || identity.byte_length <= 0) {
    throw new Error("The reviewed old baseline byte length is invalid.");
  }
  return identity;
}

function assertExistingPointerIdentity(value) {
  const identity = requiredObject(value, "reviewed old pointer identity");
  assertExactKeys(
    identity,
    ["canonical_sha256", "exists", "schema_version"],
    "reviewed old pointer identity",
  );
  if (identity.exists !== true || !cleanText(identity.schema_version)) {
    throw new Error("The reviewed old pointer identity is not an existing pointer.");
  }
  requiredSha256(identity.canonical_sha256, "reviewed old pointer SHA-256");
  return identity;
}

export function stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
  sourceId,
  planSha256,
} = {}) {
  const selectedSourceId = requiredUuid(
    sourceId,
    "reviewed apply transaction source ID",
  );
  const reviewedPlanSha256 = requiredSha256(
    planSha256,
    "reviewed apply transaction plan SHA-256",
  );
  const digest = sha256(
    `${STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_EXECUTION_REPORT_SCHEMA}|${selectedSourceId}|${reviewedPlanSha256}`,
  ).split("");
  digest[12] = "5";
  digest[16] = ["8", "9", "a", "b"][Number.parseInt(digest[16], 16) % 4];
  const hex = digest.join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function executionClock(now) {
  const readNow = typeof now === "function" ? now : () => now;
  return Object.freeze({
    read() {
      return requiredTimestamp(readNow(), "reviewed apply execution time");
    },
  });
}

function errorCode(error, fallback) {
  const code = cleanText(error?.code);
  return /^[a-z0-9][a-z0-9_.:-]{0,199}$/u.test(code) ? code : fallback;
}

function errorSummary(error) {
  return Object.freeze({
    code: errorCode(error, "reviewed_apply_execution_failed"),
    message: cleanText(error?.message || error) || "Unknown reviewed apply failure.",
  });
}

function codeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function safeFreshProjectionSha256(value) {
  try {
    return stage1EvidenceSchemaUpgradeFreshValidationSha256(value);
  } catch {
    return null;
  }
}

function jsonSha256OrNull(value) {
  if (value === null || value === undefined) return null;
  try {
    return sha256(canonicalJson(value));
  } catch {
    return null;
  }
}

function jsonCloneOrNull(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function cloneJson(value) {
  return structuredClone(value);
}

function assertExactKeys(value, expected, label) {
  const keys = Object.keys(requiredObject(value, label)).sort();
  if (!sameJson(keys, [...expected].sort())) {
    throw new Error(`The ${label} contains extra or missing keys.`);
  }
}

function requiredObject(value, label) {
  if (!plainObject(value)) throw new TypeError(`The ${label} must be an object.`);
  return value;
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`The ${label} must be one lowercase SHA-256.`);
  }
  return value;
}

function requiredUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`The ${label} must be one lowercase UUID.`);
  }
  return value;
}

function requiredUuidV4(value, label) {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    throw new Error(`The ${label} must be one lowercase UUIDv4.`);
  }
  return value;
}

function requiredTimestamp(value, label) {
  if (typeof value !== "string") {
    throw new Error(`The ${label} must be a canonical UTC timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`The ${label} must be a canonical UTC timestamp.`);
  }
  return value;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
