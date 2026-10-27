-- Only three observed public PDF downloads may retain an octet-stream MIME.
-- This grants neither source ownership nor factual approval and rewrites no evidence.
do $$ declare actual_body_sha text; begin
 select encode(extensions.digest(convert_to(proc_rows.prosrc,'UTF8'),'sha256'),'hex') into strict actual_body_sha
 from pg_catalog.pg_proc proc_rows join pg_catalog.pg_namespace namespace_rows on namespace_rows.oid=proc_rows.pronamespace
 where namespace_rows.nspname='private' and proc_rows.proname='awardping_program_text_reference_valid'
 and pg_catalog.pg_get_function_identity_arguments(proc_rows.oid)='p_ref jsonb';
 if actual_body_sha is distinct from '77392cce6a93eb73262e6d585470d26fce7d81f4f3db9350fd277e5cc153c74c' then
 raise exception 'Reference validator changed; independently review before replacing.' using errcode='40001';end if;
end $$;

create function private.awardping_program_public_drive_pdf_identity(p_url text)
returns text language sql immutable security invoker set search_path='' as $$
 select case when p_url !~ '[[:space:]]' and p_url ~ '^https://drive[.]usercontent[.]google[.]com/(uc|download)[?](id=(1zHNkNkZRMby5z2qqkwsiexbOGX-ao6_H|1ovb7IAawhtIWBws8kpYojXx_lLZusseQ|1ynJ0l9ZPi_PNIzOPrFPJcEgNvK6S9Vs0)&export=download|export=download&id=(1zHNkNkZRMby5z2qqkwsiexbOGX-ao6_H|1ovb7IAawhtIWBws8kpYojXx_lLZusseQ|1ynJ0l9ZPi_PNIzOPrFPJcEgNvK6S9Vs0))$'
 then (regexp_match(p_url,'[?&]id=([^&]+)(&|$)'))[1] else null end;
$$;
create function private.awardping_program_public_drive_pdf_transition(p_source_url text,p_final_url text)
returns boolean language sql immutable security invoker set search_path='' as $$
 select coalesce(private.awardping_program_public_drive_pdf_identity(p_source_url) is not null
 and private.awardping_program_public_drive_pdf_identity(p_source_url)=private.awardping_program_public_drive_pdf_identity(p_final_url)
 and p_final_url ~ '^https://drive[.]usercontent[.]google[.]com/download[?]',false);
