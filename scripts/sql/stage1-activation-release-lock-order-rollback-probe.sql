-- This file is a template. Execute it only through
--   node scripts/run-stage1-activation-release-lock-order-rollback-probe.mjs
-- It requires all earlier migrations, applies exactly one target migration and
-- its catalog/role smoke, then verifies complete restoration of both original
-- RPC definitions and their catalog attributes after rollback.

begin;

create temporary table awardping_stage1_activation_lock_probe_baseline (
  required_prior_versions text[] not null,
  function_contract jsonb not null,
  function_metadata_contract jsonb not null
) on commit preserve rows;

create function pg_temp.awardping_stage1_activation_lock_probe_assert(
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
        'Stage 1 activation release-lock rollback probe failed: ' ||
        p_message;
  end if;
end;
$$;

create function pg_temp.awardping_stage1_activation_lock_function_contract(
  p_include_definition boolean
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'schema', namespace.nspname,
          'name', target.proname,
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
      order by target.proname, target.oid
    ),
    '[]'::jsonb
  )
  from pg_catalog.pg_proc target
  join pg_catalog.pg_namespace namespace
    on namespace.oid = target.pronamespace
  where namespace.nspname = 'public'
    and target.proname in (
      'finalize_stage1_source_baseline_activation',
      'fail_stage1_source_baseline_activation'
    );
$$;

do $preflight$
declare
  v_required_prior_versions text[] :=
-- __AWARDPING_EXACT_PRIOR_MIGRATION_VERSIONS__
  ;
  v_missing_prior_versions text[];
  v_target_version constant text := '20260814223000';
  v_function_contract jsonb;
  v_function_metadata_contract jsonb;
