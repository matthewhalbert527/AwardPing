-- Execute after the migration inside an unconditional ROLLBACK transaction.
-- The native harness captures before_lanes, before_states, before_history and
-- before_functions before embedding the exact migration. No worker is started.
CREATE TEMP TABLE consolidation_test_results(name text PRIMARY KEY,passed boolean NOT NULL) ON COMMIT DROP;

DO $catalog_preservation_test$
BEGIN
 ASSERT NOT EXISTS(SELECT 1 FROM pg_temp.before_functions b JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(b.signature)
  WHERE to_jsonb(p)-'prosrc' IS DISTINCT FROM b.row-'prosrc'),'all function identities/owners/ACLs/signatures/security/config preserved';
 ASSERT NOT EXISTS(SELECT 1 FROM pg_temp.before_functions b JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(b.signature)
  WHERE b.signature NOT IN ('public.list_monitoring_downstream_lane_status()','private.stage1_downstream_lane_sla_contract_valid(text,bigint,bigint,bigint,timestamptz,timestamptz)','private.stage1_gate_without_contact_fence_20260717123000(timestamptz)')
   AND to_jsonb(p) IS DISTINCT FROM b.row),'all unrelated privileged function bodies preserved';
 INSERT INTO pg_temp.consolidation_test_results VALUES('all_function_catalog_and_unrelated_bodies_preserved',true);
END;$catalog_preservation_test$;

DO $consolidated_registry_test$
DECLARE actual text[];lane text;claimed jsonb;
BEGIN
 SELECT array_agg(lane_key ORDER BY lane_key) INTO actual FROM public.list_monitoring_downstream_lane_status();
 ASSERT actual=ARRAY['changed_page_review','nightly_report','page_audit']::text[],'status must return exactly three active lanes';
 ASSERT (SELECT display_name='Coverage report' FROM public.monitoring_downstream_lanes WHERE lane_key='nightly_report'),'stable report key has Coverage report label';
 ASSERT (SELECT count(*)=8 FROM public.monitoring_downstream_lanes),'retired registry rows are preserved';
 ASSERT NOT EXISTS(SELECT 1 FROM public.monitoring_downstream_lanes l JOIN pg_temp.before_lanes b USING(lane_key)
  WHERE to_jsonb(l)-'enabled'-'display_name'-'updated_at' IS DISTINCT FROM b.row-'enabled'-'display_name'-'updated_at'),'all SLA/timeout/lease/budget mapping values preserved';
 FOREACH lane IN ARRAY ARRAY['new_page_review','feedback_promotion','suppression','reconciliation','manual_quarantine'] LOOP
  claimed:=public.claim_monitoring_downstream_lane(lane,'consolidation-rollback-test',NULL,'{}'::jsonb);
  ASSERT claimed->'claimed'='false'::jsonb AND claimed->>'reason'='lane_disabled','retired lane cannot claim or start work';
 END LOOP;
 ASSERT NOT EXISTS(SELECT 1 FROM public.monitoring_downstream_lane_state s FULL JOIN pg_temp.before_states b USING(lane_key) WHERE to_jsonb(s) IS DISTINCT FROM b.row),'disabled claims cannot alter live state';
 ASSERT (SELECT jsonb_agg(jsonb_build_object('lane_key',lane_key,'count',n,'max_updated_at',max_updated_at) ORDER BY lane_key)
  FROM (SELECT lane_key,count(*) n,max(updated_at) max_updated_at FROM public.monitoring_downstream_lane_runs GROUP BY lane_key) h)
  IS NOT DISTINCT FROM (SELECT snapshot FROM pg_temp.before_history),'all historical runs preserved';
 INSERT INTO pg_temp.consolidation_test_results VALUES('exact_three_active_and_five_disabled_claims',true),('registry_state_and_history_preserved',true);
END;$consolidated_registry_test$;

DO $retired_staleness_test$
DECLARE actual text[];
BEGIN
 BEGIN
  UPDATE public.monitoring_downstream_lane_state SET last_succeeded_at='2000-01-01 00:00:00+00',last_error='native fixture stale retired lane',consecutive_failures=999
  WHERE lane_key IN ('new_page_review','feedback_promotion','suppression','reconciliation','manual_quarantine');
  SELECT array_agg(lane_key ORDER BY lane_key) INTO actual FROM public.list_monitoring_downstream_lane_status();
  ASSERT actual=ARRAY['changed_page_review','nightly_report','page_audit']::text[],'stale retired lanes must not reappear as active health failures';
  RAISE EXCEPTION USING ERRCODE='P0L01',MESSAGE='intentional stale-state rollback';
 EXCEPTION WHEN SQLSTATE 'P0L01' THEN NULL;END;
 ASSERT NOT EXISTS(SELECT 1 FROM public.monitoring_downstream_lane_state s FULL JOIN pg_temp.before_states b USING(lane_key) WHERE to_jsonb(s) IS DISTINCT FROM b.row),'retired staleness fixture restored';
 INSERT INTO pg_temp.consolidation_test_results VALUES('retired_stale_failures_excluded',true);
