-- Office tracking mutations used to be assembled from independent Data API
-- writes.  A failure between those writes could strand duplicate award cards,
-- detach monitor history, or only partially untrack an award.  Keep the whole
-- office-scoped state transition behind authenticated, transactional RPCs.

create or replace function private.office_tracking_source_url_key(p_url text)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_value text := pg_catalog.lower(pg_catalog.btrim(p_url));
  v_authority_and_path text;
  v_authority text;
  v_path text;
  v_query text;
  v_query_part text;
  v_key text;
  v_parameter_value text;
  v_kept text[] := '{}'::text[];
begin
  v_value := pg_catalog.regexp_replace(v_value, '^https?://', '', 'i');
  v_value := pg_catalog.split_part(v_value, '#', 1);
  v_authority_and_path := pg_catalog.split_part(v_value, '?', 1);
  v_query := case
    when pg_catalog.strpos(v_value, '?') > 0
      then pg_catalog.substring(v_value from pg_catalog.strpos(v_value, '?') + 1)
    else ''
  end;
  v_authority := pg_catalog.split_part(v_authority_and_path, '/', 1);
  v_authority := pg_catalog.regexp_replace(v_authority, '^www\.', '', 'i');
  v_path := pg_catalog.substring(
    v_authority_and_path
    from pg_catalog.char_length(pg_catalog.split_part(v_authority_and_path, '/', 1)) + 1
  );
  v_path := case when v_path = '' then '/' else v_path end;
  v_path := pg_catalog.regexp_replace(v_path, '/index\.(html?|php|aspx?)$', '/', 'i');
  v_path := pg_catalog.regexp_replace(v_path, '\.aspx$', '', 'i');
  v_path := pg_catalog.regexp_replace(v_path, '/+$', '');
  if v_path = '' then v_path := '/'; end if;

  foreach v_query_part in array pg_catalog.string_to_array(v_query, '&') loop
    v_key := pg_catalog.lower(pg_catalog.split_part(v_query_part, '=', 1));
    v_parameter_value := pg_catalog.lower(
      pg_catalog.btrim(
        case
          when pg_catalog.strpos(v_query_part, '=') > 0
            then pg_catalog.substring(
              v_query_part from pg_catalog.strpos(v_query_part, '=') + 1
            )
          else ''
        end
      )
    );

    if v_key = ''
      or v_key like 'utm\_%' escape '\'
      or v_key = any(array[
        'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid', 'share',
        'replytocom', 'lang', 'locale', 'view', 'campaign', 'sort'
      ])
      or (v_key = 'page' and v_parameter_value in ('', '1'))
      or (v_key = 's' and v_parameter_value = '') then
      continue;
    end if;

    v_kept := pg_catalog.array_append(
      v_kept,
      v_key || '=' || v_parameter_value
    );
  end loop;

  select coalesce(pg_catalog.array_agg(value order by value), '{}'::text[])
  into v_kept
  from pg_catalog.unnest(v_kept) value;

  return v_authority || v_path || case
    when pg_catalog.cardinality(v_kept) > 0
      then '?' || pg_catalog.array_to_string(v_kept, '&')
    else ''
  end;
end;
$$;

revoke all on function private.office_tracking_source_url_key(text)
  from public, anon, authenticated, service_role;

