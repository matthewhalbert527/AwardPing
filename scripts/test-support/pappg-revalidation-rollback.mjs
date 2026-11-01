// Render only. The caller cold-restores the genuine pair, reviews the migration,
// and executes this inside one unconditional rollback transaction.
import {buildProgramTextCapture} from '../lib/program-text-capture-contract.mjs';
import {programTextReference} from '../lib/program-text-artifacts.mjs';
import {buildProgramTextRawAnchorProviderLink} from '../lib/program-text-source-raw-anchor.mjs';
import {createHash} from 'node:crypto';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const literal=x=>"'"+JSON.stringify(x).replaceAll("'","''")+"'::jsonb";
// Explicit synthetic SQL-helper regression only. These captures are never
// uploaded, admitted, passed to the live RPC or mixed with the genuine pair.
export function pappgRevalidationEmptySliceProbe(){
 const source={id:'c49e85e3-3b19-4052-891f-c2bc67e8b8f6',shared_award_id:'d955a846-cee1-4c01-932e-e3cb7215f3fb',
  url:'https://www.nsf.gov/funding/opportunities/grfp-nsf-graduate-research-fellowship-program/nsf26-526/solicitation',title:'SYNTHETIC SQL empty-slice probe',page_type:'other'};
 const target='https://www.nsf.gov/policies/pappg',removed='Randolph Building, 401 Dulany Street, Alexandria, VA 22314 ';
 const old='Print: Required Policy Links '+removed+'Publication date: synthetic Last updated: synthetic Footer About Us';
 const make=(text,date)=>buildProgramTextCapture({source,acquisition:'http_html',captured_at:date,
  extractor:{name:'synthetic-empty-slice-probe',version:'1'},content_type:'text/html',
  raw_bytes:Buffer.from('<html><body><main><a href="/policies/pappg">PAPPG</a><p>'+text+'</p></main></body></html>'),
  text,blocks:[{id:'synthetic-footer',text,start_utf16:0,end_utf16:text.length}]});
 const before=make(old,'2026-10-30T20:00:00.000Z'),after=make(old.replace(removed,''),'2026-10-31T20:00:00.000Z');
 const p={cohort_key:'nsf_grfp',expected_canonical_shared_award_id:source.shared_award_id,
  source:{id:'de868fe8-54ba-4fa0-8210-b27c8f182112',shared_award_id:source.shared_award_id,url:target,page_type:'other',expected_member_kind:'canonical'},
  authority_ref:programTextReference(after),link_proof:{kind:'retained_raw_html_anchor.v1',target_page_url:target,
   anchor_start_utf16:after.raw_source.bytes.toString('utf8').indexOf('<a ')}};
 const doc=c=>({reference:programTextReference(c),text:c.text,blocks:c.blocks,blocks_json:JSON.stringify(canonical(c.blocks))});
 return{proposal:p,validation:{schema:'awardping.pappg-canonical-revalidation-validation.v1',proposal:p,
  previous_document:doc(before),authority_document:doc(after),provider_link:buildProgramTextRawAnchorProviderLink(p,after)}};
}
export function pappgRevalidationRollbackSql({proposal,validation,actor}){
 const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
 if(!uuid(actor)||!uuid(proposal?.id))throw Error('Real actor and operation UUID required');
 if(JSON.stringify({proposal,validation}).includes('$pappg_revalidation_rehearsal$'))throw Error('SQL body delimiter collision');
 const edge=pappgRevalidationEmptySliceProbe();
 return `BEGIN;
SET LOCAL application_name='ap-pappg-reval-${proposal.id}';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='1s';
SET LOCAL idle_in_transaction_session_timeout='30s';
-- Place the reviewed, unapplied migration here, after BEGIN and before DO.
DO $pappg_revalidation_rehearsal$
DECLARE p jsonb:=${literal(proposal)};v jsonb:=${literal(validation)};actor uuid:='${actor}';bad jsonb;proof jsonb;result jsonb;replay jsonb;
 before_disposition jsonb;before_sources jsonb;before_roles jsonb;before_events bigint;before_candidates bigint;
 source_ids uuid[];
 pending uuid;approval_hash text;authority_state jsonb;did_fail boolean;case_name text;
BEGIN
 ASSERT private.awardping_pappg_revalidation_documents_valid(${literal(edge.proposal)},${literal(edge.validation)},
  ${literal(edge.validation.previous_document.reference)}),'Synthetic zero-prefix and zero-suffix SQL regression failed';
 SELECT to_jsonb(d),d.pending_id INTO STRICT before_disposition,pending FROM public.program_text_pappg_canonical_dispositions d
  WHERE selected_source_id='de868fe8-54ba-4fa0-8210-b27c8f182112';
 ASSERT NOT EXISTS(SELECT 1 FROM public.program_text_pappg_canonical_revalidations WHERE id=(p->>'id')::uuid),'Refuse existing operation identity';
 ASSERT private.awardping_pappg_canonical_boundary_current(pending,true) IS FALSE,'Fixture needs the actual stale original admission';
 SELECT array_agg(sid ORDER BY sid) INTO source_ids FROM (SELECT c.source_id sid FROM private.awardping_pappg_canonical_catalogue() c
  UNION SELECT 'de868fe8-54ba-4fa0-8210-b27c8f182112'::uuid UNION SELECT 'c49e85e3-3b19-4052-891f-c2bc67e8b8f6'::uuid) finite;
 ASSERT cardinality(source_ids)=11,'Finite rehearsal source scope changed';
 SELECT jsonb_agg(jsonb_build_array(s.id,s.shared_award_id,s.url,s.title,s.page_type,s.admin_review_status,s.last_hash,
  encode(extensions.digest(convert_to(s.text_monitoring_state::text,'UTF8'),'sha256'),'hex'),
  encode(extensions.digest(convert_to(s.page_metadata::text,'UTF8'),'sha256'),'hex')) ORDER BY s.id)
  INTO before_sources FROM public.shared_award_sources s WHERE s.id=any(source_ids);
 SELECT jsonb_agg(jsonb_build_array(r.source_role,r.revision,r.source_ids,r.manifest_status,
  encode(extensions.digest(convert_to(r.evidence::text,'UTF8'),'sha256'),'hex')) ORDER BY r.source_role)
  INTO before_roles FROM public.program_text_source_roster r WHERE r.cohort_key='nsf_grfp';
 SELECT count(*) INTO before_events FROM public.shared_award_change_events WHERE shared_award_source_id=any(source_ids);
 SELECT count(*) INTO before_candidates FROM public.shared_award_visual_review_candidates WHERE shared_award_source_id=any(source_ids);
 FOR case_name IN SELECT unnest(ARRAY['null_proposal','null_validation','source','predecessor','role_cas','catalogue_cas','actor','stale_review','review_before_capture','text_hash','original_reference','raw_hash','raw_anchor']) LOOP
  bad:=p;proof:=v;
  CASE case_name
   WHEN 'source' THEN bad:=jsonb_set(bad,'{source_id}',to_jsonb(gen_random_uuid()::text));
   WHEN 'predecessor' THEN bad:=jsonb_set(bad,'{expected_previous_revision}',to_jsonb(gen_random_uuid()::text));
   WHEN 'role_cas' THEN bad:=jsonb_set(bad,'{expected_context,inspection,context,roles,0,revision}',to_jsonb(gen_random_uuid()::text));
   WHEN 'catalogue_cas' THEN bad:=jsonb_set(bad,'{expected_context,inspection,context,catalogue,0,title}','"Changed history"'::jsonb);
   WHEN 'actor' THEN bad:=jsonb_set(bad,'{review,actor_id}',to_jsonb(gen_random_uuid()::text));
   WHEN 'stale_review' THEN bad:=jsonb_set(bad,'{review,reviewed_at}',to_jsonb(to_char(clock_timestamp()-interval '1 day','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
   WHEN 'review_before_capture' THEN bad:=jsonb_set(bad,'{review,reviewed_at}',to_jsonb(to_char((p#>>'{authority_ref,captured_at}')::timestamptz-interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
   WHEN 'text_hash' THEN proof:=jsonb_set(proof,'{authority_document,text}',to_jsonb((proof#>>'{authority_document,text}')||' changed'));
   WHEN 'original_reference' THEN proof:=jsonb_set(proof,'{previous_document,reference,capture_id}',to_jsonb(repeat('0',64)));
   WHEN 'raw_hash' THEN proof:=jsonb_set(proof,'{provider_link,raw_base64}','"AAAA"'::jsonb);
   WHEN 'raw_anchor' THEN proof:=jsonb_set(proof,'{provider_link,anchor,start_utf16}','0'::jsonb);
   ELSE NULL;
  END CASE;
  proof:=jsonb_set(proof,'{proposal}',bad);
  did_fail:=false;
  BEGIN
   PERFORM public.revalidate_program_text_pappg_canonical(CASE WHEN case_name='null_proposal' THEN NULL ELSE bad END,
    CASE WHEN case_name='null_validation' THEN NULL ELSE proof END,actor);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '40001' THEN did_fail:=true;END;
  ASSERT did_fail,'Negative case accepted: '||case_name;
  ASSERT NOT EXISTS(SELECT 1 FROM public.program_text_pappg_canonical_revalidations WHERE id=(p->>'id')::uuid),'Negative left receipt';
 END LOOP;
 result:=public.revalidate_program_text_pappg_canonical(p,v,actor);
 ASSERT result->>'id'=p->>'id' AND result->'idempotent'='false'::jsonb,'New immutable receipt mismatch';
 ASSERT private.awardping_pappg_canonical_boundary_current(pending,true),'Strict current boundary did not recover';
 ASSERT private.awardping_program_source_allowed('de868fe8-54ba-4fa0-8210-b27c8f182112'),'Standard source approval did not recover';
 ASSERT private.awardping_program_text_canonical_url_admission('de868fe8-54ba-4fa0-8210-b27c8f182112',(p->>'epoch')::uuid)->>'revision'=p->>'id','DTO omitted successor revision';
 replay:=public.revalidate_program_text_pappg_canonical(p,v,actor);
 ASSERT replay->'idempotent'='true'::jsonb AND replay->>'content_hash'=result->>'content_hash','Exact replay mismatch';
 ASSERT (SELECT to_jsonb(d) FROM public.program_text_pappg_canonical_dispositions d WHERE pending_id=pending)=before_disposition,'Original disposition changed';
 ASSERT (SELECT jsonb_agg(jsonb_build_array(s.id,s.shared_award_id,s.url,s.title,s.page_type,s.admin_review_status,s.last_hash,
  encode(extensions.digest(convert_to(s.text_monitoring_state::text,'UTF8'),'sha256'),'hex'),
  encode(extensions.digest(convert_to(s.page_metadata::text,'UTF8'),'sha256'),'hex')) ORDER BY s.id)
  FROM public.shared_award_sources s WHERE s.id=any(source_ids))=before_sources,'Finite source state changed';
 ASSERT (SELECT jsonb_agg(jsonb_build_array(r.source_role,r.revision,r.source_ids,r.manifest_status,
  encode(extensions.digest(convert_to(r.evidence::text,'UTF8'),'sha256'),'hex')) ORDER BY r.source_role)
  FROM public.program_text_source_roster r WHERE r.cohort_key='nsf_grfp')=before_roles,'NSF role state changed';
 ASSERT (SELECT count(*) FROM public.shared_award_change_events WHERE shared_award_source_id=any(source_ids))=before_events,'Created finite public event';
 ASSERT (SELECT count(*) FROM public.shared_award_visual_review_candidates WHERE shared_award_source_id=any(source_ids))=before_candidates,'Created finite review candidate';
 did_fail:=false;
 BEGIN UPDATE public.program_text_pappg_canonical_revalidations SET actor_id=gen_random_uuid() WHERE id=(p->>'id')::uuid;
 EXCEPTION WHEN SQLSTATE '23514' THEN did_fail:=true;END;ASSERT did_fail,'Receipt was mutable';
 did_fail:=false;
 BEGIN DELETE FROM public.program_text_pappg_canonical_revalidations WHERE id=(p->>'id')::uuid;
 EXCEPTION WHEN SQLSTATE '23514' THEN did_fail:=true;END;ASSERT did_fail,'Receipt was deletable';
 -- Reverting to the old original must never reactivate the old boundary once
 -- a successor exists. This state change is rolled back in the inner block.
 BEGIN
  SELECT text_monitoring_state INTO authority_state FROM public.shared_award_sources WHERE id='c49e85e3-3b19-4052-891f-c2bc67e8b8f6';
  UPDATE public.shared_award_sources SET text_monitoring_state=jsonb_set(jsonb_set(authority_state,'{baseline_ref}',p#>'{expected_context,original_authority_ref}'),'{latest_ref}',p#>'{expected_context,original_authority_ref}')
   WHERE id='c49e85e3-3b19-4052-891f-c2bc67e8b8f6';
  ASSERT private.awardping_pappg_canonical_boundary_current(pending,true) IS FALSE,'Stale successor fell back to original authority';
  RAISE EXCEPTION USING ERRCODE='P9998',MESSAGE='rollback authority probe';
 EXCEPTION WHEN SQLSTATE 'P9998' THEN NULL;END;
 SELECT content_hash INTO STRICT approval_hash FROM public.program_text_source_approvals WHERE id=pending;
 PERFORM public.revoke_program_text_source_approval(pending,approval_hash,'Rollback-only verification that a successor cannot bypass revocation.',actor::text);
 ASSERT private.awardping_pappg_canonical_boundary_current(pending,true) IS FALSE,'Revoked original retained successor authority';
 did_fail:=false;
 BEGIN PERFORM public.revalidate_program_text_pappg_canonical(p,v,actor);EXCEPTION WHEN SQLSTATE '40001' THEN did_fail:=true;END;
 ASSERT did_fail,'Replay reactivated a revoked admission';
 SET CONSTRAINTS ALL IMMEDIATE;
 RAISE NOTICE 'PASS PAPPG revalidation:13 negatives,strict successor,exact replay,immutable history,DTO binding,no source/role/event/candidate writes,stale precedence,revocation';
END;
$pappg_revalidation_rehearsal$;
SET LOCAL ROLE authenticated;
DO $deny$ BEGIN
 BEGIN PERFORM public.revalidate_program_text_pappg_canonical(NULL,NULL,NULL);RAISE EXCEPTION 'Authenticated unexpectedly revalidated';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END;$deny$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $deny$ BEGIN
 BEGIN PERFORM public.revalidate_program_text_pappg_canonical(NULL,NULL,NULL);RAISE EXCEPTION 'Anon unexpectedly revalidated';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END;$deny$;
RESET ROLE;
ROLLBACK;
`;
}