begin
  select pg_catalog.array_agg(required.version order by required.version)
  into v_missing_prior_versions
  from pg_catalog.unnest(v_required_prior_versions) required(version)
  where not exists (
    select 1
    from supabase_migrations.schema_migrations migration
    where migration.version = required.version
  );

  perform pg_temp.awardping_stage1_activation_lock_probe_assert(
    coalesce(pg_catalog.cardinality(v_missing_prior_versions), 0) = 0,
    'one or more prior repository migrations are not recorded as applied'
  );
  perform pg_temp.awardping_stage1_activation_lock_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = v_target_version
    ),
    'migration 20260814223000 is already recorded as applied'
  );
  perform pg_temp.awardping_stage1_activation_lock_probe_assert(
    pg_catalog.to_regprocedure(
      'public.finalize_stage1_source_baseline_activation(uuid,uuid,text,text,text,jsonb)'
    ) is not null
      and pg_catalog.to_regprocedure(
        'public.fail_stage1_source_baseline_activation(uuid,uuid,uuid,text,jsonb)'
      ) is not null,
    'an exact Stage 1 activation mutation RPC is missing'
  );
  perform pg_temp.awardping_stage1_activation_lock_probe_assert(
    (
      select pg_catalog.count(*)
      from pg_catalog.pg_proc target
      join pg_catalog.pg_namespace namespace
        on namespace.oid = target.pronamespace
      where namespace.nspname = 'public'
        and target.proname in (
          'finalize_stage1_source_baseline_activation',
          'fail_stage1_source_baseline_activation'
        )
    ) = 2,
    'a Stage 1 activation mutation RPC has an unexpected overload'
  );
  perform pg_temp.awardping_stage1_activation_lock_probe_assert(
    not exists (
      select 1
      from pg_catalog.pg_proc target
      where target.oid in (
        pg_catalog.to_regprocedure(
          'public.finalize_stage1_source_baseline_activation(uuid,uuid,text,text,text,jsonb)'
        ),
        pg_catalog.to_regprocedure(
          'public.fail_stage1_source_baseline_activation(uuid,uuid,uuid,text,jsonb)'
        )
      )
        and pg_catalog.strpos(
          pg_catalog.pg_get_functiondef(target.oid),
          'stage1-national-25-release'
        ) > 0
    ),
    'a target RPC already contains the pending release-lock delta'
  );

  v_function_contract :=
    pg_temp.awardping_stage1_activation_lock_function_contract(true);
  v_function_metadata_contract :=
    pg_temp.awardping_stage1_activation_lock_function_contract(false);
  perform pg_temp.awardping_stage1_activation_lock_probe_assert(
    pg_catalog.jsonb_array_length(v_function_contract) = 2,
    'the exact two-function baseline catalog contract was not captured'
  );

  insert into pg_temp.awardping_stage1_activation_lock_probe_baseline (
    required_prior_versions,
    function_contract,
    function_metadata_contract
  ) values (
    v_required_prior_versions,
    v_function_contract,
    v_function_metadata_contract
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
  v_target record;
  v_definition text;
  v_global_key constant text :=
    'pg_catalog.hashtextextended(''stage1-national-25-release'', 0)';
begin
  perform pg_temp.awardping_stage1_activation_lock_probe_assert(
    pg_temp.awardping_stage1_activation_lock_function_contract(false) = (
      select baseline.function_metadata_contract
      from pg_temp.awardping_stage1_activation_lock_probe_baseline baseline
    ),
    'the migration changed a function catalog attribute or OID outside the body delta'
  );
  perform pg_temp.awardping_stage1_activation_lock_probe_assert(
    pg_temp.awardping_stage1_activation_lock_function_contract(true) <>
      (
        select baseline.function_contract
        from pg_temp.awardping_stage1_activation_lock_probe_baseline baseline
      ),
    'the exact function definitions did not change inside the migration transaction'
  );

  for v_target in
    select *
    from (values
      (
        'public.finalize_stage1_source_baseline_activation(uuid,uuid,text,text,text,jsonb)'::text,
        '''stage1-baseline-activation:'' || p_acquisition_id::text'::text
      ),
      (
        'public.fail_stage1_source_baseline_activation(uuid,uuid,uuid,text,jsonb)'::text,
        '''stage1-baseline-activation:'' || p_acquisition_id::text'::text
      )
    ) target(signature, per_acquisition_key)
  loop
    v_definition := pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(v_target.signature)
    );
    perform pg_temp.awardping_stage1_activation_lock_probe_assert(
      (
          pg_catalog.length(v_definition) - pg_catalog.length(
            pg_catalog.replace(v_definition, v_global_key, '')
          )
        ) / pg_catalog.length(v_global_key) = 1
        and pg_catalog.strpos(
          v_definition,
          E'begin\n  perform pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended(''stage1-national-25-release'', 0)\n  );\n\n  if p_source_id is null'
        ) > 0
        and pg_catalog.strpos(v_definition, v_global_key) <
          pg_catalog.strpos(v_definition, v_target.per_acquisition_key),
      'an applied Stage 1 activation RPC does not have exactly one global-first release lock'
    );
  end loop;

  perform pg_temp.awardping_stage1_activation_lock_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260814223000'
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
    from pg_temp.awardping_stage1_activation_lock_probe_baseline baseline
  );
begin
  perform pg_temp.awardping_stage1_activation_lock_probe_assert(
    pg_temp.awardping_stage1_activation_lock_function_contract(true) = (
      select baseline.function_contract
      from pg_temp.awardping_stage1_activation_lock_probe_baseline baseline
    ),
    'the original Stage 1 activation function definitions or catalog attributes were not restored'
  );
  perform pg_temp.awardping_stage1_activation_lock_probe_assert(
    not exists (
      select 1
      from pg_catalog.unnest(v_required_prior_versions) required(version)
      where not exists (
        select 1
        from supabase_migrations.schema_migrations migration
        where migration.version = required.version
      )
    )
      and not exists (
        select 1
        from supabase_migrations.schema_migrations migration
        where migration.version = '20260814223000'
      ),
    'migration history changed despite rollback'
  );
end;
$post_rollback$;

select
  true as awardping_stage1_pending_migration_rollback_probe_passed,
  true as awardping_stage1_activation_release_lock_rollback_probe_passed,
  1 as exact_migration_count,
  1 as exact_smoke_count,
  '20260814223000_order_stage1_activation_release_locks.sql'::text
    as exact_migration,
  'stage1_activation_release_lock_order_smoke.sql'::text as exact_smoke,
  'migration/smoke/function-catalog changes rolled back'::text
    as persistence_result;

drop table pg_temp.awardping_stage1_activation_lock_probe_baseline;
drop function
  pg_temp.awardping_stage1_activation_lock_function_contract(boolean);
drop function
  pg_temp.awardping_stage1_activation_lock_probe_assert(boolean, text);

commit;
-- POST-ROLLBACK VERIFICATION END
