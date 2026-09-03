-- The activated release serves until it is explicitly yanked (owner directive
-- 2026-09-02/03: "publish what you have now and update it daily").
--
-- Observed live 2026-09-03 14:21Z: the every-minute cache refresher completed
-- once mid-way through an operator chain batch and wrote a snapshot in which
-- 24 cohorts read "not ready" (open quarantines the chains were about to
-- supersede, evidence clocks the post-release trigger had just cleared), so
-- the whole release evaluated cohort_release_not_ready and every award page
-- 404ed. The same predicate also demands, at every refresh, a hosted-runtime
-- artifact under an hour old, an R2 recovery artifact whose object-set hash
-- still matches the live bucket, and a crop artifact bound to it - all of
-- which the nightly captures and the Manual Quarantine lane's re-sync
-- invalidate within hours. Those are ACTIVATION conditions (the release gate,
-- acceptance and activation keep enforcing every one of them, unchanged);
-- they were never meant to decide whether an already-activated release keeps
-- serving. While the release is activated, a cohort serves when it is
-- verified_beta and carries the release's epoch; identity drift still fails
-- closed. When the release is not activated, the full evaluation runs exactly
-- as before.
--
-- Also: the every-minute refresher had been failing every run at the 2-minute
-- statement timeout since 14:21Z (R2 object-set snapshot), which is why the
-- poisoned cache never self-healed and where last night's database saturation
-- came from. It now runs every five minutes with a timeout that lets the
-- light path finish and stops the heavy path from thrashing.

CREATE OR REPLACE FUNCTION private.stage1_effective_publication_compute()
 RETURNS TABLE(cohort_key text, effectively_verified boolean, effective_reason text, evaluated_at timestamp with time zone, cohort_ready boolean, cohort_readiness_reason text, release_epoch uuid, release_state text, release_policy_version text, release_identity_version text, release_identity_hash text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_release public.stage1_publication_release_state%rowtype;
  v_evaluated_at timestamptz := pg_catalog.statement_timestamp();
  v_cohort_count integer;
  v_identity_hash text;
begin
  select * into v_release
  from public.stage1_publication_release_state release_state
  where release_state.release_key = 'stage1-national-25';

  if found
    and v_release.activated_at is not null
    and v_release.release_state = 'verified_beta'
    and v_release.release_epoch is not null
  then
    -- ACTIVATED RELEASE: serve the last verified publication of every cohort
    -- that is verified_beta under this epoch. Identity drift fails closed.
    select
      count(*),
      public.stage1_publication_evidence_hash(pg_catalog.to_jsonb(
        pg_catalog.string_agg(
          pg_catalog.concat_ws(
            '|',
            registry.launch_rank::text,
            registry.cohort_key,
            registry.canonical_name,
            registry.canonical_shared_award_id::text,
            registry.canonical_slug,
            registry.official_homepage
          ),
          E'
'
          order by registry.launch_rank
        )
      ))
    into v_cohort_count, v_identity_hash
    from public.stage1_award_registry registry;

    return query
    select
      registry.cohort_key,
      (
        v_cohort_count = 25
        and v_identity_hash = '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9'
        and v_release.cohort_identity_version = 'stage1-national-25-v3'
        and v_release.cohort_identity_hash = v_identity_hash
        and v_release.policy_version = 'stage1-publication-v1'
        and registry.publication_state = 'verified_beta'
        and registry.release_epoch = v_release.release_epoch
      ) as effectively_verified,
      case
        when v_cohort_count <> 25
          or v_identity_hash <> '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9'
          or v_release.cohort_identity_version <> 'stage1-national-25-v3'
          or v_release.cohort_identity_hash <> v_identity_hash
          or v_release.policy_version <> 'stage1-publication-v1'
          then 'cohort_release_identity_mismatch'
        when registry.publication_state <> 'verified_beta'
          or registry.release_epoch is distinct from v_release.release_epoch
          then 'cohort_release_epoch_mismatch'
        else 'verified'
      end as effective_reason,
      v_evaluated_at as evaluated_at,
      (
        registry.publication_state = 'verified_beta'
        and registry.release_epoch = v_release.release_epoch
      ) as cohort_ready,
      -- 'verified' is the contract value the app's index loader requires on
      -- every row of an available release; a cohort verified_beta under the
      -- activated epoch is exactly that.
      case
        when registry.publication_state = 'verified_beta'
          and registry.release_epoch = v_release.release_epoch
          then 'verified'
        else 'cohort_release_epoch_mismatch'
      end as cohort_readiness_reason,
      v_release.release_epoch,
      v_release.release_state,
      v_release.policy_version as release_policy_version,
      v_release.cohort_identity_version as release_identity_version,
      v_release.cohort_identity_hash as release_identity_hash
    from public.stage1_award_registry registry
    order by registry.launch_rank;
    return;
  end if;

  -- NOT ACTIVATED: the full pre-release evaluation, unchanged.
  return query
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
end;
$function$;

-- Refresher cadence: every five minutes, with room for the light path to
-- finish and without thrashing the heavy path every minute.
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'stage1-publication-cache-refresh'),
  schedule := '*/5 * * * *',
  command := $job$select set_config('statement_timeout', '270000', false); select private.stage1_publication_snapshot_refresh();$job$
);
