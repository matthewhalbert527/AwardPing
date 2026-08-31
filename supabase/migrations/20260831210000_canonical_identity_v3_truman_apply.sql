-- Canonical identity v3: the truman identity starts at https://www.truman.gov/apply
-- (owner instruction, 2026-08-31) and the hertz/soros homepages carry their
-- canonical forms (no trailing slash / apex host). The registry, source
-- manifests, facts, reconciliations, and audits already carry these exact
-- values (each cohort was explicit-human-review re-published against them), so
-- unlike the v2 migration no cohort is demoted: this migration re-pins the
-- release machinery's identity literals to the payload the registry already
-- proves, and requires a fresh v3 release acceptance.
--
-- Generated from the live catalog by
-- reports/stage1-review-session-2026-08-18/release/generate-identity-v3-migration.mjs.
-- After applying: re-record all five release artifacts (they embed the
-- identity), refresh the publication caches, and deploy the matching app
-- change in src/lib/stage1-cohort-identity.ts (same commit).

begin;

-- The registry must already carry exactly the v3 identity; fail closed if not.
do $$
declare
  v_payload text;
  v_hash text;
begin
  select pg_catalog.string_agg(
    pg_catalog.concat_ws(
      '|',
      registry.launch_rank::text,
      registry.cohort_key,
      registry.canonical_name,
      registry.canonical_shared_award_id::text,
      registry.canonical_slug,
      registry.official_homepage
    ),
    E'\n'
    order by registry.launch_rank
  ) into v_payload
  from public.stage1_award_registry registry;
  v_hash := public.stage1_publication_evidence_hash(pg_catalog.to_jsonb(v_payload));
  if v_hash is distinct from '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9' then
    raise exception
      'The live registry does not carry the exact v3 identity (computed %); refusing to re-pin.',
      v_hash;
  end if;
end $$;

-- private.insert_stage1_external_release_artifact: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION private.insert_stage1_external_release_artifact(p_artifact_kind text, p_environment text, p_status text, p_cohort_identity_version text, p_cohort_identity_hash text, p_policy_version text, p_app_revision text, p_evidence jsonb, p_expected_evidence_hash text, p_signer_key_id text, p_expected_signed_payload_hash text, p_signature text, p_started_at timestamp with time zone, p_completed_at timestamp with time zone, p_valid_until timestamp with time zone, p_actor text)
 RETURNS stage1_release_acceptance_artifacts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_target jsonb := private.stage1_release_production_target_snapshot();
  v_artifact public.stage1_release_acceptance_artifacts%rowtype;
  v_signer private.stage1_release_evidence_signers%rowtype;
  v_evidence_hash text;
  v_payload_hash text;
  v_secret text;
  v_expected_signature text;
begin
  if p_artifact_kind not in (
    'hosted_runtime_identity',
    'rollback_drill',
    'non_cohort_leak_crawl',
    'r2_recovery_drill'
  ) or p_status not in ('passed', 'failed') then
    raise exception using errcode = '22023',
      message = 'Unknown external Stage 1 evidence kind or status.';
  end if;
  if p_environment <> 'production'
    or p_cohort_identity_version <> 'stage1-national-25-v3'
    or p_cohort_identity_hash <>
      '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9'
    or p_policy_version <> 'stage1-publication-v1' then
    raise exception using errcode = '23514',
      message = 'External evidence is not bound to the production national-25 release.';
  end if;
  if p_evidence is null or pg_catalog.jsonb_typeof(p_evidence) <> 'object'
    or nullif(pg_catalog.btrim(p_app_revision), '') is null
    or nullif(pg_catalog.btrim(p_actor), '') is null then
    raise exception using errcode = '22023',
      message = 'External evidence, app revision, and actor are required.';
  end if;
  if v_target ->> 'configured' <> 'true'
    or not private.stage1_release_evidence_matches_target(
      p_artifact_kind, p_evidence, v_target
    ) then
    raise exception using errcode = '23514',
      message = 'External evidence does not match the administrator-owned production target.';
  end if;
  if p_status = 'passed'
    and not private.stage1_release_artifact_evidence_valid(p_artifact_kind, p_evidence) then
    raise exception using errcode = '23514',
      message = 'A passed external artifact lacks the kind-specific evidence contract.';
  end if;
  if p_started_at is null or p_completed_at is null or p_valid_until is null
    or p_started_at > p_completed_at
    or p_completed_at > v_now + interval '5 minutes'
    or p_valid_until <= v_now
    or p_valid_until > p_completed_at + (case p_artifact_kind
      when 'hosted_runtime_identity' then interval '2 hours'
      when 'non_cohort_leak_crawl' then interval '24 hours'
      when 'r2_recovery_drill' then interval '24 hours'
      when 'rollback_drill' then interval '7 days'
      else interval '0 seconds'
    end) then
    raise exception using errcode = '22023',
      message = 'External artifact timestamps are invalid, expired, or too long-lived.';
  end if;
  if not private.stage1_release_external_envelope_valid(
    p_artifact_kind,
    p_status,
    p_evidence,
    p_started_at,
    p_completed_at
  ) then
    raise exception using errcode = '23514',
      message = 'The kind-specific producer envelope is invalid or outside the signed measurement window.';
  end if;

  v_evidence_hash := public.stage1_publication_evidence_hash(p_evidence);
  if v_evidence_hash is distinct from p_expected_evidence_hash then
    raise exception using errcode = '40001',
      message = 'External artifact evidence hash mismatch.';
  end if;
  v_payload_hash := private.stage1_release_external_payload_hash(
    p_artifact_kind,
    p_environment,
    p_status,
    p_cohort_identity_version,
    p_cohort_identity_hash,
    p_policy_version,
    p_app_revision,
    (v_target ->> 'config_version')::bigint,
    v_target ->> 'target_config_hash',
    v_evidence_hash,
    p_signer_key_id,
    p_started_at,
    p_completed_at,
    p_valid_until,
    p_actor
  );
  if v_payload_hash is distinct from p_expected_signed_payload_hash then
    raise exception using errcode = '40001',
      message = 'External artifact signing-payload hash mismatch.';
  end if;

  select * into v_signer
  from private.stage1_release_evidence_signers signer
  where signer.artifact_kind = p_artifact_kind
    and signer.key_id = p_signer_key_id
    and signer.producer_source_sha256 =
      p_evidence ->> 'producer_source_sha256'
    and signer.environment = p_environment
    and signer.enabled
    and signer.valid_from <= p_completed_at
    and (signer.valid_until is null or signer.valid_until > v_now)
  for key share;
  if not found or pg_catalog.to_regclass('vault.decrypted_secrets') is null then
    raise exception using errcode = '28000',
      message = 'No active Vault-backed signer is provisioned for this evidence kind.';
  end if;
  execute
    'select decrypted_secret from vault.decrypted_secrets where name = $1 order by updated_at desc limit 1'
    into v_secret using v_signer.vault_secret_name;
  if nullif(v_secret, '') is null or pg_catalog.length(v_secret) < 32 then
    raise exception using errcode = '28000',
      message = 'The configured Vault evidence-signing secret is missing or invalid.';
  end if;
  v_expected_signature := private.stage1_release_hmac_sha256(v_payload_hash, v_secret);
  if p_signature is distinct from v_expected_signature then
    raise exception using errcode = '28000',
      message = 'External artifact signature verification failed.';
  end if;

  insert into public.stage1_release_acceptance_artifacts (
    artifact_kind,
    producer_kind,
    environment,
    status,
    cohort_identity_version,
    cohort_identity_hash,
    policy_version,
    app_revision,
    target_config_version,
    target_config_hash,
    evidence,
    evidence_hash,
    signer_key_id,
    signed_payload_hash,
    signature,
    started_at,
    completed_at,
    valid_until,
    actor
  ) values (
    p_artifact_kind,
    'external_signed',
    p_environment,
    p_status,
    p_cohort_identity_version,
    p_cohort_identity_hash,
    p_policy_version,
    pg_catalog.btrim(p_app_revision),
    (v_target ->> 'config_version')::bigint,
    v_target ->> 'target_config_hash',
    p_evidence,
    v_evidence_hash,
    p_signer_key_id,
    v_payload_hash,
    p_signature,
    p_started_at,
    p_completed_at,
    p_valid_until,
    pg_catalog.btrim(p_actor)
  ) returning * into v_artifact;
  return v_artifact;
end;
$function$
;

