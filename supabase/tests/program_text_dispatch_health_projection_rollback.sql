-- Linked-database regression after program_text_dispatch_health_projection.
-- Requires the reviewed current worker roster. All fixtures use pg_temp; all
-- function substitutions and temporary objects unconditionally roll back.
-- No worker is invoked and no public candidate, source, role, owner, history,
-- lane-state, budget, or fact row is updated by this test.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL search_path='';SET LOCAL TIME ZONE 'UTC';SET LOCAL statement_timeout='20s';SET LOCAL lock_timeout='1s';SET LOCAL idle_in_transaction_session_timeout='30s';SET LOCAL plpgsql.check_asserts=on;SET LOCAL application_name='ap-dispatch-health-regression';
CREATE TEMP TABLE dispatch_regression_before_functions ON COMMIT DROP AS SELECT p.oid,to_jsonb(p) value FROM pg_catalog.pg_proc p WHERE p.oid IN ('public.list_monitoring_downstream_lane_status()'::regprocedure,'private.awardping_program_text_dispatch_scope_v1()'::regprocedure);
CREATE TEMP TABLE dispatch_regression_before_states ON COMMIT DROP AS SELECT lane_key,to_jsonb(s) value FROM public.monitoring_downstream_lane_state s;
CREATE TEMP TABLE dispatch_regression_before_lanes ON COMMIT DROP AS SELECT lane_key,to_jsonb(l) value FROM public.monitoring_downstream_lanes l;
CREATE TEMP TABLE dispatch_regression_before_budget ON COMMIT DROP AS SELECT jsonb_agg(to_jsonb(b) ORDER BY lane_key) value FROM public.gemini_paid_lanes b;
CREATE TEMP TABLE dispatch_regression_before_candidates ON COMMIT DROP AS SELECT count(*) n,max(updated_at) last_updated FROM public.shared_award_visual_review_candidates;
CREATE TEMP TABLE dispatch_regression_before_history ON COMMIT DROP AS SELECT lane_key,count(*) n,max(updated_at) last_updated FROM public.monitoring_downstream_lane_runs GROUP BY lane_key;
CREATE TEMP TABLE dispatch_regression_before_heads ON COMMIT DROP AS SELECT jsonb_agg(jsonb_build_object('cohort_key',cohort_key,'snapshot_id',snapshot_id) ORDER BY cohort_key) value FROM public.program_basic_fact_heads;
-- PRIVATE native fixture fragment only. Root wrapper owns BEGIN/ROLLBACK,
-- real-RPC timing before this fragment, and public-data/catalog preservation.
-- All fixture rows and mutations target pg_temp only. Function substitutions
-- are transient in the enclosing rollback transaction and restored below.
create temporary table ap_dispatch_fixture_defs(kind text primary key,definition text not null,body text not null) on commit drop;
insert into pg_temp.ap_dispatch_fixture_defs
 select 'status',pg_catalog.pg_get_functiondef(p.oid),p.prosrc from pg_catalog.pg_proc p
 where p.oid='public.list_monitoring_downstream_lane_status()'::regprocedure
 union all
 select 'scope',pg_catalog.pg_get_functiondef(p.oid),p.prosrc from pg_catalog.pg_proc p
 where p.oid='private.awardping_program_text_dispatch_scope_v1()'::regprocedure;
create temporary table ap_dispatch_fixture_results(name text primary key,details jsonb not null) on commit drop;
create temporary table ap_dispatch_scope_cache on commit drop as
 select private.awardping_program_text_dispatch_scope_v1() as scope;
create temporary table ap_dispatch_candidate_fixture on commit drop as
 select * from public.shared_award_visual_review_candidates where false;

do $install_dispatch_fixture_adapters$
declare d record;next_body text;occurrences integer;
begin
 select * into strict d from pg_temp.ap_dispatch_fixture_defs where kind='status';
 occurrences:=(length(d.body)-length(replace(d.body,'public.shared_award_visual_review_candidates','')))/length('public.shared_award_visual_review_candidates');
 if occurrences<>2 then raise exception 'Status candidate relation references changed.' using errcode='40001';end if;
 next_body:=replace(d.body,'public.shared_award_visual_review_candidates','pg_temp.ap_dispatch_candidate_fixture');
 execute replace(d.definition,d.body,next_body);
 select * into strict d from pg_temp.ap_dispatch_fixture_defs where kind='scope';
 next_body:='begin return (select scope from pg_temp.ap_dispatch_scope_cache);end;';
 execute replace(d.definition,d.body,next_body);
end;$install_dispatch_fixture_adapters$;

do $dispatch_future_predicate_cases$
declare cached jsonb;source_id uuid;active_epoch text;candidate_id uuid:='11111111-1111-4111-8111-111111111111';
 case_row record;lane record;metadata jsonb;created timestamptz:='2000-01-01 00:00:00+00';
