const check=(ok,message)=>{if(!ok)throw Error('Identity read rehearsal: '+message);};
/** Local SQL builder only. The root executes this bounded rollback fixture.
 * Permanent tables are read exclusively; cardinality cases use temporary copies. */
export function expansionIdentityReadRollback(migration){
 check(typeof migration==='string'&&migration.includes('$expansion_identity_preimage$')&&migration.includes('CREATE FUNCTION public.get_program_award_expansion_identities(')&&
  !/\b(?:begin|commit|rollback)\s*;/i.test(migration.replace(/--[^\n]*/g,'')),'exact transaction-free additive migration required');
 const start=migration.indexOf('CREATE FUNCTION public.get_program_award_expansion_identities('),end=migration.indexOf('\nrevoke all on function public.get_program_award_expansion_identities');check(start>0&&end>start,'single function projection');
 let fixture=migration.slice(start,end).replace('public.get_program_award_expansion_identities(','pg_temp.expansion_identity_fixture(');
 for(const name of['program_text_source_authority_epochs','program_award_expansion_admissions','program_award_registry','program_award_members'])fixture=fixture.replaceAll('public.'+name,'pg_temp.identity_fixture_'+name);
 const state=`jsonb_build_object('heads',(select jsonb_agg(to_jsonb(h) order by cohort_key) from public.program_basic_fact_heads h),
 'registry',(select jsonb_agg(to_jsonb(r) order by cohort_key) from public.program_award_registry r),
 'members',(select jsonb_agg(to_jsonb(m) order by shared_award_id) from public.program_award_members m),
 'admissions',(select jsonb_agg(to_jsonb(a) order by cohort_key) from public.program_award_expansion_admissions a),
 'roster',(select jsonb_agg(to_jsonb(r) order by cohort_key,source_role) from public.program_text_source_roster r),
 'sources',(select jsonb_agg(jsonb_build_object('id',s.id,'sha256',encode(extensions.digest(convert_to(to_jsonb(s)::text,'UTF8'),'sha256'),'hex')) order by s.id)
  from public.shared_award_sources s where s.id in(select distinct unnest(source_ids) from public.program_text_source_roster)),
 'snapshots',(select count(*) from public.program_basic_fact_snapshots),'reviews',(select count(*) from public.program_text_alert_reviews),
 'events',(select count(*) from public.shared_award_change_events),'candidates',(select count(*) from public.shared_award_visual_review_candidates),
 'outbox',(select count(*) from public.public_digest_outbox))`;
 return `begin isolation level repeatable read;
set local statement_timeout='120s';set local lock_timeout='2s';
create temporary table expansion_identity_report(document jsonb) on commit drop;
create temporary table expansion_identity_before_state on commit drop as select ${state} document;
create temporary table expansion_identity_before_output on commit drop as select
 (select epoch from public.program_text_source_authority_epochs where active) epoch,
 public.get_program_award_expansion_publication((select epoch from public.program_text_source_authority_epochs where active)) publication;
do $identity_scope_bound$ begin
 if (select count(*) from public.program_basic_fact_heads)<>45 or
 (select count(*) from public.program_award_expansion_admissions where status='active')<>20 or
 (select count(distinct id) from public.program_text_source_roster cross join lateral unnest(source_ids) id)>1000
 then raise exception 'Frozen45-head/20-expansion source scope changed';end if;
end;$identity_scope_bound$;
${migration}
create temporary table identity_fixture_program_text_source_authority_epochs on commit drop as select * from public.program_text_source_authority_epochs where active;
create temporary table identity_fixture_program_award_expansion_admissions on commit drop as select * from public.program_award_expansion_admissions where false;
create temporary table identity_fixture_admission_seed on commit drop as select * from public.program_award_expansion_admissions where status='active';
create temporary table identity_fixture_program_award_registry on commit drop as select * from public.program_award_registry;
create temporary table identity_fixture_program_award_members on commit drop as select * from public.program_award_members;
${fixture}
revoke all on function pg_temp.expansion_identity_fixture(uuid) from public,anon,authenticated,service_role;
do $identity_projection_equivalence$
declare prior record;actual jsonb;expected jsonb;input_epoch uuid;before_error text;after_error text;count_case integer;held boolean;checks integer:=0;
begin
 select * into strict prior from expansion_identity_before_output;
 select jsonb_build_object('schema','awardping.program-award-expansion-identities.v1','epoch',prior.publication->'epoch',
  'awards',coalesce(jsonb_agg(value-'basic_fact' order by n),'[]'::jsonb)) into expected
 from jsonb_array_elements(prior.publication->'awards') with ordinality as projected(value,n);
 actual:=public.get_program_award_expansion_identities(prior.epoch);
 if actual is distinct from expected then raise exception 'Identity output differs from the exact20-award full projection';end if;checks:=checks+1;
 foreach input_epoch in array array[null::uuid,'00000000-0000-0000-0000-000000000000'::uuid] loop
  before_error:=null;after_error:=null;
  begin perform public.get_program_award_expansion_publication(input_epoch);exception when others then before_error:=sqlstate||':'||sqlerrm;end;
  begin perform public.get_program_award_expansion_identities(input_epoch);exception when others then after_error:=sqlstate||':'||sqlerrm;end;
  if before_error is null or before_error is distinct from after_error then raise exception 'Wrong/stale epoch behavior differs';end if;checks:=checks+1;
 end loop;
 foreach count_case in array array[0,5,10,15,20] loop
  truncate pg_temp.identity_fixture_program_award_expansion_admissions;
  insert into pg_temp.identity_fixture_program_award_expansion_admissions select * from pg_temp.identity_fixture_admission_seed order by cohort_key limit count_case;
  if jsonb_array_length(pg_temp.expansion_identity_fixture(prior.epoch)->'awards')<>count_case then raise exception 'Complete temporary batch changed: %',count_case;end if;checks:=checks+1;
 end loop;
 foreach count_case in array array[1,4,6,19] loop
  truncate pg_temp.identity_fixture_program_award_expansion_admissions;
  insert into pg_temp.identity_fixture_program_award_expansion_admissions select * from pg_temp.identity_fixture_admission_seed order by cohort_key limit count_case;
  held:=false;begin perform pg_temp.expansion_identity_fixture(prior.epoch);exception when check_violation then held:=true;end;
  if not held then raise exception 'Partial temporary batch accepted: %',count_case;end if;checks:=checks+1;
 end loop;
 if has_function_privilege('anon','public.get_program_award_expansion_identities(uuid)','EXECUTE') or
  has_function_privilege('authenticated','public.get_program_award_expansion_identities(uuid)','EXECUTE') or
  not has_function_privilege('service_role','public.get_program_award_expansion_identities(uuid)','EXECUTE') then raise exception 'Service-only identity execution changed';end if;
 if ${state} is distinct from (select document from expansion_identity_before_state) then raise exception 'Permanent heads/sources/identity/history/alerts/delivery changed';end if;
 insert into expansion_identity_report values(jsonb_build_object('schema','awardping.expansion-identity-read-rehearsal.v1','status','PASS',
  'checked_at',clock_timestamp(),'checks',checks,'exact_projection',true,'expansion_awards',jsonb_array_length(actual->'awards'),
  'frozen_heads',45,'temporary_cardinality_cases',9,'permanent_state_unchanged',true,'permanent_data_writes',0,
  'identity_sha256',encode(extensions.digest(convert_to(actual::text,'UTF8'),'sha256'),'hex')));
end;$identity_projection_equivalence$;
set local role service_role;
do $identity_service_positive$
declare e uuid;v jsonb;begin
 select epoch into strict e from public.program_text_source_authority_epochs where active;
 v:=public.get_program_award_expansion_identities(e);
 if v->>'schema'<>'awardping.program-award-expansion-identities.v1' or jsonb_array_length(v->'awards')<>20 then raise exception 'Real service-role identity read failed';end if;
end;$identity_service_positive$;
reset role;
set local role anon;
do $identity_anon_denial$ begin
 begin perform public.get_program_award_expansion_identities(null::uuid);raise exception 'Anonymous identity execution unexpectedly allowed';exception when insufficient_privilege then null;end;
end;$identity_anon_denial$;
reset role;
set local role authenticated;
do $identity_authenticated_denial$ begin
 begin perform public.get_program_award_expansion_identities(null::uuid);raise exception 'Authenticated identity execution unexpectedly allowed';exception when insufficient_privilege then null;end;
end;$identity_authenticated_denial$;
reset role;
select document||jsonb_build_object('service_role_read_verified',true,'anonymous_execution_denied',true,'authenticated_execution_denied',true,
 'identity_function_sha256',encode(extensions.digest(convert_to(pg_get_functiondef('public.get_program_award_expansion_identities(uuid)'::regprocedure),'UTF8'),'sha256'),'hex'))
 as result from expansion_identity_report;
rollback;
`;
}
