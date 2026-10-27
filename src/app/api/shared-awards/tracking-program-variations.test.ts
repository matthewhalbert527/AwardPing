import {beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const mocks=vi.hoisted(()=>({user:vi.fn(),office:vi.fn(),manage:vi.fn(),config:vi.fn(),adminConfig:vi.fn(),publication:vi.fn(),admin:vi.fn(),server:vi.fn(),legacy:vi.fn(),excluded:vi.fn()}));
vi.mock('@/lib/auth',()=>({getCurrentUser:mocks.user}));
vi.mock('@/lib/config',()=>({hasSupabaseConfig:mocks.config,hasSupabaseAdminConfig:mocks.adminConfig}));
vi.mock('@/lib/offices',()=>({canManageOffice:mocks.manage,requireOfficeContext:mocks.office}));
vi.mock('@/lib/stage1-publication',()=>({getStage1PublicationEntryForAward:mocks.publication,isStage1SourceIdentityExcluded:mocks.excluded}));
vi.mock('@/lib/supabase/admin',()=>({createSupabaseAdminClient:mocks.admin}));
vi.mock('@/lib/supabase/server',()=>({createSupabaseServerClient:mocks.server}));
vi.mock('@/lib/shared-awards',()=>({trackSharedAwardForOffice:mocks.legacy,untrackSharedAwardForOffice:vi.fn(),untrackSharedAwardSourceForOffice:vi.fn()}));
import {POST as awardPost} from './[id]/track/route';
import {POST as sourcePost} from './[id]/sources/[sourceId]/track/route';
const id=(n:number)=>`90000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const adminRpc=vi.fn(),userRpc=vi.fn();let rows:Array<Record<string,unknown>>,publication:Record<string,unknown>,context:Record<string,unknown>;let eqCalls:Array<unknown[]>;
function request(origin='https://awardping.test'){return new Request('https://awardping.test/api/shared-awards/follow',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({cadence:'daily'})});}
function call(kind:'award'|'source',origin?:string){return kind==='award'?awardPost(request(origin),{params:Promise.resolve({id:id(1)})}):sourcePost(request(origin),{params:Promise.resolve({id:id(1),sourceId:id(100)})});}
beforeEach(()=>{
 vi.resetAllMocks();eqCalls=[];mocks.config.mockReturnValue(true);mocks.adminConfig.mockReturnValue(true);mocks.user.mockResolvedValue({id:id(9)});
 mocks.office.mockResolvedValue({current:{officeId:id(10),role:'owner'}});mocks.manage.mockReturnValue(true);mocks.excluded.mockReturnValue(false);
 rows=[{id:id(100),shared_award_id:id(1),url:'https://example.test/rules',title:'Mutable source title',page_type:'other',admin_review_status:'review_later',confidence:1,reason:'Old reason',updated_at:'2026-10-26T10:00:00.000Z'}];
 const bindings={[id(100)]:{url:rows[0].url,shared_award_id:id(1),title:'Pinned official application',page_type:'application'}};
 publication={effectivelyVerified:true,canonicalAwardId:id(1),memberAwardIds:[id(1)],allowedSourceIdSet:new Set([id(100)]),registry:{cohort_key:'example',release_epoch:id(2)},
  textFactReview:{id:id(3),current:true,variationInventoryId:id(4),variationInventoryRevision:id(5),releaseRevision:id(6)},approvedTextSourceBindings:bindings};
 context={schema:'awardping.program-variation-tracking.v1',cohort_key:'example',release_revision:id(6),inventory_id:id(4),inventory_revision:id(5),approval_id:id(3),approval_hash:'a'.repeat(64),epoch:id(7),shared_review_id:id(8),source_id:null,source_ids:[id(100)],source_bindings:bindings};
 mocks.publication.mockResolvedValue(publication);adminRpc.mockImplementation(async(_name:string,args:{p_source:string|null})=>({data:{...context,source_id:args.p_source},error:null}));
 userRpc.mockResolvedValue({data:{award:{id:id(11)},sources:[],monitors:[]},error:null});mocks.server.mockResolvedValue({rpc:userRpc});
 mocks.admin.mockReturnValue({rpc:adminRpc,from:vi.fn(()=>{let selected=rows;const chain={select:vi.fn(()=>chain),in:vi.fn((column:string,values:string[])=>{selected=selected.filter(row=>values.includes(row[column] as string));return chain;}),
  eq:vi.fn((column:string,value:unknown)=>{eqCalls.push([column,value]);selected=selected.filter(row=>row[column]===value);return chain;}),order:vi.fn(()=>chain),limit:vi.fn(async()=>({data:selected,error:null})),
  maybeSingle:vi.fn(async()=>({data:selected[0]??null,error:null})),then:(resolve:(x:unknown)=>unknown)=>Promise.resolve({data:selected,error:null}).then(resolve)};return chain;})});
 mocks.legacy.mockResolvedValue({award:{id:id(11)},sources:[],monitors:[]});
});
describe.each(['award','source'] as const)('approved variation %s follow route',kind=>{
 it('accepts only the signed-in office manager and passes exact pinned proof to authenticated SQL',async()=>{
  const response=await call(kind);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true,award:{id:id(11)}});
  expect(adminRpc).toHaveBeenCalledWith('get_program_variation_tracking_context',{p_cohort:'example',p_source:kind==='source'?id(100):null});
  expect(userRpc).toHaveBeenCalledExactlyOnceWith('track_office_program_variation_atomic',expect.objectContaining({p_office_id:id(10),p_expected_release_epoch:id(2),p_expected_member_shared_award_ids:[id(1)],p_expected_variation_context:expect.objectContaining({approval_hash:'a'.repeat(64)})}));
  expect(mocks.legacy).not.toHaveBeenCalled();expect(eqCalls).not.toContainEqual(['admin_review_status','open']);
 });
 it.each(['origin','signed_out','office_member','unverified_award','missing_epoch'])('preserves the %s authorization boundary',async boundary=>{
  if(boundary==='signed_out')mocks.user.mockResolvedValue(null);if(boundary==='office_member')mocks.manage.mockReturnValue(false);
  if(boundary==='unverified_award')publication.effectivelyVerified=false;if(boundary==='missing_epoch')(publication.registry as {release_epoch:string|null}).release_epoch=null;
  const response=await call(kind,boundary==='origin'?'https://attacker.test':undefined);
  expect(response.status).toBe(boundary==='signed_out'?401:boundary==='unverified_award'||boundary==='missing_epoch'?404:403);
  expect(userRpc).not.toHaveBeenCalled();expect(adminRpc).not.toHaveBeenCalled();
 });
 it.each(['unapproved','wrong_url','wrong_owner','closed','excluded'])('rejects %s source without mutation or fake status changes',async failure=>{
  if(failure==='unapproved')(publication.allowedSourceIdSet as Set<string>).clear();if(failure==='wrong_url')rows[0].url='https://example.test/other';
  if(failure==='wrong_owner')rows[0].shared_award_id=id(90);if(failure==='closed')rows[0].admin_review_status='closed';if(failure==='excluded')mocks.excluded.mockReturnValue(true);
  expect((await call(kind)).status).toBe(409);expect(userRpc).not.toHaveBeenCalled();expect(rows[0].admin_review_status).toBe(failure==='closed'?'closed':'review_later');
 });
 it('retains legacy OPEN filtering and legacy authenticated mutation when no v2 release exists',async()=>{
  delete publication.textFactReview;rows[0].admin_review_status='open';const response=await call(kind);expect(response.status).toBe(200);
  expect(eqCalls).toContainEqual(['admin_review_status','open']);expect(mocks.legacy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({officeId:id(10),canonicalSharedAwardId:id(1)}));expect(userRpc).not.toHaveBeenCalled();expect(adminRpc).not.toHaveBeenCalled();
 });
 it('keeps review_later unavailable through the legacy path',async()=>{
  delete publication.textFactReview;expect((await call(kind)).status).toBe(kind==='award'?400:404);expect(mocks.legacy).not.toHaveBeenCalled();
 });
 it('preserves authenticated database office denial and conceals private diagnostics',async()=>{
  userRpc.mockResolvedValue({data:null,error:{code:'42501',message:'Private SQL office membership detail'}});const response=await call(kind);
  expect(response.status).toBe(403);expect(JSON.stringify(await response.json())).not.toContain('Private SQL');
 });
});
