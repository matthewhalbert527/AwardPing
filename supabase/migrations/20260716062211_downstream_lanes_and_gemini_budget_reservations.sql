-- Durable, account-wide Gemini API budgets and independently leased downstream lanes.
-- Money is stored as integer micro-USD so reservation arithmetic is exact.

create table public.gemini_paid_lanes (
  lane_key text primary key,
  daily_cap_micro_usd bigint not null default 5000000,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint gemini_paid_lanes_key_check check (
    lane_key in ('new_page_review', 'changed_page_review')
  ),
  constraint gemini_paid_lanes_fixed_cap_check check (
    daily_cap_micro_usd = 5000000
  )
);

insert into public.gemini_paid_lanes (lane_key, daily_cap_micro_usd)
values
  ('new_page_review', 5000000),
  ('changed_page_review', 5000000);

create table public.gemini_spend_days (
  budget_date date not null,
  lane_key text not null references public.gemini_paid_lanes(lane_key) on delete restrict,
  reserved_micro_usd bigint not null default 0 check (reserved_micro_usd >= 0),
  spent_micro_usd bigint not null default 0 check (spent_micro_usd >= 0),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (budget_date, lane_key)
);

create table public.gemini_spend_reservations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  reservation_key text not null unique,
  attempt_token uuid not null,
  work_fingerprint text not null,
  lane_key text not null references public.gemini_paid_lanes(lane_key) on delete restrict,
  budget_date date not null,
  status text not null default 'reserved' check (
    status in ('reserved', 'creating', 'submitted', 'settled', 'released')
  ),
  reserved_micro_usd bigint not null check (reserved_micro_usd > 0),
  spent_micro_usd bigint not null default 0 check (spent_micro_usd >= 0),
  worker_source text not null,
  worker_run_id uuid,
  request_count integer not null check (request_count > 0),
  model text not null,
  metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(metadata) = 'object'
  ),
  provider_batch_name text unique,
  usage jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(usage) = 'object'
  ),
  spent_source text,
  release_reason text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  create_started_at timestamptz,
  submitted_at timestamptz,
  settled_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint gemini_spend_reservations_key_check check (
    pg_catalog.length(pg_catalog.btrim(reservation_key)) between 1 and 500
  ),
  constraint gemini_spend_reservations_work_fingerprint_check check (
    pg_catalog.length(pg_catalog.btrim(work_fingerprint)) between 1 and 500
  ),
  constraint gemini_spend_reservations_worker_source_check check (
    pg_catalog.length(pg_catalog.btrim(worker_source)) between 1 and 200
  ),
  constraint gemini_spend_reservations_model_check check (
    pg_catalog.length(pg_catalog.btrim(model)) between 1 and 200
  ),
  constraint gemini_spend_reservations_day_fk foreign key (budget_date, lane_key)
    references public.gemini_spend_days(budget_date, lane_key) on delete restrict,
  constraint gemini_spend_reservations_settlement_check check (
    status <> 'settled'
    or (
      settled_at is not null
      and spent_source is not null
      and pg_catalog.length(pg_catalog.btrim(spent_source)) > 0
    )
  ),
  constraint gemini_spend_reservations_release_check check (
    status <> 'released'
    or (
      released_at is not null
      and release_reason is not null
      and pg_catalog.length(pg_catalog.btrim(release_reason)) > 0
    )
  )
);

create index gemini_spend_reservations_lane_day_status_idx
  on public.gemini_spend_reservations (lane_key, budget_date, status, created_at);

create unique index gemini_spend_reservations_one_active_work_idx
  on public.gemini_spend_reservations (work_fingerprint)
  where status in ('reserved', 'creating', 'submitted');

create table public.gemini_spend_events (
  id bigint generated always as identity primary key,
  reservation_id uuid not null references public.gemini_spend_reservations(id) on delete restrict,
  lane_key text not null,
  budget_date date not null,
  event_type text not null check (
    event_type in ('reserved', 'create_started', 'submitted', 'settled', 'released')
  ),
  reserved_delta_micro_usd bigint not null default 0,
  spent_delta_micro_usd bigint not null default 0,
  details jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(details) = 'object'
  ),
  occurred_at timestamptz not null default pg_catalog.clock_timestamp()
);

create index gemini_spend_events_reservation_time_idx
  on public.gemini_spend_events (reservation_id, occurred_at, id);

create or replace function public.prevent_gemini_spend_event_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'gemini_spend_events is append-only';
end;
$$;

create trigger gemini_spend_events_append_only
before update or delete on public.gemini_spend_events
for each row execute function public.prevent_gemini_spend_event_mutation();

alter table public.gemini_paid_lanes enable row level security;
alter table public.gemini_spend_days enable row level security;
alter table public.gemini_spend_reservations enable row level security;
alter table public.gemini_spend_events enable row level security;

revoke all on table public.gemini_paid_lanes
  from public, anon, authenticated, service_role;
revoke all on table public.gemini_spend_days
  from public, anon, authenticated, service_role;
revoke all on table public.gemini_spend_reservations
  from public, anon, authenticated, service_role;
revoke all on table public.gemini_spend_events
  from public, anon, authenticated, service_role;
revoke all on sequence public.gemini_spend_events_id_seq
  from public, anon, authenticated, service_role;

grant select on table public.gemini_paid_lanes to service_role;
grant select on table public.gemini_spend_days to service_role;
grant select on table public.gemini_spend_reservations to service_role;
grant select on table public.gemini_spend_events to service_role;

revoke all on function public.prevent_gemini_spend_event_mutation()
  from public, anon, authenticated, service_role;

