-- Separate retained post-change probe purpose. The causal accepted change and
-- actual approved owner review are preserved. No normal no-change outcome is invented.
-- Service cold-replays three complete originals, causal model responses and DOM;
-- SQL seals current source, approved publication provenance, raw bytes and conservation.
create table public.program_basic_technical_repeat_observations (
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind='retained_technical_repeat'),
 provenance_kind text not null check(provenance_kind='post_change_technical_probe'),
 cohort_key text not null references public.program_award_registry(cohort_key) check(cohort_key='daad_study'),
 source_id uuid not null references public.shared_award_sources(id) check(source_id='88906939-65e7-492d-a671-da56678dfecd'),
 epoch uuid not null,expected_head uuid not null references public.program_basic_fact_snapshots(id),
 causal_candidate_id uuid not null references public.shared_award_visual_review_candidates(id),
 causal_candidate_hash text not null check(causal_candidate_hash~'^[a-f0-9]{64}$'),
 owner_review_id uuid not null references public.program_text_alert_reviews(id),
 owner_review_hash text not null check(owner_review_hash~'^[a-f0-9]{64}$'),
 causal_previous_ref jsonb not null,current_ref jsonb not null,probe_ref jsonb not null,
 support_hash text not null check(support_hash~'^[a-f0-9]{64}$'),
 validation jsonb not null check(octet_length(validation::text)<=33554432),
 content_hash text not null check(content_hash~'^[a-f0-9]{64}$'),
 verified_at timestamptz not null,created_at timestamptz not null default clock_timestamp(),actor text not null,
 check(owner_review_id=causal_candidate_id),
 unique(cohort_key,source_id,epoch,expected_head,causal_candidate_id,support_hash)
);
alter table public.program_basic_technical_repeat_observations enable row level security;
revoke all on public.program_basic_technical_repeat_observations from public,anon,authenticated,service_role;
grant select on public.program_basic_technical_repeat_observations to service_role;
create index basic_technical_repeat_current on public.program_basic_technical_repeat_observations(cohort_key,source_id,epoch,expected_head,created_at desc);
create trigger basic_technical_repeat_immutable before update or delete on public.program_basic_technical_repeat_observations
 for each row execute function private.awardping_basic_repeat_immutable();
create trigger basic_technical_repeat_no_truncate before truncate on public.program_basic_technical_repeat_observations
 for each statement execute function private.awardping_basic_repeat_immutable();

