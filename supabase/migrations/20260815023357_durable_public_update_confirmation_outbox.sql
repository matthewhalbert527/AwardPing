-- Make public-update confirmation issuance and delivery durable. PostgreSQL
-- owns the confirmation generation and exact 24-hour validity interval; the
-- application only supplies encrypted delivery material and a one-way token
-- hash. Provider retries reuse one immutable idempotency key and never move the
-- database-owned expiry boundary.

create schema if not exists private;
-- Preserve the role-specific USAGE grant required by private office-membership
-- RLS helpers. Object privileges below still make the outbox RPC-only.
revoke all on schema private from public;

alter table public.public_update_subscribers
  add column if not exists confirmation_generation bigint not null default 0,
  add column if not exists confirmation_issued_at timestamptz,
  add column if not exists confirmation_expires_at timestamptz,
  add column if not exists confirmation_contract_version text;

alter table public.public_update_subscribers
  drop constraint if exists public_update_subscribers_confirmation_generation_check;
alter table public.public_update_subscribers
  add constraint public_update_subscribers_confirmation_generation_check
  check (confirmation_generation >= 0);

alter table public.public_update_subscribers
  drop constraint if exists public_update_subscribers_confirmation_clock_check;
alter table public.public_update_subscribers
  add constraint public_update_subscribers_confirmation_clock_check check (
    (
      confirmation_issued_at is null
      and confirmation_expires_at is null
    )
    or (
      confirmation_issued_at is not null
      and confirmation_expires_at = confirmation_issued_at + interval '24 hours'
    )
  );

alter table public.public_update_subscribers
  drop constraint if exists public_update_subscribers_confirmation_contract_check;
alter table public.public_update_subscribers
  add constraint public_update_subscribers_confirmation_contract_check check (
    confirmation_contract_version is null
    or (
      confirmation_contract_version = 'public-confirmation-outbox-v1'
      and confirmation_generation > 0
      and confirmation_issued_at is not null
      and confirmation_expires_at is not null
    )
  );

-- Existing accepted links remain valid for their original 24-hour interval.
-- They are intentionally left with a null contract version so the confirmation
-- RPC can distinguish the pre-outbox compatibility path from all new issuance.
update public.public_update_subscribers subscriber
set
  confirmation_generation = case
    when subscriber.confirmation_token_hash is not null then 1
    else 0
  end,
  confirmation_issued_at = subscriber.confirmation_sent_at,
  confirmation_expires_at = case
    when subscriber.confirmation_sent_at is not null
      then subscriber.confirmation_sent_at + interval '24 hours'
    else null
  end
where subscriber.confirmation_contract_version is null
  and subscriber.confirmation_token_hash is not null
  and (
    subscriber.confirmation_generation = 0
    or subscriber.confirmation_issued_at is null
    or subscriber.confirmation_expires_at is null
  );

