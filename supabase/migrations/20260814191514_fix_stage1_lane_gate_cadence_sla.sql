-- Four downstream lanes are queue-backed, while four are cadence-backed.
-- list_monitoring_downstream_lane_status() intentionally exposes
-- oldest_item_sla_seconds only for queue-backed lanes; cadence lanes instead
-- expose a positive lane SLA and a next cadence deadline. The original Stage 1
-- release gate required oldest_item_sla_seconds > 0 for every lane, making the
-- eight-lane gate impossible even when all four cadence lanes were healthy.
--
-- Keep the gate fail closed by recognizing only the eight reviewed lane keys,
-- requiring a positive SLA for every lane, and validating the metric shape
-- appropriate to that lane. Existing enabled/lease/SLA-breach/timeout/source
-- and paid-lane predicates remain byte-for-byte unchanged.

create or replace function private.stage1_downstream_lane_sla_contract_valid(
  p_lane_key text,
  p_sla_seconds bigint,
  p_oldest_item_sla_seconds bigint,
  p_queue_depth bigint,
  p_oldest_item_at timestamptz,
  p_next_sla_due_at timestamptz
)
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select coalesce(
    case
      when p_lane_key in (
        'new_page_review',
        'changed_page_review',
        'feedback_promotion',
        'reconciliation'
      ) then
        p_sla_seconds > 0
        and p_oldest_item_sla_seconds = p_sla_seconds
      when p_lane_key in (
        'suppression',
        'page_audit',
        'manual_quarantine',
        'nightly_report'
      ) then
        p_sla_seconds > 0
        and p_oldest_item_sla_seconds is null
        and p_queue_depth = 0
        and p_oldest_item_at is null
        and p_next_sla_due_at is not null
      else false
    end,
    false
  );
$$;

revoke all on function private.stage1_downstream_lane_sla_contract_valid(
  text,
  bigint,
  bigint,
  bigint,
  timestamptz,
  timestamptz
) from public, anon, authenticated, service_role;

do $awardping_stage1_lane_gate_cadence_fix$
declare
  v_gate_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_gate_without_contact_fence_20260717123000(timestamp with time zone)'
  );
  v_wrapper_oid oid := pg_catalog.to_regprocedure(
    'private.stage1_release_gate_snapshot(timestamp with time zone)'
  );
  v_definition text;
  v_updated_definition text;
  v_wrapper_definition text;
  v_old_predicate constant text := 'lane.oldest_item_sla_seconds > 0';
  v_new_predicate constant text := $predicate$private.stage1_downstream_lane_sla_contract_valid(
          lane.lane_key,
          lane.sla_seconds,
          lane.oldest_item_sla_seconds,
          lane.queue_depth,
          lane.oldest_item_at,
          lane.next_sla_due_at
        )$predicate$;
  v_wrapper_anchor constant text :=
    'private.stage1_gate_without_contact_fence_20260717123000(';
  v_old_count integer;
  v_new_count integer;
  v_wrapper_anchor_count integer;
  v_owner oid;
  v_acl aclitem[];
  v_security_definer boolean;
  v_volatility "char";
  v_parallel "char";
  v_leakproof boolean;
  v_proconfig text[];
begin
  if v_gate_oid is null or v_wrapper_oid is null then
    raise exception using
      errcode = '42883',
      message = 'Stage 1 cadence-lane repair requires the deployed inner gate and canonical wrapper.';
  end if;

  select
    pg_catalog.pg_get_functiondef(procedure.oid),
    procedure.proowner,
    procedure.proacl,
    procedure.prosecdef,
    procedure.provolatile,
    procedure.proparallel,
    procedure.proleakproof,
    procedure.proconfig
  into strict
    v_definition,
    v_owner,
    v_acl,
    v_security_definer,
    v_volatility,
    v_parallel,
    v_leakproof,
    v_proconfig
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_gate_oid;

  select pg_catalog.pg_get_functiondef(v_wrapper_oid)
  into strict v_wrapper_definition;

  v_old_count := (
    pg_catalog.length(v_definition)
      - pg_catalog.length(
        pg_catalog.replace(v_definition, v_old_predicate, '')
      )
  ) / pg_catalog.length(v_old_predicate);
  v_new_count := (
    pg_catalog.length(v_definition)
      - pg_catalog.length(
        pg_catalog.replace(v_definition, v_new_predicate, '')
      )
  ) / pg_catalog.length(v_new_predicate);
  v_wrapper_anchor_count := (
    pg_catalog.length(v_wrapper_definition)
      - pg_catalog.length(
        pg_catalog.replace(v_wrapper_definition, v_wrapper_anchor, '')
      )
  ) / pg_catalog.length(v_wrapper_anchor);

  if v_old_count <> 1
    or v_new_count <> 0
    or v_wrapper_anchor_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 cadence-lane repair did not match the exact active gate chain.';
  end if;

  if not v_security_definer
    or v_volatility <> 'v'
    or not coalesce('search_path=""' = any(v_proconfig), false)
    or pg_catalog.has_function_privilege(
      'anon', v_gate_oid, 'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'authenticated', v_gate_oid, 'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'service_role', v_gate_oid, 'EXECUTE'
    ) then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 inner gate security contract changed before cadence-lane repair.';
  end if;

  v_updated_definition := pg_catalog.replace(
    v_definition,
    v_old_predicate,
    v_new_predicate
  );
  execute v_updated_definition;

  if not exists (
    select 1
    from pg_catalog.pg_proc procedure
    where procedure.oid = v_gate_oid
      and procedure.proowner = v_owner
      and procedure.proacl is not distinct from v_acl
      and procedure.prosecdef = v_security_definer
      and procedure.provolatile = v_volatility
      and procedure.proparallel = v_parallel
      and procedure.proleakproof = v_leakproof
      and procedure.proconfig is not distinct from v_proconfig
      and (
        pg_catalog.length(pg_catalog.pg_get_functiondef(procedure.oid))
          - pg_catalog.length(
            pg_catalog.replace(
              pg_catalog.pg_get_functiondef(procedure.oid),
              v_new_predicate,
              ''
            )
          )
      ) / pg_catalog.length(v_new_predicate) = 1
      and pg_catalog.strpos(
        pg_catalog.pg_get_functiondef(procedure.oid), v_old_predicate
      ) = 0
  ) then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 cadence-lane repair did not preserve the inner gate catalog contract.';
  end if;
