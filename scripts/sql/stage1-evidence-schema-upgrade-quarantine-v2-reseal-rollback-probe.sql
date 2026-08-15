-- This file is a template. Execute it only through
--   node scripts/run-stage1-evidence-schema-upgrade-quarantine-v2-reseal-rollback-probe.mjs
-- It requires all earlier repository migrations, applies exactly the v2
-- quarantine reseal plus its read-only smoke, and proves full rollback.

begin;

create temporary table awardping_stage1_quarantine_v2_reseal_probe_baseline (
  required_prior_versions text[] not null,
  function_contract jsonb not null,
  function_metadata_contract jsonb not null,
  constraint_definition text not null,
  application_contract jsonb not null
) on commit preserve rows;

create function pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
  p_condition boolean,
  p_message text
)
returns void
language plpgsql
as $$
begin
  if coalesce(p_condition, false) is not true then
    raise exception using
      errcode = 'P0001',
      message =
        'Stage 1 quarantine v2 reseal rollback probe failed: ' || p_message;
  end if;
end;
$$;

create function pg_temp.awardping_stage1_quarantine_v2_function_contract(
  p_include_definition boolean
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'oid', target.oid::text,
      'definition', case
        when p_include_definition
          then pg_catalog.pg_get_functiondef(target.oid)
        else null
      end,
      'identity_arguments',
        pg_catalog.pg_get_function_identity_arguments(target.oid),
      'result', pg_catalog.pg_get_function_result(target.oid),
      'owner_oid', target.proowner::text,
      'acl', pg_catalog.to_jsonb(target.proacl),
      'config', pg_catalog.to_jsonb(target.proconfig),
      'volatility', target.provolatile::text,
      'security_definer', target.prosecdef,
      'strict', target.proisstrict,
      'leakproof', target.proleakproof,
      'parallel', target.proparallel::text,
      'kind', target.prokind::text,
      'language_oid', target.prolang::text,
      'return_type_oid', target.prorettype::text,
      'argument_type_oids', target.proargtypes::text,
      'all_argument_type_oids', pg_catalog.to_jsonb(target.proallargtypes),
      'argument_modes', pg_catalog.to_jsonb(target.proargmodes),
      'argument_names', pg_catalog.to_jsonb(target.proargnames),
      'comment', pg_catalog.obj_description(target.oid, 'pg_proc')
    )
  )
  from pg_catalog.pg_proc target
  where target.oid = pg_catalog.to_regprocedure(
    'public.quarantine_stage1_evidence_schema_upgrade_failure(uuid,uuid,uuid,text,jsonb)'
  );
$$;

create function pg_temp.awardping_stage1_quarantine_v2_application_contract()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'failure_count', (
      select pg_catalog.count(*)
      from private.stage1_evidence_schema_upgrade_failures
    ),
    'failure_identity', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          failure.failure_sha256,
          failure.submitted_evidence_sha256,
          failure.manifest_sha256,
          failure.policy_sha256,
          failure.recorded_at
        ) order by failure.failure_sha256
      )
      from private.stage1_evidence_schema_upgrade_failures failure
    ), '[]'::jsonb),
    'quarantine_count', (
      select pg_catalog.count(*)
      from public.manual_quarantine_registry quarantine
      where quarantine.quarantine_key like
        'stage1:evidence-schema-upgrade:%'
    ),
    'quarantine_identity', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          quarantine.quarantine_key,
          quarantine.evidence_hash,
          quarantine.policy_id,
          quarantine.policy_version,
          quarantine.policy_hash,
          quarantine.last_observed_at
        ) order by quarantine.quarantine_key
      )
      from public.manual_quarantine_registry quarantine
      where quarantine.quarantine_key like
        'stage1:evidence-schema-upgrade:%'
    ), '[]'::jsonb)
  );
$$;

do $preflight$
declare
  v_required_prior_versions text[] :=
