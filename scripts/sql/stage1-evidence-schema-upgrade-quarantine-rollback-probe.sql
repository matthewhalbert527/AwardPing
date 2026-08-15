-- This file is a template. Execute it only through
--   node scripts/run-stage1-evidence-schema-upgrade-quarantine-rollback-probe.mjs
-- It requires all earlier migrations, applies only the exact target migration,
-- exercises two distinct failures plus one exact service-role replay inside a
-- transaction,
-- and verifies complete rollback of schema and application state.

begin;

create temporary table awardping_stage1_upgrade_quarantine_probe_baseline (
  required_prior_versions text[] not null,
  target_catalog_contract jsonb not null,
  source_id uuid not null,
  acquisition_id uuid not null,
  request_id uuid not null,
  disposition_item_sha256 text not null,
  finalization_receipt_sha256 text not null,
  guard_sha256 text not null,
  manifest_item integer not null,
  source_before jsonb not null,
  reviewed_other_sources_sha256 text not null,
  registry_without_target_sha256 text not null,
  application_counts jsonb not null
) on commit preserve rows;

create function pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
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
      message =
        'Stage 1 evidence-schema-upgrade quarantine rollback probe failed: ' ||
        p_message;
  end if;
end;
$$;

create function pg_temp.awardping_stage1_upgrade_quarantine_catalog_contract()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'functions', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'schema', namespace.nspname,
          'name', target.proname,
          'definition', pg_catalog.pg_get_functiondef(target.oid),
          'owner_oid', target.proowner::text,
          'acl', pg_catalog.to_jsonb(target.proacl),
          'config', pg_catalog.to_jsonb(target.proconfig),
          'volatility', target.provolatile::text,
          'security_definer', target.prosecdef,
          'identity_arguments',
            pg_catalog.pg_get_function_identity_arguments(target.oid),
          'result', pg_catalog.pg_get_function_result(target.oid),
          'comment', pg_catalog.obj_description(target.oid, 'pg_proc')
        )
        order by namespace.nspname, target.proname, target.oid
      )
      from pg_catalog.pg_proc target
      join pg_catalog.pg_namespace namespace
        on namespace.oid = target.pronamespace
      where (
        namespace.nspname = 'public'
        and target.proname =
          'quarantine_stage1_evidence_schema_upgrade_failure'
      ) or (
        namespace.nspname = 'private'
        and target.proname in (
          'stage1_evidence_schema_upgrade_quarantine_base64_sha256',
          'stage1_evidence_schema_upgrade_quarantine_json_domain_valid',
          'stage1_evidence_schema_upgrade_quarantine_json_sha256',
          'stage1_evidence_schema_upgrade_has_exact_keys'
        )
      )
    ), '[]'::jsonb),
    'relations', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'schema', namespace.nspname,
          'name', target.relname,
          'kind', target.relkind::text,
          'owner_oid', target.relowner::text,
          'acl', pg_catalog.to_jsonb(target.relacl),
          'rls', target.relrowsecurity,
          'force_rls', target.relforcerowsecurity
        )
        order by namespace.nspname, target.relname
      )
      from pg_catalog.pg_class target
      join pg_catalog.pg_namespace namespace
        on namespace.oid = target.relnamespace
      where namespace.nspname = 'private'
        and target.relname like 'stage1_evidence_schema_upgrade_failures%'
    ), '[]'::jsonb),
    'policies', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(policy)
        order by policy.schemaname, policy.tablename, policy.policyname
      )
      from pg_catalog.pg_policies policy
      where policy.schemaname = 'private'
        and policy.tablename = 'stage1_evidence_schema_upgrade_failures'
    ), '[]'::jsonb),
    'triggers', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'name', target.tgname,
          'definition', pg_catalog.pg_get_triggerdef(target.oid)
        )
        order by target.tgname
      )
      from pg_catalog.pg_trigger target
      where target.tgrelid = pg_catalog.to_regclass(
          'private.stage1_evidence_schema_upgrade_failures'
        )
        and not target.tgisinternal
    ), '[]'::jsonb)
  )
$$;

do $preflight$
declare
  v_required_prior_versions text[] :=
-- __AWARDPING_EXACT_PRIOR_MIGRATION_VERSIONS__
  ;
  v_missing_prior_versions text[];
  v_target_version constant text := '20260814211159';
  v_source_id uuid;
  v_acquisition_id uuid;
  v_request_id uuid;
  v_disposition_item_sha256 text;
  v_finalization_receipt_sha256 text;
  v_guard_sha256 text;
  v_manifest_item integer;
  v_source_before jsonb;
begin
  select pg_catalog.array_agg(required.version order by required.version)
  into v_missing_prior_versions
  from pg_catalog.unnest(v_required_prior_versions) required(version)
  where not exists (
    select 1
    from supabase_migrations.schema_migrations migration
    where migration.version = required.version
  );

  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    coalesce(pg_catalog.cardinality(v_missing_prior_versions), 0) = 0,
    'one or more prior repository migrations are not recorded as applied'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = v_target_version
    ),
    'migration 20260814211159 is already recorded as applied'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    pg_catalog.to_regclass(
      'private.stage1_source_baseline_activation_finalizations'
    ) is not null
      and pg_catalog.to_regclass('public.manual_quarantine_registry') is not null
      and pg_catalog.to_regprocedure(
        'private.stage1_canonical_json_sha256(jsonb)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.get_stage1_source_activation_finalizations(uuid[])'
      ) is not null,
    'a required Stage 1 finalization, quarantine, hashing, or getter dependency is missing'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    pg_catalog.to_regclass(
      'private.stage1_evidence_schema_upgrade_failures'
    ) is null
      and pg_catalog.to_regprocedure(
        'public.quarantine_stage1_evidence_schema_upgrade_failure(uuid,uuid,uuid,text,jsonb)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_schema_upgrade_quarantine_base64_sha256(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(jsonb)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_schema_upgrade_quarantine_json_sha256(jsonb)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_schema_upgrade_has_exact_keys(jsonb,text[])'
      ) is null
      and pg_temp.awardping_stage1_upgrade_quarantine_catalog_contract() =
        pg_catalog.jsonb_build_object(
          'functions', '[]'::jsonb,
          'relations', '[]'::jsonb,
          'policies', '[]'::jsonb,
          'triggers', '[]'::jsonb
        ),
    'the target quarantine migration already exists or has drifted objects'
  );

  select
    source.id,
    acquisition.id,
    acquisition.origin_source_page_request_id,
    finalized.disposition_item_sha256,
    finalized.finalization_receipt_sha256,
    finalized.guard_sha256,
    item.item_number,
    pg_catalog.to_jsonb(source)
  into
    v_source_id,
    v_acquisition_id,
    v_request_id,
    v_disposition_item_sha256,
    v_finalization_receipt_sha256,
    v_guard_sha256,
    v_manifest_item,
    v_source_before
  from private.stage1_source_baseline_activation_finalizations finalized
  join public.shared_award_sources source
    on source.id = finalized.shared_award_source_id
  join public.shared_award_source_acquisitions acquisition
    on acquisition.id = finalized.source_acquisition_id
  join private.stage1_source_disposition_items item
    on item.decision_item_sha256 = finalized.disposition_item_sha256
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
    and source.admin_review_status = 'open'
    and source.admin_review_note = 'exact_first_visual_baseline_verified'
    and source.admin_reviewed_by = 'stage1-baseline-activation-receipt'
    and item.decision = 'approve_baseline_only'
    and source.id = 'c30778fe-43d7-57be-842a-e046d84baaee'::uuid
    and exists (
      select 1
      from public.stage1_award_source_manifest manifest
      where source.id = any(manifest.source_ids)
    )
  order by source.id
  limit 1;

  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_source_id is not null,
    'no exact finalized reviewed-nine source is available for the rollback-only positive smoke'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    not exists (
      select 1
      from public.manual_quarantine_registry quarantine
      where quarantine.quarantine_key like
        'stage1:evidence-schema-upgrade:%'
    ),
    'a target-namespace quarantine exists before its migration'
  );

  insert into pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline (
    required_prior_versions,
    target_catalog_contract,
    source_id,
    acquisition_id,
    request_id,
    disposition_item_sha256,
    finalization_receipt_sha256,
    guard_sha256,
    manifest_item,
    source_before,
    reviewed_other_sources_sha256,
    registry_without_target_sha256,
    application_counts
  ) values (
    v_required_prior_versions,
    pg_temp.awardping_stage1_upgrade_quarantine_catalog_contract(),
    v_source_id,
    v_acquisition_id,
    v_request_id,
    v_disposition_item_sha256,
    v_finalization_receipt_sha256,
    v_guard_sha256,
    v_manifest_item,
    v_source_before,
    private.stage1_canonical_json_sha256(coalesce((
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
        and source.id <> v_source_id
    ), '[]'::jsonb)),
    private.stage1_canonical_json_sha256(coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(quarantine)
        order by quarantine.id
      )
      from public.manual_quarantine_registry quarantine
      where quarantine.quarantine_key not like
        'stage1:evidence-schema-upgrade:%'
    ), '[]'::jsonb)),
    pg_catalog.jsonb_build_object(
      'change_events', (select pg_catalog.count(*) from public.shared_award_change_events),
      'visual_candidates', (select pg_catalog.count(*) from public.shared_award_visual_review_candidates),
      'spend_days', (select pg_catalog.count(*) from public.gemini_spend_days),
      'spend_reservations', (select pg_catalog.count(*) from public.gemini_spend_reservations),
      'spend_events', (select pg_catalog.count(*) from public.gemini_spend_events),
      'stage1_publication_events',
        (select pg_catalog.count(*) from public.stage1_award_publication_events),
      'stage1_release_events',
        (select pg_catalog.count(*) from public.stage1_publication_release_events),
      'quarantine_events',
        (select pg_catalog.count(*) from public.manual_quarantine_registry_events),
      'backlog_revision', coalesce((
        select state.revision
        from public.manual_quarantine_backlog_state state
        where state.state_key = 'operator_backlog'
      ), 0),
      'stage1_award_registry_sha256', private.stage1_canonical_json_sha256(
        coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(registry) order by registry.cohort_key
          )
          from public.stage1_award_registry registry
        ), '[]'::jsonb)
      ),
      'stage1_release_state_sha256', private.stage1_canonical_json_sha256(
        coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(state) order by state.release_key
          )
          from public.stage1_publication_release_state state
        ), '[]'::jsonb)
      ),
      'manual_backlog_state_sha256', private.stage1_canonical_json_sha256(
        coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(state) order by state.state_key
          )
          from public.manual_quarantine_backlog_state state
        ), '[]'::jsonb)
      )
    )
  );
