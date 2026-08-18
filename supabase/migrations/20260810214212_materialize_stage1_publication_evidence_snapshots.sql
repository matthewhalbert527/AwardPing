-- Keep each expensive publication input on one statement-consistent read.
-- PostgreSQL can inline a singly referenced CTE; without MATERIALIZED the
-- crop snapshot is duplicated into every JSON-field comparison below and is
-- repeatedly evaluated while planning the RPC.  The evidence predicates and
-- fail-closed reasons are unchanged.
create or replace function public.list_stage1_effective_publication()
returns table (
  cohort_key text,
  effectively_verified boolean,
  effective_reason text,
  evaluated_at timestamptz,
  cohort_ready boolean,
  cohort_readiness_reason text,
  release_epoch uuid,
  release_state text,
  release_policy_version text,
  release_identity_version text,
  release_identity_hash text
)
language sql
stable
security definer
set search_path = ''
as $$
  with evaluation as (
    select pg_catalog.statement_timestamp() as evaluated_at
  ), base as (
    select *
    from public.stage1_effective_pub_pre_r2_graph_20260810184524()
  ), objects as (
    select private.stage1_visual_r2_object_set_snapshot() as value
  ), coverage as materialized (
    select private.stage1_visual_crop_coverage_snapshot() as value
  ), runtime_artifact as (
    select artifact.*
    from evaluation
    cross join lateral private.stage1_current_valid_release_artifact(
      'hosted_runtime_identity', evaluation.evaluated_at
    ) artifact
    where artifact.completed_at >=
      evaluation.evaluated_at - interval '1 hour'
    limit 1
  ), r2_artifact as (
    select artifact.*
    from evaluation
    cross join objects
    cross join runtime_artifact runtime
    cross join lateral private.stage1_current_valid_release_artifact(
      'r2_recovery_drill', evaluation.evaluated_at
    ) artifact
    where artifact.app_revision = runtime.app_revision
      and private.stage1_r2_recovery_evidence_matches_snapshot(
        artifact.evidence, objects.value
      )
    limit 1
  ), r2_release_proof as (
    select exists (select 1 from r2_artifact) as current
  ), crop_artifact as (
    select artifact.*
    from evaluation
    cross join objects
    cross join coverage
    cross join runtime_artifact runtime
    cross join r2_artifact r2
    cross join lateral private.stage1_current_valid_release_artifact(
      'visual_crop_coverage', evaluation.evaluated_at
    ) artifact
    where artifact.producer_kind = 'database_derived'
      and artifact.app_revision = runtime.app_revision
      and artifact.evidence ->> 'eligible_events' =
        coverage.value ->> 'eligible_events'
      and artifact.evidence ->> 'verified_events' =
        coverage.value ->> 'verified_events'
      and artifact.evidence ->> 'unverified_publishable_events' =
        coverage.value ->> 'unverified_publishable_events'
      and artifact.evidence ->> 'terminal_failures' =
        coverage.value ->> 'terminal_failures'
      and artifact.evidence ->> 'pdf_evidence_failures' =
        coverage.value ->> 'pdf_evidence_failures'
      and artifact.evidence ->> 'coverage_set_hash' =
        coverage.value ->> 'coverage_set_hash'
      and artifact.evidence ->> 'reference_schema' =
        coverage.value ->> 'reference_schema'
      and artifact.evidence ->> 'visual_object_count' =
        objects.value ->> 'visual_object_count'
      and artifact.evidence ->> 'visual_reference_count' =
        objects.value ->> 'visual_reference_count'
      and artifact.evidence ->> 'published_event_object_count' =
        objects.value ->> 'published_event_object_count'
      and artifact.evidence ->> 'published_event_reference_count' =
        objects.value ->> 'published_event_reference_count'
      and artifact.evidence ->> 'manifest_source_object_count' =
        objects.value ->> 'manifest_source_object_count'
      and artifact.evidence ->> 'manifest_source_reference_count' =
        objects.value ->> 'manifest_source_reference_count'
      and artifact.evidence ->> 'alias_reference_count' =
        objects.value ->> 'alias_reference_count'
      and artifact.evidence ->> 'aliased_object_count' =
        objects.value ->> 'aliased_object_count'
      and artifact.evidence ->> 'reference_set_hash' =
        objects.value ->> 'reference_set_hash'
      and artifact.evidence ->> 'visual_object_set_hash' =
        objects.value ->> 'visual_object_set_hash'
      and artifact.evidence ->> 'derivation_contract_hash' =
        private.stage1_visual_crop_derivation_contract_hash()
      and artifact.evidence ->> 'r2_hashes_verified' = 'true'
      and artifact.evidence ->> 'r2_artifact_id' = r2.id::text
    limit 1
  ), crop_release_proof as (
    select exists (select 1 from crop_artifact) as current
  )
  select
    base.cohort_key,
    base.effectively_verified
      and r2_release_proof.current
      and crop_release_proof.current,
    case
      when not r2_release_proof.current
        then 'signed_r2_recovery_artifact_not_current'
      when not crop_release_proof.current
        then 'database_derived_crop_artifact_not_current'
      else base.effective_reason
    end,
    base.evaluated_at,
    base.cohort_ready,
    base.cohort_readiness_reason,
    base.release_epoch,
    base.release_state,
    base.release_policy_version,
    base.release_identity_version,
    base.release_identity_hash
  from base
  join public.stage1_award_registry registry
    on registry.cohort_key = base.cohort_key
  cross join r2_release_proof
  cross join crop_release_proof
  order by registry.launch_rank;
$$;

revoke all on function public.list_stage1_effective_publication()
  from public, anon, authenticated, service_role;
grant execute on function public.list_stage1_effective_publication()
  to service_role;

comment on function public.list_stage1_effective_publication() is
  'Authoritative Stage 1 publication decision; expensive R2 and crop inputs are materialized once and visibility remains fail closed on current runtime-bound v4 evidence.';
