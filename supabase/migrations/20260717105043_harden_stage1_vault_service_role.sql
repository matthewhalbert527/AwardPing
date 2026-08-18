-- Stage 1 release evidence is verified inside postgres-owned SECURITY DEFINER
-- functions. Browser roles may not reach Vault at all. Supabase owns the
-- platform-default service_role Vault ACL as supabase_admin, so a project
-- migration cannot truthfully revoke it; instead the signed hosted-runtime
-- proof must show that the service key is denied the unexposed Vault Data API
-- profile, and no unexpected API-callable RPC may reference Vault.

do $awardping_stage1_vault_precondition$
declare
  v_postgres_oid oid := (
    select role.oid from pg_catalog.pg_roles role where role.rolname = 'postgres'
  );
  v_vault_oid oid := pg_catalog.to_regnamespace('vault');
  v_role text;
  v_signature text;
  v_function_oid oid;
begin
  if v_postgres_oid is null or v_vault_oid is null then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 Vault hardening requires postgres and the vault schema.';
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (
      select 1 from pg_catalog.pg_roles role where role.rolname = v_role
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          'Stage 1 Vault hardening requires the %s API role.', v_role
        );
    end if;
  end loop;
  if pg_catalog.to_regclass('vault.decrypted_secrets') is null then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 Vault hardening requires vault.decrypted_secrets.';
  end if;

  foreach v_signature in array array[
    'private.stage1_release_artifact_signature_valid(uuid,timestamp with time zone)',
    'private.insert_stage1_external_release_artifact(text,text,text,text,text,text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)'
  ] loop
    v_function_oid := pg_catalog.to_regprocedure(v_signature);
    if v_function_oid is null or not exists (
      select 1
      from pg_catalog.pg_proc procedure
      where procedure.oid = v_function_oid
        and procedure.proowner = v_postgres_oid
        and procedure.prosecdef
        and coalesce('search_path=""' = any(procedure.proconfig), false)
        and pg_catalog.strpos(
          pg_catalog.pg_get_functiondef(procedure.oid),
          'vault.decrypted_secrets'
        ) > 0
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          'Stage 1 Vault reader %s is missing or is not postgres-owned hardened SECURITY DEFINER code.',
          v_signature
        );
    end if;
  end loop;
end;
$awardping_stage1_vault_precondition$;

revoke all on schema vault from public, anon, authenticated;
revoke all on all tables in schema vault from public, anon, authenticated;

-- Vault owns private cryptographic helpers that postgres is intentionally not
-- allowed to grant. Revoke only functions that a browser role can actually call,
-- and prove postgres has grant authority before changing each ACL. The later
-- effective-access predicate still fails closed if role inheritance exposes a
-- function that these exact revokes cannot remove.
do $awardping_stage1_vault_function_acl_cleanup$
declare
  v_function_oid oid;
begin
  for v_function_oid in
    select procedure.oid
    from pg_catalog.pg_proc procedure
    where procedure.pronamespace = pg_catalog.to_regnamespace('vault')
      and procedure.prokind <> 'p'
      and exists (
        select 1
        from pg_catalog.unnest(
          array['anon', 'authenticated']::text[]
        ) role(role_name)
        where pg_catalog.has_function_privilege(
          role.role_name, procedure.oid, 'EXECUTE'
        )
      )
    order by procedure.oid
  loop
    if not pg_catalog.has_function_privilege(
      'postgres', v_function_oid, 'EXECUTE WITH GRANT OPTION'
    ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'postgres cannot revoke API execution of Vault function %s.',
          v_function_oid::pg_catalog.regprocedure
        );
    end if;

    execute pg_catalog.format(
      'revoke execute on function %s from public, anon, authenticated',
      v_function_oid::pg_catalog.regprocedure
    );
  end loop;
end;
$awardping_stage1_vault_function_acl_cleanup$;

