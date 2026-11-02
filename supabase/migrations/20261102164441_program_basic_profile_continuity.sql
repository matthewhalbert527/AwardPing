-- PRIVATE PROPOSAL. Root must create/review the migration and run the rollback
-- rehearsal. No captures, review decisions, facts, heads or spend rows change.
-- A tiny immutable receipt preserves one approved basic head after an ordinary
-- recurrence of seven already-reviewed ancillary source profiles.

create table private.program_basic_continuity_observations (
 id uuid primary key default gen_random_uuid(),
 cohort_key text not null,
 source_id uuid not null references public.shared_award_sources(id),
 epoch uuid not null,
 expected_head uuid not null references public.program_basic_fact_snapshots(id),
 current_capture_id text not null,
 receipt jsonb not null check(octet_length(receipt::text)<=65536),
 content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 unique(expected_head,source_id,current_capture_id)
);
alter table private.program_basic_continuity_observations enable row level security;
revoke all on private.program_basic_continuity_observations from public,anon,authenticated,service_role;
create trigger basic_continuity_immutable before update or delete on private.program_basic_continuity_observations
 for each row execute function private.awardping_basic_repeat_immutable();
create trigger basic_continuity_no_truncate before truncate on private.program_basic_continuity_observations
 for each statement execute function private.awardping_basic_repeat_immutable();

create table private.program_basic_continuity_policy (
 id boolean primary key default true check(id),
 pins jsonb not null,
 content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$')
);
alter table private.program_basic_continuity_policy enable row level security;
revoke all on private.program_basic_continuity_policy from public,anon,authenticated,service_role;
create trigger basic_continuity_policy_immutable before update or delete on private.program_basic_continuity_policy
 for each row execute function private.awardping_basic_repeat_immutable();
create trigger basic_continuity_policy_no_truncate before truncate on private.program_basic_continuity_policy
 for each statement execute function private.awardping_basic_repeat_immutable();

create function private.awardping_basic_continuity_profile(p_source uuid) returns jsonb
language sql immutable set search_path='' as $profiles$
 select jsonb_build_object('source_id',id,'cohort_key',cohort,'owner_id',owner,'url',url,'profile',profile,'form_action',action)
 from (values
 ('56aa30ee-164e-489a-ae5c-f2902dbb0db5'::uuid,'daad_study','440d6985-ece9-48c4-ac30-65a739f60d65','https://www.daad.org/en/find-funding/scholarship-database/?type=a&q=&status=0&subject=0&onlydaad=1&detail_to_show=0&target=44&origin=44&pg=1&detail_to_show=50026200','daad_sponsored_university_carousel.v1',null),
 ('88906939-65e7-492d-a671-da56678dfecd'::uuid,'daad_study','440d6985-ece9-48c4-ac30-65a739f60d65','https://www.daad.org/en/find-funding/scholarship-database/?origin=44&status=3&type=a&q=&onlydaad=1&language=en&detail_to_show=50026200&tab=','daad_sponsored_university_carousel.v1',null),
 ('8d654c9d-e572-4488-94a3-e4238e7b1155'::uuid,'daad_study','440d6985-ece9-48c4-ac30-65a739f60d65','https://www.daad.org/en/find-funding/country-specific-information-for-us-applicants/','daad_sponsored_university_carousel.v1',null),
 ('f322a07c-f78c-47fd-aafb-ab6422a4248f'::uuid,'schwarzman','dd23afbb-299e-489f-8a0b-e4d7506848de','https://www.schwarzmanscholars.org/admissions/application-instructions/','hidden_gravityforms_honeypot_label','/admissions/application-instructions/#gf_5'),
 ('434c57c2-4f87-4c5e-bc88-24cb59f4b1e7'::uuid,'schwarzman','19135163-d9dd-4fc2-b2ae-7d0bb8449735','https://www.schwarzmanscholars.org/admissions/','hidden_gravityforms_honeypot_label','/admissions/#gf_5'),
 ('db04bc7a-d0fd-40a5-8922-30921b02a7e2'::uuid,'schwarzman','dd23afbb-299e-489f-8a0b-e4d7506848de','https://www.schwarzmanscholars.org/admissions/','hidden_gravityforms_honeypot_label','/admissions/#gf_5'),
 ('5bf1f780-ffc1-49e1-88d7-7da3ebd943cf'::uuid,'schwarzman','19135163-d9dd-4fc2-b2ae-7d0bb8449735','https://www.schwarzmanscholars.org/','hidden_gravityforms_honeypot_label','/#gf_5')
 ) p(id,cohort,owner,url,profile,action) where id=p_source;
$profiles$;

-- A small authority seal deliberately excludes observation clocks and sibling
-- captures. Every live source still passes the existing quality/access checks.
create function private.awardping_basic_continuity_authority(p_source uuid,p_cohort text,p_epoch uuid) returns jsonb
language sql stable set search_path='' as $authority$
 select jsonb_build_object('registry',(select jsonb_build_object('cohort_key',r.cohort_key,'canonical_shared_award_id',r.canonical_shared_award_id) from public.stage1_award_registry r where r.cohort_key=p_cohort),
 'epoch',p_epoch,'members',(select jsonb_agg(m.shared_award_id order by m.shared_award_id) from public.stage1_award_members m where m.cohort_key=p_cohort),
 'roles',(select jsonb_agg(jsonb_build_object('source_role',r.source_role,'revision',r.revision,'source_ids',r.source_ids,'manifest_status',r.manifest_status,'evidence',r.evidence) order by r.source_role) from public.program_text_source_roster r where r.cohort_key=p_cohort),
 'source',jsonb_build_object('id',s.id,'owner_id',s.shared_award_id,'url',s.url,'admin_review_status',s.admin_review_status,
 'approvals',private.awardping_program_text_source_approval_dto(s.id),'canonical_url_admission',private.awardping_program_text_canonical_url_admission(s.id,p_epoch)))
 from public.shared_award_sources s where s.id=p_source;
$authority$;

