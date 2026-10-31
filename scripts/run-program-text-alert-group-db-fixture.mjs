#!/usr/bin/env node
// Runs only an in-memory PostgreSQL-WASM database, never a network database.
// Supply an already-installed local PGlite module; no dependency installation.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {programTextAlertGroupDbFixture,programTextAlertGroupFixtureSeed} from './lib/program-text-alert-group-db-fixture.mjs';

const modulePath=process.argv[2];
if(!modulePath || !/[/\\]node_modules[/\\]@electric-sql[/\\]pglite[/\\]dist[/\\]index\.js$/.test(modulePath))throw Error('Supply an absolute local PGlite module path.');
const {PGlite}=await import(pathToFileURL(modulePath).href);
const db=new PGlite();
const migration=readFileSync(new URL('../supabase/migrations/20261031231838_program_text_alert_groups.sql',import.meta.url),'utf8');
const actor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const id=i=>`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const source=i=>`20000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const query=async(sql,args=[])=>(await db.query(sql,args)).rows;
const one=async(sql,args=[])=>(await query(sql,args))[0];
const refs=async(ids)=>(await query('select id,content_hash from public.program_text_alert_reviews where id=any($1::uuid[]) order by id',[ids.map(id)]));
const save=async(ids,group=null,hash=null)=> (await one('select public.save_program_text_alert_group($1,$2,$3::jsonb,$4) result',[group,hash,JSON.stringify(await refs(ids)),actor])).result;
const decide=async(g,action='approve')=>(await one('select public.decide_program_text_alert_group($1,$2,$3,$4) result',[g.group_id,g.content_hash,action,actor])).result;
const approveOriginal=async(i)=>(await one('select public.decide_program_text_alert($1,$2,\'approve\',$3) result',[id(i),(await refs([i]))[0].content_hash,actor])).result;
const capture=async()=>await one(`select (select count(*)::int from public.shared_award_change_events) events,
 (select count(*)::int from public.shared_award_change_event_visual_evidence) evidence,
 (select count(*)::int from public.program_text_alert_group_revisions) revisions,
 (select jsonb_agg(to_jsonb(r) order by id) from public.program_text_alert_reviews r) reviews,
 (select jsonb_agg(to_jsonb(s) order by id) from public.shared_award_sources s) sources`);
