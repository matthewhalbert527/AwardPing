import { createHash } from "node:crypto";
import {
  validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";
import {
  assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA,
  assertStage1EvidenceSchemaUpgradePrecommitSourceAuthority,
  assertStage1EvidenceSchemaUpgradeJournal,
  classifyStage1EvidenceSchemaUpgradeRecovery,
  proveStage1EvidenceSchemaUpgradeArchivedCompletion,
  stage1EvidenceSchemaUpgradeBaselineBytes,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import {
  stage1EvidenceSchemaUpgradeReviewedApplyTransactionId,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-execution.mjs";
import {
  visualSnapshotPointerIdentityFields,
  visualSnapshotPointerIdentity,
} from "./visual-snapshot-latest-only-reconciliation.mjs";
import {
  assertStage1EvidenceSchemaUpgradeR2BindingReceipt,
  stage1EvidenceSchemaUpgradeR2BindingReceiptSha256,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";
import {
  buildStage1EvidenceSchemaUpgradeSourceHealthAuthority,
  classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority,
} from "./stage1-evidence-schema-upgrade-reviewed-source-authority.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_PLAN_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-exact-transaction-recovery-plan.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_AUTHORITY_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-recovery-authority.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_INSPECTION_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-recovery-inspection.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_PLAN_DRAFT_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-recovery-plan-draft.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_PLAN_MAX_LIFETIME_MS =
  4 * 60 * 60 * 1000;

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_EVIDENCE_MAX_REVIEW_DELAY_MS =
  30 * 60 * 1000;

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_AUTHORITY =
  deepFreeze({
    operation: "stage1_evidence_schema_upgrade_exact_transaction_recovery",
    source_scope: "exact_one_operation_bound_transaction",
    automatic_reconciliation: false,
    separately_reviewed_exact_transaction_recovery: true,
    allow_browser: false,
    allow_live_capture: false,
    allow_ai: false,
    allow_api_charges: false,
    allow_r2_artifact_uploads: false,
    allow_latest_pointer_compare_and_swap: false,
    allow_candidate_writes: false,
    allow_visual_review_candidate: false,
    allow_quarantine: false,
    allow_public_fact_writes: false,
    allow_hold_clearing: false,
    allow_source_discovery: false,
    allow_active_journal_compare_and_swap: true,
    allow_local_baseline_repair: true,
    allow_source_health_success: true,
    allow_completed_journal_archive: true,
    allow_original_audit_terminal_update: true,
    ambiguous_authority_leaves_original_audit_running: true,
  });

const RECOVERY_FAILURE_TERMINALS_BY_DISPOSITION = deepFreeze({
  finish_failed_audit_started_before_journal: {
    error_code: "reviewed_recovery_proven_before_journal",
    error_message:
      "Exact no-journal old authority proves the reviewed apply stopped before its business boundary.",
  },
  finish_failed_from_archived_old: {
    error_code: "reviewed_recovery_exact_archived_old_abandonment",
    error_message:
      "The archived reviewed transaction proves exact old-authority abandonment.",
  },
  finish_partial_archive_then_fail: {
    error_code: "reviewed_recovery_exact_archived_old_abandonment",
    error_message:
      "The exact partial archive completed with old-authority abandonment.",
  },
  resume_active_old_authority: {
    error_code: "reviewed_recovery_exact_old_authority_abandoned",
    error_message:
      "The exact reviewed transaction completed as abandoned old authority without upgrading the source.",
  },
});

const FRESH_REVIEWED_APPLY_ABANDONED_OLD_FAILURE = deepFreeze({
  error_code: "reviewed_unchanged_upgrade_old_authority_preserved",
  error_message: "Reviewed unchanged upgrade ended selected_blocked.",
});

export function stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition(
  disposition,
) {
  const terminal = RECOVERY_FAILURE_TERMINALS_BY_DISPOSITION[disposition];
  if (!terminal) {
    throw new Error("Reviewed recovery disposition has no authorized failed terminal.");
  }
  return deepFreeze({ status: "failed", ...cloneJson(terminal) });
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IMMUTABLE_GENERATION_PATTERN = /^[0-9a-f]{32}$/u;
const R2_RECEIPT_KEYS = Object.freeze([
  "artifact_binding_verification",
  "captured_at",
  "creates_api_charge",
  "kind",
  "limitations",
  "mutation_performed",
  "pointer_identity",
  "previous_pointer",
  "receipt_sha256",
  "schema",
  "semantic_text",
  "source_id",
  "status",
  "verified_roles",
]);
const R2_POINTER_IDENTITY_KEYS = Object.freeze([
  "bucket",
  "immutable_generation",
  "kind",
  "latest_captured_at",
  "latest_hashes",
  "latest_metadata_sha256",
  "latest_object_keys",
  "pointer_sha256",
  "shared_award_source_id",
]);
const R2_PREVIOUS_POINTER_KEYS = Object.freeze([
  "preserved",
  "previous_captured_at",
  "previous_hashes",
  "previous_metadata",
  "previous_object_keys",
  "projection_sha256",
  "verification_scope",
]);
const R2_ARTIFACT_VERIFICATION_KEYS = Object.freeze([
  "derived_binding_count",
  "pointer_claim_present",
  "status",
]);
const R2_VERIFIED_ROLE_KEYS = Object.freeze([
  "byte_length",
  "content_type",
  "key",
  "remote_body_verified",
  "role",
  "sha256",
]);
const R2_SEMANTIC_TEXT_KEYS = Object.freeze([
  "character_length",
  "object_byte_length",
  "sha256",
  "writer_framing",
]);
const R2_ARTIFACT_BINDING_KEYS = Object.freeze([
  "byte_length",
  "content_type",
  "hash_mode",
  "sha256",
]);
const R2_FIXED_ROLE_CONTRACT = Object.freeze({
  layout: Object.freeze({
    contentType: "application/json; charset=utf-8",
    fileName: "layout.json",
  }),
  meta: Object.freeze({
    contentType: "application/json; charset=utf-8",
    fileName: "meta.json",
  }),
  page: Object.freeze({ contentType: "image/jpeg", fileName: "page.jpg" }),
  pdf: Object.freeze({ contentType: "application/pdf", fileName: "document.pdf" }),
  text: Object.freeze({
    contentType: "text/plain; charset=utf-8",
    fileName: "text.txt",
  }),
  thumb: Object.freeze({ contentType: "image/jpeg", fileName: "thumb.jpg" }),
});
const topLevelKeys = Object.freeze([
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
const journalProjectionKeys = Object.freeze([
  "active",
  "archived",
  "location_state",
]);
const journalIdentityKeys = Object.freeze([
  "candidate_baseline_identity",
  "candidate_pointer_identity",
  "journal_sha256",
  "old_baseline_identity",
  "old_pointer_identity",
  "operation_binding_sha256",
  "phase",
  "precommit_authority_receipt_sha256",
  "precommit_source_authority_sha256",
  "schema_version",
  "source_id",
  "transaction_id",
]);
const currentAuthorityKeys = Object.freeze([
  "activation_projection_sha256",
  "acquisition_projection_sha256",
  "audited_source_authority",
  "audited_source_authority_sha256",
  "authority_projection_sha256",
  "creates_api_charge",
  "current_source_authority",
  "finalization_projection_sha256",
  "local_baseline_identity",
  "mutation_performed",
  "pointer_identity",
  "r2_binding_receipt",
  "r2_binding_receipt_sha256",
  "source_id",
  "source_health_classification",
]);

export function projectStage1EvidenceSchemaUpgradeReviewedRecoveryAuthority({
  sourceId,
  currentSource,
  acquisitionProjection,
  activationProjection,
  finalizationProjection,
  currentBaselineBytes,
  currentPointer,
  r2BindingReceipt,
  auditedSourceAuthority,
  candidateBaselineBytes = null,
} = {}) {
  const source = requiredUuid(sourceId, "recovery authority source_id");
  const baseline = baselineIdentity(currentBaselineBytes);
  const pointer = visualSnapshotPointerIdentity(currentPointer);
  if (
    pointer.exists
    && pointer.projection.shared_award_source_id !== source
  ) {
    throw new Error("Recovery authority pointer belongs to another source.");
  }
  const r2Receipt = normalizeCurrentR2Receipt({
    receipt: r2BindingReceipt,
    sourceId: source,
    currentPointer,
  });
  const sourceAuthority = buildStage1EvidenceSchemaUpgradeSourceHealthAuthority(
    currentSource,
  );
  const auditedAuthority = assertStage1EvidenceSchemaUpgradePrecommitSourceAuthority(
    auditedSourceAuthority,
  );
  let sourceHealthClassification;
  if (candidateBaselineBytes === null) {
    sourceHealthClassification = sourceAuthority.source_authority_sha256
      === auditedAuthority.source_authority_sha256
      ? "exact_precommit"
      : "mismatch";
  } else {
    sourceHealthClassification =
      classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority({
        precommitSourceAuthority: auditedAuthority,
        currentSource,
        candidateBaselineBytes,
      }).classification;
  }
  const content = {
    source_id: source,
    current_source_authority: cloneJson(sourceAuthority),
    audited_source_authority: cloneJson(auditedAuthority),
    audited_source_authority_sha256: requiredSha256(
      auditedAuthority.source_authority_sha256,
      "audited source authority SHA-256",
    ),
    source_health_classification: sourceHealthClassification,
    acquisition_projection_sha256: hashProjection(
      acquisitionProjection,
      "recovery acquisition projection",
    ),
    activation_projection_sha256: hashProjection(
      activationProjection,
      "recovery activation projection",
    ),
    finalization_projection_sha256: hashProjection(
      finalizationProjection,
      "recovery finalization projection",
    ),
    local_baseline_identity: baseline,
    pointer_identity: {
      schema_version: pointer.schema_version,
      exists: pointer.exists,
      canonical_sha256: pointer.canonical_sha256,
    },
    r2_binding_receipt: r2Receipt,
    r2_binding_receipt_sha256: r2Receipt.receipt_sha256,
    mutation_performed: false,
    creates_api_charge: false,
  };
  const projected = {
    ...content,
    authority_projection_sha256: sha256(canonicalJson(content)),
  };
  assertExactKeys(projected, currentAuthorityKeys, "recovery current authority");
  return deepFreeze(projected);
}

export function createStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
  applyPlanBytes,
  expectedApplyPlanFileSha256,
  reviewedDryRunReportBytes,
  manifest,
  auditInspection,
  journals,
  currentAuthoritySnapshot,
  reviewer,
  inspectionBinding,
  evidenceObservedAt,
  now,
} = {}) {
  const evidence = recoveryEvidence({
    applyPlanBytes,
    expectedApplyPlanFileSha256,
    reviewedDryRunReportBytes,
    manifest,
    auditInspection,
    journals,
    currentAuthoritySnapshot,
  });
  const observedAt = requiredTimestamp(
    evidenceObservedAt,
    "recovery evidence_observed_at",
  );
  const draft = recoveryPlanDraftFromEvidence(evidence, observedAt);
  const reviewedBy = assertReviewer(reviewer, {
    evidenceObservedAt: observedAt,
    now,
  });
  const inspection = reviewedInspectionBinding(inspectionBinding, {
    evidence,
    evidenceSha256: stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256({
      auditInspection,
      journals,
      currentAuthoritySnapshot,
    }),
    observedAt,
  });
  const plan = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_PLAN_SCHEMA,
    apply: draft.apply,
    audit: draft.audit,
    operation_binding: draft.operation_binding,
    journal: draft.journal,
    current_authority: draft.current_authority,
    expected_disposition: draft.expected_disposition,
    evidence_observed_at: draft.evidence_observed_at,
    inspection,
    reviewer: reviewedBy,
    authority: cloneJson(draft.authority),
  };
  plan.plan_sha256 = recoveryPlanSha256(plan);
  const planBytes = recoveryPlanCanonicalBytes(plan);
  const checked = validateStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
    planBytes,
    expectedPlanFileSha256: sha256(planBytes),
    applyPlanBytes,
    expectedApplyPlanFileSha256,
    reviewedDryRunReportBytes,
    manifest,
    auditInspection,
    journals,
    currentAuthoritySnapshot,
    now,
  });
  return deepFreeze({
    plan: cloneJson(plan),
    plan_bytes: Buffer.from(planBytes),
    plan_file_sha256: sha256(planBytes),
    checked,
  });
}

export function createStage1EvidenceSchemaUpgradeReviewedRecoveryPlanDraft({
  applyPlanBytes,
  expectedApplyPlanFileSha256,
  reviewedDryRunReportBytes,
  manifest,
  auditInspection,
  journals,
  currentAuthoritySnapshot,
  evidenceObservedAt,
} = {}) {
  const evidence = recoveryEvidence({
    applyPlanBytes,
    expectedApplyPlanFileSha256,
    reviewedDryRunReportBytes,
    manifest,
    auditInspection,
    journals,
    currentAuthoritySnapshot,
  });
  return recoveryPlanDraftFromEvidence(
    evidence,
    requiredTimestamp(evidenceObservedAt, "recovery draft evidence_observed_at"),
  );
}

function recoveryPlanDraftFromEvidence(evidence, observedAt) {
  const draft = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_PLAN_DRAFT_SCHEMA,
    apply: cloneJson(evidence.apply),
    audit: cloneJson(evidence.audit),
    operation_binding: cloneJson(evidence.operation_binding),
    journal: cloneJson(evidence.journal),
    current_authority: cloneJson(evidence.current_authority),
    expected_disposition: evidence.expected_disposition,
    evidence_observed_at: observedAt,
    authority: cloneJson(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_AUTHORITY,
    ),
  };
  return deepFreeze({
    ...draft,
    draft_sha256: sha256(canonicalJson(draft)),
  });
}

export function validateStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
  planBytes,
  expectedPlanFileSha256,
  applyPlanBytes,
  expectedApplyPlanFileSha256,
  reviewedDryRunReportBytes,
  manifest,
  auditInspection,
  journals,
  currentAuthoritySnapshot,
  now,
} = {}) {
  const raw = exactBytes(planBytes, "reviewed recovery plan bytes");
  const expectedFileSha = requiredSha256(
    expectedPlanFileSha256,
    "expected reviewed recovery plan file SHA-256",
  );
  const fileSha = sha256(raw);
  if (fileSha !== expectedFileSha) {
    throw new Error("Reviewed recovery plan raw bytes differ from the expected SHA-256.");
  }
  const plan = parseCanonicalPlan(raw);
  assertExactKeys(plan, topLevelKeys, "reviewed recovery plan");
  if (
    plan.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_PLAN_SCHEMA
    || requiredSha256(plan.plan_sha256, "reviewed recovery plan self SHA-256")
      !== recoveryPlanSha256(plan)
    || !sameJson(
      plan.authority,
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_AUTHORITY,
    )
  ) {
    throw new Error("Reviewed recovery plan schema, seal, or authority is invalid.");
  }
  const reviewer = assertReviewer(plan.reviewer, {
    evidenceObservedAt: plan.evidence_observed_at,
    now,
  });
  const expected = recoveryEvidence({
    applyPlanBytes,
    expectedApplyPlanFileSha256,
    reviewedDryRunReportBytes,
    manifest,
    auditInspection,
    journals,
    currentAuthoritySnapshot,
  });
  assertReviewedInspectionProjection(plan.inspection, {
    evidence: expected,
    evidenceSha256: stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256({
      auditInspection,
      journals,
      currentAuthoritySnapshot,
    }),
    observedAt: plan.evidence_observed_at,
  });
  for (const key of [
    "apply",
    "audit",
    "operation_binding",
    "journal",
    "current_authority",
    "expected_disposition",
  ]) {
    if (!sameJson(plan[key], expected[key])) {
      throw new Error(`Reviewed recovery plan ${key} differs from current exact evidence.`);
    }
  }
  return deepFreeze({
    valid: true,
    schema_version: plan.schema_version,
    plan_file_sha256: fileSha,
    plan_sha256: plan.plan_sha256,
    selected_source_id: expected.apply.selected_source_id,
    transaction_id: stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
      sourceId: expected.apply.selected_source_id,
      planSha256: expected.apply.plan_sha256,
    }),
    audit_run_id: expected.audit.run_id,
    execution_nonce: expected.audit.execution_nonce,
    expected_disposition: expected.expected_disposition,
    reviewer,
    authority: cloneJson(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_AUTHORITY,
    ),
    plan: cloneJson(plan),
  });
}

