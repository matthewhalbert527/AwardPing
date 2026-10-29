-- PRIVATE PROPOSAL ONLY. Root owns native rollback rehearsal and installation.
-- Automated source-verified basics; never a human/full-program/variation approval.
create table public.program_basic_fact_snapshots (
 id uuid primary key default gen_random_uuid(),
 cohort_key text not null references public.stage1_award_registry(cohort_key),
 award_id uuid not null references public.shared_awards(id),
 kind text not null default 'automated_source_verified_basics' check(kind='automated_source_verified_basics'),
 input_review_id uuid not null references public.program_text_fact_reviews(id),
 input_review_hash text not null check(input_review_hash ~ '^[a-f0-9]{64}$'),
 previous_snapshot_id uuid references public.program_basic_fact_snapshots(id),
 receipt jsonb not null,
 content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),
 root_plan_hash text not null check(root_plan_hash ~ '^[a-f0-9]{64}$'),
 source_versions jsonb not null check(jsonb_typeof(source_versions)='array' and jsonb_array_length(source_versions) between 1 and 500),
 public_facts jsonb not null,
 created_at timestamptz not null default now(),
 unique(cohort_key,content_hash),
 unique(cohort_key,id)
);
create table public.program_basic_fact_heads (
 cohort_key text primary key references public.stage1_award_registry(cohort_key),
 snapshot_id uuid not null,
 updated_at timestamptz not null default now(),
 foreign key(cohort_key,snapshot_id) references public.program_basic_fact_snapshots(cohort_key,id)
);
alter table public.program_basic_fact_snapshots enable row level security;
alter table public.program_basic_fact_heads enable row level security;
revoke all on public.program_basic_fact_snapshots,public.program_basic_fact_heads from public,anon,authenticated,service_role;
grant select on public.program_basic_fact_snapshots,public.program_basic_fact_heads to service_role;

-- Finite URL resolution for actual retained hrefs. Unsupported/encoded ambiguous
-- forms fail closed instead of inventing an application destination.
create function private.awardping_basic_href(p_href text,p_base text) returns text
language plpgsql immutable set search_path='' as $$
declare origin text;path text;tail text:='';piece text;parts text[]:='{}';resolved_path text;
begin
 if p_href is null or p_base is null or length(p_href)>2400 or length(p_base)>2400
  or p_href ~ '[[:space:]\\]' or p_base ~ '[[:space:]\\]' then return null;end if;
 if p_href ~ '^https://[^/?#@:[:space:]]+$' then return p_href||'/';end if;
 if p_href ~ '^https://[^/?#@:[:space:]]+[?#]' then return regexp_replace(p_href,'^(https://[^/?#@:[:space:]]+)([?#])','\1/\2');end if;
 if p_href ~ '^https://' then return p_href;end if;
 if p_href ~ '^[A-Za-z][A-Za-z0-9+.-]*:' or p_href like '//%' then return null;end if;
 origin:=substring(p_base from '^(https://[^/?#@:[:space:]]+)');if origin is null then return null;end if;
 path:=split_part(split_part(substr(p_base,length(origin)+1),'#',1),'?',1);if path='' then path:='/';end if;
 if p_href like '#%' then return split_part(p_base,'#',1)||p_href;end if;
 if p_href like '?%' then return origin||path||p_href;end if;
 if p_href like '/%' then resolved_path:=p_href;else resolved_path:=regexp_replace(path,'[^/]*$','')||p_href;end if;
 tail:=substring(resolved_path from '[?#].*$');resolved_path:=split_part(split_part(resolved_path,'#',1),'?',1);
 if resolved_path ~* '%2e|%2f|%5c' then return null;end if;
 foreach piece in array string_to_array(resolved_path,'/') loop
  if piece='' or piece='.' then continue;end if;
  if piece='..' then if cardinality(parts)>0 then parts:=parts[1:cardinality(parts)-1];end if;
  else parts:=array_append(parts,piece);end if;
 end loop;
 return origin||'/'||array_to_string(parts,'/')||case when right(resolved_path,1)='/' and cardinality(parts)>0 then '/' else '' end||coalesce(tail,'');
exception when others then return null;
end;$$;

