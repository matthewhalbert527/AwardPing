-- This file is a template. Execute it only through
--   node scripts/run-stage1-source-activation-finalizations-getter-rollback-probe.mjs
-- The exact migration and smoke run inside one linked transaction. The probe
-- requires every earlier repository migration, refuses an already-applied or
-- drifted target, and verifies exact target-function catalog restoration.

begin;

create temporary table awardping_stage1_finalization_getter_probe_baseline (
  required_prior_versions text[] not null,
  target_function_contract jsonb not null
) on commit preserve rows;

create function pg_temp.awardping_finalization_getter_probe_assert(
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
      message = 'Stage 1 finalization getter rollback probe failed: ' || p_message;
  end if;
end;
$$;

create function pg_temp.awardping_finalization_getter_probe_contract()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'oid', target.oid::text,
        'definition', pg_catalog.pg_get_functiondef(target.oid),
        'identity_arguments',
          pg_catalog.pg_get_function_identity_arguments(target.oid),
        'result', pg_catalog.pg_get_function_result(target.oid),
        'owner_oid', target.proowner::text,
        'acl', pg_catalog.to_jsonb(target.proacl),
        'config', pg_catalog.to_jsonb(target.proconfig),
        'volatility', target.provolatile::text,
        'security_definer', target.prosecdef,
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
      order by target.oid
    ),
    '[]'::jsonb
  )
  from pg_catalog.pg_proc target
  join pg_catalog.pg_namespace namespace
    on namespace.oid = target.pronamespace
  where namespace.nspname = 'public'
    and target.proname = 'get_stage1_source_activation_finalizations';
$$;

do $preflight$
declare
  v_required_prior_versions text[] :=
-- __AWARDPING_EXACT_PRIOR_MIGRATION_VERSIONS__
  ;
  v_missing_prior_versions text[];
  v_target_version constant text := '20260814203233';
