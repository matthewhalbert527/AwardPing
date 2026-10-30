// Author SQL only. Root must review/run the complete outer ROLLBACK fixture.
// It creates one transaction-local office for an existing real office owner;
// no invented user, persisted subscription, delivery or provider operation.
export function buildProgramExpansionTrackingRollbackFixture(migrationSql) {
  if (typeof migrationSql !== "string" || !migrationSql.includes("create function public.track_office_program_expansion_atomic(")) throw Error("Reviewed additive tracking migration required");
  return `begin;
create temporary table expansion_tracking_legacy_before as
select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('track_office_shared_award_atomic','untrack_office_shared_award_atomic','untrack_office_shared_award_source_atomic');
create temporary table expansion_tracking_original_before as
select jsonb_agg(to_jsonb(r) order by cohort_key) registry from public.stage1_award_registry r;
${migrationSql}
do $fixture$
declare fixture_office uuid:=gen_random_uuid();owner_id uuid;context jsonb;bindings jsonb;one_binding jsonb;result jsonb;
 admission public.program_award_expansion_admissions%rowtype;source_id uuid;second_id uuid;fixture_award uuid;failed boolean;checks integer:=0;
 original_status text;original_receipt jsonb;original_activated_at timestamptz;source_state jsonb;source_url text;other_owner uuid;
begin
 select user_id into owner_id from public.office_members where status='active' and role='owner' order by created_at,id limit 1;
 if owner_id is null then raise exception 'A real office owner is required; do not invent authentication.';end if;
 select * into strict admission from public.program_award_expansion_admissions where cohort_key='ppia_jsi';
 if (select count(*) from public.program_award_expansion_admissions where batch=1)<>5 then raise exception 'Actual first batch required';end if;
 context:=public.get_program_award_expansion_tracking_context((admission.proof->>'canonical_shared_award_id')::uuid);
 bindings:=context->'sources';source_id:=(bindings#>>'{0,id}')::uuid;second_id:=(bindings#>>'{1,id}')::uuid;
 if jsonb_array_length(bindings)<>2 then raise exception 'Expected actual bounded two-page PPIA source set';end if;
 insert into public.offices(id,name,created_by) values(fixture_office,'ROLLBACK ONLY expansion follow rehearsal',owner_id);
 insert into public.office_members(office_id,user_id,role,status) values(fixture_office,owner_id,'owner','active');
 perform set_config('request.jwt.claim.sub','',true);failed:=false;
 begin perform public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,bindings);exception when invalid_authorization_specification then failed:=true;end;
 if not failed then raise exception 'Unauthenticated tracking accepted';end if;checks:=checks+1;
 perform set_config('request.jwt.claim.sub',owner_id::text,true);failed:=false;
 begin perform public.track_office_program_expansion_atomic(gen_random_uuid(),admission.cohort_key,admission.id,admission.epoch,bindings);exception when insufficient_privilege then failed:=true;end;
 if not failed then raise exception 'Wrong office authorized';end if;checks:=checks+1;
 failed:=false;begin
  update public.office_members m set role='member' where m.office_id=fixture_office and m.user_id=owner_id;
  perform public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,bindings);
 exception when insufficient_privilege then failed:=true;end;
 if not failed then raise exception 'Ordinary office member authorized';end if;checks:=checks+1;
 failed:=false;begin
  update public.program_award_expansion_admissions set status='monitoring',activation_receipt=null,activated_at=null where id=admission.id;
  perform public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,bindings);
 exception when serialization_failure then failed:=true;end;
 if not failed then raise exception 'Inactive expansion tracking accepted';end if;checks:=checks+1;
 -- Activate only through the real readiness operation, solely inside rollback.
 perform public.activate_program_award_expansion_batch(1,admission.plan_hash,'ROLLBACK ONLY expansion tracking rehearsal');
 context:=public.get_program_award_expansion_tracking_context((admission.proof->>'canonical_shared_award_id')::uuid);bindings:=context->'sources';
 execute 'set local role authenticated';
 result:=public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,bindings);
 execute 'reset role';
 fixture_award:=(result#>>'{award,id}')::uuid;
 if result->>'alreadyTracked'<>'false' or (select count(*) from public.monitors m where m.office_id=fixture_office)<>2
 or (select count(*) from public.award_sources s where s.office_id=fixture_office and s.selected)<>2
 or exists(select 1 from public.shared_award_sources s where s.id=any(admission.source_ids) and s.admin_review_status<>'review_later')
 then raise exception 'Authenticated exact-source follow did not preserve review_later/atomic state';end if;checks:=checks+1;
 execute 'set local role authenticated';
 result:=public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,bindings);
 execute 'reset role';
 if result->>'alreadyTracked'<>'true' or (select count(*) from public.awards x where x.office_id=fixture_office)<>1
 or (select count(*) from public.monitors m where m.office_id=fixture_office)<>2 then raise exception 'Repeated follow duplicated rows';end if;checks:=checks+1;
 failed:=false;begin perform public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,gen_random_uuid(),admission.epoch,bindings);exception when serialization_failure then failed:=true;end;
 if not failed then raise exception 'Wrong admission accepted';end if;checks:=checks+1;
 failed:=false;begin perform public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,gen_random_uuid(),bindings);exception when serialization_failure then failed:=true;end;
 if not failed then raise exception 'Wrong epoch accepted';end if;checks:=checks+1;
 failed:=false;begin perform public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,jsonb_set(bindings,'{0,shared_award_id}',to_jsonb(gen_random_uuid())));exception when serialization_failure then failed:=true;end;
 if not failed then raise exception 'Wrong owner binding accepted';end if;checks:=checks+1;
 failed:=false;begin perform public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,jsonb_set(bindings,'{0,id}',to_jsonb(gen_random_uuid())));exception when serialization_failure then failed:=true;end;
 if not failed then raise exception 'Unapproved source accepted';end if;checks:=checks+1;
 failed:=false;begin perform public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,bindings||bindings);exception when serialization_failure then failed:=true;end;
 if not failed then raise exception 'Duplicate source accepted';end if;checks:=checks+1;
 failed:=false;begin perform public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,jsonb_set(bindings,'{0,updated_at}',to_jsonb('1999-01-01T00:00:00Z'::text)));exception when serialization_failure then failed:=true;end;
 if not failed then raise exception 'Stale metadata accepted';end if;checks:=checks+1;
 failed:=false;begin
  update public.program_award_registry set publication_state='suspended' where cohort_key=admission.cohort_key;
  perform public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,bindings);
 exception when serialization_failure then failed:=true;end;
 if not failed then raise exception 'Suspended publication accepted';end if;checks:=checks+1;
 failed:=false;begin
  update public.program_text_source_roster set source_ids=array_remove(source_ids,source_id) where cohort_key=admission.cohort_key;
  perform public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,bindings);
 exception when serialization_failure then failed:=true;end;
 if not failed then raise exception 'Revoked roster source accepted';end if;checks:=checks+1;
 failed:=false;begin
  update public.shared_award_sources set url=url||'/unapproved-fixture' where id=source_id;
  context:=public.get_program_award_expansion_tracking_context((admission.proof->>'canonical_shared_award_id')::uuid);
  perform public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,context->'sources');
 exception when serialization_failure then failed:=true;end;
 if not failed then raise exception 'Changed source URL accepted';end if;checks:=checks+1;
 select canonical_shared_award_id into other_owner from public.stage1_award_registry order by cohort_key limit 1;
 failed:=false;begin
  update public.shared_award_sources set shared_award_id=other_owner where id=source_id;
  context:=public.get_program_award_expansion_tracking_context((admission.proof->>'canonical_shared_award_id')::uuid);
  perform public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,context->'sources');
 exception when serialization_failure then failed:=true;end;
 if not failed then raise exception 'Changed source owner accepted';end if;checks:=checks+1;
 if (select count(*) from public.awards x where x.office_id=fixture_office)<>1 or (select count(*) from public.monitors m where m.office_id=fixture_office)<>2
 or (select count(*) from public.award_sources s where s.office_id=fixture_office)<>2 then raise exception 'Failed tracking left partial rows';end if;checks:=checks+1;
 execute 'set local role authenticated';
 result:=public.untrack_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,source_id);
 execute 'reset role';
 if result->>'ok'<>'true' or (select count(*) from public.monitors m where m.office_id=fixture_office and m.status<>'paused')<>1
 or (select status from public.awards x where x.id=fixture_award)<>'active' then raise exception 'Source-only removal escaped its source';end if;checks:=checks+1;
 select text_monitoring_state into source_state from public.shared_award_sources where id=source_id;
 update public.shared_award_sources set text_monitoring_state=jsonb_set(jsonb_set(text_monitoring_state,'{status}','"pending_review"'),'{last_program_update_at}',to_jsonb(clock_timestamp())) where id=source_id;
 if private.awardping_basic_fact_current((select snapshot_id from public.program_basic_fact_heads where cohort_key=admission.cohort_key)) then raise exception 'Pending fixture did not stale basics';end if;
 context:=public.get_program_award_expansion_tracking_context((admission.proof->>'canonical_shared_award_id')::uuid);
 select jsonb_build_array(value) into one_binding from jsonb_array_elements(context->'sources') where value->>'id'=source_id::text;
 execute 'set local role authenticated';
 result:=public.track_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,one_binding);
 execute 'reset role';
 if result#>>'{award,summary}' is not null or (select count(*) from public.monitors m where m.office_id=fixture_office and m.status<>'paused')<>2
 then raise exception 'Pending programme change blocked safe follow or copied stale summary';end if;checks:=checks+1;
 -- Revoked/moved source and inactive admission must remain removable.
 update public.shared_award_sources set url=url||'/unapproved-fixture' where id=source_id;
 update public.program_award_expansion_admissions set status='monitoring',activation_receipt=null,activated_at=null where id=admission.id;
 execute 'set local role authenticated';
 result:=public.untrack_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,source_id);
 result:=public.untrack_office_program_expansion_atomic(fixture_office,admission.cohort_key,admission.id,admission.epoch,null);
 execute 'reset role';
 if result->>'ok'<>'true' or (select count(*) from public.monitors m where m.office_id=fixture_office)<>2
 or exists(select 1 from public.monitors m where m.office_id=fixture_office and m.status<>'paused')
 or exists(select 1 from public.award_sources s where s.office_id=fixture_office and s.selected)
 or (select status from public.awards x where x.id=fixture_award)<>'archived' then raise exception 'Removal lost history or stranded inactive follows';end if;checks:=checks+1;
 if has_function_privilege('anon','public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text)','EXECUTE')
 or has_function_privilege('service_role','public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text)','EXECUTE')
 or not has_function_privilege('authenticated','public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text)','EXECUTE')
 or has_function_privilege('authenticated','public.get_program_award_expansion_tracking_context(uuid)','EXECUTE')
 or has_function_privilege('anon','public.untrack_office_program_expansion_atomic(uuid,text,uuid,uuid,uuid)','EXECUTE')
 then raise exception 'Expansion tracking ACL boundary changed';end if;checks:=checks+1;
 if exists(select 1 from expansion_tracking_legacy_before b where b.definition is distinct from pg_get_functiondef(b.signature::regprocedure))
 or (select registry from expansion_tracking_original_before) is distinct from (select jsonb_agg(to_jsonb(r) order by cohort_key) from public.stage1_award_registry r)
 then raise exception 'Original25 identity or tracking functions changed';end if;checks:=checks+1;
 perform set_config('awardping.expansion_tracking_fixture',jsonb_build_object('assertions',checks,'provider_calls',0,'persistent_follows',0)::text,true);
end;$fixture$;
select current_setting('awardping.expansion_tracking_fixture') as expansion_tracking_rollback_acceptance;
rollback;
`;
}
