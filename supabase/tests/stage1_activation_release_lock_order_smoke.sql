-- Verify the two existing activation mutation RPCs acquire the release-wide
-- advisory lock as their first executable statement, retain their exact
-- service-only security contract, and reject invalid calls without writes.
do $catalog_smoke$
declare
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
  v_target record;
  v_function_oid oid;
  v_definition text;
  v_global_key constant text :=
    'pg_catalog.hashtextextended(''stage1-national-25-release'', 0)';
begin
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
    v_function_oid := pg_catalog.to_regprocedure(v_target.signature);
    if v_function_oid is null
      or not exists (
        select 1
        from pg_catalog.pg_proc candidate
        where candidate.oid = v_function_oid
          and pg_catalog.pg_get_userbyid(candidate.proowner) = 'postgres'
          and candidate.prokind = 'f'
          and candidate.provolatile = 'v'
          and candidate.prosecdef
          and not candidate.proleakproof
          and candidate.proconfig is not distinct from
            array['search_path=""']::text[]
          and pg_catalog.has_function_privilege(
            'service_role', candidate.oid, 'EXECUTE'
          )
          and not pg_catalog.has_function_privilege(
            'anon', candidate.oid, 'EXECUTE'
          )
          and not pg_catalog.has_function_privilege(
            'authenticated', candidate.oid, 'EXECUTE'
          )
          and not exists (
            select 1
            from pg_catalog.aclexplode(
              coalesce(
                candidate.proacl,
                pg_catalog.acldefault('f', candidate.proowner)
              )
            ) privilege
            where privilege.grantee = 0
              or privilege.grantee not in (
                candidate.proowner,
                v_service_role_oid
              )
              or privilege.privilege_type <> 'EXECUTE'
              or (
                privilege.grantee = v_service_role_oid
                and privilege.is_grantable
              )
          )
      )
    then
      raise exception
        'A Stage 1 activation RPC owner, security, volatility, search path, or ACL is unsafe.';
    end if;

    v_definition := pg_catalog.pg_get_functiondef(v_function_oid);
    if (
        pg_catalog.length(v_definition) - pg_catalog.length(
          pg_catalog.replace(v_definition, v_global_key, '')
        )
      ) / pg_catalog.length(v_global_key) <> 1
      or pg_catalog.strpos(
        v_definition,
        E'begin\n  perform pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended(''stage1-national-25-release'', 0)\n  );\n\n  if p_source_id is null'
      ) = 0
      or pg_catalog.strpos(v_definition, v_global_key) >=
        pg_catalog.strpos(v_definition, v_target.per_acquisition_key)
    then
      raise exception
        'A Stage 1 activation RPC does not acquire the release lock before validation, acquisition locking, and source-row locking.';
    end if;
  end loop;
end;
$catalog_smoke$;

set role anon;
do $anon_denied$
declare
  v_finalize_denied boolean := false;
  v_fail_denied boolean := false;
begin
  begin
    perform public.finalize_stage1_source_baseline_activation(
      null::uuid, null::uuid, null::text, null::text, null::text, null::jsonb
    );
  exception when insufficient_privilege then
    v_finalize_denied := true;
  end;
  begin
    perform public.fail_stage1_source_baseline_activation(
      null::uuid, null::uuid, null::uuid, null::text, null::jsonb
    );
  exception when insufficient_privilege then
    v_fail_denied := true;
  end;
  if not v_finalize_denied or not v_fail_denied then
    raise exception 'The anon role invoked a Stage 1 activation mutation RPC.';
  end if;
end;
$anon_denied$;
reset role;

set role authenticated;
do $authenticated_denied$
declare
  v_finalize_denied boolean := false;
  v_fail_denied boolean := false;
begin
  begin
    perform public.finalize_stage1_source_baseline_activation(
      null::uuid, null::uuid, null::text, null::text, null::text, null::jsonb
    );
  exception when insufficient_privilege then
    v_finalize_denied := true;
  end;
  begin
    perform public.fail_stage1_source_baseline_activation(
      null::uuid, null::uuid, null::uuid, null::text, null::jsonb
    );
  exception when insufficient_privilege then
    v_fail_denied := true;
  end;
  if not v_finalize_denied or not v_fail_denied then
    raise exception
      'The authenticated role invoked a Stage 1 activation mutation RPC.';
  end if;
end;
$authenticated_denied$;
reset role;

set role service_role;
do $service_role_allowed$
declare
  v_finalize_reached_validation boolean := false;
  v_fail_reached_validation boolean := false;
begin
  begin
    perform public.finalize_stage1_source_baseline_activation(
      null::uuid, null::uuid, null::text, null::text, null::text, null::jsonb
    );
  exception when sqlstate '22023' then
    v_finalize_reached_validation := true;
  end;
  begin
    perform public.fail_stage1_source_baseline_activation(
      null::uuid, null::uuid, null::uuid, null::text, null::jsonb
    );
  exception when sqlstate '22023' then
    v_fail_reached_validation := true;
  end;
  if not v_finalize_reached_validation or not v_fail_reached_validation then
    raise exception
      'The service role did not reach both Stage 1 activation RPC validation boundaries.';
  end if;
end;
$service_role_allowed$;
reset role;