begin
  select pg_catalog.array_agg(required.version order by required.version)
  into v_missing_prior_versions
  from pg_catalog.unnest(v_required_prior_versions) required(version)
  where not exists (
    select 1
    from supabase_migrations.schema_migrations migration
    where migration.version = required.version
  );

  perform pg_temp.awardping_finalization_getter_probe_assert(
    coalesce(pg_catalog.cardinality(v_missing_prior_versions), 0) = 0,
    'one or more prior repository migrations are not recorded as applied'
  );
  perform pg_temp.awardping_finalization_getter_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = v_target_version
    ),
    'migration 20260814203233 is already recorded as applied'
  );
  perform pg_temp.awardping_finalization_getter_probe_assert(
    pg_catalog.to_regclass(
      'private.stage1_source_baseline_activation_finalizations'
    ) is not null,
    'the immutable Stage 1 activation-finalization table is missing'
  );
  perform pg_temp.awardping_finalization_getter_probe_assert(
    pg_catalog.to_regprocedure(
      'public.get_stage1_source_activation_finalizations(uuid[])'
    ) is null
      and pg_temp.awardping_finalization_getter_probe_contract() = '[]'::jsonb,
    'the target Stage 1 finalization getter already exists or has an overload'
  );

  insert into pg_temp.awardping_stage1_finalization_getter_probe_baseline (
    required_prior_versions,
    target_function_contract
  ) values (
    v_required_prior_versions,
    pg_temp.awardping_finalization_getter_probe_contract()
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
  v_function_oid oid := pg_catalog.to_regprocedure(
    'public.get_stage1_source_activation_finalizations(uuid[])'
  );
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
begin
  perform pg_temp.awardping_finalization_getter_probe_assert(
    v_function_oid is not null,
    'the migration did not create the exact getter signature'
  );
  perform pg_temp.awardping_finalization_getter_probe_assert(
    exists (
      select 1
      from pg_catalog.pg_proc target
      where target.oid = v_function_oid
        and pg_catalog.pg_get_userbyid(target.proowner) = 'postgres'
        and target.prokind = 'f'
        and target.proretset
        and target.provolatile = 's'
        and target.proparallel = 's'
        and not target.prosecdef
        and not target.proleakproof
        and target.proconfig is not distinct from
          array['search_path=""']::text[]
        and target.proargnames is not distinct from array[
          'p_source_ids',
          'source_acquisition_id',
          'shared_award_source_id',
          'source_page_request_id',
          'disposition_item_sha256',
          'prepare_receipt_sha256',
          'guard_sha256',
          'observed_normalized_text_sha256',
          'persistence_evidence',
          'finalization_receipt_sha256',
          'receipt',
          'finalized_at'
        ]::text[]
        and target.proargmodes::text = '{i,t,t,t,t,t,t,t,t,t,t,t}'
        and pg_catalog.pg_get_function_identity_arguments(target.oid) =
          'p_source_ids uuid[]'
        and pg_catalog.has_function_privilege(
          'service_role', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'anon', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated', target.oid, 'EXECUTE'
        )
        and exists (
          select 1
          from pg_catalog.aclexplode(
            coalesce(
              target.proacl,
              pg_catalog.acldefault('f', target.proowner)
            )
          ) privilege
          where privilege.grantee = v_service_role_oid
            and privilege.privilege_type = 'EXECUTE'
            and not privilege.is_grantable
        )
        and not exists (
          select 1
          from pg_catalog.aclexplode(
            coalesce(
              target.proacl,
              pg_catalog.acldefault('f', target.proowner)
            )
          ) privilege
          where privilege.grantee = 0
            or privilege.grantee not in (target.proowner, v_service_role_oid)
            or privilege.privilege_type <> 'EXECUTE'
            or (
              privilege.grantee = v_service_role_oid
              and privilege.is_grantable
            )
        )
    ),
    'the applied getter owner, signature, security, volatility, or ACL drifted'
  );
  perform pg_temp.awardping_finalization_getter_probe_assert(
    position(
      'private.stage1_source_baseline_activation_finalizations' in
      pg_catalog.pg_get_functiondef(v_function_oid)
    ) > 0
      and position(
        'with ordinality' in
        pg_catalog.lower(pg_catalog.pg_get_functiondef(v_function_oid))
      ) > 0
      and position(
        'order by requested.requested_ordinality' in
        pg_catalog.lower(pg_catalog.pg_get_functiondef(v_function_oid))
      ) > 0,
    'the applied getter lost its exact private evidence source or ordering'
  );
  perform pg_temp.awardping_finalization_getter_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260814203233'
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
    from pg_temp.awardping_stage1_finalization_getter_probe_baseline baseline
  );
begin
  perform pg_temp.awardping_finalization_getter_probe_assert(
    pg_temp.awardping_finalization_getter_probe_contract() = (
      select baseline.target_function_contract
      from pg_temp.awardping_stage1_finalization_getter_probe_baseline baseline
    ),
    'the target getter definition or catalog attributes survived rollback'
  );
  perform pg_temp.awardping_finalization_getter_probe_assert(
    pg_catalog.to_regprocedure(
      'public.get_stage1_source_activation_finalizations(uuid[])'
    ) is null,
    'the new Stage 1 finalization getter survived rollback'
  );
  perform pg_temp.awardping_finalization_getter_probe_assert(
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
        where migration.version = '20260814203233'
      ),
    'migration history changed despite rollback'
  );
end;
$post_rollback$;

select
  true as awardping_stage1_pending_migration_rollback_probe_passed,
  true as awardping_stage1_finalization_getter_rollback_probe_passed,
  1 as exact_migration_count,
  1 as exact_smoke_count,
  '20260814203233_get_stage1_source_activation_finalizations.sql'::text
    as exact_migration,
  'stage1_source_activation_finalizations_getter_smoke.sql'::text
    as exact_smoke,
  'migration/smoke/catalog changes rolled back'::text as persistence_result;

drop table pg_temp.awardping_stage1_finalization_getter_probe_baseline;
drop function pg_temp.awardping_finalization_getter_probe_contract();
drop function pg_temp.awardping_finalization_getter_probe_assert(boolean, text);

commit;
-- POST-ROLLBACK VERIFICATION END
