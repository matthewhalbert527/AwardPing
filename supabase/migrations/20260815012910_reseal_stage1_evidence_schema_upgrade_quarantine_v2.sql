-- Forward-only reseal for the Stage 1 evidence-schema-upgrade quarantine.
-- Migration 20260814211159 is already deployed and remains immutable. Its v1
-- audit rows stay valid, while all new RPC submissions must use the reviewed
-- v2 manifest with canonical cohort-key, award-UUID, and award-name bindings.

do $reseal_quarantine_rpc$
declare
  v_signature constant text :=
    'public.quarantine_stage1_evidence_schema_upgrade_failure(uuid,uuid,uuid,text,jsonb)';
  v_old_manifest_sha256 constant text :=
    'f2a16adec57b3a66c3e467599bbf962cf02c94d1f6ded1daf5db09bf980c0184';
  v_new_manifest_sha256 constant text :=
    '42241673b1acf00b22f5e47f7a5fa1368ad0237ba9c4795a05541941ec2209c4';
  v_old_manifest_schema constant text :=
    'awardping.stage1.reviewed-source-capture-allowlist.v1';
  v_new_manifest_schema constant text :=
    'awardping.stage1.reviewed-source-capture-allowlist.v2';
  v_old_policy_sha256 constant text :=
    '1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c';
  v_new_policy_sha256 constant text :=
    '917076584e316b4412d998ad820111046c1caf89f492012ed5061513ed7eef37';
  v_old_policy_predicate constant text :=
    $contract$v_policy ->> 'policy_version' is distinct from '1'$contract$;
  v_new_policy_predicate constant text :=
    $contract$v_policy ->> 'policy_version' is distinct from '2'$contract$;
  v_old_registry_binding constant text := $contract$'awardping-stage1-evidence-schema-upgrade-quarantine',
    '1',
    '1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c'$contract$;
  v_new_registry_binding constant text := $contract$'awardping-stage1-evidence-schema-upgrade-quarantine',
    '2',
    '917076584e316b4412d998ad820111046c1caf89f492012ed5061513ed7eef37'$contract$;
  v_expected_old_definition_sha256 constant text :=
    'c68e74dc235fd4f74e38d6d9460f64567355a040bf27186b36aa857df2dcd1c8';
  v_expected_new_definition_sha256 constant text :=
    'b0859cb4807b2a914800105154bf508be308fb1aa6943a10fb1b42b3b340083f';
  v_function_oid oid := pg_catalog.to_regprocedure(v_signature);
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
  v_definition text;
  v_updated text;
  v_reversed text;
  v_before_contract jsonb;
  v_after_contract jsonb;
  v_actual_sha256 text;
begin
  if v_function_oid is null
    or v_service_role_oid is null
    or pg_catalog.to_regprocedure('extensions.digest(bytea,text)') is null
  then
    raise exception using errcode = '55000',
      message = 'The exact deployed quarantine RPC or SHA-256 prerequisite is missing.';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc target
    join pg_catalog.pg_namespace namespace
      on namespace.oid = target.pronamespace
    where namespace.nspname = 'public'
      and target.proname = 'quarantine_stage1_evidence_schema_upgrade_failure'
  ) <> 1 then
    raise exception using errcode = '55000',
      message = 'The Stage 1 evidence-schema-upgrade quarantine RPC has an unexpected overload.';
  end if;

  select
    pg_catalog.jsonb_build_object(
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
    ),
    pg_catalog.pg_get_functiondef(target.oid)
  into strict v_before_contract, v_definition
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

  v_actual_sha256 := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_definition, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_actual_sha256 is distinct from v_expected_old_definition_sha256 then
    raise exception using errcode = '55000',
      message = 'The deployed quarantine RPC differs from the reviewed v1 definition.';
  end if;

  if (
      pg_catalog.length(v_definition) - pg_catalog.length(
        pg_catalog.replace(v_definition, v_old_manifest_sha256, '')
      )
    ) / pg_catalog.length(v_old_manifest_sha256) <> 1
    or (
      pg_catalog.length(v_definition) - pg_catalog.length(
        pg_catalog.replace(v_definition, v_old_manifest_schema, '')
      )
    ) / pg_catalog.length(v_old_manifest_schema) <> 1
    or (
      pg_catalog.length(v_definition) - pg_catalog.length(
        pg_catalog.replace(v_definition, v_old_policy_sha256, '')
      )
    ) / pg_catalog.length(v_old_policy_sha256) <> 2
    or (
      pg_catalog.length(v_definition) - pg_catalog.length(
        pg_catalog.replace(v_definition, v_old_policy_predicate, '')
      )
    ) / pg_catalog.length(v_old_policy_predicate) <> 1
    or (
      pg_catalog.length(v_definition) - pg_catalog.length(
        pg_catalog.replace(v_definition, v_old_registry_binding, '')
      )
    ) / pg_catalog.length(v_old_registry_binding) <> 1
  then
    raise exception using errcode = '55000',
      message = 'The deployed quarantine RPC has ambiguous v1 reseal anchors.';
  end if;

  v_updated := pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(
            v_definition,
            v_old_registry_binding,
            v_new_registry_binding
          ),
          v_old_policy_predicate,
          v_new_policy_predicate
        ),
        v_old_manifest_sha256,
        v_new_manifest_sha256
      ),
      v_old_manifest_schema,
      v_new_manifest_schema
    ),
    v_old_policy_sha256,
    v_new_policy_sha256
  );

  v_reversed := pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(
            v_updated,
            v_new_registry_binding,
            v_old_registry_binding
          ),
          v_new_policy_predicate,
          v_old_policy_predicate
        ),
        v_new_manifest_sha256,
        v_old_manifest_sha256
      ),
      v_new_manifest_schema,
      v_old_manifest_schema
    ),
    v_new_policy_sha256,
    v_old_policy_sha256
  );

  if v_updated = v_definition or v_reversed is distinct from v_definition then
    raise exception using errcode = '55000',
      message = 'The exact reversible quarantine RPC v2 reseal delta could not be proven.';
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

  v_actual_sha256 := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.pg_get_functiondef(v_function_oid),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  if v_after_contract is distinct from v_before_contract
    or pg_catalog.pg_get_functiondef(v_function_oid) is distinct from v_updated
    or v_actual_sha256 is distinct from v_expected_new_definition_sha256
  then
    raise exception using errcode = '55000',
      message = 'The quarantine RPC v2 reseal changed more than its exact reviewed body delta.';
  end if;
