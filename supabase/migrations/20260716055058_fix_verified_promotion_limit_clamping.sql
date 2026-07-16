-- PostgreSQL parses unqualified LEAST/GREATEST as special SQL expressions.
-- Schema-qualifying them instead performs a normal function lookup, but no
-- pg_catalog.least/pg_catalog.greatest functions exist. The promotion workflow
-- migration therefore installed three SECURITY DEFINER functions that compile
-- lazily and fail when the affected statements execute.
--
-- Patch the exact deployed definitions in place so this forward migration does
-- not duplicate large, security-sensitive function bodies or overwrite any
-- intervening production changes. Expected occurrence counts make the repair
-- fail closed if those definitions no longer have the reviewed shape.
do $migration$
declare
  v_signatures constant text[] := array[
    'public.list_monitoring_feedback_promotion_clusters(integer,boolean)',
    'public.list_monitoring_feedback_promotion_worker_queue(integer)',
    'public.checkpoint_monitoring_feedback_promotion_sweep(uuid,bigint,text,text,text,timestamptz,uuid,bigint,timestamptz,timestamptz)'
  ];
  v_expected_least constant integer[] := array[1, 1, 0];
  v_expected_greatest constant integer[] := array[1, 1, 1];
  v_qualified_least constant text := 'pg_catalog.least(';
  v_qualified_greatest constant text := 'pg_catalog.greatest(';
  v_unqualified_conflict_target constant text := 'on conflict (cluster_id)';
  v_qualified_conflict_target constant text :=
    'on conflict on constraint monitoring_feedback_promotion_worker_leases_pkey';
  v_unqualified_returning constant text := 'returning cluster_id';
  v_qualified_returning constant text := 'returning lease.cluster_id';
  v_index integer;
  v_function_oid oid;
  v_definition text;
  v_patched_definition text;
  v_least_count integer;
  v_greatest_count integer;
  v_security_definer boolean;
  v_config text[];
begin
  for v_index in 1..pg_catalog.array_length(v_signatures, 1) loop
    v_function_oid := pg_catalog.to_regprocedure(v_signatures[v_index]);

    if v_function_oid is null then
      raise exception 'required promotion function is missing: %',
        v_signatures[v_index]
        using errcode = '42883';
    end if;

    select
      pg_catalog.pg_get_functiondef(procedure.oid),
      procedure.prosecdef,
      procedure.proconfig
    into
      v_definition,
      v_security_definer,
      v_config
    from pg_catalog.pg_proc procedure
    where procedure.oid = v_function_oid;

    if not v_security_definer
      or not coalesce('search_path=""' = any(v_config), false) then
      raise exception 'promotion function security contract changed: %',
        v_signatures[v_index]
        using errcode = '55000';
    end if;

    v_least_count := (
      pg_catalog.char_length(v_definition)
      - pg_catalog.char_length(
        pg_catalog.replace(v_definition, v_qualified_least, '')
      )
    ) / pg_catalog.char_length(v_qualified_least);
    v_greatest_count := (
      pg_catalog.char_length(v_definition)
      - pg_catalog.char_length(
        pg_catalog.replace(v_definition, v_qualified_greatest, '')
      )
    ) / pg_catalog.char_length(v_qualified_greatest);

    if v_least_count is distinct from v_expected_least[v_index]
      or v_greatest_count is distinct from v_expected_greatest[v_index] then
      raise exception
        'promotion clamp repair shape changed for % (least %, greatest %)',
        v_signatures[v_index],
        v_least_count,
        v_greatest_count
        using errcode = '55000';
    end if;

    v_patched_definition := pg_catalog.replace(
      pg_catalog.replace(v_definition, v_qualified_least, 'least('),
      v_qualified_greatest,
      'greatest('
    );

    -- The worker queue's table column shares the RETURNS TABLE output name.
    -- Once the invalid clamp is fixed, PL/pgSQL reaches and rejects those two
    -- unqualified references as ambiguous. Bind both to the reviewed table.
    if v_index = 2 then
      if (
        pg_catalog.char_length(v_patched_definition)
        - pg_catalog.char_length(
          pg_catalog.replace(
            v_patched_definition,
            v_unqualified_conflict_target,
            ''
          )
        )
      ) / pg_catalog.char_length(v_unqualified_conflict_target) is distinct from 1
        or (
          pg_catalog.char_length(v_patched_definition)
          - pg_catalog.char_length(
            pg_catalog.replace(
              v_patched_definition,
              v_unqualified_returning,
              ''
            )
          )
        ) / pg_catalog.char_length(v_unqualified_returning) is distinct from 1 then
        raise exception 'promotion worker lease qualification shape changed'
          using errcode = '55000';
      end if;

      v_patched_definition := pg_catalog.replace(
        pg_catalog.replace(
          v_patched_definition,
          v_unqualified_conflict_target,
          v_qualified_conflict_target
        ),
        v_unqualified_returning,
        v_qualified_returning
      );
    end if;

    if pg_catalog.strpos(v_patched_definition, v_qualified_least) > 0
      or pg_catalog.strpos(v_patched_definition, v_qualified_greatest) > 0 then
      raise exception 'promotion clamp repair was incomplete for %',
        v_signatures[v_index]
        using errcode = '55000';
    end if;

    execute v_patched_definition;
  end loop;
end;
$migration$;

-- CREATE OR REPLACE retains ACLs, but reassert the least-privilege contract for
-- these SECURITY DEFINER entry points so the migration remains reviewable.
revoke execute on function public.list_monitoring_feedback_promotion_clusters(integer, boolean)
  from public, anon, authenticated;
grant execute on function public.list_monitoring_feedback_promotion_clusters(integer, boolean)
  to service_role;

revoke execute on function public.list_monitoring_feedback_promotion_worker_queue(integer)
  from public, anon, authenticated;
grant execute on function public.list_monitoring_feedback_promotion_worker_queue(integer)
  to service_role;

revoke execute on function public.checkpoint_monitoring_feedback_promotion_sweep(
  uuid,
  bigint,
  text,
  text,
  text,
  timestamptz,
  uuid,
  bigint,
  timestamptz,
  timestamptz
) from public, anon, authenticated;
grant execute on function public.checkpoint_monitoring_feedback_promotion_sweep(
  uuid,
  bigint,
  text,
  text,
  text,
  timestamptz,
  uuid,
  bigint,
  timestamptz,
  timestamptz
) to service_role;
