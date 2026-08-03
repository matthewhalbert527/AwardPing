-- Legacy contact ciphertext is a retained recovery artifact, never a sendable
-- recipient. Inventory every non-v2 subscriber/outbox value, disable every
-- safely stoppable delivery path, retain only a hash-bound quarantine record,
-- and make exact-key recovery and privacy erasure explicit CAS operations.

create table public.personal_data_erasure_tombstones (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  v2_email_hash text unique
    check (v2_email_hash is null or v2_email_hash ~ '^[0-9a-f]{64}$'),
  legacy_artifact_key text unique
    check (legacy_artifact_key is null or legacy_artifact_key ~ '^[0-9a-f]{64}$'),
  privacy_request_id uuid not null
    references public.privacy_requests(id) on delete restrict,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint personal_data_erasure_tombstone_identity_check check (
    pg_catalog.num_nonnulls(v2_email_hash, legacy_artifact_key) = 1
  )
);

create table public.personal_data_legacy_contact_quarantine (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  source_table text not null check (
    source_table in ('public_update_subscribers', 'public_digest_outbox')
  ),
  source_record_id uuid not null,
  source_column text not null check (
    (source_table = 'public_update_subscribers' and source_column = 'email_encrypted')
    or (source_table = 'public_digest_outbox' and source_column = 'recipient_encrypted')
  ),
  ciphertext_format text not null check (
    ciphertext_format in ('ap:v1', 'unsupported_non_v2')
  ),
  ciphertext_sha256 text check (
    ciphertext_sha256 is null or ciphertext_sha256 ~ '^[0-9a-f]{64}$'
  ),
  legacy_lookup_hash text check (
    legacy_lookup_hash is null or legacy_lookup_hash ~ '^[0-9a-f]{64}$'
  ),
  v2_email_hash text check (
    v2_email_hash is null or v2_email_hash ~ '^[0-9a-f]{64}$'
  ),
  original_status text not null check (
    nullif(pg_catalog.btrim(original_status), '') is not null
  ),
  lifecycle_status text not null default 'disabled_retained' check (
    lifecycle_status in (
      'disabled_retained',
      'recovered_v2',
      'erased_by_tombstone'
    )
  ),
  resolution text not null default 'awaiting_exact_legacy_key' check (
    nullif(pg_catalog.btrim(resolution), '') is not null
  ),
  erasure_tombstone_id uuid
    references public.personal_data_erasure_tombstones(id) on delete restrict,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null default pg_catalog.clock_timestamp(),
  resolved_at timestamptz,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint personal_data_legacy_contact_quarantine_source_unique
    unique (source_table, source_record_id, source_column),
  constraint personal_data_legacy_contact_quarantine_lifecycle_check check (
    (
      lifecycle_status = 'disabled_retained'
      and ciphertext_sha256 is not null
      and erasure_tombstone_id is null
      and resolved_at is null
    )
    or (
      lifecycle_status = 'recovered_v2'
      and ciphertext_sha256 is null
      and v2_email_hash is not null
      and erasure_tombstone_id is null
      and resolved_at is not null
    )
    or (
      lifecycle_status = 'erased_by_tombstone'
      and ciphertext_sha256 is null
      and legacy_lookup_hash is null
      and v2_email_hash is null
      and erasure_tombstone_id is not null
      and resolved_at is not null
    )
  )
);

create index personal_data_legacy_contact_quarantine_lifecycle_idx
  on public.personal_data_legacy_contact_quarantine (
    lifecycle_status, source_table, source_record_id
  );
create index personal_data_legacy_contact_quarantine_v2_hash_idx
  on public.personal_data_legacy_contact_quarantine (v2_email_hash)
  where v2_email_hash is not null;

alter table public.personal_data_erasure_tombstones enable row level security;
alter table public.personal_data_legacy_contact_quarantine enable row level security;
revoke all on table public.personal_data_erasure_tombstones
  from public, anon, authenticated, service_role;
revoke all on table public.personal_data_legacy_contact_quarantine
  from public, anon, authenticated, service_role;
grant select on table public.personal_data_erasure_tombstones to service_role;
grant select on table public.personal_data_legacy_contact_quarantine to service_role;

create or replace function private.awardping_legacy_contact_evidence_hash(
  p_source_table text,
  p_source_record_id uuid,
  p_source_column text,
  p_ciphertext_format text,
  p_ciphertext_sha256 text,
  p_legacy_lookup_hash text,
  p_original_status text
)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select public.awardping_sha256_text(
    pg_catalog.jsonb_build_object(
      'schema_version', 'personal-data-legacy-contact-evidence-v1',
      'source_table', p_source_table,
      'source_record_id', p_source_record_id,
      'source_column', p_source_column,
      'ciphertext_format', p_ciphertext_format,
      'ciphertext_sha256', p_ciphertext_sha256,
      'legacy_lookup_hash', p_legacy_lookup_hash,
      'original_status', p_original_status
    )::text
  );
$$;

revoke all on function private.awardping_legacy_contact_evidence_hash(
  text, uuid, text, text, text, text, text
) from public, anon, authenticated, service_role;

create or replace function private.freeze_personal_data_erasure_tombstone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'A personal-data erasure tombstone is immutable.';
end;
$$;

create trigger freeze_personal_data_erasure_tombstone_trigger
before update or delete on public.personal_data_erasure_tombstones
for each row execute function private.freeze_personal_data_erasure_tombstone();

create or replace function private.freeze_legacy_contact_quarantine_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.source_table is distinct from new.source_table
    or old.source_record_id is distinct from new.source_record_id
    or old.source_column is distinct from new.source_column
    or old.ciphertext_format is distinct from new.ciphertext_format
    or old.original_status is distinct from new.original_status
    or old.evidence_hash is distinct from new.evidence_hash
    or old.observed_at is distinct from new.observed_at then
    raise exception using
      errcode = '55000',
      message = 'Legacy contact quarantine source evidence is immutable.';
  end if;
  if old.lifecycle_status = 'erased_by_tombstone' and new is distinct from old then
    raise exception using
      errcode = '55000',
      message = 'An erased legacy contact quarantine tombstone is immutable.';
  end if;
  return new;
end;
$$;

create trigger freeze_legacy_contact_quarantine_evidence_trigger
before update or delete on public.personal_data_legacy_contact_quarantine
for each row execute function private.freeze_legacy_contact_quarantine_evidence();

revoke all on function private.freeze_personal_data_erasure_tombstone()
  from public, anon, authenticated, service_role;
revoke all on function private.freeze_legacy_contact_quarantine_evidence()
  from public, anon, authenticated, service_role;

-- The inventory stores no duplicate ciphertext and is stable by source key.
with legacy_contact as (
  select
    'public_update_subscribers'::text as source_table,
    subscriber.id as source_record_id,
    'email_encrypted'::text as source_column,
    case when subscriber.email_encrypted like 'ap:v1:%'
      then 'ap:v1' else 'unsupported_non_v2' end as ciphertext_format,
    public.awardping_sha256_text(subscriber.email_encrypted) as ciphertext_sha256,
    case when subscriber.email_hash ~ '^[0-9a-f]{64}$'
      then subscriber.email_hash else null end as legacy_lookup_hash,
    subscriber.status as original_status
  from public.public_update_subscribers subscriber
  where subscriber.email_encrypted is not null
    and subscriber.email_encrypted not like 'ap:v2:%'
  union all
  select
    'public_digest_outbox',
    outbox.id,
    'recipient_encrypted',
    case when outbox.recipient_encrypted like 'ap:v1:%'
      then 'ap:v1' else 'unsupported_non_v2' end,
    public.awardping_sha256_text(outbox.recipient_encrypted),
    case when outbox.recipient_hash ~ '^[0-9a-f]{64}$'
      then outbox.recipient_hash else null end,
    outbox.status
  from public.public_digest_outbox outbox
  where outbox.recipient_encrypted is not null
    and outbox.recipient_encrypted not like 'ap:v2:%'
)
insert into public.personal_data_legacy_contact_quarantine (
  source_table,
  source_record_id,
  source_column,
  ciphertext_format,
  ciphertext_sha256,
  legacy_lookup_hash,
  original_status,
  lifecycle_status,
  resolution,
  evidence_hash
)
select
  legacy_contact.source_table,
  legacy_contact.source_record_id,
  legacy_contact.source_column,
  legacy_contact.ciphertext_format,
  legacy_contact.ciphertext_sha256,
  legacy_contact.legacy_lookup_hash,
  legacy_contact.original_status,
  'disabled_retained',
  case when legacy_contact.ciphertext_format = 'ap:v1'
    then 'awaiting_exact_legacy_key'
    else 'unsupported_non_v2_disabled_requires_erasure_or_manual_repair' end,
  private.awardping_legacy_contact_evidence_hash(
    legacy_contact.source_table,
    legacy_contact.source_record_id,
    legacy_contact.source_column,
    legacy_contact.ciphertext_format,
    legacy_contact.ciphertext_sha256,
    legacy_contact.legacy_lookup_hash,
    legacy_contact.original_status
  )
