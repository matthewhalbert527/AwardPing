-- Atomically reserve free URL checks before any outbound request. The route uses
-- a service-role-only RPC so anonymous callers cannot manipulate counters or
-- write their own audit outcomes through the Data API.

create table public.free_check_rate_limit_windows (
  ip_hash text not null,
  window_started_at timestamptz not null,
  reserved_count integer not null default 0,
  attempt_count bigint not null default 0,
  last_attempt_at timestamptz not null default statement_timestamp(),
  primary key (ip_hash, window_started_at),
  constraint free_check_rate_limit_windows_ip_hash_check
    check (ip_hash ~ '^[0-9a-f]{64}$'),
  constraint free_check_rate_limit_windows_reserved_count_check
    check (reserved_count between 0 and 10),
  constraint free_check_rate_limit_windows_attempt_count_check
    check (attempt_count >= 0)
);

create table public.free_check_attempts (
  id uuid primary key default gen_random_uuid(),
  ip_hash text not null,
  url_hash text not null,
  requested_host text not null,
  window_started_at timestamptz not null,
  allowed boolean not null,
  outcome text not null,
  failure_kind text,
  created_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  constraint free_check_attempts_window_fkey
    foreign key (ip_hash, window_started_at)
    references public.free_check_rate_limit_windows (ip_hash, window_started_at)
    on delete restrict,
  constraint free_check_attempts_ip_hash_check
    check (ip_hash ~ '^[0-9a-f]{64}$'),
  constraint free_check_attempts_url_hash_check
    check (url_hash ~ '^[0-9a-f]{64}$'),
  constraint free_check_attempts_requested_host_check
    check (char_length(requested_host) between 1 and 253),
  constraint free_check_attempts_outcome_check
    check (outcome in (
      'reserved',
      'rate_limited',
      'succeeded',
      'failed',
      'outcome_unknown'
    )),
  constraint free_check_attempts_allowed_outcome_check
    check (
      (allowed and outcome in (
        'reserved',
        'succeeded',
        'failed',
        'outcome_unknown'
      ))
      or (not allowed and outcome = 'rate_limited')
    ),
  constraint free_check_attempts_completion_check
    check (
      (outcome = 'reserved' and completed_at is null)
      or (outcome <> 'reserved' and completed_at is not null)
    )
);

create index free_check_attempts_ip_created_idx
  on public.free_check_attempts (ip_hash, created_at desc);

create index free_check_attempts_outcome_created_idx
  on public.free_check_attempts (outcome, created_at desc);

create index free_check_attempts_created_idx
  on public.free_check_attempts (created_at);

create index free_check_rate_limit_windows_started_idx
  on public.free_check_rate_limit_windows (window_started_at);

-- A denied caller can retry arbitrarily often. Keep the exact aggregate in the
-- window counter while retaining only one representative denied audit row per
-- IP/window, which prevents the limiter itself becoming a write-amplification
-- vector.
create unique index free_check_attempts_one_denial_per_window_idx
  on public.free_check_attempts (ip_hash, window_started_at)
  where not allowed;

alter table public.free_check_rate_limit_windows enable row level security;
alter table public.free_check_attempts enable row level security;

revoke all on table public.free_check_rate_limit_windows
  from public, anon, authenticated, service_role;
revoke all on table public.free_check_attempts
  from public, anon, authenticated, service_role;

grant select on table public.free_check_rate_limit_windows to service_role;
grant select on table public.free_check_attempts to service_role;

