-- Correct the reviewed Hertz canonical homepage without erasing its prior
-- identity. NDSEG remains canonically rooted at ndseg.org; its official apply
-- link is retained as the explicit authority for the current SysPlus
-- contractor source. The NDSEG application dates remain quarantined because two
-- current contractor pages disagree.

create table if not exists private.stage1_canonical_identity_evidence (
  identity_key text primary key,
  cohort_key text not null references public.stage1_award_registry(cohort_key)
    on delete restrict,
  canonical_shared_award_id uuid not null references public.shared_awards(id)
    on delete restrict,
  previous_homepage text not null check (previous_homepage ~ '^https://'),
  current_homepage text not null check (current_homepage ~ '^https://'),
  authority_evidence_url text not null check (authority_evidence_url ~ '^https://'),
  evidence_summary text not null,
  evidence jsonb not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  reviewed_at timestamptz not null,
  policy_version text not null check (policy_version = 'stage1-publication-v1'),
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint stage1_canonical_identity_evidence_distinct_homepages check (
    previous_homepage <> current_homepage
  ),
  constraint stage1_canonical_identity_evidence_hash_check check (
    public.stage1_publication_evidence_hash(evidence) = evidence_hash
  )
);

alter table private.stage1_canonical_identity_evidence enable row level security;
revoke all on table private.stage1_canonical_identity_evidence
  from public, anon, authenticated, service_role;
grant select on table private.stage1_canonical_identity_evidence to service_role;
create policy stage1_canonical_identity_evidence_service_read
on private.stage1_canonical_identity_evidence
for select to service_role using (true);

create table if not exists private.stage1_delegated_source_authority_evidence (
  authority_key text primary key,
  cohort_key text not null references public.stage1_award_registry(cohort_key)
    on delete restrict,
  canonical_shared_award_id uuid not null references public.shared_awards(id)
    on delete restrict,
  canonical_homepage text not null check (canonical_homepage ~ '^https://'),
  delegated_host text not null,
  classification text not null check (
    classification = 'official_contractor_host'
  ),
  authority_status text not null check (authority_status = 'active'),
  authority_evidence_url text not null check (authority_evidence_url ~ '^https://'),
  evidence_summary text not null,
  evidence jsonb not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  reviewed_at timestamptz not null,
  policy_version text not null check (policy_version = 'stage1-publication-v1'),
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint stage1_delegated_source_authority_evidence_hash_check check (
    public.stage1_publication_evidence_hash(evidence) = evidence_hash
  )
);

alter table private.stage1_delegated_source_authority_evidence enable row level security;
revoke all on table private.stage1_delegated_source_authority_evidence
  from public, anon, authenticated, service_role;
grant select on table private.stage1_delegated_source_authority_evidence
  to service_role;
create policy stage1_delegated_source_authority_evidence_service_read
on private.stage1_delegated_source_authority_evidence
for select to service_role using (true);

create or replace function private.prevent_stage1_canonical_identity_evidence_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Reviewed Stage 1 canonical-identity evidence is immutable.';
end;
$$;

revoke all on function private.prevent_stage1_canonical_identity_evidence_mutation()
  from public, anon, authenticated, service_role;
create trigger prevent_stage1_canonical_identity_evidence_mutation
before update or delete on private.stage1_canonical_identity_evidence
for each row execute function private.prevent_stage1_canonical_identity_evidence_mutation();
create trigger prevent_stage1_delegated_source_authority_evidence_mutation
before update or delete on private.stage1_delegated_source_authority_evidence
for each row execute function private.prevent_stage1_canonical_identity_evidence_mutation();

