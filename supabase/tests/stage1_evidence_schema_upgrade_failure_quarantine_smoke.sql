-- Read-only smoke for the service-role-only Stage 1 evidence-schema-upgrade
-- failure quarantine. Positive mutation semantics run only inside the
-- dedicated rollback probe; this standalone smoke proves ACLs, function entry,
-- immutable audit permissions, and exact zero-delta rejection behavior.

do $catalog_smoke$
declare
  v_function_oid oid := pg_catalog.to_regprocedure(
    'public.quarantine_stage1_evidence_schema_upgrade_failure(uuid,uuid,uuid,text,jsonb)'
  );
  v_hash_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_evidence_schema_upgrade_quarantine_json_sha256(jsonb)'
  );
  v_domain_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(jsonb)'
  );
  v_base64_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_evidence_schema_upgrade_quarantine_base64_sha256(text)'
  );
  v_exact_keys_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_evidence_schema_upgrade_has_exact_keys(jsonb,text[])'
  );
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
begin
  if v_function_oid is null
    or v_hash_oid is null
    or v_domain_oid is null
    or v_base64_oid is null
    or v_exact_keys_oid is null
    or v_service_role_oid is null
  then
    raise exception
      'The Stage 1 evidence-schema-upgrade quarantine catalog is incomplete.';
  end if;

  if not exists (
      select 1
      from pg_catalog.pg_proc target
      where target.oid = v_function_oid
        and pg_catalog.pg_get_userbyid(target.proowner) = 'postgres'
        and target.prokind = 'f'
        and target.provolatile = 'v'
        and not target.prosecdef
        and not target.proleakproof
        and target.proconfig is not distinct from
          array['search_path=""']::text[]
        and pg_catalog.has_function_privilege(
          'service_role', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'anon', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated', target.oid, 'EXECUTE'
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
    )
  then
    raise exception
      'The Stage 1 evidence-schema-upgrade quarantine RPC owner, invoker security, search path, volatility, or ACL drifted.';
  end if;

  if not exists (
      select 1
      from pg_catalog.pg_proc target
      join pg_catalog.pg_namespace namespace
        on namespace.oid = target.pronamespace
      where target.oid = v_hash_oid
        and namespace.nspname = 'private'
        and pg_catalog.pg_get_userbyid(target.proowner) = 'postgres'
        and target.prosecdef
        and target.proconfig is not distinct from
          array['search_path=""']::text[]
        and pg_catalog.has_function_privilege(
          'service_role', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'anon', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated', target.oid, 'EXECUTE'
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
    )
  then
    raise exception
      'The private canonical-seal verifier is not narrowly service-role bound.';
  end if;

  if not exists (
      select 1
      from pg_catalog.pg_proc target
      where target.oid = v_domain_oid
        and pg_catalog.pg_get_userbyid(target.proowner) = 'postgres'
        and target.provolatile = 'i'
        and not target.prosecdef
        and target.proconfig is not distinct from
          array['search_path=""']::text[]
        and pg_catalog.has_function_privilege(
          'service_role', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'anon', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated', target.oid, 'EXECUTE'
        )
    )
    or not exists (
      select 1
      from pg_catalog.pg_proc target
      where target.oid = v_base64_oid
        and pg_catalog.pg_get_userbyid(target.proowner) = 'postgres'
        and target.prosecdef
        and target.proconfig is not distinct from
          array['search_path=""']::text[]
        and pg_catalog.has_function_privilege(
          'service_role', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'anon', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated', target.oid, 'EXECUTE'
        )
    )
    or not exists (
      select 1
      from pg_catalog.pg_proc target
      join pg_catalog.pg_namespace namespace
        on namespace.oid = target.pronamespace
      where target.oid = v_exact_keys_oid
        and namespace.nspname = 'private'
        and pg_catalog.pg_get_userbyid(target.proowner) = 'postgres'
        and target.provolatile = 'i'
        and not target.prosecdef
        and target.proconfig is not distinct from
          array['search_path=""']::text[]
        and pg_catalog.pg_get_function_identity_arguments(target.oid) =
          'p_value jsonb, p_keys text[]'
        and pg_catalog.has_function_privilege(
          'service_role', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'anon', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated', target.oid, 'EXECUTE'
        )
    )
    or exists (
      select 1
      from pg_catalog.pg_proc target
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          target.proacl,
          pg_catalog.acldefault('f', target.proowner)
        )
      ) privilege
      where target.oid = any(array[
          v_domain_oid,
          v_base64_oid,
          v_exact_keys_oid
        ]::oid[])
        and (
          privilege.grantee = 0
          or privilege.grantee not in (
            target.proowner,
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
      'The quarantine canonical-domain, exact-key, or base64-seal helper ACL drifted.';
  end if;

  if not pg_catalog.has_table_privilege(
      'service_role',
      'private.stage1_evidence_schema_upgrade_failures',
      'SELECT,INSERT'
    )
    or pg_catalog.has_table_privilege(
      'service_role',
      'private.stage1_evidence_schema_upgrade_failures',
      'UPDATE'
    )
    or pg_catalog.has_table_privilege(
      'service_role',
      'private.stage1_evidence_schema_upgrade_failures',
      'DELETE'
    )
    or pg_catalog.has_table_privilege(
      'service_role',
      'private.stage1_evidence_schema_upgrade_failures',
      'TRUNCATE'
    )
    or not exists (
      select 1
      from pg_catalog.pg_policy policy
      where policy.polrelid =
          'private.stage1_evidence_schema_upgrade_failures'::regclass
        and policy.polcmd = 'r'
        and v_service_role_oid = any(policy.polroles)
    )
    or not exists (
      select 1
      from pg_catalog.pg_policy policy
      where policy.polrelid =
          'private.stage1_evidence_schema_upgrade_failures'::regclass
        and policy.polcmd = 'a'
        and v_service_role_oid = any(policy.polroles)
    )
    or not exists (
      select 1
      from pg_catalog.pg_trigger trigger
      where trigger.tgrelid =
          'private.stage1_evidence_schema_upgrade_failures'::regclass
        and trigger.tgname =
          'prevent_stage1_evidence_schema_upgrade_failure_mutation'
        and not trigger.tgisinternal
    )
  then
    raise exception
      'The Stage 1 evidence-schema-upgrade failure audit is not append-only with narrow service-role access.';
  end if;
end;
$catalog_smoke$;

do $zero_delta_before$
begin
  create temporary table awardping_stage1_upgrade_quarantine_smoke_baseline
  as
  select
    (
      select pg_catalog.count(*)
      from private.stage1_evidence_schema_upgrade_failures
    ) as failure_count,
    (
      select pg_catalog.count(*)
      from public.manual_quarantine_registry quarantine
      where quarantine.quarantine_key like
        'stage1:evidence-schema-upgrade:%'
    ) as quarantine_count,
    private.stage1_canonical_json_sha256(
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(source)
          order by source.id
        )
        from public.shared_award_sources source
        where source.id = any(array[
          'c30778fe-43d7-57be-842a-e046d84baaee'::uuid,
          '2ea41875-5c88-5794-81b3-afa8ddaf31c1'::uuid,
          'af1367b5-0cb0-5b21-8e78-7dc195dd996f'::uuid,
          'b9407ce4-71f8-5c97-8f98-8466d640d4de'::uuid,
          '5ec9a453-fd62-53e5-b885-726b21ce7247'::uuid,
          'fa4088a7-706e-4ad3-ae12-3653751dd5e1'::uuid,
          '664d38ba-c717-5d51-b7ce-9e3a27f41fec'::uuid,
          '719ffd9e-f97c-5c6d-8a5a-71b617cadf49'::uuid,
          'c28878c0-6a8b-5fa8-b99b-ec826b86d8f2'::uuid
        ])
      ), '[]'::jsonb)
    ) as source_state_sha256;