function reviewedInspectionBinding(value, { evidence, evidenceSha256, observedAt }) {
  const binding = requiredObject(value, "reviewed recovery inspection binding");
  assertExactKeys(binding, [
    "inspection_file_sha256",
    "inspection_sha256",
    "mode",
    "proposed_plan_sha256",
    "schema_version",
  ], "reviewed recovery inspection binding");
  if (
    binding.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_INSPECTION_SCHEMA
    || binding.mode !== "inspect_and_generate_sealed_evidence"
  ) throw new Error("Reviewed recovery inspection binding schema or mode is invalid.");
  const proposedPlanSha256 = requiredSha256(
    binding.proposed_plan_sha256,
    "reviewed recovery inspection proposed-plan SHA-256",
  );
  if (proposedPlanSha256 !== recoveryPlanDraftFromEvidence(evidence, observedAt).draft_sha256) {
    throw new Error("Reviewed recovery inspection proposed plan differs from exact evidence.");
  }
  return deepFreeze({
    schema_version: binding.schema_version,
    mode: binding.mode,
    inspection_file_sha256: requiredSha256(
      binding.inspection_file_sha256,
      "reviewed recovery inspection file SHA-256",
    ),
    inspection_sha256: requiredSha256(
      binding.inspection_sha256,
      "reviewed recovery inspection self SHA-256",
    ),
    proposed_plan_sha256: proposedPlanSha256,
    evidence_sha256: requiredSha256(
      evidenceSha256,
      "reviewed recovery inspection evidence SHA-256",
    ),
    evidence_observed_at: observedAt,
    source_id: evidence.apply.selected_source_id,
    transaction_id: stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
      sourceId: evidence.apply.selected_source_id,
      planSha256: evidence.apply.plan_sha256,
    }),
  });
}

