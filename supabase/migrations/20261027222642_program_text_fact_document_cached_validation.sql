-- Reuse the strict cached full-document proof for current program facts.
-- Preserve exact source, quotation, roster, ownership and approval checks.
-- Keep the existing eight-second RPC bound; no source or fact data changes.

do $fact_document_cache_reuse$
declare body text;definition text;helper_body text;next_body text;needle text:=$old_block_loop$  v_cursor:=0;
  for v_block in select value from jsonb_array_elements(v_doc->'blocks') loop
   -- Keep the original optional-key representation for the immutable hash.
   -- Null defaults belong only to the legacy exact-eight-key slice validator.
   if not private.awardping_program_block_valid('{"heading":null,"page":null,"kind":null,"context":null}'::jsonb||v_block,v_doc->>'text') then return false; end if;
   v_start:=(v_block->>'start_utf16')::integer; v_end:=(v_block->>'end_utf16')::integer;
   if v_start<v_cursor or v_start>v_cursor and private.awardping_program_utf16_slice(v_doc->>'text',v_cursor,v_start) ~ '[^[:space:]]' then return false; end if;
   v_cursor:=v_end;
  end loop;
  if v_cursor<(v_ref->>'text_length')::integer and private.awardping_program_utf16_slice(v_doc->>'text',v_cursor,(v_ref->>'text_length')::integer) ~ '[^[:space:]]' then return false; end if;$old_block_loop$;
 replacement text:=$cached_document_proof$  -- Reuse the already-applied strict cached document proof. Source/currentness,
  -- roles, metadata hashes, fields/quotes and approval gates stay unchanged.
  if private.awardping_program_source_approval_document_valid(v_doc) is distinct from true then return false;end if;$cached_document_proof$;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select p.prosrc,pg_catalog.pg_get_functiondef(p.oid) into strict body,definition from pg_catalog.pg_proc p
  where p.oid='private.awardping_program_fact_validation_valid(jsonb,boolean)'::regprocedure;
 if encode(extensions.digest(convert_to(body,'UTF8'),'sha256'),'hex') is distinct from '051e0d4169ac678e43d019b360b2128115346e714ebc3bb8beac77205dbacfa9' then
  raise exception 'Exact fact validator preimage changed.' using errcode='40001';end if;
 select p.prosrc into strict helper_body from pg_catalog.pg_proc p
  where p.oid='private.awardping_program_source_approval_document_valid(jsonb)'::regprocedure;
 if encode(extensions.digest(convert_to(helper_body,'UTF8'),'sha256'),'hex') is distinct from '28d177e66a6a3f54bdaa19926d5377c3d04eeec266cbbce01ec24bd189d118a6' then
  raise exception 'Reviewed cached full-document proof changed.' using errcode='40001';end if;
 if exists(select 1 from pg_catalog.pg_proc p,lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
  where p.oid in('private.awardping_program_fact_validation_valid(jsonb,boolean)'::regprocedure,'private.awardping_program_source_approval_document_valid(jsonb)'::regprocedure)
   and a.privilege_type='EXECUTE' and a.grantee not in(p.proowner,'service_role'::regrole)) then
  raise exception 'Private fact/document proof ACL changed.' using errcode='42501';end if;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1
  or (length(definition)-length(replace(definition,body,'')))/length(body)<>1 then
  raise exception 'Expected exact unique full-document block loop is unavailable.' using errcode='40001';end if;
 next_body:=replace(body,needle,replacement);
 if encode(extensions.digest(convert_to(next_body,'UTF8'),'sha256'),'hex') is distinct from 'c03a8781cb77c3e73ded3606414186c616bce9bdbd9f3e6f4f6cd9463484d605' then
  raise exception 'Proposed fact proof body hash changed.' using errcode='40001';end if;
 execute replace(definition,body,next_body);
end $fact_document_cache_reuse$;
