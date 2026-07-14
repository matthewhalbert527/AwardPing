alter table public.monitoring_feedback
  add column if not exists event_summary text,
  add column if not exists event_source_url text,
  add column if not exists event_source_title text,
  add column if not exists event_source_page_type text,
  add column if not exists event_detected_at timestamptz,
  add column if not exists event_evidence jsonb not null default '{}'::jsonb;

comment on column public.monitoring_feedback.event_evidence is
  'Immutable compact evidence captured from the locked change event when the feedback is recorded.';

create index if not exists monitoring_feedback_pending_created_idx
  on public.monitoring_feedback (created_at desc, id desc)
  where promotion_status = 'pending_review';

create or replace function public.list_pending_monitoring_feedback(
  p_limit integer default 100
)
returns table (
  feedback_id uuid,
  event_id uuid,
  source_id uuid,
  award_id uuid,
  event_summary text,
  event_source_url text,
  event_source_title text,
  event_source_page_type text,
  event_detected_at timestamptz,
  event_evidence jsonb,
  reason_code text,
  note text,
  requested_scope text,
  policy_rule_id text,
  policy_version text,
  actor_email text,
  created_at timestamptz,
  total_pending bigint
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with pending as (
    select
      feedback.id as feedback_id,
      feedback.event_id,
      feedback.source_id,
      feedback.award_id,
      feedback.event_summary,
      feedback.event_source_url,
      feedback.event_source_title,
      feedback.event_source_page_type,
      feedback.event_detected_at,
      feedback.event_evidence,
      feedback.reason_code,
      feedback.note,
      feedback.requested_scope,
      feedback.policy_rule_id,
      feedback.policy_version,
      feedback.actor_email,
      feedback.created_at
    from public.monitoring_feedback feedback
    where feedback.promotion_status = 'pending_review'
      and not exists (
        select 1
        from public.monitoring_feedback_promotions promotion
        where promotion.feedback_id = feedback.id
      )
  )
  select
    pending.feedback_id,
    pending.event_id,
    pending.source_id,
    pending.award_id,
    pending.event_summary,
    pending.event_source_url,
    pending.event_source_title,
    pending.event_source_page_type,
    pending.event_detected_at,
    pending.event_evidence,
    pending.reason_code,
    pending.note,
    pending.requested_scope,
    pending.policy_rule_id,
    pending.policy_version,
    pending.actor_email,
    pending.created_at,
    count(*) over () as total_pending
  from pending
  order by pending.created_at desc, pending.feedback_id desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$function$;

revoke execute on function public.list_pending_monitoring_feedback(integer)
  from public, anon, authenticated;
grant execute on function public.list_pending_monitoring_feedback(integer)
  to service_role;

drop function public.record_monitoring_false_positive(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  text,
  text,
  text
);

create function public.record_monitoring_false_positive(
  p_request_id uuid,
  p_event_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_reason_code text,
  p_policy_identity text,
  p_policy_version text,
  p_policy_hash text,
  p_policy_config_version integer,
  p_decision_memory_version integer,
  p_note text default null,
  p_requested_scope text default 'event',
  p_policy_rule_id text default null
)
returns table (
  feedback_id uuid,
  suppressed_event_id uuid,
  award_id uuid,
  source_id uuid,
  suppressed_at timestamptz,
  promotion_status text,
  recorded_reason_code text,
  recorded_note text,
  recorded_requested_scope text,
  recorded_policy_rule_id text,
  recorded_event_summary text,
  recorded_event_source_url text,
  recorded_event_source_title text,
  recorded_event_source_page_type text,
  recorded_event_detected_at timestamptz,
  recorded_event_evidence jsonb
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_existing public.monitoring_feedback%rowtype;
  v_award_id uuid;
  v_source_id uuid;
  v_suppressed_at timestamptz;
  v_event_summary text;
  v_event_source_url text;
  v_event_source_title text;
  v_event_source_page_type text;
  v_event_detected_at timestamptz;
  v_event_evidence jsonb := '{}'::jsonb;
  v_feedback_id uuid;
  v_now timestamptz := now();
  v_actor_email text := lower(btrim(coalesce(p_actor_email, '')));
  v_reason_code text := lower(btrim(coalesce(p_reason_code, '')));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_requested_scope text := lower(btrim(coalesce(p_requested_scope, '')));
  v_policy_rule_id text := nullif(btrim(coalesce(p_policy_rule_id, '')), '');
  v_policy_identity text := btrim(coalesce(p_policy_identity, ''));
  v_policy_version text := btrim(coalesce(p_policy_version, ''));
  v_policy_hash text := btrim(coalesce(p_policy_hash, ''));
  v_promotion_status text;
begin
  if p_request_id is null or p_event_id is null or p_actor_user_id is null then
    raise exception 'request, event, and actor IDs are required'
      using errcode = '22004';
  end if;

  if char_length(v_actor_email) < 3 or char_length(v_actor_email) > 320 then
    raise exception 'a valid actor email is required'
      using errcode = '22023';
  end if;

  if v_policy_identity = '' or v_policy_version = '' or v_policy_hash = '' then
    raise exception 'monitoring policy identity, version, and hash are required'
      using errcode = '22023';
  end if;

  if char_length(coalesce(v_policy_rule_id, '')) > 160 then
    raise exception 'monitoring policy rule ID is too long'
      using errcode = '22023';
  end if;

  if v_reason_code not in (
    'capture_noise',
    'content_churn',
    'duplicate_update',
    'out_of_scope',
    'not_applicant_facing',
    'other'
  ) then
    raise exception 'invalid monitoring feedback reason'
      using errcode = '22023';
  end if;

  if v_requested_scope not in ('event', 'source', 'award', 'global') then
    raise exception 'invalid monitoring feedback scope'
      using errcode = '22023';
  end if;

  if char_length(coalesce(v_note, '')) > 1000 then
    raise exception 'monitoring feedback note is too long'
      using errcode = '22023';
  end if;

  if (v_reason_code = 'other' or v_requested_scope <> 'event') and v_note is null then
    raise exception 'a note is required for this reason or scope'
      using errcode = '22023';
  end if;

  v_promotion_status := case
    when v_policy_rule_id is not null then 'already_active'
    else 'pending_review'
  end;

  select feedback.*
  into v_existing
  from public.monitoring_feedback feedback
  where feedback.request_id = p_request_id;

  if found then
    if v_existing.event_id is distinct from p_event_id
      or v_existing.actor_user_id is distinct from p_actor_user_id
      or v_existing.actor_email is distinct from v_actor_email
      or v_existing.reason_code is distinct from v_reason_code
      or v_existing.note is distinct from v_note
      or v_existing.requested_scope is distinct from v_requested_scope
      or v_existing.policy_rule_id is distinct from v_policy_rule_id
      or v_existing.policy_identity is distinct from v_policy_identity
      or v_existing.policy_version is distinct from v_policy_version
      or v_existing.policy_hash is distinct from v_policy_hash
      or v_existing.policy_config_version is distinct from p_policy_config_version
      or v_existing.decision_memory_version is distinct from p_decision_memory_version
      or v_existing.promotion_status is distinct from v_promotion_status then
      raise exception 'request ID was already used for different feedback'
        using errcode = '22023';
    end if;

    return query
      select
        v_existing.id,
        v_existing.event_id,
        v_existing.award_id,
        v_existing.source_id,
        v_existing.suppression_applied_at,
        v_existing.promotion_status,
        v_existing.reason_code,
        v_existing.note,
        v_existing.requested_scope,
        v_existing.policy_rule_id,
        v_existing.event_summary,
        v_existing.event_source_url,
        v_existing.event_source_title,
        v_existing.event_source_page_type,
        v_existing.event_detected_at,
        v_existing.event_evidence;
    return;
  end if;

  select
    change_event.shared_award_id,
    change_event.shared_award_source_id,
    change_event.suppressed_at,
    change_event.summary,
    change_event.source_url,
    change_event.source_title,
    change_event.source_page_type,
    change_event.detected_at,
    jsonb_strip_nulls(
      jsonb_build_object(
        'reader_summary', change_event.change_details -> 'reader_summary',
        'before', change_event.change_details -> 'before',
        'after', change_event.change_details -> 'after',
        'exact_before', change_event.change_details -> 'exact_before',
        'exact_after', change_event.change_details -> 'exact_after',
        'section', change_event.change_details -> 'section',
        'change_type', change_event.change_details -> 'change_type',
        'advisor_impact', change_event.change_details -> 'advisor_impact',
        'source_relevance', change_event.change_details -> 'source_relevance',
        'source_relevance_reason', change_event.change_details -> 'source_relevance_reason',
        'changed_facts', change_event.change_details -> 'changed_facts',
        'evidence_location', change_event.change_details -> 'evidence_location',
        'is_alert_worthy', change_event.change_details -> 'is_alert_worthy',
        'confidence', change_event.change_details -> 'confidence',
        'structured_diff', change_event.change_details -> 'structured_diff',
        'quality_flags', change_event.change_details -> 'quality_flags',
        'generation_provider', change_event.change_details -> 'generation_provider',
        'generation_status', change_event.change_details -> 'generation_status',
        'monitoring_policy', change_event.change_details -> 'monitoring_policy',
        'monitoring_policy_bundle', change_event.change_details -> 'monitoring_policy_bundle',
        'snapshot', jsonb_strip_nulls(
          jsonb_build_object(
            'previous_id', change_event.previous_snapshot_id,
            'new_id', change_event.new_snapshot_id,
            'previous_hash', change_event.previous_hash,
            'new_hash', change_event.new_hash
          )
        )
      )
    )
  into
    v_award_id,
    v_source_id,
    v_suppressed_at,
    v_event_summary,
    v_event_source_url,
    v_event_source_title,
    v_event_source_page_type,
    v_event_detected_at,
    v_event_evidence
  from public.shared_award_change_events change_event
  where change_event.id = p_event_id
  for update;

  if not found then
    raise exception 'monitoring event was not found'
      using errcode = 'P0002';
  end if;

  if v_suppressed_at is null then
    update public.shared_award_change_events
    set
      suppressed_at = v_now,
      suppression_reason = 'admin_feedback:' || v_reason_code,
      suppression_source = 'admin_feedback'
    where id = p_event_id;
    v_suppressed_at := v_now;
  end if;

  begin
    insert into public.monitoring_feedback (
      request_id,
      actor_user_id,
      actor_email,
      event_id,
      source_id,
      award_id,
      reason_code,
      note,
      requested_scope,
      policy_rule_id,
      policy_identity,
      policy_version,
      policy_hash,
      policy_config_version,
      decision_memory_version,
      promotion_status,
      suppression_applied_at,
      event_summary,
      event_source_url,
      event_source_title,
      event_source_page_type,
      event_detected_at,
      event_evidence
    ) values (
      p_request_id,
      p_actor_user_id,
      v_actor_email,
      p_event_id,
      v_source_id,
      v_award_id,
      v_reason_code,
      v_note,
      v_requested_scope,
      v_policy_rule_id,
      v_policy_identity,
      v_policy_version,
      v_policy_hash,
      p_policy_config_version,
      p_decision_memory_version,
      v_promotion_status,
      v_suppressed_at,
      v_event_summary,
      v_event_source_url,
      v_event_source_title,
      v_event_source_page_type,
      v_event_detected_at,
      v_event_evidence
    )
    returning id into v_feedback_id;
  exception
    when unique_violation then
      select feedback.*
      into v_existing
      from public.monitoring_feedback feedback
      where feedback.request_id = p_request_id;

      if not found then
        raise;
      end if;

      if v_existing.event_id is distinct from p_event_id
        or v_existing.actor_user_id is distinct from p_actor_user_id
        or v_existing.actor_email is distinct from v_actor_email
        or v_existing.reason_code is distinct from v_reason_code
        or v_existing.note is distinct from v_note
        or v_existing.requested_scope is distinct from v_requested_scope
        or v_existing.policy_rule_id is distinct from v_policy_rule_id
        or v_existing.policy_identity is distinct from v_policy_identity
        or v_existing.policy_version is distinct from v_policy_version
        or v_existing.policy_hash is distinct from v_policy_hash
        or v_existing.policy_config_version is distinct from p_policy_config_version
        or v_existing.decision_memory_version is distinct from p_decision_memory_version
        or v_existing.promotion_status is distinct from v_promotion_status then
        raise exception 'request ID was already used for different feedback'
          using errcode = '22023';
      end if;

      return query
        select
          v_existing.id,
          v_existing.event_id,
          v_existing.award_id,
          v_existing.source_id,
          v_existing.suppression_applied_at,
          v_existing.promotion_status,
          v_existing.reason_code,
          v_existing.note,
          v_existing.requested_scope,
          v_existing.policy_rule_id,
          v_existing.event_summary,
          v_existing.event_source_url,
          v_existing.event_source_title,
          v_existing.event_source_page_type,
          v_existing.event_detected_at,
          v_existing.event_evidence;
      return;
  end;

  return query
    select
      v_feedback_id,
      p_event_id,
      v_award_id,
      v_source_id,
      v_suppressed_at,
      v_promotion_status,
      v_reason_code,
      v_note,
      v_requested_scope,
      v_policy_rule_id,
      v_event_summary,
      v_event_source_url,
      v_event_source_title,
      v_event_source_page_type,
      v_event_detected_at,
      v_event_evidence;
end;
$function$;

revoke execute on function public.record_monitoring_false_positive(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  text,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.record_monitoring_false_positive(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  text,
  text,
  text
) to service_role;

create or replace function public.record_monitoring_feedback_promotion(
  p_request_id uuid,
  p_feedback_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_policy_rule_id text,
  p_policy_identity text,
  p_policy_version text,
  p_policy_hash text,
  p_policy_config_version integer,
  p_decision_memory_version integer,
  p_note text default null
)
returns table (
  promotion_id uuid,
  promoted_feedback_id uuid,
  active_policy_rule_id text,
  promoted_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_existing public.monitoring_feedback_promotions%rowtype;
  v_feedback_status text;
  v_promotion_id uuid;
  v_now timestamptz := now();
  v_actor_email text := lower(btrim(coalesce(p_actor_email, '')));
  v_policy_rule_id text := nullif(btrim(coalesce(p_policy_rule_id, '')), '');
  v_policy_identity text := btrim(coalesce(p_policy_identity, ''));
  v_policy_version text := btrim(coalesce(p_policy_version, ''));
  v_policy_hash text := btrim(coalesce(p_policy_hash, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_request_id is null or p_feedback_id is null or p_actor_user_id is null then
    raise exception 'request, feedback, and actor IDs are required'
      using errcode = '22004';
  end if;

  if char_length(v_actor_email) < 3 or char_length(v_actor_email) > 320 then
    raise exception 'a valid actor email is required'
      using errcode = '22023';
  end if;

  if v_policy_rule_id is null or char_length(v_policy_rule_id) > 160 then
    raise exception 'an active policy rule ID is required'
      using errcode = '22023';
  end if;

  if v_policy_identity = '' or v_policy_version = '' or v_policy_hash = '' then
    raise exception 'monitoring policy identity, version, and hash are required'
      using errcode = '22023';
  end if;

  if char_length(coalesce(v_note, '')) > 1000 then
    raise exception 'monitoring feedback promotion note is too long'
      using errcode = '22023';
  end if;

  select promotion.*
  into v_existing
  from public.monitoring_feedback_promotions promotion
  where promotion.request_id = p_request_id;

  if found then
    if v_existing.feedback_id is distinct from p_feedback_id
      or v_existing.actor_user_id is distinct from p_actor_user_id
      or v_existing.actor_email is distinct from v_actor_email
      or v_existing.policy_rule_id is distinct from v_policy_rule_id
      or v_existing.policy_identity is distinct from v_policy_identity
      or v_existing.policy_version is distinct from v_policy_version
      or v_existing.policy_hash is distinct from v_policy_hash
      or v_existing.policy_config_version is distinct from p_policy_config_version
      or v_existing.decision_memory_version is distinct from p_decision_memory_version
      or v_existing.note is distinct from v_note then
      raise exception 'request ID was already used for a different promotion'
        using errcode = '22023';
    end if;

    return query
      select
        v_existing.id,
        v_existing.feedback_id,
        v_existing.policy_rule_id,
        v_existing.created_at;
    return;
  end if;

  select feedback.promotion_status
  into v_feedback_status
  from public.monitoring_feedback feedback
  where feedback.id = p_feedback_id;

  if not found then
    raise exception 'monitoring feedback was not found'
      using errcode = 'P0002';
  end if;

  if v_feedback_status <> 'pending_review' then
    raise exception 'monitoring feedback is already covered by an active rule'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.monitoring_feedback_promotions promotion
    where promotion.feedback_id = p_feedback_id
  ) then
    raise exception 'monitoring feedback is already promoted'
      using errcode = 'P0001';
  end if;

  begin
    insert into public.monitoring_feedback_promotions (
      request_id,
      feedback_id,
      actor_user_id,
      actor_email,
      policy_rule_id,
      policy_identity,
      policy_version,
      policy_hash,
      policy_config_version,
      decision_memory_version,
      note
    ) values (
      p_request_id,
      p_feedback_id,
      p_actor_user_id,
      v_actor_email,
      v_policy_rule_id,
      v_policy_identity,
      v_policy_version,
      v_policy_hash,
      p_policy_config_version,
      p_decision_memory_version,
      v_note
    )
    returning id into v_promotion_id;
  exception
    when unique_violation then
      select promotion.*
      into v_existing
      from public.monitoring_feedback_promotions promotion
      where promotion.request_id = p_request_id;

      if not found then
        if exists (
          select 1
          from public.monitoring_feedback_promotions promotion
          where promotion.feedback_id = p_feedback_id
        ) then
          raise exception 'monitoring feedback is already promoted'
            using errcode = 'P0001';
        end if;
        raise;
      end if;

      if v_existing.feedback_id is distinct from p_feedback_id
        or v_existing.actor_user_id is distinct from p_actor_user_id
        or v_existing.actor_email is distinct from v_actor_email
        or v_existing.policy_rule_id is distinct from v_policy_rule_id
        or v_existing.policy_identity is distinct from v_policy_identity
        or v_existing.policy_version is distinct from v_policy_version
        or v_existing.policy_hash is distinct from v_policy_hash
        or v_existing.policy_config_version is distinct from p_policy_config_version
        or v_existing.decision_memory_version is distinct from p_decision_memory_version
        or v_existing.note is distinct from v_note then
        raise exception 'request ID was already used for a different promotion'
          using errcode = '22023';
      end if;

      return query
        select
          v_existing.id,
          v_existing.feedback_id,
          v_existing.policy_rule_id,
          v_existing.created_at;
      return;
  end;

  return query
    select v_promotion_id, p_feedback_id, v_policy_rule_id, v_now;
end;
$function$;

revoke execute on function public.record_monitoring_feedback_promotion(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  text
) from public, anon, authenticated;
grant execute on function public.record_monitoring_feedback_promotion(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  text
) to service_role;

notify pgrst, 'reload schema';