end;
$preflight$;

commit;

-- MIGRATION TRANSACTION START
begin isolation level repeatable read;

-- __AWARDPING_EXACT_MIGRATION__

-- __AWARDPING_EXACT_SMOKE__

create temporary table awardping_stage1_upgrade_quarantine_javascript_evidence (
  scenario text primary key,
  evidence jsonb not null
) on commit drop;

insert into pg_temp.awardping_stage1_upgrade_quarantine_javascript_evidence (
  scenario,
  evidence
)
select entry.key, entry.value
from pg_catalog.jsonb_each(
-- __AWARDPING_EXACT_JAVASCRIPT_EVIDENCE_JSON__
) entry(key, value);

do $javascript_evidence_hash_parity$
declare
  v_scenario text;
  v_evidence jsonb;
begin
  for v_scenario, v_evidence in
    select fixture.scenario, fixture.evidence
    from pg_temp.awardping_stage1_upgrade_quarantine_javascript_evidence fixture
    order by fixture.scenario
  loop
    perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(
      v_evidence
    )
      and v_evidence ->> 'evidence_sha256' =
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_evidence - 'evidence_sha256'
        )
      and v_evidence ->> 'validation_sha256' =
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_evidence -> 'validation'
        )
      and v_evidence ->> 'manifest_sha256' =
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_evidence -> 'manifest'
        )
      and v_evidence ->> 'policy_sha256' =
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_evidence -> 'policy'
        )
      and (
        (
          v_evidence -> 'candidate_artifacts' = 'null'::jsonb
          and v_evidence -> 'candidate_artifacts_sha256' = 'null'::jsonb
        )
        or (
          v_evidence ->> 'candidate_artifacts_sha256' =
            private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
              v_evidence -> 'candidate_artifacts'
            )
          and v_evidence #>> array[
            'candidate_artifacts', 'candidate_pointer_identity',
            'canonical_sha256'
          ] = private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
            v_evidence #> array[
              'candidate_artifacts', 'candidate_pointer_identity', 'projection'
            ]
          )
        )
      )
      and (
        (
          v_evidence -> 'commit_recovery' = 'null'::jsonb
          and v_evidence -> 'commit_recovery_sha256' = 'null'::jsonb
        )
        or (
          v_evidence ->> 'commit_recovery_sha256' =
            private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
              v_evidence -> 'commit_recovery'
            )
          and v_evidence #>> array[
            'commit_recovery', 'journal', 'journal_sha256'
          ] = private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
            (v_evidence #> array['commit_recovery', 'journal']) -
              'journal_sha256'
          )
          and v_evidence #>> array[
            'commit_recovery', 'journal', 'candidate_baseline', 'sha256'
          ] = private.stage1_evidence_schema_upgrade_quarantine_base64_sha256(
            v_evidence #>> array[
              'commit_recovery', 'journal', 'candidate_baseline', 'bytes_base64'
            ]
          )
        )
      )
      and v_evidence #>> array[
        'validation', 'evidence', 'safe_integer_boundary'
      ] = '9007199254740991'
      and nullif(pg_catalog.btrim(v_evidence ->> 'detail'), '') is not null,
      'the exact JavaScript-helper ' || v_scenario ||
        ' evidence did not retain PostgreSQL canonical hash parity'
    );
  end loop;
end;
$javascript_evidence_hash_parity$;

create temporary table awardping_stage1_upgrade_quarantine_positive_baseline
on commit drop
as
select
  private.stage1_canonical_json_sha256(coalesce((
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
      and source.id <> (
        select baseline.source_id
        from pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline baseline
      )
  ), '[]'::jsonb)) as reviewed_other_sources_sha256,
  private.stage1_canonical_json_sha256(coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(quarantine)
      order by quarantine.id
    )
    from public.manual_quarantine_registry quarantine
    where quarantine.quarantine_key not like
      'stage1:evidence-schema-upgrade:%'
  ), '[]'::jsonb)) as registry_without_target_sha256,
  pg_catalog.jsonb_build_object(
    'change_events', (select pg_catalog.count(*) from public.shared_award_change_events),
    'visual_candidates', (select pg_catalog.count(*) from public.shared_award_visual_review_candidates),
    'spend_days', (select pg_catalog.count(*) from public.gemini_spend_days),
    'spend_reservations', (select pg_catalog.count(*) from public.gemini_spend_reservations),
    'spend_events', (select pg_catalog.count(*) from public.gemini_spend_events),
    'stage1_publication_events',
      (select pg_catalog.count(*) from public.stage1_award_publication_events),
    'stage1_release_events',
      (select pg_catalog.count(*) from public.stage1_publication_release_events),
    'quarantine_events',
      (select pg_catalog.count(*) from public.manual_quarantine_registry_events),
    'backlog_revision', coalesce((
      select state.revision
      from public.manual_quarantine_backlog_state state
      where state.state_key = 'operator_backlog'
    ), 0)
  ) as zero_charge_counts;

create temporary table awardping_stage1_upgrade_quarantine_fixture (
  invocation integer primary key,
  source_id uuid not null,
  acquisition_id uuid not null,
  request_id uuid not null,
  reason_code text not null,
  evidence jsonb not null
) on commit drop;

create temporary table awardping_stage1_upgrade_quarantine_receipts (
  invocation integer primary key,
  receipt jsonb not null
) on commit drop;

do $build_positive_fixture$
declare
  v_baseline pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline%rowtype;
  v_manifest jsonb :=
-- __AWARDPING_EXACT_MANIFEST_JSON__
  ;
  v_policy jsonb;
  v_mutation_accounting jsonb;
  v_validation jsonb;
  v_evidence jsonb;
  v_validation_second jsonb;
  v_evidence_second jsonb;
  v_journal_template jsonb;
  v_same_journal_template jsonb;
  v_absent_template jsonb;
  v_capture_absent_template jsonb;
  v_candidate_template jsonb;
  v_evidence_journal jsonb;
  v_evidence_same_journal jsonb;
  v_evidence_absent jsonb;
  v_evidence_capture_absent jsonb;
