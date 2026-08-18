import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { renderStage1EvidenceSchemaUpgradeQuarantineRollbackProbe } from "./render-stage1-evidence-schema-upgrade-quarantine-rollback-probe.mjs";
import {
  runStage1PendingMigrationRollbackProbe,
  STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER,
} from "./run-stage1-pending-migration-rollback-probe.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_ROLLBACK_PROBE_EXPECTED_ROW =
  Object.freeze({
    status: STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER,
    probe:
      "awardping_stage1_evidence_schema_upgrade_quarantine_probe_passed",
    exact_migration_count: 1,
    exact_smoke_count: 1,
    immutable_failure_audit_delta: 3,
    source_specific_quarantine_delta: 1,
    public_award_update_delta: 0,
    stage1_publication_safety_event_delta: 1,
    stage1_release_safety_event_delta: 1,
    manual_quarantine_event_delta: 4,
    manual_quarantine_backlog_revision_delta: 4,
    visual_candidate_delta: 0,
    paid_lane_delta: 0,
    exact_migration:
      "20260814211159_stage1_evidence_schema_upgrade_failure_quarantine.sql",
    exact_smoke: "stage1_evidence_schema_upgrade_failure_quarantine_smoke.sql",
    persistence_result:
      "migration/smoke/positive replay/catalog/application changes rolled back",
  });

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_ROLLBACK_PROBE_USAGE = `Usage: node scripts/run-stage1-evidence-schema-upgrade-quarantine-rollback-probe.mjs [--help|-h]

Requires every prior repository migration, then runs only migration
20260814211159 and its service-role smoke against the linked database. A valid
two-call quarantine replay must produce one audit/case and one source hold, all
paid/public-event counters must remain unchanged, and the transaction is then
rolled back with exact catalog and application-state restoration checks.

Options:
  -h, --help  Show this help without connecting to the database.
`;

export function runStage1EvidenceSchemaUpgradeQuarantineRollbackProbe({
  execute = runStage1PendingMigrationRollbackProbe,
  render = renderStage1EvidenceSchemaUpgradeQuarantineRollbackProbe,
} = {}) {
  return execute({
    render,
    expectedResultRow:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_ROLLBACK_PROBE_EXPECTED_ROW,
  });
}

export function runStage1EvidenceSchemaUpgradeQuarantineRollbackProbeCli({
  argv = process.argv.slice(2),
  run = runStage1EvidenceSchemaUpgradeQuarantineRollbackProbe,
  stdout = process.stdout,
} = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    stdout.write(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_ROLLBACK_PROBE_USAGE,
    );
    return { status: "help" };
  }
  if (argv.length > 0) {
    throw new Error(
      `Unknown argument${argv.length === 1 ? "" : "s"}: ${argv.join(" ")}\n` +
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_ROLLBACK_PROBE_USAGE,
    );
  }
  return run();
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    runStage1EvidenceSchemaUpgradeQuarantineRollbackProbeCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
