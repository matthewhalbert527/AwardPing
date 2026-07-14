create schema if not exists private;
revoke all on schema private from public;

create table public.monitoring_feedback (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  feedback_kind text not null default 'not_an_update'
    check (feedback_kind = 'not_an_update'),
  actor_user_id uuid not null,
  actor_email text not null
    check (char_length(actor_email) between 3 and 320),
  event_id uuid not null,
  source_id uuid,
  award_id uuid not null,
  reason_code text not null
    check (
      reason_code in (
        'capture_noise',
        'content_churn',
        'duplicate_update',
        'out_of_scope',
        'not_applicant_facing',
        'other'
      )
    ),
  note text
    check (note is null or char_length(note) <= 1000),
  requested_scope text not null default 'event'
    check (requested_scope in ('event', 'source', 'award', 'global')),
  policy_rule_id text
    check (policy_rule_id is null or char_length(policy_rule_id) between 1 and 160),
  policy_identity text not null,
  policy_version text not null,
  policy_hash text not null,
  policy_config_version integer,
  decision_memory_version integer,
  promotion_status text not null
    check (promotion_status in ('pending_review', 'already_active')),
  suppression_applied_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table public.monitoring_feedback is
  'Append-only, private admin feedback about monitoring events. Broader requested scopes remain pending until a separate reviewed rule promotion is recorded.';
comment on column public.monitoring_feedback.event_id is
  'Logical shared_award_change_events ID, intentionally not a foreign key so the audit record survives later cleanup.';
comment on column public.monitoring_feedback.requested_scope is
  'Requested review scope only; it does not activate a source, award, or global rule.';
comment on column public.monitoring_feedback.promotion_status is
  'Immutable submission status. Novel feedback begins pending_review; a validated mapping to an active alert-blocking rule is already_active.';

create index monitoring_feedback_event_created_idx
  on public.monitoring_feedback (event_id, created_at desc);
create index monitoring_feedback_pending_scope_created_idx
  on public.monitoring_feedback (requested_scope, created_at)
  where promotion_status = 'pending_review';

alter table public.monitoring_feedback enable row level security;

-- This audit log is not a browser-facing Data API resource. It has no RLS
-- policies, and only the server-side service role receives the minimum grants.
revoke all on table public.monitoring_feedback from public, anon, authenticated, service_role;
grant select, insert on table public.monitoring_feedback to service_role;

create table public.monitoring_feedback_promotions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  feedback_id uuid not null unique
    references public.monitoring_feedback(id) on delete restrict,
  actor_user_id uuid not null,
  actor_email text not null
    check (char_length(actor_email) between 3 and 320),
  policy_rule_id text not null
    check (char_length(policy_rule_id) between 1 and 160),
  policy_identity text not null,
  policy_version text not null,
  policy_hash text not null,
  policy_config_version integer,
  decision_memory_version integer,
  note text
    check (note is null or char_length(note) <= 1000),
  created_at timestamptz not null default now()
);

comment on table public.monitoring_feedback_promotions is
  'Append-only resolutions that map pending monitoring feedback to a reviewed, active alert-blocking policy rule.';

create index monitoring_feedback_promotions_created_idx
  on public.monitoring_feedback_promotions (created_at desc);

alter table public.monitoring_feedback_promotions enable row level security;
revoke all on table public.monitoring_feedback_promotions
  from public, anon, authenticated, service_role;
grant select, insert on table public.monitoring_feedback_promotions to service_role;

create or replace function private.prevent_monitoring_feedback_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception '% is append-only', tg_table_name
    using errcode = '55000';
end;
$function$;

revoke execute on function private.prevent_monitoring_feedback_mutation()
  from public, anon, authenticated, service_role;

create trigger monitoring_feedback_append_only
before update or delete on public.monitoring_feedback
for each row execute function private.prevent_monitoring_feedback_mutation();

create trigger monitoring_feedback_promotions_append_only
before update or delete on public.monitoring_feedback_promotions
for each row execute function private.prevent_monitoring_feedback_mutation();

