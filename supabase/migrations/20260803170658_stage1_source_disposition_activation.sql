-- Atomic, zero-charge application of the exact operator-reviewed Stage 1
-- baseline-source disposition: ten approved historical baselines and the Luce
-- funding page retained in durable quarantine. The approval grants monitoring
-- authority only. First visual baseline activation remains held until the
-- exact retained normalized text hash receives a server-side receipt.

revoke create on schema public from public;

-- Production already carries this normalized identity index, but the DDL was
-- not represented in the migration chain. Recreate the invariant for fresh
-- environments and fail with a useful error before the unique-index build.
do $stage1_source_normalized_identity_preflight$
declare
  v_duplicate record;
begin
  select
    source.shared_award_id,
    pg_catalog.lower(
      pg_catalog.regexp_replace(
        pg_catalog.split_part(source.url, '#', 1),
        '/+$',
        ''
      )
    ) as normalized_url,
    pg_catalog.count(*) as row_count
  into v_duplicate
  from public.shared_award_sources source
  group by
    source.shared_award_id,
    pg_catalog.lower(
      pg_catalog.regexp_replace(
        pg_catalog.split_part(source.url, '#', 1),
        '/+$',
        ''
      )
    )
  having pg_catalog.count(*) > 1
  order by source.shared_award_id, normalized_url
  limit 1;

  if found then
    raise exception using
      errcode = '23505',
      message = 'Duplicate normalized shared-award source identities must be resolved before Stage 1 source disposition activation.',
      detail = pg_catalog.format(
        'shared_award_id=%s normalized_url=%s row_count=%s',
        v_duplicate.shared_award_id,
        v_duplicate.normalized_url,
        v_duplicate.row_count
      );
  end if;
end;
$stage1_source_normalized_identity_preflight$;

create unique index if not exists shared_award_sources_award_normalized_url_uidx
  on public.shared_award_sources (
    shared_award_id,
    pg_catalog.lower(
      pg_catalog.regexp_replace(
        pg_catalog.split_part(url, '#', 1),
        '/+$',
        ''
      )
    )
  );

create table private.stage1_source_disposition_bundles (
  bundle_sha256 text primary key,
  confirmation_sha256 text not null unique,
  policy_version text not null,
  evidence_packet_sha256 text not null,
  state_fingerprint_sha256 text not null,
  onboarding_plan_sha256 text not null,
  reviewed_by text not null,
  reviewed_at timestamptz not null,
  approved_count integer not null check (approved_count = 10),
  quarantined_count integer not null check (quarantined_count = 1),
  item_count integer not null check (item_count = 11),
  full_plan jsonb not null,
  confirmation_payload jsonb not null,
  receipt jsonb not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint stage1_source_disposition_bundle_hash_check check (
    bundle_sha256 ~ '^[0-9a-f]{64}$'
    and confirmation_sha256 ~ '^[0-9a-f]{64}$'
    and evidence_packet_sha256 ~ '^[0-9a-f]{64}$'
    and state_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
    and onboarding_plan_sha256 ~ '^[0-9a-f]{64}$'
    and private.stage1_canonical_json_sha256(full_plan) = bundle_sha256
    and private.stage1_canonical_json_sha256(confirmation_payload) = confirmation_sha256
    and pg_catalog.jsonb_typeof(receipt) = 'object'
  )
);

create table private.stage1_source_disposition_items (
  decision_item_sha256 text primary key,
  bundle_sha256 text not null references
    private.stage1_source_disposition_bundles(bundle_sha256) on delete restrict,
  item_number integer not null check (item_number between 1 and 11),
  request_id uuid not null,
  decision text not null check (
    decision in ('approve_baseline_only', 'keep_quarantined')
  ),
  shared_award_id uuid not null references public.shared_awards(id) on delete restrict,
  shared_award_source_id uuid references public.shared_award_sources(id) on delete restrict,
  source_acquisition_id uuid references
    public.shared_award_source_acquisitions(id) on delete restrict,
  reviewed_roles jsonb not null check (
    pg_catalog.jsonb_typeof(reviewed_roles) = 'array'
    and pg_catalog.jsonb_array_length(reviewed_roles) > 0
  ),
  decision_payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint stage1_source_disposition_item_identity_check check (
    decision_item_sha256 ~ '^[0-9a-f]{64}$'
    and private.stage1_canonical_json_sha256(
      decision_payload
        - 'decision_item_sha256'
        - 'source_payload'
        - 'acquisition_payload'
        - 'request_patch'
    ) = decision_item_sha256
    and pg_catalog.jsonb_typeof(result) = 'object'
    and (
      decision = 'approve_baseline_only'
      and shared_award_source_id is not null
      and source_acquisition_id is not null
      or decision = 'keep_quarantined'
      and shared_award_source_id is null
      and source_acquisition_id is null
    )
  ),
  unique (bundle_sha256, item_number),
  unique (bundle_sha256, request_id)
);

create table private.stage1_source_baseline_activation_receipts (
  source_acquisition_id uuid primary key references
    public.shared_award_source_acquisitions(id) on delete restrict,
  shared_award_source_id uuid not null unique references
    public.shared_award_sources(id) on delete restrict,
  source_page_request_id uuid not null,
  disposition_item_sha256 text not null references
    private.stage1_source_disposition_items(decision_item_sha256) on delete restrict,
  guard_sha256 text not null,
  expected_normalized_text_sha256 text not null,
  observed_normalized_text_sha256 text not null,
  prepare_receipt_sha256 text not null unique,
  receipt jsonb not null,
  verified_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint stage1_source_baseline_activation_receipt_hash_check check (
    guard_sha256 ~ '^[0-9a-f]{64}$'
    and expected_normalized_text_sha256 ~ '^[0-9a-f]{64}$'
    and observed_normalized_text_sha256 ~ '^[0-9a-f]{64}$'
    and prepare_receipt_sha256 ~ '^[0-9a-f]{64}$'
    and expected_normalized_text_sha256 = observed_normalized_text_sha256
    and pg_catalog.jsonb_typeof(receipt) = 'object'
    and private.stage1_canonical_json_sha256(receipt) = prepare_receipt_sha256
    and receipt ->> 'shared_award_source_id' = shared_award_source_id::text
    and receipt ->> 'source_acquisition_id' = source_acquisition_id::text
    and receipt ->> 'source_page_request_id' = source_page_request_id::text
    and receipt ->> 'decision_item_sha256' = disposition_item_sha256
    and receipt ->> 'guard_sha256' = guard_sha256
    and receipt ->> 'expected_normalized_text_sha256' =
      expected_normalized_text_sha256
    and receipt ->> 'observed_normalized_text_sha256' =
      observed_normalized_text_sha256
  )
);

create table private.stage1_source_baseline_activation_finalizations (
  source_acquisition_id uuid primary key references
    public.shared_award_source_acquisitions(id) on delete restrict,
  shared_award_source_id uuid not null unique references
    public.shared_award_sources(id) on delete restrict,
  source_page_request_id uuid not null,
  disposition_item_sha256 text not null references
    private.stage1_source_disposition_items(decision_item_sha256) on delete restrict,
  prepare_receipt_sha256 text not null unique references
    private.stage1_source_baseline_activation_receipts(prepare_receipt_sha256)
    on delete restrict,
  guard_sha256 text not null,
  observed_normalized_text_sha256 text not null,
  persistence_evidence jsonb not null,
  finalization_receipt_sha256 text not null unique,
  receipt jsonb not null,
  finalized_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint stage1_source_baseline_activation_finalization_hash_check check (
    guard_sha256 ~ '^[0-9a-f]{64}$'
    and observed_normalized_text_sha256 ~ '^[0-9a-f]{64}$'
    and finalization_receipt_sha256 ~ '^[0-9a-f]{64}$'
    and pg_catalog.jsonb_typeof(persistence_evidence) = 'object'
    and pg_catalog.jsonb_typeof(receipt) = 'object'
    and private.stage1_canonical_json_sha256(receipt) = finalization_receipt_sha256
    and receipt ->> 'shared_award_source_id' = shared_award_source_id::text
    and receipt ->> 'source_acquisition_id' = source_acquisition_id::text
    and receipt ->> 'source_page_request_id' = source_page_request_id::text
    and receipt ->> 'decision_item_sha256' = disposition_item_sha256
    and receipt ->> 'prepare_receipt_sha256' = prepare_receipt_sha256
    and receipt ->> 'guard_sha256' = guard_sha256
    and receipt ->> 'observed_normalized_text_sha256' =
      observed_normalized_text_sha256
    and receipt ->> 'persistence_evidence_sha256' =
      private.stage1_canonical_json_sha256(persistence_evidence)
  )
);

create table private.stage1_source_baseline_activation_failures (
  failure_sha256 text primary key,
  source_acquisition_id uuid not null references
    public.shared_award_source_acquisitions(id) on delete restrict,
  shared_award_source_id uuid not null references
    public.shared_award_sources(id) on delete restrict,
  source_page_request_id uuid not null,
  disposition_item_sha256 text not null references
    private.stage1_source_disposition_items(decision_item_sha256) on delete restrict,
  reason_code text not null check (
    reason_code ~ '^stage1_baseline_activation_[a-z0-9_]+$'
  ),
  guard_sha256 text not null check (guard_sha256 ~ '^[0-9a-f]{64}$'),
  evidence jsonb not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint stage1_source_baseline_activation_failure_hash_check check (
    failure_sha256 ~ '^[0-9a-f]{64}$'
    and private.stage1_canonical_json_sha256(evidence) = failure_sha256
  )
);

create index stage1_source_baseline_activation_failures_acquisition_idx
  on private.stage1_source_baseline_activation_failures (
    source_acquisition_id,
    created_at desc
  );

alter table private.stage1_source_disposition_bundles enable row level security;
alter table private.stage1_source_disposition_items enable row level security;
alter table private.stage1_source_baseline_activation_receipts enable row level security;
alter table private.stage1_source_baseline_activation_finalizations enable row level security;
alter table private.stage1_source_baseline_activation_failures enable row level security;

revoke all on table
  private.stage1_source_disposition_bundles,
  private.stage1_source_disposition_items,
  private.stage1_source_baseline_activation_receipts,
  private.stage1_source_baseline_activation_finalizations,
  private.stage1_source_baseline_activation_failures
from public, anon, authenticated, service_role;
grant select on table
  private.stage1_source_disposition_bundles,
  private.stage1_source_disposition_items,
  private.stage1_source_baseline_activation_receipts,
  private.stage1_source_baseline_activation_finalizations,
  private.stage1_source_baseline_activation_failures
to service_role;

create policy stage1_source_disposition_bundles_service_read
on private.stage1_source_disposition_bundles
for select to service_role using (true);
create policy stage1_source_disposition_items_service_read
on private.stage1_source_disposition_items
for select to service_role using (true);
create policy stage1_source_baseline_activation_receipts_service_read
on private.stage1_source_baseline_activation_receipts
for select to service_role using (true);
create policy stage1_source_baseline_activation_finalizations_service_read
on private.stage1_source_baseline_activation_finalizations
for select to service_role using (true);
create policy stage1_source_baseline_activation_failures_service_read
on private.stage1_source_baseline_activation_failures
for select to service_role using (true);

create or replace function private.prevent_stage1_source_disposition_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Reviewed Stage 1 source disposition and activation receipts are immutable.';
end;
$$;

revoke all on function private.prevent_stage1_source_disposition_mutation()
  from public, anon, authenticated, service_role;

create trigger prevent_stage1_source_disposition_bundle_mutation
before update or delete on private.stage1_source_disposition_bundles
for each row execute function private.prevent_stage1_source_disposition_mutation();
create trigger prevent_stage1_source_disposition_item_mutation
before update or delete on private.stage1_source_disposition_items
for each row execute function private.prevent_stage1_source_disposition_mutation();
create trigger prevent_stage1_source_baseline_activation_receipt_mutation
before update or delete on private.stage1_source_baseline_activation_receipts
for each row execute function private.prevent_stage1_source_disposition_mutation();
create trigger prevent_stage1_source_baseline_activation_finalization_mutation
before update or delete on private.stage1_source_baseline_activation_finalizations
for each row execute function private.prevent_stage1_source_disposition_mutation();
create trigger prevent_stage1_source_baseline_activation_failure_mutation
before update or delete on private.stage1_source_baseline_activation_failures
for each row execute function private.prevent_stage1_source_disposition_mutation();

-- Once attached, monitoring-only authority is a durable fence. Routine
-- baseline-fact refresh may replace other page_metadata keys but may neither
-- remove/change this approval nor move the source to a different award/URL.
create or replace function public.preserve_stage1_baseline_monitoring_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous jsonb := 'null'::jsonb;
  v_current jsonb := 'null'::jsonb;
  v_confirmation_marker text;
