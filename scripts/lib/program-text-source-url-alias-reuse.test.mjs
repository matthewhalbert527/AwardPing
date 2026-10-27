import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateProgramTextURLAliasBoundary } from "./program-text-source-approval.mjs";

const owner = "10000000-0000-4000-8000-000000000001", target = "20000000-0000-4000-8000-000000000001";
const source = { id: target, shared_award_id: owner, url: "https://example.org/rules/", create: false, expected_member_kind: "canonical" };
const proposal = { source, cohort_key: "example", expected_canonical_shared_award_id: owner };
const boundary = () => [1, 2].map(index => ({ source_id: `30000000-0000-4000-8000-00000000000${index}`, shared_award_id: owner,
  source_url: index === 1 ? "https://example.org/rules/#legacy" : "https://example.org/rules",
  memberships: [{ cohort_key: "example", member_kind: index === 1 ? "canonical" : "alias" }] }));
const sql = readFileSync(new URL("../../supabase/migrations/20261026234801_program_text_canonical_url_alias_reuse.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("explicit canonical source reuse across preserved same-cohort URL aliases", () => {
  it("exposes exact preserved IDs/owners/URLs/membership for review without mutating or choosing an alias", () => {
    const aliases = boundary(), before = structuredClone(aliases);
    expect(validateProgramTextURLAliasBoundary(aliases, proposal)).toBe(aliases);
    expect(aliases).toEqual(before);
  });
  it("keeps empty legacy receipts compatible but requires a canonical existing target for nonempty boundaries", () => {
    expect(validateProgramTextURLAliasBoundary(undefined, proposal)).toEqual([]);
    expect(validateProgramTextURLAliasBoundary([], { ...proposal, source: { ...source, create: true } })).toEqual([]);
    for (const patch of [{ create: true }, { expected_member_kind: "alias" }, { shared_award_id: target }]) {
      expect(() => validateProgramTextURLAliasBoundary(boundary(), { ...proposal, source: { ...source, ...patch } })).toThrow("canonical_url_alias_reuse_required");
    }
  });
  it.each([
    ["unregistered owner", row => { row.memberships = []; }],
    ["foreign cohort", row => { row.memberships[0].cohort_key = "another_award"; }],
    ["multiple memberships", row => { row.memberships.push({ cohort_key: "another_award", member_kind: "alias" }); }],
    ["wrong member kind", row => { row.memberships[0].member_kind = "unreviewed"; }],
    ["changed URL", row => { row.source_url = "https://example.org/different-rules"; }],
    ["target substituted for alias", row => { row.source_id = target; }],
    ["unexpected permission", row => { row.approved = true; }],
  ])("refuses a malformed review boundary: %s", (_name, mutate) => {
    const aliases = boundary(); mutate(aliases[0]);
    expect(() => validateProgramTextURLAliasBoundary(aliases, proposal)).toThrow("invalid_url_alias_boundary");
  });
  it("rejects duplicate or unordered alias IDs and never treats field order as authority", () => {
    const duplicate = boundary(); duplicate[1].source_id = duplicate[0].source_id;
    for (const aliases of [duplicate, boundary().reverse()]) expect(() => validateProgramTextURLAliasBoundary(aliases, proposal)).toThrow("invalid_url_alias_boundary");
    const aliases = boundary().map(row => Object.fromEntries(Object.entries(row).reverse()));
    expect(validateProgramTextURLAliasBoundary(aliases, proposal)).toEqual(boundary());
  });
  it("does not rewrite applied migrations and retains all legacy capture/source/publication safeguards", () => {
    expect(sql).toContain("create index shared_award_sources_program_text_url_alias_idx on public.shared_award_sources");
    expect(sql).toContain("((lower(regexp_replace(split_part(url,'#',1),'/+$',''))));");
    expect(sql).not.toContain("create unique index");
    expect(sql).not.toContain("create index concurrently");
    expect(sql).toContain("alter table public.program_text_source_pending_requests add column url_alias_boundary");
    expect(sql).toContain("alter table public.program_text_source_approvals add column url_alias_boundary");
    expect(sql).not.toMatch(/(?:update|delete from) public\.shared_award_sources/i);
    expect(sql).not.toMatch(/update public\.stage1_award_members|update public\.shared_awards/i);
    expect(sql).not.toContain("create trigger");
    expect(sql).toContain("'Pending text-only provider source; no capture, baseline, factual or legacy approval.','review_later'");
    expect(sql).toContain("Existing source identity or preserved history changed.");
    expect(sql).toContain("Approval identity was reused or revoked.");
    expect(sql).toContain("Source role changed; reload the exact current role.");
  });
  it("guards phantom inserts and membership changes only in a short NOWAIT section, with late authority recheck", () => {
    expect(sql).toContain("lock table public.shared_award_sources in share mode nowait;");
    expect(sql).toContain("lock table public.stage1_award_members in share mode nowait;");
    expect(sql).toContain("a.text_monitoring_state->'latest_ref'=authority");
    expect(sql).toContain("Provider authority advanced before the final locked identity check.");
    const prepare = sql.slice(sql.indexOf("create or replace function public.prepare_program_text_source("));
    expect(prepare.indexOf("private.awardping_program_source_pending_valid(p_validation)"))
      .toBeLessThan(prepare.indexOf("perform private.awardping_program_text_lock_alias_context(p_proposal)"));
    expect(prepare.indexOf("perform private.awardping_program_text_lock_alias_context(p_proposal)"))
      .toBeLessThan(prepare.indexOf("select * into s from public.shared_award_sources where id=source_id for update"));
  });
  it("binds alias-bearing proof hashes, rechecks the saved boundary before approval and invalidates stale independent authority", () => {
    expect(sql).toContain("'awardping.program-text-source-url-alias-proof.v1'");
    expect(sql).toContain("case when p_boundary='[]'::jsonb then p_validation::text");
    expect(sql).toContain("if alias_boundary is distinct from pending.url_alias_boundary");
    expect(sql).toContain("request.url_alias_boundary");
    expect(sql).toContain("a.source_url,a.url_alias_boundary");
    expect(sql).toContain("revoke all on function private.awardping_program_text_lock_alias_context(jsonb) from public,anon,authenticated,service_role;");
  });
});
