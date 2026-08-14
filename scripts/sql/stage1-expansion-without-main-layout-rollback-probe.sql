-- This file is a template. Execute it only through
--   node scripts/run-stage1-expansion-without-main-layout-rollback-probe.mjs
-- The runner writes UTF-8 LF bytes to a temporary file and gives that file to
-- the Supabase CLI. The only committed objects are session-local temporary
-- probe helpers. The migration and every semantic assertion are rolled back.

begin;

create temporary table awardping_stage1_expansion_probe_baseline (
  function_oid oid primary key,
  function_contract jsonb not null
) on commit preserve rows;

create function pg_temp.awardping_expansion_probe_assert(
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
      message = 'Stage 1 expansion rollback probe failed: ' || p_message;
  end if;
end;
$$;

create function pg_temp.awardping_expansion_probe_function_contract(
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
  perform pg_temp.awardping_expansion_probe_assert(
    v_function_oid is not null,
    'the retained-source validator is missing'
  );
  perform pg_temp.awardping_expansion_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260814141049'
    ),
    'migration 20260814141049 is already recorded as applied'
  );
  perform pg_temp.awardping_expansion_probe_assert(
    position(
      'if v_expansion_page_count <> 0' in
      pg_catalog.pg_get_functiondef(v_function_oid)
    ) > 0,
    'the live validator is not the expected pre-migration definition'
  );
  perform pg_temp.awardping_expansion_probe_assert(
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

  insert into pg_temp.awardping_stage1_expansion_probe_baseline (
    function_oid,
    function_contract
  ) values (
    v_function_oid,
    pg_temp.awardping_expansion_probe_function_contract(v_function_oid)
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
begin
  perform pg_temp.awardping_expansion_probe_assert(
    v_function_oid = (
      select baseline.function_oid
      from pg_temp.awardping_stage1_expansion_probe_baseline baseline
    ),
    'CREATE OR REPLACE changed the validator identity'
  );
  perform pg_temp.awardping_expansion_probe_assert(
    position(
      'if v_expansion_page_count <> 0' in
      pg_catalog.pg_get_functiondef(v_function_oid)
    ) = 0,
    'the obsolete expansion dependency survived the migration'
  );
  perform pg_temp.awardping_expansion_probe_assert(
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
    'the migrated validator ownership, execution, or search-path contract is unsafe'
  );
  perform pg_temp.awardping_expansion_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260814141049'
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
  perform pg_temp.awardping_expansion_probe_assert(
    v_function_oid is not null,
    'the retained-source validator disappeared after rollback'
  );
  perform pg_temp.awardping_expansion_probe_assert(
    v_function_oid = (
      select baseline.function_oid
      from pg_temp.awardping_stage1_expansion_probe_baseline baseline
    ),
    'the validator OID did not return to its exact pre-probe value'
  );
  perform pg_temp.awardping_expansion_probe_assert(
    pg_temp.awardping_expansion_probe_function_contract(v_function_oid) = (
      select baseline.function_contract
      from pg_temp.awardping_stage1_expansion_probe_baseline baseline
    ),
    'the validator definition or catalog metadata survived rollback'
  );
  perform pg_temp.awardping_expansion_probe_assert(
    position(
      'if v_expansion_page_count <> 0' in
      pg_catalog.pg_get_functiondef(v_function_oid)
    ) > 0,
    'the expected pre-migration behavior did not return after rollback'
  );
  perform pg_temp.awardping_expansion_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260814141049'
    ),
    'migration history changed despite rollback'
  );
end;
$post_rollback$;

select
  true as awardping_stage1_pending_migration_rollback_probe_passed,
  1 as exact_migration_count,
  '20260814141049_allow_expansion_evidence_without_main_layout.sql'::text
    as exact_migration,
  'migration/schema/assertion changes rolled back'::text as persistence_result;

drop table pg_temp.awardping_stage1_expansion_probe_baseline;
drop function pg_temp.awardping_expansion_probe_function_contract(oid);
drop function pg_temp.awardping_expansion_probe_assert(boolean, text);

commit;
-- POST-ROLLBACK VERIFICATION END
