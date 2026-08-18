import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  renderStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbe,
} from "./render-stage1-evidence-schema-upgrade-quarantine-v3-accounting-rollback-probe.mjs";
import {
  runStage1PendingMigrationRollbackProbe,
  STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER,
} from "./run-stage1-pending-migration-rollback-probe.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ROLLBACK_PROBE_EXPECTED_ROW =
  Object.freeze({
    status: STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER,
    probe: "awardping_stage1_quarantine_v3_accounting_rollback_probe_passed",
    exact_migration_count: 1,
    exact_smoke_count: 1,
    function_definition_restored: true,
    function_metadata_restored: true,
    paired_v1_v2_constraint_restored: true,
    application_rows_unchanged: true,
    migration_history_unchanged: true,
  });

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ROLLBACK_PROBE_USAGE = `Usage: node scripts/run-stage1-evidence-schema-upgrade-quarantine-v3-accounting-rollback-probe.mjs [--help|-h]

Requires every prior repository migration, then runs only migration
20260815083322 and its read-only catalog/role smoke against the linked database
inside one transaction. Verifies exact function, constraint, application-row,
and migration-history rollback and persists no change.

Options:
  -h, --help  Show this help without connecting to the database.
`;

export function runStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbe({
  execute = runStage1PendingMigrationRollbackProbe,
  render = renderStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbe,
} = {}) {
  return execute({
    render,
    expectedResultRow:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ROLLBACK_PROBE_EXPECTED_ROW,
  });
}

export function runStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbeCli({
  argv = process.argv.slice(2),
  run = runStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbe,
  stdout = process.stdout,
} = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    stdout.write(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ROLLBACK_PROBE_USAGE,
    );
    return { status: "help" };
  }
  if (argv.length > 0) {
    throw new Error(
      `Unknown argument${argv.length === 1 ? "" : "s"}: ${argv.join(" ")}\n` +
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ROLLBACK_PROBE_USAGE,
    );
  }
  return run();
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    runStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbeCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
