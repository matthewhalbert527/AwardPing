-- This file is a template. Execute it only through
--   node scripts/run-stage1-lane-gate-cadence-sla-rollback-probe.mjs
-- The exact migration runs inside a transaction, its catalog and semantic
-- assertions execute, and every schema change is rolled back before the prior
-- function contracts are compared byte-for-byte.

begin;

create temporary table awardping_stage1_lane_gate_probe_baseline (
  function_oid oid primary key,
  function_contract jsonb not null
) on commit preserve rows;

create function pg_temp.awardping_lane_gate_probe_assert(
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
      message = 'Stage 1 cadence-lane rollback probe failed: ' || p_message;
  end if;
end;
$$;

create function pg_temp.awardping_lane_gate_probe_function_contract(
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
  v_inner_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_gate_without_contact_fence_20260717123000(timestamp with time zone)'
  );
  v_wrapper_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_release_gate_snapshot(timestamp with time zone)'
  );
begin
  perform pg_temp.awardping_lane_gate_probe_assert(
    v_inner_oid is not null,
    'the inherited Stage 1 gate is missing'
  );
  perform pg_temp.awardping_lane_gate_probe_assert(
    v_wrapper_oid is not null,
    'the canonical Stage 1 gate wrapper is missing'
  );
  perform pg_temp.awardping_lane_gate_probe_assert(
    pg_catalog.to_regprocedure(
      'private.stage1_downstream_lane_sla_contract_valid(text,bigint,bigint,bigint,timestamp with time zone,timestamp with time zone)'
    ) is null,
    'the new lane SLA helper already exists'
  );
  perform pg_temp.awardping_lane_gate_probe_assert(
    exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260810194427'
    ),
    'the canonical R2 release-gate wrapper prerequisite is not recorded as applied'
  );
  perform pg_temp.awardping_lane_gate_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260814191514'
    ),
    'migration 20260814191514 is already recorded as applied'
  );
  perform pg_temp.awardping_lane_gate_probe_assert(
    (
      pg_catalog.length(pg_catalog.pg_get_functiondef(v_inner_oid))
        - pg_catalog.length(
          pg_catalog.replace(
            pg_catalog.pg_get_functiondef(v_inner_oid),
            'lane.oldest_item_sla_seconds > 0',
            ''
          )
        )
    ) / pg_catalog.length('lane.oldest_item_sla_seconds > 0') = 1,
    'the inherited gate does not contain the exact known-bad SLA predicate once'
  );
  perform pg_temp.awardping_lane_gate_probe_assert(
    (
      pg_catalog.length(pg_catalog.pg_get_functiondef(v_wrapper_oid))
        - pg_catalog.length(
          pg_catalog.replace(
            pg_catalog.pg_get_functiondef(v_wrapper_oid),
            'private.stage1_gate_without_contact_fence_20260717123000(',
            ''
          )
        )
    ) / pg_catalog.length(
      'private.stage1_gate_without_contact_fence_20260717123000('
    ) = 1,
    'the canonical wrapper does not call the inherited gate exactly once'
  );

  insert into pg_temp.awardping_stage1_lane_gate_probe_baseline (
    function_oid,
    function_contract
  ) values
    (
      v_inner_oid,
      pg_temp.awardping_lane_gate_probe_function_contract(v_inner_oid)
    ),
    (
      v_wrapper_oid,
      pg_temp.awardping_lane_gate_probe_function_contract(v_wrapper_oid)
    );
end;
$preflight$;

commit;

-- MIGRATION TRANSACTION START
begin;

-- __AWARDPING_EXACT_MIGRATION__

do $applied_contract$
declare
  v_inner_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_gate_without_contact_fence_20260717123000(timestamp with time zone)'
  );
  v_wrapper_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_release_gate_snapshot(timestamp with time zone)'
  );
  v_helper_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_downstream_lane_sla_contract_valid(text,bigint,bigint,bigint,timestamp with time zone,timestamp with time zone)'
  );
begin
  perform pg_temp.awardping_lane_gate_probe_assert(
    exists (
      select 1
      from pg_temp.awardping_stage1_lane_gate_probe_baseline baseline
      where baseline.function_oid = v_inner_oid
    ),
    'CREATE OR REPLACE changed the inherited gate identity'
  );
  perform pg_temp.awardping_lane_gate_probe_assert(
    v_helper_oid is not null,
    'the private lane SLA helper was not created'
  );
  perform pg_temp.awardping_lane_gate_probe_assert(
    pg_catalog.strpos(
      pg_catalog.pg_get_functiondef(v_inner_oid),
      'private.stage1_downstream_lane_sla_contract_valid('
    ) > 0
      and pg_catalog.strpos(
        pg_catalog.pg_get_functiondef(v_inner_oid),
        'lane.oldest_item_sla_seconds > 0'
      ) = 0,
    'the inherited gate did not switch to the metric-aware SLA contract'
  );
  perform pg_temp.awardping_lane_gate_probe_assert(
    pg_temp.awardping_lane_gate_probe_function_contract(v_wrapper_oid) = (
      select baseline.function_contract
      from pg_temp.awardping_stage1_lane_gate_probe_baseline baseline
      where baseline.function_oid = v_wrapper_oid
    ),
    'the canonical wrapper changed even though only its inherited gate needed repair'
  );
  perform pg_temp.awardping_lane_gate_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260814191514'
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
  v_function_oid oid;
  v_baseline record;
begin
  for v_baseline in
    select baseline.function_oid, baseline.function_contract
    from pg_temp.awardping_stage1_lane_gate_probe_baseline baseline
  loop
    v_function_oid := v_baseline.function_oid;
    perform pg_temp.awardping_lane_gate_probe_assert(
      pg_temp.awardping_lane_gate_probe_function_contract(v_function_oid) =
        v_baseline.function_contract,
      'a Stage 1 gate definition or catalog attribute survived rollback'
    );
  end loop;

  perform pg_temp.awardping_lane_gate_probe_assert(
    pg_catalog.to_regprocedure(
      'private.stage1_downstream_lane_sla_contract_valid(text,bigint,bigint,bigint,timestamp with time zone,timestamp with time zone)'
    ) is null,
    'the new lane SLA helper survived rollback'
  );
  perform pg_temp.awardping_lane_gate_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260814191514'
    ),
    'migration history changed despite rollback'
  );
end;
$post_rollback$;

select
  true as awardping_stage1_pending_migration_rollback_probe_passed,
  true as awardping_stage1_lane_gate_cadence_sla_rollback_probe_passed,
  1 as exact_migration_count,
  '20260814191514_fix_stage1_lane_gate_cadence_sla.sql'::text
    as exact_migration,
  'migration/schema/assertion changes rolled back'::text as persistence_result;

drop table pg_temp.awardping_stage1_lane_gate_probe_baseline;
drop function pg_temp.awardping_lane_gate_probe_function_contract(oid);
drop function pg_temp.awardping_lane_gate_probe_assert(boolean, text);

commit;
-- POST-ROLLBACK VERIFICATION END