create or replace function public.reserve_gemini_spend(
  p_lane_key text,
  p_reservation_key text,
  p_attempt_token uuid,
  p_work_fingerprint text,
  p_estimated_micro_usd bigint,
  p_worker_source text,
  p_worker_run_id uuid,
  p_request_count integer,
  p_model text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_budget_date date := (v_now at time zone 'UTC')::date;
  v_reset_at timestamptz := ((v_budget_date + 1)::timestamp at time zone 'UTC');
  v_cap bigint;
  v_key text := pg_catalog.btrim(p_reservation_key);
  v_work_fingerprint text := pg_catalog.btrim(p_work_fingerprint);
  v_worker_source text := pg_catalog.btrim(p_worker_source);
  v_model text := pg_catalog.btrim(p_model);
  v_existing public.gemini_spend_reservations%rowtype;
  v_day public.gemini_spend_days%rowtype;
  v_reservation public.gemini_spend_reservations%rowtype;
  v_remaining bigint;
begin
  if p_lane_key is null then
    raise exception 'lane_key is required';
  end if;
  if v_key is null or pg_catalog.length(v_key) = 0 or pg_catalog.length(v_key) > 500 then
    raise exception 'reservation_key must contain 1 to 500 characters';
  end if;
  if p_attempt_token is null then
    raise exception 'attempt_token is required';
  end if;
  if v_work_fingerprint is null
    or pg_catalog.length(v_work_fingerprint) = 0
    or pg_catalog.length(v_work_fingerprint) > 500
  then
    raise exception 'work_fingerprint must contain 1 to 500 characters';
  end if;
  if p_estimated_micro_usd is null or p_estimated_micro_usd <= 0 then
    raise exception 'estimated_micro_usd must be greater than zero';
  end if;
  if v_worker_source is null or pg_catalog.length(v_worker_source) = 0 or pg_catalog.length(v_worker_source) > 200 then
    raise exception 'worker_source must contain 1 to 200 characters';
  end if;
  if p_request_count is null or p_request_count <= 0 then
    raise exception 'request_count must be greater than zero';
  end if;
  if v_model is null or pg_catalog.length(v_model) = 0 or pg_catalog.length(v_model) > 200 then
    raise exception 'model must contain 1 to 200 characters';
  end if;
  if p_metadata is null or pg_catalog.jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'metadata must be a JSON object';
  end if;

  select lane.daily_cap_micro_usd
  into v_cap
  from public.gemini_paid_lanes lane
  where lane.lane_key = p_lane_key;
  if not found then
    raise exception 'unknown paid Gemini lane: %', p_lane_key;
  end if;

  -- Serialize every attempt for the same billable work before inspecting its
  -- attempt-specific idempotency key. This makes the active-work unique index
  -- a durable guard as well as a final database constraint.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_work_fingerprint, 714311681)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_key, 714311682)
  );

  select reservation.*
  into v_existing
  from public.gemini_spend_reservations reservation
  where reservation.reservation_key = v_key
  for update;

  if found then
    if v_existing.lane_key is distinct from p_lane_key
      or v_existing.attempt_token is distinct from p_attempt_token
      or v_existing.work_fingerprint is distinct from v_work_fingerprint
      or v_existing.reserved_micro_usd is distinct from p_estimated_micro_usd
      or v_existing.worker_source is distinct from v_worker_source
      or v_existing.worker_run_id is distinct from p_worker_run_id
      or v_existing.request_count is distinct from p_request_count
      or v_existing.model is distinct from v_model
      or v_existing.metadata is distinct from p_metadata
    then
      raise exception 'reservation_key % was already used with a different payload', v_key;
    end if;

    select day.*
    into strict v_day
    from public.gemini_spend_days day
    where day.budget_date = v_existing.budget_date
      and day.lane_key = v_existing.lane_key;

    v_remaining := greatest(v_cap - v_day.reserved_micro_usd - v_day.spent_micro_usd, 0);
    return pg_catalog.jsonb_build_object(
      'granted', v_existing.status <> 'released',
      'can_submit', v_existing.status = 'reserved',
      'already_exists', true,
      'reason', case
        when v_existing.status = 'reserved' then 'already_reserved'
        when v_existing.status = 'creating' then 'provider_create_already_started'
        when v_existing.status = 'submitted' then 'already_submitted'
        when v_existing.status = 'settled' then 'already_settled'
        else 'already_released'
      end,
      'reservation_id', v_existing.id,
      'reservation_key', v_existing.reservation_key,
      'work_fingerprint', v_existing.work_fingerprint,
      'status', v_existing.status,
      'lane_key', v_existing.lane_key,
      'budget_date', v_existing.budget_date,
      'cap_micro_usd', v_cap,
      'reserved_micro_usd', v_day.reserved_micro_usd,
      'spent_micro_usd', v_day.spent_micro_usd,
      'remaining_micro_usd', v_remaining,
      'reset_at', ((v_existing.budget_date + 1)::timestamp at time zone 'UTC'),
      'source', 'postgres_atomic_budget_v1'
    );
  end if;

  select reservation.*
  into v_existing
  from public.gemini_spend_reservations reservation
  where reservation.work_fingerprint = v_work_fingerprint
    and reservation.status in ('reserved', 'creating', 'submitted')
  for update;

  if found then
    return pg_catalog.jsonb_build_object(
      'granted', false,
      'can_submit', false,
      'already_exists', false,
      'reason', 'active_work_reservation_exists',
      'reservation_id', null,
      'active_reservation_id', v_existing.id,
      'reservation_key', v_key,
      'work_fingerprint', v_work_fingerprint,
      'status', 'denied',
      'active_status', v_existing.status,
      'lane_key', p_lane_key,
      'budget_date', v_budget_date,
      'cap_micro_usd', v_cap,
      'reset_at', v_reset_at,
      'source', 'postgres_atomic_budget_v1'
    );
  end if;

  insert into public.gemini_spend_days (
    budget_date,
    lane_key,
    reserved_micro_usd,
    spent_micro_usd,
    created_at,
    updated_at
  ) values (
    v_budget_date,
    p_lane_key,
    0,
    0,
    v_now,
    v_now
  )
  on conflict (budget_date, lane_key) do nothing;

  select day.*
  into strict v_day
  from public.gemini_spend_days day
  where day.budget_date = v_budget_date
    and day.lane_key = p_lane_key
  for update;

  v_remaining := greatest(v_cap - v_day.reserved_micro_usd - v_day.spent_micro_usd, 0);
  if p_estimated_micro_usd > v_remaining then
    return pg_catalog.jsonb_build_object(
      'granted', false,
      'can_submit', false,
      'already_exists', false,
      'reason', 'daily_lane_cap_exceeded',
      'reservation_id', null,
      'reservation_key', v_key,
      'work_fingerprint', v_work_fingerprint,
      'status', 'denied',
      'lane_key', p_lane_key,
      'budget_date', v_budget_date,
      'cap_micro_usd', v_cap,
      'requested_micro_usd', p_estimated_micro_usd,
      'reserved_micro_usd', v_day.reserved_micro_usd,
      'spent_micro_usd', v_day.spent_micro_usd,
      'remaining_micro_usd', v_remaining,
      'reset_at', v_reset_at,
      'source', 'postgres_atomic_budget_v1'
    );
  end if;

  update public.gemini_spend_days
  set
    reserved_micro_usd = reserved_micro_usd + p_estimated_micro_usd,
    updated_at = v_now
  where budget_date = v_budget_date
    and lane_key = p_lane_key;

  insert into public.gemini_spend_reservations (
    reservation_key,
    attempt_token,
    work_fingerprint,
    lane_key,
    budget_date,
    status,
    reserved_micro_usd,
    worker_source,
    worker_run_id,
    request_count,
    model,
    metadata,
    created_at,
    updated_at
  ) values (
    v_key,
    p_attempt_token,
    v_work_fingerprint,
    p_lane_key,
    v_budget_date,
    'reserved',
    p_estimated_micro_usd,
    v_worker_source,
    p_worker_run_id,
    p_request_count,
    v_model,
    p_metadata,
    v_now,
    v_now
  )
  returning * into v_reservation;

  insert into public.gemini_spend_events (
    reservation_id,
    lane_key,
    budget_date,
    event_type,
    reserved_delta_micro_usd,
    spent_delta_micro_usd,
    details,
    occurred_at
  ) values (
    v_reservation.id,
    p_lane_key,
    v_budget_date,
    'reserved',
    p_estimated_micro_usd,
    0,
    pg_catalog.jsonb_build_object(
      'reservation_key', v_key,
      'work_fingerprint', v_work_fingerprint,
      'worker_source', v_worker_source,
      'worker_run_id', p_worker_run_id,
      'request_count', p_request_count,
      'model', v_model,
      'metadata', p_metadata
    ),
    v_now
  );

  v_remaining := v_remaining - p_estimated_micro_usd;
  return pg_catalog.jsonb_build_object(
    'granted', true,
    'can_submit', true,
    'already_exists', false,
    'reason', 'reserved',
    'reservation_id', v_reservation.id,
    'reservation_key', v_key,
    'work_fingerprint', v_work_fingerprint,
    'status', 'reserved',
    'lane_key', p_lane_key,
    'budget_date', v_budget_date,
    'cap_micro_usd', v_cap,
    'reserved_micro_usd', v_day.reserved_micro_usd + p_estimated_micro_usd,
    'spent_micro_usd', v_day.spent_micro_usd,
    'remaining_micro_usd', v_remaining,
    'reset_at', v_reset_at,
    'source', 'postgres_atomic_budget_v1'
  );
end;
$$;