END;$retired_staleness_test$;

-- Execute the exact installed lane-count/health block in isolation. The rest of
-- the release gate remains pinned and is not invoked with synthetic evidence.
CREATE TEMP TABLE consolidated_lane_fixture ON COMMIT DROP AS SELECT * FROM public.list_monitoring_downstream_lane_status();
DO $installed_gate_fragment$
DECLARE body text;start_at integer;end_at integer;fragment text;definition text;status_body text;
BEGIN
 SELECT prosrc INTO STRICT body FROM pg_catalog.pg_proc WHERE oid='private.stage1_gate_without_contact_fence_20260717123000(timestamptz)'::regprocedure;
 start_at:=strpos(body,E'  select\n    count(*),\n    count(*) filter (\n      where lane.enabled');
 end_at:=strpos(body,'  v_lanes_ok := v_lane_count = 3 and v_lane_valid_count = 3;');
 ASSERT start_at>0 AND end_at>start_at,'exact actual lane block must be found';
 fragment:=substr(body,start_at,end_at-start_at)||'  v_lanes_ok := v_lane_count = 3 and v_lane_valid_count = 3;';
 EXECUTE 'CREATE FUNCTION pg_temp.installed_lane_gate() RETURNS boolean LANGUAGE plpgsql AS $fixture$ DECLARE v_lane_count bigint;v_lane_valid_count bigint;v_lanes jsonb;v_lanes_ok boolean;BEGIN '||fragment||' RETURN v_lanes_ok;END;$fixture$';
 SELECT pg_get_functiondef(oid),prosrc INTO STRICT definition,status_body FROM pg_catalog.pg_proc WHERE oid='public.list_monitoring_downstream_lane_status()'::regprocedure;
 EXECUTE replace(definition,status_body,E'\n SELECT f.* FROM pg_temp.consolidated_lane_fixture f;\n');
END;$installed_gate_fragment$;

UPDATE pg_temp.consolidated_lane_fixture SET enabled=true,lease_expired=false,sla_breached=false,queue_depth=0,oldest_item_at=NULL,
 next_sla_due_at=clock_timestamp()+interval '1 hour',source='postgres_lane_scheduler_v1';