function assertReviewedInspectionProjection(value, { evidence, evidenceSha256, observedAt }) {
  const binding = requiredObject(value, "reviewed recovery plan inspection projection");
  assertExactKeys(binding, [
    "evidence_observed_at",
    "evidence_sha256",
    "inspection_file_sha256",
    "inspection_sha256",
    "mode",
    "proposed_plan_sha256",
    "schema_version",
    "source_id",
    "transaction_id",
  ], "reviewed recovery plan inspection projection");
  const expected = reviewedInspectionBinding({
    schema_version: binding.schema_version,
    mode: binding.mode,
    inspection_file_sha256: binding.inspection_file_sha256,
    inspection_sha256: binding.inspection_sha256,
    proposed_plan_sha256: binding.proposed_plan_sha256,
  }, { evidence, evidenceSha256, observedAt });
  if (!sameJson(binding, expected)) {
    throw new Error("Reviewed recovery plan inspection projection differs from live evidence.");
  }
  return expected;
}

export function stage1EvidenceSchemaUpgradeReviewedRecoveryPlanSha256(plan) {
  return recoveryPlanSha256(plan);
}

export function stage1EvidenceSchemaUpgradeReviewedRecoveryPlanCanonicalBytes(plan) {
  return recoveryPlanCanonicalBytes(plan);
}

/**
 * Seals the complete live recovery evidence passed between the reviewed
 * executor and its production mutation adapter. Binary baseline bytes are
 * represented by exact byte length and SHA-256 so the identity is canonical
 * without depending on Buffer's JSON implementation.
 */
export function stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256(value) {
  const evidence = requiredObject(value, "reviewed recovery live evidence");
  assertExactKeys(
    evidence,
    ["auditInspection", "currentAuthoritySnapshot", "journals"],
    "reviewed recovery live evidence",
  );
  return sha256(Buffer.from(canonicalJson(evidenceHashProjection(evidence)), "utf8"));
}

