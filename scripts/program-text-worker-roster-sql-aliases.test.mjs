import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const oldPath = new URL("../supabase/migrations/20261026231042_program_text_worker_roster_pages.sql", import.meta.url);
const correctedPath = new URL("../supabase/migrations/20261026231511_program_text_worker_roster_explicit_columns.sql", import.meta.url);
const read = path => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const original = read(oldPath), corrected = read(correctedPath);
const body = sql => sql.slice(sql.indexOf("returns jsonb language plpgsql"), sql.indexOf("\nrevoke all on function public.get_program_text_worker_roster_page"));
const inner = "array(select value::uuid from jsonb_array_elements_text(role->'source_ids') value)";
const fixedInner = "array(select source_ids.source_id::uuid from jsonb_array_elements_text(role->'source_ids') as source_ids(source_id))";
const union = "select array_agg(distinct value::uuid order by value::uuid) into v_ids\n from jsonb_array_elements(v_roles) role cross join lateral jsonb_array_elements_text(role->'source_ids') value;";
const fixedUnion = "select array_agg(distinct source_ids.source_id::uuid order by source_ids.source_id::uuid) into v_ids\n from jsonb_array_elements(v_roles) as role_rows(role_entry)\n cross join lateral jsonb_array_elements_text(role_rows.role_entry->'source_ids') as source_ids(source_id);";

describe("worker roster PostgreSQL SRF output-column correction", () => {
  it("changes only the three source-ID expansion aliases in the already applied RPC", () => {
    expect(original.split(inner)).toHaveLength(3);
    expect(original.split(union)).toHaveLength(2);
    expect(body(corrected)).toBe(body(original).replaceAll(inner, fixedInner).replace(union, fixedUnion));
  });
  it("qualifies both SRF output columns when deduplicating mixed legacy, inventory and registration IDs", () => {
    expect(corrected).toContain(fixedUnion);
    expect(corrected).not.toContain("distinct value::uuid");
    expect(corrected.match(/as source_ids\(source_id\)/g)).toHaveLength(3);
    expect(corrected.split(fixedInner)).toHaveLength(3);
  });
  it("preserves the existing function identity, caller rights and bounded page contract", () => {
    expect(corrected).toContain("create or replace function public.get_program_text_worker_roster_page(");
    expect(corrected).toContain("p_kind text,p_after jsonb default null,p_expected_roster_seal text default null,p_limit integer default 100)");
    expect(corrected).toContain("returns jsonb language plpgsql stable security invoker set search_path=''");
    expect(corrected).toContain("p_limit not between 1 and 100");
    expect(corrected).toContain("Worker roster identity changed during enumeration.");
    expect(corrected).not.toContain("security definer");
    expect(corrected).not.toMatch(/\b(?:insert into|update public|delete from|drop function)\b/i);
    expect(corrected.slice(corrected.indexOf("\nrevoke all on function public.get_program_text_worker_roster_page")))
      .toBe(original.slice(original.indexOf("\nrevoke all on function public.get_program_text_worker_roster_page")));
  });
});
