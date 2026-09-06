-- TEST-ONLY prerequisite fixture: canonical identity v3 homepages for a fresh,
-- disposable replay of the frozen migration chain. NOT a migration.
--
-- Why this exists. The frozen migration
-- 20260831210000_canonical_identity_v3_truman_apply.sql begins by requiring
-- the registry to already carry the v3 identity (hash 71aabb42...). Production
-- received the three v3 homepage values through the explicit-human-review
-- re-publication, never through a migration, so a fresh chain still carries
-- the v2 identity (hash 6e7dd7ee...) at that point and the guard fails closed
-- by design. This file lets a LOCAL, DISPOSABLE replay cross that one gap
-- honestly: the runner applies the frozen prefix through 20260830223000, runs
-- this file with psql, then applies the frozen suffix from 20260831210000.
--
-- It records nothing in migration history, fabricates no review or release
-- evidence, deletes or rewrites no seeded evidence, disables no trigger,
-- changes no function, and does not repair a bare `supabase db reset` from a
-- normal checkout.
--
-- Stability. Everything runs in one transaction that first takes the
-- release-wide advisory lock every Stage 1 mutation path takes, then locks
-- every inspected table in SHARE ROW EXCLUSIVE mode. Concurrent writers block
-- until commit, so no reviewed state can slip in between the guards and the
-- swap; normal triggers stay enabled throughout.
--
-- What the frozen prefix already contains, and what this file proves and
-- preserves untouched (count/key/value guards plus byte-for-byte before/after
-- snapshots). Exact original payload provenance comes from the runner's
-- byte-verified frozen prefix and its full-payload migration postconditions;
-- this fixture is not a standalone validator for an arbitrary database:
--   * identity seeds from 20260716204011: 25 registry rows, 25 canonical and
--     25 alias members, source identity rules, 200 manifest slots with no
--     bound source, and the release row; 20260717153000 moves the release row
--     to pending v2;
--   * three reviewed records that 20260717153000 seeds unconditionally and
--     its own postcondition requires: the Hertz canonical identity evidence
--     row, the NDSEG delegated source authority evidence row, and the NDSEG
--     official-deadline-conflict quarantine row with its single "opened"
--     audit event.
-- Everything else that could hold reviewed, verified, or captured evidence at
-- the prefix must be empty: publication and release events, reconciled fact
-- evidence, the fact publication ledger, release acceptance artifacts and
-- records, human review roots, reviewed reconciliations, candidate import
-- bundles, source dispositions, activation receipts, reconciliations, page
-- audits, fact candidates, sources, source captures, visual captures, and
-- change event visual evidence.
--
-- Connection handshake: database postgres, user postgres, application_name
-- awardping-fixture-replay-<32 lowercase hex>. That marker is a handshake
-- with the runner, not authorization. The runner's local-only target isolation
-- is what keeps this off any real project; the server cannot verify loopback
-- from inside Docker, so it does not try. This file checks that the prefix is
-- the latest recorded migration; the runner separately checks the COMPLETE
-- exact ordered prefix ledger before invoking it.
--
-- Then it applies exactly six compare-and-swap homepage changes, three
-- registry rows and their three matching canonical shared award rows, and
-- proves the result: the exact v3 hash, every other column of both tables
-- byte-for-byte unchanged (updated_at included), every preserved table
-- byte-for-byte unchanged, the release row untouched, the empty tables still
-- empty. Known, intended side effect: the shared_awards statement trigger
-- bump_manual_quarantine_backlog_revision() raises the operator backlog
-- revision by exactly one; that is an operator cache key, not evidence, and
-- the exact increment is asserted.
--
-- Runner handshake: on success the transaction commits, a NOTICE is raised,
-- and one row is returned after the commit with fixture_status
-- 'stage1_identity_v3_prerequisite_ok' and the recomputed registry hash. Any
-- refusal raises inside the transaction, so with ON_ERROR_STOP nothing is kept.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $stage1_identity_v3_prerequisite$
declare
  v_marker_pattern constant text := '^awardping-fixture-replay-[0-9a-f]{32}$';
  v_prefix_version constant text := '20260830223000';
  v_guarded_version constant text := '20260831210000';
  v_v2_hash constant text :=
    '6e7dd7ee1372671cbfb22b17b862d867145a93c7dc0b73d49afc11f504ee6c8f';
  v_v3_hash constant text :=
    '71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9';
  v_ndseg_award_id constant uuid := 'e776ca2f-4b2c-431e-a3f9-248ad78c30e8';
  v_hertz_award_id constant uuid := '4d2f6a7f-024e-4194-be31-1b9f63e497bc';
  v_seed_reviewed_at constant timestamptz := '2026-07-17T14:41:57.337Z';
  v_quarantine_key constant text := 'stage1:ndseg:official-deadline-conflict:2026-07-17';
  -- Every table below exists at the prefix and is empty on a fresh chain.
  v_empty_tables constant text[] := array[
    'public.stage1_award_publication_events',
    'public.stage1_publication_release_events',
    'public.stage1_award_reconciled_fact_evidence',
    'public.stage1_award_fact_publication_ledger',
    'public.stage1_release_acceptance_artifacts',
    'public.stage1_release_acceptance_records',
    'private.stage1_human_review_roots',
    'private.stage1_reviewed_reconciliation_authorizations',
    'private.stage1_reviewed_candidate_import_bundles',
    'private.stage1_source_disposition_bundles',
    'private.stage1_source_baseline_activation_receipts',
    'public.shared_award_reconciliation_queue',
    'public.shared_award_page_audits',
    'public.shared_award_fact_candidates',
    'public.shared_award_sources',
    'public.shared_award_source_snapshots',
    'public.shared_award_source_visual_snapshots',
    'public.shared_award_change_event_visual_evidence'
  ];
  -- Seeded at the prefix and preserved byte-for-byte by this fixture.
  v_preserved_tables constant text[] := array[
    'public.stage1_award_members',
    'public.stage1_award_source_identity_rules',
    'public.stage1_award_source_manifest',
    'public.manual_quarantine_registry',
    'public.manual_quarantine_registry_events',
    'public.manual_quarantine_registry_state',
    'private.stage1_canonical_identity_evidence',
    'private.stage1_delegated_source_authority_evidence'
  ];
  v_application_name text := pg_catalog.current_setting('application_name', true);
  v_count bigint;
  v_hash text;
  v_table text;
  v_index integer;
  v_snapshot text;
  v_preserved_before text[] := '{}'::text[];
  v_registry_before text;
  v_registry_after text;
  v_awards_before text;
  v_awards_after text;
  v_release_before text;
  v_release_after text;
  v_backlog_before bigint;
  v_backlog_after bigint;
