alter function public.retire_shared_award_source_preserving_visual_history(
  uuid,
  text,
  text
) set schema private;

alter function private.retire_shared_award_source_preserving_visual_history(
  uuid,
  text,
  text
) rename to retire_shared_award_source_unfenced_20260715143000;

revoke all on function private.retire_shared_award_source_unfenced_20260715143000(
  uuid,
  text,
  text
) from public, anon, authenticated, service_role;

create or replace function public.retire_shared_award_source_preserving_visual_history(
  p_source_id uuid,
  p_reason text,
  p_actor text
)
returns table(
  source_id uuid,
  matched_event_count integer,
  newly_suppressed_event_count integer,
  already_suppressed_event_count integer,
  already_retired boolean,
  homepage_cleared boolean
)
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '60s'
as $$
begin
  -- The source UPDATE fires the Stage 1 release-fence statement trigger. Take
  -- its national lock before the legacy implementation can lock a source row.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  return query
  select retirement.*
  from private.retire_shared_award_source_unfenced_20260715143000(
    p_source_id,
    p_reason,
    p_actor
  ) retirement;
end;
$$;

alter function public.retire_shared_award_source_preserving_visual_history(
  uuid,
  text,
  text
) owner to postgres;

revoke all on function public.retire_shared_award_source_preserving_visual_history(
  uuid,
  text,
  text
) from public, anon, authenticated, service_role;

grant execute on function public.retire_shared_award_source_preserving_visual_history(
  uuid,
  text,
  text
) to service_role;

comment on function public.retire_shared_award_source_preserving_visual_history(
  uuid,
  text,
  text
) is
  'National-lock-first wrapper for manual source retirement. It preserves the deployed visual-history and exact-homepage-clear semantics without taking a source row before the Stage 1 release lock.';

