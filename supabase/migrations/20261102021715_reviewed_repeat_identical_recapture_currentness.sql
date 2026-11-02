-- Keep a sealed reviewed no-change proof current after a newer byte-identical
-- observation. Admission, source authority/quality, support, candidate/paid rows,
-- original facts and their verification date remain unchanged.

DO $reviewed_recapture_preimage$
DECLARE actual record;
BEGIN
 SELECT p.prosecdef,p.provolatile,p.proconfig,p.proacl,pg_get_userbyid(p.proowner)::text AS owner_name,
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex') AS definition_sha256
 INTO STRICT actual FROM pg_catalog.pg_proc p
 WHERE p.oid=to_regprocedure('private.awardping_reviewed_repeat_row_current(uuid)');
 IF actual.definition_sha256 IS DISTINCT FROM '8358f9e50fd8c3d9aac24c07be93a8178d50c8ee6ca8f3f4dd55aac626d5d73e'
  OR actual.owner_name IS DISTINCT FROM 'postgres' OR actual.prosecdef IS DISTINCT FROM false
  OR actual.provolatile::text IS DISTINCT FROM 's' OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
  OR actual.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
 THEN RAISE EXCEPTION 'Reviewed-repeat currentness preimage changed' USING ERRCODE='40001';END IF;
END;
$reviewed_recapture_preimage$;

CREATE OR REPLACE FUNCTION private.awardping_reviewed_repeat_row_current(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare o public.program_basic_reviewed_repeat_observations%rowtype;s public.shared_award_sources%rowtype;sealed_text text;v jsonb;latest jsonb;
begin
 select * into strict o from public.program_basic_reviewed_repeat_observations where id=p_id;
 sealed_text:=o.validation::text;
 if o.content_hash is distinct from encode(extensions.digest(convert_to(sealed_text,'UTF8'),'sha256'),'hex')
  or private.awardping_reviewed_repeat_read_policy_current() is distinct from true then return false;end if;
 -- Parsing the already sealed text once avoids repeated large TOAST reads.
 v:=sealed_text::jsonb;
 select * into strict s from public.shared_award_sources where id=o.source_id;
 latest:=s.text_monitoring_state->'latest_ref';
 return coalesce(o.kind='reviewed_no_program_change' and v->>'kind'=o.kind
  and o.current_ref=v#>'{current_document,reference}' and o.repeat_ref=v#>'{repeat_document,reference}'
  and o.candidate_id::text=v->>'candidate_id' and o.candidate_hash=v->>'candidate_hash' and o.support_hash=v->>'support_hash'
  and o.epoch::text=v->>'epoch' and o.expected_head::text=v->>'expected_head' and o.source_id::text=v->>'source_id'
  and o.cohort_key=v->>'cohort_key' and o.verified_at=(v->>'verified_at')::timestamptz
  and s.text_monitoring_state->>'status'='baseline_ready'
  and private.awardping_current_basic_source_ready(s.id,o.cohort_key,o.epoch,latest)
  and (latest=o.current_ref or (
   private.awardping_basic_content_identity(latest)=private.awardping_basic_content_identity(o.current_ref)
   and latest#>>'{artifacts,raw,sha256}'=o.current_ref#>>'{artifacts,raw,sha256}'
   and latest#>'{artifacts,raw,byte_length}'=o.current_ref#>'{artifacts,raw,byte_length}'
   and (latest->>'captured_at')::timestamptz>=(o.current_ref->>'captured_at')::timestamptz))
  and (v->'candidate'=private.awardping_reviewed_repeat_candidate(o.candidate_id)
   and v->'paid_reservation'=private.awardping_reviewed_repeat_paid(v->'candidate')),false);
exception when others then return false;end;$function$;

DO $reviewed_recapture_postimage$
DECLARE actual record;
BEGIN
 SELECT p.prosecdef,p.provolatile,p.proconfig,p.proacl,pg_get_userbyid(p.proowner)::text AS owner_name,
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex') AS definition_sha256
 INTO STRICT actual FROM pg_catalog.pg_proc p
 WHERE p.oid=to_regprocedure('private.awardping_reviewed_repeat_row_current(uuid)');
 IF actual.definition_sha256 IS DISTINCT FROM '34f076d87c55822b16337b8d83f3e83ef86adc9a58e2c9c73e89d7c7f1ee9f4d'
  OR actual.owner_name IS DISTINCT FROM 'postgres' OR actual.prosecdef IS DISTINCT FROM false
  OR actual.provolatile::text IS DISTINCT FROM 's' OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
  OR actual.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
 THEN RAISE EXCEPTION 'Reviewed-repeat currentness postimage differs' USING ERRCODE='40001';END IF;
END;
$reviewed_recapture_postimage$;
