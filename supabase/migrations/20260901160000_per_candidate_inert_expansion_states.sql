-- Option E of docs/stage1-inert-expansion-candidates.md (adopted 2026-09-01):
-- inertness is per candidate, so mixed pages - real open states alongside
-- provably-dead controls (AMA physicians-of-tomorrow: 15 open + 6 proven dead;
-- a Simons Foundation tab) - may declare inert candidates with the same sealed
-- per-candidate proof. Every other guardrail is unchanged: inertness is earned
-- per capture (never configured), the proof lives in immutable metadata, and a
-- non-responding control remains a failure. Acceptance arithmetic already
-- requires retained + inert = attempted with zero failures.

create or replace function private.stage1_expansion_capture_coverage_valid(
  p_kind text,
  p_metadata jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_max_safe_integer constant numeric := 9007199254740991;
  v_coverage jsonb;
  v_complete boolean;
  v_status text;
  v_raw_count numeric;
  v_logical_count numeric;
  v_attempted_count numeric;
  v_retained_count numeric;
  v_capture_limit numeric;
  v_truncated boolean;
  v_truncated_count numeric;
  v_failure_count numeric;
  v_inert_count numeric;
  v_inert_entry jsonb;
  v_raw_exact boolean;
  v_logical_exact boolean;
  v_truncated_exact boolean;
begin
  if pg_catalog.jsonb_typeof(p_metadata) is distinct from 'object' then
    return false;
  end if;

  v_coverage := p_metadata -> 'expansion_state_capture_coverage';
  if p_kind = 'pdf' then
    return v_coverage is null
      or pg_catalog.jsonb_typeof(v_coverage) = 'null';
  end if;
  if p_kind is distinct from 'webpage'
    or pg_catalog.jsonb_typeof(v_coverage) is distinct from 'object'
    or v_coverage ->> 'schema' is distinct from
      'awardping.expansion-state-capture-coverage.v1'
    or pg_catalog.jsonb_typeof(v_coverage -> 'status')
      is distinct from 'string'
    or not coalesce(v_coverage ->> 'status', '') = any(array[
      'verified_complete',
      'incomplete_discovery',
      'incomplete_truncated',
      'incomplete_failures',
      'incomplete_state_count',
      'skipped_disabled',
      'skipped_profile',
      'skipped_relevance',
      'unavailable_error'
    ]::text[])
  then
    return false;
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(array[
      'attempted_count',
      'capture_limit',
      'failure_count',
      'logical_candidate_count',
      'raw_candidate_count',
      'retained_state_count',
      'truncated_count'
    ]::text[]) field_name
    where pg_catalog.jsonb_typeof(v_coverage -> field_name)
        is distinct from 'number'
      or coalesce(v_coverage ->> field_name, '') !~ '^(0|[1-9][0-9]*)$'
      or (case
        when pg_catalog.jsonb_typeof(v_coverage -> field_name) = 'number'
          and coalesce(v_coverage ->> field_name, '')
            ~ '^(0|[1-9][0-9]*)$'
          then (v_coverage ->> field_name)::numeric > v_max_safe_integer
        else false
      end)
  ) or exists (
    select 1
    from pg_catalog.unnest(array[
      'complete',
      'logical_candidate_count_exact',
      'raw_candidate_count_exact',
      'truncated',
      'truncated_count_exact'
    ]::text[]) field_name
    where pg_catalog.jsonb_typeof(v_coverage -> field_name)
      is distinct from 'boolean'
  ) then
    return false;
  end if;

  v_complete := (v_coverage ->> 'complete')::boolean;
  v_status := v_coverage ->> 'status';
  v_raw_count := (v_coverage ->> 'raw_candidate_count')::numeric;
  v_logical_count := (v_coverage ->> 'logical_candidate_count')::numeric;
  v_attempted_count := (v_coverage ->> 'attempted_count')::numeric;
  v_retained_count := (v_coverage ->> 'retained_state_count')::numeric;
  v_capture_limit := (v_coverage ->> 'capture_limit')::numeric;
  v_truncated := (v_coverage ->> 'truncated')::boolean;
  v_truncated_count := (v_coverage ->> 'truncated_count')::numeric;
  v_failure_count := (v_coverage ->> 'failure_count')::numeric;
  -- Provably-inert candidates (docs/stage1-inert-expansion-candidates.md,
  -- option C adopted 2026-08-30; option E adopted 2026-09-01: retained states
  -- and inert candidates may coexist - inertness is per candidate, and the
  -- acceptance arithmetic requires retained + inert = attempted).
  v_inert_count := coalesce((v_coverage ->> 'inert_count')::numeric, 0);
  if v_inert_count < 0 then
    return false;
  end if;
  if v_inert_count > 0 then
    if pg_catalog.jsonb_typeof(v_coverage -> 'inert_candidates') is distinct from 'array'
      or pg_catalog.jsonb_array_length(v_coverage -> 'inert_candidates') <> v_inert_count
    then
      return false;
    end if;
    for v_inert_entry in
      select entry from pg_catalog.jsonb_array_elements(v_coverage -> 'inert_candidates') entry
    loop
      if pg_catalog.jsonb_typeof(v_inert_entry) is distinct from 'object'
        or coalesce(v_inert_entry ->> 'selector', '') = ''
        or pg_catalog.jsonb_typeof(v_inert_entry -> 'attempts') is distinct from 'number'
        or (v_inert_entry ->> 'attempts')::numeric < 2
        or v_inert_entry -> 'control_responded' is distinct from 'true'::jsonb
        or v_inert_entry -> 'content_never_visible' is distinct from 'true'::jsonb
      then
        return false;
      end if;
    end loop;
  elsif v_coverage ? 'inert_candidates' then
    if pg_catalog.jsonb_typeof(v_coverage -> 'inert_candidates') is distinct from 'array'
      or pg_catalog.jsonb_array_length(v_coverage -> 'inert_candidates') <> 0
    then
      return false;
    end if;
  end if;
  v_raw_exact := (v_coverage ->> 'raw_candidate_count_exact')::boolean;
  v_logical_exact :=
    (v_coverage ->> 'logical_candidate_count_exact')::boolean;
  v_truncated_exact := (v_coverage ->> 'truncated_count_exact')::boolean;

  if v_raw_count < v_logical_count
    or v_attempted_count > v_logical_count
    or v_attempted_count > v_capture_limit
    or v_retained_count > v_attempted_count
    or v_failure_count > v_attempted_count
    or pg_catalog.jsonb_typeof(p_metadata -> 'expansion_state_count')
      is distinct from 'number'
    or coalesce(p_metadata ->> 'expansion_state_count', '')
      !~ '^(0|[1-9][0-9]*)$'
    or (case
      when pg_catalog.jsonb_typeof(p_metadata -> 'expansion_state_count') = 'number'
        and coalesce(p_metadata ->> 'expansion_state_count', '')
          ~ '^(0|[1-9][0-9]*)$'
        then (p_metadata ->> 'expansion_state_count')::numeric
          is distinct from v_retained_count
      else false
    end)
    or pg_catalog.jsonb_typeof(
      p_metadata #> '{retained_artifact_projection,authoritative,expansion_state_count}'
    ) is distinct from 'number'
    or coalesce(
      p_metadata #>>
        '{retained_artifact_projection,authoritative,expansion_state_count}',
      ''
    ) !~ '^(0|[1-9][0-9]*)$'
    or (case
      when pg_catalog.jsonb_typeof(
        p_metadata #> '{retained_artifact_projection,authoritative,expansion_state_count}'
      ) = 'number'
        and coalesce(
          p_metadata #>>
            '{retained_artifact_projection,authoritative,expansion_state_count}',
          ''
        ) ~ '^(0|[1-9][0-9]*)$'
        then (
          p_metadata #>>
            '{retained_artifact_projection,authoritative,expansion_state_count}'
        )::numeric is distinct from v_retained_count
      else false
    end)
    or (
      v_logical_exact
      and v_truncated_exact
      and v_truncated_count is distinct from
        greatest(0, v_logical_count - v_attempted_count)
    )
    or (
      v_logical_exact
      and v_logical_count > v_attempted_count
      and not v_truncated
    )
    or v_complete is distinct from (v_status = 'verified_complete')
  then
    return false;
  end if;

  -- Stage 1 publication requires verified completeness. Incomplete legacy
  -- recovery verdicts remain recoverable locally/R2 but cannot satisfy release.
  return v_complete
    and v_raw_exact
    and v_logical_exact
    and not v_truncated
    and v_truncated_count = 0
    and v_truncated_exact
    and v_attempted_count = v_logical_count
    and v_retained_count + v_inert_count = v_attempted_count
    and v_failure_count = 0;
end;
$$;
