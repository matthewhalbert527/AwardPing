-- PRIVATE SQL-only followup; no runtime/source/queue/history/owner mutation.
-- The scheduler observes the exact text dispatcher input set. Old visual rows,
-- finished owner reviews, failed rows, and in-flight processing remain history;
-- none are claimed, reclassified, suppressed, or retried by this projection.
DO $dispatch_scope_absent$ BEGIN
 IF pg_catalog.to_regprocedure('private.awardping_program_text_dispatch_scope_v1()') IS NOT NULL THEN RAISE EXCEPTION 'Dispatch scope helper already exists; review its policy before replacement.' USING ERRCODE='40001';END IF;
END;$dispatch_scope_absent$;
-- PRIVATE DRAFT. Owner-only observation helper; do not apply independently.
-- Role source provenance: live get_program_text_worker_roster_page body
-- SHA256 85fc2ce3671a5633a9559700696a40c26988d0b2d1e19133a30a7516bbf5910e.
create function private.awardping_program_text_dispatch_scope_v1()
returns jsonb language plpgsql stable security invoker set search_path = ''
as $dispatch_scope$
declare v_scope jsonb;
begin
 if (select pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p.prosrc,'UTF8'),'sha256'),'hex')
  from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure('public.get_program_text_worker_roster_page(text,jsonb,text,integer)'))
  is distinct from '85fc2ce3671a5633a9559700696a40c26988d0b2d1e19133a30a7516bbf5910e'
 then raise exception 'Program-text worker roster semantics changed; review dispatch health projection.' using errcode='40001'; end if;
