-- Text monitoring is a new epoch, independent of preserved visual history.
-- New RPCs are service-role-only and security invoker. No historical rows are reset.
grant usage on schema private to service_role;
alter table public.shared_award_sources
  add column if not exists text_monitoring_state jsonb not null default '{}'::jsonb;
alter table public.shared_award_sources add constraint shared_award_source_text_state_object
  check (jsonb_typeof(text_monitoring_state)='object');
alter table public.shared_award_visual_review_candidates
  drop constraint shared_award_visual_review_candidates_candidate_scope_check;
alter table public.shared_award_visual_review_candidates
  add constraint shared_award_visual_review_candidates_candidate_scope_check
  check(candidate_scope in ('content_change','initial_official_document','program_text_change'));
alter table public.shared_award_change_event_visual_evidence
  drop constraint shared_award_change_event_visual_evidence_evidence_status_check;
alter table public.shared_award_change_event_visual_evidence
  add constraint shared_award_change_event_visual_evidence_evidence_status_check
  check(evidence_status in ('verified','unavailable_exact_text_missing','unavailable_geometry_missing',
    'unavailable_image_missing','unavailable_ambiguous','historical_artifact_unrecoverable',
    'full_screenshot_fallback','not_applicable_pdf','not_applicable_new_document',
    'not_applicable_source_html','verified_text'));

create or replace function private.awardping_program_exact_object(p_value jsonb,p_keys text[])
returns boolean language sql immutable set search_path='' as $$
select case when jsonb_typeof(p_value)='object'
 then coalesce(p_value ?& p_keys and p_value-p_keys='{}'::jsonb,false) else false end;
$$;
revoke all on function private.awardping_program_exact_object(jsonb,text[]) from public,anon,authenticated;
grant execute on function private.awardping_program_exact_object(jsonb,text[]) to service_role;

