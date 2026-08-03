-- This file is a template. Execute it only through
--   node scripts/run-stage1-pending-migration-rollback-probe.mjs
-- The runner writes UTF-8 LF bytes to a temporary file and gives that file to
-- the Supabase CLI. Do not use a PowerShell native pipeline: it can normalize
-- LF to CRLF and break the migrations' exact dollar-quoted fragment matches.
-- Nothing below commits application data or schema. The first and last commits
-- affect only session-local temporary objects; every migration and fixture
-- mutation is enclosed by the explicit rollback.

begin;
create temporary table awardping_stage1_probe_baseline (
  sync_definition text not null,
  sync_proconfig text[],
  sync_acl text,
  success_definition text not null,
  success_proconfig text[],
  success_acl text,
  gate_definition text not null,
  gate_proconfig text[],
  gate_acl text,
  gate_oid oid not null,
  gate_owner oid not null,
  gate_security_definer boolean not null,
  gate_volatility "char" not null,
  effective_definition text not null,
  effective_proconfig text[],
  effective_acl text,
  effective_oid oid not null,
  effective_owner oid not null,
  effective_security_definer boolean not null,
  effective_volatility "char" not null,
  listing_definition text not null,
  listing_proconfig text[],
  listing_acl text,
  listing_oid oid not null,
  listing_owner oid not null,
  listing_security_definer boolean not null,
  listing_volatility "char" not null,
  artifact_selector_definition text not null,
  artifact_selector_proconfig text[],
  artifact_selector_acl text,
  artifact_selector_oid oid not null,
  artifact_selector_owner oid not null,
  artifact_selector_security_definer boolean not null,
  artifact_selector_volatility "char" not null,
  visual_object_set_definition text not null,
  visual_object_set_proconfig text[],
  visual_object_set_acl text,
  visual_object_set_oid oid not null,
  visual_object_set_owner oid not null,
  visual_object_set_security_definer boolean not null,
  visual_object_set_volatility "char" not null,
  r2_manifest_definition text not null,
  r2_manifest_proconfig text[],
  r2_manifest_acl text,
  r2_manifest_oid oid not null,
  r2_manifest_owner oid not null,
  r2_manifest_security_definer boolean not null,
  r2_manifest_volatility "char" not null,
  retirement_definition text not null,
  retirement_proconfig text[],
  retirement_acl text,
  retirement_oid oid not null,
  retirement_owner oid not null,
  retirement_security_definer boolean not null,
  retirement_volatility "char" not null,
  legacy_erasure_acl text,
  vault_schema_acl text,
  vault_relation_acls jsonb not null,
  vault_function_acls jsonb not null,
  registry_row jsonb not null,
  release_row jsonb not null,
  canonical_identity_rows jsonb not null,
  candidate_lifecycle_table_acls jsonb not null,
  table_counts jsonb not null,
  award_event_sequence_name text not null,
  award_event_sequence_state jsonb not null,
  release_event_sequence_name text not null,
  release_event_sequence_state jsonb not null,
  quarantine_event_sequence_name text not null,
  quarantine_event_sequence_state jsonb not null
) on commit preserve rows;

create function pg_temp.awardping_probe_assert(
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
      message = 'Stage 1 rollback probe failed: ' || p_message;
  end if;
end;
$$;

do $preflight$
declare
  v_award_sequence text;
  v_release_sequence text;
  v_quarantine_event_sequence text;
  v_award_sequence_state jsonb;
  v_release_sequence_state jsonb;
  v_quarantine_event_sequence_state jsonb;
begin
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regclass('public.shared_award_regression_audit_state') is null,
    'regression audit state already exists; the pending set is not unapplied'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regprocedure(
      'public.record_shared_award_regression_audit(uuid,jsonb,text)'
    ) is null,
    'regression audit writer already exists'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regprocedure(
      'private.invalidate_stage1_release_for_regression_audit(uuid,uuid,text,timestamp with time zone)'
    ) is null,
    'regression release invalidator already exists'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regprocedure(
      'public.finish_or_requeue_award_reconciliation_claim(uuid,uuid,timestamp with time zone,bigint,text,text)'
    ) is null,
    'terminal reconciliation writer already exists'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regprocedure(
      'public.commit_award_reconciliation_blocked(uuid,uuid,timestamp with time zone,bigint,timestamp with time zone,jsonb,jsonb,jsonb,jsonb,text)'
    ) is null,
    'blocked reconciliation writer already exists'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regclass(
      'public.shared_award_fact_candidate_terminal_archive'
    ) is null
      and pg_catalog.to_regprocedure(
        'public.awardping_enforce_fact_candidate_status_lifecycle()'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.prevent_terminal_candidate_archive_mutation()'
      ) is null
      and not exists (
        select 1
        from pg_catalog.pg_trigger trigger
        where trigger.tgname in (
          'awardping_fact_candidate_status_lifecycle',
          'stage1_candidate_parent_award_delete_release_fence',
          'stage1_candidate_parent_source_delete_release_fence'
        )
      ),
    'candidate lifecycle archive contract already exists'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regclass(
      'public.personal_data_legacy_ciphertext_archive'
    ) is null
      and pg_catalog.to_regprocedure(
        'private.awardping_personal_data_sha256(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.awardping_preserve_legacy_personal_data_archive()'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.erase_personal_data_legacy_archive_for_privacy_request(uuid,uuid)'
      ) is null
      and not exists (
        select 1
        from pg_catalog.pg_attribute attribute
        where attribute.attrelid = 'public.profiles'::pg_catalog.regclass
          and attribute.attname in (
            'personal_data_reentry_required',
            'personal_data_reentry_reason',
            'personal_data_reentry_marked_at',
            'personal_data_reentered_at'
          )
          and not attribute.attisdropped
      )
      and not exists (
        select 1
        from pg_catalog.pg_constraint constraint_row
        where constraint_row.conrelid = 'public.profiles'::pg_catalog.regclass
          and constraint_row.conname = 'profiles_personal_data_reentry_state_check'
      ),
    'personal-data re-entry contract already exists'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regprocedure(
      'public.apply_shared_award_source_cleanup_plan(jsonb,text,text)'
    ) is null,
    'award-scoped source-cleanup CAS function already exists'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regprocedure(
      'public.commit_reviewed_stage1_reconciliation_publication(uuid,uuid,timestamp with time zone,bigint,timestamp with time zone,jsonb,text,jsonb,double precision,jsonb,uuid[],uuid[],jsonb,jsonb,jsonb,jsonb)'
    ) is null
      and pg_catalog.to_regprocedure(
        'public.import_reviewed_stage1_fact_candidates(jsonb,text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.get_stage1_human_review_root(text)'
      ) is null
      and pg_catalog.to_regclass(
        'private.stage1_reviewed_candidate_import_bundles'
      ) is null
      and pg_catalog.to_regclass(
        'private.stage1_reviewed_candidate_import_items'
      ) is null
      and pg_catalog.to_regclass(
        'private.stage1_human_review_roots'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_safe_uuid(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_canonical_json_text(jsonb)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_canonical_json_sha256(jsonb)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_text_sha256(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_jsonb_has_exact_keys(jsonb,text[])'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_https_host(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_location_is_valid(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_candidate_uuid_from_sha256(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.prevent_stage1_reviewed_candidate_import_mutation()'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.prevent_stage1_human_review_root_mutation()'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.enforce_stage1_reviewed_reconciliation_success()'
      ) is null
      and not exists (
        select 1
        from pg_catalog.pg_trigger trigger
        where trigger.tgname in (
          'enforce_stage1_reviewed_reconciliation_success',
          'prevent_stage1_human_review_root_mutation',
          'prevent_stage1_reviewed_candidate_import_bundle_mutation',
          'prevent_stage1_reviewed_candidate_import_item_mutation'
        )
          and not trigger.tgisinternal
      ),
    'reviewed Stage 1 reconciliation contract already exists'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regclass(
      'private.stage1_canonical_identity_evidence'
    ) is null
      and pg_catalog.to_regclass(
        'private.stage1_delegated_source_authority_evidence'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.prevent_stage1_canonical_identity_evidence_mutation()'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_manifest_source_authority_valid(text,text,text,text,text,jsonb)'
      ) is null
      and not exists (
        select 1
        from public.manual_quarantine_registry quarantine
        where quarantine.quarantine_key =
          'stage1:ndseg:official-deadline-conflict:2026-07-17'
      ),
    'reviewed Hertz/NDSEG canonical-authority contract already exists'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regprocedure(
      'private.stage1_durable_verification_timestamp_valid(timestamp with time zone,timestamp with time zone)'
    ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_live_source_check_current(timestamp with time zone,timestamp with time zone)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_manifest_source_capture_binding_valid(uuid,text,jsonb,jsonb,jsonb)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_safe_timestamptz(text)'
      ) is null,
    'durable Stage 1 verification helpers already exist; the pending set is not unapplied'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regclass(
      'public.personal_data_legacy_contact_quarantine'
    ) is null
      and pg_catalog.to_regclass(
        'public.personal_data_erasure_tombstones'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.recover_legacy_contact_ciphertext(text,uuid,timestamp with time zone,text,text,text,text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.erase_personal_data_for_privacy_request(uuid,text,text,uuid)'
      ) is null,
    'legacy contact privacy contract already exists'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regprocedure(
      'public.retire_shared_award_source_preserving_visual_history(uuid,text,text)'
    ) is not null
      and pg_catalog.to_regprocedure(
        'private.retire_shared_award_source_unfenced_20260715143000(uuid,text,text)'
      ) is null,
    'deployed source-retirement function is missing or already wrapped'
  );
  perform pg_temp.awardping_probe_assert(
    not exists (
      select 1
      from public.stage1_award_source_identity_rules identity_rule
      where (identity_rule.cohort_key, identity_rule.rule_key) in (
        ('rhodes_us', 'exclude_rhodes_non_us_constituencies'),
        ('gilman', 'exclude_gilman_mccain')
      )
    ),
    'pending Stage 1 source-identity fence rows already exist'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regprocedure(
      'public.commit_award_reconciliation_publication(uuid,uuid,timestamp with time zone,bigint,timestamp with time zone,jsonb,text,jsonb,double precision,jsonb,uuid[],uuid[],jsonb,jsonb,jsonb)'
    ) is not null,
    'deployed atomic reconciliation publication function is missing'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regprocedure(
      'private.stage1_release_gate_snapshot(timestamp with time zone)'
    ) is not null,
    'deployed Stage 1 release gate function is missing'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regnamespace('vault') is not null
      and pg_catalog.to_regclass('vault.decrypted_secrets') is not null,
    'deployed Vault schema or decrypted-secrets view is missing'
  );
  perform pg_temp.awardping_probe_assert(
    (select pg_catalog.count(*) = 25 from public.stage1_award_registry),
    'Stage 1 registry is not the exact 25-award cohort'
  );
  perform pg_temp.awardping_probe_assert(
    (select pg_catalog.count(*) = 1
       from public.stage1_publication_release_state
      where release_key = 'stage1-national-25'),
    'authoritative Stage 1 release row is missing'
  );
  perform pg_temp.awardping_probe_assert(
    not exists (
      select 1
      from public.shared_awards
      where id = '00000000-0000-4000-8000-00000000a001'::uuid
         or search_key = 'awardping-stage1-rollback-probe-do-not-commit'
    ),
    'reserved synthetic award identity is already present'
  );
  perform pg_temp.awardping_probe_assert(
    not exists (
      select 1
      from public.stage1_release_acceptance_records acceptance
      where acceptance.id = '00000000-0000-4000-8000-00000000a00a'::uuid
        or acceptance.summary_hash = pg_catalog.repeat('b', 64)
    ),
    'reserved synthetic release acceptance identity is already present'
  );
  perform pg_temp.awardping_probe_assert(
    not exists (
      select 1
      from public.shared_awards award
      where award.id in (
        '00000000-0000-4000-8000-00000000d001'::uuid,
        '00000000-0000-4000-8000-00000000d004'::uuid
      )
        or award.search_key in (
          'awardping-candidate-source-fk-probe-do-not-commit',
          'awardping-candidate-award-fk-probe-do-not-commit'
        )
    )
      and not exists (
        select 1
        from public.shared_award_sources source
        where source.id = '00000000-0000-4000-8000-00000000d002'::uuid
      )
      and not exists (
        select 1
        from public.shared_award_fact_candidates candidate
        where candidate.id in (
          '00000000-0000-4000-8000-00000000d003'::uuid,
          '00000000-0000-4000-8000-00000000d005'::uuid
        )
      ),
    'reserved candidate FK lifecycle fixture identity is already present'
  );

  v_award_sequence := pg_catalog.pg_get_serial_sequence(
    'public.stage1_award_publication_events', 'id'
  );
  v_release_sequence := pg_catalog.pg_get_serial_sequence(
    'public.stage1_publication_release_events', 'id'
  );
  v_quarantine_event_sequence := pg_catalog.pg_get_serial_sequence(
    'public.manual_quarantine_registry_events', 'id'
  );
  perform pg_temp.awardping_probe_assert(
    v_award_sequence is not null
      and v_release_sequence is not null
      and v_quarantine_event_sequence is not null,
    'Stage 1 or quarantine event identity sequences are missing'
  );
  execute pg_catalog.format(
    'select pg_catalog.jsonb_build_object(''last_value'', last_value, ''is_called'', is_called) from %s',
    v_award_sequence::pg_catalog.regclass
  ) into v_award_sequence_state;
  execute pg_catalog.format(
    'select pg_catalog.jsonb_build_object(''last_value'', last_value, ''is_called'', is_called) from %s',
    v_release_sequence::pg_catalog.regclass
  ) into v_release_sequence_state;
  execute pg_catalog.format(
    'select pg_catalog.jsonb_build_object(''last_value'', last_value, ''is_called'', is_called) from %s',
    v_quarantine_event_sequence::pg_catalog.regclass
  ) into v_quarantine_event_sequence_state;

  insert into pg_temp.awardping_stage1_probe_baseline
  select
    pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure('public.sync_manual_quarantine_registry()')
    ),
    sync_proc.proconfig,
    sync_proc.proacl::text,
    pg_catalog.pg_get_functiondef(success_proc.oid),
    success_proc.proconfig,
    success_proc.proacl::text,
    pg_catalog.pg_get_functiondef(gate_proc.oid),
    gate_proc.proconfig,
    gate_proc.proacl::text,
    gate_proc.oid,
    gate_proc.proowner,
    gate_proc.prosecdef,
    gate_proc.provolatile,
    pg_catalog.pg_get_functiondef(effective_proc.oid),
    effective_proc.proconfig,
    effective_proc.proacl::text,
    effective_proc.oid,
    effective_proc.proowner,
    effective_proc.prosecdef,
    effective_proc.provolatile,
    pg_catalog.pg_get_functiondef(listing_proc.oid),
    listing_proc.proconfig,
    listing_proc.proacl::text,
    listing_proc.oid,
    listing_proc.proowner,
    listing_proc.prosecdef,
    listing_proc.provolatile,
    pg_catalog.pg_get_functiondef(artifact_selector_proc.oid),
    artifact_selector_proc.proconfig,
    artifact_selector_proc.proacl::text,
    artifact_selector_proc.oid,
    artifact_selector_proc.proowner,
    artifact_selector_proc.prosecdef,
    artifact_selector_proc.provolatile,
    pg_catalog.pg_get_functiondef(visual_object_set_proc.oid),
    visual_object_set_proc.proconfig,
    visual_object_set_proc.proacl::text,
    visual_object_set_proc.oid,
    visual_object_set_proc.proowner,
    visual_object_set_proc.prosecdef,
    visual_object_set_proc.provolatile,
    pg_catalog.pg_get_functiondef(r2_manifest_proc.oid),
    r2_manifest_proc.proconfig,
    r2_manifest_proc.proacl::text,
    r2_manifest_proc.oid,
    r2_manifest_proc.proowner,
    r2_manifest_proc.prosecdef,
    r2_manifest_proc.provolatile,
    pg_catalog.pg_get_functiondef(retirement_proc.oid),
    retirement_proc.proconfig,
    retirement_proc.proacl::text,
    retirement_proc.oid,
    retirement_proc.proowner,
    retirement_proc.prosecdef,
    retirement_proc.provolatile,
    (
      select procedure.proacl::text
      from pg_catalog.pg_proc procedure
      where procedure.oid = pg_catalog.to_regprocedure(
        'public.erase_public_update_subscriber(text,text)'
      )
    ),
    (
      select namespace.nspacl::text
      from pg_catalog.pg_namespace namespace
      where namespace.oid = pg_catalog.to_regnamespace('vault')
    ),
    (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'oid', class.oid,
            'acl', class.relacl::text
          ) order by class.oid
        ),
        '[]'::jsonb
      )
      from pg_catalog.pg_class class
      where class.relnamespace = pg_catalog.to_regnamespace('vault')
        and class.relkind in ('r', 'p', 'v', 'm', 'f')
    ),
    (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'oid', procedure.oid,
            'acl', procedure.proacl::text
          ) order by procedure.oid
        ),
        '[]'::jsonb
      )
      from pg_catalog.pg_proc procedure
      where procedure.pronamespace = pg_catalog.to_regnamespace('vault')
        and procedure.prokind <> 'p'
    ),
    (
      select pg_catalog.to_jsonb(registry)
      from public.stage1_award_registry registry
      order by registry.launch_rank
      limit 1
    ),
    (
      select pg_catalog.to_jsonb(release_state)
      from public.stage1_publication_release_state release_state
      where release_state.release_key = 'stage1-national-25'
    ),
    pg_catalog.jsonb_build_object(
      'registry', (
        select pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(registry)
          order by registry.cohort_key
        )
        from public.stage1_award_registry registry
        where registry.cohort_key in ('hertz', 'ndseg')
      ),
      'awards', (
        select pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(award)
          order by award.id
        )
        from public.shared_awards award
        where award.id in (
          '4d2f6a7f-024e-4194-be31-1b9f63e497bc'::uuid,
          'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid
        )
      )
    ),
    (
      select pg_catalog.jsonb_object_agg(
        class.oid::text,
        class.relacl::text
        order by class.oid
      )
      from pg_catalog.pg_class class
      where class.oid in (
        'public.shared_awards'::pg_catalog.regclass,
        'public.shared_award_sources'::pg_catalog.regclass,
        'public.shared_award_fact_candidates'::pg_catalog.regclass
      )
    ),
    pg_catalog.jsonb_build_object(
      'awards', (select pg_catalog.count(*) from public.shared_awards),
      'sources', (select pg_catalog.count(*) from public.shared_award_sources),
      'candidates', (select pg_catalog.count(*) from public.shared_award_fact_candidates),
      'queue', (select pg_catalog.count(*) from public.shared_award_reconciliation_queue),
      'audits', (select pg_catalog.count(*) from public.shared_award_page_audits),
      'acceptances', (select pg_catalog.count(*) from public.stage1_release_acceptance_records),
      'award_events', (select pg_catalog.count(*) from public.stage1_award_publication_events),
      'release_events', (select pg_catalog.count(*) from public.stage1_publication_release_events),
      'quarantine', (select pg_catalog.count(*) from public.manual_quarantine_registry),
      'quarantine_events', (
        select pg_catalog.count(*) from public.manual_quarantine_registry_events
      )
    ),
    v_award_sequence,
    v_award_sequence_state,
    v_release_sequence,
    v_release_sequence_state,
    v_quarantine_event_sequence,
    v_quarantine_event_sequence_state
  from pg_catalog.pg_proc sync_proc
  cross join pg_catalog.pg_proc success_proc
  cross join pg_catalog.pg_proc gate_proc
  cross join pg_catalog.pg_proc effective_proc
  cross join pg_catalog.pg_proc listing_proc
  cross join pg_catalog.pg_proc artifact_selector_proc
  cross join pg_catalog.pg_proc visual_object_set_proc
  cross join pg_catalog.pg_proc r2_manifest_proc
  cross join pg_catalog.pg_proc retirement_proc
  where sync_proc.oid = pg_catalog.to_regprocedure(
      'public.sync_manual_quarantine_registry()'
    )
    and success_proc.oid = pg_catalog.to_regprocedure(
      'public.commit_award_reconciliation_publication(uuid,uuid,timestamp with time zone,bigint,timestamp with time zone,jsonb,text,jsonb,double precision,jsonb,uuid[],uuid[],jsonb,jsonb,jsonb)'
    )
    and gate_proc.oid = pg_catalog.to_regprocedure(
      'private.stage1_release_gate_snapshot(timestamp with time zone)'
    )
    and effective_proc.oid = pg_catalog.to_regprocedure(
      'public.stage1_effective_publication_reason(text,timestamp with time zone)'
    )
    and listing_proc.oid = pg_catalog.to_regprocedure(
      'public.list_stage1_effective_publication()'
    )
    and artifact_selector_proc.oid = pg_catalog.to_regprocedure(
      'private.stage1_current_valid_release_artifact(text,timestamp with time zone)'
    )
    and visual_object_set_proc.oid = pg_catalog.to_regprocedure(
      'private.stage1_visual_r2_object_set_snapshot()'
    )
    and r2_manifest_proc.oid = pg_catalog.to_regprocedure(
      'public.get_stage1_release_r2_verification_manifest()'
    )
    and retirement_proc.oid = pg_catalog.to_regprocedure(
      'public.retire_shared_award_source_preserving_visual_history(uuid,text,text)'
    );

  perform pg_temp.awardping_probe_assert(
    (select pg_catalog.count(*) = 1 from pg_temp.awardping_stage1_probe_baseline),
    'could not snapshot the pre-migration contract'
  );
end;
$preflight$;
commit;

-- MIGRATION TRANSACTION START
begin;
set local statement_timeout = '120s';
set local lock_timeout = '15s';

-- Identity sequences are non-transactional. Redirect every event table that
-- pending migrations or fixtures can write before applying the exact SQL. The
-- replacement sequences exist only inside this transaction, so a migration
-- error or the explicit rollback cannot advance durable production sequences.
alter table public.stage1_award_publication_events alter column id drop identity;
alter table public.stage1_publication_release_events alter column id drop identity;
alter table public.manual_quarantine_registry_events alter column id drop identity;
create sequence private.awardping_stage1_probe_award_events_seq
  as bigint start with 9000000000000000000 increment by 1 no cycle;
create sequence private.awardping_stage1_probe_release_events_seq
  as bigint start with 9000000000000000000 increment by 1 no cycle;
create sequence private.awardping_stage1_probe_quarantine_events_seq
  as bigint start with 9000000000000000000 increment by 1 no cycle;
alter table public.stage1_award_publication_events
  alter column id set default nextval(
    'private.awardping_stage1_probe_award_events_seq'::pg_catalog.regclass
  );
alter table public.stage1_publication_release_events
  alter column id set default nextval(
    'private.awardping_stage1_probe_release_events_seq'::pg_catalog.regclass
  );
alter table public.manual_quarantine_registry_events
  alter column id set default nextval(
    'private.awardping_stage1_probe_quarantine_events_seq'::pg_catalog.regclass
  );

-- __AWARDPING_PENDING_MIGRATIONS__

do $schema_contract$
declare
  v_definition text;
  v_gate_snapshot jsonb;
  v_gate_after_regrant jsonb;
  v_source_id uuid := '11111111-1111-4111-8111-111111111111'::uuid;
  v_source_prefix text :=
    'visual-snapshots/sources/11111111-1111-4111-8111-111111111111/captures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
  v_web_keys jsonb;
  v_web_hashes jsonb := pg_catalog.jsonb_build_object(
    'image_hash', pg_catalog.repeat('a', 64),
    'text_hash', pg_catalog.repeat('b', 64)
  );
  v_web_metadata jsonb := pg_catalog.jsonb_build_object(
    'page_bytes', 10,
    'thumb_bytes', 5,
    'text_object_bytes', 6,
    'text_length', 5
  );
  v_service_role_oid oid;
  v_wrapper_oid oid := pg_catalog.to_regprocedure(
    'public.commit_award_reconciliation_publication(uuid,uuid,timestamp with time zone,bigint,timestamp with time zone,jsonb,text,jsonb,double precision,jsonb,uuid[],uuid[],jsonb,jsonb,jsonb)'
  );
  v_inner_oid oid := pg_catalog.to_regprocedure(
    'private.commit_award_reconciliation_publication_unfenced_20260716221500(uuid,uuid,timestamp with time zone,bigint,timestamp with time zone,jsonb,text,jsonb,double precision,jsonb,uuid[],uuid[],jsonb,jsonb,jsonb)'
  );
