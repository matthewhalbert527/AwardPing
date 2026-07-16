-- Align the atomic initial-document publisher with the canonical evidence
-- manifest emitted by preparePublishedInitialOfficialDocumentEvidence().
--
-- The durable evidence contract uses the state ID `first-observation`. The
-- original publication RPC accidentally required `first_observation`, so it
-- rejected otherwise valid, fully hash-bound evidence. Patch exactly that one
-- predicate in place. The same publication path now retains candidate-bound
-- PDF text, so also require its permanent R2 artifact contract before the
-- existing candidate hash/length validation. Refuse to proceed if the deployed
-- definition differs in any unexpected way rather than weakening or rebuilding
-- its other guards.
do $migration$
declare
  v_function regprocedure := pg_catalog.to_regprocedure(
    'public.publish_shared_award_initial_document_event(jsonb,jsonb)'
  );
  v_definition text;
  v_old_occurrences integer;
  v_new_occurrences integer;
  v_old_predicate constant text :=
    $predicate$v_previous_capture ->> 'state_id' is distinct from 'first_observation'$predicate$;
  v_new_predicate constant text :=
    $predicate$v_previous_capture ->> 'state_id' is distinct from 'first-observation'$predicate$;
  v_old_text_guard constant text := $guard$  perform public.awardping_assert_permanent_visual_artifact(v_current_capture -> 'metadata', 'current.metadata');
  perform public.awardping_validate_candidate_snapshot_manifest($guard$;
  v_new_text_guard constant text := $guard$  perform public.awardping_assert_permanent_visual_artifact(v_current_capture -> 'metadata', 'current.metadata');
  perform public.awardping_assert_permanent_visual_artifact(v_current_capture -> 'text', 'current.text');
  perform public.awardping_validate_candidate_snapshot_manifest($guard$;
  v_old_text_guard_occurrences integer;
  v_new_text_guard_occurrences integer;
begin
  if v_function is null then
    raise exception using
      errcode = '42883',
      message = 'Initial-document publication RPC is missing; apply prerequisite migrations first.';
  end if;

  select pg_catalog.pg_get_functiondef(v_function)
  into strict v_definition;

  v_old_occurrences := (
    pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_old_predicate, ''))
  ) / pg_catalog.length(v_old_predicate);
  v_new_occurrences := (
    pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_new_predicate, ''))
  ) / pg_catalog.length(v_new_predicate);
  v_old_text_guard_occurrences := (
    pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_old_text_guard, ''))
  ) / pg_catalog.length(v_old_text_guard);
  v_new_text_guard_occurrences := (
    pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_new_text_guard, ''))
  ) / pg_catalog.length(v_new_text_guard);

  if v_old_occurrences = 1 and v_new_occurrences = 0 then
    v_definition := pg_catalog.replace(v_definition, v_old_predicate, v_new_predicate);
  elsif not (v_old_occurrences = 0 and v_new_occurrences = 1) then
    raise exception using
      errcode = '23514',
      message = 'Initial-document publication RPC has an unexpected or ambiguous attestation state-ID contract.';
  end if;

  if v_old_text_guard_occurrences = 1 and v_new_text_guard_occurrences = 0 then
    v_definition := pg_catalog.replace(v_definition, v_old_text_guard, v_new_text_guard);
  elsif not (v_old_text_guard_occurrences = 0 and v_new_text_guard_occurrences = 1) then
    raise exception using
      errcode = '23514',
      message = 'Initial-document publication RPC has an unexpected or ambiguous current-text artifact contract.';
  end if;

  execute v_definition;
end;
$migration$;

-- CREATE OR REPLACE preserves the existing function ACL. Reassert the narrow
-- service-role-only execution surface explicitly so the forward repair is
-- independently auditable.
revoke all on function public.publish_shared_award_initial_document_event(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_shared_award_initial_document_event(jsonb, jsonb)
  to service_role;

comment on function public.publish_shared_award_initial_document_event(jsonb, jsonb) is
  'Atomically publishes a truthful current-only first-observation event with canonical first-observation evidence state, an immutable attestation, and retained candidate-bound official PDF and text artifacts; bulk onboarding is ineligible.';
