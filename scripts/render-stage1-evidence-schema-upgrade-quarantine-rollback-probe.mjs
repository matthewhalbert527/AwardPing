import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stage1EvidenceSchemaUpgradeExpectedManifest } from "./lib/stage1-evidence-schema-upgrade.mjs";
import {
  buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs,
  prepareStage1EvidenceSchemaUpgradeQuarantineValidation,
  stage1EvidenceSchemaUpgradeQuarantineSafeAction,
} from "./lib/stage1-evidence-schema-upgrade-quarantine.mjs";
import {
  sealStage1EvidenceSchemaUpgradeMutationAccounting,
  zeroStage1EvidenceSchemaUpgradeMutationCounts,
} from "./lib/stage1-evidence-schema-upgrade-mutation-accounting.mjs";
import {
  advanceStage1EvidenceSchemaUpgradeJournal,
  buildStage1EvidenceSchemaUpgradeJournal,
} from "./lib/stage1-evidence-schema-upgrade-transaction.mjs";
import { visualSnapshotPointerIdentity } from "./lib/visual-snapshot-latest-only-reconciliation.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_MIGRATION =
  "20260814211159_stage1_evidence_schema_upgrade_failure_quarantine.sql";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_SMOKE =
  "stage1_evidence_schema_upgrade_failure_quarantine_smoke.sql";

const migrationMarker = "-- __AWARDPING_EXACT_MIGRATION__";
const smokeMarker = "-- __AWARDPING_EXACT_SMOKE__";
const priorMigrationsMarker =
  "-- __AWARDPING_EXACT_PRIOR_MIGRATION_VERSIONS__";
const manifestMarker = "-- __AWARDPING_EXACT_MANIFEST_JSON__";
const javascriptEvidenceMarker =
  "-- __AWARDPING_EXACT_JAVASCRIPT_EVIDENCE_JSON__";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(scriptDirectory, "../supabase/migrations");

function normalizeSql(name, sql) {
  const normalized = sql.replace(/\r\n/g, "\n").trim();
  if (normalized.includes("\r")) {
    throw new Error(`${name} contains unsupported standalone CR bytes.`);
  }
  if (/^\s*(?:begin|commit|rollback)\s*;/imu.test(normalized)) {
    throw new Error(`${name} contains transaction control and cannot be nested safely.`);
  }
  return normalized;
}

function exactSqlBlock({ label, name, sql }) {
  const normalized = normalizeSql(name, sql);
  const sha256 = createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex");
  return [
    `-- BEGIN EXACT ${label} ${name} sha256=${sha256}`,
    normalized,
    `-- END EXACT ${label} ${name}`,
  ].join("\n");
}

export function listStage1EvidenceSchemaUpgradeQuarantinePriorMigrationVersions() {
  const targetVersion = STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_MIGRATION
    .split("_", 1)[0];
  const versions = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .map((name) => ({ name, version: name.split("_", 1)[0] }))
    .filter(({ version }) => version.localeCompare(targetVersion) < 0)
    .sort((left, right) => left.version.localeCompare(right.version));
  if (versions.length === 0) {
    throw new Error("The Stage 1 upgrade quarantine has no prior migration preflight set.");
  }
  if (new Set(versions.map(({ version }) => version)).size !== versions.length) {
    throw new Error("Prior migration versions are not unique.");
  }
  return versions.map(({ version }) => version);
}

function exactPriorMigrationsBlock(versions) {
  const identity = versions.join("\n");
  const sha256 = createHash("sha256").update(identity, "utf8").digest("hex");
  return [
    `-- BEGIN EXACT PRIOR MIGRATION VERSIONS count=${versions.length} sha256=${sha256}`,
    "array[",
    ...versions.map(
      (version, index) =>
        `  '${version}'::text${index === versions.length - 1 ? "" : ","}`,
    ),
    "]::text[]",
    "-- END EXACT PRIOR MIGRATION VERSIONS",
  ].join("\n");
}

function exactManifestBlock() {
  const manifest = stableJson(stage1EvidenceSchemaUpgradeExpectedManifest());
  const sha256 = createHash("sha256").update(manifest, "utf8").digest("hex");
  return [
    `-- BEGIN EXACT REVIEWED-NINE MANIFEST sha256=${sha256}`,
    `'${manifest.replaceAll("'", "''")}'::jsonb`,
    "-- END EXACT REVIEWED-NINE MANIFEST",
  ].join("\n");
}

