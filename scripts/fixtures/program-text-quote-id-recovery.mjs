import {buildProgramTextCapture} from '../lib/program-text-capture-contract.mjs';
import {programTextReference} from '../lib/program-text-artifacts.mjs';
import {buildProgramTextComparison,buildProgramTextReviewPackets} from '../lib/program-text-review.mjs';
import {PROGRAM_TEXT_QUOTE_ID_RECOVERY_CANDIDATE as id,PROGRAM_TEXT_QUOTE_ID_RECOVERY_SOURCE as sourceId,PROGRAM_TEXT_QUOTE_ID_RECOVERY_AWARD as awardId} from '../lib/program-text-quote-id-recovery.mjs';
export function quoteIdRecoveryFixture(){
 const epoch='ec349339-ff62-4d2e-a610-8c361b4044ec',source={id:sourceId,shared_award_id:awardId,url:'https://www.nsfgrfp.org/',title:'NSF Graduate Research Fellowship Program',page_type:'homepage'};
 const before='2027 NSF GRFP. October 23, 2026 by 8:00 p.m. Eastern time Chemistry; Geosciences; Mathematical Sciences; Physics and Astronomy';
 const after=before+' applications are closed';
 const capture=(text,captured_at)=>buildProgramTextCapture({source,final_url:source.url,captured_at,acquisition:'http_html',extractor:{name:'fixture',version:'1'},raw_bytes:Buffer.from('<main>'+text+'</main>'),content_type:'text/html',text,blocks:[{id:'block-000012',text,start_utf16:0,end_utf16:text.length}]});
 const previous=capture(before,'2026-10-25T23:00:00.000Z'),current=capture(after,'2026-10-26T23:00:00.000Z');
 const comparison=buildProgramTextComparison(previous,current,{epoch,cycle_id:null}),plan=buildProgramTextReviewPackets(comparison),changed=comparison.changed_blocks[0];
 const response={schema:'awardping.program-text-review.v1',epoch,award_id:awardId,source_id:sourceId,cycle_id:null,packet_id:plan.packets[0].packet_id,comparison_id:comparison.comparison_id,
  blocks:[{id:changed.id,disposition:'program_change',reason:'Applications for the four listed fields have closed.',changes:[{field:'cycle_status',operation:'replace',applicant_impact:true,
   summary:'Applications for Chemistry; Geosciences; Mathematical Sciences; Physics and Astronomy are now closed.',previous_quote:{block_id:changed.id,text:before},current_quote:{block_id:changed.id,text:after}}]}]};
 const row={id,shared_award_source_id:sourceId,shared_award_id:awardId,source_url:source.url,candidate_signature:comparison.comparison_id,candidate_scope:'program_text_change',status:'failed',
  rejection_reason:'manual_review_required:quote_not_bound_to_changed_block',previous_snapshot_ref:programTextReference(previous),new_snapshot_ref:programTextReference(current),
  worker_metadata:{epoch,monitoring_contract:'program-text-v1',evidence_signature:comparison.comparison_id,bucket:'private-fixture',provider_request_keys:['preserved-existing-request'],gemini_spend_reservation_id:'preserved-existing-reservation'},
  ai_result:{responses:[response],program_text_validation:{status:'held',reasons:['quote_not_bound_to_changed_block']}},
  prompt_payload:{comparison,packet_plan:plan,program_identity:{award_id:awardId,award_name:source.title,source_url:source.url,source_title:source.title}},model:'preserved-paid-model',actual_usage:{tokens:17}};
 const captures=new Map([[previous.capture_id,previous],[current.capture_id,current]]);return{row,source,epoch,previous,current,captures,loadCapture:async ref=>captures.get(ref.capture_id)};
}
