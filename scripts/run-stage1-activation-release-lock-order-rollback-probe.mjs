import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderStage1ActivationReleaseLockOrderRollbackProbe } from "./render-stage1-activation-release-lock-order-rollback-probe.mjs";
import { runStage1PendingMigrationRollbackProbe } from "./run-stage1-pending-migration-rollback-probe.mjs";

export const STAGE1_ACTIVATION_RELEASE_LOCK_ORDER_ROLLBACK_PROBE_USAGE = `Usage: node scripts/run-stage1-activation-release-lock-order-rollback-probe.mjs [--help|-h]

Requires every prior repository migration, then runs only migration
20260814223000 and its service-role/lock-order smoke against the linked
database inside one transaction. Verifies exact function-catalog rollback and
persists no application, migration-history, or schema change.

Options:
  -h, --help  Show this help without connecting to the database.
`;

export function runStage1ActivationReleaseLockOrderRollbackProbe({
  execute = runStage1PendingMigrationRollbackProbe,
  render = renderStage1ActivationReleaseLockOrderRollbackProbe,
} = {}) {
  return execute({ render });
}

export function runStage1ActivationReleaseLockOrderRollbackProbeCli({
  argv = process.argv.slice(2),
  run = runStage1ActivationReleaseLockOrderRollbackProbe,
  stdout = process.stdout,
} = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    stdout.write(STAGE1_ACTIVATION_RELEASE_LOCK_ORDER_ROLLBACK_PROBE_USAGE);
    return { status: "help" };
  }
  if (argv.length > 0) {
    throw new Error(
      `Unknown argument${argv.length === 1 ? "" : "s"}: ${argv.join(" ")}\n` +
        STAGE1_ACTIVATION_RELEASE_LOCK_ORDER_ROLLBACK_PROBE_USAGE,
    );
  }
  return run();
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    runStage1ActivationReleaseLockOrderRollbackProbeCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
