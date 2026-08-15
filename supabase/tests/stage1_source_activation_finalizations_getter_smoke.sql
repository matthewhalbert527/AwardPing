-- Exercise the service-role-only Stage 1 finalization getter without changing
-- application data. Positive round trips run when finalized rows exist; all
-- validation, completeness, owner, search-path, and ACL checks are data-free.
do $smoke$
declare
  v_function_oid oid := pg_catalog.to_regprocedure(
    'public.get_stage1_source_activation_finalizations(uuid[])'
  );
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
  v_before_count bigint;
  v_after_count bigint;
  v_rejected boolean;
  v_missing_source_id uuid;
  v_existing_source_id uuid;
  v_requested_source_ids uuid[];
  v_loaded_source_ids uuid[];
  v_over_limit uuid[];
  v_expected jsonb;
  v_actual jsonb;
begin
  if v_function_oid is null
    or v_service_role_oid is null
    or not exists (
      select 1
      from pg_catalog.pg_proc target
      where target.oid = v_function_oid
        and pg_catalog.pg_get_userbyid(target.proowner) = 'postgres'
        and target.proretset
        and target.provolatile = 's'
        and target.proparallel = 's'
        and not target.prosecdef
        and not target.proleakproof
        and target.proconfig is not distinct from
          array['search_path=""']::text[]
        and pg_catalog.has_function_privilege(
          'service_role', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'anon', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated', target.oid, 'EXECUTE'
        )
        and not exists (
          select 1
          from pg_catalog.aclexplode(
            coalesce(
              target.proacl,
              pg_catalog.acldefault('f', target.proowner)
            )
          ) privilege
          where privilege.grantee = 0
            or privilege.grantee not in (target.proowner, v_service_role_oid)
            or privilege.privilege_type <> 'EXECUTE'
            or (
              privilege.grantee = v_service_role_oid
              and privilege.is_grantable
            )
        )
    )
  then
    raise exception
      'The Stage 1 finalization getter owner, security, search path, or ACL is unsafe.';
  end if;

  if not pg_catalog.has_table_privilege(
      'service_role',
      'private.stage1_source_baseline_activation_finalizations',
      'SELECT'
    )
    or not exists (
      select 1
      from pg_catalog.pg_policy policy
      where policy.polrelid =
          'private.stage1_source_baseline_activation_finalizations'::regclass
        and policy.polcmd = 'r'
        and v_service_role_oid = any(policy.polroles)
    )
  then
    raise exception
      'The Stage 1 finalization getter lacks its existing narrow service-role read authority.';
  end if;

  select pg_catalog.count(*)
  into v_before_count
  from private.stage1_source_baseline_activation_finalizations;

  v_rejected := false;
  begin
    perform 1
    from public.get_stage1_source_activation_finalizations(null::uuid[]);
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'A null source-ID array was accepted.';
  end if;

  v_rejected := false;
  begin
    perform 1
    from public.get_stage1_source_activation_finalizations(array[]::uuid[]);
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'An empty source-ID array was accepted.';
  end if;

  v_rejected := false;
  begin
    perform 1
    from public.get_stage1_source_activation_finalizations(
      array[
        '00000000-0000-4000-8000-000000000001'::uuid,
        null::uuid
      ]
    );
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'A source-ID array containing null was accepted.';
  end if;

  v_rejected := false;
  begin
    perform 1
    from public.get_stage1_source_activation_finalizations(
      array[
        '00000000-0000-4000-8000-000000000001'::uuid,
        '00000000-0000-4000-8000-000000000001'::uuid
      ]
    );
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'Duplicate source IDs were accepted.';
  end if;

  select pg_catalog.array_agg(
    (
      '00000000-0000-4000-8000-' ||
      pg_catalog.lpad(member.position::text, 12, '0')
    )::uuid
    order by member.position
  )
  into v_over_limit
  from pg_catalog.generate_series(1, 26) as member(position);

  v_rejected := false;
  begin
    perform 1
    from public.get_stage1_source_activation_finalizations(v_over_limit);
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'More than 25 source IDs were accepted.';
  end if;

  select candidate.source_id
  into v_missing_source_id
  from pg_catalog.unnest(
    array[
      'ffffffff-ffff-4fff-8fff-fffffffffff1'::uuid,
      'ffffffff-ffff-4fff-8fff-fffffffffff2'::uuid,
      'ffffffff-ffff-4fff-8fff-fffffffffff3'::uuid
    ]
  ) as candidate(source_id)
  where not exists (
    select 1
    from private.stage1_source_baseline_activation_finalizations finalized
    where finalized.shared_award_source_id = candidate.source_id
  )
  order by candidate.source_id
  limit 1;

  if v_missing_source_id is null then
    raise exception 'The missing-finalization smoke fixture collided with live data.';
  end if;

  v_rejected := false;
  begin
    perform 1
    from public.get_stage1_source_activation_finalizations(
      array[v_missing_source_id]
    );
  exception when sqlstate 'P0002' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'A requested source without an exact finalization was accepted.';
  end if;

  select
    finalized.shared_award_source_id,
    pg_catalog.to_jsonb(finalized)
  into v_existing_source_id, v_expected
  from private.stage1_source_baseline_activation_finalizations finalized
  order by finalized.shared_award_source_id
  limit 1;

  if v_existing_source_id is not null then
    select pg_catalog.to_jsonb(loaded)
    into strict v_actual
    from public.get_stage1_source_activation_finalizations(
      array[v_existing_source_id]
    ) loaded;

    if v_actual is distinct from v_expected then
      raise exception
        'The Stage 1 finalization getter changed or omitted an immutable receipt field.';
    end if;
  end if;

  select pg_catalog.array_agg(
    selected.shared_award_source_id
    order by selected.shared_award_source_id desc
  )
  into v_requested_source_ids
  from (
    select finalized.shared_award_source_id
    from private.stage1_source_baseline_activation_finalizations finalized
    order by finalized.shared_award_source_id
    limit 2
  ) selected;

  if pg_catalog.cardinality(v_requested_source_ids) = 2 then
    select pg_catalog.array_agg(loaded.shared_award_source_id)
    into v_loaded_source_ids
    from public.get_stage1_source_activation_finalizations(
      v_requested_source_ids
    ) loaded;

    if v_loaded_source_ids is distinct from v_requested_source_ids then
      raise exception
        'The Stage 1 finalization getter did not preserve source-ID input order.';
    end if;
  end if;

  select pg_catalog.count(*)
  into v_after_count
  from private.stage1_source_baseline_activation_finalizations;
  if v_after_count is distinct from v_before_count then
    raise exception 'The read-only Stage 1 finalization smoke changed evidence rows.';
  end if;
