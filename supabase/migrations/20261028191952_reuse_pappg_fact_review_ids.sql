-- PRIVATE PROPOSED: same-call bounded matching fact-review IDs; no persisted cache/table/index/grant.
-- Exact original retained-history bound stays first. At most2001IDs preserves every valid<=2000row;
-- 2001means original dependency sum necessarily exceeds2000 and takes the identical23514 guard.
DO $same_call_fact_ids$
DECLARE v_oid oid; v_before jsonb; v_after jsonb; v_actual text;
BEGIN
 v_oid:=to_regprocedure('private.awardping_pappg_canonical_foreign_projection(uuid)');
 IF v_oid IS NULL THEN RAISE EXCEPTION 'Foreign projection function absent.'; END IF;
 SELECT encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex'),to_jsonb(p)-'prosrc'
 INTO v_actual,v_before FROM pg_catalog.pg_proc p WHERE p.oid=v_oid;
 IF v_actual IS DISTINCT FROM '86ce093d67b1077f81002d0049cfb52af08b6f040c7e6174bf64b0d28897618d' THEN RAISE EXCEPTION 'Foreign projection preimage changed.' USING ERRCODE='40001'; END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION private.awardping_pappg_canonical_foreign_projection(p_source uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare s public.shared_award_sources%rowtype;history jsonb;activity jsonb;result jsonb;n bigint;fact_review_ids uuid[];
begin
 select * into strict s from public.shared_award_sources where id=p_source;
 if not exists(select 1 from private.awardping_pappg_canonical_catalogue() c where c.source_id=s.id and c.owner_id=s.shared_award_id)
  or s.url is distinct from 'https://www.nsf.gov/policies/pappg' then raise exception 'Foreign catalogue identity changed.' using errcode='40001';end if;
 select (select count(*) from public.shared_award_source_snapshots x where x.shared_award_source_id=s.id)
  +(select count(*) from public.shared_award_source_visual_snapshots x where x.shared_award_source_id=s.id)
  +(select count(*) from public.shared_award_visual_review_candidates x where x.shared_award_source_id=s.id)
  +(select count(*) from public.shared_award_change_events x where x.shared_award_source_id=s.id)
  +(select count(*) from public.shared_award_change_event_visual_evidence x where x.shared_award_source_id=s.id)
  into n;
 if n>2000 then raise exception 'Foreign retained-history bound exceeded.' using errcode='23514';end if;
 select coalesce(array_agg(m.id order by m.id),'{}'::uuid[]) into fact_review_ids
 from (select x.id from public.program_text_fact_reviews x where x.validation#>'{review,capture_refs}' @> jsonb_build_array(jsonb_build_object('source',jsonb_build_object('id',s.id)))
  order by x.id limit 2001) m;
 if (select count(*) from public.shared_award_source_acquisitions x where x.shared_award_source_id=s.id)
  +(select count(*) from public.program_text_source_approvals x where x.source_id=s.id)
  +(select count(*) from public.program_text_source_approval_events x join public.program_text_source_approvals a on a.id=x.approval_id where a.source_id=s.id)
  +(select count(*) from public.program_text_source_pending_requests x where x.source_id=s.id)
  +(select count(*) from public.program_text_source_roster x where s.id=any(x.source_ids))
  +(select count(*) from public.stage1_award_source_manifest x where s.id=any(x.source_ids))
  +(select count(*) from public.program_variation_scopes x where exists(select 1 from jsonb_array_elements(x.source_roles) r where r->'source_ids' ? s.id::text))
  +coalesce(cardinality(fact_review_ids),0)
  +(select count(*) from public.program_variation_unit_reviews x where x.validation#>'{review,capture_refs}' @> jsonb_build_array(jsonb_build_object('source',jsonb_build_object('id',s.id))))
  +(select count(*) from public.monitors x where x.shared_award_source_id=s.id)>2000
 then raise exception 'Foreign dependency activity bound exceeded.' using errcode='23514';end if;
 select jsonb_build_object(
  'snapshots',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.hash,x.source_url) order by x.id) from public.shared_award_source_snapshots x where x.shared_award_source_id=s.id),'[]'::jsonb),
  'visual',coalesce((select jsonb_agg(encode(extensions.digest(convert_to((to_jsonb(x)-'updated_at')::text,'UTF8'),'sha256'),'hex') order by (to_jsonb(x)-'updated_at')::text) from public.shared_award_source_visual_snapshots x where x.shared_award_source_id=s.id),'[]'::jsonb),
  'candidates',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.status,x.candidate_signature,x.previous_snapshot_ref,x.new_snapshot_ref,x.gemini_batch_name,x.model,encode(extensions.digest(convert_to(coalesce(x.ai_result,'null'::jsonb)::text,'UTF8'),'sha256'),'hex')) order by x.id) from public.shared_award_visual_review_candidates x where x.shared_award_source_id=s.id),'[]'::jsonb),
  'events',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.previous_snapshot_id,x.new_snapshot_id,x.previous_hash,x.new_hash) order by x.id) from public.shared_award_change_events x where x.shared_award_source_id=s.id),'[]'::jsonb),
  'event_evidence',coalesce((select jsonb_agg(encode(extensions.digest(convert_to((to_jsonb(x)-'verified_at'-'backfilled_at')::text,'UTF8'),'sha256'),'hex') order by x.change_event_id) from public.shared_award_change_event_visual_evidence x where x.shared_award_source_id=s.id),'[]'::jsonb)) into history;
 select jsonb_build_object(
  'acquisitions',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.acquisition_kind,x.notification_mode,
   encode(extensions.digest(convert_to(x.review_seal::text,'UTF8'),'sha256'),'hex'),encode(extensions.digest(convert_to(x.metadata::text,'UTF8'),'sha256'),'hex')) order by x.id) from public.shared_award_source_acquisitions x where x.shared_award_source_id=s.id),'[]'::jsonb),
  'approvals',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.epoch,x.content_hash,(select coalesce(jsonb_agg(jsonb_build_array(e.id,e.action) order by e.id),'[]'::jsonb) from public.program_text_source_approval_events e where e.approval_id=x.id)) order by x.id) from public.program_text_source_approvals x where x.source_id=s.id),'[]'::jsonb),
  'pending',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.epoch,x.content_hash) order by x.id) from public.program_text_source_pending_requests x where x.source_id=s.id),'[]'::jsonb),
  'text_roles',coalesce((select jsonb_agg(jsonb_build_array(x.cohort_key,x.source_role,x.revision) order by x.cohort_key,x.source_role) from public.program_text_source_roster x where s.id=any(x.source_ids)),'[]'::jsonb),
  'legacy_roles',coalesce((select jsonb_agg(jsonb_build_array(x.cohort_key,x.source_ids) order by x.cohort_key) from public.stage1_award_source_manifest x where s.id=any(x.source_ids)),'[]'::jsonb),
  'variation_scopes',coalesce((select jsonb_agg(jsonb_build_array(x.inventory_id,x.scope_key,x.retired) order by x.inventory_id,x.scope_key) from public.program_variation_scopes x where exists(select 1 from jsonb_array_elements(x.source_roles) r where r->'source_ids' ? s.id::text)),'[]'::jsonb),
  'fact_reviews',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.status,x.content_hash) order by x.id) from public.program_text_fact_reviews x where x.id=any(fact_review_ids)),'[]'::jsonb),
  'variation_reviews',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.content_hash) order by x.id) from public.program_variation_unit_reviews x where x.validation#>'{review,capture_refs}' @> jsonb_build_array(jsonb_build_object('source',jsonb_build_object('id',s.id)))),'[]'::jsonb),
  'monitors',coalesce((select jsonb_agg(jsonb_build_array(x.id,to_jsonb(x)->'status',to_jsonb(x)->'is_active') order by x.id) from public.monitors x where x.shared_award_source_id=s.id),'[]'::jsonb)) into activity;
 if octet_length(history::text)>4194304 or octet_length(activity::text)>262144 then raise exception 'Foreign evidence projection is too large.' using errcode='23514';end if;
 result:=jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type,
  'admin_review_status',s.admin_review_status,'text_monitoring_state',s.text_monitoring_state,'last_hash',s.last_hash,
  'page_metadata_sha256',private.awardping_pappg_canonical_page_metadata_hash(s.page_metadata),
  'owner_status',(select a.status from public.shared_awards a where a.id=s.shared_award_id),
  'memberships',coalesce((select jsonb_agg(jsonb_build_object('cohort_key',m.cohort_key,'member_kind',m.member_kind) order by m.cohort_key) from public.stage1_award_members m where m.shared_award_id=s.shared_award_id),'[]'::jsonb),
  'history_count',n,'history_sha256',encode(extensions.digest(convert_to(history::text,'UTF8'),'sha256'),'hex'),
  'activity',activity);
 if octet_length(result::text)>131072 then raise exception 'Foreign source projection is too large.' using errcode='23514';end if;
 return result;
end;
$function$
$definition$;
 SELECT encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex'),to_jsonb(p)-'prosrc'
 INTO v_actual,v_after FROM pg_catalog.pg_proc p WHERE p.oid=v_oid;
 IF v_actual IS DISTINCT FROM '2785e990a5bfed228c96a284e1a448ff0eb7eabe6a8ba3c56687bd115844f735' OR v_after IS DISTINCT FROM v_before
 THEN RAISE EXCEPTION 'Foreign projection postimage or metadata/ACL changed.'; END IF;
END;
$same_call_fact_ids$;
