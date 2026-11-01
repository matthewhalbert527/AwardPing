-- Consolidate recurring work without deleting lane state, queues, or run history.
-- The Windows cadence stays fifteen minutes. Existing lane SLA, timeout, lease,
-- paid-budget, queue, and authorization policies are preserved.
DO $consolidated_lane_registry$
DECLARE keys text[];active_keys text[];
BEGIN
 PERFORM 1 FROM public.monitoring_downstream_lanes FOR UPDATE;
 SELECT array_agg(lane_key ORDER BY lane_key) INTO keys FROM public.monitoring_downstream_lanes;
 IF keys IS DISTINCT FROM ARRAY['changed_page_review','feedback_promotion','manual_quarantine','new_page_review','nightly_report','page_audit','reconciliation','suppression']::text[] THEN
  RAISE EXCEPTION 'Downstream lane registry differs from the reviewed eight-row topology.' USING ERRCODE='40001';
 END IF;
 IF EXISTS(SELECT 1 FROM public.monitoring_downstream_lanes WHERE lane_key IN ('changed_page_review','page_audit','nightly_report') AND NOT enabled) THEN
  RAISE EXCEPTION 'An intended active downstream lane has been disabled; preserve that operator decision.' USING ERRCODE='40001';
 END IF;
 UPDATE public.monitoring_downstream_lanes SET enabled=false,updated_at=pg_catalog.clock_timestamp()
 WHERE lane_key IN ('new_page_review','feedback_promotion','suppression','reconciliation','manual_quarantine') AND enabled;
 UPDATE public.monitoring_downstream_lanes SET display_name='Coverage report',updated_at=pg_catalog.clock_timestamp()
 WHERE lane_key='nightly_report' AND display_name IS DISTINCT FROM 'Coverage report';
 SELECT array_agg(lane_key ORDER BY lane_key) INTO active_keys FROM public.monitoring_downstream_lanes WHERE enabled;
 IF active_keys IS DISTINCT FROM ARRAY['changed_page_review','nightly_report','page_audit']::text[] THEN
  RAISE EXCEPTION 'Consolidation did not produce the exact three active lanes.' USING ERRCODE='55000';
 END IF;
END;$consolidated_lane_registry$;

DO $consolidated_lane_function_0$
DECLARE target oid:=pg_catalog.to_regprocedure('public.list_monitoring_downstream_lane_status()');old_body text;next_body text;definition text;before_catalog jsonb;after_catalog jsonb;
BEGIN
 IF target IS NULL THEN RAISE EXCEPTION 'Required lane function is missing.' USING ERRCODE='42883';END IF;
 SELECT p.prosrc,pg_catalog.pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO STRICT old_body,definition,before_catalog FROM pg_catalog.pg_proc p WHERE p.oid=target;
 IF encode(extensions.digest(convert_to(old_body,'UTF8'),'sha256'),'hex')<>'12622c5fb40c4fb2abf79e33daf1c3c00fe7bb03fd11f57a534a368618010a28' THEN
  RAISE EXCEPTION 'Lane function preimage changed: public.list_monitoring_downstream_lane_status().' USING ERRCODE='40001';END IF;
 next_body:=old_body;
 next_body:=pg_catalog.replace(next_body,$lane_patch_0_0a$  cross join lane_clock
  order by lane.sort_order;$lane_patch_0_0a$,$lane_patch_0_0b$  cross join lane_clock
  where lane.enabled
  order by lane.sort_order;$lane_patch_0_0b$);
 IF encode(extensions.digest(convert_to(next_body,'UTF8'),'sha256'),'hex')<>'2133c384a7aa7338faa8bec4d6d073f387b91c51219f94d4e71e38a4ae15222c' THEN
  RAISE EXCEPTION 'Lane function replacement differs: public.list_monitoring_downstream_lane_status().' USING ERRCODE='40001';END IF;
 EXECUTE pg_catalog.replace(definition,old_body,next_body);
 SELECT to_jsonb(p)-'prosrc' INTO STRICT after_catalog FROM pg_catalog.pg_proc p WHERE p.oid=target;
 IF after_catalog IS DISTINCT FROM before_catalog OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=target AND encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex')='2133c384a7aa7338faa8bec4d6d073f387b91c51219f94d4e71e38a4ae15222c') THEN
  RAISE EXCEPTION 'Lane function catalog or body preservation failed.' USING ERRCODE='55000';END IF;
END;$consolidated_lane_function_0$;

