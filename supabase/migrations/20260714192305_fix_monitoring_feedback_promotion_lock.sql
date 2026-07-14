-- Row-locking reads require UPDATE privilege in PostgreSQL. The feedback table is
-- deliberately append-only and grants the service role only SELECT/INSERT, so a
-- plain read is sufficient before inserting the separately locked promotion row.
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

  if nullif(btrim(coalesce(p_policy_identity, '')), '') is null
    or nullif(btrim(coalesce(p_policy_version, '')), '') is null
    or nullif(btrim(coalesce(p_policy_hash, '')), '') is null then
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
    if v_existing.feedback_id <> p_feedback_id
      or v_existing.actor_user_id <> p_actor_user_id then
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
    p_policy_identity,
    p_policy_version,
    p_policy_hash,
    p_policy_config_version,
    p_decision_memory_version,
    v_note
  )
  returning id into v_promotion_id;

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