-- has_*_privilege reports effective access, including PUBLIC and inherited role
-- membership. Keeping this predicate private lets the release gate continuously
-- detect permission drift after this one-time ACL cleanup.
create or replace function private.stage1_vault_access_contract_safe()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vault_oid oid := pg_catalog.to_regnamespace('vault');
  v_role text;
  v_table_privileges text[] := array[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
    'REFERENCES', 'TRIGGER'
  ];
begin
  if v_vault_oid is null
    or pg_catalog.to_regclass('vault.decrypted_secrets') is null then
    return false;
  end if;

  -- PostgreSQL 17 added MAINTAIN. Construct the list at runtime so the same
  -- predicate remains valid on the currently supported PostgreSQL 15/16 bases.
  if pg_catalog.current_setting('server_version_num')::integer >= 170000 then
    v_table_privileges := pg_catalog.array_append(
      v_table_privileges, 'MAINTAIN'
    );
  end if;

  foreach v_role in array array['anon', 'authenticated'] loop
    if pg_catalog.has_schema_privilege(v_role, v_vault_oid, 'USAGE')
      or pg_catalog.has_schema_privilege(v_role, v_vault_oid, 'CREATE') then
      return false;
    end if;
    if exists (
      select 1
      from pg_catalog.pg_class class
      cross join pg_catalog.unnest(v_table_privileges)
        privilege(privilege_name)
      where class.relnamespace = v_vault_oid
        and class.relkind in ('r', 'p', 'v', 'm', 'f')
        and pg_catalog.has_table_privilege(
          v_role, class.oid, privilege.privilege_name
        )
    ) then
      return false;
    end if;
    if exists (
      select 1
      from pg_catalog.pg_class class
      where class.relnamespace = v_vault_oid
        and class.relkind in ('r', 'p', 'v', 'm', 'f')
        and pg_catalog.has_any_column_privilege(
          v_role, class.oid, 'SELECT,INSERT,UPDATE,REFERENCES'
        )
    ) then
      return false;
    end if;
    if exists (
      select 1
      from pg_catalog.pg_proc procedure
      where procedure.pronamespace = v_vault_oid
        and procedure.prokind <> 'p'
        and pg_catalog.has_function_privilege(
          v_role, procedure.oid, 'EXECUTE'
        )
    ) then
      return false;
    end if;
  end loop;

  -- A service key can call only functions in exposed schemas. Its managed
  -- direct Vault ACL is harmless only while Vault itself is not exposed, which
  -- the signed runtime probe proves. Independently reject any unexpected RPC
  -- surface that mentions Vault and is executable by an API role.
  if exists (
    select 1
    from pg_catalog.pg_proc procedure
    where procedure.pronamespace <> v_vault_oid
      and procedure.prokind = 'f'
      and pg_catalog.strpos(
        pg_catalog.lower(pg_catalog.pg_get_functiondef(procedure.oid)),
        'vault.'
      ) > 0
      and exists (
        select 1
        from pg_catalog.unnest(
          array['anon', 'authenticated', 'service_role']::text[]
        ) role(role_name)
        where pg_catalog.has_function_privilege(
          role.role_name, procedure.oid, 'EXECUTE'
        )
      )
  ) then
    return false;
  end if;

  return true;
exception when others then
  return false;
end;
$$;

alter function private.stage1_vault_access_contract_safe() owner to postgres;
revoke all on function private.stage1_vault_access_contract_safe()
  from public, anon, authenticated, service_role;