-- Pure algorithm aliases: repeat=earlier current and current=later probe. The
-- original capture references/text are untouched and no candidate is synthesized.
create function private.awardping_technical_repeat_pair(v jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('source_id',v->'source_id','repeat_document',v->'current_document','current_document',v->'probe_document',
  'repeat_raw',v->'current_raw','current_raw',v->'probe_raw','technical_comparison',v->'technical_comparison','rules',v->'rules',
  'widget_proofs',coalesce((select jsonb_agg(jsonb_build_object('profile',w->'profile','previous_marker',w->'current_marker','current_marker',w->'probe_marker'))
   from jsonb_array_elements(v->'widget_proofs') w),'[]'::jsonb));
$$;
create function private.awardping_technical_repeat_support(p_review jsonb,p_source uuid,v jsonb) returns jsonb language sql immutable set search_path='' as $$
 select private.awardping_reviewed_repeat_support(p_review,p_source,v||jsonb_build_object('repeat_document',v->'probe_document',
  'widget_proofs',coalesce((select jsonb_agg(jsonb_build_object('profile',w->'profile','current_marker',w->'current_marker','previous_marker',w->'probe_marker'))
   from jsonb_array_elements(v->'widget_proofs') w),'[]'::jsonb)));
$$;

create function private.awardping_technical_repeat_owner_review(p_id uuid) returns jsonb language sql stable set search_path='' as $$
 select to_jsonb(r) from public.program_text_alert_reviews r where r.id=p_id;
$$;
create function private.awardping_technical_repeat_published_event(p_id uuid) returns jsonb language sql stable set search_path='' as $$
 select to_jsonb(e) from public.program_text_alert_reviews r join public.shared_award_change_events e on e.id=r.event_id where r.id=p_id;
$$;
create function private.awardping_technical_repeat_published_evidence(p_id uuid) returns jsonb language sql stable set search_path='' as $$
 select case when count(*)=1 then jsonb_agg(to_jsonb(e))->0 else null end from public.program_text_alert_reviews r
 join public.shared_award_change_event_visual_evidence e on e.change_event_id=r.event_id and e.visual_review_candidate_id=r.id where r.id=p_id;
$$;
create function private.awardping_technical_repeat_cause_valid(v jsonb) returns boolean language plpgsql stable set search_path='' as $$
declare c jsonb:=v->'causal_candidate';r jsonb:=v->'owner_review';paid jsonb:=v->'paid_reservation';event jsonb:=v->'published_event';evidence jsonb:=v->'published_evidence';comparison jsonb;cid uuid;actual_candidate public.shared_award_visual_review_candidates%rowtype;
begin
 cid:=(v->>'causal_candidate_id')::uuid;
 select * into strict actual_candidate from public.shared_award_visual_review_candidates where id=cid;
 if c is distinct from private.awardping_reviewed_repeat_candidate(cid)
  or private.awardping_reviewed_repeat_hash(c) is distinct from v->>'causal_candidate_hash'
  or paid is distinct from private.awardping_reviewed_repeat_paid(c)
  or jsonb_typeof(r) is distinct from 'object' or r is distinct from private.awardping_technical_repeat_owner_review(cid)
  or jsonb_typeof(event) is distinct from 'object' or event is distinct from private.awardping_technical_repeat_published_event(cid)
  or jsonb_typeof(evidence) is distinct from 'object' or evidence is distinct from private.awardping_technical_repeat_published_evidence(cid)
  or r->>'id' is distinct from cid::text or r->>'id' is distinct from v->>'owner_review_id'
  or r->>'content_hash' is distinct from v->>'owner_review_hash' or r->>'status' is distinct from 'approved'
  or r->>'content_hash' is distinct from private.program_text_alert_hash(actual_candidate,r->'details',r->'localization')
  or r->>'candidate_signature' is distinct from c->>'candidate_signature' or r->>'reviewed_at' is null or r->>'reviewed_by' is null
  or not exists(select 1 from auth.users where id=(r->>'reviewed_by')::uuid)
  or r->>'event_id' is distinct from event->>'id' or event->>'id' is distinct from c#>>'{worker_metadata,change_event_id}'
  or c#>'{worker_metadata,baseline_advanced}' is distinct from 'true'::jsonb
  or event->>'visual_review_candidate_id' is distinct from cid::text or event->>'shared_award_source_id' is distinct from v->>'source_id'
  or event->>'shared_award_id' is distinct from '440d6985-ece9-48c4-ac30-65a739f60d65' or event->>'source_url' is distinct from c->>'source_url'
  or event->'change_details' is distinct from r->'details' or event->'suppressed_at' is distinct from 'null'::jsonb
  or evidence->>'change_event_id' is distinct from event->>'id' or evidence->>'visual_review_candidate_id' is distinct from cid::text
  or evidence->>'candidate_signature' is distinct from c->>'candidate_signature' or evidence->>'shared_award_source_id' is distinct from v->>'source_id'
  or evidence->>'shared_award_id' is distinct from '440d6985-ece9-48c4-ac30-65a739f60d65'
  or evidence->'previous_capture' is distinct from c->'previous_snapshot_ref' or evidence->'current_capture' is distinct from c->'new_snapshot_ref'
  or evidence->'localization' is distinct from r->'localization' or evidence->>'evidence_status' is distinct from 'verified_text'
  or evidence->>'evidence_schema_version' is distinct from 'program-text-event-evidence-v1'
  or c->>'candidate_scope' is distinct from 'program_text_change' or c->>'status' is distinct from 'published'
  or c->'rejection_reason' is distinct from 'null'::jsonb or c->>'published_at' is null or c->>'completed_at' is null
  or not coalesce((c->>'completed_at')::timestamptz<=(c->>'published_at')::timestamptz and (c->>'published_at')::timestamptz<=(r->>'reviewed_at')::timestamptz
   and (r->>'reviewed_at')::timestamptz<=(v->>'verified_at')::timestamptz,false)
  or (c->>'completed_at')::timestamptz<(v#>>'{current_document,reference,captured_at}')::timestamptz
  or private.awardping_program_exact_object(c->'ai_result',array['responses','program_text_validation']) is distinct from true
  or private.awardping_program_exact_object(c#>'{ai_result,program_text_validation}',array['status','details','reasons','comparison_id']) is distinct from true
  or c#>>'{ai_result,program_text_validation,status}' is distinct from 'accepted'
  or c#>>'{ai_result,program_text_validation,comparison_id}' is distinct from c->>'candidate_signature'
  or c#>'{ai_result,program_text_validation,reasons}' is distinct from '[]'::jsonb or c#>'{ai_result,program_text_validation,details}' is distinct from r->'details'
  or c->>'shared_award_source_id' is distinct from '88906939-65e7-492d-a671-da56678dfecd'
  or c->>'shared_award_id' is distinct from '440d6985-ece9-48c4-ac30-65a739f60d65'
  or c->>'source_url' is distinct from v#>>'{current_document,reference,source,url}'
  or c#>>'{worker_metadata,monitoring_contract}' is distinct from 'program-text-v1' or c#>>'{worker_metadata,epoch}' is distinct from v->>'epoch'
  or c#>>'{worker_metadata,admin_alert_review_id}' is distinct from cid::text or c#>>'{worker_metadata,evidence_signature}' is distinct from c->>'candidate_signature'
  or c->'new_snapshot_ref' is distinct from v#>'{current_document,reference}' or c->'previous_snapshot_ref' is distinct from v#>'{causal_previous_document,reference}'
 then return false;end if;
 comparison:=c#>'{prompt_payload,comparison}';
 if comparison->>'schema' is distinct from 'awardping.program-text-comparison.v1' or comparison->>'status' is distinct from 'review_required'
  or comparison->>'comparison_id' is distinct from c->>'candidate_signature'
  or private.awardping_reviewed_repeat_hash(comparison-'comparison_id') is distinct from c->>'candidate_signature'
  or comparison->>'previous_text' is distinct from v#>>'{causal_previous_document,text}' or comparison->>'current_text' is distinct from v#>>'{current_document,text}'
  or comparison#>>'{context,source_id}' is distinct from v->>'source_id' or comparison#>>'{context,epoch}' is distinct from v->>'epoch'
  or comparison#>>'{context,award_id}' is distinct from '440d6985-ece9-48c4-ac30-65a739f60d65'
  or comparison->'previous_ref' is distinct from private.awardping_reviewed_repeat_comparison_ref(v#>'{causal_previous_document,reference}')
  or comparison->'current_ref' is distinct from private.awardping_reviewed_repeat_comparison_ref(v#>'{current_document,reference}')
  or c#>>'{prompt_payload,packet_plan,status}' is distinct from 'ready' or c#>>'{prompt_payload,packet_plan,comparison_id}' is distinct from c->>'candidate_signature'
  or jsonb_typeof(c#>'{prompt_payload,packet_plan,packets}') is distinct from 'array' or jsonb_array_length(c#>'{prompt_payload,packet_plan,packets}') not between 1 and 200
  or exists(select 1 from jsonb_array_elements(c#>'{prompt_payload,packet_plan,packets}') packet
   where packet->>'comparison_id' is distinct from c->>'candidate_signature' or packet->'context' is distinct from comparison->'context'
    or packet->'previous_ref' is distinct from comparison->'previous_ref' or packet->'current_ref' is distinct from comparison->'current_ref')
 then return false;end if;
 perform public.awardping_validate_program_text_evidence(evidence,to_jsonb(actual_candidate),r->'details');
 return coalesce(paid->>'status'='settled' and paid->>'id'=c#>>'{worker_metadata,gemini_spend_reservation_id}'
  and paid->>'attempt_token'=c#>>'{worker_metadata,gemini_spend_attempt_token}' and paid->>'model'=c->>'model'
  and paid->>'provider_batch_name'=c->>'gemini_batch_name' and paid->>'lane_key'='changed_page_review' and paid->>'worker_source'='program-text-review'
  and paid#>>'{metadata,candidate_id}'=c->>'id' and paid#>>'{metadata,monitoring_contract}'='program-text-v1'
  and paid->>'work_fingerprint'='program-text:'||(c->>'candidate_signature')||':'||(c->>'model')
  and jsonb_typeof(c#>'{worker_metadata,provider_request_keys}')='array'
  and (select count(distinct k) from jsonb_array_elements_text(c#>'{worker_metadata,provider_request_keys}') keys(k))=jsonb_array_length(c#>'{worker_metadata,provider_request_keys}')
  and (select jsonb_agg(k order by k collate "C") from jsonb_array_elements_text(c#>'{worker_metadata,provider_request_keys}') keys(k))
   =(select jsonb_agg(packet->'packet_id' order by (packet->>'packet_id') collate "C") from jsonb_array_elements(c#>'{prompt_payload,packet_plan,packets}') packet)
  and (paid->>'request_count')::integer=jsonb_array_length(c#>'{worker_metadata,provider_request_keys}')
  and (paid->>'request_count')::integer=jsonb_array_length(c#>'{prompt_payload,packet_plan,packets}')
  and paid->>'settled_at' is not null and length(paid->>'spent_source')>0,false);
exception when others then return false;end;$$;

create function private.awardping_technical_repeat_marker_valid(m jsonb,r jsonb,p_profile text,p_source uuid,p_side jsonb) returns boolean
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
 if p_profile='daad889_sponsored_university_carousel.v1' and p_source='88906939-65e7-492d-a671-da56678dfecd' then
  expected_selector:='div.bg-lightgrey.u-p-medium.js-ad-slider.is-relative[role="region"][aria-roledescription="Karussell"]';expected_count:=11;expected_heading:='"Advertisements by German Universities"'::jsonb;
 else return false;end if;
 return m->>'selector'=expected_selector and m->'card_count'=to_jsonb(expected_count) and m->'heading'=expected_heading
  and case when p_profile='daad889_sponsored_university_carousel.v1' then
   m->'container_attributes'=(m->'raw_container_attributes')-'aria-labelledby' and m#>>'{raw_container_attributes,aria-labelledby}' ~ '^headline-[a-f0-9]{8,32}$'
   else m->'container_attributes'=m->'raw_container_attributes' end;
exception when others then return false;end;$$;
create function private.awardping_technical_repeat_residual(v jsonb,p_side text) returns jsonb language plpgsql immutable set search_path='' as $$
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
  select value into strict change from jsonb_array_elements(v#>'{technical_comparison,changed_blocks}') where value->>'id'=rule->>'change_id';
  b:=change->case when p_side='repeat' then 'previous' else 'current' end;
  if not exists(select 1 from jsonb_array_elements(widgets) w where (w->>'start')::integer<=(b->>'start_utf16')::integer and (w->>'end')::integer>=(b->>'end_utf16')::integer) then
   marker:=jsonb_build_array(rule->>'kind',rule->>'decoded_hex');
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
create function private.awardping_technical_repeat_rules_valid(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare changes jsonb:=v#>'{technical_comparison,changed_blocks}';rule jsonb;change jsonb;wp jsonb;before_b jsonb;after_b jsonb;side text;m jsonb;
begin
 if exists(select 1 from jsonb_array_elements(v->'rules') r where r->>'kind' not in('identical_protected_email_destination','raw_marked_ancillary_widget')) then return false;end if;
 if jsonb_typeof(v->'rules') is distinct from 'array' or jsonb_typeof(changes) is distinct from 'array'
  or jsonb_array_length(changes) not between 1 and 256 or jsonb_array_length(changes)<>jsonb_array_length(v->'rules')
  or (select count(distinct x->>'change_id') from jsonb_array_elements(v->'rules') x)<>jsonb_array_length(changes)
  or jsonb_typeof(v->'widget_proofs') is distinct from 'array' or jsonb_array_length(v->'widget_proofs')>1 then return false;end if;
 for wp in select value from jsonb_array_elements(v->'widget_proofs') loop
  if private.awardping_program_exact_object(wp,array['profile','previous_marker','current_marker']) is distinct from true
   or private.awardping_technical_repeat_marker_valid(wp->'previous_marker',v->'repeat_raw',wp->>'profile',(v->>'source_id')::uuid,v->'repeat_document') is distinct from true
   or private.awardping_technical_repeat_marker_valid(wp->'current_marker',v->'current_raw',wp->>'profile',(v->>'source_id')::uuid,v->'current_document') is distinct from true
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
   else return false;end if;
  end if;
  foreach side in array array['repeat','current'] loop
   m:=case when side='repeat' then before_b else after_b end;
   if m<>'null'::jsonb and not exists(select 1 from jsonb_array_elements(v#>array[side||'_document','blocks']) b where b->>'id'=m->>'id'
    and b->>'text'=m->>'text' and b->'start_utf16'=m->'start_utf16' and b->'end_utf16'=m->'end_utf16') then return false;end if;
  end loop;
 end loop;return true;
exception when others then return false;end;$$;
create function private.awardping_technical_repeat_validation_valid(v jsonb) returns boolean language plpgsql stable set search_path='' as $$
declare a jsonb:=v#>'{causal_previous_document,reference}';b jsonb:=v#>'{current_document,reference}';c jsonb:=v#>'{probe_document,reference}';
 comparison jsonb:=v->'technical_comparison';support jsonb;pair jsonb;residual jsonb;d jsonb;field text;
begin
 if private.awardping_program_exact_object(v,array['schema','kind','provenance_kind','cohort_key','source_id','epoch','expected_head','causal_candidate_id','causal_candidate_hash','causal_candidate','owner_review','owner_review_id','owner_review_hash','paid_reservation','published_event','published_evidence','causal_previous_document','causal_previous_raw','current_document','current_raw','probe_document','probe_raw','technical_comparison','rules','widget_proofs','support_projection','support_hash','verified_at']) is distinct from true
  or v->>'schema' is distinct from 'awardping.current-basic-technical-repeat-validation.v1'
  or v->>'kind' is distinct from 'retained_technical_repeat' or v->>'provenance_kind' is distinct from 'post_change_technical_probe'
  or v->>'source_id' is distinct from '88906939-65e7-492d-a671-da56678dfecd' or v->>'cohort_key' is distinct from 'daad_study'
  or jsonb_typeof(v->'widget_proofs') is distinct from 'array' or jsonb_array_length(v->'widget_proofs')>1
  or exists(select 1 from jsonb_array_elements(v->'widget_proofs') w
   where private.awardping_program_exact_object(w,array['profile','current_marker','probe_marker']) is distinct from true)
  or octet_length(v::text)>33554432 then return false;end if;
 foreach field in array array['causal_previous','current','probe'] loop
  d:=v->(field||'_document');
  if private.awardping_program_source_approval_document_valid(d) is distinct from true
   or private.awardping_reviewed_repeat_raw_valid(d,v->(field||'_raw')) is distinct from true
   or d#>>'{reference,source,id}' is distinct from v->>'source_id'
   or d#>>'{reference,source,shared_award_id}' is distinct from '440d6985-ece9-48c4-ac30-65a739f60d65'
   or d#>>'{reference,source,url}' is distinct from 'https://www.daad.org/en/find-funding/scholarship-database/?origin=44&status=3&type=a&q=&onlydaad=1&language=en&detail_to_show=50026200&tab='
   or d#>'{reference,final_url}' is distinct from d#>'{reference,source,url}' then return false;end if;
 end loop;
 if a->'source' is distinct from b->'source' or b->'source' is distinct from c->'source'
  or a->'extractor' is distinct from b->'extractor' or b->'extractor' is distinct from c->'extractor'
  or a->'capture_id'=b->'capture_id' or b->'capture_id'=c->'capture_id' or a->'capture_id'=c->'capture_id'
  or a#>'{artifacts,metadata,object_key}'=b#>'{artifacts,metadata,object_key}'
  or b#>'{artifacts,metadata,object_key}'=c#>'{artifacts,metadata,object_key}' or a#>'{artifacts,metadata,object_key}'=c#>'{artifacts,metadata,object_key}'
  or not coalesce((a->>'captured_at')::timestamptz<(b->>'captured_at')::timestamptz and (b->>'captured_at')::timestamptz<(c->>'captured_at')::timestamptz
   and (v->>'verified_at')::timestamptz>=(c->>'captured_at')::timestamptz,false)
  or private.awardping_technical_repeat_cause_valid(v) is distinct from true
  or private.awardping_program_exact_object(comparison,array['schema','context','previous_ref','current_ref','previous_text','current_text','changed_blocks','ignored_noise_blocks','status','reason','comparison_id']) is distinct from true
  or comparison->>'schema' is distinct from 'awardping.program-text-comparison.v1' or comparison->>'status' is distinct from 'review_required'
  or comparison->'reason' is distinct from 'null'::jsonb or comparison->'ignored_noise_blocks' is distinct from '0'::jsonb
  or private.awardping_program_exact_object(comparison->'context',array['source_id','award_id','epoch','cycle_id']) is distinct from true
  or comparison#>>'{context,source_id}' is distinct from v->>'source_id' or comparison#>>'{context,epoch}' is distinct from v->>'epoch'
  or comparison#>>'{context,award_id}' is distinct from '440d6985-ece9-48c4-ac30-65a739f60d65' or comparison#>'{context,cycle_id}' is distinct from 'null'::jsonb
  or comparison->>'comparison_id' is distinct from private.awardping_reviewed_repeat_hash(comparison-'comparison_id')
  or comparison->>'previous_text' is distinct from v#>>'{current_document,text}' or comparison->>'current_text' is distinct from v#>>'{probe_document,text}'
  or comparison->'previous_ref' is distinct from private.awardping_reviewed_repeat_comparison_ref(b)
  or comparison->'current_ref' is distinct from private.awardping_reviewed_repeat_comparison_ref(c)
 then return false;end if;
 pair:=private.awardping_technical_repeat_pair(v);
 if private.awardping_technical_repeat_rules_valid(pair) is distinct from true then return false;end if;
 residual:=private.awardping_technical_repeat_residual(pair,'repeat');
 if residual is null or residual is distinct from private.awardping_technical_repeat_residual(pair,'current') then return false;end if;
 support:=private.awardping_technical_repeat_support(null,(v->>'source_id')::uuid,v);
 return support is not null and support=v->'support_projection' and private.awardping_reviewed_repeat_hash(support)=v->>'support_hash';
exception when others then return false;end;$$;


create function private.awardping_technical_repeat_row_current(p_id uuid) returns boolean language plpgsql stable set search_path='' as $$
declare o public.program_basic_technical_repeat_observations%rowtype;s public.shared_award_sources%rowtype;
begin
 select * into strict o from public.program_basic_technical_repeat_observations where id=p_id;
 select * into strict s from public.shared_award_sources where id=o.source_id;
 return coalesce(o.kind='retained_technical_repeat' and o.provenance_kind='post_change_technical_probe'
  and o.validation->>'kind'=o.kind and o.validation->>'provenance_kind'=o.provenance_kind
  and o.content_hash=encode(extensions.digest(convert_to(o.validation::text,'UTF8'),'sha256'),'hex')
  and o.causal_previous_ref=o.validation#>'{causal_previous_document,reference}' and o.current_ref=o.validation#>'{current_document,reference}' and o.probe_ref=o.validation#>'{probe_document,reference}'
  and o.causal_candidate_id::text=o.validation->>'causal_candidate_id' and o.causal_candidate_hash=o.validation->>'causal_candidate_hash'
  and o.owner_review_id::text=o.validation->>'owner_review_id' and o.owner_review_hash=o.validation->>'owner_review_hash'
  and o.support_hash=o.validation->>'support_hash' and o.epoch::text=o.validation->>'epoch' and o.expected_head::text=o.validation->>'expected_head'
  and o.source_id::text=o.validation->>'source_id' and o.cohort_key=o.validation->>'cohort_key' and o.verified_at=(o.validation->>'verified_at')::timestamptz
  and s.id='88906939-65e7-492d-a671-da56678dfecd' and s.shared_award_id='440d6985-ece9-48c4-ac30-65a739f60d65'
  and s.text_monitoring_state->>'status'='baseline_ready' and s.text_monitoring_state->'latest_ref'=o.current_ref and s.text_monitoring_state->'baseline_ref'=o.current_ref
  and private.awardping_current_basic_source_ready(s.id,o.cohort_key,o.epoch,o.current_ref)
  and private.awardping_technical_repeat_cause_valid(o.validation),false);
exception when others then return false;end;$$;

create function private.awardping_technical_repeat_proof_valid(v_review jsonb,p_proof jsonb,p_ref jsonb,p_parent uuid default null)
returns boolean language plpgsql stable set search_path='' as $$
declare o public.program_basic_technical_repeat_observations%rowtype;h uuid;head_ok boolean:=false;projection jsonb;
begin
 if private.awardping_program_exact_object(p_proof,array['source_id','repeat_observation_id','pending_alert_review_id','pending_alert_review_hash','kind','provenance_kind','technical_repeat_observation_id','technical_repeat_hash']) is distinct from true
  or p_proof->>'kind' is distinct from 'retained_technical_repeat' or p_proof->'repeat_observation_id' is distinct from 'null'::jsonb
  or p_proof->>'provenance_kind' is distinct from 'post_change_technical_probe'
  or p_proof->'pending_alert_review_id' is distinct from 'null'::jsonb or p_proof->'pending_alert_review_hash' is distinct from 'null'::jsonb
 then return false;end if;
 select * into strict o from public.program_basic_technical_repeat_observations where id=(p_proof->>'technical_repeat_observation_id')::uuid;
 if o.source_id::text is distinct from p_proof->>'source_id' or o.source_id::text is distinct from p_ref#>>'{source,id}'
  or o.cohort_key is distinct from v_review->>'cohort_key' or o.epoch::text is distinct from v_review->>'epoch'
  or o.content_hash is distinct from p_proof->>'technical_repeat_hash' or o.current_ref is distinct from p_ref
  or private.awardping_technical_repeat_row_current(o.id) is distinct from true then return false;end if;
 if p_parent is not null then head_ok:=o.expected_head=p_parent;else
  select snapshot_id into h from public.program_basic_fact_heads where cohort_key=o.cohort_key;
  head_ok:=o.expected_head=h or exists(select 1 from public.program_basic_fact_snapshots x join public.program_text_fact_reviews d on d.id=x.input_review_id
   where x.id=h and x.previous_snapshot_id=o.expected_head and d.content_hash=x.input_review_hash
    and d.content_hash=encode(extensions.digest(convert_to(d.validation::text,'UTF8'),'sha256'),'hex')
    and d.validation->'review'=v_review and (x.receipt->'current_source_proofs') @> jsonb_build_array(p_proof));
 end if;
 if head_ok is distinct from true then return false;end if;
 projection:=private.awardping_technical_repeat_support(v_review,o.source_id,o.validation);
 return projection is not null and projection=o.validation->'support_projection' and private.awardping_reviewed_repeat_hash(projection)=o.support_hash;
exception when others then return false;end;$$;
create function private.awardping_technical_repeat_commit_heads_valid(p_validation jsonb,p_parent uuid)
returns boolean language plpgsql stable set search_path='' as $$
declare p jsonb;o public.program_basic_technical_repeat_observations%rowtype;
begin
 for p in select value from jsonb_array_elements(p_validation->'current_source_proofs') where value->>'kind'='retained_technical_repeat' loop
  select * into strict o from public.program_basic_technical_repeat_observations where id=(p->>'technical_repeat_observation_id')::uuid;
  if o.expected_head is distinct from p_parent then return false;end if;
 end loop;return true;
exception when others then return false;end;$$;
create function private.awardping_technical_repeat_version_valid(p_snapshot uuid,p_version jsonb)
returns boolean language plpgsql stable set search_path='' as $$
declare x public.program_basic_fact_snapshots%rowtype;d public.program_text_fact_reviews%rowtype;o public.program_basic_technical_repeat_observations%rowtype;p jsonb;
begin
 if private.awardping_program_exact_object(p_version,array['source_id','owner_id','url','epoch','content_identity','repeat_observation_id','pending_alert_review_id','pending_alert_review_hash','kind','provenance_kind','technical_repeat_observation_id','technical_repeat_hash']) is distinct from true
  or p_version->>'kind' is distinct from 'retained_technical_repeat' or p_version->>'provenance_kind' is distinct from 'post_change_technical_probe' then return false;end if;
 select * into strict x from public.program_basic_fact_snapshots where id=p_snapshot;
 select * into strict d from public.program_text_fact_reviews where id=x.input_review_id;
 if d.content_hash is distinct from x.input_review_hash or d.content_hash is distinct from encode(extensions.digest(convert_to(d.validation::text,'UTF8'),'sha256'),'hex') then return false;end if;
 select * into strict o from public.program_basic_technical_repeat_observations where id=(p_version->>'technical_repeat_observation_id')::uuid;
 p:=jsonb_build_object('source_id',p_version->'source_id','repeat_observation_id',p_version->'repeat_observation_id',
  'pending_alert_review_id',p_version->'pending_alert_review_id','pending_alert_review_hash',p_version->'pending_alert_review_hash',
  'kind',p_version->'kind','provenance_kind',p_version->'provenance_kind','technical_repeat_observation_id',p_version->'technical_repeat_observation_id','technical_repeat_hash',p_version->'technical_repeat_hash');
 return coalesce(o.cohort_key=x.cohort_key and o.epoch::text=p_version->>'epoch'
  and o.current_ref#>>'{source,shared_award_id}'=p_version->>'owner_id' and o.current_ref#>>'{source,url}'=p_version->>'url'
  and private.awardping_basic_content_identity(o.current_ref)=p_version->'content_identity' and (x.receipt->'current_source_proofs') @> jsonb_build_array(p)
  and private.awardping_technical_repeat_proof_valid(d.validation->'review',p,o.current_ref,x.previous_snapshot_id),false);
exception when others then return false;end;$$;
create function public.inspect_program_basic_technical_repeat(p_cohort_key text,p_source_id uuid,p_causal_candidate_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare packet jsonb;c jsonb;r jsonb;event jsonb;evidence jsonb;begin
 if p_cohort_key is distinct from 'daad_study' or p_source_id is distinct from '88906939-65e7-492d-a671-da56678dfecd'::uuid then
  raise exception 'Finite DAAD technical-probe source required.' using errcode='23514';end if;
 packet:=public.inspect_current_program_basic_award(p_cohort_key);c:=private.awardping_reviewed_repeat_candidate(p_causal_candidate_id);
 r:=private.awardping_technical_repeat_owner_review(p_causal_candidate_id);event:=private.awardping_technical_repeat_published_event(p_causal_candidate_id);evidence:=private.awardping_technical_repeat_published_evidence(p_causal_candidate_id);
 if c is null or r is null or event is null or evidence is null or c->>'status' is distinct from 'published' or r->>'status' is distinct from 'approved'
  or c->>'shared_award_source_id' is distinct from p_source_id::text
  or not exists(select 1 from jsonb_array_elements(packet#>'{context,sources}') s where s->>'id'=p_source_id::text and s#>>'{text_monitoring_state,status}'='baseline_ready')
 then raise exception 'Exact approved publication and current baseline source required.' using errcode='23514';end if;
 return jsonb_build_object('schema','awardping.current-basic-technical-repeat-inspection.v1','packet',packet,'causal_candidate',c,
  'causal_candidate_hash',private.awardping_reviewed_repeat_hash(c),'owner_review',r,'paid_reservation',private.awardping_reviewed_repeat_paid(c),'published_event',event,'published_evidence',evidence);
end;$$;

create function public.attest_program_basic_technical_repeat(p_validation jsonb,p_actor text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb:=p_validation;o public.program_basic_technical_repeat_observations%rowtype;h uuid;hash text;sid uuid;cid uuid;e uuid;
begin
 if coalesce(p_actor,'') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then raise exception 'Real actor UUID required.' using errcode='23514';end if;
 if not exists(select 1 from auth.users where id=p_actor::uuid)
  or octet_length(v::text)>33554432 or not coalesce((v->>'verified_at')::timestamptz between clock_timestamp()-interval '15 minutes' and clock_timestamp(),false)
 then raise exception 'Fresh genuine technical-probe verification and real actor required.' using errcode='23514';end if;
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('awardping-basic-facts:'||(v->>'cohort_key'),0));
 sid:=(v->>'source_id')::uuid;cid:=(v->>'causal_candidate_id')::uuid;e:=(v->>'epoch')::uuid;
 perform 1 from public.shared_award_sources where id=sid for share;
 perform 1 from public.shared_award_visual_review_candidates where id=cid for share;
 perform 1 from public.program_text_alert_reviews where id=(v->>'owner_review_id')::uuid for share;
 perform 1 from public.shared_award_change_events where id=(v#>>'{owner_review,event_id}')::uuid for share;
 perform 1 from public.shared_award_change_event_visual_evidence where change_event_id=(v#>>'{owner_review,event_id}')::uuid and visual_review_candidate_id=cid for share;
 perform 1 from public.program_text_source_roster where cohort_key=v->>'cohort_key' for share;
 perform 1 from public.gemini_spend_reservations where id=(v#>>'{causal_candidate,worker_metadata,gemini_spend_reservation_id}')::uuid for share;
 select snapshot_id into strict h from public.program_basic_fact_heads where cohort_key=v->>'cohort_key' for share;
 if h::text is distinct from v->>'expected_head' or private.awardping_technical_repeat_validation_valid(v) is distinct from true
  or private.awardping_current_basic_source_ready(sid,v->>'cohort_key',e,v#>'{current_document,reference}') is distinct from true
  or not exists(select 1 from public.shared_award_sources where id=sid and text_monitoring_state->>'status'='baseline_ready'
   and text_monitoring_state->'baseline_ref'=v#>'{current_document,reference}')
 then raise exception 'Exact current parent, approved cause and retained technical originals changed.' using errcode='40001';end if;
 hash:=encode(extensions.digest(convert_to(v::text,'UTF8'),'sha256'),'hex');
 select * into o from public.program_basic_technical_repeat_observations where cohort_key=v->>'cohort_key' and source_id=sid and epoch=e and expected_head=h and causal_candidate_id=cid and support_hash=v->>'support_hash';
 if found then
  if o.validation is distinct from v or o.actor is distinct from p_actor or o.content_hash is distinct from hash then raise exception 'Technical-probe replay differs.' using errcode='40001';end if;
  return jsonb_build_object('ok',true,'id',o.id,'content_hash',o.content_hash,'already_applied',true);
 end if;
 insert into public.program_basic_technical_repeat_observations(kind,provenance_kind,cohort_key,source_id,epoch,expected_head,causal_candidate_id,causal_candidate_hash,
  owner_review_id,owner_review_hash,causal_previous_ref,current_ref,probe_ref,support_hash,validation,content_hash,verified_at,actor)
 values('retained_technical_repeat','post_change_technical_probe',v->>'cohort_key',sid,e,h,cid,v->>'causal_candidate_hash',
  (v->>'owner_review_id')::uuid,v->>'owner_review_hash',v#>'{causal_previous_document,reference}',v#>'{current_document,reference}',v#>'{probe_document,reference}',v->>'support_hash',v,hash,(v->>'verified_at')::timestamptz,p_actor) returning * into o;
 return jsonb_build_object('ok',true,'id',o.id,'content_hash',o.content_hash,'already_applied',false);
end;$$;

revoke all on function private.awardping_technical_repeat_pair(jsonb),private.awardping_technical_repeat_support(jsonb,uuid,jsonb),
 private.awardping_technical_repeat_owner_review(uuid),private.awardping_technical_repeat_published_event(uuid),private.awardping_technical_repeat_published_evidence(uuid),
 private.awardping_technical_repeat_cause_valid(jsonb),private.awardping_technical_repeat_marker_valid(jsonb,jsonb,text,uuid,jsonb),
 private.awardping_technical_repeat_residual(jsonb,text),private.awardping_technical_repeat_rules_valid(jsonb),
 private.awardping_technical_repeat_validation_valid(jsonb),private.awardping_technical_repeat_row_current(uuid),
 private.awardping_technical_repeat_proof_valid(jsonb,jsonb,jsonb,uuid),private.awardping_technical_repeat_commit_heads_valid(jsonb,uuid),
 private.awardping_technical_repeat_version_valid(uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.inspect_program_basic_technical_repeat(text,uuid,uuid),public.attest_program_basic_technical_repeat(jsonb,text) from public,anon,authenticated;
grant execute on function public.inspect_program_basic_technical_repeat(text,uuid,uuid),public.attest_program_basic_technical_repeat(jsonb,text) to service_role;

-- BEGIN APPROVED TECHNICAL PROBE DISPATCH
-- Separate DAAD889 retained technical-probe dispatcher. Append after its
-- ledger/helpers. Actual applied first-feature function definitions are pinned;
-- reviewed-no-change and byte-repeat branches retain their original statements.
-- No transaction wrapper, source writes or migration-history operation here.

do $technical_dispatch_proofs$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('private.awardping_current_basic_proofs_valid(jsonb,jsonb)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'f4a67c8284665ef8734373e584f385ee888ce19ca92eba2520d361fbe8c74896' then
  raise exception 'Technical-probe dispatcher preimage changed: proofs.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$technical_proofs_0_before$  if p ? 'kind' then$technical_proofs_0_before$,$technical_proofs_0_after$  if p->>'kind'='retained_technical_repeat' then
   if p->>'provenance_kind' is distinct from 'post_change_technical_probe'
    or p->>'source_id' is distinct from '88906939-65e7-492d-a671-da56678dfecd'
    or v_review->>'cohort_key' is distinct from 'daad_study'
    or not coalesce(private.awardping_technical_repeat_proof_valid(v_review,p,r,null),false) then return false;end if;
   continue;
  end if;
  if p ? 'kind' then$technical_proofs_0_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'7e7fae5bb65720ba2ef469f99c35036877870b517efee5c0fdd1dc0e5d7c8d0d' then
  raise exception 'Technical-probe dispatcher replacement differs: proofs.' using errcode='40001';
 end if;
 execute v_after;
end;
$technical_dispatch_proofs$;

do $technical_dispatch_context$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('public.inspect_current_program_basic_award(text)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'89043af512a1103dd6c4e2e5ce2f974ab096240419a8e354b189ba8c9cd4cd3f' then
  raise exception 'Technical-probe dispatcher preimage changed: context.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$technical_context_0_before$observations jsonb;reviewed_observations jsonb;$technical_context_0_before$,$technical_context_0_after$observations jsonb;reviewed_observations jsonb;technical_observations jsonb;$technical_context_0_after$);
 v_after:=replace(v_after,$technical_context_1_before$ return jsonb_build_object('schema','awardping.current-basic-award-context.v1'$technical_context_1_before$,$technical_context_1_after$ select coalesce(jsonb_agg(jsonb_build_object(
  'id',o.id,'kind',o.kind,'provenance_kind',o.provenance_kind,'cohort_key',o.cohort_key,'source_id',o.source_id,'epoch',o.epoch,'expected_head',o.expected_head,
  'causal_candidate_id',o.causal_candidate_id,'causal_candidate_hash',o.causal_candidate_hash,
  'owner_review_id',o.owner_review_id,'owner_review_hash',o.owner_review_hash,
  'causal_previous_ref',o.causal_previous_ref,'current_ref',o.current_ref,'probe_ref',o.probe_ref,
  'support_hash',o.support_hash,'content_hash',o.content_hash,'verified_at',o.verified_at,'actor',o.actor,
  'causal_candidate',o.validation->'causal_candidate','owner_review',o.validation->'owner_review',
  'published_event',o.validation->'published_event','published_evidence',o.validation->'published_evidence',
  'paid_reservation',o.validation->'paid_reservation','technical_comparison',o.validation->'technical_comparison',
  'rules',o.validation->'rules','widget_proofs',o.validation->'widget_proofs','support_projection',o.validation->'support_projection') order by o.created_at desc,o.id),'[]'::jsonb)
 into technical_observations from (select limited.* from public.shared_award_sources x cross join lateral (
  select z.* from public.program_basic_technical_repeat_observations z
  where z.cohort_key=p_cohort_key and z.epoch=e and z.source_id=x.id and z.expected_head is not distinct from head
   and z.kind='retained_technical_repeat' and z.provenance_kind='post_change_technical_probe'
   and z.current_ref=x.text_monitoring_state->'latest_ref' and private.awardping_technical_repeat_row_current(z.id)
  order by z.created_at desc,z.id limit 2
 ) limited where p_cohort_key='daad_study' and x.id=any(ids) and x.id='88906939-65e7-492d-a671-da56678dfecd'::uuid) o;
 return jsonb_build_object('schema','awardping.current-basic-award-context.v1'$technical_context_1_after$);
 v_after:=replace(v_after,$technical_context_2_before$'reviewed_repeat_observations',reviewed_observations))$technical_context_2_before$,$technical_context_2_after$'reviewed_repeat_observations',reviewed_observations,'technical_repeat_observations',technical_observations))$technical_context_2_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'1b54a499a9bcbb8c9698c5991d68d4beef4979193c4384494c1caa9da362e1c4' then
  raise exception 'Technical-probe dispatcher replacement differs: context.' using errcode='40001';
 end if;
 execute v_after;
end;
$technical_dispatch_context$;

do $technical_dispatch_commit$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('public.commit_current_program_basic_facts(uuid,text,uuid,jsonb,text,text)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'6bd79591ad413ae6875414fa32d49ccecc85b0ee031591b29a1d138d3e947d31' then
  raise exception 'Technical-probe dispatcher preimage changed: commit.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$technical_commit_0_before$ or not coalesce(private.awardping_reviewed_repeat_commit_heads_valid(d.validation,p_expected_head_id),false)$technical_commit_0_before$,$technical_commit_0_after$ or not coalesce(private.awardping_reviewed_repeat_commit_heads_valid(d.validation,p_expected_head_id),false)
 or not coalesce(private.awardping_technical_repeat_commit_heads_valid(d.validation,p_expected_head_id),false)$technical_commit_0_after$);
 v_after:=replace(v_after,$technical_commit_1_before$  'reviewed_repeat_observation_id',p->'reviewed_repeat_observation_id','reviewed_repeat_hash',p->'reviewed_repeat_hash') else '{}'::jsonb end
 order by r#>>'{source,id}') into versions$technical_commit_1_before$,$technical_commit_1_after$  'reviewed_repeat_observation_id',p->'reviewed_repeat_observation_id','reviewed_repeat_hash',p->'reviewed_repeat_hash') else '{}'::jsonb end
 ||case when p->>'kind'='retained_technical_repeat' then jsonb_build_object('kind','retained_technical_repeat',
  'provenance_kind','post_change_technical_probe','technical_repeat_observation_id',p->'technical_repeat_observation_id','technical_repeat_hash',p->'technical_repeat_hash') else '{}'::jsonb end
 order by r#>>'{source,id}') into versions$technical_commit_1_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'fd52d9df42c8ab586c06559316095748d252541c345ff5da9801b3b7c243e443' then
  raise exception 'Technical-probe dispatcher replacement differs: commit.' using errcode='40001';
 end if;
 execute v_after;
end;
$technical_dispatch_commit$;

do $technical_dispatch_currentness$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('private.awardping_current_basic_fact_current(uuid)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'d130ce8def118e6297b13b578cbf048641a290e579a68f22caf17c28888c053d' then
  raise exception 'Technical-probe dispatcher preimage changed: currentness.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$technical_currentness_0_before$  if v ? 'kind' then$technical_currentness_0_before$,$technical_currentness_0_after$  if v->>'kind'='retained_technical_repeat' then
   if v->>'provenance_kind' is distinct from 'post_change_technical_probe'
    or v->>'source_id' is distinct from '88906939-65e7-492d-a671-da56678dfecd'
    or x.cohort_key is distinct from 'daad_study'
    or not coalesce(private.awardping_technical_repeat_version_valid(x.id,v),false) then return false;end if;
   continue;
  end if;
  if v ? 'kind' then$technical_currentness_0_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'e330f3507e260ca734806c166f48a59d4821cbfbf370338919b6ed6634707c23' then
  raise exception 'Technical-probe dispatcher replacement differs: currentness.' using errcode='40001';
 end if;
 execute v_after;
end;
$technical_dispatch_currentness$;

