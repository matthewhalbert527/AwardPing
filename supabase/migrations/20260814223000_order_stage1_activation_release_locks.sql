-- Stage 1 activation finalization and failure both mutate reviewed source
-- state. Acquire the same release-wide advisory lock used by the source
-- release-fence trigger before either RPC takes its acquisition or source-row
-- lock. This removes the global-lock/row-lock inversion without rewriting the
-- already-deployed business logic.

do $finalize_release_lock_order$
declare
  v_signature constant text :=
    'public.finalize_stage1_source_baseline_activation(uuid,uuid,text,text,text,jsonb)';
  v_anchor constant text := E'begin\n  if p_source_id is null';
  v_global_key constant text :=
    'pg_catalog.hashtextextended(''stage1-national-25-release'', 0)';
  v_replacement constant text := E'begin\n  perform pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended(''stage1-national-25-release'', 0)\n  );\n\n  if p_source_id is null';
  v_per_acquisition_key constant text :=
    '''stage1-baseline-activation:'' || p_acquisition_id::text';
  v_function_oid oid := pg_catalog.to_regprocedure(v_signature);
  v_definition text;
  v_updated text;
  v_before_contract jsonb;
  v_after_contract jsonb;
begin
  if v_function_oid is null then
    raise exception using errcode = '55000',
      message = 'The exact Stage 1 activation-finalization RPC is missing.';
  end if;

  select pg_catalog.jsonb_build_object(
    'oid', target.oid::text,
    'owner', target.proowner::text,
    'acl', pg_catalog.to_jsonb(target.proacl),
    'config', pg_catalog.to_jsonb(target.proconfig),
    'volatility', target.provolatile::text,
    'security_definer', target.prosecdef,
    'strict', target.proisstrict,
    'leakproof', target.proleakproof,
    'parallel', target.proparallel::text,
    'kind', target.prokind::text,
    'language', target.prolang::text,
    'result', pg_catalog.pg_get_function_result(target.oid),
    'identity_arguments',
      pg_catalog.pg_get_function_identity_arguments(target.oid),
    'argument_names', pg_catalog.to_jsonb(target.proargnames),
    'argument_types', target.proargtypes::text,
    'all_argument_types', pg_catalog.to_jsonb(target.proallargtypes),
    'argument_modes', pg_catalog.to_jsonb(target.proargmodes),
    'comment', pg_catalog.obj_description(target.oid, 'pg_proc')
  ), pg_catalog.pg_get_functiondef(target.oid)
  into strict v_before_contract, v_definition
  from pg_catalog.pg_proc target
  where target.oid = v_function_oid;

  if pg_catalog.strpos(v_definition, v_global_key) > 0 then
    if (
        pg_catalog.length(v_definition) - pg_catalog.length(
          pg_catalog.replace(v_definition, v_global_key, '')
        )
      ) / pg_catalog.length(v_global_key) <> 1
      or pg_catalog.strpos(v_definition, v_replacement) = 0
      or pg_catalog.strpos(v_definition, v_global_key) >=
        pg_catalog.strpos(v_definition, v_per_acquisition_key)
    then
      raise exception using errcode = '55000',
        message = 'The Stage 1 activation-finalization RPC has a drifted release-lock order.';
    end if;
  else
    if pg_catalog.strpos(v_definition, v_anchor) = 0
      or pg_catalog.strpos(
        pg_catalog.substr(
          v_definition,
          pg_catalog.strpos(v_definition, v_anchor) +
            pg_catalog.length(v_anchor)
        ),
        v_anchor
      ) > 0
    then
      raise exception using errcode = '55000',
        message = 'The Stage 1 activation-finalization RPC does not contain exactly one release-lock insertion anchor.';
    end if;

    v_updated := pg_catalog.replace(v_definition, v_anchor, v_replacement);
    if v_updated = v_definition
      or pg_catalog.replace(v_updated, v_replacement, v_anchor)
        is distinct from v_definition
      or (
          pg_catalog.length(v_updated) - pg_catalog.length(
            pg_catalog.replace(v_updated, v_global_key, '')
          )
        ) / pg_catalog.length(v_global_key) <> 1
      or pg_catalog.strpos(v_updated, v_global_key) >=
        pg_catalog.strpos(v_updated, v_per_acquisition_key)
    then
      raise exception using errcode = '55000',
        message = 'The exact Stage 1 activation-finalization release-lock delta could not be proven.';
    end if;

    execute v_updated;

    select pg_catalog.jsonb_build_object(
      'oid', target.oid::text,
      'owner', target.proowner::text,
      'acl', pg_catalog.to_jsonb(target.proacl),
      'config', pg_catalog.to_jsonb(target.proconfig),
      'volatility', target.provolatile::text,
      'security_definer', target.prosecdef,
      'strict', target.proisstrict,
      'leakproof', target.proleakproof,
      'parallel', target.proparallel::text,
      'kind', target.prokind::text,
      'language', target.prolang::text,
      'result', pg_catalog.pg_get_function_result(target.oid),
      'identity_arguments',
        pg_catalog.pg_get_function_identity_arguments(target.oid),
      'argument_names', pg_catalog.to_jsonb(target.proargnames),
      'argument_types', target.proargtypes::text,
      'all_argument_types', pg_catalog.to_jsonb(target.proallargtypes),
      'argument_modes', pg_catalog.to_jsonb(target.proargmodes),
      'comment', pg_catalog.obj_description(target.oid, 'pg_proc')
    )
    into strict v_after_contract
    from pg_catalog.pg_proc target
    where target.oid = v_function_oid;

    if v_after_contract is distinct from v_before_contract
      or pg_catalog.pg_get_functiondef(v_function_oid) is distinct from
        v_updated
    then
      raise exception using errcode = '55000',
        message = 'The Stage 1 activation-finalization lock patch changed more than its exact function-body delta.';
    end if;
  end if;
end;
$finalize_release_lock_order$;

do $failure_release_lock_order$
declare
  v_signature constant text :=
    'public.fail_stage1_source_baseline_activation(uuid,uuid,uuid,text,jsonb)';
  v_anchor constant text := E'begin\n  if p_source_id is null';
  v_global_key constant text :=
    'pg_catalog.hashtextextended(''stage1-national-25-release'', 0)';
  v_replacement constant text := E'begin\n  perform pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended(''stage1-national-25-release'', 0)\n  );\n\n  if p_source_id is null';
  v_per_acquisition_key constant text :=
    '''stage1-baseline-activation:'' || p_acquisition_id::text';
  v_function_oid oid := pg_catalog.to_regprocedure(v_signature);
  v_definition text;
  v_updated text;
  v_before_contract jsonb;
  v_after_contract jsonb;