-- The hosted-runtime proof is the enforceable boundary for Supabase's
-- platform-owned service_role Vault grants. Extend the already-deployed
-- validator by exact anchors, preserving its OID, owner, ACL, and volatility.
do $awardping_stage1_vault_runtime_evidence_rewrite$
declare
  v_function_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_release_artifact_evidence_valid(text,jsonb)'
  );
  v_definition text;
  v_updated_definition text;
  v_old_identity text := E'      p_evidence ->> ''schema_version'' = ''awardping.stage1.hosted-runtime-identity.v1''\n      and p_evidence ->> ''measurement_method'' = ''direct_no_redirect_https_get_v1''';
  v_new_identity text := E'      p_evidence ->> ''schema_version'' = ''awardping.stage1.hosted-runtime-identity.v2''\n      and p_evidence ->> ''measurement_method'' = ''direct_no_redirect_https_and_vault_profile_get_v2''';
  v_old_tail text := E'      and p_evidence ->> ''auth_response_sha256'' ~ ''^[0-9a-f]{64}$''\n      and nullif(pg_catalog.btrim(p_evidence ->> ''observed_at''), '''') is not null';
  v_new_tail text := E'      and p_evidence ->> ''auth_response_sha256'' ~ ''^[0-9a-f]{64}$''\n      and p_evidence ->> ''vault_profile_url'' =\n        p_evidence ->> ''supabase_origin'' || ''/rest/v1/decrypted_secrets?select=id&limit=1''\n      and p_evidence ->> ''vault_profile_http_status'' = ''406''\n      and p_evidence ->> ''vault_profile_postgrest_code'' = ''PGRST106''\n      and p_evidence ->> ''vault_profile_exposed'' = ''false''\n      and p_evidence ->> ''vault_profile_redirected'' = ''false''\n      and p_evidence ->> ''vault_profile_response_sha256'' ~ ''^[0-9a-f]{64}$''\n      and nullif(pg_catalog.btrim(p_evidence ->> ''observed_at''), '''') is not null';
  v_owner oid;
  v_acl aclitem[];
  v_security_definer boolean;
  v_volatility "char";
  v_proconfig text[];
begin
  if v_function_oid is null then
    raise exception using errcode = '42883',
      message = 'Stage 1 Vault hardening requires the release artifact validator.';
  end if;
  select
    pg_catalog.pg_get_functiondef(procedure.oid), procedure.proowner,
    procedure.proacl, procedure.prosecdef, procedure.provolatile,
    procedure.proconfig
  into
    v_definition, v_owner, v_acl, v_security_definer, v_volatility,
    v_proconfig
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_function_oid;

  if (
    pg_catalog.length(v_definition) -
      pg_catalog.length(pg_catalog.replace(v_definition, v_old_identity, ''))
  ) / pg_catalog.length(v_old_identity) <> 1
    or (
      pg_catalog.length(v_definition) -
        pg_catalog.length(pg_catalog.replace(v_definition, v_old_tail, ''))
    ) / pg_catalog.length(v_old_tail) <> 1
    or pg_catalog.strpos(v_definition, 'vault_profile_postgrest_code') > 0 then
    raise exception using errcode = '55000',
      message = 'Release artifact validator did not match the exact Vault runtime-evidence anchors.';
  end if;

  v_updated_definition := pg_catalog.replace(
    v_definition, v_old_identity, v_new_identity
  );
  v_updated_definition := pg_catalog.replace(
    v_updated_definition, v_old_tail, v_new_tail
  );
  execute v_updated_definition;

  if not exists (
    select 1
    from pg_catalog.pg_proc procedure
    where procedure.oid = v_function_oid
      and procedure.proowner = v_owner
      and procedure.proacl is not distinct from v_acl
      and procedure.prosecdef = v_security_definer
      and procedure.provolatile = v_volatility
      and procedure.proconfig is not distinct from v_proconfig
      and pg_catalog.strpos(
        pg_catalog.pg_get_functiondef(procedure.oid), v_new_identity
      ) > 0
      and pg_catalog.strpos(
        pg_catalog.pg_get_functiondef(procedure.oid), v_new_tail
      ) > 0
  ) then
    raise exception using errcode = '55000',
      message = 'Vault runtime-evidence validator rewrite changed its security contract.';
  end if;
end;
$awardping_stage1_vault_runtime_evidence_rewrite$;

