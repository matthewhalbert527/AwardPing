-- Versioned, private current-details reviews. Collection is not fact approval.
create table public.program_text_fact_reviews (
 id uuid primary key default gen_random_uuid(),
 cohort_key text not null references public.stage1_award_registry(cohort_key),
 validation jsonb not null,
 content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),
 status text not null default 'draft' check(status in ('draft','approved')),
 created_by text not null,
 created_at timestamptz not null default now(),
 reviewed_by text,
 reviewed_at timestamptz,
 unique(cohort_key,content_hash),
 check((status='approved')=(reviewed_by is not null and reviewed_at is not null))
);
create table public.program_text_fact_release (
 release_key text primary key check(release_key='national-25-text-facts'),
 revision uuid not null default gen_random_uuid(),
 review_ids jsonb not null default '{}'::jsonb check(jsonb_typeof(review_ids)='object'),
 is_active boolean not null default false,
 published_by text,
 published_at timestamptz
);
create table public.program_text_fact_review_events (
 id uuid primary key default gen_random_uuid(),
 action text not null check(action in ('draft_created','approved','published')),
 subject_id text not null,
 details jsonb not null,
 actor text not null,
 created_at timestamptz not null default now()
);
alter table public.program_text_fact_reviews enable row level security;
alter table public.program_text_fact_release enable row level security;
alter table public.program_text_fact_review_events enable row level security;
revoke all on public.program_text_fact_reviews,public.program_text_fact_release,public.program_text_fact_review_events from public,anon,authenticated,service_role;
grant select on public.program_text_fact_reviews,public.program_text_fact_release,public.program_text_fact_review_events to service_role;
insert into public.program_text_fact_release(release_key) values('national-25-text-facts');

