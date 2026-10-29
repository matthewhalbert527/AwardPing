import {buildProgramTextCapture} from '../lib/program-text-capture-contract.mjs';
import {programTextReference} from '../lib/program-text-artifacts.mjs';
import {buildProgramTextComparison,buildProgramTextReviewPackets} from '../lib/program-text-review.mjs';

export function documentReferenceFixture({title='Information for Candidates - USA',base='Information for Candidates'}={}) {
 const source={id:'10000000-0000-4000-8000-000000000001',shared_award_id:'20000000-0000-4000-8000-000000000001',url:'https://example.edu/award',title:'Official candidate guidance',page_type:'application'};
 const epoch='30000000-0000-4000-8000-000000000001',path=[{text:'United States of America',level:1},{text:'The scholarship',level:2}],heading='United States of America > The scholarship';
 const paragraph=`As the Scholarships are place-based, the eligibility criteria, application requirements and selection process vary slightly depending on which constituency you are applying for. To ensure that you have all of the information you need to apply, please read the ${base} carefully. You should also check the Conditions of Tenure to ensure that your proposed course of study is covered and share the Guidance for Referees with your referees. These documents can all be accessed below.`;
 const entry=(text,kind)=>({text,kind,heading,context:{heading_path:path,list_path:[],table_row:[]}});
 const capture=(entries,day,raw)=>{
  let text='';const blocks=entries.map((e,i)=>{if(i)text+='\n';const start_utf16=text.length;text+=e.text;return{id:`block-${i}`,start_utf16,end_utf16:text.length,...e};});
  return buildProgramTextCapture({source,final_url:source.url,captured_at:`2026-10-${day}T12:00:00.000Z`,acquisition:'http_html',extractor:{name:'fixture',version:'1'},raw_bytes:Buffer.from(raw),content_type:'text/html',text,blocks});
 };
 const previous=capture([entry(paragraph,'p'),entry(title,'li'),entry('Guidance for Referees - USA','li')],'26',`<main><p>${paragraph}</p><a href="/files/usainformationforcandidates/">${title}</a><p>Guidance for Referees - USA</p></main>`);
 const current=capture([entry(paragraph,'p'),entry('Guidance for Referees - USA','li')],'28',`<main><p>${paragraph}</p><p>Guidance for Referees - USA</p></main>`);
 const comparison=buildProgramTextComparison(previous,current,{epoch,cycle_id:null}),plan=buildProgramTextReviewPackets(comparison),changed=comparison.changed_blocks[0];
 const responses=[{schema:'awardping.program-text-review.v1',comparison_id:comparison.comparison_id,packet_id:plan.packets[0].packet_id,...comparison.context,
  blocks:[{id:changed.id,disposition:'program_change',reason:'The document link/item is no longer listed on the candidate page.',changes:[{field:'documents',operation:'remove',summary:`Removal of the '${title}' document.`,previous_quote:{block_id:changed.previous.id,text:title},current_quote:null,applicant_impact:true}]}]}];
 const reservation={id:'40000000-0000-4000-8000-000000000001',status:'settled',attempt_token:'50000000-0000-4000-8000-000000000001',request_count:1,model:'gemini-3.8-flash',spent_micro_usd:3158,provider_batch_name:'batches/retainedexisting',work_fingerprint:`program-text:${comparison.comparison_id}:gemini-3.8-flash`,metadata:{candidate_id:'60000000-0000-4000-8000-000000000001'}};
 const candidate={id:reservation.metadata.candidate_id,shared_award_source_id:source.id,shared_award_id:source.shared_award_id,source_url:source.url,candidate_signature:comparison.comparison_id,candidate_scope:'program_text_change',status:'failed',rejection_reason:'manual_review_required:unsupported_program_field_evidence',
  previous_snapshot_ref:programTextReference(previous),new_snapshot_ref:programTextReference(current),model:reservation.model,gemini_batch_name:reservation.provider_batch_name,
  worker_metadata:{epoch,monitoring_contract:'program-text-v1',evidence_signature:comparison.comparison_id,provider_request_keys:[plan.packets[0].packet_id],gemini_spend_reservation_id:reservation.id,gemini_spend_attempt_token:reservation.attempt_token},
  ai_result:{responses,program_text_validation:{status:'held',reasons:['unsupported_program_field_evidence']}},prompt_payload:{comparison,packet_plan:plan,program_identity:{award_id:source.shared_award_id,award_name:source.title,source_url:source.url,source_title:source.title}}};
 const captures=new Map([[previous.capture_id,previous],[current.capture_id,current]]);
 return{source,epoch,previous,current,comparison,plan,responses,reservation,candidate,captures,loadCapture:async ref=>captures.get(ref.capture_id)};
}
