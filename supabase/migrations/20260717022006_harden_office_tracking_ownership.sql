-- Office award tracking is tenant-owned state. Creator user ids are audit
-- metadata, not the lifetime owner of the row, and browser roles must mutate
-- this graph only through the reviewed transactional RPCs.

-- Repair only missing legacy tenant keys before making office_id authoritative.
-- A non-null cross-office relationship is not safe to "repair" automatically:
-- the retired user-owned policies allowed a caller to supply an award_id without
-- proving that the award belonged to the same office. Moving such a child row to
-- the award's office would turn legacy cross-tenant injection into victim-owned
-- data. The validation below therefore fails closed on every mismatch.

update public.awards award
set office_id = (
  select member.office_id
  from public.office_members member
  where member.user_id = award.user_id
    and member.status = 'active'
  order by member.joined_at, member.created_at, member.id
  limit 1
)
where award.office_id is null
  and award.user_id is not null;

update public.award_sources source
set office_id = award.office_id
from public.awards award
where source.award_id = award.id
  and source.office_id is null;

update public.monitors monitor
set office_id = coalesce(
  (
    select award.office_id
    from public.awards award
    where award.id = monitor.award_id
  ),
  (
    select member.office_id
    from public.office_members member
    where member.user_id = monitor.user_id
      and member.status = 'active'
    order by member.joined_at, member.created_at, member.id
    limit 1
  )
)
where monitor.office_id is null;