with reviewed_identity (
  identity_key,
  cohort_key,
  canonical_shared_award_id,
  previous_homepage,
  current_homepage,
  authority_evidence_url,
  evidence_summary,
  reviewed_at
) as (
  values
    (
      'hertz-current-fellowship-root-2026-07-17',
      'hertz',
      '4d2f6a7f-024e-4194-be31-1b9f63e497bc'::uuid,
      'https://www.hertzfoundation.org/the-fellowship/',
      'https://www.hertzfoundation.org/hertz-fellowship/',
      'https://www.hertzfoundation.org/hertz-fellowship/application-help/faq/',
      'The current official Hertz program, application, eligibility, benefits, and FAQ pages are under /hertz-fellowship/; /the-fellowship/ is retained only as prior identity history.',
      '2026-07-17T14:41:57.337Z'::timestamptz
    )
), sealed as (
  select
    reviewed_identity.*,
    pg_catalog.jsonb_build_object(
      'schema_version', 'awardping.stage1.canonical-identity-evidence.v1',
      'cohort_key', reviewed_identity.cohort_key,
      'canonical_shared_award_id', reviewed_identity.canonical_shared_award_id,
      'previous_homepage', reviewed_identity.previous_homepage,
      'current_homepage', reviewed_identity.current_homepage,
      'authority_evidence_url', reviewed_identity.authority_evidence_url,
      'evidence_summary', reviewed_identity.evidence_summary,
      'reviewed_at', reviewed_identity.reviewed_at,
      'review_method', 'explicit_human_official_source_review',
      'paid_api_calls', 0
    ) as evidence
  from reviewed_identity
)
insert into private.stage1_canonical_identity_evidence (
  identity_key,
  cohort_key,
  canonical_shared_award_id,
  previous_homepage,
  current_homepage,
  authority_evidence_url,
  evidence_summary,
  evidence,
  evidence_hash,
  reviewed_at,
  policy_version
)
select
  sealed.identity_key,
  sealed.cohort_key,
  sealed.canonical_shared_award_id,
  sealed.previous_homepage,
  sealed.current_homepage,
  sealed.authority_evidence_url,
  sealed.evidence_summary,
  sealed.evidence,
  public.stage1_publication_evidence_hash(sealed.evidence),
  sealed.reviewed_at,
  'stage1-publication-v1'
from sealed
on conflict (identity_key) do nothing;

with reviewed_authority as (
  select pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.delegated-source-authority-evidence.v1',
    'cohort_key', 'ndseg',
    'canonical_shared_award_id',
      'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid,
    'canonical_homepage', 'https://ndseg.org/',
    'delegated_host', 'ndseg.sysplus.com',
    'classification', 'official_contractor_host',
    'authority_status', 'active',
    'authority_evidence_url', 'https://ndseg.org/apply-link',
    'evidence_summary', 'The canonical NDSEG host explicitly delegates the current application to the SysPlus-operated NDSEG program.',
    'reviewed_at', '2026-07-17T14:41:57.337Z',
    'review_method', 'explicit_human_official_source_review',
    'paid_api_calls', 0
  ) as evidence
)
insert into private.stage1_delegated_source_authority_evidence (
  authority_key,
  cohort_key,
  canonical_shared_award_id,
  canonical_homepage,
  delegated_host,
  classification,
  authority_status,
  authority_evidence_url,
  evidence_summary,
  evidence,
  evidence_hash,
  reviewed_at,
  policy_version
)
select
  'ndseg-sysplus-current-contractor-2026-07-17',
  'ndseg',
  'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid,
  'https://ndseg.org/',
  'ndseg.sysplus.com',
  'official_contractor_host',
  'active',
  'https://ndseg.org/apply-link',
  'The canonical NDSEG host explicitly delegates the current application to the SysPlus-operated NDSEG program.',
  reviewed_authority.evidence,
  public.stage1_publication_evidence_hash(reviewed_authority.evidence),
  '2026-07-17T14:41:57.337Z'::timestamptz,
  'stage1-publication-v1'
from reviewed_authority
on conflict (authority_key) do nothing;

-- Every current release function must use the corrected immutable cohort
-- identity. Recreate only functions that embed the exact previous identity
-- version/hash; CREATE OR REPLACE preserves their owner and grants.
do $awardping_stage1_identity_function_upgrade$
declare
  v_function record;
  v_definition text;
