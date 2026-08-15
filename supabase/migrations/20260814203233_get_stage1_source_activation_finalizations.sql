-- Expose the immutable Stage 1 activation finalization receipts to the local
-- service-role worker without exposing the private evidence table itself.
-- The private table already grants SELECT to service_role under an explicit
-- read policy, so this RPC remains SECURITY INVOKER.

create or replace function public.get_stage1_source_activation_finalizations(
  p_source_ids uuid[]
)
returns table (
  source_acquisition_id uuid,
  shared_award_source_id uuid,
  source_page_request_id uuid,
  disposition_item_sha256 text,
  prepare_receipt_sha256 text,
  guard_sha256 text,
  observed_normalized_text_sha256 text,
  persistence_evidence jsonb,
  finalization_receipt_sha256 text,
  receipt jsonb,
  finalized_at timestamptz
)
language plpgsql
stable
parallel safe
security invoker
set search_path = ''
as $$
declare
  v_requested_count integer;
  v_distinct_count integer;
  v_matched_count integer;
begin
  v_requested_count := pg_catalog.cardinality(p_source_ids);

  if p_source_ids is null
    or v_requested_count not between 1 and 25
    or pg_catalog.array_ndims(p_source_ids) is distinct from 1
    or pg_catalog.array_lower(p_source_ids, 1) is distinct from 1
    or exists (
      select 1
      from pg_catalog.unnest(p_source_ids) as requested(source_id)
      where requested.source_id is null
    )
  then
    raise exception using
      errcode = '22023',
      message = 'Stage 1 finalization lookup requires 1 to 25 non-null source UUIDs in a one-dimensional array.';
  end if;

  select pg_catalog.count(distinct requested.source_id)::integer
  into v_distinct_count
  from pg_catalog.unnest(p_source_ids) as requested(source_id);

  if v_distinct_count <> v_requested_count then
    raise exception using
      errcode = '22023',
      message = 'Stage 1 finalization lookup source UUIDs must be unique.';
  end if;

  select pg_catalog.count(*)::integer
  into v_matched_count
  from pg_catalog.unnest(p_source_ids) as requested(source_id)
  join private.stage1_source_baseline_activation_finalizations finalized
    on finalized.shared_award_source_id = requested.source_id;

  if v_matched_count <> v_requested_count then
    raise exception using
      errcode = 'P0002',
      message = 'An exact immutable Stage 1 activation finalization is required for every requested source.';
  end if;

  return query
  select
    finalized.source_acquisition_id,
    finalized.shared_award_source_id,
    finalized.source_page_request_id,
    finalized.disposition_item_sha256,
    finalized.prepare_receipt_sha256,
    finalized.guard_sha256,
    finalized.observed_normalized_text_sha256,
    finalized.persistence_evidence,
    finalized.finalization_receipt_sha256,
    finalized.receipt,
    finalized.finalized_at
  from pg_catalog.unnest(p_source_ids) with ordinality
    as requested(source_id, requested_ordinality)
  join private.stage1_source_baseline_activation_finalizations finalized
    on finalized.shared_award_source_id = requested.source_id
  order by requested.requested_ordinality;
end;
$$;

alter function public.get_stage1_source_activation_finalizations(uuid[])
  owner to postgres;

revoke all on function public.get_stage1_source_activation_finalizations(uuid[])
from public, anon, authenticated, service_role;
grant execute on function public.get_stage1_source_activation_finalizations(uuid[])
to service_role;

comment on function public.get_stage1_source_activation_finalizations(uuid[])
is 'Returns the exact immutable Stage 1 activation finalization receipt for each member of a strict service-role source-ID set, preserving input order.';

do $catalog_assertions$
declare
  v_function_oid oid := pg_catalog.to_regprocedure(
    'public.get_stage1_source_activation_finalizations(uuid[])'
  );
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
begin
  if v_function_oid is null
    or v_service_role_oid is null
    or not exists (
      select 1
      from pg_catalog.pg_proc target
      where target.oid = v_function_oid
        and pg_catalog.pg_get_userbyid(target.proowner) = 'postgres'
        and target.prokind = 'f'
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
        and exists (
          select 1
          from pg_catalog.aclexplode(
            coalesce(
              target.proacl,
              pg_catalog.acldefault('f', target.proowner)
            )
          ) privilege
          where privilege.grantee = v_service_role_oid
            and privilege.privilege_type = 'EXECUTE'
            and not privilege.is_grantable
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
    raise exception using
      errcode = '55000',
      message = 'Stage 1 finalization getter owner, volatility, search path, or execution ACL is unsafe.';
  end if;
end;
$catalog_assertions$;
