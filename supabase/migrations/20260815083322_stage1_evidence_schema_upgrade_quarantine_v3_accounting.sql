-- Forward-only Stage 1 evidence-schema-upgrade quarantine accounting evolution.
-- The already-applied v1 and v2 migrations remain immutable. Existing paired
-- audit seals stay valid, while new submissions use policy v3 and accept only
-- the exact legacy-four or current-six pointer-commit accounting contracts.

do $reseal_quarantine_rpc$
declare
  v_signature constant text :=
    'public.quarantine_stage1_evidence_schema_upgrade_failure(uuid,uuid,uuid,text,jsonb)';
  v_manifest_sha256 constant text :=
    '42241673b1acf00b22f5e47f7a5fa1368ad0237ba9c4795a05541941ec2209c4';
  v_old_policy_sha256 constant text :=
    '917076584e316b4412d998ad820111046c1caf89f492012ed5061513ed7eef37';
  v_new_policy_sha256 constant text :=
    '5b544eae051e4ed8313aec2a253a5f7795b351b4536869dbddae41138eb79fb6';
  v_old_policy_predicate constant text :=
    $contract$v_policy ->> 'policy_version' is distinct from '2'$contract$;
  v_new_policy_predicate constant text :=
    $contract$v_policy ->> 'policy_version' is distinct from '3'$contract$;
  v_old_registry_binding constant text := $contract$'awardping-stage1-evidence-schema-upgrade-quarantine',
    '2',
    '917076584e316b4412d998ad820111046c1caf89f492012ed5061513ed7eef37'$contract$;
  v_new_registry_binding constant text := $contract$'awardping-stage1-evidence-schema-upgrade-quarantine',
    '3',
    '5b544eae051e4ed8313aec2a253a5f7795b351b4536869dbddae41138eb79fb6'$contract$;
  v_old_accounting_contract constant text := $contract$        or private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_pointer_accounting_evidence,
          array['boundary', 'cas', 'journal_phase', 'response_loss_possible']
        ) is not true
        or nullif(pg_catalog.btrim(
          v_pointer_accounting_evidence ->> 'boundary'
        ), '') is null
        or v_pointer_accounting_evidence ->> 'journal_phase' is distinct from
          v_pointer_commit_receipt ->> 'journal_phase'
        or v_pointer_accounting_evidence -> 'response_loss_possible'
          is distinct from pg_catalog.to_jsonb(
            not coalesce((v_mutation_accounting ->> 'exact')::boolean, false)
          )
        or v_pointer_accounting_evidence -> 'cas' is distinct from
          v_pointer_receipt_cas$contract$;
  v_new_accounting_contract constant text := $contract$        or not (
          private.stage1_evidence_schema_upgrade_has_exact_keys(
            v_pointer_accounting_evidence,
            array['boundary', 'cas', 'journal_phase', 'response_loss_possible']
          ) is true
          or (
            private.stage1_evidence_schema_upgrade_has_exact_keys(
              v_pointer_accounting_evidence,
              array[
                'boundary',
                'cas',
                'journal_archive',
                'journal_persistence',
                'journal_phase',
                'response_loss_possible'
              ]
            ) is true
            and private.stage1_evidence_schema_upgrade_has_exact_keys(
              v_pointer_accounting_evidence -> 'journal_persistence',
              array[
                'local_journal_writes_lower_bound',
                'response_loss_possible',
                'state'
              ]
            ) is true
            and pg_catalog.jsonb_typeof(
              v_pointer_accounting_evidence #> array[
                'journal_persistence', 'local_journal_writes_lower_bound'
              ]
            ) = 'number'
            and pg_catalog.scale((v_pointer_accounting_evidence #>> array[
              'journal_persistence', 'local_journal_writes_lower_bound'
            ])::numeric) = 0
            and (v_pointer_accounting_evidence #>> array[
              'journal_persistence', 'local_journal_writes_lower_bound'
            ])::numeric between 0 and 9007199254740991
            and pg_catalog.jsonb_typeof(
              v_pointer_accounting_evidence #> array[
                'journal_persistence', 'response_loss_possible'
              ]
            ) = 'boolean'
            and pg_catalog.jsonb_typeof(
              v_pointer_accounting_evidence #> array[
                'journal_persistence', 'state'
              ]
            ) = 'string'
            and (
              (
                v_pointer_accounting_evidence #>> array[
                  'journal_persistence', 'state'
                ] = 'not_started'
                and v_pointer_accounting_evidence #> array[
                  'journal_persistence', 'local_journal_writes_lower_bound'
                ] = '0'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_persistence', 'response_loss_possible'
                ] = 'false'::jsonb
              )
              or (
                v_pointer_accounting_evidence #>> array[
                  'journal_persistence', 'state'
                ] in ('write_in_flight', 'write_response_unknown')
                and v_pointer_accounting_evidence #> array[
                  'journal_persistence', 'local_journal_writes_lower_bound'
                ] = '0'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_persistence', 'response_loss_possible'
                ] = 'true'::jsonb
              )
              or (
                v_pointer_accounting_evidence #>> array[
                  'journal_persistence', 'state'
                ] in (
                  'write_acknowledged_readback_pending',
                  'write_acknowledged_readback_unverified',
                  'verified'
                )
                and (v_pointer_accounting_evidence #>> array[
                  'journal_persistence', 'local_journal_writes_lower_bound'
                ])::numeric >= 1
                and v_pointer_accounting_evidence #> array[
                  'journal_persistence', 'response_loss_possible'
                ] = 'false'::jsonb
              )
            )
            and v_pointer_accounting_evidence #>> array[
              'journal_persistence', 'state'
            ] in ('not_started', 'verified')
            and private.stage1_evidence_schema_upgrade_has_exact_keys(
              v_pointer_accounting_evidence -> 'journal_archive',
              array[
                'active_absence_verified',
                'archive_receipt_acknowledged',
                'archived_readback_verified',
                'evidence_sha256',
                'local_journal_archive_writes_lower_bound',
                'response_loss_possible',
                'schema_version',
                'state'
              ]
            ) is true
            and v_pointer_accounting_evidence #>> array[
              'journal_archive', 'schema_version'
            ] =
              'awardping.stage1.evidence-schema-upgrade-journal-archive-accounting.v1'
            and coalesce(v_pointer_accounting_evidence #>> array[
              'journal_archive', 'evidence_sha256'
            ], '') ~ '^[0-9a-f]{64}$'
            and v_pointer_accounting_evidence #>> array[
              'journal_archive', 'evidence_sha256'
            ] = private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
              (v_pointer_accounting_evidence -> 'journal_archive') -
                'evidence_sha256'
            )
            and pg_catalog.jsonb_typeof(
              v_pointer_accounting_evidence #> array[
                'journal_archive', 'local_journal_archive_writes_lower_bound'
              ]
            ) = 'number'
            and pg_catalog.scale((v_pointer_accounting_evidence #>> array[
              'journal_archive', 'local_journal_archive_writes_lower_bound'
            ])::numeric) = 0
            and (v_pointer_accounting_evidence #>> array[
              'journal_archive', 'local_journal_archive_writes_lower_bound'
            ])::numeric between 0 and 9007199254740991
            and not exists (
              select 1
              from (values
                ('active_absence_verified'),
                ('archive_receipt_acknowledged'),
                ('archived_readback_verified'),
                ('response_loss_possible')
              ) flags(field_name)
              where pg_catalog.jsonb_typeof(
                (v_pointer_accounting_evidence -> 'journal_archive') ->
                  flags.field_name
              ) <> 'boolean'
            )
            and pg_catalog.jsonb_typeof(
              v_pointer_accounting_evidence #> array[
                'journal_archive', 'state'
              ]
            ) = 'string'
            and (
              (
                v_pointer_accounting_evidence #>> array[
                  'journal_archive', 'state'
                ] = 'not_started'
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'local_journal_archive_writes_lower_bound'
                ] = '0'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'archive_receipt_acknowledged'
                ] = 'false'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'archived_readback_verified'
                ] = 'false'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'active_absence_verified'
                ] = 'false'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'response_loss_possible'
                ] = 'false'::jsonb
              )
              or (
                v_pointer_accounting_evidence #>> array[
                  'journal_archive', 'state'
                ] in (
                  'archive_write_in_flight',
                  'archive_write_response_unknown',
                  'archive_receipt_unverified'
                )
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'local_journal_archive_writes_lower_bound'
                ] = '0'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'archive_receipt_acknowledged'
                ] = 'false'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'archived_readback_verified'
                ] = 'false'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'active_absence_verified'
                ] = 'false'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'response_loss_possible'
                ] = 'true'::jsonb
              )
              or (
                v_pointer_accounting_evidence #>> array[
                  'journal_archive', 'state'
                ] in (
                  'archive_write_acknowledged_readback_pending',
                  'archive_write_acknowledged_readback_unverified'
                )
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'local_journal_archive_writes_lower_bound'
                ] = '1'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'archive_receipt_acknowledged'
                ] = 'true'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'archived_readback_verified'
                ] = 'false'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'active_absence_verified'
                ] = 'false'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'response_loss_possible'
                ] = 'true'::jsonb
              )
              or (
                v_pointer_accounting_evidence #>> array[
                  'journal_archive', 'state'
                ] in (
                  'archived_readback_verified_active_absence_pending',
                  'archived_readback_verified_active_absence_response_unknown'
                )
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'local_journal_archive_writes_lower_bound'
                ] = '1'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'archive_receipt_acknowledged'
                ] = 'true'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'archived_readback_verified'
                ] = 'true'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'active_absence_verified'
                ] = 'false'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'response_loss_possible'
                ] = 'true'::jsonb
              )
              or (
                v_pointer_accounting_evidence #>> array[
                  'journal_archive', 'state'
                ] = 'archived_readback_verified_active_still_present'
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'local_journal_archive_writes_lower_bound'
                ] = '1'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'archive_receipt_acknowledged'
                ] = 'true'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'archived_readback_verified'
                ] = 'true'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'active_absence_verified'
                ] = 'false'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'response_loss_possible'
                ] = 'false'::jsonb
              )
              or (
                v_pointer_accounting_evidence #>> array[
                  'journal_archive', 'state'
                ] = 'verified'
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'local_journal_archive_writes_lower_bound'
                ] = '1'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'archive_receipt_acknowledged'
                ] = 'true'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'archived_readback_verified'
                ] = 'true'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'active_absence_verified'
                ] = 'true'::jsonb
                and v_pointer_accounting_evidence #> array[
                  'journal_archive', 'response_loss_possible'
                ] = 'false'::jsonb
              )
            )
            and v_pointer_accounting_evidence #>> array[
              'journal_archive', 'state'
            ] = 'not_started'
          )
        )
        or nullif(pg_catalog.btrim(
          v_pointer_accounting_evidence ->> 'boundary'
        ), '') is null
        or v_pointer_accounting_evidence ->> 'journal_phase' is distinct from
          v_pointer_commit_receipt ->> 'journal_phase'
        or v_pointer_accounting_evidence -> 'response_loss_possible'
          is distinct from pg_catalog.to_jsonb(
            not coalesce((v_mutation_accounting ->> 'exact')::boolean, false)
            or (
              private.stage1_evidence_schema_upgrade_has_exact_keys(
                v_pointer_accounting_evidence,
                array[
                  'boundary',
                  'cas',
                  'journal_archive',
                  'journal_persistence',
                  'journal_phase',
                  'response_loss_possible'
                ]
              ) is true
              and (
                v_pointer_accounting_evidence #> array[
                  'journal_persistence', 'response_loss_possible'
                ] = 'true'::jsonb
                or v_pointer_accounting_evidence #> array[
                  'journal_archive', 'response_loss_possible'
                ] = 'true'::jsonb
              )
            )
          )
        or v_pointer_accounting_evidence -> 'cas' is distinct from
          v_pointer_receipt_cas$contract$;
  v_expected_old_definition_sha256 constant text :=
    'b0859cb4807b2a914800105154bf508be308fb1aa6943a10fb1b42b3b340083f';
  v_expected_new_definition_sha256 constant text :=
    'cc18feb9a5ebfbd82cf113f31d9f9955e5fccb625ca8c7fb94d47940abf4d666';
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
      message = 'The exact deployed quarantine v2 RPC or SHA-256 prerequisite is missing.';
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
      message = 'The deployed quarantine RPC differs from the reviewed v2 definition.';
  end if;

  if (
      pg_catalog.length(v_definition) - pg_catalog.length(
        pg_catalog.replace(v_definition, v_manifest_sha256, '')
      )
    ) / pg_catalog.length(v_manifest_sha256) <> 1
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
    or (
      pg_catalog.length(v_definition) - pg_catalog.length(
        pg_catalog.replace(v_definition, v_old_accounting_contract, '')
      )
    ) / pg_catalog.length(v_old_accounting_contract) <> 1
  then
    raise exception using errcode = '55000',
      message = 'The deployed quarantine RPC has ambiguous v2 accounting-policy anchors.';
  end if;

  v_updated := pg_catalog.replace(
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
      v_old_policy_sha256,
      v_new_policy_sha256
    ),
    v_old_accounting_contract,
    v_new_accounting_contract
  );

  v_reversed := pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.replace(
        pg_catalog.replace(
          v_updated,
          v_new_accounting_contract,
          v_old_accounting_contract
        ),
        v_new_registry_binding,
        v_old_registry_binding
      ),
      v_new_policy_predicate,
      v_old_policy_predicate
    ),
    v_new_policy_sha256,
    v_old_policy_sha256
  );

  if v_updated = v_definition or v_reversed is distinct from v_definition then
    raise exception using errcode = '55000',
      message = 'The exact reversible quarantine RPC v3 accounting delta could not be proven.';
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
      message = 'The quarantine RPC v3 reseal changed more than its exact reviewed body delta.';
  end if;
