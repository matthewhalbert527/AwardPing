import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderStage1ExpansionCaptureCoverageRollbackProbe } from "./render-stage1-expansion-capture-coverage-rollback-probe.mjs";
import {
  runStage1PendingMigrationRollbackProbe,
  STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER,
} from "./run-stage1-pending-migration-rollback-probe.mjs";

export const STAGE1_EXPANSION_CAPTURE_COVERAGE_ROLLBACK_PROBE_EXPECTED_ROW =
  Object.freeze({
    [STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER]: true,
    awardping_stage1_expansion_coverage_rollback_probe_passed: true,
    exact_migration_count: 1,
    exact_migration:
      "20260814173236_require_stage1_expansion_capture_coverage.sql",
    persistence_result: "migration/schema/assertion changes rolled back",
  });

export const STAGE1_EXPANSION_COVERAGE_ROLLBACK_PROBE_USAGE = `Usage: node scripts/run-stage1-expansion-capture-coverage-rollback-probe.mjs [--help|-h]

Runs migration 20260814173236 and its expansion-coverage smoke assertions against the
linked database inside one transaction, verifies rollback, and persists no
application or schema change.

Options:
  -h, --help  Show this help without connecting to the database.
`;

export function runStage1ExpansionCaptureCoverageRollbackProbe({
  execute = runStage1PendingMigrationRollbackProbe,
  render = renderStage1ExpansionCaptureCoverageRollbackProbe,
} = {}) {
  return execute({
    render,
    expectedResultRow:
      STAGE1_EXPANSION_CAPTURE_COVERAGE_ROLLBACK_PROBE_EXPECTED_ROW,
  });
}

export function runStage1ExpansionCaptureCoverageRollbackProbeCli({
  argv = process.argv.slice(2),
  run = runStage1ExpansionCaptureCoverageRollbackProbe,
  stdout = process.stdout,
} = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    stdout.write(STAGE1_EXPANSION_COVERAGE_ROLLBACK_PROBE_USAGE);
    return { status: "help" };
  }
  if (argv.length > 0) {
    throw new Error(
      `Unknown argument${argv.length === 1 ? "" : "s"}: ${argv.join(" ")}\n` +
        STAGE1_EXPANSION_COVERAGE_ROLLBACK_PROBE_USAGE,
    );
  }
  return run();
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    runStage1ExpansionCaptureCoverageRollbackProbeCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
