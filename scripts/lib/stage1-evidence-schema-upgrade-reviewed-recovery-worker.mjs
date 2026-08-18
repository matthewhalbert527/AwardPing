import { createHash } from "node:crypto";
import {
  validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";
import {
  stage1EvidenceSchemaUpgradeReviewedApplyTransactionId,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-execution.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_INSPECTION_SCHEMA as RECOVERY_INSPECTION_SCHEMA,
  createStage1EvidenceSchemaUpgradeReviewedRecoveryPlan,
  createStage1EvidenceSchemaUpgradeReviewedRecoveryPlanDraft,
  stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-plan.mjs";
import {
  runStage1EvidenceSchemaUpgradeReviewedRecoveryExecution,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-execution.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_INSPECTION_MODE =
  "inspect_and_generate_sealed_evidence";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_SEAL_MODE =
  "seal_separately_reviewed_exact_transaction_plan";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_EXECUTION_MODE =
  "execute_separately_reviewed_exact_transaction";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_INSPECTION_SCHEMA =
  RECOVERY_INSPECTION_SCHEMA;

const INSPECTION_INTERFACES = Object.freeze([
  "readRecoveryEvidence",
  "withSourceLock",
]);

/**
 * Read-only recovery inspection and canonical evidence generation. The only local
 * write belongs to the CLI after this function returns the exact evidence bytes;
 * this function cannot mutate a journal, baseline, audit row, source row, R2,
 * pointer, candidate, quarantine, public fact, or hold.
 */
export async function inspectStage1EvidenceSchemaUpgradeReviewedRecovery({
  applyPlanBytes,
  expectedApplyPlanFileSha256,
  reviewedDryRunReportBytes,
  manifest,
  interfaces = {},
  now = () => new Date().toISOString(),
} = {}) {
  const historical =
    validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence({
      planBytes: applyPlanBytes,
      expectedPlanFileSha256: expectedApplyPlanFileSha256,
      reportBytes: reviewedDryRunReportBytes,
      manifest,
    });
  const io = exactInterfaces(interfaces, INSPECTION_INTERFACES, "inspection");
  const sourceId = historical.selected_source_id;
  const transactionId = stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
    sourceId,
    planSha256: historical.plan_sha256,
  });
  const clock = monotonicInspectionClock(now);
  let entered = false;
  let generated = null;
  let lockError = null;
  try {
    await io.withSourceLock(deepFreeze({
      source_id: sourceId,
      transaction_id: transactionId,
      read_only: true,
      creates_api_charge: false,
      execute: async () => {
        if (entered) throw new Error("Recovery inspection source lock executed twice.");
        entered = true;
        clock.read();
        const evidence = exactEvidence(await io.readRecoveryEvidence(deepFreeze({
          source_id: sourceId,
          transaction_id: transactionId,
          reviewed_apply_plan_file_sha256: historical.plan_file_sha256,
          reviewed_apply_plan_sha256: historical.plan_sha256,
          read_only: true,
          creates_api_charge: false,
        })));
        const observedAt = clock.read();
        generated = buildInspectionArtifact({
          historical,
          sourceId,
          transactionId,
          evidence,
          observedAt,
          applyPlanBytes,
          expectedApplyPlanFileSha256,
          reviewedDryRunReportBytes,
          manifest,
        });
        return generated;
      },
    }));
  } catch (error) {
    lockError = error;
  }
  if (!entered) throw lockError || new Error("Recovery inspection source lock did not execute.");
  if (lockError) {
    throw Object.assign(
      new Error("Recovery inspection lock completion was not acknowledged; discard its evidence bytes."),
      { code: "reviewed_recovery_inspection_lock_response_lost", cause: lockError },
    );
  }
  clock.read();
  if (!generated) throw new Error("Recovery inspection produced no canonical evidence artifact.");
  return generated;
}

/**
 * Pure local review/seal step. It performs no runtime I/O and turns one exact
 * self-sealed inspection artifact into the separately reviewed recovery plan.
 */
export function sealStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
  inspectionBytes,
  expectedInspectionFileSha256,
  applyPlanBytes,
  expectedApplyPlanFileSha256,
  reviewedDryRunReportBytes,
  manifest,
  reviewer,
  now = () => new Date().toISOString(),
} = {}) {
  const historical =
    validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence({
      planBytes: applyPlanBytes,
      expectedPlanFileSha256: expectedApplyPlanFileSha256,
      reportBytes: reviewedDryRunReportBytes,
      manifest,
    });
  const inspected = assertStage1EvidenceSchemaUpgradeReviewedRecoveryInspectionArtifact({
    inspectionBytes,
    expectedInspectionFileSha256,
    historical,
  });
  const proposedPlan = createStage1EvidenceSchemaUpgradeReviewedRecoveryPlanDraft({
    applyPlanBytes,
    expectedApplyPlanFileSha256,
    reviewedDryRunReportBytes,
    manifest,
    auditInspection: inspected.evidence.auditInspection,
    journals: inspected.evidence.journals,
    currentAuthoritySnapshot: inspected.evidence.currentAuthoritySnapshot,
    evidenceObservedAt: inspected.inspection.evidence_observed_at,
  });
  if (!sameJson(proposedPlan, inspected.inspection.proposed_plan)) {
    throw new Error("Reviewed recovery inspection proposed plan changed during sealing.");
  }
  return createStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
    applyPlanBytes,
    expectedApplyPlanFileSha256,
    reviewedDryRunReportBytes,
    manifest,
    auditInspection: inspected.evidence.auditInspection,
    journals: inspected.evidence.journals,
    currentAuthoritySnapshot: inspected.evidence.currentAuthoritySnapshot,
    reviewer,
    inspectionBinding: {
      schema_version: inspected.inspection.schema_version,
      mode: inspected.inspection.mode,
      inspection_file_sha256: inspected.inspectionFileSha256,
      inspection_sha256: inspected.inspection.inspection_sha256,
      proposed_plan_sha256: proposedPlan.draft_sha256,
    },
    evidenceObservedAt: inspected.inspection.evidence_observed_at,
    now: readClock(now),
  });
}