begin
 select scope into strict cached from pg_temp.ap_dispatch_scope_cache;
 source_id:=(cached->'source_ids'->>0)::uuid;active_epoch:=cached->>'epoch';
 if source_id is null or cached->'source_ids' @> '["00000000-0000-0000-0000-000000000000"]'::jsonb then
  raise exception 'Fixture needs one eligible source and a distinct excluded sentinel.';end if;
 for case_row in select * from (values
  ('pending','program_text_change','pending','current','eligible','absent',1),
  ('submitted','program_text_change','submitted','current','eligible','absent',1),
  ('succeeded','program_text_change','succeeded','current','eligible','absent',1),
  ('json_null_owner','program_text_change','pending','current','eligible','json_null',1),
  ('wrong_epoch','program_text_change','pending','old','eligible','absent',0),
  ('missing_epoch','program_text_change','pending','absent','eligible','absent',0),
  ('outside_roster','program_text_change','pending','current','outside','absent',0),
  ('owner_review_pending','program_text_change','pending','current','eligible','reference',0),
  ('owner_review_succeeded','program_text_change','succeeded','current','eligible','reference',0),
  ('empty_owner_reference','program_text_change','pending','current','eligible','empty',0),
  ('legacy_content_change','content_change','succeeded','current','eligible','absent',0),
  ('initial_official_document','initial_official_document','pending','current','eligible','absent',0),
  ('processing_is_not_retryable','program_text_change','processing','current','eligible','absent',0),
  ('failed_missing_batch_is_not_retryable','program_text_change','failed','current','eligible','absent',0),
  ('published_is_terminal','program_text_change','published','current','eligible','absent',0),
  ('rejected_is_terminal','program_text_change','rejected','current','eligible','absent',0)
 ) cases(name,candidate_scope,status,epoch_kind,source_kind,owner_kind,expected)
 loop
  truncate pg_temp.ap_dispatch_candidate_fixture;
  metadata:=case case_row.epoch_kind when 'current' then jsonb_build_object('epoch',active_epoch)
   when 'old' then jsonb_build_object('epoch','22222222-2222-4222-8222-222222222222') else '{}'::jsonb end;
  if case_row.owner_kind='reference' then metadata:=metadata||jsonb_build_object('admin_alert_review_id',candidate_id::text);
  elsif case_row.owner_kind='json_null' then metadata:=metadata||jsonb_build_object('admin_alert_review_id',null);
  elsif case_row.owner_kind='empty' then metadata:=metadata||jsonb_build_object('admin_alert_review_id','');end if;
  insert into pg_temp.ap_dispatch_candidate_fixture(id,shared_award_source_id,candidate_scope,status,worker_metadata,created_at,rejection_reason)
   values(candidate_id,case when case_row.source_kind='eligible' then source_id else '00000000-0000-0000-0000-000000000000'::uuid end,
    case_row.candidate_scope,case_row.status,metadata,created,'missing_batch_response');
  select * into strict lane from public.list_monitoring_downstream_lane_status() where lane_key='changed_page_review';
  if lane.queue_depth<>case_row.expected or lane.oldest_item_at is distinct from (case when case_row.expected=1 then created else null::timestamptz end)
   or lane.sla_breached is distinct from (case_row.expected=1)
  then raise exception 'Future dispatch fixture failed: %.',case_row.name;end if;
  insert into pg_temp.ap_dispatch_fixture_results values(case_row.name,jsonb_build_object('queue_depth',lane.queue_depth,'oldest_item_at',lane.oldest_item_at,'sla_breached',lane.sla_breached));
 end loop;
end;$dispatch_future_predicate_cases$;

-- Restore real functions before testing real roster validation in a temp clone.
do $restore_real_dispatch_after_predicates$
declare d record;begin for d in select * from pg_temp.ap_dispatch_fixture_defs order by kind loop execute d.definition;end loop;end;
$restore_real_dispatch_after_predicates$;

-- Clone the ACTUAL complete role union, rather than the legacy roster table
-- alone: sealed inventories can shadow every legacy_common row. This isolates
-- the exact same global role validation for legacy, inventory, and registered
-- sources, while keeping all public role/inventory/source tables untouched.
do $clone_current_dispatch_roles$
declare d record;start_at integer;epoch_at integer;role_prefix text;next_body text;baseline jsonb;
begin
 select * into strict d from pg_temp.ap_dispatch_fixture_defs where kind='scope';
 start_at:=strpos(d.body,'with active_inventories as (');epoch_at:=strpos(d.body,' ),active_epoch as (');
 if start_at<1 or epoch_at<=start_at then raise exception 'Scope role-union fixture anchors changed.' using errcode='40001';end if;
 role_prefix:=substr(d.body,start_at,epoch_at-start_at)||' )';
 execute 'create temporary table ap_dispatch_role_fixture on commit drop as '||role_prefix||' select * from roles';
 next_body:=replace(d.body,role_prefix,'with roles as (select * from pg_temp.ap_dispatch_role_fixture)');
 if next_body=d.body then raise exception 'Scope fixture did not replace exact role union.';end if;
 execute replace(d.definition,d.body,next_body);
 baseline:=private.awardping_program_text_dispatch_scope_v1();
 if baseline is distinct from (select scope from pg_temp.ap_dispatch_scope_cache) then raise exception 'Temp role clone differs from real dispatch scope.';end if;
 insert into pg_temp.ap_dispatch_fixture_results values('exact_current_role_clone',jsonb_build_object('equal',true,'role_count',baseline->'role_count'));