end;
$awardping_stage1_lane_gate_cadence_fix$;

-- Executable, data-free migration smoke: all eight reviewed metric shapes pass,
-- while omitted, contradictory, unknown, and non-positive contracts fail.
do $awardping_stage1_lane_gate_cadence_smoke$
declare
  v_now constant timestamptz := '2026-01-01 00:00:00+00'::timestamptz;
  v_valid_count integer;
begin
  select count(*) filter (
    where private.stage1_downstream_lane_sla_contract_valid(
      fixture.lane_key,
      fixture.sla_seconds,
      fixture.oldest_item_sla_seconds,
      fixture.queue_depth,
      fixture.oldest_item_at,
      fixture.next_sla_due_at
    )
  )
  into v_valid_count
  from (
    values
      ('new_page_review', 3600::bigint, 3600::bigint, 1::bigint, v_now, v_now + interval '1 hour'),
      ('changed_page_review', 3600::bigint, 3600::bigint, 0::bigint, null::timestamptz, null::timestamptz),
      ('feedback_promotion', 3600::bigint, 3600::bigint, 0::bigint, null::timestamptz, null::timestamptz),
      ('reconciliation', 3600::bigint, 3600::bigint, 1::bigint, v_now, v_now + interval '1 hour'),
      ('suppression', 3600::bigint, null::bigint, 0::bigint, null::timestamptz, v_now + interval '1 hour'),
      ('page_audit', 3600::bigint, null::bigint, 0::bigint, null::timestamptz, v_now + interval '1 hour'),
      ('manual_quarantine', 3600::bigint, null::bigint, 0::bigint, null::timestamptz, v_now + interval '1 hour'),
      ('nightly_report', 3600::bigint, null::bigint, 0::bigint, null::timestamptz, v_now + interval '1 hour')
  ) fixture(
    lane_key,
    sla_seconds,
    oldest_item_sla_seconds,
    queue_depth,
    oldest_item_at,
    next_sla_due_at
  );

  if v_valid_count <> 8 then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 cadence-lane smoke did not accept exactly eight healthy metric shapes.';
  end if;

  if private.stage1_downstream_lane_sla_contract_valid(
      'suppression', 0, null, 0, null, v_now
    )
    or private.stage1_downstream_lane_sla_contract_valid(
      'suppression', 3600, 3600, 0, null, v_now
    )
    or private.stage1_downstream_lane_sla_contract_valid(
      'suppression', 3600, null, 1, null, v_now
    )
    or private.stage1_downstream_lane_sla_contract_valid(
      'suppression', 3600, null, 0, v_now, v_now
    )
    or private.stage1_downstream_lane_sla_contract_valid(
      'suppression', 3600, null, 0, null, null
    )
    or private.stage1_downstream_lane_sla_contract_valid(
      'reconciliation', 3600, null, 1, v_now, v_now
    )
    or private.stage1_downstream_lane_sla_contract_valid(
      'reconciliation', 3600, 1800, 1, v_now, v_now
    )
    or private.stage1_downstream_lane_sla_contract_valid(
      'unreviewed_lane', 3600, 3600, 0, null, null
    ) then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 cadence-lane smoke accepted an invalid metric shape.';
  end if;
end;
$awardping_stage1_lane_gate_cadence_smoke$;

do $awardping_stage1_lane_gate_cadence_security$
begin
  if not exists (
    select 1
    from pg_catalog.pg_proc procedure
    where procedure.oid = pg_catalog.to_regprocedure(
        'private.stage1_downstream_lane_sla_contract_valid(text,bigint,bigint,bigint,timestamp with time zone,timestamp with time zone)'
      )
      and not procedure.prosecdef
      and procedure.provolatile = 'i'
      and procedure.proparallel = 's'
      and coalesce('search_path=""' = any(procedure.proconfig), false)
  ) or pg_catalog.has_function_privilege(
    'anon',
    'private.stage1_downstream_lane_sla_contract_valid(text,bigint,bigint,bigint,timestamp with time zone,timestamp with time zone)',
    'EXECUTE'
  ) or pg_catalog.has_function_privilege(
    'authenticated',
    'private.stage1_downstream_lane_sla_contract_valid(text,bigint,bigint,bigint,timestamp with time zone,timestamp with time zone)',
    'EXECUTE'
  ) or pg_catalog.has_function_privilege(
    'service_role',
    'private.stage1_downstream_lane_sla_contract_valid(text,bigint,bigint,bigint,timestamp with time zone,timestamp with time zone)',
    'EXECUTE'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Stage 1 cadence-lane helper security boundary is not private and immutable.';
  end if;
end;
$awardping_stage1_lane_gate_cadence_security$;

comment on function private.stage1_downstream_lane_sla_contract_valid(
  text,
  bigint,
  bigint,
  bigint,
  timestamptz,
  timestamptz
) is
  'Fail-closed Stage 1 lane metric contract: queue lanes require matching oldest-item SLA; cadence lanes require a positive cadence SLA and a concrete next due time.';
