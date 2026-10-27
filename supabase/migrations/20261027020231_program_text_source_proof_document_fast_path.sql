-- Cache immutable document data and whole-text metrics once. The BMP branch
-- proves the same exact blocks without rescanning the full page per block.
-- Non-BMP documents retain the existing strict UTF16 helper path.
do $preimage$
declare expected record;actual text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 for expected in select * from (values
  ('awardping_program_source_approval_document_valid','1da33e8b8cc41b7cad2fed01a83ed70d84cb8435f2b3fc547faceb6a5e00895c'),
  ('awardping_program_block_valid','fba5fe463c44d0c610b773e170a610dc5087dd0a15c8a71ae53e2a14d5b4ecd8'),
  ('awardping_program_utf16_slice','6f72c37f8ad03bc33f0612cad323f6f698115ddffc6b1c04c12de1481645a068'),
  ('awardping_program_utf16_length','1248f163352f96c5cd1cb4ebb7da8cb7a77c170dded9ad4bfe404f126dad7c93')
 ) as inputs(name,body_hash) loop
  select encode(extensions.digest(convert_to(proc_rows.prosrc,'UTF8'),'sha256'),'hex') into strict actual
  from pg_catalog.pg_proc proc_rows join pg_catalog.pg_namespace namespace_rows on namespace_rows.oid=proc_rows.pronamespace
  where namespace_rows.nspname='private' and proc_rows.proname=expected.name;
  if actual is distinct from expected.body_hash then raise exception 'Source proof validator preimage changed.' using errcode='40001';end if;
 end loop;
end $preimage$;

create or replace function private.awardping_program_source_approval_document_valid(p_doc jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb:=p_doc->'reference';b jsonb;cursor_at integer:=0;next_at integer;end_at integer;
 full_text text:=p_doc->>'text';blocks jsonb:=p_doc->'blocks';blocks_json text:=p_doc->>'blocks_json';
 text_units integer;bmp_only boolean;
begin
 -- Preserve exact source/reference, complete-original, hashes, JSON and count
 -- checks. Optional block keys are defaulted only for the slice proof below.
 if not private.awardping_program_exact_object(p_doc,array['reference','text','blocks','blocks_json'])
  or not private.awardping_program_text_reference_valid(r)
  or private.awardping_program_fact_known_html_shell(r) or private.awardping_program_fact_known_footer_only_pdf(r)
  or jsonb_typeof(p_doc->'text') is distinct from 'string'
 then return false;end if;
 text_units:=private.awardping_program_utf16_length(full_text);
 bmp_only:=text_units=char_length(full_text);
 if text_units<>(r->>'text_length')::integer
  or encode(extensions.digest(convert_to(full_text,'UTF8'),'sha256'),'hex')<>r->>'text_sha256'
  or jsonb_typeof(blocks) is distinct from 'array' or jsonb_array_length(blocks) not between 1 and 20000
  or jsonb_typeof(p_doc->'blocks_json') is distinct from 'string' or blocks_json::jsonb<>blocks
  or encode(extensions.digest(convert_to(blocks_json,'UTF8'),'sha256'),'hex')<>r->>'blocks_sha256'
  or (select count(distinct x->>'id') from jsonb_array_elements(blocks) x)<>jsonb_array_length(blocks)
 then return false;end if;
 for b in select value from jsonb_array_elements(blocks) loop
  b:='{"heading":null,"page":null,"kind":null,"context":null}'::jsonb||b;
  if bmp_only then
   -- These are the unchanged awardping_program_block_valid shape/type/range
   -- guards. BMP UTF16 positions equal PostgreSQL scalar positions, proven for
   -- the WHOLE original above; no byte-offset or per-block inference is used.
   if not private.awardping_program_exact_object(b,array['id','text','start_utf16','end_utf16','heading','page','kind','context'])
    or not coalesce(jsonb_typeof(b->'id')='string' and length(btrim(b->>'id')) between 1 and 200
     and jsonb_typeof(b->'text')='string' and length(btrim(b->>'text'))>0
     and jsonb_typeof(b->'start_utf16')='number' and b->>'start_utf16' ~ '^[0-9]+$'
     and jsonb_typeof(b->'end_utf16')='number' and b->>'end_utf16' ~ '^[1-9][0-9]*$'
     and (b->>'start_utf16')::numeric between 0 and 1000000
     and (b->>'end_utf16')::numeric between 1 and 1000000
     and jsonb_typeof(b->'heading') in ('string','null')
     and jsonb_typeof(b->'kind') in ('string','null')
     and jsonb_typeof(b->'page') in ('number','null')
     and jsonb_typeof(b->'context') in ('object','null'),false)
   then return false;end if;
   next_at:=(b->>'start_utf16')::integer;end_at:=(b->>'end_utf16')::integer;
   if end_at<=next_at or end_at>text_units
    or substr(full_text,next_at+1,end_at-next_at) is distinct from b->>'text'
    or char_length(b->>'text')<>end_at-next_at
   then return false;end if;
  else
   -- Preserve half-surrogate rejection and every original Unicode boundary.
   -- The old helper can return NULL for an invalid half-surrogate slice.
   -- Indeterminate proofs must fail closed rather than escape IF NOT NULL.
   if private.awardping_program_block_valid(b,full_text) is distinct from true then return false;end if;
   next_at:=(b->>'start_utf16')::integer;end_at:=(b->>'end_utf16')::integer;
  end if;
  if next_at<cursor_at then return false;end if;
  if next_at>cursor_at and (case when bmp_only then substr(full_text,cursor_at+1,next_at-cursor_at)
    else private.awardping_program_utf16_slice(full_text,cursor_at,next_at) end) ~ '[^[:space:]]'
  then return false;end if;
  cursor_at:=end_at;
 end loop;
 return cursor_at=text_units or (case when bmp_only then substr(full_text,cursor_at+1,text_units-cursor_at)
  else private.awardping_program_utf16_slice(full_text,cursor_at,text_units) end) !~ '[^[:space:]]';
exception when others then return false;
end;
$$;
revoke all on function private.awardping_program_source_approval_document_valid(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_source_approval_document_valid(jsonb) to service_role;
