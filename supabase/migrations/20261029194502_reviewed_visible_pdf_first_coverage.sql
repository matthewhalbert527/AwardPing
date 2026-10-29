-- Service-only admission of an independently reviewed projection of an exact
-- retained PDF. Applying schema admits no profile and changes no source state.
create table public.program_text_reviewed_pdf_profiles (
 id uuid primary key default gen_random_uuid(),source_id uuid not null references public.shared_award_sources(id) on delete restrict,
 epoch uuid not null references public.program_text_source_authority_epochs(epoch) on delete restrict,
 profile_sha256 text not null check(profile_sha256 ~ '^[a-f0-9]{64}$'),
 source_identity jsonb not null,source_authority jsonb not null,reference jsonb not null,
 document jsonb not null,provenance jsonb not null,review_receipt jsonb not null,
 reason text not null check(length(btrim(reason)) between 20 and 2000),created_at timestamptz not null default clock_timestamp(),
 unique(source_id,epoch,profile_sha256)
);
create table public.program_text_reviewed_pdf_initial_journal (
 id uuid primary key default gen_random_uuid(),profile_id uuid not null references public.program_text_reviewed_pdf_profiles(id) on delete restrict,
 source_id uuid not null references public.shared_award_sources(id) on delete restrict,
 epoch uuid not null references public.program_text_source_authority_epochs(epoch) on delete restrict,
 policy text not null check(policy='awardping.reviewed-visible-pdf-initial-coverage.v1'),
 source_identity jsonb not null,source_authority jsonb not null,previous_source jsonb not null,
 previous_state jsonb not null,next_state jsonb not null,document jsonb not null,collection_failures jsonb not null,
 actor text not null check(actor='worker:program-text-v1'),reason text not null check(length(btrim(reason)) between 20 and 2000),
 created_at timestamptz not null default clock_timestamp(),unique(source_id,epoch)
);
alter table public.program_text_reviewed_pdf_profiles enable row level security;
alter table public.program_text_reviewed_pdf_initial_journal enable row level security;
revoke all on public.program_text_reviewed_pdf_profiles,public.program_text_reviewed_pdf_initial_journal from public,anon,authenticated,service_role;
grant select on public.program_text_reviewed_pdf_profiles,public.program_text_reviewed_pdf_initial_journal to service_role;
create function private.awardping_reject_reviewed_pdf_history_mutation()
returns trigger language plpgsql set search_path='' as $$begin
 raise exception 'Reviewed PDF admission and original first-coverage history are immutable.' using errcode='42501';
end $$;
revoke all on function private.awardping_reject_reviewed_pdf_history_mutation() from public,anon,authenticated,service_role;
create trigger reviewed_pdf_profile_no_mutation before update or delete on public.program_text_reviewed_pdf_profiles for each row execute function private.awardping_reject_reviewed_pdf_history_mutation();
create trigger reviewed_pdf_profile_no_truncate before truncate on public.program_text_reviewed_pdf_profiles for each statement execute function private.awardping_reject_reviewed_pdf_history_mutation();
create trigger reviewed_pdf_initial_no_mutation before update or delete on public.program_text_reviewed_pdf_initial_journal for each row execute function private.awardping_reject_reviewed_pdf_history_mutation();
create trigger reviewed_pdf_initial_no_truncate before truncate on public.program_text_reviewed_pdf_initial_journal for each statement execute function private.awardping_reject_reviewed_pdf_history_mutation();

-- Preserve the exact legacy validator, including all SMART/HTML guards. Either
-- reserved extractor half activates the additional immutable-profile gate.
do $guard$
declare actual text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex') into strict actual
 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 where n.nspname='private' and p.proname='awardping_program_text_reference_valid';
 if actual is distinct from 'c28403ba7a4424c89442bcb59f70081240b60dceca6b7a250928e6a5dbd40a30'
 then raise exception 'Reference validator preimage changed; review again.' using errcode='40001';end if;
 alter function private.awardping_program_text_reference_valid(jsonb) rename to awardping_program_text_reference_before_reviewed_pdf;
