-- Distinct current-basic purpose. No legacy full-approval or alert-decision
-- function is broadened. Repeats are immutable service-attested retained objects.
create table public.program_basic_repeat_observations (
 id uuid primary key default gen_random_uuid(), cohort_key text not null references public.stage1_award_registry(cohort_key),
 source_id uuid not null references public.shared_award_sources(id), epoch uuid not null,
 current_ref jsonb not null, repeat_ref jsonb not null, content_identity jsonb not null,
 current_ref_hash text not null check(current_ref_hash ~ '^[a-f0-9]{64}$'), repeat_ref_hash text not null check(repeat_ref_hash ~ '^[a-f0-9]{64}$'),
 verified_at timestamptz not null, created_at timestamptz not null default clock_timestamp(), actor text not null,
 unique(cohort_key,source_id,current_ref_hash,repeat_ref_hash)
);
alter table public.program_basic_repeat_observations enable row level security;
revoke all on public.program_basic_repeat_observations from public,anon,authenticated,service_role;
grant select on public.program_basic_repeat_observations to service_role;
create function private.awardping_basic_repeat_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Retained repeat observations are immutable.' using errcode='23514';end;$$;
create trigger basic_repeat_immutable before update or delete on public.program_basic_repeat_observations for each row execute function private.awardping_basic_repeat_immutable();
create trigger basic_repeat_no_truncate before truncate on public.program_basic_repeat_observations for each statement execute function private.awardping_basic_repeat_immutable();

