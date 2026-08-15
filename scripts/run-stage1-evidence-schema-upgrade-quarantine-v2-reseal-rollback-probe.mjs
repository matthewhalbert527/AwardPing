import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  renderStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbe,
} from "./render-stage1-evidence-schema-upgrade-quarantine-v2-reseal-rollback-probe.mjs";
import {
  runStage1PendingMigrationRollbackProbe,
} from "./run-stage1-pending-migration-rollback-probe.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_ROLLBACK_PROBE_USAGE = `Usage: node scripts/run-stage1-evidence-schema-upgrade-quarantine-v2-reseal-rollback-probe.mjs [--help|-h]

Requires every prior repository migration, then runs only migration
20260815012910 and its read-only catalog/role smoke against the linked database
inside one transaction. Verifies exact function, constraint, application-row,
and migration-history rollback and persists no change.

Options:
  -h, --help  Show this help without connecting to the database.
`;

export function runStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbe({
  execute = runStage1PendingMigrationRollbackProbe,
  render = renderStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbe,
} = {}) {
  return execute({ render });
}

export function runStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbeCli({
  argv = process.argv.slice(2),
  run = runStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbe,
  stdout = process.stdout,
} = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    stdout.write(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_ROLLBACK_PROBE_USAGE,
    );
    return { status: "help" };
  }
  if (argv.length > 0) {
    throw new Error(
      `Unknown argument${argv.length === 1 ? "" : "s"}: ${argv.join(" ")}\n` +
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_ROLLBACK_PROBE_USAGE,
    );
  }
  return run();
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    runStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbeCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