begin
  if tg_op = 'DELETE' then
    v_previous := coalesce(
      old.page_metadata -> 'stage1_baseline_monitoring_approval',
      'null'::jsonb
    );
    if v_previous <> 'null'::jsonb then
      raise exception using
        errcode = '55000',
        message = 'A Stage 1 baseline monitoring-approved source cannot be deleted.';
    end if;
    return old;
  end if;

  v_current := coalesce(
    new.page_metadata -> 'stage1_baseline_monitoring_approval',
    'null'::jsonb
  );
  if tg_op = 'UPDATE' then
    v_previous := coalesce(
      old.page_metadata -> 'stage1_baseline_monitoring_approval',
      'null'::jsonb
    );
  end if;

  if v_previous = 'null'::jsonb and v_current <> 'null'::jsonb then
    v_confirmation_marker := pg_catalog.current_setting(
      'awardping.stage1_source_disposition_confirmation',
      true
    );
    if coalesce(v_confirmation_marker, '') !~ '^[0-9a-f]{64}$'
      or new.admin_review_status is distinct from 'review_later'
      or new.admin_review_note is distinct from
        'approved_pending_exact_first_visual_baseline'
      or new.admin_reviewed_by is distinct from
        'stage1-baseline-source-disposition'
      or private.stage1_jsonb_has_exact_keys(v_current, array[
        'decision',
        'decision_item_sha256',
        'evidence_packet_sha256',
        'exact_evidence_verified',
        'fact_candidate_authority',
        'notification_mode',
        'policy_version',
        'public_fact_authority',
        'reviewed_roles',
        'schema_version',
        'shared_award_source_id',
        'source_page_request_id'
      ]) is not true
      or v_current ->> 'shared_award_source_id' is distinct from new.id::text
      or v_current ->> 'schema_version' is distinct from
        'awardping.stage1.baseline-monitoring-approval.v1'
      or v_current ->> 'policy_version' is distinct from
        'stage1-baseline-source-disposition-v1'
      or v_current ->> 'decision' is distinct from 'monitoring_only'
      or v_current -> 'public_fact_authority' is distinct from 'false'::jsonb
      or v_current -> 'fact_candidate_authority' is distinct from 'false'::jsonb
    then
      raise exception using
        errcode = '55000',
        message = 'Stage 1 monitoring approval may only be attached by the exact atomic held-source disposition RPC.';
    end if;
  end if;

  if v_previous <> 'null'::jsonb and (
    v_current is distinct from v_previous
    or new.shared_award_id is distinct from old.shared_award_id
    or new.url is distinct from old.url
  ) then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 baseline monitoring approval, award identity, and source URL are immutable.';
  end if;

  if v_previous <> 'null'::jsonb
    and old.admin_review_status = 'review_later'
    and new.admin_review_status = 'open'
    and not exists (
      select 1
      from private.stage1_source_baseline_activation_finalizations finalized
      where finalized.shared_award_source_id = old.id
        and finalized.source_page_request_id =
          (v_previous ->> 'source_page_request_id')::uuid
        and finalized.disposition_item_sha256 =
          v_previous ->> 'decision_item_sha256'
        and not exists (
          select 1
          from private.stage1_source_baseline_activation_failures failure
          where failure.shared_award_source_id = old.id
            and failure.created_at >= finalized.finalized_at
        )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 monitoring sources remain review_later until exact immutable baseline finalization exists.';
  end if;
  return new;
end;
$$;

revoke all on function public.preserve_stage1_baseline_monitoring_approval()
  from public, anon, authenticated, service_role;

create trigger preserve_stage1_baseline_monitoring_approval_trigger
before insert or update of page_metadata, shared_award_id, url, admin_review_status or delete
on public.shared_award_sources
for each row execute function public.preserve_stage1_baseline_monitoring_approval();

create or replace function private.stage1_source_roles_valid(p_roles jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_roles) = 'array'
    and pg_catalog.jsonb_array_length(p_roles) between 1 and 8
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_roles) role(value)
      where pg_catalog.jsonb_typeof(role.value) <> 'string'
        or role.value #>> '{}' not in (
          'identity_home',
          'eligibility',
          'application_materials',
          'dates_cycle',
          'funding',
          'faq',
          'selection_interviews',
          'current_documents'
        )
    )
    and (
      select pg_catalog.count(*) = pg_catalog.count(distinct role.value #>> '{}')
      from pg_catalog.jsonb_array_elements(p_roles) role(value)
    )
    and p_roles = (
      select pg_catalog.jsonb_agg(role.value order by role.value #>> '{}')
      from pg_catalog.jsonb_array_elements(p_roles) role(value)
    )
$$;

create or replace function private.stage1_monitoring_approval_valid(
  p_approval jsonb,
  p_source_id uuid,
  p_request_id uuid,
  p_evidence_packet_sha256 text,
  p_decision_item_sha256 text,
  p_reviewed_roles jsonb
)
returns boolean
language sql
stable
strict
set search_path = ''
as $$
  select private.stage1_jsonb_has_exact_keys(p_approval, array[
      'decision',
      'decision_item_sha256',
      'evidence_packet_sha256',
      'exact_evidence_verified',
      'fact_candidate_authority',
      'notification_mode',
      'policy_version',
      'public_fact_authority',
      'reviewed_roles',
      'schema_version',
      'shared_award_source_id',
      'source_page_request_id'
    ])
    and p_approval ->> 'schema_version' =
      'awardping.stage1.baseline-monitoring-approval.v1'
    and p_approval ->> 'policy_version' =
      'stage1-baseline-source-disposition-v1'
    and p_approval ->> 'decision' = 'monitoring_only'
    and p_approval ->> 'shared_award_source_id' = p_source_id::text
    and p_approval ->> 'source_page_request_id' = p_request_id::text
    and p_approval ->> 'evidence_packet_sha256' = p_evidence_packet_sha256
    and p_approval ->> 'decision_item_sha256' = p_decision_item_sha256
    and p_approval -> 'reviewed_roles' = p_reviewed_roles
    and private.stage1_source_roles_valid(p_approval -> 'reviewed_roles')
    and p_approval -> 'exact_evidence_verified' = 'true'::jsonb
    and p_approval ->> 'notification_mode' = 'baseline_only'
    and p_approval -> 'public_fact_authority' = 'false'::jsonb
    and p_approval -> 'fact_candidate_authority' = 'false'::jsonb
$$;

create or replace function private.stage1_human_source_disposition_valid(
  p_disposition jsonb,
  p_source_id uuid,
  p_acquisition_id uuid,
  p_request_id uuid,
  p_evidence_packet_sha256 text,
  p_decision_item_sha256 text,
  p_reviewed_roles jsonb,
  p_capture_metadata jsonb,
  p_final_url text
)
returns boolean
language plpgsql
stable
strict
set search_path = ''
as $$
declare
  v_review jsonb := p_disposition -> 'effective_source_review';
  v_guard jsonb := p_disposition -> 'activation_guard';
  v_authority jsonb := p_disposition -> 'authority';
  v_facts jsonb := v_review -> 'facts';
  v_artifact jsonb := v_guard -> 'retained_text_artifact';
  v_retained jsonb := p_capture_metadata -> 'retained_artifact';
  v_retained_text jsonb := v_retained #> array['artifacts', 'text'];
  v_quote jsonb;
begin
  if private.stage1_jsonb_has_exact_keys(p_disposition, array[
      'activation_guard',
      'authority',
      'decision',
      'effective_source_review',
      'guard_sha256',
      'policy_version',
      'schema_version'
    ]) is not true
    or p_disposition ->> 'schema_version' is distinct from
      'awardping.stage1.baseline-source-human-disposition.v1'
    or p_disposition ->> 'policy_version' is distinct from
      'stage1-baseline-source-disposition-v1'
    or p_disposition ->> 'decision' is distinct from 'approve_baseline_only'
    or coalesce(p_disposition ->> 'guard_sha256', '') !~ '^[0-9a-f]{64}$'
    or private.stage1_canonical_json_sha256(p_disposition - 'guard_sha256')
      is distinct from p_disposition ->> 'guard_sha256'
  then
    return false;
  end if;

  if private.stage1_jsonb_has_exact_keys(v_guard, array[
      'capture_file_sha256',
      'decision_item_sha256',
      'evidence_packet_sha256',
      'final_url',
      'mode',
      'normalized_retained_text_sha256',
      'notification_mode',
      'onboarding_batch_id',
      'retained_text_artifact',
      'shared_award_source_acquisition_id',
      'shared_award_source_id',
      'source_page_request_id'
    ]) is not true
    or v_guard ->> 'mode' is distinct from
      'first_visual_baseline_exact_normalized_retained_text'
    or v_guard ->> 'notification_mode' is distinct from 'baseline_only'
    or v_guard ->> 'onboarding_batch_id' is distinct from
      'stage1-national-25-reviewed-sources-v1'
    or v_guard ->> 'shared_award_source_id' is distinct from p_source_id::text
    or v_guard ->> 'shared_award_source_acquisition_id'
      is distinct from p_acquisition_id::text
    or v_guard ->> 'source_page_request_id' is distinct from p_request_id::text
    or v_guard ->> 'evidence_packet_sha256'
      is distinct from p_evidence_packet_sha256
    or v_guard ->> 'decision_item_sha256'
      is distinct from p_decision_item_sha256
    or v_guard ->> 'final_url' is distinct from p_final_url
    or p_final_url !~ '^https://'
    or coalesce(v_guard ->> 'capture_file_sha256', '') !~ '^[0-9a-f]{64}$'
    or coalesce(v_guard ->> 'normalized_retained_text_sha256', '')
      !~ '^[0-9a-f]{64}$'
    or v_guard ->> 'capture_file_sha256'
      is distinct from p_capture_metadata ->> 'capture_file_hash'
    or v_guard ->> 'normalized_retained_text_sha256'
      is distinct from v_retained ->> 'text_hash'
  then
    return false;
  end if;

  if private.stage1_jsonb_has_exact_keys(v_artifact, array[
      'bucket', 'bytes', 'key', 'r2_verified_at', 'sha256', 'store_id'
    ]) is not true
    or pg_catalog.jsonb_typeof(v_artifact -> 'bytes') is distinct from 'number'
    or coalesce(v_artifact ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
    or v_artifact ->> 'bucket' is distinct from v_retained ->> 'r2_bucket'
    or v_artifact ->> 'store_id' is distinct from v_retained ->> 'r2_store_id'
    or v_artifact ->> 'r2_verified_at' is distinct from v_retained ->> 'r2_verified_at'
    or v_artifact ->> 'key' is distinct from v_retained_text ->> 'key'
    or v_artifact ->> 'sha256' is distinct from v_retained_text ->> 'sha256'
    or (v_artifact ->> 'bytes')::numeric is distinct from
      (v_retained_text ->> 'byte_length')::numeric
    or v_artifact ->> 'key' is distinct from
      'source-intake-first-observation/v1/requests/' || p_request_id::text ||
      '/sha256/' || (v_guard ->> 'capture_file_sha256') || '/text.txt'
  then
    return false;
  end if;

  if private.stage1_jsonb_has_exact_keys(v_review, array[
      'confidence',
      'cycle_relevance',
      'evidence_quotes',
      'exact_evidence_verified',
      'facts',
      'officialness',
      'page_type',
      'reviewed_roles',
      'source_relevance',
      'status'
    ]) is not true
    or v_review ->> 'status' is distinct from 'accepted'
    or v_review ->> 'source_relevance' not in ('primary', 'supporting')
    or v_review ->> 'cycle_relevance' not in (
      'current_or_upcoming', 'evergreen'
    )
    or v_review ->> 'officialness' not in ('official', 'likely_official')
    or v_review ->> 'confidence' not in ('medium', 'high')
    or v_review ->> 'page_type' not in (
      'homepage', 'application', 'deadline', 'eligibility', 'requirements',
      'faq', 'pdf', 'portal', 'listing', 'other'
    )
    or v_review -> 'exact_evidence_verified' is distinct from 'true'::jsonb
    or v_review -> 'reviewed_roles' is distinct from p_reviewed_roles
    or private.stage1_source_roles_valid(v_review -> 'reviewed_roles') is not true
    or pg_catalog.jsonb_typeof(v_review -> 'evidence_quotes') is distinct from 'array'
    or pg_catalog.jsonb_array_length(v_review -> 'evidence_quotes') < 1
  then
    return false;
  end if;

  if private.stage1_jsonb_has_exact_keys(v_facts, array[
      'amount',
      'application_materials',
      'deadline',
      'description',
      'eligibility',
      'important_dates'
    ]) is not true
    or v_facts -> 'amount' is distinct from 'null'::jsonb
    or v_facts -> 'deadline' is distinct from 'null'::jsonb
    or v_facts -> 'description' is distinct from 'null'::jsonb
    or v_facts -> 'application_materials' is distinct from '[]'::jsonb
    or v_facts -> 'eligibility' is distinct from '[]'::jsonb
    or v_facts -> 'important_dates' is distinct from '[]'::jsonb
  then
    return false;
  end if;

  for v_quote in
    select quote.value
    from pg_catalog.jsonb_array_elements(v_review -> 'evidence_quotes') quote(value)
  loop
    if pg_catalog.jsonb_typeof(v_quote) <> 'string'
      or nullif(pg_catalog.btrim(v_quote #>> '{}'), '') is null
      or pg_catalog.strpos(
        coalesce(p_capture_metadata ->> 'text', ''),
        v_quote #>> '{}'
      ) = 0
    then
      return false;
    end if;
  end loop;

  if private.stage1_jsonb_has_exact_keys(v_authority, array[
      'fact_candidates',
      'first_observation_notification',
      'monitoring',
      'publication',
      'public_facts',
      'reconciliation'
    ]) is not true
    or v_authority -> 'monitoring' is distinct from 'true'::jsonb
    or v_authority -> 'fact_candidates' is distinct from 'false'::jsonb
    or v_authority -> 'first_observation_notification' is distinct from 'false'::jsonb
    or v_authority -> 'publication' is distinct from 'false'::jsonb
    or v_authority -> 'public_facts' is distinct from 'false'::jsonb
    or v_authority -> 'reconciliation' is distinct from 'false'::jsonb
  then
    return false;
  end if;

  return true;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$$;

revoke all on function private.stage1_source_roles_valid(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.stage1_monitoring_approval_valid(
  jsonb, uuid, uuid, text, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.stage1_human_source_disposition_valid(
  jsonb, uuid, uuid, uuid, text, text, jsonb, jsonb, text
) from public, anon, authenticated, service_role;

create or replace function private.stage1_source_disposition_uuid(
  p_kind text,
  p_request_id uuid
)
returns uuid
language plpgsql
stable
strict
set search_path = ''
as $$
declare
  v_hash text;
  v_bytes bytea;
  v_hex text;
begin
  if p_kind not in ('source', 'acquisition') then
    return null;
  end if;
  v_hash := private.stage1_text_sha256(
    'stage1-baseline-source-disposition:' || p_kind || ':' || p_request_id::text
  );
  v_bytes := pg_catalog.decode(pg_catalog.substr(v_hash, 1, 32), 'hex');
  v_bytes := pg_catalog.set_byte(
    v_bytes,
    6,
    (pg_catalog.get_byte(v_bytes, 6) & 15) | 80
  );
  v_bytes := pg_catalog.set_byte(
    v_bytes,
    8,
    (pg_catalog.get_byte(v_bytes, 8) & 63) | 128
  );
  v_hex := pg_catalog.encode(v_bytes, 'hex');
  return (
    pg_catalog.substr(v_hex, 1, 8) || '-' ||
    pg_catalog.substr(v_hex, 9, 4) || '-' ||
    pg_catalog.substr(v_hex, 13, 4) || '-' ||
    pg_catalog.substr(v_hex, 17, 4) || '-' ||
    pg_catalog.substr(v_hex, 21, 12)
  )::uuid;
end;
$$;

revoke all on function private.stage1_source_disposition_uuid(text, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.apply_reviewed_stage1_source_dispositions(
  p_binding jsonb,
  p_confirmation_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_confirmation_payload jsonb;
  v_confirmation jsonb;
  v_operator_review jsonb;
  v_safety jsonb;
  v_decisions jsonb;
  v_bundle_sha256 text;
  v_reviewed_at timestamptz;
  v_built_at timestamptz;
  v_apply_not_after timestamptz;
  v_rows_observed_at timestamptz;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_decision jsonb;
  v_expected record;
  v_request public.source_page_requests%rowtype;
  v_source public.shared_award_sources%rowtype;
  v_acquisition public.shared_award_source_acquisitions%rowtype;
  v_existing_bundle private.stage1_source_disposition_bundles%rowtype;
  v_source_id uuid;
  v_acquisition_id uuid;
  v_existing_source_id uuid;
  v_expected_existing_source_id uuid;
  v_item_number integer;
  v_request_id uuid;
  v_award_id uuid;
  v_decision_name text;
  v_item_sha256 text;
  v_expected_status_reason text;
  v_expected_roles jsonb;
  v_source_payload jsonb;
  v_acquisition_payload jsonb;
  v_request_patch jsonb;
  v_request_binding jsonb;
  v_role_binding jsonb;
  v_provider_binding jsonb;
  v_retained_evidence jsonb;
  v_classification jsonb;
  v_source_binding jsonb;
  v_acquisition_binding jsonb;
  v_human_disposition jsonb;
  v_monitoring_approval jsonb;
  v_source_inserted boolean;
  v_item_results jsonb := '[]'::jsonb;
  v_item_ledger_rows jsonb := '[]'::jsonb;
  v_receipt jsonb;
  v_quarantine_evidence jsonb;
  v_quarantine_id uuid;
  v_existing_quarantine public.manual_quarantine_registry%rowtype;
  v_ai_review_patch jsonb;
  v_item_result jsonb;
  v_item_ledger_row jsonb;
  v_expected_quotes jsonb;
  v_approved_count integer := 0;
  v_quarantined_count integer := 0;
  v_count integer;
begin
  if private.stage1_jsonb_has_exact_keys(p_binding, array[
      'apply_not_after',
      'built_at',
      'confirmation',
      'confirmation_payload',
      'mode',
      'policy_version',
      'schema_version'
    ]) is not true
    or p_binding ->> 'schema_version' is distinct from
      'awardping.stage1.baseline-source-disposition-plan.v1'
    or p_binding ->> 'policy_version' is distinct from
      'stage1-baseline-source-disposition-v1'
    or p_binding ->> 'mode' is distinct from 'local_preview'
    or pg_catalog.jsonb_typeof(p_binding -> 'confirmation_payload')
      is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_binding -> 'confirmation')
      is distinct from 'object'
    or coalesce(p_confirmation_sha256, '') !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023',
      message = 'A complete reviewed Stage 1 baseline-source disposition plan is required.';
  end if;

  v_confirmation_payload := p_binding -> 'confirmation_payload';
  v_confirmation := p_binding -> 'confirmation';
  v_bundle_sha256 := private.stage1_canonical_json_sha256(p_binding);

  if private.stage1_jsonb_has_exact_keys(v_confirmation, array[
      'exact_confirmation_phrase', 'plan_sha256'
    ]) is not true
    or private.stage1_canonical_json_sha256(v_confirmation_payload)
      is distinct from p_confirmation_sha256
    or v_confirmation ->> 'plan_sha256' is distinct from p_confirmation_sha256
    or v_confirmation ->> 'exact_confirmation_phrase' is distinct from
      'Apply Stage 1 baseline-source disposition plan ' || p_confirmation_sha256
  then
    raise exception using errcode = '22023',
      message = 'The exact current Stage 1 source disposition confirmation is required.';
  end if;

  if private.stage1_jsonb_has_exact_keys(v_confirmation_payload, array[
      'decisions',
      'evidence_packet_sha256',
      'onboarding_plan_sha256',
      'operator_review',
      'rows_observed_at',
      'safety_contract',
      'state_fingerprint_sha256'
    ]) is not true
    or v_confirmation_payload ->> 'evidence_packet_sha256' is distinct from
      '8a1c1d9aa8ccbdf1dcdbb7b2f4b83ac19c99dd9557a8949dff5f63dd22d1026f'
    or v_confirmation_payload ->> 'state_fingerprint_sha256' is distinct from
      '5773e66daa7726642f6c4442f5ad1db581ed598aaf2584d5ac5db141d141915a'
    or v_confirmation_payload ->> 'onboarding_plan_sha256' is distinct from
      '302bbdd44cd2366bcf811ad0c7ea75b8a2b901c5e235ef6925b08bdfcd8ea1c9'
    or pg_catalog.jsonb_typeof(v_confirmation_payload -> 'operator_review')
      is distinct from 'object'
    or pg_catalog.jsonb_typeof(v_confirmation_payload -> 'safety_contract')
      is distinct from 'object'
    or pg_catalog.jsonb_typeof(v_confirmation_payload -> 'decisions')
      is distinct from 'array'
  then
    raise exception using errcode = '22023',
      message = 'The Stage 1 evidence packet, production fingerprint, or onboarding plan does not match the reviewed disposition.';
  end if;

  v_operator_review := v_confirmation_payload -> 'operator_review';
  v_safety := v_confirmation_payload -> 'safety_contract';
  v_decisions := v_confirmation_payload -> 'decisions';

  if private.stage1_jsonb_has_exact_keys(v_operator_review, array[
      'reviewed_at', 'statement', 'statement_sha256'
    ]) is not true
    or nullif(pg_catalog.btrim(v_operator_review ->> 'statement'), '') is null
    or private.stage1_text_sha256(v_operator_review ->> 'statement')
      is distinct from v_operator_review ->> 'statement_sha256'
    or coalesce(v_operator_review ->> 'statement_sha256', '') !~ '^[0-9a-f]{64}$'
    or v_operator_review ->> 'statement' is distinct from
      'Approve baseline-only for items 1–6 and 8–11. Keep item 7, Luce funding, quarantined. The other task is finished.'
  then
    raise exception using errcode = '22023',
      message = 'The exact operator approval statement and hash are required.';
  end if;

  if private.stage1_jsonb_has_exact_keys(v_safety, array[
      'approve_baseline_only_count',
      'database_writes_during_preview',
      'exact_request_count',
      'fact_candidates',
      'first_observation_notifications',
      'keep_quarantined_count',
      'paid_api_calls',
      'public_fact_writes',
      'reconciliation_requests',
      'source_activation_before_visual_baseline'
    ]) is not true
    or v_safety -> 'exact_request_count' is distinct from '11'::jsonb
    or v_safety -> 'approve_baseline_only_count' is distinct from '10'::jsonb
    or v_safety -> 'keep_quarantined_count' is distinct from '1'::jsonb
    or v_safety -> 'paid_api_calls' is distinct from '0'::jsonb
    or v_safety -> 'database_writes_during_preview' is distinct from '0'::jsonb
    or v_safety -> 'public_fact_writes' is distinct from '0'::jsonb
    or v_safety -> 'fact_candidates' is distinct from '0'::jsonb
    or v_safety -> 'reconciliation_requests' is distinct from '0'::jsonb
    or v_safety -> 'first_observation_notifications' is distinct from '0'::jsonb
    or v_safety -> 'source_activation_before_visual_baseline'
      is distinct from '0'::jsonb
    or pg_catalog.jsonb_array_length(v_decisions) <> 11
  then
    raise exception using errcode = '22023',
      message = 'The Stage 1 source disposition safety contract must be exactly 10 approved, one quarantined, and zero paid/public/downstream work.';
  end if;

  begin
    v_built_at := (p_binding ->> 'built_at')::timestamptz;
    v_apply_not_after := (p_binding ->> 'apply_not_after')::timestamptz;
    v_rows_observed_at := (v_confirmation_payload ->> 'rows_observed_at')::timestamptz;
    v_reviewed_at := (v_operator_review ->> 'reviewed_at')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = '22023',
      message = 'Stage 1 source disposition timestamps are invalid.';
  end;

  if v_built_at > v_now + interval '5 minutes'
    or v_built_at < v_now - interval '5 minutes'
    or v_apply_not_after <= v_built_at
    or v_apply_not_after is distinct from v_reviewed_at + interval '24 hours'
    or v_now > v_apply_not_after
    or v_reviewed_at is distinct from
      '2026-08-03T17:17:45.549Z'::timestamptz
    or v_rows_observed_at > v_now + interval '5 minutes'
    or v_rows_observed_at < v_now - interval '5 minutes'
    or pg_catalog.abs(
      extract(epoch from (v_built_at - v_rows_observed_at))
    ) > 300
  then
    raise exception using errcode = '22023',
      message = 'The Stage 1 source disposition review window or production observation is stale.';
  end if;

  if v_decisions is distinct from (
    select pg_catalog.jsonb_agg(decision.value order by (decision.value ->> 'item_number')::integer)
    from pg_catalog.jsonb_array_elements(v_decisions) decision(value)
  )
    or (select pg_catalog.count(distinct (decision.value ->> 'item_number')::integer)
        from pg_catalog.jsonb_array_elements(v_decisions) decision(value)) <> 11
    or (select pg_catalog.count(distinct decision.value ->> 'request_id')
        from pg_catalog.jsonb_array_elements(v_decisions) decision(value)) <> 11
  then
    raise exception using errcode = '22023',
      message = 'Stage 1 source decisions must be unique and ordered by the exact packet item number.';
  end if;

  -- Use the same release-lock order as Stage 1 source mutation triggers, then
  -- serialize exact replays by the human confirmation hash.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_confirmation_sha256, 0)
  );

  select bundle.* into v_existing_bundle
  from private.stage1_source_disposition_bundles bundle
  where bundle.confirmation_sha256 = p_confirmation_sha256;
  if found then
    if v_existing_bundle.bundle_sha256 is distinct from v_bundle_sha256
      or v_existing_bundle.full_plan is distinct from p_binding
      or v_existing_bundle.confirmation_payload is distinct from v_confirmation_payload
      or v_existing_bundle.policy_version is distinct from p_binding ->> 'policy_version'
    then
      raise exception using errcode = '40001',
        message = 'A Stage 1 source disposition confirmation collides with different durable proof.';
    end if;
    return v_existing_bundle.receipt;
  end if;

  perform request.id
  from public.source_page_requests request
  where request.id in (
    select (decision.value ->> 'request_id')::uuid
    from pg_catalog.jsonb_array_elements(v_decisions) decision(value)
  )
  order by request.id
  for update;
  get diagnostics v_count = row_count;
  if v_count <> 11 then
    raise exception using errcode = '40001',
      message = 'The exact eleven reviewed Stage 1 source requests are no longer present.';
  end if;

  -- Set only a transaction-local audit marker. The source trigger still makes
  -- every retained approval immutable after it first appears.
  perform pg_catalog.set_config(
    'awardping.stage1_source_disposition_confirmation',
    p_confirmation_sha256,
    true
  );

  for v_decision in
    select decision.value
    from pg_catalog.jsonb_array_elements(v_decisions) decision(value)
    order by (decision.value ->> 'item_number')::integer
  loop
    if private.stage1_jsonb_has_exact_keys(v_decision, array[
        'acquisition_binding',
        'acquisition_payload',
        'decision',
        'decision_item_sha256',
        'effective_source_classification',
        'exact_quotes',
        'expected_request_binding',
        'item_number',
        'provider_binding',
        'request_id',
        'request_patch',
        'retained_evidence',
        'reviewed_role_binding',
        'source_binding',
        'source_payload'
      ]) is not true
      or coalesce(v_decision ->> 'decision_item_sha256', '') !~ '^[0-9a-f]{64}$'
      or private.stage1_canonical_json_sha256(
        v_decision
          - 'decision_item_sha256'
          - 'source_payload'
          - 'acquisition_payload'
          - 'request_patch'
      )
        is distinct from v_decision ->> 'decision_item_sha256'
      or pg_catalog.jsonb_typeof(v_decision -> 'exact_quotes') is distinct from 'array'
      or pg_catalog.jsonb_typeof(v_decision -> 'expected_request_binding')
        is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_decision -> 'reviewed_role_binding')
        is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_decision -> 'provider_binding')
        is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_decision -> 'retained_evidence')
        is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_decision -> 'effective_source_classification')
        is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_decision -> 'source_binding')
        is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_decision -> 'source_payload')
        is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_decision -> 'acquisition_binding')
        is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_decision -> 'acquisition_payload')
        is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_decision -> 'request_patch')
        is distinct from 'object'
    then
      raise exception using errcode = '22023',
        message = 'A Stage 1 source disposition item is malformed or its canonical hash differs.';
    end if;

    begin
      v_item_number := (v_decision ->> 'item_number')::integer;
      v_request_id := (v_decision ->> 'request_id')::uuid;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '22023',
        message = 'A Stage 1 source disposition item number or request UUID is invalid.';
    end;

    select expected.* into v_expected
    from (values
      (1, '62a291a2-e64d-5788-a876-f2dca551a021'::uuid,
        'approve_baseline_only'::text,
        '26b5b55f-57e9-42a7-ae4c-37d389c5e70c'::uuid,
        'cycle_relevance_unclear'::text,
        '["funding"]'::jsonb, null::uuid),
      (2, 'cc190ad2-8240-5b8c-b5ac-a73180094d24'::uuid,
        'approve_baseline_only'::text,
        '26b5b55f-57e9-42a7-ae4c-37d389c5e70c'::uuid,
        'cycle_relevance_unclear'::text,
        '["faq"]'::jsonb, null::uuid),
      (3, '2bd3018c-d1b6-5d39-85ed-ea278e9d3702'::uuid,
        'approve_baseline_only'::text,
        '26b5b55f-57e9-42a7-ae4c-37d389c5e70c'::uuid,
        'cycle_relevance_unclear'::text,
        '["application_materials"]'::jsonb, null::uuid),
      (4, 'e01d9d33-47de-5ba9-b83c-d6e7c69a4c7f'::uuid,
        'approve_baseline_only'::text,
        '0695c116-1151-4b68-997e-93df400734dd'::uuid,
        'missing_evidence_quotes'::text,
        '["application_materials","current_documents","dates_cycle","eligibility","faq","funding","selection_interviews"]'::jsonb,
        null::uuid),
      (5, '27ad713b-0332-59e6-b28b-44b9ff631bc1'::uuid,
        'approve_baseline_only'::text,
        '5dd1afc1-a560-495a-9bee-1f26f835475b'::uuid,
        'missing_evidence_quotes'::text,
        '["selection_interviews"]'::jsonb, null::uuid),
      (6, 'fd02cb92-8ab6-553f-8e31-752802ac4641'::uuid,
        'approve_baseline_only'::text,
        '4d2f6a7f-024e-4194-be31-1b9f63e497bc'::uuid,
        'cycle_relevance_unclear'::text,
        '["identity_home"]'::jsonb, null::uuid),
      (7, 'b7dd586b-ac5e-5da7-abe7-8478a353b865'::uuid,
        'keep_quarantined'::text,
        'a643d94e-216b-4449-bf2f-99d8503793d7'::uuid,
        'missing_evidence_quotes'::text,
        '["funding"]'::jsonb, null::uuid),
      (8, 'a97507bf-295a-5a81-99e5-4516f96c9612'::uuid,
        'approve_baseline_only'::text,
        'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid,
        'cycle_relevance_unclear'::text,
        '["identity_home"]'::jsonb,
        'fa4088a7-706e-4ad3-ae12-3653751dd5e1'::uuid),
      (9, '2cd2f427-753f-5de7-ab0b-616502b287b7'::uuid,
        'approve_baseline_only'::text,
        '406c12bc-49f3-4d4c-b90d-9ba7e4e0f70e'::uuid,
        'missing_evidence_quotes'::text,
        '["funding","identity_home"]'::jsonb, null::uuid),
      (10, 'cf731f52-f02d-581e-bf52-c698f53d87d8'::uuid,
        'approve_baseline_only'::text,
        'dd23afbb-299e-489f-8a0b-e4d7506848de'::uuid,
        'missing_evidence_quotes'::text,
        '["current_documents"]'::jsonb, null::uuid),
      (11, '4952d327-4fa5-53a0-8247-dd029f7f2c2c'::uuid,
        'approve_baseline_only'::text,
        '2da1b35d-fe8b-46cd-bc4b-b099e0fd1363'::uuid,
        'cycle_relevance_unclear'::text,
        '["faq","funding","selection_interviews"]'::jsonb, null::uuid)
    ) expected(
      item_number,
      request_id,
      decision,
      shared_award_id,
      request_status_reason,
      reviewed_roles,
      expected_existing_source_id
    )
    where expected.item_number = v_item_number;

    if not found
      or v_request_id is distinct from v_expected.request_id
      or v_decision ->> 'decision' is distinct from v_expected.decision
    then
      raise exception using errcode = '22023',
        message = 'The disposition does not contain the exact approved 10+1 request decisions.';
    end if;

    v_award_id := v_expected.shared_award_id;
    v_decision_name := v_expected.decision;
    v_expected_status_reason := v_expected.request_status_reason;
    v_expected_roles := v_expected.reviewed_roles;
    v_expected_existing_source_id := v_expected.expected_existing_source_id;
    v_item_sha256 := v_decision ->> 'decision_item_sha256';
    v_request_binding := v_decision -> 'expected_request_binding';
    v_role_binding := v_decision -> 'reviewed_role_binding';
    v_provider_binding := v_decision -> 'provider_binding';
    v_retained_evidence := v_decision -> 'retained_evidence';
    v_classification := v_decision -> 'effective_source_classification';
    v_source_binding := v_decision -> 'source_binding';
    v_source_payload := v_decision -> 'source_payload';
    v_acquisition_binding := v_decision -> 'acquisition_binding';
    v_acquisition_payload := v_decision -> 'acquisition_payload';
    v_request_patch := v_decision -> 'request_patch';

    select request.* into strict v_request
    from public.source_page_requests request
    where request.id = v_request_id;

    if private.stage1_jsonb_has_exact_keys(v_request_binding, array[
        'acquisition_kind',
        'capture_file_sha256',
        'capture_text_sha256',
        'matched_shared_award_id',
        'normalized_url',
        'notification_mode',
        'onboarding_batch_id',
        'status',
        'status_reason',
        'updated_at'
      ]) is not true
      or v_request_binding ->> 'status' is distinct from 'needs_manual_review'
      or v_request_binding ->> 'status_reason' is distinct from v_expected_status_reason
      or (v_request_binding ->> 'updated_at')::timestamptz
        is distinct from v_request.updated_at
      or v_request_binding ->> 'matched_shared_award_id' is distinct from v_award_id::text
      or v_request_binding ->> 'normalized_url' is distinct from v_request.normalized_url
      or v_request_binding ->> 'acquisition_kind' is distinct from 'historical_import'
      or v_request_binding ->> 'notification_mode' is distinct from 'baseline_only'
      or v_request_binding ->> 'onboarding_batch_id' is distinct from
        'stage1-national-25-reviewed-sources-v1'
      or v_request.status is distinct from 'needs_manual_review'
      or v_request.status_reason is distinct from v_expected_status_reason
      or v_request.matched_shared_award_id is distinct from v_award_id
      or v_request.acquisition_kind is distinct from 'historical_import'
      or v_request.notification_mode is distinct from 'baseline_only'
      or v_request.onboarding_batch_id is distinct from
        'stage1-national-25-reviewed-sources-v1'
      or v_request.created_shared_award_id is not null
      or coalesce(pg_catalog.cardinality(v_request.created_source_ids), 0) <> 0
      or v_request_binding ->> 'capture_file_sha256' is distinct from
        v_request.capture_metadata ->> 'capture_file_hash'
      or v_request_binding ->> 'capture_text_sha256' is distinct from
        v_request.capture_metadata -> 'retained_artifact' ->> 'text_hash'
    then
      raise exception using errcode = '40001',
        message = 'A reviewed Stage 1 source request changed after the evidence packet was prepared.';
    end if;

    if private.stage1_jsonb_has_exact_keys(v_role_binding, array[
        'monitor_only_roles', 'onboarding_evidence_sha256', 'reviewed_roles'
      ]) is not true
      or v_role_binding -> 'reviewed_roles' is distinct from v_expected_roles
      or private.stage1_source_roles_valid(v_role_binding -> 'reviewed_roles') is not true
      or pg_catalog.jsonb_typeof(v_role_binding -> 'monitor_only_roles')
        is distinct from 'array'
      or v_role_binding ->> 'onboarding_evidence_sha256' is distinct from
        v_request.ai_review #>> array[
          'reviewed_source_onboarding_evidence', 'evidence_sha256'
        ]
      or v_expected_roles is distinct from (
        select pg_catalog.jsonb_agg(role.value order by role.value #>> '{}')
        from pg_catalog.jsonb_array_elements(
          v_request.ai_review #> array[
            'reviewed_source_onboarding_evidence', 'reviewed_roles'
          ]
        ) role(value)
      )
      or v_role_binding -> 'monitor_only_roles' is distinct from
        coalesce(
          v_request.ai_review #> array[
            'reviewed_source_onboarding_evidence', 'monitor_only_roles'
          ],
          '[]'::jsonb
        )
    then
      raise exception using errcode = '40001',
        message = 'A reviewed Stage 1 source-role or onboarding-evidence binding changed.';
    end if;

    if private.stage1_jsonb_has_exact_keys(v_provider_binding, array[
        'input_digest_sha256',
        'model',
        'provider_batch_name',
        'provider_batch_request_key',
        'provider_result_sha256',
        'result_digest_sha256'
      ]) is not true
      or v_provider_binding ->> 'input_digest_sha256' is distinct from
        v_request.ai_review #>> array['provider_input_binding', 'digest_sha256']
      or v_provider_binding ->> 'result_digest_sha256' is distinct from
        v_request.ai_review #>> array['provider_result_binding', 'digest_sha256']
      or v_provider_binding ->> 'provider_result_sha256' is distinct from
        v_request.ai_review #>> array['provider_result_binding', 'provider_result_sha256']
      or v_provider_binding ->> 'provider_result_sha256' is distinct from
        private.stage1_canonical_json_sha256(v_request.ai_review -> 'raw')
      or v_provider_binding ->> 'model' is distinct from
        v_request.ai_review #>> array['provider_result_binding', 'model']
      or v_provider_binding ->> 'provider_batch_name' is distinct from
        v_request.ai_review #>> array['provider_result_binding', 'provider_batch_name']
      or v_provider_binding ->> 'provider_batch_request_key' is distinct from
        v_request.ai_review #>> array[
          'provider_result_binding', 'provider_batch_request_key'
        ]
      or v_provider_binding ->> 'provider_batch_request_key'
        is distinct from v_request_id::text
      or v_request.ai_review #>> array[
        'provider_result_binding', 'input_digest_sha256'
      ] is distinct from v_request.ai_review #>> array[
        'provider_input_binding', 'digest_sha256'
      ]
      or coalesce(v_provider_binding ->> 'input_digest_sha256', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_provider_binding ->> 'result_digest_sha256', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_provider_binding ->> 'provider_result_sha256', '') !~ '^[0-9a-f]{64}$'
    then
      raise exception using errcode = '40001',
        message = 'A Stage 1 source provider input/result binding changed or is incomplete.';
    end if;

    if private.stage1_jsonb_has_exact_keys(v_retained_evidence, array[
        'capture_file_sha256',
        'captured_at',
        'final_url',
        'normalized_text_sha256',
        'text_artifact'
      ]) is not true
      or private.stage1_jsonb_has_exact_keys(
        v_retained_evidence -> 'text_artifact',
        array['bucket', 'bytes', 'key', 'r2_verified_at', 'sha256', 'store_id']
      ) is not true
      or v_retained_evidence ->> 'capture_file_sha256' is distinct from
        v_request.capture_metadata ->> 'capture_file_hash'
      or v_retained_evidence ->> 'normalized_text_sha256' is distinct from
        v_request.capture_metadata -> 'retained_artifact' ->> 'text_hash'
      or v_retained_evidence ->> 'final_url' is distinct from
        coalesce(
          v_request.capture_metadata ->> 'canonical_url',
          v_request.capture_metadata ->> 'final_url',
          v_request.capture_metadata -> 'retained_artifact' ->> 'final_url'
        )
      or v_retained_evidence ->> 'final_url' is distinct from
        v_request.normalized_url
      or (v_retained_evidence ->> 'captured_at')::timestamptz is distinct from
        coalesce(
          nullif(v_request.capture_metadata ->> 'captured_at', '')::timestamptz,
          nullif(v_request.capture_metadata -> 'retained_artifact' ->> 'captured_at', '')::timestamptz
        )
      or v_retained_evidence -> 'text_artifact' ->> 'bucket' is distinct from
        v_request.capture_metadata -> 'retained_artifact' ->> 'r2_bucket'
      or v_retained_evidence -> 'text_artifact' ->> 'store_id' is distinct from
        v_request.capture_metadata -> 'retained_artifact' ->> 'r2_store_id'
      or (v_retained_evidence -> 'text_artifact' ->> 'r2_verified_at')::timestamptz
        is distinct from
        (v_request.capture_metadata -> 'retained_artifact' ->> 'r2_verified_at')::timestamptz
      or v_retained_evidence -> 'text_artifact' ->> 'key' is distinct from
        v_request.capture_metadata #>> array[
          'retained_artifact', 'artifacts', 'text', 'key'
        ]
      or v_retained_evidence -> 'text_artifact' ->> 'sha256' is distinct from
        v_request.capture_metadata #>> array[
          'retained_artifact', 'artifacts', 'text', 'sha256'
        ]
      or (v_retained_evidence -> 'text_artifact' ->> 'bytes')::bigint
        is distinct from
        (v_request.capture_metadata #>> array[
          'retained_artifact', 'artifacts', 'text', 'byte_length'
        ])::bigint
      or v_retained_evidence -> 'text_artifact' ->> 'key' is distinct from
        'source-intake-first-observation/v1/requests/' || v_request_id::text ||
        '/sha256/' || (v_retained_evidence ->> 'capture_file_sha256') || '/text.txt'
      or coalesce(v_retained_evidence ->> 'normalized_text_sha256', '') !~
        '^[0-9a-f]{64}$'
    then
      raise exception using errcode = '40001',
        message = 'A Stage 1 retained capture or immutable R2 text artifact binding changed.';
    end if;

    v_expected_quotes := case v_item_number
      when 1 then pg_catalog.jsonb_build_array(
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 317, 133),
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 2737, 156)
      )
      when 2 then pg_catalog.jsonb_build_array(
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 153, 243),
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 1674, 138)
      )
      when 3 then pg_catalog.jsonb_build_array(
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 81, 91),
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 289, 175)
      )
      when 4 then pg_catalog.jsonb_build_array(
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 701, 178),
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 14405, 476),
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 17076, 77)
      )
      when 5 then pg_catalog.jsonb_build_array(
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 3753, 108),
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 7450, 134)
      )
      when 6 then pg_catalog.jsonb_build_array(
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 63, 73),
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 241, 205)
      )
      when 7 then pg_catalog.jsonb_build_array(
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 86, 177),
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 547, 165),
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 1381, 49)
      )
      when 8 then pg_catalog.jsonb_build_array(
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 1509, 292)
      )
      when 9 then pg_catalog.jsonb_build_array(
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 84, 64),
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 672, 151)
      )
      when 10 then pg_catalog.jsonb_build_array(
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 107, 99),
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 8090, 153)
      )
      when 11 then pg_catalog.jsonb_build_array(
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 2026, 154),
        pg_catalog.substr(v_request.capture_metadata ->> 'text', 6389, 81)
      )
    end;

    if v_decision -> 'exact_quotes' is distinct from v_expected_quotes
      or pg_catalog.jsonb_array_length(v_decision -> 'exact_quotes') < 1
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(v_decision -> 'exact_quotes') quote(value)
        where pg_catalog.jsonb_typeof(quote.value) <> 'string'
          or nullif(pg_catalog.btrim(quote.value #>> '{}'), '') is null
          or pg_catalog.strpos(
            coalesce(v_request.capture_metadata ->> 'text', ''),
            quote.value #>> '{}'
          ) = 0
      )
      or (
        select pg_catalog.count(*) <> pg_catalog.count(distinct quote.value #>> '{}')
        from pg_catalog.jsonb_array_elements(v_decision -> 'exact_quotes') quote(value)
      )
    then
      raise exception using errcode = '23514',
        message = 'Every reviewed Stage 1 source quote must be a unique exact retained-text substring.';
    end if;

    if private.stage1_jsonb_has_exact_keys(v_classification, array[
        'confidence',
        'cycle_relevance',
        'evidence_quotes',
        'exact_evidence_verified',
        'facts',
        'officialness',
        'page_type',
        'reviewed_roles',
        'source_relevance',
        'status'
      ]) is not true
      or v_classification -> 'evidence_quotes' is distinct from
        v_decision -> 'exact_quotes'
      or v_classification -> 'reviewed_roles' is distinct from v_expected_roles
      or v_classification -> 'exact_evidence_verified' is distinct from 'true'::jsonb
      or v_classification ->> 'status' is distinct from (case
        when v_decision_name = 'approve_baseline_only' then 'accepted'
        else 'needs_review'
      end)
      or v_classification ->> 'source_relevance' is distinct from
        v_request.ai_review ->> 'source_relevance'
      or v_classification ->> 'officialness' is distinct from
        v_request.ai_review ->> 'officialness'
      or v_classification ->> 'confidence' is distinct from
        v_request.ai_review ->> 'confidence'
      or v_classification ->> 'cycle_relevance' is distinct from (case
        when v_item_number in (1, 2, 3, 6, 7, 8, 11) then 'evergreen'
        else 'current_or_upcoming'
      end)
      or v_classification ->> 'page_type' is distinct from (case v_item_number
        when 1 then 'other'
        when 2 then 'faq'
        when 3 then 'application'
        when 4 then 'eligibility'
        when 5 then 'application'
        when 6 then 'homepage'
        when 7 then 'other'
        when 8 then 'homepage'
        when 9 then 'homepage'
        when 10 then 'pdf'
        when 11 then 'faq'
      end)
      or private.stage1_jsonb_has_exact_keys(v_classification -> 'facts', array[
        'amount',
        'application_materials',
        'deadline',
        'description',
        'eligibility',
        'important_dates'
      ]) is not true
      or v_classification -> 'facts' -> 'amount' is distinct from 'null'::jsonb
      or v_classification -> 'facts' -> 'deadline' is distinct from 'null'::jsonb
      or v_classification -> 'facts' -> 'description' is distinct from 'null'::jsonb
      or v_classification -> 'facts' -> 'application_materials'
        is distinct from '[]'::jsonb
      or v_classification -> 'facts' -> 'eligibility'
        is distinct from '[]'::jsonb
      or v_classification -> 'facts' -> 'important_dates'
        is distinct from '[]'::jsonb
    then
      raise exception using errcode = '23514',
        message = 'The effective human source classification does not match its exact reviewed roles and quotes.';
    end if;

    if private.stage1_jsonb_has_exact_keys(v_source_binding, array[
        'expected_existing_admin_review_status',
        'expected_existing_source_id',
        'expected_existing_updated_at',
        'normalized_collision_count',
        'normalized_url',
        'source_id'
      ]) is not true
      or v_source_binding ->> 'normalized_url' is distinct from v_request.normalized_url
      or pg_catalog.jsonb_typeof(v_source_binding -> 'normalized_collision_count')
        is distinct from 'number'
    then
      raise exception using errcode = '22023',
        message = 'The reviewed Stage 1 source identity binding is malformed.';
    end if;

    perform source.id
    from public.shared_award_sources source
    where source.shared_award_id = v_award_id
      and pg_catalog.lower(
        pg_catalog.regexp_replace(
          pg_catalog.split_part(source.url, '#', 1), '/+$', ''
        )
      ) = pg_catalog.lower(
        pg_catalog.regexp_replace(
          pg_catalog.split_part(v_request.normalized_url, '#', 1), '/+$', ''
        )
      )
    order by source.id
    for update;

    select
      pg_catalog.count(*),
      (pg_catalog.array_agg(source.id order by source.id))[1]
    into v_count, v_existing_source_id
    from public.shared_award_sources source
    where source.shared_award_id = v_award_id
      and pg_catalog.lower(
        pg_catalog.regexp_replace(
          pg_catalog.split_part(source.url, '#', 1), '/+$', ''
        )
      ) = pg_catalog.lower(
        pg_catalog.regexp_replace(
          pg_catalog.split_part(v_request.normalized_url, '#', 1), '/+$', ''
        )
      );

    if v_count is distinct from (v_source_binding ->> 'normalized_collision_count')::integer
      or v_count is distinct from (case
        when v_expected_existing_source_id is null then 0 else 1
      end)
      or v_existing_source_id is distinct from v_expected_existing_source_id
      or nullif(v_source_binding ->> 'expected_existing_source_id', '')::uuid
        is distinct from v_expected_existing_source_id
    then
      raise exception using errcode = '40001',
        message = 'A normalized Stage 1 source identity collision changed before disposition apply.';
    end if;

    if v_expected_existing_source_id is not null then
      select source.* into strict v_source
      from public.shared_award_sources source
      where source.id = v_expected_existing_source_id;
      if v_source.shared_award_id is distinct from v_award_id
        or v_source.url is distinct from 'https://ndseg.org/'
        or v_source.admin_review_status is distinct from 'review_later'
        or v_source.updated_at is distinct from
          nullif(v_source_binding ->> 'expected_existing_updated_at', '')::timestamptz
        or v_source_binding ->> 'expected_existing_admin_review_status'
          is distinct from 'review_later'
      then
        raise exception using errcode = '40001',
          message = 'The exact existing NDSEG canonical source changed before reviewed activation.';
      end if;
      v_source_id := v_expected_existing_source_id;
    elsif v_decision_name = 'approve_baseline_only' then
      v_source_id := private.stage1_source_disposition_uuid('source', v_request_id);
      if nullif(v_source_binding ->> 'source_id', '')::uuid is distinct from v_source_id
        or v_source_binding -> 'expected_existing_source_id' is distinct from 'null'::jsonb
        or v_source_binding -> 'expected_existing_admin_review_status' is distinct from 'null'::jsonb
        or v_source_binding -> 'expected_existing_updated_at' is distinct from 'null'::jsonb
      then
        raise exception using errcode = '22023',
          message = 'A new Stage 1 source does not carry its deterministic no-collision identity.';
      end if;
    else
      v_source_id := null;
      if v_source_binding -> 'source_id' is distinct from 'null'::jsonb
        or v_source_binding -> 'expected_existing_source_id' is distinct from 'null'::jsonb
        or v_source_binding -> 'expected_existing_admin_review_status' is distinct from 'null'::jsonb
        or v_source_binding -> 'expected_existing_updated_at' is distinct from 'null'::jsonb
      then
        raise exception using errcode = '22023',
          message = 'The quarantined Luce decision must not bind or create a source.';
      end if;
    end if;

    if private.stage1_jsonb_has_exact_keys(v_acquisition_binding, array[
        'expected_existing_acquisition_count',
        'expected_existing_acquisition_id',
        'source_acquisition_id'
      ]) is not true
      or v_acquisition_binding -> 'expected_existing_acquisition_count'
        is distinct from '0'::jsonb
      or v_acquisition_binding -> 'expected_existing_acquisition_id'
        is distinct from 'null'::jsonb
    then
      raise exception using errcode = '22023',
        message = 'Every reviewed Stage 1 source must begin without an acquisition.';
    end if;

    if v_decision_name = 'approve_baseline_only' then
      v_acquisition_id := private.stage1_source_disposition_uuid(
        'acquisition', v_request_id
      );
      if nullif(v_acquisition_binding ->> 'source_acquisition_id', '')::uuid
        is distinct from v_acquisition_id
      then
        raise exception using errcode = '22023',
          message = 'An approved Stage 1 source does not carry its deterministic acquisition identity.';
      end if;
      if exists (
        select 1
        from public.shared_award_source_acquisitions acquisition
        where acquisition.shared_award_source_id = v_source_id
          or acquisition.id = v_acquisition_id
      ) then
        raise exception using errcode = '40001',
          message = 'A Stage 1 source acquisition appeared after the reviewed production snapshot.';
      end if;
    else
      v_acquisition_id := null;
      if v_acquisition_binding -> 'source_acquisition_id' is distinct from 'null'::jsonb then
        raise exception using errcode = '22023',
          message = 'The quarantined Luce decision must not carry an acquisition identity.';
      end if;
    end if;

    if v_decision_name = 'approve_baseline_only' then
      if private.stage1_jsonb_has_exact_keys(v_source_payload, array[
          'confidence',
          'consecutive_failures',
          'display_title',
          'id',
          'last_error',
          'page_description',
          'page_metadata',
          'page_metadata_generated_at',
          'page_metadata_model',
          'page_type',
          'reason',
          'shared_award_id',
          'source',
          'submitted_by_user_id',
          'title',
          'url'
        ]) is not true
        or nullif(v_source_payload ->> 'id', '')::uuid is distinct from v_source_id
        or nullif(v_source_payload ->> 'shared_award_id', '')::uuid is distinct from v_award_id
        or v_source_payload ->> 'url' is distinct from v_request.normalized_url
        or nullif(pg_catalog.btrim(v_source_payload ->> 'title'), '') is null
        or v_source_payload ->> 'page_type' not in (
          'homepage', 'deadline', 'application', 'eligibility', 'requirements',
          'pdf', 'faq', 'other'
        )
        or pg_catalog.jsonb_typeof(v_source_payload -> 'confidence') is distinct from 'number'
        or (v_source_payload ->> 'confidence')::numeric < 0
        or (v_source_payload ->> 'confidence')::numeric > 1
        or v_source_payload ->> 'source' not in ('seed', 'admin')
        or nullif(v_source_payload ->> 'submitted_by_user_id', '')::uuid
          is distinct from v_request.user_id
        or pg_catalog.jsonb_typeof(v_source_payload -> 'page_metadata')
          is distinct from 'object'
        or (v_source_payload ->> 'page_metadata_generated_at')::timestamptz
          is distinct from v_built_at
        or nullif(pg_catalog.btrim(v_source_payload ->> 'page_metadata_model'), '') is null
        or v_source_payload ->> 'page_metadata_model' is distinct from
          'stage1-baseline-source-disposition-v1'
        or v_source_payload -> 'last_error' is distinct from 'null'::jsonb
        or v_source_payload -> 'consecutive_failures' is distinct from '0'::jsonb
      then
        raise exception using errcode = '23514',
          message = 'An approved Stage 1 source payload is incomplete or broader than the reviewed source identity.';
      end if;

      v_monitoring_approval := v_source_payload #> array[
        'page_metadata', 'stage1_baseline_monitoring_approval'
      ];
      if private.stage1_monitoring_approval_valid(
        v_monitoring_approval,
        v_source_id,
        v_request_id,
        v_confirmation_payload ->> 'evidence_packet_sha256',
        v_item_sha256,
        v_expected_roles
      ) is not true
      then
        raise exception using errcode = '23514',
          message = 'The source monitoring-only approval is missing, malformed, or grants fact authority.';
      end if;

      if v_expected_existing_source_id is null then
        if v_source_payload ->> 'source' is distinct from 'admin' then
          raise exception using errcode = '23514',
            message = 'New reviewed Stage 1 sources require admin provenance.';
        end if;
        if private.stage1_jsonb_has_exact_keys(
          v_source_payload -> 'page_metadata',
          array['stage1_baseline_monitoring_approval']
        ) is not true then
          raise exception using errcode = '23514',
            message = 'A new Stage 1 source may carry only its monitoring-only approval metadata.';
        end if;
        insert into public.shared_award_sources (
          id,
          shared_award_id,
          url,
          title,
          display_title,
          page_description,
          page_type,
          confidence,
          reason,
          source,
          submitted_by_user_id,
          admin_review_status,
          admin_review_note,
          admin_reviewed_at,
          admin_reviewed_by,
          page_metadata,
          page_metadata_generated_at,
          page_metadata_model,
          last_error,
          consecutive_failures,
          updated_at
        ) values (
          v_source_id,
          v_award_id,
          v_source_payload ->> 'url',
          v_source_payload ->> 'title',
          nullif(v_source_payload ->> 'display_title', ''),
          nullif(v_source_payload ->> 'page_description', ''),
          v_source_payload ->> 'page_type',
          (v_source_payload ->> 'confidence')::numeric,
          nullif(v_source_payload ->> 'reason', ''),
          v_source_payload ->> 'source',
          nullif(v_source_payload ->> 'submitted_by_user_id', '')::uuid,
          'review_later',
          'approved_pending_exact_first_visual_baseline',
          v_now,
          'stage1-baseline-source-disposition',
          v_source_payload -> 'page_metadata',
          (v_source_payload ->> 'page_metadata_generated_at')::timestamptz,
          v_source_payload ->> 'page_metadata_model',
          null,
          0,
          v_now
        )
        returning * into v_source;
        if not found then
          raise exception using errcode = '40001',
            message = 'The reviewed Stage 1 source insert was suppressed by a concurrent source policy.';
        end if;
        v_source_inserted := true;
      else
        if v_source_payload ->> 'source' is distinct from v_source.source
          or v_source_payload ->> 'title' is distinct from v_source.title
          or nullif(v_source_payload ->> 'display_title', '')
            is distinct from v_source.display_title
          or nullif(v_source_payload ->> 'page_description', '')
            is distinct from v_source.page_description
          or v_source_payload ->> 'page_type' is distinct from v_source.page_type
          or (v_source_payload ->> 'confidence')::numeric
            is distinct from v_source.confidence
          or nullif(v_source_payload ->> 'reason', '') is distinct from v_source.reason
          or nullif(v_source_payload ->> 'submitted_by_user_id', '')::uuid
            is distinct from v_source.submitted_by_user_id
          or v_source_payload -> 'page_metadata' is distinct from
            (
              coalesce(v_source.page_metadata, '{}'::jsonb)
                - 'baseline_facts'
                - 'baseline_facts_metadata'
            ) || pg_catalog.jsonb_build_object(
              'stage1_baseline_monitoring_approval', v_monitoring_approval
            )
        then
          raise exception using errcode = '40001',
            message = 'The NDSEG source payload differs from the exact existing row plus monitoring-only approval.';
        end if;

        update public.shared_award_sources source
        set
          admin_review_status = 'review_later',
          admin_review_note = 'approved_pending_exact_first_visual_baseline',
          admin_reviewed_at = v_now,
          admin_reviewed_by = 'stage1-baseline-source-disposition',
          page_metadata = v_source_payload -> 'page_metadata',
          page_metadata_generated_at =
            (v_source_payload ->> 'page_metadata_generated_at')::timestamptz,
          page_metadata_model = v_source_payload ->> 'page_metadata_model',
          last_error = null,
          consecutive_failures = 0,
          updated_at = v_now
        where source.id = v_source_id
          and source.admin_review_status = 'review_later'
          and source.updated_at = v_source.updated_at
        returning source.* into v_source;
        if not found then
          raise exception using errcode = '40001',
            message = 'The exact NDSEG source compare-and-set activation hold failed.';
        end if;
        v_source_inserted := false;
      end if;

      if private.stage1_jsonb_has_exact_keys(v_acquisition_payload, array[
          'acquisition_kind',
          'id',
          'metadata',
          'notification_mode',
          'onboarding_batch_id',
          'origin_source_page_request_id',
          'origin_worker_run_id',
          'parent_shared_award_source_id',
          'review_seal',
          'shared_award_source_id'
        ]) is not true
        or nullif(v_acquisition_payload ->> 'id', '')::uuid
          is distinct from v_acquisition_id
        or nullif(v_acquisition_payload ->> 'shared_award_source_id', '')::uuid
          is distinct from v_source_id
        or v_acquisition_payload ->> 'acquisition_kind' is distinct from
          'historical_import'
        or v_acquisition_payload ->> 'notification_mode' is distinct from
          'baseline_only'
        or nullif(v_acquisition_payload ->> 'origin_source_page_request_id', '')::uuid
          is distinct from v_request_id
        or v_acquisition_payload -> 'origin_worker_run_id' is distinct from 'null'::jsonb
        or v_acquisition_payload -> 'parent_shared_award_source_id'
          is distinct from 'null'::jsonb
        or v_acquisition_payload ->> 'onboarding_batch_id' is distinct from
          'stage1-national-25-reviewed-sources-v1'
        or pg_catalog.jsonb_typeof(v_acquisition_payload -> 'review_seal')
          is distinct from 'object'
        or pg_catalog.jsonb_typeof(v_acquisition_payload -> 'metadata')
          is distinct from 'object'
        or private.stage1_jsonb_has_exact_keys(
          v_acquisition_payload -> 'metadata',
          array[
            'decision_item_sha256',
            'evidence_packet_sha256',
            'stage1_baseline_activation_required'
          ]
        ) is not true
        or v_acquisition_payload -> 'metadata' ->
          'stage1_baseline_activation_required' is distinct from 'true'::jsonb
        or v_acquisition_payload -> 'metadata' ->> 'decision_item_sha256'
          is distinct from v_item_sha256
        or v_acquisition_payload -> 'metadata' ->> 'evidence_packet_sha256'
          is distinct from v_confirmation_payload ->> 'evidence_packet_sha256'
      then
        raise exception using errcode = '23514',
          message = 'The reviewed Stage 1 acquisition payload is not exact historical baseline-only provenance.';
      end if;

      v_human_disposition := v_acquisition_payload #> array[
        'review_seal', 'human_source_disposition'
      ];
      if v_human_disposition -> 'effective_source_review'
          is distinct from v_classification
        or private.stage1_jsonb_has_exact_keys(
          v_acquisition_payload -> 'review_seal',
          array[
            'capture_file_hash',
            'capture_final_url',
            'human_source_disposition',
            'seal_sha256',
            'source_page_request_id'
          ]
        ) is not true
        or v_acquisition_payload -> 'review_seal' ->> 'source_page_request_id'
          is distinct from v_request_id::text
        or v_acquisition_payload -> 'review_seal' ->> 'capture_file_hash'
          is distinct from v_request.capture_metadata ->> 'capture_file_hash'
        or v_acquisition_payload -> 'review_seal' ->> 'capture_final_url'
          is distinct from v_retained_evidence ->> 'final_url'
        or private.stage1_human_source_disposition_valid(
          v_human_disposition,
          v_source_id,
          v_acquisition_id,
          v_request_id,
          v_confirmation_payload ->> 'evidence_packet_sha256',
          v_item_sha256,
          v_expected_roles,
          v_request.capture_metadata,
          v_retained_evidence ->> 'final_url'
        ) is not true
      then
        raise exception using errcode = '23514',
          message = 'The immutable acquisition lacks its exact human disposition and first-baseline activation guard.';
      end if;

      if private.stage1_canonical_json_sha256(
          (v_acquisition_payload -> 'review_seal') - 'seal_sha256'
        ) is distinct from v_acquisition_payload -> 'review_seal' ->> 'seal_sha256'
      then
        raise exception using errcode = '23514',
          message = 'The Stage 1 acquisition review seal hash is invalid.';
      end if;

      insert into public.shared_award_source_acquisitions (
        id,
        shared_award_source_id,
        acquisition_kind,
        notification_mode,
        origin_source_page_request_id,
        origin_worker_run_id,
        parent_shared_award_source_id,
        onboarding_batch_id,
        review_seal,
        metadata,
        acquired_at
      ) values (
        v_acquisition_id,
        v_source_id,
        'historical_import',
        'baseline_only',
        v_request_id,
        null,
        null,
        'stage1-national-25-reviewed-sources-v1',
        v_acquisition_payload -> 'review_seal',
        v_acquisition_payload -> 'metadata',
        v_now
      ) returning * into v_acquisition;
    else
      if v_source_payload <> '{}'::jsonb
        or v_acquisition_payload <> '{}'::jsonb
      then
        raise exception using errcode = '23514',
          message = 'The quarantined Luce decision may not carry source or acquisition payloads.';
      end if;
      v_source_inserted := false;
    end if;

    if private.stage1_jsonb_has_exact_keys(v_request_patch, array[
        'ai_review_patch',
        'created_shared_award_id',
        'created_source_ids',
        'preserve_provider_input_binding',
        'preserve_provider_raw',
        'preserve_provider_result_binding',
        'status',
        'status_reason',
        'worker_run_id'
      ]) is not true
      or v_request_patch -> 'worker_run_id' is distinct from 'null'::jsonb
      or v_request_patch -> 'created_shared_award_id' is distinct from 'null'::jsonb
      or v_request_patch -> 'preserve_provider_raw' is distinct from 'true'::jsonb
      or v_request_patch -> 'preserve_provider_input_binding'
        is distinct from 'true'::jsonb
      or v_request_patch -> 'preserve_provider_result_binding'
        is distinct from 'true'::jsonb
      or pg_catalog.jsonb_typeof(v_request_patch -> 'ai_review_patch')
        is distinct from 'object'
    then
      raise exception using errcode = '23514',
        message = 'The Stage 1 request patch is incomplete or could overwrite provider evidence.';
    end if;

    v_ai_review_patch := v_request_patch -> 'ai_review_patch';
    if v_decision_name = 'approve_baseline_only' then
      if v_request_patch ->> 'status' is distinct from 'added'
        or v_request_patch ->> 'status_reason' is distinct from
          'stage1_baseline_source_added_pending_exact_visual_activation'
        or v_request_patch -> 'created_source_ids' is distinct from
          pg_catalog.jsonb_build_array(v_source_id)
        or private.stage1_jsonb_has_exact_keys(v_ai_review_patch, array[
          'confidence',
          'cycle_relevance',
          'evidence_quotes',
          'exact_evidence_verified',
          'facts',
          'human_source_disposition',
          'officialness',
          'page_type',
          'reviewed_roles',
          'source_relevance',
          'status'
        ]) is not true
        or v_ai_review_patch - 'human_source_disposition'
          is distinct from v_classification
        or v_ai_review_patch -> 'human_source_disposition'
          is distinct from v_human_disposition
      then
        raise exception using errcode = '23514',
          message = 'An approved request patch must terminate intake while retaining the exact human monitoring disposition.';
      end if;
      v_approved_count := v_approved_count + 1;
    else
      if v_request_patch ->> 'status' is distinct from 'needs_manual_review'
        or v_request_patch ->> 'status_reason' is distinct from
          'stage1_human_source_quarantined_role_mismatch'
        or v_request_patch -> 'created_source_ids' is distinct from 'null'::jsonb
        or private.stage1_jsonb_has_exact_keys(
          v_ai_review_patch, array['human_quarantine']
        ) is not true
        or private.stage1_jsonb_has_exact_keys(
          v_ai_review_patch -> 'human_quarantine',
          array[
            'decision',
            'decision_item_sha256',
            'evidence_packet_sha256',
            'policy_version',
            'reviewed_roles'
          ]
        ) is not true
        or v_ai_review_patch -> 'human_quarantine' ->> 'decision'
          is distinct from 'keep_quarantined'
        or v_ai_review_patch -> 'human_quarantine' ->> 'decision_item_sha256'
          is distinct from v_item_sha256
        or v_ai_review_patch -> 'human_quarantine' ->> 'evidence_packet_sha256'
          is distinct from v_confirmation_payload ->> 'evidence_packet_sha256'
        or v_ai_review_patch -> 'human_quarantine' ->> 'policy_version'
          is distinct from 'stage1-baseline-source-disposition-v1'
        or v_ai_review_patch -> 'human_quarantine' -> 'reviewed_roles'
          is distinct from v_expected_roles
      then
        raise exception using errcode = '23514',
          message = 'The Luce request patch must preserve the exact durable human quarantine.';
      end if;
      v_quarantined_count := v_quarantined_count + 1;
    end if;

    update public.source_page_requests request
    set
      status = v_request_patch ->> 'status',
      status_reason = v_request_patch ->> 'status_reason',
      worker_run_id = null,
      created_shared_award_id = null,
      created_source_ids = case
        when v_decision_name = 'approve_baseline_only'
          then array[v_source_id]::uuid[]
        else null
      end,
      ai_review = request.ai_review || v_ai_review_patch,
      processed_at = case
        when v_decision_name = 'approve_baseline_only' then v_now
        else request.processed_at
      end,
      failed_at = case
        when v_decision_name = 'approve_baseline_only' then null
        else request.failed_at
      end,
      error = case
        when v_decision_name = 'approve_baseline_only' then null
        else request.error
      end,
      updated_at = v_now
    where request.id = v_request_id
      and request.status = 'needs_manual_review'
      and request.updated_at = v_request.updated_at
    returning request.* into v_request;
    if not found then
      raise exception using errcode = '40001',
        message = 'A Stage 1 source request changed before its exact compare-and-set update.';
    end if;

    if private.stage1_canonical_json_sha256(v_request.ai_review -> 'raw')
        is distinct from v_provider_binding ->> 'provider_result_sha256'
      or v_request.ai_review #>> array['provider_input_binding', 'digest_sha256']
        is distinct from v_provider_binding ->> 'input_digest_sha256'
      or v_request.ai_review #>> array['provider_result_binding', 'digest_sha256']
        is distinct from v_provider_binding ->> 'result_digest_sha256'
    then
      raise exception using errcode = '23514',
        message = 'The atomic request update did not preserve exact provider evidence.';
    end if;

    if v_decision_name = 'keep_quarantined' then
      v_quarantine_evidence := pg_catalog.jsonb_build_object(
        'schema_version', 'awardping.stage1.source-disposition-quarantine.v1',
        'policy_version', 'stage1-baseline-source-disposition-v1',
        'decision', 'keep_quarantined',
        'item_number', v_item_number,
        'request_id', v_request_id,
        'shared_award_id', v_award_id,
        'decision_item_sha256', v_item_sha256,
        'evidence_packet_sha256',
          v_confirmation_payload ->> 'evidence_packet_sha256',
        'reviewed_roles', v_expected_roles,
        'exact_quotes', v_decision -> 'exact_quotes',
        'effective_source_classification', v_classification,
        'provider_binding', v_provider_binding,
        'retained_evidence', v_retained_evidence,
        'public_fact_authority', false,
        'fact_candidate_authority', false,
        'retry_charge', 'none',
        'safe_action',
          'Retain Luce funding in quarantine until exact current-cycle funding evidence receives a new human review.'
      );

      select quarantine.* into v_existing_quarantine
      from public.manual_quarantine_registry quarantine
      where quarantine.quarantine_key =
        'stage1:source-intake:luce-funding:' || v_request_id::text
      for update;
      if found then
        if v_existing_quarantine.status is distinct from 'quarantined'
          or v_existing_quarantine.primary_source_table is distinct from
            'source_page_requests'
          or v_existing_quarantine.primary_source_record_id is distinct from
            v_request_id
          or v_existing_quarantine.evidence is distinct from v_quarantine_evidence
          or v_existing_quarantine.evidence_hash is distinct from
            public.manual_quarantine_evidence_hash(v_quarantine_evidence)
        then
          raise exception using errcode = '40001',
            message = 'The durable Luce funding quarantine key collides with different evidence.';
        end if;
        v_quarantine_id := v_existing_quarantine.id;
      else
        insert into public.manual_quarantine_registry (
          quarantine_key,
          case_key,
          classification,
          category,
          status,
          requires_action,
          terminal,
          terminal_failure_count,
          severity,
          public_impact,
          owner,
          retry_mode,
          retry_charge,
          title,
          reason_code,
          reason,
          recommended_action,
          shared_award_id,
          primary_source_table,
          primary_source_record_id,
          evidence_record_count,
          evidence,
          evidence_hash,
          policy_id,
          policy_version,
          policy_hash,
          first_observed_at,
          last_observed_at
        ) values (
          'stage1:source-intake:luce-funding:' || v_request_id::text,
          'stage1:source-intake:luce-funding',
          'actionable_quarantine',
          'public_page',
          'quarantined',
          true,
          false,
          0,
          'medium',
          'protected',
          'stage1-source-owner',
          'Retry only after new exact current-cycle funding evidence and human review.',
          'none',
          'Luce funding source remains quarantined',
          'stage1_human_source_quarantined_role_mismatch',
          'The reviewed Luce page did not prove the requested funding role strongly enough for monitoring activation.',
          'Collect exact current-cycle Luce funding wording, review it, and issue a new immutable disposition before activation.',
          v_award_id,
          'source_page_requests',
          v_request_id,
          pg_catalog.jsonb_array_length(v_decision -> 'exact_quotes'),
          v_quarantine_evidence,
          public.manual_quarantine_evidence_hash(v_quarantine_evidence),
          'awardping-stage1-source-disposition',
          '1',
          private.stage1_text_sha256('stage1-baseline-source-disposition-v1'),
          v_now,
          v_now
        ) returning id into v_quarantine_id;
      end if;
    end if;

    v_item_result := pg_catalog.jsonb_build_object(
      'item_number', v_item_number,
      'request_id', v_request_id,
      'decision', v_decision_name,
      'shared_award_id', v_award_id,
      'shared_award_source_id', v_source_id,
      'source_acquisition_id', v_acquisition_id,
      'source_inserted', v_source_inserted,
      'request_status', v_request.status,
      'quarantine_id', case
        when v_decision_name = 'keep_quarantined' then v_quarantine_id
        else null
      end,
      'activation_state', case
        when v_decision_name = 'approve_baseline_only'
          then 'pending_exact_first_visual_baseline'
        else 'quarantined'
      end,
      'paid_api_calls', 0,
      'public_fact_writes', 0,
      'fact_candidates', 0,
      'reconciliation_requests', 0,
      'first_observation_notifications', 0
    );
    v_item_results := v_item_results || pg_catalog.jsonb_build_array(v_item_result);
    v_item_ledger_row := pg_catalog.jsonb_build_object(
      'decision_item_sha256', v_item_sha256,
      'item_number', v_item_number,
      'request_id', v_request_id,
      'decision', v_decision_name,
      'shared_award_id', v_award_id,
      'shared_award_source_id', v_source_id,
      'source_acquisition_id', v_acquisition_id,
      'reviewed_roles', v_expected_roles,
      'decision_payload', v_decision,
      'result', v_item_result
    );
    v_item_ledger_rows := v_item_ledger_rows ||
      pg_catalog.jsonb_build_array(v_item_ledger_row);
  end loop;

  if v_approved_count <> 10
    or v_quarantined_count <> 1
    or pg_catalog.jsonb_array_length(v_item_results) <> 11
    or v_quarantine_id is null
  then
    raise exception using errcode = '23514',
      message = 'The atomic Stage 1 disposition did not produce the required 10+1 outcome.';
  end if;

  select pg_catalog.count(*) into v_count
  from public.shared_award_sources source
  where source.id in (
      select nullif(item.value ->> 'shared_award_source_id', '')::uuid
      from pg_catalog.jsonb_array_elements(v_item_ledger_rows) item(value)
      where item.value ->> 'decision' = 'approve_baseline_only'
    )
    and source.admin_review_status = 'review_later'
    and source.admin_review_note =
      'approved_pending_exact_first_visual_baseline'
    and source.admin_reviewed_by = 'stage1-baseline-source-disposition'
    and private.stage1_monitoring_approval_valid(
      source.page_metadata -> 'stage1_baseline_monitoring_approval',
      source.id,
      (source.page_metadata -> 'stage1_baseline_monitoring_approval'
        ->> 'source_page_request_id')::uuid,
      v_confirmation_payload ->> 'evidence_packet_sha256',
      source.page_metadata -> 'stage1_baseline_monitoring_approval'
        ->> 'decision_item_sha256',
      source.page_metadata -> 'stage1_baseline_monitoring_approval'
        -> 'reviewed_roles'
    );
  if v_count <> 10 then
    raise exception using errcode = '23514',
      message = 'All ten approved sources must remain held pending exact visual-baseline persistence.';
  end if;

  select pg_catalog.count(*) into v_count
  from public.shared_award_source_acquisitions acquisition
  where acquisition.id in (
      select nullif(item.value ->> 'source_acquisition_id', '')::uuid
      from pg_catalog.jsonb_array_elements(v_item_ledger_rows) item(value)
      where item.value ->> 'decision' = 'approve_baseline_only'
    )
    and acquisition.acquisition_kind = 'historical_import'
    and acquisition.notification_mode = 'baseline_only'
    and acquisition.onboarding_batch_id =
      'stage1-national-25-reviewed-sources-v1';
  if v_count <> 10 then
    raise exception using errcode = '23514',
      message = 'All ten approved sources require exact immutable baseline-only acquisition provenance.';
  end if;

  v_receipt := pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.source-disposition-apply-receipt.v1',
    'status', 'applied',
    'application_mode', 'atomic_10_plus_1',
    'bundle_sha256', v_bundle_sha256,
    'confirmation_sha256', p_confirmation_sha256,
    'evidence_packet_sha256',
      v_confirmation_payload ->> 'evidence_packet_sha256',
    'state_fingerprint_sha256',
      v_confirmation_payload ->> 'state_fingerprint_sha256',
    'onboarding_plan_sha256',
      v_confirmation_payload ->> 'onboarding_plan_sha256',
    'applied_at', v_now,
    'approved_baseline_only', v_approved_count,
    'kept_quarantined', v_quarantined_count,
    'luce_quarantine_id', v_quarantine_id,
    'activation_state', 'pending_exact_first_visual_baseline',
    'paid_api_calls', 0,
    'public_fact_writes', 0,
    'fact_candidates', 0,
    'reconciliation_requests', 0,
    'first_observation_notifications', 0,
    'items', v_item_results
  );

  insert into private.stage1_source_disposition_bundles (
    bundle_sha256,
    confirmation_sha256,
    policy_version,
    evidence_packet_sha256,
    state_fingerprint_sha256,
    onboarding_plan_sha256,
    reviewed_by,
    reviewed_at,
    approved_count,
    quarantined_count,
    item_count,
    full_plan,
    confirmation_payload,
    receipt,
    created_at
  ) values (
    v_bundle_sha256,
    p_confirmation_sha256,
    p_binding ->> 'policy_version',
    v_confirmation_payload ->> 'evidence_packet_sha256',
    v_confirmation_payload ->> 'state_fingerprint_sha256',
    v_confirmation_payload ->> 'onboarding_plan_sha256',
    v_operator_review ->> 'statement',
    v_reviewed_at,
    10,
    1,
    11,
    p_binding,
    v_confirmation_payload,
    v_receipt,
    v_now
  );

  for v_item_ledger_row in
    select item.value
    from pg_catalog.jsonb_array_elements(v_item_ledger_rows) item(value)
    order by (item.value ->> 'item_number')::integer
  loop
    insert into private.stage1_source_disposition_items (
      decision_item_sha256,
      bundle_sha256,
      item_number,
      request_id,
      decision,
      shared_award_id,
      shared_award_source_id,
      source_acquisition_id,
      reviewed_roles,
      decision_payload,
      result,
      created_at
    ) values (
      v_item_ledger_row ->> 'decision_item_sha256',
      v_bundle_sha256,
      (v_item_ledger_row ->> 'item_number')::integer,
      (v_item_ledger_row ->> 'request_id')::uuid,
      v_item_ledger_row ->> 'decision',
      (v_item_ledger_row ->> 'shared_award_id')::uuid,
      nullif(v_item_ledger_row ->> 'shared_award_source_id', '')::uuid,
      nullif(v_item_ledger_row ->> 'source_acquisition_id', '')::uuid,
      v_item_ledger_row -> 'reviewed_roles',
      v_item_ledger_row -> 'decision_payload',
      v_item_ledger_row -> 'result',
      v_now
    );
  end loop;

  return v_receipt;