begin
  v_web_keys := pg_catalog.jsonb_build_object(
    'page', v_source_prefix || 'page.jpg',
    'thumb', v_source_prefix || 'thumb.jpg',
    'text', v_source_prefix || 'text.txt',
    'layout', v_source_prefix || 'layout.json',
    'meta', v_source_prefix || 'meta.json',
    'expansion_state_01', v_source_prefix || 'expansion-state-01.jpg',
    'expansion_state_01_layout',
      v_source_prefix || 'expansion-state-01-layout.json'
  );
  select role.oid
  into strict v_service_role_oid
  from pg_catalog.pg_roles role
  where role.rolname = 'service_role';

  select pg_catalog.pg_get_functiondef(procedure.oid)
  into strict v_definition
  from pg_catalog.pg_proc procedure
  where procedure.oid = pg_catalog.to_regprocedure(
    'public.stage1_effective_publication_reason(text,timestamp with time zone)'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.regexp_count(
      v_definition,
      'p_evaluated_at - interval ''24 hours'''
    ) = 0
      and v_definition like '%private.stage1_live_source_check_current(%'
      and v_definition like '%private.stage1_durable_verification_timestamp_valid(%'
      and v_definition like '%private.stage1_manifest_source_capture_binding_valid(%'
      and v_definition not like '%manifest.checked_at >= p_evaluated_at - interval ''24 hours''%'
      and v_definition not like '%snapshot.latest_captured_at < p_evaluated_at - interval ''24 hours''%'
      and v_definition not like '%v_latest_reconciliation.completed_at < p_evaluated_at - interval ''24 hours''%'
      and v_definition not like '%v_latest_audit.created_at < p_evaluated_at - interval ''24 hours''%'
      and v_definition not like '%private.stage1_current_valid_release_artifact(%'
      and v_definition not like '%signed_r2_recovery_artifact_not_current%'
      and v_definition like '%snapshot.latest_hashes is distinct from ledger.source_snapshot_hashes%'
      and v_definition like '%v_latest_reconciliation.status <> ''succeeded''%'
      and v_definition like '%v_latest_audit.audit_status <> ''passed''%'
      and v_definition like '%actionable_quarantine_open%',
    'durable Stage 1 verification epoch policy changed'
  );
  perform pg_temp.awardping_probe_assert(
    private.stage1_durable_verification_timestamp_valid(
      pg_catalog.statement_timestamp() - interval '30 days',
      pg_catalog.statement_timestamp()
    )
      and private.stage1_live_source_check_current(
        pg_catalog.statement_timestamp() - interval '23 hours 59 minutes',
        pg_catalog.statement_timestamp()
      )
      and not private.stage1_live_source_check_current(
        pg_catalog.statement_timestamp() - interval '24 hours 1 second',
        pg_catalog.statement_timestamp()
      )
      and not private.stage1_durable_verification_timestamp_valid(
        pg_catalog.statement_timestamp() + interval '5 minutes 1 second',
        pg_catalog.statement_timestamp()
      )
      and (
        select procedure.provolatile = 'i'
          and not procedure.prosecdef
          and coalesce('search_path=""' = any(procedure.proconfig), false)
        from pg_catalog.pg_proc procedure
        where procedure.oid = pg_catalog.to_regprocedure(
          'private.stage1_durable_verification_timestamp_valid(timestamp with time zone,timestamp with time zone)'
        )
      )
      and (
        select procedure.provolatile = 'i'
          and not procedure.prosecdef
          and coalesce('search_path=""' = any(procedure.proconfig), false)
        from pg_catalog.pg_proc procedure
        where procedure.oid = pg_catalog.to_regprocedure(
          'private.stage1_live_source_check_current(timestamp with time zone,timestamp with time zone)'
        )
      )
      and not pg_catalog.has_function_privilege(
        'service_role',
        'private.stage1_durable_verification_timestamp_valid(timestamp with time zone,timestamp with time zone)',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'service_role',
        'private.stage1_live_source_check_current(timestamp with time zone,timestamp with time zone)',
        'EXECUTE'
      )
      and private.stage1_safe_timestamptz(
        '2026-07-17T18:00:00.000Z'
      ) = '2026-07-17T18:00:00.000Z'::timestamptz
      and private.stage1_safe_timestamptz(
        '2026-07-17T18:00:00garbageZ'
      ) is null
      and not pg_catalog.has_function_privilege(
        'service_role',
        'private.stage1_safe_timestamptz(text)',
        'EXECUTE'
      ),
    'durable timestamp or live-source freshness behavior changed'
  );
  perform pg_temp.awardping_probe_assert(
    private.stage1_manifest_source_capture_binding_valid(
      v_source_id, 'webpage', v_web_keys, v_web_hashes, v_web_metadata
    ),
    'valid immutable webpage capture binding was rejected'
  );
  perform pg_temp.awardping_probe_assert(
    private.stage1_manifest_source_capture_binding_valid(
        v_source_id,
        'pdf',
        pg_catalog.jsonb_build_object(
          'pdf', v_source_prefix || 'document.pdf',
          'text', v_source_prefix || 'text.txt',
          'meta', v_source_prefix || 'meta.json'
        ),
        pg_catalog.jsonb_build_object(
          'file_hash', pg_catalog.repeat('c', 64),
          'text_hash', pg_catalog.repeat('d', 64)
        ),
        pg_catalog.jsonb_build_object(
          'file_bytes', 20,
          'text_object_bytes', 6,
          'text_length', 5
        )
      ),
    'valid immutable PDF capture binding was rejected'
  );
  perform pg_temp.awardping_probe_assert(
    not private.stage1_manifest_source_capture_binding_valid(
        v_source_id,
        'webpage',
        pg_catalog.jsonb_set(
          v_web_keys,
          '{text}',
          pg_catalog.to_jsonb(
            'visual-snapshots/sources/11111111-1111-4111-8111-111111111111/latest/text.txt'::text
          )
        ),
        v_web_hashes,
        v_web_metadata
      )
      and not private.stage1_manifest_source_capture_binding_valid(
        v_source_id,
        'webpage',
        pg_catalog.jsonb_set(
          v_web_keys,
          '{text}',
          pg_catalog.to_jsonb(
            'visual-snapshots/sources/11111111-1111-4111-8111-111111111111/captures/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/text.txt'::text
          )
        ),
        v_web_hashes,
        v_web_metadata
      )
      and not private.stage1_manifest_source_capture_binding_valid(
        v_source_id, 'webpage', v_web_keys - 'thumb',
        v_web_hashes, v_web_metadata
      )
      and not private.stage1_manifest_source_capture_binding_valid(
        v_source_id,
        'webpage',
        v_web_keys || pg_catalog.jsonb_build_object(
          'mystery', v_source_prefix || 'mystery.bin'
        ),
        v_web_hashes,
        v_web_metadata
      )
      and not private.stage1_manifest_source_capture_binding_valid(
        v_source_id,
        'webpage',
        pg_catalog.jsonb_set(
          v_web_keys,
          '{meta}',
          pg_catalog.to_jsonb(v_source_prefix || 'text.txt')
        ),
        v_web_hashes,
        v_web_metadata
      )
      and not private.stage1_manifest_source_capture_binding_valid(
        v_source_id, 'webpage', v_web_keys, v_web_hashes,
        v_web_metadata - 'text_object_bytes'
      )
      ,
    'immutable capture key-set negative cases were accepted'
  );
  perform pg_temp.awardping_probe_assert(
    (
        select procedure.provolatile = 'i'
          and not procedure.prosecdef
          and coalesce('search_path=""' = any(procedure.proconfig), false)
        from pg_catalog.pg_proc procedure
        where procedure.oid = pg_catalog.to_regprocedure(
          'private.stage1_manifest_source_capture_binding_valid(uuid,text,jsonb,jsonb,jsonb)'
        )
      )
      and not pg_catalog.has_function_privilege(
        'service_role',
        'private.stage1_manifest_source_capture_binding_valid(uuid,text,jsonb,jsonb,jsonb)',
        'EXECUTE'
      ),
    'immutable Stage 1 manifest source-capture binding behavior changed'
  );
  select pg_catalog.pg_get_functiondef(procedure.oid)
  into strict v_definition
  from pg_catalog.pg_proc procedure
  where procedure.oid = pg_catalog.to_regprocedure(
    'public.list_stage1_effective_publication()'
  );
  perform pg_temp.awardping_probe_assert(
    v_definition like '%private.stage1_current_valid_release_artifact(%'
      and v_definition like '%''r2_recovery_drill''%'
      and v_definition like '%signed_r2_recovery_artifact_not_current%'
      and v_definition like '%visual_object_set_hash%'
      and v_definition like '%visual_objects_checked%'
      and v_definition like '%unexpected_bucket_count%'
      and v_definition like '%malformed_object_count%'
      and v_definition like '%manifest_binding_error_count%'
      and pg_catalog.lower(v_definition) like
        '%readiness_reason = ''verified'' as cohort_ready%'
      and pg_catalog.lower(v_definition) like
        '%decision_reason = ''verified'' as effectively_verified%',
    'signed R2 proof is not isolated to national effective publication'
  );

  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regclass('public.shared_award_page_audits_batch_request_key_idx') is not null,
    'incremental quarantine request-key index is missing'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regclass(
      'public.personal_data_legacy_contact_quarantine'
    ) is not null
      and pg_catalog.to_regclass(
        'public.personal_data_erasure_tombstones'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.quarantine_legacy_contact_ciphertext(text,uuid,timestamp with time zone,text)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.recover_legacy_contact_ciphertext(text,uuid,timestamp with time zone,text,text,text,text)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.erase_personal_data_for_privacy_request(uuid,text,text,uuid)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.erase_legacy_contact_ciphertext_for_privacy_request(uuid,text,uuid)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'private.stage1_gate_without_contact_fence_20260717123000(timestamp with time zone)'
      ) is not null
      and pg_catalog.has_function_privilege(
        'service_role',
        'public.recover_legacy_contact_ciphertext(text,uuid,timestamp with time zone,text,text,text,text)',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated',
        'public.recover_legacy_contact_ciphertext(text,uuid,timestamp with time zone,text,text,text,text)',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'service_role',
        'public.erase_public_update_subscriber(text,text)',
        'EXECUTE'
      )
      and not pg_catalog.has_table_privilege(
        'service_role',
        'public.personal_data_legacy_contact_quarantine',
        'INSERT,UPDATE,DELETE'
      ),
    'legacy contact privacy CAS, ACL, or signed-gate contract changed'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select procedure.prosecdef
        and procedure.provolatile = 'v'
        and coalesce('search_path=""' = any(procedure.proconfig), false)
        and coalesce('statement_timeout=60s' = any(procedure.proconfig), false)
      from pg_catalog.pg_proc procedure
      where procedure.oid = pg_catalog.to_regprocedure(
        'public.apply_shared_award_source_cleanup_plan(jsonb,text,text)'
      )
    )
      and pg_catalog.has_function_privilege(
        'service_role',
        'public.apply_shared_award_source_cleanup_plan(jsonb,text,text)',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'anon',
        'public.apply_shared_award_source_cleanup_plan(jsonb,text,text)',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated',
        'public.apply_shared_award_source_cleanup_plan(jsonb,text,text)',
        'EXECUTE'
      ),
    'award-scoped source-cleanup CAS security or timeout contract changed'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select procedure.prosecdef
        and procedure.provolatile = 'v'
        and coalesce('search_path=""' = any(procedure.proconfig), false)
        and coalesce('statement_timeout=60s' = any(procedure.proconfig), false)
        and pg_catalog.strpos(
          pg_catalog.pg_get_functiondef(procedure.oid),
          'stage1-national-25-release'
        ) < pg_catalog.strpos(
          pg_catalog.pg_get_functiondef(procedure.oid),
          'private.retire_shared_award_source_unfenced_20260715143000'
        )
      from pg_catalog.pg_proc procedure
      where procedure.oid = pg_catalog.to_regprocedure(
        'public.retire_shared_award_source_preserving_visual_history(uuid,text,text)'
      )
    )
      and pg_catalog.to_regprocedure(
        'private.retire_shared_award_source_unfenced_20260715143000(uuid,text,text)'
      ) is not null
      and not pg_catalog.has_function_privilege(
        'service_role',
        'private.retire_shared_award_source_unfenced_20260715143000(uuid,text,text)',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'anon',
        'private.retire_shared_award_source_unfenced_20260715143000(uuid,text,text)',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated',
        'private.retire_shared_award_source_unfenced_20260715143000(uuid,text,text)',
        'EXECUTE'
      ),
    'manual source-retirement wrapper lock order or private ACL changed'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regclass(
      'public.personal_data_legacy_ciphertext_archive'
    ) is not null
      and pg_catalog.to_regprocedure(
        'private.awardping_personal_data_sha256(text)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'private.awardping_preserve_legacy_personal_data_archive()'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.erase_personal_data_legacy_archive_for_privacy_request(uuid,uuid)'
      ) is not null
      and (
        select pg_catalog.count(*) = 4
        from pg_catalog.pg_attribute attribute
        where attribute.attrelid = 'public.profiles'::pg_catalog.regclass
          and attribute.attname in (
            'personal_data_reentry_required',
            'personal_data_reentry_reason',
            'personal_data_reentry_marked_at',
            'personal_data_reentered_at'
          )
          and not attribute.attisdropped
      )
      and exists (
        select 1
        from pg_catalog.pg_constraint constraint_row
        where constraint_row.conrelid = 'public.profiles'::pg_catalog.regclass
          and constraint_row.conname = 'profiles_personal_data_reentry_state_check'
      )
      and exists (
        select 1
        from pg_catalog.pg_trigger trigger
        where trigger.tgrelid =
              'public.personal_data_legacy_ciphertext_archive'::pg_catalog.regclass
          and trigger.tgname = 'preserve_legacy_personal_data_archive_rows'
          and not trigger.tgisinternal
      )
      and exists (
        select 1
        from pg_catalog.pg_trigger trigger
        where trigger.tgrelid =
              'public.personal_data_legacy_ciphertext_archive'::pg_catalog.regclass
          and trigger.tgname = 'preserve_legacy_personal_data_archive_truncate'
          and not trigger.tgisinternal
      ),
    'personal-data re-entry schema, constraint, or archive guards are incomplete'
  );
  perform pg_temp.awardping_probe_assert(
    not exists (
      select 1
      from public.profiles profile
      cross join lateral (
        values
          ('full_name_encrypted'::text, profile.full_name_encrypted),
          ('organization_encrypted'::text, profile.organization_encrypted)
      ) as legacy(source_column, ciphertext)
      where legacy.ciphertext is not null
        and legacy.ciphertext not like 'ap:v2:%'
        and (
          not profile.personal_data_reentry_required
          or profile.personal_data_reentry_marked_at is null
          or profile.personal_data_reentry_reason is distinct from (case
            when profile.full_name_encrypted like 'ap:v1:%'
              or profile.organization_encrypted like 'ap:v1:%'
              then 'legacy_v1_key_unavailable'
            else 'unsupported_ciphertext_format'
          end)
          or not exists (
            select 1
            from public.personal_data_legacy_ciphertext_archive archive
            where archive.user_id = profile.id
              and archive.source_column = legacy.source_column
              and archive.ciphertext = legacy.ciphertext
              and archive.ciphertext_sha256 =
                  private.awardping_personal_data_sha256(legacy.ciphertext)
          )
        )
    )
      and not exists (
        select 1
        from public.profiles profile
        where profile.personal_data_reentry_required
          and coalesce(profile.full_name_encrypted, '') like 'ap:v2:%'
          and coalesce(profile.organization_encrypted, '') like 'ap:v2:%'
      ),
    'legacy personal data was not archived and marked for truthful re-entry'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.has_table_privilege(
      'service_role',
      'public.personal_data_legacy_ciphertext_archive',
      'SELECT'
    )
      and not pg_catalog.has_table_privilege(
        'service_role',
        'public.personal_data_legacy_ciphertext_archive',
        'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER'
      )
      and pg_catalog.has_function_privilege(
        'service_role',
        'public.erase_personal_data_legacy_archive_for_privacy_request(uuid,uuid)',
        'EXECUTE'
      ),
    'personal-data archive least-privilege contract is incomplete'
  );
  perform pg_temp.awardping_probe_assert(
    exists (
      select 1
      from public.stage1_award_source_identity_rules identity_rule
      where identity_rule.cohort_key = 'rhodes_us'
        and identity_rule.rule_key = 'exclude_rhodes_non_us_constituencies'
        and 'https://www.rhodeshouse.ox.ac.uk/media/50000/canada-information-for-candidates-2027.pdf'
            ~* identity_rule.url_pattern
        and not (
          'https://www.rhodeshouse.ox.ac.uk/files/usainformationforcandidates/'
          ~* identity_rule.url_pattern
        )
    )
      and exists (
        select 1
        from public.stage1_award_source_identity_rules identity_rule
        where identity_rule.cohort_key = 'gilman'
          and identity_rule.rule_key = 'exclude_gilman_mccain'
          and 'https://www.gilmanscholarship.org/program/gilman-mccain-scholarships/'
              ~* identity_rule.url_pattern
          and not (
            'https://www.gilmanscholarship.org/applicants/eligibility/'
            ~* identity_rule.url_pattern
          )
      ),
    'Stage 1 source-identity fence rows did not enforce exact competition boundaries'
  );
  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure('public.sync_manual_quarantine_registry()')
  ) into v_definition;
  perform pg_temp.awardping_probe_assert(
    pg_catalog.strpos(pg_catalog.lower(v_definition), 'join (') > 0
      and pg_catalog.strpos(
        pg_catalog.lower(v_definition),
        'latest_request.gemini_batch_request_key = attempt.gemini_batch_request_key'
      ) > 0
      and pg_catalog.strpos(
        pg_catalog.lower(v_definition),
        'manual_quarantine_registry.evidence_hash is distinct from excluded.evidence_hash'
      ) > 0,
    'incremental quarantine function rewrite is incomplete'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select coalesce('statement_timeout=60s' = any(procedure.proconfig), false)
      from pg_catalog.pg_proc procedure
      where procedure.oid = pg_catalog.to_regprocedure(
        'public.sync_manual_quarantine_registry()'
      )
    ),
    'quarantine sync does not have its function-only 60-second timeout'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regprocedure(
      'public.bump_manual_quarantine_backlog_for_changed_registry_rows()'
    ) is not null
      and not pg_catalog.has_function_privilege(
        'service_role',
        'public.bump_manual_quarantine_backlog_for_changed_registry_rows()',
        'EXECUTE'
      )
      and (
        select pg_catalog.count(*) = 3
        from pg_catalog.pg_trigger trigger
        where trigger.tgrelid = 'public.manual_quarantine_registry'::pg_catalog.regclass
          and trigger.tgname in (
            'bump_manual_quarantine_backlog_after_registry_insert',
            'bump_manual_quarantine_backlog_after_registry_update',
            'bump_manual_quarantine_backlog_after_registry_delete'
          )
          and not trigger.tgisinternal
      ),
    'quarantine backlog transition-table trigger contract changed'
  );

  perform pg_temp.awardping_probe_assert(
    (
      select class.relrowsecurity
      from pg_catalog.pg_class class
      where class.oid = 'public.shared_award_regression_audit_state'::pg_catalog.regclass
    ),
    'regression state RLS is disabled'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.has_table_privilege(
      'service_role', 'public.shared_award_regression_audit_state', 'SELECT,INSERT,UPDATE,DELETE'
    )
      and not pg_catalog.has_table_privilege(
        'anon', 'public.shared_award_regression_audit_state', 'SELECT'
      )
      and not pg_catalog.has_table_privilege(
        'authenticated', 'public.shared_award_regression_audit_state', 'SELECT'
      ),
    'regression state table grants are not service-only'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.has_function_privilege(
      'service_role',
      'public.record_shared_award_regression_audit(uuid,jsonb,text)',
      'EXECUTE'
    )
      and not pg_catalog.has_function_privilege(
        'anon',
        'public.record_shared_award_regression_audit(uuid,jsonb,text)',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated',
        'public.record_shared_award_regression_audit(uuid,jsonb,text)',
        'EXECUTE'
      ),
    'regression audit writer grants are not service-only'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select procedure.prosecdef
        and coalesce('search_path=""' = any(procedure.proconfig), false)
      from pg_catalog.pg_proc procedure
      where procedure.oid = pg_catalog.to_regprocedure(
        'public.record_shared_award_regression_audit(uuid,jsonb,text)'
      )
    ),
    'regression audit writer security settings changed'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select procedure.prosecdef
        and procedure.provolatile = 'v'
        and coalesce('search_path=""' = any(procedure.proconfig), false)
      from pg_catalog.pg_proc procedure
      where procedure.oid = pg_catalog.to_regprocedure(
        'private.invalidate_stage1_release_for_regression_audit(uuid,uuid,text,timestamp with time zone)'
      )
    )
      and not pg_catalog.has_function_privilege(
        'anon',
        'private.invalidate_stage1_release_for_regression_audit(uuid,uuid,text,timestamp with time zone)',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated',
        'private.invalidate_stage1_release_for_regression_audit(uuid,uuid,text,timestamp with time zone)',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'service_role',
        'private.invalidate_stage1_release_for_regression_audit(uuid,uuid,text,timestamp with time zone)',
        'EXECUTE'
      ),
    'private regression release invalidator security settings or grants changed'
  );

  perform pg_temp.awardping_probe_assert(
    (
      select class.relrowsecurity
      from pg_catalog.pg_class class
      where class.oid =
        'public.shared_award_fact_candidate_terminal_archive'::pg_catalog.regclass
    )
      and not exists (
        select 1
        from pg_catalog.pg_constraint constraint_row
        where constraint_row.conrelid =
          'public.shared_award_fact_candidate_terminal_archive'::pg_catalog.regclass
          and constraint_row.contype = 'f'
      )
      and pg_catalog.has_table_privilege(
        'service_role',
        'public.shared_award_fact_candidate_terminal_archive',
        'SELECT'
      )
      and not pg_catalog.has_table_privilege(
        'service_role',
        'public.shared_award_fact_candidate_terminal_archive',
        'INSERT'
      )
      and not pg_catalog.has_table_privilege(
        'service_role',
        'public.shared_award_fact_candidate_terminal_archive',
        'UPDATE'
      )
      and not pg_catalog.has_table_privilege(
        'service_role',
        'public.shared_award_fact_candidate_terminal_archive',
        'DELETE'
      )
      and not pg_catalog.has_table_privilege(
        'service_role',
        'public.shared_award_fact_candidate_terminal_archive',
        'TRUNCATE'
      )
      and not pg_catalog.has_table_privilege(
        'anon',
        'public.shared_award_fact_candidate_terminal_archive',
        'SELECT'
      )
      and not pg_catalog.has_table_privilege(
        'authenticated',
        'public.shared_award_fact_candidate_terminal_archive',
        'SELECT'
      ),
    'terminal candidate archive RLS, FK independence, or grants changed'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select not role.rolsuper and not role.rolreplication
      from pg_catalog.pg_roles role
      where role.oid = v_service_role_oid
    )
      and not exists (
        select 1
        from pg_catalog.pg_class class
        where class.oid in (
          'public.shared_awards'::pg_catalog.regclass,
          'public.shared_award_sources'::pg_catalog.regclass,
          'public.shared_award_fact_candidates'::pg_catalog.regclass,
          'public.shared_award_fact_candidate_terminal_archive'::pg_catalog.regclass
        )
          and class.relowner = v_service_role_oid
      )
      and not exists (
        select 1
        from pg_catalog.unnest(array[
          'public.shared_awards',
          'public.shared_award_sources',
          'public.shared_award_fact_candidates',
          'public.shared_award_fact_candidate_terminal_archive'
        ]::text[]) as relation(relation_name)
        where pg_catalog.has_table_privilege(
          'service_role', relation_name, 'TRUNCATE'
        )
          or pg_catalog.has_table_privilege(
            'service_role', relation_name, 'TRIGGER'
          )
      ),
    'service role can bypass candidate lifecycle triggers or owns evidence tables'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select procedure.prosecdef
        and procedure.provolatile = 'v'
        and coalesce('search_path=""' = any(procedure.proconfig), false)
      from pg_catalog.pg_proc procedure
      where procedure.oid = pg_catalog.to_regprocedure(
        'public.awardping_enforce_fact_candidate_status_lifecycle()'
      )
    )
      and not pg_catalog.has_function_privilege(
        'anon',
        'public.awardping_enforce_fact_candidate_status_lifecycle()',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated',
        'public.awardping_enforce_fact_candidate_status_lifecycle()',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'service_role',
        'public.awardping_enforce_fact_candidate_status_lifecycle()',
        'EXECUTE'
      )
      and (
        select not procedure.prosecdef
          and procedure.provolatile = 'v'
          and coalesce('search_path=""' = any(procedure.proconfig), false)
        from pg_catalog.pg_proc procedure
        where procedure.oid = pg_catalog.to_regprocedure(
          'private.prevent_terminal_candidate_archive_mutation()'
        )
      )
      and not pg_catalog.has_function_privilege(
        'service_role',
        'private.prevent_terminal_candidate_archive_mutation()',
        'EXECUTE'
      ),
    'candidate lifecycle trigger security settings or grants changed'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select pg_catalog.count(*) = 2
        and pg_catalog.bool_and(not trigger.tgisinternal)
        and pg_catalog.bool_and(trigger.tgenabled = 'O')
        -- Rendered trigger definitions are presentation text and may add quoting or omit
        -- "FOR EACH STATEMENT" across PostgreSQL versions. Assert the catalog
        -- contract instead: BEFORE (2) + DELETE (8), without the ROW bit (1).
        and pg_catalog.bool_and(trigger.tgtype = 10)
        and pg_catalog.bool_and(
          trigger.tgfoid = pg_catalog.to_regprocedure(
            'public.stage1_evidence_release_fence_before_statement()'
          )
        )
        and pg_catalog.bool_and(
          case trigger.tgname
            when 'stage1_candidate_parent_award_delete_release_fence' then
              trigger.tgrelid = 'public.shared_awards'::pg_catalog.regclass
            when 'stage1_candidate_parent_source_delete_release_fence' then
              trigger.tgrelid = 'public.shared_award_sources'::pg_catalog.regclass
            else false
          end
        )
      from pg_catalog.pg_trigger trigger
      where trigger.tgname in (
        'stage1_candidate_parent_award_delete_release_fence',
        'stage1_candidate_parent_source_delete_release_fence'
      )
    )
      and exists (
        select 1
        from pg_catalog.pg_trigger trigger
        where trigger.tgrelid =
          'public.shared_award_fact_candidate_terminal_archive'::pg_catalog.regclass
          and trigger.tgname = 'awardping_terminal_candidate_archive_immutable'
          and not trigger.tgisinternal
          and trigger.tgenabled = 'O'
          and trigger.tgfoid = pg_catalog.to_regprocedure(
            'private.prevent_terminal_candidate_archive_mutation()'
          )
          -- ROW (1) + BEFORE (2) + DELETE (8) + UPDATE (16).
          and trigger.tgtype = 27
      ),
    'candidate parent lock fences or archive immutability trigger changed'
  );

  perform pg_temp.awardping_probe_assert(
    v_wrapper_oid is not null and v_inner_oid is not null,
    'national-lock wrapper or private inner publication function is missing'
  );
  select pg_catalog.pg_get_functiondef(v_wrapper_oid) into v_definition;
  perform pg_temp.awardping_probe_assert(
    pg_catalog.strpos(v_definition, 'pg_advisory_xact_lock') > 0
      and pg_catalog.strpos(v_definition, 'pg_advisory_xact_lock')
        < pg_catalog.strpos(
          v_definition,
          'private.commit_award_reconciliation_publication_unfenced_20260716221500'
        ),
    'publication wrapper does not take the national lock before the inner call'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.has_function_privilege('service_role', v_wrapper_oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('anon', v_wrapper_oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', v_wrapper_oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('service_role', v_inner_oid, 'EXECUTE'),
    'publication wrapper/private-inner grants are incorrect'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select procedure.prosecdef
        and coalesce('search_path=""' = any(procedure.proconfig), false)
      from pg_catalog.pg_proc procedure
      where procedure.oid = v_wrapper_oid
    ),
    'publication wrapper is not a hardened SECURITY DEFINER function'
  );

  perform pg_temp.awardping_probe_assert(
    private.stage1_vault_access_contract_safe(),
    'a browser role or unexpected API RPC retains a Vault access path'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select procedure.proowner = (
          select role.oid from pg_catalog.pg_roles role where role.rolname = 'postgres'
        )
        and procedure.prosecdef
        and procedure.provolatile = 's'
        and coalesce('search_path=""' = any(procedure.proconfig), false)
      from pg_catalog.pg_proc procedure
      where procedure.oid = pg_catalog.to_regprocedure(
        'private.stage1_vault_access_contract_safe()'
      )
    )
      and not pg_catalog.has_function_privilege(
        'anon', 'private.stage1_vault_access_contract_safe()', 'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated', 'private.stage1_vault_access_contract_safe()', 'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'service_role', 'private.stage1_vault_access_contract_safe()', 'EXECUTE'
      ),
    'effective Vault privilege predicate security settings or grants changed'
  );
  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(
      'private.stage1_release_artifact_evidence_valid(text,jsonb)'
    )
  ) into v_definition;
  perform pg_temp.awardping_probe_assert(
    pg_catalog.strpos(
      v_definition, 'awardping.stage1.hosted-runtime-identity.v2'
    ) > 0
      and pg_catalog.strpos(
        v_definition, 'direct_no_redirect_https_and_vault_profile_get_v2'
      ) > 0
      and pg_catalog.strpos(v_definition, 'vault_profile_http_status') > 0
      and pg_catalog.strpos(v_definition, 'vault_profile_postgrest_code') > 0
      and pg_catalog.strpos(v_definition, 'PGRST106') > 0
      and pg_catalog.strpos(v_definition, 'vault_profile_response_sha256') > 0,
    'hosted runtime evidence validator lacks the service-key Vault profile denial'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select pg_catalog.count(*) = 2
        and pg_catalog.bool_and(
          procedure.proowner = (
            select role.oid from pg_catalog.pg_roles role where role.rolname = 'postgres'
          )
          and procedure.prosecdef
          and coalesce('search_path=""' = any(procedure.proconfig), false)
        )
      from pg_catalog.pg_proc procedure
      where procedure.oid = any(array[
        pg_catalog.to_regprocedure(
          'private.stage1_release_artifact_signature_valid(uuid,timestamp with time zone)'
        ),
        pg_catalog.to_regprocedure(
          'private.insert_stage1_external_release_artifact(text,text,text,text,text,text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)'
        )
      ])
    ),
    'postgres-owned Vault readers lost their hardened SECURITY DEFINER contract'
  );
  perform pg_temp.awardping_probe_assert(
    not exists (
      select 1
      from unnest(array[
        'public.record_stage1_hosted_runtime_identity_artifact(text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
        'public.record_stage1_rollback_drill_artifact(text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
        'public.record_stage1_non_cohort_leak_crawl_artifact(text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
        'public.record_stage1_r2_recovery_drill_artifact(text,text,jsonb,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
        'public.get_stage1_release_gate_snapshot()',
        'public.activate_stage1_release_from_acceptance(uuid,text,text,text)'
      ]) as signatures(signature)
      where pg_catalog.to_regprocedure(signature) is null
        or not pg_catalog.has_function_privilege(
          'service_role', pg_catalog.to_regprocedure(signature), 'EXECUTE'
        )
    ),
    'service_role lost a narrow Stage 1 SECURITY DEFINER entrypoint'
  );

  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(
      'private.stage1_gate_without_contact_fence_20260717123000(timestamp with time zone)'
    )
  ) into v_definition;
  perform pg_temp.awardping_probe_assert(
    pg_catalog.strpos(v_definition, 'run as worker_run') > 0
      and pg_catalog.strpos(
        v_definition,
        'private.stage1_6pm_shard_healthy(latest_runs.worker_run)'
      ) > 0
      and pg_catalog.strpos(
        v_definition,
        'private.stage1_6pm_shard_healthy(latest_runs)'
      ) = 0
      and pg_catalog.strpos(
        v_definition,
        'v_vault_access_contract_safe := private.stage1_vault_access_contract_safe()'
      ) > 0
      and pg_catalog.strpos(
        v_definition, 'vault_access_contract_failed'
      ) > 0
      and pg_catalog.strpos(v_definition, '''vault_security''') > 0,
    'Stage 1 gate is missing the composite or effective Vault contract'
  );
  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(
      'private.stage1_release_gate_snapshot(timestamp with time zone)'
    )
  ) into v_definition;
  perform pg_temp.awardping_probe_assert(
    pg_catalog.strpos(
      v_definition,
      'stage1_gate_without_contact_fence_20260717123000'
    ) > 0
      and pg_catalog.strpos(
        v_definition,
        'private.personal_data_legacy_contact_gate_snapshot()'
      ) > 0
      and pg_catalog.strpos(
        v_definition,
        'legacy_contact_ciphertext_not_safe'
      ) > 0
      and pg_catalog.strpos(
        v_definition,
        'public.stage1_publication_evidence_hash(v_basis)'
      ) > 0,
    'Stage 1 contact wrapper does not bind its exact delegate into the signed state hash'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select procedure.prosecdef
        and procedure.provolatile = 'v'
        and coalesce('search_path=""' = any(procedure.proconfig), false)
      from pg_catalog.pg_proc procedure
      where procedure.oid = pg_catalog.to_regprocedure(
        'private.stage1_release_gate_snapshot(timestamp with time zone)'
      )
    )
      and not pg_catalog.has_function_privilege(
        'anon',
        'private.stage1_release_gate_snapshot(timestamp with time zone)',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated',
        'private.stage1_release_gate_snapshot(timestamp with time zone)',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'service_role',
        'private.stage1_release_gate_snapshot(timestamp with time zone)',
        'EXECUTE'
      ),
    'Stage 1 gate security settings or grants changed'
  );

  v_gate_snapshot := private.stage1_release_gate_snapshot(
    pg_catalog.clock_timestamp()
  );
  perform pg_temp.awardping_probe_assert(
    v_gate_snapshot ->> 'state' = 'HOLD'
      and v_gate_snapshot ->> 'state_hash' ~ '^[0-9a-f]{64}$'
      and v_gate_snapshot #>> '{vault_security,api_surface_safe}' = 'true'
      and v_gate_snapshot #>>
        '{vault_security,service_role_data_api_profile_blocked}' = 'false'
      and v_gate_snapshot -> 'failures'
        @> '["vault_access_contract_failed"]'::jsonb
      and v_gate_snapshot #>> '{personal_data_legacy_contacts,state}' = 'SAFE'
      and pg_catalog.jsonb_typeof(v_gate_snapshot -> 'failures') = 'array',
    'Stage 1 gate did not execute to a fail-closed signed snapshot'
  );

  -- Prove behavioral fail-closure rather than only matching SQL text. This
  -- grant and its cleanup are both inside the transaction that is rolled back.
  grant usage on schema vault to authenticated;
  perform pg_temp.awardping_probe_assert(
    not private.stage1_vault_access_contract_safe(),
    'effective Vault predicate did not detect a later browser-role regrant'
  );
  v_gate_after_regrant := private.stage1_release_gate_snapshot(
    pg_catalog.clock_timestamp()
  );
  perform pg_temp.awardping_probe_assert(
    v_gate_after_regrant ->> 'state' = 'HOLD'
      and v_gate_after_regrant #>> '{vault_security,api_surface_safe}' = 'false'
      and v_gate_after_regrant #>>
        '{vault_security,service_role_data_api_profile_blocked}' = 'false'
      and v_gate_after_regrant -> 'failures'
        @> '["vault_access_contract_failed"]'::jsonb
      and v_gate_after_regrant ->> 'state_hash' ~ '^[0-9a-f]{64}$'
      and v_gate_after_regrant ->> 'state_hash'
        <> v_gate_snapshot ->> 'state_hash',
    'a later Vault regrant did not force HOLD and change the signed state hash'
  );
  revoke usage on schema vault from authenticated;
  perform pg_temp.awardping_probe_assert(
    private.stage1_vault_access_contract_safe(),
    'effective Vault predicate did not recover after removing the probe grant'
  );
