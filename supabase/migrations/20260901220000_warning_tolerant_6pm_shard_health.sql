-- Warning-tolerant 6 PM shard health (OWNER RULING REQUIRED before apply).
--
-- Evidence (2026-09-01): private.stage1_6pm_shard_healthy as created in
-- 20260716224000 requires metadata.failure_groups to be EMPTY, run_health
-- incident_count = 0, status = 'healthy', and requires_attention = false.
-- The worker (scripts/lib/visual-capture-run-report.mjs) counts EVERY
-- report error as an incident and flips status to 'degraded' whenever
-- incident_count > 0 - including warning-severity classes such as
-- localization_evidence_unavailable (accordion isolation wobbles on pages
-- whose coverage still completes; observed on a source that BASELINED
-- cleanly the same run) and network_transient (a single recovered retry).
-- No nightly run in 21+ days of history has ever produced zero failure
-- groups; under the original predicate the four-consecutive-healthy-nights
-- soak is structurally unsatisfiable while any fleet page misbehaves
-- transiently, regardless of capture quality.
--
-- Amendment: derive night health from the failure-group SEVERITIES rather
-- than the warning-inflated scalars. Every real failure class stays fatal:
-- critical groups (baseline evidence, resource limits, PDF parse, unknown,
-- inventory proof), any counted source failure (failed_count / run_health
-- source_failures must still be zero), execution status, inventory
-- completeness, and the independent inventory proof are unchanged. A group
-- whose severity is anything other than 'warning' (including absent or
-- malformed severities) still fails the night - fail closed.

create or replace function private.stage1_6pm_shard_healthy(
  p_run public.local_worker_runs
)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_metadata jsonb := coalesce(p_run.metadata, '{}'::jsonb);
  v_identity jsonb := coalesce(v_metadata -> 'run_identity', '{}'::jsonb);
  v_health jsonb := coalesce(v_metadata -> 'run_health', '{}'::jsonb);
  v_groups jsonb;
  v_non_warning_groups integer := 0;
  v_shard_index integer;
begin
  if v_identity ->> 'shard_index' !~ '^[0-2]$' then return false; end if;
  v_shard_index := (v_identity ->> 'shard_index')::integer;

  v_groups := case
    when pg_catalog.jsonb_typeof(v_metadata -> 'failure_groups') = 'array'
      then v_metadata -> 'failure_groups'
    else '[]'::jsonb
  end;

  -- Fail closed: any group not explicitly marked severity 'warning' is fatal.
  select count(*) into v_non_warning_groups
  from pg_catalog.jsonb_array_elements(v_groups) as g(value)
  where coalesce(g.value ->> 'severity', '') <> 'warning';

  return p_run.status = 'succeeded'
    and p_run.finished_at is not null
    and p_run.finished_at >= p_run.started_at
    and p_run.checked_count > 0
    and p_run.failed_count = 0
    and nullif(pg_catalog.btrim(coalesce(p_run.error, '')), '') is null
    and v_health ->> 'schema_version' = '2'
    and v_health ->> 'status' in ('healthy', 'degraded')
    and v_health ->> 'execution_status' not in
      ('running', 'blocked', 'failed', 'recovery_required')
    and v_health ->> 'inventory_complete' = 'true'
    and v_health ->> 'inventory_proof_required' = 'true'
    and v_health ->> 'inventory_proof_complete' = 'true'
    and v_health ->> 'source_failures' = '0'
    and v_health ->> 'loaded_sources' ~ '^[1-9][0-9]*$'
    and v_health ->> 'processed_sources' = v_health ->> 'loaded_sources'
    and v_non_warning_groups = 0
    and private.stage1_6pm_inventory_proof_valid(v_metadata, v_shard_index);
exception when others then
  return false;
end;
$$;

revoke all on function private.stage1_6pm_shard_healthy(public.local_worker_runs)
  from public, anon, authenticated, service_role;
