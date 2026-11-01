-- Statement-local batching only. No persistent cache, publication, source,
-- currentness, authorization, notification or scheduled-worker changes.
do $expansion_read_preimage$
declare pin record;actual record;
begin
 for pin in select * from (values
  ('public.get_program_award_expansion_publication(uuid)','ff775c8b627d5fc503aa5f1e2d8f3952673680fcd90d00dd2930ca7921192e8d','s'),
  ('public.get_program_basic_facts(uuid[])','9467df8118b1d591a69c2f0d16e1c69f238a6bc7493e586ec279559e710f80f8','s'),
  ('public.get_program_text_public_alert_source_bindings(uuid)','698a5f4f623c6462b67a4656153db750e0eb818d5144f10352f9b25148832b80','s'),
  ('public.get_stage1_publication_snapshot()','d00a1071ae47c1a9f1c895761d34f88ccb2d3aeac03dd15e24bd945e674ef4a5','v')
 ) as pins(signature,definition_sha256,volatility) loop
  select p.prosecdef,p.provolatile,p.proconfig,p.proacl,pg_catalog.pg_get_userbyid(p.proowner)::text owner_name,
   encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex') definition_sha256
  into strict actual from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure(pin.signature);
  if actual.definition_sha256 is distinct from pin.definition_sha256 or actual.owner_name is distinct from 'postgres'
   or actual.prosecdef is distinct from true or actual.provolatile::text is distinct from pin.volatility
   or actual.proconfig is distinct from array['search_path=""']::text[]
   or to_jsonb(actual.proacl) is distinct from '["postgres=X/postgres","service_role=X/postgres"]'::jsonb
  then raise exception 'Publication read preimage changed: %',pin.signature using errcode='40001';end if;
 end loop;
end;$expansion_read_preimage$;

CREATE OR REPLACE FUNCTION public.get_program_award_expansion_publication(p_epoch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
 if p_epoch is null or not exists(select 1 from public.program_text_source_authority_epochs where active and epoch=p_epoch)
 then raise exception 'The current monitoring epoch is required.' using errcode='40001';end if;
 with active_awards as materialized (
  select r as registry,a.source_ids,a.proof
  from public.program_award_expansion_admissions a
  join public.program_award_registry r on r.cohort_key=a.cohort_key
  where a.status='active' and a.epoch=p_epoch
 ), basic_snapshot as materialized (
  select public.get_program_basic_facts(array(
   select distinct (selected.registry).canonical_shared_award_id
   from active_awards selected order by (selected.registry).canonical_shared_award_id
  )) as facts
  where exists(select 1 from active_awards)
 )
 select coalesce(jsonb_agg(jsonb_build_object('registry',to_jsonb(selected.registry),
  'members',(select jsonb_agg(to_jsonb(m) order by m.shared_award_id) from public.program_award_members m where m.cohort_key=(selected.registry).cohort_key),
  'source_ids',selected.source_ids,'reviewed_homepage',jsonb_build_object('source_id',
   (select q->>'id' from jsonb_array_elements(selected.proof->'sources') q where q->>'url'=(selected.registry).official_homepage),
   'url',(selected.registry).official_homepage),
  'basic_fact',(select value from jsonb_array_elements(basics.facts)
   where value->>'cohort_key'=(selected.registry).cohort_key
    and value->>'award_id'=(selected.registry).canonical_shared_award_id::text))
  order by (selected.registry).launch_rank),'[]'::jsonb) into result
 from active_awards selected cross join basic_snapshot basics;
 if jsonb_array_length(result) not in(0,5,10,15,20) then raise exception 'Expansion publication has a partial activated batch.' using errcode='23514';end if;
 return jsonb_build_object('schema','awardping.program-award-expansion-publication.v1','epoch',p_epoch,'awards',result);
end;$function$;

do $expansion_read_postimage$
declare pin record;actual record;
begin
 for pin in select * from (values
  ('public.get_program_award_expansion_publication(uuid)','25726591364ea39c4de6fc7c4f481113d5e5a7f3344b6543eeaefd13b8762578','s'),
  ('public.get_program_basic_facts(uuid[])','9467df8118b1d591a69c2f0d16e1c69f238a6bc7493e586ec279559e710f80f8','s'),
  ('public.get_program_text_public_alert_source_bindings(uuid)','698a5f4f623c6462b67a4656153db750e0eb818d5144f10352f9b25148832b80','s'),
  ('public.get_stage1_publication_snapshot()','d00a1071ae47c1a9f1c895761d34f88ccb2d3aeac03dd15e24bd945e674ef4a5','v')
 ) as pins(signature,definition_sha256,volatility) loop
  select p.prosecdef,p.provolatile,p.proconfig,p.proacl,pg_catalog.pg_get_userbyid(p.proowner)::text owner_name,
   encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex') definition_sha256
  into strict actual from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure(pin.signature);
  if actual.definition_sha256 is distinct from pin.definition_sha256 or actual.owner_name is distinct from 'postgres'
   or actual.prosecdef is distinct from true or actual.provolatile::text is distinct from pin.volatility
   or actual.proconfig is distinct from array['search_path=""']::text[]
   or to_jsonb(actual.proacl) is distinct from '["postgres=X/postgres","service_role=X/postgres"]'::jsonb
  then raise exception 'Publication read postimage changed: %',pin.signature using errcode='40001';end if;
 end loop;
end;$expansion_read_postimage$;
