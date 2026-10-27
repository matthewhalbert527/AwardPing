-- Additive text-only inventories/receipts. Existing v1 drafts are never converted.
create table public.program_variation_inventories (
 id uuid primary key default gen_random_uuid(), cohort_key text not null references public.stage1_award_registry(cohort_key),
 cycle text not null check(length(btrim(cycle)) between 1 and 120), revision uuid not null default gen_random_uuid(),
 content_hash text, status text not null default 'draft' check(status in ('draft','sealed')),
 expected_variants integer not null check(expected_variants>=0), previous_revision uuid,
 created_by text not null, created_at timestamptz not null default clock_timestamp(), sealed_at timestamptz,
 check((status='draft' and content_hash is null and sealed_at is null) or (status='sealed' and content_hash ~ '^[a-f0-9]{64}$' and sealed_at is not null))
);
create table public.program_variation_inventory_heads (
 cohort_key text primary key references public.stage1_award_registry(cohort_key),
 inventory_id uuid not null references public.program_variation_inventories(id), revision uuid not null
);
create table public.program_variation_inventory_draft_heads (
 cohort_key text primary key references public.stage1_award_registry(cohort_key),
 inventory_id uuid not null references public.program_variation_inventories(id),revision uuid not null
);
create table public.program_variation_inventory_evidence (
 id uuid primary key default gen_random_uuid(), inventory_id uuid not null references public.program_variation_inventories(id),
 content_hash text not null, validation jsonb not null, created_at timestamptz not null default clock_timestamp(), unique(inventory_id,content_hash)
);
create table public.program_variation_scopes (
 inventory_id uuid not null references public.program_variation_inventories(id), scope_key text not null,
 label text not null check(length(btrim(label)) between 1 and 200), attributes jsonb not null,
 source_roles jsonb not null, provider_support jsonb not null, retired boolean not null,
 evidence_id uuid not null references public.program_variation_inventory_evidence(id),
 primary key(inventory_id,scope_key),
 check(scope_key ~ '^[a-z0-9][a-z0-9_-]{0,127}$' and scope_key<>'legacy_common')
);
create table public.program_variation_unit_reviews (
 id uuid primary key default gen_random_uuid(), inventory_id uuid not null, scope_key text not null,
 unit jsonb not null, validation jsonb not null, content_hash text not null,
 shared_review_id uuid references public.program_variation_unit_reviews(id), shared_hash text,
 created_by text not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(inventory_id,scope_key) references public.program_variation_scopes(inventory_id,scope_key),
 unique(inventory_id,scope_key,content_hash)
);
create index program_variation_unit_latest on public.program_variation_unit_reviews(inventory_id,scope_key,created_at desc,id desc);
create table public.program_variation_award_approvals (
 id uuid primary key default gen_random_uuid(), cohort_key text not null references public.stage1_award_registry(cohort_key),
 inventory_id uuid not null references public.program_variation_inventories(id),
 shared_review_id uuid not null references public.program_variation_unit_reviews(id), child_reviews jsonb not null,
 content_hash text not null, reviewed_by text not null, reviewed_at timestamptz not null default clock_timestamp(), unique(cohort_key,content_hash)
);
create table public.program_variation_release (
 release_key text primary key check(release_key='national-25-provider-variations'), revision uuid not null default gen_random_uuid(),
 approval_ids jsonb not null default '{}', is_active boolean not null default false, published_by text, published_at timestamptz
);
insert into public.program_variation_release(release_key) values('national-25-provider-variations');
create table public.program_variation_review_events (
 id uuid primary key default gen_random_uuid(), action text not null, subject_id uuid not null, details jsonb not null,
 actor text not null, created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
 foreach t in array array['program_variation_inventories','program_variation_inventory_heads','program_variation_inventory_draft_heads','program_variation_inventory_evidence',
 'program_variation_scopes','program_variation_unit_reviews','program_variation_award_approvals','program_variation_release','program_variation_review_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to service_role',t);
 end loop;
end $$;
-- Preserves legacy admission until the separate text-approval migration extends it.
create function private.awardping_program_text_source_access(p_source_id uuid,p_cohort text default null,p_epoch uuid default null)
returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.shared_award_sources s where s.id=p_source_id and s.admin_review_status='open'
 and (p_cohort is null or exists(select 1 from public.stage1_award_members m where m.shared_award_id=s.shared_award_id and m.cohort_key=p_cohort)));
$$;
revoke all on function private.awardping_program_text_source_access(uuid,text,uuid) from public,anon,authenticated;
grant execute on function private.awardping_program_text_source_access(uuid,text,uuid) to service_role;
create function private.awardping_program_text_source_registration_allowed(p_source_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$ select false; $$;
revoke all on function private.awardping_program_text_source_registration_allowed(uuid) from public,anon,authenticated;
grant execute on function private.awardping_program_text_source_registration_allowed(uuid) to service_role;

create function private.awardping_variation_fact_validation_valid(p_inventory uuid,p_scope text,p_validation jsonb,p_approval boolean)
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
 if not exists(select 1 from public.program_variation_inventory_heads h join public.program_variation_inventories i on i.id=h.inventory_id and i.revision=h.revision
 where i.id=p_inventory and i.status='sealed' and i.cohort_key=v_registry.cohort_key and i.cycle=v_review->>'cycle')
 or not exists(select 1 from public.program_variation_scopes s where s.inventory_id=p_inventory and s.scope_key=p_scope and not s.retired) then return false; end if;
 if v_review->>'award_id' is distinct from v_registry.canonical_shared_award_id::text then return false; end if;
 select jsonb_agg(jsonb_build_object('source_role',r->>'source_role','revision',r->'revision','source_ids',r->'source_ids') order by r->>'source_role')
 into v_roster from jsonb_array_elements(private.awardping_variation_roles(p_inventory,p_scope)) r;
 if v_roster is null or v_roster is distinct from
  (select jsonb_agg(value order by value->>'source_role') from jsonb_array_elements(v_review->'roster')) then return false; end if;
 select array_agg(distinct id::uuid order by id::uuid) into v_ids from jsonb_array_elements(private.awardping_variation_roles(p_inventory,p_scope)) r,
  lateral jsonb_array_elements_text(r->'source_ids') id;
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
   or private.awardping_program_fact_known_footer_only_pdf(v_ref)
   or not private.awardping_program_fact_source_ready(v_source.id)
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

create function private.awardping_variation_roles(p_inventory uuid,p_scope text)
returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(role||jsonb_build_object('source_role',s.scope_key||'/'||(role->>'source_role')) order by s.scope_key,role->>'source_role'),'[]')
 from public.program_variation_scopes s cross join lateral jsonb_array_elements(s.source_roles) role
 where s.inventory_id=p_inventory and not s.retired and s.scope_key in ('common',p_scope);