-- private.stage1_current_valid_release_artifact: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION private.stage1_current_valid_release_artifact(p_artifact_kind text, p_evaluated_at timestamp with time zone)
 RETURNS SETOF stage1_release_acceptance_artifacts
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with ranked_candidates as (
    select
      artifact.id,
      pg_catalog.row_number() over (
        order by artifact.completed_at desc, artifact.id desc
      ) as recency_rank
    from public.stage1_release_acceptance_artifacts artifact
    where artifact.artifact_kind = p_artifact_kind
      and artifact.environment = 'production'
      and artifact.cohort_identity_version = 'stage1-national-25-v3'
      and artifact.cohort_identity_hash =
        '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9'
      and artifact.policy_version = 'stage1-publication-v1'
      and artifact.started_at <= artifact.completed_at
      and artifact.completed_at <= p_evaluated_at + interval '5 minutes'
      and private.stage1_release_artifact_signature_valid(
        artifact.id, p_evaluated_at
      )
      and (
        artifact.producer_kind = 'external_signed'
        or (
          artifact.producer_kind = 'database_derived'
          and artifact.artifact_kind = 'visual_crop_coverage'
          and artifact.evidence ->> 'producer_contract' =
            'awardping.stage1.database-derived-release-evidence.v2'
          and artifact.evidence ->> 'derivation_contract_hash' =
            private.stage1_visual_crop_derivation_contract_hash()
        )
      )
  ), latest as (
    select artifact.*
    from public.stage1_release_acceptance_artifacts artifact
    join ranked_candidates candidate on candidate.id = artifact.id
    where candidate.recency_rank = 1
  )
  select latest.*
  from latest
  where latest.status = 'passed'
    and latest.valid_until > p_evaluated_at
    and private.stage1_release_artifact_evidence_valid(
      latest.artifact_kind,
      latest.evidence
    );
$function$
;

