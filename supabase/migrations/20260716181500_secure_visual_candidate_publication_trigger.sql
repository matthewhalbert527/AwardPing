-- The published-candidate freeze trigger validates exact immutable event
-- evidence and candidate snapshot manifests before allowing `published`.
-- Its internal manifest helpers are intentionally not executable through
-- PostgREST, including by service_role, so the trigger must run as its trusted
-- owner. First-observation candidates also truthfully have an attestation in
-- place of a previous snapshot manifest; validate that narrow contract without
-- weakening the ordinary two-snapshot publication path.
do $migration_preflight$
declare
  v_function regprocedure := pg_catalog.to_regprocedure(
    'public.awardping_freeze_published_visual_candidate_event_binding()'
  );
  v_validator regprocedure := pg_catalog.to_regprocedure(
    'public.awardping_validate_candidate_snapshot_manifest(jsonb,jsonb,text,text)'
  );
  v_definition text;
  v_owner name;
  v_owner_oid oid;
  v_result text;
  v_validator_owner_oid oid;
begin
  if v_function is null or v_validator is null then
    raise exception using
      errcode = '42883',
      message = 'Published visual-candidate freeze trigger or private manifest validator is missing; apply prerequisite migrations first.';
  end if;

  select
    pg_catalog.pg_get_functiondef(proc.oid),
    pg_catalog.pg_get_userbyid(proc.proowner),
    proc.proowner,
    pg_catalog.pg_get_function_result(proc.oid)
  into strict v_definition, v_owner, v_owner_oid, v_result
  from pg_catalog.pg_proc proc
  where proc.oid = v_function;

  select proc.proowner
  into strict v_validator_owner_oid
  from pg_catalog.pg_proc proc
  where proc.oid = v_validator;

  if v_result is distinct from 'trigger'
    or v_owner in ('anon', 'authenticated', 'service_role')
    or v_owner_oid is distinct from v_validator_owner_oid
    or pg_catalog.strpos(
      v_definition,
      'old.status <> ''published'' and new.status = ''published'''
    ) = 0
    or pg_catalog.strpos(
      v_definition,
      'shared_award_change_event_visual_evidence'
    ) = 0
    or pg_catalog.strpos(
      v_definition,
      'awardping_validate_candidate_snapshot_manifest'
    ) = 0
    or pg_catalog.strpos(v_definition, 'old.status = ''published''') = 0 then
    raise exception using
      errcode = '23514',
      message = 'Published visual-candidate freeze trigger does not match the guarded immutable-evidence or private-validator ownership contract.';
  end if;
end;
$migration_preflight$;

