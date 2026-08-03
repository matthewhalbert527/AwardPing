-- Keep terminal/blocked reconciliation outcomes transactionally consistent
-- with their candidate dispositions, and make Stage 1 publication state track
-- candidate-evidence changes even when the rendered public fact text is equal.

-- Candidate writes take the Stage 1 statement fence even when the reconciled
-- award is not currently a cohort member. Preserve one lock order for every
-- success path by placing the already-deployed atomic publication function
-- behind a service-only wrapper that takes the national lock before the inner
-- function can lock a queue, award, source, or candidate row.
alter function public.commit_award_reconciliation_publication(
  uuid,
  uuid,
  timestamptz,
  bigint,
  timestamptz,
  jsonb,
  text,
  jsonb,
  double precision,
  jsonb,
  uuid[],
  uuid[],
  jsonb,
  jsonb,
  jsonb
) set schema private;

alter function private.commit_award_reconciliation_publication(
  uuid,
  uuid,
  timestamptz,
  bigint,
  timestamptz,
  jsonb,
  text,
  jsonb,
  double precision,
  jsonb,
  uuid[],
  uuid[],
  jsonb,
  jsonb,
  jsonb
) rename to commit_award_reconciliation_publication_unfenced_20260716221500;

revoke all on function private.commit_award_reconciliation_publication_unfenced_20260716221500(
  uuid,
  uuid,
  timestamptz,
  bigint,
  timestamptz,
  jsonb,
  text,
  jsonb,
  double precision,
  jsonb,
  uuid[],
  uuid[],
  jsonb,
  jsonb,
  jsonb
) from public, anon, authenticated, service_role;

create function public.commit_award_reconciliation_publication(
  p_reconciliation_id uuid,
  p_shared_award_id uuid,
  p_expected_started_at timestamptz,
  p_expected_queue_generation bigint,
  p_expected_award_updated_at timestamptz,
  p_expected_public_facts jsonb,
  p_summary text,
  p_public_facts jsonb,
  p_confidence double precision,
  p_evidence_rows jsonb,
  p_source_ids uuid[],
  p_candidate_ids uuid[],
  p_generated_candidates jsonb,
  p_candidate_status_updates jsonb,
  p_audit_row jsonb
)
returns public.shared_award_reconciliation_queue
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  return private.commit_award_reconciliation_publication_unfenced_20260716221500(
    p_reconciliation_id,
    p_shared_award_id,
    p_expected_started_at,
    p_expected_queue_generation,
    p_expected_award_updated_at,
    p_expected_public_facts,
    p_summary,
    p_public_facts,
    p_confidence,
    p_evidence_rows,
    p_source_ids,
    p_candidate_ids,
    p_generated_candidates,
    p_candidate_status_updates,
    p_audit_row
  );
end;
$$;

