-- Read-only smoke for the forward-only Stage 1 quarantine v2 reseal.
-- It proves the exact new body seal, paired v1/v2 audit-history constraint,
-- and unchanged service-role-only execution boundary without application rows.

do $catalog_smoke$
declare
  v_function_oid oid := pg_catalog.to_regprocedure(
    'public.quarantine_stage1_evidence_schema_upgrade_failure(uuid,uuid,uuid,text,jsonb)'
  );
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
  v_definition text;
  v_constraint_definition text;
  v_definition_sha256 text;
begin
  if v_function_oid is null
    or v_service_role_oid is null
    or pg_catalog.to_regprocedure('extensions.digest(bytea,text)') is null
  then
    raise exception
      'The Stage 1 quarantine v2 reseal catalog or SHA-256 prerequisite is incomplete.';
  end if;

  select pg_catalog.pg_get_functiondef(target.oid)
  into strict v_definition
  from pg_catalog.pg_proc target
  where target.oid = v_function_oid
    and pg_catalog.pg_get_userbyid(target.proowner) = 'postgres'
    and target.prokind = 'f'
    and target.provolatile = 'v'
    and not target.prosecdef
    and not target.proleakproof
    and target.proconfig is not distinct from array['search_path=""']::text[]
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
    );

  v_definition_sha256 := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_definition, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_definition_sha256 <>
      'b0859cb4807b2a914800105154bf508be308fb1aa6943a10fb1b42b3b340083f'
    or (
      pg_catalog.length(v_definition) - pg_catalog.length(
        pg_catalog.replace(
          v_definition,
          '42241673b1acf00b22f5e47f7a5fa1368ad0237ba9c4795a05541941ec2209c4',
          ''
        )
      )
    ) / 64 <> 1
    or (
      pg_catalog.length(v_definition) - pg_catalog.length(
        pg_catalog.replace(
          v_definition,
          '917076584e316b4412d998ad820111046c1caf89f492012ed5061513ed7eef37',
          ''
        )
      )
    ) / 64 <> 2
    or (
      pg_catalog.length(v_definition) - pg_catalog.length(
        pg_catalog.replace(
          v_definition,
          'awardping.stage1.reviewed-source-capture-allowlist.v2',
          ''
        )
      )
    ) / pg_catalog.length(
      'awardping.stage1.reviewed-source-capture-allowlist.v2'
    ) <> 1
    or pg_catalog.strpos(
      v_definition,
      $contract$v_policy ->> 'policy_version' is distinct from '2'$contract$
    ) = 0
    or pg_catalog.strpos(
      v_definition,
      $contract$'awardping-stage1-evidence-schema-upgrade-quarantine',
    '2',
    '917076584e316b4412d998ad820111046c1caf89f492012ed5061513ed7eef37'$contract$
    ) = 0
    or pg_catalog.strpos(
      v_definition,
      'f2a16adec57b3a66c3e467599bbf962cf02c94d1f6ded1daf5db09bf980c0184'
    ) > 0
    or pg_catalog.strpos(
      v_definition,
      '1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c'
    ) > 0
    or pg_catalog.strpos(
      v_definition,
      'awardping.stage1.reviewed-source-capture-allowlist.v1'
    ) > 0
  then
    raise exception
      'The Stage 1 quarantine RPC does not have the exact canonical-identity v2 seal.';
  end if;

  select pg_catalog.pg_get_constraintdef(target.oid, true)
  into strict v_constraint_definition
  from pg_catalog.pg_constraint target
  where target.conrelid =
      'private.stage1_evidence_schema_upgrade_failures'::regclass
    and target.conname =
      'stage1_evidence_schema_upgrade_failure_hash_check'
    and target.contype = 'c'
    and target.convalidated
    and not target.connoinherit;

  if (
      pg_catalog.length(v_constraint_definition) - pg_catalog.length(
        pg_catalog.replace(
          v_constraint_definition,
          'f2a16adec57b3a66c3e467599bbf962cf02c94d1f6ded1daf5db09bf980c0184',
          ''
        )
      )
    ) / 64 <> 1
    or (
      pg_catalog.length(v_constraint_definition) - pg_catalog.length(
        pg_catalog.replace(
          v_constraint_definition,
          '1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c',
          ''
        )
      )
    ) / 64 <> 1
    or (
      pg_catalog.length(v_constraint_definition) - pg_catalog.length(
        pg_catalog.replace(
          v_constraint_definition,
          '42241673b1acf00b22f5e47f7a5fa1368ad0237ba9c4795a05541941ec2209c4',
          ''
        )
      )
    ) / 64 <> 1
    or (
      pg_catalog.length(v_constraint_definition) - pg_catalog.length(
        pg_catalog.replace(
          v_constraint_definition,
          '917076584e316b4412d998ad820111046c1caf89f492012ed5061513ed7eef37',
          ''
        )
      )
    ) / 64 <> 1
  then
    raise exception
      'The Stage 1 quarantine audit does not preserve exactly one paired v1/v2 hash contract.';
  end if;
end;
$catalog_smoke$;

set role anon;
do $anon_denied$
declare
  v_denied boolean := false;
begin
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      null::uuid, null::uuid, null::uuid, null::text, null::jsonb
    );
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'The anon role invoked the Stage 1 quarantine v2 RPC.';
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
      null::uuid, null::uuid, null::uuid, null::text, null::jsonb
    );
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception
      'The authenticated role invoked the Stage 1 quarantine v2 RPC.';
  end if;
end;
$authenticated_denied$;
reset role;

set role service_role;
do $service_role_boundary$
declare
  v_reached_validation boolean := false;
begin
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      null::uuid, null::uuid, null::uuid, null::text, null::jsonb
    );
  exception when sqlstate '22023' then
    v_reached_validation := true;
  end;
  if not v_reached_validation then
    raise exception
      'The service role did not reach the Stage 1 quarantine v2 validation boundary.';
  end if;
end;
$service_role_boundary$;
reset role;