function recoveryEvidence({
  applyPlanBytes,
  expectedApplyPlanFileSha256,
  reviewedDryRunReportBytes,
  manifest,
  auditInspection,
  journals,
  currentAuthoritySnapshot,
}) {
  const apply = validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence({
    planBytes: applyPlanBytes,
    expectedPlanFileSha256: expectedApplyPlanFileSha256,
    reportBytes: reviewedDryRunReportBytes,
    manifest,
  });
  const audit = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
    auditInspection,
  );
  if (
    audit.plan_file_sha256 !== apply.plan_file_sha256
    || audit.plan_sha256 !== apply.plan_sha256
    || audit.selected_source_id !== apply.selected_source_id
    || !sameJson(audit.binding.selected, apply.plan.selected)
  ) {
    throw new Error("Recovery audit inspection differs from the historical apply plan.");
  }
  const transactionId = stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
    sourceId: apply.selected_source_id,
    planSha256: apply.plan_sha256,
  });
  const fresh = requiredObject(audit.fresh_capture, "recovery audit fresh capture");
  const journalEvidence = normalizeJournalEvidence({
    journals,
    sourceId: apply.selected_source_id,
    transactionId,
    apply,
    audit,
    fresh,
  });
  const operationBinding = journalEvidence.operationBinding;
  const authorityJournal = journals.active || journals.archived;
  const candidateBaselineBytes = authorityJournal
    ? stage1EvidenceSchemaUpgradeBaselineBytes(authorityJournal.candidate_baseline)
    : null;
  const currentAuthority = projectStage1EvidenceSchemaUpgradeReviewedRecoveryAuthority({
    ...currentAuthoritySnapshot,
    sourceId: apply.selected_source_id,
    auditedSourceAuthority: audit.authority_receipt.source_authority,
    candidateBaselineBytes,
  });
  assertStableBusinessAuthority({
    apply,
    currentAuthority,
    currentAuthoritySnapshot,
  });
  const expectedDisposition = recoveryDisposition({
    apply,
    audit,
    journalEvidence,
    journals,
    currentAuthority,
    currentAuthoritySnapshot,
    operationBinding,
    transactionId,
  });
  return deepFreeze({
    apply: {
      schema_version: apply.schema_version,
      plan_file_sha256: apply.plan_file_sha256,
      plan_sha256: apply.plan_sha256,
      selected_source_id: apply.selected_source_id,
      reviewed_report_attempt_id: apply.report_binding.attempt_id,
      manifest: cloneJson(apply.plan.manifest),
      reviewed_report: cloneJson(apply.report_binding),
      deferred_source_ids: cloneJson(apply.deferred_source_ids),
      selected_source: cloneJson(apply.plan.selected.source),
      reviewer: cloneJson(apply.reviewer),
      authority: cloneJson(apply.authority),
    },
    audit: {
      inspection_schema_version: audit.schema_version,
      inspection_sha256: audit.inspection_sha256,
      run_id: audit.run_id,
      row_kind: audit.row_kind,
      status: audit.status,
      execution_nonce: audit.execution_nonce,
      started_at: audit.started_at,
      finished_at: audit.finished_at,
      observed_row_sha256: audit.observed_row_sha256,
      fresh_capture_sha256: fresh.fresh_capture_sha256,
      authority_receipt: cloneJson(audit.authority_receipt),
      authority_receipt_sha256: audit.authority_receipt_sha256,
      source_authority_sha256:
        audit.authority_receipt.source_authority.source_authority_sha256,
      terminal_identity_sha256: audit.terminal_identity_sha256,
      report_replay: audit.report_replay,
    },
    operation_binding: operationBinding,
    journal: journalEvidence.projection,
    current_authority: currentAuthority,
    expected_disposition: expectedDisposition,
  });
}

function normalizeJournalEvidence({
  journals,
  sourceId,
  transactionId,
  apply,
  audit,
  fresh,
}) {
  const value = requiredObject(journals, "recovery journal locations");
  assertExactKeys(value, ["active", "archived"], "recovery journal locations");
  const active = normalizeJournalAtLocation(value.active, {
    label: "active",
    sourceId,
    transactionId,
  });
  const archived = normalizeJournalAtLocation(value.archived, {
    label: "archived",
    sourceId,
    transactionId,
  });
  const operationBindings = [value.active, value.archived]
    .filter(Boolean)
    .map((journal) => journal.operation_binding);
  const operationBinding = operationBindings[0] || null;
  for (const binding of operationBindings) {
    if (!sameJson(binding, operationBinding)) {
      throw new Error("Active and archived journals have different operation bindings.");
    }
  }
  if (operationBinding) {
    if (
      operationBinding.source_id !== sourceId
      || operationBinding.transaction_id !== transactionId
      || operationBinding.reviewed_apply_plan_file_sha256 !== apply.plan_file_sha256
      || operationBinding.reviewed_apply_plan_sha256 !== apply.plan_sha256
      || operationBinding.audit_run_id !== audit.run_id
      || operationBinding.execution_nonce !== audit.execution_nonce
      || operationBinding.reviewed_report_attempt_id !== apply.report_binding.attempt_id
      || operationBinding.fresh_capture_sha256 !== fresh.fresh_capture_sha256
      || operationBinding.fresh_capture_result_sha256 !== fresh.capture_result_sha256
      || operationBinding.fresh_capture_validation_sha256
        !== fresh.capture_validation_sha256
      || operationBinding.fresh_validation_projection_sha256
        !== fresh.fresh_validation_projection_sha256
      || operationBinding.precommit_authority_receipt_sha256
        !== audit.authority_receipt_sha256
      || !sameJson(
        operationBinding.precommit_source_authority,
        audit.authority_receipt.source_authority,
      )
    ) {
      throw new Error(
        "Reviewed journal operation binding differs from persisted audit authority.",
      );
    }
  }
  let locationState;
  if (active && archived) {
    if (
      active.journal_sha256 !== archived.journal_sha256
      || active.phase !== "completed"
      || archived.phase !== "completed"
      || !sameJson(value.active, value.archived)
    ) {
      throw new Error(
        "Dual active and archived reviewed journals must be the exact same completed bytes.",
      );
    }
    locationState = "active_and_archived_completed";
  } else if (active) {
    locationState = "active";
  } else if (archived) {
    if (archived.phase !== "completed") {
      throw new Error("Archived reviewed journal is not completed.");
    }
    locationState = "archived_completed";
  } else {
    locationState = "absent";
  }
  const projection = {
    location_state: locationState,
    active,
    archived,
  };
  assertExactKeys(projection, journalProjectionKeys, "recovery journal projection");
  return {
    projection: deepFreeze(projection),
    active: value.active,
    archived: value.archived,
    operationBinding: operationBinding ? deepFreeze(cloneJson(operationBinding)) : null,
  };
}

function normalizeJournalAtLocation(value, {
  label,
  sourceId,
  transactionId,
}) {
  if (value === null) return null;
  const journal = assertStage1EvidenceSchemaUpgradeJournal(value);
  if (
    journal.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA
    || journal.source_id !== sourceId
    || journal.transaction_id !== transactionId
  ) {
    throw new Error(`${label} recovery journal is not the exact reviewed v2 transaction.`);
  }
  const projection = {
    schema_version: journal.schema_version,
    source_id: journal.source_id,
    transaction_id: journal.transaction_id,
    phase: journal.phase,
    journal_sha256: journal.journal_sha256,
    operation_binding_sha256: journal.operation_binding.binding_sha256,
    precommit_authority_receipt_sha256:
      journal.operation_binding.precommit_authority_receipt_sha256,
    precommit_source_authority_sha256:
      journal.operation_binding.precommit_source_authority.source_authority_sha256,
    old_baseline_identity: baselineEnvelopeIdentity(journal.old_baseline),
    candidate_baseline_identity: baselineEnvelopeIdentity(journal.candidate_baseline),
    old_pointer_identity: compactPointerIdentity(journal.old_pointer_identity),
    candidate_pointer_identity: compactPointerIdentity(
      journal.candidate_pointer_identity,
    ),
  };
  assertExactKeys(projection, journalIdentityKeys, `${label} recovery journal identity`);
  return deepFreeze(projection);
}

