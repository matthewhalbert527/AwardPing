import { createHash } from "node:crypto";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REPORT_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS,
  validateStage1EvidenceSchemaUpgradeManifest,
} from "./stage1-evidence-schema-upgrade.mjs";
import {
  assertStage1EvidenceSchemaUpgradeR2BindingReceipt,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";
import {
  VISUAL_SNAPSHOT_POINTER_IDENTITY_SCHEMA,
} from "./visual-snapshot-latest-only-reconciliation.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-exact-one-apply-plan.v3";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_FRESH_VALIDATION_PROJECTION_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-fresh-validation-projection.v3";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_MAX_LIFETIME_MS =
  24 * 60 * 60 * 1000;

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_DEFERRED_COUNT =
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS.length - 1;

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY =
  deepFreeze({
    operation: "stage1_evidence_schema_upgrade",
    source_scope: "exact_one_reviewed_source",
    required_capture_decision: "eligible_unchanged_upgrade",
    allow_immutable_r2_artifact_uploads: true,
    allow_latest_pointer_compare_and_swap: true,
    allow_local_baseline_write: true,
    allow_source_health_success: true,
    worker_run_audit_mode: "dedicated_exact_one_insert_one_terminal_update",
    allow_worker_run_supersession: false,
    preserve_admin_review_status: true,
    allow_visual_review_candidate: false,
    allow_quarantine: false,
    allow_public_fact_writes: false,
    allow_hold_clearing: false,
    automatic_reconciliation: false,
    separately_reviewed_exact_transaction_recovery: true,
    allow_first_observation_notifications: false,
    allow_source_discovery: false,
    allow_baseline_refresh: false,
  });

const sha256Pattern = /^[0-9a-f]{64}$/u;
const generationPattern = /^[0-9a-f]{32}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

const zeroMutationCounts = deepFreeze({
  database_writes: 0,
  r2_writes: 0,
  local_baseline_writes: 0,
  candidate_writes: 0,
  quarantine_writes: 0,
  source_state_writes: 0,
});

const dryRunSafety = deepFreeze({
  creates_api_charge: false,
  live_capture_permitted: true,
  local_capture_artifacts_permitted: true,
  public_fact_writes: 0,
  reconciliation_requests: 0,
  public_events: 0,
  source_discovery: false,
  baseline_refreshes: 0,
  ...zeroMutationCounts,
});

const dryRunResultStatuses = new Set([
  "dry_run_already_upgraded",
  "dry_run_completed_authority_invalid",
  "dry_run_evidence_failure",
  "dry_run_ready",
  "dry_run_recovery_required",
  "implementation_blocked",
  "ineligible",
  "isolated_mode_failed",
]);

const topLevelPlanKeys = Object.freeze([
  "authority",
  "deferred_source_ids",
  "dry_run_report",
  "expected_active_journal_sha256",
  "manifest",
  "plan_sha256",
  "reviewer",
  "schema_version",
  "selected",
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

/**
 * Produces the stable, pre-mutation revalidation domain for one source result.
 * The raw reviewed result remains separately hash-bound by the plan. This
 * projection deliberately retains eligibility/finalization, acquisition,
 * semantic/visual/coverage evidence, exact local-baseline bytes,
 * complete existing pointer identity, R2 authority, and recovery evidence. It
 * omits only the schema-defined prospective capture timestamp, its
 * capture-instance layout binding, and PDF-recovery receipt fields derived
 * from volatile values. The authoritative existing layout identity remains
 * bound.
 * Unknown or nested fields remain bound so a future evidence-schema addition
 * cannot silently acquire a volatile-looking name and escape revalidation.
 */
export function projectStage1EvidenceSchemaUpgradeFreshValidation(sourceResult) {
  const row = requiredObject(sourceResult, "source result");
  const projectedRow = cloneJson(row);
  delete projectedRow.evaluated_at;
  const captureValidation = requiredObject(
    projectedRow.capture_validation,
    "source result capture_validation",
  );
  const evidence = requiredObject(
    captureValidation.evidence,
    "source result capture_validation evidence",
  );

  if (plainObject(evidence.capture)) {
    stripProspectiveCaptureVolatility(evidence.capture);
  }
  if (plainObject(evidence.pdf_text_recovery)) {
    stripPdfRecoveryVolatility(evidence.pdf_text_recovery);
  }
  if (!Object.hasOwn(evidence, "pdf_text_recovery")) {
    evidence.pdf_text_recovery = null;
  }
  if (!Object.hasOwn(evidence, "prior_recovery")) {
    evidence.prior_recovery = null;
  }

  return {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_FRESH_VALIDATION_PROJECTION_SCHEMA,
    source_result: projectedRow,
  };
}

export function stage1EvidenceSchemaUpgradeFreshValidationSha256(sourceResult) {
  return sha256(canonicalJson(
    projectStage1EvidenceSchemaUpgradeFreshValidation(sourceResult),
  ));
}

export function stage1EvidenceSchemaUpgradeReviewedApplyPlanSha256(plan) {
  const value = requiredObject(plan, "reviewed apply plan");
  const basis = cloneJson(value);
  delete basis.plan_sha256;
  return sha256(canonicalJson(basis));
}

export function stage1EvidenceSchemaUpgradeReviewedApplyPlanCanonicalBytes(plan) {
  return Buffer.from(`${canonicalJson(plan)}\n`, "utf8");
}

/**
 * Builds one canonical reviewed-plan document from an exact producer report.
 * The caller still supplies the human/operator review identity and bounded
 * review window; this helper performs no I/O and grants no mutation authority
 * until the returned bytes are separately supplied to the apply validator.
 */
export function createStage1EvidenceSchemaUpgradeReviewedApplyPlan({
  reportBytes,
  manifest,
  selectedSourceId,
  reviewer,
  now,
} = {}) {
  const rawReport = exactBytes(reportBytes, "dry-run report bytes");
  const report = parseReviewedReport(rawReport);
  const checkedManifest = validateStage1EvidenceSchemaUpgradeManifest(manifest);
  const manifestSha256 = sha256(canonicalJson(checkedManifest));
  const stage1Report = assertReviewedDryRunReport({
    report,
    manifest: checkedManifest,
    manifestSha256,
  });
  const sourceId = requiredUuid(selectedSourceId, "selected source ID");
  const manifestSource = checkedManifest.sources.find(
    (source) => source.source_id === sourceId,
  );
  const matchingResults = stage1Report.results.filter(
    (result) => result?.source_id === sourceId,
  );
  if (!manifestSource || matchingResults.length !== 1) {
    throw new Error(
      "The selected source is not one exact member/result of the reviewed-nine report.",
    );
  }
  const sourceResult = matchingResults[0];
  assertReadySourceResult({ sourceResult, manifestSource, manifestSha256 });

  const reviewedBy = assertReviewer(reviewer, {
    now,
    reportFinishedAt: report.finished_at,
    stage1GeneratedAt: stage1Report.generated_at,
  });
  const plan = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_SCHEMA,
    manifest: {
      schema_version: checkedManifest.schema_version,
      sha256: manifestSha256,
      source_count: checkedManifest.source_count,
    },
    dry_run_report: {
      file_sha256: sha256(rawReport),
      report_schema_version: report.report_schema_version,
      attempt_id: report.run_identity.attempt_id,
      worker_run_id: report.worker_run_id ?? null,
      started_at: report.started_at,
      finished_at: report.finished_at,
      stage1_report_schema_version: stage1Report.schema_version,
      stage1_report_generated_at: stage1Report.generated_at,
      stage1_report_sha256: sha256(canonicalJson(stage1Report)),
      manifest_sha256: manifestSha256,
    },
    selected: selectedBinding({ sourceResult, manifestSource }),
    deferred_source_ids: checkedManifest.source_ids.filter((id) => id !== sourceId),
    reviewer: reviewedBy,
    expected_active_journal_sha256: null,
    authority: cloneJson(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY,
    ),
    plan_sha256: null,
  };
  plan.plan_sha256 = stage1EvidenceSchemaUpgradeReviewedApplyPlanSha256(plan);
  const planBytes = stage1EvidenceSchemaUpgradeReviewedApplyPlanCanonicalBytes(plan);
  const checked = validateStage1EvidenceSchemaUpgradeReviewedApplyPlan({
    planBytes,
    expectedPlanFileSha256: sha256(planBytes),
    reportBytes: rawReport,
    manifest: checkedManifest,
    now,
  });
  return Object.freeze({
    plan: deepFreeze(cloneJson(plan)),
    plan_bytes: Buffer.from(planBytes),
    plan_file_sha256: sha256(planBytes),
    checked,
  });
}

/**
 * Purely validates a reviewed exact-one apply plan. It performs no I/O and is
 * not apply authority by itself: a later worker integration must still load a
 * fresh source, prove there is no active journal, recompute the exported fresh
 * validation projection, and constrain execution to the returned authority.
 */
export function validateStage1EvidenceSchemaUpgradeReviewedApplyPlan({
  planBytes,
  expectedPlanFileSha256,
  reportBytes,
  manifest,
  now,
} = {}) {
  return validateReviewedApplyPlanInternal({
    planBytes,
    expectedPlanFileSha256,
    reportBytes,
    manifest,
    now,
    historicalEvidenceOnly: false,
  });
}

/**
 * Revalidates every immutable parent-plan/report/manifest binding for a later
 * separately reviewed recovery. The original plan's review window must have
 * been valid when created, but it may now be expired; this result is evidence
 * only and must never be passed to the fresh apply executor.
 */
export function validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence({
  planBytes,
  expectedPlanFileSha256,
  reportBytes,
  manifest,
} = {}) {
  return validateReviewedApplyPlanInternal({
    planBytes,
    expectedPlanFileSha256,
    reportBytes,
    manifest,
    now: null,
    historicalEvidenceOnly: true,
  });
}

function validateReviewedApplyPlanInternal({
  planBytes,
  expectedPlanFileSha256,
  reportBytes,
  manifest,
  now,
  historicalEvidenceOnly,
}) {
  const rawPlan = exactBytes(planBytes, "reviewed apply plan bytes");
  const expectedFileSha256 = requiredSha256(
    expectedPlanFileSha256,
    "expected plan file SHA-256",
  );
  const planFileSha256 = sha256(rawPlan);
  if (planFileSha256 !== expectedFileSha256) {
    throw new Error("The reviewed apply-plan raw bytes differ from the CLI-expected SHA-256.");
  }

  const plan = parseCanonicalPlan(rawPlan);
  assertExactKeys(plan, topLevelPlanKeys, "reviewed apply plan");
  if (plan.schema_version
    !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_SCHEMA) {
    throw new Error("The reviewed apply-plan schema is unsupported.");
  }
  requiredSha256(plan.plan_sha256, "reviewed apply-plan self-seal");
  if (plan.plan_sha256 !== stage1EvidenceSchemaUpgradeReviewedApplyPlanSha256(plan)) {
    throw new Error("The reviewed apply-plan canonical self-seal is invalid.");
  }

  const checkedManifest = validateStage1EvidenceSchemaUpgradeManifest(manifest);
  const manifestSha256 = sha256(canonicalJson(checkedManifest));
  assertManifestBinding(plan.manifest, checkedManifest, manifestSha256);

  const rawReport = exactBytes(reportBytes, "dry-run report bytes");
  const reportFileSha256 = sha256(rawReport);
  const report = parseReviewedReport(rawReport);
  const stage1Report = assertReviewedDryRunReport({
    report,
    manifest: checkedManifest,
    manifestSha256,
  });
  assertReportBinding(plan.dry_run_report, {
    report,
    stage1Report,
    reportFileSha256,
    manifestSha256,
  });

  const selected = requiredObject(plan.selected, "reviewed apply-plan selected source");
  assertExactKeys(selected, [
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
  ], "reviewed apply-plan selected source");
  const selectedSource = requiredObject(selected.source, "selected source identity");
  const selectedSourceId = requiredUuid(selectedSource.source_id, "selected source ID");
  const manifestSource = checkedManifest.sources.find(
    (source) => source.source_id === selectedSourceId,
  );
  if (!manifestSource || !sameJson(selectedSource, manifestSource)) {
    throw new Error("The reviewed apply-plan selected source differs from the parent manifest.");
  }

  const matchingResults = stage1Report.results.filter(
    (result) => result?.source_id === selectedSourceId,
  );
  if (matchingResults.length !== 1) {
    throw new Error("The reviewed apply-plan selected source must have exactly one dry-run result.");
  }
  const sourceResult = matchingResults[0];
  assertReadySourceResult({
    sourceResult,
    manifestSource,
    manifestSha256,
  });
  const expectedSelected = selectedBinding({ sourceResult, manifestSource });
  if (!sameJson(selected, expectedSelected)) {
    throw new Error("The reviewed apply-plan selected identities differ from the exact dry-run result.");
  }

  const expectedDeferred = checkedManifest.source_ids.filter(
    (sourceId) => sourceId !== selectedSourceId,
  );
  assertExactDeferredComplement(plan.deferred_source_ids, expectedDeferred);
  if (plan.expected_active_journal_sha256 !== null) {
    throw new Error("Reviewed exact-one apply requires expected_active_journal_sha256 to be null.");
  }
  if (!sameJson(
    plan.authority,
    STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY,
  )) {
    throw new Error("The reviewed apply-plan authority exceeds unchanged evidence upgrade scope.");
  }

  const reviewer = assertReviewer(plan.reviewer, {
    now,
    reportFinishedAt: report.finished_at,
    stage1GeneratedAt: stage1Report.generated_at,
    historicalEvidenceOnly,
  });
  const freshValidationProjection =
    projectStage1EvidenceSchemaUpgradeFreshValidation(sourceResult);

  return deepFreeze({
    valid: true,
    historical_evidence_only: historicalEvidenceOnly,
    schema_version: plan.schema_version,
    plan_file_sha256: planFileSha256,
    plan_sha256: plan.plan_sha256,
    selected_source_id: selectedSourceId,
    deferred_source_ids: [...expectedDeferred],
    expected_active_journal_sha256: null,
    reviewer,
    authority: cloneJson(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY,
    ),
    report_binding: cloneJson(plan.dry_run_report),
    plan: cloneJson(plan),
    selected_result: cloneJson(sourceResult),
    fresh_validation_projection: freshValidationProjection,
    fresh_validation_projection_sha256:
      stage1EvidenceSchemaUpgradeFreshValidationSha256(sourceResult),
  });
}

function assertReviewedDryRunReport({ report, manifest, manifestSha256 }) {
  const value = requiredObject(report, "visual dry-run report");
  if (value.report_schema_version !== 2) {
    throw new Error("The reviewed dry-run report schema is unsupported.");
  }
  requiredTimestamp(value.started_at, "dry-run report started_at");
  requiredTimestamp(value.finished_at, "dry-run report finished_at");
  if (Date.parse(value.finished_at) < Date.parse(value.started_at)) {
    throw new Error("The reviewed dry-run report finished before it started.");
  }
  const runIdentity = requiredObject(value.run_identity, "dry-run report run_identity");
  if (
    runIdentity.workflow !== "visual_capture"
    || runIdentity.trigger !== "manual"
    || runIdentity.shard_count !== 1
    || runIdentity.shard_index !== 0
  ) {
    throw new Error("The reviewed dry-run report is not one manual unsharded visual run.");
  }
  requiredUuid(runIdentity.attempt_id, "dry-run report attempt ID");

  const options = requiredObject(value.options, "dry-run report options");
  const selector = requiredObject(
    options.stage1_evidence_schema_upgrade_selector,
    "dry-run report Stage 1 selector",
  );
  if (
    options.stage1_evidence_schema_upgrade !== true
    || options.stage1_evidence_schema_upgrade_dry_run !== true
    || options.source_id !== null
    || options.source_ids_filter_count !== manifest.source_count
    || options.limit !== manifest.source_count
    || selector.exact_source_count !== manifest.source_count
    || selector.dry_run !== true
    || !sameJson(selector.source_ids, manifest.source_ids)
  ) {
    throw new Error("The reviewed dry-run report did not execute the exact reviewed-nine selector.");
  }

  const stage1 = requiredObject(
    value.stage1_evidence_schema_upgrade,
    "dry-run report Stage 1 result",
  );
  if (
    stage1.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REPORT_SCHEMA
    || stage1.mode !== "dry_run"
    || stage1.manifest_sha256 !== manifestSha256
    || stage1.exact_source_count !== manifest.source_count
    || stage1.evaluated_source_count !== manifest.source_count
    || stage1.mutation_counts_are_exact !== true
    || stage1.mutation_count_semantics !== "exact"
    || stage1.mutation_count_uncertain_source_count !== 0
    || !sameJson(stage1.unknown_write_categories, [])
    || !sameJson(stage1.mutation_counts, zeroMutationCounts)
    || !sameJson(stage1.safety, dryRunSafety)
  ) {
    throw new Error("The reviewed Stage 1 dry-run report has unsafe or inconsistent aggregate state.");
  }
  requiredTimestamp(stage1.generated_at, "Stage 1 report generated_at");
  if (Date.parse(stage1.generated_at) > Date.parse(value.finished_at)) {
    throw new Error("The Stage 1 report was generated after the enclosing report finished.");
  }
  if (!Array.isArray(stage1.results) || stage1.results.length !== manifest.source_count) {
    throw new Error("The reviewed Stage 1 dry-run report does not contain exactly nine results.");
  }
  const resultIds = stage1.results.map((result) => result?.source_id);
  const resultIdSet = new Set(resultIds);
  if (
    resultIdSet.size !== manifest.source_count
    || manifest.source_ids.some((sourceId) => !resultIdSet.has(sourceId))
  ) {
    throw new Error("The reviewed Stage 1 dry-run results differ from the exact parent manifest membership.");
  }
  for (const result of stage1.results) {
    const row = requiredObject(result, "Stage 1 source result");
    assertExactKeys(row, sourceResultKeys, "Stage 1 source result");
    if (
      row.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA
      || row.mode !== "dry_run"
      || row.manifest_sha256 !== manifestSha256
      || !uuidPattern.test(row.source_id)
      || !dryRunResultStatuses.has(row.status)
      || !sameJson(row.mutation_counts, zeroMutationCounts)
      || !sameJson(row.safety, dryRunSafety)
    ) {
      throw new Error("A reviewed Stage 1 source result has an invalid dry-run identity.");
    }
  }
  assertDryRunAggregateTruth(stage1);
  assertDryRunEnvelopeTruth(value, stage1);
  return stage1;
}

function assertDryRunEnvelopeTruth(report, stage1) {
  const successful = new Set(["dry_run_complete", "completed"])
    .has(stage1.status);
  const expectedStatus = successful ? "completed" : "blocked";
  const expectedStopReason = successful
    ? null
    : "stage1_evidence_schema_upgrade_not_ready";
  if (
    report.worker_run_id !== null
    || report.status !== expectedStatus
    || report.execution_status !== expectedStatus
    || report.stop_reason !== expectedStopReason
  ) {
    throw new Error(
      "The reviewed Stage 1 dry-run envelope is inconsistent or records a worker-run mutation.",
    );
  }
}

function assertDryRunAggregateTruth(stage1) {
  const rows = stage1.results;
  const eligible = rows.filter((row) => row.source_eligible === true).length;
  const completed = rows.filter(
    (row) => row.status === "dry_run_already_upgraded",
  ).length;
  const quarantined = rows.filter((row) => (
    row.quarantine?.status === "quarantined"
    || row.quarantine?.status === "existing_hold"
  )).length;
  const blocked = rows.filter((row) => ![
    "dry_run_already_upgraded",
    "dry_run_ready",
  ].includes(row.status)).length;
  const expected = {
    eligible_source_count: eligible,
    upgraded_source_count: 0,
    candidate_source_count: 0,
    quarantined_source_count: quarantined,
    completed_source_count: completed,
    blocked_source_count: blocked,
    terminal_failure_source_count: blocked,
    automated_work_clear: blocked === 0 && quarantined === 0,
    quarantined_work_remaining: quarantined,
    status: blocked === 0 ? "dry_run_complete" : "blocked",
  };
  if (Object.entries(expected).some(([key, value]) => stage1[key] !== value)) {
    throw new Error("The reviewed Stage 1 dry-run aggregate does not match its exact results.");
  }
}

function assertManifestBinding(binding, manifest, manifestSha256) {
  const value = requiredObject(binding, "reviewed apply-plan manifest binding");
  assertExactKeys(value, ["schema_version", "sha256", "source_count"],
    "reviewed apply-plan manifest binding");
  if (
    value.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SCHEMA
    || value.sha256 !== manifestSha256
    || value.source_count !== manifest.source_count
  ) {
    throw new Error("The reviewed apply-plan parent manifest binding is invalid.");
  }
  requiredSha256(value.sha256, "reviewed apply-plan manifest SHA-256");
}

function assertReportBinding(binding, {
  report,
  stage1Report,
  reportFileSha256,
  manifestSha256,
}) {
  const value = requiredObject(binding, "reviewed apply-plan report binding");
  assertExactKeys(value, [
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
  ], "reviewed apply-plan report binding");
  const expected = {
    file_sha256: reportFileSha256,
    report_schema_version: report.report_schema_version,
    attempt_id: report.run_identity.attempt_id,
    worker_run_id: report.worker_run_id ?? null,
    started_at: report.started_at,
    finished_at: report.finished_at,
    stage1_report_schema_version: stage1Report.schema_version,
    stage1_report_generated_at: stage1Report.generated_at,
    stage1_report_sha256: sha256(canonicalJson(stage1Report)),
    manifest_sha256: manifestSha256,
  };
  for (const key of ["file_sha256", "stage1_report_sha256", "manifest_sha256"]) {
    requiredSha256(value[key], `reviewed apply-plan report ${key}`);
  }
  if (!sameJson(value, expected)) {
    throw new Error("The reviewed apply-plan does not bind the exact raw dry-run report.");
  }
}

function assertReadySourceResult({ sourceResult, manifestSource, manifestSha256 }) {
  const row = requiredObject(sourceResult, "selected dry-run source result");
  assertExactKeys(row, sourceResultKeys, "selected dry-run source result");
  requiredTimestamp(row.evaluated_at, "selected result evaluated_at");
  if (
    row.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA
    || row.mode !== "dry_run"
    || row.source_id !== manifestSource.source_id
    || row.manifest_sha256 !== manifestSha256
    || row.source_eligible !== true
    || row.status !== "dry_run_ready"
    || !cleanText(row.reason_code)
  ) {
    throw new Error("The selected source is not one exact dry_run_ready result.");
  }

  const eligibility = requiredObject(row.eligibility, "selected source eligibility");
  assertExactKeys(eligibility, [
    "activation_binding",
    "award",
    "eligible",
    "evidence_completeness_checked",
    "finalization_binding",
    "manifest_item",
    "page",
    "reason_codes",
    "semantic_difference_checked",
    "source_id",
  ], "selected source eligibility");
  if (
    eligibility.eligible !== true
    || eligibility.source_id !== manifestSource.source_id
    || eligibility.manifest_item !== manifestSource.item
    || eligibility.award !== manifestSource.award
    || eligibility.page !== manifestSource.page
    || !sameJson(eligibility.reason_codes, [])
    || eligibility.semantic_difference_checked !== false
    || eligibility.evidence_completeness_checked !== false
  ) {
    throw new Error("The selected source eligibility differs from the reviewed manifest.");
  }
  const activation = requiredObject(
    eligibility.activation_binding,
    "selected activation binding",
  );
  assertExactKeys(activation, ["allowed", "applies", "guard_sha256", "reason"],
    "selected activation binding");
  if (
    activation.applies !== true
    || activation.allowed !== true
    || activation.reason !== "stage1_baseline_activation_exact_binding_verified"
  ) {
    throw new Error("The selected source activation binding is not exact and allowed.");
  }
  requiredSha256(activation.guard_sha256, "selected activation guard SHA-256");

  const finalization = requiredObject(
    eligibility.finalization_binding,
    "selected finalization binding",
  );
  assertExactKeys(finalization, [
    "finalization_receipt_sha256",
    "finalized_at",
    "present",
    "source_acquisition_id",
  ], "selected finalization binding");
  if (finalization.present !== true) {
    throw new Error("The selected source finalization is absent.");
  }
  requiredUuid(finalization.source_acquisition_id, "selected acquisition ID");
  requiredSha256(
    finalization.finalization_receipt_sha256,
    "selected finalization receipt SHA-256",
  );
  requiredTimestamp(finalization.finalized_at, "selected finalization timestamp");

  const queuePolicy = requiredObject(row.queue_policy, "selected queue policy");
  assertExactKeys(queuePolicy, ["bypassRejectionLedger", "context", "queueReconciliation"],
    "selected queue policy");
  if (
    queuePolicy.context !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT
    || queuePolicy.bypassRejectionLedger !== true
    || queuePolicy.queueReconciliation !== false
  ) {
    throw new Error("The selected source queue policy is outside Stage 1 isolation.");
  }

  const validation = requiredObject(row.capture_validation, "selected capture validation");
  assertExactKeys(validation, ["decision", "evidence", "reason", "status"],
    "selected capture validation");
  if (
    validation.status !== "evaluated"
    || validation.decision !== "eligible_unchanged_upgrade"
    || validation.reason !== row.reason_code
  ) {
    throw new Error("The selected capture validation does not authorize only an unchanged upgrade.");
  }
  const evidence = requiredObject(validation.evidence, "selected validation evidence");
  if (evidence.source_id !== row.source_id) {
    throw new Error("The selected validation evidence belongs to another source.");
  }
  assertLocalBaselineIdentity(evidence.local_baseline_identity);
  assertExistingPointerIdentity(evidence.existing_pointer_identity);
  const acquisition = requiredObject(
    evidence.immutable_acquisition,
    "selected immutable acquisition",
  );
  assertExactKeys(acquisition, [
    "evidence_quote_count",
    "file_hash",
    "guard_sha256",
    "normalized_text_hash",
    "text_hash",
  ], "selected immutable acquisition");
  requiredSha256(acquisition.file_hash, "selected acquisition file SHA-256");
  requiredNullableSha256(acquisition.text_hash, "selected acquisition text SHA-256");
  requiredSha256(
    acquisition.normalized_text_hash,
    "selected acquisition normalized text SHA-256",
  );
  requiredPositiveInteger(
    acquisition.evidence_quote_count,
    "selected acquisition evidence quote count",
  );
  if (acquisition.guard_sha256 !== activation.guard_sha256) {
    throw new Error("The selected acquisition and activation guard hashes disagree.");
  }

  const r2 = requiredObject(
    evidence.authoritative_existing_r2_binding,
    "selected authoritative R2 binding",
  );
  assertR2Binding(r2, row.source_id, evidence.kind);
  if (
    !sameJson(row.pointer_journal, { status: "would_commit" })
    || !sameJson(row.visual_review_candidate, { status: "not_planned" })
    || !sameJson(row.quarantine, { status: "not_planned" })
    || !sameJson(row.safety, dryRunSafety)
    || !sameJson(row.mutation_counts, zeroMutationCounts)
  ) {
    throw new Error("The selected dry-run result contains an unauthorized planned outcome.");
  }
}

function assertR2Binding(receipt, sourceId, kind) {
  assertStage1EvidenceSchemaUpgradeR2BindingReceipt(receipt);
  const pointer = requiredObject(receipt.pointer_identity, "selected R2 pointer identity");
  const previous = requiredObject(receipt.previous_pointer, "selected previous R2 pointer");
  const keys = requiredObject(pointer.latest_object_keys, "selected R2 object keys");
  const hashes = requiredObject(pointer.latest_hashes, "selected R2 latest hashes");
  const roles = Array.isArray(receipt.verified_roles) ? receipt.verified_roles : null;
  if (
    receipt.source_id !== sourceId
    || receipt.kind !== kind
    || receipt.status !== "verified"
    || receipt.creates_api_charge !== false
    || receipt.mutation_performed !== false
    || pointer.shared_award_source_id !== sourceId
    || pointer.kind !== kind
    || !cleanText(pointer.bucket)
    || !generationPattern.test(pointer.immutable_generation)
    || !roles
    || roles.length === 0
  ) {
    throw new Error("The selected authoritative R2 binding identity is invalid.");
  }
  requiredTimestamp(receipt.captured_at, "selected R2 capture timestamp");
  requiredIsoTimestamp(pointer.latest_captured_at, "selected R2 pointer timestamp");
  requiredSha256(pointer.pointer_sha256, "selected R2 pointer SHA-256");
  requiredSha256(previous.projection_sha256, "selected previous R2 pointer SHA-256");
  requiredSha256(pointer.latest_metadata_sha256, "selected R2 metadata SHA-256");
  requiredSha256(receipt.receipt_sha256, "selected R2 receipt SHA-256");
  const roleNames = roles.map((role) => role?.role);
  if (
    new Set(roleNames).size !== roles.length
    || !sameJson([...roleNames].sort(), Object.keys(keys).sort())
  ) {
    throw new Error("The selected R2 verified role set differs from its pointer.");
  }
  for (const role of roles) {
    if (
      !cleanText(role.role)
      || role.key !== keys[role.role]
      || !sha256Pattern.test(role.sha256)
      || !Number.isSafeInteger(role.byte_length)
      || role.byte_length <= 0
      || !cleanText(role.content_type)
      || role.remote_body_verified !== true
    ) {
      throw new Error("A selected R2 verified role has an invalid exact-byte binding.");
    }
  }
  for (const hash of Object.values(hashes)) {
    requiredNullableSha256(hash, "selected R2 latest semantic SHA-256");
  }
  requiredSha256(receipt.semantic_text?.sha256, "selected R2 semantic text SHA-256");
  requiredPositiveInteger(
    receipt.semantic_text?.character_length,
    "selected R2 semantic text length",
  );
  requiredPositiveInteger(
    receipt.semantic_text?.object_byte_length,
    "selected R2 semantic text object length",
  );
  if (receipt.semantic_text?.writer_framing !== "lf") {
    throw new Error("The selected R2 semantic text framing is unsupported.");
  }
}

function selectedBinding({ sourceResult, manifestSource }) {
  const eligibility = sourceResult.eligibility;
  const activation = eligibility.activation_binding;
  const finalization = eligibility.finalization_binding;
  const validation = sourceResult.capture_validation;
  const evidence = validation.evidence;
  const acquisition = evidence.immutable_acquisition;
  const r2 = evidence.authoritative_existing_r2_binding;
  const pointer = r2.pointer_identity;
  const recoveryEvidence = {
    pdf_text_recovery: evidence.pdf_text_recovery ?? null,
    prior_recovery: evidence.prior_recovery ?? null,
  };
  return {
    source: cloneJson(manifestSource),
    result: {
      schema_version: sourceResult.schema_version,
      evaluated_at: sourceResult.evaluated_at,
      result_sha256: sha256(canonicalJson(sourceResult)),
      status: sourceResult.status,
      reason_code: sourceResult.reason_code,
    },
    validation: {
      status: validation.status,
      decision: validation.decision,
      reason: validation.reason,
      capture_validation_sha256: sha256(canonicalJson(validation)),
      fresh_projection_schema:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_FRESH_VALIDATION_PROJECTION_SCHEMA,
      fresh_projection_sha256:
        stage1EvidenceSchemaUpgradeFreshValidationSha256(sourceResult),
    },
    acquisition: {
      source_acquisition_id: finalization.source_acquisition_id,
      file_sha256: acquisition.file_hash,
      text_sha256: acquisition.text_hash,
      normalized_text_sha256: acquisition.normalized_text_hash,
      evidence_quote_count: acquisition.evidence_quote_count,
    },
    activation: {
      guard_sha256: activation.guard_sha256,
      binding_reason: activation.reason,
    },
    finalization: {
      receipt_sha256: finalization.finalization_receipt_sha256,
      finalized_at: finalization.finalized_at,
    },
    local_baseline_identity: cloneJson(evidence.local_baseline_identity),
    existing_pointer_identity: cloneJson(evidence.existing_pointer_identity),
    r2: {
      binding_receipt_sha256: r2.receipt_sha256,
      pointer_sha256: pointer.pointer_sha256,
      previous_pointer_projection_sha256: r2.previous_pointer.projection_sha256,
      latest_metadata_sha256: pointer.latest_metadata_sha256,
      immutable_generation: pointer.immutable_generation,
      bucket: pointer.bucket,
      kind: r2.kind,
      captured_at: r2.captured_at,
      pointer_latest_object_keys_sha256:
        sha256(canonicalJson(pointer.latest_object_keys)),
      pointer_latest_hashes_sha256:
        sha256(canonicalJson(pointer.latest_hashes)),
      verified_roles_sha256: sha256(canonicalJson(r2.verified_roles)),
      semantic_text_sha256: r2.semantic_text.sha256,
    },
    recovery_evidence_sha256: sha256(canonicalJson(recoveryEvidence)),
  };
}

function assertLocalBaselineIdentity(value) {
  const identity = requiredObject(value, "selected local baseline identity");
  assertExactKeys(identity, ["byte_length", "sha256"], "selected local baseline identity");
  requiredSha256(identity.sha256, "selected local baseline SHA-256");
  requiredPositiveInteger(identity.byte_length, "selected local baseline byte length");
  return identity;
}

function assertExistingPointerIdentity(value) {
  const identity = requiredObject(value, "selected existing pointer identity");
  assertExactKeys(
    identity,
    ["canonical_sha256", "exists", "schema_version"],
    "selected existing pointer identity",
  );
  if (
    identity.schema_version !== VISUAL_SNAPSHOT_POINTER_IDENTITY_SCHEMA
    || identity.exists !== true
  ) {
    throw new Error("The selected existing pointer identity is absent or unsupported.");
  }
  requiredSha256(identity.canonical_sha256, "selected existing pointer canonical SHA-256");
  return identity;
}

function assertExactDeferredComplement(value, expected) {
  if (!Array.isArray(value)
    || value.length !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_DEFERRED_COUNT) {
    throw new Error("The reviewed apply plan must defer exactly the other eight sources.");
  }
  const ids = value.map((sourceId) => requiredUuid(sourceId, "deferred source ID"));
  if (new Set(ids).size !== ids.length || !sameJson(ids, expected)) {
    throw new Error("The reviewed apply-plan deferred sources are not the exact ordered complement.");
  }
}

function assertReviewer(value, {
  now,
  reportFinishedAt,
  stage1GeneratedAt,
  historicalEvidenceOnly = false,
}) {
  const reviewer = requiredObject(value, "reviewed apply-plan reviewer");
  assertExactKeys(reviewer, ["expires_at", "reviewed_at", "reviewer_id"],
    "reviewed apply-plan reviewer");
  const reviewerId = cleanText(reviewer.reviewer_id);
  if (
    reviewerId !== reviewer.reviewer_id
    || reviewerId.length < 3
    || reviewerId.length > 200
    || /[\u0000-\u001f\u007f]/u.test(reviewerId)
  ) {
    throw new Error("The reviewed apply plan requires one exact non-control reviewer identity.");
  }
  const reviewedAt = requiredTimestamp(reviewer.reviewed_at, "plan reviewed_at");
  const expiresAt = requiredTimestamp(reviewer.expires_at, "plan expires_at");
  const reviewedMs = Date.parse(reviewedAt);
  const expiresMs = Date.parse(expiresAt);
  const nowMs = historicalEvidenceOnly
    ? reviewedMs
    : Date.parse(requiredTimestamp(now, "plan validation now"));
  if (
    reviewedMs < Date.parse(requiredTimestamp(reportFinishedAt, "report finished_at"))
    || reviewedMs < Date.parse(requiredTimestamp(stage1GeneratedAt, "Stage 1 generated_at"))
    || (!historicalEvidenceOnly && reviewedMs > nowMs)
    || (!historicalEvidenceOnly && expiresMs <= nowMs)
    || expiresMs <= reviewedMs
    || expiresMs - reviewedMs
      > STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_MAX_LIFETIME_MS
  ) {
    throw new Error("The reviewed apply plan is not currently valid within its bounded review window.");
  }
  return cloneJson(reviewer);
}

function stripProspectiveCaptureVolatility(value) {
  if (!plainObject(value)) return;
  delete value.captured_at;
  // This is the full visual-text-geometry evidence hash. It binds the capture
  // timestamp, archive-relative screenshot path, verification fingerprints,
  // and runtime selector paths, so it is intentionally unique per capture and
  // cannot serve as cross-capture geometry identity. Exact image, semantic,
  // coverage, artifact, and existing-authority evidence remain projected.
  delete value.layout_hash;
}

function stripPdfRecoveryVolatility(receipt) {
  delete receipt.receipt_sha256;
  if (plainObject(receipt.prospective_observation)) {
    delete receipt.prospective_observation.captured_at;
    // These describe raw metadata bytes whose canonical body contains the
    // prospective capture timestamp and local generation paths.
    delete receipt.prospective_observation.parser_metadata_object_sha256;
    delete receipt.prospective_observation.parser_metadata_object_bytes;
  }
  if (plainObject(receipt.authorized_local_candidate_mutation)) {
    delete receipt.authorized_local_candidate_mutation.captured_at;
  }
}

function parseCanonicalPlan(bytes) {
  const value = parseJsonBytes(bytes, "reviewed apply plan");
  const canonical = stage1EvidenceSchemaUpgradeReviewedApplyPlanCanonicalBytes(value);
  if (!Buffer.from(bytes).equals(canonical)) {
    throw new Error("The reviewed apply-plan file is not canonical sorted JSON with one LF.");
  }
  return value;
}

function parseReviewedReport(bytes) {
  const value = parseJsonBytes(bytes, "dry-run report");
  const canonical = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (!Buffer.from(bytes).equals(canonical)) {
    throw new Error(
      "The reviewed dry-run report is not the exact producer JSON serialization.",
    );
  }
  return value;
}

function parseJsonBytes(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`The ${label} is not exact UTF-8.`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`The ${label} is not one valid JSON value.`);
  }
  return requiredObject(value, label);
}

function exactBytes(value, label) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(`The ${label} must be a string or Uint8Array.`);
}

function assertExactKeys(value, expected, label) {
  const keys = Object.keys(requiredObject(value, label)).sort();
  const wanted = [...expected].sort();
  if (!sameJson(keys, wanted)) {
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
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`The ${label} must be one lowercase SHA-256.`);
  }
  return value;
}

function requiredNullableSha256(value, label) {
  if (value === null) return null;
  return requiredSha256(value, label);
}

function requiredUuid(value, label) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new Error(`The ${label} must be one lowercase UUID.`);
  }
  return value;
}

function requiredTimestamp(value, label) {
  if (typeof value !== "string") {
    throw new Error(`The ${label} must be a canonical UTC timestamp.`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`The ${label} must be a canonical UTC timestamp.`);
  }
  return value;
}

function requiredIsoTimestamp(value, label) {
  if (
    typeof value !== "string"
    || !isoTimestampPattern.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`The ${label} must be an ISO timestamp.`);
  }
  return value;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The ${label} must be a positive safe integer.`);
  }
  return value;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cloneJson(value) {
  return structuredClone(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