revoke all on function public.commit_award_reconciliation_publication(
  uuid,
  uuid,
  timestamptz,
  bigint,
  timestamptz,
  jsonb,
  text,
  jsonb,
  double precision,
  jsonb,
  uuid[],
  uuid[],
  jsonb,
  jsonb,
  jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.commit_award_reconciliation_publication(
  uuid,
  uuid,
  timestamptz,
  bigint,
  timestamptz,
  jsonb,
  text,
  jsonb,
  double precision,
  jsonb,
  uuid[],
  uuid[],
  jsonb,
  jsonb,
  jsonb
) to service_role;

comment on function public.commit_award_reconciliation_publication(
  uuid,
  uuid,
  timestamptz,
  bigint,
  timestamptz,
  jsonb,
  text,
  jsonb,
  double precision,
  jsonb,
  uuid[],
  uuid[],
  jsonb,
  jsonb,
  jsonb
) is
  'National-lock-first service wrapper for the CAS-protected atomic reconciliation publication commit.';

-- Rejected candidates are immutable terminal evidence, but their original
-- foreign keys deliberately implement source ON DELETE SET NULL and award
-- ON DELETE CASCADE. Preserve the exact terminal row before either database
-- referential action runs. These identifiers intentionally are not foreign
-- keys: the archive must outlive the award/source rows whose deletion caused
-- it to be written.
create table public.shared_award_fact_candidate_terminal_archive (
  archive_id uuid primary key default pg_catalog.gen_random_uuid(),
  candidate_id uuid not null,
  lifecycle_action text not null check (
    lifecycle_action in ('source_deleted', 'award_deleted')
  ),
  shared_award_id uuid not null,
  shared_award_source_id uuid,
  candidate_snapshot jsonb not null check (
    pg_catalog.jsonb_typeof(candidate_snapshot) = 'object'
  ),
  candidate_snapshot_hash text not null check (
    candidate_snapshot_hash ~ '^[0-9a-f]{64}$'
  ),
  trigger_depth integer not null check (trigger_depth > 1),
  archive_contract text not null default 'rejected-candidate-fk-lifecycle-v1'
    check (archive_contract = 'rejected-candidate-fk-lifecycle-v1'),
  archived_at timestamptz not null,
  unique (candidate_id, lifecycle_action),
  constraint terminal_candidate_archive_snapshot_identity_check check (
    candidate_snapshot ->> 'id' = candidate_id::text
    and candidate_snapshot ->> 'shared_award_id' = shared_award_id::text
    and (
      candidate_snapshot ->> 'shared_award_source_id'
    ) is not distinct from shared_award_source_id::text
    and candidate_snapshot ->> 'candidate_status' = 'rejected'
  ),
  constraint terminal_candidate_archive_action_check check (
    lifecycle_action <> 'source_deleted'
    or shared_award_source_id is not null
  )
);

create index shared_award_fact_candidate_terminal_archive_award_idx
  on public.shared_award_fact_candidate_terminal_archive (
    shared_award_id,
    archived_at desc,
    candidate_id
  );

alter table public.shared_award_fact_candidate_terminal_archive
  enable row level security;
revoke all on table public.shared_award_fact_candidate_terminal_archive
  from public, anon, authenticated, service_role;
grant select on table public.shared_award_fact_candidate_terminal_archive
  to service_role;

-- Normal service DML remains available, but TRUNCATE would bypass row triggers
-- and TRIGGER privilege could install an alternate mutation path. Neither is
-- required by reconciliation or parent-row lifecycle operations.
revoke truncate, trigger on table
  public.shared_awards,
  public.shared_award_sources,
  public.shared_award_fact_candidates
from service_role;

comment on table public.shared_award_fact_candidate_terminal_archive is
  'Append-only hash-bound snapshots of rejected candidates detached or deleted exclusively by database foreign-key lifecycle actions.';

create or replace function private.prevent_terminal_candidate_archive_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Rejected-candidate lifecycle archives are append-only.';
end;
$$;

revoke all on function private.prevent_terminal_candidate_archive_mutation()
  from public, anon, authenticated, service_role;

create trigger awardping_terminal_candidate_archive_immutable
before update or delete on public.shared_award_fact_candidate_terminal_archive
for each row
execute function private.prevent_terminal_candidate_archive_mutation();

create or replace function public.awardping_enforce_fact_candidate_status_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_material_changed boolean;
  v_source_fk_detach boolean := false;
  v_snapshot jsonb;
  v_archived_at timestamptz;
  v_trigger_depth integer := pg_catalog.pg_trigger_depth();
begin
  if tg_op = 'DELETE' then
    if old.candidate_status = 'rejected' then
      -- A direct child DELETE executes at depth 1 and remains forbidden. The
      -- award's ON DELETE CASCADE executes from PostgreSQL's parent FK trigger
      -- at a deeper level after the parent row is no longer visible.
      if v_trigger_depth <= 1 or exists (
        select 1
        from public.shared_awards award
        where award.id = old.shared_award_id
      ) then
        raise exception using
          errcode = '55000',
          message = 'A rejected fact candidate is terminal and cannot be deleted.';
      end if;

      v_snapshot := pg_catalog.to_jsonb(old);
      v_archived_at := pg_catalog.clock_timestamp();
      insert into public.shared_award_fact_candidate_terminal_archive (
        candidate_id,
        lifecycle_action,
        shared_award_id,
        shared_award_source_id,
        candidate_snapshot,
        candidate_snapshot_hash,
        trigger_depth,
        archived_at
      ) values (
        old.id,
        'award_deleted',
        old.shared_award_id,
        old.shared_award_source_id,
        v_snapshot,
        public.stage1_publication_evidence_hash(v_snapshot),
        v_trigger_depth,
        v_archived_at
      );
    end if;
    return old;
  end if;

  if new.id is distinct from old.id then
    raise exception using
      errcode = '55000',
      message = 'A fact candidate identity is immutable.';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception using
      errcode = '55000',
      message = 'A fact candidate creation timestamp is immutable.';
  end if;

  -- updated_at is a database-managed CAS version, not candidate material.
  -- Comparing every other column automatically protects future evidence fields
  -- that may be added after this migration.
  v_material_changed :=
    (pg_catalog.to_jsonb(new) - 'updated_at') is distinct from
    (pg_catalog.to_jsonb(old) - 'updated_at');

  -- The source's ON DELETE SET NULL is the only permitted material rewrite of
  -- a rejected candidate. Require all of PostgreSQL's FK-action signals: a
  -- nested trigger, the old parent already absent, null as the new FK value,
  -- and byte-equivalent candidate material after excluding that one FK.
  if old.candidate_status = 'rejected'
    and old.shared_award_source_id is not null
    and new.shared_award_source_id is null
    and v_trigger_depth > 1
    and not exists (
      select 1
      from public.shared_award_sources source
      where source.id = old.shared_award_source_id
    )
    and (
      pg_catalog.to_jsonb(new) - 'updated_at' - 'shared_award_source_id'
    ) is not distinct from (
      pg_catalog.to_jsonb(old) - 'updated_at' - 'shared_award_source_id'
    ) then
    v_source_fk_detach := true;
  end if;

  if v_source_fk_detach then
    v_snapshot := pg_catalog.to_jsonb(old);
    v_archived_at := pg_catalog.clock_timestamp();
    insert into public.shared_award_fact_candidate_terminal_archive (
      candidate_id,
      lifecycle_action,
      shared_award_id,
      shared_award_source_id,
      candidate_snapshot,
      candidate_snapshot_hash,
      trigger_depth,
      archived_at
    ) values (
      old.id,
      'source_deleted',
      old.shared_award_id,
      old.shared_award_source_id,
      v_snapshot,
      public.stage1_publication_evidence_hash(v_snapshot),
      v_trigger_depth,
      v_archived_at
    );
    new.updated_at := greatest(
      pg_catalog.clock_timestamp(),
      old.updated_at + interval '1 microsecond'
    );
    return new;
  end if;

  if old.candidate_status = 'rejected' and v_material_changed then
    raise exception using
      errcode = '55000',
      message = 'A rejected fact candidate is terminal and its material state is immutable.';
  end if;

  if v_material_changed then
    new.updated_at := greatest(
      pg_catalog.clock_timestamp(),
      old.updated_at + interval '1 microsecond'
    );
  else
    -- A true no-op, including an attempted standalone version rewrite, keeps
    -- the prior CAS version and cannot fire the semantic invalidation path.
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

revoke all on function public.awardping_enforce_fact_candidate_status_lifecycle()
  from public, anon, authenticated, service_role;

drop trigger if exists awardping_fact_candidate_status_lifecycle
  on public.shared_award_fact_candidates;
create trigger awardping_fact_candidate_status_lifecycle
before update or delete on public.shared_award_fact_candidates
for each row
execute function public.awardping_enforce_fact_candidate_status_lifecycle();

-- Parent deletes must acquire the same national lock before PostgreSQL locks a
-- parent row and invokes candidate SET NULL/CASCADE actions. Otherwise a
-- reconciliation can hold the national lock while waiting on the parent as
-- the delete waits on the candidate statement fence in reverse order.
drop trigger if exists stage1_candidate_parent_award_delete_release_fence
  on public.shared_awards;
create trigger stage1_candidate_parent_award_delete_release_fence
before delete on public.shared_awards
for each statement
execute function public.stage1_evidence_release_fence_before_statement();

drop trigger if exists stage1_candidate_parent_source_delete_release_fence
  on public.shared_award_sources;
create trigger stage1_candidate_parent_source_delete_release_fence
before delete on public.shared_award_sources
for each statement
execute function public.stage1_evidence_release_fence_before_statement();

create or replace function public.invalidate_stage1_publication_on_fact_candidate_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_award_ids uuid[] := '{}'::uuid[];
  v_cohort_keys text[] := '{}'::text[];
  v_invalidated_at timestamptz := pg_catalog.clock_timestamp();
  v_invalidated_count integer := 0;
  v_evidence jsonb;
begin
  if tg_op = 'UPDATE' and not (
    old.shared_award_id is distinct from new.shared_award_id
    or old.shared_award_source_id is distinct from new.shared_award_source_id
    or old.source_url is distinct from new.source_url
    or old.source_title is distinct from new.source_title
    or old.source_role is distinct from new.source_role
    or old.source_quality_decision is distinct from new.source_quality_decision
    or old.field_name is distinct from new.field_name
    or old.raw_value is distinct from new.raw_value
    or old.normalized_value is distinct from new.normalized_value
    or old.evidence_quote is distinct from new.evidence_quote
    or old.evidence_location is distinct from new.evidence_location
    or old.extracted_at is distinct from new.extracted_at
    or old.model is distinct from new.model
    or old.confidence is distinct from new.confidence
    or old.candidate_status is distinct from new.candidate_status
    -- Disposition reasons are reviewed provenance. A changed ranking or
    -- rejection rationale must invalidate the reviewed release even when the
    -- candidate value and public text remain byte-for-byte equal.
    or old.selected_reason is distinct from new.selected_reason
    or old.rejection_reason is distinct from new.rejection_reason
    or old.source_page_request_id is distinct from new.source_page_request_id
    or old.intake_value_sha256 is distinct from new.intake_value_sha256
    or old.metadata is distinct from new.metadata
  ) then
    return new;
  end if;

  if tg_op <> 'DELETE' then
    v_award_ids := pg_catalog.array_append(v_award_ids, new.shared_award_id);
  end if;
  if tg_op <> 'INSERT' then
    v_award_ids := pg_catalog.array_append(v_award_ids, old.shared_award_id);
  end if;

  select coalesce(
    pg_catalog.array_agg(distinct member.cohort_key order by member.cohort_key),
    '{}'::text[]
  )
  into v_cohort_keys
  from public.stage1_award_members member
  where member.shared_award_id = any(v_award_ids);

  if pg_catalog.cardinality(v_cohort_keys) = 0 then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  v_evidence := pg_catalog.jsonb_build_object(
    'trigger_table', tg_table_name,
    'operation', tg_op,
    'candidate_id', case when tg_op = 'DELETE' then old.id else new.id end,
    'cohort_keys', pg_catalog.to_jsonb(v_cohort_keys),
    'invalidated_at', v_invalidated_at
  );

  with invalidated as (
    update public.stage1_award_registry registry
    set
      publication_state = 'revalidation_pending',
      release_epoch = null,
      state_reason = 'A fact-candidate evidence binding changed; fresh Stage 1 verification is required.',
      evidence_checked_at = null,
      updated_at = v_invalidated_at
    where registry.cohort_key = any(v_cohort_keys)
      and registry.publication_state = 'verified_beta'
    returning registry.cohort_key, registry.policy_version
  )
  insert into public.stage1_award_publication_events (
    cohort_key,
    previous_state,
    next_state,
    reason,
    policy_version,
    evidence_snapshot,
    evidence_hash,
    actor
  )
  select
    invalidated.cohort_key,
    'verified_beta',
    'revalidation_pending',
    'A fact-candidate evidence binding changed; fresh Stage 1 verification is required.',
    invalidated.policy_version,
    v_evidence,
    public.stage1_publication_evidence_hash(v_evidence),
    'database-trigger'
  from invalidated;

  get diagnostics v_invalidated_count = row_count;

  if v_invalidated_count > 0 then
    perform public.invalidate_stage1_cohort_release(
      'A Stage 1 fact-candidate evidence binding changed; the 25-award release requires revalidation.',
      'database-trigger'
    );
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.invalidate_stage1_publication_on_fact_candidate_change()
  from public, anon, authenticated, service_role;

drop trigger if exists stage1_candidate_release_fence_before_statement
  on public.shared_award_fact_candidates;
create trigger stage1_candidate_release_fence_before_statement
before insert or update or delete on public.shared_award_fact_candidates
for each statement
execute function public.stage1_evidence_release_fence_before_statement();

drop trigger if exists stage1_candidate_invalidate_publication
  on public.shared_award_fact_candidates;
create trigger stage1_candidate_invalidate_publication
after insert or update of
  shared_award_id,
  shared_award_source_id,
  source_url,
  source_title,
  source_role,
  source_quality_decision,
  field_name,
  raw_value,
  normalized_value,
  evidence_quote,
  evidence_location,
  extracted_at,
  model,
  confidence,
  candidate_status,
  selected_reason,
  rejection_reason,
  source_page_request_id,
  intake_value_sha256,
  metadata
or delete on public.shared_award_fact_candidates
for each row
execute function public.invalidate_stage1_publication_on_fact_candidate_change();

-- Queue/audit outcomes can make the effective Stage 1 predicate fail even
-- when every candidate disposition is a true no-op. Centralize the matching
-- registry/release transition so blocked commits and terminal claim finishes
-- cannot leave an authoritative verified_beta epoch behind. Callers acquire
-- the national advisory lock before touching their queue row; this helper
-- reacquires it transaction-reentrantly as defense in depth.
create or replace function private.invalidate_stage1_reconciliation_outcome(
  p_shared_award_id uuid,
  p_reason text,
  p_actor text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invalidated_at timestamptz := pg_catalog.clock_timestamp();
  v_invalidated_count integer := 0;
  v_reason text := coalesce(
    nullif(pg_catalog.btrim(p_reason), ''),
    'A Stage 1 reconciliation outcome requires fresh verification.'
  );
  v_actor text := coalesce(
    nullif(pg_catalog.btrim(p_actor), ''),
    'reconciliation-worker'
  );
  v_evidence jsonb;
begin
  if p_shared_award_id is null then
    return 0;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  v_evidence := pg_catalog.jsonb_build_object(
    'trigger_table', 'shared_award_reconciliation_queue',
    'shared_award_id', p_shared_award_id,
    'reason', v_reason,
    'invalidated_at', v_invalidated_at
  );

  with affected as (
    select distinct member.cohort_key
    from public.stage1_award_members member
    where member.shared_award_id = p_shared_award_id
  ), invalidated as (
    update public.stage1_award_registry registry
    set
      publication_state = 'revalidation_pending',
      release_epoch = null,
      state_reason = v_reason,
      evidence_checked_at = null,
      updated_at = v_invalidated_at
    from affected
    where registry.cohort_key = affected.cohort_key
      and registry.publication_state = 'verified_beta'
    returning registry.cohort_key, registry.policy_version
  )
  insert into public.stage1_award_publication_events (
    cohort_key,
    previous_state,
    next_state,
    reason,
    policy_version,
    evidence_snapshot,
    evidence_hash,
    actor
  )
  select
    invalidated.cohort_key,
    'verified_beta',
    'revalidation_pending',
    v_reason,
    invalidated.policy_version,
    v_evidence,
    public.stage1_publication_evidence_hash(v_evidence),
    v_actor
  from invalidated;

  get diagnostics v_invalidated_count = row_count;

  if v_invalidated_count > 0 then
    perform public.invalidate_stage1_cohort_release(v_reason, v_actor);
  end if;

  return v_invalidated_count;
end;
$$;

revoke all on function private.invalidate_stage1_reconciliation_outcome(
  uuid, text, text
) from public, anon, authenticated, service_role;

comment on function private.invalidate_stage1_reconciliation_outcome(
  uuid, text, text
) is
  'Idempotently invalidates the Stage 1 award and national release after a terminal reconciliation outcome; internal callers must hold the national advisory lock before queue mutation.';

create or replace function public.finish_or_requeue_award_reconciliation_claim(
  p_reconciliation_id uuid,
  p_shared_award_id uuid,
  p_expected_started_at timestamptz,
  p_expected_queue_generation bigint,
  p_terminal_status text,
  p_error text
)
returns public.shared_award_reconciliation_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queue public.shared_award_reconciliation_queue%rowtype;
begin
  if p_reconciliation_id is null
    or p_shared_award_id is null
    or p_expected_started_at is null
    or p_expected_queue_generation is null then
    raise exception using
      errcode = '22004',
      message = 'Reconciliation claim identities are required.';
  end if;
  if p_terminal_status not in ('failed', 'skipped', 'pending') then
    raise exception using
      errcode = '22023',
      message = 'Only failed, skipped, or pending reconciliation outcomes are accepted.';
  end if;

  -- Terminal outcomes participate in the national release lock order even
  -- when the supplied award is not currently a Stage 1 member. Membership can
  -- change only behind the same lock, so this avoids a check-then-lock race.
  -- A pending/requeue outcome deliberately does not acquire or invalidate.
  if p_terminal_status in ('failed', 'skipped') then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('stage1-national-25-release', 0)
    );
  end if;

  select queue.*
  into v_queue
  from public.shared_award_reconciliation_queue queue
  where queue.id = p_reconciliation_id
  for update;

  if not found
    or v_queue.shared_award_id <> p_shared_award_id
    or v_queue.status <> 'processing'
    or v_queue.started_at is distinct from p_expected_started_at
    or v_queue.completed_at is not null then
    return null;
  end if;

  if v_queue.generation is distinct from p_expected_queue_generation then
    update public.shared_award_reconciliation_queue queue
    set
      status = 'pending',
      started_at = null,
      completed_at = null,
      error = 'requeued_after_trigger_during_processing'
    where queue.id = p_reconciliation_id
      and queue.status = 'processing'
      and queue.started_at = p_expected_started_at
    returning queue.* into v_queue;
    return v_queue;
  end if;

  if p_terminal_status = 'pending' then
    update public.shared_award_reconciliation_queue queue
    set
      status = 'pending',
      started_at = null,
      completed_at = null,
      error = pg_catalog.left(
        coalesce(p_error, 'requeued_after_transient_reconciliation_conflict'),
        1000
      )
    where queue.id = p_reconciliation_id
      and queue.status = 'processing'
      and queue.started_at = p_expected_started_at
      and queue.generation = p_expected_queue_generation
      and queue.completed_at is null
    returning queue.* into v_queue;
    return v_queue;
  end if;

  update public.shared_award_reconciliation_queue queue
  set
    status = p_terminal_status,
    completed_at = pg_catalog.statement_timestamp(),
    error = pg_catalog.left(coalesce(p_error, p_terminal_status), 1000)
  where queue.id = p_reconciliation_id
    and queue.status = 'processing'
    and queue.started_at = p_expected_started_at
    and queue.generation = p_expected_queue_generation
    and queue.completed_at is null
  returning queue.* into v_queue;

  if not found then
    return null;
  end if;

  perform private.invalidate_stage1_reconciliation_outcome(
    p_shared_award_id,
    pg_catalog.format(
      'A Stage 1 reconciliation ended %s; fresh verification is required.',
      p_terminal_status
    ),
    'reconciliation-worker'
  );

  return v_queue;
end;
$$;

revoke all on function public.finish_or_requeue_award_reconciliation_claim(
  uuid, uuid, timestamptz, bigint, text, text
) from public, anon, authenticated;
grant execute on function public.finish_or_requeue_award_reconciliation_claim(
  uuid, uuid, timestamptz, bigint, text, text
) to service_role;

create or replace function public.commit_award_reconciliation_blocked(
  p_reconciliation_id uuid,
  p_shared_award_id uuid,
  p_expected_started_at timestamptz,
  p_expected_queue_generation bigint,
  p_expected_award_updated_at timestamptz,
  p_expected_public_facts jsonb,
  p_generated_candidates jsonb,
  p_candidate_status_updates jsonb,
  p_audit_row jsonb,
  p_failure_reason text
)
returns public.shared_award_reconciliation_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queue public.shared_award_reconciliation_queue%rowtype;
  v_award public.shared_awards%rowtype;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_generated_count integer := 0;
  v_updated_candidate_count integer := 0;
begin
  if p_reconciliation_id is null
    or p_shared_award_id is null
    or p_expected_started_at is null
    or p_expected_queue_generation is null
    or p_expected_award_updated_at is null then
    raise exception using
      errcode = '22004',
      message = 'Reconciliation, award, claim, and award-version identities are required.';
  end if;
  if pg_catalog.jsonb_typeof(p_expected_public_facts) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_generated_candidates) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_candidate_status_updates) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row) is distinct from 'object'
    or nullif(pg_catalog.btrim(p_failure_reason), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Blocked reconciliation inputs are incomplete or malformed.';
  end if;

  -- A blocked outcome is terminal. Acquire the national fence before the
  -- queue/award rows so promotion and invalidation share one lock order, and
  -- so a concurrent Stage 1 membership change cannot create a race.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  select queue.*
  into v_queue
  from public.shared_award_reconciliation_queue queue
  where queue.id = p_reconciliation_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Reconciliation queue row does not exist.';
  end if;
  if v_queue.shared_award_id <> p_shared_award_id
    or v_queue.status <> 'processing'
    or v_queue.started_at is distinct from p_expected_started_at
    or v_queue.completed_at is not null then
    raise exception using
      errcode = '40001',
      message = 'Reconciliation claim is stale or is no longer owned by this worker.';
  end if;

  if v_queue.generation is distinct from p_expected_queue_generation then
    update public.shared_award_reconciliation_queue queue
    set
      status = 'pending',
      started_at = null,
      completed_at = null,
      error = 'requeued_after_trigger_during_processing'
    where queue.id = p_reconciliation_id
      and queue.status = 'processing'
      and queue.started_at = p_expected_started_at
    returning queue.* into v_queue;
    if not found then
      raise exception using
        errcode = '40001',
        message = 'Reconciliation claim changed before its follow-up could be preserved.';
    end if;
    return v_queue;
  end if;

  select award.*
  into v_award
  from public.shared_awards award
  where award.id = p_shared_award_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Shared award does not exist.';
  end if;
  if v_award.updated_at is distinct from p_expected_award_updated_at
    or v_award.public_facts is distinct from p_expected_public_facts then
    raise exception using
      errcode = '40001',
      message = 'Shared award changed after reconciliation began; retry with fresh inputs.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_generated_candidates) generated(value)
    where pg_catalog.jsonb_typeof(generated.value) is distinct from 'object'
      or coalesce(generated.value ->> 'id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(generated.value ->> 'shared_award_id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(generated.value ->> 'shared_award_source_id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or nullif(pg_catalog.btrim(generated.value ->> 'field_name'), '') is null
      or generated.value ->> 'candidate_status' not in (
        'pending', 'selected', 'rejected', 'conflicted', 'superseded'
      )
      or not (generated.value ? 'normalized_value')
      or pg_catalog.jsonb_typeof(
        generated.value -> 'source_quality_decision'
      ) is distinct from 'object'
      or pg_catalog.jsonb_typeof(generated.value -> 'metadata') is distinct from 'object'
      or coalesce(generated.value -> 'source_page_request_id', 'null'::jsonb)
        is distinct from 'null'::jsonb
      or coalesce(generated.value -> 'intake_value_sha256', 'null'::jsonb)
        is distinct from 'null'::jsonb
  ) then
    raise exception using
      errcode = '22023',
      message = 'A generated fact candidate is malformed or claims a paid-intake identity.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_candidate_status_updates) mutation(value)
    where pg_catalog.jsonb_typeof(mutation.value) is distinct from 'object'
      or coalesce(mutation.value ->> 'id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or mutation.value ->> 'expected_status' not in (
        'pending', 'selected', 'rejected', 'conflicted', 'superseded'
      )
      or mutation.value ->> 'candidate_status' not in (
        'pending', 'selected', 'rejected', 'conflicted', 'superseded'
      )
      or (
        mutation.value ->> 'expected_status' = 'rejected'
        and mutation.value ->> 'candidate_status' <> 'rejected'
      )
      or nullif(mutation.value ->> 'expected_updated_at', '') is null
  ) then
    raise exception using
      errcode = '22023',
      message = 'A fact candidate status mutation is malformed or revives terminal rejection.';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_generated_candidates) generated(value)
  ) <> (
    select pg_catalog.count(distinct generated.value ->> 'id')
    from pg_catalog.jsonb_array_elements(p_generated_candidates) generated(value)
  ) or (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_candidate_status_updates) mutation(value)
  ) <> (
    select pg_catalog.count(distinct mutation.value ->> 'id')
    from pg_catalog.jsonb_array_elements(p_candidate_status_updates) mutation(value)
  ) or exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_generated_candidates) generated(value)
    join pg_catalog.jsonb_array_elements(p_candidate_status_updates) mutation(value)
      on mutation.value ->> 'id' = generated.value ->> 'id'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Candidate mutation identities must be unique and disjoint.';
  end if;

  if coalesce(p_audit_row ->> 'shared_award_id', '') !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or (p_audit_row ->> 'shared_award_id')::uuid <> p_shared_award_id
    or p_audit_row ->> 'audit_kind' is distinct from 'deterministic'
    or p_audit_row ->> 'audit_status' not in (
      'warnings', 'failed', 'needs_review'
    )
    or p_audit_row ->> 'severity' not in (
      'warning', 'error', 'critical'
    )
    or pg_catalog.jsonb_typeof(p_audit_row -> 'findings') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'suggested_fixes') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'field_conflicts') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'source_rejections') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'selected_fact_summary') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_audit_row -> 'public_page_snapshot') is distinct from 'object'
    or coalesce(
      p_audit_row #>> array[
        'public_page_snapshot',
        'reconciliation_audit_signature'
      ],
      ''
    ) !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'The blocked deterministic audit is malformed.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_generated_candidates) generated(value)
    left join public.shared_award_sources source
      on source.id = (generated.value ->> 'shared_award_source_id')::uuid
    left join public.shared_award_fact_candidates existing_candidate
      on existing_candidate.id = (generated.value ->> 'id')::uuid
    where existing_candidate.id is not null
      or source.id is null
      or source.shared_award_id is distinct from
        (generated.value ->> 'shared_award_id')::uuid
      or not (
        source.shared_award_id = p_shared_award_id
        or exists (
          select 1
          from public.stage1_award_members target_member
          join public.stage1_award_members source_member
            on source_member.cohort_key = target_member.cohort_key
          where target_member.shared_award_id = p_shared_award_id
            and source_member.shared_award_id = source.shared_award_id
        )
      )
  ) then
    raise exception using
      errcode = '23503',
      message = 'A generated candidate identity or source is missing or outside the reconciled award scope.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_candidate_status_updates) mutation(value)
    left join public.shared_award_fact_candidates candidate
      on candidate.id = (mutation.value ->> 'id')::uuid
    where candidate.id is null
      or not (
        candidate.shared_award_id = p_shared_award_id
        or exists (
          select 1
          from public.stage1_award_members target_member
          join public.stage1_award_members candidate_member
            on candidate_member.cohort_key = target_member.cohort_key
          where target_member.shared_award_id = p_shared_award_id
            and candidate_member.shared_award_id = candidate.shared_award_id
        )
      )
  ) then
    raise exception using
      errcode = '23503',
      message = 'A candidate status mutation targets a missing or out-of-scope candidate.';
  end if;

  insert into public.shared_award_fact_candidates (
    id,
    shared_award_id,
    shared_award_source_id,
    source_url,
    source_title,
    source_role,
    source_quality_decision,
    field_name,
    raw_value,
    normalized_value,
    evidence_quote,
    evidence_location,
    extracted_at,
    model,
    confidence,
    candidate_status,
    rejection_reason,
    selected_reason,
    source_page_request_id,
    intake_value_sha256,
    metadata,
    created_at,
    updated_at
  )
  select
    generated.id,
    generated.shared_award_id,
    generated.shared_award_source_id,
    generated.source_url,
    generated.source_title,
    generated.source_role,
    generated.source_quality_decision,
    generated.field_name,
    generated.raw_value,
    generated.normalized_value,
    generated.evidence_quote,
    generated.evidence_location,
    generated.extracted_at,
    generated.model,
    generated.confidence,
    generated.candidate_status,
    generated.rejection_reason,
    generated.selected_reason,
    generated.source_page_request_id,
    generated.intake_value_sha256,
    generated.metadata,
    v_now,
    v_now
  from pg_catalog.jsonb_to_recordset(p_generated_candidates) as generated(
    id uuid,
    shared_award_id uuid,
    shared_award_source_id uuid,
    source_url text,
    source_title text,
    source_role text,
    source_quality_decision jsonb,
    field_name text,
    raw_value text,
    normalized_value jsonb,
    evidence_quote text,
    evidence_location text,
    extracted_at timestamptz,
    model text,
    confidence text,
    candidate_status text,
    rejection_reason text,
    selected_reason text,
    source_page_request_id uuid,
    intake_value_sha256 text,
    metadata jsonb
  );

  get diagnostics v_generated_count = row_count;
  if v_generated_count <> pg_catalog.jsonb_array_length(p_generated_candidates) then
    raise exception using
      errcode = 'P0001',
      message = 'Not every generated fact candidate was persisted.';
  end if;

  update public.shared_award_fact_candidates candidate
  set
    candidate_status = mutation.candidate_status,
    selected_reason = mutation.selected_reason,
    rejection_reason = mutation.rejection_reason,
    updated_at = v_now
  from pg_catalog.jsonb_to_recordset(p_candidate_status_updates) as mutation(
    id uuid,
    expected_status text,
    expected_updated_at timestamptz,
    candidate_status text,
    selected_reason text,
    rejection_reason text
  )
  where candidate.id = mutation.id
    and candidate.candidate_status = mutation.expected_status
    and candidate.updated_at = mutation.expected_updated_at;

  get diagnostics v_updated_candidate_count = row_count;
  if v_updated_candidate_count <>
      pg_catalog.jsonb_array_length(p_candidate_status_updates) then
    raise exception using
      errcode = '40001',
      message = 'A fact candidate changed before the blocked reconciliation commit.';
  end if;

  insert into public.shared_award_page_audits (
    shared_award_id,
    audit_kind,
    audit_status,
    severity,
    findings,
    suggested_fixes,
    field_conflicts,
    source_rejections,
    selected_fact_summary,
    public_page_snapshot,
    model
  )
  select
    p_shared_award_id,
    p_audit_row ->> 'audit_kind',
    p_audit_row ->> 'audit_status',
    p_audit_row ->> 'severity',
    p_audit_row -> 'findings',
    p_audit_row -> 'suggested_fixes',
    p_audit_row -> 'field_conflicts',
    p_audit_row -> 'source_rejections',
    p_audit_row -> 'selected_fact_summary',
    p_audit_row -> 'public_page_snapshot',
    p_audit_row ->> 'model'
  where not exists (
    select 1
    from public.shared_award_page_audits audit
    where audit.shared_award_id = p_shared_award_id
      and audit.audit_kind = 'deterministic'
      and audit.public_page_snapshot @> pg_catalog.jsonb_build_object(
        'reconciliation_audit_signature',
        p_audit_row #>> array[
          'public_page_snapshot',
          'reconciliation_audit_signature'
        ]
      )
  );

  update public.shared_award_reconciliation_queue queue
  set
    status = 'failed',
    completed_at = v_now,
    error = pg_catalog.left(p_failure_reason, 1000)
  where queue.id = p_reconciliation_id
    and queue.shared_award_id = p_shared_award_id
    and queue.status = 'processing'
    and queue.started_at = p_expected_started_at
    and queue.generation = p_expected_queue_generation
    and queue.completed_at is null
  returning queue.* into v_queue;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'Reconciliation claim changed before the blocked outcome commit.';
  end if;

  perform private.invalidate_stage1_reconciliation_outcome(
    p_shared_award_id,
    'A deterministic reconciliation was blocked; fresh Stage 1 verification is required.',
    'reconciliation-worker'
  );

  return v_queue;
end;
$$;

revoke all on function public.commit_award_reconciliation_blocked(
  uuid,
  uuid,
  timestamptz,
  bigint,
  timestamptz,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  text
) from public, anon, authenticated;
grant execute on function public.commit_award_reconciliation_blocked(
  uuid,
  uuid,
  timestamptz,
  bigint,
  timestamptz,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  text
) to service_role;

comment on function public.commit_award_reconciliation_blocked(
  uuid,
  uuid,
  timestamptz,
  bigint,
  timestamptz,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  text
) is
  'CAS-protected atomic commit for a blocked deterministic reconciliation: candidate materialization/disposition, audit evidence, and failed-or-requeued queue outcome.';