function assertStableBusinessAuthority({
  apply,
  currentAuthority,
  currentAuthoritySnapshot,
}) {
  const selected = requiredObject(apply.plan.selected, "historical selected authority");
  const expected = {
    acquisition_projection_sha256: hashProjection(
      selected.acquisition,
      "selected acquisition",
    ),
    activation_projection_sha256: hashProjection(
      selected.activation,
      "selected activation",
    ),
    finalization_projection_sha256: hashProjection(
      selected.finalization,
      "selected finalization",
    ),
  };
  for (const [key, hash] of Object.entries(expected)) {
    if (currentAuthority[key] !== hash) {
      throw new Error(`Current recovery ${key} differs from reviewed business authority.`);
    }
  }
  const currentSource = requiredObject(
    currentAuthoritySnapshot.currentSource,
    "current live source authority row",
  );
  const auditedSource = currentAuthority.audited_source_authority.projection;
  if (
    currentAuthority.source_health_classification === "mismatch"
    || currentSource.id !== selected.source.source_id
    || currentSource.shared_award_id !== selected.source.shared_award_id
    || auditedSource.id !== selected.source.source_id
    || auditedSource.shared_award_id !== selected.source.shared_award_id
  ) {
    throw new Error(
      "Current or audited live source authority differs from the reviewed source.",
    );
  }
  for (const [key, selectedKey] of [
    ["acquisitionProjection", "acquisition"],
    ["activationProjection", "activation"],
    ["finalizationProjection", "finalization"],
  ]) {
    if (!sameJson(currentAuthoritySnapshot[key], selected[selectedKey])) {
      throw new Error(`Current recovery ${key} is not the exact reviewed projection.`);
    }
  }
}

function recoveryDisposition({
  apply,
  audit,
  journalEvidence,
  journals,
  currentAuthority,
  currentAuthoritySnapshot,
  operationBinding,
  transactionId,
}) {
  const state = journalEvidence.projection.location_state;
  const selected = apply.plan.selected;
  if (state === "absent") {
    assertStage1EvidenceSchemaUpgradeReviewedRecoveryOldR2Authority({
      currentAuthority,
      selected,
      auditInspection: audit,
    });
    const oldAuthority = sameJson(
      currentAuthority.local_baseline_identity,
      { present: true, ...selected.local_baseline_identity },
    ) && sameJson(
      currentAuthority.pointer_identity,
      selected.existing_pointer_identity,
    ) && currentAuthority.r2_binding_receipt_sha256
      === selected.r2.binding_receipt_sha256;
    if (
      !oldAuthority
      || currentAuthority.source_health_classification !== "exact_precommit"
    ) {
      throw new Error(
        "No-journal recovery does not prove the exact reviewed old authority.",
      );
    }
    if (audit.row_kind === "terminal_succeeded") {
      throw new Error("A terminal-success audit cannot be replayed without a completed journal.");
    }
    if (audit.row_kind === "terminal_failed") {
      assertTerminalReplayCompletionProvenance({
        audit,
        outcome: "before_journal",
        sourceId: apply.selected_source_id,
        transactionId,
      });
    }
    return audit.row_kind === "terminal_failed"
      ? "report_replay_failed_before_journal"
      : "finish_failed_audit_started_before_journal";
  }

  const authorityJournal = journals.active || journals.archived;
  const recovery = classifyStage1EvidenceSchemaUpgradeRecovery({
    journal: authorityJournal,
    currentBaselineBytes: currentAuthoritySnapshot.currentBaselineBytes,
    currentPointer: currentAuthoritySnapshot.currentPointer,
  });
  if (state === "archived_completed" || state === "active_and_archived_completed") {
    const archived = journals.archived;
    const proof = proveStage1EvidenceSchemaUpgradeArchivedCompletion({
      journal: archived,
      expectedJournalSha256: archived.journal_sha256,
      expectedTransactionId: transactionId,
      expectedOperationBinding: operationBinding,
      currentBaselineBytes: currentAuthoritySnapshot.currentBaselineBytes,
      currentPointer: currentAuthoritySnapshot.currentPointer,
    });
    if (proof.authority === "old") {
      assertStage1EvidenceSchemaUpgradeReviewedRecoveryOldR2Authority({
        currentAuthority,
        selected,
        auditInspection: audit,
      });
    } else {
      assertStage1EvidenceSchemaUpgradeReviewedRecoveryCandidateR2Pointer(
        currentAuthoritySnapshot.currentPointer,
      );
    }
    if (
      proof.authority === "candidate"
      && audit.row_kind === "terminal_failed"
    ) {
      throw new Error("Archived candidate success conflicts with a terminal-failed audit.");
    }
    if (
      proof.authority === "old"
      && audit.row_kind === "terminal_succeeded"
    ) {
      throw new Error("Archived old abandonment conflicts with a terminal-success audit.");
    }
    if (audit.row_kind === "terminal_succeeded") {
      const identity = requiredObject(
        audit.terminal?.selected_result_commit_identity,
        "terminal success commit identity",
      );
      if (
        identity.source_id !== apply.selected_source_id
        || identity.commit_journal_sha256 !== archived.journal_sha256
      ) {
        throw new Error(
          "Terminal-success audit does not bind the exact archived completed journal.",
        );
      }
    }
    if (audit.row_kind !== "running") {
      assertTerminalReplayCompletionProvenance({
        audit,
        outcome: proof.authority === "candidate"
          ? "archived_candidate"
          : "archived_old",
        sourceId: apply.selected_source_id,
        transactionId,
      });
    }
    if (
      proof.authority === "candidate"
      && currentAuthority.source_health_classification !== "exact_already_current"
    ) {
      return audit.row_kind === "running"
        ? "inspect_completed_candidate_source_health_unproven_leave_running"
        : "inspect_terminal_candidate_source_health_unproven_no_report_replay";
    }
    if (
      proof.authority === "old"
      && currentAuthority.source_health_classification !== "exact_precommit"
    ) {
      return audit.row_kind === "running"
        ? "inspect_completed_old_source_health_drift_leave_running"
        : "inspect_terminal_old_source_health_drift_no_report_replay";
    }
    if (
      state === "active_and_archived_completed"
      && audit.row_kind !== "running"
    ) {
      return proof.authority === "candidate"
        ? "finish_partial_archive_then_replay_candidate_success"
        : "finish_partial_archive_then_replay_old_abandonment";
    }
    if (audit.row_kind !== "running") {
      return proof.authority === "candidate"
        ? "report_replay_archived_candidate_success"
        : "report_replay_archived_old_abandonment";
    }
    if (state === "active_and_archived_completed") {
      return proof.authority === "candidate"
        ? "finish_partial_archive_then_succeed"
        : "finish_partial_archive_then_fail";
    }
    return proof.authority === "candidate"
      ? "finish_succeeded_from_archived_candidate"
      : "finish_failed_from_archived_old";
  }
  if (audit.row_kind !== "running") {
    throw new Error("A terminal audit conflicts with a still-active non-archived journal.");
  }
  if (recovery.classification === "old") {
    assertStage1EvidenceSchemaUpgradeReviewedRecoveryOldR2Authority({
      currentAuthority,
      selected,
      auditInspection: audit,
    });
  } else if (recovery.classification === "candidate") {
    assertStage1EvidenceSchemaUpgradeReviewedRecoveryCandidateR2Pointer(
      currentAuthoritySnapshot.currentPointer,
    );
  }
  if (
    recovery.classification === "old"
    && currentAuthority.source_health_classification !== "exact_precommit"
  ) {
    return "inspect_active_old_with_source_drift_leave_running";
  }
  if (
    authorityJournal.phase === "completed"
    && recovery.classification === "candidate"
    && currentAuthority.source_health_classification !== "exact_already_current"
  ) {
    return "inspect_completed_candidate_source_health_unproven_leave_running";
  }
  if (recovery.classification === "candidate") return "resume_active_candidate_authority";
  if (recovery.classification === "old") return "resume_active_old_authority";
  return "inspect_active_ambiguous_leave_running";
}

