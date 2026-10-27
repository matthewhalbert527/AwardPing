-- PRIVATE SUCCESSOR: ROOT REVIEW/APPLY ONLY. No source is initialized here.
-- Finite four-source extension; the existing two journals/history/state are untouched.
-- Old two admission and exact-retry semantics remain unchanged. New aliases retain
-- their actual source UUID/owner/URL/type, never substitute canonical identity.
do $smart_six_guard_0$
declare function_oid oid;prior_body text;definition text;next_body text;body_edit jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select proc_rows.oid,proc_rows.prosrc,pg_catalog.pg_get_functiondef(proc_rows.oid) into strict function_oid,prior_body,definition
 from pg_catalog.pg_proc proc_rows join pg_catalog.pg_namespace namespace_rows on namespace_rows.oid=proc_rows.pronamespace
 where namespace_rows.nspname='private' and proc_rows.proname='awardping_smart_publisher_json_reference_metadata_valid';
 if encode(extensions.digest(convert_to(prior_body,'UTF8'),'sha256'),'hex') is distinct from '9946936b031678bb7407ddd099ef8f04ae2201099ec91863de49c537d7bdc5a7'
 then raise exception 'Reviewed SMART function body changed; re-review the exact live preimage.' using errcode='40001';end if;
 next_body:=prior_body;
 for body_edit in select value from jsonb_array_elements('[{"needle":")),false);","replacement":"))\n  or (p_ref->>''acquisition''=''publisher_json''\n   and p_ref#>>''{extractor,name}''=''smart-publisher-json''\n   and p_ref->>''final_url''=p_ref#>>''{source,url}''\n   and exists(select 1 from (values\n   (''203baaf3-2905-4fdf-b4af-af84998195a8'',''d7d4d117-f312-456f-a75c-3dbd5d372c99'',''https://www.smartscholarship.org/smart/en?id=kb_article&sys_id=84f05b02db5ac3006bb8f4b40f9619cc'',''faq'',''smart-publisher-json-kb-v1''),\n   (''2562f7c2-4709-4d63-ac25-c4638733a981'',''1efa2a75-e6b8-4bf6-80be-85ef2f6b3108'',''https://www.smartscholarship.org/smart?id=kb_article&sys_id=b8fb18e0db8a8300ecc734cc7c9619d7'',''application'',''smart-publisher-json-kb-v1''),\n   (''39685b8a-3ad9-41c5-834b-b2aaafb2b0e5'',''1efa2a75-e6b8-4bf6-80be-85ef2f6b3108'',''https://www.smartscholarship.org/smart?id=kb_article&sys_id=0383c5d6db2a03006bb8f4b40f961956'',''deadline'',''smart-publisher-json-kb-v1''),\n   (''92eebc07-7392-4136-ba13-d9cd5455c8f9'',''1efa2a75-e6b8-4bf6-80be-85ef2f6b3108'',''https://www.smartscholarship.org/smart/en'',''homepage'',''smart-publisher-json-v1'')\n   ) as reviewed(id,owner_id,url,page_type,version)\n   where p_ref#>>''{source,id}''=reviewed.id\n    and p_ref#>>''{source,shared_award_id}''=reviewed.owner_id\n    and p_ref#>>''{source,url}''=reviewed.url\n    and p_ref#>>''{source,page_type}''=reviewed.page_type\n    and p_ref#>>''{extractor,version}''=reviewed.version)),false);"}]'::jsonb) loop
  if body_edit->>'needle'='' or (length(next_body)-length(replace(next_body,body_edit->>'needle','')))/length(body_edit->>'needle')<>1
  then raise exception 'Expected unique exact SMART insertion point is unavailable.' using errcode='40001';end if;
  next_body:=replace(next_body,body_edit->>'needle',body_edit->>'replacement');
 end loop;
 if next_body=prior_body or (length(definition)-length(replace(definition,prior_body,'')))/length(prior_body)<>1
 then raise exception 'Exact SMART function body cannot be replaced safely.' using errcode='40001';end if;
 execute replace(definition,prior_body,next_body);
end $smart_six_guard_0$;