-- __AWARDPING_EXACT_PRIOR_MIGRATION_VERSIONS__
  ;
  v_missing_prior_versions text[];
  v_target_version constant text := '20260815012910';
  v_function_contract jsonb;
  v_function_metadata_contract jsonb;
  v_constraint_definition text;
begin
  select pg_catalog.array_agg(required.version order by required.version)
  into v_missing_prior_versions
  from pg_catalog.unnest(v_required_prior_versions) required(version)
  where not exists (
    select 1
    from supabase_migrations.schema_migrations migration
    where migration.version = required.version
  );

  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    coalesce(pg_catalog.cardinality(v_missing_prior_versions), 0) = 0,
    'one or more prior repository migrations are not recorded as applied'
  );
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = v_target_version
    ),
    'migration 20260815012910 is already recorded as applied'
  );
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    pg_catalog.to_regprocedure(
      'public.quarantine_stage1_evidence_schema_upgrade_failure(uuid,uuid,uuid,text,jsonb)'
    ) is not null,
    'the exact Stage 1 quarantine RPC is missing'
  );
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    (
      select pg_catalog.count(*)
      from pg_catalog.pg_proc target
      join pg_catalog.pg_namespace namespace
        on namespace.oid = target.pronamespace
      where namespace.nspname = 'public'
        and target.proname =
          'quarantine_stage1_evidence_schema_upgrade_failure'
    ) = 1,
    'the Stage 1 quarantine RPC has an unexpected overload'
  );

  v_function_contract :=
    pg_temp.awardping_stage1_quarantine_v2_function_contract(true);
  v_function_metadata_contract :=
    pg_temp.awardping_stage1_quarantine_v2_function_contract(false);
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    v_function_contract is not null
      and v_function_metadata_contract is not null,
    'the exact function catalog baseline was not captured'
  );

  select pg_catalog.pg_get_constraintdef(target.oid, true)
  into strict v_constraint_definition
  from pg_catalog.pg_constraint target
  where target.conrelid =
      'private.stage1_evidence_schema_upgrade_failures'::regclass
    and target.conname =
      'stage1_evidence_schema_upgrade_failure_hash_check'
    and target.contype = 'c'
    and target.convalidated
    and not target.connoinherit;

  insert into pg_temp.awardping_stage1_quarantine_v2_reseal_probe_baseline (
    required_prior_versions,
    function_contract,
    function_metadata_contract,
    constraint_definition,
    application_contract
  ) values (
    v_required_prior_versions,
    v_function_contract,
    v_function_metadata_contract,
    v_constraint_definition,
    pg_temp.awardping_stage1_quarantine_v2_application_contract()
  );
end;
$preflight$;

commit;

-- MIGRATION TRANSACTION START
begin;

-- __AWARDPING_EXACT_MIGRATION__

-- __AWARDPING_EXACT_SMOKE__

do $applied_contract$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(
      'public.quarantine_stage1_evidence_schema_upgrade_failure(uuid,uuid,uuid,text,jsonb)'
    )
  );
  v_constraint_definition text;