begin
  for v_function in
    select
      procedure.oid,
      pg_catalog.pg_get_functiondef(procedure.oid) as definition
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname in ('public', 'private')
      and procedure.prokind = 'f'
      and (
        (
          namespace.nspname = 'public'
          and procedure.proname = any(array[
            'transition_stage1_cohort_release',
            'list_stage1_effective_publication',
            'get_stage1_publication_snapshot',
            'record_stage1_hosted_runtime_identity_artifact',
            'record_stage1_rollback_drill_artifact',
            'record_stage1_non_cohort_leak_crawl_artifact',
            'record_stage1_r2_recovery_drill_artifact',
            'record_stage1_visual_crop_coverage_artifact',
            'record_stage1_release_acceptance'
          ]::text[])
        )
        or (
          namespace.nspname = 'private'
          and procedure.proname = any(array[
            'stage1_release_contract_state_hash',
            'stage1_release_external_signing_preflight',
             'insert_stage1_external_release_artifact',
             'stage1_current_valid_release_artifact',
             'stage1_release_gate_snapshot',
             -- 20260717123000 wrapped the active gate under this exact name.
             -- It remains on the live call path and still embeds the prior
             -- cohort identity until this migration upgrades it too.
             'stage1_gate_without_contact_fence_20260717123000'
           ]::text[])
        )
      )
      and (
        pg_catalog.strpos(
          pg_catalog.pg_get_functiondef(procedure.oid),
          '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e'
        ) > 0
        or pg_catalog.strpos(
          pg_catalog.pg_get_functiondef(procedure.oid),
          'stage1-national-25-v1'
        ) > 0
      )
  loop
    v_definition := pg_catalog.replace(
      pg_catalog.replace(
        v_function.definition,
        '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e',
        '6e7dd7ee1372671cbfb22b17b862d867145a93c7dc0b73d49afc11f504ee6c8f'
      ),
      'stage1-national-25-v1',
      'stage1-national-25-v2'
    );
    execute v_definition;
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname in ('public', 'private')
      and procedure.prokind = 'f'
      and (
        pg_catalog.strpos(
          pg_catalog.pg_get_functiondef(procedure.oid),
          '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e'
        ) > 0
        or pg_catalog.strpos(
          pg_catalog.pg_get_functiondef(procedure.oid),
          'stage1-national-25-v1'
        ) > 0
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'A current Stage 1 function still embeds the retired cohort identity.';
  end if;
end;
$awardping_stage1_identity_function_upgrade$;

-- A cohort-owned source is not automatically an official source. The live
-- release gate accepts only the exact canonical homepage host or an active,
-- immutable delegated-authority row. identity_home is stricter: it must be the
-- exact canonical homepage URL and may never be supplied by a contractor.
create or replace function private.stage1_manifest_source_authority_valid(
  p_cohort_key text,
  p_source_role text,
  p_source_url text,
  p_canonical_homepage text,
  p_policy_version text,
  p_source_binding jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_source_host text := pg_catalog.lower(
    pg_catalog.substring(p_source_url, '^https://([^/:?#]+)')
  );
  v_canonical_host text := pg_catalog.lower(
    pg_catalog.substring(p_canonical_homepage, '^https://([^/:?#]+)')
  );
  v_binding_identity jsonb := p_source_binding -> 'official_identity';
begin
  if nullif(pg_catalog.btrim(p_cohort_key), '') is null
    or nullif(pg_catalog.btrim(p_source_role), '') is null
    or nullif(pg_catalog.btrim(v_source_host), '') is null
    or nullif(pg_catalog.btrim(v_canonical_host), '') is null
    or p_source_binding ->> 'source_url' is distinct from p_source_url
    or pg_catalog.jsonb_typeof(v_binding_identity) is distinct from 'object'
    or v_binding_identity ->> 'host' is distinct from v_source_host
  then
    return false;
  end if;

  if p_source_role = 'identity_home' then
    return p_source_url = p_canonical_homepage
      and v_source_host = v_canonical_host
      and v_binding_identity ->> 'classification' = 'canonical_program_host'
      and v_binding_identity ->> 'evidence_url' = p_canonical_homepage;
  end if;

  if v_source_host = v_canonical_host then
    return v_binding_identity ->> 'classification' = 'canonical_program_host'
      and v_binding_identity ->> 'evidence_url' = p_canonical_homepage;
  end if;

  return exists (
    select 1
    from private.stage1_delegated_source_authority_evidence authority
    where authority.cohort_key = p_cohort_key
      and authority.canonical_homepage = p_canonical_homepage
      and authority.delegated_host = v_source_host
      and authority.classification = 'official_contractor_host'
      and authority.authority_status = 'active'
      and authority.policy_version = p_policy_version
      and authority.classification =
        v_binding_identity ->> 'classification'
      and authority.authority_evidence_url =
        v_binding_identity ->> 'evidence_url'
      and authority.evidence_hash =
        public.stage1_publication_evidence_hash(authority.evidence)
  );
end;
$$;

revoke all on function private.stage1_manifest_source_authority_valid(
  text,
  text,
  text,
  text,
  text,
  jsonb
) from public, anon, authenticated, service_role;

-- Patch the single authoritative per-cohort reason function at one reviewed
-- anchor. Any upstream function-body drift aborts instead of guessing.
do $awardping_stage1_source_authority_gate_upgrade$
declare
  v_function_oid oid := pg_catalog.to_regprocedure(
    'public.stage1_effective_publication_reason(text,timestamp with time zone)'
  );
  v_definition text;
  v_anchor constant text := E'or manifest.evidence #>> array[''source_bindings'', source_id::text, ''source_url'']\n          is distinct from source.url';
  v_replacement constant text := E'or not private.stage1_manifest_source_authority_valid(\n          p_cohort_key,\n          manifest.source_role,\n          source.url,\n          v_registry.official_homepage,\n          v_registry.policy_version,\n          manifest.evidence #> array[''source_bindings'', source_id::text]\n        )\n        or manifest.evidence #>> array[''source_bindings'', source_id::text, ''source_url'']\n          is distinct from source.url';
begin
  if v_function_oid is null then
    raise exception using
      errcode = '55000',
      message = 'The authoritative Stage 1 publication-reason function is missing.';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(v_function_oid);
  if pg_catalog.strpos(v_definition, v_anchor) = 0
    or pg_catalog.strpos(
      pg_catalog.substring(
        v_definition,
        pg_catalog.strpos(v_definition, v_anchor)
          + pg_catalog.length(v_anchor)
      ),
      v_anchor
    ) > 0
  then
    raise exception using
      errcode = '55000',
      message = 'The authoritative Stage 1 source-identity gate anchor drifted or is ambiguous.';
  end if;
  execute pg_catalog.replace(v_definition, v_anchor, v_replacement);

  if pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(v_function_oid),
    'private.stage1_manifest_source_authority_valid('
  ) = 0 then
    raise exception using
      errcode = '55000',
      message = 'The authoritative Stage 1 source-authority gate was not installed.';
  end if;
end;
$awardping_stage1_source_authority_gate_upgrade$;

alter table public.stage1_publication_release_state
  alter column cohort_identity_version
  set default 'stage1-national-25-v2';

do $awardping_stage1_canonical_homepage_upgrade$
declare
  v_wrong integer;
  v_changed boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  select pg_catalog.count(*) into v_wrong
  from (
    values
      (
        'hertz'::text,
        '4d2f6a7f-024e-4194-be31-1b9f63e497bc'::uuid,
        'https://www.hertzfoundation.org/the-fellowship/'::text,
        'https://www.hertzfoundation.org/hertz-fellowship/'::text
      ),
      (
        'ndseg'::text,
        'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid,
        'https://ndseg.org/'::text,
        'https://ndseg.org/'::text
      )
  ) expected(cohort_key, award_id, previous_homepage, current_homepage)
  left join public.stage1_award_registry registry
    on registry.cohort_key = expected.cohort_key
  left join public.shared_awards award
    on award.id = expected.award_id
  where registry.canonical_shared_award_id is distinct from expected.award_id
    or registry.official_homepage not in (
      expected.previous_homepage,
      expected.current_homepage
    )
    or award.id is null
    or award.official_homepage not in (
      expected.previous_homepage,
      expected.current_homepage
    );
  if v_wrong <> 0 then
    raise exception using
      errcode = '40001',
      message = 'Hertz or NDSEG canonical identity changed outside the reviewed migration fence.';
  end if;

  select exists (
    select 1
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
    ) expected(cohort_key, award_id, current_homepage)
    join public.stage1_award_registry registry
      on registry.cohort_key = expected.cohort_key
    join public.shared_awards award on award.id = expected.award_id
    where registry.official_homepage is distinct from expected.current_homepage
      or award.official_homepage is distinct from expected.current_homepage
  ) into v_changed;

  with expected (cohort_key, award_id, current_homepage) as (
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
  )
  insert into public.stage1_award_publication_events (
    cohort_key,
    previous_state,
    next_state,
    reason,
    policy_version,
    evidence_snapshot,
    evidence_hash,
    actor
  )
  select
    registry.cohort_key,
    'verified_beta',
    'revalidation_pending',
    'Canonical homepage authority changed; fresh Stage 1 verification is required.',
    registry.policy_version,
    pg_catalog.jsonb_build_object(
      'previous_homepage', registry.official_homepage,
      'current_homepage', expected.current_homepage,
      'canonical_shared_award_id', expected.award_id,
      'identity_version', 'stage1-national-25-v2',
      'invalidated_at', pg_catalog.statement_timestamp()
    ),
    public.stage1_publication_evidence_hash(
      pg_catalog.jsonb_build_object(
        'previous_homepage', registry.official_homepage,
        'current_homepage', expected.current_homepage,
        'canonical_shared_award_id', expected.award_id,
        'identity_version', 'stage1-national-25-v2',
        'invalidated_at', pg_catalog.statement_timestamp()
      )
    ),
    'reviewed-canonical-identity-migration'
  from expected
  join public.stage1_award_registry registry
    on registry.cohort_key = expected.cohort_key
  where registry.canonical_shared_award_id = expected.award_id
    and registry.publication_state = 'verified_beta'
    and registry.official_homepage is distinct from expected.current_homepage;

  with expected (cohort_key, award_id, current_homepage) as (
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
  )
  update public.stage1_award_registry registry
  set
    official_homepage = expected.current_homepage,
    publication_state = case
      when registry.publication_state = 'verified_beta'
        then 'revalidation_pending'
      else registry.publication_state
    end,
    state_reason = 'Canonical homepage authority changed; fresh exact source, fact, reconciliation, audit, and release evidence is required.',
    fact_ledger_batch_id = null,
    release_epoch = null,
    evidence_checked_at = null,
    last_verified_at = null,
    updated_at = pg_catalog.statement_timestamp()
  from expected
  where registry.cohort_key = expected.cohort_key
    and registry.canonical_shared_award_id = expected.award_id
    and registry.official_homepage is distinct from expected.current_homepage;

  with expected (cohort_key, award_id, current_homepage) as (
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
  )
  update public.shared_awards award
  set
    official_homepage = expected.current_homepage,
    updated_at = pg_catalog.statement_timestamp()
  from expected
  where award.id = expected.award_id
    and award.official_homepage is distinct from expected.current_homepage;

  if v_changed then
    perform public.invalidate_stage1_cohort_release(
      'Hertz canonical identity changed and NDSEG contractor authority was reviewed; the 25-award release requires fresh v2 evidence.',
      'reviewed-canonical-identity-migration'
    );
  end if;

  update public.stage1_publication_release_state release_state
  set
    release_state = case
      when release_state.release_state = 'verified_beta'
        then 'revalidation_pending'
      else release_state.release_state
    end,
    release_epoch = null,
    activated_at = null,
    reason = case
      when v_changed
        then 'Canonical identity v2 requires a fresh exact 25-award release.'
      else release_state.reason
    end,
    cohort_identity_version = 'stage1-national-25-v2',
    cohort_identity_hash =
      '6e7dd7ee1372671cbfb22b17b862d867145a93c7dc0b73d49afc11f504ee6c8f',
    updated_at = pg_catalog.statement_timestamp()
  where release_state.release_key = 'stage1-national-25'
    and (
      release_state.cohort_identity_version is distinct from
        'stage1-national-25-v2'
      or release_state.cohort_identity_hash is distinct from
        '6e7dd7ee1372671cbfb22b17b862d867145a93c7dc0b73d49afc11f504ee6c8f'
      or release_state.release_state = 'verified_beta'
      or release_state.release_epoch is not null
      or release_state.activated_at is not null
    );