function assertTerminalReplayCompletionProvenance({
  audit,
  outcome,
  sourceId,
  transactionId,
}) {
  const terminal = requiredObject(
    audit.terminal,
    "terminal replay completion evidence",
  );
  const authority = requiredObject(
    terminal.completion_authority,
    "terminal replay completion authority",
  );
  if (authority.mode === "fresh_reviewed_apply") {
    if (outcome === "archived_old") {
      const failure = requiredObject(
        terminal.failure,
        "fresh reviewed-apply archived-old terminal failure",
      );
      if (
        terminal.status !== "failed"
        || failure.error_code
          !== FRESH_REVIEWED_APPLY_ABANDONED_OLD_FAILURE.error_code
        || failure.error_summary
          !== FRESH_REVIEWED_APPLY_ABANDONED_OLD_FAILURE.error_message
        || failure.error_message_sha256
          !== sha256(FRESH_REVIEWED_APPLY_ABANDONED_OLD_FAILURE.error_message)
      ) {
        throw new Error(
          "Fresh reviewed-apply archived-old terminal is not the exact abandoned-old outcome.",
        );
      }
      return;
    }
    if (
      (outcome === "before_journal" && terminal.status !== "failed")
      || (outcome === "archived_candidate" && terminal.status !== "succeeded")
    ) {
      throw new Error("Fresh reviewed-apply terminal provenance conflicts with recovery evidence.");
    }
    return;
  }
  if (authority.mode !== "reviewed_recovery") {
    throw new Error("Terminal replay completion authority mode is invalid.");
  }
  const recovery = requiredObject(
    authority.recovery,
    "terminal replay reviewed recovery authority",
  );
  if (
    recovery.source_id !== sourceId
    || recovery.transaction_id !== transactionId
  ) throw new Error("Terminal replay recovery authority belongs to another transaction.");
  const allowed = outcome === "before_journal"
    ? new Set(["finish_failed_audit_started_before_journal"])
    : outcome === "archived_old"
      ? new Set([
          "finish_failed_from_archived_old",
          "finish_partial_archive_then_fail",
          "resume_active_old_authority",
        ])
      : new Set([
          "finish_succeeded_from_archived_candidate",
          "finish_partial_archive_then_succeed",
          "resume_active_candidate_authority",
        ]);
  if (!allowed.has(recovery.expected_disposition)) {
    throw new Error("Terminal replay recovery disposition conflicts with current proof.");
  }
  if (terminal.status === "failed") {
    const expected =
      stage1EvidenceSchemaUpgradeReviewedRecoveryFailureTerminalForDisposition(
        recovery.expected_disposition,
      );
    const failure = requiredObject(terminal.failure, "terminal replay failure evidence");
    if (
      failure.error_code !== expected.error_code
      || failure.error_summary !== expected.error_message.slice(0, 1000)
      || failure.error_message_sha256 !== sha256(expected.error_message)
    ) throw new Error("Terminal replay failure narrative conflicts with its recovery authority.");
  }
}

function baselineIdentity(value) {
  if (value === null) {
    return { present: false, sha256: null, byte_length: 0 };
  }
  const bytes = exactBytes(value, "current recovery baseline bytes");
  return {
    present: true,
    sha256: sha256(bytes),
    byte_length: bytes.byteLength,
  };
}

function baselineEnvelopeIdentity(envelope) {
  const value = requiredObject(envelope, "journal baseline envelope");
  return {
    present: value.present,
    sha256: value.sha256,
    byte_length: value.byte_length,
  };
}

function compactPointerIdentity(identity) {
  const value = requiredObject(identity, "journal pointer identity");
  return {
    schema_version: value.schema_version,
    exists: value.exists,
    canonical_sha256: value.canonical_sha256,
  };
}

