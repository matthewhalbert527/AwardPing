-- Give every subscriber/event pair one durable delivery reservation. Daily
-- presentation batches remain capped at 12 events, but a burst is split into
-- as many immutable outbox rows as necessary and no rolling time window can
-- duplicate or age an event out unseen.

alter table public.public_update_subscribers
  add column if not exists digest_started_at timestamptz;

update public.public_update_subscribers subscriber
set digest_started_at = coalesce(
  subscriber.confirmed_at,
  subscriber.created_at,
  pg_catalog.clock_timestamp()
)
where subscriber.digest_started_at is null;

alter table public.public_update_subscribers
  alter column digest_started_at set default pg_catalog.clock_timestamp(),
  alter column digest_started_at set not null;

alter table public.public_update_deliveries
  drop constraint if exists public_update_deliveries_subscriber_id_digest_key_key;

alter table public.public_digest_outbox
  add column if not exists batch_sequence integer not null default 1
    check (batch_sequence > 0);

alter table public.public_digest_outbox
  drop constraint if exists public_digest_outbox_subscriber_digest_unique;

create unique index if not exists public_digest_outbox_subscriber_digest_batch_idx
  on public.public_digest_outbox (subscriber_id, digest_key, batch_sequence)
  where subscriber_id is not null;

create table public.public_digest_event_receipts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  subscriber_id uuid
    references public.public_update_subscribers(id) on delete set null,
  change_event_id uuid not null
    references public.shared_award_change_events(id) on delete restrict,
  outbox_id uuid
    references public.public_digest_outbox(id) on delete restrict,
  legacy_delivery_id uuid
    references public.public_update_deliveries(id) on delete restrict,
  status text not null check (
    status in (
      'reserved',
      'sent',
      'terminal_failed',
      'release_blocked',
      'superseded_unsent',
      'privacy_scrubbed'
    )
  ),
  sent_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint public_digest_event_receipt_owner_check check (
    pg_catalog.num_nonnulls(outbox_id, legacy_delivery_id) = 1
  ),
  constraint public_digest_event_receipt_sent_check check (
    (status = 'sent' and sent_at is not null)
    or (status <> 'sent' and sent_at is null)
  ),
  constraint public_digest_event_receipt_outbox_event_unique
    unique (outbox_id, change_event_id),
  constraint public_digest_event_receipt_legacy_event_unique
    unique (legacy_delivery_id, change_event_id)
);

create unique index public_digest_event_receipt_subscriber_event_idx
  on public.public_digest_event_receipts (subscriber_id, change_event_id)
  where subscriber_id is not null;

create index public_digest_event_receipt_outbox_idx
  on public.public_digest_event_receipts (outbox_id, status);

create index public_digest_event_receipt_pair_cursor_idx
  on public.public_digest_event_receipts (subscriber_id, change_event_id, id)
  where subscriber_id is not null;

create index if not exists public_update_subscribers_active_cursor_idx
  on public.public_update_subscribers (id)
  where status = 'active';

alter table public.public_digest_event_receipts enable row level security;
revoke all on table public.public_digest_event_receipts
  from public, anon, authenticated, service_role;
grant select on table public.public_digest_event_receipts to service_role;

insert into public.public_digest_event_receipts (
  subscriber_id,
  change_event_id,
  legacy_delivery_id,
  status,
  sent_at,
  created_at,
  updated_at
)
select distinct on (delivery.subscriber_id, event_id)
  delivery.subscriber_id,
  event_id,
  delivery.id,
  case when delivery.status = 'sent' then 'sent' else 'terminal_failed' end,
  case when delivery.status = 'sent' then delivery.sent_at else null end,
  delivery.created_at,
  delivery.created_at
from public.public_update_deliveries delivery
cross join lateral pg_catalog.unnest(delivery.change_event_ids) event_id
where delivery.outbox_id is null
order by
  delivery.subscriber_id,
  event_id,
  (delivery.status = 'sent') desc,
  delivery.created_at asc,
  delivery.id asc;

insert into public.public_digest_event_receipts (
  subscriber_id,
  change_event_id,
  outbox_id,
  status,
  sent_at,
  created_at,
  updated_at
)
select distinct on (outbox.subscriber_id, event_id)
  outbox.subscriber_id,
  event_id,
  outbox.id,
  case
    when outbox.status = 'sent' then 'sent'
    when outbox.status = 'terminal_failed' then 'terminal_failed'
    when outbox.status = 'release_blocked' then 'release_blocked'
    when outbox.status = 'privacy_scrubbed' then 'privacy_scrubbed'
    else 'reserved'
  end,
  case when outbox.status = 'sent' then outbox.sent_at else null end,
  outbox.created_at,
  outbox.updated_at