end;
$schema_contract$;

-- Exercise the privacy RPCs against real PostgreSQL rows. The deliberate
-- AP001/AP002 exceptions roll each fixture subtransaction back immediately,
-- before any later release-gate behavior is evaluated.
do $privacy_rpc_contract$
declare
  v_user_id uuid;
  v_legacy_subscriber_id uuid := '00000000-0000-4000-8000-00000000e101'::uuid;
  v_canonical_subscriber_id uuid := '00000000-0000-4000-8000-00000000e102'::uuid;
  v_outbox_one_id uuid := '00000000-0000-4000-8000-00000000e111'::uuid;
  v_outbox_two_id uuid := '00000000-0000-4000-8000-00000000e112'::uuid;
  v_privacy_request_id uuid := '00000000-0000-4000-8000-00000000e121'::uuid;
  v_tombstone_legacy_id uuid := '00000000-0000-4000-8000-00000000e122'::uuid;
  v_active_subscriber_id uuid := '00000000-0000-4000-8000-00000000e131'::uuid;
  v_active_outbox_id uuid := '00000000-0000-4000-8000-00000000e132'::uuid;
  v_release_epoch uuid := '00000000-0000-4000-8000-00000000e140'::uuid;
  v_legacy_lookup_hash text := public.awardping_sha256_text(
    'awardping-stage1-probe-legacy-lookup'
  );
  v_canonical_hash text := public.awardping_sha256_text(
    'awardping-stage1-probe-canonical-v2'
  );
  v_erasure_hash text := public.awardping_sha256_text(
    'awardping-stage1-probe-erasure-v2'
  );
  v_result jsonb;
  v_export jsonb;
  v_marker jsonb;
  v_marker_basis text;
  v_active_lease_blocked boolean := false;
begin
  select auth_user.id
  into v_user_id
  from auth.users auth_user
  order by auth_user.id
  limit 1;
  perform pg_temp.awardping_probe_assert(
    v_user_id is not null,
    'privacy RPC behavior probe requires one existing Auth user'
  );

  begin
    -- Isolate the behavior fixture from pre-existing quarantined history. The
    -- enclosing AP001 subtransaction restores every row and trigger state.
    alter table public.personal_data_legacy_contact_quarantine
      disable trigger freeze_legacy_contact_quarantine_evidence_trigger;
    update public.personal_data_legacy_contact_quarantine quarantine
    set
      ciphertext_sha256 = null,
      v2_email_hash = public.awardping_sha256_text(
        'stage1-privacy-probe-temporary-resolution|' || quarantine.id::text
      ),
      lifecycle_status = 'recovered_v2',
      resolution = 'temporary_transactional_privacy_rpc_probe_resolution',
      resolved_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
    where quarantine.lifecycle_status = 'disabled_retained';
    alter table public.personal_data_legacy_contact_quarantine
      enable trigger freeze_legacy_contact_quarantine_evidence_trigger;

    insert into public.public_update_subscribers (
      id, email, email_hash, email_encrypted, status,
      confirmation_token_hash, unsubscribe_token_hash
    ) values
      (
        v_legacy_subscriber_id, null, v_legacy_lookup_hash,
        'ap:v1:stage1-probe-legacy-subscriber', 'unsubscribed', null,
        'stage1-probe-legacy-unsubscribe'
      ),
      (
        v_canonical_subscriber_id, null, v_canonical_hash,
        'ap:v2:stage1-probe-canonical-subscriber', 'unsubscribed', null,
        'stage1-probe-canonical-unsubscribe'
      );

    alter table public.public_digest_outbox
      disable trigger sync_public_digest_event_receipts_after_insert;
    insert into public.public_digest_outbox (
      id, subscriber_id, digest_key, recipient_hash, recipient_encrypted,
      release_key, release_epoch, release_policy_version,
      release_identity_version, release_identity_hash, change_event_ids,
      event_bindings, rendered_payload, payload_schema_version, payload_hash,
      eligibility_seal_hash, provider_idempotency_key, status, batch_sequence
    ) values
      (
        v_outbox_one_id, v_legacy_subscriber_id, '2099-12-30',
        v_legacy_lookup_hash, 'ap:v1:stage1-probe-outbox-one',
        'stage1-national-25', v_release_epoch, 'probe-policy-v1',
        'probe-identity-v1', pg_catalog.repeat('7', 64),
        array['00000000-0000-4000-8000-00000000e151'::uuid],
        '[{"change_event_id":"00000000-0000-4000-8000-00000000e151"}]'::jsonb,
        '{"probe":1}'::jsonb, 'public-digest-render-v1',
        pg_catalog.repeat('3', 64), pg_catalog.repeat('5', 64),
        'awardping-public-digest:' || pg_catalog.repeat('3', 64),
        'terminal_failed', 1
      ),
      (
        v_outbox_two_id, v_legacy_subscriber_id, '2099-12-30',
        v_legacy_lookup_hash, 'ap:v1:stage1-probe-outbox-two',
        'stage1-national-25', v_release_epoch, 'probe-policy-v1',
        'probe-identity-v1', pg_catalog.repeat('7', 64),
        array['00000000-0000-4000-8000-00000000e152'::uuid],
        '[{"change_event_id":"00000000-0000-4000-8000-00000000e152"}]'::jsonb,
        '{"probe":2}'::jsonb, 'public-digest-render-v1',
        pg_catalog.repeat('4', 64), pg_catalog.repeat('6', 64),
        'awardping-public-digest:' || pg_catalog.repeat('4', 64),
        'terminal_failed', 2
      );
    alter table public.public_digest_outbox
      enable trigger sync_public_digest_event_receipts_after_insert;

    perform public.quarantine_legacy_contact_ciphertext(
      'public_update_subscribers',
      v_legacy_subscriber_id,
      (select subscriber.updated_at from public.public_update_subscribers subscriber
        where subscriber.id = v_legacy_subscriber_id),
      public.awardping_sha256_text('ap:v1:stage1-probe-legacy-subscriber')
    );
    perform public.quarantine_legacy_contact_ciphertext(
      'public_digest_outbox',
      v_outbox_one_id,
      (select outbox.updated_at from public.public_digest_outbox outbox
        where outbox.id = v_outbox_one_id),
      public.awardping_sha256_text('ap:v1:stage1-probe-outbox-one')
    );
    perform public.quarantine_legacy_contact_ciphertext(
      'public_digest_outbox',
      v_outbox_two_id,
      (select outbox.updated_at from public.public_digest_outbox outbox
        where outbox.id = v_outbox_two_id),
      public.awardping_sha256_text('ap:v1:stage1-probe-outbox-two')
    );

    v_result := public.recover_legacy_contact_ciphertext(
      'public_update_subscribers',
      v_legacy_subscriber_id,
      (select subscriber.updated_at from public.public_update_subscribers subscriber
        where subscriber.id = v_legacy_subscriber_id),
      public.awardping_sha256_text('ap:v1:stage1-probe-legacy-subscriber'),
      v_legacy_lookup_hash,
      v_canonical_hash,
      'ap:v2:stage1-probe-recovered-subscriber'
    );
    perform pg_temp.awardping_probe_assert(
      v_result ->> 'state' = 'canonical_v2_merged'
        and not exists (
          select 1 from public.public_update_subscribers subscriber
          where subscriber.id = v_legacy_subscriber_id
        )
        and (
          select pg_catalog.count(*) = 2
          from public.public_digest_outbox outbox
          where outbox.id in (v_outbox_one_id, v_outbox_two_id)
            and outbox.status = 'privacy_scrubbed'
            and outbox.subscriber_id is null
            and outbox.recipient_hash is null
            and outbox.recipient_encrypted is null
            and outbox.rendered_payload is null
        )
        and (
          select pg_catalog.count(*) = 3
          from public.personal_data_legacy_contact_quarantine quarantine
          where (
            quarantine.source_record_id = v_legacy_subscriber_id
            or quarantine.source_record_id in (v_outbox_one_id, v_outbox_two_id)
          )
            and quarantine.lifecycle_status = 'recovered_v2'
            and quarantine.v2_email_hash = v_canonical_hash
            and quarantine.ciphertext_sha256 is null
        ),
      'canonical subscriber recovery did not scrub and resolve every linked outbox'
    );

    v_export := public.get_personal_data_legacy_contact_export(v_canonical_hash);
    perform pg_temp.awardping_probe_assert(
      v_export ->> 'state' = 'complete'
        and (v_export ->> 'unattributable_retained_items')::bigint = 0
        and pg_catalog.jsonb_array_length(v_export -> 'items') = 3,
      'legacy contact export did not return every exactly linked recovered artifact'
    );

    insert into public.privacy_requests (
      id, user_id, email_hash, request_type, status, details
    ) values (
      v_privacy_request_id,
      v_user_id,
      v_erasure_hash,
      'delete',
      'pending',
      '{}'::jsonb
    );
    v_result := public.erase_personal_data_for_privacy_request(
      v_user_id,
      v_erasure_hash,
      'stage1-probe-user@example.invalid',
      v_privacy_request_id
    );
    v_marker := v_result -> 'app_data_erasure_marker';
    v_marker_basis := pg_catalog.concat_ws(
      '|',
      v_marker ->> 'schema_version',
      v_marker ->> 'state',
      v_marker ->> 'privacy_request_id',
      v_marker ->> 'user_id',
      coalesce(v_marker ->> 'email_hash', '<null>'),
      v_marker ->> 'completed_at'
    );
    perform pg_temp.awardping_probe_assert(
      v_marker ->> 'schema_version' = 'privacy-app-data-erasure-v1'
        and v_marker ->> 'state' = 'completed'
        and v_marker ->> 'privacy_request_id' = v_privacy_request_id::text
        and v_marker ->> 'user_id' = v_user_id::text
        and v_marker ->> 'email_hash' = v_erasure_hash
        and v_marker ->> 'completed_at' ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
        and v_marker ->> 'evidence_hash' =
          public.awardping_sha256_text(v_marker_basis)
        and (
          select privacy_request.details -> 'app_data_erasure' = v_marker
          from public.privacy_requests privacy_request
          where privacy_request.id = v_privacy_request_id
            and privacy_request.status = 'pending'
        ),
      'privacy erasure did not atomically persist its deterministic completion marker'
    );

    insert into public.public_update_subscribers (
      id, email, email_hash, email_encrypted, status,
      confirmation_token_hash, unsubscribe_token_hash
    ) values (
      v_tombstone_legacy_id, null, v_legacy_lookup_hash,
      'ap:v1:stage1-probe-tombstone-late-arrival', 'unsubscribed', null,
      'stage1-probe-tombstone-unsubscribe'
    );
    perform public.quarantine_legacy_contact_ciphertext(
      'public_update_subscribers',
      v_tombstone_legacy_id,
      (select subscriber.updated_at from public.public_update_subscribers subscriber
        where subscriber.id = v_tombstone_legacy_id),
      public.awardping_sha256_text('ap:v1:stage1-probe-tombstone-late-arrival')
    );
    v_result := public.recover_legacy_contact_ciphertext(
      'public_update_subscribers',
      v_tombstone_legacy_id,
      (select subscriber.updated_at from public.public_update_subscribers subscriber
        where subscriber.id = v_tombstone_legacy_id),
      public.awardping_sha256_text('ap:v1:stage1-probe-tombstone-late-arrival'),
      v_legacy_lookup_hash,
      v_erasure_hash,
      'ap:v2:stage1-probe-tombstone-blocked'
    );
    perform pg_temp.awardping_probe_assert(
      v_result ->> 'state' = 'erased_by_tombstone'
        and not exists (
          select 1 from public.public_update_subscribers subscriber
          where subscriber.id = v_tombstone_legacy_id
        )
        and exists (
          select 1
          from public.personal_data_legacy_contact_quarantine quarantine
          where quarantine.source_record_id = v_tombstone_legacy_id
            and quarantine.lifecycle_status = 'erased_by_tombstone'
            and quarantine.erasure_tombstone_id is not null
        ),
      'a prior privacy tombstone did not defeat later legacy recovery'
    );

    raise exception using
      errcode = 'AP001',
      message = 'rollback privacy RPC behavior fixtures';
  exception when sqlstate 'AP001' then
    null;
  end;

  perform pg_temp.awardping_probe_assert(
    not exists (
      select 1 from public.public_update_subscribers subscriber
      where subscriber.id in (
        v_legacy_subscriber_id, v_canonical_subscriber_id, v_tombstone_legacy_id
      )
    )
      and not exists (
        select 1 from public.public_digest_outbox outbox
        where outbox.id in (v_outbox_one_id, v_outbox_two_id)
      )
      and not exists (
        select 1 from public.privacy_requests privacy_request
        where privacy_request.id = v_privacy_request_id
      ),
    'privacy RPC behavior fixture subtransaction did not roll back cleanly'
  );

  begin
    alter table public.public_digest_outbox
      drop constraint public_digest_outbox_non_v2_not_sendable_check;
    insert into public.public_update_subscribers (
      id, email, email_hash, email_encrypted, status,
      confirmation_token_hash, unsubscribe_token_hash
    ) values (
      v_active_subscriber_id, null, v_legacy_lookup_hash,
      'ap:v1:stage1-probe-active-subscriber', 'unsubscribed', null,
      'stage1-probe-active-unsubscribe'
    );
    alter table public.public_digest_outbox
      disable trigger sync_public_digest_event_receipts_after_insert;
    insert into public.public_digest_outbox (
      id, subscriber_id, digest_key, recipient_hash, recipient_encrypted,
      release_key, release_epoch, release_policy_version,
      release_identity_version, release_identity_hash, change_event_ids,
      event_bindings, rendered_payload, payload_schema_version, payload_hash,
      eligibility_seal_hash, provider_idempotency_key, status,
      lease_token, last_claim_token, lease_owner, leased_at, lease_expires_at
    ) values (
      v_active_outbox_id, v_active_subscriber_id, '2099-12-31',
      v_legacy_lookup_hash, 'ap:v1:stage1-probe-active-outbox',
      'stage1-national-25', v_release_epoch, 'probe-policy-v1',
      'probe-identity-v1', pg_catalog.repeat('7', 64),
      array['00000000-0000-4000-8000-00000000e153'::uuid],
      '[{"change_event_id":"00000000-0000-4000-8000-00000000e153"}]'::jsonb,
      '{"probe":3}'::jsonb, 'public-digest-render-v1',
      pg_catalog.repeat('8', 64), pg_catalog.repeat('9', 64),
      'awardping-public-digest:' || pg_catalog.repeat('8', 64),
      'sending',
      '00000000-0000-4000-8000-00000000e154'::uuid,
      '00000000-0000-4000-8000-00000000e154'::uuid,
      'stage1-privacy-probe',
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp() + interval '10 minutes'
    );
    alter table public.public_digest_outbox
      enable trigger sync_public_digest_event_receipts_after_insert;
    perform public.quarantine_legacy_contact_ciphertext(
      'public_update_subscribers',
      v_active_subscriber_id,
      (select subscriber.updated_at from public.public_update_subscribers subscriber
        where subscriber.id = v_active_subscriber_id),
      public.awardping_sha256_text('ap:v1:stage1-probe-active-subscriber')
    );
    begin
      perform public.recover_legacy_contact_ciphertext(
        'public_update_subscribers',
        v_active_subscriber_id,
        (select subscriber.updated_at from public.public_update_subscribers subscriber
          where subscriber.id = v_active_subscriber_id),
        public.awardping_sha256_text('ap:v1:stage1-probe-active-subscriber'),
        v_legacy_lookup_hash,
        v_canonical_hash,
        'ap:v2:stage1-probe-active-recovery'
      );
    exception when serialization_failure then
      v_active_lease_blocked := true;
    end;
    perform pg_temp.awardping_probe_assert(
      v_active_lease_blocked,
      'legacy recovery did not fail closed around an active provider lease'
    );
    raise exception using
      errcode = 'AP002',
      message = 'rollback active-lease privacy fixture';
  exception when sqlstate 'AP002' then
    null;
  end;

  perform pg_temp.awardping_probe_assert(
    exists (
        select 1
        from pg_catalog.pg_constraint constraint_row
        where constraint_row.conrelid =
            'public.public_digest_outbox'::pg_catalog.regclass
          and constraint_row.conname =
            'public_digest_outbox_non_v2_not_sendable_check'
      )
      and not exists (
        select 1 from public.public_update_subscribers subscriber
        where subscriber.id = v_active_subscriber_id
      )
      and not exists (
        select 1 from public.public_digest_outbox outbox
        where outbox.id = v_active_outbox_id
      ),
    'active-lease privacy fixture or temporary constraint change leaked state'
  );
end;
$privacy_rpc_contract$;

do $canonical_authority_contract$
declare
  v_identity_update_rejected boolean := false;
  v_delegation_delete_rejected boolean := false;
begin
  perform pg_temp.awardping_probe_assert(
    (
      select pg_catalog.count(*) = 2
      from (
        values
          (
            'hertz'::text,
            '4d2f6a7f-024e-4194-be31-1b9f63e497bc'::uuid,
            'https://www.hertzfoundation.org/hertz-fellowship/'::text
          ),
          (
            'ndseg'::text,
            'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid,
            'https://ndseg.org/'::text
          )
      ) expected(cohort_key, award_id, homepage)
      join public.stage1_award_registry registry
        on registry.cohort_key = expected.cohort_key
       and registry.canonical_shared_award_id = expected.award_id
       and registry.official_homepage = expected.homepage
      join public.shared_awards award
        on award.id = expected.award_id
       and award.official_homepage = expected.homepage
    ),
    'reviewed Hertz/NDSEG canonical homepages were not applied exactly'
  );
  perform pg_temp.awardping_probe_assert(
    exists (
      select 1
      from private.stage1_canonical_identity_evidence identity_evidence
      where identity_evidence.identity_key =
          'hertz-current-fellowship-root-2026-07-17'
        and identity_evidence.previous_homepage =
          'https://www.hertzfoundation.org/the-fellowship/'
        and identity_evidence.current_homepage =
          'https://www.hertzfoundation.org/hertz-fellowship/'
        and identity_evidence.evidence_hash =
          public.stage1_publication_evidence_hash(identity_evidence.evidence)
    )
      and exists (
        select 1
        from private.stage1_delegated_source_authority_evidence delegation
        where delegation.authority_key =
            'ndseg-sysplus-current-contractor-2026-07-17'
          and delegation.canonical_homepage = 'https://ndseg.org/'
          and delegation.delegated_host = 'ndseg.sysplus.com'
          and delegation.classification = 'official_contractor_host'
          and delegation.authority_evidence_url = 'https://ndseg.org/apply-link'
          and delegation.evidence_hash =
            public.stage1_publication_evidence_hash(delegation.evidence)
      ),
    'immutable Hertz identity or NDSEG contractor-authority evidence is incomplete'
  );
  perform pg_temp.awardping_probe_assert(
    private.stage1_manifest_source_authority_valid(
      'ndseg',
      'identity_home',
      'https://ndseg.org/',
      'https://ndseg.org/',
      'stage1-publication-v1',
      pg_catalog.jsonb_build_object(
        'source_url', 'https://ndseg.org/',
        'official_identity', pg_catalog.jsonb_build_object(
          'host', 'ndseg.org',
          'classification', 'canonical_program_host',
          'evidence_url', 'https://ndseg.org/',
          'reviewed_reason', 'Exact canonical NDSEG homepage.'
        )
      )
    ),
    'exact canonical NDSEG identity_home was rejected by the authority gate'
  );
  perform pg_temp.awardping_probe_assert(
    private.stage1_manifest_source_authority_valid(
      'ndseg',
      'dates_cycle',
      'https://ndseg.sysplus.com/NDSEG/Applicants/How-to-Apply',
      'https://ndseg.org/',
      'stage1-publication-v1',
      pg_catalog.jsonb_build_object(
        'source_url',
          'https://ndseg.sysplus.com/NDSEG/Applicants/How-to-Apply',
        'official_identity', pg_catalog.jsonb_build_object(
          'host', 'ndseg.sysplus.com',
          'classification', 'official_contractor_host',
          'evidence_url', 'https://ndseg.org/apply-link',
          'reviewed_reason', 'The canonical NDSEG apply link delegates to SysPlus.'
        )
      )
    ),
    'exact reviewed SysPlus non-identity source was rejected by the authority gate'
  );
  perform pg_temp.awardping_probe_assert(
    not private.stage1_manifest_source_authority_valid(
      'ndseg',
      'dates_cycle',
      'https://unrelated.example/ndseg-dates',
      'https://ndseg.org/',
      'stage1-publication-v1',
      pg_catalog.jsonb_build_object(
        'source_url', 'https://unrelated.example/ndseg-dates',
        'official_identity', pg_catalog.jsonb_build_object(
          'host', 'unrelated.example',
          'classification', 'official_contractor_host',
          'evidence_url', 'https://ndseg.org/apply-link',
          'reviewed_reason', 'Forged same-cohort source binding must fail.'
        )
      )
    ),
    'an unrelated NDSEG-owned source host bypassed delegated authority'
  );
  perform pg_temp.awardping_probe_assert(
    not private.stage1_manifest_source_authority_valid(
      'ndseg',
      'identity_home',
      'https://ndseg.sysplus.com/',
      'https://ndseg.org/',
      'stage1-publication-v1',
      pg_catalog.jsonb_build_object(
        'source_url', 'https://ndseg.sysplus.com/',
        'official_identity', pg_catalog.jsonb_build_object(
          'host', 'ndseg.sysplus.com',
          'classification', 'official_contractor_host',
          'evidence_url', 'https://ndseg.org/apply-link',
          'reviewed_reason', 'Contractor source cannot become identity_home.'
        )
      )
    ),
    'the SysPlus contractor source was accepted as NDSEG identity_home'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.strpos(
      pg_catalog.pg_get_functiondef(
        pg_catalog.to_regprocedure(
          'public.stage1_effective_publication_reason(text,timestamp with time zone)'
        )
      ),
      'private.stage1_manifest_source_authority_valid('
    ) > 0,
    'the authoritative Stage 1 publication reason does not enforce source authority'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select release_state.cohort_identity_version = 'stage1-national-25-v2'
        and release_state.cohort_identity_hash =
          '6e7dd7ee1372671cbfb22b17b862d867145a93c7dc0b73d49afc11f504ee6c8f'
      from public.stage1_publication_release_state release_state
      where release_state.release_key = 'stage1-national-25'
    ),
    'Stage 1 release state did not bind canonical identity v2'
  );
  perform pg_temp.awardping_probe_assert(
    exists (
      select 1
      from public.manual_quarantine_registry quarantine
      where quarantine.quarantine_key =
          'stage1:ndseg:official-deadline-conflict:2026-07-17'
        and quarantine.status = 'quarantined'
        and quarantine.requires_action
        and quarantine.severity = 'high'
        and quarantine.public_impact = 'blocked'
        and quarantine.retry_charge = 'none'
        and quarantine.evidence ->> 'publication_decision' = 'not_published'
        and quarantine.evidence ->> 'authority_evidence_url' =
          'https://ndseg.org/apply-link'
        and quarantine.evidence -> 'conflicting_sources' @>
          '[{"url":"https://ndseg.sysplus.com/","reported_cycle":"FY2027","reported_open_date":"August 3, 2026","reported_deadline":"October 30, 2026 (5 PM Eastern)"},{"url":"https://ndseg.sysplus.com/NDSEG/Applicants/How-to-Apply","reported_cycle":"next application cycle","reported_open_date":"August 15","reported_deadline":"November 15"}]'::jsonb
    ),
    'NDSEG conflicting deadline was not retained as an unavailable operator quarantine'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select class.relrowsecurity
      from pg_catalog.pg_class class
      where class.oid =
        'private.stage1_canonical_identity_evidence'::pg_catalog.regclass
    )
      and (
        select class.relrowsecurity
        from pg_catalog.pg_class class
        where class.oid =
          'private.stage1_delegated_source_authority_evidence'::pg_catalog.regclass
      )
      and pg_catalog.has_table_privilege(
        'service_role',
        'private.stage1_canonical_identity_evidence',
        'SELECT'
      )
      and not pg_catalog.has_table_privilege(
        'service_role',
        'private.stage1_canonical_identity_evidence',
        'INSERT,UPDATE,DELETE'
      )
      and not pg_catalog.has_table_privilege(
        'authenticated',
        'private.stage1_delegated_source_authority_evidence',
        'SELECT'
      )
      and not pg_catalog.has_function_privilege(
        'service_role',
        'private.prevent_stage1_canonical_identity_evidence_mutation()',
        'EXECUTE'
      ),
    'canonical-authority evidence RLS, grants, or immutable trigger ACL changed'
  );

  begin
    update private.stage1_canonical_identity_evidence
    set evidence_summary = 'Mutation must fail.'
    where identity_key = 'hertz-current-fellowship-root-2026-07-17';
  exception when sqlstate '55000' then
    v_identity_update_rejected := true;
  end;
  begin
    delete from private.stage1_delegated_source_authority_evidence
    where authority_key = 'ndseg-sysplus-current-contractor-2026-07-17';
  exception when sqlstate '55000' then
    v_delegation_delete_rejected := true;
  end;
  perform pg_temp.awardping_probe_assert(
    v_identity_update_rejected
      and v_delegation_delete_rejected
      and (
        select pg_catalog.count(*) = 1
        from private.stage1_canonical_identity_evidence
        where identity_key = 'hertz-current-fellowship-root-2026-07-17'
      )
      and (
        select pg_catalog.count(*) = 1
        from private.stage1_delegated_source_authority_evidence
        where authority_key = 'ndseg-sysplus-current-contractor-2026-07-17'
      ),
    'canonical-authority evidence was mutable or a failed mutation leaked state'
  );
