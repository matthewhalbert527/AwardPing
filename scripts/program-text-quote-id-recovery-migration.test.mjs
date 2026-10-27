import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {parse} from 'libpg-query';
const sql=readFileSync(new URL('../supabase/migrations/20261027003046_program_text_quote_id_recovery.sql',import.meta.url),'utf8');
const approve=sql.slice(sql.indexOf('create function public.approve_program_text_quote_id_recovery('));
describe('one-candidate administrator quotation-ID recovery schema',()=>{
 it('parses as additive schema without replacing any worker, provider or quote-validation function',async()=>{
  expect((await parse(sql)).stmts.length).toBeGreaterThan(20);expect(sql).not.toMatch(/create or replace function/i);
  expect(sql).not.toMatch(/(?:update|insert into|delete from) public\.(?:shared_award_sources|source_change_events|program_fact|program_variation|ai_|office_)/i);
  expect(sql).not.toMatch(/\b(?:commit|rollback)\s*;/i);
 });
 it('pins the finite row, source, award, exact original response and sole held reason',()=>{
  for(const value of ['8d40add5-89ea-4f96-9c31-f1f68c1fa472','d4509d97-da9b-4e12-bbe9-45129e6ce1c1','d955a846-cee1-4c01-932e-e3cb7215f3fb',
   'f2685822df09e002dc13da27189d6cb2ad7dc6583a84301cecfe7f9c36b6edaf','manual_review_required:quote_not_bound_to_changed_block',
   "p_candidate->>'status' is distinct from 'failed'", "'[\"quote_not_bound_to_changed_block\"]'::jsonb"])expect(sql).toContain(value);
 });
 it('derives only two IDs from the actual previous/current source blocks with exact unique UTF16 proof',()=>{
  for(const value of ["foreach side in array array['previous','current']", "quote->>'block_id' is distinct from changed->>'id'", 'private.awardping_program_block_valid(source_block,full_text) is distinct from true',
   "source_block->>'id'=changed->>'id'",'quote_at<1',"strpos(substr(source_block->>'text',quote_at+1),quote->>'text')>0",
   'private.awardping_program_utf16_slice(full_text,start_utf16,end_utf16)',"array['0','blocks','0','changes','0',side||'_quote','block_id']"])expect(sql).toContain(value);
 });
 it('binds exact current source pair, owned roster, exclusions, source authority and current epoch',()=>{
  for(const value of ["text_monitoring_state->'baseline_ref' is distinct from p_candidate->'previous_snapshot_ref'", "text_monitoring_state->'latest_ref' is distinct from p_candidate->'new_snapshot_ref'",
   'private.awardping_program_text_source_access', 'private.awardping_program_source_allowed','stage1_award_registry','stage1_award_members','program_text_source_roster',
   'stage1_award_source_identity_rules','program_text_source_authority_epochs',"'{prompt_payload,program_identity}'"])expect(sql).toContain(value);
 });
 it('locks, rechecks both PG hashes, journals the full failure and uses whole-row CAS before resuming',()=>{
  const journal=approve.indexOf('insert into public.program_text_quote_id_recovery_journal'),update=approve.indexOf('update public.shared_award_visual_review_candidates');
  expect(approve.indexOf('for update nowait')).toBeLessThan(approve.indexOf('inspection:=public.inspect_program_text_quote_id_recovery'));
  expect(journal).toBeGreaterThan(0);expect(update).toBeGreaterThan(journal);expect(approve).toContain('to_jsonb(shared_award_visual_review_candidates)=snapshot');
  expect(approve).toContain("status='succeeded'");expect(approve).toContain('changed_count<>1');expect(approve).toContain("'stage1-national-25-release'");
  expect(approve).not.toMatch(/\b(?:batch_job_name|model_name|completed_at|prompt_payload|previous_snapshot_ref|new_snapshot_ref)\s*=/);
 });
 it('keeps immutable full failure history and returns identical replays as history only',()=>{
  for(const value of ['failed_candidate jsonb not null','original_responses jsonb not null','source_identity_proof jsonb not null','before update or delete','before truncate',
   'prior.preimage_hash is distinct from p_preimage_hash','prior.projection_hash is distinct from p_projection_hash','prior.reason is distinct from p_reason',"'historical_receipt'"])expect(sql).toContain(value);
 });
 it('uses an explicit service-only server boundary and no public table write privileges',()=>{
  expect(sql).toContain('revoke all on public.program_text_quote_id_recovery_journal from public,anon,authenticated,service_role');
  expect(sql).toContain('grant select on public.program_text_quote_id_recovery_journal to service_role');
  for(const name of ['inspect_program_text_quote_id_recovery(uuid)','approve_program_text_quote_id_recovery(uuid,text,text,text,uuid)']){
   expect(sql).toContain(`revoke all on function public.${name} from public,anon,authenticated`);expect(sql).toContain(`grant execute on function public.${name} to service_role`);
  }
  expect(approve).toContain("security definer set search_path=''");expect(approve).toContain('not exists(select 1 from auth.users actor where actor.id=p_actor)');
 });
});
