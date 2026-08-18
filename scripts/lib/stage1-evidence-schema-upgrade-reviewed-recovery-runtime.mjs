import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { guardAdminReviewMutation } from "./admin-review-state-guard.mjs";
import { comparePreciseRfc3339 } from "./monitoring-feedback-promotion-verification.mjs";
import {
  prepareR2CaptureArtifacts,
} from "./r2-capture-artifact-bindings.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_MODE,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_ROW_COLUMNS,
  finishStage1EvidenceSchemaUpgradeReviewedApplyAudit,
  inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs";
import {
  validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";
import {
  stage1EvidenceSchemaUpgradeReviewedApplyTransactionId,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-execution.mjs";
import {
  assertStage1EvidenceSchemaUpgradeReviewedRecoverySucceededTerminal,
  buildStage1EvidenceSchemaUpgradeReviewedRecoveryArchivedSucceededTerminal,
  stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-execution.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT,
  runStage1EvidenceSchemaUpgradeCommit,
} from "./stage1-evidence-schema-upgrade-commit.mjs";
import {
  zeroStage1EvidenceSchemaUpgradeMutationCounts,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";
import {
  stage1EvidenceSchemaUpgradeCanonicalTimestamp,
  stage1EvidenceSchemaUpgradeFinalizationReceiptSha256,
} from "./stage1-evidence-schema-upgrade.mjs";
import {
  verifyStage1EvidenceSchemaUpgradeR2Binding,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";
import {
  assertStage1EvidenceSchemaUpgradeReviewedRecoveryCandidateR2Pointer,
  assertStage1EvidenceSchemaUpgradeReviewedRecoveryOldR2Authority,
  projectStage1EvidenceSchemaUpgradeReviewedRecoveryAuthority,
  stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256,
  stage1EvidenceSchemaUpgradeReviewedRecoveryPlanCanonicalBytes,
  stage1EvidenceSchemaUpgradeReviewedRecoveryPlanSha256,
  validateStage1EvidenceSchemaUpgradeReviewedRecoveryPlan,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-plan.mjs";
import {
  assertStage1EvidenceSchemaUpgradeReviewedRecoveryInspectionArtifact,
  stage1EvidenceSchemaUpgradeReviewedRecoveryInspectionPlanBinding,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-worker.mjs";
import {
  classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority,
  projectStage1EvidenceSchemaUpgradeSourceHealthAuthority,
} from "./stage1-evidence-schema-upgrade-reviewed-source-authority.mjs";
import {
  assertStage1EvidenceSchemaUpgradeJournal,
  proveStage1EvidenceSchemaUpgradeArchivedCompletion,
  stage1EvidenceSchemaUpgradeBaselineBytes,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import { withVisualBaselineLockAsync } from "./visual-baseline-lock.mjs";
import { visualSnapshotPointerIdentity } from "./visual-snapshot-latest-only-reconciliation.mjs";

const SOURCE_COLUMNS = [
  "id",
  "shared_award_id",
  "url",
  "title",
  "display_title",
  "page_description",
  "page_metadata",
  "page_metadata_generated_at",
  "page_metadata_model",
  "page_type",
  "source",
  "reason",
  "submitted_by_user_id",
  "admin_review_status",
  "admin_review_note",
  "admin_reviewed_at",
  "admin_reviewed_by",
  "last_hash",
  "last_checked_at",
  "next_check_at",
  "consecutive_failures",
  "last_error",
  "created_at",
  "updated_at",
  "shared_awards!inner(id, name, status, official_homepage)",
].join(", ");

const POINTER_COLUMNS = [
  "shared_award_source_id",
  "shared_award_id",
  "kind",
  "bucket",
  "source_url",
  "source_title",
  "source_page_type",
  "latest_captured_at",
  "latest_object_keys",
  "latest_hashes",
  "latest_metadata",
  "previous_captured_at",
  "previous_object_keys",
  "previous_hashes",
  "previous_metadata",
  "updated_at",
].join(", ");

const ACQUISITION_COLUMNS = [
  "id",
  "shared_award_source_id",
  "acquisition_kind",
  "notification_mode",
  "origin_source_page_request_id",
  "origin_worker_run_id",
  "parent_shared_award_source_id",
  "onboarding_batch_id",
  "review_seal",
  "metadata",
  "acquired_at",
  "created_at",
].join(",");

const AUDIT_COLUMNS =
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_ROW_COLUMNS.join(",");

const FINALIZATION_KEYS = Object.freeze([
  "disposition_item_sha256",
  "finalization_receipt_sha256",
  "finalized_at",
  "guard_sha256",
  "observed_normalized_text_sha256",
  "persistence_evidence",
  "prepare_receipt_sha256",
  "receipt",
  "shared_award_source_id",
  "source_acquisition_id",
  "source_page_request_id",
]);

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_SOURCE_PREIMAGE_COLUMNS =
  Object.freeze([
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
  ]);

/**
 * Production-only capability adapter for reviewed recovery. It deliberately
 * imports only GetObject from S3 and exposes no browser, capture, AI, upload,
 * pointer-CAS, candidate, quarantine, public-fact, hold, or supersession hook.
 */
export function createStage1EvidenceSchemaUpgradeReviewedRecoveryRuntime({
  supabase,
  archiveRoot,
  readR2Object,
  r2Bucket,
  reviewedApplyPlan,
  sourceId,
  transactionId,
  reviewedRecoveryAuthority = null,
  visualSourceCheckMinutes = 24 * 60,
  lockTimeoutMs = 30_000,
  now = () => new Date().toISOString(),
} = {}) {
  const db = requiredObject(supabase, "reviewed recovery Supabase client");
  const root = requiredText(archiveRoot, "reviewed recovery archive root");
  if (typeof readR2Object !== "function") {
    throw new TypeError("Reviewed recovery exact R2 read interface is required.");
  }
  const bucket = requiredText(r2Bucket, "reviewed recovery R2 bucket");
  const suppliedApply = requiredObject(reviewedApplyPlan, "reviewed apply plan evidence");
  const source = requiredText(sourceId, "reviewed recovery source ID");
  const transaction = requiredText(transactionId, "reviewed recovery transaction ID");
  const recovery = normalizeReviewedRecoveryAuthority(reviewedRecoveryAuthority, {
    suppliedApply,
    sourceId: source,
    transactionId: transaction,
  });
  const apply = recovery?.historicalApply || suppliedApply;
  const selected = requiredObject(apply.plan?.selected, "reviewed selected source authority");
  if (selected.source?.source_id !== source) {
    throw new Error("Recovery runtime source differs from the reviewed apply plan.");
  }
  if (!Number.isSafeInteger(visualSourceCheckMinutes) || visualSourceCheckMinutes < 1) {
    throw new Error("Recovery visual source check interval is invalid.");
  }

  const state = Object.freeze({
    db,
    root: canonicalArchiveRoot(root),
    readR2Object,
    bucket,
    apply,
    selected,
    source,
    transaction,
    recovery,
    visualSourceCheckMinutes,
    lockTimeoutMs,
    now,
    clockAuthority: { lastMilliseconds: null },
    session: {
      successfulCommitResult: null,
      validatedRecoveryPlan: null,
      activeLockEpoch: null,
      activeLockReadOnly: null,
      nextLockEpoch: 0,
      mutationPromisesByEpoch: new Map(),
      acceptingMutations: false,
      topLevelMutationInFlightEpoch: null,
    },
  });

  const withSourceLock = async (request) => withExactSourceLock(state, request);
  const readRecoveryEvidence = async (request) => readExactRecoveryEvidence(state, request);
  const recoverActiveJournal = (request) => trackRecoveryMutationPromise(
    state,
    () => recoverExactActiveJournal(state, request),
  );
  const finishOriginalAudit = (request) => trackRecoveryMutationPromise(
    state,
    () => finishExactOriginalAudit(state, request),
  );

  return Object.freeze({
    inspectionInterfaces: Object.freeze({ readRecoveryEvidence, withSourceLock }),
    executionInterfaces: Object.freeze({
      finishOriginalAudit,
      readRecoveryEvidence,
      recoverActiveJournal,
      withSourceLock,
    }),
  });
}

function normalizeReviewedRecoveryAuthority(value, {
  suppliedApply,
  sourceId,
  transactionId,
} = {}) {
  if (value === null || value === undefined) return null;
  const authority = requiredObject(value, "reviewed recovery runtime authority");
  assertExactKeys(authority, [
    "applyPlanBytes",
    "expectedApplyPlanFileSha256",
    "expectedInspectionFileSha256",
    "expectedRecoveryPlanFileSha256",
    "expectedRecoveryPlanSha256",
    "manifest",
    "inspectionBytes",
    "recoveryPlanBytes",
    "reviewedDryRunReportBytes",
  ], "reviewed recovery runtime authority");
  const recoveryPlanBytes = exactBytes(
    authority.recoveryPlanBytes,
    "reviewed recovery plan",
  );
  const applyPlanBytes = exactBytes(authority.applyPlanBytes, "reviewed apply plan");
  const reportBytes = exactBytes(
    authority.reviewedDryRunReportBytes,
    "reviewed dry-run report",
  );
  const inspectionBytes = exactBytes(
    authority.inspectionBytes,
    "reviewed recovery inspection artifact",
  );
  const expectedRecoveryPlanFileSha256 = requiredSha256(
    authority.expectedRecoveryPlanFileSha256,
    "expected reviewed recovery plan file SHA-256",
  );
  const expectedRecoveryPlanSha256 = requiredSha256(
    authority.expectedRecoveryPlanSha256,
    "expected reviewed recovery plan self SHA-256",
  );
  if (sha256(recoveryPlanBytes) !== expectedRecoveryPlanFileSha256) {
    throw new Error("Reviewed recovery runtime plan bytes differ from the external file SHA-256.");
  }
  const parsed = parseJsonBytes(recoveryPlanBytes, "reviewed recovery plan");
  if (
    parsed.plan_sha256 !== expectedRecoveryPlanSha256
    || parsed.plan_sha256
      !== stage1EvidenceSchemaUpgradeReviewedRecoveryPlanSha256(parsed)
    || !recoveryPlanBytes.equals(
      stage1EvidenceSchemaUpgradeReviewedRecoveryPlanCanonicalBytes(parsed),
    )
  ) throw new Error("Reviewed recovery runtime plan self seal or canonical bytes differ.");
  const expiresAt = requiredTimestamp(
    parsed.reviewer?.expires_at,
    "reviewed recovery plan expires_at",
  );
  const reviewedAt = requiredTimestamp(
    parsed.reviewer?.reviewed_at,
    "reviewed recovery plan reviewed_at",
  );
  const historicalApply =
    validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence({
      planBytes: applyPlanBytes,
      expectedPlanFileSha256: requiredSha256(
        authority.expectedApplyPlanFileSha256,
        "expected reviewed apply plan file SHA-256",
      ),
      reportBytes,
      manifest: authority.manifest,
    });
  const inspected = assertStage1EvidenceSchemaUpgradeReviewedRecoveryInspectionArtifact({
    inspectionBytes,
    expectedInspectionFileSha256: requiredSha256(
      authority.expectedInspectionFileSha256,
      "expected reviewed recovery inspection file SHA-256",
    ),
    historical: historicalApply,
  });
  if (!sameJson(historicalApply, {
    ...structuredClone(suppliedApply),
    historical_evidence_only: true,
  })) {
    throw new Error("Reviewed recovery runtime historical parent differs from supplied apply authority.");
  }
  if (
    historicalApply.selected_source_id !== sourceId
    || stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
      sourceId,
      planSha256: historicalApply.plan_sha256,
    }) !== transactionId
  ) throw new Error("Reviewed recovery runtime parent apply authority differs from its source.");
  if (!sameJson(
    parsed.inspection,
    stage1EvidenceSchemaUpgradeReviewedRecoveryInspectionPlanBinding(inspected),
  )) throw new Error("Reviewed recovery runtime plan differs from its inspection artifact.");
  return Object.freeze({
    recoveryPlanBytes,
    expectedRecoveryPlanFileSha256,
    expectedRecoveryPlanSha256,
    applyPlanBytes,
    expectedApplyPlanFileSha256: requiredSha256(
      authority.expectedApplyPlanFileSha256,
      "expected reviewed apply plan file SHA-256",
    ),
    reviewedDryRunReportBytes: reportBytes,
    inspectionBytes,
    expectedInspectionFileSha256: requiredSha256(
      authority.expectedInspectionFileSha256,
      "expected reviewed recovery inspection file SHA-256",
    ),
    manifest: authority.manifest,
    historicalApply,
    plan: parsed,
    reviewedAt,
    expiresAt,
    expectedDisposition: requiredText(
      parsed.expected_disposition,
      "reviewed recovery expected disposition",
    ),
  });
}

async function withExactSourceLock(state, request) {
  const value = requiredObject(request, "reviewed recovery source lock request");
  const inspect = Object.hasOwn(value, "read_only");
  assertExactKeys(value, inspect
    ? ["creates_api_charge", "execute", "read_only", "source_id", "transaction_id"]
    : ["creates_api_charge", "execute", "source_id", "transaction_id"],
  "reviewed recovery source lock request");
  assertRuntimeIdentity(state, value);
  if (
    value.creates_api_charge !== false
    || (inspect && value.read_only !== true)
    || typeof value.execute !== "function"
  ) throw new Error("Reviewed recovery source lock request exceeds authority.");
  const sourceRoot = join(state.root, "sources", state.source);
  assertCanonicalMutationParent(
    state,
    join(sourceRoot, ".baseline.lock"),
    "source lock",
  );
  return withVisualBaselineLockAsync({
    archiveRoot: state.root,
    sourceId: state.source,
    timeoutMs: state.lockTimeoutMs,
    operation: async (lockReceipt) => {
      if (state.session.activeLockEpoch !== null) {
        throw new Error("Reviewed recovery source lock session is already active.");
      }
      const epoch = ++state.session.nextLockEpoch;
      state.session.activeLockEpoch = epoch;
      state.session.activeLockReadOnly = inspect;
      state.session.acceptingMutations = !inspect;
      state.session.mutationPromisesByEpoch.set(epoch, new Set());
      assertCanonicalDirectory(state, sourceRoot, "source lock parent");
      // Establish the runtime's monotonic clock authority inside the acquired
      // source lock and before user code can begin DB/R2 evidence reads.
      readNow(state);
      let result;
      let executionError = null;
      try {
        result = await value.execute(lockReceipt);
      } catch (error) {
        executionError = error;
      }
      state.session.acceptingMutations = false;
      try {
        const detachedError = await drainRecoveryMutationPromises(state, epoch);
        if (executionError) throw executionError;
        if (detachedError) {
          throw Object.assign(
            new Error("A detached reviewed recovery mutation failed before lock release."),
            { cause: detachedError },
          );
        }
        // Inspection is also bounded by the monotonic runtime clock: a clock
        // rollback during DB/R2 reads invalidates the read-only artifact.
        readNow(state);
        assertCanonicalDirectory(state, sourceRoot, "source lock parent");
        return result;
      } finally {
        state.session.mutationPromisesByEpoch.delete(epoch);
        if (state.session.activeLockEpoch === epoch) {
          state.session.activeLockEpoch = null;
          state.session.activeLockReadOnly = null;
          state.session.acceptingMutations = false;
        }
      }
    },
  });
}

function trackRecoveryMutationPromise(state, execute) {
  const epoch = assertActiveRecoveryLock(state);
  if (state.session.acceptingMutations !== true) {
    throw new Error("Reviewed recovery source lock is no longer accepting mutations.");
  }
  if (state.session.topLevelMutationInFlightEpoch !== null) {
    throw new Error("Reviewed recovery permits only one top-level mutation per source lock.");
  }
  const pending = state.session.mutationPromisesByEpoch.get(epoch);
  if (!(pending instanceof Set)) {
    throw new Error("Reviewed recovery mutation lock tracking is unavailable.");
  }
  state.session.topLevelMutationInFlightEpoch = epoch;
  const promise = Promise.resolve().then(execute).finally(() => {
    if (state.session.topLevelMutationInFlightEpoch === epoch) {
      state.session.topLevelMutationInFlightEpoch = null;
    }
  });
  void promise.catch(() => {});
  const entry = { promise, observed: false };
  const returnHandledDerived = (derived) => {
    // A caller may intentionally detach a success-only `.then()` or a
    // `.finally()`. Those do not observe the mutation rejection, but their
    // derived native promise would otherwise create unrelated unhandled-noise
    // before the lock drain reports the original failure deterministically.
    void derived.catch(() => {});
    return derived;
  };
  const exposed = {
    then(onFulfilled, onRejected) {
      if (typeof onRejected === "function") entry.observed = true;
      return returnHandledDerived(promise.then(onFulfilled, onRejected));
    },
    catch(onRejected) {
      if (typeof onRejected === "function") entry.observed = true;
      return returnHandledDerived(promise.catch(onRejected));
    },
    finally(onFinally) {
      return returnHandledDerived(promise.finally(onFinally));
    },
  };
  pending.add(entry);
  return exposed;
}

async function drainRecoveryMutationPromises(state, epoch) {
  const pending = state.session.mutationPromisesByEpoch.get(epoch);
  if (!(pending instanceof Set)) return null;
  let firstError = null;
  let observedSize = -1;
  while (observedSize !== pending.size) {
    observedSize = pending.size;
    const entries = [...pending];
    const settled = await Promise.allSettled(entries.map((entry) => entry.promise));
    const detachedFailureIndex = settled.findIndex(
      (result, index) => result.status === "rejected" && !entries[index].observed,
    );
    if (detachedFailureIndex >= 0) {
      firstError ||= settled[detachedFailureIndex].reason;
    }
  }
  return firstError;
}

async function readExactRecoveryEvidence(state, request) {
  const value = requiredObject(request, "reviewed recovery evidence request");
  const inspect = Object.hasOwn(value, "read_only");
  assertExactKeys(value, inspect
    ? [
        "creates_api_charge",
        "read_only",
        "reviewed_apply_plan_file_sha256",
        "reviewed_apply_plan_sha256",
        "source_id",
        "transaction_id",
      ]
    : [
        "creates_api_charge",
        "reviewed_apply_plan_file_sha256",
        "reviewed_apply_plan_sha256",
        "source_id",
        "transaction_id",
      ],
  "reviewed recovery evidence request");
  assertRuntimeIdentity(state, value);
  if (
    value.creates_api_charge !== false
    || (inspect && value.read_only !== true)
    || value.reviewed_apply_plan_file_sha256 !== state.apply.plan_file_sha256
    || value.reviewed_apply_plan_sha256 !== state.apply.plan_sha256
  ) throw new Error("Reviewed recovery evidence request differs from apply authority.");

  // Every call deliberately reloads every authority plane; no result is cached
  // across plan generation, business recovery, audit finish, or report replay.
  const [currentSource, acquisition, finalization, currentPointer, auditInspection] =
    await Promise.all([
      readCurrentSource(state),
      readCurrentAcquisition(state),
      readCurrentFinalization(state),
      readCurrentPointer(state),
      inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery({
        reviewedApplyPlan: state.apply,
        interfaces: { readRun: (auditRequest) => readAuditRun(state, auditRequest) },
      }),
    ]);
  const currentBaselineBytes = readBaselineBytes(state);
  const journals = readJournalLocations(state);
  const acquisitionProjection = acquisitionProjectionFromRow(acquisition);
  if (
    finalization.source_acquisition_id
      !== state.selected.acquisition.source_acquisition_id
    || stage1EvidenceSchemaUpgradeFinalizationReceiptSha256(finalization.receipt)
      !== finalization.finalization_receipt_sha256
    || comparePreciseRfc3339(
      finalization.finalized_at,
      finalization.receipt?.finalized_at,
    ) !== 0
    || comparePreciseRfc3339(
      finalization.finalized_at,
      currentSource.admin_reviewed_at,
    ) !== 0
  ) {
    throw new Error("Current reviewed recovery finalization authority changed.");
  }
  const activationProjection = {
    guard_sha256: finalization.guard_sha256,
    binding_reason: "stage1_baseline_activation_exact_binding_verified",
  };
  const finalizationProjection = {
    receipt_sha256: finalization.finalization_receipt_sha256,
    finalized_at: stage1EvidenceSchemaUpgradeCanonicalTimestamp(
      finalization.finalized_at,
    ),
  };
  for (const [observed, expected, label] of [
    [acquisitionProjection, state.selected.acquisition, "acquisition"],
    [activationProjection, state.selected.activation, "activation"],
    [finalizationProjection, state.selected.finalization, "finalization"],
  ]) {
    if (!sameJson(observed, expected)) {
      throw new Error(`Current reviewed recovery ${label} authority changed.`);
    }
  }
  const r2BindingReceipt = await verifyCurrentR2(state, {
    baselineBytes: stage1EvidenceSchemaUpgradeReviewedRecoveryR2AuthorityBaselineBytes({
      currentBaselineBytes,
      currentPointer,
      journals,
    }),
    pointer: currentPointer,
  });
  return deepFreeze({
    auditInspection,
    journals,
    currentAuthoritySnapshot: {
      currentSource,
      acquisitionProjection,
      activationProjection,
      finalizationProjection,
      currentBaselineBytes,
      currentPointer,
      r2BindingReceipt,
    },
  });
}

async function validateRecoveryMutationBoundary(
  state,
  request,
  { requireOriginalPlanState, mutationEpoch },
) {
  assertActiveRecoveryLock(state, mutationEpoch);
  const authority = state.recovery;
  if (!authority) {
    throw new Error("Reviewed recovery mutation runtime lacks the exact reviewed plan authority.");
  }
  const entryTime = readNow(state);
  if (
    request.recovery_plan_file_sha256 !== authority.expectedRecoveryPlanFileSha256
    || request.recovery_plan_sha256 !== authority.expectedRecoveryPlanSha256
    || request.recovery_plan_expires_at !== authority.expiresAt
    || Date.parse(entryTime) < Date.parse(authority.reviewedAt)
    || Date.parse(entryTime) >= Date.parse(authority.expiresAt)
  ) throw new Error("Reviewed recovery mutation request is outside its exact review authority.");
  const evidence = await readExactRecoveryEvidence(state, {
    source_id: state.source,
    transaction_id: state.transaction,
    reviewed_apply_plan_file_sha256: state.apply.plan_file_sha256,
    reviewed_apply_plan_sha256: state.apply.plan_sha256,
    creates_api_charge: false,
  });
  if (
    requiredSha256(
      request.expected_recovery_evidence_sha256,
      "expected reviewed recovery evidence SHA-256",
    ) !== stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256(evidence)
  ) throw new Error("Reviewed recovery live evidence changed at the mutation boundary.");
  const validationTime = readNow(state);
  if (
    Date.parse(validationTime) < Date.parse(entryTime)
    ||
    Date.parse(validationTime) < Date.parse(authority.reviewedAt)
    || Date.parse(validationTime) >= Date.parse(authority.expiresAt)
  ) throw new Error("Reviewed recovery plan expired during mutation-boundary evidence reads.");
  let validated = null;
  if (requireOriginalPlanState) {
    validated = validateStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
      planBytes: authority.recoveryPlanBytes,
      expectedPlanFileSha256: authority.expectedRecoveryPlanFileSha256,
      applyPlanBytes: authority.applyPlanBytes,
      expectedApplyPlanFileSha256: authority.expectedApplyPlanFileSha256,
      reviewedDryRunReportBytes: authority.reviewedDryRunReportBytes,
      manifest: authority.manifest,
      auditInspection: evidence.auditInspection,
      journals: evidence.journals,
      currentAuthoritySnapshot: evidence.currentAuthoritySnapshot,
      now: validationTime,
    });
    if (
      validated.plan_sha256 !== authority.expectedRecoveryPlanSha256
      || validated.plan_file_sha256 !== authority.expectedRecoveryPlanFileSha256
    ) throw new Error("Reviewed recovery mutation plan identity changed.");
  }
  const mutationTime = readNow(state);
  if (
    Date.parse(mutationTime) < Date.parse(validationTime)
    ||
    Date.parse(mutationTime) < Date.parse(authority.reviewedAt)
    || Date.parse(mutationTime) >= Date.parse(authority.expiresAt)
  ) throw new Error("Reviewed recovery plan expired immediately before mutation.");
  assertActiveRecoveryLock(state, mutationEpoch);
  return { evidence, validated, currentTime: mutationTime };
}

async function recoverExactActiveJournal(state, request) {
  const mutationEpoch = assertActiveRecoveryLock(state);
  const value = requiredObject(request, "reviewed active recovery request");
  const dual = Object.hasOwn(value, "expected_archived_journal_sha256");
  assertExactKeys(value, [
    "creates_api_charge",
    "expected_active_journal_sha256",
    "expected_audit_inspection_sha256",
    "expected_recovery_evidence_sha256",
    ...(dual ? ["expected_archived_journal_sha256"] : []),
    "operation_binding",
    "recovery_plan_expires_at",
    "recovery_plan_file_sha256",
    "recovery_plan_sha256",
    "source_id",
    "transaction_id",
  ], "reviewed active recovery request");
  assertRuntimeIdentity(state, value);
  if (value.creates_api_charge !== false) {
    throw new Error("Reviewed active recovery cannot create an API charge.");
  }
  assertReviewedActiveRecoveryDisposition(
    state.recovery?.expectedDisposition,
    dual,
  );
  const boundary = await validateRecoveryMutationBoundary(state, value, {
    requireOriginalPlanState: true,
    mutationEpoch,
  });
  if (
    boundary.validated.expected_disposition !== state.recovery.expectedDisposition
  ) throw new Error("Reviewed recovery plan does not authorize active journal mutation.");
  state.session.validatedRecoveryPlan = boundary.validated;
  const journals = boundary.evidence.journals;
  const active = journals.active;
  if (
    !active
    || active.journal_sha256 !== value.expected_active_journal_sha256
    || active.transaction_id !== state.transaction
    || !sameJson(active.operation_binding, value.operation_binding)
  ) throw new Error("Reviewed active journal changed before recovery mutation.");
  if (
    dual
      ? !journals.archived
        || journals.archived.journal_sha256 !== value.expected_archived_journal_sha256
        || journals.archived.journal_sha256 !== active.journal_sha256
      : journals.archived !== null
  ) throw new Error("Reviewed archived journal presence changed before recovery mutation.");
  const audit = boundary.evidence.auditInspection;
  if (audit.inspection_sha256 !== value.expected_audit_inspection_sha256) {
    throw new Error("Reviewed audit evidence changed before active recovery mutation.");
  }
  const result = await runStage1EvidenceSchemaUpgradeCommit({
    sourceId: state.source,
    transactionId: state.transaction,
    expectedActiveJournalSha256: value.expected_active_journal_sha256,
    operationBinding: value.operation_binding,
    interfaces: recoveryCommitInterfaces(state, active, mutationEpoch),
    now: () => readNow(state),
  });
  state.session.successfulCommitResult = result?.status === "upgraded"
    ? deepFreeze({
        result: structuredClone(result),
        start_journal: structuredClone(active),
      })
    : null;
  return result;
}

function assertReviewedActiveRecoveryDisposition(disposition, dual) {
  const allowed = dual
    ? new Set([
        "finish_partial_archive_then_fail",
        "finish_partial_archive_then_replay_candidate_success",
        "finish_partial_archive_then_replay_old_abandonment",
        "finish_partial_archive_then_succeed",
      ])
    : new Set([
        "resume_active_candidate_authority",
        "resume_active_old_authority",
      ]);
  if (!allowed.has(disposition)) {
    throw new Error("Reviewed recovery plan does not authorize active journal mutation.");
  }
}

async function finishExactOriginalAudit(state, request) {
  const mutationEpoch = assertActiveRecoveryLock(state);
  const value = requiredObject(request, "reviewed recovery audit finish request");
  assertExactKeys(value, [
    "creates_api_charge",
    "completion_authority",
    "execution_nonce",
    "expected_audit_inspection_sha256",
    "expected_recovery_evidence_sha256",
    "finished_at",
    "recovery_plan_expires_at",
    "recovery_plan_file_sha256",
    "recovery_plan_sha256",
    "reviewed_apply_plan_file_sha256",
    "reviewed_apply_plan_sha256",
    "source_id",
    "terminal",
    "transaction_id",
  ], "reviewed recovery audit finish request");
  assertRuntimeIdentity(state, value);
  if (
    value.creates_api_charge !== false
    || value.reviewed_apply_plan_file_sha256 !== state.apply.plan_file_sha256
    || value.reviewed_apply_plan_sha256 !== state.apply.plan_sha256
  ) throw new Error("Reviewed recovery audit finish request differs from apply authority.");
  const requestedTerminal = requiredObject(
    value.terminal,
    "reviewed recovery audit terminal",
  );
  const requestedStatus = recoveryDispositionTerminalStatus(
    state.recovery?.expectedDisposition,
  );
  if (requestedTerminal.status !== requestedStatus) {
    throw new Error("Reviewed recovery plan does not authorize this audit terminal outcome.");
  }
  const boundary = await validateRecoveryMutationBoundary(state, value, {
    requireOriginalPlanState: !recoveryDispositionRequiresPriorBusinessMutation(
      state.recovery.expectedDisposition,
    ),
    mutationEpoch,
  });
  const validatedCompletionPlan = boundary.validated
    || state.session.validatedRecoveryPlan;
  if (
    !validatedCompletionPlan
    || validatedCompletionPlan.plan_file_sha256
      !== state.recovery.expectedRecoveryPlanFileSha256
    || validatedCompletionPlan.plan_sha256
      !== state.recovery.expectedRecoveryPlanSha256
  ) throw new Error("Reviewed recovery audit finish lacks its fully validated plan.");
  const completionAuthority =
    stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority({
      recoveryPlan: validatedCompletionPlan.plan,
      expectedRecoveryPlanFileSha256: validatedCompletionPlan.plan_file_sha256,
      expectedRecoveryPlanSha256: validatedCompletionPlan.plan_sha256,
      sourceId: state.source,
      transactionId: state.transaction,
    });
  if (!sameJson(value.completion_authority, completionAuthority)) {
    throw new Error("Reviewed recovery audit completion authority differs from its plan.");
  }
  const finishedAt = requiredTimestamp(
    value.finished_at,
    "reviewed recovery audit finished_at",
  );
  if (
    Date.parse(finishedAt) < Date.parse(state.recovery.reviewedAt)
    || Date.parse(finishedAt) >= Date.parse(state.recovery.expiresAt)
    || Date.parse(finishedAt) > Date.parse(boundary.currentTime)
  ) throw new Error("Reviewed recovery audit finish time exceeds its reviewed window.");
  const terminal = requestedTerminal;
  assertRecoveryTerminalBusinessOutcome(state, boundary, terminal);
  const audit = boundary.evidence.auditInspection;
  if (audit.inspection_sha256 !== value.expected_audit_inspection_sha256) {
    throw new Error("Reviewed audit row changed before its terminal mutation.");
  }
  return finishStage1EvidenceSchemaUpgradeReviewedApplyAudit({
    reviewedApplyPlan: state.apply,
    executionNonce: value.execution_nonce,
    finishedAt: value.finished_at,
    terminal: value.terminal,
    completionAuthority,
    interfaces: {
      readRun: (auditRequest) => readAuditRun(state, auditRequest),
      updateRun: (updateRequest) => updateAuditRun(state, updateRequest, mutationEpoch),
    },
  });
}

function recoveryDispositionRequiresPriorBusinessMutation(disposition) {
  return new Set([
    "finish_partial_archive_then_fail",
    "finish_partial_archive_then_succeed",
    "resume_active_candidate_authority",
    "resume_active_old_authority",
  ]).has(disposition);
}

function recoveryDispositionTerminalStatus(disposition) {
  if (new Set([
    "finish_failed_audit_started_before_journal",
    "finish_failed_from_archived_old",
    "finish_partial_archive_then_fail",
    "resume_active_old_authority",
  ]).has(disposition)) return "failed";
  if (new Set([
    "finish_partial_archive_then_succeed",
    "finish_succeeded_from_archived_candidate",
    "resume_active_candidate_authority",
  ]).has(disposition)) return "succeeded";
  throw new Error("Reviewed recovery disposition does not authorize an audit terminal write.");
}

function assertRecoveryTerminalBusinessOutcome(state, boundary, terminal) {
  const { journals, currentAuthoritySnapshot: snapshot } = boundary.evidence;
  if (journals.active !== null) {
    throw new Error("Reviewed recovery cannot terminalize while an active journal remains.");
  }
  const audit = boundary.evidence.auditInspection;
  const archived = journals.archived
    ? assertStage1EvidenceSchemaUpgradeJournal(journals.archived)
    : null;
  if (
    archived
    && !sameJson(archived.operation_binding, state.recovery.plan.operation_binding)
  ) throw new Error("Reviewed recovery archived journal differs from the reviewed operation.");
  const candidateBytes = archived
    ? stage1EvidenceSchemaUpgradeBaselineBytes(archived.candidate_baseline)
    : null;
  const authority = projectStage1EvidenceSchemaUpgradeReviewedRecoveryAuthority({
    ...snapshot,
    sourceId: state.source,
    auditedSourceAuthority: audit.authority_receipt.source_authority,
    candidateBaselineBytes: candidateBytes,
  });
  if (terminal.status === "succeeded") {
    if (!archived) {
      throw new Error("Reviewed recovery success requires an exact completed archive.");
    }
    const proof = proveStage1EvidenceSchemaUpgradeArchivedCompletion({
      journal: archived,
      expectedJournalSha256: archived.journal_sha256,
      expectedTransactionId: state.transaction,
      expectedOperationBinding: state.recovery.plan.operation_binding,
      currentBaselineBytes: snapshot.currentBaselineBytes,
      currentPointer: snapshot.currentPointer,
    });
    if (
      proof.authority !== "candidate"
      || authority.source_health_classification !== "exact_already_current"
    ) throw new Error("Reviewed recovery success authority is not exactly candidate-complete.");
    assertStage1EvidenceSchemaUpgradeReviewedRecoveryCandidateR2Pointer(
      snapshot.currentPointer,
    );
    const evaluatedAt = requiredTimestamp(
      terminal.selected_result?.evaluated_at,
      "reviewed recovery selected result evaluated_at",
    );
    if (
      Date.parse(evaluatedAt) < Date.parse(state.recovery.reviewedAt)
      || Date.parse(evaluatedAt) >= Date.parse(state.recovery.expiresAt)
      || Date.parse(evaluatedAt) > Date.parse(boundary.currentTime)
    ) throw new Error("Reviewed recovery selected result time exceeds its reviewed window.");
    if (state.recovery.expectedDisposition === "finish_succeeded_from_archived_candidate") {
      const expected = buildStage1EvidenceSchemaUpgradeReviewedRecoveryArchivedSucceededTerminal({
        sourceId: state.source,
        transactionId: state.transaction,
        journal: archived,
        auditInspection: audit,
        evaluatedAt,
      });
      if (!sameJson(terminal, expected)) {
        throw new Error("Reviewed recovery archived replay terminal is not exact.");
      }
    } else {
      const cached = state.session.successfulCommitResult;
      if (!cached || !sameJson(terminal.commit_receipt, cached.result.receipt)) {
        throw new Error("Reviewed recovery success does not match this runtime invocation.");
      }
      assertStage1EvidenceSchemaUpgradeReviewedRecoverySucceededTerminal({
        sourceId: state.source,
        transactionId: state.transaction,
        journal: cached.start_journal,
        auditInspection: audit,
        selectedResult: terminal.selected_result,
        commitReceipt: terminal.commit_receipt,
        receiptProfile: recoverySuccessReceiptProfile(state.recovery.plan),
        accountingProfile: "current_invocation_verified_archive",
      });
    }
    return;
  }
  const expectedFailure =
    stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition(
      state.recovery.expectedDisposition,
    );
  if (!sameJson(terminal, expectedFailure)) {
    throw new Error("Reviewed recovery failed terminal narrative differs from its disposition.");
  }
  if (authority.source_health_classification !== "exact_precommit") {
    throw new Error("Reviewed recovery failure authority is not exactly precommit.");
  }
  if (state.recovery.expectedDisposition === "finish_failed_audit_started_before_journal") {
    const selected = state.apply.plan.selected;
    assertStage1EvidenceSchemaUpgradeReviewedRecoveryOldR2Authority({
      currentAuthority: authority,
      selected,
      auditInspection: audit,
    });
    if (
      archived !== null
      || !sameJson(authority.local_baseline_identity, {
        present: true,
        ...selected.local_baseline_identity,
      })
      || !sameJson(authority.pointer_identity, selected.existing_pointer_identity)
      || authority.r2_binding_receipt_sha256 !== selected.r2.binding_receipt_sha256
    ) throw new Error("Reviewed recovery pre-journal failure changed old authority.");
    return;
  }
  if (!archived) {
    throw new Error("Reviewed recovery old-authority failure requires its completed archive.");
  }
  const proof = proveStage1EvidenceSchemaUpgradeArchivedCompletion({
    journal: archived,
    expectedJournalSha256: archived.journal_sha256,
    expectedTransactionId: state.transaction,
    expectedOperationBinding: state.recovery.plan.operation_binding,
    currentBaselineBytes: snapshot.currentBaselineBytes,
    currentPointer: snapshot.currentPointer,
  });
  if (proof.authority !== "old") {
    throw new Error("Reviewed recovery failed terminal is not exact archived old authority.");
  }
  assertStage1EvidenceSchemaUpgradeReviewedRecoveryOldR2Authority({
    currentAuthority: authority,
    selected: state.apply.plan.selected,
    auditInspection: audit,
  });
}

function recoverySuccessReceiptProfile(plan) {
  if (plan.expected_disposition === "finish_succeeded_from_archived_candidate") {
    return "committed_candidate";
  }
  if (plan.expected_disposition === "finish_partial_archive_then_succeed") {
    return "candidate_authority_recovered";
  }
  if (plan.expected_disposition === "resume_active_candidate_authority") {
    return plan.journal?.active?.phase === "completed"
      ? "candidate_authority_recovered"
      : "committed_candidate";
  }
  throw new Error("Reviewed recovery disposition has no successful receipt profile.");
}

function recoveryCommitInterfaces(state, initialJournal, mutationEpoch) {
  const precommitSourceAuthority = initialJournal.operation_binding.precommit_source_authority;
  return {
    async loadActiveJournal({ source_id: sourceId }) {
      assertSource(state, sourceId);
      return readActiveJournal(state);
    },
    async persistActiveJournalAtomically(request) {
      assertExactKeys(request, [
        "expected_journal_sha256",
        "journal",
        "source_id",
        "transaction_id",
      ], "reviewed recovery journal persistence request");
      assertRuntimeIdentity(state, request);
      const journal = assertStage1EvidenceSchemaUpgradeJournal(request.journal);
      const current = readActiveJournal(state);
      if (
        journal.source_id !== state.source
        || journal.transaction_id !== state.transaction
        || !sameJson(journal.operation_binding, initialJournal.operation_binding)
        || current?.journal_sha256 !== request.expected_journal_sha256
      ) throw new Error("Reviewed recovery active journal CAS precondition failed.");
      assertRecoveryMutationWindow(state, undefined, mutationEpoch);
      atomicWriteJson(state, journalPaths(state).active, journal, "active journal");
      return { status: "persisted", journal_sha256: journal.journal_sha256 };
    },
    async archiveCompletedJournalAtomically(request) {
      assertExactKeys(request, [
        "creates_api_charge",
        "expected_journal_sha256",
        "journal",
        "source_id",
        "transaction_id",
      ], "reviewed recovery journal archive request");
      assertRuntimeIdentity(state, request);
      if (request.creates_api_charge !== false) {
        throw new Error("Reviewed recovery journal archive cannot create an API charge.");
      }
      const journal = assertStage1EvidenceSchemaUpgradeJournal(request.journal);
      const paths = journalPaths(state);
      const active = readActiveJournal(state);
      const archived = readArchivedJournal(state);
      if (
        journal.phase !== "completed"
        || journal.journal_sha256 !== request.expected_journal_sha256
        || active?.journal_sha256 !== request.expected_journal_sha256
        || (archived && archived.journal_sha256 !== request.expected_journal_sha256)
        || !sameJson(journal.operation_binding, initialJournal.operation_binding)
      ) throw new Error("Reviewed completed journal archive identity changed.");
      if (!archived) {
        assertRecoveryMutationWindow(state, undefined, mutationEpoch);
        atomicWriteJson(state, paths.archived, journal, "completed journal archive");
      }
      const verified = readArchivedJournal(state);
      if (verified?.journal_sha256 !== request.expected_journal_sha256) {
        throw new Error("Reviewed completed journal archive readback failed.");
      }
      assertRecoveryMutationWindow(state, undefined, mutationEpoch);
      removeCanonicalFile(state, paths.active, "completed active journal");
      return {
        status: "archived",
        source_id: state.source,
        transaction_id: state.transaction,
        journal_sha256: journal.journal_sha256,
        creates_api_charge: false,
      };
    },
    async readArchivedJournal({ source_id: sourceId, transaction_id: transactionId }) {
      assertSource(state, sourceId);
      if (transactionId !== state.transaction) throw new Error("Archived journal transaction changed.");
      return readArchivedJournal(state);
    },
    async readBaselineBytes({ source_id: sourceId }) {
      assertSource(state, sourceId);
      return readBaselineBytes(state);
    },
    async writeBaselineBytesAtomically(request) {
      assertExactKeys(request, [
        "bytes",
        "expected_byte_length",
        "expected_sha256",
        "source_id",
      ], "reviewed recovery baseline write request");
      assertSource(state, request.source_id);
      const bytes = request.bytes === null ? null : Buffer.from(request.bytes);
      if (
        bytes === null
          ? request.expected_sha256 !== null || request.expected_byte_length !== 0
          : bytes.byteLength !== request.expected_byte_length
            || sha256(bytes) !== request.expected_sha256
      ) throw new Error("Reviewed recovery baseline bytes differ from journal authority.");
      assertRecoveryMutationWindow(state, undefined, mutationEpoch);
      atomicWriteBytes(state, baselinePath(state), bytes, "authoritative baseline");
      return { status: bytes === null ? "removed" : "written" };
    },
    async readLatestPointer({ source_id: sourceId }) {
      assertSource(state, sourceId);
      return readCurrentPointer(state);
    },
    async markSourceHealthSucceeded(request) {
      const exact = assertStage1EvidenceSchemaUpgradeReviewedRecoverySourceHealthRequest({
        request,
        sourceId: state.source,
        transactionId: state.transaction,
        initialJournal,
      });
      return markExactSourceHealthSucceeded(state, {
        candidateBaselineSha256: exact.candidate_baseline_sha256,
        precommitSourceAuthority,
        mutationEpoch,
      });
    },
  };
}

export function assertStage1EvidenceSchemaUpgradeReviewedRecoverySourceHealthRequest({
  request,
  sourceId,
  transactionId,
  initialJournal,
} = {}) {
  const value = requiredObject(request, "reviewed recovery source-health request");
  assertExactKeys(value, [
    "authoritative_pointer",
    "candidate_baseline_sha256",
    "context",
    "creates_api_charge",
    "precommit_source_authority",
    "preserve_reviewed_metadata",
    "preserve_reviewed_url",
    "source_id",
    "transaction_id",
  ], "reviewed recovery source-health request");
  const journal = assertStage1EvidenceSchemaUpgradeJournal(initialJournal);
  if (
    value.source_id !== sourceId
    || value.transaction_id !== transactionId
    || journal.source_id !== sourceId
    || journal.transaction_id !== transactionId
    || value.context !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_CONTEXT
    || value.creates_api_charge !== false
    || value.preserve_reviewed_url !== true
    || value.preserve_reviewed_metadata !== true
    || value.candidate_baseline_sha256 !== journal.candidate_baseline.sha256
    || !sameJson(value.authoritative_pointer, journal.candidate_pointer_identity.projection)
    || !sameJson(
      value.precommit_source_authority,
      journal.operation_binding.precommit_source_authority,
    )
  ) throw new Error("Reviewed recovery source-health request differs from journal authority.");
  return deepFreeze({ ...value });
}

async function markExactSourceHealthSucceeded(state, {
  candidateBaselineSha256,
  precommitSourceAuthority,
  mutationEpoch,
}) {
  const bytes = readBaselineBytes(state);
  if (!bytes || sha256(bytes) !== candidateBaselineSha256) {
    throw new Error("Reviewed recovery source health requires the exact candidate baseline.");
  }
  const before = await readCurrentSource(state);
  const beforeClassification = classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority({
    precommitSourceAuthority,
    currentSource: before,
    candidateBaselineBytes: bytes,
  }).classification;
  if (beforeClassification === "exact_already_current") {
    return sourceHealthReceipt(state, "already_current", 0);
  }
  if (beforeClassification !== "exact_precommit") {
    throw new Error("Reviewed recovery source health authority changed before mutation.");
  }
  const baseline = parseJsonBytes(bytes, "reviewed recovery candidate baseline");
  const hash = [
    baseline.file_hash,
    baseline.main_content_hash,
    baseline.image_hash,
    baseline.text_hash,
  ].find((entry) => typeof entry === "string" && entry.trim());
  if (!hash) throw new Error("Reviewed recovery candidate baseline has no visual hash.");
  const checkedAt = readNow(state);
  assertRecoveryMutationWindow(state, checkedAt, mutationEpoch);
  if (Date.parse(checkedAt) < Date.parse(baseline.captured_at)) {
    throw new Error("Reviewed recovery source-health time precedes candidate capture.");
  }
  const nextCheckAt = new Date(
    Date.parse(checkedAt) + state.visualSourceCheckMinutes * 60_000,
  ).toISOString();
  let mutation = state.db.from("shared_award_sources").update({
    last_hash: `visual:${hash.trim()}`,
    last_checked_at: checkedAt,
    next_check_at: nextCheckAt,
    consecutive_failures: 0,
    last_error: null,
    updated_at: checkedAt,
  }).eq("id", state.source);
  mutation = guardAdminReviewMutation(mutation, before, {
    requiredStatus: before.admin_review_status,
  });
  mutation = guardStage1EvidenceSchemaUpgradeReviewedRecoverySourcePreimage(
    mutation,
    before,
  );
  const { data, error } = await mutation.select("id").maybeSingle();
  if (error) throw new Error(describeDbError(error, "update reviewed recovery source health"));
  const after = await readCurrentSource(state);
  const afterClassification = classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority({
    precommitSourceAuthority,
    currentSource: after,
    candidateBaselineBytes: bytes,
  }).classification;
  if (afterClassification !== "exact_already_current") {
    throw new Error("Reviewed recovery source-health update did not read back exactly.");
  }
  return sourceHealthReceipt(state, data ? "succeeded" : "already_current", data ? 1 : 0);
}

function sourceHealthReceipt(state, status, writes) {
  return deepFreeze({
    status,
    source_id: state.source,
    context: "stage1_evidence_schema_upgrade",
    creates_api_charge: false,
    mutation_counts: {
      ...zeroStage1EvidenceSchemaUpgradeMutationCounts(),
      database_writes: writes,
      source_state_writes: writes,
    },
  });
}

export function guardStage1EvidenceSchemaUpgradeReviewedRecoverySourcePreimage(
  query,
  source,
) {
  let guarded = query;
  for (const column of
    STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_SOURCE_PREIMAGE_COLUMNS) {
    const value = source?.[column];
    guarded = value === null || value === undefined
      ? guarded.is(column, null)
      : guarded.eq(column, value);
  }
  return guarded;
}

async function readCurrentSource(state) {
  const { data, error } = await state.db
    .from("shared_award_sources")
    .select(SOURCE_COLUMNS)
    .eq("id", state.source)
    .maybeSingle();
  if (error) throw new Error(describeDbError(error, "read reviewed recovery source"));
  const projection = projectStage1EvidenceSchemaUpgradeSourceHealthAuthority(data);
  if (projection.id !== state.source) throw new Error("Reviewed recovery source is missing.");
  return projection;
}

async function readCurrentAcquisition(state) {
  const id = state.selected.acquisition.source_acquisition_id;
  const { data, error } = await state.db
    .from("shared_award_source_acquisitions")
    .select(ACQUISITION_COLUMNS)
    .eq("id", id)
    .eq("shared_award_source_id", state.source)
    .maybeSingle();
  if (error) throw new Error(describeDbError(error, "read reviewed recovery acquisition"));
  if (!data) throw new Error("Reviewed recovery acquisition is missing.");
  return data;
}

async function readCurrentFinalization(state) {
  const { data, error } = await state.db.rpc(
    "get_stage1_source_activation_finalizations",
    { p_source_ids: [state.source] },
  );
  if (error) throw new Error(describeDbError(error, "read reviewed recovery finalization"));
  const rows = Array.isArray(data) ? data : [];
  if (
    rows.length !== 1
    || rows[0]?.shared_award_source_id !== state.source
    || !sameJson(Object.keys(rows[0]).sort(), [...FINALIZATION_KEYS].sort())
  ) throw new Error("Reviewed recovery finalization lookup was not exact.");
  return rows[0];
}

async function readCurrentPointer(state) {
  const { data, error } = await state.db
    .from("shared_award_source_visual_snapshots")
    .select(POINTER_COLUMNS)
    .eq("shared_award_source_id", state.source)
    .maybeSingle();
  if (error) throw new Error(describeDbError(error, "read reviewed recovery pointer"));
  if (!data) throw new Error("Reviewed recovery authoritative pointer is missing.");
  if (data.bucket !== state.bucket) {
    throw new Error("Reviewed recovery pointer bucket differs from configured read authority.");
  }
  return data;
}

async function readAuditRun(state, { run_id: runId }) {
  const { data, error } = await state.db
    .from("local_worker_runs")
    .select(AUDIT_COLUMNS)
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(describeDbError(error, "read reviewed recovery audit row"));
  return data ?? null;
}

async function updateAuditRun(state, { guard, patch }, mutationEpoch) {
  assertRecoveryMutationWindow(state, undefined, mutationEpoch);
  let mutation = state.db
    .from("local_worker_runs")
    .update(patch)
    .eq("id", guard.id)
    .eq("worker_name", guard.worker_name)
    .eq("status", guard.status)
    .contains("metadata", {
      audit_mode: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_MODE,
      phase: "running",
      execution_nonce: guard.execution_nonce,
      metadata_sha256: guard.running_metadata_sha256,
      binding: { plan: {
        file_sha256: guard.plan_file_sha256,
        self_sha256: guard.plan_sha256,
      } },
    });
  const { data, error } = await mutation.select(AUDIT_COLUMNS).maybeSingle();
  if (error) throw new Error(describeDbError(error, "finish reviewed recovery audit row"));
  return data ?? null;
}

function acquisitionProjectionFromRow(row) {
  const acquisition = requiredObject(row, "reviewed recovery acquisition row");
  const seal = requiredObject(acquisition.review_seal, "reviewed recovery acquisition seal");
  const disposition = requiredObject(
    seal.human_source_disposition,
    "reviewed recovery source disposition",
  );
  const guard = requiredObject(disposition.activation_guard, "reviewed recovery activation guard");
  const review = requiredObject(
    disposition.effective_source_review,
    "reviewed recovery effective source review",
  );
  const retained = requiredObject(seal.retained_artifact, "reviewed recovery retained artifact");
  const quotes = Array.isArray(review.evidence_quotes) ? review.evidence_quotes : [];
  return {
    source_acquisition_id: acquisition.id,
    file_sha256: retained.file_hash || guard.capture_file_sha256,
    text_sha256: retained.text_hash || null,
    normalized_text_sha256: guard.normalized_retained_text_sha256,
    evidence_quote_count: quotes.length,
  };
}

export function stage1EvidenceSchemaUpgradeReviewedRecoveryR2AuthorityBaselineBytes({
  currentBaselineBytes,
  currentPointer,
  journals,
} = {}) {
  const journal = journals.active || journals.archived;
  if (!journal) return currentBaselineBytes;
  const pointerIdentity = visualSnapshotPointerIdentity(currentPointer);
  if (pointerIdentity.canonical_sha256 === journal.old_pointer_identity.canonical_sha256) {
    return stage1EvidenceSchemaUpgradeBaselineBytes(journal.old_baseline);
  }
  if (
    pointerIdentity.canonical_sha256
      === journal.candidate_pointer_identity.canonical_sha256
  ) {
    return stage1EvidenceSchemaUpgradeBaselineBytes(journal.candidate_baseline);
  }
  throw new Error(
    "Reviewed recovery current pointer matches neither journaled R2 generation.",
  );
}

async function verifyCurrentR2(state, { baselineBytes, pointer }) {
  const baseline = parseJsonBytes(baselineBytes, "reviewed recovery current baseline");
  const capture = captureFromBaseline(state, baseline);
  const roleFiles = localRoleFiles(capture, pointer);
  const prepared = prepareR2CaptureArtifacts(roleFiles, { readFile: readFileSync });
  const pointerBindings = plainObject(pointer.latest_metadata?.artifact_bindings);
  const remoteEntries = await Promise.all(
    Object.entries(requiredObject(pointer.latest_object_keys, "reviewed recovery R2 roles"))
      .map(async ([role, key]) => {
        const localBinding = requiredObject(
          prepared.artifactBindings?.[role],
          `reviewed recovery local ${role} artifact binding`,
        );
        const pointerBinding = pointerBindings[role] === undefined
          ? null
          : requiredObject(
              pointerBindings[role],
              `reviewed recovery pointer ${role} artifact binding`,
            );
        const expectedByteLength = localBinding.byte_length;
        if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0) {
          throw new Error(`Reviewed recovery R2 ${role} byte length is invalid.`);
        }
        if (
          pointerBinding
          && pointerBinding.byte_length !== expectedByteLength
        ) throw new Error(`Reviewed recovery R2 ${role} pointer byte length changed.`);
        const response = requiredObject(await state.readR2Object(deepFreeze({
          bucket: pointer.bucket,
          key,
          expected_byte_length: expectedByteLength,
          creates_api_charge: false,
          mutation_performed: false,
        })), "reviewed recovery R2 read receipt");
        assertExactKeys(response, [
          "body",
          "bucket",
          "byte_length",
          "content_type",
          "creates_api_charge",
          "expected_byte_length",
          "key",
          "mutation_performed",
        ], "reviewed recovery R2 read receipt");
        const body = Buffer.from(response.body);
        if (
          response.bucket !== pointer.bucket
          || response.key !== key
          || response.creates_api_charge !== false
          || response.mutation_performed !== false
          || response.expected_byte_length !== expectedByteLength
          || response.byte_length !== body.byteLength
          || body.byteLength !== expectedByteLength
        ) throw new Error("Reviewed recovery R2 read receipt is not exact.");
        return [role, {
          key,
          body,
          content_type: cleanText(response.content_type) || null,
          byte_length: response.byte_length,
          ...(Object.hasOwn(pointerBindings, role)
            ? { binding: pointerBindings[role] }
            : {}),
        }];
      }),
  );
  return verifyStage1EvidenceSchemaUpgradeR2Binding({
    sourceId: state.source,
    sourceKind: capture.kind,
    existingBaseline: baseline,
    existingCapture: capture,
    localPreparedArtifacts: prepared,
    r2Pointer: pointer,
    remoteArtifactsByRole: Object.fromEntries(remoteEntries),
  });
}

function captureFromBaseline(state, baseline) {
  const capturePaths = requiredObject(baseline.capture, "reviewed recovery baseline capture");
  const metaPath = archivePath(state, capturePaths.meta);
  const textPath = archivePath(state, capturePaths.text);
  const meta = parseJsonBytes(readFileSync(metaPath), "reviewed recovery capture metadata");
  const layoutPath = capturePaths.layout ? archivePath(state, capturePaths.layout) : null;
  const expansionTextPath = capturePaths.expansion_text
    ? archivePath(state, capturePaths.expansion_text)
    : null;
  const sectionsTextPath = capturePaths.sections_text
    ? archivePath(state, capturePaths.sections_text)
    : null;
  const sectionsJsonPath = capturePaths.sections_json
    ? archivePath(state, capturePaths.sections_json)
    : null;
  const mainGeometry = layoutPath
    ? parseJsonBytes(readFileSync(layoutPath), "reviewed recovery capture layout")
    : plainObject(meta.text_geometry);
  const metadataStates = Array.isArray(meta.expansion_state_screenshots)
    ? meta.expansion_state_screenshots
    : [];
  const expansionStateScreenshots = (Array.isArray(capturePaths.expansion_states)
    ? capturePaths.expansion_states
    : []).map((retained, index) => {
      const retainedState = requiredObject(
        retained,
        `reviewed recovery retained expansion state ${index + 1}`,
      );
      const retainedId = cleanText(retainedState.state_id);
      const metadata = plainObject(
        metadataStates.find((entry) => retainedId && entry?.state_id === retainedId)
        || metadataStates[index],
      );
      const pagePath = archivePath(
        state,
        requiredText(retainedState.page, `retained expansion state ${index + 1} page`),
      );
      const stateLayoutPath = archivePath(
        state,
        requiredText(retainedState.layout, `retained expansion state ${index + 1} layout`),
      );
      const geometry = parseJsonBytes(
        readFileSync(stateLayoutPath),
        `reviewed recovery expansion state ${index + 1} layout`,
      );
      return {
        ...retainedState,
        ...metadata,
        state_id: cleanText(metadata.state_id || retainedState.state_id) || null,
        index: Number.isSafeInteger(metadata.index)
          ? metadata.index
          : Number.isSafeInteger(retainedState.index) ? retainedState.index : index,
        label: cleanText(metadata.label || retainedState.label) || null,
        captured_at: cleanText(metadata.captured_at || retainedState.captured_at) || null,
        image_hash: cleanText(metadata.image_hash || retainedState.image_hash) || null,
        layout_hash: cleanText(
          metadata.layout_hash || retainedState.layout_hash || geometry.geometry_hash,
        ) || null,
        text_geometry: geometry,
        text_hash: cleanText(metadata.text_hash || retainedState.text_hash) || null,
        text_length: Number.isSafeInteger(metadata.text_length)
          ? metadata.text_length
          : retainedState.text_length,
        page_bytes: Number.isSafeInteger(metadata.page_bytes)
          ? metadata.page_bytes
          : retainedState.page_bytes,
        isolation: metadata.isolation || retainedState.isolation || null,
        page_path: pagePath,
        layout_path: stateLayoutPath,
      };
    });
  return {
    ...meta,
    kind: baseline.kind || (capturePaths.pdf ? "pdf" : "webpage"),
    dir: capturePaths.dir
      ? archiveDirectoryPath(state, capturePaths.dir)
      : dirname(metaPath),
    source: Object.keys(plainObject(meta.source)).length ? meta.source : baseline.source,
    page_path: capturePaths.page ? archivePath(state, capturePaths.page) : null,
    thumb_path: capturePaths.thumb ? archivePath(state, capturePaths.thumb) : null,
    pdf_path: capturePaths.pdf ? archivePath(state, capturePaths.pdf) : null,
    text_path: textPath,
    expansion_text_path: expansionTextPath,
    sections_text_path: sectionsTextPath,
    sections_json_path: sectionsJsonPath,
    layout_path: layoutPath,
    text_geometry: mainGeometry,
    meta_path: metaPath,
    text: readFileSync(textPath, "utf8"),
    captured_at: baseline.captured_at || meta.captured_at || null,
    final_url: baseline.final_url || meta.final_url || null,
    page_title: baseline.page_title || meta.page_title || null,
    section_extraction_profile:
      baseline.section_extraction_profile || meta.section_extraction_profile || null,
    text_hash: baseline.text_hash || meta.text_hash || null,
    image_hash: baseline.image_hash || meta.image_hash || baseline.file_hash || null,
    layout_hash: baseline.layout_hash || meta.layout_hash || null,
    file_hash: baseline.file_hash || meta.file_hash || null,
    file_bytes: baseline.file_bytes || meta.file_bytes || null,
    text_length: baseline.text_length || meta.text_length || 0,
    body_text_hash: baseline.body_text_hash || meta.body_text_hash || null,
    main_content_hash: baseline.main_content_hash || meta.main_content_hash || null,
    nav_header_footer_hash:
      baseline.nav_header_footer_hash || meta.nav_header_footer_hash || null,
    expansion_hash: baseline.expansion_hash || meta.expansion_hash || null,
    expandable_sections_hash:
      baseline.expandable_sections_hash || meta.expandable_sections_hash || null,
    body_text_length: baseline.body_text_length || meta.body_text_length || 0,
    main_content_text_length:
      baseline.main_content_text_length || meta.main_content_text_length || 0,
    nav_header_footer_text_length:
      baseline.nav_header_footer_text_length || meta.nav_header_footer_text_length || 0,
    expansion_text_length:
      baseline.expansion_text_length || meta.expansion_text_length || 0,
    section_text_length: baseline.section_text_length || meta.section_text_length || 0,
    expandable_sections:
      Array.isArray(baseline.expandable_sections) && baseline.expandable_sections.length
        ? baseline.expandable_sections
        : Array.isArray(meta.expandable_sections) ? meta.expandable_sections : [],
    dimensions: baseline.dimensions || meta.dimensions || null,
    hidden_noise_counts: baseline.hidden_noise_counts || meta.hidden_noise_counts || null,
    baseline_facts:
      baseline.summary_metadata?.baseline_facts || meta.baseline_facts || null,
    baseline_facts_metadata:
      baseline.summary_metadata?.baseline_facts_metadata
      || meta.baseline_facts_metadata
      || null,
    page_bytes: baseline.page_bytes || meta.page_bytes || null,
    thumb_bytes: baseline.thumb_bytes || meta.thumb_bytes || null,
    ...((meta.retained_artifact_projection
      || baseline.summary_metadata?.retained_artifact_projection)
      ? {
          retained_artifact_projection:
            meta.retained_artifact_projection
            || baseline.summary_metadata.retained_artifact_projection,
        }
      : {}),
    ...((meta.expansion_state_capture_coverage
      || baseline.summary_metadata?.expansion_state_capture_coverage)
      ? {
          expansion_state_capture_coverage:
            meta.expansion_state_capture_coverage
            || baseline.summary_metadata.expansion_state_capture_coverage,
        }
      : {}),
    expansion_state_screenshots: expansionStateScreenshots,
  };
}

function localRoleFiles(capture, pointer) {
  const files = capture.kind === "pdf"
    ? [
        ["pdf", "document.pdf", capture.pdf_path, "application/pdf"],
        ["text", "text.txt", capture.text_path, "text/plain; charset=utf-8"],
        ["meta", "meta.json", capture.meta_path, "application/json; charset=utf-8"],
      ]
    : [
        ["page", "page.jpg", capture.page_path, "image/jpeg"],
        ["thumb", "thumb.jpg", capture.thumb_path, "image/jpeg"],
        ["text", "text.txt", capture.text_path, "text/plain; charset=utf-8"],
        ...(capture.layout_path
          ? [["layout", "layout.json", capture.layout_path, "application/json; charset=utf-8"]]
          : []),
        ...(capture.expansion_state_screenshots || []).flatMap((state, index) => {
          const suffix = String(index + 1).padStart(2, "0");
          return [
            [
              `expansion_state_${suffix}`,
              `expansion-state-${suffix}.jpg`,
              state.page_path,
              "image/jpeg",
            ],
            [
              `expansion_state_${suffix}_layout`,
              `expansion-state-${suffix}-layout.json`,
              state.layout_path,
              "application/json; charset=utf-8",
            ],
          ];
        }),
        ["meta", "meta.json", capture.meta_path, "application/json; charset=utf-8"],
      ];
  const normalized = files.map(([name, fileName, path, contentType]) => {
    if (!path || !existsSync(path)) {
      throw new Error(`Reviewed recovery local R2 role ${name} is missing.`);
    }
    return { name, fileName, path, contentType };
  });
  const names = new Set(normalized.map((entry) => entry.name));
  for (const role of Object.keys(
    requiredObject(pointer.latest_object_keys, "reviewed recovery pointer roles"),
  )) {
    if (!names.has(role)) {
      throw new Error(`Reviewed recovery local R2 role ${role} is missing or unsupported.`);
    }
  }
  return normalized;
}

function readJournalLocations(state) {
  return deepFreeze({
    active: readActiveJournal(state),
    archived: readArchivedJournal(state),
  });
}

function readActiveJournal(state) {
  return readJournalFile(state, journalPaths(state).active, "active");
}

function readArchivedJournal(state) {
  return readJournalFile(state, journalPaths(state).archived, "archived");
}

function readJournalFile(state, path, label) {
  assertCanonicalReadBoundary(state, path, `${label} journal`);
  if (!existsSync(path)) return null;
  assertCanonicalExistingFile(state, path, `${label} journal`);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Reviewed recovery ${label} journal is unreadable.`);
  }
  return assertStage1EvidenceSchemaUpgradeJournal(value);
}

function readBaselineBytes(state) {
  const path = baselinePath(state);
  assertCanonicalReadBoundary(state, path, "authoritative baseline");
  return existsSync(path)
    ? readFileSync(assertCanonicalExistingFile(state, path, "authoritative baseline"))
    : null;
}

function baselinePath(state) {
  return join(state.root, "sources", state.source, "baseline.json");
}

function journalPaths(state) {
  const root = join(
    state.root,
    "sources",
    state.source,
    "stage1-evidence-schema-upgrade-journals",
  );
  return {
    active: join(root, "active.json"),
    archived: join(root, "completed", `${state.transaction}.json`),
  };
}

function archivePath(state, reference) {
  const text = requiredText(reference, "reviewed recovery archive-relative path");
  const candidate = isAbsolute(text) ? resolve(text) : resolve(state.root, text);
  const rel = relative(state.root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Reviewed recovery local artifact path escapes the archive root.");
  }
  return assertCanonicalExistingFile(state, candidate, "local R2 evidence artifact");
}

function archiveDirectoryPath(state, reference) {
  const text = requiredText(reference, "reviewed recovery archive-relative directory");
  const candidate = isAbsolute(text) ? resolve(text) : resolve(state.root, text);
  if (!filesystemPathContained(candidate, state.root)) {
    throw new Error("Reviewed recovery local artifact directory escapes the archive root.");
  }
  return assertCanonicalDirectory(state, candidate, "local R2 evidence directory");
}

function atomicWriteJson(state, path, value, label) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  atomicWriteBytes(state, path, bytes, label);
}

function atomicWriteBytes(state, path, value, label) {
  if (value === null) {
    removeCanonicalFile(state, path, label);
    return;
  }
  const bytes = Buffer.from(value);
  assertCanonicalMutationParent(state, path, label);
  if (existsSync(path)) assertCanonicalExistingFile(state, path, label);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  assertCanonicalMutationParent(state, temporary, `${label} staging file`);
  if (existsSync(temporary)) {
    throw new Error(`Reviewed recovery ${label} staging path already exists.`);
  }
  writeFileSync(temporary, bytes, { flag: "wx" });
  assertCanonicalExistingFile(state, temporary, `${label} staging file`);
  assertCanonicalMutationParent(state, path, label);
  if (existsSync(path)) assertCanonicalExistingFile(state, path, label);
  renameSync(temporary, path);
  assertCanonicalExistingFile(state, path, label);
}

export function inspectStage1EvidenceSchemaUpgradeReviewedRecoveryRuntimePath({
  archiveRoot,
  targetPath,
  mutationBoundary = false,
} = {}) {
  const state = { root: canonicalArchiveRoot(archiveRoot) };
  const path = resolve(requiredText(targetPath, "reviewed recovery inspected path"));
  if (mutationBoundary === true) {
    assertCanonicalMutationParent(state, path, "inspected recovery path");
  } else {
    assertCanonicalReadBoundary(state, path, "inspected recovery path");
  }
  return Object.freeze({
    path,
    exists: existsSync(path),
    mutation_performed: false,
  });
}

export function inspectStage1EvidenceSchemaUpgradeReviewedRecoveryLocalR2Roles({
  archiveRoot,
  sourceId,
  baselineBytes,
  pointer,
} = {}) {
  const state = {
    root: canonicalArchiveRoot(archiveRoot),
    source: requiredText(sourceId, "reviewed recovery inspected source ID"),
  };
  const baseline = parseJsonBytes(baselineBytes, "reviewed recovery inspected baseline");
  const capture = captureFromBaseline(state, baseline);
  const files = localRoleFiles(
    capture,
    requiredObject(pointer, "reviewed recovery inspected pointer"),
  );
  return deepFreeze({
    roles: files.map((entry) => entry.name).sort(),
    expansion_state_count: capture.expansion_state_screenshots.length,
    mutation_performed: false,
  });
}

export async function inspectStage1EvidenceSchemaUpgradeReviewedRecoveryRetainedR2Binding({
  archiveRoot,
  sourceId,
  baselineBytes,
  pointer,
  remoteBodiesByRole,
} = {}) {
  const source = requiredText(sourceId, "reviewed recovery inspected source ID");
  const r2Pointer = requiredObject(pointer, "reviewed recovery inspected R2 pointer");
  const keys = requiredObject(
    r2Pointer.latest_object_keys,
    "reviewed recovery inspected R2 object keys",
  );
  const bodies = requiredObject(
    remoteBodiesByRole,
    "reviewed recovery inspected remote R2 bodies",
  );
  if (!sameJson(Object.keys(bodies).sort(), Object.keys(keys).sort())) {
    throw new Error("Reviewed recovery inspected remote R2 roles are not exact.");
  }
  const contentTypes = {
    layout: "application/json; charset=utf-8",
    meta: "application/json; charset=utf-8",
    page: "image/jpeg",
    pdf: "application/pdf",
    text: "text/plain; charset=utf-8",
    thumb: "image/jpeg",
  };
  const state = {
    root: canonicalArchiveRoot(archiveRoot),
    source,
    bucket: requiredText(r2Pointer.bucket, "reviewed recovery inspected R2 bucket"),
    readR2Object: async (request) => {
      const role = Object.keys(keys).find((name) => keys[name] === request.key);
      if (!role || request.bucket !== r2Pointer.bucket) {
        throw new Error("Reviewed recovery inspected R2 read escaped its pointer.");
      }
      const body = Buffer.from(bodies[role]);
      return {
        bucket: request.bucket,
        key: request.key,
        body,
        expected_byte_length: request.expected_byte_length,
        content_type: contentTypes[role] || null,
        byte_length: body.byteLength,
        mutation_performed: false,
        creates_api_charge: false,
      };
    },
  };
  const receipt = await verifyCurrentR2(state, {
    baselineBytes: exactBytes(
      baselineBytes,
      "reviewed recovery inspected baseline bytes",
    ),
    pointer: r2Pointer,
  });
  return deepFreeze(structuredClone(receipt));
}

function canonicalArchiveRoot(value) {
  const lexical = resolve(requiredText(value, "reviewed recovery archive root"));
  const stats = lstatSync(lexical);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Reviewed recovery archive root is not a direct directory.");
  }
  const canonical = realpathSync(lexical);
  if (!sameFilesystemPath(canonical, lexical)) {
    throw new Error("Reviewed recovery archive root resolves through a reparse point or alias.");
  }
  return canonical;
}

function assertCanonicalReadBoundary(state, path, label) {
  assertCanonicalRootStable(state);
  const lexical = resolve(path);
  if (!filesystemPathContained(lexical, state.root)) {
    throw new Error(`Reviewed recovery ${label} is outside the archive root.`);
  }
  const parent = dirname(lexical);
  const relativeParent = relative(state.root, parent);
  let current = state.root;
  for (const segment of relativeParent.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) return lexical;
    assertCanonicalDirectory(state, current, `${label} parent`);
  }
  if (existsSync(lexical)) assertCanonicalExistingFile(state, lexical, label);
  return lexical;
}

function assertCanonicalMutationParent(state, path, label) {
  assertCanonicalRootStable(state);
  const lexical = resolve(path);
  if (!filesystemPathContained(lexical, state.root)) {
    throw new Error(`Reviewed recovery ${label} mutation is outside the archive root.`);
  }
  const parent = dirname(lexical);
  const relativeParent = relative(state.root, parent);
  let current = state.root;
  for (const segment of relativeParent.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) {
      try {
        mkdirSync(current);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    assertCanonicalDirectory(state, current, `${label} parent`);
  }
  assertCanonicalRootStable(state);
  return parent;
}

function assertCanonicalRootStable(state) {
  const stats = lstatSync(state.root);
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || !sameFilesystemPath(realpathSync(state.root), state.root)
  ) throw new Error("Reviewed recovery archive root authority changed.");
}

function assertCanonicalDirectory(state, path, label) {
  const lexical = resolve(path);
  const stats = lstatSync(lexical);
  const canonical = realpathSync(lexical);
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || !sameFilesystemPath(canonical, lexical)
    || !filesystemPathContained(canonical, state.root)
  ) throw new Error(`Reviewed recovery ${label} resolves through a reparse point.`);
  return canonical;
}

function assertCanonicalExistingFile(state, path, label) {
  const lexical = resolve(path);
  if (!filesystemPathContained(lexical, state.root)) {
    throw new Error(`Reviewed recovery ${label} is outside the archive root.`);
  }
  const stats = lstatSync(lexical);
  const canonical = realpathSync(lexical);
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || !sameFilesystemPath(canonical, lexical)
    || !filesystemPathContained(canonical, state.root)
  ) throw new Error(`Reviewed recovery ${label} resolves through a reparse point.`);
  return canonical;
}

function removeCanonicalFile(state, path, label) {
  assertCanonicalMutationParent(state, path, label);
  if (!existsSync(path)) return;
  assertCanonicalExistingFile(state, path, label);
  assertCanonicalMutationParent(state, path, label);
  assertCanonicalExistingFile(state, path, label);
  rmSync(path, { force: false });
  assertCanonicalMutationParent(state, path, label);
  if (existsSync(path)) throw new Error(`Reviewed recovery ${label} removal did not settle.`);
}

function filesystemPathContained(candidate, parent) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function sameFilesystemPath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function assertRuntimeIdentity(state, request) {
  assertSource(state, request.source_id);
  if (request.transaction_id !== state.transaction) {
    throw new Error("Reviewed recovery transaction identity changed.");
  }
}

function assertSource(state, sourceId) {
  if (sourceId !== state.source) throw new Error("Reviewed recovery source identity changed.");
}

function readNow(state) {
  const raw = typeof state.now === "function" ? state.now() : state.now;
  const text = cleanText(raw);
  const milliseconds = Date.parse(text);
  if (!text || !Number.isFinite(milliseconds)) throw new Error("Reviewed recovery time is invalid.");
  if (
    Number.isFinite(state.clockAuthority?.lastMilliseconds)
    && milliseconds < state.clockAuthority.lastMilliseconds
  ) throw new Error("Reviewed recovery clock moved backward.");
  if (state.clockAuthority) state.clockAuthority.lastMilliseconds = milliseconds;
  return new Date(milliseconds).toISOString();
}

function assertRecoveryMutationWindow(
  state,
  observedAt = readNow(state),
  expectedEpoch = null,
) {
  assertActiveRecoveryLock(state, expectedEpoch);
  if (
    !state.recovery
    || Date.parse(observedAt) < Date.parse(state.recovery.reviewedAt)
    || Date.parse(observedAt) >= Date.parse(state.recovery.expiresAt)
  ) throw new Error("Reviewed recovery mutation is outside its reviewed window.");
  return observedAt;
}

function assertActiveRecoveryLock(state, expectedEpoch = null) {
  const active = state.session?.activeLockEpoch;
  if (
    !Number.isSafeInteger(active)
    || (expectedEpoch !== null && active !== expectedEpoch)
    || state.session.activeLockReadOnly !== false
  ) {
    throw new Error("Reviewed recovery mutation requires its exact active source lock session.");
  }
  return active;
}

function parseJsonBytes(value, label) {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} bytes are missing.`);
  try {
    return requiredObject(JSON.parse(Buffer.from(value).toString("utf8")), label);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new Error(`${label} is not valid JSON.`);
  }
}

function exactBytes(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TypeError(`${label} must be exact bytes.`);
}

function describeDbError(error, action) {
  return `${action} failed: ${cleanText(error?.message || error) || "unknown database error"}`;
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function requiredSha256(value, label) {
  const text = requiredText(value, label);
  if (!/^[0-9a-f]{64}$/u.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function requiredTimestamp(value, label) {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid.`);
  return new Date(milliseconds).toISOString();
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function assertExactKeys(value, expected, label) {
  if (!sameJson(Object.keys(value).sort(), [...expected].sort())) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
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
  if (ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}