DO $consolidated_lane_function_1$
DECLARE target oid:=pg_catalog.to_regprocedure('private.stage1_downstream_lane_sla_contract_valid(text,bigint,bigint,bigint,timestamp with time zone,timestamp with time zone)');old_body text;next_body text;definition text;before_catalog jsonb;after_catalog jsonb;
BEGIN
 IF target IS NULL THEN RAISE EXCEPTION 'Required lane function is missing.' USING ERRCODE='42883';END IF;
 SELECT p.prosrc,pg_catalog.pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO STRICT old_body,definition,before_catalog FROM pg_catalog.pg_proc p WHERE p.oid=target;
 IF encode(extensions.digest(convert_to(old_body,'UTF8'),'sha256'),'hex')<>'337ecd4b41493b7b148f372f7ae2db59b46ed7036e0af01e55888c660fe8e3d3' THEN
  RAISE EXCEPTION 'Lane function preimage changed: private.stage1_downstream_lane_sla_contract_valid(text,bigint,bigint,bigint,timestamp with time zone,timestamp with time zone).' USING ERRCODE='40001';END IF;
 next_body:=old_body;
 next_body:=pg_catalog.replace(next_body,$lane_patch_1_0a$        'new_page_review',
        'changed_page_review',
        'feedback_promotion',
        'reconciliation'$lane_patch_1_0a$,$lane_patch_1_0b$        'changed_page_review'$lane_patch_1_0b$);
 next_body:=pg_catalog.replace(next_body,$lane_patch_1_1a$        'suppression',
        'page_audit',
        'manual_quarantine',
        'nightly_report'$lane_patch_1_1a$,$lane_patch_1_1b$        'page_audit',
        'nightly_report'$lane_patch_1_1b$);
 IF encode(extensions.digest(convert_to(next_body,'UTF8'),'sha256'),'hex')<>'6c68bc7fa0dec6243a6362e95f3a976ea04a1639192c576cbd4481e1f3fc391e' THEN
  RAISE EXCEPTION 'Lane function replacement differs: private.stage1_downstream_lane_sla_contract_valid(text,bigint,bigint,bigint,timestamp with time zone,timestamp with time zone).' USING ERRCODE='40001';END IF;
 EXECUTE pg_catalog.replace(definition,old_body,next_body);
 SELECT to_jsonb(p)-'prosrc' INTO STRICT after_catalog FROM pg_catalog.pg_proc p WHERE p.oid=target;
 IF after_catalog IS DISTINCT FROM before_catalog OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=target AND encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex')='6c68bc7fa0dec6243a6362e95f3a976ea04a1639192c576cbd4481e1f3fc391e') THEN
  RAISE EXCEPTION 'Lane function catalog or body preservation failed.' USING ERRCODE='55000';END IF;
END;$consolidated_lane_function_1$;

DO $consolidated_lane_function_2$
DECLARE target oid:=pg_catalog.to_regprocedure('private.stage1_gate_without_contact_fence_20260717123000(timestamp with time zone)');old_body text;next_body text;definition text;before_catalog jsonb;after_catalog jsonb;
BEGIN
 IF target IS NULL THEN RAISE EXCEPTION 'Required lane function is missing.' USING ERRCODE='42883';END IF;
 SELECT p.prosrc,pg_catalog.pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO STRICT old_body,definition,before_catalog FROM pg_catalog.pg_proc p WHERE p.oid=target;
 IF encode(extensions.digest(convert_to(old_body,'UTF8'),'sha256'),'hex')<>'dd93fba3e59bb345ad02c08a809c8be5af43f86b91d67a7f165460b77ded7d63' THEN
  RAISE EXCEPTION 'Lane function preimage changed: private.stage1_gate_without_contact_fence_20260717123000(timestamp with time zone).' USING ERRCODE='40001';END IF;
 next_body:=old_body;
 next_body:=pg_catalog.replace(next_body,$lane_patch_2_0a$v_lanes_ok := v_lane_count = 8 and v_lane_valid_count = 8;$lane_patch_2_0a$,$lane_patch_2_0b$v_lanes_ok := v_lane_count = 3 and v_lane_valid_count = 3;$lane_patch_2_0b$);
 next_body:=pg_catalog.replace(next_body,$lane_patch_2_1a$the eight downstream lanes$lane_patch_2_1a$,$lane_patch_2_1b$the three active downstream lanes$lane_patch_2_1b$);
 next_body:=pg_catalog.replace(next_body,$lane_patch_2_2a$'eight_downstream_lanes_failed'$lane_patch_2_2a$,$lane_patch_2_2b$'active_downstream_lanes_failed'$lane_patch_2_2b$);
 IF encode(extensions.digest(convert_to(next_body,'UTF8'),'sha256'),'hex')<>'d737eb71b046d8883f827c73c381aedf9db1222a366215588a8dd47247541f52' THEN
  RAISE EXCEPTION 'Lane function replacement differs: private.stage1_gate_without_contact_fence_20260717123000(timestamp with time zone).' USING ERRCODE='40001';END IF;
 EXECUTE pg_catalog.replace(definition,old_body,next_body);
 SELECT to_jsonb(p)-'prosrc' INTO STRICT after_catalog FROM pg_catalog.pg_proc p WHERE p.oid=target;
 IF after_catalog IS DISTINCT FROM before_catalog OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=target AND encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex')='d737eb71b046d8883f827c73c381aedf9db1222a366215588a8dd47247541f52') THEN
  RAISE EXCEPTION 'Lane function catalog or body preservation failed.' USING ERRCODE='55000';END IF;
END;$consolidated_lane_function_2$;
