-- Preserve full admission validation. Reuse only immutable, SHA-sealed pure
-- invariants at read time while rechecking exact live dependencies and policy.
-- Read-only policy closure of the admission checks folded below. Missing or
-- changed helpers fail closed until a separately reviewed policy update.
create function private.awardping_reviewed_repeat_read_policy_current() returns boolean
language sql stable set search_path='' as $reviewed_read_policy$
 select coalesce(count(*)=8 and bool_and(coalesce(pg_catalog.pg_get_userbyid(p.proowner)=e->>'owner_name'
  and to_jsonb(p.proacl) is not distinct from e->'acl'
  and encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')=e->>'definition_sha256',false)),false)
 from jsonb_array_elements('[{"signature":"private.awardping_reviewed_repeat_candidate_valid(jsonb)","acl":["postgres=X/postgres"],"definition_sha256":"222d2419edf0f4e8f8159f1905968f7d6f4c7f57a8e4f90c1c0065b696566041","owner_name":"postgres"},{"signature":"private.awardping_reviewed_repeat_candidate(uuid)","acl":["postgres=X/postgres"],"definition_sha256":"0157501dec68d0aaf0327db2c07b9a2e381d9e8d9e5e36b64dc03ea85f3ad5f6","owner_name":"postgres"},{"signature":"private.awardping_reviewed_repeat_paid(jsonb)","acl":["postgres=X/postgres"],"definition_sha256":"bb59a12601173ed27b32e3745117d09bb53d89d7b56ae46e0bf45cd511dbbbc3","owner_name":"postgres"},{"signature":"private.awardping_reviewed_repeat_hash(jsonb)","acl":["postgres=X/postgres"],"definition_sha256":"24f5bfa25bef0c58f87890a8fe0cfaed450ae55270422ec08264e59cd906454b","owner_name":"postgres"},{"signature":"private.awardping_reviewed_repeat_comparison_ref(jsonb)","acl":["postgres=X/postgres"],"definition_sha256":"c325326a9d8aa96b31c4a804258744603b81118a7da23c0057de9076dde29490","owner_name":"postgres"},{"signature":"private.monitoring_feedback_canonical_json(jsonb)","acl":["postgres=X/postgres"],"definition_sha256":"d06f63d374ccac9be773c82eec662dcf7e4e4a1d5c3b54ba6e5bfde51c09d067","owner_name":"postgres"},{"signature":"private.awardping_program_exact_object(jsonb,text[])","acl":["postgres=X/postgres","service_role=X/postgres"],"definition_sha256":"10b6bfa76a42d2a3e37d10a4c8a83420f10a6f278cec58f02b23b673c83c8681","owner_name":"postgres"},{"signature":"private.awardping_reviewed_repeat_validation_valid(jsonb)","acl":["postgres=X/postgres"],"definition_sha256":"f8366225310efa97ce0562dc3d692c9e895899eb0f449bdcefa05d2dc0fe7d7b","owner_name":"postgres"}]'::jsonb) e
 left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(e->>'signature');
$reviewed_read_policy$;
revoke all on function private.awardping_reviewed_repeat_read_policy_current() from public,anon,authenticated,service_role;

-- Only the current-read wrapper changes. Full admission validators and RPCs do not.
DO $reviewed_read_wrapper$
DECLARE before_def text;after_def text;BEGIN
 before_def:=pg_get_functiondef('private.awardping_reviewed_repeat_row_current(uuid)'::regprocedure);
 if encode(extensions.digest(convert_to(before_def,'UTF8'),'sha256'),'hex')<>'69d201b4e3b25a3417740f6ba659942c3a845b9578e4641d5a3904a965e3ccd5' then raise exception 'Reviewed read wrapper preimage changed.' using errcode='40001';end if;
 after_def:=$reviewed_read_after$CREATE OR REPLACE FUNCTION private.awardping_reviewed_repeat_row_current(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare o public.program_basic_reviewed_repeat_observations%rowtype;s public.shared_award_sources%rowtype;sealed_text text;v jsonb;
begin
 select * into strict o from public.program_basic_reviewed_repeat_observations where id=p_id;
 sealed_text:=o.validation::text;
 if o.content_hash is distinct from encode(extensions.digest(convert_to(sealed_text,'UTF8'),'sha256'),'hex')
  or private.awardping_reviewed_repeat_read_policy_current() is distinct from true then return false;end if;
 -- Parsing the already sealed text once avoids repeated large TOAST reads.
 v:=sealed_text::jsonb;
 select * into strict s from public.shared_award_sources where id=o.source_id;
 return coalesce(o.kind='reviewed_no_program_change' and v->>'kind'=o.kind
  and o.current_ref=v#>'{current_document,reference}' and o.repeat_ref=v#>'{repeat_document,reference}'
  and o.candidate_id::text=v->>'candidate_id' and o.candidate_hash=v->>'candidate_hash' and o.support_hash=v->>'support_hash'
  and o.epoch::text=v->>'epoch' and o.expected_head::text=v->>'expected_head' and o.source_id::text=v->>'source_id'
  and o.cohort_key=v->>'cohort_key' and o.verified_at=(v->>'verified_at')::timestamptz
  and s.text_monitoring_state->>'status'='baseline_ready' and s.text_monitoring_state->'latest_ref'=o.current_ref
  and private.awardping_current_basic_source_ready(s.id,o.cohort_key,o.epoch,o.current_ref)
  and (v->'candidate'=private.awardping_reviewed_repeat_candidate(o.candidate_id)
   and v->'paid_reservation'=private.awardping_reviewed_repeat_paid(v->'candidate')),false);
exception when others then return false;end;$function$
$reviewed_read_after$;
 if encode(extensions.digest(convert_to(after_def,'UTF8'),'sha256'),'hex')<>'8358f9e50fd8c3d9aac24c07be93a8178d50c8ee6ca8f3f4dd55aac626d5d73e' then raise exception 'Reviewed read wrapper differs.' using errcode='40001';end if;
 execute after_def;
END;
$reviewed_read_wrapper$;

-- Sealed read cache only; the complete cause/publication validators remain
-- unchanged for admission. At original attestation V was fully validated.
-- SHA(V), immutable ledger and unchanged policy establish its pure invariants.
-- Every mutable input to the skipped validation is checked against V below:
-- projected candidate, its two additional text-hash columns, paid row, approved
-- owner row, event, unique evidence row, reviewer existence and source allowance.
-- Existing row/source/epoch/parent/support/version guards are untouched.
create function private.awardping_technical_repeat_live_cause(p_id uuid)
returns boolean language plpgsql stable set search_path='' as $technical_live_cause$
declare o public.program_basic_technical_repeat_observations%rowtype;v jsonb;sealed_text text;c jsonb;r jsonb;cid uuid;
 previous_hash text;current_hash text;pin jsonb;actual record;
begin
 select * into strict o from public.program_basic_technical_repeat_observations where id=p_id;
 sealed_text:=o.validation::text;
 if o.kind is distinct from 'retained_technical_repeat' or o.provenance_kind is distinct from 'post_change_technical_probe'
  or o.cohort_key is distinct from 'daad_study' or o.source_id is distinct from '88906939-65e7-492d-a671-da56678dfecd'::uuid
  or o.content_hash is distinct from encode(extensions.digest(convert_to(sealed_text,'UTF8'),'sha256'),'hex') then return false;end if;
 -- Parse the verified seal once: subsequent accesses cannot repeatedly deTOAST
 -- the multi-megabyte original validation value.
 v:=sealed_text::jsonb;
 for pin in select value from jsonb_array_elements('[{"signature":"private.awardping_technical_repeat_cause_valid(jsonb)","definition_sha256":"5a0925c2ba8766ae059a9570a689ca4793022d2febb8d3e748351a35fdd3f20a","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.awardping_validate_program_text_evidence(jsonb,jsonb,jsonb)","definition_sha256":"7407f53323428bb54c59c51cb0e29584539c9841d7922acbbac0e6d2b5a55803","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"private.awardping_reviewed_repeat_candidate(uuid)","definition_sha256":"0157501dec68d0aaf0327db2c07b9a2e381d9e8d9e5e36b64dc03ea85f3ad5f6","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"private.awardping_reviewed_repeat_paid(jsonb)","definition_sha256":"bb59a12601173ed27b32e3745117d09bb53d89d7b56ae46e0bf45cd511dbbbc3","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"private.awardping_reviewed_repeat_hash(jsonb)","definition_sha256":"24f5bfa25bef0c58f87890a8fe0cfaed450ae55270422ec08264e59cd906454b","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"private.awardping_reviewed_repeat_comparison_ref(jsonb)","definition_sha256":"c325326a9d8aa96b31c4a804258744603b81118a7da23c0057de9076dde29490","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"private.program_text_alert_hash(public.shared_award_visual_review_candidates,jsonb,jsonb)","definition_sha256":"c04cf729970c29fb9ad8377dca575988763a42a19ffea1ba38afd8bcc3b85a98","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"private.monitoring_feedback_canonical_json(jsonb)","definition_sha256":"d06f63d374ccac9be773c82eec662dcf7e4e4a1d5c3b54ba6e5bfde51c09d067","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"private.awardping_program_exact_object(jsonb,text[])","definition_sha256":"10b6bfa76a42d2a3e37d10a4c8a83420f10a6f278cec58f02b23b673c83c8681","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"private.awardping_program_block_valid(jsonb,text)","definition_sha256":"32007c139028105fd957f808380034d7eb52c4e8fab3e63dc88a2a67c000836e","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"private.awardping_program_text_reference_valid(jsonb)","definition_sha256":"20014705304b69d723f4d806b801441a1739ce3a745ccac01906a7f25b6b411e","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"private.awardping_program_utf16_length(text)","definition_sha256":"28525ac28cbdf142df6f673cc10229f35c7c31a2a24d264404e771b1be8a5979","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"private.awardping_program_utf16_slice(text,integer,integer)","definition_sha256":"ea88a64543ce819ed80ff84ce84676494966823795f46a6c2661f9671c736c9f","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.awardping_sha256_text(text)","definition_sha256":"f0b9c626273db67d2e2848ca0bcc07755fae0567ed18fcb90cca64eec5a81dd2","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"private.awardping_program_changed_publisher_data(jsonb)","definition_sha256":"7605ffa34743113460ac736e319a1d2a35fed5a0e87f9c600f38101de9885522","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"private.awardping_program_text_reference_before_reviewed_pdf(jsonb)","definition_sha256":"2d684575a4597f49f3d06c7ba884a4caa22270ba609a6c5b3f02e2f4259b0ac3","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"private.awardping_technical_repeat_owner_review(uuid)","definition_sha256":"ab1f220ecba0f92427ca249d676633101d867ecd68b0aa0c7f726d49d28fe7d8","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"private.awardping_technical_repeat_published_event(uuid)","definition_sha256":"40e3705a84e9e284da888676f93be612670c75c6c353cd322ef28a37e99d9742","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"private.awardping_technical_repeat_published_evidence(uuid)","definition_sha256":"e400000ea4f5665a325642c222a9bf1da8f0ee6c89987de30eeada5782bd9d0c","owner":"postgres","acl":["postgres=X/postgres"]}]'::jsonb) loop
  select pg_catalog.pg_get_functiondef(p.oid) definition,pg_catalog.pg_get_userbyid(p.proowner)::text owner_name,
   coalesce(to_jsonb(p.proacl),'null'::jsonb) acl into strict actual from pg_catalog.pg_proc p
   where p.oid=pg_catalog.to_regprocedure(pin->>'signature');
  if encode(extensions.digest(convert_to(actual.definition,'UTF8'),'sha256'),'hex') is distinct from pin->>'definition_sha256'
   or actual.owner_name is distinct from pin->>'owner' or actual.acl is distinct from pin->'acl' then return false;end if;
 end loop;
 cid:=(v->>'causal_candidate_id')::uuid;c:=v->'causal_candidate';r:=v->'owner_review';
 if cid is distinct from o.causal_candidate_id
  or c is distinct from private.awardping_reviewed_repeat_candidate(cid)
  or v->'paid_reservation' is distinct from private.awardping_reviewed_repeat_paid(c)
  or r is distinct from private.awardping_technical_repeat_owner_review(cid)
  or v->'published_event' is distinct from private.awardping_technical_repeat_published_event(cid)
  or v->'published_evidence' is distinct from private.awardping_technical_repeat_published_evidence(cid)
  or not exists(select 1 from auth.users where id=(r->>'reviewed_by')::uuid)
  or private.awardping_program_source_allowed(o.source_id) is distinct from true then return false;end if;
 -- These two live columns are read by the original publication validator but
 -- deliberately are not members of the normal candidate snapshot projection.
 select previous_text_hash,new_text_hash into strict previous_hash,current_hash
  from public.shared_award_visual_review_candidates where id=cid;
 return previous_hash is not distinct from v#>>'{causal_previous_document,reference,text_sha256}'
  and current_hash is not distinct from v#>>'{current_document,reference,text_sha256}';
exception when others then return false;end;
$technical_live_cause$;
revoke all on function private.awardping_technical_repeat_live_cause(uuid) from public,anon,authenticated,service_role;

do $technical_live_row_dispatch$
declare old_body text;old_def text;next_body text;
begin
 select prosrc,pg_get_functiondef(oid) into strict old_body,old_def from pg_catalog.pg_proc
  where oid='private.awardping_technical_repeat_row_current(uuid)'::regprocedure;
 if encode(extensions.digest(convert_to(old_body,'UTF8'),'sha256'),'hex')<>'fc6c25166568e552288d3f41d4d473df8ca355e845f02d2dedac8b139a65a151' then raise exception 'Technical live row preimage changed.' using errcode='40001';end if;
 next_body:=replace(old_body,$technical_old_call$and private.awardping_technical_repeat_cause_valid(o.validation)$technical_old_call$,$technical_new_call$and private.awardping_technical_repeat_live_cause(o.id)$technical_new_call$);
 if encode(extensions.digest(convert_to(next_body,'UTF8'),'sha256'),'hex')<>'e6b79a21eda586fa4fcc2b8ab7534be5ff1b5073903017e66605214e19627dd1' then raise exception 'Technical live row replacement differs.' using errcode='40001';end if;
 execute replace(old_def,old_body,next_body);
end;
$technical_live_row_dispatch$;
