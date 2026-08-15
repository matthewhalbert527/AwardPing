import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadModule, parseSync } from "libpg-query";

import {
  listStage1EvidenceSchemaUpgradeQuarantinePriorMigrationVersions,
  renderStage1EvidenceSchemaUpgradeQuarantineRollbackProbe,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_MIGRATION,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_SMOKE,
} from "./render-stage1-evidence-schema-upgrade-quarantine-rollback-probe.mjs";
import {
  runStage1EvidenceSchemaUpgradeQuarantineRollbackProbe,
  runStage1EvidenceSchemaUpgradeQuarantineRollbackProbeCli,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_ROLLBACK_PROBE_USAGE,
} from "./run-stage1-evidence-schema-upgrade-quarantine-rollback-probe.mjs";

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

describe("Stage 1 evidence-schema-upgrade quarantine linked rollback probe", () => {
  const migration = normalizedFile(
    new URL(
      `../supabase/migrations/${STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_MIGRATION}`,
      import.meta.url,
    ),
  );
  const smoke = normalizedFile(
    new URL(
      `../supabase/tests/${STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_SMOKE}`,
      import.meta.url,
    ),
  );
  const priorVersions =
    listStage1EvidenceSchemaUpgradeQuarantinePriorMigrationVersions();
  const sql = renderStage1EvidenceSchemaUpgradeQuarantineRollbackProbe();

  it("renders parseable LF-only SQL with one exact migration and smoke", async () => {
    await loadModule();
    expect(() => parseSync(sql)).not.toThrow();
    expect(sql.match(/BEGIN EXACT MIGRATION/gu)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT SMOKE/gu)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT PRIOR MIGRATION VERSIONS/gu)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT REVIEWED-NINE MANIFEST/gu)).toHaveLength(1);
    expect(sql.match(/BEGIN EXACT JAVASCRIPT EVIDENCE/gu)).toHaveLength(1);
    expect(sql).toContain(exactBlock({
      label: "MIGRATION",
      name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_MIGRATION,
      sql: migration,
    }));
    expect(sql).toContain(exactBlock({
      label: "SMOKE",
      name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_SMOKE,
      sql: smoke,
    }));
    expect(sql).toContain(exactPriorBlock(priorVersions));
    expect(sql).not.toMatch(/__AWARDPING_EXACT_/u);
    expect(sql).toContain("the exact JavaScript-helper ' || v_scenario ||");
    expect(sql).toContain("where fixture.scenario = 'changed'");
    expect(sql).toContain("where fixture.scenario = 'same'");
    expect(sql).toContain("where fixture.scenario = 'absent'");
    expect(sql).toContain("where fixture.scenario = 'capture_absent'");
    expect(sql).toContain("verify_journal_observation_rpc_branches");
    expect(sql).toContain("where invocation = 5");
    expect(sql).toContain("where invocation = 6");
    expect(sql).toContain("fresh_absence_only");
    expect(sql).toContain("verified_absent");
    expect(sql).toContain(
      "the verified-absent journal receipt, replay, storage, binding, availability, or action was not exact",
    );
    expect(sql).toContain(
      "Malformed verified-absence evidence was not rejected with exact zero audit delta.",
    );
    expect(sql).toContain(
      "the no-mutation verified-absence observation was not accepted without a pointer binding",
    );
    expect(sql).toContain(
      "v_evidence ->> 'candidate_artifacts_sha256'",
    );
    expect(sql).toContain("v_evidence ->> 'commit_recovery_sha256'");
    expect(sql).toContain(
      "stage1_evidence_schema_upgrade_quarantine_base64_sha256",
    );
    expect(sql).not.toContain("\r");
    expect(sql.endsWith("\n")).toBe(true);
  });

  it("requires the complete prior chain and exactly one unapplied target", () => {
    const targetVersion =
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_MIGRATION.split("_", 1)[0];
    const expectedPrior = readdirSync(migrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name))
      .map((name) => name.split("_", 1)[0])
      .filter((version) => version.localeCompare(targetVersion) < 0)
      .sort((left, right) => left.localeCompare(right));
    expect(priorVersions).toEqual(expectedPrior);
    expect(new Set(priorVersions).size).toBe(priorVersions.length);
    expect(priorVersions.at(-1)).toBe("20260814203233");
    for (const contract of [
      "one or more prior repository migrations are not recorded as applied",
      "migration 20260814211159 is already recorded as applied",
      "public.get_stage1_source_activation_finalizations(uuid[])",
      "the target quarantine migration already exists or has drifted objects",
      "no exact finalized reviewed-nine source is available",
    ]) {
      expect(sql).toContain(contract);
    }
  });

  it("performs reason A, reason B, its replay, and a full active-journal failure", () => {
    const migrationStart = sql.indexOf("-- BEGIN EXACT MIGRATION");
    const smokeStart = sql.indexOf("-- BEGIN EXACT SMOKE", migrationStart);
    const fixtureStart = sql.indexOf("do $build_positive_fixture$", smokeStart);
    const positiveCalls = sql.indexOf(
      "set role service_role;\ninsert into pg_temp.awardping_stage1_upgrade_quarantine_receipts",
      fixtureStart,
    );
    const firstCall = sql.indexOf(
      "public.quarantine_stage1_evidence_schema_upgrade_failure(",
      positiveCalls,
    );
    const secondCall = sql.indexOf(
      "public.quarantine_stage1_evidence_schema_upgrade_failure(",
      firstCall + 1,
    );
    const thirdCall = sql.indexOf(
      "public.quarantine_stage1_evidence_schema_upgrade_failure(",
      secondCall + 1,
    );
    const fourthCall = sql.indexOf(
      "public.quarantine_stage1_evidence_schema_upgrade_failure(",
      thirdCall + 1,
    );
    const delta = sql.indexOf("do $positive_exact_delta$", fourthCall);
    const rollback = sql.indexOf("rollback;\n-- MIGRATION TRANSACTION END", delta);
    expect(migrationStart).toBeGreaterThanOrEqual(0);
    expect(smokeStart).toBeGreaterThan(migrationStart);
    expect(fixtureStart).toBeGreaterThan(smokeStart);
    expect(positiveCalls).toBeGreaterThan(fixtureStart);
    expect(firstCall).toBeGreaterThan(fixtureStart);
    expect(secondCall).toBeGreaterThan(firstCall);
    expect(thirdCall).toBeGreaterThan(secondCall);
    expect(fourthCall).toBeGreaterThan(thirdCall);
    expect(delta).toBeGreaterThan(fourthCall);
    expect(rollback).toBeGreaterThan(delta);
    expect(sql.slice(migrationStart, rollback)).not.toMatch(/^\s*commit\s*;/mu);
    for (const contract of [
      "set role service_role;",
      "v_first -> 'audit_inserted' = 'true'::jsonb",
      "v_second -> 'audit_inserted' = 'true'::jsonb",
      "v_third -> 'audit_inserted' = 'false'::jsonb",
      "v_fourth -> 'audit_inserted' = 'true'::jsonb",
      "did not create exactly three immutable failure audits",
      "did not create exactly one source-specific quarantine",
      "evidence_record_count = 3",
      "terminal_failure_count = 1",
      "the reason-B replay, or the active-journal observation was not exact and monotonic",
      "v_first #>> array['mutation_counts', 'database_writes'] = '9'",
      "v_second #>> array['mutation_counts', 'database_writes'] = '5'",
      "v_third #>> array['mutation_counts', 'database_writes'] = '4'",
      "v_fourth #>> array['mutation_counts', 'database_writes'] = '5'",
      "Finalization timestamp drift was not rejected.",
      "Missing validation source binding was not rejected.",
      "Swapped validation source binding was not rejected.",
      "Same-source wrong candidate generation was not rejected.",
      "Same-source wrong candidate hash was not rejected.",
      "Missing candidate validation image hash was not rejected.",
      "Simultaneous recovery and unavailable journal evidence was not rejected.",
      "Unreachable pointer-commit validation decision was not rejected.",
      "Unreachable candidate-enqueue validation decision was not rejected.",
      "Unsealed mutation accounting was not rejected.",
      "Non-string unknown mutation category was not rejected.",
      "Malformed journal-read-unavailable observation was not rejected.",
      "Candidate-enqueue ' || (v_case ->> 'label') ||",
      "Pointer-commit ' || (v_case ->> 'label') ||",
      "forbidden unknown R2 category",
      "forbidden unknown quarantine category",
      "Exactly resealed pointer-receipt database-write inflation was not rejected.",
      "A resealed noncanonical candidate capture timestamp was not rejected.",
      "A resealed noncanonical candidate pointer timestamp was not rejected.",
      "2026-08-14T24:00:00.000Z",
      "durable_upgrade_journal_read_unavailable",
      "rollback_probe_candidate_observation_committed",
      "v_failure_journal.evidence -> 'candidate_artifacts'",
      "v_failure_journal.evidence -> 'commit_recovery'",
    ]) {
      expect(sql).toContain(contract);
    }
  });

  it("proves zero public award-update/candidate/paid-lane delta and exact safety events", () => {
    for (const contract of [
      "public.shared_award_change_events",
      "public.shared_award_visual_review_candidates",
      "public.gemini_spend_days",
      "public.gemini_spend_reservations",
      "public.gemini_spend_events",
      "public.stage1_award_publication_events",
      "public.stage1_publication_release_events",
      "public.manual_quarantine_backlog_state",
      "the quarantine exact release-safety, operator-event, visual-candidate, or paid-lane delta drifted",
      "0 as public_award_update_delta",
      "1 as stage1_publication_safety_event_delta",
      "1 as stage1_release_safety_event_delta",
      "4 as manual_quarantine_event_delta",
      "4 as manual_quarantine_backlog_revision_delta",
      "0 as visual_candidate_delta",
      "0 as paid_lane_delta",
    ]) {
      expect(sql).toContain(contract);
    }
  });

  it("verifies exact catalog and application restoration after rollback", () => {
    for (const contract of [
      "awardping_stage1_upgrade_quarantine_catalog_contract()",
      "the target quarantine definition or catalog attributes survived rollback",
      "the new failure audit table, helper, or quarantine RPC survived rollback",
      "stage1_evidence_schema_upgrade_quarantine_base64_sha256(text)",
      "stage1_evidence_schema_upgrade_quarantine_json_domain_valid(jsonb)",
      "the rollback did not restore exact reviewed-source, operator-case, event, or paid-lane state",
      "migration history changed despite rollback",
      "awardping_stage1_evidence_schema_upgrade_quarantine_probe_passed",
      "migration/smoke/positive replay/catalog/application changes rolled back",
    ]) {
      expect(sql).toContain(contract);
    }
  });
});