end;$clone_current_dispatch_roles$;

do $dispatch_invalid_roster_case$
declare changed integer;begin
 update pg_temp.ap_dispatch_role_fixture set source_ids='{}'::uuid[] where ctid=(select ctid from pg_temp.ap_dispatch_role_fixture limit 1);
 get diagnostics changed=row_count;if changed<>1 then raise exception 'Invalid-roster fixture changed unexpected row count.';end if;
 begin
  perform private.awardping_program_text_dispatch_scope_v1();
  raise exception 'Invalid empty source_ids was accepted.' using errcode='P0001';
 exception when sqlstate '23514' then
  insert into pg_temp.ap_dispatch_fixture_results values('invalid_empty_role_source_ids',jsonb_build_object('expected_sqlstate','23514','public_rows_changed',0));
 end;
end;$dispatch_invalid_roster_case$;

-- Restore the real helper/status bodies and assert their exact definitions.
do $restore_dispatch_fixture_definitions$
declare d record;oid_now oid;begin
 for d in select * from pg_temp.ap_dispatch_fixture_defs order by kind loop
  execute d.definition;
  oid_now:=case d.kind when 'status' then 'public.list_monitoring_downstream_lane_status()'::regprocedure
   else 'private.awardping_program_text_dispatch_scope_v1()'::regprocedure end;
  if pg_catalog.pg_get_functiondef(oid_now) is distinct from d.definition then raise exception 'Fixture function restoration differs: %.',d.kind;end if;
 end loop;
end;$restore_dispatch_fixture_definitions$;

DO $dispatch_regression_public_preservation$
BEGIN
 ASSERT NOT EXISTS(SELECT 1 FROM pg_temp.dispatch_regression_before_functions b JOIN pg_catalog.pg_proc p USING(oid) WHERE to_jsonb(p) IS DISTINCT FROM b.value),'both exact function catalogs/bodies restored';
 ASSERT NOT EXISTS(SELECT 1 FROM pg_temp.dispatch_regression_before_states b FULL JOIN public.monitoring_downstream_lane_state s USING(lane_key) WHERE b.value IS DISTINCT FROM to_jsonb(s)),'no actual lane-state writes';
 ASSERT NOT EXISTS(SELECT 1 FROM pg_temp.dispatch_regression_before_lanes b FULL JOIN public.monitoring_downstream_lanes l USING(lane_key) WHERE b.value IS DISTINCT FROM to_jsonb(l)),'no actual enabled/SLA/lease/timeout/mapping writes';
 ASSERT (SELECT jsonb_agg(to_jsonb(b) ORDER BY lane_key) FROM public.gemini_paid_lanes b)=(SELECT value FROM pg_temp.dispatch_regression_before_budget),'no paid-budget configuration writes';
 ASSERT (SELECT jsonb_build_object('n',count(*),'last_updated',max(updated_at)) FROM public.shared_award_visual_review_candidates)=(SELECT to_jsonb(b) FROM pg_temp.dispatch_regression_before_candidates b),'no actual candidate creation/status/relabel writes';
 ASSERT NOT EXISTS(SELECT 1 FROM pg_temp.dispatch_regression_before_history b FULL JOIN (SELECT lane_key,count(*) n,max(updated_at) last_updated FROM public.monitoring_downstream_lane_runs GROUP BY lane_key) h USING(lane_key) WHERE to_jsonb(b) IS DISTINCT FROM to_jsonb(h)),'no actual run-history writes';
 ASSERT (SELECT jsonb_agg(jsonb_build_object('cohort_key',cohort_key,'snapshot_id',snapshot_id) ORDER BY cohort_key) FROM public.program_basic_fact_heads)=(SELECT value FROM pg_temp.dispatch_regression_before_heads),'all actual fact-head identities preserved';
 ASSERT has_function_privilege('service_role','public.list_monitoring_downstream_lane_status()','EXECUTE') AND NOT has_function_privilege('anon','public.list_monitoring_downstream_lane_status()','EXECUTE') AND NOT has_function_privilege('authenticated','public.list_monitoring_downstream_lane_status()','EXECUTE'),'status privileged RPC boundary preserved';
 ASSERT NOT has_function_privilege('service_role','private.awardping_program_text_dispatch_scope_v1()','EXECUTE') AND NOT has_function_privilege('anon','private.awardping_program_text_dispatch_scope_v1()','EXECUTE') AND NOT has_function_privilege('authenticated','private.awardping_program_text_dispatch_scope_v1()','EXECUTE'),'scope helper remains owner-only';
END;$dispatch_regression_public_preservation$;
SELECT jsonb_build_object('status','PASS','cases',(SELECT jsonb_object_agg(name,details ORDER BY name) FROM pg_temp.ap_dispatch_fixture_results),'public_rows_changed',0,'transaction','ROLLBACK') result;
ROLLBACK;
