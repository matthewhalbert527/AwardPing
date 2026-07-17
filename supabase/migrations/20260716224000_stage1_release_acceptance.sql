-- Stage 1 public activation is deliberately separate from award-level
-- promotion.  Acceptance is generated from database-owned evidence; callers
-- cannot assert that a gate passed by supplying booleans in a JSON summary.
--
-- Four facts live outside Postgres (the hosted Auth/app response, an anonymous
-- deployed crawl, a rollback/restoration exercise, and R2 object reads).  Each
-- is imported through a kind-specific RPC with an HMAC produced by an isolated
-- evidence runner.  HMAC secrets are held in Supabase Vault and are never
-- accepted by, returned to, or readable through a service-role RPC.  Until a
-- signer is provisioned and a valid proof is imported, release fails closed.

create schema if not exists private;

-- The expected production destination is owned by a direct Postgres
-- administrator, not by the service-role evidence runner.  Do not seed this
-- row from repository defaults: production activation stays closed until an
-- administrator records the reviewed app, Supabase, deployment, and R2
-- identities in the actual production database.
create table private.stage1_release_production_targets (
  release_key text primary key check (release_key = 'stage1-national-25'),
  config_version bigint not null check (config_version > 0),
  app_origin text not null,
  supabase_origin text not null,
  supabase_project_ref text not null,
  deployment_provider text not null check (deployment_provider = 'vercel'),
  deployment_project_id text not null,
  deployment_team_slug text not null,
  r2_account_id text not null,
  r2_bucket text not null,
  configured_by text not null,
  configured_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint stage1_release_production_target_app_origin_check check (
    app_origin = pg_catalog.lower(app_origin)
    and app_origin ~ '^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  constraint stage1_release_production_target_supabase_check check (
    supabase_project_ref ~ '^[a-z0-9]{20}$'
    and supabase_origin = 'https://' || supabase_project_ref || '.supabase.co'
  ),
  constraint stage1_release_production_target_identity_check check (
    pg_catalog.length(pg_catalog.btrim(deployment_project_id)) between 8 and 200
    and deployment_team_slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'
    and r2_account_id ~ '^[a-f0-9]{32}$'
    and r2_bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
    and pg_catalog.length(pg_catalog.btrim(configured_by)) between 1 and 500
  )
);

create table public.stage1_release_acceptance_artifacts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  artifact_kind text not null check (artifact_kind in (
    'hosted_runtime_identity',
    'rollback_drill',
    'non_cohort_leak_crawl',
    'r2_recovery_drill',
    'visual_crop_coverage'
  )),
  producer_kind text not null check (
    producer_kind in ('external_signed', 'database_derived')
  ),
  environment text not null check (environment = 'production'),
  status text not null check (status in ('passed', 'failed')),
  cohort_identity_version text not null,
  cohort_identity_hash text not null check (cohort_identity_hash ~ '^[0-9a-f]{64}$'),
  policy_version text not null,
  app_revision text not null,
  target_config_version bigint not null check (target_config_version > 0),
  target_config_hash text not null check (target_config_hash ~ '^[0-9a-f]{64}$'),
  evidence jsonb not null check (pg_catalog.jsonb_typeof(evidence) = 'object'),
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  signer_key_id text,
  signed_payload_hash text check (
    signed_payload_hash is null or signed_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  signature text check (signature is null or signature ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null,
  completed_at timestamptz not null,
  valid_until timestamptz not null,
  actor text not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint stage1_release_acceptance_artifact_text_check check (
    pg_catalog.length(pg_catalog.btrim(policy_version)) between 1 and 200
    and pg_catalog.length(pg_catalog.btrim(app_revision)) between 1 and 500
    and pg_catalog.length(pg_catalog.btrim(actor)) between 1 and 500
  ),
  constraint stage1_release_acceptance_artifact_time_check check (
    started_at <= completed_at and completed_at < valid_until
  ),
  constraint stage1_release_acceptance_artifact_producer_check check (
    (
      producer_kind = 'external_signed'
      and artifact_kind <> 'visual_crop_coverage'
      and signer_key_id is not null
      and signed_payload_hash is not null
      and signature is not null
    )
    or (
      producer_kind = 'database_derived'
      and artifact_kind = 'visual_crop_coverage'
      and signer_key_id is null
      and signed_payload_hash is null
      and signature is null
    )
  )
);

create index stage1_release_acceptance_artifacts_latest_idx
  on public.stage1_release_acceptance_artifacts
  (artifact_kind, status, completed_at desc, id desc);

-- This table contains only Vault secret names, never secret material.  It has
-- no service-role mutation RPC.  Provision/rotate one key per external proof
-- kind using a direct postgres administration session after creating the
-- corresponding Vault secret.  A missing/disabled/expired signer is a hard
-- release failure.
create table private.stage1_release_evidence_signers (
  artifact_kind text primary key check (artifact_kind in (
    'hosted_runtime_identity',
    'rollback_drill',
    'non_cohort_leak_crawl',
    'r2_recovery_drill'
  )),
  key_id text not null unique,
  vault_secret_name text not null unique,
  producer_source_sha256 text not null check (
    producer_source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  environment text not null check (environment = 'production'),
  enabled boolean not null default true,
  valid_from timestamptz not null default pg_catalog.clock_timestamp(),
  valid_until timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint stage1_release_evidence_signer_text_check check (
    pg_catalog.length(pg_catalog.btrim(key_id)) between 8 and 200
    and pg_catalog.length(pg_catalog.btrim(vault_secret_name)) between 8 and 200
  ),
  constraint stage1_release_evidence_signer_time_check check (
    valid_until is null or valid_until > valid_from
  )
);

create table public.stage1_release_acceptance_records (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  status text not null default 'ready' check (
    status in ('ready', 'consumed', 'expired', 'rejected')
  ),
  release_key text not null default 'stage1-national-25'
    check (release_key = 'stage1-national-25'),
  cohort_identity_version text not null,
  cohort_identity_hash text not null check (cohort_identity_hash ~ '^[0-9a-f]{64}$'),
  policy_version text not null,
  summary jsonb not null check (pg_catalog.jsonb_typeof(summary) = 'object'),
  gate_state_hash text not null check (gate_state_hash ~ '^[0-9a-f]{64}$'),
  summary_hash text not null unique check (summary_hash ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz not null,
  expires_at timestamptz not null,
  actor text not null,
  consumed_at timestamptz,
  release_epoch uuid,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint stage1_release_acceptance_record_time_check check (
    generated_at < expires_at
    and expires_at <= generated_at + interval '15 minutes'
  ),
  constraint stage1_release_acceptance_record_consumption_check check (
    (status = 'consumed' and consumed_at is not null and release_epoch is not null)
    or (status <> 'consumed' and consumed_at is null and release_epoch is null)
  )
);

create table public.stage1_release_acceptance_artifact_links (
  acceptance_id uuid not null
    references public.stage1_release_acceptance_records(id) on delete restrict,
  artifact_id uuid not null
    references public.stage1_release_acceptance_artifacts(id) on delete restrict,
  artifact_kind text not null check (artifact_kind in (
    'hosted_runtime_identity',
    'rollback_drill',
    'non_cohort_leak_crawl',
    'r2_recovery_drill',
    'visual_crop_coverage'
  )),
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  primary key (acceptance_id, artifact_kind),
  unique (acceptance_id, artifact_id)
);

alter table public.stage1_release_acceptance_artifacts enable row level security;
alter table public.stage1_release_acceptance_records enable row level security;
alter table public.stage1_release_acceptance_artifact_links enable row level security;
alter table private.stage1_release_evidence_signers enable row level security;
alter table private.stage1_release_production_targets enable row level security;

revoke all on table public.stage1_release_acceptance_artifacts
  from public, anon, authenticated, service_role;
revoke all on table public.stage1_release_acceptance_records
  from public, anon, authenticated, service_role;
revoke all on table public.stage1_release_acceptance_artifact_links
  from public, anon, authenticated, service_role;
revoke all on table private.stage1_release_evidence_signers
  from public, anon, authenticated, service_role;
revoke all on table private.stage1_release_production_targets
  from public, anon, authenticated, service_role;
grant select on table public.stage1_release_acceptance_artifacts to service_role;
grant select on table public.stage1_release_acceptance_records to service_role;
grant select on table public.stage1_release_acceptance_artifact_links to service_role;

comment on table private.stage1_release_evidence_signers is
  'Postgres-admin-only mapping from release proof kinds to encrypted Supabase Vault secrets. No service-role write or secret-read path exists.';
comment on table private.stage1_release_production_targets is
  'Postgres-admin-only expected production origin/project/storage identity. A missing row keeps release acceptance closed.';

create or replace function private.stage1_release_hmac_sha256(
  p_payload text,
  p_secret text
)
returns text
language plpgsql
stable
strict
security definer
set search_path = ''
as $$
declare
  v_hmac text;
begin
  if pg_catalog.length(p_secret) < 32 then
    raise exception using errcode = '23514',
      message = 'The configured release evidence HMAC secret is too short.';
  end if;
  if pg_catalog.to_regprocedure('extensions.hmac(bytea,bytea,text)') is not null then
    execute
      'select pg_catalog.encode(extensions.hmac(pg_catalog.convert_to($1, ''UTF8''), pg_catalog.convert_to($2, ''UTF8''), ''sha256''), ''hex'')'
      into v_hmac using p_payload, p_secret;
  elsif pg_catalog.to_regprocedure('public.hmac(bytea,bytea,text)') is not null then
    execute
      'select pg_catalog.encode(public.hmac(pg_catalog.convert_to($1, ''UTF8''), pg_catalog.convert_to($2, ''UTF8''), ''sha256''), ''hex'')'
      into v_hmac using p_payload, p_secret;
  else
    raise exception using errcode = '55000',
      message = 'pgcrypto hmac(bytea,bytea,text) is required for signed release evidence.';
  end if;
  return v_hmac;
end;
$$;

revoke all on function private.stage1_release_hmac_sha256(text, text)
  from public, anon, authenticated, service_role;

create or replace function private.stage1_release_production_target_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with target as (
    select pg_catalog.jsonb_build_object(
      'release_key', configured.release_key,
      'config_version', configured.config_version,
      'app_origin', configured.app_origin,
      'supabase_origin', configured.supabase_origin,
      'supabase_project_ref', configured.supabase_project_ref,
      'deployment_provider', configured.deployment_provider,
      'deployment_project_id', configured.deployment_project_id,
      'deployment_team_slug', configured.deployment_team_slug,
      'r2_account_id', configured.r2_account_id,
      'r2_bucket', configured.r2_bucket
    ) as value
    from private.stage1_release_production_targets configured
    where configured.release_key = 'stage1-national-25'
  )
  select pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.production-target.v1',
    'configured', true,
    'target_config_hash', public.stage1_publication_evidence_hash(target.value)
  ) || target.value
  from target
  union all
  select pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.production-target.v1',
    'configured', false,
    'release_key', 'stage1-national-25',
    'config_version', null,
    'target_config_hash', null
  )
  where not exists (select 1 from target)
  limit 1;
$$;

revoke all on function private.stage1_release_production_target_snapshot()
  from public, anon, authenticated, service_role;

create or replace function public.get_stage1_release_producer_target()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target jsonb := private.stage1_release_production_target_snapshot();
begin
  if v_target ->> 'configured' <> 'true' then
    raise exception using errcode = '55000',
      message = 'A Postgres administrator has not configured the Stage 1 production target.';
  end if;
  return v_target;
end;
$$;

revoke all on function public.get_stage1_release_producer_target()
  from public, anon, authenticated, service_role;
grant execute on function public.get_stage1_release_producer_target()
  to service_role;

create or replace function public.get_stage1_release_leak_crawl_manifest()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target jsonb := private.stage1_release_production_target_snapshot();
  v_stage1 jsonb;
  v_non_cohort jsonb;
  v_manifest_basis jsonb;
begin
  if v_target ->> 'configured' <> 'true' then
    raise exception using errcode = '55000',
      message = 'The administrator-owned production target is not configured.';
  end if;
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'cohort_key', registry.cohort_key,
        'shared_award_id', registry.canonical_shared_award_id,
        'path', '/' || registry.canonical_slug,
        'expected_state', 'under_verification'
      ) order by registry.launch_rank
    ),
    '[]'::jsonb
  ) into v_stage1
  from public.stage1_award_registry registry;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'shared_award_id', award.id,
        'path', '/' || award.slug,
        'expected_status', 404
      ) order by award.id
    ),
    '[]'::jsonb
  ) into v_non_cohort
  from public.shared_awards award
  where award.status = 'active'
    and nullif(pg_catalog.btrim(award.slug), '') is not null
    and not exists (
      select 1
      from public.stage1_award_members member
      where member.shared_award_id = award.id
    );

  v_manifest_basis := pg_catalog.jsonb_build_object(
    'contract', 'awardping.stage1.anonymous-leak-crawl-manifest.v1',
    'target_config_hash', v_target ->> 'target_config_hash',
    'stage1_routes', v_stage1,
    'non_cohort_routes', v_non_cohort
  );
  return v_manifest_basis || pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.anonymous-leak-crawl-manifest.v1',
    'target', v_target,
    'stage1_route_count', pg_catalog.jsonb_array_length(v_stage1),
    'non_cohort_route_count', pg_catalog.jsonb_array_length(v_non_cohort),
    'route_manifest_sha256', public.stage1_publication_evidence_hash(v_manifest_basis)
  );