end;
$canonical_authority_contract$;

-- A first sync is allowed to reconcile genuinely stale quarantine rows. Prove
-- that an exact replay performs no registry update and does not advance either
-- the audit log or the operator backlog cursor.
insert into public.manual_quarantine_registry (
  id,
  quarantine_key,
  case_key,
  classification,
  category,
  status,
  requires_action,
  terminal,
  terminal_failure_count,
  severity,
  public_impact,
  owner,
  retry_mode,
  retry_charge,
  title,
  reason_code,
  reason,
  recommended_action,
  primary_source_table,
  primary_source_record_id,
  evidence_record_count,
  evidence,
  evidence_hash,
  policy_id,
  policy_version,
  policy_hash,
  first_observed_at,
  last_observed_at
) values (
  '00000000-0000-4000-8000-00000000e001'::uuid,
  'awardping-stage1-rollback-probe-generic-resolution',
  'awardping-stage1-rollback-probe-generic-resolution',
  'actionable_quarantine',
  'public_page',
  'quarantined',
  true,
  false,
  0,
  'medium',
  'unknown',
  'rollback-probe',
  'Retry after generic source evidence changes.',
  'none',
  'Rollback probe generic quarantine',
  'rollback_probe_generic_resolution',
  'This generic policy case has no award and must resolve on the first sync.',
  'No operator action; this row exists only inside the rollback probe.',
  'stage1_pending_migration_rollback_probe',
  '00000000-0000-4000-8000-00000000e002'::uuid,
  1,
  '{"probe":"generic_resolvable_case"}'::jsonb,
  public.manual_quarantine_evidence_hash(
    '{"probe":"generic_resolvable_case"}'::jsonb
  ),
  'awardping-manual-quarantine',
  '1',
  '4a12c7a0c4e088bca3b5c4b9ef28c6ddb8b108ac8b324c23dbde4aa5e0646ae4',
  pg_catalog.statement_timestamp() - interval '1 day',
  pg_catalog.statement_timestamp() - interval '1 day'
);

do $quarantine_incremental_contract$
declare
  v_first_result jsonb;
  v_second_result jsonb;
  v_events_after_first bigint;
  v_events_after_second bigint;
  v_rows_after_first jsonb;
  v_rows_after_second jsonb;
  v_backlog_revision_after_first bigint;
  v_backlog_revision_after_second bigint;
  v_backlog_updated_after_first timestamptz;
  v_backlog_updated_after_second timestamptz;
  v_custom_before jsonb;
  v_custom_after_first jsonb;
  v_custom_after_second jsonb;
begin
  select pg_catalog.to_jsonb(quarantine)
  into strict v_custom_before
  from public.manual_quarantine_registry quarantine
  where quarantine.quarantine_key =
    'stage1:ndseg:official-deadline-conflict:2026-07-17';

  v_first_result := public.sync_manual_quarantine_registry();
  select pg_catalog.to_jsonb(quarantine)
  into strict v_custom_after_first
  from public.manual_quarantine_registry quarantine
  where quarantine.quarantine_key =
    'stage1:ndseg:official-deadline-conflict:2026-07-17';
  select pg_catalog.count(*)
  into strict v_events_after_first
  from public.manual_quarantine_registry_events;
  select coalesce(
    pg_catalog.jsonb_object_agg(
      registry.id::text,
      pg_catalog.to_jsonb(registry.updated_at)
      order by registry.id
    ),
    '{}'::jsonb
  )
  into strict v_rows_after_first
  from public.manual_quarantine_registry registry;
  select state.revision, state.updated_at
  into strict v_backlog_revision_after_first, v_backlog_updated_after_first
  from public.manual_quarantine_backlog_state state
  where state.state_key = 'operator_backlog';

  v_second_result := public.sync_manual_quarantine_registry();
  select pg_catalog.to_jsonb(quarantine)
  into strict v_custom_after_second
  from public.manual_quarantine_registry quarantine
  where quarantine.quarantine_key =
    'stage1:ndseg:official-deadline-conflict:2026-07-17';
  select pg_catalog.count(*)
  into strict v_events_after_second
  from public.manual_quarantine_registry_events;
  select coalesce(
    pg_catalog.jsonb_object_agg(
      registry.id::text,
      pg_catalog.to_jsonb(registry.updated_at)
      order by registry.id
    ),
    '{}'::jsonb
  )
  into strict v_rows_after_second
  from public.manual_quarantine_registry registry;
  select state.revision, state.updated_at
  into strict v_backlog_revision_after_second, v_backlog_updated_after_second
  from public.manual_quarantine_backlog_state state
  where state.state_key = 'operator_backlog';

  perform pg_temp.awardping_probe_assert(
    pg_catalog.jsonb_typeof(v_first_result) = 'object'
      and pg_catalog.jsonb_typeof(v_second_result) = 'object',
    'optimized quarantine sync did not complete twice'
  );
  perform pg_temp.awardping_probe_assert(
    v_custom_after_first = v_custom_before
      and v_custom_after_second = v_custom_before
      and v_custom_before ->> 'status' = 'quarantined'
      and exists (
        select 1
        from public.manual_quarantine_registry quarantine
        where quarantine.id =
          '00000000-0000-4000-8000-00000000e001'::uuid
          and quarantine.status = 'resolved'
          and quarantine.resolved_by = 'manual-quarantine-sync'
      ),
    'quarantine sync did not preserve the custom NDSEG case while resolving a generic case'
  );
  perform pg_temp.awardping_probe_assert(
    v_events_after_second = v_events_after_first,
    'second optimized quarantine sync emitted a registry audit event'
  );
  perform pg_temp.awardping_probe_assert(
    v_rows_after_second = v_rows_after_first,
    'second optimized quarantine sync changed a registry row updated_at'
  );
  perform pg_temp.awardping_probe_assert(
    v_backlog_revision_after_second = v_backlog_revision_after_first
      and v_backlog_updated_after_second = v_backlog_updated_after_first,
    'second optimized quarantine sync advanced the operator backlog revision'
  );
end;
$quarantine_incremental_contract$;

insert into public.shared_awards (
  id, search_key, name, slug, official_homepage, summary, public_facts,
  confidence, status, source
) values (
  '00000000-0000-4000-8000-00000000a001'::uuid,
  'awardping-stage1-rollback-probe-do-not-commit',
  'AwardPing Stage 1 Rollback Probe',
  'awardping-stage1-rollback-probe-do-not-commit',
  'https://example.invalid/awardping-stage1-rollback-probe',
  'Rollback-only linked migration fixture.',
  '{"probe":"unchanged"}'::jsonb,
  1,
  'active',
  'admin'
);
insert into public.shared_award_sources (
  id, shared_award_id, url, title, page_type, confidence, reason, source
) values (
  '00000000-0000-4000-8000-00000000a002'::uuid,
  '00000000-0000-4000-8000-00000000a001'::uuid,
  'https://example.invalid/awardping-stage1-rollback-probe/source',
  'Rollback probe source',
  'other',
  1,
  'Rollback-only linked migration fixture.',
  'admin'
);

-- Attach the rollback-only award as an alias while its cohort is not
-- released. This lets the candidate trigger exercise a real Stage 1 row
-- without changing any production award evidence outside this transaction.
do $candidate_stage1_setup$
declare
  v_cohort_key text;
begin
  select registry.cohort_key into v_cohort_key
  from public.stage1_award_registry registry
  order by registry.launch_rank
  limit 1;
  update public.stage1_award_registry registry
  set
    publication_state = 'revalidation_pending',
    release_epoch = null,
    state_reason = 'Rollback probe candidate-trigger setup.',
    evidence_checked_at = null,
    updated_at = pg_catalog.statement_timestamp()
  where registry.cohort_key = v_cohort_key;
  insert into public.stage1_award_members (
    shared_award_id, cohort_key, member_kind, reason
  ) values (
    '00000000-0000-4000-8000-00000000a001'::uuid,
    v_cohort_key,
    'alias',
    'Rollback-only candidate invalidation probe.'
  );
end;
$candidate_stage1_setup$;

do $regression_contract$
declare
  v_award_id constant uuid := '00000000-0000-4000-8000-00000000a001'::uuid;
  v_acceptance_id constant uuid := '00000000-0000-4000-8000-00000000a00a'::uuid;
  v_release_epoch constant uuid := '00000000-0000-4000-8000-00000000b001'::uuid;
  v_acceptance_hash constant text := pg_catalog.repeat('b', 64);
  v_cohort_key text;
  v_fact_ledger_batch_id uuid;
  v_deterministic_page_audit_id uuid;
  v_stage1_row_count integer;
  v_ready_acceptance_count integer;
  v_award_event_count bigint;
  v_release_event_count bigint;
  v_activation_blocked boolean := false;
  v_failed jsonb;
  v_same jsonb;
  v_material jsonb;
  v_pass jsonb;
  v_result_1 jsonb;
  v_result_2 jsonb;
  v_result_3 jsonb;
  v_result_pass jsonb;
  v_result_recur jsonb;
  v_result_final jsonb;
  v_failure_1 jsonb;
  v_failure_2 jsonb;
  v_evaluation jsonb;
  v_evaluation_selected_at timestamptz;
begin
  v_failure_1 := public.record_shared_award_regression_audit_attempt_failure(
    v_award_id, 'probe operational failure one'
  );
  perform pg_temp.awardping_probe_assert(
    v_failure_1 ->> 'consecutive_failures' = '1'
      and (
        (v_failure_1 ->> 'next_retry_at')::timestamptz
        - (v_failure_1 ->> 'attempt_recorded_at')::timestamptz
      ) between interval '299 seconds' and interval '301 seconds',
    'first regression failure did not receive five-minute backoff'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.jsonb_array_length(
      public.list_shared_awards_for_regression_audit(
        25, array['awardping-stage1-rollback-probe-do-not-commit'], false
      )
    ) = 0
      and pg_catalog.jsonb_array_length(
        public.list_shared_awards_for_regression_audit(
          25, array['awardping-stage1-rollback-probe-do-not-commit'], true
        )
      ) = 1,
    'deferred regression selector does not honor the retry state'
  );
  v_failure_2 := public.record_shared_award_regression_audit_attempt_failure(
    v_award_id, 'probe operational failure two'
  );
  perform pg_temp.awardping_probe_assert(
    v_failure_2 ->> 'consecutive_failures' = '2'
      and (
        (v_failure_2 ->> 'next_retry_at')::timestamptz
        - (v_failure_2 ->> 'attempt_recorded_at')::timestamptz
      ) between interval '599 seconds' and interval '601 seconds',
    'second regression failure did not double its backoff'
  );

  select selected.value -> 'regression_evaluation'
  into v_evaluation
  from pg_catalog.jsonb_array_elements(
    public.list_shared_awards_for_regression_audit(
      25, array['awardping-stage1-rollback-probe-do-not-commit'], true
    )
  ) selected(value)
  limit 1;
  perform pg_temp.awardping_probe_assert(
    v_evaluation ->> 'contract_version' = 'stage1-regression-evaluation-v1'
      and v_evaluation ->> 'revision' ~ '^[0-9a-f]{64}$'
      and (v_evaluation ->> 'source_count')::integer = 1
      and pg_catalog.jsonb_array_length(v_evaluation -> 'sources') = 1,
    'regression selector did not return a complete immutable evaluation envelope'
  );
  v_evaluation_selected_at := (v_evaluation ->> 'selected_at')::timestamptz;

  v_failed := pg_catalog.jsonb_build_object(
    'audit_kind', 'regression',
    'audit_status', 'failed',
    'severity', 'error',
    'findings', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('code', 'rollback_probe')
    ),
    'suggested_fixes', '[]'::jsonb,
    'field_conflicts', '[]'::jsonb,
    'source_rejections', '[]'::jsonb,
    'selected_fact_summary', '{"probe":"same"}'::jsonb,
    'public_page_snapshot', pg_catalog.jsonb_build_object(
      'observation_only', true,
      'applied_to_public', false,
      'evaluation_contract_version', v_evaluation ->> 'contract_version',
      'evaluation_revision', v_evaluation ->> 'revision',
      'evaluation_source_count', (v_evaluation ->> 'source_count')::integer,
      'evaluated_at', pg_catalog.to_char(
        (v_evaluation_selected_at - interval '4 minutes') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'captured_at', '2026-07-17T00:00:00Z',
      'reconciliation', pg_catalog.jsonb_build_object(
        'generated_at', v_evaluation_selected_at - interval '4 minutes'
      )
    ),
    'model', 'rollback-probe'
  );
  v_same := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_failed,
      '{public_page_snapshot,evaluated_at}',
      pg_catalog.to_jsonb(pg_catalog.to_char(
        (v_evaluation_selected_at - interval '3 minutes') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ))
    ),
    '{public_page_snapshot,reconciliation,generated_at}',
    pg_catalog.to_jsonb(v_evaluation_selected_at - interval '3 minutes')
  );
  v_material := pg_catalog.jsonb_set(
    v_same,
    '{public_page_snapshot,captured_at}',
    '"2026-07-17T02:00:00Z"'::jsonb
  );
  v_pass := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_failed
        || '{"audit_status":"passed","severity":"info","findings":[]}'::jsonb,
      '{public_page_snapshot,evaluated_at}',
      pg_catalog.to_jsonb(pg_catalog.to_char(
        (v_evaluation_selected_at - interval '1 minute') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ))
    ),
    '{public_page_snapshot,reconciliation,generated_at}',
    pg_catalog.to_jsonb(v_evaluation_selected_at - interval '1 minute')
  );

  select registry.cohort_key, registry.fact_ledger_batch_id
  into v_cohort_key, v_fact_ledger_batch_id
  from public.stage1_award_members member
  join public.stage1_award_registry registry
    on registry.cohort_key = member.cohort_key
  where member.shared_award_id = v_award_id;
  select audit.id into v_deterministic_page_audit_id
  from public.shared_award_page_audits audit
  join public.stage1_award_registry registry
    on registry.canonical_shared_award_id = audit.shared_award_id
  where registry.cohort_key = v_cohort_key
    and audit.audit_kind = 'deterministic'
  order by audit.created_at desc, audit.id desc
  limit 1;
  select pg_catalog.count(*)::integer into v_stage1_row_count
  from public.stage1_award_registry;

  -- Build a rollback-only release and acceptance so the first blocking
  -- observation proves fail-closed invalidation in that same RPC transaction.
  update public.stage1_award_registry registry
  set
    publication_state = 'verified_beta',
    release_epoch = v_release_epoch,
    state_reason = 'rollback probe regression invalidation',
    updated_at = pg_catalog.statement_timestamp();
  alter table public.stage1_publication_release_state
    disable trigger supersede_stale_public_digest_reservations_on_release_trigger;
  update public.stage1_publication_release_state
  set
    release_state = 'verified_beta',
    release_epoch = v_release_epoch,
    activated_at = pg_catalog.statement_timestamp(),
    reason = 'rollback probe regression invalidation',
    updated_at = pg_catalog.statement_timestamp()
  where release_key = 'stage1-national-25';
  alter table public.stage1_publication_release_state
    enable trigger supersede_stale_public_digest_reservations_on_release_trigger;
  insert into public.stage1_release_acceptance_records (
    id,
    status,
    release_key,
    cohort_identity_version,
    cohort_identity_hash,
    policy_version,
    summary,
    gate_state_hash,
    summary_hash,
    generated_at,
    expires_at,
    actor
  ) values (
    v_acceptance_id,
    'ready',
    'stage1-national-25',
    'stage1-national-25-v2',
    '6e7dd7ee1372671cbfb22b17b862d867145a93c7dc0b73d49afc11f504ee6c8f',
    'stage1-publication-v1',
    '{"probe":"blocking-regression-acceptance"}'::jsonb,
    pg_catalog.repeat('a', 64),
    v_acceptance_hash,
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp() + interval '10 minutes',
    'rollback-probe'
  );
  select pg_catalog.count(*)::integer into v_ready_acceptance_count
  from public.stage1_release_acceptance_records acceptance
  where acceptance.release_key = 'stage1-national-25'
    and acceptance.status = 'ready';
  select pg_catalog.count(*) into v_award_event_count
  from public.stage1_award_publication_events
  where cohort_key = v_cohort_key;
  select pg_catalog.count(*) into v_release_event_count
  from public.stage1_publication_release_events
  where release_key = 'stage1-national-25';

  v_result_1 := public.record_shared_award_regression_audit(
    v_award_id, v_failed, 'probe blocking outcome'
  );
  perform pg_temp.awardping_probe_assert(
    v_result_1 ->> 'inserted' = 'true'
      and v_result_1 #>> '{stage1_invalidation,affected_stage1_cohort}' = 'true'
      and v_result_1 #>> '{stage1_invalidation,award_invalidated}' = 'true'
      and v_result_1 #>> '{stage1_invalidation,national_release_invalidated}' = 'true'
      and v_result_1 #>> '{stage1_invalidation,ready_acceptances_rejected}'
        = v_ready_acceptance_count::text
      and v_result_1 #>> '{stage1_invalidation,release_epochs_cleared}'
        = v_stage1_row_count::text
      and v_result_1 #>> '{stage1_invalidation,regression_audit_id}'
        = v_result_1 ->> 'audit_id'
      and v_result_1 #>> '{stage1_invalidation,regression_observation_key}'
        = v_result_1 ->> 'observation_key'
      and (
        v_result_1 #>> '{stage1_invalidation,deterministic_page_audit_id}'
      ) is not distinct from v_deterministic_page_audit_id::text
      and (
        v_result_1 #>> '{stage1_invalidation,deterministic_fact_ledger_batch_id}'
      ) is not distinct from v_fact_ledger_batch_id::text
      and (
        select registry.publication_state = 'revalidation_pending'
          and registry.release_epoch is null
          and registry.fact_ledger_batch_id is not distinct from v_fact_ledger_batch_id
        from public.stage1_award_registry registry
        where registry.cohort_key = v_cohort_key
      )
      and not exists (
        select 1 from public.stage1_award_registry registry
        where registry.release_epoch is not null
      )
      and (
        select release_state.release_state = 'revalidation_pending'
          and release_state.release_epoch is null
          and release_state.activated_at is null
        from public.stage1_publication_release_state release_state
        where release_state.release_key = 'stage1-national-25'
      )
      and (
        select acceptance.status = 'rejected'
        from public.stage1_release_acceptance_records acceptance
        where acceptance.id = v_acceptance_id
      )
      and public.stage1_effective_publication_reason(
        v_cohort_key, pg_catalog.statement_timestamp()
      ) = 'state_revalidation_pending'
      and (
        select pg_catalog.count(*) = v_award_event_count + 1
        from public.stage1_award_publication_events event
        where event.cohort_key = v_cohort_key
      )
      and (
        select event.previous_state = 'verified_beta'
          and event.next_state = 'revalidation_pending'
          and event.actor = 'scheduled_regression_audit'
          and event.evidence_snapshot ->> 'invalidation_contract'
            = 'stage1-blocking-regression-v1'
          and event.evidence_snapshot #>> '{regression,audit_id}'
            = v_result_1 ->> 'audit_id'
          and event.evidence_snapshot #>> '{regression,audit_kind}'
            = 'regression'
          and event.evidence_snapshot #>> '{regression,audit_status}'
            = 'failed'
          and event.evidence_snapshot #>> '{regression,severity}'
            = 'error'
          and event.evidence_snapshot #>> '{regression,observation_key}'
            = v_result_1 ->> 'observation_key'
          and event.evidence_snapshot
            #>> '{deterministic_publication,audit_kind}' = 'deterministic'
          and (
            event.evidence_snapshot
              #>> '{deterministic_publication,page_audit_id}'
          ) is not distinct from v_deterministic_page_audit_id::text
          and (
            event.evidence_snapshot
              #>> '{deterministic_publication,fact_ledger_batch_id}'
          ) is not distinct from v_fact_ledger_batch_id::text
        from public.stage1_award_publication_events event
        where event.cohort_key = v_cohort_key
        order by event.id desc
        limit 1
      )
      and (
        select pg_catalog.count(*) = v_release_event_count + 1
        from public.stage1_publication_release_events event
        where event.release_key = 'stage1-national-25'
      )
      and (
        select event.previous_state = 'verified_beta'
          and event.next_state = 'revalidation_pending'
          and event.release_epoch is null
          and event.actor = 'scheduled_regression_audit'
          and event.evidence_snapshot ->> 'invalidation_contract'
            = 'stage1-blocking-regression-v1'
          and event.evidence_snapshot ->> 'release_epochs_cleared'
            = v_stage1_row_count::text
        from public.stage1_publication_release_events event
        where event.release_key = 'stage1-national-25'
        order by event.id desc
        limit 1
      ),
    'blocking regression did not atomically invalidate publication, acceptance, and provenance'
  );

  begin
    perform public.activate_stage1_release_from_acceptance(
      v_acceptance_id,
      v_acceptance_hash,
      'rollback probe must remain blocked',
      'rollback-probe'
    );
  exception when sqlstate '40001' then
    v_activation_blocked := true;
  end;
  perform pg_temp.awardping_probe_assert(
    v_activation_blocked,
    'ready acceptance remained activatable after the blocking regression transaction'
  );

  v_result_2 := public.record_shared_award_regression_audit(
    v_award_id, v_same, 'probe blocking outcome'
  );
  perform pg_temp.awardping_probe_assert(
    v_result_1 ->> 'inserted' = 'true'
      and v_result_2 ->> 'inserted' = 'false'
      and v_result_1 ->> 'observation_key' = v_result_2 ->> 'observation_key'
      and v_result_2 #>> '{stage1_invalidation,award_invalidated}' = 'false'
      and v_result_2 #>> '{stage1_invalidation,national_release_invalidated}' = 'false'
      and v_result_2 #>> '{stage1_invalidation,ready_acceptances_rejected}' = '0'
      and v_result_2 #>> '{stage1_invalidation,release_epochs_cleared}' = '0'
      and (
        select pg_catalog.count(*) = v_award_event_count + 1
        from public.stage1_award_publication_events event
        where event.cohort_key = v_cohort_key
      )
      and (
        select pg_catalog.count(*) = v_release_event_count + 1
        from public.stage1_publication_release_events event
        where event.release_key = 'stage1-national-25'
      ),
    'volatile regression timestamps were not deduplicated'
  );

  v_result_3 := public.record_shared_award_regression_audit(
    v_award_id, v_material, 'probe material blocking outcome'
  );
  perform pg_temp.awardping_probe_assert(
    v_result_3 ->> 'inserted' = 'true'
      and v_result_3 ->> 'observation_key' <> v_result_1 ->> 'observation_key',
    'material captured_at evidence did not create a distinct observation'
  );

  v_result_pass := public.record_shared_award_regression_audit(
    v_award_id, v_pass, null
  );
  perform pg_temp.awardping_probe_assert(
    v_result_pass ->> 'resolved_prior_failures' = '2',
    'passing regression audit did not resolve both prior failures'
  );
  v_result_recur := public.record_shared_award_regression_audit(
    v_award_id, v_failed, 'probe recurrence'
  );
  perform pg_temp.awardping_probe_assert(
    v_result_recur ->> 'inserted' = 'true'
      and v_result_recur ->> 'observation_key' = v_result_1 ->> 'observation_key',
    'a resolved regression failure could not recur as a new occurrence'
  );
  v_result_final := public.record_shared_award_regression_audit(
    v_award_id, v_pass, null
  );
  perform pg_temp.awardping_probe_assert(
    v_result_final ->> 'inserted' = 'false'
      and v_result_final ->> 'resolved_prior_failures' = '1'
      and (
        select state.consecutive_failures = 0
          and state.last_operational_error is null
          and state.last_audit_error is null
        from public.shared_award_regression_audit_state state
        where state.shared_award_id = v_award_id
      )
      and (
        select award.public_facts = '{"probe":"unchanged"}'::jsonb
        from public.shared_awards award
        where award.id = v_award_id
      )
      and (
        select registry.publication_state = 'revalidation_pending'
          and registry.release_epoch is null
          and registry.fact_ledger_batch_id is not distinct from v_fact_ledger_batch_id
        from public.stage1_award_registry registry
        where registry.cohort_key = v_cohort_key
      )
      and (
        select release_state.release_state = 'revalidation_pending'
          and release_state.release_epoch is null
        from public.stage1_publication_release_state release_state
        where release_state.release_key = 'stage1-national-25'
      )
      and (
        select acceptance.status = 'rejected'
        from public.stage1_release_acceptance_records acceptance
        where acceptance.id = v_acceptance_id
      ),
    'final regression pass reset retry state but changed fail-closed publication state'
  );
end;
$regression_contract$;

insert into public.shared_award_fact_candidates (
  id, shared_award_id, shared_award_source_id, source_url, source_title,
  source_role, source_quality_decision, field_name, raw_value,
  normalized_value, evidence_quote, evidence_location, extracted_at, model,
  confidence, candidate_status, metadata
) values
(
  '00000000-0000-4000-8000-00000000a003'::uuid,
  '00000000-0000-4000-8000-00000000a001'::uuid,
  '00000000-0000-4000-8000-00000000a002'::uuid,
  'https://example.invalid/awardping-stage1-rollback-probe/source',
  'Rollback probe source', 'eligibility', '{"official":true}'::jsonb,
  'eligibility', 'Probe value', '"Probe value"'::jsonb,
  'Probe evidence', 'Probe location', statement_timestamp(), 'rollback-probe',
  'high', 'pending', '{"revision":1}'::jsonb
),
(
  '00000000-0000-4000-8000-00000000a004'::uuid,
  '00000000-0000-4000-8000-00000000a001'::uuid,
  '00000000-0000-4000-8000-00000000a002'::uuid,
  'https://example.invalid/awardping-stage1-rollback-probe/source',
  'Rollback probe source', 'dates_cycle', '{"official":true}'::jsonb,
  'deadline', 'Probe deadline', '"Probe deadline"'::jsonb,
  'Probe evidence', 'Probe location', statement_timestamp(), 'rollback-probe',
  'high', 'pending', '{"revision":1}'::jsonb
);

do $candidate_contract$
declare
  v_candidate_id constant uuid := '00000000-0000-4000-8000-00000000a003'::uuid;
  v_created_at timestamptz;
  v_updated_at timestamptz;
  v_material_updated_at timestamptz;
  v_caught boolean;
begin
  select candidate.created_at, candidate.updated_at
  into v_created_at, v_updated_at
  from public.shared_award_fact_candidates candidate
  where candidate.id = v_candidate_id;

  update public.shared_award_fact_candidates
  set updated_at = updated_at + interval '1 day'
  where id = v_candidate_id;
  perform pg_temp.awardping_probe_assert(
    (select updated_at = v_updated_at
       from public.shared_award_fact_candidates
      where id = v_candidate_id),
    'true no-op rewrote the candidate CAS version'
  );

  update public.shared_award_fact_candidates
  set metadata = '{"revision":2}'::jsonb
  where id = v_candidate_id;
  select candidate.updated_at into v_material_updated_at
  from public.shared_award_fact_candidates candidate
  where candidate.id = v_candidate_id;
  perform pg_temp.awardping_probe_assert(
    v_material_updated_at > v_updated_at,
    'material candidate change did not advance the CAS version'
  );

  v_caught := false;
  begin
    update public.shared_award_fact_candidates
    set id = '00000000-0000-4000-8000-00000000afff'::uuid
    where id = v_candidate_id;
  exception when sqlstate '55000' then
    v_caught := true;
  end;
  perform pg_temp.awardping_probe_assert(v_caught, 'candidate ID was mutable');

  v_caught := false;
  begin
    update public.shared_award_fact_candidates
    set created_at = v_created_at - interval '1 day'
    where id = v_candidate_id;
  exception when sqlstate '55000' then
    v_caught := true;
  end;
  perform pg_temp.awardping_probe_assert(v_caught, 'candidate created_at was mutable');

  update public.shared_award_fact_candidates
  set candidate_status = 'rejected', rejection_reason = 'probe terminal rejection'
  where id = v_candidate_id;
  v_caught := false;
  begin
    update public.shared_award_fact_candidates
    set metadata = '{"revision":3}'::jsonb
    where id = v_candidate_id;
  exception when sqlstate '55000' then
    v_caught := true;
  end;
  perform pg_temp.awardping_probe_assert(v_caught, 'rejected candidate material was mutable');
  v_caught := false;
  begin
    delete from public.shared_award_fact_candidates where id = v_candidate_id;
  exception when sqlstate '55000' then
    v_caught := true;
  end;
  perform pg_temp.awardping_probe_assert(v_caught, 'rejected candidate was deletable');