end;
$zero_delta_before$;

set role anon;
do $anon_denied$
declare
  v_denied boolean := false;
begin
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000002'::uuid,
      '00000000-0000-4000-8000-000000000003'::uuid,
      'invalid_evidence',
      '{}'::jsonb
    );
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception
      'The anon role invoked the Stage 1 evidence-schema-upgrade quarantine RPC.';
  end if;
end;
$anon_denied$;
reset role;

set role authenticated;
do $authenticated_denied$
declare
  v_denied boolean := false;
begin
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000002'::uuid,
      '00000000-0000-4000-8000-000000000003'::uuid,
      'invalid_evidence',
      '{}'::jsonb
    );
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception
      'The authenticated role invoked the Stage 1 evidence-schema-upgrade quarantine RPC.';
  end if;
end;
$authenticated_denied$;
reset role;

set role service_role;
do $canonical_domain_smoke$
begin
  if private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(
      '{"ascii_key":[null,true,"Évidence",9007199254740991]}'::jsonb
    ) is not true
    or private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(
      '{"fractional":0.0000001}'::jsonb
    ) is not false
    or private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(
      '{"scaled_integer":1.0}'::jsonb
    ) is not false
    or private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(
      '{"évidence":true}'::jsonb
    ) is not false
    or private.stage1_evidence_schema_upgrade_quarantine_base64_sha256(
      'Y2Fub25pY2Fs'
    ) is distinct from
      '0deeb8fa1dbbee4c0dbe7f5e3c9183940139f26d22797ee8ab07c00557a4c2ff'
  then
    raise exception
      'The cross-language canonical JSON/base64 hash domain drifted.';
  end if;
