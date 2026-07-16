-- Paid reservation release must be a compare-and-set operation. A stale
-- pre-create recovery may observe `reserved` only to race with the real owner
-- moving the same reservation to `creating`; releasing after that transition
-- would reopen budget while a provider call can exist.

drop function if exists public.release_gemini_spend_reservation(uuid, text);

create function public.release_gemini_spend_reservation(
  p_reservation_id uuid,
  p_reason text,
  p_expected_status text default null,
  p_expected_attempt_token uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_reason text := pg_catalog.btrim(p_reason);
  v_expected_status text := nullif(pg_catalog.btrim(p_expected_status), '');
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
  if v_expected_status is not null
    and v_expected_status not in ('reserved', 'creating', 'submitted', 'settled', 'released')
  then
    raise exception 'expected_status is invalid';
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
      'source', 'postgres_atomic_budget_v2_compare_and_set'
    );
  end if;

  if v_expected_status is not null and v_reservation.status is distinct from v_expected_status then
    return pg_catalog.jsonb_build_object(
      'released', false,
      'reason', 'reservation_state_changed',
      'reservation_id', v_reservation.id,
      'expected_status', v_expected_status,
      'actual_status', v_reservation.status,
      'source', 'postgres_atomic_budget_v2_compare_and_set'
    );
  end if;
  if p_expected_attempt_token is not null
    and v_reservation.attempt_token is distinct from p_expected_attempt_token
  then
    return pg_catalog.jsonb_build_object(
      'released', false,
      'reason', 'reservation_owner_changed',
      'reservation_id', v_reservation.id,
      'actual_status', v_reservation.status,
      'source', 'postgres_atomic_budget_v2_compare_and_set'
    );
  end if;

  -- Submitted calls remain reserved until settlement. Creating calls can be
  -- released only by their exact attempt owner with definitive evidence that
  -- the provider POST was not reached or definitively failed.
  if v_reservation.status = 'submitted' then
    raise exception 'submitted reservation % requires settlement and cannot be released', p_reservation_id;
  end if;
  if v_reservation.status = 'creating' and (
    p_expected_attempt_token is null
    or (
      v_reason not like 'provider_create_not_reached:%'
      and v_reason not like 'provider_create_definitively_failed:%'
      and v_reason <> 'provider_create_definitively_failed'
    )
  ) then
    raise exception 'provider-started reservation % requires owner-bound definitive no-create evidence or settlement', p_reservation_id;
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
    pg_catalog.jsonb_build_object(
      'reason', v_reason,
      'expected_status', v_expected_status,
      'owner_verified', p_expected_attempt_token is not null
    ),
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
    'source', 'postgres_atomic_budget_v2_compare_and_set'
  );
end;
$$;

revoke all on function public.release_gemini_spend_reservation(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.release_gemini_spend_reservation(uuid, text, text, uuid)
  to service_role;

notify pgrst, 'reload schema';
