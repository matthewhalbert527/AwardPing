-- Narrow MANUAL collection approval, not automated officialness inference or
-- cryptographic page proof. The operator must inspect the actual official link
-- and ownership before invoking this service-only RPC. No capture/hash/seal is
-- invented. Legacy intake/visual authority and historical source rows are intact.
--
-- p_proposal exact shape (all identifiers except "$new" are lowercase UUIDs):
-- {schema:"awardping.program-text-source-registration.v1",cohort_key,
--  expected_canonical_shared_award_id,expected_official_homepage,source_url,
--  authority:{source_id,source_url,link_href,link_text,checked_at,review_note},
--  roles:[{source_role,expected_revision,expected_source_ids:[uuid],
--          source_ids:[uuid|"$new"],review_note}]}
-- Every changed role must contain "$new" exactly once. Other source IDs can
-- only retain members of that role; broader existing-source corrections use
-- replace_program_text_source_role separately after their own explicit review.
-- Exact required role sets: CLS overview dates_cycle+application_materials;
-- CLS selection selection_interviews; Beinecke conditions funding. The latter
-- ADDS funding/tenure coverage: it does not retire the unavailable document or
-- claim that conditions alone cover current dates or selection requirements.
create function public.register_program_text_source(p_proposal jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_cohort text; v_owner uuid; v_home text; v_origin text; v_url text; v_title text; v_type text;
 v_required_roles text[]; v_roles text[]; v_authority jsonb; v_href text; v_resolved text; v_base text;
 v_parts text[]:='{}'; v_part text; v_checked timestamptz;
 v_registry public.stage1_award_registry%rowtype;
 v_authority_source public.shared_award_sources%rowtype; v_source public.shared_award_sources%rowtype;
 v_role public.program_text_source_roster%rowtype; v_change jsonb; v_id uuid; v_expected uuid[]; v_next uuid[];
 v_source_refs text[]; v_binding jsonb; v_bindings jsonb; v_roles_result jsonb:='[]'; v_result jsonb;
 v_registration record; v_review jsonb;
begin
 -- This is first and matches fact publication and text-roster lock ordering.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if private.awardping_program_exact_object(p_proposal,array['schema','cohort_key',
   'expected_canonical_shared_award_id','expected_official_homepage','source_url','authority','roles']) is not true
  or p_proposal->>'schema' is distinct from 'awardping.program-text-source-registration.v1'
  or length(btrim(coalesce(p_actor,''))) not between 1 and 320
  or octet_length(p_proposal::text)>65536
 then raise exception 'Invalid manual text-source registration.' using errcode='23514'; end if;

 v_url:=p_proposal->>'source_url';
 -- Deliberately not a general hostname allowlist. Only these three new pages
 -- may acquire text-only collection authority through this operation.
 case v_url
  when 'https://clscholarship.org/applicants' then
   v_cohort:='cls'; v_owner:='ba1a3c76-4868-42b4-994b-6cbae72a7044';
   v_home:='https://clscholarship.org/'; v_origin:='https://clscholarship.org';
   v_title:='Critical Language Scholarship Program — Applicant overview'; v_type:='application';
   v_required_roles:=array['application_materials','dates_cycle'];
  when 'https://clscholarship.org/applicants/selection-process' then
   v_cohort:='cls'; v_owner:='ba1a3c76-4868-42b4-994b-6cbae72a7044';
   v_home:='https://clscholarship.org/'; v_origin:='https://clscholarship.org';
   v_title:='Critical Language Scholarship Program — Selection process'; v_type:='other';
   v_required_roles:=array['selection_interviews'];
  when 'https://beineckescholarship.org/beinecke-scholarship/scholarship-conditions/' then
   v_cohort:='beinecke'; v_owner:='26b5b55f-57e9-42a7-ae4c-37d389c5e70c';
   v_home:='https://beineckescholarship.org/'; v_origin:='https://beineckescholarship.org';
   v_title:='Beinecke Scholarship — Scholarship conditions'; v_type:='requirements';
   v_required_roles:=array['funding'];
  else raise exception 'This page is outside the reviewed three-source correction.' using errcode='23514';
 end case;
 if p_proposal->>'cohort_key' is distinct from v_cohort
  or p_proposal->>'expected_canonical_shared_award_id' is distinct from v_owner::text
  or p_proposal->>'expected_official_homepage' is distinct from v_home
 then raise exception 'The reviewed canonical program identity changed.' using errcode='23514'; end if;
 select * into strict v_registry from public.stage1_award_registry where cohort_key=v_cohort for share;
 if v_registry.canonical_shared_award_id<>v_owner or v_registry.official_homepage<>v_home
  or not exists(select 1 from public.stage1_award_members m join public.shared_awards a on a.id=m.shared_award_id
   where m.cohort_key=v_cohort and m.shared_award_id=v_owner and m.member_kind='canonical' and a.status='active')
 then raise exception 'Canonical source registration identity is stale.' using errcode='40001'; end if;

 v_authority:=p_proposal->'authority';
 if private.awardping_program_exact_object(v_authority,array['source_id','source_url','link_href','link_text','checked_at','review_note']) is not true
  or coalesce(v_authority->>'source_id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  or jsonb_typeof(v_authority->'source_url') is distinct from 'string'
  or length(v_authority->>'source_url') not between 1 and 4096
  or left(v_authority->>'source_url',length(v_origin)+1)<>v_origin||'/'
  or v_authority->>'source_url' ~ '[[:space:]#\\]'
  or jsonb_typeof(v_authority->'link_href') is distinct from 'string'
  or length(v_authority->>'link_href') not between 1 and 4096
  or jsonb_typeof(v_authority->'link_text') is distinct from 'string'
  or length(btrim(v_authority->>'link_text')) not between 1 and 1000
  or jsonb_typeof(v_authority->'review_note') is distinct from 'string'
  or length(btrim(v_authority->>'review_note')) not between 20 and 2000
  or coalesce(v_authority->>'checked_at','') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
 then raise exception 'An explicit same-origin manual authority/link review is required.' using errcode='23514'; end if;
 v_checked:=(v_authority->>'checked_at')::timestamptz;
 if v_checked>clock_timestamp()+interval '5 minutes' or v_checked<clock_timestamp()-interval '7 days'
 then raise exception 'Recheck the actual official authority link before registration.' using errcode='23514'; end if;
 select * into strict v_authority_source from public.shared_award_sources where id=(v_authority->>'source_id')::uuid for share;
 if v_authority_source.url is distinct from v_authority->>'source_url'
  or v_authority_source.admin_review_status is distinct from 'open'
  or not exists(select 1 from public.stage1_award_members m join public.shared_awards a on a.id=m.shared_award_id
   where m.cohort_key=v_cohort and m.shared_award_id=v_authority_source.shared_award_id and a.status='active')
  or exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=v_cohort
   and ((r.url_pattern is not null and v_authority_source.url ~* r.url_pattern)
    or (r.title_pattern is not null and concat_ws(' ',v_authority_source.title,v_authority_source.display_title) ~* r.title_pattern)))
 then raise exception 'The manual authority page is not an open official source of this program.' using errcode='23514'; end if;

 -- Resolve a literal absolute/root-relative/relative anchor href without
 -- accepting credentials, protocol-relative hosts, queries, encoded aliases,
 -- fragments or backslash browser-origin ambiguity. No URL is fetched here.
 v_href:=v_authority->>'link_href';
 if v_href=v_url then v_resolved:=v_href;
 else
  if v_href !~ '^[A-Za-z0-9_./-]+$' or position('//' in v_href)>0
  then raise exception 'The literal official link does not resolve to the approved page.' using errcode='23514'; end if;
  v_base:=regexp_replace(v_authority_source.url,'[?].*$','');
  v_base:=regexp_replace(v_base,'[^/]*$','');
  v_resolved:=case when left(v_href,1)='/' then v_origin||v_href else v_base||v_href end;
  foreach v_part in array string_to_array(substr(v_resolved,length(v_origin)+1),'/') loop
   if v_part='..' then v_parts:=v_parts[1:greatest(cardinality(v_parts)-1,0)];
   elsif v_part not in ('','.') then v_parts:=array_append(v_parts,v_part); end if;
  end loop;
  v_resolved:=v_origin||'/'||array_to_string(v_parts,'/')||case when right(v_href,1)='/' then '/' else '' end;
 end if;
 if v_resolved is distinct from v_url
 then raise exception 'The literal official link does not resolve to the approved page.' using errcode='23514'; end if;

 if jsonb_typeof(p_proposal->'roles') is distinct from 'array'
 then raise exception 'Explicit versioned source-role corrections are required.' using errcode='23514'; end if;
 select array_agg(item->>'source_role' order by item->>'source_role') into v_roles from jsonb_array_elements(p_proposal->'roles') item;
 if v_roles is distinct from v_required_roles
 then raise exception 'The source-role correction is outside this page-specific approval.' using errcode='23514'; end if;
 -- Deterministic role locks and ALL CAS checks precede any source insertion.
 for v_change in select value from jsonb_array_elements(p_proposal->'roles') order by value->>'source_role' loop
  if private.awardping_program_exact_object(v_change,array['source_role','expected_revision','expected_source_ids','source_ids','review_note']) is not true
   or coalesce(v_change->>'expected_revision','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   or jsonb_typeof(v_change->'expected_source_ids') is distinct from 'array'
   or jsonb_typeof(v_change->'source_ids') is distinct from 'array'
   or jsonb_typeof(v_change->'review_note') is distinct from 'string'
   or length(btrim(v_change->>'review_note')) not between 20 and 2000
  then raise exception 'Invalid versioned source-role correction.' using errcode='23514'; end if;
  if jsonb_array_length(v_change->'expected_source_ids') not between 1 and 50
   or jsonb_array_length(v_change->'source_ids') not between 1 and 50
   or exists(select 1 from jsonb_array_elements(v_change->'expected_source_ids') x where jsonb_typeof(x)<>'string' or x#>>'{}' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
   or exists(select 1 from jsonb_array_elements(v_change->'source_ids') x where jsonb_typeof(x)<>'string' or (x#>>'{}'<>'$new' and x#>>'{}' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'))
  then raise exception 'Source-role identities are invalid or out of bounds.' using errcode='23514'; end if;
  select array_agg(x::uuid order by x::uuid) into v_expected from jsonb_array_elements_text(v_change->'expected_source_ids') x;
  select array_agg(x) into v_source_refs from jsonb_array_elements_text(v_change->'source_ids') x;
  if cardinality(v_expected)<>(select count(distinct x) from unnest(v_expected) x)
   or cardinality(v_source_refs)<>(select count(distinct x) from unnest(v_source_refs) x)
   or (select count(*) from unnest(v_source_refs) x where x='$new')<>1
   or exists(select 1 from unnest(v_source_refs) x where case when x='$new' then false else not x::uuid=any(v_expected) end)
  then raise exception 'Each role must explicitly include the new page and only retain prior identities.' using errcode='23514'; end if;
  select * into strict v_role from public.program_text_source_roster where cohort_key=v_cohort and source_role=v_change->>'source_role' for update;
  if v_role.revision<>(v_change->>'expected_revision')::uuid
   or (select array_agg(x order by x) from unnest(v_role.source_ids) x) is distinct from v_expected
  then raise exception 'A source role changed; review all current role versions.' using errcode='40001'; end if;
 end loop;

 -- Reject normalized matches anywhere, including sources under registered
 -- aliases. Never enter the legacy RPC's existing-row metadata update branch.
 if exists(select 1 from public.shared_award_sources s where
  lower(regexp_replace(split_part(s.url,'#',1),'/+$',''))=lower(regexp_replace(v_url,'/+$','')))
 then raise exception 'This normalized page already has a source identity; review and reuse it explicitly.' using errcode='23505'; end if;
 if exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=v_cohort
  and ((r.url_pattern is not null and v_url ~* r.url_pattern) or (r.title_pattern is not null and v_title ~* r.title_pattern)))
 then raise exception 'This page is excluded from the reviewed program identity.' using errcode='23514'; end if;
 v_review:=jsonb_build_object('schema','awardping.program-text-manual-source-approval.v1',
  'cohort_key',v_cohort,'canonical_shared_award_id',v_owner,'official_homepage',v_home,'source_url',v_url,
  'reviewed_by',btrim(p_actor),'authority',v_authority,'roles',p_proposal->'roles',
  'collection_only',true,'public_fact_authority',false,'fact_candidate_authority',false);
 select * into strict v_registration from public.register_shared_award_source_from_intake(
  jsonb_build_object('shared_award_id',v_owner,'url',v_url,'title',v_title,'page_type',v_type,'confidence',1,
   'reason','Manually reviewed text-only source correction; silent initial coverage required.',
   'source','admin','submitted_by_user_id',null,'admin_review_status','open',
   'page_metadata',jsonb_build_object('kind','program_text_manual_registration','program_text_collection_approval',v_review),
   'consecutive_failures',0),
  jsonb_build_object('acquisition_kind','admin_intake','notification_mode','baseline_only','award_was_created',false,
   'onboarding_batch_id','program-text-three-source-correction-v1','review_seal','{}'::jsonb,
   'metadata',v_review));
 if v_registration.source_inserted is not true or v_registration.acquisition_id is null
  or v_registration.effective_notification_mode is distinct from 'baseline_only'
 then raise exception 'New source and silent immutable acquisition were not registered together.' using errcode='40001'; end if;
 select * into strict v_source from public.shared_award_sources where id=v_registration.source_id for share;
 if v_source.url<>v_url or v_source.shared_award_id<>v_owner or v_source.text_monitoring_state<>'{}'::jsonb
 then raise exception 'The new source did not retain an empty, independent text baseline.' using errcode='23514'; end if;

 for v_change in select value from jsonb_array_elements(p_proposal->'roles') order by value->>'source_role' loop
  select * into strict v_role from public.program_text_source_roster where cohort_key=v_cohort and source_role=v_change->>'source_role';
  select array_agg(case when x='$new' then v_source.id else x::uuid end order by position)
   into v_next from jsonb_array_elements_text(v_change->'source_ids') with ordinality refs(x,position);
  v_bindings:='{}';
  foreach v_id in array v_next loop
   v_binding:=case when v_id=v_source.id then jsonb_build_object('source_url',v_url,'shared_award_id',v_owner,
     'authority_url',v_authority_source.url,'review_note',btrim(v_change->>'review_note'))
    else v_role.evidence#>array['source_bindings',v_id::text] end;
   v_bindings:=v_bindings||jsonb_build_object(v_id::text,v_binding);
  end loop;
  v_result:=public.replace_program_text_source_role(v_cohort,v_change->>'source_role',(v_change->>'expected_revision')::uuid,v_next,
   jsonb_build_object('schema','awardping.program-text-source-role.v1','source_bindings',v_bindings),btrim(p_actor));
  v_roles_result:=v_roles_result||jsonb_build_array(v_result);
 end loop;
 return jsonb_build_object('schema','awardping.program-text-source-registration-result.v1','cohort_key',v_cohort,
  'source_id',v_source.id,'acquisition_id',v_registration.acquisition_id,'source_url',v_url,
  'notification_mode','baseline_only','roles',v_roles_result);
exception when no_data_found then
 raise exception 'The reviewed registry, authority source, or role no longer exists.' using errcode='23503';
end;
$$;
-- SECURITY DEFINER is necessary for deterministic roster FOR UPDATE preflight:
-- service_role intentionally has SELECT only on that private authority table.
-- No direct table privileges or caller-controlled object names are introduced.
revoke all on function public.register_program_text_source(jsonb,text) from public,anon,authenticated;
grant execute on function public.register_program_text_source(jsonb,text) to service_role;
notify pgrst,'reload schema';
