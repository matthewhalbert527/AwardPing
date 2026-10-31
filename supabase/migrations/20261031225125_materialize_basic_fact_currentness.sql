-- Evaluate the unchanged basic-fact currentness guard once per selected head.
-- MATERIALIZED is statement-local evaluation only: no persistent cache, changed
-- authority decision, fact publication, notification, RLS or permission change.
do $basic_currentness_preimage$ begin
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_basic_fact_current(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') is distinct from '14cb00619fd34612ceb6d0b5b79dff8ae0979ccae6693903030c3d7582881871' then raise exception 'Basic-currentness preimage changed: private.awardping_basic_fact_current' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('public.get_program_basic_facts(uuid[])'::regprocedure),'UTF8'),'sha256'),'hex') is distinct from 'c76fed1fe86c2e5aae992d0f876fdb21aeae2bf0c1a163eed86a376f040e75b7' then raise exception 'Basic-currentness preimage changed: public.get_program_basic_facts' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_current_basic_fact_current(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') is distinct from 'd130ce8def118e6297b13b578cbf048641a290e579a68f22caf17c28888c053d' then raise exception 'Basic-currentness preimage changed: private.awardping_current_basic_fact_current' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_basic_fact_current_v1(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') is distinct from 'd22a3d6a24d6a1d991dd3dc459163f7555625db4e446fcc6a34e1a25fded1360' then raise exception 'Basic-currentness preimage changed: private.awardping_basic_fact_current_v1' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_program_source_allowed(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') is distinct from '283f9e68cf4ebe0e5518765ecb9df9be0b4dde00d7ac70a44e9f5377d5aac1b2' then raise exception 'Basic-currentness preimage changed: private.awardping_program_source_allowed' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc where oid='public.get_program_basic_facts(uuid[])'::regprocedure and prosecdef and provolatile='s' and proconfig=array['search_path=""']::text[] and proacl::text='{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Basic-facts RPC security attributes changed.' using errcode='40001';end if;
end;$basic_currentness_preimage$;

CREATE OR REPLACE FUNCTION public.get_program_basic_facts(p_award_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if p_award_ids is null or cardinality(p_award_ids)>100 or exists(select 1 from unnest(p_award_ids) id where id is null)
  or cardinality(p_award_ids)<>(select count(distinct id) from unnest(p_award_ids) id) then raise exception 'Choose at most100 distinct awards.' using errcode='23514';end if;
 return coalesce((with scoped_current as materialized (
   select s.award_id,s.cohort_key,s.id,s.kind,s.public_facts,s.receipt->'reviewed_at' as verified_at,
    private.awardping_basic_fact_current(s.id) as current
   from public.program_basic_fact_heads h join public.program_basic_fact_snapshots s on s.id=h.snapshot_id
   where s.award_id=any(p_award_ids)
  )
  select jsonb_agg(jsonb_build_object('award_id',s.award_id,'cohort_key',s.cohort_key,'snapshot_id',s.id,'kind',s.kind,'current',s.current,
   'public_facts',case when s.current then s.public_facts else 'null'::jsonb end,'verified_at',s.verified_at) order by s.cohort_key)
  from scoped_current s),'[]'::jsonb);
end;$function$;

do $basic_currentness_postimage$ begin
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_basic_fact_current(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') is distinct from '14cb00619fd34612ceb6d0b5b79dff8ae0979ccae6693903030c3d7582881871' then raise exception 'Basic-currentness preimage changed: private.awardping_basic_fact_current' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_current_basic_fact_current(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') is distinct from 'd130ce8def118e6297b13b578cbf048641a290e579a68f22caf17c28888c053d' then raise exception 'Basic-currentness preimage changed: private.awardping_current_basic_fact_current' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_basic_fact_current_v1(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') is distinct from 'd22a3d6a24d6a1d991dd3dc459163f7555625db4e446fcc6a34e1a25fded1360' then raise exception 'Basic-currentness preimage changed: private.awardping_basic_fact_current_v1' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_program_source_allowed(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') is distinct from '283f9e68cf4ebe0e5518765ecb9df9be0b4dde00d7ac70a44e9f5377d5aac1b2' then raise exception 'Basic-currentness preimage changed: private.awardping_program_source_allowed' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc where oid='public.get_program_basic_facts(uuid[])'::regprocedure and prosecdef and provolatile='s' and proconfig=array['search_path=""']::text[] and proacl::text='{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Basic-facts RPC security attributes changed.' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('public.get_program_basic_facts(uuid[])'::regprocedure),'UTF8'),'sha256'),'hex') is distinct from '9467df8118b1d591a69c2f0d16e1c69f238a6bc7493e586ec279559e710f80f8' then raise exception 'Basic-facts optimized postimage differs.' using errcode='40001';end if;
end;$basic_currentness_postimage$;
