import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parse } from "libpg-query";

const sql = readFileSync(new URL("../supabase/migrations/20261025160637_program_text_source_roster.sql", import.meta.url), "utf8");
const ast = await parse(sql);
const functions = ast.stmts.map(x => x.stmt.CreateFunctionStmt).filter(Boolean);
const name = fn => fn.funcname.map(x => x.String.sval).join(".");
const option = (fn, key) => fn.options.find(x => x.DefElem.defname === key)?.DefElem.arg;
const body = fn => option(fn, "as").List.items[0].String.sval;

describe("text-only collection authority", () => {
  it("parses and never resets captures, candidates or the legacy manifests", () => {
    expect(ast.stmts.length).toBeGreaterThan(10);
    expect(sql).not.toMatch(/(?:update|delete\s+from|alter\s+table)\s+public\.(?:shared_award_sources|shared_award_visual_review_candidates|stage1_award_source_manifest)\b/i);
    expect(sql).not.toMatch(/set_stage1_award_manifest_entry/);
    expect(sql).toContain("cardinality(m.source_ids) not between 1 and 50");
    expect(sql).toContain("count(distinct cohort_key)");
  });
  it("protects roster and immutable audit records with RLS and service read-only grants", () => {
    for (const table of ["program_text_source_roster", "program_text_source_roster_events"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    expect(sql).toContain("grant select on public.program_text_source_roster,public.program_text_source_roster_events to service_role");
    expect(sql).not.toMatch(/grant\s+(?:all|insert|update|delete)[^;]+\bto\s+(?:anon|authenticated|service_role)\b/i);
  });
  it("exposes only a bounded role-replacement definer with no public execution", () => {
    for (const fn of functions) {
      expect(option(fn, "security")?.Boolean.boolval ?? false).toBe(name(fn) === "public.replace_program_text_source_role");
      expect(fn.options.some(x => x.DefElem.defname === "set" && x.DefElem.arg.VariableSetStmt.name === "search_path" &&
        x.DefElem.arg.VariableSetStmt.args[0].A_Const.sval.sval === "")).toBe(true);
    }
    expect(sql).toContain("revoke all on function public.replace_program_text_source_role(text,text,uuid,uuid[],jsonb,text) from public,anon,authenticated");
    expect(sql).not.toMatch(/grant\s+execute[^;]+\bto\s+(?:public|anon|authenticated)\b/i);
  });
  it("retains role, owner, source URL, exclusion, review and stale-version checks", () => {
    const text = body(functions.find(fn => name(fn) === "public.replace_program_text_source_role"));
    for (const guard of ["for update", "v_old.revision<>p_expected_revision", "count(distinct x)",
      "v_source.admin_review_status is distinct from 'open'", "m.shared_award_id=v_source.shared_award_id",
      "v_binding->>'source_url' is distinct from v_source.url", "v_binding->>'shared_award_id' is distinct from v_source.shared_award_id::text",
      "stage1_award_source_identity_rules", "authority_url", "review_note", "previous_entry,next_entry", "to_jsonb(v_old),to_jsonb(v_new)"]) expect(text).toContain(guard);
  });
  it("parses SQL helper bodies and keeps source approval on current text-only bindings", async () => {
    for (const fn of functions) if (option(fn, "language").String.sval === "sql") await parse(body(fn));
    const allowed = body(functions.find(fn => name(fn) === "private.awardping_program_source_allowed"));
    expect(allowed).toContain("public.program_text_source_roster");
    expect(allowed).toContain("'shared_award_id'");
    expect(allowed).not.toContain("public.stage1_award_source_manifest");
  });
});