exception
  when invalid_text_representation
    or invalid_datetime_format
    or datetime_field_overflow
    or numeric_value_out_of_range
  then
    raise exception using errcode = '22023',
      message = 'A reviewed Stage 1 disposition binding contains an invalid typed value.';
end;
$$;

revoke all on function public.apply_reviewed_stage1_source_dispositions(
  jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.apply_reviewed_stage1_source_dispositions(
  jsonb, text
) to service_role;

comment on function public.apply_reviewed_stage1_source_dispositions(jsonb, text) is
  'Atomically applies the exact 10 approved baseline-only source requests plus the Luce funding quarantine without paid API, public fact, candidate, reconciliation, notification, or pre-baseline activation authority.';

create or replace function private.stage1_activation_persistence_evidence_valid(
  p_evidence jsonb,
  p_source_id uuid,
  p_acquisition_id uuid,
  p_request_id uuid,
  p_guard_sha256 text,
  p_observed_normalized_text_sha256 text
)
returns boolean
language plpgsql
stable
strict
set search_path = ''
as $$
declare
  v_local jsonb := p_evidence -> 'local_baseline';
  v_r2 jsonb := p_evidence -> 'r2';
begin
  if private.stage1_jsonb_has_exact_keys(p_evidence, array[
      'acquisition_id',
      'creates_api_charge',
      'guard_sha256',
      'local_baseline',
      'local_baseline_written',
      'observed_normalized_text_sha256',
      'persisted_at',
      'r2',
      'r2_sync_succeeded',
      'request_id',
      'schema_version',
      'source_id'
    ]) is not true
    or p_evidence ->> 'schema_version' is distinct from
      'awardping.stage1.baseline-activation-persistence-evidence.v1'
    or nullif(p_evidence ->> 'source_id', '')::uuid is distinct from p_source_id
    or nullif(p_evidence ->> 'acquisition_id', '')::uuid
      is distinct from p_acquisition_id
    or nullif(p_evidence ->> 'request_id', '')::uuid is distinct from p_request_id
    or p_evidence ->> 'guard_sha256' is distinct from p_guard_sha256
    or p_evidence ->> 'observed_normalized_text_sha256'
      is distinct from p_observed_normalized_text_sha256
    or p_evidence -> 'local_baseline_written' is distinct from 'true'::jsonb
    or p_evidence -> 'r2_sync_succeeded' is distinct from 'true'::jsonb
    or p_evidence -> 'creates_api_charge' is distinct from 'false'::jsonb
    or (p_evidence ->> 'persisted_at')::timestamptz >
      pg_catalog.statement_timestamp() + interval '5 minutes'
  then
    return false;
  end if;

  if private.stage1_jsonb_has_exact_keys(v_local, array[
      'activation_guard_sha256',
      'activation_status',
      'archive_relative_path',
      'capture_meta_path',
      'captured_at',
      'file_hash',
      'image_hash',
      'kind',
      'layout_hash',
      'text_hash'
    ]) is not true
    or nullif(pg_catalog.btrim(v_local ->> 'archive_relative_path'), '') is null
    or nullif(pg_catalog.btrim(v_local ->> 'capture_meta_path'), '') is null
    or nullif(pg_catalog.btrim(v_local ->> 'kind'), '') is null
    or (v_local ->> 'captured_at')::timestamptz >
      pg_catalog.statement_timestamp() + interval '5 minutes'
    or coalesce(v_local ->> 'text_hash', '') !~ '^[0-9a-f]{64}$'
    or coalesce(v_local ->> 'image_hash', '') !~ '^[0-9a-f]{64}$'
    or not (
      v_local -> 'file_hash' = 'null'::jsonb
      or coalesce(v_local ->> 'file_hash', '') ~ '^[0-9a-f]{64}$'
    )
    or not (
      v_local -> 'layout_hash' = 'null'::jsonb
      or coalesce(v_local ->> 'layout_hash', '') ~ '^[0-9a-f]{64}$'
    )
    or v_local ->> 'text_hash' is distinct from
      p_observed_normalized_text_sha256
    or v_local ->> 'activation_guard_sha256' is distinct from p_guard_sha256
    or v_local ->> 'activation_status' is distinct from 'server_prepare_recorded'
  then
    return false;
  end if;

  if private.stage1_jsonb_has_exact_keys(v_r2, array[
      'activation_guard_sha256',
      'bucket',
      'latest_captured_at',
      'latest_hashes',
      'latest_object_keys',
      'uploaded_object_count'
    ]) is not true
    or nullif(pg_catalog.btrim(v_r2 ->> 'bucket'), '') is null
    or (v_r2 ->> 'latest_captured_at')::timestamptz is distinct from
      (v_local ->> 'captured_at')::timestamptz
    or pg_catalog.jsonb_typeof(v_r2 -> 'latest_hashes') is distinct from 'object'
    or pg_catalog.jsonb_typeof(v_r2 -> 'latest_object_keys') is distinct from 'object'
    or v_r2 -> 'latest_object_keys' = '{}'::jsonb
    or nullif(v_r2 #>> array['latest_object_keys', 'text'], '') is null
    or v_r2 #>> array['latest_hashes', 'text_hash'] is distinct from
      v_local ->> 'text_hash'
    or v_r2 #>> array['latest_hashes', 'image_hash'] is distinct from
      v_local ->> 'image_hash'
    or v_r2 ->> 'activation_guard_sha256' is distinct from p_guard_sha256
    or pg_catalog.jsonb_typeof(v_r2 -> 'uploaded_object_count')
      is distinct from 'number'
    or (v_r2 ->> 'uploaded_object_count')::integer <= 0
  then
    return false;
  end if;

  return true;
exception
  when invalid_text_representation
    or invalid_datetime_format
    or datetime_field_overflow
    or numeric_value_out_of_range
  then
    return false;
end;
$$;

revoke all on function private.stage1_activation_persistence_evidence_valid(
  jsonb, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;

create or replace function public.record_stage1_source_baseline_activation(
  p_source_id uuid,
  p_acquisition_id uuid,
  p_observed_normalized_text_sha256 text,
  p_guard_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_source public.shared_award_sources%rowtype;
  v_acquisition public.shared_award_source_acquisitions%rowtype;
  v_item private.stage1_source_disposition_items%rowtype;
  v_existing private.stage1_source_baseline_activation_receipts%rowtype;
  v_disposition jsonb;
  v_guard jsonb;
  v_receipt jsonb;
  v_receipt_sha256 text;
begin
  if p_source_id is null
    or p_acquisition_id is null
    or coalesce(p_observed_normalized_text_sha256, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_guard_sha256, '') !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023',
      message = 'Exact Stage 1 baseline activation identities and hashes are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stage1-baseline-activation:' || p_acquisition_id::text,
      0
    )
  );

  select receipt.* into v_existing
  from private.stage1_source_baseline_activation_receipts receipt
  where receipt.source_acquisition_id = p_acquisition_id;
  if found then
    if v_existing.shared_award_source_id is distinct from p_source_id
      or v_existing.observed_normalized_text_sha256 is distinct from
        p_observed_normalized_text_sha256
      or v_existing.guard_sha256 is distinct from p_guard_sha256
    then
      raise exception using errcode = '40001',
        message = 'The immutable Stage 1 activation prepare receipt collides with different proof.';
    end if;
    select source.* into strict v_source
    from public.shared_award_sources source
    where source.id = p_source_id
    for update;
    if v_source.admin_review_status is distinct from 'review_later'
      or v_source.admin_review_note is distinct from
        'approved_pending_exact_first_visual_baseline'
      or v_source.admin_reviewed_by is distinct from
        'stage1-baseline-source-disposition'
      or exists (
        select 1
        from private.stage1_source_baseline_activation_failures failure
        where failure.source_acquisition_id = p_acquisition_id
          and failure.created_at >= v_existing.verified_at
      )
    then
      raise exception using errcode = '55000',
        message = 'The prior Stage 1 activation prepare receipt is no longer eligible for finalization.';
    end if;
    return pg_catalog.jsonb_build_object(
      'allowed', true,
      'prepare_receipt_sha256', v_existing.prepare_receipt_sha256
    );
  end if;

  select source.* into strict v_source
  from public.shared_award_sources source
  where source.id = p_source_id
  for update;
  select acquisition.* into strict v_acquisition
  from public.shared_award_source_acquisitions acquisition
  where acquisition.id = p_acquisition_id
    and acquisition.shared_award_source_id = p_source_id;
  select item.* into strict v_item
  from private.stage1_source_disposition_items item
  where item.source_acquisition_id = p_acquisition_id
    and item.shared_award_source_id = p_source_id
    and item.decision = 'approve_baseline_only';

  v_disposition := v_acquisition.review_seal -> 'human_source_disposition';
  v_guard := v_disposition -> 'activation_guard';
  if v_source.admin_review_status is distinct from 'review_later'
    or v_source.admin_review_note is distinct from
      'approved_pending_exact_first_visual_baseline'
    or v_source.admin_reviewed_by is distinct from
      'stage1-baseline-source-disposition'
    or v_acquisition.acquisition_kind is distinct from 'historical_import'
    or v_acquisition.notification_mode is distinct from 'baseline_only'
    or v_acquisition.onboarding_batch_id is distinct from
      'stage1-national-25-reviewed-sources-v1'
    or v_acquisition.origin_source_page_request_id is distinct from
      v_item.request_id
    or v_disposition ->> 'guard_sha256' is distinct from p_guard_sha256
    or private.stage1_canonical_json_sha256(v_disposition - 'guard_sha256')
      is distinct from p_guard_sha256
    or v_guard ->> 'shared_award_source_id' is distinct from p_source_id::text
    or v_guard ->> 'shared_award_source_acquisition_id'
      is distinct from p_acquisition_id::text
    or v_guard ->> 'source_page_request_id' is distinct from v_item.request_id::text
    or v_guard ->> 'decision_item_sha256' is distinct from
      v_item.decision_item_sha256
    or v_guard ->> 'normalized_retained_text_sha256' is distinct from
      p_observed_normalized_text_sha256
    or v_guard ->> 'mode' is distinct from
      'first_visual_baseline_exact_normalized_retained_text'
    or v_guard ->> 'notification_mode' is distinct from 'baseline_only'
    or v_source.url is distinct from v_guard ->> 'final_url'
    or private.stage1_monitoring_approval_valid(
      v_source.page_metadata -> 'stage1_baseline_monitoring_approval',
      p_source_id,
      v_item.request_id,
      v_guard ->> 'evidence_packet_sha256',
      v_item.decision_item_sha256,
      v_item.reviewed_roles
    ) is not true
  then
    raise exception using errcode = '23514',
      message = 'Stage 1 activation prepare requires the exact held human-reviewed source and normalized text.';
  end if;

  v_receipt := pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.baseline-activation-prepare-receipt.v1',
    'status', 'prepared_not_open',
    'shared_award_source_id', p_source_id,
    'source_acquisition_id', p_acquisition_id,
    'source_page_request_id', v_item.request_id,
    'decision_item_sha256', v_item.decision_item_sha256,
    'guard_sha256', p_guard_sha256,
    'expected_normalized_text_sha256',
      v_guard ->> 'normalized_retained_text_sha256',
    'observed_normalized_text_sha256', p_observed_normalized_text_sha256,
    'review_status', 'review_later',
    'review_note', 'approved_pending_exact_first_visual_baseline',
    'prepared_at', v_now,
    'public_fact_authority', false,
    'creates_api_charge', false
  );
  v_receipt_sha256 := private.stage1_canonical_json_sha256(v_receipt);

  insert into private.stage1_source_baseline_activation_receipts (
    source_acquisition_id,
    shared_award_source_id,
    source_page_request_id,
    disposition_item_sha256,
    guard_sha256,
    expected_normalized_text_sha256,
    observed_normalized_text_sha256,
    prepare_receipt_sha256,
    receipt,
    verified_at
  ) values (
    p_acquisition_id,
    p_source_id,
    v_item.request_id,
    v_item.decision_item_sha256,
    p_guard_sha256,
    p_observed_normalized_text_sha256,
    p_observed_normalized_text_sha256,
    v_receipt_sha256,
    v_receipt,
    v_now
  );

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'prepare_receipt_sha256', v_receipt_sha256
  );
