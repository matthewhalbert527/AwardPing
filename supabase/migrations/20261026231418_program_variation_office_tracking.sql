
-- Additive authenticated office tracking for the exact approved variation
-- release. Legacy tracking functions, source statuses and approval history
-- remain unchanged. Existing office entitlement triggers and consolidation
-- retain their authority; no new scheduling or billing path is introduced.
do $$ declare actual_sha text;begin
 select encode(extensions.digest(convert_to(proc_rows.prosrc,'UTF8'),'sha256'),'hex') into strict actual_sha
 from pg_catalog.pg_proc proc_rows join pg_catalog.pg_namespace namespace_rows on namespace_rows.oid=proc_rows.pronamespace
 where namespace_rows.nspname='public' and proc_rows.proname='track_office_shared_award_atomic'
 and pg_get_function_identity_arguments(proc_rows.oid)='p_office_id uuid, p_canonical_shared_award_id uuid, p_expected_member_shared_award_ids uuid[], p_expected_release_epoch uuid, p_expected_source_bindings jsonb, p_cadence text';
 if actual_sha is distinct from '2be909383f89f8ef5e479b034b6f690c22a034fafc76957e09dd041e876ffcfd' then raise exception 'Legacy tracking contract changed; independently review the new path.' using errcode='40001';end if;
end $$;

