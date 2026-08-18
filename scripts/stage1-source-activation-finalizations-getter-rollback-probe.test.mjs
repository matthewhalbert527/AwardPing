import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  listStage1FinalizationGetterPriorMigrationVersions,
  renderStage1SourceActivationFinalizationsGetterRollbackProbe,
  STAGE1_SOURCE_ACTIVATION_FINALIZATIONS_GETTER_MIGRATION,
  STAGE1_SOURCE_ACTIVATION_FINALIZATIONS_GETTER_SMOKE,
} from "./render-stage1-source-activation-finalizations-getter-rollback-probe.mjs";
import {
  runStage1SourceActivationFinalizationsGetterRollbackProbe,
  runStage1SourceActivationFinalizationsGetterRollbackProbeCli,
  STAGE1_SOURCE_ACTIVATION_FINALIZATIONS_GETTER_ROLLBACK_PROBE_EXPECTED_ROW,
  STAGE1_FINALIZATION_GETTER_ROLLBACK_PROBE_USAGE,
} from "./run-stage1-source-activation-finalizations-getter-rollback-probe.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(scriptDirectory, "../supabase/migrations");

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

function exactPriorBlock(versions) {
  const sha256 = createHash("sha256")
    .update(versions.join("\n"), "utf8")
    .digest("hex");
  return [
    `-- BEGIN EXACT PRIOR MIGRATION VERSIONS count=${versions.length} sha256=${sha256}`,
    "array[",
    ...versions.map(
      (version, index) =>
        `  '${version}'::text${index === versions.length - 1 ? "" : ","}`,
    ),
    "]::text[]",
    "-- END EXACT PRIOR MIGRATION VERSIONS",
  ].join("\n");
}

describe("Stage 1 source-finalization getter linked rollback probe", () => {
  const migration = normalizedFile(
    new URL(
      `../supabase/migrations/${STAGE1_SOURCE_ACTIVATION_FINALIZATIONS_GETTER_MIGRATION}`,
      import.meta.url,
    ),
  );
  const smoke = normalizedFile(
    new URL(
      `../supabase/tests/${STAGE1_SOURCE_ACTIVATION_FINALIZATIONS_GETTER_SMOKE}`,
      import.meta.url,
    ),
  );
  const priorVersions = listStage1FinalizationGetterPriorMigrationVersions();
  const sql = renderStage1SourceActivationFinalizationsGetterRollbackProbe();

  it("embeds the exact migration, smoke, and complete prior-version preflight", () => {
    expect(sql.match(/BEGIN EXACT MIGRATION/g)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT SMOKE/g)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT PRIOR MIGRATION VERSIONS/g)).toHaveLength(1);
    expect(sql).toContain(
      exactBlock({
        label: "MIGRATION",
        name: STAGE1_SOURCE_ACTIVATION_FINALIZATIONS_GETTER_MIGRATION,
        sql: migration,
      }),
    );
    expect(sql).toContain(
      exactBlock({
        label: "SMOKE",
        name: STAGE1_SOURCE_ACTIVATION_FINALIZATIONS_GETTER_SMOKE,
        sql: smoke,
      }),
    );
    expect(sql).toContain(exactPriorBlock(priorVersions));
    expect(sql).not.toMatch(/__AWARDPING_EXACT_/);
    expect(sql.endsWith("\n")).toBe(true);
    expect(sql).not.toContain("\r");

    const targetVersion =
      STAGE1_SOURCE_ACTIVATION_FINALIZATIONS_GETTER_MIGRATION.split("_", 1)[0];
    const expectedPrior = readdirSync(migrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name))
      .map((name) => name.split("_", 1)[0])
      .filter((version) => version.localeCompare(targetVersion) < 0)
      .sort((left, right) => left.localeCompare(right));
    expect(priorVersions).toEqual(expectedPrior);
    expect(new Set(priorVersions).size).toBe(priorVersions.length);
    expect(priorVersions.at(-1)).toBe("20260814191514");
  });

  it("requires all prior migrations and refuses an applied or drifted target", () => {
    for (const contract of [
      "from pg_catalog.unnest(v_required_prior_versions) required(version)",
      "one or more prior repository migrations are not recorded as applied",
      "migration.version = v_target_version",
      "migration 20260814203233 is already recorded as applied",
      "the immutable Stage 1 activation-finalization table is missing",
      "the target Stage 1 finalization getter already exists or has an overload",
    ]) {
      expect(sql).toContain(contract);
    }
  });

  it("runs exact migration and role smoke in one rollback-only transaction", () => {
    const applyStart = sql.indexOf("-- MIGRATION TRANSACTION START");
    const migrationStart = sql.indexOf("-- BEGIN EXACT MIGRATION", applyStart);
    const smokeStart = sql.indexOf("-- BEGIN EXACT SMOKE", migrationStart);
    const rollback = sql.indexOf(
      "rollback;\n-- MIGRATION TRANSACTION END",
      smokeStart,
    );
    expect(applyStart).toBeGreaterThanOrEqual(0);
    expect(migrationStart).toBeGreaterThan(applyStart);
    expect(smokeStart).toBeGreaterThan(migrationStart);
    expect(rollback).toBeGreaterThan(smokeStart);
    expect(sql.slice(applyStart, rollback)).not.toMatch(/^\s*commit\s*;/m);
    for (const roleContract of [
      "set role anon;",
      "set role authenticated;",
      "set role service_role;",
      "exception when insufficient_privilege",
      "The service role did not reach the getter completeness check through RLS.",
    ]) {
      expect(sql).toContain(roleContract);
    }
  });

  it("asserts the exact applied API and restores its complete catalog contract", () => {
    for (const contract of [
      "pg_catalog.pg_get_functiondef(target.oid)",
      "pg_catalog.pg_get_function_identity_arguments(target.oid)",
      "pg_catalog.pg_get_function_result(target.oid)",
      "'owner_oid', target.proowner::text",
      "'acl', pg_catalog.to_jsonb(target.proacl)",
      "'config', pg_catalog.to_jsonb(target.proconfig)",
      "target.proargmodes::text = '{i,t,t,t,t,t,t,t,t,t,t,t}'",
      "not target.prosecdef",
      "target.provolatile = 's'",
      "target.proparallel = 's'",
      "the target getter definition or catalog attributes survived rollback",
      "the new Stage 1 finalization getter survived rollback",
      "migration history changed despite rollback",
      "awardping_stage1_finalization_getter_rollback_probe_passed",
      "1 as exact_migration_count",
      "1 as exact_smoke_count",
      "migration/smoke/catalog changes rolled back",
    ]) {
      expect(sql).toContain(contract);
    }
  });
});