begin
  select * into strict v_baseline
  from pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline;

  v_policy := pg_catalog.jsonb_build_object(
    'schema_version',
      'awardping.stage1.evidence-schema-upgrade-quarantine-policy.v1',
    'policy_id', 'awardping-stage1-evidence-schema-upgrade-quarantine',
    'policy_version', '1',
    'context', 'stage1_evidence_schema_upgrade',
    'manifest_sha256',
      'f2a16adec57b3a66c3e467599bbf962cf02c94d1f6ded1daf5db09bf980c0184',
    'reviewed_source_count', 9,
    'creates_api_charge', false,
    'public_fact_authority', false
  );
  v_mutation_accounting := pg_catalog.jsonb_build_object(
    'schema_version',
      'awardping.stage1.evidence-schema-upgrade-mutation-accounting.v1',
    'operation', 'candidate_enqueue',
    'count_semantics', 'confirmed_lower_bounds',
    'exact', true,
    'lower_bound_counts', pg_catalog.jsonb_build_object(
      'candidate_writes', 1,
      'database_writes', 1,
      'local_baseline_writes', 0,
      'quarantine_writes', 0,
      'r2_writes', 0,
      'source_state_writes', 0
    ),
    'unknown_write_categories', '[]'::jsonb,
    'evidence', pg_catalog.jsonb_build_object(
      'boundary', 'rollback_probe_candidate_observation_committed',
      'candidate_signature', pg_catalog.repeat('e', 64),
      'response_loss_possible', false
    )
  );
  v_mutation_accounting := v_mutation_accounting ||
    pg_catalog.jsonb_build_object(
      'accounting_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_mutation_accounting
        )
    );
  select fixture.evidence into strict v_journal_template
  from pg_temp.awardping_stage1_upgrade_quarantine_javascript_evidence fixture
  where fixture.scenario = 'changed';
  select fixture.evidence into strict v_same_journal_template
  from pg_temp.awardping_stage1_upgrade_quarantine_javascript_evidence fixture
  where fixture.scenario = 'same';
  select fixture.evidence into strict v_absent_template
  from pg_temp.awardping_stage1_upgrade_quarantine_javascript_evidence fixture
  where fixture.scenario = 'absent';
  select fixture.evidence into strict v_capture_absent_template
  from pg_temp.awardping_stage1_upgrade_quarantine_javascript_evidence fixture
  where fixture.scenario = 'capture_absent';
  v_candidate_template := pg_catalog.jsonb_set(
    v_journal_template -> 'candidate_artifacts',
    array['journal_sha256'],
    'null'::jsonb
  );
  v_validation := pg_catalog.jsonb_build_object(
    'schema_version',
      'awardping.stage1.evidence-schema-upgrade-validation.v1',
    'decision', 'material_difference_candidate',
    'creates_api_charge', false,
    'reason', 'probe_evidence_failure',
    'reasons', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'code', 'probe_evidence_failure',
        'detail', 'Rollback-only exact-delta fixture.'
      )
    ),
    'evidence', pg_catalog.jsonb_build_object(
      'source_id', v_baseline.source_id,
      'probe_only', true,
      'kind', v_candidate_template ->> 'kind',
      'capture', pg_catalog.jsonb_build_object(
        'source_id', v_baseline.source_id,
        'captured_at', v_candidate_template ->> 'captured_at',
        'text_hash', v_candidate_template #> array[
          'candidate_pointer_identity', 'projection',
          'latest_hashes', 'text_hash'
        ],
        'image_hash', v_candidate_template #> array[
          'candidate_pointer_identity', 'projection',
          'latest_hashes', 'image_hash'
        ],
        'file_hash', v_candidate_template #> array[
          'candidate_pointer_identity', 'projection',
          'latest_hashes', 'file_hash'
        ],
        'layout_hash', v_candidate_template #> array[
          'candidate_pointer_identity', 'projection',
          'latest_hashes', 'layout_hash'
        ]
      ),
      'mutation_failure', pg_catalog.jsonb_build_object(
        'operation', 'candidate_enqueue',
        'error', pg_catalog.jsonb_build_object(
          'name', 'Error',
          'code', 'rollback_probe_candidate_response_lost',
          'message', 'Rollback-probe candidate response was lost.'
        ),
        'mutation_accounting', v_mutation_accounting
      ),
      'journal_read_unavailable', pg_catalog.jsonb_build_object(
        'status', 'unavailable',
        'error', pg_catalog.jsonb_build_object(
          'name', 'FilesystemError',
          'code', 'EACCES',
          'message', 'Rollback-probe active journal read was unavailable.'
        )
      )
    ),
    'outcome', pg_catalog.jsonb_build_object(
      'would_commit', false,
      'would_queue_visual_candidate', true,
      'would_quarantine', false,
      'creates_api_charge', false
    )
  );
  v_evidence := pg_catalog.jsonb_build_object(
    'schema_version',
      'awardping.stage1.evidence-schema-upgrade-quarantine-evidence.v1',
    'source_binding', pg_catalog.jsonb_build_object(
      'source_id', v_baseline.source_id,
      'source_acquisition_id', v_baseline.acquisition_id,
      'source_page_request_id', v_baseline.request_id,
      'manifest_item', v_baseline.manifest_item,
      'guard_sha256', v_baseline.guard_sha256,
      'disposition_item_sha256', v_baseline.disposition_item_sha256,
      'finalization_receipt_sha256',
        v_baseline.finalization_receipt_sha256
    ),
    'manifest', v_manifest,
    'manifest_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_manifest),
    'policy', v_policy,
    'policy_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_policy),
    'failure_stage', 'candidate_enqueue',
    'reason_code', 'probe_evidence_failure',
    'detail', 'Rollback-only exact-delta fixture.',
    'safe_action',
      'Keep this source quarantined. Repair access to the durable upgrade journal, obtain and validate its exact fresh state, and reconcile any active journal before any new capture or retry. Also reconcile the exact visual-review candidate signature '
        || pg_catalog.repeat('e', 64)
        || ' and its current terminal/observation state before any retry; do not enqueue a duplicate.',
    'validation', v_validation,
    'validation_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_validation),
    'r2_binding', null,
    'r2_binding_sha256', null,
    'commit_recovery', null,
    'commit_recovery_sha256', null,
    'candidate_artifacts', v_candidate_template,
    'candidate_artifacts_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_candidate_template
      ),
    'evidence_availability', pg_catalog.jsonb_build_object(
      'validation', pg_catalog.jsonb_build_object(
        'status', 'sealed_present',
        'at_failure_stage', 'candidate_enqueue',
        'unavailable_reason', null
      ),
      'r2_binding', pg_catalog.jsonb_build_object(
        'status', 'not_observed',
        'at_failure_stage', 'candidate_enqueue',
        'unavailable_reason', 'r2_binding_not_observed_before_failure'
      ),
      'commit_recovery', pg_catalog.jsonb_build_object(
        'status', 'unavailable',
        'at_failure_stage', 'candidate_enqueue',
        'unavailable_reason',
          'durable_upgrade_journal_read_unavailable'
      ),
      'candidate_artifacts', pg_catalog.jsonb_build_object(
        'status', 'sealed_present',
        'at_failure_stage', 'candidate_enqueue',
        'unavailable_reason', null
      )
    ),
    'creates_api_charge', false,
    'public_fact_authority', false,
    'public_award_update_created', false
  );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );

  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_manifest) =
      'f2a16adec57b3a66c3e467599bbf962cf02c94d1f6ded1daf5db09bf980c0184',
    'the rendered reviewed-nine manifest digest drifted'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_policy) =
      '1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c',
    'the rollback-only quarantine policy digest drifted'
  );

  v_validation_second := v_validation || pg_catalog.jsonb_build_object(
    'reason', 'probe_second_evidence_failure',
    'reasons', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'code', 'probe_second_evidence_failure',
        'detail', 'Rollback-only second exact-delta fixture.'
      )
    )
  );
  v_evidence_second := (v_evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'reason_code', 'probe_second_evidence_failure',
      'detail', 'Rollback-only second exact-delta fixture.',
      'validation', v_validation_second,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation_second
        )
    );
  v_evidence_second := v_evidence_second || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_evidence_second
      )
  );

  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_baseline.source_id =
      (v_journal_template #>> array[
        'source_binding', 'source_id'
      ])::uuid
      and v_journal_template #>> array[
        'candidate_artifacts', 'source_id'
      ] = v_baseline.source_id::text
      and v_journal_template #>> array[
        'commit_recovery', 'journal', 'source_id'
      ] = v_baseline.source_id::text,
    'the JavaScript active-journal fixture is not bound to the selected source'
  );
  v_evidence_journal := (v_journal_template - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'source_binding', pg_catalog.jsonb_build_object(
        'source_id', v_baseline.source_id,
        'source_acquisition_id', v_baseline.acquisition_id,
        'source_page_request_id', v_baseline.request_id,
        'manifest_item', v_baseline.manifest_item,
        'guard_sha256', v_baseline.guard_sha256,
        'disposition_item_sha256', v_baseline.disposition_item_sha256,
        'finalization_receipt_sha256',
          v_baseline.finalization_receipt_sha256
      )
    );
  v_evidence_journal := v_evidence_journal || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_evidence_journal
      )
  );
  v_evidence_same_journal :=
    (v_same_journal_template - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'source_binding', pg_catalog.jsonb_build_object(
        'source_id', v_baseline.source_id,
        'source_acquisition_id', v_baseline.acquisition_id,
        'source_page_request_id', v_baseline.request_id,
        'manifest_item', v_baseline.manifest_item,
        'guard_sha256', v_baseline.guard_sha256,
        'disposition_item_sha256', v_baseline.disposition_item_sha256,
        'finalization_receipt_sha256',
          v_baseline.finalization_receipt_sha256
      )
    );
  v_evidence_same_journal := v_evidence_same_journal ||
    pg_catalog.jsonb_build_object(
      'evidence_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_evidence_same_journal
        )
    );
  v_evidence_absent := (v_absent_template - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'source_binding', pg_catalog.jsonb_build_object(
        'source_id', v_baseline.source_id,
        'source_acquisition_id', v_baseline.acquisition_id,
        'source_page_request_id', v_baseline.request_id,
        'manifest_item', v_baseline.manifest_item,
        'guard_sha256', v_baseline.guard_sha256,
        'disposition_item_sha256', v_baseline.disposition_item_sha256,
        'finalization_receipt_sha256',
          v_baseline.finalization_receipt_sha256
      )
    );
  v_evidence_absent := v_evidence_absent || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_evidence_absent
      )
  );
  v_evidence_capture_absent :=
    (v_capture_absent_template - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'source_binding', pg_catalog.jsonb_build_object(
        'source_id', v_baseline.source_id,
        'source_acquisition_id', v_baseline.acquisition_id,
        'source_page_request_id', v_baseline.request_id,
        'manifest_item', v_baseline.manifest_item,
        'guard_sha256', v_baseline.guard_sha256,
        'disposition_item_sha256', v_baseline.disposition_item_sha256,
        'finalization_receipt_sha256',
          v_baseline.finalization_receipt_sha256
      )
    );
  v_evidence_capture_absent := v_evidence_capture_absent ||
    pg_catalog.jsonb_build_object(
      'evidence_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_evidence_capture_absent
        )
    );

  insert into pg_temp.awardping_stage1_upgrade_quarantine_fixture (
    invocation,
    source_id,
    acquisition_id,
    request_id,
    reason_code,
    evidence
  ) values (
    1,
    v_baseline.source_id,
    v_baseline.acquisition_id,
    v_baseline.request_id,
    'probe_evidence_failure',
    v_evidence
  ), (
    2,
    v_baseline.source_id,
    v_baseline.acquisition_id,
    v_baseline.request_id,
    'probe_second_evidence_failure',
    v_evidence_second
  ), (
    3,
    v_baseline.source_id,
    v_baseline.acquisition_id,
    v_baseline.request_id,
    v_evidence_journal ->> 'reason_code',
    v_evidence_journal
  ), (
    4,
    v_baseline.source_id,
    v_baseline.acquisition_id,
    v_baseline.request_id,
    v_evidence_same_journal ->> 'reason_code',
    v_evidence_same_journal
  ), (
    5,
    v_baseline.source_id,
    v_baseline.acquisition_id,
    v_baseline.request_id,
    v_evidence_absent ->> 'reason_code',
    v_evidence_absent
  ), (
    6,
    v_baseline.source_id,
    v_baseline.acquisition_id,
    v_baseline.request_id,
    v_evidence_capture_absent ->> 'reason_code',
    v_evidence_capture_absent
  );
end;
$build_positive_fixture$;

grant select on table
  pg_temp.awardping_stage1_upgrade_quarantine_fixture
to service_role;
grant select, insert on table
  pg_temp.awardping_stage1_upgrade_quarantine_receipts
to service_role;

do $prepare_finalization_timestamp_drift$
declare
  v_baseline pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline%rowtype;
  v_source_after jsonb;
begin
  select * into strict v_baseline
  from pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline;

  update public.shared_award_sources source
  set admin_reviewed_at = source.admin_reviewed_at + interval '1 second'
  where source.id = v_baseline.source_id;

  select pg_catalog.to_jsonb(source) into strict v_source_after
  from public.shared_award_sources source
  where source.id = v_baseline.source_id;
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_source_after - 'admin_reviewed_at' =
        v_baseline.source_before - 'admin_reviewed_at'
      and (v_source_after ->> 'admin_reviewed_at')::timestamptz =
        (v_baseline.source_before ->> 'admin_reviewed_at')::timestamptz
          + interval '1 second',
    'the rollback-only finalization timestamp drift fixture was not exact'
  );
end;
$prepare_finalization_timestamp_drift$;

set role service_role;
do $reject_finalization_timestamp_drift$
declare
  v_fixture pg_temp.awardping_stage1_upgrade_quarantine_fixture%rowtype;
  v_rejected boolean := false;
begin
  select * into strict v_fixture
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 1;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_fixture.evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Finalization timestamp drift was not rejected.';
  end if;