end;
$awardping_stage1_canonical_homepage_upgrade$;

-- The conflict is deliberately not resolved by selecting either date. This
-- durable operator case blocks publication until new official evidence makes
-- the two current pages agree or supersedes one of them.
with evidence as (
  select pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.ndseg-application-cycle-conflict.v1',
    'canonical_shared_award_id',
      'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid,
    'authority_evidence_url', 'https://ndseg.org/apply-link',
    'current_operating_root', 'https://ndseg.sysplus.com/',
    'conflicting_sources', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'url', 'https://ndseg.sysplus.com/',
        'source_kind', 'official_contractor_homepage',
        'reported_cycle', 'FY2027',
        'reported_open_date', 'August 3, 2026',
        'reported_deadline', 'October 30, 2026 (5 PM Eastern)',
        'exact_wording', 'The NDSEG FY2027 Fellowship Program Application Period begins August 3 through October 30, 2026 (5 PM Eastern).'
      ),
      pg_catalog.jsonb_build_object(
        'url', 'https://ndseg.sysplus.com/NDSEG/Applicants/How-to-Apply',
        'source_kind', 'official_contractor_how_to_apply',
        'reported_cycle', 'next application cycle',
        'reported_open_date', 'August 15',
        'reported_deadline', 'November 15',
        'exact_wording', 'The next application cycle opens August 15 – November 15'
      )
    ),
    'reviewed_at', '2026-07-17T14:41:57.337Z',
    'publication_decision', 'not_published'
  ) as value
)
insert into public.manual_quarantine_registry (
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
  shared_award_id,
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
)
select
  'stage1:ndseg:official-deadline-conflict:2026-07-17',
  'stage1:ndseg:official-deadline-conflict',
  'actionable_quarantine',
  'public_page',
  'quarantined',
  true,
  false,
  0,
  'high',
  'blocked',
  'stage1-source-owner',
  'Recheck both official contractor pages after a published correction; never auto-select one date set.',
  'none',
  'NDSEG official application-cycle date conflict',
  'official_source_fact_conflict',
  'Two current official SysPlus NDSEG pages publish different opening and closing dates for the next application cycle.',
  'Keep the application-cycle dates unavailable. Obtain a cycle-specific correction or explicit program-owner confirmation, then resolve this quarantine with retained evidence.',
  'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid,
  'stage1_award_registry',
  'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid,
  2,
  evidence.value,
  public.manual_quarantine_evidence_hash(evidence.value),
  'awardping-stage1-official-source-conflict',
  '1',
  '4a12c7a0c4e088bca3b5c4b9ef28c6ddb8b108ac8b324c23dbde4aa5e0646ae4',
  '2026-07-17T14:41:57.337Z'::timestamptz,
  '2026-07-17T14:41:57.337Z'::timestamptz