end;
$$;

revoke all on function public.record_stage1_source_baseline_activation(
  uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_stage1_source_baseline_activation(
  uuid, uuid, text, text
) to service_role;

comment on function public.record_stage1_source_baseline_activation(
  uuid, uuid, text, text
) is 'Records immutable Stage 1 first-baseline prepare proof but deliberately leaves the source held in review_later until local and R2 persistence are finalized.';

create or replace function public.finalize_stage1_source_baseline_activation(
  p_source_id uuid,
  p_acquisition_id uuid,
  p_observed_normalized_text_sha256 text,
  p_guard_sha256 text,
  p_prepare_receipt_sha256 text,
  p_persistence_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_source public.shared_award_sources%rowtype;
  v_prepare private.stage1_source_baseline_activation_receipts%rowtype;
  v_existing private.stage1_source_baseline_activation_finalizations%rowtype;
  v_receipt jsonb;
  v_receipt_sha256 text;
begin
  if p_source_id is null
    or p_acquisition_id is null
    or coalesce(p_observed_normalized_text_sha256, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_guard_sha256, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_prepare_receipt_sha256, '') !~ '^[0-9a-f]{64}$'
    or pg_catalog.jsonb_typeof(p_persistence_evidence) is distinct from 'object'
  then
    raise exception using errcode = '22023',
      message = 'Exact Stage 1 activation prepare and persistence proof are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stage1-baseline-activation:' || p_acquisition_id::text,
      0
    )
  );

  select finalized.* into v_existing
  from private.stage1_source_baseline_activation_finalizations finalized
  where finalized.source_acquisition_id = p_acquisition_id;
  if found then
    if v_existing.shared_award_source_id is distinct from p_source_id
      or v_existing.guard_sha256 is distinct from p_guard_sha256
      or v_existing.observed_normalized_text_sha256 is distinct from
        p_observed_normalized_text_sha256
      or v_existing.prepare_receipt_sha256 is distinct from
        p_prepare_receipt_sha256
      or v_existing.persistence_evidence is distinct from p_persistence_evidence
    then
      raise exception using errcode = '40001',
        message = 'The immutable Stage 1 activation finalization collides with different proof.';
    end if;
    select source.* into strict v_source
    from public.shared_award_sources source
    where source.id = p_source_id
    for update;
    if v_source.admin_review_status is distinct from 'open'
      or v_source.admin_review_note is distinct from
        'exact_first_visual_baseline_verified'
      or v_source.admin_reviewed_by is distinct from
        'stage1-baseline-activation-receipt'
      or exists (
        select 1
        from private.stage1_source_baseline_activation_failures failure
        where failure.source_acquisition_id = p_acquisition_id
          and failure.created_at >= v_existing.finalized_at
      )
    then
      raise exception using errcode = '55000',
        message = 'The prior Stage 1 activation finalization was invalidated by a later durable failure.';
    end if;
    return pg_catalog.jsonb_build_object(
      'allowed', true,
      'finalization_receipt_sha256',
        v_existing.finalization_receipt_sha256
    );
  end if;

  select receipt.* into strict v_prepare
  from private.stage1_source_baseline_activation_receipts receipt
  where receipt.source_acquisition_id = p_acquisition_id
    and receipt.shared_award_source_id = p_source_id
    and receipt.prepare_receipt_sha256 = p_prepare_receipt_sha256
    and receipt.guard_sha256 = p_guard_sha256
    and receipt.observed_normalized_text_sha256 =
      p_observed_normalized_text_sha256;
  select source.* into strict v_source
  from public.shared_award_sources source
  where source.id = p_source_id
  for update;

  if private.stage1_activation_persistence_evidence_valid(
      p_persistence_evidence,
      p_source_id,
      p_acquisition_id,
      v_prepare.source_page_request_id,
      p_guard_sha256,
      p_observed_normalized_text_sha256
    ) is not true
    or v_source.admin_review_status is distinct from 'review_later'
    or v_source.admin_review_note is distinct from
      'approved_pending_exact_first_visual_baseline'
    or v_source.admin_reviewed_by is distinct from
      'stage1-baseline-source-disposition'
    or v_source.last_checked_at is null
    or v_source.next_check_at is null
    or v_source.consecutive_failures <> 0
    or v_source.last_error is not null
    or v_source.last_hash not in (
      'visual:' || (p_persistence_evidence #>> array['local_baseline', 'text_hash']),
      'visual:' || (p_persistence_evidence #>> array['local_baseline', 'image_hash']),
      'visual:' || coalesce(
        p_persistence_evidence #>> array['local_baseline', 'file_hash'], ''
      ),
      'visual:' || coalesce(
        p_persistence_evidence #>> array['local_baseline', 'layout_hash'], ''
      ),
      'visual:' || coalesce(
        p_persistence_evidence #>> array['r2', 'latest_hashes', 'main_content_hash'],
        ''
      )
    )
  then
    raise exception using errcode = '23514',
      message = 'Stage 1 activation finalization requires persisted local/R2 evidence and the successful held-source health write.';
  end if;

  v_receipt := pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.baseline-activation-finalization-receipt.v1',
    'status', 'finalized_open',
    'shared_award_source_id', p_source_id,
    'source_acquisition_id', p_acquisition_id,
    'source_page_request_id', v_prepare.source_page_request_id,
    'decision_item_sha256', v_prepare.disposition_item_sha256,
    'guard_sha256', p_guard_sha256,
    'observed_normalized_text_sha256', p_observed_normalized_text_sha256,
    'prepare_receipt_sha256', p_prepare_receipt_sha256,
    'persistence_evidence_sha256',
      private.stage1_canonical_json_sha256(p_persistence_evidence),
    'finalized_at', v_now,
    'public_fact_authority', false,
    'creates_api_charge', false
  );
  v_receipt_sha256 := private.stage1_canonical_json_sha256(v_receipt);

  insert into private.stage1_source_baseline_activation_finalizations (
    source_acquisition_id,
    shared_award_source_id,
    source_page_request_id,
    disposition_item_sha256,
    prepare_receipt_sha256,
    guard_sha256,
    observed_normalized_text_sha256,
    persistence_evidence,
    finalization_receipt_sha256,
    receipt,
    finalized_at
  ) values (
    p_acquisition_id,
    p_source_id,
    v_prepare.source_page_request_id,
    v_prepare.disposition_item_sha256,
    p_prepare_receipt_sha256,
    p_guard_sha256,
    p_observed_normalized_text_sha256,
    p_persistence_evidence,
    v_receipt_sha256,
    v_receipt,
    v_now
  );

  update public.shared_award_sources source
  set
    admin_review_status = 'open',
    admin_review_note = 'exact_first_visual_baseline_verified',
    admin_reviewed_at = v_now,
    admin_reviewed_by = 'stage1-baseline-activation-receipt',
    updated_at = v_now
  where source.id = p_source_id
    and source.admin_review_status = 'review_later'
    and source.admin_review_note =
      'approved_pending_exact_first_visual_baseline'
    and source.admin_reviewed_by = 'stage1-baseline-source-disposition';
  if not found then
    raise exception using errcode = '40001',
      message = 'The Stage 1 held-source finalization compare-and-set failed.';
  end if;

  update public.manual_quarantine_registry quarantine
  set
    status = 'resolved',
    resolved_at = v_now,
    resolved_by = 'stage1-baseline-activation-receipt',
    resolution_note = 'Exact local and R2 first-visual-baseline persistence finalized.',
    last_observed_at = v_now
  where quarantine.quarantine_key =
      'stage1:baseline-activation:' || p_source_id::text
    and quarantine.status <> 'resolved';

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'finalization_receipt_sha256', v_receipt_sha256
  );
