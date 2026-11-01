-- Detach one already-verified immutable JSON value for repeated support reads.
-- Assignment is local to the fetched record; no stored row, seal, authority,
-- admission rule, dispatch, privilege, cache or public projection changes.
do $reviewed_proof_read_preimage$
declare pin record;actual record;
begin
 for pin in select * from (values
  ('private.awardping_basic_fact_current(uuid)','14cb00619fd34612ceb6d0b5b79dff8ae0979ccae6693903030c3d7582881871','s'),
  ('private.awardping_current_basic_fact_current(uuid)','e330f3507e260ca734806c166f48a59d4821cbfbf370338919b6ed6634707c23','s'),
  ('private.awardping_reviewed_repeat_proof_valid(jsonb,jsonb,jsonb,uuid)','478f7896d102d213eca8379b87c48c82bcb5db2a9ffb33bf36458dda22a0c32a','s'),
  ('private.awardping_reviewed_repeat_read_policy_current()','0ebbf903760b46b98ab96d31302e7f66a87d3b2710c8cbed25ead179e4ed769c','s'),
  ('private.awardping_reviewed_repeat_row_current(uuid)','8358f9e50fd8c3d9aac24c07be93a8178d50c8ee6ca8f3f4dd55aac626d5d73e','s'),
  ('private.awardping_reviewed_repeat_support(jsonb,uuid,jsonb)','8e69896d73bfb50374b8e70f0ebe8ad074aa8f143bb98474a020ef586ad87c52','i'),
  ('private.awardping_reviewed_repeat_version_valid(uuid,jsonb)','bf4a85b6d1c278a3c0be887bd78d67010f017abf77bf866d54de09747f5eba81','s')
 ) as pins(signature,definition_sha256,volatility) loop
  select p.prosecdef,p.provolatile,p.proconfig,p.proacl,pg_get_userbyid(p.proowner)::text owner_name,
   encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex') definition_sha256
  into strict actual from pg_catalog.pg_proc p where p.oid=to_regprocedure(pin.signature);
  if actual.definition_sha256 is distinct from pin.definition_sha256 or actual.owner_name is distinct from 'postgres'
   or actual.prosecdef is distinct from false or actual.provolatile::text is distinct from pin.volatility
   or actual.proconfig is distinct from array['search_path=""']::text[] or actual.proacl::text is distinct from '{postgres=X/postgres}'
  then raise exception 'Reviewed-proof read preimage changed: %',pin.signature using errcode='40001';end if;
 end loop;
 if encode(extensions.digest(convert_to(pg_get_functiondef('public.get_program_basic_facts(uuid[])'::regprocedure),'UTF8'),'sha256'),'hex')
  is distinct from '9467df8118b1d591a69c2f0d16e1c69f238a6bc7493e586ec279559e710f80f8'
 then raise exception 'The original once-per-head basic getter changed' using errcode='40001';end if;
end;$reviewed_proof_read_preimage$;