create or replace function public.record_monitoring_false_positive(
  p_request_id uuid,
  p_event_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_reason_code text,
  p_policy_identity text,
  p_policy_version text,
  p_policy_hash text,
  p_policy_config_version integer,
  p_decision_memory_version integer,
  p_note text default null,
  p_requested_scope text default 'event',
  p_policy_rule_id text default null
)
returns table (
  feedback_id uuid,
  suppressed_event_id uuid,
  award_id uuid,
  source_id uuid,
  suppressed_at timestamptz,
  promotion_status text
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_existing public.monitoring_feedback%rowtype;
  v_award_id uuid;
  v_source_id uuid;
  v_suppressed_at timestamptz;
  v_feedback_id uuid;
  v_now timestamptz := now();
  v_actor_email text := lower(btrim(coalesce(p_actor_email, '')));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_policy_rule_id text := nullif(btrim(coalesce(p_policy_rule_id, '')), '');
  v_promotion_status text;
begin
  if p_request_id is null or p_event_id is null or p_actor_user_id is null then
    raise exception 'request, event, and actor IDs are required'
      using errcode = '22004';
  end if;

  if char_length(v_actor_email) < 3 or char_length(v_actor_email) > 320 then
    raise exception 'a valid actor email is required'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_policy_identity, '')), '') is null
    or nullif(btrim(coalesce(p_policy_version, '')), '') is null
    or nullif(btrim(coalesce(p_policy_hash, '')), '') is null then
    raise exception 'monitoring policy identity, version, and hash are required'
      using errcode = '22023';
  end if;

  if char_length(coalesce(v_policy_rule_id, '')) > 160 then
    raise exception 'monitoring policy rule ID is too long'
      using errcode = '22023';
  end if;

  if p_reason_code not in (
    'capture_noise',
    'content_churn',
    'duplicate_update',
    'out_of_scope',
    'not_applicant_facing',
    'other'
  ) then
    raise exception 'invalid monitoring feedback reason'
      using errcode = '22023';
  end if;

  if p_requested_scope not in ('event', 'source', 'award', 'global') then
    raise exception 'invalid monitoring feedback scope'
      using errcode = '22023';
  end if;

  if char_length(coalesce(v_note, '')) > 1000 then
    raise exception 'monitoring feedback note is too long'
      using errcode = '22023';
  end if;

  if (p_reason_code = 'other' or p_requested_scope <> 'event') and v_note is null then
    raise exception 'a note is required for this reason or scope'
      using errcode = '22023';
  end if;

  select feedback.*
    into v_existing
  from public.monitoring_feedback feedback
  where feedback.request_id = p_request_id;

  if found then
    if v_existing.event_id <> p_event_id
      or v_existing.actor_user_id <> p_actor_user_id then
      raise exception 'request ID was already used for different feedback'
        using errcode = '22023';
    end if;

    return query
      select
        v_existing.id,
        v_existing.event_id,
        v_existing.award_id,
        v_existing.source_id,
        v_existing.suppression_applied_at,
        v_existing.promotion_status;
    return;
  end if;

  select
    change_event.shared_award_id,
    change_event.shared_award_source_id,
    change_event.suppressed_at
  into v_award_id, v_source_id, v_suppressed_at
  from public.shared_award_change_events change_event
  where change_event.id = p_event_id
  for update;

  if not found then
    raise exception 'monitoring event was not found'
      using errcode = 'P0002';
  end if;

  if v_suppressed_at is not null then
    raise exception 'monitoring event is already suppressed'
      using errcode = 'P0001';
  end if;

  v_promotion_status := case
    when v_policy_rule_id is not null then 'already_active'
    else 'pending_review'
  end;

  update public.shared_award_change_events
  set
    suppressed_at = v_now,
    suppression_reason = 'admin_feedback:' || p_reason_code,
    suppression_source = 'admin_feedback'
  where id = p_event_id;

  insert into public.monitoring_feedback (
    request_id,
    actor_user_id,
    actor_email,
    event_id,
    source_id,
    award_id,
    reason_code,
    note,
    requested_scope,
    policy_rule_id,
    policy_identity,
    policy_version,
    policy_hash,
    policy_config_version,
    decision_memory_version,
    promotion_status,
    suppression_applied_at
  ) values (
    p_request_id,
    p_actor_user_id,
    v_actor_email,
    p_event_id,
    v_source_id,
    v_award_id,
    p_reason_code,
    v_note,
    p_requested_scope,
    v_policy_rule_id,
    p_policy_identity,
    p_policy_version,
    p_policy_hash,
    p_policy_config_version,
    p_decision_memory_version,
    v_promotion_status,
    v_now
  )
  returning id into v_feedback_id;

  return query
    select
      v_feedback_id,
      p_event_id,
      v_award_id,
      v_source_id,
      v_now,
      v_promotion_status;
