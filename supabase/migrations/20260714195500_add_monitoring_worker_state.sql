-- Durable worker-only state for rejected visual evidence and keyset-based policy sweeps.

alter table public.shared_award_visual_review_candidates
  add column if not exists publication_claim_token text,
  add column if not exists publication_claimed_at timestamptz;

-- A source baseline is a single ordered stream. This database-enforced lease
-- prevents distinct candidates and distinct worker processes from advancing
-- the same local/R2 source baseline concurrently.
create unique index if not exists shared_award_visual_review_candidates_source_publication_claim_idx
  on public.shared_award_visual_review_candidates (shared_award_source_id)
  where publication_claim_token is not null;

create or replace function public.advance_shared_award_visual_snapshot(
  p_expected_exists boolean,
  p_expected_updated_at timestamptz,
  p_snapshot jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows integer := 0;
  v_source_id uuid := (p_snapshot ->> 'shared_award_source_id')::uuid;
  v_latest_captured_at timestamptz := nullif(p_snapshot ->> 'latest_captured_at', '')::timestamptz;
begin
  if p_expected_exists then
    update public.shared_award_source_visual_snapshots
    set
      shared_award_id = (p_snapshot ->> 'shared_award_id')::uuid,
      source_url = p_snapshot ->> 'source_url',
      source_title = p_snapshot ->> 'source_title',
      source_page_type = p_snapshot ->> 'source_page_type',
      kind = coalesce(p_snapshot ->> 'kind', 'webpage'),
      bucket = p_snapshot ->> 'bucket',
      latest_captured_at = v_latest_captured_at,
      latest_object_keys = coalesce(p_snapshot -> 'latest_object_keys', '{}'::jsonb),
      latest_hashes = coalesce(p_snapshot -> 'latest_hashes', '{}'::jsonb),
      latest_metadata = coalesce(p_snapshot -> 'latest_metadata', '{}'::jsonb),
      previous_captured_at = nullif(p_snapshot ->> 'previous_captured_at', '')::timestamptz,
      previous_object_keys = coalesce(p_snapshot -> 'previous_object_keys', '{}'::jsonb),
      previous_hashes = coalesce(p_snapshot -> 'previous_hashes', '{}'::jsonb),
      previous_metadata = coalesce(p_snapshot -> 'previous_metadata', '{}'::jsonb),
      updated_at = (p_snapshot ->> 'updated_at')::timestamptz
    where shared_award_source_id = v_source_id
      and updated_at = p_expected_updated_at
      and (latest_captured_at is null or latest_captured_at <= v_latest_captured_at);
    get diagnostics v_rows = row_count;
    return v_rows = 1;
  end if;

  insert into public.shared_award_source_visual_snapshots (
    shared_award_source_id, shared_award_id, source_url, source_title,
    source_page_type, kind, bucket, latest_captured_at, latest_object_keys,
    latest_hashes, latest_metadata, previous_captured_at, previous_object_keys,
    previous_hashes, previous_metadata, updated_at
  ) values (
    v_source_id,
    (p_snapshot ->> 'shared_award_id')::uuid,
    p_snapshot ->> 'source_url',
    p_snapshot ->> 'source_title',
    p_snapshot ->> 'source_page_type',
    coalesce(p_snapshot ->> 'kind', 'webpage'),
    p_snapshot ->> 'bucket',
    v_latest_captured_at,
    coalesce(p_snapshot -> 'latest_object_keys', '{}'::jsonb),
    coalesce(p_snapshot -> 'latest_hashes', '{}'::jsonb),
    coalesce(p_snapshot -> 'latest_metadata', '{}'::jsonb),
    nullif(p_snapshot ->> 'previous_captured_at', '')::timestamptz,
    coalesce(p_snapshot -> 'previous_object_keys', '{}'::jsonb),
    coalesce(p_snapshot -> 'previous_hashes', '{}'::jsonb),
    coalesce(p_snapshot -> 'previous_metadata', '{}'::jsonb),
    (p_snapshot ->> 'updated_at')::timestamptz
  ) on conflict (shared_award_source_id) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke all on function public.advance_shared_award_visual_snapshot(boolean, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.advance_shared_award_visual_snapshot(boolean, timestamptz, jsonb)
  to service_role;

create table if not exists public.shared_award_visual_rejection_ledger (
  id uuid primary key default gen_random_uuid(),
  shared_award_source_id uuid not null references public.shared_award_sources(id) on delete cascade,
  candidate_id uuid references public.shared_award_visual_review_candidates(id) on delete set null,
  evidence_signature text not null,
  policy_id text,
  policy_version text,
  policy_hash text not null,
  rejection_reason text not null,
  previous_text_hash text,
  new_text_hash text,
  previous_image_hash text,
  new_image_hash text,
  previous_file_hash text,
  new_file_hash text,
  comparison_snapshot_ref jsonb not null default '{}'::jsonb,
  deterministic_diff jsonb not null default '{}'::jsonb,
  first_rejected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  seen_count bigint not null default 1 check (seen_count > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shared_award_visual_rejection_ledger_identity_key
    unique (shared_award_source_id, evidence_signature, policy_hash)
);

alter table public.shared_award_visual_rejection_ledger enable row level security;
revoke all on table public.shared_award_visual_rejection_ledger from public, anon, authenticated;
grant all on table public.shared_award_visual_rejection_ledger to service_role;

create index if not exists shared_award_visual_rejection_ledger_source_seen_idx
  on public.shared_award_visual_rejection_ledger (shared_award_source_id, last_seen_at desc);

-- The hourly global sweep advances in this exact keyset order. The older
-- award-prefixed partial index cannot serve a cross-award scan efficiently.
create index if not exists shared_award_change_events_unsuppressed_sweep_idx
  on public.shared_award_change_events (detected_at, id)
  where suppressed_at is null;

create table if not exists public.monitoring_policy_sweep_state (
  sweep_key text primary key,
  policy_hash text not null,
  cursor_detected_at timestamptz,
  cursor_event_id uuid,
  scanned_count bigint not null default 0 check (scanned_count >= 0),
  cycle_started_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monitoring_policy_sweep_cursor_pair_check check (
    (cursor_detected_at is null and cursor_event_id is null)
    or (cursor_detected_at is not null and cursor_event_id is not null)
  )
);

alter table public.monitoring_policy_sweep_state enable row level security;
revoke all on table public.monitoring_policy_sweep_state from public, anon, authenticated;
grant all on table public.monitoring_policy_sweep_state to service_role;

comment on table public.shared_award_visual_rejection_ledger is
  'Policy-versioned comparison evidence rejected by visual review; it never replaces the public last-known-good snapshot baseline.';
comment on table public.monitoring_policy_sweep_state is
  'Persistent keyset cursor for bounded monitoring-policy cleanup sweeps.';
comment on column public.shared_award_visual_review_candidates.publication_claim_token is
  'Cross-process, per-source lease token guarding visual publication and baseline side effects.';
