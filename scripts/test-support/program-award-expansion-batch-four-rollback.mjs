import {currentBasicHash} from '../lib/current-basic-source-proof.mjs';
const check=(ok,message)=>{if(!ok)throw Error('Batch4 rollback: '+message);};
const literal=value=>"'"+JSON.stringify(value).replaceAll("'","''")+"'::jsonb";
/** Pure real-plan rehearsal builder. Never connects, changes credentials or
 * invents captures/facts. Every operation is enclosed by unconditional ROLLBACK. */
export function buildProgramAwardExpansionBatchFourRollback({migration,awards,ownerPlan}={}){
 check(typeof migration==='string'&&migration.includes('$batch_four_preconditions$')&&migration.includes('check(launch_rank between 1 and 45)')&&
  !/\b(?:begin|commit|rollback)\s*;/i.test(migration.replace(/--[^\n]*/g,'')),'transaction-free reviewed migration required');
 check(Array.isArray(awards)&&awards.length===5&&new Set(awards.map(a=>a.cohort_key)).size===5&&awards.reduce((n,a)=>n+a.sources.length,0)===15,'exact reviewed5/15-source admission plan required');
 check(ownerPlan?.schema==='awardping.batch4-owner-creation-plan.v1'&&ownerPlan.batch===4&&ownerPlan.owners?.length===2&&typeof ownerPlan.reviewed_at==='string'&&
  awards.every(award=>award.reviewed_at===ownerPlan.reviewed_at),'owner plan must use the same actual fresh metadata review');
 check(!/\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(JSON.stringify({awards,ownerPlan})),'SQL delimiter in reviewed inputs');
 const planHash=currentBasicHash({batch:4,awards}),ownerHash=currentBasicHash(ownerPlan);
 return `begin isolation level repeatable read;
set local statement_timeout='120s';
create temporary table batch4_before_original as select to_jsonb(r) document from public.stage1_award_registry r;
create temporary table batch4_before_registry as select to_jsonb(r) document from public.program_award_registry r;
create temporary table batch4_before_members as select to_jsonb(m) document from public.program_award_members m;
create temporary table batch4_before_admissions as select to_jsonb(a) document from public.program_award_expansion_admissions a;
create temporary table batch4_before_roster as select to_jsonb(r) document from public.program_text_source_roster r;
create temporary table batch4_before_heads as select to_jsonb(h) document from public.program_basic_fact_heads h;
create temporary table batch4_before_owner_history as select id,to_jsonb(a) document from public.shared_awards a where id in
 (select canonical_shared_award_id from public.program_award_registry) or id='07ccbb15-9e99-4a3e-8eb7-d55c6c6d1990'::uuid;
create temporary table batch4_before_sources as select id,to_jsonb(s) document from public.shared_award_sources s where
 id in(select unnest(source_ids) from public.program_text_source_roster) or shared_award_id='07ccbb15-9e99-4a3e-8eb7-d55c6c6d1990'::uuid or
 id in(select (planned_source.value->>'id')::uuid from jsonb_array_elements(${literal(awards)}) AS planned_award(value) cross join lateral jsonb_array_elements(planned_award.value->'sources') AS planned_source(value)) or
 id in(select (planned_boundary.value->>'source_id')::uuid from jsonb_array_elements(${literal(awards)}) AS planned_award(value) cross join lateral jsonb_array_elements(planned_award.value->'sources') AS planned_source(value) cross join lateral jsonb_array_elements(planned_source.value->'url_alias_boundary') AS planned_boundary(value));
${migration}
do $batch_four_rollback_checks$
declare v_plans jsonb:=${literal(awards)};v_owner_plan jsonb:=${literal(ownerPlan)};v_plan_hash text:='${planHash}';v_owner_hash text:='${ownerHash}';
 v_bad jsonb;v_result jsonb;v_failed boolean;v_checks integer:=0;v_function text;v_sources bigint;v_acquisitions bigint;v_owners bigint;
 v_events bigint;v_candidates bigint;v_outbox bigint;v_created integer;v_owner jsonb;v_source_id uuid;v_admission record;v_context jsonb;
begin
 if (select count(*) from public.stage1_award_registry)<>25 or (select count(*) from public.program_award_registry)<>40 or
 (select count(*) from public.program_award_expansion_admissions where status='active')<>15 then raise exception 'Structural migration changed accepted40';end if;v_checks:=v_checks+1;
 foreach v_function in array array['public.create_program_award_expansion_batch_four_owners(jsonb,text,text)',
 'public.admit_program_award_expansion_batch(integer,jsonb,text,text)','public.activate_program_award_expansion_batch(integer,text,text)',
 'public.get_program_award_expansion_publication(uuid)'] loop
  if has_function_privilege('anon',v_function,'EXECUTE') or has_function_privilege('authenticated',v_function,'EXECUTE') or
  not has_function_privilege('service_role',v_function,'EXECUTE') then raise exception 'Unauthenticated batch4 backend authority exposed';end if;v_checks:=v_checks+1;
 end loop;
 select count(*) into v_owners from public.shared_awards;select count(*) into v_sources from public.shared_award_sources;
 select count(*) into v_acquisitions from public.shared_award_source_acquisitions;
 select count(*) into v_events from public.shared_award_change_events;select count(*) into v_candidates from public.shared_award_visual_review_candidates;
 select count(*) into v_outbox from public.public_digest_outbox;
 select count(*) into v_created from jsonb_array_elements(v_plans) AS planned_award(value) cross join lateral jsonb_array_elements(planned_award.value->'sources') AS planned_source(value) where (planned_source.value->>'create')::boolean;
 if exists(select 1 from public.shared_awards existing where existing.id in(select (planned_owner.value->>'id')::uuid from jsonb_array_elements(v_owner_plan->'owners') AS planned_owner(value)))
 then raise exception 'Real reviewed new-owner absence changed; no rehearsal insertion authorized';end if;

 -- Wrong second identity must create neither owner, despite a correctly hashed request.
 v_bad:=jsonb_set(v_owner_plan,'{owners,1,name}','"wrong second owner"'::jsonb);v_failed:=false;
 begin perform public.create_program_award_expansion_batch_four_owners(v_bad,
 encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(v_bad),'UTF8'),'sha256'),'hex'),'ROLLBACK ONLY batch4 probe');
 exception when check_violation then v_failed:=true;end;
 if not v_failed or (select count(*) from public.shared_awards)<>v_owners then raise exception 'Invalid two-owner plan was partially inserted';end if;v_checks:=v_checks+1;

 -- A deliberate blank, planned identity exists only in this nested rollback.
 -- It is not a fact, source, baseline or published award, and is never retained.
 begin
  v_owner:=v_owner_plan#>'{owners,0}';
  insert into public.shared_awards(id,search_key,name,slug,official_homepage,status,source,confidence,public_facts)
  values((v_owner->>'id')::uuid,v_owner->>'search_key',v_owner->>'name',v_owner->>'slug',v_owner->>'official_homepage','active','admin',0,'{}');
  v_failed:=false;
  begin perform public.create_program_award_expansion_batch_four_owners(v_owner_plan,v_owner_hash,'ROLLBACK ONLY batch4 probe');
  exception when serialization_failure then v_failed:=true;end;
  if not v_failed or (select count(*) from public.shared_awards)<>v_owners+1 or
  exists(select 1 from public.shared_awards where id=(v_owner_plan#>>'{owners,1,id}')::uuid)
  then raise exception 'Partial existing owner was reused, changed or completed';end if;
  raise exception 'Rollback-only partial-owner fixture' using errcode='P0099';
 exception when sqlstate 'P0099' then null;end;v_checks:=v_checks+1;
 if (select count(*) from public.shared_awards)<>v_owners then raise exception 'Partial-owner fixture escaped its rollback';end if;
 v_result:=public.create_program_award_expansion_batch_four_owners(v_owner_plan,v_owner_hash,'ROLLBACK ONLY batch4 probe');
 if v_result->>'already_applied'<>'false' or (select count(*) from public.shared_awards)<>v_owners+2 then raise exception 'Exact two blank owners did not insert atomically';end if;v_checks:=v_checks+1;
 v_result:=public.create_program_award_expansion_batch_four_owners(v_owner_plan,v_owner_hash,'ROLLBACK ONLY batch4 probe');
 if v_result->>'already_applied'<>'true' or (select count(*) from public.shared_awards)<>v_owners+2 then raise exception 'Owner replay changed rows';end if;v_checks:=v_checks+1;
 if exists(select 1 from public.shared_awards existing where existing.id in(select (planned_owner.value->>'id')::uuid from jsonb_array_elements(v_owner_plan->'owners') AS planned_owner(value)) and
 (existing.public_facts<>'{}'::jsonb or existing.summary is not null or existing.public_facts_generated_at is not null or existing.public_facts_model is not null or existing.submitted_by_user_id is not null))
 then raise exception 'Owner creation invented public facts or account attribution';end if;v_checks:=v_checks+1;

 v_bad:=jsonb_set(v_plans,'{4,sources,0,review_note}','""'::jsonb);v_failed:=false;
 begin perform public.admit_program_award_expansion_batch(4,v_bad,'ROLLBACK ONLY batch4 probe',
 encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(jsonb_build_object('batch',4,'awards',v_bad)),'UTF8'),'sha256'),'hex'));
 exception when check_violation then v_failed:=true;end;
 if not v_failed then raise exception 'Invalid fifth award was admitted';end if;v_checks:=v_checks+1;
 v_failed:=false;begin perform public.admit_program_award_expansion_batch(4,v_plans-4,'ROLLBACK ONLY batch4 probe',repeat('0',64));exception when check_violation then v_failed:=true;end;
 if not v_failed then raise exception 'Partial fourth batch was admitted';end if;v_checks:=v_checks+1;
 v_failed:=false;begin perform public.admit_program_award_expansion_batch(5,v_plans,'ROLLBACK ONLY batch4 probe',v_plan_hash);exception when check_violation then v_failed:=true;end;
 if not v_failed then raise exception 'Unreviewed fifth batch was admitted';end if;v_checks:=v_checks+1;
 v_bad:=jsonb_set(v_plans,'{4,sources,0,expected_text_monitoring_state}','{"retained_history":true}'::jsonb);v_failed:=false;
 begin perform public.admit_program_award_expansion_batch(4,v_bad,'ROLLBACK ONLY batch4 probe',
 encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(jsonb_build_object('batch',4,'awards',v_bad)),'UTF8'),'sha256'),'hex'));
 exception when check_violation then v_failed:=true;end;
 if not v_failed then raise exception 'Source history reset was admitted';end if;v_checks:=v_checks+1;
 if (select count(*) from public.program_award_registry)<>40 or (select count(*) from public.program_award_expansion_admissions)<>15 or
 (select count(*) from public.shared_award_sources)<>v_sources or (select count(*) from public.shared_award_source_acquisitions)<>v_acquisitions
 then raise exception 'Rejected plan left a partial fourth batch';end if;v_checks:=v_checks+1;

 v_result:=public.admit_program_award_expansion_batch(4,v_plans,'ROLLBACK ONLY batch4 probe',v_plan_hash);
 if v_result->>'notification_mode'<>'baseline_only' or (select count(*) from public.program_award_registry)<>45 or
 (select count(*) from public.program_award_expansion_admissions where batch=4 and status='monitoring')<>5 or
 (select count(*) from public.shared_award_sources)<>v_sources+v_created or (select count(*) from public.shared_award_source_acquisitions)<>v_acquisitions+v_created
 then raise exception 'Atomic five-award admission failed';end if;v_checks:=v_checks+1;
 if exists(select 1 from public.program_award_expansion_admissions a cross join lateral unnest(a.source_ids) ids(id)
 join public.shared_award_sources source_row on source_row.id=ids.id where a.batch=4 and
 (source_row.text_monitoring_state<>'{}'::jsonb or private.program_award_expansion_source_proof(source_row.id) is null))
 then raise exception 'New source silently lost independent initial-coverage authority';end if;v_checks:=v_checks+1;
 for v_admission in select a.*,r.canonical_shared_award_id from public.program_award_expansion_admissions a join public.program_award_registry r using(cohort_key) where a.batch=4 loop
  v_context:=public.get_program_award_expansion_tracking_context(v_admission.canonical_shared_award_id);
  if v_context->>'cohort_key'<>v_admission.cohort_key or (v_context->>'admission_id')::uuid<>v_admission.id or
  jsonb_array_length(v_context->'source_ids')<>3 or private.program_award_expansion_follow_source(v_admission.cohort_key,v_admission.id,v_admission.epoch,v_admission.source_ids[1])
  then raise exception 'Ranks41–45 tracking context failed or pending sources gained follow permission';end if;v_checks:=v_checks+1;
 end loop;
 if jsonb_array_length(public.get_program_award_expansion_publication('ec349339-ff62-4d2e-a610-8c361b4044ec')->'awards')<>15
 then raise exception 'Unverified initial coverage changed the public40';end if;v_checks:=v_checks+1;
 v_failed:=false;begin perform public.activate_program_award_expansion_batch(4,v_plan_hash,'ROLLBACK ONLY batch4 probe');exception when check_violation then v_failed:=true;end;
 if not v_failed then raise exception 'Uncollected unsupported fourth batch activated';end if;v_checks:=v_checks+1;
 select source_ids[1] into v_source_id from public.program_award_expansion_admissions where batch=4 order by cohort_key limit 1;
 begin
  update public.shared_award_sources set text_monitoring_state='{"rollback_only_history_marker":true}' where id=v_source_id;
  v_result:=public.admit_program_award_expansion_batch(4,v_plans,'ROLLBACK ONLY batch4 probe',v_plan_hash);
  if v_result->>'already_applied'<>'true' or (select text_monitoring_state from public.shared_award_sources where id=v_source_id)<>'{"rollback_only_history_marker":true}'::jsonb
  then raise exception 'Admission replay reset retained history';end if;
  raise exception 'Rollback-only history fixture' using errcode='P0099';
 exception when sqlstate 'P0099' then null;end;v_checks:=v_checks+1;
 if (public.get_program_text_worker_roster_page('check',null,public.get_program_text_worker_roster_page('roles')->>'roster_seal')->>'cohort_count')::integer<>45
 then raise exception 'Existing roster-driven collector omitted the next5';end if;v_checks:=v_checks+1;
 if (select count(*) from public.shared_award_change_events)<>v_events or (select count(*) from public.shared_award_visual_review_candidates)<>v_candidates or
 (select count(*) from public.public_digest_outbox)<>v_outbox then raise exception 'First coverage created a change or notification';end if;v_checks:=v_checks+1;
 if exists(select 1 from batch4_before_original b full join public.stage1_award_registry r on r.cohort_key=b.document->>'cohort_key' where to_jsonb(r) is distinct from b.document) or
 exists(select 1 from batch4_before_registry b join public.program_award_registry r on r.cohort_key=b.document->>'cohort_key' where to_jsonb(r) is distinct from b.document) or
 exists(select 1 from batch4_before_members b join public.program_award_members m on m.shared_award_id::text=b.document->>'shared_award_id' where to_jsonb(m) is distinct from b.document) or
 exists(select 1 from batch4_before_admissions b join public.program_award_expansion_admissions a on a.id::text=b.document->>'id' where to_jsonb(a) is distinct from b.document) or
 exists(select 1 from batch4_before_roster b join public.program_text_source_roster r on r.cohort_key=b.document->>'cohort_key' and r.source_role=b.document->>'source_role' where to_jsonb(r) is distinct from b.document) or
 exists(select 1 from batch4_before_heads b full join public.program_basic_fact_heads basic_head on basic_head.cohort_key=b.document->>'cohort_key' where to_jsonb(basic_head) is distinct from b.document) or
 exists(select 1 from batch4_before_owner_history b join public.shared_awards history_owner on history_owner.id=b.id where to_jsonb(history_owner) is distinct from b.document) or
 exists(select 1 from batch4_before_sources b join public.shared_award_sources source_row on source_row.id=b.id where to_jsonb(source_row) is distinct from b.document)
 then raise exception 'The accepted40, undergraduate Ellison or retained source/approval/fact bodies changed';end if;v_checks:=v_checks+1;
 raise notice 'Batch4 rollback checks passed: %',v_checks;
end;$batch_four_rollback_checks$;
rollback;
`;
}
