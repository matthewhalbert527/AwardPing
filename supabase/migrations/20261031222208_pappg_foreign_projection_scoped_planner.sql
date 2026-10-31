-- Scope planner choices to the existing private projection. The exact body,
-- bounds, ordering, authority checks, function identity and ACL remain intact.
-- The indexed ordered lookup otherwise prefers a full toasted-payload PK scan.
do $pappg_scoped_planner$
declare target oid;before_meta jsonb;after_meta jsonb;
begin
 target:=to_regprocedure('private.awardping_pappg_canonical_foreign_projection(uuid)');
 if target is null then raise exception 'Private PAPPG foreign projection is missing.' using errcode='40001';end if;
 select to_jsonb(p) into strict before_meta from pg_catalog.pg_proc p where p.oid=target;
 if encode(extensions.digest(convert_to(before_meta->>'prosrc','UTF8'),'sha256'),'hex') is distinct from '2785e990a5bfed228c96a284e1a448ff0eb7eabe6a8ba3c56687bd115844f735'
  or before_meta->'proconfig' is distinct from to_jsonb(array['search_path=""']::text[])
  or before_meta->>'provolatile' is distinct from 's' or before_meta->'prosecdef' is distinct from 'false'::jsonb
 then raise exception 'Exact private PAPPG projection body or configuration changed.' using errcode='40001';end if;
 execute 'alter function private.awardping_pappg_canonical_foreign_projection(uuid) set enable_seqscan to off';
 execute 'alter function private.awardping_pappg_canonical_foreign_projection(uuid) set enable_indexscan to off';
 execute 'alter function private.awardping_pappg_canonical_foreign_projection(uuid) set jit to off';
 select to_jsonb(p) into strict after_meta from pg_catalog.pg_proc p where p.oid=target;
 if (after_meta-'proconfig') is distinct from (before_meta-'proconfig')
  or after_meta->'proconfig' is distinct from to_jsonb(array['search_path=""','enable_seqscan=off','enable_indexscan=off','jit=off']::text[])
 then raise exception 'PAPPG scoped planner changed body, ACL, identity or unrelated metadata.' using errcode='40001';end if;
end;
$pappg_scoped_planner$;
