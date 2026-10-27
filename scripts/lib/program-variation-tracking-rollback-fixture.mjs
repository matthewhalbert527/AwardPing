// SQL generation only. All seeded sources, approvals, office rows and user
// claims are synthetic or transaction-local and must end in the outer ROLLBACK.
import {buildProgramVariationRollbackFixture} from './program-variation-rollback-fixture.mjs';
export async function buildProgramVariationTrackingRollbackFixture(registries,epoch){
 const base=await buildProgramVariationRollbackFixture(registries,epoch);
 const checks=`
DO $tracking_fixture$
DECLARE fixture_registry public.stage1_award_registry%rowtype;fixture_source public.shared_award_sources%rowtype;
 fixture_office uuid:='ed000000-0000-4000-8000-000000000001';fixture_owner uuid;fixture_context jsonb;fixture_result jsonb;
 fixture_approval uuid:='ed000000-0000-4000-8000-000000000002';fixture_members uuid[];fixture_bindings jsonb;fixture_title text;fixture_url text;
 fixture_failed boolean;tests integer:=0;fixture_count integer;fixture_definition_hash text;
BEGIN
 SELECT user_id INTO fixture_owner FROM public.office_members WHERE status='active' AND role='owner' ORDER BY created_at,id LIMIT 1;
 IF fixture_owner IS NULL THEN RAISE EXCEPTION 'Tracking rehearsal requires an existing real office owner; do not fabricate authentication.';END IF;
 SELECT * INTO STRICT fixture_registry FROM public.stage1_award_registry ORDER BY cohort_key LIMIT 1;
 SELECT * INTO STRICT fixture_source FROM public.shared_award_sources WHERE id='f0000000-0000-4000-8000-000000000001';
 SELECT array_agg(shared_award_id ORDER BY shared_award_id) INTO fixture_members FROM public.stage1_award_members WHERE cohort_key=fixture_registry.cohort_key;
 INSERT INTO public.offices(id,name,created_by) VALUES(fixture_office,'ROLLBACK ONLY approved-source tracking rehearsal',fixture_owner);
 INSERT INTO public.office_members(office_id,user_id,role,status) VALUES(fixture_office,fixture_owner,'owner','active');
 PERFORM set_config('request.jwt.claim.sub',fixture_owner::text,true);
 fixture_title:=fixture_source.title;fixture_url:=fixture_source.url;
 -- This first positive case changes only mutable catalog metadata. The
 -- office must copy its approved capture title and shared review overview.
 UPDATE public.shared_award_sources SET title='UNAPPROVED LATEST TITLE' WHERE id=fixture_source.id;
 fixture_context:=public.get_program_variation_tracking_context(fixture_registry.cohort_key,null);
 IF fixture_context->'source_id'<>'null'::jsonb OR jsonb_array_length(fixture_context->'source_ids')<>1
 OR fixture_context#>>'{source_ids,0}'<>fixture_source.id::text THEN RAISE EXCEPTION 'Default follow escaped the bounded common review';END IF;tests:=tests+1;
 SELECT jsonb_agg(jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type,
  'confidence',s.confidence,'reason',s.reason,'admin_review_status',s.admin_review_status,'updated_at',s.updated_at) ORDER BY s.id) INTO fixture_bindings
 FROM public.shared_award_sources s WHERE s.id=fixture_source.id;
 EXECUTE 'SET LOCAL ROLE authenticated';
 fixture_result:=public.track_office_program_variation_atomic(fixture_office,fixture_registry.canonical_shared_award_id,fixture_members,fixture_registry.release_epoch,fixture_bindings,fixture_context,'daily');
 EXECUTE 'RESET ROLE';
 IF fixture_result#>>'{award,summary}' IS DISTINCT FROM (SELECT parent.validation#>>'{public_facts,overview}' FROM public.program_variation_unit_reviews parent WHERE parent.id=(fixture_context->>'shared_review_id')::uuid)
 OR fixture_result#>>'{sources,0,title}' IS DISTINCT FROM fixture_title OR fixture_result#>>'{sources,0,title}'='UNAPPROVED LATEST TITLE'
 OR fixture_result#>>'{sources,0,page_type}' IS DISTINCT FROM fixture_context#>>array['source_bindings',fixture_source.id::text,'page_type']
 THEN RAISE EXCEPTION 'Normal authenticated tracking did not preserve approved facts/title/type.';END IF;tests:=tests+1;
 -- Synthetic independent text authority is seeded only inside this rollback
 -- fixture. The authority operation and its proof were tested separately;
 -- no real source, legacy OPEN state, evidence or approval is fabricated.
 UPDATE public.shared_award_sources SET title=fixture_title,admin_review_status='review_later' WHERE id=fixture_source.id;
 INSERT INTO public.program_text_source_approvals(id,source_id,cohort_key,epoch,shared_award_id,source_url,content_hash,validation,role_receipts,approved_by)
 VALUES(fixture_approval,fixture_source.id,fixture_registry.cohort_key,(fixture_context->>'epoch')::uuid,fixture_source.shared_award_id,fixture_url,repeat('d',64),
 jsonb_build_object('proposal',jsonb_build_object('registration_scope',jsonb_build_object('kind','variation_inventory','inventory_id',fixture_context->'inventory_id'),
 'source',jsonb_build_object('title',fixture_title,'page_type',fixture_source.page_type))),'[]','SYNTHETIC ROLLBACK ONLY');
 INSERT INTO public.program_text_source_approval_events(approval_id,action,actor,reason) VALUES(fixture_approval,'approved','SYNTHETIC ROLLBACK ONLY','Only tests a current independent authority record; never committed.');
 fixture_context:=public.get_program_variation_tracking_context(fixture_registry.cohort_key,fixture_source.id);
 IF fixture_context->>'source_id'<>fixture_source.id::text OR jsonb_array_length(fixture_context->'source_ids')<>1
 OR fixture_context#>>'{source_ids,0}'<>fixture_source.id::text THEN RAISE EXCEPTION 'Explicit follow escaped its one pinned source';END IF;tests:=tests+1;
 SELECT jsonb_agg(jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type,
  'confidence',s.confidence,'reason',s.reason,'admin_review_status',s.admin_review_status,'updated_at',s.updated_at) ORDER BY s.id) INTO fixture_bindings
 FROM public.shared_award_sources s WHERE s.id=fixture_source.id;
 EXECUTE 'SET LOCAL ROLE authenticated';
 fixture_result:=public.track_office_program_variation_atomic(fixture_office,fixture_registry.canonical_shared_award_id,fixture_members,fixture_registry.release_epoch,fixture_bindings,fixture_context,'daily');
 EXECUTE 'RESET ROLE';
 IF fixture_result->>'alreadyTracked'<>'true' OR (SELECT admin_review_status FROM public.shared_award_sources WHERE id=fixture_source.id)<>'review_later'
 OR (SELECT count(*) FROM public.monitors WHERE office_id=fixture_office)<>1 THEN RAISE EXCEPTION 'Independent review_later follow was blocked, faked OPEN or duplicated.';END IF;tests:=tests+1;
 SELECT count(*) INTO fixture_count FROM public.award_sources WHERE office_id=fixture_office;
 fixture_failed:=false;BEGIN PERFORM public.track_office_program_variation_atomic('ed000000-0000-4000-8000-000000000099',fixture_registry.canonical_shared_award_id,fixture_members,fixture_registry.release_epoch,fixture_bindings,fixture_context,'daily');EXCEPTION WHEN insufficient_privilege THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Wrong office was authorized';END IF;tests:=tests+1;
 fixture_failed:=false;BEGIN UPDATE public.office_members SET role='member' WHERE office_id=fixture_office;
 PERFORM public.track_office_program_variation_atomic(fixture_office,fixture_registry.canonical_shared_award_id,fixture_members,fixture_registry.release_epoch,fixture_bindings,fixture_context,'daily');EXCEPTION WHEN insufficient_privilege THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Ordinary office member was authorized';END IF;tests:=tests+1;
 PERFORM set_config('request.jwt.claim.sub','',true);fixture_failed:=false;BEGIN PERFORM public.track_office_program_variation_atomic(fixture_office,fixture_registry.canonical_shared_award_id,fixture_members,fixture_registry.release_epoch,fixture_bindings,fixture_context,'daily');EXCEPTION WHEN invalid_authorization_specification THEN fixture_failed:=true;END;
 PERFORM set_config('request.jwt.claim.sub',fixture_owner::text,true);IF NOT fixture_failed THEN RAISE EXCEPTION 'Unauthenticated follow was authorized';END IF;tests:=tests+1;
 fixture_failed:=false;BEGIN PERFORM public.track_office_program_variation_atomic(fixture_office,fixture_registry.canonical_shared_award_id,ARRAY[fixture_registry.canonical_shared_award_id,fixture_registry.canonical_shared_award_id],fixture_registry.release_epoch,fixture_bindings,fixture_context,'daily');EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Wrong member set was accepted';END IF;tests:=tests+1;
 fixture_failed:=false;BEGIN PERFORM public.track_office_program_variation_atomic(fixture_office,fixture_registry.canonical_shared_award_id,fixture_members,gen_random_uuid(),fixture_bindings,fixture_context,'daily');EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Wrong original release epoch was accepted';END IF;tests:=tests+1;
 fixture_failed:=false;BEGIN PERFORM public.track_office_program_variation_atomic(fixture_office,fixture_registry.canonical_shared_award_id,fixture_members,fixture_registry.release_epoch,fixture_bindings,jsonb_set(fixture_context,'{release_revision}',to_jsonb(gen_random_uuid())),'daily');EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Stale variation release was accepted';END IF;tests:=tests+1;
 fixture_failed:=false;BEGIN PERFORM public.track_office_program_variation_atomic(fixture_office,fixture_registry.canonical_shared_award_id,fixture_members,fixture_registry.release_epoch,fixture_bindings,jsonb_set(fixture_context,'{approval_hash}',to_jsonb(repeat('0',64))),'daily');EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Stale approval hash was accepted';END IF;tests:=tests+1;
 fixture_failed:=false;BEGIN PERFORM public.track_office_program_variation_atomic(fixture_office,fixture_registry.canonical_shared_award_id,fixture_members,fixture_registry.release_epoch,fixture_bindings,jsonb_set(fixture_context,'{inventory_revision}',to_jsonb(gen_random_uuid())),'daily');EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Stale inventory revision was accepted';END IF;tests:=tests+1;
 fixture_failed:=false;BEGIN PERFORM public.track_office_program_variation_atomic(fixture_office,fixture_registry.canonical_shared_award_id,fixture_members,fixture_registry.release_epoch,jsonb_set(fixture_bindings,'{0,updated_at}',to_jsonb('1999-01-01T00:00:00Z'::text)),fixture_context,'daily');EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Stale mutable source proof was accepted';END IF;tests:=tests+1;
 fixture_failed:=false;BEGIN UPDATE public.award_sources SET url=fixture_url||'/' WHERE office_id=fixture_office;
 PERFORM public.track_office_program_variation_atomic(fixture_office,fixture_registry.canonical_shared_award_id,fixture_members,fixture_registry.release_epoch,fixture_bindings,fixture_context,'daily');EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Different exact document history was silently reassigned';END IF;tests:=tests+1;
 fixture_failed:=false;BEGIN PERFORM public.get_program_variation_tracking_context(fixture_registry.cohort_key,'ed000000-0000-4000-8000-000000000099');EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Unapproved source was admitted';END IF;tests:=tests+1;
 fixture_failed:=false;BEGIN UPDATE public.shared_award_sources SET url=fixture_url||'/unapproved' WHERE id=fixture_source.id;
 PERFORM public.get_program_variation_tracking_context(fixture_registry.cohort_key,fixture_source.id);EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Unapproved source URL was admitted';END IF;tests:=tests+1;
 fixture_failed:=false;BEGIN UPDATE public.shared_award_sources SET shared_award_id=(SELECT canonical_shared_award_id FROM public.stage1_award_registry WHERE cohort_key<>fixture_registry.cohort_key ORDER BY cohort_key LIMIT 1) WHERE id=fixture_source.id;
 PERFORM public.get_program_variation_tracking_context(fixture_registry.cohort_key,fixture_source.id);EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Wrong award owner was admitted';END IF;tests:=tests+1;
 fixture_failed:=false;BEGIN INSERT INTO public.program_text_source_approval_events(approval_id,action,actor,reason) VALUES(fixture_approval,'revoked','SYNTHETIC ROLLBACK ONLY','Revocation must deny follow without rewriting historical evidence.');
 PERFORM public.get_program_variation_tracking_context(fixture_registry.cohort_key,fixture_source.id);EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Revoked text authority was admitted';END IF;tests:=tests+1;
 fixture_failed:=false;BEGIN UPDATE public.program_variation_release SET is_active=false;
 PERFORM public.get_program_variation_tracking_context(fixture_registry.cohort_key,fixture_source.id);EXCEPTION WHEN serialization_failure THEN fixture_failed:=true;END;
 IF NOT fixture_failed THEN RAISE EXCEPTION 'Inactive publication was admitted';END IF;tests:=tests+1;
 IF (SELECT count(*) FROM public.award_sources WHERE office_id=fixture_office)<>fixture_count
 OR (SELECT count(*) FROM public.monitors WHERE office_id=fixture_office)<>1 THEN RAISE EXCEPTION 'A failed follow left partial office writes';END IF;tests:=tests+1;
 IF has_function_privilege('anon','public.track_office_program_variation_atomic(uuid,uuid,uuid[],uuid,jsonb,jsonb,text)','EXECUTE')
 OR has_function_privilege('service_role','public.track_office_program_variation_atomic(uuid,uuid,uuid[],uuid,jsonb,jsonb,text)','EXECUTE')
 OR NOT has_function_privilege('authenticated','public.track_office_program_variation_atomic(uuid,uuid,uuid[],uuid,jsonb,jsonb,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.get_program_variation_tracking_context(text,uuid)','EXECUTE') THEN RAISE EXCEPTION 'Authenticated tracking privilege boundary changed';END IF;tests:=tests+1;
 SELECT encode(extensions.digest(convert_to(proc_rows.prosrc,'UTF8'),'sha256'),'hex') INTO STRICT fixture_definition_hash FROM pg_catalog.pg_proc proc_rows JOIN pg_catalog.pg_namespace namespace_rows ON namespace_rows.oid=proc_rows.pronamespace
 WHERE namespace_rows.nspname='public' AND proc_rows.proname='track_office_shared_award_atomic';
 IF fixture_definition_hash<>'2be909383f89f8ef5e479b034b6f690c22a034fafc76957e09dd041e876ffcfd' THEN RAISE EXCEPTION 'Legacy tracking was changed';END IF;tests:=tests+1;
 PERFORM set_config('awardping.tracking_fixture_results',jsonb_build_object('assertions',tests,'paid_calls',0,'persistent_writes',0)::text,true);
END $tracking_fixture$;
SELECT current_setting('awardping.tracking_fixture_results') AS tracking_rollback_only_acceptance;
`;
 return base.replace(/ROLLBACK;\s*$/,()=>checks+'\nROLLBACK;\n');
}