-- Rewrite only the four exact, known anchors in the already composite-safe gate.
-- CREATE OR REPLACE retains the function OID, callers, owner, ACL, and security
-- metadata; the checks below reject definition drift rather than guessing.
do $awardping_stage1_vault_gate_rewrite$
declare
  v_gate_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_release_gate_snapshot(timestamp with time zone)'
  );
  v_definition text;
  v_updated_definition text;
  v_old_declaration text := E'  v_invite_acl_ok boolean := false;\n  v_contract_state_hash text;';
  v_new_declaration text := E'  v_invite_acl_ok boolean := false;\n  v_vault_access_contract_safe boolean := false;\n  v_vault_service_profile_blocked boolean := false;\n  v_contract_state_hash text;';
  v_old_assignment text := '  v_contract_state_hash := private.stage1_release_contract_state_hash();';
  v_new_assignment text := E'  v_vault_access_contract_safe := private.stage1_vault_access_contract_safe();\n  v_vault_service_profile_blocked :=\n    coalesce(v_runtime.evidence ->> ''vault_profile_http_status'', '''') = ''406''\n    and coalesce(v_runtime.evidence ->> ''vault_profile_postgrest_code'', '''') = ''PGRST106''\n    and coalesce(v_runtime.evidence ->> ''vault_profile_exposed'', '''') = ''false''\n    and coalesce(v_runtime.evidence ->> ''vault_profile_redirected'', '''') = ''false'';\n  v_contract_state_hash := private.stage1_release_contract_state_hash();';
  v_old_failure text := E'  if not v_contract_ok or not v_invite_acl_ok then\n    v_failures := pg_catalog.array_append(v_failures, ''invite_only_database_contract_failed'');\n  end if;';
  v_new_failure text := E'  if not v_contract_ok or not v_invite_acl_ok then\n    v_failures := pg_catalog.array_append(v_failures, ''invite_only_database_contract_failed'');\n  end if;\n  if not v_vault_access_contract_safe or not v_vault_service_profile_blocked then\n    v_failures := pg_catalog.array_append(v_failures, ''vault_access_contract_failed'');\n  end if;';
  v_old_basis text := E'      ''disable_signup'', v_runtime.evidence -> ''disable_signup''\n    ),\n    ''nightly'', v_nightly,';
  v_new_basis text := E'      ''disable_signup'', v_runtime.evidence -> ''disable_signup''\n    ),\n    ''vault_security'', pg_catalog.jsonb_build_object(\n      ''api_surface_safe'', v_vault_access_contract_safe,\n      ''service_role_data_api_profile_blocked'', v_vault_service_profile_blocked,\n      ''profile_http_status'', v_runtime.evidence -> ''vault_profile_http_status'',\n      ''profile_postgrest_code'', v_runtime.evidence -> ''vault_profile_postgrest_code''\n    ),\n    ''nightly'', v_nightly,';
  v_anchor text;
  v_anchor_count integer;
  v_owner oid;
  v_acl aclitem[];
  v_security_definer boolean;
  v_volatility "char";
  v_proconfig text[];
