-- Fail closed when an authoritative R2 baseline cannot be restored locally.
-- These RPCs keep the source lifecycle state and the operator quarantine case
-- in one transaction, and only a verified exact-generation restore may reopen
-- the source.

create or replace function public.record_r2_baseline_recovery_quarantine(
  p_source_id uuid,
  p_reason_code text,
  p_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_source public.shared_award_sources%rowtype;
  v_award public.shared_awards%rowtype;
  v_reason_code text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_reason_code, '')));
  v_message text;
  v_note text;
  v_quarantine_key text;
  v_evidence jsonb;
  v_quarantine_id uuid;
  v_worker_owns_review boolean;
  v_policy_id constant text := 'awardping-r2-baseline-recovery-quarantine';
  v_policy_version constant text := '1';
  v_policy_hash constant text := '4458c623fe35d74671bf6b6c418b0dd3ac0567933f05fb87d562348a8a288683';
begin
  if p_source_id is null
    or v_reason_code = ''
    or pg_catalog.length(v_reason_code) > 200
    or v_reason_code !~ '^[a-z0-9_]+$'
    or p_evidence is null
    or pg_catalog.jsonb_typeof(p_evidence) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'R2 baseline-recovery quarantine requires a source, normalized reason, and JSON evidence object.';
  end if;

  -- Lock both rows so an award cannot be archived and a source cannot be
  -- reassigned or independently reviewed during this quarantine transaction.
  select source.* into strict v_source
  from public.shared_award_sources source
  join public.shared_awards award
    on award.id = source.shared_award_id
   and award.status = 'active'
  where source.id = p_source_id
  for update of source, award;

  select award.* into strict v_award
  from public.shared_awards award
  where award.id = v_source.shared_award_id
    and award.status = 'active';

  v_message := pg_catalog.left(
    coalesce(
      nullif(pg_catalog.btrim(p_evidence ->> 'message'), ''),
      'Exact local-cache recovery from the authoritative R2 generation failed.'
    ),
    1000
  );
  v_note := pg_catalog.left(
    'AwardPing R2 recovery quarantine: ' || v_reason_code || '. ' ||
    'Verify the immutable R2 pointer, object metadata, hashes, and complete generation; ' ||
    'then restore those exact bytes. Do not fetch or promote a replacement baseline.',
    1000
  );
  v_quarantine_key := 'r2-baseline-recovery:' || v_source.id::text;
  v_worker_owns_review :=
    v_source.admin_review_status = 'open'
    or (
      v_source.admin_review_status = 'review_later'
      and v_source.admin_reviewed_by = 'awardping-r2-baseline-recovery'
      and coalesce(v_source.admin_review_note, '') like
        'AwardPing R2 recovery quarantine:%'
    );

  -- Never overwrite a separate operator's review_later ownership. The source
  -- is already protected in that case, while the dedicated registry case still
  -- records the R2 failure and remains explicitly actionable.
  if v_worker_owns_review then
    update public.shared_award_sources source
    set
      admin_review_status = 'review_later',
      admin_review_note = v_note,
      admin_reviewed_at = v_now,
      admin_reviewed_by = 'awardping-r2-baseline-recovery',
      last_checked_at = v_now,
      consecutive_failures = coalesce(source.consecutive_failures, 0) + 1,
      last_error = v_message,
      updated_at = v_now
    where source.id = v_source.id;
  end if;

  v_evidence := pg_catalog.jsonb_build_object(
    'schema_version', 'awardping.r2-baseline-recovery-quarantine.v1',
    'observed_at', v_now,
    'failure', pg_catalog.jsonb_build_object(
      'reason_code', v_reason_code,
      'message', v_message,
      'worker_evidence', p_evidence
    ),
    'source', pg_catalog.jsonb_build_object(
      'id', v_source.id,
      'shared_award_id', v_source.shared_award_id,
      'url', v_source.url,
      'title', coalesce(
        nullif(v_source.display_title, ''),
        nullif(v_source.title, ''),
        v_source.url
      ),
      'review_status_before', v_source.admin_review_status,
      'reviewed_by_before', v_source.admin_reviewed_by,
      'review_note_before', v_source.admin_review_note,
      'r2_worker_owns_review', v_worker_owns_review
    ),
    'award', pg_catalog.jsonb_build_object(
      'id', v_award.id,
      'name', v_award.name,
      'status', v_award.status
    ),
    'protection', pg_catalog.jsonb_build_object(
      'public_impact', 'protected',
      'live_fetch_allowed', false,
      'replacement_baseline_allowed', false,
      'last_known_good_preserved', true
    ),
    'retry', pg_catalog.jsonb_build_object(
      'creates_api_charge', false,
      'required_result', 'exact_r2_generation_rehydrated'
    ),
    'policy', pg_catalog.jsonb_build_object(
      'id', v_policy_id,
      'version', v_policy_version,
      'hash', v_policy_hash
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
    policy_id,
    policy_version,
    policy_hash,
    first_observed_at,
    last_observed_at,
    quarantined_at,
    resolved_at,
    resolved_by,
    resolution_note
  ) values (
    v_quarantine_key,
    v_quarantine_key,
    'actionable_quarantine',
    'public_page',
    'quarantined',
    true,
    true,
    1,
    'high',
    'protected',
    'Baseline evidence recovery',
    'manual_exact_r2_rehydration_then_automatic_resume',
    'none',
    coalesce(
      nullif(v_source.display_title, ''),
      nullif(v_source.title, ''),
      v_source.url
    ) || ': authoritative baseline recovery failed',
    'r2_authoritative_baseline_recovery_failed',
    v_message,
    'Inspect the immutable R2 pointer and complete generation. Use only the exact-source, no-charge recovery path to restore the same source, capture time, kind, metadata, and hash-bound objects; broad scans remain excluded. A successful exact restore automatically reopens this source. Never fetch a replacement baseline.',
    v_source.shared_award_id,
    v_source.id,
    'shared_award_sources',
    v_source.id,
    1,
    v_evidence,
    public.manual_quarantine_evidence_hash(v_evidence),
    v_policy_id,
    v_policy_version,
    v_policy_hash,
    v_now,
    v_now,
    v_now,
    null,
    null,
    null
  )
  on conflict (quarantine_key) do update set
    case_key = excluded.case_key,
    classification = excluded.classification,
    category = excluded.category,
    status = case
      when public.manual_quarantine_registry.status = 'in_review' then 'in_review'
      else 'quarantined'
    end,
    requires_action = excluded.requires_action,
    terminal = excluded.terminal,
    terminal_failure_count = excluded.terminal_failure_count,
    severity = excluded.severity,
    public_impact = excluded.public_impact,
    owner = excluded.owner,
    retry_mode = excluded.retry_mode,
    retry_charge = excluded.retry_charge,
    title = excluded.title,
    reason_code = excluded.reason_code,
    reason = excluded.reason,
    recommended_action = excluded.recommended_action,
    shared_award_id = excluded.shared_award_id,
    shared_award_source_id = excluded.shared_award_source_id,
    primary_source_table = excluded.primary_source_table,
    primary_source_record_id = excluded.primary_source_record_id,
    evidence_record_count = excluded.evidence_record_count,
    evidence = excluded.evidence,
    evidence_hash = excluded.evidence_hash,
    policy_id = excluded.policy_id,
    policy_version = excluded.policy_version,
    policy_hash = excluded.policy_hash,
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
    raise exception using
      errcode = '23503',
      message = 'R2 baseline-recovery quarantine references a missing source or inactive award.';
end;
$$;

revoke all on function public.record_r2_baseline_recovery_quarantine(uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_r2_baseline_recovery_quarantine(uuid, text, jsonb)
  to service_role;

-- The generic quarantine sync resolves public_page cases when their current
-- page-audit/reconciliation inputs clear. This source-keyed case has neither
-- input and must stay open until the dedicated exact-rehydration RPC succeeds.
create or replace function public.preserve_r2_baseline_recovery_quarantine()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.policy_id = 'awardping-r2-baseline-recovery-quarantine'
    and old.quarantine_key =
      'r2-baseline-recovery:' || old.shared_award_source_id::text
    and old.status in ('quarantined', 'in_review')
    and new.status = 'resolved'
    and new.resolved_by = 'manual-quarantine-sync' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.preserve_r2_baseline_recovery_quarantine()
  from public, anon, authenticated, service_role;

drop trigger if exists zz_preserve_r2_baseline_recovery_quarantine
  on public.manual_quarantine_registry;
create trigger zz_preserve_r2_baseline_recovery_quarantine
before update on public.manual_quarantine_registry
for each row execute function public.preserve_r2_baseline_recovery_quarantine();

create or replace function public.resolve_r2_baseline_recovery_quarantine(
  p_source_id uuid,
  p_evidence jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_source public.shared_award_sources%rowtype;
  v_quarantine public.manual_quarantine_registry%rowtype;
  v_resolved_evidence jsonb;
  v_reopen_source boolean;
  v_policy_id constant text := 'awardping-r2-baseline-recovery-quarantine';
  v_policy_version constant text := '1';
  v_policy_hash constant text := '4458c623fe35d74671bf6b6c418b0dd3ac0567933f05fb87d562348a8a288683';
begin
  if p_source_id is null
    or p_evidence is null
    or pg_catalog.jsonb_typeof(p_evidence) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'R2 baseline-recovery resolution requires a source and exact-rehydration JSON evidence.';
  end if;

  select source.* into strict v_source
  from public.shared_award_sources source
  join public.shared_awards award
    on award.id = source.shared_award_id
   and award.status = 'active'
  where source.id = p_source_id
  for update of source, award;

  select registry.* into v_quarantine
  from public.manual_quarantine_registry registry
  where registry.quarantine_key = 'r2-baseline-recovery:' || p_source_id::text
    and registry.case_key = registry.quarantine_key
    and registry.classification = 'actionable_quarantine'
    and registry.category = 'public_page'
    and registry.status in ('quarantined', 'in_review')
    and registry.terminal
    and registry.shared_award_id = v_source.shared_award_id
    and registry.shared_award_source_id = v_source.id
    and registry.primary_source_table = 'shared_award_sources'
    and registry.primary_source_record_id = v_source.id
    and registry.policy_id = v_policy_id
    and registry.policy_version = v_policy_version
    and registry.policy_hash = v_policy_hash
  for update;

  if not found then
    return false;
  end if;

  -- Accept the native exact-rehydration result shape only. These fields were
  -- already verified against the immutable pointer, object metadata, bytes,
  -- and local baseline before the service-role worker calls this RPC.
  if p_evidence ->> 'schema_version' is distinct from
      'awardping.r2-baseline-recovery-resolution.v1'
    or p_evidence ->> 'source_id' is distinct from p_source_id::text
    or p_evidence ->> 'shared_award_id' is distinct from v_source.shared_award_id::text
    or p_evidence -> 'rehydrated' is distinct from 'true'::jsonb
    or p_evidence -> 'creates_api_charge' is distinct from 'false'::jsonb
    or p_evidence -> 'used_live_fetch' is distinct from 'false'::jsonb
    or coalesce(p_evidence ->> 'reason', '') not like
      'exact_r2_generation_rehydrated%'
    or coalesce(p_evidence ->> 'generation', '') not in ('latest', 'previous')
    or coalesce(p_evidence ->> 'family', '') not in ('captures', 'approved')
    or coalesce(p_evidence ->> 'version', '') !~* '^[0-9a-f]{32}$'
    or coalesce(p_evidence ->> 'artifact_count', '') !~ '^[1-9][0-9]*$'
    or p_evidence #>> '{baseline,source,id}' is distinct from p_source_id::text
    or p_evidence #>> '{baseline,source,shared_award_id}' is distinct from
      v_source.shared_award_id::text
    or coalesce(p_evidence #>> '{baseline,kind}', '') not in ('webpage', 'pdf')
    or nullif(
      pg_catalog.btrim(coalesce(p_evidence #>> '{baseline,captured_at}', '')),
      ''
    ) is null
    or coalesce(p_evidence #>> '{baseline,text_hash}', '') !~* '^[0-9a-f]{64}$'
    or (
      p_evidence #>> '{baseline,kind}' = 'pdf'
      and coalesce(p_evidence #>> '{baseline,file_hash}', '') !~* '^[0-9a-f]{64}$'
    )
    or (
      p_evidence #>> '{baseline,kind}' = 'webpage'
      and coalesce(p_evidence #>> '{baseline,image_hash}', '') !~* '^[0-9a-f]{64}$'
    ) then
    raise exception using
      errcode = '23514',
      message = 'Only a complete exact R2 generation rehydration for this source and award can resolve the quarantine.';
  end if;

  -- An exact restore resolves the R2 evidence problem, but it must not erase a
  -- separate operator/workflow review. Reopen and clear source failure fields
  -- only while the exact status/by/note ownership marker is still intact.
  v_reopen_source :=
    v_source.admin_review_status = 'review_later'
    and v_source.admin_reviewed_by = 'awardping-r2-baseline-recovery'
    and coalesce(v_source.admin_review_note, '') like
      'AwardPing R2 recovery quarantine:%';

  v_resolved_evidence := v_quarantine.evidence || pg_catalog.jsonb_build_object(
    'resolution', pg_catalog.jsonb_build_object(
      'resolved_at', v_now,
      'reason', 'exact_r2_generation_rehydrated',
      'rehydration', p_evidence,
      'source_reopened', v_reopen_source,
      'source_review_state_preserved', not v_reopen_source,
      'source_review_status', v_source.admin_review_status,
      'source_reviewed_by', v_source.admin_reviewed_by,
      'creates_api_charge', false
    )
  );

  if v_reopen_source then
    update public.shared_award_sources source
    set
      admin_review_status = 'open',
      admin_review_note = null,
      admin_reviewed_at = null,
      admin_reviewed_by = null,
      next_check_at = v_now,
      consecutive_failures = 0,
      last_error = null,
      updated_at = v_now
    where source.id = v_source.id;
  end if;

  update public.manual_quarantine_registry registry
  set
    status = 'resolved',
    resolved_at = v_now,
    resolved_by = 'awardping-r2-baseline-recovery',
    resolution_note = case
      when v_reopen_source then
        'The exact immutable R2 generation was verified, restored to the local cache, and the source was safely reopened.'
      else
        'The exact immutable R2 generation was verified and restored. A separate source review state was preserved, so this RPC did not reopen the source.'
    end,
    evidence = v_resolved_evidence,
    evidence_hash = public.manual_quarantine_evidence_hash(v_resolved_evidence)
  where registry.id = v_quarantine.id;

  perform public.refresh_manual_quarantine_registry_state(v_now);
  return true;
exception
  when no_data_found then
    raise exception using
      errcode = '23503',
      message = 'R2 baseline-recovery resolution references a missing source or inactive award.';
end;
$$;

revoke all on function public.resolve_r2_baseline_recovery_quarantine(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_r2_baseline_recovery_quarantine(uuid, jsonb)
  to service_role;

comment on function public.record_r2_baseline_recovery_quarantine(uuid, text, jsonb) is
  'Atomically protects a source and opens one source-keyed, no-charge operator case when authoritative R2 baseline recovery fails closed.';
comment on function public.resolve_r2_baseline_recovery_quarantine(uuid, jsonb) is
  'Resolves the exact open R2 recovery case and reopens its still-owned source only after exact immutable-generation rehydration succeeds.';
