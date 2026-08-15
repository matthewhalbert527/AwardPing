import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { renderStage1EvidenceSchemaUpgradeQuarantineRollbackProbe } from "./render-stage1-evidence-schema-upgrade-quarantine-rollback-probe.mjs";
import { runStage1PendingMigrationRollbackProbe } from "./run-stage1-pending-migration-rollback-probe.mjs";

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
  return execute({ render });
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