from public.public_digest_outbox outbox
cross join lateral pg_catalog.unnest(outbox.change_event_ids) event_id
where outbox.subscriber_id is not null
  and not (
    outbox.status in ('queued', 'leased', 'release_blocked')
    and outbox.send_attempt_count = 0
    and outbox.first_provider_attempt_at is null
    and outbox.last_provider_attempt_at is null
    and outbox.ambiguous_since is null
    and outbox.sent_at is null
    and outbox.provider_message_id is null
    and not exists (
      select 1
      from public.public_update_deliveries delivery
      where delivery.outbox_id = outbox.id
        or delivery.provider_idempotency_key = outbox.provider_idempotency_key
        or delivery.payload_hash = outbox.payload_hash
    )
  )
order by
  outbox.subscriber_id,
  event_id,
  (outbox.status = 'sent') desc,
  (outbox.provider_message_id is not null) desc,
  (outbox.status = 'sending') desc,
  (outbox.ambiguous_since is not null) desc,
  (
    outbox.send_attempt_count > 0
    or outbox.first_provider_attempt_at is not null
    or outbox.last_provider_attempt_at is not null
    or outbox.ambiguous_since is not null
    or outbox.status in ('sending', 'ambiguous')
  ) desc,
  outbox.created_at asc,
  outbox.id asc
on conflict do nothing;

create or replace function private.public_digest_outbox_owns_complete_receipt_set(
  p_outbox_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      (
        select pg_catalog.count(*)
        from public.public_digest_event_receipts receipt
        where receipt.outbox_id = outbox.id
      ) = pg_catalog.cardinality(outbox.change_event_ids)
      and not exists (
        select 1
        from public.public_digest_event_receipts receipt
        where receipt.outbox_id = outbox.id
          and (
            receipt.subscriber_id is distinct from outbox.subscriber_id
            or not (receipt.change_event_id = any(outbox.change_event_ids))
            or receipt.status is distinct from case
              when outbox.status = 'sent' then 'sent'
              when outbox.status = 'terminal_failed' then 'terminal_failed'
              when outbox.status = 'release_blocked' then 'release_blocked'
              when outbox.status = 'privacy_scrubbed' then 'privacy_scrubbed'
              else 'reserved'
            end
            or receipt.sent_at is distinct from case
              when outbox.status = 'sent' then outbox.sent_at
              else null
            end
          )
      )
    from public.public_digest_outbox outbox
    where outbox.id = p_outbox_id
      and outbox.subscriber_id is not null
  ), false);
$$;

revoke all on function private.public_digest_outbox_owns_complete_receipt_set(uuid)
  from public, anon, authenticated, service_role;

-- Every pre-ledger row that provably never reached provider authorization is
-- frozen and rebuilt through the new one-receipt-per-event enqueue path.
update public.public_digest_outbox outbox
set
  status = 'release_blocked',
  lease_token = null,
  lease_owner = null,
  leased_at = null,
  lease_expires_at = null,
  next_attempt_at = pg_catalog.clock_timestamp(),
  last_error = pg_catalog.concat_ws(
    ' ',
    nullif(pg_catalog.btrim(outbox.last_error), ''),
    'Pre-ledger zero-attempt digest was safely frozen for event-ledger rebuild.'
  ),
  updated_at = pg_catalog.clock_timestamp()
where outbox.status in ('queued', 'leased', 'release_blocked')
  and outbox.send_attempt_count = 0
  and outbox.first_provider_attempt_at is null
  and outbox.last_provider_attempt_at is null
  and outbox.ambiguous_since is null
  and outbox.sent_at is null
  and outbox.provider_message_id is null
  and not exists (
    select 1
    from public.public_update_deliveries delivery
    where delivery.outbox_id = outbox.id
      or delivery.provider_idempotency_key = outbox.provider_idempotency_key
      or delivery.payload_hash = outbox.payload_hash
  );