end;
$reject_finalization_timestamp_drift$;
reset role;

do $restore_and_verify_finalization_timestamp_drift$
declare
  v_baseline pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline%rowtype;
  v_positive pg_temp.awardping_stage1_upgrade_quarantine_positive_baseline%rowtype;
  v_source_after jsonb;
begin
  select * into strict v_baseline
  from pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline;
  select * into strict v_positive
  from pg_temp.awardping_stage1_upgrade_quarantine_positive_baseline;

  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    (select pg_catalog.count(*) from
      private.stage1_evidence_schema_upgrade_failures) = 0
      and not exists (
        select 1 from public.manual_quarantine_registry quarantine
        where quarantine.quarantine_key =
          'stage1:evidence-schema-upgrade:' || v_baseline.source_id::text
      )
      and (select pg_catalog.count(*) from public.stage1_award_publication_events) =
        (v_positive.zero_charge_counts ->> 'stage1_publication_events')::bigint
      and (select pg_catalog.count(*) from public.stage1_publication_release_events) =
        (v_positive.zero_charge_counts ->> 'stage1_release_events')::bigint
      and (select pg_catalog.count(*) from public.manual_quarantine_registry_events) =
        (v_positive.zero_charge_counts ->> 'quarantine_events')::bigint
      and coalesce((
        select state.revision
        from public.manual_quarantine_backlog_state state
        where state.state_key = 'operator_backlog'
      ), 0) = (v_positive.zero_charge_counts ->> 'backlog_revision')::bigint,
    'finalization timestamp drift rejection created a durable row or safety event'
  );

  update public.shared_award_sources source
  set admin_reviewed_at =
    (v_baseline.source_before ->> 'admin_reviewed_at')::timestamptz
  where source.id = v_baseline.source_id;
  select pg_catalog.to_jsonb(source) into strict v_source_after
  from public.shared_award_sources source
  where source.id = v_baseline.source_id;
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_source_after = v_baseline.source_before,
    'the rollback-only finalization timestamp fixture did not restore exactly'
  );
end;
$restore_and_verify_finalization_timestamp_drift$;

set role service_role;
do $reject_validation_source_drift$
declare
  v_fixture pg_temp.awardping_stage1_upgrade_quarantine_fixture%rowtype;
  v_validation jsonb;
  v_evidence jsonb;
  v_accounting jsonb;
  v_pointer_receipt jsonb;
  v_candidate jsonb;
  v_candidate_pointer jsonb;
  v_candidate_projection jsonb;
  v_case jsonb;
  v_rejected boolean;
begin
  select * into strict v_fixture
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 1;

  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['evidence'],
    (v_fixture.evidence #> array['validation', 'evidence']) - 'source_id'
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Missing validation source binding was not rejected.';
  end if;

  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['evidence', 'source_id'],
    pg_catalog.to_jsonb('99999999-9999-4999-8999-999999999999'::text)
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Swapped validation source binding was not rejected.';
  end if;

  select * into strict v_fixture
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 1;
  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['evidence', 'capture', 'captured_at'],
    pg_catalog.to_jsonb('2026-08-14T21:00:02.000Z'::text)
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Same-source wrong candidate generation was not rejected.';
  end if;

  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['evidence', 'capture', 'image_hash'],
    pg_catalog.to_jsonb(pg_catalog.repeat('f', 64))
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Same-source wrong candidate hash was not rejected.';
  end if;

  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['evidence', 'capture'],
    (v_fixture.evidence #> array['validation', 'evidence', 'capture']) -
      'image_hash'
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Missing candidate validation image hash was not rejected.';
  end if;

  select * into strict v_fixture
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 3;

  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['evidence'],
    (v_fixture.evidence #> array['validation', 'evidence']) -
      'mutation_failure'
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Pointer-commit mutation failure omission was not rejected.';
  end if;

  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['evidence', 'journal_read_unavailable'],
    pg_catalog.jsonb_build_object(
      'status', 'unavailable',
      'error', pg_catalog.jsonb_build_object(
        'name', 'FilesystemError',
        'code', 'EACCES',
        'message', 'Contradictory rollback-probe journal read.'
      )
    )
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Simultaneous recovery and unavailable journal evidence was not rejected.';
  end if;

  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['decision'],
    pg_catalog.to_jsonb('material_difference_candidate'::text)
  );
  v_validation := pg_catalog.jsonb_set(
    v_validation,
    array['outcome'],
    pg_catalog.jsonb_build_object(
      'would_commit', false,
      'would_queue_visual_candidate', true,
      'would_quarantine', false,
      'creates_api_charge', false
    )
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Unreachable pointer-commit validation decision was not rejected.';
  end if;

  select * into strict v_fixture
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 1;
  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['decision'],
    pg_catalog.to_jsonb('evidence_failure_quarantine'::text)
  );
  v_validation := pg_catalog.jsonb_set(
    v_validation,
    array['outcome'],
    pg_catalog.jsonb_build_object(
      'would_commit', false,
      'would_queue_visual_candidate', false,
      'would_quarantine', true,
      'creates_api_charge', false
    )
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Unreachable candidate-enqueue validation decision was not rejected.';
  end if;

  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array[
      'evidence', 'mutation_failure', 'mutation_accounting',
      'lower_bound_counts', 'candidate_writes'
    ],
    '2'::jsonb
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Unsealed mutation accounting was not rejected.';
  end if;

  v_accounting := pg_catalog.jsonb_set(
    v_fixture.evidence #> array[
      'validation', 'evidence', 'mutation_failure', 'mutation_accounting'
    ],
    array['unknown_write_categories'],
    '[null]'::jsonb
  );
  v_accounting := pg_catalog.jsonb_set(
    v_accounting,
    array['exact'],
    'false'::jsonb
  );
  v_accounting := (v_accounting - 'accounting_sha256') ||
    pg_catalog.jsonb_build_object(
      'accounting_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_accounting - 'accounting_sha256'
        )
    );
  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['evidence', 'mutation_failure', 'mutation_accounting'],
    v_accounting
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Non-string unknown mutation category was not rejected.';
  end if;

  v_accounting := v_fixture.evidence #> array[
    'validation', 'evidence', 'mutation_failure', 'mutation_accounting'
  ];
  v_accounting := pg_catalog.jsonb_set(
    v_accounting,
    array['evidence', 'candidate_signature'],
    'null'::jsonb
  );
  v_accounting := pg_catalog.jsonb_set(
    v_accounting,
    array['evidence', 'response_loss_possible'],
    'true'::jsonb
  );
  v_accounting := pg_catalog.jsonb_set(
    v_accounting,
    array['unknown_write_categories'],
    '["candidate_writes", "database_writes"]'::jsonb
  );
  v_accounting := pg_catalog.jsonb_set(
    v_accounting,
    array['exact'],
    'false'::jsonb
  );
  v_accounting := (v_accounting - 'accounting_sha256') ||
    pg_catalog.jsonb_build_object(
      'accounting_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_accounting - 'accounting_sha256'
        )
    );
  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['evidence', 'mutation_failure', 'mutation_accounting'],
    v_accounting
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'safe_action',
        'Keep this source quarantined. Repair access to the durable upgrade journal, obtain and validate its exact fresh state, and reconcile any active journal before any new capture or retry. Also repair the sealed pre-enqueue candidate preparation failure, then retry; exact accounting proves no candidate or database write was attempted.',
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'A null candidate signature with possible writes was not rejected.';
  end if;

  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['evidence', 'journal_read_unavailable', 'error'],
    (v_fixture.evidence #> array[
      'validation', 'evidence', 'journal_read_unavailable', 'error'
    ]) - 'message'
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_evidence)
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Malformed journal-read-unavailable observation was not rejected.';
  end if;

  select * into strict v_fixture
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 1;
  for v_case in
    select item.value
    from pg_catalog.jsonb_array_elements(
      '[{"kind":"count","label":"forbidden R2 write"},{"kind":"unknown","label":"forbidden unknown R2 category"}]'::jsonb
    ) item(value)
  loop
    v_accounting := v_fixture.evidence #> array[
      'validation', 'evidence', 'mutation_failure', 'mutation_accounting'
    ];
    if v_case ->> 'kind' = 'count' then
      v_accounting := pg_catalog.jsonb_set(
        v_accounting,
        array['lower_bound_counts', 'r2_writes'],
        '1'::jsonb
      );
    else
      v_accounting := pg_catalog.jsonb_set(
        v_accounting,
        array['unknown_write_categories'],
        '["r2_writes"]'::jsonb
      );
      v_accounting := pg_catalog.jsonb_set(
        v_accounting,
        array['exact'],
        'false'::jsonb
      );
      v_accounting := pg_catalog.jsonb_set(
        v_accounting,
        array['evidence', 'response_loss_possible'],
        'true'::jsonb
      );
    end if;
    v_accounting := (v_accounting - 'accounting_sha256') ||
      pg_catalog.jsonb_build_object(
        'accounting_sha256',
          private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
            v_accounting - 'accounting_sha256'
          )
      );
    v_validation := pg_catalog.jsonb_set(
      v_fixture.evidence -> 'validation',
      array['evidence', 'mutation_failure', 'mutation_accounting'],
      v_accounting
    );
    v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
      pg_catalog.jsonb_build_object(
        'validation', v_validation,
        'validation_sha256',
          private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
            v_validation
          )
      );
    v_evidence := v_evidence || pg_catalog.jsonb_build_object(
      'evidence_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_evidence
        )
    );
    v_rejected := false;
    begin
      perform public.quarantine_stage1_evidence_schema_upgrade_failure(
        v_fixture.source_id,
        v_fixture.acquisition_id,
        v_fixture.request_id,
        v_fixture.reason_code,
        v_evidence
      );
    exception when sqlstate '23514' then
      v_rejected := true;
    end;
    if not v_rejected then
      raise exception using errcode = 'P0001',
        message = 'Candidate-enqueue ' || (v_case ->> 'label') ||
          ' was not rejected after exact resealing.';
    end if;
  end loop;

  select * into strict v_fixture
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 5;
  for v_case in
    select item.value
    from pg_catalog.jsonb_array_elements(
      '[{"kind":"count","label":"forbidden candidate write"},{"kind":"unknown","label":"forbidden unknown quarantine category"}]'::jsonb
    ) item(value)
  loop
    v_accounting := v_fixture.evidence #> array[
      'validation', 'evidence', 'mutation_failure', 'mutation_accounting'
    ];
    if v_case ->> 'kind' = 'count' then
      v_accounting := pg_catalog.jsonb_set(
        v_accounting,
        array['lower_bound_counts', 'candidate_writes'],
        '1'::jsonb
      );
    else
      v_accounting := pg_catalog.jsonb_set(
        v_accounting,
        array['unknown_write_categories'],
        '["quarantine_writes"]'::jsonb
      );
      v_accounting := pg_catalog.jsonb_set(
        v_accounting,
        array['exact'],
        'false'::jsonb
      );
      v_accounting := pg_catalog.jsonb_set(
        v_accounting,
        array['evidence', 'response_loss_possible'],
        'true'::jsonb
      );
    end if;
    v_accounting := (v_accounting - 'accounting_sha256') ||
      pg_catalog.jsonb_build_object(
        'accounting_sha256',
          private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
            v_accounting - 'accounting_sha256'
          )
      );
    v_validation := pg_catalog.jsonb_set(
      v_fixture.evidence -> 'validation',
      array['evidence', 'mutation_failure', 'mutation_accounting'],
      v_accounting
    );
    v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
      pg_catalog.jsonb_build_object(
        'validation', v_validation,
        'validation_sha256',
          private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
            v_validation
          )
      );
    v_evidence := v_evidence || pg_catalog.jsonb_build_object(
      'evidence_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_evidence
        )
    );
    v_rejected := false;
    begin
      perform public.quarantine_stage1_evidence_schema_upgrade_failure(
        v_fixture.source_id,
        v_fixture.acquisition_id,
        v_fixture.request_id,
        v_fixture.reason_code,
        v_evidence
      );
    exception when sqlstate '23514' then
      v_rejected := true;
    end;
    if not v_rejected then
      raise exception using errcode = 'P0001',
        message = 'Pointer-commit ' || (v_case ->> 'label') ||
          ' was not rejected after exact resealing.';
    end if;
  end loop;

  select * into strict v_fixture
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 4;
  v_accounting := v_fixture.evidence #> array[
    'validation', 'evidence', 'mutation_failure', 'mutation_accounting'
  ];
  v_accounting := pg_catalog.jsonb_set(
    v_accounting,
    array['lower_bound_counts', 'database_writes'],
    '2'::jsonb
  );
  v_accounting := (v_accounting - 'accounting_sha256') ||
    pg_catalog.jsonb_build_object(
      'accounting_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_accounting - 'accounting_sha256'
        )
    );
  v_pointer_receipt := v_fixture.evidence #> array[
    'validation', 'evidence', 'pointer_commit_receipt'
  ];
  v_pointer_receipt := pg_catalog.jsonb_set(
    v_pointer_receipt,
    array['mutation_accounting'],
    v_accounting
  );
  v_pointer_receipt := pg_catalog.jsonb_set(
    v_pointer_receipt,
    array['mutation_counts', 'database_writes'],
    '2'::jsonb
  );
  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['evidence', 'mutation_failure', 'mutation_accounting'],
    v_accounting
  );
  v_validation := pg_catalog.jsonb_set(
    v_validation,
    array['evidence', 'pointer_commit_receipt'],
    v_pointer_receipt
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_evidence
      )
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'Exactly resealed pointer-receipt database-write inflation was not rejected.';
  end if;

  select * into strict v_fixture
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 1;
  v_candidate := v_fixture.evidence -> 'candidate_artifacts';
  v_candidate_pointer := v_candidate -> 'candidate_pointer_identity';
  v_candidate_projection := pg_catalog.jsonb_set(
    v_candidate_pointer -> 'projection',
    array['latest_captured_at'],
    pg_catalog.to_jsonb('2026-08-14T24:00:00.000Z'::text)
  );
  v_candidate_pointer := pg_catalog.jsonb_build_object(
    'schema_version', v_candidate_pointer -> 'schema_version',
    'exists', true,
    'projection', v_candidate_projection,
    'canonical_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_candidate_projection
      )
  );
  v_candidate := pg_catalog.jsonb_set(
    v_candidate,
    array['captured_at'],
    pg_catalog.to_jsonb('2026-08-14T24:00:00.000Z'::text)
  );
  v_candidate := pg_catalog.jsonb_set(
    v_candidate,
    array['candidate_pointer_identity'],
    v_candidate_pointer
  );
  v_validation := pg_catalog.jsonb_set(
    v_fixture.evidence -> 'validation',
    array['evidence', 'capture', 'captured_at'],
    pg_catalog.to_jsonb('2026-08-14T24:00:00.000Z'::text)
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'candidate_artifacts', v_candidate,
      'candidate_artifacts_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_candidate
        ),
      'validation', v_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_validation
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_evidence
      )
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'A resealed noncanonical candidate capture timestamp was not rejected.';
  end if;

  select * into strict v_fixture
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 1;
  v_candidate := v_fixture.evidence -> 'candidate_artifacts';
  v_candidate_pointer := v_candidate -> 'candidate_pointer_identity';
  v_candidate_projection := pg_catalog.jsonb_set(
    v_candidate_pointer -> 'projection',
    array['updated_at'],
    pg_catalog.to_jsonb('2026-08-14T16:05:01.000-05:00'::text)
  );
  v_candidate_pointer := pg_catalog.jsonb_build_object(
    'schema_version', v_candidate_pointer -> 'schema_version',
    'exists', true,
    'projection', v_candidate_projection,
    'canonical_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_candidate_projection
      )
  );
  v_candidate := pg_catalog.jsonb_set(
    v_candidate,
    array['candidate_pointer_identity'],
    v_candidate_pointer
  );
  v_evidence := (v_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'candidate_artifacts', v_candidate,
      'candidate_artifacts_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_candidate
        )
    );
  v_evidence := v_evidence || pg_catalog.jsonb_build_object(
    'evidence_sha256',
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_evidence
      )
  );
  v_rejected := false;
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_fixture.source_id,
      v_fixture.acquisition_id,
      v_fixture.request_id,
      v_fixture.reason_code,
      v_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using errcode = 'P0001',
      message = 'A resealed noncanonical candidate pointer timestamp was not rejected.';
  end if;