create or replace function public.reserve_free_check_attempt(
  p_ip_hash text,
  p_url_hash text,
  p_requested_host text,
  p_limit integer default 10
)
returns table (
  attempt_id uuid,
  allowed boolean,
  retry_after_seconds integer,
  effective_limit integer,
  window_started_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_window_started_at timestamptz := date_trunc('hour', v_now);
  v_effective_limit integer := least(greatest(coalesce(p_limit, 10), 1), 10);
  v_reserved_count integer;
  v_attempt_id uuid := pg_catalog.gen_random_uuid();
  v_allowed boolean;
  v_retry_after_seconds integer;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid ip hash';
  end if;

  if p_url_hash is null or p_url_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid url hash';
  end if;

  if p_requested_host is null
     or char_length(p_requested_host) not between 1 and 253 then
    raise exception 'invalid requested host';
  end if;

  -- The transaction-scoped key lock serializes reservations for one IP. Hash
  -- collisions can only make the limiter stricter; they cannot increase quota.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('awardping:free-check:' || p_ip_hash, 0)
  );

  -- Reconcile crashed or disconnected checks truthfully. This work is bounded
  -- so one public request cannot turn maintenance into an unbounded statement.
  with stale_attempts as (
    select attempt.id
    from public.free_check_attempts as attempt
    where attempt.outcome = 'reserved'
      and attempt.created_at < v_now - interval '15 minutes'
    order by attempt.created_at
    limit 100
    for update skip locked
  )
  update public.free_check_attempts as attempt
  set outcome = 'outcome_unknown',
      failure_kind = 'reservation_stale',
      completed_at = v_now
  from stale_attempts
  where attempt.id = stale_attempts.id;

  -- Retain 30 days of terminal audit evidence. Old attempts are deleted before
  -- their now-unreferenced hourly windows, in small indexed batches.
  with expired_attempts as (
    select attempt.id
    from public.free_check_attempts as attempt
    where attempt.outcome <> 'reserved'
      and attempt.created_at < v_now - interval '30 days'
    order by attempt.created_at
    limit 200
    for update skip locked
  )
  delete from public.free_check_attempts as attempt
  using expired_attempts
  where attempt.id = expired_attempts.id;

  with expired_windows as (
    select rate_window.ip_hash, rate_window.window_started_at
    from public.free_check_rate_limit_windows as rate_window
    where rate_window.window_started_at < v_now - interval '30 days'
      and not exists (
        select 1
        from public.free_check_attempts as attempt
        where attempt.ip_hash = rate_window.ip_hash
          and attempt.window_started_at = rate_window.window_started_at
      )
    order by rate_window.window_started_at
    limit 200
    for update of rate_window skip locked
  )
  delete from public.free_check_rate_limit_windows as rate_window
  using expired_windows
  where rate_window.ip_hash = expired_windows.ip_hash
    and rate_window.window_started_at = expired_windows.window_started_at;

  insert into public.free_check_rate_limit_windows (
    ip_hash,
    window_started_at,
    reserved_count,
    attempt_count,
    last_attempt_at
  ) values (
    p_ip_hash,
    v_window_started_at,
    0,
    0,
    v_now
  )
  on conflict (ip_hash, window_started_at) do nothing;

  select rate_window.reserved_count
  into v_reserved_count
  from public.free_check_rate_limit_windows as rate_window
  where rate_window.ip_hash = p_ip_hash
    and rate_window.window_started_at = v_window_started_at
  for update;

  if not found then
    raise exception 'rate limit window unavailable';
  end if;

  v_allowed := v_reserved_count < v_effective_limit;
  v_retry_after_seconds := greatest(
    1,
    ceil(extract(epoch from (
      v_window_started_at + interval '1 hour' - v_now
    )))::integer
  );

  update public.free_check_rate_limit_windows as rate_window
  set reserved_count = rate_window.reserved_count + case when v_allowed then 1 else 0 end,
      attempt_count = case
        when rate_window.attempt_count < 9223372036854775807
          then rate_window.attempt_count + 1
        else rate_window.attempt_count
      end,
      last_attempt_at = v_now
  where rate_window.ip_hash = p_ip_hash
    and rate_window.window_started_at = v_window_started_at;

  if v_allowed then
    insert into public.free_check_attempts (
      id,
      ip_hash,
      url_hash,
      requested_host,
      window_started_at,
      allowed,
      outcome,
      created_at,
      completed_at
    ) values (
      v_attempt_id,
      p_ip_hash,
      p_url_hash,
      lower(p_requested_host),
      v_window_started_at,
      true,
      'reserved',
      v_now,
      null
    );
  else
    select attempt.id
    into v_attempt_id
    from public.free_check_attempts as attempt
    where attempt.ip_hash = p_ip_hash
      and attempt.window_started_at = v_window_started_at
      and not attempt.allowed
    limit 1;

    if not found then
      v_attempt_id := pg_catalog.gen_random_uuid();
      insert into public.free_check_attempts (
        id,
        ip_hash,
        url_hash,
        requested_host,
        window_started_at,
        allowed,
        outcome,
        created_at,
        completed_at
      ) values (
        v_attempt_id,
        p_ip_hash,
        p_url_hash,
        lower(p_requested_host),
        v_window_started_at,
        false,
        'rate_limited',
        v_now,
        v_now
      );
    end if;
  end if;

  return query
  select
    v_attempt_id,
    v_allowed,
    v_retry_after_seconds,
    v_effective_limit,
    v_window_started_at;
end;
$$;