async function rejects(fn,pattern){await db.exec('savepoint rejected_call');try{await assert.rejects(fn,pattern);}finally{await db.exec('rollback to rejected_call; release rejected_call');}}
const results=[];
async function test(name,fn){await db.exec('begin');try{await db.exec(programTextAlertGroupFixtureSeed());await fn();results.push({name,status:'passed'});}catch(e){results.push({name,status:'failed',error:e.message});throw e;}finally{await db.exec('rollback');}}
try{
 await db.exec(programTextAlertGroupDbFixture());
 await db.exec(migration);
 await test('pending + pending publishes originals and grouping atomically',async()=>{
  const g=await save([1,2]),a=await decide(g);assert.equal(a.status,'approved');
  const r=await capture();assert.equal(r.events,2);assert.equal(r.evidence,2);assert.equal(r.revisions,2);assert(r.reviews.slice(0,2).every(x=>x.status==='approved'));
  assert.equal((await decide(a)).already_reviewed,true);assert.equal((await capture()).events,2);
 });
 await test('all-approved grouping creates no events and returns public immutable revision',async()=>{
  await approveOriginal(1);await approveOriginal(2);const before=await capture();const g=await save([1,2]);const a=await decide(g);
  assert.equal((await capture()).events,before.events);
  const events=(await query('select id from public.shared_award_change_events')).map(x=>x.id);
  const result=(await one('select public.get_program_text_published_alert_groups($1::uuid[]) value',[events])).value;
  assert.equal(result.length,1);assert.equal(result[0].revision_id,a.revision_id);assert.equal(result[0].event_ids.length,2);assert(!JSON.stringify(result).includes(actor));
 });
 await test('pending + approved preserves original event and approval hashes',async()=>{
  await approveOriginal(1);const old=await one('select * from public.program_text_alert_reviews where id=$1',[id(1)]);
  const g=await save([1,2]);await decide(g);assert.deepEqual(await one('select * from public.program_text_alert_reviews where id=$1',[id(1)]),old);assert.equal((await capture()).events,2);
 });
 await test('same-page successive approved + pending comparisons remain independently supported',async()=>{
  await approveOriginal(1);
  await query(`update public.shared_award_visual_review_candidates set shared_award_source_id=$2::uuid,source_url='https://fixture.invalid/source-1',
   previous_snapshot_ref='{"capture":"current-1"}'::jsonb,prompt_payload=jsonb_set(prompt_payload,'{comparison,context,source_id}',to_jsonb(($2::uuid)::text)) where id=$1`,[id(2),source(1)]);
  await query(`update public.shared_award_sources set text_monitoring_state=text_monitoring_state||'{"latest_ref":{"capture":"current-2"},"status":"awaiting_review"}'::jsonb where id=$1`,[source(1)]);
  await query(`update public.program_text_alert_reviews r set content_hash=private.program_text_alert_hash(c,r.details,r.localization)
   from public.shared_award_visual_review_candidates c where c.id=r.id and r.id=$1`,[id(2)]);
  await decide(await save([1,2]));assert.equal((await capture()).events,2);
 });
 await test('second publisher failure rolls back first event, approval and baseline',async()=>{
  const g=await save([1,2]);await query('update public.shared_award_visual_review_candidates set prompt_payload=prompt_payload||\'{"fixture_fail":true}\'::jsonb where id=$1',[id(2)]);
  // Failure is introduced in the publisher, after both pre-validations pass.
  await db.exec(`create function private.fixture_second_publish_failure() returns trigger language plpgsql as $$begin if new.visual_review_candidate_id='${id(2)}'::uuid then raise exception 'Injected second event failure';end if;return new;end$$;
   create trigger fixture_second_publish_failure before insert on public.shared_award_change_events for each row execute function private.fixture_second_publish_failure();`);
  await query('update public.shared_award_visual_review_candidates set prompt_payload=prompt_payload-\'fixture_fail\' where id=$1',[id(2)]);
  const before=await capture();await rejects(()=>decide(g),/Injected second event failure/);assert.deepEqual(await capture(),before);
 });
 await test('stale head CAS, old member hash and duplicate membership reject',async()=>{
  const g=await save([1,2]),next=await save([1,2,3],g.group_id,g.content_hash);
  await rejects(()=>decide(g),/revision changed/);await rejects(()=>save([1,4]),/another group/);
  await rejects(()=>save([1,2,4],g.group_id,g.content_hash),/revision changed/);
  await rejects(async()=>one('select public.save_program_text_alert_group($1,$2,$3::jsonb,$4)',[next.group_id,next.content_hash,JSON.stringify([{id:id(1),content_hash:'0'.repeat(64)},...(await refs([2,3]))]),actor]),/retain every existing member|evidence or status changed/);
  await rejects(()=>save([1,2],next.group_id,next.content_hash),/retain every existing member/);
 });
 await test('nested original decision during publication cannot bypass a group or partially publish',async()=>{
  const g=await save([1,2]),hash=(await refs([2]))[0].content_hash;
  await db.exec(`create function private.fixture_nested_decision() returns trigger language plpgsql as $$begin
   perform public.decide_program_text_alert('${id(2)}','${hash}','approve','${actor}');return new;end$$;
   create trigger fixture_nested_decision before insert on public.shared_award_change_events for each row execute function private.fixture_nested_decision();`);
  const before=await capture();await rejects(()=>decide(g),/with its related group/);assert.deepEqual(await capture(),before);
 });
 await test('source retargeting, foreign award and stale comparison reject',async()=>{
  await query('update public.shared_award_sources set url=\'https://fixture.invalid/retarget\' where id=$1',[source(2)]);await rejects(()=>save([1,2]),/source, owner/);
  await query('update public.shared_award_sources set url=\'https://fixture.invalid/source-2\',shared_award_id=\'cccccccc-cccc-4ccc-8ccc-cccccccccccc\' where id=$1',[source(2)]);await rejects(()=>save([1,2]),/source, owner/);
  await query('update public.shared_award_sources set shared_award_id=\'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\',text_monitoring_state=jsonb_set(text_monitoring_state,\'{latest_ref}\',\'{"capture":"different"}\') where id=$1',[source(2)]);await rejects(()=>save([1,2]),/comparison is stale/);
 });
 await test('incompatible explicit cycles and distant detections reject',async()=>{
  await query('update public.shared_award_visual_review_candidates set prompt_payload=jsonb_set(prompt_payload,\'{comparison,context,cycle_id}\',to_jsonb($2::text)) where id=$1',[id(1),'2027']);
  await query('update public.shared_award_visual_review_candidates set prompt_payload=jsonb_set(prompt_payload,\'{comparison,context,cycle_id}\',to_jsonb($2::text)) where id=$1',[id(2),'2028']);await rejects(()=>save([1,2]),/Different application cycles/);
  await query('update public.shared_award_visual_review_candidates set prompt_payload=jsonb_set(prompt_payload,\'{comparison,context,cycle_id}\',\'null\'::jsonb),created_at=clock_timestamp()-interval \'31 days\' where id=$1',[id(2)]);await rejects(()=>save([1,2]),/within 30 days/);
 });
 await test('legacy single decisions cannot bypass grouped pending originals',async()=>{
  const g=await save([1,2]);await rejects(()=>approveOriginal(1),/with its related group/);assert.equal((await capture()).events,0);
  await decide(g,'undo');await approveOriginal(1);assert.equal((await capture()).events,1);
 });
 await test('undo unpublished draft retires metadata and leaves pending evidence intact',async()=>{
  const before=await capture(),g=await save([1,2]),a=await decide(g,'undo');assert.equal(a.status,'retired');
  const after=await capture();assert.deepEqual(after.reviews,before.reviews);assert.deepEqual(after.sources,before.sources);assert.equal(after.events,0);
  assert.equal((await one('select count(*)::int n from public.program_text_alert_group_members')).n,0);
  assert.equal((await one('select public.get_program_text_alert_groups($1::uuid[]) value',[[id(1),id(2)]])).value.length,0);
 });
 await test('undo appended draft restores published members and rejects undo of approved revision',async()=>{
  const initial=await decide(await save([1,2]));await rejects(()=>decide(initial,'undo'),/Only a draft/);
  const pending=await save([1,2,3],initial.group_id,initial.content_hash),undone=await decide(pending,'undo');assert.equal(undone.status,'undone');
  const members=await query('select review_id from public.program_text_alert_group_members order by review_id');assert.deepEqual(members.map(x=>x.review_id),[id(1),id(2)]);
  assert.equal((await one('select status from public.program_text_alert_reviews where id=$1',[id(3)])).status,'pending');
  const meta=(await one('select public.get_program_text_alert_groups($1::uuid[]) value',[[id(1)]])).value[0];assert.equal(meta.published.id,initial.revision_id);assert.equal(meta.head.operation,'undo');
 });
 await test('undo retains published base membership even when an original hash becomes stale',async()=>{
  const initial=await decide(await save([1,2])),pending=await save([1,2,3],initial.group_id,initial.content_hash);
  await query("update public.program_text_alert_reviews set content_hash=repeat('0',64) where id=$1",[id(1)]);
  await decide(pending,'undo');assert.deepEqual((await query('select review_id from public.program_text_alert_group_members order by review_id')).map(x=>x.review_id),[id(1),id(2)]);
 });
 await test('approved append adds only one original event and preserves earlier published revision',async()=>{
  const initial=await decide(await save([1,2])),before=await one('select * from public.program_text_alert_group_revisions where id=$1',[initial.revision_id]);
  const a=await decide(await save([1,2,3],initial.group_id,initial.content_hash));assert.equal((await capture()).events,3);
  assert.deepEqual(await one('select * from public.program_text_alert_group_revisions where id=$1',[initial.revision_id]),before);assert.equal(a.revision,4);
 });
 await test('metadata seeds are bounded, empty seeds are empty and public output has no actor',async()=>{
  const g=await save([1,2]);assert.equal((await one('select public.get_program_text_alert_groups($1::uuid[]) value',[[]])).value.length,0);
  await rejects(()=>one('select public.get_program_text_alert_groups($1::uuid[])',[Array(101).fill(id(1))]),/at most 100/);
  const meta=(await one('select public.get_program_text_alert_groups($1::uuid[]) value',[[id(1)]])).value;
  assert.deepEqual(meta[0].member_ids,[id(1),id(2)]);assert.equal(meta[0].head.id,g.revision_id);assert.equal(meta[0].published,null);
  const byGroup=(await one('select public.get_program_text_alert_groups($1::uuid[]) value',[[g.group_id]])).value;
  assert.deepEqual(byGroup,meta);
  assert(!JSON.stringify(meta).includes(actor));await decide(g);
 });
 await test('group hash is timezone independent and original approval tampering hides public group',async()=>{
  const approved=await decide(await save([1,2]));await db.exec("set local timezone='Asia/Tokyo'");
  const meta=(await one('select public.get_program_text_alert_groups($1::uuid[]) value',[[id(1)]])).value;
  const actual=(await one(`select private.program_text_alert_group_revision_hash(id,group_id,revision,operation,member_refs,event_refs,created_at,created_by) hash
   from public.program_text_alert_group_revisions where id=$1`,[approved.revision_id])).hash;
  assert.equal(actual,approved.content_hash);assert.equal(meta[0].published.content_hash,approved.content_hash);
  const events=(await query('select id from public.shared_award_change_events')).map(x=>x.id);
  await query("update public.program_text_alert_reviews set content_hash=repeat('0',64) where id=$1",[id(2)]);
  assert.deepEqual((await one('select public.get_program_text_published_alert_groups($1::uuid[]) value',[events])).value,[]);
 });
 await test('bounded exact input, role denials and immutable revision triggers',async()=>{
  await rejects(()=>save([1]),/2 to 8/);await rejects(()=>save([1,1]),/2 to 8|Duplicate/);await rejects(()=>save([1,2,3,4,5,6,7,8,9]),/2 to 8/);
  await rejects(async()=>one('select public.save_program_text_alert_group(null,null,$1::jsonb,$2)',[JSON.stringify([{id:id(1),content_hash:'0'.repeat(64),extra:true},...(await refs([2]))]),actor]),/Exact alert identities/);
  const g=await save([1,2]);await rejects(()=>query('update public.program_text_alert_group_revisions set member_refs=\'[]\' where id=$1',[g.revision_id]),/append-only/);
  await rejects(()=>db.exec('truncate public.program_text_alert_group_revisions cascade'),/append-only/);
  await rejects(async()=>{await db.exec('set local role authenticated');await save([3,4]);},/permission denied/);
  await rejects(async()=>{await db.exec('set local role service_role');await query('select * from public.program_text_alert_groups');},/permission denied/);
 });
 console.log(JSON.stringify({schema:'awardping.alert-group-local-postgres.v1',database:'in-memory-pglite',production_database_calls:0,tests:results},null,2));
}catch(error){console.error(JSON.stringify({schema:'awardping.alert-group-local-postgres.v1',tests:results,error:error.message,code:error.code},null,2));process.exitCode=1;}
finally{await db.close();}
