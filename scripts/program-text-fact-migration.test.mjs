import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parse } from "libpg-query";
const sql = readFileSync(new URL("../supabase/migrations/20261025161903_program_text_fact_reviews.sql", import.meta.url), "utf8");
const ast = await parse(sql), functions = ast.stmts.map(x => x.stmt.CreateFunctionStmt).filter(Boolean);
const name = fn => fn.funcname.map(x => x.String.sval).join(".");
const option = (fn, key) => fn.options.find(x => x.DefElem.defname === key)?.DefElem.arg;
const body = fn => option(fn, "as").List.items[0].String.sval;

describe("private source-bound current-fact publication", () => {
  it("parses the SQL and exposes no direct public or service writes", async () => {
    expect(ast.stmts.length).toBeGreaterThan(20);
    for (const fn of functions) {
      expect(fn.options.some(x => x.DefElem.defname === "set" && x.DefElem.arg.VariableSetStmt.name === "search_path" && x.DefElem.arg.VariableSetStmt.args[0].A_Const.sval.sval === "")).toBe(true);
      if (option(fn, "language").String.sval === "sql") await parse(body(fn));
    }
    expect(sql).not.toMatch(/grant\s+(?:all|insert|update|delete)[^;]+\bto\s+(?:public|anon|authenticated|service_role)\b/i);
    expect(sql).not.toMatch(/grant\s+execute[^;]+\bto\s+(?:public|anon|authenticated)\b/i);
    expect(sql.match(/enable row level security/g)).toHaveLength(3);
  });
  it("limits definers to three fixed-table write operations", () => {
    const expected = ["public.save_program_text_fact_review", "public.approve_program_text_fact_review", "public.publish_program_text_fact_batch"];
    expect(functions.filter(fn => option(fn, "security")?.Boolean.boolval).map(name)).toEqual(expected);
    expect(sql).not.toMatch(/\bexecute\s+(?:format|p_|v_)/i);
  });
  it("checks full source sets, retained text hashes, exact UTF16 slices and source ownership", () => {
    const validate = body(functions.find(fn => name(fn) === "private.awardping_program_fact_validation_valid"));
    for (const invariant of ["count(distinct value#>>'{reference,source,id}')", "extensions.digest(convert_to(v_doc->>'text','UTF8'),'sha256')",
      "private.awardping_program_block_valid", "private.awardping_program_utf16_slice", "public.stage1_award_members",
      "v_state->'baseline_ref' is distinct from v_state->'latest_ref'", "v_state->>'epoch' is distinct from v_review->>'epoch'",
      "v_source.shared_award_id::text", "'not_published','unresolved'", "v_roster is distinct from", "'source_role'",
      "(v_doc->>'blocks_json')::jsonb is distinct from v_doc->'blocks'",
      "extensions.digest(convert_to(v_doc->>'blocks_json','UTF8'),'sha256')", "v_ref->>'blocks_sha256'"]) {
      expect(validate).toContain(invariant);
    }
    expect(validate).toContain("count(distinct value->>'track')");
    expect(validate).toContain("v_supported_years");
    expect(validate).toContain("'reviewed_all_sources'");
    expect(validate).toContain("'{\"heading\":null,\"page\":null,\"kind\":null,\"context\":null}'::jsonb||v_block");
  });
  it("does not allow credentials or backslashes in an application URL authority", () => {
    const validate = body(functions.find(fn => name(fn) === "private.awardping_program_fact_validation_valid"));
    const expression = validate.match(/v_field->>'field'='application_url' and not coalesce\(v_item->>'value' ~ '([^']+)'/)[1];
    const re = new RegExp(expression.replaceAll("[:space:]", "\\s"));
    for (const value of ["https://user:pass@example.org", "https://user@example.org/path", "https://user\\name.example.org"]) expect(re.test(value)).toBe(false);
    for (const value of ["https://example.org", "https://example.org/apply?email=x@y.com", "https://example.org/#apply"]) expect(re.test(value)).toBe(true);
  });
  it("requires exact immutable originals without changing their optional block-key representation", () => {
    const validate = body(functions.find(fn => name(fn) === "private.awardping_program_fact_validation_valid"));
    expect(validate).toContain("array['reference','text','blocks','blocks_json']");
    expect(validate).toContain("jsonb_typeof(v_doc->'blocks_json') is distinct from 'string'");
    expect(validate).toContain("v_ref->>'blocks_sha256'");
  });
  it("keeps source readiness honest instead of relying only on status and counts", () => {
    const ready = body(functions.find(fn => name(fn) === "private.awardping_program_fact_source_ready"));
    for (const invariant of ["private.awardping_program_source_allowed", "private.awardping_program_text_reference_valid", "v_state->'baseline_ref'=v_ref",
      "'{source,id}'", "'{source,shared_award_id}'", "'{source,url}'", "'first_captured_at'", "'last_checked_at'", "between 2 and 2147483647", "exception when others then return false"]) expect(ready).toContain(invariant);
    const batch = body(functions.find(fn => name(fn) === "public.get_program_text_fact_review_batch"));
    expect(batch).toContain("'ready',private.awardping_program_fact_source_ready(s.id)");
  });
  it("approves each exact immutable draft separately and requires 25 for initial release", () => {
    expect(sql).toContain("v_row.content_hash is distinct from p_expected_hash");
    expect(sql).toContain("private.awardping_program_fact_validation_valid(v_row.validation,true)");
    expect(sql).toContain("jsonb_object_keys(p_review_ids))<>25");
    expect(sql).toContain("v_row.cohort_key<>v_registry.cohort_key");
    expect(sql).toContain("p_expected_revision is distinct from v_release.revision");
    expect(sql).toContain("'approved',p_id::text");
    expect(sql).toContain("'published',v_release.revision::text");
    expect(sql).not.toMatch(/update\s+public\.(?:shared_awards|stage1_award_registry|stage1_award_source_manifest|shared_award_visual_review_candidates)\b/i);
  });
  it("keeps no-change approval but marks program changes and roster corrections stale", () => {
    const current = body(functions.find(fn => name(fn) === "private.awardping_program_fact_review_current"));
    expect(current).toContain("'last_program_update_at'");
    expect(current).toContain("v_roster is distinct from");
    expect(current).not.toContain("text_sha256");
    expect(current).toContain("'baseline_ready'");
    expect(current).toContain("registry.canonical_shared_award_id::text=v_row.validation#>>'{review,award_id}'");
    expect(current).toContain("member.cohort_key=v_row.cohort_key");
  });
  it("uses explicit track-specific application-deadline labels in the shared public snapshot", () => {
    const values = body(functions.find(fn => name(fn) === "private.awardping_program_fact_public_values"));
    expect(values).toContain("when v_name='deadline' then 'Application deadline'");
  });
});