from legacy_contact
order by legacy_contact.source_table, legacy_contact.source_record_id
on conflict (source_table, source_record_id, source_column) do nothing;

-- Disable consent rows unless an already-authorized provider call is still in
-- flight. Such a lease remains an explicit HOLD until it expires.
update public.public_update_subscribers subscriber
set
  status = 'unsubscribed',
  confirmation_token_hash = null,
  unsubscribed_at = coalesce(subscriber.unsubscribed_at, pg_catalog.clock_timestamp()),
  updated_at = pg_catalog.clock_timestamp()
where subscriber.email_encrypted is not null
  and subscriber.email_encrypted not like 'ap:v2:%'
  and subscriber.status in ('pending', 'active')
  and not exists (
    select 1
    from public.public_digest_outbox outbox
    where outbox.subscriber_id = subscriber.id
      and outbox.status = 'sending'
      and outbox.lease_expires_at > pg_catalog.clock_timestamp()
  );

-- A legacy recipient with no conclusive provider result is retained as audit
-- evidence but is never retried. A live sending lease is not rewritten because
-- its provider outcome may already be in flight; authorize/gate fences below
-- keep it from beginning a new request.
update public.public_digest_outbox outbox
set
  status = 'terminal_failed',
  lease_token = null,
  lease_owner = null,
  leased_at = null,
  lease_expires_at = null,
  next_attempt_at = pg_catalog.clock_timestamp(),
  last_error = pg_catalog.concat_ws(
    ' ',
    nullif(pg_catalog.btrim(outbox.last_error), ''),
    'Legacy recipient ciphertext was quarantined and is not sendable.'
  ),
  updated_at = pg_catalog.clock_timestamp()
where outbox.recipient_encrypted is not null
  and outbox.recipient_encrypted not like 'ap:v2:%'
  and (
    outbox.status in ('queued', 'leased', 'ambiguous', 'release_blocked')
    or (
      outbox.status = 'sending'
      and outbox.lease_expires_at <= pg_catalog.clock_timestamp()
    )
  );

alter table public.public_update_subscribers
  add constraint public_update_subscribers_non_v2_not_consent_active_check check (
    status not in ('pending', 'active')
    or coalesce(email_encrypted, '') like 'ap:v2:%'
  ) not valid;

alter table public.public_digest_outbox
  add constraint public_digest_outbox_non_v2_not_sendable_check check (
    status not in ('queued', 'leased', 'sending', 'ambiguous', 'release_blocked')
    or coalesce(recipient_encrypted, '') like 'ap:v2:%'
  ) not valid;

-- Direct REST subscription creation/refresh/confirmation shares the same
-- transaction lock as erasure, recovery, enqueue, and provider authorization.
-- If subscribe wins first, erasure sees and removes it; if erasure wins first,
-- a genuinely fresh opt-in can proceed only after the tombstone transaction.
drop trigger if exists public_digest_subscriber_fence_before_update_delete
  on public.public_update_subscribers;
create trigger public_digest_subscriber_fence_before_update_delete
before insert or update or delete on public.public_update_subscribers
for each statement execute function private.public_digest_subscriber_fence_before_statement();

create or replace function private.personal_data_legacy_contact_gate_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_subscriber_non_v2 bigint;
  v_outbox_non_v2 bigint;
  v_active_subscriber_non_v2 bigint;
  v_active_subscriber_missing_ciphertext bigint;
  v_sendable_outbox_non_v2 bigint;
  v_unquarantined_non_v2 bigint;
  v_basis jsonb;
begin
  select count(*)
  into v_subscriber_non_v2
  from public.public_update_subscribers subscriber
  where subscriber.email_encrypted is not null
    and subscriber.email_encrypted not like 'ap:v2:%';

  select count(*) into v_active_subscriber_non_v2
  from public.public_update_subscribers subscriber
  where subscriber.status in ('pending', 'active')
    and coalesce(subscriber.email_encrypted, '') not like 'ap:v2:%';

  select count(*) into v_active_subscriber_missing_ciphertext
  from public.public_update_subscribers subscriber
  where subscriber.status in ('pending', 'active')
    and subscriber.email_encrypted is null;

  select
    count(*),
    count(*) filter (
      where outbox.status in (
        'queued', 'leased', 'sending', 'ambiguous', 'release_blocked'
      )
    )
  into v_outbox_non_v2, v_sendable_outbox_non_v2
  from public.public_digest_outbox outbox
  where outbox.recipient_encrypted is not null
    and outbox.recipient_encrypted not like 'ap:v2:%';

  select count(*) into v_unquarantined_non_v2
  from (
    select
      'public_update_subscribers'::text as source_table,
      subscriber.id as source_record_id,
      'email_encrypted'::text as source_column,
      case when subscriber.email_encrypted like 'ap:v1:%'
        then 'ap:v1' else 'unsupported_non_v2' end as ciphertext_format,
      public.awardping_sha256_text(subscriber.email_encrypted) as ciphertext_sha256
    from public.public_update_subscribers subscriber
    where subscriber.email_encrypted is not null
      and subscriber.email_encrypted not like 'ap:v2:%'
    union all
    select
      'public_digest_outbox',
      outbox.id,
      'recipient_encrypted',
      case when outbox.recipient_encrypted like 'ap:v1:%'
        then 'ap:v1' else 'unsupported_non_v2' end,
      public.awardping_sha256_text(outbox.recipient_encrypted)
    from public.public_digest_outbox outbox
    where outbox.recipient_encrypted is not null
      and outbox.recipient_encrypted not like 'ap:v2:%'
  ) legacy
  where not exists (
    select 1
    from public.personal_data_legacy_contact_quarantine quarantine
    where quarantine.source_table = legacy.source_table
      and quarantine.source_record_id = legacy.source_record_id
      and quarantine.source_column = legacy.source_column
      and quarantine.ciphertext_format = legacy.ciphertext_format
      and quarantine.ciphertext_sha256 = legacy.ciphertext_sha256
      and quarantine.lifecycle_status = 'disabled_retained'
  );

  v_basis := pg_catalog.jsonb_build_object(
    'schema_version', 'personal-data-legacy-contact-gate-v1',
    'subscriber_non_v2_total', v_subscriber_non_v2,
    'outbox_non_v2_total', v_outbox_non_v2,
    'active_or_pending_subscriber_non_v2', v_active_subscriber_non_v2,
    'active_or_pending_subscriber_missing_ciphertext',
      v_active_subscriber_missing_ciphertext,
    'claimable_or_reactivatable_outbox_non_v2', v_sendable_outbox_non_v2,
    'unquarantined_non_v2', v_unquarantined_non_v2,
    'retained_disabled_or_historical_non_v2',
      greatest(
        0,
        v_subscriber_non_v2 + v_outbox_non_v2
          - (v_active_subscriber_non_v2 - v_active_subscriber_missing_ciphertext)
          - v_sendable_outbox_non_v2
      )
  );
  return v_basis || pg_catalog.jsonb_build_object(
    'state', case
      when v_active_subscriber_non_v2 = 0
        and v_sendable_outbox_non_v2 = 0
        and v_unquarantined_non_v2 = 0
      then 'SAFE'
      else 'HOLD'
    end,
    'evidence_hash', public.stage1_publication_evidence_hash(v_basis)
  );
