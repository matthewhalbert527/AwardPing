-- Durable, release-fenced public digest delivery.
--
-- Application code may render and propose a payload, but only the database can
-- enqueue it, lease it, authorize the irreversible provider request, or record
-- completion. The provider idempotency key is derived from the immutable
-- payload hash. A provider request whose outcome is unknown may only be retried
-- while the original key is conservatively younger than 23 hours.

create schema if not exists private;
revoke all on schema private from public;

alter table public.public_update_deliveries
  add column if not exists outbox_id uuid,
  add column if not exists delivery_contract_version text,
  add column if not exists payload_hash text,
  add column if not exists provider_message_id text;

alter table public.public_update_deliveries
  alter column subscriber_id drop not null;
alter table public.public_update_deliveries
  drop constraint if exists public_update_deliveries_subscriber_id_fkey;
alter table public.public_update_deliveries
  add constraint public_update_deliveries_subscriber_id_fkey
  foreign key (subscriber_id)
  references public.public_update_subscribers(id) on delete set null;

alter table public.public_update_deliveries
  drop constraint if exists public_update_deliveries_outbox_id_fkey;

create table if not exists public.public_digest_outbox (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid
    references public.public_update_subscribers(id) on delete set null,
  digest_key text not null check (digest_key ~ '^\d{4}-\d{2}-\d{2}$'),
  recipient_hash text,
  recipient_encrypted text,
  release_key text not null check (release_key = 'stage1-national-25'),
  release_epoch uuid not null,
  release_policy_version text not null check (length(btrim(release_policy_version)) > 0),
  release_identity_version text not null check (length(btrim(release_identity_version)) > 0),
  release_identity_hash text not null check (release_identity_hash ~ '^[0-9a-f]{64}$'),
  change_event_ids uuid[] not null check (
    cardinality(change_event_ids) between 1 and 12
  ),
  event_bindings jsonb not null check (
    jsonb_typeof(event_bindings) = 'array'
    and jsonb_array_length(event_bindings) between 1 and 12
  ),
  rendered_payload jsonb,
  payload_schema_version text not null
    check (payload_schema_version = 'public-digest-render-v1'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  eligibility_seal_hash text not null check (eligibility_seal_hash ~ '^[0-9a-f]{64}$'),
  provider_idempotency_key text not null
    check (provider_idempotency_key = 'awardping-public-digest:' || payload_hash),
  status text not null default 'queued' check (
    status in (
      'queued',
      'leased',
      'sending',
      'ambiguous',
      'sent',
      'terminal_failed',
      'release_blocked',
      'privacy_scrubbed'
    )
  ),
  send_attempt_count integer not null default 0 check (send_attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  last_claim_token uuid,
  lease_owner text,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  first_provider_attempt_at timestamptz,
  last_provider_attempt_at timestamptz,
  ambiguous_since timestamptz,
  provider_message_id text,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_digest_outbox_subscriber_digest_unique
    unique (subscriber_id, digest_key),
  constraint public_digest_outbox_payload_hash_unique unique (payload_hash),
  constraint public_digest_outbox_provider_key_unique unique (provider_idempotency_key),
  constraint public_digest_outbox_event_binding_count_check check (
    cardinality(change_event_ids) = jsonb_array_length(event_bindings)
  ),
  constraint public_digest_outbox_personal_material_check check (
    (
      status = 'privacy_scrubbed'
      and subscriber_id is null
      and recipient_hash is null
      and recipient_encrypted is null
      and rendered_payload is null
    )
    or (
      status <> 'privacy_scrubbed'
      and subscriber_id is not null
      and recipient_hash ~ '^[0-9a-f]{64}$'
      and nullif(btrim(recipient_encrypted), '') is not null
      and jsonb_typeof(rendered_payload) = 'object'
    )
  ),
  constraint public_digest_outbox_lease_state_check check (
    (
      status in ('leased', 'sending')
      and lease_token is not null
      and last_claim_token = lease_token
      and nullif(btrim(lease_owner), '') is not null
      and leased_at is not null
      and lease_expires_at is not null
      and lease_expires_at > leased_at
    )
    or (
      status not in ('leased', 'sending')
      and lease_token is null
      and lease_owner is null
      and leased_at is null
      and lease_expires_at is null
    )
  ),
  constraint public_digest_outbox_ambiguous_state_check check (
    (status = 'ambiguous' and ambiguous_since is not null)
    or status <> 'ambiguous'
  ),
  constraint public_digest_outbox_sent_state_check check (
    (
      status = 'sent'
      and sent_at is not null
      and nullif(btrim(provider_message_id), '') is not null
    )
    or (
      status not in ('sent', 'privacy_scrubbed')
      and sent_at is null
    )
    or status = 'privacy_scrubbed'
  )
);

alter table public.public_update_deliveries
  add constraint public_update_deliveries_outbox_id_fkey
  foreign key (outbox_id) references public.public_digest_outbox(id) on delete restrict;

create unique index if not exists public_update_deliveries_outbox_idx
  on public.public_update_deliveries (outbox_id)
  where outbox_id is not null;

create index if not exists public_digest_outbox_claim_idx
  on public.public_digest_outbox (status, next_attempt_at, created_at, id);

create index if not exists public_digest_outbox_active_lease_idx
  on public.public_digest_outbox (release_epoch, lease_expires_at)
  where status = 'sending';

alter table public.public_digest_outbox enable row level security;
revoke all on table public.public_digest_outbox from public, anon, authenticated;
revoke insert, update, delete, truncate
  on table public.public_digest_outbox from service_role;
grant select on table public.public_digest_outbox to service_role;

-- New final delivery rows must be written by complete_public_digest_send().
-- Existing rows remain nullable and therefore remain honestly identifiable as
-- legacy deliveries without a sealed payload/outbox contract.
revoke insert, update, delete, truncate
  on table public.public_update_deliveries from service_role;
grant select on table public.public_update_deliveries to service_role;

create or replace function private.public_digest_release_is_current(
  p_release_epoch uuid,
  p_release_policy_version text,
  p_release_identity_version text,
  p_release_identity_hash text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    count(*) = 25
    and bool_and(
      effective.effectively_verified
      and effective.effective_reason = 'verified'
      and effective.release_epoch = p_release_epoch
      and effective.release_state = 'verified_beta'
      and effective.release_policy_version = p_release_policy_version
      and effective.release_identity_version = p_release_identity_version
      and effective.release_identity_hash = p_release_identity_hash
    ),
    false
  )
  from public.list_stage1_effective_publication() effective;
$$;

revoke all on function private.public_digest_release_is_current(uuid, text, text, text)
  from public, anon, authenticated, service_role;

create or replace function private.public_digest_events_are_current(
  p_event_bindings jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with bindings as (
    select binding.value
    from pg_catalog.jsonb_array_elements(p_event_bindings) binding(value)
  ), validated as (
    select change_event.id
    from bindings binding
    join public.shared_award_change_events change_event
      on change_event.id = (binding.value ->> 'eventId')::uuid
    join public.shared_award_sources source
      on source.id = change_event.shared_award_source_id
      and source.shared_award_id = change_event.shared_award_id
    join public.stage1_award_members member
      on member.shared_award_id = change_event.shared_award_id
    join public.stage1_award_registry registry
      on registry.cohort_key = member.cohort_key
    join public.shared_award_change_event_visual_evidence evidence
      on evidence.change_event_id = change_event.id
    where change_event.shared_award_id = (binding.value ->> 'memberAwardId')::uuid
      and registry.canonical_shared_award_id = (binding.value ->> 'awardId')::uuid
      and registry.canonical_name = binding.value ->> 'awardName'
      and change_event.shared_award_source_id = (binding.value ->> 'sourceId')::uuid
      and change_event.source_url = binding.value ->> 'sourceUrl'
      and coalesce(pg_catalog.to_jsonb(change_event.source_title), 'null'::jsonb) =
        coalesce(binding.value -> 'eventSourceTitle', 'null'::jsonb)
      and coalesce(pg_catalog.to_jsonb(change_event.source_page_type), 'null'::jsonb) =
        coalesce(binding.value -> 'eventSourcePageType', 'null'::jsonb)
      and change_event.summary = binding.value ->> 'eventSummary'
      and coalesce(change_event.change_details, 'null'::jsonb) =
        coalesce(binding.value -> 'eventChangeDetails', 'null'::jsonb)
      and source.url = change_event.source_url
      and source.admin_review_status = 'open'
      and change_event.detected_at = (binding.value ->> 'detectedAt')::timestamptz
      and change_event.suppressed_at is null
      and nullif(pg_catalog.btrim(change_event.change_details ->> 'suppressed_at'), '') is null
      and nullif(pg_catalog.btrim(change_event.change_details ->> 'suppression_reason'), '') is null
      and change_event.visual_review_candidate_id is not distinct from
        nullif(binding.value ->> 'visualReviewCandidateId', '')::uuid
      and evidence.id = (binding.value ->> 'visualEvidenceId')::uuid
      and evidence.shared_award_id = change_event.shared_award_id
      and evidence.shared_award_source_id is not distinct from change_event.shared_award_source_id
      and evidence.visual_review_candidate_id is not distinct from
        change_event.visual_review_candidate_id
      and evidence.evidence_status = binding.value ->> 'visualEvidenceStatus'
      and evidence.evidence_schema_version = binding.value ->> 'visualEvidenceSchemaVersion'
      and evidence.candidate_signature is not distinct from
        nullif(binding.value ->> 'visualEvidenceCandidateSignature', '')
      and exists (
        select 1
        from public.stage1_award_source_manifest manifest
        where manifest.cohort_key = registry.cohort_key
          and change_event.shared_award_source_id = any(manifest.source_ids)
      )
  )
  select coalesce(
    pg_catalog.jsonb_typeof(p_event_bindings) = 'array'
    and pg_catalog.jsonb_array_length(p_event_bindings) between 1 and 12
    and (select count(*) from bindings) =
      (select count(distinct binding.value ->> 'eventId') from bindings binding)
    and (select count(*) from validated) = (select count(*) from bindings),
    false
  );
$$;

revoke all on function private.public_digest_events_are_current(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.freeze_public_digest_outbox_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'Public digest outbox rows are durable and cannot be deleted.';
  end if;

  if new.status = 'privacy_scrubbed' and old.status <> 'privacy_scrubbed' then
    if new.subscriber_id is not null
      or new.recipient_hash is not null
      or new.recipient_encrypted is not null
      or new.rendered_payload is not null
      or old.digest_key is distinct from new.digest_key
      or old.release_epoch is distinct from new.release_epoch
      or old.change_event_ids is distinct from new.change_event_ids
      or old.event_bindings is distinct from new.event_bindings
      or old.payload_hash is distinct from new.payload_hash
      or old.eligibility_seal_hash is distinct from new.eligibility_seal_hash
      or old.provider_idempotency_key is distinct from new.provider_idempotency_key then
      raise exception using
        errcode = '55000',
        message = 'Privacy erasure may remove personal delivery material but cannot rewrite its non-personal audit seal.';
    end if;
    return new;
  end if;

  if old.status = 'privacy_scrubbed' then
    raise exception using
      errcode = '55000',
      message = 'A privacy-scrubbed public digest audit row is immutable.';
  end if;

  if old.subscriber_id is distinct from new.subscriber_id
    or old.digest_key is distinct from new.digest_key
    or old.recipient_hash is distinct from new.recipient_hash
    or old.recipient_encrypted is distinct from new.recipient_encrypted
    or old.release_key is distinct from new.release_key
    or old.release_epoch is distinct from new.release_epoch
    or old.release_policy_version is distinct from new.release_policy_version
    or old.release_identity_version is distinct from new.release_identity_version
    or old.release_identity_hash is distinct from new.release_identity_hash
    or old.change_event_ids is distinct from new.change_event_ids
    or old.event_bindings is distinct from new.event_bindings
    or old.rendered_payload is distinct from new.rendered_payload
    or old.payload_schema_version is distinct from new.payload_schema_version
    or old.payload_hash is distinct from new.payload_hash
    or old.eligibility_seal_hash is distinct from new.eligibility_seal_hash
    or old.provider_idempotency_key is distinct from new.provider_idempotency_key
    or old.max_attempts is distinct from new.max_attempts
    or old.created_at is distinct from new.created_at then
    raise exception using
      errcode = '55000',
      message = 'A public digest outbox payload and its evidence bindings are immutable.';
  end if;

  if old.status = 'sent' and new is distinct from old then
    raise exception using
      errcode = '55000',
      message = 'A completed public digest outbox row is immutable.';
  end if;
  return new;
end;
$$;

revoke all on function private.freeze_public_digest_outbox_row()
  from public, anon, authenticated, service_role;

drop trigger if exists freeze_public_digest_outbox_row_trigger
  on public.public_digest_outbox;
create trigger freeze_public_digest_outbox_row_trigger
before update or delete on public.public_digest_outbox
for each row execute function private.freeze_public_digest_outbox_row();

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
  v_enqueued integer := 0;
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
    for key share;
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
      and outbox.digest_key = p_digest_key;
    if found then
      if v_existing.payload_hash is distinct from v_payload_hash then
        raise exception using
          errcode = '23505',
          message = 'This subscriber digest is already frozen with a different payload.';
      end if;
      v_existing_count := v_existing_count + 1;
      continue;
    end if;

    if exists (
      select 1
      from public.public_update_deliveries delivery
      where delivery.subscriber_id = v_subscriber.id
        and delivery.digest_key = p_digest_key
    ) then
      -- A legacy row has no exact rendered payload. Never guess whether a
      -- replacement request would duplicate a delivery.
      v_legacy_blocked := v_legacy_blocked + 1;
      continue;
    end if;

    insert into public.public_digest_outbox (
      subscriber_id,
      digest_key,
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
    'already_frozen', v_existing_count,
    'legacy_blocked', v_legacy_blocked
  );
end;
$$;

revoke all on function public.enqueue_public_digest_outbox(text, uuid, text, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_public_digest_outbox(text, uuid, text, text, text, jsonb)
  to service_role;

create or replace function public.claim_public_digest_outbox(
  p_worker_id text,
  p_limit integer default 25,
  p_lease_seconds integer default 300
)
returns table (
  id uuid,
  lease_token uuid,
  recipient_hash text,
  recipient_encrypted text,
  rendered_payload jsonb,
  payload_hash text,
  provider_idempotency_key text,
  send_attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_release public.stage1_publication_release_state%rowtype;
begin
  if nullif(pg_catalog.btrim(p_worker_id), '') is null
    or p_limit not between 1 and 100
    or p_lease_seconds not between 30 and 600 then
    raise exception using errcode = '22023', message = 'A worker, 1-100 claim limit, and 30-600 second lease are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  update public.public_digest_outbox outbox
  set
    status = case
      -- A lease can expire before authorize_public_digest_send() starts a
      -- provider request. It is safe to restore that work only when it did not
      -- originate from an earlier ambiguous provider result. ambiguous_since
      -- is intentionally retained while an ambiguous row is leased so a crash
      -- between claim and authorization cannot erase that provenance.
      when outbox.status = 'leased'
        and outbox.ambiguous_since is null
        and outbox.send_attempt_count < outbox.max_attempts
        then 'queued'
      when outbox.first_provider_attempt_at is not null
        and outbox.first_provider_attempt_at > pg_catalog.clock_timestamp() - interval '23 hours'
        and outbox.send_attempt_count < outbox.max_attempts
        then 'ambiguous'
      else 'terminal_failed'
    end,
    ambiguous_since = case
      when (
        outbox.status = 'sending'
        or (outbox.status = 'leased' and outbox.ambiguous_since is not null)
      )
        and outbox.first_provider_attempt_at is not null
        and outbox.first_provider_attempt_at > pg_catalog.clock_timestamp() - interval '23 hours'
        and outbox.send_attempt_count < outbox.max_attempts
        then coalesce(outbox.ambiguous_since, outbox.first_provider_attempt_at, outbox.leased_at)
      else outbox.ambiguous_since
    end,
    next_attempt_at = case
      when outbox.status = 'leased'
        and outbox.ambiguous_since is null
        and outbox.send_attempt_count < outbox.max_attempts
        then pg_catalog.clock_timestamp()
      else pg_catalog.clock_timestamp() + interval '5 minutes'
    end,
    last_error = case
      when outbox.status = 'sending'
        or (outbox.status = 'leased' and outbox.ambiguous_since is not null)
        then coalesce(outbox.last_error, 'Provider request lease expired before completion was recorded.')
      else outbox.last_error
    end,
    lease_token = null,
    lease_owner = null,
    leased_at = null,
    lease_expires_at = null,
    updated_at = pg_catalog.clock_timestamp()
  where outbox.status in ('leased', 'sending')
    and outbox.lease_expires_at <= pg_catalog.clock_timestamp();

  update public.public_digest_outbox outbox
  set
    status = 'terminal_failed',
    last_error = coalesce(
      outbox.last_error,
      'Ambiguous provider outcome exceeded the conservative 23-hour retry window.'
    ),
    updated_at = pg_catalog.clock_timestamp()
  where outbox.status = 'ambiguous'
    and outbox.first_provider_attempt_at <= pg_catalog.clock_timestamp() - interval '23 hours';

  select * into v_release
  from public.stage1_publication_release_state release_state
  where release_state.release_key = 'stage1-national-25'
  for key share;
  if not found or not private.public_digest_release_is_current(
    v_release.release_epoch,
    v_release.policy_version,
    v_release.cohort_identity_version,
    v_release.cohort_identity_hash
  ) then
    return;
  end if;

  return query
  with claimable as (
    select outbox.id, gen_random_uuid() as claim_token
    from public.public_digest_outbox outbox
    where outbox.status in ('queued', 'ambiguous')
      and outbox.next_attempt_at <= pg_catalog.clock_timestamp()
      and outbox.send_attempt_count < outbox.max_attempts
      and outbox.release_epoch = v_release.release_epoch
      and outbox.release_policy_version = v_release.policy_version
      and outbox.release_identity_version = v_release.cohort_identity_version
      and outbox.release_identity_hash = v_release.cohort_identity_hash
      and (
        outbox.status <> 'ambiguous'
        or outbox.first_provider_attempt_at > pg_catalog.clock_timestamp() - interval '23 hours'
      )
    order by outbox.next_attempt_at, outbox.created_at, outbox.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.public_digest_outbox outbox
    set
      status = 'leased',
      lease_token = claimable.claim_token,
      last_claim_token = claimable.claim_token,
      lease_owner = pg_catalog.btrim(p_worker_id),
      leased_at = pg_catalog.clock_timestamp(),
      lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = pg_catalog.clock_timestamp()
    from claimable
    where outbox.id = claimable.id
    returning outbox.*
  )
  select
    claimed.id,
    claimed.lease_token,
    claimed.recipient_hash,
    claimed.recipient_encrypted,
    claimed.rendered_payload,
    claimed.payload_hash,
    claimed.provider_idempotency_key,
    claimed.send_attempt_count
  from claimed
  order by claimed.next_attempt_at, claimed.created_at, claimed.id;
end;
$$;

revoke all on function public.claim_public_digest_outbox(text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_public_digest_outbox(text, integer, integer)
  to service_role;

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

  -- Recheck the two retry bounds after claiming. This closes the interval in
  -- which an ambiguous key can age out, or the attempt ceiling can be reached,
  -- between claim and the irreversible provider request.
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

create or replace function public.complete_public_digest_send(
  p_outbox_id uuid,
  p_lease_token uuid,
  p_provider_message_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbox public.public_digest_outbox%rowtype;
  v_completed_at timestamptz := pg_catalog.clock_timestamp();
begin
  if nullif(pg_catalog.btrim(p_provider_message_id), '') is null then
    raise exception using errcode = '22023', message = 'A provider message ID is required.';
  end if;
  select * into v_outbox
  from public.public_digest_outbox outbox
  where outbox.id = p_outbox_id
  for update;
  if not found then return false; end if;
  if v_outbox.status = 'sent'
    and v_outbox.last_claim_token = p_lease_token
    and v_outbox.provider_message_id = pg_catalog.btrim(p_provider_message_id) then
    return true;
  end if;
  if v_outbox.status <> 'sending'
    or v_outbox.lease_token is distinct from p_lease_token
    or v_outbox.last_claim_token is distinct from p_lease_token then
    return false;
  end if;

  update public.public_digest_outbox outbox
  set
    status = 'sent',
    provider_message_id = pg_catalog.btrim(p_provider_message_id),
    sent_at = v_completed_at,
    last_error = null,
    lease_token = null,
    lease_owner = null,
    leased_at = null,
    lease_expires_at = null,
    updated_at = v_completed_at
  where outbox.id = p_outbox_id;

  insert into public.public_update_deliveries (
    subscriber_id,
    digest_key,
    change_event_ids,
    recipient,
    recipient_hash,
    status,
    error,
    release_epoch,
    release_policy_version,
    release_identity_hash,
    provider_idempotency_key,
    sent_at,
    outbox_id,
    delivery_contract_version,
    payload_hash,
    provider_message_id
  ) values (
    v_outbox.subscriber_id,
    v_outbox.digest_key,
    v_outbox.change_event_ids,
    null,
    v_outbox.recipient_hash,
    'sent',
    null,
    v_outbox.release_epoch,
    v_outbox.release_policy_version,
    v_outbox.release_identity_hash,
    v_outbox.provider_idempotency_key,
    v_completed_at,
    v_outbox.id,
    'public-digest-outbox-v1',
    v_outbox.payload_hash,
    pg_catalog.btrim(p_provider_message_id)
  );

  update public.public_update_subscribers subscriber
  set last_digest_sent_at = v_completed_at, updated_at = v_completed_at
  where subscriber.id = v_outbox.subscriber_id;
  return true;
end;
$$;

revoke all on function public.complete_public_digest_send(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_public_digest_send(uuid, uuid, text)
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
      coalesce(nullif(pg_catalog.btrim(p_error), ''), 'Public digest delivery failed.'),
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

-- Unsubscribe is serialized with provider authorization. If authorization has
-- already committed a live sending lease, the caller is told to retry instead
-- of receiving a false success while a message is in flight. If unsubscribe
-- wins the release lock first, authorize_public_digest_send() observes the
-- inactive subscriber and refuses the provider request.
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
  ) then
    return 'retry_active_send';
  end if;

  update public.public_update_subscribers subscriber
  set
    status = 'unsubscribed',
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
  if p_email_hash is null and nullif(pg_catalog.btrim(p_legacy_email), '') is null then
    return 0;
  end if;
  if p_email_hash is not null and p_email_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'A valid personal-data lookup hash is required.';
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
  ) then
    raise exception using
      errcode = '40001',
      message = 'Privacy erasure must retry after the active public digest send lease.';
  end if;

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
grant execute on function public.erase_public_update_subscriber(text, text)
  to service_role;

-- Every subscriber mutation follows the same advisory-lock order as provider
-- authorization. The row fence protects future service code from bypassing the
-- unsubscribe RPC and mutating/deleting an exact recipient during a live send.
create or replace function private.public_digest_subscriber_fence_before_statement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  return null;
end;
$$;

create or replace function private.fence_sending_digest_subscriber_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.public_digest_outbox outbox
    where outbox.subscriber_id = old.id
      and outbox.status = 'sending'
      and outbox.lease_expires_at > pg_catalog.clock_timestamp()
  ) then
    raise exception using
      errcode = '40001',
      message = 'Subscriber mutation must retry after the active public digest send lease.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.public_digest_subscriber_fence_before_statement()
  from public, anon, authenticated, service_role;
revoke all on function private.fence_sending_digest_subscriber_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists public_digest_subscriber_fence_before_update_delete
  on public.public_update_subscribers;
create trigger public_digest_subscriber_fence_before_update_delete
before update or delete on public.public_update_subscribers
for each statement execute function private.public_digest_subscriber_fence_before_statement();

drop trigger if exists fence_sending_digest_subscriber_mutation_trigger
  on public.public_update_subscribers;
create trigger fence_sending_digest_subscriber_mutation_trigger
before update or delete on public.public_update_subscribers
for each row execute function private.fence_sending_digest_subscriber_mutation();

-- Release invalidation is transactionally refused while a provider call is in
-- flight. Callers retry after the short send lease; a crashed call stops
-- blocking at lease expiry and is retained as ambiguous evidence.
create or replace function private.fence_stage1_release_from_digest_send()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    tg_op = 'DELETE'
    or old.release_state is distinct from new.release_state
    or old.release_epoch is distinct from new.release_epoch
    or old.policy_version is distinct from new.policy_version
    or old.cohort_identity_version is distinct from new.cohort_identity_version
    or old.cohort_identity_hash is distinct from new.cohort_identity_hash
  ) and exists (
    select 1
    from public.public_digest_outbox outbox
    where outbox.status = 'sending'
      and outbox.release_epoch = old.release_epoch
      and outbox.lease_expires_at > pg_catalog.clock_timestamp()
  ) then
    raise exception using
      errcode = '40001',
      message = 'Stage 1 release transition must retry after the active public digest send lease.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.fence_stage1_release_from_digest_send()
  from public, anon, authenticated, service_role;

drop trigger if exists fence_stage1_release_from_digest_send_trigger
  on public.stage1_publication_release_state;
create trigger fence_stage1_release_from_digest_send_trigger
before update or delete on public.stage1_publication_release_state
for each row execute function private.fence_stage1_release_from_digest_send();

-- Suppression is the only mutable event predicate used by public delivery.
-- It takes the release lock before row selection so authorize/send and feedback
-- suppression have one lock order. Suppression wins if it started first; an
-- already-started provider request gets its short fence, then suppression can
-- retry without ever silently changing a frozen outbox payload.
create or replace function private.public_digest_event_fence_before_statement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  return null;
end;
$$;

create or replace function private.fence_sending_digest_event_suppression()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    old.suppressed_at is distinct from new.suppressed_at
    or old.suppression_reason is distinct from new.suppression_reason
    or old.suppression_source is distinct from new.suppression_source
    or old.change_details is distinct from new.change_details
  ) and exists (
    select 1
    from public.public_digest_outbox outbox
    where outbox.status = 'sending'
      and old.id = any(outbox.change_event_ids)
      and outbox.lease_expires_at > pg_catalog.clock_timestamp()
  ) then
    raise exception using
      errcode = '40001',
      message = 'Event suppression must retry after the active public digest send lease.';
  end if;
  return new;
end;
$$;

revoke all on function private.public_digest_event_fence_before_statement()
  from public, anon, authenticated, service_role;
revoke all on function private.fence_sending_digest_event_suppression()
  from public, anon, authenticated, service_role;

drop trigger if exists public_digest_event_fence_before_update
  on public.shared_award_change_events;
create trigger public_digest_event_fence_before_update
before update of suppressed_at, suppression_reason, suppression_source, change_details
on public.shared_award_change_events
for each statement execute function private.public_digest_event_fence_before_statement();

drop trigger if exists fence_sending_digest_event_suppression_trigger
  on public.shared_award_change_events;
create trigger fence_sending_digest_event_suppression_trigger
before update of suppressed_at, suppression_reason, suppression_source, change_details
on public.shared_award_change_events
for each row execute function private.fence_sending_digest_event_suppression();

comment on table public.public_digest_outbox is
  'Immutable rendered public digests with DB-owned release/event authorization, leased provider sends, and explicit ambiguous outcomes.';
comment on column public.public_digest_outbox.first_provider_attempt_at is
  'Start of the provider idempotency window. Ambiguous retries stop conservatively at 23 hours.';
