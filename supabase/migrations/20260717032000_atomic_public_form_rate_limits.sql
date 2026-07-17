-- Serialize every public form-rate reservation by exact kind/IP window so a
-- parallel burst cannot pass a count-then-insert race and trigger unbounded
-- email/provider work.

create or replace function public.reserve_public_form_rate_limit(
  p_kind text,
  p_ip_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_window_started_at timestamptz;
  v_count integer;
  v_oldest timestamptz;
begin
  if p_kind not in ('subscribe', 'contact', 'source_request') then
    raise exception using errcode = '22023', message = 'Unknown public form rate-limit kind.';
  end if;
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'A SHA-256 IP hash is required.';
  end if;
  if p_limit is null or p_limit not between 1 and 100
    or p_window_seconds is null or p_window_seconds not between 60 and 86400 then
    raise exception using errcode = '22023', message = 'The public form limit or window is invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-form-rate-limit:' || p_kind || ':' || p_ip_hash,
      0
    )
  );

  v_window_started_at := v_now - pg_catalog.make_interval(secs => p_window_seconds);
  select count(*)::integer, min(rate.created_at)
  into v_count, v_oldest
  from public.public_form_rate_limits rate
  where rate.kind = p_kind
    and rate.ip_hash = p_ip_hash
    and rate.created_at >= v_window_started_at;

  if v_count >= p_limit then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'effective_limit', p_limit,
      'retry_after_seconds', pg_catalog.greatest(
        1,
        pg_catalog.ceil(
          pg_catalog.extract(epoch from (
            coalesce(v_oldest, v_now) + pg_catalog.make_interval(secs => p_window_seconds) - v_now
          ))
        )::integer
      )
    );
  end if;

  insert into public.public_form_rate_limits (kind, ip_hash, created_at)
  values (p_kind, p_ip_hash, v_now);

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'remaining', p_limit - v_count - 1,
    'effective_limit', p_limit,
    'retry_after_seconds', 0
  );
end;
$$;

revoke all on function public.reserve_public_form_rate_limit(text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_public_form_rate_limit(text, text, integer, integer)
  to service_role;

revoke insert, update, delete, truncate on table public.public_form_rate_limits
  from public, anon, authenticated, service_role;
grant select on table public.public_form_rate_limits to service_role;

comment on function public.reserve_public_form_rate_limit(text, text, integer, integer) is
  'Atomically reserves one public subscribe/contact/source-request attempt under an exact kind/IP rolling window.';