end;
$$;

create or replace function private.personal_data_legacy_contact_gate_safe()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.personal_data_legacy_contact_gate_snapshot() ->> 'state' = 'SAFE';
$$;

create or replace function public.get_personal_data_legacy_contact_gate_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.personal_data_legacy_contact_gate_snapshot();
$$;

revoke all on function private.personal_data_legacy_contact_gate_snapshot()
  from public, anon, authenticated, service_role;
revoke all on function private.personal_data_legacy_contact_gate_safe()
  from public, anon, authenticated, service_role;
revoke all on function public.get_personal_data_legacy_contact_gate_snapshot()
  from public, anon, authenticated, service_role;
grant execute on function public.get_personal_data_legacy_contact_gate_snapshot()
  to service_role;

-- Digest release is not current while any legacy contact is active, claimable,
-- reactivatable, or missing its exact quarantine evidence.
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
  select private.personal_data_legacy_contact_gate_safe()
    and coalesce(
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

create or replace function public.quarantine_legacy_contact_ciphertext(
  p_source_table text,
  p_source_record_id uuid,
  p_expected_updated_at timestamptz,
  p_expected_ciphertext_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscriber public.public_update_subscribers%rowtype;
  v_outbox public.public_digest_outbox%rowtype;
  v_lookup_hash text;
  v_source_column text;
  v_ciphertext_format text;
  v_original_status text;
  v_disabled boolean := false;
begin
  if p_source_table not in ('public_update_subscribers', 'public_digest_outbox')
    or p_source_record_id is null
    or p_expected_updated_at is null
    or p_expected_ciphertext_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'A supported source and exact legacy contact CAS are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  if p_source_table = 'public_update_subscribers' then
    select * into v_subscriber
    from public.public_update_subscribers subscriber
    where subscriber.id = p_source_record_id
      and subscriber.updated_at = p_expected_updated_at
      and subscriber.email_encrypted is not null
      and subscriber.email_encrypted not like 'ap:v2:%'
      and public.awardping_sha256_text(subscriber.email_encrypted) =
        p_expected_ciphertext_sha256
    for update;
    if not found then
      raise exception using
        errcode = '40001',
        message = 'Legacy subscriber changed after the quarantine plan was created.';
    end if;
    v_source_column := 'email_encrypted';
    v_ciphertext_format := case when v_subscriber.email_encrypted like 'ap:v1:%'
      then 'ap:v1' else 'unsupported_non_v2' end;
    v_original_status := v_subscriber.status;
    v_lookup_hash := case when v_subscriber.email_hash ~ '^[0-9a-f]{64}$'
      then v_subscriber.email_hash else null end;
  else
    select * into v_outbox
    from public.public_digest_outbox outbox
    where outbox.id = p_source_record_id
      and outbox.updated_at = p_expected_updated_at
      and outbox.recipient_encrypted is not null
      and outbox.recipient_encrypted not like 'ap:v2:%'
      and public.awardping_sha256_text(outbox.recipient_encrypted) =
        p_expected_ciphertext_sha256
    for update;
    if not found then
      raise exception using
        errcode = '40001',
        message = 'Legacy digest outbox row changed after the quarantine plan was created.';
    end if;
    v_source_column := 'recipient_encrypted';
    v_ciphertext_format := case when v_outbox.recipient_encrypted like 'ap:v1:%'
      then 'ap:v1' else 'unsupported_non_v2' end;
    v_original_status := v_outbox.status;
    v_lookup_hash := case when v_outbox.recipient_hash ~ '^[0-9a-f]{64}$'
      then v_outbox.recipient_hash else null end;
  end if;

  insert into public.personal_data_legacy_contact_quarantine (
    source_table,
    source_record_id,
    source_column,
    ciphertext_format,
    ciphertext_sha256,
    legacy_lookup_hash,
    original_status,
    lifecycle_status,
    resolution,
    evidence_hash
  ) values (
    p_source_table,
    p_source_record_id,
    v_source_column,
    v_ciphertext_format,
    p_expected_ciphertext_sha256,
    v_lookup_hash,
    v_original_status,
    'disabled_retained',
    case when v_ciphertext_format = 'ap:v1'
      then 'awaiting_exact_legacy_key'
      else 'unsupported_non_v2_disabled_requires_erasure_or_manual_repair' end,
    private.awardping_legacy_contact_evidence_hash(
      p_source_table,
      p_source_record_id,
      v_source_column,
      v_ciphertext_format,
      p_expected_ciphertext_sha256,
      v_lookup_hash,
      v_original_status
    )
  )
  on conflict (source_table, source_record_id, source_column) do nothing;

  if not exists (
    select 1
    from public.personal_data_legacy_contact_quarantine quarantine
    where quarantine.source_table = p_source_table
      and quarantine.source_record_id = p_source_record_id
      and quarantine.source_column = v_source_column
      and quarantine.ciphertext_format = v_ciphertext_format
      and quarantine.ciphertext_sha256 = p_expected_ciphertext_sha256
      and quarantine.lifecycle_status = 'disabled_retained'
  ) then
    raise exception using
      errcode = '40001',
      message = 'Legacy contact quarantine evidence changed after planning.';
  end if;

  if p_source_table = 'public_update_subscribers' then
    update public.public_update_subscribers subscriber
    set
      status = 'unsubscribed',
      confirmation_token_hash = null,
      unsubscribed_at = coalesce(
        subscriber.unsubscribed_at, pg_catalog.clock_timestamp()
      ),
      updated_at = pg_catalog.clock_timestamp()
    where subscriber.id = p_source_record_id
      and subscriber.email_encrypted is not null
      and subscriber.email_encrypted not like 'ap:v2:%'
      and subscriber.status in ('pending', 'active')
      and not exists (
        select 1
        from public.public_digest_outbox outbox
        where outbox.subscriber_id = subscriber.id
          and outbox.status = 'sending'
          and outbox.lease_expires_at > pg_catalog.clock_timestamp()
      );
    v_disabled := v_subscriber.status not in ('pending', 'active') or found;
  else
    update public.public_digest_outbox outbox
    set
      status = 'terminal_failed',
      lease_token = null,
      lease_owner = null,
      leased_at = null,
      lease_expires_at = null,
      next_attempt_at = pg_catalog.clock_timestamp(),
      last_error = pg_catalog.concat_ws(
        ' ',
        nullif(pg_catalog.btrim(outbox.last_error), ''),
        'Legacy recipient ciphertext was quarantined and is not sendable.'
      ),
      updated_at = pg_catalog.clock_timestamp()
    where outbox.id = p_source_record_id
      and outbox.recipient_encrypted is not null
      and outbox.recipient_encrypted not like 'ap:v2:%'
      and (
        outbox.status in ('queued', 'leased', 'ambiguous', 'release_blocked')
        or (
          outbox.status = 'sending'
          and outbox.lease_expires_at <= pg_catalog.clock_timestamp()
        )
      );
    v_disabled := v_outbox.status not in (
      'queued', 'leased', 'sending', 'ambiguous', 'release_blocked'
    ) or found;
  end if;

  return pg_catalog.jsonb_build_object(
    'source_table', p_source_table,
    'source_record_id', p_source_record_id,
    'ciphertext_sha256', p_expected_ciphertext_sha256,
    'disabled', v_disabled,
    'state', case when v_disabled then 'disabled_retained' else 'gate_hold' end
  );
end;
$$;

revoke all on function public.quarantine_legacy_contact_ciphertext(
  text, uuid, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.quarantine_legacy_contact_ciphertext(
  text, uuid, timestamptz, text
) to service_role;

create or replace function public.recover_legacy_contact_ciphertext(
  p_source_table text,
  p_source_record_id uuid,
  p_expected_updated_at timestamptz,
  p_expected_ciphertext_sha256 text,
  p_expected_lookup_hash text,
  p_v2_email_hash text,
  p_v2_email_encrypted text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscriber public.public_update_subscribers%rowtype;
  v_outbox public.public_digest_outbox%rowtype;
  v_quarantine public.personal_data_legacy_contact_quarantine%rowtype;
  v_tombstone public.personal_data_erasure_tombstones%rowtype;
  v_source_column text;
  v_original_status text;
  v_canonical_subscriber_id uuid;
  v_linked_outbox_ids uuid[] := '{}'::uuid[];
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_source_table not in ('public_update_subscribers', 'public_digest_outbox')
    or p_source_record_id is null
    or p_expected_updated_at is null
    or p_expected_ciphertext_sha256 !~ '^[0-9a-f]{64}$'
    or (p_expected_lookup_hash is not null
      and p_expected_lookup_hash !~ '^[0-9a-f]{64}$')
    or p_v2_email_hash !~ '^[0-9a-f]{64}$'
    or p_v2_email_encrypted not like 'ap:v2:%' then
    raise exception using
      errcode = '22023',
      message = 'Exact legacy CAS evidence and a sealed v2 contact are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  if p_source_table = 'public_update_subscribers' then
    select * into v_subscriber
    from public.public_update_subscribers subscriber
    where subscriber.id = p_source_record_id
      and subscriber.updated_at = p_expected_updated_at
      and subscriber.email_encrypted like 'ap:v1:%'
      and public.awardping_sha256_text(subscriber.email_encrypted) =
        p_expected_ciphertext_sha256
      and subscriber.email_hash is not distinct from p_expected_lookup_hash
    for update;
    if not found then
      raise exception using
        errcode = '40001',
        message = 'Legacy subscriber recovery CAS failed; reload every page and replan.';
    end if;
    v_source_column := 'email_encrypted';
    v_original_status := v_subscriber.status;
  else
    select * into v_outbox
    from public.public_digest_outbox outbox
    where outbox.id = p_source_record_id
      and outbox.updated_at = p_expected_updated_at
      and outbox.recipient_encrypted like 'ap:v1:%'
      and public.awardping_sha256_text(outbox.recipient_encrypted) =
        p_expected_ciphertext_sha256
      and outbox.recipient_hash is not distinct from p_expected_lookup_hash
    for update;
    if not found then
      raise exception using
        errcode = '40001',
        message = 'Legacy outbox recovery CAS failed; reload every page and replan.';
    end if;
    v_source_column := 'recipient_encrypted';
    v_original_status := v_outbox.status;
  end if;

  insert into public.personal_data_legacy_contact_quarantine (
    source_table,
    source_record_id,
    source_column,
    ciphertext_format,
    ciphertext_sha256,
    legacy_lookup_hash,
    original_status,
    lifecycle_status,
    resolution,
    evidence_hash
  ) values (
    p_source_table,
    p_source_record_id,
    v_source_column,
    'ap:v1',
    p_expected_ciphertext_sha256,
    p_expected_lookup_hash,
    v_original_status,
    'disabled_retained',
    'exact_key_authenticated_recovery_pending',
    private.awardping_legacy_contact_evidence_hash(
      p_source_table,
      p_source_record_id,
      v_source_column,
      'ap:v1',
      p_expected_ciphertext_sha256,
      p_expected_lookup_hash,
      v_original_status
    )
  )
  on conflict (source_table, source_record_id, source_column) do nothing;

  select * into v_quarantine
  from public.personal_data_legacy_contact_quarantine quarantine
  where quarantine.source_table = p_source_table
    and quarantine.source_record_id = p_source_record_id
    and quarantine.source_column = v_source_column
  for update;
  if not found
    or v_quarantine.lifecycle_status <> 'disabled_retained'
    or v_quarantine.ciphertext_format <> 'ap:v1'
    or v_quarantine.ciphertext_sha256 is distinct from
      p_expected_ciphertext_sha256
    or v_quarantine.legacy_lookup_hash is distinct from
      p_expected_lookup_hash then
    raise exception using
      errcode = '40001',
      message = 'Legacy contact quarantine evidence changed after planning.';
  end if;

  select * into v_tombstone
  from public.personal_data_erasure_tombstones tombstone
  where tombstone.v2_email_hash = p_v2_email_hash
  for key share;

  if p_source_table = 'public_digest_outbox' then
    if v_outbox.status = 'sending'
      and v_outbox.lease_expires_at > v_now then
      raise exception using
        errcode = '40001',
        message = 'Legacy outbox recovery must retry after the active send lease.';
    end if;
    update public.public_digest_outbox outbox
    set
      subscriber_id = null,
      recipient_hash = null,
      recipient_encrypted = null,
      rendered_payload = null,
      status = 'privacy_scrubbed',
      last_error = case when v_tombstone.id is null
        then 'Legacy recipient recovered to v2 identity; immutable v1 outbox personal material was scrubbed.'
        else 'A prior erasure tombstone prevented legacy recipient recovery.'
      end,
      lease_token = null,
      lease_owner = null,
      leased_at = null,
      lease_expires_at = null,
      next_attempt_at = v_now,
      updated_at = v_now
    where outbox.id = p_source_record_id;

    update public.personal_data_legacy_contact_quarantine quarantine
    set
      ciphertext_sha256 = null,
      legacy_lookup_hash = case when v_tombstone.id is null
        then quarantine.legacy_lookup_hash else null end,
      v2_email_hash = case when v_tombstone.id is null
        then p_v2_email_hash else null end,
      lifecycle_status = case when v_tombstone.id is null
        then 'recovered_v2' else 'erased_by_tombstone' end,
      resolution = case when v_tombstone.id is null
        then 'exact_key_recovered_identity_outbox_scrubbed'
        else 'prior_erasure_tombstone_applied_before_recovery' end,
      erasure_tombstone_id = v_tombstone.id,
      resolved_at = v_now,
      updated_at = v_now
    where quarantine.id = v_quarantine.id;
    return pg_catalog.jsonb_build_object(
      'state', case when v_tombstone.id is null
        then 'recovered_v2_outbox_scrubbed' else 'erased_by_tombstone' end,
      'source_table', p_source_table,
      'source_record_id', p_source_record_id,
      'v2_email_hash', case when v_tombstone.id is null
        then p_v2_email_hash else null end
    );
  end if;

  select coalesce(pg_catalog.array_agg(outbox.id order by outbox.id), '{}'::uuid[])
  into v_linked_outbox_ids
  from public.public_digest_outbox outbox
  where outbox.subscriber_id = p_source_record_id;

  if exists (
    select 1
    from public.public_digest_outbox outbox
    where outbox.id = any(v_linked_outbox_ids)
      and outbox.status = 'sending'
      and outbox.lease_expires_at > v_now
  ) then
    raise exception using
      errcode = '40001',
      message = 'Legacy subscriber recovery must retry after the active send lease.';
  end if;

  if v_tombstone.id is not null then
    update public.public_digest_outbox outbox
    set
      subscriber_id = null,
      recipient_hash = null,
      recipient_encrypted = null,
      rendered_payload = null,
      status = 'privacy_scrubbed',
      last_error = 'A prior erasure tombstone prevented legacy subscriber recovery.',
      lease_token = null,
      lease_owner = null,
      leased_at = null,
      lease_expires_at = null,
      next_attempt_at = v_now,
      updated_at = v_now
    where outbox.id = any(v_linked_outbox_ids);
    update public.public_update_deliveries delivery
    set subscriber_id = null, recipient = null, recipient_hash = null
    where delivery.subscriber_id = p_source_record_id;
    delete from public.public_update_subscribers subscriber
    where subscriber.id = p_source_record_id;
    update public.personal_data_legacy_contact_quarantine quarantine
    set
      ciphertext_sha256 = null,
      legacy_lookup_hash = null,
      v2_email_hash = null,
      lifecycle_status = 'erased_by_tombstone',
      resolution = 'prior_erasure_tombstone_applied_before_recovery',
      erasure_tombstone_id = v_tombstone.id,
      resolved_at = v_now,
      updated_at = v_now
    where quarantine.lifecycle_status <> 'erased_by_tombstone'
      and (
        quarantine.id = v_quarantine.id
        or (
          quarantine.source_table = 'public_digest_outbox'
          and quarantine.source_record_id = any(v_linked_outbox_ids)
        )
      );
    if exists (
      select 1
      from public.personal_data_legacy_contact_quarantine quarantine
      where quarantine.source_table = 'public_digest_outbox'
        and quarantine.source_record_id = any(v_linked_outbox_ids)
        and quarantine.lifecycle_status <> 'erased_by_tombstone'
    ) then
      raise exception using
        errcode = '55000',
        message = 'Legacy subscriber tombstone did not resolve every linked outbox quarantine row.';
    end if;
    return pg_catalog.jsonb_build_object(
      'state', 'erased_by_tombstone',
      'source_table', p_source_table,
      'source_record_id', p_source_record_id
    );
  end if;

  select subscriber.id into v_canonical_subscriber_id
  from public.public_update_subscribers subscriber
  where subscriber.email_hash = p_v2_email_hash
    and subscriber.id <> p_source_record_id
  order by subscriber.id
  limit 1
  for update;

  if v_canonical_subscriber_id is not null then
    update public.public_digest_outbox outbox
    set
      subscriber_id = null,
      recipient_hash = null,
      recipient_encrypted = null,
      rendered_payload = null,
      status = 'privacy_scrubbed',
      last_error = 'Legacy duplicate subscriber merged into the canonical v2 identity.',
      lease_token = null,
      lease_owner = null,
      leased_at = null,
      lease_expires_at = null,
      next_attempt_at = v_now,
      updated_at = v_now
    where outbox.id = any(v_linked_outbox_ids);
    update public.public_update_deliveries delivery
    set subscriber_id = null, recipient = null, recipient_hash = null
    where delivery.subscriber_id = p_source_record_id;
    delete from public.public_update_subscribers subscriber
    where subscriber.id = p_source_record_id;
  else
    update public.public_update_subscribers subscriber
    set
      email = null,
      email_hash = p_v2_email_hash,
      email_encrypted = p_v2_email_encrypted,
      -- Recovery restores identity, not consent. A fresh confirmation is
      -- required before any recovered legacy subscriber can receive mail.
      status = 'unsubscribed',
      confirmation_token_hash = null,
      unsubscribed_at = coalesce(subscriber.unsubscribed_at, v_now),
      updated_at = v_now
    where subscriber.id = p_source_record_id;
    v_canonical_subscriber_id := p_source_record_id;
  end if;

  update public.personal_data_legacy_contact_quarantine quarantine
  set
    ciphertext_sha256 = null,
    v2_email_hash = p_v2_email_hash,
    lifecycle_status = 'recovered_v2',
    resolution = case
      when quarantine.source_table = 'public_digest_outbox'
        then 'exact_key_bound_to_existing_canonical_v2_subscriber_outbox_scrubbed'
      when v_canonical_subscriber_id = p_source_record_id
        then 'exact_key_recovered_subscriber_v2'
      else 'exact_key_bound_to_existing_canonical_v2_subscriber'
    end,
    resolved_at = v_now,
    updated_at = v_now
  where quarantine.lifecycle_status = 'disabled_retained'
    and (
      quarantine.id = v_quarantine.id
      or (
        v_canonical_subscriber_id <> p_source_record_id
        and quarantine.source_table = 'public_digest_outbox'
        and quarantine.source_record_id = any(v_linked_outbox_ids)
      )
    );

  if v_canonical_subscriber_id <> p_source_record_id and exists (
    select 1
    from public.personal_data_legacy_contact_quarantine quarantine
    where quarantine.source_table = 'public_digest_outbox'
      and quarantine.source_record_id = any(v_linked_outbox_ids)
      and quarantine.lifecycle_status = 'disabled_retained'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Legacy canonical merge did not resolve every linked outbox quarantine row.';
  end if;

  return pg_catalog.jsonb_build_object(
    'state', case when v_canonical_subscriber_id = p_source_record_id
      then 'recovered_v2' else 'canonical_v2_merged' end,
    'source_table', p_source_table,
    'source_record_id', p_source_record_id,
    'canonical_subscriber_id', v_canonical_subscriber_id,
    'v2_email_hash', p_v2_email_hash
  );
end;
$$;

revoke all on function public.recover_legacy_contact_ciphertext(
  text, uuid, timestamptz, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.recover_legacy_contact_ciphertext(
  text, uuid, timestamptz, text, text, text, text
) to service_role;

create or replace function public.get_personal_data_legacy_contact_export(
  p_v2_email_hash text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_unattributable_retained_items bigint := 0;
  v_items jsonb := '[]'::jsonb;
begin
  if p_v2_email_hash is not null
    and p_v2_email_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'A valid v2 email hash is required for privacy export.';
  end if;

  select count(*)
  into v_unattributable_retained_items
  from public.personal_data_legacy_contact_quarantine quarantine
  where quarantine.lifecycle_status = 'disabled_retained';

  if v_unattributable_retained_items > 0 then
    return pg_catalog.jsonb_build_object(
      'state', 'incomplete',
      'reason', 'legacy_contact_identity_unavailable',
      'unattributable_retained_items', v_unattributable_retained_items,
      'items', '[]'::jsonb
    );
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', quarantine.id,
        'source_table', quarantine.source_table,
        'source_record_id', quarantine.source_record_id,
        'source_column', quarantine.source_column,
        'ciphertext_format', quarantine.ciphertext_format,
        'lifecycle_status', quarantine.lifecycle_status,
        'resolution', quarantine.resolution,
        'observed_at', quarantine.observed_at,
        'resolved_at', quarantine.resolved_at
      ) order by quarantine.observed_at, quarantine.id
    ),
    '[]'::jsonb
  )
  into v_items
  from public.personal_data_legacy_contact_quarantine quarantine
  where quarantine.lifecycle_status <> 'erased_by_tombstone'
    and p_v2_email_hash is not null
    and quarantine.v2_email_hash = p_v2_email_hash;

  return pg_catalog.jsonb_build_object(
    'state', 'complete',
    'unattributable_retained_items', 0,
    'items', v_items
  );
end;
$$;

revoke all on function public.get_personal_data_legacy_contact_export(
  text
) from public, anon, authenticated, service_role;
grant execute on function public.get_personal_data_legacy_contact_export(
  text
) to service_role;

create or replace function public.erase_personal_data_for_privacy_request(
  p_user_id uuid,
  p_email_hash text,
  p_legacy_email text,
  p_privacy_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.privacy_requests%rowtype;
  v_tombstone_id uuid;
  v_subscriber_ids uuid[] := '{}'::uuid[];
  v_outbox_ids uuid[] := '{}'::uuid[];
  v_contact_deleted integer := 0;
  v_outbox_scrubbed integer := 0;
  v_profile_archive_erased integer := 0;
  v_source_page_requests_deleted integer := 0;
  v_discovery_requests_deleted integer := 0;
  v_alert_deliveries_deleted integer := 0;
  v_shared_awards_detached integer := 0;
  v_shared_award_sources_detached integer := 0;
  v_request_marked integer := 0;
  v_app_erasure_marker jsonb;
  v_app_erasure_completed_at text;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_user_id is null or p_privacy_request_id is null
    or (p_email_hash is not null and p_email_hash !~ '^[0-9a-f]{64}$') then
    raise exception using
      errcode = '22023',
      message = 'A user, pending privacy request, and valid v2 email hash are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  select * into v_request
  from public.privacy_requests privacy_request
  where privacy_request.id = p_privacy_request_id
    and privacy_request.user_id = p_user_id
    and privacy_request.request_type = 'delete'
    and privacy_request.status = 'pending'
    and privacy_request.email_hash is not distinct from p_email_hash
  for update;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'Personal-data erasure requires its exact pending privacy request.';
  end if;

  if exists (
    select 1
    from public.personal_data_legacy_contact_quarantine quarantine
    where quarantine.lifecycle_status = 'disabled_retained'
  ) then
    raise exception using
      errcode = '55000',
      message = 'legacy_contact_identity_unavailable: retained legacy contact evidence cannot be safely attributed.';
  end if;

  if p_email_hash is not null then
    insert into public.personal_data_erasure_tombstones (
      v2_email_hash,
      privacy_request_id,
      evidence_hash
    ) values (
      p_email_hash,
      p_privacy_request_id,
      public.awardping_sha256_text(
        pg_catalog.jsonb_build_object(
          'schema_version', 'personal-data-erasure-tombstone-v1',
          'v2_email_hash', p_email_hash,
          'privacy_request_id', p_privacy_request_id
        )::text
      )
    ) on conflict (v2_email_hash) do nothing;
    select tombstone.id into v_tombstone_id
    from public.personal_data_erasure_tombstones tombstone
    where tombstone.v2_email_hash = p_email_hash
    for key share;
  end if;

  v_profile_archive_erased :=
    public.erase_personal_data_legacy_archive_for_privacy_request(
      p_user_id,
      p_privacy_request_id
    );

  select coalesce(pg_catalog.array_agg(subscriber.id order by subscriber.id), '{}'::uuid[])
  into v_subscriber_ids
  from public.public_update_subscribers subscriber
  where (p_email_hash is not null and subscriber.email_hash = p_email_hash)
    or (
      nullif(pg_catalog.btrim(p_legacy_email), '') is not null
      and subscriber.email = pg_catalog.lower(pg_catalog.btrim(p_legacy_email))
    )
    or exists (
      select 1
      from public.personal_data_legacy_contact_quarantine quarantine
      where quarantine.source_table = 'public_update_subscribers'
        and quarantine.source_record_id = subscriber.id
        and quarantine.v2_email_hash = p_email_hash
    );

  select coalesce(pg_catalog.array_agg(outbox.id order by outbox.id), '{}'::uuid[])
  into v_outbox_ids
  from public.public_digest_outbox outbox
  where outbox.subscriber_id = any(v_subscriber_ids)
    or (p_email_hash is not null and outbox.recipient_hash = p_email_hash)
    or exists (
      select 1
      from public.personal_data_legacy_contact_quarantine quarantine
      where quarantine.source_table = 'public_digest_outbox'
        and quarantine.source_record_id = outbox.id
        and quarantine.v2_email_hash = p_email_hash
    );

  if exists (
    select 1
    from public.public_digest_outbox outbox
    where outbox.id = any(v_outbox_ids)
      and outbox.status = 'sending'
      and outbox.lease_expires_at > v_now
  ) then
    raise exception using
      errcode = '40001',
      message = 'Privacy erasure must retry after the active public digest send lease.';
  end if;

  -- Account-owned application data is erased only inside this exact
  -- pending-request/user/v2-bound transaction. Any later failure, including
  -- a delivery CAS or retained-evidence check, rolls all of these changes back.
  delete from public.source_page_requests request
  where request.user_id = p_user_id;
  get diagnostics v_source_page_requests_deleted = row_count;

  delete from public.discovery_requests request
  where request.user_id = p_user_id;
  get diagnostics v_discovery_requests_deleted = row_count;

  delete from public.alert_deliveries delivery
  where delivery.user_id = p_user_id;
  get diagnostics v_alert_deliveries_deleted = row_count;

  update public.shared_awards award
  set submitted_by_user_id = null
  where award.submitted_by_user_id = p_user_id;
  get diagnostics v_shared_awards_detached = row_count;

  update public.shared_award_sources source
  set submitted_by_user_id = null
  where source.submitted_by_user_id = p_user_id;
  get diagnostics v_shared_award_sources_detached = row_count;

  update public.public_digest_outbox outbox
  set
    subscriber_id = null,
    recipient_hash = null,
    recipient_encrypted = null,
    rendered_payload = null,
    status = 'privacy_scrubbed',
    last_error = 'Personal delivery material erased by a pending privacy request.',
    lease_token = null,
    lease_owner = null,
    leased_at = null,
    lease_expires_at = null,
    next_attempt_at = v_now,
    updated_at = v_now
  where outbox.id = any(v_outbox_ids)
    and outbox.status <> 'privacy_scrubbed';
  get diagnostics v_outbox_scrubbed = row_count;

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
  get diagnostics v_contact_deleted = row_count;

  if v_tombstone_id is not null then
    update public.personal_data_legacy_contact_quarantine quarantine
    set
      ciphertext_sha256 = null,
      legacy_lookup_hash = null,
      v2_email_hash = null,
      lifecycle_status = 'erased_by_tombstone',
      resolution = 'pending_privacy_request_erasure',
      erasure_tombstone_id = v_tombstone_id,
      resolved_at = v_now,
      updated_at = v_now
    where quarantine.lifecycle_status <> 'erased_by_tombstone'
      and (
        quarantine.v2_email_hash = p_email_hash
        or (
          quarantine.source_table = 'public_update_subscribers'
          and quarantine.source_record_id = any(v_subscriber_ids)
        )
        or (
          quarantine.source_table = 'public_digest_outbox'
          and quarantine.source_record_id = any(v_outbox_ids)
        )
      );
  end if;

  if exists (
    select 1
    from public.personal_data_legacy_contact_quarantine quarantine
    where quarantine.lifecycle_status <> 'erased_by_tombstone'
      and quarantine.v2_email_hash = p_email_hash
  ) then
    raise exception using
      errcode = '55000',
      message = 'legacy_contact_erasure_incomplete: linked legacy contact evidence remains.';
  end if;

  v_app_erasure_completed_at := pg_catalog.to_char(
    pg_catalog.clock_timestamp() at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
  v_app_erasure_marker := pg_catalog.jsonb_build_object(
    'schema_version', 'privacy-app-data-erasure-v1',
    'state', 'completed',
    'privacy_request_id', p_privacy_request_id,
    'user_id', p_user_id,
    'email_hash', p_email_hash,
    'completed_at', v_app_erasure_completed_at
  );
  v_app_erasure_marker := v_app_erasure_marker || pg_catalog.jsonb_build_object(
    'evidence_hash', public.awardping_sha256_text(
      pg_catalog.concat_ws(
        '|',
        'privacy-app-data-erasure-v1',
        'completed',
        p_privacy_request_id::text,
        p_user_id::text,
        coalesce(p_email_hash, '<null>'),
        v_app_erasure_completed_at
      )
    )
  );
  update public.privacy_requests privacy_request
  set details = pg_catalog.jsonb_set(
    coalesce(privacy_request.details, '{}'::jsonb),
    '{app_data_erasure}',
    v_app_erasure_marker,
    true
  )
  where privacy_request.id = p_privacy_request_id
    and privacy_request.user_id = p_user_id
    and privacy_request.status = 'pending';
  get diagnostics v_request_marked = row_count;
  if v_request_marked <> 1 then
    raise exception using
      errcode = '40001',
      message = 'Personal-data erasure completion marker CAS failed.';
  end if;

  return pg_catalog.jsonb_build_object(
    'profile_archive_rows_erased', v_profile_archive_erased,
    'source_page_requests_deleted', v_source_page_requests_deleted,
    'discovery_requests_deleted', v_discovery_requests_deleted,
    'alert_deliveries_deleted', v_alert_deliveries_deleted,
    'shared_awards_detached', v_shared_awards_detached,
    'shared_award_sources_detached', v_shared_award_sources_detached,
    'subscribers_deleted', v_contact_deleted,
    'outbox_rows_scrubbed', v_outbox_scrubbed,
    'erasure_tombstone_id', v_tombstone_id,
    'legacy_contact_identity', 'legacy_contact_identity_resolved',
    'app_data_erasure_marker', v_app_erasure_marker
  );
end;
$$;

revoke all on function public.erase_personal_data_for_privacy_request(
  uuid, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.erase_personal_data_for_privacy_request(
  uuid, text, text, uuid
) to service_role;

-- The superseded service-role erasure entrypoint has no privacy-request or
-- tombstone binding and must not remain callable during a staggered deploy.
revoke all on function public.erase_public_update_subscriber(text, text)
  from public, anon, authenticated, service_role;

create or replace function public.erase_legacy_contact_ciphertext_for_privacy_request(
  p_quarantine_id uuid,
  p_expected_ciphertext_sha256 text,
  p_privacy_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.privacy_requests%rowtype;
  v_quarantine public.personal_data_legacy_contact_quarantine%rowtype;
  v_tombstone_id uuid;
  v_artifact_key text;
  v_subscriber_ids uuid[] := '{}'::uuid[];
  v_outbox_ids uuid[] := '{}'::uuid[];
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_quarantine_id is null
    or p_privacy_request_id is null
    or p_expected_ciphertext_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'A quarantine identity, exact ciphertext hash, and privacy request are required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  select * into v_request
  from public.privacy_requests privacy_request
  where privacy_request.id = p_privacy_request_id
    and privacy_request.request_type = 'delete'
    and privacy_request.status = 'pending'
    and privacy_request.details #>> '{legacy_contact_quarantine,id}' =
      p_quarantine_id::text
    and privacy_request.details #>> '{legacy_contact_quarantine,ciphertext_sha256}' =
      p_expected_ciphertext_sha256
  for update;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'Legacy artifact erasure requires a pending privacy request.';
  end if;
  select * into v_quarantine
  from public.personal_data_legacy_contact_quarantine quarantine
  where quarantine.id = p_quarantine_id
    and quarantine.lifecycle_status = 'disabled_retained'
    and quarantine.ciphertext_sha256 = p_expected_ciphertext_sha256
  for update;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'Legacy artifact erasure CAS failed.';
  end if;

  v_artifact_key := public.awardping_sha256_text(
    'personal-data-legacy-contact-erasure-v1|' || p_quarantine_id::text ||
      '|' || p_expected_ciphertext_sha256
  );
  insert into public.personal_data_erasure_tombstones (
    legacy_artifact_key,
    privacy_request_id,
    evidence_hash
  ) values (
    v_artifact_key,
    p_privacy_request_id,
    public.awardping_sha256_text(
      pg_catalog.jsonb_build_object(
        'schema_version', 'personal-data-erasure-tombstone-v1',
        'legacy_artifact_key', v_artifact_key,
        'privacy_request_id', p_privacy_request_id
      )::text
    )
  ) on conflict (legacy_artifact_key) do nothing;
  select tombstone.id into v_tombstone_id
  from public.personal_data_erasure_tombstones tombstone
  where tombstone.legacy_artifact_key = v_artifact_key
  for key share;

  if v_quarantine.source_table = 'public_update_subscribers' then
    v_subscriber_ids := array[v_quarantine.source_record_id];
    select coalesce(pg_catalog.array_agg(outbox.id order by outbox.id), '{}'::uuid[])
    into v_outbox_ids
    from public.public_digest_outbox outbox
    where outbox.subscriber_id = v_quarantine.source_record_id;
  else
    v_outbox_ids := array[v_quarantine.source_record_id];
  end if;

  if exists (
    select 1
    from public.public_digest_outbox outbox
    where outbox.id = any(v_outbox_ids)
      and outbox.status = 'sending'
      and outbox.lease_expires_at > v_now
  ) then
    raise exception using
      errcode = '40001',
      message = 'Legacy artifact erasure must retry after the active send lease.';
  end if;

  update public.public_digest_outbox outbox
  set
    subscriber_id = null,
    recipient_hash = null,
    recipient_encrypted = null,
    rendered_payload = null,
    status = 'privacy_scrubbed',
    last_error = 'Unrecoverable legacy contact material erased by quarantine identity.',
    lease_token = null,
    lease_owner = null,
    leased_at = null,
    lease_expires_at = null,
    next_attempt_at = v_now,
    updated_at = v_now
  where outbox.id = any(v_outbox_ids)
    and outbox.status <> 'privacy_scrubbed';
  update public.public_update_deliveries delivery
  set subscriber_id = null, recipient = null, recipient_hash = null
  where delivery.subscriber_id = any(v_subscriber_ids);
  delete from public.public_update_subscribers subscriber
  where subscriber.id = any(v_subscriber_ids);

  update public.personal_data_legacy_contact_quarantine quarantine
  set
    ciphertext_sha256 = null,
    legacy_lookup_hash = null,
    v2_email_hash = null,
    lifecycle_status = 'erased_by_tombstone',
    resolution = 'quarantine_identity_privacy_erasure',
    erasure_tombstone_id = v_tombstone_id,
    resolved_at = v_now,
    updated_at = v_now
  where quarantine.lifecycle_status <> 'erased_by_tombstone'
    and (
      quarantine.id = p_quarantine_id
      or (
        quarantine.source_table = 'public_digest_outbox'
        and quarantine.source_record_id = any(v_outbox_ids)
      )
    );

  return pg_catalog.jsonb_build_object(
    'state', 'erased_by_tombstone',
    'quarantine_id', p_quarantine_id,
    'erasure_tombstone_id', v_tombstone_id
  );
end;
$$;

revoke all on function public.erase_legacy_contact_ciphertext_for_privacy_request(
  uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.erase_legacy_contact_ciphertext_for_privacy_request(
  uuid, text, uuid
) to service_role;

-- Patch the currently deployed event-ledger enqueue atomically. Exact anchors
-- make an unknown later definition fail closed instead of silently weakening
-- the v2-only contract.
do $awardping_v2_enqueue_fence$
declare
  v_oid oid := pg_catalog.to_regprocedure(
    'public.enqueue_public_digest_outbox(text,uuid,text,text,text,jsonb)'
  );
  v_definition text;
  v_updated text;
  v_cipher_guard_old text := $anchor$
      or nullif(pg_catalog.btrim(v_entry ->> 'recipient_encrypted'), '') is null then$anchor$;
  v_cipher_guard_new text := $anchor$
      or coalesce(v_entry ->> 'recipient_encrypted', '') not like 'ap:v2:%' then$anchor$;
  v_subscriber_guard_old text := $anchor$
      or v_subscriber.email_hash is distinct from v_entry ->> 'recipient_hash' then$anchor$;
  v_subscriber_guard_new text := $anchor$
      or v_subscriber.email_hash is distinct from v_entry ->> 'recipient_hash'
      or coalesce(v_subscriber.email_encrypted, '') not like 'ap:v2:%'
      or v_subscriber.email_encrypted is distinct from v_entry ->> 'recipient_encrypted' then$anchor$;
  v_reactivation_old text := $anchor$
      if v_existing.status = 'release_blocked'
        and v_existing.release_epoch = p_expected_release_epoch$anchor$;
  v_reactivation_new text := $anchor$
      if v_existing.status = 'release_blocked'
        and coalesce(v_existing.recipient_encrypted, '') like 'ap:v2:%'
        and v_existing.recipient_encrypted = v_entry ->> 'recipient_encrypted'
        and v_existing.release_epoch = p_expected_release_epoch$anchor$;
begin
  if v_oid is null then
    raise exception using errcode = '42883', message = 'Digest enqueue RPC is missing.';
  end if;
  select pg_catalog.pg_get_functiondef(v_oid) into v_definition;
  if (pg_catalog.length(v_definition) - pg_catalog.length(
      pg_catalog.replace(v_definition, v_cipher_guard_old, '')
    )) / pg_catalog.length(v_cipher_guard_old) <> 1
    or (pg_catalog.length(v_definition) - pg_catalog.length(
      pg_catalog.replace(v_definition, v_subscriber_guard_old, '')
    )) / pg_catalog.length(v_subscriber_guard_old) <> 1
    or (pg_catalog.length(v_definition) - pg_catalog.length(
      pg_catalog.replace(v_definition, v_reactivation_old, '')
    )) / pg_catalog.length(v_reactivation_old) <> 1 then
    raise exception using
      errcode = '55000',
      message = 'Digest enqueue definition did not match the exact v1-capable contract.';
  end if;
  v_updated := pg_catalog.replace(v_definition, v_cipher_guard_old, v_cipher_guard_new);
  v_updated := pg_catalog.replace(v_updated, v_subscriber_guard_old, v_subscriber_guard_new);
  v_updated := pg_catalog.replace(v_updated, v_reactivation_old, v_reactivation_new);
  execute v_updated;
  if pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(v_oid),
    $needle$v_subscriber.email_encrypted is distinct from v_entry ->> 'recipient_encrypted'$needle$
  ) = 0 then
    raise exception using errcode = '55000', message = 'Digest enqueue v2 fence was not installed.';
  end if;
end;
$awardping_v2_enqueue_fence$;

do $awardping_v2_claim_fence$
declare
  v_oid oid := pg_catalog.to_regprocedure(
    'public.claim_public_digest_outbox(text,integer,integer)'
  );
  v_definition text;
  v_old text := $anchor$
    where outbox.status in ('queued', 'ambiguous')
      and outbox.next_attempt_at <= pg_catalog.clock_timestamp()$anchor$;
  v_new text := $anchor$
    where outbox.status in ('queued', 'ambiguous')
      and coalesce(outbox.recipient_encrypted, '') like 'ap:v2:%'
      and exists (
        select 1
        from public.public_update_subscribers subscriber
        where subscriber.id = outbox.subscriber_id
          and subscriber.status = 'active'
          and subscriber.email_hash = outbox.recipient_hash
          and subscriber.email_encrypted = outbox.recipient_encrypted
          and coalesce(subscriber.email_encrypted, '') like 'ap:v2:%'
      )
      and outbox.next_attempt_at <= pg_catalog.clock_timestamp()$anchor$;
begin
  if v_oid is null then
    raise exception using errcode = '42883', message = 'Digest claim RPC is missing.';
  end if;
  select pg_catalog.pg_get_functiondef(v_oid) into v_definition;
  if (pg_catalog.length(v_definition) - pg_catalog.length(
      pg_catalog.replace(v_definition, v_old, '')
    )) / pg_catalog.length(v_old) <> 1 then
    raise exception using
      errcode = '55000',
      message = 'Digest claim definition did not match the exact v1-capable contract.';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
  if pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(v_oid),
    $needle$subscriber.email_encrypted = outbox.recipient_encrypted$needle$
  ) = 0 then
    raise exception using errcode = '55000', message = 'Digest claim v2 fence was not installed.';
  end if;
end;
$awardping_v2_claim_fence$;

do $awardping_v2_authorize_fence$
declare
  v_oid oid := pg_catalog.to_regprocedure(
    'public.authorize_public_digest_send(uuid,uuid)'
  );
  v_definition text;
  v_old text := $anchor$
    or v_subscriber.email_hash is distinct from v_outbox.recipient_hash then$anchor$;
  v_new text := $anchor$
    or v_subscriber.email_hash is distinct from v_outbox.recipient_hash
    or coalesce(v_outbox.recipient_encrypted, '') not like 'ap:v2:%'
    or coalesce(v_subscriber.email_encrypted, '') not like 'ap:v2:%'
    or v_subscriber.email_encrypted is distinct from v_outbox.recipient_encrypted then$anchor$;
begin
  if v_oid is null then
    raise exception using errcode = '42883', message = 'Digest authorization RPC is missing.';
  end if;
  select pg_catalog.pg_get_functiondef(v_oid) into v_definition;
  if (pg_catalog.length(v_definition) - pg_catalog.length(
      pg_catalog.replace(v_definition, v_old, '')
    )) / pg_catalog.length(v_old) <> 1 then
    raise exception using
      errcode = '55000',
      message = 'Digest authorization definition did not match the exact v1-capable contract.';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
  if pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(v_oid),
    $needle$coalesce(v_outbox.recipient_encrypted, '') not like 'ap:v2:%'$needle$
  ) = 0 then
    raise exception using errcode = '55000', message = 'Digest authorization v2 fence was not installed.';
  end if;
end;
$awardping_v2_authorize_fence$;

revoke all on function public.enqueue_public_digest_outbox(
  text, uuid, text, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_public_digest_outbox(
  text, uuid, text, text, text, jsonb
) to service_role;
revoke all on function public.claim_public_digest_outbox(text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_public_digest_outbox(text, integer, integer)
  to service_role;
revoke all on function public.authorize_public_digest_send(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_public_digest_send(uuid, uuid)
  to service_role;

-- Make legacy-contact safety part of the signed Stage 1 basis and state hash.
-- The original gate stays intact as a private implementation detail; the
-- canonical name becomes a fail-closed wrapper.
alter function private.stage1_release_gate_snapshot(timestamptz)
  rename to stage1_gate_without_contact_fence_20260717123000;

revoke all on function private.stage1_gate_without_contact_fence_20260717123000(
  timestamptz
) from public, anon, authenticated, service_role;

create or replace function private.stage1_release_gate_snapshot(
  p_evaluated_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inner jsonb;
  v_contact jsonb;
  v_failures jsonb;
  v_basis jsonb;
begin
  v_inner :=
    private.stage1_gate_without_contact_fence_20260717123000(
      p_evaluated_at
    );
  v_contact := private.personal_data_legacy_contact_gate_snapshot();
  v_failures := case
    when pg_catalog.jsonb_typeof(v_inner -> 'failures') = 'array'
      then v_inner -> 'failures'
    else '[]'::jsonb
  end;
  if v_contact ->> 'state' <> 'SAFE'
    and not v_failures @> '["legacy_contact_ciphertext_not_safe"]'::jsonb then
    v_failures := v_failures ||
      '["legacy_contact_ciphertext_not_safe"]'::jsonb;
  end if;
  v_basis := (
    v_inner - 'generated_at' - 'state' - 'state_hash' - 'failures'
  ) || pg_catalog.jsonb_build_object(
    'personal_data_legacy_contacts', v_contact,
    'failures', v_failures
  );
  return v_basis || pg_catalog.jsonb_build_object(
    'generated_at', p_evaluated_at,
    'state', case when pg_catalog.jsonb_array_length(v_failures) = 0
      then 'READY' else 'HOLD' end,
    'state_hash', public.stage1_publication_evidence_hash(v_basis)
  );
end;
$$;

revoke all on function private.stage1_release_gate_snapshot(timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.get_stage1_release_gate_snapshot()
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.stage1_release_gate_snapshot(pg_catalog.clock_timestamp());
$$;

revoke all on function public.get_stage1_release_gate_snapshot()
  from public, anon, authenticated, service_role;
grant execute on function public.get_stage1_release_gate_snapshot()
  to service_role;

comment on table public.personal_data_legacy_contact_quarantine is
  'Durable no-plaintext inventory of every non-v2 subscriber/outbox contact artifact, its disabled state, exact-key v1 recovery, and erasure linkage.';
comment on table public.personal_data_erasure_tombstones is
  'Immutable pending-request-bound tombstones that prevent later legacy-key recovery from rehydrating erased contact data.';