end;
$function$;

revoke execute on function public.record_monitoring_false_positive(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  text,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.record_monitoring_false_positive(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  text,
  text,
  text
) to service_role;

grant select, update on table public.shared_award_change_events to service_role;

create or replace function public.record_monitoring_feedback_promotion(
  p_request_id uuid,
  p_feedback_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_policy_rule_id text,
  p_policy_identity text,
  p_policy_version text,
  p_policy_hash text,
  p_policy_config_version integer,
  p_decision_memory_version integer,
  p_note text default null
)
returns table (
  promotion_id uuid,
  promoted_feedback_id uuid,
  active_policy_rule_id text,
  promoted_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_existing public.monitoring_feedback_promotions%rowtype;
  v_feedback_status text;
  v_promotion_id uuid;
  v_now timestamptz := now();
  v_actor_email text := lower(btrim(coalesce(p_actor_email, '')));
  v_policy_rule_id text := nullif(btrim(coalesce(p_policy_rule_id, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_request_id is null or p_feedback_id is null or p_actor_user_id is null then
    raise exception 'request, feedback, and actor IDs are required'
      using errcode = '22004';
  end if;

  if char_length(v_actor_email) < 3 or char_length(v_actor_email) > 320 then
    raise exception 'a valid actor email is required'
      using errcode = '22023';
  end if;

  if v_policy_rule_id is null or char_length(v_policy_rule_id) > 160 then
    raise exception 'an active policy rule ID is required'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_policy_identity, '')), '') is null
    or nullif(btrim(coalesce(p_policy_version, '')), '') is null
    or nullif(btrim(coalesce(p_policy_hash, '')), '') is null then
    raise exception 'monitoring policy identity, version, and hash are required'
      using errcode = '22023';
  end if;

  if char_length(coalesce(v_note, '')) > 1000 then
    raise exception 'monitoring feedback promotion note is too long'
      using errcode = '22023';
  end if;

  select promotion.*
  into v_existing
  from public.monitoring_feedback_promotions promotion
  where promotion.request_id = p_request_id;

  if found then
    if v_existing.feedback_id <> p_feedback_id
      or v_existing.actor_user_id <> p_actor_user_id then
      raise exception 'request ID was already used for a different promotion'
        using errcode = '22023';
    end if;

    return query
      select
        v_existing.id,
        v_existing.feedback_id,
        v_existing.policy_rule_id,
        v_existing.created_at;
    return;
  end if;

  select feedback.promotion_status
  into v_feedback_status
  from public.monitoring_feedback feedback
  where feedback.id = p_feedback_id
  for share;

  if not found then
    raise exception 'monitoring feedback was not found'
      using errcode = 'P0002';
  end if;

  if v_feedback_status <> 'pending_review' then
    raise exception 'monitoring feedback is already covered by an active rule'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.monitoring_feedback_promotions promotion
    where promotion.feedback_id = p_feedback_id
  ) then
    raise exception 'monitoring feedback is already promoted'
      using errcode = 'P0001';
  end if;

  insert into public.monitoring_feedback_promotions (
    request_id,
    feedback_id,
    actor_user_id,
    actor_email,
    policy_rule_id,
    policy_identity,
    policy_version,
    policy_hash,
    policy_config_version,
    decision_memory_version,
    note
  ) values (
    p_request_id,
    p_feedback_id,
    p_actor_user_id,
    v_actor_email,
    v_policy_rule_id,
    p_policy_identity,
    p_policy_version,
    p_policy_hash,
    p_policy_config_version,
    p_decision_memory_version,
    v_note
  )
  returning id into v_promotion_id;

  return query
    select v_promotion_id, p_feedback_id, v_policy_rule_id, v_now;
end;
$function$;

revoke execute on function public.record_monitoring_feedback_promotion(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  text
) from public, anon, authenticated;
grant execute on function public.record_monitoring_feedback_promotion(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  text
) to service_role;