end;
$candidate_contract$;

do $candidate_fk_lifecycle_contract$
declare
  v_source_award_id constant uuid := '00000000-0000-4000-8000-00000000d001'::uuid;
  v_source_id constant uuid := '00000000-0000-4000-8000-00000000d002'::uuid;
  v_source_candidate_id constant uuid := '00000000-0000-4000-8000-00000000d003'::uuid;
  v_award_delete_id constant uuid := '00000000-0000-4000-8000-00000000d004'::uuid;
  v_award_candidate_id constant uuid := '00000000-0000-4000-8000-00000000d005'::uuid;
  v_source_candidate_before jsonb;
  v_award_candidate_before jsonb;
  v_caught boolean := false;
begin
  insert into public.shared_awards (
    id, search_key, name, slug, official_homepage, summary, public_facts,
    confidence, status, source
  ) values
  (
    v_source_award_id,
    'awardping-candidate-source-fk-probe-do-not-commit',
    'AwardPing Candidate Source FK Probe',
    'awardping-candidate-source-fk-probe-do-not-commit',
    'https://example.invalid/candidate-source-fk-probe',
    'Rollback-only source FK lifecycle fixture.',
    '{"probe":"source-fk"}'::jsonb,
    1,
    'active',
    'admin'
  ),
  (
    v_award_delete_id,
    'awardping-candidate-award-fk-probe-do-not-commit',
    'AwardPing Candidate Award FK Probe',
    'awardping-candidate-award-fk-probe-do-not-commit',
    'https://example.invalid/candidate-award-fk-probe',
    'Rollback-only award FK lifecycle fixture.',
    '{"probe":"award-fk"}'::jsonb,
    1,
    'active',
    'admin'
  );
  insert into public.shared_award_sources (
    id, shared_award_id, url, title, page_type, confidence, reason, source
  ) values (
    v_source_id,
    v_source_award_id,
    'https://example.invalid/candidate-source-fk-probe/source',
    'Candidate source FK probe',
    'other',
    1,
    'Rollback-only source FK lifecycle fixture.',
    'admin'
  );
  insert into public.shared_award_fact_candidates (
    id, shared_award_id, shared_award_source_id, source_url, source_title,
    source_role, source_quality_decision, field_name, raw_value,
    normalized_value, evidence_quote, evidence_location, extracted_at, model,
    confidence, candidate_status, rejection_reason, metadata
  ) values
  (
    v_source_candidate_id,
    v_source_award_id,
    v_source_id,
    'https://example.invalid/candidate-source-fk-probe/source',
    'Candidate source FK probe',
    'eligibility',
    '{"official":true}'::jsonb,
    'eligibility',
    'Rejected source lifecycle value',
    '"Rejected source lifecycle value"'::jsonb,
    'Rejected source lifecycle evidence',
    'Rollback probe source lifecycle',
    pg_catalog.statement_timestamp(),
    'rollback-probe',
    'high',
    'rejected',
    'rollback probe terminal source candidate',
    '{"probe":"source-fk"}'::jsonb
  ),
  (
    v_award_candidate_id,
    v_award_delete_id,
    null,
    'https://example.invalid/candidate-award-fk-probe',
    'Candidate award FK probe',
    'eligibility',
    '{"official":true}'::jsonb,
    'eligibility',
    'Rejected award lifecycle value',
    '"Rejected award lifecycle value"'::jsonb,
    'Rejected award lifecycle evidence',
    'Rollback probe award lifecycle',
    pg_catalog.statement_timestamp(),
    'rollback-probe',
    'high',
    'rejected',
    'rollback probe terminal award candidate',
    '{"probe":"award-fk"}'::jsonb
  );

  select pg_catalog.to_jsonb(candidate) into v_source_candidate_before
  from public.shared_award_fact_candidates candidate
  where candidate.id = v_source_candidate_id;
  select pg_catalog.to_jsonb(candidate) into v_award_candidate_before
  from public.shared_award_fact_candidates candidate
  where candidate.id = v_award_candidate_id;

  begin
    update public.shared_award_fact_candidates
    set shared_award_source_id = null
    where id = v_source_candidate_id;
  exception when sqlstate '55000' then
    v_caught := true;
  end;
  perform pg_temp.awardping_probe_assert(
    v_caught
      and (
        select candidate.shared_award_source_id = v_source_id
        from public.shared_award_fact_candidates candidate
        where candidate.id = v_source_candidate_id
      )
      and not exists (
        select 1
        from public.shared_award_fact_candidate_terminal_archive archive
        where archive.candidate_id = v_source_candidate_id
      ),
    'direct rejected-candidate source detachment bypassed terminal immutability'
  );

  delete from public.shared_award_sources source
  where source.id = v_source_id;
  perform pg_temp.awardping_probe_assert(
    not exists (
      select 1 from public.shared_award_sources source
      where source.id = v_source_id
    )
      and (
        select candidate.shared_award_source_id is null
          and candidate.candidate_status = 'rejected'
          and candidate.updated_at >
            (v_source_candidate_before ->> 'updated_at')::timestamptz
          and (
            pg_catalog.to_jsonb(candidate)
              - 'updated_at' - 'shared_award_source_id'
          ) = (
            v_source_candidate_before
              - 'updated_at' - 'shared_award_source_id'
          )
        from public.shared_award_fact_candidates candidate
        where candidate.id = v_source_candidate_id
      )
      and (
        select archive.lifecycle_action = 'source_deleted'
          and archive.shared_award_id = v_source_award_id
          and archive.shared_award_source_id = v_source_id
          and archive.candidate_snapshot = v_source_candidate_before
          and archive.candidate_snapshot_hash =
            public.stage1_publication_evidence_hash(
              archive.candidate_snapshot
            )
          and archive.trigger_depth > 1
          and archive.archive_contract =
            'rejected-candidate-fk-lifecycle-v1'
        from public.shared_award_fact_candidate_terminal_archive archive
        where archive.candidate_id = v_source_candidate_id
          and archive.lifecycle_action = 'source_deleted'
      ),
    'source ON DELETE SET NULL did not preserve and detach rejected evidence'
  );

  v_caught := false;
  begin
    update public.shared_award_fact_candidate_terminal_archive
    set archived_at = archived_at + interval '1 second'
    where candidate_id = v_source_candidate_id
      and lifecycle_action = 'source_deleted';
  exception when sqlstate '55000' then
    v_caught := true;
  end;
  perform pg_temp.awardping_probe_assert(
    v_caught,
    'terminal candidate archive was mutable'
  );
  v_caught := false;
  begin
    delete from public.shared_award_fact_candidate_terminal_archive
    where candidate_id = v_source_candidate_id
      and lifecycle_action = 'source_deleted';
  exception when sqlstate '55000' then
    v_caught := true;
  end;
  perform pg_temp.awardping_probe_assert(
    v_caught,
    'terminal candidate archive was deletable'
  );

  delete from public.shared_awards award
  where award.id = v_award_delete_id;
  perform pg_temp.awardping_probe_assert(
    not exists (
      select 1 from public.shared_awards award
      where award.id = v_award_delete_id
    )
      and not exists (
        select 1 from public.shared_award_fact_candidates candidate
        where candidate.id = v_award_candidate_id
      )
      and (
        select archive.lifecycle_action = 'award_deleted'
          and archive.shared_award_id = v_award_delete_id
          and archive.shared_award_source_id is null
          and archive.candidate_snapshot = v_award_candidate_before
          and archive.candidate_snapshot_hash =
            public.stage1_publication_evidence_hash(
              archive.candidate_snapshot
            )
          and archive.trigger_depth > 1
        from public.shared_award_fact_candidate_terminal_archive archive
        where archive.candidate_id = v_award_candidate_id
          and archive.lifecycle_action = 'award_deleted'
      ),
    'award ON DELETE CASCADE did not preserve rejected candidate evidence'
  );
end;
$candidate_fk_lifecycle_contract$;

do $candidate_invalidation_contract$
declare
  v_cohort_key text;
  v_epoch constant uuid := '00000000-0000-4000-8000-00000000c001'::uuid;
  v_event_count bigint;
  v_release_event_count bigint;
begin
  select member.cohort_key into v_cohort_key
  from public.stage1_award_members member
  where member.shared_award_id = '00000000-0000-4000-8000-00000000a001'::uuid;
  update public.stage1_award_registry registry
  set
    publication_state = 'verified_beta',
    release_epoch = v_epoch,
    state_reason = 'rollback probe candidate invalidation',
    evidence_checked_at = pg_catalog.statement_timestamp(),
    last_verified_at = pg_catalog.statement_timestamp()
  where registry.cohort_key = v_cohort_key;
  alter table public.stage1_publication_release_state
    disable trigger supersede_stale_public_digest_reservations_on_release_trigger;
  update public.stage1_publication_release_state
  set
    release_state = 'verified_beta',
    release_epoch = v_epoch,
    activated_at = pg_catalog.statement_timestamp(),
    reason = 'rollback probe candidate invalidation'
  where release_key = 'stage1-national-25';
  alter table public.stage1_publication_release_state
    enable trigger supersede_stale_public_digest_reservations_on_release_trigger;
  select pg_catalog.count(*) into v_event_count
  from public.stage1_award_publication_events
  where cohort_key = v_cohort_key;
  select pg_catalog.count(*) into v_release_event_count
  from public.stage1_publication_release_events
  where release_key = 'stage1-national-25';

  update public.shared_award_fact_candidates
  set metadata = '{"revision":2,"candidate_invalidation_probe":true}'::jsonb
  where id = '00000000-0000-4000-8000-00000000a004'::uuid;

  perform pg_temp.awardping_probe_assert(
    (select publication_state = 'revalidation_pending' and release_epoch is null
       from public.stage1_award_registry
      where cohort_key = v_cohort_key)
      and (select release_state = 'revalidation_pending' and release_epoch is null
             from public.stage1_publication_release_state
            where release_key = 'stage1-national-25')
      and (select pg_catalog.count(*) = v_event_count + 1
             from public.stage1_award_publication_events
            where cohort_key = v_cohort_key)
      and (select pg_catalog.count(*) = v_release_event_count + 1
             from public.stage1_publication_release_events
            where release_key = 'stage1-national-25'),
    'candidate evidence invalidation was not constraint-safe and exactly once'
  );
end;
$candidate_invalidation_contract$;

-- Give the rollback-only source one complete immutable capture and a current
-- successful check. The reviewed wrapper must consume these exact versions;
-- both rows and all dependent publication writes are removed by the outer
-- rollback.
update public.shared_award_sources source
set
  admin_review_status = 'open',
  last_checked_at = pg_catalog.date_trunc(
    'milliseconds', pg_catalog.statement_timestamp()
  ),
  last_error = null,
  updated_at = pg_catalog.date_trunc(
    'milliseconds', pg_catalog.statement_timestamp()
  )
where source.id = '00000000-0000-4000-8000-00000000a002'::uuid;

insert into public.shared_award_source_visual_snapshots (
  shared_award_source_id,
  shared_award_id,
  source_url,
  source_title,
  source_page_type,
  kind,
  bucket,
  latest_captured_at,
  latest_object_keys,
  latest_hashes,
  latest_metadata,
  updated_at
) values (
  '00000000-0000-4000-8000-00000000a002'::uuid,
  '00000000-0000-4000-8000-00000000a001'::uuid,
  'https://example.invalid/awardping-stage1-rollback-probe/source',
  'Rollback probe source',
  'other',
  'webpage',
  'awardping-stage1-rollback-probe',
  pg_catalog.date_trunc(
    'milliseconds', pg_catalog.statement_timestamp() - interval '30 days'
  ),
  pg_catalog.jsonb_build_object(
    'page',
      'visual-snapshots/sources/00000000-0000-4000-8000-00000000a002/captures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/page.jpg',
    'thumb',
      'visual-snapshots/sources/00000000-0000-4000-8000-00000000a002/captures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/thumb.jpg',
    'text',
      'visual-snapshots/sources/00000000-0000-4000-8000-00000000a002/captures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/text.txt',
    'meta',
      'visual-snapshots/sources/00000000-0000-4000-8000-00000000a002/captures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/meta.json'
  ),
  pg_catalog.jsonb_build_object(
    'image_hash', pg_catalog.repeat('a', 64),
    'text_hash', pg_catalog.repeat('b', 64)
  ),
  '{"page_bytes":101,"text_object_bytes":51,"text_length":50}'::jsonb,
  pg_catalog.date_trunc(
    'milliseconds', pg_catalog.statement_timestamp() - interval '30 days'
  )
);

do $reviewed_reconciliation_contract$
declare
  v_source public.shared_award_sources%rowtype;
  v_snapshot public.shared_award_source_visual_snapshots%rowtype;
  v_candidate public.shared_award_fact_candidates%rowtype;
  v_award public.shared_awards%rowtype;
  v_registry public.stage1_award_registry%rowtype;
  v_auto_queue_id constant uuid :=
    '00000000-0000-4000-8000-00000000a00b'::uuid;
  v_reviewed_queue_id constant uuid :=
    '00000000-0000-4000-8000-00000000a00c'::uuid;
  v_replay_queue_id constant uuid :=
    '00000000-0000-4000-8000-00000000a00d'::uuid;
  v_auto_started_at constant timestamptz :=
    '2026-07-17T06:00:00Z'::timestamptz;
  v_reviewed_started_at constant timestamptz :=
    '2026-07-17T06:05:00Z'::timestamptz;
  v_replay_started_at constant timestamptz :=
    '2026-07-17T06:10:00Z'::timestamptz;
  v_summary constant text := 'Reviewed rollback probe succeeded.';
  v_root_hash text;
  v_signature text;
  v_replay_signature constant text := pg_catalog.repeat('d', 64);
  v_public_facts jsonb;
  v_replay_public_facts jsonb;
  v_review jsonb;
  v_source_binding jsonb;
  v_roles jsonb;
  v_review_root jsonb;
  v_review_binding jsonb;
  v_evidence_rows jsonb;
  v_replay_evidence_rows jsonb;
  v_candidate_mutations jsonb;
  v_audit_projection jsonb;
  v_audit_base jsonb;
  v_audit jsonb;
  v_replay_audit jsonb;
  v_import_reviewed_at timestamptz;
  v_import_reviewed_at_text text;
  v_import_source_binding jsonb;
  v_import_review_source jsonb;
  v_import_item jsonb;
  v_item_identity jsonb;
  v_item_sha text;
  v_import_candidate_id uuid;
  v_review_bundle jsonb;
  v_bundle_sha text;
  v_import_candidate jsonb;
  v_import_candidates jsonb;
  v_confirmation_payload jsonb;
  v_confirmation_sha text;
  v_import_binding jsonb;
  v_import_result jsonb;
  v_import_replay jsonb;
  v_result public.shared_award_reconciliation_queue%rowtype;
  v_retrieved_root jsonb;
  v_auto_rejected boolean := false;
  v_collision_rejected boolean := false;
  v_commit_failure_rejected boolean := false;
  v_invalid_hash_rejected boolean := false;
  v_update_rejected boolean := false;
  v_delete_rejected boolean := false;
  v_generic_quote_rejected boolean := false;
  v_missing_marker_rejected boolean := false;
  v_wrong_role_rejected boolean := false;
  v_wrong_order_rejected boolean := false;
  v_projection_rejected boolean := false;
  v_audit_projection_rejected boolean := false;
  v_stored_root_replay_rejected boolean := false;
  v_selected_replay_verified boolean := false;
  v_bad_review_binding jsonb;