function buildInspectionArtifact({
  historical,
  sourceId,
  transactionId,
  evidence,
  observedAt,
  applyPlanBytes,
  expectedApplyPlanFileSha256,
  reviewedDryRunReportBytes,
  manifest,
}) {
  const baseline = Buffer.from(evidence.currentAuthoritySnapshot.currentBaselineBytes);
  const proposedPlan = createStage1EvidenceSchemaUpgradeReviewedRecoveryPlanDraft({
    applyPlanBytes,
    expectedApplyPlanFileSha256,
    reviewedDryRunReportBytes,
    manifest,
    auditInspection: evidence.auditInspection,
    journals: evidence.journals,
    currentAuthoritySnapshot: evidence.currentAuthoritySnapshot,
    evidenceObservedAt: observedAt,
  });
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_INSPECTION_SCHEMA,
    mode: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_INSPECTION_MODE,
    evidence_observed_at: observedAt,
    source_id: sourceId,
    transaction_id: transactionId,
    reviewed_apply_plan_file_sha256: historical.plan_file_sha256,
    reviewed_apply_plan_sha256: historical.plan_sha256,
    audit_inspection: cloneJson(evidence.auditInspection),
    journals: cloneJson(evidence.journals),
    current_authority_snapshot: {
      current_source: cloneJson(evidence.currentAuthoritySnapshot.currentSource),
      acquisition_projection: cloneJson(
        evidence.currentAuthoritySnapshot.acquisitionProjection,
      ),
      activation_projection: cloneJson(
        evidence.currentAuthoritySnapshot.activationProjection,
      ),
      finalization_projection: cloneJson(
        evidence.currentAuthoritySnapshot.finalizationProjection,
      ),
      current_baseline: {
        encoding: "base64",
        byte_length: baseline.byteLength,
        sha256: sha256(baseline),
        bytes_base64: baseline.toString("base64"),
      },
      current_pointer: cloneJson(evidence.currentAuthoritySnapshot.currentPointer),
      r2_binding_receipt: cloneJson(
        evidence.currentAuthoritySnapshot.r2BindingReceipt,
      ),
    },
    evidence_sha256: stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256(
      evidence,
    ),
    proposed_plan: cloneJson(proposedPlan),
    mutation_performed: false,
    creates_api_charge: false,
  };
  const inspection = deepFreeze({
    ...content,
    inspection_sha256: sha256(canonicalJson(content)),
  });
  const inspectionBytes = Buffer.from(canonicalJson(inspection), "utf8");
  return deepFreeze({
    inspection,
    inspection_bytes: inspectionBytes,
    inspection_file_sha256: sha256(inspectionBytes),
  });
}

