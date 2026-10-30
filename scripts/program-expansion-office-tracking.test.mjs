import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {parse} from "libpg-query";
import {buildProgramExpansionTrackingRollbackFixture} from "./lib/program-expansion-tracking-rollback-fixture.mjs";
const sql=readFileSync(new URL("../supabase/migrations/20261030170030_program_award_expansion_office_tracking.sql",import.meta.url),"utf8");
describe("additive expansion office tracking",()=>{
 it("parses explicit additive functions without replacing legacy tracking",async()=>{
  expect((await parse(sql)).stmts).toHaveLength(12);
  expect(sql).not.toMatch(/create or replace|alter table|drop function/i);
  expect(sql).toContain("cca3c48c9e3f101e4ef70ba8800872fa37d79144deda0f028a627aadf489d5a8");
 });
 it("requires real user and current active office management before row writes",()=>{
  expect(sql.match(/v_actor_user_id uuid:=\(select auth.uid\(\)\)/)).toBeTruthy();
  expect(sql).toContain("m.status='active' and m.role in ('owner','admin') for share");
  expect(sql).toContain("a.status='active'");
  expect(sql).toContain("e.active and e.epoch=p_expected_epoch for share");
  expect(sql).toContain("private.program_award_expansion_source_proof(s.id) is not null");
  expect(sql).toContain("private.awardping_program_source_allowed(s.id)");
 });
 it("binds exact selected subset, metadata and owner without inventing a legacy release epoch",()=>{
  expect(sql).toContain("not v_selected_source_ids<@v_admission.source_ids");
  expect(sql).toContain("v_database_source_bindings is distinct from p_expected_source_bindings");
  expect(sql).toContain("s.shared_award_id=r.canonical_shared_award_id");
  expect(sql).not.toContain("v_registry.release_epoch");
  expect(sql).not.toContain("admin_review_status = 'open'");
 });
 it("allows pending real changes while omitting unsupported local summary",()=>{
  const authority=sql.slice(sql.indexOf("create function private.program_award_expansion_follow_source"),sql.indexOf("revoke all on function private.program_award_expansion_follow_source"));
  expect(authority).not.toMatch(/baseline_ready|successful_checks|basic_fact_current/);
  expect(sql).toContain("when private.awardping_basic_fact_current(s.id) then s.public_facts->>'overview' else null");
 });
 it("preserves own-office history and allows inactive/revoked source removal",()=>{
  const untrack=sql.slice(sql.indexOf("create function public.untrack_office_program_expansion_atomic"));
  expect(untrack).not.toMatch(/a\.status='active'|program_award_expansion_follow_source|basic_fact_current/);
  expect(untrack).toContain("x.office_id=p_office_id and x.shared_award_id=owner_id");
  expect(untrack).toContain("m.shared_award_source_id=p_source_id");
  expect(untrack).toContain("'preserved',true");
  expect(untrack).not.toMatch(/delete from/);
 });
 it("restricts context to service reads and mutations to authenticated users",()=>{
  expect(sql).toContain("grant execute on function public.get_program_award_expansion_tracking_context(uuid) to service_role");
  expect(sql).toContain("grant execute on function public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text) to authenticated");
  expect(sql).toContain("grant execute on function public.untrack_office_program_expansion_atomic(uuid,text,uuid,uuid,uuid) to authenticated");
 });
 it("authors a parseable unconditional rollback with real-owner authenticated cases",async()=>{
  const fixture=buildProgramExpansionTrackingRollbackFixture(sql);
  expect((await parse(fixture)).stmts.length).toBeGreaterThan(12);
  expect(fixture.trim()).toMatch(/^begin;[\s\S]*rollback;$/);
  expect(fixture).toContain("set local role authenticated");
  expect(fixture).toContain("Pending programme change blocked safe follow");
  expect(fixture).toContain("Original25 identity or tracking functions changed");
  expect(fixture).not.toContain("insert into auth.users");
 });
});