$$;
create function private.awardping_variation_inventory_hash(p_inventory uuid)
returns text language sql stable set search_path='' as $$
 select encode(extensions.digest(convert_to(jsonb_build_object('cohort_key',i.cohort_key,'cycle',i.cycle,
 'expected_variants',i.expected_variants,'previous_revision',i.previous_revision,'scopes',coalesce((select jsonb_agg(
 jsonb_build_object('scope_key',s.scope_key,'label',s.label,'attributes',s.attributes,'source_roles',s.source_roles,
 'provider_support',s.provider_support,'retired',s.retired,'evidence_hash',e.content_hash) order by s.scope_key)
 from public.program_variation_scopes s join public.program_variation_inventory_evidence e on e.id=s.evidence_id
 where s.inventory_id=i.id),'[]'))::text,'UTF8'),'sha256'),'hex') from public.program_variation_inventories i where i.id=p_inventory;
$$;
create function private.awardping_variation_inventory_source_ids(p_inventory uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(id order by id),'[]'::jsonb) from (select distinct sid id from public.program_variation_scopes scope
 cross join lateral jsonb_array_elements(scope.source_roles) role cross join lateral jsonb_array_elements_text(role->'source_ids') sid
 where scope.inventory_id=p_inventory and not scope.retired) ids;
$$;

