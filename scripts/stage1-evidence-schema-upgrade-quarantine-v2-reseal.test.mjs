import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { loadModule, parseSync } from "libpg-query";

import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SCHEMA,
} from "./lib/stage1-evidence-schema-upgrade.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256,
} from "./lib/stage1-evidence-schema-upgrade-quarantine.mjs";
import {
  listStage1EvidenceSchemaUpgradeQuarantineV2PriorVersions,
  renderStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbe,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_MIGRATION,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_SMOKE,
} from "./render-stage1-evidence-schema-upgrade-quarantine-v2-reseal-rollback-probe.mjs";
import {
  runStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbe,
  runStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbeCli,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_ROLLBACK_PROBE_EXPECTED_ROW,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_ROLLBACK_PROBE_USAGE,
} from "./run-stage1-evidence-schema-upgrade-quarantine-v2-reseal-rollback-probe.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(scriptDirectory, "../supabase/migrations");
const oldManifestSha256 =
  "f2a16adec57b3a66c3e467599bbf962cf02c94d1f6ded1daf5db09bf980c0184";
const oldPolicySha256 =
  "1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c";
const v2PolicySha256 =
  "917076584e316b4412d998ad820111046c1caf89f492012ed5061513ed7eef37";

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

describe("Stage 1 evidence-schema-upgrade quarantine v2 forward reseal", () => {
  const historicalMigration = normalizedFile(
    new URL(
      "../supabase/migrations/20260814211159_stage1_evidence_schema_upgrade_failure_quarantine.sql",
      import.meta.url,
    ),
  );
  const migration = normalizedFile(
    new URL(
      `../supabase/migrations/${STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_MIGRATION}`,
      import.meta.url,
    ),
  );
  const smoke = normalizedFile(
    new URL(
      `../supabase/tests/${STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_SMOKE}`,
      import.meta.url,
    ),
  );

  it("keeps the already-applied historical migration byte-contract on v1", () => {
    expect(historicalMigration).toContain(oldManifestSha256);
    expect(historicalMigration).toContain(oldPolicySha256);
    expect(historicalMigration).toContain(
      "awardping.stage1.reviewed-source-capture-allowlist.v1",
    );
    expect(historicalMigration).not.toContain(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256,
    );
    expect(historicalMigration).not.toContain(
      v2PolicySha256,
    );
  });

  it("parses as PostgreSQL and makes only the reviewed function/constraint delta", async () => {
    await loadModule();
    expect(() => parseSync(migration)).not.toThrow();
    expect(() => parseSync(smoke)).not.toThrow();
    expect(migration).not.toMatch(/^\s*(?:insert|update|delete|truncate)\b/imu);
    expect(migration).not.toMatch(/create\s+(?:or\s+replace\s+)?table\b/iu);
    expect(migration).not.toMatch(/\b(?:commit|rollback)\s*;/iu);
    expect(migration.match(/execute v_updated/giu)).toHaveLength(1);
    expect(migration.match(/drop constraint stage1_evidence_schema_upgrade_failure_hash_check/giu))
      .toHaveLength(1);
    expect(migration.match(/add constraint stage1_evidence_schema_upgrade_failure_hash_check/giu))
      .toHaveLength(1);
    expect(migration).toContain("not valid;");
    expect(migration).toContain(
      "validate constraint stage1_evidence_schema_upgrade_failure_hash_check",
    );
  });

  it("reseals the exact deployed v1 definition to historical manifest/policy v2", () => {
    expect(STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SCHEMA).toBe(
      "awardping.stage1.reviewed-source-capture-allowlist.v2",
    );
    expect(STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256).toBe(
      "42241673b1acf00b22f5e47f7a5fa1368ad0237ba9c4795a05541941ec2209c4",
    );
    for (const contract of [
      oldManifestSha256,
      oldPolicySha256,
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256,
      v2PolicySha256,
      "awardping.stage1.reviewed-source-capture-allowlist.v1",
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SCHEMA,
      "v_policy ->> 'policy_version' is distinct from '1'",
      "v_policy ->> 'policy_version' is distinct from '2'",
      "c68e74dc235fd4f74e38d6d9460f64567355a040bf27186b36aa857df2dcd1c8",
      "b0859cb4807b2a914800105154bf508be308fb1aa6943a10fb1b42b3b340083f",
      "The exact reversible quarantine RPC v2 reseal delta could not be proven.",
      "v_after_contract is distinct from v_before_contract",
    ]) {
      expect(migration).toContain(contract);
    }
  });

  it("allows only paired v1 history or paired v2 writes in the audit constraint", () => {
    const constraintStart = migration.indexOf(
      "add constraint stage1_evidence_schema_upgrade_failure_hash_check check (",
    );
    const constraintEnd = migration.indexOf(
      ") not valid;",
      constraintStart,
    );
    const constraint = migration.slice(constraintStart, constraintEnd);
    expect(constraintStart).toBeGreaterThanOrEqual(0);
    expect(constraintEnd).toBeGreaterThan(constraintStart);
    expect(constraint).toMatch(
      new RegExp(
        `manifest_sha256\\s*=\\s*'${oldManifestSha256}'` +
          `[\\s\\S]*?policy_sha256\\s*=\\s*'${oldPolicySha256}'` +
          `[\\s\\S]*?\\)\\s*or\\s*\\(` +
          `[\\s\\S]*?manifest_sha256\\s*=\\s*'${STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256}'` +
          `[\\s\\S]*?policy_sha256\\s*=\\s*'${v2PolicySha256}'`,
        "u",
      ),
    );
    expect(constraint.match(/manifest_sha256\s*=/gu)).toHaveLength(2);
    expect(constraint.match(/policy_sha256\s*=/gu)).toHaveLength(2);
  });

  it("keeps the smoke read-only and verifies exact v2 seals plus role boundaries", () => {
    expect(smoke).not.toMatch(/^\s*(?:insert|update|delete|truncate)\b/imu);
    for (const contract of [
      "b0859cb4807b2a914800105154bf508be308fb1aa6943a10fb1b42b3b340083f",
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256,
      v2PolicySha256,
      oldManifestSha256,
      oldPolicySha256,
      "set role anon;",
      "set role authenticated;",
      "set role service_role;",
      "The service role did not reach the Stage 1 quarantine v2 validation boundary.",
    ]) {
      expect(smoke).toContain(contract);
    }
  });
});

