-- Stage 1 has a deliberately small public surface. This registry is the one
-- authoritative publication gate; shared_awards.status remains the worker's
-- operational active/archive state and must never be used as a public-release
-- decision on its own.

create extension if not exists pgcrypto;

create table if not exists public.stage1_award_registry (
  cohort_key text primary key check (cohort_key ~ '^[a-z0-9_]+$'),
  launch_rank integer not null unique check (launch_rank between 1 and 25),
  canonical_name text not null,
  canonical_shared_award_id uuid not null unique
    references public.shared_awards(id) on delete restrict,
  canonical_slug text not null unique check (
    canonical_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  official_homepage text not null check (official_homepage ~ '^https://'),
  publication_state text not null default 'pending' check (
    publication_state in (
      'pending',
      'verified_beta',
      'revalidation_pending',
      'suspended'
    )
  ),
  state_reason text not null default 'Awaiting verified Stage 1 evidence.',
  policy_version text not null default 'stage1-publication-v1',
  fact_ledger_batch_id uuid,
  release_epoch uuid,
  evidence_checked_at timestamptz,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stage1_registry_release_epoch_state_check check (
    release_epoch is null or publication_state = 'verified_beta'
  )
);

create table if not exists public.stage1_publication_release_state (
  release_key text primary key check (release_key = 'stage1-national-25'),
  release_state text not null default 'pending' check (
    release_state in (
      'pending',
      'verified_beta',
      'revalidation_pending',
      'suspended'
    )
  ),
  release_epoch uuid,
  reason text not null default 'Awaiting one verified 25-award release.',
  policy_version text not null default 'stage1-publication-v1',
  cohort_identity_version text not null default 'stage1-national-25-v1',
  cohort_identity_hash text not null check (cohort_identity_hash ~ '^[0-9a-f]{64}$'),
  activated_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint stage1_release_epoch_state_check check (
    (
      release_state = 'verified_beta'
      and release_epoch is not null
      and activated_at is not null
    )
    or (
      release_state <> 'verified_beta'
      and release_epoch is null
      and activated_at is null
    )
  )
);

create table if not exists public.stage1_publication_release_events (
  id bigint generated always as identity primary key,
  release_key text not null,
  previous_state text not null,
  next_state text not null,
  release_epoch uuid,
  reason text not null,
  policy_version text not null,
  cohort_identity_version text not null,
  cohort_identity_hash text not null check (cohort_identity_hash ~ '^[0-9a-f]{64}$'),
  evidence_snapshot jsonb not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  actor text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.stage1_award_members (
  shared_award_id uuid primary key
    references public.shared_awards(id) on delete restrict,
  cohort_key text not null
    references public.stage1_award_registry(cohort_key) on delete restrict,
  member_kind text not null check (member_kind in ('canonical', 'alias')),
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists stage1_award_members_one_canonical_idx
  on public.stage1_award_members (cohort_key)
  where member_kind = 'canonical';

create index if not exists stage1_award_members_cohort_idx
  on public.stage1_award_members (cohort_key, member_kind, shared_award_id);

create table if not exists public.stage1_award_source_identity_rules (
  id bigint generated always as identity primary key,
  cohort_key text not null
    references public.stage1_award_registry(cohort_key) on delete restrict,
  rule_key text not null,
  url_pattern text,
  title_pattern text,
  reason text not null,
  policy_version text not null default 'stage1-publication-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cohort_key, rule_key),
  constraint stage1_source_identity_rule_pattern_check check (
    nullif(pg_catalog.btrim(url_pattern), '') is not null
    or nullif(pg_catalog.btrim(title_pattern), '') is not null
  )
);

create table if not exists public.stage1_award_source_manifest (
  cohort_key text not null
    references public.stage1_award_registry(cohort_key) on delete restrict,
  source_role text not null check (
    source_role in (
      'identity_home',
      'eligibility',
      'application_materials',
      'dates_cycle',
      'funding',
      'faq',
      'selection_interviews',
      'current_documents'
    )
  ),
  manifest_status text not null default 'missing' check (
    manifest_status in ('missing', 'present', 'combined', 'not_published')
  ),
  source_ids uuid[] not null default '{}'::uuid[],
  evidence jsonb not null default '{}'::jsonb,
  checked_at timestamptz,
  policy_version text not null default 'stage1-publication-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (cohort_key, source_role),
  constraint stage1_manifest_missing_state_check check (
    (manifest_status = 'missing' and checked_at is null)
    or (manifest_status <> 'missing' and checked_at is not null)
  ),
  constraint stage1_manifest_sources_check check (
    (manifest_status = 'missing' and cardinality(source_ids) = 0)
    or (manifest_status <> 'missing' and cardinality(source_ids) > 0)
  )
);

create table if not exists public.stage1_award_publication_events (
  id bigint generated always as identity primary key,
  cohort_key text not null
    references public.stage1_award_registry(cohort_key) on delete restrict,
  previous_state text not null,
  next_state text not null,
  reason text not null,
  policy_version text not null,
  evidence_snapshot jsonb not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  actor text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.stage1_award_reconciled_fact_evidence (
  id uuid primary key default gen_random_uuid(),
  shared_award_id uuid not null
    references public.shared_awards(id) on delete restrict,
  reconciliation_id uuid not null
    references public.shared_award_reconciliation_queue(id) on delete restrict,
  field_name text not null,
  public_value jsonb not null,
  candidate_ids uuid[] not null check (cardinality(candidate_ids) > 0),
  source_ids uuid[] not null check (cardinality(source_ids) > 0),
  evidence jsonb not null check (pg_catalog.jsonb_typeof(evidence) = 'object'),
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  materialized_at timestamptz not null default now(),
  unique (reconciliation_id, field_name)
);

create table if not exists public.stage1_award_fact_publication_ledger (
  id bigint generated always as identity primary key,
  verification_batch_id uuid not null,
  cohort_key text not null
    references public.stage1_award_registry(cohort_key) on delete restrict,
  field_name text not null,
  materialization_id uuid not null
    references public.stage1_award_reconciled_fact_evidence(id) on delete restrict,
  candidate_id uuid not null
    references public.shared_award_fact_candidates(id) on delete restrict,
  source_id uuid not null
    references public.shared_award_sources(id) on delete restrict,
  source_url text not null check (source_url ~ '^https://'),
  source_role text not null,
  contributing_candidate_ids uuid[] not null check (
    cardinality(contributing_candidate_ids) > 0
  ),
  contributing_source_ids uuid[] not null check (
    cardinality(contributing_source_ids) > 0
  ),
  supporting_text text not null check (
    nullif(pg_catalog.btrim(supporting_text), '') is not null
  ),
  source_snapshot_hashes jsonb not null check (
    source_snapshot_hashes <> '{}'::jsonb
  ),
  source_captured_at timestamptz not null,
  reconciliation_id uuid not null
    references public.shared_award_reconciliation_queue(id) on delete restrict,
  page_audit_id uuid not null
    references public.shared_award_page_audits(id) on delete restrict,
  normalized_value jsonb not null,
  public_value jsonb not null,
  cycle text not null,
  policy_version text not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz not null default now(),
  unique (verification_batch_id, field_name)
);

create index if not exists stage1_fact_ledger_cohort_batch_idx
  on public.stage1_award_fact_publication_ledger (
    cohort_key,
    verification_batch_id,
    field_name
  );

create index if not exists stage1_publication_events_cohort_idx
  on public.stage1_award_publication_events (cohort_key, created_at desc, id desc);

alter table public.stage1_award_registry enable row level security;
alter table public.stage1_publication_release_state enable row level security;
alter table public.stage1_publication_release_events enable row level security;
alter table public.stage1_award_members enable row level security;
alter table public.stage1_award_source_identity_rules enable row level security;
alter table public.stage1_award_source_manifest enable row level security;
alter table public.stage1_award_publication_events enable row level security;
alter table public.stage1_award_reconciled_fact_evidence enable row level security;
alter table public.stage1_award_fact_publication_ledger enable row level security;

revoke all on table public.stage1_award_registry
  from public, anon, authenticated, service_role;
revoke all on table public.stage1_publication_release_state
  from public, anon, authenticated, service_role;
revoke all on table public.stage1_publication_release_events
  from public, anon, authenticated, service_role;
revoke all on table public.stage1_award_members
  from public, anon, authenticated, service_role;
revoke all on table public.stage1_award_source_identity_rules
  from public, anon, authenticated, service_role;
revoke all on table public.stage1_award_source_manifest
  from public, anon, authenticated, service_role;
revoke all on table public.stage1_award_publication_events
  from public, anon, authenticated, service_role;
revoke all on table public.stage1_award_reconciled_fact_evidence
  from public, anon, authenticated, service_role;
revoke all on table public.stage1_award_fact_publication_ledger
  from public, anon, authenticated, service_role;
revoke all on sequence public.stage1_award_publication_events_id_seq
  from public, anon, authenticated, service_role;
revoke all on sequence public.stage1_publication_release_events_id_seq
  from public, anon, authenticated, service_role;
revoke all on sequence public.stage1_award_fact_publication_ledger_id_seq
  from public, anon, authenticated, service_role;

grant select on table public.stage1_award_registry to service_role;
grant select on table public.stage1_publication_release_state to service_role;
grant select on table public.stage1_publication_release_events to service_role;
grant select on table public.stage1_award_members to service_role;
grant select on table public.stage1_award_source_identity_rules to service_role;
grant select on table public.stage1_award_source_manifest to service_role;
grant select on table public.stage1_award_publication_events to service_role;
grant select, insert, update, delete
  on table public.stage1_award_reconciled_fact_evidence to service_role;
grant select on table public.stage1_award_fact_publication_ledger to service_role;

create temporary table stage1_cohort_seed (
  launch_rank integer,
  cohort_key text,
  canonical_name text,
  canonical_search_key text,
  canonical_shared_award_id uuid,
  canonical_slug text,
  official_homepage text
) on commit drop;

insert into stage1_cohort_seed values
    (1, 'rhodes_us', 'Rhodes Scholarship (United States)', 'rhodes scholarship', '3e0c02fe-70cc-4933-81c4-b58ac4036bff'::uuid, 'rhodes-scholarship', 'https://www.rhodeshouse.ox.ac.uk/scholarships/the-rhodes-scholarship/'),
    (2, 'marshall', 'Marshall Scholarship', 'marshall scholarship', '4c02307f-5928-4066-8f97-bd704b372184'::uuid, 'marshall-scholarship', 'https://www.marshallscholarship.org/'),
    (3, 'fulbright_us_student', 'Fulbright U.S. Student Program', 'fulbright u.s. student program', '5dd1afc1-a560-495a-9bee-1f26f835475b'::uuid, 'fulbright-u-s-student-program', 'https://us.fulbrightonline.org/'),
    (4, 'gates_cambridge', 'Gates Cambridge Scholarship', 'gates cambridge scholarship', 'b6fc3596-4f9a-4cab-ba83-69b3e5387774'::uuid, 'gates-cambridge-scholarship', 'https://www.gatescambridge.org/'),
    (5, 'churchill', 'Churchill Scholarship', 'churchill scholarship', '0695c116-1151-4b68-997e-93df400734dd'::uuid, 'churchill-scholarship', 'https://www.churchillscholarship.org/'),
    (6, 'schwarzman', 'Schwarzman Scholars', 'schwarzman scholars', 'dd23afbb-299e-489f-8a0b-e4d7506848de'::uuid, 'schwarzman-scholars', 'https://www.schwarzmanscholars.org/'),
    (7, 'knight_hennessy', 'Knight-Hennessy Scholars', 'knight-hennessy scholars', '141944a8-fd04-4433-b0e4-8990fae56764'::uuid, 'knight-hennessy-scholars', 'https://knight-hennessy.stanford.edu/'),
    (8, 'yenching', 'Yenching Academy', 'yenching academy scholars', '2da1b35d-fe8b-46cd-bc4b-b099e0fd1363'::uuid, 'yenching-academy-scholars', 'https://yenchingacademy.pku.edu.cn/'),
    (9, 'luce', 'Luce Scholars Program', 'luce scholars program', 'a643d94e-216b-4449-bf2f-99d8503793d7'::uuid, 'luce-scholars-program', 'https://lucescholars.org/'),
    (10, 'truman', 'Harry S. Truman Scholarship', 'truman scholarship', 'bf04d4c1-4db3-4f4e-bf1b-e4dbca7bb7d3'::uuid, 'truman-scholarship', 'https://www.truman.gov/'),
    (11, 'goldwater', 'Barry Goldwater Scholarship', 'goldwater scholarship', '4a2c1160-d5bc-41db-b645-d51030585275'::uuid, 'goldwater-scholarship', 'https://goldwaterscholarship.gov/'),
    (12, 'udall_undergraduate', 'Udall Undergraduate Scholarship', 'udall scholarship', 'ef4c98ad-ffaa-4f15-9771-d9a94487bf0d'::uuid, 'udall-scholarship', 'https://www.udall.gov/OurPrograms/Scholarship/Scholarship.aspx'),
    (13, 'beinecke', 'Beinecke Scholarship', 'beinecke scholarship', '26b5b55f-57e9-42a7-ae4c-37d389c5e70c'::uuid, 'beinecke-scholarship', 'https://beineckescholarship.org/'),
    (14, 'gilman', 'Benjamin A. Gilman International Scholarship', 'gilman international scholarship', 'c699e979-fbbe-4d58-8a4a-fc36fe6db833'::uuid, 'gilman-international-scholarship', 'https://www.gilmanscholarship.org/'),
    (15, 'boren', 'Boren Scholarships and Fellowships', 'boren awards', '5cabc508-416c-4387-8652-276e7c76afe1'::uuid, 'boren-awards', 'https://www.borenawards.org/'),
    (16, 'cls', 'Critical Language Scholarship Program', 'critical language scholarship', 'ba1a3c76-4868-42b4-994b-6cbae72a7044'::uuid, 'critical-language-scholarship', 'https://clscholarship.org/'),
    (17, 'nsf_grfp', 'NSF Graduate Research Fellowship Program', 'nsf graduate research fellowship program', 'd955a846-cee1-4c01-932e-e3cb7215f3fb'::uuid, 'nsf-graduate-research-fellowship-program', 'https://www.nsfgrfp.org/'),
    (18, 'hertz', 'Hertz Fellowship', 'hertz foundation graduate fellowship', '4d2f6a7f-024e-4194-be31-1b9f63e497bc'::uuid, 'hertz-foundation-graduate-fellowship', 'https://www.hertzfoundation.org/the-fellowship/'),
    (19, 'ndseg', 'National Defense Science and Engineering Graduate Fellowship', 'national defense science and engineering graduate fellowship', 'e776ca2f-4b2c-431e-a3f9-248ad78c30e8'::uuid, 'national-defense-science-and-engineering-graduate-fellowship', 'https://ndseg.org/'),
    (20, 'smart', 'SMART Scholarship-for-Service Program', 'smart scholarship for service program', 'd7d4d117-f312-456f-a75c-3dbd5d372c99'::uuid, 'smart-scholarship-for-service-program', 'https://www.smartscholarship.org/smart'),
    (21, 'gem', 'GEM Fellowship', 'gem national consortium', '4b7cef78-b2c9-4463-ad3e-0f42a9164425'::uuid, 'gem-national-consortium', 'https://www.gemfellowship.org/'),
    (22, 'noaa_hollings', 'NOAA Ernest F. Hollings Undergraduate Scholarship', 'noaa hollings scholarship', 'a9b42e3f-6d7e-4b0d-8132-77c2042b311d'::uuid, 'noaa-hollings-scholarship', 'https://www.noaa.gov/office-education/hollings-scholarship'),
    (23, 'soros', 'Paul & Daisy Soros Fellowships for New Americans', 'paul & daisy soros fellowships for new americans', '3cf7c610-0246-4dfb-b26c-289254e40ce6'::uuid, 'paul-and-daisy-soros-fellowships-for-new-americans', 'https://www.pdsoros.org/'),
    (24, 'samvid', 'Samvid Scholars', 'samvid scholars program', '406c12bc-49f3-4d4c-b90d-9ba7e4e0f70e'::uuid, 'samvid-scholars-program', 'https://samvidscholars.org/'),
    (25, 'gaither', 'James C. Gaither Junior Fellows Program', 'james c. gaither junior fellows program', '7007882c-af99-4919-ad2c-2672ffcccfaf'::uuid, 'james-c-gaither-junior-fellows-program', 'https://carnegieendowment.org/james-c-gaither-junior-fellows-program');

insert into public.shared_awards (
  id,
  search_key,
  name,
  official_homepage,
  summary,
  confidence,
  status,
  source,
  slug
)
select
  seed.canonical_shared_award_id,
  seed.canonical_search_key,
  seed.canonical_name,
  seed.official_homepage,
  seed.canonical_name || ' official award record.',
  0,
  'active',
  'seed',
  seed.canonical_slug
from stage1_cohort_seed seed
on conflict (id) do update
set search_key = excluded.search_key,
  name = excluded.name,
  official_homepage = excluded.official_homepage,
  status = 'active',
  slug = excluded.slug,
  updated_at = now();

with aliases (search_key) as (
  values
    ('rhodes scholarships'),
    ('u.s. department of state - fulbright u.s. student program - english teaching assistantships (eta)'),
    ('u.s. department of state - fulbright u.s. student program - grants for research, study, & arts'),
    ('schwarzman scholarship'),
    ('knight-hennessy scholars program'),
    ('henry luce foundation - scholars program for professional development in asia'),
    ('morris k. udall and stewart l. udall scholarship'),
    ('gilman scholarship'),
    ('boren awards for international study'),
    ('boren scholarship/fellowship urgd/grad'),
    ('us national security education program (nsep) - boren fellowships'),
    ('critical language scholarships program'),
    ('critical languages scholarship'),
    ('u.s. department of state - critical language scholarship (cls) program'),
    ('national science foundation graduate research fellowship'),
    ('department of war national defense science and engineering grad fellowships'),
    ('smart scholarship program'),
    ('u.s. department of defense (dod) - science, mathematics & research for transformation (smart) - scholarship for service program'),
    ('national gem consortium - master''s engineering and science fellowship'),
    ('national gem consortium - ph.d. engineering and science fellowship'),
    ('ernest f. hollings undergraduate scholarship (noaa)'),
    ('hollings scholarship'),
    ('soros fellowship for new americans'),
    ('soros fellowships for new americans'),
    ('carnegie junior fellowship')
)
insert into public.shared_awards (
  search_key,
  name,
  summary,
  confidence,
  status,
  source,
  slug
)
select
  aliases.search_key,
  pg_catalog.initcap(aliases.search_key),
  'Retained historical alias for the Stage 1 cohort.',
  0,
  'active',
  'seed',
  'stage1-alias-' || pg_catalog.md5(aliases.search_key)
from aliases
on conflict (search_key) do nothing;

with cohort as (
  select * from stage1_cohort_seed
)
insert into public.stage1_award_registry (
  launch_rank,
  cohort_key,
  canonical_name,
  canonical_shared_award_id,
  canonical_slug,
  official_homepage
)
select
  cohort.launch_rank,
  cohort.cohort_key,
  cohort.canonical_name,
  cohort.canonical_shared_award_id,
  cohort.canonical_slug,
  cohort.official_homepage
from cohort
join public.shared_awards award
  on award.id = cohort.canonical_shared_award_id
  and award.search_key = cohort.canonical_search_key
  and award.slug = cohort.canonical_slug
on conflict (cohort_key) do update
set
  launch_rank = excluded.launch_rank,
  canonical_name = excluded.canonical_name,
  canonical_shared_award_id = excluded.canonical_shared_award_id,
  canonical_slug = excluded.canonical_slug,
  official_homepage = excluded.official_homepage,
  publication_state = case
    when public.stage1_award_registry.canonical_name is distinct from excluded.canonical_name
      or public.stage1_award_registry.canonical_shared_award_id is distinct from excluded.canonical_shared_award_id
      or public.stage1_award_registry.canonical_slug is distinct from excluded.canonical_slug
      or public.stage1_award_registry.official_homepage is distinct from excluded.official_homepage
    then 'pending'
    else public.stage1_award_registry.publication_state
  end,
  state_reason = case
    when public.stage1_award_registry.canonical_name is distinct from excluded.canonical_name
      or public.stage1_award_registry.canonical_shared_award_id is distinct from excluded.canonical_shared_award_id
      or public.stage1_award_registry.canonical_slug is distinct from excluded.canonical_slug
      or public.stage1_award_registry.official_homepage is distinct from excluded.official_homepage
    then 'Canonical identity changed; fresh Stage 1 verification is required.'
    else public.stage1_award_registry.state_reason
  end,
  evidence_checked_at = case
    when public.stage1_award_registry.canonical_name is distinct from excluded.canonical_name
      or public.stage1_award_registry.canonical_shared_award_id is distinct from excluded.canonical_shared_award_id
      or public.stage1_award_registry.canonical_slug is distinct from excluded.canonical_slug
      or public.stage1_award_registry.official_homepage is distinct from excluded.official_homepage
    then null
    else public.stage1_award_registry.evidence_checked_at
  end,
  last_verified_at = case
    when public.stage1_award_registry.canonical_name is distinct from excluded.canonical_name
      or public.stage1_award_registry.canonical_shared_award_id is distinct from excluded.canonical_shared_award_id
      or public.stage1_award_registry.canonical_slug is distinct from excluded.canonical_slug
      or public.stage1_award_registry.official_homepage is distinct from excluded.official_homepage
    then null
    else public.stage1_award_registry.last_verified_at
  end,
  fact_ledger_batch_id = case
    when public.stage1_award_registry.canonical_name is distinct from excluded.canonical_name
      or public.stage1_award_registry.canonical_shared_award_id is distinct from excluded.canonical_shared_award_id
      or public.stage1_award_registry.canonical_slug is distinct from excluded.canonical_slug
      or public.stage1_award_registry.official_homepage is distinct from excluded.official_homepage
    then null
    else public.stage1_award_registry.fact_ledger_batch_id
  end,
  updated_at = now();

insert into public.stage1_award_members (
  shared_award_id,
  cohort_key,
  member_kind,
  reason
)
select
  registry.canonical_shared_award_id,
  registry.cohort_key,
  'canonical',
  'Canonical Stage 1 public record.'
from public.stage1_award_registry registry
on conflict (shared_award_id) do update
set
  cohort_key = excluded.cohort_key,
  member_kind = excluded.member_kind,
  reason = excluded.reason,
  updated_at = now()
where public.stage1_award_members.cohort_key is distinct from excluded.cohort_key
  or public.stage1_award_members.member_kind is distinct from excluded.member_kind
  or public.stage1_award_members.reason is distinct from excluded.reason;

insert into public.stage1_award_source_identity_rules (
  cohort_key,
  rule_key,
  url_pattern,
  title_pattern,
  reason
)
values (
  'marshall',
  'exclude_marshall_sherfield',
  '(?:^|/)marshall-sherfield(?:/|$)|/media/[0-9]+/msf_',
  'sherfield|postdoctoral|\mmsf\M',
  'Marshall Sherfield is a separate postdoctoral fellowship and must never supply Marshall Scholarship facts or updates.'
)
on conflict (cohort_key, rule_key) do update
set
  url_pattern = excluded.url_pattern,
  title_pattern = excluded.title_pattern,
  reason = excluded.reason,
  policy_version = excluded.policy_version,
  updated_at = now()
where public.stage1_award_source_identity_rules.url_pattern
    is distinct from excluded.url_pattern
  or public.stage1_award_source_identity_rules.title_pattern
    is distinct from excluded.title_pattern
  or public.stage1_award_source_identity_rules.reason
    is distinct from excluded.reason
  or public.stage1_award_source_identity_rules.policy_version
    is distinct from excluded.policy_version;

with aliases (cohort_key, search_key, reason) as (
  values
    ('rhodes_us', 'rhodes scholarships', 'Pluralized duplicate of the United States Rhodes Scholarship.'),
    ('fulbright_us_student', 'u.s. department of state - fulbright u.s. student program - english teaching assistantships (eta)', 'Fulbright ETA track retained beneath the U.S. Student Program.'),
    ('fulbright_us_student', 'u.s. department of state - fulbright u.s. student program - grants for research, study, & arts', 'Fulbright research, study, and arts track retained beneath the U.S. Student Program.'),
    ('schwarzman', 'schwarzman scholarship', 'Historical singular Schwarzman catalog name.'),
    ('knight_hennessy', 'knight-hennessy scholars program', 'Imported duplicate of the canonical Knight-Hennessy program.'),
    ('luce', 'henry luce foundation - scholars program for professional development in asia', 'Historical Luce Scholars catalog name.'),
    ('udall_undergraduate', 'morris k. udall and stewart l. udall scholarship', 'Formal-name Udall record retained beneath the populated operational record.'),
    ('gilman', 'gilman scholarship', 'Short-name duplicate of the Gilman International Scholarship.'),
    ('boren', 'boren awards for international study', 'Historical Boren program name.'),
    ('boren', 'boren scholarship/fellowship urgd/grad', 'Combined undergraduate/graduate Boren catalog name.'),
    ('boren', 'us national security education program (nsep) - boren fellowships', 'NSEP Boren Fellowship catalog record.'),
    ('cls', 'critical language scholarships program', 'Pluralized duplicate of the Critical Language Scholarship program.'),
    ('cls', 'critical languages scholarship', 'Historical pluralized CLS catalog name.'),
    ('cls', 'u.s. department of state - critical language scholarship (cls) program', 'Department of State CLS catalog record.'),
    ('nsf_grfp', 'national science foundation graduate research fellowship', 'Archived historical NSF GRFP record retained for evidence.'),
    ('ndseg', 'department of war national defense science and engineering grad fellowships', 'Historical NDSEG catalog record.'),
    ('smart', 'smart scholarship program', 'Short-name SMART catalog record.'),
    ('smart', 'u.s. department of defense (dod) - science, mathematics & research for transformation (smart) - scholarship for service program', 'Department of Defense descriptive SMART catalog record.'),
    ('gem', 'national gem consortium - master''s engineering and science fellowship', 'GEM master''s track retained beneath the canonical program.'),
    ('gem', 'national gem consortium - ph.d. engineering and science fellowship', 'GEM Ph.D. track retained beneath the canonical program.'),
    ('noaa_hollings', 'ernest f. hollings undergraduate scholarship (noaa)', 'Historical formal NOAA Hollings catalog name.'),
    ('noaa_hollings', 'hollings scholarship', 'Short-name duplicate of NOAA Hollings.'),
    ('soros', 'soros fellowship for new americans', 'Singular Soros catalog name.'),
    ('soros', 'soros fellowships for new americans', 'Pluralized Soros catalog name.'),
    ('gaither', 'carnegie junior fellowship', 'Historical name of the Gaither Junior Fellows program.')
)
insert into public.stage1_award_members (
  shared_award_id,
  cohort_key,
  member_kind,
  reason
)
select
  award.id,
  aliases.cohort_key,
  'alias',
  aliases.reason
from aliases
join public.shared_awards award on award.search_key = aliases.search_key
join public.stage1_award_registry registry
  on registry.cohort_key = aliases.cohort_key
where award.id <> registry.canonical_shared_award_id
on conflict (shared_award_id) do update
set
  cohort_key = excluded.cohort_key,
  member_kind = excluded.member_kind,
  reason = excluded.reason,
  updated_at = now()
where public.stage1_award_members.cohort_key is distinct from excluded.cohort_key
  or public.stage1_award_members.member_kind is distinct from excluded.member_kind
  or public.stage1_award_members.reason is distinct from excluded.reason;

with roles (source_role) as (
  values
    ('identity_home'),
    ('eligibility'),
    ('application_materials'),
    ('dates_cycle'),
    ('funding'),
    ('faq'),
    ('selection_interviews'),
    ('current_documents')
)
insert into public.stage1_award_source_manifest (cohort_key, source_role)
select registry.cohort_key, roles.source_role
from public.stage1_award_registry registry
cross join roles
on conflict (cohort_key, source_role) do nothing;

do $stage1_cohort_preflight$
declare
  v_registry_count integer;
  v_canonical_member_count integer;
  v_alias_member_count integer;
begin
  select count(*) into v_registry_count
  from public.stage1_award_registry;

  select count(*) into v_canonical_member_count
  from public.stage1_award_members
  where member_kind = 'canonical';

  select count(*) into v_alias_member_count
  from public.stage1_award_members
  where member_kind = 'alias';

  if v_registry_count <> 25
    or v_canonical_member_count <> 25
    or v_alias_member_count <> 25 then
    raise exception using
      errcode = '23514',
      message = format(
        'Stage 1 requires exactly 25 registry rows, 25 canonical members, and 25 retained aliases/tracks; found %s, %s, and %s.',
        v_registry_count,
        v_canonical_member_count,
        v_alias_member_count
      );
  end if;

  if exists (
    select 1
    from public.stage1_award_registry registry
    join public.stage1_award_members member
      on member.cohort_key = registry.cohort_key
      and member.member_kind = 'canonical'
    where member.shared_award_id <> registry.canonical_shared_award_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'A Stage 1 canonical member does not match its registry identity.';
  end if;
end;
$stage1_cohort_preflight$;

create or replace function public.stage1_publication_evidence_hash(p_evidence jsonb)
returns text
language plpgsql
stable
strict
set search_path = ''
as $$
declare
  v_digest text;
begin
  if pg_catalog.to_regprocedure('extensions.digest(bytea,text)') is not null then
    execute
      'select pg_catalog.encode(extensions.digest(pg_catalog.convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into v_digest
      using p_evidence::text;
  else
    execute
      'select pg_catalog.encode(public.digest(pg_catalog.convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into v_digest
      using p_evidence::text;
  end if;

  return v_digest;
end;
$$;

create or replace function public.stage1_manifest_evidence_complete(
  p_status text,
  p_evidence jsonb,
  p_policy_version text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    p_status in ('present', 'combined', 'not_published')
    and pg_catalog.jsonb_typeof(p_evidence) = 'object'
    and p_evidence ->> 'official' = 'true'
    and nullif(pg_catalog.btrim(p_evidence ->> 'source_url'), '') is not null
    and nullif(pg_catalog.btrim(p_evidence ->> 'supporting_text'), '') is not null
    and pg_catalog.jsonb_typeof(p_evidence -> 'source_bindings') = 'object'
    and pg_catalog.jsonb_typeof(p_evidence -> 'candidate_bindings') = 'object'
    and pg_catalog.jsonb_typeof(p_evidence -> 'fact_candidate_ids') = 'array'
    and (
      p_status = 'not_published'
      or pg_catalog.jsonb_array_length(p_evidence -> 'fact_candidate_ids') > 0
    )
    and coalesce(
      p_evidence ->> 'captured_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.+Z$',
      false
    )
    and coalesce(
      p_evidence ->> 'r2_verified_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.+Z$',
      false
    )
    and coalesce(
      p_evidence ->> 'local_verified_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.+Z$',
      false
    )
    and nullif(pg_catalog.btrim(p_evidence ->> 'cycle'), '') is not null
    and p_evidence ->> 'reconciliation_status' in ('passed', 'verified', 'not_applicable')
    and p_evidence ->> 'policy_version' = p_policy_version;
$$;

revoke all on function public.stage1_publication_evidence_hash(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.stage1_manifest_evidence_complete(text, jsonb, text)
  from public, anon, authenticated, service_role;

insert into public.stage1_publication_release_state (
  release_key,
  release_state,
  release_epoch,
  reason,
  policy_version,
  cohort_identity_version,
  cohort_identity_hash,
  activated_at
)
select
  'stage1-national-25',
  'pending',
  null,
  'Awaiting one verified 25-award release.',
  'stage1-publication-v1',
  'stage1-national-25-v1',
  public.stage1_publication_evidence_hash(pg_catalog.to_jsonb(identity_payload.value)),
  null
from (
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
  ) as value
  from public.stage1_award_registry registry
) identity_payload
on conflict (release_key) do nothing;

create or replace function public.invalidate_stage1_cohort_release(
  p_reason text,
  p_actor text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_release public.stage1_publication_release_state%rowtype;
  v_evidence jsonb;
  v_invalidated_at timestamptz := now();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  select * into v_release
  from public.stage1_publication_release_state release_state
  where release_state.release_key = 'stage1-national-25'
  for update;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'The authoritative Stage 1 cohort release row is missing.';
  end if;

  update public.stage1_award_registry registry
  set
    release_epoch = null,
    updated_at = v_invalidated_at
  where registry.release_epoch is not null;

  if v_release.release_state = 'verified_beta' or v_release.release_epoch is not null then
    v_evidence := pg_catalog.jsonb_build_object(
      'prior_release_epoch', v_release.release_epoch,
      'invalidated_at', v_invalidated_at,
      'reason', pg_catalog.btrim(p_reason)
    );

    update public.stage1_publication_release_state release_state
    set
      release_state = 'revalidation_pending',
      release_epoch = null,
      reason = pg_catalog.btrim(p_reason),
      activated_at = null,
      updated_at = v_invalidated_at
    where release_state.release_key = 'stage1-national-25';

    insert into public.stage1_publication_release_events (
      release_key,
      previous_state,
      next_state,
      release_epoch,
      reason,
      policy_version,
      cohort_identity_version,
      cohort_identity_hash,
      evidence_snapshot,
      evidence_hash,
      actor
    ) values (
      'stage1-national-25',
      v_release.release_state,
      'revalidation_pending',
      v_release.release_epoch,
      pg_catalog.btrim(p_reason),
      v_release.policy_version,
      v_release.cohort_identity_version,
      v_release.cohort_identity_hash,
      v_evidence,
      public.stage1_publication_evidence_hash(v_evidence),
      coalesce(nullif(pg_catalog.btrim(p_actor), ''), 'database-trigger')
    );
  end if;
end;
$$;

revoke all on function public.invalidate_stage1_cohort_release(text, text)
  from public, anon, authenticated, service_role;

create or replace function public.set_stage1_award_manifest_entry(
  p_cohort_key text,
  p_source_role text,
  p_manifest_status text,
  p_source_ids uuid[],
  p_evidence jsonb,
  p_checked_at timestamptz,
  p_policy_version text
)
returns public.stage1_award_source_manifest
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stage1_award_source_manifest%rowtype;
  v_source_ids uuid[] := coalesce(p_source_ids, '{}'::uuid[]);
begin
  if not exists (
    select 1
    from public.stage1_award_registry registry
    where registry.cohort_key = p_cohort_key
  ) then
    raise exception using errcode = '22023', message = 'Unknown Stage 1 cohort key.';
  end if;

  if p_manifest_status not in ('missing', 'present', 'combined', 'not_published') then
    raise exception using errcode = '22023', message = 'Invalid Stage 1 manifest status.';
  end if;

  if p_manifest_status = 'missing' then
    p_checked_at := null;
    v_source_ids := '{}'::uuid[];
    p_evidence := '{}'::jsonb;
  else
    if p_checked_at is null or p_checked_at < now() - interval '24 hours' then
      raise exception using
        errcode = '23514',
        message = 'Stage 1 manifest evidence must have been checked within 24 hours.';
    end if;

    if not public.stage1_manifest_evidence_complete(
      p_manifest_status,
      coalesce(p_evidence, '{}'::jsonb),
      p_policy_version
    ) then
      raise exception using
        errcode = '23514',
        message = 'Stage 1 manifest evidence is incomplete or its immutable hashes do not match.';
    end if;

    if (p_evidence ->> 'r2_verified_at')::timestamptz < now() - interval '24 hours'
      or (p_evidence ->> 'local_verified_at')::timestamptz < now() - interval '24 hours'
      or (p_evidence ->> 'r2_verified_at')::timestamptz > now() + interval '5 minutes'
      or (p_evidence ->> 'local_verified_at')::timestamptz > now() + interval '5 minutes' then
      raise exception using
        errcode = '23514',
        message = 'R2 and local-cache evidence verification must be current and not future-dated.';
    end if;
  end if;

  if p_manifest_status <> 'missing' and cardinality(v_source_ids) = 0 then
    raise exception using
      errcode = '23514',
      message = 'Every verified or not-published Stage 1 finding requires an official evidence source.';
  end if;

  if exists (
    select 1
    from unnest(v_source_ids) source_id
    left join public.shared_award_sources source on source.id = source_id
    left join public.shared_award_source_visual_snapshots snapshot
      on snapshot.shared_award_source_id = source.id
    left join public.stage1_award_members member
      on member.shared_award_id = source.shared_award_id
      and member.cohort_key = p_cohort_key
    where source.id is null
      or member.shared_award_id is null
      or source.admin_review_status <> 'open'
      or source.last_checked_at is null
      or source.last_checked_at < now() - interval '24 hours'
      or nullif(pg_catalog.btrim(source.last_error), '') is not null
      or exists (
        select 1
        from public.stage1_award_source_identity_rules identity_rule
        where identity_rule.cohort_key = p_cohort_key
          and (
            (
              identity_rule.url_pattern is not null
              and source.url ~* identity_rule.url_pattern
            )
            or (
              identity_rule.title_pattern is not null
              and concat_ws(' ', source.title, source.display_title) ~*
                identity_rule.title_pattern
            )
          )
      )
      or snapshot.shared_award_source_id is null
      or snapshot.latest_captured_at is null
      or snapshot.latest_captured_at < now() - interval '24 hours'
      or snapshot.latest_object_keys = '{}'::jsonb
      or snapshot.latest_hashes = '{}'::jsonb
      or p_evidence #>> array['source_bindings', source_id::text, 'source_url']
        is distinct from source.url
      or p_evidence #> array['source_bindings', source_id::text, 'object_keys']
        is distinct from snapshot.latest_object_keys
      or p_evidence #> array['source_bindings', source_id::text, 'hashes']
        is distinct from snapshot.latest_hashes
      or p_evidence #> array['source_bindings', source_id::text, 'r2_hashes']
        is distinct from snapshot.latest_hashes
      or p_evidence #> array['source_bindings', source_id::text, 'local_hashes']
        is distinct from snapshot.latest_hashes
      or (
        p_evidence #>> array['source_bindings', source_id::text, 'captured_at']
      )::timestamptz is distinct from snapshot.latest_captured_at
  ) then
    raise exception using
      errcode = '23514',
      message = 'Stage 1 sources require matching fresh database, R2, and local-cache snapshot identities.';
  end if;

  if p_source_role = 'identity_home' and p_manifest_status <> 'missing' then
    if p_manifest_status not in ('present', 'combined')
      or cardinality(v_source_ids) <> 1
      or not exists (
        select 1
        from public.stage1_award_registry registry
        join public.shared_award_sources source
          on source.id = v_source_ids[1]
        where registry.cohort_key = p_cohort_key
          and source.url = registry.official_homepage
          and p_evidence ->> 'source_url' = registry.official_homepage
          and p_evidence #>> array[
            'source_bindings', source.id::text, 'source_url'
          ] = registry.official_homepage
      ) then
      raise exception using
        errcode = '23514',
        message = 'The identity_home manifest must bind exactly one reviewed source whose URL exactly matches the Stage 1 registry homepage.';
    end if;
  end if;

  if p_manifest_status in ('present', 'combined')
    and pg_catalog.jsonb_array_length(p_evidence -> 'fact_candidate_ids') = 0 then
    raise exception using
      errcode = '23514',
      message = 'Published Stage 1 source roles require selected fact-candidate evidence.';
  end if;

  if exists (
    select 1
    from (
      select case
        when raw.candidate_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then raw.candidate_id_text::uuid
        else null
      end as candidate_id
      from pg_catalog.jsonb_array_elements_text(
        p_evidence -> 'fact_candidate_ids'
      ) raw(candidate_id_text)
    ) requested
    left join public.shared_award_fact_candidates candidate
      on candidate.id = requested.candidate_id
    left join public.shared_award_sources candidate_source
      on candidate_source.id = candidate.shared_award_source_id
    left join public.stage1_award_members member
      on member.shared_award_id = candidate.shared_award_id
      and member.cohort_key = p_cohort_key
    where requested.candidate_id is null
      or candidate.id is null
      or member.shared_award_id is null
      or candidate.candidate_status <> 'selected'
      or candidate.shared_award_source_id is null
      or not (candidate.shared_award_source_id = any(v_source_ids))
      or candidate_source.id is null
      or candidate_source.shared_award_id <> candidate.shared_award_id
      or p_evidence #>> array[
        'candidate_bindings', candidate.id::text, 'source_id'
      ] is distinct from candidate.shared_award_source_id::text
      or p_evidence #>> array[
        'candidate_bindings', candidate.id::text, 'candidate_source_role'
      ] is distinct from candidate.source_role
      or p_evidence #>> array[
        'candidate_bindings', candidate.id::text, 'source_role'
      ] is distinct from p_source_role
      or p_evidence #>> array[
        'candidate_bindings', candidate.id::text, 'field_name'
      ] is distinct from candidate.field_name
      or p_evidence #> array[
        'candidate_bindings', candidate.id::text, 'normalized_value'
      ] is distinct from candidate.normalized_value
      or p_evidence #>> array[
        'candidate_bindings', candidate.id::text, 'evidence_quote'
      ] is distinct from candidate.evidence_quote
      or p_evidence #>> array[
        'candidate_bindings', candidate.id::text, 'evidence_location'
      ] is distinct from candidate.evidence_location
      or p_evidence #>> array[
        'candidate_bindings', candidate.id::text, 'intake_value_sha256'
      ] is distinct from candidate.intake_value_sha256
  ) then
    raise exception using
      errcode = '23514',
      message = 'Stage 1 fact evidence must reference selected candidates from the bound official sources.';
  end if;

  insert into public.stage1_award_source_manifest (
    cohort_key,
    source_role,
    manifest_status,
    source_ids,
    evidence,
    checked_at,
    policy_version,
    updated_at
  )
  values (
    p_cohort_key,
    p_source_role,
    p_manifest_status,
    v_source_ids,
    coalesce(p_evidence, '{}'::jsonb),
    p_checked_at,
    p_policy_version,
    now()
  )
  on conflict (cohort_key, source_role) do update
  set
    manifest_status = excluded.manifest_status,
    source_ids = excluded.source_ids,
    evidence = excluded.evidence,
    checked_at = excluded.checked_at,
    policy_version = excluded.policy_version,
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.set_stage1_award_manifest_entry(
  text, text, text, uuid[], jsonb, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.set_stage1_award_manifest_entry(
  text, text, text, uuid[], jsonb, timestamptz, text
) to service_role;

create or replace function public.transition_stage1_award_publication(
  p_cohort_key text,
  p_next_state text,
  p_reason text,
  p_policy_version text,
  p_actor text
)
returns public.stage1_award_registry
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_registry public.stage1_award_registry%rowtype;
  v_previous_state text;
  v_evidence jsonb;
  v_checked_at timestamptz;
  v_reconciliation jsonb;
  v_page_audit jsonb;
  v_ledger_batch_id uuid;
  v_public_fact_count integer;
  v_ledger_count integer;
begin
  if p_next_state not in ('pending', 'verified_beta', 'revalidation_pending', 'suspended') then
    raise exception using errcode = '22023', message = 'Invalid Stage 1 publication state.';
  end if;
  if nullif(pg_catalog.btrim(p_reason), '') is null
    or nullif(pg_catalog.btrim(p_policy_version), '') is null
    or nullif(pg_catalog.btrim(p_actor), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Publication transitions require a reason, policy version, and actor.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  select * into v_registry
  from public.stage1_award_registry registry
  where registry.cohort_key = p_cohort_key
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'Unknown Stage 1 cohort key.';
  end if;

  v_previous_state := v_registry.publication_state;

  select
    pg_catalog.jsonb_object_agg(
      manifest.source_role,
      pg_catalog.jsonb_build_object(
        'status', manifest.manifest_status,
        'source_ids', manifest.source_ids,
        'evidence', manifest.evidence,
        'checked_at', manifest.checked_at,
        'policy_version', manifest.policy_version
      )
      order by manifest.source_role
    ),
    min(manifest.checked_at)
  into v_evidence, v_checked_at
  from public.stage1_award_source_manifest manifest
  where manifest.cohort_key = p_cohort_key;

  if p_next_state = 'verified_beta' then
    if v_registry.canonical_shared_award_id is null
      or not exists (
        select 1
        from public.shared_awards award
        where award.id = v_registry.canonical_shared_award_id
          and award.status = 'active'
          and award.name = v_registry.canonical_name
          and award.slug = v_registry.canonical_slug
          and award.official_homepage = v_registry.official_homepage
      ) then
      raise exception using
        errcode = '23514',
        message = 'The canonical Stage 1 award identity is missing, inactive, or differs from the reviewed registry.';
    end if;

    if (
      select count(*)
      from public.stage1_award_source_manifest manifest
      where manifest.cohort_key = p_cohort_key
        and manifest.manifest_status in ('present', 'combined', 'not_published')
        and manifest.checked_at >= now() - interval '24 hours'
        and (manifest.evidence ->> 'r2_verified_at')::timestamptz
          between now() - interval '24 hours' and now() + interval '5 minutes'
        and (manifest.evidence ->> 'local_verified_at')::timestamptz
          between now() - interval '24 hours' and now() + interval '5 minutes'
        and manifest.policy_version = p_policy_version
        and public.stage1_manifest_evidence_complete(
          manifest.manifest_status,
          manifest.evidence,
          p_policy_version
        )
    ) <> 8 then
      raise exception using
        errcode = '23514',
        message = 'All eight Stage 1 source roles require fresh, complete, matching evidence.';
    end if;

    if not exists (
      select 1
      from public.stage1_award_source_manifest manifest
      join public.shared_award_sources source
        on cardinality(manifest.source_ids) = 1
        and source.id = manifest.source_ids[1]
      where manifest.cohort_key = p_cohort_key
        and manifest.source_role = 'identity_home'
        and manifest.manifest_status in ('present', 'combined')
        and source.url = v_registry.official_homepage
        and manifest.evidence ->> 'source_url' = v_registry.official_homepage
        and manifest.evidence #>> array[
          'source_bindings', source.id::text, 'source_url'
        ] = v_registry.official_homepage
    ) then
      raise exception using
        errcode = '23514',
        message = 'The identity_home manifest does not exactly bind the reviewed registry homepage.';
    end if;

    if exists (
      select 1
      from public.stage1_award_source_manifest manifest
      cross join unnest(manifest.source_ids) source_id
      left join public.shared_award_sources source on source.id = source_id
      left join public.shared_award_source_visual_snapshots snapshot
        on snapshot.shared_award_source_id = source.id
      left join public.stage1_award_members member
        on member.shared_award_id = source.shared_award_id
        and member.cohort_key = p_cohort_key
      where manifest.cohort_key = p_cohort_key
        and (
          source.id is null
          or member.shared_award_id is null
          or source.admin_review_status <> 'open'
          or source.last_checked_at is null
          or source.last_checked_at < now() - interval '24 hours'
          or nullif(pg_catalog.btrim(source.last_error), '') is not null
          or exists (
            select 1
            from public.stage1_award_source_identity_rules identity_rule
            where identity_rule.cohort_key = p_cohort_key
              and (
                (
                  identity_rule.url_pattern is not null
                  and source.url ~* identity_rule.url_pattern
                )
                or (
                  identity_rule.title_pattern is not null
                  and concat_ws(' ', source.title, source.display_title) ~*
                    identity_rule.title_pattern
                )
              )
          )
          or snapshot.shared_award_source_id is null
          or snapshot.latest_captured_at is null
          or snapshot.latest_captured_at < now() - interval '24 hours'
          or snapshot.latest_object_keys = '{}'::jsonb
          or snapshot.latest_hashes = '{}'::jsonb
          or manifest.evidence #>> array['source_bindings', source_id::text, 'source_url']
            is distinct from source.url
          or manifest.evidence #> array['source_bindings', source_id::text, 'object_keys']
            is distinct from snapshot.latest_object_keys
          or manifest.evidence #> array['source_bindings', source_id::text, 'hashes']
            is distinct from snapshot.latest_hashes
          or manifest.evidence #> array['source_bindings', source_id::text, 'r2_hashes']
            is distinct from snapshot.latest_hashes
          or manifest.evidence #> array['source_bindings', source_id::text, 'local_hashes']
            is distinct from snapshot.latest_hashes
          or (
            manifest.evidence #>> array['source_bindings', source_id::text, 'captured_at']
          )::timestamptz is distinct from snapshot.latest_captured_at
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'A Stage 1 manifest source is stale, failed, closed, or belongs to another award.';
    end if;

    if exists (
      select 1
      from public.stage1_award_source_manifest manifest
      cross join lateral (
        select case
          when raw.candidate_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then raw.candidate_id_text::uuid
          else null
        end as candidate_id
        from pg_catalog.jsonb_array_elements_text(
          manifest.evidence -> 'fact_candidate_ids'
        ) raw(candidate_id_text)
      ) requested
      left join public.shared_award_fact_candidates candidate
        on candidate.id = requested.candidate_id
      left join public.shared_award_sources candidate_source
        on candidate_source.id = candidate.shared_award_source_id
      left join public.stage1_award_members candidate_member
        on candidate_member.shared_award_id = candidate.shared_award_id
        and candidate_member.cohort_key = p_cohort_key
      where manifest.cohort_key = p_cohort_key
        and manifest.manifest_status in ('present', 'combined')
        and (
          requested.candidate_id is null
          or candidate.id is null
          or candidate.candidate_status <> 'selected'
          or candidate_member.shared_award_id is null
          or candidate.shared_award_source_id is null
          or not (candidate.shared_award_source_id = any(manifest.source_ids))
          or candidate_source.id is null
          or candidate_source.shared_award_id <> candidate.shared_award_id
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'source_id'
          ] is distinct from candidate.shared_award_source_id::text
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'candidate_source_role'
          ] is distinct from candidate.source_role
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'source_role'
          ] is distinct from manifest.source_role
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'field_name'
          ] is distinct from candidate.field_name
          or manifest.evidence #> array[
            'candidate_bindings', candidate.id::text, 'normalized_value'
          ] is distinct from candidate.normalized_value
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'evidence_quote'
          ] is distinct from candidate.evidence_quote
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'evidence_location'
          ] is distinct from candidate.evidence_location
          or manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'intake_value_sha256'
          ] is distinct from candidate.intake_value_sha256
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'A Stage 1 candidate no longer matches its reviewed role, wording, location, intake hash, or source.';
    end if;

    if exists (
      select 1
      from public.manual_quarantine_registry quarantine
      left join public.shared_award_sources quarantine_source
        on quarantine_source.id = quarantine.shared_award_source_id
      join public.stage1_award_members member
        on member.shared_award_id = coalesce(
          quarantine.shared_award_id,
          quarantine_source.shared_award_id
        )
      where member.cohort_key = p_cohort_key
        and quarantine.classification = 'actionable_quarantine'
        and quarantine.status in ('quarantined', 'in_review')
    ) then
      raise exception using
        errcode = '23514',
        message = 'Unresolved manual quarantine blocks Stage 1 publication.';
    end if;

    if exists (
      select 1
      from public.shared_award_page_audits audit
      join public.stage1_award_members member
        on member.shared_award_id = audit.shared_award_id
      where member.cohort_key = p_cohort_key
        and audit.resolved_at is null
        and (
          audit.audit_status in ('failed', 'needs_review')
          or audit.severity = 'critical'
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'An unresolved critical or failed page audit blocks Stage 1 publication.';
    end if;

    select to_jsonb(queue)
    into v_reconciliation
    from public.shared_award_reconciliation_queue queue
    where queue.shared_award_id = v_registry.canonical_shared_award_id
    order by queue.created_at desc, queue.id desc
    limit 1;

    if v_reconciliation is null
      or v_reconciliation ->> 'status' <> 'succeeded'
      or v_reconciliation ->> 'completed_at' is null
      or (v_reconciliation ->> 'completed_at')::timestamptz < now() - interval '24 hours'
      or pg_catalog.jsonb_typeof(v_reconciliation -> 'source_ids') <> 'array'
      or pg_catalog.jsonb_typeof(v_reconciliation -> 'candidate_ids') <> 'array' then
      raise exception using
        errcode = '23514',
        message = 'A fresh successful canonical reconciliation with exact source and candidate identities is required.';
    end if;

    if exists (
      select 1
      from public.stage1_award_source_manifest manifest
      cross join unnest(manifest.source_ids) source_id
      where manifest.cohort_key = p_cohort_key
        and not ((v_reconciliation -> 'source_ids') ? source_id::text)
    ) or exists (
      select 1
      from (
        select case
          when raw.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then raw.value::uuid
          else null
        end as source_id
        from pg_catalog.jsonb_array_elements_text(
          v_reconciliation -> 'source_ids'
        ) raw(value)
      ) reconciled
      left join public.shared_award_sources source on source.id = reconciled.source_id
      left join public.stage1_award_members member
        on member.shared_award_id = source.shared_award_id
        and member.cohort_key = p_cohort_key
      where reconciled.source_id is null
        or source.id is null
        or member.shared_award_id is null
        or not exists (
          select 1
          from public.stage1_award_source_manifest manifest
          where manifest.cohort_key = p_cohort_key
            and reconciled.source_id = any(manifest.source_ids)
        )
    ) or exists (
      select 1
      from public.stage1_award_source_manifest manifest
      cross join lateral pg_catalog.jsonb_array_elements_text(
        manifest.evidence -> 'fact_candidate_ids'
      ) manifest_candidate(value)
      where manifest.cohort_key = p_cohort_key
        and not ((v_reconciliation -> 'candidate_ids') ? manifest_candidate.value)
    ) or exists (
      select 1
      from (
        select case
          when raw.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then raw.value::uuid
          else null
        end as candidate_id
        from pg_catalog.jsonb_array_elements_text(
          v_reconciliation -> 'candidate_ids'
        ) raw(value)
      ) reconciled
      left join public.shared_award_fact_candidates candidate
        on candidate.id = reconciled.candidate_id
      left join public.shared_award_sources source
        on source.id = candidate.shared_award_source_id
      left join public.stage1_award_members member
        on member.shared_award_id = candidate.shared_award_id
        and member.cohort_key = p_cohort_key
      where reconciled.candidate_id is null
        or candidate.id is null
        or candidate.candidate_status <> 'selected'
        or member.shared_award_id is null
        or source.id is null
        or source.shared_award_id <> candidate.shared_award_id
        or not ((v_reconciliation -> 'source_ids') ? source.id::text)
        or not exists (
          select 1
          from public.stage1_award_source_manifest manifest
          where manifest.cohort_key = p_cohort_key
            and source.id = any(manifest.source_ids)
            and (manifest.evidence -> 'fact_candidate_ids') ? candidate.id::text
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Canonical reconciliation identities must exactly equal the reviewed manifest sources and candidates.';
    end if;

    select to_jsonb(audit)
    into v_page_audit
    from public.shared_award_page_audits audit
    where audit.shared_award_id = v_registry.canonical_shared_award_id
    order by audit.created_at desc, audit.id desc
    limit 1;

    if v_page_audit is null
      or v_page_audit ->> 'audit_status' <> 'passed'
      or (v_page_audit ->> 'created_at')::timestamptz < now() - interval '24 hours'
      or pg_catalog.jsonb_typeof(v_page_audit -> 'public_page_snapshot') <> 'object' then
      raise exception using
        errcode = '23514',
        message = 'A fresh passed canonical page audit with an exact public-page snapshot is required.';
    end if;

    select count(*)
    into v_public_fact_count
    from public.shared_awards award
    cross join lateral pg_catalog.jsonb_each(award.public_facts) fact
    where award.id = v_registry.canonical_shared_award_id
      and fact.key in (
        'overview',
        'deadline',
        'opening_date',
        'award_amounts',
        'eligibility',
        'requirements',
        'application_materials',
        'how_to_apply',
        'important_dates',
        'documents',
        'contacts',
        'academic_levels',
        'disciplines',
        'citizenship',
        'confidence'
      )
      and fact.value not in (
        'null'::jsonb,
        '""'::jsonb,
        '[]'::jsonb,
        '{}'::jsonb
      );

    if v_public_fact_count = 0 or not exists (
      select 1
      from public.shared_awards award
      where award.id = v_registry.canonical_shared_award_id
        and award.public_facts -> 'overview' not in (
          'null'::jsonb,
          '""'::jsonb,
          '[]'::jsonb,
          '{}'::jsonb
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Stage 1 publication requires a reconciled, evidence-bound public overview.';
    end if;

    v_ledger_batch_id := gen_random_uuid();

    insert into public.stage1_award_fact_publication_ledger (
      verification_batch_id,
      cohort_key,
      field_name,
      materialization_id,
      candidate_id,
      source_id,
      source_url,
      source_role,
      contributing_candidate_ids,
      contributing_source_ids,
      supporting_text,
      source_snapshot_hashes,
      source_captured_at,
      reconciliation_id,
      page_audit_id,
      normalized_value,
      public_value,
      cycle,
      policy_version,
      evidence_hash
    )
    select distinct on (fact.key)
      v_ledger_batch_id,
      p_cohort_key,
      fact.key,
      materialization.id,
      candidate.id,
      candidate.shared_award_source_id,
      source.url,
      manifest.source_role,
      materialization.candidate_ids,
      materialization.source_ids,
      manifest.evidence #>> array[
        'candidate_bindings', candidate.id::text, 'evidence_quote'
      ],
      manifest.evidence #> array[
        'source_bindings',
        candidate.shared_award_source_id::text,
        'hashes'
      ],
      (
        manifest.evidence #>> array[
          'source_bindings',
          candidate.shared_award_source_id::text,
          'captured_at'
        ]
      )::timestamptz,
      (v_reconciliation ->> 'id')::uuid,
      (v_page_audit ->> 'id')::uuid,
      materialization.public_value,
      fact.value,
      manifest.evidence ->> 'cycle',
      p_policy_version,
      public.stage1_publication_evidence_hash(
        pg_catalog.jsonb_build_object(
          'cohort_key', p_cohort_key,
          'field_name', fact.key,
          'materialization_id', materialization.id,
          'candidate_id', candidate.id,
          'source_id', candidate.shared_award_source_id,
          'source_url', source.url,
          'source_role', manifest.source_role,
          'contributing_candidate_ids', materialization.candidate_ids,
          'contributing_source_ids', materialization.source_ids,
          'supporting_text', manifest.evidence #>> array[
            'candidate_bindings', candidate.id::text, 'evidence_quote'
          ],
          'source_snapshot_hashes', manifest.evidence #> array[
            'source_bindings',
            candidate.shared_award_source_id::text,
            'hashes'
          ],
          'source_captured_at', manifest.evidence #>> array[
            'source_bindings',
            candidate.shared_award_source_id::text,
            'captured_at'
          ],
          'reconciliation_id', v_reconciliation ->> 'id',
          'page_audit_id', v_page_audit ->> 'id',
          'normalized_value', materialization.public_value,
          'public_value', fact.value,
          'cycle', manifest.evidence ->> 'cycle',
          'policy_version', p_policy_version
        )
      )
    from public.shared_awards award
    cross join lateral pg_catalog.jsonb_each(award.public_facts) fact
    join public.stage1_award_reconciled_fact_evidence materialization
      on materialization.shared_award_id = v_registry.canonical_shared_award_id
      and materialization.reconciliation_id = (v_reconciliation ->> 'id')::uuid
      and materialization.field_name = fact.key
      and materialization.public_value = fact.value
      and materialization.materialized_at >= now() - interval '24 hours'
      and materialization.evidence_hash =
        public.stage1_publication_evidence_hash(materialization.evidence)
    join public.shared_award_fact_candidates candidate
      on candidate.id = materialization.candidate_ids[1]
      and candidate.candidate_status = 'selected'
      and candidate.shared_award_source_id is not null
      and candidate.id = any(materialization.candidate_ids)
      and candidate.shared_award_source_id = any(materialization.source_ids)
      and (v_reconciliation -> 'candidate_ids') ? candidate.id::text
      and (v_reconciliation -> 'source_ids') ? candidate.shared_award_source_id::text
      and v_page_audit -> 'public_page_snapshot' -> fact.key = fact.value
    join public.stage1_award_source_manifest manifest
      on manifest.cohort_key = p_cohort_key
      and candidate.shared_award_source_id = any(manifest.source_ids)
      and (manifest.evidence -> 'fact_candidate_ids') ? candidate.id::text
    join public.shared_award_sources source
      on source.id = candidate.shared_award_source_id
    where award.id = v_registry.canonical_shared_award_id
      and fact.key in (
        'overview',
        'deadline',
        'opening_date',
        'award_amounts',
        'eligibility',
        'requirements',
        'application_materials',
        'how_to_apply',
        'important_dates',
        'documents',
        'contacts',
        'academic_levels',
        'disciplines',
        'citizenship',
        'confidence'
      )
      and fact.value not in (
        'null'::jsonb,
        '""'::jsonb,
        '[]'::jsonb,
        '{}'::jsonb
      )
      and materialization.evidence ->> 'award_id'
        = v_registry.canonical_shared_award_id::text
      and materialization.evidence ->> 'reconciliation_id'
        = (v_reconciliation ->> 'id')
      and materialization.evidence ->> 'field_name' = fact.key
      and materialization.evidence -> 'public_value' = fact.value
      and materialization.evidence -> 'candidate_ids'
        = pg_catalog.to_jsonb(materialization.candidate_ids)
      and materialization.evidence -> 'source_ids'
        = pg_catalog.to_jsonb(materialization.source_ids)
      and not exists (
        select 1
        from unnest(materialization.candidate_ids) contributor_id
        left join public.shared_award_fact_candidates contributor
          on contributor.id = contributor_id
        left join public.shared_award_sources contributor_source
          on contributor_source.id = contributor.shared_award_source_id
        left join public.stage1_award_members contributor_member
          on contributor_member.shared_award_id = contributor.shared_award_id
          and contributor_member.cohort_key = p_cohort_key
        where contributor.id is null
          or contributor.candidate_status <> 'selected'
          or contributor_member.shared_award_id is null
          or contributor_source.id is null
          or contributor_source.shared_award_id <> contributor.shared_award_id
          or not (contributor_source.id = any(materialization.source_ids))
          or not ((v_reconciliation -> 'candidate_ids') ? contributor.id::text)
          or not ((v_reconciliation -> 'source_ids') ? contributor_source.id::text)
          or materialization.evidence #>> array[
            'candidate_bindings', contributor.id::text, 'source_id'
          ] is distinct from contributor.shared_award_source_id::text
          or materialization.evidence #>> array[
            'candidate_bindings', contributor.id::text, 'field_name'
          ] is distinct from contributor.field_name
          or materialization.evidence #> array[
            'candidate_bindings', contributor.id::text, 'normalized_value'
          ] is distinct from contributor.normalized_value
          or materialization.evidence #>> array[
            'candidate_bindings', contributor.id::text, 'evidence_quote'
          ] is distinct from contributor.evidence_quote
          or materialization.evidence #>> array[
            'candidate_bindings', contributor.id::text, 'evidence_location'
          ] is distinct from contributor.evidence_location
          or materialization.evidence #>> array[
            'candidate_bindings', contributor.id::text, 'intake_value_sha256'
          ] is distinct from contributor.intake_value_sha256
      )
    order by
      fact.key,
      materialization.materialized_at desc,
      materialization.id desc;

    select count(*) into v_ledger_count
    from public.stage1_award_fact_publication_ledger ledger
    where ledger.verification_batch_id = v_ledger_batch_id;

    if v_ledger_count <> v_public_fact_count then
      raise exception using
        errcode = '23514',
        message = format(
          'Only %s of %s published fact fields have exact selected-candidate evidence.',
          v_ledger_count,
          v_public_fact_count
        );
    end if;
  end if;

  if p_next_state = 'verified_beta' then
    v_evidence := pg_catalog.jsonb_build_object(
      'source_manifest', coalesce(v_evidence, '{}'::jsonb),
      'reconciliation', v_reconciliation,
      'page_audit', v_page_audit,
      'fact_ledger_batch_id', v_ledger_batch_id,
      'evaluated_at', now()
    );
  end if;

  update public.stage1_award_registry registry
  set
    publication_state = p_next_state,
    state_reason = pg_catalog.btrim(p_reason),
    policy_version = p_policy_version,
    fact_ledger_batch_id = case
      when p_next_state = 'verified_beta' then v_ledger_batch_id
      else registry.fact_ledger_batch_id
    end,
    release_epoch = null,
    evidence_checked_at = case
      when p_next_state = 'verified_beta' then v_checked_at
      else registry.evidence_checked_at
    end,
    last_verified_at = case
      when p_next_state = 'verified_beta' then now()
      else registry.last_verified_at
    end,
    updated_at = now()
  where registry.cohort_key = p_cohort_key
  returning * into v_registry;

  perform public.invalidate_stage1_cohort_release(
    'A Stage 1 award publication state changed; the 25-award release requires a new atomic activation.',
    p_actor
  );

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
  values (
    p_cohort_key,
    v_previous_state,
    p_next_state,
    pg_catalog.btrim(p_reason),
    p_policy_version,
    coalesce(v_evidence, '{}'::jsonb),
    public.stage1_publication_evidence_hash(coalesce(v_evidence, '{}'::jsonb)),
    pg_catalog.btrim(p_actor)
  );

  return v_registry;