end;
$$;

revoke all on function public.get_stage1_release_leak_crawl_manifest()
  from public, anon, authenticated, service_role;
grant execute on function public.get_stage1_release_leak_crawl_manifest()
  to service_role;

create or replace function private.stage1_release_external_payload_hash(
  p_artifact_kind text,
  p_environment text,
  p_status text,
  p_cohort_identity_version text,
  p_cohort_identity_hash text,
  p_policy_version text,
  p_app_revision text,
  p_target_config_version bigint,
  p_target_config_hash text,
  p_evidence_hash text,
  p_signer_key_id text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_valid_until timestamptz,
  p_actor text
)
returns text
language sql
stable
strict
security definer
set search_path = ''
as $$
  select public.stage1_publication_evidence_hash(
    pg_catalog.jsonb_build_object(
      'contract', 'awardping.stage1.external-release-evidence.v2',
      'artifact_kind', p_artifact_kind,
      'environment', p_environment,
      'status', p_status,
      'cohort_identity_version', p_cohort_identity_version,
      'cohort_identity_hash', p_cohort_identity_hash,
      'policy_version', p_policy_version,
      'app_revision', p_app_revision,
      'target_config_version', p_target_config_version,
      'target_config_hash', p_target_config_hash,
      'evidence_hash', p_evidence_hash,
      'signer_key_id', p_signer_key_id,
      'started_at', p_started_at,
      'completed_at', p_completed_at,
      'valid_until', p_valid_until,
      'actor', p_actor
    )
  );
$$;

