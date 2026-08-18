import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadModule, parseSync } from "libpg-query";

import {
  listPublicUpdateConfirmationOutboxPriorMigrationVersions,
  PUBLIC_UPDATE_CONFIRMATION_OUTBOX_MIGRATION,
  PUBLIC_UPDATE_CONFIRMATION_OUTBOX_SMOKE,
  renderPublicUpdateConfirmationOutboxRollbackProbe,
} from "./render-public-update-confirmation-outbox-rollback-probe.mjs";
import {
  PUBLIC_UPDATE_CONFIRMATION_OUTBOX_ROLLBACK_PROBE_EXPECTED_ROW,
  PUBLIC_UPDATE_CONFIRMATION_OUTBOX_ROLLBACK_PROBE_USAGE,
  runPublicUpdateConfirmationOutboxRollbackProbe,
  runPublicUpdateConfirmationOutboxRollbackProbeCli,
} from "./run-public-update-confirmation-outbox-rollback-probe.mjs";

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

describe("public-update confirmation linked rollback probe", () => {
  const migration = normalizedFile(
    new URL(
      `../supabase/migrations/${PUBLIC_UPDATE_CONFIRMATION_OUTBOX_MIGRATION}`,
      import.meta.url,
    ),
  );
  const smoke = normalizedFile(
    new URL(
      `../supabase/tests/${PUBLIC_UPDATE_CONFIRMATION_OUTBOX_SMOKE}`,
      import.meta.url,
    ),
  );
  const priorVersions =
    listPublicUpdateConfirmationOutboxPriorMigrationVersions();
  const sql = renderPublicUpdateConfirmationOutboxRollbackProbe();

  it("embeds one exact migration, one exact smoke, and every prior version", async () => {
    await loadModule();
    expect(() => parseSync(sql)).not.toThrow();
    expect(sql.match(/BEGIN EXACT MIGRATION/g)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT SMOKE/g)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT PRIOR MIGRATION VERSIONS/g)).toHaveLength(1);
    expect(sql).toContain(
      exactBlock({
        label: "MIGRATION",
        name: PUBLIC_UPDATE_CONFIRMATION_OUTBOX_MIGRATION,
        sql: migration,
      }),
    );
    expect(sql).toContain(
      exactBlock({
        label: "SMOKE",
        name: PUBLIC_UPDATE_CONFIRMATION_OUTBOX_SMOKE,
        sql: smoke,
      }),
    );
    expect(sql).toContain(exactPriorBlock(priorVersions));
    expect(sql).not.toMatch(/__AWARDPING_EXACT_/);
    expect(sql.endsWith("\n")).toBe(true);
    expect(sql).not.toContain("\r");

    const targetVersion =
      PUBLIC_UPDATE_CONFIRMATION_OUTBOX_MIGRATION.split("_", 1)[0];
    const expectedPrior = readdirSync(migrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name))
      .map((name) => name.split("_", 1)[0])
      .filter((version) => version.localeCompare(targetVersion) < 0)
      .sort((left, right) => left.localeCompare(right));
    expect(priorVersions).toEqual(expectedPrior);
    expect(new Set(priorVersions).size).toBe(priorVersions.length);
    expect(priorVersions.at(-1)).toBe("20260815012910");
  });

  it("fails closed on prerequisites, partial patching, or migration-history drift", () => {
    for (const contract of [
      "one or more prior repository migrations are not recorded as applied",
      "migration 20260815023357 is already recorded as applied",
      "a target confirmation outbox object already exists",
      "a target subscriber column already exists",
      "the exact three-function replacement baseline was not captured",
      "the exact subscriber trigger baseline was not captured",
    ]) {
      expect(sql).toContain(contract);
    }
    const preflight = sql.slice(
      sql.indexOf("do $preflight$"),
      sql.indexOf("commit;", sql.indexOf("do $preflight$")),
    );
    for (const staleRpc of [
      "claim_public_update_confirmations(text,integer,integer,uuid)",
      "authorize_public_update_confirmation_send(uuid,uuid)",
      "complete_public_update_confirmation_send(uuid,uuid,text)",
      "fail_public_update_confirmation_send(uuid,uuid,text,boolean,boolean)",
    ]) {
      expect(preflight).toContain(staleRpc);
    }
  });

  it("runs the exact migration and role/behavior smoke in one rollback transaction", () => {
    const applyStart = sql.indexOf("-- MIGRATION TRANSACTION START");
    const migrationStart = sql.indexOf("-- BEGIN EXACT MIGRATION", applyStart);
    const smokeStart = sql.indexOf("-- BEGIN EXACT SMOKE", migrationStart);
    const rollback = sql.indexOf(
      "rollback;\n-- MIGRATION TRANSACTION END",
      smokeStart,
    );
    expect(migrationStart).toBeGreaterThan(applyStart);
    expect(smokeStart).toBeGreaterThan(migrationStart);
    expect(rollback).toBeGreaterThan(smokeStart);
    expect(sql.slice(applyStart, rollback)).not.toMatch(/^\s*commit\s*;/m);
    expect(sql).toContain("set role anon;");
    expect(sql).toContain("set role authenticated;");
    expect(sql).toContain("set role service_role;");
  });

  it("proves exact function restoration and removal of every new object", () => {
    for (const contract of [
      "pg_catalog.pg_get_functiondef(target.oid)",
      "'oid', target.oid::text",
      "'acl', pg_catalog.to_jsonb(target.proacl)",
      "a replaced function changed OID or catalog metadata outside its body",
      "a new confirmation object survived rollback",
      "a new subscriber column survived rollback",
      "an original function definition or catalog attribute was not restored",
      "the original subscriber trigger definition or identity was not restored",
      "migration history changed despite rollback",
      "awardping_public_update_confirmation_outbox_rollback_probe_passed",
      "1 as exact_migration_count",
      "1 as exact_smoke_count",
    ]) {
      expect(sql).toContain(contract);
    }
  });
});