describe("Stage 1 evidence-schema-upgrade quarantine rollback executable", () => {
  it("passes the dedicated renderer to the hardened linked-query runner", () => {
    const execute = vi.fn(({ render }) => ({ status: "passed", sql: render() }));
    const render = vi.fn(() => "begin;\nrollback;\n");
    expect(runStage1EvidenceSchemaUpgradeQuarantineRollbackProbe({
      execute,
      render,
    })).toEqual({ status: "passed", sql: "begin;\nrollback;\n" });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ render });
  });

  it.each(["--help", "-h"])(
    "prints dedicated help for %s without connecting",
    (helpFlag) => {
      const run = vi.fn();
      const stdout = { write: vi.fn() };
      expect(runStage1EvidenceSchemaUpgradeQuarantineRollbackProbeCli({
        argv: [helpFlag],
        run,
        stdout,
      })).toEqual({ status: "help" });
      expect(stdout.write).toHaveBeenCalledWith(
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_ROLLBACK_PROBE_USAGE,
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("rejects arguments and runs only with an empty argument list", () => {
    const run = vi.fn(() => ({ status: "passed" }));
    expect(() => runStage1EvidenceSchemaUpgradeQuarantineRollbackProbeCli({
      argv: ["--dry-run"],
      run,
    })).toThrow("Unknown argument: --dry-run");
    expect(run).not.toHaveBeenCalled();
    expect(runStage1EvidenceSchemaUpgradeQuarantineRollbackProbeCli({
      argv: [],
      run,
    })).toEqual({ status: "passed" });
    expect(run).toHaveBeenCalledOnce();
  });
});