end;
$$;

revoke all on function public.transition_stage1_award_publication(
  text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.transition_stage1_award_publication(
  text, text, text, text, text
) to service_role;

create or replace function public.stage1_effective_publication_reason(
  p_cohort_key text,
  p_evaluated_at timestamptz default now()
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_registry public.stage1_award_registry%rowtype;
  v_latest_reconciliation public.shared_award_reconciliation_queue%rowtype;
  v_latest_audit public.shared_award_page_audits%rowtype;
  v_public_fact_count integer;
  v_ledger_count integer;
begin
  select * into v_registry
  from public.stage1_award_registry registry
  where registry.cohort_key = p_cohort_key;

  if not found then return 'registry_missing'; end if;
  if v_registry.publication_state <> 'verified_beta' then
    return 'state_' || v_registry.publication_state;
  end if;
  if v_registry.policy_version <> 'stage1-publication-v1' then
    return 'policy_version_mismatch';
  end if;
  if v_registry.evidence_checked_at is null
    or v_registry.last_verified_at is null
    or v_registry.evidence_checked_at < p_evaluated_at - interval '24 hours'
    or v_registry.last_verified_at < p_evaluated_at - interval '24 hours'
    or v_registry.evidence_checked_at > p_evaluated_at + interval '5 minutes'
    or v_registry.last_verified_at > p_evaluated_at + interval '5 minutes' then
    return 'registry_evidence_stale';
  end if;
  if not exists (
    select 1
    from public.shared_awards award
    where award.id = v_registry.canonical_shared_award_id
      and award.status = 'active'
      and award.name = v_registry.canonical_name
      and award.slug = v_registry.canonical_slug
      and award.official_homepage = v_registry.official_homepage
  ) then
    return 'canonical_award_identity_changed_or_inactive';
  end if;

  if (
    select count(*)
    from public.stage1_award_source_manifest manifest
    where manifest.cohort_key = p_cohort_key
      and manifest.checked_at >= p_evaluated_at - interval '24 hours'
      and manifest.checked_at <= p_evaluated_at + interval '5 minutes'
      and (manifest.evidence ->> 'r2_verified_at')::timestamptz
        between p_evaluated_at - interval '24 hours'
          and p_evaluated_at + interval '5 minutes'
      and (manifest.evidence ->> 'local_verified_at')::timestamptz
        between p_evaluated_at - interval '24 hours'
          and p_evaluated_at + interval '5 minutes'
      and manifest.policy_version = v_registry.policy_version
      and public.stage1_manifest_evidence_complete(
        manifest.manifest_status,
        manifest.evidence,
        v_registry.policy_version
      )
  ) <> 8 then
    return 'source_manifest_incomplete_or_stale';
  end if;

  if not exists (
    select 1
    from public.stage1_award_source_manifest manifest
    join public.shared_award_sources source
      on cardinality(manifest.source_ids) = 1
      and source.id = manifest.source_ids[1]
    where manifest.cohort_key = p_cohort_key
      and manifest.source_role = 'identity_home'
      and manifest.manifest_status in ('present', 'combined')
      and source.url = v_registry.official_homepage
      and manifest.evidence ->> 'source_url' = v_registry.official_homepage
      and manifest.evidence #>> array[
        'source_bindings', source.id::text, 'source_url'
      ] = v_registry.official_homepage
  ) then
    return 'identity_home_not_allowlisted';
  end if;

  if exists (
    select 1
    from public.stage1_award_source_manifest manifest
    cross join unnest(manifest.source_ids) source_id
    left join public.shared_award_sources source on source.id = source_id
    left join public.shared_award_source_visual_snapshots snapshot
      on snapshot.shared_award_source_id = source.id
    left join public.stage1_award_members member
      on member.shared_award_id = source.shared_award_id
      and member.cohort_key = p_cohort_key
    where manifest.cohort_key = p_cohort_key
      and (
        source.id is null
        or member.shared_award_id is null
        or source.admin_review_status <> 'open'
        or source.last_checked_at is null
        or source.last_checked_at < p_evaluated_at - interval '24 hours'
        or source.last_checked_at > p_evaluated_at + interval '5 minutes'
        or nullif(pg_catalog.btrim(source.last_error), '') is not null
        or exists (
          select 1
          from public.stage1_award_source_identity_rules identity_rule
          where identity_rule.cohort_key = p_cohort_key
            and (
              (
                identity_rule.url_pattern is not null
                and source.url ~* identity_rule.url_pattern
              )
              or (
                identity_rule.title_pattern is not null
                and concat_ws(' ', source.title, source.display_title) ~*
                  identity_rule.title_pattern
              )
            )
        )
        or snapshot.shared_award_source_id is null
        or snapshot.latest_captured_at is null
        or snapshot.latest_captured_at < p_evaluated_at - interval '24 hours'
        or snapshot.latest_captured_at > p_evaluated_at + interval '5 minutes'
        or snapshot.latest_object_keys = '{}'::jsonb
        or snapshot.latest_hashes = '{}'::jsonb
        or manifest.evidence #>> array['source_bindings', source_id::text, 'source_url']
          is distinct from source.url
        or manifest.evidence #> array['source_bindings', source_id::text, 'object_keys']
          is distinct from snapshot.latest_object_keys
        or manifest.evidence #> array['source_bindings', source_id::text, 'hashes']
          is distinct from snapshot.latest_hashes
        or manifest.evidence #> array['source_bindings', source_id::text, 'r2_hashes']
          is distinct from snapshot.latest_hashes
        or manifest.evidence #> array['source_bindings', source_id::text, 'local_hashes']
          is distinct from snapshot.latest_hashes
        or (
          manifest.evidence #>> array['source_bindings', source_id::text, 'captured_at']
        )::timestamptz is distinct from snapshot.latest_captured_at
      )
  ) then
    return 'source_or_snapshot_identity_invalid';
  end if;

  if exists (
    select 1
    from public.stage1_award_source_manifest manifest
    cross join lateral (
      select case
        when raw.candidate_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then raw.candidate_id_text::uuid
        else null
      end as candidate_id
      from pg_catalog.jsonb_array_elements_text(
        manifest.evidence -> 'fact_candidate_ids'
      ) raw(candidate_id_text)
    ) requested
    left join public.shared_award_fact_candidates candidate
      on candidate.id = requested.candidate_id
    left join public.shared_award_sources candidate_source
      on candidate_source.id = candidate.shared_award_source_id
    left join public.stage1_award_members candidate_member
      on candidate_member.shared_award_id = candidate.shared_award_id
      and candidate_member.cohort_key = p_cohort_key
    where manifest.cohort_key = p_cohort_key
      and manifest.manifest_status in ('present', 'combined')
      and (
        requested.candidate_id is null
        or candidate.id is null
        or candidate.candidate_status <> 'selected'
        or candidate_member.shared_award_id is null
        or candidate.shared_award_source_id is null
        or not (candidate.shared_award_source_id = any(manifest.source_ids))
        or candidate_source.id is null
        or candidate_source.shared_award_id <> candidate.shared_award_id
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'source_id'
        ] is distinct from candidate.shared_award_source_id::text
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'candidate_source_role'
        ] is distinct from candidate.source_role
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'source_role'
        ] is distinct from manifest.source_role
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'field_name'
        ] is distinct from candidate.field_name
        or manifest.evidence #> array[
          'candidate_bindings', candidate.id::text, 'normalized_value'
        ] is distinct from candidate.normalized_value
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'evidence_quote'
        ] is distinct from candidate.evidence_quote
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'evidence_location'
        ] is distinct from candidate.evidence_location
        or manifest.evidence #>> array[
          'candidate_bindings', candidate.id::text, 'intake_value_sha256'
        ] is distinct from candidate.intake_value_sha256
      )
  ) then
    return 'fact_candidate_binding_invalid';
  end if;

  if exists (
    select 1
    from public.manual_quarantine_registry quarantine
    left join public.shared_award_sources quarantine_source
      on quarantine_source.id = quarantine.shared_award_source_id
    join public.stage1_award_members member
      on member.shared_award_id = coalesce(
        quarantine.shared_award_id,
        quarantine_source.shared_award_id
      )
    where member.cohort_key = p_cohort_key
      and quarantine.classification = 'actionable_quarantine'
      and quarantine.status in ('quarantined', 'in_review')
  ) then
    return 'actionable_quarantine_open';
  end if;

  if exists (
    select 1
    from public.shared_award_page_audits audit
    join public.stage1_award_members member
      on member.shared_award_id = audit.shared_award_id
    where member.cohort_key = p_cohort_key
      and audit.resolved_at is null
      and (
        audit.audit_status in ('failed', 'needs_review')
        or audit.severity = 'critical'
      )
  ) then
    return 'page_audit_failure_open';
  end if;

  select * into v_latest_reconciliation
  from public.shared_award_reconciliation_queue queue
  where queue.shared_award_id = v_registry.canonical_shared_award_id
  order by queue.created_at desc, queue.id desc
  limit 1;
  if not found
    or v_latest_reconciliation.status <> 'succeeded'
    or v_latest_reconciliation.completed_at is null
    or v_latest_reconciliation.completed_at < p_evaluated_at - interval '24 hours'
    or v_latest_reconciliation.completed_at > p_evaluated_at + interval '5 minutes'
    or v_latest_reconciliation.source_ids is null
    or v_latest_reconciliation.candidate_ids is null then
    return 'canonical_reconciliation_not_fresh_success';
  end if;

  if exists (
    select 1
    from public.stage1_award_source_manifest manifest
    cross join unnest(manifest.source_ids) source_id
    where manifest.cohort_key = p_cohort_key
      and not (source_id = any(v_latest_reconciliation.source_ids))
  ) or exists (
    select 1
    from unnest(v_latest_reconciliation.source_ids) source_id
    left join public.shared_award_sources source on source.id = source_id
    left join public.stage1_award_members member
      on member.shared_award_id = source.shared_award_id
      and member.cohort_key = p_cohort_key
    where source.id is null
      or member.shared_award_id is null
      or not exists (
        select 1
        from public.stage1_award_source_manifest manifest
        where manifest.cohort_key = p_cohort_key
          and source_id = any(manifest.source_ids)
      )
  ) or exists (
    select 1
    from public.stage1_award_source_manifest manifest
    cross join lateral (
      select case
        when raw.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then raw.value::uuid
        else null
      end as candidate_id
      from pg_catalog.jsonb_array_elements_text(
        manifest.evidence -> 'fact_candidate_ids'
      ) raw(value)
    ) manifest_candidate
    where manifest.cohort_key = p_cohort_key
      and (
        manifest_candidate.candidate_id is null
        or not (
          manifest_candidate.candidate_id = any(v_latest_reconciliation.candidate_ids)
        )
      )
  ) or exists (
    select 1
    from unnest(v_latest_reconciliation.candidate_ids) candidate_id
    left join public.shared_award_fact_candidates candidate
      on candidate.id = candidate_id
    left join public.shared_award_sources source
      on source.id = candidate.shared_award_source_id
    left join public.stage1_award_members member
      on member.shared_award_id = candidate.shared_award_id
      and member.cohort_key = p_cohort_key
    where candidate.id is null
      or candidate.candidate_status <> 'selected'
      or member.shared_award_id is null
      or source.id is null
      or source.shared_award_id <> candidate.shared_award_id
      or not (source.id = any(v_latest_reconciliation.source_ids))
      or not exists (
        select 1
        from public.stage1_award_source_manifest manifest
        where manifest.cohort_key = p_cohort_key
          and source.id = any(manifest.source_ids)
          and (manifest.evidence -> 'fact_candidate_ids') ? candidate.id::text
      )
  ) then
    return 'canonical_reconciliation_identity_set_mismatch';
  end if;

  select * into v_latest_audit
  from public.shared_award_page_audits audit
  where audit.shared_award_id = v_registry.canonical_shared_award_id
  order by audit.created_at desc, audit.id desc
  limit 1;
  if not found
    or v_latest_audit.audit_status <> 'passed'
    or v_latest_audit.created_at < p_evaluated_at - interval '24 hours'
    or v_latest_audit.created_at > p_evaluated_at + interval '5 minutes' then
    return 'canonical_page_audit_not_fresh_pass';
  end if;

  if v_registry.fact_ledger_batch_id is null then
    return 'fact_ledger_missing';
  end if;

  select count(*)
  into v_public_fact_count
  from public.shared_awards award
  cross join lateral pg_catalog.jsonb_each(award.public_facts) fact
  where award.id = v_registry.canonical_shared_award_id
    and fact.key in (
      'overview',
      'deadline',
      'opening_date',
      'award_amounts',
      'eligibility',
      'requirements',
      'application_materials',
      'how_to_apply',
      'important_dates',
      'documents',
      'contacts',
      'academic_levels',
      'disciplines',
      'citizenship',
      'confidence'
    )
    and fact.value not in (
      'null'::jsonb,
      '""'::jsonb,
      '[]'::jsonb,
      '{}'::jsonb
    );

  select count(*)
  into v_ledger_count
  from public.stage1_award_fact_publication_ledger ledger
  where ledger.cohort_key = p_cohort_key
    and ledger.verification_batch_id = v_registry.fact_ledger_batch_id;

  if v_public_fact_count = 0 or v_ledger_count <> v_public_fact_count then
    return 'fact_ledger_field_count_mismatch';
  end if;

  if not exists (
    select 1
    from public.stage1_award_fact_publication_ledger ledger
    where ledger.cohort_key = p_cohort_key
      and ledger.verification_batch_id = v_registry.fact_ledger_batch_id
      and ledger.field_name = 'overview'
  ) then
    return 'fact_ledger_overview_missing';
  end if;

  if exists (
    select 1
    from public.stage1_award_fact_publication_ledger ledger
    left join public.shared_award_fact_candidates candidate
      on candidate.id = ledger.candidate_id
    left join public.stage1_award_reconciled_fact_evidence materialization
      on materialization.id = ledger.materialization_id
    left join public.shared_award_sources source
      on source.id = ledger.source_id
    left join public.stage1_award_members candidate_member
      on candidate_member.shared_award_id = candidate.shared_award_id
      and candidate_member.cohort_key = p_cohort_key
    left join public.shared_award_source_visual_snapshots snapshot
      on snapshot.shared_award_source_id = ledger.source_id
    left join public.shared_awards award
      on award.id = v_registry.canonical_shared_award_id
    where ledger.cohort_key = p_cohort_key
      and ledger.verification_batch_id = v_registry.fact_ledger_batch_id
      and (
        ledger.policy_version <> v_registry.policy_version
        or ledger.reconciliation_id <> v_latest_reconciliation.id
        or ledger.page_audit_id <> v_latest_audit.id
        or v_latest_reconciliation.candidate_ids is null
        or not (ledger.candidate_id = any(v_latest_reconciliation.candidate_ids))
        or v_latest_reconciliation.source_ids is null
        or not (ledger.source_id = any(v_latest_reconciliation.source_ids))
        or v_latest_audit.public_page_snapshot -> ledger.field_name
          is distinct from ledger.public_value
        or candidate.id is null
        or materialization.id is null
        or materialization.shared_award_id <> v_registry.canonical_shared_award_id
        or materialization.reconciliation_id <> v_latest_reconciliation.id
        or materialization.field_name <> ledger.field_name
        or materialization.public_value <> ledger.public_value
        or materialization.candidate_ids <> ledger.contributing_candidate_ids
        or materialization.source_ids <> ledger.contributing_source_ids
        or materialization.evidence_hash <>
          public.stage1_publication_evidence_hash(materialization.evidence)
        or materialization.evidence -> 'public_value' <> ledger.public_value
        or materialization.evidence -> 'candidate_ids' <>
          pg_catalog.to_jsonb(materialization.candidate_ids)
        or materialization.evidence -> 'source_ids' <>
          pg_catalog.to_jsonb(materialization.source_ids)
        or exists (
          select 1
          from unnest(ledger.contributing_candidate_ids) contributor_id
          left join public.shared_award_fact_candidates contributor
            on contributor.id = contributor_id
          left join public.shared_award_sources contributor_source
            on contributor_source.id = contributor.shared_award_source_id
          left join public.stage1_award_members contributor_member
            on contributor_member.shared_award_id = contributor.shared_award_id
            and contributor_member.cohort_key = p_cohort_key
          where contributor.id is null
            or contributor.candidate_status <> 'selected'
            or contributor_member.shared_award_id is null
            or contributor_source.id is null
            or contributor_source.shared_award_id <> contributor.shared_award_id
            or not (contributor_source.id = any(ledger.contributing_source_ids))
            or not (contributor.id = any(v_latest_reconciliation.candidate_ids))
            or not (contributor_source.id = any(v_latest_reconciliation.source_ids))
            or materialization.evidence #>> array[
              'candidate_bindings', contributor.id::text, 'source_id'
            ] is distinct from contributor.shared_award_source_id::text
            or materialization.evidence #>> array[
              'candidate_bindings', contributor.id::text, 'field_name'
            ] is distinct from contributor.field_name
            or materialization.evidence #> array[
              'candidate_bindings', contributor.id::text, 'normalized_value'
            ] is distinct from contributor.normalized_value
            or materialization.evidence #>> array[
              'candidate_bindings', contributor.id::text, 'evidence_quote'
            ] is distinct from contributor.evidence_quote
            or materialization.evidence #>> array[
              'candidate_bindings', contributor.id::text, 'evidence_location'
            ] is distinct from contributor.evidence_location
            or materialization.evidence #>> array[
              'candidate_bindings', contributor.id::text, 'intake_value_sha256'
            ] is distinct from contributor.intake_value_sha256
        )
        or candidate_member.shared_award_id is null
        or source.id is null
        or source.shared_award_id <> candidate.shared_award_id
        or source.url <> ledger.source_url
        or snapshot.shared_award_source_id is null
        or snapshot.latest_hashes is distinct from ledger.source_snapshot_hashes
        or snapshot.latest_captured_at is distinct from ledger.source_captured_at
        or candidate.candidate_status <> 'selected'
        or candidate.shared_award_source_id <> ledger.source_id
        or ledger.normalized_value <> ledger.public_value
        or award.public_facts -> ledger.field_name is distinct from ledger.public_value
        or not exists (
          select 1
          from public.stage1_award_source_manifest manifest
          where manifest.cohort_key = p_cohort_key
            and manifest.source_role = ledger.source_role
            and ledger.source_id = any(manifest.source_ids)
            and (manifest.evidence -> 'fact_candidate_ids') ? ledger.candidate_id::text
            and manifest.evidence #>> array[
              'candidate_bindings', ledger.candidate_id::text, 'candidate_source_role'
            ] is not distinct from candidate.source_role
            and manifest.evidence #>> array[
              'candidate_bindings', ledger.candidate_id::text, 'evidence_quote'
            ] = ledger.supporting_text
            and manifest.evidence #>> array[
              'candidate_bindings', ledger.candidate_id::text, 'evidence_location'
            ] is not distinct from candidate.evidence_location
            and manifest.evidence #>> array[
              'candidate_bindings', ledger.candidate_id::text, 'intake_value_sha256'
            ] is not distinct from candidate.intake_value_sha256
            and manifest.evidence #>> array[
              'source_bindings',
              ledger.source_id::text,
              'source_url'
            ] = ledger.source_url
            and manifest.evidence #> array[
              'source_bindings',
              ledger.source_id::text,
              'hashes'
            ] = ledger.source_snapshot_hashes
            and (
              manifest.evidence #>> array[
                'source_bindings',
                ledger.source_id::text,
                'captured_at'
              ]
            )::timestamptz = ledger.source_captured_at
        )
      )
  ) then
    return 'fact_ledger_binding_invalid';
  end if;

  return 'verified';
