/** Inert finite actual-row rehearsal. The returned SQL rolls back every DDL
 * and data change. Caller supplies the independently reviewed retained proof. */
export function reviewedPdfFirstCoverageRollbackFixture({migration,document,review_receipt}){
 const id=document?.reference?.source?.id;
 if(typeof migration!=='string'||!migration.includes('create function public.transition_reviewed_pdf_first_coverage(')||/\b(?:commit|rollback)\s*;/i.test(migration)||typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw Error('Unapplied schema and exact reviewed source proof required');
 const literal=x=>"'"+JSON.stringify(x).replaceAll("'","''")+"'::jsonb";
 // Remove repeated page-level bindings from the transport, then reconstruct
 // exact blocks and canonical bytes inside the rollback-only transaction.
 const compactDocument={...document};delete compactDocument.blocks_json;
 if(Array.isArray(document.blocks))compactDocument.blocks=document.blocks.map(b=>({...b,context:Object.fromEntries(Object.entries(b.context??{}).filter(([k])=>!['representation','method','document_scope','profile_sha256','original_render_sha256','reviewed_transcript_sha256'].includes(k)))}));
 return `BEGIN;
SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='3s';
${migration}
CREATE FUNCTION pg_temp.reviewed_pdf_canonical_json(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $canonical$
DECLARE result text;
BEGIN
 IF jsonb_typeof(v)='object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||pg_temp.reviewed_pdf_canonical_json(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(v);RETURN result;
 ELSIF jsonb_typeof(v)='array' THEN SELECT '['||coalesce(string_agg(pg_temp.reviewed_pdf_canonical_json(value),',' ORDER BY ordinal),'')||']' INTO result FROM jsonb_array_elements(v) WITH ORDINALITY AS entry(value,ordinal);RETURN result;
 ELSE RETURN v::text;END IF;
END $canonical$;
DO $reviewed_pdf_rehearsal$
DECLARE target constant uuid:='${id}';doc jsonb:=${literal(compactDocument)};receipt constant jsonb:=${literal(review_receipt)};
 reason constant text:='ROLLBACK ONLY: independent full visible original review and retained complete text projection, with truthful source limitations.';
 policy constant text:='awardping.reviewed-visible-pdf-initial-coverage.v1';before_source jsonb;old_state jsonb;next_state jsonb;epoch_id uuid;result jsonb;again jsonb;
 original_failures jsonb;original_candidates bigint;original_facts bigint;original_alerts bigint;original_outbox bigint;original_receipts bigint;
 journal public.program_text_reviewed_pdf_initial_journal%rowtype;failed boolean;checks integer:=0;fn text;role_name text;
BEGIN
 IF jsonb_typeof(doc->'blocks')='array' THEN
  doc:=jsonb_set(doc,'{blocks}',(SELECT jsonb_agg(b||jsonb_build_object('context',jsonb_build_object('representation','reviewed_visible_pdf_text','method','independent_agent_visible_transcription','document_scope','sample_application',
  'profile_sha256',doc#>>'{reviewed_pdf,profile_sha256}','original_render_sha256',doc#>>ARRAY['reviewed_pdf','pages',((b->>'page')::integer-1)::text,'original_render_sha256'],
  'reviewed_transcript_sha256',doc#>>ARRAY['reviewed_pdf','pages',((b->>'page')::integer-1)::text,'reviewed_transcript_sha256'])||(b->'context')) ORDER BY ordinal)
  FROM jsonb_array_elements(doc->'blocks') WITH ORDINALITY AS entry(b,ordinal)));
  doc:=doc||jsonb_build_object('blocks_json',pg_temp.reviewed_pdf_canonical_json(doc->'blocks'));
 END IF;
 SELECT to_jsonb(s) INTO STRICT before_source FROM public.shared_award_sources s WHERE s.id=target;
 old_state:=before_source->'text_monitoring_state';epoch_id:=(old_state->>'epoch')::uuid;
 next_state:=jsonb_build_object('schema','awardping.program-text-state.v1','epoch',epoch_id,'status','baseline_ready','baseline_ref',doc->'reference','latest_ref',doc->'reference',
 'first_captured_at',doc#>>'{reference,captured_at}','last_checked_at',doc#>>'{reference,captured_at}','successful_checks',1);
 SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY attempt_number),'[]') INTO original_failures FROM public.program_text_collection_failures f WHERE f.source_id=target;
 SELECT count(*) INTO original_candidates FROM public.shared_award_visual_review_candidates;SELECT count(*) INTO original_facts FROM public.program_basic_fact_snapshots;
 SELECT count(*) INTO original_alerts FROM public.program_text_alert_reviews;SELECT count(*) INTO original_outbox FROM public.public_digest_outbox;SELECT count(*) INTO original_receipts FROM public.public_digest_event_receipts;
 IF NOT private.awardping_reviewed_pdf_document_valid(doc) THEN RAISE EXCEPTION 'Actual reviewed projection rejected';END IF;checks:=checks+1;
 IF private.awardping_program_text_reference_valid(doc->'reference') THEN RAISE EXCEPTION 'Unadmitted reserved projection accepted';END IF;checks:=checks+1;
 EXECUTE format('PREPARE reviewed_pdf_constant_proof AS SELECT private.awardping_program_source_approval_document_valid(%L::jsonb)',(doc-'reviewed_pdf')::text);
 EXECUTE 'EXECUTE reviewed_pdf_constant_proof' INTO failed;
 IF failed THEN RAISE EXCEPTION 'Unadmitted constant source proof accepted';END IF;checks:=checks+1;
 IF private.awardping_reviewed_pdf_document_valid(jsonb_set(doc,'{reviewed_pdf,completeness_scope}','null')) OR
 private.awardping_reviewed_pdf_document_valid(jsonb_set(doc,'{reviewed_pdf,hidden_or_unreadable_source_values_inferred}','true')) OR
 private.awardping_reviewed_pdf_document_valid(jsonb_set(doc,'{reviewed_pdf,pages,19,page}','19')) OR
 private.awardping_reviewed_pdf_document_valid(jsonb_set(doc,'{text}',to_jsonb((doc->>'text')||' invented')))
 THEN RAISE EXCEPTION 'Tampered projection, omitted page or false provenance accepted';END IF;checks:=checks+1;
 FOREACH fn IN ARRAY ARRAY['public.admit_reviewed_visible_pdf_profile(uuid,uuid,jsonb,jsonb,text)','public.transition_reviewed_pdf_first_coverage(uuid,jsonb,jsonb,jsonb,text,text)'] LOOP
  IF has_function_privilege('anon',fn,'EXECUTE') OR has_function_privilege('authenticated',fn,'EXECUTE') OR NOT has_function_privilege('service_role',fn,'EXECUTE') THEN RAISE EXCEPTION 'RPC privilege leak';END IF;checks:=checks+1;
 END LOOP;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  failed:=false;BEGIN EXECUTE format('SET LOCAL ROLE %I',role_name);PERFORM public.admit_reviewed_visible_pdf_profile(target,epoch_id,doc,receipt,reason);
  EXCEPTION WHEN insufficient_privilege THEN failed:=true;END;EXECUTE 'RESET ROLE';IF NOT failed THEN RAISE EXCEPTION 'Unauthorized admission accepted';END IF;checks:=checks+1;
 END LOOP;
 failed:=false;BEGIN PERFORM public.admit_reviewed_visible_pdf_profile(target,epoch_id,doc,jsonb_set(receipt,'{independent_review_sha256}',to_jsonb(repeat('f',64))),reason);
 EXCEPTION WHEN check_violation THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Wrong independent review accepted';END IF;checks:=checks+1;
 EXECUTE 'SET LOCAL ROLE service_role';result:=public.admit_reviewed_visible_pdf_profile(target,epoch_id,doc,receipt,reason);EXECUTE 'RESET ROLE';
 IF result->>'admitted'<>'true' OR result->>'already_admitted'<>'false' OR NOT private.awardping_program_text_reference_valid(doc->'reference') THEN RAISE EXCEPTION 'Native service admission failed';END IF;checks:=checks+1;
 EXECUTE 'EXECUTE reviewed_pdf_constant_proof' INTO failed;EXECUTE 'DEALLOCATE reviewed_pdf_constant_proof';
 IF NOT failed OR NOT private.awardping_program_source_approval_document_valid(doc-'reviewed_pdf') OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'blocks') b WHERE NOT private.awardping_program_block_valid('{"heading":null,"page":null,"kind":null,"context":null}'::jsonb||b,doc->>'text'))
 THEN RAISE EXCEPTION 'Admitted constant source proof or full reviewed blocks rejected';END IF;checks:=checks+1;
 again:=public.admit_reviewed_visible_pdf_profile(target,epoch_id,doc,receipt,reason);IF again->>'already_admitted'<>'true' OR again->'profile_id' IS DISTINCT FROM result->'profile_id' THEN RAISE EXCEPTION 'Admission idempotence failed';END IF;checks:=checks+1;
 IF private.awardping_program_text_reference_valid(jsonb_set(doc->'reference','{extractor,name}','"other"')) OR
 private.awardping_program_text_reference_valid(jsonb_set(doc->'reference','{extractor,version}','"other"')) OR
 private.awardping_program_text_reference_valid(jsonb_set(doc->'reference','{text_sha256}',to_jsonb(repeat('f',64))))
 THEN RAISE EXCEPTION 'Reserved-name or version-prefix bypass accepted';END IF;checks:=checks+1;
 failed:=false;BEGIN PERFORM public.transition_reviewed_pdf_first_coverage(target,old_state,jsonb_set(next_state,'{successful_checks}','2'),doc,policy,reason);
 EXCEPTION WHEN check_violation THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'A repeat was fabricated';END IF;checks:=checks+1;
 failed:=false;BEGIN PERFORM public.transition_reviewed_pdf_first_coverage(target,jsonb_set(old_state,'{successful_checks}','999'),next_state,doc,policy,reason);
 EXCEPTION WHEN serialization_failure THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Stale previous source accepted';END IF;checks:=checks+1;
 EXECUTE 'SET LOCAL ROLE service_role';result:=public.transition_reviewed_pdf_first_coverage(target,old_state,next_state,doc,policy,reason);EXECUTE 'RESET ROLE';
 IF result->>'applied'<>'true' OR result->>'creates_update'<>'false' OR result->>'idempotent'<>'false' THEN RAISE EXCEPTION 'Native silent transition failed';END IF;checks:=checks+1;
 SELECT * INTO STRICT journal FROM public.program_text_reviewed_pdf_initial_journal WHERE source_id=target;
 IF journal.previous_source IS DISTINCT FROM before_source OR journal.previous_state IS DISTINCT FROM old_state OR journal.collection_failures IS DISTINCT FROM original_failures
 OR journal.document IS DISTINCT FROM doc OR journal.next_state IS DISTINCT FROM next_state
 OR (SELECT text_monitoring_state FROM public.shared_award_sources WHERE id=target) IS DISTINCT FROM next_state THEN RAISE EXCEPTION 'Original evidence/history lost';END IF;checks:=checks+1;
 again:=public.transition_reviewed_pdf_first_coverage(target,old_state,next_state,doc,policy,reason);
 IF again->>'idempotent'<>'true' OR again->'journal_id' IS DISTINCT FROM result->'journal_id' THEN RAISE EXCEPTION 'Transition idempotence failed';END IF;checks:=checks+1;
 failed:=false;BEGIN PERFORM public.transition_reviewed_pdf_first_coverage(target,old_state,next_state,doc,policy,reason||' different');
 EXCEPTION WHEN serialization_failure THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Different repeat was accepted';END IF;checks:=checks+1;
 failed:=false;BEGIN UPDATE public.program_text_reviewed_pdf_profiles SET reason='erase';EXCEPTION WHEN insufficient_privilege THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Profile history mutable';END IF;checks:=checks+1;
 failed:=false;BEGIN DELETE FROM public.program_text_reviewed_pdf_initial_journal;EXCEPTION WHEN insufficient_privilege THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Original history deletable';END IF;checks:=checks+1;
 failed:=false;BEGIN TRUNCATE public.program_text_reviewed_pdf_initial_journal;EXCEPTION WHEN insufficient_privilege THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Original history truncatable';END IF;checks:=checks+1;
 IF (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY attempt_number),'[]') FROM public.program_text_collection_failures f WHERE f.source_id=target) IS DISTINCT FROM original_failures
 OR (SELECT count(*) FROM public.shared_award_visual_review_candidates)<>original_candidates OR (SELECT count(*) FROM public.program_basic_fact_snapshots)<>original_facts
 OR (SELECT count(*) FROM public.program_text_alert_reviews)<>original_alerts OR (SELECT count(*) FROM public.public_digest_outbox)<>original_outbox OR (SELECT count(*) FROM public.public_digest_event_receipts)<>original_receipts
 THEN RAISE EXCEPTION 'Comparisons, failures, facts or outgoing alerts changed';END IF;checks:=checks+1;
 RAISE NOTICE 'reviewed_pdf_native_checks=%, all changes will be rolled back',checks;
END $reviewed_pdf_rehearsal$;
ROLLBACK;
`;
}
