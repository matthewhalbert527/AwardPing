-- This file is a template. Execute it only through
--   node scripts/run-stage1-expansion-capture-coverage-rollback-probe.mjs
-- The runner writes UTF-8 LF bytes to a temporary file and gives that file to
-- the Supabase CLI. The migration and semantic smoke run in one transaction
-- and are rolled back before the exact prior catalog contract is compared.

begin;

create temporary table awardping_stage1_coverage_probe_baseline (
  function_oid oid primary key,
  function_contract jsonb not null
) on commit preserve rows;

create function pg_temp.awardping_coverage_probe_assert(
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
      message = 'Stage 1 expansion coverage rollback probe failed: ' || p_message;
  end if;
end;
$$;

create function pg_temp.awardping_coverage_probe_function_contract(
  p_function_oid oid
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'oid', target.oid::text,
    'definition', pg_catalog.pg_get_functiondef(target.oid),
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
    'argument_type_oids', target.proargtypes::text
  )
  from pg_catalog.pg_proc target
  where target.oid = p_function_oid;
$$;

do $preflight$
declare
  v_function_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_manifest_source_capture_binding_valid(uuid,text,jsonb,jsonb,jsonb)'
  );
begin
  perform pg_temp.awardping_coverage_probe_assert(
    v_function_oid is not null,
    'the retained-source validator is missing'
  );
  perform pg_temp.awardping_coverage_probe_assert(
    pg_catalog.to_regprocedure(
      'private.stage1_expansion_capture_coverage_valid(text,jsonb)'
    ) is null,
    'the new coverage validator already exists'
  );
  perform pg_temp.awardping_coverage_probe_assert(
    exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260814141049'
    ),
    'prerequisite migration 20260814141049 is not recorded as applied'
  );
  perform pg_temp.awardping_coverage_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260814173236'
    ),
    'migration 20260814173236 is already recorded as applied'
  );
  perform pg_temp.awardping_coverage_probe_assert(
    position(
      'if v_expansion_page_count <> v_expansion_layout_count' in
      pg_catalog.pg_get_functiondef(v_function_oid)
    ) > 0
      and position(
        'private.stage1_expansion_capture_coverage_valid' in
        pg_catalog.pg_get_functiondef(v_function_oid)
      ) = 0,
    'the live validator is not the expected post-20260814141049 definition'
  );
  perform pg_temp.awardping_coverage_probe_assert(
    (
      select pg_catalog.pg_get_userbyid(target.proowner) = 'postgres'
        and target.provolatile = 'i'
        and not target.prosecdef
        and target.proconfig is not distinct from
          array['search_path=""']::text[]
        and not pg_catalog.has_function_privilege(
          'anon', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'service_role', target.oid, 'EXECUTE'
        )
      from pg_catalog.pg_proc target
      where target.oid = v_function_oid
    ),
    'the pre-migration validator ownership, execution, or search-path contract is unsafe'
  );

  insert into pg_temp.awardping_stage1_coverage_probe_baseline (
    function_oid,
    function_contract
  ) values (
    v_function_oid,
    pg_temp.awardping_coverage_probe_function_contract(v_function_oid)
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
    'private.stage1_manifest_source_capture_binding_valid(uuid,text,jsonb,jsonb,jsonb)'
  );
  v_coverage_function_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_expansion_capture_coverage_valid(text,jsonb)'
  );
begin
  perform pg_temp.awardping_coverage_probe_assert(
    v_function_oid = (
      select baseline.function_oid
      from pg_temp.awardping_stage1_coverage_probe_baseline baseline
    ),
    'CREATE OR REPLACE changed the retained-source validator identity'
  );
  perform pg_temp.awardping_coverage_probe_assert(
    v_coverage_function_oid is not null,
    'the canonical expansion coverage validator was not created'
  );
  perform pg_temp.awardping_coverage_probe_assert(
    position(
      'private.stage1_expansion_capture_coverage_valid' in
      pg_catalog.pg_get_functiondef(v_function_oid)
    ) > 0,
    'the retained-source validator does not call the coverage validator'
  );
  perform pg_temp.awardping_coverage_probe_assert(
    position(
      'awardping.expansion-state-capture-coverage.v1' in
      pg_catalog.pg_get_functiondef(v_coverage_function_oid)
    ) > 0
      and position(
        'verified completeness' in
        pg_catalog.lower(pg_catalog.pg_get_functiondef(v_coverage_function_oid))
      ) > 0,
    'the coverage validator does not contain the reviewed canonical contract'
  );
  perform pg_temp.awardping_coverage_probe_assert(
    not exists (
      select 1
      from pg_catalog.unnest(
        array[v_function_oid, v_coverage_function_oid]
      ) as function_oid(oid)
      join pg_catalog.pg_proc target on target.oid = function_oid.oid
      where pg_catalog.pg_get_userbyid(target.proowner) <> 'postgres'
        or target.provolatile <> 'i'
        or target.prosecdef
        or target.proconfig is distinct from array['search_path=""']::text[]
        or pg_catalog.has_function_privilege('anon', target.oid, 'EXECUTE')
        or pg_catalog.has_function_privilege('authenticated', target.oid, 'EXECUTE')
        or pg_catalog.has_function_privilege('service_role', target.oid, 'EXECUTE')
    ),
    'a migrated validator broadened ownership, execution, or search-path authority'
  );
  perform pg_temp.awardping_coverage_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260814173236'
    ),
    'direct probe execution unexpectedly changed migration history'
  );
end;
$applied_contract$;

rollback;
-- MIGRATION TRANSACTION END

-- POST-ROLLBACK VERIFICATION START
begin;

do $post_rollback$
declare
  v_function_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_manifest_source_capture_binding_valid(uuid,text,jsonb,jsonb,jsonb)'
  );
begin
  perform pg_temp.awardping_coverage_probe_assert(
    v_function_oid = (
      select baseline.function_oid
      from pg_temp.awardping_stage1_coverage_probe_baseline baseline
    ),
    'the retained-source validator OID did not return after rollback'
  );
  perform pg_temp.awardping_coverage_probe_assert(
    pg_temp.awardping_coverage_probe_function_contract(v_function_oid) = (
      select baseline.function_contract
      from pg_temp.awardping_stage1_coverage_probe_baseline baseline
    ),
    'the retained-source validator definition or catalog metadata survived rollback'
  );
  perform pg_temp.awardping_coverage_probe_assert(
    pg_catalog.to_regprocedure(
      'private.stage1_expansion_capture_coverage_valid(text,jsonb)'
    ) is null,
    'the new coverage validator survived rollback'
  );
  perform pg_temp.awardping_coverage_probe_assert(
    exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260814141049'
    )
      and not exists (
        select 1
        from supabase_migrations.schema_migrations migration
        where migration.version = '20260814173236'
      ),
    'migration history changed despite rollback'
  );
end;
$post_rollback$;

select
  true as awardping_stage1_pending_migration_rollback_probe_passed,
  true as awardping_stage1_expansion_coverage_rollback_probe_passed,
  1 as exact_migration_count,
  '20260814173236_require_stage1_expansion_capture_coverage.sql'::text
    as exact_migration,
  'migration/schema/assertion changes rolled back'::text as persistence_result;

drop table pg_temp.awardping_stage1_coverage_probe_baseline;
drop function pg_temp.awardping_coverage_probe_function_contract(oid);
drop function pg_temp.awardping_coverage_probe_assert(boolean, text);

commit;
-- POST-ROLLBACK VERIFICATION END
