-- Insert exact human-reviewed Stage 1 fact candidates without invoking paid
-- intake, mutating legacy candidates, or coupling candidate creation to
-- reconciliation/publication. The private ledgers make retries idempotent and
-- give reviewed reconciliation a durable provenance registry.

create schema if not exists private;
revoke all on schema private from public;
revoke create on schema public from public;

create or replace function private.stage1_canonical_json_text(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case pg_catalog.jsonb_typeof(p_value)
    when 'object' then (
      select '{' || coalesce(pg_catalog.string_agg(
        pg_catalog.to_jsonb(entry.key)::text || ':' ||
          private.stage1_canonical_json_text(entry.value),
        ',' order by entry.key collate "C"
      ), '') || '}'
      from pg_catalog.jsonb_each(p_value) entry
    )
    when 'array' then (
      select '[' || coalesce(pg_catalog.string_agg(
        private.stage1_canonical_json_text(entry.value),
        ',' order by entry.ordinality
      ), '') || ']'
      from pg_catalog.jsonb_array_elements(p_value)
        with ordinality entry(value, ordinality)
    )
    else p_value::text
  end
$$;

create or replace function private.stage1_pgcrypto_sha256(p_value bytea)
returns text
language plpgsql
stable
strict
set search_path = ''
as $$
declare
  v_digest_schema text;
  v_digest text;
begin
  select pg_catalog.min(namespace.nspname::text)
  into v_digest_schema
  from pg_catalog.pg_extension ext
  join pg_catalog.pg_depend dep
    on dep.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
    and dep.refobjid = ext.oid
    and dep.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
    and dep.deptype = 'e'
  join pg_catalog.pg_proc proc
    on proc.oid = dep.objid
  join pg_catalog.pg_namespace namespace
    on namespace.oid = proc.pronamespace
  where ext.extname = 'pgcrypto'
    and proc.proname = 'digest'
    and proc.prokind = 'f'
    and proc.pronargs = 2
    and proc.proargtypes[0] = 'pg_catalog.bytea'::pg_catalog.regtype
    and proc.proargtypes[1] = 'pg_catalog.text'::pg_catalog.regtype
    and proc.prorettype = 'pg_catalog.bytea'::pg_catalog.regtype
    and proc.proowner = ext.extowner
  having pg_catalog.count(*) = 1;

  if v_digest_schema is null then
    raise exception using
      errcode = '55000',
      message = 'The exact extension-owned pgcrypto digest(bytea,text) function is required.';
  end if;

  execute pg_catalog.format(
    'select pg_catalog.encode(%I.digest($1, ''sha256''::pg_catalog.text), ''hex''::pg_catalog.text)',
    v_digest_schema
  ) into v_digest using p_value;
  return v_digest;
end;
$$;

create or replace function private.stage1_canonical_json_sha256(p_value jsonb)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select private.stage1_pgcrypto_sha256(
    pg_catalog.convert_to(private.stage1_canonical_json_text(p_value), 'UTF8')
  )
$$;

create or replace function private.stage1_text_sha256(p_value text)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select private.stage1_pgcrypto_sha256(pg_catalog.convert_to(p_value, 'UTF8'))
$$;

create or replace function private.stage1_jsonb_has_exact_keys(
  p_value jsonb,
  p_keys text[]
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_value) = 'object'
    and (
      select pg_catalog.count(*) = pg_catalog.cardinality(p_keys)
        and pg_catalog.count(*) = pg_catalog.count(distinct key_name)
        and pg_catalog.bool_and(key_name = any(p_keys))
      from pg_catalog.jsonb_object_keys(p_value) key_name
    )
$$;

create or replace function private.stage1_https_host(p_url text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.lower(
    pg_catalog.substring(p_url, '^https://([^/:?#]+)')
  )
$$;

create or replace function private.stage1_evidence_location_is_valid(p_value text)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_match text[];
begin
  v_match := pg_catalog.regexp_match(
    p_value,
    '^immutable_text_chars:(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$'
  );
  return v_match is not null
    and v_match[2]::numeric > v_match[1]::numeric;
exception when numeric_value_out_of_range then
  return false;
end;
$$;

-- local_verified_at records when the operator process re-read the immutable
-- file. It must be fresh on every call, so it is deliberately excluded from
-- the stable replay identity while the complete first-apply binding (and its
-- hash) remains retained in the immutable bundle ledger.
create or replace function private.stage1_stable_source_bindings(p_value jsonb)
returns jsonb
language sql
immutable
strict
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      source.value - 'local_verified_at'
      order by source.value ->> 'source_id'
    ),
    '[]'::jsonb
  )
  from pg_catalog.jsonb_array_elements(p_value) source(value)
$$;

