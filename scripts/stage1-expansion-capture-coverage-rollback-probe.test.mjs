import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  renderStage1ExpansionCaptureCoverageRollbackProbe,
  STAGE1_EXPANSION_CAPTURE_COVERAGE_MIGRATION,
  STAGE1_EXPANSION_CAPTURE_COVERAGE_SMOKE,
} from "./render-stage1-expansion-capture-coverage-rollback-probe.mjs";
import {
  runStage1ExpansionCaptureCoverageRollbackProbe,
  runStage1ExpansionCaptureCoverageRollbackProbeCli,
  STAGE1_EXPANSION_CAPTURE_COVERAGE_ROLLBACK_PROBE_EXPECTED_ROW,
  STAGE1_EXPANSION_COVERAGE_ROLLBACK_PROBE_USAGE,
} from "./run-stage1-expansion-capture-coverage-rollback-probe.mjs";

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

describe("Stage 1 expansion capture coverage linked rollback probe", () => {
  const priorMigration = normalizedFile(
    new URL(
      "../supabase/migrations/20260814141049_allow_expansion_evidence_without_main_layout.sql",
      import.meta.url,
    ),
  );
  const migration = normalizedFile(
    new URL(
      `../supabase/migrations/${STAGE1_EXPANSION_CAPTURE_COVERAGE_MIGRATION}`,
      import.meta.url,
    ),
  );
  const smoke = normalizedFile(
    new URL(
      `../supabase/tests/${STAGE1_EXPANSION_CAPTURE_COVERAGE_SMOKE}`,
      import.meta.url,
    ),
  );
  const sql = renderStage1ExpansionCaptureCoverageRollbackProbe();

  it("embeds only the exact new migration and its coverage smoke in order", () => {
    const migrationBlock = exactBlock({
      label: "MIGRATION",
      name: STAGE1_EXPANSION_CAPTURE_COVERAGE_MIGRATION,
      sql: migration,
    });
    const smokeBlock = exactBlock({
      label: "SMOKE",
      name: STAGE1_EXPANSION_CAPTURE_COVERAGE_SMOKE,
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

  it("changes the applied manifest validator by exactly one coverage gate", () => {
    const insertionPoint =
      "    or pg_catalog.jsonb_typeof(p_metadata -> 'text_object_bytes')\n";
    const coverageGate = [
      "    or not private.stage1_expansion_capture_coverage_valid(",
      "      p_kind, p_metadata",
      "    )",
      "",
    ].join("\n");
    expect(priorMigration.split(insertionPoint)).toHaveLength(2);
    const expectedManifestDefinition = priorMigration.replace(
      insertionPoint,
      coverageGate + insertionPoint,
    );
    expect(migration.endsWith(expectedManifestDefinition)).toBe(true);
    expect(migration.split(coverageGate)).toHaveLength(2);

    const helperDelta = migration.slice(
      0,
      migration.length - expectedManifestDefinition.length,
    );
    expect(helperDelta.match(/create or replace function/gi)).toHaveLength(1);
    expect(helperDelta.match(/revoke all on function/gi)).toHaveLength(1);
    expect(helperDelta).toMatch(
      /revoke all on function private\.stage1_expansion_capture_coverage_valid\(\s*text,\s*jsonb\s*\)/u,
    );
    expect(helperDelta).not.toMatch(
      /\b(?:create|alter|drop)\s+table\b|\b(?:insert|update|delete)\s+(?:into|from)?\b|\bgrant\b/iu,
    );
    expect(helperDelta).not.toMatch(/\b(?:or|and)\s+case\b/iu);
    expect(helperDelta.match(/\bor\s+\(case\b/giu)).toHaveLength(3);
  });

  it("requires the prior migration, keeps history untouched, and restores exact catalog state", () => {
    for (const contract of [
      "migration.version = '20260814141049'",
      "migration.version = '20260814173236'",
      "prerequisite migration 20260814141049 is not recorded as applied",
      "migration 20260814173236 is already recorded as applied",
      "pg_catalog.pg_get_functiondef(target.oid)",
      "'owner_oid', target.proowner::text",
      "'acl', pg_catalog.to_jsonb(target.proacl)",
      "'config', pg_catalog.to_jsonb(target.proconfig)",
      "v_function_oid = (",
      "the new coverage validator survived rollback",
      "the retained-source validator definition or catalog metadata survived rollback",
    ]) {
      expect(sql).toContain(contract);
    }
    expect(sql).toContain("1 as exact_migration_count");
    expect(sql).toContain(
      "awardping_stage1_expansion_coverage_rollback_probe_passed",
    );
    expect(sql).toContain("rollback;\n-- MIGRATION TRANSACTION END");
    const applyStart = sql.indexOf("-- MIGRATION TRANSACTION START");
    const rollback = sql.indexOf("rollback;\n-- MIGRATION TRANSACTION END");
    expect(sql.slice(applyStart, rollback)).not.toMatch(/^\s*commit\s*;/m);
  });

  it("exercises complete, missing, incomplete, contradictory, and PDF coverage", () => {
    for (const assertion of [
      "A complete expansion pair was rejected when main geometry was explicitly unavailable.",
      "A webpage without canonical expansion coverage was accepted.",
      "An incomplete expansion coverage verdict satisfied Stage 1.",
      "Contradictory retained-state coverage was accepted.",
      "The canonical zero-expansion explicit-unavailability shape no longer validates.",
      "A canonical PDF retained-artifact projection was rejected.",
      "A PDF carrying webpage expansion coverage was accepted.",
    ]) {
      expect(sql).toContain(assertion);
    }
    expect(sql).toContain("awardping.expansion-state-capture-coverage.v1");
    expect(sql).toContain("private.stage1_expansion_capture_coverage_valid");
  });
});

describe("Stage 1 expansion coverage rollback probe executable", () => {
  it("passes the dedicated renderer to the hardened linked-query runner", () => {
    const execute = vi.fn(({ render }) => ({ status: "passed", sql: render() }));
    const render = vi.fn(() => "begin;\nrollback;\n");
    const result = runStage1ExpansionCaptureCoverageRollbackProbe({
      execute,
      render,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({
      render,
      expectedResultRow:
        STAGE1_EXPANSION_CAPTURE_COVERAGE_ROLLBACK_PROBE_EXPECTED_ROW,
    });
    expect(result).toEqual({ status: "passed", sql: "begin;\nrollback;\n" });
  });

  it.each(["--help", "-h"])(
    "prints dedicated help for %s without connecting",
    (helpFlag) => {
      const run = vi.fn();
      const stdout = { write: vi.fn() };
      expect(runStage1ExpansionCaptureCoverageRollbackProbeCli({
        argv: [helpFlag],
        run,
        stdout,
      })).toEqual({ status: "help" });
      expect(stdout.write).toHaveBeenCalledWith(
        STAGE1_EXPANSION_COVERAGE_ROLLBACK_PROBE_USAGE,
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("rejects arguments and runs only with an empty argument list", () => {
    const run = vi.fn(() => ({ status: "passed" }));
    expect(() => runStage1ExpansionCaptureCoverageRollbackProbeCli({
      argv: ["--dry-run"],
      run,
    })).toThrow("Unknown argument: --dry-run");
    expect(run).not.toHaveBeenCalled();
    expect(runStage1ExpansionCaptureCoverageRollbackProbeCli({
      argv: [],
      run,
    })).toEqual({ status: "passed" });
    expect(run).toHaveBeenCalledOnce();
  });
});
