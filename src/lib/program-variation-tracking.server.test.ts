import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {Database} from './database.types';
import type {Stage1PublicationEntry} from './stage1-publication';
import {loadProgramVariationTrackingSources,trackProgramVariationForOffice} from './program-variation-tracking.server';
vi.mock('server-only',()=>({}));
vi.mock('@/lib/stage1-publication',()=>({isStage1SourceIdentityExcluded:()=>false}));
const id=(n:number)=>`90000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const rpc=vi.fn();const queries:string[][]=[];
let publication:Stage1PublicationEntry;let context:Record<string,unknown>;let sources:Database['public']['Tables']['shared_award_sources']['Row'][];
const admin={rpc,from:vi.fn(()=>{let ids:string[]=[];const chain={select:vi.fn(()=>chain),in:vi.fn((_column:string,values:string[])=>{ids=values;queries.push(values);return chain;}),order:vi.fn(()=>chain),limit:vi.fn(async()=>({data:sources.filter(source=>ids.includes(source.id)),error:null}))};return chain;})} as unknown as SupabaseClient<Database>;
function prepare(count=1){
 sources=Array.from({length:count},(_,n)=>({id:id(n+100),shared_award_id:id(1),url:`https://example.test/provider/${n}`,title:'Mutable source title',page_type:'other',admin_review_status:'review_later',confidence:0.7,reason:'Mutable explanation',updated_at:'2026-10-26T10:00:00.000Z'})) as typeof sources;
 const bindings=Object.fromEntries(sources.map(source=>[source.id,{url:source.url,shared_award_id:source.shared_award_id,title:'Pinned approved program page',page_type:'application'}]));
 publication={effectivelyVerified:true,canonicalAwardId:id(1),memberAwardIds:[id(1)],allowedSourceIdSet:new Set(sources.map(source=>source.id)),registry:{cohort_key:'example',release_epoch:id(2)},
  textFactReview:{id:id(3),current:true,variationInventoryId:id(4),variationInventoryRevision:id(5),releaseRevision:id(6)},approvedTextSourceBindings:bindings} as unknown as Stage1PublicationEntry;
 context={schema:'awardping.program-variation-tracking.v1',cohort_key:'example',release_revision:id(6),inventory_id:id(4),inventory_revision:id(5),approval_id:id(3),approval_hash:'a'.repeat(64),epoch:id(7),shared_review_id:id(8),source_id:null,source_ids:sources.map(source=>source.id),source_bindings:bindings};
 rpc.mockResolvedValue({data:context,error:null});
}
beforeEach(()=>{vi.clearAllMocks();queries.length=0;prepare();});
describe('approved variation source tracking boundary',()=>{
 it('accepts independently authorized review_later without fake legacy approval and sends exact current bindings',async()=>{
  const value=await loadProgramVariationTrackingSources(admin,publication);expect(value.sources[0].admin_review_status).toBe('review_later');
  rpc.mockResolvedValue({data:{award:{id:id(9)},sources:[],monitors:[]},error:null});
  await trackProgramVariationForOffice({supabase:admin,publication,...value,officeId:id(10),cadence:'daily'});
  expect(rpc).toHaveBeenLastCalledWith('track_office_program_variation_atomic',expect.objectContaining({p_expected_variation_context:context,p_office_id:id(10),
   p_expected_source_bindings:[expect.objectContaining({id:id(100),url:sources[0].url,title:'Mutable source title',admin_review_status:'review_later'})]}));
  expect(sources[0].title).toBe('Mutable source title');
 });
 it('queries only bounded common IDs in chunks while preserving source identities',async()=>{
  prepare(250);const result=await loadProgramVariationTrackingSources(admin,publication);expect(queries.map(x=>x.length)).toEqual([100,100,50]);expect(result.sources).toHaveLength(250);
 });
 it('keeps explicit source follow limited to exactly the requested approved source',async()=>{
  context.source_id=id(100);const result=await loadProgramVariationTrackingSources(admin,publication,id(100));expect(result.sources).toHaveLength(1);
  expect(rpc).toHaveBeenCalledWith('get_program_variation_tracking_context',{p_cohort:'example',p_source:id(100)});
 });
 it.each(['release_revision','inventory_id','inventory_revision','approval_id','approval_hash'])('rejects stale or malformed %s before source lookup',async field=>{
  context[field]='wrong';await expect(loadProgramVariationTrackingSources(admin,publication)).rejects.toMatchObject({code:'40001'});expect(queries).toHaveLength(0);
 });
 it.each(['url','shared_award_id','closed','missing_authority','unapproved_source','missing_row','unverified_award'])('rejects %s without sending an authenticated mutation',async kind=>{
  if(kind==='url')sources[0].url+='/changed';if(kind==='shared_award_id')sources[0].shared_award_id=id(90);
  if(kind==='closed')(sources[0] as unknown as {admin_review_status:string}).admin_review_status='closed';
  if(kind==='missing_authority')rpc.mockResolvedValue({data:null,error:{code:'40001',message:'No text approval'}});
  if(kind==='unapproved_source')publication.allowedSourceIdSet.clear();if(kind==='missing_row')sources=[];if(kind==='unverified_award')publication.effectivelyVerified=false;
  await expect(loadProgramVariationTrackingSources(admin,publication)).rejects.toMatchObject({code:'40001'});
  expect(rpc.mock.calls.every(call=>call[0]==='get_program_variation_tracking_context')).toBe(true);
 });
 it('requires current approved facts, not just a sealed inventory or old publication receipt',async()=>{
  publication.textFactReview!.current=false;await expect(loadProgramVariationTrackingSources(admin,publication)).rejects.toMatchObject({code:'40001'});expect(rpc).not.toHaveBeenCalled();
 });
 it('preserves denial codes from authenticated SQL authorization and never leaks its diagnostics',async()=>{
  const value=await loadProgramVariationTrackingSources(admin,publication);rpc.mockResolvedValue({data:null,error:{code:'42501',message:'private office details'}});
  await expect(trackProgramVariationForOffice({supabase:admin,publication,...value,officeId:id(10),cadence:'daily'})).rejects.toMatchObject({code:'42501',message:'Shared award could not be tracked. Refresh and try again.'});
 });
});
