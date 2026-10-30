import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "libpg-query";
import { loadProgramTextBasicStatus } from "./program-text-worker.mjs";
import { buildProgramAwardExpansionRollback } from "./lib/program-award-expansion-rollback-fixture.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261030151153_program_award_expansion_registry.sql", import.meta.url), "utf8");
const uuid = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const status = n => ({ cohort_key: "award_" + n, award_id: uuid(n + 1), snapshot_id: n % 2 ? uuid(n + 101) : null, basic_details_current: n % 2 === 1 });
const roster = n => ({ manifest: Array.from({ length: n }, (_, i) => ({ cohort_key: "award_" + i })) });
const db = awards => ({ rpc: async name => {
  expect(name).toBe("get_program_award_monitoring_basics");
  return { data: { schema: "awardping.program-award-monitoring-basics.v1", awards }, error: null };
} });

describe("expanded basic-purpose worker reporting", () => {
  it.each([25, 30, 35])("loads the exact current %i-award union without a full approval workflow", async count => {
    const result = await loadProgramTextBasicStatus(db(Array.from({ length: count }, (_, i) => status(i))), roster(count));
    expect(result.size).toBe(count);
    expect(result.get("award_1").basic_details_current).toBe(true);
    expect(result.get("award_0").snapshot_id).toBeNull();
  });
  it.each([
    rows => rows.slice(0, 24),
    rows => [...rows, status(25)],
    rows => rows.map((r, i) => i === 1 ? rows[0] : r),
    rows => rows.map((r, i) => i === 1 ? { ...r, award_id: rows[0].award_id } : r),
    rows => rows.map((r, i) => i === 0 ? { ...r, basic_details_current: true } : r),
    rows => rows.map((r, i) => i === 1 ? { ...r, snapshot_id: "unverified" } : r),
    rows => rows.map((r, i) => i === 1 ? { ...r, cohort_key: "unknown" } : r),
    rows => rows.map((r, i) => i === 1 ? { ...r, complete_program_approval: true } : r),
  ])("rejects incomplete, stale-shaped or wrongly owned basic status %#", async change => {
    await expect(loadProgramTextBasicStatus(db(change(Array.from({ length: 25 }, (_, i) => status(i)))), roster(25))).rejects.toThrow(/unavailable|incomplete/);
  });
  it("does not turn a failed database read into an empty successful report", async () => {
    await expect(loadProgramTextBasicStatus({ rpc: async () => ({ data: null, error: { code: "42501" } }) }, roster(25))).rejects.toThrow("unavailable");
  });
});

describe("bounded additive award admission migration", () => {
  it("parses as explicit reviewed DDL rather than runtime function rewriting", async () => {
    expect((await parse(migration)).stmts.length).toBeGreaterThan(60);
    expect(migration).not.toMatch(/execute\s+pg_get_functiondef/i);
    expect(migration).not.toMatch(/alter table public\.stage1_award_registry|update public\.stage1_award_registry|insert into public\.stage1_award_registry/i);
  });
  it("protects new tables and limits public entry points to the backend", () => {
    for (const table of ["program_award_registry", "program_award_members", "program_award_expansion_admissions"]) {
      expect(migration).toContain("alter table public." + table + " enable row level security");
      expect((migration.match(/revoke all on public\.[^;]+;/g) || []).some(statement =>
        statement.includes("public." + table) && statement.endsWith("from public,anon,authenticated,service_role;"))).toBe(true);
    }
    for (const name of ["admit_program_award_expansion_batch", "activate_program_award_expansion_batch", "get_program_award_expansion_publication", "get_program_award_monitoring_basics"]) {
      expect(migration).toMatch(new RegExp("revoke all on function public\\." + name + "\\([^;]+from public,anon,authenticated,service_role"));
      expect(migration).toMatch(new RegExp("grant execute on function public\\." + name + "\\([^;]+to service_role"));
    }
  });
  it("bounds reviewed identity and programme URLs, and forbids full expansion approvals", () => {
    expect(migration).toContain("jsonb_array_length(p_awards)<>5");
    expect(migration).toContain("jsonb_array_length(w->'sources') not between 1 and 6");
    expect(migration).toContain("source selection");
    expect(migration).toContain("and coalesce(p_approval,true) then return false");
    expect(migration).toContain("'program-basic-expansion-v1'");
  });
  it("preserves historical source identities and compares exact collision records", () => {
    expect(migration).toContain("actual_boundary is distinct from q->'url_alias_boundary'");
    expect(migration).toContain("memberships");
    expect(migration).toContain("Existing source identity, history or permission changed");
    expect(migration).not.toMatch(/update public\.shared_award_sources\s+set\s+text_monitoring_state/i);
    expect(migration).toContain("'baseline_only'");
    expect(migration).toContain("'server_first_capture_eligible',false");
  });
  it("lets the database generate reviewed_text roster status and supplies required insertion fields", () => {
    const columns = migration.match(/insert into public\.program_text_source_roster\(([^)]+)\)/)[1].split(",");
    expect(columns).not.toContain("manifest_status");
    expect(columns).toEqual(["cohort_key", "source_role", "source_ids", "evidence", "reviewed_by"]);
    expect(migration).toContain("insert into public.shared_award_source_acquisitions(shared_award_source_id,acquisition_kind,notification_mode,onboarding_batch_id,review_seal,metadata)");
  });
  it("requires initial readiness before activation but keeps admitted identity during later changes", () => {
    expect(migration).toContain("private.program_award_expansion_initial_ready(a.cohort_key,e)");
    expect(migration).toContain("and private.program_award_identity_is_public(member.cohort_key)");
    const publication = migration.slice(migration.indexOf("create function public.get_program_award_expansion_publication"));
    expect(publication).toContain("where a.status='active' and a.epoch=p_epoch");
    expect(publication).not.toContain("where private.program_award_expansion_initial_ready");
    expect(publication).toContain("public.get_program_basic_facts(array[r.canonical_shared_award_id])");
  });
});

describe("explicit rollback-only operational rehearsal", () => {
  it("wraps the actual migration and tests atomicity, silent first coverage and unauthorized boundaries", async () => {
    const sql = buildProgramAwardExpansionRollback({ migration, awards: Array.from({ length: 5 }, (_, i) => ({ cohort_key: "rollback_" + i, sources: [] })) });
    expect(sql).toMatch(/^begin isolation level repeatable read;/);
    expect(sql).toMatch(/rollback;\s*$/);
    expect(sql).toContain("Unverified first coverage reached public identity/alerts");
    expect(sql).toContain("Rejected last-award plan left a partial mutation");
    expect(sql).toContain("has_function_privilege('anon'");
    expect(sql).toContain("Admission replay reset source history");
    expect((await parse(sql)).stmts.length).toBeGreaterThan(75);
  });
  it("refuses a committing migration or incomplete batch fixture", () => {
    expect(() => buildProgramAwardExpansionRollback({ migration: migration + "\ncommit;", awards: Array(5).fill({}) })).toThrow("transaction-free");
    expect(() => buildProgramAwardExpansionRollback({ migration, awards: [] })).toThrow("five");
  });
});

