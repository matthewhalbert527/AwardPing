import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  renderStage1ExpansionWithoutMainLayoutRollbackProbe,
  STAGE1_EXPANSION_WITHOUT_MAIN_LAYOUT_MIGRATION,
  STAGE1_EXPANSION_WITHOUT_MAIN_LAYOUT_SMOKE,
} from "./render-stage1-expansion-without-main-layout-rollback-probe.mjs";
import {
  runStage1ExpansionWithoutMainLayoutRollbackProbe,
  runStage1ExpansionWithoutMainLayoutRollbackProbeCli,
  STAGE1_EXPANSION_ROLLBACK_PROBE_USAGE,
} from "./run-stage1-expansion-without-main-layout-rollback-probe.mjs";

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

describe("Stage 1 expansion-without-main-layout linked rollback probe", () => {
  const migration = normalizedFile(
    new URL(
      `../supabase/migrations/${STAGE1_EXPANSION_WITHOUT_MAIN_LAYOUT_MIGRATION}`,
      import.meta.url,
    ),
  );
  const smoke = normalizedFile(
    new URL(
      `../supabase/tests/${STAGE1_EXPANSION_WITHOUT_MAIN_LAYOUT_SMOKE}`,
      import.meta.url,
    ),
  );
  const sql = renderStage1ExpansionWithoutMainLayoutRollbackProbe();

  it("embeds the exact current migration and semantic smoke once in order", () => {
    const migrationBlock = exactBlock({
      label: "MIGRATION",
      name: STAGE1_EXPANSION_WITHOUT_MAIN_LAYOUT_MIGRATION,
      sql: migration,
    });
    const smokeBlock = exactBlock({
      label: "SMOKE",
      name: STAGE1_EXPANSION_WITHOUT_MAIN_LAYOUT_SMOKE,
      sql: smoke,
    });
    expect(sql.match(/BEGIN EXACT MIGRATION/g)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT SMOKE/g)).toHaveLength(1);
    expect(sql).toContain(migrationBlock);
    expect(sql).toContain(smokeBlock);
    expect(sql.indexOf(migrationBlock)).toBeLessThan(sql.indexOf(smokeBlock));
    expect(sql).not.toContain("__AWARDPING_EXACT_MIGRATION__");
    expect(sql).not.toContain("__AWARDPING_EXACT_SMOKE__");
    expect(sql.endsWith("\n")).toBe(true);
    expect(sql).not.toContain("\r");
  });

  it("rolls back the exact migration and smoke before comparing catalog state", () => {
    const applyStart = sql.indexOf("-- MIGRATION TRANSACTION START");
    const migrationStart = sql.indexOf("-- BEGIN EXACT MIGRATION");
    const smokeStart = sql.indexOf("-- BEGIN EXACT SMOKE");
    const rollback = sql.indexOf("rollback;\n-- MIGRATION TRANSACTION END");
    const postcheck = sql.indexOf("-- POST-ROLLBACK VERIFICATION START");
    expect(applyStart).toBeGreaterThan(-1);
    expect(migrationStart).toBeGreaterThan(applyStart);
    expect(smokeStart).toBeGreaterThan(migrationStart);
    expect(rollback).toBeGreaterThan(smokeStart);
    expect(postcheck).toBeGreaterThan(rollback);
    expect(sql.slice(applyStart, rollback)).not.toMatch(/^\s*commit\s*;/m);
    expect(sql).toContain(
      "awardping_stage1_pending_migration_rollback_probe_passed",
    );
    expect(sql).toContain("1 as exact_migration_count");
  });

  it("snapshots and restores the exact validator catalog contract", () => {
    for (const contract of [
      "pg_catalog.pg_get_functiondef(target.oid)",
      "'owner_oid', target.proowner::text",
      "'acl', pg_catalog.to_jsonb(target.proacl)",
      "'config', pg_catalog.to_jsonb(target.proconfig)",
      "'volatility', target.provolatile::text",
      "'security_definer', target.prosecdef",
      "'language_oid', target.prolang::text",
      "'return_type_oid', target.prorettype::text",
      "'argument_type_oids', target.proargtypes::text",
      "migration.version = '20260814141049'",
      "v_function_oid = (",
      "function_contract(v_function_oid) = (",
      "the validator definition or catalog metadata survived rollback",
    ]) {
      expect(sql).toContain(contract);
    }
    expect(sql.match(/has_function_privilege\(/g)).toHaveLength(6);
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(sql.match(new RegExp(`'${role}'`, "g"))).toHaveLength(2);
    }
  });

  it("executes the hybrid positive and fail-closed negative smoke assertions", () => {
    for (const assertion of [
      "A complete expansion pair was rejected when main geometry was explicitly unavailable.",
      "The fixture did not exercise independent layout hashes.",
      "An expansion screenshot without its layout was accepted.",
      "An expansion screenshot with a mismatched raw hash was accepted.",
      "A non-contiguous expansion pair was accepted.",
      "Missing main geometry was accepted with a contradictory layout hash.",
      "Missing main geometry was accepted with exact localization claimed.",
      "Missing main geometry was accepted without explicit non-exact localization.",
      "Missing main geometry was accepted with a retained layout file claim.",
      "Missing main geometry was accepted without a geometry failure reason.",
      "A negative expansion count was accepted.",
      "The pre-existing explicit-unavailability shape no longer validates.",
    ]) {
      expect(sql).toContain(assertion);
    }
  });
});

describe("Stage 1 expansion rollback probe executable", () => {
  it("passes the dedicated renderer to the hardened linked-query runner", () => {
    const execute = vi.fn(({ render }) => ({ status: "passed", sql: render() }));
    const render = vi.fn(() => "begin;\nrollback;\n");
    const result = runStage1ExpansionWithoutMainLayoutRollbackProbe({
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
        runStage1ExpansionWithoutMainLayoutRollbackProbeCli({
          argv: [helpFlag],
          run,
          stdout,
        }),
      ).toEqual({ status: "help" });
      expect(stdout.write).toHaveBeenCalledWith(
        STAGE1_EXPANSION_ROLLBACK_PROBE_USAGE,
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("rejects arguments and runs only with an empty argument list", () => {
    const run = vi.fn(() => ({ status: "passed" }));
    expect(() =>
      runStage1ExpansionWithoutMainLayoutRollbackProbeCli({
        argv: ["--dry-run"],
        run,
      }),
    ).toThrow("Unknown argument: --dry-run");
    expect(run).not.toHaveBeenCalled();
    expect(
      runStage1ExpansionWithoutMainLayoutRollbackProbeCli({ argv: [], run }),
    ).toEqual({ status: "passed" });
    expect(run).toHaveBeenCalledOnce();
  });
});