from evidence
on conflict (quarantine_key) do nothing;

do $awardping_stage1_canonical_identity_postcondition$
declare
  v_identity_payload text;
  v_identity_hash text;
  v_hertz_evidence jsonb := pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.canonical-identity-evidence.v1',
    'cohort_key', 'hertz',
    'canonical_shared_award_id',
      '4d2f6a7f-024e-4194-be31-1b9f63e497bc'::uuid,
    'previous_homepage', 'https://www.hertzfoundation.org/the-fellowship/',
    'current_homepage', 'https://www.hertzfoundation.org/hertz-fellowship/',
    'authority_evidence_url',
      'https://www.hertzfoundation.org/hertz-fellowship/application-help/faq/',
    'evidence_summary', 'The current official Hertz program, application, eligibility, benefits, and FAQ pages are under /hertz-fellowship/; /the-fellowship/ is retained only as prior identity history.',
    'reviewed_at', '2026-07-17T14:41:57.337Z'::timestamptz,
    'review_method', 'explicit_human_official_source_review',
    'paid_api_calls', 0
  );
  v_ndseg_authority_evidence jsonb := pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.delegated-source-authority-evidence.v1',
    'cohort_key', 'ndseg',
    'canonical_shared_award_id',
      'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid,
    'canonical_homepage', 'https://ndseg.org/',
    'delegated_host', 'ndseg.sysplus.com',
    'classification', 'official_contractor_host',
    'authority_status', 'active',
    'authority_evidence_url', 'https://ndseg.org/apply-link',
    'evidence_summary', 'The canonical NDSEG host explicitly delegates the current application to the SysPlus-operated NDSEG program.',
    'reviewed_at', '2026-07-17T14:41:57.337Z',
    'review_method', 'explicit_human_official_source_review',
    'paid_api_calls', 0
  );
  v_ndseg_conflict_evidence jsonb := pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.stage1.ndseg-application-cycle-conflict.v1',
    'canonical_shared_award_id',
      'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid,
    'authority_evidence_url', 'https://ndseg.org/apply-link',
    'current_operating_root', 'https://ndseg.sysplus.com/',
    'conflicting_sources', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'url', 'https://ndseg.sysplus.com/',
        'source_kind', 'official_contractor_homepage',
        'reported_cycle', 'FY2027',
        'reported_open_date', 'August 3, 2026',
        'reported_deadline', 'October 30, 2026 (5 PM Eastern)',
        'exact_wording', 'The NDSEG FY2027 Fellowship Program Application Period begins August 3 through October 30, 2026 (5 PM Eastern).'
      ),
      pg_catalog.jsonb_build_object(
        'url', 'https://ndseg.sysplus.com/NDSEG/Applicants/How-to-Apply',
        'source_kind', 'official_contractor_how_to_apply',
        'reported_cycle', 'next application cycle',
        'reported_open_date', 'August 15',
        'reported_deadline', 'November 15',
        'exact_wording', 'The next application cycle opens August 15 – November 15'
      )
    ),
    'reviewed_at', '2026-07-17T14:41:57.337Z',
    'publication_decision', 'not_published'
  );