do $$
begin
  if exists (select 1 from public.awards where office_id is null)
    or exists (select 1 from public.award_sources where office_id is null)
    or exists (select 1 from public.monitors where office_id is null) then
    raise exception using
      errcode = '23502',
      message = 'Office tracking rows must be assigned to an office before ownership hardening.';
  end if;

  if exists (
    select 1
    from public.award_sources source
    join public.awards award on award.id = source.award_id
    where source.office_id is distinct from award.office_id
  ) or exists (
    select 1
    from public.monitors monitor
    join public.awards award on award.id = monitor.award_id
    where monitor.office_id is distinct from award.office_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cross-office award tracking relationships require reviewed manual repair.';
  end if;
end;
$$;

-- Auth-user deletion must not erase the office's cards, evidence links, notes,
-- or tasks. The office is the owner; these nullable columns retain creator
-- attribution only while the account exists.
alter table public.awards
  drop constraint if exists awards_user_id_fkey;
alter table public.awards
  alter column office_id set not null,
  alter column user_id drop not null,
  add constraint awards_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete set null;

alter table public.award_sources
  drop constraint if exists award_sources_user_id_fkey;
alter table public.award_sources
  alter column office_id set not null,
  alter column user_id drop not null,
  add constraint award_sources_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete set null;

alter table public.monitors
  drop constraint if exists monitors_user_id_fkey;
alter table public.monitors
  alter column office_id set not null,
  alter column user_id drop not null,
  add constraint monitors_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete set null;

alter table public.award_notes
  drop constraint if exists award_notes_author_user_id_fkey;
alter table public.award_notes
  alter column author_user_id drop not null,
  add constraint award_notes_author_user_id_fkey
    foreign key (author_user_id) references auth.users(id) on delete set null;

alter table public.award_tasks
  drop constraint if exists award_tasks_created_by_user_id_fkey;
alter table public.award_tasks
  alter column created_by_user_id drop not null,
  add constraint award_tasks_created_by_user_id_fkey
    foreign key (created_by_user_id) references auth.users(id) on delete set null;

comment on column public.awards.user_id is
  'Nullable creator attribution. office_id is the authoritative tenant owner.';
comment on column public.award_sources.user_id is
  'Nullable creator attribution. office_id is the authoritative tenant owner.';
comment on column public.monitors.user_id is
  'Nullable creator attribution. office_id is the authoritative tenant owner.';
comment on column public.award_notes.author_user_id is
  'Nullable author attribution retained only while the auth user exists.';
comment on column public.award_tasks.created_by_user_id is
  'Nullable creator attribution retained only while the auth user exists.';

-- Enforce that award-bound sources and monitors belong to the same office as
-- their award. A detached monitor remains office-owned and may have no award.
alter table public.awards
  add constraint awards_id_office_id_key unique (id, office_id);

alter table public.award_sources
  drop constraint if exists award_sources_award_id_fkey,
  add constraint award_sources_award_office_fkey
    foreign key (award_id, office_id)
    references public.awards(id, office_id)
    on delete cascade;

alter table public.monitors
  drop constraint if exists monitors_award_id_fkey,
  add constraint monitors_award_office_fkey
    foreign key (award_id, office_id)
    references public.awards(id, office_id)
    on delete set null (award_id);

-- Remove the legacy creator-owned mutation paths and the unrestricted office
-- workflow UPDATE policy. Office reads remain available through the existing
-- office-visible SELECT policies.
drop policy if exists "awards are user owned" on public.awards;
drop policy if exists "award sources are user owned" on public.award_sources;
drop policy if exists "monitors are user owned" on public.monitors;
drop policy if exists "awards workflow editable by office members" on public.awards;

revoke insert, update, delete, truncate, references, trigger
  on table public.awards from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.award_sources from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.monitors from anon, authenticated;

grant select on table public.awards to authenticated;
grant select on table public.award_sources to authenticated;
grant select on table public.monitors to authenticated;
grant select, insert, update, delete on table public.awards to service_role;
grant select, insert, update, delete on table public.award_sources to service_role;
grant select, insert, update, delete on table public.monitors to service_role;

create index if not exists shared_award_change_events_first_monitor_idx
  on public.shared_award_change_events (first_reported_by_monitor_id)
  where first_reported_by_monitor_id is not null;

-- Consolidation may move mutable local history to the canonical monitor, but
-- published shared-event attribution is immutable evidence. If a losing
-- monitor is referenced by any shared event, retain it as a paused, detached
-- tombstone rather than rewriting the event or allowing its FK to null out.
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

    if exists (
      select 1
      from public.shared_award_change_events event
      where event.first_reported_by_monitor_id = v_duplicate.duplicate_id
    ) then
      update public.monitors monitor
      set award_id = null,
          status = 'paused',
          updated_at = statement_timestamp()
      where monitor.id = v_duplicate.duplicate_id
        and monitor.office_id = p_office_id;
    else
      delete from public.monitors monitor
      where monitor.id = v_duplicate.duplicate_id
        and monitor.office_id = p_office_id;
    end if;
  end loop;

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

-- Source intake is server-validated (including DNS/SSRF checks) before this
-- service-only RPC is called. The RPC keeps creation of the office award,
-- selected sources, and monitors in one database transaction.
create or replace function public.create_office_award_tracking_from_intake(
  p_actor_user_id uuid,
  p_office_id uuid,
  p_shared_award_id uuid,
  p_shared_award_source_ids uuid[],
  p_cadence text default 'daily'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shared_award public.shared_awards%rowtype;
  v_selected_source_ids uuid[];
  v_canonical_office_award_id uuid;
  v_source public.shared_award_sources%rowtype;
  v_source_row_id uuid;
  v_monitor_id uuid;
  v_result jsonb;
begin
  if p_actor_user_id is null or p_office_id is null or p_shared_award_id is null then
    raise exception using errcode = '22023', message = 'Tracking identity is incomplete.';
  end if;
  if p_cadence <> 'daily' then
    raise exception using errcode = '22023', message = 'Unsupported tracking cadence.';
  end if;
  if p_shared_award_source_ids is null
    or pg_catalog.cardinality(p_shared_award_source_ids) = 0 then
    raise exception using errcode = '22023', message = 'Choose at least one source.';
  end if;

  perform 1
  from public.office_members member
  where member.office_id = p_office_id
    and member.user_id = p_actor_user_id
    and member.status = 'active'
    and member.role in ('owner', 'admin')
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'Office owner or admin access is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'office-award-intake:' || p_office_id::text || ':' || p_shared_award_id::text,
      0
    )
  );

  select coalesce(
    pg_catalog.array_agg(source_id order by source_id),
    '{}'::uuid[]
  )
  into v_selected_source_ids
  from (
    select distinct pg_catalog.unnest(p_shared_award_source_ids) as source_id
  ) selected;

  if pg_catalog.cardinality(v_selected_source_ids)
      <> pg_catalog.cardinality(p_shared_award_source_ids) then
    raise exception using errcode = '22023', message = 'Selected sources contain duplicates.';
  end if;

  select * into v_shared_award
  from public.shared_awards award
  where award.id = p_shared_award_id
    and award.status = 'active'
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'Shared award was not found.';
  end if;

  if (
    select count(*)
    from public.shared_award_sources source
    where source.id = any(v_selected_source_ids)
      and source.shared_award_id = p_shared_award_id
      and source.admin_review_status = 'open'
  ) <> pg_catalog.cardinality(v_selected_source_ids) then
    raise exception using errcode = '40001', message = 'Selected source identity is stale.';
  end if;

  if (
    select count(distinct private.office_tracking_source_url_key(source.url))
    from public.shared_award_sources source
    where source.id = any(v_selected_source_ids)
  ) <> pg_catalog.cardinality(v_selected_source_ids) then
    raise exception using errcode = '22023', message = 'Selected sources contain duplicate URLs.';
  end if;

  perform 1
  from public.shared_award_sources source
  where source.id = any(v_selected_source_ids)
  order by source.id
  for share;

  perform 1
  from public.awards award
  where award.office_id = p_office_id
    and award.shared_award_id = p_shared_award_id
  order by award.id
  for update;

  select award.id into v_canonical_office_award_id
  from public.awards award
  where award.office_id = p_office_id
    and award.shared_award_id = p_shared_award_id
  order by
    (award.status = 'active') desc,
    award.created_at,
    award.id
  limit 1;

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
      p_actor_user_id,
      p_shared_award_id,
      v_shared_award.name,
      v_shared_award.official_homepage,
      v_shared_award.summary,
      v_shared_award.confidence,
      'active'
    ) returning id into v_canonical_office_award_id;
  else
    perform private.consolidate_office_award_tracking(
      p_office_id,
      v_canonical_office_award_id,
      p_shared_award_id,
      array[p_shared_award_id],
      v_selected_source_ids
    );
  end if;

  update public.awards award
  set shared_award_id = p_shared_award_id,
      name = v_shared_award.name,
      official_homepage = v_shared_award.official_homepage,
      summary = v_shared_award.summary,
      confidence = v_shared_award.confidence,
      status = 'active',
      updated_at = statement_timestamp()
  where award.id = v_canonical_office_award_id
    and award.office_id = p_office_id;
  if not found then
    raise exception using errcode = '40001', message = 'Office award changed during source intake.';
  end if;

  for v_source in
    select source.*
    from public.shared_award_sources source
    where source.id = any(v_selected_source_ids)
    order by source.id
  loop
    v_source_row_id := null;
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
        p_actor_user_id,
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
        p_actor_user_id,
        v_canonical_office_award_id,
        v_source.id,
        v_shared_award.name || ' - ' || case v_source.page_type
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
          label = v_shared_award.name || ' - ' || case v_source.page_type
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
    ), '[]'::jsonb)
  ) into v_result
  from public.awards award
  where award.id = v_canonical_office_award_id
    and award.office_id = p_office_id;

  return v_result;
end;
$$;

revoke all on function public.create_office_award_tracking_from_intake(
  uuid, uuid, uuid, uuid[], text
) from public, anon, authenticated, service_role;
grant execute on function public.create_office_award_tracking_from_intake(
  uuid, uuid, uuid, uuid[], text
) to service_role;
