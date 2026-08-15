import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadModule, parseSync } from "libpg-query";

import {
  listStage1ActivationReleaseLockOrderPriorMigrationVersions,
  renderStage1ActivationReleaseLockOrderRollbackProbe,
  STAGE1_ACTIVATION_RELEASE_LOCK_ORDER_MIGRATION,
  STAGE1_ACTIVATION_RELEASE_LOCK_ORDER_SMOKE,
} from "./render-stage1-activation-release-lock-order-rollback-probe.mjs";
import {
  runStage1ActivationReleaseLockOrderRollbackProbe,
  runStage1ActivationReleaseLockOrderRollbackProbeCli,
  STAGE1_ACTIVATION_RELEASE_LOCK_ORDER_ROLLBACK_PROBE_USAGE,
} from "./run-stage1-activation-release-lock-order-rollback-probe.mjs";

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

describe("Stage 1 activation release-lock linked rollback probe", () => {
  const migration = normalizedFile(
    new URL(
      `../supabase/migrations/${STAGE1_ACTIVATION_RELEASE_LOCK_ORDER_MIGRATION}`,
      import.meta.url,
    ),
  );
  const smoke = normalizedFile(
    new URL(
      `../supabase/tests/${STAGE1_ACTIVATION_RELEASE_LOCK_ORDER_SMOKE}`,
      import.meta.url,
    ),
  );
  const priorVersions =
    listStage1ActivationReleaseLockOrderPriorMigrationVersions();
  const sql = renderStage1ActivationReleaseLockOrderRollbackProbe();

  it("embeds one exact migration, one exact smoke, and every prior version", async () => {
    await loadModule();
    expect(() => parseSync(sql)).not.toThrow();
    expect(sql.match(/BEGIN EXACT MIGRATION/g)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT SMOKE/g)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT PRIOR MIGRATION VERSIONS/g)).toHaveLength(1);
    expect(sql).toContain(
      exactBlock({
        label: "MIGRATION",
        name: STAGE1_ACTIVATION_RELEASE_LOCK_ORDER_MIGRATION,
        sql: migration,
      }),
    );
    expect(sql).toContain(
      exactBlock({
        label: "SMOKE",
        name: STAGE1_ACTIVATION_RELEASE_LOCK_ORDER_SMOKE,
        sql: smoke,
      }),
    );
    expect(sql).toContain(exactPriorBlock(priorVersions));
    expect(sql).not.toMatch(/__AWARDPING_EXACT_/);
    expect(sql.endsWith("\n")).toBe(true);
    expect(sql).not.toContain("\r");

    const targetVersion =
      STAGE1_ACTIVATION_RELEASE_LOCK_ORDER_MIGRATION.split("_", 1)[0];
    const expectedPrior = readdirSync(migrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name))
      .map((name) => name.split("_", 1)[0])
      .filter((version) => version.localeCompare(targetVersion) < 0)
      .sort((left, right) => left.localeCompare(right));
    expect(priorVersions).toEqual(expectedPrior);
    expect(new Set(priorVersions).size).toBe(priorVersions.length);
    expect(priorVersions.at(-1)).toBe("20260814211159");
  });

  it("fails closed on missing prerequisites, overloads, prior patching, or history drift", () => {
    for (const contract of [
      "from pg_catalog.unnest(v_required_prior_versions) required(version)",
      "one or more prior repository migrations are not recorded as applied",
      "migration 20260814223000 is already recorded as applied",
      "an exact Stage 1 activation mutation RPC is missing",
      "a Stage 1 activation mutation RPC has an unexpected overload",
      "a target RPC already contains the pending release-lock delta",
      "the exact two-function baseline catalog contract was not captured",
    ]) {
      expect(sql).toContain(contract);
    }
  });

  it("runs the exact delta and role smoke in one rollback-only transaction", () => {
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
    expect(sql).toContain("set role anon;");
    expect(sql).toContain("set role authenticated;");
    expect(sql).toContain("set role service_role;");
    expect(sql).toContain(
      "The service role did not reach both Stage 1 activation RPC validation boundaries.",
    );
  });

  it("proves global-first order, same OIDs/metadata, exact rollback, and unchanged history", () => {
    for (const contract of [
      "pg_catalog.pg_get_functiondef(target.oid)",
      "'oid', target.oid::text",
      "'owner_oid', target.proowner::text",
      "'acl', pg_catalog.to_jsonb(target.proacl)",
      "'config', pg_catalog.to_jsonb(target.proconfig)",
      "'comment', pg_catalog.obj_description(target.oid, 'pg_proc')",
      "awardping_stage1_activation_lock_function_contract(false) =",
      "changed a function catalog attribute or OID outside the body delta",
      "does not have exactly one global-first release lock",
      "the original Stage 1 activation function definitions or catalog attributes were not restored",
      "migration history changed despite rollback",
      "awardping_stage1_activation_release_lock_rollback_probe_passed",
      "1 as exact_migration_count",
      "1 as exact_smoke_count",
      "migration/smoke/function-catalog changes rolled back",
    ]) {
      expect(sql).toContain(contract);
    }
  });
});

describe("Stage 1 activation release-lock rollback probe executable", () => {
  it("passes the dedicated renderer to the hardened linked-query runner", () => {
    const execute = vi.fn(({ render }) => ({ status: "passed", sql: render() }));
    const render = vi.fn(() => "begin;\nrollback;\n");
    const result = runStage1ActivationReleaseLockOrderRollbackProbe({
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
        runStage1ActivationReleaseLockOrderRollbackProbeCli({
          argv: [helpFlag],
          run,
          stdout,
        }),
      ).toEqual({ status: "help" });
      expect(stdout.write).toHaveBeenCalledWith(
        STAGE1_ACTIVATION_RELEASE_LOCK_ORDER_ROLLBACK_PROBE_USAGE,
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("rejects arguments and runs only with an empty argument list", () => {
    const run = vi.fn(() => ({ status: "passed" }));
    expect(() =>
      runStage1ActivationReleaseLockOrderRollbackProbeCli({
        argv: ["--dry-run"],
        run,
      }),
    ).toThrow("Unknown argument: --dry-run");
    expect(run).not.toHaveBeenCalled();
    expect(
      runStage1ActivationReleaseLockOrderRollbackProbeCli({
        argv: [],
        run,
      }),
    ).toEqual({ status: "passed" });
    expect(run).toHaveBeenCalledOnce();
  });
});
