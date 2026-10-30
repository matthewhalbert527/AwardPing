-- Additive authenticated follow operations for admitted text-only awards.
-- The legacy original-25 RPCs, release epoch and delivery settings are unchanged.

do $preimages$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('program-award-expansion',0));
 if encode(extensions.digest(convert_to(pg_get_functiondef('public.track_office_shared_award_atomic(uuid,uuid,uuid[],uuid,jsonb,text)'::regprocedure),'UTF8'),'sha256'),'hex')<>'cca3c48c9e3f101e4ef70ba8800872fa37d79144deda0f028a627aadf489d5a8'
 or encode(extensions.digest(convert_to(pg_get_functiondef('public.untrack_office_shared_award_atomic(uuid,uuid,uuid[],uuid,boolean)'::regprocedure),'UTF8'),'sha256'),'hex')<>'3842fc504b010929b157c2dfe63c94a98480ce6533edae6aa03da8a2f2d0174d'
 or encode(extensions.digest(convert_to(pg_get_functiondef('public.untrack_office_shared_award_source_atomic(uuid,uuid,uuid,uuid[],uuid,boolean)'::regprocedure),'UTF8'),'sha256'),'hex')<>'2b37624b2b44492028a0286311cc583d47461396e6d5926d5cd10c87a2eeb31c'
 or encode(extensions.digest(convert_to(pg_get_functiondef('private.program_award_expansion_source_proof(uuid)'::regprocedure),'UTF8'),'sha256'),'hex')<>'a66e722a6887d86005cb0cb865033d525d2ffe82137fa11233d36d3150b04933'
 or encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_program_source_allowed(uuid)'::regprocedure),'UTF8'),'sha256'),'hex')<>'283f9e68cf4ebe0e5518765ecb9df9be0b4dde00d7ac70a44e9f5377d5aac1b2'
 then raise exception 'Reviewed tracking or text source authority preimage changed.' using errcode='40001';end if;
end;$preimages$;

create function private.program_award_expansion_follow_source(p_cohort text,p_admission uuid,p_epoch uuid,p_source uuid)
returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.program_award_expansion_admissions a
 join public.program_award_registry r on r.cohort_key=a.cohort_key
 join public.program_award_members m on m.cohort_key=r.cohort_key and m.shared_award_id=r.canonical_shared_award_id and m.member_kind='canonical'
 join public.shared_award_sources s on s.shared_award_id=r.canonical_shared_award_id and s.id=any(a.source_ids)
 join public.program_text_source_authority_epochs e on e.active and e.epoch=a.epoch
 where a.id=p_admission and a.cohort_key=p_cohort and a.epoch=p_epoch and a.status='active'
 and r.launch_rank between 26 and 35 and r.policy_version='program-basic-expansion-v1' and r.publication_state<>'suspended'
 and s.id=p_source and s.text_monitoring_state->>'schema'='awardping.program-text-state.v1'
 and s.text_monitoring_state->>'epoch'=p_epoch::text
 and private.program_award_expansion_source_proof(s.id) is not null
 and private.awardping_program_text_source_access(s.id,p_cohort,p_epoch)
 and private.awardping_program_source_allowed(s.id));
$$;
revoke all on function private.program_award_expansion_follow_source(text,uuid,uuid,uuid) from public,anon,authenticated,service_role;

-- Context supplies metadata, not permission. The authenticated mutation checks
-- the actual current source authority again after locking the relevant rows.
create function public.get_program_award_expansion_tracking_context(p_shared_award_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a public.program_award_expansion_admissions%rowtype;r public.program_award_registry%rowtype;v_sources jsonb;
begin
 select registry.* into strict r from public.program_award_registry registry
 where registry.canonical_shared_award_id=p_shared_award_id and registry.launch_rank between 26 and 35
 and registry.policy_version='program-basic-expansion-v1';
 select admission.* into strict a from public.program_award_expansion_admissions admission
 where admission.cohort_key=r.cohort_key;
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,
  'page_type',s.page_type,'confidence',s.confidence,'reason',s.reason,'admin_review_status',s.admin_review_status,'updated_at',s.updated_at) order by s.id),'[]')
 into v_sources from public.shared_award_sources s where s.id=any(a.source_ids);
 return jsonb_build_object('schema','awardping.program-award-expansion-tracking.v1','cohort_key',a.cohort_key,
  'canonical_shared_award_id',r.canonical_shared_award_id,'admission_id',a.id,'epoch',a.epoch,
  'source_ids',(select jsonb_agg(id order by id) from unnest(a.source_ids) id),'sources',v_sources);