create function private.awardping_variation_quote_valid(p_quote jsonb,p_docs jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare d jsonb; b jsonb; a integer; z integer;
begin
 if not private.awardping_program_exact_object(p_quote,array['source_id','capture_id','block_id','start_utf16','end_utf16','text'])
  or jsonb_typeof(p_quote->'text') is distinct from 'string' or private.awardping_program_utf16_length(p_quote->>'text') not between 1 and 1600
  or not coalesce(p_quote->>'start_utf16' ~ '^[0-9]+$' and p_quote->>'end_utf16' ~ '^[1-9][0-9]*$',false) then return false; end if;
 select value into strict d from jsonb_array_elements(p_docs) where value#>>'{reference,source,id}'=p_quote->>'source_id'
  and value#>>'{reference,capture_id}'=p_quote->>'capture_id';
 select value into strict b from jsonb_array_elements(d->'blocks') where value->>'id'=p_quote->>'block_id';
 a:=(p_quote->>'start_utf16')::integer; z:=(p_quote->>'end_utf16')::integer;
 return a>=(b->>'start_utf16')::integer and z<=(b->>'end_utf16')::integer and z>a
  and private.awardping_program_utf16_length(p_quote->>'text')=z-a
  and private.awardping_program_utf16_slice(d->>'text',a,z)=p_quote->>'text';
exception when others then return false;
end $$;

create function private.awardping_variation_provider_document_valid(p_doc jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare r jsonb:=p_doc->'reference';b jsonb;cursor_at integer:=0;next_at integer;
begin
 if not private.awardping_program_exact_object(p_doc,array['reference','text','blocks','blocks_json'])
  or not private.awardping_program_text_reference_valid(r)
  or private.awardping_program_fact_known_html_shell(r) or private.awardping_program_fact_known_footer_only_pdf(r)
  or jsonb_typeof(p_doc->'text') is distinct from 'string' or private.awardping_program_utf16_length(p_doc->>'text')<>(r->>'text_length')::integer
  or encode(extensions.digest(convert_to(p_doc->>'text','UTF8'),'sha256'),'hex')<>r->>'text_sha256'
  or jsonb_typeof(p_doc->'blocks') is distinct from 'array' or jsonb_array_length(p_doc->'blocks') not between 1 and 20000
  or jsonb_typeof(p_doc->'blocks_json') is distinct from 'string' or (p_doc->>'blocks_json')::jsonb<>p_doc->'blocks'
  or encode(extensions.digest(convert_to(p_doc->>'blocks_json','UTF8'),'sha256'),'hex')<>r->>'blocks_sha256'
  or (select count(distinct x->>'id') from jsonb_array_elements(p_doc->'blocks') x)<>jsonb_array_length(p_doc->'blocks')
 then return false; end if;
 for b in select value from jsonb_array_elements(p_doc->'blocks') loop
  if not private.awardping_program_block_valid('{"heading":null,"page":null,"kind":null,"context":null}'::jsonb||b,p_doc->>'text') then return false; end if;
  next_at:=(b->>'start_utf16')::integer;
  if next_at<cursor_at or next_at>cursor_at and private.awardping_program_utf16_slice(p_doc->>'text',cursor_at,next_at) ~ '[^[:space:]]' then return false; end if;
  cursor_at:=(b->>'end_utf16')::integer;
 end loop;
 return cursor_at=(r->>'text_length')::integer or private.awardping_program_utf16_slice(p_doc->>'text',cursor_at,(r->>'text_length')::integer) !~ '[^[:space:]]';
exception when others then return false;
end;
$$;

create function private.awardping_variation_provider_proof_valid(p_proof jsonb,p_cohort text)
returns boolean language plpgsql stable set search_path='' as $$
declare d jsonb; ref jsonb; s public.shared_award_sources%rowtype; state jsonb;
begin
 if not private.awardping_program_exact_object(p_proof,array['schema','cohort_key','epoch','source_text'])
  or p_proof->>'schema' is distinct from 'awardping.program-variation-provider-proof.v1' or p_proof->>'cohort_key' is distinct from p_cohort
  or not coalesce(p_proof->>'epoch' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$',false)
  or octet_length(p_proof::text)>33554432 or jsonb_typeof(p_proof->'source_text') is distinct from 'array'
  or jsonb_array_length(p_proof->'source_text') not between 1 and 500
  or (select count(distinct x#>>'{reference,source,id}') from jsonb_array_elements(p_proof->'source_text') x)<>jsonb_array_length(p_proof->'source_text')
 then return false; end if;
 for d in select value from jsonb_array_elements(p_proof->'source_text') loop
  if not private.awardping_variation_provider_document_valid(d) then return false; end if;
  ref:=d->'reference'; select * into strict s from public.shared_award_sources where id=(ref#>>'{source,id}')::uuid; state:=s.text_monitoring_state;
  if not private.awardping_program_text_source_access(s.id,p_cohort,(p_proof->>'epoch')::uuid) or not private.awardping_program_fact_source_ready(s.id)
   or not exists(select 1 from public.stage1_award_members m where m.cohort_key=p_cohort and m.shared_award_id=s.shared_award_id)
   or s.shared_award_id::text is distinct from ref#>>'{source,shared_award_id}' or s.url is distinct from ref#>>'{source,url}'
   or state->>'epoch' is distinct from p_proof->>'epoch' or state#>>'{latest_ref,text_sha256}' is distinct from ref->>'text_sha256'
   or state#>>'{latest_ref,final_url}' is distinct from ref->>'final_url' or state#>>'{latest_ref,acquisition}' is distinct from ref->>'acquisition'
   or state#>'{latest_ref,extractor}' is distinct from ref->'extractor'
  then return false; end if;
 end loop;
 return true;
exception when others then return false;
end $$;

create function public.save_program_variation_unit(p_envelope jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u jsonb:=p_envelope->'unit'; v jsonb:=p_envelope->'validation'; d jsonb; f jsonb; q jsonb;
 parent public.program_variation_unit_reviews%rowtype; saved public.program_variation_unit_reviews%rowtype; h text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if length(btrim(coalesce(p_actor,''))) not between 1 and 320
  or not private.awardping_program_exact_object(p_envelope,array['schema','unit','validation'])
  or p_envelope->>'schema' is distinct from 'awardping.program-variation-validation.v1'
  or not private.awardping_program_exact_object(u,array['schema','inventory_id','scope_key','shared_review_id','shared_hash','reviewed_all_sources','capture_refs','decisions'])
  or u->>'schema' is distinct from 'awardping.program-variation-unit.v1'
  or jsonb_typeof(u->'reviewed_all_sources') is distinct from 'boolean'
  or u->'reviewed_all_sources' is distinct from v#>'{review,reviewed_all_sources}'
  or u->'capture_refs' is distinct from v#>'{review,capture_refs}'
  or octet_length(u::text)>4194304 or jsonb_typeof(u->'decisions') is distinct from 'array' or jsonb_array_length(u->'decisions')<>21
  or (select count(distinct x->>'field') from jsonb_array_elements(u->'decisions') x)<>21
  or not private.awardping_variation_fact_validation_valid((u->>'inventory_id')::uuid,u->>'scope_key',v,false)
 then raise exception 'Invalid or stale bounded variation unit.' using errcode='23514'; end if;
 if u->>'scope_key'='common' then
  if u->'shared_review_id'<>'null' or u->'shared_hash'<>'null' then raise exception 'Shared review cannot inherit.' using errcode='23514'; end if;
 else
  select * into strict parent from public.program_variation_unit_reviews where id=(u->>'shared_review_id')::uuid for share;
  if parent.inventory_id<>(u->>'inventory_id')::uuid or parent.scope_key<>'common' or parent.content_hash is distinct from u->>'shared_hash'
  then raise exception 'Shared review changed.' using errcode='40001'; end if;
 end if;
 for d in select value from jsonb_array_elements(u->'decisions') loop
  select value into strict f from jsonb_array_elements(v#>'{review,fields}') where value->>'field'=d->>'field';
  if d->>'mode'='replace' then
   if not private.awardping_program_exact_object(d,array['field','mode','decision']) or d->'decision' is distinct from f
   then raise exception 'Replacement is not the validated field.' using errcode='23514'; end if;
  elsif d->>'mode'='inherit' and u->>'scope_key'<>'common' then
   if not private.awardping_program_exact_object(d,array['field','mode','support']) or jsonb_typeof(d->'support') is distinct from 'array'
    or jsonb_array_length(d->'support') not between 1 and 12 or f->>'status'='unresolved'
    or not exists(select 1 from jsonb_array_elements(parent.validation#>'{review,fields}') x where x=f)
   then raise exception 'Inheritance requires an exact resolved shared field and applicability evidence.' using errcode='23514'; end if;
   for q in select value from jsonb_array_elements(d->'support') loop
    if not private.awardping_variation_quote_valid(q,v->'source_text') then raise exception 'Unsupported inherited applicability.' using errcode='23514'; end if;
   end loop;
  else raise exception 'Every field needs explicit replace or inherit.' using errcode='23514'; end if;
 end loop;
 h:=encode(extensions.digest(convert_to(p_envelope::text,'UTF8'),'sha256'),'hex');
 insert into public.program_variation_unit_reviews(inventory_id,scope_key,unit,validation,content_hash,shared_review_id,shared_hash,created_by)
 values((u->>'inventory_id')::uuid,u->>'scope_key',u,
  (v-'source_text')||jsonb_build_object('schema','awardping.program-variation-unit-receipt.v1','source_text_hash',encode(extensions.digest(convert_to((v->'source_text')::text,'UTF8'),'sha256'),'hex')),
  h,(u->>'shared_review_id')::uuid,u->>'shared_hash',p_actor)
 on conflict(inventory_id,scope_key,content_hash) do nothing returning * into saved;
 if saved.id is null then select * into strict saved from public.program_variation_unit_reviews
 where inventory_id=(u->>'inventory_id')::uuid and scope_key=u->>'scope_key' and content_hash=h;
 else insert into public.program_variation_review_events(action,subject_id,details,actor) values('unit_saved',saved.id,jsonb_build_object('content_hash',h),p_actor); end if;
 return jsonb_build_object('id',saved.id,'content_hash',saved.content_hash,'scope_key',saved.scope_key,'blockers',saved.validation->'blockers');
end $$;

-- Immutable receipts have already passed complete text/block/quotation proof.
-- Approval checks their live identities/state, not a client-supplied success flag.
create function private.awardping_variation_unit_current(p_id uuid,p_at timestamptz,p_strict_hash boolean)
returns boolean language plpgsql stable set search_path='' as $$
declare u public.program_variation_unit_reviews%rowtype; ref jsonb; s public.shared_award_sources%rowtype;
begin
 select * into strict u from public.program_variation_unit_reviews where id=p_id;
 if not exists(select 1 from public.program_variation_inventory_heads h join public.program_variation_inventories i on i.id=h.inventory_id
  and i.revision=h.revision and i.status='sealed' join public.stage1_award_registry registry on registry.cohort_key=i.cohort_key
  where i.id=u.inventory_id and registry.canonical_shared_award_id::text=u.validation#>>'{review,award_id}') then return false; end if;
 for ref in select value from jsonb_array_elements(u.validation#>'{review,capture_refs}') loop
  select * into strict s from public.shared_award_sources where id=(ref#>>'{source,id}')::uuid;
  if not private.awardping_program_fact_source_ready(s.id)
   or not exists(select 1 from public.stage1_award_members m where m.cohort_key=u.validation#>>'{review,cohort_key}' and m.shared_award_id=s.shared_award_id)
   or s.shared_award_id::text is distinct from ref#>>'{source,shared_award_id}' or s.url is distinct from ref#>>'{source,url}'
   or s.text_monitoring_state->>'epoch' is distinct from u.validation#>>'{review,epoch}'
   or coalesce((s.text_monitoring_state->>'last_program_update_at')::timestamptz>p_at,false)
   or s.text_monitoring_state#>'{latest_ref,extractor}' is distinct from ref->'extractor'
   or s.text_monitoring_state#>>'{latest_ref,acquisition}' is distinct from ref->>'acquisition'
   or p_strict_hash and s.text_monitoring_state#>>'{latest_ref,text_sha256}' is distinct from ref->>'text_sha256'
  then return false; end if;
 end loop;
 return true;
exception when others then return false;
end $$;

create function public.approve_program_variation_award(p_inventory uuid,p_expected_inventory_hash text,p_shared_review uuid,p_shared_hash text,p_child_reviews jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.program_variation_inventories%rowtype; parent public.program_variation_unit_reviews%rowtype; child public.program_variation_unit_reviews%rowtype;
 entry record; m jsonb; h text; result public.program_variation_award_approvals%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict i from public.program_variation_inventories where id=p_inventory for share;
 select * into strict parent from public.program_variation_unit_reviews where id=p_shared_review for share;
 if length(btrim(coalesce(p_actor,''))) not between 1 and 320 or i.status<>'sealed' or i.content_hash is distinct from p_expected_inventory_hash
  or parent.inventory_id<>i.id or parent.scope_key<>'common' or parent.content_hash is distinct from p_shared_hash
  or parent.validation#>'{review,reviewed_all_sources}' is distinct from 'true'::jsonb
  or not private.awardping_variation_unit_current(parent.id,parent.created_at,true)
  or not exists(select 1 from jsonb_array_elements(parent.validation#>'{review,fields}') f where f->>'field'='overview'
   and f->>'status'='verified' and jsonb_array_length(f->'items')=1 and f#>'{items,0,track}'='null')
  or jsonb_typeof(p_child_reviews) is distinct from 'object'
  or (select count(*) from jsonb_object_keys(p_child_reviews))<>i.expected_variants
  or i.expected_variants=0 and exists(select 1 from jsonb_array_elements(parent.validation#>'{review,fields}') f where f->>'status'='unresolved')
 then raise exception 'Award has an incomplete or stale shared/inventory review.' using errcode='23514'; end if;
 for entry in select s.scope_key,p_child_reviews->s.scope_key value from public.program_variation_scopes s
  where s.inventory_id=i.id and s.scope_key<>'common' and not s.retired order by s.scope_key loop
  if not private.awardping_program_exact_object(entry.value,array['id','content_hash']) then raise exception 'Missing variant review.' using errcode='23514'; end if;
  select * into strict child from public.program_variation_unit_reviews where id=(entry.value->>'id')::uuid for share;
  if child.inventory_id<>i.id or child.scope_key<>entry.scope_key or child.content_hash is distinct from entry.value->>'content_hash'
   or child.shared_review_id is distinct from parent.id or child.shared_hash is distinct from parent.content_hash
   or child.validation#>'{review,reviewed_all_sources}' is distinct from 'true'::jsonb
   or not exists(select 1 from jsonb_array_elements(child.validation#>'{review,fields}') f where f->>'field'='overview'
    and f->>'status'='verified' and jsonb_array_length(f->'items')=1 and f#>'{items,0,track}'='null')
   or exists(select 1 from jsonb_array_elements(child.validation#>'{review,fields}') f where f->>'status'='unresolved')
   or not private.awardping_variation_unit_current(child.id,child.created_at,true)
  then raise exception 'Variant review is unresolved, stale or outside the inventory.' using errcode='23514'; end if;
 end loop;
 m:=jsonb_build_object('inventory_id',i.id,'inventory_revision',i.revision,'inventory_hash',i.content_hash,
 'shared',jsonb_build_object('id',parent.id,'content_hash',parent.content_hash),'variants',p_child_reviews);
 h:=encode(extensions.digest(convert_to(m::text,'UTF8'),'sha256'),'hex');
 insert into public.program_variation_award_approvals(cohort_key,inventory_id,shared_review_id,child_reviews,content_hash,reviewed_by)
 values(i.cohort_key,i.id,parent.id,p_child_reviews,h,p_actor) on conflict(cohort_key,content_hash) do nothing returning * into result;
 if result.id is null then select * into strict result from public.program_variation_award_approvals where cohort_key=i.cohort_key and content_hash=h;
 else insert into public.program_variation_review_events(action,subject_id,details,actor) values('award_approved',result.id,jsonb_build_object('content_hash',h,'inventory_hash',i.content_hash),p_actor); end if;
 return to_jsonb(result);
end $$;

create function private.awardping_variation_award_current(p_id uuid)
returns boolean language plpgsql stable set search_path='' as $$
declare a public.program_variation_award_approvals%rowtype; entry jsonb;
begin
 select * into strict a from public.program_variation_award_approvals where id=p_id;
 if not private.awardping_variation_unit_current(a.shared_review_id,a.reviewed_at,false) then return false; end if;
 for entry in select value from jsonb_each(a.child_reviews) loop
  if not private.awardping_variation_unit_current((entry->>'id')::uuid,a.reviewed_at,false) then return false; end if;
 end loop;
 return true;
exception when others then return false;
end $$;

create function public.publish_program_variation_batch(p_expected_revision uuid,p_approval_ids jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.program_variation_release%rowtype; award record; a public.program_variation_award_approvals%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict r from public.program_variation_release where release_key='national-25-provider-variations' for update;
 if length(btrim(coalesce(p_actor,''))) not between 1 and 320 or p_expected_revision is distinct from r.revision
  or jsonb_typeof(p_approval_ids) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_approval_ids))<>25
  or (select count(*) from public.stage1_award_registry)<>25 then raise exception 'Exact current25 manifest required.' using errcode='23514'; end if;
 for award in select * from public.stage1_award_registry order by cohort_key loop
  select * into strict a from public.program_variation_award_approvals where id=(p_approval_ids->>award.cohort_key)::uuid for share;
  if a.cohort_key<>award.cohort_key or not private.awardping_variation_award_current(a.id)
  then raise exception 'Every award needs a current complete variation approval.' using errcode='23514'; end if;
 end loop;
 if r.is_active and r.approval_ids=p_approval_ids then return to_jsonb(r); end if;
 update public.program_variation_release set revision=gen_random_uuid(),approval_ids=p_approval_ids,is_active=true,published_by=p_actor,published_at=clock_timestamp()
 where release_key=r.release_key returning * into r;
 insert into public.program_variation_review_events(action,subject_id,details,actor) values('batch_published',r.revision,jsonb_build_object('approval_ids',p_approval_ids),p_actor);
 return to_jsonb(r);
end $$;

-- Retain v1 read/history compatibility, but never bypass complete variation coverage.
create or replace function public.publish_program_text_fact_batch(p_expected_revision uuid,p_review_ids jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.program_text_fact_release%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict r from public.program_text_fact_release where release_key='national-25-text-facts' for share;
 if r.is_active and r.revision=p_expected_revision and r.review_ids=p_review_ids and length(btrim(coalesce(p_actor,''))) between 1 and 320 then return to_jsonb(r); end if;
 raise exception 'New factual publication requires all25 complete provider-variation manifests.' using errcode='23514';
end $$;

create function public.get_program_variation_admin_page(p_cohort text,p_inventory uuid default null,p_after text default null,p_limit integer default 25)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare i public.program_variation_inventories%rowtype; a public.program_variation_award_approvals%rowtype; page jsonb; last_key text; more boolean;
begin
 if p_limit not between 1 and 25 then raise exception 'Bounded page required.' using errcode='23514'; end if;
 if p_inventory is null then select * into i from public.program_variation_inventories where cohort_key=p_cohort order by created_at desc,id desc limit 1;
 else select * into strict i from public.program_variation_inventories where id=p_inventory and cohort_key=p_cohort; end if;
 if i.id is null then return jsonb_build_object('inventory',null,'scopes','[]'::jsonb,'total',0,'next_cursor',null,'approval',null); end if;
 select jsonb_agg(to_jsonb(s)-'evidence_id'||jsonb_build_object('review',case when u.id is null then null else jsonb_build_object(
 'id',u.id,'scope_key',u.scope_key,'content_hash',u.content_hash,'shared_review_id',u.shared_review_id,'shared_hash',u.shared_hash,
 'blockers',u.validation->'blockers','fields',u.validation#>'{review,fields}','created_at',u.created_at,
 'current',private.awardping_variation_unit_current(u.id,u.created_at,true)) end) order by s.scope_key),max(s.scope_key)
 into page,last_key from (select * from public.program_variation_scopes where inventory_id=i.id and (p_after is null or scope_key>p_after) order by scope_key limit p_limit) s
 left join lateral(select * from public.program_variation_unit_reviews r where r.inventory_id=i.id and r.scope_key=s.scope_key order by created_at desc,id desc limit 1) u on true;
 select exists(select 1 from public.program_variation_scopes where inventory_id=i.id and scope_key>last_key) into more;
 select * into a from public.program_variation_award_approvals where inventory_id=i.id order by reviewed_at desc,id desc limit 1;
 return jsonb_build_object('inventory',to_jsonb(i)||jsonb_build_object('scope_count',(select count(*) from public.program_variation_scopes where inventory_id=i.id),
 'draft_hash',private.awardping_variation_inventory_hash(i.id)),'scopes',coalesce(page,'[]'::jsonb),
 'total',(select count(*) from public.program_variation_scopes where inventory_id=i.id),'next_cursor',case when more then i.revision::text||':'||last_key else null end,
 'approval',case when a.id is null then null else jsonb_build_object('id',a.id,'content_hash',a.content_hash,'reviewed_at',a.reviewed_at,'current',private.awardping_variation_award_current(a.id)) end);
end $$;

create function public.get_program_variation_admin_batch()
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('schema','awardping.program-variation-admin-batch.v1','revision',r.revision,'active',r.is_active,'approval_ids',r.approval_ids,
 'awards',(select jsonb_agg(jsonb_build_object('cohort_key',reg.cohort_key,'approval_id',a.id,'content_hash',a.content_hash,
 'current',case when a.id is null then false else private.awardping_variation_award_current(a.id) end,
 'inventory_id',i.id,'inventory_revision',i.revision,'expected_variants',coalesce(i.expected_variants,0),
 'inventory_sealed',coalesce(i.status='sealed',false),'total_variants',coalesce(i.expected_variants,0),
 'scope_total',(select count(*) from public.program_variation_scopes s where s.inventory_id=i.id and not s.retired),
 'draft_inventory_id',(select d.inventory_id from public.program_variation_inventory_draft_heads d where d.cohort_key=reg.cohort_key),
 'approved_variants',coalesce((select count(*) from jsonb_object_keys(a.child_reviews)),0),
 'current_approved_variants',case when a.id is not null and private.awardping_variation_award_current(a.id) then i.expected_variants else 0 end,
 'approved_source_ids',case when a.id is not null and private.awardping_variation_award_current(a.id) then private.awardping_variation_inventory_source_ids(i.id) else '[]'::jsonb end,
 'source_count',case when a.id is not null and private.awardping_variation_award_current(a.id) then jsonb_array_length(private.awardping_variation_inventory_source_ids(i.id)) else 0 end,
 'source_set_seal',case when a.id is not null and private.awardping_variation_award_current(a.id) then encode(extensions.digest(convert_to(jsonb_build_object(
 'inventory_revision',i.revision,'approval_hash',a.content_hash,'source_ids',private.awardping_variation_inventory_source_ids(i.id))::text,'UTF8'),'sha256'),'hex') else null end,
 'ready_variants',(select count(*) from public.program_variation_scopes s join lateral(select * from public.program_variation_unit_reviews ur
  where ur.inventory_id=i.id and ur.scope_key=s.scope_key order by created_at desc,id desc limit 1) u on true
  where s.inventory_id=i.id and s.scope_key<>'common' and not s.retired and u.validation#>'{review,reviewed_all_sources}'='true'::jsonb
  and not exists(select 1 from jsonb_array_elements(u.validation#>'{review,fields}') field where field->>'status'='unresolved')
  and private.awardping_variation_unit_current(u.id,u.created_at,true)),
 'reviewed_variants',(select count(*) from public.program_variation_scopes s where s.inventory_id=i.id and s.scope_key<>'common' and not s.retired and exists(
 select 1 from public.program_variation_unit_reviews u where u.inventory_id=i.id and u.scope_key=s.scope_key)),
 'blockers',case when i.id is null then jsonb_build_array('provider_inventory_missing') when a.id is null then jsonb_build_array('award_approval_missing')
 when not private.awardping_variation_award_current(a.id) then jsonb_build_array('award_approval_stale') else '[]'::jsonb end) order by reg.cohort_key)
 from public.stage1_award_registry reg left join public.program_variation_inventory_heads h on h.cohort_key=reg.cohort_key
 left join public.program_variation_inventories i on i.id=h.inventory_id and i.revision=h.revision
 left join lateral(select * from public.program_variation_award_approvals aa where aa.inventory_id=i.id order by reviewed_at desc,id desc limit 1) a on true))
 from public.program_variation_release r where r.release_key='national-25-provider-variations';
$$;

create function public.get_program_variation_publication()
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('schema','awardping.program-variation-publication.v1','revision',r.revision,'active',r.is_active,
 'cohorts',coalesce((select jsonb_agg(jsonb_build_object('cohort_key',a.cohort_key,'review_id',a.id,'award_id',registry.canonical_shared_award_id,
 'epoch',u.validation#>'{review,epoch}','reviewed_at',a.reviewed_at,'current',private.awardping_variation_award_current(a.id),
 'public_facts',u.validation->'public_facts','inventory_id',i.id,'inventory_revision',i.revision,'variant_count',i.expected_variants,
 'source_ids',all_sources.ids,'source_count',jsonb_array_length(all_sources.ids),
 'source_bindings',(select jsonb_object_agg(source_id,jsonb_build_object('url',binding->>'source_url','shared_award_id',binding->>'shared_award_id'))
  from (select distinct source_id,role#>array['evidence','source_bindings',source_id] binding
   from public.program_variation_scopes scope cross join lateral jsonb_array_elements(scope.source_roles) role
   cross join lateral jsonb_array_elements_text(role->'source_ids') source_id where scope.inventory_id=i.id and not scope.retired) approved_bindings)) order by a.cohort_key)
 from public.program_variation_award_approvals a join public.stage1_award_registry registry on registry.cohort_key=a.cohort_key
 join public.program_variation_inventories i on i.id=a.inventory_id join public.program_variation_unit_reviews u on u.id=a.shared_review_id
 cross join lateral(select jsonb_agg(id order by id) ids from (select distinct source_id id from public.program_variation_scopes s
 cross join lateral jsonb_array_elements(s.source_roles) role cross join lateral jsonb_array_elements_text(role->'source_ids') source_id
 where s.inventory_id=i.id and not s.retired) unique_ids) all_sources
 where r.is_active and a.id::text in (select value from jsonb_each_text(r.approval_ids))),'[]'::jsonb))
 from public.program_variation_release r where r.release_key='national-25-provider-variations';
$$;

create function public.get_program_variation_public_context(p_cohort text,p_scope text default null,p_after text default null,p_country text default null,p_course text default null,p_track text default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare release public.program_variation_release%rowtype; a public.program_variation_award_approvals%rowtype; i public.program_variation_inventories%rowtype;
 u public.program_variation_unit_reviews%rowtype; options jsonb; selected_meta jsonb; total integer; last_key text; more boolean; selected text:=coalesce(p_scope,'common');
begin
 select * into strict release from public.program_variation_release where release_key='national-25-provider-variations';
 if not release.is_active then return null; end if;
 select * into a from public.program_variation_award_approvals where id=(release.approval_ids->>p_cohort)::uuid;
 if a.id is null then return null; end if;
 select * into strict i from public.program_variation_inventories where id=a.inventory_id;
 if selected='common' then select * into strict u from public.program_variation_unit_reviews where id=a.shared_review_id;
 else
  if not a.child_reviews ? selected then raise exception 'Unknown approved variation.' using errcode='23514'; end if;
  select * into strict u from public.program_variation_unit_reviews where id=(a.child_reviews#>>array[selected,'id'])::uuid;
 end if;
 select jsonb_build_object('scope_key',s.scope_key,'label',s.label,'attributes',s.attributes) into strict selected_meta
 from public.program_variation_scopes s where s.inventory_id=i.id and s.scope_key=selected and not s.retired;
 select count(*) into total from public.program_variation_scopes s where s.inventory_id=i.id and s.scope_key<>'common' and not s.retired
 and (p_country is null or strpos(lower(coalesce(s.attributes->>'country','')),lower(p_country))>0) and (p_course is null or strpos(lower(coalesce(s.attributes->>'course','')),lower(p_course))>0) and (p_track is null or strpos(lower(coalesce(s.attributes->>'track','')),lower(p_track))>0);
 select jsonb_agg(jsonb_build_object('scope_key',scope_key,'label',label,'attributes',attributes) order by scope_key),max(scope_key) into options,last_key
 from (select * from public.program_variation_scopes s where s.inventory_id=i.id and s.scope_key<>'common' and not s.retired
 and (p_after is null or s.scope_key>p_after) and (p_country is null or strpos(lower(coalesce(s.attributes->>'country','')),lower(p_country))>0)
 and (p_course is null or strpos(lower(coalesce(s.attributes->>'course','')),lower(p_course))>0) and (p_track is null or strpos(lower(coalesce(s.attributes->>'track','')),lower(p_track))>0) order by s.scope_key limit 25) page;
 select exists(select 1 from public.program_variation_scopes s where s.inventory_id=i.id and s.scope_key<>'common' and not s.retired
 and s.scope_key>last_key and (p_country is null or strpos(lower(coalesce(s.attributes->>'country','')),lower(p_country))>0) and (p_course is null or strpos(lower(coalesce(s.attributes->>'course','')),lower(p_course))>0)
 and (p_track is null or strpos(lower(coalesce(s.attributes->>'track','')),lower(p_track))>0)) into more;
 return jsonb_build_object('inventory_id',i.id,'revision',i.revision,'cycle',i.cycle,'total',total,
 'next_cursor',case when more then i.revision::text||':'||last_key else null end,'options',coalesce(options,'[]'::jsonb),
 'selected_scope_key',selected,'selected_option',selected_meta,'public_facts',u.validation->'public_facts','current',private.awardping_variation_award_current(a.id),'reviewed_at',a.reviewed_at,
 'source_ids',(select jsonb_agg(value#>'{source,id}' order by value#>>'{source,id}') from jsonb_array_elements(u.validation#>'{review,capture_refs}')),
 'source_bindings',(select jsonb_object_agg(value#>>'{source,id}',jsonb_build_object('url',value#>>'{source,url}',
  'shared_award_id',value#>>'{source,shared_award_id}','title',value#>'{source,title}','page_type',value#>'{source,page_type}'))
  from jsonb_array_elements(u.validation#>'{review,capture_refs}')));
end $$;


-- Collection authority remains exact-source/owner/role bound. No legacy source
-- status is changed and a draft inventory has no collection authority.
create or replace function private.awardping_program_source_allowed(p_source_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.shared_award_sources s join public.shared_awards a on a.id=s.shared_award_id and a.status='active'
 join public.stage1_award_members member on member.shared_award_id=s.shared_award_id
 where s.id=p_source_id and private.awardping_program_text_source_access(s.id,member.cohort_key) and not exists(
 select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=member.cohort_key and
 ((r.url_pattern is not null and s.url ~* r.url_pattern) or (r.title_pattern is not null and concat_ws(' ',s.title,s.display_title) ~* r.title_pattern)))
 and (exists(select 1 from public.program_text_source_roster m where m.cohort_key=member.cohort_key and s.id=any(m.source_ids)
 and not exists(select 1 from public.program_variation_inventory_heads h join public.program_variation_inventories i on i.id=h.inventory_id
  and i.revision=h.revision and i.status='sealed' where h.cohort_key=member.cohort_key)
 and m.evidence#>>array['source_bindings',s.id::text,'source_url']=s.url
 and m.evidence#>>array['source_bindings',s.id::text,'shared_award_id']=s.shared_award_id::text)
 or exists(select 1 from public.program_variation_inventories i join public.program_variation_scopes v on v.inventory_id=i.id and not v.retired
 cross join lateral jsonb_array_elements(v.source_roles) role where i.status='sealed' and i.cohort_key=member.cohort_key and role->'source_ids' ? s.id::text
 and (exists(select 1 from public.program_variation_inventory_heads h where h.inventory_id=i.id and h.revision=i.revision and h.cohort_key=i.cohort_key)
 or exists(select 1 from public.program_variation_release release join public.program_variation_award_approvals approval
 on approval.id::text=release.approval_ids->>i.cohort_key where release.is_active and approval.inventory_id=i.id and approval.cohort_key=i.cohort_key))
 and role#>>array['evidence','source_bindings',s.id::text,'source_url']=s.url
 and role#>>array['evidence','source_bindings',s.id::text,'shared_award_id']=s.shared_award_id::text)))
 or private.awardping_program_text_source_registration_allowed(p_source_id);
$$;

create function public.create_program_variation_inventory(p_cohort text,p_cycle text,p_expected_variants integer,p_previous_revision uuid,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.program_variation_inventories%rowtype; current_revision uuid;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if length(btrim(coalesce(p_actor,''))) not between 1 and 320 or length(btrim(coalesce(p_cycle,''))) not between 1 and 120
  or p_expected_variants is null or p_expected_variants<0 then raise exception 'Invalid inventory header.' using errcode='23514'; end if;
 select revision into current_revision from public.program_variation_inventory_heads where cohort_key=p_cohort;
 if current_revision is distinct from p_previous_revision then raise exception 'Inventory head changed.' using errcode='40001'; end if;
 insert into public.program_variation_inventories(cohort_key,cycle,expected_variants,previous_revision,created_by)
 values(p_cohort,p_cycle,p_expected_variants,p_previous_revision,p_actor) returning * into i;
 insert into public.program_variation_inventory_draft_heads(cohort_key,inventory_id,revision) values(i.cohort_key,i.id,i.revision)
 on conflict(cohort_key) do update set inventory_id=excluded.inventory_id,revision=excluded.revision;
 insert into public.program_variation_review_events(action,subject_id,details,actor) values('inventory_created',i.id,jsonb_build_object('revision',i.revision),p_actor);
 return to_jsonb(i)||jsonb_build_object('scope_count',0,'draft_hash',private.awardping_variation_inventory_hash(i.id));
end $$;

create function public.append_program_variation_scopes(p_inventory uuid,p_expected_revision uuid,p_scopes jsonb,p_provider_validation jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.program_variation_inventories%rowtype; s jsonb; r jsonb; q jsonb; b jsonb; sid uuid;
 src public.shared_award_sources%rowtype; eid uuid; eh text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict i from public.program_variation_inventories where id=p_inventory for update;
 if i.status<>'draft' or i.revision is distinct from p_expected_revision or not exists(select 1 from public.program_variation_inventory_draft_heads h
 where h.inventory_id=i.id and h.revision=i.revision and h.cohort_key=i.cohort_key) then raise exception 'Immutable or stale inventory.' using errcode='40001'; end if;
 if length(btrim(coalesce(p_actor,''))) not between 1 and 320 or jsonb_typeof(p_scopes) is distinct from 'array'
  or jsonb_array_length(p_scopes) not between 1 and 25 or octet_length(p_scopes::text)>4194304
  or not private.awardping_variation_provider_proof_valid(p_provider_validation,i.cohort_key)
 then raise exception 'Inventory requires current original provider-index evidence.' using errcode='23514'; end if;
 eh:=encode(extensions.digest(convert_to(p_provider_validation::text,'UTF8'),'sha256'),'hex');
 insert into public.program_variation_inventory_evidence(inventory_id,content_hash,validation) values(i.id,eh,p_provider_validation)
 on conflict(inventory_id,content_hash) do nothing;
 select id into strict eid from public.program_variation_inventory_evidence where inventory_id=i.id and content_hash=eh;
 for s in select value from jsonb_array_elements(p_scopes) loop
  if not private.awardping_program_exact_object(s,array['scope_key','label','attributes','source_roles','provider_support','retired'])
   or not coalesce(s->>'scope_key' ~ '^[a-z0-9][a-z0-9_-]{0,127}$',false) or s->>'scope_key'='legacy_common'
   or jsonb_typeof(s->'label') is distinct from 'string' or not coalesce(length(btrim(s->>'label')) between 1 and 200,false) or jsonb_typeof(s->'retired') is distinct from 'boolean'
   or not private.awardping_program_exact_object(s->'attributes',array['country','course','track','applicant_group'])
   or exists(select 1 from jsonb_each(s->'attributes') a where jsonb_typeof(a.value)<>'null' and
    (jsonb_typeof(a.value)<>'string' or length(btrim(a.value#>>'{}')) not between 1 and 200))
   or s->>'scope_key'='common' and ((s->>'retired')::boolean or s->'attributes'<>'{"country":null,"course":null,"track":null,"applicant_group":null}')
   or jsonb_typeof(s->'source_roles') is distinct from 'array' or jsonb_array_length(s->'source_roles') not between 1 and 50
   or (select count(distinct x->>'source_role') from jsonb_array_elements(s->'source_roles') x)<>jsonb_array_length(s->'source_roles')
   or jsonb_typeof(s->'provider_support') is distinct from 'array' or jsonb_array_length(s->'provider_support') not between 1 and 12
  then raise exception 'Invalid bounded provider scope.' using errcode='23514'; end if;
  for q in select value from jsonb_array_elements(s->'provider_support') loop
   if not private.awardping_variation_quote_valid(q,p_provider_validation->'source_text') then raise exception 'Provider scope quote is unsupported.' using errcode='23514'; end if;
  end loop;
  for r in select value from jsonb_array_elements(s->'source_roles') loop
   if not private.awardping_program_exact_object(r,array['source_role','revision','source_ids','manifest_status','evidence'])
    or not coalesce(r->>'source_role' ~ '^[a-z][a-z0-9_]{0,79}$',false) or not coalesce(r->>'revision' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$',false)
    or r->>'manifest_status' is distinct from 'reviewed_text' or jsonb_typeof(r->'source_ids') is distinct from 'array' or jsonb_array_length(r->'source_ids') not between 1 and 50
    or (select count(distinct x) from jsonb_array_elements(r->'source_ids') x)<>jsonb_array_length(r->'source_ids')
    or not private.awardping_program_exact_object(r->'evidence',array['schema','source_bindings']) or r#>>'{evidence,schema}' is distinct from 'awardping.program-text-source-role.v1'
    or jsonb_typeof(r#>'{evidence,source_bindings}') is distinct from 'object'
    or (select count(*) from jsonb_object_keys(r#>'{evidence,source_bindings}'))<>jsonb_array_length(r->'source_ids')
   then raise exception 'Invalid scope source role.' using errcode='23514'; end if;
   for sid in select value::uuid from jsonb_array_elements_text(r->'source_ids') loop
    select * into strict src from public.shared_award_sources where id=sid for share;
    b:=r#>array['evidence','source_bindings',sid::text];
    if not private.awardping_program_text_source_access(src.id,i.cohort_key) or not exists(select 1 from public.shared_awards a where a.id=src.shared_award_id and a.status='active')
     or not exists(select 1 from public.stage1_award_members m where m.cohort_key=i.cohort_key and m.shared_award_id=src.shared_award_id)
     or exists(select 1 from public.stage1_award_source_identity_rules x where x.cohort_key=i.cohort_key and
      ((x.url_pattern is not null and src.url ~* x.url_pattern) or (x.title_pattern is not null and concat_ws(' ',src.title,src.display_title) ~* x.title_pattern)))
     or not private.awardping_program_exact_object(b,array['source_url','shared_award_id','authority_url','review_note'])
     or b->>'source_url' is distinct from src.url or b->>'shared_award_id' is distinct from src.shared_award_id::text
     or jsonb_typeof(b->'authority_url') is distinct from 'string' or not coalesce(b->>'authority_url' ~ '^https://[^[:space:]]+$',false) or length(b->>'authority_url')>4000
     or jsonb_typeof(b->'review_note') is distinct from 'string' or not coalesce(length(btrim(b->>'review_note')) between 20 and 2000,false)
    then raise exception 'Scope source ownership or authority changed.' using errcode='23514'; end if;
   end loop;
  end loop;
  if (select count(distinct source_entries.source_value) from jsonb_array_elements(s->'source_roles') as role_entries(role_value)
   cross join lateral jsonb_array_elements_text(role_entries.role_value->'source_ids') as source_entries(source_value))>500
  then raise exception 'Bounded scope exceeds source limit.' using errcode='23514'; end if;
  insert into public.program_variation_scopes(inventory_id,scope_key,label,attributes,source_roles,provider_support,retired,evidence_id)
  values(i.id,s->>'scope_key',s->>'label',s->'attributes',s->'source_roles',s->'provider_support',(s->>'retired')::boolean,eid);
 end loop;
 update public.program_variation_inventories set revision=gen_random_uuid() where id=i.id returning * into i;
 update public.program_variation_inventory_draft_heads set revision=i.revision where inventory_id=i.id;
 insert into public.program_variation_review_events(action,subject_id,details,actor) values('scopes_appended',i.id,jsonb_build_object('count',jsonb_array_length(p_scopes),'revision',i.revision),p_actor);
 return to_jsonb(i)||jsonb_build_object('scope_count',(select count(*) from public.program_variation_scopes where inventory_id=i.id),'draft_hash',private.awardping_variation_inventory_hash(i.id));
end $$;

create function private.awardping_variation_inventory_sources_current(p_inventory uuid)
returns boolean language plpgsql stable set search_path='' as $$
declare i public.program_variation_inventories%rowtype; binding record; s public.shared_award_sources%rowtype; evidence record; ref jsonb;
begin
 select * into strict i from public.program_variation_inventories where id=p_inventory;
 for binding in select role,sid from public.program_variation_scopes scope cross join lateral jsonb_array_elements(scope.source_roles) role
 cross join lateral jsonb_array_elements_text(role->'source_ids') sid where scope.inventory_id=i.id and not scope.retired loop
  select * into strict s from public.shared_award_sources where id=binding.sid::uuid;
  if not private.awardping_program_text_source_access(s.id,i.cohort_key)
   or not exists(select 1 from public.shared_awards a where a.id=s.shared_award_id and a.status='active')
   or not exists(select 1 from public.stage1_award_members m where m.cohort_key=i.cohort_key and m.shared_award_id=s.shared_award_id)
   or binding.role#>>array['evidence','source_bindings',s.id::text,'source_url'] is distinct from s.url
   or binding.role#>>array['evidence','source_bindings',s.id::text,'shared_award_id'] is distinct from s.shared_award_id::text
   or exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=i.cohort_key and
    ((r.url_pattern is not null and s.url ~* r.url_pattern) or (r.title_pattern is not null and concat_ws(' ',s.title,s.display_title) ~* r.title_pattern)))
  then return false; end if;
 end loop;
 for evidence in select e.validation from public.program_variation_inventory_evidence e where e.inventory_id=i.id loop
  for ref in select value->'reference' from jsonb_array_elements(evidence.validation->'source_text') loop
   select * into strict s from public.shared_award_sources where id=(ref#>>'{source,id}')::uuid;
   if not private.awardping_program_fact_source_ready(s.id) or s.url is distinct from ref#>>'{source,url}'
    or s.shared_award_id::text is distinct from ref#>>'{source,shared_award_id}'
    or s.text_monitoring_state->>'epoch' is distinct from evidence.validation->>'epoch'
    or s.text_monitoring_state#>>'{latest_ref,text_sha256}' is distinct from ref->>'text_sha256'
    or s.text_monitoring_state#>>'{latest_ref,acquisition}' is distinct from ref->>'acquisition'
    or s.text_monitoring_state#>'{latest_ref,extractor}' is distinct from ref->'extractor' then return false; end if;
  end loop;
 end loop;
 return not exists(select 1 from public.program_variation_scopes v where v.inventory_id=i.id and not v.retired and
  (select count(distinct sid) from jsonb_array_elements(private.awardping_variation_roles(i.id,v.scope_key)) role
   cross join lateral jsonb_array_elements_text(role->'source_ids') sid)>500);
exception when others then return false;
end $$;

create function public.seal_program_variation_inventory(p_inventory uuid,p_expected_revision uuid,p_expected_hash text,p_complete_provider_inventory_reviewed boolean,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.program_variation_inventories%rowtype; h uuid; actual_hash text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict i from public.program_variation_inventories where id=p_inventory for update;
 select revision into h from public.program_variation_inventory_heads where cohort_key=i.cohort_key;
 actual_hash:=private.awardping_variation_inventory_hash(i.id);
 if i.status<>'draft' or i.revision is distinct from p_expected_revision or h is distinct from i.previous_revision
  or not exists(select 1 from public.program_variation_inventory_draft_heads d where d.inventory_id=i.id and d.revision=i.revision and d.cohort_key=i.cohort_key)
  or actual_hash is distinct from p_expected_hash or p_complete_provider_inventory_reviewed is distinct from true
  or not private.awardping_variation_inventory_sources_current(i.id)
  or length(btrim(coalesce(p_actor,''))) not between 1 and 320
  or not exists(select 1 from public.program_variation_scopes where inventory_id=i.id and scope_key='common' and not retired)
  or (select count(*) from public.program_variation_scopes where inventory_id=i.id and scope_key<>'common' and not retired)<>i.expected_variants
  or exists(select 1 from public.program_variation_inventory_heads oldh join public.program_variation_scopes oldscope on oldscope.inventory_id=oldh.inventory_id
    where oldh.cohort_key=i.cohort_key and oldscope.scope_key<>'common' and not exists(select 1 from public.program_variation_scopes ns where ns.inventory_id=i.id and ns.scope_key=oldscope.scope_key))
 then raise exception 'Inventory is incomplete, stale or lacks explicit retirement history.' using errcode='23514'; end if;
 update public.program_variation_inventories set status='sealed',content_hash=actual_hash,sealed_at=clock_timestamp() where id=i.id returning * into i;
 insert into public.program_variation_inventory_heads(cohort_key,inventory_id,revision) values(i.cohort_key,i.id,i.revision)
 on conflict(cohort_key) do update set inventory_id=excluded.inventory_id,revision=excluded.revision;
 delete from public.program_variation_inventory_draft_heads where inventory_id=i.id;
 insert into public.program_variation_review_events(action,subject_id,details,actor) values('inventory_sealed',i.id,jsonb_build_object('content_hash',actual_hash,'revision',i.revision),p_actor);
 return to_jsonb(i)||jsonb_build_object('scope_count',(select count(*) from public.program_variation_scopes where inventory_id=i.id));
end $$;

-- All privileged entry points require the existing admin server's service role.
-- No browser role can insert/update these records or execute an approval RPC.
do $$ declare grant_entry record; begin
 for grant_entry in select namespace_rows.nspname,proc_rows.oid::regprocedure signature from pg_catalog.pg_proc proc_rows
 join pg_catalog.pg_namespace namespace_rows on namespace_rows.oid=proc_rows.pronamespace
 where (namespace_rows.nspname='private' and proc_rows.proname like 'awardping_variation_%') or (namespace_rows.nspname='public' and proc_rows.proname in (
 'create_program_variation_inventory','append_program_variation_scopes','seal_program_variation_inventory','save_program_variation_unit',
 'approve_program_variation_award','publish_program_variation_batch','get_program_variation_admin_page','get_program_variation_admin_batch','get_program_variation_publication','get_program_variation_public_context')) loop
  execute format('revoke all on function %s from public,anon,authenticated',grant_entry.signature);
  execute format('grant execute on function %s to service_role',grant_entry.signature);
 end loop;
end $$;
notify pgrst,'reload schema';
