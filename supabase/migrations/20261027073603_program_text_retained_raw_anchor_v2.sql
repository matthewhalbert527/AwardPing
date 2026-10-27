-- PRIVATE CANDIDATE: root review and actual rollback rehearsal required before integration/apply.
-- No source/data/baseline/queue/publication mutation occurs on schema application.
-- Finite NSF raw HTML link provenance. The server must cold-parse the full
-- original before this service-only SQL envelope is issued. SQL does NOT claim
-- to reconstruct DOM ancestry or prove a script substring is an active anchor.
create function private.awardping_program_raw_anchor_provider_link_valid(p_doc jsonb,p_link jsonb,p_proposal jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb:=p_doc->'reference';a jsonb:=p_link->'anchor';lp jsonb:=p_proposal->'link_proof';raw_bytes bytea;raw_text text;
 raw_size integer;field_name text;n bigint;start_byte integer;end_byte integer;start_utf16 integer;end_utf16 integer;
 attr_start integer;attr_end integer;value_start integer;value_end integer;href text;expected_href text;attribute_text text;value_token text;
begin
 if not private.awardping_program_exact_object(p_link,array['kind','source_id','capture_id','raw_artifact','raw_base64','parser_profile','anchor','resolved_url'])
  or p_link->>'kind' is distinct from 'retained_raw_html_anchor.v1'
  or p_link->>'parser_profile' is distinct from 'program-text-raw-anchor-v1/cheerio1.2.0-parse5-7.3.0'
  or not private.awardping_program_exact_object(lp,array['kind','anchor_start_utf16','target_page_url'])
  or lp->>'kind' is distinct from 'retained_raw_html_anchor.v1'
  or p_proposal->>'cohort_key' is distinct from 'nsf_grfp'
  or p_proposal->>'expected_canonical_shared_award_id' is distinct from 'd955a846-cee1-4c01-932e-e3cb7215f3fb'
  or p_proposal#>>'{source,shared_award_id}' is distinct from 'd955a846-cee1-4c01-932e-e3cb7215f3fb'
  or p_proposal#>>'{source,expected_member_kind}' is distinct from 'canonical'
  or p_proposal#>>'{source,page_type}' is distinct from 'other'
  or lp->>'target_page_url' is distinct from p_proposal#>>'{source,url}'
  or p_link->>'resolved_url' is distinct from lp->>'target_page_url'
  or p_proposal->'authority_ref' is distinct from r
  or r#>>'{source,id}' is distinct from 'c49e85e3-3b19-4052-891f-c2bc67e8b8f6'
  or r#>>'{source,shared_award_id}' is distinct from 'd955a846-cee1-4c01-932e-e3cb7215f3fb'
  or r#>>'{source,url}' is distinct from 'https://www.nsf.gov/funding/opportunities/grfp-nsf-graduate-research-fellowship-program/nsf26-526/solicitation'
  or r->>'final_url' is distinct from r#>>'{source,url}' or r->>'acquisition' is distinct from 'http_html'
  or r#>>'{completeness,status}' is distinct from 'complete' or r#>'{completeness,reasons}' is distinct from '[]'::jsonb
  or coalesce(r#>>'{artifacts,raw,content_type}','') !~* '^text/html(;|$)'
  or right(r#>>'{artifacts,raw,object_key}',14) is distinct from '/original.html'
  or p_link->'raw_artifact' is distinct from r#>'{artifacts,raw}'
  or p_link->>'source_id' is distinct from r#>>'{source,id}' or p_link->>'capture_id' is distinct from r->>'capture_id'
  or jsonb_typeof(p_link->'raw_base64') is distinct from 'string' or octet_length(p_link->>'raw_base64') not between 4 and 2796204
  or (p_link->>'raw_base64') !~ '^[A-Za-z0-9+/]*={0,2}$' or length(p_link->>'raw_base64')%4<>0
  or octet_length(p_link::text)>4194304
  or not private.awardping_program_exact_object(a,array['tag','namespace','ordinal','start_utf16','end_utf16','start_byte','end_byte','start_tag','start_tag_sha256',
   'href_attribute_start_utf16','href_attribute_end_utf16','href_value_start_byte','href_value_end_byte','literal_href','label','parent_context'])
  or a->>'tag' is distinct from 'a' or a->>'namespace' is distinct from 'http://www.w3.org/1999/xhtml'
  or jsonb_typeof(a->'start_tag') is distinct from 'string' or octet_length(a->>'start_tag') not between 5 and 4096
  or (a->>'start_tag') !~* '^<a([[:space:]/>])' or right(a->>'start_tag',1) is distinct from '>'
  or coalesce(a->>'start_tag_sha256','') !~ '^[a-f0-9]{64}$'
  or jsonb_typeof(a->'literal_href') is distinct from 'string' or length(a->>'literal_href') not between 1 and 2048
  or jsonb_typeof(a->'label') is distinct from 'string' or length(a->>'label')>1000
  or jsonb_typeof(a->'parent_context') is distinct from 'string' or length(a->>'parent_context')>1600
 then return false;end if;
 expected_href:=case p_link->>'resolved_url'
  when 'https://www.nsf.gov/policies/document/graduate-research-fellowship-program-grfp-administrative'
   then 'https://www.nsf.gov/policies/document/graduate-research-fellowship-program-grfp-administrative'
  when 'https://www.nsf.gov/policies/pappg' then '/policies/pappg' else null end;
 if expected_href is null or a->>'literal_href' is distinct from expected_href then return false;end if;
 foreach field_name in array array['ordinal','start_utf16','end_utf16','start_byte','end_byte','href_attribute_start_utf16','href_attribute_end_utf16','href_value_start_byte','href_value_end_byte'] loop
  if jsonb_typeof(a->field_name) is distinct from 'number' or coalesce(a->>field_name,'') !~ '^(0|[1-9][0-9]{0,9})$' then return false;end if;
  n:=(a->>field_name)::bigint;if n>2097152 then return false;end if;
 end loop;
 if lp->'anchor_start_utf16' is distinct from a->'start_utf16' then return false;end if;
 raw_bytes:=decode(p_link->>'raw_base64','base64');raw_size:=octet_length(raw_bytes);
 if raw_size not between 1 and 2097152 or raw_size::text is distinct from r#>>'{artifacts,raw,byte_length}'
  or encode(extensions.digest(raw_bytes,'sha256'),'hex') is distinct from r#>>'{artifacts,raw,sha256}'
  or replace(encode(raw_bytes,'base64'),E'\n','') is distinct from p_link->>'raw_base64'
  or position(decode('00','hex') in raw_bytes)>0 or substring(raw_bytes from 1 for 3)=decode('efbbbf','hex') then return false;end if;
 raw_text:=convert_from(raw_bytes,'UTF8');if convert_to(raw_text,'UTF8')<>raw_bytes then return false;end if;
 start_byte:=(a->>'start_byte')::integer;end_byte:=(a->>'end_byte')::integer;
 start_utf16:=(a->>'start_utf16')::integer;end_utf16:=(a->>'end_utf16')::integer;
 attr_start:=(a->>'href_attribute_start_utf16')::integer;attr_end:=(a->>'href_attribute_end_utf16')::integer;
 value_start:=(a->>'href_value_start_byte')::integer;value_end:=(a->>'href_value_end_byte')::integer;href:=a->>'literal_href';
 if start_byte>=end_byte or end_byte>raw_size or start_utf16>=end_utf16 or attr_start<start_utf16 or attr_end>end_utf16 or attr_start>=attr_end
  or value_start<start_byte or value_end>end_byte or value_start>=value_end
  or substring(raw_bytes from start_byte+1 for end_byte-start_byte) is distinct from convert_to(a->>'start_tag','UTF8')
  or encode(extensions.digest(substring(raw_bytes from start_byte+1 for end_byte-start_byte),'sha256'),'hex') is distinct from a->>'start_tag_sha256'
  or private.awardping_program_utf16_slice(raw_text,start_utf16,end_utf16) is distinct from a->>'start_tag'
  or substring(raw_bytes from value_start+1 for value_end-value_start) is distinct from convert_to(href,'UTF8')
 then return false;end if;
 attribute_text:=private.awardping_program_utf16_slice(raw_text,attr_start,attr_end);
 if attribute_text is null or attribute_text !~* '^href[[:space:]]*=[[:space:]]*' then return false;end if;
 value_token:=regexp_replace(attribute_text,'^[Hh][Rr][Ee][Ff][[:space:]]*=[[:space:]]*','');
 if value_token not in (href,'"'||href||'"',chr(39)||href||chr(39)) then return false;end if;
 return true;
exception when others then return false;
end;
$$;
revoke all on function private.awardping_program_raw_anchor_provider_link_valid(jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_raw_anchor_provider_link_valid(jsonb,jsonb,jsonb) to service_role;

do $raw_patch_0$
declare body text;original_body text;definition text;needle text;replacement text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select p.prosrc,pg_catalog.pg_get_functiondef(p.oid) into strict body,definition from pg_catalog.pg_proc p where p.oid='private.awardping_program_source_pending_valid(jsonb)'::regprocedure;
 if encode(extensions.digest(convert_to(body,'UTF8'),'sha256'),'hex') is distinct from '2ecc1bcc91b2edb2cf9d84ad482b5358f0bf4e892a1523716181dcbb04f6f123' then
  raise exception 'Raw-anchor source workflow preimage changed.' using errcode='40001';end if;
 original_body:=body;
 needle:=$needle_0_0$ r public.stage1_award_registry%rowtype;$needle_0_0$;
 replacement:=$replacement_0_0$ raw_anchor boolean:=coalesce(p_validation->>'schema'='awardping.program-text-source-pending-proof.v2',false);
 r public.stage1_award_registry%rowtype;$replacement_0_0$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'Raw-anchor source workflow replacement is not unique.' using errcode='40001';end if;
 body:=replace(body,needle,replacement);
 needle:=$needle_0_1$p_validation->>'schema' is distinct from 'awardping.program-text-source-pending-proof.v1'$needle_0_1$;
 replacement:=$replacement_0_1$p_validation->>'schema' is distinct from (case when raw_anchor then 'awardping.program-text-source-pending-proof.v2' else 'awardping.program-text-source-pending-proof.v1' end)$replacement_0_1$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'Raw-anchor source workflow replacement is not unique.' using errcode='40001';end if;
 body:=replace(body,needle,replacement);
 needle:=$needle_0_2$'source','authority_ref','link_block_id','roles','registration_scope'$needle_0_2$;
 replacement:=$replacement_0_2$'source','authority_ref',case when raw_anchor then 'link_proof' else 'link_block_id' end,'roles','registration_scope'$replacement_0_2$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'Raw-anchor source workflow replacement is not unique.' using errcode='40001';end if;
 body:=replace(body,needle,replacement);
 needle:=$needle_0_3$p->>'schema' is distinct from 'awardping.program-text-source-pending-request.v1'$needle_0_3$;
 replacement:=$replacement_0_3$p->>'schema' is distinct from (case when raw_anchor then 'awardping.program-text-source-pending-request.v2' else 'awardping.program-text-source-pending-request.v1' end)$replacement_0_3$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'Raw-anchor source workflow replacement is not unique.' using errcode='40001';end if;
 body:=replace(body,needle,replacement);
 needle:=$needle_0_4$  or not private.awardping_program_exact_object(l,array['source_id','capture_id','block_id','start_utf16','end_utf16','text','resolved_url'])$needle_0_4$;
 replacement:=$replacement_0_4$ then return false;end if;
 if raw_anchor then
  if not private.awardping_program_raw_anchor_provider_link_valid(d,l,p) then return false;end if;
 else
 if not private.awardping_program_exact_object(l,array['source_id','capture_id','block_id','start_utf16','end_utf16','text','resolved_url'])$replacement_0_4$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'Raw-anchor source workflow replacement is not unique.' using errcode='40001';end if;
 body:=replace(body,needle,replacement);
 needle:=$needle_0_5$ if resolved is distinct from src->>'url' then return false;end if;$needle_0_5$;
 replacement:=$replacement_0_5$ if resolved is distinct from src->>'url' then return false;end if;
 end if; -- unchanged v1 source_link branch$replacement_0_5$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'Raw-anchor source workflow replacement is not unique.' using errcode='40001';end if;
 body:=replace(body,needle,replacement);
 if encode(extensions.digest(convert_to(body,'UTF8'),'sha256'),'hex') is distinct from 'bb77bdbde62ef0921512c04d7527d387ea29518f59e6d9d8d4db4e75f98ec48e' or
  (length(definition)-length(replace(definition,original_body,'')))/length(original_body)<>1 then
  raise exception 'Raw-anchor source workflow next body changed.' using errcode='40001';end if;
 execute replace(definition,original_body,body);
end $raw_patch_0$;

do $raw_patch_1$
declare body text;original_body text;definition text;needle text;replacement text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select p.prosrc,pg_catalog.pg_get_functiondef(p.oid) into strict body,definition from pg_catalog.pg_proc p where p.oid='public.approve_program_text_source(jsonb,jsonb,text)'::regprocedure;
 if encode(extensions.digest(convert_to(body,'UTF8'),'sha256'),'hex') is distinct from 'd62b225eb0af82cdce44010ea6bc22360bf8fe212d0a6bc819405cca09621924' then
  raise exception 'Raw-anchor source workflow preimage changed.' using errcode='40001';end if;
 original_body:=body;
 needle:=$needle_1_0$ registry public.stage1_award_registry%rowtype;$needle_1_0$;
 replacement:=$replacement_1_0$ raw_anchor boolean:=coalesce(p_proposal->>'schema'='awardping.program-text-source-approval-request.v2',false);
 registry public.stage1_award_registry%rowtype;$replacement_1_0$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'Raw-anchor source workflow replacement is not unique.' using errcode='40001';end if;
 body:=replace(body,needle,replacement);
 needle:=$needle_1_1$'source','authority_ref','link_block_id','target_ref','roles','registration_scope'$needle_1_1$;
 replacement:=$replacement_1_1$'source','authority_ref',case when raw_anchor then 'link_proof' else 'link_block_id' end,'target_ref','roles','registration_scope'$replacement_1_1$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'Raw-anchor source workflow replacement is not unique.' using errcode='40001';end if;
 body:=replace(body,needle,replacement);
 needle:=$needle_1_2$p_proposal->>'schema' is distinct from 'awardping.program-text-source-approval-request.v1'$needle_1_2$;
 replacement:=$replacement_1_2$p_proposal->>'schema' is distinct from (case when raw_anchor then 'awardping.program-text-source-approval-request.v2' else 'awardping.program-text-source-approval-request.v1' end)$replacement_1_2$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'Raw-anchor source workflow replacement is not unique.' using errcode='40001';end if;
 body:=replace(body,needle,replacement);
 needle:=$needle_1_3$p_validation->>'schema' is distinct from 'awardping.program-text-source-approval-proof.v1'$needle_1_3$;
 replacement:=$replacement_1_3$p_validation->>'schema' is distinct from (case when raw_anchor then 'awardping.program-text-source-approval-proof.v2' else 'awardping.program-text-source-approval-proof.v1' end)$replacement_1_3$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'Raw-anchor source workflow replacement is not unique.' using errcode='40001';end if;
 body:=replace(body,needle,replacement);
 needle:=$needle_1_4$jsonb_build_object('schema','awardping.program-text-source-approval-request.v1',$needle_1_4$;
 replacement:=$replacement_1_4$jsonb_build_object('schema',case when raw_anchor then 'awardping.program-text-source-approval-request.v2' else 'awardping.program-text-source-approval-request.v1' end,$replacement_1_4$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'Raw-anchor source workflow replacement is not unique.' using errcode='40001';end if;
 body:=replace(body,needle,replacement);
 needle:=$needle_1_5$ if not private.awardping_program_exact_object(link,array['source_id','capture_id','block_id','start_utf16','end_utf16','text','resolved_url'])$needle_1_5$;
 replacement:=$replacement_1_5$ if raw_anchor then
  if not private.awardping_program_raw_anchor_provider_link_valid(doc,link,p_proposal) then
   raise exception 'Complete retained raw provider-link proof is invalid.' using errcode='23514';end if;
 else
 if not private.awardping_program_exact_object(link,array['source_id','capture_id','block_id','start_utf16','end_utf16','text','resolved_url'])$replacement_1_5$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'Raw-anchor source workflow replacement is not unique.' using errcode='40001';end if;
 body:=replace(body,needle,replacement);
 needle:=$needle_1_6$ if resolved is distinct from source_url then raise exception 'Provider href does not resolve to the exact requested source.' using errcode='23514'; end if;$needle_1_6$;
 replacement:=$replacement_1_6$ if resolved is distinct from source_url then raise exception 'Provider href does not resolve to the exact requested source.' using errcode='23514'; end if;
 end if; -- unchanged v1 source_link branch$replacement_1_6$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'Raw-anchor source workflow replacement is not unique.' using errcode='40001';end if;
 body:=replace(body,needle,replacement);
 if encode(extensions.digest(convert_to(body,'UTF8'),'sha256'),'hex') is distinct from '38bc575638016e966692b9d2a3d2d243fcb652b8157a343d5f0500e4bfda5115' or
  (length(definition)-length(replace(definition,original_body,'')))/length(original_body)<>1 then
  raise exception 'Raw-anchor source workflow next body changed.' using errcode='40001';end if;
 execute replace(definition,original_body,body);
end $raw_patch_1$;
