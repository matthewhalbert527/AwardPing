-- Additive proof purpose. The original byte-repeat table, attestation RPC and
-- byte identity remain unchanged. Service JS cold-replays the normal review,
-- actual DOM profiles and both complete originals; SQL binds that frozen proof
-- to current queue/spend/source/head facts and independently checks conservation.
create table public.program_basic_reviewed_repeat_observations (
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind='reviewed_no_program_change'),
 cohort_key text not null references public.program_award_registry(cohort_key),
 source_id uuid not null references public.shared_award_sources(id),epoch uuid not null,
 expected_head uuid not null references public.program_basic_fact_snapshots(id),
 candidate_id uuid not null references public.shared_award_visual_review_candidates(id),
 candidate_hash text not null check(candidate_hash~'^[a-f0-9]{64}$'),
 current_ref jsonb not null,repeat_ref jsonb not null,
 support_hash text not null check(support_hash~'^[a-f0-9]{64}$'),
 validation jsonb not null check(octet_length(validation::text)<=33554432),
 content_hash text not null check(content_hash~'^[a-f0-9]{64}$'),
 verified_at timestamptz not null,created_at timestamptz not null default clock_timestamp(),actor text not null,
 unique(cohort_key,source_id,epoch,expected_head,candidate_id,support_hash)
);
alter table public.program_basic_reviewed_repeat_observations enable row level security;
revoke all on public.program_basic_reviewed_repeat_observations from public,anon,authenticated,service_role;
grant select on public.program_basic_reviewed_repeat_observations to service_role;
create index basic_reviewed_repeat_current on public.program_basic_reviewed_repeat_observations(cohort_key,source_id,epoch,expected_head,created_at desc);
create trigger basic_reviewed_repeat_immutable before update or delete on public.program_basic_reviewed_repeat_observations
 for each row execute function private.awardping_basic_repeat_immutable();
create trigger basic_reviewed_repeat_no_truncate before truncate on public.program_basic_reviewed_repeat_observations
 for each statement execute function private.awardping_basic_repeat_immutable();

create function private.awardping_reviewed_repeat_hash(v jsonb) returns text language sql immutable set search_path='' as $$
 select encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(v),'UTF8'),'sha256'),'hex');
$$;
create function private.awardping_reviewed_repeat_candidate(p_id uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',c.id,'shared_award_id',c.shared_award_id,'shared_award_source_id',c.shared_award_source_id,
 'source_url',c.source_url,'candidate_scope',c.candidate_scope,'status',c.status,'rejection_reason',c.rejection_reason,
 'candidate_signature',c.candidate_signature,'previous_snapshot_ref',c.previous_snapshot_ref,'new_snapshot_ref',c.new_snapshot_ref,
 'worker_metadata',c.worker_metadata,'prompt_payload',c.prompt_payload,'ai_result',c.ai_result,'model',c.model,
 'gemini_batch_name',c.gemini_batch_name,'submitted_at',c.submitted_at,'completed_at',c.completed_at,'published_at',c.published_at,'actual_usage',c.actual_usage)
 from public.shared_award_visual_review_candidates c where c.id=p_id;
