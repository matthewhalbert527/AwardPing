-- Durable provenance and truthful first-observation events for newly discovered
-- official PDFs. Legacy/unknown and bulk-onboarding work remains baseline-only.

alter table public.source_page_requests
  add column if not exists acquisition_kind text not null default 'legacy_unknown',
  add column if not exists notification_mode text not null default 'baseline_only',
  add column if not exists parent_shared_award_source_id uuid,
  add column if not exists onboarding_batch_id text;

alter table public.source_page_requests
  drop constraint if exists source_page_requests_acquisition_kind_check;
alter table public.source_page_requests
  add constraint source_page_requests_acquisition_kind_check check (
    acquisition_kind in (
      'live_discovery',
      'user_request',
      'admin_intake',
      'historical_import',
      'seed',
      'repair',
      'legacy_unknown',
      'operator_historical_exception'
    )
  );

alter table public.source_page_requests
  drop constraint if exists source_page_requests_notification_mode_check;
alter table public.source_page_requests
  add constraint source_page_requests_notification_mode_check check (
    notification_mode in ('first_capture_candidate', 'baseline_only', 'manual_review')
  );

create table if not exists public.shared_award_source_acquisitions (
  id uuid primary key default gen_random_uuid(),
  shared_award_source_id uuid not null unique
    references public.shared_award_sources(id) on delete restrict,
  acquisition_kind text not null check (
    acquisition_kind in (
      'live_discovery',
      'user_request',
      'admin_intake',
      'historical_import',
      'seed',
      'repair',
      'legacy_unknown',
      'operator_historical_exception'
    )
  ),
  notification_mode text not null check (
    notification_mode in ('first_capture_candidate', 'baseline_only', 'manual_review')
  ),
  -- Logical references intentionally survive privacy cleanup and source-intake
  -- history retention changes. The source itself is retained by the FK above.
  origin_source_page_request_id uuid,
  origin_worker_run_id uuid,
  parent_shared_award_source_id uuid,
  onboarding_batch_id text,
  review_seal jsonb not null default '{}'::jsonb check (
    jsonb_typeof(review_seal) = 'object'
  ),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object'
  ),
  acquired_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint shared_award_source_acquisitions_first_capture_check check (
    notification_mode <> 'first_capture_candidate'
    or ((
      acquisition_kind in ('live_discovery', 'operator_historical_exception')
      and onboarding_batch_id is null
      and review_seal -> 'sealed' = 'true'::jsonb
      and review_seal ->> 'status' = 'accepted'
      and review_seal ->> 'cycle_relevance' in ('current_or_upcoming', 'evergreen')
      and coalesce(review_seal ->> 'award_relevance', review_seal ->> 'source_relevance')
        in ('primary', 'supporting')
      and review_seal ->> 'officialness' in ('official', 'likely_official')
      and review_seal ->> 'confidence' in ('medium', 'high')
      and review_seal ->> 'page_type' = 'pdf'
      and review_seal ->> 'capture_file_hash' ~ '^[0-9a-f]{64}$'
      and review_seal -> 'exact_evidence_verified' = 'true'::jsonb
      and jsonb_typeof(review_seal -> 'evidence_quotes') = 'array'
      and jsonb_array_length(review_seal -> 'evidence_quotes') > 0
      and (
        acquisition_kind <> 'live_discovery'
        or (
          jsonb_typeof(review_seal -> 'retained_artifact') = 'object'
          and
          review_seal -> 'retained_artifact' = metadata -> 'retained_artifact'
          and review_seal -> 'retained_artifact' ->> 'namespace' = 'source-intake-first-observation'
          and review_seal -> 'retained_artifact' ->> 'request_id' = origin_source_page_request_id::text
          and review_seal -> 'retained_artifact' ->> 'file_hash' = review_seal ->> 'capture_file_hash'
          and coalesce(review_seal -> 'retained_artifact' ->> 'r2_verified_at', '')
            ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.+Z$'
          and coalesce(review_seal -> 'retained_artifact' ->> 'r2_bucket', '')
            ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
          and coalesce(review_seal -> 'retained_artifact' ->> 'r2_store_id', '')
            ~ '^[A-Za-z0-9][A-Za-z0-9.:-]{0,254}$'
          and review_seal -> 'retained_artifact' ->> 'prefix' =
            'source-intake-first-observation/v1/requests/' ||
            origin_source_page_request_id::text || '/sha256/' ||
            (review_seal ->> 'capture_file_hash')
          and review_seal -> 'retained_artifact' -> 'artifacts' -> 'pdf' ->> 'key' =
            (review_seal -> 'retained_artifact' ->> 'prefix') || '/document.pdf'
          and review_seal -> 'retained_artifact' -> 'artifacts' -> 'pdf' ->> 'sha256' =
            review_seal ->> 'capture_file_hash'
          and metadata -> 'server_artifact_binding' ->> 'source_id' = shared_award_source_id::text
          and metadata -> 'server_artifact_binding' ->> 'acquisition_id' = id::text
          and metadata -> 'server_artifact_binding' ->> 'request_id' = origin_source_page_request_id::text
          and metadata -> 'server_artifact_binding' ->> 'file_hash' = review_seal ->> 'capture_file_hash'
          and metadata -> 'server_artifact_binding' ->> 'final_url' = review_seal ->> 'capture_final_url'
          and metadata -> 'server_artifact_binding' ->> 'artifact_prefix' =
            review_seal -> 'retained_artifact' ->> 'prefix'
        )
      )
    ) is true)
  )
);

create index if not exists shared_award_source_acquisitions_mode_idx
  on public.shared_award_source_acquisitions (notification_mode, acquired_at asc);

alter table public.shared_award_source_acquisitions enable row level security;
revoke all on table public.shared_award_source_acquisitions
  from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.shared_award_source_acquisitions
  from service_role;
grant select on table public.shared_award_source_acquisitions to service_role;

create or replace function public.awardping_reject_source_acquisition_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Source acquisition provenance and its sealed review are immutable.';
end;
$$;

drop trigger if exists awardping_reject_source_acquisition_mutation_trigger
  on public.shared_award_source_acquisitions;
create trigger awardping_reject_source_acquisition_mutation_trigger
  before update or delete on public.shared_award_source_acquisitions
  for each row execute function public.awardping_reject_source_acquisition_mutation();