begin
  -- 0. Stability: the release-wide advisory lock, then every inspected table.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'Fixture refused: no migration ledger; this is not a Supabase CLI replay database.';
  end if;
  lock table
    supabase_migrations.schema_migrations,
    public.stage1_award_registry,
    public.shared_awards,
    public.stage1_publication_release_state,
    public.manual_quarantine_backlog_state
    in share row exclusive mode;
  foreach v_table in array v_preserved_tables || v_empty_tables loop
    execute pg_catalog.format('lock table %s in share row exclusive mode', v_table::regclass);
  end loop;

  -- 1. Connection handshake (a marker, not authorization).
  if pg_catalog.current_database() <> 'postgres' or current_user <> 'postgres' then
    raise exception 'Fixture refused: expected database postgres as user postgres, got % as %.',
      pg_catalog.current_database(), current_user;
  end if;
  if v_application_name is null or v_application_name !~ v_marker_pattern then
    raise exception 'Fixture refused: application_name % is not the replay handshake marker.',
      coalesce(v_application_name, '<unset>');
  end if;

  -- 2. Ledger position: prefix present, nothing after it. The runner checks
  --    the complete exact prefix version list immediately before this file.
  select pg_catalog.count(*) into v_count
  from supabase_migrations.schema_migrations ledger
  where ledger.version = v_prefix_version;
  if v_count <> 1 then
    raise exception 'Fixture refused: prefix migration % is not recorded as applied.', v_prefix_version;
  end if;
  select pg_catalog.count(*) into v_count
  from supabase_migrations.schema_migrations ledger
  where ledger.version > v_prefix_version;
  if v_count <> 0 then
    raise exception 'Fixture refused: % migration(s) after % are already applied; the guard at % must not have run yet.',
      v_count, v_prefix_version, v_guarded_version;
  end if;

  -- 3. Registry: exactly the 25 v2 identity rows, all pending and evidence-free.
  select pg_catalog.count(*) into v_count from public.stage1_award_registry;
  if v_count <> 25 then
    raise exception 'Fixture refused: expected 25 registry rows, found %.', v_count;
  end if;
  v_hash := public.stage1_publication_evidence_hash(pg_catalog.to_jsonb((
    select pg_catalog.string_agg(
      pg_catalog.concat_ws(
        '|',
        registry.launch_rank::text,
        registry.cohort_key,
        registry.canonical_name,
        registry.canonical_shared_award_id::text,
        registry.canonical_slug,
        registry.official_homepage
      ),
      E'\n'
      order by registry.launch_rank
    )
    from public.stage1_award_registry registry
  )));
  if v_hash is distinct from v_v2_hash then
    raise exception 'Fixture refused: registry identity hash % is not the exact v2 hash %.', v_hash, v_v2_hash;
  end if;
  select pg_catalog.count(*) into v_count
  from public.stage1_award_registry registry
  where registry.publication_state <> 'pending'
    or registry.policy_version <> 'stage1-publication-v1'
    or registry.fact_ledger_batch_id is not null
    or registry.release_epoch is not null
    or registry.evidence_checked_at is not null
    or registry.last_verified_at is not null;
  if v_count <> 0 then
    raise exception 'Fixture refused: % registry row(s) carry reviewed, verified, or evidence-bearing state.', v_count;
  end if;

  -- 4. Release row: exactly one, pending v2, no epoch, no activation.
  select pg_catalog.count(*) into v_count from public.stage1_publication_release_state;
  if v_count <> 1 then
    raise exception 'Fixture refused: expected exactly one release row, found %.', v_count;
  end if;
  select pg_catalog.count(*) into v_count
  from public.stage1_publication_release_state release_state
  where release_state.release_key = 'stage1-national-25'
    and release_state.release_state = 'pending'
    and release_state.release_epoch is null
    and release_state.activated_at is null
    and release_state.cohort_identity_version = 'stage1-national-25-v2'
    and release_state.cohort_identity_hash = v_v2_hash;
  if v_count <> 1 then
    raise exception 'Fixture refused: the release row is not the pending v2 state with no epoch or activation.';
  end if;

  -- 5. Identity integrity across members and canonical shared award rows.
  select pg_catalog.count(*) into v_count
  from public.stage1_award_members member
  join public.stage1_award_registry registry
    on registry.cohort_key = member.cohort_key
    and registry.canonical_shared_award_id = member.shared_award_id
  where member.member_kind = 'canonical';
  if v_count <> 25 then
    raise exception 'Fixture refused: expected 25 canonical members matching the registry, found %.', v_count;
  end if;
  select pg_catalog.count(*) into v_count
  from public.stage1_award_members member
  where member.member_kind = 'alias';
  if v_count <> 25 then
    raise exception 'Fixture refused: expected 25 alias members, found %.', v_count;
  end if;
  select pg_catalog.count(*) into v_count
  from public.stage1_award_registry registry
  join public.shared_awards award
    on award.id = registry.canonical_shared_award_id
    and award.name = registry.canonical_name
    and award.slug = registry.canonical_slug
    and award.official_homepage = registry.official_homepage;
  if v_count <> 25 then
    raise exception 'Fixture refused: only % of 25 canonical shared award rows match their registry rows.', v_count;
  end if;

  -- 6. The manifest has slots but no bound source anywhere.
  select pg_catalog.count(*) into v_count
  from public.stage1_award_source_manifest manifest
  where manifest.manifest_status <> 'missing'
    or pg_catalog.cardinality(manifest.source_ids) <> 0
    or manifest.checked_at is not null;
  if v_count <> 0 then
    raise exception 'Fixture refused: % manifest slot(s) already bind reviewed sources.', v_count;
  end if;

  -- 7. Exactly the reviewed records the frozen 20260717153000 migration seeds.
  --    Hertz canonical identity evidence: one row, the seeded one.
  select pg_catalog.count(*) into v_count from private.stage1_canonical_identity_evidence;
  if v_count <> 1 then
    raise exception 'Fixture refused: expected exactly the one seeded canonical identity evidence row, found %.', v_count;
  end if;
  select pg_catalog.count(*) into v_count
  from private.stage1_canonical_identity_evidence evidence
  where evidence.identity_key = 'hertz-current-fellowship-root-2026-07-17'
    and evidence.cohort_key = 'hertz'
    and evidence.canonical_shared_award_id = v_hertz_award_id
    and evidence.previous_homepage = 'https://www.hertzfoundation.org/the-fellowship/'
    and evidence.current_homepage = 'https://www.hertzfoundation.org/hertz-fellowship/'
    and evidence.authority_evidence_url = 'https://www.hertzfoundation.org/hertz-fellowship/application-help/faq/'
    and evidence.reviewed_at = v_seed_reviewed_at
    and evidence.policy_version = 'stage1-publication-v1'
    and evidence.evidence ->> 'review_method' = 'explicit_human_official_source_review'
    and evidence.evidence_hash = public.stage1_publication_evidence_hash(evidence.evidence);
  if v_count <> 1 then
    raise exception 'Fixture refused: the canonical identity evidence row is not the seeded Hertz record.';
  end if;
  --    NDSEG delegated source authority evidence: one row, the seeded one.
  select pg_catalog.count(*) into v_count from private.stage1_delegated_source_authority_evidence;
  if v_count <> 1 then
    raise exception 'Fixture refused: expected exactly the one seeded delegated authority evidence row, found %.', v_count;
  end if;
  select pg_catalog.count(*) into v_count
  from private.stage1_delegated_source_authority_evidence authority
  where authority.authority_key = 'ndseg-sysplus-current-contractor-2026-07-17'
    and authority.cohort_key = 'ndseg'
    and authority.canonical_shared_award_id = v_ndseg_award_id
    and authority.canonical_homepage = 'https://ndseg.org/'
    and authority.delegated_host = 'ndseg.sysplus.com'
    and authority.classification = 'official_contractor_host'
    and authority.authority_status = 'active'
    and authority.authority_evidence_url = 'https://ndseg.org/apply-link'
    and authority.reviewed_at = v_seed_reviewed_at
    and authority.policy_version = 'stage1-publication-v1'
    and authority.evidence_hash = public.stage1_publication_evidence_hash(authority.evidence);
  if v_count <> 1 then
    raise exception 'Fixture refused: the delegated authority evidence row is not the seeded NDSEG record.';
  end if;
  --    NDSEG official-deadline-conflict quarantine: the one row the frozen
  --    migration's own postcondition requires, still exactly as seeded.
  select pg_catalog.count(*) into v_count from public.manual_quarantine_registry;
  if v_count <> 1 then
    raise exception 'Fixture refused: expected exactly the one seeded quarantine row, found %.', v_count;
  end if;
  select pg_catalog.count(*) into v_count
  from public.manual_quarantine_registry quarantine
  where quarantine.quarantine_key = v_quarantine_key
    and quarantine.case_key = 'stage1:ndseg:official-deadline-conflict'
    and quarantine.classification = 'actionable_quarantine'
    and quarantine.category = 'public_page'
    and quarantine.status = 'quarantined'
    and quarantine.requires_action
    and not quarantine.terminal
    and quarantine.terminal_failure_count = 0
    and quarantine.severity = 'high'
    and quarantine.public_impact = 'blocked'
    and quarantine.owner = 'stage1-source-owner'
    and quarantine.retry_charge = 'none'
    and quarantine.title = 'NDSEG official application-cycle date conflict'
    and quarantine.reason_code = 'official_source_fact_conflict'
    and quarantine.shared_award_id = v_ndseg_award_id
    and quarantine.shared_award_source_id is null
    and quarantine.visual_review_candidate_id is null
    and quarantine.primary_source_table = 'stage1_award_registry'
    and quarantine.primary_source_record_id = v_ndseg_award_id
    and quarantine.evidence_record_count = 2
    and quarantine.evidence ->> 'publication_decision' = 'not_published'
    and quarantine.evidence_hash = public.manual_quarantine_evidence_hash(quarantine.evidence)
    and quarantine.policy_id = 'awardping-stage1-official-source-conflict'
    and quarantine.policy_version = '1'
    and quarantine.policy_hash = '4a12c7a0c4e088bca3b5c4b9ef28c6ddb8b108ac8b324c23dbde4aa5e0646ae4'
    and quarantine.first_observed_at = v_seed_reviewed_at
    and quarantine.last_observed_at = v_seed_reviewed_at
    and quarantine.resolved_at is null;
  if v_count <> 1 then
    raise exception 'Fixture refused: the quarantine row is not the seeded NDSEG official-deadline-conflict record.';
  end if;
  --    Its audit trail is the single "opened" event the insert trigger wrote.
  select pg_catalog.count(*) into v_count from public.manual_quarantine_registry_events;
  if v_count <> 1 then
    raise exception 'Fixture refused: expected exactly one quarantine audit event, found %.', v_count;
  end if;
  select pg_catalog.count(*) into v_count
  from public.manual_quarantine_registry_events event
  join public.manual_quarantine_registry quarantine on quarantine.id = event.quarantine_id
  where quarantine.quarantine_key = v_quarantine_key
    and event.event_type = 'opened'
    and event.previous_status is null
    and event.next_status = 'quarantined'
    and event.evidence_hash = quarantine.evidence_hash;
  if v_count <> 1 then
    raise exception 'Fixture refused: the quarantine audit event is not the seeded "opened" event.';
  end if;

  -- 8. Nothing else that could hold reviewed, verified, or captured evidence.
  foreach v_table in array v_empty_tables loop
    execute pg_catalog.format('select pg_catalog.count(*) from %s', v_table::regclass) into v_count;
    if v_count <> 0 then
      raise exception 'Fixture refused: % holds % row(s); a fresh replay has none.', v_table, v_count;
    end if;
  end loop;

  -- Snapshots of everything the six changes must leave untouched.
  select pg_catalog.string_agg(
    (pg_catalog.to_jsonb(registry) - 'official_homepage')::text,
    E'\n' order by registry.launch_rank
  ) into v_registry_before
  from public.stage1_award_registry registry;
  select pg_catalog.string_agg(
    (pg_catalog.to_jsonb(award) - 'official_homepage')::text,
    E'\n' order by award.id
  ) into v_awards_before
  from public.shared_awards award;
  select pg_catalog.to_jsonb(release_state)::text into v_release_before
  from public.stage1_publication_release_state release_state;
  foreach v_table in array v_preserved_tables loop
    execute pg_catalog.format(
      'select coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(preserved)::text, pg_catalog.chr(10) order by pg_catalog.to_jsonb(preserved)::text), '''') from %s preserved',
      v_table::regclass
    ) into v_snapshot;
    v_preserved_before := pg_catalog.array_append(v_preserved_before, v_snapshot);
  end loop;
  select state.revision into v_backlog_before
  from public.manual_quarantine_backlog_state state
  where state.state_key = 'operator_backlog';
  if v_backlog_before is null then
    raise exception 'Fixture refused: the seeded operator backlog revision row is missing.';
  end if;

  -- 9. Exactly three registry rows, each swapped only from its exact v2 homepage.
  with expected (cohort_key, award_id, previous_homepage, next_homepage) as (
    values
      ('truman', 'bf04d4c1-4db3-4f4e-bf1b-e4dbca7bb7d3'::uuid,
        'https://www.truman.gov/', 'https://www.truman.gov/apply'),
      ('hertz', '4d2f6a7f-024e-4194-be31-1b9f63e497bc'::uuid,
        'https://www.hertzfoundation.org/hertz-fellowship/', 'https://www.hertzfoundation.org/hertz-fellowship'),
      ('soros', '3cf7c610-0246-4dfb-b26c-289254e40ce6'::uuid,
        'https://www.pdsoros.org/', 'https://pdsoros.org/')
  )
  update public.stage1_award_registry registry
  set official_homepage = expected.next_homepage
  from expected
  where registry.cohort_key = expected.cohort_key
    and registry.canonical_shared_award_id = expected.award_id
    and registry.official_homepage = expected.previous_homepage
    and registry.publication_state = 'pending';
  get diagnostics v_count = row_count;
  if v_count <> 3 then
    raise exception 'Fixture aborted: expected exactly 3 registry homepage changes, made %.', v_count;
  end if;

  -- 10. The three matching canonical shared award rows, same exact swap.
  with expected (cohort_key, award_id, previous_homepage, next_homepage) as (
    values
      ('truman', 'bf04d4c1-4db3-4f4e-bf1b-e4dbca7bb7d3'::uuid,
        'https://www.truman.gov/', 'https://www.truman.gov/apply'),
      ('hertz', '4d2f6a7f-024e-4194-be31-1b9f63e497bc'::uuid,
        'https://www.hertzfoundation.org/hertz-fellowship/', 'https://www.hertzfoundation.org/hertz-fellowship'),
      ('soros', '3cf7c610-0246-4dfb-b26c-289254e40ce6'::uuid,
        'https://www.pdsoros.org/', 'https://pdsoros.org/')
  )
  update public.shared_awards award
  set official_homepage = expected.next_homepage
  from expected
  where award.id = expected.award_id
    and award.official_homepage = expected.previous_homepage;
  get diagnostics v_count = row_count;
  if v_count <> 3 then
    raise exception 'Fixture aborted: expected exactly 3 shared award homepage changes, made %.', v_count;
  end if;

  -- 11. Result: exact v3 hash, consistent canonical rows, nothing else moved.
  v_hash := public.stage1_publication_evidence_hash(pg_catalog.to_jsonb((
    select pg_catalog.string_agg(
      pg_catalog.concat_ws(
        '|',
        registry.launch_rank::text,
        registry.cohort_key,
        registry.canonical_name,
        registry.canonical_shared_award_id::text,
        registry.canonical_slug,
        registry.official_homepage
      ),
      E'\n'
      order by registry.launch_rank
    )
    from public.stage1_award_registry registry
  )));
  if v_hash is distinct from v_v3_hash then
    raise exception 'Fixture aborted: registry identity hash % is not the exact v3 hash %.', v_hash, v_v3_hash;
  end if;
  select pg_catalog.count(*) into v_count
  from public.stage1_award_registry registry
  join public.shared_awards award
    on award.id = registry.canonical_shared_award_id
    and award.official_homepage = registry.official_homepage;
  if v_count <> 25 then
    raise exception 'Fixture aborted: only % of 25 canonical shared award homepages match the registry after the swap.', v_count;
  end if;
  select pg_catalog.string_agg(
    (pg_catalog.to_jsonb(registry) - 'official_homepage')::text,
    E'\n' order by registry.launch_rank
  ) into v_registry_after
  from public.stage1_award_registry registry;
  if v_registry_after is distinct from v_registry_before then
    raise exception 'Fixture aborted: a registry column other than official_homepage changed.';
  end if;
  select pg_catalog.string_agg(
    (pg_catalog.to_jsonb(award) - 'official_homepage')::text,
    E'\n' order by award.id
  ) into v_awards_after
  from public.shared_awards award;
  if v_awards_after is distinct from v_awards_before then
    raise exception 'Fixture aborted: a shared award column other than official_homepage changed.';
  end if;
  select pg_catalog.to_jsonb(release_state)::text into v_release_after
  from public.stage1_publication_release_state release_state;
  if v_release_after is distinct from v_release_before then
    raise exception 'Fixture aborted: the release row changed; the frozen v3 migration re-pins it, not this fixture.';
  end if;
  v_index := 0;
  foreach v_table in array v_preserved_tables loop
    v_index := v_index + 1;
    execute pg_catalog.format(
      'select coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(preserved)::text, pg_catalog.chr(10) order by pg_catalog.to_jsonb(preserved)::text), '''') from %s preserved',
      v_table::regclass
    ) into v_snapshot;
    if v_snapshot is distinct from v_preserved_before[v_index] then
      raise exception 'Fixture aborted: seeded table % changed during the swap.', v_table;
    end if;
  end loop;
  foreach v_table in array v_empty_tables loop
    execute pg_catalog.format('select pg_catalog.count(*) from %s', v_table::regclass) into v_count;
    if v_count <> 0 then
      raise exception 'Fixture aborted: % gained % row(s) during the swap.', v_table, v_count;
    end if;
  end loop;
  select state.revision into v_backlog_after
  from public.manual_quarantine_backlog_state state
  where state.state_key = 'operator_backlog';
  if v_backlog_after is distinct from v_backlog_before + 1 then
    raise exception 'Fixture aborted: expected the operator backlog revision to rise by exactly one (% -> %), got %.',
      v_backlog_before, v_backlog_before + 1, v_backlog_after;
  end if;

  raise notice 'awardping-fixture-replay: stage1 identity v3 prerequisite applied; registry hash % -> %',
    v_v2_hash, v_v3_hash;
end $stage1_identity_v3_prerequisite$;

commit;

-- Runner handshake, recomputed from the committed registry after the commit.
select
  'stage1_identity_v3_prerequisite_ok' as fixture_status,
  public.stage1_publication_evidence_hash(pg_catalog.to_jsonb((
    select pg_catalog.string_agg(
      pg_catalog.concat_ws(
        '|',
        registry.launch_rank::text,
        registry.cohort_key,
        registry.canonical_name,
        registry.canonical_shared_award_id::text,
        registry.canonical_slug,
        registry.official_homepage
      ),
      E'\n'
      order by registry.launch_rank
    )
    from public.stage1_award_registry registry
  ))) as registry_identity_hash;