describe("Stage 1 source-finalization getter rollback probe executable", () => {
  it("passes the dedicated renderer to the hardened linked-query runner", () => {
    const execute = vi.fn(({ render }) => ({ status: "passed", sql: render() }));
    const render = vi.fn(() => "begin;\nrollback;\n");
    const result =
      runStage1SourceActivationFinalizationsGetterRollbackProbe({
        execute,
        render,
      });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({
      render,
      expectedResultRow:
        STAGE1_SOURCE_ACTIVATION_FINALIZATIONS_GETTER_ROLLBACK_PROBE_EXPECTED_ROW,
    });
    expect(result).toEqual({ status: "passed", sql: "begin;\nrollback;\n" });
  });

  it.each(["--help", "-h"])(
    "prints dedicated help for %s without connecting",
    (helpFlag) => {
      const run = vi.fn();
      const stdout = { write: vi.fn() };
      expect(
        runStage1SourceActivationFinalizationsGetterRollbackProbeCli({
          argv: [helpFlag],
          run,
          stdout,
        }),
      ).toEqual({ status: "help" });
      expect(stdout.write).toHaveBeenCalledWith(
        STAGE1_FINALIZATION_GETTER_ROLLBACK_PROBE_USAGE,
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("rejects arguments and runs only with an empty argument list", () => {
    const run = vi.fn(() => ({ status: "passed" }));
    expect(() =>
      runStage1SourceActivationFinalizationsGetterRollbackProbeCli({
        argv: ["--dry-run"],
        run,
      }),
    ).toThrow("Unknown argument: --dry-run");
    expect(run).not.toHaveBeenCalled();
    expect(
      runStage1SourceActivationFinalizationsGetterRollbackProbeCli({
        argv: [],
        run,
      }),
    ).toEqual({ status: "passed" });
    expect(run).toHaveBeenCalledOnce();
  });
});
