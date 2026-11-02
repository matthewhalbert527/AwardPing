// A distinct proof purpose for a genuinely retained post-change probe. The
// accepted programme change and actual approved publication are preserved verbatim.
// This module never labels that causal candidate no_program_change.
import{createHash}from'node:crypto';
import{load}from'cheerio';
import{programTextReference}from'./program-text-artifacts.mjs';
import{validateProgramTextCapture}from'./program-text-capture-contract.mjs';
import{buildProgramTextComparison,buildProgramTextReviewPackets,validateProgramTextReviewResult}from'./program-text-review.mjs';
import{assertCurrentBasicSource}from'./current-basic-source-proof.mjs';
import{reviewedBasicHash as hash,reviewedBasicEqual as equal,reviewedBasicCandidateSnapshot,reviewedBasicSupportProjection,reviewedDaadSponsoredCards}from'./current-basic-reviewed-repeat.mjs';

export const TECHNICAL_BASIC_REPEAT_KIND='retained_technical_repeat';
export const TECHNICAL_BASIC_REPEAT_PROVENANCE='post_change_technical_probe';
export const TECHNICAL_BASIC_REPEAT_SCHEMA='awardping.current-basic-technical-repeat-validation.v1';
export const TECHNICAL_BASIC_REPEAT_INSPECTION_SCHEMA='awardping.current-basic-technical-repeat-inspection.v1';
export const DAAD_TECHNICAL_PROBE_SOURCE_ID='88906939-65e7-492d-a671-da56678dfecd';
export const DAAD_TECHNICAL_PROBE_OWNER_ID='440d6985-ece9-48c4-ac30-65a739f60d65';
export const DAAD_TECHNICAL_PROBE_URL='https://www.daad.org/en/find-funding/scholarship-database/?origin=44&status=3&type=a&q=&onlydaad=1&language=en&detail_to_show=50026200&tab=';
const PROFILE='daad889_sponsored_university_carousel.v1';
const SELECTOR='div.bg-lightgrey.u-p-medium.js-ad-slider.is-relative[role="region"][aria-roledescription="Karussell"]';
const HEADING='Advertisements by German Universities';
const check=(ok,why)=>{if(!ok)throw Error('Technical basic probe: '+why);};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x)&&!/^0{8}(?:-0{4}){3}-0{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(x).digest('hex');
const document=c=>({reference:programTextReference(c),text:c.text,blocks:c.blocks,blocks_json:JSON.stringify(canonical(c.blocks))});
const raw=c=>({artifact:programTextReference(c).artifacts.raw,raw_base64:c.raw_source.bytes.toString('base64')});
const flow=s=>s.replace(/\s+/g,' ').trim();
function assertFiniteCapture(capture){
 validateProgramTextCapture(capture);
 check(capture.source.id===DAAD_TECHNICAL_PROBE_SOURCE_ID&&capture.source.shared_award_id===DAAD_TECHNICAL_PROBE_OWNER_ID&&capture.source.url===DAAD_TECHNICAL_PROBE_URL&&capture.final_url===DAAD_TECHNICAL_PROBE_URL&&capture.acquisition==='http_html'&&capture.completeness.status==='complete'&&capture.completeness.reasons.length===0,'complete_exact_daad889_original_required');
}
function textVariants(node){const values=[];const walk=n=>{if(n.type==='text')values.push(n.data);else if(!['script','style','template','noscript'].includes(n.name))for(const child of n.children||[])walk(child);};walk(node);return[flow(values.join(' ')),flow(values.join(''))];}

function carousel(capture){
 assertFiniteCapture(capture);const bytes=capture.raw_source.bytes,html=bytes.toString('utf8');
 check(Buffer.from(html,'utf8').equals(bytes)&&!html.startsWith('\ufeff')&&!html.includes('\0'),'carousel_raw_encoding');
 const dom=load(html,{sourceCodeLocationInfo:true}),nodes=dom(SELECTOR);check(nodes.length===1&&!dom('base').length,'unique_actual_carousel_required');
 const node=nodes[0],widget=dom(node),location=node.sourceCodeLocation;
 check(node.namespace==='http://www.w3.org/1999/xhtml'&&location?.startTag&&location?.endTag&&widget.parents('body').length===1&&!widget.parents('script,style,template,noscript,iframe,svg,math').length,'actual_body_carousel_required');
 const{cards,scope_nodes}=reviewedDaadSponsoredCards(dom,widget,HEADING);
 const headingId=widget.attr('aria-labelledby');check(/^headline-[a-f0-9]{8,32}$/.test(headingId||'')&&widget.find('h2[id]').filter((i,h)=>dom(h).attr('id')===headingId&&flow(dom(h).text())===HEADING).length===1,'actual_carousel_heading_reference_required');
 const insideText=textVariants({name:'div',children:scope_nodes}),insideHrefs=cards.find('a[href]').map((i,a)=>dom(a).attr('href')).get(),outside=dom('body').clone();outside.find(SELECTOR).remove();
 const outsideText=textVariants(outside[0]),outsideHrefs=outside.find('a[href]').map((i,a)=>dom(a).attr('href')).get();
 const belongs=(block,strict)=>{
  if(block.kind==='source_link'&&block.context?.source_attribute==='href')return insideHrefs.includes(block.text)&&(!strict||!outsideHrefs.includes(block.text));
  const value=flow(block.text),staticLabel=value===HEADING&&block.context?.heading_path?.some(h=>h.text===HEADING)&&widget.find('p.u-dateline').filter((i,p)=>flow(dom(p).text())===value).length===cards.length;
  return value.length>0&&insideText.some(t=>t.includes(value))&&(!strict||staticLabel||!outsideText.some(t=>t.includes(value)));
 };
 const attributes={...node.attribs};delete attributes['aria-labelledby'];const snippet=html.slice(location.startOffset,location.endOffset);
 return{belongs,marker:{profile:PROFILE,selector:SELECTOR,start_utf16:location.startOffset,end_utf16:location.endOffset,html:snippet,html_sha256:sha(Buffer.from(snippet)),container_attributes:attributes,raw_container_attributes:node.attribs,card_count:cards.length,heading:HEADING,excluded_support_block_ids:capture.blocks.filter(b=>belongs(b,false)).map(b=>b.id)}};
}

function cfDestination(text,block){
 const match=/^\/cdn-cgi\/l\/email-protection#([a-f0-9]+)$/i.exec(text);if(!match||match[1].length<6||match[1].length>8194||match[1].length%2)return null;
 const encoded=Buffer.from(match[1],'hex'),bytes=Buffer.from([...encoded.subarray(1)].map(b=>b^encoded[0]));if(!bytes.length||!bytes.every(b=>b>=33&&b<=126))return null;
 const value=bytes.toString('ascii'),local=value.split('@')[0];
 if(bytes.length<=254&&local.length<=64&&!local.startsWith('.')&&!local.endsWith('.')&&!local.includes('..')&&/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value))return bytes;
 if(block.context?.link_text!=='Email this Page'||block.context?.heading_path?.at(-1)?.text!=='Share this page')return null;
 const share=/^\?subject=([^&]+)(?:&|&#0*38;|&#[xX]0*26;)body=(.+)$/.exec(value);if(!share||/%(?![a-f0-9]{2})/i.test(value))return null;
 try{const subject=decodeURIComponent(share[1]),body=decodeURIComponent(share[2]);return subject.length&&body.length&&!/\p{Cc}/u.test(subject+body)?bytes:null;}catch{return null;}
}

/** Pure comparison of actual current text with a later probe. The comparison
 * is never saved or represented as a normal queue candidate/model outcome. */
export function technicalProbeRules(current,probe,epoch){
 for(const c of[current,probe])assertFiniteCapture(c);
 check(equal(current.source,probe.source)&&equal(current.extractor,probe.extractor)&&Date.parse(current.captured_at)<Date.parse(probe.captured_at),'independent_later_same_source_probe_required');
 const comparison=buildProgramTextComparison(current,probe,{epoch,cycle_id:null});
 check(comparison.status==='review_required'&&comparison.changed_blocks.length>0&&comparison.changed_blocks.length<=256,'bounded_actual_technical_comparison_required');
 const rules=[],currentEdits=[],probeEdits=[];let currentWidget,probeWidget;
 for(const change of comparison.changed_blocks){
  const before=change.previous,after=change.current;check(before||after,'empty_technical_change');
  check((!before||current.text.slice(before.start_utf16,before.end_utf16)===before.text)&&(!after||probe.text.slice(after.start_utf16,after.end_utf16)===after.text),'technical_slice_not_literal');
  const scope=before&&after&&before.kind===after.kind&&before.heading===after.heading&&before.page===after.page&&equal(before.context,after.context);
  if(scope&&before.kind==='source_link'&&before.context?.source_attribute==='href'&&/^\/cdn-cgi\/l\/email-protection#/.test(before.text)){
   const a=cfDestination(before.text,before),b=cfDestination(after.text,after);check(a&&b&&a.equals(b),'probe_changed_protected_destination');
   rules.push({change_id:change.id,kind:'identical_protected_email_destination',decoded_hex:a.toString('hex')});currentEdits.push({start:before.start_utf16,end:before.end_utf16,marker:['identical_protected_email_destination',a.toString('hex')]});probeEdits.push({start:after.start_utf16,end:after.end_utf16,marker:['identical_protected_email_destination',b.toString('hex')]});
  }else{
   currentWidget??=carousel(current);probeWidget??=carousel(probe);
   check(equal(currentWidget.marker.container_attributes,probeWidget.marker.container_attributes)&&(!before||currentWidget.belongs(before,true))&&(!after||probeWidget.belongs(after,true)),'probe_change_outside_exact_sponsored_widget:'+change.id);
   rules.push({change_id:change.id,kind:'raw_marked_ancillary_widget',profile:PROFILE});
  }
 }
 const widgetRuns=(capture,widget)=>{if(!widget)return[];const ids=new Set(widget.marker.excluded_support_block_ids),runs=[];let run=null;for(const block of capture.blocks){if(ids.has(block.id)){if(run&&/^\s*$/.test(capture.text.slice(run.end,block.start_utf16)))run.end=block.end_utf16;else{run={start:block.start_utf16,end:block.end_utf16,marker:['raw_marked_ancillary_widget',PROFILE]};runs.push(run);}}else run=null;}return runs;};
 const residual=(capture,technical,widget)=>{const widgets=widgetRuns(capture,widget),edits=[...technical.filter(t=>!widgets.some(w=>t.start>=w.start&&t.end<=w.end)),...widgets].sort((a,b)=>a.start-b.start),parts=[];let at=0;for(const edit of edits){check(edit.start>=at,'overlapping_probe_edits');parts.push(capture.text.slice(at,edit.start),edit.marker);at=edit.end;}parts.push(capture.text.slice(at));return parts;};
 check(equal(residual(current,currentEdits,currentWidget),residual(probe,probeEdits,probeWidget)),'probe_changed_other_literal_source_text');
 return{technical_comparison:comparison,rules,widget_proofs:currentWidget?[{profile:PROFILE,current_marker:currentWidget.marker,probe_marker:probeWidget.marker}]:[]};
}

function causalEvidence(row,causalPrevious,current){
 const c=row.causal_candidate,p=row.owner_review,e=row.published_event,evidence=row.published_evidence,paid=row.paid_reservation;
 check(uuid(c?.id)&&c.id===row.causal_candidate_id&&hex(row.causal_candidate_hash)&&hash(c)===row.causal_candidate_hash&&equal(reviewedBasicCandidateSnapshot(c),c),'actual_causal_candidate_hash_required');
 check(c.candidate_scope==='program_text_change'&&c.status==='published'&&c.rejection_reason===null&&Number.isFinite(Date.parse(c.published_at))&&Number.isFinite(Date.parse(c.completed_at))&&Date.parse(c.completed_at)>=Date.parse(current.captured_at)&&Date.parse(c.published_at)>=Date.parse(c.completed_at)&&c.shared_award_source_id===DAAD_TECHNICAL_PROBE_SOURCE_ID&&c.shared_award_id===DAAD_TECHNICAL_PROBE_OWNER_ID&&c.source_url===DAAD_TECHNICAL_PROBE_URL&&c.worker_metadata?.monitoring_contract==='program-text-v1'&&c.worker_metadata.epoch===row.epoch&&c.worker_metadata.evidence_signature===c.candidate_signature&&c.worker_metadata.admin_alert_review_id===c.id&&c.worker_metadata.baseline_advanced===true&&uuid(c.worker_metadata.change_event_id),'real_accepted_published_cause_required');
 check(exact(p,['id','candidate_signature','content_hash','created_at','details','event_id','localization','reviewed_at','reviewed_by','status'])&&p.id===c.id&&p.status==='approved'&&p.candidate_signature===c.candidate_signature&&hex(p.content_hash)&&p.id===row.owner_review_id&&p.content_hash===row.owner_review_hash&&uuid(p.reviewed_by)&&Number.isFinite(Date.parse(p.reviewed_at))&&Date.parse(p.reviewed_at)>=Date.parse(c.published_at)&&p.event_id===c.worker_metadata.change_event_id,'real_approved_owner_review_hash_required');
 const oldRef=programTextReference(causalPrevious),ref=programTextReference(current);
 check(equal(c.previous_snapshot_ref,oldRef)&&equal(c.new_snapshot_ref,ref),'causal_source_pair_changed');
 const comparison=buildProgramTextComparison(causalPrevious,current,{epoch:row.epoch,cycle_id:c.prompt_payload?.comparison?.context?.cycle_id}),packets=buildProgramTextReviewPackets(comparison,c.prompt_payload?.packet_plan?.limits);
 check(equal(comparison,c.prompt_payload?.comparison)&&comparison.comparison_id===c.candidate_signature&&packets.status==='ready'&&equal(packets,c.prompt_payload?.packet_plan)&&exact(c.ai_result,['responses','program_text_validation']),'causal_comparison_or_packet_envelope_changed');
 const validation=validateProgramTextReviewResult(comparison,packets,c.ai_result.responses);
 check(validation.status==='accepted'&&equal(validation,c.ai_result.program_text_validation),'causal_programme_change_validation_changed');
 const blocks={previous:[],current:[]};for(const side of['previous','current']){const seen=new Set();for(const change of comparison.changed_blocks)if(change[side]&&!seen.has(change[side].id)){seen.add(change[side].id);blocks[side].push(change[side]);}}
 const localization={schema:'awardping.program-text-publication.v1',epoch:row.epoch,comparison_id:comparison.comparison_id,program_changes:validation.details.program_changes,supporting_blocks:blocks};
 check(equal(p.details,validation.details)&&equal(p.localization,localization),'approved_owner_payload_changed');
 check(uuid(e?.id)&&e.id===p.event_id&&e.visual_review_candidate_id===c.id&&e.shared_award_id===DAAD_TECHNICAL_PROBE_OWNER_ID&&e.shared_award_source_id===DAAD_TECHNICAL_PROBE_SOURCE_ID&&e.source_url===DAAD_TECHNICAL_PROBE_URL&&e.previous_hash===oldRef.text_sha256&&e.new_hash===ref.text_sha256&&e.previous_snapshot_id===null&&e.new_snapshot_id===null&&e.suppressed_at===null&&e.suppression_reason===null&&e.suppression_source===null&&equal(e.change_details,validation.details)&&e.summary===validation.details.summary,'actual_unsuppressed_published_event_required');
 check(uuid(evidence?.id)&&evidence.change_event_id===e.id&&evidence.visual_review_candidate_id===c.id&&evidence.shared_award_id===DAAD_TECHNICAL_PROBE_OWNER_ID&&evidence.shared_award_source_id===DAAD_TECHNICAL_PROBE_SOURCE_ID&&evidence.candidate_signature===c.candidate_signature&&evidence.evidence_schema_version==='program-text-event-evidence-v1'&&evidence.evidence_status==='verified_text'&&typeof evidence.bucket==='string'&&evidence.bucket.length>0&&equal(evidence.previous_capture,oldRef)&&equal(evidence.current_capture,ref)&&equal(evidence.localization,localization)&&Number.isFinite(Date.parse(evidence.verified_at))&&Date.parse(evidence.verified_at)>=Date.parse(c.completed_at),'actual_published_capture_evidence_required');
 const keys=c.worker_metadata.provider_request_keys;
 check(paid?.status==='settled'&&paid.id===c.worker_metadata.gemini_spend_reservation_id&&paid.attempt_token===c.worker_metadata.gemini_spend_attempt_token&&paid.model===c.model&&paid.provider_batch_name===c.gemini_batch_name&&paid.metadata?.candidate_id===c.id&&paid.metadata.monitoring_contract==='program-text-v1'&&paid.lane_key==='changed_page_review'&&paid.worker_source==='program-text-review'&&paid.work_fingerprint===`program-text:${c.candidate_signature}:${c.model}`&&Array.isArray(keys)&&new Set(keys).size===keys.length&&paid.request_count===keys.length&&equal([...keys].sort(),packets.packets.map(p=>p.packet_id).sort())&&Number.isFinite(Date.parse(paid.settled_at))&&typeof paid.spent_source==='string'&&paid.spent_source.length>0,'actual_settled_causal_provider_attempt_required');
}

export function technicalProbeSupportProjection(review,current,probe,widgets=[]){
 const aliases=widgets.map(w=>({current_marker:w.current_marker,previous_marker:w.probe_marker}));
 return reviewedBasicSupportProjection(review,DAAD_TECHNICAL_PROBE_SOURCE_ID,current,probe,aliases);
}

export function validateCurrentBasicTechnicalProbeEvidence(row,{causalPrevious,current,probe}){
 for(const c of[causalPrevious,current,probe])assertFiniteCapture(c);
 check(row.kind===TECHNICAL_BASIC_REPEAT_KIND&&row.provenance_kind===TECHNICAL_BASIC_REPEAT_PROVENANCE&&row.cohort_key==='daad_study'&&row.source_id===DAAD_TECHNICAL_PROBE_SOURCE_ID&&equal(programTextReference(causalPrevious),row.causal_previous_ref)&&equal(programTextReference(current),row.current_ref)&&equal(programTextReference(probe),row.probe_ref)&&equal(causalPrevious.source,current.source)&&equal(current.source,probe.source)&&equal(causalPrevious.extractor,current.extractor)&&equal(current.extractor,probe.extractor)&&Date.parse(causalPrevious.captured_at)<Date.parse(current.captured_at)&&Date.parse(current.captured_at)<Date.parse(probe.captured_at)&&current.capture_id!==probe.capture_id&&row.current_ref.artifacts.metadata.object_key!==row.probe_ref.artifacts.metadata.object_key,'exact_causal_current_and_later_probe_required');
 causalEvidence(row,causalPrevious,current);const proof=technicalProbeRules(current,probe,row.epoch);
 check(equal(proof.technical_comparison,row.technical_comparison)&&equal(proof.rules,row.rules)&&equal(proof.widget_proofs,row.widget_proofs),'technical_probe_proof_changed');return proof;
}

export async function prepareCurrentBasicTechnicalProbeRepeat({inspection,review,probe_ref,verified_at},context){
 check(inspection?.schema===TECHNICAL_BASIC_REPEAT_INSPECTION_SCHEMA&&inspection.packet?.schema==='awardping.current-basic-award-context.v1'&&uuid(inspection.packet.head_id)&&inspection.packet.context.basic_fact_head_id===inspection.packet.head_id&&typeof context.loadCapture==='function'&&equal(Object.fromEntries(Object.keys(inspection.packet.context).map(k=>[k,context[k]])),inspection.packet.context),'fresh_real_technical_probe_inspection_required');
 const source=context.sources.find(s=>s.id===DAAD_TECHNICAL_PROBE_SOURCE_ID),currentRef=source?.text_monitoring_state?.latest_ref,pending=assertCurrentBasicSource(source,currentRef,context);
 check(source.text_monitoring_state.status==='baseline_ready'&&pending===null&&context.registry.cohort_key==='daad_study'&&context.registry.canonical_shared_award_id===DAAD_TECHNICAL_PROBE_OWNER_ID&&equal(source.text_monitoring_state.baseline_ref,currentRef)&&!context.pending_alert_reviews.some(p=>p.source_id===source.id),'actual_approved_baseline_source_required');
 check(review.cohort_key==='daad_study'&&review.award_id===DAAD_TECHNICAL_PROBE_OWNER_ID&&review.epoch===context.epoch&&equal(review.capture_refs.find(r=>r.source.id===source.id),currentRef),'technical_probe_public_review_scope_changed');
 check(typeof verified_at==='string'&&Number.isFinite(Date.parse(verified_at))&&new Date(verified_at).toISOString()===verified_at&&Date.parse(verified_at)<=Date.now()&&Date.now()-Date.parse(verified_at)<=15*60*1000,'fresh_probe_verification_required');
 const causal=reviewedBasicCandidateSnapshot(inspection.causal_candidate),causalRef=causal.previous_snapshot_ref;
 const[causalPrevious,current,probe]=await Promise.all([context.loadCapture(causalRef),context.loadCapture(currentRef),context.loadCapture(probe_ref)]);
 const proof=technicalProbeRules(current,probe,context.epoch),row={kind:TECHNICAL_BASIC_REPEAT_KIND,provenance_kind:TECHNICAL_BASIC_REPEAT_PROVENANCE,cohort_key:'daad_study',source_id:source.id,epoch:context.epoch,expected_head:inspection.packet.head_id,causal_candidate_id:causal.id,causal_candidate_hash:inspection.causal_candidate_hash,causal_candidate:causal,owner_review:inspection.owner_review,owner_review_id:inspection.owner_review?.id,owner_review_hash:inspection.owner_review?.content_hash,published_event:inspection.published_event,published_evidence:inspection.published_evidence,paid_reservation:inspection.paid_reservation,causal_previous_ref:causalRef,current_ref:currentRef,probe_ref,...proof};
 validateCurrentBasicTechnicalProbeEvidence(row,{causalPrevious,current,probe});check(Date.parse(verified_at)>=Date.parse(probe.captured_at)&&Date.parse(verified_at)>=Date.parse(row.owner_review.reviewed_at)&&Date.parse(verified_at)>=Date.parse(causal.published_at),'verification_precedes_later_probe_or_approval');
 const support=technicalProbeSupportProjection(review,current,probe,row.widget_proofs);
 const validation={schema:TECHNICAL_BASIC_REPEAT_SCHEMA,kind:row.kind,provenance_kind:row.provenance_kind,cohort_key:row.cohort_key,source_id:source.id,epoch:row.epoch,expected_head:row.expected_head,causal_candidate_id:row.causal_candidate_id,causal_candidate_hash:row.causal_candidate_hash,causal_candidate:row.causal_candidate,owner_review:row.owner_review,owner_review_id:row.owner_review_id,owner_review_hash:row.owner_review_hash,published_event:row.published_event,published_evidence:row.published_evidence,paid_reservation:row.paid_reservation,causal_previous_document:document(causalPrevious),causal_previous_raw:raw(causalPrevious),current_document:document(current),current_raw:raw(current),probe_document:document(probe),probe_raw:raw(probe),technical_comparison:proof.technical_comparison,rules:proof.rules,widget_proofs:proof.widget_proofs,support_projection:support,support_hash:hash(support),verified_at};
 check(Buffer.byteLength(JSON.stringify(validation))<=32*1024*1024,'bounded_complete_technical_probe_required');return{p_validation:validation};
}

export function currentTechnicalBasicSourceProof(source,ref,context,selected){
 const pending=assertCurrentBasicSource(source,ref,context),rows=context.technical_repeat_observations?.filter(r=>r.id===selected.id)||[];check(rows.length===1,'technical_probe_ledger_missing');const r=rows[0];
 check(pending===null&&source.text_monitoring_state.status==='baseline_ready'&&equal(source.text_monitoring_state.baseline_ref,ref)&&r.kind===TECHNICAL_BASIC_REPEAT_KIND&&r.provenance_kind===TECHNICAL_BASIC_REPEAT_PROVENANCE&&r.cohort_key==='daad_study'&&context.registry.cohort_key==='daad_study'&&r.source_id===source.id&&r.source_id===DAAD_TECHNICAL_PROBE_SOURCE_ID&&r.epoch===context.epoch&&r.expected_head===context.basic_fact_head_id&&equal(r.current_ref,ref)&&r.owner_review?.status==='approved'&&r.owner_review_id===r.owner_review.id&&r.owner_review_hash===r.owner_review.content_hash&&hex(r.content_hash)&&hex(r.support_hash)&&hex(r.causal_candidate_hash),'technical_probe_current_parent_or_approval_binding_changed');
 return{source_id:source.id,repeat_observation_id:null,pending_alert_review_id:null,pending_alert_review_hash:null,kind:TECHNICAL_BASIC_REPEAT_KIND,provenance_kind:TECHNICAL_BASIC_REPEAT_PROVENANCE,technical_repeat_observation_id:r.id,technical_repeat_hash:r.content_hash};
}

export const technicalBasicProofSelection=proof=>({source_id:proof.source_id,id:proof.technical_repeat_observation_id,kind:TECHNICAL_BASIC_REPEAT_KIND});