-- PRIVATE DRAFT ONLY. No database changes. Append a SELECT to this CTE list.
-- Roles union is copied from the live get_program_text_worker_roster_page body
-- saved in health-projection-live-context.json (body SHA 85fc2ce3...).
-- Caller MUST fail if scope_contract.epoch_count <> 1, epoch differs from the
-- release's config/program-text-monitoring.json, or invalid_roster_count <> 0.
-- eligible_source_ids matches worker review source_ids, not mutation authority.
with active_inventories as (
  select i.* from public.program_variation_inventories i where i.status='sealed' and
   (exists(select 1 from public.program_variation_inventory_heads h where h.inventory_id=i.id and h.cohort_key=i.cohort_key and h.revision=i.revision)
    or exists(select 1 from public.program_variation_release release join public.program_variation_award_approvals approval
     on approval.id::text=release.approval_ids->>i.cohort_key where release.is_active and approval.inventory_id=i.id and approval.cohort_key=i.cohort_key))
 ),roles as (
  select r.cohort_key,'legacy_common'::text as scope_key,r.source_role,r.source_ids,r.manifest_status,r.evidence,r.revision,
   null::uuid as inventory_id,null::uuid as inventory_revision,null::text as cycle,null::text as variation_scope_key
  from public.program_text_source_roster r
  where not exists(select 1 from public.program_variation_inventory_heads h join public.program_variation_inventories i
   on i.id=h.inventory_id and i.cohort_key=h.cohort_key and i.revision=h.revision and i.status='sealed' where h.cohort_key=r.cohort_key)
  union all
  select i.cohort_key,'inventory_'||replace(i.id::text,'-','')||'_'||s.scope_key,role->>'source_role',
   array(select source_ids.source_id::uuid from jsonb_array_elements_text(role->'source_ids') as source_ids(source_id)),
   role->>'manifest_status',role->'evidence',(role->>'revision')::uuid,i.id,i.revision,i.cycle,s.scope_key
  from active_inventories i
  join public.program_variation_scopes s on s.inventory_id=i.id and not s.retired
  cross join lateral jsonb_array_elements(s.source_roles) role
  union all
  select role->>'cohort_key',role->>'scope_key',role->>'source_role',
   array(select source_ids.source_id::uuid from jsonb_array_elements_text(role->'source_ids') as source_ids(source_id)),role->>'manifest_status',role->'evidence',
   (role->>'revision')::uuid,(role->>'inventory_id')::uuid,(role->>'inventory_revision')::uuid,role->>'cycle',role->>'variation_scope_key'
  from jsonb_array_elements(private.awardping_program_text_registered_source_roles()) role
 ),active_epoch as (
  select count(*)::integer as epoch_count,
   case when count(*)=1 then (array_agg(epoch))[1] else null::uuid end as epoch
  from public.program_text_source_authority_epochs where active
 ),role_sources as (
  select r.*, source_id from roles r cross join lateral unnest(r.source_ids) source_id
 ),source_dtos as materialized (
  select s.id,s.shared_award_id,s.url,s.admin_review_status,e.epoch,
   private.awardping_program_text_source_approval_dto(s.id) as approvals,
   private.awardping_program_text_canonical_url_admission(s.id,e.epoch) as admission
  from public.shared_award_sources s cross join active_epoch e
  where exists(select 1 from role_sources r where r.source_id=s.id)
 ),canonical_access as (
  select s.*, case when s.id in (
   'de868fe8-54ba-4fa0-8210-b27c8f182112'::uuid,
   '19204933-2b56-42ac-96ee-b54213a2785a','27a2e7e7-d679-4b60-a9fb-300bbe33a94c',
   '29839757-599c-4758-873f-974380ca7e9d','3e5795a6-d0d0-4894-af01-b1abcfdee999',
   '5a952e53-9c66-4c0f-9c42-07eaef865011','73e4e932-cf63-47c4-a929-11a50e170728',
   '8ff84135-5a09-4873-ab89-28129e5d9cbf','a04ebac4-827b-423d-a79f-8bfdd5e24008',
   'ca7a2e0b-39aa-44ea-9cf3-3949fbcb8e4c')
   or lower(rtrim(split_part(s.url,'#',1),'/'))='https://www.nsf.gov/policies/pappg'
  then coalesce(s.id='de868fe8-54ba-4fa0-8210-b27c8f182112'::uuid
   and s.shared_award_id='d955a846-cee1-4c01-932e-e3cb7215f3fb'::uuid
   and s.url='https://www.nsf.gov/policies/pappg'
   and jsonb_typeof(s.admission)='object'
   and (select count(*) from jsonb_object_keys(s.admission))=10
   and s.admission ?& array['schema','source_id','shared_award_id','source_url','cohort_key','epoch','selected_source_id','revision','content_hash','current']
   and s.admission->>'schema'='awardping.program-text-canonical-url-admission.v1'
   and s.admission->'source_id'=to_jsonb(s.id::text)
   and s.admission->'shared_award_id'=to_jsonb(s.shared_award_id::text)
   and s.admission->'source_url'=to_jsonb(s.url)
   and s.admission->'epoch'=to_jsonb(s.epoch::text)
   and s.admission->'cohort_key'='"nsf_grfp"'::jsonb
   and s.admission->'selected_source_id'='"de868fe8-54ba-4fa0-8210-b27c8f182112"'::jsonb
   and jsonb_typeof(s.admission->'revision')='string'
   and s.admission->>'revision' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   and s.admission->>'revision'<>'00000000-0000-0000-0000-000000000000'
   and jsonb_typeof(s.admission->'content_hash')='string'
   and s.admission->>'content_hash' ~ '^[a-f0-9]{64}$'
   and s.admission->'current'='true'::jsonb,false)
  else true end as canonical_allowed,
  (s.id in ('de868fe8-54ba-4fa0-8210-b27c8f182112'::uuid,
   '19204933-2b56-42ac-96ee-b54213a2785a','27a2e7e7-d679-4b60-a9fb-300bbe33a94c',
   '29839757-599c-4758-873f-974380ca7e9d','3e5795a6-d0d0-4894-af01-b1abcfdee999',
   '5a952e53-9c66-4c0f-9c42-07eaef865011','73e4e932-cf63-47c4-a929-11a50e170728',
   '8ff84135-5a09-4873-ab89-28129e5d9cbf','a04ebac4-827b-423d-a79f-8bfdd5e24008',
   'ca7a2e0b-39aa-44ea-9cf3-3949fbcb8e4c')
   or lower(rtrim(split_part(s.url,'#',1),'/'))='https://www.nsf.gov/policies/pappg') as canonical_needed
  from source_dtos s
 ),role_access as (
  select r.source_id, coalesce(
   s.canonical_allowed and (not s.canonical_needed or r.cohort_key='nsf_grfp')
   and (s.admin_review_status='open' or s.admin_review_status='review_later' and exists(
    select 1 from jsonb_array_elements(s.approvals) proof
    where jsonb_typeof(proof)='object'
     and (select count(*) from jsonb_object_keys(proof))=9
     and proof ?& array['schema','id','source_id','shared_award_id','source_url','cohort_key','epoch','content_hash','current']
     and proof->>'schema'='awardping.program-text-source-approval.v1'
     and jsonb_typeof(proof->'id')='string'
     and proof->>'id' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
     and proof->>'id'<>'00000000-0000-0000-0000-000000000000'
     and proof->'source_id'=to_jsonb(s.id::text)
     and proof->'shared_award_id'=to_jsonb(s.shared_award_id::text)
     and proof->'source_url'=to_jsonb(s.url)
     and proof->'epoch'=to_jsonb(s.epoch::text)
     and proof->'cohort_key'=to_jsonb(r.cohort_key)
     and proof->>'cohort_key' ~ '^[a-z0-9_-]{1,80}$'
     and jsonb_typeof(proof->'content_hash')='string'
     and proof->>'content_hash' ~ '^[a-f0-9]{64}$'
     and proof->'current'='true'::jsonb))
   and r.manifest_status='reviewed_text'
   and r.revision is not null
   and r.evidence->>'schema'='awardping.program-text-source-role.v1'
   and r.evidence->'source_bindings'->(s.id::text)->'source_url'=to_jsonb(s.url)
   and r.evidence->'source_bindings'->(s.id::text)->'shared_award_id'=to_jsonb(s.shared_award_id::text),false) as allowed
  from role_sources r join canonical_access s on s.id=r.source_id
 ),eligible_source_ids as (
  select source_id from role_access group by source_id having bool_and(allowed)
 ),scope_contract as (
  select e.epoch_count,e.epoch,
   (select count(*) from roles)::integer as role_count,
   (select count(distinct source_id) from role_sources)::integer as roster_source_count,
   (select count(*) from eligible_source_ids)::integer as eligible_source_count,
   ((select count(*) from roles r where cardinality(r.source_ids) not between 1 and 50
      or coalesce(r.cohort_key !~ '^[a-z0-9_-]{1,80}$',true)
      or coalesce(r.scope_key !~ '^[a-z0-9_-]{1,200}$',true)
      or coalesce(r.source_role !~ '^[a-z0-9_-]{1,80}$',true)
      or r.source_ids is null or exists(select 1 from unnest(r.source_ids) x where x is null)
      or cardinality(r.source_ids)<>(select count(distinct x) from unnest(r.source_ids) x))
    +(select count(*) from (select cohort_key,scope_key,source_role from roles group by 1,2,3 having count(*)<>1) duplicate_roles)
    +(select count(*) from (select distinct source_id from role_sources) ids left join public.shared_award_sources s on s.id=ids.source_id
      where s.id is null or s.shared_award_id is null or s.url is null)
    +case when (select count(distinct cohort_key) from roles)<>(select count(*) from public.program_award_registry) then 1 else 0 end)::integer as invalid_roster_count
  from active_epoch e
 )

 select to_jsonb(scope_contract) || jsonb_build_object('source_ids',
  coalesce((select jsonb_agg(source_id order by source_id) from eligible_source_ids),'[]'::jsonb))
 into strict v_scope from scope_contract;
 if (v_scope->>'epoch_count')::integer <> 1
  or (v_scope->>'epoch')::uuid is distinct from 'ec349339-ff62-4d2e-a610-8c361b4044ec'::uuid
  or (v_scope->>'invalid_roster_count')::integer <> 0
  or (v_scope->>'role_count')::integer < 1
  or (v_scope->>'roster_source_count')::integer < 1
 then raise exception 'Program-text dispatch scope is missing or invalid.' using errcode='23514'; end if;
 return jsonb_build_object('schema','awardping.program-text-dispatch-scope.v1') || v_scope;
