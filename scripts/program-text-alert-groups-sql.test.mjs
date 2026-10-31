import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {parse} from 'libpg-query';
import {programTextAlertGroupDbFixture,programTextAlertGroupFixtureSeed} from './lib/program-text-alert-group-db-fixture.mjs';

const migration=readFileSync(new URL('../supabase/migrations/20261031231838_program_text_alert_groups.sql',import.meta.url),'utf8');
const name=value=>value.map(x=>x.String.sval).join('.');
const ast=await parse(migration);
const functions=ast.stmts.filter(x=>x.stmt.CreateFunctionStmt).map(x=>x.stmt.CreateFunctionStmt);
const definition=key=>functions.find(x=>name(x.funcname)===key);
const body=key=>definition(key).options.find(x=>x.DefElem.defname==='as').DefElem.arg.List.items[0].String.sval;
const publicNames=['public.save_program_text_alert_group','public.decide_program_text_alert_group','public.get_program_text_alert_groups',
 'public.get_program_text_published_alert_groups','public.decide_program_text_alert'];

describe('append-only related text alerts SQL contract',()=>{
 it('creates only the three grouping tables and changes no existing evidence or delivery table',()=>{
  expect(ast.stmts.filter(x=>x.stmt.CreateStmt).map(x=>x.stmt.CreateStmt.relation.relname)).toEqual([
   'program_text_alert_groups','program_text_alert_group_revisions','program_text_alert_group_members']);
  expect(migration).not.toMatch(/\b(?:update|insert\s+into|delete\s+from|alter\s+table|truncate)\s+(?:public\.)?(?:shared_award_change_events|shared_award_change_event_visual_evidence|public_digest_outbox|public_digest_event_receipts|program_basic_fact_snapshots)\b/i);
 });
 it('keeps every public entry point service-only and every new table behind RLS with no client grants',()=>{
  for(const key of publicNames){const fn=definition(key);expect(fn).toBeDefined();
   const security=fn.options.find(x=>x.DefElem.defname==='security').DefElem.arg.Boolean.boolval;
   const setting=fn.options.find(x=>x.DefElem.defname==='set').DefElem.arg.VariableSetStmt;
   expect(security).toBe(true);expect(setting.name).toBe('search_path');expect(setting.args[0].A_Const.sval.sval).toBe('');
  }
  const grants=ast.stmts.filter(x=>x.stmt.GrantStmt?.is_grant).map(x=>x.stmt.GrantStmt);
  expect(grants).toHaveLength(1);expect(grants[0].objtype).toBe('OBJECT_FUNCTION');
  expect(grants[0].objects.map(x=>name(x.ObjectWithArgs.objname)).sort()).toEqual(publicNames.slice().sort());
  expect(grants[0].grantees.map(x=>x.RoleSpec.rolename)).toEqual(['service_role']);
  expect((migration.match(/enable row level security/gi)||[])).toHaveLength(3);
 });
 it('pins the production decision and all three unchanged evidence helpers before and after',()=>{
  for(const hash of ['f6a71a7ee0ee67ecbd6277bb703f885dbdce0f9bfe26ceaf141599a42e48e6e1',
   '55328ee49c607d7065bdab98d821569d4d825e30c88b28842621470f4510225e',
   'bdb5450a4c07b93bb614f51460419b08e974bcf0d6fcca10be190f2733a28fc0',
   'e86fb4d7b5bd764f607d9664b81789724f4e3f3573dcb70e663578a1f1ed6549']){
   expect(migration.split(hash)).toHaveLength(3);
  }
  expect(migration).toContain("'FUNCTION public.decide_program_text_alert(', 'FUNCTION private.decide_program_text_alert_ungrouped('");
  expect(functions.some(x=>name(x.funcname)==='private.decide_program_text_alert_ungrouped')).toBe(false);
 });
 it('hashes immutable member/event identity with timezone-independent timestamp and forbids revision rewrites',()=>{
  const text=body('private.program_text_alert_group_revision_hash');
  for(const key of ["'id'","'group_id'","'revision'","'operation'","'member_refs'","'event_refs'","'created_by'"])expect(text).toContain(key);
  expect(text).toContain('extract(epoch from p_created)');
  const triggers=ast.stmts.filter(x=>x.stmt.CreateTrigStmt).map(x=>x.stmt.CreateTrigStmt);
  expect(triggers).toHaveLength(2);expect(triggers.every(x=>x.relation.relname==='program_text_alert_group_revisions')).toBe(true);
  expect(body('private.program_text_alert_group_freeze')).toContain("errcode='55000'");
 });
 it('requires exact 2–8 member identities, distinct UUIDs and current saved hashes',()=>{
  const normalize=body('private.program_text_alert_group_normalize'),validate=body('private.program_text_alert_group_validate');
  expect(normalize).toContain('n not between 2 and 8');expect(normalize).toContain('count(distinct value');expect(normalize).toContain('jsonb_object_keys(x))<>2');
  expect(validate).toContain('r.content_hash is distinct from private.program_text_alert_hash(c,r.details,r.localization)');
  expect(validate).toContain('s.shared_award_id is distinct from a');expect(validate).toContain('s.url is distinct from c.source_url');
  expect(validate).toContain('private.awardping_program_source_allowed(s.id)');
  expect(validate).toContain("Different application cycles cannot be grouped");expect(validate).toContain("interval '30 days'");
 });
 it('uses original current comparison validation before approval and full public evidence after approval',()=>{
  const validate=body('private.program_text_alert_group_validate');
  expect(validate).toContain("s.text_monitoring_state->'baseline_ref' is distinct from c.previous_snapshot_ref");
  expect(validate).toContain("s.text_monitoring_state->'latest_ref' is distinct from c.new_snapshot_ref");
  expect(validate).toContain('public.awardping_validate_program_text_evidence(e,to_jsonb(c),r.details)');
  expect(validate).toContain('private.public_digest_reviewed_text_source_current(r.event_id)');
 });
 it('takes the shared publication lock before row locks and performs every original approval in one RPC body',()=>{
  for(const fn of ['public.save_program_text_alert_group','public.decide_program_text_alert_group','public.decide_program_text_alert']){
   const text=body(fn);expect(text.indexOf("hashtextextended('stage1-national-25-release',0)")).toBeGreaterThan(0);
   if(text.includes('for update'))expect(text.indexOf("hashtextextended('stage1-national-25-release',0)")).toBeLessThan(text.indexOf('for update'));
  }
  const decision=body('public.decide_program_text_alert_group');
  expect(decision).toContain('private.decide_program_text_alert_ungrouped(');
  expect(decision.replace(/--[^\n]*/g,'')).not.toMatch(/\bexception\s+when\b|\bcommit\b|\brollback\b/i);
  expect(decision.split('perform private.program_text_alert_group_validate(')).toHaveLength(3);
  expect(decision).toContain("private.program_text_alert_group_append(g.id,'approved',h.member_refs,events,p_actor)");
 });
 it('CAS checks both draft mutation and decisions, preserves base membership and blocks old-client bypass',()=>{
  for(const fn of ['public.save_program_text_alert_group','public.decide_program_text_alert_group']){
   expect(body(fn)).toContain('h.content_hash is distinct from p_expected_hash');expect(body(fn)).toContain('private.program_text_alert_group_revision_hash(h.id,');
  }
  expect(body('public.save_program_text_alert_group')).toContain('An append must retain every existing member');
  expect(body('public.save_program_text_alert_group')).toContain('An alert already belongs to another group');
  expect(body('public.decide_program_text_alert')).toContain("r.status='pending'");
  expect(body('public.decide_program_text_alert')).toContain('Review this alert with its related group');
 });
 it('undo is draft-only and changes only grouping metadata, retaining old approved revision',()=>{
  const text=body('public.decide_program_text_alert_group'),undo=text.slice(text.indexOf("if p_action='undo' then"),text.indexOf('perform 1 from public.shared_award_visual_review_candidates'));
  expect(text.indexOf("h.operation is distinct from 'draft'")).toBeLessThan(text.indexOf("if p_action='undo' then"));
  expect(undo).toContain("private.program_text_alert_group_append(g.id,'undo',published.member_refs,null,p_actor)");
  expect(undo).toContain('set retired=true');expect(undo).not.toMatch(/update\s+public\.(?:program_text_alert_reviews|shared_award_sources|shared_award_visual_review_candidates)/i);
  expect(undo).toContain("where(x.value->>'id')::uuid=m.review_id");expect(undo).not.toContain('select a.content_hash');
  expect(body('public.get_program_text_alert_groups')).toContain('g.id=any(p_review_ids)');
 });
 it('public metadata requires approved immutable original event/hash bindings and exposes no actor',()=>{
  const text=body('public.get_program_text_published_alert_groups');
  for(const key of ["'group_id'","'revision_id'","'content_hash'","'shared_award_id'","'event_ids'","'member_refs'","'event_refs'","'created_at'"])expect(text).toContain(key);
  expect(text).toContain("r.operation='approved'");expect(text).toContain('a.content_hash is distinct from x.value');
  expect(text).toContain('a.event_id is distinct from');expect(text).toContain('private.public_digest_reviewed_text_source_current(');
  expect(text).not.toMatch(/jsonb_build_object\([^;]*'created_by'/);expect(text).not.toContain("'actor'");
 });
 it('local native SQL fixture copies real decision/publisher gates and confines its test doubles to the fixture',async()=>{
  const fixture=programTextAlertGroupDbFixture(),seed=programTextAlertGroupFixtureSeed();
  expect((await parse(fixture)).stmts.length).toBeGreaterThan(20);expect((await parse(seed)).stmts.length).toBe(8);
  for(const name of ['private.publish_reviewed_program_text_event','private.program_text_alert_hash','public.decide_program_text_alert','private.public_digest_reviewed_text_source_current'])expect(fixture).toContain(`FUNCTION ${name}`.toLowerCase().split(' ')[1]);
  expect(fixture).toContain('Fixture evidence rejected');expect(migration).not.toContain('fixture_fail');expect(seed).toContain('https://fixture.invalid/');
 });
});
