import { currentBasicHash } from "../lib/current-basic-source-proof.mjs";

const check = (ok, reason) => { if (!ok) throw Error("Batch-three rollback: " + reason); };
const json = value => "$batch_three_fixture$" + JSON.stringify(value) + "$batch_three_fixture$::jsonb";

/** Pure rehearsal construction. Only the actual reviewed five-award plan is used;
 * it is never committed, collected, published, sent or submitted to a provider. */
export function buildProgramAwardExpansionBatchThreeRollback({ migration, awards } = {}) {
  check(typeof migration === "string" && migration.includes("$batch_three_preconditions$") &&
    migration.includes("check(launch_rank between 1 and 40)") && !/\b(?:begin|commit|rollback)\s*;/i.test(migration.replace(/--[^\n]*/g, "")),
  "an unapplied transaction-free batch-three migration is required");
  check(Array.isArray(awards) && awards.length === 5 && new Set(awards.map(a => a.cohort_key)).size === 5 &&
    !/\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(JSON.stringify(awards)), "exact reviewed five-award plan required");
  const planHash = currentBasicHash({ batch: 3, awards });
  return `begin isolation level repeatable read;
set local statement_timeout='120s';
create temporary table batch_three_before_original as select to_jsonb(r) document from public.stage1_award_registry r;
create temporary table batch_three_before_registry as select to_jsonb(r) document from public.program_award_registry r;
create temporary table batch_three_before_members as select to_jsonb(m) document from public.program_award_members m;
create temporary table batch_three_before_admissions as select to_jsonb(a) document from public.program_award_expansion_admissions a;
create temporary table batch_three_before_sources as select id,to_jsonb(s) document from public.shared_award_sources s;
create temporary table batch_three_before_heads as select to_jsonb(h) document from public.program_basic_fact_heads h;
${migration}

do $batch_three_rollback_checks$
declare plans jsonb:=${json(awards)};bad jsonb;h text:='${planHash}';result jsonb;failed boolean;checks integer:=0;
 old_sources bigint;old_acquisitions bigint;old_events bigint;old_candidates bigint;old_outbox bigint;fn text;sid uuid;created_sources integer;admission record;context jsonb;
begin
 if (select count(*) from public.stage1_award_registry)<>25 or (select count(*) from public.program_award_registry)<>35 or
 (select count(*) from public.program_award_expansion_admissions where status='active')<>10
 then raise exception 'The accepted35 changed during structural migration';end if;checks:=checks+1;
 foreach fn in array array['public.admit_program_award_expansion_batch(integer,jsonb,text,text)',
 'public.activate_program_award_expansion_batch(integer,text,text)','public.get_program_award_expansion_publication(uuid)'] loop
  if has_function_privilege('anon',fn,'EXECUTE') or has_function_privilege('authenticated',fn,'EXECUTE') or
  not has_function_privilege('service_role',fn,'EXECUTE') then raise exception 'Unauthenticated batch-three authority exposed';end if;checks:=checks+1;
 end loop;
 if has_function_privilege('anon','public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text)','EXECUTE') or
 not has_function_privilege('authenticated','public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text)','EXECUTE') or
 has_function_privilege('authenticated','public.get_program_award_expansion_tracking_context(uuid)','EXECUTE') or
 not has_function_privilege('service_role','public.get_program_award_expansion_tracking_context(uuid)','EXECUTE')
 then raise exception 'Existing office tracking permissions changed';end if;checks:=checks+1;
 -- Removing credentials inside a nested rollback verifies denial without
 -- fabricating any identity, changing an auth session or creating office rows.
 begin
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{}',true);
  failed:=false;
  begin perform public.track_office_program_expansion_atomic(null,null,null,null,'[]'::jsonb,'daily');
  exception when invalid_authorization_specification then failed:=true;end;
  if not failed then raise exception 'Unauthenticated office tracking was accepted';end if;
  raise exception 'Rollback only anonymous denial' using errcode='P0099';
 exception when sqlstate 'P0099' then null;end;checks:=checks+1;
 select count(*) into old_sources from public.shared_award_sources;
 select count(*) into old_acquisitions from public.shared_award_source_acquisitions;
 select count(*) into old_events from public.shared_award_change_events;
 select count(*) into old_candidates from public.shared_award_visual_review_candidates;
 select count(*) into old_outbox from public.public_digest_outbox;
 select count(*) into created_sources from jsonb_array_elements(plans) w cross join lateral jsonb_array_elements(w->'sources') s where (s->>'create')::boolean;

 -- An invalid last award must not leave any of the first four admitted.
 bad:=jsonb_set(plans,'{4,sources,0,review_note}','""'::jsonb);failed:=false;
 begin perform public.admit_program_award_expansion_batch(3,bad,'ROLLBACK ONLY next-five probe',
 encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(jsonb_build_object('batch',3,'awards',bad)),'UTF8'),'sha256'),'hex'));
 exception when check_violation then failed:=true;end;
 if not failed then raise exception 'Invalid fifth award was admitted';end if;checks:=checks+1;
 bad:=plans-4;failed:=false;
 begin perform public.admit_program_award_expansion_batch(3,bad,'ROLLBACK ONLY next-five probe',repeat('0',64));
 exception when check_violation then failed:=true;end;
 if not failed then raise exception 'Partial batch-three admission was accepted';end if;checks:=checks+1;
 failed:=false;
 begin perform public.admit_program_award_expansion_batch(4,plans,'ROLLBACK ONLY next-five probe',h);
 exception when check_violation then failed:=true;end;
 if not failed then raise exception 'Unreviewed fourth batch was admitted';end if;checks:=checks+1;
 bad:=jsonb_set(plans,'{4,sources,0,expected_text_monitoring_state}','{"retained_history":true}'::jsonb);failed:=false;
 begin perform public.admit_program_award_expansion_batch(3,bad,'ROLLBACK ONLY next-five probe',
 encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(jsonb_build_object('batch',3,'awards',bad)),'UTF8'),'sha256'),'hex'));
 exception when check_violation then failed:=true;end;
 if not failed then raise exception 'Source history reset was accepted';end if;checks:=checks+1;
 if (select count(*) from public.program_award_registry)<>35 or (select count(*) from public.program_award_expansion_admissions)<>10 or
 (select count(*) from public.shared_award_sources)<>old_sources or (select count(*) from public.shared_award_source_acquisitions)<>old_acquisitions
 then raise exception 'Rejected plan left a partial third batch';end if;checks:=checks+1;

 result:=public.admit_program_award_expansion_batch(3,plans,'ROLLBACK ONLY next-five probe',h);
 if result->>'notification_mode'<>'baseline_only' or (select count(*) from public.program_award_registry)<>40 or
 (select count(*) from public.program_award_expansion_admissions where batch=3 and status='monitoring')<>5 or
 (select count(*) from public.shared_award_sources)<>old_sources+created_sources or
 (select count(*) from public.shared_award_source_acquisitions)<>old_acquisitions+created_sources
 then raise exception 'Atomic five-award admission failed';end if;checks:=checks+1;
 if exists(select 1 from public.program_award_expansion_admissions a cross join lateral unnest(a.source_ids) source_ids(source_id)
 join public.shared_award_sources s on s.id=source_ids.source_id where a.batch=3 and
 (s.text_monitoring_state<>'{}'::jsonb or private.program_award_expansion_source_proof(s.id) is null))
 then raise exception 'A new source lacks silent independent initial coverage authority';end if;checks:=checks+1;
 for admission in select a.*,r.canonical_shared_award_id from public.program_award_expansion_admissions a
 join public.program_award_registry r using(cohort_key) where a.batch=3 loop
  context:=public.get_program_award_expansion_tracking_context(admission.canonical_shared_award_id);
  if context->>'cohort_key'<>admission.cohort_key or (context->>'admission_id')::uuid<>admission.id or
  jsonb_array_length(context->'source_ids')<>cardinality(admission.source_ids) or
  private.program_award_expansion_follow_source(admission.cohort_key,admission.id,admission.epoch,admission.source_ids[1])
  then raise exception 'Ranks36–40 context is unavailable or pending sources gained follow permission';end if;checks:=checks+1;
 end loop;
 if jsonb_array_length(public.get_program_award_expansion_publication('ec349339-ff62-4d2e-a610-8c361b4044ec')->'awards')<>10 or
 exists(select 1 from jsonb_array_elements(public.get_program_text_public_alert_source_bindings('ec349339-ff62-4d2e-a610-8c361b4044ec')->'bindings') x
 where x->>'cohort_key' in (select cohort_key from public.program_award_expansion_admissions where batch=3))
 then raise exception 'Unverified first coverage changed the public35 or alert sources';end if;checks:=checks+1;
 failed:=false;
 begin perform public.activate_program_award_expansion_batch(3,h,'ROLLBACK ONLY next-five probe');
 exception when check_violation then failed:=true;end;
 if not failed then raise exception 'Uncollected or unsupported third batch activated';end if;checks:=checks+1;
 -- This deliberately invalid private marker exists only in a nested rollback;
 -- it is not a capture, a baseline, factual evidence or a publication.
 select source_ids[1] into sid from public.program_award_expansion_admissions where batch=3 order by cohort_key limit 1;
 begin
  update public.shared_award_sources set text_monitoring_state='{"rollback_only_history_marker":true}' where id=sid;
  result:=public.admit_program_award_expansion_batch(3,plans,'ROLLBACK ONLY next-five probe',h);
  if result->>'already_applied'<>'true' or (select text_monitoring_state from public.shared_award_sources where id=sid)<>'{"rollback_only_history_marker":true}'::jsonb
  then raise exception 'Exact admission replay reset retained history';end if;
  raise exception 'Rollback only history simulation' using errcode='P0099';
 exception when sqlstate 'P0099' then null;end;checks:=checks+1;
 if (public.get_program_text_worker_roster_page('check',null,
 public.get_program_text_worker_roster_page('roles')->>'roster_seal')->>'cohort_count')::integer<>40
 then raise exception 'The existing collector omitted the next five';end if;checks:=checks+1;
 if (select count(*) from public.shared_award_change_events)<>old_events or (select count(*) from public.shared_award_visual_review_candidates)<>old_candidates or
 (select count(*) from public.public_digest_outbox)<>old_outbox then raise exception 'First coverage produced a change or notification';end if;checks:=checks+1;
 if exists(select 1 from batch_three_before_original b full join public.stage1_award_registry r on r.cohort_key=b.document->>'cohort_key' where to_jsonb(r) is distinct from b.document) or
 exists(select 1 from batch_three_before_registry b join public.program_award_registry r on r.cohort_key=b.document->>'cohort_key' where to_jsonb(r) is distinct from b.document) or
 exists(select 1 from batch_three_before_members b join public.program_award_members m on m.shared_award_id::text=b.document->>'shared_award_id' where to_jsonb(m) is distinct from b.document) or
 exists(select 1 from batch_three_before_admissions b join public.program_award_expansion_admissions a on a.id::text=b.document->>'id' where to_jsonb(a) is distinct from b.document) or
 exists(select 1 from batch_three_before_sources b join public.shared_award_sources s on s.id=b.id where to_jsonb(s) is distinct from b.document) or
 exists(select 1 from batch_three_before_heads b full join public.program_basic_fact_heads basic_head on basic_head.cohort_key=b.document->>'cohort_key' where to_jsonb(basic_head) is distinct from b.document)
 then raise exception 'The accepted35 or historical source/fact bodies changed';end if;checks:=checks+1;
 raise notice 'Batch-three rollback checks passed: %',checks;
end;$batch_three_rollback_checks$;
rollback;
`;
}
