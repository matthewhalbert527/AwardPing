-- A failed paid review is never resubmitted merely because a retry counter is
-- below a limit. A site admin approves one exact failed candidate version;
-- the worker consumes that approval atomically when it returns the candidate
-- to pending. Existing-provider response recovery remains a separate no-cost
-- path and does not consume an approval.

create table public.gemini_paid_retry_approvals (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  candidate_id uuid not null
    references public.shared_award_visual_review_candidates(id) on delete restrict,
  lane_key text not null check (
    lane_key in ('new_page_review', 'changed_page_review')
  ),
  candidate_updated_at timestamptz not null,
  failure_fingerprint text not null check (
    failure_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  approved_request_fingerprint text not null check (
    approved_request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  status text not null default 'approved' check (
    status in ('approved', 'consumed', 'revoked', 'expired')
  ),
  reason text not null,
  approved_by text not null,
  approved_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_candidate_updated_at timestamptz,
  authorized_provider_request_fingerprint text check (
    authorized_provider_request_fingerprint is null
    or authorized_provider_request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  provider_request_bound_at timestamptz,
  constraint gemini_paid_retry_approval_text_check check (
    pg_catalog.length(pg_catalog.btrim(reason)) between 1 and 1000
    and pg_catalog.length(pg_catalog.btrim(approved_by)) between 1 and 500
  ),
  constraint gemini_paid_retry_approval_time_check check (
    approved_at < expires_at
    and expires_at <= approved_at + interval '24 hours'
    and (
      (status = 'consumed' and consumed_at is not null
        and consumed_candidate_updated_at is not null)
      or (status <> 'consumed' and consumed_at is null
        and consumed_candidate_updated_at is null)
    )
  ),
  constraint gemini_paid_retry_provider_request_binding_check check (
    (authorized_provider_request_fingerprint is null
      and provider_request_bound_at is null)
    or (status = 'consumed'
      and authorized_provider_request_fingerprint is not null
      and provider_request_bound_at is not null)
  )
);

create unique index gemini_paid_retry_approvals_one_active_idx
  on public.gemini_paid_retry_approvals(candidate_id)
  where status = 'approved';

create index gemini_paid_retry_approvals_status_expiry_idx
  on public.gemini_paid_retry_approvals(status, expires_at, approved_at);

alter table public.gemini_paid_retry_approvals enable row level security;
revoke all on table public.gemini_paid_retry_approvals
  from public, anon, authenticated, service_role;
grant select on table public.gemini_paid_retry_approvals to service_role;

create or replace function private.visual_review_paid_retry_failure_fingerprint(
  p_candidate_id uuid,
  p_candidate_updated_at timestamptz,
  p_rejection_reason text,
  p_gemini_batch_name text,
  p_retry_count bigint
)
returns text
language sql
stable
set search_path = ''
as $$
  select public.stage1_publication_evidence_hash(
    pg_catalog.jsonb_build_object(
      'candidate_id', p_candidate_id,
      'candidate_updated_at', p_candidate_updated_at,
      'rejection_reason', p_rejection_reason,
      'gemini_batch_name', p_gemini_batch_name,
      'retry_count', greatest(0::bigint, p_retry_count)
    )
  );
$$;

revoke all on function private.visual_review_paid_retry_failure_fingerprint(
  uuid, timestamptz, text, text, bigint
) from public, anon, authenticated, service_role;

-- This is the exact candidate request material an operator approves. Provider,
-- lease, status, and worker-journal fields are deliberately excluded; every
-- field capable of changing the review question or its evidence is included.
create or replace function private.visual_review_paid_request_fingerprint(
  p_candidate public.shared_award_visual_review_candidates
)
returns text
language sql
stable
set search_path = ''
as $$
  select public.stage1_publication_evidence_hash(
    pg_catalog.jsonb_build_object(
      'candidate_signature', p_candidate.candidate_signature,
      'gemini_batch_request_key', p_candidate.gemini_batch_request_key,
      'candidate_scope', p_candidate.candidate_scope,
      'shared_award_id', p_candidate.shared_award_id,
      'shared_award_source_id', p_candidate.shared_award_source_id,
      'source_acquisition_id', p_candidate.source_acquisition_id,
      'source_url', p_candidate.source_url,
      'source_title', p_candidate.source_title,
      'source_page_type', p_candidate.source_page_type,
      'previous_snapshot_ref', p_candidate.previous_snapshot_ref,
      'new_snapshot_ref', p_candidate.new_snapshot_ref,
      'previous_text_hash', p_candidate.previous_text_hash,
      'new_text_hash', p_candidate.new_text_hash,
      'previous_image_hash', p_candidate.previous_image_hash,
      'new_image_hash', p_candidate.new_image_hash,
      'previous_file_hash', p_candidate.previous_file_hash,
      'new_file_hash', p_candidate.new_file_hash,
      'deterministic_diff', p_candidate.deterministic_diff,
      'deterministic_classification', p_candidate.deterministic_classification,
      'prompt_payload', p_candidate.prompt_payload,
      'prompt_context', p_candidate.prompt_context
    )
  );
$$;

revoke all on function private.visual_review_paid_request_fingerprint(
  public.shared_award_visual_review_candidates
) from public, anon, authenticated, service_role;

create or replace function public.approve_visual_review_paid_retry(
  p_candidate_id uuid,
  p_expected_candidate_updated_at timestamptz,
  p_reason text,
  p_actor text
)
returns public.gemini_paid_retry_approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_retry_count bigint;
  v_failure_fingerprint text;
  v_request_fingerprint text;
  v_lane_key text;
  v_approval public.gemini_paid_retry_approvals%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_candidate_id is null or p_expected_candidate_updated_at is null
    or nullif(pg_catalog.btrim(p_reason), '') is null
    or nullif(pg_catalog.btrim(p_actor), '') is null then
    raise exception using
      errcode = '22004',
      message = 'Candidate version, reason, and approving actor are required.';
  end if;

  select candidate.* into v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = p_candidate_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Visual review candidate does not exist.';
  end if;
  if v_candidate.status <> 'failed'
    or v_candidate.updated_at is distinct from p_expected_candidate_updated_at then
    raise exception using
      errcode = '40001',
      message = 'Visual review failure changed before retry approval.';
  end if;
  if pg_catalog.lower(coalesce(v_candidate.rejection_reason, '')) in (
    'missing_batch_response',
    'manual_recovery_required_possible_external_batch_created',
    'manual_recovery_required_equivalent_review_create_started',
    'manual_recovery_required_spend_reservation_state'
  ) then
    raise exception using
      errcode = '23514',
      message = 'This provider state must be recovered or reconciled, not resubmitted.';
  end if;

  v_retry_count := case
    when v_candidate.worker_metadata ->> 'failure_retry_count' ~ '^[0-9]+$'
      then (v_candidate.worker_metadata ->> 'failure_retry_count')::bigint
    else 0
  end;
  v_failure_fingerprint := private.visual_review_paid_retry_failure_fingerprint(
    v_candidate.id,
    v_candidate.updated_at,
    v_candidate.rejection_reason,
    v_candidate.gemini_batch_name,
    v_retry_count
  );
  v_request_fingerprint := private.visual_review_paid_request_fingerprint(
    v_candidate
  );
  v_lane_key := case
    when v_candidate.candidate_scope = 'initial_official_document'
      then 'new_page_review'
    else 'changed_page_review'
  end;

  update public.gemini_paid_retry_approvals approval
  set status = 'revoked'
  where approval.candidate_id = v_candidate.id
    and approval.status = 'approved';

  insert into public.gemini_paid_retry_approvals (
    candidate_id,
    lane_key,
    candidate_updated_at,
    failure_fingerprint,
    approved_request_fingerprint,
    reason,
    approved_by,
    approved_at,
    expires_at
  ) values (
    v_candidate.id,
    v_lane_key,
    v_candidate.updated_at,
    v_failure_fingerprint,
    v_request_fingerprint,
    pg_catalog.btrim(p_reason),
    pg_catalog.btrim(p_actor),
    v_now,
    v_now + interval '24 hours'
  ) returning * into v_approval;

  return v_approval;
end;
$$;

revoke all on function public.approve_visual_review_paid_retry(
  uuid, timestamptz, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.approve_visual_review_paid_retry(
  uuid, timestamptz, text, text
) to service_role;

create or replace function public.consume_visual_review_paid_retry_approval(
  p_candidate_id uuid,
  p_expected_candidate_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_approval public.gemini_paid_retry_approvals%rowtype;
  v_retry_count bigint;
  v_failure_fingerprint text;
  v_request_fingerprint text;
  v_lane_key text;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select candidate.* into v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = p_candidate_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'requeued', false,
      'reason', 'candidate_failure_changed'
    );
  end if;
  if v_candidate.status <> 'failed'
    or v_candidate.updated_at is distinct from p_expected_candidate_updated_at then
    update public.gemini_paid_retry_approvals approval
    set status = 'revoked'
    where approval.candidate_id = p_candidate_id
      and approval.status = 'approved';
    return pg_catalog.jsonb_build_object(
      'requeued', false,
      'reason', 'candidate_failure_changed'
    );
  end if;
  if pg_catalog.lower(coalesce(v_candidate.rejection_reason, '')) in (
    'missing_batch_response',
    'manual_recovery_required_possible_external_batch_created',
    'manual_recovery_required_equivalent_review_create_started',
    'manual_recovery_required_spend_reservation_state'
  ) then
    return pg_catalog.jsonb_build_object(
      'requeued', false,
      'reason', 'provider_state_requires_recovery'
    );
  end if;

  v_retry_count := case
    when v_candidate.worker_metadata ->> 'failure_retry_count' ~ '^[0-9]+$'
      then (v_candidate.worker_metadata ->> 'failure_retry_count')::bigint
    else 0
  end;
  v_failure_fingerprint := private.visual_review_paid_retry_failure_fingerprint(
    v_candidate.id,
    v_candidate.updated_at,
    v_candidate.rejection_reason,
    v_candidate.gemini_batch_name,
    v_retry_count
  );
  v_request_fingerprint := private.visual_review_paid_request_fingerprint(
    v_candidate
  );
  v_lane_key := case
    when v_candidate.candidate_scope = 'initial_official_document'
      then 'new_page_review'
    else 'changed_page_review'
  end;

  select approval.* into v_approval
  from public.gemini_paid_retry_approvals approval
  where approval.candidate_id = v_candidate.id
    and approval.status = 'approved'
    and approval.expires_at > v_now
    and approval.candidate_updated_at = v_candidate.updated_at
    and approval.failure_fingerprint = v_failure_fingerprint
    and approval.approved_request_fingerprint = v_request_fingerprint
    and approval.lane_key = v_lane_key
  order by approval.approved_at desc, approval.id desc
  limit 1
  for update;

  if not found then
    update public.gemini_paid_retry_approvals approval
    set status = 'expired'
    where approval.candidate_id = v_candidate.id
      and approval.status = 'approved'
      and approval.expires_at <= v_now;
    return pg_catalog.jsonb_build_object(
      'requeued', false,
      'reason', 'paid_retry_approval_required',
      'failure_fingerprint', v_failure_fingerprint
    );
  end if;

  -- The transition trigger below accepts failed -> pending only from this
  -- exact approval-consuming transaction.
  perform pg_catalog.set_config(
    'awardping.paid_retry_approval_id',
    v_approval.id::text,
    true
  );

  update public.shared_award_visual_review_candidates candidate
  set
    status = 'pending',
    gemini_batch_name = null,
    model = null,
    submitted_at = null,
    completed_at = null,
    published_at = null,
    ai_result = null,
    actual_usage = '{}'::jsonb,
    rejection_reason = null,
    worker_metadata = coalesce(candidate.worker_metadata, '{}'::jsonb) ||
      pg_catalog.jsonb_build_object(
        'failure_retry_count', v_retry_count + 1,
        'failure_requeued_at', v_now,
        'paid_retry_approval_id', v_approval.id,
        'paid_retry_approved_by', v_approval.approved_by,
        'paid_retry_approval_reason', v_approval.reason,
        'paid_retry_approved_request_fingerprint', v_request_fingerprint,
        'paid_retry_approved_candidate_signature', v_candidate.candidate_signature,
        'paid_retry_approved_batch_request_key', v_candidate.gemini_batch_request_key,
        'paid_retry_approved_lane_key', v_approval.lane_key,
        'paid_retry_approval_expires_at', v_approval.expires_at,
        'submission_claim_token', null
      ),
    updated_at = v_now
  where candidate.id = v_candidate.id
    and candidate.status = 'failed'
    and candidate.updated_at = p_expected_candidate_updated_at;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'Visual review failure changed while consuming retry approval.';
  end if;

  update public.gemini_paid_retry_approvals approval
  set
    status = 'consumed',
    consumed_at = v_now,
    consumed_candidate_updated_at = v_now
  where approval.id = v_approval.id
    and approval.status = 'approved';

  if not found then
    raise exception using
      errcode = '40001',
      message = 'Paid retry approval was already consumed.';
  end if;

  return pg_catalog.jsonb_build_object(
    'requeued', true,
    'reason', 'operator_approved_paid_retry',
    'approval_id', v_approval.id,
    'lane_key', v_approval.lane_key,
    'next_retry_count', v_retry_count + 1,
    'candidate_updated_at', v_now
  );
end;
$$;

revoke all on function public.consume_visual_review_paid_retry_approval(
  uuid, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.consume_visual_review_paid_retry_approval(
  uuid, timestamptz
) to service_role;

-- A consumed retry remains charge-authorized only for the exact request, exact
-- lane, exact processing claim, and original approval lifetime. The worker
-- calls this both before reserving spend and immediately before provider create.
create or replace function public.authorize_visual_review_paid_retry_submission(
  p_candidate_id uuid,
  p_submission_claim_token uuid,
  p_expected_request_fingerprint text,
  p_expected_provider_request_fingerprint text,
  p_expected_lane_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_approval public.gemini_paid_retry_approvals%rowtype;
  v_approval_id_text text;
  v_lane_key text;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_candidate_id is null
    or p_submission_claim_token is null
    or p_expected_request_fingerprint is null
    or p_expected_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_expected_provider_request_fingerprint is null
    or p_expected_provider_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_expected_lane_key is null
    or p_expected_lane_key not in ('new_page_review', 'changed_page_review') then
    return pg_catalog.jsonb_build_object(
      'authorized', false,
      'reason', 'invalid_authorization_request'
    );
  end if;

  select candidate.* into v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = p_candidate_id
  for update;
  if not found
    or v_candidate.status <> 'processing'
    or v_candidate.gemini_batch_name is not null
    or v_candidate.worker_metadata ->> 'submission_claim_token'
      is distinct from p_submission_claim_token::text then
    return pg_catalog.jsonb_build_object(
      'authorized', false,
      'reason', 'submission_claim_changed'
    );
  end if;

  v_lane_key := case
    when v_candidate.candidate_scope = 'initial_official_document'
      then 'new_page_review'
    else 'changed_page_review'
  end;
  if v_lane_key is distinct from p_expected_lane_key
    or v_candidate.worker_metadata ->> 'paid_retry_approved_lane_key'
      is distinct from p_expected_lane_key then
    return pg_catalog.jsonb_build_object(
      'authorized', false,
      'reason', 'paid_retry_lane_mismatch'
    );
  end if;

  v_approval_id_text := nullif(
    v_candidate.worker_metadata ->> 'paid_retry_approval_id',
    ''
  );
  if v_approval_id_text is null
    or v_approval_id_text !~ '^[0-9a-fA-F-]{36}$' then
    return pg_catalog.jsonb_build_object(
      'authorized', false,
      'reason', 'paid_retry_approval_missing'
    );
  end if;

  select approval.* into v_approval
  from public.gemini_paid_retry_approvals approval
  where approval.id = v_approval_id_text::uuid
  for update;
  if not found
    or v_approval.status <> 'consumed'
    or v_approval.candidate_id is distinct from v_candidate.id
    or v_approval.lane_key is distinct from p_expected_lane_key
    or v_approval.approved_request_fingerprint
      is distinct from p_expected_request_fingerprint then
    return pg_catalog.jsonb_build_object(
      'authorized', false,
      'reason', 'paid_retry_approval_binding_changed'
    );
  end if;
  if v_approval.expires_at <= v_now then
    return pg_catalog.jsonb_build_object(
      'authorized', false,
      'reason', 'paid_retry_approval_expired'
    );
  end if;

  if v_candidate.worker_metadata ->> 'paid_retry_approved_request_fingerprint'
      is distinct from p_expected_request_fingerprint
    or v_candidate.worker_metadata ->> 'paid_retry_approved_candidate_signature'
      is distinct from v_candidate.candidate_signature
    or v_candidate.worker_metadata ->> 'paid_retry_approved_batch_request_key'
      is distinct from v_candidate.gemini_batch_request_key
    or private.visual_review_paid_request_fingerprint(v_candidate)
      is distinct from p_expected_request_fingerprint then
    return pg_catalog.jsonb_build_object(
      'authorized', false,
      'reason', 'paid_retry_approval_request_drift'
    );
  end if;

  if v_approval.authorized_provider_request_fingerprint is null then
    update public.gemini_paid_retry_approvals approval
    set
      authorized_provider_request_fingerprint =
        p_expected_provider_request_fingerprint,
      provider_request_bound_at = v_now
    where approval.id = v_approval.id
      and approval.status = 'consumed'
      and approval.authorized_provider_request_fingerprint is null;
    if not found then
      return pg_catalog.jsonb_build_object(
        'authorized', false,
        'reason', 'paid_retry_provider_request_binding_raced'
      );
    end if;
    v_approval.authorized_provider_request_fingerprint :=
      p_expected_provider_request_fingerprint;
    v_approval.provider_request_bound_at := v_now;
  elsif v_approval.authorized_provider_request_fingerprint
    is distinct from p_expected_provider_request_fingerprint then
    return pg_catalog.jsonb_build_object(
      'authorized', false,
      'reason', 'paid_retry_provider_request_drift'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'authorized', true,
    'reason', 'exact_paid_retry_authorized',
    'approval_id', v_approval.id,
    'lane_key', v_approval.lane_key,
    'provider_request_fingerprint',
      v_approval.authorized_provider_request_fingerprint,
    'expires_at', v_approval.expires_at
  );
end;
$$;

revoke all on function public.authorize_visual_review_paid_retry_submission(
  uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.authorize_visual_review_paid_retry_submission(
  uuid, uuid, text, text, text
) to service_role;

-- If policy or source context changes after an approval is consumed, refresh
-- the request while it is still pending and then fail it in the same
-- transaction. No session can observe the refreshed row as submit-ready; the
-- current request needs a new operator approval.
create or replace function public.invalidate_visual_review_paid_retry_for_request_drift(
  p_candidate_id uuid,
  p_expected_request_fingerprint text,
  p_expected_lane_key text,
  p_candidate_signature text,
  p_gemini_batch_request_key text,
  p_source_url text,
  p_source_title text,
  p_source_page_type text,
  p_prompt_payload jsonb,
  p_prompt_context text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_refreshed public.shared_award_visual_review_candidates%rowtype;
  v_approval public.gemini_paid_retry_approvals%rowtype;
  v_conflict public.shared_award_visual_review_candidates%rowtype;
  v_approval_id_text text;
  v_lane_key text;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_candidate_id is null
    or p_expected_request_fingerprint is null
    or p_expected_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_expected_lane_key is null
    or p_expected_lane_key not in ('new_page_review', 'changed_page_review')
    or p_candidate_signature !~ '^[0-9a-f]{64}$'
    or p_gemini_batch_request_key is distinct from p_candidate_signature
    or nullif(pg_catalog.btrim(p_source_url), '') is null
    or pg_catalog.jsonb_typeof(p_prompt_payload) <> 'object' then
    return pg_catalog.jsonb_build_object(
      'invalidated', false,
      'reason', 'invalid_request_refresh'
    );
  end if;

  select candidate.* into v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = p_candidate_id
  for update;
  if not found
    or v_candidate.status <> 'pending'
    or v_candidate.gemini_batch_name is not null then
    return pg_catalog.jsonb_build_object(
      'invalidated', false,
      'reason', 'candidate_not_pending'
    );
  end if;

  v_lane_key := case
    when v_candidate.candidate_scope = 'initial_official_document'
      then 'new_page_review'
    else 'changed_page_review'
  end;
  v_approval_id_text := nullif(
    v_candidate.worker_metadata ->> 'paid_retry_approval_id',
    ''
  );
  if v_lane_key is distinct from p_expected_lane_key
    or v_candidate.worker_metadata ->> 'paid_retry_approved_request_fingerprint'
      is distinct from p_expected_request_fingerprint
    or v_approval_id_text is null
    or v_approval_id_text !~ '^[0-9a-fA-F-]{36}$'
    or private.visual_review_paid_request_fingerprint(v_candidate)
      is distinct from p_expected_request_fingerprint then
    return pg_catalog.jsonb_build_object(
      'invalidated', false,
      'reason', 'consumed_approval_binding_changed'
    );
  end if;

  select approval.* into v_approval
  from public.gemini_paid_retry_approvals approval
  where approval.id = v_approval_id_text::uuid
  for key share;
  if not found
    or v_approval.status <> 'consumed'
    or v_approval.candidate_id is distinct from v_candidate.id
    or v_approval.lane_key is distinct from p_expected_lane_key
    or v_approval.approved_request_fingerprint
      is distinct from p_expected_request_fingerprint then
    return pg_catalog.jsonb_build_object(
      'invalidated', false,
      'reason', 'consumed_approval_not_exact'
    );
  end if;

  select other.* into v_conflict
  from public.shared_award_visual_review_candidates other
  where other.candidate_signature = p_candidate_signature
    and other.id <> v_candidate.id
  limit 1
  for key share;
  if found then
    update public.shared_award_visual_review_candidates candidate
    set
      status = 'superseded',
      rejection_reason = 'current_policy_candidate_exists:' || v_conflict.id::text,
      completed_at = v_now,
      worker_metadata = (
        candidate.worker_metadata
          - 'paid_retry_approval_id'
          - 'paid_retry_approved_request_fingerprint'
          - 'paid_retry_approved_candidate_signature'
          - 'paid_retry_approved_batch_request_key'
          - 'paid_retry_approved_lane_key'
          - 'paid_retry_approval_expires_at'
      ) || pg_catalog.jsonb_build_object(
        'paid_retry_invalidated_approval_id', v_approval.id,
        'paid_retry_request_drift_detected_at', v_now,
        'superseded_by_candidate_id', v_conflict.id
      ),
      updated_at = v_now
    where candidate.id = v_candidate.id;
    return pg_catalog.jsonb_build_object(
      'invalidated', true,
      'reason', 'current_policy_candidate_exists',
      'superseded', true,
      'conflict_candidate_id', v_conflict.id
    );
  end if;

  begin
    update public.shared_award_visual_review_candidates candidate
    set
      candidate_signature = p_candidate_signature,
      gemini_batch_request_key = p_gemini_batch_request_key,
      source_url = pg_catalog.btrim(p_source_url),
      source_title = p_source_title,
      source_page_type = p_source_page_type,
      prompt_payload = p_prompt_payload,
      prompt_context = p_prompt_context,
      worker_metadata = (
        candidate.worker_metadata
          - 'paid_retry_approval_id'
          - 'paid_retry_approved_request_fingerprint'
          - 'paid_retry_approved_candidate_signature'
          - 'paid_retry_approved_batch_request_key'
          - 'paid_retry_approved_lane_key'
          - 'paid_retry_approval_expires_at'
      ) || pg_catalog.jsonb_build_object(
        'paid_retry_invalidated_approval_id', v_approval.id,
        'paid_retry_request_drift_detected_at', v_now,
        'paid_retry_previous_request_fingerprint', p_expected_request_fingerprint
      ),
      updated_at = v_now
    where candidate.id = v_candidate.id
      and candidate.status = 'pending'
    returning candidate.* into v_refreshed;
  exception when unique_violation then
    select other.* into v_conflict
    from public.shared_award_visual_review_candidates other
    where other.candidate_signature = p_candidate_signature
      and other.id <> v_candidate.id
    limit 1;
    update public.shared_award_visual_review_candidates candidate
    set
      status = 'superseded',
      rejection_reason = 'current_policy_candidate_exists:' || v_conflict.id::text,
      completed_at = v_now,
      worker_metadata = candidate.worker_metadata || pg_catalog.jsonb_build_object(
        'paid_retry_invalidated_approval_id', v_approval.id,
        'paid_retry_request_drift_detected_at', v_now,
        'superseded_by_candidate_id', v_conflict.id
      ),
      updated_at = v_now
    where candidate.id = v_candidate.id;
    return pg_catalog.jsonb_build_object(
      'invalidated', true,
      'reason', 'current_policy_candidate_exists',
      'superseded', true,
      'conflict_candidate_id', v_conflict.id
    );
  end;

  update public.shared_award_visual_review_candidates candidate
  set
    status = 'failed',
    rejection_reason = 'paid_retry_approval_request_drift',
    completed_at = v_now,
    updated_at = v_now
  where candidate.id = v_candidate.id
    and candidate.status = 'pending';

  return pg_catalog.jsonb_build_object(
    'invalidated', true,
    'reason', 'fresh_approval_required_for_current_request',
    'superseded', false,
    'request_fingerprint', private.visual_review_paid_request_fingerprint(v_refreshed)
  );
end;
$$;

revoke all on function public.invalidate_visual_review_paid_retry_for_request_drift(
  uuid, text, text, text, text, text, text, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.invalidate_visual_review_paid_retry_for_request_drift(
  uuid, text, text, text, text, text, text, text, jsonb, text
) to service_role;

create or replace function private.enforce_visual_review_paid_retry_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'failed' and new.status = 'pending' and (
    nullif(new.worker_metadata ->> 'paid_retry_approval_id', '') is null
    or pg_catalog.current_setting(
      'awardping.paid_retry_approval_id',
      true
    ) is distinct from new.worker_metadata ->> 'paid_retry_approval_id'
  ) then
    raise exception using
      errcode = '42501',
      message = 'A failed paid visual review can return to pending only through exact approval consumption.';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_visual_review_paid_retry_transition()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_visual_review_paid_retry_transition_trigger
  on public.shared_award_visual_review_candidates;
create trigger enforce_visual_review_paid_retry_transition_trigger
before update of status on public.shared_award_visual_review_candidates
for each row execute function private.enforce_visual_review_paid_retry_transition();

-- Fail closed any automatic retry that was already pending when this policy is
-- installed. It can be reviewed and approved normally from its current exact
-- request, but it cannot inherit the retired counter-only retry behavior.
update public.shared_award_visual_review_candidates candidate
set
  status = 'failed',
  rejection_reason = 'paid_retry_approval_required',
  completed_at = pg_catalog.clock_timestamp(),
  updated_at = pg_catalog.clock_timestamp()
where candidate.status = 'pending'
  and coalesce(
    case
      when candidate.worker_metadata ->> 'failure_retry_count' ~ '^[0-9]+$'
        then (candidate.worker_metadata ->> 'failure_retry_count')::integer
    end,
    0
  ) > 0
  and nullif(candidate.worker_metadata ->> 'paid_retry_approval_id', '') is null;

-- Keep the durable quarantine and lane status aligned with the one-use
-- approval policy. These functions predate this migration and are large; the
-- guarded definition rewrites fail the migration if their reviewed source
-- shape ever drifts instead of silently leaving the old auto-retry semantics.
do $$
declare
  v_function pg_catalog.regprocedure;
  v_definition text;
  v_rewritten text;
  v_manual_predicate_count integer;
begin
  v_function := pg_catalog.to_regprocedure(
    'public.sync_manual_quarantine_registry()'
  );
  if v_function is null then
    raise exception 'sync_manual_quarantine_registry() must exist before paid retry approval';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(v_function);
  if pg_catalog.regexp_count(v_definition, '\) >= 3 then true') <> 2 then
    raise exception 'visual terminal retry-count predicates drifted before paid retry approval';
  end if;
  v_rewritten := pg_catalog.replace(
    v_definition,
    ') >= 3 then true',
    ') >= 0 then true'
  );
  if pg_catalog.strpos(v_rewritten, 'else ''retry_limit_reached''') = 0 then
    raise exception 'visual retry-mode clause drifted before paid retry approval';
  end if;
  v_rewritten := pg_catalog.replace(
    v_rewritten,
    'else ''retry_limit_reached''',
    'else ''paid_retry_approval_required'''
  );
  v_manual_predicate_count := pg_catalog.regexp_count(
    v_rewritten,
    $pattern$lower\(btrim\(coalesce\(visual\.rejection_reason, ''\)\)\)\s*=\s*'manual_recovery_required_possible_external_batch_created'$pattern$
  );
  if v_manual_predicate_count < 1 then
    raise exception 'visual manual-recovery predicates drifted before paid retry approval';
  end if;
  v_rewritten := pg_catalog.regexp_replace(
    v_rewritten,
    $pattern$lower\(btrim\(coalesce\(visual\.rejection_reason, ''\)\)\)\s*=\s*'manual_recovery_required_possible_external_batch_created'$pattern$,
    $replacement$lower(btrim(coalesce(visual.rejection_reason, ''))) like 'manual_recovery_required_%'$replacement$,
    'g'
  );
  execute v_rewritten;
end;
$$;

do $$
declare
  v_function pg_catalog.regprocedure;
  v_definition text;
  v_old_source text := $old$  source_queue as (
    select
      count(*)::bigint as queue_depth,
      min(request.created_at) as oldest_item_at
    from public.source_page_requests request
    where request.status in (
      'pending',
      'queued',
      'validating',
      'capturing',
      'ai_review_pending',
      'ai_review_submitted',
      'ai_review_succeeded',
      'matching'
    )
  ),$old$;
  v_new_source text := $new$  source_queue as (
    select
      count(*)::bigint as queue_depth,
      min(item.created_at) as oldest_item_at
    from (
      select request.created_at
      from public.source_page_requests request
      where request.status in (
        'pending',
        'queued',
        'validating',
        'capturing',
        'ai_review_pending',
        'ai_review_submitted',
        'ai_review_succeeded',
        'matching'
      )
      union all
      select candidate.created_at
      from public.shared_award_visual_review_candidates candidate
      where candidate.candidate_scope = 'initial_official_document'
        and (
          candidate.status in ('pending', 'submitted', 'processing', 'succeeded')
          or (
            candidate.status = 'failed'
            and lower(pg_catalog.btrim(coalesce(candidate.rejection_reason, ''))) =
              'missing_batch_response'
          )
        )
    ) item
  ),$new$;
  v_old text := $old$    where candidate.status in ('pending', 'submitted', 'processing', 'succeeded')
      or (
        candidate.status = 'failed'
        and (
          lower(pg_catalog.btrim(coalesce(candidate.rejection_reason, ''))) =
            'missing_batch_response'
          or (
            lower(pg_catalog.btrim(coalesce(candidate.rejection_reason, ''))) <>
              'manual_recovery_required_possible_external_batch_created'
            and coalesce(
              case
                when candidate.worker_metadata ->> 'failure_retry_count' ~ '^[0-9]+$'
                  then (candidate.worker_metadata ->> 'failure_retry_count')::integer
              end,
              0
            ) < 3
          )
        )
      )$old$;
  v_new text := $new$    where candidate.candidate_scope <> 'initial_official_document'
      and (
        candidate.status in ('pending', 'submitted', 'processing', 'succeeded')
        or (
          candidate.status = 'failed'
          and lower(pg_catalog.btrim(coalesce(candidate.rejection_reason, ''))) =
            'missing_batch_response'
        )
      )$new$;
begin
  v_function := pg_catalog.to_regprocedure(
    'public.list_monitoring_downstream_lane_status()'
  );
  if v_function is null then
    raise exception 'list_monitoring_downstream_lane_status() must exist before paid retry approval';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(v_function);
  if pg_catalog.strpos(v_definition, v_old_source) = 0 then
    raise exception 'new-page lane source backlog clause drifted before paid retry approval';
  end if;
  v_definition := pg_catalog.replace(
    v_definition,
    v_old_source,
    v_new_source
  );
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'changed-page lane failed-candidate backlog clause drifted before paid retry approval';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$$;

select public.sync_manual_quarantine_registry();

comment on table public.gemini_paid_retry_approvals is
  'One-use, exact-failure operator approvals. No paid new-page or changed-page review retry can be resubmitted without one.';