revoke all on function public.reserve_gemini_spend(text, text, uuid, text, bigint, text, uuid, integer, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_gemini_spend(text, text, uuid, text, bigint, text, uuid, integer, text, jsonb)
  to service_role;

create or replace function public.mark_gemini_spend_create_started(
  p_reservation_id uuid,
  p_attempt_token uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_reservation public.gemini_spend_reservations%rowtype;
begin
  if p_reservation_id is null then
    raise exception 'reservation_id is required';
  end if;
  if p_attempt_token is null then
    raise exception 'attempt_token is required';
  end if;
  if p_metadata is null or pg_catalog.jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'metadata must be a JSON object';
  end if;

  select reservation.*
  into v_reservation
  from public.gemini_spend_reservations reservation
  where reservation.id = p_reservation_id
  for update;
  if not found then
    raise exception 'Gemini spend reservation % was not found', p_reservation_id;
  end if;
  if v_reservation.attempt_token is distinct from p_attempt_token then
    raise exception 'attempt token does not own Gemini spend reservation %', p_reservation_id;
  end if;

  if v_reservation.status in ('creating', 'submitted', 'settled') then
    return pg_catalog.jsonb_build_object(
      'create_allowed', false,
      'create_started', true,
      'already_started', true,
      'reservation_id', v_reservation.id,
      'status', v_reservation.status,
      'create_started_at', v_reservation.create_started_at,
      'source', 'postgres_atomic_budget_v1'
    );
  end if;
  if v_reservation.status = 'released' then
    raise exception 'released reservation % cannot start provider create', p_reservation_id;
  end if;

  update public.gemini_spend_reservations
  set
    status = 'creating',
    create_started_at = v_now,
    metadata = metadata || p_metadata,
    updated_at = v_now
  where id = p_reservation_id;

  insert into public.gemini_spend_events (
    reservation_id,
    lane_key,
    budget_date,
    event_type,
    details,
    occurred_at
  ) values (
    v_reservation.id,
    v_reservation.lane_key,
    v_reservation.budget_date,
    'create_started',
    p_metadata,
    v_now
  );

  return pg_catalog.jsonb_build_object(
    'create_allowed', true,
    'create_started', true,
    'already_started', false,
    'reservation_id', v_reservation.id,
    'status', 'creating',
    'create_started_at', v_now,
    'source', 'postgres_atomic_budget_v1'
  );
end;
$$;

revoke all on function public.mark_gemini_spend_create_started(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_gemini_spend_create_started(uuid, uuid, jsonb)
  to service_role;

create or replace function public.submit_gemini_spend_reservation(
  p_reservation_id uuid,
  p_attempt_token uuid,
  p_provider_batch_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_provider_batch_name text := pg_catalog.btrim(p_provider_batch_name);
  v_reservation public.gemini_spend_reservations%rowtype;
begin
  if p_reservation_id is null then
    raise exception 'reservation_id is required';
  end if;
  if p_attempt_token is null then
    raise exception 'attempt_token is required';
  end if;
  if v_provider_batch_name is null
    or pg_catalog.length(v_provider_batch_name) = 0
    or pg_catalog.length(v_provider_batch_name) > 500
  then
    raise exception 'provider_batch_name must contain 1 to 500 characters';
  end if;

  select reservation.*
  into v_reservation
  from public.gemini_spend_reservations reservation
  where reservation.id = p_reservation_id
  for update;
  if not found then
    raise exception 'Gemini spend reservation % was not found', p_reservation_id;
  end if;
  if v_reservation.attempt_token is distinct from p_attempt_token then
    raise exception 'attempt token does not own Gemini spend reservation %', p_reservation_id;
  end if;

  if v_reservation.status in ('submitted', 'settled') then
    if v_reservation.provider_batch_name is distinct from v_provider_batch_name then
      raise exception 'reservation % is already bound to a different provider batch', p_reservation_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'submitted', true,
      'already_submitted', true,
      'reservation_id', v_reservation.id,
      'status', v_reservation.status,
      'provider_batch_name', v_reservation.provider_batch_name,
      'source', 'postgres_atomic_budget_v1'
    );
  end if;

  if v_reservation.status = 'released' then
    raise exception 'released reservation % cannot be submitted', p_reservation_id;
  end if;
  if v_reservation.status = 'reserved' then
    raise exception 'reservation % must record provider-create start before submission', p_reservation_id;
  end if;

  update public.gemini_spend_reservations
  set
    status = 'submitted',
    provider_batch_name = v_provider_batch_name,
    submitted_at = v_now,
    updated_at = v_now
  where id = p_reservation_id;

  insert into public.gemini_spend_events (
    reservation_id,
    lane_key,
    budget_date,
    event_type,
    details,
    occurred_at
  ) values (
    v_reservation.id,
    v_reservation.lane_key,
    v_reservation.budget_date,
    'submitted',
    pg_catalog.jsonb_build_object('provider_batch_name', v_provider_batch_name),
    v_now
  );

  return pg_catalog.jsonb_build_object(
    'submitted', true,
    'already_submitted', false,
    'reservation_id', v_reservation.id,
    'status', 'submitted',
    'provider_batch_name', v_provider_batch_name,
    'reserved_micro_usd', v_reservation.reserved_micro_usd,
    'source', 'postgres_atomic_budget_v1'
  );
end;
$$;

revoke all on function public.submit_gemini_spend_reservation(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_gemini_spend_reservation(uuid, uuid, text)
  to service_role;

create or replace function public.settle_gemini_spend_reservation(
  p_reservation_id uuid,
  p_spent_micro_usd bigint,
  p_usage jsonb,
  p_spent_source text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_spent_source text := pg_catalog.btrim(p_spent_source);
  v_reservation public.gemini_spend_reservations%rowtype;
  v_day public.gemini_spend_days%rowtype;
  v_cap bigint;
  v_held_micro_usd bigint := 0;
  v_reserved_after bigint;
  v_spent_after bigint;
  v_remaining bigint;
begin
  if p_reservation_id is null then
    raise exception 'reservation_id is required';
  end if;
  if p_spent_micro_usd is null or p_spent_micro_usd < 0 then
    raise exception 'spent_micro_usd must be zero or greater';
  end if;
  if p_usage is null or pg_catalog.jsonb_typeof(p_usage) <> 'object' then
    raise exception 'usage must be a JSON object';
  end if;
  if v_spent_source is null
    or pg_catalog.length(v_spent_source) = 0
    or pg_catalog.length(v_spent_source) > 200
  then
    raise exception 'spent_source must contain 1 to 200 characters';
  end if;

  select reservation.*
  into v_reservation
  from public.gemini_spend_reservations reservation
  where reservation.id = p_reservation_id
  for update;
  if not found then
    raise exception 'Gemini spend reservation % was not found', p_reservation_id;
  end if;

  select lane.daily_cap_micro_usd
  into strict v_cap
  from public.gemini_paid_lanes lane
  where lane.lane_key = v_reservation.lane_key;

  select day.*
  into strict v_day
  from public.gemini_spend_days day
  where day.budget_date = v_reservation.budget_date
    and day.lane_key = v_reservation.lane_key
  for update;

  if v_reservation.status = 'settled' then
    if v_reservation.spent_micro_usd is distinct from p_spent_micro_usd
      or v_reservation.usage is distinct from p_usage
      or v_reservation.spent_source is distinct from v_spent_source
    then
      raise exception 'reservation % was already settled with different usage or cost', p_reservation_id;
    end if;
    v_remaining := greatest(v_cap - v_day.reserved_micro_usd - v_day.spent_micro_usd, 0);
    return pg_catalog.jsonb_build_object(
      'settled', true,
      'already_settled', true,
      'reservation_id', v_reservation.id,
      'status', 'settled',
      'lane_key', v_reservation.lane_key,
      'budget_date', v_reservation.budget_date,
      'cap_micro_usd', v_cap,
      'reserved_micro_usd', v_day.reserved_micro_usd,
      'spent_micro_usd', v_day.spent_micro_usd,
      'remaining_micro_usd', v_remaining,
      'over_cap', v_day.spent_micro_usd > v_cap,
      'source', 'postgres_atomic_budget_v1'
    );
  end if;

  -- A released reservation may later be corrected when provider evidence proves
  -- that spend occurred. Truthful spend is recorded even when it exceeds the cap.
  if v_reservation.status in ('reserved', 'creating', 'submitted') then
    v_held_micro_usd := v_reservation.reserved_micro_usd;
  end if;
  if v_day.reserved_micro_usd < v_held_micro_usd then
    raise exception 'Gemini budget ledger reserved total is inconsistent for reservation %', p_reservation_id;
  end if;

  v_reserved_after := v_day.reserved_micro_usd - v_held_micro_usd;
  v_spent_after := v_day.spent_micro_usd + p_spent_micro_usd;

  update public.gemini_spend_days
  set
    reserved_micro_usd = v_reserved_after,
    spent_micro_usd = v_spent_after,
    updated_at = v_now
  where budget_date = v_reservation.budget_date
    and lane_key = v_reservation.lane_key;

  update public.gemini_spend_reservations
  set
    status = 'settled',
    spent_micro_usd = p_spent_micro_usd,
    usage = p_usage,
    spent_source = v_spent_source,
    settled_at = v_now,
    updated_at = v_now
  where id = p_reservation_id;

  insert into public.gemini_spend_events (
    reservation_id,
    lane_key,
    budget_date,
    event_type,
    reserved_delta_micro_usd,
    spent_delta_micro_usd,
    details,
    occurred_at
  ) values (
    v_reservation.id,
    v_reservation.lane_key,
    v_reservation.budget_date,
    'settled',
    -v_held_micro_usd,
    p_spent_micro_usd,
    pg_catalog.jsonb_build_object(
      'prior_status', v_reservation.status,
      'provider_batch_name', v_reservation.provider_batch_name,
      'usage', p_usage,
      'spent_source', v_spent_source
    ),
    v_now
  );

  v_remaining := greatest(v_cap - v_reserved_after - v_spent_after, 0);
  return pg_catalog.jsonb_build_object(
    'settled', true,
    'already_settled', false,
    'reservation_id', v_reservation.id,
    'status', 'settled',
    'lane_key', v_reservation.lane_key,
    'budget_date', v_reservation.budget_date,
    'cap_micro_usd', v_cap,
    'reservation_micro_usd', v_reservation.reserved_micro_usd,
    'actual_micro_usd', p_spent_micro_usd,
    'reserved_micro_usd', v_reserved_after,
    'spent_micro_usd', v_spent_after,
    'remaining_micro_usd', v_remaining,
    'over_cap', v_spent_after > v_cap,
    'source', 'postgres_atomic_budget_v1'
  );
end;
$$;

revoke all on function public.settle_gemini_spend_reservation(uuid, bigint, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.settle_gemini_spend_reservation(uuid, bigint, jsonb, text)
  to service_role;

create or replace function public.release_gemini_spend_reservation(
  p_reservation_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_reason text := pg_catalog.btrim(p_reason);
  v_reservation public.gemini_spend_reservations%rowtype;
  v_day public.gemini_spend_days%rowtype;
  v_cap bigint;
  v_reserved_after bigint;
  v_remaining bigint;
begin
  if p_reservation_id is null then
    raise exception 'reservation_id is required';
  end if;
  if v_reason is null or pg_catalog.length(v_reason) = 0 or pg_catalog.length(v_reason) > 1000 then
    raise exception 'reason must contain 1 to 1000 characters';
  end if;

  select reservation.*
  into v_reservation
  from public.gemini_spend_reservations reservation
  where reservation.id = p_reservation_id
  for update;
  if not found then
    raise exception 'Gemini spend reservation % was not found', p_reservation_id;
  end if;

  if v_reservation.status = 'released' then
    if v_reservation.release_reason is distinct from v_reason then
      raise exception 'reservation % was already released for a different reason', p_reservation_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'released', true,
      'already_released', true,
      'reservation_id', v_reservation.id,
      'status', 'released',
      'reason', v_reservation.release_reason,
      'source', 'postgres_atomic_budget_v1'
    );
  end if;

  -- Submitted calls remain reserved until settlement. This deliberately rejects
  -- automatic timeout/TTL cleanup for externally ambiguous paid calls.
  if v_reservation.status = 'submitted' then
    raise exception 'submitted reservation % requires settlement and cannot be released', p_reservation_id;
  end if;
  if v_reservation.status = 'creating'
    and v_reason not like 'provider_create_not_reached:%'
    and v_reason not like 'provider_create_definitively_failed:%'
    and v_reason <> 'provider_create_definitively_failed'
  then
    raise exception 'provider-started reservation % requires definitive no-create evidence or settlement', p_reservation_id;
  end if;
  if v_reservation.status = 'settled' then
    raise exception 'settled reservation % cannot be released', p_reservation_id;
  end if;

  select lane.daily_cap_micro_usd
  into strict v_cap
  from public.gemini_paid_lanes lane
  where lane.lane_key = v_reservation.lane_key;

  select day.*
  into strict v_day
  from public.gemini_spend_days day
  where day.budget_date = v_reservation.budget_date
    and day.lane_key = v_reservation.lane_key
  for update;

  if v_day.reserved_micro_usd < v_reservation.reserved_micro_usd then
    raise exception 'Gemini budget ledger reserved total is inconsistent for reservation %', p_reservation_id;
  end if;
  v_reserved_after := v_day.reserved_micro_usd - v_reservation.reserved_micro_usd;

  update public.gemini_spend_days
  set
    reserved_micro_usd = v_reserved_after,
    updated_at = v_now
  where budget_date = v_reservation.budget_date
    and lane_key = v_reservation.lane_key;

  update public.gemini_spend_reservations
  set
    status = 'released',
    release_reason = v_reason,
    released_at = v_now,
    updated_at = v_now
  where id = p_reservation_id;

  insert into public.gemini_spend_events (
    reservation_id,
    lane_key,
    budget_date,
    event_type,
    reserved_delta_micro_usd,
    details,
    occurred_at
  ) values (
    v_reservation.id,
    v_reservation.lane_key,
    v_reservation.budget_date,
    'released',
    -v_reservation.reserved_micro_usd,
    pg_catalog.jsonb_build_object('reason', v_reason),
    v_now
  );

  v_remaining := greatest(v_cap - v_reserved_after - v_day.spent_micro_usd, 0);
  return pg_catalog.jsonb_build_object(
    'released', true,
    'already_released', false,
    'reservation_id', v_reservation.id,
    'status', 'released',
    'lane_key', v_reservation.lane_key,
    'budget_date', v_reservation.budget_date,
    'reason', v_reason,
    'cap_micro_usd', v_cap,
    'reserved_micro_usd', v_reserved_after,
    'spent_micro_usd', v_day.spent_micro_usd,
    'remaining_micro_usd', v_remaining,
    'source', 'postgres_atomic_budget_v1'
  );
end;
$$;

revoke all on function public.release_gemini_spend_reservation(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.release_gemini_spend_reservation(uuid, text)
  to service_role;

create or replace function public.list_gemini_budget_status()
returns table (
  lane_key text,
  budget_date date,
  cap_micro_usd bigint,
  reserved_micro_usd bigint,
  spent_micro_usd bigint,
  remaining_micro_usd bigint,
  reset_at timestamptz,
  source text
)
language sql
security definer
set search_path = ''
as $$
  with utc_clock as (
    select
      (pg_catalog.clock_timestamp() at time zone 'UTC')::date as budget_date
  )
  select
    lane.lane_key,
    utc_clock.budget_date,
    lane.daily_cap_micro_usd as cap_micro_usd,
    coalesce(day.reserved_micro_usd, 0)::bigint as reserved_micro_usd,
    coalesce(day.spent_micro_usd, 0)::bigint as spent_micro_usd,
    greatest(
      lane.daily_cap_micro_usd
        - coalesce(day.reserved_micro_usd, 0)
        - coalesce(day.spent_micro_usd, 0),
      0
    )::bigint as remaining_micro_usd,
    ((utc_clock.budget_date + 1)::timestamp at time zone 'UTC') as reset_at,
    'postgres_atomic_budget_v1'::text as source
  from public.gemini_paid_lanes lane
  cross join utc_clock
  left join public.gemini_spend_days day
    on day.budget_date = utc_clock.budget_date
   and day.lane_key = lane.lane_key
  order by case lane.lane_key
    when 'new_page_review' then 1
    when 'changed_page_review' then 2
    else 3
  end;
$$;

revoke all on function public.list_gemini_budget_status()
  from public, anon, authenticated, service_role;
grant execute on function public.list_gemini_budget_status()
  to service_role;

comment on table public.gemini_paid_lanes is
  'The only paid Gemini API lanes. Each has an immutable 5 USD UTC-day cap represented as 5,000,000 micro-USD.';
comment on table public.gemini_spend_reservations is
  'Attempt-owned paid-call reservations with one active reservation per billable-work fingerprint. Submitted reservations never expire or release automatically; provider evidence must settle them.';
comment on table public.gemini_spend_events is
  'Append-only evidence for every successful reservation lifecycle transition.';

create table public.monitoring_downstream_lanes (
  lane_key text primary key,
  display_name text not null,
  paid_lane_key text references public.gemini_paid_lanes(lane_key) on delete restrict,
  enabled boolean not null default true,
  timeout interval not null,
  lease_ttl interval not null,
  sla interval not null,
  retry_base interval not null,
  retry_max interval not null,
  sort_order integer not null unique,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint monitoring_downstream_lanes_key_check check (
    lane_key in (
      'new_page_review',
      'changed_page_review',
      'feedback_promotion',
      'suppression',
      'reconciliation',
      'page_audit',
      'manual_quarantine',
      'nightly_report'
    )
  ),
  constraint monitoring_downstream_lanes_durations_check check (
    timeout > interval '0 seconds'
    and timeout < lease_ttl
    and lease_ttl > interval '0 seconds'
    and lease_ttl <= interval '24 hours'
    and sla > interval '0 seconds'
    and retry_base > interval '0 seconds'
    and retry_max >= retry_base
  ),
  constraint monitoring_downstream_lanes_paid_mapping_check check (
    (lane_key = 'new_page_review' and paid_lane_key = 'new_page_review')
    or (lane_key = 'changed_page_review' and paid_lane_key = 'changed_page_review')
    or (
      lane_key not in ('new_page_review', 'changed_page_review')
      and paid_lane_key is null
    )
  ),
  constraint monitoring_downstream_lanes_page_audit_no_cost_check check (
    lane_key <> 'page_audit' or paid_lane_key is null
  )
);

insert into public.monitoring_downstream_lanes (
  lane_key,
  display_name,
  paid_lane_key,
  enabled,
  timeout,
  lease_ttl,
  sla,
  retry_base,
  retry_max,
  sort_order
)
values
  ('new_page_review', 'New-page review', 'new_page_review', true, interval '10 minutes', interval '15 minutes', interval '1 hour', interval '5 minutes', interval '1 hour', 10),
  ('changed_page_review', 'Changed-page review', 'changed_page_review', true, interval '10 minutes', interval '15 minutes', interval '1 hour', interval '5 minutes', interval '1 hour', 20),
  ('feedback_promotion', 'Feedback promotion', null, true, interval '6 minutes', interval '10 minutes', interval '24 hours', interval '15 minutes', interval '6 hours', 30),
  ('suppression', 'Suppression', null, true, interval '6 minutes', interval '10 minutes', interval '1 hour', interval '5 minutes', interval '1 hour', 40),
  ('reconciliation', 'Reconciliation', null, true, interval '6 minutes', interval '10 minutes', interval '1 hour', interval '5 minutes', interval '1 hour', 50),
  ('page_audit', 'Page audit', null, true, interval '6 minutes', interval '10 minutes', interval '2 hours', interval '15 minutes', interval '4 hours', 60),
  ('manual_quarantine', 'Manual quarantine', null, true, interval '4 minutes', interval '8 minutes', interval '1 hour', interval '15 minutes', interval '2 hours', 70),
  ('nightly_report', 'Nightly report', null, true, interval '4 minutes', interval '8 minutes', interval '25 hours', interval '30 minutes', interval '6 hours', 80);

create table public.monitoring_downstream_lane_runs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  lane_key text not null references public.monitoring_downstream_lanes(lane_key) on delete restrict,
  claim_token uuid not null unique,
  worker_source text not null,
  worker_run_id uuid,
  attempt_number bigint not null check (attempt_number > 0),
  status text not null default 'running' check (
    status in ('running', 'succeeded', 'failed', 'lease_expired')
  ),
  metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(metadata) = 'object'
  ),
  result jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(result) = 'object'
  ),
  error text,
  claimed_at timestamptz not null,
  heartbeat_at timestamptz not null,
  lease_expires_at timestamptz not null,
  sla_deadline timestamptz not null,
  completed_at timestamptz,
  retry_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint monitoring_downstream_lane_runs_worker_source_check check (
    pg_catalog.length(pg_catalog.btrim(worker_source)) between 1 and 200
  ),
  constraint monitoring_downstream_lane_runs_completion_check check (
    (status = 'running' and completed_at is null)
    or (status <> 'running' and completed_at is not null)
  )
);

create unique index monitoring_downstream_lane_runs_one_active_idx
  on public.monitoring_downstream_lane_runs (lane_key)
  where status = 'running';

create index monitoring_downstream_lane_runs_history_idx
  on public.monitoring_downstream_lane_runs (lane_key, claimed_at desc, id);

create table public.monitoring_downstream_lane_state (
  lane_key text primary key references public.monitoring_downstream_lanes(lane_key) on delete restrict,
  status text not null default 'idle' check (status in ('idle', 'claimed', 'backoff')),
  active_run_id uuid references public.monitoring_downstream_lane_runs(id) on delete restrict,
  claim_token uuid,
  lease_owner text,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  sla_deadline timestamptz,
  next_eligible_at timestamptz,
  consecutive_failures bigint not null default 0 check (consecutive_failures >= 0),
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  last_error text,
  last_result jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(last_result) = 'object'
  ),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint monitoring_downstream_lane_state_claim_tuple_check check (
    (
      status = 'claimed'
      and active_run_id is not null
      and claim_token is not null
      and lease_owner is not null
      and claimed_at is not null
      and heartbeat_at is not null
      and lease_expires_at is not null
      and sla_deadline is not null
      and next_eligible_at is null
    )
    or (
      status in ('idle', 'backoff')
      and active_run_id is null
      and claim_token is null
      and lease_owner is null
      and claimed_at is null
      and heartbeat_at is null
      and lease_expires_at is null
      and sla_deadline is null
      and (status <> 'backoff' or next_eligible_at is not null)
    )
  )
);

insert into public.monitoring_downstream_lane_state (lane_key)
select lane.lane_key
from public.monitoring_downstream_lanes lane;

alter table public.monitoring_downstream_lanes enable row level security;
alter table public.monitoring_downstream_lane_runs enable row level security;
alter table public.monitoring_downstream_lane_state enable row level security;

revoke all on table public.monitoring_downstream_lanes
  from public, anon, authenticated, service_role;
revoke all on table public.monitoring_downstream_lane_runs
  from public, anon, authenticated, service_role;
revoke all on table public.monitoring_downstream_lane_state
  from public, anon, authenticated, service_role;

grant select on table public.monitoring_downstream_lanes to service_role;
grant select on table public.monitoring_downstream_lane_runs to service_role;
grant select on table public.monitoring_downstream_lane_state to service_role;

create or replace function public.claim_monitoring_downstream_lane(
  p_lane_key text,
  p_worker_source text,
  p_worker_run_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_worker_source text := pg_catalog.btrim(p_worker_source);
  v_lane public.monitoring_downstream_lanes%rowtype;
  v_state public.monitoring_downstream_lane_state%rowtype;
  v_run_id uuid;
  v_claim_token uuid;
  v_failures bigint;
  v_backoff interval;
  v_retry_at timestamptz;
  v_lease_expires_at timestamptz;
  v_sla_deadline timestamptz;
begin
  if p_lane_key is null then
    raise exception 'lane_key is required';
  end if;
  if v_worker_source is null
    or pg_catalog.length(v_worker_source) = 0
    or pg_catalog.length(v_worker_source) > 200
  then
    raise exception 'worker_source must contain 1 to 200 characters';
  end if;
  if p_metadata is null or pg_catalog.jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'metadata must be a JSON object';
  end if;

  select lane.*
  into v_lane
  from public.monitoring_downstream_lanes lane
  where lane.lane_key = p_lane_key;
  if not found then
    raise exception 'unknown downstream lane: %', p_lane_key;
  end if;

  select state.*
  into v_state
  from public.monitoring_downstream_lane_state state
  where state.lane_key = p_lane_key
  for update;
  if not found then
    raise exception 'downstream lane state is missing for %', p_lane_key;
  end if;

  if not v_lane.enabled then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'reason', 'lane_disabled',
      'lane_key', p_lane_key,
      'status', v_state.status,
      'source', 'postgres_lane_scheduler_v1'
    );
  end if;

  if v_state.status = 'claimed' then
    if v_state.lease_expires_at > v_now then
      return pg_catalog.jsonb_build_object(
        'claimed', false,
        'reason', 'lease_active',
        'lane_key', p_lane_key,
        'status', 'claimed',
        'active_run_id', v_state.active_run_id,
        'lease_owner', v_state.lease_owner,
        'lease_expires_at', v_state.lease_expires_at,
        'source', 'postgres_lane_scheduler_v1'
      );
    end if;

    -- Workflow leases expire independently of paid-call reservations. Expiring
    -- this run schedules lane backoff but never mutates Gemini spend state.
    v_failures := v_state.consecutive_failures + 1;
    v_backoff := least(
      v_lane.retry_max,
      v_lane.retry_base * pg_catalog.power(
        2::double precision,
        least(greatest(v_failures - 1, 0), 20)::integer
      )
    );
    v_retry_at := v_now + v_backoff;

    update public.monitoring_downstream_lane_runs
    set
      status = 'lease_expired',
      error = 'lease_expired_without_completion',
      completed_at = v_now,
      retry_at = v_retry_at,
      updated_at = v_now
    where id = v_state.active_run_id
      and status = 'running';

    update public.monitoring_downstream_lane_state
    set
      status = 'backoff',
      active_run_id = null,
      claim_token = null,
      lease_owner = null,
      claimed_at = null,
      heartbeat_at = null,
      lease_expires_at = null,
      sla_deadline = null,
      next_eligible_at = v_retry_at,
      consecutive_failures = v_failures,
      last_finished_at = v_now,
      last_failed_at = v_now,
      last_error = 'lease_expired_without_completion',
      updated_at = v_now
    where lane_key = p_lane_key;

    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'reason', 'expired_lease_entered_backoff',
      'lane_key', p_lane_key,
      'status', 'backoff',
      'expired_run_id', v_state.active_run_id,
      'consecutive_failures', v_failures,
      'retry_at', v_retry_at,
      'source', 'postgres_lane_scheduler_v1'
    );
  end if;

  if v_state.status = 'backoff' and v_state.next_eligible_at > v_now then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'reason', 'retry_backoff',
      'lane_key', p_lane_key,
      'status', 'backoff',
      'consecutive_failures', v_state.consecutive_failures,
      'retry_at', v_state.next_eligible_at,
      'source', 'postgres_lane_scheduler_v1'
    );
  end if;

  v_run_id := pg_catalog.gen_random_uuid();
  v_claim_token := pg_catalog.gen_random_uuid();
  v_lease_expires_at := v_now + v_lane.lease_ttl;
  v_sla_deadline := v_now + v_lane.sla;

  insert into public.monitoring_downstream_lane_runs (
    id,
    lane_key,
    claim_token,
    worker_source,
    worker_run_id,
    attempt_number,
    status,
    metadata,
    claimed_at,
    heartbeat_at,
    lease_expires_at,
    sla_deadline,
    created_at,
    updated_at
  ) values (
    v_run_id,
    p_lane_key,
    v_claim_token,
    v_worker_source,
    p_worker_run_id,
    v_state.consecutive_failures + 1,
    'running',
    p_metadata,
    v_now,
    v_now,
    v_lease_expires_at,
    v_sla_deadline,
    v_now,
    v_now
  );

  update public.monitoring_downstream_lane_state
  set
    status = 'claimed',
    active_run_id = v_run_id,
    claim_token = v_claim_token,
    lease_owner = v_worker_source,
    claimed_at = v_now,
    heartbeat_at = v_now,
    lease_expires_at = v_lease_expires_at,
    sla_deadline = v_sla_deadline,
    next_eligible_at = null,
    last_started_at = v_now,
    updated_at = v_now
  where lane_key = p_lane_key;

  return pg_catalog.jsonb_build_object(
    'claimed', true,
    'reason', 'claimed',
    'lane_key', p_lane_key,
    'paid_lane_key', v_lane.paid_lane_key,
    'creates_api_charge', v_lane.paid_lane_key is not null,
    'status', 'claimed',
    'run_id', v_run_id,
    'claim_token', v_claim_token,
    'worker_run_id', p_worker_run_id,
    'attempt_number', v_state.consecutive_failures + 1,
    'claimed_at', v_now,
    'lease_expires_at', v_lease_expires_at,
    'timeout_seconds', extract(epoch from v_lane.timeout)::bigint,
    'sla_deadline', v_sla_deadline,
    'source', 'postgres_lane_scheduler_v1'
  );
end;
$$;

revoke all on function public.claim_monitoring_downstream_lane(text, text, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_monitoring_downstream_lane(text, text, uuid, jsonb)
  to service_role;

create or replace function public.heartbeat_monitoring_downstream_lane(
  p_lane_key text,
  p_run_id uuid,
  p_claim_token uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_lane public.monitoring_downstream_lanes%rowtype;
  v_state public.monitoring_downstream_lane_state%rowtype;
  v_failures bigint;
  v_backoff interval;
  v_retry_at timestamptz;
  v_lease_expires_at timestamptz;
begin
  if p_lane_key is null or p_run_id is null or p_claim_token is null then
    raise exception 'lane_key, run_id, and claim_token are required';
  end if;
  if p_metadata is null or pg_catalog.jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'metadata must be a JSON object';
  end if;

  select lane.*
  into v_lane
  from public.monitoring_downstream_lanes lane
  where lane.lane_key = p_lane_key;
  if not found then
    raise exception 'unknown downstream lane: %', p_lane_key;
  end if;

  select state.*
  into v_state
  from public.monitoring_downstream_lane_state state
  where state.lane_key = p_lane_key
  for update;
  if not found then
    raise exception 'downstream lane state is missing for %', p_lane_key;
  end if;

  if v_state.status <> 'claimed'
    or v_state.active_run_id is distinct from p_run_id
    or v_state.claim_token is distinct from p_claim_token
  then
    return pg_catalog.jsonb_build_object(
      'heartbeat', false,
      'reason', 'stale_or_mismatched_claim',
      'lane_key', p_lane_key,
      'run_id', p_run_id,
      'status', v_state.status,
      'source', 'postgres_lane_scheduler_v1'
    );
  end if;

  if v_state.lease_expires_at <= v_now then
    v_failures := v_state.consecutive_failures + 1;
    v_backoff := least(
      v_lane.retry_max,
      v_lane.retry_base * pg_catalog.power(
        2::double precision,
        least(greatest(v_failures - 1, 0), 20)::integer
      )
    );
    v_retry_at := v_now + v_backoff;

    update public.monitoring_downstream_lane_runs
    set
      status = 'lease_expired',
      error = 'lease_expired_before_heartbeat',
      completed_at = v_now,
      retry_at = v_retry_at,
      updated_at = v_now
    where id = p_run_id
      and status = 'running';

    update public.monitoring_downstream_lane_state
    set
      status = 'backoff',
      active_run_id = null,
      claim_token = null,
      lease_owner = null,
      claimed_at = null,
      heartbeat_at = null,
      lease_expires_at = null,
      sla_deadline = null,
      next_eligible_at = v_retry_at,
      consecutive_failures = v_failures,
      last_finished_at = v_now,
      last_failed_at = v_now,
      last_error = 'lease_expired_before_heartbeat',
      updated_at = v_now
    where lane_key = p_lane_key;

    return pg_catalog.jsonb_build_object(
      'heartbeat', false,
      'reason', 'lease_expired',
      'lane_key', p_lane_key,
      'run_id', p_run_id,
      'status', 'backoff',
      'consecutive_failures', v_failures,
      'retry_at', v_retry_at,
      'source', 'postgres_lane_scheduler_v1'
    );
  end if;

  v_lease_expires_at := v_now + v_lane.lease_ttl;

  update public.monitoring_downstream_lane_runs
  set
    heartbeat_at = v_now,
    lease_expires_at = v_lease_expires_at,
    metadata = metadata || p_metadata,
    updated_at = v_now
  where id = p_run_id
    and status = 'running';

  update public.monitoring_downstream_lane_state
  set
    heartbeat_at = v_now,
    lease_expires_at = v_lease_expires_at,
    updated_at = v_now
  where lane_key = p_lane_key;

  return pg_catalog.jsonb_build_object(
    'heartbeat', true,
    'reason', 'lease_extended',
    'lane_key', p_lane_key,
    'run_id', p_run_id,
    'status', 'claimed',
    'heartbeat_at', v_now,
    'lease_expires_at', v_lease_expires_at,
    'sla_deadline', v_state.sla_deadline,
    'sla_breached', v_state.sla_deadline <= v_now,
    'source', 'postgres_lane_scheduler_v1'
  );
end;
$$;

revoke all on function public.heartbeat_monitoring_downstream_lane(text, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.heartbeat_monitoring_downstream_lane(text, uuid, uuid, jsonb)
  to service_role;

create or replace function public.complete_monitoring_downstream_lane(
  p_lane_key text,
  p_run_id uuid,
  p_claim_token uuid,
  p_succeeded boolean,
  p_result jsonb,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_lane public.monitoring_downstream_lanes%rowtype;
  v_state public.monitoring_downstream_lane_state%rowtype;
  v_error text := nullif(pg_catalog.btrim(p_error), '');
  v_failures bigint;
  v_backoff interval;
  v_retry_at timestamptz;
begin
  if p_lane_key is null or p_run_id is null or p_claim_token is null or p_succeeded is null then
    raise exception 'lane_key, run_id, claim_token, and succeeded are required';
  end if;
  if p_result is null or pg_catalog.jsonb_typeof(p_result) <> 'object' then
    raise exception 'result must be a JSON object';
  end if;
  if not p_succeeded and v_error is null then
    v_error := 'worker_reported_failure';
  end if;
  if v_error is not null and pg_catalog.length(v_error) > 4000 then
    v_error := pg_catalog.left(v_error, 4000);
  end if;

  select lane.*
  into v_lane
  from public.monitoring_downstream_lanes lane
  where lane.lane_key = p_lane_key;
  if not found then
    raise exception 'unknown downstream lane: %', p_lane_key;
  end if;

  select state.*
  into v_state
  from public.monitoring_downstream_lane_state state
  where state.lane_key = p_lane_key
  for update;
  if not found then
    raise exception 'downstream lane state is missing for %', p_lane_key;
  end if;

  if v_state.status <> 'claimed'
    or v_state.active_run_id is distinct from p_run_id
    or v_state.claim_token is distinct from p_claim_token
  then
    return pg_catalog.jsonb_build_object(
      'completed', false,
      'reason', 'stale_or_mismatched_claim',
      'lane_key', p_lane_key,
      'run_id', p_run_id,
      'status', v_state.status,
      'source', 'postgres_lane_scheduler_v1'
    );
  end if;

  if v_state.lease_expires_at <= v_now then
    v_failures := v_state.consecutive_failures + 1;
    v_backoff := least(
      v_lane.retry_max,
      v_lane.retry_base * pg_catalog.power(
        2::double precision,
        least(greatest(v_failures - 1, 0), 20)::integer
      )
    );
    v_retry_at := v_now + v_backoff;

    update public.monitoring_downstream_lane_runs
    set
      status = 'lease_expired',
      error = 'lease_expired_before_completion',
      result = p_result,
      completed_at = v_now,
      retry_at = v_retry_at,
      updated_at = v_now
    where id = p_run_id
      and status = 'running';

    update public.monitoring_downstream_lane_state
    set
      status = 'backoff',
      active_run_id = null,
      claim_token = null,
      lease_owner = null,
      claimed_at = null,
      heartbeat_at = null,
      lease_expires_at = null,
      sla_deadline = null,
      next_eligible_at = v_retry_at,
      consecutive_failures = v_failures,
      last_finished_at = v_now,
      last_failed_at = v_now,
      last_error = 'lease_expired_before_completion',
      last_result = p_result,
      updated_at = v_now
    where lane_key = p_lane_key;

    return pg_catalog.jsonb_build_object(
      'completed', false,
      'reason', 'lease_expired',
      'lane_key', p_lane_key,
      'run_id', p_run_id,
      'status', 'backoff',
      'consecutive_failures', v_failures,
      'retry_at', v_retry_at,
      'source', 'postgres_lane_scheduler_v1'
    );
  end if;

  if p_succeeded then
    update public.monitoring_downstream_lane_runs
    set
      status = 'succeeded',
      result = p_result,
      error = null,
      completed_at = v_now,
      retry_at = null,
      updated_at = v_now
    where id = p_run_id
      and status = 'running';

    update public.monitoring_downstream_lane_state
    set
      status = 'idle',
      active_run_id = null,
      claim_token = null,
      lease_owner = null,
      claimed_at = null,
      heartbeat_at = null,
      lease_expires_at = null,
      sla_deadline = null,
      next_eligible_at = null,
      consecutive_failures = 0,
      last_finished_at = v_now,
      last_succeeded_at = v_now,
      last_error = null,
      last_result = p_result,
      updated_at = v_now
    where lane_key = p_lane_key;

    return pg_catalog.jsonb_build_object(
      'completed', true,
      'succeeded', true,
      'reason', 'completed',
      'lane_key', p_lane_key,
      'run_id', p_run_id,
      'status', 'idle',
      'completed_at', v_now,
      'source', 'postgres_lane_scheduler_v1'
    );
  end if;

  v_failures := v_state.consecutive_failures + 1;
  v_backoff := least(
    v_lane.retry_max,
    v_lane.retry_base * pg_catalog.power(
      2::double precision,
      least(greatest(v_failures - 1, 0), 20)::integer
    )
  );
  v_retry_at := v_now + v_backoff;

  update public.monitoring_downstream_lane_runs
  set
    status = 'failed',
    result = p_result,
    error = v_error,
    completed_at = v_now,
    retry_at = v_retry_at,
    updated_at = v_now
  where id = p_run_id
    and status = 'running';

  update public.monitoring_downstream_lane_state
  set
    status = 'backoff',
    active_run_id = null,
    claim_token = null,
    lease_owner = null,
    claimed_at = null,
    heartbeat_at = null,
    lease_expires_at = null,
    sla_deadline = null,
    next_eligible_at = v_retry_at,
    consecutive_failures = v_failures,
    last_finished_at = v_now,
    last_failed_at = v_now,
    last_error = v_error,
    last_result = p_result,
    updated_at = v_now
  where lane_key = p_lane_key;

  return pg_catalog.jsonb_build_object(
    'completed', true,
    'succeeded', false,
    'reason', 'failed_with_backoff',
    'lane_key', p_lane_key,
    'run_id', p_run_id,
    'status', 'backoff',
    'error', v_error,
    'consecutive_failures', v_failures,
    'retry_at', v_retry_at,
    'source', 'postgres_lane_scheduler_v1'
  );
end;
$$;

revoke all on function public.complete_monitoring_downstream_lane(text, uuid, uuid, boolean, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_monitoring_downstream_lane(text, uuid, uuid, boolean, jsonb, text)
  to service_role;

create or replace function public.list_monitoring_downstream_lane_status()
returns table (
  lane_key text,
  display_name text,
  paid_lane_key text,
  creates_api_charge boolean,
  enabled boolean,
  status text,
  claimable boolean,
  queue_depth bigint,
  oldest_item_at timestamptz,
  active_run_id uuid,
  lease_owner text,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  lease_expired boolean,
  sla_deadline timestamptz,
  next_sla_due_at timestamptz,
  sla_breached boolean,
  next_eligible_at timestamptz,
  consecutive_failures bigint,
  timeout_seconds bigint,
  lease_ttl_seconds bigint,
  sla_seconds bigint,
  oldest_item_sla_seconds bigint,
  retry_base_seconds bigint,
  retry_max_seconds bigint,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  last_error text,
  source text
)
language sql
security definer
set search_path = ''
as $$
  with lane_clock as (
    select pg_catalog.clock_timestamp() as now_at
  ),
  source_queue as (
    select
      count(*)::bigint as queue_depth,
      min(request.created_at) as oldest_item_at
    from public.source_page_requests request
    where request.status in (
      'pending',
      'queued',
      'validating',
      'capturing',
      'ai_review_pending',
      'ai_review_submitted',
      'ai_review_succeeded',
      'matching'
    )
  ),
  visual_queue as (
    select
      count(*)::bigint as queue_depth,
      min(candidate.created_at) as oldest_item_at
    from public.shared_award_visual_review_candidates candidate
    where candidate.status in ('pending', 'submitted', 'processing', 'succeeded')
      or (
        candidate.status = 'failed'
        and (
          lower(pg_catalog.btrim(coalesce(candidate.rejection_reason, ''))) =
            'missing_batch_response'
          or (
            lower(pg_catalog.btrim(coalesce(candidate.rejection_reason, ''))) <>
              'manual_recovery_required_possible_external_batch_created'
            and coalesce(
              case
                when candidate.worker_metadata ->> 'failure_retry_count' ~ '^[0-9]+$'
                  then (candidate.worker_metadata ->> 'failure_retry_count')::integer
              end,
              0
            ) < 3
          )
        )
      )
  ),
  feedback_queue as (
    select
      count(*)::bigint as queue_depth,
      min(cluster.updated_at) as oldest_item_at
    from public.monitoring_feedback_promotion_clusters cluster
    where cluster.resolved_at is null
      and cluster.current_stage in (
        'rule_drafted',
        'historical_shadow_test',
        'regression_tests_pass',
        'app_worker_hashes_match',
        'six_pm_canary',
        'retroactive_sweep'
      )
      and (
        cluster.current_stage <> 'retroactive_sweep'
        or cluster.activation_status in (
          'blocked_late_evidence',
          'rollback_required',
          'sweep_completed'
        )
      )
  ),
  reconciliation_queue as (
    select
      count(*)::bigint as queue_depth,
      min(queue.created_at) as oldest_item_at
    from public.shared_award_reconciliation_queue queue
    where queue.status in ('pending', 'processing')
  ),
  lane_backlog as (
    select 'new_page_review'::text as lane_key, queue_depth, oldest_item_at
    from source_queue
    union all
    select 'changed_page_review'::text, queue_depth, oldest_item_at
    from visual_queue
    union all
    select 'feedback_promotion'::text, queue_depth, oldest_item_at
    from feedback_queue
    union all
    select 'suppression'::text, 0::bigint, null::timestamptz
    union all
    select 'reconciliation'::text, queue_depth, oldest_item_at
    from reconciliation_queue
    union all
    -- Page-audit findings and quarantine cases are durable operator work shown
    -- in the Action Inbox. They are not retryable lane backlog: these lanes
    -- periodically refresh that evidence, so lane health is measured by the
    -- last successful refresh cadence below.
    select 'page_audit'::text, 0::bigint, null::timestamptz
    union all
    select 'manual_quarantine'::text, 0::bigint, null::timestamptz
    union all
    select 'nightly_report'::text, 0::bigint, null::timestamptz
  )
  select
    lane.lane_key,
    lane.display_name,
    lane.paid_lane_key,
    lane.paid_lane_key is not null as creates_api_charge,
    lane.enabled,
    state.status,
    (
      lane.enabled
      and (
        state.status = 'idle'
        or (
          state.status = 'backoff'
          and state.next_eligible_at <= lane_clock.now_at
        )
      )
    ) as claimable,
    backlog.queue_depth,
    backlog.oldest_item_at,
    state.active_run_id,
    state.lease_owner,
    state.claimed_at,
    state.heartbeat_at,
    state.lease_expires_at,
    (
      state.status = 'claimed'
      and state.lease_expires_at <= lane_clock.now_at
    ) as lease_expired,
    state.sla_deadline,
    case
      when lane.lane_key in (
        'new_page_review',
        'changed_page_review',
        'feedback_promotion',
        'reconciliation'
      ) then backlog.oldest_item_at + lane.sla
      else coalesce(state.last_succeeded_at, state.created_at) + lane.sla
    end as next_sla_due_at,
    case
      when lane.lane_key in (
        'new_page_review',
        'changed_page_review',
        'feedback_promotion',
        'reconciliation'
      ) then coalesce(backlog.oldest_item_at + lane.sla <= lane_clock.now_at, false)
      else coalesce(state.last_succeeded_at, state.created_at) + lane.sla <= lane_clock.now_at
    end as sla_breached,
    state.next_eligible_at,
    state.consecutive_failures,
    extract(epoch from lane.timeout)::bigint as timeout_seconds,
    extract(epoch from lane.lease_ttl)::bigint as lease_ttl_seconds,
    extract(epoch from lane.sla)::bigint as sla_seconds,
    case
      when lane.lane_key in (
        'new_page_review',
        'changed_page_review',
        'feedback_promotion',
        'reconciliation'
      ) then extract(epoch from lane.sla)::bigint
      else null::bigint
    end as oldest_item_sla_seconds,
    extract(epoch from lane.retry_base)::bigint as retry_base_seconds,
    extract(epoch from lane.retry_max)::bigint as retry_max_seconds,
    state.last_started_at,
    state.last_finished_at,
    state.last_succeeded_at,
    state.last_failed_at,
    state.last_error,
    'postgres_lane_scheduler_v1'::text as source
  from public.monitoring_downstream_lanes lane
  join public.monitoring_downstream_lane_state state
    on state.lane_key = lane.lane_key
  join lane_backlog backlog
    on backlog.lane_key = lane.lane_key
  cross join lane_clock
  order by lane.sort_order;
$$;

revoke all on function public.list_monitoring_downstream_lane_status()
  from public, anon, authenticated, service_role;
grant execute on function public.list_monitoring_downstream_lane_status()
  to service_role;

comment on table public.monitoring_downstream_lanes is
  'Fixed downstream workflow lanes with independent lease, SLA, and retry/backoff policy. Page audit is explicitly no-cost.';
comment on table public.monitoring_downstream_lane_state is
  'One atomic scheduler state row per downstream lane; workflow lease expiry never releases a paid Gemini reservation.';
comment on table public.monitoring_downstream_lane_runs is
  'Durable downstream claim attempts and completion evidence.';

-- Public-page reconciliation and page-audit repair are deterministic, no-cost
-- operations. Rewrite the earlier registry synchronizer in place so both
-- future syncs and already-persisted public-page quarantine rows carry that
-- contract. Changed-page visual review remains a separate paid lane.
do $$
declare
  v_function pg_catalog.regprocedure;
  v_definition text;
  v_rewritten text;
  v_next text;
begin
  v_function := pg_catalog.to_regprocedure(
    'public.sync_manual_quarantine_registry()'
  );
  if v_function is null then
    raise exception 'sync_manual_quarantine_registry() must exist before the downstream-lane migration';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_function);
  v_rewritten := pg_catalog.replace(
    v_definition,
    pg_catalog.quote_literal('may_charge'),
    pg_catalog.quote_literal('none')
  );
  if v_rewritten is not distinct from v_definition then
    raise exception 'public-page retry-charge clause was not found in sync_manual_quarantine_registry()';
  end if;

  v_next := pg_catalog.replace(
    v_rewritten,
    pg_catalog.quote_literal(
      'The latest page audit exhausted two Gemini Batch attempts with retryable response failures.'
    ),
    pg_catalog.quote_literal(
      'The latest deterministic page audit reached its safe retry limit.'
    )
  );
  if v_next is not distinct from v_rewritten then
    raise exception 'public-page terminal reason was not found in sync_manual_quarantine_registry()';
  end if;
  v_rewritten := v_next;

  v_next := pg_catalog.replace(
    v_rewritten,
    pg_catalog.quote_literal(
      'Inspect the two failed page-audit attempts before explicitly approving another Gemini Batch attempt; retrying may create a charge.'
    ),
    pg_catalog.quote_literal(
      'Inspect the failed page-audit evidence, repair this award only, then rerun the deterministic no-cost page audit.'
    )
  );
  if v_next is not distinct from v_rewritten then
    raise exception 'public-page terminal action was not found in sync_manual_quarantine_registry()';
  end if;

  execute v_next;
end;
$$;

select public.sync_manual_quarantine_registry();