revoke all on function private.stage1_release_external_payload_hash(
  text, text, text, text, text, text, text, bigint, text, text, text,
  timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;

create or replace function private.stage1_release_evidence_matches_target(
  p_artifact_kind text,
  p_evidence jsonb,
  p_target jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_target ->> 'configured' = 'true'
    and p_evidence ->> 'target_config_version' = p_target ->> 'config_version'
    and p_evidence ->> 'target_config_hash' = p_target ->> 'target_config_hash'
    and p_evidence ->> 'production_app_origin' = p_target ->> 'app_origin'
    and p_evidence ->> 'supabase_origin' = p_target ->> 'supabase_origin'
    and p_evidence ->> 'supabase_project_ref' = p_target ->> 'supabase_project_ref'
    and case p_artifact_kind
      when 'hosted_runtime_identity' then
        p_evidence ->> 'base_url' = p_target ->> 'app_origin'
        and p_evidence ->> 'deployment_provider' = p_target ->> 'deployment_provider'
        and p_evidence ->> 'deployment_project_id' = p_target ->> 'deployment_project_id'
      when 'rollback_drill' then
        p_evidence ->> 'deployment_provider' = p_target ->> 'deployment_provider'
        and p_evidence ->> 'deployment_project_id' = p_target ->> 'deployment_project_id'
        and p_evidence ->> 'deployment_team_slug' = p_target ->> 'deployment_team_slug'
      when 'non_cohort_leak_crawl' then
        p_evidence ->> 'base_url' = p_target ->> 'app_origin'
      when 'r2_recovery_drill' then
        p_evidence ->> 'r2_account_id' = p_target ->> 'r2_account_id'
        and p_evidence ->> 'r2_bucket' = p_target ->> 'r2_bucket'
      when 'visual_crop_coverage' then true
      else false
    end;
$$;

revoke all on function private.stage1_release_evidence_matches_target(text, jsonb, jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.stage1_release_external_envelope_valid(
  p_artifact_kind text,
  p_status text,
  p_evidence jsonb,
  p_started_at timestamptz,
  p_completed_at timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_measured_at timestamptz;
begin
  if pg_catalog.jsonb_typeof(p_evidence) <> 'object'
    or p_evidence ->> 'producer_contract' <>
      'awardping.stage1.release-evidence-producer.v2'
    or p_evidence ->> 'producer_source_sha256' !~ '^[0-9a-f]{64}$'
    or p_evidence ->> 'measurement_id' !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_started_at is null
    or p_completed_at is null then
    return false;
  end if;
  begin
    v_measured_at := (p_evidence ->> 'measured_at')::timestamptz;
  exception when others then
    return false;
  end;
  return v_measured_at >= p_started_at - interval '5 minutes'
    and v_measured_at <= p_completed_at + interval '5 minutes'
    and case p_artifact_kind
      when 'hosted_runtime_identity' then
        p_status = 'passed'
        and private.stage1_release_artifact_evidence_valid(
          p_artifact_kind, p_evidence
        )
      when 'rollback_drill' then
        p_evidence ->> 'schema_version' = 'awardping.stage1.rollback-drill.v1'
        and p_evidence ->> 'measurement_method' =
          'vercel_cli_rollback_restore_probe_v1'
        and p_evidence ->> 'rollback_succeeded' in ('true', 'false')
        and p_evidence ->> 'restore_succeeded' in ('true', 'false')
        and nullif(pg_catalog.btrim(p_evidence ->> 'before_revision'), '') is not null
        and nullif(pg_catalog.btrim(p_evidence ->> 'rollback_revision'), '') is not null
        and nullif(pg_catalog.btrim(p_evidence ->> 'restored_revision'), '') is not null
        and p_evidence ->> 'before_state_hash' ~ '^[0-9a-f]{64}$'
        and p_evidence ->> 'rollback_state_hash' ~ '^[0-9a-f]{64}$'
        and p_evidence ->> 'restored_state_hash' ~ '^[0-9a-f]{64}$'
        and p_evidence ->> 'rollback_command_sha256' ~ '^[0-9a-f]{64}$'
        and p_evidence ->> 'restore_command_sha256' ~ '^[0-9a-f]{64}$'
        and p_evidence ->> 'contract_state_hash' ~ '^[0-9a-f]{64}$'
        and p_evidence ->> 'transition_events_checked' ~
          '^[2-9]$|^[1-9][0-9]+$'
        and p_status = case
          when private.stage1_release_artifact_evidence_valid(
            p_artifact_kind, p_evidence
          ) then 'passed'
          else 'failed'
        end
      when 'non_cohort_leak_crawl' then
        p_evidence ->> 'schema_version' =
          'awardping.stage1.non-cohort-leak-crawl.v1'
        and p_evidence ->> 'measurement_method' =
          'anonymous_exact_origin_crawl_v1'
        and p_evidence ->> 'anonymous' = 'true'
        and p_evidence ->> 'redirects_followed' = 'false'
        and p_evidence ->> 'authorization_header_sent' = 'false'
        and p_evidence ->> 'cookie_header_sent' = 'false'
        and p_evidence ->> 'routes_checked' ~ '^[1-9][0-9]*$'
        and p_evidence ->> 'non_cohort_awards_sampled' ~ '^[1-9][0-9]*$'
        and p_evidence ->> 'stage1_awards_observed' ~ '^[0-9]+$'
        and p_evidence ->> 'stage1_under_verification_pages' ~ '^[0-9]+$'
        and p_evidence ->> 'non_cohort_leaks' ~ '^[0-9]+$'
        and p_evidence ->> 'unexpected_stage1_leaks' ~ '^[0-9]+$'
        and p_evidence ->> 'route_manifest_sha256' ~ '^[0-9a-f]{64}$'
        and p_evidence ->> 'response_set_sha256' ~ '^[0-9a-f]{64}$'
        and p_evidence ->> 'runtime_identity_response_sha256' ~
          '^[0-9a-f]{64}$'
        and p_status = case
          when private.stage1_release_artifact_evidence_valid(
            p_artifact_kind, p_evidence
          ) then 'passed'
          else 'failed'
        end
      when 'r2_recovery_drill' then
        p_evidence ->> 'schema_version' =
          'awardping.stage1.r2-recovery-drill.v1'
        and p_evidence ->> 'measurement_method' = 'r2_full_get_sha256_v1'
        and p_evidence ->> 'hash_verified' in ('true', 'false')
        and p_evidence ->> 'recovered_objects' ~ '^[0-9]+$'
        and p_evidence ->> 'failed_objects' ~ '^[0-9]+$'
        and p_evidence ->> 'refused_objects' ~ '^[0-9]+$'
        and p_evidence ->> 'visual_objects_checked' ~ '^[1-9][0-9]*$'
        and p_evidence ->> 'visual_object_set_hash' ~ '^[0-9a-f]{64}$'
        and p_evidence ->> 'recovery_manifest_sha256' ~ '^[0-9a-f]{64}$'
        and p_status = case
          when private.stage1_release_artifact_evidence_valid(
            p_artifact_kind, p_evidence
          ) then 'passed'
          else 'failed'
        end
      else false
    end;
end;
$$;

revoke all on function private.stage1_release_external_envelope_valid(
  text, text, jsonb, timestamptz, timestamptz
) from public, anon, authenticated, service_role;

create or replace function private.stage1_release_artifact_evidence_valid(
  p_artifact_kind text,
  p_evidence jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_evidence) = 'object'
    and (
      (
        p_artifact_kind <> 'visual_crop_coverage'
        and p_evidence ->> 'producer_contract' =
          'awardping.stage1.release-evidence-producer.v2'
        and p_evidence ->> 'producer_source_sha256' ~ '^[0-9a-f]{64}$'
        and p_evidence ->> 'measurement_id' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
      or (
        p_artifact_kind = 'visual_crop_coverage'
        and p_evidence ->> 'producer_contract' =
          'awardping.stage1.database-derived-release-evidence.v2'
        and p_evidence ->> 'derivation_contract_hash' ~ '^[0-9a-f]{64}$'
      )
    )
    and nullif(pg_catalog.btrim(p_evidence ->> 'measured_at'), '') is not null
    and p_evidence ->> 'target_config_version' ~ '^[1-9][0-9]*$'
    and p_evidence ->> 'target_config_hash' ~ '^[0-9a-f]{64}$'
    and p_evidence ->> 'production_app_origin' ~ '^https://'
    and p_evidence ->> 'supabase_origin' ~ '^https://[a-z0-9]{20}\.supabase\.co$'
    and p_evidence ->> 'supabase_project_ref' ~ '^[a-z0-9]{20}$'
    and case p_artifact_kind
    when 'hosted_runtime_identity' then
      p_evidence ->> 'schema_version' = 'awardping.stage1.hosted-runtime-identity.v1'
      and p_evidence ->> 'measurement_method' = 'direct_no_redirect_https_get_v1'
      and p_evidence ->> 'disable_signup' = 'true'
      and p_evidence ->> 'identity_http_status' = '200'
      and p_evidence ->> 'auth_http_status' = '200'
      and p_evidence ->> 'identity_redirected' = 'false'
      and p_evidence ->> 'auth_redirected' = 'false'
      and p_evidence ->> 'base_url' = p_evidence ->> 'production_app_origin'
      and p_evidence ->> 'identity_url' =
        p_evidence ->> 'production_app_origin' || '/api/monitoring-policy-identity'
      and p_evidence ->> 'auth_settings_url' =
        p_evidence ->> 'supabase_origin' || '/auth/v1/settings'
      and p_evidence ->> 'deployment_provider' = 'vercel'
      and nullif(pg_catalog.btrim(p_evidence ->> 'deployment_project_id'), '') is not null
      and nullif(pg_catalog.btrim(p_evidence ->> 'app_revision'), '') is not null
      and nullif(pg_catalog.btrim(p_evidence ->> 'policy_hash'), '') is not null
      and nullif(pg_catalog.btrim(p_evidence ->> 'batch_policy_hash'), '') is not null
      and nullif(pg_catalog.btrim(p_evidence ->> 'suppression_policy_hash'), '') is not null
      and p_evidence ->> 'matcher_hash' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'identity_response_sha256' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'auth_response_sha256' ~ '^[0-9a-f]{64}$'
      and nullif(pg_catalog.btrim(p_evidence ->> 'observed_at'), '') is not null
    when 'rollback_drill' then
      p_evidence ->> 'schema_version' = 'awardping.stage1.rollback-drill.v1'
      and p_evidence ->> 'measurement_method' =
        'vercel_cli_rollback_restore_probe_v1'
      and p_evidence ->> 'rollback_succeeded' = 'true'
      and p_evidence ->> 'restore_succeeded' = 'true'
      and p_evidence ->> 'deployment_provider' = 'vercel'
      and nullif(pg_catalog.btrim(p_evidence ->> 'deployment_project_id'), '') is not null
      and nullif(pg_catalog.btrim(p_evidence ->> 'deployment_team_slug'), '') is not null
      and nullif(pg_catalog.btrim(p_evidence ->> 'rollback_deployment'), '') is not null
      and nullif(pg_catalog.btrim(p_evidence ->> 'restore_deployment'), '') is not null
      and nullif(pg_catalog.btrim(p_evidence ->> 'before_revision'), '') is not null
      and nullif(pg_catalog.btrim(p_evidence ->> 'rollback_revision'), '') is not null
      and p_evidence ->> 'restored_revision' = p_evidence ->> 'before_revision'
      and p_evidence ->> 'rollback_revision' <> p_evidence ->> 'before_revision'
      and p_evidence ->> 'before_state_hash' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'rollback_state_hash' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'restored_state_hash' = p_evidence ->> 'before_state_hash'
      and p_evidence ->> 'rollback_state_hash' <> p_evidence ->> 'before_state_hash'
      and p_evidence ->> 'rollback_command_sha256' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'restore_command_sha256' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'contract_state_hash' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'transition_events_checked' ~ '^[2-9]$|^[1-9][0-9]+$'
    when 'non_cohort_leak_crawl' then
      p_evidence ->> 'schema_version' = 'awardping.stage1.non-cohort-leak-crawl.v1'
      and p_evidence ->> 'measurement_method' =
        'anonymous_exact_origin_crawl_v1'
      and p_evidence ->> 'anonymous' = 'true'
      and p_evidence ->> 'redirects_followed' = 'false'
      and p_evidence ->> 'authorization_header_sent' = 'false'
      and p_evidence ->> 'cookie_header_sent' = 'false'
      and p_evidence ->> 'base_url' = p_evidence ->> 'production_app_origin'
      and p_evidence ->> 'routes_checked' ~ '^[1-9][0-9]*$'
      and p_evidence ->> 'non_cohort_awards_sampled' ~ '^[1-9][0-9]*$'
      and p_evidence ->> 'stage1_awards_observed' = '25'
      and p_evidence ->> 'stage1_under_verification_pages' = '25'
      and p_evidence ->> 'non_cohort_leaks' = '0'
      and p_evidence ->> 'unexpected_stage1_leaks' = '0'
      and p_evidence ->> 'route_manifest_sha256' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'response_set_sha256' ~ '^[0-9a-f]{64}$'
    when 'r2_recovery_drill' then
      p_evidence ->> 'schema_version' = 'awardping.stage1.r2-recovery-drill.v1'
      and p_evidence ->> 'measurement_method' = 'r2_full_get_sha256_v1'
      and p_evidence ->> 'hash_verified' = 'true'
      and p_evidence ->> 'r2_account_id' ~ '^[a-f0-9]{32}$'
      and p_evidence ->> 'r2_bucket' ~ '^[a-z0-9][a-z0-9.-]+[a-z0-9]$'
      and p_evidence ->> 'r2_endpoint' =
        'https://' || (p_evidence ->> 'r2_account_id') || '.r2.cloudflarestorage.com'
      and p_evidence ->> 'recovered_objects' ~ '^[1-9][0-9]*$'
      and p_evidence ->> 'failed_objects' = '0'
      and p_evidence ->> 'refused_objects' = '0'
      and p_evidence ->> 'visual_objects_checked' ~ '^[0-9]+$'
      and p_evidence ->> 'visual_object_set_hash' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'recovery_manifest_sha256' ~ '^[0-9a-f]{64}$'
    when 'visual_crop_coverage' then
      p_evidence ->> 'schema_version' = 'awardping.stage1.visual-crop-coverage.v2'
      and p_evidence ->> 'eligible_events' ~ '^[0-9]+$'
      and p_evidence ->> 'verified_events' ~ '^[0-9]+$'
      and p_evidence ->> 'unverified_publishable_events' = '0'
      and p_evidence ->> 'terminal_failures' = '0'
      and p_evidence ->> 'pdf_evidence_failures' = '0'
      and p_evidence ->> 'r2_hashes_verified' = 'true'
      and p_evidence ->> 'coverage_set_hash' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'visual_object_set_hash' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'visual_object_count' ~ '^[0-9]+$'
    else false
  end;
$$;

revoke all on function private.stage1_release_artifact_evidence_valid(text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.prevent_stage1_release_acceptance_artifact_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using errcode = '55000',
    message = 'Stage 1 release acceptance artifacts and links are immutable.';
end;
$$;

revoke all on function public.prevent_stage1_release_acceptance_artifact_mutation()
  from public, anon, authenticated, service_role;

create trigger stage1_release_acceptance_artifacts_immutable
before update or delete on public.stage1_release_acceptance_artifacts
for each row execute function public.prevent_stage1_release_acceptance_artifact_mutation();

create trigger stage1_release_acceptance_links_immutable
before update or delete on public.stage1_release_acceptance_artifact_links
for each row execute function public.prevent_stage1_release_acceptance_artifact_mutation();

-- Deterministically identify every retained object referenced by an
-- unsuppressed Stage 1 event.  The signed R2 producer must HEAD/read this exact
-- set and bind its proof to the returned count and hash.
create or replace function private.stage1_visual_r2_object_set_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with stage1_events as (
    select evidence.*
    from public.shared_award_change_event_visual_evidence evidence
    join public.shared_award_change_events event
      on event.id = evidence.change_event_id
    where event.suppressed_at is null
      and exists (
        select 1
        from public.stage1_award_members member
        where member.shared_award_id = event.shared_award_id
      )
  ), artifact_values as (
    select
      event.bucket,
      side.side_name,
      artifact.artifact_name,
      artifact.value
    from stage1_events event
    cross join lateral (values
      ('previous'::text, event.previous_capture),
      ('current'::text, event.current_capture)
    ) as side(side_name, capture)
    cross join lateral (values
      ('full'::text, side.capture -> 'full'),
      ('metadata'::text, side.capture -> 'metadata'),
      ('layout'::text, side.capture -> 'layout'),
      ('crop'::text, side.capture -> 'crop')
    ) as artifact(artifact_name, value)
    where nullif(pg_catalog.btrim(artifact.value ->> 'object_key'), '') is not null
  ), object_rows as (
    select distinct
      bucket,
      side_name,
      artifact_name,
      value ->> 'object_key' as object_key,
      value ->> 'sha256' as sha256,
      value ->> 'byte_length' as byte_length,
      value ->> 'content_type' as content_type
    from artifact_values
  ), object_payload as (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'bucket', bucket,
          'side', side_name,
          'artifact', artifact_name,
          'object_key', object_key,
          'sha256', sha256,
          'byte_length', byte_length,
          'content_type', content_type
        ) order by bucket, object_key, side_name, artifact_name
      ),
      '[]'::jsonb
    ) as value
    from object_rows
  ), object_quality as (
    select
      count(*) filter (
        where bucket is distinct from (
          private.stage1_release_production_target_snapshot() ->> 'r2_bucket'
        )
      ) as unexpected_bucket_count,
      count(*) filter (
        where object_key !~ '^visual-snapshots/published/'
          or sha256 !~ '^[0-9a-f]{64}$'
          or byte_length !~ '^[1-9][0-9]*$'
          or content_type is null
          or content_type !~ '^(image/|application/json)'
      ) as malformed_object_count
    from object_rows
  )
  select pg_catalog.jsonb_build_object(
    'visual_object_count', pg_catalog.jsonb_array_length(object_payload.value),
    'visual_object_set_hash', public.stage1_publication_evidence_hash(object_payload.value),
    'unexpected_bucket_count', object_quality.unexpected_bucket_count,
    'malformed_object_count', object_quality.malformed_object_count,
    'objects', object_payload.value
  )
  from object_payload
  cross join object_quality;
$$;

revoke all on function private.stage1_visual_r2_object_set_snapshot()
  from public, anon, authenticated, service_role;

create or replace function public.get_stage1_release_r2_verification_manifest()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target jsonb := private.stage1_release_production_target_snapshot();
  v_manifest jsonb := private.stage1_visual_r2_object_set_snapshot();
begin
  if v_target ->> 'configured' <> 'true' then
    raise exception using errcode = '55000',
      message = 'The administrator-owned production target is not configured.';
  end if;
  return pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.r2-verification-manifest.v1',
    'target', v_target,
    'visual_object_count', v_manifest -> 'visual_object_count',
    'visual_object_set_hash', v_manifest -> 'visual_object_set_hash',
    'unexpected_bucket_count', v_manifest -> 'unexpected_bucket_count',
    'malformed_object_count', v_manifest -> 'malformed_object_count',
    'objects', v_manifest -> 'objects'
  );
end;
$$;

revoke all on function public.get_stage1_release_r2_verification_manifest()
  from public, anon, authenticated, service_role;
grant execute on function public.get_stage1_release_r2_verification_manifest()
  to service_role;

-- Keep this release-gate dependency private and local to this migration.  The
-- stricter public exact-text validation helpers are installed by the next
-- migration, but a clean migration chain must not depend on a future object.
create or replace function private.stage1_visual_json_text_values(p_value jsonb)
returns setof text
language sql
immutable
security definer
set search_path = ''
as $$
  select p_value #>> '{}'
  where pg_catalog.jsonb_typeof(p_value) = 'string'
  union all
  select item.value #>> '{}'
  from pg_catalog.jsonb_array_elements(
    case
      when pg_catalog.jsonb_typeof(p_value) = 'array' then p_value
      else '[]'::jsonb
    end
  ) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'string';
$$;

revoke all on function private.stage1_visual_json_text_values(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.stage1_visual_event_has_semantic_side(
  p_change_details jsonb,
  p_side text
)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  with details as (
    select case
      when pg_catalog.jsonb_typeof(p_change_details) = 'object'
        then p_change_details
      else '{}'::jsonb
    end as value
  ), candidates as (
    select exact_value.value as wording
    from details
    cross join lateral private.stage1_visual_json_text_values(
      case
        when p_side = 'previous' then details.value -> 'exact_before'
        else details.value -> 'exact_after'
      end
    ) as exact_value(value)
    union all
    select structured_value.value
    from details
    cross join lateral private.stage1_visual_json_text_values(
      details.value -> 'structured_diff' -> case
        when p_side = 'previous' then 'removed_text'
        else 'added_text'
      end
    ) as structured_value(value)
    union all
    select fact_value.value
    from details
    cross join lateral pg_catalog.jsonb_array_elements(
      coalesce(
        case
          when pg_catalog.jsonb_typeof(details.value -> 'changed_facts') = 'array'
            then details.value -> 'changed_facts'
        end,
        '[]'::jsonb
      ) || coalesce(
        case
          when pg_catalog.jsonb_typeof(details.value -> 'changed_award_facts') = 'array'
            then details.value -> 'changed_award_facts'
        end,
        '[]'::jsonb
      )
    ) as fact(value)
    cross join lateral private.stage1_visual_json_text_values(
      fact.value -> case
        when p_side = 'previous' then 'removed_text'
        else 'added_text'
      end
    ) as fact_value(value)
  )
  select p_side in ('previous', 'current')
    and exists (
      select 1
      from candidates
      where nullif(pg_catalog.btrim(candidates.wording), '') is not null
    );
$$;

revoke all on function private.stage1_visual_event_has_semantic_side(jsonb, text)
  from public, anon, authenticated, service_role;

-- Coverage is measured from actual published event evidence.  Stored layout
-- metadata alone never counts.  HTML events need v2 exact-text crops; PDFs
-- need an explicit not-applicable PDF evidence row.
create or replace function private.stage1_visual_crop_coverage_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with stage1_events as (
    select
      event.id,
      event.visual_review_candidate_id,
      event.source_page_type,
      event.change_details,
      evidence.id as evidence_id,
      evidence.visual_review_candidate_id as evidence_candidate_id,
      evidence.evidence_status,
      evidence.evidence_schema_version,
      evidence.previous_capture,
      evidence.current_capture,
      evidence.localization,
      coalesce(event.source_page_type, '') = 'pdf' as is_pdf,
      (
        coalesce(event.source_page_type, '') <> 'pdf'
        and event.visual_review_candidate_id is not null
        and evidence.id is not null
        and evidence.visual_review_candidate_id = event.visual_review_candidate_id
        and evidence.evidence_status = 'verified'
        and evidence.evidence_schema_version = 'visual-event-evidence-v2'
        and evidence.localization ->> 'semantic_contract' = 'visual-exact-text-binding-v2'
        and evidence.localization ->> 'change_semantics_sha256' ~ '^[0-9a-f]{64}$'
        and (
          not private.stage1_visual_event_has_semantic_side(event.change_details, 'previous')
          or (
            evidence.localization #>> '{sides,previous,status}' = 'verified'
            and evidence.localization #>> '{sides,previous,algorithm_version}' = '3'
            and evidence.localization #>> '{sides,previous,semantic_binding,contract}' =
              'visual-exact-text-binding-v2'
            and evidence.localization #>> '{sides,previous,semantic_binding,algorithm_version}' = '3'
            and evidence.localization #>> '{sides,previous,semantic_binding,binding_sha256}' =
              evidence.previous_capture #>> '{crop,semantic_binding_sha256}'
            and evidence.previous_capture #>> '{crop,object_key}' like 'visual-snapshots/published/%'
            and evidence.previous_capture #>> '{crop,sha256}' ~ '^[0-9a-f]{64}$'
            and evidence.previous_capture #>> '{crop,semantic_binding_sha256}' ~ '^[0-9a-f]{64}$'
            and coalesce((evidence.previous_capture #>> '{crop,exact_overlap}')::boolean, false)
          )
        )
        and (
          not private.stage1_visual_event_has_semantic_side(event.change_details, 'current')
          or (
            evidence.localization #>> '{sides,current,status}' = 'verified'
            and evidence.localization #>> '{sides,current,algorithm_version}' = '3'
            and evidence.localization #>> '{sides,current,semantic_binding,contract}' =
              'visual-exact-text-binding-v2'
            and evidence.localization #>> '{sides,current,semantic_binding,algorithm_version}' = '3'
            and evidence.localization #>> '{sides,current,semantic_binding,binding_sha256}' =
              evidence.current_capture #>> '{crop,semantic_binding_sha256}'
            and evidence.current_capture #>> '{crop,object_key}' like 'visual-snapshots/published/%'
            and evidence.current_capture #>> '{crop,sha256}' ~ '^[0-9a-f]{64}$'
            and evidence.current_capture #>> '{crop,semantic_binding_sha256}' ~ '^[0-9a-f]{64}$'
            and coalesce((evidence.current_capture #>> '{crop,exact_overlap}')::boolean, false)
          )
        )
      ) as crop_verified
    from public.shared_award_change_events event
    left join public.shared_award_change_event_visual_evidence evidence
      on evidence.change_event_id = event.id
    where event.suppressed_at is null
      and exists (
        select 1
        from public.stage1_award_members member
        where member.shared_award_id = event.shared_award_id
      )
  ), coverage_payload as (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'event_id', id,
          'candidate_id', visual_review_candidate_id,
          'evidence_id', evidence_id,
          'status', evidence_status,
          'schema', evidence_schema_version,
          'crop_verified', crop_verified,
          'previous_crop_sha256', previous_capture #>> '{crop,sha256}',
          'current_crop_sha256', current_capture #>> '{crop,sha256}',
          'change_semantics_sha256', localization ->> 'change_semantics_sha256'
        ) order by id
      ),
      '[]'::jsonb
    ) as value
    from stage1_events
  ), counts as (
    select
      count(*) filter (where not is_pdf) as eligible_events,
      count(*) filter (where not is_pdf and crop_verified) as verified_events,
      count(*) filter (where not is_pdf and not crop_verified) as unverified_events,
      count(*) filter (
        where not is_pdf and coalesce(evidence_status, 'missing') in (
          'missing',
          'unavailable_exact_text_missing',
          'unavailable_geometry_missing',
          'unavailable_image_missing',
          'unavailable_ambiguous',
          'historical_artifact_unrecoverable',
          'full_screenshot_fallback'
        )
      ) as terminal_failures,
      count(*) filter (
        where is_pdf and (
          evidence_id is null
          or evidence_status <> 'not_applicable_pdf'
          or visual_review_candidate_id is distinct from evidence_candidate_id
        )
      ) as pdf_evidence_failures
    from stage1_events
  ), objects as (
    select private.stage1_visual_r2_object_set_snapshot() as value
  )
  select pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.visual-crop-coverage.v2',
    'eligible_events', counts.eligible_events,
    'verified_events', counts.verified_events,
    'unverified_publishable_events', counts.unverified_events,
    'terminal_failures', counts.terminal_failures,
    'pdf_evidence_failures', counts.pdf_evidence_failures,
    'coverage_set_hash', public.stage1_publication_evidence_hash(coverage_payload.value),
    'visual_object_count', objects.value -> 'visual_object_count',
    'visual_object_set_hash', objects.value -> 'visual_object_set_hash'
  )
  from counts
  cross join coverage_payload
  cross join objects;
$$;

revoke all on function private.stage1_visual_crop_coverage_snapshot()
  from public, anon, authenticated, service_role;

create or replace function private.stage1_visual_crop_derivation_contract_hash()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.stage1_publication_evidence_hash(
    pg_catalog.jsonb_build_object(
      'contract', 'awardping.stage1.visual-crop-db-derivation.v2',
      'event_scope', 'unsuppressed_stage1_change_events',
      'html_requirement', 'visual-event-evidence-v2-exact-text-overlap',
      'pdf_requirement', 'candidate-bound-not-applicable-pdf',
      'object_requirement', 'current-signed-r2-object-set'
    )
  );
$$;

revoke all on function private.stage1_visual_crop_derivation_contract_hash()
  from public, anon, authenticated, service_role;

create or replace function private.stage1_release_contract_state_hash()
returns text
language sql
stable
security definer
set search_path = ''
as $$
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
      'cohort_identity_version', 'stage1-national-25-v1',
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
$$;

revoke all on function private.stage1_release_contract_state_hash()
  from public, anon, authenticated, service_role;

create or replace function public.get_stage1_release_contract_state_hash()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.stage1_release_contract_state_hash();
$$;

revoke all on function public.get_stage1_release_contract_state_hash()
  from public, anon, authenticated, service_role;
grant execute on function public.get_stage1_release_contract_state_hash()
  to service_role;

-- Private canonicalization shared by four kind-specific preflights.  No public
-- RPC accepts an artifact kind or a caller-selected target.
create or replace function private.stage1_release_external_signing_preflight(
  p_artifact_kind text,
  p_status text,
  p_app_revision text,
  p_evidence jsonb,
  p_signer_key_id text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_valid_until timestamptz,
  p_actor text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    'stage1-national-25-v1',
    '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e',
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
$$;

revoke all on function private.stage1_release_external_signing_preflight(
  text, text, text, jsonb, text,
  timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;

create or replace function public.prepare_stage1_hosted_runtime_identity_artifact(
  p_status text, p_app_revision text, p_evidence jsonb, p_signer_key_id text,
  p_started_at timestamptz, p_completed_at timestamptz,
  p_valid_until timestamptz, p_actor text
)
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.stage1_release_external_signing_preflight(
    'hosted_runtime_identity', p_status, p_app_revision, p_evidence,
    p_signer_key_id, p_started_at, p_completed_at, p_valid_until, p_actor
  );
$$;

create or replace function public.prepare_stage1_rollback_drill_artifact(
  p_status text, p_app_revision text, p_evidence jsonb, p_signer_key_id text,
  p_started_at timestamptz, p_completed_at timestamptz,
  p_valid_until timestamptz, p_actor text
)
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.stage1_release_external_signing_preflight(
    'rollback_drill', p_status, p_app_revision, p_evidence,
    p_signer_key_id, p_started_at, p_completed_at, p_valid_until, p_actor
  );
$$;

create or replace function public.prepare_stage1_non_cohort_leak_crawl_artifact(
  p_status text, p_app_revision text, p_evidence jsonb, p_signer_key_id text,
  p_started_at timestamptz, p_completed_at timestamptz,
  p_valid_until timestamptz, p_actor text
)
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.stage1_release_external_signing_preflight(
    'non_cohort_leak_crawl', p_status, p_app_revision, p_evidence,
    p_signer_key_id, p_started_at, p_completed_at, p_valid_until, p_actor
  );
$$;

create or replace function public.prepare_stage1_r2_recovery_drill_artifact(
  p_status text, p_app_revision text, p_evidence jsonb, p_signer_key_id text,
  p_started_at timestamptz, p_completed_at timestamptz,
  p_valid_until timestamptz, p_actor text
)
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.stage1_release_external_signing_preflight(
    'r2_recovery_drill', p_status, p_app_revision, p_evidence,
    p_signer_key_id, p_started_at, p_completed_at, p_valid_until, p_actor
  );
$$;

revoke all on function public.prepare_stage1_hosted_runtime_identity_artifact(
  text, text, jsonb, text, timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
revoke all on function public.prepare_stage1_rollback_drill_artifact(
  text, text, jsonb, text, timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
revoke all on function public.prepare_stage1_non_cohort_leak_crawl_artifact(
  text, text, jsonb, text, timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
revoke all on function public.prepare_stage1_r2_recovery_drill_artifact(
  text, text, jsonb, text, timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_stage1_hosted_runtime_identity_artifact(
  text, text, jsonb, text, timestamptz, timestamptz, timestamptz, text
) to service_role;
grant execute on function public.prepare_stage1_rollback_drill_artifact(
  text, text, jsonb, text, timestamptz, timestamptz, timestamptz, text
) to service_role;
grant execute on function public.prepare_stage1_non_cohort_leak_crawl_artifact(
  text, text, jsonb, text, timestamptz, timestamptz, timestamptz, text
) to service_role;
grant execute on function public.prepare_stage1_r2_recovery_drill_artifact(
  text, text, jsonb, text, timestamptz, timestamptz, timestamptz, text
) to service_role;

create or replace function private.stage1_release_artifact_signature_valid(
  p_artifact_id uuid,
  p_evaluated_at timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_artifact public.stage1_release_acceptance_artifacts%rowtype;
  v_signer private.stage1_release_evidence_signers%rowtype;
  v_target jsonb := private.stage1_release_production_target_snapshot();
  v_secret text;
  v_expected_payload_hash text;
  v_expected_signature text;
begin
  select * into v_artifact
  from public.stage1_release_acceptance_artifacts artifact
  where artifact.id = p_artifact_id;
  if not found then return false; end if;
  if v_target ->> 'configured' <> 'true'
    or v_artifact.target_config_version is distinct from
      (v_target ->> 'config_version')::bigint
    or v_artifact.target_config_hash is distinct from
      v_target ->> 'target_config_hash'
    or not private.stage1_release_evidence_matches_target(
      v_artifact.artifact_kind, v_artifact.evidence, v_target
    ) then
    return false;
  end if;

  if v_artifact.producer_kind = 'database_derived' then
    return v_artifact.artifact_kind = 'visual_crop_coverage'
      and v_artifact.signer_key_id is null
      and v_artifact.signed_payload_hash is null
      and v_artifact.signature is null;
  end if;

  if v_artifact.producer_kind <> 'external_signed'
    or not private.stage1_release_external_envelope_valid(
      v_artifact.artifact_kind,
      v_artifact.status,
      v_artifact.evidence,
      v_artifact.started_at,
      v_artifact.completed_at
    ) then
    return false;
  end if;

  select * into v_signer
  from private.stage1_release_evidence_signers signer
  where signer.artifact_kind = v_artifact.artifact_kind
    and signer.key_id = v_artifact.signer_key_id
    and signer.producer_source_sha256 =
      v_artifact.evidence ->> 'producer_source_sha256'
    and signer.environment = v_artifact.environment
    and signer.enabled
    and signer.valid_from <= v_artifact.completed_at
    and (signer.valid_until is null or signer.valid_until > p_evaluated_at);
  if not found or pg_catalog.to_regclass('vault.decrypted_secrets') is null then
    return false;
  end if;

  execute
    'select decrypted_secret from vault.decrypted_secrets where name = $1 order by updated_at desc limit 1'
    into v_secret using v_signer.vault_secret_name;
  if nullif(v_secret, '') is null or pg_catalog.length(v_secret) < 32 then
    return false;
  end if;

  v_expected_payload_hash := private.stage1_release_external_payload_hash(
    v_artifact.artifact_kind,
    v_artifact.environment,
    v_artifact.status,
    v_artifact.cohort_identity_version,
    v_artifact.cohort_identity_hash,
    v_artifact.policy_version,
    v_artifact.app_revision,
    v_artifact.target_config_version,
    v_artifact.target_config_hash,
    v_artifact.evidence_hash,
    v_artifact.signer_key_id,
    v_artifact.started_at,
    v_artifact.completed_at,
    v_artifact.valid_until,
    v_artifact.actor
  );
  v_expected_signature := private.stage1_release_hmac_sha256(
    v_expected_payload_hash,
    v_secret
  );
  return v_artifact.signed_payload_hash = v_expected_payload_hash
    and v_artifact.signature = v_expected_signature;
exception when others then
  -- Missing Vault access, a rotated secret, or any malformed crypto dependency
  -- invalidates the proof instead of making release availability-dependent.
  return false;
end;
$$;

revoke all on function private.stage1_release_artifact_signature_valid(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function private.insert_stage1_external_release_artifact(
  p_artifact_kind text,
  p_environment text,
  p_status text,
  p_cohort_identity_version text,
  p_cohort_identity_hash text,
  p_policy_version text,
  p_app_revision text,
  p_evidence jsonb,
  p_expected_evidence_hash text,
  p_signer_key_id text,
  p_expected_signed_payload_hash text,
  p_signature text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_valid_until timestamptz,
  p_actor text
)
returns public.stage1_release_acceptance_artifacts
language plpgsql
security definer
set search_path = ''
as $$
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
    or p_cohort_identity_version <> 'stage1-national-25-v1'
    or p_cohort_identity_hash <>
      '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e'
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
$$;

revoke all on function private.insert_stage1_external_release_artifact(
  text, text, text, text, text, text, text, jsonb, text, text, text, text,
  timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;

create or replace function private.stage1_current_valid_release_artifact(
  p_artifact_kind text,
  p_evaluated_at timestamptz
)
returns setof public.stage1_release_acceptance_artifacts
language sql
stable
security definer
set search_path = ''
as $$
  with ranked_candidates as (
    select
      artifact.id,
      pg_catalog.row_number() over (
        order by artifact.completed_at desc, artifact.id desc
      ) as recency_rank
    from public.stage1_release_acceptance_artifacts artifact
    where artifact.artifact_kind = p_artifact_kind
      and artifact.environment = 'production'
      and artifact.cohort_identity_version = 'stage1-national-25-v1'
      and artifact.cohort_identity_hash =
        '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e'
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
$$;

revoke all on function private.stage1_current_valid_release_artifact(text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.record_stage1_hosted_runtime_identity_artifact(
  p_status text,
  p_app_revision text,
  p_evidence jsonb,
  p_expected_evidence_hash text,
  p_signer_key_id text,
  p_expected_signed_payload_hash text,
  p_signature text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_valid_until timestamptz,
  p_actor text
)
returns public.stage1_release_acceptance_artifacts
language plpgsql
security definer
set search_path = ''
as $$
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
    'stage1-national-25-v1',
    '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e',
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
$$;

revoke all on function public.record_stage1_hosted_runtime_identity_artifact(
  text, text, jsonb, text, text, text, text,
  timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_stage1_hosted_runtime_identity_artifact(
  text, text, jsonb, text, text, text, text,
  timestamptz, timestamptz, timestamptz, text
) to service_role;

create or replace function public.record_stage1_rollback_drill_artifact(
  p_status text,
  p_app_revision text,
  p_evidence jsonb,
  p_expected_evidence_hash text,
  p_signer_key_id text,
  p_expected_signed_payload_hash text,
  p_signature text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_valid_until timestamptz,
  p_actor text
)
returns public.stage1_release_acceptance_artifacts
language plpgsql
security definer
set search_path = ''
as $$
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
    'stage1-national-25-v1',
    '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e',
    'stage1-publication-v1', p_app_revision, p_evidence,
    p_expected_evidence_hash, p_signer_key_id,
    p_expected_signed_payload_hash, p_signature,
    p_started_at, p_completed_at, p_valid_until, p_actor
  );
end;
$$;

revoke all on function public.record_stage1_rollback_drill_artifact(
  text, text, jsonb, text, text, text, text,
  timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_stage1_rollback_drill_artifact(
  text, text, jsonb, text, text, text, text,
  timestamptz, timestamptz, timestamptz, text
) to service_role;

create or replace function public.record_stage1_non_cohort_leak_crawl_artifact(
  p_status text,
  p_app_revision text,
  p_evidence jsonb,
  p_expected_evidence_hash text,
  p_signer_key_id text,
  p_expected_signed_payload_hash text,
  p_signature text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_valid_until timestamptz,
  p_actor text
)
returns public.stage1_release_acceptance_artifacts
language plpgsql
security definer
set search_path = ''
as $$
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
    'stage1-national-25-v1',
    '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e',
    'stage1-publication-v1', p_app_revision, p_evidence,
    p_expected_evidence_hash, p_signer_key_id,
    p_expected_signed_payload_hash, p_signature,
    p_started_at, p_completed_at, p_valid_until, p_actor
  );
end;
$$;

revoke all on function public.record_stage1_non_cohort_leak_crawl_artifact(
  text, text, jsonb, text, text, text, text,
  timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_stage1_non_cohort_leak_crawl_artifact(
  text, text, jsonb, text, text, text, text,
  timestamptz, timestamptz, timestamptz, text
) to service_role;

create or replace function public.record_stage1_r2_recovery_drill_artifact(
  p_status text,
  p_app_revision text,
  p_evidence jsonb,
  p_expected_evidence_hash text,
  p_signer_key_id text,
  p_expected_signed_payload_hash text,
  p_signature text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_valid_until timestamptz,
  p_actor text
)
returns public.stage1_release_acceptance_artifacts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_runtime public.stage1_release_acceptance_artifacts%rowtype;
  v_objects jsonb;
begin
  if p_status = 'passed' then
    select * into v_runtime
    from private.stage1_current_valid_release_artifact(
      'hosted_runtime_identity', pg_catalog.clock_timestamp()
    ) limit 1;
    v_objects := private.stage1_visual_r2_object_set_snapshot();
    if v_runtime.id is null
      or v_runtime.app_revision <> pg_catalog.btrim(p_app_revision)
      or v_objects ->> 'unexpected_bucket_count' <> '0'
      or v_objects ->> 'malformed_object_count' <> '0'
      or p_evidence ->> 'visual_object_set_hash' is distinct from
        v_objects ->> 'visual_object_set_hash'
      or (p_evidence ->> 'visual_objects_checked')::bigint is distinct from
        (v_objects ->> 'visual_object_count')::bigint then
      raise exception using errcode = '23514',
        message = 'R2 proof did not verify the current immutable Stage 1 visual object set.';
    end if;
  end if;
  return private.insert_stage1_external_release_artifact(
    'r2_recovery_drill', 'production', p_status,
    'stage1-national-25-v1',
    '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e',
    'stage1-publication-v1', p_app_revision, p_evidence,
    p_expected_evidence_hash, p_signer_key_id,
    p_expected_signed_payload_hash, p_signature,
    p_started_at, p_completed_at, p_valid_until, p_actor
  );
end;
$$;

revoke all on function public.record_stage1_r2_recovery_drill_artifact(
  text, text, jsonb, text, text, text, text,
  timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_stage1_r2_recovery_drill_artifact(
  text, text, jsonb, text, text, text, text,
  timestamptz, timestamptz, timestamptz, text
) to service_role;

-- Unlike the four external proofs, visual coverage has no caller-supplied
-- result.  Postgres derives the event set and exact-crop counts and binds them
-- to the latest signed R2 verification of the same object-set hash.
create or replace function public.record_stage1_visual_crop_coverage_artifact(
  p_actor text
)
returns public.stage1_release_acceptance_artifacts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_target jsonb := private.stage1_release_production_target_snapshot();
  v_runtime public.stage1_release_acceptance_artifacts%rowtype;
  v_r2 public.stage1_release_acceptance_artifacts%rowtype;
  v_coverage jsonb;
  v_evidence jsonb;
  v_status text;
  v_artifact public.stage1_release_acceptance_artifacts%rowtype;
begin
  if nullif(pg_catalog.btrim(p_actor), '') is null then
    raise exception using errcode = '22023', message = 'A crop-coverage actor is required.';
  end if;
  if v_target ->> 'configured' <> 'true' then
    raise exception using errcode = '55000',
      message = 'The administrator-owned production target is not configured.';
  end if;
  select * into v_runtime
  from private.stage1_current_valid_release_artifact(
    'hosted_runtime_identity', v_now
  ) limit 1;
  if v_runtime.id is null or v_runtime.completed_at < v_now - interval '1 hour' then
    raise exception using errcode = '23514',
      message = 'Current signed hosted runtime identity is required before deriving crop coverage.';
  end if;

  select * into v_r2
  from private.stage1_current_valid_release_artifact('r2_recovery_drill', v_now) artifact
  where artifact.app_revision = v_runtime.app_revision
  limit 1;
  v_coverage := private.stage1_visual_crop_coverage_snapshot();
  if v_r2.id is not null and (
    v_r2.evidence ->> 'visual_object_set_hash' is distinct from
      v_coverage ->> 'visual_object_set_hash'
    or (v_r2.evidence ->> 'visual_objects_checked')::bigint is distinct from
      (v_coverage ->> 'visual_object_count')::bigint
  ) then
    v_r2.id := null;
  end if;
  v_evidence := v_coverage || pg_catalog.jsonb_build_object(
    'producer_contract', 'awardping.stage1.database-derived-release-evidence.v2',
    'derivation_contract_hash', private.stage1_visual_crop_derivation_contract_hash(),
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
    'stage1-national-25-v1',
    '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e',
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
$$;

revoke all on function public.record_stage1_visual_crop_coverage_artifact(text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_stage1_visual_crop_coverage_artifact(text)
  to service_role;

-- Helpers for translating the permanent Node/Next nightly-run contract into a
-- conservative database check.  Any malformed option is treated as set/unsafe.
create or replace function private.stage1_json_flag_enabled(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case pg_catalog.jsonb_typeof(p_value)
    when 'boolean' then p_value = 'true'::jsonb
    when 'number' then coalesce((p_value #>> '{}')::numeric, 0) <> 0
    when 'string' then pg_catalog.lower(pg_catalog.btrim(p_value #>> '{}'))
      in ('1', 'true', 'yes', 'on')
    else false
  end;
$$;

create or replace function private.stage1_json_option_set(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case pg_catalog.jsonb_typeof(p_value)
    when 'null' then false
    when 'boolean' then p_value = 'true'::jsonb
    when 'number' then coalesce((p_value #>> '{}')::numeric, 0) > 0
    when 'string' then nullif(pg_catalog.btrim(p_value #>> '{}'), '') is not null
    when 'array' then pg_catalog.jsonb_array_length(p_value) > 0
    when 'object' then p_value <> '{}'::jsonb
    else false
  end;
$$;

revoke all on function private.stage1_json_flag_enabled(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.stage1_json_option_set(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.stage1_normal_6pm_monitoring_date(
  p_run public.local_worker_runs
)
returns date
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_identity jsonb := coalesce(p_run.metadata -> 'run_identity', '{}'::jsonb);
  v_options jsonb := coalesce(p_run.metadata -> 'options', '{}'::jsonb);
  v_monitoring_date date;
  v_local_started timestamp;
  v_computed_date date;
  v_shard_index integer;
  v_expected_worker text;
begin
  if p_run.metadata ->> 'kind' <> 'visual_snapshot'
    or v_identity ->> 'workflow' <> 'visual_capture'
    or v_identity ->> 'timezone' <> 'America/Chicago'
    or pg_catalog.lower(pg_catalog.btrim(v_identity ->> 'trigger')) <> 'scheduled'
    or v_identity ->> 'monitoring_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or v_identity ->> 'shard_count' <> '3'
    or v_identity ->> 'shard_index' !~ '^[0-2]$' then
    return null;
  end if;
  begin
    v_monitoring_date := (v_identity ->> 'monitoring_date')::date;
    v_shard_index := (v_identity ->> 'shard_index')::integer;
  exception when others then return null;
  end;
  v_expected_worker := pg_catalog.format(
    'local-visual-snapshot-worker-shard-%s-of-3', v_shard_index + 1
  );
  if p_run.worker_name <> v_expected_worker
    or v_identity ->> 'cohort_id' <> 'visual-nightly:' || v_monitoring_date::text
    or v_options ->> 'run_cohort_id' <> 'visual-nightly:' || v_monitoring_date::text
    or not private.stage1_json_flag_enabled(v_options -> 'include_not_due')
    or not private.stage1_json_flag_enabled(v_options -> 'discovery_mode')
    or pg_catalog.lower(pg_catalog.btrim(v_options ->> 'discovery_intent')) <> 'live_recurring'
    or coalesce((v_options ->> 'limit')::numeric, 0) < 50000
    or private.stage1_json_flag_enabled(v_options -> 'baseline_refresh')
    or private.stage1_json_flag_enabled(v_options -> 'complete_missing_baselines')
    or private.stage1_json_flag_enabled(v_options -> 'ai_review_evidence_capture')
    or private.stage1_json_flag_enabled(v_options -> 'localization_repair')
    or private.stage1_json_flag_enabled(v_options -> 'r2_backfill_baselines')
    or private.stage1_json_flag_enabled(v_options -> 'reset_previous_snapshot')
    or private.stage1_json_flag_enabled(v_options -> 'force_r2_snapshot_refresh')
    or private.stage1_json_flag_enabled(v_options -> 'pdf_only')
    or private.stage1_json_flag_enabled(v_options -> 'web_only')
    or private.stage1_json_flag_enabled(v_options -> 'skip_existing_baseline')
    or private.stage1_json_option_set(v_options -> 'source_id')
    or private.stage1_json_option_set(v_options -> 'source_url')
    or private.stage1_json_option_set(v_options -> 'award')
    or private.stage1_json_option_set(v_options -> 'source_ids_filter_count')
    or private.stage1_json_option_set(v_options -> 'initial_official_document_materialization')
    or private.stage1_json_option_set(v_options -> 'initial_official_document_acquisition_id')
    or private.stage1_json_option_set(v_options -> 'discovery_onboarding_batch_id')
    or pg_catalog.lower(pg_catalog.btrim(coalesce(v_options ->> 'discovery_intent', '')))
      = 'historical_onboarding' then
    return null;
  end if;
  v_local_started := p_run.started_at at time zone 'America/Chicago';
  v_computed_date := case
    when v_local_started::time < time '18:00' then v_local_started::date - 1
    else v_local_started::date
  end;
  if v_computed_date <> v_monitoring_date then return null; end if;
  return v_monitoring_date;
exception when others then
  return null;
end;
$$;

revoke all on function private.stage1_normal_6pm_monitoring_date(public.local_worker_runs)
  from public, anon, authenticated, service_role;

create or replace function private.stage1_6pm_inventory_proof_valid(
  p_metadata jsonb,
  p_expected_shard_index integer
)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_proof jsonb := coalesce(p_metadata -> 'source_inventory', '{}'::jsonb);
  v_partitions jsonb;
  v_partition jsonb;
  v_global_count bigint;
  v_expected_count bigint;
  v_loaded_count bigint;
  v_partition_sum bigint;
begin
  if p_expected_shard_index not between 0 and 2
    or v_proof ->> 'schema_version' <> '1'
    or pg_catalog.lower(v_proof ->> 'algorithm') <> 'sha256'
    or v_proof ->> 'eligibility_contract' <>
      'active_award_open_source_monitoring_policy_v1'
    or v_proof ->> 'shard_count' <> '3'
    or v_proof ->> 'shard_index' <> p_expected_shard_index::text
    or v_proof ->> 'global_source_count' !~ '^[1-9][0-9]*$'
    or v_proof ->> 'global_source_ids_sha256' !~ '^[0-9a-f]{64}$'
    or v_proof ->> 'expected_shard_source_count' !~ '^[1-9][0-9]*$'
    or v_proof ->> 'expected_shard_source_ids_sha256' !~ '^[0-9a-f]{64}$'
    or v_proof ->> 'loaded_shard_source_count' !~ '^[1-9][0-9]*$'
    or v_proof ->> 'loaded_shard_source_ids_sha256' !~ '^[0-9a-f]{64}$'
    or v_proof ->> 'partition_source_count_sum' !~ '^[1-9][0-9]*$'
    or v_proof ->> 'shard_exact_match' <> 'true'
    or v_proof ->> 'proof_complete' <> 'true'
    or pg_catalog.jsonb_typeof(v_proof -> 'partitions') <> 'array'
    or pg_catalog.jsonb_array_length(v_proof -> 'partitions') <> 3 then
    return false;
  end if;
  v_global_count := (v_proof ->> 'global_source_count')::bigint;
  v_expected_count := (v_proof ->> 'expected_shard_source_count')::bigint;
  v_loaded_count := (v_proof ->> 'loaded_shard_source_count')::bigint;
  v_partition_sum := (v_proof ->> 'partition_source_count_sum')::bigint;
  v_partitions := v_proof -> 'partitions';
  if v_global_count <> v_partition_sum or v_expected_count <> v_loaded_count
    or v_proof ->> 'expected_shard_source_ids_sha256' <>
      v_proof ->> 'loaded_shard_source_ids_sha256' then
    return false;
  end if;
  select partition.value into v_partition
  from pg_catalog.jsonb_array_elements(v_partitions) partition(value)
  where partition.value ->> 'shard_index' = p_expected_shard_index::text;
  if v_partition is null
    or v_partition ->> 'source_count' <> v_expected_count::text
    or v_partition ->> 'source_ids_sha256' <>
      v_proof ->> 'expected_shard_source_ids_sha256' then
    return false;
  end if;
  if (
    select count(*) = 3
      and count(distinct (partition.value ->> 'shard_index')) = 3
      and count(*) filter (
        where partition.value ->> 'shard_index' ~ '^[0-2]$'
          and partition.value ->> 'source_count' ~ '^[0-9]+$'
          and partition.value ->> 'source_ids_sha256' ~ '^[0-9a-f]{64}$'
      ) = 3
      and sum((partition.value ->> 'source_count')::bigint) = v_global_count
    from pg_catalog.jsonb_array_elements(v_partitions) partition(value)
  ) is not true then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function private.stage1_6pm_inventory_proof_valid(jsonb, integer)
  from public, anon, authenticated, service_role;

create or replace function private.stage1_6pm_shard_healthy(
  p_run public.local_worker_runs
)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_metadata jsonb := coalesce(p_run.metadata, '{}'::jsonb);
  v_identity jsonb := coalesce(v_metadata -> 'run_identity', '{}'::jsonb);
  v_health jsonb := coalesce(v_metadata -> 'run_health', '{}'::jsonb);
  v_shard_index integer;
begin
  if v_identity ->> 'shard_index' !~ '^[0-2]$' then return false; end if;
  v_shard_index := (v_identity ->> 'shard_index')::integer;
  return p_run.status = 'succeeded'
    and p_run.finished_at is not null
    and p_run.finished_at >= p_run.started_at
    and p_run.checked_count > 0
    and p_run.failed_count = 0
    and nullif(pg_catalog.btrim(coalesce(p_run.error, '')), '') is null
    and v_health ->> 'schema_version' = '2'
    and v_health ->> 'status' = 'healthy'
    and v_health ->> 'inventory_complete' = 'true'
    and v_health ->> 'inventory_proof_required' = 'true'
    and v_health ->> 'inventory_proof_complete' = 'true'
    and v_health ->> 'source_failures' = '0'
    and v_health ->> 'incident_count' = '0'
    and v_health ->> 'requires_attention' = 'false'
    and v_health ->> 'loaded_sources' ~ '^[1-9][0-9]*$'
    and v_health ->> 'processed_sources' = v_health ->> 'loaded_sources'
    and coalesce(pg_catalog.jsonb_array_length(
      case when pg_catalog.jsonb_typeof(v_metadata -> 'failure_groups') = 'array'
        then v_metadata -> 'failure_groups' else '[]'::jsonb end
    ), 0) = 0
    and private.stage1_6pm_inventory_proof_valid(v_metadata, v_shard_index);
exception when others then
  return false;
end;
$$;

revoke all on function private.stage1_6pm_shard_healthy(public.local_worker_runs)
  from public, anon, authenticated, service_role;

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
        and pg_catalog.bool_and(private.stage1_6pm_shard_healthy(latest_runs))
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
        and lane.oldest_item_sla_seconds > 0
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
    '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e' then
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
      'identity_version', 'stage1-national-25-v1',
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

create or replace function public.record_stage1_release_acceptance(
  p_expected_gate_state_hash text,
  p_expires_at timestamptz,
  p_actor text
)
returns public.stage1_release_acceptance_records
language plpgsql
security definer
set search_path = ''
as $$
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
      '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e'
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
    'stage1-national-25-v1',
    '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e',
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
$$;

revoke all on function public.record_stage1_release_acceptance(
  text, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_stage1_release_acceptance(
  text, timestamptz, text
) to service_role;

create or replace function public.activate_stage1_release_from_acceptance(
  p_acceptance_id uuid,
  p_expected_summary_hash text,
  p_reason text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_acceptance public.stage1_release_acceptance_records%rowtype;
  v_current jsonb;
  v_kind text;
  v_link public.stage1_release_acceptance_artifact_links%rowtype;
  v_artifact public.stage1_release_acceptance_artifacts%rowtype;
  v_current_binding jsonb;
  v_release jsonb;
begin
  if nullif(pg_catalog.btrim(p_reason), '') is null
    or nullif(pg_catalog.btrim(p_actor), '') is null then
    raise exception using errcode = '22023',
      message = 'Release activation requires a reason and actor.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  select * into v_acceptance
  from public.stage1_release_acceptance_records acceptance
  where acceptance.id = p_acceptance_id
  for update;
  if not found
    or v_acceptance.status <> 'ready'
    or v_acceptance.expires_at <= v_now
    or v_acceptance.summary_hash is distinct from p_expected_summary_hash then
    raise exception using errcode = '40001',
      message = 'Release acceptance is missing, stale, consumed, or hash-mismatched.';
  end if;

  -- Recompute every gate from current rows.  The caller cannot preserve a
  -- previous READY decision by replaying the acceptance summary.
  v_current := private.stage1_release_gate_snapshot(v_now);
  if v_current ->> 'state' <> 'READY'
    or v_current ->> 'state_hash' is distinct from v_acceptance.gate_state_hash
    or v_acceptance.summary ->> 'state_hash' is distinct from
      v_acceptance.gate_state_hash then
    raise exception using errcode = '40001',
      message = 'A database-owned release gate changed or failed after acceptance.';
  end if;

  foreach v_kind in array array[
    'hosted_runtime_identity',
    'rollback_drill',
    'non_cohort_leak_crawl',
    'r2_recovery_drill',
    'visual_crop_coverage'
  ] loop
    select * into v_link
    from public.stage1_release_acceptance_artifact_links link
    where link.acceptance_id = v_acceptance.id
      and link.artifact_kind = v_kind;
    if not found then
      raise exception using errcode = '23514',
        message = pg_catalog.format('Acceptance artifact link %s is missing.', v_kind);
    end if;
    select * into v_artifact
    from public.stage1_release_acceptance_artifacts artifact
    where artifact.id = v_link.artifact_id
    for key share;
    v_current_binding := v_current -> 'artifacts' -> v_kind;
    if not found
      or v_artifact.artifact_kind <> v_kind
      or v_artifact.evidence_hash <> v_link.evidence_hash
      or v_artifact.valid_until <= v_now
      or not private.stage1_release_artifact_evidence_valid(v_kind, v_artifact.evidence)
      or not private.stage1_release_artifact_signature_valid(v_artifact.id, v_now)
      or v_current_binding ->> 'id' <> v_artifact.id::text
      or v_current_binding ->> 'evidence_hash' <> v_artifact.evidence_hash then
      raise exception using errcode = '23514',
        message = pg_catalog.format(
          'Acceptance artifact %s is stale, invalid, or no longer current.', v_kind
        );
    end if;
  end loop;

  v_release := public.transition_stage1_cohort_release(
    'verified_beta',
    p_reason,
    'stage1-publication-v1',
    p_actor
  );
  update public.stage1_release_acceptance_records
  set
    status = 'consumed',
    consumed_at = v_now,
    release_epoch = (v_release ->> 'release_epoch')::uuid
  where id = v_acceptance.id;
  return v_release || pg_catalog.jsonb_build_object(
    'acceptance_id', v_acceptance.id,
    'acceptance_summary_hash', v_acceptance.summary_hash,
    'gate_state_hash', v_acceptance.gate_state_hash
  );
end;
$$;

revoke all on function public.activate_stage1_release_from_acceptance(
  uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.activate_stage1_release_from_acceptance(
  uuid, text, text, text
) to service_role;

create or replace function public.suspend_stage1_release(
  p_reason text,
  p_actor text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.transition_stage1_cohort_release(
    'suspended', p_reason, 'stage1-publication-v1', p_actor
  );
$$;

revoke all on function public.suspend_stage1_release(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.suspend_stage1_release(text, text)
  to service_role;

-- Promotion can verify awards but cannot activate public visibility.  The
-- short-lived DB-derived acceptance above is the only service-role upgrade.
revoke execute on function public.transition_stage1_cohort_release(
  text, text, text, text
) from service_role;

comment on table public.stage1_release_acceptance_artifacts is
  'Immutable release proofs: four Vault-HMAC signed external observations and one database-derived exact-crop coverage artifact.';
comment on table public.stage1_release_acceptance_records is
  'Short-lived DB-generated release decisions. The summary is never accepted from a caller and is re-derived at activation.';