CREATE TEMP TABLE consolidated_healthy_lanes ON COMMIT DROP AS SELECT * FROM pg_temp.consolidated_lane_fixture;
DO $gate_positive_and_negatives$
DECLARE lane text;
BEGIN
 ASSERT pg_temp.installed_lane_gate(),'three healthy approved keys pass the installed gate block';
 DELETE FROM pg_temp.consolidated_lane_fixture WHERE lane_key='page_audit';
 ASSERT NOT pg_temp.installed_lane_gate(),'missing active lane must fail';
 INSERT INTO pg_temp.consolidated_lane_fixture SELECT * FROM pg_temp.consolidated_healthy_lanes WHERE lane_key='page_audit';
 UPDATE pg_temp.consolidated_lane_fixture SET lane_key='suppression' WHERE lane_key='page_audit';
 ASSERT NOT pg_temp.installed_lane_gate(),'a retired key cannot substitute for an active key';
 UPDATE pg_temp.consolidated_lane_fixture SET lane_key='page_audit' WHERE lane_key='suppression';
 INSERT INTO pg_temp.consolidated_lane_fixture SELECT * FROM pg_temp.consolidated_healthy_lanes WHERE lane_key='page_audit';
 ASSERT NOT pg_temp.installed_lane_gate(),'unexpected fourth row must fail';
 TRUNCATE pg_temp.consolidated_lane_fixture;INSERT INTO pg_temp.consolidated_lane_fixture SELECT * FROM pg_temp.consolidated_healthy_lanes;
 UPDATE pg_temp.consolidated_lane_fixture SET sla_breached=true WHERE lane_key='nightly_report';
 ASSERT NOT pg_temp.installed_lane_gate(),'active SLA breach must fail';
 UPDATE pg_temp.consolidated_lane_fixture SET sla_breached=false,lease_expired=true WHERE lane_key='nightly_report';
 ASSERT NOT pg_temp.installed_lane_gate(),'active expired lease must fail';
 UPDATE pg_temp.consolidated_lane_fixture SET lease_expired=false,timeout_seconds=0 WHERE lane_key='nightly_report';
 ASSERT NOT pg_temp.installed_lane_gate(),'nonpositive timeout must fail';
 TRUNCATE pg_temp.consolidated_lane_fixture;INSERT INTO pg_temp.consolidated_lane_fixture SELECT * FROM pg_temp.consolidated_healthy_lanes;
 UPDATE pg_temp.consolidated_lane_fixture SET lease_ttl_seconds=timeout_seconds WHERE lane_key='page_audit';
 ASSERT NOT pg_temp.installed_lane_gate(),'lease must remain longer than timeout';
 TRUNCATE pg_temp.consolidated_lane_fixture;INSERT INTO pg_temp.consolidated_lane_fixture SELECT * FROM pg_temp.consolidated_healthy_lanes;
 UPDATE pg_temp.consolidated_lane_fixture SET creates_api_charge=false WHERE lane_key='changed_page_review';
 ASSERT NOT pg_temp.installed_lane_gate(),'paid-lane mapping guard must remain';
 TRUNCATE pg_temp.consolidated_lane_fixture;INSERT INTO pg_temp.consolidated_lane_fixture SELECT * FROM pg_temp.consolidated_healthy_lanes;
 UPDATE pg_temp.consolidated_lane_fixture SET source='untrusted_fixture' WHERE lane_key='page_audit';
 ASSERT NOT pg_temp.installed_lane_gate(),'source contract guard must remain';
 TRUNCATE pg_temp.consolidated_lane_fixture;INSERT INTO pg_temp.consolidated_lane_fixture SELECT * FROM pg_temp.consolidated_healthy_lanes;
 UPDATE pg_temp.consolidated_lane_fixture SET oldest_item_sla_seconds=sla_seconds WHERE lane_key='page_audit';
 ASSERT NOT pg_temp.installed_lane_gate(),'cadence metric shape must remain distinct';
 TRUNCATE pg_temp.consolidated_lane_fixture;INSERT INTO pg_temp.consolidated_lane_fixture SELECT * FROM pg_temp.consolidated_healthy_lanes;
 UPDATE pg_temp.consolidated_lane_fixture SET enabled=false WHERE lane_key='page_audit';
 ASSERT NOT pg_temp.installed_lane_gate(),'disabled active row must fail';
 ASSERT NOT private.stage1_downstream_lane_sla_contract_valid('unknown',3600,NULL,0,NULL,clock_timestamp()),'unknown key must fail closed';
 ASSERT NOT private.stage1_downstream_lane_sla_contract_valid('changed_page_review',3600,1800,0,NULL,NULL),'queue SLA must remain exact';
 INSERT INTO pg_temp.consolidation_test_results VALUES('installed_gate_healthy_three',true),('installed_gate_missing_retired_extra_keys',true),('installed_gate_all_existing_health_guards',true);
END;$gate_positive_and_negatives$;

DO $privileged_rpc_boundaries$
DECLARE signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.claim_monitoring_downstream_lane(text,text,uuid,jsonb)','public.heartbeat_monitoring_downstream_lane(text,uuid,uuid,jsonb)','public.complete_monitoring_downstream_lane(text,uuid,uuid,boolean,jsonb,text)','public.list_monitoring_downstream_lane_status()','public.get_stage1_release_gate_snapshot()'] LOOP
  ASSERT has_function_privilege('service_role',signature,'EXECUTE'),'service execution retained';
  ASSERT NOT has_function_privilege('anon',signature,'EXECUTE') AND NOT has_function_privilege('authenticated',signature,'EXECUTE'),'unprivileged execution remains denied';
 END LOOP;
 ASSERT NOT has_function_privilege('service_role','private.stage1_downstream_lane_sla_contract_valid(text,bigint,bigint,bigint,timestamptz,timestamptz)','EXECUTE'),'private helper remains owner-only';
 INSERT INTO pg_temp.consolidation_test_results VALUES('privileged_rpc_and_helper_acls_preserved',true);
END;$privileged_rpc_boundaries$;

SELECT jsonb_build_object('status','PASS','cases',(SELECT jsonb_object_agg(name,passed ORDER BY name) FROM pg_temp.consolidation_test_results),'note','all migration and fixture changes roll back') result;