exception when no_data_found or too_many_rows then
 raise exception 'An admitted expansion identity is required.' using errcode='P0002';
end;$$;
revoke all on function public.get_program_award_expansion_tracking_context(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_program_award_expansion_tracking_context(uuid) to service_role;

create function public.track_office_program_expansion_atomic(p_office_id uuid,p_cohort_key text,p_expected_admission_id uuid,
 p_expected_epoch uuid,p_expected_source_bindings jsonb,p_cadence text default 'daily')
returns jsonb language plpgsql security definer set search_path='' as $function$
declare v_actor_user_id uuid:=(select auth.uid());v_registry public.program_award_registry%rowtype;
 v_admission public.program_award_expansion_admissions%rowtype;v_shared_award public.shared_awards%rowtype;
 p_canonical_shared_award_id uuid;v_current_member_ids uuid[];v_selected_source_ids uuid[];v_database_source_bindings jsonb;
 v_canonical_office_award_id uuid;v_summary text;v_was_tracked boolean:=false;
 v_source public.shared_award_sources%rowtype;v_source_row_id uuid;v_monitor_id uuid;v_result jsonb;v_binding jsonb;
begin
 if v_actor_user_id is null then raise exception 'Authentication is required.' using errcode='28000';end if;
 if p_office_id is null or p_cohort_key is null or p_expected_admission_id is null or p_expected_epoch is null
 or p_cadence is distinct from 'daily' or jsonb_typeof(p_expected_source_bindings) is distinct from 'array'
 or jsonb_array_length(p_expected_source_bindings) not between 1 and 6 or octet_length(p_expected_source_bindings::text)>32768
 then raise exception 'A bounded exact expansion tracking identity is required.' using errcode='22023';end if;
 perform 1 from public.office_members m where m.office_id=p_office_id and m.user_id=v_actor_user_id
 and m.status='active' and m.role in ('owner','admin') for share;
 if not found then raise exception 'Office owner or admin access is required.' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('program-award-expansion',0));
 select * into v_admission from public.program_award_expansion_admissions a
 where a.cohort_key=p_cohort_key and a.id=p_expected_admission_id for share;
 if not found or v_admission.status<>'active' or v_admission.epoch<>p_expected_epoch
 then raise exception 'Expansion admission is not currently active.' using errcode='40001';end if;
 perform 1 from public.program_text_source_authority_epochs e where e.active and e.epoch=p_expected_epoch for share;
 if not found then raise exception 'Text source authority epoch changed.' using errcode='40001';end if;
 select * into v_registry from public.program_award_registry r where r.cohort_key=p_cohort_key
 and r.launch_rank between 26 and 35 and r.policy_version='program-basic-expansion-v1' and r.publication_state<>'suspended' for share;
 if not found then raise exception 'Expansion award is not currently released.' using errcode='40001';end if;
 p_canonical_shared_award_id:=v_registry.canonical_shared_award_id;
 v_current_member_ids:=array[p_canonical_shared_award_id];
 perform 1 from public.program_award_members m where m.cohort_key=p_cohort_key order by m.shared_award_id for share;
 if (select count(*) from public.program_award_members m where m.cohort_key=p_cohort_key)<>1
 or not exists(select 1 from public.program_award_members m where m.cohort_key=p_cohort_key
 and m.shared_award_id=p_canonical_shared_award_id and m.member_kind='canonical')
 then raise exception 'Expansion canonical membership changed.' using errcode='40001';end if;
 select * into v_shared_award from public.shared_awards a where a.id=p_canonical_shared_award_id and a.status='active' for share;
 if not found then raise exception 'Canonical award changed before tracking.' using errcode='40001';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('office-award-tracking:'||p_office_id::text||':'||p_canonical_shared_award_id::text,0));
 for v_binding in select value from jsonb_array_elements(p_expected_source_bindings) loop
  if not coalesce(private.awardping_program_exact_object(v_binding,array['id','shared_award_id','url','title','page_type','confidence','reason','admin_review_status','updated_at']),false)
  or jsonb_typeof(v_binding->'id') is distinct from 'string' or (v_binding->>'id') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  then raise exception 'Exact source metadata bindings are required.' using errcode='22023';end if;
 end loop;
 select array_agg(id order by id) into v_selected_source_ids from
 (select distinct (x->>'id')::uuid id from jsonb_array_elements(p_expected_source_bindings) x) ids;
 if cardinality(v_selected_source_ids)<>jsonb_array_length(p_expected_source_bindings)
 or not v_selected_source_ids<@v_admission.source_ids
 then raise exception 'Selected expansion source identity changed.' using errcode='40001';end if;
 perform 1 from public.shared_award_sources s where s.id=any(v_selected_source_ids) order by s.id for share;
 perform 1 from public.program_text_source_roster r where r.cohort_key=p_cohort_key order by r.source_role for share;
 if exists(select 1 from unnest(v_selected_source_ids) id
 where not private.program_award_expansion_follow_source(p_cohort_key,p_expected_admission_id,p_expected_epoch,id))
 then raise exception 'Selected expansion source authority changed.' using errcode='40001';end if;
 if (select count(*) from public.shared_award_sources s where s.id=any(v_selected_source_ids))<>
 (select count(distinct private.office_tracking_source_url_key(s.url)) from public.shared_award_sources s where s.id=any(v_selected_source_ids))
 then raise exception 'Selected expansion source URL is duplicated.' using errcode='40001';end if;
 select jsonb_agg(jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type,
 'confidence',s.confidence,'reason',s.reason,'admin_review_status',s.admin_review_status,'updated_at',s.updated_at) order by s.id)
 into v_database_source_bindings from public.shared_award_sources s where s.id=any(v_selected_source_ids);
 if v_database_source_bindings is distinct from p_expected_source_bindings
 then raise exception 'Source rows changed before tracking.' using errcode='40001';end if;

  perform 1
  from public.awards award
  where award.office_id = p_office_id
    and award.shared_award_id = any(v_current_member_ids)
  order by award.id
  for update;

  select exists (
    select 1
    from public.awards award
    where award.office_id = p_office_id
      and award.shared_award_id = any(v_current_member_ids)
      and award.status = 'active'
  ) into v_was_tracked;

  select award.id into v_canonical_office_award_id
  from public.awards award
  where award.office_id = p_office_id
    and award.shared_award_id = any(v_current_member_ids)
  order by
    (award.shared_award_id = p_canonical_shared_award_id) desc,
    (award.status = 'active') desc,
    award.created_at,
    award.id
  limit 1;

  -- A stale basic snapshot does not prevent following. It contributes no
  -- unsupported local summary while the genuine change awaits reconciliation.
  select case when private.awardping_basic_fact_current(s.id) then s.public_facts->>'overview' else null end
  into v_summary from public.program_basic_fact_heads h
  join public.program_basic_fact_snapshots s on s.id=h.snapshot_id
  where h.cohort_key=p_cohort_key;

  if v_canonical_office_award_id is null then
    insert into public.awards (
      office_id,
      user_id,
      shared_award_id,
      name,
      official_homepage,
      summary,
      confidence,
      status
    ) values (
      p_office_id,
      v_actor_user_id,
      p_canonical_shared_award_id,
      v_registry.canonical_name,
      v_registry.official_homepage,
      v_summary,
      v_shared_award.confidence,
      'active'
    ) returning id into v_canonical_office_award_id;
  else
    perform private.consolidate_office_award_tracking(
      p_office_id,
      v_canonical_office_award_id,
      p_canonical_shared_award_id,
      v_current_member_ids,
      v_selected_source_ids
    );
  end if;

  update public.awards award
  set shared_award_id = p_canonical_shared_award_id,
      name = v_registry.canonical_name,
      official_homepage = v_registry.official_homepage,
      summary = v_summary,
      confidence = v_shared_award.confidence,
      status = 'active',
      updated_at = statement_timestamp()
  where award.id = v_canonical_office_award_id
    and award.office_id = p_office_id;
  if not found then
    raise exception using errcode = '40001', message = 'Canonical office award changed while tracking.';
  end if;

  for v_source in
    select source.*
    from public.shared_award_sources source
    where source.id = any(v_selected_source_ids)
    order by source.id
  loop
    select source.id into v_source_row_id
    from public.award_sources source
    where source.office_id = p_office_id
      and source.award_id = v_canonical_office_award_id
      and private.office_tracking_source_url_key(source.url)
        = private.office_tracking_source_url_key(v_source.url)
    order by source.created_at, source.id
    limit 1
    for update;

    if v_source_row_id is null then
      insert into public.award_sources (
        award_id,
        office_id,
        user_id,
        shared_award_source_id,
        url,
        title,
        page_type,
        confidence,
        reason,
        selected
      ) values (
        v_canonical_office_award_id,
        p_office_id,
        v_actor_user_id,
        v_source.id,
        v_source.url,
        v_source.title,
        v_source.page_type,
        v_source.confidence,
        v_source.reason,
        true
      ) returning id into v_source_row_id;
    else
      update public.award_sources source
      set shared_award_source_id = v_source.id,
          url = v_source.url,
          title = v_source.title,
          page_type = v_source.page_type,
          confidence = v_source.confidence,
          reason = v_source.reason,
          selected = true,
          updated_at = statement_timestamp()
      where source.id = v_source_row_id
        and source.office_id = p_office_id;
    end if;

    v_monitor_id := null;
    select monitor.id into v_monitor_id
    from public.monitors monitor
    where monitor.office_id = p_office_id
      and monitor.award_id = v_canonical_office_award_id
      and private.office_tracking_source_url_key(monitor.url)
        = private.office_tracking_source_url_key(v_source.url)
    order by monitor.created_at, monitor.id
    limit 1
    for update;

    if v_monitor_id is null then
      insert into public.monitors (
        office_id,
        user_id,
        award_id,
        shared_award_source_id,
        label,
        url,
        content_type,
        cadence,
        page_type,
        source_label,
        status,
        next_check_at
      ) values (
        p_office_id,
        v_actor_user_id,
        v_canonical_office_award_id,
        v_source.id,
        v_registry.canonical_name || ' - ' || case v_source.page_type
          when 'homepage' then 'Homepage'
          when 'deadline' then 'Deadline'
          when 'application' then 'Application'
          when 'eligibility' then 'Eligibility'
          when 'requirements' then 'Award conditions'
          when 'pdf' then 'PDF guide'
          when 'faq' then 'FAQ'
          else 'Other source'
        end,
        v_source.url,
        case
          when v_source.page_type = 'pdf'
            or pg_catalog.lower(pg_catalog.split_part(v_source.url, '?', 1)) like '%.pdf'
            then 'pdf'
          else 'auto'
        end,
        p_cadence,
        v_source.page_type,
        v_source.title,
        'active',
        statement_timestamp()
      ) returning id into v_monitor_id;
    else
      update public.monitors monitor
      set shared_award_source_id = v_source.id,
          label = v_registry.canonical_name || ' - ' || case v_source.page_type
            when 'homepage' then 'Homepage'
            when 'deadline' then 'Deadline'
            when 'application' then 'Application'
            when 'eligibility' then 'Eligibility'
            when 'requirements' then 'Award conditions'
            when 'pdf' then 'PDF guide'
            when 'faq' then 'FAQ'
            else 'Other source'
          end,
          url = v_source.url,
          content_type = case
            when v_source.page_type = 'pdf'
              or pg_catalog.lower(pg_catalog.split_part(v_source.url, '?', 1)) like '%.pdf'
              then 'pdf'
            else 'auto'
          end,
          cadence = p_cadence,
          page_type = v_source.page_type,
          source_label = v_source.title,
          status = case when monitor.status = 'paused' then 'active' else monitor.status end,
          next_check_at = case
            when monitor.status = 'paused' then statement_timestamp()
            else monitor.next_check_at
          end,
          updated_at = statement_timestamp()
      where monitor.id = v_monitor_id
        and monitor.office_id = p_office_id;
    end if;
  end loop;

  select pg_catalog.jsonb_build_object(
    'award', pg_catalog.to_jsonb(award),
    'sources', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(source) order by source.created_at, source.id)
      from public.award_sources source
      where source.office_id = p_office_id
        and source.award_id = v_canonical_office_award_id
        and source.selected
    ), '[]'::jsonb),
    'monitors', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(monitor) order by monitor.created_at, monitor.id)
      from public.monitors monitor
      where monitor.office_id = p_office_id
        and monitor.award_id = v_canonical_office_award_id
        and monitor.status <> 'paused'
    ), '[]'::jsonb),
    'alreadyTracked', v_was_tracked
  ) into v_result
  from public.awards award
  where award.id = v_canonical_office_award_id
    and award.office_id = p_office_id;

  return v_result;