begin
  if v_gate_oid is null then
    raise exception using
      errcode = '42883',
      message = 'Stage 1 Vault hardening requires the deployed release gate.';
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

  if pg_catalog.strpos(
      v_definition,
      E'select\n      run as worker_run,\n      run.*,\n      private.stage1_normal_6pm_monitoring_date(run) as monitoring_date,'
    ) = 0
    or pg_catalog.strpos(
      v_definition,
      'private.stage1_6pm_shard_healthy(latest_runs.worker_run)'
    ) = 0
    or pg_catalog.strpos(
      v_definition,
      'private.stage1_6pm_shard_healthy(latest_runs)'
    ) > 0 then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 Vault hardening requires the composite-safe release gate.';
  end if;

  foreach v_anchor in array array[
    v_old_declaration, v_old_assignment, v_old_failure, v_old_basis
  ] loop
    v_anchor_count := (
      pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(v_definition, v_anchor, ''))
    ) / pg_catalog.length(v_anchor);
    if v_anchor_count <> 1 then
      raise exception using
        errcode = '55000',
        message = 'Stage 1 release gate did not match an exact Vault hardening anchor.';
    end if;
  end loop;
  if pg_catalog.strpos(v_definition, v_new_declaration) > 0
    or pg_catalog.strpos(v_definition, 'vault_access_contract_failed') > 0
    or pg_catalog.strpos(v_definition, '''vault_security''') > 0 then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 release gate already contains an unexpected Vault hardening rewrite.';
  end if;

  v_updated_definition := pg_catalog.replace(
    v_definition, v_old_declaration, v_new_declaration
  );
  v_updated_definition := pg_catalog.replace(
    v_updated_definition, v_old_assignment, v_new_assignment
  );
  v_updated_definition := pg_catalog.replace(
    v_updated_definition, v_old_failure, v_new_failure
  );
  v_updated_definition := pg_catalog.replace(
    v_updated_definition, v_old_basis, v_new_basis
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
        pg_catalog.pg_get_functiondef(procedure.oid), v_new_declaration
      ) > 0
      and pg_catalog.strpos(
        pg_catalog.pg_get_functiondef(procedure.oid), v_new_assignment
      ) > 0
      and pg_catalog.strpos(
        pg_catalog.pg_get_functiondef(procedure.oid), v_new_failure
      ) > 0
      and pg_catalog.strpos(
        pg_catalog.pg_get_functiondef(procedure.oid), v_new_basis
      ) > 0
  ) then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 Vault gate rewrite did not preserve its OID, caller, and security contract.';
  end if;
end;
$awardping_stage1_vault_gate_rewrite$;

revoke all on function private.stage1_release_gate_snapshot(timestamptz)
  from public, anon, authenticated, service_role;

do $awardping_stage1_vault_postcondition$
declare
  v_postgres_oid oid := (
    select role.oid from pg_catalog.pg_roles role where role.rolname = 'postgres'
  );
  v_vault_oid oid := pg_catalog.to_regnamespace('vault');
  v_signature text;
  v_function_oid oid;
  v_gate_snapshot jsonb;
  v_gate_definition text;
