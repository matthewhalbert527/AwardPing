-- The original Stage 1 gate widened each local_worker_runs row with three CTE
-- columns, then passed that wider record to a function whose argument is the
-- exact public.local_worker_runs composite type. PostgreSQL rejects that call
-- with 42846 before the gate can fail closed. Preserve every existing field and
-- calculation, but retain the source table row as an explicit composite for
-- the health predicate.

do $awardping_stage1_gate_composite_fix$
declare
  v_gate_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_release_gate_snapshot(timestamp with time zone)'
  );
  v_definition text;
  v_updated_definition text;
  v_old_base_anchor text := E'select\n      run.*,\n      private.stage1_normal_6pm_monitoring_date(run) as monitoring_date,';
  v_new_base_anchor text := E'select\n      run as worker_run,\n      run.*,\n      private.stage1_normal_6pm_monitoring_date(run) as monitoring_date,';
  v_old_health_call text := 'private.stage1_6pm_shard_healthy(latest_runs)';
  v_new_health_call text := 'private.stage1_6pm_shard_healthy(latest_runs.worker_run)';
  v_old_base_count integer;
  v_old_health_count integer;
  v_owner oid;
  v_acl aclitem[];
  v_security_definer boolean;
  v_volatility "char";
  v_proconfig text[];
begin
  if v_gate_oid is null then
    raise exception using
      errcode = '42883',
      message = 'Stage 1 release gate composite fix requires the deployed gate function.';
  end if;

  select
    pg_catalog.pg_get_functiondef(procedure.oid),
    procedure.proowner,
    procedure.proacl,
    procedure.prosecdef,
    procedure.provolatile,
    procedure.proconfig
  into
    v_definition,
    v_owner,
    v_acl,
    v_security_definer,
    v_volatility,
    v_proconfig
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_gate_oid;

  v_old_base_count := (
    pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_old_base_anchor, ''))
  ) / pg_catalog.length(v_old_base_anchor);
  v_old_health_count := (
    pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_old_health_call, ''))
  ) / pg_catalog.length(v_old_health_call);

  if v_old_base_count <> 1
    or v_old_health_count <> 1
    or pg_catalog.strpos(v_definition, v_new_base_anchor) > 0
    or pg_catalog.strpos(v_definition, v_new_health_call) > 0 then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 release gate definition did not match the exact known-bad composite-row contract.';
  end if;

  v_updated_definition := pg_catalog.replace(
    pg_catalog.replace(v_definition, v_old_base_anchor, v_new_base_anchor),
    v_old_health_call,
    v_new_health_call
  );
  execute v_updated_definition;

  if not exists (
    select 1
    from pg_catalog.pg_proc procedure
    where procedure.oid = v_gate_oid
      and procedure.proowner = v_owner
      and procedure.proacl is not distinct from v_acl
      and procedure.prosecdef = v_security_definer
      and procedure.provolatile = v_volatility
      and procedure.proconfig is not distinct from v_proconfig
      and pg_catalog.strpos(
        pg_catalog.pg_get_functiondef(procedure.oid), v_new_base_anchor
      ) > 0
      and pg_catalog.strpos(
        pg_catalog.pg_get_functiondef(procedure.oid), v_new_health_call
      ) > 0
      and pg_catalog.strpos(
        pg_catalog.pg_get_functiondef(procedure.oid), v_old_health_call
      ) = 0
  ) then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 release gate composite fix did not preserve its definition and security contract.';
  end if;
end;
$awardping_stage1_gate_composite_fix$;

-- Keep the private implementation inaccessible. The service role continues to
-- use the existing public.get_stage1_release_gate_snapshot() wrapper.
revoke all on function private.stage1_release_gate_snapshot(timestamptz)
  from public, anon, authenticated, service_role;

do $awardping_stage1_gate_composite_security$
begin
  if not exists (
    select 1
    from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure(
        'private.stage1_release_gate_snapshot(timestamp with time zone)'
      )
      and procedure.prosecdef
      and procedure.provolatile = 'v'
      and coalesce('search_path=""' = any(procedure.proconfig), false)
  ) or pg_catalog.has_function_privilege(
    'anon',
    'private.stage1_release_gate_snapshot(timestamp with time zone)',
    'EXECUTE'
  ) or pg_catalog.has_function_privilege(
    'authenticated',
    'private.stage1_release_gate_snapshot(timestamp with time zone)',
    'EXECUTE'
  ) or pg_catalog.has_function_privilege(
    'service_role',
    'private.stage1_release_gate_snapshot(timestamp with time zone)',
    'EXECUTE'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 release gate composite fix changed the private function security boundary.';
  end if;
end;
$awardping_stage1_gate_composite_security$;