create function private.awardping_basic_content_identity(r jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('source',jsonb_build_object('id',r#>'{source,id}','shared_award_id',r#>'{source,shared_award_id}','url',r#>'{source,url}'),
 'final_url',r->'final_url','acquisition',r->'acquisition','extractor',r->'extractor','text_sha256',r->'text_sha256','blocks_sha256',r->'blocks_sha256',
 'pdf_raw_sha256',case when r->>'acquisition' like 'pdf_%' then r#>'{artifacts,raw,sha256}' else 'null'::jsonb end);
$$;

create function private.awardping_current_basic_pending_review(p_source uuid) returns jsonb language sql stable set search_path='' as $$
 select case when count(*)=1 then (jsonb_agg(jsonb_build_object('id',r.id,'candidate_id',c.id,'source_id',s.id,'owner_id',s.shared_award_id,
 'source_url',s.url,'epoch',c.worker_metadata->'epoch','candidate_scope',c.candidate_scope,'candidate_status',c.status,
 'candidate_signature',c.candidate_signature,'previous_ref',c.previous_snapshot_ref,'current_ref',c.new_snapshot_ref,
 'review_status',r.status,'content_hash',r.content_hash,'expected_content_hash',private.program_text_alert_hash(c,r.details,r.localization)))->0) else null end
 from public.shared_award_sources s join public.shared_award_visual_review_candidates c on c.shared_award_source_id=s.id
 join public.program_text_alert_reviews r on r.id=c.id
 where s.id=p_source and s.text_monitoring_state->>'status'='awaiting_review' and c.candidate_scope='program_text_change'
 and c.status='succeeded' and r.status='pending' and c.shared_award_id=s.shared_award_id and c.source_url=s.url
 and c.worker_metadata->>'monitoring_contract'='program-text-v1' and c.worker_metadata->>'epoch'=s.text_monitoring_state->>'epoch'
 and c.worker_metadata->>'evidence_signature'=c.candidate_signature and c.worker_metadata->>'admin_alert_review_id'=r.id::text
 and c.ai_result#>>'{program_text_validation,status}'='accepted'
 and c.previous_snapshot_ref=s.text_monitoring_state->'baseline_ref' and c.new_snapshot_ref=s.text_monitoring_state->'latest_ref'
 and r.content_hash=private.program_text_alert_hash(c,r.details,r.localization) and r.candidate_signature=c.candidate_signature;
$$;

create function private.awardping_current_basic_source_ready(p_source uuid,p_cohort text,p_epoch uuid,p_ref jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare s public.shared_award_sources%rowtype;v jsonb;
begin
 select * into strict s from public.shared_award_sources where id=p_source;v:=s.text_monitoring_state;
 if not private.awardping_program_text_reference_valid(p_ref) or not private.awardping_program_text_source_access(s.id,p_cohort,p_epoch)
  or not private.awardping_program_text_collection_quality_ready(s.id,p_epoch)
  or not exists(select 1 from public.stage1_award_members m where m.cohort_key=p_cohort and m.shared_award_id=s.shared_award_id)
  or not exists(select 1 from public.program_text_source_roster r where r.cohort_key=p_cohort and s.id=any(r.source_ids))
  or not exists(select 1 from public.program_text_source_authority_epochs e where e.active and e.epoch=p_epoch)
  or exists(select 1 from public.program_text_source_roster r where r.cohort_key=p_cohort and s.id=any(r.source_ids) and
   (r.manifest_status is distinct from 'reviewed_text' or r.evidence->>'schema' is distinct from 'awardping.program-text-source-role.v1'
    or r.evidence#>>array['source_bindings',s.id::text,'source_url'] is distinct from s.url
    or r.evidence#>>array['source_bindings',s.id::text,'shared_award_id'] is distinct from s.shared_award_id::text))
  or v->>'schema' is distinct from 'awardping.program-text-state.v1' or v->>'epoch' is distinct from p_epoch::text
  or not coalesce((v->>'successful_checks')::integer>=2,false) or v->'latest_ref' is distinct from p_ref
  or p_ref#>>'{source,id}' is distinct from s.id::text or p_ref#>>'{source,shared_award_id}' is distinct from s.shared_award_id::text
  or p_ref#>>'{source,url}' is distinct from s.url
  or not coalesce((v->>'first_captured_at')::timestamptz<(p_ref->>'captured_at')::timestamptz
    and (p_ref->>'captured_at')::timestamptz<=(v->>'last_checked_at')::timestamptz,false) then return false;end if;
 if v->>'status'='baseline_ready' then return coalesce(v->'baseline_ref'=v->'latest_ref',false);end if;
 return coalesce(v->>'status'='awaiting_review' and private.awardping_current_basic_pending_review(s.id) is not null,false);
exception when others then return false;end;$$;

create function private.awardping_basic_repeat_document_valid(d jsonb) returns boolean language plpgsql stable set search_path='' as $$
declare r jsonb:=d->'reference';b jsonb;c integer:=0;a integer;z integer;
begin
 if not private.awardping_program_exact_object(d,array['reference','text','blocks','blocks_json']) or not private.awardping_program_text_reference_valid(r)
 or jsonb_typeof(d->'text') is distinct from 'string' or jsonb_typeof(d->'blocks_json') is distinct from 'string' or private.awardping_program_utf16_length(d->>'text')<>(r->>'text_length')::integer
 or encode(extensions.digest(convert_to(d->>'text','UTF8'),'sha256'),'hex')<>r->>'text_sha256'
 or jsonb_typeof(d->'blocks')<>'array' or jsonb_array_length(d->'blocks') not between 1 and 20000
 or (d->>'blocks_json')::jsonb is distinct from d->'blocks' or encode(extensions.digest(convert_to(d->>'blocks_json','UTF8'),'sha256'),'hex')<>r->>'blocks_sha256'
 or (select count(distinct value->>'id') from jsonb_array_elements(d->'blocks'))<>jsonb_array_length(d->'blocks') then return false;end if;
 for b in select value from jsonb_array_elements(d->'blocks') loop
  if not private.awardping_program_block_valid('{"heading":null,"page":null,"kind":null,"context":null}'::jsonb||b,d->>'text') then return false;end if;
  a:=(b->>'start_utf16')::integer;z:=(b->>'end_utf16')::integer;
  if a<c or a>c and private.awardping_program_utf16_slice(d->>'text',c,a) ~ '[^[:space:]]' then return false;end if;c:=z;
 end loop;
 return c=(r->>'text_length')::integer or private.awardping_program_utf16_slice(d->>'text',c,(r->>'text_length')::integer) !~ '[^[:space:]]';
exception when others then return false;end;$$;

create function public.attest_program_basic_repeat(p_cohort_key text,p_current_ref jsonb,p_repeat_document jsonb,p_verified_at timestamptz,p_actor text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb:=p_repeat_document->'reference';sid uuid:=(p_current_ref#>>'{source,id}')::uuid;v public.program_basic_repeat_observations%rowtype;ch text;rh text;
begin
 if octet_length(p_repeat_document::text)>33554432 or length(btrim(coalesce(p_actor,''))) not between 1 and 320
 or not coalesce(p_verified_at between clock_timestamp()-interval '15 minutes' and clock_timestamp(),false) then raise exception 'Fresh bounded cold-retention attestation required.' using errcode='23514';end if;
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform 1 from public.shared_award_sources where id=sid for share;
 if not private.awardping_current_basic_source_ready(sid,p_cohort_key,(select epoch from public.program_text_source_authority_epochs where active),p_current_ref)
 or not private.awardping_basic_repeat_document_valid(p_repeat_document)
 or private.awardping_basic_content_identity(r) is distinct from private.awardping_basic_content_identity(p_current_ref)
 or r->>'capture_id'=p_current_ref->>'capture_id' or r->>'captured_at'=p_current_ref->>'captured_at'
 or r#>>'{artifacts,metadata,object_key}'=p_current_ref#>>'{artifacts,metadata,object_key}'
 or greatest((r->>'captured_at')::timestamptz,(p_current_ref->>'captured_at')::timestamptz)>p_verified_at
 then raise exception 'Independent retained repeat of current complete source is unconfirmed.' using errcode='23514';end if;
 ch:=encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(p_current_ref),'UTF8'),'sha256'),'hex');
 rh:=encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(r),'UTF8'),'sha256'),'hex');
 select * into v from public.program_basic_repeat_observations where cohort_key=p_cohort_key and source_id=sid and current_ref_hash=ch and repeat_ref_hash=rh;
 if found then
  if v.current_ref<>p_current_ref or v.repeat_ref<>r or v.actor<>p_actor or v.verified_at<>p_verified_at then raise exception 'Repeat attestation replay differs.' using errcode='40001';end if;
  return jsonb_build_object('ok',true,'id',v.id,'already_applied',true);
 end if;
 insert into public.program_basic_repeat_observations(cohort_key,source_id,epoch,current_ref,repeat_ref,content_identity,current_ref_hash,repeat_ref_hash,verified_at,actor)
 values(p_cohort_key,sid,(select epoch from public.program_text_source_authority_epochs where active),p_current_ref,r,private.awardping_basic_content_identity(p_current_ref),ch,rh,p_verified_at,p_actor) returning * into v;
 return jsonb_build_object('ok',true,'id',v.id,'already_applied',false);
end;$$;

create function private.awardping_current_basic_proofs_valid(v_review jsonb,p_proofs jsonb) returns boolean language plpgsql stable set search_path='' as $$
declare p jsonb;r jsonb;o public.program_basic_repeat_observations%rowtype;pending jsonb;
begin
 if jsonb_typeof(p_proofs) is distinct from 'array' or jsonb_array_length(p_proofs)<>jsonb_array_length(v_review->'capture_refs')
 or (select count(distinct value->>'source_id') from jsonb_array_elements(p_proofs))<>jsonb_array_length(p_proofs) then return false;end if;
 for r in select value from jsonb_array_elements(v_review->'capture_refs') loop
  select value into strict p from jsonb_array_elements(p_proofs) where value->>'source_id'=r#>>'{source,id}';
  if not private.awardping_program_exact_object(p,array['source_id','repeat_observation_id','pending_alert_review_id','pending_alert_review_hash']) then return false;end if;
  select * into strict o from public.program_basic_repeat_observations where id=(p->>'repeat_observation_id')::uuid;
  if o.source_id::text<>r#>>'{source,id}' or o.cohort_key<>v_review->>'cohort_key' or o.epoch::text<>v_review->>'epoch'
    or o.content_identity is distinct from private.awardping_basic_content_identity(r) then return false;end if;
  pending:=private.awardping_current_basic_pending_review(o.source_id);
  if pending is null then if p->'pending_alert_review_id'<>'null'::jsonb or p->'pending_alert_review_hash'<>'null'::jsonb then return false;end if;
  elsif pending->'id' is distinct from p->'pending_alert_review_id' or pending->'content_hash' is distinct from p->'pending_alert_review_hash' then return false;end if;
 end loop;
 return true;
exception when others then return false;end;$$;
create function private.awardping_current_basic_validation_valid(p_validation jsonb)
returns boolean language plpgsql stable set search_path='' as $$
declare p_approval boolean:=false; v_review jsonb:=p_validation->'review'; v_registry public.stage1_award_registry%rowtype;
 v_roster jsonb; v_ids uuid[]; v_doc jsonb; v_ref jsonb; v_source public.shared_award_sources%rowtype;
 v_state jsonb; v_field jsonb; v_item jsonb; v_quote jsonb; v_block jsonb; v_cursor integer; v_start integer; v_end integer; v_supported_years text[];
 v_fields text[]:=array['overview','opening_date','deadline','cycle_status','important_dates','eligibility','citizenship',
 'academic_levels','disciplines','award_amounts','stipend','tuition','travel_research_allowance','tenure','requirements',
 'application_materials','how_to_apply','documents','selection','application_url','contacts'];
begin
 if not private.awardping_program_exact_object(p_validation,array['schema','review','blockers','source_text','public_facts','current_source_proofs'])
  or p_validation->>'schema' is distinct from 'awardping.current-basic-fact-validation.v1'
  or octet_length(p_validation::text)>33554432
  or not private.awardping_program_exact_object(v_review,array['schema','cohort_key','award_id','epoch','cycle','reviewed_all_sources','roster','capture_refs','fields'])
  or v_review->>'schema' is distinct from 'awardping.program-fact-review.v1'
  or jsonb_typeof(v_review->'cycle') is distinct from 'string' or length(btrim(v_review->>'cycle')) not between 1 and 120
  or v_review->'reviewed_all_sources' is distinct from 'false'::jsonb
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
  if not private.awardping_current_basic_source_ready(v_source.id,v_registry.cohort_key,(v_review->>'epoch')::uuid,v_ref) then return false;end if;
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
  if v_field->>'status'='not_published' or v_field->>'status'='verified' and not v_field->>'field'=any(array['overview','opening_date','deadline','cycle_status','important_dates','eligibility','citizenship','academic_levels','disciplines','award_amounts','stipend','tuition','travel_research_allowance','tenure','application_url']) then return false;end if;
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
 if not private.awardping_current_basic_proofs_valid(v_review,p_validation->'current_source_proofs') then return false;end if;
 return (not p_approval or (v_review->>'reviewed_all_sources')::boolean and p_validation->'blockers'='[]'::jsonb)
  and p_validation->'public_facts'=private.awardping_program_fact_public_values(v_review);
exception when others then return false;
end;
$$;

create function public.save_current_program_basic_fact_review(p_validation jsonb,p_actor text) returns jsonb language plpgsql security definer set search_path='' as $$
declare h text;d public.program_text_fact_reviews%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if length(btrim(coalesce(p_actor,''))) not between 1 and 320 or not private.awardping_current_basic_validation_valid(p_validation)
 then raise exception 'Current basic source review is invalid.' using errcode='23514';end if;
 h:=encode(extensions.digest(convert_to(p_validation::text,'UTF8'),'sha256'),'hex');
 select * into d from public.program_text_fact_reviews where cohort_key=p_validation#>>'{review,cohort_key}' and content_hash=h;
 if found then return jsonb_build_object('id',d.id,'content_hash',d.content_hash,'status',d.status);end if;
 insert into public.program_text_fact_reviews(cohort_key,validation,content_hash,created_by) values(p_validation#>>'{review,cohort_key}',p_validation,h,p_actor) returning * into d;
 insert into public.program_text_fact_review_events(action,subject_id,details,actor) values('draft_created',d.id::text,jsonb_build_object('purpose','independent_current_basics','content_hash',h),p_actor);
 return jsonb_build_object('id',d.id,'content_hash',h,'status',d.status);
end;$$;

create function public.inspect_current_program_basic_award(p_cohort_key text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare e uuid;ids uuid[];r jsonb;s jsonb;m jsonb;registry jsonb;head uuid;pending jsonb;observations jsonb;
begin
 select epoch into strict e from public.program_text_source_authority_epochs where active;
 select jsonb_build_object('cohort_key',cohort_key,'canonical_shared_award_id',canonical_shared_award_id) into strict registry from public.stage1_award_registry where cohort_key=p_cohort_key;
 select array_agg(distinct id) into ids from public.program_text_source_roster x cross join lateral unnest(x.source_ids) id where x.cohort_key=p_cohort_key;
 select jsonb_agg(jsonb_build_object('source_role',source_role,'revision',revision,'source_ids',source_ids,'manifest_status',manifest_status,'evidence',evidence) order by source_role) into r from public.program_text_source_roster where cohort_key=p_cohort_key;
 if not coalesce(cardinality(ids) between 1 and 500,false) or not coalesce(jsonb_array_length(r) between 1 and 100,false) then raise exception 'Bounded full source set required.' using errcode='23514';end if;
 select jsonb_agg(jsonb_build_object('id',x.id,'shared_award_id',x.shared_award_id,'url',x.url,'title',x.title,'page_type',x.page_type,'admin_review_status',x.admin_review_status,'text_monitoring_state',x.text_monitoring_state,
  'text_collection_quality',private.awardping_program_text_collection_quality(x.id),'text_source_approvals',private.awardping_program_text_source_approval_dto(x.id),'canonical_url_admission',private.awardping_program_text_canonical_url_admission(x.id,e)) order by x.id) into s from public.shared_award_sources x where x.id=any(ids);
 select jsonb_agg(shared_award_id order by shared_award_id) into m from public.stage1_award_members where cohort_key=p_cohort_key;
 if not coalesce(jsonb_array_length(m) between 1 and 100,false) or jsonb_array_length(s)<>cardinality(ids) then raise exception 'Source identity/membership incomplete.' using errcode='23514';end if;
 select coalesce(jsonb_agg(p order by id),'[]'::jsonb) into pending from (select id,private.awardping_current_basic_pending_review(id) p from unnest(ids) id) x where p is not null;
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'cohort_key',o.cohort_key,'source_id',o.source_id,'epoch',o.epoch,'current_ref',o.current_ref,'repeat_ref',o.repeat_ref,'content_identity',o.content_identity,'verified_at',o.verified_at) order by o.created_at desc,o.id),'[]'::jsonb)
 into observations from (select limited.* from public.shared_award_sources x cross join lateral (
  select z.* from public.program_basic_repeat_observations z where z.cohort_key=p_cohort_key and z.epoch=e and z.source_id=x.id
   and z.content_identity=private.awardping_basic_content_identity(x.text_monitoring_state->'latest_ref') order by z.created_at desc,z.id limit 8
 ) limited where x.id=any(ids)) o;
 select snapshot_id into head from public.program_basic_fact_heads where cohort_key=p_cohort_key;
 return jsonb_build_object('schema','awardping.current-basic-award-context.v1','head_id',head,'context',jsonb_build_object('registry',registry,'roles',r,'sources',s,'memberIds',m,'epoch',e,'pending_alert_reviews',pending,'repeat_observations',observations));
end;$$;
create function public.inspect_current_basic_fact_draft(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d public.program_text_fact_reviews%rowtype;x jsonb;
begin select * into strict d from public.program_text_fact_reviews where id=p_id;x:=public.inspect_current_program_basic_award(d.cohort_key);
 return jsonb_build_object('schema','awardping.basic-fact-draft-context.v1','draft',jsonb_build_object('id',d.id,'content_hash',d.content_hash,'validation',d.validation),'context',x->'context','head_id',x->'head_id');end;$$;

create function public.commit_current_program_basic_facts(p_draft_id uuid,p_expected_draft_hash text,p_expected_head_id uuid,p_receipt jsonb,p_receipt_hash text,p_plan_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d public.program_text_fact_reviews%rowtype;h uuid;v public.program_basic_fact_snapshots%rowtype;projection jsonb;expected jsonb;refs jsonb;versions jsonb;vh text;
begin
 if not coalesce(p_expected_draft_hash ~ '^[a-f0-9]{64}$',false) or not coalesce(p_receipt_hash ~ '^[a-f0-9]{64}$',false) or not coalesce(p_plan_hash ~ '^[a-f0-9]{64}$',false)
 or p_receipt is null or octet_length(p_receipt::text)>8388608 or not private.awardping_program_exact_object(p_receipt,array['schema','cohort_key','award_id','epoch','cycle','input_review_id','input_review_hash','selected_fields','reviewed_at','roster','supporting_capture_refs','current_capture_refs','public_facts','current_source_proofs'])
 then raise exception 'Exact bounded current basic snapshot required.' using errcode='23514';end if;
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict d from public.program_text_fact_reviews where id=p_draft_id for share;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('awardping-basic-facts:'||d.cohort_key,0));
 perform 1 from public.stage1_award_registry where cohort_key=d.cohort_key for share;
 perform 1 from public.program_text_source_roster where cohort_key=d.cohort_key for share;
 perform 1 from public.program_text_source_authority_epochs where active for share;
 perform 1 from public.shared_award_sources where id in(select (value#>>'{source,id}')::uuid from jsonb_array_elements(d.validation#>'{review,capture_refs}')) order by id for share;
 if d.content_hash is distinct from p_expected_draft_hash or not private.awardping_current_basic_validation_valid(d.validation)
 or not coalesce((p_receipt->>'reviewed_at')::timestamptz between clock_timestamp()-interval '15 minutes' and clock_timestamp(),false)
 then raise exception 'Saved current basic sources or fresh review changed.' using errcode='40001';end if;
 projection:=private.awardping_basic_fact_selection(d.validation,p_receipt->'selected_fields');refs:=d.validation#>'{review,capture_refs}';
 expected:=jsonb_build_object('schema','awardping.current-basic-award-fact-review.v1','cohort_key',d.cohort_key,'award_id',d.validation#>'{review,award_id}','epoch',d.validation#>'{review,epoch}','cycle',d.validation#>'{review,cycle}',
 'input_review_id',d.id,'input_review_hash',d.content_hash,'selected_fields',p_receipt->'selected_fields','reviewed_at',p_receipt->'reviewed_at','roster',d.validation#>'{review,roster}',
 'supporting_capture_refs',refs,'current_capture_refs',refs,'public_facts',projection,'current_source_proofs',d.validation->'current_source_proofs');
 vh:=encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(expected),'UTF8'),'sha256'),'hex');
 if expected is distinct from p_receipt or vh is distinct from p_receipt_hash then raise exception 'Independent current basic projection differs.' using errcode='23514';end if;
 select jsonb_agg(jsonb_build_object('source_id',r#>>'{source,id}','owner_id',r#>>'{source,shared_award_id}','url',r#>>'{source,url}','epoch',d.validation#>>'{review,epoch}',
 'content_identity',private.awardping_basic_content_identity(r),'repeat_observation_id',p->'repeat_observation_id','pending_alert_review_id',p->'pending_alert_review_id','pending_alert_review_hash',p->'pending_alert_review_hash') order by r#>>'{source,id}') into versions
 from jsonb_array_elements(refs) r join jsonb_array_elements(d.validation->'current_source_proofs') p on p->>'source_id'=r#>>'{source,id}';
 select snapshot_id into h from public.program_basic_fact_heads where cohort_key=d.cohort_key for update;
 if h is not null and exists(select 1 from public.program_basic_fact_snapshots x where x.id=h and x.content_hash=vh and x.input_review_id=d.id and x.input_review_hash=d.content_hash and x.previous_snapshot_id is not distinct from p_expected_head_id and x.root_plan_hash=p_plan_hash)
 then return jsonb_build_object('ok',true,'snapshot_id',h,'already_applied',true,'kind','automated_source_verified_basics');end if;
 if h is distinct from p_expected_head_id then raise exception 'Basic head changed.' using errcode='40001';end if;
 insert into public.program_basic_fact_snapshots(cohort_key,award_id,input_review_id,input_review_hash,previous_snapshot_id,receipt,content_hash,root_plan_hash,source_versions,public_facts)
 values(d.cohort_key,(d.validation#>>'{review,award_id}')::uuid,d.id,d.content_hash,h,expected,vh,p_plan_hash,versions,projection) returning * into v;
 insert into public.program_basic_fact_heads(cohort_key,snapshot_id) values(d.cohort_key,v.id) on conflict(cohort_key) do update set snapshot_id=excluded.snapshot_id,updated_at=now();
 return jsonb_build_object('ok',true,'snapshot_id',v.id,'already_applied',false,'kind',v.kind);
end;$$;
create function private.awardping_basic_fact_current_v1(p_id uuid) returns boolean
language plpgsql stable set search_path='' as $$
declare s public.program_basic_fact_snapshots%rowtype;r jsonb;src public.shared_award_sources%rowtype;
begin
 select * into strict s from public.program_basic_fact_snapshots where id=p_id;
 if not exists(select 1 from public.stage1_award_registry x where x.cohort_key=s.cohort_key and x.canonical_shared_award_id=s.award_id)
  or not exists(select 1 from public.program_text_source_authority_epochs x where x.active and x.epoch::text=s.receipt->>'epoch') then return false;end if;
 for r in select value from jsonb_array_elements(s.source_versions) loop
  select * into strict src from public.shared_award_sources where id=(r->>'source_id')::uuid;
  if not private.awardping_program_fact_source_ready(src.id) or not private.awardping_program_text_collection_quality_ready(src.id,(r->>'epoch')::uuid)
   or not private.awardping_program_text_source_access(src.id,s.cohort_key,(r->>'epoch')::uuid)
   or src.shared_award_id::text is distinct from r->>'owner_id' or src.url is distinct from r->>'url'
   or not exists(select 1 from public.stage1_award_members m where m.cohort_key=s.cohort_key and m.shared_award_id=src.shared_award_id)
   or src.text_monitoring_state->>'schema' is distinct from 'awardping.program-text-state.v1'
   or src.text_monitoring_state->>'epoch' is distinct from r->>'epoch'
   or coalesce(src.text_monitoring_state->'last_program_update_at','null'::jsonb) is distinct from r->'program_version'
   or private.awardping_basic_source_decision_version(src.id) is distinct from r->'admin_decision_version'
  then return false;end if;
 end loop;
 return true;
exception when others then return false;
end;$$;

create function private.awardping_current_basic_fact_current(p_id uuid) returns boolean language plpgsql stable set search_path='' as $$
declare x public.program_basic_fact_snapshots%rowtype;v jsonb;s public.shared_award_sources%rowtype;r public.program_text_alert_reviews%rowtype;c public.shared_award_visual_review_candidates%rowtype;actual_roster jsonb;
begin
 select * into strict x from public.program_basic_fact_snapshots where id=p_id;
 if x.receipt->>'schema'<>'awardping.current-basic-award-fact-review.v1' or not exists(select 1 from public.stage1_award_registry z where z.cohort_key=x.cohort_key and z.canonical_shared_award_id=x.award_id) then return false;end if;
 select jsonb_agg(jsonb_build_object('source_role',source_role,'revision',revision,'source_ids',source_ids) order by source_role) into actual_roster from public.program_text_source_roster where cohort_key=x.cohort_key;
 if actual_roster is distinct from (select jsonb_agg(value order by value->>'source_role') from jsonb_array_elements(x.receipt->'roster')) then return false;end if;
 for v in select value from jsonb_array_elements(x.source_versions) loop
  select * into strict s from public.shared_award_sources where id=(v->>'source_id')::uuid;
  if s.shared_award_id::text<>v->>'owner_id' or s.url<>v->>'url' or not private.awardping_current_basic_source_ready(s.id,x.cohort_key,(v->>'epoch')::uuid,s.text_monitoring_state->'latest_ref')
   or private.awardping_basic_content_identity(s.text_monitoring_state->'latest_ref') is distinct from v->'content_identity'
   or not exists(select 1 from public.program_basic_repeat_observations o where o.id=(v->>'repeat_observation_id')::uuid and o.source_id=s.id and o.cohort_key=x.cohort_key and o.epoch=(v->>'epoch')::uuid and o.content_identity=v->'content_identity') then return false;end if;
  if v->'pending_alert_review_id'<>'null'::jsonb then
   select * into strict r from public.program_text_alert_reviews where id=(v->>'pending_alert_review_id')::uuid;
   select * into strict c from public.shared_award_visual_review_candidates where id=r.id;
   if r.content_hash<>v->>'pending_alert_review_hash' or r.content_hash<>private.program_text_alert_hash(c,r.details,r.localization)
    or c.shared_award_source_id<>s.id or c.shared_award_id<>s.shared_award_id or c.source_url<>s.url
    or private.awardping_basic_content_identity(c.new_snapshot_ref) is distinct from v->'content_identity'
    or not ((r.status='pending' and c.status='succeeded') or (r.status='approved' and c.status='published') or (r.status='dismissed' and c.status='rejected' and c.rejection_reason='admin_dismissed_program_change')) then return false;end if;
  elsif s.text_monitoring_state->>'status'='awaiting_review' then return false;
  end if;
 end loop;return true;
exception when others then return false;end;$$;
create or replace function private.awardping_basic_fact_current(p_id uuid) returns boolean language plpgsql stable set search_path='' as $$
declare k text;begin select receipt->>'schema' into strict k from public.program_basic_fact_snapshots where id=p_id;
 if k='awardping.basic-award-fact-review.v1' then return private.awardping_basic_fact_current_v1(p_id);end if;
 if k='awardping.current-basic-award-fact-review.v1' then return private.awardping_current_basic_fact_current(p_id);end if;
 return false;exception when others then return false;end;$$;

revoke all on function private.awardping_basic_repeat_immutable(),private.awardping_basic_content_identity(jsonb),private.awardping_current_basic_pending_review(uuid),
 private.awardping_current_basic_source_ready(uuid,text,uuid,jsonb),private.awardping_basic_repeat_document_valid(jsonb),private.awardping_current_basic_proofs_valid(jsonb,jsonb),
 private.awardping_current_basic_validation_valid(jsonb),private.awardping_basic_fact_current_v1(uuid),private.awardping_current_basic_fact_current(uuid),private.awardping_basic_fact_current(uuid)
 from public,anon,authenticated,service_role;
revoke all on function public.attest_program_basic_repeat(text,jsonb,jsonb,timestamptz,text),public.save_current_program_basic_fact_review(jsonb,text),
 public.inspect_current_program_basic_award(text),public.inspect_current_basic_fact_draft(uuid),public.commit_current_program_basic_facts(uuid,text,uuid,jsonb,text,text) from public,anon,authenticated,service_role;
grant execute on function public.attest_program_basic_repeat(text,jsonb,jsonb,timestamptz,text),public.save_current_program_basic_fact_review(jsonb,text),
 public.inspect_current_program_basic_award(text),public.inspect_current_basic_fact_draft(uuid),public.commit_current_program_basic_facts(uuid,text,uuid,jsonb,text,text) to service_role;
notify pgrst,'reload schema';