end;
$smoke$;

-- Prove the exposed RPC boundary, not merely its catalog ACL. Anonymous and
-- signed-in user roles must be denied before function entry.
set role anon;
do $anon_denied$
declare
  v_denied boolean := false;
begin
  begin
    perform 1
    from public.get_stage1_source_activation_finalizations(null::uuid[]);
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'The anon role invoked the Stage 1 finalization getter.';
  end if;
end;
$anon_denied$;
reset role;

set role authenticated;
do $authenticated_denied$
declare
  v_denied boolean := false;
begin
  begin
    perform 1
    from public.get_stage1_source_activation_finalizations(null::uuid[]);
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception
      'The authenticated role invoked the Stage 1 finalization getter.';
  end if;
end;
$authenticated_denied$;
reset role;

-- A service-role call must enter the function, read through the existing RLS
-- policy, and receive the function's own missing-row error rather than a
-- permission error. When data exists, also prove the exact row round trip.
set role service_role;
do $service_role_allowed$
declare
  v_missing_source_id uuid;
  v_existing_source_id uuid;
  v_reached_private_read boolean := false;
  v_expected jsonb;
  v_actual jsonb;
begin
  select candidate.source_id
  into v_missing_source_id
  from pg_catalog.unnest(
    array[
      'ffffffff-ffff-4fff-8fff-fffffffffff1'::uuid,
      'ffffffff-ffff-4fff-8fff-fffffffffff2'::uuid,
      'ffffffff-ffff-4fff-8fff-fffffffffff3'::uuid
    ]
  ) as candidate(source_id)
  where not exists (
    select 1
    from private.stage1_source_baseline_activation_finalizations finalized
    where finalized.shared_award_source_id = candidate.source_id
  )
  order by candidate.source_id
  limit 1;

  if v_missing_source_id is null then
    raise exception 'The service-role missing-row smoke fixture collided with live data.';
  end if;

  begin
    perform 1
    from public.get_stage1_source_activation_finalizations(
      array[v_missing_source_id]
    );
  exception when sqlstate 'P0002' then
    v_reached_private_read := true;
  end;
  if not v_reached_private_read then
    raise exception
      'The service role did not reach the getter completeness check through RLS.';
  end if;

  select
    finalized.shared_award_source_id,
    pg_catalog.to_jsonb(finalized)
  into v_existing_source_id, v_expected
  from private.stage1_source_baseline_activation_finalizations finalized
  order by finalized.shared_award_source_id
  limit 1;

  if v_existing_source_id is not null then
    select pg_catalog.to_jsonb(loaded)
    into strict v_actual
    from public.get_stage1_source_activation_finalizations(
      array[v_existing_source_id]
    ) loaded;

    if v_actual is distinct from v_expected then
      raise exception
        'The service-role getter round trip changed immutable finalization evidence.';
    end if;
  end if;
end;
$service_role_allowed$;
reset role;