describe("public-update confirmation rollback probe executable", () => {
  it("passes the dedicated renderer to the hardened linked-query runner", () => {
    const execute = vi.fn(({ render }) => ({ status: "passed", sql: render() }));
    const render = vi.fn(() => "begin;\nrollback;\n");
    expect(
      runPublicUpdateConfirmationOutboxRollbackProbe({ execute, render }),
    ).toEqual({ status: "passed", sql: "begin;\nrollback;\n" });
    expect(execute).toHaveBeenCalledWith({
      render,
      expectedResultRow:
        PUBLIC_UPDATE_CONFIRMATION_OUTBOX_ROLLBACK_PROBE_EXPECTED_ROW,
    });
  });

  it.each(["--help", "-h"])(
    "prints dedicated help for %s without connecting",
    (helpFlag) => {
      const run = vi.fn();
      const stdout = { write: vi.fn() };
      expect(
        runPublicUpdateConfirmationOutboxRollbackProbeCli({
          argv: [helpFlag],
          run,
          stdout,
        }),
      ).toEqual({ status: "help" });
      expect(stdout.write).toHaveBeenCalledWith(
        PUBLIC_UPDATE_CONFIRMATION_OUTBOX_ROLLBACK_PROBE_USAGE,
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("rejects arguments and runs only with an empty argument list", () => {
    const run = vi.fn(() => ({ status: "passed" }));
    expect(() =>
      runPublicUpdateConfirmationOutboxRollbackProbeCli({
        argv: ["--dry-run"],
        run,
      }),
    ).toThrow("Unknown argument: --dry-run");
    expect(run).not.toHaveBeenCalled();
    expect(
      runPublicUpdateConfirmationOutboxRollbackProbeCli({ argv: [], run }),
    ).toEqual({ status: "passed" });
    expect(run).toHaveBeenCalledOnce();
  });
});