begin
  select registry.* into v_registry
  from public.stage1_award_registry registry
  order by registry.launch_rank
  limit 1;
  update public.shared_awards award
  set updated_at = pg_catalog.date_trunc(
    'milliseconds', pg_catalog.statement_timestamp()
  )
  where award.id = v_registry.canonical_shared_award_id;
  select award.* into v_award
  from public.shared_awards award
  where award.id = v_registry.canonical_shared_award_id;
  select source.* into v_source
  from public.shared_award_sources source
  where source.id = '00000000-0000-4000-8000-00000000a002'::uuid;
  select snapshot.* into v_snapshot
  from public.shared_award_source_visual_snapshots snapshot
  where snapshot.shared_award_source_id = v_source.id;
  perform pg_temp.awardping_probe_assert(
    v_source.last_checked_at >= pg_catalog.statement_timestamp() - interval '24 hours'
      and v_snapshot.latest_captured_at <=
        pg_catalog.statement_timestamp() - interval '29 days',
    'reviewed reconciliation fixture did not separate live checks from durable capture evidence'
  );

  v_import_reviewed_at := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.statement_timestamp()
  );
  v_import_reviewed_at_text := pg_catalog.to_char(
    v_import_reviewed_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_import_source_binding := pg_catalog.jsonb_build_object(
    'source_id', v_source.id,
    'shared_award_id', v_source.shared_award_id,
    'source_url', v_source.url,
    'source_title', coalesce(v_source.display_title, v_source.title),
    'source_updated_at', pg_catalog.to_char(
      v_source.updated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'last_checked_at', pg_catalog.to_char(
      v_source.last_checked_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'snapshot_updated_at', pg_catalog.to_char(
      v_snapshot.updated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'captured_at', pg_catalog.to_char(
      v_snapshot.latest_captured_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'capture_text_sha256', v_snapshot.latest_hashes ->> 'text_hash',
    'capture_text_object_key', v_snapshot.latest_object_keys ->> 'text',
    'official_identity', pg_catalog.jsonb_build_object(
      'host', 'example.invalid',
      'classification', 'official_authority_host',
      'evidence_url', v_source.url,
      'reviewed_reason',
        'Rollback-only exact authority-host evidence for the linked probe.'
    ),
    'local_verified_at', v_import_reviewed_at_text
  );
  v_import_review_source := v_import_source_binding - array[
    'shared_award_id', 'source_title', 'local_verified_at'
  ];
  v_import_item := pg_catalog.jsonb_build_object(
    'item_key', 'deadline.probe',
    'source_id', v_source.id,
    'source_relevance', 'primary',
    'field_name', 'deadline',
    'normalized_value', 'Probe deadline',
    'evidence_quote', 'Probe deadline',
    'evidence_location', 'immutable_text_chars:0-14'
  );
  v_item_identity := pg_catalog.jsonb_build_object(
    'schema_version',
      'awardping.stage1.reviewed-candidate-import-item.v1',
    'policy_version', 'stage1-publication-v1',
    'canonical_shared_award_id', v_award.id::text,
    'source_id', v_source.id::text,
    'source_url', v_source.url,
    'source_relevance', 'primary',
    'field_name', 'deadline',
    'normalized_value', 'Probe deadline',
    'evidence_quote', 'Probe deadline',
    'evidence_location', 'immutable_text_chars:0-14',
    'capture_text_sha256', v_snapshot.latest_hashes ->> 'text_hash',
    'capture_text_object_key', v_snapshot.latest_object_keys ->> 'text'
  );
  v_item_sha := private.stage1_canonical_json_sha256(v_item_identity);
  v_import_candidate_id := private.stage1_candidate_uuid_from_sha256(v_item_sha);
  v_review_bundle := pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.reviewed-candidate-import.v1',
    'policy_version', 'stage1-publication-v1',
    'review', pg_catalog.jsonb_build_object(
      'reviewed_by', 'rollback-probe',
      'reviewed_at', v_import_reviewed_at_text,
      'reason', 'Exercise the exact reviewed candidate import contract.',
      'selection_method', 'explicit_human_review',
      'paid_api_calls', 0
    ),
    'cohort', pg_catalog.jsonb_build_object(
      'cohort_key', v_registry.cohort_key,
      'canonical_award', pg_catalog.jsonb_build_object(
        'id', v_award.id,
        'search_key', v_award.search_key,
        'name', v_award.name,
        'official_homepage', v_award.official_homepage
      )
    ),
    'sources', pg_catalog.jsonb_build_array(v_import_review_source),
    'items', pg_catalog.jsonb_build_array(v_import_item)
  );
  v_bundle_sha := private.stage1_canonical_json_sha256(v_review_bundle);
  v_import_candidate := pg_catalog.jsonb_build_object(
    'id', v_import_candidate_id,
    'shared_award_id', v_source.shared_award_id,
    'shared_award_source_id', v_source.id,
    'source_url', v_source.url,
    'source_title', coalesce(v_source.display_title, v_source.title),
    'source_role', 'primary',
    'source_quality_decision', pg_catalog.jsonb_build_object(
      'decision', 'approved',
      'purpose', 'stage1_reviewed_candidate_import',
      'official_identity', v_import_source_binding -> 'official_identity'
    ),
    'field_name', 'deadline',
    'raw_value', 'Probe deadline',
    'normalized_value', 'Probe deadline',
    'evidence_quote', 'Probe deadline',
    'evidence_location', 'immutable_text_chars:0-14',
    'extracted_at', v_import_reviewed_at_text,
    'model', 'explicit-human-stage1-candidate-import',
    'confidence', 'human_reviewed',
    'candidate_status', 'pending',
    'rejection_reason', null,
    'selected_reason', null,
    'source_page_request_id', null,
    'intake_value_sha256', null,
    'metadata', pg_catalog.jsonb_build_object(
      'stage1_immutable_evidence', pg_catalog.jsonb_build_object(
        'schema_version',
          'awardping.stage1.candidate-immutable-evidence.v1',
        'source_id', v_source.id,
        'capture_text_sha256', v_snapshot.latest_hashes ->> 'text_hash',
        'capture_text_object_key', v_snapshot.latest_object_keys ->> 'text',
        'evidence_quote_sha256',
          private.stage1_text_sha256('Probe deadline'),
        'verification_method', 'exact_local_text_substring'
      ),
      'stage1_candidate_import', pg_catalog.jsonb_build_object(
        'schema_version',
          'awardping.stage1.reviewed-candidate-import-item.v1',
        'bundle_sha256', v_bundle_sha,
        'item_sha256', v_item_sha,
        'item_key', 'deadline.probe',
        'reviewed_by', 'rollback-probe',
        'reviewed_at', v_import_reviewed_at_text,
        'review_reason',
          'Exercise the exact reviewed candidate import contract.',
        'paid_api_calls', 0
      )
    )
  );
  v_import_candidates := pg_catalog.jsonb_build_array(v_import_candidate);
  v_confirmation_payload := pg_catalog.jsonb_build_object(
    'schema_version',
      'awardping.stage1.reviewed-candidate-import-confirmation.v1',
    'operation', 'apply_reviewed_stage1_candidate_import',
    'cohort_key', v_registry.cohort_key,
    'canonical_shared_award_id', v_award.id,
    'policy_version', 'stage1-publication-v1',
    'bundle_sha256', v_bundle_sha,
    'database_snapshot_sha256', pg_catalog.repeat('c', 64),
    'candidates_sha256',
      private.stage1_canonical_json_sha256(v_import_candidates),
    'candidate_ids', pg_catalog.jsonb_build_array(v_import_candidate_id),
    'candidate_count', 1,
    'reviewed_by', 'rollback-probe',
    'reviewed_at', v_import_reviewed_at_text,
    'paid_api_calls', 0
  );
  v_confirmation_sha := private.stage1_canonical_json_sha256(
    v_confirmation_payload
  );
  v_import_binding := pg_catalog.jsonb_build_object(
    'schema_version',
      'awardping.stage1.reviewed-candidate-import-binding.v1',
    'policy_version', 'stage1-publication-v1',
    'bundle_sha256', v_bundle_sha,
    'review_bundle', v_review_bundle,
    'award', pg_catalog.jsonb_build_object(
      'id', v_award.id,
      'updated_at', pg_catalog.to_char(
        v_award.updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    ),
    'source_bindings', pg_catalog.jsonb_build_array(v_import_source_binding),
    'candidates', v_import_candidates,
    'confirmation_payload', v_confirmation_payload,
    'confirmation_sha256', v_confirmation_sha
  );

  perform pg_temp.awardping_probe_assert(
    pg_catalog.has_function_privilege(
      'service_role',
      'public.import_reviewed_stage1_fact_candidates(jsonb,text)',
      'EXECUTE'
    )
      and not pg_catalog.has_function_privilege(
        'anon',
        'public.import_reviewed_stage1_fact_candidates(jsonb,text)',
        'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated',
        'public.import_reviewed_stage1_fact_candidates(jsonb,text)',
        'EXECUTE'
      )
      and (
        select pg_catalog.bool_and(class.relrowsecurity)
        from pg_catalog.pg_class class
        where class.oid in (
          'private.stage1_reviewed_candidate_import_bundles'::pg_catalog.regclass,
          'private.stage1_reviewed_candidate_import_items'::pg_catalog.regclass
        )
      )
      and pg_catalog.has_table_privilege(
        'service_role',
        'private.stage1_reviewed_candidate_import_bundles',
        'SELECT'
      )
      and pg_catalog.has_table_privilege(
        'service_role',
        'private.stage1_reviewed_candidate_import_items',
        'SELECT'
      )
      and not pg_catalog.has_table_privilege(
        'service_role',
        'private.stage1_reviewed_candidate_import_bundles',
        'INSERT,UPDATE,DELETE'
      )
      and not pg_catalog.has_table_privilege(
        'service_role',
        'private.stage1_reviewed_candidate_import_items',
        'INSERT,UPDATE,DELETE'
      ),
    'reviewed candidate import was not service-only with read-only private ledgers'
  );
  v_import_result := public.import_reviewed_stage1_fact_candidates(
    v_import_binding,
    v_confirmation_sha
  );
  v_import_replay := public.import_reviewed_stage1_fact_candidates(
    v_import_binding,
    v_confirmation_sha
  );
  perform pg_temp.awardping_probe_assert(
    v_import_result ->> 'status' = 'succeeded'
      and v_import_result ->> 'inserted_count' = '1'
      and v_import_result ->> 'existing_count' = '0'
      and v_import_result ->> 'paid_api_calls' = '0'
      and v_import_result ->> 'source_mutations' = '0'
      and v_import_result ->> 'publication_mutations' = '0'
      and v_import_replay ->> 'status' = 'succeeded'
      and v_import_replay ->> 'inserted_count' = '0'
      and v_import_replay ->> 'existing_count' = '1'
      and (
        select bundle.review_bundle = v_review_bundle
          and bundle.source_bindings =
            pg_catalog.jsonb_build_array(v_import_source_binding)
          and bundle.candidates_sha256 =
            private.stage1_canonical_json_sha256(v_import_candidates)
          and bundle.confirmation_payload = v_confirmation_payload
          and bundle.import_binding_sha256 =
            private.stage1_canonical_json_sha256(v_import_binding)
          and bundle.candidate_count = 1
        from private.stage1_reviewed_candidate_import_bundles bundle
        where bundle.bundle_sha256 = v_bundle_sha
      )
      and (
        select item.bundle_sha256 = v_bundle_sha
          and item.candidate_id = v_import_candidate_id
          and item.canonical_shared_award_id = v_award.id
          and item.source_id = v_source.id
          and item.field_name = 'deadline'
        from private.stage1_reviewed_candidate_import_items item
        where item.item_sha256 = v_item_sha
      )
      and (
        select candidate.shared_award_id = v_source.shared_award_id
          and candidate.shared_award_id <> v_award.id
          and candidate.shared_award_source_id = v_source.id
        from public.shared_award_fact_candidates candidate
        where candidate.id = v_import_candidate_id
      ),
    'reviewed candidate import did not retain alias source ownership with canonical durable proof'
  );

  begin
    update public.shared_award_fact_candidates candidate
    set
      candidate_status = 'selected',
      selected_reason = 'rollback-probe selected replay',
      rejection_reason = null
    where candidate.id = v_import_candidate_id;
    v_import_replay := public.import_reviewed_stage1_fact_candidates(
      v_import_binding,
      v_confirmation_sha
    );
    perform pg_temp.awardping_probe_assert(
      v_import_replay ->> 'inserted_count' = '0'
        and v_import_replay ->> 'existing_count' = '1',
      'reviewed candidate import replay rejected an exact selected lifecycle row'
    );
    raise exception using
      errcode = 'P9201',
      message = 'Rollback the selected lifecycle replay fixture.';
  exception when sqlstate 'P9201' then
    v_selected_replay_verified := true;
  end;
  perform pg_temp.awardping_probe_assert(
    v_selected_replay_verified
      and (
        select candidate.candidate_status = 'pending'
          and candidate.selected_reason is null
        from public.shared_award_fact_candidates candidate
        where candidate.id = v_import_candidate_id
      ),
    'selected candidate replay did not remain idempotent or roll back cleanly'
  );

  select candidate.* into strict v_candidate
  from public.shared_award_fact_candidates candidate
  where candidate.id = v_import_candidate_id;

  v_public_facts := pg_catalog.jsonb_build_object(
    'deadline', v_candidate.normalized_value
  );
  v_review := pg_catalog.jsonb_build_object(
    'reviewed_by', 'rollback-probe',
    'reviewed_at', v_import_reviewed_at,
    'reason', 'Execute the reviewed Stage 1 trigger contract.',
    'selection_method', 'explicit_human_review',
    'auto_accept_ranked_candidates', false,
    'materialize_candidates', false
  );
  v_source_binding := pg_catalog.jsonb_build_object(
    'source_id', v_source.id,
    'source_url', v_source.url,
    'official_identity', pg_catalog.jsonb_build_object(
      'host', 'example.invalid',
      'classification', 'official_authority_host',
      'evidence_url', v_source.url,
      'reviewed_reason',
        'Rollback-only exact authority-host evidence for the linked probe.'
    ),
    'last_checked_at', v_source.last_checked_at,
    'snapshot', pg_catalog.jsonb_build_object(
      'captured_at', v_snapshot.latest_captured_at,
      'object_keys', v_snapshot.latest_object_keys,
      'kind', v_snapshot.kind,
      'hashes', v_snapshot.latest_hashes,
      'metadata', v_snapshot.latest_metadata
    ),
    'r2', pg_catalog.jsonb_build_object(
      'verified_at', v_import_reviewed_at,
      'hashes', v_snapshot.latest_hashes
    ),
    'local', pg_catalog.jsonb_build_object(
      'verified_at', v_import_reviewed_at,
      'hashes', v_snapshot.latest_hashes
    )
  );
  v_roles := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'source_role', 'identity_home', 'manifest_status', 'present',
      'official', true, 'supporting_text', 'Reviewed identity source.',
      'cycle', 'probe', 'sources', pg_catalog.jsonb_build_array(v_source_binding),
      'fact_candidate_ids', '[]'::jsonb
    ),
    pg_catalog.jsonb_build_object(
      'source_role', 'eligibility', 'manifest_status', 'not_published',
      'official', true, 'supporting_text', 'No separate eligibility publication.',
      'cycle', 'probe', 'sources', pg_catalog.jsonb_build_array(v_source_binding),
      'fact_candidate_ids', '[]'::jsonb
    ),
    pg_catalog.jsonb_build_object(
      'source_role', 'application_materials', 'manifest_status', 'not_published',
      'official', true, 'supporting_text', 'No separate materials publication.',
      'cycle', 'probe', 'sources', pg_catalog.jsonb_build_array(v_source_binding),
      'fact_candidate_ids', '[]'::jsonb
    ),
    pg_catalog.jsonb_build_object(
      'source_role', 'dates_cycle', 'manifest_status', 'present',
      'official', true, 'supporting_text', 'Reviewed deadline source.',
      'cycle', 'probe', 'sources', pg_catalog.jsonb_build_array(v_source_binding),
      'fact_candidate_ids', pg_catalog.jsonb_build_array(v_candidate.id)
    ),
    pg_catalog.jsonb_build_object(
      'source_role', 'funding', 'manifest_status', 'not_published',
      'official', true, 'supporting_text', 'No separate funding publication.',
      'cycle', 'probe', 'sources', pg_catalog.jsonb_build_array(v_source_binding),
      'fact_candidate_ids', '[]'::jsonb
    ),
    pg_catalog.jsonb_build_object(
      'source_role', 'faq', 'manifest_status', 'not_published',
      'official', true, 'supporting_text', 'No separate FAQ publication.',
      'cycle', 'probe', 'sources', pg_catalog.jsonb_build_array(v_source_binding),
      'fact_candidate_ids', '[]'::jsonb
    ),
    pg_catalog.jsonb_build_object(
      'source_role', 'selection_interviews', 'manifest_status', 'not_published',
      'official', true, 'supporting_text', 'No separate interview publication.',
      'cycle', 'probe', 'sources', pg_catalog.jsonb_build_array(v_source_binding),
      'fact_candidate_ids', '[]'::jsonb
    ),
    pg_catalog.jsonb_build_object(
      'source_role', 'current_documents', 'manifest_status', 'not_published',
      'official', true, 'supporting_text', 'No separate current document.',
      'cycle', 'probe', 'sources', pg_catalog.jsonb_build_array(v_source_binding),
      'fact_candidate_ids', '[]'::jsonb
    )
  );
  v_review_root := pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.human-review-root.v1',
    'policy_version', 'stage1-publication-v1',
    'review', v_review,
    'cohorts', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'cohort_key', v_registry.cohort_key,
        'canonical_award', pg_catalog.jsonb_build_object(
          'id', v_award.id,
          'search_key', v_award.search_key,
          'name', v_award.name,
          'official_homepage', v_award.official_homepage
        ),
        'public_facts', v_public_facts,
        'publication', pg_catalog.jsonb_build_object(
          'summary', v_summary,
          'confidence', 1
        ),
        'field_choices', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'field_name', 'deadline',
            'composition_method', 'direct_exact',
            'candidate_ids', pg_catalog.jsonb_build_array(v_candidate.id),
            'candidate_evidence', pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object(
                'candidate_id', v_candidate.id,
                'source_id', v_candidate.shared_award_source_id,
                'evidence_quote', v_candidate.evidence_quote,
                'evidence_location', v_candidate.evidence_location,
                'capture_text_sha256',
                  v_candidate.metadata #>> array[
                    'stage1_immutable_evidence', 'capture_text_sha256'
                  ],
                'capture_text_object_key',
                  v_candidate.metadata #>> array[
                    'stage1_immutable_evidence', 'capture_text_object_key'
                  ]
              )
            )
          )
        ),
        'roles', v_roles
      )
    )
  );
  v_root_hash := private.stage1_canonical_json_sha256(v_review_root);
  perform pg_temp.awardping_probe_assert(
    v_root_hash ~ '^[0-9a-f]{64}$'
      and v_root_hash = private.stage1_canonical_json_sha256(v_review_root),
    'server did not recompute the exact canonical human-review root hash'
  );

  v_candidate_mutations := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'id', v_candidate.id,
      'expected_status', v_candidate.candidate_status,
      'expected_updated_at', v_candidate.updated_at,
      'candidate_status', 'selected',
      'selected_reason', 'explicit_human_review:' || v_root_hash,
      'rejection_reason', null
    )
  );
  v_evidence_rows := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'field_name', 'deadline',
      'public_value', v_public_facts -> 'deadline',
      'candidate_ids', pg_catalog.jsonb_build_array(v_candidate.id),
      'source_ids', pg_catalog.jsonb_build_array(v_source.id),
      'evidence', pg_catalog.jsonb_build_object(
        'award_id', v_award.id,
        'reconciliation_id', v_auto_queue_id,
        'field_name', 'deadline',
        'public_value', v_public_facts -> 'deadline',
        'candidate_ids', pg_catalog.jsonb_build_array(v_candidate.id),
        'source_ids', pg_catalog.jsonb_build_array(v_source.id),
        'stage1_review_root_schema_version',
          'awardping.stage1.human-review-root.v1',
        'stage1_review_root_sha256', v_root_hash,
        'candidate_bindings', pg_catalog.jsonb_build_object(
          v_candidate.id::text,
          pg_catalog.jsonb_build_object(
            'source_id', v_source.id,
            'source_role', v_candidate.source_role,
            'source_relevance', v_candidate.source_role,
            'reviewed_stage1_source_role', 'dates_cycle',
            'field_name', v_candidate.field_name,
            'canonical_field_name', 'deadline',
            'contributes_to_field', 'deadline',
            'composition_method', 'direct_exact',
            'composition_index', null,
            'contribution_kind', 'direct_selected_value',
            'reviewed_contribution_kind', 'direct_selected_value',
            'normalized_value', v_candidate.normalized_value,
            'composed_value', v_candidate.normalized_value,
            'selected_value', v_public_facts -> 'deadline',
            'public_field_value', v_public_facts -> 'deadline',
            'evidence_quote', v_candidate.evidence_quote,
            'evidence_location', v_candidate.evidence_location,
            'capture_text_sha256',
              v_candidate.metadata #>> array[
                'stage1_immutable_evidence', 'capture_text_sha256'
              ],
            'capture_text_object_key',
              v_candidate.metadata #>> array[
                'stage1_immutable_evidence', 'capture_text_object_key'
              ],
            'immutable_evidence',
              v_candidate.metadata -> 'stage1_immutable_evidence',
            'candidate_import', pg_catalog.jsonb_build_object(
              'schema_version',
                'awardping.stage1.reviewed-candidate-import-item.v1',
              'bundle_sha256', v_bundle_sha,
              'item_sha256', v_item_sha
            ),
            'intake_value_sha256', v_candidate.intake_value_sha256,
            'extracted_at', v_candidate.extracted_at,
            'model', v_candidate.model
          )
        )
      )
    )
  );
  perform pg_temp.awardping_probe_assert(
    private.stage1_review_fact_bijection_valid(
      v_public_facts,
      v_review_root #> array['cohorts', '0', 'field_choices'],
      v_evidence_rows,
      array[v_candidate.id]
    ),
    'valid reviewed fact/choice/evidence bijection was rejected'
  );
  perform pg_temp.awardping_probe_assert(
    not private.stage1_review_fact_bijection_valid(
      v_public_facts || pg_catalog.jsonb_build_object(
        'overview', 'Unsupported fact reusing the deadline candidate.'
      ),
      v_review_root #> array['cohorts', '0', 'field_choices'],
      v_evidence_rows || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(
            v_evidence_rows -> 0,
            '{field_name}',
            pg_catalog.to_jsonb('overview'::text)
          ),
          '{public_value}',
          pg_catalog.to_jsonb(
            'Unsupported fact reusing the deadline candidate.'::text
          )
        )
      ),
      array[v_candidate.id]
    ),
    'reviewed bijection accepted a non-empty fact with no reviewed field choice'
  );
  v_audit_projection := pg_catalog.jsonb_build_object(
    'stage1_review_root_schema_version',
      'awardping.stage1.human-review-root.v1',
    'stage1_review_root_sha256', v_root_hash,
    'stage1_reviewed_public_facts_sha256',
      private.stage1_canonical_json_sha256(v_public_facts),
    'stage1_reviewed_summary_sha256',
      private.stage1_text_sha256(v_summary),
    'stage1_reviewed_confidence_sha256',
      private.stage1_canonical_json_sha256(
        pg_catalog.to_jsonb(1::double precision)
      ),
    'stage1_reviewed_evidence_rows_sha256',
      private.stage1_reviewed_evidence_rows_sha256(v_evidence_rows)
  );
  v_audit_base := pg_catalog.jsonb_build_object(
    'shared_award_id', v_award.id,
    'audit_kind', 'deterministic',
    'audit_status', 'passed',
    'severity', 'info',
    'findings', '[]'::jsonb,
    'suggested_fixes', '[]'::jsonb,
    'field_conflicts', '[]'::jsonb,
    'source_rejections', '[]'::jsonb,
    'selected_fact_summary', pg_catalog.jsonb_build_object(
      'deadline', pg_catalog.jsonb_build_array(v_candidate.id)
    ) || v_audit_projection,
    'public_page_snapshot', v_public_facts,
    'model', 'explicit-human-reviewed-stage1-reconciliation'
  );
  v_signature := private.stage1_canonical_json_sha256(v_audit_base);
  v_audit := v_audit_base || pg_catalog.jsonb_build_object(
    'public_page_snapshot', (v_audit_base -> 'public_page_snapshot') ||
      pg_catalog.jsonb_build_object(
        'reconciliation_audit_signature', v_signature
      )
  );

  insert into public.shared_award_reconciliation_queue (
    id, shared_award_id, reason, status, started_at, generation,
    source_ids, candidate_ids, metadata
  ) values (
    v_auto_queue_id, v_award.id, 'explicit_human_review', 'processing',
    v_auto_started_at, 0, array[v_source.id], array[v_candidate.id],
    pg_catalog.jsonb_build_object(
      'processor', 'reconcile-reviewed-stage1-selection',
      'selection_mode', 'explicit_human_review',
      'stage1_review_root_schema_version',
        'awardping.stage1.human-review-root.v1',
      'stage1_review_root_sha256', v_root_hash,
      'reviewed_contributor_source_ids',
        pg_catalog.to_jsonb(array[v_source.id]),
      'reviewed_candidate_ids',
        pg_catalog.to_jsonb(array[v_candidate.id])
    )
  );
  begin
    perform public.commit_award_reconciliation_publication(
      v_auto_queue_id,
      v_award.id,
      v_auto_started_at,
      0,
      v_award.updated_at,
      v_award.public_facts,
      'Pre-shaped direct core rootless bypass must fail.',
      v_public_facts,
      1,
      v_evidence_rows,
      array[v_source.id],
      array[v_candidate.id],
      '[]'::jsonb,
      v_candidate_mutations,
      v_audit
    );
  exception when sqlstate '23514' then
    v_auto_rejected := true;
  end;
  perform pg_temp.awardping_probe_assert(
    v_auto_rejected
      and (
        select queue.status = 'processing'
          and queue.completed_at is null
          and queue.metadata ->> 'stage1_review_root_sha256' = v_root_hash
        from public.shared_award_reconciliation_queue queue
        where queue.id = v_auto_queue_id
      )
      and (
        select candidate.candidate_status = v_candidate.candidate_status
          and candidate.updated_at = v_candidate.updated_at
        from public.shared_award_fact_candidates candidate
        where candidate.id = v_candidate.id
      )
      and (
        select award.public_facts = v_award.public_facts
          and award.updated_at = v_award.updated_at
        from public.shared_awards award
        where award.id = v_award.id
      )
      and not exists (
        select 1
        from private.stage1_human_review_roots stored
        where stored.root_sha256 = v_root_hash
      )
      and not exists (
        select 1
        from private.stage1_reviewed_reconciliation_authorizations authz
        where authz.reconciliation_id = v_reviewed_queue_id
      )
      and not exists (
        select 1
        from public.shared_award_page_audits audit
        where audit.shared_award_id = v_award.id
          and audit.public_page_snapshot ->> 'reconciliation_audit_signature'
            = v_signature
      ),
    'pre-shaped direct core success bypassed private-root enforcement or left partial writes'
  );
  delete from public.shared_award_reconciliation_queue queue
  where queue.id = v_auto_queue_id
    and queue.status = 'processing';

  v_evidence_rows := pg_catalog.jsonb_set(
    v_evidence_rows,
    '{0,evidence,reconciliation_id}',
    pg_catalog.to_jsonb(v_reviewed_queue_id::text)
  );
  -- The direct-core bypass above uses its own queue ID. Rebind the signed
  -- evidence hash and audit signature after switching the immutable evidence
  -- row to the dedicated reviewed queue.
  v_audit_projection := pg_catalog.jsonb_set(
    v_audit_projection,
    '{stage1_reviewed_evidence_rows_sha256}',
    pg_catalog.to_jsonb(
      private.stage1_reviewed_evidence_rows_sha256(v_evidence_rows)
    )
  );
  v_audit_base := pg_catalog.jsonb_set(
    v_audit_base,
    '{selected_fact_summary}',
    (v_audit_base -> 'selected_fact_summary') || v_audit_projection
  );
  v_signature := private.stage1_canonical_json_sha256(v_audit_base);
  v_audit := v_audit_base || pg_catalog.jsonb_build_object(
    'public_page_snapshot', (v_audit_base -> 'public_page_snapshot') ||
      pg_catalog.jsonb_build_object(
        'reconciliation_audit_signature', v_signature
      )
  );
  v_review_binding := pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.reviewed-reconciliation-commit.v1',
    'policy_version', 'stage1-publication-v1',
    'cohort_key', v_registry.cohort_key,
    'canonical_shared_award_id', v_award.id,
    'public_facts', v_public_facts,
    'selection_sha256', v_root_hash,
    'stage1_review_root_schema_version',
      'awardping.stage1.human-review-root.v1',
    'stage1_review_root_sha256', v_root_hash,
    'review', v_review,
    'review_root', v_review_root,
    'award', pg_catalog.jsonb_build_object(
      'id', v_award.id,
      'updated_at', v_award.updated_at,
      'current_public_facts', v_award.public_facts,
      'current_public_facts_sha256',
        private.stage1_canonical_json_sha256(v_award.public_facts),
      'replacement_public_facts', v_public_facts,
      'replacement_public_facts_sha256',
        private.stage1_canonical_json_sha256(v_public_facts),
      'replacement_summary', v_summary,
      'replacement_summary_sha256', private.stage1_text_sha256(v_summary),
      'replacement_confidence', 1,
      'replacement_confidence_sha256',
        private.stage1_canonical_json_sha256('1'::jsonb)
    ),
    'source_ids', pg_catalog.jsonb_build_array(v_source.id),
    'review_source_ids', pg_catalog.jsonb_build_array(v_source.id),
    'candidate_ids', pg_catalog.jsonb_build_array(v_candidate.id),
    'source_snapshots', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'source_id', v_source.id,
        'shared_award_id', v_source.shared_award_id,
        'source_url', v_source.url,
        'source_updated_at', v_source.updated_at,
        'last_checked_at', v_source.last_checked_at,
        'bucket', v_snapshot.bucket,
        'kind', v_snapshot.kind,
        'snapshot_updated_at', v_snapshot.updated_at,
        'captured_at', v_snapshot.latest_captured_at,
        'object_keys', v_snapshot.latest_object_keys,
        'hashes', v_snapshot.latest_hashes,
        'metadata', v_snapshot.latest_metadata
      )
    ),
    'candidate_versions', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'candidate_id', v_candidate.id,
        'shared_award_id', v_candidate.shared_award_id,
        'source_id', v_candidate.shared_award_source_id,
        'field_name', v_candidate.field_name,
        'source_relevance', v_candidate.source_role,
        'reviewed_stage1_source_role', 'dates_cycle',
        'composition_method', 'direct_exact',
        'composition_index', null,
        'candidate_status', v_candidate.candidate_status,
        'normalized_value', v_candidate.normalized_value,
        'evidence_quote', v_candidate.evidence_quote,
        'evidence_location', v_candidate.evidence_location,
        'immutable_evidence',
          v_candidate.metadata -> 'stage1_immutable_evidence',
        'candidate_import', pg_catalog.jsonb_build_object(
          'schema_version',
            'awardping.stage1.reviewed-candidate-import-item.v1',
          'bundle_sha256', v_bundle_sha,
          'item_sha256', v_item_sha
        ),
        'intake_value_sha256', v_candidate.intake_value_sha256,
        'extracted_at', v_candidate.extracted_at,
        'model', v_candidate.model,
        'updated_at', v_candidate.updated_at
      )
    )
  );
  insert into public.shared_award_reconciliation_queue (
    id, shared_award_id, reason, status, started_at, generation,
    source_ids, candidate_ids, metadata
  ) values (
    v_reviewed_queue_id, v_award.id, 'explicit_human_review', 'processing',
    v_reviewed_started_at, 0, array[v_source.id], array[v_candidate.id],
    '{"probe":true}'::jsonb
  );

  perform pg_temp.awardping_probe_assert(
    (
      select class.relrowsecurity
      from pg_catalog.pg_class class
      where class.oid = 'private.stage1_human_review_roots'::pg_catalog.regclass
    )
      and pg_catalog.has_table_privilege(
        'service_role', 'private.stage1_human_review_roots', 'SELECT'
      )
      and pg_catalog.has_function_privilege(
        'service_role', 'public.get_stage1_human_review_root(text)', 'EXECUTE'
      )
      and not pg_catalog.has_table_privilege(
        'service_role', 'private.stage1_human_review_roots', 'INSERT'
      )
      and not pg_catalog.has_table_privilege(
        'service_role', 'private.stage1_human_review_roots', 'UPDATE'
      )
      and not pg_catalog.has_table_privilege(
        'service_role', 'private.stage1_human_review_roots', 'DELETE'
      )
      and not pg_catalog.has_table_privilege(
        'anon', 'private.stage1_human_review_roots', 'SELECT'
      )
      and not pg_catalog.has_table_privilege(
        'authenticated', 'private.stage1_human_review_roots', 'SELECT'
      )
      and not pg_catalog.has_function_privilege(
        'anon', 'public.get_stage1_human_review_root(text)', 'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated', 'public.get_stage1_human_review_root(text)', 'EXECUTE'
      )
      and exists (
        select 1
        from pg_catalog.pg_policy policy
        where policy.polrelid =
            'private.stage1_human_review_roots'::pg_catalog.regclass
          and policy.polname = 'stage1_human_review_roots_service_read'
      ),
    'human-review root registry did not enforce private service-only reads'
  );

  begin
    perform public.commit_reviewed_stage1_reconciliation_publication(
      v_reviewed_queue_id,
      v_award.id,
      v_reviewed_started_at,
      0,
      v_award.updated_at,
      v_award.public_facts,
      'Unsigned summary substitution must fail.',
      v_public_facts,
      1,
      v_evidence_rows,
      array[v_source.id],
      array[v_candidate.id],
      '[]'::jsonb,
      v_candidate_mutations,
      v_audit,
      v_review_binding
    );
  exception when sqlstate '22023' then
    v_projection_rejected := true;
  end;

  begin
    perform public.commit_reviewed_stage1_reconciliation_publication(
      v_reviewed_queue_id,
      v_award.id,
      v_reviewed_started_at,
      0,
      v_award.updated_at,
      v_award.public_facts,
      v_summary,
      v_public_facts,
      1,
      v_evidence_rows,
      array[v_source.id],
      array[v_candidate.id],
      '[]'::jsonb,
      v_candidate_mutations,
      pg_catalog.jsonb_set(
        v_audit,
        '{severity}',
        pg_catalog.to_jsonb('warning'::text)
      ),
      v_review_binding
    );
  exception when sqlstate '22023' then
    v_audit_projection_rejected := true;
  end;

  -- The reviewed wrapper must reject a vague quote even when every other
  -- candidate/version field is unchanged. The exception boundary also proves
  -- that the temporary candidate mutation cannot leak out of the check.
  begin
    update public.shared_award_fact_candidates candidate
    set evidence_quote = 'Official source page.'
    where candidate.id = v_candidate.id;

    perform public.commit_reviewed_stage1_reconciliation_publication(
      v_reviewed_queue_id,
      v_award.id,
      v_reviewed_started_at,
      0,
      v_award.updated_at,
      v_award.public_facts,
      v_summary,
      v_public_facts,
      1,
      v_evidence_rows,
      array[v_source.id],
      array[v_candidate.id],
      '[]'::jsonb,
      v_candidate_mutations,
      v_audit,
      v_review_binding
    );
    raise exception using
      errcode = 'P9101',
      message = 'Reviewed wrapper accepted a generic evidence quote.';
  exception
    when sqlstate '40001' then
      v_generic_quote_rejected := true;
    when sqlstate 'P9101' then
      null;
  end;

  -- Candidate evidence must retain the signed immutable marker. Removing it
  -- inside this subtransaction must fail before publication and roll back.
  begin
    update public.shared_award_fact_candidates candidate
    set metadata = candidate.metadata - 'stage1_immutable_evidence'
    where candidate.id = v_candidate.id;

    perform public.commit_reviewed_stage1_reconciliation_publication(
      v_reviewed_queue_id,
      v_award.id,
      v_reviewed_started_at,
      0,
      v_award.updated_at,
      v_award.public_facts,
      v_summary,
      v_public_facts,
      1,
      v_evidence_rows,
      array[v_source.id],
      array[v_candidate.id],
      '[]'::jsonb,
      v_candidate_mutations,
      v_audit,
      v_review_binding
    );
    raise exception using
      errcode = 'P9102',
      message = 'Reviewed wrapper accepted a missing immutable marker.';
  exception
    when sqlstate '40001' then
      v_missing_marker_rejected := true;
    when sqlstate 'P9102' then
      null;
  end;

  -- The candidate is reviewed only for dates_cycle. Relabeling that exact
  -- candidate as identity_home must not be accepted by a ranked or fuzzy role
  -- substitution.
  v_bad_review_binding := pg_catalog.jsonb_set(
    v_review_binding,
    '{candidate_versions,0,reviewed_stage1_source_role}',
    pg_catalog.to_jsonb('identity_home'::text)
  );
  begin
    perform public.commit_reviewed_stage1_reconciliation_publication(
      v_reviewed_queue_id,
      v_award.id,
      v_reviewed_started_at,
      0,
      v_award.updated_at,
      v_award.public_facts,
      v_summary,
      v_public_facts,
      1,
      v_evidence_rows,
      array[v_source.id],
      array[v_candidate.id],
      '[]'::jsonb,
      v_candidate_mutations,
      v_audit,
      v_bad_review_binding
    );
    raise exception using
      errcode = 'P9103',
      message = 'Reviewed wrapper accepted a candidate under the wrong role.';
  exception
    when sqlstate '40001' then
      v_wrong_role_rejected := true;
    when sqlstate 'P9103' then
      null;
  end;

  -- direct_exact has no composition index. Adding index zero simulates an
  -- order/composition substitution and must fail closed.
  v_bad_review_binding := pg_catalog.jsonb_set(
    v_review_binding,
    '{candidate_versions,0,composition_index}',
    pg_catalog.to_jsonb(0)
  );
  begin
    perform public.commit_reviewed_stage1_reconciliation_publication(
      v_reviewed_queue_id,
      v_award.id,
      v_reviewed_started_at,
      0,
      v_award.updated_at,
      v_award.public_facts,
      v_summary,
      v_public_facts,
      1,
      v_evidence_rows,
      array[v_source.id],
      array[v_candidate.id],
      '[]'::jsonb,
      v_candidate_mutations,
      v_audit,
      v_bad_review_binding
    );
    raise exception using
      errcode = 'P9104',
      message = 'Reviewed wrapper accepted a direct candidate composition index.';
  exception
    when sqlstate '40001' then
      v_wrong_order_rejected := true;
    when sqlstate 'P9104' then
      null;
  end;

  perform pg_temp.awardping_probe_assert(
    v_generic_quote_rejected
      and v_missing_marker_rejected
      and v_wrong_role_rejected
      and v_wrong_order_rejected
      and v_projection_rejected
      and v_audit_projection_rejected
      and (
        select queue.status = 'processing'
          and queue.completed_at is null
          and queue.metadata = '{"probe":true}'::jsonb
        from public.shared_award_reconciliation_queue queue
        where queue.id = v_reviewed_queue_id
      )
      and (
        select candidate.evidence_quote = v_candidate.evidence_quote
          and candidate.metadata = v_candidate.metadata
          and candidate.candidate_status = v_candidate.candidate_status
          and candidate.updated_at = v_candidate.updated_at
        from public.shared_award_fact_candidates candidate
        where candidate.id = v_candidate.id
      )
      and not exists (
        select 1
        from private.stage1_human_review_roots stored
        where stored.root_sha256 = v_root_hash
      ),
    'reviewed candidate negative checks accepted a substitution or leaked partial writes'
  );

  -- Seed the same digest with a structurally valid but different root inside a
  -- subtransaction. The reviewed wrapper must reject the collision, and the
  -- sentinel exception must roll the collision fixture back before the real
  -- reviewed commit runs.
  begin
    insert into private.stage1_human_review_roots (
      root_sha256,
      schema_version,
      policy_version,
      cohort_key,
      canonical_shared_award_id,
      public_facts_sha256,
      summary_sha256,
      confidence_sha256,
      evidence_rows_sha256,
      audit_row_sha256,
      review_root,
      reviewed_at
    ) values (
      v_root_hash,
      'awardping.stage1.human-review-root.v1',
      'stage1-publication-v1',
      v_registry.cohort_key,
      v_award.id,
      private.stage1_canonical_json_sha256(v_public_facts),
      private.stage1_text_sha256(v_summary),
      private.stage1_canonical_json_sha256('1'::jsonb),
      private.stage1_reviewed_evidence_rows_sha256(v_evidence_rows),
      private.stage1_reviewed_audit_row_sha256(v_audit),
      pg_catalog.jsonb_set(
        v_review_root,
        '{review,reason}',
        pg_catalog.to_jsonb('Deliberate collision fixture.'::text)
      ),
      private.stage1_safe_timestamptz(
        v_review_binding #>> array['review', 'reviewed_at']
      )
    );

    begin
      perform public.commit_reviewed_stage1_reconciliation_publication(
        v_reviewed_queue_id,
        v_award.id,
        v_reviewed_started_at,
        0,
        v_award.updated_at,
        v_award.public_facts,
        v_summary,
        v_public_facts,
        1,
        v_evidence_rows,
        array[v_source.id],
        array[v_candidate.id],
        '[]'::jsonb,
        v_candidate_mutations,
        v_audit,
        v_review_binding
      );
    exception when sqlstate '23505' then
      v_collision_rejected := true;
    end;

    perform pg_temp.awardping_probe_assert(
      v_collision_rejected,
      'reviewed wrapper accepted a colliding immutable human-review root'
    );
    raise exception using
      errcode = 'P9001',
      message = 'Rollback the deliberate human-review root collision fixture.';
  exception when sqlstate 'P9001' then
    null;
  end;

  perform pg_temp.awardping_probe_assert(
    v_collision_rejected
      and not exists (
        select 1
        from private.stage1_human_review_roots stored
        where stored.root_sha256 = v_root_hash
      )
      and (
        select queue.status = 'processing'
          and queue.completed_at is null
        from public.shared_award_reconciliation_queue queue
        where queue.id = v_reviewed_queue_id
      ),
    'collision rejection retained its fixture or partially changed the queue'
  );

  -- A stale queue CAS fails only after the reviewed wrapper inserts the root.
  -- Catching that failure must roll the inserted root and metadata write back.
  begin
    perform public.commit_reviewed_stage1_reconciliation_publication(
      v_reviewed_queue_id,
      v_award.id,
      v_reviewed_started_at + interval '1 second',
      0,
      v_award.updated_at,
      v_award.public_facts,
      v_summary,
      v_public_facts,
      1,
      v_evidence_rows,
      array[v_source.id],
      array[v_candidate.id],
      '[]'::jsonb,
      v_candidate_mutations,
      v_audit,
      v_review_binding
    );
  exception when sqlstate '40001' then
    v_commit_failure_rejected := true;
  end;
  perform pg_temp.awardping_probe_assert(
    v_commit_failure_rejected
      and not exists (
        select 1
        from private.stage1_human_review_roots stored
        where stored.root_sha256 = v_root_hash
      )
      and (
        select queue.status = 'processing'
          and queue.completed_at is null
          and queue.metadata = '{"probe":true}'::jsonb
        from public.shared_award_reconciliation_queue queue
        where queue.id = v_reviewed_queue_id
      ),
    'failed reviewed commit retained its inserted root or queue metadata'
  );

  -- Insert and read the exact immutable root first. The reviewed wrapper below
  -- must then reuse this identical row instead of duplicating or mutating it.
  insert into private.stage1_human_review_roots (
    root_sha256,
    schema_version,
    policy_version,
    cohort_key,
    canonical_shared_award_id,
    public_facts_sha256,
    summary_sha256,
    confidence_sha256,
    evidence_rows_sha256,
    audit_row_sha256,
    review_root,
    reviewed_at
  ) values (
    v_root_hash,
    'awardping.stage1.human-review-root.v1',
    'stage1-publication-v1',
    v_registry.cohort_key,
    v_award.id,
    private.stage1_canonical_json_sha256(v_public_facts),
    private.stage1_text_sha256(v_summary),
    private.stage1_canonical_json_sha256('1'::jsonb),
    private.stage1_reviewed_evidence_rows_sha256(v_evidence_rows),
    private.stage1_reviewed_audit_row_sha256(v_audit),
    v_review_root,
    private.stage1_safe_timestamptz(
      v_review_binding #>> array['review', 'reviewed_at']
    )
  );
  perform pg_temp.awardping_probe_assert(
    (
      select stored.schema_version =
            'awardping.stage1.human-review-root.v1'
          and stored.policy_version = 'stage1-publication-v1'
          and stored.cohort_key = v_registry.cohort_key
          and stored.canonical_shared_award_id = v_award.id
          and stored.public_facts_sha256 =
            private.stage1_canonical_json_sha256(v_public_facts)
          and stored.summary_sha256 = private.stage1_text_sha256(v_summary)
          and stored.confidence_sha256 =
            private.stage1_canonical_json_sha256('1'::jsonb)
          and stored.evidence_rows_sha256 =
            private.stage1_reviewed_evidence_rows_sha256(v_evidence_rows)
          and stored.audit_row_sha256 =
            private.stage1_reviewed_audit_row_sha256(v_audit)
          and stored.review_root = v_review_root
          and stored.reviewed_at = private.stage1_safe_timestamptz(
            v_review_binding #>> array['review', 'reviewed_at']
          )
      from private.stage1_human_review_roots stored
      where stored.root_sha256 = v_root_hash
    ),
    'exact immutable human-review root was not inserted and readable'
  );

  v_retrieved_root := public.get_stage1_human_review_root(v_root_hash);
  perform pg_temp.awardping_probe_assert(
    v_retrieved_root ->> 'schema_version' =
        'awardping.stage1.human-review-root-retrieval.v1'
      and v_retrieved_root ->> 'root_sha256' = v_root_hash
      and v_retrieved_root ->> 'recomputed_sha256' = v_root_hash
      and v_retrieved_root -> 'hash_matches' = 'true'::jsonb
      and v_retrieved_root ->> 'cohort_key' = v_registry.cohort_key
      and v_retrieved_root ->> 'canonical_shared_award_id' = v_award.id::text
      and v_retrieved_root -> 'review_root' = v_review_root
      and public.get_stage1_human_review_root(
        pg_catalog.repeat('f', 64)
      ) is null,
    'service recovery reader did not return an exact hash-matched root or null for missing evidence'
  );
  begin
    perform public.get_stage1_human_review_root('NOT-A-VALID-HASH');
  exception when sqlstate '22023' then
    v_invalid_hash_rejected := true;
  end;
  perform pg_temp.awardping_probe_assert(
    v_invalid_hash_rejected,
    'service recovery reader accepted an invalid root hash'
  );

  v_result := public.commit_reviewed_stage1_reconciliation_publication(
    v_reviewed_queue_id,
    v_award.id,
    v_reviewed_started_at,
    0,
    v_award.updated_at,
    v_award.public_facts,
    v_summary,
    v_public_facts,
    1,
    v_evidence_rows,
    array[v_source.id],
    array[v_candidate.id],
    '[]'::jsonb,
    v_candidate_mutations,
    v_audit,
    v_review_binding
  );
  perform pg_temp.awardping_probe_assert(
    v_result.status = 'succeeded'
      and v_result.reason = 'explicit_human_review'
      and v_result.metadata ->> 'processor'
        = 'reconcile-reviewed-stage1-selection'
      and v_result.metadata ->> 'selection_mode' = 'explicit_human_review'
      and v_result.metadata ->> 'stage1_review_root_schema_version'
        = 'awardping.stage1.human-review-root.v1'
      and v_result.metadata ->> 'stage1_review_root_sha256' = v_root_hash
      and v_result.metadata ->> 'stage1_reviewed_public_facts_sha256' =
        private.stage1_canonical_json_sha256(v_public_facts)
      and v_result.metadata ->> 'stage1_reviewed_summary_sha256' =
        private.stage1_text_sha256(v_summary)
      and v_result.metadata ->> 'stage1_reviewed_confidence_sha256' =
        private.stage1_canonical_json_sha256(
          pg_catalog.to_jsonb(1::double precision)
        )
      and v_result.metadata ->> 'stage1_reviewed_evidence_rows_sha256' =
        private.stage1_reviewed_evidence_rows_sha256(v_evidence_rows)
      and v_result.metadata ->> 'stage1_reviewed_audit_row_sha256' =
        private.stage1_reviewed_audit_row_sha256(v_audit)
      and v_result.metadata -> 'reviewed_contributor_source_ids'
        = pg_catalog.to_jsonb(array[v_source.id])
      and v_result.metadata -> 'reviewed_candidate_ids'
        = pg_catalog.to_jsonb(array[v_candidate.id])
      and (
        select pg_catalog.count(*) = 1
        from private.stage1_human_review_roots stored
        where stored.root_sha256 = v_root_hash
          and stored.review_root = v_review_root
          and stored.audit_row_sha256 =
            private.stage1_reviewed_audit_row_sha256(v_audit)
      )
      and not exists (
        select 1
        from private.stage1_reviewed_reconciliation_authorizations authz
        where authz.reconciliation_id = v_reviewed_queue_id
      )
      and (
        select candidate.candidate_status = 'selected'
        from public.shared_award_fact_candidates candidate
        where candidate.id = v_candidate.id
      )
      and (
        select award.public_facts = v_public_facts
          and award.summary = v_summary
          and award.confidence = 1
        from public.shared_awards award
        where award.id = v_award.id
      )
      and (
        select private.stage1_reviewed_audit_row_sha256(
            pg_catalog.jsonb_build_object(
              'shared_award_id', audit.shared_award_id,
              'audit_kind', audit.audit_kind,
              'audit_status', audit.audit_status,
              'severity', audit.severity,
              'findings', audit.findings,
              'suggested_fixes', audit.suggested_fixes,
              'field_conflicts', audit.field_conflicts,
              'source_rejections', audit.source_rejections,
              'selected_fact_summary', audit.selected_fact_summary,
              'public_page_snapshot', audit.public_page_snapshot,
              'model', audit.model
            )
          ) = private.stage1_reviewed_audit_row_sha256(v_audit)
          and audit.public_page_snapshot -
              'reconciliation_audit_signature' =
            v_audit_base -> 'public_page_snapshot'
          and audit.selected_fact_summary =
            v_audit_base -> 'selected_fact_summary'
        from public.shared_award_page_audits audit
        where audit.shared_award_id = v_award.id
          and audit.public_page_snapshot ->> 'reconciliation_audit_signature'
            = v_signature
        order by audit.created_at desc, audit.id desc
        limit 1
      ),
    'reviewed Stage 1 wrapper did not pass its trigger with exact root-bound evidence'
  );

  -- A stored root is not a reusable bearer token. Replaying it through the
  -- legacy core with a different, internally coherent fact/evidence/audit
  -- payload must fail at the Stage 1 success trigger and roll back atomically.
  select award.* into strict v_award
  from public.shared_awards award
  where award.id = v_registry.canonical_shared_award_id;

  v_replay_public_facts := pg_catalog.jsonb_set(
    v_public_facts,
    '{deadline}',
    pg_catalog.to_jsonb('2099-12-31 (not human reviewed)'::text),
    false
  );
  v_replay_evidence_rows := pg_catalog.jsonb_set(
    v_evidence_rows,
    '{0,public_value}',
    v_replay_public_facts -> 'deadline',
    false
  );
  v_replay_evidence_rows := pg_catalog.jsonb_set(
    v_replay_evidence_rows,
    '{0,evidence,reconciliation_id}',
    pg_catalog.to_jsonb(v_replay_queue_id::text),
    false
  );
  v_replay_evidence_rows := pg_catalog.jsonb_set(
    v_replay_evidence_rows,
    '{0,evidence,public_value}',
    v_replay_public_facts -> 'deadline',
    false
  );
  v_replay_evidence_rows := pg_catalog.jsonb_set(
    v_replay_evidence_rows,
    array[
      '0', 'evidence', 'candidate_bindings', v_candidate.id::text,
      'selected_value'
    ],
    v_replay_public_facts -> 'deadline',
    false
  );
  v_replay_evidence_rows := pg_catalog.jsonb_set(
    v_replay_evidence_rows,
    array[
      '0', 'evidence', 'candidate_bindings', v_candidate.id::text,
      'public_field_value'
    ],
    v_replay_public_facts -> 'deadline',
    false
  );
  v_replay_audit := pg_catalog.jsonb_set(
    v_audit,
    '{public_page_snapshot}',
    v_replay_public_facts || pg_catalog.jsonb_build_object(
      'reconciliation_audit_signature', v_replay_signature
    ),
    false
  );

  insert into public.shared_award_reconciliation_queue (
    id, shared_award_id, reason, status, started_at, generation,
    source_ids, candidate_ids, metadata
  ) values (
    v_replay_queue_id, v_award.id, 'explicit_human_review', 'processing',
    v_replay_started_at, 0, array[v_source.id], array[v_candidate.id],
    pg_catalog.jsonb_build_object(
      'processor', 'reconcile-reviewed-stage1-selection',
      'selection_mode', 'explicit_human_review',
      'stage1_review_root_schema_version',
        'awardping.stage1.human-review-root.v1',
      'stage1_review_root_sha256', v_root_hash,
      'stage1_reviewed_public_facts_sha256',
        private.stage1_canonical_json_sha256(v_replay_public_facts),
      'stage1_reviewed_summary_sha256',
        private.stage1_text_sha256('Stored-root replay probe must fail.'),
      'stage1_reviewed_confidence_sha256',
        private.stage1_canonical_json_sha256('1'::jsonb),
      'stage1_reviewed_evidence_rows_sha256',
        private.stage1_reviewed_evidence_rows_sha256(v_replay_evidence_rows),
      'stage1_reviewed_audit_row_sha256',
        private.stage1_reviewed_audit_row_sha256(v_replay_audit),
      'stage1_reviewed_audit_signature', v_replay_signature,
      'reviewed_contributor_source_ids',
        pg_catalog.to_jsonb(array[v_source.id]),
      'reviewed_candidate_ids',
        pg_catalog.to_jsonb(array[v_candidate.id])
    )
  );

  begin
    perform public.commit_award_reconciliation_publication(
      v_replay_queue_id,
      v_award.id,
      v_replay_started_at,
      0,
      v_award.updated_at,
      v_award.public_facts,
      'Stored-root replay probe must fail.',
      v_replay_public_facts,
      1,
      v_replay_evidence_rows,
      array[v_source.id],
      array[v_candidate.id],
      '[]'::jsonb,
      '[]'::jsonb,
      v_replay_audit
    );
    raise exception using
      errcode = 'P9106',
      message = 'Legacy core replay reused a consumed Stage 1 review root.';
  exception
    when sqlstate '23514' then
      v_stored_root_replay_rejected := true;
    when sqlstate 'P9106' then
      null;
  end;

  perform pg_temp.awardping_probe_assert(
    v_stored_root_replay_rejected
      and (
        select queue.status = 'processing'
          and queue.completed_at is null
        from public.shared_award_reconciliation_queue queue
        where queue.id = v_replay_queue_id
      )
      and (
        select award.public_facts = v_public_facts
        from public.shared_awards award
        where award.id = v_award.id
      )
      and not exists (
        select 1
        from public.stage1_award_reconciled_fact_evidence evidence
        where evidence.reconciliation_id = v_replay_queue_id
      )
      and not exists (
        select 1
        from public.shared_award_page_audits audit
        where audit.shared_award_id = v_award.id
          and audit.public_page_snapshot ->> 'reconciliation_audit_signature'
            = v_replay_signature
      )
      and not exists (
        select 1
        from private.stage1_reviewed_reconciliation_authorizations authz
        where authz.reconciliation_id = v_replay_queue_id
      ),
    'stored review-root replay was accepted or left partial publication state'
  );
  -- This negative fixture must remain processing to prove the failed replay
  -- was atomic, but it must not occupy the award's one-active-queue slot for
  -- later independent contracts in this same rollback transaction.
  delete from public.shared_award_reconciliation_queue queue
  where queue.id = v_replay_queue_id;

  begin
    update private.stage1_human_review_roots stored
    set review_root = stored.review_root
    where stored.root_sha256 = v_root_hash;
  exception when sqlstate '55000' then
    v_update_rejected := true;
  end;
  begin
    delete from private.stage1_human_review_roots stored
    where stored.root_sha256 = v_root_hash;
  exception when sqlstate '55000' then
    v_delete_rejected := true;
  end;
  perform pg_temp.awardping_probe_assert(
    v_update_rejected
      and v_delete_rejected
      and (
        select pg_catalog.count(*) = 1
        from private.stage1_human_review_roots stored
        where stored.root_sha256 = v_root_hash
          and stored.review_root = v_review_root
      ),
    'immutable human-review root registry allowed update or delete'
  );
  -- Later rollback-probe contracts reuse this rollback-only candidate as a
  -- pending CAS fixture. Restore only that fixture status after proving the
  -- reviewed transition; the outer transaction still owns all changes.
  update public.shared_award_fact_candidates candidate
  set
    candidate_status = 'pending',
    selected_reason = null,
    rejection_reason = null
  where candidate.id = v_candidate.id
    and candidate.candidate_status = 'selected';