begin
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    pg_temp.awardping_stage1_quarantine_v2_function_contract(false) = (
      select baseline.function_metadata_contract
      from pg_temp.awardping_stage1_quarantine_v2_reseal_probe_baseline baseline
    ),
    'the migration changed a function catalog attribute or OID outside the body reseal'
  );
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    pg_temp.awardping_stage1_quarantine_v2_function_contract(true) <>
      (
        select baseline.function_contract
        from pg_temp.awardping_stage1_quarantine_v2_reseal_probe_baseline baseline
      ),
    'the exact quarantine RPC definition did not change inside the migration transaction'
  );
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(v_definition, 'UTF8'), 'sha256'),
      'hex'
    ) = 'b0859cb4807b2a914800105154bf508be308fb1aa6943a10fb1b42b3b340083f',
    'the applied quarantine RPC definition does not have the reviewed v2 digest'
  );

  select pg_catalog.pg_get_constraintdef(target.oid, true)
  into strict v_constraint_definition
  from pg_catalog.pg_constraint target
  where target.conrelid =
      'private.stage1_evidence_schema_upgrade_failures'::regclass
    and target.conname =
      'stage1_evidence_schema_upgrade_failure_hash_check'
    and target.contype = 'c'
    and target.convalidated
    and not target.connoinherit;

  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    pg_catalog.strpos(
      v_constraint_definition,
      'f2a16adec57b3a66c3e467599bbf962cf02c94d1f6ded1daf5db09bf980c0184'
    ) > 0
      and pg_catalog.strpos(
        v_constraint_definition,
        '1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c'
      ) > 0
      and pg_catalog.strpos(
        v_constraint_definition,
        '42241673b1acf00b22f5e47f7a5fa1368ad0237ba9c4795a05541941ec2209c4'
      ) > 0
      and pg_catalog.strpos(
        v_constraint_definition,
        '917076584e316b4412d998ad820111046c1caf89f492012ed5061513ed7eef37'
      ) > 0,
    'the applied audit constraint does not preserve both paired v1/v2 seals'
  );
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    pg_temp.awardping_stage1_quarantine_v2_application_contract() = (
      select baseline.application_contract
      from pg_temp.awardping_stage1_quarantine_v2_reseal_probe_baseline baseline
    ),
    'the migration or read-only smoke changed application or audit rows'
  );
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260815012910'
    ),
    'direct rollback-probe execution unexpectedly changed migration history'
  );
end;
$applied_contract$;

rollback;
-- MIGRATION TRANSACTION END

-- POST-ROLLBACK VERIFICATION START
begin;

do $post_rollback$
declare
  v_required_prior_versions text[] := (
    select baseline.required_prior_versions
    from pg_temp.awardping_stage1_quarantine_v2_reseal_probe_baseline baseline
  );
  v_constraint_definition text;
begin
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    pg_temp.awardping_stage1_quarantine_v2_function_contract(true) = (
      select baseline.function_contract
      from pg_temp.awardping_stage1_quarantine_v2_reseal_probe_baseline baseline
    ),
    'the original quarantine RPC definition or catalog attributes were not restored'
  );

  select pg_catalog.pg_get_constraintdef(target.oid, true)
  into strict v_constraint_definition
  from pg_catalog.pg_constraint target
  where target.conrelid =
      'private.stage1_evidence_schema_upgrade_failures'::regclass
    and target.conname =
      'stage1_evidence_schema_upgrade_failure_hash_check';
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    v_constraint_definition = (
      select baseline.constraint_definition
      from pg_temp.awardping_stage1_quarantine_v2_reseal_probe_baseline baseline
    ),
    'the original v1 audit constraint definition was not restored'
  );
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    pg_temp.awardping_stage1_quarantine_v2_application_contract() = (
      select baseline.application_contract
      from pg_temp.awardping_stage1_quarantine_v2_reseal_probe_baseline baseline
    ),
    'application or audit rows changed despite rollback'
  );
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    not exists (
      select 1
      from pg_catalog.unnest(v_required_prior_versions) required(version)
      where not exists (
        select 1
        from supabase_migrations.schema_migrations migration
        where migration.version = required.version
      )
    ),
    'a prior migration-history row disappeared during the probe'
  );
  perform pg_temp.awardping_stage1_quarantine_v2_reseal_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260815012910'
    ),
    'migration history changed despite rollback'
  );
end;
$post_rollback$;

select
  'awardping_stage1_pending_migration_rollback_probe_passed' as status,
  'awardping_stage1_quarantine_v2_reseal_rollback_probe_passed' as probe,
  1 as exact_migration_count,
  1 as exact_smoke_count,
  true as function_definition_restored,
  true as function_metadata_restored,
  true as v1_constraint_restored,
  true as application_rows_unchanged,
  true as migration_history_unchanged;

rollback;
-- POST-ROLLBACK VERIFICATION END
