-- GREATEST and LEAST are PostgreSQL conditional expressions, not ordinary
-- pg_catalog functions. Repair the already-deployed service-only failure RPC
-- in place, while failing closed unless its exact broken expression is found
-- once in the expected function definition.

do $migration$
declare
  v_signature constant regprocedure :=
    'public.fail_stage1_source_baseline_activation(uuid,uuid,uuid,text,jsonb)'::regprocedure;
  v_broken constant text :=
    'pg_catalog.greatest(source.consecutive_failures, 1)';
  v_repaired constant text :=
    'greatest(source.consecutive_failures, 1)';
  v_definition text;
  v_updated text;
begin
  select pg_catalog.pg_get_functiondef(v_signature::oid)
  into strict v_definition;

  if pg_catalog.strpos(v_definition, v_broken) = 0
    or pg_catalog.strpos(
      pg_catalog.substr(
        v_definition,
        pg_catalog.strpos(v_definition, v_broken) + pg_catalog.length(v_broken)
      ),
      v_broken
    ) > 0
  then
    raise exception using errcode = '55000',
      message = 'Stage 1 activation failure RPC does not contain exactly one expected broken GREATEST expression.';
  end if;

  v_updated := pg_catalog.replace(v_definition, v_broken, v_repaired);
  if v_updated = v_definition
    or pg_catalog.strpos(v_updated, v_broken) > 0
  then
    raise exception using errcode = '55000',
      message = 'Stage 1 activation failure RPC GREATEST repair did not apply exactly.';
  end if;

  execute v_updated;
end;
$migration$;

revoke all on function public.fail_stage1_source_baseline_activation(
  uuid, uuid, uuid, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.fail_stage1_source_baseline_activation(
  uuid, uuid, uuid, text, jsonb
) to service_role;

comment on function public.fail_stage1_source_baseline_activation(
  uuid, uuid, uuid, text, jsonb
) is 'Persists immutable Stage 1 activation failure proof, re-holds the source even after uncertain finalization, and opens one durable zero-charge operator quarantine. Failure counter clamping uses PostgreSQL GREATEST syntax.';
