-- Separate, explicit human-reviewed official-origin source admission. This never
-- claims a hyperlink witness, approves facts, seeds baselines or edits old sources.
-- This is a private service operation, not an authenticated HTTP action. The
-- service caller cold-restores the original and records the actual authorized
-- human's existing auth UUID; no browser session or hyperlink is asserted.
create function public.admit_reviewed_official_program_text_source(p_proposal jsonb,p_document jsonb,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 src jsonb:=p_proposal->'source';review jsonb:=p_proposal->'review';ref jsonb:=p_document->'reference';
 registry public.stage1_award_registry%rowtype;role public.program_text_source_roster%rowtype;
 prior public.program_text_source_approvals%rowtype;change jsonb;old_role jsonb;updated_role jsonb;
 source_id uuid;approval_id uuid;owner_id uuid;policy_epoch uuid;expected_ids uuid[];next_ids uuid[];sid uuid;
 validation jsonb;proof_hash text;bindings jsonb;roles_result jsonb:='[]'::jsonb;additions integer:=0;
 source_url text;official_origin text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if private.awardping_program_exact_object(p_proposal,array['schema','id','cohort_key','epoch','expected_canonical_shared_award_id','expected_official_homepage','source','roles','registration_scope','review']) is distinct from true
  or p_proposal->>'schema' is distinct from 'awardping.explicit-official-source-admission.v1'
  or private.awardping_program_exact_object(src,array['id','shared_award_id','url','title','page_type']) is distinct from true
  or private.awardping_program_exact_object(review,array['actor_id','reason','purpose','reviewed_at']) is distinct from true
  or p_proposal->'registration_scope' is distinct from '{"kind":"legacy_roles"}'::jsonb
  or octet_length(p_proposal::text)>262144 or octet_length(p_document::text)>16777216
  or coalesce(p_proposal->>'id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  or coalesce(src->>'id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  or coalesce(src->>'shared_award_id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  or coalesce(p_proposal->>'cohort_key','') !~ '^[a-z0-9_-]{1,80}$'
  or p_actor is null or p_actor='00000000-0000-0000-0000-000000000000' or review->>'actor_id' is distinct from p_actor::text
  or not exists(select 1 from auth.users where id=p_actor)
  or jsonb_typeof(review->'reason') is distinct from 'string' or length(btrim(coalesce(review->>'reason',''))) not between 20 and 2000
  or jsonb_typeof(review->'purpose') is distinct from 'string' or length(btrim(coalesce(review->>'purpose',''))) not between 20 and 2000
  or coalesce(review->>'reviewed_at','') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
  or jsonb_typeof(src->'title') is distinct from 'string' or length(btrim(coalesce(src->>'title',''))) not between 1 and 1000
  or coalesce(src->>'page_type','') not in ('homepage','deadline','application','eligibility','requirements','pdf','faq','other')
  or jsonb_typeof(p_proposal->'roles') is distinct from 'array'
 then raise exception 'Invalid explicit official-source review.' using errcode='23514';end if;
 source_id:=(src->>'id')::uuid;approval_id:=(p_proposal->>'id')::uuid;owner_id:=(src->>'shared_award_id')::uuid;source_url:=src->>'url';
 if source_id='00000000-0000-0000-0000-000000000000' or approval_id='00000000-0000-0000-0000-000000000000' then
  raise exception 'Real unused identities required.' using errcode='23514';end if;
 validation:=jsonb_build_object('schema','awardping.explicit-official-source-admission-validation.v1','proposal',p_proposal,'target_document',p_document);
 proof_hash:=private.awardping_program_text_source_alias_proof_hash(validation,'[]'::jsonb);
 select * into prior from public.program_text_source_approvals where id=approval_id;
 if found then
  if prior.validation is distinct from validation or prior.content_hash is distinct from proof_hash or prior.approved_by is distinct from p_actor::text
   or exists(select 1 from public.program_text_source_approval_events e where e.approval_id=prior.id and e.action='revoked') then
   raise exception 'Admission identity reused or revoked; inspect current state.' using errcode='40001';end if;
  return jsonb_build_object('id',prior.id,'source_id',prior.source_id,'content_hash',prior.content_hash,'roles',prior.role_receipts,'idempotent',true);
 end if;
 if (review->>'reviewed_at')::timestamptz>clock_timestamp() or (review->>'reviewed_at')::timestamptz<clock_timestamp()-interval '15 minutes' then
  raise exception 'Fresh completed human review required.' using errcode='23514';end if;
 -- Freeze the global normalized collision boundary through insertion. Never reuse
 -- an existing identity, title, status, monitoring history or foreign owner here.
 lock table public.shared_award_sources in share row exclusive mode nowait;
 lock table public.stage1_award_members in share mode nowait;
 select * into strict registry from public.stage1_award_registry where cohort_key=p_proposal->>'cohort_key' for share;
 select epoch into strict policy_epoch from public.program_text_source_authority_epochs where active for share;
 official_origin:=substring(registry.official_homepage from '^https://[a-z0-9.-]+');
 if p_proposal->>'epoch' is distinct from policy_epoch::text
  or p_proposal->>'expected_canonical_shared_award_id' is distinct from registry.canonical_shared_award_id::text
  or owner_id is distinct from registry.canonical_shared_award_id
  or p_proposal->>'expected_official_homepage' is distinct from registry.official_homepage
  or not coalesce(registry.official_homepage ~ '^https://[a-z0-9.-]+(/[A-Za-z0-9_./-]*)?$',false)
  or not coalesce(source_url ~ '^https://[a-z0-9.-]+(/[A-Za-z0-9_./-]*)?$',false)
  or substring(source_url from '^https://[a-z0-9.-]+') is distinct from official_origin
  or source_url like '%/../%' or source_url like '%/./%' or source_url ~ '/\.\.?$'
  or not exists(select 1 from public.stage1_award_members m join public.shared_awards a on a.id=m.shared_award_id and a.status='active'
    where m.cohort_key=registry.cohort_key and m.shared_award_id=owner_id and m.member_kind='canonical')
  or exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=registry.cohort_key and
    ((r.url_pattern is not null and source_url ~* r.url_pattern) or (r.title_pattern is not null and src->>'title' ~* r.title_pattern)))
  or exists(select 1 from public.program_variation_inventory_heads h join public.program_variation_inventories i on i.id=h.inventory_id
    and i.revision=h.revision and i.status='sealed' where h.cohort_key=registry.cohort_key)
  or private.awardping_pappg_canonical_known(source_id,source_url)
 then raise exception 'Exact current canonical official-origin legacy scope required.' using errcode='23514';end if;
 if exists(select 1 from public.shared_award_sources where id=source_id or
   lower(regexp_replace(split_part(url,'#',1),'/+$',''))=lower(regexp_replace(source_url,'/+$','')))
  or exists(select 1 from public.program_text_source_pending_requests p where p.id=approval_id)
 then raise exception 'Existing source or pending identity must be preserved; this path admits new sources only.' using errcode='23505';end if;
 if private.awardping_program_source_approval_document_valid(p_document) is distinct from true
  or ref->'source' is distinct from src or ref->>'final_url' is distinct from source_url
  or coalesce(ref->>'acquisition','') not in ('http_html','pdf_text')
  or (ref->>'captured_at')::timestamptz>(review->>'reviewed_at')::timestamptz or (ref->>'captured_at')::timestamptz<clock_timestamp()-interval '7 days'
 then raise exception 'Complete fresh cold exact-target proof required.' using errcode='23514';end if;
 if jsonb_array_length(p_proposal->'roles') not between 1 and 50
  or jsonb_array_length(p_proposal->'roles')<>(select count(*) from public.program_text_source_roster where cohort_key=registry.cohort_key)
  or (select count(distinct r->>'source_role') from jsonb_array_elements(p_proposal->'roles') r)<>jsonb_array_length(p_proposal->'roles')
 then raise exception 'Entire current role snapshot required.' using errcode='23514';end if;
 for change in select value from jsonb_array_elements(p_proposal->'roles') order by value->>'source_role' loop
  if private.awardping_program_exact_object(change,array['source_role','expected_revision','expected_source_ids','next_source_ids']) is distinct from true
   or coalesce(change->>'source_role','') !~ '^[a-z][a-z0-9_]{0,79}$'
   or coalesce(change->>'expected_revision','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   or jsonb_typeof(change->'expected_source_ids') is distinct from 'array' or jsonb_typeof(change->'next_source_ids') is distinct from 'array'
   or jsonb_array_length(change->'expected_source_ids') not between 1 and 50 or jsonb_array_length(change->'next_source_ids') not between 1 and 50
  then raise exception 'Exact bounded role CAS required.' using errcode='23514';end if;
  select array_agg(x::uuid order by ord) into expected_ids from jsonb_array_elements_text(change->'expected_source_ids') with ordinality a(x,ord);
  select array_agg(x::uuid order by ord) into next_ids from jsonb_array_elements_text(change->'next_source_ids') with ordinality a(x,ord);
  select * into strict role from public.program_text_source_roster where cohort_key=registry.cohort_key and source_role=change->>'source_role' for update;
  if role.revision::text is distinct from change->>'expected_revision' or role.source_ids is distinct from expected_ids
   or source_id=any(expected_ids) or cardinality(expected_ids)<>(select count(distinct x) from unnest(expected_ids) x)
   or cardinality(next_ids)<>(select count(distinct x) from unnest(next_ids) x)
   or (next_ids is distinct from expected_ids and next_ids is distinct from array_append(expected_ids,source_id)) then
   raise exception 'Only exact ordered source append is permitted.' using errcode='40001';end if;
  if next_ids is distinct from expected_ids then additions:=additions+1;end if;
  foreach sid in array expected_ids loop
   if private.awardping_program_text_source_access(sid,registry.cohort_key,policy_epoch) is distinct from true or not exists(select 1 from public.shared_award_sources s
     where s.id=sid and role.evidence#>>array['source_bindings',sid::text,'source_url']=s.url
      and role.evidence#>>array['source_bindings',sid::text,'shared_award_id']=s.shared_award_id::text) then
    raise exception 'Retained source authority changed.' using errcode='40001';end if;
  end loop;
 end loop;
 if additions=0 then raise exception 'At least one explicit source role addition required.' using errcode='23514';end if;
 insert into public.shared_award_sources(id,shared_award_id,url,title,page_type,source,confidence,reason,admin_review_status)
 values(source_id,owner_id,source_url,src->>'title',src->>'page_type','admin',1,'Explicit human-reviewed official source; silent independent first coverage required.','review_later');
 for change in select value from jsonb_array_elements(p_proposal->'roles') order by value->>'source_role' loop
  if change->'expected_source_ids'=change->'next_source_ids' then continue;end if;
  select * into strict role from public.program_text_source_roster where cohort_key=registry.cohort_key and source_role=change->>'source_role';old_role:=to_jsonb(role);
  select array_agg(x::uuid order by ord) into next_ids from jsonb_array_elements_text(change->'next_source_ids') with ordinality a(x,ord);
  bindings:=coalesce(role.evidence->'source_bindings','{}'::jsonb)||jsonb_build_object(source_id::text,jsonb_build_object(
    'source_url',source_url,'shared_award_id',owner_id,'authority_url',registry.official_homepage,
    'review_note','Explicit official-origin target review; no hyperlink provenance claimed. '||(review->>'purpose')));
  update public.program_text_source_roster set source_ids=next_ids,evidence=role.evidence||jsonb_build_object('source_bindings',bindings),
   revision=gen_random_uuid(),reviewed_by=p_actor::text,reviewed_at=clock_timestamp() where cohort_key=registry.cohort_key and source_role=role.source_role
   returning to_jsonb(program_text_source_roster.*) into updated_role;
  insert into public.program_text_source_roster_events(cohort_key,source_role,previous_entry,next_entry,reviewed_by) values(registry.cohort_key,role.source_role,old_role,updated_role,p_actor::text);
  roles_result:=roles_result||jsonb_build_array(updated_role);
 end loop;
 insert into public.program_text_source_approvals(id,source_id,cohort_key,epoch,shared_award_id,source_url,content_hash,validation,role_receipts,url_alias_boundary,approved_by)
 values(approval_id,source_id,registry.cohort_key,policy_epoch,owner_id,source_url,proof_hash,validation,roles_result,'[]'::jsonb,p_actor::text);
 insert into public.program_text_source_approval_events(approval_id,action,actor,reason) values(approval_id,'approved',p_actor::text,
  'Explicit human-reviewed collection only; no hyperlink proof, facts, baseline, alert decision or publication. '||(review->>'reason'));
 return jsonb_build_object('id',approval_id,'source_id',source_id,'content_hash',proof_hash,'roles',roles_result,'idempotent',false);
end;
$$;
revoke all on function public.admit_reviewed_official_program_text_source(jsonb,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admit_reviewed_official_program_text_source(jsonb,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
