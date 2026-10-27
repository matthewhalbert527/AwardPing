import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),loadProgramTextCapture:vi.fn(),verifyCandidate:vi.fn()}));
vi.mock('server-only',()=>({}));vi.mock('@/lib/supabase/admin',()=>({createSupabaseAdminClient:()=>({rpc:mocks.rpc})}));
vi.mock('@/lib/r2',()=>({createR2Client:()=>({}),getR2Bucket:()=>'private-test-evidence'}));
vi.mock('../../scripts/lib/program-text-artifacts.mjs',async importOriginal=>({...await importOriginal<typeof import('../../scripts/lib/program-text-artifacts.mjs')>(),loadProgramTextCapture:mocks.loadProgramTextCapture}));
vi.mock('../../scripts/lib/program-text-repository.mjs',()=>({createProgramTextRepository:(_db:unknown,options:{loadCapture:(ref:unknown)=>Promise<unknown>})=>({
 verifyCandidate:async(row:{previous_snapshot_ref:unknown;new_snapshot_ref:unknown})=>{await mocks.verifyCandidate(row);await options.loadCapture(row.previous_snapshot_ref);await options.loadCapture(row.new_snapshot_ref);},
})}));
import {quoteIdRecoveryFixture} from '../../scripts/fixtures/program-text-quote-id-recovery.mjs';
import {prepareProgramTextQuoteIdRecovery} from '../../scripts/lib/program-text-quote-id-recovery.mjs';
import {loadProgramTextQuoteIdRecovery,approveProgramTextQuoteIdRecovery} from './program-text-quote-id-recovery.server';
const candidate='8d40add5-89ea-4f96-9c31-f1f68c1fa472',actor='10000000-0000-4000-8000-000000000001';
const input={candidate_id:candidate,preimage_hash:'a'.repeat(64),projection_hash:'b'.repeat(64),reason:'Both source-bound quotations retain their exact original wording.'};
let inspected:Record<string,unknown>;
beforeEach(async()=>{vi.resetAllMocks();const fixture=quoteIdRecoveryFixture();const prepared=await prepareProgramTextQuoteIdRecovery(fixture.row,{loadCapture:fixture.loadCapture});
 inspected={already_applied:false,candidate:fixture.row,source_identity_proof:{epoch:fixture.epoch},preimage_hash:input.preimage_hash,projection_hash:input.projection_hash,
  projected_responses:prepared.projected_responses,changes:prepared.changes};
 mocks.loadProgramTextCapture.mockImplementation(fixture.loadCapture);mocks.verifyCandidate.mockResolvedValue(undefined);
 mocks.rpc.mockImplementation(async(name:string)=>({data:name==='inspect_program_text_quote_id_recovery'?inspected:{candidate_id:candidate,already_applied:false,status:'succeeded'},error:null}));
});
describe('cold verified quotation-ID recovery server preparation',()=>{
 it('shares two cold original loads with the unchanged repository verification and returns only reviewable text',async()=>{
  const value=await loadProgramTextQuoteIdRecovery(candidate);expect(value).toMatchObject({already_applied:false,candidate_id:candidate,validation:{status:'accepted'}});
  expect(mocks.verifyCandidate).toHaveBeenCalledExactlyOnceWith(inspected.candidate);expect(mocks.loadProgramTextCapture).toHaveBeenCalledTimes(2);
  expect(value).toHaveProperty('changed_text.previous');expect(value).toHaveProperty('source.url');expect(value).not.toHaveProperty('candidate');
  expect(JSON.stringify(value)).not.toContain('batch_job_name');expect(value).toHaveProperty('warning',expect.stringContaining('may publish'));
 });
 it('rebuilds and cold-verifies again before the only service-authorized transition',async()=>{
  await approveProgramTextQuoteIdRecovery(input,actor);expect(mocks.loadProgramTextCapture).toHaveBeenCalledTimes(2);
  expect(mocks.rpc).toHaveBeenLastCalledWith('approve_program_text_quote_id_recovery',{p_candidate:candidate,p_preimage_hash:input.preimage_hash,
   p_projection_hash:input.projection_hash,p_reason:input.reason,p_actor:actor});
 });
 it('does not accept a stale preview hash',async()=>{
  await expect(approveProgramTextQuoteIdRecovery({...input,preimage_hash:'c'.repeat(64)},actor)).rejects.toThrow('preview changed');
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
 });
 it.each(['projected_responses','changes'])('rejects SQL and independently cold-derived %s disagreements',async key=>{
  inspected[key]=[];await expect(loadProgramTextQuoteIdRecovery(candidate)).rejects.toThrow('disagree');expect(mocks.rpc).toHaveBeenCalledTimes(1);
 });
 it('rejects epoch drift before loading evidence',async()=>{
  inspected.source_identity_proof={epoch:actor};await expect(loadProgramTextQuoteIdRecovery(candidate)).rejects.toThrow('changed');expect(mocks.loadProgramTextCapture).not.toHaveBeenCalled();
 });
 it('does not bypass the unchanged repository source/pair/current-authority verification',async()=>{
  mocks.verifyCandidate.mockRejectedValue(Error('stale source authority'));await expect(approveProgramTextQuoteIdRecovery(input,actor)).rejects.toThrow('stale source');
  expect(mocks.rpc).toHaveBeenCalledTimes(1);expect(mocks.loadProgramTextCapture).not.toHaveBeenCalled();
 });
 it('fails closed on a missing original and never submits or calls recovery',async()=>{
  mocks.loadProgramTextCapture.mockRejectedValue(Error('unavailable'));await expect(approveProgramTextQuoteIdRecovery(input,actor)).rejects.toThrow('unavailable');
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
 });
 it('rejects other candidates before using service credentials',async()=>{
  await expect(loadProgramTextQuoteIdRecovery(actor)).rejects.toThrow('Unsupported');expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it('returns historical receipts without cold loading or constructing a fresh projection',async()=>{
  inspected={already_applied:true,receipt:{candidate_id:candidate,journal_id:actor,status:'historical_receipt'}};
  // A completed recovery remains a candidate-bound historical receipt even
  // after live sources have advanced; it must not rebuild or restart work.
  mocks.verifyCandidate.mockRejectedValue(Error('live source changed after completed recovery'));
  expect(await loadProgramTextQuoteIdRecovery(candidate)).toEqual({candidate_id:candidate,...inspected});expect(mocks.loadProgramTextCapture).not.toHaveBeenCalled();expect(mocks.verifyCandidate).not.toHaveBeenCalled();
  await approveProgramTextQuoteIdRecovery(input,actor);expect(mocks.rpc).toHaveBeenLastCalledWith('approve_program_text_quote_id_recovery',expect.objectContaining({p_reason:input.reason}));
 });
 it('does not report an unconfirmed SQL result as recovered',async()=>{
  mocks.rpc.mockImplementation(async(name:string)=>name.startsWith('inspect')?{data:inspected,error:null}:{data:null,error:{code:'40001'}});
  await expect(approveProgramTextQuoteIdRecovery(input,actor)).rejects.toThrow('No recovery transition');
 });
});