do $smart_six_guard_1$
declare function_oid oid;prior_body text;definition text;next_body text;body_edit jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select proc_rows.oid,proc_rows.prosrc,pg_catalog.pg_get_functiondef(proc_rows.oid) into strict function_oid,prior_body,definition
 from pg_catalog.pg_proc proc_rows join pg_catalog.pg_namespace namespace_rows on namespace_rows.oid=proc_rows.pronamespace
 where namespace_rows.nspname='public' and proc_rows.proname='transition_known_smart_html_shell';
 if encode(extensions.digest(convert_to(prior_body,'UTF8'),'sha256'),'hex') is distinct from '86035c4977d4150af5e0b87936c45f3f00ca93855b746425f7648157576a37ff'
 then raise exception 'Reviewed SMART function body changed; re-review the exact live preimage.' using errcode='40001';end if;
 next_body:=prior_body;
 for body_edit in select value from jsonb_array_elements('[{"needle":"p_source_id not in (''58aefec0-0d42-4b7b-9887-60d25940b3d0''::uuid,''c33cc2f4-2cbd-458c-b630-537eb3d50f72''::uuid)","replacement":"p_source_id not in (''58aefec0-0d42-4b7b-9887-60d25940b3d0''::uuid,''c33cc2f4-2cbd-458c-b630-537eb3d50f72''::uuid,''203baaf3-2905-4fdf-b4af-af84998195a8''::uuid,''2562f7c2-4709-4d63-ac25-c4638733a981''::uuid,''39685b8a-3ad9-41c5-834b-b2aaafb2b0e5''::uuid,''92eebc07-7392-4136-ba13-d9cd5455c8f9''::uuid)"},{"needle":"if s.shared_award_id<>''d7d4d117-f312-456f-a75c-3dbd5d372c99''::uuid","replacement":"if s.shared_award_id is distinct from (case when s.id in (''2562f7c2-4709-4d63-ac25-c4638733a981''::uuid,''39685b8a-3ad9-41c5-834b-b2aaafb2b0e5''::uuid,''92eebc07-7392-4136-ba13-d9cd5455c8f9''::uuid) then ''1efa2a75-e6b8-4bf6-80be-85ef2f6b3108''::uuid else ''d7d4d117-f312-456f-a75c-3dbd5d372c99''::uuid end)"},{"needle":"where registry.cohort_key=''smart'' and registry.canonical_shared_award_id=s.shared_award_id)","replacement":"where registry.cohort_key=''smart'' and (registry.canonical_shared_award_id=s.shared_award_id\n    or (s.id in (''2562f7c2-4709-4d63-ac25-c4638733a981''::uuid,''39685b8a-3ad9-41c5-834b-b2aaafb2b0e5''::uuid,''92eebc07-7392-4136-ba13-d9cd5455c8f9''::uuid) and registry.canonical_shared_award_id=''d7d4d117-f312-456f-a75c-3dbd5d372c99''::uuid and member.member_kind=''alias'')))"}]'::jsonb) loop
  if body_edit->>'needle'='' or (length(next_body)-length(replace(next_body,body_edit->>'needle','')))/length(body_edit->>'needle')<>1
  then raise exception 'Expected unique exact SMART insertion point is unavailable.' using errcode='40001';end if;
  next_body:=replace(next_body,body_edit->>'needle',body_edit->>'replacement');
 end loop;
 if next_body=prior_body or (length(definition)-length(replace(definition,prior_body,'')))/length(prior_body)<>1
 then raise exception 'Exact SMART function body cannot be replaced safely.' using errcode='40001';end if;
 execute replace(definition,prior_body,next_body);
end $smart_six_guard_1$;

-- OIDs, language, volatility, search_path, definer/ACL and immutable-journal
-- triggers remain the existing values via pg_get_functiondef replacement.
-- Reserve the exact new KB extractor tag even under forged HTML/name fields.
do $smart_six_guard_2$
declare function_oid oid;prior_body text;definition text;next_body text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select proc_rows.oid,proc_rows.prosrc,pg_catalog.pg_get_functiondef(proc_rows.oid) into strict function_oid,prior_body,definition
 from pg_catalog.pg_proc proc_rows join pg_catalog.pg_namespace namespace_rows on namespace_rows.oid=proc_rows.pronamespace
 where namespace_rows.nspname='private' and proc_rows.proname='awardping_program_text_reference_valid';
 if encode(extensions.digest(convert_to(prior_body,'UTF8'),'sha256'),'hex') is distinct from 'f64a4a4dd53df2e02026a46603f709768ea2ebadcca3483dd69b8d2c48a528a2'
 then raise exception 'Reviewed SMART reference body changed; re-review the exact live preimage.' using errcode='40001';end if;
 if (length(prior_body)-length(replace(prior_body,'p_ref#>>''{extractor,version}''=''smart-publisher-json-v1''','')))/length('p_ref#>>''{extractor,version}''=''smart-publisher-json-v1''')<>1
 then raise exception 'Expected exact SMART reserved-version insertion point is unavailable.' using errcode='40001';end if;
 next_body:=replace(prior_body,'p_ref#>>''{extractor,version}''=''smart-publisher-json-v1''','p_ref#>>''{extractor,version}'' in (''smart-publisher-json-v1'',''smart-publisher-json-kb-v1'')');
 if next_body=prior_body or (length(definition)-length(replace(definition,prior_body,'')))/length(prior_body)<>1
 then raise exception 'Exact SMART reference body cannot be replaced safely.' using errcode='40001';end if;
 execute replace(definition,prior_body,next_body);
end $smart_six_guard_2$;

notify pgrst,'reload schema';
