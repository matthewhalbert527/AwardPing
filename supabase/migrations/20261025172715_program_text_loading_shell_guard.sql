-- Known invalid originals are preserved, not reset or compared with a new page.
-- These six SMART captures contain ONLY the exact 76-character loading/navigation
-- shell below. This quality hold does not depend on URL/owner guesses or a minimum
-- text length, and does not alter the global reference/history contract.
create function private.awardping_program_fact_known_html_shell(p_ref jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
 select coalesce(p_ref->>'acquisition' in ('http_html','rendered_html')
  and p_ref->>'text_length'='76'
  and p_ref->>'text_sha256'='0690da223815dc8171e2ec5e6699cf455373bb41644063cd276de152a1ac197c',false);
$$;
revoke all on function private.awardping_program_fact_known_html_shell(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_fact_known_html_shell(jsonb) to service_role;

create or replace function private.awardping_program_fact_validation_valid(p_validation jsonb,p_approval boolean)
returns boolean language plpgsql stable set search_path='' as $$
declare v_review jsonb:=p_validation->'review'; v_registry public.stage1_award_registry%rowtype;
 v_roster jsonb; v_ids uuid[]; v_doc jsonb; v_ref jsonb; v_source public.shared_award_sources%rowtype;
 v_state jsonb; v_field jsonb; v_item jsonb; v_quote jsonb; v_block jsonb; v_cursor integer; v_start integer; v_end integer; v_supported_years text[];
 v_fields text[]:=array['overview','opening_date','deadline','cycle_status','important_dates','eligibility','citizenship',
 'academic_levels','disciplines','award_amounts','stipend','tuition','travel_research_allowance','tenure','requirements',
 'application_materials','how_to_apply','documents','selection','application_url','contacts'];
begin
 if not private.awardping_program_exact_object(p_validation,array['schema','review','blockers','source_text','public_facts'])
  or p_validation->>'schema' is distinct from 'awardping.program-fact-validation.v1'
  or octet_length(p_validation::text)>33554432
  or not private.awardping_program_exact_object(v_review,array['schema','cohort_key','award_id','epoch','cycle','reviewed_all_sources','roster','capture_refs','fields'])
  or v_review->>'schema' is distinct from 'awardping.program-fact-review.v1'
  or jsonb_typeof(v_review->'cycle') is distinct from 'string' or length(btrim(v_review->>'cycle')) not between 1 and 120
  or jsonb_typeof(v_review->'reviewed_all_sources') is distinct from 'boolean'
  or not coalesce(v_review->>'epoch' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$',false)
  or jsonb_typeof(v_review->'roster') is distinct from 'array' or jsonb_typeof(v_review->'capture_refs') is distinct from 'array'
  or jsonb_typeof(v_review->'fields') is distinct from 'array' or jsonb_array_length(v_review->'fields')<>21
  or jsonb_typeof(p_validation->'blockers') is distinct from 'array' or jsonb_typeof(p_validation->'source_text') is distinct from 'array'
 then return false; end if;
 select * into strict v_registry from public.stage1_award_registry where cohort_key=v_review->>'cohort_key';
 if v_review->>'award_id' is distinct from v_registry.canonical_shared_award_id::text then return false; end if;
 select jsonb_agg(jsonb_build_object('source_role',source_role,'revision',revision,'source_ids',source_ids) order by source_role)
 into v_roster from public.program_text_source_roster where cohort_key=v_registry.cohort_key;
 if v_roster is null or v_roster is distinct from
  (select jsonb_agg(value order by value->>'source_role') from jsonb_array_elements(v_review->'roster')) then return false; end if;
 select array_agg(distinct id order by id) into v_ids from public.program_text_source_roster r,
  lateral unnest(r.source_ids) id where r.cohort_key=v_registry.cohort_key;
 if cardinality(v_ids) not between 1 and 500 or jsonb_array_length(v_review->'capture_refs')<>cardinality(v_ids)
  or jsonb_array_length(p_validation->'source_text')<>cardinality(v_ids)
  or (select count(distinct value#>>'{reference,source,id}') from jsonb_array_elements(p_validation->'source_text'))<>cardinality(v_ids)
  or (select count(distinct value#>>'{source,id}') from jsonb_array_elements(v_review->'capture_refs'))<>cardinality(v_ids)
 then return false; end if;
 for v_doc in select value from jsonb_array_elements(p_validation->'source_text') loop
  v_ref:=v_doc->'reference';
  if not private.awardping_program_exact_object(v_doc,array['reference','text','blocks','blocks_json'])
   or not private.awardping_program_text_reference_valid(v_ref)
   or not (v_ref#>>'{source,id}')::uuid=any(v_ids)
   or not exists(select 1 from jsonb_array_elements(v_review->'capture_refs') ref where ref=v_ref)
   or jsonb_typeof(v_doc->'text') is distinct from 'string'
   or private.awardping_program_utf16_length(v_doc->>'text')<>(v_ref->>'text_length')::integer
   or encode(extensions.digest(convert_to(v_doc->>'text','UTF8'),'sha256'),'hex') is distinct from v_ref->>'text_sha256'
   or jsonb_typeof(v_doc->'blocks') is distinct from 'array'
   or jsonb_typeof(v_doc->'blocks_json') is distinct from 'string'
   or (v_doc->>'blocks_json')::jsonb is distinct from v_doc->'blocks'
   or encode(extensions.digest(convert_to(v_doc->>'blocks_json','UTF8'),'sha256'),'hex') is distinct from v_ref->>'blocks_sha256'
   or jsonb_array_length(v_doc->'blocks') not between 1 and 20000
   or (select count(distinct value->>'id') from jsonb_array_elements(v_doc->'blocks'))<>jsonb_array_length(v_doc->'blocks')
  then return false; end if;
  select * into strict v_source from public.shared_award_sources where id=(v_ref#>>'{source,id}')::uuid;
  v_state:=v_source.text_monitoring_state;
  if private.awardping_program_fact_known_html_shell(v_ref)
   or not private.awardping_program_source_allowed(v_source.id)
   or v_ref#>>'{source,shared_award_id}' is distinct from v_source.shared_award_id::text
   or v_ref#>>'{source,url}' is distinct from v_source.url
   or not exists(select 1 from public.stage1_award_members m where m.shared_award_id=v_source.shared_award_id and m.cohort_key=v_registry.cohort_key)
   or v_state->>'schema' is distinct from 'awardping.program-text-state.v1' or v_state->>'epoch' is distinct from v_review->>'epoch'
   or v_state->>'status' is distinct from 'baseline_ready' or not coalesce((v_state->>'successful_checks')::integer>=2,false)
   or v_state->'baseline_ref' is distinct from v_state->'latest_ref'
   or v_state#>>'{latest_ref,text_sha256}' is distinct from v_ref->>'text_sha256'
   or v_state#>>'{latest_ref,final_url}' is distinct from v_ref->>'final_url'
   or v_state#>>'{latest_ref,acquisition}' is distinct from v_ref->>'acquisition'
   or v_state#>'{latest_ref,extractor}' is distinct from v_ref->'extractor'
   or not coalesce((v_state->>'first_captured_at')::timestamptz<(v_state#>>'{latest_ref,captured_at}')::timestamptz
    and (v_ref->>'captured_at')::timestamptz<=(v_state->>'last_checked_at')::timestamptz,false)
  then return false; end if;
  v_cursor:=0;
  for v_block in select value from jsonb_array_elements(v_doc->'blocks') loop
   -- Keep the original optional-key representation for the immutable hash.
   -- Null defaults belong only to the legacy exact-eight-key slice validator.
   if not private.awardping_program_block_valid('{"heading":null,"page":null,"kind":null,"context":null}'::jsonb||v_block,v_doc->>'text') then return false; end if;
   v_start:=(v_block->>'start_utf16')::integer; v_end:=(v_block->>'end_utf16')::integer;
   if v_start<v_cursor or v_start>v_cursor and private.awardping_program_utf16_slice(v_doc->>'text',v_cursor,v_start) ~ '[^[:space:]]' then return false; end if;
   v_cursor:=v_end;
  end loop;
  if v_cursor<(v_ref->>'text_length')::integer and private.awardping_program_utf16_slice(v_doc->>'text',v_cursor,(v_ref->>'text_length')::integer) ~ '[^[:space:]]' then return false; end if;
 end loop;
 if (select count(distinct value->>'field') from jsonb_array_elements(v_review->'fields'))<>21 then return false; end if;
 for v_field in select value from jsonb_array_elements(v_review->'fields') loop
  if not private.awardping_program_exact_object(v_field,array['field','status','items','note'])
   or not coalesce(v_field->>'field'=any(v_fields),false)
   or not coalesce(v_field->>'status' in ('verified','not_published','unresolved'),false)
   or jsonb_typeof(v_field->'note') is distinct from 'string' or length(v_field->>'note')>2000
   or jsonb_typeof(v_field->'items') is distinct from 'array' or jsonb_array_length(v_field->'items')>64
   or v_field->>'status'='verified' and jsonb_array_length(v_field->'items')=0
   or v_field->>'status'<>'verified' and (jsonb_array_length(v_field->'items')<>0 or length(btrim(v_field->>'note'))<20)
   or p_approval and v_field->>'status'='unresolved' then return false; end if;
  if p_approval and v_field->>'field'='overview' and (v_field->>'status'<>'verified'
   or jsonb_array_length(v_field->'items')<>1 or v_field#>>'{items,0,track}' is not null) then return false; end if;
  if (select count(distinct jsonb_build_array(value->'track',value->'value')) from jsonb_array_elements(v_field->'items'))<>jsonb_array_length(v_field->'items') then return false; end if;
  for v_item in select value from jsonb_array_elements(v_field->'items') loop
   if not private.awardping_program_exact_object(v_item,array['value','track','support'])
    or jsonb_typeof(v_item->'value') is distinct from 'string' or length(btrim(v_item->>'value'))=0
    or private.awardping_program_utf16_length(v_item->>'value')>2400
    or not coalesce(jsonb_typeof(v_item->'track')='null' or jsonb_typeof(v_item->'track')='string' and length(btrim(v_item->>'track')) between 1 and 200,false)
    or jsonb_typeof(v_item->'support') is distinct from 'array' or jsonb_array_length(v_item->'support') not between 1 and 12
    or v_field->>'field'='application_url' and not coalesce(v_item->>'value' ~ '^https://[^/@\\?#[:space:]]+([/?#][^[:space:]]*)?$',false)
   then return false; end if;
   for v_quote in select value from jsonb_array_elements(v_item->'support') loop
    if not private.awardping_program_exact_object(v_quote,array['source_id','capture_id','block_id','start_utf16','end_utf16','text'])
     or jsonb_typeof(v_quote->'text') is distinct from 'string' or length(btrim(v_quote->>'text'))=0
     or private.awardping_program_utf16_length(v_quote->>'text')>1600
     or jsonb_typeof(v_quote->'start_utf16') is distinct from 'number' or jsonb_typeof(v_quote->'end_utf16') is distinct from 'number'
     or not coalesce(v_quote->>'start_utf16' ~ '^[0-9]+$' and v_quote->>'end_utf16' ~ '^[1-9][0-9]*$',false)
    then return false; end if;
    select value into strict v_doc from jsonb_array_elements(p_validation->'source_text')
     where value#>>'{reference,source,id}'=v_quote->>'source_id' and value#>>'{reference,capture_id}'=v_quote->>'capture_id';
    select value into strict v_block from jsonb_array_elements(v_doc->'blocks') where value->>'id'=v_quote->>'block_id';
    v_start:=(v_quote->>'start_utf16')::integer; v_end:=(v_quote->>'end_utf16')::integer;
    if v_start<(v_block->>'start_utf16')::integer or v_end>(v_block->>'end_utf16')::integer or v_start>=v_end
     or private.awardping_program_utf16_length(v_quote->>'text')<>v_end-v_start
     or private.awardping_program_utf16_slice(v_doc->>'text',v_start,v_end) is distinct from v_quote->>'text'
    then return false; end if;
   end loop;
   if v_field->>'field' in ('deadline','opening_date') then
    select array_agg(matches[1]) into v_supported_years from regexp_matches(
     (select string_agg(value->>'text',' ') from jsonb_array_elements(v_item->'support')),'\m((?:19|20)[0-9]{2})\M','g') matches;
    if cardinality(v_supported_years)>0 and exists(select 1 from regexp_matches(v_item->>'value','\m((?:19|20)[0-9]{2})\M','g') matches
     where not matches[1]=any(v_supported_years)) then return false; end if;
   end if;
  end loop;
  if v_field->>'field' in ('deadline','opening_date','cycle_status') and jsonb_array_length(v_field->'items')>1
   and (exists(select 1 from jsonb_array_elements(v_field->'items') where value->>'track' is null)
    or (select count(distinct value->>'track') from jsonb_array_elements(v_field->'items'))<>jsonb_array_length(v_field->'items'))
  then return false; end if;
 end loop;
 return (not p_approval or (v_review->>'reviewed_all_sources')::boolean and p_validation->'blockers'='[]'::jsonb)
  and p_validation->'public_facts'=private.awardping_program_fact_public_values(v_review);
exception when others then return false;
end;
$$;

create or replace function private.awardping_program_fact_source_ready(p_id uuid)
returns boolean language plpgsql stable set search_path='' as $$
declare v_source public.shared_award_sources%rowtype; v_state jsonb; v_ref jsonb;
begin
 select * into strict v_source from public.shared_award_sources where id=p_id;
 v_state:=v_source.text_monitoring_state; v_ref:=v_state->'latest_ref';
 return coalesce(private.awardping_program_source_allowed(v_source.id)
  and v_state->>'schema'='awardping.program-text-state.v1'
  and v_state->>'epoch' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  and v_state->>'epoch'<>'00000000-0000-0000-0000-000000000000'
  and v_state->>'status'='baseline_ready'
  and jsonb_typeof(v_state->'successful_checks')='number'
  and v_state->>'successful_checks' ~ '^[1-9][0-9]*$'
  and (v_state->>'successful_checks')::bigint between 2 and 2147483647
  and v_state->'baseline_ref'=v_ref
  and private.awardping_program_text_reference_valid(v_ref)
  and not private.awardping_program_fact_known_html_shell(v_ref)
  and v_ref#>>'{source,id}'=v_source.id::text
  and v_ref#>>'{source,shared_award_id}'=v_source.shared_award_id::text
  and v_ref#>>'{source,url}'=v_source.url
  and (v_state->>'first_captured_at')::timestamptz<(v_ref->>'captured_at')::timestamptz
  and (v_ref->>'captured_at')::timestamptz<=(v_state->>'last_checked_at')::timestamptz,false);
exception when others then return false;
end;
$$;

create or replace function private.awardping_program_fact_review_current(p_id uuid)
returns boolean language plpgsql stable set search_path='' as $$
declare v_row public.program_text_fact_reviews%rowtype; v_ref jsonb; v_source public.shared_award_sources%rowtype; v_roster jsonb;
begin
 select * into strict v_row from public.program_text_fact_reviews where id=p_id;
 if v_row.status<>'approved' or not exists(select 1 from public.stage1_award_registry registry where registry.cohort_key=v_row.cohort_key
  and registry.canonical_shared_award_id::text=v_row.validation#>>'{review,award_id}') then return false; end if;
 select jsonb_agg(jsonb_build_object('source_role',source_role,'revision',revision,'source_ids',source_ids) order by source_role)
 into v_roster from public.program_text_source_roster where cohort_key=v_row.cohort_key;
 if v_roster is distinct from (select jsonb_agg(value order by value->>'source_role') from jsonb_array_elements(v_row.validation#>'{review,roster}')) then return false; end if;
 for v_ref in select value from jsonb_array_elements(v_row.validation#>'{review,capture_refs}') loop
  select * into strict v_source from public.shared_award_sources where id=(v_ref#>>'{source,id}')::uuid;
  if not private.awardping_program_fact_source_ready(v_source.id)
   or not private.awardping_program_source_allowed(v_source.id) or v_source.shared_award_id::text is distinct from v_ref#>>'{source,shared_award_id}'
   or not exists(select 1 from public.stage1_award_members member where member.cohort_key=v_row.cohort_key and member.shared_award_id=v_source.shared_award_id)
   or v_source.url is distinct from v_ref#>>'{source,url}' or v_source.text_monitoring_state->>'epoch' is distinct from v_row.validation#>>'{review,epoch}'
   or v_source.text_monitoring_state->>'schema' is distinct from 'awardping.program-text-state.v1'
   or v_source.text_monitoring_state->>'status' is distinct from 'baseline_ready'
   or not coalesce((v_source.text_monitoring_state->>'successful_checks')::integer>=2,false)
   or v_source.text_monitoring_state->'baseline_ref' is distinct from v_source.text_monitoring_state->'latest_ref'
   or coalesce((v_source.text_monitoring_state->>'last_program_update_at')::timestamptz>v_row.reviewed_at,false)
  then return false; end if;
 end loop;
 return true;
exception when others then return false;
end;
$$;
