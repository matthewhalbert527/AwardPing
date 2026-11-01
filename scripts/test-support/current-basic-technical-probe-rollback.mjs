// Rendering only: no connections, acquisition, provider calls or execution.
import{createHash}from'node:crypto';
import{prepareNativeJsonTransport,nativeJsonTransportExpression,NATIVE_JSON_TRANSPORT_SQL}from'./native-json-transport.mjs';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x)&&!/^0{8}(?:-0{4}){3}-0{12}$/.test(x);
const check=(ok,why)=>{if(!ok)throw Error('Technical-probe rollback renderer: '+why);};
export const TECHNICAL_PROBE_ROLLBACK_CASES=Object.freeze(['e2e','attest','unknownkind','tamper_support','rawhash','unsettledreservation','stalehead','ownerhash','earlierprobe','anon','authenticated']);
export function currentBasicTechnicalProbeRollbackSql({plan,actor,caseName='e2e',migrationSql=''}){
 check(plan?.schema==='awardping.private-technical-probe-native-e2e-template.v1'&&plan.status==='TEMPLATE_NOT_DATABASE_PROOF'&&plan.cohort==='daad_study'&&uuid(plan.expected_head)&&uuid(actor)&&TECHNICAL_PROBE_ROLLBACK_CASES.includes(caseName),'actual_finite_template_actor_and_case_required');
 check(plan.technical_validation?.source_id==='88906939-65e7-492d-a671-da56678dfecd'&&plan.technical_validation.kind==='retained_technical_repeat'&&plan.technical_validation.provenance_kind==='post_change_technical_probe'&&plan.technical_validation.expected_head===plan.expected_head,'exact_root_reviewed_daad_fixture_required');
 check(typeof migrationSql==='string'&&!/^\s*(?:begin|commit|rollback)\s*;/im.test(migrationSql),'migration_cannot_control_outer_transaction');
 const identity=hash({plan,actor,caseName,migration_sha256:createHash('sha256').update(migrationSql).digest('hex')}),applicationName='ap-tp-'+caseName+'-'+identity.slice(0,16),json=nativeJsonTransportExpression(prepareNativeJsonTransport(plan)),all=json+migrationSql+actor;
 let delimiter='$ap_tp_'+identity.slice(0,16)+'$',i=0;while(all.includes(delimiter)){check(i++<100,'unable_to_choose_collision_safe_delimiter');delimiter='$ap_tp_'+identity.slice(0,16)+'_'+i+'$';}
 const denied=['anon','authenticated'].includes(caseName),negative=!['e2e','attest'].includes(caseName);
 const mutation={unknownkind:"v:=jsonb_set(v,'{kind}','\"invented_equivalence\"'::jsonb);",tamper_support:"v:=jsonb_set(v,'{support_projection,0,current_quote,text}',to_jsonb((v#>>'{support_projection,0,current_quote,text}')||' forged'));v:=jsonb_set(v,'{support_hash}',to_jsonb(private.awardping_reviewed_repeat_hash(v->'support_projection')));",rawhash:"v:=jsonb_set(v,'{probe_raw,raw_base64}','\"AAAA\"'::jsonb);",unsettledreservation:"v:=jsonb_set(v,'{paid_reservation,status}','\"submitted\"'::jsonb);",stalehead:"v:=jsonb_set(v,'{expected_head}',to_jsonb(gen_random_uuid()::text));",ownerhash:"v:=jsonb_set(v,'{owner_review_hash}',to_jsonb(repeat('0',64)));",earlierprobe:"v:=jsonb_set(jsonb_set(v,'{probe_document}',v->'causal_previous_document'),'{probe_raw}',v->'causal_previous_raw');"}[caseName]||'';
 const body=denied?`BEGIN
 BEGIN PERFORM public.attest_program_basic_technical_repeat(NULL,NULL);RAISE EXCEPTION 'Unprivileged technical-probe execution was allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 PERFORM set_config('awardping.technical_probe_native_result',jsonb_build_object('status','PASS','case','${caseName}','execute_denied',true)::text,true);
 RAISE NOTICE 'PASS technical-probe ${caseName} execute denied';
END;`:`DECLARE t jsonb:=${json};v jsonb;actor text:='${actor}';result jsonb;proofs jsonb;client_validation jsonb;draft jsonb;receipt jsonb;receipt_hash text;committed jsonb;getter jsonb;version jsonb;
 old_head uuid;before_rows bigint;after_rows bigint;source_ids uuid[];before_sources jsonb;after_sources jsonb;before_candidate text;before_paid text;before_owner text;before_event text;before_evidence text;before_events bigint;did_fail boolean:=false;
BEGIN
 v:=t->'technical_validation';
 SELECT snapshot_id INTO STRICT old_head FROM public.program_basic_fact_heads WHERE cohort_key='daad_study';
 ASSERT old_head::text=t->>'expected_head','Actual parent head changed';
 SELECT array_agg((x#>>'{source,id}')::uuid ORDER BY x#>>'{source,id}') INTO source_ids FROM jsonb_array_elements(t#>'{client_validation_template,review,capture_refs}') x;
 ASSERT cardinality(source_ids)=3,'Finite three-source fixture changed';
 SELECT jsonb_agg(jsonb_build_array(id,shared_award_id,url,encode(extensions.digest(convert_to(text_monitoring_state::text,'UTF8'),'sha256'),'hex')) ORDER BY id) INTO before_sources FROM public.shared_award_sources WHERE id=any(source_ids);
 before_candidate:=private.awardping_reviewed_repeat_hash(private.awardping_reviewed_repeat_candidate((v->>'causal_candidate_id')::uuid));
 before_paid:=private.awardping_reviewed_repeat_hash(private.awardping_reviewed_repeat_paid(v->'causal_candidate'));
 before_owner:=private.awardping_reviewed_repeat_hash(private.awardping_technical_repeat_owner_review((v->>'causal_candidate_id')::uuid));
 before_event:=private.awardping_reviewed_repeat_hash(private.awardping_technical_repeat_published_event((v->>'causal_candidate_id')::uuid));
 before_evidence:=private.awardping_reviewed_repeat_hash(private.awardping_technical_repeat_published_evidence((v->>'causal_candidate_id')::uuid));
 ASSERT (SELECT text_monitoring_state->'latest_ref' FROM public.shared_award_sources WHERE id=(v->>'source_id')::uuid)=v#>'{current_document,reference}','Actual latest current reference changed';
 ASSERT (SELECT text_monitoring_state->'baseline_ref' FROM public.shared_award_sources WHERE id=(v->>'source_id')::uuid)=v#>'{current_document,reference}','Actual approved baseline changed';
 ASSERT private.awardping_current_basic_pending_review((v->>'source_id')::uuid) IS NULL,'Actual approved source unexpectedly has a pending owner review';
 SELECT count(*) INTO before_events FROM public.shared_award_change_events WHERE shared_award_source_id=any(source_ids);
 SELECT count(*) INTO before_rows FROM public.program_basic_technical_repeat_observations WHERE cohort_key='daad_study' AND source_id=(v->>'source_id')::uuid AND causal_candidate_id=(v->>'causal_candidate_id')::uuid AND expected_head=old_head;
 ${mutation}
 ${negative?`EXECUTE 'SET LOCAL ROLE service_role';
 BEGIN PERFORM public.attest_program_basic_technical_repeat(v,actor);EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '40001' THEN did_fail:=true;END;
 EXECUTE 'RESET ROLE';ASSERT did_fail,'Negative case ${caseName} accepted';
 SELECT count(*) INTO after_rows FROM public.program_basic_technical_repeat_observations WHERE cohort_key='daad_study' AND source_id=(t#>>'{technical_validation,source_id}')::uuid AND causal_candidate_id=(t#>>'{technical_validation,causal_candidate_id}')::uuid AND expected_head=old_head;
 ASSERT after_rows=before_rows,'Negative case left an immutable receipt';`:`EXECUTE 'SET LOCAL ROLE service_role';
 result:=public.attest_program_basic_technical_repeat(v,actor);EXECUTE 'RESET ROLE';
 ASSERT result->'ok'='true'::jsonb AND result->>'id' IS NOT NULL AND result->>'content_hash' IS NOT NULL,'Real technical attestation did not return its receipt';
 ASSERT private.awardping_technical_repeat_row_current((result->>'id')::uuid),'Real technical proof is not current';
 ${caseName==='e2e'?`client_validation:=t->'client_validation_template';
 SELECT jsonb_agg(CASE WHEN p->>'kind'='retained_technical_repeat' THEN jsonb_set(jsonb_set(p,'{technical_repeat_observation_id}',result->'id'),'{technical_repeat_hash}',result->'content_hash') ELSE p END ORDER BY ord)
  INTO proofs FROM jsonb_array_elements(client_validation->'current_source_proofs') WITH ORDINALITY x(p,ord);
 client_validation:=jsonb_set(client_validation,'{current_source_proofs}',proofs);
 EXECUTE 'SET LOCAL ROLE service_role';draft:=public.save_current_program_basic_fact_review(client_validation,actor);EXECUTE 'RESET ROLE';
 ASSERT draft->>'id' IS NOT NULL AND draft->>'content_hash' IS NOT NULL,'Real saved draft identity missing';
 receipt:=jsonb_set(jsonb_set(jsonb_set(t->'receipt_template','{current_source_proofs}',proofs),'{input_review_id}',draft->'id'),'{input_review_hash}',draft->'content_hash');
 receipt_hash:=private.awardping_reviewed_repeat_hash(receipt);
 EXECUTE 'SET LOCAL ROLE service_role';committed:=public.commit_current_program_basic_facts((draft->>'id')::uuid,draft->>'content_hash',old_head,receipt,receipt_hash,'${identity}');EXECUTE 'RESET ROLE';
 ASSERT committed->'ok'='true'::jsonb AND committed->>'snapshot_id' IS NOT NULL,'Real current-basic commit failed';
 ASSERT (SELECT snapshot_id FROM public.program_basic_fact_heads WHERE cohort_key='daad_study')=(committed->>'snapshot_id')::uuid,'New actual head missing';
 EXECUTE 'SET LOCAL ROLE service_role';getter:=public.get_program_basic_facts(ARRAY[(receipt->>'award_id')::uuid]);EXECUTE 'RESET ROLE';
 ASSERT jsonb_array_length(getter)=1 AND getter#>'{0,current}'='true'::jsonb AND getter#>>'{0,snapshot_id}'=committed->>'snapshot_id','New technical head is not current through actual getter';
 ASSERT getter#>'{0,public_facts}'=t->'public_preview','Actual public facts differ from reviewed old+new preview';
 SELECT value INTO STRICT version FROM public.program_basic_fact_snapshots x CROSS JOIN LATERAL jsonb_array_elements(x.source_versions) WHERE x.id=(committed->>'snapshot_id')::uuid AND value->>'kind'='retained_technical_repeat';
 ASSERT private.awardping_technical_repeat_version_valid((committed->>'snapshot_id')::uuid,jsonb_set(version,'{epoch}',to_jsonb(gen_random_uuid()::text))) IS FALSE,'Foreign epoch survived technical currentness';`:`ASSERT (SELECT snapshot_id FROM public.program_basic_fact_heads WHERE cohort_key='daad_study')=old_head,'Attestation changed the basic head';`}`}
 SELECT jsonb_agg(jsonb_build_array(id,shared_award_id,url,encode(extensions.digest(convert_to(text_monitoring_state::text,'UTF8'),'sha256'),'hex')) ORDER BY id) INTO after_sources FROM public.shared_award_sources WHERE id=any(source_ids);
 ASSERT after_sources=before_sources,'Source baseline/latest/counters or identities changed';
 ASSERT (SELECT text_monitoring_state->'latest_ref' FROM public.shared_award_sources WHERE id=(t#>>'{technical_validation,source_id}')::uuid) IS DISTINCT FROM t#>'{technical_validation,probe_document,reference}','Later probe was adopted as source latest';
 ASSERT private.awardping_reviewed_repeat_hash(private.awardping_reviewed_repeat_candidate((t#>>'{technical_validation,causal_candidate_id}')::uuid))=before_candidate,'Accepted causal candidate changed';
 ASSERT private.awardping_reviewed_repeat_hash(private.awardping_reviewed_repeat_paid(t#>'{technical_validation,causal_candidate}'))=before_paid,'Causal settled paid history changed';
 ASSERT private.awardping_reviewed_repeat_hash(private.awardping_technical_repeat_owner_review((t#>>'{technical_validation,causal_candidate_id}')::uuid))=before_owner,'Approved owner review changed';
 ASSERT private.awardping_reviewed_repeat_hash(private.awardping_technical_repeat_published_event((t#>>'{technical_validation,causal_candidate_id}')::uuid))=before_event,'Published event changed';
 ASSERT private.awardping_reviewed_repeat_hash(private.awardping_technical_repeat_published_evidence((t#>>'{technical_validation,causal_candidate_id}')::uuid))=before_evidence,'Published capture evidence changed';
 ASSERT (SELECT count(*) FROM public.shared_award_change_events WHERE shared_award_source_id=any(source_ids))=before_events,'Created an alert/update event';
 PERFORM set_config('awardping.technical_probe_native_result',jsonb_build_object('status','PASS','case','${caseName}','attestation_id',result->'id','snapshot_id',committed->'snapshot_id','approved_owner_event_evidence_preserved',true,'source_state_preserved',true,'probe_not_adopted',true)::text,true);
 RAISE NOTICE 'PASS technical-probe ${caseName}: approved cause/owner/event/evidence/settled paid/source state preserved; later probe not adopted; transaction rolls back';
END;`;
 return `BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL standard_conforming_strings=on;
SET LOCAL plpgsql.check_asserts=on;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='1s';
SET LOCAL idle_in_transaction_session_timeout='30s';
SET LOCAL application_name='${applicationName}';
${migrationSql}
${NATIVE_JSON_TRANSPORT_SQL}
${denied?'SET LOCAL ROLE '+caseName+';':'RESET ROLE;'}
DO ${delimiter}
${body}
${delimiter};
RESET ROLE;
SELECT current_setting('awardping.technical_probe_native_result')::jsonb AS result;
ROLLBACK;
`;
}