function exactJavaScriptEvidenceBlock() {
  const sourceId = "c30778fe-43d7-57be-842a-e046d84baaee";
  const priorCandidate = rollbackProbeCandidateEvidence(sourceId);
  const priorJournal = rollbackProbeRecoveryJournal({
    candidate: priorCandidate,
    sourceId,
    transactionId: "stage1-quarantine-rollback-probe-j1",
  });
  priorCandidate.journal_sha256 = priorJournal.journal_sha256;

  const mutationCounts = zeroStage1EvidenceSchemaUpgradeMutationCounts();
  mutationCounts.database_writes = 1;
  mutationCounts.source_state_writes = 1;
  const cas = {
    attempted: true,
    returned: null,
    threw: false,
    recovered: true,
    error_code: null,
    error_message: null,
    confirmed_database_pointer_writes: 0,
    write_attribution: "prior_invocation_not_counted",
  };
  const mutationAccounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: mutationCounts,
    unknownWriteCategories: [],
    evidence: {
      boundary: "result_built",
      journal_phase: "recovery_required",
      response_loss_possible: false,
      cas,
    },
  });
  const mutationFailure = {
    operation: "pointer_commit",
    error: Object.assign(
      new Error("Rollback-probe recovery needs durable quarantine."),
      { code: "rollback_probe_recovery_requires_quarantine" },
    ),
    mutation_accounting: mutationAccounting,
  };
  const candidateKeys = Object.values(
    priorCandidate.candidate_pointer_identity.projection.latest_object_keys,
  ).sort();
  const pointerCommitReceipt = {
    schema_version: "awardping.stage1.evidence-schema-upgrade-commit-receipt.v1",
    source_id: sourceId,
    context: "stage1_evidence_schema_upgrade",
    operation: "pointer_commit",
    status: "recovery_required",
    creates_api_charge: false,
    transaction_id: priorJournal.transaction_id,
    outcome: "authority_changed_after_source_health",
    journal_phase: "recovery_required",
    journal_sha256: priorJournal.journal_sha256,
    journal_archived: false,
    authoritative_pointer_state: "unknown",
    authoritative_baseline_state: "other",
    authoritative_pointer_sha256: null,
    authoritative_baseline_sha256: null,
    cas,
    cleanup_debt: {
      schema_version: "awardping.visual-snapshot.latest-only-cleanup-debt.v1",
      reason: "authoritative_pointer_unreadable",
      delete_performed: false,
      requires_authoritative_recheck: true,
      requires_published_reference_graph_check: false,
      candidate_keys: candidateKeys,
      protected_keys: [],
      eligible_keys: [],
      deferred_keys: candidateKeys,
      item_count: candidateKeys.length,
      eligible_count: 0,
    },
    cleanup_delete_performed: false,
    source_health: {
      status: "succeeded",
      mutation_counts: {
        database_writes: 1,
        r2_writes: 0,
        local_baseline_writes: 0,
        candidate_writes: 0,
        quarantine_writes: 0,
        source_state_writes: 1,
      },
    },
    mutation_count_scope: "confirmed_io_receipts_in_this_invocation",
    mutation_counts: mutationAccounting.lower_bound_counts,
    mutation_accounting: mutationAccounting,
  };

  const freshCandidate = rollbackProbeCandidateEvidence(sourceId, {
    version: "2".repeat(32),
    capturedAt: "2026-08-14T21:05:00.000Z",
    imageHash: "4".repeat(64),
    textHash: "5".repeat(64),
    layoutHash: "6".repeat(64),
  });
  const freshJournal = rollbackProbePreparedJournal({
    candidate: freshCandidate,
    sourceId,
    transactionId: "stage1-quarantine-rollback-probe-j2",
  });
  freshCandidate.journal_sha256 = freshJournal.journal_sha256;

  const buildScenario = ({ candidate, journal, scenario }) => {
    const sameJournal = journal.journal_sha256 === priorJournal.journal_sha256;
    const commitRecovery = {
      schema_version: "awardping.stage1.evidence-schema-upgrade-recovery-evidence.v1",
      source_id: sourceId,
      context: "stage1_evidence_schema_upgrade",
      status: "recovery_required",
      creates_api_charge: false,
      journal_sha256: journal.journal_sha256,
      journal,
      reason: sameJournal
        ? pointerCommitReceipt.outcome
        : "fresh_active_upgrade_journal_requires_reconciliation",
      safe_action:
        "Keep the source quarantined and reconcile this exact freshly verified journal before retrying.",
    };
    const validation = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      candidateArtifacts: candidate,
      commitRecovery,
      pointerCommitReceipt,
      mutationFailure,
      validation: {
        schema_version: "awardping.stage1.evidence-schema-upgrade-validation.v1",
        decision: "evidence_failure_quarantine",
        creates_api_charge: false,
        reason: `javascript_${scenario}_journal_probe`,
        reasons: [{
          code: `javascript_${scenario}_journal_probe`,
          detail: "Static JavaScript-to-PostgreSQL pointer-commit parity fixture.",
        }],
        evidence: {
          source_id: sourceId,
          safe_integer_boundary: 9007199254740991,
          pointer_commit_receipt: pointerCommitReceipt,
        },
        outcome: {
          would_commit: false,
          would_queue_visual_candidate: false,
          would_quarantine: true,
          creates_api_charge: false,
        },
      },
    });
    const fallbackSafeAction = "Static fallback action must be replaced.";
    return buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs({
      source: {
        id: sourceId,
        source_activation_finalization: {
          disposition_item_sha256: "b".repeat(64),
          finalization_receipt_sha256: "c".repeat(64),
        },
      },
      acquisition: {
        id: "11111111-1111-4111-8111-111111111111",
        origin_source_page_request_id: "22222222-2222-4222-8222-222222222222",
        review_seal: {
          human_source_disposition: {
            guard_sha256: "a".repeat(64),
            activation_guard: { decision_item_sha256: "b".repeat(64) },
          },
        },
      },
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      failureStage: "pointer_commit",
      reasonCode: `javascript_${scenario}_journal_probe`,
      detail: "Évidence strings remain UTF-8 while object keys and numbers stay canonical.",
      safeAction: stage1EvidenceSchemaUpgradeQuarantineSafeAction(
        validation,
        fallbackSafeAction,
      ),
      validation,
      r2Binding: null,
      r2BindingObserved: false,
      candidateArtifacts: candidate,
      candidatePlanObserved: true,
      commitRecovery,
      journalObserved: true,
    }).p_evidence;
  };

  const absentValidation = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
    mutationFailure,
    journalReadAbsent: { status: "absent", journal: null, error: null },
    validation: {
      schema_version: "awardping.stage1.evidence-schema-upgrade-validation.v1",
      decision: "evidence_failure_quarantine",
      creates_api_charge: false,
      reason: "javascript_absent_journal_probe",
      reasons: [{
        code: "javascript_absent_journal_probe",
        detail: "Static JavaScript-to-PostgreSQL verified-absence parity fixture.",
      }],
      evidence: {
        source_id: sourceId,
        safe_integer_boundary: 9007199254740991,
      },
      outcome: {
        would_commit: false,
        would_queue_visual_candidate: false,
        would_quarantine: true,
        creates_api_charge: false,
      },
    },
  });
  const absentEvidence = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs({
    source: {
      id: sourceId,
      source_activation_finalization: {
        disposition_item_sha256: "b".repeat(64),
        finalization_receipt_sha256: "c".repeat(64),
      },
    },
    acquisition: {
      id: "11111111-1111-4111-8111-111111111111",
      origin_source_page_request_id: "22222222-2222-4222-8222-222222222222",
      review_seal: {
        human_source_disposition: {
          guard_sha256: "a".repeat(64),
          activation_guard: { decision_item_sha256: "b".repeat(64) },
        },
      },
    },
    manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
    failureStage: "pointer_commit",
    reasonCode: "javascript_absent_journal_probe",
    detail: "Evidence strings remain UTF-8 while object keys and numbers stay canonical.",
    safeAction: stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      absentValidation,
      "Static fallback action must be replaced.",
    ),
    validation: absentValidation,
    r2Binding: null,
    r2BindingObserved: false,
    candidateArtifacts: null,
    candidatePlanObserved: false,
    commitRecovery: null,
    journalObserved: false,
  }).p_evidence;

  const captureAbsentValidation =
    prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      journalReadAbsent: { status: "absent", journal: null, error: null },
      validation: {
        schema_version: "awardping.stage1.evidence-schema-upgrade-validation.v1",
        decision: "evidence_failure_quarantine",
        creates_api_charge: false,
        reason: "javascript_capture_absent_probe",
        reasons: [{
          code: "javascript_capture_absent_probe",
          detail: "Static no-mutation verified-absence parity fixture.",
        }],
        evidence: {
          source_id: sourceId,
          safe_integer_boundary: 9007199254740991,
        },
        outcome: {
          would_commit: false,
          would_queue_visual_candidate: false,
          would_quarantine: true,
          creates_api_charge: false,
        },
      },
    });
  const captureAbsentEvidence =
    buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs({
      source: {
        id: sourceId,
        source_activation_finalization: {
          disposition_item_sha256: "b".repeat(64),
          finalization_receipt_sha256: "c".repeat(64),
        },
      },
      acquisition: {
        id: "11111111-1111-4111-8111-111111111111",
        origin_source_page_request_id:
          "22222222-2222-4222-8222-222222222222",
        review_seal: {
          human_source_disposition: {
            guard_sha256: "a".repeat(64),
            activation_guard: { decision_item_sha256: "b".repeat(64) },
          },
        },
      },
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      failureStage: "capture_validation",
      reasonCode: "javascript_capture_absent_probe",
      detail: "A successful fresh read verified that no journal exists.",
      safeAction: stage1EvidenceSchemaUpgradeQuarantineSafeAction(
        captureAbsentValidation,
        "Repair the capture evidence while the source remains quarantined.",
      ),
      validation: captureAbsentValidation,
      r2Binding: null,
      r2BindingObserved: false,
      candidateArtifacts: null,
      candidatePlanObserved: false,
      commitRecovery: null,
      journalObserved: false,
    }).p_evidence;

  const evidence = {
    absent: absentEvidence,
    capture_absent: captureAbsentEvidence,
    changed: buildScenario({
      candidate: freshCandidate,
      journal: freshJournal,
      scenario: "changed",
    }),
    same: buildScenario({
      candidate: priorCandidate,
      journal: priorJournal,
      scenario: "same",
    }),
  };
  const json = stableJson(evidence);
  const envelopeSha256 = createHash("sha256").update(json, "utf8").digest("hex");
  return [
    `-- BEGIN EXACT JAVASCRIPT EVIDENCE sha256=${envelopeSha256}`,
    `'${json.replaceAll("'", "''")}'::jsonb`,
    "-- END EXACT JAVASCRIPT EVIDENCE",
  ].join("\n");
}

