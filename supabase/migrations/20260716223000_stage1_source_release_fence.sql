-- A reviewed source ID is not a permanent capability to change its URL or
-- quality metadata. Fence source mutations against national promotion and
-- invalidate the exact cohort before any later public read can reuse it.
-- PostgreSQL acquires the UPDATE/DELETE RowExclusive table lock before firing
-- a BEFORE STATEMENT trigger. Promotion therefore must not request a
-- conflicting SHARE table lock on this table after taking the advisory lock.

create or replace function public.stage1_source_release_fence_before_statement()
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

revoke all on function public.stage1_source_release_fence_before_statement()
  from public, anon, authenticated, service_role;

drop trigger if exists stage1_source_release_fence_before_update
  on public.shared_award_sources;
create trigger stage1_source_release_fence_before_update
before update of
  shared_award_id,
  url,
  admin_review_status,
  title,
  display_title,
  page_metadata,
  page_metadata_generated_at,
  page_metadata_model,
  page_type,
  source,
  reason,
  submitted_by_user_id
on public.shared_award_sources
for each statement
execute function public.stage1_source_release_fence_before_statement();

drop trigger if exists stage1_source_release_fence_before_delete
  on public.shared_award_sources;
create trigger stage1_source_release_fence_before_delete
before delete on public.shared_award_sources
for each statement
execute function public.stage1_source_release_fence_before_statement();

create or replace function public.invalidate_stage1_publication_on_source_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_id uuid := case when tg_op = 'DELETE' then old.id else new.id end;
  v_invalidated_at timestamptz := pg_catalog.clock_timestamp();
  v_evidence jsonb;
  v_invalidated_count integer := 0;
begin
  -- The statement-level trigger acquired this lock before PostgreSQL selected
  -- or locked source rows. Reacquiring it here is transaction-reentrant.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  if tg_op = 'UPDATE' and not (
    old.shared_award_id is distinct from new.shared_award_id
    or old.url is distinct from new.url
    or old.admin_review_status is distinct from new.admin_review_status
    or old.title is distinct from new.title
    or old.display_title is distinct from new.display_title
    or old.page_metadata is distinct from new.page_metadata
    or old.page_metadata_generated_at is distinct from new.page_metadata_generated_at
    or old.page_metadata_model is distinct from new.page_metadata_model
    or old.page_type is distinct from new.page_type
    or old.source is distinct from new.source
    or old.reason is distinct from new.reason
    or old.submitted_by_user_id is distinct from new.submitted_by_user_id
  ) then
    return new;
  end if;

  v_evidence := pg_catalog.jsonb_build_object(
    'trigger_table', tg_table_name,
    'operation', tg_op,
    'shared_award_source_id', v_source_id,
    'previous_url', case when tg_op = 'INSERT' then null else old.url end,
    'current_url', case when tg_op = 'DELETE' then null else new.url end,
    'invalidated_at', v_invalidated_at
  );

  with affected as (
    select distinct manifest.cohort_key
    from public.stage1_award_source_manifest manifest
    where v_source_id = any(manifest.source_ids)
  ), invalidated as (
    update public.stage1_award_registry registry
    set
      publication_state = 'revalidation_pending',
      state_reason = 'A reviewed official source changed; fresh Stage 1 verification is required.',
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
    'A reviewed official source changed; fresh Stage 1 verification is required.',
    invalidated.policy_version,
    v_evidence,
    public.stage1_publication_evidence_hash(v_evidence),
    'database-trigger'
  from invalidated;

  get diagnostics v_invalidated_count = row_count;

  if v_invalidated_count > 0 then
    perform public.invalidate_stage1_cohort_release(
      'A reviewed official source changed; the 25-award release requires revalidation.',
      'database-trigger'
    );
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.invalidate_stage1_publication_on_source_change()
  from public, anon, authenticated, service_role;

drop trigger if exists stage1_source_invalidate_publication_after_update
  on public.shared_award_sources;
create trigger stage1_source_invalidate_publication_after_update
after update of
  shared_award_id,
  url,
  admin_review_status,
  title,
  display_title,
  page_metadata,
  page_metadata_generated_at,
  page_metadata_model,
  page_type,
  source,
  reason,
  submitted_by_user_id
on public.shared_award_sources
for each row
execute function public.invalidate_stage1_publication_on_source_change();

drop trigger if exists stage1_source_invalidate_publication_after_delete
  on public.shared_award_sources;
create trigger stage1_source_invalidate_publication_after_delete
after delete on public.shared_award_sources
for each row
execute function public.invalidate_stage1_publication_on_source_change();