begin
  if not private.stage1_vault_access_contract_safe() then
    raise exception using
      errcode = '55000',
      message = 'A browser role or an unexpected API-callable RPC retains a Vault access path.';
  end if;

  v_function_oid := pg_catalog.to_regprocedure(
    'private.stage1_vault_access_contract_safe()'
  );
  if v_function_oid is null or not exists (
    select 1
    from pg_catalog.pg_proc procedure
    where procedure.oid = v_function_oid
      and procedure.proowner = v_postgres_oid
      and procedure.prosecdef
      and procedure.provolatile = 's'
      and coalesce('search_path=""' = any(procedure.proconfig), false)
  ) or pg_catalog.has_function_privilege(
    'anon', v_function_oid, 'EXECUTE'
  ) or pg_catalog.has_function_privilege(
    'authenticated', v_function_oid, 'EXECUTE'
  ) or pg_catalog.has_function_privilege(
    'service_role', v_function_oid, 'EXECUTE'
  ) then
    raise exception using
      errcode = '55000',
      message = 'The private effective Vault privilege predicate is not hardened.';
  end if;

  if not pg_catalog.has_schema_privilege('postgres', 'vault', 'USAGE')
    or not pg_catalog.has_table_privilege(
      'postgres', 'vault.decrypted_secrets', 'SELECT'
    ) then
    raise exception using
      errcode = '55000',
      message = 'Vault hardening unexpectedly removed postgres Vault access.';
  end if;

  foreach v_signature in array array[
    'private.stage1_release_artifact_signature_valid(uuid,timestamp with time zone)',
    'private.insert_stage1_external_release_artifact(text,text,text,text,text,text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)'
  ] loop
    v_function_oid := pg_catalog.to_regprocedure(v_signature);
    if v_function_oid is null or not exists (
      select 1
      from pg_catalog.pg_proc procedure
      where procedure.oid = v_function_oid
        and procedure.proowner = v_postgres_oid
        and procedure.prosecdef
        and coalesce('search_path=""' = any(procedure.proconfig), false)
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          'Stage 1 Vault reader %s lost its postgres SECURITY DEFINER contract.',
          v_signature
        );
    end if;
  end loop;

  foreach v_signature in array array[
    'public.record_stage1_hosted_runtime_identity_artifact(text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
    'public.record_stage1_rollback_drill_artifact(text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
    'public.record_stage1_non_cohort_leak_crawl_artifact(text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
    'public.record_stage1_r2_recovery_drill_artifact(text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
    'public.get_stage1_release_gate_snapshot()',
    'public.activate_stage1_release_from_acceptance(uuid,text,text,text)'
  ] loop
    v_function_oid := pg_catalog.to_regprocedure(v_signature);
    if v_function_oid is null or not exists (
      select 1
      from pg_catalog.pg_proc procedure
      where procedure.oid = v_function_oid
        and procedure.proowner = v_postgres_oid
        and procedure.prosecdef
        and coalesce('search_path=""' = any(procedure.proconfig), false)
    ) or not pg_catalog.has_function_privilege(
      'service_role', v_function_oid, 'EXECUTE'
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          'Stage 1 public SECURITY DEFINER entrypoint %s is no longer callable by service_role.',
          v_signature
        );
    end if;
  end loop;

  select pg_catalog.pg_get_functiondef(procedure.oid)
  into v_gate_definition
  from pg_catalog.pg_proc procedure
  where procedure.oid = pg_catalog.to_regprocedure(
    'private.stage1_release_gate_snapshot(timestamp with time zone)'
  );
  if pg_catalog.strpos(
      v_gate_definition,
      'v_vault_access_contract_safe := private.stage1_vault_access_contract_safe()'
    ) = 0
    or pg_catalog.strpos(
      v_gate_definition, 'vault_access_contract_failed'
    ) = 0
    or pg_catalog.strpos(v_gate_definition, '''vault_security''') = 0
    or pg_catalog.has_function_privilege(
      'anon',
      'private.stage1_release_gate_snapshot(timestamp with time zone)',
      'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'authenticated',
      'private.stage1_release_gate_snapshot(timestamp with time zone)',
      'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'service_role',
      'private.stage1_release_gate_snapshot(timestamp with time zone)',
      'EXECUTE'
    ) then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 release gate is not bound to the effective Vault privilege predicate.';
  end if;

  v_gate_snapshot := private.stage1_release_gate_snapshot(
    pg_catalog.clock_timestamp()
  );
  if coalesce(
      v_gate_snapshot #>> '{vault_security,api_surface_safe}', ''
    ) <> 'true'
    or coalesce(
      v_gate_snapshot #>> '{vault_security,service_role_data_api_profile_blocked}',
      ''
    ) not in ('true', 'false')
    or (
      v_gate_snapshot #>>
        '{vault_security,service_role_data_api_profile_blocked}' = 'false'
      and (
        coalesce(v_gate_snapshot ->> 'state', '') <> 'HOLD'
        or not coalesce(v_gate_snapshot -> 'failures', '[]'::jsonb)
          @> '["vault_access_contract_failed"]'::jsonb
      )
    )
    or coalesce(v_gate_snapshot ->> 'state', '') not in ('HOLD', 'READY')
    or coalesce(v_gate_snapshot ->> 'state_hash', '') !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 release gate did not sign the enforceable Vault access contract.';
  end if;
end;
$awardping_stage1_vault_postcondition$;
