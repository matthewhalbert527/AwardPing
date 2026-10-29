-- Text-only material changes require an administrator decision before publication.
do $$ begin
 if encode(extensions.digest(pg_get_functiondef('public.publish_program_text_event(uuid,jsonb,jsonb)'::regprocedure),'sha256'),'hex') <>
 'd59229d2fdfb7850e9d2e8db9d66f588b983069553fabe977b6774ac8b33c0cb'
 then raise exception 'Publication preimage changed'; end if;
end $$;
create table public.program_text_alert_reviews (
 id uuid primary key references public.shared_award_visual_review_candidates(id),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 candidate_signature text not null,
 details jsonb not null,
 localization jsonb not null,
 status text not null default 'pending' check (status in ('pending','approved','dismissed')),
 created_at timestamptz not null default clock_timestamp(),
 reviewed_at timestamptz,
 reviewed_by uuid references auth.users(id),
 event_id uuid references public.shared_award_change_events(id),
 check ((status='pending' and reviewed_at is null and reviewed_by is null and event_id is null)
   or (status='approved' and reviewed_at is not null and reviewed_by is not null and event_id is not null)
   or (status='dismissed' and reviewed_at is not null and reviewed_by is not null and event_id is null))
);
alter table public.program_text_alert_reviews enable row level security;
revoke all on public.program_text_alert_reviews from public,anon,authenticated;
grant select on public.program_text_alert_reviews to service_role;
create index program_text_alert_reviews_status_created_idx on public.program_text_alert_reviews(status,created_at desc,id);
CREATE OR REPLACE FUNCTION private.publish_reviewed_program_text_event(p_candidate_id uuid, p_details jsonb, p_localization jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_c public.shared_award_visual_review_candidates%rowtype; v_s public.shared_award_sources%rowtype;
 v_event_id uuid:=gen_random_uuid(); v_evidence jsonb; v_state jsonb; v_existing jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict v_c from public.shared_award_visual_review_candidates where id=p_candidate_id for update;
 if v_c.candidate_scope is distinct from 'program_text_change'
   or not coalesce(v_c.status in ('succeeded','published'),false) then
   raise exception 'An accepted text candidate is required.' using errcode='23514'; end if;
 select * into strict v_s from public.shared_award_sources where id=v_c.shared_award_source_id for update;
 if v_c.status='published' then
   select to_jsonb(e) into strict v_existing from public.shared_award_change_event_visual_evidence e
     join public.shared_award_change_events event on event.id=e.change_event_id
     where e.visual_review_candidate_id=v_c.id and e.change_event_id::text=v_c.worker_metadata->>'change_event_id'
       and e.localization=p_localization and event.change_details=p_details;
   perform public.awardping_validate_program_text_evidence(v_existing,to_jsonb(v_c),p_details);
   return jsonb_build_object('published',true,'event_id',v_c.worker_metadata->>'change_event_id','already_published',true);
 end if;
 if v_s.text_monitoring_state->'baseline_ref' is distinct from v_c.previous_snapshot_ref
   or v_s.text_monitoring_state->'latest_ref' is distinct from v_c.new_snapshot_ref then
   raise exception 'Source baseline or latest observation changed before publication.' using errcode='40001'; end if;
 if not coalesce(v_c.worker_metadata->>'evidence_signature' ~ '^[0-9a-f]{64}$',false) then
   raise exception 'Text publication requires the immutable queued evidence signature.' using errcode='23514'; end if;
 v_evidence:=jsonb_build_object('change_event_id',v_event_id,'shared_award_id',v_c.shared_award_id,
 'shared_award_source_id',v_c.shared_award_source_id,'visual_review_candidate_id',v_c.id,
 'candidate_signature',v_c.candidate_signature,'bucket',v_c.worker_metadata->>'bucket',
 'evidence_status','verified_text','evidence_schema_version','program-text-event-evidence-v1',
 'previous_capture',v_c.previous_snapshot_ref,'current_capture',v_c.new_snapshot_ref,
 'localization',p_localization,'verified_at',clock_timestamp());
 perform public.awardping_validate_program_text_evidence(v_evidence,to_jsonb(v_c),p_details);
 insert into public.shared_award_change_events(id,shared_award_id,shared_award_source_id,source_url,
 source_title,source_page_type,previous_hash,new_hash,summary,change_details,visual_review_candidate_id)
 values(v_event_id,v_c.shared_award_id,v_c.shared_award_source_id,v_c.source_url,v_c.source_title,
 v_c.source_page_type,v_c.previous_text_hash,v_c.new_text_hash,p_details->>'summary',p_details,v_c.id);
 insert into public.shared_award_change_event_visual_evidence(change_event_id,shared_award_id,
 shared_award_source_id,visual_review_candidate_id,candidate_signature,bucket,evidence_status,
 previous_capture,current_capture,localization,evidence_schema_version,verified_at)
 values(v_event_id,v_c.shared_award_id,v_c.shared_award_source_id,v_c.id,v_c.candidate_signature,
 v_c.worker_metadata->>'bucket','verified_text',v_c.previous_snapshot_ref,v_c.new_snapshot_ref,
 p_localization,'program-text-event-evidence-v1',clock_timestamp());
 update public.shared_award_visual_review_candidates set status='published',published_at=clock_timestamp(),
 updated_at=clock_timestamp(),worker_metadata=worker_metadata||jsonb_build_object('change_event_id',v_event_id,'baseline_advanced',true)
 where id=v_c.id;
 v_state:=v_s.text_monitoring_state||jsonb_build_object('baseline_ref',v_c.new_snapshot_ref,
 'status','baseline_ready','last_program_update_at',clock_timestamp());
 update public.shared_award_sources set text_monitoring_state=v_state where id=v_s.id;
 return jsonb_build_object('published',true,'event_id',v_event_id,'already_published',false);
end;
$function$
;
revoke all on function private.publish_reviewed_program_text_event(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;

create function private.program_text_alert_hash(c public.shared_award_visual_review_candidates,d jsonb,l jsonb)
returns text language sql immutable set search_path='' as $$
 select encode(extensions.digest(convert_to(jsonb_build_object('id',c.id,'signature',c.candidate_signature,
 'source',c.shared_award_source_id,'award',c.shared_award_id,'previous',c.previous_snapshot_ref,
 'current',c.new_snapshot_ref,'validation',c.ai_result->'program_text_validation','details',d,'localization',l)::text,'UTF8'),'sha256'),'hex');
$$;
revoke all on function private.program_text_alert_hash(public.shared_award_visual_review_candidates,jsonb,jsonb) from public,anon,authenticated,service_role;

create or replace function public.publish_program_text_event(p_candidate_id uuid,p_details jsonb,p_localization jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.shared_award_visual_review_candidates%rowtype; s public.shared_award_sources%rowtype;
 r public.program_text_alert_reviews%rowtype; h text; e jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict c from public.shared_award_visual_review_candidates where id=p_candidate_id for update;
 if c.status='published' then
   return private.publish_reviewed_program_text_event(p_candidate_id,p_details,p_localization);
 end if;
 if c.candidate_scope is distinct from 'program_text_change' or c.status is distinct from 'succeeded' then
   raise exception 'A successful material change review is required' using errcode='23514'; end if;
 select * into strict s from public.shared_award_sources where id=c.shared_award_source_id for update;
 if s.text_monitoring_state->'baseline_ref' is distinct from c.previous_snapshot_ref or
    s.text_monitoring_state->'latest_ref' is distinct from c.new_snapshot_ref then
   raise exception 'The proposed alert is stale' using errcode='40001'; end if;
 e:=jsonb_build_object('change_event_id',gen_random_uuid(),'shared_award_id',c.shared_award_id,
 'shared_award_source_id',c.shared_award_source_id,'visual_review_candidate_id',c.id,
 'candidate_signature',c.candidate_signature,'bucket',c.worker_metadata->>'bucket',
 'evidence_status','verified_text','evidence_schema_version','program-text-event-evidence-v1',
 'previous_capture',c.previous_snapshot_ref,'current_capture',c.new_snapshot_ref,
 'localization',p_localization,'verified_at',clock_timestamp());
 perform public.awardping_validate_program_text_evidence(e,to_jsonb(c),p_details);
 h:=private.program_text_alert_hash(c,p_details,p_localization);
 insert into public.program_text_alert_reviews(id,content_hash,candidate_signature,details,localization)
 values(c.id,h,c.candidate_signature,p_details,p_localization) on conflict(id) do nothing;
 select * into strict r from public.program_text_alert_reviews where id=c.id for update;
 if r.content_hash is distinct from h then raise exception 'Alert evidence changed' using errcode='40001'; end if;
 -- Exclude a queued human decision from the worker's bounded AI review window.
 -- The comparison and retained evidence remain unchanged and readable by admin.
 update public.shared_award_visual_review_candidates set
   worker_metadata=worker_metadata||jsonb_build_object('admin_alert_review_id',c.id)
   where id=c.id;
 return jsonb_build_object('published',false,'review_required',true,'review_id',r.id,'content_hash',r.content_hash);
end $$;
revoke all on function public.publish_program_text_event(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.publish_program_text_event(uuid,jsonb,jsonb) to service_role;

create function public.decide_program_text_alert(p_id uuid,p_expected_hash text,p_action text,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.shared_award_visual_review_candidates%rowtype; s public.shared_award_sources%rowtype;
 r public.program_text_alert_reviews%rowtype; e jsonb; result jsonb;
begin
 if p_actor is null or not exists(select 1 from auth.users where id=p_actor) then
   raise exception 'A real authenticated reviewer is required' using errcode='42501'; end if;
 if p_action is null or p_action not in ('approve','dismiss') or p_expected_hash is null then
   raise exception 'Choose an explicit alert decision' using errcode='23514'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict c from public.shared_award_visual_review_candidates where id=p_id for update;
 select * into strict s from public.shared_award_sources where id=c.shared_award_source_id for update;
 select * into strict r from public.program_text_alert_reviews where id=p_id for update;
 if r.content_hash is distinct from p_expected_hash or r.content_hash is distinct from
   private.program_text_alert_hash(c,r.details,r.localization) then
   raise exception 'The reviewed alert changed' using errcode='40001'; end if;
 if r.status<>'pending' then
   if (r.status='approved' and p_action='approve') or (r.status='dismissed' and p_action='dismiss') then
     return jsonb_build_object('ok',true,'status',r.status,'already_reviewed',true,'event_id',r.event_id);
   end if;
   raise exception 'This alert already has a different decision' using errcode='40001';
 end if;
 if c.candidate_scope is distinct from 'program_text_change' or c.status is distinct from 'succeeded' or
    s.text_monitoring_state->'baseline_ref' is distinct from c.previous_snapshot_ref or
    s.text_monitoring_state->'latest_ref' is distinct from c.new_snapshot_ref then
    raise exception 'Alert source comparison is no longer current' using errcode='40001'; end if;
 e:=jsonb_build_object('change_event_id',gen_random_uuid(),'shared_award_id',c.shared_award_id,
 'shared_award_source_id',c.shared_award_source_id,'visual_review_candidate_id',c.id,
 'candidate_signature',c.candidate_signature,'bucket',c.worker_metadata->>'bucket',
 'evidence_status','verified_text','evidence_schema_version','program-text-event-evidence-v1',
 'previous_capture',c.previous_snapshot_ref,'current_capture',c.new_snapshot_ref,
 'localization',r.localization,'verified_at',clock_timestamp());
 perform public.awardping_validate_program_text_evidence(e,to_jsonb(c),r.details);
 if p_action='approve' then
   result:=private.publish_reviewed_program_text_event(p_id,r.details,r.localization);
   if result->>'published' is distinct from 'true' then raise exception 'Publication was not confirmed'; end if;
   update public.program_text_alert_reviews set status='approved',reviewed_at=clock_timestamp(),reviewed_by=p_actor,
     event_id=(result->>'event_id')::uuid where id=p_id;
 else
   -- Dismissal advances this exact comparison silently, retaining both originals and the decision.
   update public.shared_award_sources set text_monitoring_state=text_monitoring_state||
     jsonb_build_object('baseline_ref',c.new_snapshot_ref,'status','baseline_ready') where id=s.id;
   update public.shared_award_visual_review_candidates set status='rejected',rejection_reason='admin_dismissed_program_change',
     updated_at=clock_timestamp() where id=c.id;
   update public.program_text_alert_reviews set status='dismissed',reviewed_at=clock_timestamp(),reviewed_by=p_actor where id=p_id;
 end if;
 return jsonb_build_object('ok',true,'status',case when p_action='approve' then 'approved' else 'dismissed' end);
end $$;
revoke all on function public.decide_program_text_alert(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.decide_program_text_alert(uuid,text,text,uuid) to service_role;