end;
$reviewed_reconciliation_contract$;

insert into public.shared_award_reconciliation_queue (
  id, shared_award_id, reason, status, started_at, generation, metadata
) values (
  '00000000-0000-4000-8000-00000000a005'::uuid,
  '00000000-0000-4000-8000-00000000a001'::uuid,
  'rollback_probe_stale_candidate_cas', 'processing',
  '2026-07-17T03:00:00Z'::timestamptz, 0, '{"probe":true}'::jsonb
);

do $stale_cas_contract$
declare
  v_expected_award_updated_at timestamptz;
  v_expected_public_facts jsonb;
  v_candidate_updated_at timestamptz;
  v_result public.shared_award_reconciliation_queue%rowtype;
  v_caught boolean := false;
begin
  select award.updated_at, award.public_facts
    into v_expected_award_updated_at, v_expected_public_facts
  from public.shared_awards award
  where award.id = '00000000-0000-4000-8000-00000000a001'::uuid;
  select candidate.updated_at into v_candidate_updated_at
  from public.shared_award_fact_candidates candidate
  where candidate.id = '00000000-0000-4000-8000-00000000a004'::uuid;

  begin
    perform public.commit_award_reconciliation_blocked(
      '00000000-0000-4000-8000-00000000a005'::uuid,
      '00000000-0000-4000-8000-00000000a001'::uuid,
      '2026-07-17T03:00:00Z'::timestamptz,
      0,
      v_expected_award_updated_at,
      v_expected_public_facts,
      '[]'::jsonb,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'id', '00000000-0000-4000-8000-00000000a004',
        'expected_status', 'pending',
        'expected_updated_at', v_candidate_updated_at - interval '1 second',
        'candidate_status', 'rejected',
        'selected_reason', null,
        'rejection_reason', 'probe stale mutation'
      )),
      pg_catalog.jsonb_build_object(
        'shared_award_id', '00000000-0000-4000-8000-00000000a001',
        'audit_kind', 'deterministic', 'audit_status', 'failed',
        'severity', 'critical', 'findings', '[]'::jsonb,
        'suggested_fixes', '[]'::jsonb, 'field_conflicts', '[]'::jsonb,
        'source_rejections', '[]'::jsonb, 'selected_fact_summary', '{}'::jsonb,
        'public_page_snapshot', pg_catalog.jsonb_build_object(
          'reconciliation_audit_signature', pg_catalog.repeat('c', 64)
        ),
        'model', 'rollback-probe'
      ),
      'probe stale CAS'
    );
  exception when sqlstate '40001' then
    v_caught := true;
  end;
  perform pg_temp.awardping_probe_assert(v_caught, 'stale candidate CAS did not raise 40001');
  perform pg_temp.awardping_probe_assert(
    (select status = 'processing' and completed_at is null
       from public.shared_award_reconciliation_queue
      where id = '00000000-0000-4000-8000-00000000a005'::uuid)
      and (select candidate_status = 'pending'
             from public.shared_award_fact_candidates
            where id = '00000000-0000-4000-8000-00000000a004'::uuid)
      and not exists (
        select 1 from public.shared_award_page_audits audit
        where audit.public_page_snapshot ->> 'reconciliation_audit_signature'
          = pg_catalog.repeat('c', 64)
      ),
    'stale CAS left a partial queue, candidate, or audit write'
  );
  v_result := public.finish_or_requeue_award_reconciliation_claim(
    '00000000-0000-4000-8000-00000000a005'::uuid,
    '00000000-0000-4000-8000-00000000a001'::uuid,
    '2026-07-17T03:00:00Z'::timestamptz,
    0,
    'pending',
    'probe safe requeue after 40001'
  );
  perform pg_temp.awardping_probe_assert(
    v_result.status = 'pending' and v_result.started_at is null,
    'stale CAS could not be safely requeued'
  );
end;
$stale_cas_contract$;

do $stage1_outcome_contract$
declare
  v_registry public.stage1_award_registry%rowtype;
  v_release public.stage1_publication_release_state%rowtype;
  v_award public.shared_awards%rowtype;
  v_result public.shared_award_reconciliation_queue%rowtype;
  v_event_count bigint;
  v_release_event_count bigint;
  v_epoch uuid;
  v_queue_id uuid;
  v_started_at timestamptz;
  v_status text;
  v_deleted_count integer;
begin
  select registry.* into v_registry
  from public.stage1_award_registry registry
  order by registry.launch_rank
  limit 1;
  select award.* into v_award
  from public.shared_awards award
  where award.id = v_registry.canonical_shared_award_id;

  -- Blocked, including the empty-candidate case, must invalidate once.
  v_epoch := '00000000-0000-4000-8000-00000000b001'::uuid;
  update public.stage1_award_registry
  set publication_state = 'verified_beta', state_reason = 'rollback probe',
      release_epoch = v_epoch, evidence_checked_at = statement_timestamp(),
      last_verified_at = statement_timestamp()
  where cohort_key = v_registry.cohort_key;
  -- The production public-digest trigger correctly refuses a synthetic
  -- activation when all 25 awards are not current. Bypass only that USER
  -- trigger for this transaction-only preparation update; normal triggers are
  -- restored before the reconciliation RPC exercises invalidation.
  alter table public.stage1_publication_release_state
    disable trigger supersede_stale_public_digest_reservations_on_release_trigger;
  update public.stage1_publication_release_state
  set release_state = 'verified_beta', release_epoch = v_epoch,
      activated_at = statement_timestamp(), reason = 'rollback probe'
  where release_key = 'stage1-national-25';
  alter table public.stage1_publication_release_state
    enable trigger supersede_stale_public_digest_reservations_on_release_trigger;
  v_queue_id := '00000000-0000-4000-8000-00000000a006'::uuid;
  v_started_at := '2026-07-17T04:00:00Z'::timestamptz;
  insert into public.shared_award_reconciliation_queue (
    id, shared_award_id, reason, status, started_at, generation, metadata
  ) values (
    v_queue_id, v_registry.canonical_shared_award_id,
    'rollback_probe_blocked_stage1', 'processing', v_started_at, 0,
    '{"probe":true}'::jsonb
  );
  select pg_catalog.count(*) into v_event_count
  from public.stage1_award_publication_events
  where cohort_key = v_registry.cohort_key;
  select pg_catalog.count(*) into v_release_event_count
  from public.stage1_publication_release_events
  where release_key = 'stage1-national-25';
  v_result := public.commit_award_reconciliation_blocked(
    v_queue_id, v_registry.canonical_shared_award_id, v_started_at, 0,
    v_award.updated_at, v_award.public_facts, '[]'::jsonb, '[]'::jsonb,
    pg_catalog.jsonb_build_object(
      'shared_award_id', v_registry.canonical_shared_award_id,
      'audit_kind', 'deterministic', 'audit_status', 'failed',
      'severity', 'critical', 'findings', '[]'::jsonb,
      'suggested_fixes', '[]'::jsonb, 'field_conflicts', '[]'::jsonb,
      'source_rejections', '[]'::jsonb, 'selected_fact_summary', '{}'::jsonb,
      'public_page_snapshot', pg_catalog.jsonb_build_object(
        'reconciliation_audit_signature', pg_catalog.repeat('d', 64)
      ),
      'model', 'rollback-probe'
    ),
    'rollback probe blocked outcome'
  );
  perform pg_temp.awardping_probe_assert(
    v_result.status = 'failed'
      and (select publication_state = 'revalidation_pending' and release_epoch is null
             from public.stage1_award_registry
            where cohort_key = v_registry.cohort_key)
      and (select release_state = 'revalidation_pending' and release_epoch is null
             from public.stage1_publication_release_state
            where release_key = 'stage1-national-25')
      and (select public_facts = v_award.public_facts
             from public.shared_awards
            where id = v_award.id)
      and (select pg_catalog.count(*) = v_event_count + 1
             from public.stage1_award_publication_events
            where cohort_key = v_registry.cohort_key)
      and (select pg_catalog.count(*) = v_release_event_count + 1
             from public.stage1_publication_release_events
            where release_key = 'stage1-national-25'),
    'blocked reconciliation did not atomically invalidate award/release exactly once'
  );

  -- Pending is a retry, not a terminal invalidation.
  v_epoch := '00000000-0000-4000-8000-00000000b002'::uuid;
  update public.stage1_award_registry
  set publication_state = 'verified_beta', state_reason = 'rollback probe',
      release_epoch = v_epoch, evidence_checked_at = statement_timestamp()
  where cohort_key = v_registry.cohort_key;
  alter table public.stage1_publication_release_state
    disable trigger supersede_stale_public_digest_reservations_on_release_trigger;
  update public.stage1_publication_release_state
  set release_state = 'verified_beta', release_epoch = v_epoch,
      activated_at = statement_timestamp(), reason = 'rollback probe'
  where release_key = 'stage1-national-25';
  alter table public.stage1_publication_release_state
    enable trigger supersede_stale_public_digest_reservations_on_release_trigger;
  v_queue_id := '00000000-0000-4000-8000-00000000a007'::uuid;
  v_started_at := '2026-07-17T05:00:00Z'::timestamptz;
  insert into public.shared_award_reconciliation_queue (
    id, shared_award_id, reason, status, started_at, generation, metadata
  ) values (
    v_queue_id, v_registry.canonical_shared_award_id,
    'rollback_probe_pending_stage1', 'processing', v_started_at, 0,
    '{"probe":true}'::jsonb
  );
  select pg_catalog.count(*) into v_event_count
  from public.stage1_award_publication_events
  where cohort_key = v_registry.cohort_key;
  v_result := public.finish_or_requeue_award_reconciliation_claim(
    v_queue_id, v_registry.canonical_shared_award_id, v_started_at, 0,
    'pending', 'rollback probe retry'
  );
  perform pg_temp.awardping_probe_assert(
    v_result.status = 'pending'
      and (select publication_state = 'verified_beta' and release_epoch = v_epoch
             from public.stage1_award_registry
            where cohort_key = v_registry.cohort_key)
      and (select release_state = 'verified_beta' and release_epoch = v_epoch
             from public.stage1_publication_release_state
            where release_key = 'stage1-national-25')
      and (select pg_catalog.count(*) = v_event_count
             from public.stage1_award_publication_events
            where cohort_key = v_registry.cohort_key),
    'pending retry incorrectly invalidated the Stage 1 release'
  );
  -- The queue's production uniqueness contract intentionally permits only one
  -- active reconciliation per award. The pending fixture has completed its
  -- assertion, so remove that exact rollback-only row before creating terminal
  -- fixtures for the same Stage 1 award.
  delete from public.shared_award_reconciliation_queue
  where id = '00000000-0000-4000-8000-00000000a007'::uuid
    and shared_award_id = v_registry.canonical_shared_award_id
    and status = 'pending';
  get diagnostics v_deleted_count = row_count;
  perform pg_temp.awardping_probe_assert(
    v_deleted_count = 1,
    'pending retry fixture was not removed exactly once before terminal probes'
  );

  -- Both terminal statuses must invalidate, and replay must be idempotent.
  foreach v_status in array array['failed', 'skipped'] loop
    v_epoch := case v_status
      when 'failed' then '00000000-0000-4000-8000-00000000b003'::uuid
      else '00000000-0000-4000-8000-00000000b004'::uuid
    end;
    v_queue_id := case v_status
      when 'failed' then '00000000-0000-4000-8000-00000000a008'::uuid
      else '00000000-0000-4000-8000-00000000a009'::uuid
    end;
    v_started_at := case v_status
      when 'failed' then '2026-07-17T06:00:00Z'::timestamptz
      else '2026-07-17T07:00:00Z'::timestamptz
    end;
    update public.stage1_award_registry
    set publication_state = 'verified_beta', state_reason = 'rollback probe',
        release_epoch = v_epoch, evidence_checked_at = statement_timestamp()
    where cohort_key = v_registry.cohort_key;
    alter table public.stage1_publication_release_state
      disable trigger supersede_stale_public_digest_reservations_on_release_trigger;
    update public.stage1_publication_release_state
    set release_state = 'verified_beta', release_epoch = v_epoch,
        activated_at = statement_timestamp(), reason = 'rollback probe'
    where release_key = 'stage1-national-25';
    alter table public.stage1_publication_release_state
      enable trigger supersede_stale_public_digest_reservations_on_release_trigger;
    insert into public.shared_award_reconciliation_queue (
      id, shared_award_id, reason, status, started_at, generation, metadata
    ) values (
      v_queue_id, v_registry.canonical_shared_award_id,
      'rollback_probe_terminal_' || v_status, 'processing', v_started_at, 0,
      '{"probe":true}'::jsonb
    );
    select pg_catalog.count(*) into v_event_count
    from public.stage1_award_publication_events
    where cohort_key = v_registry.cohort_key;
    v_result := public.finish_or_requeue_award_reconciliation_claim(
      v_queue_id, v_registry.canonical_shared_award_id, v_started_at, 0,
      v_status, 'rollback probe terminal ' || v_status
    );
    perform pg_temp.awardping_probe_assert(
      v_result.status = v_status
        and (select publication_state = 'revalidation_pending' and release_epoch is null
               from public.stage1_award_registry
              where cohort_key = v_registry.cohort_key)
        and (select release_state = 'revalidation_pending' and release_epoch is null
               from public.stage1_publication_release_state
              where release_key = 'stage1-national-25')
        and (select pg_catalog.count(*) = v_event_count + 1
               from public.stage1_award_publication_events
              where cohort_key = v_registry.cohort_key),
      'terminal ' || v_status || ' did not invalidate exactly once'
    );
    select pg_catalog.count(*) into v_event_count
    from public.stage1_award_publication_events
    where cohort_key = v_registry.cohort_key;
    v_result := public.finish_or_requeue_award_reconciliation_claim(
      v_queue_id, v_registry.canonical_shared_award_id, v_started_at, 0,
      v_status, 'rollback probe replay'
    );
    perform pg_temp.awardping_probe_assert(
      v_result.id is null
        and (select publication_state = 'revalidation_pending' and release_epoch is null
               from public.stage1_award_registry
              where cohort_key = v_registry.cohort_key)
        and (select release_state = 'revalidation_pending' and release_epoch is null
               from public.stage1_publication_release_state
              where release_key = 'stage1-national-25')
        and (select pg_catalog.count(*) = v_event_count
               from public.stage1_award_publication_events
              where cohort_key = v_registry.cohort_key),
      'terminal ' || v_status || ' replay was not idempotent'
    );
  end loop;