export function assertStage1EvidenceSchemaUpgradeReviewedRecoveryInspectionArtifact({
  inspectionBytes,
  expectedInspectionFileSha256,
  historical,
}) {
  const bytes = exactBytes(inspectionBytes, "reviewed recovery inspection artifact");
  if (sha256(bytes) !== requiredSha256(
    expectedInspectionFileSha256,
    "expected reviewed recovery inspection file SHA-256",
  )) throw new Error("Reviewed recovery inspection file SHA-256 differs from its review.");
  let inspection;
  try {
    inspection = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Reviewed recovery inspection artifact is not valid JSON.");
  }
  assertExactKeys(inspection, [
    "audit_inspection",
    "creates_api_charge",
    "current_authority_snapshot",
    "evidence_observed_at",
    "evidence_sha256",
    "inspection_sha256",
    "journals",
    "mode",
    "mutation_performed",
    "proposed_plan",
    "reviewed_apply_plan_file_sha256",
    "reviewed_apply_plan_sha256",
    "schema_version",
    "source_id",
    "transaction_id",
  ], "reviewed recovery inspection artifact");
  const content = cloneJson(inspection);
  delete content.inspection_sha256;
  if (
    inspection.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_INSPECTION_SCHEMA
    || inspection.mode
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_INSPECTION_MODE
    || inspection.mutation_performed !== false
    || inspection.creates_api_charge !== false
    || inspection.reviewed_apply_plan_file_sha256 !== historical.plan_file_sha256
    || inspection.reviewed_apply_plan_sha256 !== historical.plan_sha256
    || inspection.source_id !== historical.selected_source_id
    || inspection.transaction_id !== stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
      sourceId: historical.selected_source_id,
      planSha256: historical.plan_sha256,
    })
    || inspection.inspection_sha256 !== sha256(canonicalJson(content))
    || !bytes.equals(Buffer.from(canonicalJson(inspection), "utf8"))
  ) throw new Error("Reviewed recovery inspection artifact identity or self seal is invalid.");
  readClock(inspection.evidence_observed_at);
  const snapshot = requiredObject(
    inspection.current_authority_snapshot,
    "reviewed recovery inspection current authority",
  );
  assertExactKeys(snapshot, [
    "acquisition_projection",
    "activation_projection",
    "current_baseline",
    "current_pointer",
    "current_source",
    "finalization_projection",
    "r2_binding_receipt",
  ], "reviewed recovery inspection current authority");
  const encoded = requiredObject(
    snapshot.current_baseline,
    "reviewed recovery inspection baseline bytes",
  );
  assertExactKeys(encoded, ["byte_length", "bytes_base64", "encoding", "sha256"],
    "reviewed recovery inspection baseline bytes");
  if (encoded.encoding !== "base64" || typeof encoded.bytes_base64 !== "string") {
    throw new Error("Reviewed recovery inspection baseline encoding is invalid.");
  }
  const baseline = Buffer.from(encoded.bytes_base64, "base64");
  if (
    baseline.toString("base64") !== encoded.bytes_base64
    || baseline.byteLength !== encoded.byte_length
    || sha256(baseline) !== requiredSha256(encoded.sha256, "inspection baseline SHA-256")
  ) throw new Error("Reviewed recovery inspection baseline bytes are not exact.");
  const evidence = {
    auditInspection: cloneJson(inspection.audit_inspection),
    journals: cloneJson(inspection.journals),
    currentAuthoritySnapshot: {
      currentSource: cloneJson(snapshot.current_source),
      acquisitionProjection: cloneJson(snapshot.acquisition_projection),
      activationProjection: cloneJson(snapshot.activation_projection),
      finalizationProjection: cloneJson(snapshot.finalization_projection),
      currentBaselineBytes: baseline,
      currentPointer: cloneJson(snapshot.current_pointer),
      r2BindingReceipt: cloneJson(snapshot.r2_binding_receipt),
    },
  };
  if (
    inspection.evidence_sha256
      !== stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256(evidence)
  ) throw new Error("Reviewed recovery inspection live-evidence seal is invalid.");
  return deepFreeze({
    inspection: cloneJson(inspection),
    inspectionFileSha256: sha256(bytes),
    evidence,
  });
}

/**
 * Execution wrapper kept separate from inspection so a caller cannot turn a
 * freshly generated artifact into an implicit apply. Both the exact raw file
 * SHA and the visible self SHA must be supplied from the external review.
 */