end $guard$;
create function private.awardping_program_text_reference_valid(p_ref jsonb)
returns boolean language plpgsql stable security invoker set search_path='' as $$
begin
 if private.awardping_program_text_reference_before_reviewed_pdf(p_ref) is distinct from true then return false;end if;
 if p_ref#>>'{extractor,name}'='reviewed-visible-pdf-text' or p_ref#>>'{extractor,version}' like 'reviewed-visible-pdf-v1/%' then
  return exists(select 1 from public.program_text_reviewed_pdf_profiles p where
   p_ref->'source'=p.source_identity and p_ref->>'acquisition'='pdf_text'
   and p_ref->>'final_url'=p.source_identity->>'url'
   and p_ref->'extractor'=p.reference->'extractor'
   and p_ref->>'text_sha256'=p.reference->>'text_sha256'
   and p_ref->'text_length'=p.reference->'text_length'
   and p_ref->>'blocks_sha256'=p.reference->>'blocks_sha256'
   and (p_ref#>'{artifacts,raw}')-array['object_key']=(p.reference#>'{artifacts,raw}')-array['object_key']
   and (p_ref#>'{artifacts,text}')-array['object_key']=(p.reference#>'{artifacts,text}')-array['object_key']);
 end if;
 return true;
exception when others then return false;
end $$;
revoke all on function private.awardping_program_text_reference_valid(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_text_reference_valid(jsonb) to service_role;

-- These four otherwise unchanged legacy callers transitively read the new
-- ledger. Preserve their exact bodies and ACLs, correcting volatility only.
do $volatility$
declare item jsonb;p record;
begin
 for item in select value from jsonb_array_elements('[
 {"name":"awardping_program_quote_id_recovery_projection","args":"jsonb","hash":"f5fa556ef263fadebb0ce215062b39513355d4f93818ce5b85ce18b732c94d11"},
 {"name":"awardping_program_smart_twelve_body_link_valid","args":"jsonb,jsonb,jsonb","hash":"f979e40a8c23b7eafa35289ea78def7f3d3211acdb9352bb426eca750f141586"},
 {"name":"awardping_program_source_approval_document_valid","args":"jsonb","hash":"28d177e66a6a3f54bdaa19926d5377c3d04eeec266cbbce01ec24bd189d118a6"},
 {"name":"awardping_variation_provider_document_valid","args":"jsonb","hash":"d4e80496da7ee86ab768962e31c3d6cc87c94306be7e75ade5e290565eac40df"}]'::jsonb) loop
  select proc.prosrc,proc.provolatile into strict p from pg_catalog.pg_proc proc join pg_catalog.pg_namespace ns on ns.oid=proc.pronamespace
  where ns.nspname='private' and proc.proname=item->>'name';
  if p.provolatile<>'i' or encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex') is distinct from item->>'hash'
  then raise exception 'Legacy validator volatility/body preimage changed.' using errcode='40001';end if;
  execute 'alter function private.'||quote_ident(item->>'name')||'('||(item->>'args')||') stable';
 end loop;
end $volatility$;

create function private.awardping_reviewed_pdf_source_authority(p_source_id uuid,p_epoch uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare s public.shared_award_sources%rowtype;cohort text;roles jsonb;
begin
 select * into strict s from public.shared_award_sources where id=p_source_id;
 select distinct r.cohort_key into strict cohort from public.stage1_award_registry r
 join public.stage1_award_members m on m.cohort_key=r.cohort_key and m.shared_award_id=s.shared_award_id
 join public.program_text_source_roster roster on roster.cohort_key=r.cohort_key and s.id=any(roster.source_ids);
 if not exists(select 1 from public.program_text_source_authority_epochs where epoch=p_epoch and active)
  or not private.awardping_program_text_source_access(s.id,cohort,p_epoch)
  or s.page_type<>'pdf' or s.admin_review_status<>'open'
  or not exists(select 1 from public.shared_awards a where a.id=s.shared_award_id and a.status='active')
  or exists(select 1 from public.stage1_award_source_identity_rules x where x.cohort_key=cohort and
   ((x.url_pattern is not null and s.url ~* x.url_pattern) or (x.title_pattern is not null and concat_ws(' ',s.title,s.display_title) ~* x.title_pattern)))
 then raise exception 'Current reviewed PDF ownership and text authority required.' using errcode='23514';end if;
 select jsonb_agg(to_jsonb(r) order by source_role) into roles from public.program_text_source_roster r
 where r.cohort_key=cohort and s.id=any(r.source_ids) and r.manifest_status='reviewed_text'
 and r.evidence#>>array['source_bindings',s.id::text,'source_url']=s.url
 and r.evidence#>>array['source_bindings',s.id::text,'shared_award_id']=s.shared_award_id::text;
 if roles is null then raise exception 'Exact reviewed PDF role binding is missing.' using errcode='23514';end if;
 return jsonb_build_object('source',jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type),
  'cohort_key',cohort,'epoch',p_epoch,'roles',roles,'approval',private.awardping_program_text_source_approval_dto(s.id));
end $$;
revoke all on function private.awardping_reviewed_pdf_source_authority(uuid,uuid) from public,anon,authenticated;
grant execute on function private.awardping_reviewed_pdf_source_authority(uuid,uuid) to service_role;

-- Full exact text, canonical blocks and truthful page-level provenance are
-- checked before service admission. The service also cold-replays original PDF
-- bytes and the packaged projection; SQL does not claim to visually read a PDF.
create function private.awardping_reviewed_pdf_document_valid(p_document jsonb)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare r jsonb:=p_document->'reference';v jsonb:=p_document->'reviewed_pdf';p jsonb;b jsonb;page_count integer;cursor_at integer:=0;page_no integer:=0;
begin
 if (not private.awardping_program_exact_object(p_document,array['reference','text','blocks','blocks_json','reviewed_pdf'])
 or octet_length(p_document::text)>33554432
 or private.awardping_program_text_reference_before_reviewed_pdf(r) is distinct from true
 or r->>'acquisition'<>'pdf_text' or r#>>'{extractor,name}'<>'reviewed-visible-pdf-text'
 or r#>>'{extractor,version}' is distinct from 'reviewed-visible-pdf-v1/'||(v->>'profile_sha256')
 or r->>'final_url' is distinct from r#>>'{source,url}'
 or not private.awardping_program_exact_object(v,array['schema','profile_sha256','source','raw','review','source_limitations','pages','projected_text_sha256','projected_blocks_sha256','completeness_scope','hidden_or_unreadable_source_values_inferred'])
 or v->>'schema'<>'awardping.reviewed-visible-pdf-provenance.v1' or coalesce(v->>'profile_sha256','') !~ '^[a-f0-9]{64}$'
 or v->'source' is distinct from r->'source' or v#>>'{raw,sha256}' is distinct from r#>>'{artifacts,raw,sha256}'
 or v#>'{raw,byte_length}' is distinct from r#>'{artifacts,raw,byte_length}'
 or not private.awardping_program_exact_object(v->'raw',array['sha256','byte_length','physical_pages'])
 or coalesce(v#>>'{raw,physical_pages}','') !~ '^[1-9][0-9]*$'
 or (v#>>'{raw,physical_pages}')::integer not between 1 and 100
 or v#>>'{review,method}'<>'independent_agent_visible_transcription'
 or v#>'{review,native_extraction_claimed}' is distinct from 'false'::jsonb
 or v#>'{review,ocr_engine_verification_claimed}' is distinct from 'false'::jsonb
 or v#>'{review,human_certification_claimed}' is distinct from 'false'::jsonb
 or v#>'{review,source_byte_verbatim}' is distinct from 'false'::jsonb
 or coalesce(v#>>'{review,primary_review_sha256}','') !~ '^[a-f0-9]{64}$'
 or coalesce(v#>>'{review,independent_review_sha256}','') !~ '^[a-f0-9]{64}$'
 or coalesce(v#>>'{review,original_bindings_sha256}','') !~ '^[a-f0-9]{64}$'
 or v->>'completeness_scope'<>'all_legible_visible_static_text_of_exact_original'
 or v->'hidden_or_unreadable_source_values_inferred' is distinct from 'false'::jsonb
 or jsonb_typeof(v->'source_limitations') is distinct from 'array' or jsonb_typeof(v->'pages') is distinct from 'array'
 or jsonb_typeof(p_document->'text') is distinct from 'string'
 or private.awardping_program_utf16_length(p_document->>'text')<>(r->>'text_length')::integer
 or octet_length(p_document->>'text')<>(r#>>'{artifacts,text,byte_length}')::integer
 or encode(extensions.digest(convert_to(p_document->>'text','UTF8'),'sha256'),'hex') is distinct from r->>'text_sha256'
 or v->>'projected_text_sha256' is distinct from r->>'text_sha256'
 or v->>'projected_blocks_sha256' is distinct from r->>'blocks_sha256'
 or jsonb_typeof(p_document->'blocks') is distinct from 'array' or jsonb_array_length(p_document->'blocks') not between 1 and 20000
 or jsonb_typeof(p_document->'blocks_json') is distinct from 'string'
 or (p_document->>'blocks_json')::jsonb is distinct from p_document->'blocks'
 or encode(extensions.digest(convert_to(p_document->>'blocks_json','UTF8'),'sha256'),'hex') is distinct from r->>'blocks_sha256'
 or (select count(distinct value->>'id') from jsonb_array_elements(p_document->'blocks'))<>jsonb_array_length(p_document->'blocks')
 ) is distinct from false then return false;end if;
 page_count:=(v#>>'{raw,physical_pages}')::integer;
 if jsonb_array_length(v->'pages')<>page_count then return false;end if;
 for p in select value from jsonb_array_elements(v->'pages') loop
  page_no:=page_no+1;
  if (not private.awardping_program_exact_object(p,array['page','original_render_sha256','reviewed_transcript_sha256','projected_text_sha256','lines'])
   or p->>'page'<>page_no::text or coalesce(p->>'lines','') !~ '^[1-9][0-9]*$'
   or coalesce(p->>'original_render_sha256','') !~ '^[a-f0-9]{64}$'
   or coalesce(p->>'reviewed_transcript_sha256','') !~ '^[a-f0-9]{64}$'
   or coalesce(p->>'projected_text_sha256','') !~ '^[a-f0-9]{64}$'
   or (select count(*) from jsonb_array_elements(p_document->'blocks') block where block->>'page'=page_no::text)<>(p->>'lines')::integer
   ) is distinct from false then return false;end if;
 end loop;
 for b in select value from jsonb_array_elements(p_document->'blocks') loop
  if (not private.awardping_program_exact_object(b,array['id','text','start_utf16','end_utf16','page','kind','context'])
   or jsonb_typeof(b->'text') is distinct from 'string' or length(btrim(b->>'text'))=0
   or coalesce(b->>'id','') !~ '^reviewed-pdf-p[0-9]{3}-l[0-9]{3}$' or b->>'kind'<>'reviewed_pdf_text'
   or b#>>'{context,representation}'<>'reviewed_visible_pdf_text'
   or b#>>'{context,method}'<>'independent_agent_visible_transcription'
   or b#>>'{context,profile_sha256}' is distinct from v->>'profile_sha256'
   or coalesce(b->>'page','') !~ '^[1-9][0-9]*$' or (b->>'page')::integer not between 1 and page_count
   or b#>>'{context,original_render_sha256}' is distinct from v#>>array['pages',((b->>'page')::integer-1)::text,'original_render_sha256']
   or b#>>'{context,reviewed_transcript_sha256}' is distinct from v#>>array['pages',((b->>'page')::integer-1)::text,'reviewed_transcript_sha256']
   or coalesce(b->>'start_utf16','') !~ '^[0-9]+$' or coalesce(b->>'end_utf16','') !~ '^[1-9][0-9]*$'
   or (b->>'start_utf16')::integer<cursor_at
   or private.awardping_program_utf16_slice(p_document->>'text',(b->>'start_utf16')::integer,(b->>'end_utf16')::integer) is distinct from b->>'text'
  ) is distinct from false then return false;end if;
  cursor_at:=(b->>'end_utf16')::integer;
 end loop;
 return cursor_at=(r->>'text_length')::integer;
exception when others then return false;
end $$;
revoke all on function private.awardping_reviewed_pdf_document_valid(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_reviewed_pdf_document_valid(jsonb) to service_role;

create function public.admit_reviewed_visible_pdf_profile(p_source_id uuid,p_epoch uuid,p_document jsonb,p_review_receipt jsonb,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb;v jsonb:=p_document->'reviewed_pdf';r jsonb:=p_document->'reference';prior public.program_text_reviewed_pdf_profiles%rowtype;profile_id uuid:=gen_random_uuid();
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform 1 from public.shared_award_sources where id=p_source_id for share nowait;
 perform 1 from public.program_text_source_authority_epochs where epoch=p_epoch and active for share nowait;
 perform 1 from public.program_text_source_roster where p_source_id=any(source_ids) for share nowait;
 authority:=private.awardping_reviewed_pdf_source_authority(p_source_id,p_epoch);
 if private.awardping_reviewed_pdf_document_valid(p_document) is distinct from true
  or r->'source' is distinct from authority->'source' or length(btrim(coalesce(p_reason,''))) not between 20 and 2000
  or not private.awardping_program_exact_object(p_review_receipt,array['schema','reviewer','root_review_sha256','independent_review_sha256','profile_sha256','reviewed_at'])
  or p_review_receipt->>'schema'<>'awardping.reviewed-visible-pdf-admission-review.v1'
  or p_review_receipt->>'reviewer'<>'codex_operator:independent_visible_pdf_review'
  or coalesce(p_review_receipt->>'root_review_sha256','') !~ '^[a-f0-9]{64}$'
  or p_review_receipt->>'independent_review_sha256' is distinct from v#>>'{review,independent_review_sha256}'
  or p_review_receipt->>'profile_sha256' is distinct from v->>'profile_sha256'
  or coalesce(p_review_receipt->>'reviewed_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  or (p_review_receipt->>'reviewed_at')::timestamptz>clock_timestamp()+interval '5 minutes'
 then raise exception 'Exact reviewed original, full projection and independent review receipt required.' using errcode='23514';end if;
 select * into prior from public.program_text_reviewed_pdf_profiles where source_id=p_source_id and epoch=p_epoch and profile_sha256=v->>'profile_sha256';
 if found then
  if prior.document is distinct from p_document or prior.review_receipt is distinct from p_review_receipt or prior.reason<>p_reason
   or prior.source_authority is distinct from authority then raise exception 'A different immutable profile admission already exists.' using errcode='40001';end if;
  return jsonb_build_object('admitted',true,'profile_id',prior.id,'already_admitted',true);
 end if;
 insert into public.program_text_reviewed_pdf_profiles(id,source_id,epoch,profile_sha256,source_identity,source_authority,reference,document,provenance,review_receipt,reason)
 values(profile_id,p_source_id,p_epoch,v->>'profile_sha256',r->'source',authority,r,p_document,v,p_review_receipt,p_reason);
 return jsonb_build_object('admitted',true,'profile_id',profile_id,'already_admitted',false);
end $$;
revoke all on function public.admit_reviewed_visible_pdf_profile(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.admit_reviewed_visible_pdf_profile(uuid,uuid,jsonb,jsonb,text) to service_role;

create function public.transition_reviewed_pdf_first_coverage(p_source_id uuid,p_expected_state jsonb,p_next_state jsonb,p_document jsonb,p_policy text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.shared_award_sources%rowtype;profile public.program_text_reviewed_pdf_profiles%rowtype;prior public.program_text_reviewed_pdf_initial_journal%rowtype;
 r jsonb:=p_document->'reference';old_ref jsonb:=p_expected_state->'baseline_ref';authority jsonb;expected_next jsonb;failures jsonb;
 active_epoch uuid;observed_at timestamptz;changed integer;journal_id uuid:=gen_random_uuid();
begin
 if p_source_id is null or p_policy is distinct from 'awardping.reviewed-visible-pdf-initial-coverage.v1'
 or length(btrim(coalesce(p_reason,''))) not between 20 and 2000 then raise exception 'Reviewed PDF first-coverage policy required.' using errcode='23514';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select epoch into strict active_epoch from public.program_text_source_authority_epochs where active for share nowait;
 select * into strict s from public.shared_award_sources where id=p_source_id for update nowait;
 perform 1 from public.program_text_source_roster where p_source_id=any(source_ids) for share nowait;
 authority:=private.awardping_reviewed_pdf_source_authority(p_source_id,active_epoch);
 select * into strict profile from public.program_text_reviewed_pdf_profiles where source_id=p_source_id and epoch=active_epoch
  and profile_sha256=p_document#>>'{reviewed_pdf,profile_sha256}' for share nowait;
 if profile.source_authority is distinct from authority or profile.provenance is distinct from p_document->'reviewed_pdf'
 or private.awardping_reviewed_pdf_document_valid(p_document) is distinct from true
 or private.awardping_program_text_reference_valid(r) is distinct from true
 or r->'source' is distinct from authority->'source'
 or profile.document->'text' is distinct from p_document->'text' or profile.document->'blocks' is distinct from p_document->'blocks'
 or profile.document->'blocks_json' is distinct from p_document->'blocks_json'
 then raise exception 'Current authority and immutable exact reviewed PDF projection required.' using errcode='23514';end if;
 expected_next:=jsonb_build_object('schema','awardping.program-text-state.v1','epoch',active_epoch,'status','baseline_ready','baseline_ref',r,'latest_ref',r,
  'last_checked_at',r->>'captured_at','first_captured_at',r->>'captured_at','successful_checks',1);
 if p_next_state is distinct from expected_next then raise exception 'Exactly one silent initial capture and an independent repeat are required.' using errcode='23514';end if;
 select * into prior from public.program_text_reviewed_pdf_initial_journal where source_id=p_source_id and epoch=active_epoch;
 if found then
  if prior.previous_state is distinct from p_expected_state or prior.next_state is distinct from p_next_state or prior.document is distinct from p_document
  or prior.policy<>p_policy or prior.reason<>p_reason or s.text_monitoring_state is distinct from prior.next_state
  then raise exception 'Original PDF initial coverage already exists or source advanced.' using errcode='40001';end if;
  return jsonb_build_object('applied',true,'journal_id',prior.id,'state',prior.next_state,'initial_coverage',true,'creates_update',false,'idempotent',true);
 end if;
 if s.text_monitoring_state is distinct from p_expected_state then raise exception 'Exact PDF source state changed.' using errcode='40001';end if;
 if not private.awardping_program_exact_object(p_expected_state,array['schema','epoch','status','baseline_ref','latest_ref','first_captured_at','last_checked_at','successful_checks'])
 or p_expected_state->>'schema'<>'awardping.program-text-state.v1' or p_expected_state->>'epoch'<>active_epoch::text
 or p_expected_state->>'status'<>'baseline_ready' or old_ref is distinct from p_expected_state->'latest_ref'
 or private.awardping_program_text_reference_valid(old_ref) is distinct from true
 or private.awardping_program_fact_known_footer_only_pdf(old_ref) is distinct from true
 or old_ref->'source' is distinct from r->'source' or old_ref->>'final_url' is distinct from r->>'final_url'
 or old_ref#>>'{artifacts,raw,sha256}' is distinct from r#>>'{artifacts,raw,sha256}'
 or old_ref#>'{artifacts,raw,byte_length}' is distinct from r#>'{artifacts,raw,byte_length}'
 or coalesce(p_expected_state->>'successful_checks','') !~ '^[1-9][0-9]*$'
 or (p_expected_state->>'successful_checks')::numeric>2147483647
 or (p_expected_state->>'first_captured_at')::timestamptz>(old_ref->>'captured_at')::timestamptz
 or (old_ref->>'captured_at')::timestamptz>(p_expected_state->>'last_checked_at')::timestamptz
 then raise exception 'Only the exact retained known-footer baseline of the same PDF may transition.' using errcode='23514';end if;
 observed_at:=(r->>'captured_at')::timestamptz;
 if observed_at<=greatest((old_ref->>'captured_at')::timestamptz,(p_expected_state->>'last_checked_at')::timestamptz)
 or observed_at>clock_timestamp()+interval '5 minutes' then raise exception 'A later complete retained capture is required.' using errcode='23514';end if;
 -- No legacy, failed or closed comparison can be silently superseded here.
 if exists(select 1 from public.shared_award_visual_review_candidates c where c.shared_award_source_id=s.id)
 then raise exception 'Any existing comparison prevents this first-coverage operation.' using errcode='23514';end if;
 select coalesce(jsonb_agg(to_jsonb(f) order by attempt_number),'[]') into failures from public.program_text_collection_failures f where f.source_id=s.id;
 insert into public.program_text_reviewed_pdf_initial_journal(id,profile_id,source_id,epoch,policy,source_identity,source_authority,previous_source,previous_state,next_state,document,collection_failures,actor,reason)
 values(journal_id,profile.id,s.id,active_epoch,p_policy,authority->'source',authority,to_jsonb(s),p_expected_state,p_next_state,p_document,failures,'worker:program-text-v1',p_reason);
 update public.shared_award_sources set text_monitoring_state=p_next_state,last_checked_at=observed_at,next_check_at=observed_at+interval '1 day'
 where id=s.id and text_monitoring_state=p_expected_state;
 get diagnostics changed=row_count;
 if changed<>1 then raise exception 'Exact PDF first-coverage CAS failed.' using errcode='40001';end if;
 return jsonb_build_object('applied',true,'journal_id',journal_id,'state',p_next_state,'initial_coverage',true,'creates_update',false,'idempotent',false);
end $$;
revoke all on function public.transition_reviewed_pdf_first_coverage(uuid,jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.transition_reviewed_pdf_first_coverage(uuid,jsonb,jsonb,jsonb,text,text) to service_role;
notify pgrst,'reload schema';
