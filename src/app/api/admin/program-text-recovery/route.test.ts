import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({getCurrentUser:vi.fn(),isSiteAdminEmail:vi.fn(),loadProgramTextQuoteIdRecovery:vi.fn(),approveProgramTextQuoteIdRecovery:vi.fn()}));
vi.mock('@/lib/auth',()=>mocks);vi.mock('@/lib/program-text-quote-id-recovery.server',()=>mocks);
import {GET,POST} from './route';
const candidate='8d40add5-89ea-4f96-9c31-f1f68c1fa472',actor='10000000-0000-4000-8000-000000000001';
const input={candidate_id:candidate,preimage_hash:'a'.repeat(64),projection_hash:'b'.repeat(64),reason:'Both source-bound quotations retain their exact original wording.'};
const req=(value:unknown=input,origin:string|null='https://awardping.com')=>new Request('https://awardping.com/api/admin/program-text-recovery',{
 method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(value)});
const get=(query=`?candidate=${candidate}`)=>new Request(`https://awardping.com/api/admin/program-text-recovery${query}`);
beforeEach(()=>{vi.resetAllMocks();mocks.getCurrentUser.mockResolvedValue({id:actor,email:'admin@example.test'});mocks.isSiteAdminEmail.mockReturnValue(true);
 mocks.loadProgramTextQuoteIdRecovery.mockResolvedValue({candidate_id:candidate,already_applied:false});
 mocks.approveProgramTextQuoteIdRecovery.mockResolvedValue({candidate_id:candidate,already_applied:false,status:'succeeded'});});
describe('finite saved quotation-ID administrator recovery endpoint',()=>{
 it.each([GET,POST])('requires authentication before private service calls',async method=>{
  mocks.getCurrentUser.mockResolvedValue(null);expect((await method(req())).status).toBe(401);
  expect(mocks.loadProgramTextQuoteIdRecovery).not.toHaveBeenCalled();expect(mocks.approveProgramTextQuoteIdRecovery).not.toHaveBeenCalled();
 });
 it.each([GET,POST])('requires a site administrator',async method=>{mocks.isSiteAdminEmail.mockReturnValue(false);expect((await method(req())).status).toBe(403);});
 it.each([null,'https://attacker.example'])('rejects cross-origin or missing-origin writes before authentication (%s)',async origin=>{
  expect((await POST(req(input,origin))).status).toBe(403);expect(mocks.getCurrentUser).not.toHaveBeenCalled();expect(mocks.approveProgramTextQuoteIdRecovery).not.toHaveBeenCalled();
 });
 it.each(['','?candidate=other',`?candidate=${candidate}&candidate=${candidate}`,`?candidate=${candidate}&projection=override`])('rejects unsupported or ambiguous queries %s',async query=>{
  expect((await GET(get(query))).status).toBe(404);expect(mocks.loadProgramTextQuoteIdRecovery).not.toHaveBeenCalled();
 });
 it('loads only the finite preview, with private no-store and nosniff headers',async()=>{
  const response=await GET(get());expect(response.status).toBe(200);expect(mocks.loadProgramTextQuoteIdRecovery).toHaveBeenCalledExactlyOnceWith(candidate);
  expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('x-content-type-options')).toBe('nosniff');
 });
 it('derives the actor server-side and passes only the four approved request properties',async()=>{
  const response=await POST(req());expect(response.status).toBe(200);expect(mocks.approveProgramTextQuoteIdRecovery).toHaveBeenCalledExactlyOnceWith(input,actor);
  expect(await response.json()).toMatchObject({ok:true,result:{status:'succeeded',candidate_id:candidate}});
 });
 it.each([{...input,actor:'forged'},{...input,projected_responses:[]},{...input,candidate_id:'other'},{...input,preimage_hash:'x'.repeat(64)},
  {...input,projection_hash:null},{...input,reason:'yes'},{...input,reason:' '.repeat(25)},{...input,reason:'x'.repeat(2001)},null,[]])('rejects expanded or invalid review bodies %j',async value=>{
  expect((await POST(req(value))).status).toBe(400);expect(mocks.approveProgramTextQuoteIdRecovery).not.toHaveBeenCalled();
 });
 it('bounds streamed JSON and declared length before entering the service',async()=>{
  expect((await POST(req({...input,reason:'x'.repeat(17000)}))).status).toBe(413);
  const request=req();request.headers.set('content-length','17000');expect((await POST(request)).status).toBe(413);
  expect(mocks.approveProgramTextQuoteIdRecovery).not.toHaveBeenCalled();
 });
 it('rejects non-JSON input',async()=>{const request=req();request.headers.set('content-type','text/plain');expect((await POST(request)).status).toBe(400);});
 it.each([GET,POST])('does not expose provider, claim or private diagnostic errors',async method=>{
  mocks.loadProgramTextQuoteIdRecovery.mockRejectedValue(Error('private provider job token'));
  mocks.approveProgramTextQuoteIdRecovery.mockRejectedValue(Error('private provider job token'));
  const response=await method(method===GET?get():req());expect(response.status).toBe(409);expect(await response.text()).not.toMatch(/provider|token|job/);
  expect(response.headers.get('cache-control')).toContain('no-store');
 });
 it('allows a historical receipt to be displayed without offering a new projection',async()=>{
  const historical={already_applied:true,receipt:{journal_id:actor,candidate_id:candidate,status:'historical_receipt'}};
  mocks.loadProgramTextQuoteIdRecovery.mockResolvedValue(historical);expect(await(await GET(get())).json()).toEqual(historical);
  expect(mocks.approveProgramTextQuoteIdRecovery).not.toHaveBeenCalled();
 });
});