end;
$canonical_domain_smoke$;

do $service_role_enters_validator$
declare
  v_rejected boolean := false;
begin
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000002'::uuid,
      '00000000-0000-4000-8000-000000000003'::uuid,
      'invalid_evidence',
      '{}'::jsonb
    );
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception
      'The service role did not reach the exact quarantine evidence validator.';
  end if;
end;
$service_role_enters_validator$;
reset role;

do $zero_delta_after$
declare
  v_before awardping_stage1_upgrade_quarantine_smoke_baseline%rowtype;
  v_after awardping_stage1_upgrade_quarantine_smoke_baseline%rowtype;
begin
  select * into strict v_before
  from awardping_stage1_upgrade_quarantine_smoke_baseline;

  select
    (
      select pg_catalog.count(*)
      from private.stage1_evidence_schema_upgrade_failures
    ),
    (
      select pg_catalog.count(*)
      from public.manual_quarantine_registry quarantine
      where quarantine.quarantine_key like
        'stage1:evidence-schema-upgrade:%'
    ),
    private.stage1_canonical_json_sha256(
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(source)
          order by source.id
        )
        from public.shared_award_sources source
        where source.id = any(array[
          'c30778fe-43d7-57be-842a-e046d84baaee'::uuid,
          '2ea41875-5c88-5794-81b3-afa8ddaf31c1'::uuid,
          'af1367b5-0cb0-5b21-8e78-7dc195dd996f'::uuid,
          'b9407ce4-71f8-5c97-8f98-8466d640d4de'::uuid,
          '5ec9a453-fd62-53e5-b885-726b21ce7247'::uuid,
          'fa4088a7-706e-4ad3-ae12-3653751dd5e1'::uuid,
          '664d38ba-c717-5d51-b7ce-9e3a27f41fec'::uuid,
          '719ffd9e-f97c-5c6d-8a5a-71b617cadf49'::uuid,
          'c28878c0-6a8b-5fa8-b99b-ec826b86d8f2'::uuid
        ])
      ), '[]'::jsonb)
    )
  into v_after;

  if v_after is distinct from v_before then
    raise exception
      'Rejected Stage 1 evidence-schema-upgrade quarantine calls changed application state.';
  end if;
end;
$zero_delta_after$;

drop table awardping_stage1_upgrade_quarantine_smoke_baseline;
