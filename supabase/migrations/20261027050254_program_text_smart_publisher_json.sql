-- PRIVATE DRAFT: ROOT ONLY. No source state is changed by migration application.
-- This is a finite initial publisher-data transport; it is not HTML/WS coverage.
create function private.awardping_smart_publisher_json_reference_metadata_valid(p_ref jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
 select coalesce(p_ref->>'acquisition'='publisher_json'
  and p_ref#>>'{source,shared_award_id}'='d7d4d117-f312-456f-a75c-3dbd5d372c99'
  and p_ref#>>'{extractor,name}'='smart-publisher-json'
  and p_ref#>>'{extractor,version}'='smart-publisher-json-v1'
  and p_ref->>'final_url'=p_ref#>>'{source,url}'
  and ((p_ref#>>'{source,id}'='58aefec0-0d42-4b7b-9887-60d25940b3d0'
    and p_ref#>>'{source,url}'='https://www.smartscholarship.org/smart'
    and p_ref#>>'{source,page_type}'='homepage')
   or (p_ref#>>'{source,id}'='c33cc2f4-2cbd-458c-b630-537eb3d50f72'
    and p_ref#>>'{source,url}'='https://www.smartscholarship.org/smart/en?id=smart_eligibility'
    and p_ref#>>'{source,page_type}'='eligibility')),false);
$$;
create function private.awardping_program_changed_publisher_data(p_comparison jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
 select case when jsonb_typeof(p_comparison->'changed_blocks')='array' then exists(
  select 1 from jsonb_array_elements(p_comparison->'changed_blocks') row,
   lateral (values(row->'previous'),(row->'current')) sides(block)
  where block->>'kind'='publisher_data' or block#>>'{context,representation}'='publisher_data')
 else true end;
$$;
revoke all on function private.awardping_smart_publisher_json_reference_metadata_valid(jsonb),
 private.awardping_program_changed_publisher_data(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_smart_publisher_json_reference_metadata_valid(jsonb),
 private.awardping_program_changed_publisher_data(jsonb) to service_role;

-- Exact private.awardping_program_text_reference_valid preimage, UTF-8 LF body. No guard is removed.
do $guard_0$
declare function_oid oid; prior_body text; definition text; next_body text; edit jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select proc.oid,proc.prosrc,pg_catalog.pg_get_functiondef(proc.oid) into strict function_oid,prior_body,definition
 from pg_catalog.pg_proc proc join pg_catalog.pg_namespace ns on ns.oid=proc.pronamespace
 where ns.nspname='private' and proc.proname='awardping_program_text_reference_valid';
 if encode(extensions.digest(convert_to(prior_body,'UTF8'),'sha256'),'hex') is distinct from 'cd21fddd73b6c2d296469c3baee572b75c4b7189db1c54a0758b9496949b9b5f'
 then raise exception 'Reviewed function body changed; re-review the exact live preimage.' using errcode='40001';end if;
 next_body:=prior_body;
 for edit in select value from jsonb_array_elements('[{"needle":" v_pdf boolean; v_limit integer;","replacement":" v_pdf boolean; v_json boolean; v_limit integer;"},{"needle":"begin\n if p_ref#>>''{extractor,version}''=","replacement":"begin\n if (p_ref->>''acquisition''=''publisher_json'' or p_ref#>>''{extractor,name}''=''smart-publisher-json'' or p_ref#>>''{extractor,version}''=''smart-publisher-json-v1'')\n  and not private.awardping_smart_publisher_json_reference_metadata_valid(p_ref) then return false;end if;\n if p_ref#>>''{extractor,version}''="},{"needle":"in (''http_html'',''rendered_html'',''pdf_text'',''pdf_ocr'')","replacement":"in (''http_html'',''rendered_html'',''pdf_text'',''pdf_ocr'',''publisher_json'')"},{"needle":" v_pdf:=p_ref->>''acquisition'' in (''pdf_text'',''pdf_ocr'');","replacement":" v_pdf:=p_ref->>''acquisition'' in (''pdf_text'',''pdf_ocr'');\n v_json:=p_ref->>''acquisition''=''publisher_json'';"},{"needle":"when v_pdf then ''original.pdf'' else ''original.html'' end;","replacement":"when v_pdf then ''original.pdf'' when v_json then ''original.json'' else ''original.html'' end;"},{"needle":"v_limit:=case when v_role=''raw'' and v_pdf","replacement":"v_limit:=case when v_role=''raw'' and v_json then 524288 when v_role=''raw'' and v_pdf"},{"needle":"coalesce(case when v_pdf then (v_artifact","replacement":"coalesce(case when v_json then v_artifact->>''content_type''=''application/json'' when v_pdf then (v_artifact"}]'::jsonb) loop
  if edit->>'needle'='' or (length(next_body)-length(replace(next_body,edit->>'needle','')))/length(edit->>'needle')<>1
  then raise exception 'Expected unique exact body insertion point is unavailable.' using errcode='40001';end if;
  next_body:=replace(next_body,edit->>'needle',edit->>'replacement');
 end loop;
 if next_body=prior_body or (length(definition)-length(replace(definition,prior_body,'')))/length(prior_body)<>1
 then raise exception 'Exact function body cannot be replaced safely.' using errcode='40001';end if;
 execute replace(definition,prior_body,next_body);
end $guard_0$;

-- Exact private.awardping_program_fact_validation_valid preimage, UTF-8 LF body. No guard is removed.
do $guard_1$
declare function_oid oid; prior_body text; definition text; next_body text; edit jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select proc.oid,proc.prosrc,pg_catalog.pg_get_functiondef(proc.oid) into strict function_oid,prior_body,definition
 from pg_catalog.pg_proc proc join pg_catalog.pg_namespace ns on ns.oid=proc.pronamespace
 where ns.nspname='private' and proc.proname='awardping_program_fact_validation_valid';
 if encode(extensions.digest(convert_to(prior_body,'UTF8'),'sha256'),'hex') is distinct from 'fa208e16066d3596ba303d7b4a2ad6e99f1fa8b5f4c9ab9bdf53f81d6653d61a'
 then raise exception 'Reviewed function body changed; re-review the exact live preimage.' using errcode='40001';end if;
 next_body:=prior_body;
 for edit in select value from jsonb_array_elements('[{"needle":"    v_start:=(v_quote->>''start_utf16'')::integer; v_end:=(v_quote->>''end_utf16'')::integer;","replacement":"    if v_block->>''kind''=''publisher_data'' or v_block#>>''{context,representation}''=''publisher_data'' then return false;end if;\n    v_start:=(v_quote->>''start_utf16'')::integer; v_end:=(v_quote->>''end_utf16'')::integer;"}]'::jsonb) loop
  if edit->>'needle'='' or (length(next_body)-length(replace(next_body,edit->>'needle','')))/length(edit->>'needle')<>1
  then raise exception 'Expected unique exact body insertion point is unavailable.' using errcode='40001';end if;
  next_body:=replace(next_body,edit->>'needle',edit->>'replacement');
 end loop;
 if next_body=prior_body or (length(definition)-length(replace(definition,prior_body,'')))/length(prior_body)<>1
 then raise exception 'Exact function body cannot be replaced safely.' using errcode='40001';end if;
 execute replace(definition,prior_body,next_body);
end $guard_1$;

-- Exact private.awardping_variation_fact_validation_valid preimage, UTF-8 LF body. No guard is removed.
do $guard_2$
declare function_oid oid; prior_body text; definition text; next_body text; edit jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select proc.oid,proc.prosrc,pg_catalog.pg_get_functiondef(proc.oid) into strict function_oid,prior_body,definition
 from pg_catalog.pg_proc proc join pg_catalog.pg_namespace ns on ns.oid=proc.pronamespace
 where ns.nspname='private' and proc.proname='awardping_variation_fact_validation_valid';
 if encode(extensions.digest(convert_to(prior_body,'UTF8'),'sha256'),'hex') is distinct from '5764a88861f254d08c8aab83e81de4162144f7df344a36d38d27721aec8a6601'
 then raise exception 'Reviewed function body changed; re-review the exact live preimage.' using errcode='40001';end if;
 next_body:=prior_body;
 for edit in select value from jsonb_array_elements('[{"needle":"    v_start:=(v_quote->>''start_utf16'')::integer; v_end:=(v_quote->>''end_utf16'')::integer;","replacement":"    if v_block->>''kind''=''publisher_data'' or v_block#>>''{context,representation}''=''publisher_data'' then return false;end if;\n    v_start:=(v_quote->>''start_utf16'')::integer; v_end:=(v_quote->>''end_utf16'')::integer;"}]'::jsonb) loop
  if edit->>'needle'='' or (length(next_body)-length(replace(next_body,edit->>'needle','')))/length(edit->>'needle')<>1
  then raise exception 'Expected unique exact body insertion point is unavailable.' using errcode='40001';end if;
  next_body:=replace(next_body,edit->>'needle',edit->>'replacement');
 end loop;
 if next_body=prior_body or (length(definition)-length(replace(definition,prior_body,'')))/length(prior_body)<>1
 then raise exception 'Exact function body cannot be replaced safely.' using errcode='40001';end if;
 execute replace(definition,prior_body,next_body);
end $guard_2$;

-- Exact private.awardping_variation_quote_valid preimage, UTF-8 LF body. No guard is removed.
do $guard_3$
declare function_oid oid; prior_body text; definition text; next_body text; edit jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select proc.oid,proc.prosrc,pg_catalog.pg_get_functiondef(proc.oid) into strict function_oid,prior_body,definition
 from pg_catalog.pg_proc proc join pg_catalog.pg_namespace ns on ns.oid=proc.pronamespace
 where ns.nspname='private' and proc.proname='awardping_variation_quote_valid';
 if encode(extensions.digest(convert_to(prior_body,'UTF8'),'sha256'),'hex') is distinct from 'd9517c1f243562a0719f2bd135dd67a826cbc5b47c8a0f2ae6eedf5d4f5ab4a4'
 then raise exception 'Reviewed function body changed; re-review the exact live preimage.' using errcode='40001';end if;
 next_body:=prior_body;
 for edit in select value from jsonb_array_elements('[{"needle":" a:=(p_quote->>''start_utf16'')::integer; z:=(p_quote->>''end_utf16'')::integer;","replacement":" if b->>''kind''=''publisher_data'' or b#>>''{context,representation}''=''publisher_data'' then return false;end if;\n a:=(p_quote->>''start_utf16'')::integer; z:=(p_quote->>''end_utf16'')::integer;"}]'::jsonb) loop
  if edit->>'needle'='' or (length(next_body)-length(replace(next_body,edit->>'needle','')))/length(edit->>'needle')<>1
  then raise exception 'Expected unique exact body insertion point is unavailable.' using errcode='40001';end if;
  next_body:=replace(next_body,edit->>'needle',edit->>'replacement');
 end loop;
 if next_body=prior_body or (length(definition)-length(replace(definition,prior_body,'')))/length(prior_body)<>1
 then raise exception 'Exact function body cannot be replaced safely.' using errcode='40001';end if;
 execute replace(definition,prior_body,next_body);
end $guard_3$;

-- Exact public.awardping_validate_program_text_evidence preimage, UTF-8 LF body. No guard is removed.
do $guard_4$
declare function_oid oid; prior_body text; definition text; next_body text; edit jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select proc.oid,proc.prosrc,pg_catalog.pg_get_functiondef(proc.oid) into strict function_oid,prior_body,definition
 from pg_catalog.pg_proc proc join pg_catalog.pg_namespace ns on ns.oid=proc.pronamespace
 where ns.nspname='public' and proc.proname='awardping_validate_program_text_evidence';
 if encode(extensions.digest(convert_to(prior_body,'UTF8'),'sha256'),'hex') is distinct from 'f3ee03f5a8c0c9259ba3d0527a420c6ffe7a34d99d350d0bd495ddc634eb4ef6'
 then raise exception 'Reviewed function body changed; re-review the exact live preimage.' using errcode='40001';end if;
 next_body:=prior_body;
 for edit in select value from jsonb_array_elements('[{"needle":"     v_start:=(v_quote->>''start_utf16'')::integer-(v_block->>''start_utf16'')::integer;","replacement":"     if v_block->>''kind''=''publisher_data'' or v_block#>>''{context,representation}''=''publisher_data'' then raise exception ''Publisher data labels are not source quotations.'' using errcode=''23514'';end if;\n     v_start:=(v_quote->>''start_utf16'')::integer-(v_block->>''start_utf16'')::integer;"},{"needle":" v_comparison_id:=v_comparison->>''comparison_id'';","replacement":" if private.awardping_program_changed_publisher_data(v_comparison) then raise exception ''Changed publisher data requires separate reconciliation, not publication.'' using errcode=''23514'';end if;\n v_comparison_id:=v_comparison->>''comparison_id'';"}]'::jsonb) loop
  if edit->>'needle'='' or (length(next_body)-length(replace(next_body,edit->>'needle','')))/length(edit->>'needle')<>1
  then raise exception 'Expected unique exact body insertion point is unavailable.' using errcode='40001';end if;
  next_body:=replace(next_body,edit->>'needle',edit->>'replacement');
 end loop;
 if next_body=prior_body or (length(definition)-length(replace(definition,prior_body,'')))/length(prior_body)<>1
 then raise exception 'Exact function body cannot be replaced safely.' using errcode='40001';end if;
 execute replace(definition,prior_body,next_body);
end $guard_4$;

-- Exact private.awardping_set_program_text_source_state_base preimage, UTF-8 LF body. No guard is removed.
do $guard_5$
declare function_oid oid; prior_body text; definition text; next_body text; edit jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select proc.oid,proc.prosrc,pg_catalog.pg_get_functiondef(proc.oid) into strict function_oid,prior_body,definition
 from pg_catalog.pg_proc proc join pg_catalog.pg_namespace ns on ns.oid=proc.pronamespace
 where ns.nspname='private' and proc.proname='awardping_set_program_text_source_state_base';
 if encode(extensions.digest(convert_to(prior_body,'UTF8'),'sha256'),'hex') is distinct from 'f77f940c3d865861943c915fa188d283288d7d7285f4731c156ecf7e55c6f68e'
 then raise exception 'Reviewed function body changed; re-review the exact live preimage.' using errcode='40001';end if;
 next_body:=prior_body;
 for edit in select value from jsonb_array_elements('[{"needle":"and c.ai_result#>>''{program_text_validation,status}''=''no_program_change''","replacement":"and c.ai_result#>>''{program_text_validation,status}''=''no_program_change''\n             and not private.awardping_program_changed_publisher_data(c.prompt_payload#>''{comparison}'')"}]'::jsonb) loop
  if edit->>'needle'='' or (length(next_body)-length(replace(next_body,edit->>'needle','')))/length(edit->>'needle')<>1
  then raise exception 'Expected unique exact body insertion point is unavailable.' using errcode='40001';end if;
  next_body:=replace(next_body,edit->>'needle',edit->>'replacement');
 end loop;
 if next_body=prior_body or (length(definition)-length(replace(definition,prior_body,'')))/length(prior_body)<>1
 then raise exception 'Exact function body cannot be replaced safely.' using errcode='40001';end if;
 execute replace(definition,prior_body,next_body);
end $guard_5$;


create table public.program_text_smart_initial_coverage_journal (
 id uuid primary key default gen_random_uuid(),
 source_id uuid not null references public.shared_award_sources(id) on delete restrict,
 epoch uuid not null references public.program_text_source_authority_epochs(epoch) on delete restrict,
 policy text not null check(policy='awardping.smart-publisher-initial-coverage.v1'),
 source_identity jsonb not null,source_role_authority jsonb not null,
 previous_state jsonb not null,next_state jsonb not null,document jsonb not null,
 document_hash text not null check(document_hash ~ '^[a-f0-9]{64}$'),
 actor text not null,reason text not null check(length(btrim(reason)) between 20 and 2000),
 created_at timestamptz not null default clock_timestamp(),unique(source_id,epoch)
);
alter table public.program_text_smart_initial_coverage_journal enable row level security;
revoke all on public.program_text_smart_initial_coverage_journal from public,anon,authenticated,service_role;
grant select on public.program_text_smart_initial_coverage_journal to service_role;
create function private.awardping_reject_smart_initial_coverage_mutation()
returns trigger language plpgsql security invoker set search_path='' as $$begin
 raise exception 'Meaningful SMART initial coverage history is immutable.' using errcode='42501';
end $$;
revoke all on function private.awardping_reject_smart_initial_coverage_mutation() from public,anon,authenticated,service_role;
create trigger program_text_smart_initial_coverage_no_mutation before update or delete
 on public.program_text_smart_initial_coverage_journal for each row execute function private.awardping_reject_smart_initial_coverage_mutation();
create trigger program_text_smart_initial_coverage_no_truncate before truncate
 on public.program_text_smart_initial_coverage_journal for each statement execute function private.awardping_reject_smart_initial_coverage_mutation();

create function public.transition_known_smart_html_shell(
 p_source_id uuid,p_expected_state jsonb,p_next_state jsonb,p_document jsonb,p_policy text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.shared_award_sources%rowtype; prior public.program_text_smart_initial_coverage_journal%rowtype;
 r jsonb:=p_document->'reference';old_ref jsonb;expected_next jsonb;roles jsonb;identity jsonb;
 policy_epoch uuid;observed_at timestamptz;document_hash text;journal_id uuid:=gen_random_uuid();changed integer;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if p_source_id not in ('58aefec0-0d42-4b7b-9887-60d25940b3d0'::uuid,'c33cc2f4-2cbd-458c-b630-537eb3d50f72'::uuid)
  or p_source_id is null or p_policy is distinct from 'awardping.smart-publisher-initial-coverage.v1'
  or length(btrim(coalesce(p_reason,''))) not between 20 and 2000
  or octet_length(p_document::text)>33554432
 then raise exception 'Outside the finite meaningful SMART coverage policy.' using errcode='23514';end if;
 select epoch into strict policy_epoch from public.program_text_source_authority_epochs where active;
 select * into strict s from public.shared_award_sources where id=p_source_id for update;
 if s.shared_award_id<>'d7d4d117-f312-456f-a75c-3dbd5d372c99'::uuid
  or not private.awardping_program_source_allowed(s.id)
  or not private.awardping_program_text_source_access(s.id,'smart',policy_epoch)
  or not exists(select 1 from public.stage1_award_registry registry join public.stage1_award_members member
   on member.cohort_key=registry.cohort_key and member.shared_award_id=s.shared_award_id
   where registry.cohort_key='smart' and registry.canonical_shared_award_id=s.shared_award_id)
  or not private.awardping_smart_publisher_json_reference_metadata_valid(r)
  or private.awardping_program_source_approval_document_valid(p_document) is distinct from true
  or r#>>'{source,id}' is distinct from s.id::text
  or r#>>'{source,shared_award_id}' is distinct from s.shared_award_id::text
  or r#>>'{source,url}' is distinct from s.url or r#>>'{source,title}' is distinct from s.title
  or r#>>'{source,page_type}' is distinct from s.page_type
 then raise exception 'Exact current source authority and complete retained publisher original are required.' using errcode='23514';end if;
 identity:=jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type);
 document_hash:=encode(extensions.digest(convert_to(p_document::text,'UTF8'),'sha256'),'hex');
 expected_next:=jsonb_build_object('schema','awardping.program-text-state.v1','epoch',policy_epoch,'status','baseline_ready',
  'baseline_ref',r,'latest_ref',r,'last_checked_at',r->>'captured_at','first_captured_at',r->>'captured_at','successful_checks',1);
 if p_next_state is distinct from expected_next then raise exception 'One meaningful capture must establish its exact fresh baseline, never an update.' using errcode='23514';end if;
 select * into prior from public.program_text_smart_initial_coverage_journal where source_id=s.id and epoch=policy_epoch;
 if found then
  if prior.previous_state is distinct from p_expected_state or prior.next_state is distinct from p_next_state
   or prior.document is distinct from p_document or prior.document_hash<>document_hash or prior.policy<>p_policy
   or prior.reason<>p_reason or prior.source_identity is distinct from identity or s.text_monitoring_state is distinct from prior.next_state
  then raise exception 'Initial coverage already exists or its exact source state has advanced; history cannot be replayed differently.' using errcode='40001';end if;
  return jsonb_build_object('applied',true,'journal_id',prior.id,'state',prior.next_state,'initial_coverage',true,'creates_update',false,'idempotent',true);
 end if;
 if s.text_monitoring_state is distinct from p_expected_state then raise exception 'SMART source state changed; preserve the current exact pair.' using errcode='40001';end if;
 old_ref:=p_expected_state->'baseline_ref';
 if not private.awardping_program_exact_object(p_expected_state,array['schema','epoch','status','baseline_ref','latest_ref','first_captured_at','last_checked_at','successful_checks'])
  or p_expected_state->>'schema' is distinct from 'awardping.program-text-state.v1'
  or p_expected_state->>'epoch' is distinct from policy_epoch::text or p_expected_state->>'status' is distinct from 'baseline_ready'
  or old_ref is distinct from p_expected_state->'latest_ref'
  or private.awardping_program_text_reference_valid(old_ref) is distinct from true
  or private.awardping_program_fact_known_html_shell(old_ref) is distinct from true
  or old_ref#>>'{source,id}' is distinct from s.id::text or old_ref#>>'{source,shared_award_id}' is distinct from s.shared_award_id::text
  or old_ref#>>'{source,url}' is distinct from s.url or old_ref#>>'{source,title}' is distinct from s.title
  or old_ref#>>'{source,page_type}' is distinct from s.page_type
  or old_ref->>'final_url' is distinct from s.url
  or not coalesce(jsonb_typeof(p_expected_state->'successful_checks')='number' and p_expected_state->>'successful_checks' ~ '^[1-9][0-9]*$'
   and (p_expected_state->>'successful_checks')::numeric<=2147483647,false)
  or coalesce(p_expected_state->>'first_captured_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  or coalesce(p_expected_state->>'last_checked_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  or (p_expected_state->>'first_captured_at')::timestamptz>(old_ref->>'captured_at')::timestamptz
  or (old_ref->>'captured_at')::timestamptz>(p_expected_state->>'last_checked_at')::timestamptz
 then raise exception 'Only the original exact known loading-only baseline can receive first meaningful coverage.' using errcode='23514';end if;
 observed_at:=(r->>'captured_at')::timestamptz;
 if observed_at<=greatest((old_ref->>'captured_at')::timestamptz,(p_expected_state->>'last_checked_at')::timestamptz)
  or observed_at>clock_timestamp()+interval '5 minutes'
 then raise exception 'A strictly later current meaningful observation is required.' using errcode='23514';end if;
 -- Every unresolved source comparison blocks this operation, including legacy
 -- and failed work. Closed history is preserved, never cleared or superseded.
 if exists(select 1 from public.shared_award_visual_review_candidates candidate
  where candidate.shared_award_source_id=s.id and candidate.status not in ('superseded','rejected','published'))
 then raise exception 'Existing unresolved source review must remain held.' using errcode='23514';end if;
 select jsonb_agg(to_jsonb(roster) order by roster.source_role) into roles from public.program_text_source_roster roster
 where roster.cohort_key='smart' and s.id=any(roster.source_ids)
  and roster.evidence#>>array['source_bindings',s.id::text,'source_url']=s.url
  and roster.evidence#>>array['source_bindings',s.id::text,'shared_award_id']=s.shared_award_id::text;
 if roles is null then raise exception 'The exact reviewed current SMART source role is required.' using errcode='23514';end if;
 insert into public.program_text_smart_initial_coverage_journal(id,source_id,epoch,policy,source_identity,source_role_authority,
  previous_state,next_state,document,document_hash,actor,reason)
 values(journal_id,s.id,policy_epoch,p_policy,identity,roles,p_expected_state,p_next_state,p_document,document_hash,'worker:program-text-v1',p_reason);
 update public.shared_award_sources set text_monitoring_state=p_next_state,last_checked_at=observed_at,next_check_at=observed_at+interval '1 day'
 where id=s.id and text_monitoring_state=p_expected_state;
 get diagnostics changed=row_count;
 if changed<>1 then raise exception 'Exact SMART source CAS failed after journaling.' using errcode='40001';end if;
 return jsonb_build_object('applied',true,'journal_id',journal_id,'state',p_next_state,'initial_coverage',true,'creates_update',false,'idempotent',false);
end;
$$;
revoke all on function public.transition_known_smart_html_shell(uuid,jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.transition_known_smart_html_shell(uuid,jsonb,jsonb,jsonb,text,text) to service_role;

notify pgrst,'reload schema';