export function normalizeStage1EvidenceSchemaUpgradeReviewedRecoveryCurrentR2Receipt({
  receipt,
  sourceId,
  currentPointer,
}) {
  assertStage1EvidenceSchemaUpgradeR2BindingReceipt(receipt);
  const value = cloneJson(receipt);
  assertExactKeys(value, R2_RECEIPT_KEYS, "recovery R2 binding receipt");
  const pointer = visualSnapshotPointerIdentity(currentPointer);
  if (!pointer.exists) {
    throw new Error("Recovery R2 receipt cannot bind an absent current pointer.");
  }
  const rawPointer = requiredObject(currentPointer, "recovery current pointer");
  if (Object.keys(rawPointer).some(
    (key) => !visualSnapshotPointerIdentityFields.includes(key),
  )) {
    throw new Error("Recovery current pointer contains fields outside its canonical projection.");
  }
  const current = pointer.projection;
  const receiptPointer = requiredObject(
    value.pointer_identity,
    "recovery R2 receipt pointer identity",
  );
  assertExactKeys(
    receiptPointer,
    R2_POINTER_IDENTITY_KEYS,
    "recovery R2 receipt pointer identity",
  );
  const previousPointer = requiredObject(
    value.previous_pointer,
    "recovery R2 receipt previous pointer",
  );
  assertExactKeys(
    previousPointer,
    R2_PREVIOUS_POINTER_KEYS,
    "recovery R2 receipt previous pointer",
  );
  const verification = requiredObject(
    value.artifact_binding_verification,
    "recovery R2 artifact binding verification",
  );
  assertExactKeys(
    verification,
    R2_ARTIFACT_VERIFICATION_KEYS,
    "recovery R2 artifact binding verification",
  );
  const semanticText = requiredObject(
    value.semantic_text,
    "recovery R2 semantic text",
  );
  assertExactKeys(
    semanticText,
    R2_SEMANTIC_TEXT_KEYS,
    "recovery R2 semantic text",
  );
  const roles = Array.isArray(value.verified_roles) ? value.verified_roles : null;
  const expectedRoleKeys = Object.entries(current.latest_object_keys || {})
    .map(([role, key]) => ({ role, key }))
    .sort((left, right) => left.role.localeCompare(right.role));
  const observedRoleKeys = roles?.map((entry) => ({
    role: entry?.role,
    key: entry?.key,
  })).sort((left, right) => String(left.role).localeCompare(String(right.role)));
  const latestMetadata = requiredObject(
    current.latest_metadata,
    "recovery current pointer latest metadata",
  );
  const hasBindingSchema = Object.hasOwn(latestMetadata, "artifact_bindings_schema");
  const hasArtifactBindings = Object.hasOwn(latestMetadata, "artifact_bindings");
  if (hasBindingSchema !== hasArtifactBindings) {
    throw new Error("Recovery current pointer contains a partial artifact binding claim.");
  }
  const pointerBindings = hasArtifactBindings
    ? requiredObject(
        latestMetadata.artifact_bindings,
        "recovery current pointer artifact bindings",
      )
    : null;
  if (
    value.receipt_sha256
      !== stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(value)
    || value.source_id !== sourceId
    || value.kind !== current.kind
    || !sameCanonicalTimestamp(value.captured_at, current.latest_captured_at)
    || receiptPointer.shared_award_source_id !== sourceId
    || receiptPointer.kind !== current.kind
    || receiptPointer.bucket !== current.bucket
    || !sameCanonicalTimestamp(
      receiptPointer.latest_captured_at,
      current.latest_captured_at,
    )
    || !sameJson(receiptPointer.latest_object_keys, current.latest_object_keys)
    || !sameJson(receiptPointer.latest_hashes, current.latest_hashes)
    || receiptPointer.latest_metadata_sha256
      !== sha256(canonicalJson(current.latest_metadata))
    || !roles
    || !sameJson(observedRoleKeys, expectedRoleKeys)
  ) {
    throw new Error(
      "Recovery R2 binding receipt does not prove the exact current pointer generation and roles.",
    );
  }
  assertRecoveryR2RoleTopology(value.kind, roles.map((entry) => entry?.role));
  if (
    !IMMUTABLE_GENERATION_PATTERN.test(receiptPointer.immutable_generation)
    || !sameJson(
      roles.map((entry) => entry?.role),
      roles.map((entry) => entry?.role).sort((left, right) => left.localeCompare(right)),
    )
    || !Array.isArray(value.limitations)
    || value.limitations.some((entry) => typeof entry !== "string" || !entry.trim())
    || !sameJson(
      value.limitations,
      [...new Set(value.limitations)].sort((left, right) => left.localeCompare(right)),
    )
  ) {
    throw new Error("Recovery R2 binding receipt topology or limitations are invalid.");
  }
  if (
    !SHA256_PATTERN.test(semanticText.sha256)
    || !Number.isSafeInteger(semanticText.character_length)
    || semanticText.character_length < 0
    || !Number.isSafeInteger(semanticText.object_byte_length)
    || semanticText.object_byte_length < 1
    || !new Set(["crlf", "lf"]).has(semanticText.writer_framing)
    || semanticText.sha256 !== current.latest_hashes?.text_hash
  ) throw new Error("Recovery R2 semantic text identity is invalid.");
  if (pointerBindings) {
    if (
      latestMetadata.artifact_bindings_schema
        !== "awardping.r2.capture-artifact-bindings.v1"
      || !sameJson(Object.keys(pointerBindings).sort(), roles.map((entry) => entry.role))
      || verification.status !== "pointer_v1_bindings_verified"
      || verification.pointer_claim_present !== true
      || verification.derived_binding_count !== 0
    ) throw new Error("Recovery R2 pointer artifact binding claim is invalid.");
  } else if (
    verification.status !== "derived_from_exact_local_and_remote_bytes"
    || verification.pointer_claim_present !== false
    || verification.derived_binding_count !== roles.length
  ) {
    throw new Error("Recovery legacy R2 artifact binding proof is invalid.");
  }
  for (const entry of roles) {
    assertExactKeys(entry, R2_VERIFIED_ROLE_KEYS, "recovery R2 verified role");
    const role = requiredText(entry.role, "recovery R2 verified role name");
    const contract = recoveryR2RoleContract(role);
    const key = requiredText(entry.key, `recovery R2 ${role} key`);
    const binding = pointerBindings?.[role] ?? null;
    if (
      !contract
      || key !== current.latest_object_keys[role]
      || !recoveryR2ImmutableKeyMatches({
        key,
        sourceId,
        generation: receiptPointer.immutable_generation,
        fileName: contract.fileName,
      })
      || !SHA256_PATTERN.test(entry.sha256)
      || !Number.isSafeInteger(entry.byte_length)
      || entry.byte_length < 1
      || entry.content_type !== contract.contentType
      || entry.remote_body_verified !== true
    ) throw new Error(`Recovery R2 verified ${role} role identity is invalid.`);
    if (binding) {
      assertExactKeys(
        binding,
        R2_ARTIFACT_BINDING_KEYS,
        `recovery current pointer ${role} artifact binding`,
      );
      if (
        binding.hash_mode !== "raw_sha256"
        || entry.sha256 !== binding.sha256
        || entry.byte_length !== binding.byte_length
        || entry.content_type !== binding.content_type
      ) throw new Error(`Recovery R2 verified ${role} role differs from pointer binding.`);
    }
  }
  const textRole = roles.find((entry) => entry.role === "text");
  const primaryRole = roles.find((entry) => (
    entry.role === (value.kind === "pdf" ? "pdf" : "page")
  ));
  if (
    !textRole
    || textRole.byte_length !== semanticText.object_byte_length
    || !primaryRole
    || primaryRole.sha256
      !== current.latest_hashes?.[value.kind === "pdf" ? "file_hash" : "image_hash"]
  ) throw new Error("Recovery legacy R2 core byte identity differs from current pointer hashes.");
  return deepFreeze(value);
}

export function assertStage1EvidenceSchemaUpgradeReviewedRecoveryOldR2Authority({
  currentAuthority,
  selected,
  auditInspection,
}) {
  const authority = requiredObject(
    currentAuthority,
    "reviewed recovery old R2 authority",
  );
  const selectedAuthority = requiredObject(
    selected,
    "reviewed recovery selected authority",
  );
  const selectedR2 = requiredObject(
    selectedAuthority.r2,
    "reviewed recovery selected R2 identity",
  );
  const audit = assertStage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryInspection(
    auditInspection,
  );
  const receipt = requiredObject(
    authority.r2_binding_receipt,
    "reviewed recovery old R2 receipt",
  );
  const pointer = requiredObject(
    receipt.pointer_identity,
    "reviewed recovery old R2 pointer identity",
  );
  const previous = requiredObject(
    receipt.previous_pointer,
    "reviewed recovery old R2 previous pointer",
  );
  if (
    authority.r2_binding_receipt_sha256 !== selectedR2.binding_receipt_sha256
    || receipt.receipt_sha256 !== selectedR2.binding_receipt_sha256
    || audit.authority_receipt.r2_binding_receipt_sha256
      !== selectedR2.binding_receipt_sha256
    || !sameJson(authority.pointer_identity, selectedAuthority.existing_pointer_identity)
    || !sameJson(
      audit.authority_receipt.existing_pointer_identity,
      selectedAuthority.existing_pointer_identity,
    )
    || !sameJson(audit.binding.selected.r2, selectedR2)
    || pointer.pointer_sha256 !== selectedR2.pointer_sha256
    || previous.projection_sha256 !== selectedR2.previous_pointer_projection_sha256
    || pointer.latest_metadata_sha256 !== selectedR2.latest_metadata_sha256
    || pointer.immutable_generation !== selectedR2.immutable_generation
    || pointer.bucket !== selectedR2.bucket
    || receipt.kind !== selectedR2.kind
    || !sameCanonicalTimestamp(receipt.captured_at, selectedR2.captured_at)
    || sha256(canonicalJson(pointer.latest_object_keys))
      !== selectedR2.pointer_latest_object_keys_sha256
    || sha256(canonicalJson(pointer.latest_hashes))
      !== selectedR2.pointer_latest_hashes_sha256
    || sha256(canonicalJson(receipt.verified_roles))
      !== selectedR2.verified_roles_sha256
    || receipt.semantic_text?.sha256 !== selectedR2.semantic_text_sha256
  ) throw new Error("Reviewed recovery old R2 authority differs from its exact review.");
  return deepFreeze(cloneJson(authority));
}