-- private.stage1_gate_without_contact_fence_20260717123000: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION private.stage1_gate_without_contact_fence_20260717123000(p_evaluated_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_now timestamptz := p_evaluated_at;
  v_target jsonb := private.stage1_release_production_target_snapshot();
  v_due_date date;
  v_identity_payload text;
  v_cohort_count bigint := 0;
  v_ready_count bigint := 0;
  v_cohort_identity_hash text;
  v_quarantine_count bigint := 0;
  v_invite_reissue_count bigint := 0;
  v_contract jsonb;
  v_contract_ok boolean := false;
  v_invite_acl_ok boolean := false;
  v_vault_access_contract_safe boolean := false;
  v_vault_service_profile_blocked boolean := false;
  v_contract_state_hash text;
  v_release public.stage1_publication_release_state%rowtype;
  v_runtime public.stage1_release_acceptance_artifacts%rowtype;
  v_rollback public.stage1_release_acceptance_artifacts%rowtype;
  v_leak public.stage1_release_acceptance_artifacts%rowtype;
  v_r2 public.stage1_release_acceptance_artifacts%rowtype;
  v_crop public.stage1_release_acceptance_artifacts%rowtype;
  v_objects jsonb;
  v_coverage jsonb;
  v_leak_manifest jsonb;
  v_r2_bound boolean := false;
  v_crop_bound boolean := false;
  v_artifacts_ok boolean := false;
  v_nightly jsonb := '{}'::jsonb;
  v_nightly_ok boolean := false;
  v_budgets jsonb := '[]'::jsonb;
  v_budget_count bigint := 0;
  v_budget_valid_count bigint := 0;
  v_budgets_ok boolean := false;
  v_lanes jsonb := '[]'::jsonb;
  v_lane_count bigint := 0;
  v_lane_valid_count bigint := 0;
  v_lanes_ok boolean := false;
  v_failures text[] := '{}'::text[];
  v_basis jsonb;
  v_state_hash text;
begin
  if v_now is null then
    raise exception using errcode = '22023', message = 'A release evaluation timestamp is required.';
  end if;
  v_due_date := case
    when (v_now at time zone 'America/Chicago')::time < time '18:00'
      then (v_now at time zone 'America/Chicago')::date - 1
    else (v_now at time zone 'America/Chicago')::date
  end;

  select
    count(*),
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
      E'\n' order by registry.launch_rank
    )
  into v_cohort_count, v_identity_payload
  from public.stage1_award_registry registry;
  v_cohort_identity_hash := public.stage1_publication_evidence_hash(
    pg_catalog.to_jsonb(v_identity_payload)
  );
  select count(*) filter (
    where public.stage1_effective_publication_reason(
      registry.cohort_key, v_now
    ) = 'verified'
  ) into v_ready_count
  from public.stage1_award_registry registry;

  select count(*) into v_quarantine_count
  from public.manual_quarantine_registry quarantine
  where quarantine.classification = 'actionable_quarantine'
    and quarantine.requires_action
    and quarantine.status in ('quarantined', 'in_review')
    and (
      exists (
        select 1 from public.stage1_award_members member
        where member.shared_award_id = quarantine.shared_award_id
      )
      or exists (
        select 1
        from public.shared_award_sources source
        join public.stage1_award_members member
          on member.shared_award_id = source.shared_award_id
        where source.id = quarantine.shared_award_source_id
      )
      or exists (
        select 1
        from public.shared_award_visual_review_candidates candidate
        join public.stage1_award_members member
          on member.shared_award_id = candidate.shared_award_id
        where candidate.id = quarantine.visual_review_candidate_id
      )
    );

  v_contract := public.get_awardping_release_contract_status();
  v_contract_ok := v_contract ->> 'contract_version' = 'awardping-release-contract-v1'
    and v_contract ->> 'matches' = 'true'
    and v_contract ->> 'requirement_count' = '16'
    and pg_catalog.jsonb_typeof(v_contract -> 'missing') = 'array'
    and pg_catalog.jsonb_array_length(v_contract -> 'missing') = 0;
  select count(*) into v_invite_reissue_count
  from public.office_invite_security_reissues reissue
  where reissue.status in ('pending_reissue', 'replacement_ready');
  v_invite_acl_ok :=
    not pg_catalog.has_function_privilege(
      'anon', 'public.reserve_office_invite_signup(text)', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'authenticated', 'public.reserve_office_invite_signup(text)', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'anon', 'public.complete_office_invite_signup(uuid,uuid,uuid,text)', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'authenticated', 'public.complete_office_invite_signup(uuid,uuid,uuid,text)', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'anon', 'public.accept_office_invite_for_user(text,uuid,text)', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'authenticated', 'public.accept_office_invite_for_user(text,uuid,text)', 'EXECUTE'
    )
    and not exists (
      select 1
      from pg_catalog.pg_policies policy
      where policy.schemaname = 'public'
        and policy.tablename in ('offices', 'office_members')
        and policy.cmd in ('INSERT', 'ALL')
        and (
          'public' = any(policy.roles)
          or 'anon' = any(policy.roles)
          or 'authenticated' = any(policy.roles)
        )
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger trigger
      where trigger.tgrelid = 'auth.users'::pg_catalog.regclass
        and trigger.tgname = 'on_auth_user_created'
        and not trigger.tgisinternal
        and trigger.tgenabled <> 'D'
    );

  v_vault_access_contract_safe := private.stage1_vault_access_contract_safe();
  v_vault_service_profile_blocked :=
    coalesce(v_runtime.evidence ->> 'vault_profile_http_status', '') = '406'
    and coalesce(v_runtime.evidence ->> 'vault_profile_postgrest_code', '') = 'PGRST106'
    and coalesce(v_runtime.evidence ->> 'vault_profile_exposed', '') = 'false'
    and coalesce(v_runtime.evidence ->> 'vault_profile_redirected', '') = 'false';
  v_contract_state_hash := private.stage1_release_contract_state_hash();
  select * into v_release
  from public.stage1_publication_release_state release
  where release.release_key = 'stage1-national-25';

  select * into v_runtime
  from private.stage1_current_valid_release_artifact(
    'hosted_runtime_identity', v_now
  ) artifact
  where artifact.completed_at >= v_now - interval '1 hour'
  limit 1;
  select * into v_rollback
  from private.stage1_current_valid_release_artifact('rollback_drill', v_now)
  limit 1;
  select * into v_leak
  from private.stage1_current_valid_release_artifact('non_cohort_leak_crawl', v_now)
  limit 1;
  select * into v_r2
  from private.stage1_current_valid_release_artifact('r2_recovery_drill', v_now)
  limit 1;
  select * into v_crop
  from private.stage1_current_valid_release_artifact('visual_crop_coverage', v_now)
  limit 1;

  v_objects := private.stage1_visual_r2_object_set_snapshot();
  v_coverage := private.stage1_visual_crop_coverage_snapshot();
  if v_target ->> 'configured' = 'true' then
    v_leak_manifest := public.get_stage1_release_leak_crawl_manifest();
  else
    v_leak_manifest := '{}'::jsonb;
  end if;
  v_r2_bound := v_runtime.id is not null
    and v_r2.id is not null
    and v_objects ->> 'unexpected_bucket_count' = '0'
    and v_objects ->> 'malformed_object_count' = '0'
    and v_r2.app_revision = v_runtime.app_revision
    and v_r2.evidence ->> 'visual_object_set_hash' =
      v_objects ->> 'visual_object_set_hash'
    and v_r2.evidence ->> 'visual_objects_checked' =
      v_objects ->> 'visual_object_count';
  v_crop_bound := v_runtime.id is not null
    and v_crop.id is not null
    and v_crop.producer_kind = 'database_derived'
    and v_crop.app_revision = v_runtime.app_revision
    and v_crop.evidence ->> 'eligible_events' = v_coverage ->> 'eligible_events'
    and v_crop.evidence ->> 'verified_events' = v_coverage ->> 'verified_events'
    and v_crop.evidence ->> 'unverified_publishable_events' =
      v_coverage ->> 'unverified_publishable_events'
    and v_crop.evidence ->> 'terminal_failures' = v_coverage ->> 'terminal_failures'
    and v_crop.evidence ->> 'pdf_evidence_failures' = v_coverage ->> 'pdf_evidence_failures'
    and v_crop.evidence ->> 'coverage_set_hash' = v_coverage ->> 'coverage_set_hash'
    and v_crop.evidence ->> 'visual_object_count' = v_objects ->> 'visual_object_count'
    and v_crop.evidence ->> 'visual_object_set_hash' = v_objects ->> 'visual_object_set_hash'
    and v_crop.evidence ->> 'derivation_contract_hash' =
      private.stage1_visual_crop_derivation_contract_hash()
    and v_crop.evidence ->> 'r2_hashes_verified' = 'true'
    and v_crop.evidence ->> 'r2_artifact_id' = v_r2.id::text
    and v_r2_bound;
  v_artifacts_ok := v_runtime.id is not null
    and v_rollback.id is not null
    and v_leak.id is not null
    and v_r2_bound
    and v_crop_bound
    and v_rollback.app_revision = v_runtime.app_revision
    and v_leak.app_revision = v_runtime.app_revision
    and v_rollback.evidence ->> 'contract_state_hash' = v_contract_state_hash
    and v_leak.evidence ->> 'route_manifest_sha256' =
      v_leak_manifest ->> 'route_manifest_sha256'
    and pg_catalog.rtrim(v_leak.evidence ->> 'base_url', '/') =
      pg_catalog.rtrim(v_runtime.evidence ->> 'base_url', '/');

  with base_runs as (
    select
      run as worker_run,
      run.*,
      private.stage1_normal_6pm_monitoring_date(run) as monitoring_date,
      case
        when run.metadata #>> '{run_identity,shard_index}' ~ '^[0-2]$'
          then (run.metadata #>> '{run_identity,shard_index}')::integer
        else -1
      end as shard_index
    from public.local_worker_runs run
    where run.started_at <= v_now
      and private.stage1_normal_6pm_monitoring_date(run) between v_due_date - 3 and v_due_date
  ), ranked_runs as (
    select
      base_runs.*,
      pg_catalog.row_number() over (
        partition by monitoring_date, shard_index
        order by started_at desc, id desc
      ) as rank_for_shard
    from base_runs
    where monitoring_date is not null
  ), latest_runs as (
    select * from ranked_runs where rank_for_shard = 1
  ), cohorts as (
    select
      monitoring_date,
      max(finished_at) as finished_at,
      count(*) as shard_count,
      (
        count(*) = 3
        and count(distinct shard_index) = 3
        and pg_catalog.bool_and(private.stage1_6pm_shard_healthy(latest_runs.worker_run))
        and count(distinct (metadata #>> '{source_inventory,global_source_count}')) = 1
        and count(distinct (metadata #>> '{source_inventory,global_source_ids_sha256}')) = 1
        and count(distinct (metadata #> '{source_inventory,partitions}')) = 1
        and sum(case
          when metadata #>> '{source_inventory,expected_shard_source_count}' ~ '^[1-9][0-9]*$'
            then (metadata #>> '{source_inventory,expected_shard_source_count}')::bigint
          else -1000000000
        end) = max(case
          when metadata #>> '{source_inventory,global_source_count}' ~ '^[1-9][0-9]*$'
            then (metadata #>> '{source_inventory,global_source_count}')::bigint
          else -2000000000
        end)
      ) as healthy,
      pg_catalog.jsonb_agg(id order by shard_index) as run_ids,
      max(metadata #>> '{source_inventory,global_source_count}') as global_source_count,
      max(metadata #>> '{source_inventory,global_source_ids_sha256}') as global_source_hash
    from latest_runs
    group by monitoring_date
  ), required_dates as (
    select
      offset_value,
      v_due_date - offset_value as monitoring_date
    from pg_catalog.generate_series(0, 3) offset_value
  ), required as (
    select
      required_dates.offset_value,
      required_dates.monitoring_date,
      cohorts.finished_at,
      coalesce(cohorts.healthy, false) as healthy,
      cohorts.run_ids,
      cohorts.global_source_count,
      cohorts.global_source_hash
    from required_dates
    left join cohorts using (monitoring_date)
  )
  select pg_catalog.jsonb_build_object(
    'contract', 'awardping.stage1.three-6pm-plus-24h-soak.v2',
    'due_monitoring_date', v_due_date,
    'required_acceptance_cohorts', 3,
    'acceptance_cohorts', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'monitoring_date', required.monitoring_date,
          'healthy', required.healthy,
          'finished_at', required.finished_at,
          'run_ids', required.run_ids,
          'global_source_count', required.global_source_count,
          'global_source_hash', required.global_source_hash
        ) order by required.offset_value desc
      )
      from required where required.offset_value between 1 and 3
    ), '[]'::jsonb),
    'healthy_acceptance_cohorts', (
      select count(*) from required
      where offset_value between 1 and 3 and healthy
    ),
    'current_due_cohort_healthy', coalesce((
      select healthy from required where offset_value = 0
    ), false),
    'healthy_required_calendar_dates', (
      select count(*) from required where healthy
    ),
    'soak_started_at', (
      select finished_at from required where offset_value = 1
    ),
    'soak_complete', coalesce((
      select healthy and finished_at is not null
        and v_now - finished_at >= interval '24 hours'
      from required where offset_value = 1
    ), false),
    'app_worker_identity_mismatches', (
      select count(*)
      from latest_runs
      where v_runtime.id is null
        or metadata ->> 'worker_revision' is distinct from v_runtime.app_revision
        or metadata #>> '{monitoring_policy_bundle,hash}' is distinct from
          v_runtime.evidence ->> 'policy_hash'
        or metadata #>> '{monitoring_policy,hash}' is distinct from
          v_runtime.evidence ->> 'batch_policy_hash'
        or metadata #>> '{suppression_policy,hash}' is distinct from
          v_runtime.evidence ->> 'suppression_policy_hash'
        or metadata ->> 'matcher_digest' is distinct from
          v_runtime.evidence ->> 'matcher_hash'
    ),
    'r2_enabled_current_shards', (
      select count(*)
      from latest_runs
      where monitoring_date = v_due_date
        and private.stage1_json_flag_enabled(
          metadata #> '{options,r2_rehydrate_local_cache}'
        )
    ),
    'r2_failed_current', coalesce((
      select sum(case
        when metadata #>> '{counts,r2_rehydration_failed}' ~ '^[0-9]+$'
          then (metadata #>> '{counts,r2_rehydration_failed}')::bigint
        else 1000000 end)
      from latest_runs where monitoring_date = v_due_date
    ), 1000000),
    'r2_refused_current', coalesce((
      select sum(case
        when metadata #>> '{counts,r2_rehydration_refused}' ~ '^[0-9]+$'
          then (metadata #>> '{counts,r2_rehydration_refused}')::bigint
        else 1000000 end)
      from latest_runs where monitoring_date = v_due_date
    ), 1000000),
    'all_bound_run_ids', coalesce((
      select pg_catalog.jsonb_agg(id order by monitoring_date, shard_index)
      from latest_runs
    ), '[]'::jsonb)
  ) into v_nightly;

  v_nightly_ok := v_nightly ->> 'healthy_acceptance_cohorts' = '3'
    and v_nightly ->> 'current_due_cohort_healthy' = 'true'
    and v_nightly ->> 'healthy_required_calendar_dates' = '4'
    and v_nightly ->> 'soak_complete' = 'true'
    and v_nightly ->> 'app_worker_identity_mismatches' = '0'
    and v_nightly ->> 'r2_enabled_current_shards' = '3'
    and v_nightly ->> 'r2_failed_current' = '0'
    and v_nightly ->> 'r2_refused_current' = '0'
    and pg_catalog.jsonb_array_length(v_nightly -> 'all_bound_run_ids') = 12;

  select
    count(*),
    count(*) filter (
      where budget.lane_key in ('new_page_review', 'changed_page_review')
        and budget.cap_micro_usd = 5000000
        and budget.reserved_micro_usd >= 0
        and budget.spent_micro_usd >= 0
        and budget.remaining_micro_usd =
          budget.cap_micro_usd - budget.reserved_micro_usd - budget.spent_micro_usd
        and budget.remaining_micro_usd >= 0
        and budget.reset_at > v_now
        and budget.source = 'postgres_atomic_budget_v1'
    ),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(budget) order by budget.lane_key), '[]'::jsonb)
  into v_budget_count, v_budget_valid_count, v_budgets
  from public.list_gemini_budget_status() budget;
  v_budgets_ok := v_budget_count = 2 and v_budget_valid_count = 2;

  select
    count(*),
    count(*) filter (
      where lane.enabled
        and not lane.lease_expired
        and not lane.sla_breached
        and lane.timeout_seconds > 0
        and lane.lease_ttl_seconds > lane.timeout_seconds
        and private.stage1_downstream_lane_sla_contract_valid(
          lane.lane_key,
          lane.sla_seconds,
          lane.oldest_item_sla_seconds,
          lane.queue_depth,
          lane.oldest_item_at,
          lane.next_sla_due_at
        )
        and lane.source = 'postgres_lane_scheduler_v1'
        and (
          (
            lane.lane_key in ('new_page_review', 'changed_page_review')
            and lane.creates_api_charge
            and lane.paid_lane_key = lane.lane_key
          )
          or (
            lane.lane_key not in ('new_page_review', 'changed_page_review')
            and not lane.creates_api_charge
            and lane.paid_lane_key is null
          )
        )
    ),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(lane) order by lane.lane_key), '[]'::jsonb)
  into v_lane_count, v_lane_valid_count, v_lanes
  from public.list_monitoring_downstream_lane_status() lane;
  v_lanes_ok := v_lane_count = 8 and v_lane_valid_count = 8;

  if v_cohort_count <> 25 or v_cohort_identity_hash <>
    '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9' then
    v_failures := pg_catalog.array_append(v_failures, 'exact_national_25_identity_failed');
  end if;
  if v_target ->> 'configured' <> 'true' then
    v_failures := pg_catalog.array_append(
      v_failures, 'admin_owned_production_target_not_configured'
    );
  end if;
  if v_ready_count <> 25 then
    v_failures := pg_catalog.array_append(v_failures, 'award_readiness_not_25_of_25');
  end if;
  if v_release.release_key is null
    or v_release.release_state = 'verified_beta'
    or v_release.release_epoch is not null
    or v_release.policy_version <> 'stage1-publication-v1' then
    v_failures := pg_catalog.array_append(v_failures, 'release_state_not_closed_or_mismatched');
  end if;
  if v_quarantine_count <> 0 then
    v_failures := pg_catalog.array_append(v_failures, 'actionable_quarantine_remaining');
  end if;
  if not v_contract_ok or not v_invite_acl_ok then
    v_failures := pg_catalog.array_append(v_failures, 'invite_only_database_contract_failed');
  end if;
  if not v_vault_access_contract_safe or not v_vault_service_profile_blocked then
    v_failures := pg_catalog.array_append(v_failures, 'vault_access_contract_failed');
  end if;
  if v_invite_reissue_count <> 0 then
    v_failures := pg_catalog.array_append(v_failures, 'invite_security_reissues_remaining');
  end if;
  if v_runtime.id is null or v_runtime.evidence ->> 'disable_signup' <> 'true' then
    v_failures := pg_catalog.array_append(v_failures, 'signed_hosted_auth_runtime_evidence_missing');
  end if;
  if not v_nightly_ok then
    v_failures := pg_catalog.array_append(v_failures, 'three_6pm_cohorts_soak_or_runtime_identity_failed');
  end if;
  if not v_budgets_ok then
    v_failures := pg_catalog.array_append(v_failures, 'two_atomic_5_usd_budgets_failed');
  end if;
  if not v_lanes_ok then
    v_failures := pg_catalog.array_append(v_failures, 'eight_downstream_lanes_failed');
  end if;
  if not v_r2_bound then
    v_failures := pg_catalog.array_append(v_failures, 'signed_r2_recovery_or_object_set_failed');
  end if;
  if not v_crop_bound then
    v_failures := pg_catalog.array_append(v_failures, 'database_derived_exact_crop_coverage_failed');
  end if;
  if not v_artifacts_ok then
    v_failures := pg_catalog.array_append(v_failures, 'release_artifact_set_failed');
  end if;

  v_basis := pg_catalog.jsonb_build_object(
    'schema_version', 'stage1-release-gate-acceptance-v2',
    'release_contract_state_hash', v_contract_state_hash,
    'production_target', v_target,
    'cohort', pg_catalog.jsonb_build_object(
      'expected_count', 25,
      'registry_count', v_cohort_count,
      'ready_count', v_ready_count,
      'identity_version', 'stage1-national-25-v3',
      'identity_hash', v_cohort_identity_hash
    ),
    'release', pg_catalog.to_jsonb(v_release),
    'quarantine', pg_catalog.jsonb_build_object(
      'actionable_count', v_quarantine_count
    ),
    'invite', pg_catalog.jsonb_build_object(
      'database_contract', v_contract,
      'database_acl_safe', v_invite_acl_ok,
      'unresolved_security_reissues', v_invite_reissue_count,
      'hosted_runtime_artifact_id', v_runtime.id,
      'disable_signup', v_runtime.evidence -> 'disable_signup'
    ),
    'vault_security', pg_catalog.jsonb_build_object(
      'api_surface_safe', v_vault_access_contract_safe,
      'service_role_data_api_profile_blocked', v_vault_service_profile_blocked,
      'profile_http_status', v_runtime.evidence -> 'vault_profile_http_status',
      'profile_postgrest_code', v_runtime.evidence -> 'vault_profile_postgrest_code'
    ),
    'nightly', v_nightly,
    'budgets', v_budgets,
    'lanes', v_lanes,
    'r2_recovery', pg_catalog.jsonb_build_object(
      'current_worker_configuration_safe', v_nightly_ok,
      'artifact_id', v_r2.id,
      'artifact_evidence_hash', v_r2.evidence_hash,
      'current_object_set', v_objects,
      'bound', v_r2_bound
    ),
    'visual_crop_coverage', v_coverage || pg_catalog.jsonb_build_object(
      'artifact_id', v_crop.id,
      'artifact_evidence_hash', v_crop.evidence_hash,
      'r2_hashes_verified', v_r2_bound,
      'bound', v_crop_bound
    ),
    'artifacts', pg_catalog.jsonb_build_object(
      'hosted_runtime_identity', pg_catalog.jsonb_build_object(
        'id', v_runtime.id, 'evidence_hash', v_runtime.evidence_hash
      ),
      'rollback_drill', pg_catalog.jsonb_build_object(
        'id', v_rollback.id, 'evidence_hash', v_rollback.evidence_hash
      ),
      'non_cohort_leak_crawl', pg_catalog.jsonb_build_object(
        'id', v_leak.id, 'evidence_hash', v_leak.evidence_hash
      ),
      'r2_recovery_drill', pg_catalog.jsonb_build_object(
        'id', v_r2.id, 'evidence_hash', v_r2.evidence_hash
      ),
      'visual_crop_coverage', pg_catalog.jsonb_build_object(
        'id', v_crop.id, 'evidence_hash', v_crop.evidence_hash
      )
    ),
    'failures', pg_catalog.to_jsonb(v_failures)
  );
  v_state_hash := public.stage1_publication_evidence_hash(v_basis);
  return v_basis || pg_catalog.jsonb_build_object(
    'generated_at', v_now,
    'state', case when pg_catalog.cardinality(v_failures) = 0 then 'READY' else 'HOLD' end,
    'state_hash', v_state_hash
  );
end;
$function$
;

-- private.stage1_publication_snapshot_compute: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION private.stage1_publication_snapshot_compute()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with evaluated as (
    select statement_timestamp() as evaluated_at
  ),
  identity_payload as (
    select pg_catalog.string_agg(
      pg_catalog.concat_ws(
        '|',
        registry.launch_rank::text,
        registry.cohort_key,
        registry.canonical_name,
        registry.canonical_shared_award_id::text,
        registry.canonical_slug,
        registry.official_homepage
      ),
      E'\n'
      order by registry.launch_rank
    ) as value
    from public.stage1_award_registry registry
  ),
  effective_rows as (
    select * from public.list_stage1_effective_publication()
  ),
  cohort_rows as (
    select
      registry.launch_rank,
      pg_catalog.jsonb_build_object(
        'registry', pg_catalog.to_jsonb(registry),
        'effectively_verified', effective.effectively_verified,
        'effective_reason', effective.effective_reason,
        'cohort_ready', effective.cohort_ready,
        'cohort_readiness_reason', effective.cohort_readiness_reason,
        'evaluated_at', effective.evaluated_at,
        'members', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(member)
            order by member.member_kind, member.shared_award_id
          )
          from public.stage1_award_members member
          where member.cohort_key = registry.cohort_key
        ), '[]'::jsonb),
        'identity_rules', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(identity_rule)
            order by identity_rule.rule_key, identity_rule.id
          )
          from public.stage1_award_source_identity_rules identity_rule
          where identity_rule.cohort_key = registry.cohort_key
        ), '[]'::jsonb),
        'allowed_source_ids', coalesce((
          select pg_catalog.jsonb_agg(
            allowed.source_id
            order by allowed.source_id
          )
          from (
            select distinct unnest(manifest.source_ids) as source_id
            from public.stage1_award_source_manifest manifest
            where manifest.cohort_key = registry.cohort_key
          ) allowed
        ), '[]'::jsonb),
        'reviewed_homepage', (
          select pg_catalog.jsonb_build_object(
            'source_id', source.id,
            'url', source.url
          )
          from public.stage1_award_source_manifest manifest
          join public.shared_award_sources source
            on cardinality(manifest.source_ids) = 1
            and source.id = manifest.source_ids[1]
          where manifest.cohort_key = registry.cohort_key
            and manifest.source_role = 'identity_home'
            and manifest.manifest_status in ('present', 'combined')
            and source.url = registry.official_homepage
            and manifest.evidence ->> 'source_url' = registry.official_homepage
            and manifest.evidence #>> array[
              'source_bindings', source.id::text, 'source_url'
            ] = registry.official_homepage
        ),
        'published_facts', coalesce((
          select pg_catalog.jsonb_object_agg(
            ledger.field_name,
            ledger.public_value
            order by ledger.field_name
          )
          from public.stage1_award_fact_publication_ledger ledger
          where ledger.cohort_key = registry.cohort_key
            and ledger.verification_batch_id = registry.fact_ledger_batch_id
        ), '{}'::jsonb)
      ) as payload
    from public.stage1_award_registry registry
    join effective_rows effective on effective.cohort_key = registry.cohort_key
  )
  select pg_catalog.jsonb_build_object(
    'schema_version', 3,
    'cohort_identity_version', 'stage1-national-25-v3',
    'cohort_identity_hash', public.stage1_publication_evidence_hash(
      pg_catalog.to_jsonb(identity_payload.value)
    ),
    'evaluated_at', evaluated.evaluated_at,
    'release', pg_catalog.jsonb_build_object(
      'release_key', release_state.release_key,
      'release_state', release_state.release_state,
      'release_epoch', release_state.release_epoch,
      'policy_version', release_state.policy_version,
      'cohort_identity_version', release_state.cohort_identity_version,
      'cohort_identity_hash', release_state.cohort_identity_hash,
      'activated_at', release_state.activated_at,
      'effectively_released', coalesce((
        select count(*) = 25 and bool_and(effective.effectively_verified)
        from effective_rows effective
      ), false),
      'effective_reason', coalesce((
        select min(effective.effective_reason)
        from effective_rows effective
      ), 'cohort_release_rows_missing'),
      'ready_cohort_count', coalesce((
        select count(*) filter (where effective.cohort_ready)
        from effective_rows effective
      ), 0)
    ),
    'cohorts', coalesce(
      (
        select pg_catalog.jsonb_agg(
          cohort_rows.payload
          order by cohort_rows.launch_rank
        )
        from cohort_rows
      ),
      '[]'::jsonb
    )
  )
  from evaluated
  cross join identity_payload
  cross join public.stage1_publication_release_state release_state
  where release_state.release_key = 'stage1-national-25';