create or replace function private.consolidate_office_award_tracking(
  p_office_id uuid,
  p_canonical_office_award_id uuid,
  p_canonical_shared_award_id uuid,
  p_member_shared_award_ids uuid[],
  p_selected_shared_source_ids uuid[] default '{}'::uuid[]
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_duplicate record;
  v_priority text;
  v_workflow_status text;
  v_owner_member_id uuid;
  v_last_reviewed_at timestamptz;
begin
  if not exists (
    select 1
    from public.awards award
    where award.id = p_canonical_office_award_id
      and award.office_id = p_office_id
      and award.shared_award_id = any(p_member_shared_award_ids)
  ) then
    raise exception using
      errcode = '40001',
      message = 'Canonical office award changed before consolidation.';
  end if;

  select
    case when pg_catalog.bool_or(award.priority = 'high') then 'high' else 'normal' end,
    (pg_catalog.array_agg(
      award.workflow_status
      order by case award.workflow_status
        when 'done' then 5
        when 'ready' then 4
        when 'in_progress' then 3
        when 'needs_review' then 2
        else 1
      end desc,
      award.updated_at desc,
      award.id
    ))[1],
    (pg_catalog.array_agg(
      award.owner_member_id
      order by (award.owner_member_id is null), award.updated_at desc, award.id
    ) filter (where award.owner_member_id is not null))[1],
    pg_catalog.max(award.last_reviewed_at)
  into
    v_priority,
    v_workflow_status,
    v_owner_member_id,
    v_last_reviewed_at
  from public.awards award
  where award.office_id = p_office_id
    and award.shared_award_id = any(p_member_shared_award_ids);

  -- Move every local snapshot/event and the shared-event attribution to the
  -- final monitor winner before deleting duplicate monitors.
  for v_duplicate in
    with ranked as (
      select
        monitor.id,
        pg_catalog.first_value(monitor.id) over (
          partition by private.office_tracking_source_url_key(monitor.url)
          order by case monitor.status
            when 'active' then 3
            when 'error' then 2
            else 1
          end desc,
          monitor.last_checked_at desc nulls last,
          (monitor.award_id = p_canonical_office_award_id) desc,
          monitor.created_at,
          monitor.id
        ) as winner_id
      from public.monitors monitor
      join public.awards award on award.id = monitor.award_id
      where monitor.office_id = p_office_id
        and award.office_id = p_office_id
        and award.shared_award_id = any(p_member_shared_award_ids)
    )
    select ranked.id as duplicate_id, ranked.winner_id
    from ranked
    where ranked.id <> ranked.winner_id
    order by ranked.id
  loop
    update public.monitor_snapshots snapshot
    set monitor_id = v_duplicate.winner_id,
        office_id = p_office_id
    where snapshot.monitor_id = v_duplicate.duplicate_id;

    update public.change_events event
    set monitor_id = v_duplicate.winner_id,
        office_id = p_office_id
    where event.monitor_id = v_duplicate.duplicate_id;

    update public.shared_award_change_events event
    set first_reported_by_monitor_id = v_duplicate.winner_id
    where event.first_reported_by_monitor_id = v_duplicate.duplicate_id;

    delete from public.monitors monitor
    where monitor.id = v_duplicate.duplicate_id
      and monitor.office_id = p_office_id;
  end loop;

  -- Source rows have no dependent history.  Keep the selected/canonical/oldest
  -- representative for each canonical URL and discard only exact duplicates.
  delete from public.award_sources source
  using (
    select ranked.id
    from (
      select
        source.id,
        pg_catalog.row_number() over (
          partition by private.office_tracking_source_url_key(source.url)
          order by source.selected desc,
            (source.award_id = p_canonical_office_award_id) desc,
            source.created_at,
            source.id
        ) as position
      from public.award_sources source
      join public.awards award on award.id = source.award_id
      where source.office_id = p_office_id
        and award.office_id = p_office_id
        and award.shared_award_id = any(p_member_shared_award_ids)
    ) ranked
    where ranked.position > 1
  ) duplicate
  where source.id = duplicate.id
    and source.office_id = p_office_id;

  update public.award_sources source
  set award_id = p_canonical_office_award_id,
      shared_award_source_id = coalesce((
        select shared_source.id
        from public.shared_award_sources shared_source
        where shared_source.id = any(coalesce(p_selected_shared_source_ids, '{}'::uuid[]))
          and private.office_tracking_source_url_key(shared_source.url)
            = private.office_tracking_source_url_key(source.url)
        order by
          (shared_source.shared_award_id = p_canonical_shared_award_id) desc,
          shared_source.created_at,
          shared_source.id
        limit 1
      ), source.shared_award_source_id),
      updated_at = statement_timestamp()
  where source.office_id = p_office_id
    and source.award_id in (
      select award.id
      from public.awards award
      where award.office_id = p_office_id
        and award.shared_award_id = any(p_member_shared_award_ids)
    );

  update public.monitors monitor
  set award_id = p_canonical_office_award_id,
      shared_award_source_id = coalesce((
        select shared_source.id
        from public.shared_award_sources shared_source
        where shared_source.id = any(coalesce(p_selected_shared_source_ids, '{}'::uuid[]))
          and private.office_tracking_source_url_key(shared_source.url)
            = private.office_tracking_source_url_key(monitor.url)
        order by
          (shared_source.shared_award_id = p_canonical_shared_award_id) desc,
          shared_source.created_at,
          shared_source.id
        limit 1
      ), monitor.shared_award_source_id),
      updated_at = statement_timestamp()
  where monitor.office_id = p_office_id
    and monitor.award_id in (
      select award.id
      from public.awards award
      where award.office_id = p_office_id
        and award.shared_award_id = any(p_member_shared_award_ids)
    );

  update public.award_notes note
  set award_id = p_canonical_office_award_id,
      updated_at = statement_timestamp()
  where note.office_id = p_office_id
    and note.award_id in (
      select award.id
      from public.awards award
      where award.office_id = p_office_id
        and award.shared_award_id = any(p_member_shared_award_ids)
        and award.id <> p_canonical_office_award_id
    );

  update public.award_tasks task
  set award_id = p_canonical_office_award_id,
      updated_at = statement_timestamp()
  where task.office_id = p_office_id
    and task.award_id in (
      select award.id
      from public.awards award
      where award.office_id = p_office_id
        and award.shared_award_id = any(p_member_shared_award_ids)
        and award.id <> p_canonical_office_award_id
    );

  update public.awards award
  set priority = coalesce(v_priority, award.priority),
      workflow_status = coalesce(v_workflow_status, award.workflow_status),
      owner_member_id = coalesce(award.owner_member_id, v_owner_member_id),
      last_reviewed_at = greatest(award.last_reviewed_at, v_last_reviewed_at),
      updated_at = statement_timestamp()
  where award.id = p_canonical_office_award_id
    and award.office_id = p_office_id;

  delete from public.awards award
  where award.office_id = p_office_id
    and award.shared_award_id = any(p_member_shared_award_ids)
    and award.id <> p_canonical_office_award_id;
end;
$$;

revoke all on function private.consolidate_office_award_tracking(
  uuid, uuid, uuid, uuid[], uuid[]
) from public, anon, authenticated, service_role;

create or replace function public.track_office_shared_award_atomic(
  p_office_id uuid,
  p_canonical_shared_award_id uuid,
  p_expected_member_shared_award_ids uuid[],
  p_expected_release_epoch uuid,
  p_expected_source_bindings jsonb,
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
begin
  if v_actor_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication is required.';
  end if;
  if p_office_id is null or p_canonical_shared_award_id is null
    or p_expected_release_epoch is null then
    raise exception using errcode = '22023', message = 'Tracking identity is incomplete.';
  end if;
  if p_cadence <> 'daily' then
    raise exception using errcode = '22023', message = 'Unsupported tracking cadence.';
  end if;
  if p_expected_member_shared_award_ids is null
    or pg_catalog.cardinality(p_expected_member_shared_award_ids) = 0
    or p_expected_source_bindings is null
    or pg_catalog.jsonb_typeof(p_expected_source_bindings) <> 'array'
    or pg_catalog.jsonb_array_length(p_expected_source_bindings) = 0 then
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

  select coalesce(pg_catalog.array_agg(source_id order by source_id), '{}'::uuid[])
  into v_allowed_source_ids
  from (
    select distinct pg_catalog.unnest(manifest.source_ids) as source_id
    from public.stage1_award_source_manifest manifest
    where manifest.cohort_key = v_registry.cohort_key
  ) allowed;

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
    and source.admin_review_status = 'open';

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

  select case
    when pg_catalog.jsonb_typeof(ledger.public_value) = 'string'
      then ledger.public_value #>> '{}'
    else null
  end
  into v_summary
  from public.stage1_award_fact_publication_ledger ledger
  where ledger.cohort_key = v_registry.cohort_key
    and ledger.verification_batch_id = v_registry.fact_ledger_batch_id
    and ledger.field_name = 'overview';

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
$$;

revoke all on function public.track_office_shared_award_atomic(
  uuid, uuid, uuid[], uuid, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.track_office_shared_award_atomic(
  uuid, uuid, uuid[], uuid, jsonb, text
) to authenticated;

create or replace function public.untrack_office_shared_award_atomic(
  p_office_id uuid,
  p_requested_shared_award_id uuid,
  p_expected_member_shared_award_ids uuid[] default null,
  p_expected_release_epoch uuid default null,
  p_validate_release_epoch boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_registry public.stage1_award_registry%rowtype;
  v_canonical_shared_award_id uuid := p_requested_shared_award_id;
  v_current_member_ids uuid[] := array[p_requested_shared_award_id];
  v_expected_member_ids uuid[];
  v_selected_source_ids uuid[] := '{}'::uuid[];
  v_canonical_office_award_id uuid;
  v_was_tracked boolean := false;
begin
  if v_actor_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication is required.';
  end if;
  if p_office_id is null or p_requested_shared_award_id is null then
    raise exception using errcode = '22023', message = 'Untracking identity is incomplete.';
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

  select registry.* into v_registry
  from public.stage1_award_registry registry
  where registry.canonical_shared_award_id = p_requested_shared_award_id
    or exists (
      select 1
      from public.stage1_award_members member
      where member.cohort_key = registry.cohort_key
        and member.shared_award_id = p_requested_shared_award_id
    )
  order by registry.launch_rank
  limit 1
  for share;

  if found then
    v_canonical_shared_award_id := v_registry.canonical_shared_award_id;
    select pg_catalog.array_agg(member.shared_award_id order by member.shared_award_id)
    into v_current_member_ids
    from public.stage1_award_members member
    where member.cohort_key = v_registry.cohort_key;

    select coalesce(pg_catalog.array_agg(source_id order by source_id), '{}'::uuid[])
    into v_selected_source_ids
    from (
      select distinct pg_catalog.unnest(manifest.source_ids) as source_id
      from public.stage1_award_source_manifest manifest
      where manifest.cohort_key = v_registry.cohort_key
    ) selected;

    if p_validate_release_epoch
      and v_registry.release_epoch is distinct from p_expected_release_epoch then
      raise exception using errcode = '40001', message = 'Stage 1 release changed before untracking.';
    end if;
  elsif p_validate_release_epoch then
    raise exception using errcode = '40001', message = 'Stage 1 identity changed before untracking.';
  end if;

  if p_expected_member_shared_award_ids is not null then
    select pg_catalog.array_agg(member_id order by member_id)
    into v_expected_member_ids
    from (
      select distinct pg_catalog.unnest(p_expected_member_shared_award_ids) as member_id
    ) expected;
    if pg_catalog.cardinality(v_expected_member_ids)
        <> pg_catalog.cardinality(p_expected_member_shared_award_ids)
      or v_expected_member_ids is distinct from v_current_member_ids then
      raise exception using errcode = '40001', message = 'Stage 1 member identity changed before untracking.';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'office-award-tracking:' || p_office_id::text || ':' || v_canonical_shared_award_id::text,
      0
    )
  );

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
    (award.shared_award_id = v_canonical_shared_award_id) desc,
    (award.status = 'active') desc,
    award.created_at,
    award.id
  limit 1;

  if v_canonical_office_award_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'alreadyTracked', false,
      'preserved', true
    );
  end if;

  perform private.consolidate_office_award_tracking(
    p_office_id,
    v_canonical_office_award_id,
    v_canonical_shared_award_id,
    v_current_member_ids,
    v_selected_source_ids
  );

  update public.monitors monitor
  set status = 'paused',
      updated_at = statement_timestamp()
  where monitor.office_id = p_office_id
    and monitor.award_id = v_canonical_office_award_id
    and monitor.status <> 'paused';

  update public.award_sources source
  set selected = false,
      updated_at = statement_timestamp()
  where source.office_id = p_office_id
    and source.award_id = v_canonical_office_award_id
    and source.selected;

  update public.awards award
  set shared_award_id = v_canonical_shared_award_id,
      status = 'archived',
      updated_at = statement_timestamp()
  where award.office_id = p_office_id
    and award.id = v_canonical_office_award_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'alreadyTracked', v_was_tracked,
    'preserved', true,
    'awardId', v_canonical_office_award_id
  );