begin
  if exists (
    select 1
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
    left join public.stage1_award_registry registry
      on registry.cohort_key = expected.cohort_key
    left join public.shared_awards award
      on award.id = expected.award_id
    where registry.canonical_shared_award_id is distinct from expected.award_id
      or registry.official_homepage is distinct from expected.homepage
      or award.official_homepage is distinct from expected.homepage
  ) then
    raise exception using
      errcode = '55000',
      message = 'Hertz or NDSEG did not reach the reviewed canonical homepage.';
  end if;

  if not exists (
    select 1
    from private.stage1_canonical_identity_evidence retained
    where retained.identity_key = 'hertz-current-fellowship-root-2026-07-17'
      and retained.cohort_key = 'hertz'
      and retained.canonical_shared_award_id =
        '4d2f6a7f-024e-4194-be31-1b9f63e497bc'::uuid
      and retained.previous_homepage =
        'https://www.hertzfoundation.org/the-fellowship/'
      and retained.current_homepage =
        'https://www.hertzfoundation.org/hertz-fellowship/'
      and retained.authority_evidence_url =
        'https://www.hertzfoundation.org/hertz-fellowship/application-help/faq/'
      and retained.evidence_summary =
        'The current official Hertz program, application, eligibility, benefits, and FAQ pages are under /hertz-fellowship/; /the-fellowship/ is retained only as prior identity history.'
      and retained.evidence = v_hertz_evidence
      and retained.evidence_hash =
        public.stage1_publication_evidence_hash(v_hertz_evidence)
      and retained.reviewed_at = '2026-07-17T14:41:57.337Z'::timestamptz
      and retained.policy_version = 'stage1-publication-v1'
  ) then
    raise exception using
      errcode = '55000',
      message = 'The retained Hertz identity key collides with different evidence or hash.';
  end if;

  if not exists (
    select 1
    from private.stage1_delegated_source_authority_evidence retained
    where retained.authority_key =
      'ndseg-sysplus-current-contractor-2026-07-17'
      and retained.cohort_key = 'ndseg'
      and retained.canonical_shared_award_id =
        'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid
      and retained.canonical_homepage = 'https://ndseg.org/'
      and retained.delegated_host = 'ndseg.sysplus.com'
      and retained.classification = 'official_contractor_host'
      and retained.authority_status = 'active'
      and retained.authority_evidence_url = 'https://ndseg.org/apply-link'
      and retained.evidence_summary =
        'The canonical NDSEG host explicitly delegates the current application to the SysPlus-operated NDSEG program.'
      and retained.evidence = v_ndseg_authority_evidence
      and retained.evidence_hash =
        public.stage1_publication_evidence_hash(v_ndseg_authority_evidence)
      and retained.reviewed_at = '2026-07-17T14:41:57.337Z'::timestamptz
      and retained.policy_version = 'stage1-publication-v1'
  ) then
    raise exception using
      errcode = '55000',
      message = 'The NDSEG delegated contractor key collides with different evidence or hash.';
  end if;

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
    E'\n' order by registry.launch_rank
  ) into v_identity_payload
  from public.stage1_award_registry registry;
  v_identity_hash := public.stage1_publication_evidence_hash(
    pg_catalog.to_jsonb(v_identity_payload)
  );
  if v_identity_hash is distinct from
    '6e7dd7ee1372671cbfb22b17b862d867145a93c7dc0b73d49afc11f504ee6c8f'
  then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 canonical identity v2 hash differs from reviewed code.';
  end if;

  if not exists (
    select 1 from public.manual_quarantine_registry quarantine
    where quarantine.quarantine_key =
      'stage1:ndseg:official-deadline-conflict:2026-07-17'
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
      and quarantine.retry_mode =
        'Recheck both official contractor pages after a published correction; never auto-select one date set.'
      and quarantine.retry_charge = 'none'
      and quarantine.title = 'NDSEG official application-cycle date conflict'
      and quarantine.reason_code = 'official_source_fact_conflict'
      and quarantine.reason =
        'Two current official SysPlus NDSEG pages publish different opening and closing dates for the next application cycle.'
      and quarantine.recommended_action =
        'Keep the application-cycle dates unavailable. Obtain a cycle-specific correction or explicit program-owner confirmation, then resolve this quarantine with retained evidence.'
      and quarantine.shared_award_id =
        'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid
      and quarantine.shared_award_source_id is null
      and quarantine.visual_review_candidate_id is null
      and quarantine.primary_source_table = 'stage1_award_registry'
      and quarantine.primary_source_record_id =
        'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid
      and quarantine.evidence_record_count = 2
      and quarantine.evidence = v_ndseg_conflict_evidence
      and quarantine.evidence_hash =
        public.manual_quarantine_evidence_hash(v_ndseg_conflict_evidence)
      and quarantine.evidence ->> 'publication_decision' = 'not_published'
      and quarantine.policy_id = 'awardping-stage1-official-source-conflict'
      and quarantine.policy_version = '1'
      and quarantine.policy_hash =
        '4a12c7a0c4e088bca3b5c4b9ef28c6ddb8b108ac8b324c23dbde4aa5e0646ae4'
      and quarantine.first_observed_at =
        '2026-07-17T14:41:57.337Z'::timestamptz
      and quarantine.last_observed_at =
        '2026-07-17T14:41:57.337Z'::timestamptz
      and quarantine.resolved_at is null
      and quarantine.resolved_by is null
      and quarantine.resolution_note is null
  ) then
    raise exception using
      errcode = '55000',
      message = 'The exact unresolved NDSEG official date-conflict quarantine is missing or altered.';
  end if;
end;
$awardping_stage1_canonical_identity_postcondition$;