revoke all on function private.stage1_canonical_json_text(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.stage1_pgcrypto_sha256(bytea)
  from public, anon, authenticated, service_role;
revoke all on function private.stage1_canonical_json_sha256(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.stage1_text_sha256(text)
  from public, anon, authenticated, service_role;
revoke all on function private.stage1_jsonb_has_exact_keys(jsonb, text[])
  from public, anon, authenticated, service_role;
revoke all on function private.stage1_https_host(text)
  from public, anon, authenticated, service_role;
revoke all on function private.stage1_evidence_location_is_valid(text)
  from public, anon, authenticated, service_role;
revoke all on function private.stage1_stable_source_bindings(jsonb)
  from public, anon, authenticated, service_role;

create table private.stage1_reviewed_candidate_import_bundles (
  bundle_sha256 text primary key,
  confirmation_sha256 text not null,
  cohort_key text not null references public.stage1_award_registry(cohort_key)
    on delete restrict,
  canonical_shared_award_id uuid not null references public.shared_awards(id)
    on delete restrict,
  reviewed_by text not null,
  reviewed_at timestamptz not null,
  review_reason text not null,
  candidate_count integer not null check (candidate_count between 1 and 500),
  review_bundle jsonb not null,
  source_bindings jsonb not null,
  source_bindings_sha256 text not null,
  candidates_sha256 text not null,
  confirmation_payload jsonb not null,
  import_binding_sha256 text not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint stage1_reviewed_candidate_import_bundle_hash_check check (
    bundle_sha256 ~ '^[0-9a-f]{64}$'
    and confirmation_sha256 ~ '^[0-9a-f]{64}$'
    and source_bindings_sha256 ~ '^[0-9a-f]{64}$'
    and candidates_sha256 ~ '^[0-9a-f]{64}$'
    and import_binding_sha256 ~ '^[0-9a-f]{64}$'
    and private.stage1_canonical_json_sha256(review_bundle) = bundle_sha256
    and private.stage1_canonical_json_sha256(source_bindings) = source_bindings_sha256
    and private.stage1_canonical_json_sha256(confirmation_payload) = confirmation_sha256
    and confirmation_payload ->> 'bundle_sha256' = bundle_sha256
    and confirmation_payload ->> 'candidates_sha256' = candidates_sha256
    and (confirmation_payload ->> 'candidate_count')::integer = candidate_count
  )
);

create table private.stage1_reviewed_candidate_import_items (
  item_sha256 text primary key,
  bundle_sha256 text not null references
    private.stage1_reviewed_candidate_import_bundles(bundle_sha256)
    on delete restrict,
  candidate_id uuid not null unique references
    public.shared_award_fact_candidates(id) on delete restrict,
  canonical_shared_award_id uuid not null references public.shared_awards(id)
    on delete restrict,
  source_id uuid not null references public.shared_award_sources(id)
    on delete restrict,
  field_name text not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint stage1_reviewed_candidate_import_item_hash_check check (
    item_sha256 ~ '^[0-9a-f]{64}$'
  )
);

alter table private.stage1_reviewed_candidate_import_bundles enable row level security;
alter table private.stage1_reviewed_candidate_import_items enable row level security;
revoke all on table
  private.stage1_reviewed_candidate_import_bundles,
  private.stage1_reviewed_candidate_import_items
from public, anon, authenticated, service_role;
grant select on table
  private.stage1_reviewed_candidate_import_bundles,
  private.stage1_reviewed_candidate_import_items
to service_role;
create policy stage1_reviewed_candidate_import_bundles_service_read
on private.stage1_reviewed_candidate_import_bundles
for select to service_role using (true);
create policy stage1_reviewed_candidate_import_items_service_read
on private.stage1_reviewed_candidate_import_items
for select to service_role using (true);

create or replace function private.prevent_stage1_reviewed_candidate_import_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Reviewed Stage 1 candidate-import ledgers are immutable.';
end;
$$;

revoke all on function private.prevent_stage1_reviewed_candidate_import_mutation()
  from public, anon, authenticated, service_role;
create trigger prevent_stage1_reviewed_candidate_import_bundle_mutation
before update or delete on private.stage1_reviewed_candidate_import_bundles
for each row execute function private.prevent_stage1_reviewed_candidate_import_mutation();
create trigger prevent_stage1_reviewed_candidate_import_item_mutation
before update or delete on private.stage1_reviewed_candidate_import_items
for each row execute function private.prevent_stage1_reviewed_candidate_import_mutation();

create or replace function private.stage1_candidate_uuid_from_sha256(p_hash text)
returns uuid
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_bytes bytea;
  v_hex text;
begin
  if p_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  v_bytes := pg_catalog.decode(pg_catalog.substr(p_hash, 1, 32), 'hex');
  v_bytes := pg_catalog.set_byte(
    v_bytes,
    6,
    (pg_catalog.get_byte(v_bytes, 6) & 15) | 64
  );
  v_bytes := pg_catalog.set_byte(
    v_bytes,
    8,
    (pg_catalog.get_byte(v_bytes, 8) & 63) | 128
  );
  v_hex := pg_catalog.encode(v_bytes, 'hex');
  return (
    pg_catalog.substr(v_hex, 1, 8) || '-' ||
    pg_catalog.substr(v_hex, 9, 4) || '-' ||
    pg_catalog.substr(v_hex, 13, 4) || '-' ||
    pg_catalog.substr(v_hex, 17, 4) || '-' ||
    pg_catalog.substr(v_hex, 21, 12)
  )::uuid;
end;
$$;

revoke all on function private.stage1_candidate_uuid_from_sha256(text)
  from public, anon, authenticated, service_role;

create or replace function public.import_reviewed_stage1_fact_candidates(
  p_import_binding jsonb,
  p_confirmation_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bundle jsonb;
  v_bundle_sha text;
  v_confirmation jsonb;
  v_import_binding_sha text;
  v_source_bindings_sha text;
  v_candidates_sha text;
  v_award_id uuid;
  v_cohort_key text;
  v_reviewed_at timestamptz;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_candidate jsonb;
  v_source_binding jsonb;
  v_review_source jsonb;
  v_bundle_item jsonb;
  v_item_sha text;
  v_expected_item_sha text;
  v_expected_candidate_ids jsonb;
  v_existing_candidate public.shared_award_fact_candidates%rowtype;
  v_existing_bundle private.stage1_reviewed_candidate_import_bundles%rowtype;
  v_existing_ledger private.stage1_reviewed_candidate_import_items%rowtype;
  v_inserted integer := 0;
  v_existing integer := 0;
  v_count integer;
  v_source_count integer;
begin
  if private.stage1_jsonb_has_exact_keys(p_import_binding, array[
      'schema_version',
      'policy_version',
      'bundle_sha256',
      'review_bundle',
      'award',
      'source_bindings',
      'candidates',
      'confirmation_payload',
      'confirmation_sha256'
    ]) is not true
    or p_import_binding ->> 'schema_version' is distinct from
      'awardping.stage1.reviewed-candidate-import-binding.v1'
    or p_import_binding ->> 'policy_version' is distinct from
      'stage1-publication-v1'
    or coalesce(p_import_binding ->> 'bundle_sha256', '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_import_binding ->> 'confirmation_sha256', '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_confirmation_sha256, '') !~ '^[0-9a-f]{64}$'
    or p_import_binding ->> 'confirmation_sha256' is distinct from
      p_confirmation_sha256
    or pg_catalog.jsonb_typeof(p_import_binding -> 'review_bundle')
      is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_import_binding -> 'source_bindings')
      is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_import_binding -> 'candidates')
      is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_import_binding -> 'confirmation_payload')
      is distinct from 'object'
  then
    raise exception using errcode = '22023',
      message = 'A complete reviewed Stage 1 candidate-import binding is required.';
  end if;

  v_bundle := p_import_binding -> 'review_bundle';
  v_bundle_sha := p_import_binding ->> 'bundle_sha256';
  v_confirmation := p_import_binding -> 'confirmation_payload';
  v_import_binding_sha := private.stage1_canonical_json_sha256(p_import_binding);
  v_source_bindings_sha := private.stage1_canonical_json_sha256(
    p_import_binding -> 'source_bindings'
  );
  v_candidates_sha := private.stage1_canonical_json_sha256(
    p_import_binding -> 'candidates'
  );
  if private.stage1_jsonb_has_exact_keys(v_bundle, array[
      'schema_version', 'policy_version', 'review', 'cohort', 'sources', 'items'
    ]) is not true
    or private.stage1_jsonb_has_exact_keys(v_bundle -> 'review', array[
      'reviewed_by', 'reviewed_at', 'reason', 'selection_method', 'paid_api_calls'
    ]) is not true
    or private.stage1_jsonb_has_exact_keys(v_bundle -> 'cohort', array[
      'cohort_key', 'canonical_award'
    ]) is not true
    or private.stage1_jsonb_has_exact_keys(
      v_bundle #> array['cohort', 'canonical_award'],
      array['id', 'search_key', 'name', 'official_homepage']
    ) is not true
    or private.stage1_jsonb_has_exact_keys(p_import_binding -> 'award', array[
      'id', 'updated_at'
    ]) is not true
    or private.stage1_jsonb_has_exact_keys(v_confirmation, array[
      'schema_version',
      'operation',
      'cohort_key',
      'canonical_shared_award_id',
      'policy_version',
      'bundle_sha256',
      'database_snapshot_sha256',
      'candidates_sha256',
      'candidate_ids',
      'candidate_count',
      'reviewed_by',
      'reviewed_at',
      'paid_api_calls'
    ]) is not true
    or pg_catalog.jsonb_typeof(v_bundle -> 'sources') is distinct from 'array'
    or pg_catalog.jsonb_typeof(v_bundle -> 'items') is distinct from 'array'
    or pg_catalog.jsonb_typeof(v_confirmation -> 'candidate_ids') is distinct from 'array'
    or private.stage1_canonical_json_sha256(v_bundle) is distinct from v_bundle_sha
    or private.stage1_canonical_json_sha256(v_confirmation)
      is distinct from p_confirmation_sha256
    or v_confirmation ->> 'bundle_sha256' is distinct from v_bundle_sha
    or v_confirmation ->> 'candidates_sha256' is distinct from v_candidates_sha
    or coalesce(v_confirmation ->> 'database_snapshot_sha256', '') !~ '^[0-9a-f]{64}$'
    or v_bundle ->> 'schema_version' is distinct from
      'awardping.stage1.reviewed-candidate-import.v1'
    or v_bundle ->> 'policy_version' is distinct from 'stage1-publication-v1'
    or v_bundle #>> array['review', 'selection_method'] is distinct from
      'explicit_human_review'
    or v_bundle #> array['review', 'paid_api_calls'] is distinct from '0'::jsonb
  then
    raise exception using errcode = '22023',
      message = 'Candidate-import canonical hashes or review policy do not match.';
  end if;

  v_award_id := (v_bundle #>> array['cohort', 'canonical_award', 'id'])::uuid;
  v_cohort_key := v_bundle #>> array['cohort', 'cohort_key'];
  v_reviewed_at := (v_bundle #>> array['review', 'reviewed_at'])::timestamptz;
  v_count := pg_catalog.jsonb_array_length(p_import_binding -> 'candidates');
  v_source_count := pg_catalog.jsonb_array_length(v_bundle -> 'sources');
  select pg_catalog.jsonb_agg(
    pg_catalog.to_jsonb(candidate ->> 'id') order by candidate ->> 'id'
  ) into v_expected_candidate_ids
  from pg_catalog.jsonb_array_elements(p_import_binding -> 'candidates') candidate;
  if v_count < 1 or v_count > 500
    or (v_confirmation ->> 'candidate_count')::integer <> v_count
    or pg_catalog.jsonb_array_length(v_bundle -> 'items') <> v_count
    or v_source_count < 1
    or pg_catalog.jsonb_array_length(p_import_binding -> 'source_bindings') <> v_source_count
    or nullif(pg_catalog.btrim(v_cohort_key), '') is null
    or nullif(pg_catalog.btrim(v_bundle #>> array['review', 'reviewed_by']), '') is null
    or nullif(pg_catalog.btrim(v_bundle #>> array['review', 'reason']), '') is null
    or coalesce(v_bundle #>> array['review', 'reviewed_at'], '') !~
      '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]\d{3}Z$'
    or v_reviewed_at < v_now - interval '24 hours'
    or v_reviewed_at > v_now + interval '5 minutes'
    or v_confirmation ->> 'schema_version' is distinct from
      'awardping.stage1.reviewed-candidate-import-confirmation.v1'
    or v_confirmation ->> 'operation' is distinct from
      'apply_reviewed_stage1_candidate_import'
    or v_confirmation ->> 'cohort_key' is distinct from v_cohort_key
    or v_confirmation ->> 'canonical_shared_award_id' is distinct from v_award_id::text
    or v_confirmation ->> 'policy_version' is distinct from 'stage1-publication-v1'
    or v_confirmation ->> 'reviewed_by' is distinct from
      v_bundle #>> array['review', 'reviewed_by']
    or v_confirmation ->> 'reviewed_at' is distinct from
      v_bundle #>> array['review', 'reviewed_at']
    or v_confirmation -> 'paid_api_calls' is distinct from '0'::jsonb
    or v_confirmation -> 'candidate_ids' is distinct from v_expected_candidate_ids
    or (select pg_catalog.count(distinct candidate ->> 'id')
        from pg_catalog.jsonb_array_elements(p_import_binding -> 'candidates') candidate) <> v_count
    or (select pg_catalog.count(distinct item ->> 'item_key')
        from pg_catalog.jsonb_array_elements(v_bundle -> 'items') item) <> v_count
    or (select pg_catalog.count(distinct source ->> 'source_id')
        from pg_catalog.jsonb_array_elements(v_bundle -> 'sources') source) <> v_source_count
    or (select pg_catalog.count(distinct source ->> 'source_id')
        from pg_catalog.jsonb_array_elements(p_import_binding -> 'source_bindings') source) <> v_source_count
    or v_bundle -> 'sources' is distinct from (
      select pg_catalog.jsonb_agg(source order by source ->> 'source_id')
      from pg_catalog.jsonb_array_elements(v_bundle -> 'sources') source
    )
    or v_bundle -> 'items' is distinct from (
      select pg_catalog.jsonb_agg(item order by item ->> 'item_key')
      from pg_catalog.jsonb_array_elements(v_bundle -> 'items') item
    )
    or p_import_binding -> 'source_bindings' is distinct from (
      select pg_catalog.jsonb_agg(source order by source ->> 'source_id')
      from pg_catalog.jsonb_array_elements(p_import_binding -> 'source_bindings') source
    )
    or p_import_binding -> 'candidates' is distinct from (
      select pg_catalog.jsonb_agg(candidate order by
        candidate #>> array['metadata', 'stage1_candidate_import', 'item_key'])
      from pg_catalog.jsonb_array_elements(p_import_binding -> 'candidates') candidate
    )
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(v_bundle -> 'sources') reviewed_source
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_import_binding -> 'source_bindings') binding
        where binding ->> 'source_id' = reviewed_source ->> 'source_id'
      ) or not exists (
        select 1 from pg_catalog.jsonb_array_elements(v_bundle -> 'items') item
        where item ->> 'source_id' = reviewed_source ->> 'source_id'
      )
    )
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_import_binding -> 'source_bindings') binding
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(v_bundle -> 'sources') reviewed_source
        where reviewed_source ->> 'source_id' = binding ->> 'source_id'
      )
    )
  then
    raise exception using errcode = '22023',
      message = 'Candidate-import counts, cohort, or reviewer are invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_bundle_sha, 0)
  );

  if not exists (
    select 1 from public.stage1_award_registry registry
    join public.shared_awards award on award.id = registry.canonical_shared_award_id
    join public.stage1_award_members member on member.shared_award_id = award.id
    where registry.cohort_key = v_cohort_key
      and registry.canonical_shared_award_id = v_award_id
      and registry.policy_version = 'stage1-publication-v1'
      and registry.canonical_name = v_bundle #>> array['cohort', 'canonical_award', 'name']
      and registry.official_homepage = v_bundle #>> array['cohort', 'canonical_award', 'official_homepage']
      and award.id::text = p_import_binding #>> array['award', 'id']
      and award.status = 'active'
      and award.search_key = v_bundle #>> array['cohort', 'canonical_award', 'search_key']
      and award.name = v_bundle #>> array['cohort', 'canonical_award', 'name']
      and award.official_homepage = v_bundle #>> array['cohort', 'canonical_award', 'official_homepage']
      and award.updated_at = (p_import_binding #>> array['award', 'updated_at'])::timestamptz
      and member.cohort_key = v_cohort_key
      and member.member_kind = 'canonical'
  ) then
    raise exception using errcode = '40001',
      message = 'The reviewed canonical Stage 1 award changed before import.';
  end if;

  for v_source_binding in
    select value from pg_catalog.jsonb_array_elements(
      p_import_binding -> 'source_bindings'
    )
  loop
    select value into v_review_source
    from pg_catalog.jsonb_array_elements(v_bundle -> 'sources') reviewed_source(value)
    where value ->> 'source_id' = v_source_binding ->> 'source_id';
    if not found
      or private.stage1_jsonb_has_exact_keys(v_source_binding, array[
        'source_id', 'shared_award_id', 'source_url', 'source_title',
        'source_updated_at', 'last_checked_at', 'snapshot_updated_at',
        'captured_at', 'capture_text_sha256', 'capture_text_object_key',
        'official_identity', 'local_verified_at'
      ]) is not true
      or private.stage1_jsonb_has_exact_keys(v_review_source, array[
        'source_id', 'source_url', 'official_identity', 'source_updated_at',
        'last_checked_at', 'snapshot_updated_at', 'captured_at',
        'capture_text_sha256', 'capture_text_object_key'
      ]) is not true
      or private.stage1_jsonb_has_exact_keys(v_source_binding -> 'official_identity', array[
        'host', 'classification', 'evidence_url', 'reviewed_reason'
      ]) is not true
      or v_source_binding - array['shared_award_id', 'source_title', 'local_verified_at']
        is distinct from v_review_source
      or coalesce(v_source_binding ->> 'capture_text_sha256', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_source_binding ->> 'capture_text_object_key', '') !~
        ('^visual-snapshots/sources/' || (v_source_binding ->> 'source_id') ||
         '/captures/[0-9a-f]{32}/text[.]txt$')
      or coalesce(v_source_binding ->> 'local_verified_at', '') !~
        '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]\d{3}Z$'
      or v_source_binding ->> 'source_url' !~ '^https://'
      or v_source_binding ->> 'shared_award_id' !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or v_source_binding ->> 'source_id' !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or (v_source_binding ->> 'local_verified_at')::timestamptz <
        (v_source_binding ->> 'captured_at')::timestamptz
      or (v_source_binding ->> 'local_verified_at')::timestamptz < v_now - interval '24 hours'
      or (v_source_binding ->> 'local_verified_at')::timestamptz > v_now + interval '5 minutes'
      or (v_source_binding ->> 'last_checked_at')::timestamptz < v_now - interval '24 hours'
      or (v_source_binding ->> 'last_checked_at')::timestamptz > v_reviewed_at
      or (v_source_binding ->> 'source_updated_at')::timestamptz > v_reviewed_at + interval '5 minutes'
      or (v_source_binding ->> 'snapshot_updated_at')::timestamptz > v_reviewed_at + interval '5 minutes'
      or (v_source_binding ->> 'captured_at')::timestamptz > v_reviewed_at + interval '5 minutes'
      or private.stage1_https_host(v_source_binding ->> 'source_url') is distinct from
        v_source_binding #>> array['official_identity', 'host']
      or v_source_binding #>> array['official_identity', 'classification'] not in (
        'canonical_program_host', 'official_authority_host', 'official_contractor_host'
      )
      or v_source_binding #>> array['official_identity', 'evidence_url'] !~ '^https://'
      or nullif(pg_catalog.btrim(
        v_source_binding #>> array['official_identity', 'reviewed_reason']
      ), '') is null
      or (
        v_source_binding #>> array['official_identity', 'classification'] =
          'canonical_program_host'
        and (
          private.stage1_https_host(v_source_binding ->> 'source_url') is distinct from
            private.stage1_https_host(v_bundle #>> array['cohort', 'canonical_award', 'official_homepage'])
          or v_source_binding #>> array['official_identity', 'evidence_url'] is distinct from
            v_bundle #>> array['cohort', 'canonical_award', 'official_homepage']
        )
      )
      or (
        v_source_binding #>> array['official_identity', 'classification'] <>
          'canonical_program_host'
        and private.stage1_https_host(v_source_binding ->> 'source_url') =
          private.stage1_https_host(v_bundle #>> array['cohort', 'canonical_award', 'official_homepage'])
      )
      or (
        v_source_binding #>> array['official_identity', 'classification'] =
          'official_contractor_host'
        and private.stage1_https_host(
          v_source_binding #>> array['official_identity', 'evidence_url']
        ) is distinct from private.stage1_https_host(
          v_bundle #>> array['cohort', 'canonical_award', 'official_homepage']
        )
      )
      or (
        v_source_binding #>> array['official_identity', 'classification'] =
          'official_authority_host'
        and private.stage1_https_host(
          v_source_binding #>> array['official_identity', 'evidence_url']
        ) not in (
          private.stage1_https_host(v_source_binding ->> 'source_url'),
          private.stage1_https_host(v_bundle #>> array['cohort', 'canonical_award', 'official_homepage'])
        )
      )
      or not exists (
        select 1
        from public.shared_award_sources source
        join public.stage1_award_members member
          on member.shared_award_id = source.shared_award_id
        join public.shared_award_source_visual_snapshots snapshot
          on snapshot.shared_award_source_id = source.id
        where source.id = (v_source_binding ->> 'source_id')::uuid
          and member.cohort_key = v_cohort_key
          and source.shared_award_id = (v_source_binding ->> 'shared_award_id')::uuid
          and source.url = v_source_binding ->> 'source_url'
          and source.admin_review_status = 'open'
          and nullif(pg_catalog.btrim(source.last_error), '') is null
          and source.updated_at =
            (v_source_binding ->> 'source_updated_at')::timestamptz
          and source.last_checked_at =
            (v_source_binding ->> 'last_checked_at')::timestamptz
          and snapshot.updated_at =
            (v_source_binding ->> 'snapshot_updated_at')::timestamptz
          and snapshot.latest_captured_at =
            (v_source_binding ->> 'captured_at')::timestamptz
          and snapshot.latest_hashes ->> 'text_hash' =
            v_source_binding ->> 'capture_text_sha256'
          and snapshot.latest_object_keys ->> 'text' =
            v_source_binding ->> 'capture_text_object_key'
          and snapshot.kind in ('webpage', 'pdf')
          and not exists (
            select 1 from public.stage1_award_source_identity_rules identity_rule
            where identity_rule.cohort_key = v_cohort_key
              and identity_rule.policy_version = 'stage1-publication-v1'
              and (
                (identity_rule.url_pattern is not null and source.url ~* identity_rule.url_pattern)
                or (
                  identity_rule.title_pattern is not null
                  and coalesce(source.display_title, source.title, '') ~* identity_rule.title_pattern
                )
              )
          )
      )
    then
      raise exception using errcode = '40001',
        message = 'A reviewed source or immutable text pointer changed before import.';
    end if;
  end loop;

  select bundle.* into v_existing_bundle
  from private.stage1_reviewed_candidate_import_bundles bundle
  where bundle.bundle_sha256 = v_bundle_sha;
  if found then
    if v_existing_bundle.confirmation_sha256 is distinct from p_confirmation_sha256
      or v_existing_bundle.cohort_key is distinct from v_cohort_key
      or v_existing_bundle.canonical_shared_award_id is distinct from v_award_id
      or v_existing_bundle.reviewed_by is distinct from
        v_bundle #>> array['review', 'reviewed_by']
      or v_existing_bundle.reviewed_at is distinct from v_reviewed_at
      or v_existing_bundle.review_reason is distinct from
        v_bundle #>> array['review', 'reason']
      or v_existing_bundle.candidate_count is distinct from v_count
      or v_existing_bundle.review_bundle is distinct from v_bundle
      or private.stage1_stable_source_bindings(v_existing_bundle.source_bindings)
        is distinct from private.stage1_stable_source_bindings(
          p_import_binding -> 'source_bindings'
        )
      or v_existing_bundle.candidates_sha256 is distinct from v_candidates_sha
      or v_existing_bundle.confirmation_payload is distinct from v_confirmation
    then
      raise exception using errcode = '40001',
        message = 'A reviewed candidate-import bundle hash exists with different proof.';
    end if;
  else
    insert into private.stage1_reviewed_candidate_import_bundles (
      bundle_sha256,
      confirmation_sha256,
      cohort_key,
      canonical_shared_award_id,
      reviewed_by,
      reviewed_at,
      review_reason,
      candidate_count,
      review_bundle,
      source_bindings,
      source_bindings_sha256,
      candidates_sha256,
      confirmation_payload,
      import_binding_sha256
    ) values (
      v_bundle_sha,
      p_confirmation_sha256,
      v_cohort_key,
      v_award_id,
      v_bundle #>> array['review', 'reviewed_by'],
      v_reviewed_at,
      v_bundle #>> array['review', 'reason'],
      v_count,
      v_bundle,
      p_import_binding -> 'source_bindings',
      v_source_bindings_sha,
      v_candidates_sha,
      v_confirmation,
      v_import_binding_sha
    );
  end if;

  for v_candidate in
    select value from pg_catalog.jsonb_array_elements(
      p_import_binding -> 'candidates'
    )
  loop
    select value into v_bundle_item
    from pg_catalog.jsonb_array_elements(v_bundle -> 'items') item(value)
    where value ->> 'item_key' = v_candidate #>> array[
      'metadata', 'stage1_candidate_import', 'item_key'
    ];
    select value into v_source_binding
    from pg_catalog.jsonb_array_elements(
      p_import_binding -> 'source_bindings'
    ) binding(value)
    where value ->> 'source_id' = v_candidate ->> 'shared_award_source_id';
    v_item_sha := v_candidate #>> array[
      'metadata', 'stage1_candidate_import', 'item_sha256'
    ];
    if not found
      or private.stage1_jsonb_has_exact_keys(v_bundle_item, array[
        'item_key', 'source_id', 'source_relevance', 'field_name',
        'normalized_value', 'evidence_quote', 'evidence_location'
      ]) is not true
    then
      raise exception using errcode = '22023',
        message = 'A reviewed candidate has no unique exact reviewed item or source.';
    end if;
    v_expected_item_sha := private.stage1_canonical_json_sha256(
      pg_catalog.jsonb_build_object(
        'schema_version', 'awardping.stage1.reviewed-candidate-import-item.v1',
        'policy_version', 'stage1-publication-v1',
        'canonical_shared_award_id', v_award_id::text,
        'source_id', v_bundle_item ->> 'source_id',
        'source_url', v_source_binding ->> 'source_url',
        'source_relevance', v_bundle_item ->> 'source_relevance',
        'field_name', v_bundle_item ->> 'field_name',
        'normalized_value', v_bundle_item -> 'normalized_value',
        'evidence_quote', v_bundle_item ->> 'evidence_quote',
        'evidence_location', v_bundle_item ->> 'evidence_location',
        'capture_text_sha256', v_source_binding ->> 'capture_text_sha256',
        'capture_text_object_key', v_source_binding ->> 'capture_text_object_key'
      )
    );
    if private.stage1_jsonb_has_exact_keys(v_candidate, array[
        'id', 'shared_award_id', 'shared_award_source_id', 'source_url',
        'source_title', 'source_role', 'source_quality_decision', 'field_name',
        'raw_value', 'normalized_value', 'evidence_quote', 'evidence_location',
        'extracted_at', 'model', 'confidence', 'candidate_status',
        'rejection_reason', 'selected_reason', 'source_page_request_id',
        'intake_value_sha256', 'metadata'
      ]) is not true
      or private.stage1_jsonb_has_exact_keys(v_candidate -> 'metadata', array[
        'stage1_immutable_evidence', 'stage1_candidate_import'
      ]) is not true
      or private.stage1_jsonb_has_exact_keys(
        v_candidate #> array['metadata', 'stage1_immutable_evidence'],
        array[
          'schema_version', 'source_id', 'capture_text_sha256',
          'capture_text_object_key', 'evidence_quote_sha256', 'verification_method'
        ]
      ) is not true
      or private.stage1_jsonb_has_exact_keys(
        v_candidate #> array['metadata', 'stage1_candidate_import'],
        array[
          'schema_version', 'bundle_sha256', 'item_sha256', 'item_key',
          'reviewed_by', 'reviewed_at', 'review_reason', 'paid_api_calls'
        ]
      ) is not true
      or private.stage1_jsonb_has_exact_keys(v_candidate -> 'source_quality_decision', array[
        'decision', 'purpose', 'official_identity'
      ]) is not true
      or coalesce(v_item_sha, '') !~ '^[0-9a-f]{64}$'
      or v_item_sha is distinct from v_expected_item_sha
      or v_candidate #>> array[
        'metadata', 'stage1_candidate_import', 'bundle_sha256'
      ] is distinct from v_bundle_sha
      or v_candidate #>> array[
        'metadata', 'stage1_candidate_import', 'schema_version'
      ] is distinct from 'awardping.stage1.reviewed-candidate-import-item.v1'
      or v_candidate #>> array[
        'metadata', 'stage1_candidate_import', 'reviewed_by'
      ] is distinct from v_bundle #>> array['review', 'reviewed_by']
      or v_candidate #>> array[
        'metadata', 'stage1_candidate_import', 'reviewed_at'
      ] is distinct from v_bundle #>> array['review', 'reviewed_at']
      or v_candidate #>> array[
        'metadata', 'stage1_candidate_import', 'review_reason'
      ] is distinct from v_bundle #>> array['review', 'reason']
      or v_candidate #> array[
        'metadata', 'stage1_candidate_import', 'paid_api_calls'
      ] is distinct from '0'::jsonb
      -- A reviewed source may belong to a same-cohort alias. Keep the
      -- candidate attached to that real source owner while the import bundle,
      -- item hash, ledger, and later publication remain canonical-award bound.
      or v_candidate ->> 'shared_award_id' is distinct from
        v_source_binding ->> 'shared_award_id'
      or v_candidate ->> 'shared_award_source_id' is distinct from
        v_bundle_item ->> 'source_id'
      or v_candidate ->> 'source_url' is distinct from v_source_binding ->> 'source_url'
      or v_candidate -> 'source_title' is distinct from v_source_binding -> 'source_title'
      or v_candidate ->> 'source_role' is distinct from v_bundle_item ->> 'source_relevance'
      or v_candidate ->> 'source_role' not in ('primary', 'supporting')
      or v_candidate ->> 'field_name' is distinct from v_bundle_item ->> 'field_name'
      or v_candidate ->> 'field_name' not in (
        'overview', 'deadline', 'opening_date', 'award_amounts', 'eligibility',
        'requirements', 'application_materials', 'how_to_apply',
        'important_dates', 'documents', 'contacts', 'academic_levels',
        'disciplines', 'citizenship', 'confidence'
      )
      or v_candidate -> 'normalized_value' is distinct from
        v_bundle_item -> 'normalized_value'
      or v_bundle_item -> 'normalized_value' in (
        'null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb
      )
      or v_candidate ->> 'raw_value' is distinct from (case
        when pg_catalog.jsonb_typeof(v_bundle_item -> 'normalized_value') = 'string'
          then v_bundle_item #>> array['normalized_value']
        else private.stage1_canonical_json_text(v_bundle_item -> 'normalized_value')
      end)
      or nullif(pg_catalog.btrim(v_candidate ->> 'evidence_quote'), '') is null
      or v_candidate ->> 'evidence_quote' is distinct from
        v_bundle_item ->> 'evidence_quote'
      or v_candidate ->> 'evidence_location' is distinct from
        v_bundle_item ->> 'evidence_location'
      or private.stage1_evidence_location_is_valid(
        v_candidate ->> 'evidence_location'
      ) is not true
      or v_bundle_item ->> 'item_key' !~ '^[a-z0-9][a-z0-9._-]{0,119}$'
      or v_candidate ->> 'extracted_at' is distinct from
        v_bundle #>> array['review', 'reviewed_at']
      or v_candidate ->> 'candidate_status' is distinct from 'pending'
      or v_candidate ->> 'model' is distinct from
        'explicit-human-stage1-candidate-import'
      or v_candidate ->> 'confidence' is distinct from 'human_reviewed'
      or v_candidate -> 'rejection_reason' is distinct from 'null'::jsonb
      or v_candidate -> 'selected_reason' is distinct from 'null'::jsonb
      or v_candidate -> 'source_page_request_id' is distinct from 'null'::jsonb
      or v_candidate -> 'intake_value_sha256' is distinct from 'null'::jsonb
      or v_candidate #>> array['source_quality_decision', 'decision'] is distinct from 'approved'
      or v_candidate #>> array['source_quality_decision', 'purpose'] is distinct from
        'stage1_reviewed_candidate_import'
      or v_candidate #> array['source_quality_decision', 'official_identity'] is distinct from
        v_source_binding -> 'official_identity'
      or private.stage1_candidate_uuid_from_sha256(v_item_sha) is distinct from
        (v_candidate ->> 'id')::uuid
      or v_candidate #>> array[
        'metadata', 'stage1_immutable_evidence', 'schema_version'
      ] is distinct from 'awardping.stage1.candidate-immutable-evidence.v1'
      or v_candidate #>> array[
        'metadata', 'stage1_immutable_evidence', 'verification_method'
      ] is distinct from 'exact_local_text_substring'
      or v_candidate #>> array[
        'metadata', 'stage1_immutable_evidence', 'source_id'
      ] is distinct from v_candidate ->> 'shared_award_source_id'
      or v_candidate #>> array[
        'metadata', 'stage1_immutable_evidence', 'evidence_quote_sha256'
      ] is distinct from private.stage1_text_sha256(
        v_candidate ->> 'evidence_quote'
      )
      or v_candidate #>> array[
        'metadata', 'stage1_immutable_evidence', 'capture_text_sha256'
      ] is distinct from v_source_binding ->> 'capture_text_sha256'
      or v_candidate #>> array[
        'metadata', 'stage1_immutable_evidence', 'capture_text_object_key'
      ] is distinct from v_source_binding ->> 'capture_text_object_key'
    then
      raise exception using errcode = '22023',
        message = 'A reviewed candidate lacks exact item, evidence, or deterministic identity binding.';
    end if;

    select candidate.* into v_existing_candidate
    from public.shared_award_fact_candidates candidate
    where candidate.id = (v_candidate ->> 'id')::uuid;

    if found then
      select ledger.* into v_existing_ledger
      from private.stage1_reviewed_candidate_import_items ledger
      where ledger.candidate_id = v_existing_candidate.id;
      if v_existing_candidate.id is distinct from (v_candidate ->> 'id')::uuid
        or v_existing_candidate.shared_award_id is distinct from
          (v_candidate ->> 'shared_award_id')::uuid
        or v_existing_candidate.shared_award_source_id is distinct from
          (v_candidate ->> 'shared_award_source_id')::uuid
        or v_existing_candidate.source_url is distinct from v_candidate ->> 'source_url'
        or v_existing_candidate.source_title is distinct from
          v_candidate ->> 'source_title'
        or v_existing_candidate.source_role is distinct from v_candidate ->> 'source_role'
        or v_existing_candidate.source_quality_decision is distinct from
          v_candidate -> 'source_quality_decision'
        or v_existing_candidate.field_name is distinct from
          v_candidate ->> 'field_name'
        or v_existing_candidate.raw_value is distinct from v_candidate ->> 'raw_value'
        or v_existing_candidate.normalized_value is distinct from
          v_candidate -> 'normalized_value'
        or v_existing_candidate.evidence_quote is distinct from
          v_candidate ->> 'evidence_quote'
        or v_existing_candidate.evidence_location is distinct from
          v_candidate ->> 'evidence_location'
        or v_existing_candidate.extracted_at is distinct from
          (v_candidate ->> 'extracted_at')::timestamptz
        or v_existing_candidate.model is distinct from v_candidate ->> 'model'
        or v_existing_candidate.confidence is distinct from v_candidate ->> 'confidence'
        -- Status and disposition reasons are downstream lifecycle fields. An
        -- exact replay must never revert or reject a legitimately selected,
        -- conflicted, superseded, or rejected imported candidate.
        or v_existing_candidate.source_page_request_id is not null
        or v_existing_candidate.intake_value_sha256 is not null
        or v_existing_candidate.metadata is distinct from v_candidate -> 'metadata'
        or v_existing_ledger.item_sha256 is distinct from v_item_sha
        or v_existing_ledger.bundle_sha256 is distinct from v_bundle_sha
        or v_existing_ledger.candidate_id is distinct from v_existing_candidate.id
        or v_existing_ledger.canonical_shared_award_id is distinct from v_award_id
        or v_existing_ledger.source_id is distinct from
          (v_candidate ->> 'shared_award_source_id')::uuid
        or v_existing_ledger.field_name is distinct from v_candidate ->> 'field_name'
      then
        raise exception using errcode = '40001',
          message = 'An idempotent candidate identity exists with different evidence.';
      end if;
      v_existing := v_existing + 1;
      continue;
    end if;

    insert into public.shared_award_fact_candidates (
      id,
      shared_award_id,
      shared_award_source_id,
      source_url,
      source_title,
      source_role,
      source_quality_decision,
      field_name,
      raw_value,
      normalized_value,
      evidence_quote,
      evidence_location,
      extracted_at,
      model,
      confidence,
      candidate_status,
      rejection_reason,
      selected_reason,
      source_page_request_id,
      intake_value_sha256,
      metadata
    ) values (
      (v_candidate ->> 'id')::uuid,
      (v_candidate ->> 'shared_award_id')::uuid,
      (v_candidate ->> 'shared_award_source_id')::uuid,
      v_candidate ->> 'source_url',
      v_candidate ->> 'source_title',
      v_candidate ->> 'source_role',
      v_candidate -> 'source_quality_decision',
      v_candidate ->> 'field_name',
      v_candidate ->> 'raw_value',
      v_candidate -> 'normalized_value',
      v_candidate ->> 'evidence_quote',
      v_candidate ->> 'evidence_location',
      (v_candidate ->> 'extracted_at')::timestamptz,
      v_candidate ->> 'model',
      v_candidate ->> 'confidence',
      'pending',
      null,
      null,
      null,
      null,
      v_candidate -> 'metadata'
    );

    insert into private.stage1_reviewed_candidate_import_items (
      item_sha256,
      bundle_sha256,
      candidate_id,
      canonical_shared_award_id,
      source_id,
      field_name
    ) values (
      v_item_sha,
      v_bundle_sha,
      (v_candidate ->> 'id')::uuid,
      v_award_id,
      (v_candidate ->> 'shared_award_source_id')::uuid,
      v_candidate ->> 'field_name'
    );
    v_inserted := v_inserted + 1;
  end loop;

  select bundle.* into v_existing_bundle
  from private.stage1_reviewed_candidate_import_bundles bundle
  where bundle.bundle_sha256 = v_bundle_sha;
  if not found
    or v_existing_bundle.confirmation_sha256 is distinct from p_confirmation_sha256
    or v_existing_bundle.cohort_key is distinct from v_cohort_key
    or v_existing_bundle.canonical_shared_award_id is distinct from v_award_id
    or v_existing_bundle.reviewed_by is distinct from
      v_bundle #>> array['review', 'reviewed_by']
    or v_existing_bundle.reviewed_at is distinct from v_reviewed_at
    or v_existing_bundle.review_reason is distinct from
      v_bundle #>> array['review', 'reason']
    or v_existing_bundle.candidate_count is distinct from v_count
    or v_existing_bundle.review_bundle is distinct from v_bundle
    or private.stage1_stable_source_bindings(v_existing_bundle.source_bindings)
      is distinct from private.stage1_stable_source_bindings(
        p_import_binding -> 'source_bindings'
      )
    or v_existing_bundle.candidates_sha256 is distinct from v_candidates_sha
    or v_existing_bundle.confirmation_payload is distinct from v_confirmation
    or (select pg_catalog.count(*) from private.stage1_reviewed_candidate_import_items ledger
        where ledger.bundle_sha256 = v_bundle_sha) <> v_count
  then
    raise exception using errcode = '40001',
      message = 'Candidate-import durable proof differs from the exact reviewed import.';
  end if;

  return pg_catalog.jsonb_build_object(
    'status', 'succeeded',
    'bundle_sha256', v_bundle_sha,
    'confirmation_sha256', p_confirmation_sha256,
    'candidate_count', v_count,
    'inserted_count', v_inserted,
    'existing_count', v_existing,
    'paid_api_calls', 0,
    'source_mutations', 0,
    'release_mutations', 0,
    'reconciliation_mutations', 0,
    'publication_mutations', 0
  );
end;
$$;

revoke execute on function public.import_reviewed_stage1_fact_candidates(
  jsonb,
  text
) from public, anon, authenticated;
grant execute on function public.import_reviewed_stage1_fact_candidates(
  jsonb,
  text
) to service_role;

comment on function public.import_reviewed_stage1_fact_candidates(jsonb, text) is
  'Service-only atomic idempotent insertion of exact human-reviewed Stage 1 fact candidates. It never mutates sources, releases, reconciliation, publication state, or legacy candidate rows.';