end;
$reject_validation_source_drift$;
reset role;

do $verify_validation_source_rejection_zero_delta$
declare
  v_baseline pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline%rowtype;
  v_positive pg_temp.awardping_stage1_upgrade_quarantine_positive_baseline%rowtype;
  v_source_after jsonb;
begin
  select * into strict v_baseline
  from pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline;
  select * into strict v_positive
  from pg_temp.awardping_stage1_upgrade_quarantine_positive_baseline;
  select pg_catalog.to_jsonb(source) into strict v_source_after
  from public.shared_award_sources source
  where source.id = v_baseline.source_id;
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_source_after = v_baseline.source_before
      and (select pg_catalog.count(*) from
        private.stage1_evidence_schema_upgrade_failures) = 0
      and not exists (
        select 1 from public.manual_quarantine_registry quarantine
        where quarantine.quarantine_key =
          'stage1:evidence-schema-upgrade:' || v_baseline.source_id::text
      )
      and (select pg_catalog.count(*) from public.stage1_award_publication_events) =
        (v_positive.zero_charge_counts ->> 'stage1_publication_events')::bigint
      and (select pg_catalog.count(*) from public.stage1_publication_release_events) =
        (v_positive.zero_charge_counts ->> 'stage1_release_events')::bigint
      and (select pg_catalog.count(*) from public.manual_quarantine_registry_events) =
        (v_positive.zero_charge_counts ->> 'quarantine_events')::bigint
      and coalesce((
        select state.revision
        from public.manual_quarantine_backlog_state state
        where state.state_key = 'operator_backlog'
      ), 0) = (v_positive.zero_charge_counts ->> 'backlog_revision')::bigint,
    'validation source or candidate generation/hash rejection was not exact zero-delta'
  );
end;
$verify_validation_source_rejection_zero_delta$;

savepoint verify_journal_observation_rpc_branches;
set role service_role;
do $verify_journal_observation_rpc_branches$
declare
  v_same_fixture pg_temp.awardping_stage1_upgrade_quarantine_fixture%rowtype;
  v_absent_fixture pg_temp.awardping_stage1_upgrade_quarantine_fixture%rowtype;
  v_capture_absent_fixture
    pg_temp.awardping_stage1_upgrade_quarantine_fixture%rowtype;
  v_same_receipt jsonb;
  v_absent_receipt jsonb;
  v_absent_replay jsonb;
  v_capture_absent_receipt jsonb;
  v_quarantine public.manual_quarantine_registry%rowtype;
  v_malformed_validation jsonb;
  v_malformed_evidence jsonb;
  v_rejected boolean := false;
  v_audit_before bigint;
  v_audit_after bigint;