export function assertStage1EvidenceSchemaUpgradeReviewedRecoveryCandidateR2Pointer(
  currentPointer,
) {
  const pointer = visualSnapshotPointerIdentity(currentPointer);
  if (!pointer.exists) {
    throw new Error("Reviewed recovery candidate R2 pointer is absent.");
  }
  const latestMetadata = requiredObject(
    pointer.projection.latest_metadata,
    "reviewed recovery candidate R2 metadata",
  );
  const bindings = requiredObject(
    latestMetadata.artifact_bindings,
    "reviewed recovery candidate R2 artifact bindings",
  );
  if (
    latestMetadata.artifact_bindings_schema
      !== "awardping.r2.capture-artifact-bindings.v1"
    || !sameJson(
      Object.keys(bindings).sort(),
      Object.keys(pointer.projection.latest_object_keys || {}).sort(),
    )
  ) throw new Error("Reviewed recovery candidate R2 pointer lacks exact v1 bindings.");
  return deepFreeze(cloneJson(pointer.projection));
}

function normalizeCurrentR2Receipt(input) {
  return normalizeStage1EvidenceSchemaUpgradeReviewedRecoveryCurrentR2Receipt(input);
}

function assertRecoveryR2RoleTopology(kind, roles) {
  const required = kind === "pdf"
    ? ["meta", "pdf", "text"]
    : ["meta", "page", "text", "thumb"];
  if (!new Set(["pdf", "webpage"]).has(kind) || required.some((role) => !roles.includes(role))) {
    throw new Error("Recovery R2 receipt is missing a required core role.");
  }
  if (kind === "pdf") {
    if (roles.some((role) => !required.includes(role))) {
      throw new Error("Recovery PDF R2 receipt contains a webpage-only role.");
    }
    return;
  }
  if (roles.includes("pdf") || roles.some((role) => !recoveryR2RoleContract(role))) {
    throw new Error("Recovery webpage R2 receipt contains an unsupported role.");
  }
  const pages = roles
    .map((role) => /^expansion_state_(\d{2,})$/u.exec(role)?.[1] ?? null)
    .filter(Boolean)
    .sort();
  const layouts = roles
    .map((role) => /^expansion_state_(\d{2,})_layout$/u.exec(role)?.[1] ?? null)
    .filter(Boolean)
    .sort();
  if (
    !sameJson(pages, layouts)
    || pages.some((suffix, index) => suffix !== String(index + 1).padStart(2, "0"))
  ) throw new Error("Recovery R2 expansion roles are not exact contiguous pairs.");
}

function recoveryR2RoleContract(role) {
  if (R2_FIXED_ROLE_CONTRACT[role]) return R2_FIXED_ROLE_CONTRACT[role];
  const page = /^expansion_state_(\d{2,})$/u.exec(role);
  if (page) {
    return { contentType: "image/jpeg", fileName: `expansion-state-${page[1]}.jpg` };
  }
  const layout = /^expansion_state_(\d{2,})_layout$/u.exec(role);
  if (layout) {
    return {
      contentType: "application/json; charset=utf-8",
      fileName: `expansion-state-${layout[1]}-layout.json`,
    };
  }
  return null;
}

function recoveryR2ImmutableKeyMatches({ key, sourceId, generation, fileName }) {
  if (key.includes("\\") || key.includes("..") || /[\u0000-\u001f]/u.test(key)) {
    return false;
  }
  const parts = key.split("/");
  return parts.length === 6
    && parts[0] === "visual-snapshots"
    && parts[1] === "sources"
    && parts[2] === sourceId
    && parts[3] === "captures"
    && parts[4] === generation
    && parts[5] === fileName;
}

function sameCanonicalTimestamp(left, right) {
  const leftMilliseconds = Date.parse(left);
  const rightMilliseconds = Date.parse(right);
  return Number.isFinite(leftMilliseconds)
    && Number.isFinite(rightMilliseconds)
    && leftMilliseconds === rightMilliseconds;
}

function assertReviewer(value, { evidenceObservedAt, now }) {
  const reviewer = requiredObject(value, "reviewed recovery plan reviewer");
  assertExactKeys(reviewer, ["expires_at", "reviewed_at", "reviewer_id"],
    "reviewed recovery plan reviewer");
  const reviewedAt = requiredTimestamp(reviewer.reviewed_at, "recovery reviewed_at");
  const expiresAt = requiredTimestamp(reviewer.expires_at, "recovery expires_at");
  const observedAt = requiredTimestamp(evidenceObservedAt, "recovery evidence_observed_at");
  const current = requiredTimestamp(now, "recovery validation now");
  requiredReviewerId(reviewer.reviewer_id, "recovery reviewer_id");
  if (
    Date.parse(reviewedAt) < Date.parse(observedAt)
    || Date.parse(reviewedAt) > Date.parse(current)
    || Date.parse(reviewedAt) - Date.parse(observedAt)
      > STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_EVIDENCE_MAX_REVIEW_DELAY_MS
    || Date.parse(expiresAt) <= Date.parse(current)
    || Date.parse(expiresAt) <= Date.parse(reviewedAt)
    || Date.parse(expiresAt) - Date.parse(observedAt)
      > STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_PLAN_MAX_LIFETIME_MS
  ) {
    throw new Error("Reviewed recovery plan is outside its bounded review window.");
  }
  return cloneJson(reviewer);
}

function recoveryPlanSha256(plan) {
  const value = cloneJson(requiredObject(plan, "reviewed recovery plan"));
  delete value.plan_sha256;
  return sha256(canonicalJson(value));
}

function recoveryPlanCanonicalBytes(plan) {
  const value = cloneJson(requiredObject(plan, "reviewed recovery plan"));
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function parseCanonicalPlan(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Reviewed recovery plan must be valid UTF-8 JSON.");
  }
  if (!isPlainObject(value)) throw new Error("Reviewed recovery plan must be an object.");
  if (!bytes.equals(recoveryPlanCanonicalBytes(value))) {
    throw new Error("Reviewed recovery plan is not canonical sorted JSON with one LF.");
  }
  return value;
}

function hashProjection(value, label) {
  return sha256(canonicalJson(requiredObject(value, label)));
}

function evidenceHashProjection(value) {
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return {
      binary_byte_length: bytes.byteLength,
      binary_sha256: sha256(bytes),
    };
  }
  if (Array.isArray(value)) return value.map(evidenceHashProjection);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, evidenceHashProjection(value[key])]),
    );
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return value;
  throw new Error("Reviewed recovery live evidence contains a non-canonical value.");
}

function exactBytes(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TypeError(`${label} must be exact bytes.`);
}

function requiredReviewerId(value, label) {
  const text = requiredText(value, label);
  if (
    text.length < 3
    || text.length > 200
    || /[\u0000-\u001f\u007f]/u.test(text)
  ) throw new Error(`${label} is invalid.`);
  return text;
}

function requiredTimestamp(value, label) {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid.`);
  return new Date(milliseconds).toISOString();
}

function requiredSha256(value, label) {
  const text = requiredText(value, label);
  if (!SHA256_PATTERN.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function requiredUuid(value, label) {
  const text = requiredText(value, label);
  if (!UUID_PATTERN.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function requiredText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function requiredObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function assertExactKeys(value, expected, label) {
  if (!sameJson(Object.keys(value).sort(), [...expected].sort())) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