create or replace function public.apply_shared_award_source_cleanup_plan(
  p_plan jsonb,
  p_reason text,
  p_actor text
)
returns table(
  shared_award_id uuid,
  retired_source_count integer,
  matched_event_count integer,
  newly_suppressed_event_count integer,
  homepage_changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '60s'
as $$
declare
  v_actor text := nullif(pg_catalog.btrim(p_actor), '');
  v_award public.shared_awards%rowtype;
  v_award_update_count integer := 0;
  v_current_source_states jsonb;
  v_expected_award_homepage text;
  v_expected_award_id uuid;
  v_expected_award_name text;
  v_expected_award_status text;
  v_expected_award_updated_at timestamptz;
  v_expected_remaining_open_source_ids uuid[];
  v_expected_source_states jsonb;
  v_homepage jsonb;
  v_homepage_new text;
  v_homepage_old text;
  v_homepage_replacement_source_id uuid;
  v_matched_event_count integer := 0;
  v_newly_suppressed_event_count integer := 0;
  v_now timestamptz := pg_catalog.now();
  v_planned_useful_remaining_source_ids uuid[];
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_retire_source_ids uuid[];
  v_source_update_count integer := 0;
begin
  if v_reason is null or v_actor is null then
    raise exception using
      errcode = '22023',
      message = 'Award source cleanup requires a non-empty reason and actor.';
  end if;
  if p_plan is null
    or pg_catalog.jsonb_typeof(p_plan) <> 'object'
    or not p_plan ?& array[
      'schema_version',
      'expected_award',
      'expected_sources',
      'retire_source_ids',
      'expected_remaining_open_source_ids',
      'planned_useful_remaining_source_ids',
      'homepage'
    ]
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(p_plan)
    ) <> 7
    or p_plan ->> 'schema_version'
      <> 'awardping-award-source-cleanup-plan-v1' then
    raise exception using
      errcode = '22023',
      message = 'Award source cleanup requires one exact versioned plan.';
  end if;
  if pg_catalog.jsonb_typeof(p_plan -> 'expected_award') <> 'object'
    or pg_catalog.jsonb_typeof(p_plan -> 'expected_sources') <> 'array'
    or pg_catalog.jsonb_typeof(p_plan -> 'retire_source_ids') <> 'array'
    or pg_catalog.jsonb_typeof(
      p_plan -> 'expected_remaining_open_source_ids'
    ) <> 'array'
    or pg_catalog.jsonb_typeof(
      p_plan -> 'planned_useful_remaining_source_ids'
    ) <> 'array'
    or pg_catalog.jsonb_typeof(p_plan -> 'homepage') <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'Award source cleanup plan fields have invalid JSON types.';
  end if;
  if not (p_plan -> 'expected_award') ?& array[
      'id',
      'name',
      'official_homepage',
      'status',
      'updated_at'
    ]
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(p_plan -> 'expected_award')
    ) <> 5
    or not (p_plan -> 'homepage') ?& array[
      'old_url',
      'new_url',
      'replacement_source_id'
    ]
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(p_plan -> 'homepage')
    ) <> 3 then
    raise exception using
      errcode = '22023',
      message = 'Award source cleanup award or homepage state is incomplete.';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      p_plan -> 'expected_sources'
    ) as source_item(state)
    where pg_catalog.jsonb_typeof(source_item.state) <> 'object'
      or not source_item.state ?& array[
        'schema_version',
        'id',
        'shared_award_id',
        'url',
        'title',
        'page_type',
        'confidence',
        'source',
        'last_error',
        'admin_review_status',
        'updated_at'
      ]
      or (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_object_keys(source_item.state)
      ) <> 11
      or source_item.state ->> 'schema_version'
        <> 'awardping-source-retirement-cas-v1'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Award source cleanup contains an incomplete source snapshot.';
  end if;

  begin
    v_expected_award_id := (p_plan #>> '{expected_award,id}')::uuid;
    v_expected_award_name := p_plan #>> '{expected_award,name}';
    v_expected_award_homepage :=
      p_plan #>> '{expected_award,official_homepage}';
    v_expected_award_status := p_plan #>> '{expected_award,status}';
    v_expected_award_updated_at :=
      (p_plan #>> '{expected_award,updated_at}')::timestamptz;
    v_homepage := p_plan -> 'homepage';
    v_homepage_old := v_homepage ->> 'old_url';
    v_homepage_new := v_homepage ->> 'new_url';
    v_homepage_replacement_source_id :=
      nullif(v_homepage ->> 'replacement_source_id', '')::uuid;

    select coalesce(
      pg_catalog.array_agg(item.value::uuid order by item.value::uuid),
      '{}'::uuid[]
    ) into v_retire_source_ids
    from pg_catalog.jsonb_array_elements_text(
      p_plan -> 'retire_source_ids'
    ) as item(value);
    select coalesce(
      pg_catalog.array_agg(item.value::uuid order by item.value::uuid),
      '{}'::uuid[]
    ) into v_expected_remaining_open_source_ids
    from pg_catalog.jsonb_array_elements_text(
      p_plan -> 'expected_remaining_open_source_ids'
    ) as item(value);
    select coalesce(
      pg_catalog.array_agg(item.value::uuid order by item.value::uuid),
      '{}'::uuid[]
    ) into v_planned_useful_remaining_source_ids
    from pg_catalog.jsonb_array_elements_text(
      p_plan -> 'planned_useful_remaining_source_ids'
    ) as item(value);

    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'schema_version', expected.schema_version,
          'id', expected.id,
          'shared_award_id', expected.shared_award_id,
          'url', expected.url,
          'title', expected.title,
          'page_type', expected.page_type,
          'confidence', expected.confidence,
          'source', expected.source,
          'last_error', expected.last_error,
          'admin_review_status', expected.admin_review_status,
          'updated_at', expected.updated_at
        ) order by expected.id
      ),
      '[]'::jsonb
    ) into v_expected_source_states
    from pg_catalog.jsonb_to_recordset(
      p_plan -> 'expected_sources'
    ) as expected(
      schema_version text,
      id uuid,
      shared_award_id uuid,
      url text,
      title text,
      page_type text,
      confidence numeric,
      source text,
      last_error text,
      admin_review_status text,
      updated_at timestamptz
    );
  exception
    when invalid_text_representation
      or invalid_datetime_format
      or datetime_field_overflow
      or numeric_value_out_of_range then
      raise exception using
        errcode = '22023',
        message = 'Award source cleanup plan contains invalid typed values.';
  end;

  if v_expected_award_id is null
    or nullif(pg_catalog.btrim(v_expected_award_name), '') is null
    or v_expected_award_status <> 'active'
    or v_expected_award_updated_at is null
    or pg_catalog.jsonb_array_length(p_plan -> 'retire_source_ids')
      <> pg_catalog.cardinality(v_retire_source_ids)
    or pg_catalog.jsonb_array_length(
      p_plan -> 'expected_remaining_open_source_ids'
    ) <> pg_catalog.cardinality(v_expected_remaining_open_source_ids)
    or pg_catalog.jsonb_array_length(
      p_plan -> 'planned_useful_remaining_source_ids'
    ) <> pg_catalog.cardinality(v_planned_useful_remaining_source_ids)
    or (
      pg_catalog.cardinality(v_retire_source_ids) = 0
      and v_homepage_old is not distinct from v_homepage_new
    ) then
    raise exception using
      errcode = '22023',
      message = 'Award source cleanup plan is empty, duplicated, or not active.';
  end if;

  -- Global release fence first, then the award, then every source in stable ID
  -- order. The later statement triggers reacquire the transaction-level lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  select award.* into strict v_award
  from public.shared_awards award
  where award.id = v_expected_award_id
  for update;

  perform source_row.id
  from public.shared_award_sources source_row
  where source_row.shared_award_id = v_expected_award_id
  order by source_row.id
  for update;

  if v_award.name is distinct from v_expected_award_name
    or v_award.official_homepage is distinct from v_expected_award_homepage
    or v_award.status is distinct from v_expected_award_status
    or v_award.updated_at is distinct from v_expected_award_updated_at
    or v_homepage_old is distinct from v_expected_award_homepage then
    raise exception using
      errcode = '40001',
      message = 'Shared award changed after cleanup planning; requeue cleanup.';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'schema_version', 'awardping-source-retirement-cas-v1',
        'id', source_row.id,
        'shared_award_id', source_row.shared_award_id,
        'url', source_row.url,
        'title', source_row.title,
        'page_type', source_row.page_type,
        'confidence', source_row.confidence,
        'source', source_row.source,
        'last_error', source_row.last_error,
        'admin_review_status', source_row.admin_review_status,
        'updated_at', source_row.updated_at
      ) order by source_row.id
    ),
    '[]'::jsonb
  ) into v_current_source_states
  from public.shared_award_sources source_row
  where source_row.shared_award_id = v_expected_award_id;

  if v_current_source_states is distinct from v_expected_source_states then
    raise exception using
      errcode = '40001',
      message = 'Award source set changed after cleanup planning; requeue cleanup.';
  end if;
  if exists (
    select 1
    from pg_catalog.unnest(v_retire_source_ids) as retired(id)
    left join public.shared_award_sources source_row
      on source_row.id = retired.id
      and source_row.shared_award_id = v_expected_award_id
    where source_row.id is null
      or source_row.admin_review_status <> 'open'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Award source cleanup can retire only observed open award sources.';
  end if;

  if v_expected_remaining_open_source_ids is distinct from coalesce(
    (
      select pg_catalog.array_agg(source_row.id order by source_row.id)
      from public.shared_award_sources source_row
      where source_row.shared_award_id = v_expected_award_id
        and source_row.admin_review_status = 'open'
        and not source_row.id = any(v_retire_source_ids)
    ),
    '{}'::uuid[]
  )
    or not v_planned_useful_remaining_source_ids
      <@ v_expected_remaining_open_source_ids then
    raise exception using
      errcode = '22023',
      message = 'Award source cleanup remaining-source invariant is invalid.';
  end if;

  if v_homepage_replacement_source_id is not null then
    if not v_homepage_replacement_source_id = any(
      v_planned_useful_remaining_source_ids
    )
      or not exists (
        select 1
        from public.shared_award_sources source_row
        where source_row.id = v_homepage_replacement_source_id
          and source_row.shared_award_id = v_expected_award_id
          and source_row.admin_review_status = 'open'
          and source_row.url = v_homepage_new
      ) then
      raise exception using
        errcode = '22023',
        message = 'Award source cleanup homepage replacement is not a planned useful remaining source.';
    end if;
  elsif v_homepage_old is distinct from v_homepage_new
    and v_homepage_new is not null then
    raise exception using
      errcode = '22023',
      message = 'Award source cleanup non-null homepage replacement requires a source identity.';
  end if;
  if v_homepage_old is not distinct from v_homepage_new
    and v_homepage_replacement_source_id is not null then
    raise exception using
      errcode = '22023',
      message = 'Award source cleanup unchanged homepage cannot claim a replacement.';
  end if;
  if v_homepage_old is not distinct from v_homepage_new
    and exists (
      select 1
      from public.shared_award_sources source_row
      where source_row.id = any(v_retire_source_ids)
        and source_row.url = v_homepage_old
    ) then
    raise exception using
      errcode = '22023',
      message = 'Award source cleanup cannot leave the homepage on a retiring source.';
  end if;

  if pg_catalog.cardinality(v_retire_source_ids) > 0 then
    perform event.id
    from public.shared_award_change_events event
    where event.shared_award_source_id = any(v_retire_source_ids)
      or (
        event.shared_award_id = v_expected_award_id
        and exists (
          select 1
          from public.shared_award_sources source_row
          where source_row.id = any(v_retire_source_ids)
            and source_row.url = event.source_url
        )
      )
    order by event.id
    for update;

    select pg_catalog.count(*)::integer
    into v_matched_event_count
    from public.shared_award_change_events event
    where event.shared_award_source_id = any(v_retire_source_ids)
      or (
        event.shared_award_id = v_expected_award_id
        and exists (
          select 1
          from public.shared_award_sources source_row
          where source_row.id = any(v_retire_source_ids)
            and source_row.url = event.source_url
        )
      );

    update public.shared_award_change_events event
    set
      suppressed_at = v_now,
      suppression_reason = v_reason,
      suppression_source = 'source_retirement'
    where (
      event.shared_award_source_id = any(v_retire_source_ids)
      or (
        event.shared_award_id = v_expected_award_id
        and exists (
          select 1
          from public.shared_award_sources source_row
          where source_row.id = any(v_retire_source_ids)
            and source_row.url = event.source_url
        )
      )
    )
      and event.suppressed_at is null;
    get diagnostics v_newly_suppressed_event_count = row_count;

    update public.shared_award_sources source_row
    set
      admin_review_status = 'review_later',
      admin_review_note = v_reason,
      admin_reviewed_at = v_now,
      admin_reviewed_by = v_actor,
      updated_at = v_now
    where source_row.shared_award_id = v_expected_award_id
      and source_row.id = any(v_retire_source_ids)
      and source_row.admin_review_status = 'open';
    get diagnostics v_source_update_count = row_count;
    if v_source_update_count <> pg_catalog.cardinality(v_retire_source_ids) then
      raise exception using
        errcode = '40001',
        message = 'Award source cleanup retirement CAS affected an unexpected row count; requeue cleanup.';
    end if;
  end if;

  if v_homepage_old is distinct from v_homepage_new then
    update public.shared_awards award
    set
      official_homepage = v_homepage_new,
      updated_at = v_now
    where award.id = v_expected_award_id
      and award.status = v_expected_award_status
      and award.updated_at = v_expected_award_updated_at
      and award.official_homepage is not distinct from v_homepage_old;
    get diagnostics v_award_update_count = row_count;
    if v_award_update_count <> 1 then
      raise exception using
        errcode = '40001',
        message = 'Award source cleanup homepage CAS affected zero rows; requeue cleanup.';
    end if;
  end if;

  shared_award_id := v_expected_award_id;
  retired_source_count := v_source_update_count;
  matched_event_count := v_matched_event_count;
  newly_suppressed_event_count := v_newly_suppressed_event_count;
  homepage_changed := v_homepage_old is distinct from v_homepage_new;
  return next;
exception
  when no_data_found then
    raise exception using
      errcode = '40001',
      message = 'Shared award disappeared after cleanup planning; requeue cleanup.';
end;
$$;

alter function public.apply_shared_award_source_cleanup_plan(
  jsonb,
  text,
  text
) owner to postgres;

revoke all on function public.apply_shared_award_source_cleanup_plan(
  jsonb,
  text,
  text
) from public, anon, authenticated, service_role;

grant execute on function public.apply_shared_award_source_cleanup_plan(
  jsonb,
  text,
  text
) to service_role;

comment on function public.apply_shared_award_source_cleanup_plan(
  jsonb,
  text,
  text
) is
  'Applies one award-scoped cleanup plan atomically under national, award, complete source-set, and event locks. Any award, sibling-source, useful-source, replacement, retirement, or homepage drift aborts and requeues the whole award plan.';