begin
  select * into strict v_same_fixture
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 4;
  select * into strict v_absent_fixture
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 5;
  select * into strict v_capture_absent_fixture
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 6;

  v_same_receipt := public.quarantine_stage1_evidence_schema_upgrade_failure(
    v_same_fixture.source_id,
    v_same_fixture.acquisition_id,
    v_same_fixture.request_id,
    v_same_fixture.reason_code,
    v_same_fixture.evidence
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_same_receipt ->> 'status' = 'quarantined'
      and v_same_receipt ->> 'reason_code' =
        'javascript_same_journal_probe'
      and v_same_receipt ->> 'failure_stage' = 'pointer_commit',
    'the exact JavaScript same-journal receipt did not pass the SQL RPC contract'
  );

  v_absent_receipt :=
    public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_absent_fixture.source_id,
      v_absent_fixture.acquisition_id,
      v_absent_fixture.request_id,
      v_absent_fixture.reason_code,
      v_absent_fixture.evidence
    );
  v_absent_replay :=
    public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_absent_fixture.source_id,
      v_absent_fixture.acquisition_id,
      v_absent_fixture.request_id,
      v_absent_fixture.reason_code,
      v_absent_fixture.evidence
    );
  select quarantine.* into strict v_quarantine
  from public.manual_quarantine_registry quarantine
  where quarantine.quarantine_key =
    'stage1:evidence-schema-upgrade:' || v_absent_fixture.source_id::text;
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_absent_receipt ->> 'status' = 'quarantined'
      and v_absent_receipt -> 'audit_inserted' = 'true'::jsonb
      and v_absent_replay -> 'audit_inserted' = 'false'::jsonb
      and v_absent_receipt ->> 'quarantine_id' =
        v_absent_replay ->> 'quarantine_id'
      and v_absent_fixture.evidence #>> array[
        'evidence_availability', 'commit_recovery', 'status'
      ] = 'verified_absent'
      and v_absent_fixture.evidence #>> array[
        'validation', 'evidence', 'pointer_commit_journal_binding', 'status'
      ] = 'fresh_absence_only'
      and v_absent_fixture.evidence #>> array[
        'validation', 'evidence', 'journal_read_absent', 'status'
      ] = 'absent'
      and v_absent_fixture.evidence ->> 'safe_action' like
        '%fresh read verified that no active upgrade journal exists%'
      and v_absent_fixture.evidence ->> 'safe_action' like
        '%retry only if the commit is proven incomplete%'
      and v_quarantine.evidence -> 'failure_evidence' =
        v_absent_fixture.evidence
      and v_quarantine.recommended_action =
        v_absent_fixture.evidence ->> 'safe_action',
    'the verified-absent journal receipt, replay, storage, binding, availability, or action was not exact'
  );

  select pg_catalog.count(*) into strict v_audit_before
  from private.stage1_evidence_schema_upgrade_failures;
  v_malformed_validation := pg_catalog.jsonb_set(
    v_absent_fixture.evidence -> 'validation',
    array['evidence', 'journal_read_absent', 'error'],
    pg_catalog.jsonb_build_object(
      'name', 'Error',
      'message', 'A verified absence cannot carry an error.'
    )
  );
  v_malformed_evidence :=
    (v_absent_fixture.evidence - 'evidence_sha256') ||
    pg_catalog.jsonb_build_object(
      'validation', v_malformed_validation,
      'validation_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_malformed_validation
        )
    );
  v_malformed_evidence := v_malformed_evidence ||
    pg_catalog.jsonb_build_object(
      'evidence_sha256',
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_malformed_evidence
        )
    );
  begin
    perform public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_absent_fixture.source_id,
      v_absent_fixture.acquisition_id,
      v_absent_fixture.request_id,
      v_absent_fixture.reason_code,
      v_malformed_evidence
    );
  exception when sqlstate '23514' then
    v_rejected := true;
  end;
  select pg_catalog.count(*) into strict v_audit_after
  from private.stage1_evidence_schema_upgrade_failures;
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_rejected and v_audit_after = v_audit_before,
    'Malformed verified-absence evidence was not rejected with exact zero audit delta.'
  );

  v_capture_absent_receipt :=
    public.quarantine_stage1_evidence_schema_upgrade_failure(
      v_capture_absent_fixture.source_id,
      v_capture_absent_fixture.acquisition_id,
      v_capture_absent_fixture.request_id,
      v_capture_absent_fixture.reason_code,
      v_capture_absent_fixture.evidence
    );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_capture_absent_receipt ->> 'status' = 'quarantined'
      and v_capture_absent_receipt ->> 'failure_stage' = 'capture_validation'
      and not ((
        v_capture_absent_fixture.evidence #> array['validation', 'evidence']
      ) ? 'mutation_failure')
      and not ((
        v_capture_absent_fixture.evidence #> array['validation', 'evidence']
      ) ? 'pointer_commit_journal_binding')
      and v_capture_absent_fixture.evidence #>> array[
        'evidence_availability', 'commit_recovery', 'status'
      ] = 'verified_absent',
    'the no-mutation verified-absence observation was not accepted without a pointer binding'
  );
end;
$verify_journal_observation_rpc_branches$;
reset role;
rollback to savepoint verify_journal_observation_rpc_branches;
release savepoint verify_journal_observation_rpc_branches;

do $prepare_verified_release_invalidation_fixture$
declare
  v_baseline pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline%rowtype;
  v_cohort_key text;
  v_release_epoch uuid := '44444444-4444-4444-8444-444444444444'::uuid;
begin
  select * into strict v_baseline
  from pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline;
  select pg_catalog.min(manifest.cohort_key) into strict v_cohort_key
  from public.stage1_award_source_manifest manifest
  where v_baseline.source_id = any(manifest.source_ids);

  update public.stage1_award_registry registry
  set
    publication_state = case
      when registry.cohort_key = v_cohort_key then 'verified_beta'
      else 'pending'
    end,
    release_epoch = null,
    state_reason = 'Rollback-only verified-beta invalidation fixture.',
    updated_at = pg_catalog.clock_timestamp()
  where registry.cohort_key in (
    select manifest.cohort_key
    from public.stage1_award_source_manifest manifest
    where v_baseline.source_id = any(manifest.source_ids)
  ) or registry.release_epoch is not null;

  update public.stage1_publication_release_state release_state
  set
    release_state = 'verified_beta',
    release_epoch = v_release_epoch,
    reason = 'Rollback-only verified-beta invalidation fixture.',
    activated_at = pg_catalog.clock_timestamp(),
    updated_at = pg_catalog.clock_timestamp()
  where release_state.release_key = 'stage1-national-25';

  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_cohort_key is not null
      and (
        select pg_catalog.count(*)
        from public.stage1_award_registry registry
        where registry.publication_state = 'verified_beta'
          and exists (
            select 1
            from public.stage1_award_source_manifest manifest
            where manifest.cohort_key = registry.cohort_key
              and v_baseline.source_id = any(manifest.source_ids)
          )
      ) = 1
      and exists (
        select 1
        from public.stage1_publication_release_state release_state
        where release_state.release_key = 'stage1-national-25'
          and release_state.release_state = 'verified_beta'
          and release_state.release_epoch = v_release_epoch
      ),
    'the rollback-only verified-beta release invalidation fixture was not exact'
  );

  update pg_temp.awardping_stage1_upgrade_quarantine_positive_baseline baseline
  set zero_charge_counts = pg_catalog.jsonb_build_object(
    'change_events', (select pg_catalog.count(*) from public.shared_award_change_events),
    'visual_candidates', (select pg_catalog.count(*) from public.shared_award_visual_review_candidates),
    'spend_days', (select pg_catalog.count(*) from public.gemini_spend_days),
    'spend_reservations', (select pg_catalog.count(*) from public.gemini_spend_reservations),
    'spend_events', (select pg_catalog.count(*) from public.gemini_spend_events),
    'stage1_publication_events',
      (select pg_catalog.count(*) from public.stage1_award_publication_events),
    'stage1_release_events',
      (select pg_catalog.count(*) from public.stage1_publication_release_events),
    'quarantine_events',
      (select pg_catalog.count(*) from public.manual_quarantine_registry_events),
    'backlog_revision', coalesce((
      select state.revision
      from public.manual_quarantine_backlog_state state
      where state.state_key = 'operator_backlog'
    ), 0)
  );
end;
$prepare_verified_release_invalidation_fixture$;

set role service_role;
insert into pg_temp.awardping_stage1_upgrade_quarantine_receipts (
  invocation,
  receipt
)
select
  1,
  public.quarantine_stage1_evidence_schema_upgrade_failure(
    fixture.source_id,
    fixture.acquisition_id,
    fixture.request_id,
    fixture.reason_code,
    fixture.evidence
  )
from pg_temp.awardping_stage1_upgrade_quarantine_fixture fixture
where fixture.invocation = 1;

insert into pg_temp.awardping_stage1_upgrade_quarantine_receipts (
  invocation,
  receipt
)
select
  2,
  public.quarantine_stage1_evidence_schema_upgrade_failure(
    fixture.source_id,
    fixture.acquisition_id,
    fixture.request_id,
    fixture.reason_code,
    fixture.evidence
  )
from pg_temp.awardping_stage1_upgrade_quarantine_fixture fixture
where fixture.invocation = 2;

insert into pg_temp.awardping_stage1_upgrade_quarantine_receipts (
  invocation,
  receipt
)
select
  3,
  public.quarantine_stage1_evidence_schema_upgrade_failure(
    fixture.source_id,
    fixture.acquisition_id,
    fixture.request_id,
    fixture.reason_code,
    fixture.evidence
  )
from pg_temp.awardping_stage1_upgrade_quarantine_fixture fixture
where fixture.invocation = 2;

insert into pg_temp.awardping_stage1_upgrade_quarantine_receipts (
  invocation,
  receipt
)
select
  4,
  public.quarantine_stage1_evidence_schema_upgrade_failure(
    fixture.source_id,
    fixture.acquisition_id,
    fixture.request_id,
    fixture.reason_code,
    fixture.evidence
  )
from pg_temp.awardping_stage1_upgrade_quarantine_fixture fixture
where fixture.invocation = 3;
reset role;

do $positive_exact_delta$
declare
  v_baseline pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline%rowtype;
  v_positive pg_temp.awardping_stage1_upgrade_quarantine_positive_baseline%rowtype;
  v_fixture_first pg_temp.awardping_stage1_upgrade_quarantine_fixture%rowtype;
  v_fixture_second pg_temp.awardping_stage1_upgrade_quarantine_fixture%rowtype;
  v_fixture_journal pg_temp.awardping_stage1_upgrade_quarantine_fixture%rowtype;
  v_first jsonb;
  v_second jsonb;
  v_third jsonb;
  v_fourth jsonb;
  v_source public.shared_award_sources%rowtype;
  v_quarantine public.manual_quarantine_registry%rowtype;
  v_failure_first private.stage1_evidence_schema_upgrade_failures%rowtype;
  v_failure_second private.stage1_evidence_schema_upgrade_failures%rowtype;
  v_failure_journal private.stage1_evidence_schema_upgrade_failures%rowtype;
  v_other_sources_sha256 text;
  v_other_registry_sha256 text;
  v_zero_charge_counts jsonb;
