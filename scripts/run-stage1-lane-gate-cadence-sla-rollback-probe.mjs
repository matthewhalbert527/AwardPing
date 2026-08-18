import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderStage1LaneGateCadenceSlaRollbackProbe } from "./render-stage1-lane-gate-cadence-sla-rollback-probe.mjs";
import {
  runStage1PendingMigrationRollbackProbe,
  STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER,
} from "./run-stage1-pending-migration-rollback-probe.mjs";

export const STAGE1_LANE_GATE_CADENCE_SLA_ROLLBACK_PROBE_EXPECTED_ROW =
  Object.freeze({
    [STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER]: true,
    awardping_stage1_lane_gate_cadence_sla_rollback_probe_passed: true,
    exact_migration_count: 1,
    exact_migration: "20260814191514_fix_stage1_lane_gate_cadence_sla.sql",
    persistence_result: "migration/schema/assertion changes rolled back",
  });

export const STAGE1_LANE_GATE_CADENCE_SLA_ROLLBACK_PROBE_USAGE = `Usage: node scripts/run-stage1-lane-gate-cadence-sla-rollback-probe.mjs [--help|-h]

Runs migration 20260814191514 and its data-free lane-contract assertions against
the linked database inside one transaction, verifies exact catalog rollback,
and persists no application, migration-history, or schema change.

Options:
  -h, --help  Show this help without connecting to the database.
`;

export function runStage1LaneGateCadenceSlaRollbackProbe({
  execute = runStage1PendingMigrationRollbackProbe,
  render = renderStage1LaneGateCadenceSlaRollbackProbe,
} = {}) {
  return execute({
    render,
    expectedResultRow:
      STAGE1_LANE_GATE_CADENCE_SLA_ROLLBACK_PROBE_EXPECTED_ROW,
  });
}

export function runStage1LaneGateCadenceSlaRollbackProbeCli({
  argv = process.argv.slice(2),
  run = runStage1LaneGateCadenceSlaRollbackProbe,
  stdout = process.stdout,
} = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    stdout.write(STAGE1_LANE_GATE_CADENCE_SLA_ROLLBACK_PROBE_USAGE);
    return { status: "help" };
  }
  if (argv.length > 0) {
    throw new Error(
      `Unknown argument${argv.length === 1 ? "" : "s"}: ${argv.join(" ")}\n` +
        STAGE1_LANE_GATE_CADENCE_SLA_ROLLBACK_PROBE_USAGE,
    );
  }
  return run();
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    runStage1LaneGateCadenceSlaRollbackProbeCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