create table private.public_update_confirmation_outbox (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid
    references public.public_update_subscribers(id) on delete set null,
  confirmation_generation bigint not null check (confirmation_generation > 0),
  recipient_hash text,
  recipient_encrypted text,
  confirmation_token_hash text,
  confirmation_token_encrypted text,
  rendered_payload_encrypted text,
  payload_schema_version text,
  payload_hash text,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  provider_idempotency_key text,
  status text not null default 'queued' check (
    status in (
      'queued',
      'claimed',
      'sending',
      'accepted',
      'accepted_stale',
      'ambiguous',
      'retry',
      'terminal_failed',
      'stale',
      'confirmed',
      'privacy_scrubbed'
    )
  ),
  send_attempt_count integer not null default 0 check (send_attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null,
  lease_token uuid,
  last_claim_token uuid,
  lease_owner text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  first_provider_attempt_at timestamptz,
  last_provider_attempt_at timestamptz,
  ambiguous_since timestamptz,
  provider_message_id text,
  accepted_at timestamptz,
  confirmed_at timestamptz,
  stale_at timestamptz,
  privacy_scrubbed_at timestamptz,
  last_error text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint public_update_confirmation_outbox_generation_unique
    unique (subscriber_id, confirmation_generation),
  constraint public_update_confirmation_outbox_token_hash_unique
    unique (confirmation_token_hash),
  constraint public_update_confirmation_outbox_provider_key_unique
    unique (provider_idempotency_key),
  constraint public_update_confirmation_outbox_clock_check check (
    expires_at = issued_at + interval '24 hours'
  ),
  constraint public_update_confirmation_outbox_provider_key_check check (
    provider_idempotency_key is null
    or (
      payload_hash is not null
      and provider_idempotency_key =
        'awardping-public-confirmation:' || payload_hash
    )
  ),
  constraint public_update_confirmation_outbox_payload_contract_check check (
    (
      payload_schema_version is null
      and payload_hash is null
    )
    or (
      payload_schema_version is not null
      and
      payload_schema_version = 'public-confirmation-render-v1'
      and payload_hash is not null
      and payload_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  constraint public_update_confirmation_outbox_lease_check check (
    (
      status in ('claimed', 'sending')
      and lease_token is not null
      and last_claim_token is not null
      and last_claim_token = lease_token
      and nullif(pg_catalog.btrim(lease_owner), '') is not null
      and claimed_at is not null
      and lease_expires_at is not null
      and lease_expires_at > claimed_at
    )
    or (
      status not in ('claimed', 'sending')
      and lease_token is null
      and lease_owner is null
      and claimed_at is null
      and lease_expires_at is null
    )
  ),
  constraint public_update_confirmation_outbox_accepted_check check (
    (
      status in ('accepted', 'accepted_stale')
      and accepted_at is not null
      and nullif(pg_catalog.btrim(provider_message_id), '') is not null
    )
    or status not in ('accepted', 'accepted_stale')
  ),
  constraint public_update_confirmation_outbox_ambiguous_check check (
    (status = 'ambiguous' and ambiguous_since is not null)
    or status <> 'ambiguous'
  ),
  constraint public_update_confirmation_outbox_confirmed_check check (
    (status = 'confirmed' and confirmed_at is not null)
    or status <> 'confirmed'
  ),
  constraint public_update_confirmation_outbox_personal_material_check check (
    (
      status in ('queued', 'claimed', 'sending', 'ambiguous', 'retry')
      and subscriber_id is not null
      and recipient_hash is not null
      and recipient_hash ~ '^[0-9a-f]{64}$'
      and recipient_encrypted is not null
      and recipient_encrypted like 'ap:v2:%'
      and confirmation_token_hash is not null
      and confirmation_token_hash ~ '^[0-9a-f]{64}$'
      and confirmation_token_encrypted is not null
      and confirmation_token_encrypted like 'ap:v2:%'
      and rendered_payload_encrypted is not null
      and rendered_payload_encrypted like 'ap:v2:%'
      and payload_schema_version is not null
      and payload_schema_version = 'public-confirmation-render-v1'
      and payload_hash is not null
      and payload_hash ~ '^[0-9a-f]{64}$'
      and provider_idempotency_key is not null
    )
    or (
      status in ('accepted', 'accepted_stale')
      and recipient_encrypted is null
      and confirmation_token_encrypted is null
      and rendered_payload_encrypted is null
      and recipient_hash is not null
      and recipient_hash ~ '^[0-9a-f]{64}$'
      and confirmation_token_hash is not null
      and confirmation_token_hash ~ '^[0-9a-f]{64}$'
      and payload_schema_version is not null
      and payload_schema_version = 'public-confirmation-render-v1'
      and payload_hash is not null
      and payload_hash ~ '^[0-9a-f]{64}$'
      and provider_idempotency_key is not null
    )
    or (
      status in ('terminal_failed', 'stale', 'confirmed')
      and recipient_encrypted is null
      and confirmation_token_encrypted is null
      and rendered_payload_encrypted is null
      and (
        status <> 'confirmed'
        or (
          payload_schema_version is not null
          and
          payload_schema_version = 'public-confirmation-render-v1'
          and payload_hash is not null
          and payload_hash ~ '^[0-9a-f]{64}$'
          and provider_idempotency_key is not null
        )
        or (
          payload_schema_version is null
          and payload_hash is null
          and provider_idempotency_key is null
        )
      )
    )
    or (
      status = 'privacy_scrubbed'
      and subscriber_id is null
      and recipient_hash is null
      and recipient_encrypted is null
      and confirmation_token_hash is null
      and confirmation_token_encrypted is null
      and rendered_payload_encrypted is null
      and payload_schema_version is null
      and payload_hash is null
      and provider_idempotency_key is null
      and provider_message_id is null
    )
  )
);

create index public_update_confirmation_outbox_claim_idx
  on private.public_update_confirmation_outbox
  (status, next_attempt_at, created_at, id);
create index public_update_confirmation_outbox_subscriber_idx
  on private.public_update_confirmation_outbox
  (subscriber_id, confirmation_generation desc);

revoke all on table private.public_update_confirmation_outbox
  from public, anon, authenticated, service_role;

create or replace function public.enqueue_public_update_confirmation(
  p_subscriber_id uuid,
  p_created_at timestamptz,
  p_legacy_email text,
  p_recipient_hash text,
  p_recipient_encrypted text,
  p_confirmation_token_hash text,
  p_confirmation_token_encrypted text,
  p_rendered_payload_encrypted text,
  p_payload_schema_version text,
  p_payload_hash text,
  p_unsubscribe_token_hash text
)
returns table (outbox_id uuid, needs_delivery boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscriber public.public_update_subscribers%rowtype;
  v_current private.public_update_confirmation_outbox%rowtype;
  v_now timestamptz;
  v_generation bigint;
  v_outbox_id uuid;
begin
  if p_subscriber_id is null
    or p_created_at is null
    or p_recipient_hash is null
    or p_recipient_hash !~ '^[0-9a-f]{64}$'
    or p_confirmation_token_hash is null
    or p_confirmation_token_hash !~ '^[0-9a-f]{64}$'
    or p_unsubscribe_token_hash is null
    or p_unsubscribe_token_hash !~ '^[0-9a-f]{64}$'
    or p_recipient_encrypted is null
    or p_recipient_encrypted not like 'ap:v2:%'
    or p_confirmation_token_encrypted is null
    or p_confirmation_token_encrypted not like 'ap:v2:%'
    or p_rendered_payload_encrypted is null
    or p_rendered_payload_encrypted not like 'ap:v2:%'
    or p_payload_schema_version is distinct from 'public-confirmation-render-v1'
    or p_payload_hash is null
    or p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'A subscriber identity, v2 encrypted recipient/token/payload, and exact hashes are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-update-confirmation:' || p_recipient_hash,
      0
    )
  );

  select * into v_subscriber
  from public.public_update_subscribers subscriber
  where subscriber.email_hash = p_recipient_hash
  for update;

  if not found and nullif(pg_catalog.btrim(p_legacy_email), '') is not null then
    select * into v_subscriber
    from public.public_update_subscribers subscriber
    where subscriber.email_hash is null
      and subscriber.email = pg_catalog.lower(pg_catalog.btrim(p_legacy_email))
    for update;
  end if;
  v_now := pg_catalog.clock_timestamp();

  if found and v_subscriber.status = 'active' then
    update public.public_update_subscribers subscriber
    set
      email = null,
      email_hash = p_recipient_hash,
      email_encrypted = p_recipient_encrypted,
      updated_at = v_now
    where subscriber.id = v_subscriber.id;
    return query select null::uuid, false;
    return;
  end if;

  -- Preserve a pre-outbox confirmation that ded6636 already recorded as
  -- provider-accepted. Its original database timestamp and exact expiry were
  -- backfilled above; a repeated signup must not rotate or extend that link.
  if found
    and v_subscriber.status = 'pending'
    and v_subscriber.confirmation_contract_version is null
    and v_subscriber.confirmation_token_hash is not null
    and v_subscriber.confirmation_sent_at is not null
    and v_subscriber.confirmation_issued_at is not null
    and v_subscriber.confirmation_expires_at > v_now then
    return query select null::uuid, false;
    return;
  end if;

  if found then
    select * into v_current
    from private.public_update_confirmation_outbox outbox
    where outbox.subscriber_id = v_subscriber.id
      and outbox.confirmation_generation = v_subscriber.confirmation_generation
    order by outbox.created_at desc, outbox.id
    limit 1
    for update;

    if found
      and v_current.expires_at > v_now
      and v_current.status in (
        'queued', 'claimed', 'sending', 'accepted', 'ambiguous', 'retry'
      ) then
      return query select
        v_current.id,
        v_current.status in ('queued', 'ambiguous', 'retry');
      return;
    end if;

    v_generation := v_subscriber.confirmation_generation + 1;
    update public.public_update_subscribers subscriber
    set
      email = null,
      email_hash = p_recipient_hash,
      email_encrypted = p_recipient_encrypted,
      status = 'pending',
      confirmation_token_hash = p_confirmation_token_hash,
      confirmation_sent_at = null,
      confirmation_generation = v_generation,
      confirmation_issued_at = v_now,
      confirmation_expires_at = v_now + interval '24 hours',
      confirmation_contract_version = 'public-confirmation-outbox-v1',
      confirmed_at = null,
      unsubscribed_at = null,
      updated_at = v_now
    where subscriber.id = v_subscriber.id;
  else
    v_generation := 1;
    insert into public.public_update_subscribers (
      id,
      email,
      email_hash,
      email_encrypted,
      status,
      confirmation_token_hash,
      unsubscribe_token_hash,
      confirmation_sent_at,
      confirmation_generation,
      confirmation_issued_at,
      confirmation_expires_at,
      confirmation_contract_version,
      created_at,
      updated_at
    ) values (
      p_subscriber_id,
      null,
      p_recipient_hash,
      p_recipient_encrypted,
      'pending',
      p_confirmation_token_hash,
      p_unsubscribe_token_hash,
      null,
      v_generation,
      v_now,
      v_now + interval '24 hours',
      'public-confirmation-outbox-v1',
      p_created_at,
      v_now
    )
    returning * into v_subscriber;
  end if;

  insert into private.public_update_confirmation_outbox (
    subscriber_id,
    confirmation_generation,
    recipient_hash,
    recipient_encrypted,
    confirmation_token_hash,
    confirmation_token_encrypted,
    rendered_payload_encrypted,
    payload_schema_version,
    payload_hash,
    issued_at,
    expires_at,
    provider_idempotency_key,
    status,
    next_attempt_at,
    created_at,
    updated_at
  ) values (
    v_subscriber.id,
    v_generation,
    p_recipient_hash,
    p_recipient_encrypted,
    p_confirmation_token_hash,
    p_confirmation_token_encrypted,
    p_rendered_payload_encrypted,
    p_payload_schema_version,
    p_payload_hash,
    v_now,
    v_now + interval '24 hours',
    'awardping-public-confirmation:' || p_payload_hash,
    'queued',
    v_now,
    v_now,
    v_now
  )
  returning id into v_outbox_id;

  return query select v_outbox_id, true;
end;
$$;

revoke all on function public.enqueue_public_update_confirmation(
  uuid, timestamptz, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_public_update_confirmation(
  uuid, timestamptz, text, text, text, text, text, text, text, text, text
) to service_role;

create or replace function public.claim_public_update_confirmations(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 300,
  p_outbox_id uuid default null
)
returns table (
  id uuid,
  lease_token uuid,
  recipient_hash text,
  recipient_encrypted text,
  confirmation_token_hash text,
  confirmation_token_encrypted text,
  rendered_payload_encrypted text,
  payload_schema_version text,
  payload_hash text,
  provider_idempotency_key text,
  expires_at timestamptz,
  send_attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if nullif(pg_catalog.btrim(p_worker_id), '') is null
    or p_limit not between 1 and 100
    or p_lease_seconds not between 30 and 600 then
    raise exception using
      errcode = '22023',
      message = 'A worker, 1-100 claim limit, and 30-600 second lease are required.';
  end if;

  update private.public_update_confirmation_outbox outbox
  set
    status = case
      when outbox.status = 'claimed'
        and outbox.ambiguous_since is not null
        and outbox.expires_at > v_now + interval '5 minutes'
        and outbox.first_provider_attempt_at > v_now - interval '23 hours'
        and outbox.send_attempt_count < outbox.max_attempts
        then 'ambiguous'
      when outbox.status = 'claimed'
        and outbox.expires_at > v_now + interval '5 minutes'
        and outbox.send_attempt_count < outbox.max_attempts
        then 'retry'
      when outbox.status = 'sending'
        and outbox.expires_at > v_now + interval '5 minutes'
        and outbox.first_provider_attempt_at > v_now - interval '23 hours'
        and outbox.send_attempt_count < outbox.max_attempts
        then 'ambiguous'
      else 'stale'
    end,
    ambiguous_since = case
      when outbox.status = 'sending'
        then coalesce(
          outbox.ambiguous_since,
          outbox.first_provider_attempt_at,
          outbox.claimed_at
        )
      else outbox.ambiguous_since
    end,
    next_attempt_at = case
      when (
        outbox.status = 'claimed'
        and outbox.expires_at > v_now + interval '5 minutes'
        and outbox.send_attempt_count < outbox.max_attempts
        and (
          outbox.ambiguous_since is null
          or outbox.first_provider_attempt_at > v_now - interval '23 hours'
        )
      ) or (
        outbox.status = 'sending'
        and outbox.expires_at > v_now + interval '5 minutes'
        and outbox.first_provider_attempt_at > v_now - interval '23 hours'
        and outbox.send_attempt_count < outbox.max_attempts
      )
        then v_now + interval '5 minutes'
      else outbox.next_attempt_at
    end,
    stale_at = case
      when not (
        (
          outbox.status = 'claimed'
          and outbox.expires_at > v_now + interval '5 minutes'
          and outbox.send_attempt_count < outbox.max_attempts
          and (
            outbox.ambiguous_since is null
            or outbox.first_provider_attempt_at > v_now - interval '23 hours'
          )
        ) or (
          outbox.status = 'sending'
          and outbox.expires_at > v_now + interval '5 minutes'
          and outbox.first_provider_attempt_at > v_now - interval '23 hours'
          and outbox.send_attempt_count < outbox.max_attempts
        )
      )
        then coalesce(outbox.stale_at, v_now)
      else outbox.stale_at
    end,
    recipient_encrypted = case
      when not (
        (
          outbox.status = 'claimed'
          and outbox.expires_at > v_now + interval '5 minutes'
          and outbox.send_attempt_count < outbox.max_attempts
          and (
            outbox.ambiguous_since is null
            or outbox.first_provider_attempt_at > v_now - interval '23 hours'
          )
        ) or (
          outbox.status = 'sending'
          and outbox.expires_at > v_now + interval '5 minutes'
          and outbox.first_provider_attempt_at > v_now - interval '23 hours'
          and outbox.send_attempt_count < outbox.max_attempts
        )
      )
        then null
      else outbox.recipient_encrypted
    end,
    confirmation_token_encrypted = case
      when not (
        (
          outbox.status = 'claimed'
          and outbox.expires_at > v_now + interval '5 minutes'
          and outbox.send_attempt_count < outbox.max_attempts
          and (
            outbox.ambiguous_since is null
            or outbox.first_provider_attempt_at > v_now - interval '23 hours'
          )
        ) or (
          outbox.status = 'sending'
          and outbox.expires_at > v_now + interval '5 minutes'
          and outbox.first_provider_attempt_at > v_now - interval '23 hours'
          and outbox.send_attempt_count < outbox.max_attempts
        )
      )
        then null
      else outbox.confirmation_token_encrypted
    end,
    rendered_payload_encrypted = case
      when not (
        (
          outbox.status = 'claimed'
          and outbox.expires_at > v_now + interval '5 minutes'
          and outbox.send_attempt_count < outbox.max_attempts
          and (
            outbox.ambiguous_since is null
            or outbox.first_provider_attempt_at > v_now - interval '23 hours'
          )
        ) or (
          outbox.status = 'sending'
          and outbox.expires_at > v_now + interval '5 minutes'
          and outbox.first_provider_attempt_at > v_now - interval '23 hours'
          and outbox.send_attempt_count < outbox.max_attempts
        )
      )
        then null
      else outbox.rendered_payload_encrypted
    end,
    last_error = case
      when outbox.status = 'sending'
        then coalesce(
          outbox.last_error,
          'Provider request lease expired before acceptance was recorded.'
        )
      else outbox.last_error
    end,
    lease_token = null,
    lease_owner = null,
    claimed_at = null,
    lease_expires_at = null,
    updated_at = v_now
  where outbox.status in ('claimed', 'sending')
    and outbox.lease_expires_at <= v_now;

  update private.public_update_confirmation_outbox outbox
  set
    status = 'stale',
    stale_at = coalesce(outbox.stale_at, v_now),
    recipient_encrypted = null,
    confirmation_token_encrypted = null,
    rendered_payload_encrypted = null,
    last_error = coalesce(
      outbox.last_error,
      'Confirmation token expired before another provider request was authorized.'
    ),
    updated_at = v_now
  where outbox.status in ('queued', 'ambiguous', 'retry')
    and (
      outbox.expires_at <= v_now + interval '5 minutes'
      or outbox.send_attempt_count >= outbox.max_attempts
      or (
        outbox.first_provider_attempt_at is not null
        and outbox.first_provider_attempt_at <= v_now - interval '23 hours'
      )
    );

  update private.public_update_confirmation_outbox outbox
  set
    status = 'stale',
    stale_at = coalesce(outbox.stale_at, v_now),
    recipient_encrypted = null,
    confirmation_token_encrypted = null,
    rendered_payload_encrypted = null,
    last_error = coalesce(
      outbox.last_error,
      'Subscriber confirmation generation changed before provider send.'
    ),
    updated_at = v_now
  where outbox.status in ('queued', 'ambiguous', 'retry')
    and not exists (
      select 1
      from public.public_update_subscribers subscriber
      where subscriber.id = outbox.subscriber_id
        and subscriber.status = 'pending'
        and subscriber.confirmation_contract_version =
          'public-confirmation-outbox-v1'
        and subscriber.confirmation_sent_at is null
        and subscriber.confirmation_generation =
          outbox.confirmation_generation
        and subscriber.confirmation_token_hash =
          outbox.confirmation_token_hash
        and subscriber.email_hash = outbox.recipient_hash
        and subscriber.confirmation_issued_at = outbox.issued_at
        and subscriber.confirmation_expires_at = outbox.expires_at
    );

  return query
  with claimable as (
    select outbox.id, gen_random_uuid() as claim_token
    from private.public_update_confirmation_outbox outbox
    where outbox.status in ('queued', 'ambiguous', 'retry')
      and outbox.next_attempt_at <= v_now
      and outbox.expires_at > v_now + interval '5 minutes'
      and outbox.send_attempt_count < outbox.max_attempts
      and (p_outbox_id is null or outbox.id = p_outbox_id)
      and (
        outbox.first_provider_attempt_at is null
        or outbox.first_provider_attempt_at > v_now - interval '23 hours'
      )
    order by
      case when p_outbox_id is not null and outbox.id = p_outbox_id then 0 else 1 end,
      outbox.next_attempt_at,
      outbox.created_at,
      outbox.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update private.public_update_confirmation_outbox outbox
    set
      status = 'claimed',
      lease_token = claimable.claim_token,
      last_claim_token = claimable.claim_token,
      lease_owner = pg_catalog.btrim(p_worker_id),
      claimed_at = v_now,
      lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = v_now
    from claimable
    where outbox.id = claimable.id
    returning outbox.*
  )
  select
    claimed.id,
    claimed.lease_token,
    claimed.recipient_hash,
    claimed.recipient_encrypted,
    claimed.confirmation_token_hash,
    claimed.confirmation_token_encrypted,
    claimed.rendered_payload_encrypted,
    claimed.payload_schema_version,
    claimed.payload_hash,
    claimed.provider_idempotency_key,
    claimed.expires_at,
    claimed.send_attempt_count
  from claimed
  order by claimed.next_attempt_at, claimed.created_at, claimed.id;
end;
$$;

revoke all on function public.claim_public_update_confirmations(
  text, integer, integer, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.claim_public_update_confirmations(
  text, integer, integer, uuid
) to service_role;

create or replace function public.authorize_public_update_confirmation_send(
  p_outbox_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbox private.public_update_confirmation_outbox%rowtype;
  v_subscriber public.public_update_subscribers%rowtype;
  v_subscriber_id uuid;
  v_now timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  -- A direct subscriber mutation already owns the subscriber row before its
  -- BEFORE trigger can stale the outbox. Match that subscriber -> outbox order
  -- here so authorization cannot form an outbox -> subscriber deadlock cycle.
  select outbox.subscriber_id into v_subscriber_id
  from private.public_update_confirmation_outbox outbox
  where outbox.id = p_outbox_id;
  if not found or v_subscriber_id is null then
    return false;
  end if;

  select * into v_subscriber
  from public.public_update_subscribers subscriber
  where subscriber.id = v_subscriber_id
  for update;
  if not found then return false; end if;

  select * into v_outbox
  from private.public_update_confirmation_outbox outbox
  where outbox.id = p_outbox_id
  for update;
  v_now := pg_catalog.clock_timestamp();
  if not found
    or v_outbox.subscriber_id is distinct from v_subscriber.id
    or v_outbox.status <> 'claimed'
    or v_outbox.lease_token is distinct from p_lease_token
    or v_outbox.lease_expires_at <= v_now then
    return false;
  end if;

  if v_subscriber.status <> 'pending'
    or v_subscriber.confirmation_contract_version is distinct from
      'public-confirmation-outbox-v1'
    or v_subscriber.confirmation_sent_at is not null
    or v_subscriber.confirmation_generation <>
      v_outbox.confirmation_generation
    or v_subscriber.confirmation_token_hash is distinct from
      v_outbox.confirmation_token_hash
    or v_subscriber.email_hash is distinct from v_outbox.recipient_hash
    or v_subscriber.confirmation_issued_at is distinct from v_outbox.issued_at
    or v_subscriber.confirmation_expires_at is distinct from v_outbox.expires_at
    or v_outbox.expires_at <= v_now + interval '5 minutes'
    or v_outbox.send_attempt_count >= v_outbox.max_attempts
    or (
      v_outbox.first_provider_attempt_at is not null
      and v_outbox.first_provider_attempt_at <= v_now - interval '23 hours'
    ) then
    update private.public_update_confirmation_outbox outbox
    set
      status = 'stale',
      stale_at = coalesce(outbox.stale_at, v_now),
      recipient_encrypted = null,
      confirmation_token_encrypted = null,
      rendered_payload_encrypted = null,
      last_error = 'Confirmation send authorization failed its current-generation or expiry fence.',
      lease_token = null,
      lease_owner = null,
      claimed_at = null,
      lease_expires_at = null,
      updated_at = v_now
    where outbox.id = p_outbox_id;
    return false;
  end if;

  update private.public_update_confirmation_outbox outbox
  set
    status = 'sending',
    send_attempt_count = outbox.send_attempt_count + 1,
    first_provider_attempt_at = coalesce(outbox.first_provider_attempt_at, v_now),
    last_provider_attempt_at = v_now,
    lease_expires_at = greatest(
      outbox.lease_expires_at,
      v_now + interval '5 minutes'
    ),
    updated_at = v_now
  where outbox.id = p_outbox_id;
  return true;
end;
$$;

revoke all on function public.authorize_public_update_confirmation_send(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_public_update_confirmation_send(uuid, uuid)
  to service_role;

create or replace function public.complete_public_update_confirmation_send(
  p_outbox_id uuid,
  p_lease_token uuid,
  p_provider_message_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbox private.public_update_confirmation_outbox%rowtype;
  v_subscriber public.public_update_subscribers%rowtype;
  v_subscriber_id uuid;
  v_now timestamptz;
  v_current boolean;
  v_status text;
begin
  if nullif(pg_catalog.btrim(p_provider_message_id), '') is null then
    raise exception using
      errcode = '22023',
      message = 'A provider message ID is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  select outbox.subscriber_id into v_subscriber_id
  from private.public_update_confirmation_outbox outbox
  where outbox.id = p_outbox_id;
  if not found then return 'missing'; end if;

  if v_subscriber_id is not null then
    select * into v_subscriber
    from public.public_update_subscribers subscriber
    where subscriber.id = v_subscriber_id
    for update;
  end if;

  select * into v_outbox
  from private.public_update_confirmation_outbox outbox
  where outbox.id = p_outbox_id
  for update;
  if not found then return 'missing'; end if;
  v_now := pg_catalog.clock_timestamp();
  if v_outbox.status in ('accepted', 'accepted_stale')
    and v_outbox.last_claim_token = p_lease_token
    and v_outbox.provider_message_id = pg_catalog.btrim(p_provider_message_id) then
    return v_outbox.status;
  end if;
  if v_outbox.status = 'privacy_scrubbed'
    or v_outbox.last_claim_token is distinct from p_lease_token
    or v_outbox.send_attempt_count = 0 then
    return v_outbox.status;
  end if;
  if v_outbox.status not in (
    'sending', 'ambiguous', 'retry', 'terminal_failed', 'stale'
  ) then
    return v_outbox.status;
  end if;

  v_current :=
    v_subscriber.id is not null
    and v_outbox.subscriber_id = v_subscriber.id
    and v_subscriber.status = 'pending'
    and v_subscriber.confirmation_contract_version is not distinct from
      'public-confirmation-outbox-v1'
    and v_subscriber.confirmation_sent_at is null
    and v_subscriber.confirmation_generation =
      v_outbox.confirmation_generation
    and v_subscriber.confirmation_token_hash =
      v_outbox.confirmation_token_hash
    and v_subscriber.email_hash = v_outbox.recipient_hash
    and v_subscriber.confirmation_issued_at = v_outbox.issued_at
    and v_subscriber.confirmation_expires_at = v_outbox.expires_at
    and v_outbox.expires_at > v_now
    and v_subscriber.confirmation_expires_at > v_now;
  v_status := case when v_current then 'accepted' else 'accepted_stale' end;

  update private.public_update_confirmation_outbox outbox
  set
    status = v_status,
    provider_message_id = pg_catalog.btrim(p_provider_message_id),
    accepted_at = v_now,
    recipient_encrypted = null,
    confirmation_token_encrypted = null,
    rendered_payload_encrypted = null,
    last_error = null,
    lease_token = null,
    lease_owner = null,
    claimed_at = null,
    lease_expires_at = null,
    updated_at = v_now
  where outbox.id = p_outbox_id;

  if v_current then
    update public.public_update_subscribers subscriber
    set confirmation_sent_at = v_outbox.issued_at, updated_at = v_now
    where subscriber.id = v_outbox.subscriber_id
      and subscriber.status = 'pending'
      and subscriber.confirmation_generation =
        v_outbox.confirmation_generation
      and subscriber.confirmation_token_hash =
        v_outbox.confirmation_token_hash
      and subscriber.confirmation_expires_at > v_now;
  end if;
  return v_status;
end;
$$;

revoke all on function public.complete_public_update_confirmation_send(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.complete_public_update_confirmation_send(
  uuid, uuid, text
) to service_role;

create or replace function public.fail_public_update_confirmation_send(
  p_outbox_id uuid,
  p_lease_token uuid,
  p_error text,
  p_ambiguous boolean,
  p_retryable boolean default true
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbox private.public_update_confirmation_outbox%rowtype;
  v_now timestamptz;
  v_status text;
  v_retry_minutes integer;
begin
  select * into v_outbox
  from private.public_update_confirmation_outbox outbox
  where outbox.id = p_outbox_id
  for update;
  if not found then return 'missing'; end if;
  v_now := pg_catalog.clock_timestamp();
  if v_outbox.status <> 'sending'
    or v_outbox.lease_token is distinct from p_lease_token
    or v_outbox.last_claim_token is distinct from p_lease_token then
    return v_outbox.status;
  end if;

  v_retry_minutes := case
    when p_ambiguous then 5
    else least(
      60,
      pg_catalog.power(
        2::numeric,
        greatest(0, v_outbox.send_attempt_count - 1)
      )::integer
    )
  end;
  v_status := case
    when not p_retryable then 'terminal_failed'
    when v_outbox.send_attempt_count >= v_outbox.max_attempts
      then 'terminal_failed'
    when v_outbox.expires_at <=
      v_now + pg_catalog.make_interval(mins => v_retry_minutes + 5)
      then 'stale'
    when p_ambiguous
      and v_outbox.first_provider_attempt_at <= v_now - interval '23 hours'
      then 'terminal_failed'
    when p_ambiguous then 'ambiguous'
    else 'retry'
  end;

  update private.public_update_confirmation_outbox outbox
  set
    status = v_status,
    ambiguous_since = case
      when p_ambiguous then coalesce(outbox.ambiguous_since, v_now)
      else outbox.ambiguous_since
    end,
    next_attempt_at = case
      when v_status in ('ambiguous', 'retry')
        then v_now + pg_catalog.make_interval(mins => v_retry_minutes)
      else outbox.next_attempt_at
    end,
    stale_at = case
      when v_status = 'stale' then coalesce(outbox.stale_at, v_now)
      else outbox.stale_at
    end,
    recipient_encrypted = case
      when v_status in ('terminal_failed', 'stale') then null
      else outbox.recipient_encrypted
    end,
    confirmation_token_encrypted = case
      when v_status in ('terminal_failed', 'stale') then null
      else outbox.confirmation_token_encrypted
    end,
    rendered_payload_encrypted = case
      when v_status in ('terminal_failed', 'stale') then null
      else outbox.rendered_payload_encrypted
    end,
    last_error = left(
      coalesce(
        nullif(pg_catalog.btrim(p_error), ''),
        'Public-update confirmation delivery failed.'
      ),
      4000
    ),
    lease_token = null,
    lease_owner = null,
    claimed_at = null,
    lease_expires_at = null,
    updated_at = v_now
  where outbox.id = p_outbox_id;
  return v_status;
end;
$$;

revoke all on function public.fail_public_update_confirmation_send(
  uuid, uuid, text, boolean, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.fail_public_update_confirmation_send(
  uuid, uuid, text, boolean, boolean
) to service_role;

create or replace function public.confirm_public_update_subscription(
  p_confirmation_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscriber public.public_update_subscribers%rowtype;
  v_outbox private.public_update_confirmation_outbox%rowtype;
  v_now timestamptz;
begin
  if p_confirmation_token_hash is null
    or p_confirmation_token_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  select * into v_subscriber
  from public.public_update_subscribers subscriber
  where subscriber.confirmation_token_hash = p_confirmation_token_hash
  for update;
  v_now := pg_catalog.clock_timestamp();
  if not found
    or v_subscriber.status <> 'pending'
    or v_subscriber.confirmation_issued_at is null
    or v_subscriber.confirmation_expires_at is null
    or v_now < v_subscriber.confirmation_issued_at
    or v_now >= v_subscriber.confirmation_expires_at then
    return false;
  end if;

  if v_subscriber.confirmation_contract_version =
    'public-confirmation-outbox-v1' then
    select * into v_outbox
    from private.public_update_confirmation_outbox outbox
    where outbox.subscriber_id = v_subscriber.id
      and outbox.confirmation_generation =
        v_subscriber.confirmation_generation
      and outbox.confirmation_token_hash = p_confirmation_token_hash
    for update;
    if not found
      or v_outbox.status <> 'accepted'
      or v_outbox.issued_at <> v_subscriber.confirmation_issued_at
      or v_outbox.expires_at <> v_subscriber.confirmation_expires_at
      or v_subscriber.confirmation_sent_at is distinct from
        v_outbox.issued_at then
      return false;
    end if;

    update private.public_update_confirmation_outbox outbox
    set
      status = 'confirmed',
      subscriber_id = v_subscriber.id,
      confirmed_at = v_now,
      updated_at = v_now
    where outbox.id = v_outbox.id;
  elsif v_subscriber.confirmation_contract_version is null then
    if v_subscriber.confirmation_sent_at is null
      or v_subscriber.confirmation_generation <= 0 then
      return false;
    end if;

    -- Give a provider-accepted pre-outbox link the same durable, DB-clock
    -- activation receipt required by every v1 link. No recoverable delivery
    -- payload is synthesized for this compatibility-only row.
    insert into private.public_update_confirmation_outbox (
      subscriber_id,
      confirmation_generation,
      recipient_hash,
      confirmation_token_hash,
      issued_at,
      expires_at,
      status,
      next_attempt_at,
      confirmed_at,
      last_error,
      created_at,
      updated_at
    ) values (
      v_subscriber.id,
      v_subscriber.confirmation_generation,
      v_subscriber.email_hash,
      p_confirmation_token_hash,
      v_subscriber.confirmation_issued_at,
      v_subscriber.confirmation_expires_at,
      'confirmed',
      v_now,
      v_now,
      'Pre-outbox provider acceptance activated through the DB-clock compatibility path.',
      v_now,
      v_now
    );
  else
    return false;
  end if;

  update public.public_update_subscribers subscriber
  set
    status = 'active',
    confirmation_token_hash = null,
    confirmed_at = v_now,
    digest_started_at = v_now,
    unsubscribed_at = null,
    updated_at = v_now
  where subscriber.id = v_subscriber.id;
  return true;
end;
$$;

revoke all on function public.confirm_public_update_subscription(text)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_public_update_subscription(text)
  to service_role;

-- Serialize subscriber invalidation with provider authorization. Any direct
-- update/delete path (including privacy erasure) receives the same fence, and
-- deletion scrubs recoverable confirmation delivery material before the FK is
-- detached.
create or replace function private.fence_sending_digest_subscriber_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_confirmation_invalidated boolean := tg_op = 'DELETE';
begin
  -- During a rolling deploy, a ded6636 instance omits the durable-contract
  -- columns. Retain the request identity but neutralize its token before that
  -- instance reaches its provider-current check, so it still returns the same
  -- generic 202 without sending a confirmation that was never enqueued.
  if tg_op = 'INSERT' then
    if new.status = 'pending'
      and new.confirmation_token_hash is not null
      and new.confirmation_contract_version is null
      and new.confirmation_generation = 0
      and new.confirmation_issued_at is null
      and new.confirmation_expires_at is null then
      new.confirmation_token_hash := null;
      new.confirmation_sent_at := null;
    end if;
    return new;
  end if;

  -- Likewise, turn an old-shaped direct token rotation into a successful
  -- no-op. The old adapter receives its expected row representation, but its
  -- subsequent exact token/current-state check fails before provider I/O.
  if tg_op = 'UPDATE'
    and new.status = 'pending'
    and new.confirmation_token_hash is not null
    and new.confirmation_token_hash is distinct from old.confirmation_token_hash
    and new.confirmation_generation = old.confirmation_generation
    and new.confirmation_issued_at is not distinct from old.confirmation_issued_at
    and new.confirmation_expires_at is not distinct from old.confirmation_expires_at
    and new.confirmation_contract_version is not distinct from
      old.confirmation_contract_version then
    return old;
  end if;

  if exists (
    select 1
    from public.public_digest_outbox outbox
    where outbox.subscriber_id = old.id
      and outbox.status = 'sending'
      and outbox.lease_expires_at > v_now
  ) then
    raise exception using
      errcode = '40001',
      message = 'Subscriber mutation must retry after the active public digest send lease.';
  end if;

  if tg_op = 'UPDATE' then
    -- A provider request that began before this migration may report its
    -- acceptance afterward. Preserve only that exact old mark mutation. Its
    -- original attempt seal remains the immutable expiry anchor, so migration
    -- latency cannot extend a legacy token; activation still uses DB time.
    if old.status = 'pending'
      and old.confirmation_contract_version is null
      and old.confirmation_token_hash is not null
      and old.confirmation_sent_at is null
      and new.confirmation_token_hash = old.confirmation_token_hash
      and new.confirmation_sent_at = old.updated_at
      and (
        pg_catalog.to_jsonb(new)
          - 'confirmation_sent_at'
          - 'updated_at'
      ) = (
        pg_catalog.to_jsonb(old)
          - 'confirmation_sent_at'
          - 'updated_at'
      ) then
      new.confirmation_generation := greatest(old.confirmation_generation, 1);
      new.confirmation_issued_at := new.confirmation_sent_at;
      new.confirmation_expires_at :=
        new.confirmation_sent_at + interval '24 hours';
    end if;

    v_confirmation_invalidated :=
      new.status <> 'pending'
      or new.confirmation_generation is distinct from old.confirmation_generation
      or new.confirmation_token_hash is distinct from old.confirmation_token_hash
      or new.email_hash is distinct from old.email_hash
      or new.confirmation_sent_at is distinct from old.confirmation_sent_at
      or new.confirmation_issued_at is distinct from old.confirmation_issued_at
      or new.confirmation_expires_at is distinct from old.confirmation_expires_at
      or new.confirmation_contract_version is distinct from
        old.confirmation_contract_version;

    -- Activation is never a direct table mutation. The confirmation RPC first
    -- writes a matching DB-clock receipt, then this trigger permits its exact
    -- subscriber transition in the same transaction.
    if old.status = 'pending' and new.status = 'active' and not exists (
      select 1
      from private.public_update_confirmation_outbox outbox
      where outbox.subscriber_id = old.id
        and outbox.confirmation_generation = old.confirmation_generation
        and outbox.confirmation_token_hash = old.confirmation_token_hash
        and outbox.issued_at = old.confirmation_issued_at
        and outbox.expires_at = old.confirmation_expires_at
        and outbox.status = 'confirmed'
        and outbox.confirmed_at = new.confirmed_at
        and new.confirmed_at = new.digest_started_at
        and new.updated_at = new.confirmed_at
        and new.confirmation_token_hash is null
    ) then
      raise exception using
        errcode = '40001',
        message = 'Public-update activation requires the atomic DB-clock confirmation RPC.';
    end if;
  end if;

  if v_confirmation_invalidated and exists (
    select 1
    from private.public_update_confirmation_outbox outbox
    where outbox.subscriber_id = old.id
      and outbox.status = 'sending'
      and outbox.lease_expires_at > v_now
  ) then
    raise exception using
      errcode = '40001',
      message = 'Subscriber mutation must retry after the active confirmation send lease.';
  end if;

  if tg_op = 'DELETE' then
    update private.public_update_confirmation_outbox outbox
    set
      subscriber_id = null,
      recipient_hash = null,
      recipient_encrypted = null,
      confirmation_token_hash = null,
      confirmation_token_encrypted = null,
      rendered_payload_encrypted = null,
      payload_schema_version = null,
      payload_hash = null,
      provider_idempotency_key = null,
      provider_message_id = null,
      status = 'privacy_scrubbed',
      privacy_scrubbed_at = v_now,
      last_error = 'Confirmation delivery material erased with its subscriber.',
      lease_token = null,
      lease_owner = null,
      claimed_at = null,
      lease_expires_at = null,
      updated_at = v_now
    where outbox.subscriber_id = old.id;
    return old;
  end if;

  if v_confirmation_invalidated then
    update private.public_update_confirmation_outbox outbox
    set
      status = 'stale',
      stale_at = coalesce(outbox.stale_at, v_now),
      recipient_encrypted = null,
      confirmation_token_encrypted = null,
      rendered_payload_encrypted = null,
      last_error = coalesce(
        outbox.last_error,
        'Subscriber state invalidated this confirmation generation.'
      ),
      lease_token = null,
      lease_owner = null,
      claimed_at = null,
      lease_expires_at = null,
      updated_at = v_now
    where outbox.subscriber_id = old.id
      and (
        outbox.status in ('queued', 'claimed', 'ambiguous', 'retry')
        or (
          outbox.status = 'sending'
          and outbox.lease_expires_at <= v_now
        )
      );
  end if;
  return new;
end;
$$;

revoke all on function private.fence_sending_digest_subscriber_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists fence_sending_digest_subscriber_mutation_trigger
  on public.public_update_subscribers;
create trigger fence_sending_digest_subscriber_mutation_trigger
before insert or update or delete on public.public_update_subscribers
for each row execute function private.fence_sending_digest_subscriber_mutation();

create or replace function public.unsubscribe_public_update_subscriber(
  p_unsubscribe_token_hash text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscriber public.public_update_subscribers%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_unsubscribe_token_hash is null
    or p_unsubscribe_token_hash !~ '^[0-9a-f]{64}$' then
    return 'not_found';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  select * into v_subscriber
  from public.public_update_subscribers subscriber
  where subscriber.unsubscribe_token_hash = p_unsubscribe_token_hash
  for update;
  if not found then return 'not_found'; end if;

  if exists (
    select 1
    from public.public_digest_outbox outbox
    where outbox.subscriber_id = v_subscriber.id
      and outbox.status = 'sending'
      and outbox.lease_expires_at > v_now
  ) or exists (
    select 1
    from private.public_update_confirmation_outbox outbox
    where outbox.subscriber_id = v_subscriber.id
      and outbox.status = 'sending'
      and outbox.lease_expires_at > v_now
  ) then
    return 'retry_active_send';
  end if;

  update public.public_update_subscribers subscriber
  set
    status = 'unsubscribed',
    confirmation_token_hash = null,
    unsubscribed_at = v_now,
    updated_at = v_now
  where subscriber.id = v_subscriber.id;
  return 'unsubscribed';
end;
$$;

revoke all on function public.unsubscribe_public_update_subscriber(text)
  from public, anon, authenticated, service_role;
grant execute on function public.unsubscribe_public_update_subscriber(text)
  to service_role;

create or replace function public.erase_public_update_subscriber(
  p_email_hash text,
  p_legacy_email text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscriber_ids uuid[];
  v_deleted_count integer := 0;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_email_hash is null
    and nullif(pg_catalog.btrim(p_legacy_email), '') is null then
    return 0;
  end if;
  if p_email_hash is not null and p_email_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'A valid personal-data lookup hash is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  perform 1
  from public.public_update_subscribers subscriber
  where (p_email_hash is not null and subscriber.email_hash = p_email_hash)
    or (
      nullif(pg_catalog.btrim(p_legacy_email), '') is not null
      and subscriber.email = pg_catalog.lower(pg_catalog.btrim(p_legacy_email))
    )
  for update;
  select coalesce(pg_catalog.array_agg(subscriber.id), '{}'::uuid[])
  into v_subscriber_ids
  from public.public_update_subscribers subscriber
  where (p_email_hash is not null and subscriber.email_hash = p_email_hash)
    or (
      nullif(pg_catalog.btrim(p_legacy_email), '') is not null
      and subscriber.email = pg_catalog.lower(pg_catalog.btrim(p_legacy_email))
    );

  if exists (
    select 1
    from public.public_digest_outbox outbox
    where (
      outbox.subscriber_id = any(v_subscriber_ids)
      or (p_email_hash is not null and outbox.recipient_hash = p_email_hash)
    )
      and outbox.status = 'sending'
      and outbox.lease_expires_at > v_now
  ) or exists (
    select 1
    from private.public_update_confirmation_outbox outbox
    where (
      outbox.subscriber_id = any(v_subscriber_ids)
      or (p_email_hash is not null and outbox.recipient_hash = p_email_hash)
    )
      and outbox.status = 'sending'
      and outbox.lease_expires_at > v_now
  ) then
    raise exception using
      errcode = '40001',
      message = 'Privacy erasure must retry after an active public email send lease.';
  end if;

  update private.public_update_confirmation_outbox outbox
  set
    subscriber_id = null,
    recipient_hash = null,
    recipient_encrypted = null,
    confirmation_token_hash = null,
    confirmation_token_encrypted = null,
    rendered_payload_encrypted = null,
    payload_schema_version = null,
    payload_hash = null,
    provider_idempotency_key = null,
    provider_message_id = null,
    status = 'privacy_scrubbed',
    privacy_scrubbed_at = v_now,
    last_error = 'Confirmation delivery material erased at the subscriber request.',
    lease_token = null,
    lease_owner = null,
    claimed_at = null,
    lease_expires_at = null,
    updated_at = v_now
  where outbox.subscriber_id = any(v_subscriber_ids)
    or (p_email_hash is not null and outbox.recipient_hash = p_email_hash);

  update public.public_digest_outbox outbox
  set
    subscriber_id = null,
    recipient_hash = null,
    recipient_encrypted = null,
    rendered_payload = null,
    status = 'privacy_scrubbed',
    last_error = 'Personal delivery material erased at the subscriber request.',
    lease_token = null,
    lease_owner = null,
    leased_at = null,
    lease_expires_at = null,
    next_attempt_at = v_now,
    updated_at = v_now
  where outbox.subscriber_id = any(v_subscriber_ids)
    or (p_email_hash is not null and outbox.recipient_hash = p_email_hash);

  update public.public_update_deliveries delivery
  set subscriber_id = null, recipient = null, recipient_hash = null
  where delivery.subscriber_id = any(v_subscriber_ids)
    or (p_email_hash is not null and delivery.recipient_hash = p_email_hash)
    or (
      nullif(pg_catalog.btrim(p_legacy_email), '') is not null
      and pg_catalog.lower(pg_catalog.btrim(delivery.recipient)) =
        pg_catalog.lower(pg_catalog.btrim(p_legacy_email))
    );

  delete from public.public_update_subscribers subscriber
  where subscriber.id = any(v_subscriber_ids);
  get diagnostics v_deleted_count = row_count;
  return v_deleted_count;
end;
$$;

revoke all on function public.erase_public_update_subscriber(text, text)
  from public, anon, authenticated, service_role;
-- This superseded erasure entrypoint lacks privacy-request/tombstone binding.
-- Keep the explicit deny established by 20260717123000; runtime erasure must
-- continue through erase_personal_data_for_privacy_request.