end;
$reseal_quarantine_rpc$;

do $expand_failure_hash_constraint$
declare
  v_constraint_oid oid;
  v_definition text;
  v_expected_old_definition_sha256 constant text :=
    '7d0a76947a366e94a74857903986618b101f1b26bd204d6668b0872bed0771a6';
  v_expected_new_definition_sha256 constant text :=
    '82bfc427d568cb7ddedcd56d9ef8fa16dd61c769395f9a30e5466c0e387160c6';
  v_actual_sha256 text;
  v_failure_count bigint;
begin
  if pg_catalog.to_regprocedure('extensions.digest(bytea,text)') is null then
    raise exception using errcode = '55000',
      message = 'The SHA-256 prerequisite for the quarantine v3 constraint is missing.';
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
      message = 'The deployed quarantine audit hash constraint differs from paired v1/v2 history.';
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
        or (
          manifest_sha256 =
            '42241673b1acf00b22f5e47f7a5fa1368ad0237ba9c4795a05541941ec2209c4'
          and policy_sha256 =
            '5b544eae051e4ed8313aec2a253a5f7795b351b4536869dbddae41138eb79fb6'
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

  v_actual_sha256 := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_definition, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_actual_sha256 is distinct from v_expected_new_definition_sha256
    or (
      select pg_catalog.count(*)
      from private.stage1_evidence_schema_upgrade_failures
    ) <> v_failure_count
  then
    raise exception using errcode = '55000',
      message = 'The quarantine audit constraint did not preserve exactly paired v1/v2 history plus v3.';
  end if;
end;
$expand_failure_hash_constraint$;