end;
$$;

revoke all on function public.stage1_effective_publication_reason(text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.transition_stage1_cohort_release(
  p_next_state text,
  p_reason text,
  p_policy_version text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_release public.stage1_publication_release_state%rowtype;
  v_previous_state text;
  v_evaluated_at timestamptz := statement_timestamp();
  v_identity_payload text;
  v_identity_hash text;
  v_cohort_count integer;
  v_ready_count integer;
  v_updated_count integer;
  v_epoch uuid;
  v_evidence jsonb;
begin
  if p_next_state not in ('pending', 'verified_beta', 'revalidation_pending', 'suspended') then
    raise exception using errcode = '22023', message = 'Invalid Stage 1 cohort release state.';
  end if;
  if nullif(pg_catalog.btrim(p_reason), '') is null
    or nullif(pg_catalog.btrim(p_policy_version), '') is null
    or nullif(pg_catalog.btrim(p_actor), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Cohort release transitions require a reason, policy version, and actor.';
  end if;
  if p_policy_version <> 'stage1-publication-v1' then
    raise exception using errcode = '23514', message = 'Stage 1 cohort release policy version mismatch.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );

  select * into v_release
  from public.stage1_publication_release_state release_state
  where release_state.release_key = 'stage1-national-25'
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'The authoritative Stage 1 cohort release row is missing.';
  end if;
  v_previous_state := v_release.release_state;

  select
    count(*),
    pg_catalog.string_agg(
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
  into v_cohort_count, v_identity_payload
  from public.stage1_award_registry registry;
  v_identity_hash := public.stage1_publication_evidence_hash(
    pg_catalog.to_jsonb(v_identity_payload)
  );

  if v_cohort_count <> 25
    or v_identity_hash <> '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e' then
    raise exception using
      errcode = '23514',
      message = 'The registry does not exactly match the reviewed national 25 cohort.';
  end if;

  select count(*) filter (where reason.value = 'verified')
  into v_ready_count
  from public.stage1_award_registry registry
  cross join lateral (
    select public.stage1_effective_publication_reason(
      registry.cohort_key,
      v_evaluated_at
    ) as value
  ) reason;

  if p_next_state = 'verified_beta' then
    if v_ready_count <> 25 then
      raise exception using
        errcode = '23514',
        message = format(
          'The Stage 1 cohort release is not ready: %s/25 awards passed live verification.',
          v_ready_count
        );
    end if;
    v_epoch := gen_random_uuid();
    update public.stage1_award_registry registry
    set release_epoch = v_epoch, updated_at = v_evaluated_at;
    get diagnostics v_updated_count = row_count;
    if v_updated_count <> 25 then
      raise exception using
        errcode = '23514',
        message = 'The Stage 1 release epoch was not assigned to exactly 25 awards.';
    end if;
  else
    v_epoch := null;
    update public.stage1_award_registry registry
    set release_epoch = null, updated_at = v_evaluated_at
    where registry.release_epoch is not null;
  end if;

  update public.stage1_publication_release_state release_state
  set
    release_state = p_next_state,
    release_epoch = v_epoch,
    reason = pg_catalog.btrim(p_reason),
    policy_version = p_policy_version,
    cohort_identity_version = 'stage1-national-25-v1',
    cohort_identity_hash = v_identity_hash,
    activated_at = case when p_next_state = 'verified_beta' then v_evaluated_at else null end,
    updated_at = v_evaluated_at
  where release_state.release_key = 'stage1-national-25'
  returning * into v_release;

  v_evidence := pg_catalog.jsonb_build_object(
    'evaluated_at', v_evaluated_at,
    'cohort_count', v_cohort_count,
    'ready_cohort_count', v_ready_count,
    'cohort_identity_hash', v_identity_hash,
    'release_epoch', v_epoch
  );
  insert into public.stage1_publication_release_events (
    release_key,
    previous_state,
    next_state,
    release_epoch,
    reason,
    policy_version,
    cohort_identity_version,
    cohort_identity_hash,
    evidence_snapshot,
    evidence_hash,
    actor
  ) values (
    'stage1-national-25',
    v_previous_state,
    p_next_state,
    v_epoch,
    pg_catalog.btrim(p_reason),
    p_policy_version,
    'stage1-national-25-v1',
    v_identity_hash,
    v_evidence,
    public.stage1_publication_evidence_hash(v_evidence),
    pg_catalog.btrim(p_actor)
  );

  return pg_catalog.to_jsonb(v_release);
end;
$$;

revoke all on function public.transition_stage1_cohort_release(text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.transition_stage1_cohort_release(text, text, text, text)
  to service_role;

create or replace function public.list_stage1_effective_publication()
returns table (
  cohort_key text,
  effectively_verified boolean,
  effective_reason text,
  evaluated_at timestamptz,
  cohort_ready boolean,
  cohort_readiness_reason text,
  release_epoch uuid,
  release_state text,
  release_policy_version text,
  release_identity_version text,
  release_identity_hash text
)
language sql
stable
security definer
set search_path = ''
as $$
  with evaluated as (
    select statement_timestamp() as evaluated_at
  ),
  identity_payload as (
    select
      count(*) as cohort_count,
      public.stage1_publication_evidence_hash(pg_catalog.to_jsonb(
        pg_catalog.string_agg(
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
      )) as identity_hash
    from public.stage1_award_registry registry
  ),
  cohort_reasons as (
    select
      registry.launch_rank,
      registry.cohort_key,
      registry.release_epoch as registry_release_epoch,
      reason.value as readiness_reason
    from public.stage1_award_registry registry
    cross join evaluated
    cross join lateral (
      select public.stage1_effective_publication_reason(
        registry.cohort_key,
        evaluated.evaluated_at
      ) as value
    ) reason
  ),
  release_decision as (
    select
      release_state.*,
      evaluated.evaluated_at,
      identity_payload.cohort_count,
      identity_payload.identity_hash,
      count(*) filter (where cohort_reasons.readiness_reason = 'verified') as ready_count,
      count(*) filter (
        where cohort_reasons.registry_release_epoch is distinct from release_state.release_epoch
      ) as epoch_mismatch_count,
      case
        when identity_payload.cohort_count <> 25
          or identity_payload.identity_hash <> '60261d07d5918554d0fb0b4ab895dbef3d57973f0a5b8d277ad0b128611d801e'
          or release_state.cohort_identity_version <> 'stage1-national-25-v1'
          or release_state.cohort_identity_hash <> identity_payload.identity_hash
          or release_state.policy_version <> 'stage1-publication-v1'
          then 'cohort_release_identity_mismatch'
        when release_state.release_state <> 'verified_beta'
          then 'cohort_release_not_activated'
        when count(*) filter (where cohort_reasons.readiness_reason = 'verified') <> 25
          then 'cohort_release_not_ready'
        when release_state.release_epoch is null
          or count(*) filter (
            where cohort_reasons.registry_release_epoch is distinct from release_state.release_epoch
          ) <> 0
          then 'cohort_release_epoch_mismatch'
        else 'verified'
      end as decision_reason
    from public.stage1_publication_release_state release_state
    cross join evaluated
    cross join identity_payload
    cross join cohort_reasons
    where release_state.release_key = 'stage1-national-25'
    group by
      release_state.release_key,
      release_state.release_state,
      release_state.release_epoch,
      release_state.reason,
      release_state.policy_version,
      release_state.cohort_identity_version,
      release_state.cohort_identity_hash,
      release_state.activated_at,
      release_state.updated_at,
      evaluated.evaluated_at,
      identity_payload.cohort_count,
      identity_payload.identity_hash
  )
  select
    cohort_reasons.cohort_key,
    release_decision.decision_reason = 'verified' as effectively_verified,
    release_decision.decision_reason as effective_reason,
    release_decision.evaluated_at,
    cohort_reasons.readiness_reason = 'verified' as cohort_ready,
    cohort_reasons.readiness_reason as cohort_readiness_reason,
    release_decision.release_epoch,
    release_decision.release_state,
    release_decision.policy_version as release_policy_version,
    release_decision.cohort_identity_version as release_identity_version,
    release_decision.cohort_identity_hash as release_identity_hash
  from cohort_reasons
  cross join release_decision
  order by cohort_reasons.launch_rank;
$$;

revoke all on function public.list_stage1_effective_publication()
  from public, anon, authenticated, service_role;
grant execute on function public.list_stage1_effective_publication()
  to service_role;

-- One RPC returns the complete publication decision and every value needed to
-- enforce it. PostgREST callers must not assemble a security decision from
-- separate requests that can observe different database snapshots.
create or replace function public.get_stage1_publication_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with evaluated as (
    select statement_timestamp() as evaluated_at
  ),
  identity_payload as (
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
    ) as value
    from public.stage1_award_registry registry
  ),
  effective_rows as (
    select * from public.list_stage1_effective_publication()
  ),
  cohort_rows as (
    select
      registry.launch_rank,
      pg_catalog.jsonb_build_object(
        'registry', pg_catalog.to_jsonb(registry),
        'effectively_verified', effective.effectively_verified,
        'effective_reason', effective.effective_reason,
        'cohort_ready', effective.cohort_ready,
        'cohort_readiness_reason', effective.cohort_readiness_reason,
        'evaluated_at', effective.evaluated_at,
        'members', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(member)
            order by member.member_kind, member.shared_award_id
          )
          from public.stage1_award_members member
          where member.cohort_key = registry.cohort_key
        ), '[]'::jsonb),
        'identity_rules', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(identity_rule)
            order by identity_rule.rule_key, identity_rule.id
          )
          from public.stage1_award_source_identity_rules identity_rule
          where identity_rule.cohort_key = registry.cohort_key
        ), '[]'::jsonb),
        'allowed_source_ids', coalesce((
          select pg_catalog.jsonb_agg(
            allowed.source_id
            order by allowed.source_id
          )
          from (
            select distinct unnest(manifest.source_ids) as source_id
            from public.stage1_award_source_manifest manifest
            where manifest.cohort_key = registry.cohort_key
          ) allowed
        ), '[]'::jsonb),
        'reviewed_homepage', (
          select pg_catalog.jsonb_build_object(
            'source_id', source.id,
            'url', source.url
          )
          from public.stage1_award_source_manifest manifest
          join public.shared_award_sources source
            on cardinality(manifest.source_ids) = 1
            and source.id = manifest.source_ids[1]
          where manifest.cohort_key = registry.cohort_key
            and manifest.source_role = 'identity_home'
            and manifest.manifest_status in ('present', 'combined')
            and source.url = registry.official_homepage
            and manifest.evidence ->> 'source_url' = registry.official_homepage
            and manifest.evidence #>> array[
              'source_bindings', source.id::text, 'source_url'
            ] = registry.official_homepage
        ),
        'published_facts', coalesce((
          select pg_catalog.jsonb_object_agg(
            ledger.field_name,
            ledger.public_value
            order by ledger.field_name
          )
          from public.stage1_award_fact_publication_ledger ledger
          where ledger.cohort_key = registry.cohort_key
            and ledger.verification_batch_id = registry.fact_ledger_batch_id
        ), '{}'::jsonb)
      ) as payload
    from public.stage1_award_registry registry
    join effective_rows effective on effective.cohort_key = registry.cohort_key
  )
  select pg_catalog.jsonb_build_object(
    'schema_version', 3,
    'cohort_identity_version', 'stage1-national-25-v1',
    'cohort_identity_hash', public.stage1_publication_evidence_hash(
      pg_catalog.to_jsonb(identity_payload.value)
    ),
    'evaluated_at', evaluated.evaluated_at,
    'release', pg_catalog.jsonb_build_object(
      'release_key', release_state.release_key,
      'release_state', release_state.release_state,
      'release_epoch', release_state.release_epoch,
      'policy_version', release_state.policy_version,
      'cohort_identity_version', release_state.cohort_identity_version,
      'cohort_identity_hash', release_state.cohort_identity_hash,
      'activated_at', release_state.activated_at,
      'effectively_released', coalesce((
        select count(*) = 25 and bool_and(effective.effectively_verified)
        from effective_rows effective
      ), false),
      'effective_reason', coalesce((
        select min(effective.effective_reason)
        from effective_rows effective
      ), 'cohort_release_rows_missing'),
      'ready_cohort_count', coalesce((
        select count(*) filter (where effective.cohort_ready)
        from effective_rows effective
      ), 0)
    ),
    'cohorts', coalesce(
      (
        select pg_catalog.jsonb_agg(
          cohort_rows.payload
          order by cohort_rows.launch_rank
        )
        from cohort_rows
      ),
      '[]'::jsonb
    )
  )
  from evaluated
  cross join identity_payload
  cross join public.stage1_publication_release_state release_state
  where release_state.release_key = 'stage1-national-25';