end;
$$;

revoke all on function public.untrack_office_shared_award_atomic(
  uuid, uuid, uuid[], uuid, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.untrack_office_shared_award_atomic(
  uuid, uuid, uuid[], uuid, boolean
) to authenticated;

create or replace function public.untrack_office_shared_award_source_atomic(
  p_office_id uuid,
  p_requested_shared_award_id uuid,
  p_shared_award_source_id uuid,
  p_expected_member_shared_award_ids uuid[] default null,
  p_expected_release_epoch uuid default null,
  p_validate_release_epoch boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_registry public.stage1_award_registry%rowtype;
  v_canonical_shared_award_id uuid := p_requested_shared_award_id;
  v_current_member_ids uuid[] := array[p_requested_shared_award_id];
  v_expected_member_ids uuid[];
  v_selected_source_ids uuid[] := '{}'::uuid[];
  v_canonical_office_award_id uuid;
  v_source_url text;
  v_was_tracked boolean := false;
begin
  if v_actor_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication is required.';
  end if;
  if p_office_id is null or p_requested_shared_award_id is null
    or p_shared_award_source_id is null then
    raise exception using errcode = '22023', message = 'Source untracking identity is incomplete.';
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

  select registry.* into v_registry
  from public.stage1_award_registry registry
  where registry.canonical_shared_award_id = p_requested_shared_award_id
    or exists (
      select 1
      from public.stage1_award_members member
      where member.cohort_key = registry.cohort_key
        and member.shared_award_id = p_requested_shared_award_id
    )
  order by registry.launch_rank
  limit 1
  for share;

  if found then
    v_canonical_shared_award_id := v_registry.canonical_shared_award_id;
    select pg_catalog.array_agg(member.shared_award_id order by member.shared_award_id)
    into v_current_member_ids
    from public.stage1_award_members member
    where member.cohort_key = v_registry.cohort_key;

    select coalesce(pg_catalog.array_agg(source_id order by source_id), '{}'::uuid[])
    into v_selected_source_ids
    from (
      select distinct pg_catalog.unnest(manifest.source_ids) as source_id
      from public.stage1_award_source_manifest manifest
      where manifest.cohort_key = v_registry.cohort_key
    ) selected;

    if p_validate_release_epoch
      and v_registry.release_epoch is distinct from p_expected_release_epoch then
      raise exception using errcode = '40001', message = 'Stage 1 release changed before source untracking.';
    end if;
  elsif p_validate_release_epoch then
    raise exception using errcode = '40001', message = 'Stage 1 identity changed before source untracking.';
  end if;

  if p_expected_member_shared_award_ids is not null then
    select pg_catalog.array_agg(member_id order by member_id)
    into v_expected_member_ids
    from (
      select distinct pg_catalog.unnest(p_expected_member_shared_award_ids) as member_id
    ) expected;
    if pg_catalog.cardinality(v_expected_member_ids)
        <> pg_catalog.cardinality(p_expected_member_shared_award_ids)
      or v_expected_member_ids is distinct from v_current_member_ids then
      raise exception using errcode = '40001', message = 'Stage 1 member identity changed before source untracking.';
    end if;
  end if;

  select source.url into v_source_url
  from public.shared_award_sources source
  where source.id = p_shared_award_source_id
    and source.shared_award_id = any(v_current_member_ids)
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'Award source was not found.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'office-award-tracking:' || p_office_id::text || ':' || v_canonical_shared_award_id::text,
      0
    )
  );

  perform 1
  from public.awards award
  where award.office_id = p_office_id
    and award.shared_award_id = any(v_current_member_ids)
  order by award.id
  for update;

  select award.id into v_canonical_office_award_id
  from public.awards award
  where award.office_id = p_office_id
    and award.shared_award_id = any(v_current_member_ids)
  order by
    (award.shared_award_id = v_canonical_shared_award_id) desc,
    (award.status = 'active') desc,
    award.created_at,
    award.id
  limit 1;

  if v_canonical_office_award_id is null then
    return pg_catalog.jsonb_build_object('ok', true, 'tracked', false, 'preserved', true);
  end if;

  perform private.consolidate_office_award_tracking(
    p_office_id,
    v_canonical_office_award_id,
    v_canonical_shared_award_id,
    v_current_member_ids,
    v_selected_source_ids
  );

  select exists (
    select 1
    from public.monitors monitor
    where monitor.office_id = p_office_id
      and monitor.award_id = v_canonical_office_award_id
      and monitor.status <> 'paused'
      and private.office_tracking_source_url_key(monitor.url)
        = private.office_tracking_source_url_key(v_source_url)
  ) or exists (
    select 1
    from public.award_sources source
    where source.office_id = p_office_id
      and source.award_id = v_canonical_office_award_id
      and source.selected
      and private.office_tracking_source_url_key(source.url)
        = private.office_tracking_source_url_key(v_source_url)
  ) into v_was_tracked;

  update public.monitors monitor
  set status = 'paused',
      updated_at = statement_timestamp()
  where monitor.office_id = p_office_id
    and monitor.award_id = v_canonical_office_award_id
    and private.office_tracking_source_url_key(monitor.url)
      = private.office_tracking_source_url_key(v_source_url)
    and monitor.status <> 'paused';

  update public.award_sources source
  set selected = false,
      updated_at = statement_timestamp()
  where source.office_id = p_office_id
    and source.award_id = v_canonical_office_award_id
    and private.office_tracking_source_url_key(source.url)
      = private.office_tracking_source_url_key(v_source_url)
    and source.selected;

  if not exists (
    select 1
    from public.monitors monitor
    where monitor.office_id = p_office_id
      and monitor.award_id = v_canonical_office_award_id
      and monitor.status <> 'paused'
  ) and not exists (
    select 1
    from public.award_sources source
    where source.office_id = p_office_id
      and source.award_id = v_canonical_office_award_id
      and source.selected
  ) then
    update public.awards award
    set status = 'archived',
        shared_award_id = v_canonical_shared_award_id,
        updated_at = statement_timestamp()
    where award.office_id = p_office_id
      and award.id = v_canonical_office_award_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'tracked', false,
    'wasTracked', v_was_tracked,
    'preserved', true,
    'awardId', v_canonical_office_award_id
  );
end;
$$;

revoke all on function public.untrack_office_shared_award_source_atomic(
  uuid, uuid, uuid, uuid[], uuid, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.untrack_office_shared_award_source_atomic(
  uuid, uuid, uuid, uuid[], uuid, boolean
) to authenticated;

comment on function public.track_office_shared_award_atomic(
  uuid, uuid, uuid[], uuid, jsonb, text
) is 'Atomically validates the active Stage 1 release, consolidates equivalent office awards, and enables selected source monitors.';
comment on function public.untrack_office_shared_award_atomic(
  uuid, uuid, uuid[], uuid, boolean
) is 'Atomically consolidates then archives office award tracking while preserving sources, monitors, notes, tasks, snapshots, and change history.';
comment on function public.untrack_office_shared_award_source_atomic(
  uuid, uuid, uuid, uuid[], uuid, boolean
) is 'Atomically disables one canonical source URL and preserves its full office history.';
