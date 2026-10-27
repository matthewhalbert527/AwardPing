import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {parse} from 'libpg-query';
const sql=readFileSync(new URL('../supabase/migrations/20261026231418_program_variation_office_tracking.sql',import.meta.url),'utf8');
const legacy=readFileSync(new URL('../supabase/migrations/20260717011309_atomic_office_award_tracking.sql',import.meta.url),'utf8');
const track=sql.slice(sql.indexOf('create function public.track_office_program_variation_atomic('));
describe('additive atomic approved-variation office tracking',()=>{
 it('parses while leaving old functions, source approvals and scheduling untouched',async()=>{
  expect((await parse(sql)).stmts.length).toBeGreaterThan(7);
  expect(sql).not.toContain('create or replace function public.track_office_shared_award_atomic');
  expect(sql).not.toMatch(/(?:update|insert into|delete from) public\.(?:shared_award_sources|program_variation_|program_text_)/i);
  expect(sql).toContain('2be909383f89f8ef5e479b034b6f690c22a034fafc76957e09dd041e876ffcfd');
 });
 it('retains authenticated office roles, canonical identity, original release and member guards',()=>{
  for(const guard of ["v_actor_user_id uuid := (select auth.uid())", "member.office_id = p_office_id", "member.user_id = v_actor_user_id", "member.status = 'active'",
   "member.role in ('owner', 'admin')",'public.list_stage1_effective_publication()', 'v_registry.release_epoch is distinct from p_expected_release_epoch',
   'v_expected_member_ids is distinct from v_current_member_ids', "p_cadence is distinct from 'daily'", 'pg_advisory_xact_lock_shared','office-award-tracking:',
   'public.stage1_award_source_identity_rules identity_rule','private.consolidate_office_award_tracking'])expect(track).toContain(guard);
 });
 it('independently rechecks current exact25 release, inventory revision, approval hash and pinned source proof',()=>{
  for(const guard of ['jsonb_object_keys(release_row.approval_ids))<>25', 'private.awardping_variation_award_current(approval_row.id)', "'release_revision',release_row.revision",
   "'inventory_revision',inventory_row.revision", "'approval_hash',approval_row.content_hash", "cardinality(source_ids) not between 1 and 500", 'private.awardping_program_text_source_access',
   "source.admin_review_status in ('open','review_later')", 'source.url=binding', "source.shared_award_id::text=binding"])expect(sql).toContain(guard);
  expect(track).toContain('p_expected_variation_context is distinct from v_variation_context');
  expect(track).toContain("array['source_bindings',source.id::text,'url']");
  expect(track).not.toContain('stage1_award_source_manifest');
  expect(track).toContain('pg_catalog.jsonb_array_length(p_expected_source_bindings) > 500');
 });
 it('locks source rows then rechecks authority, preserves exact documents and fails on unsafe legacy aliases',()=>{
  const lock=track.indexOf('order by source.id for share;');const proof=track.indexOf('Approved variation source state changed before tracking.');
  const write=track.indexOf('insert into public.awards');expect(lock).toBeGreaterThan(0);expect(proof).toBeGreaterThan(lock);expect(write).toBeGreaterThan(proof);
  expect(track).toContain('existing_source.url<>selected_source.url');expect(track).toContain('existing_monitor.url<>selected_source.url');
  expect(track).toContain('Different exact document URLs require separate identity review.');
 });
 it('writes overview and source titles/types from approved pinned snapshots',()=>{
  expect(track).toContain("parent.validation#>>'{public_facts,overview}'");expect(track).not.toContain('ledger.public_value');
  expect(track).toContain("v_source.title:=coalesce(nullif(btrim(v_pinned_binding->>'title'),''),v_registry.canonical_name||' official source')");
  expect(track).toContain("v_source.page_type:=coalesce(v_pinned_binding->>'page_type','other')");
  expect(sql).toContain("parent.validation#>'{review,capture_refs}'");expect(sql).toContain("child.validation#>'{review,capture_refs}'");
 });
 it('retains legacy consolidation and monitor transition writes byte-for-byte after title pinning',()=>{
  const marker='    select source.id into v_source_row_id';const end='  return v_result;';
  const old=legacy.slice(legacy.indexOf('create or replace function public.track_office_shared_award_atomic('));
  expect(track.slice(track.indexOf(marker),track.indexOf(end))).toBe(old.slice(old.indexOf(marker),old.indexOf(end)));
 });
 it('keeps helper reads service-only and mutations authenticated with no exception-swallowing write path',()=>{
  expect(sql).toContain('grant execute on function public.get_program_variation_tracking_context(text,uuid) to service_role');
  expect(sql).toContain('grant execute on function public.track_office_program_variation_atomic(uuid,uuid,uuid[],uuid,jsonb,jsonb,text) to authenticated');
  expect(sql).toContain('from public,anon,authenticated,service_role');expect(track).not.toMatch(/exception when others/i);
  expect(track).not.toMatch(/\b(?:commit|rollback)\s*;/i);expect(track).toContain("set search_path = ''");
 });
});
