import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "libpg-query";

const before = readFileSync(new URL("../supabase/migrations/20261030154351_replace_unadmitted_aauw_with_cooke.sql", import.meta.url), "utf8");
const sql = readFileSync(new URL("../supabase/migrations/20261030161527_replace_unadmitted_cooke_with_daad_study.sql", import.meta.url), "utf8");
const original = readFileSync(new URL("../supabase/migrations/20261030151153_program_award_expansion_registry.sql", import.meta.url), "utf8");
const candidates = text => JSON.parse(text.match(/\$candidates\$([\s\S]*?)\$candidates\$/)[1]);
const form = JSON.parse(sql.match(/\$observed\$([\s\S]*?)\$observed\$/)[1]);
const target = "https://www.daad.org/en/find-funding/scholarship-database/?origin=44&status=3&type=a&q=&onlydaad=1&language=en&detail_to_show=50026200&tab=";

describe("reviewed DAAD USA graduate GET-form admission", () => {
  it("parses an explicit candidate and bounded admission replacement", async () => {
    expect((await parse(sql)).stmts).toHaveLength(5);
    expect(sql).toContain("1a3036cdbb77813ceb88d68eed65b8b99acc0dd1d3c1fe6492193c331a589ecd");
    expect(sql).toContain("5939fcf9a1557fe3d805b258db6ba342b4dac94ac598e44cd5967cc5214aedc9");
    expect(sql).toContain("cohort_key in ('cooke_transfer','clarendon','daad_study') or launch_rank=33");
  });
  it("preserves the other nine reviewed identities and all admitted first-batch URLs", () => {
    const after = candidates(sql);
    expect(after).toHaveLength(10);
    for (const previous of candidates(before).filter(c => c.cohort_key !== "cooke_transfer")) {
      expect(after.find(c => c.cohort_key === previous.cohort_key)).toEqual(previous);
    }
    expect(after.some(c => ["cooke_transfer", "clarendon", "aauw_international"].includes(c.cohort_key))).toBe(false);
    const daad = after.find(c => c.cohort_key === "daad_study");
    expect(daad.canonical_shared_award_id).toBe("440d6985-ece9-48c4-ac30-65a739f60d65");
    expect(daad.canonical_name).toBe("DAAD Study Scholarships");
    expect(daad.source_urls).toHaveLength(3);
    expect(daad.source_urls.some(u => u.includes('/faq/'))).toBe(false);
    expect(daad.source_urls).toContain(target);
    expect(after.filter(c => c.batch === 1).reduce((n, c) => n + c.source_urls.length, 0)).toBe(17);
    expect(after.filter(c => c.batch === 2).reduce((n, c) => n + c.source_urls.length, 0)).toBe(18);
  });
  it("pins one observed GET form and its full ordered public filter controls", () => {
    expect(form).toMatchObject({schema: "awardping.program-award-expansion-get-form.v1", selector: "#applicationreq form", method: "get", action: null,
      selected_scope: {origin: "44", origin_label: "USA", status: "3", status_label: "Graduates"},
      authority_capture_id: "0a1e31d365c34d5acbeb77118251d099b2c1d72a0adb7e528be37071e42a7825",
      authority_raw_sha256: "9598035df554a4e41428d2a1582e3fb5368fcd0268d1433b38c5589f7cabddb9"});
    const serialized = new URL(form.action_url);
    serialized.search = new URLSearchParams(form.controls.map(c => [c.name, c.value])).toString();
    expect(serialized.href).toBe(target);
    expect(sql).toContain("p_cohort='daad_study' and p_source='" + target + "'");
    expect(sql).toContain("and p_proof=$observed$");
    expect(sql).toContain("revoke all on function private.program_award_expansion_get_form_authority(text,text,text,jsonb) from public,anon,authenticated,service_role");
  });
  it("requires typed form proof instead of accepting an invented literal href", () => {
    expect(sql).toContain("and not (q ? 'authority_form')");
    expect(sql).toContain("q->>'authority_href' is distinct from ''");
    expect(sql).toContain("The observed form must belong to an included official source.");
    expect(sql).toContain("private.awardping_basic_href(q->>'authority_href',q->>'authority_url') is distinct from q->>'url'");
  });
  it("keeps replay, atomic validation, source collision and silent first coverage behavior unchanged", () => {
    const oldBody = original.match(/create function public\.admit_program_award_expansion_batch[\s\S]*?end;\$\$;/)[0];
    const newBody = sql.match(/create or replace function public\.admit_program_award_expansion_batch[\s\S]*?end;\$\$;/)[0];
    for (const marker of ["declare e uuid", " -- Validate all five plans", "   perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner.id", " for w in select value from jsonb_array_elements(p_awards) order by value->>'cohort_key' loop\n  c:=private.program_award_expansion_candidate(w->>'cohort_key');ids:="]) {
      expect(newBody).toContain(marker);
    }
    expect(newBody.slice(newBody.indexOf("   perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner.id"))).toBe(oldBody.slice(oldBody.indexOf("   perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner.id")));
    expect(newBody.slice(newBody.indexOf("declare e uuid"), newBody.indexOf("  for q in select value"))).toBe(oldBody.slice(oldBody.indexOf("declare e uuid"), oldBody.indexOf("  for q in select value")));
    expect(sql).not.toMatch(/\b(?:drop|truncate)\b/i);
  });
});