-- A parent source's first PDF-link scan is a seed sweep, not live discovery.
-- Only links first seen after this durable watermark can request a public
-- first-observation event. This makes enabling the 6 PM discovery scan safe for
-- an already-populated source catalog.
create table if not exists public.shared_award_source_discovery_states (
  shared_award_source_id uuid primary key
    references public.shared_award_sources(id) on delete cascade,
  pdf_seed_completed_at timestamptz not null,
  last_pdf_scan_at timestamptz not null,
  last_worker_run_id uuid,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shared_award_source_discovery_states_last_scan_idx
  on public.shared_award_source_discovery_states (last_pdf_scan_at asc);

alter table public.shared_award_source_discovery_states enable row level security;
revoke all on table public.shared_award_source_discovery_states
  from public, anon, authenticated, service_role;
grant select on table public.shared_award_source_discovery_states to service_role;

create table if not exists public.shared_award_source_discovered_links (
  parent_shared_award_source_id uuid not null
    references public.shared_award_sources(id) on delete cascade,
  url_hash text not null check (url_hash ~ '^[0-9a-f]{64}$'),
  normalized_url text not null,
  link_kind text not null default 'pdf' check (link_kind = 'pdf'),
  notification_mode text not null check (
    notification_mode in ('first_capture_candidate', 'baseline_only')
  ),
  onboarding_batch_id text,
  first_worker_run_id uuid,
  last_worker_run_id uuid,
  source_page_request_id uuid,
  prior_source_page_request_id uuid,
  notification_disposition text not null default 'unreviewed' check (
    notification_disposition in (
      'unreviewed',
      'no_prior_request',
      'baseline_prior_request_bound',
      'active_live_request_bound',
      'prior_non_live_request_requires_action',
      'prior_terminal_request_requires_action',
      'prior_request_requires_action',
      'quarantined_prior_request_conflict',
      'operator_approved_new_live_review_bound'
    )
  ),
  request_queued_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (parent_shared_award_source_id, url_hash)
);

alter table public.shared_award_source_discovered_links
  add column if not exists source_page_request_id uuid,
  add column if not exists prior_source_page_request_id uuid,
  add column if not exists notification_disposition text not null default 'unreviewed',
  add column if not exists request_queued_at timestamptz;

alter table public.shared_award_source_discovered_links
  drop constraint if exists shared_award_source_discovered_links_notification_disposition_check;
alter table public.shared_award_source_discovered_links
  add constraint shared_award_source_discovered_links_notification_disposition_check check (
    notification_disposition in (
      'unreviewed',
      'no_prior_request',
      'baseline_prior_request_bound',
      'active_live_request_bound',
      'prior_non_live_request_requires_action',
      'prior_terminal_request_requires_action',
      'prior_request_requires_action',
      'quarantined_prior_request_conflict',
      'operator_approved_new_live_review_bound'
    )
  );

comment on column public.shared_award_source_discovered_links.source_page_request_id is
  'Durable intake-attempt binding. Intentionally not a foreign key so request retention cannot erase paid-attempt deduplication.';
comment on column public.shared_award_source_discovered_links.prior_source_page_request_id is
  'Conflicting prior intake request retained for operator evidence; it is not an eligible live-attempt binding.';
comment on column public.shared_award_source_discovered_links.notification_disposition is
  'Whether the post-seed notification can safely queue, reuses an active eligible live request, or requires quarantine.';

create index if not exists shared_award_source_discovered_links_mode_idx
  on public.shared_award_source_discovered_links (notification_mode, first_seen_at asc);
create index if not exists shared_award_source_discovered_links_request_idx
  on public.shared_award_source_discovered_links (source_page_request_id)
  where source_page_request_id is not null;

alter table public.shared_award_source_discovered_links enable row level security;
revoke all on table public.shared_award_source_discovered_links
  from public, anon, authenticated, service_role;
grant select on table public.shared_award_source_discovered_links to service_role;

create or replace function public.register_shared_award_source_pdf_links(
  p_source_id uuid,
  p_urls jsonb,
  p_worker_run_id uuid default null,
  p_live_requested boolean default false,
  p_onboarding_batch_id text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_scan_complete boolean default false
)
returns table(
  normalized_url text,
  notification_mode text,
  onboarding_batch_id text,
  source_page_request_id uuid,
  prior_source_page_request_id uuid,
  notification_disposition text,
  first_seen boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_source public.shared_award_sources%rowtype;
  v_award_name text;
  v_link public.shared_award_source_discovered_links%rowtype;
  v_request public.source_page_requests%rowtype;
  v_item jsonb;
  v_url text;
  v_url_hash text;
  v_seed_completed boolean := false;
  v_inserted boolean;
  v_notification_mode text;
  v_onboarding_batch_id text;
begin
  if p_source_id is null
    or p_urls is null
    or jsonb_typeof(p_urls) <> 'array'
    or jsonb_array_length(p_urls) > 500
    or p_live_requested is null
    or p_scan_complete is null
    or p_metadata is null
    or jsonb_typeof(p_metadata) <> 'object' then
    raise exception using errcode = '22023', message = 'PDF link registration payload is invalid.';
  end if;

  select source.* into strict v_source
  from public.shared_award_sources source
  join public.shared_awards award on award.id = source.shared_award_id
  where source.id = p_source_id
    and source.admin_review_status = 'open'
    and award.status = 'active'
  for update of source;

  select award.name into strict v_award_name
  from public.shared_awards award
  where award.id = v_source.shared_award_id;

  perform 1
  from public.shared_award_source_discovery_states state
  where state.shared_award_source_id = p_source_id
  for update;
  v_seed_completed := found;

  for v_item in
    select item.value
    from jsonb_array_elements(p_urls) item(value)
  loop
    if jsonb_typeof(v_item) <> 'string' then
      raise exception using errcode = '22023', message = 'Every discovered PDF URL must be a string.';
    end if;
    v_url := btrim(v_item #>> '{}');
    if v_url = '' or length(v_url) > 4096 or v_url !~* '^https?://' then
      raise exception using errcode = '22023', message = 'A discovered PDF URL is invalid.';
    end if;
    v_url_hash := public.awardping_sha256_text(v_url);
    v_notification_mode := case
      -- Once a complete scan has established the durable seed watermark, every
      -- first-seen URL is provably post-seed even when this particular scan was
      -- truncated. Completeness gates creation of the watermark, not later live
      -- discovery, so large pages cannot silently baseline newly added PDFs.
      when v_seed_completed
        and p_live_requested
        and nullif(btrim(p_onboarding_batch_id), '') is null
      then 'first_capture_candidate'
      else 'baseline_only'
    end;
    v_onboarding_batch_id := case
      when v_notification_mode = 'first_capture_candidate' then null
      else coalesce(nullif(btrim(p_onboarding_batch_id), ''), 'pdf_seed:' || p_source_id::text)
    end;

    insert into public.shared_award_source_discovered_links (
      parent_shared_award_source_id,
      url_hash,
      normalized_url,
      notification_mode,
      onboarding_batch_id,
      first_worker_run_id,
      last_worker_run_id,
      metadata,
      first_seen_at,
      last_seen_at
    ) values (
      p_source_id,
      v_url_hash,
      v_url,
      v_notification_mode,
      v_onboarding_batch_id,
      p_worker_run_id,
      p_worker_run_id,
      p_metadata,
      v_now,
      v_now
    )
    on conflict (parent_shared_award_source_id, url_hash) do nothing
    returning * into v_link;
    v_inserted := found;

    if not v_inserted then
      select link.* into strict v_link
      from public.shared_award_source_discovered_links link
      where link.parent_shared_award_source_id = p_source_id
        and link.url_hash = v_url_hash
      for update;
      if v_link.normalized_url is distinct from v_url then
        raise exception using errcode = '23514', message = 'A discovered PDF URL hash collision was detected.';
      end if;
      update public.shared_award_source_discovered_links link
      set
        last_worker_run_id = p_worker_run_id,
        last_seen_at = v_now,
        metadata = link.metadata || p_metadata
      where link.parent_shared_award_source_id = p_source_id
        and link.url_hash = v_url_hash
      returning link.* into v_link;
    end if;

    -- A live post-seed discovery may only reuse an in-flight request whose
    -- immutable flags already describe this exact live attempt. Historical,
    -- terminal, and ambiguously scoped requests remain evidence for an operator
    -- quarantine; they must never silently suppress the new link or be relabeled
    -- as live. Baseline-only seed work can still bind any prior request because
    -- it cannot publish a first-observation event.
    if v_link.source_page_request_id is null
      and v_link.prior_source_page_request_id is null then
      select request.*
      into v_request
      from public.source_page_requests request
      where (
          request.normalized_url = v_url
          or request.homepage_url = v_url
          or request.submitted_url = v_url
        )
        and (
          request.parent_shared_award_source_id = p_source_id
          or request.matched_shared_award_id = v_source.shared_award_id
          or (
            request.parent_shared_award_source_id is null
            and request.matched_shared_award_id is null
            and lower(regexp_replace(btrim(request.award_name), '\s+', ' ', 'g')) =
              lower(regexp_replace(btrim(v_award_name), '\s+', ' ', 'g'))
          )
        )
      order by
        case
          when v_link.notification_mode = 'first_capture_candidate'
            and request.acquisition_kind = 'live_discovery'
            and request.notification_mode = 'first_capture_candidate'
            and request.onboarding_batch_id is null
            and request.parent_shared_award_source_id = p_source_id
            and request.normalized_url = v_url
            and request.status in (
              'pending',
              'queued',
              'validating',
              'capturing',
              'ai_review_pending',
              'ai_review_submitted',
              'ai_review_succeeded',
              'matching'
            ) then 0
          when request.parent_shared_award_source_id = p_source_id then 1
          when request.matched_shared_award_id = v_source.shared_award_id then 2
          else 3
        end,
        request.created_at desc,
        request.id desc
      limit 1;

      if found and (
        v_link.notification_mode = 'baseline_only'
        or (
          v_request.acquisition_kind = 'live_discovery'
          and v_request.notification_mode = 'first_capture_candidate'
          and v_request.onboarding_batch_id is null
          and v_request.parent_shared_award_source_id = p_source_id
          and v_request.normalized_url = v_url
          and v_request.status in (
            'pending',
            'queued',
            'validating',
            'capturing',
            'ai_review_pending',
            'ai_review_submitted',
            'ai_review_succeeded',
            'matching'
          )
        )
      ) then
        update public.shared_award_source_discovered_links link
        set
          source_page_request_id = v_request.id,
          prior_source_page_request_id = null,
          notification_disposition = case
            when v_link.notification_mode = 'first_capture_candidate'
              then 'active_live_request_bound'
            else 'baseline_prior_request_bound'
          end,
          request_queued_at = coalesce(link.request_queued_at, v_request.created_at),
          last_seen_at = v_now
        where link.parent_shared_award_source_id = p_source_id
          and link.url_hash = v_url_hash
          and link.source_page_request_id is null
        returning link.* into v_link;
      elsif found then
        update public.shared_award_source_discovered_links link
        set
          prior_source_page_request_id = v_request.id,
          notification_disposition = case
            when v_request.status in ('added', 'rejected', 'failed', 'needs_manual_review')
              then 'prior_terminal_request_requires_action'
            when v_request.acquisition_kind <> 'live_discovery'
              or v_request.notification_mode <> 'first_capture_candidate'
              or v_request.onboarding_batch_id is not null
              then 'prior_non_live_request_requires_action'
            else 'prior_request_requires_action'
          end,
          last_seen_at = v_now
        where link.parent_shared_award_source_id = p_source_id
          and link.url_hash = v_url_hash
          and link.source_page_request_id is null
          and link.prior_source_page_request_id is null
        returning link.* into v_link;
      elsif v_link.notification_mode = 'first_capture_candidate' then
        update public.shared_award_source_discovered_links link
        set
          notification_disposition = 'no_prior_request',
          last_seen_at = v_now
        where link.parent_shared_award_source_id = p_source_id
          and link.url_hash = v_url_hash
          and link.source_page_request_id is null
          and link.prior_source_page_request_id is null
        returning link.* into v_link;
      end if;
    end if;

    normalized_url := v_link.normalized_url;
    notification_mode := v_link.notification_mode;
    onboarding_batch_id := v_link.onboarding_batch_id;
    source_page_request_id := v_link.source_page_request_id;
    prior_source_page_request_id := v_link.prior_source_page_request_id;
    notification_disposition := v_link.notification_disposition;
    first_seen := v_inserted;
    return next;
  end loop;

  -- A truncated first scan may safely record every visible URL as baseline, but
  -- it cannot establish that the parent's historical link set has been seeded.
  -- The first later complete scan is therefore also baseline-only and is the
  -- only scan allowed to create the seed-completed watermark.
  if v_seed_completed or p_scan_complete then
    insert into public.shared_award_source_discovery_states (
      shared_award_source_id,
      pdf_seed_completed_at,
      last_pdf_scan_at,
      last_worker_run_id,
      metadata,
      updated_at
    ) values (
      p_source_id,
      v_now,
      v_now,
      p_worker_run_id,
      p_metadata || jsonb_build_object(
        'last_live_requested', p_live_requested,
        'last_scan_complete', p_scan_complete,
        'last_observed_pdf_url_count', jsonb_array_length(p_urls)
      ),
      v_now
    )
    on conflict (shared_award_source_id) do update
    set
      last_pdf_scan_at = excluded.last_pdf_scan_at,
      last_worker_run_id = excluded.last_worker_run_id,
      metadata = public.shared_award_source_discovery_states.metadata || excluded.metadata,
      updated_at = excluded.updated_at;
  end if;
exception
  when no_data_found then
    raise exception using errcode = '23503', message = 'PDF link registration references missing discovery provenance.';
end;
$$;

revoke all on function public.register_shared_award_source_pdf_links(uuid, jsonb, uuid, boolean, text, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.register_shared_award_source_pdf_links(uuid, jsonb, uuid, boolean, text, jsonb, boolean)
  to service_role;

create or replace function public.bind_shared_award_discovered_link_request(
  p_parent_source_id uuid,
  p_normalized_url text,
  p_source_page_request_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.shared_award_sources%rowtype;
  v_award_name text;
  v_link public.shared_award_source_discovered_links%rowtype;
  v_request public.source_page_requests%rowtype;
  v_conflicting_request public.source_page_requests%rowtype;
  v_url text := btrim(coalesce(p_normalized_url, ''));
  v_url_hash text;
begin
  if p_parent_source_id is null
    or p_source_page_request_id is null
    or v_url = ''
    or length(v_url) > 4096
    or v_url !~* '^https?://' then
    raise exception using errcode = '22023', message = 'Discovered PDF request binding payload is invalid.';
  end if;

  select source.* into strict v_source
  from public.shared_award_sources source
  where source.id = p_parent_source_id
  for update;

  select award.name into strict v_award_name
  from public.shared_awards award
  where award.id = v_source.shared_award_id;

  v_url_hash := public.awardping_sha256_text(v_url);
  select link.* into strict v_link
  from public.shared_award_source_discovered_links link
  where link.parent_shared_award_source_id = p_parent_source_id
    and link.url_hash = v_url_hash
  for update;

  if v_link.normalized_url is distinct from v_url then
    raise exception using errcode = '23514', message = 'The discovered PDF URL does not match its ledger entry.';
  end if;

  select request.* into strict v_request
  from public.source_page_requests request
  where request.id = p_source_page_request_id
  for update;

  if not (
      v_request.normalized_url is not distinct from v_url
      or v_request.homepage_url is not distinct from v_url
      or v_request.submitted_url is not distinct from v_url
    )
    or not (
      v_request.parent_shared_award_source_id = p_parent_source_id
      or v_request.matched_shared_award_id = v_source.shared_award_id
      or (
        v_request.parent_shared_award_source_id is null
        and v_request.matched_shared_award_id is null
        and lower(regexp_replace(btrim(v_request.award_name), '\s+', ' ', 'g')) =
          lower(regexp_replace(btrim(v_award_name), '\s+', ' ', 'g'))
      )
    ) then
    raise exception using errcode = '23514', message = 'The source intake request does not match the discovered PDF provenance.';
  end if;

  if v_link.source_page_request_id is not null
    and v_link.source_page_request_id <> p_source_page_request_id then
    raise exception using errcode = '23514', message = 'The discovered PDF is already bound to another intake request.';
  end if;

  if v_link.notification_mode = 'first_capture_candidate'
    and v_link.source_page_request_id is null
    and v_link.prior_source_page_request_id is null then
    select request.* into v_conflicting_request
    from public.source_page_requests request
    where request.id <> p_source_page_request_id
      and (
        request.normalized_url = v_url
        or request.homepage_url = v_url
        or request.submitted_url = v_url
      )
      and (
        request.parent_shared_award_source_id = p_parent_source_id
        or request.matched_shared_award_id = v_source.shared_award_id
        or (
          request.parent_shared_award_source_id is null
          and request.matched_shared_award_id is null
          and lower(regexp_replace(btrim(request.award_name), '\s+', ' ', 'g')) =
            lower(regexp_replace(btrim(v_award_name), '\s+', ' ', 'g'))
        )
      )
    order by request.created_at desc, request.id desc
    limit 1
    for share;

    if found then
      update public.source_page_requests request
      set
        status = 'needs_manual_review',
        status_reason = 'discovered_pdf_prior_request_conflict_no_charge',
        worker_run_id = null,
        error = 'A prior request for this post-seed PDF requires provenance review before any paid live review can start.',
        updated_at = now()
      where request.id = v_request.id
        and request.status in ('pending', 'queued');

      update public.shared_award_source_discovered_links link
      set
        prior_source_page_request_id = v_conflicting_request.id,
        notification_disposition = case
          when v_conflicting_request.status in ('added', 'rejected', 'failed', 'needs_manual_review')
            then 'prior_terminal_request_requires_action'
          when v_conflicting_request.acquisition_kind <> 'live_discovery'
            or v_conflicting_request.notification_mode <> 'first_capture_candidate'
            or v_conflicting_request.onboarding_batch_id is not null
            then 'prior_non_live_request_requires_action'
          else 'prior_request_requires_action'
        end,
        metadata = link.metadata || jsonb_build_object(
          'unbound_no_charge_request_id', v_request.id,
          'prior_request_conflict_detected_at', now()
        ),
        last_seen_at = greatest(link.last_seen_at, now())
      where link.parent_shared_award_source_id = p_parent_source_id
        and link.url_hash = v_url_hash;
      return false;
    end if;
  end if;

  if v_link.notification_mode = 'first_capture_candidate'
    and (
      v_link.prior_source_page_request_id is not null
      or v_request.acquisition_kind <> 'live_discovery'
      or v_request.notification_mode <> 'first_capture_candidate'
      or v_request.onboarding_batch_id is not null
      or v_request.parent_shared_award_source_id is distinct from p_parent_source_id
      or v_request.normalized_url is distinct from v_url
      or v_request.status not in (
        'pending',
        'queued',
        'validating',
        'capturing',
        'ai_review_pending',
        'ai_review_submitted',
        'ai_review_succeeded',
        'matching'
      )
    ) then
    raise exception using
      errcode = '23514',
      message = 'A live discovered PDF can only bind an active request with the same immutable live provenance.';
  end if;

  update public.shared_award_source_discovered_links link
  set
    source_page_request_id = p_source_page_request_id,
    prior_source_page_request_id = null,
    notification_disposition = case
      when link.notification_mode = 'first_capture_candidate'
        then 'active_live_request_bound'
      else 'baseline_prior_request_bound'
    end,
    request_queued_at = coalesce(link.request_queued_at, v_request.created_at),
    last_seen_at = greatest(link.last_seen_at, now())
  where link.parent_shared_award_source_id = p_parent_source_id
    and link.url_hash = v_url_hash;

  return true;
exception
  when no_data_found then
    raise exception using errcode = '23503', message = 'Discovered PDF request binding references missing provenance.';
end;
$$;

revoke all on function public.bind_shared_award_discovered_link_request(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.bind_shared_award_discovered_link_request(uuid, text, uuid)
  to service_role;

create or replace function public.create_and_bind_shared_award_discovered_link_request(
  p_parent_source_id uuid,
  p_normalized_url text,
  p_request jsonb
)
returns table(
  source_page_request_id uuid,
  created boolean,
  notification_disposition text,
  prior_source_page_request_id uuid,
  quarantine_required boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_url text := btrim(coalesce(p_normalized_url, ''));
  v_url_hash text;
  v_source public.shared_award_sources%rowtype;
  v_link public.shared_award_source_discovered_links%rowtype;
  v_existing public.source_page_requests%rowtype;
  v_inserted public.source_page_requests%rowtype;
  v_matched_award_id uuid;
  v_parent_source_id uuid;
  v_award_name text;
  v_expected_award_name text;
  v_homepage_url text;
  v_submitted_url text;
  v_request_normalized_url text;
  v_intake_type text;
  v_notes text;
  v_status text;
  v_status_reason text;
  v_acquisition_kind text;
  v_notification_mode text;
  v_onboarding_batch_id text;
begin
  if p_parent_source_id is null
    or v_url = ''
    or length(v_url) > 4096
    or v_url !~* '^https?://'
    or p_request is null
    or jsonb_typeof(p_request) <> 'object'
    or p_request - array[
      'award_name',
      'homepage_url',
      'submitted_url',
      'normalized_url',
      'intake_type',
      'notes',
      'status',
      'status_reason',
      'matched_shared_award_id',
      'acquisition_kind',
      'notification_mode',
      'parent_shared_award_source_id',
      'onboarding_batch_id'
    ]::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Atomic discovered PDF request payload is invalid.';
  end if;

  begin
    v_matched_award_id := nullif(p_request ->> 'matched_shared_award_id', '')::uuid;
    v_parent_source_id := nullif(p_request ->> 'parent_shared_award_source_id', '')::uuid;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Atomic discovered PDF request identifiers must be valid UUIDs.';
  end;
  v_award_name := nullif(btrim(p_request ->> 'award_name'), '');
  v_homepage_url := nullif(btrim(p_request ->> 'homepage_url'), '');
  v_submitted_url := nullif(btrim(p_request ->> 'submitted_url'), '');
  v_request_normalized_url := nullif(btrim(p_request ->> 'normalized_url'), '');
  v_intake_type := nullif(btrim(p_request ->> 'intake_type'), '');
  v_notes := nullif(btrim(p_request ->> 'notes'), '');
  v_status := nullif(btrim(p_request ->> 'status'), '');
  v_status_reason := nullif(btrim(p_request ->> 'status_reason'), '');
  v_acquisition_kind := nullif(btrim(p_request ->> 'acquisition_kind'), '');
  v_notification_mode := nullif(btrim(p_request ->> 'notification_mode'), '');
  v_onboarding_batch_id := nullif(btrim(p_request ->> 'onboarding_batch_id'), '');

  if v_award_name is null
    or length(v_award_name) > 1000
    or v_homepage_url is distinct from v_url
    or v_request_normalized_url is distinct from v_url
    or v_submitted_url is null
    or length(v_submitted_url) > 4096
    or v_submitted_url !~* '^https?://'
    or v_intake_type <> 'official_source'
    or v_status <> 'pending'
    or v_status_reason is null
    or v_matched_award_id is null
    or v_parent_source_id is distinct from p_parent_source_id then
    raise exception using errcode = '23514', message = 'Atomic discovered PDF request identity does not match its ledger link.';
  end if;

  select source.* into strict v_source
  from public.shared_award_sources source
  join public.shared_awards award on award.id = source.shared_award_id
  where source.id = p_parent_source_id
    and source.admin_review_status = 'open'
    and award.status = 'active'
  for update of source;
  if v_matched_award_id is distinct from v_source.shared_award_id then
    raise exception using errcode = '23514', message = 'Atomic discovered PDF request award does not match its parent source.';
  end if;
  select regexp_replace(btrim(award.name), '\s+', ' ', 'g')
  into strict v_expected_award_name
  from public.shared_awards award
  where award.id = v_source.shared_award_id;
  if v_award_name is distinct from v_expected_award_name then
    raise exception using errcode = '23514', message = 'Atomic discovered PDF request award name does not match its authoritative award.';
  end if;
  -- Use the server-owned canonical spelling in both uniqueness checks and the
  -- inserted row; a service payload cannot bypass deduplication with spacing or
  -- case aliases.
  v_award_name := v_expected_award_name;

  v_url_hash := public.awardping_sha256_text(v_url);
  select link.* into strict v_link
  from public.shared_award_source_discovered_links link
  where link.parent_shared_award_source_id = p_parent_source_id
    and link.url_hash = v_url_hash
    and link.normalized_url = v_url
  for update;

  if v_link.notification_mode = 'first_capture_candidate' then
    if v_link.onboarding_batch_id is not null
      or v_acquisition_kind <> 'live_discovery'
      or v_notification_mode <> 'first_capture_candidate'
      or v_onboarding_batch_id is not null then
      raise exception using errcode = '23514', message = 'A post-seed PDF link requires an exact live-discovery request.';
    end if;
  elsif v_acquisition_kind <> 'historical_import'
    or v_notification_mode <> 'baseline_only'
    or v_onboarding_batch_id is null
    or v_onboarding_batch_id is distinct from v_link.onboarding_batch_id then
    raise exception using errcode = '23514', message = 'A baseline-only PDF link requires matching historical-onboarding provenance.';
  end if;

  if v_link.source_page_request_id is not null then
    source_page_request_id := v_link.source_page_request_id;
    created := false;
    notification_disposition := v_link.notification_disposition;
    prior_source_page_request_id := v_link.prior_source_page_request_id;
    quarantine_required := false;
    return next;
    return;
  end if;
  if v_link.prior_source_page_request_id is not null then
    source_page_request_id := null;
    created := false;
    notification_disposition := v_link.notification_disposition;
    prior_source_page_request_id := v_link.prior_source_page_request_id;
    quarantine_required := true;
    return next;
    return;
  end if;

  select request.* into v_existing
  from public.source_page_requests request
  where (
      request.normalized_url = v_url
      or request.homepage_url = v_url
      or request.submitted_url = v_url
    )
    and (
      request.parent_shared_award_source_id = p_parent_source_id
      or request.matched_shared_award_id = v_source.shared_award_id
      or (
        request.parent_shared_award_source_id is null
        and request.matched_shared_award_id is null
        and lower(regexp_replace(btrim(request.award_name), '\s+', ' ', 'g')) =
          lower(regexp_replace(btrim(v_award_name), '\s+', ' ', 'g'))
      )
    )
  order by
    case
      when v_link.notification_mode = 'first_capture_candidate'
        and request.acquisition_kind = 'live_discovery'
        and request.notification_mode = 'first_capture_candidate'
        and request.onboarding_batch_id is null
        and request.parent_shared_award_source_id = p_parent_source_id
        and request.normalized_url = v_url
        and request.status in (
          'pending', 'queued', 'validating', 'capturing', 'ai_review_pending',
          'ai_review_submitted', 'ai_review_succeeded', 'matching'
        ) then 0
      else 1
    end,
    request.created_at desc,
    request.id desc
  limit 1
  for share;

  if found then
    if v_link.notification_mode = 'baseline_only'
      or (
        v_existing.acquisition_kind = 'live_discovery'
        and v_existing.notification_mode = 'first_capture_candidate'
        and v_existing.onboarding_batch_id is null
        and v_existing.parent_shared_award_source_id = p_parent_source_id
        and v_existing.normalized_url = v_url
        and v_existing.status in (
          'pending', 'queued', 'validating', 'capturing', 'ai_review_pending',
          'ai_review_submitted', 'ai_review_succeeded', 'matching'
        )
      ) then
      update public.shared_award_source_discovered_links link
      set
        source_page_request_id = v_existing.id,
        notification_disposition = case
          when link.notification_mode = 'first_capture_candidate'
            then 'active_live_request_bound'
          else 'baseline_prior_request_bound'
        end,
        request_queued_at = coalesce(link.request_queued_at, v_existing.created_at),
        last_seen_at = greatest(link.last_seen_at, v_now)
      where link.parent_shared_award_source_id = p_parent_source_id
        and link.url_hash = v_url_hash
      returning link.* into v_link;
      source_page_request_id := v_existing.id;
      created := false;
      notification_disposition := v_link.notification_disposition;
      prior_source_page_request_id := null;
      quarantine_required := false;
      return next;
      return;
    end if;

    update public.shared_award_source_discovered_links link
    set
      prior_source_page_request_id = v_existing.id,
      notification_disposition = case
        when v_existing.status in ('added', 'rejected', 'failed', 'needs_manual_review')
          then 'prior_terminal_request_requires_action'
        when v_existing.acquisition_kind <> 'live_discovery'
          or v_existing.notification_mode <> 'first_capture_candidate'
          or v_existing.onboarding_batch_id is not null
          then 'prior_non_live_request_requires_action'
        else 'prior_request_requires_action'
      end,
      last_seen_at = greatest(link.last_seen_at, v_now)
    where link.parent_shared_award_source_id = p_parent_source_id
      and link.url_hash = v_url_hash
    returning link.* into v_link;
    source_page_request_id := null;
    created := false;
    notification_disposition := v_link.notification_disposition;
    prior_source_page_request_id := v_existing.id;
    quarantine_required := true;
    return next;
    return;
  end if;

  begin
    insert into public.source_page_requests (
      award_name,
      homepage_url,
      submitted_url,
      normalized_url,
      intake_type,
      notes,
      status,
      status_reason,
      matched_shared_award_id,
      acquisition_kind,
      notification_mode,
      parent_shared_award_source_id,
      onboarding_batch_id,
      created_at,
      updated_at
    ) values (
      v_award_name,
      v_homepage_url,
      v_submitted_url,
      v_request_normalized_url,
      v_intake_type,
      v_notes,
      'pending',
      v_status_reason,
      v_matched_award_id,
      v_acquisition_kind,
      v_notification_mode,
      v_parent_source_id,
      v_onboarding_batch_id,
      v_now,
      v_now
    )
    returning * into v_inserted;
  exception
    when unique_violation then
      select request.* into strict v_existing
      from public.source_page_requests request
      where request.normalized_url = v_url
        and lower(coalesce(nullif(request.award_name, ''), '')) =
          lower(coalesce(nullif(v_award_name, ''), ''))
        and request.status in (
          'pending', 'queued', 'validating', 'capturing', 'ai_review_pending',
          'ai_review_submitted', 'ai_review_succeeded', 'matching', 'needs_manual_review'
        )
      order by request.created_at desc, request.id desc
      limit 1
      for share;

      if v_existing.acquisition_kind = 'live_discovery'
        and v_existing.notification_mode = 'first_capture_candidate'
        and v_existing.onboarding_batch_id is null
        and v_existing.parent_shared_award_source_id = p_parent_source_id
        and v_existing.normalized_url = v_url
        and v_existing.status <> 'needs_manual_review' then
        update public.shared_award_source_discovered_links link
        set
          source_page_request_id = v_existing.id,
          notification_disposition = 'active_live_request_bound',
          request_queued_at = coalesce(link.request_queued_at, v_existing.created_at),
          last_seen_at = greatest(link.last_seen_at, v_now)
        where link.parent_shared_award_source_id = p_parent_source_id
          and link.url_hash = v_url_hash;
        source_page_request_id := v_existing.id;
        created := false;
        notification_disposition := 'active_live_request_bound';
        prior_source_page_request_id := null;
        quarantine_required := false;
        return next;
        return;
      end if;

      update public.shared_award_source_discovered_links link
      set
        prior_source_page_request_id = v_existing.id,
        notification_disposition = case
          when v_existing.status = 'needs_manual_review'
            then 'prior_terminal_request_requires_action'
          else 'prior_non_live_request_requires_action'
        end,
        last_seen_at = greatest(link.last_seen_at, v_now)
      where link.parent_shared_award_source_id = p_parent_source_id
        and link.url_hash = v_url_hash
      returning link.* into v_link;
      source_page_request_id := null;
      created := false;
      notification_disposition := v_link.notification_disposition;
      prior_source_page_request_id := v_existing.id;
      quarantine_required := true;
      return next;
      return;
  end;

  update public.shared_award_source_discovered_links link
  set
    source_page_request_id = v_inserted.id,
    prior_source_page_request_id = null,
    notification_disposition = case
      when link.notification_mode = 'first_capture_candidate'
        then 'active_live_request_bound'
      else 'baseline_prior_request_bound'
    end,
    request_queued_at = coalesce(link.request_queued_at, v_inserted.created_at),
    last_seen_at = greatest(link.last_seen_at, v_now)
  where link.parent_shared_award_source_id = p_parent_source_id
    and link.url_hash = v_url_hash
  returning link.* into v_link;

  source_page_request_id := v_inserted.id;
  created := true;
  notification_disposition := v_link.notification_disposition;
  prior_source_page_request_id := null;
  quarantine_required := false;
  return next;
exception
  when no_data_found then
    raise exception using errcode = '23503', message = 'Atomic discovered PDF request creation references missing provenance.';
end;
$$;

revoke all on function public.create_and_bind_shared_award_discovered_link_request(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_and_bind_shared_award_discovered_link_request(uuid, text, jsonb)
  to service_role;

create or replace function public.record_shared_award_discovered_link_quarantine(
  p_parent_source_id uuid,
  p_normalized_url text,
  p_prior_source_page_request_id uuid,
  p_evidence jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_url text := btrim(coalesce(p_normalized_url, ''));
  v_source public.shared_award_sources%rowtype;
  v_link public.shared_award_source_discovered_links%rowtype;
  v_request public.source_page_requests%rowtype;
  v_evidence jsonb;
  v_quarantine_id uuid;
begin
  if p_parent_source_id is null
    or p_prior_source_page_request_id is null
    or v_url = ''
    or length(v_url) > 4096
    or v_url !~* '^https?://'
    or p_evidence is null
    or jsonb_typeof(p_evidence) <> 'object' then
    raise exception using errcode = '22023', message = 'Discovered PDF quarantine payload is invalid.';
  end if;

  select source.* into strict v_source
  from public.shared_award_sources source
  join public.shared_awards award on award.id = source.shared_award_id
  where source.id = p_parent_source_id
    and source.admin_review_status = 'open'
    and award.status = 'active'
  for update of source;

  select link.* into strict v_link
  from public.shared_award_source_discovered_links link
  where link.parent_shared_award_source_id = p_parent_source_id
    and link.url_hash = public.awardping_sha256_text(v_url)
    and link.normalized_url = v_url
  for update;

  if v_link.notification_mode <> 'first_capture_candidate'
    or v_link.onboarding_batch_id is not null
    or v_link.source_page_request_id is not null
    or v_link.prior_source_page_request_id is distinct from p_prior_source_page_request_id
    or v_link.notification_disposition not in (
      'prior_non_live_request_requires_action',
      'prior_terminal_request_requires_action',
      'prior_request_requires_action',
      'quarantined_prior_request_conflict'
    ) then
    raise exception using errcode = '23514', message = 'Only an unresolved post-seed live-link provenance conflict can be quarantined.';
  end if;

  select request.* into strict v_request
  from public.source_page_requests request
  where request.id = p_prior_source_page_request_id
  for share;

  v_evidence := jsonb_build_object(
    'schema_version', 'awardping.discovered-pdf-notification-quarantine.v1',
    'observed_at', v_now,
    'discovered_link', jsonb_build_object(
      'parent_shared_award_source_id', v_link.parent_shared_award_source_id,
      'normalized_url', v_link.normalized_url,
      'url_hash', v_link.url_hash,
      'notification_mode', v_link.notification_mode,
      'notification_disposition', v_link.notification_disposition,
      'first_seen_at', v_link.first_seen_at,
      'last_seen_at', v_link.last_seen_at
    ),
    'prior_request', jsonb_build_object(
      'id', v_request.id,
      'status', v_request.status,
      'status_reason', v_request.status_reason,
      'acquisition_kind', v_request.acquisition_kind,
      'notification_mode', v_request.notification_mode,
      'parent_shared_award_source_id', v_request.parent_shared_award_source_id,
      'onboarding_batch_id', v_request.onboarding_batch_id,
      'normalized_url', v_request.normalized_url,
      'capture_file_hash', v_request.capture_metadata ->> 'capture_file_hash',
      'retained_artifact_present', jsonb_typeof(v_request.capture_metadata -> 'retained_artifact') = 'object',
      'ai_review_status', v_request.ai_review ->> 'status',
      'gemini_batch_name', v_request.ai_review ->> 'gemini_batch_name',
      'created_at', v_request.created_at,
      'updated_at', v_request.updated_at
    ),
    'worker_evidence', p_evidence
  );

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
    shared_award_source_id,
    primary_source_table,
    primary_source_record_id,
    evidence_record_count,
    evidence,
    evidence_hash,
    first_observed_at,
    last_observed_at,
    quarantined_at,
    resolved_at,
    resolved_by,
    resolution_note
  ) values (
    'discovered-pdf-notification:' || v_source.id::text || ':' || v_link.url_hash,
    'discovered-pdf-notification:' || v_source.id::text || ':' || v_link.url_hash,
    'actionable_quarantine',
    'initial_document',
    'quarantined',
    true,
    true,
    1,
    'high',
    'delayed',
    'Source intake and evidence',
    'manual_source_intake_provenance_review',
    'may_charge',
    coalesce(nullif(v_source.display_title, ''), nullif(v_source.title, ''), v_source.url) ||
      ': new PDF notification is blocked by prior intake history',
    v_link.notification_disposition,
    'A newly discovered post-seed PDF matched a prior request that is terminal, historical, or not bound to this exact live discovery. AwardPing did not suppress the link or start another paid review.',
    'Inspect the prior request charge, retained capture, sealed review, and immutable discovery flags. Replay the same retained live result for $0 when eligible. Otherwise explicitly approve one new-page review; never relabel historical evidence as live or absorb this link as a healthy baseline.',
    v_source.shared_award_id,
    v_source.id,
    'shared_award_sources',
    v_source.id,
    1,
    v_evidence,
    public.manual_quarantine_evidence_hash(v_evidence),
    v_link.first_seen_at,
    v_now,
    v_now,
    null,
    null,
    null
  )
  on conflict (quarantine_key) do update set
    status = case
      when public.manual_quarantine_registry.status = 'in_review' then 'in_review'
      else 'quarantined'
    end,
    retry_mode = excluded.retry_mode,
    retry_charge = excluded.retry_charge,
    reason_code = excluded.reason_code,
    reason = excluded.reason,
    recommended_action = excluded.recommended_action,
    evidence = excluded.evidence,
    evidence_hash = excluded.evidence_hash,
    first_observed_at = least(
      public.manual_quarantine_registry.first_observed_at,
      excluded.first_observed_at
    ),
    last_observed_at = excluded.last_observed_at,
    quarantined_at = case
      when public.manual_quarantine_registry.status = 'resolved' then v_now
      else public.manual_quarantine_registry.quarantined_at
    end,
    resolved_at = null,
    resolved_by = null,
    resolution_note = null
  returning id into v_quarantine_id;

  update public.shared_award_source_discovered_links link
  set
    notification_disposition = 'quarantined_prior_request_conflict',
    metadata = link.metadata || jsonb_build_object(
      'notification_quarantine_id', v_quarantine_id,
      'notification_quarantined_at', v_now,
      'notification_quarantine_prior_request_id', v_request.id
    ),
    last_seen_at = greatest(link.last_seen_at, v_now)
  where link.parent_shared_award_source_id = p_parent_source_id
    and link.url_hash = v_link.url_hash;

  perform public.refresh_manual_quarantine_registry_state(v_now);
  return v_quarantine_id;
exception
  when no_data_found then
    raise exception using errcode = '23503', message = 'Discovered PDF quarantine references missing or mismatched provenance.';
end;
$$;

revoke all on function public.record_shared_award_discovered_link_quarantine(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_shared_award_discovered_link_quarantine(uuid, text, uuid, jsonb)
  to service_role;

create or replace function public.resolve_shared_award_discovered_link_quarantine(
  p_parent_source_id uuid,
  p_normalized_url text,
  p_action text,
  p_actor text,
  p_actor_user_id uuid,
  p_expected_evidence_hash text,
  p_source_page_request_id uuid default null
)
returns table(bound_source_page_request_id uuid, created boolean, resolved boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_url text := btrim(coalesce(p_normalized_url, ''));
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_actor text := lower(btrim(coalesce(p_actor, '')));
  v_source public.shared_award_sources%rowtype;
  v_link public.shared_award_source_discovered_links%rowtype;
  v_prior_request public.source_page_requests%rowtype;
  v_request public.source_page_requests%rowtype;
  v_quarantine public.manual_quarantine_registry%rowtype;
  v_assignment public.manual_quarantine_operator_assignments%rowtype;
  v_award_name text;
  v_bound_id uuid;
  v_created boolean := false;
  v_prior_request_closed boolean := false;
  v_resolved_evidence jsonb;
begin
  if p_parent_source_id is null
    or v_url = ''
    or length(v_url) > 4096
    or v_url !~* '^https?://'
    or v_action not in ('bind_eligible_live_request', 'approve_new_live_review')
    or v_actor = ''
    or length(v_actor) > 320
    or v_actor !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_actor_user_id is null
    or p_expected_evidence_hash is null
    or p_expected_evidence_hash !~ '^[0-9a-f]{64}$'
    or (v_action = 'bind_eligible_live_request' and p_source_page_request_id is null)
    or (v_action = 'approve_new_live_review' and p_source_page_request_id is not null) then
    raise exception using errcode = '22023', message = 'Discovered PDF quarantine resolution payload is invalid.';
  end if;

  select source.* into strict v_source
  from public.shared_award_sources source
  join public.shared_awards award on award.id = source.shared_award_id
  where source.id = p_parent_source_id
    and source.admin_review_status = 'open'
    and award.status = 'active'
  for update of source;
  select award.name into strict v_award_name
  from public.shared_awards award
  where award.id = v_source.shared_award_id;

  select link.* into strict v_link
  from public.shared_award_source_discovered_links link
  where link.parent_shared_award_source_id = p_parent_source_id
    and link.url_hash = public.awardping_sha256_text(v_url)
    and link.normalized_url = v_url
  for update;
  if v_link.notification_mode <> 'first_capture_candidate'
    or v_link.onboarding_batch_id is not null
    or v_link.source_page_request_id is not null
    or v_link.prior_source_page_request_id is null
    or v_link.notification_disposition <> 'quarantined_prior_request_conflict' then
    raise exception using errcode = '23514', message = 'The discovered PDF link is not an unresolved live-notification quarantine.';
  end if;

  select registry.* into strict v_quarantine
  from public.manual_quarantine_registry registry
  where registry.quarantine_key =
      'discovered-pdf-notification:' || v_source.id::text || ':' || v_link.url_hash
    and registry.category = 'initial_document'
  for update;

  if v_quarantine.status <> 'in_review' then
    raise exception using
      errcode = '23514',
      message = 'The discovered PDF quarantine must still be in review before it can be resolved.';
  end if;
  if v_quarantine.evidence_hash is distinct from p_expected_evidence_hash then
    raise exception using
      errcode = '40001',
      message = 'The discovered PDF quarantine evidence changed after operator review began.';
  end if;

  select assignment.* into strict v_assignment
  from public.manual_quarantine_operator_assignments assignment
  where assignment.quarantine_id = v_quarantine.id
  for update;
  if v_assignment.assigned_to_user_id is distinct from p_actor_user_id
    or v_assignment.assigned_to_email is distinct from v_actor then
    raise exception using
      errcode = '23514',
      message = 'The discovered PDF quarantine assignment changed before resolution.';
  end if;

  -- The quarantined request is evidence, not a reusable live-discovery
  -- identity. Lock it for either resolution path so an operator decision
  -- cannot race a worker update or silently change which prior request was
  -- inspected.
  select request.* into strict v_prior_request
  from public.source_page_requests request
  where request.id = v_link.prior_source_page_request_id
  for update;

  if v_action = 'bind_eligible_live_request' then
    select request.* into strict v_request
    from public.source_page_requests request
    where request.id = p_source_page_request_id
    for update;
    if v_request.acquisition_kind <> 'live_discovery'
      or v_request.notification_mode <> 'first_capture_candidate'
      or v_request.onboarding_batch_id is not null
      or v_request.parent_shared_award_source_id is distinct from p_parent_source_id
      or v_request.matched_shared_award_id is distinct from v_source.shared_award_id
      or v_request.normalized_url is distinct from v_url
      or v_request.status not in (
        'pending',
        'queued',
        'validating',
        'capturing',
        'ai_review_pending',
        'ai_review_submitted',
        'ai_review_succeeded',
        'matching'
      ) then
      raise exception using
        errcode = '23514',
        message = 'The selected request is not an active exact live request. Use the existing source-intake $0 retained-result action first when eligible.';
    end if;
    v_bound_id := v_request.id;
  else
    -- The active-request uniqueness guard deliberately includes manual-review
    -- rows. An explicit paid resolution therefore closes only the exact prior
    -- request selected by the quarantine before inserting its replacement.
    -- Its original status/reason and all retained artifacts remain preserved
    -- in the quarantine evidence; acquisition flags are never relabeled.
    if v_prior_request.status in (
      'pending',
      'queued',
      'validating',
      'capturing',
      'ai_review_pending',
      'ai_review_submitted',
      'ai_review_succeeded',
      'matching',
      'needs_manual_review'
    ) then
      update public.source_page_requests request
      set
        status = 'rejected',
        status_reason = 'superseded_by_operator_approved_post_seed_live_pdf_review',
        worker_run_id = null,
        processed_at = coalesce(request.processed_at, v_now),
        error = 'Closed by the explicit discovered-PDF quarantine resolution. Prior evidence is retained in the quarantine registry.',
        updated_at = v_now
      where request.id = v_prior_request.id;
      v_prior_request_closed := true;
    end if;

    begin
      insert into public.source_page_requests (
        award_name,
        homepage_url,
        submitted_url,
        normalized_url,
        intake_type,
        notes,
        status,
        status_reason,
        matched_shared_award_id,
        acquisition_kind,
        notification_mode,
        parent_shared_award_source_id,
        onboarding_batch_id,
        created_at,
        updated_at
      ) values (
        v_award_name,
        v_url,
        v_url,
        v_url,
        'official_source',
        'Operator approved one new live review after inspecting quarantined prior intake provenance. Prior request: ' ||
          v_link.prior_source_page_request_id::text || '. Actor: ' || v_actor,
        'pending',
        'operator_approved_post_seed_live_pdf_review',
        v_source.shared_award_id,
        'live_discovery',
        'first_capture_candidate',
        p_parent_source_id,
        null,
        v_now,
        v_now
      )
      returning id into v_bound_id;
    exception
      when unique_violation then
        raise exception using
          errcode = '23505',
          message = 'Another active request still owns this PDF and award identity. The quarantine remains unresolved and no new request was committed.';
    end;
    v_created := true;
  end if;

  update public.shared_award_source_discovered_links link
  set
    source_page_request_id = v_bound_id,
    notification_disposition = case
      when v_created then 'operator_approved_new_live_review_bound'
      else 'active_live_request_bound'
    end,
    request_queued_at = coalesce(link.request_queued_at, v_now),
    metadata = link.metadata || jsonb_build_object(
      'notification_quarantine_resolution_action', v_action,
      'notification_quarantine_resolved_at', v_now,
      'notification_quarantine_resolved_by', v_actor,
      'notification_quarantine_bound_request_id', v_bound_id,
      'prior_request_evidence_preserved', true
    ),
    last_seen_at = greatest(link.last_seen_at, v_now)
  where link.parent_shared_award_source_id = p_parent_source_id
    and link.url_hash = v_link.url_hash;

  v_resolved_evidence := v_quarantine.evidence || jsonb_build_object(
    'resolution', jsonb_build_object(
      'resolved_at', v_now,
      'resolved_by', v_actor,
      'action', v_action,
      'bound_source_page_request_id', v_bound_id,
      'created_new_review_request', v_created,
      'prior_source_page_request_id', v_link.prior_source_page_request_id,
      'prior_request_status_before_resolution', v_prior_request.status,
      'prior_request_status_reason_before_resolution', v_prior_request.status_reason,
      'prior_request_closed_for_explicit_new_review', v_prior_request_closed,
      'prior_request_evidence_preserved', true
    )
  );
  update public.manual_quarantine_registry registry
  set
    status = 'resolved',
    resolved_at = v_now,
    resolved_by = v_actor,
    resolution_note = case
      when v_created
        then 'Operator explicitly approved one new live-discovery review under the new-page budget lane.'
      else 'Operator bound an existing exact live request after using its supported retained-result recovery path.'
    end,
    evidence = v_resolved_evidence,
    evidence_hash = public.manual_quarantine_evidence_hash(v_resolved_evidence)
  where registry.id = v_quarantine.id;

  perform public.refresh_manual_quarantine_registry_state(v_now);
  bound_source_page_request_id := v_bound_id;
  created := v_created;
  resolved := true;
  return next;
exception
  when no_data_found then
    raise exception using errcode = '23503', message = 'Discovered PDF quarantine resolution references missing or mismatched provenance.';
end;
$$;

revoke all on function public.resolve_shared_award_discovered_link_quarantine(uuid, text, text, text, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_shared_award_discovered_link_quarantine(uuid, text, text, text, uuid, text, uuid)
  to service_role;

alter table public.shared_award_visual_review_candidates
  add column if not exists candidate_scope text not null default 'content_change',
  add column if not exists source_acquisition_id uuid
    references public.shared_award_source_acquisitions(id) on delete restrict;

alter table public.shared_award_visual_review_candidates
  drop constraint if exists shared_award_visual_review_candidates_candidate_scope_check;
alter table public.shared_award_visual_review_candidates
  add constraint shared_award_visual_review_candidates_candidate_scope_check check (
    candidate_scope in ('content_change', 'initial_official_document')
  );

alter table public.shared_award_visual_review_candidates
  drop constraint if exists shared_award_visual_review_candidates_initial_acquisition_check;
alter table public.shared_award_visual_review_candidates
  add constraint shared_award_visual_review_candidates_initial_acquisition_check check (
    candidate_scope <> 'initial_official_document' or source_acquisition_id is not null
  );

create unique index if not exists shared_award_visual_review_initial_acquisition_idx
  on public.shared_award_visual_review_candidates (source_acquisition_id)
  where candidate_scope = 'initial_official_document';

create or replace function public.awardping_preserve_visual_candidate_scope_binding()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.candidate_scope is distinct from old.candidate_scope
    or new.source_acquisition_id is distinct from old.source_acquisition_id then
    raise exception using
      errcode = '55000',
      message = 'A visual candidate kind and source-acquisition binding are immutable.';
  end if;
  return new;
end;
$$;

drop trigger if exists awardping_preserve_visual_candidate_scope_binding_trigger
  on public.shared_award_visual_review_candidates;
create trigger awardping_preserve_visual_candidate_scope_binding_trigger
  before update on public.shared_award_visual_review_candidates
  for each row execute function public.awardping_preserve_visual_candidate_scope_binding();

-- The general visual-evidence guard intentionally freezes a succeeded
-- candidate's prompt identity. A deterministic first-observation candidate is
-- the one narrow exception: it may need the current monitoring policy before
-- publication, but it must never be converted into a paid review or have its
-- acquisition/evidence identity changed. Only the SECURITY DEFINER refresh RPC
-- below can authorize this exact transition through a transaction-local marker.
create or replace function public.awardping_preserve_published_visual_candidate_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_has_evidence boolean := false;
  v_authorized_initial_policy_refresh boolean := false;
begin
  select exists (
    select 1
    from public.shared_award_change_event_visual_evidence evidence
    where evidence.visual_review_candidate_id = old.id
  ) into v_has_evidence;

  v_authorized_initial_policy_refresh :=
    coalesce(
      pg_catalog.current_setting(
        'awardping.initial_document_policy_refresh_candidate_id',
        true
      ) = old.id::text,
      false
    )
    and not v_has_evidence
    and old.candidate_scope = 'initial_official_document'
    and new.candidate_scope = 'initial_official_document'
    and old.source_acquisition_id is not null
    and new.source_acquisition_id = old.source_acquisition_id
    and old.status = 'succeeded'
    and new.status = 'succeeded'
    and old.publication_claim_token is not null
    and old.publication_claimed_at is not null
    and new.publication_claim_token is null
    and new.publication_claimed_at is null
    and old.model is null
    and new.model is null
    and old.gemini_batch_name is null
    and new.gemini_batch_name is null
    and old.gemini_batch_request_key is null
    and new.gemini_batch_request_key is null
    and old.estimated_cost_usd is null
    and new.estimated_cost_usd is null
    and old.actual_usage = '{}'::jsonb
    and new.actual_usage = '{}'::jsonb
    and new.ai_result is not distinct from old.ai_result
    and new.source_url is not distinct from old.source_url
    and new.source_title is not distinct from old.source_title
    and new.source_page_type is not distinct from old.source_page_type
    and new.previous_text_hash is not distinct from old.previous_text_hash
    and new.new_text_hash is not distinct from old.new_text_hash
    and new.previous_image_hash is not distinct from old.previous_image_hash
    and new.new_image_hash is not distinct from old.new_image_hash
    and new.previous_file_hash is not distinct from old.previous_file_hash
    and new.new_file_hash is not distinct from old.new_file_hash
    and new.deterministic_diff is not distinct from old.deterministic_diff
    and new.deterministic_classification is not distinct from old.deterministic_classification
    and new.prompt_context is not distinct from old.prompt_context
    and new.submitted_at is not distinct from old.submitted_at
    and new.completed_at is not distinct from old.completed_at
    and new.published_at is not distinct from old.published_at
    and new.candidate_signature ~ '^[0-9a-f]{64}$'
    and new.candidate_signature is distinct from old.candidate_signature
    and jsonb_typeof(new.prompt_payload -> 'monitoring_policy') = 'object'
    and jsonb_typeof(new.prompt_payload -> 'monitoring_policy_bundle') = 'object'
    and (
      new.prompt_payload - 'monitoring_policy' - 'monitoring_policy_bundle'
    ) = (
      old.prompt_payload - 'monitoring_policy' - 'monitoring_policy_bundle'
    );
  v_authorized_initial_policy_refresh := coalesce(
    v_authorized_initial_policy_refresh,
    false
  );

  if new.id is distinct from old.id
    or new.shared_award_id is distinct from old.shared_award_id
    or new.shared_award_source_id is distinct from old.shared_award_source_id
    or new.previous_snapshot_ref is distinct from old.previous_snapshot_ref
    or new.new_snapshot_ref is distinct from old.new_snapshot_ref
    or (
      old.prompt_payload ? 'previous_snapshot_ref'
      and new.prompt_payload -> 'previous_snapshot_ref' is distinct from
        old.prompt_payload -> 'previous_snapshot_ref'
    )
    or (
      old.prompt_payload ? 'new_snapshot_ref'
      and new.prompt_payload -> 'new_snapshot_ref' is distinct from
        old.prompt_payload -> 'new_snapshot_ref'
    )
    or (
      nullif(old.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}', '') is not null
      and new.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}' is distinct from
        old.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}'
    )
    or (
      nullif(old.prompt_payload #>> '{hashes,new_artifact_manifest_digest}', '') is not null
      and new.prompt_payload #>> '{hashes,new_artifact_manifest_digest}' is distinct from
        old.prompt_payload #>> '{hashes,new_artifact_manifest_digest}'
    )
    or (
      nullif(old.worker_metadata ->> 'evidence_signature', '') is not null
      and new.worker_metadata ->> 'evidence_signature' is distinct from
        old.worker_metadata ->> 'evidence_signature'
    ) then
    raise exception using
      errcode = '55000',
      message = 'A visual review candidate snapshot and artifact-manifest binding is immutable after enqueue.';
  end if;

  if not v_authorized_initial_policy_refresh
    and (old.status <> 'pending' or new.status <> 'pending' or v_has_evidence)
    and (
      new.candidate_signature is distinct from old.candidate_signature
      or new.source_url is distinct from old.source_url
      or new.source_title is distinct from old.source_title
      or new.source_page_type is distinct from old.source_page_type
      or new.previous_text_hash is distinct from old.previous_text_hash
      or new.new_text_hash is distinct from old.new_text_hash
      or new.previous_image_hash is distinct from old.previous_image_hash
      or new.new_image_hash is distinct from old.new_image_hash
      or new.previous_file_hash is distinct from old.previous_file_hash
      or new.new_file_hash is distinct from old.new_file_hash
      or new.deterministic_diff is distinct from old.deterministic_diff
      or new.deterministic_classification is distinct from old.deterministic_classification
      or new.prompt_payload is distinct from old.prompt_payload
      or new.prompt_context is distinct from old.prompt_context
      or new.gemini_batch_request_key is distinct from old.gemini_batch_request_key
    ) then
    raise exception using
      errcode = '55000',
      message = 'A submitted visual review candidate identity and deterministic evidence are immutable.';
  end if;

  if v_has_evidence and (
    new.id is distinct from old.id
    or new.model is distinct from old.model
    or new.gemini_batch_name is distinct from old.gemini_batch_name
    or new.ai_result is distinct from old.ai_result
  ) then
    raise exception using
      errcode = '55000',
      message = 'A published visual review candidate provider identity and review result are immutable.';
  end if;
  return new;
end;
$$;

create or replace function public.refresh_shared_award_initial_document_candidate_policy(
  p_candidate_id uuid,
  p_publication_claim_token text,
  p_candidate_signature text,
  p_monitoring_policy jsonb,
  p_monitoring_policy_bundle jsonb,
  p_policy_guard jsonb
)
returns table(candidate_id uuid, candidate_signature text, refreshed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_acquisition public.shared_award_source_acquisitions%rowtype;
  v_prompt_payload jsonb;
  v_worker_metadata jsonb;
  v_refreshed_id uuid;
  v_refreshed_signature text;
begin
  if p_candidate_id is null
    or nullif(btrim(p_publication_claim_token), '') is null
    or length(p_publication_claim_token) > 512
    or p_candidate_signature is null
    or p_candidate_signature !~ '^[0-9a-f]{64}$'
    or p_monitoring_policy is null
    or p_monitoring_policy_bundle is null
    or p_policy_guard is null
    or jsonb_typeof(p_monitoring_policy) <> 'object'
    or jsonb_typeof(p_monitoring_policy_bundle) <> 'object'
    or jsonb_typeof(p_policy_guard) <> 'object'
    or nullif(btrim(p_monitoring_policy ->> 'id'), '') is null
    or nullif(btrim(p_monitoring_policy ->> 'version'), '') is null
    or coalesce(p_monitoring_policy ->> 'hash', '') !~ '^[0-9a-f]{64}$'
    or nullif(btrim(p_monitoring_policy_bundle ->> 'id'), '') is null
    or nullif(btrim(p_monitoring_policy_bundle ->> 'version'), '') is null
    or coalesce(p_monitoring_policy_bundle ->> 'hash', '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Initial-document policy refresh payload is invalid.';
  end if;

  select candidate.* into strict v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = p_candidate_id
  for update;

  if v_candidate.candidate_scope <> 'initial_official_document'
    or v_candidate.source_acquisition_id is null
    or v_candidate.status <> 'succeeded'
    or v_candidate.publication_claim_token is distinct from p_publication_claim_token
    or v_candidate.publication_claimed_at is null
    or v_candidate.candidate_signature = p_candidate_signature
    or v_candidate.model is not null
    or v_candidate.gemini_batch_name is not null
    or v_candidate.gemini_batch_request_key is not null
    or v_candidate.estimated_cost_usd is not null
    or v_candidate.actual_usage <> '{}'::jsonb
    or v_candidate.ai_result #>> '{review_execution,creates_api_charge}' is distinct from 'false'
    or jsonb_typeof(v_candidate.prompt_payload) <> 'object'
    or jsonb_typeof(v_candidate.worker_metadata) <> 'object'
    or exists (
      select 1
      from public.shared_award_change_events event
      where event.visual_review_candidate_id = v_candidate.id
    )
    or exists (
      select 1
      from public.shared_award_change_event_visual_evidence evidence
      where evidence.visual_review_candidate_id = v_candidate.id
    ) then
    raise exception using errcode = '23514', message = 'Only a claimed, unpublished, zero-charge first-observation candidate can refresh policy identity.';
  end if;

  select acquisition.* into strict v_acquisition
  from public.shared_award_source_acquisitions acquisition
  where acquisition.id = v_candidate.source_acquisition_id
    and acquisition.shared_award_source_id = v_candidate.shared_award_source_id
  for share;
  if v_acquisition.notification_mode <> 'first_capture_candidate'
    or v_acquisition.onboarding_batch_id is not null then
    raise exception using errcode = '23514', message = 'Initial-document policy refresh requires eligible immutable acquisition provenance.';
  end if;

  v_prompt_payload := jsonb_set(
    jsonb_set(
      v_candidate.prompt_payload,
      '{monitoring_policy}',
      p_monitoring_policy,
      true
    ),
    '{monitoring_policy_bundle}',
    p_monitoring_policy_bundle,
    true
  );
  v_worker_metadata := v_candidate.worker_metadata || jsonb_build_object(
    'policy_guard', p_policy_guard,
    'monitoring_policy', p_monitoring_policy,
    'monitoring_policy_bundle', p_monitoring_policy_bundle,
    'policy_refreshed_at', v_now,
    'policy_refreshed_from', coalesce(
      v_candidate.worker_metadata -> 'monitoring_policy',
      v_candidate.prompt_payload -> 'monitoring_policy',
      'null'::jsonb
    ),
    'deterministic_initial_document_policy_refresh', true,
    'creates_api_charge', false,
    'publication_claim_token', null,
    'publication_claim_last_token', p_publication_claim_token,
    'publication_claim_completed_at', v_now,
    'publication_claim_outcome', 'policy_refreshed'
  );

  perform pg_catalog.set_config(
    'awardping.initial_document_policy_refresh_candidate_id',
    v_candidate.id::text,
    true
  );
  update public.shared_award_visual_review_candidates candidate
  set
    candidate_signature = p_candidate_signature,
    prompt_payload = v_prompt_payload,
    worker_metadata = v_worker_metadata,
    rejection_reason = null,
    publication_claim_token = null,
    publication_claimed_at = null,
    updated_at = v_now
  where candidate.id = v_candidate.id
    and candidate.status = 'succeeded'
    and candidate.publication_claim_token = p_publication_claim_token
  returning candidate.id, candidate.candidate_signature
  into v_refreshed_id, v_refreshed_signature;
  perform pg_catalog.set_config(
    'awardping.initial_document_policy_refresh_candidate_id',
    '',
    true
  );

  if v_refreshed_id is null then
    raise exception using errcode = '40001', message = 'Initial-document publication claim changed during policy refresh.';
  end if;
  candidate_id := v_refreshed_id;
  candidate_signature := v_refreshed_signature;
  refreshed := true;
  return next;
exception
  when no_data_found then
    raise exception using errcode = '23503', message = 'Initial-document policy refresh references missing durable provenance.';
end;
$$;

revoke all on function public.refresh_shared_award_initial_document_candidate_policy(uuid, text, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.refresh_shared_award_initial_document_candidate_policy(uuid, text, text, jsonb, jsonb, jsonb)
  to service_role;

alter table public.shared_award_change_event_visual_evidence
  drop constraint if exists shared_award_change_event_visual_evidence_evidence_status_check;
alter table public.shared_award_change_event_visual_evidence
  add constraint shared_award_change_event_visual_evidence_evidence_status_check check (
    evidence_status in (
      'verified',
      'unavailable_exact_text_missing',
      'unavailable_geometry_missing',
      'unavailable_image_missing',
      'unavailable_ambiguous',
      'historical_artifact_unrecoverable',
      'full_screenshot_fallback',
      'not_applicable_pdf',
      'not_applicable_new_document'
    )
  );

-- Registering a source and its immutable acquisition in one transaction closes
-- the crash window where the source existed but its first-observation provenance
-- did not. The function also makes the notification decision again on the server;
-- callers cannot re-arm an existing source or promote onboarding work.
create or replace function public.register_shared_award_source_from_intake(
  p_source jsonb,
  p_acquisition jsonb
)
returns table(
  source_id uuid,
  acquisition_id uuid,
  source_inserted boolean,
  effective_notification_mode text,
  effective_disposition_reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_award public.shared_awards%rowtype;
  v_source public.shared_award_sources%rowtype;
  v_existing_acquisition public.shared_award_source_acquisitions%rowtype;
  v_request public.source_page_requests%rowtype;
  v_award_id uuid;
  v_submitted_by_user_id uuid;
  v_origin_source_page_request_id uuid;
  v_origin_worker_run_id uuid;
  v_parent_shared_award_source_id uuid;
  v_url text;
  v_title text;
  v_display_title text;
  v_page_description text;
  v_page_type text;
  v_reason text;
  v_source_kind text;
  v_admin_review_status text;
  v_page_metadata jsonb;
  v_page_metadata_generated_at timestamptz;
  v_page_metadata_model text;
  v_last_error text;
  v_confidence numeric;
  v_consecutive_failures integer;
  v_acquisition_kind text;
  v_requested_notification_mode text;
  v_effective_notification_mode text := 'baseline_only';
  v_onboarding_batch_id text;
  v_review_seal jsonb;
  v_acquisition_metadata jsonb;
  v_award_was_created boolean;
  v_first_capture_eligible boolean := false;
  v_all_quotes_exact boolean := true;
  v_quote jsonb;
  v_normalized_quote text;
  v_normalized_capture_text text;
  v_retained_artifact jsonb;
begin
  if jsonb_typeof(p_source) <> 'object' or jsonb_typeof(p_acquisition) <> 'object' then
    raise exception using errcode = '22023', message = 'Source and acquisition payloads must be JSON objects.';
  end if;
  if p_source - array[
    'shared_award_id',
    'url',
    'title',
    'display_title',
    'page_description',
    'page_type',
    'confidence',
    'reason',
    'source',
    'submitted_by_user_id',
    'admin_review_status',
    'page_metadata',
    'page_metadata_generated_at',
    'page_metadata_model',
    'last_error',
    'consecutive_failures'
  ]::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Source registration contains unsupported fields.';
  end if;
  if p_acquisition - array[
    'acquisition_kind',
    'notification_mode',
    'award_was_created',
    'origin_source_page_request_id',
    'origin_worker_run_id',
    'parent_shared_award_source_id',
    'onboarding_batch_id',
    'review_seal',
    'metadata'
  ]::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Source acquisition contains unsupported fields.';
  end if;

  begin
    v_award_id := nullif(p_source ->> 'shared_award_id', '')::uuid;
    v_submitted_by_user_id := nullif(p_source ->> 'submitted_by_user_id', '')::uuid;
    v_origin_source_page_request_id := nullif(p_acquisition ->> 'origin_source_page_request_id', '')::uuid;
    v_origin_worker_run_id := nullif(p_acquisition ->> 'origin_worker_run_id', '')::uuid;
    v_parent_shared_award_source_id := nullif(p_acquisition ->> 'parent_shared_award_source_id', '')::uuid;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Source registration identifiers must be valid UUIDs.';
  end;

  v_url := nullif(btrim(p_source ->> 'url'), '');
  v_title := nullif(btrim(p_source ->> 'title'), '');
  v_display_title := nullif(btrim(p_source ->> 'display_title'), '');
  v_page_description := nullif(btrim(p_source ->> 'page_description'), '');
  v_page_type := nullif(btrim(p_source ->> 'page_type'), '');
  v_reason := nullif(btrim(p_source ->> 'reason'), '');
  v_source_kind := nullif(btrim(p_source ->> 'source'), '');
  v_admin_review_status := nullif(btrim(p_source ->> 'admin_review_status'), '');
  v_page_metadata := coalesce(p_source -> 'page_metadata', '{}'::jsonb);
  v_page_metadata_model := nullif(btrim(p_source ->> 'page_metadata_model'), '');
  v_last_error := nullif(btrim(p_source ->> 'last_error'), '');
  v_acquisition_kind := nullif(btrim(p_acquisition ->> 'acquisition_kind'), '');
  v_requested_notification_mode := nullif(btrim(p_acquisition ->> 'notification_mode'), '');
  v_onboarding_batch_id := nullif(btrim(p_acquisition ->> 'onboarding_batch_id'), '');
  v_review_seal := coalesce(p_acquisition -> 'review_seal', '{}'::jsonb);
  v_acquisition_metadata := coalesce(p_acquisition -> 'metadata', '{}'::jsonb);
  v_retained_artifact := coalesce(v_review_seal -> 'retained_artifact', '{}'::jsonb);

  if v_award_id is null
    or v_url is null or length(v_url) > 4096 or v_url !~* '^https?://'
    or v_title is null or length(v_title) > 1000
    or v_page_type not in ('homepage', 'deadline', 'application', 'eligibility', 'requirements', 'pdf', 'faq', 'other')
    or v_source_kind <> 'admin'
    or v_admin_review_status <> 'open'
    or jsonb_typeof(v_page_metadata) <> 'object'
    or jsonb_typeof(v_review_seal) <> 'object'
    or jsonb_typeof(v_acquisition_metadata) <> 'object' then
    raise exception using errcode = '23514', message = 'Source registration identity or metadata is invalid.';
  end if;
  if v_acquisition_kind not in (
    'live_discovery',
    'user_request',
    'admin_intake',
    'historical_import',
    'seed',
    'repair',
    'legacy_unknown',
    'operator_historical_exception'
  ) or v_requested_notification_mode not in (
    'first_capture_candidate',
    'baseline_only',
    'manual_review'
  ) then
    raise exception using errcode = '23514', message = 'Source acquisition policy values are invalid.';
  end if;
  if jsonb_typeof(p_source -> 'confidence') <> 'number'
    or jsonb_typeof(p_source -> 'consecutive_failures') <> 'number'
    or coalesce(p_source ->> 'consecutive_failures', '') !~ '^\d+$'
    or jsonb_typeof(p_acquisition -> 'award_was_created') <> 'boolean' then
    raise exception using errcode = '23514', message = 'Source registration numeric and boolean fields are invalid.';
  end if;

  begin
    v_confidence := (p_source ->> 'confidence')::numeric;
    v_consecutive_failures := (p_source ->> 'consecutive_failures')::integer;
    v_award_was_created := (p_acquisition ->> 'award_was_created')::boolean;
    v_page_metadata_generated_at := nullif(p_source ->> 'page_metadata_generated_at', '')::timestamptz;
  exception
    when invalid_text_representation or invalid_datetime_format
      or numeric_value_out_of_range or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Source registration contains an invalid number or timestamp.';
  end;
  if v_confidence < 0 or v_confidence > 1 or v_consecutive_failures < 0 then
    raise exception using errcode = '23514', message = 'Source confidence or failure count is outside its allowed range.';
  end if;

  select award.* into strict v_award
  from public.shared_awards award
  where award.id = v_award_id
  for share;
  if v_award.status <> 'active' then
    raise exception using errcode = '23514', message = 'Accepted sources can only be registered for an active award.';
  end if;

  -- Serialize this logical source identity and then rely on the table uniqueness
  -- constraint as a second guard against callers outside this function.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_award_id::text || E'\n' || v_url, 0)
  );

  insert into public.shared_award_sources (
    shared_award_id,
    url,
    title,
    display_title,
    page_description,
    page_type,
    confidence,
    reason,
    source,
    submitted_by_user_id,
    admin_review_status,
    page_metadata,
    page_metadata_generated_at,
    page_metadata_model,
    last_error,
    consecutive_failures,
    updated_at
  ) values (
    v_award_id,
    v_url,
    v_title,
    v_display_title,
    v_page_description,
    v_page_type,
    v_confidence,
    v_reason,
    v_source_kind,
    v_submitted_by_user_id,
    v_admin_review_status,
    v_page_metadata,
    v_page_metadata_generated_at,
    v_page_metadata_model,
    v_last_error,
    v_consecutive_failures,
    now()
  )
  on conflict (shared_award_id, url) do nothing
  returning * into v_source;

  if not found then
    select source.* into strict v_source
    from public.shared_award_sources source
    where source.shared_award_id = v_award_id
      and source.url = v_url
    for update;

    update public.shared_award_sources source
    set
      title = v_title,
      display_title = v_display_title,
      page_description = v_page_description,
      page_type = v_page_type,
      confidence = v_confidence,
      reason = v_reason,
      page_metadata = coalesce(source.page_metadata, '{}'::jsonb) || v_page_metadata,
      page_metadata_generated_at = v_page_metadata_generated_at,
      page_metadata_model = v_page_metadata_model,
      last_error = v_last_error,
      consecutive_failures = v_consecutive_failures,
      updated_at = now()
    where source.id = v_source.id
    returning source.* into v_source;

    select acquisition.* into v_existing_acquisition
    from public.shared_award_source_acquisitions acquisition
    where acquisition.shared_award_source_id = v_source.id;

    source_id := v_source.id;
    source_inserted := false;
    if found
      and v_existing_acquisition.origin_source_page_request_id is not distinct from v_origin_source_page_request_id
      and v_existing_acquisition.review_seal ->> 'capture_file_hash'
        is not distinct from v_review_seal ->> 'capture_file_hash' then
      acquisition_id := v_existing_acquisition.id;
      effective_notification_mode := v_existing_acquisition.notification_mode;
      effective_disposition_reason := coalesce(
        nullif(v_existing_acquisition.metadata ->> 'effective_disposition_reason', ''),
        nullif(v_existing_acquisition.metadata ->> 'disposition_reason', ''),
        'existing_acquisition_reused'
      );
    else
      acquisition_id := null;
      effective_notification_mode := 'baseline_only';
      effective_disposition_reason := 'preexisting_source_not_reacquired';
    end if;
    return next;
    return;
  end if;

  if v_requested_notification_mode = 'first_capture_candidate'
    and v_acquisition_kind = 'live_discovery'
    and not v_award_was_created
    and v_onboarding_batch_id is null
    and v_page_type = 'pdf'
    and v_origin_source_page_request_id is not null
    and v_origin_worker_run_id is not null
    and v_parent_shared_award_source_id is not null
    and v_review_seal -> 'sealed' = 'true'::jsonb
    and v_review_seal ->> 'status' = 'accepted'
    and coalesce(v_review_seal ->> 'award_relevance', v_review_seal ->> 'source_relevance')
      in ('primary', 'supporting')
    and v_review_seal ->> 'source_relevance' in ('primary', 'supporting')
    and v_review_seal ->> 'cycle_relevance' in ('current_or_upcoming', 'evergreen')
    and v_review_seal ->> 'officialness' in ('official', 'likely_official')
    and v_review_seal ->> 'confidence' in ('medium', 'high')
    and v_review_seal ->> 'page_type' = 'pdf'
    and v_review_seal ->> 'capture_file_hash' ~ '^[0-9a-f]{64}$'
    and v_review_seal ->> 'seal_sha256' ~ '^[0-9a-f]{64}$'
    and v_review_seal -> 'exact_evidence_verified' = 'true'::jsonb
    and jsonb_typeof(v_review_seal -> 'evidence_quotes') = 'array'
    and jsonb_array_length(v_review_seal -> 'evidence_quotes') > 0
    and v_review_seal ->> 'capture_final_url' = v_url
    and (
      v_review_seal ->> 'capture_content_type' ilike '%pdf%'
      or v_url ~* '\.pdf(?:$|[?#])'
    )
    and v_review_seal ->> 'source_page_request_id' = v_origin_source_page_request_id::text
    and v_acquisition_metadata ->> 'capture_file_hash' = v_review_seal ->> 'capture_file_hash'
    and jsonb_typeof(v_retained_artifact) = 'object'
    and v_retained_artifact ->> 'schema_version' = '1'
    and v_retained_artifact ->> 'namespace' = 'source-intake-first-observation'
    and v_retained_artifact ->> 'request_id' = v_origin_source_page_request_id::text
    and v_retained_artifact ->> 'captured_at' = v_review_seal ->> 'capture_captured_at'
    and v_retained_artifact ->> 'final_url' = v_url
    and v_retained_artifact ->> 'file_hash' = v_review_seal ->> 'capture_file_hash'
    and coalesce(v_retained_artifact ->> 'file_bytes', '') ~ '^[1-9][0-9]*$'
    and v_retained_artifact ->> 'text_hash' ~ '^[0-9a-f]{64}$'
    and coalesce(v_retained_artifact ->> 'text_length', '') ~ '^[0-9]+$'
    and coalesce(v_retained_artifact ->> 'r2_verified_at', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.+Z$'
    and coalesce(v_retained_artifact ->> 'r2_bucket', '') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
    and coalesce(v_retained_artifact ->> 'r2_store_id', '') ~ '^[A-Za-z0-9][A-Za-z0-9.:-]{0,254}$'
    and v_retained_artifact ->> 'prefix' =
      'source-intake-first-observation/v1/requests/' ||
      v_origin_source_page_request_id::text || '/sha256/' ||
      (v_review_seal ->> 'capture_file_hash')
    and v_review_seal -> 'retained_artifact' = v_acquisition_metadata -> 'retained_artifact'
    and jsonb_typeof(v_retained_artifact -> 'artifacts') = 'object'
    and jsonb_typeof(v_retained_artifact -> 'artifacts' -> 'pdf') = 'object'
    and jsonb_typeof(v_retained_artifact -> 'artifacts' -> 'text') = 'object'
    and jsonb_typeof(v_retained_artifact -> 'artifacts' -> 'capture_metadata') = 'object'
    and v_retained_artifact -> 'artifacts' -> 'pdf' ->> 'key' =
      (v_retained_artifact ->> 'prefix') || '/document.pdf'
    and v_retained_artifact -> 'artifacts' -> 'text' ->> 'key' =
      (v_retained_artifact ->> 'prefix') || '/text.txt'
    and v_retained_artifact -> 'artifacts' -> 'capture_metadata' ->> 'key' =
      (v_retained_artifact ->> 'prefix') || '/capture.json'
    and v_retained_artifact -> 'artifacts' -> 'pdf' ->> 'sha256' =
      v_review_seal ->> 'capture_file_hash'
    and v_retained_artifact -> 'artifacts' -> 'text' ->> 'sha256' ~ '^[0-9a-f]{64}$'
    and v_retained_artifact -> 'artifacts' -> 'capture_metadata' ->> 'sha256' ~ '^[0-9a-f]{64}$'
    and v_retained_artifact -> 'artifacts' -> 'pdf' ->> 'byte_length' =
      v_retained_artifact ->> 'file_bytes'
    and coalesce(v_retained_artifact -> 'artifacts' -> 'text' ->> 'byte_length', '') ~ '^[1-9][0-9]*$'
    and coalesce(v_retained_artifact -> 'artifacts' -> 'capture_metadata' ->> 'byte_length', '') ~ '^[1-9][0-9]*$'
    and v_retained_artifact -> 'artifacts' -> 'pdf' ->> 'content_type' = 'application/pdf'
    and v_retained_artifact -> 'artifacts' -> 'text' ->> 'content_type' = 'text/plain; charset=utf-8'
    and v_retained_artifact -> 'artifacts' -> 'capture_metadata' ->> 'content_type' = 'application/json'
    and v_acquisition_metadata -> 'award_was_created' = 'false'::jsonb
    and v_acquisition_metadata -> 'source_was_inserted' = 'true'::jsonb then
    select request.* into v_request
    from public.source_page_requests request
    where request.id = v_origin_source_page_request_id
    for share;

    if found
      and v_request.status = 'matching'
      and v_request.worker_run_id is not distinct from v_origin_worker_run_id
      and v_request.matched_shared_award_id is not distinct from v_award_id
      and v_request.acquisition_kind = 'live_discovery'
      and v_request.notification_mode = 'first_capture_candidate'
      and v_request.onboarding_batch_id is null
      and v_request.parent_shared_award_source_id is not distinct from v_parent_shared_award_source_id
      and v_request.normalized_url is not distinct from v_url
      and v_request.capture_metadata ->> 'capture_file_hash'
        is not distinct from v_review_seal ->> 'capture_file_hash'
      and not (v_request.capture_metadata ? 'artifact_bytes')
      and v_request.capture_metadata -> 'retained_artifact' = v_retained_artifact
      and coalesce(v_request.capture_metadata ->> 'canonical_url', v_request.capture_metadata ->> 'final_url')
        is not distinct from v_url
      and v_request.ai_review ->> 'status' = 'accepted'
      and v_request.ai_review ->> 'source_relevance' is not distinct from v_review_seal ->> 'source_relevance'
      and v_request.ai_review ->> 'cycle_relevance' is not distinct from v_review_seal ->> 'cycle_relevance'
      and v_request.ai_review ->> 'officialness' is not distinct from v_review_seal ->> 'officialness'
      and v_request.ai_review ->> 'confidence' is not distinct from v_review_seal ->> 'confidence'
      and v_request.ai_review ->> 'page_type' = 'pdf'
      and exists (
        select 1
        from public.shared_award_sources parent
        where parent.id = v_parent_shared_award_source_id
          and parent.shared_award_id = v_award_id
          and parent.admin_review_status = 'open'
      ) then
      -- The request flags are not authoritative. Bind eligibility to the exact
      -- post-seed discovery ledger row and lock it through acquisition insert,
      -- so historical/bulk intake cannot be promoted by a mislabeled payload.
      perform 1
      from public.shared_award_source_discovered_links link
      where link.parent_shared_award_source_id = v_parent_shared_award_source_id
        and link.url_hash = public.awardping_sha256_text(v_url)
        and link.normalized_url = v_url
        and link.notification_mode = 'first_capture_candidate'
        and link.onboarding_batch_id is null
        and link.source_page_request_id = v_origin_source_page_request_id
      for share;

      if found then
        v_normalized_capture_text := btrim(
          regexp_replace(coalesce(v_request.capture_metadata ->> 'text', ''), '[[:space:]]+', ' ', 'g')
        );
        for v_quote in
          select quote.value
          from jsonb_array_elements(v_review_seal -> 'evidence_quotes') quote(value)
        loop
          if jsonb_typeof(v_quote) <> 'string' then
            v_all_quotes_exact := false;
            exit;
          end if;
          v_normalized_quote := btrim(regexp_replace(v_quote #>> '{}', '[[:space:]]+', ' ', 'g'));
          if v_normalized_quote = ''
            or position(v_normalized_quote in v_normalized_capture_text) = 0 then
            v_all_quotes_exact := false;
            exit;
          end if;
        end loop;
        v_first_capture_eligible := v_all_quotes_exact;
      end if;
    end if;
  end if;

  if v_first_capture_eligible then
    v_effective_notification_mode := 'first_capture_candidate';
    effective_disposition_reason := 'sealed_live_discovery_for_existing_award';
  elsif v_requested_notification_mode = 'first_capture_candidate'
    and v_acquisition_kind = 'live_discovery'
    and not v_award_was_created
    and v_onboarding_batch_id is null then
    -- A server-only mismatch must roll back the source insert as well as the
    -- acquisition. Inserting an immutable UNIQUE manual acquisition here would
    -- make a repaired replay impossible and silently strand this source.
    raise exception using
      errcode = '23514',
      message = 'Live first-capture artifact/evidence validation failed; source registration was rolled back for repair and replay.';
  elsif v_requested_notification_mode = 'manual_review'
    and not v_award_was_created
    and v_onboarding_batch_id is null then
    v_effective_notification_mode := 'manual_review';
    effective_disposition_reason := coalesce(
      nullif(v_acquisition_metadata ->> 'disposition_reason', ''),
      'explicit_manual_review'
    );
  else
    v_effective_notification_mode := 'baseline_only';
    effective_disposition_reason := coalesce(
      nullif(v_acquisition_metadata ->> 'disposition_reason', ''),
      'intentional_onboarding_baseline_only'
    );
  end if;

  acquisition_id := gen_random_uuid();
  insert into public.shared_award_source_acquisitions (
    id,
    shared_award_source_id,
    acquisition_kind,
    notification_mode,
    origin_source_page_request_id,
    origin_worker_run_id,
    parent_shared_award_source_id,
    onboarding_batch_id,
    review_seal,
    metadata
  ) values (
    acquisition_id,
    v_source.id,
    v_acquisition_kind,
    v_effective_notification_mode,
    v_origin_source_page_request_id,
    v_origin_worker_run_id,
    v_parent_shared_award_source_id,
    v_onboarding_batch_id,
    v_review_seal,
    v_acquisition_metadata || jsonb_build_object(
      'requested_notification_mode', v_requested_notification_mode,
      'effective_notification_mode', v_effective_notification_mode,
      'effective_disposition_reason', effective_disposition_reason,
      'server_policy_checked', true,
      'server_first_capture_eligible', v_first_capture_eligible,
      'server_artifact_binding', case
        when v_first_capture_eligible then jsonb_build_object(
          'source_id', v_source.id,
          'acquisition_id', acquisition_id,
          'request_id', v_origin_source_page_request_id,
          'file_hash', v_review_seal ->> 'capture_file_hash',
          'final_url', v_url,
          'artifact_prefix', v_retained_artifact ->> 'prefix'
        )
        else null
      end
    )
  );

  source_id := v_source.id;
  source_inserted := true;
  effective_notification_mode := v_effective_notification_mode;
  return next;
exception
  when no_data_found then
    raise exception using errcode = '23503', message = 'Source registration references a missing award or source.';
end;
$$;

revoke all on function public.register_shared_award_source_from_intake(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.register_shared_award_source_from_intake(jsonb, jsonb)
  to service_role;

-- These two rows are a deliberately narrow operator-approved recovery for the
-- Marshall 2027 documents that motivated this fix. No reason/source/date-based
-- historical backfill is allowed because old imports are not distinguishable
-- from live discovery.
insert into public.shared_award_source_acquisitions (
  id,
  shared_award_source_id,
  acquisition_kind,
  notification_mode,
  review_seal,
  metadata,
  acquired_at
)
select
  recovery.acquisition_id,
  source.id,
  'operator_historical_exception',
  'first_capture_candidate',
  jsonb_build_object(
    'id', recovery.review_id,
    'sealed', true,
    'status', 'accepted',
    'award_relevance', 'primary',
    'source_relevance', 'primary',
    'cycle_relevance', 'current_or_upcoming',
    'officialness', 'official',
    'confidence', 'high',
    'page_type', 'pdf',
    'capture_file_hash', recovery.capture_file_hash,
    'capture_content_type', 'application/pdf',
    'capture_final_url', recovery.url,
    'exact_evidence_verified', true,
    'evidence_quotes', jsonb_build_array(recovery.evidence_quote),
    'review_kind', 'operator_verified_historical_recovery',
    'reviewed_at', '2026-07-16T00:00:00.000Z'
  ),
  jsonb_build_object(
    'recovery_scope', 'marshall_2027_two_known_documents_only',
    'recovery_reason', 'First capture was silently treated as a baseline before first-observation events existed.',
    'historical_backfill_policy', 'explicit_source_and_hash_allowlist',
    'expected_source_url', recovery.url
  ),
  '2026-07-16T00:00:00.000Z'::timestamptz
from public.shared_award_sources source
join (
  values
    (
      '6975274d-a362-4af9-af5b-bf72742dbfd1'::uuid,
      'marshall-2027-application-statements-review'::text,
      '37a03efe-cd73-4061-bee0-d194e7ff5c2b'::uuid,
      'https://www.marshallscholarship.org/wp-content/uploads/2026/05/2027-Marshall-Application-Statements.pdf'::text,
      '0f864072d723ff69afe4bb4e4f8ed262199be22506d9ac8942115c57fa6c9c5a'::text,
      'Candidates must also include a brief outline of why they have chosen their second-choice courses and institutions. (500 words maximum)'::text
    ),
    (
      'a43846ed-abcc-4b16-9fd5-191ddf7ab9cb'::uuid,
      'marshall-2027-rules-review'::text,
      '7dccefb4-3f8c-4fa8-9e9d-c7d909e07ced'::uuid,
      'https://www.marshallscholarship.org/wp-content/uploads/2026/05/2027-Rules-for-Marshall-Scholarship-Candidates_final.pdf'::text,
      'edab936aa2c9b08bd35280e1a27935527fe9baf0c29f5c8b2f069497dffbe88a'::text,
      'Candidates must indicate their first- and second-choice courses for each year of projected study as part of their Marshall application.'::text
    )
) as recovery(acquisition_id, review_id, source_id, url, capture_file_hash, evidence_quote)
  on recovery.source_id = source.id and recovery.url = source.url
where source.admin_review_status = 'open'
on conflict (shared_award_source_id) do nothing;

create or replace function public.publish_shared_award_initial_document_event(
  p_event jsonb,
  p_evidence jsonb
)
returns table(change_event_id uuid, evidence_id uuid, inserted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_acquisition public.shared_award_source_acquisitions%rowtype;
  v_source public.shared_award_sources%rowtype;
  v_award public.shared_awards%rowtype;
  v_existing_event public.shared_award_change_events%rowtype;
  v_existing_evidence public.shared_award_change_event_visual_evidence%rowtype;
  v_candidate_id uuid;
  v_acquisition_id uuid;
  v_award_id uuid;
  v_source_id uuid;
  v_event_id uuid;
  v_evidence_id uuid;
  v_event_inserted boolean := false;
  v_evidence_inserted boolean := false;
  v_source_url text;
  v_source_title text;
  v_source_page_type text;
  v_previous_hash text;
  v_new_hash text;
  v_summary text;
  v_change_details jsonb;
  v_previous_capture jsonb;
  v_current_capture jsonb;
  v_localization jsonb;
  v_attestation_sha256 text;
  v_attested_source_id text;
  v_attested_award_id text;
  v_attested_acquisition_id text;
  v_attested_source_url text;
  v_attested_final_url text;
  v_attested_review_final_url text;
  v_attested_capture_file_sha256 text;
  v_attested_review_capture_file_sha256 text;
  v_acquisition_final_url text;
  v_candidate_attestation_json text;
  v_candidate_attestation_sha256 text;
  v_attested_capture_at timestamptz;
  v_first_observed_at timestamptz;
  v_detected_at timestamptz;
  v_recognized_at timestamptz;
  v_generated_at timestamptz;
begin
  if jsonb_typeof(p_event) <> 'object' or jsonb_typeof(p_evidence) <> 'object' then
    raise exception using errcode = '22023', message = 'Event and evidence payloads must be JSON objects.';
  end if;

  begin
    v_candidate_id := nullif(p_event ->> 'visual_review_candidate_id', '')::uuid;
    v_acquisition_id := nullif(p_event ->> 'source_acquisition_id', '')::uuid;
    v_award_id := nullif(p_event ->> 'shared_award_id', '')::uuid;
    v_source_id := nullif(p_event ->> 'shared_award_source_id', '')::uuid;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Initial-document event identifiers must be valid UUIDs.';
  end;

  if v_candidate_id is null or v_acquisition_id is null
    or v_award_id is null or v_source_id is null then
    raise exception using errcode = '23514', message = 'Initial-document publication requires candidate, acquisition, award, and source IDs.';
  end if;

  select candidate.* into strict v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = v_candidate_id
  for update;

  if v_candidate.candidate_scope <> 'initial_official_document'
    or v_candidate.source_acquisition_id is distinct from v_acquisition_id
    or v_candidate.shared_award_id is distinct from v_award_id
    or v_candidate.shared_award_source_id is distinct from v_source_id
    or v_candidate.status not in ('succeeded', 'published') then
    raise exception using errcode = '23514', message = 'Initial-document candidate identity or status is invalid.';
  end if;
  if v_candidate.model is not null
    or v_candidate.gemini_batch_name is not null
    or v_candidate.gemini_batch_request_key is not null
    or v_candidate.estimated_cost_usd is not null
    or coalesce(v_candidate.actual_usage, '{}'::jsonb) <> '{}'::jsonb
    or v_candidate.ai_result #>> '{review_execution,creates_api_charge}' is distinct from 'false'
    or v_candidate.ai_result ->> 'candidate_scope' is distinct from 'initial_official_document'
    or v_candidate.ai_result ->> 'observation_kind' is distinct from 'first_observation' then
    raise exception using errcode = '23514', message = 'Initial-document candidates must use the sealed zero-charge deterministic review path.';
  end if;

  select acquisition.* into strict v_acquisition
  from public.shared_award_source_acquisitions acquisition
  where acquisition.id = v_acquisition_id
  for share;
  if v_acquisition.shared_award_source_id is distinct from v_source_id
    or v_acquisition.notification_mode <> 'first_capture_candidate'
    or v_acquisition.onboarding_batch_id is not null
    or coalesce((v_acquisition.review_seal ->> 'sealed')::boolean, false) is not true
    or v_acquisition.review_seal ->> 'status' is distinct from 'accepted'
    or v_acquisition.review_seal ->> 'page_type' is distinct from 'pdf'
    or v_acquisition.review_seal ->> 'capture_file_hash' is distinct from v_candidate.new_file_hash then
    raise exception using errcode = '23514', message = 'Source acquisition is not eligible for a first-capture notification.';
  end if;

  select source.* into strict v_source
  from public.shared_award_sources source
  where source.id = v_source_id
  for update;
  if v_source.shared_award_id is distinct from v_award_id
    or v_source.admin_review_status <> 'open' then
    raise exception using errcode = '23514', message = 'Initial-document publication requires an open source for the same award.';
  end if;

  select award.* into strict v_award
  from public.shared_awards award
  where award.id = v_award_id
  for share;
  if v_award.status <> 'active' then
    raise exception using errcode = '23514', message = 'Initial-document publication requires an active award.';
  end if;

  v_source_url := nullif(btrim(p_event ->> 'source_url'), '');
  v_source_title := nullif(btrim(p_event ->> 'source_title'), '');
  v_source_page_type := nullif(btrim(p_event ->> 'source_page_type'), '');
  v_previous_hash := nullif(btrim(p_event ->> 'previous_hash'), '');
  v_new_hash := nullif(btrim(p_event ->> 'new_hash'), '');
  v_summary := nullif(btrim(p_event ->> 'summary'), '');
  v_change_details := coalesce(p_event -> 'change_details', '{}'::jsonb);
  v_attested_source_id := nullif(btrim(v_candidate.prompt_payload #>> '{first_observation_attestation,body,source,id}'), '');
  v_attested_award_id := nullif(btrim(v_candidate.prompt_payload #>> '{first_observation_attestation,body,source,shared_award_id}'), '');
  v_attested_acquisition_id := nullif(btrim(v_candidate.prompt_payload #>> '{first_observation_attestation,body,acquisition,id}'), '');
  v_attested_source_url := nullif(btrim(v_candidate.prompt_payload #>> '{first_observation_attestation,body,source,url}'), '');
  v_attested_final_url := nullif(btrim(v_candidate.prompt_payload #>> '{first_observation_attestation,body,capture,final_url}'), '');
  v_attested_review_final_url := nullif(btrim(v_candidate.prompt_payload #>> '{first_observation_attestation,body,sealed_review,capture_final_url}'), '');
  v_attested_capture_file_sha256 := nullif(btrim(v_candidate.prompt_payload #>> '{first_observation_attestation,body,capture,file_sha256}'), '');
  v_attested_review_capture_file_sha256 := nullif(btrim(v_candidate.prompt_payload #>> '{first_observation_attestation,body,sealed_review,capture_file_sha256}'), '');
  v_acquisition_final_url := nullif(btrim(v_acquisition.review_seal ->> 'capture_final_url'), '');
  v_candidate_attestation_json := nullif(
    v_candidate.prompt_payload #>> '{first_observation_attestation,canonical_json}',
    ''
  );
  v_candidate_attestation_sha256 := nullif(
    btrim(v_candidate.prompt_payload #>> '{first_observation_attestation,sha256}'),
    ''
  );
  if v_source_url is null or v_previous_hash is null or v_new_hash is null or v_summary is null
    or jsonb_typeof(v_change_details) <> 'object' then
    raise exception using errcode = '23514', message = 'Initial-document event identity and summary are incomplete.';
  end if;

  -- This scope is created by this migration, so it has no legacy redirect
  -- exception. A later visual fetch cannot rewrite source identity: the event,
  -- current source, candidate, immutable acquisition seal, and every URL in the
  -- canonical attestation must all name the same document. The attestation and
  -- current PDF hashes are independently rebound here before publication.
  if v_source_url is distinct from v_source.url
    or v_source_url is distinct from v_candidate.source_url
    or v_source_url is distinct from v_acquisition_final_url
    or v_source_url is distinct from v_attested_source_url
    or v_source_url is distinct from v_attested_final_url
    or v_source_url is distinct from v_attested_review_final_url
    or v_attested_source_id is distinct from v_source_id::text
    or v_attested_award_id is distinct from v_award_id::text
    or v_attested_acquisition_id is distinct from v_acquisition_id::text
    or jsonb_typeof(v_candidate.prompt_payload #> '{first_observation_attestation,body}') is distinct from 'object'
    or v_candidate_attestation_json is null
    or v_candidate_attestation_json::jsonb is distinct from
      v_candidate.prompt_payload #> '{first_observation_attestation,body}'
    or v_candidate_attestation_sha256 is null
    or v_candidate_attestation_sha256 !~ '^[0-9a-f]{64}$'
    or public.awardping_sha256_text(v_candidate_attestation_json)
      is distinct from v_candidate_attestation_sha256
    or v_candidate.prompt_payload #>> '{hashes,first_observation_attestation_sha256}'
      is distinct from v_candidate_attestation_sha256
    or v_candidate.previous_file_hash is distinct from v_candidate_attestation_sha256
    or v_candidate.previous_snapshot_ref ->> 'attestation_sha256'
      is distinct from v_candidate_attestation_sha256
    or v_previous_hash is distinct from v_candidate_attestation_sha256
    or v_attested_capture_file_sha256 is distinct from v_candidate.new_file_hash
    or v_attested_review_capture_file_sha256 is distinct from v_candidate.new_file_hash
    or v_acquisition.review_seal ->> 'capture_file_hash'
      is distinct from v_candidate.new_file_hash
    or v_source_title is distinct from v_candidate.source_title
    or v_source_page_type is distinct from v_candidate.source_page_type
    or v_source_page_type is distinct from 'pdf' then
    raise exception using errcode = '23514', message = 'Initial-document source identity does not match its candidate.';
  end if;
  if v_change_details ->> 'event_kind' is distinct from 'new_official_document'
    or v_change_details ->> 'candidate_scope' is distinct from 'initial_official_document'
    or v_change_details ->> 'observation_kind' is distinct from 'first_observation'
    or v_change_details ->> 'candidate_signature' is distinct from v_candidate.candidate_signature
    or v_change_details ->> 'source_acquisition_id' is distinct from v_acquisition_id::text
    or v_change_details #>> '{source,source_url}' is distinct from v_source_url
    or v_change_details ->> 'exact_after' is distinct from v_candidate.ai_result ->> 'exact_after'
    or v_change_details ->> 'exact_after' is distinct from v_candidate.deterministic_diff ->> 'exact_after'
    or not (
      v_acquisition.review_seal -> 'evidence_quotes'
        @> jsonb_build_array(v_change_details ->> 'exact_after')
    )
    or coalesce((v_change_details ->> 'first_observation')::boolean, false) is not true then
    raise exception using errcode = '23514', message = 'Initial-document details must make the first-observation semantics explicit.';
  end if;

  if p_evidence ->> 'evidence_status' is distinct from 'not_applicable_new_document'
    or p_evidence ->> 'visual_review_candidate_id' is distinct from v_candidate_id::text
    or p_evidence ->> 'shared_award_id' is distinct from v_award_id::text
    or p_evidence ->> 'shared_award_source_id' is distinct from v_source_id::text
    or p_evidence ->> 'candidate_signature' is distinct from v_candidate.candidate_signature
    or p_evidence ->> 'source_acquisition_id' is distinct from v_acquisition_id::text then
    raise exception using errcode = '23514', message = 'Initial-document evidence identity is invalid.';
  end if;

  v_previous_capture := coalesce(p_evidence -> 'previous_capture', '{}'::jsonb);
  v_current_capture := coalesce(p_evidence -> 'current_capture', '{}'::jsonb);
  v_localization := coalesce(p_evidence -> 'localization', '{}'::jsonb);
  v_attestation_sha256 := nullif(v_previous_capture #>> '{metadata,sha256}', '');
  if v_previous_capture ->> 'kind' is distinct from 'first_observation_attestation'
    or v_previous_capture ->> 'state_id' is distinct from 'first_observation'
    or jsonb_typeof(v_previous_capture -> 'full') is distinct from 'null'
    or v_attestation_sha256 !~ '^[0-9a-f]{64}$'
    or v_previous_capture #>> '{capture_hashes,attestation_hash}' is distinct from v_attestation_sha256
    or v_candidate.previous_snapshot_ref ->> 'attestation_sha256' is distinct from v_attestation_sha256
    or v_candidate.prompt_payload #>> '{first_observation_attestation,sha256}' is distinct from v_attestation_sha256
    or v_previous_hash is distinct from v_attestation_sha256 then
    raise exception using errcode = '23514', message = 'First-observation attestation binding is invalid.';
  end if;
  perform public.awardping_assert_permanent_visual_artifact(
    v_previous_capture -> 'metadata',
    'previous.first_observation_attestation'
  );

  if v_current_capture ->> 'kind' is distinct from 'pdf'
    or v_current_capture ->> 'state_id' is distinct from 'document'
    or v_current_capture #>> '{full,content_type}' not like 'application/pdf%'
    or v_current_capture #>> '{metadata,content_type}' not like 'application/json%'
    or v_current_capture #>> '{capture_hashes,file_hash}' is distinct from v_candidate.new_file_hash
    or v_current_capture #>> '{full,sha256}' is distinct from v_candidate.new_file_hash
    or v_new_hash is distinct from v_candidate.new_file_hash then
    raise exception using errcode = '23514', message = 'Current official PDF evidence is incomplete or does not match the candidate.';
  end if;
  perform public.awardping_assert_permanent_visual_artifact(v_current_capture -> 'full', 'current.document');
  perform public.awardping_assert_permanent_visual_artifact(v_current_capture -> 'metadata', 'current.metadata');
  perform public.awardping_validate_candidate_snapshot_manifest(
    v_candidate.new_snapshot_ref,
    v_candidate.prompt_payload -> 'new_snapshot_ref',
    v_candidate.prompt_payload #>> '{hashes,new_artifact_manifest_digest}',
    'current'
  );
  perform public.awardping_validate_candidate_capture_binding(
    v_current_capture,
    v_candidate.new_snapshot_ref,
    v_candidate.new_file_hash,
    v_candidate_id,
    'current',
    true
  );

  if jsonb_typeof(v_localization) <> 'object'
    or v_localization ->> 'direction' is distinct from 'added'
    or v_localization #>> '{sides,previous,status}' is distinct from 'not_applicable_first_observation'
    or v_localization #>> '{sides,current,status}' is distinct from 'not_applicable_pdf' then
    raise exception using errcode = '23514', message = 'Initial-document localization must truthfully describe an added current-only PDF.';
  end if;

  begin
    v_attested_capture_at := nullif(
      btrim(v_candidate.prompt_payload #>> '{first_observation_attestation,body,capture,captured_at}'),
      ''
    )::timestamptz;
    v_first_observed_at := nullif(btrim(v_change_details ->> 'first_observed_at'), '')::timestamptz;
    v_detected_at := nullif(btrim(p_event ->> 'detected_at'), '')::timestamptz;
    v_recognized_at := nullif(btrim(v_change_details ->> 'recognized_at'), '')::timestamptz;
    v_generated_at := nullif(btrim(v_change_details ->> 'generated_at'), '')::timestamptz;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Initial-document event timestamps must be valid.';
  end;

  -- The retained capture remains historical evidence, while publication is
  -- recognized at candidate creation. Bind both meanings server-side so a
  -- caller cannot backdate a recovery out of the digest window or imply that
  -- AwardPing first captured the document when the recovery was recognized.
  if v_attested_capture_at is null
    or v_first_observed_at is distinct from v_attested_capture_at
    or v_detected_at is distinct from v_candidate.created_at
    or v_recognized_at is distinct from v_candidate.created_at
    or v_generated_at is distinct from v_candidate.created_at then
    raise exception using errcode = '23514', message = 'Initial-document event timestamps do not match immutable capture and candidate recognition provenance.';
  end if;

  insert into public.shared_award_change_events (
    shared_award_id,
    shared_award_source_id,
    source_url,
    source_title,
    source_page_type,
    previous_snapshot_id,
    new_snapshot_id,
    previous_hash,
    new_hash,
    summary,
    change_details,
    detected_at,
    visual_review_candidate_id
  ) values (
    v_award_id,
    v_source_id,
    v_source_url,
    v_source_title,
    v_source_page_type,
    null,
    null,
    v_previous_hash,
    v_new_hash,
    v_summary,
    v_change_details,
    v_detected_at,
    v_candidate_id
  )
  on conflict (shared_award_id, source_url, previous_hash, new_hash) do nothing
  returning id into v_event_id;
  v_event_inserted := found;

  if v_event_id is null then
    select event.* into strict v_existing_event
    from public.shared_award_change_events event
    where event.shared_award_id = v_award_id
      and event.source_url = v_source_url
      and event.previous_hash = v_previous_hash
      and event.new_hash = v_new_hash
    for update;
    if v_existing_event.shared_award_source_id is distinct from v_source_id
      or v_existing_event.visual_review_candidate_id is distinct from v_candidate_id
      or v_existing_event.detected_at is distinct from v_candidate.created_at
      or v_existing_event.summary is distinct from v_summary
      or v_existing_event.change_details is distinct from v_change_details then
      raise exception using errcode = '23514', message = 'Existing first-observation event conflicts with this publication retry.';
    end if;
    v_event_id := v_existing_event.id;
  end if;

  insert into public.shared_award_change_event_visual_evidence (
    change_event_id,
    shared_award_id,
    shared_award_source_id,
    visual_review_candidate_id,
    candidate_signature,
    bucket,
    evidence_status,
    previous_capture,
    current_capture,
    localization,
    evidence_schema_version,
    verified_at,
    backfilled_at
  ) values (
    v_event_id,
    v_award_id,
    v_source_id,
    v_candidate_id,
    v_candidate.candidate_signature,
    nullif(p_evidence ->> 'bucket', ''),
    'not_applicable_new_document',
    v_previous_capture,
    v_current_capture,
    v_localization,
    coalesce(nullif(p_evidence ->> 'evidence_schema_version', ''), 'visual-event-evidence-v1'),
    null,
    null
  )
  on conflict on constraint shared_award_change_event_visual_evidence_pkey do nothing
  returning id into v_evidence_id;
  v_evidence_inserted := found;

  if v_evidence_id is null then
    select evidence.* into strict v_existing_evidence
    from public.shared_award_change_event_visual_evidence evidence
    where evidence.change_event_id = v_event_id;
    if v_existing_evidence.visual_review_candidate_id is distinct from v_candidate_id
      or v_existing_evidence.candidate_signature is distinct from v_candidate.candidate_signature
      or v_existing_evidence.evidence_status <> 'not_applicable_new_document'
      or v_existing_evidence.previous_capture <> v_previous_capture
      or v_existing_evidence.current_capture <> v_current_capture
      or v_existing_evidence.localization <> v_localization then
      raise exception using errcode = '23514', message = 'Existing first-observation evidence conflicts with this publication retry.';
    end if;
    v_evidence_id := v_existing_evidence.id;
  end if;

  change_event_id := v_event_id;
  evidence_id := v_evidence_id;
  inserted := v_event_inserted or v_evidence_inserted;
  return next;
exception
  when no_data_found then
    raise exception using errcode = '23503', message = 'Initial-document publication references missing durable provenance.';
end;
$$;

revoke all on function public.publish_shared_award_initial_document_event(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_shared_award_initial_document_event(jsonb, jsonb)
  to service_role;

-- First-observation validation failures are operator work, but they are not
-- ordinary paid visual-review retries. Give them their own durable category so
-- the action inbox can state the evidence problem and possible charge honestly.
alter table public.manual_quarantine_registry
  drop constraint if exists manual_quarantine_registry_category_check,
  drop constraint if exists manual_quarantine_registry_classification_category_check,
  drop constraint if exists manual_quarantine_registry_terminal_category_count_check;

alter table public.manual_quarantine_registry
  add constraint manual_quarantine_registry_category_check check (
    category in (
      'public_page',
      'visual_review',
      'initial_document',
      'historical_localization'
    )
  ),
  add constraint manual_quarantine_registry_classification_category_check check (
    (
      classification = 'actionable_quarantine'
      and category in ('public_page', 'visual_review', 'initial_document')
    )
    or (
      classification = 'historical_limitation'
      and category = 'historical_localization'
    )
  ),
  add constraint manual_quarantine_registry_terminal_category_count_check check (
    (category = 'public_page' and terminal_failure_count between 0 and 2)
    or (category in ('visual_review', 'initial_document') and terminal_failure_count = 1)
    or (category = 'historical_localization' and terminal_failure_count = 0)
  );

create or replace function public.record_initial_official_document_quarantine(
  p_source_id uuid,
  p_acquisition_id uuid,
  p_reason_code text,
  p_evidence jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_source public.shared_award_sources%rowtype;
  v_acquisition public.shared_award_source_acquisitions%rowtype;
  v_reason_code text := lower(btrim(coalesce(p_reason_code, '')));
  v_evidence jsonb;
  v_quarantine_id uuid;
  v_failure_stage text := lower(btrim(coalesce(p_evidence ->> 'failure_stage', 'capture_evidence')));
  v_retry_mode text;
  v_recommended_action text;
begin
  if v_reason_code = ''
    or length(v_reason_code) > 200
    or v_reason_code !~ '^[a-z0-9_]+$' then
    raise exception using errcode = '22023', message = 'A normalized initial-document failure reason is required.';
  end if;
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception using errcode = '22023', message = 'Initial-document quarantine evidence must be a JSON object.';
  end if;
  v_retry_mode := case
    when v_failure_stage = 'publication_persistence'
      then 'automatic_zero_charge_publication_retry'
    when v_failure_stage in (
      'publication_guard',
      'current_policy_validation',
      'source_identity',
      'candidate_artifact_recovery',
      'permanent_evidence_preparation'
    )
      then 'manual_candidate_evidence_repair'
    else 'automatic_local_evidence_retry'
  end;
  v_recommended_action := case
    when v_failure_stage = 'source_identity' then
      'Restore the monitored source URL to the immutable candidate URL or the exact final URL sealed by its retained capture. The retry is free and must not rewrite candidate evidence.'
    when v_failure_stage = 'candidate_artifact_recovery' then
      'Inspect the candidate-bound local paths, immutable artifact manifest, and exact R2 source generation. Repairing and retrying this candidate is free; do not overwrite conflicting bytes, substitute another document, or rewrite candidate identity.'
    when v_failure_stage = 'permanent_evidence_preparation' then
      'Inspect the verified candidate artifacts and permanent R2 evidence dependency, then retry the same candidate without charge. Do not substitute another document or rewrite candidate identity.'
    when v_failure_stage = 'publication_persistence' then
      'Verify the atomic initial-document event/evidence publication RPC, migration, and database availability. AwardPing will retry the retained candidate automatically without charge; do not create a replacement review.'
    when v_retry_mode = 'manual_candidate_evidence_repair' then
      'Inspect the sealed acquisition, retained PDF, and deterministic candidate. Repairing candidate evidence is free; approve another paid new-page review only if the sealed intake review itself must be replaced.'
    else
      'Inspect the sealed acquisition and retained PDF first. AwardPing will retry local evidence validation without charge; approve another paid new-page review only if the sealed intake evidence itself must be replaced.'
  end;

  select * into strict v_source
  from public.shared_award_sources source
  where source.id = p_source_id
  for update;

  select * into strict v_acquisition
  from public.shared_award_source_acquisitions acquisition
  where acquisition.id = p_acquisition_id
    and acquisition.shared_award_source_id = v_source.id
    and acquisition.notification_mode = 'first_capture_candidate';

  v_evidence := jsonb_build_object(
    'schema_version', 'awardping.initial-document-quarantine.v1',
    'failure', jsonb_build_object(
      'reason_code', v_reason_code,
      'observed_at', v_now,
      'details', p_evidence || jsonb_build_object('failure_stage', v_failure_stage)
    ),
    'source', jsonb_build_object(
      'id', v_source.id,
      'shared_award_id', v_source.shared_award_id,
      'url', v_source.url,
      'title', coalesce(v_source.display_title, v_source.title)
    ),
    'acquisition', jsonb_build_object(
      'id', v_acquisition.id,
      'acquisition_kind', v_acquisition.acquisition_kind,
      'notification_mode', v_acquisition.notification_mode,
      'origin_source_page_request_id', v_acquisition.origin_source_page_request_id,
      'origin_worker_run_id', v_acquisition.origin_worker_run_id,
      'parent_shared_award_source_id', v_acquisition.parent_shared_award_source_id,
      'acquired_at', v_acquisition.acquired_at,
      'review_seal', v_acquisition.review_seal
    )
  );

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
    shared_award_source_id,
    primary_source_table,
    primary_source_record_id,
    evidence_record_count,
    evidence,
    evidence_hash,
    first_observed_at,
    last_observed_at,
    quarantined_at,
    resolved_at,
    resolved_by,
    resolution_note
  ) values (
    'initial-document:' || v_acquisition.id::text,
    'initial-document:' || v_acquisition.id::text,
    'actionable_quarantine',
    'initial_document',
    'quarantined',
    true,
    true,
    1,
    'high',
    'delayed',
    'Source intake and evidence',
    v_retry_mode,
    'none',
    coalesce(nullif(v_source.display_title, ''), nullif(v_source.title, ''), v_source.url) ||
      ': new-document evidence needs review',
    v_reason_code,
    coalesce(
      nullif(p_evidence ->> 'message', ''),
      'The first-observation candidate could not be bound safely to its sealed source acquisition and retained PDF.'
    ),
    v_recommended_action,
    v_source.shared_award_id,
    v_source.id,
    'shared_award_source_acquisitions',
    v_acquisition.id,
    1,
    v_evidence,
    public.manual_quarantine_evidence_hash(v_evidence),
    v_now,
    v_now,
    v_now,
    null,
    null,
    null
  )
  on conflict (quarantine_key) do update set
    status = case
      when public.manual_quarantine_registry.status = 'in_review' then 'in_review'
      else 'quarantined'
    end,
    retry_mode = excluded.retry_mode,
    retry_charge = excluded.retry_charge,
    reason_code = excluded.reason_code,
    reason = excluded.reason,
    recommended_action = excluded.recommended_action,
    shared_award_id = excluded.shared_award_id,
    shared_award_source_id = excluded.shared_award_source_id,
    primary_source_table = excluded.primary_source_table,
    primary_source_record_id = excluded.primary_source_record_id,
    evidence = excluded.evidence,
    evidence_hash = excluded.evidence_hash,
    first_observed_at = least(
      public.manual_quarantine_registry.first_observed_at,
      excluded.first_observed_at
    ),
    last_observed_at = excluded.last_observed_at,
    quarantined_at = case
      when public.manual_quarantine_registry.status = 'resolved' then v_now
      else public.manual_quarantine_registry.quarantined_at
    end,
    resolved_at = null,
    resolved_by = null,
    resolution_note = null
  returning id into v_quarantine_id;

  perform public.refresh_manual_quarantine_registry_state(v_now);
  return v_quarantine_id;
exception
  when no_data_found then
    raise exception using errcode = '23503', message = 'Initial-document quarantine references missing or mismatched provenance.';
end;
$$;

revoke all on function public.record_initial_official_document_quarantine(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_initial_official_document_quarantine(uuid, uuid, text, jsonb)
  to service_role;

create or replace function public.resolve_initial_official_document_quarantine(
  p_acquisition_id uuid,
  p_candidate_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_updated boolean := false;
  v_updated_count integer := 0;
begin
  if not exists (
    select 1
    from public.shared_award_visual_review_candidates candidate
    where candidate.id = p_candidate_id
      and candidate.candidate_scope = 'initial_official_document'
      and candidate.source_acquisition_id = p_acquisition_id
      and candidate.status in ('succeeded', 'published')
  ) then
    raise exception using errcode = '23514', message = 'Only a valid completed first-observation candidate can resolve this quarantine.';
  end if;

  with resolution as (
    select
      registry.id,
      registry.evidence || jsonb_build_object(
        'resolution', jsonb_build_object(
          'resolved_at', v_now,
          'reason', 'valid_initial_document_candidate_created',
          'candidate_id', p_candidate_id
        )
      ) as resolved_evidence
    from public.manual_quarantine_registry registry
    join public.shared_award_visual_review_candidates candidate
      on candidate.id = p_candidate_id
      and candidate.candidate_scope = 'initial_official_document'
      and candidate.source_acquisition_id = p_acquisition_id
    where registry.quarantine_key = 'initial-document:' || p_acquisition_id::text
      and registry.category = 'initial_document'
      and registry.status in ('quarantined', 'in_review')
      and (
        candidate.status = 'published'
        or (
          candidate.status = 'succeeded'
          and candidate.rejection_reason is null
          and coalesce(candidate.worker_metadata ->> 'rejection_disposition', '') not like 'actionable_%'
          and coalesce(
            registry.evidence #>> '{failure,details,failure_stage}',
            'capture_evidence'
          ) = 'capture_evidence'
        )
      )
    for update
  )
  update public.manual_quarantine_registry registry
  set
    status = 'resolved',
    resolved_at = v_now,
    resolved_by = 'initial-document-candidate-worker',
    resolution_note = 'A valid deterministic first-observation candidate now binds the sealed acquisition to retained PDF evidence.',
    evidence = resolution.resolved_evidence,
    evidence_hash = public.manual_quarantine_evidence_hash(resolution.resolved_evidence)
  from resolution
  where registry.id = resolution.id;

  get diagnostics v_updated_count = row_count;
  v_updated := v_updated_count > 0;
  if v_updated then
    perform public.refresh_manual_quarantine_registry_state(v_now);
  end if;
  return v_updated;
end;
$$;

revoke all on function public.resolve_initial_official_document_quarantine(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_initial_official_document_quarantine(uuid, uuid)
  to service_role;

comment on table public.shared_award_source_acquisitions is
  'Immutable provenance and sealed material-review evidence for the first accepted acquisition of a monitored source.';
comment on function public.publish_shared_award_initial_document_event(jsonb, jsonb) is
  'Atomically publishes a truthful current-only first-observation event with an immutable attestation and retained official PDF; bulk onboarding is ineligible.';
