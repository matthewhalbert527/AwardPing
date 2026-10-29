import{createHash}from'node:crypto';import{describe,it,expect}from'vitest';
import{documentReferenceFixture}from'../fixtures/program-text-document-reference.mjs';
import{buildProgramTextReviewPackets,validateProgramTextReviewResult}from'./program-text-review.mjs';
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
const seal=c=>{const v={...c};delete v.comparison_id;return{...v,comparison_id:createHash('sha256').update(JSON.stringify(stable(v))).digest('hex')};};
function mutate(change){const f=documentReferenceFixture();const c=structuredClone(f.comparison);change(c.changed_blocks[0],c);const comparison=seal(c),plan=buildProgramTextReviewPackets(comparison),responses=structuredClone(f.responses);responses[0].comparison_id=comparison.comparison_id;responses[0].packet_id=plan.packets[0].packet_id;return{...f,comparison,plan,responses};}
const validate=f=>validateProgramTextReviewResult(f.comparison,f.plan,f.responses);
describe('source-framed candidate-guide document references',()=>{
 it('accepts the removed official guide reference and scopes derived copy to the page',()=>{const f=documentReferenceFixture(),before=structuredClone(f.responses),v=validate(f);expect(v.status).toBe('accepted');expect(v.details.summary).toBe('The page no longer lists “Information for Candidates - USA”.');expect(v.description_projections[0]).toMatchObject({original_summary:f.responses[0].blocks[0].changes[0].summary,policy:'awardping.document-reference-description.v1'});expect(f.responses).toEqual(before);});
 it('uses a reusable tightly framed title rule, not an award/country ID exception',()=>{const f=documentReferenceFixture({title:'Information for Applicants - Canada',base:'Information for Applicants'});expect(validate(f).status).toBe('accepted');});
 for(const[name,change]of[
  ['missing framing',r=>r.previous_context=[]],['different heading',r=>r.previous_context[0].heading='Unrelated'],
  ['different heading path',r=>r.previous_context[0].context.heading_path=[{text:'Unrelated',level:1}]],
  ['missing structural path',r=>{delete r.previous.context.heading_path;delete r.previous_context[0].context.heading_path;}],
  ['distant framing',r=>r.previous_context[0].end_utf16-=5],['following framing',r=>r.previous_context[0].end_utf16=r.previous.start_utf16+1],
  ['generic information framing',r=>r.previous_context[0].text='Information about candidates. Documents are available elsewhere.'],
  ['unrelated named document',r=>r.previous_context[0].text=r.previous_context[0].text.replace('Information for Candidates','Information for Applicants')],
  ['ordinary paragraph title',r=>r.previous.kind='p'],
 ])it('holds '+name,()=>expect(validate(mutate(change)).reasons).toContain('unsupported_program_field_evidence'));
 it('does not turn arbitrary Information or Candidates words into a document cue',()=>{for(const title of ['Information','Candidates','Information about Candidates']){const f=documentReferenceFixture({title});expect(validate(f).status).toBe('held');}});
 it('requires the quotation to cover the full qualified title',()=>{const f=documentReferenceFixture();f.responses[0].blocks[0].changes[0].previous_quote.text='Information for Candidates';expect(validate(f).status).toBe('held');});
 it('still rejects unsupported invented summary numbers before deriving page-scoped copy',()=>{const f=documentReferenceFixture();f.responses[0].blocks[0].changes[0].summary='A new 999 dollar charge.';expect(validate(f).reasons).toContain('unsupported_summary_number');});
 it('does not admit an unrelated programme field',()=>{const f=documentReferenceFixture();f.responses[0].blocks[0].changes[0].field='contacts';expect(validate(f).status).toBe('held');});
 it('preserves comparison integrity and owner identity checks',()=>{const f=documentReferenceFixture();f.comparison.context.award_id='wrong';expect(validate(f).reasons).toContain('invalid_comparison_integrity');const g=documentReferenceFixture();g.responses[0].award_id='wrong';expect(validate(g).reasons).toContain('response_identity_or_coverage_mismatch');});
 it('does not remove a reference still present in the current text',()=>{const f=mutate((r,c)=>c.current_text+='\nInformation for Candidates - USA');expect(validate(f).reasons).toContain('change_operation_not_supported');});
});