export async function executeStage1EvidenceSchemaUpgradeReviewedRecovery({
  recoveryPlanBytes,
  expectedRecoveryPlanFileSha256,
  expectedRecoveryPlanSha256,
  inspectionBytes,
  expectedInspectionFileSha256,
  applyPlanBytes,
  expectedApplyPlanFileSha256,
  reviewedDryRunReportBytes,
  manifest,
  interfaces,
  now = () => new Date().toISOString(),
} = {}) {
  const recoveryPlan = assertExpectedSelfSha(
    recoveryPlanBytes,
    expectedRecoveryPlanSha256,
  );
  const historical =
    validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence({
      planBytes: applyPlanBytes,
      expectedPlanFileSha256: expectedApplyPlanFileSha256,
      reportBytes: reviewedDryRunReportBytes,
      manifest,
    });
  const inspected = assertStage1EvidenceSchemaUpgradeReviewedRecoveryInspectionArtifact({
    inspectionBytes,
    expectedInspectionFileSha256,
    historical,
  });
  if (!sameJson(
    recoveryPlan.inspection,
    stage1EvidenceSchemaUpgradeReviewedRecoveryInspectionPlanBinding(inspected),
  )) throw new Error("Reviewed recovery plan is not bound to the reviewed inspection artifact.");
  return runStage1EvidenceSchemaUpgradeReviewedRecoveryExecution({
    recoveryPlanBytes,
    expectedRecoveryPlanFileSha256,
    applyPlanBytes,
    expectedApplyPlanFileSha256,
    reviewedDryRunReportBytes,
    manifest,
    interfaces,
    now,
  });
}

function assertExpectedSelfSha(planBytes, expected) {
  const sha = requiredSha256(expected, "expected reviewed recovery plan self SHA-256");
  let plan;
  try {
    plan = JSON.parse(Buffer.from(planBytes).toString("utf8"));
  } catch {
    throw new Error("Reviewed recovery plan bytes are not valid JSON.");
  }
  if (plan?.plan_sha256 !== sha) {
    throw new Error("Reviewed recovery plan self SHA-256 differs from the external review.");
  }
  return plan;
}

export function stage1EvidenceSchemaUpgradeReviewedRecoveryInspectionPlanBinding(
  inspected,
) {
  const value = requiredObject(inspected, "reviewed recovery inspected artifact");
  const inspection = requiredObject(value.inspection, "reviewed recovery inspection");
  return deepFreeze({
    schema_version: inspection.schema_version,
    mode: inspection.mode,
    inspection_file_sha256: requiredSha256(
      value.inspectionFileSha256,
      "reviewed recovery inspection file SHA-256",
    ),
    inspection_sha256: requiredSha256(
      inspection.inspection_sha256,
      "reviewed recovery inspection self SHA-256",
    ),
    proposed_plan_sha256: requiredSha256(
      inspection.proposed_plan?.draft_sha256,
      "reviewed recovery proposed plan SHA-256",
    ),
    evidence_sha256: requiredSha256(
      inspection.evidence_sha256,
      "reviewed recovery inspection evidence SHA-256",
    ),
    evidence_observed_at: readClock(inspection.evidence_observed_at),
    source_id: requiredText(inspection.source_id, "reviewed recovery inspection source ID"),
    transaction_id: requiredText(
      inspection.transaction_id,
      "reviewed recovery inspection transaction ID",
    ),
  });
}

function exactEvidence(value) {
  const evidence = requiredObject(value, "reviewed recovery evidence read");
  assertExactKeys(
    evidence,
    ["auditInspection", "currentAuthoritySnapshot", "journals"],
    "reviewed recovery evidence read",
  );
  const journals = requiredObject(evidence.journals, "reviewed recovery journal locations");
  assertExactKeys(journals, ["active", "archived"], "reviewed recovery journal locations");
  return evidence;
}

function exactInterfaces(value, names, label) {
  const interfaces = requiredObject(value, `reviewed recovery ${label} interfaces`);
  assertExactKeys(interfaces, names, `reviewed recovery ${label} interfaces`);
  for (const name of names) {
    if (typeof interfaces[name] !== "function") {
      throw new TypeError(`Reviewed recovery ${label} interface ${name} is required.`);
    }
  }
  return interfaces;
}

function readClock(value) {
  const raw = typeof value === "function" ? value() : value;
  const text = typeof raw === "string" ? raw.trim() : "";
  const milliseconds = Date.parse(text);
  if (!text || !Number.isFinite(milliseconds)) {
    throw new Error("Reviewed recovery inspection time is invalid.");
  }
  return new Date(milliseconds).toISOString();
}

function monotonicInspectionClock(value) {
  let lastMilliseconds = null;
  return Object.freeze({
    read() {
      const current = readClock(value);
      const milliseconds = Date.parse(current);
      if (lastMilliseconds !== null && milliseconds < lastMilliseconds) {
        throw new Error("Reviewed recovery inspection clock moved backward.");
      }
      lastMilliseconds = milliseconds;
      return current;
    },
  });
}

function requiredSha256(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{64}$/u.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function requiredText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function exactBytes(value, label) {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    throw new TypeError(`${label} bytes are required.`);
  }
  return Buffer.from(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}