create function private.awardping_variation_tracking_source_binding(p_approval uuid,p_source uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('url',reference#>>'{source,url}','shared_award_id',reference#>>'{source,shared_award_id}',
  'title',reference#>'{source,title}','page_type',reference#>'{source,page_type}') from (
 select ref reference,0 priority,'common' scope_key from public.program_variation_award_approvals approval
 join public.program_variation_unit_reviews parent on parent.id=approval.shared_review_id
 cross join lateral jsonb_array_elements(parent.validation#>'{review,capture_refs}') ref
 where approval.id=p_approval and ref#>>'{source,id}'=p_source::text
 union all
 select ref,1,entry.key from public.program_variation_award_approvals approval
 cross join lateral jsonb_each(approval.child_reviews) entry
 join public.program_variation_unit_reviews child on child.id=(entry.value->>'id')::uuid
 cross join lateral jsonb_array_elements(child.validation#>'{review,capture_refs}') ref
 where approval.id=p_approval and ref#>>'{source,id}'=p_source::text
 ) approved_reference where private.awardping_program_text_reference_valid(reference)
 order by priority,scope_key limit 1;
$$;
revoke all on function private.awardping_variation_tracking_source_binding(uuid,uuid) from public,anon,authenticated;
grant execute on function private.awardping_variation_tracking_source_binding(uuid,uuid) to service_role;

create function public.get_program_variation_tracking_context(p_cohort text,p_source uuid default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare release_row public.program_variation_release%rowtype;approval_row public.program_variation_award_approvals%rowtype;
 inventory_row public.program_variation_inventories%rowtype;parent_row public.program_variation_unit_reviews%rowtype;
 source_ids uuid[];source_id uuid;bindings jsonb:='{}';binding jsonb;
begin
 select * into strict release_row from public.program_variation_release where release_key='national-25-provider-variations';
 if not release_row.is_active or jsonb_typeof(release_row.approval_ids) is distinct from 'object'
  or (select count(*) from jsonb_object_keys(release_row.approval_ids))<>25
  or (select count(*) from jsonb_each_text(release_row.approval_ids) entry join public.program_variation_award_approvals approval
    on approval.id=entry.value::uuid and approval.cohort_key=entry.key join public.stage1_award_registry registry on registry.cohort_key=entry.key)<>25
 then raise exception 'Exact25 approved variation publication is required.' using errcode='40001';end if;
 select * into approval_row from public.program_variation_award_approvals where id=(release_row.approval_ids->>p_cohort)::uuid and cohort_key=p_cohort;
 if approval_row.id is null or not private.awardping_variation_award_current(approval_row.id) then raise exception 'Current approved award details are required.' using errcode='40001';end if;
 select * into strict inventory_row from public.program_variation_inventories where id=approval_row.inventory_id and status='sealed';
 select * into strict parent_row from public.program_variation_unit_reviews where id=approval_row.shared_review_id;
 if p_source is null then
  select array_agg((ref#>>'{source,id}')::uuid order by (ref#>>'{source,id}')::uuid) into source_ids
  from jsonb_array_elements(parent_row.validation#>'{review,capture_refs}') ref;
 else source_ids:=array[p_source];end if;
 if cardinality(source_ids) not between 1 and 500 or cardinality(source_ids)<>(select count(distinct value) from unnest(source_ids) value)
 then raise exception 'Common tracking review must remain bounded.' using errcode='23514';end if;
 foreach source_id in array source_ids loop
  binding:=private.awardping_variation_tracking_source_binding(approval_row.id,source_id);
  if binding is null or not(private.awardping_variation_inventory_source_ids(inventory_row.id) ? source_id::text)
   or not exists(select 1 from public.shared_award_sources source join public.stage1_award_members member
    on member.shared_award_id=source.shared_award_id and member.cohort_key=p_cohort
    where source.id=source_id and source.url=binding->>'url' and source.shared_award_id::text=binding->>'shared_award_id'
    and source.admin_review_status in ('open','review_later')
    and private.awardping_program_text_source_access(source.id,p_cohort,(parent_row.validation#>>'{review,epoch}')::uuid))
   then raise exception 'Approved source identity or text authority changed.' using errcode='40001';end if;
  bindings:=bindings||jsonb_build_object(source_id::text,binding);
 end loop;
 return jsonb_build_object('schema','awardping.program-variation-tracking.v1','cohort_key',p_cohort,'release_revision',release_row.revision,
  'inventory_id',inventory_row.id,'inventory_revision',inventory_row.revision,'approval_id',approval_row.id,'approval_hash',approval_row.content_hash,
  'epoch',parent_row.validation#>'{review,epoch}','shared_review_id',parent_row.id,'source_id',p_source,'source_ids',to_jsonb(source_ids),'source_bindings',bindings);
end $$;
revoke all on function public.get_program_variation_tracking_context(text,uuid) from public,anon,authenticated;
grant execute on function public.get_program_variation_tracking_context(text,uuid) to service_role;

create function public.track_office_program_variation_atomic(
  p_office_id uuid,
  p_canonical_shared_award_id uuid,
  p_expected_member_shared_award_ids uuid[],
  p_expected_release_epoch uuid,
  p_expected_source_bindings jsonb,
  p_expected_variation_context jsonb,
  p_cadence text default 'daily'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_registry public.stage1_award_registry%rowtype;
  v_shared_award public.shared_awards%rowtype;
  v_current_member_ids uuid[];
  v_expected_member_ids uuid[];
  v_allowed_source_ids uuid[];
  v_selected_source_ids uuid[];
  v_database_source_bindings jsonb;
  v_canonical_office_award_id uuid;
  v_summary text;
  v_was_tracked boolean := false;
  v_source public.shared_award_sources%rowtype;
  v_source_row_id uuid;
  v_monitor_id uuid;
  v_result jsonb;
  v_variation_context jsonb;
  v_pinned_binding jsonb;
begin
  if v_actor_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication is required.';
  end if;
  if p_office_id is null or p_canonical_shared_award_id is null
    or p_expected_release_epoch is null then
    raise exception using errcode = '22023', message = 'Tracking identity is incomplete.';
  end if;
  if p_cadence is distinct from 'daily' then
    raise exception using errcode = '22023', message = 'Unsupported tracking cadence.';
  end if;
  if p_expected_member_shared_award_ids is null
    or pg_catalog.cardinality(p_expected_member_shared_award_ids) = 0
    or p_expected_source_bindings is null
    or pg_catalog.jsonb_typeof(p_expected_source_bindings) <> 'array'
    or pg_catalog.jsonb_array_length(p_expected_source_bindings) = 0
    or pg_catalog.jsonb_array_length(p_expected_source_bindings) > 500
    or pg_catalog.jsonb_typeof(p_expected_variation_context) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Tracking inputs are empty.';
  end if;

  perform 1
  from public.office_members member
  where member.office_id = p_office_id
    and member.user_id = v_actor_user_id
    and member.status = 'active'
    and member.role in ('owner', 'admin')
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'Office owner or admin access is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'office-award-tracking:' || p_office_id::text || ':' || p_canonical_shared_award_id::text,
      0
    )
  );

  select * into v_registry
  from public.stage1_award_registry registry
  where registry.canonical_shared_award_id = p_canonical_shared_award_id
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'Stage 1 award was not found.';
  end if;

  if v_registry.release_epoch is distinct from p_expected_release_epoch then
    raise exception using errcode = '40001', message = 'Stage 1 release changed before tracking.';
  end if;
  if not exists (
    select 1
    from public.list_stage1_effective_publication() effective
    where effective.cohort_key = v_registry.cohort_key
      and effective.effectively_verified
      and effective.release_epoch = p_expected_release_epoch
  ) then
    raise exception using errcode = '40001', message = 'Stage 1 award is not currently released.';
  end if;

  v_variation_context:=public.get_program_variation_tracking_context(v_registry.cohort_key,(p_expected_variation_context->>'source_id')::uuid);
  if p_expected_variation_context is distinct from v_variation_context then
    raise exception using errcode='40001',message='Approved variation release changed before tracking.';
  end if;

  select pg_catalog.array_agg(member.shared_award_id order by member.shared_award_id)
  into v_current_member_ids
  from public.stage1_award_members member
  where member.cohort_key = v_registry.cohort_key;

  select pg_catalog.array_agg(member_id order by member_id)
  into v_expected_member_ids
  from (
    select distinct pg_catalog.unnest(p_expected_member_shared_award_ids) as member_id
  ) expected;

  if pg_catalog.cardinality(v_expected_member_ids)
      <> pg_catalog.cardinality(p_expected_member_shared_award_ids)
    or v_expected_member_ids is distinct from v_current_member_ids
    or not (p_canonical_shared_award_id = any(v_current_member_ids)) then
    raise exception using errcode = '40001', message = 'Stage 1 member identity changed before tracking.';
  end if;

  select array_agg(value::uuid order by value::uuid) into v_allowed_source_ids
  from jsonb_array_elements_text(v_variation_context->'source_ids');

  begin
    select pg_catalog.array_agg(source_id order by source_id)
    into v_selected_source_ids
    from (
      select distinct (binding.value ->> 'id')::uuid as source_id
      from pg_catalog.jsonb_array_elements(p_expected_source_bindings) binding(value)
    ) selected;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Source binding contains an invalid identifier.';
  end;

  if pg_catalog.cardinality(v_selected_source_ids)
      <> pg_catalog.jsonb_array_length(p_expected_source_bindings)
    or exists (
      select 1
      from pg_catalog.unnest(v_selected_source_ids) selected_id
      where not (selected_id = any(v_allowed_source_ids))
    )
    or (
      select count(*)
      from public.shared_award_sources source
      where source.id = any(v_selected_source_ids)
    ) <> (
      select count(distinct private.office_tracking_source_url_key(source.url))
      from public.shared_award_sources source
      where source.id = any(v_selected_source_ids)
    ) then
    raise exception using errcode = '40001', message = 'Selected source identity is stale or duplicated.';
  end if;

  if exists (
    select 1
    from public.shared_award_sources source
    join public.stage1_award_source_identity_rules identity_rule
      on identity_rule.cohort_key = v_registry.cohort_key
    where source.id = any(v_selected_source_ids)
      and (
        (
          identity_rule.url_pattern is not null
          and source.url ~* identity_rule.url_pattern
        )
        or (
          identity_rule.title_pattern is not null
          and pg_catalog.concat_ws(' ', source.title, source.display_title)
            ~* identity_rule.title_pattern
        )
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'Selected source is excluded by the reviewed identity policy.';
  end if;

  perform 1 from public.shared_award_sources source where source.id=any(v_selected_source_ids) order by source.id for share;
  -- Recheck current approval after locking mutable rows; no timing gap can
  -- substitute a newer URL, owner, revoked authority or substantive change.
  if p_expected_variation_context is distinct from public.get_program_variation_tracking_context(v_registry.cohort_key,(p_expected_variation_context->>'source_id')::uuid) then
    raise exception using errcode='40001',message='Approved variation source state changed before tracking.';
  end if;
  if exists(select 1 from public.shared_award_sources selected_source
    join public.awards office_award on office_award.office_id=p_office_id and office_award.shared_award_id=any(v_current_member_ids)
    join public.award_sources existing_source on existing_source.award_id=office_award.id and existing_source.office_id=p_office_id
    where selected_source.id=any(v_selected_source_ids) and existing_source.url<>selected_source.url
      and private.office_tracking_source_url_key(existing_source.url)=private.office_tracking_source_url_key(selected_source.url))
    or exists(select 1 from public.shared_award_sources selected_source
    join public.awards office_award on office_award.office_id=p_office_id and office_award.shared_award_id=any(v_current_member_ids)
    join public.monitors existing_monitor on existing_monitor.award_id=office_award.id and existing_monitor.office_id=p_office_id
    where selected_source.id=any(v_selected_source_ids) and existing_monitor.url<>selected_source.url
      and private.office_tracking_source_url_key(existing_monitor.url)=private.office_tracking_source_url_key(selected_source.url)) then
    raise exception using errcode='40001',message='Different exact document URLs require separate identity review.';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', source.id,
      'shared_award_id', source.shared_award_id,
      'url', source.url,
      'title', source.title,
      'page_type', source.page_type,
      'confidence', source.confidence,
      'reason', source.reason,
      'admin_review_status', source.admin_review_status,
      'updated_at', source.updated_at
    ) order by source.id
  ), '[]'::jsonb)
  into v_database_source_bindings
  from public.shared_award_sources source
  where source.id = any(v_selected_source_ids)
    and source.shared_award_id = any(v_current_member_ids)
    and source.admin_review_status in ('open','review_later')
    and source.url=v_variation_context#>>array['source_bindings',source.id::text,'url']
    and source.shared_award_id::text=v_variation_context#>>array['source_bindings',source.id::text,'shared_award_id']
    and private.awardping_program_text_source_access(source.id,v_registry.cohort_key,(v_variation_context->>'epoch')::uuid);

  if v_database_source_bindings is distinct from p_expected_source_bindings then
    raise exception using errcode = '40001', message = 'Source rows changed before tracking.';
  end if;

  perform 1
  from public.shared_award_sources source
  where source.id = any(v_selected_source_ids)
  order by source.id
  for share;

  select * into v_shared_award
  from public.shared_awards award
  where award.id = p_canonical_shared_award_id
    and award.status = 'active'
  for share;
  if not found then
    raise exception using errcode = '40001', message = 'Canonical award changed before tracking.';
  end if;

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

  select parent.validation#>>'{public_facts,overview}' into v_summary from public.program_variation_unit_reviews parent
  where parent.id=(v_variation_context->>'shared_review_id')::uuid;
  if length(btrim(coalesce(v_summary,'')))=0 then raise exception using errcode='40001',message='Approved shared program overview is required.';end if;

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
    v_pinned_binding:=v_variation_context#>array['source_bindings',v_source.id::text];
    v_source.title:=coalesce(nullif(btrim(v_pinned_binding->>'title'),''),v_registry.canonical_name||' official source');
    v_source.page_type:=coalesce(v_pinned_binding->>'page_type','other');
    v_source.reason:='Source retained by the approved program variation release.';
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
$$;

revoke all on function public.track_office_program_variation_atomic(uuid,uuid,uuid[],uuid,jsonb,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.track_office_program_variation_atomic(uuid,uuid,uuid[],uuid,jsonb,jsonb,text) to authenticated;
notify pgrst,'reload schema';