create or replace function public.awardping_freeze_published_visual_candidate_event_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'published' then
      raise exception using
        errcode = '23514',
        message = 'A post-migration visual candidate cannot be inserted directly in published status.';
    end if;
    return new;
  end if;

  if old.status <> 'published' and new.status = 'published' then
    if nullif(btrim(new.worker_metadata ->> 'change_event_id'), '') is null
      or (
        nullif(btrim(old.worker_metadata ->> 'change_event_id'), '') is not null
        and new.worker_metadata ->> 'change_event_id' is distinct from
          old.worker_metadata ->> 'change_event_id'
      ) then
      raise exception using
        errcode = '55000',
        message = 'A visual candidate must enter published status with its existing exact reverse event binding.';
    end if;

    if not exists (
      select 1
      from public.shared_award_change_event_visual_evidence evidence
      where evidence.visual_review_candidate_id = new.id
        and evidence.change_event_id::text = new.worker_metadata ->> 'change_event_id'
    ) then
      raise exception using
        errcode = '23514',
        message = 'A visual candidate cannot enter published status before its exact immutable event evidence exists.';
    end if;

    if new.worker_metadata ->> 'evidence_signature' is null
      or new.worker_metadata ->> 'evidence_signature' !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '23514',
        message = 'A modern visual candidate cannot enter published status without its evidence signature.';
    end if;

    if new.candidate_scope = 'initial_official_document' then
      if new.source_acquisition_id is null
        or jsonb_typeof(new.previous_snapshot_ref) is distinct from 'object'
        or new.previous_snapshot_ref is distinct from
          new.prompt_payload -> 'previous_snapshot_ref'
        or new.previous_snapshot_ref ->> 'kind' is distinct from
          'first_observation_attestation'
        or coalesce(
          new.previous_snapshot_ref ->> 'attestation_sha256' ~ '^[0-9a-f]{64}$',
          false
        ) is not true
        or new.previous_snapshot_ref ->> 'attestation_sha256' is distinct from
          new.previous_file_hash
        or new.previous_snapshot_ref ->> 'attestation_sha256' is distinct from
          new.prompt_payload #>> '{first_observation_attestation,sha256}'
        or new.previous_snapshot_ref ->> 'attestation_sha256' is distinct from
          new.prompt_payload #>> '{hashes,first_observation_attestation_sha256}'
        or new.previous_snapshot_ref ->> 'source_acquisition_id' is distinct from
          new.source_acquisition_id::text
        or coalesce(
          new.previous_snapshot_ref ->> 'byte_length' ~ '^[1-9][0-9]*$',
          false
        ) is not true
        or new.previous_snapshot_ref ->> 'byte_length' is distinct from
          new.prompt_payload #>> '{first_observation_attestation,byte_length}'
        or new.previous_snapshot_ref ->> 'content_type' is distinct from
          'application/json'
        or new.previous_snapshot_ref ->> 'content_type' is distinct from
          new.prompt_payload #>> '{first_observation_attestation,content_type}'
        or coalesce(
          new.previous_snapshot_ref ->> 'captured_at' ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.+Z$',
          false
        ) is not true
        or new.previous_snapshot_ref ->> 'captured_at' is distinct from
          new.prompt_payload #>>
            '{first_observation_attestation,body,capture,captured_at}'
        or new.previous_snapshot_ref ? 'artifact_manifest'
        or nullif(
          btrim(new.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}'),
          ''
        ) is not null then
        raise exception using
          errcode = '23514',
          message = 'An initial official-document candidate requires its exact immutable first-observation attestation instead of a previous snapshot manifest.';
      end if;

      if not exists (
        select 1
        from public.shared_award_change_event_visual_evidence evidence
        where evidence.visual_review_candidate_id = new.id
          and evidence.change_event_id::text = new.worker_metadata ->> 'change_event_id'
          and evidence.evidence_status = 'not_applicable_new_document'
          and evidence.previous_capture ->> 'kind' = 'first_observation_attestation'
          and evidence.previous_capture ->> 'state_id' = 'first-observation'
          and evidence.previous_capture #>> '{metadata,sha256}' = new.previous_file_hash
          and evidence.previous_capture #>> '{metadata,byte_length}' =
            new.previous_snapshot_ref ->> 'byte_length'
          and evidence.previous_capture #>> '{metadata,content_type}' like
            'application/json%'
          and evidence.previous_capture ->> 'captured_at' =
            new.previous_snapshot_ref ->> 'captured_at'
          and evidence.previous_capture #>> '{capture_hashes,attestation_hash}' =
            new.previous_file_hash
          and evidence.previous_capture #>> '{attestation,binding,candidate_id}' =
            new.id::text
          and evidence.previous_capture #>> '{attestation,binding,candidate_signature}' =
            new.candidate_signature
          and evidence.previous_capture #>>
            '{attestation,binding,source_acquisition_id}' =
              new.source_acquisition_id::text
          and evidence.previous_capture #>>
            '{attestation,binding,first_observation_attestation_sha256}' =
              new.previous_file_hash
          and evidence.previous_capture #>>
            '{attestation,binding,current_file_sha256}' = new.new_file_hash
          and evidence.current_capture ->> 'kind' = 'pdf'
          and evidence.current_capture ->> 'state_id' = 'document'
          and evidence.current_capture #>> '{full,sha256}' = new.new_file_hash
          and evidence.current_capture #>> '{capture_hashes,file_hash}' =
            new.new_file_hash
      ) then
        raise exception using
          errcode = '23514',
          message = 'An initial official-document candidate cannot enter published status without its exact attestation and current-document evidence.';
      end if;

      perform public.awardping_validate_candidate_snapshot_manifest(
        new.new_snapshot_ref,
        new.prompt_payload -> 'new_snapshot_ref',
        new.prompt_payload #>> '{hashes,new_artifact_manifest_digest}',
        'current'
      );
    else
      perform public.awardping_validate_candidate_snapshot_manifest(
        new.previous_snapshot_ref,
        new.prompt_payload -> 'previous_snapshot_ref',
        new.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}',
        'previous'
      );
      perform public.awardping_validate_candidate_snapshot_manifest(
        new.new_snapshot_ref,
        new.prompt_payload -> 'new_snapshot_ref',
        new.prompt_payload #>> '{hashes,new_artifact_manifest_digest}',
        'current'
      );
    end if;
  end if;

  if old.status = 'published' and (
    new.status is distinct from old.status
    or new.worker_metadata ->> 'change_event_id' is distinct from
      old.worker_metadata ->> 'change_event_id'
  ) then
    raise exception using
      errcode = '55000',
      message = 'A published visual candidate status and reverse event binding are immutable.';
  end if;
  return new;
end;
$$;

-- Trigger functions cannot be called as ordinary SQL functions. Retain the
-- existing service-role trigger grant, exclude browser-facing roles, and do not
-- grant direct execution on any internal validator.
revoke all on function public.awardping_freeze_published_visual_candidate_event_binding()
  from public, anon, authenticated;
grant execute on function public.awardping_freeze_published_visual_candidate_event_binding()
  to service_role;

comment on function public.awardping_freeze_published_visual_candidate_event_binding() is
  'Owner-executed publication transition guard: ordinary candidates require both immutable snapshot manifests; first-document candidates require an exact prior attestation plus the current manifest and bound event evidence; internal validators remain unexposed.';
