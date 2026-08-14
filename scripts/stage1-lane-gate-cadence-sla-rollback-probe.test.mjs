import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  renderStage1LaneGateCadenceSlaRollbackProbe,
  STAGE1_LANE_GATE_CADENCE_SLA_MIGRATION,
} from "./render-stage1-lane-gate-cadence-sla-rollback-probe.mjs";
import {
  runStage1LaneGateCadenceSlaRollbackProbe,
  runStage1LaneGateCadenceSlaRollbackProbeCli,
  STAGE1_LANE_GATE_CADENCE_SLA_ROLLBACK_PROBE_USAGE,
} from "./run-stage1-lane-gate-cadence-sla-rollback-probe.mjs";

function normalizedFile(url) {
  return readFileSync(url, "utf8").replace(/\r\n/g, "\n").trim();
}

function exactBlock({ label, name, sql }) {
  const sha256 = createHash("sha256").update(sql, "utf8").digest("hex");
  return [
    `-- BEGIN EXACT ${label} ${name} sha256=${sha256}`,
    sql,
    `-- END EXACT ${label} ${name}`,
  ].join("\n");
}

describe("Stage 1 cadence-lane linked rollback probe", () => {
  const migration = normalizedFile(
    new URL(
      `../supabase/migrations/${STAGE1_LANE_GATE_CADENCE_SLA_MIGRATION}`,
      import.meta.url,
    ),
  );
  const sql = renderStage1LaneGateCadenceSlaRollbackProbe();

  it("embeds exactly the reviewed migration with a content hash", () => {
    const migrationBlock = exactBlock({
      label: "MIGRATION",
      name: STAGE1_LANE_GATE_CADENCE_SLA_MIGRATION,
      sql: migration,
    });
    expect(sql.match(/BEGIN EXACT MIGRATION/g)).toHaveLength(1);
    expect(sql).toContain(migrationBlock);
    expect(sql).not.toContain("__AWARDPING_EXACT_MIGRATION__");
    expect(sql.endsWith("\n")).toBe(true);
    expect(sql).not.toContain("\r");
  });

  it("preflights the active wrapper chain and refuses an applied or drifted state", () => {
    for (const contract of [
      "private.stage1_gate_without_contact_fence_20260717123000(timestamp with time zone)",
      "private.stage1_release_gate_snapshot(timestamp with time zone)",
      "the new lane SLA helper already exists",
      "migration.version = '20260810194427'",
      "migration.version = '20260814191514'",
      "the inherited gate does not contain the exact known-bad SLA predicate once",
      "the canonical wrapper does not call the inherited gate exactly once",
    ]) {
      expect(sql).toContain(contract);
    }
  });

  it("runs the migration smoke, rolls back, and compares exact catalog state", () => {
    for (const contract of [
      "pg_catalog.pg_get_functiondef(target.oid)",
      "'owner_oid', target.proowner::text",
      "'acl', pg_catalog.to_jsonb(target.proacl)",
      "'config', pg_catalog.to_jsonb(target.proconfig)",
      "the private lane SLA helper was not created",
      "the inherited gate did not switch to the metric-aware SLA contract",
      "the canonical wrapper changed even though only its inherited gate needed repair",
      "the new lane SLA helper survived rollback",
      "a Stage 1 gate definition or catalog attribute survived rollback",
      "awardping_stage1_lane_gate_cadence_sla_rollback_probe_passed",
      "migration/schema/assertion changes rolled back",
    ]) {
      expect(sql).toContain(contract);
    }
    expect(sql).toContain("rollback;\n-- MIGRATION TRANSACTION END");
    const applyStart = sql.indexOf("-- MIGRATION TRANSACTION START");
    const rollback = sql.indexOf("rollback;\n-- MIGRATION TRANSACTION END");
    expect(sql.slice(applyStart, rollback)).not.toMatch(/^\s*commit\s*;/m);
    expect(sql).toContain("1 as exact_migration_count");
  });
});

describe("Stage 1 cadence-lane rollback probe executable", () => {
  it("passes the dedicated renderer to the hardened linked-query runner", () => {
    const execute = vi.fn(({ render }) => ({ status: "passed", sql: render() }));
    const render = vi.fn(() => "begin;\nrollback;\n");
    const result = runStage1LaneGateCadenceSlaRollbackProbe({
      execute,
      render,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ render });
    expect(result).toEqual({ status: "passed", sql: "begin;\nrollback;\n" });
  });

  it.each(["--help", "-h"])(
    "prints dedicated help for %s without connecting",
    (helpFlag) => {
      const run = vi.fn();
      const stdout = { write: vi.fn() };
      expect(
        runStage1LaneGateCadenceSlaRollbackProbeCli({
          argv: [helpFlag],
          run,
          stdout,
        }),
      ).toEqual({ status: "help" });
      expect(stdout.write).toHaveBeenCalledWith(
        STAGE1_LANE_GATE_CADENCE_SLA_ROLLBACK_PROBE_USAGE,
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("rejects arguments and runs only with an empty argument list", () => {
    const run = vi.fn(() => ({ status: "passed" }));
    expect(() =>
      runStage1LaneGateCadenceSlaRollbackProbeCli({
        argv: ["--dry-run"],
        run,
      }),
    ).toThrow("Unknown argument: --dry-run");
    expect(run).not.toHaveBeenCalled();
    expect(
      runStage1LaneGateCadenceSlaRollbackProbeCli({ argv: [], run }),
    ).toEqual({ status: "passed" });
    expect(run).toHaveBeenCalledOnce();
  });
});