end;
$dispatch_scope$;
revoke all on function private.awardping_program_text_dispatch_scope_v1() from public,anon,authenticated,service_role;

DO $dispatch_status_projection$
DECLARE target oid:='public.list_monitoring_downstream_lane_status()'::regprocedure;definition text;old_body text;next_body text;before_catalog jsonb;after_catalog jsonb;
BEGIN
 SELECT pg_get_functiondef(p.oid),p.prosrc,to_jsonb(p)-'prosrc' INTO STRICT definition,old_body,before_catalog FROM pg_catalog.pg_proc p WHERE p.oid=target;
 IF encode(extensions.digest(convert_to(old_body,'UTF8'),'sha256'),'hex')<>'2133c384a7aa7338faa8bec4d6d073f387b91c51219f94d4e71e38a4ae15222c' THEN RAISE EXCEPTION 'Consolidated status preimage changed.' USING ERRCODE='40001';END IF;
 next_body:=replace(old_body,$old_dispatch_queue$  visual_queue as (
    select
      count(*)::bigint as queue_depth,
      min(candidate.created_at) as oldest_item_at
    from public.shared_award_visual_review_candidates candidate
    where candidate.candidate_scope <> 'initial_official_document'
      and (
        candidate.status in ('pending', 'submitted', 'processing', 'succeeded')
        or (
          candidate.status = 'failed'
          and lower(pg_catalog.btrim(coalesce(candidate.rejection_reason, ''))) =
            'missing_batch_response'
        )
      )
  ),
$old_dispatch_queue$,$new_dispatch_queue$  dispatch_scope as materialized (
    select private.awardping_program_text_dispatch_scope_v1() as scope
  ),
  visual_queue as (
    select count(*)::bigint as queue_depth,min(candidate.created_at) as oldest_item_at
    from public.shared_award_visual_review_candidates candidate cross join dispatch_scope
    where candidate.candidate_scope='program_text_change'
      and candidate.worker_metadata->>'epoch'=dispatch_scope.scope->>'epoch'
      and candidate.worker_metadata->>'admin_alert_review_id' is null
      and candidate.status in ('pending','submitted','succeeded')
      and candidate.shared_award_source_id in (
        select source_id::uuid from jsonb_array_elements_text(dispatch_scope.scope->'source_ids') ids(source_id)
      )
  ),
$new_dispatch_queue$);
 IF encode(extensions.digest(convert_to(next_body,'UTF8'),'sha256'),'hex')<>'94e7ca27ffd45191a8115e0ef31195e22eedfbe1aeb6f69e96716c3e2260e8cb' THEN RAISE EXCEPTION 'Dispatch queue projection differs.' USING ERRCODE='40001';END IF;
 EXECUTE replace(definition,old_body,next_body);
 SELECT to_jsonb(p)-'prosrc' INTO STRICT after_catalog FROM pg_catalog.pg_proc p WHERE p.oid=target;
 IF after_catalog IS DISTINCT FROM before_catalog THEN RAISE EXCEPTION 'Status function privilege/catalog contract changed.' USING ERRCODE='55000';END IF;
END;$dispatch_status_projection$;