describe("Stage 1 quarantine v2 linked rollback probe", () => {
  const migration = normalizedFile(
    new URL(
      `../supabase/migrations/${STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_MIGRATION}`,
      import.meta.url,
    ),
  );
  const smoke = normalizedFile(
    new URL(
      `../supabase/tests/${STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_SMOKE}`,
      import.meta.url,
    ),
  );
  const priorVersions =
    listStage1EvidenceSchemaUpgradeQuarantineV2PriorVersions();
  const sql = renderStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbe();

  it("embeds one exact migration, one exact smoke, and every prior version", async () => {
    await loadModule();
    expect(() => parseSync(sql)).not.toThrow();
    expect(sql.match(/BEGIN EXACT MIGRATION/g)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT SMOKE/g)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT PRIOR MIGRATION VERSIONS/g)).toHaveLength(1);
    expect(sql).toContain(exactBlock({
      label: "MIGRATION",
      name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_MIGRATION,
      sql: migration,
    }));
    expect(sql).toContain(exactBlock({
      label: "SMOKE",
      name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_SMOKE,
      sql: smoke,
    }));
    expect(sql).toContain(exactPriorBlock(priorVersions));
    expect(sql).not.toMatch(/__AWARDPING_EXACT_/);
    expect(sql.endsWith("\n")).toBe(true);
    expect(sql).not.toContain("\r");

    const targetVersion =
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_MIGRATION.split(
        "_",
        1,
      )[0];
    const expectedPrior = readdirSync(migrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name))
      .map((name) => name.split("_", 1)[0])
      .filter((version) => version.localeCompare(targetVersion) < 0)
      .sort((left, right) => left.localeCompare(right));
    expect(priorVersions).toEqual(expectedPrior);
    expect(new Set(priorVersions).size).toBe(priorVersions.length);
    expect(priorVersions).toContain("20260814211159");
    expect(priorVersions).toContain("20260814223000");
  });

  it("runs the exact delta/smoke in one transaction and proves full rollback", () => {
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

    for (const contract of [
      "one or more prior repository migrations are not recorded as applied",
      "migration 20260815012910 is already recorded as applied",
      "the Stage 1 quarantine RPC has an unexpected overload",
      "the migration changed a function catalog attribute or OID outside the body reseal",
      "the migration or read-only smoke changed application or audit rows",
      "the original quarantine RPC definition or catalog attributes were not restored",
      "the original v1 audit constraint definition was not restored",
      "migration history changed despite rollback",
      "awardping_stage1_pending_migration_rollback_probe_passed",
      "awardping_stage1_quarantine_v2_reseal_rollback_probe_passed",
    ]) {
      expect(sql).toContain(contract);
    }
  });

  it("exposes only help or an argument-free hardened linked runner", () => {
    const execute = vi.fn(({ render }) => ({ status: "passed", sql: render() }));
    const render = vi.fn(() => "begin;\nrollback;\n");
    expect(runStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbe({
      execute,
      render,
    })).toEqual({ status: "passed", sql: "begin;\nrollback;\n" });
    expect(execute).toHaveBeenCalledWith({
      render,
      expectedResultRow:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_ROLLBACK_PROBE_EXPECTED_ROW,
    });

    const run = vi.fn(() => ({ status: "passed" }));
    const stdout = { write: vi.fn() };
    expect(runStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbeCli({
      argv: ["--help"],
      run,
      stdout,
    })).toEqual({ status: "help" });
    expect(stdout.write).toHaveBeenCalledWith(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_ROLLBACK_PROBE_USAGE,
    );
    expect(run).not.toHaveBeenCalled();
    expect(() =>
      runStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbeCli({
        argv: ["--dry-run"],
        run,
      }),
    ).toThrow("Unknown argument: --dry-run");
    expect(runStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbeCli({
      argv: [],
      run,
    })).toEqual({ status: "passed" });
    expect(run).toHaveBeenCalledOnce();
  });
});
