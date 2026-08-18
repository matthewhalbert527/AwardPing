import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { loadModule, parseSync } from "libpg-query";

import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_SHA256,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_VERSION,
} from "./lib/stage1-evidence-schema-upgrade-quarantine.mjs";
import {
  listStage1EvidenceSchemaUpgradeQuarantineV3PriorVersions,
  renderStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbe,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ACCOUNTING_MIGRATION,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ACCOUNTING_SMOKE,
} from "./render-stage1-evidence-schema-upgrade-quarantine-v3-accounting-rollback-probe.mjs";
import {
  runStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbe,
  runStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbeCli,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ROLLBACK_PROBE_EXPECTED_ROW,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ROLLBACK_PROBE_USAGE,
} from "./run-stage1-evidence-schema-upgrade-quarantine-v3-accounting-rollback-probe.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(scriptDirectory, "../supabase/migrations");
const manifestV1Sha256 =
  "f2a16adec57b3a66c3e467599bbf962cf02c94d1f6ded1daf5db09bf980c0184";
const policyV1Sha256 =
  "1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c";
const policyV2Sha256 =
  "917076584e316b4412d998ad820111046c1caf89f492012ed5061513ed7eef37";
const policyV3Sha256 =
  "5b544eae051e4ed8313aec2a253a5f7795b351b4536869dbddae41138eb79fb6";
const functionV2Sha256 =
  "b0859cb4807b2a914800105154bf508be308fb1aa6943a10fb1b42b3b340083f";
const functionV3Sha256 =
  "cc18feb9a5ebfbd82cf113f31d9f9955e5fccb625ca8c7fb94d47940abf4d666";
const constraintV2Sha256 =
  "7d0a76947a366e94a74857903986618b101f1b26bd204d6668b0872bed0771a6";
const constraintV3Sha256 =
  "82bfc427d568cb7ddedcd56d9ef8fa16dd61c769395f9a30e5466c0e387160c6";

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

function contractValue(sql, name) {
  const match = new RegExp(
    `${name} constant text :=\\s*\\$contract\\$([\\s\\S]*?)\\$contract\\$;`,
    "u",
  ).exec(sql);
  expect(match).not.toBeNull();
  return match[1];
}

describe("Stage 1 evidence-schema-upgrade quarantine v3 accounting migration", () => {
  const migration = normalizedFile(
    new URL(
      `../supabase/migrations/${STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ACCOUNTING_MIGRATION}`,
      import.meta.url,
    ),
  );
  const smoke = normalizedFile(
    new URL(
      `../supabase/tests/${STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ACCOUNTING_SMOKE}`,
      import.meta.url,
    ),
  );

  it("is a forward-only exact function/constraint delta with no row mutation", async () => {
    await loadModule();
    expect(() => parseSync(migration)).not.toThrow();
    expect(() => parseSync(smoke)).not.toThrow();
    expect(migration).not.toMatch(/^\s*(?:insert|update|delete|truncate)\b/imu);
    expect(migration).not.toMatch(/create\s+(?:or\s+replace\s+)?table\b/iu);
    expect(migration).not.toMatch(/\b(?:commit|rollback)\s*;/iu);
    expect(migration.match(/execute v_updated/giu)).toHaveLength(1);
    expect(migration.match(
      /drop constraint stage1_evidence_schema_upgrade_failure_hash_check/giu,
    )).toHaveLength(1);
    expect(migration.match(
      /add constraint stage1_evidence_schema_upgrade_failure_hash_check/giu,
    )).toHaveLength(1);
    expect(migration).toContain("not valid;");
    expect(migration).toContain(
      "validate constraint stage1_evidence_schema_upgrade_failure_hash_check",
    );
  });

  it("reseals the unchanged manifest v2 to policy v3 and exact RPC digest", () => {
    expect(STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256).toBe(
      "42241673b1acf00b22f5e47f7a5fa1368ad0237ba9c4795a05541941ec2209c4",
    );
    expect(STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_VERSION).toBe("3");
    expect(STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_SHA256).toBe(
      policyV3Sha256,
    );
    for (const contract of [
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256,
      policyV2Sha256,
      policyV3Sha256,
      functionV2Sha256,
      functionV3Sha256,
      constraintV2Sha256,
      constraintV3Sha256,
      "v_policy ->> 'policy_version' is distinct from '2'",
      "v_policy ->> 'policy_version' is distinct from '3'",
      "The exact reversible quarantine RPC v3 accounting delta could not be proven.",
      "v_after_contract is distinct from v_before_contract",
    ]) {
      expect(migration).toContain(contract);
    }
  });

  it("accepts exactly legacy-four or current-six and enforces nested matrices", () => {
    const current = contractValue(migration, "v_new_accounting_contract");
    expect(current).toContain(
      "array['boundary', 'cas', 'journal_phase', 'response_loss_possible']",
    );
    expect(current.match(/'journal_archive',\s*'journal_persistence'/gu))
      .toHaveLength(2);
    expect(current).toContain(
      "'local_journal_writes_lower_bound',\n                'response_loss_possible',\n                'state'",
    );
    expect(current).toContain(
      "'active_absence_verified',\n                'archive_receipt_acknowledged',\n                'archived_readback_verified',\n                'evidence_sha256',\n                'local_journal_archive_writes_lower_bound',\n                'response_loss_possible',\n                'schema_version',\n                'state'",
    );
    for (const state of [
      "not_started",
      "write_in_flight",
      "write_response_unknown",
      "write_acknowledged_readback_pending",
      "write_acknowledged_readback_unverified",
      "verified",
      "archive_write_in_flight",
      "archive_write_response_unknown",
      "archive_receipt_unverified",
      "archive_write_acknowledged_readback_pending",
      "archive_write_acknowledged_readback_unverified",
      "archived_readback_verified_active_absence_pending",
      "archived_readback_verified_active_absence_response_unknown",
      "archived_readback_verified_active_still_present",
    ]) {
      expect(current).toContain(`'${state}'`);
    }
    expect(current).toContain(
      "awardping.stage1.evidence-schema-upgrade-journal-archive-accounting.v1",
    );
    expect(current).toContain(
      "private.stage1_evidence_schema_upgrade_quarantine_json_sha256(",
    );
    expect(current).toContain(
      "] in ('not_started', 'verified')",
    );
    expect(current).toContain(
      "'journal_archive', 'state'\n            ] = 'not_started'",
    );
    expect(current).not.toContain("jsonb_object_keys");
  });

  it("preserves only paired v1, paired v2, or paired v3 audit seals", () => {
    const start = migration.indexOf(
      "add constraint stage1_evidence_schema_upgrade_failure_hash_check check (",
    );
    const end = migration.indexOf(") not valid;", start);
    const constraint = migration.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(constraint.match(/manifest_sha256\s*=/gu)).toHaveLength(3);
    expect(constraint.match(/policy_sha256\s*=/gu)).toHaveLength(3);
    expect(constraint.match(new RegExp(STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256, "gu")))
      .toHaveLength(2);
    for (const seal of [
      manifestV1Sha256,
      policyV1Sha256,
      policyV2Sha256,
      policyV3Sha256,
    ]) {
      expect(constraint).toContain(seal);
    }
  });

  it("keeps the smoke read-only and proves exact seals plus role boundaries", () => {
    expect(smoke).not.toMatch(/^\s*(?:insert|update|delete|truncate)\b/imu);
    for (const contract of [
      functionV3Sha256,
      constraintV3Sha256,
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256,
      policyV3Sha256,
      policyV2Sha256,
      "set role anon;",
      "set role authenticated;",
      "set role service_role;",
      "The service role did not reach the Stage 1 quarantine v3 validation boundary.",
    ]) {
      expect(smoke).toContain(contract);
    }
  });
});