$function$
;

-- private.stage1_release_contract_state_hash: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION private.stage1_release_contract_state_hash()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with cohort as (
    select
      count(*) as cohort_count,
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
          E'\n' order by registry.launch_rank
        )
      )) as cohort_identity_hash
    from public.stage1_award_registry registry
  )
  select public.stage1_publication_evidence_hash(
    pg_catalog.jsonb_build_object(
      'contract', 'awardping.stage1.release-contract-state.v2',
      'policy_version', 'stage1-publication-v1',
      'cohort_identity_version', 'stage1-national-25-v3',
      'cohort_count', cohort.cohort_count,
      'cohort_identity_hash', cohort.cohort_identity_hash,
      'production_target', private.stage1_release_production_target_snapshot(),
      'invite_and_free_check_contract', public.get_awardping_release_contract_status(),
      'required_artifact_kinds', pg_catalog.jsonb_build_array(
        'hosted_runtime_identity',
        'rollback_drill',
        'non_cohort_leak_crawl',
        'r2_recovery_drill',
        'visual_crop_coverage'
      )
    )
  )
  from cohort;
$function$
;

-- private.stage1_release_external_signing_preflight: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION private.stage1_release_external_signing_preflight(p_artifact_kind text, p_status text, p_app_revision text, p_evidence jsonb, p_signer_key_id text, p_started_at timestamp with time zone, p_completed_at timestamp with time zone, p_valid_until timestamp with time zone, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_target jsonb := private.stage1_release_production_target_snapshot();
  v_signer private.stage1_release_evidence_signers%rowtype;
  v_evidence_hash text;
  v_payload_hash text;
begin
  if p_artifact_kind not in (
    'hosted_runtime_identity',
    'rollback_drill',
    'non_cohort_leak_crawl',
    'r2_recovery_drill'
  ) then
    raise exception using errcode = '22023',
      message = 'Only an external Stage 1 proof kind has a signing payload.';
  end if;
  if p_status not in ('passed', 'failed')
    or nullif(pg_catalog.btrim(p_app_revision), '') is null
    or nullif(pg_catalog.btrim(p_actor), '') is null
    or pg_catalog.jsonb_typeof(p_evidence) <> 'object' then
    raise exception using errcode = '22023',
      message = 'A valid producer measurement, status, app revision, and actor are required.';
  end if;
  if v_target ->> 'configured' <> 'true'
    or not private.stage1_release_evidence_matches_target(
      p_artifact_kind, p_evidence, v_target
    ) then
    raise exception using errcode = '23514',
      message = 'Producer evidence does not match the administrator-owned production target.';
  end if;
  if p_status = 'passed'
    and not private.stage1_release_artifact_evidence_valid(
      p_artifact_kind, p_evidence
    ) then
    raise exception using errcode = '23514',
      message = 'A passed artifact lacks its kind-specific measured-evidence contract.';
  end if;
  if p_started_at is null or p_completed_at is null or p_valid_until is null
    or p_started_at > p_completed_at
    or p_completed_at > v_now + interval '5 minutes'
    or p_valid_until <= v_now
    or p_valid_until > p_completed_at + (case p_artifact_kind
      when 'hosted_runtime_identity' then interval '2 hours'
      when 'non_cohort_leak_crawl' then interval '24 hours'
      when 'r2_recovery_drill' then interval '24 hours'
      when 'rollback_drill' then interval '7 days'
      else interval '0 seconds'
    end) then
    raise exception using errcode = '22023',
      message = 'Producer measurement timestamps are invalid, expired, or too long-lived.';
  end if;
  if not private.stage1_release_external_envelope_valid(
    p_artifact_kind,
    p_status,
    p_evidence,
    p_started_at,
    p_completed_at
  ) then
    raise exception using errcode = '23514',
      message = 'The kind-specific producer envelope is invalid or outside the signed measurement window.';
  end if;
  select * into v_signer
  from private.stage1_release_evidence_signers signer
  where signer.artifact_kind = p_artifact_kind
    and signer.key_id = p_signer_key_id
    and signer.environment = 'production'
    and signer.enabled
    and signer.valid_from <= p_completed_at
    and (signer.valid_until is null or signer.valid_until > v_now);
  if not found or v_signer.producer_source_sha256 is distinct from
    p_evidence ->> 'producer_source_sha256' then
    raise exception using errcode = '28000',
      message = 'The evidence was not emitted by the direct-admin-approved producer source.';
  end if;
  v_evidence_hash := public.stage1_publication_evidence_hash(p_evidence);
  v_payload_hash := private.stage1_release_external_payload_hash(
    p_artifact_kind,
    'production',
    p_status,
    'stage1-national-25-v3',
    '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9',
    'stage1-publication-v1',
    p_app_revision,
    (v_target ->> 'config_version')::bigint,
    v_target ->> 'target_config_hash',
    v_evidence_hash,
    p_signer_key_id,
    p_started_at,
    p_completed_at,
    p_valid_until,
    p_actor
  );
  return pg_catalog.jsonb_build_object(
    'contract', 'awardping.stage1.external-release-evidence.v2',
    'artifact_kind', p_artifact_kind,
    'target_config_version', (v_target ->> 'config_version')::bigint,
    'target_config_hash', v_target ->> 'target_config_hash',
    'evidence_hash', v_evidence_hash,
    'signed_payload_hash', v_payload_hash
  );
end;
$function$
;

-- public.record_stage1_hosted_runtime_identity_artifact: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION public.record_stage1_hosted_runtime_identity_artifact(p_status text, p_app_revision text, p_evidence jsonb, p_expected_evidence_hash text, p_signer_key_id text, p_expected_signed_payload_hash text, p_signature text, p_started_at timestamp with time zone, p_completed_at timestamp with time zone, p_valid_until timestamp with time zone, p_actor text)
 RETURNS stage1_release_acceptance_artifacts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_observed_at timestamptz;
begin
  if p_status = 'passed' then
    if p_evidence ->> 'app_revision' is distinct from pg_catalog.btrim(p_app_revision)
      or p_evidence ->> 'identity_url' is distinct from
        pg_catalog.rtrim(p_evidence ->> 'base_url', '/') || '/api/monitoring-policy-identity'
      or p_evidence ->> 'auth_settings_url' is distinct from
        pg_catalog.rtrim(p_evidence ->> 'supabase_origin', '/') || '/auth/v1/settings' then
      raise exception using errcode = '23514',
        message = 'Hosted runtime evidence URL or app-revision binding is invalid.';
    end if;
    begin
      v_observed_at := (p_evidence ->> 'observed_at')::timestamptz;
    exception when others then
      raise exception using errcode = '22023',
        message = 'Hosted runtime evidence observed_at is invalid.';
    end;
    if pg_catalog.abs(
      pg_catalog.date_part('epoch', p_completed_at - v_observed_at)
    ) > 300
      or p_completed_at < pg_catalog.clock_timestamp() - interval '1 hour'
      or p_valid_until > p_completed_at + interval '2 hours' then
      raise exception using errcode = '23514',
        message = 'Hosted runtime evidence is stale or too long-lived.';
    end if;
  end if;
  return private.insert_stage1_external_release_artifact(
    'hosted_runtime_identity',
    'production',
    p_status,
    'stage1-national-25-v3',
    '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9',
    'stage1-publication-v1',
    p_app_revision,
    p_evidence,
    p_expected_evidence_hash,
    p_signer_key_id,
    p_expected_signed_payload_hash,
    p_signature,
    p_started_at,
    p_completed_at,
    p_valid_until,
    p_actor
  );
end;
$function$
;

-- public.record_stage1_non_cohort_leak_crawl_artifact: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION public.record_stage1_non_cohort_leak_crawl_artifact(p_status text, p_app_revision text, p_evidence jsonb, p_expected_evidence_hash text, p_signer_key_id text, p_expected_signed_payload_hash text, p_signature text, p_started_at timestamp with time zone, p_completed_at timestamp with time zone, p_valid_until timestamp with time zone, p_actor text)
 RETURNS stage1_release_acceptance_artifacts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_runtime public.stage1_release_acceptance_artifacts%rowtype;
  v_manifest jsonb;
begin
  if p_status = 'passed' then
    select * into v_runtime
    from private.stage1_current_valid_release_artifact(
      'hosted_runtime_identity', pg_catalog.clock_timestamp()
    ) limit 1;
    v_manifest := public.get_stage1_release_leak_crawl_manifest();
    if v_runtime.id is null
      or v_runtime.app_revision <> pg_catalog.btrim(p_app_revision)
      or pg_catalog.rtrim(p_evidence ->> 'base_url', '/') is distinct from
        pg_catalog.rtrim(v_runtime.evidence ->> 'base_url', '/')
      or p_evidence ->> 'route_manifest_sha256' is distinct from
        v_manifest ->> 'route_manifest_sha256'
      or p_evidence ->> 'stage1_awards_observed' is distinct from
        v_manifest ->> 'stage1_route_count'
      or p_evidence ->> 'non_cohort_awards_sampled' is distinct from
        v_manifest ->> 'non_cohort_route_count'
      or (p_evidence ->> 'routes_checked')::bigint is distinct from
        (
          (v_manifest ->> 'stage1_route_count')::bigint
          + (v_manifest ->> 'non_cohort_route_count')::bigint
        ) then
      raise exception using errcode = '23514',
        message = 'Anonymous crawl proof is not bound to the current runtime and complete DB-owned route manifest.';
    end if;
  end if;
  return private.insert_stage1_external_release_artifact(
    'non_cohort_leak_crawl', 'production', p_status,
    'stage1-national-25-v3',
    '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9',
    'stage1-publication-v1', p_app_revision, p_evidence,
    p_expected_evidence_hash, p_signer_key_id,
    p_expected_signed_payload_hash, p_signature,
    p_started_at, p_completed_at, p_valid_until, p_actor
  );
end;
$function$
;

-- public.record_stage1_r2_recovery_drill_artifact: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION public.record_stage1_r2_recovery_drill_artifact(p_status text, p_app_revision text, p_evidence jsonb, p_expected_evidence_hash text, p_signer_key_id text, p_expected_signed_payload_hash text, p_signature text, p_started_at timestamp with time zone, p_completed_at timestamp with time zone, p_valid_until timestamp with time zone, p_actor text)
 RETURNS stage1_release_acceptance_artifacts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_runtime public.stage1_release_acceptance_artifacts%rowtype;
  v_objects jsonb;
begin
  if p_status = 'passed' then
    select * into v_runtime
    from private.stage1_current_valid_release_artifact(
      'hosted_runtime_identity', pg_catalog.clock_timestamp()
    )
    limit 1;
    v_objects := private.stage1_visual_r2_object_set_snapshot();
    if v_runtime.id is null
      or v_runtime.app_revision <> pg_catalog.btrim(p_app_revision)
      or not private.stage1_r2_recovery_evidence_matches_snapshot(
        p_evidence, v_objects
      ) then
      raise exception using errcode = '23514',
        message = 'R2 proof did not verify the complete current Stage 1 canonical object-reference graph.';
    end if;
  end if;
  return private.insert_stage1_external_release_artifact(
    'r2_recovery_drill', 'production', p_status,
    'stage1-national-25-v3',
    '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9',
    'stage1-publication-v1', p_app_revision, p_evidence,
    p_expected_evidence_hash, p_signer_key_id,
    p_expected_signed_payload_hash, p_signature,
    p_started_at, p_completed_at, p_valid_until, p_actor
  );
end;
$function$
;

-- public.record_stage1_release_acceptance: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION public.record_stage1_release_acceptance(p_expected_gate_state_hash text, p_expires_at timestamp with time zone, p_actor text)
 RETURNS stage1_release_acceptance_records
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_summary jsonb;
  v_summary_hash text;
  v_acceptance public.stage1_release_acceptance_records%rowtype;
  v_kind text;
  v_binding jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  if nullif(pg_catalog.btrim(p_actor), '') is null
    or p_expires_at is null
    or p_expires_at <= v_now
    or p_expires_at > v_now + interval '15 minutes' then
    raise exception using errcode = '22023',
      message = 'Acceptance actor and a future expiry no more than 15 minutes away are required.';
  end if;

  v_summary := private.stage1_release_gate_snapshot(v_now);
  if v_summary ->> 'schema_version' <> 'stage1-release-gate-acceptance-v2'
    or v_summary ->> 'state' <> 'READY'
    or v_summary #>> '{cohort,identity_hash}' <>
      '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9'
    or v_summary ->> 'state_hash' is distinct from p_expected_gate_state_hash then
    raise exception using errcode = '40001',
      message = 'The database-derived Stage 1 gate is not READY or changed after operator review.';
  end if;
  v_summary_hash := public.stage1_publication_evidence_hash(v_summary);

  insert into public.stage1_release_acceptance_records (
    cohort_identity_version,
    cohort_identity_hash,
    policy_version,
    summary,
    gate_state_hash,
    summary_hash,
    generated_at,
    expires_at,
    actor
  ) values (
    'stage1-national-25-v3',
    '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9',
    'stage1-publication-v1',
    v_summary,
    v_summary ->> 'state_hash',
    v_summary_hash,
    v_now,
    p_expires_at,
    pg_catalog.btrim(p_actor)
  ) returning * into v_acceptance;

  foreach v_kind in array array[
    'hosted_runtime_identity',
    'rollback_drill',
    'non_cohort_leak_crawl',
    'r2_recovery_drill',
    'visual_crop_coverage'
  ] loop
    v_binding := v_summary -> 'artifacts' -> v_kind;
    insert into public.stage1_release_acceptance_artifact_links (
      acceptance_id,
      artifact_id,
      artifact_kind,
      evidence_hash
    ) values (
      v_acceptance.id,
      (v_binding ->> 'id')::uuid,
      v_kind,
      v_binding ->> 'evidence_hash'
    );
  end loop;
  return v_acceptance;
end;
$function$
;

-- public.record_stage1_rollback_drill_artifact: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION public.record_stage1_rollback_drill_artifact(p_status text, p_app_revision text, p_evidence jsonb, p_expected_evidence_hash text, p_signer_key_id text, p_expected_signed_payload_hash text, p_signature text, p_started_at timestamp with time zone, p_completed_at timestamp with time zone, p_valid_until timestamp with time zone, p_actor text)
 RETURNS stage1_release_acceptance_artifacts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_runtime public.stage1_release_acceptance_artifacts%rowtype;
begin
  if p_status = 'passed' then
    select * into v_runtime
    from private.stage1_current_valid_release_artifact(
      'hosted_runtime_identity', pg_catalog.clock_timestamp()
    ) limit 1;
    if v_runtime.id is null
      or v_runtime.app_revision <> pg_catalog.btrim(p_app_revision)
      or p_evidence ->> 'contract_state_hash' <>
        private.stage1_release_contract_state_hash() then
      raise exception using errcode = '23514',
        message = 'Rollback proof is not bound to the current signed runtime and database contract.';
    end if;
  end if;
  return private.insert_stage1_external_release_artifact(
    'rollback_drill', 'production', p_status,
    'stage1-national-25-v3',
    '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9',
    'stage1-publication-v1', p_app_revision, p_evidence,
    p_expected_evidence_hash, p_signer_key_id,
    p_expected_signed_payload_hash, p_signature,
    p_started_at, p_completed_at, p_valid_until, p_actor
  );
end;
$function$
;

-- public.record_stage1_visual_crop_coverage_artifact: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION public.record_stage1_visual_crop_coverage_artifact(p_actor text)
 RETURNS stage1_release_acceptance_artifacts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_target jsonb := private.stage1_release_production_target_snapshot();
  v_runtime public.stage1_release_acceptance_artifacts%rowtype;
  v_r2 public.stage1_release_acceptance_artifacts%rowtype;
  v_objects jsonb;
  v_coverage jsonb;
  v_evidence jsonb;
  v_status text;
  v_artifact public.stage1_release_acceptance_artifacts%rowtype;
begin
  if nullif(pg_catalog.btrim(p_actor), '') is null then
    raise exception using errcode = '22023',
      message = 'A crop-coverage actor is required.';
  end if;
  if v_target ->> 'configured' <> 'true' then
    raise exception using errcode = '55000',
      message = 'The administrator-owned production target is not configured.';
  end if;
  select * into v_runtime
  from private.stage1_current_valid_release_artifact(
    'hosted_runtime_identity', v_now
  )
  limit 1;
  if v_runtime.id is null
    or v_runtime.completed_at < v_now - interval '1 hour' then
    raise exception using errcode = '23514',
      message = 'Current signed hosted runtime identity is required before deriving crop coverage.';
  end if;

  v_objects := private.stage1_visual_r2_object_set_snapshot();
  select * into v_r2
  from private.stage1_current_valid_release_artifact(
    'r2_recovery_drill', v_now
  ) artifact
  where artifact.app_revision = v_runtime.app_revision
    and private.stage1_r2_recovery_evidence_matches_snapshot(
      artifact.evidence, v_objects
    )
  limit 1;
  v_coverage := private.stage1_visual_crop_coverage_snapshot();
  v_evidence := v_coverage || pg_catalog.jsonb_build_object(

    'producer_contract', 'awardping.stage1.database-derived-release-evidence.v2',
    'derivation_contract_hash',
      private.stage1_visual_crop_derivation_contract_hash(),
    'measured_at', v_now,
    'target_config_version', (v_target ->> 'config_version')::bigint,
    'target_config_hash', v_target ->> 'target_config_hash',
    'production_app_origin', v_target ->> 'app_origin',
    'supabase_origin', v_target ->> 'supabase_origin',
    'supabase_project_ref', v_target ->> 'supabase_project_ref',
    'r2_hashes_verified', v_r2.id is not null,
    'r2_artifact_id', v_r2.id,
    'derived_at', v_now
  );
  v_status := case
    when v_evidence ->> 'unverified_publishable_events' = '0'
      and v_evidence ->> 'terminal_failures' = '0'
      and v_evidence ->> 'pdf_evidence_failures' = '0'
      and v_r2.id is not null
      then 'passed'
    else 'failed'
  end;

  insert into public.stage1_release_acceptance_artifacts (
    artifact_kind,
    producer_kind,
    environment,
    status,
    cohort_identity_version,
    cohort_identity_hash,
    policy_version,
    app_revision,
    target_config_version,
    target_config_hash,
    evidence,
    evidence_hash,
    started_at,
    completed_at,
    valid_until,
    actor
  ) values (
    'visual_crop_coverage',
    'database_derived',
    'production',
    v_status,
    'stage1-national-25-v3',
    '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9',
    'stage1-publication-v1',
    v_runtime.app_revision,
    (v_target ->> 'config_version')::bigint,
    v_target ->> 'target_config_hash',
    v_evidence,
    public.stage1_publication_evidence_hash(v_evidence),
    v_now,
    v_now,
    v_now + interval '24 hours',
    pg_catalog.btrim(p_actor)
  ) returning * into v_artifact;
  return v_artifact;
end;
$function$
;

-- public.stage1_effective_pub_pre_r2_graph_20260810184524: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION public.stage1_effective_pub_pre_r2_graph_20260810184524()
 RETURNS TABLE(cohort_key text, effectively_verified boolean, effective_reason text, evaluated_at timestamp with time zone, cohort_ready boolean, cohort_readiness_reason text, release_epoch uuid, release_state text, release_policy_version text, release_identity_version text, release_identity_hash text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with evaluated as (
    select statement_timestamp() as evaluated_at
  ),
  r2_object_set as (
    select private.stage1_visual_r2_object_set_snapshot() as value
  ),
  r2_release_proof as (
    select exists (
      select 1
      from private.stage1_current_valid_release_artifact(
        'r2_recovery_drill', evaluated.evaluated_at
      ) artifact
      where r2_object_set.value ->> 'unexpected_bucket_count' = '0'
        and r2_object_set.value ->> 'malformed_object_count' = '0'
        and r2_object_set.value ->> 'manifest_binding_error_count' = '0'
        and artifact.evidence ->> 'visual_object_set_hash' =
          r2_object_set.value ->> 'visual_object_set_hash'
        and artifact.evidence ->> 'visual_objects_checked' =
          r2_object_set.value ->> 'visual_object_count'
        and artifact.evidence ->> 'published_event_objects_checked' =
          r2_object_set.value ->> 'published_event_object_count'
        and artifact.evidence ->> 'manifest_source_objects_checked' =
          r2_object_set.value ->> 'manifest_source_object_count'
    ) as current
    from evaluated
    cross join r2_object_set
  ),
  identity_payload as (
    select
      count(*) as cohort_count,
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
          E'\n'
          order by registry.launch_rank
        )
      )) as identity_hash
    from public.stage1_award_registry registry
  ),
  cohort_reasons as (
    select
      registry.launch_rank,
      registry.cohort_key,
      registry.release_epoch as registry_release_epoch,
      reason.value as readiness_reason
    from public.stage1_award_registry registry
    cross join evaluated
    cross join lateral (
      select public.stage1_effective_publication_reason(
        registry.cohort_key,
        evaluated.evaluated_at
      ) as value
    ) reason
  ),
  release_decision as (
    select
      release_state.*,
      evaluated.evaluated_at,
      r2_release_proof.current,
      identity_payload.cohort_count,
      identity_payload.identity_hash,
      count(*) filter (where cohort_reasons.readiness_reason = 'verified') as ready_count,
      count(*) filter (
        where cohort_reasons.registry_release_epoch is distinct from release_state.release_epoch
      ) as epoch_mismatch_count,
      case
        when identity_payload.cohort_count <> 25
          or identity_payload.identity_hash <> '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9'
          or release_state.cohort_identity_version <> 'stage1-national-25-v3'
          or release_state.cohort_identity_hash <> identity_payload.identity_hash
          or release_state.policy_version <> 'stage1-publication-v1'
          then 'cohort_release_identity_mismatch'
        when not r2_release_proof.current
          then 'signed_r2_recovery_artifact_not_current'
        when release_state.release_state <> 'verified_beta'
          then 'cohort_release_not_activated'
        when count(*) filter (where cohort_reasons.readiness_reason = 'verified') <> 25
          then 'cohort_release_not_ready'
        when release_state.release_epoch is null
          or count(*) filter (
            where cohort_reasons.registry_release_epoch is distinct from release_state.release_epoch
          ) <> 0
          then 'cohort_release_epoch_mismatch'
        else 'verified'
      end as decision_reason
    from public.stage1_publication_release_state release_state
    cross join evaluated
    cross join r2_release_proof
    cross join identity_payload
    cross join cohort_reasons
    where release_state.release_key = 'stage1-national-25'
    group by
      release_state.release_key,
      release_state.release_state,
      release_state.release_epoch,
      release_state.reason,
      release_state.policy_version,
      release_state.cohort_identity_version,
      release_state.cohort_identity_hash,
      release_state.activated_at,
      release_state.updated_at,
      evaluated.evaluated_at,
      r2_release_proof.current,
      identity_payload.cohort_count,
      identity_payload.identity_hash
  )
  select
    cohort_reasons.cohort_key,
    release_decision.decision_reason = 'verified' as effectively_verified,
    release_decision.decision_reason as effective_reason,
    release_decision.evaluated_at,
    cohort_reasons.readiness_reason = 'verified' as cohort_ready,
    cohort_reasons.readiness_reason as cohort_readiness_reason,
    release_decision.release_epoch,
    release_decision.release_state,
    release_decision.policy_version as release_policy_version,
    release_decision.cohort_identity_version as release_identity_version,
    release_decision.cohort_identity_hash as release_identity_hash
  from cohort_reasons
  cross join release_decision
  order by cohort_reasons.launch_rank;