begin
  select * into strict v_baseline
  from pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline;
  select * into strict v_positive
  from pg_temp.awardping_stage1_upgrade_quarantine_positive_baseline;
  select * into strict v_fixture_first
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 1;
  select * into strict v_fixture_second
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 2;
  select * into strict v_fixture_journal
  from pg_temp.awardping_stage1_upgrade_quarantine_fixture
  where invocation = 3;
  select receipt into strict v_first
  from pg_temp.awardping_stage1_upgrade_quarantine_receipts
  where invocation = 1;
  select receipt into strict v_second
  from pg_temp.awardping_stage1_upgrade_quarantine_receipts
  where invocation = 2;
  select receipt into strict v_third
  from pg_temp.awardping_stage1_upgrade_quarantine_receipts
  where invocation = 3;
  select receipt into strict v_fourth
  from pg_temp.awardping_stage1_upgrade_quarantine_receipts
  where invocation = 4;
  select source.* into strict v_source
  from public.shared_award_sources source
  where source.id = v_baseline.source_id;
  select quarantine.* into strict v_quarantine
  from public.manual_quarantine_registry quarantine
  where quarantine.quarantine_key =
    'stage1:evidence-schema-upgrade:' || v_baseline.source_id::text;
  select failure.* into strict v_failure_first
  from private.stage1_evidence_schema_upgrade_failures failure
  where failure.submitted_evidence_sha256 =
    v_fixture_first.evidence ->> 'evidence_sha256';
  select failure.* into strict v_failure_second
  from private.stage1_evidence_schema_upgrade_failures failure
  where failure.submitted_evidence_sha256 =
    v_fixture_second.evidence ->> 'evidence_sha256';
  select failure.* into strict v_failure_journal
  from private.stage1_evidence_schema_upgrade_failures failure
  where failure.submitted_evidence_sha256 =
    v_fixture_journal.evidence ->> 'evidence_sha256';

  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    (select pg_catalog.count(*) from
      private.stage1_evidence_schema_upgrade_failures) = 3,
    'reason A, reason B, and the active journal did not create exactly three immutable failure audits'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    (select pg_catalog.count(*) from public.manual_quarantine_registry quarantine
      where quarantine.quarantine_key like
        'stage1:evidence-schema-upgrade:%') = 1,
    'the valid replay did not create exactly one source-specific quarantine'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_first -> 'audit_inserted' = 'true'::jsonb
      and v_second -> 'audit_inserted' = 'true'::jsonb
      and v_third -> 'audit_inserted' = 'false'::jsonb
      and v_fourth -> 'audit_inserted' = 'true'::jsonb
      and v_first ->> 'failure_sha256' <> v_second ->> 'failure_sha256'
      and v_second ->> 'failure_sha256' = v_third ->> 'failure_sha256'
      and v_first ->> 'quarantine_id' = v_second ->> 'quarantine_id'
      and v_second ->> 'quarantine_id' = v_third ->> 'quarantine_id'
      and v_third ->> 'quarantine_id' = v_fourth ->> 'quarantine_id'
      and v_second ->> 'evidence_sha256' = v_third ->> 'evidence_sha256'
      and v_second ->> 'recorded_at' = v_third ->> 'recorded_at'
      and v_fourth ->> 'reason_code' = 'javascript_changed_journal_probe'
      and v_fourth ->> 'failure_stage' = 'pointer_commit'
      and v_fourth ->> 'evidence_sha256' =
        v_fixture_journal.evidence ->> 'evidence_sha256'
      and (v_first ->> 'observed_at')::timestamptz <
        (v_second ->> 'observed_at')::timestamptz
      and (v_second ->> 'observed_at')::timestamptz <
        (v_third ->> 'observed_at')::timestamptz
      and (v_third ->> 'observed_at')::timestamptz <
        (v_fourth ->> 'observed_at')::timestamptz,
    'reason evolution, the reason-B replay, or the active-journal observation was not exact and monotonic'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    private.stage1_evidence_schema_upgrade_has_exact_keys(v_first, array[
      'audit_inserted',
      'creates_api_charge',
      'evidence_sha256',
      'failure_sha256',
      'failure_stage',
      'mutation_count_scope',
      'mutation_counts',
      'observed_at',
      'public_award_update_created',
      'public_fact_authority',
      'quarantine_id',
      'reason_code',
      'release_safety',
      'receipt_sha256',
      'recorded_at',
      'schema_version',
      'shared_award_source_id',
      'source_acquisition_id',
      'source_page_request_id',
      'source_reheld',
      'status'
    ])
      and v_first ->> 'receipt_sha256' =
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_first - 'receipt_sha256'
        )
      and v_second ->> 'receipt_sha256' =
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_second - 'receipt_sha256'
        )
      and v_fourth ->> 'receipt_sha256' =
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_fourth - 'receipt_sha256'
        )
      and v_first -> 'creates_api_charge' = 'false'::jsonb
      and v_first -> 'public_fact_authority' = 'false'::jsonb
      and v_first -> 'public_award_update_created' = 'false'::jsonb
      and v_first ->> 'mutation_count_scope' = 'quarantine_rpc_only'
      and v_first -> 'source_reheld' = 'true'::jsonb,
    'the positive quarantine receipts are incomplete, unsealed, charged, or authoritative'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_first #>> array['mutation_counts', 'database_writes'] = '9'
      and v_second #>> array['mutation_counts', 'database_writes'] = '5'
      and v_third #>> array['mutation_counts', 'database_writes'] = '4'
      and v_fourth #>> array['mutation_counts', 'database_writes'] = '5'
      and v_first #>> array['mutation_counts', 'quarantine_writes'] = '3'
      and v_first #>> array['mutation_counts', 'source_state_writes'] = '1'
      and v_first #>> array['mutation_counts', 'r2_writes'] = '0'
      and v_first #>> array['mutation_counts', 'candidate_writes'] = '0'
      and v_first #>> array['mutation_counts', 'publication_safety_writes'] = '4'
      and v_second #>> array['mutation_counts', 'publication_safety_writes'] = '0'
      and v_fourth #>> array['mutation_counts', 'publication_safety_writes'] = '0'
      and v_fourth #>> array['mutation_counts', 'failure_audit_writes'] = '1'
      and v_fourth #>> array['mutation_counts', 'r2_writes'] = '0'
      and v_fourth #>> array['mutation_counts', 'local_baseline_writes'] = '0'
      and v_fourth #>> array['mutation_counts', 'candidate_writes'] = '0'
      and v_first #>> array[
        'release_safety', 'stage1_award_registry_writes'
      ] = '1'
      and v_first #>> array[
        'release_safety', 'stage1_award_publication_event_writes'
      ] = '1'
      and v_first #>> array['release_safety', 'stage1_release_state_writes'] = '1'
      and v_first #>> array['release_safety', 'stage1_release_event_writes'] = '1'
      and v_first #>> array['release_safety', 'stage1_release_registry_writes'] = '0'
      and v_first #>> array[
        'release_safety', 'manual_quarantine_backlog_state_writes'
      ] = '1',
    'the exact quarantine and release-safety mutation counts drifted'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_failure_first.submitted_evidence_sha256 =
      v_fixture_first.evidence ->> 'evidence_sha256'
      and v_failure_first.failure_sha256 = v_first ->> 'failure_sha256'
      and private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_failure_first.evidence
      ) = v_failure_first.failure_sha256
      and v_failure_first.evidence #>> array[
        'evidence_availability', 'commit_recovery', 'status'
      ] = 'unavailable'
      and v_failure_first.evidence #>> array[
        'validation', 'evidence', 'journal_read_unavailable', 'status'
      ] = 'unavailable'
      and v_failure_first.evidence #>> array[
        'validation', 'evidence', 'mutation_failure', 'operation'
      ] = 'candidate_enqueue'
      and v_failure_first.evidence #> array[
        'validation', 'evidence', 'mutation_failure',
        'mutation_accounting', 'exact'
      ] = 'true'::jsonb
      and v_failure_first.evidence #>> array[
        'validation', 'evidence', 'mutation_failure',
        'mutation_accounting', 'accounting_sha256'
      ] = private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_failure_first.evidence #> array[
          'validation', 'evidence', 'mutation_failure', 'mutation_accounting'
        ] - 'accounting_sha256'
      )
      and v_failure_second.submitted_evidence_sha256 =
        v_fixture_second.evidence ->> 'evidence_sha256'
      and v_failure_second.failure_sha256 = v_second ->> 'failure_sha256'
      and private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_failure_second.evidence
      ) = v_failure_second.failure_sha256
      and v_failure_journal.submitted_evidence_sha256 =
        v_fixture_journal.evidence ->> 'evidence_sha256'
      and v_failure_journal.failure_sha256 = v_fourth ->> 'failure_sha256'
      and private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_failure_journal.evidence
      ) = v_failure_journal.failure_sha256
      and v_failure_journal.evidence -> 'candidate_artifacts' =
        v_fixture_journal.evidence -> 'candidate_artifacts'
      and v_failure_journal.evidence -> 'commit_recovery' =
        v_fixture_journal.evidence -> 'commit_recovery'
      and v_failure_journal.evidence #> array[
        'validation', 'evidence', 'mutation_failure',
        'mutation_accounting', 'exact'
      ] = 'false'::jsonb
      and v_failure_journal.evidence #> array[
        'validation', 'evidence', 'mutation_failure',
        'mutation_accounting', 'unknown_write_categories'
      ] = '["database_writes", "r2_writes"]'::jsonb,
    'the immutable failure audits do not retain all exact submitted, candidate, recovery, and server seals'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_source.admin_review_status = 'review_later'
      and v_source.admin_review_note =
        'stage1_evidence_schema_upgrade_failed:javascript_changed_journal_probe'
      and v_source.admin_reviewed_by =
        'stage1-evidence-schema-upgrade-quarantine'
      and v_source.consecutive_failures >= 1
      and v_source.last_error =
        'Stage 1 evidence-schema upgrade failed: Évidence strings remain UTF-8 while object keys and numbers stay canonical.',
    'the selected source was not re-held with the exact failure state'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_quarantine.status = 'quarantined'
      and v_quarantine.evidence_record_count = 3
      and v_quarantine.terminal_failure_count = 1
      and v_quarantine.reason_code = 'javascript_changed_journal_probe'
      and v_quarantine.retry_charge = 'none'
      and v_quarantine.title = 'Stage 1 evidence-schema upgrade failed'
      and v_quarantine.policy_id =
        'awardping-stage1-evidence-schema-upgrade-quarantine'
      and v_quarantine.policy_version = '1'
      and v_quarantine.policy_hash =
        '1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c'
      and v_quarantine.evidence -> 'creates_api_charge' = 'false'::jsonb
      and v_quarantine.evidence -> 'public_fact_authority' = 'false'::jsonb
      and v_quarantine.evidence #> array[
        'failure_evidence', 'candidate_artifacts'
      ] = v_fixture_journal.evidence -> 'candidate_artifacts'
      and v_quarantine.evidence #> array[
        'failure_evidence', 'commit_recovery'
      ] = v_fixture_journal.evidence -> 'commit_recovery',
    'the operator quarantine key, evidence count, charge, title, or policy drifted'
  );

  select private.stage1_canonical_json_sha256(coalesce(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(source) order by source.id),
    '[]'::jsonb
  )) into v_other_sources_sha256
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
    and source.id <> v_baseline.source_id;
  select private.stage1_canonical_json_sha256(coalesce(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(quarantine) order by quarantine.id),
    '[]'::jsonb
  )) into v_other_registry_sha256
  from public.manual_quarantine_registry quarantine
  where quarantine.quarantine_key not like
    'stage1:evidence-schema-upgrade:%';
  v_zero_charge_counts := pg_catalog.jsonb_build_object(
    'change_events', (select pg_catalog.count(*) from public.shared_award_change_events),
    'visual_candidates', (select pg_catalog.count(*) from public.shared_award_visual_review_candidates),
    'spend_days', (select pg_catalog.count(*) from public.gemini_spend_days),
    'spend_reservations', (select pg_catalog.count(*) from public.gemini_spend_reservations),
    'spend_events', (select pg_catalog.count(*) from public.gemini_spend_events),
    'stage1_publication_events',
      (select pg_catalog.count(*) from public.stage1_award_publication_events),
    'stage1_release_events',
      (select pg_catalog.count(*) from public.stage1_publication_release_events),
    'quarantine_events',
      (select pg_catalog.count(*) from public.manual_quarantine_registry_events),
    'backlog_revision', coalesce((
      select state.revision
      from public.manual_quarantine_backlog_state state
      where state.state_key = 'operator_backlog'
    ), 0)
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_other_sources_sha256 = v_positive.reviewed_other_sources_sha256
      and v_other_registry_sha256 = v_positive.registry_without_target_sha256
      and v_zero_charge_counts = (
        v_positive.zero_charge_counts || pg_catalog.jsonb_build_object(
          'stage1_publication_events',
            (v_positive.zero_charge_counts ->> 'stage1_publication_events')::bigint + 1,
          'stage1_release_events',
            (v_positive.zero_charge_counts ->> 'stage1_release_events')::bigint + 1,
          'quarantine_events',
            (v_positive.zero_charge_counts ->> 'quarantine_events')::bigint + 4,
          'backlog_revision',
            (v_positive.zero_charge_counts ->> 'backlog_revision')::bigint + 4
        )
      )
      and exists (
        select 1
        from public.stage1_award_registry registry
        join public.stage1_award_source_manifest manifest
          on manifest.cohort_key = registry.cohort_key
        where v_baseline.source_id = any(manifest.source_ids)
          and registry.publication_state = 'revalidation_pending'
          and registry.release_epoch is null
      )
      and exists (
        select 1
        from public.stage1_publication_release_state release_state
        where release_state.release_key = 'stage1-national-25'
          and release_state.release_state = 'revalidation_pending'
          and release_state.release_epoch is null
      ),
    'the quarantine exact release-safety, operator-event, visual-candidate, or paid-lane delta drifted'
  );