$$;
create function private.awardping_program_public_drive_pdf_metadata_valid(p_ref jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
 select coalesce(p_ref#>>'{source,page_type}'='pdf' and p_ref->>'acquisition'='pdf_text'
 and p_ref#>>'{extractor,name}'='pdf-parse' and p_ref#>>'{extractor,version}'='2.4.5/program-text-v1/public-drive-pdf-v1'
 and private.awardping_program_public_drive_pdf_transition(p_ref#>>'{source,url}',p_ref->>'final_url'),false);
$$;
revoke all on function private.awardping_program_public_drive_pdf_identity(text),private.awardping_program_public_drive_pdf_transition(text,text),
 private.awardping_program_public_drive_pdf_metadata_valid(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_public_drive_pdf_identity(text),private.awardping_program_public_drive_pdf_transition(text,text),
 private.awardping_program_public_drive_pdf_metadata_valid(jsonb) to service_role;

CREATE OR REPLACE FUNCTION private.awardping_program_text_reference_valid(p_ref jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare v_artifact jsonb; v_role text; v_name text; v_prefix text; v_at timestamptz;
 v_pdf boolean; v_limit integer;
begin
 if p_ref#>>'{extractor,version}'='2.4.5/program-text-v1/public-drive-pdf-v1'
  and not private.awardping_program_public_drive_pdf_metadata_valid(p_ref) then return false;end if;
 if not private.awardping_program_exact_object(p_ref,array['schema','kind','capture_id','source','final_url',
   'captured_at','acquisition','extractor','text_sha256','text_length','blocks_sha256','completeness','artifacts'])
   or not coalesce(
     p_ref->>'schema'='awardping.program-text-reference.v1' and p_ref->>'kind'='program_text'
     and jsonb_typeof(p_ref->'capture_id')='string' and p_ref->>'capture_id' ~ '^[0-9a-f]{64}$'
     and jsonb_typeof(p_ref->'source')='object'
     and (p_ref->'source') ?& array['id','shared_award_id','url']
     and (p_ref->'source')-array['id','shared_award_id','url','title','page_type']='{}'::jsonb
     and p_ref#>>'{source,id}' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     and p_ref#>>'{source,shared_award_id}' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     and jsonb_typeof(p_ref#>'{source,url}')='string' and p_ref#>>'{source,url}' ~ '^https?://[^[:space:]]+$'
     and jsonb_typeof(p_ref->'final_url')='string' and p_ref->>'final_url' ~ '^https?://[^[:space:]]+$'
     and jsonb_typeof(p_ref->'captured_at')='string'
     and p_ref->>'captured_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
     and jsonb_typeof(p_ref->'text_sha256')='string' and p_ref->>'text_sha256' ~ '^[0-9a-f]{64}$'
     and jsonb_typeof(p_ref->'blocks_sha256')='string' and p_ref->>'blocks_sha256' ~ '^[0-9a-f]{64}$'
     and jsonb_typeof(p_ref->'text_length')='number' and p_ref->>'text_length' ~ '^[1-9][0-9]*$'
     and (p_ref->>'text_length')::numeric between 1 and 1000000
     and p_ref->>'acquisition' in ('http_html','rendered_html','pdf_text','pdf_ocr')
   ,false) then return false; end if;
 if not private.awardping_program_exact_object(p_ref->'extractor',array['name','version'])
   or not coalesce(jsonb_typeof(p_ref#>'{extractor,name}')='string'
     and length(btrim(p_ref#>>'{extractor,name}')) between 1 and 160
     and jsonb_typeof(p_ref#>'{extractor,version}')='string'
     and length(btrim(p_ref#>>'{extractor,version}')) between 1 and 160,false)
   or not private.awardping_program_exact_object(p_ref->'completeness',array['status','reasons'])
   or p_ref#>>'{completeness,status}' is distinct from 'complete'
   or p_ref#>'{completeness,reasons}' is distinct from '[]'::jsonb
   or not private.awardping_program_exact_object(p_ref->'artifacts',array['raw','text','metadata'])
 then return false; end if;
 v_at:=(p_ref->>'captured_at')::timestamptz;
 if to_char(v_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') is distinct from p_ref->>'captured_at'
 then return false; end if;
 v_pdf:=p_ref->>'acquisition' in ('pdf_text','pdf_ocr');
 v_prefix:='program-text/sources/'||(p_ref#>>'{source,id}')||'/'||(p_ref->>'capture_id')||'/';
 foreach v_role in array array['raw','text','metadata'] loop
   v_artifact:=p_ref->'artifacts'->v_role;
   v_name:=case when v_role='metadata' then 'metadata.json' when v_role='text' then 'text.txt'
     when v_pdf then 'original.pdf' else 'original.html' end;
   v_limit:=case when v_role='raw' and v_pdf then 20971520 when v_role='raw' then 5242880
     when v_role='text' then 8388608 else 33554432 end;
   if not private.awardping_program_exact_object(v_artifact,array['object_key','sha256','byte_length','content_type'])
     or not coalesce(v_artifact->>'object_key'=v_prefix||v_name
       and jsonb_typeof(v_artifact->'sha256')='string' and v_artifact->>'sha256' ~ '^[0-9a-f]{64}$'
       and jsonb_typeof(v_artifact->'byte_length')='number'
       and v_artifact->>'byte_length' ~ '^[1-9][0-9]*$'
       and (v_artifact->>'byte_length')::numeric between 1 and v_limit
       and jsonb_typeof(v_artifact->'content_type')='string',false)
   then return false; end if;
   if v_role='text' and (v_artifact->>'content_type' is distinct from 'text/plain; charset=utf-8'
       or v_artifact->>'sha256' is distinct from p_ref->>'text_sha256'
       or (v_artifact->>'byte_length')::numeric < (p_ref->>'text_length')::numeric
       or (v_artifact->>'byte_length')::numeric > 3*(p_ref->>'text_length')::numeric)
     or v_role='metadata' and v_artifact->>'content_type' is distinct from 'application/json'
     or v_role='raw' and not coalesce(case when v_pdf then (v_artifact->>'content_type' ~* '^application/pdf(;|$)'
       or private.awardping_program_public_drive_pdf_metadata_valid(p_ref) and v_artifact->>'content_type' ~* '^application/octet-stream(;|$)')
       else v_artifact->>'content_type' ~* '^(text/html|application/xhtml[+]xml)(;|$)' end,false)
   then return false; end if;
 end loop;
 return true;
exception when others then return false;
end;
$function$;

-- CREATE OR REPLACE preserves the existing function identity and ACL.
revoke all on function private.awardping_program_text_reference_valid(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_text_reference_valid(jsonb) to service_role;
notify pgrst,'reload schema';