end;
$stage1_outcome_contract$;

-- Isolate the national decision from award evidence so this rollback-only
-- contract can prove the non-circular R2 behavior without pretending that an
-- incomplete pre-launch database already has 25 fully materialized ledgers.
-- The production award-reason function and signed-artifact selector are both
-- restored by the transaction rollback and compared with their exact baselines.
create or replace function public.stage1_effective_publication_reason(
  p_cohort_key text,
  p_evaluated_at timestamptz default now()
)
returns text
language sql
stable
security definer
set search_path = ''
as $probe_award_readiness$
  select 'verified'::text;
$probe_award_readiness$;
revoke all on function public.stage1_effective_publication_reason(text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function private.stage1_visual_r2_object_set_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $probe_r2_object_set$
  select pg_catalog.jsonb_build_object(
    'visual_object_count', 0,
    'published_event_object_count', 0,
    'manifest_source_object_count', 0,
    'visual_object_set_hash', coalesce(
      nullif(pg_catalog.current_setting(
        'awardping.stage1_probe_r2_object_set_hash', true
      ), ''),
      pg_catalog.repeat('a', 64)
    ),
    'unexpected_bucket_count', 0,
    'malformed_object_count', 0,
    'manifest_binding_error_count', 0,
    'objects', '[]'::jsonb
  );
$probe_r2_object_set$;
revoke all on function private.stage1_visual_r2_object_set_snapshot()
  from public, anon, authenticated, service_role;

create or replace function private.stage1_current_valid_release_artifact(
  p_artifact_kind text,
  p_evaluated_at timestamptz
)
returns setof public.stage1_release_acceptance_artifacts
language plpgsql
stable
security definer
set search_path = ''
as $probe_r2_dependency$
declare
  v_artifact public.stage1_release_acceptance_artifacts%rowtype;
begin
  if p_artifact_kind = 'r2_recovery_drill'
    and pg_catalog.current_setting(
      'awardping.stage1_probe_r2_current', true
    ) = 'on' then
    v_artifact.evidence := pg_catalog.jsonb_build_object(
      'visual_object_set_hash', pg_catalog.repeat('a', 64),
      'visual_objects_checked', 0,
      'published_event_objects_checked', 0,
      'manifest_source_objects_checked', 0
    );
    return next v_artifact;
  end if;
  return;
end;
$probe_r2_dependency$;
revoke all on function private.stage1_current_valid_release_artifact(
  text, timestamptz
) from public, anon, authenticated, service_role;

do $durable_epoch_release_contract$
declare
  v_epoch constant uuid := '00000000-0000-4000-8000-00000000b005'::uuid;
  v_ready_count integer;
  v_visible_count integer;
  v_reason_count integer;
  v_snapshot jsonb;
begin
  update public.stage1_award_registry
  set
    publication_state = 'verified_beta',
    state_reason = 'rollback probe durable verification epoch',
    release_epoch = v_epoch,
    evidence_checked_at = pg_catalog.statement_timestamp() - interval '30 days',
    last_verified_at = pg_catalog.statement_timestamp() - interval '30 days',
    updated_at = pg_catalog.statement_timestamp();
  alter table public.stage1_publication_release_state
    disable trigger supersede_stale_public_digest_reservations_on_release_trigger;
  update public.stage1_publication_release_state
  set
    release_state = 'verified_beta',
    release_epoch = v_epoch,
    activated_at = pg_catalog.statement_timestamp(),
    reason = 'rollback probe durable verification epoch',
    updated_at = pg_catalog.statement_timestamp()
  where release_key = 'stage1-national-25';
  alter table public.stage1_publication_release_state
    enable trigger supersede_stale_public_digest_reservations_on_release_trigger;

  perform pg_catalog.set_config(
    'awardping.stage1_probe_r2_current', 'on', true
  );
  perform pg_catalog.set_config(
    'awardping.stage1_probe_r2_object_set_hash',
    pg_catalog.repeat('a', 64),
    true
  );
  select
    pg_catalog.count(*) filter (where effective.cohort_ready),
    pg_catalog.count(*) filter (where effective.effectively_verified),
    pg_catalog.count(*) filter (where effective.effective_reason = 'verified')
  into v_ready_count, v_visible_count, v_reason_count
  from public.list_stage1_effective_publication() effective;
  v_snapshot := public.get_stage1_publication_snapshot();
  perform pg_temp.awardping_probe_assert(
    v_ready_count = 25
      and v_visible_count = 25
      and v_reason_count = 25
      and v_snapshot #>> '{release,effectively_released}' = 'true'
      and v_snapshot #>> '{release,ready_cohort_count}' = '25',
    'current R2 proof did not permit one exact effective public release'
  );

  perform pg_catalog.set_config(
    'awardping.stage1_probe_r2_object_set_hash',
    pg_catalog.repeat('b', 64),
    true
  );
  select
    pg_catalog.count(*) filter (where effective.cohort_ready),
    pg_catalog.count(*) filter (where effective.effectively_verified),
    pg_catalog.count(*) filter (
      where effective.effective_reason =
        'signed_r2_recovery_artifact_not_current'
    )
  into v_ready_count, v_visible_count, v_reason_count
  from public.list_stage1_effective_publication() effective;
  perform pg_temp.awardping_probe_assert(
    v_ready_count = 25
      and v_visible_count = 0
      and v_reason_count = 25,
    'changed R2 object set did not invalidate the still-age-valid signed proof'
  );

  perform pg_catalog.set_config(
    'awardping.stage1_probe_r2_object_set_hash',
    pg_catalog.repeat('a', 64),
    true
  );

  perform pg_catalog.set_config(
    'awardping.stage1_probe_r2_current', 'off', true
  );
  select
    pg_catalog.count(*) filter (where effective.cohort_ready),
    pg_catalog.count(*) filter (where effective.effectively_verified),
    pg_catalog.count(*) filter (
      where effective.effective_reason =
        'signed_r2_recovery_artifact_not_current'
    )
  into v_ready_count, v_visible_count, v_reason_count
  from public.list_stage1_effective_publication() effective;
  v_snapshot := public.get_stage1_publication_snapshot();
  perform pg_temp.awardping_probe_assert(
    v_ready_count = 25
      and v_visible_count = 0
      and v_reason_count = 25
      and v_snapshot #>> '{release,effectively_released}' = 'false'
      and v_snapshot #>> '{release,effective_reason}' =
        'signed_r2_recovery_artifact_not_current'
      and v_snapshot #>> '{release,ready_cohort_count}' = '25',
    'expired R2 proof did not close public release while retaining cohort readiness'
  );
end;
$durable_epoch_release_contract$;

rollback;
-- MIGRATION TRANSACTION END

-- POST-ROLLBACK VERIFICATION START
begin;
do $post_rollback$
declare
  v_baseline pg_temp.awardping_stage1_probe_baseline%rowtype;
  v_counts jsonb;
  v_sequence_state jsonb;
begin
  select * into v_baseline from pg_temp.awardping_stage1_probe_baseline;
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regclass('public.shared_award_regression_audit_state') is null
      and pg_catalog.to_regprocedure(
        'public.record_shared_award_regression_audit(uuid,jsonb,text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.invalidate_stage1_release_for_regression_audit(uuid,uuid,text,timestamp with time zone)'
      ) is null
      and pg_catalog.to_regclass(
        'public.shared_award_fact_candidate_terminal_archive'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.awardping_enforce_fact_candidate_status_lifecycle()'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.prevent_terminal_candidate_archive_mutation()'
      ) is null
      and not exists (
        select 1
        from pg_catalog.pg_trigger trigger
        where trigger.tgname in (
          'awardping_fact_candidate_status_lifecycle',
          'stage1_candidate_parent_award_delete_release_fence',
          'stage1_candidate_parent_source_delete_release_fence'
        )
      )
      and pg_catalog.to_regprocedure(
        'public.finish_or_requeue_award_reconciliation_claim(uuid,uuid,timestamp with time zone,bigint,text,text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.commit_award_reconciliation_blocked(uuid,uuid,timestamp with time zone,bigint,timestamp with time zone,jsonb,jsonb,jsonb,jsonb,text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.commit_award_reconciliation_publication_unfenced_20260716221500(uuid,uuid,timestamp with time zone,bigint,timestamp with time zone,jsonb,text,jsonb,double precision,jsonb,uuid[],uuid[],jsonb,jsonb,jsonb)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_vault_access_contract_safe()'
      ) is null
      and pg_catalog.to_regclass(
        'public.personal_data_legacy_ciphertext_archive'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.awardping_personal_data_sha256(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.awardping_preserve_legacy_personal_data_archive()'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.erase_personal_data_legacy_archive_for_privacy_request(uuid,uuid)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.apply_shared_award_source_cleanup_plan(jsonb,text,text)'
      ) is null
      and pg_catalog.to_regclass(
        'public.personal_data_legacy_contact_quarantine'
      ) is null
      and pg_catalog.to_regclass(
        'public.personal_data_erasure_tombstones'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.recover_legacy_contact_ciphertext(text,uuid,timestamp with time zone,text,text,text,text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.erase_personal_data_for_privacy_request(uuid,text,text,uuid)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_gate_without_contact_fence_20260717123000(timestamp with time zone)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.bump_manual_quarantine_backlog_for_changed_registry_rows()'
      ) is null
      and pg_catalog.to_regclass(
        'private.stage1_canonical_identity_evidence'
      ) is null
      and pg_catalog.to_regclass(
        'private.stage1_delegated_source_authority_evidence'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.prevent_stage1_canonical_identity_evidence_mutation()'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_manifest_source_authority_valid(text,text,text,text,text,jsonb)'
      ) is null
      and exists (
        select 1
        from pg_catalog.pg_trigger trigger
        where trigger.tgrelid = 'public.manual_quarantine_registry'::pg_catalog.regclass
          and trigger.tgname = 'bump_manual_quarantine_backlog_after_registry_mutation'
          and not trigger.tgisinternal
      )
      and not exists (
        select 1
        from pg_catalog.pg_trigger trigger
        where trigger.tgrelid = 'public.manual_quarantine_registry'::pg_catalog.regclass
          and trigger.tgname in (
            'bump_manual_quarantine_backlog_after_registry_insert',
            'bump_manual_quarantine_backlog_after_registry_update',
            'bump_manual_quarantine_backlog_after_registry_delete'
          )
          and not trigger.tgisinternal
      )
      and pg_catalog.to_regprocedure(
        'private.retire_shared_award_source_unfenced_20260715143000(uuid,text,text)'
      ) is null
      and not exists (
        select 1
        from pg_catalog.pg_attribute attribute
        where attribute.attrelid = 'public.profiles'::pg_catalog.regclass
          and attribute.attname in (
            'personal_data_reentry_required',
            'personal_data_reentry_reason',
            'personal_data_reentry_marked_at',
            'personal_data_reentered_at'
          )
          and not attribute.attisdropped
      )
      and not exists (
        select 1
        from pg_catalog.pg_constraint constraint_row
        where constraint_row.conrelid = 'public.profiles'::pg_catalog.regclass
          and constraint_row.conname = 'profiles_personal_data_reentry_state_check'
      ),
    'pending schema objects survived rollback'
  );
  perform pg_temp.awardping_probe_assert(
    not exists (
      select 1
      from public.stage1_award_source_identity_rules identity_rule
      where (identity_rule.cohort_key, identity_rule.rule_key) in (
        ('rhodes_us', 'exclude_rhodes_non_us_constituencies'),
        ('gilman', 'exclude_gilman_mccain')
      )
    ),
    'Stage 1 source-identity fence rows survived rollback'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure('public.sync_manual_quarantine_registry()')
    ) = v_baseline.sync_definition
      and (
        select procedure.proconfig is not distinct from v_baseline.sync_proconfig
          and procedure.proacl::text is not distinct from v_baseline.sync_acl
        from pg_catalog.pg_proc procedure
        where procedure.oid = pg_catalog.to_regprocedure(
          'public.sync_manual_quarantine_registry()'
        )
      ),
    'manual quarantine function did not return to its exact pre-probe state'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(
        'public.commit_award_reconciliation_publication(uuid,uuid,timestamp with time zone,bigint,timestamp with time zone,jsonb,text,jsonb,double precision,jsonb,uuid[],uuid[],jsonb,jsonb,jsonb)'
      )
    ) = v_baseline.success_definition
      and (
        select procedure.proconfig is not distinct from v_baseline.success_proconfig
          and procedure.proacl::text is not distinct from v_baseline.success_acl
        from pg_catalog.pg_proc procedure
        where procedure.oid = pg_catalog.to_regprocedure(
          'public.commit_award_reconciliation_publication(uuid,uuid,timestamp with time zone,bigint,timestamp with time zone,jsonb,text,jsonb,double precision,jsonb,uuid[],uuid[],jsonb,jsonb,jsonb)'
        )
      ),
    'atomic publication function did not return to its exact pre-probe state'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(
        'private.stage1_release_gate_snapshot(timestamp with time zone)'
      )
    ) = v_baseline.gate_definition
      and (
        select procedure.proconfig is not distinct from v_baseline.gate_proconfig
          and procedure.proacl::text is not distinct from v_baseline.gate_acl
          and procedure.oid = v_baseline.gate_oid
          and procedure.proowner = v_baseline.gate_owner
          and procedure.prosecdef = v_baseline.gate_security_definer
          and procedure.provolatile = v_baseline.gate_volatility
        from pg_catalog.pg_proc procedure
        where procedure.oid = pg_catalog.to_regprocedure(
          'private.stage1_release_gate_snapshot(timestamp with time zone)'
        )
      ),
    'Stage 1 release gate did not return to its exact pre-probe state'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(
        'public.stage1_effective_publication_reason(text,timestamp with time zone)'
      )
    ) = v_baseline.effective_definition
      and (
        select procedure.proconfig is not distinct from v_baseline.effective_proconfig
          and procedure.proacl::text is not distinct from v_baseline.effective_acl
          and procedure.oid = v_baseline.effective_oid
          and procedure.proowner = v_baseline.effective_owner
          and procedure.prosecdef = v_baseline.effective_security_definer
          and procedure.provolatile = v_baseline.effective_volatility
        from pg_catalog.pg_proc procedure
        where procedure.oid = pg_catalog.to_regprocedure(
          'public.stage1_effective_publication_reason(text,timestamp with time zone)'
        )
      ),
    'immutable Stage 1 verification function did not return to its exact pre-probe state'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(
        'public.list_stage1_effective_publication()'
      )
    ) = v_baseline.listing_definition
      and (
        select procedure.proconfig is not distinct from v_baseline.listing_proconfig
          and procedure.proacl::text is not distinct from v_baseline.listing_acl
          and procedure.oid = v_baseline.listing_oid
          and procedure.proowner = v_baseline.listing_owner
          and procedure.prosecdef = v_baseline.listing_security_definer
          and procedure.provolatile = v_baseline.listing_volatility
        from pg_catalog.pg_proc procedure
        where procedure.oid = pg_catalog.to_regprocedure(
          'public.list_stage1_effective_publication()'
        )
      ),
    'national effective publication function did not return to its exact pre-probe state'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(
        'private.stage1_current_valid_release_artifact(text,timestamp with time zone)'
      )
    ) = v_baseline.artifact_selector_definition
      and (
        select procedure.proconfig is not distinct from
            v_baseline.artifact_selector_proconfig
          and procedure.proacl::text is not distinct from
            v_baseline.artifact_selector_acl
          and procedure.oid = v_baseline.artifact_selector_oid
          and procedure.proowner = v_baseline.artifact_selector_owner
          and procedure.prosecdef =
            v_baseline.artifact_selector_security_definer
          and procedure.provolatile = v_baseline.artifact_selector_volatility
        from pg_catalog.pg_proc procedure
        where procedure.oid = pg_catalog.to_regprocedure(
          'private.stage1_current_valid_release_artifact(text,timestamp with time zone)'
        )
      ),
    'signed release-artifact selector did not return to its exact pre-probe state'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(
        'private.stage1_visual_r2_object_set_snapshot()'
      )
    ) = v_baseline.visual_object_set_definition
      and (
        select procedure.proconfig is not distinct from
            v_baseline.visual_object_set_proconfig
          and procedure.proacl::text is not distinct from
            v_baseline.visual_object_set_acl
          and procedure.oid = v_baseline.visual_object_set_oid
          and procedure.proowner = v_baseline.visual_object_set_owner
          and procedure.prosecdef =
            v_baseline.visual_object_set_security_definer
          and procedure.provolatile = v_baseline.visual_object_set_volatility
        from pg_catalog.pg_proc procedure
        where procedure.oid = pg_catalog.to_regprocedure(
          'private.stage1_visual_r2_object_set_snapshot()'
        )
      ),
    'visual R2 object-set function did not return to its exact pre-probe state'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(
        'public.get_stage1_release_r2_verification_manifest()'
      )
    ) = v_baseline.r2_manifest_definition
      and (
        select procedure.proconfig is not distinct from
            v_baseline.r2_manifest_proconfig
          and procedure.proacl::text is not distinct from
            v_baseline.r2_manifest_acl
          and procedure.oid = v_baseline.r2_manifest_oid
          and procedure.proowner = v_baseline.r2_manifest_owner
          and procedure.prosecdef = v_baseline.r2_manifest_security_definer
          and procedure.provolatile = v_baseline.r2_manifest_volatility
        from pg_catalog.pg_proc procedure
        where procedure.oid = pg_catalog.to_regprocedure(
          'public.get_stage1_release_r2_verification_manifest()'
        )
      ),
    'public R2 verification-manifest function did not return to its exact pre-probe state'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regprocedure(
      'private.stage1_durable_verification_timestamp_valid(timestamp with time zone,timestamp with time zone)'
    ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_live_source_check_current(timestamp with time zone,timestamp with time zone)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_manifest_source_capture_binding_valid(uuid,text,jsonb,jsonb,jsonb)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_safe_timestamptz(text)'
      ) is null,
    'durable Stage 1 verification helper functions survived rollback'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.to_regprocedure(
      'public.commit_reviewed_stage1_reconciliation_publication(uuid,uuid,timestamp with time zone,bigint,timestamp with time zone,jsonb,text,jsonb,double precision,jsonb,uuid[],uuid[],jsonb,jsonb,jsonb,jsonb)'
    ) is null
      and pg_catalog.to_regprocedure(
        'public.import_reviewed_stage1_fact_candidates(jsonb,text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.get_stage1_human_review_root(text)'
      ) is null
      and pg_catalog.to_regclass(
        'private.stage1_reviewed_candidate_import_bundles'
      ) is null
      and pg_catalog.to_regclass(
        'private.stage1_reviewed_candidate_import_items'
      ) is null
      and pg_catalog.to_regclass(
        'private.stage1_human_review_roots'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_safe_uuid(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_canonical_json_text(jsonb)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_canonical_json_sha256(jsonb)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_text_sha256(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_jsonb_has_exact_keys(jsonb,text[])'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_https_host(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_evidence_location_is_valid(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.stage1_candidate_uuid_from_sha256(text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.prevent_stage1_reviewed_candidate_import_mutation()'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.prevent_stage1_human_review_root_mutation()'
      ) is null
      and pg_catalog.to_regprocedure(
        'private.enforce_stage1_reviewed_reconciliation_success()'
      ) is null
      and not exists (
        select 1
        from pg_catalog.pg_trigger trigger
        where trigger.tgname in (
          'enforce_stage1_reviewed_reconciliation_success',
          'prevent_stage1_human_review_root_mutation',
          'prevent_stage1_reviewed_candidate_import_bundle_mutation',
          'prevent_stage1_reviewed_candidate_import_item_mutation'
        )
          and not trigger.tgisinternal
      ),
    'reviewed Stage 1 import/reconciliation function, registry, ledger, or trigger survived rollback'
  );
  perform pg_temp.awardping_probe_assert(
    pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(
        'public.retire_shared_award_source_preserving_visual_history(uuid,text,text)'
      )
    ) = v_baseline.retirement_definition
      and (
        select procedure.proconfig is not distinct from v_baseline.retirement_proconfig
          and procedure.proacl::text is not distinct from v_baseline.retirement_acl
          and procedure.oid = v_baseline.retirement_oid
          and procedure.proowner = v_baseline.retirement_owner
          and procedure.prosecdef = v_baseline.retirement_security_definer
          and procedure.provolatile = v_baseline.retirement_volatility
        from pg_catalog.pg_proc procedure
        where procedure.oid = pg_catalog.to_regprocedure(
          'public.retire_shared_award_source_preserving_visual_history(uuid,text,text)'
        )
      ),
    'manual source-retirement function did not return to its exact pre-probe state'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select procedure.proacl::text is not distinct from
        v_baseline.legacy_erasure_acl
      from pg_catalog.pg_proc procedure
      where procedure.oid = pg_catalog.to_regprocedure(
        'public.erase_public_update_subscriber(text,text)'
      )
    ),
    'legacy subscriber erasure ACL did not return to its exact pre-probe state'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select pg_catalog.jsonb_object_agg(
        class.oid::text,
        class.relacl::text
        order by class.oid
      ) = v_baseline.candidate_lifecycle_table_acls
      from pg_catalog.pg_class class
      where class.oid in (
        'public.shared_awards'::pg_catalog.regclass,
        'public.shared_award_sources'::pg_catalog.regclass,
        'public.shared_award_fact_candidates'::pg_catalog.regclass
      )
    ),
    'candidate lifecycle table ACLs did not return to their exact pre-probe state'
  );
  perform pg_temp.awardping_probe_assert(
    (
      select namespace.nspacl::text is not distinct from v_baseline.vault_schema_acl
      from pg_catalog.pg_namespace namespace
      where namespace.oid = pg_catalog.to_regnamespace('vault')
    )
      and (
        select coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'oid', class.oid,
              'acl', class.relacl::text
            ) order by class.oid
          ),
          '[]'::jsonb
        ) = v_baseline.vault_relation_acls
        from pg_catalog.pg_class class
        where class.relnamespace = pg_catalog.to_regnamespace('vault')
          and class.relkind in ('r', 'p', 'v', 'm', 'f')
      )
      and (
        select coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'oid', procedure.oid,
              'acl', procedure.proacl::text
            ) order by procedure.oid
          ),
          '[]'::jsonb
        ) = v_baseline.vault_function_acls
        from pg_catalog.pg_proc procedure
        where procedure.pronamespace = pg_catalog.to_regnamespace('vault')
          and procedure.prokind <> 'p'
      ),
    'Vault schema, relation, or function ACLs did not return to their exact pre-probe state'
  );

  v_counts := pg_catalog.jsonb_build_object(
    'awards', (select pg_catalog.count(*) from public.shared_awards),
    'sources', (select pg_catalog.count(*) from public.shared_award_sources),
    'candidates', (select pg_catalog.count(*) from public.shared_award_fact_candidates),
    'queue', (select pg_catalog.count(*) from public.shared_award_reconciliation_queue),
    'audits', (select pg_catalog.count(*) from public.shared_award_page_audits),
    'acceptances', (select pg_catalog.count(*) from public.stage1_release_acceptance_records),
    'award_events', (select pg_catalog.count(*) from public.stage1_award_publication_events),
    'release_events', (select pg_catalog.count(*) from public.stage1_publication_release_events),
    'quarantine', (select pg_catalog.count(*) from public.manual_quarantine_registry),
    'quarantine_events', (
      select pg_catalog.count(*) from public.manual_quarantine_registry_events
    )
  );
  perform pg_temp.awardping_probe_assert(
    v_counts = v_baseline.table_counts
      and not exists (
        select 1 from public.shared_awards
        where id = '00000000-0000-4000-8000-00000000a001'::uuid
      )
      and not exists (
        select 1 from public.shared_awards award
        where award.id in (
          '00000000-0000-4000-8000-00000000d001'::uuid,
          '00000000-0000-4000-8000-00000000d004'::uuid
        )
      )
      and (
        select pg_catalog.to_jsonb(registry) = v_baseline.registry_row
        from public.stage1_award_registry registry
        order by registry.launch_rank
        limit 1
      )
      and (
        select pg_catalog.to_jsonb(release_state) = v_baseline.release_row
        from public.stage1_publication_release_state release_state
        where release_state.release_key = 'stage1-national-25'
      )
      and pg_catalog.jsonb_build_object(
        'registry', (
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(registry)
            order by registry.cohort_key
          )
          from public.stage1_award_registry registry
          where registry.cohort_key in ('hertz', 'ndseg')
        ),
        'awards', (
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(award)
            order by award.id
          )
          from public.shared_awards award
          where award.id in (
            '4d2f6a7f-024e-4194-be31-1b9f63e497bc'::uuid,
            'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid
          )
        )
      ) = v_baseline.canonical_identity_rows,
    'fixture rows or Stage 1 state survived rollback'
  );

  execute pg_catalog.format(
    'select pg_catalog.jsonb_build_object(''last_value'', last_value, ''is_called'', is_called) from %s',
    v_baseline.award_event_sequence_name::pg_catalog.regclass
  ) into v_sequence_state;
  perform pg_temp.awardping_probe_assert(
    v_sequence_state = v_baseline.award_event_sequence_state,
    'award publication event sequence changed despite rollback'
  );
  execute pg_catalog.format(
    'select pg_catalog.jsonb_build_object(''last_value'', last_value, ''is_called'', is_called) from %s',
    v_baseline.release_event_sequence_name::pg_catalog.regclass
  ) into v_sequence_state;
  perform pg_temp.awardping_probe_assert(
    v_sequence_state = v_baseline.release_event_sequence_state,
    'release event sequence changed despite rollback'
  );
  execute pg_catalog.format(
    'select pg_catalog.jsonb_build_object(''last_value'', last_value, ''is_called'', is_called) from %s',
    v_baseline.quarantine_event_sequence_name::pg_catalog.regclass
  ) into v_sequence_state;
  perform pg_temp.awardping_probe_assert(
    v_sequence_state = v_baseline.quarantine_event_sequence_state,
    'manual-quarantine audit event sequence changed despite rollback'
  );
end;
$post_rollback$;

select
  true as awardping_stage1_pending_migration_rollback_probe_passed,
  14 as exact_migration_count,
  'all migration/schema/fixture changes rolled back'::text as persistence_result;

drop table pg_temp.awardping_stage1_probe_baseline;
commit;
-- POST-ROLLBACK VERIFICATION END