end;
$positive_exact_delta$;

do $applied_contract$
declare
  v_function_oid oid := pg_catalog.to_regprocedure(
    'public.quarantine_stage1_evidence_schema_upgrade_failure(uuid,uuid,uuid,text,jsonb)'
  );
begin
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_function_oid is not null
      and pg_catalog.to_regclass(
        'private.stage1_evidence_schema_upgrade_failures'
      ) is not null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_schema_upgrade_quarantine_base64_sha256(text)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(jsonb)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_schema_upgrade_quarantine_json_sha256(jsonb)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_schema_upgrade_has_exact_keys(jsonb,text[])'
      ) is not null
      and exists (
        select 1
        from pg_catalog.pg_proc target
        where target.oid = v_function_oid
          and pg_catalog.pg_get_userbyid(target.proowner) = 'postgres'
          and target.provolatile = 'v'
          and not target.prosecdef
          and target.proconfig is not distinct from
            array['search_path=""']::text[]
      ),
    'the applied quarantine table or exact SECURITY INVOKER RPC is missing'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260814211159'
    ),
    'direct rollback-probe execution unexpectedly changed migration history'
  );
end;
$applied_contract$;

rollback;
-- MIGRATION TRANSACTION END

-- POST-ROLLBACK VERIFICATION START
begin;

do $post_rollback$
declare
  v_baseline pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline%rowtype;
  v_source_after jsonb;
  v_other_sources_sha256 text;
  v_other_registry_sha256 text;
  v_application_counts jsonb;
begin
  select * into strict v_baseline
  from pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline;

  select pg_catalog.to_jsonb(source) into strict v_source_after
  from public.shared_award_sources source
  where source.id = v_baseline.source_id;
  select private.stage1_canonical_json_sha256(coalesce(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(source) order by source.id),
    '[]'::jsonb
  )) into v_other_sources_sha256
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
    and source.id <> v_baseline.source_id;
  select private.stage1_canonical_json_sha256(coalesce(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(quarantine) order by quarantine.id),
    '[]'::jsonb
  )) into v_other_registry_sha256
  from public.manual_quarantine_registry quarantine
  where quarantine.quarantine_key not like
    'stage1:evidence-schema-upgrade:%';
  v_application_counts := pg_catalog.jsonb_build_object(
    'change_events', (select pg_catalog.count(*) from public.shared_award_change_events),
    'visual_candidates', (select pg_catalog.count(*) from public.shared_award_visual_review_candidates),
    'spend_days', (select pg_catalog.count(*) from public.gemini_spend_days),
    'spend_reservations', (select pg_catalog.count(*) from public.gemini_spend_reservations),
    'spend_events', (select pg_catalog.count(*) from public.gemini_spend_events),
    'stage1_publication_events',
      (select pg_catalog.count(*) from public.stage1_award_publication_events),
    'stage1_release_events',
      (select pg_catalog.count(*) from public.stage1_publication_release_events),
    'quarantine_events',
      (select pg_catalog.count(*) from public.manual_quarantine_registry_events),
    'backlog_revision', coalesce((
      select state.revision
      from public.manual_quarantine_backlog_state state
      where state.state_key = 'operator_backlog'
    ), 0),
    'stage1_award_registry_sha256', private.stage1_canonical_json_sha256(
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(registry) order by registry.cohort_key
        )
        from public.stage1_award_registry registry
      ), '[]'::jsonb)
    ),
    'stage1_release_state_sha256', private.stage1_canonical_json_sha256(
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(state) order by state.release_key
        )
        from public.stage1_publication_release_state state
      ), '[]'::jsonb)
    ),
    'manual_backlog_state_sha256', private.stage1_canonical_json_sha256(
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(state) order by state.state_key
        )
        from public.manual_quarantine_backlog_state state
      ), '[]'::jsonb)
    )
  );

  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    pg_temp.awardping_stage1_upgrade_quarantine_catalog_contract() =
      v_baseline.target_catalog_contract,
    'the target quarantine definition or catalog attributes survived rollback'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    pg_catalog.to_regclass(
      'private.stage1_evidence_schema_upgrade_failures'
    ) is null
      and pg_catalog.to_regprocedure(
        'public.quarantine_stage1_evidence_schema_upgrade_failure(uuid,uuid,uuid,text,jsonb)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_schema_upgrade_quarantine_base64_sha256(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(jsonb)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_schema_upgrade_quarantine_json_sha256(jsonb)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_schema_upgrade_has_exact_keys(jsonb,text[])'
      ) is null,
    'the new failure audit table, helper, or quarantine RPC survived rollback'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    v_source_after = v_baseline.source_before
      and v_other_sources_sha256 = v_baseline.reviewed_other_sources_sha256
      and v_other_registry_sha256 = v_baseline.registry_without_target_sha256
      and v_application_counts = v_baseline.application_counts
      and not exists (
        select 1
        from public.manual_quarantine_registry quarantine
        where quarantine.quarantine_key like
          'stage1:evidence-schema-upgrade:%'
      ),
    'the rollback did not restore exact reviewed-source, operator-case, event, or paid-lane state'
  );
  perform pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
    not exists (
      select 1
      from pg_catalog.unnest(v_baseline.required_prior_versions)
        required(version)
      where not exists (
        select 1
        from supabase_migrations.schema_migrations migration
        where migration.version = required.version
      )
    )
      and not exists (
        select 1
        from supabase_migrations.schema_migrations migration
        where migration.version = '20260814211159'
      ),
    'migration history changed despite rollback'
  );
end;
$post_rollback$;

select
  true as awardping_stage1_pending_migration_rollback_probe_passed,
  true as awardping_stage1_evidence_schema_upgrade_quarantine_probe_passed,
  1 as exact_migration_count,
  1 as exact_smoke_count,
  3 as immutable_failure_audit_delta,
  1 as source_specific_quarantine_delta,
  0 as public_award_update_delta,
  1 as stage1_publication_safety_event_delta,
  1 as stage1_release_safety_event_delta,
  4 as manual_quarantine_event_delta,
  4 as manual_quarantine_backlog_revision_delta,
  0 as visual_candidate_delta,
  0 as paid_lane_delta,
  '20260814211159_stage1_evidence_schema_upgrade_failure_quarantine.sql'::text
    as exact_migration,
  'stage1_evidence_schema_upgrade_failure_quarantine_smoke.sql'::text
    as exact_smoke,
  'migration/smoke/positive replay/catalog/application changes rolled back'::text
    as persistence_result;

drop table pg_temp.awardping_stage1_upgrade_quarantine_probe_baseline;
drop function pg_temp.awardping_stage1_upgrade_quarantine_catalog_contract();
drop function pg_temp.awardping_stage1_upgrade_quarantine_probe_assert(
  boolean,
  text
);

commit;
-- POST-ROLLBACK VERIFICATION END