function rollbackProbeRecoveryJournal({ candidate, sourceId, transactionId }) {
  const prepared = rollbackProbePreparedJournal({
    candidate,
    sourceId,
    transactionId,
  });
  return advanceStage1EvidenceSchemaUpgradeJournal(prepared, {
    expectedPhase: "prepared",
    nextPhase: "recovery_required",
    at: candidate.captured_at,
    detail: { outcome: "ambiguous_authority" },
  });
}

function rollbackProbePreparedJournal({ candidate, sourceId, transactionId }) {
  return buildStage1EvidenceSchemaUpgradeJournal({
    transactionId,
    sourceId,
    oldBaselineBytes: null,
    oldPointer: null,
    candidateBaselineBytes: Buffer.from(
      JSON.stringify({ kind: "webpage", source_id: sourceId }),
      "utf8",
    ),
    candidatePointer: candidate.candidate_pointer_identity.projection,
    createdAt: candidate.captured_at,
  });
}

function rollbackProbeCandidateEvidence(sourceId, {
  version = "1".repeat(32),
  capturedAt = "2026-08-14T21:00:00.000Z",
  imageHash = "1".repeat(64),
  textHash = "2".repeat(64),
  layoutHash = "9".repeat(64),
} = {}) {
  const roles = [
    "page",
    "thumb",
    "text",
    "meta",
    "layout",
    "expansion_state_01",
    "expansion_state_01_layout",
  ];
  const fileNames = {
    page: "page.jpg",
    thumb: "thumb.jpg",
    text: "text.txt",
    meta: "meta.json",
    layout: "layout.json",
    expansion_state_01: "expansion-state-01.jpg",
    expansion_state_01_layout: "expansion-state-01-layout.json",
  };
  const contentTypes = {
    page: "image/jpeg",
    thumb: "image/jpeg",
    text: "text/plain; charset=utf-8",
    meta: "application/json; charset=utf-8",
    layout: "application/json; charset=utf-8",
    expansion_state_01: "image/jpeg",
    expansion_state_01_layout: "application/json; charset=utf-8",
  };
  const bindings = Object.fromEntries(roles.map((role, index) => [
    role,
    {
      sha256: String(index + 1).repeat(64),
      byte_length: 100 + index,
      content_type: contentTypes[role],
      hash_mode: "raw_sha256",
    },
  ]));
  const objectKeys = Object.fromEntries(roles.map((role) => [
    role,
    `visual-snapshots/sources/${sourceId}/captures/${version}/${fileNames[role]}`,
  ]));
  const pointer = {
    shared_award_source_id: sourceId,
    shared_award_id: "33333333-3333-4333-8333-333333333333",
    source_url: "https://example.test/eligibility",
    source_title: "Eligibility",
    source_page_type: "eligibility",
    kind: "webpage",
    bucket: "awardping-evidence",
    latest_captured_at: capturedAt,
    latest_object_keys: objectKeys,
    latest_hashes: {
      image_hash: imageHash,
      text_hash: textHash,
      body_text_hash: null,
      main_content_hash: null,
      nav_header_footer_hash: null,
      expansion_hash: null,
      layout_hash: layoutHash,
      file_hash: null,
    },
    latest_metadata: {
      artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
      artifact_bindings: bindings,
      retained_artifact_projection: {
        schema: "awardping.capture-retained-artifact-projection.v1",
        kind: "webpage",
        localization_status: "exact_geometry_available",
        authoritative: {
          layout_retained: true,
          layout_hash: layoutHash,
          expansion_state_count: 1,
        },
      },
    },
    previous_captured_at: null,
    previous_object_keys: {},
    previous_hashes: {},
    previous_metadata: {},
    updated_at: "2026-08-14T21:00:01.000Z",
  };
  return {
    schema_version: "awardping.stage1.evidence-schema-upgrade-candidate-artifacts.v1",
    source_id: sourceId,
    kind: "webpage",
    bucket: pointer.bucket,
    version,
    captured_at: capturedAt,
    candidate_pointer_identity: visualSnapshotPointerIdentity(pointer),
    journal_sha256: null,
    artifacts: roles.map((role) => ({
      role,
      bucket: pointer.bucket,
      version,
      object_key: objectKeys[role],
      ...bindings[role],
    })),
    creates_api_charge: false,
    public_fact_authority: false,
  };
}