create function private.awardping_basic_fact_selection(p_validation jsonb,p_selected jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare allowed text[]:=array['overview','opening_date','deadline','cycle_status','important_dates','eligibility','citizenship','academic_levels','disciplines','award_amounts','stipend','tuition','travel_research_allowance','tenure','application_url'];
 selected text[];v_review jsonb:=p_validation->'review';f jsonb;i jsonb;q jsonb;doc jsonb;b jsonb;years text[];base text;ok boolean;masked jsonb;
begin
 if jsonb_typeof(p_selected) is distinct from 'array' or jsonb_array_length(p_selected) not between 1 and 15
  or exists(select 1 from jsonb_array_elements(p_selected) x where jsonb_typeof(x)<>'string') then raise exception 'Invalid basic field selection.' using errcode='23514';end if;
 select array_agg(value) into selected from jsonb_array_elements_text(p_selected);
 if cardinality(selected)<>(select count(distinct x) from unnest(selected) x) or not 'overview'=any(selected)
  or exists(select 1 from unnest(selected) x where not x=any(allowed))
  or p_selected is distinct from (select jsonb_agg(to_jsonb(x) order by n) from unnest(allowed) with ordinality a(x,n) where x=any(selected))
 then raise exception 'Only explicit, canonical basic fields are supported.' using errcode='23514';end if;
 for f in select value from jsonb_array_elements(v_review->'fields') where value->>'field'=any(selected) loop
  if f->>'status'<>'verified' then raise exception 'Unknown, conflicting and unpublished decisions are not public basics.' using errcode='23514';end if;
  if f->>'field'='overview' and (jsonb_array_length(f->'items')<>1 or f#>>'{items,0,track}' is not null) then raise exception 'A supported shared overview is required.' using errcode='23514';end if;
  for i in select value from jsonb_array_elements(f->'items') loop
   if f->>'field' in ('deadline','opening_date') then
    select coalesce(array_agg(m[1]),'{}') into years from regexp_matches((select string_agg(value->>'text',' ') from jsonb_array_elements(i->'support')),'\m((?:19|20)[0-9]{2})\M','g') m;
    if exists(select 1 from regexp_matches(i->>'value','\m((?:19|20)[0-9]{2})\M','g') m where not m[1]=any(years)) then raise exception 'Unquoted date year.' using errcode='23514';end if;
   end if;
   if f->>'field'='application_url' then
    ok:=false;
    for q in select value from jsonb_array_elements(i->'support') loop
     select value into strict doc from jsonb_array_elements(p_validation->'source_text') where value#>>'{reference,source,id}'=q->>'source_id' and value#>>'{reference,capture_id}'=q->>'capture_id';
     select value into strict b from jsonb_array_elements(doc->'blocks') where value->>'id'=q->>'block_id';
     if b->>'kind'='source_link' and b#>>'{context,source_attribute}'='href' and (q->>'start_utf16')::integer=(b->>'start_utf16')::integer and (q->>'end_utf16')::integer=(b->>'end_utf16')::integer then
      if b#>'{context,base_hrefs}' is not null and (jsonb_typeof(b#>'{context,base_hrefs}')<>'array' or jsonb_array_length(b#>'{context,base_hrefs}')>1
       or exists(select 1 from jsonb_array_elements(b#>'{context,base_hrefs}') x where jsonb_typeof(x)<>'string')) then continue;end if;
      base:=coalesce(b#>>'{context,base_hrefs,0}',doc#>>'{reference,final_url}');
      if base !~ '^https://' then base:=private.awardping_basic_href(base,doc#>>'{reference,final_url}');end if;
      ok:=ok or private.awardping_basic_href(b->>'text',base)=i->>'value';
     elsif q->>'text'=i->>'value' then
      ok:=ok or ((q->>'start_utf16')::integer=0 or private.awardping_program_utf16_slice(doc->>'text',(q->>'start_utf16')::integer-1,(q->>'start_utf16')::integer) ~ '[[:space:]("''<]')
       and ((q->>'end_utf16')::integer=private.awardping_program_utf16_length(doc->>'text') or private.awardping_program_utf16_slice(doc->>'text',(q->>'end_utf16')::integer,(q->>'end_utf16')::integer+1) ~ '[[:space:])"''>]');
     end if;
    end loop;
    if not coalesce(ok,false) then raise exception 'Application link lacks exact retained support.' using errcode='23514';end if;
   end if;
  end loop;
 end loop;
 select jsonb_set(v_review,'{fields}',jsonb_agg(case when value->>'field'=any(selected) then value else
  jsonb_build_object('field',value->>'field','status','unresolved','items','[]'::jsonb,'note','Outside this selected basic-information snapshot.') end order by n))
 into masked from jsonb_array_elements(v_review->'fields') with ordinality a(value,n);
 return private.awardping_program_fact_public_values(masked);
end;$$;

create function private.awardping_basic_source_decision_version(p_source uuid) returns jsonb
language sql stable set search_path='' as $$
 select case when count(*)=0 then 'null'::jsonb else jsonb_build_object('count',count(*),'latest_at',max(r.reviewed_at)) end
 from public.program_text_alert_reviews r join public.shared_award_visual_review_candidates c on c.id=r.id
 where c.shared_award_source_id=p_source and c.candidate_scope='program_text_change' and r.status in ('approved','dismissed');
$$;

-- Source body/capture/roster changes alone do not revoke a basic snapshot.
-- Validated no-change advancement remains ready and preserves both stamps;
-- pending/failed comparisons or quality holds stop currentness. An approved OR
-- dismissed material alert advances a terminal-decision stamp and stales it.
create function private.awardping_basic_fact_current(p_id uuid) returns boolean
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

create function public.inspect_program_basic_fact_draft(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d public.program_text_fact_reviews%rowtype;e uuid;ids uuid[];r jsonb;s jsonb;m jsonb;registry jsonb;head uuid;
begin
 select * into strict d from public.program_text_fact_reviews where id=p_id;
 select epoch into strict e from public.program_text_source_authority_epochs where active;
 select jsonb_build_object('cohort_key',cohort_key,'canonical_shared_award_id',canonical_shared_award_id) into strict registry from public.stage1_award_registry where cohort_key=d.cohort_key;
 select array_agg(distinct id) into ids from public.program_text_source_roster x cross join lateral unnest(x.source_ids) id where x.cohort_key=d.cohort_key;
 -- Aggregate roles separately: each role appears once even when it has many sources.
 select jsonb_agg(jsonb_build_object('source_role',source_role,'revision',revision,'source_ids',source_ids,'manifest_status',manifest_status,'evidence',evidence) order by source_role) into r from public.program_text_source_roster where cohort_key=d.cohort_key;
 if not coalesce(cardinality(ids) between 1 and 500,false) or not coalesce(jsonb_array_length(r) between 1 and 100,false) then raise exception 'Bounded source set required.' using errcode='23514';end if;
 select jsonb_agg(jsonb_build_object('id',x.id,'shared_award_id',x.shared_award_id,'url',x.url,'title',x.title,'page_type',x.page_type,'admin_review_status',x.admin_review_status,'text_monitoring_state',x.text_monitoring_state,
  'text_collection_quality',private.awardping_program_text_collection_quality(x.id),'text_source_approvals',private.awardping_program_text_source_approval_dto(x.id),'canonical_url_admission',private.awardping_program_text_canonical_url_admission(x.id,e)) order by x.id) into s from public.shared_award_sources x where x.id=any(ids);
 select jsonb_agg(shared_award_id order by shared_award_id) into m from public.stage1_award_members where cohort_key=d.cohort_key;
 if not coalesce(jsonb_array_length(m) between 1 and 100,false) or jsonb_array_length(s) is distinct from cardinality(ids) then raise exception 'Bounded source identity/membership context required.' using errcode='23514';end if;
 select snapshot_id into head from public.program_basic_fact_heads where cohort_key=d.cohort_key;
 return jsonb_build_object('schema','awardping.basic-fact-draft-context.v1','draft',jsonb_build_object('id',d.id,'content_hash',d.content_hash,'validation',d.validation),
  'context',jsonb_build_object('registry',registry,'roles',r,'sources',s,'memberIds',m,'epoch',e),'head_id',head);
end;$$;

create function public.commit_program_basic_facts(p_draft_id uuid,p_expected_draft_hash text,p_expected_head_id uuid,p_receipt jsonb,p_receipt_hash text,p_plan_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d public.program_text_fact_reviews%rowtype;head uuid;v_saved public.program_basic_fact_snapshots%rowtype;r jsonb;src public.shared_award_sources%rowtype;current_refs jsonb:='[]';source_versions jsonb;projection jsonb;expected jsonb;v_hash text;
begin
 if not coalesce(p_expected_draft_hash ~ '^[a-f0-9]{64}$',false) or not coalesce(p_receipt_hash ~ '^[a-f0-9]{64}$',false) or not coalesce(p_plan_hash ~ '^[a-f0-9]{64}$',false)
  or p_receipt is null or octet_length(p_receipt::text)>8388608 or not private.awardping_program_exact_object(p_receipt,array['schema','cohort_key','award_id','epoch','cycle','input_review_id','input_review_hash','selected_fields','reviewed_at','roster','supporting_capture_refs','current_capture_refs','public_facts'])
 then raise exception 'Exact bounded basic snapshot required.' using errcode='23514';end if;
 -- Existing source/roster/authority writers take the exclusive form of this
 -- guard. A shared read barrier keeps their lock order while different awards
 -- may publish basics independently through their own CAS/head lock below.
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict d from public.program_text_fact_reviews where id=p_draft_id for share;
 if d.content_hash is distinct from p_expected_draft_hash then raise exception 'Saved draft changed.' using errcode='40001';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('awardping-basic-facts:'||d.cohort_key,0));
 perform 1 from public.stage1_award_registry where cohort_key=d.cohort_key for share;
 perform 1 from public.program_text_source_roster where cohort_key=d.cohort_key for share;
 perform 1 from public.program_text_source_authority_epochs where active for share;
 perform 1 from public.shared_award_sources where id in(select (value#>>'{source,id}')::uuid from jsonb_array_elements(d.validation#>'{review,capture_refs}')) order by id for share;
 if not exists(select 1 from public.program_text_source_authority_epochs x where x.active and x.epoch::text=d.validation#>>'{review,epoch}')
  or not private.awardping_program_fact_validation_valid(d.validation,false) then raise exception 'Saved support/current source checks failed.' using errcode='23514';end if;
 if not coalesce((p_receipt->>'reviewed_at')::timestamptz between clock_timestamp()-interval '15 minutes' and clock_timestamp(),false) then raise exception 'Fresh cold verification required.' using errcode='40001';end if;
 for r in select value from jsonb_array_elements(d.validation#>'{review,capture_refs}') loop
  select * into strict src from public.shared_award_sources where id=(r#>>'{source,id}')::uuid;
  if not private.awardping_program_text_collection_quality_ready(src.id,(d.validation#>>'{review,epoch}')::uuid)
   or not private.awardping_program_text_source_access(src.id,d.cohort_key,(d.validation#>>'{review,epoch}')::uuid)
   or src.text_monitoring_state#>'{latest_ref,blocks_sha256}' is distinct from r->'blocks_sha256' then raise exception 'Current source quality/context changed.' using errcode='40001';end if;
  current_refs:=current_refs||jsonb_build_array(src.text_monitoring_state->'latest_ref');
 end loop;
 projection:=private.awardping_basic_fact_selection(d.validation,p_receipt->'selected_fields');
 expected:=jsonb_build_object('schema','awardping.basic-award-fact-review.v1','cohort_key',d.cohort_key,'award_id',d.validation#>'{review,award_id}','epoch',d.validation#>'{review,epoch}','cycle',d.validation#>'{review,cycle}',
  'input_review_id',d.id,'input_review_hash',d.content_hash,'selected_fields',p_receipt->'selected_fields','reviewed_at',p_receipt->'reviewed_at','roster',d.validation#>'{review,roster}',
  'supporting_capture_refs',d.validation#>'{review,capture_refs}','current_capture_refs',current_refs,'public_facts',projection);
 v_hash:=encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(expected),'UTF8'),'sha256'),'hex');
 if expected is distinct from p_receipt or v_hash is distinct from p_receipt_hash then raise exception 'Independent basic projection differs.' using errcode='23514';end if;
 select jsonb_agg(jsonb_build_object('source_id',s.id,'owner_id',s.shared_award_id,'url',s.url,'epoch',s.text_monitoring_state->'epoch',
  'program_version',coalesce(s.text_monitoring_state->'last_program_update_at','null'::jsonb),
  'admin_decision_version',private.awardping_basic_source_decision_version(s.id)) order by s.id) into source_versions
 from public.shared_award_sources s where s.id in (
  select distinct (q->>'source_id')::uuid from jsonb_array_elements(d.validation#>'{review,fields}') f,
  lateral jsonb_array_elements(f->'items') i,lateral jsonb_array_elements(i->'support') q
  where p_receipt->'selected_fields' ? (f->>'field'));
 if source_versions is null or jsonb_array_length(source_versions) not between 1 and 500 then raise exception 'Selected support versions are missing.' using errcode='23514';end if;
 select snapshot_id into head from public.program_basic_fact_heads where cohort_key=d.cohort_key for update;
 if head is not null and exists(select 1 from public.program_basic_fact_snapshots x where x.id=head and x.content_hash=v_hash
  and x.input_review_id=p_draft_id and x.input_review_hash=p_expected_draft_hash and x.previous_snapshot_id is not distinct from p_expected_head_id and x.root_plan_hash=p_plan_hash)
 then return jsonb_build_object('ok',true,'snapshot_id',head,'already_applied',true,'kind','automated_source_verified_basics');end if;
 if head is distinct from p_expected_head_id then raise exception 'Basic head changed.' using errcode='40001';end if;
 insert into public.program_basic_fact_snapshots(cohort_key,award_id,input_review_id,input_review_hash,previous_snapshot_id,receipt,content_hash,root_plan_hash,source_versions,public_facts)
 values(d.cohort_key,(d.validation#>>'{review,award_id}')::uuid,d.id,d.content_hash,head,expected,v_hash,p_plan_hash,source_versions,projection) returning * into v_saved;
 insert into public.program_basic_fact_heads(cohort_key,snapshot_id) values(d.cohort_key,v_saved.id)
 on conflict(cohort_key) do update set snapshot_id=excluded.snapshot_id,updated_at=now();
 return jsonb_build_object('ok',true,'snapshot_id',v_saved.id,'already_applied',false,'kind',v_saved.kind);
end;$$;

create function public.get_program_basic_facts(p_award_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if p_award_ids is null or cardinality(p_award_ids)>100 or exists(select 1 from unnest(p_award_ids) id where id is null)
  or cardinality(p_award_ids)<>(select count(distinct id) from unnest(p_award_ids) id) then raise exception 'Choose at most100 distinct awards.' using errcode='23514';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('award_id',s.award_id,'cohort_key',s.cohort_key,'snapshot_id',s.id,'kind',s.kind,'current',x.current,
  'public_facts',case when x.current then s.public_facts else 'null'::jsonb end,'verified_at',s.receipt->'reviewed_at') order by s.cohort_key)
  from public.program_basic_fact_heads h join public.program_basic_fact_snapshots s on s.id=h.snapshot_id
  cross join lateral (select private.awardping_basic_fact_current(s.id) current) x where s.award_id=any(p_award_ids)),'[]'::jsonb);
end;$$;

revoke all on function private.awardping_basic_href(text,text),private.awardping_basic_fact_selection(jsonb,jsonb),private.awardping_basic_source_decision_version(uuid),private.awardping_basic_fact_current(uuid) from public,anon,authenticated,service_role;
revoke all on function public.inspect_program_basic_fact_draft(uuid),public.commit_program_basic_facts(uuid,text,uuid,jsonb,text,text),public.get_program_basic_facts(uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.inspect_program_basic_fact_draft(uuid),public.commit_program_basic_facts(uuid,text,uuid,jsonb,text,text),public.get_program_basic_facts(uuid[]) to service_role;
-- No shared_awards, fact-review approvals, event, notification or digest writes.
notify pgrst,'reload schema';
