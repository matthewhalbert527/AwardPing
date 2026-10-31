// Render only. No connection, source acquisition, provider call or execution.
// Every case is one bounded transaction with an unconditional terminal rollback.
import{createHash}from'node:crypto';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const literal=x=>"'"+JSON.stringify(x).replaceAll("'","''")+"'::jsonb";
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x)&&!/^0{8}(?:-0{4}){3}-0{12}$/.test(x);
const check=(ok,why)=>{if(!ok)throw Error('Reviewed-repeat rollback renderer: '+why);};
export const REVIEWED_REPEAT_ROLLBACK_CASES=Object.freeze(['e2e','attest','unknownkind','tamper_support','rawhash','unsettledreservation','stalehead','anon','authenticated']);

export function currentBasicReviewedRepeatRollbackSql({plan,actor,caseName='e2e',migrationSql=''}){
 check(plan?.schema==='awardping.private-reviewed-repeat-native-e2e-template.v1'&&plan.status==='TEMPLATE_NOT_DATABASE_PROOF'&&plan.cohort==='schwarzman'&&uuid(plan.expected_head)&&uuid(actor)&&REVIEWED_REPEAT_ROLLBACK_CASES.includes(caseName),'actual_finite_template_actor_and_case_required');
 check(plan.reviewed_validation?.source_id==='f322a07c-f78c-47fd-aafb-ab6422a4248f'&&plan.reviewed_validation.kind==='reviewed_no_program_change'&&plan.reviewed_validation.expected_head===plan.expected_head&&Array.isArray(plan.byte_attestations)&&plan.byte_attestations.length<=4,'exact_root_reviewed_schwarzman_fixture_required');
 check(typeof migrationSql==='string'&&!/^\s*(?:begin|commit|rollback)\s*;/im.test(migrationSql),'migration_cannot_control_outer_transaction');
 const identity=hash({plan,actor,caseName,migration_sha256:createHash('sha256').update(migrationSql).digest('hex')}),applicationName='ap-rr-'+caseName+'-'+identity.slice(0,16),json=literal(plan),all=json+migrationSql+actor;
 let delimiter='$ap_rr_'+identity.slice(0,16)+'$',i=0;while(all.includes(delimiter)){check(i++<100,'unable_to_choose_collision_safe_delimiter');delimiter='$ap_rr_'+identity.slice(0,16)+'_'+i+'$';}
 const denied=['anon','authenticated'].includes(caseName);
 let body;
 if(denied){body=`BEGIN
 BEGIN
  PERFORM public.attest_program_basic_reviewed_repeat(NULL,NULL);
  RAISE EXCEPTION 'Unprivileged reviewed-repeat execution was allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 RAISE NOTICE 'PASS reviewed-repeat ${caseName} execute denied';
END;`;}
 else{
 const negative=!['e2e','attest'].includes(caseName),mutation={unknownkind:"v:=jsonb_set(v,'{kind}','\"invented_equivalence\"'::jsonb);",tamper_support:"v:=jsonb_set(v,'{support_projection,0,current_quote,text}',to_jsonb((v#>>'{support_projection,0,current_quote,text}')||' forged'));v:=jsonb_set(v,'{support_hash}',to_jsonb(private.awardping_reviewed_repeat_hash(v->'support_projection')));",rawhash:"v:=jsonb_set(v,'{current_raw,raw_base64}','\"AAAA\"'::jsonb);",unsettledreservation:"v:=jsonb_set(v,'{paid_reservation,status}','\"submitted\"'::jsonb);",stalehead:"v:=jsonb_set(v,'{expected_head}',to_jsonb(gen_random_uuid()::text));"}[caseName]||'';
 body=`DECLARE t jsonb:=${json};v jsonb;actor text:='${actor}';result jsonb;byte_plan jsonb;byte_result jsonb;proofs jsonb;client_validation jsonb;draft jsonb;receipt jsonb;receipt_hash text;committed jsonb;getter jsonb;version jsonb;
 old_head uuid;before_rows bigint;after_rows bigint;source_ids uuid[];before_sources jsonb;after_sources jsonb;before_candidate text;before_paid text;before_events bigint;did_fail boolean:=false;
BEGIN
 v:=t->'reviewed_validation';
 SELECT snapshot_id INTO STRICT old_head FROM public.program_basic_fact_heads WHERE cohort_key='schwarzman';
 ASSERT old_head::text=t->>'expected_head','Actual parent head changed';
 SELECT array_agg((x#>>'{source,id}')::uuid ORDER BY x#>>'{source,id}') INTO source_ids FROM jsonb_array_elements(t#>'{client_validation_template,review,capture_refs}') x;
 ASSERT cardinality(source_ids)=5,'Finite five-source fixture changed';
 SELECT jsonb_agg(jsonb_build_array(id,shared_award_id,url,encode(extensions.digest(convert_to(text_monitoring_state::text,'UTF8'),'sha256'),'hex')) ORDER BY id)
  INTO before_sources FROM public.shared_award_sources WHERE id=any(source_ids);
 before_candidate:=private.awardping_reviewed_repeat_hash(private.awardping_reviewed_repeat_candidate((v->>'candidate_id')::uuid));
 before_paid:=private.awardping_reviewed_repeat_hash(private.awardping_reviewed_repeat_paid(v->'candidate'));
 SELECT count(*) INTO before_events FROM public.shared_award_change_events WHERE shared_award_source_id=any(source_ids);
 SELECT count(*) INTO before_rows FROM public.program_basic_reviewed_repeat_observations WHERE cohort_key='schwarzman' AND source_id=(v->>'source_id')::uuid AND candidate_id=(v->>'candidate_id')::uuid AND expected_head=old_head;
 ${mutation}
 ${negative?`EXECUTE 'SET LOCAL ROLE service_role';
 BEGIN PERFORM public.attest_program_basic_reviewed_repeat(v,actor);EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '40001' THEN did_fail:=true;END;
 EXECUTE 'RESET ROLE';
 ASSERT did_fail,'Negative case ${caseName} accepted';
 SELECT count(*) INTO after_rows FROM public.program_basic_reviewed_repeat_observations WHERE cohort_key='schwarzman' AND source_id=(t#>>'{reviewed_validation,source_id}')::uuid AND candidate_id=(t#>>'{reviewed_validation,candidate_id}')::uuid AND expected_head=old_head;
 ASSERT after_rows=before_rows,'Negative case left an immutable receipt';`:`EXECUTE 'SET LOCAL ROLE service_role';
 result:=public.attest_program_basic_reviewed_repeat(v,actor);
 EXECUTE 'RESET ROLE';
 ASSERT result->'ok'='true'::jsonb AND result->>'id' IS NOT NULL AND result->>'content_hash' IS NOT NULL,'Real attestation did not return its receipt';
 ASSERT private.awardping_reviewed_repeat_row_current((result->>'id')::uuid),'Real reviewed proof is not current';
 ${caseName==='e2e'?`client_validation:=t->'client_validation_template';
 SELECT jsonb_agg(CASE WHEN p->>'kind'='reviewed_no_program_change' THEN
  jsonb_set(jsonb_set(p,'{reviewed_repeat_observation_id}',result->'id'),'{reviewed_repeat_hash}',result->'content_hash') ELSE p END ORDER BY ord)
  INTO proofs FROM jsonb_array_elements(client_validation->'current_source_proofs') WITH ORDINALITY x(p,ord);
 FOR byte_plan IN SELECT value FROM jsonb_array_elements(t->'byte_attestations') LOOP
  EXECUTE 'SET LOCAL ROLE service_role';
  byte_result:=public.attest_program_basic_repeat(byte_plan#>>'{parameters,p_cohort_key}',byte_plan#>'{parameters,p_current_ref}',byte_plan#>'{parameters,p_repeat_document}',(byte_plan#>>'{parameters,p_verified_at}')::timestamptz,actor);
  EXECUTE 'RESET ROLE';
  ASSERT byte_result->'ok'='true'::jsonb AND byte_result->>'id' IS NOT NULL,'Genuine byte repeat was not attested';
  SELECT jsonb_agg(CASE WHEN p->>'source_id'=byte_plan->>'source_id' THEN jsonb_set(p,'{repeat_observation_id}',byte_result->'id') ELSE p END ORDER BY ord)
   INTO proofs FROM jsonb_array_elements(proofs) WITH ORDINALITY x(p,ord);
 END LOOP;
 client_validation:=jsonb_set(client_validation,'{current_source_proofs}',proofs);
 EXECUTE 'SET LOCAL ROLE service_role';
 draft:=public.save_current_program_basic_fact_review(client_validation,actor);
 EXECUTE 'RESET ROLE';
 ASSERT draft->>'id' IS NOT NULL AND draft->>'content_hash' IS NOT NULL,'Real saved draft identity missing';
 receipt:=jsonb_set(jsonb_set(jsonb_set(t->'receipt_template','{current_source_proofs}',proofs),'{input_review_id}',draft->'id'),'{input_review_hash}',draft->'content_hash');
 receipt_hash:=private.awardping_reviewed_repeat_hash(receipt);
 EXECUTE 'SET LOCAL ROLE service_role';
 committed:=public.commit_current_program_basic_facts((draft->>'id')::uuid,draft->>'content_hash',old_head,receipt,receipt_hash,'${identity}');
 EXECUTE 'RESET ROLE';
 ASSERT committed->'ok'='true'::jsonb AND committed->>'snapshot_id' IS NOT NULL,'Real current-basic commit failed';
 ASSERT (SELECT snapshot_id FROM public.program_basic_fact_heads WHERE cohort_key='schwarzman')=(committed->>'snapshot_id')::uuid,'New actual head missing';
 EXECUTE 'SET LOCAL ROLE service_role';
 getter:=public.get_program_basic_facts(ARRAY[(receipt->>'award_id')::uuid]);
 EXECUTE 'RESET ROLE';
 ASSERT jsonb_array_length(getter)=1 AND getter#>'{0,current}'='true'::jsonb AND getter#>>'{0,snapshot_id}'=committed->>'snapshot_id','New head is not current through the actual getter';
 ASSERT getter#>'{0,public_facts}'=t->'public_preview','Actual published facts differ from reviewed old+new preview';
 SELECT value INTO STRICT version FROM public.program_basic_fact_snapshots x CROSS JOIN LATERAL jsonb_array_elements(x.source_versions) WHERE x.id=(committed->>'snapshot_id')::uuid AND value->>'kind'='reviewed_no_program_change';
 ASSERT private.awardping_reviewed_repeat_version_valid((committed->>'snapshot_id')::uuid,jsonb_set(version,'{epoch}',to_jsonb(gen_random_uuid()::text))) IS FALSE,'Foreign epoch survived new-kind currentness';`:`ASSERT (SELECT snapshot_id FROM public.program_basic_fact_heads WHERE cohort_key='schwarzman')=old_head,'Attestation changed the basic head';`}`}
 SELECT jsonb_agg(jsonb_build_array(id,shared_award_id,url,encode(extensions.digest(convert_to(text_monitoring_state::text,'UTF8'),'sha256'),'hex')) ORDER BY id)
  INTO after_sources FROM public.shared_award_sources WHERE id=any(source_ids);
 ASSERT after_sources=before_sources,'Source identities or monitoring state changed';
 ASSERT private.awardping_reviewed_repeat_hash(private.awardping_reviewed_repeat_candidate((t#>>'{reviewed_validation,candidate_id}')::uuid))=before_candidate,'Normal candidate changed';
 ASSERT private.awardping_reviewed_repeat_hash(private.awardping_reviewed_repeat_paid(t#>'{reviewed_validation,candidate}'))=before_paid,'Paid history changed';
 ASSERT (SELECT count(*) FROM public.shared_award_change_events WHERE shared_award_source_id=any(source_ids))=before_events,'Created an alert/update event';
 RAISE NOTICE 'PASS reviewed-repeat ${caseName}: actual pair/candidate/paid/source/head preserved; transaction rolls back';
END;`;
 }
 return `BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL standard_conforming_strings=on;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='1s';
SET LOCAL idle_in_transaction_session_timeout='30s';
SET LOCAL application_name='${applicationName}';
${migrationSql}
${denied?'SET LOCAL ROLE '+caseName+';':'RESET ROLE;'}
DO ${delimiter}
${body}
${delimiter};
RESET ROLE;
ROLLBACK;
`;
}