$$;

revoke all on function public.get_stage1_publication_snapshot()
  from public, anon, authenticated, service_role;
grant execute on function public.get_stage1_publication_snapshot()
  to service_role;

create or replace function public.invalidate_stage1_publication_on_evidence_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cohort_keys text[] := '{}'::text[];
begin
  if tg_op <> 'DELETE' then
    v_cohort_keys := pg_catalog.array_append(v_cohort_keys, new.cohort_key);
  end if;
  if tg_op <> 'INSERT' then
    v_cohort_keys := pg_catalog.array_append(v_cohort_keys, old.cohort_key);
  end if;

  with invalidated as (
    update public.stage1_award_registry registry
    set
      publication_state = 'revalidation_pending',
      state_reason = format(
        'Stage 1 evidence changed in %s; fresh verification is required.',
        tg_table_name
      ),
      evidence_checked_at = null,
      updated_at = now()
    where registry.cohort_key = any(v_cohort_keys)
      and registry.publication_state = 'verified_beta'
    returning registry.cohort_key, registry.policy_version
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
    invalidated.cohort_key,
    'verified_beta',
    'revalidation_pending',
    format(
      'Stage 1 evidence changed in %s; fresh verification is required.',
      tg_table_name
    ),
    invalidated.policy_version,
    pg_catalog.jsonb_build_object(
      'trigger_table', tg_table_name,
      'operation', tg_op,
      'invalidated_at', now()
    ),
    public.stage1_publication_evidence_hash(
      pg_catalog.jsonb_build_object(
        'trigger_table', tg_table_name,
        'operation', tg_op,
        'invalidated_at', now()
      )
    ),
    'database-trigger'
  from invalidated;

  perform public.invalidate_stage1_cohort_release(
    format(
      'Stage 1 evidence changed in %s; the 25-award release requires revalidation.',
      tg_table_name
    ),
    'database-trigger'
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.invalidate_stage1_publication_on_evidence_change()
  from public, anon, authenticated, service_role;

-- Acquire the global release fence before PostgreSQL selects or locks any
-- evidence row. Promotion holds the same advisory lock and deliberately does
-- not request conflicting table locks on these fenced tables.
create or replace function public.stage1_evidence_release_fence_before_statement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  return null;
end;
$$;

revoke all on function public.stage1_evidence_release_fence_before_statement()
  from public, anon, authenticated, service_role;

drop trigger if exists stage1_members_invalidate_publication
  on public.stage1_award_members;
drop trigger if exists stage1_members_release_fence_before_statement
  on public.stage1_award_members;
create trigger stage1_members_release_fence_before_statement
before insert or update or delete on public.stage1_award_members
for each statement execute function public.stage1_evidence_release_fence_before_statement();
create trigger stage1_members_invalidate_publication
after insert or update or delete on public.stage1_award_members
for each row execute function public.invalidate_stage1_publication_on_evidence_change();

drop trigger if exists stage1_manifest_invalidate_publication
  on public.stage1_award_source_manifest;
drop trigger if exists stage1_manifest_release_fence_before_statement
  on public.stage1_award_source_manifest;
create trigger stage1_manifest_release_fence_before_statement
before insert or update or delete on public.stage1_award_source_manifest
for each statement execute function public.stage1_evidence_release_fence_before_statement();
create trigger stage1_manifest_invalidate_publication
after insert or update or delete on public.stage1_award_source_manifest
for each row execute function public.invalidate_stage1_publication_on_evidence_change();

drop trigger if exists stage1_identity_rules_invalidate_publication
  on public.stage1_award_source_identity_rules;
drop trigger if exists stage1_identity_rules_release_fence_before_statement
  on public.stage1_award_source_identity_rules;
create trigger stage1_identity_rules_release_fence_before_statement
before insert or update or delete on public.stage1_award_source_identity_rules
for each statement execute function public.stage1_evidence_release_fence_before_statement();
create trigger stage1_identity_rules_invalidate_publication
after insert or update or delete on public.stage1_award_source_identity_rules
for each row execute function public.invalidate_stage1_publication_on_evidence_change();

create or replace function public.invalidate_stage1_publication_on_canonical_award_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invalidated_at timestamptz := now();
  v_evidence jsonb;
  v_invalidated_count integer := 0;
begin
  v_evidence := pg_catalog.jsonb_build_object(
    'trigger_table', tg_table_name,
    'operation', tg_op,
    'shared_award_id', new.id,
    'invalidated_at', v_invalidated_at
  );

  with invalidated as (
    update public.stage1_award_registry registry
    set
      publication_state = 'revalidation_pending',
      state_reason = 'Canonical award identity or published facts changed; fresh Stage 1 verification is required.',
      evidence_checked_at = null,
      updated_at = v_invalidated_at
    where registry.canonical_shared_award_id = new.id
      and registry.publication_state = 'verified_beta'
    returning registry.cohort_key, registry.policy_version
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
    invalidated.cohort_key,
    'verified_beta',
    'revalidation_pending',
    'Canonical award identity or published facts changed; fresh Stage 1 verification is required.',
    invalidated.policy_version,
    v_evidence,
    public.stage1_publication_evidence_hash(v_evidence),
    'database-trigger'
  from invalidated;

  get diagnostics v_invalidated_count = row_count;

  if v_invalidated_count > 0 then
    perform public.invalidate_stage1_cohort_release(
      'Canonical award identity or published facts changed; the 25-award release requires revalidation.',
      'database-trigger'
    );
  end if;

  return new;
end;
$$;

revoke all on function public.invalidate_stage1_publication_on_canonical_award_change()
  from public, anon, authenticated, service_role;

drop trigger if exists stage1_canonical_award_invalidate_publication
  on public.shared_awards;
drop trigger if exists stage1_canonical_award_release_fence_before_statement
  on public.shared_awards;
create trigger stage1_canonical_award_release_fence_before_statement
before update of name, slug, official_homepage, public_facts, status
on public.shared_awards
for each statement
execute function public.stage1_evidence_release_fence_before_statement();
create trigger stage1_canonical_award_invalidate_publication
after update of name, slug, official_homepage, public_facts, status
on public.shared_awards
for each row
when (
  old.name is distinct from new.name
  or old.slug is distinct from new.slug
  or old.official_homepage is distinct from new.official_homepage
  or old.public_facts is distinct from new.public_facts
  or old.status is distinct from new.status
)
execute function public.invalidate_stage1_publication_on_canonical_award_change();

-- Public and authenticated clients never read the mutable shared catalog
-- directly during Stage 1. Every web/API surface is server-rendered through
-- the service-role publication predicate above. This prevents a raw PostgREST
-- query from bypassing suppression, quarantine, source-quality, or beta state.
revoke all on table public.shared_awards from anon, authenticated;
revoke all on table public.shared_award_sources from anon, authenticated;
revoke all on table public.shared_award_source_snapshots from anon, authenticated;
revoke all on table public.shared_award_change_events from anon, authenticated;
revoke all on table public.shared_award_slug_aliases from anon, authenticated;
revoke all on table public.shared_award_update_read_baselines from authenticated;
revoke all on table public.shared_award_change_reads from authenticated;

drop policy if exists "shared awards visible to authenticated users"
  on public.shared_awards;
drop policy if exists "shared award sources visible to authenticated users"
  on public.shared_award_sources;
drop policy if exists "shared award snapshots visible to authenticated users"
  on public.shared_award_source_snapshots;
drop policy if exists "shared award history visible to authenticated users"
  on public.shared_award_change_events;
drop policy if exists "shared award aliases visible for active awards"
  on public.shared_award_slug_aliases;
drop policy if exists "read baselines are user owned"
  on public.shared_award_update_read_baselines;
drop policy if exists "change reads are user owned"
  on public.shared_award_change_reads;
