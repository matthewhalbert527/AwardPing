import { currentBasicHash } from "./current-basic-source-proof.mjs";

const quote = value => "$expansion_fixture$" + JSON.stringify(value) + "$expansion_fixture$::jsonb";
const check = (condition, message) => { if (!condition) throw Error(message); };

/** Pure rollback-script construction. No database/network/provider operations.
 * Uses the reviewed real admission identities only inside an explicit rollback. */
export function buildProgramAwardExpansionRollback({ migration, awards } = {}) {
  check(typeof migration === "string" && migration.includes("create table public.program_award_registry") &&
    !/\b(?:begin|commit|rollback)\s*;/i.test(migration.replace(/--[^\n]*/g, "")), "An unapplied transaction-free expansion migration is required");
  check(Array.isArray(awards) && awards.length === 5, "An exact first batch of five reviewed plans is required");
  const hash = currentBasicHash({ batch: 1, awards });
  return `begin isolation level repeatable read;
set local statement_timeout='120s';
create temporary table expansion_before_registry as select to_jsonb(r) document from public.stage1_award_registry r;
create temporary table expansion_before_members as select to_jsonb(m) document from public.stage1_award_members m;
create temporary table expansion_before_sources as select id,to_jsonb(s) document from public.shared_award_sources s;
create temporary table expansion_before_awards as select id,to_jsonb(a) document from public.shared_awards a;
${migration}
do $expansion_checks$
declare plans jsonb:=${quote(awards)};bad jsonb;h text:='${hash}';result jsonb;v_count integer:=0;failed boolean;
 old_events bigint;old_candidates bigint;old_outbox bigint;old_acquisitions bigint;old_sources bigint;fn text;sid uuid;saved jsonb;
begin
 if (select count(*) from public.stage1_award_registry)<>25 or
  exists(select 1 from expansion_before_registry b full join public.stage1_award_registry r on r.cohort_key=b.document->>'cohort_key' where to_jsonb(r) is distinct from b.document)
  or exists(select 1 from expansion_before_members b full join public.stage1_award_members m on m.shared_award_id::text=b.document->>'shared_award_id' where to_jsonb(m) is distinct from b.document)
 then raise exception 'Legacy 25-award identities changed';end if;v_count:=v_count+1;
 if (select count(*) from public.program_award_registry)<>25 or (select count(*) from public.program_award_members)<>(select count(*) from public.stage1_award_members)
 then raise exception 'Unified original identity mirror is incomplete';end if;v_count:=v_count+1;
 foreach fn in array array['public.admit_program_award_expansion_batch(integer,jsonb,text,text)','public.activate_program_award_expansion_batch(integer,text,text)',
 'public.get_program_award_expansion_publication(uuid)','public.get_program_award_monitoring_basics()'] loop
  if has_function_privilege('anon',fn,'EXECUTE') or has_function_privilege('authenticated',fn,'EXECUTE') or not has_function_privilege('service_role',fn,'EXECUTE')
  then raise exception 'Unauthenticated expansion authority exposed';end if;v_count:=v_count+1;
 end loop;
 select count(*) into old_events from public.shared_award_change_events;
 select count(*) into old_candidates from public.shared_award_visual_review_candidates;
 select count(*) into old_outbox from public.public_digest_outbox;
 select count(*) into old_acquisitions from public.shared_award_source_acquisitions;
 select count(*) into old_sources from public.shared_award_sources;

 -- Partial cohorts, changed URLs and nonempty histories fail before any write.
 bad:=plans-4;failed:=false;
 begin perform public.admit_program_award_expansion_batch(1,bad,'ROLLBACK ONLY admission probe',repeat('0',64));exception when check_violation then failed:=true;end;
 if not failed then raise exception 'Partial batch admitted';end if;v_count:=v_count+1;
 bad:=jsonb_set(plans,'{4,sources,0,url}','"https://attacker.invalid/unreviewed"'::jsonb);failed:=false;
 begin perform public.admit_program_award_expansion_batch(1,bad,'ROLLBACK ONLY admission probe',
 encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(jsonb_build_object('batch',1,'awards',bad)),'UTF8'),'sha256'),'hex'));exception when check_violation then failed:=true;end;
 if not failed then raise exception 'Unreviewed provider/programme URL admitted';end if;v_count:=v_count+1;
 bad:=jsonb_set(plans,'{4,sources,0,expected_text_monitoring_state}','{"history":"preserved"}'::jsonb);failed:=false;
 begin perform public.admit_program_award_expansion_batch(1,bad,'ROLLBACK ONLY admission probe',
 encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(jsonb_build_object('batch',1,'awards',bad)),'UTF8'),'sha256'),'hex'));exception when check_violation then failed:=true;end;
 if not failed then raise exception 'Nonempty baseline reset admitted';end if;v_count:=v_count+1;
 bad:=jsonb_set(plans,'{4,reviewed_at}','null'::jsonb);failed:=false;
 begin perform public.admit_program_award_expansion_batch(1,bad,'ROLLBACK ONLY admission probe',
 encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(jsonb_build_object('batch',1,'awards',bad)),'UTF8'),'sha256'),'hex'));exception when check_violation then failed:=true;end;
 if not failed then raise exception 'Null freshness proof admitted';end if;v_count:=v_count+1;
 if (select count(*) from public.program_award_expansion_admissions)<>0 or (select count(*) from public.program_award_registry)<>25
 or (select count(*) from public.shared_award_sources)<>old_sources or (select count(*) from public.shared_award_source_acquisitions)<>old_acquisitions
 then raise exception 'Rejected last-award plan left a partial mutation';end if;v_count:=v_count+1;

 result:=public.admit_program_award_expansion_batch(1,plans,'ROLLBACK ONLY admission probe',h);
 if result->>'notification_mode'<>'baseline_only' or (select count(*) from public.program_award_registry)<>30
 or (select count(*) from public.program_award_expansion_admissions where batch=1 and status='monitoring')<>5
 then raise exception 'Exact atomic first-five admission failed';end if;v_count:=v_count+1;
 if exists(select 1 from public.program_award_expansion_admissions a cross join lateral unnest(a.source_ids) source_id_list(source_id)
 join public.shared_award_sources s on s.id=source_id_list.source_id where s.text_monitoring_state<>'{}'::jsonb or private.program_award_expansion_source_proof(s.id) is null)
 then raise exception 'First coverage was not independent or source authority missing';end if;v_count:=v_count+1;
 if jsonb_array_length(public.get_program_award_expansion_publication('ec349339-ff62-4d2e-a610-8c361b4044ec')->'awards')<>0
 or exists(select 1 from jsonb_array_elements(public.get_program_text_public_alert_source_bindings('ec349339-ff62-4d2e-a610-8c361b4044ec')->'bindings') x
  where x->>'cohort_key' in (select cohort_key from public.program_award_expansion_admissions))
 then raise exception 'Unverified first coverage reached public identity/alerts';end if;v_count:=v_count+1;
 failed:=false;
 begin perform public.activate_program_award_expansion_batch(1,h,'ROLLBACK ONLY admission probe');exception when check_violation then failed:=true;end;
 if not failed then raise exception 'Uncollected/basicless batch activated';end if;v_count:=v_count+1;
 -- Exact replay must preserve any state accrued after admission rather than reset it.
 select source_ids[1] into sid from public.program_award_expansion_admissions order by cohort_key limit 1;
 begin
  update public.shared_award_sources set text_monitoring_state='{"rollback_probe_history":true}' where id=sid;
  result:=public.admit_program_award_expansion_batch(1,plans,'ROLLBACK ONLY admission probe',h);
  if result->>'already_applied'<>'true' or (select text_monitoring_state from public.shared_award_sources where id=sid)<>'{"rollback_probe_history":true}'::jsonb
  then raise exception 'Admission replay reset source history';end if;
  raise exception 'Rollback only replay simulation' using errcode='P0099';
 exception when sqlstate 'P0099' then null;end;v_count:=v_count+1;
 if (public.get_program_text_worker_roster_page('check',null,
  public.get_program_text_worker_roster_page('roles')->>'roster_seal')->>'cohort_count')::integer<>30
 then raise exception 'Worker omitted the admitted cohorts';end if;v_count:=v_count+1;
 if (select count(*) from public.shared_award_change_events)<>old_events or (select count(*) from public.shared_award_visual_review_candidates)<>old_candidates
 or (select count(*) from public.public_digest_outbox)<>old_outbox
 then raise exception 'Admission or first coverage created a change/notification';end if;v_count:=v_count+1;
 if exists(select 1 from expansion_before_sources b join public.shared_award_sources s on s.id=b.id where to_jsonb(s) is distinct from b.document)
 or exists(select 1 from expansion_before_awards b join public.shared_awards a on a.id=b.id where to_jsonb(a) is distinct from b.document)
 then raise exception 'Historical award/source bodies were changed';end if;v_count:=v_count+1;
 raise notice 'Expansion rollback checks passed: %',v_count;
end;$expansion_checks$;
rollback;
`;
}