/** One bounded case per independent transaction, never an automatic retry.
 * Caller inserts the exact reviewed migration using a replacement callback. */
export function pappgRevalidationSingleRollbackSql({proposal,validation,actor,case_name='success'}){
 const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
 if(!uuid(actor)||!uuid(proposal?.id)||!['success','bad_role','bad_raw_anchor','unauthorized','revocation','replay'].includes(case_name))throw Error('Finite native case, real actor and operation UUID required');
 const declarations=`DECLARE p jsonb:=${literal(proposal)};v jsonb:=${literal(validation)};actor uuid:='${actor}';result jsonb;replay jsonb;bad jsonb;did_fail boolean:=false;pending uuid;approval_hash text;`;
 let body;
 if(case_name==='success')body=`${declarations}
BEGIN
 result:=public.revalidate_program_text_pappg_canonical(p,v,actor);
 ASSERT result->>'id'=p->>'id' AND result->'idempotent'='false'::jsonb,'Actual success receipt mismatch';
 ASSERT EXISTS(SELECT 1 FROM public.program_text_pappg_canonical_revalidations r WHERE r.id=(p->>'id')::uuid AND r.content_hash=result->>'content_hash'),'Actual validated receipt missing';
END;`;
 else if(case_name==='bad_role'||case_name==='bad_raw_anchor')body=`${declarations}
BEGIN
 ${case_name==='bad_role'?`p:=jsonb_set(p,'{expected_context,inspection,context,roles,0,revision}',to_jsonb(gen_random_uuid()::text));v:=jsonb_set(v,'{proposal}',p);`:
 `v:=jsonb_set(v,'{provider_link,anchor,start_utf16}','0'::jsonb);`}
 BEGIN PERFORM public.revalidate_program_text_pappg_canonical(p,v,actor);
 EXCEPTION WHEN SQLSTATE '${case_name==='bad_role'?'40001':'23514'}' THEN did_fail:=true;END;
 ASSERT did_fail,'Negative ${case_name} accepted';
 ASSERT NOT EXISTS(SELECT 1 FROM public.program_text_pappg_canonical_revalidations WHERE id=(p->>'id')::uuid),'Negative left receipt';
END;`;
 else if(case_name==='replay')body=`${declarations}
BEGIN
 result:=public.revalidate_program_text_pappg_canonical(p,v,actor);
 replay:=public.revalidate_program_text_pappg_canonical(p,v,actor);
 ASSERT result->'idempotent'='false'::jsonb AND replay->'idempotent'='true'::jsonb AND result->>'content_hash'=replay->>'content_hash','Exact replay mismatch';
END;`;
 else if(case_name==='revocation')body=`${declarations}
BEGIN
 result:=public.revalidate_program_text_pappg_canonical(p,v,actor);
 SELECT d.pending_id INTO STRICT pending FROM public.program_text_pappg_canonical_dispositions d WHERE d.revision=(p->>'disposition_revision')::uuid;
 SELECT content_hash INTO STRICT approval_hash FROM public.program_text_source_approvals WHERE id=pending;
 PERFORM public.revoke_program_text_source_approval(pending,approval_hash,'Rollback-only verification that a successor cannot bypass revocation.',actor::text);
 ASSERT private.awardping_pappg_canonical_boundary_current(pending,true) IS FALSE,'Revoked original retained successor authority';
END;`;
 else body=`BEGIN
 BEGIN PERFORM public.revalidate_program_text_pappg_canonical(NULL,NULL,NULL);RAISE EXCEPTION 'Role unexpectedly revalidated';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END;`;
 let delimiter='$ap_pappg_'+createHash('sha256').update(body).digest('hex').slice(0,24)+'$';
 while(body.includes(delimiter))delimiter=delimiter.slice(0,-1)+'x$';
 const block=`DO ${delimiter}\n${body}\n${delimiter};`;
 return `BEGIN;
SET LOCAL application_name='ap-pappg-${case_name}-${proposal.id}';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='1s';
SET LOCAL idle_in_transaction_session_timeout='30s';
-- Place the reviewed, unapplied migration here, after BEGIN and before DO.
${case_name==='unauthorized'?`SET LOCAL ROLE authenticated;\n${block}\nRESET ROLE;\nSET LOCAL ROLE anon;\n${block}\nRESET ROLE;`:block}
SELECT 'PASS ${case_name}' AS native_case;
ROLLBACK;
`;
}