create or replace function public.complete_free_check_attempt(
  p_attempt_id uuid,
  p_outcome text,
  p_failure_kind text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_outcome not in ('succeeded', 'failed') then
    raise exception 'invalid terminal outcome';
  end if;

  if p_outcome = 'succeeded' and p_failure_kind is not null then
    raise exception 'successful outcome cannot have failure kind';
  end if;

  if p_failure_kind is not null
     and char_length(p_failure_kind) not between 1 and 64 then
    raise exception 'invalid failure kind';
  end if;

  update public.free_check_attempts as attempt
  set outcome = p_outcome,
      failure_kind = p_failure_kind,
      completed_at = statement_timestamp()
  where attempt.id = p_attempt_id
    and attempt.allowed
    and attempt.outcome = 'reserved'
    and attempt.completed_at is null;

  return found;
end;
$$;

revoke execute on function public.reserve_free_check_attempt(text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_free_check_attempt(text, text, text, integer)
  to service_role;

revoke execute on function public.complete_free_check_attempt(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_free_check_attempt(uuid, text, text)
  to service_role;

-- One versioned, read-only probe lets the release gate verify the complete
-- invite-only and anonymous free-check database contract without executing a
-- mutating RPC with dummy arguments.
create or replace function public.get_awardping_release_contract_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with requirements (requirement_key, satisfied) as (
    values
      (
        'rpc:get_office_invite_signup_preview(text)',
        pg_catalog.to_regprocedure('public.get_office_invite_signup_preview(text)') is not null
      ),
      (
        'rpc:reserve_office_invite_signup(text)',
        pg_catalog.to_regprocedure('public.reserve_office_invite_signup(text)') is not null
      ),
      (
        'rpc:reconcile_office_invite_signup_auth_user(uuid,uuid,text)',
        pg_catalog.to_regprocedure('public.reconcile_office_invite_signup_auth_user(uuid,uuid,text)') is not null
      ),
      (
        'rpc:complete_office_invite_signup(uuid,uuid,uuid,text)',
        pg_catalog.to_regprocedure('public.complete_office_invite_signup(uuid,uuid,uuid,text)') is not null
      ),
      (
        'rpc:release_office_invite_signup_reservation(uuid,uuid)',
        pg_catalog.to_regprocedure('public.release_office_invite_signup_reservation(uuid,uuid)') is not null
      ),
      (
        'rpc:prepare_office_invite_security_reissue(uuid,uuid,text,text,timestamptz,uuid)',
        pg_catalog.to_regprocedure('public.prepare_office_invite_security_reissue(uuid,uuid,text,text,timestamptz,uuid)') is not null
      ),
      (
        'rpc:record_office_invite_security_reissue_delivery(uuid,uuid,text,text)',
        pg_catalog.to_regprocedure('public.record_office_invite_security_reissue_delivery(uuid,uuid,text,text)') is not null
      ),
      (
        'rpc:accept_office_invite_for_user(text,uuid,text)',
        pg_catalog.to_regprocedure('public.accept_office_invite_for_user(text,uuid,text)') is not null
      ),
      (
        'rpc:get_office_invite_security_reissue_status()',
        pg_catalog.to_regprocedure('public.get_office_invite_security_reissue_status()') is not null
      ),
      (
        'rpc:reserve_free_check_attempt(text,text,text,integer)',
        pg_catalog.to_regprocedure('public.reserve_free_check_attempt(text,text,text,integer)') is not null
      ),
      (
        'rpc:complete_free_check_attempt(uuid,text,text)',
        pg_catalog.to_regprocedure('public.complete_free_check_attempt(uuid,text,text)') is not null
      ),
      (
        'table:public.office_invite_security_reissues',
        pg_catalog.to_regclass('public.office_invite_security_reissues') is not null
      ),
      (
        'table:private.office_invite_signup_reservations',
        pg_catalog.to_regclass('private.office_invite_signup_reservations') is not null
      ),
      (
        'table:public.free_check_rate_limit_windows',
        pg_catalog.to_regclass('public.free_check_rate_limit_windows') is not null
      ),
      (
        'table:public.free_check_attempts',
        pg_catalog.to_regclass('public.free_check_attempts') is not null
      ),
      (
        'column:public.office_invites.signup_email_hash',
        exists (
          select 1
          from pg_catalog.pg_attribute attribute
          where attribute.attrelid = pg_catalog.to_regclass('public.office_invites')
            and attribute.attname = 'signup_email_hash'
            and attribute.atttypid = pg_catalog.to_regtype('text')
            and not attribute.attisdropped
        )
      )
  )
  select pg_catalog.jsonb_build_object(
    'contract_version', 'awardping-release-contract-v1',
    'matches', bool_and(requirements.satisfied),
    'requirement_count', count(*),
    'missing', coalesce(
      pg_catalog.jsonb_agg(requirements.requirement_key order by requirements.requirement_key)
        filter (where not requirements.satisfied),
      '[]'::jsonb
    )
  )
  from requirements;
$$;

revoke all on function public.get_awardping_release_contract_status()
  from public, anon, authenticated, service_role;
grant execute on function public.get_awardping_release_contract_status()
  to service_role;
