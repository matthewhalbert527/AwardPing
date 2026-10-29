/** Generates a finite actual-row native rehearsal. It executes nothing and all
 * schema/data changes are inside BEGIN/ROLLBACK. The caller supplies its exact
 * reviewed current failed candidate; no IDs are stored in the migration. */
export function programTextDocumentRecoveryRollbackFixture({migration,candidate_id}){
 if(typeof migration!=='string'||!migration.includes('create function public.commit_program_text_document_recovery(')||/\b(?:commit|rollback)\s*;/i.test(migration)||
  typeof candidate_id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(candidate_id))throw Error('Exact unapplied migration and finite candidate required');
 return `BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='3s';
${migration}
DO $document_recovery_rehearsal$
DECLARE
 target constant uuid:='${candidate_id}';reason constant text:='ROLLBACK ONLY: explicitly reviewed unchanged saved response and both original programme-page captures.';
 actor constant text:='codex_operator:user_authorized_saved_response_recovery';
 before_candidate jsonb;after_candidate jsonb;before_source jsonb;preview jsonb;result jsonb;again jsonb;
 fixture_source_id uuid;fixture_reservation_id uuid;before_reservation jsonb;before_events jsonb;before_outbox bigint;before_receipts bigint;before_alerts bigint;before_facts bigint;
 journal public.program_text_document_recovery_journal%rowtype;failed boolean;count_checks integer:=0;fn text;role_name text;
BEGIN
 SELECT to_jsonb(c) INTO STRICT before_candidate FROM public.shared_award_visual_review_candidates c WHERE c.id=target;
 fixture_source_id:=(before_candidate->>'shared_award_source_id')::uuid;fixture_reservation_id:=(before_candidate#>>'{worker_metadata,gemini_spend_reservation_id}')::uuid;
 SELECT to_jsonb(s) INTO STRICT before_source FROM public.shared_award_sources s WHERE s.id=fixture_source_id;
 SELECT to_jsonb(r) INTO STRICT before_reservation FROM public.gemini_spend_reservations r WHERE r.id=fixture_reservation_id;
 SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]') INTO before_events FROM public.gemini_spend_events e WHERE e.reservation_id=fixture_reservation_id;
 SELECT count(*) INTO before_outbox FROM public.public_digest_outbox;SELECT count(*) INTO before_receipts FROM public.public_digest_event_receipts;
 SELECT count(*) INTO before_alerts FROM public.program_text_alert_reviews;SELECT count(*) INTO before_facts FROM public.program_basic_fact_snapshots;
 IF before_candidate->>'status'<>'failed' OR EXISTS(SELECT 1 FROM public.program_text_document_recovery_journal)
 THEN RAISE EXCEPTION 'Rehearsal requires the actual still-held row and empty new journal';END IF;
 preview:=public.inspect_program_text_document_recovery(target);
 IF preview->>'already_applied'<>'false' OR preview->'candidate' IS DISTINCT FROM before_candidate
 OR preview->'paid_reservation' IS DISTINCT FROM before_reservation OR preview->'paid_events' IS DISTINCT FROM before_events
 OR preview->>'scope'<>'page_document_reference_removed' OR preview->>'derived_summary' NOT LIKE 'The page no longer lists %'
 THEN RAISE EXCEPTION 'Actual native failed-pair preview failed';END IF;count_checks:=count_checks+1;
 FOREACH fn IN ARRAY ARRAY['public.inspect_program_text_document_recovery(uuid)','public.commit_program_text_document_recovery(uuid,text,text,text,text,text)'] LOOP
  IF has_function_privilege('anon',fn,'EXECUTE') OR has_function_privilege('authenticated',fn,'EXECUTE')
   OR NOT has_function_privilege('service_role',fn,'EXECUTE') THEN RAISE EXCEPTION 'Recovery function privileges are wrong';END IF;count_checks:=count_checks+1;
 END LOOP;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(role_name,'public.program_text_document_recovery_journal','INSERT')
   OR has_table_privilege(role_name,'public.program_text_document_recovery_journal','UPDATE')
   OR has_table_privilege(role_name,'public.program_text_document_recovery_journal','DELETE')
   OR has_table_privilege(role_name,'public.program_text_document_recovery_journal','TRUNCATE')
  THEN RAISE EXCEPTION 'Recovery journal direct mutation privilege leak';END IF;count_checks:=count_checks+1;
 END LOOP;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  failed:=false;BEGIN EXECUTE format('SET LOCAL ROLE %I',role_name);PERFORM public.inspect_program_text_document_recovery(target);
  EXCEPTION WHEN insufficient_privilege THEN failed:=true;END;EXECUTE 'RESET ROLE';
  IF NOT failed THEN RAISE EXCEPTION 'Unauthenticated recovery inspection was accepted';END IF;count_checks:=count_checks+1;
 END LOOP;
 failed:=false;BEGIN PERFORM public.commit_program_text_document_recovery(target,repeat('0',64),preview->>'responses_hash',repeat('f',64),reason,actor);
 EXCEPTION WHEN serialization_failure THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Stale full-row/source/paid preimage was accepted';END IF;count_checks:=count_checks+1;
 failed:=false;BEGIN PERFORM public.commit_program_text_document_recovery(target,preview->>'preimage_hash',repeat('0',64),repeat('f',64),reason,actor);
 EXCEPTION WHEN serialization_failure THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Wrong original response version was accepted';END IF;count_checks:=count_checks+1;
 failed:=false;BEGIN PERFORM public.commit_program_text_document_recovery(target,preview->>'preimage_hash',preview->>'responses_hash',repeat('f',64),reason,'human_user');
 EXCEPTION WHEN check_violation THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Unreviewed/fabricated actor was accepted';END IF;count_checks:=count_checks+1;
 failed:=false;BEGIN UPDATE public.shared_award_sources SET text_monitoring_state=jsonb_set(text_monitoring_state,'{latest_ref}',text_monitoring_state->'baseline_ref') WHERE id=fixture_source_id;
  PERFORM public.commit_program_text_document_recovery(target,preview->>'preimage_hash',preview->>'responses_hash',repeat('f',64),reason,actor);
 EXCEPTION WHEN serialization_failure THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Changed original current pair was accepted';END IF;count_checks:=count_checks+1;
 failed:=false;BEGIN UPDATE public.gemini_spend_reservations SET updated_at=clock_timestamp() WHERE id=fixture_reservation_id;
  PERFORM public.commit_program_text_document_recovery(target,preview->>'preimage_hash',preview->>'responses_hash',repeat('f',64),reason,actor);
 EXCEPTION WHEN serialization_failure THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Changed original paid row was accepted';END IF;count_checks:=count_checks+1;
 failed:=false;BEGIN PERFORM private.awardping_document_recovery_shape(jsonb_set(before_candidate,'{ai_result,responses,0,blocks,0,changes,0,field}','"eligibility"'));
 EXCEPTION WHEN check_violation THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Another failure field was accepted';END IF;count_checks:=count_checks+1;
 -- Exercise the intended service-only caller, without impersonating an owner.
 EXECUTE 'SET LOCAL ROLE service_role';
 result:=public.commit_program_text_document_recovery(target,preview->>'preimage_hash',preview->>'responses_hash',repeat('f',64),reason,actor);
 EXECUTE 'RESET ROLE';
 IF result->>'status'<>'succeeded' OR result->>'already_applied'<>'false' THEN RAISE EXCEPTION 'Native atomic recovery failed';END IF;count_checks:=count_checks+1;
 SELECT * INTO STRICT journal FROM public.program_text_document_recovery_journal WHERE candidate_id=target;
 SELECT to_jsonb(c) INTO STRICT after_candidate FROM public.shared_award_visual_review_candidates c WHERE c.id=target;
 IF journal.failed_candidate IS DISTINCT FROM before_candidate OR journal.original_responses IS DISTINCT FROM before_candidate#>'{ai_result,responses}'
 OR journal.paid_reservation IS DISTINCT FROM before_reservation OR journal.paid_events IS DISTINCT FROM before_events
 OR after_candidate->>'status'<>'succeeded' OR after_candidate->'ai_result' IS DISTINCT FROM before_candidate->'ai_result'
 OR after_candidate->'worker_metadata' IS DISTINCT FROM (before_candidate->'worker_metadata')||jsonb_build_object('program_text_document_recovery',jsonb_build_object('journal_id',journal.id,'policy',journal.policy))
 OR (after_candidate-array['status','rejection_reason','updated_at','worker_metadata']) IS DISTINCT FROM (before_candidate-array['status','rejection_reason','updated_at','worker_metadata'])
 THEN RAISE EXCEPTION 'Recovery changed data beyond status/provenance or lost failure history';END IF;count_checks:=count_checks+1;
 again:=public.commit_program_text_document_recovery(target,preview->>'preimage_hash',preview->>'responses_hash',repeat('f',64),reason,actor);
 IF again->>'already_applied'<>'true' OR again->'journal_id' IS DISTINCT FROM result->'journal_id'
 OR (SELECT count(*) FROM public.program_text_document_recovery_journal)<>1
 OR (SELECT to_jsonb(c) FROM public.shared_award_visual_review_candidates c WHERE c.id=target) IS DISTINCT FROM after_candidate
 THEN RAISE EXCEPTION 'Exact idempotent replay changed state';END IF;count_checks:=count_checks+1;
 failed:=false;BEGIN PERFORM public.commit_program_text_document_recovery(target,preview->>'preimage_hash',preview->>'responses_hash',repeat('e',64),reason,actor);
 EXCEPTION WHEN serialization_failure THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'A different repeat plan was accepted';END IF;count_checks:=count_checks+1;
 failed:=false;BEGIN UPDATE public.program_text_document_recovery_journal SET reason='erase history' WHERE candidate_id=target;
 EXCEPTION WHEN insufficient_privilege THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Journal update erased history';END IF;count_checks:=count_checks+1;
 failed:=false;BEGIN DELETE FROM public.program_text_document_recovery_journal WHERE candidate_id=target;
 EXCEPTION WHEN insufficient_privilege THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Journal delete erased history';END IF;count_checks:=count_checks+1;
 failed:=false;BEGIN TRUNCATE public.program_text_document_recovery_journal;
 EXCEPTION WHEN insufficient_privilege THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Journal truncate erased history';END IF;count_checks:=count_checks+1;
 IF (SELECT to_jsonb(s) FROM public.shared_award_sources s WHERE s.id=fixture_source_id) IS DISTINCT FROM before_source
 OR (SELECT to_jsonb(r) FROM public.gemini_spend_reservations r WHERE r.id=fixture_reservation_id) IS DISTINCT FROM before_reservation
 OR (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]') FROM public.gemini_spend_events e WHERE e.reservation_id=fixture_reservation_id) IS DISTINCT FROM before_events
 OR (SELECT count(*) FROM public.public_digest_outbox)<>before_outbox OR (SELECT count(*) FROM public.public_digest_event_receipts)<>before_receipts
 OR (SELECT count(*) FROM public.program_text_alert_reviews)<>before_alerts OR (SELECT count(*) FROM public.program_basic_fact_snapshots)<>before_facts
 THEN RAISE EXCEPTION 'Source, paid history, facts or outgoing alert state changed';END IF;count_checks:=count_checks+1;
 RAISE NOTICE 'document_recovery_native_checks=%, all changes will be rolled back',count_checks;
END $document_recovery_rehearsal$;
ROLLBACK;
`;
}