end;
$$;

revoke all on function public.finalize_stage1_source_baseline_activation(
  uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_stage1_source_baseline_activation(
  uuid, uuid, text, text, text, jsonb
) to service_role;

comment on function public.finalize_stage1_source_baseline_activation(
  uuid, uuid, text, text, text, jsonb
) is 'Opens one held Stage 1 source only after immutable prepare proof, successful source health persistence, and exact local plus R2 baseline evidence are committed.';

create or replace function public.fail_stage1_source_baseline_activation(
  p_source_id uuid,
  p_acquisition_id uuid,
  p_request_id uuid,
  p_reason_code text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_source public.shared_award_sources%rowtype;
  v_acquisition public.shared_award_source_acquisitions%rowtype;
  v_item private.stage1_source_disposition_items%rowtype;
  v_disposition jsonb;
  v_guard jsonb;
  v_failure_evidence jsonb;
  v_failure_sha256 text;
  v_quarantine_evidence jsonb;
  v_quarantine_id uuid;
begin
  if p_source_id is null
    or p_acquisition_id is null
    or p_request_id is null
    or coalesce(p_reason_code, '') !~
      '^stage1_baseline_activation_[a-z0-9_]+$'
    or private.stage1_jsonb_has_exact_keys(p_evidence, array[
      'baseline_facts_requested',
      'baseline_written',
      'creates_api_charge',
      'detail',
      'expected_normalized_text_sha256',
      'failure_stage',
      'guard_sha256',
      'observed_comparison_final_url',
      'observed_comparison_text_sha256',
      'observed_final_url',
      'observed_normalized_text_sha256',
      'observed_visual_text_sha256',
      'persistence_evidence',
      'public_event_created',
      'r2_sync_succeeded',
      'safe_action',
      'schema_version'
    ]) is not true
    or p_evidence ->> 'schema_version' is distinct from
      'awardping.stage1.baseline-activation-failure-evidence.v1'
    or p_evidence -> 'creates_api_charge' is distinct from 'false'::jsonb
    or p_evidence -> 'public_event_created' is distinct from 'false'::jsonb
    or p_evidence -> 'baseline_facts_requested' is distinct from 'false'::jsonb
    or pg_catalog.jsonb_typeof(p_evidence -> 'baseline_written')
      is distinct from 'boolean'
    or pg_catalog.jsonb_typeof(p_evidence -> 'r2_sync_succeeded')
      is distinct from 'boolean'
    or nullif(pg_catalog.btrim(p_evidence ->> 'failure_stage'), '') is null
    or nullif(pg_catalog.btrim(p_evidence ->> 'safe_action'), '') is null
  then
    raise exception using errcode = '22023',
      message = 'Exact zero-charge Stage 1 activation failure evidence is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stage1-baseline-activation:' || p_acquisition_id::text,
      0
    )
  );
  select source.* into strict v_source
  from public.shared_award_sources source
  where source.id = p_source_id
  for update;
  select acquisition.* into strict v_acquisition
  from public.shared_award_source_acquisitions acquisition
  where acquisition.id = p_acquisition_id
    and acquisition.shared_award_source_id = p_source_id
    and acquisition.origin_source_page_request_id = p_request_id;
  select item.* into strict v_item
  from private.stage1_source_disposition_items item
  where item.source_acquisition_id = p_acquisition_id
    and item.shared_award_source_id = p_source_id
    and item.request_id = p_request_id
    and item.decision = 'approve_baseline_only';

  v_disposition := v_acquisition.review_seal -> 'human_source_disposition';
  v_guard := v_disposition -> 'activation_guard';
  if v_disposition ->> 'guard_sha256' is distinct from
      private.stage1_canonical_json_sha256(v_disposition - 'guard_sha256')
    or v_guard ->> 'shared_award_source_id' is distinct from p_source_id::text
    or v_guard ->> 'shared_award_source_acquisition_id'
      is distinct from p_acquisition_id::text
    or v_guard ->> 'source_page_request_id' is distinct from p_request_id::text
    or v_guard ->> 'decision_item_sha256' is distinct from
      v_item.decision_item_sha256
    or (
      p_evidence ->> 'guard_sha256' is not null
      and p_evidence ->> 'guard_sha256' is distinct from
        v_disposition ->> 'guard_sha256'
    )
    or (
      p_evidence ->> 'expected_normalized_text_sha256' is not null
      and p_evidence ->> 'expected_normalized_text_sha256' is distinct from
        v_guard ->> 'normalized_retained_text_sha256'
    )
  then
    raise exception using errcode = '23514',
      message = 'Stage 1 activation failure evidence is not bound to the immutable reviewed source.';
  end if;

  if p_evidence -> 'persistence_evidence' <> 'null'::jsonb
    and private.stage1_activation_persistence_evidence_valid(
      p_evidence -> 'persistence_evidence',
      p_source_id,
      p_acquisition_id,
      p_request_id,
      v_disposition ->> 'guard_sha256',
      p_evidence -> 'persistence_evidence'
        ->> 'observed_normalized_text_sha256'
    ) is not true
  then
    raise exception using errcode = '23514',
      message = 'Post-persistence Stage 1 activation failure evidence is malformed.';
  end if;
  if (
      p_evidence -> 'persistence_evidence' <> 'null'::jsonb
      and (
        p_evidence -> 'baseline_written' is distinct from 'true'::jsonb
        or p_evidence -> 'r2_sync_succeeded' is distinct from 'true'::jsonb
      )
    )
    or (
      p_evidence -> 'r2_sync_succeeded' = 'true'::jsonb
      and p_evidence -> 'persistence_evidence' = 'null'::jsonb
    )
  then
    raise exception using errcode = '23514',
      message = 'Stage 1 failure persistence flags must match their retained persistence evidence.';
  end if;

  v_failure_evidence := p_evidence || pg_catalog.jsonb_build_object(
    'shared_award_source_id', p_source_id,
    'source_acquisition_id', p_acquisition_id,
    'source_page_request_id', p_request_id,
    'decision_item_sha256', v_item.decision_item_sha256,
    'expected_guard_sha256', v_disposition ->> 'guard_sha256',
    'reason_code', p_reason_code,
    'recorded_at', v_now
  );
  v_failure_sha256 := private.stage1_canonical_json_sha256(v_failure_evidence);

  insert into private.stage1_source_baseline_activation_failures (
    failure_sha256,
    source_acquisition_id,
    shared_award_source_id,
    source_page_request_id,
    disposition_item_sha256,
    reason_code,
    guard_sha256,
    evidence,
    created_at
  ) values (
    v_failure_sha256,
    p_acquisition_id,
    p_source_id,
    p_request_id,
    v_item.decision_item_sha256,
    p_reason_code,
    v_disposition ->> 'guard_sha256',
    v_failure_evidence,
    v_now
  ) on conflict (failure_sha256) do nothing;

  update public.shared_award_sources source
  set
    admin_review_status = 'review_later',
    admin_review_note = 'stage1_baseline_activation_failed:' || p_reason_code,
    admin_reviewed_at = v_now,
    admin_reviewed_by = 'stage1-baseline-activation-failure',
    last_error = 'Stage 1 baseline activation failed: ' ||
      coalesce(nullif(p_evidence ->> 'detail', ''), p_reason_code),
    consecutive_failures = pg_catalog.greatest(source.consecutive_failures, 1),
    updated_at = v_now
  where source.id = p_source_id;

  v_quarantine_evidence := pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.baseline-activation-quarantine.v1',
    'failure_sha256', v_failure_sha256,
    'reason_code', p_reason_code,
    'shared_award_source_id', p_source_id,
    'source_acquisition_id', p_acquisition_id,
    'source_page_request_id', p_request_id,
    'decision_item_sha256', v_item.decision_item_sha256,
    'guard_sha256', v_disposition ->> 'guard_sha256',
    'failure_evidence', p_evidence,
    'finalization_previously_recorded', exists (
      select 1
      from private.stage1_source_baseline_activation_finalizations finalized
      where finalized.source_acquisition_id = p_acquisition_id
    ),
    'public_fact_authority', false,
    'creates_api_charge', false
  );

  insert into public.manual_quarantine_registry (
    quarantine_key,
    case_key,
    classification,
    category,
    status,
    requires_action,
    terminal,
    terminal_failure_count,
    severity,
    public_impact,
    owner,
    retry_mode,
    retry_charge,
    title,
    reason_code,
    reason,
    recommended_action,
    shared_award_id,
    shared_award_source_id,
    primary_source_table,
    primary_source_record_id,
    evidence_record_count,
    evidence,
    evidence_hash,
    policy_id,
    policy_version,
    policy_hash,
    first_observed_at,
    last_observed_at
  ) values (
    'stage1:baseline-activation:' || p_source_id::text,
    'stage1:baseline-activation:' || p_source_id::text,
    'actionable_quarantine',
    'visual_review',
    'quarantined',
    true,
    true,
    1,
    'high',
    'protected',
    'stage1-visual-owner',
    'Retry only after the evidence shown here is repaired or a new exact human disposition is issued.',
    'none',
    'Stage 1 first visual baseline activation failed',
    p_reason_code,
    coalesce(nullif(p_evidence ->> 'detail', ''), p_reason_code),
    p_evidence ->> 'safe_action',
    v_source.shared_award_id,
    p_source_id,
    'shared_award_sources',
    p_source_id,
    1,
    v_quarantine_evidence,
    public.manual_quarantine_evidence_hash(v_quarantine_evidence),
    'awardping-stage1-baseline-activation',
    '1',
    private.stage1_text_sha256('stage1-baseline-source-disposition-v1'),
    v_now,
    v_now
  )
  on conflict (quarantine_key) do update
  set
    status = 'quarantined',
    requires_action = true,
    terminal = true,
    terminal_failure_count = 1,
    severity = 'high',
    public_impact = 'protected',
    reason_code = excluded.reason_code,
    reason = excluded.reason,
    recommended_action = excluded.recommended_action,
    evidence_record_count =
      public.manual_quarantine_registry.evidence_record_count + 1,
    evidence = excluded.evidence,
    evidence_hash = excluded.evidence_hash,
    last_observed_at = excluded.last_observed_at,
    resolved_at = null,
    resolved_by = null,
    resolution_note = null
  returning id into v_quarantine_id;

  return pg_catalog.jsonb_build_object(
    'status', 'quarantined',
    'quarantine_id', v_quarantine_id,
    'failure_sha256', v_failure_sha256,
    'shared_award_source_id', p_source_id,
    'source_acquisition_id', p_acquisition_id,
    'creates_api_charge', false,
    'public_event_created', false
  );
end;
$$;

revoke all on function public.fail_stage1_source_baseline_activation(
  uuid, uuid, uuid, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.fail_stage1_source_baseline_activation(
  uuid, uuid, uuid, text, jsonb
) to service_role;

comment on function public.fail_stage1_source_baseline_activation(
  uuid, uuid, uuid, text, jsonb
) is 'Persists immutable Stage 1 activation failure proof, re-holds the source even after uncertain finalization, and opens one durable zero-charge operator quarantine.';
