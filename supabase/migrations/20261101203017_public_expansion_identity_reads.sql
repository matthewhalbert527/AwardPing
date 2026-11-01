-- Identity-only presentation scope; current facts stay on the existing fresh
-- per-award basic getter. No source/currentness, publication, history or worker
-- change, persistent cache, private helper rewrite or table privilege changes.
do $expansion_identity_preimage$
declare pin record;actual record;
begin
 if to_regprocedure('public.get_program_award_expansion_identities(uuid)') is not null then raise exception 'The additive expansion identity RPC already exists' using errcode='40001';end if;
 for pin in select * from (values
  ('public.get_program_award_expansion_publication(uuid)','25726591364ea39c4de6fc7c4f481113d5e5a7f3344b6543eeaefd13b8762578',true,'{postgres=X/postgres,service_role=X/postgres}'),
  ('public.get_program_basic_facts(uuid[])','9467df8118b1d591a69c2f0d16e1c69f238a6bc7493e586ec279559e710f80f8',true,'{postgres=X/postgres,service_role=X/postgres}'),
  ('private.awardping_reviewed_repeat_proof_valid(jsonb,jsonb,jsonb,uuid)','bbd928b76e2b58bf8d8d7ce82afbeafa5fa50dd099893c00db6c13a36cf328c7',false,'{postgres=X/postgres}')
 ) as pins(signature,definition_sha256,definer,acl) loop
  select p.prosecdef,p.provolatile,p.proconfig,p.proacl,pg_get_userbyid(p.proowner)::text owner_name,
   encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex') definition_sha256
  into strict actual from pg_catalog.pg_proc p where p.oid=to_regprocedure(pin.signature);
  if actual.definition_sha256 is distinct from pin.definition_sha256 or actual.owner_name is distinct from 'postgres'
   or actual.prosecdef is distinct from pin.definer or actual.provolatile::text is distinct from 's'
   or actual.proconfig is distinct from array['search_path=""']::text[] or actual.proacl::text is distinct from pin.acl
  then raise exception 'Existing publication/fact authority changed: %',pin.signature using errcode='40001';end if;
 end loop;

end;$expansion_identity_preimage$;

CREATE FUNCTION public.get_program_award_expansion_identities(p_epoch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
 if p_epoch is null or not exists(select 1 from public.program_text_source_authority_epochs where active and epoch=p_epoch)
 then raise exception 'The current monitoring epoch is required.' using errcode='40001';end if;
 select coalesce(jsonb_agg(jsonb_build_object('registry',to_jsonb(r),
  'members',(select jsonb_agg(to_jsonb(m) order by m.shared_award_id) from public.program_award_members m where m.cohort_key=r.cohort_key),
  'source_ids',a.source_ids,'reviewed_homepage',jsonb_build_object('source_id',
   (select q->>'id' from jsonb_array_elements(a.proof->'sources') q where q->>'url'=r.official_homepage),'url',r.official_homepage))
  order by r.launch_rank),'[]'::jsonb) into result
 from public.program_award_expansion_admissions a join public.program_award_registry r on r.cohort_key=a.cohort_key
 where a.status='active' and a.epoch=p_epoch;
 if jsonb_array_length(result) not in(0,5,10,15,20) then raise exception 'Expansion publication has a partial activated batch.' using errcode='23514';end if;
 return jsonb_build_object('schema','awardping.program-award-expansion-identities.v1','epoch',p_epoch,'awards',result);
end;$function$;
revoke all on function public.get_program_award_expansion_identities(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_program_award_expansion_identities(uuid) to service_role;

do $expansion_identity_postimage$
declare pin record;actual record;
begin

 for pin in select * from (values
  ('public.get_program_award_expansion_publication(uuid)','25726591364ea39c4de6fc7c4f481113d5e5a7f3344b6543eeaefd13b8762578',true,'{postgres=X/postgres,service_role=X/postgres}'),
  ('public.get_program_basic_facts(uuid[])','9467df8118b1d591a69c2f0d16e1c69f238a6bc7493e586ec279559e710f80f8',true,'{postgres=X/postgres,service_role=X/postgres}'),
  ('private.awardping_reviewed_repeat_proof_valid(jsonb,jsonb,jsonb,uuid)','bbd928b76e2b58bf8d8d7ce82afbeafa5fa50dd099893c00db6c13a36cf328c7',false,'{postgres=X/postgres}')
 ) as pins(signature,definition_sha256,definer,acl) loop
  select p.prosecdef,p.provolatile,p.proconfig,p.proacl,pg_get_userbyid(p.proowner)::text owner_name,
   encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex') definition_sha256
  into strict actual from pg_catalog.pg_proc p where p.oid=to_regprocedure(pin.signature);
  if actual.definition_sha256 is distinct from pin.definition_sha256 or actual.owner_name is distinct from 'postgres'
   or actual.prosecdef is distinct from pin.definer or actual.provolatile::text is distinct from 's'
   or actual.proconfig is distinct from array['search_path=""']::text[] or actual.proacl::text is distinct from pin.acl
  then raise exception 'Existing publication/fact authority changed: %',pin.signature using errcode='40001';end if;
 end loop;
 select p.prosecdef,p.provolatile,p.proconfig,p.proacl,pg_get_userbyid(p.proowner)::text owner_name,
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex') definition_sha256 into strict actual
  from pg_catalog.pg_proc p where p.oid='public.get_program_award_expansion_identities(uuid)'::regprocedure;
 if actual.definition_sha256 is distinct from '209d9ff1e43c227f79db6e1eefd314d0375e3f8e78a7b94013a73b980e82025d' or actual.owner_name is distinct from 'postgres'
  or actual.prosecdef is distinct from false or actual.provolatile::text is distinct from 's'
  or actual.proconfig is distinct from array['search_path=""']::text[]
  or actual.proacl::text is distinct from '{postgres=X/postgres,service_role=X/postgres}'
 then raise exception 'Identity-only RPC security or projection changed' using errcode='40001';end if;
end;$expansion_identity_postimage$;