$function$
;

-- public.transition_stage1_cohort_release: v2 identity literals re-pinned to v3
CREATE OR REPLACE FUNCTION public.transition_stage1_cohort_release(p_next_state text, p_reason text, p_policy_version text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_release public.stage1_publication_release_state%rowtype;
  v_previous_state text;
  v_evaluated_at timestamptz := statement_timestamp();
  v_identity_payload text;
  v_identity_hash text;
  v_cohort_count integer;
  v_ready_count integer;
  v_updated_count integer;
  v_epoch uuid;
  v_evidence jsonb;
begin
  if p_next_state not in ('pending', 'verified_beta', 'revalidation_pending', 'suspended') then
    raise exception using errcode = '22023', message = 'Invalid Stage 1 cohort release state.';
  end if;
  if nullif(pg_catalog.btrim(p_reason), '') is null
    or nullif(pg_catalog.btrim(p_policy_version), '') is null
    or nullif(pg_catalog.btrim(p_actor), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Cohort release transitions require a reason, policy version, and actor.';
  end if;
  if p_policy_version <> 'stage1-publication-v1' then
    raise exception using errcode = '23514', message = 'Stage 1 cohort release policy version mismatch.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  select * into v_release
  from public.stage1_publication_release_state release_state
  where release_state.release_key = 'stage1-national-25'
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'The authoritative Stage 1 cohort release row is missing.';
  end if;
  v_previous_state := v_release.release_state;

  select
    count(*),
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
      E'\n'
      order by registry.launch_rank
    )
  into v_cohort_count, v_identity_payload
  from public.stage1_award_registry registry;
  v_identity_hash := public.stage1_publication_evidence_hash(
    pg_catalog.to_jsonb(v_identity_payload)
  );

  if v_cohort_count <> 25
    or v_identity_hash <> '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9' then
    raise exception using
      errcode = '23514',
      message = 'The registry does not exactly match the reviewed national 25 cohort.';
  end if;

  select count(*) filter (where reason.value = 'verified')
  into v_ready_count
  from public.stage1_award_registry registry
  cross join lateral (
    select public.stage1_effective_publication_reason(
      registry.cohort_key,
      v_evaluated_at
    ) as value
  ) reason;

  if p_next_state = 'verified_beta' then
    if v_ready_count <> 25 then
      raise exception using
        errcode = '23514',
        message = format(
          'The Stage 1 cohort release is not ready: %s/25 awards passed live verification.',
          v_ready_count
        );
    end if;
    v_epoch := gen_random_uuid();
    update public.stage1_award_registry registry
    set release_epoch = v_epoch, updated_at = v_evaluated_at;
    get diagnostics v_updated_count = row_count;
    if v_updated_count <> 25 then
      raise exception using
        errcode = '23514',
        message = 'The Stage 1 release epoch was not assigned to exactly 25 awards.';
    end if;
  else
    v_epoch := null;
    update public.stage1_award_registry registry
    set release_epoch = null, updated_at = v_evaluated_at
    where registry.release_epoch is not null;
  end if;

  update public.stage1_publication_release_state release_state
  set
    release_state = p_next_state,
    release_epoch = v_epoch,
    reason = pg_catalog.btrim(p_reason),
    policy_version = p_policy_version,
    cohort_identity_version = 'stage1-national-25-v3',
    cohort_identity_hash = v_identity_hash,
    activated_at = case when p_next_state = 'verified_beta' then v_evaluated_at else null end,
    updated_at = v_evaluated_at
  where release_state.release_key = 'stage1-national-25'
  returning * into v_release;

  v_evidence := pg_catalog.jsonb_build_object(
    'evaluated_at', v_evaluated_at,
    'cohort_count', v_cohort_count,
    'ready_cohort_count', v_ready_count,
    'cohort_identity_hash', v_identity_hash,
    'release_epoch', v_epoch
  );
  insert into public.stage1_publication_release_events (
    release_key,
    previous_state,
    next_state,
    release_epoch,
    reason,
    policy_version,
    cohort_identity_version,
    cohort_identity_hash,
    evidence_snapshot,
    evidence_hash,
    actor
  ) values (
    'stage1-national-25',
    v_previous_state,
    p_next_state,
    v_epoch,
    pg_catalog.btrim(p_reason),
    p_policy_version,
    'stage1-national-25-v3',
    v_identity_hash,
    v_evidence,
    public.stage1_publication_evidence_hash(v_evidence),
    pg_catalog.btrim(p_actor)
  );

  return pg_catalog.to_jsonb(v_release);
end;
$function$
;

-- The pending release row now names v3; any prior acceptance is void and the
-- activation ceremony must run against the v3 gate.
update public.stage1_publication_release_state release_state
set
  release_state = 'pending',
  release_epoch = null,
  activated_at = null,
  reason = 'Canonical identity v3 (truman /apply identity start; hertz/soros canonical homepages) requires a fresh exact 25-award release.',
  cohort_identity_version = 'stage1-national-25-v3',
  cohort_identity_hash = '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9',
  updated_at = pg_catalog.clock_timestamp()
where release_state.release_key = 'stage1-national-25'
  and (
    release_state.cohort_identity_version is distinct from 'stage1-national-25-v3'
    or release_state.cohort_identity_hash is distinct from '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9'
  );

-- No function may still pin the v2 identity after this migration.
do $$
declare
  v_remaining text;
begin
  select pg_catalog.string_agg(n.nspname || '.' || p.proname, ', ')
  into v_remaining
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where p.prosrc like '%6e7dd7ee1372671cbfb22b17b862d867145a93c7dc0b73d49afc11f504ee6c8f%' or p.prosrc like '%stage1-national-25-v2%';
  if v_remaining is not null then
    raise exception 'Functions still pin v2 identity literals: %', v_remaining;
  end if;
end $$;

commit;