end;
$reseal_quarantine_rpc$;

do $expand_failure_hash_constraint$
declare
  v_constraint_oid oid;
  v_definition text;
  v_expected_old_definition_sha256 constant text :=
    '9d4af6ce2b907640379d13d58e657e257d7f165805614999109b302045dbec47';
  v_actual_sha256 text;
  v_failure_count bigint;
begin
  if pg_catalog.to_regprocedure('extensions.digest(bytea,text)') is null then
    raise exception using errcode = '55000',
      message = 'The SHA-256 prerequisite for the quarantine constraint reseal is missing.';
  end if;

  lock table private.stage1_evidence_schema_upgrade_failures
    in access exclusive mode;

  select target.oid, pg_catalog.pg_get_constraintdef(target.oid, true)
  into strict v_constraint_oid, v_definition
  from pg_catalog.pg_constraint target
  where target.conrelid =
      'private.stage1_evidence_schema_upgrade_failures'::regclass
    and target.conname =
      'stage1_evidence_schema_upgrade_failure_hash_check'
    and target.contype = 'c'
    and target.convalidated
    and not target.connoinherit;

  v_actual_sha256 := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_definition, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_actual_sha256 is distinct from v_expected_old_definition_sha256 then
    raise exception using errcode = '55000',
      message = 'The deployed quarantine audit hash constraint differs from the reviewed v1 definition.';
  end if;

  select pg_catalog.count(*) into strict v_failure_count
  from private.stage1_evidence_schema_upgrade_failures;

  alter table private.stage1_evidence_schema_upgrade_failures
    drop constraint stage1_evidence_schema_upgrade_failure_hash_check;

  alter table private.stage1_evidence_schema_upgrade_failures
    add constraint stage1_evidence_schema_upgrade_failure_hash_check check (
      failure_sha256 ~ '^[0-9a-f]{64}$'
      and submitted_evidence_sha256 ~ '^[0-9a-f]{64}$'
      and disposition_item_sha256 ~ '^[0-9a-f]{64}$'
      and finalization_receipt_sha256 ~ '^[0-9a-f]{64}$'
      and (
        (
          manifest_sha256 =
            'f2a16adec57b3a66c3e467599bbf962cf02c94d1f6ded1daf5db09bf980c0184'
          and policy_sha256 =
            '1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c'
        )
        or (
          manifest_sha256 =
            '42241673b1acf00b22f5e47f7a5fa1368ad0237ba9c4795a05541941ec2209c4'
          and policy_sha256 =
            '917076584e316b4412d998ad820111046c1caf89f492012ed5061513ed7eef37'
        )
      )
      and reason_code ~ '^[a-z0-9][a-z0-9_]{1,159}$'
      and failure_stage ~ '^[a-z0-9][a-z0-9_]{1,159}$'
      and pg_catalog.jsonb_typeof(evidence) = 'object'
      and evidence ->> 'evidence_sha256' = submitted_evidence_sha256
    ) not valid;

  alter table private.stage1_evidence_schema_upgrade_failures
    validate constraint stage1_evidence_schema_upgrade_failure_hash_check;

  select target.oid, pg_catalog.pg_get_constraintdef(target.oid, true)
  into strict v_constraint_oid, v_definition
  from pg_catalog.pg_constraint target
  where target.conrelid =
      'private.stage1_evidence_schema_upgrade_failures'::regclass
    and target.conname =
      'stage1_evidence_schema_upgrade_failure_hash_check'
    and target.contype = 'c'
    and target.convalidated
    and not target.connoinherit;

  if (
      pg_catalog.length(v_definition) - pg_catalog.length(
        pg_catalog.replace(
          v_definition,
          'f2a16adec57b3a66c3e467599bbf962cf02c94d1f6ded1daf5db09bf980c0184',
          ''
        )
      )
    ) / 64 <> 1
    or (
      pg_catalog.length(v_definition) - pg_catalog.length(
        pg_catalog.replace(
          v_definition,
          '1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c',
          ''
        )
      )
    ) / 64 <> 1
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
    ) / 64 <> 1
    or (
      select pg_catalog.count(*)
      from private.stage1_evidence_schema_upgrade_failures
    ) <> v_failure_count
  then
    raise exception using errcode = '55000',
      message = 'The quarantine audit constraint did not preserve exactly the paired v1/v2 history contract.';
  end if;
end;
$expand_failure_hash_constraint$;
