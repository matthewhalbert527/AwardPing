import {describe,it,expect,vi} from 'vitest';
import {prepareProgramTextQuoteIdRecovery} from './program-text-quote-id-recovery.mjs';
import {quoteIdRecoveryFixture} from '../fixtures/program-text-quote-id-recovery.mjs';
import {review} from '../program-text-worker.mjs';
describe('finite explicit saved quotation-ID correction',()=>{
 it('changes exactly the two block IDs while preserving original response/candidate/model/usage',async()=>{
  const f=quoteIdRecoveryFixture(),before=structuredClone(f.row);const value=await prepareProgramTextQuoteIdRecovery(f.row,f);
  expect(value.validation.status).toBe('accepted');expect(f.row).toEqual(before);expect(value.changes).toHaveLength(2);
  const restored=structuredClone(value.projected_responses);for(const side of ['previous','current'])restored[0].blocks[0].changes[0][side+'_quote'].block_id='change-00001';
  expect(restored).toEqual(f.row.ai_result.responses);expect(value.changed_text).toEqual({previous:f.previous.text,current:f.current.text});
  expect(value.warning).toContain('may publish');expect(value.warning).toContain('does not approve current award facts');
 });
 it.each(['id','shared_award_source_id','shared_award_id','candidate_scope','status','rejection_reason'])('rejects unsupported %s without loading source objects',async field=>{
  const f=quoteIdRecoveryFixture();f.row[field]='unsupported';const loadCapture=vi.fn();await expect(prepareProgramTextQuoteIdRecovery(f.row,{loadCapture})).rejects.toThrow();expect(loadCapture).not.toHaveBeenCalled();
 });
 it.each(['quote_text','already_fixed','response_extra','summary_number','field','missing_side','wrong_row','missing_metadata'])('rejects %s rather than broadening recovery',async kind=>{
  const f=quoteIdRecoveryFixture(),change=f.row.ai_result.responses[0].blocks[0].changes[0];
  if(kind==='quote_text')change.current_quote.text='invented quote';if(kind==='already_fixed')change.current_quote.block_id='block-000012';
  if(kind==='response_extra')f.row.ai_result.responses.push(structuredClone(f.row.ai_result.responses[0]));if(kind==='summary_number')change.summary='Applications close in2099.';
  if(kind==='field')change.field='tuition';if(kind==='missing_side')change.previous_quote=null;if(kind==='wrong_row')f.row.ai_result.responses[0].blocks[0].id='other-row';
  if(kind==='missing_metadata')f.current.raw_source.sha256='0'.repeat(64);
  await expect(prepareProgramTextQuoteIdRecovery(f.row,f)).rejects.toThrow();
 });
 it('holds on changed complete comparison or packet plan, even when quotes look plausible',async()=>{
  for(const part of ['comparison','packet_plan']){const f=quoteIdRecoveryFixture();f.row.prompt_payload[part].comparison_id='0'.repeat(64);await expect(prepareProgramTextQuoteIdRecovery(f.row,f)).rejects.toThrow();}
 });
 it('uses existing succeeded-result finalization without submit, poll, spend or source recapture',async()=>{
  const f=quoteIdRecoveryFixture(),prepared=await prepareProgramTextQuoteIdRecovery(f.row,f),recovered={...f.row,status:'succeeded',ai_result:{...f.row.ai_result,responses:prepared.projected_responses}};
  const state={schema:'awardping.program-text-state.v1',epoch:f.epoch,baseline_ref:recovered.previous_snapshot_ref,latest_ref:recovered.new_snapshot_ref,status:'awaiting_review',
   successful_checks:2,first_captured_at:f.previous.captured_at,last_checked_at:f.current.captured_at};
  const loadCapture=vi.fn(f.loadCapture),record=vi.fn(async()=>({persisted:true})),publish=vi.fn(async()=>({published:true,event_id:'10000000-0000-4000-8000-000000000001'})),reserve=vi.fn(()=>{throw Error('No new spending allowed');}),fetcher=vi.fn(()=>{throw Error('No provider/network allowed');});
  const repository={listCandidates:vi.fn(async()=>[recovered]),verifyCandidate:vi.fn(async()=>true),recordReviewResult:record,claim:vi.fn(()=>{throw Error('No new claim');}),save:vi.fn(()=>{throw Error('No new provider state');})};
  const callbacks={readState:async()=>state,loadCapture,recordReviewResult:record,compareAndSetState:vi.fn(()=>{throw Error('Not a no-change baseline');}),publishProgramChange:publish};
  const result=await review(repository,{fetcher,ledger:{reserve}},callbacks,1,{source_ids:[f.source.id],epoch:f.epoch});
  expect(result[0].status).toBe('published');expect(record).toHaveBeenCalledTimes(1);expect(publish).toHaveBeenCalledTimes(1);
  expect(repository.claim).not.toHaveBeenCalled();expect(repository.save).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();
 });
});
