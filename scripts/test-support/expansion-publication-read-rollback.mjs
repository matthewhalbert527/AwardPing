import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
const check=(ok,message)=>{if(!ok)throw Error('Expansion read rehearsal: '+message);};
/** Pure builder. No connection, publication or source mutation; root executes
 * the generated SQL once in a repeatable-read transaction ending in ROLLBACK. */
export function expansionPublicationReadRollback({migration,previousDefinition}={}) {
 check(typeof migration==='string'&&migration.includes('$expansion_read_preimage$')&&migration.includes('basic_snapshot as materialized')&&
  !/\b(?:begin|commit|rollback)\s*;/i.test(migration.replace(/--[^\n]*/g,'')),'reviewed transaction-free migration required');
 check(typeof previousDefinition==='string'&&sha(previousDefinition)==='ff775c8b627d5fc503aa5f1e2d8f3952673680fcd90d00dd2930ca7921192e8d','exact actual previous definition required');
 const old=previousDefinition.replace('public.get_program_award_expansion_publication(','pg_temp.expansion_publication_before(');
 check(old!==previousDefinition&&!/\$expansion_read_rehearsal\$/.test(migration),'exact temporary original and safe delimiter');
 const state=`jsonb_build_object('heads',(select jsonb_agg(to_jsonb(h) order by cohort_key) from public.program_basic_fact_heads h),
 'registry',(select jsonb_agg(to_jsonb(r) order by cohort_key) from public.program_award_registry r),
 'members',(select jsonb_agg(to_jsonb(m) order by shared_award_id) from public.program_award_members m),
 'roster',(select jsonb_agg(to_jsonb(r) order by cohort_key,source_role) from public.program_text_source_roster r),
 'sources',(select jsonb_agg(jsonb_build_object('id',s.id,'sha256',encode(extensions.digest(convert_to(to_jsonb(s)::text,'UTF8'),'sha256'),'hex')) order by s.id)
  from public.shared_award_sources s where s.id in(select distinct unnest(source_ids) from public.program_text_source_roster)),
 'snapshots',(select count(*) from public.program_basic_fact_snapshots),'reviews',(select count(*) from public.program_text_alert_reviews),
 'events',(select count(*) from public.shared_award_change_events),'candidates',(select count(*) from public.shared_award_visual_review_candidates),
 'outbox',(select count(*) from public.public_digest_outbox))`;
 return `begin isolation level repeatable read;
set local statement_timeout='120s';
set local lock_timeout='2s';
create temporary table expansion_read_rehearsal_report(document jsonb) on commit drop;
create temporary table expansion_read_before_state on commit drop as select ${state} document;
do $expansion_read_initial_bounds$
begin
 if (select count(*) from public.program_award_registry)<>45 or (select count(*) from public.program_basic_fact_heads)<>45
  or (select count(*) from public.program_award_expansion_admissions where status='active')<>20
  or (select count(distinct id) from public.program_text_source_roster cross join lateral unnest(source_ids) id)>1000
 then raise exception 'The frozen45-award source/head scope changed';end if;
end;$expansion_read_initial_bounds$;
${old.trimEnd()};
revoke all on function pg_temp.expansion_publication_before(uuid) from public,anon,authenticated,service_role;
create temporary table expansion_read_before_outputs on commit drop as select
 (select epoch from public.program_text_source_authority_epochs where active) epoch,
 pg_temp.expansion_publication_before((select epoch from public.program_text_source_authority_epochs where active)) publication,
 public.get_program_basic_facts(array(select canonical_shared_award_id from public.program_award_registry order by launch_rank)) basics,
 public.get_program_text_public_alert_source_bindings((select epoch from public.program_text_source_authority_epochs where active)) bindings;
${migration}
do $expansion_read_rehearsal$
declare prior record;next_result jsonb;before_error text;after_error text;input_epoch uuid;scope_checks integer:=0;signature text;
begin
 select * into strict prior from expansion_read_before_outputs;
 next_result:=public.get_program_award_expansion_publication(prior.epoch);
 if next_result is distinct from prior.publication then raise exception 'Exact45-award expansion JSON changed';end if;scope_checks:=scope_checks+1;
 if public.get_program_basic_facts(array(select canonical_shared_award_id from public.program_award_registry order by launch_rank)) is distinct from prior.basics
  or public.get_program_text_public_alert_source_bindings(prior.epoch) is distinct from prior.bindings
 then raise exception 'Unchanged currentness or source-authority output changed';end if;scope_checks:=scope_checks+1;
 foreach input_epoch in array array[null::uuid,'00000000-0000-0000-0000-000000000000'::uuid] loop
  before_error:=null;after_error:=null;
  begin perform pg_temp.expansion_publication_before(input_epoch);exception when others then before_error:=sqlstate||':'||sqlerrm;end;
  begin perform public.get_program_award_expansion_publication(input_epoch);exception when others then after_error:=sqlstate||':'||sqlerrm;end;
  if before_error is null or before_error is distinct from after_error then raise exception 'Invalid-epoch behavior changed';end if;scope_checks:=scope_checks+1;
 end loop;
 foreach signature in array array['public.get_program_award_expansion_publication(uuid)','public.get_program_basic_facts(uuid[])',
  'public.get_program_text_public_alert_source_bindings(uuid)','public.get_stage1_publication_snapshot()'] loop
  if has_function_privilege('anon',signature,'EXECUTE') or has_function_privilege('authenticated',signature,'EXECUTE')
   or not has_function_privilege('service_role',signature,'EXECUTE') then raise exception 'Private service-only read privilege changed: %',signature;end if;
 end loop;scope_checks:=scope_checks+1;
 if ${state} is distinct from (select document from expansion_read_before_state)
 then raise exception 'A head, source, registry, ledger, review, event or delivery queue changed';end if;scope_checks:=scope_checks+1;
 insert into expansion_read_rehearsal_report values(jsonb_build_object('schema','awardping.expansion-read-rehearsal.v1','status','PASS',
  'checked_at',clock_timestamp(),'checks',scope_checks,'frozen_heads',45,'expansion_awards',jsonb_array_length(next_result->'awards'),
  'publication_equal',true,'basic_facts_equal',true,'source_bindings_equal',true,'permanent_state_unchanged',true,'permanent_data_writes',0,
  'publication_sha256',encode(extensions.digest(convert_to(next_result::text,'UTF8'),'sha256'),'hex'),
  'basic_facts_sha256',encode(extensions.digest(convert_to(prior.basics::text,'UTF8'),'sha256'),'hex'),
  'source_bindings_sha256',encode(extensions.digest(convert_to(prior.bindings::text,'UTF8'),'sha256'),'hex')));
 raise notice 'Expansion read equivalence PASS: % checks; exact20 expansion awards,45 frozen heads; no permanent data writes',scope_checks;
end;$expansion_read_rehearsal$;
set local role anon;
do $expansion_read_anon_denial$ begin
 begin perform public.get_program_award_expansion_publication(null::uuid);raise exception 'Anonymous expansion execution unexpectedly allowed';exception when insufficient_privilege then null;end;
end;$expansion_read_anon_denial$;
reset role;
set local role authenticated;
do $expansion_read_authenticated_denial$ begin
 begin perform public.get_program_award_expansion_publication(null::uuid);raise exception 'Authenticated expansion execution unexpectedly allowed';exception when insufficient_privilege then null;end;
end;$expansion_read_authenticated_denial$;
reset role;
select document||jsonb_build_object('anonymous_execution_denied',true,'authenticated_execution_denied',true,
 'expansion_function_sha256',encode(extensions.digest(convert_to(pg_get_functiondef('public.get_program_award_expansion_publication(uuid)'::regprocedure),'UTF8'),'sha256'),'hex'))
 as result from expansion_read_rehearsal_report;
rollback;
`;
}