create or replace function private.awardping_program_text_reference_valid(p_ref jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_artifact jsonb; v_role text; v_name text; v_prefix text; v_at timestamptz;
 v_pdf boolean; v_limit integer;
begin
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
     or v_role='raw' and not coalesce(case when v_pdf then v_artifact->>'content_type' ~* '^application/pdf(;|$)'
       else v_artifact->>'content_type' ~* '^(text/html|application/xhtml[+]xml)(;|$)' end,false)
   then return false; end if;
 end loop;
 return true;
exception when others then return false;
end;
$$;
revoke all on function private.awardping_program_text_reference_valid(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_text_reference_valid(jsonb) to service_role;

create or replace function private.awardping_program_utf16_length(p_text text)
returns integer language sql immutable strict set search_path='' as $$
select coalesce(sum(case when ascii(ch)>65535 then 2 else 1 end),0)::integer
from unnest(string_to_array(p_text,null)) ch;
$$;
create or replace function private.awardping_program_utf16_slice(p_text text,p_start integer,p_end integer)
returns text language plpgsql immutable strict set search_path='' as $$
declare v_i integer:=0; v_at integer:=0; v_size integer; v_start_index integer; v_ch text;
begin
 if p_start<0 or p_end<=p_start then return null; end if;
 foreach v_ch in array string_to_array(p_text,null) loop
   v_i:=v_i+1; v_size:=case when ascii(v_ch)>65535 then 2 else 1 end;
   if v_at=p_start then v_start_index:=v_i;
   elsif v_at<p_start and v_at+v_size>p_start then return null; end if;
   v_at:=v_at+v_size;
   if v_at=p_end then
     if v_start_index is null then return null; end if;
     return substr(p_text,v_start_index,v_i-v_start_index+1);
   elsif v_at>p_end then return null; end if;
 end loop;
 return null;
end;
$$;
revoke all on function private.awardping_program_utf16_length(text) from public,anon,authenticated;
revoke all on function private.awardping_program_utf16_slice(text,integer,integer) from public,anon,authenticated;
grant execute on function private.awardping_program_utf16_length(text) to service_role;
grant execute on function private.awardping_program_utf16_slice(text,integer,integer) to service_role;

create or replace function private.awardping_program_source_allowed(p_source_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
select exists(
 select 1 from public.shared_award_sources s
 join public.shared_awards a on a.id=s.shared_award_id and a.status='active'
 join public.stage1_award_members member on member.shared_award_id=s.shared_award_id
 join public.stage1_award_source_manifest m on m.cohort_key=member.cohort_key and s.id=any(m.source_ids)
 where s.id=p_source_id and s.admin_review_status='open' and m.manifest_status<>'missing'
 and m.evidence#>>array['source_bindings',s.id::text,'source_url']=s.url
 and not exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=m.cohort_key
  and ((r.url_pattern is not null and s.url ~* r.url_pattern)
    or (r.title_pattern is not null and concat_ws(' ',s.title,s.display_title) ~* r.title_pattern)))
);
$$;
revoke all on function private.awardping_program_source_allowed(uuid) from public,anon,authenticated;
grant execute on function private.awardping_program_source_allowed(uuid) to service_role;

create or replace function private.awardping_program_block_valid(p_block jsonb,p_text text)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_start integer; v_end integer;
begin
 if not private.awardping_program_exact_object(p_block,array['id','text','start_utf16','end_utf16','heading','page','kind','context'])
   or not coalesce(jsonb_typeof(p_block->'id')='string' and length(btrim(p_block->>'id')) between 1 and 200
     and jsonb_typeof(p_block->'text')='string' and length(btrim(p_block->>'text'))>0
     and jsonb_typeof(p_block->'start_utf16')='number' and p_block->>'start_utf16' ~ '^[0-9]+$'
     and jsonb_typeof(p_block->'end_utf16')='number' and p_block->>'end_utf16' ~ '^[1-9][0-9]*$'
     and (p_block->>'start_utf16')::numeric between 0 and 1000000
     and (p_block->>'end_utf16')::numeric between 1 and 1000000
     and jsonb_typeof(p_block->'heading') in ('string','null')
     and jsonb_typeof(p_block->'kind') in ('string','null')
     and jsonb_typeof(p_block->'page') in ('number','null')
     and jsonb_typeof(p_block->'context') in ('object','null'),false)
 then return false; end if;
 v_start:=(p_block->>'start_utf16')::integer; v_end:=(p_block->>'end_utf16')::integer;
 return v_end>v_start and private.awardping_program_utf16_slice(p_text,v_start,v_end)=p_block->>'text'
   and private.awardping_program_utf16_length(p_block->>'text')=v_end-v_start;
exception when others then return false;
end;
$$;
revoke all on function private.awardping_program_block_valid(jsonb,text) from public,anon,authenticated;
grant execute on function private.awardping_program_block_valid(jsonb,text) to service_role;

create or replace function public.set_program_text_source_state(
 p_source_id uuid,p_expected_state jsonb,p_next_state jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_source public.shared_award_sources%rowtype; v_ref jsonb; v_checked timestamptz;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict v_source from public.shared_award_sources where id=p_source_id for update;
 if not private.awardping_program_source_allowed(p_source_id) then
   raise exception 'Source must remain an approved required award source.' using errcode='23514'; end if;
 if v_source.text_monitoring_state is distinct from p_expected_state then
   raise exception 'Text source state changed; reload before proceeding.' using errcode='40001'; end if;
 if jsonb_typeof(p_next_state) is distinct from 'object'
   or p_next_state->>'schema' is distinct from 'awardping.program-text-state.v1'
   or not coalesce(p_next_state->>'epoch' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$',false)
   or p_next_state->>'epoch'='00000000-0000-0000-0000-000000000000'
   or not coalesce(p_next_state->>'status' in ('baseline_ready','monitoring','awaiting_review','held','error'),false)
   or not coalesce(p_next_state->>'last_checked_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$',false)
   or not coalesce(p_next_state->>'first_captured_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$',false)
   or not coalesce(jsonb_typeof(p_next_state->'successful_checks')='number'
     and p_next_state->>'successful_checks' ~ '^[1-9][0-9]*$'
     and (p_next_state->>'successful_checks')::numeric between 1 and 2147483647,false)
 then raise exception 'Invalid text source state.' using errcode='23514'; end if;
 v_checked:=(p_next_state->>'last_checked_at')::timestamptz;
 if v_checked>clock_timestamp()+interval '5 minutes'
   or to_char(v_checked at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') is distinct from p_next_state->>'last_checked_at'
 then raise exception 'Invalid source observation time.' using errcode='23514'; end if;
 if p_expected_state<>'{}'::jsonb and (
   p_next_state->>'epoch' is distinct from p_expected_state->>'epoch'
   or v_checked<(p_expected_state->>'last_checked_at')::timestamptz
   or (p_next_state#>>'{latest_ref,captured_at}')::timestamptz<(p_expected_state#>>'{latest_ref,captured_at}')::timestamptz
 ) then raise exception 'An existing text epoch or observation cannot be reset.' using errcode='23514'; end if;
 foreach v_ref in array array[p_next_state->'baseline_ref',p_next_state->'latest_ref'] loop
   if not private.awardping_program_text_reference_valid(v_ref)
     or v_ref#>>'{source,id}' is distinct from v_source.id::text
     or v_ref#>>'{source,shared_award_id}' is distinct from v_source.shared_award_id::text
     or v_ref#>>'{source,url}' is distinct from v_source.url
     or (v_ref->>'captured_at')::timestamptz>v_checked
   then raise exception 'Invalid source-bound text reference.' using errcode='23514'; end if;
 end loop;
 if p_next_state#>>'{baseline_ref,final_url}' is distinct from p_next_state#>>'{latest_ref,final_url}'
   or p_next_state#>'{baseline_ref,extractor}' is distinct from p_next_state#>'{latest_ref,extractor}'
   or p_next_state#>>'{baseline_ref,acquisition}' is distinct from p_next_state#>>'{latest_ref,acquisition}'
   or (p_next_state#>>'{baseline_ref,captured_at}')::timestamptz>(p_next_state#>>'{latest_ref,captured_at}')::timestamptz
 then raise exception 'Baseline and latest observation configuration must match.' using errcode='23514'; end if;
 if p_expected_state='{}'::jsonb then
   if p_next_state->>'status' is distinct from 'baseline_ready'
     or p_next_state->'baseline_ref' is distinct from p_next_state->'latest_ref'
     or p_next_state ? 'last_program_update_at'
     or p_next_state->>'first_captured_at' is distinct from p_next_state#>>'{latest_ref,captured_at}'
     or p_next_state->>'successful_checks' is distinct from '1'
   then raise exception 'First coverage establishes one collection baseline, never an update.' using errcode='23514'; end if;
 else
   if p_next_state->>'first_captured_at' is distinct from p_expected_state->>'first_captured_at'
     or (p_next_state->>'successful_checks')::bigint<>(p_expected_state->>'successful_checks')::bigint+
       (case when p_next_state#>>'{latest_ref,capture_id}' is distinct from p_expected_state#>>'{latest_ref,capture_id}' then 1 else 0 end)
   then raise exception 'First coverage and successful capture counts must remain accurate.' using errcode='23514'; end if;
   if p_next_state->'last_program_update_at' is distinct from p_expected_state->'last_program_update_at' then
     raise exception 'Only publication may change the last program-update time.' using errcode='23514'; end if;
   if p_next_state#>>'{baseline_ref,final_url}' is distinct from p_expected_state#>>'{baseline_ref,final_url}'
     or p_next_state#>'{baseline_ref,extractor}' is distinct from p_expected_state#>'{baseline_ref,extractor}'
     or p_next_state#>>'{baseline_ref,acquisition}' is distinct from p_expected_state#>>'{baseline_ref,acquisition}'
     or p_next_state#>>'{latest_ref,capture_id}'=p_expected_state#>>'{latest_ref,capture_id}'
       and p_next_state->'latest_ref' is distinct from p_expected_state->'latest_ref'
   then raise exception 'Text extraction identity cannot change inside an epoch.' using errcode='23514'; end if;
   if p_next_state->'baseline_ref' is distinct from p_expected_state->'baseline_ref'
     and (p_next_state->'baseline_ref' is distinct from p_next_state->'latest_ref'
       or (p_next_state#>>'{baseline_ref,text_sha256}' is distinct from p_expected_state#>>'{baseline_ref,text_sha256}'
         and not exists(select 1 from public.shared_award_visual_review_candidates c
           where c.shared_award_source_id=p_source_id and c.shared_award_id=v_source.shared_award_id
             and c.candidate_scope='program_text_change' and c.status='succeeded'
             and c.worker_metadata->>'epoch'=p_next_state->>'epoch'
             and c.worker_metadata->>'monitoring_contract'='program-text-v1'
             and c.ai_result#>>'{program_text_validation,status}'='no_program_change'
             and c.ai_result#>>'{program_text_validation,comparison_id}'=c.candidate_signature
             and c.prompt_payload#>>'{comparison,comparison_id}'=c.candidate_signature
             and c.worker_metadata->>'evidence_signature'=c.candidate_signature
             and c.prompt_payload#>>'{comparison,context,source_id}'=p_source_id::text
             and c.prompt_payload#>>'{comparison,context,award_id}'=v_source.shared_award_id::text
             and c.prompt_payload#>>'{comparison,context,epoch}'=p_next_state->>'epoch'
             and c.prompt_payload#>>'{packet_plan,comparison_id}'=c.candidate_signature
             and c.prompt_payload#>>'{packet_plan,status}' in ('ready','unchanged')
             and jsonb_typeof(c.prompt_payload#>'{packet_plan,packets}')='array'
             and jsonb_typeof(c.ai_result->'responses')='array'
             and jsonb_array_length(c.ai_result->'responses')=jsonb_array_length(c.prompt_payload#>'{packet_plan,packets}')
             and c.previous_snapshot_ref=p_expected_state->'baseline_ref'
             and c.new_snapshot_ref=p_next_state->'baseline_ref'
             and c.prompt_payload#>'{comparison,previous_ref,capture_id}'=c.previous_snapshot_ref->'capture_id'
             and c.prompt_payload#>'{comparison,current_ref,capture_id}'=c.new_snapshot_ref->'capture_id'
         )))
   then raise exception 'Changed baseline requires its completed no-change review or publication.' using errcode='23514'; end if;
 end if;
 update public.shared_award_sources set text_monitoring_state=p_next_state,last_checked_at=v_checked,
   next_check_at=v_checked+interval '1 day' where id=p_source_id;
 return p_next_state;
end;
$$;
revoke all on function public.set_program_text_source_state(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.set_program_text_source_state(uuid,jsonb,jsonb) to service_role;

create or replace function public.awardping_validate_program_text_evidence(
 p_evidence jsonb,p_candidate jsonb,p_details jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare v_source public.shared_award_sources%rowtype; v_change jsonb; v_quote jsonb; v_comparison jsonb;
 v_side text; v_block jsonb; v_blocks jsonb; v_expected jsonb; v_existing jsonb; v_row jsonb; v_ref jsonb;
 v_comp_ref jsonb; v_full_text text; v_start integer; v_end integer; v_comparison_id text;
 v_seen jsonb:='[]'::jsonb; v_identity jsonb;
 v_allowed text[]:=array['opening_date','deadline','cycle_status','important_dates','eligibility',
 'citizenship','academic_levels','disciplines','award_amounts','stipend','tuition',
 'travel_research_allowance','tenure','requirements','application_materials','how_to_apply',
 'documents','selection','application_url','contacts'];
begin
 select * into strict v_source from public.shared_award_sources
 where id=(p_candidate->>'shared_award_source_id')::uuid;
 if not private.awardping_program_exact_object(p_details,array['schema','event_kind','summary','program_changes'])
   or p_details->>'schema' is distinct from 'awardping.program-change.v1'
   or p_details->>'event_kind' is distinct from 'program_details_changed'
   or jsonb_typeof(p_details->'summary') is distinct from 'string'
   or nullif(btrim(p_details->>'summary'),'') is null
   or private.awardping_program_utf16_length(p_details->>'summary') not between 1 and 1200
   or jsonb_typeof(p_details->'program_changes') is distinct from 'array'
 then raise exception 'Invalid typed program-change details.' using errcode='23514'; end if;
 if jsonb_array_length(p_details->'program_changes') not between 1 and 64 then
   raise exception 'A program update requires 1 to 64 supported changes.' using errcode='23514'; end if;
 if not private.awardping_program_exact_object(p_evidence->'localization',
     array['schema','epoch','comparison_id','program_changes','supporting_blocks'])
   or p_evidence#>>'{localization,schema}' is distinct from 'awardping.program-text-publication.v1'
   or not private.awardping_program_exact_object(p_evidence#>'{localization,supporting_blocks}',array['previous','current'])
   or not private.awardping_program_source_allowed(v_source.id)
   or not coalesce(p_candidate->>'status' in ('succeeded','published'),false)
   or p_candidate->>'candidate_scope' is distinct from 'program_text_change'
   or p_evidence->>'evidence_schema_version' is distinct from 'program-text-event-evidence-v1'
   or p_evidence->>'evidence_status' is distinct from 'verified_text'
   or p_evidence->>'visual_review_candidate_id' is distinct from p_candidate->>'id'
   or p_evidence->>'candidate_signature' is distinct from p_candidate->>'candidate_signature'
   or not coalesce(p_candidate->>'candidate_signature' ~ '^[0-9a-f]{64}$',false)
   or p_evidence->>'shared_award_id' is distinct from p_candidate->>'shared_award_id'
   or p_evidence->>'shared_award_source_id' is distinct from p_candidate->>'shared_award_source_id'
   or p_candidate#>>'{worker_metadata,monitoring_contract}' is distinct from 'program-text-v1'
   or not coalesce(p_candidate#>>'{worker_metadata,epoch}' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$',false)
   or p_candidate#>>'{worker_metadata,epoch}'='00000000-0000-0000-0000-000000000000'
   or p_candidate#>>'{worker_metadata,epoch}' is distinct from v_source.text_monitoring_state->>'epoch'
   or p_candidate->>'source_url' is distinct from v_source.url
   or p_candidate->>'shared_award_id' is distinct from v_source.shared_award_id::text
   or p_evidence#>>'{localization,epoch}' is distinct from p_candidate#>>'{worker_metadata,epoch}'
   or p_evidence#>'{localization,program_changes}' is distinct from p_details->'program_changes'
   or p_candidate#>'{ai_result,program_text_validation,details}' is distinct from p_details
   or p_candidate#>>'{ai_result,program_text_validation,status}' is distinct from 'accepted'
   or nullif(btrim(p_evidence->>'bucket'),'') is null
   or p_evidence->>'bucket' is distinct from p_candidate#>>'{worker_metadata,bucket}'
   or nullif(p_evidence->>'verified_at','') is null
   or p_evidence->>'backfilled_at' is not null
 then raise exception 'Text event review/source/epoch binding mismatch.' using errcode='23514'; end if;
 v_comparison:=p_candidate#>'{prompt_payload,comparison}';
 v_comparison_id:=v_comparison->>'comparison_id';
 if v_comparison->>'schema' is distinct from 'awardping.program-text-comparison.v1'
   or v_comparison->>'status' is distinct from 'review_required'
   or not coalesce(v_comparison_id ~ '^[0-9a-f]{64}$',false)
   or v_comparison_id is distinct from p_candidate->>'candidate_signature'
   or v_comparison_id is distinct from p_candidate#>>'{worker_metadata,evidence_signature}'
   or p_evidence#>>'{localization,comparison_id}' is distinct from v_comparison_id
   or p_candidate#>>'{ai_result,program_text_validation,comparison_id}' is distinct from v_comparison_id
   or p_candidate#>>'{prompt_payload,packet_plan,comparison_id}' is distinct from v_comparison_id
   or p_candidate#>>'{prompt_payload,packet_plan,status}' is distinct from 'ready'
   or v_comparison#>>'{context,source_id}' is distinct from v_source.id::text
   or v_comparison#>>'{context,award_id}' is distinct from v_source.shared_award_id::text
   or v_comparison#>>'{context,epoch}' is distinct from v_source.text_monitoring_state->>'epoch'
   or jsonb_typeof(v_comparison->'changed_blocks') is distinct from 'array'
   or jsonb_typeof(p_candidate#>'{prompt_payload,packet_plan,packets}') is distinct from 'array'
   or jsonb_typeof(p_candidate#>'{ai_result,responses}') is distinct from 'array'
 then raise exception 'Text comparison and complete review plan must remain bound to the candidate.' using errcode='23514'; end if;
 if jsonb_array_length(v_comparison->'changed_blocks') not between 1 and 2000
   or jsonb_array_length(p_candidate#>'{prompt_payload,packet_plan,packets}') not between 1 and 1000
   or jsonb_array_length(p_candidate#>'{ai_result,responses}')<>
     jsonb_array_length(p_candidate#>'{prompt_payload,packet_plan,packets}')
 then raise exception 'Text review coverage is incomplete.' using errcode='23514'; end if;
 foreach v_side in array array['previous','current'] loop
   v_ref:=p_evidence->(v_side||'_capture');
   v_comp_ref:=v_comparison->(v_side||'_ref');
   v_full_text:=v_comparison->>(v_side||'_text');
   if not private.awardping_program_text_reference_valid(v_ref)
     or v_ref is distinct from p_candidate->(case when v_side='previous' then 'previous_snapshot_ref' else 'new_snapshot_ref' end)
     or v_ref#>>'{source,id}' is distinct from v_source.id::text
     or v_ref#>>'{source,shared_award_id}' is distinct from v_source.shared_award_id::text
     or v_ref#>>'{source,url}' is distinct from v_source.url
     or v_ref->>'text_sha256' is distinct from p_candidate->>(case when v_side='previous' then 'previous_text_hash' else 'new_text_hash' end)
     or v_comp_ref->>'capture_id' is distinct from v_ref->>'capture_id'
     or v_comp_ref->>'source_id' is distinct from v_source.id::text
     or v_comp_ref->>'award_id' is distinct from v_source.shared_award_id::text
     or v_comp_ref->>'url' is distinct from v_source.url
     or v_comp_ref->>'final_url' is distinct from v_ref->>'final_url'
     or v_comp_ref->>'captured_at' is distinct from v_ref->>'captured_at'
     or v_comp_ref->>'text_sha256' is distinct from v_ref->>'text_sha256'
     or v_comp_ref->>'raw_source_sha256' is distinct from v_ref#>>'{artifacts,raw,sha256}'
     or v_comp_ref->>'acquisition' is distinct from v_ref->>'acquisition'
     or v_comp_ref->'extractor' is distinct from v_ref->'extractor'
     or jsonb_typeof(v_comparison->(v_side||'_text')) is distinct from 'string'
     or private.awardping_program_utf16_length(v_full_text) is distinct from (v_ref->>'text_length')::integer
     or public.awardping_sha256_text(v_full_text) is distinct from v_ref->>'text_sha256'
   then raise exception 'Text event capture/original comparison mismatch.' using errcode='23514'; end if;
   v_blocks:=p_evidence#>array['localization','supporting_blocks',v_side];
   if jsonb_typeof(v_blocks) is distinct from 'array' then
     raise exception 'Text publication requires exact supporting block arrays.' using errcode='23514'; end if;
   v_expected:='[]'::jsonb;
   for v_row in select value from jsonb_array_elements(v_comparison->'changed_blocks') loop
     v_block:=v_row->v_side;
     if v_block is null then raise exception 'Changed comparison side is missing.' using errcode='23514'; end if;
     if v_block='null'::jsonb then continue; end if;
     if not private.awardping_program_block_valid(v_block,v_full_text) then
       raise exception 'Comparison block is not a complete original text slice.' using errcode='23514'; end if;
     select value into v_existing from jsonb_array_elements(v_expected) where value->>'id'=v_block->>'id';
     if found then
       if v_existing is distinct from v_block then raise exception 'Comparison block identity is ambiguous.' using errcode='23514'; end if;
     else
       if jsonb_array_length(v_expected)>0 and (v_block->>'start_utf16')::integer<
         (v_expected->(-1)->>'end_utf16')::integer then
         raise exception 'Supporting blocks must preserve original nonoverlapping order.' using errcode='23514';
       end if;
       v_expected:=v_expected||jsonb_build_array(v_block);
     end if;
   end loop;
   if v_blocks is distinct from v_expected then
     raise exception 'Supporting blocks must equal the immutable candidate comparison blocks.' using errcode='23514'; end if;
 end loop;
 if (p_evidence#>>'{current_capture,captured_at}')::timestamptz<=(p_evidence#>>'{previous_capture,captured_at}')::timestamptz
   or p_evidence#>>'{current_capture,final_url}' is distinct from p_evidence#>>'{previous_capture,final_url}'
   or p_evidence#>'{current_capture,extractor}' is distinct from p_evidence#>'{previous_capture,extractor}'
   or p_evidence#>>'{current_capture,acquisition}' is distinct from p_evidence#>>'{previous_capture,acquisition}'
 then raise exception 'Text comparison observation order or configuration changed.' using errcode='23514'; end if;
 for v_change in select value from jsonb_array_elements(p_details->'program_changes') loop
   if not private.awardping_program_exact_object(v_change,array['field','operation','summary','previous_quote','current_quote'])
     or not coalesce(v_change->>'field'=any(v_allowed),false)
     or not coalesce(v_change->>'operation' in ('add','remove','replace'),false)
     or jsonb_typeof(v_change->'summary') is distinct from 'string'
     or nullif(btrim(v_change->>'summary'),'') is null
     or private.awardping_program_utf16_length(v_change->>'summary') not between 1 and 600
     or not coalesce(
       (v_change->>'operation'='add' and v_change->'previous_quote'='null'::jsonb and jsonb_typeof(v_change->'current_quote')='object')
       or (v_change->>'operation'='remove' and v_change->'current_quote'='null'::jsonb and jsonb_typeof(v_change->'previous_quote')='object')
       or (v_change->>'operation'='replace' and jsonb_typeof(v_change->'current_quote')='object' and jsonb_typeof(v_change->'previous_quote')='object')
     ,false)
   then raise exception 'Invalid program field, operation or exact quotation direction.' using errcode='23514'; end if;
   v_identity:=jsonb_build_array(v_change->'field',v_change->'operation',v_change->'previous_quote',v_change->'current_quote');
   if exists(select 1 from jsonb_array_elements(v_seen) entry where entry=v_identity) then
     raise exception 'Duplicate program change.' using errcode='23514'; end if;
   v_seen:=v_seen||jsonb_build_array(v_identity);
   foreach v_side in array array['previous','current'] loop
     v_quote:=v_change->(v_side||'_quote');
     if v_quote='null'::jsonb then continue; end if;
     if not private.awardping_program_exact_object(v_quote,array['block_id','start_utf16','end_utf16','text'])
       or jsonb_typeof(v_quote->'text') is distinct from 'string'
       or nullif(btrim(v_quote->>'text'),'') is null
       or private.awardping_program_utf16_length(v_quote->>'text') not between 1 and 1600
       or jsonb_typeof(v_quote->'block_id') is distinct from 'string'
       or private.awardping_program_utf16_length(v_quote->>'block_id') not between 1 and 200
       or not coalesce(jsonb_typeof(v_quote->'start_utf16')='number' and v_quote->>'start_utf16' ~ '^[0-9]+$'
         and jsonb_typeof(v_quote->'end_utf16')='number' and v_quote->>'end_utf16' ~ '^[1-9][0-9]*$'
         and (v_quote->>'start_utf16')::numeric between 0 and 1000000
         and (v_quote->>'end_utf16')::numeric between 1 and 1000000,false)
     then raise exception 'Invalid exact quotation.' using errcode='23514'; end if;
     v_blocks:=p_evidence#>array['localization','supporting_blocks',v_side];
     select value into strict v_block from jsonb_array_elements(v_blocks) where value->>'id'=v_quote->>'block_id';
     v_start:=(v_quote->>'start_utf16')::integer-(v_block->>'start_utf16')::integer;
     v_end:=(v_quote->>'end_utf16')::integer-(v_block->>'start_utf16')::integer;
     if private.awardping_program_utf16_length(v_quote->>'text')<>v_end-v_start
       or private.awardping_program_utf16_slice(v_block->>'text',v_start,v_end) is distinct from v_quote->>'text'
       or strpos(substr(v_block->>'text',strpos(v_block->>'text',v_quote->>'text')+1),v_quote->>'text')>0
     then raise exception 'Quotation does not match its original block.' using errcode='23514'; end if;
   end loop;
   if not exists(select 1 from jsonb_array_elements(v_comparison->'changed_blocks') changed_row
       where (v_change->'previous_quote'='null'::jsonb or changed_row#>>'{previous,id}'=v_change#>>'{previous_quote,block_id}')
         and (v_change->'current_quote'='null'::jsonb or changed_row#>>'{current,id}'=v_change#>>'{current_quote,block_id}'))
     or v_change->>'operation'='replace' and
       btrim(regexp_replace(v_change#>>'{previous_quote,text}','[[:space:]]+',' ','g'))=
       btrim(regexp_replace(v_change#>>'{current_quote,text}','[[:space:]]+',' ','g'))
     or v_change->>'operation'='add' and position(
       btrim(regexp_replace(v_change#>>'{current_quote,text}','[[:space:]]+',' ','g')) in
       btrim(regexp_replace(v_comparison->>'previous_text','[[:space:]]+',' ','g')))>0
     or v_change->>'operation'='remove' and position(
       btrim(regexp_replace(v_change#>>'{previous_quote,text}','[[:space:]]+',' ','g')) in
       btrim(regexp_replace(v_comparison->>'current_text','[[:space:]]+',' ','g')))>0
   then raise exception 'Quoted change is cross-paired, already present or formatting only.' using errcode='23514'; end if;
 end loop;
end;
$$;
revoke all on function public.awardping_validate_program_text_evidence(jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.awardping_validate_program_text_evidence(jsonb,jsonb,jsonb) to service_role;

create or replace function public.publish_program_text_event(p_candidate_id uuid,p_details jsonb,p_localization jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_c public.shared_award_visual_review_candidates%rowtype; v_s public.shared_award_sources%rowtype;
 v_event_id uuid:=gen_random_uuid(); v_evidence jsonb; v_state jsonb; v_existing jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict v_c from public.shared_award_visual_review_candidates where id=p_candidate_id for update;
 if v_c.candidate_scope is distinct from 'program_text_change'
   or not coalesce(v_c.status in ('succeeded','published'),false) then
   raise exception 'An accepted text candidate is required.' using errcode='23514'; end if;
 select * into strict v_s from public.shared_award_sources where id=v_c.shared_award_source_id for update;
 if v_c.status='published' then
   select to_jsonb(e) into strict v_existing from public.shared_award_change_event_visual_evidence e
     join public.shared_award_change_events event on event.id=e.change_event_id
     where e.visual_review_candidate_id=v_c.id and e.change_event_id::text=v_c.worker_metadata->>'change_event_id'
       and e.localization=p_localization and event.change_details=p_details;
   perform public.awardping_validate_program_text_evidence(v_existing,to_jsonb(v_c),p_details);
   return jsonb_build_object('published',true,'event_id',v_c.worker_metadata->>'change_event_id','already_published',true);
 end if;
 if v_s.text_monitoring_state->'baseline_ref' is distinct from v_c.previous_snapshot_ref
   or v_s.text_monitoring_state->'latest_ref' is distinct from v_c.new_snapshot_ref then
   raise exception 'Source baseline or latest observation changed before publication.' using errcode='40001'; end if;
 if not coalesce(v_c.worker_metadata->>'evidence_signature' ~ '^[0-9a-f]{64}$',false) then
   raise exception 'Text publication requires the immutable queued evidence signature.' using errcode='23514'; end if;
 v_evidence:=jsonb_build_object('change_event_id',v_event_id,'shared_award_id',v_c.shared_award_id,
 'shared_award_source_id',v_c.shared_award_source_id,'visual_review_candidate_id',v_c.id,
 'candidate_signature',v_c.candidate_signature,'bucket',v_c.worker_metadata->>'bucket',
 'evidence_status','verified_text','evidence_schema_version','program-text-event-evidence-v1',
 'previous_capture',v_c.previous_snapshot_ref,'current_capture',v_c.new_snapshot_ref,
 'localization',p_localization,'verified_at',clock_timestamp());
 perform public.awardping_validate_program_text_evidence(v_evidence,to_jsonb(v_c),p_details);
 insert into public.shared_award_change_events(id,shared_award_id,shared_award_source_id,source_url,
 source_title,source_page_type,previous_hash,new_hash,summary,change_details,visual_review_candidate_id)
 values(v_event_id,v_c.shared_award_id,v_c.shared_award_source_id,v_c.source_url,v_c.source_title,
 v_c.source_page_type,v_c.previous_text_hash,v_c.new_text_hash,p_details->>'summary',p_details,v_c.id);
 insert into public.shared_award_change_event_visual_evidence(change_event_id,shared_award_id,
 shared_award_source_id,visual_review_candidate_id,candidate_signature,bucket,evidence_status,
 previous_capture,current_capture,localization,evidence_schema_version,verified_at)
 values(v_event_id,v_c.shared_award_id,v_c.shared_award_source_id,v_c.id,v_c.candidate_signature,
 v_c.worker_metadata->>'bucket','verified_text',v_c.previous_snapshot_ref,v_c.new_snapshot_ref,
 p_localization,'program-text-event-evidence-v1',clock_timestamp());
 update public.shared_award_visual_review_candidates set status='published',published_at=clock_timestamp(),
 updated_at=clock_timestamp(),worker_metadata=worker_metadata||jsonb_build_object('change_event_id',v_event_id,'baseline_advanced',true)
 where id=v_c.id;
 v_state:=v_s.text_monitoring_state||jsonb_build_object('baseline_ref',v_c.new_snapshot_ref,
 'status','baseline_ready','last_program_update_at',clock_timestamp());
 update public.shared_award_sources set text_monitoring_state=v_state where id=v_s.id;
 return jsonb_build_object('published',true,'event_id',v_event_id,'already_published',false);
end;
$$;
revoke all on function public.publish_program_text_event(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.publish_program_text_event(uuid,jsonb,jsonb) to service_role;

alter table public.shared_award_change_event_visual_evidence drop constraint shared_award_change_event_visual_evidence_verification_check;
alter table public.shared_award_change_event_visual_evidence add constraint shared_award_change_event_visual_evidence_verification_check check (((((evidence_status = 'verified'::text) AND (verified_at IS NOT NULL) AND (visual_review_candidate_id IS NOT NULL) AND (((jsonb_typeof((previous_capture -> 'crop'::text)) = 'object'::text) AND COALESCE(((previous_capture #>> '{crop,exact_overlap}'::text[]))::boolean, false)) OR ((jsonb_typeof((current_capture -> 'crop'::text)) = 'object'::text) AND COALESCE(((current_capture #>> '{crop,exact_overlap}'::text[]))::boolean, false)))) OR ((evidence_status <> 'verified'::text) AND (verified_at IS NULL)))) or (evidence_status='verified_text' and verified_at is not null and visual_review_candidate_id is not null));
CREATE OR REPLACE FUNCTION public.awardping_validate_visual_evidence_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_event public.shared_award_change_events%rowtype;
  v_direction text;
  v_previous_required boolean;
  v_current_required boolean;
  v_previous_localization jsonb;
  v_current_localization jsonb;
begin
  select * into strict v_event
  from public.shared_award_change_events event
  where event.id = new.change_event_id;

  if v_event.shared_award_id <> new.shared_award_id
    or v_event.shared_award_source_id is distinct from new.shared_award_source_id then
    raise exception using errcode = '23514',
      message = 'Visual evidence award/source identity does not match its change event.';
  end if;

  if new.evidence_status = 'historical_artifact_unrecoverable' and (
    coalesce((new.localization ->> 'terminal_artifact_loss_confirmed')::boolean, false) is not true
    or nullif(btrim(new.localization ->> 'terminal_artifact_loss_reason'), '') is null
    or new.localization #>> '{sides,previous,status}' is distinct from 'historical_artifact_unrecoverable'
    or nullif(btrim(new.localization #>> '{sides,previous,reason}'), '') is null
    or new.localization #>> '{sides,current,status}' is distinct from 'historical_artifact_unrecoverable'
    or nullif(btrim(new.localization #>> '{sides,current,reason}'), '') is null
  ) then
    raise exception using errcode = '23514',
      message = 'Unrecoverable visual history requires explicit terminal artifact-loss confirmation.';
  end if;

  if new.visual_review_candidate_id is null then
    if new.backfilled_at is null
      or new.evidence_status <> 'historical_artifact_unrecoverable'
      or new.previous_capture <> '{}'::jsonb
      or new.current_capture <> '{}'::jsonb
      or new.bucket is not null
      or coalesce((new.localization ->> 'terminal_artifact_loss_confirmed')::boolean, false) is not true
      or nullif(btrim(new.localization ->> 'terminal_artifact_loss_reason'), '') is null
      or new.localization #>> '{sides,previous,status}' is distinct from 'historical_artifact_unrecoverable'
      or nullif(btrim(new.localization #>> '{sides,previous,reason}'), '') is null
      or new.localization #>> '{sides,current,status}' is distinct from 'historical_artifact_unrecoverable'
      or nullif(btrim(new.localization #>> '{sides,current,reason}'), '') is null then
      raise exception using errcode = '23514',
        message = 'Candidate-free visual evidence is allowed only after explicit terminal artifact-loss confirmation.';
    end if;
    return new;
  end if;

  select * into strict v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = new.visual_review_candidate_id;
  if v_candidate.shared_award_id <> new.shared_award_id
    or v_candidate.shared_award_source_id is distinct from new.shared_award_source_id
    or v_candidate.candidate_signature <> new.candidate_signature then
    raise exception using errcode = '23514',
      message = 'Visual evidence identity does not match its review candidate.';
  end if;
  if v_event.visual_review_candidate_id is distinct from new.visual_review_candidate_id then
    raise exception using errcode = '23514',
      message = 'Visual evidence candidate does not match its change event binding.';
  end if;

  if new.evidence_schema_version='program-text-event-evidence-v1' or new.evidence_status='verified_text'
    or v_candidate.candidate_scope='program_text_change'
    or new.previous_capture->>'kind'='program_text' or new.current_capture->>'kind'='program_text'
    or v_event.change_details->>'schema'='awardping.program-change.v1' then
    perform public.awardping_validate_program_text_evidence(to_jsonb(new),to_jsonb(v_candidate),v_event.change_details);
    return new;
  end if;

  if to_jsonb(new) ->> 'evidence_status' = 'not_applicable_source_html'
    or to_jsonb(new) ->> 'evidence_schema_version' = 'source-html-event-evidence-v1'
    or to_jsonb(new) #>> '{previous_capture,kind}' = 'source_html'
    or to_jsonb(new) #>> '{current_capture,kind}' = 'source_html'
    or to_jsonb(new) #>> '{previous_capture,capture_profile}' = 'scrapling-source-html-v1'
    or to_jsonb(new) #>> '{current_capture,capture_profile}' = 'scrapling-source-html-v1'
    or v_event.change_details ->> 'evidence_kind' = 'source_html'
    or v_event.change_details ->> 'capture_profile' = 'scrapling-source-html-v1' then
    perform public.awardping_validate_source_html_evidence(to_jsonb(new),to_jsonb(v_candidate),v_event.change_details);
  end if;

  if new.evidence_status = 'verified' then
    if new.evidence_schema_version <> 'visual-event-evidence-v2' then
      raise exception using errcode = '23514',
        message = 'New verified crops require visual-event-evidence-v2; v1 crops are full-screenshot fallback only.';
    end if;
    perform public.awardping_validate_exact_visual_evidence(
      new.previous_capture,
      new.current_capture,
      new.localization
    );
    v_direction := new.localization ->> 'direction';
    v_previous_required := public.awardping_visual_event_has_semantic_side(v_event.change_details, 'previous');
    v_current_required := public.awardping_visual_event_has_semantic_side(v_event.change_details, 'current');
    if (v_previous_required and v_current_required and v_direction not in ('changed', 'mixed'))
      or (v_previous_required and not v_current_required and v_direction <> 'removed')
      or (v_current_required and not v_previous_required and v_direction <> 'added')
      or (not v_previous_required and not v_current_required) then
      raise exception using errcode = '23514',
        message = 'Verified crop direction does not match the exact directional wording in the event.';
    end if;
    v_previous_localization := new.localization #> '{sides,previous}';
    v_current_localization := new.localization #> '{sides,current}';
    if v_previous_required and not public.awardping_visual_semantic_text_allowed(
      v_event.change_details,
      'previous',
      v_previous_localization #>> '{semantic_binding,wording_source}',
      v_previous_localization ->> 'exact_text'
    ) then
      raise exception using errcode = '23514',
        message = 'Previous crop wording is not an exact removed value from this event.';
    end if;
    if v_current_required and not public.awardping_visual_semantic_text_allowed(
      v_event.change_details,
      'current',
      v_current_localization #>> '{semantic_binding,wording_source}',
      v_current_localization ->> 'exact_text'
    ) then
      raise exception using errcode = '23514',
        message = 'Current crop wording is not an exact added value from this event.';
    end if;
    if new.localization ->> 'change_semantics_sha256' is distinct from
        coalesce(v_previous_localization #>> '{semantic_binding,change_semantics_sha256}',
          v_current_localization #>> '{semantic_binding,change_semantics_sha256}')
      or (v_previous_required and v_current_required and
        v_previous_localization #>> '{semantic_binding,change_semantics_sha256}' is distinct from
          v_current_localization #>> '{semantic_binding,change_semantics_sha256}') then
      raise exception using errcode = '23514',
        message = 'Required crop sides do not share the event semantic manifest hash.';
    end if;
  end if;
  return new;
exception
  when no_data_found then
    raise exception using errcode = '23503',
      message = 'Visual evidence references a missing event or candidate.';
end;
$function$
;
CREATE OR REPLACE FUNCTION public.awardping_freeze_published_visual_candidate_event_binding()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'INSERT' then
    if new.status = 'published' then
      raise exception using
        errcode = '23514',
        message = 'A post-migration visual candidate cannot be inserted directly in published status.';
    end if;
    return new;
  end if;

  if new.candidate_scope is distinct from old.candidate_scope
    or old.candidate_scope='program_text_change' and (
      new.worker_metadata->>'epoch' is distinct from old.worker_metadata->>'epoch'
      or new.worker_metadata->>'monitoring_contract' is distinct from old.worker_metadata->>'monitoring_contract'
      or new.worker_metadata->>'bucket' is distinct from old.worker_metadata->>'bucket'
    ) then
    raise exception 'Queued candidate scope and text monitoring identity are immutable.' using errcode='55000';
  end if;

  if old.status <> 'published' and new.status = 'published' then
    if nullif(btrim(new.worker_metadata ->> 'change_event_id'), '') is null
      or (
        nullif(btrim(old.worker_metadata ->> 'change_event_id'), '') is not null
        and new.worker_metadata ->> 'change_event_id' is distinct from
          old.worker_metadata ->> 'change_event_id'
      ) then
      raise exception using
        errcode = '55000',
        message = 'A visual candidate must enter published status with its existing exact reverse event binding.';
    end if;

    if not exists (
      select 1
      from public.shared_award_change_event_visual_evidence evidence
      where evidence.visual_review_candidate_id = new.id
        and evidence.change_event_id::text = new.worker_metadata ->> 'change_event_id'
    ) then
      raise exception using
        errcode = '23514',
        message = 'A visual candidate cannot enter published status before its exact immutable event evidence exists.';
    end if;

    if new.worker_metadata ->> 'evidence_signature' is null
      or new.worker_metadata ->> 'evidence_signature' !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '23514',
        message = 'A modern visual candidate cannot enter published status without its evidence signature.';
    end if;

    if new.candidate_scope='program_text_change' then
      perform public.awardping_validate_program_text_evidence(to_jsonb(e),to_jsonb(new),v.change_details)
      from public.shared_award_change_event_visual_evidence e
      join public.shared_award_change_events v on v.id=e.change_event_id
      where e.visual_review_candidate_id=new.id and e.change_event_id::text=new.worker_metadata->>'change_event_id';
      if not found then raise exception 'Text publication evidence missing.' using errcode='23514'; end if;
      return new;
    end if;

    if new.candidate_scope = 'initial_official_document' then
      if new.source_acquisition_id is null
        or jsonb_typeof(new.previous_snapshot_ref) is distinct from 'object'
        or new.previous_snapshot_ref is distinct from
          new.prompt_payload -> 'previous_snapshot_ref'
        or new.previous_snapshot_ref ->> 'kind' is distinct from
          'first_observation_attestation'
        or coalesce(
          new.previous_snapshot_ref ->> 'attestation_sha256' ~ '^[0-9a-f]{64}$',
          false
        ) is not true
        or new.previous_snapshot_ref ->> 'attestation_sha256' is distinct from
          new.previous_file_hash
        or new.previous_snapshot_ref ->> 'attestation_sha256' is distinct from
          new.prompt_payload #>> '{first_observation_attestation,sha256}'
        or new.previous_snapshot_ref ->> 'attestation_sha256' is distinct from
          new.prompt_payload #>> '{hashes,first_observation_attestation_sha256}'
        or new.previous_snapshot_ref ->> 'source_acquisition_id' is distinct from
          new.source_acquisition_id::text
        or coalesce(
          new.previous_snapshot_ref ->> 'byte_length' ~ '^[1-9][0-9]*$',
          false
        ) is not true
        or new.previous_snapshot_ref ->> 'byte_length' is distinct from
          new.prompt_payload #>> '{first_observation_attestation,byte_length}'
        or new.previous_snapshot_ref ->> 'content_type' is distinct from
          'application/json'
        or new.previous_snapshot_ref ->> 'content_type' is distinct from
          new.prompt_payload #>> '{first_observation_attestation,content_type}'
        or coalesce(
          new.previous_snapshot_ref ->> 'captured_at' ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.+Z$',
          false
        ) is not true
        or new.previous_snapshot_ref ->> 'captured_at' is distinct from
          new.prompt_payload #>>
            '{first_observation_attestation,body,capture,captured_at}'
        or new.previous_snapshot_ref ? 'artifact_manifest'
        or nullif(
          btrim(new.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}'),
          ''
        ) is not null then
        raise exception using
          errcode = '23514',
          message = 'An initial official-document candidate requires its exact immutable first-observation attestation instead of a previous snapshot manifest.';
      end if;

      if not exists (
        select 1
        from public.shared_award_change_event_visual_evidence evidence
        where evidence.visual_review_candidate_id = new.id
          and evidence.change_event_id::text = new.worker_metadata ->> 'change_event_id'
          and evidence.evidence_status = 'not_applicable_new_document'
          and evidence.previous_capture ->> 'kind' = 'first_observation_attestation'
          and evidence.previous_capture ->> 'state_id' = 'first-observation'
          and evidence.previous_capture #>> '{metadata,sha256}' = new.previous_file_hash
          and evidence.previous_capture #>> '{metadata,byte_length}' =
            new.previous_snapshot_ref ->> 'byte_length'
          and evidence.previous_capture #>> '{metadata,content_type}' like
            'application/json%'
          and evidence.previous_capture ->> 'captured_at' =
            new.previous_snapshot_ref ->> 'captured_at'
          and evidence.previous_capture #>> '{capture_hashes,attestation_hash}' =
            new.previous_file_hash
          and evidence.previous_capture #>> '{attestation,binding,candidate_id}' =
            new.id::text
          and evidence.previous_capture #>> '{attestation,binding,candidate_signature}' =
            new.candidate_signature
          and evidence.previous_capture #>>
            '{attestation,binding,source_acquisition_id}' =
              new.source_acquisition_id::text
          and evidence.previous_capture #>>
            '{attestation,binding,first_observation_attestation_sha256}' =
              new.previous_file_hash
          and evidence.previous_capture #>>
            '{attestation,binding,current_file_sha256}' = new.new_file_hash
          and evidence.current_capture ->> 'kind' = 'pdf'
          and evidence.current_capture ->> 'state_id' = 'document'
          and evidence.current_capture #>> '{full,sha256}' = new.new_file_hash
          and evidence.current_capture #>> '{capture_hashes,file_hash}' =
            new.new_file_hash
      ) then
        raise exception using
          errcode = '23514',
          message = 'An initial official-document candidate cannot enter published status without its exact attestation and current-document evidence.';
      end if;

      perform public.awardping_validate_candidate_snapshot_manifest(
        new.new_snapshot_ref,
        new.prompt_payload -> 'new_snapshot_ref',
        new.prompt_payload #>> '{hashes,new_artifact_manifest_digest}',
        'current'
      );
    else
      perform public.awardping_validate_candidate_snapshot_manifest(
        new.previous_snapshot_ref,
        new.prompt_payload -> 'previous_snapshot_ref',
        new.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}',
        'previous'
      );
      perform public.awardping_validate_candidate_snapshot_manifest(
        new.new_snapshot_ref,
        new.prompt_payload -> 'new_snapshot_ref',
        new.prompt_payload #>> '{hashes,new_artifact_manifest_digest}',
        'current'
      );
    end if;
  end if;

  if old.status = 'published' and (
    new.status is distinct from old.status
    or new.worker_metadata ->> 'change_event_id' is distinct from
      old.worker_metadata ->> 'change_event_id'
  ) then
    raise exception using
      errcode = '55000',
        message = 'A published visual candidate status and reverse event binding are immutable.';
  end if;
  return new;
end;
$function$
;
revoke all on function public.awardping_validate_visual_evidence_insert() from public,anon,authenticated;
grant execute on function public.awardping_validate_visual_evidence_insert() to service_role;
revoke all on function public.awardping_freeze_published_visual_candidate_event_binding() from public,anon,authenticated;
grant execute on function public.awardping_freeze_published_visual_candidate_event_binding() to service_role;