$$;
create function private.awardping_reviewed_repeat_paid(c jsonb) returns jsonb language plpgsql stable set search_path='' as $$
declare p jsonb;begin
 if c#>>'{worker_metadata,gemini_spend_reservation_id}' is null then return 'null'::jsonb;end if;
 select to_jsonb(x) into strict p from public.gemini_spend_reservations x where id=(c#>>'{worker_metadata,gemini_spend_reservation_id}')::uuid;
 return p;exception when others then return null;end;$$;

create function private.awardping_reviewed_repeat_comparison_ref(r jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('capture_id',r->'capture_id','source_id',r#>'{source,id}','award_id',r#>'{source,shared_award_id}',
  'url',r#>'{source,url}','final_url',r->'final_url','captured_at',r->'captured_at','text_sha256',r->'text_sha256',
  'raw_source_sha256',r#>'{artifacts,raw,sha256}','acquisition',r->'acquisition','extractor',r->'extractor');
$$;
create function private.awardping_reviewed_repeat_candidate_valid(v jsonb) returns boolean language plpgsql stable set search_path='' as $$
declare c jsonb:=v->'candidate';p jsonb:=v->'paid_reservation';comparison jsonb;provenance jsonb;cid uuid;
begin
 cid:=(v->>'candidate_id')::uuid;
 if c is distinct from private.awardping_reviewed_repeat_candidate(cid) or p is distinct from private.awardping_reviewed_repeat_paid(c)
  or private.awardping_reviewed_repeat_hash(c) is distinct from v->>'candidate_hash'
  or c->>'candidate_scope' is distinct from 'program_text_change' or c->>'status' is distinct from 'rejected'
  or c->>'rejection_reason' is distinct from 'no_program_change' or c->'published_at' is distinct from 'null'::jsonb
  or c->>'completed_at' is null or (c->>'completed_at')::timestamptz<(v#>>'{current_document,reference,captured_at}')::timestamptz
  or jsonb_typeof(c->'ai_result') is distinct from 'object'
  or exists(select 1 from jsonb_object_keys(c->'ai_result') k where k not in('responses','program_text_validation','program_text_review_provenance'))
  or not (c->'ai_result') ?& array['responses','program_text_validation']
  or c->>'id' is distinct from v->>'candidate_id' or c->>'shared_award_source_id' is distinct from v->>'source_id'
  or c->>'shared_award_id' is distinct from v#>>'{current_document,reference,source,shared_award_id}'
  or c->>'source_url' is distinct from v#>>'{current_document,reference,source,url}'
  or c#>>'{worker_metadata,monitoring_contract}' is distinct from 'program-text-v1'
  or c#>>'{worker_metadata,epoch}' is distinct from v->>'epoch' or c#>>'{worker_metadata,admin_alert_review_id}' is not null
  or c->'new_snapshot_ref' is distinct from v#>'{current_document,reference}'
  or c->'previous_snapshot_ref' is distinct from v#>'{repeat_document,reference}'
 then return false;end if;
 comparison:=c#>'{prompt_payload,comparison}';provenance:=c#>'{ai_result,program_text_review_provenance}';
 if comparison->>'status' is distinct from 'review_required' or comparison->>'comparison_id' is distinct from c->>'candidate_signature'
  or private.awardping_reviewed_repeat_hash(comparison-'comparison_id') is distinct from c->>'candidate_signature'
  or c#>>'{worker_metadata,evidence_signature}' is distinct from c->>'candidate_signature'
  or comparison->>'previous_text' is distinct from v#>>'{repeat_document,text}' or comparison->>'current_text' is distinct from v#>>'{current_document,text}'
  or comparison#>>'{context,source_id}' is distinct from v->>'source_id' or comparison#>>'{context,epoch}' is distinct from v->>'epoch'
  or comparison#>>'{context,award_id}' is distinct from v#>>'{current_document,reference,source,shared_award_id}'
  or comparison->'previous_ref' is distinct from private.awardping_reviewed_repeat_comparison_ref(v#>'{repeat_document,reference}')
  or comparison->'current_ref' is distinct from private.awardping_reviewed_repeat_comparison_ref(v#>'{current_document,reference}')
  or c#>>'{prompt_payload,packet_plan,status}' is distinct from 'ready'
  or c#>>'{prompt_payload,packet_plan,comparison_id}' is distinct from c->>'candidate_signature'
  or jsonb_typeof(c#>'{prompt_payload,packet_plan,packets}') is distinct from 'array'
  or jsonb_array_length(c#>'{prompt_payload,packet_plan,packets}') not between 1 and 200
  or exists(select 1 from jsonb_array_elements(c#>'{prompt_payload,packet_plan,packets}') packet
   where packet->>'comparison_id' is distinct from c->>'candidate_signature' or packet->'context' is distinct from comparison->'context'
    or packet->'previous_ref' is distinct from comparison->'previous_ref' or packet->'current_ref' is distinct from comparison->'current_ref')
  or c#>'{ai_result,program_text_validation}' is distinct from jsonb_build_object('status','no_program_change','comparison_id',c->'candidate_signature','reasons','[]'::jsonb,'changes','[]'::jsonb)
 then return false;end if;
 if provenance is not null then
  return p='null'::jsonb and c->'model'='null'::jsonb and c->'gemini_batch_name'='null'::jsonb and c->'submitted_at'='null'::jsonb
   and c#>>'{worker_metadata,gemini_spend_reservation_id}' is null and c#>>'{worker_metadata,gemini_spend_attempt_token}' is null
   and provenance->>'schema'='awardping.deterministic-program-text-no-change.v1'
   and provenance->>'comparison_id'=c->>'candidate_signature' and provenance->>'source_id'=v->>'source_id' and provenance->>'epoch'=v->>'epoch'
   and provenance->'generated_by_gemini'='false'::jsonb and provenance->'new_provider_calls'='0'::jsonb
   and provenance->'spend_mutations'='0'::jsonb and provenance->'creates_update'='false'::jsonb;
 end if;
 return coalesce(p->>'status'='settled' and p->>'id'=c#>>'{worker_metadata,gemini_spend_reservation_id}'
  and p->>'attempt_token'=c#>>'{worker_metadata,gemini_spend_attempt_token}' and p->>'model'=c->>'model'
  and p->>'provider_batch_name'=c->>'gemini_batch_name' and p->>'lane_key'='changed_page_review' and p->>'worker_source'='program-text-review'
  and p#>>'{metadata,candidate_id}'=c->>'id' and p#>>'{metadata,monitoring_contract}'='program-text-v1'
  and p->>'work_fingerprint'='program-text:'||(c->>'candidate_signature')||':'||(c->>'model')
  and (p->>'request_count')::integer=jsonb_array_length(c#>'{worker_metadata,provider_request_keys}')
  and (p->>'request_count')::integer=jsonb_array_length(c#>'{prompt_payload,packet_plan,packets}')
  and p->>'settled_at' is not null and length(p->>'spent_source')>0,false);
exception when others then return false;end;$$;

create function private.awardping_reviewed_repeat_residual(v jsonb,p_side text) returns jsonb language plpgsql immutable set search_path='' as $$
declare d jsonb:=v->(p_side||'_document');wp jsonb;b jsonb;change jsonb;rule jsonb;ids jsonb;profile text;
 spans jsonb:='[]';widgets jsonb:='[]';parts jsonb:='[]';run_start integer;run_end integer;at_pos integer:=0;z integer;full_units integer;
 marker jsonb;span jsonb;gap text;
begin
 if p_side not in('repeat','current') then return null;end if;
 full_units:=(d#>>'{reference,text_length}')::integer;
 for wp in select value from jsonb_array_elements(v->'widget_proofs') loop
  ids:=wp#>array[case when p_side='repeat' then 'previous_marker' else 'current_marker' end,'excluded_support_block_ids'];profile:=wp->>'profile';run_start:=null;
  for b in select value from jsonb_array_elements(d->'blocks') loop
   if ids ? (b->>'id') then
    if run_start is not null then
     gap:=case when run_end=(b->>'start_utf16')::integer then '' else private.awardping_program_utf16_slice(d->>'text',run_end,(b->>'start_utf16')::integer) end;
     if gap is null or gap ~ '[^[:space:]]' then widgets:=widgets||jsonb_build_array(jsonb_build_object('start',run_start,'end',run_end,'marker',jsonb_build_array('raw_marked_ancillary_widget',profile)));run_start:=null;end if;
    end if;
    if run_start is null then run_start:=(b->>'start_utf16')::integer;end if;run_end:=(b->>'end_utf16')::integer;
   elsif run_start is not null then
    widgets:=widgets||jsonb_build_array(jsonb_build_object('start',run_start,'end',run_end,'marker',jsonb_build_array('raw_marked_ancillary_widget',profile)));run_start:=null;
   end if;
  end loop;
  if run_start is not null then widgets:=widgets||jsonb_build_array(jsonb_build_object('start',run_start,'end',run_end,'marker',jsonb_build_array('raw_marked_ancillary_widget',profile)));end if;
 end loop;
 for rule in select value from jsonb_array_elements(v->'rules') where value->>'kind'<>'raw_marked_ancillary_widget' loop
  select value into strict change from jsonb_array_elements(v#>'{candidate,prompt_payload,comparison,changed_blocks}') where value->>'id'=rule->>'change_id';
  b:=change->case when p_side='repeat' then 'previous' else 'current' end;
  if not exists(select 1 from jsonb_array_elements(widgets) w where (w->>'start')::integer<=(b->>'start_utf16')::integer and (w->>'end')::integer>=(b->>'end_utf16')::integer) then
   marker:=case when rule->>'kind'='identical_protected_email_destination' then jsonb_build_array(rule->>'kind',rule->>'decoded_hex')
    else jsonb_build_array(rule->>'kind','f322a07c-f78c-47fd-aafb-ab6422a4248f') end;
   spans:=spans||jsonb_build_array(jsonb_build_object('start',b->'start_utf16','end',b->'end_utf16','marker',marker));
  end if;
 end loop;
 spans:=spans||widgets;
 for span in select value from jsonb_array_elements(spans) order by (value->>'start')::integer loop
  z:=(span->>'start')::integer;
  if z<at_pos or (span->>'end')::integer<=z or (span->>'end')::integer>full_units then return null;end if;
  gap:=case when z=at_pos then '' else private.awardping_program_utf16_slice(d->>'text',at_pos,z) end;if gap is null then return null;end if;
  parts:=parts||jsonb_build_array(to_jsonb(gap),span->'marker');at_pos:=(span->>'end')::integer;
 end loop;
 gap:=case when at_pos=full_units then '' else private.awardping_program_utf16_slice(d->>'text',at_pos,full_units) end;
 if gap is null then return null;end if;return parts||jsonb_build_array(to_jsonb(gap));
exception when others then return null;end;$$;

create function private.awardping_reviewed_repeat_support(p_review jsonb,p_source uuid,v jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare entries jsonb;result jsonb:='[]';e jsonb;q jsonb;b jsonb;rb jsonb;matches jsonb;next_q jsonb;meaning jsonb;start_at integer;end_at integer;
 core text[]:=array['overview','opening_date','deadline','cycle_status','important_dates','eligibility','citizenship','academic_levels','disciplines','award_amounts','stipend','tuition','travel_research_allowance','tenure','application_url'];
begin
 if p_review is null then entries:=v->'support_projection';else
  if exists(select 1 from jsonb_array_elements(p_review->'fields') f where f->>'status'='verified' and not f->>'field'=any(core)) then return null;end if;
  select coalesce(jsonb_agg(jsonb_build_object('field',f->>'field','item_index',i_ord-1,'support_index',q_ord-1,'value',i->'value','track',i->'track','current_quote',quote)
   order by (f->>'field') collate "C",i_ord,q_ord),'[]'::jsonb) into entries
  from jsonb_array_elements(p_review->'fields') f cross join lateral jsonb_array_elements(f->'items') with ordinality its(i,i_ord)
  cross join lateral jsonb_array_elements(i->'support') with ordinality qs(quote,q_ord)
  where f->>'status'='verified' and f->>'field'=any(core) and quote->>'source_id'=p_source::text;
 end if;
 if jsonb_typeof(entries) is distinct from 'array' or jsonb_array_length(entries)>5000 then return null;end if;
 for e in select value from jsonb_array_elements(entries) order by (value->>'field') collate "C",(value->>'item_index')::integer,(value->>'support_index')::integer loop
  q:=e->'current_quote';
  if e->>'field' is null or not e->>'field'=any(core) or jsonb_typeof(e->'item_index') is distinct from 'number'
   or jsonb_typeof(e->'support_index') is distinct from 'number' or (e->>'item_index')::integer<0 or (e->>'support_index')::integer<0
   or jsonb_typeof(e->'value') is distinct from 'string' or jsonb_typeof(e->'track') not in('string','null')
   or private.awardping_program_exact_object(q,array['source_id','capture_id','block_id','start_utf16','end_utf16','text']) is distinct from true
   or q->>'source_id' is distinct from p_source::text or q->>'capture_id' is distinct from v#>>'{current_document,reference,capture_id}'
  then return null;end if;
  select value into strict b from jsonb_array_elements(v#>'{current_document,blocks}') where value->>'id'=q->>'block_id';
  start_at:=(q->>'start_utf16')::integer;end_at:=(q->>'end_utf16')::integer;
  if start_at<(b->>'start_utf16')::integer or end_at>(b->>'end_utf16')::integer or end_at<=start_at or end_at-start_at>1600
   or private.awardping_program_utf16_slice(v#>>'{current_document,text}',start_at,end_at) is distinct from q->>'text'
   or exists(select 1 from jsonb_array_elements(v->'widget_proofs') w where (w#>'{current_marker,excluded_support_block_ids}') ? (q->>'block_id')) then return null;end if;
  meaning:=b-'id'-'start_utf16'-'end_utf16';
  select coalesce(jsonb_agg(x),'[]'::jsonb) into matches from jsonb_array_elements(v#>'{repeat_document,blocks}') x where x-'id'-'start_utf16'-'end_utf16'=meaning;
  select value into rb from jsonb_array_elements(matches) where value->>'id'=b->>'id';
  if rb is null then if jsonb_array_length(matches)<>1 then return null;end if;rb:=matches->0;end if;
  if exists(select 1 from jsonb_array_elements(v->'widget_proofs') w where (w#>'{previous_marker,excluded_support_block_ids}') ? (rb->>'id')) then return null;end if;
  next_q:=q||jsonb_build_object('capture_id',v#>'{repeat_document,reference,capture_id}','block_id',rb->'id',
   'start_utf16',(rb->>'start_utf16')::integer+start_at-(b->>'start_utf16')::integer,'end_utf16',(rb->>'start_utf16')::integer+end_at-(b->>'start_utf16')::integer);
  if private.awardping_program_utf16_slice(v#>>'{repeat_document,text}',(next_q->>'start_utf16')::integer,(next_q->>'end_utf16')::integer) is distinct from q->>'text' then return null;end if;
  result:=result||jsonb_build_array(jsonb_build_object('field',e->'field','item_index',e->'item_index','support_index',e->'support_index','value',e->'value','track',e->'track','current_quote',q,'repeat_quote',next_q,'semantic_block',meaning));
 end loop;return result;
exception when others then return null;end;$$;

create function private.awardping_reviewed_repeat_validation_valid(v jsonb) returns boolean language plpgsql stable set search_path='' as $$
declare a jsonb:=v#>'{current_document,reference}';b jsonb:=v#>'{repeat_document,reference}';support jsonb;residual jsonb;
begin
 if private.awardping_program_exact_object(v,array['schema','kind','cohort_key','source_id','epoch','expected_head','candidate_id','candidate_hash','candidate','paid_reservation','current_document','repeat_document','current_raw','repeat_raw','rules','widget_proofs','support_projection','support_hash','verified_at']) is distinct from true
  or v->>'schema' is distinct from 'awardping.current-basic-reviewed-repeat-validation.v1' or v->>'kind' is distinct from 'reviewed_no_program_change'
  or octet_length(v::text)>33554432
  or private.awardping_program_source_approval_document_valid(v->'current_document') is distinct from true
  or private.awardping_program_source_approval_document_valid(v->'repeat_document') is distinct from true
  or private.awardping_reviewed_repeat_raw_valid(v->'current_document',v->'current_raw') is distinct from true
  or private.awardping_reviewed_repeat_raw_valid(v->'repeat_document',v->'repeat_raw') is distinct from true
  or a->'source' is distinct from b->'source' or a->'final_url' is distinct from b->'final_url' or a->'acquisition' is distinct from b->'acquisition' or a->'extractor' is distinct from b->'extractor'
  or a#>>'{source,id}' is distinct from v->>'source_id' or a->'capture_id'=b->'capture_id' or a->'captured_at'=b->'captured_at'
  or a#>'{artifacts,metadata,object_key}'=b#>'{artifacts,metadata,object_key}' or (b->>'captured_at')::timestamptz>=(a->>'captured_at')::timestamptz
  or (v->>'verified_at')::timestamptz<(a->>'captured_at')::timestamptz
  or private.awardping_reviewed_repeat_candidate_valid(v) is distinct from true
  or private.awardping_reviewed_repeat_rules_valid(v) is distinct from true then return false;end if;
 residual:=private.awardping_reviewed_repeat_residual(v,'repeat');
 if residual is null or residual is distinct from private.awardping_reviewed_repeat_residual(v,'current') then return false;end if;
 support:=private.awardping_reviewed_repeat_support(null,(v->>'source_id')::uuid,v);
 return support is not null and support=v->'support_projection' and private.awardping_reviewed_repeat_hash(support)=v->>'support_hash';
exception when others then return false;end;$$;

create function public.inspect_program_basic_reviewed_repeat(p_cohort_key text,p_source_id uuid,p_candidate_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare packet jsonb;c jsonb;begin
 packet:=public.inspect_current_program_basic_award(p_cohort_key);c:=private.awardping_reviewed_repeat_candidate(p_candidate_id);
 if c is null or c->>'shared_award_source_id' is distinct from p_source_id::text or not exists(select 1 from jsonb_array_elements(packet#>'{context,sources}') s where s->>'id'=p_source_id::text)
 then raise exception 'Exact current cohort source and normal candidate required.' using errcode='23514';end if;
 return jsonb_build_object('schema','awardping.current-basic-reviewed-repeat-inspection.v1','packet',packet,'candidate',c,
  'candidate_hash',private.awardping_reviewed_repeat_hash(c),'paid_reservation',private.awardping_reviewed_repeat_paid(c));
end;$$;

create function private.awardping_reviewed_repeat_row_current(p_id uuid) returns boolean language plpgsql stable set search_path='' as $$
declare o public.program_basic_reviewed_repeat_observations%rowtype;s public.shared_award_sources%rowtype;
begin
 select * into strict o from public.program_basic_reviewed_repeat_observations where id=p_id;
 select * into strict s from public.shared_award_sources where id=o.source_id;
 return coalesce(o.kind='reviewed_no_program_change' and o.validation->>'kind'=o.kind
  and o.content_hash=encode(extensions.digest(convert_to(o.validation::text,'UTF8'),'sha256'),'hex')
  and o.current_ref=o.validation#>'{current_document,reference}' and o.repeat_ref=o.validation#>'{repeat_document,reference}'
  and o.candidate_id::text=o.validation->>'candidate_id' and o.candidate_hash=o.validation->>'candidate_hash' and o.support_hash=o.validation->>'support_hash'
  and o.epoch::text=o.validation->>'epoch' and o.expected_head::text=o.validation->>'expected_head' and o.source_id::text=o.validation->>'source_id'
  and o.cohort_key=o.validation->>'cohort_key' and o.verified_at=(o.validation->>'verified_at')::timestamptz
  and s.text_monitoring_state->>'status'='baseline_ready' and s.text_monitoring_state->'latest_ref'=o.current_ref
  and private.awardping_current_basic_source_ready(s.id,o.cohort_key,o.epoch,o.current_ref)
  and private.awardping_reviewed_repeat_candidate_valid(o.validation),false);
exception when others then return false;end;$$;

create function private.awardping_reviewed_repeat_proof_valid(v_review jsonb,p_proof jsonb,p_ref jsonb,p_parent uuid default null)
returns boolean language plpgsql stable set search_path='' as $$
declare o public.program_basic_reviewed_repeat_observations%rowtype;h uuid;head_ok boolean:=false;projection jsonb;
begin
 if private.awardping_program_exact_object(p_proof,array['source_id','repeat_observation_id','pending_alert_review_id','pending_alert_review_hash','kind','reviewed_repeat_observation_id','reviewed_repeat_hash']) is distinct from true
  or p_proof->>'kind' is distinct from 'reviewed_no_program_change' or p_proof->'repeat_observation_id' is distinct from 'null'::jsonb
  or p_proof->'pending_alert_review_id' is distinct from 'null'::jsonb or p_proof->'pending_alert_review_hash' is distinct from 'null'::jsonb
 then return false;end if;
 select * into strict o from public.program_basic_reviewed_repeat_observations where id=(p_proof->>'reviewed_repeat_observation_id')::uuid;
 if o.source_id::text is distinct from p_proof->>'source_id' or o.source_id::text is distinct from p_ref#>>'{source,id}'
  or o.cohort_key is distinct from v_review->>'cohort_key' or o.epoch::text is distinct from v_review->>'epoch'
  or o.content_hash is distinct from p_proof->>'reviewed_repeat_hash' or o.current_ref is distinct from p_ref
  or private.awardping_reviewed_repeat_row_current(o.id) is distinct from true then return false;end if;
 if p_parent is not null then head_ok:=o.expected_head=p_parent;else
  select snapshot_id into h from public.program_basic_fact_heads where cohort_key=o.cohort_key;
  head_ok:=o.expected_head=h or exists(select 1 from public.program_basic_fact_snapshots x join public.program_text_fact_reviews d on d.id=x.input_review_id
   where x.id=h and x.previous_snapshot_id=o.expected_head and d.content_hash=x.input_review_hash
    and d.content_hash=encode(extensions.digest(convert_to(d.validation::text,'UTF8'),'sha256'),'hex')
    and d.validation->'review'=v_review and (x.receipt->'current_source_proofs') @> jsonb_build_array(p_proof));
 end if;
 if head_ok is distinct from true then return false;end if;
 projection:=private.awardping_reviewed_repeat_support(v_review,o.source_id,o.validation);
 return projection is not null and projection=o.validation->'support_projection' and private.awardping_reviewed_repeat_hash(projection)=o.support_hash;
exception when others then return false;end;$$;

create function private.awardping_reviewed_repeat_commit_heads_valid(p_validation jsonb,p_parent uuid)
returns boolean language plpgsql stable set search_path='' as $$
declare p jsonb;o public.program_basic_reviewed_repeat_observations%rowtype;
begin
 for p in select value from jsonb_array_elements(p_validation->'current_source_proofs') where value->>'kind'='reviewed_no_program_change' loop
  select * into strict o from public.program_basic_reviewed_repeat_observations where id=(p->>'reviewed_repeat_observation_id')::uuid;
  if o.expected_head is distinct from p_parent then return false;end if;
 end loop;return true;
exception when others then return false;end;$$;

create function private.awardping_reviewed_repeat_version_valid(p_snapshot uuid,p_version jsonb)
returns boolean language plpgsql stable set search_path='' as $$
declare x public.program_basic_fact_snapshots%rowtype;d public.program_text_fact_reviews%rowtype;o public.program_basic_reviewed_repeat_observations%rowtype;p jsonb;
begin
 if private.awardping_program_exact_object(p_version,array['source_id','owner_id','url','epoch','content_identity','repeat_observation_id','pending_alert_review_id','pending_alert_review_hash','kind','reviewed_repeat_observation_id','reviewed_repeat_hash']) is distinct from true
  or p_version->>'kind' is distinct from 'reviewed_no_program_change' then return false;end if;
 select * into strict x from public.program_basic_fact_snapshots where id=p_snapshot;
 select * into strict d from public.program_text_fact_reviews where id=x.input_review_id;
 if d.content_hash is distinct from x.input_review_hash or d.content_hash is distinct from encode(extensions.digest(convert_to(d.validation::text,'UTF8'),'sha256'),'hex') then return false;end if;
 select * into strict o from public.program_basic_reviewed_repeat_observations where id=(p_version->>'reviewed_repeat_observation_id')::uuid;
 p:=jsonb_build_object('source_id',p_version->'source_id','repeat_observation_id',p_version->'repeat_observation_id',
  'pending_alert_review_id',p_version->'pending_alert_review_id','pending_alert_review_hash',p_version->'pending_alert_review_hash',
  'kind',p_version->'kind','reviewed_repeat_observation_id',p_version->'reviewed_repeat_observation_id','reviewed_repeat_hash',p_version->'reviewed_repeat_hash');
 return coalesce(o.cohort_key=x.cohort_key and o.epoch::text=p_version->>'epoch'
  and o.current_ref#>>'{source,shared_award_id}'=p_version->>'owner_id' and o.current_ref#>>'{source,url}'=p_version->>'url'
  and private.awardping_basic_content_identity(o.current_ref)=p_version->'content_identity' and (x.receipt->'current_source_proofs') @> jsonb_build_array(p)
  and private.awardping_reviewed_repeat_proof_valid(d.validation->'review',p,o.current_ref,x.previous_snapshot_id),false);
exception when others then return false;end;$$;

create function public.attest_program_basic_reviewed_repeat(p_validation jsonb,p_actor text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb:=p_validation;o public.program_basic_reviewed_repeat_observations%rowtype;h uuid;hash text;sid uuid;cid uuid;e uuid;
begin
 if coalesce(p_actor,'') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then raise exception 'Real actor UUID required.' using errcode='23514';end if;
 if not exists(select 1 from auth.users where id=p_actor::uuid)
  or octet_length(v::text)>33554432 or not coalesce((v->>'verified_at')::timestamptz between clock_timestamp()-interval '15 minutes' and clock_timestamp(),false)
 then raise exception 'Fresh genuine reviewed-repeat verification and real actor required.' using errcode='23514';end if;
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('awardping-basic-facts:'||(v->>'cohort_key'),0));
 sid:=(v->>'source_id')::uuid;cid:=(v->>'candidate_id')::uuid;e:=(v->>'epoch')::uuid;
 perform 1 from public.shared_award_sources where id=sid for share;
 perform 1 from public.shared_award_visual_review_candidates where id=cid for share;
 perform 1 from public.program_text_source_roster where cohort_key=v->>'cohort_key' for share;
 if v#>>'{candidate,worker_metadata,gemini_spend_reservation_id}' is not null then
  perform 1 from public.gemini_spend_reservations where id=(v#>>'{candidate,worker_metadata,gemini_spend_reservation_id}')::uuid for share;
 end if;
 select snapshot_id into strict h from public.program_basic_fact_heads where cohort_key=v->>'cohort_key' for share;
 if h::text is distinct from v->>'expected_head' or private.awardping_reviewed_repeat_validation_valid(v) is distinct from true
  or private.awardping_current_basic_source_ready(sid,v->>'cohort_key',e,v#>'{current_document,reference}') is distinct from true
  or not exists(select 1 from public.shared_award_sources where id=sid and text_monitoring_state->>'status'='baseline_ready')
 then raise exception 'Exact current parent, source and ordinary reviewed originals changed.' using errcode='40001';end if;
 hash:=encode(extensions.digest(convert_to(v::text,'UTF8'),'sha256'),'hex');
 select * into o from public.program_basic_reviewed_repeat_observations where cohort_key=v->>'cohort_key' and source_id=sid and epoch=e and expected_head=h and candidate_id=cid and support_hash=v->>'support_hash';
 if found then
  if o.validation is distinct from v or o.actor is distinct from p_actor or o.content_hash is distinct from hash then raise exception 'Reviewed-repeat replay differs.' using errcode='40001';end if;
  return jsonb_build_object('ok',true,'id',o.id,'content_hash',o.content_hash,'already_applied',true);
 end if;
 insert into public.program_basic_reviewed_repeat_observations(kind,cohort_key,source_id,epoch,expected_head,candidate_id,candidate_hash,current_ref,repeat_ref,support_hash,validation,content_hash,verified_at,actor)
 values('reviewed_no_program_change',v->>'cohort_key',sid,e,h,cid,v->>'candidate_hash',v#>'{current_document,reference}',v#>'{repeat_document,reference}',v->>'support_hash',v,hash,(v->>'verified_at')::timestamptz,p_actor) returning * into o;
 return jsonb_build_object('ok',true,'id',o.id,'content_hash',o.content_hash,'already_applied',false);
end;$$;

create function private.awardping_reviewed_repeat_raw_valid(d jsonb,r jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare bytes bytea;t text;begin
 if private.awardping_program_exact_object(r,array['artifact','raw_base64']) is distinct from true
  or r->'artifact' is distinct from d#>'{reference,artifacts,raw}' or d#>>'{reference,acquisition}' is distinct from 'http_html'
  or jsonb_typeof(r->'raw_base64') is distinct from 'string' or octet_length(r->>'raw_base64') not between 4 and 2796204
  or coalesce(r->>'raw_base64','') !~ '^[A-Za-z0-9+/]*={0,2}$' then return false;end if;
 bytes:=decode(r->>'raw_base64','base64');t:=convert_from(bytes,'UTF8');
 return octet_length(bytes) between 1 and 2097152 and octet_length(bytes)::text=r#>>'{artifact,byte_length}'
  and encode(extensions.digest(bytes,'sha256'),'hex')=r#>>'{artifact,sha256}'
  and replace(encode(bytes,'base64'),E'\n','')=r->>'raw_base64' and convert_to(t,'UTF8')=bytes
  and position(decode('00','hex') in bytes)=0 and substring(bytes from 1 for 3)<>decode('efbbbf','hex');
exception when others then return false;end;$$;
create function private.awardping_reviewed_cf_hex(t text) returns text language plpgsql immutable set search_path='' as $$
declare b bytea;out bytea:=''::bytea;n integer;x integer;begin
 if coalesce(t,'') !~ '^/cdn-cgi/l/email-protection#[0-9a-fA-F]+$'
  or length(split_part(t,'#',2)) not between 6 and 8194 or length(split_part(t,'#',2))%2<>0 then return null;end if;
 b:=decode(split_part(t,'#',2),'hex');
 for n in 1..octet_length(b)-1 loop x:=get_byte(b,n)#get_byte(b,0);if x not between 33 and 126 then return null;end if;out:=out||set_byte(decode('00','hex'),0,x);end loop;
 return encode(out,'hex');exception when others then return null;end;$$;

create function private.awardping_reviewed_marker_valid(m jsonb,r jsonb,p_profile text,p_source uuid,p_side jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare raw_text text:=convert_from(decode(r->>'raw_base64','base64'),'UTF8');expected_selector text;expected_count integer;expected_heading jsonb;
begin
 if private.awardping_program_exact_object(m,array['profile','selector','start_utf16','end_utf16','html','html_sha256','container_attributes','raw_container_attributes','card_count','heading','excluded_support_block_ids']) is distinct from true
  or m->>'profile' is distinct from p_profile or jsonb_typeof(m->'start_utf16') is distinct from 'number'
  or jsonb_typeof(m->'end_utf16') is distinct from 'number'
  or private.awardping_program_utf16_slice(raw_text,(m->>'start_utf16')::integer,(m->>'end_utf16')::integer) is distinct from m->>'html'
  or encode(extensions.digest(convert_to(m->>'html','UTF8'),'sha256'),'hex') is distinct from m->>'html_sha256'
  or jsonb_typeof(m->'container_attributes') is distinct from 'object' or jsonb_typeof(m->'raw_container_attributes') is distinct from 'object'
  or jsonb_typeof(m->'excluded_support_block_ids') is distinct from 'array' or jsonb_array_length(m->'excluded_support_block_ids') not between 1 and 20000
  or exists(select 1 from jsonb_array_elements_text(m->'excluded_support_block_ids') id where not exists(select 1 from jsonb_array_elements(p_side->'blocks') b where b->>'id'=id))
 then return false;end if;
 if p_profile='james_madison_sidebar_testimonials.v1' and p_source='0f217532-3638-4cc4-8548-7ae9f4eec489' then
  expected_selector:='div#block-views-block-testimonial-block-block-1.views-element-container';expected_count:=3;expected_heading:='null'::jsonb;
 elsif p_profile='soros_featured_fellows.v1' and p_source in('bd79bc43-dd42-4f0b-8323-7c981587b261','c2affec3-e89a-4ada-b1eb-955ad72e7646') then
  expected_selector:='div.wp-block-acf-featured-fellows';expected_count:=2;expected_heading:='"Featured Fellows"'::jsonb;
 elsif p_profile='daad_sponsored_university_carousel.v1' and p_source='56aa30ee-164e-489a-ae5c-f2902dbb0db5' then
  expected_selector:='div.bg-lightgrey.u-p-medium.js-ad-slider.is-relative[role="region"][aria-roledescription="Karussell"]';expected_count:=11;expected_heading:='"Advertisements by German Universities"'::jsonb;
 else return false;end if;
 return m->>'selector'=expected_selector and m->'card_count'=to_jsonb(expected_count) and m->'heading'=expected_heading
  and case when p_profile='daad_sponsored_university_carousel.v1' then
   m->'container_attributes'=m->'raw_container_attributes'-'aria-labelledby' and m#>>'{raw_container_attributes,aria-labelledby}' ~ '^headline-[a-f0-9]{8,32}$'
   else m->'container_attributes'=m->'raw_container_attributes' end;
exception when others then return false;end;$$;

-- Parser/DOM membership is replayed by the service module, never asserted by
-- this SQL envelope. SQL verifies exact raw slices, profiles and whole-page
-- literal conservation, and forbids every marked widget block as fact support.
create function private.awardping_reviewed_repeat_rules_valid(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare changes jsonb:=v#>'{candidate,prompt_payload,comparison,changed_blocks}';rule jsonb;change jsonb;wp jsonb;before_b jsonb;after_b jsonb;side text;m jsonb;raw_text text;old_m jsonb;new_m jsonb;
begin
 if jsonb_typeof(v->'rules') is distinct from 'array' or jsonb_typeof(changes) is distinct from 'array'
  or jsonb_array_length(changes) not between 1 and 256 or jsonb_array_length(changes)<>jsonb_array_length(v->'rules')
  or (select count(distinct x->>'change_id') from jsonb_array_elements(v->'rules') x)<>jsonb_array_length(changes)
  or jsonb_typeof(v->'widget_proofs') is distinct from 'array' or jsonb_array_length(v->'widget_proofs')>1 then return false;end if;
 for wp in select value from jsonb_array_elements(v->'widget_proofs') loop
  if private.awardping_program_exact_object(wp,array['profile','previous_marker','current_marker']) is distinct from true
   or private.awardping_reviewed_marker_valid(wp->'previous_marker',v->'repeat_raw',wp->>'profile',(v->>'source_id')::uuid,v->'repeat_document') is distinct from true
   or private.awardping_reviewed_marker_valid(wp->'current_marker',v->'current_raw',wp->>'profile',(v->>'source_id')::uuid,v->'current_document') is distinct from true
   or wp#>'{previous_marker,container_attributes}' is distinct from wp#>'{current_marker,container_attributes}' then return false;end if;
 end loop;
 for rule in select value from jsonb_array_elements(v->'rules') loop
  select value into strict change from jsonb_array_elements(changes) where value->>'id'=rule->>'change_id';before_b:=change->'previous';after_b:=change->'current';
  if rule->>'kind'='raw_marked_ancillary_widget' then
   if private.awardping_program_exact_object(rule,array['change_id','kind','profile']) is distinct from true then return false;end if;
   select value into strict wp from jsonb_array_elements(v->'widget_proofs') where value->>'profile'=rule->>'profile';
   if before_b<>'null'::jsonb and not (wp#>'{previous_marker,excluded_support_block_ids}') ? (before_b->>'id')
    or after_b<>'null'::jsonb and not (wp#>'{current_marker,excluded_support_block_ids}') ? (after_b->>'id') then return false;end if;
  else
   if before_b='null'::jsonb or after_b='null'::jsonb or (before_b-'id'-'text'-'start_utf16'-'end_utf16') is distinct from (after_b-'id'-'text'-'start_utf16'-'end_utf16') then return false;end if;
   if rule->>'kind'='identical_protected_email_destination' then
    if private.awardping_program_exact_object(rule,array['change_id','kind','decoded_hex']) is distinct from true
     or before_b->>'kind' is distinct from 'source_link' or before_b#>>'{context,source_attribute}' is distinct from 'href'
     or private.awardping_reviewed_cf_hex(before_b->>'text') is distinct from rule->>'decoded_hex'
     or private.awardping_reviewed_cf_hex(after_b->>'text') is distinct from rule->>'decoded_hex' or rule->>'decoded_hex' is null then return false;end if;
   elsif rule->>'kind'='hidden_gravityforms_honeypot_label' then
    if private.awardping_program_exact_object(rule,array['change_id','kind','previous_marker','current_marker']) is distinct from true
     or v->>'source_id' is distinct from 'f322a07c-f78c-47fd-aafb-ab6422a4248f' or before_b->>'kind' is distinct from 'li' then return false;end if;
    old_m:=rule->'previous_marker';new_m:=rule->'current_marker';
    if old_m->>'label' not in('URL','LinkedIn') or new_m->>'label' not in('URL','LinkedIn') or old_m->>'label'=new_m->>'label'
     or replace(old_m->>'html','>'||(old_m->>'label')||'</span>','>'||(new_m->>'label')||'</span>') is distinct from new_m->>'html'
     or before_b->>'text' is distinct from (old_m->>'label')||' This field is for validation purposes and should be left unchanged.'
     or after_b->>'text' is distinct from (new_m->>'label')||' This field is for validation purposes and should be left unchanged.' then return false;end if;
    foreach side in array array['repeat','current'] loop
     m:=case when side='repeat' then old_m else new_m end;raw_text:=convert_from(decode(v#>>array[side||'_raw','raw_base64'],'base64'),'UTF8');
     if private.awardping_program_exact_object(m,array['start_utf16','end_utf16','html','html_sha256','wrapper_start_utf16','wrapper_start_tag','form_start_utf16','form_start_tag','label']) is distinct from true
      or private.awardping_program_utf16_slice(raw_text,(m->>'start_utf16')::integer,(m->>'end_utf16')::integer) is distinct from m->>'html'
      or encode(extensions.digest(convert_to(m->>'html','UTF8'),'sha256'),'hex') is distinct from m->>'html_sha256'
      or private.awardping_program_utf16_slice(raw_text,(m->>'wrapper_start_utf16')::integer,(m->>'wrapper_start_utf16')::integer+private.awardping_program_utf16_length(m->>'wrapper_start_tag')) is distinct from m->>'wrapper_start_tag'
      or private.awardping_program_utf16_slice(raw_text,(m->>'form_start_utf16')::integer,(m->>'form_start_utf16')::integer+private.awardping_program_utf16_length(m->>'form_start_tag')) is distinct from m->>'form_start_tag'
      or position('gform_wrapper_5' in m->>'wrapper_start_tag')=0 or position('gform_5' in m->>'form_start_tag')=0
      or position('gfield--type-honeypot' in m->>'html')=0 then return false;end if;
    end loop;
   else return false;end if;
  end if;
  foreach side in array array['repeat','current'] loop
   m:=case when side='repeat' then before_b else after_b end;
   if m<>'null'::jsonb and not exists(select 1 from jsonb_array_elements(v#>array[side||'_document','blocks']) b where b->>'id'=m->>'id'
    and b->>'text'=m->>'text' and b->'start_utf16'=m->'start_utf16' and b->'end_utf16'=m->'end_utf16') then return false;end if;
  end loop;
 end loop;return true;
exception when others then return false;end;$$;


revoke all on function private.awardping_reviewed_repeat_hash(jsonb),private.awardping_reviewed_repeat_candidate(uuid),
 private.awardping_reviewed_repeat_paid(jsonb),private.awardping_reviewed_repeat_comparison_ref(jsonb),private.awardping_reviewed_repeat_candidate_valid(jsonb),
 private.awardping_reviewed_repeat_residual(jsonb,text),private.awardping_reviewed_repeat_support(jsonb,uuid,jsonb),
 private.awardping_reviewed_repeat_validation_valid(jsonb),private.awardping_reviewed_repeat_raw_valid(jsonb,jsonb),
 private.awardping_reviewed_cf_hex(text),private.awardping_reviewed_marker_valid(jsonb,jsonb,text,uuid,jsonb),
 private.awardping_reviewed_repeat_rules_valid(jsonb),private.awardping_reviewed_repeat_row_current(uuid),
 private.awardping_reviewed_repeat_proof_valid(jsonb,jsonb,jsonb,uuid),private.awardping_reviewed_repeat_commit_heads_valid(jsonb,uuid),
 private.awardping_reviewed_repeat_version_valid(uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.inspect_program_basic_reviewed_repeat(text,uuid,uuid),public.attest_program_basic_reviewed_repeat(jsonb,text) from public,anon,authenticated;
grant execute on function public.inspect_program_basic_reviewed_repeat(text,uuid,uuid),public.attest_program_basic_reviewed_repeat(jsonb,text) to service_role;

-- BEGIN REVIEWED REPEAT DISPATCH
-- Additive dispatcher fragment. Append after reviewed-repeat ledger/helpers.
-- Exact production function-definition preimages are pinned from the immutable
-- read-only 2026-10-31T21:54 receipt; old byte-proof statements stay unchanged.
-- This file contains no transaction wrapper or migration-history operation.

do $dispatch_proofs$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('private.awardping_current_basic_proofs_valid(jsonb,jsonb)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'d14cd8e0d32c8fc7341255444399cd019b95b1bff00a8fdc002dab079c071196' then
  raise exception 'Reviewed-repeat dispatcher preimage changed: proofs.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$dispatch_proofs_0_before$  if not private.awardping_program_exact_object(p,array['source_id','repeat_observation_id','pending_alert_review_id','pending_alert_review_hash']) then return false;end if;$dispatch_proofs_0_before$,$dispatch_proofs_0_after$  if p ? 'kind' then
   if p->>'kind' is distinct from 'reviewed_no_program_change' or not coalesce(private.awardping_reviewed_repeat_proof_valid(v_review,p,r,null),false) then return false;end if;
   continue;
  end if;
  if not private.awardping_program_exact_object(p,array['source_id','repeat_observation_id','pending_alert_review_id','pending_alert_review_hash']) then return false;end if;$dispatch_proofs_0_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'f4a67c8284665ef8734373e584f385ee888ce19ca92eba2520d361fbe8c74896' then
  raise exception 'Reviewed-repeat dispatcher replacement differs: proofs.' using errcode='40001';
 end if;
 execute v_after;
end;
$dispatch_proofs$;

do $dispatch_context$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('public.inspect_current_program_basic_award(text)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'76e6ed96c7f624f671eda62538d404490b815facb6697255c8b2a310ffec5a89' then
  raise exception 'Reviewed-repeat dispatcher preimage changed: context.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$dispatch_context_0_before$head uuid;pending jsonb;observations jsonb;$dispatch_context_0_before$,$dispatch_context_0_after$head uuid;pending jsonb;observations jsonb;reviewed_observations jsonb;$dispatch_context_0_after$);
 v_after:=replace(v_after,$dispatch_context_1_before$ select snapshot_id into head from public.program_basic_fact_heads where cohort_key=p_cohort_key;$dispatch_context_1_before$,$dispatch_context_1_after$ select snapshot_id into head from public.program_basic_fact_heads where cohort_key=p_cohort_key;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',o.id,'kind',o.kind,'cohort_key',o.cohort_key,'source_id',o.source_id,'epoch',o.epoch,'expected_head',o.expected_head,
  'candidate_id',o.candidate_id,'candidate_hash',o.candidate_hash,'current_ref',o.current_ref,'repeat_ref',o.repeat_ref,
  'support_hash',o.support_hash,'content_hash',o.content_hash,'verified_at',o.verified_at,'actor',o.actor,
  'candidate',o.validation->'candidate','paid_reservation',o.validation->'paid_reservation','rules',o.validation->'rules',
  'widget_proofs',o.validation->'widget_proofs','support_projection',o.validation->'support_projection') order by o.created_at desc,o.id),'[]'::jsonb)
 into reviewed_observations from (select limited.* from public.shared_award_sources x cross join lateral (
  select z.* from public.program_basic_reviewed_repeat_observations z
  where z.cohort_key=p_cohort_key and z.epoch=e and z.source_id=x.id and z.expected_head is not distinct from head
   and z.current_ref=x.text_monitoring_state->'latest_ref' and private.awardping_reviewed_repeat_row_current(z.id)
  order by z.created_at desc,z.id limit 2
 ) limited where x.id=any(ids)) o;$dispatch_context_1_after$);
 v_after:=replace(v_after,$dispatch_context_2_before$'pending_alert_reviews',pending,'repeat_observations',observations)$dispatch_context_2_before$,$dispatch_context_2_after$'pending_alert_reviews',pending,'repeat_observations',observations,'basic_fact_head_id',head,'reviewed_repeat_observations',reviewed_observations)$dispatch_context_2_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'89043af512a1103dd6c4e2e5ce2f974ab096240419a8e354b189ba8c9cd4cd3f' then
  raise exception 'Reviewed-repeat dispatcher replacement differs: context.' using errcode='40001';
 end if;
 execute v_after;
end;
$dispatch_context$;

do $dispatch_commit$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('public.commit_current_program_basic_facts(uuid,text,uuid,jsonb,text,text)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'4df0cd318e6e3d9ced7e79228ba4b66a463a7f88dfcb5e66845820825aa81ff0' then
  raise exception 'Reviewed-repeat dispatcher preimage changed: commit.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$dispatch_commit_0_before$ if d.content_hash is distinct from p_expected_draft_hash or not private.awardping_current_basic_validation_valid(d.validation)$dispatch_commit_0_before$,$dispatch_commit_0_after$ if d.content_hash is distinct from p_expected_draft_hash or not private.awardping_current_basic_validation_valid(d.validation)
 or not coalesce(private.awardping_reviewed_repeat_commit_heads_valid(d.validation,p_expected_head_id),false)$dispatch_commit_0_after$);
 v_after:=replace(v_after,$dispatch_commit_1_before$'pending_alert_review_hash',p->'pending_alert_review_hash') order by r#>>'{source,id}') into versions$dispatch_commit_1_before$,$dispatch_commit_1_after$'pending_alert_review_hash',p->'pending_alert_review_hash')
 ||case when p->>'kind'='reviewed_no_program_change' then jsonb_build_object('kind','reviewed_no_program_change',
  'reviewed_repeat_observation_id',p->'reviewed_repeat_observation_id','reviewed_repeat_hash',p->'reviewed_repeat_hash') else '{}'::jsonb end
 order by r#>>'{source,id}') into versions$dispatch_commit_1_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'6bd79591ad413ae6875414fa32d49ccecc85b0ee031591b29a1d138d3e947d31' then
  raise exception 'Reviewed-repeat dispatcher replacement differs: commit.' using errcode='40001';
 end if;
 execute v_after;
end;
$dispatch_commit$;

do $dispatch_currentness$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('private.awardping_current_basic_fact_current(uuid)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'2a217b35fe7884cdf7ec5740c7b1d4b61976e854af791a1fa217821ca8e0c223' then
  raise exception 'Reviewed-repeat dispatcher preimage changed: currentness.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$dispatch_currentness_0_before$  select * into strict s from public.shared_award_sources where id=(v->>'source_id')::uuid;$dispatch_currentness_0_before$,$dispatch_currentness_0_after$  select * into strict s from public.shared_award_sources where id=(v->>'source_id')::uuid;
  if v ? 'kind' then
   if v->>'kind' is distinct from 'reviewed_no_program_change' or not coalesce(private.awardping_reviewed_repeat_version_valid(x.id,v),false) then return false;end if;
   continue;
  end if;$dispatch_currentness_0_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'d130ce8def118e6297b13b578cbf048641a290e579a68f22caf17c28888c053d' then
  raise exception 'Reviewed-repeat dispatcher replacement differs: currentness.' using errcode='40001';
 end if;
 execute v_after;
end;
$dispatch_currentness$;


-- END REVIEWED REPEAT DISPATCH
notify pgrst,'reload schema';