-- Any retained attempted row with partial ownership is non-sendable and stays
-- visible for operator resolution; its owned receipts continue to deduplicate.
update public.public_digest_outbox outbox
set
  status = 'release_blocked',
  lease_token = null,
  lease_owner = null,
  leased_at = null,
  lease_expires_at = null,
  next_attempt_at = pg_catalog.clock_timestamp(),
  last_error = pg_catalog.concat_ws(
    ' ',
    nullif(pg_catalog.btrim(outbox.last_error), ''),
    'Pre-ledger digest has partial event-receipt ownership and requires operator resolution.'
  ),
  updated_at = pg_catalog.clock_timestamp()
where outbox.status in ('queued', 'leased', 'ambiguous', 'terminal_failed', 'release_blocked')
  and not private.public_digest_outbox_owns_complete_receipt_set(outbox.id)
  and not (
    outbox.send_attempt_count = 0
    and outbox.first_provider_attempt_at is null
    and outbox.last_provider_attempt_at is null
    and outbox.ambiguous_since is null
    and outbox.sent_at is null
    and outbox.provider_message_id is null
    and not exists (
      select 1
      from public.public_update_deliveries delivery
      where delivery.outbox_id = outbox.id
        or delivery.provider_idempotency_key = outbox.provider_idempotency_key
        or delivery.payload_hash = outbox.payload_hash
    )
  );

update public.public_digest_event_receipts receipt
set
  status = 'release_blocked',
  sent_at = null,
  updated_at = pg_catalog.clock_timestamp()
from public.public_digest_outbox outbox
where outbox.id = receipt.outbox_id
  and outbox.status = 'release_blocked'
  and receipt.sent_at is null
  and receipt.status in ('reserved', 'terminal_failed', 'release_blocked');

create or replace function private.sync_public_digest_event_receipts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op = 'INSERT' then
    insert into public.public_digest_event_receipts (
      subscriber_id,
      change_event_id,
      outbox_id,
      status,
      sent_at
    )
    select new.subscriber_id, event_id, new.id, 'reserved', null
    from pg_catalog.unnest(new.change_event_ids) event_id;
    return new;
  end if;

  v_status := case
    when new.status = 'sent' then 'sent'
    when new.status = 'terminal_failed' then 'terminal_failed'
    when new.status = 'release_blocked' then 'release_blocked'
    when new.status = 'privacy_scrubbed' then 'privacy_scrubbed'
    else 'reserved'
  end;
  update public.public_digest_event_receipts receipt
  set
    subscriber_id = case when v_status = 'privacy_scrubbed' then null else receipt.subscriber_id end,
    status = v_status,
    sent_at = case when v_status = 'sent' then new.sent_at else null end,
    updated_at = pg_catalog.clock_timestamp()
  where receipt.outbox_id = new.id;
  return new;
end;
$$;

revoke all on function private.sync_public_digest_event_receipts()
  from public, anon, authenticated, service_role;

drop trigger if exists sync_public_digest_event_receipts_after_insert
  on public.public_digest_outbox;
create trigger sync_public_digest_event_receipts_after_insert
after insert on public.public_digest_outbox
for each row execute function private.sync_public_digest_event_receipts();

drop trigger if exists sync_public_digest_event_receipts_after_status
  on public.public_digest_outbox;
create trigger sync_public_digest_event_receipts_after_status
after update of status, sent_at on public.public_digest_outbox
for each row
when (old.status is distinct from new.status or old.sent_at is distinct from new.sent_at)
execute function private.sync_public_digest_event_receipts();

create or replace function private.fence_public_digest_send_without_complete_receipts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'sending'
    and old.status is distinct from new.status
    and not private.public_digest_outbox_owns_complete_receipt_set(old.id) then
    raise exception using
      errcode = '40001',
      message = 'Digest provider authorization requires complete exclusive event-receipt ownership.';
  end if;
  return new;
end;
$$;

revoke all on function private.fence_public_digest_send_without_complete_receipts()
  from public, anon, authenticated, service_role;

drop trigger if exists fence_public_digest_send_without_complete_receipts_trigger
  on public.public_digest_outbox;
create trigger fence_public_digest_send_without_complete_receipts_trigger
before update of status on public.public_digest_outbox
for each row execute function private.fence_public_digest_send_without_complete_receipts();