export function renderStage1EvidenceSchemaUpgradeQuarantineRollbackProbe() {
  const template = readFileSync(
    resolve(
      scriptDirectory,
      "sql/stage1-evidence-schema-upgrade-quarantine-rollback-probe.sql",
    ),
    "utf8",
  );
  for (const marker of [
    migrationMarker,
    smokeMarker,
    priorMigrationsMarker,
    manifestMarker,
    javascriptEvidenceMarker,
  ]) {
    if (template.split(marker).length !== 2) {
      throw new Error(
        `Rollback-probe template must contain exactly one ${marker} marker.`,
      );
    }
  }

  const migration = exactSqlBlock({
    label: "MIGRATION",
    name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_MIGRATION,
    sql: readFileSync(
      resolve(
        migrationsDirectory,
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_MIGRATION,
      ),
      "utf8",
    ),
  });
  const smoke = exactSqlBlock({
    label: "SMOKE",
    name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_SMOKE,
    sql: readFileSync(
      resolve(
        scriptDirectory,
        `../supabase/tests/${STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_SMOKE}`,
      ),
      "utf8",
    ),
  });
  const priorMigrations = exactPriorMigrationsBlock(
    listStage1EvidenceSchemaUpgradeQuarantinePriorMigrationVersions(),
  );

  return `${template
    .replace(priorMigrationsMarker, () => priorMigrations)
    .replace(migrationMarker, () => migration)
    .replace(smokeMarker, () => smoke)
    .replace(manifestMarker, () => exactManifestBlock())
    .replace(javascriptEvidenceMarker, () => exactJavaScriptEvidenceBlock())
    .replace(/\r\n/g, "\n")
    .trimEnd()}\n`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  process.stdout.write(
    renderStage1EvidenceSchemaUpgradeQuarantineRollbackProbe(),
  );
}