describe("Stage 1 quarantine v3 linked rollback probe", () => {
  const migration = normalizedFile(
    new URL(
      `../supabase/migrations/${STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ACCOUNTING_MIGRATION}`,
      import.meta.url,
    ),
  );
  const smoke = normalizedFile(
    new URL(
      `../supabase/tests/${STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ACCOUNTING_SMOKE}`,
      import.meta.url,
    ),
  );
  const priorVersions =
    listStage1EvidenceSchemaUpgradeQuarantineV3PriorVersions();
  const sql = renderStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbe();

  it("embeds one exact migration, one exact smoke, and every prior version", async () => {
    await loadModule();
    expect(() => parseSync(sql)).not.toThrow();
    expect(sql.match(/BEGIN EXACT MIGRATION/g)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT SMOKE/g)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT PRIOR MIGRATION VERSIONS/g)).toHaveLength(1);
    expect(sql).toContain(exactBlock({
      label: "MIGRATION",
      name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ACCOUNTING_MIGRATION,
      sql: migration,
    }));
    expect(sql).toContain(exactBlock({
      label: "SMOKE",
      name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ACCOUNTING_SMOKE,
      sql: smoke,
    }));
    expect(sql).toContain(exactPriorBlock(priorVersions));
    expect(sql).not.toMatch(/__AWARDPING_EXACT_/);
    expect(sql.endsWith("\n")).toBe(true);
    expect(sql).not.toContain("\r");

    const targetVersion =
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ACCOUNTING_MIGRATION.split(
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
    expect(priorVersions).toContain("20260815012910");
    expect(priorVersions).toContain("20260815023357");
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
      "migration 20260815083322 is already recorded as applied",
      "the Stage 1 quarantine RPC has an unexpected overload",
      "the migration changed a function catalog attribute or OID outside the body reseal",
      "the migration or read-only smoke changed application or audit rows",
      "the original quarantine RPC definition or catalog attributes were not restored",
      "the original paired v1/v2 audit constraint definition was not restored",
      "migration history changed despite rollback",
      "awardping_stage1_pending_migration_rollback_probe_passed",
      "awardping_stage1_quarantine_v3_accounting_rollback_probe_passed",
    ]) {
      expect(sql).toContain(contract);
    }
  });

  it("exposes only help or an argument-free hardened linked runner", () => {
    const execute = vi.fn(({ render }) => ({ status: "passed", sql: render() }));
    const render = vi.fn(() => "begin;\nrollback;\n");
    expect(runStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbe({
      execute,
      render,
    })).toEqual({ status: "passed", sql: "begin;\nrollback;\n" });
    expect(execute).toHaveBeenCalledWith({
      render,
      expectedResultRow:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ROLLBACK_PROBE_EXPECTED_ROW,
    });

    const run = vi.fn(() => ({ status: "passed" }));
    const stdout = { write: vi.fn() };
    expect(runStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbeCli({
      argv: ["--help"],
      run,
      stdout,
    })).toEqual({ status: "help" });
    expect(stdout.write).toHaveBeenCalledWith(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V3_ROLLBACK_PROBE_USAGE,
    );
    expect(run).not.toHaveBeenCalled();
    expect(() =>
      runStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbeCli({
        argv: ["--dry-run"],
        run,
      }),
    ).toThrow("Unknown argument: --dry-run");
    expect(runStage1EvidenceSchemaUpgradeQuarantineV3RollbackProbeCli({
      argv: [],
      run,
    })).toEqual({ status: "passed" });
    expect(run).toHaveBeenCalledOnce();
  });
});