begin
  if v_function_oid is null then
    raise exception using errcode = '55000',
      message = 'The exact Stage 1 activation-failure RPC is missing.';
  end if;

  select pg_catalog.jsonb_build_object(
    'oid', target.oid::text,
    'owner', target.proowner::text,
    'acl', pg_catalog.to_jsonb(target.proacl),
    'config', pg_catalog.to_jsonb(target.proconfig),
    'volatility', target.provolatile::text,
    'security_definer', target.prosecdef,
    'strict', target.proisstrict,
    'leakproof', target.proleakproof,
    'parallel', target.proparallel::text,
    'kind', target.prokind::text,
    'language', target.prolang::text,
    'result', pg_catalog.pg_get_function_result(target.oid),
    'identity_arguments',
      pg_catalog.pg_get_function_identity_arguments(target.oid),
    'argument_names', pg_catalog.to_jsonb(target.proargnames),
    'argument_types', target.proargtypes::text,
    'all_argument_types', pg_catalog.to_jsonb(target.proallargtypes),
    'argument_modes', pg_catalog.to_jsonb(target.proargmodes),
    'comment', pg_catalog.obj_description(target.oid, 'pg_proc')
  ), pg_catalog.pg_get_functiondef(target.oid)
  into strict v_before_contract, v_definition
  from pg_catalog.pg_proc target
  where target.oid = v_function_oid;

  if pg_catalog.strpos(v_definition, v_global_key) > 0 then
    if (
        pg_catalog.length(v_definition) - pg_catalog.length(
          pg_catalog.replace(v_definition, v_global_key, '')
        )
      ) / pg_catalog.length(v_global_key) <> 1
      or pg_catalog.strpos(v_definition, v_replacement) = 0
      or pg_catalog.strpos(v_definition, v_global_key) >=
        pg_catalog.strpos(v_definition, v_per_acquisition_key)
    then
      raise exception using errcode = '55000',
        message = 'The Stage 1 activation-failure RPC has a drifted release-lock order.';
    end if;
  else
    if pg_catalog.strpos(v_definition, v_anchor) = 0
      or pg_catalog.strpos(
        pg_catalog.substr(
          v_definition,
          pg_catalog.strpos(v_definition, v_anchor) +
            pg_catalog.length(v_anchor)
        ),
        v_anchor
      ) > 0
    then
      raise exception using errcode = '55000',
        message = 'The Stage 1 activation-failure RPC does not contain exactly one release-lock insertion anchor.';
    end if;

    v_updated := pg_catalog.replace(v_definition, v_anchor, v_replacement);
    if v_updated = v_definition
      or pg_catalog.replace(v_updated, v_replacement, v_anchor)
        is distinct from v_definition
      or (
          pg_catalog.length(v_updated) - pg_catalog.length(
            pg_catalog.replace(v_updated, v_global_key, '')
          )
        ) / pg_catalog.length(v_global_key) <> 1
      or pg_catalog.strpos(v_updated, v_global_key) >=
        pg_catalog.strpos(v_updated, v_per_acquisition_key)
    then
      raise exception using errcode = '55000',
        message = 'The exact Stage 1 activation-failure release-lock delta could not be proven.';
    end if;

    execute v_updated;

    select pg_catalog.jsonb_build_object(
      'oid', target.oid::text,
      'owner', target.proowner::text,
      'acl', pg_catalog.to_jsonb(target.proacl),
      'config', pg_catalog.to_jsonb(target.proconfig),
      'volatility', target.provolatile::text,
      'security_definer', target.prosecdef,
      'strict', target.proisstrict,
      'leakproof', target.proleakproof,
      'parallel', target.proparallel::text,
      'kind', target.prokind::text,
      'language', target.prolang::text,
      'result', pg_catalog.pg_get_function_result(target.oid),
      'identity_arguments',
        pg_catalog.pg_get_function_identity_arguments(target.oid),
      'argument_names', pg_catalog.to_jsonb(target.proargnames),
      'argument_types', target.proargtypes::text,
      'all_argument_types', pg_catalog.to_jsonb(target.proallargtypes),
      'argument_modes', pg_catalog.to_jsonb(target.proargmodes),
      'comment', pg_catalog.obj_description(target.oid, 'pg_proc')
    )
    into strict v_after_contract
    from pg_catalog.pg_proc target
    where target.oid = v_function_oid;

    if v_after_contract is distinct from v_before_contract
      or pg_catalog.pg_get_functiondef(v_function_oid) is distinct from
        v_updated
    then
      raise exception using errcode = '55000',
        message = 'The Stage 1 activation-failure lock patch changed more than its exact function-body delta.';
    end if;
  end if;
end;
$failure_release_lock_order$;

revoke all on function public.finalize_stage1_source_baseline_activation(
  uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_stage1_source_baseline_activation(
  uuid, uuid, text, text, text, jsonb
) to service_role;

revoke all on function public.fail_stage1_source_baseline_activation(
  uuid, uuid, uuid, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.fail_stage1_source_baseline_activation(
  uuid, uuid, uuid, text, jsonb
) to service_role;

do $release_lock_catalog_guard$
declare
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
  v_target record;
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
    select pg_catalog.pg_get_functiondef(candidate.oid)
    into strict v_definition
    from pg_catalog.pg_proc candidate
    where candidate.oid = pg_catalog.to_regprocedure(v_target.signature)
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
      );

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
      raise exception using errcode = '55000',
        message = 'A Stage 1 activation RPC lost its global-first release-lock contract.';
    end if;
  end loop;
end;
$release_lock_catalog_guard$;