create function private.awardping_program_fact_public_values(p_review jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v_result jsonb:='{}'; v_field jsonb; v_values jsonb; v_dates jsonb:='[]'; v_amounts jsonb:='[]'; v_name text;
begin
 for v_field in select value from jsonb_array_elements(p_review->'fields') loop
  v_name:=v_field->>'field';
  select coalesce(jsonb_agg(to_jsonb(case when value->>'track' is null then value->>'value'
   else value->>'track'||': '||(value->>'value') end) order by ord),'[]'::jsonb) into v_values
  from jsonb_array_elements(v_field->'items') with ordinality item(value,ord) where v_field->>'status'='verified';
  v_result:=v_result||jsonb_build_object(v_name,case when v_name in ('overview','deadline','opening_date','cycle_status','application_url')
   then case when jsonb_array_length(v_values)=1 then v_values->0 else 'null'::jsonb end else v_values end);
 end loop;
 v_dates:=coalesce(v_result->'important_dates','[]'::jsonb);
 foreach v_name in array array['deadline','opening_date'] loop
  for v_field in select value from jsonb_array_elements(p_review->'fields') where value->>'field'=v_name and value->>'status'='verified'
   and jsonb_array_length(value->'items')>1 loop
   select v_dates||coalesce(jsonb_agg(to_jsonb((case when v_name='deadline' then 'Application deadline' else 'Opens' end)||' — '||
    (value->>'track')||': '||(value->>'value')) order by ord),'[]'::jsonb) into v_dates
    from jsonb_array_elements(v_field->'items') with ordinality item(value,ord);
  end loop;
 end loop;
 v_amounts:=coalesce(v_result->'award_amounts','[]'::jsonb);
 foreach v_name in array array['stipend','tuition','travel_research_allowance'] loop
  select v_amounts||coalesce(jsonb_agg(to_jsonb((case when v_name='stipend' then 'Stipend' when v_name='tuition' then 'Tuition' else 'Travel/research' end)||': '||
   value) order by ord),'[]'::jsonb) into v_amounts from jsonb_array_elements_text(coalesce(v_result->v_name,'[]'::jsonb)) with ordinality item(value,ord);
 end loop;
 select coalesce(jsonb_agg(value->'field' order by ord),'[]'::jsonb) into v_values
  from jsonb_array_elements(p_review->'fields') with ordinality item(value,ord) where value->>'status'='not_published';
 v_result:=v_result||jsonb_build_object('important_dates',v_dates,'award_amounts',v_amounts,'reviewed_cycle',p_review->'cycle','not_published_fields',v_values);
 select coalesce(jsonb_agg(to_jsonb(case when item->>'track' is null then item->>'value' else item->>'track'||': '||(item->>'value') end) order by ord),'[]'::jsonb)
 into v_values from jsonb_array_elements(p_review->'fields') field,
 lateral jsonb_array_elements(field->'items') with ordinality items(item,ord) where field->>'field'='application_url' and field->>'status'='verified';
 return v_result||jsonb_build_object('application_urls',v_values);
end;
$$;
revoke all on function private.awardping_program_fact_public_values(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_fact_public_values(jsonb) to service_role;

create function private.awardping_program_fact_validation_valid(p_validation jsonb,p_approval boolean)
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
  if not private.awardping_program_source_allowed(v_source.id)
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
revoke all on function private.awardping_program_fact_validation_valid(jsonb,boolean) from public,anon,authenticated;
grant execute on function private.awardping_program_fact_validation_valid(jsonb,boolean) to service_role;

create function public.save_program_text_fact_review(p_validation jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_hash text; v_row public.program_text_fact_reviews%rowtype;
begin
 if length(btrim(coalesce(p_actor,''))) not between 1 and 320 or not private.awardping_program_fact_validation_valid(p_validation,false)
 then raise exception 'Fact draft requires complete current originals and exact support.' using errcode='23514'; end if;
 v_hash:=encode(extensions.digest(convert_to(p_validation::text,'UTF8'),'sha256'),'hex');
 insert into public.program_text_fact_reviews(cohort_key,validation,content_hash,created_by)
 values(p_validation#>>'{review,cohort_key}',p_validation,v_hash,p_actor)
 on conflict(cohort_key,content_hash) do nothing returning * into v_row;
 if v_row.id is null then select * into strict v_row from public.program_text_fact_reviews where cohort_key=p_validation#>>'{review,cohort_key}' and content_hash=v_hash;
 else insert into public.program_text_fact_review_events(action,subject_id,details,actor)
  values('draft_created',v_row.id::text,jsonb_build_object('content_hash',v_hash),p_actor); end if;
 return jsonb_build_object('id',v_row.id,'content_hash',v_row.content_hash,'status',v_row.status);
end;
$$;
create function public.approve_program_text_fact_review(p_id uuid,p_expected_hash text,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.program_text_fact_reviews%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict v_row from public.program_text_fact_reviews where id=p_id for update;
 if length(btrim(coalesce(p_actor,''))) not between 1 and 320 or v_row.content_hash is distinct from p_expected_hash
  or not private.awardping_program_fact_validation_valid(v_row.validation,true)
 then raise exception 'Unresolved, stale or unsupported facts cannot be approved.' using errcode='23514'; end if;
 if v_row.status='draft' then
  update public.program_text_fact_reviews set status='approved',reviewed_by=p_actor,reviewed_at=clock_timestamp() where id=p_id returning * into v_row;
  insert into public.program_text_fact_review_events(action,subject_id,details,actor)
   values('approved',p_id::text,jsonb_build_object('content_hash',v_row.content_hash),p_actor);
 end if;
 return jsonb_build_object('id',v_row.id,'content_hash',v_row.content_hash,'status',v_row.status,'reviewed_at',v_row.reviewed_at);
end;
$$;
-- A collection badge uses the same complete, repeated identity boundary as
-- factual approval. A status string and counter alone are not proof of readiness.
create function private.awardping_program_fact_source_ready(p_id uuid)
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
  and v_ref#>>'{source,id}'=v_source.id::text
  and v_ref#>>'{source,shared_award_id}'=v_source.shared_award_id::text
  and v_ref#>>'{source,url}'=v_source.url
  and (v_state->>'first_captured_at')::timestamptz<(v_ref->>'captured_at')::timestamptz
  and (v_ref->>'captured_at')::timestamptz<=(v_state->>'last_checked_at')::timestamptz,false);
exception when others then return false;
end;
$$;
revoke all on function private.awardping_program_fact_source_ready(uuid) from public,anon,authenticated;
grant execute on function private.awardping_program_fact_source_ready(uuid) to service_role;

create function private.awardping_program_fact_review_current(p_id uuid)
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
  if not private.awardping_program_source_allowed(v_source.id) or v_source.shared_award_id::text is distinct from v_ref#>>'{source,shared_award_id}'
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
revoke all on function private.awardping_program_fact_review_current(uuid) from public,anon,authenticated;
grant execute on function private.awardping_program_fact_review_current(uuid) to service_role;

create function public.publish_program_text_fact_batch(p_expected_revision uuid,p_review_ids jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_release public.program_text_fact_release%rowtype; v_registry public.stage1_award_registry%rowtype; v_row public.program_text_fact_reviews%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict v_release from public.program_text_fact_release where release_key='national-25-text-facts' for update;
 if p_expected_revision is distinct from v_release.revision or length(btrim(coalesce(p_actor,''))) not between 1 and 320
  or jsonb_typeof(p_review_ids) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_review_ids))<>25
  or (select count(*) from public.stage1_award_registry)<>25 then raise exception 'A current exact 25-award batch is required.' using errcode='23514'; end if;
 for v_registry in select * from public.stage1_award_registry order by cohort_key loop
  select * into strict v_row from public.program_text_fact_reviews where id=(p_review_ids->>v_registry.cohort_key)::uuid for share;
  if v_row.cohort_key<>v_registry.cohort_key or v_row.status<>'approved'
   or v_row.validation#>>'{review,award_id}' is distinct from v_registry.canonical_shared_award_id::text
   or (not v_release.is_active or p_review_ids->v_registry.cohort_key is distinct from v_release.review_ids->v_registry.cohort_key)
    and not private.awardping_program_fact_review_current(v_row.id)
  then raise exception 'Every changed award needs its own current approved source-bound facts.' using errcode='23514'; end if;
 end loop;
 if v_release.review_ids=p_review_ids and v_release.is_active then return to_jsonb(v_release); end if;
 update public.program_text_fact_release set revision=gen_random_uuid(),review_ids=p_review_ids,is_active=true,published_by=p_actor,published_at=clock_timestamp()
  where release_key='national-25-text-facts' returning * into v_release;
 insert into public.program_text_fact_review_events(action,subject_id,details,actor)
  values('published',v_release.revision::text,jsonb_build_object('review_ids',p_review_ids),p_actor);
 return to_jsonb(v_release);
end;
$$;
create function public.get_program_text_fact_publication()
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('schema','awardping.program-fact-publication.v1','revision',release.revision,'active',release.is_active,
  'cohorts',coalesce((select jsonb_agg(jsonb_build_object('cohort_key',r.cohort_key,'review_id',r.id,
   'award_id',r.validation#>'{review,award_id}','epoch',r.validation#>'{review,epoch}','reviewed_at',r.reviewed_at,
   'current',private.awardping_program_fact_review_current(r.id),'public_facts',r.validation->'public_facts',
   'source_ids',(select jsonb_agg(ref#>'{source,id}') from jsonb_array_elements(r.validation#>'{review,capture_refs}') ref)) order by r.cohort_key)
   from public.program_text_fact_reviews r where release.is_active and r.id::text in (select jsonb_each_text.value from jsonb_each_text(release.review_ids))),'[]'::jsonb))
 from public.program_text_fact_release release where release.release_key='national-25-text-facts';
$$;
revoke all on function public.save_program_text_fact_review(jsonb,text),public.approve_program_text_fact_review(uuid,text,text),
 public.publish_program_text_fact_batch(uuid,jsonb,text),public.get_program_text_fact_publication() from public,anon,authenticated;
grant execute on function public.save_program_text_fact_review(jsonb,text),public.approve_program_text_fact_review(uuid,text,text),
 public.publish_program_text_fact_batch(uuid,jsonb,text),public.get_program_text_fact_publication() to service_role;

-- Bounded summaries for one admin screen; original text stays private and is
-- fetched for one review at a time, never sent in the 25-award overview.
create function public.get_program_text_fact_review_batch()
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('cohort_key',registry.cohort_key,'award_id',registry.canonical_shared_award_id,
  'name',registry.canonical_name,'slug',registry.canonical_slug,
  'sources',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'url',s.url,'title',s.title,
   'ready',private.awardping_program_fact_source_ready(s.id),
   'state',coalesce(s.text_monitoring_state->>'status','not_captured')) order by s.url)
   from public.shared_award_sources s where s.id in (select unnest(source_ids) from public.program_text_source_roster where cohort_key=registry.cohort_key)),'[]'::jsonb),
  'review',case when latest.id is null then 'null'::jsonb else jsonb_build_object('id',latest.id,'content_hash',latest.content_hash,
   'status',latest.status,'reviewed_at',latest.reviewed_at,'current',private.awardping_program_fact_review_current(latest.id),
   'cycle',latest.validation#>'{review,cycle}','blockers',latest.validation->'blockers',
   'fields',(select jsonb_agg(jsonb_build_object('field',field->'field','status',field->'status','note',field->'note',
    'items',(select coalesce(jsonb_agg(item-'support'),'[]'::jsonb) from jsonb_array_elements(field->'items') item)) order by ord)
    from jsonb_array_elements(latest.validation#>'{review,fields}') with ordinality fields(field,ord))) end) order by registry.launch_rank),'[]'::jsonb)
 from public.stage1_award_registry registry left join lateral
 (select * from public.program_text_fact_reviews where cohort_key=registry.cohort_key order by created_at desc,id desc limit 1) latest on true;
$$;
revoke all on function public.get_program_text_fact_review_batch() from public,anon,authenticated;
grant execute on function public.get_program_text_fact_review_batch() to service_role;
notify pgrst,'reload schema';