create or replace function public.authorize_public_digest_send(
  p_outbox_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbox public.public_digest_outbox%rowtype;
  v_subscriber public.public_update_subscribers%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  select * into v_outbox
  from public.public_digest_outbox outbox
  where outbox.id = p_outbox_id
  for update;
  if not found
    or v_outbox.status <> 'leased'
    or v_outbox.lease_token is distinct from p_lease_token
    or v_outbox.lease_expires_at <= pg_catalog.clock_timestamp() then
    return false;
  end if;

  if v_outbox.send_attempt_count >= v_outbox.max_attempts
    or (
      v_outbox.ambiguous_since is not null
      and (
        v_outbox.first_provider_attempt_at is null
        or v_outbox.first_provider_attempt_at <= pg_catalog.clock_timestamp() - interval '23 hours'
      )
    ) then
    update public.public_digest_outbox outbox
    set
      status = 'terminal_failed',
      last_error = 'The digest retry authorization window or attempt limit was exhausted before provider send.',
      lease_token = null,
      lease_owner = null,
      leased_at = null,
      lease_expires_at = null,
      updated_at = pg_catalog.clock_timestamp()
    where outbox.id = p_outbox_id;
    return false;
  end if;

  if not private.public_digest_outbox_owns_complete_receipt_set(v_outbox.id) then
    update public.public_digest_outbox outbox
    set
      status = 'release_blocked',
      last_error = 'Digest provider authorization was blocked because this historical batch does not own a complete exclusive event-receipt set.',
      lease_token = null,
      lease_owner = null,
      leased_at = null,
      lease_expires_at = null,
      updated_at = pg_catalog.clock_timestamp()
    where outbox.id = p_outbox_id;
    return false;
  end if;

  select * into v_subscriber
  from public.public_update_subscribers subscriber
  where subscriber.id = v_outbox.subscriber_id
  for key share;
  if not found
    or v_subscriber.status <> 'active'
    or v_subscriber.email_hash is distinct from v_outbox.recipient_hash then
    update public.public_digest_outbox outbox
    set
      status = 'release_blocked',
      last_error = 'The subscriber unsubscribed or its recipient binding changed before provider send.',
      lease_token = null,
      lease_owner = null,
      leased_at = null,
      lease_expires_at = null,
      updated_at = pg_catalog.clock_timestamp()
    where outbox.id = p_outbox_id;
    return false;
  end if;

  perform 1
  from public.shared_award_change_events change_event
  where change_event.id = any(v_outbox.change_event_ids)
  for key share;

  if not private.public_digest_release_is_current(
    v_outbox.release_epoch,
    v_outbox.release_policy_version,
    v_outbox.release_identity_version,
    v_outbox.release_identity_hash
  )
    or public.awardping_sha256_text(v_outbox.event_bindings::text) is distinct from
      v_outbox.eligibility_seal_hash
    or not private.public_digest_events_are_current(v_outbox.event_bindings) then
    update public.public_digest_outbox outbox
    set
      status = 'release_blocked',
      last_error = 'The Stage 1 release or a frozen event eligibility binding changed before provider send.',
      lease_token = null,
      lease_owner = null,
      leased_at = null,
      lease_expires_at = null,
      updated_at = pg_catalog.clock_timestamp()
    where outbox.id = p_outbox_id;
    return false;
  end if;

  update public.public_digest_outbox outbox
  set
    status = 'sending',
    send_attempt_count = outbox.send_attempt_count + 1,
    first_provider_attempt_at = coalesce(
      outbox.first_provider_attempt_at,
      pg_catalog.clock_timestamp()
    ),
    last_provider_attempt_at = pg_catalog.clock_timestamp(),
    lease_expires_at = greatest(
      outbox.lease_expires_at,
      pg_catalog.clock_timestamp() + interval '5 minutes'
    ),
    updated_at = pg_catalog.clock_timestamp()
  where outbox.id = p_outbox_id;
  return true;
end;
$$;

revoke all on function public.authorize_public_digest_send(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_public_digest_send(uuid, uuid)
  to service_role;

create or replace function public.fail_public_digest_send(
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
  v_outbox public.public_digest_outbox%rowtype;
  v_status text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_retry_delay_minutes integer;
begin
  select * into v_outbox
  from public.public_digest_outbox outbox
  where outbox.id = p_outbox_id
  for update;
  if not found then return 'missing'; end if;
  if v_outbox.status <> 'sending'
    or v_outbox.lease_token is distinct from p_lease_token
    or v_outbox.last_claim_token is distinct from p_lease_token then
    return v_outbox.status;
  end if;

  if p_ambiguous then
    v_status := case
      when p_retryable
        and v_outbox.send_attempt_count < v_outbox.max_attempts
        and v_outbox.first_provider_attempt_at > v_now - interval '23 hours'
        then 'ambiguous'
      else 'terminal_failed'
    end;
    v_retry_delay_minutes := 5;
  else
    v_status := case
      when p_retryable and v_outbox.send_attempt_count < v_outbox.max_attempts
        then 'queued'
      else 'terminal_failed'
    end;
    v_retry_delay_minutes := least(
      60,
      pg_catalog.power(2::numeric, greatest(0, v_outbox.send_attempt_count - 1))::integer
    );
  end if;

  if v_status in ('queued', 'ambiguous')
    and not private.public_digest_outbox_owns_complete_receipt_set(v_outbox.id) then
    v_status := 'release_blocked';
  end if;

  update public.public_digest_outbox outbox
  set
    status = v_status,
    ambiguous_since = case
      when p_ambiguous then coalesce(outbox.ambiguous_since, v_now)
      else outbox.ambiguous_since
    end,
    next_attempt_at = case
      when v_status in ('queued', 'ambiguous')
        then v_now + pg_catalog.make_interval(mins => v_retry_delay_minutes)
      else outbox.next_attempt_at
    end,
    last_error = left(
      case
        when v_status = 'release_blocked' then pg_catalog.concat_ws(
          ' ',
          coalesce(nullif(pg_catalog.btrim(p_error), ''), 'Public digest delivery failed.'),
          'Automatic retry was blocked because this historical batch does not own a complete exclusive event-receipt set.'
        )
        else coalesce(nullif(pg_catalog.btrim(p_error), ''), 'Public digest delivery failed.')
      end,
      4000
    ),
    lease_token = null,
    lease_owner = null,
    leased_at = null,
    lease_expires_at = null,
    updated_at = v_now
  where outbox.id = p_outbox_id;
  return v_status;
end;
$$;

revoke all on function public.fail_public_digest_send(uuid, uuid, text, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.fail_public_digest_send(uuid, uuid, text, boolean, boolean)
  to service_role;

create or replace function private.freeze_public_digest_batch_sequence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.batch_sequence is distinct from new.batch_sequence then
    raise exception using errcode = '55000', message = 'A frozen digest batch sequence is immutable.';
  end if;
  return new;
end;
$$;

revoke all on function private.freeze_public_digest_batch_sequence()
  from public, anon, authenticated, service_role;

create trigger freeze_public_digest_batch_sequence_trigger
before update on public.public_digest_outbox
for each row execute function private.freeze_public_digest_batch_sequence();

-- A release rotation invalidates an unsent frozen payload. Free only rows whose
-- delivery outcome is still definitively "not sent" so the same events can be
-- rendered under the new release identity. Sent and ambiguous history remains
-- permanently reserved, including terminal rows descended from ambiguity.
create or replace function public.supersede_stale_public_digest_reservations(
  p_expected_release_epoch uuid,
  p_expected_release_policy_version text,
  p_expected_release_identity_version text,
  p_expected_release_identity_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbox_ids uuid[];
  v_outbox_count integer := 0;
  v_expected_receipt_count integer := 0;
  v_receipt_count integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  if not private.public_digest_release_is_current(
    p_expected_release_epoch,
    p_expected_release_policy_version,
    p_expected_release_identity_version,
    p_expected_release_identity_hash
  ) then
    raise exception using
      errcode = '40001',
      message = 'The complete Stage 1 release is not current; stale digest reservations were not superseded.';
  end if;

  v_outbox_ids := array(
    select outbox.id
    from public.public_digest_outbox outbox
    where outbox.release_key = 'stage1-national-25'
      and (
        outbox.release_epoch is distinct from p_expected_release_epoch
        or outbox.release_policy_version is distinct from p_expected_release_policy_version
        or outbox.release_identity_version is distinct from p_expected_release_identity_version
        or outbox.release_identity_hash is distinct from p_expected_release_identity_hash
      )
      and outbox.status in ('queued', 'leased', 'release_blocked')
      and outbox.send_attempt_count = 0
      and outbox.first_provider_attempt_at is null
      and outbox.last_provider_attempt_at is null
      and outbox.ambiguous_since is null
      and outbox.sent_at is null
      and outbox.provider_message_id is null
      and not exists (
        select 1
        from public.public_update_deliveries delivery
        where delivery.outbox_id = outbox.id
          or delivery.provider_idempotency_key = outbox.provider_idempotency_key
          or delivery.payload_hash = outbox.payload_hash
          or (
            delivery.outbox_id is null
            and delivery.subscriber_id = outbox.subscriber_id
            and delivery.change_event_ids && outbox.change_event_ids
          )
      )
      and (
        select pg_catalog.count(*)
        from public.public_digest_event_receipts receipt
        where receipt.outbox_id = outbox.id
      ) = pg_catalog.cardinality(outbox.change_event_ids)
      and not exists (
        select 1
        from public.public_digest_event_receipts receipt
        where receipt.outbox_id = outbox.id
          and (
            receipt.subscriber_id is distinct from outbox.subscriber_id
            or not (receipt.change_event_id = any(outbox.change_event_ids))
            or receipt.sent_at is not null
            or receipt.status is distinct from case
              when outbox.status = 'release_blocked' then 'release_blocked'
              else 'reserved'
            end
          )
      )
    order by outbox.id
    for update
  );

  if coalesce(pg_catalog.cardinality(v_outbox_ids), 0) = 0 then
    return pg_catalog.jsonb_build_object(
      'superseded_outbox_rows', 0,
      'released_event_reservations', 0
    );
  end if;

  perform receipt.id
  from public.public_digest_event_receipts receipt
  where receipt.outbox_id = any(v_outbox_ids)
  order by receipt.outbox_id, receipt.change_event_id
  for update;

  select coalesce(pg_catalog.sum(pg_catalog.cardinality(outbox.change_event_ids)), 0)::integer
  into v_expected_receipt_count
  from public.public_digest_outbox outbox
  where outbox.id = any(v_outbox_ids);

  update public.public_digest_outbox outbox
  set
    status = 'release_blocked',
    lease_token = null,
    lease_owner = null,
    leased_at = null,
    lease_expires_at = null,
    next_attempt_at = pg_catalog.clock_timestamp(),
    last_error = pg_catalog.concat_ws(
      ' ',
      nullif(pg_catalog.btrim(outbox.last_error), ''),
      'Definitively unsent reservation superseded after the Stage 1 release identity changed.'
    ),
    updated_at = pg_catalog.clock_timestamp()
  where outbox.id = any(v_outbox_ids);
  get diagnostics v_outbox_count = row_count;

  update public.public_digest_event_receipts receipt
  set
    subscriber_id = null,
    status = 'superseded_unsent',
    sent_at = null,
    updated_at = pg_catalog.clock_timestamp()
  where receipt.outbox_id = any(v_outbox_ids)
    and receipt.subscriber_id is not null;
  get diagnostics v_receipt_count = row_count;

  if v_receipt_count <> v_expected_receipt_count then
    raise exception using
      errcode = '40001',
      message = 'The stale digest receipt set changed while it was being superseded; retry safely.';
  end if;

  return pg_catalog.jsonb_build_object(
    'superseded_outbox_rows', v_outbox_count,
    'released_event_reservations', v_receipt_count
  );
end;
$$;

revoke all on function public.supersede_stale_public_digest_reservations(uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.supersede_stale_public_digest_reservations(uuid, text, text, text)
  to service_role;

create or replace function private.supersede_stale_public_digest_reservations_on_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.release_key = 'stage1-national-25'
    and new.release_state = 'verified_beta' then
    if tg_op = 'INSERT' then
      perform public.supersede_stale_public_digest_reservations(
        new.release_epoch,
        new.policy_version,
        new.cohort_identity_version,
        new.cohort_identity_hash
      );
    elsif old.release_epoch is distinct from new.release_epoch
      or old.policy_version is distinct from new.policy_version
      or old.cohort_identity_version is distinct from new.cohort_identity_version
      or old.cohort_identity_hash is distinct from new.cohort_identity_hash then
      perform public.supersede_stale_public_digest_reservations(
        new.release_epoch,
        new.policy_version,
        new.cohort_identity_version,
        new.cohort_identity_hash
      );
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.supersede_stale_public_digest_reservations_on_release()
  from public, anon, authenticated, service_role;

drop trigger if exists supersede_stale_public_digest_reservations_on_release_trigger
  on public.stage1_publication_release_state;
create trigger supersede_stale_public_digest_reservations_on_release_trigger
after insert or update on public.stage1_publication_release_state
for each row execute function private.supersede_stale_public_digest_reservations_on_release();

create or replace function public.enqueue_public_digest_outbox(
  p_digest_key text,
  p_expected_release_epoch uuid,
  p_expected_release_policy_version text,
  p_expected_release_identity_version text,
  p_expected_release_identity_hash text,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry jsonb;
  v_payload jsonb;
  v_bindings jsonb;
  v_subscriber public.public_update_subscribers%rowtype;
  v_existing public.public_digest_outbox%rowtype;
  v_payload_hash text;
  v_event_ids uuid[];
  v_batch_sequence integer;
  v_enqueued integer := 0;
  v_reactivated integer := 0;
  v_existing_count integer := 0;
  v_legacy_blocked integer := 0;
begin
  if p_digest_key !~ '^\d{4}-\d{2}-\d{2}$'
    or pg_catalog.to_date(p_digest_key, 'YYYY-MM-DD')::text <> p_digest_key then
    raise exception using errcode = '22023', message = 'A valid UTC digest key is required.';
  end if;
  if pg_catalog.jsonb_typeof(p_entries) <> 'array'
    or pg_catalog.jsonb_array_length(p_entries) > 500 then
    raise exception using errcode = '22023', message = 'Digest enqueue entries must be an array of at most 500 rows.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  if not private.public_digest_release_is_current(
    p_expected_release_epoch,
    p_expected_release_policy_version,
    p_expected_release_identity_version,
    p_expected_release_identity_hash
  ) then
    raise exception using
      errcode = '40001',
      message = 'The complete Stage 1 release is not current; no digest was enqueued.';
  end if;

  for v_entry in select entry.value from pg_catalog.jsonb_array_elements(p_entries) entry(value)
  loop
    v_payload := v_entry -> 'rendered_payload';
    v_bindings := v_payload -> 'eventBindings';
    if pg_catalog.jsonb_typeof(v_payload) <> 'object'
      or v_payload ->> 'schemaVersion' <> 'public-digest-render-v1'
      or v_payload ->> 'digestKey' <> p_digest_key
      or v_payload ->> 'recipientHash' <> v_entry ->> 'recipient_hash'
      or v_payload #>> '{release,releaseKey}' <> 'stage1-national-25'
      or v_payload #>> '{release,releaseEpoch}' <> p_expected_release_epoch::text
      or v_payload #>> '{release,policyVersion}' <> p_expected_release_policy_version
      or v_payload #>> '{release,identityVersion}' <> p_expected_release_identity_version
      or v_payload #>> '{release,identityHash}' <> p_expected_release_identity_hash
      or nullif(pg_catalog.btrim(v_payload ->> 'from'), '') is null
      or nullif(pg_catalog.btrim(v_payload ->> 'subject'), '') is null
      or nullif(pg_catalog.btrim(v_payload ->> 'html'), '') is null
      or nullif(pg_catalog.btrim(v_payload ->> 'text'), '') is null
      or pg_catalog.jsonb_typeof(v_bindings) <> 'array'
      or pg_catalog.jsonb_array_length(v_bindings) not between 1 and 12 then
      raise exception using errcode = '22023', message = 'A complete rendered digest payload is required.';
    end if;
    if coalesce(v_entry ->> 'recipient_hash', '') !~ '^[0-9a-f]{64}$'
      or nullif(pg_catalog.btrim(v_entry ->> 'recipient_encrypted'), '') is null then
      raise exception using errcode = '22023', message = 'A sealed digest recipient is required.';
    end if;

    select * into v_subscriber
    from public.public_update_subscribers subscriber
    where subscriber.id = (v_entry ->> 'subscriber_id')::uuid
    for update;
    if not found
      or v_subscriber.status <> 'active'
      or v_subscriber.email_hash is distinct from v_entry ->> 'recipient_hash' then
      raise exception using errcode = '23514', message = 'The digest subscriber is not active or its recipient binding changed.';
    end if;

    v_event_ids := array(
      select (binding.value ->> 'eventId')::uuid
      from pg_catalog.jsonb_array_elements(v_bindings)
        with ordinality as binding(value, ordinality)
      order by binding.ordinality
    );
    perform 1
    from public.shared_award_change_events change_event
    where change_event.id = any(v_event_ids)
    for key share;
    if not private.public_digest_events_are_current(v_bindings) then
      raise exception using
        errcode = '40001',
        message = 'A proposed digest event no longer satisfies its frozen public eligibility binding.';
    end if;

    v_payload_hash := public.awardping_sha256_text(v_payload::text);
    select * into v_existing
    from public.public_digest_outbox outbox
    where outbox.subscriber_id = v_subscriber.id
      and outbox.payload_hash = v_payload_hash
    for update;
    if found then
      if v_existing.status = 'release_blocked'
        and v_existing.release_epoch = p_expected_release_epoch
        and v_existing.release_policy_version = p_expected_release_policy_version
        and v_existing.release_identity_version = p_expected_release_identity_version
        and v_existing.release_identity_hash = p_expected_release_identity_hash
        and v_existing.change_event_ids = v_event_ids
        and v_existing.send_attempt_count = 0
        and v_existing.first_provider_attempt_at is null
        and v_existing.last_provider_attempt_at is null
        and v_existing.ambiguous_since is null
        and v_existing.sent_at is null
        and v_existing.provider_message_id is null
        and not exists (
          select 1
          from public.public_digest_event_receipts receipt
          where receipt.outbox_id = v_existing.id
        )
        and not exists (
          select 1
          from public.public_update_deliveries delivery
          where delivery.outbox_id = v_existing.id
            or delivery.provider_idempotency_key = v_existing.provider_idempotency_key
            or delivery.payload_hash = v_existing.payload_hash
            or (
              delivery.outbox_id is null
              and delivery.subscriber_id = v_existing.subscriber_id
              and delivery.change_event_ids && v_existing.change_event_ids
            )
        ) then
        insert into public.public_digest_event_receipts (
          subscriber_id,
          change_event_id,
          outbox_id,
          status,
          sent_at
        )
        select v_existing.subscriber_id, event_id, v_existing.id, 'reserved', null
        from pg_catalog.unnest(v_existing.change_event_ids) event_id;

        update public.public_digest_outbox outbox
        set
          status = 'queued',
          next_attempt_at = pg_catalog.clock_timestamp(),
          last_error = pg_catalog.concat_ws(
            ' ',
            nullif(pg_catalog.btrim(outbox.last_error), ''),
            'Pre-ledger zero-attempt payload reactivated with complete event-ledger ownership.'
          ),
          updated_at = pg_catalog.clock_timestamp()
        where outbox.id = v_existing.id;
        v_reactivated := v_reactivated + 1;
        continue;
      end if;
      v_existing_count := v_existing_count + 1;
      continue;
    end if;

    if exists (
      select 1
      from public.public_update_deliveries delivery
      where delivery.subscriber_id = v_subscriber.id
        and delivery.outbox_id is null
        and delivery.change_event_ids && v_event_ids
    ) then
      v_legacy_blocked := v_legacy_blocked + 1;
      continue;
    end if;
    if exists (
      select 1
      from public.public_digest_event_receipts receipt
      where receipt.subscriber_id = v_subscriber.id
        and receipt.change_event_id = any(v_event_ids)
    ) then
      raise exception using
        errcode = '40001',
        message = 'A digest event was reserved concurrently; reload the subscriber ledger before rendering.';
    end if;

    select coalesce(max(outbox.batch_sequence), 0) + 1
    into v_batch_sequence
    from public.public_digest_outbox outbox
    where outbox.subscriber_id = v_subscriber.id
      and outbox.digest_key = p_digest_key;

    insert into public.public_digest_outbox (
      subscriber_id,
      digest_key,
      batch_sequence,
      recipient_hash,
      recipient_encrypted,
      release_key,
      release_epoch,
      release_policy_version,
      release_identity_version,
      release_identity_hash,
      change_event_ids,
      event_bindings,
      rendered_payload,
      payload_schema_version,
      payload_hash,
      eligibility_seal_hash,
      provider_idempotency_key
    ) values (
      v_subscriber.id,
      p_digest_key,
      v_batch_sequence,
      v_entry ->> 'recipient_hash',
      v_entry ->> 'recipient_encrypted',
      'stage1-national-25',
      p_expected_release_epoch,
      p_expected_release_policy_version,
      p_expected_release_identity_version,
      p_expected_release_identity_hash,
      v_event_ids,
      v_bindings,
      v_payload,
      'public-digest-render-v1',
      v_payload_hash,
      public.awardping_sha256_text(v_bindings::text),
      'awardping-public-digest:' || v_payload_hash
    );
    v_enqueued := v_enqueued + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'digest_key', p_digest_key,
    'enqueued', v_enqueued,
    'reactivated', v_reactivated,
    'already_frozen', v_existing_count,
    'legacy_blocked', v_legacy_blocked
  );
end;
$$;

revoke all on function public.enqueue_public_digest_outbox(text, uuid, text, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_public_digest_outbox(text, uuid, text, text, text, jsonb)
  to service_role;

comment on table public.public_digest_event_receipts is
  'Durable per-subscriber event reservations preventing duplicate or omitted public digest updates across overlapping runs and presentation batches.';