end;
$function$

;

revoke all on function public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text) to authenticated;

-- Removal grants no source access or collection permission and remains possible
-- after a genuine change, source revocation or inactive admission.
create function public.untrack_office_program_expansion_atomic(p_office_id uuid,p_cohort_key text,p_expected_admission_id uuid,
 p_expected_epoch uuid,p_source_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());a public.program_award_expansion_admissions%rowtype;
 owner_id uuid;source_url text;v_award_ids uuid[];v_award_id uuid;was_tracked boolean;
begin
 if actor is null then raise exception 'Authentication is required.' using errcode='28000';end if;
 if p_office_id is null or p_cohort_key is null or p_expected_admission_id is null or p_expected_epoch is null
 then raise exception 'Expansion untracking identity is incomplete.' using errcode='22023';end if;
 perform 1 from public.office_members m where m.office_id=p_office_id and m.user_id=actor
 and m.status='active' and m.role in ('owner','admin') for share;
 if not found then raise exception 'Office owner or admin access is required.' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('program-award-expansion',0));
 select * into a from public.program_award_expansion_admissions x where x.cohort_key=p_cohort_key and x.id=p_expected_admission_id for share;
 if not found or a.epoch<>p_expected_epoch then raise exception 'Expansion admission identity changed.' using errcode='40001';end if;
 owner_id:=(a.proof->>'canonical_shared_award_id')::uuid;
 if p_source_id is not null then
  select q->>'url' into source_url from jsonb_array_elements(a.proof->'sources') q where (q->>'id')::uuid=p_source_id;
  if not found or not(p_source_id=any(a.source_ids)) then raise exception 'Source does not belong to this expansion admission.' using errcode='40001';end if;
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('office-award-tracking:'||p_office_id::text||':'||owner_id::text,0));
 perform 1 from public.awards x where x.office_id=p_office_id and x.shared_award_id=owner_id order by x.id for update;
 select coalesce(array_agg(x.id order by x.id),'{}'::uuid[]) into v_award_ids from public.awards x where x.office_id=p_office_id and x.shared_award_id=owner_id;
 select exists(select 1 from public.monitors m where m.office_id=p_office_id and m.award_id=any(v_award_ids) and m.status<>'paused'
 and (p_source_id is null or m.shared_award_source_id=p_source_id or private.office_tracking_source_url_key(m.url)=private.office_tracking_source_url_key(source_url)))
 or exists(select 1 from public.award_sources s where s.office_id=p_office_id and s.award_id=any(v_award_ids) and s.selected
 and (p_source_id is null or s.shared_award_source_id=p_source_id or private.office_tracking_source_url_key(s.url)=private.office_tracking_source_url_key(source_url))) into was_tracked;
 update public.monitors m set status='paused',updated_at=statement_timestamp()
 where m.office_id=p_office_id and m.award_id=any(v_award_ids) and m.status<>'paused'
 and (p_source_id is null or m.shared_award_source_id=p_source_id or private.office_tracking_source_url_key(m.url)=private.office_tracking_source_url_key(source_url));
 update public.award_sources s set selected=false,updated_at=statement_timestamp()
 where s.office_id=p_office_id and s.award_id=any(v_award_ids) and s.selected
 and (p_source_id is null or s.shared_award_source_id=p_source_id or private.office_tracking_source_url_key(s.url)=private.office_tracking_source_url_key(source_url));
 foreach v_award_id in array v_award_ids loop
  if p_source_id is null or (not exists(select 1 from public.monitors m where m.office_id=p_office_id and m.award_id=v_award_id and m.status<>'paused')
   and not exists(select 1 from public.award_sources s where s.office_id=p_office_id and s.award_id=v_award_id and s.selected)) then
   update public.awards x set status='archived',updated_at=statement_timestamp() where x.office_id=p_office_id and x.id=v_award_id;
  end if;
 end loop;
 return jsonb_build_object('ok',true,'alreadyTracked',was_tracked,'tracked',false,'preserved',true,'awardId',v_award_ids[1]);
end;$$;
revoke all on function public.untrack_office_program_expansion_atomic(uuid,text,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.untrack_office_program_expansion_atomic(uuid,text,uuid,uuid,uuid) to authenticated;