CREATE OR REPLACE FUNCTION private.awardping_reviewed_repeat_proof_valid(v_review jsonb, p_proof jsonb, p_ref jsonb, p_parent uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare o public.program_basic_reviewed_repeat_observations%rowtype;h uuid;head_ok boolean:=false;projection jsonb;
begin
 if private.awardping_program_exact_object(p_proof,array['source_id','repeat_observation_id','pending_alert_review_id','pending_alert_review_hash','kind','reviewed_repeat_observation_id','reviewed_repeat_hash']) is distinct from true
  or p_proof->>'kind' is distinct from 'reviewed_no_program_change' or p_proof->'repeat_observation_id' is distinct from 'null'::jsonb
  or p_proof->'pending_alert_review_id' is distinct from 'null'::jsonb or p_proof->'pending_alert_review_hash' is distinct from 'null'::jsonb
 then return false;end if;
 select * into strict o from public.program_basic_reviewed_repeat_observations where id=(p_proof->>'reviewed_repeat_observation_id')::uuid;
 if o.source_id::text is distinct from p_proof->>'source_id' or o.source_id::text is distinct from p_ref#>>'{source,id}'
  or o.cohort_key is distinct from v_review->>'cohort_key' or o.epoch::text is distinct from v_review->>'epoch'
  or o.content_hash is distinct from p_proof->>'reviewed_repeat_hash' or o.current_ref is distinct from p_ref
  or private.awardping_reviewed_repeat_row_current(o.id) is distinct from true then return false;end if;
 if p_parent is not null then head_ok:=o.expected_head=p_parent;else
  select snapshot_id into h from public.program_basic_fact_heads where cohort_key=o.cohort_key;
  head_ok:=o.expected_head=h or exists(select 1 from public.program_basic_fact_snapshots x join public.program_text_fact_reviews d on d.id=x.input_review_id
   where x.id=h and x.previous_snapshot_id=o.expected_head and d.content_hash=x.input_review_hash
    and d.content_hash=encode(extensions.digest(convert_to(d.validation::text,'UTF8'),'sha256'),'hex')
    and d.validation->'review'=v_review and (x.receipt->'current_source_proofs') @> jsonb_build_array(p_proof));
 end if;
 if head_ok is distinct from true then return false;end if;
 o.validation := (o.validation::text)::jsonb;
 projection:=private.awardping_reviewed_repeat_support(v_review,o.source_id,o.validation);
 return projection is not null and projection=o.validation->'support_projection' and private.awardping_reviewed_repeat_hash(projection)=o.support_hash;
exception when others then return false;end;$function$;

do $reviewed_proof_read_postimage$
declare pin record;actual record;
begin
 for pin in select * from (values
  ('private.awardping_basic_fact_current(uuid)','14cb00619fd34612ceb6d0b5b79dff8ae0979ccae6693903030c3d7582881871','s'),
  ('private.awardping_current_basic_fact_current(uuid)','e330f3507e260ca734806c166f48a59d4821cbfbf370338919b6ed6634707c23','s'),
  ('private.awardping_reviewed_repeat_proof_valid(jsonb,jsonb,jsonb,uuid)','bbd928b76e2b58bf8d8d7ce82afbeafa5fa50dd099893c00db6c13a36cf328c7','s'),
  ('private.awardping_reviewed_repeat_read_policy_current()','0ebbf903760b46b98ab96d31302e7f66a87d3b2710c8cbed25ead179e4ed769c','s'),
  ('private.awardping_reviewed_repeat_row_current(uuid)','8358f9e50fd8c3d9aac24c07be93a8178d50c8ee6ca8f3f4dd55aac626d5d73e','s'),
  ('private.awardping_reviewed_repeat_support(jsonb,uuid,jsonb)','8e69896d73bfb50374b8e70f0ebe8ad074aa8f143bb98474a020ef586ad87c52','i'),
  ('private.awardping_reviewed_repeat_version_valid(uuid,jsonb)','bf4a85b6d1c278a3c0be887bd78d67010f017abf77bf866d54de09747f5eba81','s')
 ) as pins(signature,definition_sha256,volatility) loop
  select p.prosecdef,p.provolatile,p.proconfig,p.proacl,pg_get_userbyid(p.proowner)::text owner_name,
   encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex') definition_sha256
  into strict actual from pg_catalog.pg_proc p where p.oid=to_regprocedure(pin.signature);
  if actual.definition_sha256 is distinct from pin.definition_sha256 or actual.owner_name is distinct from 'postgres'
   or actual.prosecdef is distinct from false or actual.provolatile::text is distinct from pin.volatility
   or actual.proconfig is distinct from array['search_path=""']::text[] or actual.proacl::text is distinct from '{postgres=X/postgres}'
  then raise exception 'Reviewed-proof read postimage changed: %',pin.signature using errcode='40001';end if;
 end loop;
 if encode(extensions.digest(convert_to(pg_get_functiondef('public.get_program_basic_facts(uuid[])'::regprocedure),'UTF8'),'sha256'),'hex')
  is distinct from '9467df8118b1d591a69c2f0d16e1c69f238a6bc7493e586ec279559e710f80f8'
 then raise exception 'The original once-per-head basic getter changed' using errcode='40001';end if;
end;$reviewed_proof_read_postimage$;
