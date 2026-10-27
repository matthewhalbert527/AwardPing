/** Builds a finite actual-row rehearsal for the operator. This module executes
 * nothing: every data/schema mutation is confined to generated BEGIN/ROLLBACK.
 * Requires the installed foundation schema and the real still-failed NSF pair. */
export function programTextQuoteIdRecoveryRollbackFixture({migration}){
 if(typeof migration!=='string'||!migration.includes('create function public.approve_program_text_quote_id_recovery(')||/\b(?:commit|rollback)\s*;/i.test(migration))throw Error('Expected the exact unapplied finite migration.');
 return `BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='3s';
${migration}
DO $recovery_fixture$
DECLARE
 fixture_candidate constant uuid:='8d40add5-89ea-4f96-9c31-f1f68c1fa472';
 fixture_source constant uuid:='d4509d97-da9b-4e12-bbe9-45129e6ce1c1';
 fixture_reason constant text:='ROLLBACK ONLY: reviewed both exact quotations and their two source-bound identifier substitutions.';
 fixture_actor uuid;fixture_before jsonb;fixture_after jsonb;fixture_source_before jsonb;fixture_preview jsonb;fixture_response jsonb;
 fixture_result jsonb;fixture_journal public.program_text_quote_id_recovery_journal%rowtype;
 fixture_projection jsonb;fixture_wrong jsonb;fixture_expected jsonb;fixture_failed boolean;fixture_role text;fixture_function text;
 fixture_count integer:=0;fixture_ledger_before text;fixture_ledger_after text;fixture_facts_before text;fixture_facts_after text;
BEGIN
 SELECT id INTO STRICT fixture_actor FROM auth.users ORDER BY created_at,id LIMIT 1;
 SELECT to_jsonb(c) INTO STRICT fixture_before FROM public.shared_award_visual_review_candidates c WHERE c.id=fixture_candidate;
 SELECT to_jsonb(s) INTO STRICT fixture_source_before FROM public.shared_award_sources s WHERE s.id=fixture_source;
 IF fixture_before->>'status'<>'failed' OR EXISTS(SELECT 1 FROM public.program_text_quote_id_recovery_journal)
 THEN RAISE EXCEPTION 'Rehearsal requires the untouched actual failed candidate and empty new journal';END IF;
 -- Compact row-version fingerprints avoid aggregating private queue/response text.
 SELECT md5(coalesce(string_agg(fp,'' ORDER BY fp),'')) INTO fixture_ledger_before FROM (
  SELECT 'days:'||budget_date||':'||lane_key||':'||xmin::text||':'||ctid::text AS fp FROM public.gemini_spend_days
  UNION ALL SELECT 'reservation:'||id::text||':'||xmin::text||':'||ctid::text FROM public.gemini_spend_reservations
  UNION ALL SELECT 'event:'||id::text||':'||xmin::text||':'||ctid::text FROM public.gemini_spend_events) ledger_rows;
 SELECT md5(coalesce(string_agg(fp,'' ORDER BY fp),'')) INTO fixture_facts_before FROM (
  SELECT 'unit:'||id::text||':'||xmin::text||':'||ctid::text AS fp FROM public.program_variation_unit_reviews
  UNION ALL SELECT 'approval:'||id::text||':'||xmin::text||':'||ctid::text FROM public.program_variation_award_approvals
  UNION ALL SELECT 'release:'||release_key||':'||xmin::text||':'||ctid::text FROM public.program_variation_release
  UNION ALL SELECT 'v1review:'||id::text||':'||xmin::text||':'||ctid::text FROM public.program_text_fact_reviews
  UNION ALL SELECT 'v1release:'||release_key||':'||xmin::text||':'||ctid::text FROM public.program_text_fact_release
  UNION ALL SELECT 'source_event:'||id::text||':'||xmin::text||':'||ctid::text FROM public.shared_award_change_events WHERE shared_award_source_id=fixture_source) fact_rows;
 fixture_preview:=public.inspect_program_text_quote_id_recovery(fixture_candidate);
 IF fixture_preview->>'already_applied'<>'false' OR fixture_preview->'candidate' IS DISTINCT FROM fixture_before
 OR jsonb_array_length(fixture_preview->'changes')<>2 THEN RAISE EXCEPTION 'Exact actual-row preview failed';END IF;fixture_count:=fixture_count+1;
 fixture_projection:=fixture_preview->'projected_responses';fixture_response:=fixture_before#>'{ai_result,responses}';
 fixture_expected:=jsonb_set(jsonb_set(fixture_response,'{0,blocks,0,changes,0,previous_quote,block_id}',
  fixture_before#>'{prompt_payload,comparison,changed_blocks,0,previous,id}',false),'{0,blocks,0,changes,0,current_quote,block_id}',
  fixture_before#>'{prompt_payload,comparison,changed_blocks,0,current,id}',false);
 IF fixture_projection IS DISTINCT FROM fixture_expected OR fixture_projection=fixture_response
 THEN RAISE EXCEPTION 'Projection changed something other than the two proven IDs';END IF;fixture_count:=fixture_count+1;
 FOREACH fixture_function IN ARRAY ARRAY['public.inspect_program_text_quote_id_recovery(uuid)','public.approve_program_text_quote_id_recovery(uuid,text,text,text,uuid)'] LOOP
  IF has_function_privilege('anon',fixture_function,'EXECUTE') OR has_function_privilege('authenticated',fixture_function,'EXECUTE')
   OR NOT has_function_privilege('service_role',fixture_function,'EXECUTE') THEN RAISE EXCEPTION 'Recovery function authority leak';END IF;fixture_count:=fixture_count+1;
 END LOOP;
 FOREACH fixture_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(fixture_role,'public.program_text_quote_id_recovery_journal','INSERT')
   OR has_table_privilege(fixture_role,'public.program_text_quote_id_recovery_journal','UPDATE')
   OR has_table_privilege(fixture_role,'public.program_text_quote_id_recovery_journal','DELETE')
   OR has_table_privilege(fixture_role,'public.program_text_quote_id_recovery_journal','TRUNCATE')
  THEN RAISE EXCEPTION 'Recovery journal direct write authority leak';END IF;fixture_count:=fixture_count+1;
 END LOOP;
 FOREACH fixture_role IN ARRAY ARRAY['anon','authenticated'] LOOP
  fixture_failed:=false;BEGIN
   EXECUTE format('SET LOCAL ROLE %I',fixture_role);
   PERFORM public.approve_program_text_quote_id_recovery(fixture_candidate,fixture_preview->>'preimage_hash',fixture_preview->>'projection_hash',fixture_reason,fixture_actor);
  EXCEPTION WHEN insufficient_privilege THEN fixture_failed:=true;END;EXECUTE 'RESET ROLE';
  IF NOT fixture_failed THEN RAISE EXCEPTION 'Unauthenticated recovery was accepted';END IF;fixture_count:=fixture_count+1;
 END LOOP;
 fixture_failed:=false;BEGIN PERFORM public.inspect_program_text_quote_id_recovery(gen_random_uuid());
 EXCEPTION WHEN check_violation THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Unapproved candidate was accepted';END IF;fixture_count:=fixture_count+1;
 fixture_failed:=false;BEGIN PERFORM public.approve_program_text_quote_id_recovery(fixture_candidate,repeat('0',64),fixture_preview->>'projection_hash',fixture_reason,fixture_actor);
 EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Stale candidate preimage was accepted';END IF;fixture_count:=fixture_count+1;
 fixture_failed:=false;BEGIN PERFORM public.approve_program_text_quote_id_recovery(fixture_candidate,fixture_preview->>'preimage_hash',repeat('0',64),fixture_reason,fixture_actor);
 EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Stale projection was accepted';END IF;fixture_count:=fixture_count+1;
 fixture_failed:=false;BEGIN PERFORM public.approve_program_text_quote_id_recovery(fixture_candidate,fixture_preview->>'preimage_hash',fixture_preview->>'projection_hash','yes',fixture_actor);
 EXCEPTION WHEN check_violation THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Missing explicit review was accepted';END IF;fixture_count:=fixture_count+1;
 fixture_failed:=false;BEGIN PERFORM public.approve_program_text_quote_id_recovery(fixture_candidate,fixture_preview->>'preimage_hash',fixture_preview->>'projection_hash',fixture_reason,gen_random_uuid());
 EXCEPTION WHEN check_violation THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Unknown actor was accepted';END IF;fixture_count:=fixture_count+1;
 -- Rehearse stale source/current-pair/epoch/roster with subtransaction rollback.
 fixture_failed:=false;BEGIN UPDATE public.shared_award_sources SET url=url||'/unapproved-rehearsal' WHERE id=fixture_source;
  PERFORM public.approve_program_text_quote_id_recovery(fixture_candidate,fixture_preview->>'preimage_hash',fixture_preview->>'projection_hash',fixture_reason,fixture_actor);
 EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Changed source URL was accepted';END IF;fixture_count:=fixture_count+1;
 fixture_failed:=false;BEGIN UPDATE public.shared_award_sources SET text_monitoring_state=jsonb_set(text_monitoring_state,'{latest_ref}',text_monitoring_state->'baseline_ref') WHERE id=fixture_source;
  PERFORM public.approve_program_text_quote_id_recovery(fixture_candidate,fixture_preview->>'preimage_hash',fixture_preview->>'projection_hash',fixture_reason,fixture_actor);
 EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Changed current capture pair was accepted';END IF;fixture_count:=fixture_count+1;
 fixture_failed:=false;BEGIN UPDATE public.shared_award_sources SET text_monitoring_state=jsonb_set(text_monitoring_state,'{epoch}',to_jsonb(gen_random_uuid())) WHERE id=fixture_source;
  PERFORM public.approve_program_text_quote_id_recovery(fixture_candidate,fixture_preview->>'preimage_hash',fixture_preview->>'projection_hash',fixture_reason,fixture_actor);
 EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Changed current epoch was accepted';END IF;fixture_count:=fixture_count+1;
 fixture_failed:=false;BEGIN UPDATE public.program_text_source_roster SET revision=gen_random_uuid() WHERE cohort_key='nsf_grfp'
  AND source_role=(SELECT r.source_role FROM public.program_text_source_roster r WHERE r.cohort_key='nsf_grfp' ORDER BY r.source_role LIMIT 1);
  PERFORM public.approve_program_text_quote_id_recovery(fixture_candidate,fixture_preview->>'preimage_hash',fixture_preview->>'projection_hash',fixture_reason,fixture_actor);
 EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Changed roster version was accepted';END IF;fixture_count:=fixture_count+1;
 fixture_wrong:=jsonb_set(fixture_before,'{ai_result,responses,0,blocks,0,changes,0,summary}',to_jsonb('Unreviewed new factual claim'::text));
 fixture_failed:=false;BEGIN PERFORM private.awardping_program_quote_id_recovery_projection(fixture_wrong);
 EXCEPTION WHEN check_violation THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Response prose changed outside the named IDs';END IF;fixture_count:=fixture_count+1;
 fixture_wrong:=jsonb_set(fixture_before,'{prompt_payload,comparison,changed_blocks,0,previous,text}',to_jsonb('A forged source block'::text));
 fixture_failed:=false;BEGIN PERFORM private.awardping_program_quote_id_recovery_projection(fixture_wrong);
 EXCEPTION WHEN check_violation THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Forged side block was accepted';END IF;fixture_count:=fixture_count+1;
 IF EXISTS(SELECT 1 FROM public.program_text_quote_id_recovery_journal)
 OR (SELECT to_jsonb(c) FROM public.shared_award_visual_review_candidates c WHERE c.id=fixture_candidate) IS DISTINCT FROM fixture_before
 THEN RAISE EXCEPTION 'A rejected operation changed the failed row or journal';END IF;fixture_count:=fixture_count+1;
 -- Force a failure after the journal insert to prove the transaction is atomic.
 ALTER TABLE public.shared_award_visual_review_candidates ADD CONSTRAINT quote_id_fixture_late_failure
  CHECK(id<>'8d40add5-89ea-4f96-9c31-f1f68c1fa472'::uuid OR status<>'succeeded') NOT VALID;
 fixture_failed:=false;BEGIN PERFORM public.approve_program_text_quote_id_recovery(fixture_candidate,fixture_preview->>'preimage_hash',fixture_preview->>'projection_hash',fixture_reason,fixture_actor);
 EXCEPTION WHEN check_violation THEN fixture_failed:=true;END;
 ALTER TABLE public.shared_award_visual_review_candidates DROP CONSTRAINT quote_id_fixture_late_failure;
 IF NOT fixture_failed OR EXISTS(SELECT 1 FROM public.program_text_quote_id_recovery_journal)
 OR (SELECT to_jsonb(c) FROM public.shared_award_visual_review_candidates c WHERE c.id=fixture_candidate) IS DISTINCT FROM fixture_before
 THEN RAISE EXCEPTION 'Late transition failure left partial recovery';END IF;fixture_count:=fixture_count+1;
 fixture_result:=public.approve_program_text_quote_id_recovery(fixture_candidate,fixture_preview->>'preimage_hash',fixture_preview->>'projection_hash',fixture_reason,fixture_actor);
 SELECT to_jsonb(c) INTO STRICT fixture_after FROM public.shared_award_visual_review_candidates c WHERE c.id=fixture_candidate;
 SELECT * INTO STRICT fixture_journal FROM public.program_text_quote_id_recovery_journal WHERE candidate_id=fixture_candidate;
 IF fixture_result->>'status'<>'succeeded' OR fixture_result->>'already_applied'<>'false'
 OR fixture_after->>'status'<>'succeeded' OR fixture_after#>'{ai_result,responses}' IS DISTINCT FROM fixture_expected
 OR fixture_after->'rejection_reason' IS DISTINCT FROM 'null'::jsonb
 OR fixture_journal.failed_candidate IS DISTINCT FROM fixture_before OR fixture_journal.original_responses IS DISTINCT FROM fixture_response
 OR fixture_journal.projected_responses IS DISTINCT FROM fixture_expected OR jsonb_array_length(fixture_journal.substitutions)<>2
 THEN RAISE EXCEPTION 'Successful recovery lost original history or altered the projection';END IF;fixture_count:=fixture_count+1;
 IF (fixture_after-ARRAY['status','ai_result','rejection_reason','updated_at','worker_metadata']) IS DISTINCT FROM
  (fixture_before-ARRAY['status','ai_result','rejection_reason','updated_at','worker_metadata'])
 OR ((fixture_after->'ai_result')-'responses') IS DISTINCT FROM ((fixture_before->'ai_result')-'responses')
 OR ((fixture_after->'worker_metadata')-'program_text_quote_id_recovery') IS DISTINCT FROM (fixture_before->'worker_metadata')
 THEN RAISE EXCEPTION 'Recovery changed a claim, provider job, original prompt, capture reference, usage, model or completion history';END IF;fixture_count:=fixture_count+1;
 fixture_result:=public.approve_program_text_quote_id_recovery(fixture_candidate,fixture_preview->>'preimage_hash',fixture_preview->>'projection_hash',fixture_reason,fixture_actor);
 IF fixture_result->>'status'<>'historical_receipt' OR fixture_result->>'already_applied'<>'true'
 OR (SELECT to_jsonb(c) FROM public.shared_award_visual_review_candidates c WHERE c.id=fixture_candidate) IS DISTINCT FROM fixture_after
 OR (SELECT count(*) FROM public.program_text_quote_id_recovery_journal)<>1
 THEN RAISE EXCEPTION 'Identical replay repeated a live transition';END IF;fixture_count:=fixture_count+1;
 fixture_result:=public.inspect_program_text_quote_id_recovery(fixture_candidate);
 IF fixture_result->>'already_applied'<>'true' OR fixture_result->'candidate' IS NOT NULL
 OR fixture_result#>>'{receipt,status}'<>'historical_receipt' THEN RAISE EXCEPTION 'Historical GET rebuilt a live projection';END IF;fixture_count:=fixture_count+1;
 fixture_failed:=false;BEGIN PERFORM public.approve_program_text_quote_id_recovery(fixture_candidate,fixture_preview->>'preimage_hash',fixture_preview->>'projection_hash',fixture_reason||' modified',fixture_actor);
 EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Replay rewrote the recorded reason';END IF;fixture_count:=fixture_count+1;
 fixture_failed:=false;BEGIN UPDATE public.program_text_quote_id_recovery_journal SET reason=reason||' changed';
 EXCEPTION WHEN insufficient_privilege THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Journal UPDATE permitted';END IF;fixture_count:=fixture_count+1;
 fixture_failed:=false;BEGIN DELETE FROM public.program_text_quote_id_recovery_journal;
 EXCEPTION WHEN insufficient_privilege THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Journal DELETE permitted';END IF;fixture_count:=fixture_count+1;
 fixture_failed:=false;BEGIN TRUNCATE public.program_text_quote_id_recovery_journal;
 EXCEPTION WHEN insufficient_privilege THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Journal TRUNCATE permitted';END IF;fixture_count:=fixture_count+1;
 IF (SELECT to_jsonb(s) FROM public.shared_award_sources s WHERE s.id=fixture_source) IS DISTINCT FROM fixture_source_before
 THEN RAISE EXCEPTION 'Recovery touched source baseline or collection state';END IF;fixture_count:=fixture_count+1;
 SELECT md5(coalesce(string_agg(fp,'' ORDER BY fp),'')) INTO fixture_ledger_after FROM (
  SELECT 'days:'||budget_date||':'||lane_key||':'||xmin::text||':'||ctid::text AS fp FROM public.gemini_spend_days
  UNION ALL SELECT 'reservation:'||id::text||':'||xmin::text||':'||ctid::text FROM public.gemini_spend_reservations
  UNION ALL SELECT 'event:'||id::text||':'||xmin::text||':'||ctid::text FROM public.gemini_spend_events) ledger_rows;
 SELECT md5(coalesce(string_agg(fp,'' ORDER BY fp),'')) INTO fixture_facts_after FROM (
  SELECT 'unit:'||id::text||':'||xmin::text||':'||ctid::text AS fp FROM public.program_variation_unit_reviews
  UNION ALL SELECT 'approval:'||id::text||':'||xmin::text||':'||ctid::text FROM public.program_variation_award_approvals
  UNION ALL SELECT 'release:'||release_key||':'||xmin::text||':'||ctid::text FROM public.program_variation_release
  UNION ALL SELECT 'v1review:'||id::text||':'||xmin::text||':'||ctid::text FROM public.program_text_fact_reviews
  UNION ALL SELECT 'v1release:'||release_key||':'||xmin::text||':'||ctid::text FROM public.program_text_fact_release
  UNION ALL SELECT 'source_event:'||id::text||':'||xmin::text||':'||ctid::text FROM public.shared_award_change_events WHERE shared_award_source_id=fixture_source) fact_rows;
 IF fixture_ledger_before IS DISTINCT FROM fixture_ledger_after OR fixture_facts_before IS DISTINCT FROM fixture_facts_after
 THEN RAISE EXCEPTION 'Recovery changed spending or current-fact approvals/publication';END IF;fixture_count:=fixture_count+1;
 PERFORM set_config('awardping.quote_id_recovery_fixture',jsonb_build_object('assertions',fixture_count,'candidate',fixture_candidate,
  'projection_changes',2,'paid_calls',0,'persistent_writes',0,'publication_in_recovery',false)::text,true);
END $recovery_fixture$;
SELECT current_setting('awardping.quote_id_recovery_fixture') AS quote_id_recovery_rollback_only_acceptance;
ROLLBACK;
`;
}