-- A prior observation supplies an independent retained capture only. Never
-- follow chains: its direct ordinary terminal comparison must still be sealed.
create function private.awardping_basic_continuity_basis_valid(b jsonb,p_head uuid,p_source uuid,p_epoch uuid,p_anchor jsonb,p_current jsonb) returns boolean
language plpgsql stable set search_path='' as $basis$
declare o private.program_basic_continuity_observations%rowtype;r jsonb;c jsonb;row_versions jsonb;
begin
 if private.awardping_program_exact_object(b,array['observation_id','content_hash','repeat_ref']) is distinct from true then return false;end if;
 select * into strict o from private.program_basic_continuity_observations where id=(b->>'observation_id')::uuid;r:=o.receipt;
 select jsonb_build_object('snapshot_xmin',x.xmin::text,'snapshot_ctid',x.ctid::text,'draft_xmin',d.xmin::text,'draft_ctid',d.ctid::text) into strict row_versions
 from public.program_basic_fact_snapshots x join public.program_text_fact_reviews d on d.id=x.input_review_id where x.id=p_head;
 if o.expected_head is distinct from p_head or o.source_id is distinct from p_source or o.epoch is distinct from p_epoch
  or o.content_hash is distinct from b->>'content_hash' or o.content_hash is distinct from private.awardping_reviewed_repeat_hash(r)
  or r->>'kind' not in('ordinary_no_program_change','ordinary_zero_packet_no_change') or r->>'actor' is distinct from 'system:program-text:basic-continuity'
  or r->'current_ref' is distinct from b->'repeat_ref' or r->'anchor_ref' is distinct from p_anchor
  or r->'basis_row_versions' is distinct from row_versions
  or r->>'authority_hash' is distinct from private.awardping_reviewed_repeat_hash(private.awardping_basic_continuity_authority(p_source,o.cohort_key,p_epoch))
  or private.awardping_basic_content_identity(r->'current_ref') is distinct from private.awardping_basic_content_identity(p_current)
  or not coalesce((r#>>'{current_ref,captured_at}')::timestamptz<(p_current->>'captured_at')::timestamptz,false) then return false;end if;
 c:=private.awardping_reviewed_repeat_candidate((r->>'candidate_id')::uuid);
 return coalesce(private.awardping_reviewed_repeat_hash(c)=r->>'candidate_hash'
  and private.awardping_reviewed_repeat_hash(private.awardping_reviewed_repeat_paid(c))=r->>'paid_hash'
  and c->>'status'='rejected' and c->>'rejection_reason'='no_program_change' and c->'new_snapshot_ref'=r->'current_ref' and c->'previous_snapshot_ref'=r->'previous_ref',false);
exception when others then return false;end;
$basis$;

-- Return the exact accepted head and original review, even while the old source
-- versions are stale. This is NOT an approval or a latest-capture fact draft.
create function public.inspect_program_basic_continuity(p_source_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $inspect$
declare profile jsonb;packet jsonb;x public.program_basic_fact_snapshots%rowtype;d public.program_text_fact_reviews%rowtype;
 s public.shared_award_sources%rowtype;v jsonb;a jsonb;c jsonb;cid uuid;n integer;repeat_ref jsonb;unchanged_basis jsonb;prior private.program_basic_continuity_observations%rowtype;
begin
 profile:=private.awardping_basic_continuity_profile(p_source_id);
 if profile is null then return jsonb_build_object('schema','awardping.program-basic-continuity-inspection.v1','status','skipped','source_id',p_source_id,'reason','outside_reviewed_profiles');end if;
 select * into strict s from public.shared_award_sources where id=p_source_id;
 select z.* into strict x from public.program_basic_fact_heads h join public.program_basic_fact_snapshots z on z.id=h.snapshot_id where h.cohort_key=profile->>'cohort_key';
 select * into strict d from public.program_text_fact_reviews where id=x.input_review_id;
 select value into strict v from jsonb_array_elements(x.source_versions) where value->>'source_id'=s.id::text;
 select value into strict a from jsonb_array_elements(x.receipt->'current_capture_refs') where value#>>'{source,id}'=s.id::text;
 if x.receipt->>'schema' is distinct from 'awardping.current-basic-award-fact-review.v1'
  or x.content_hash is distinct from private.awardping_reviewed_repeat_hash(x.receipt)
  or d.content_hash is distinct from x.input_review_hash or d.content_hash is distinct from encode(extensions.digest(convert_to(d.validation::text,'UTF8'),'sha256'),'hex')
  or x.public_facts is distinct from x.receipt->'public_facts'
  or x.public_facts is distinct from private.awardping_basic_fact_selection(d.validation,x.receipt->'selected_fields')
  or s.shared_award_id::text is distinct from profile->>'owner_id' or s.url is distinct from profile->>'url'
  or v->>'owner_id' is distinct from profile->>'owner_id' or v->>'url' is distinct from profile->>'url'
  or v->'pending_alert_review_id' is distinct from 'null'::jsonb or v->'pending_alert_review_hash' is distinct from 'null'::jsonb
  or s.text_monitoring_state->>'status' is distinct from 'baseline_ready'
  or private.awardping_current_basic_source_ready(s.id,x.cohort_key,(v->>'epoch')::uuid,s.text_monitoring_state->'latest_ref') is distinct from true
  or private.awardping_basic_content_identity(a) is distinct from v->'content_identity'
  or a#>>'{source,shared_award_id}' is distinct from profile->>'owner_id' or a#>>'{source,url}' is distinct from profile->>'url'
  or a=s.text_monitoring_state->'latest_ref'
 then return jsonb_build_object('schema','awardping.program-basic-continuity-inspection.v1','status','skipped','source_id',p_source_id,'reason','head_or_source_not_eligible');end if;
 if private.awardping_basic_continuity_version_current(x.id,v) then
  return jsonb_build_object('schema','awardping.program-basic-continuity-inspection.v1','status','skipped','source_id',p_source_id,'expected_head',x.id,'current_ref',s.text_monitoring_state->'latest_ref','reason','already_current');end if;
 packet:=public.inspect_current_program_basic_award(x.cohort_key);
 if packet->>'head_id' is distinct from x.id::text or (select jsonb_agg(jsonb_build_object('source_role',r.source_role,'revision',r.revision,'source_ids',r.source_ids) order by r.source_role) from public.program_text_source_roster r where r.cohort_key=x.cohort_key)
  is distinct from (select jsonb_agg(value order by value->>'source_role') from jsonb_array_elements(x.receipt->'roster'))
 then return jsonb_build_object('schema','awardping.program-basic-continuity-inspection.v1','status','skipped','source_id',p_source_id,'reason','roster_changed');end if;
 select count(*),(array_agg(z.id))[1] into n,cid from public.shared_award_visual_review_candidates z
 where z.shared_award_source_id=s.id and z.candidate_scope='program_text_change' and z.worker_metadata->>'epoch'=v->>'epoch' and z.new_snapshot_ref=s.text_monitoring_state->'latest_ref';
 if n>1 then return jsonb_build_object('schema','awardping.program-basic-continuity-inspection.v1','status','skipped','source_id',p_source_id,'reason','ambiguous_current_candidate');end if;
 if n=1 then c:=private.awardping_reviewed_repeat_candidate(cid);
  if c->>'status' is distinct from 'rejected' or c->>'rejection_reason' is distinct from 'no_program_change' then
   return jsonb_build_object('schema','awardping.program-basic-continuity-inspection.v1','status','skipped','source_id',p_source_id,'reason','current_comparison_not_terminal_no_change');end if;
  repeat_ref:=c->'previous_snapshot_ref';
 elsif private.awardping_basic_content_identity(a)=private.awardping_basic_content_identity(s.text_monitoring_state->'latest_ref') then repeat_ref:=a;
 else
  select * into prior from private.program_basic_continuity_observations o where o.expected_head=x.id and o.source_id=s.id and o.epoch=(v->>'epoch')::uuid
   and private.awardping_basic_continuity_basis_valid(jsonb_build_object('observation_id',o.id,'content_hash',o.content_hash,'repeat_ref',o.receipt->'current_ref'),x.id,s.id,(v->>'epoch')::uuid,a,s.text_monitoring_state->'latest_ref')
   order by (o.receipt#>>'{current_ref,captured_at}')::timestamptz desc,o.id limit 1;
  if not found then return jsonb_build_object('schema','awardping.program-basic-continuity-inspection.v1','status','skipped','source_id',p_source_id,'reason','independent_same_content_repeat_not_available');end if;
  repeat_ref:=prior.receipt->'current_ref';unchanged_basis:=jsonb_build_object('observation_id',prior.id,'content_hash',prior.content_hash,'repeat_ref',repeat_ref);
 end if;
 return jsonb_build_object('schema','awardping.program-basic-continuity-inspection.v1','status','ready','cohort_key',x.cohort_key,'source_id',s.id,'epoch',v->'epoch',
 'expected_head',x.id,'snapshot_hash',x.content_hash,'input_review_hash',x.input_review_hash,'source_version',v,'anchor_ref',a,'current_ref',s.text_monitoring_state->'latest_ref',
 'approved_review',d.validation->'review','selected_fields',x.receipt->'selected_fields','context',packet->'context','repeat_ref',repeat_ref,'unchanged_basis',unchanged_basis,'candidate',c,'candidate_hash',case when c is null then null else private.awardping_reviewed_repeat_hash(c) end,
 'paid_reservation',case when c is null then null else private.awardping_reviewed_repeat_paid(c) end);
exception when no_data_found or too_many_rows then return jsonb_build_object('schema','awardping.program-basic-continuity-inspection.v1','status','skipped','source_id',p_source_id,'reason','missing_or_ambiguous_approved_basis');end;
$inspect$;

create function public.list_program_basic_continuity_sources() returns jsonb
language sql stable security definer set search_path='' as $list$
 select jsonb_build_object('schema','awardping.program-basic-continuity-work.v1','sources',coalesce(jsonb_agg(jsonb_build_object('source_id',s.id,'epoch',s.text_monitoring_state->'epoch') order by s.id),'[]'::jsonb))
 from public.shared_award_sources s cross join lateral (select private.awardping_basic_continuity_profile(s.id) p) q
 join public.program_basic_fact_heads h on h.cohort_key=p->>'cohort_key'
 where p is not null and s.text_monitoring_state->>'status'='baseline_ready'
 and s.shared_award_id::text=p->>'owner_id' and s.url=p->>'url'
 and not exists(select 1 from private.program_basic_continuity_observations o where o.source_id=s.id and o.expected_head=h.snapshot_id and o.current_capture_id=s.text_monitoring_state#>>'{latest_ref,capture_id}');
$list$;

-- This private pure adapter accepts equal hidden labels ONLY for the explicit
-- identical-text branch. All existing source/raw marker checks are retained.
do $identity_rules$
declare original text;revised text;
begin
 original:=pg_get_functiondef('private.awardping_reviewed_repeat_rules_valid(jsonb)'::regprocedure);
 if position('or old_m->>''label''=new_m->>''label''' in original)=0 then raise exception 'Continuity rules preimage missing';end if;
 revised:=replace(original,'private.awardping_reviewed_repeat_rules_valid(v jsonb)','private.awardping_basic_continuity_rules_valid(v jsonb)');
 revised:=replace(revised,'or old_m->>''label''=new_m->>''label''','or (old_m->>''label''=new_m->>''label'' and rule->>''change_id'' is distinct from ''identity-marker'')');
 if revised=original or position('private.awardping_basic_continuity_rules_valid' in revised)=0 then raise exception 'Continuity rules replacement failed';end if;
 execute revised;
end;$identity_rules$;

-- The single observed field serialization is intentionally narrow. A different
-- form, moved/visible field, extra input or changed action safely remains held.
create function private.awardping_basic_continuity_wrapper_identity(tag text) returns text
language sql immutable set search_path='' as $wrapper$
 select case when tag ~ '^<div class=''gf_browser_(unknown|chrome) '
  and (select count(*) from regexp_matches(tag,'gf_browser_[A-Za-z0-9_-]+','g'))=1
 then regexp_replace(tag,'^(<div class='')gf_browser_(unknown|chrome)( )',E'\\1gf_browser_OBSERVED\\3') else null end;
$wrapper$;

create function private.awardping_basic_continuity_hidden_valid(m jsonb,d jsonb,r jsonb,p_source uuid) returns boolean
language plpgsql immutable set search_path='' as $hidden$
declare p jsonb:=private.awardping_basic_continuity_profile(p_source);html text;form_html text;tag text;expected text;b jsonb;finish integer;
begin
 if p->>'profile' is distinct from 'hidden_gravityforms_honeypot_label' or m->>'label' not in('Company','Facebook','Instagram','LinkedIn','URL','X/Twitter')
  or private.awardping_reviewed_repeat_raw_valid(d,r) is distinct from true then return false;end if;
 html:=convert_from(decode(r->>'raw_base64','base64'),'UTF8');
 expected:='<li id="field_5_10" class="gfield gfield--type-honeypot gform_validation_container field_sublabel_below gfield--has-description field_description_below field_validation_below gfield_visibility_visible"><label id=''gfield_label_5_10'' class=''gfield_label gform-field-label'' for=''input_5_10''><span class=''gform-field-label__text''>'||(m->>'label')||'</span></label><div class=''ginput_container''><input name=''input_10'' id=''input_5_10'' type=''text'' value='''' autocomplete=''new-password''/></div><div class=''gfield_description'' id=''gfield_description_5_10''>This field is for validation purposes and should be left unchanged.</div></li>';
 if m->>'html' is distinct from expected or private.awardping_program_utf16_slice(html,(m->>'start_utf16')::integer,(m->>'end_utf16')::integer) is distinct from expected
  or m->>'wrapper_start_tag' !~ '^<div [^<>]*id=''gform_wrapper_5'' style=''display:none''>$'
  or m->>'form_start_tag' is distinct from '<form method=''post'' enctype=''multipart/form-data'' target=''gform_ajax_frame_5'' id=''gform_5''  action='''||(p->>'form_action')||''' data-formid=''5'' novalidate>'
  or (m->>'wrapper_start_utf16')::integer>=(m->>'form_start_utf16')::integer or (m->>'form_start_utf16')::integer>=(m->>'start_utf16')::integer
  or private.awardping_program_utf16_slice(html,(m->>'wrapper_start_utf16')::integer,(m->>'wrapper_start_utf16')::integer+private.awardping_program_utf16_length(m->>'wrapper_start_tag')) is distinct from m->>'wrapper_start_tag'
  or private.awardping_program_utf16_slice(html,(m->>'form_start_utf16')::integer,(m->>'form_start_utf16')::integer+private.awardping_program_utf16_length(m->>'form_start_tag')) is distinct from m->>'form_start_tag'
  or (select count(*) from jsonb_array_elements(d->'blocks') z where z->>'kind'='li' and z->>'text'=(m->>'label')||' This field is for validation purposes and should be left unchanged.')<>1
  or position('</form' in private.awardping_program_utf16_slice(html,(m->>'form_start_utf16')::integer,(m->>'start_utf16')::integer))>0
 then return false;end if;
 return true;
exception when others then return false;end;
$hidden$;

create function private.awardping_basic_continuity_pair_valid(v jsonb) returns boolean
language plpgsql stable set search_path='' as $pair$
declare a jsonb:=v->'anchor_document';b jsonb:=v->'current_document';p jsonb:=v->'anchor_pair';work jsonb;changes jsonb;rules jsonb;mark jsonb;before_b jsonb;after_b jsonb;residual jsonb;profile jsonb;wp jsonb;old_sequence jsonb;new_sequence jsonb;side text;doc jsonb;excluded jsonb;residual_wp jsonb;
begin
 profile:=private.awardping_basic_continuity_profile((v->>'source_id')::uuid);
 if (case when p->>'mode'='profiled_ancillary_reorder' then private.awardping_program_exact_object(p,array['mode','changed_blocks','rules','widget_proofs','identity_markers','reorder_exclusions'])
  else private.awardping_program_exact_object(p,array['mode','changed_blocks','rules','widget_proofs','identity_markers']) end) is distinct from true
  or private.awardping_program_source_approval_document_valid(a) is distinct from true or private.awardping_program_source_approval_document_valid(b) is distinct from true
  or private.awardping_reviewed_repeat_raw_valid(a,v->'anchor_raw') is distinct from true or private.awardping_reviewed_repeat_raw_valid(b,v->'current_raw') is distinct from true
  or a#>'{reference,source}' is distinct from b#>'{reference,source}' or a#>'{reference,final_url}' is distinct from b#>'{reference,final_url}'
  or a#>'{reference,acquisition}' is distinct from b#>'{reference,acquisition}' or a#>'{reference,extractor}' is distinct from b#>'{reference,extractor}'
  or a#>>'{reference,source,id}' is distinct from v->>'source_id' or a#>>'{reference,source,shared_award_id}' is distinct from profile->>'owner_id'
  or a#>>'{reference,source,url}' is distinct from profile->>'url' or a#>>'{reference,final_url}' is distinct from profile->>'url'
  or a#>>'{reference,acquisition}' is distinct from 'http_html'
  or jsonb_typeof(p->'rules') is distinct from 'array' or jsonb_typeof(p->'widget_proofs') is distinct from 'array' or jsonb_typeof(p->'identity_markers') is distinct from 'array'
 then return false;end if;
 changes:=p->'changed_blocks';rules:=p->'rules';
 if p->>'mode'='profiled_ancillary_reorder' then
  if profile->>'profile' is distinct from 'daad_sponsored_university_carousel.v1' or v->>'source_id' not in('56aa30ee-164e-489a-ae5c-f2902dbb0db5','88906939-65e7-492d-a671-da56678dfecd','8d654c9d-e572-4488-94a3-e4238e7b1155')
   or a->>'text'=b->>'text' or changes is distinct from '[]'::jsonb or rules is distinct from '[]'::jsonb
   or p->'identity_markers' is distinct from '[]'::jsonb or jsonb_array_length(p->'widget_proofs')<>1
   or private.awardping_program_exact_object(p->'reorder_exclusions',array['previous','current']) is distinct from true then return false;end if;
  wp:=p#>'{widget_proofs,0}';
  if private.awardping_program_exact_object(wp,array['profile','previous_marker','current_marker']) is distinct from true
   or wp->>'profile' is distinct from profile->>'profile'
   or private.awardping_reviewed_marker_valid(wp->'previous_marker',v->'anchor_raw',wp->>'profile',(v->>'source_id')::uuid,a) is distinct from true
   or private.awardping_reviewed_marker_valid(wp->'current_marker',v->'current_raw',wp->>'profile',(v->>'source_id')::uuid,b) is distinct from true
   or wp#>'{previous_marker,container_attributes}' is distinct from wp#>'{current_marker,container_attributes}' then return false;end if;
  foreach side in array array['previous','current'] loop
   doc:=case side when 'previous' then a else b end;excluded:=p#>array['reorder_exclusions',side];
   if jsonb_typeof(excluded) is distinct from 'array' or jsonb_array_length(excluded) not between 1 and 1000
    or (select count(distinct value) from jsonb_array_elements(excluded))<>jsonb_array_length(excluded)
    or exists(select 1 from jsonb_array_elements(excluded) e where jsonb_typeof(e) is distinct from 'string'
     or not (wp#>array[side||'_marker','excluded_support_block_ids']) ? (e#>>'{}')
     or not exists(select 1 from jsonb_array_elements(doc->'blocks') block where block->>'id'=e#>>'{}')) then return false;end if;
   -- A repeated caption outside the actual sponsor widget may not borrow its
   -- exception. Complete ordered remaining blocks and links remain factual.
   if exists(select 1 from jsonb_array_elements(doc->'blocks') outside_b join jsonb_array_elements(doc->'blocks') inside_b
    on regexp_replace(btrim(outside_b->>'text'),'[[:space:]]+',' ','g')=regexp_replace(btrim(inside_b->>'text'),'[[:space:]]+',' ','g')
    where not excluded ? (outside_b->>'id') and excluded ? (inside_b->>'id')) then return false;end if;
  end loop;
  select coalesce(jsonb_agg(z-'id'-'start_utf16'-'end_utf16' order by ord),'[]'::jsonb) into old_sequence
   from jsonb_array_elements(a->'blocks') with ordinality vals(z,ord) where not (p#>'{reorder_exclusions,previous}') ? (z->>'id');
  select coalesce(jsonb_agg(z-'id'-'start_utf16'-'end_utf16' order by ord),'[]'::jsonb) into new_sequence
   from jsonb_array_elements(b->'blocks') with ordinality vals(z,ord) where not (p#>'{reorder_exclusions,current}') ? (z->>'id');
  if old_sequence is distinct from new_sequence or jsonb_array_length(old_sequence)=0 then return false;end if;
  residual_wp:=jsonb_set(jsonb_set(wp,'{previous_marker,excluded_support_block_ids}',p#>'{reorder_exclusions,previous}'),'{current_marker,excluded_support_block_ids}',p#>'{reorder_exclusions,current}');
  work:=jsonb_build_object('source_id',v->'source_id','repeat_document',a,'current_document',b,'rules','[]'::jsonb,'widget_proofs',jsonb_build_array(residual_wp),
   'candidate',jsonb_build_object('prompt_payload',jsonb_build_object('comparison',jsonb_build_object('changed_blocks','[]'::jsonb))));
  residual:=private.awardping_reviewed_repeat_residual(work,'repeat');
  return residual is not null and residual=private.awardping_reviewed_repeat_residual(work,'current');
 end if;
 if p->>'mode'='identical_program_text' then
  if a->>'text' is distinct from b->>'text' or a->'blocks' is distinct from b->'blocks' or changes is distinct from '[]'::jsonb or rules is distinct from '[]'::jsonb then return false;end if;
  if profile->>'profile'='hidden_gravityforms_honeypot_label' then
   if jsonb_array_length(p->'identity_markers')<>1 or jsonb_array_length(p->'widget_proofs')<>0 then return false;end if;
   mark:=p#>'{identity_markers,0}';
   if private.awardping_program_exact_object(mark,array['kind','block_id','previous_marker','current_marker']) is distinct from true or mark->>'kind' is distinct from 'hidden_gravityforms_honeypot_label' then return false;end if;
   select value into strict before_b from jsonb_array_elements(a->'blocks') where value->>'id'=mark->>'block_id';
   select value into strict after_b from jsonb_array_elements(b->'blocks') where value->>'id'=mark->>'block_id';
   changes:=jsonb_build_array(jsonb_build_object('id','identity-marker','previous',before_b,'current',after_b));
   rules:=jsonb_build_array((mark-'block_id')||jsonb_build_object('change_id','identity-marker'));
  else
   if jsonb_array_length(p->'identity_markers')<>0 or jsonb_array_length(p->'widget_proofs')<>1 then return false;end if;
   -- Use an actual widget member only as a marker-validation adapter. No real
   -- candidate is fabricated; zero-change full text/blocks equality is above.
   select value into strict before_b from jsonb_array_elements(a->'blocks') where value->>'id'=p#>>'{widget_proofs,0,previous_marker,excluded_support_block_ids,0}';
   select value into strict after_b from jsonb_array_elements(b->'blocks') where value->>'id'=p#>>'{widget_proofs,0,current_marker,excluded_support_block_ids,0}';
   changes:=jsonb_build_array(jsonb_build_object('id','identity-marker','previous',before_b,'current',after_b));
   rules:=jsonb_build_array(jsonb_build_object('change_id','identity-marker','kind','raw_marked_ancillary_widget','profile',profile->>'profile'));
  end if;
 elsif p->>'mode'='profiled_ancillary_change' then
  if jsonb_typeof(changes) is distinct from 'array' or jsonb_array_length(changes) not between 1 and 256 then return false;end if;
  if profile->>'profile'='hidden_gravityforms_honeypot_label' and not exists(select 1 from jsonb_array_elements(rules) z where z->>'kind'='hidden_gravityforms_honeypot_label') then
   if jsonb_array_length(p->'identity_markers')<>1 or exists(select 1 from jsonb_array_elements(changes) z where z->>'id'='identity-marker') then return false;end if;
   mark:=p#>'{identity_markers,0}';
   if private.awardping_program_exact_object(mark,array['kind','block_id','previous_marker','current_marker']) is distinct from true or mark->>'kind' is distinct from 'hidden_gravityforms_honeypot_label'
    or mark#>'{previous_marker,label}' is distinct from mark#>'{current_marker,label}' then return false;end if;
   select value into strict before_b from jsonb_array_elements(a->'blocks') where value->>'id'=mark->>'block_id';
   select value into strict after_b from jsonb_array_elements(b->'blocks') where value->>'id'=mark->>'block_id';
   if before_b-'id'-'start_utf16'-'end_utf16' is distinct from after_b-'id'-'start_utf16'-'end_utf16' then return false;end if;
   changes:=changes||jsonb_build_array(jsonb_build_object('id','identity-marker','previous',before_b,'current',after_b));
   rules:=rules||jsonb_build_array((mark-'block_id')||jsonb_build_object('change_id','identity-marker'));
  elsif jsonb_array_length(p->'identity_markers')<>0 then return false;end if;
 else return false;end if;
 if exists(select 1 from jsonb_array_elements(rules) z where z->>'kind' not in('hidden_gravityforms_honeypot_label','raw_marked_ancillary_widget','identical_protected_email_destination')) then return false;end if;
 if profile->>'profile'='hidden_gravityforms_honeypot_label' then
  if jsonb_array_length(p->'widget_proofs')<>0 or (select count(*) from jsonb_array_elements(rules) z where z->>'kind'='hidden_gravityforms_honeypot_label')<>1 then return false;end if;
  select value into strict mark from jsonb_array_elements(rules) where value->>'kind'='hidden_gravityforms_honeypot_label';
  if private.awardping_basic_continuity_hidden_valid(mark->'previous_marker',a,v->'anchor_raw',(v->>'source_id')::uuid) is distinct from true
   or private.awardping_basic_continuity_hidden_valid(mark->'current_marker',b,v->'current_raw',(v->>'source_id')::uuid) is distinct from true
   or private.awardping_basic_continuity_wrapper_identity(mark#>>'{previous_marker,wrapper_start_tag}') is null
   or private.awardping_basic_continuity_wrapper_identity(mark#>>'{previous_marker,wrapper_start_tag}') is distinct from private.awardping_basic_continuity_wrapper_identity(mark#>>'{current_marker,wrapper_start_tag}')
   or mark#>'{previous_marker,form_start_tag}' is distinct from mark#>'{current_marker,form_start_tag}' then return false;end if;
 else
  if jsonb_array_length(p->'widget_proofs')<>1 or p#>>'{widget_proofs,0,profile}' is distinct from profile->>'profile' then return false;end if;
 end if;
 work:=jsonb_build_object('source_id',v->'source_id','repeat_document',a,'current_document',b,'repeat_raw',v->'anchor_raw','current_raw',v->'current_raw','rules',rules,'widget_proofs',p->'widget_proofs',
 'continuity_mode',p->'mode','candidate',jsonb_build_object('prompt_payload',jsonb_build_object('comparison',jsonb_build_object('changed_blocks',changes))));
 if private.awardping_basic_continuity_rules_valid(work) is distinct from true then return false;end if;
 residual:=private.awardping_reviewed_repeat_residual(work,'repeat');
 return residual is not null and residual=private.awardping_reviewed_repeat_residual(work,'current');
exception when others then return false;end;
$pair$;

-- A support projection must contain every published selected quote from this
-- source, in exact field/item/quote order, and must return to the original quote.
create function private.awardping_basic_continuity_support_valid(v jsonb,i jsonb) returns boolean
language plpgsql immutable set search_path='' as $support$
declare projected jsonb;expected jsonb;actual jsonb;work jsonb;
begin
 work:=jsonb_build_object('repeat_document',v->'anchor_document','current_document',v->'current_document','widget_proofs',v#>'{anchor_pair,widget_proofs}','support_projection',v->'support_projection');
 projected:=private.awardping_reviewed_repeat_support(null,(v->>'source_id')::uuid,work);
 if projected is null or projected is distinct from v->'support_projection' or private.awardping_reviewed_repeat_hash(projected) is distinct from v->>'support_hash' then return false;end if;
 select coalesce(jsonb_agg(jsonb_build_object('field',f->>'field','item_index',i_ord-1,'support_index',q_ord-1,'value',item->'value','track',item->'track','quote',quote) order by (f->>'field') collate "C",i_ord,q_ord),'[]'::jsonb) into expected
 from jsonb_array_elements(i#>'{approved_review,fields}') f cross join lateral jsonb_array_elements(f->'items') with ordinality its(item,i_ord)
 cross join lateral jsonb_array_elements(item->'support') with ordinality qs(quote,q_ord)
 where f->>'status'='verified' and (i->'selected_fields') ? (f->>'field') and quote->>'source_id'=v->>'source_id';
 select coalesce(jsonb_agg(jsonb_build_object('field',z->'field','item_index',z->'item_index','support_index',z->'support_index','value',z->'value','track',z->'track','quote',z->'repeat_quote') order by (z->>'field') collate "C",(z->>'item_index')::integer,(z->>'support_index')::integer),'[]'::jsonb) into actual from jsonb_array_elements(projected) z;
 return actual=expected;
exception when others then return false;end;
$support$;

-- Machine continuity only. The original human reviewed-repeat validator still
-- requires genuine review packets; a zero-packet queue row is admitted here
-- only after independent finite DAAD raw-widget/outside-body conservation.
create function private.awardping_basic_continuity_zero_valid(v jsonb,n jsonb) returns boolean
language plpgsql stable set search_path='' as $zero$
declare c jsonb:=n->'candidate';comparison jsonb:=n->'comparison';plan jsonb:=n->'packet_plan';expected jsonb;work jsonb;cid uuid;
begin
 if private.awardping_program_exact_object(n,array['schema','candidate','candidate_hash','paid_reservation','comparison','packet_plan','responses','validation','pair']) is distinct from true
  or n->>'schema' is distinct from 'awardping.basic-continuity-zero-packet-validation.v1' or v->>'cohort_key' is distinct from 'daad_study'
  or n#>>'{pair,mode}' is distinct from 'profiled_ancillary_reorder' then return false;end if;
 cid:=(c->>'id')::uuid;
 if c is distinct from private.awardping_reviewed_repeat_candidate(cid) or private.awardping_reviewed_repeat_hash(c) is distinct from n->>'candidate_hash'
  or c->>'candidate_scope' is distinct from 'program_text_change' or c->>'status' is distinct from 'rejected' or c->>'rejection_reason' is distinct from 'no_program_change'
  or c->'model' is distinct from 'null'::jsonb or c->'gemini_batch_name' is distinct from 'null'::jsonb or c->'submitted_at' is distinct from 'null'::jsonb or c->'published_at' is distinct from 'null'::jsonb
  or c->'actual_usage' is distinct from '{}'::jsonb or n->'paid_reservation' is distinct from 'null'::jsonb or private.awardping_reviewed_repeat_paid(c) is distinct from 'null'::jsonb
  or (c->'worker_metadata') ?| array['gemini_spend_reservation_id','gemini_spend_attempt_token','program_text_claim_token','provider_request_keys','admin_alert_review_id']
  or c->>'shared_award_source_id' is distinct from v->>'source_id' or c->>'shared_award_id' is distinct from v#>>'{current_document,reference,source,shared_award_id}'
  or c->>'source_url' is distinct from v#>>'{current_document,reference,source,url}' or c#>>'{worker_metadata,monitoring_contract}' is distinct from 'program-text-v1'
  or c#>>'{worker_metadata,epoch}' is distinct from v->>'epoch' or c#>>'{worker_metadata,evidence_signature}' is distinct from c->>'candidate_signature'
  or c->'new_snapshot_ref' is distinct from v#>'{current_document,reference}' or c->'previous_snapshot_ref' is distinct from v#>'{previous_document,reference}'
  or not coalesce((c->>'completed_at')::timestamptz>=(v#>>'{current_document,reference,captured_at}')::timestamptz,false)
  or comparison is distinct from c#>'{prompt_payload,comparison}' or plan is distinct from c#>'{prompt_payload,packet_plan}'
  or private.awardping_program_exact_object(comparison,array['schema','context','previous_ref','current_ref','previous_text','current_text','changed_blocks','ignored_noise_blocks','status','reason','comparison_id']) is distinct from true
  or comparison->>'schema' is distinct from 'awardping.program-text-comparison.v1' or comparison->>'status' is distinct from 'unchanged'
  or comparison->'changed_blocks' is distinct from '[]'::jsonb or comparison->'ignored_noise_blocks' is distinct from '0'::jsonb
  or comparison->>'reason' not in('same_program_text','noise_or_reordering_only')
  or comparison->>'comparison_id' is distinct from c->>'candidate_signature' or private.awardping_reviewed_repeat_hash(comparison-'comparison_id') is distinct from c->>'candidate_signature'
  or comparison->>'previous_text' is distinct from v#>>'{previous_document,text}' or comparison->>'current_text' is distinct from v#>>'{current_document,text}'
  or comparison->'previous_ref' is distinct from private.awardping_reviewed_repeat_comparison_ref(v#>'{previous_document,reference}')
  or comparison->'current_ref' is distinct from private.awardping_reviewed_repeat_comparison_ref(v#>'{current_document,reference}')
  or private.awardping_program_exact_object(comparison->'context',array['award_id','source_id','epoch','cycle_id']) is distinct from true
  or comparison#>>'{context,award_id}' is distinct from c->>'shared_award_id' or comparison#>>'{context,source_id}' is distinct from v->>'source_id' or comparison#>>'{context,epoch}' is distinct from v->>'epoch'
  or private.awardping_program_exact_object(plan,array['status','comparison_id','packets']) is distinct from true or plan->>'status' is distinct from 'unchanged'
  or plan->>'comparison_id' is distinct from c->>'candidate_signature' or plan->'packets' is distinct from '[]'::jsonb or n->'responses' is distinct from '[]'::jsonb
  or private.awardping_program_exact_object(c->'ai_result',array['responses','program_text_validation']) is distinct from true or c#>'{ai_result,responses}' is distinct from '[]'::jsonb
 then return false;end if;
 expected:=jsonb_build_object('status','no_program_change','comparison_id',c->'candidate_signature','reasons','[]'::jsonb,'changes','[]'::jsonb);
 if n->'validation' is distinct from expected or c#>'{ai_result,program_text_validation}' is distinct from expected
  or not coalesce((v#>>'{previous_document,reference,captured_at}')::timestamptz<(v#>>'{current_document,reference,captured_at}')::timestamptz,false)
  or v#>'{previous_document,reference,capture_id}'=v#>'{current_document,reference,capture_id}'
  or v#>'{previous_document,reference,artifacts,metadata,object_key}'=v#>'{current_document,reference,artifacts,metadata,object_key}' then return false;end if;
 work:=jsonb_build_object('source_id',v->'source_id','anchor_document',v->'previous_document','anchor_raw',v->'previous_raw','current_document',v->'current_document','current_raw',v->'current_raw','anchor_pair',n->'pair');
 return private.awardping_basic_continuity_pair_valid(work);
exception when others then return false;end;
$zero$;

create function private.awardping_basic_continuity_validation_valid(v jsonb,i jsonb) returns boolean
language plpgsql stable set search_path='' as $validate$
declare k text;n jsonb;begin
 if private.awardping_program_exact_object(v,array['schema','kind','actor','verified_at','cohort_key','source_id','epoch','expected_head','snapshot_hash','input_review_hash','source_version','anchor_ref','current_ref','repeat_ref','unchanged_basis','anchor_document','anchor_raw','current_document','current_raw','previous_document','previous_raw','normal_validation','anchor_pair','support_projection','support_hash']) is distinct from true
  or v->>'schema' is distinct from 'awardping.program-basic-continuity-validation.v1' or v->>'actor' is distinct from 'system:program-text:basic-continuity'
  or octet_length(v::text)>33554432 or i->>'status' is distinct from 'ready' then return false;end if;
 foreach k in array array['cohort_key','source_id','epoch','expected_head','snapshot_hash','input_review_hash','source_version','anchor_ref','current_ref','repeat_ref','unchanged_basis'] loop
  if v->k is distinct from i->k then return false;end if;
 end loop;
 if v#>'{anchor_document,reference}' is distinct from i->'anchor_ref' or v#>'{current_document,reference}' is distinct from i->'current_ref'
  or not coalesce((v->>'verified_at')::timestamptz>=(i#>>'{current_ref,captured_at}')::timestamptz,false)
  or not coalesce((i#>>'{anchor_ref,captured_at}')::timestamptz<(i#>>'{current_ref,captured_at}')::timestamptz,false)
  or i#>'{anchor_ref,capture_id}'=i#>'{current_ref,capture_id}' or i#>'{anchor_ref,artifacts,metadata,object_key}'=i#>'{current_ref,artifacts,metadata,object_key}'
  or private.awardping_basic_continuity_pair_valid(v) is distinct from true or private.awardping_basic_continuity_support_valid(v,i) is distinct from true then return false;end if;
 if v->>'kind'='ordinary_no_program_change' then
  n:=v->'normal_validation';
  return i->'candidate' is not null and i->'candidate'<>'null'::jsonb and n->'candidate'=i->'candidate' and n->>'candidate_hash'=i->>'candidate_hash'
   and n->'paid_reservation'=i->'paid_reservation' and n->'expected_head'=i->'expected_head' and n->'cohort_key'=i->'cohort_key' and n->'source_id'=i->'source_id' and n->'epoch'=i->'epoch'
   and n->'current_document'=v->'current_document' and n->'current_raw'=v->'current_raw' and n->'repeat_document'=v->'previous_document' and n->'repeat_raw'=v->'previous_raw'
   and private.awardping_reviewed_repeat_validation_valid(n);
 elsif v->>'kind'='ordinary_zero_packet_no_change' then
  n:=v->'normal_validation';
  return i->'candidate' is not null and i->'candidate'<>'null'::jsonb and n->'candidate'=i->'candidate' and n->>'candidate_hash'=i->>'candidate_hash'
   and i->'paid_reservation'='null'::jsonb and private.awardping_basic_continuity_zero_valid(v,n);
 elsif v->>'kind'='ordinary_unchanged' then
  return (i->'candidate' is null or i->'candidate'='null'::jsonb) and v->'normal_validation'='null'::jsonb
   and v#>'{previous_document,reference}'=i->'repeat_ref'
   and private.awardping_program_source_approval_document_valid(v->'previous_document')
   and private.awardping_reviewed_repeat_raw_valid(v->'previous_document',v->'previous_raw')
   and v#>'{previous_document,text}'=v#>'{current_document,text}' and v#>'{previous_document,blocks}'=v#>'{current_document,blocks}'
   and private.awardping_basic_content_identity(i->'repeat_ref')=private.awardping_basic_content_identity(i->'current_ref')
   and i#>'{repeat_ref,capture_id}'<>i#>'{current_ref,capture_id}' and i#>'{repeat_ref,artifacts,metadata,object_key}'<>i#>'{current_ref,artifacts,metadata,object_key}'
   and (i#>>'{repeat_ref,captured_at}')::timestamptz<(i#>>'{current_ref,captured_at}')::timestamptz;
 end if;return false;
exception when others then return false;end;
$validate$;

create function private.awardping_basic_continuity_policy_current() returns boolean
language plpgsql stable set search_path='' as $policy$
declare stored private.program_basic_continuity_policy%rowtype;pin jsonb;actual jsonb;rel text;begin
 select * into strict stored from private.program_basic_continuity_policy where id;
 if stored.content_hash is distinct from private.awardping_reviewed_repeat_hash(stored.pins) or jsonb_array_length(stored.pins)<>50 then return false;end if;
 for pin in select value from jsonb_array_elements(stored.pins) loop
  select jsonb_build_object('signature',pin->>'signature','definition_sha256',encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex'),'owner',pg_get_userbyid(p.proowner),'acl',to_jsonb(p.proacl),'security_definer',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig) into strict actual
  from pg_catalog.pg_proc p where p.oid=to_regprocedure(pin->>'signature');
  if actual is distinct from pin then return false;end if;
 end loop;
 foreach rel in array array['private.program_basic_continuity_observations','private.program_basic_continuity_policy'] loop
  if not exists(select 1 from pg_catalog.pg_class c where c.oid=to_regclass(rel) and pg_get_userbyid(c.relowner)='postgres' and c.relrowsecurity
   and not has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') and not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') and not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
   or (select count(*) from pg_catalog.pg_trigger t where t.tgrelid=to_regclass(rel) and not t.tgisinternal and t.tgenabled='O' and t.tgfoid='private.awardping_basic_repeat_immutable()'::regprocedure)<>2 then return false;end if;
 end loop;
 return true;
exception when others then return false;end;
$policy$;

create function public.attest_program_basic_continuity(p_validation jsonb) returns jsonb
language plpgsql security definer set search_path='' as $attest$
declare i jsonb;v jsonb:=p_validation;r jsonb;h text;existing private.program_basic_continuity_observations%rowtype;o private.program_basic_continuity_observations%rowtype;v_source uuid;basis_versions jsonb;
begin
 v_source:=(v->>'source_id')::uuid;
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('awardping-basic-facts:'||(v->>'cohort_key'),0));
 perform 1 from public.program_basic_fact_heads where cohort_key=v->>'cohort_key' for share;
 perform 1 from public.program_basic_fact_snapshots where id=(v->>'expected_head')::uuid for share;
 perform 1 from public.program_text_fact_reviews where id=(select input_review_id from public.program_basic_fact_snapshots where id=(v->>'expected_head')::uuid) for share;
 perform 1 from public.stage1_award_registry where cohort_key=v->>'cohort_key' for share;
 perform 1 from public.program_text_source_roster where cohort_key=v->>'cohort_key' for share;
 perform 1 from public.program_text_source_authority_epochs where active for share;
 perform 1 from public.shared_award_sources s where s.id=v_source for update;
 if v->>'kind' in('ordinary_no_program_change','ordinary_zero_packet_no_change') then
  perform 1 from public.shared_award_visual_review_candidates where id=coalesce(v#>>'{normal_validation,candidate_id}',v#>>'{normal_validation,candidate,id}')::uuid for share;
  if v#>>'{normal_validation,candidate,worker_metadata,gemini_spend_reservation_id}' is not null then perform 1 from public.gemini_spend_reservations where id=(v#>>'{normal_validation,candidate,worker_metadata,gemini_spend_reservation_id}')::uuid for share;end if;
 end if;
 select z.* into existing from private.program_basic_continuity_observations z where z.expected_head=(v->>'expected_head')::uuid and z.source_id=v_source and z.current_capture_id=v#>>'{current_ref,capture_id}';
 if found and existing.receipt->>'validation_hash'=private.awardping_reviewed_repeat_hash(v)
  and private.awardping_basic_continuity_version_current(existing.expected_head,existing.receipt->'source_version') then
  return jsonb_build_object('ok',true,'already_applied',true,'id',existing.id,'observation_id',existing.id,'content_hash',existing.content_hash);end if;
 i:=public.inspect_program_basic_continuity(v_source);
 if private.awardping_basic_continuity_policy_current() is distinct from true or private.awardping_basic_continuity_validation_valid(v,i) is distinct from true
  or not coalesce((v->>'verified_at')::timestamptz between clock_timestamp()-interval '15 minutes' and clock_timestamp(),false)
 then raise exception 'Fresh exact approved-anchor continuity proof required.' using errcode='40001';end if;
 select jsonb_build_object('snapshot_xmin',x.xmin::text,'snapshot_ctid',x.ctid::text,'draft_xmin',d.xmin::text,'draft_ctid',d.ctid::text) into strict basis_versions
 from public.program_basic_fact_snapshots x join public.program_text_fact_reviews d on d.id=x.input_review_id where x.id=(v->>'expected_head')::uuid;
 r:=jsonb_build_object('schema','awardping.program-basic-continuity-read-receipt.v1','kind',v->'kind','actor','system:program-text:basic-continuity','verified_at',v->'verified_at',
 'cohort_key',v->'cohort_key','source_id',v->'source_id','epoch',v->'epoch','expected_head',v->'expected_head','snapshot_hash',v->'snapshot_hash','input_review_hash',v->'input_review_hash',
 'source_version',v->'source_version','anchor_ref',v->'anchor_ref','current_ref',v->'current_ref','previous_ref',v#>'{previous_document,reference}','unchanged_basis',v->'unchanged_basis',
 'basis_row_versions',basis_versions,'support_hash',v->'support_hash','authority_hash',private.awardping_reviewed_repeat_hash(private.awardping_basic_continuity_authority(v_source,v->>'cohort_key',(v->>'epoch')::uuid)),
 'candidate_id',i#>'{candidate,id}','candidate_hash',i->'candidate_hash','paid_hash',case when i->'candidate' is null or i->'candidate'='null'::jsonb then null else private.awardping_reviewed_repeat_hash(i->'paid_reservation') end,
 'anchor_pair_hash',private.awardping_reviewed_repeat_hash(v->'anchor_pair'),'validation_hash',private.awardping_reviewed_repeat_hash(v));
 h:=private.awardping_reviewed_repeat_hash(r);
 select z.* into existing from private.program_basic_continuity_observations z where z.expected_head=(v->>'expected_head')::uuid and z.source_id=v_source and z.current_capture_id=v#>>'{current_ref,capture_id}';
 if found then
  if existing.receipt-'verified_at'-'validation_hash' is distinct from r-'verified_at'-'validation_hash' or existing.content_hash is distinct from private.awardping_reviewed_repeat_hash(existing.receipt) then raise exception 'Existing continuity proof differs.' using errcode='40001';end if;
  return jsonb_build_object('ok',true,'already_applied',true,'id',existing.id,'observation_id',existing.id,'content_hash',existing.content_hash);
 end if;
 insert into private.program_basic_continuity_observations(cohort_key,source_id,epoch,expected_head,current_capture_id,receipt,content_hash)
 values(v->>'cohort_key',v_source,(v->>'epoch')::uuid,(v->>'expected_head')::uuid,v#>>'{current_ref,capture_id}',r,h) returning * into o;
 return jsonb_build_object('ok',true,'already_applied',false,'id',o.id,'observation_id',o.id,'content_hash',o.content_hash,'notification_mode','none','facts_changed',false);
end;
$attest$;

-- Public GETs inspect only the small immutable read receipt and mutable row
-- hashes. They never parse retained raw HTML or the full ephemeral validation.
create function private.awardping_basic_continuity_version_current(p_snapshot uuid,p_version jsonb) returns boolean
language plpgsql stable set search_path='' as $current$
declare o private.program_basic_continuity_observations%rowtype;r jsonb;x public.program_basic_fact_snapshots%rowtype;s public.shared_award_sources%rowtype;p jsonb;c jsonb;paid jsonb;roster jsonb;anchor jsonb;draft_hash text;basis_versions jsonb;
begin
 p:=private.awardping_basic_continuity_profile((p_version->>'source_id')::uuid);
 if p is null then return false;end if;
 select * into strict x from public.program_basic_fact_snapshots where id=p_snapshot;
 select d.content_hash,jsonb_build_object('snapshot_xmin',z.xmin::text,'snapshot_ctid',z.ctid::text,'draft_xmin',d.xmin::text,'draft_ctid',d.ctid::text) into strict draft_hash,basis_versions
 from public.program_basic_fact_snapshots z join public.program_text_fact_reviews d on d.id=z.input_review_id where z.id=x.id;
 select * into strict s from public.shared_award_sources where id=(p_version->>'source_id')::uuid;
 select * into strict o from private.program_basic_continuity_observations where expected_head=x.id and source_id=s.id and current_capture_id=s.text_monitoring_state#>>'{latest_ref,capture_id}';r:=o.receipt;
 if private.awardping_basic_continuity_policy_current() is distinct from true then return false;end if;
 select value into strict anchor from jsonb_array_elements(x.receipt->'current_capture_refs') where value#>>'{source,id}'=s.id::text;
 select jsonb_agg(jsonb_build_object('source_role',source_role,'revision',revision,'source_ids',source_ids) order by source_role) into roster from public.program_text_source_roster where cohort_key=x.cohort_key;
 if o.content_hash is distinct from private.awardping_reviewed_repeat_hash(r) or r->>'schema' is distinct from 'awardping.program-basic-continuity-read-receipt.v1'
  or o.cohort_key is distinct from x.cohort_key or o.epoch::text is distinct from p_version->>'epoch' or o.expected_head is distinct from x.id
  or r->>'actor' is distinct from 'system:program-text:basic-continuity' or r->>'expected_head' is distinct from x.id::text or r->'source_version' is distinct from p_version
  or not exists(select 1 from public.program_basic_fact_heads h where h.cohort_key=x.cohort_key and h.snapshot_id=x.id)
  or not exists(select 1 from jsonb_array_elements(x.source_versions) z where z=p_version)
  or r->>'snapshot_hash' is distinct from x.content_hash or x.content_hash is distinct from private.awardping_reviewed_repeat_hash(x.receipt)
  or x.receipt->>'schema' is distinct from 'awardping.current-basic-award-fact-review.v1'
  or r->>'input_review_hash' is distinct from x.input_review_hash or draft_hash is distinct from x.input_review_hash or r->'basis_row_versions' is distinct from basis_versions
  or x.public_facts is distinct from x.receipt->'public_facts'
  or roster is distinct from (select jsonb_agg(value order by value->>'source_role') from jsonb_array_elements(x.receipt->'roster'))
  or s.shared_award_id::text is distinct from p->>'owner_id' or s.url is distinct from p->>'url' or x.cohort_key is distinct from p->>'cohort_key'
  or p_version->>'owner_id' is distinct from s.shared_award_id::text or p_version->>'url' is distinct from s.url
  or p_version->'pending_alert_review_id' is distinct from 'null'::jsonb or p_version->'pending_alert_review_hash' is distinct from 'null'::jsonb
  or r->'anchor_ref' is distinct from anchor or private.awardping_basic_content_identity(anchor) is distinct from p_version->'content_identity'
  or r->'current_ref' is distinct from s.text_monitoring_state->'latest_ref' or s.text_monitoring_state->>'status' is distinct from 'baseline_ready'
  or private.awardping_current_basic_source_ready(s.id,x.cohort_key,o.epoch,r->'current_ref') is distinct from true
  or r->>'authority_hash' is distinct from private.awardping_reviewed_repeat_hash(private.awardping_basic_continuity_authority(s.id,x.cohort_key,o.epoch)) then return false;end if;
 if r->'unchanged_basis'<>'null'::jsonb and private.awardping_basic_continuity_basis_valid(r->'unchanged_basis',x.id,s.id,o.epoch,anchor,r->'current_ref') is distinct from true then return false;end if;
 if r->>'kind' in('ordinary_no_program_change','ordinary_zero_packet_no_change') then
  c:=private.awardping_reviewed_repeat_candidate((r->>'candidate_id')::uuid);paid:=private.awardping_reviewed_repeat_paid(c);
  return private.awardping_reviewed_repeat_hash(c)=r->>'candidate_hash' and private.awardping_reviewed_repeat_hash(paid)=r->>'paid_hash'
   and c->>'status'='rejected' and c->>'rejection_reason'='no_program_change' and c->'new_snapshot_ref'=r->'current_ref' and c->'previous_snapshot_ref'=r->'previous_ref';
 elsif r->>'kind'='ordinary_unchanged' then
  return not exists(select 1 from public.shared_award_visual_review_candidates z where z.shared_award_source_id=s.id and z.candidate_scope='program_text_change' and z.worker_metadata->>'epoch'=o.epoch::text and z.new_snapshot_ref=r->'current_ref');
 end if;return false;
exception when others then return false;end;
$current$;

-- Only insert the new fail-closed branch. Legacy proof validation remains exact.
do $dispatch$
declare original text;revised text;needle text:=E'  select * into strict s from public.shared_award_sources where id=(v->>''source_id'')::uuid;';
begin
 original:=pg_get_functiondef('private.awardping_current_basic_fact_current(uuid)'::regprocedure);
 if encode(extensions.digest(convert_to(original,'UTF8'),'sha256'),'hex') is distinct from 'e330f3507e260ca734806c166f48a59d4821cbfbf370338919b6ed6634707c23'
  or (length(original)-length(replace(original,needle,'')))/length(needle)<>1 then raise exception 'Current basic dispatcher preimage changed.' using errcode='40001';end if;
 revised:=replace(original,needle,needle||E'\n  if private.awardping_basic_continuity_version_current(x.id,v) then continue;end if;');execute revised;
end;$dispatch$;

revoke all on function private.awardping_basic_continuity_profile(uuid),private.awardping_basic_continuity_authority(uuid,text,uuid),private.awardping_basic_continuity_basis_valid(jsonb,uuid,uuid,uuid,jsonb,jsonb),
 private.awardping_basic_continuity_rules_valid(jsonb),private.awardping_basic_continuity_wrapper_identity(text),private.awardping_basic_continuity_hidden_valid(jsonb,jsonb,jsonb,uuid),
 private.awardping_basic_continuity_pair_valid(jsonb),private.awardping_basic_continuity_support_valid(jsonb,jsonb),private.awardping_basic_continuity_zero_valid(jsonb,jsonb),private.awardping_basic_continuity_validation_valid(jsonb,jsonb),
 private.awardping_basic_continuity_policy_current(),private.awardping_basic_continuity_version_current(uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.list_program_basic_continuity_sources(),public.inspect_program_basic_continuity(uuid),public.attest_program_basic_continuity(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.list_program_basic_continuity_sources(),public.inspect_program_basic_continuity(uuid),public.attest_program_basic_continuity(jsonb) to service_role;

-- Seal the admitted validator closure after all final ACLs and dispatch exist.
-- A later reviewed migration must explicitly replace this policy, not silently
-- leave old receipts valid against changed admission or authority functions.
insert into private.program_basic_continuity_policy(id,pins,content_hash)
select true,pins,private.awardping_reviewed_repeat_hash(pins) from (
 select jsonb_agg(jsonb_build_object('signature',s.signature,'definition_sha256',encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex'),'owner',pg_get_userbyid(p.proowner),'acl',to_jsonb(p.proacl),'security_definer',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig) order by s.signature) pins
 from unnest(array[
 'private.awardping_basic_continuity_profile(uuid)','private.awardping_basic_continuity_authority(uuid,text,uuid)','private.awardping_basic_continuity_basis_valid(jsonb,uuid,uuid,uuid,jsonb,jsonb)','private.awardping_basic_continuity_rules_valid(jsonb)',
 'private.awardping_basic_continuity_wrapper_identity(text)','private.awardping_basic_continuity_hidden_valid(jsonb,jsonb,jsonb,uuid)','private.awardping_basic_continuity_pair_valid(jsonb)',
 'private.awardping_basic_continuity_support_valid(jsonb,jsonb)','private.awardping_basic_continuity_zero_valid(jsonb,jsonb)','private.awardping_basic_continuity_validation_valid(jsonb,jsonb)','private.awardping_basic_continuity_policy_current()',
 'private.awardping_basic_continuity_version_current(uuid,jsonb)','public.inspect_program_basic_continuity(uuid)','public.list_program_basic_continuity_sources()',
 'public.attest_program_basic_continuity(jsonb)','private.awardping_basic_repeat_immutable()','private.awardping_reviewed_repeat_validation_valid(jsonb)',
 'private.awardping_reviewed_repeat_candidate_valid(jsonb)','private.awardping_reviewed_repeat_candidate(uuid)','private.awardping_reviewed_repeat_paid(jsonb)',
 'private.awardping_reviewed_repeat_rules_valid(jsonb)','private.awardping_reviewed_marker_valid(jsonb,jsonb,text,uuid,jsonb)','private.awardping_reviewed_repeat_raw_valid(jsonb,jsonb)',
 'private.awardping_reviewed_repeat_support(jsonb,uuid,jsonb)','private.awardping_reviewed_repeat_residual(jsonb,text)','private.awardping_reviewed_repeat_hash(jsonb)',
 'private.awardping_program_source_approval_document_valid(jsonb)','private.awardping_current_basic_source_ready(uuid,text,uuid,jsonb)',
 'private.awardping_program_text_source_approval_dto(uuid)','private.awardping_program_text_canonical_url_admission(uuid,uuid)',
 'private.awardping_basic_content_identity(jsonb)','private.awardping_basic_fact_selection(jsonb,jsonb)','private.awardping_current_basic_fact_current(uuid)',
 'private.awardping_program_exact_object(jsonb,text[])','private.monitoring_feedback_canonical_json(jsonb)',
 'private.awardping_program_text_source_access(uuid,text,uuid)','private.awardping_program_text_collection_quality_ready(uuid,uuid)',
 'private.awardping_program_text_collection_quality(uuid,uuid)','private.awardping_program_text_reference_valid(jsonb)',
 'private.awardping_program_block_valid(jsonb,text)','private.awardping_program_utf16_slice(text,integer,integer)','private.awardping_program_utf16_length(text)',
 'private.awardping_program_fact_known_html_shell(jsonb)','private.awardping_program_fact_known_footer_only_pdf(jsonb)',
 'private.awardping_program_text_source_approval_dto_stage1(uuid)','private.awardping_program_text_approval_context_current(text,uuid,uuid,text,jsonb)',
 'private.awardping_program_text_canonical_boundary_current(uuid,text,uuid,text,jsonb)','private.awardping_pappg_canonical_admission_allowed(uuid,text,uuid)',
 'private.program_award_expansion_source_proof(uuid)','private.awardping_reviewed_repeat_comparison_ref(jsonb)'
 ]) s(signature) join pg_catalog.pg_proc p on p.oid=to_regprocedure(s.signature)
) all_pins;

do $postcheck$ begin
 if private.awardping_basic_continuity_policy_current() is distinct from true then raise exception 'Continuity policy closure failed.';end if;
 if exists(select 1 from private.program_basic_continuity_observations) then raise exception 'New continuity ledger must start empty.';end if;
end;$postcheck$;
