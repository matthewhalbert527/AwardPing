import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderPublicUpdateConfirmationOutboxRollbackProbe } from "./render-public-update-confirmation-outbox-rollback-probe.mjs";
import {
  runStage1PendingMigrationRollbackProbe,
  STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER,
} from "./run-stage1-pending-migration-rollback-probe.mjs";

export const PUBLIC_UPDATE_CONFIRMATION_OUTBOX_ROLLBACK_PROBE_EXPECTED_ROW =
  Object.freeze({
    status: STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER,
    probe: "awardping_public_update_confirmation_outbox_rollback_probe_passed",
    exact_migration_count: 1,
    exact_smoke_count: 1,
    exact_migration:
      "20260815023357_durable_public_update_confirmation_outbox.sql",
    exact_smoke: "public_update_confirmation_outbox_smoke.sql",
    persistence_result:
      "migration/smoke/table/column/function changes rolled back",
  });

export const PUBLIC_UPDATE_CONFIRMATION_OUTBOX_ROLLBACK_PROBE_USAGE = `Usage: node scripts/run-public-update-confirmation-outbox-rollback-probe.mjs [--help|-h]

Requires every prior repository migration, then runs only migration
20260815023357 and its confirmation-outbox smoke against the linked database
inside one transaction. Verifies exact rollback and persists no application,
migration-history, or schema change.

Options:
  -h, --help  Show this help without connecting to the database.
`;

export function runPublicUpdateConfirmationOutboxRollbackProbe({
  execute = runStage1PendingMigrationRollbackProbe,
  render = renderPublicUpdateConfirmationOutboxRollbackProbe,
} = {}) {
  return execute({
    render,
    expectedResultRow:
      PUBLIC_UPDATE_CONFIRMATION_OUTBOX_ROLLBACK_PROBE_EXPECTED_ROW,
  });
}

export function runPublicUpdateConfirmationOutboxRollbackProbeCli({
  argv = process.argv.slice(2),
  run = runPublicUpdateConfirmationOutboxRollbackProbe,
  stdout = process.stdout,
} = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    stdout.write(PUBLIC_UPDATE_CONFIRMATION_OUTBOX_ROLLBACK_PROBE_USAGE);
    return { status: "help" };
  }
  if (argv.length > 0) {
    throw new Error(
      `Unknown argument${argv.length === 1 ? "" : "s"}: ${argv.join(" ")}\n` +
        PUBLIC_UPDATE_CONFIRMATION_OUTBOX_ROLLBACK_PROBE_USAGE,
    );
  }
  return run();
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    runPublicUpdateConfirmationOutboxRollbackProbeCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
