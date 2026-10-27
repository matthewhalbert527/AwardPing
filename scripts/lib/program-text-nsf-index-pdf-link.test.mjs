import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProgramTextCapture} from './program-text-capture-contract.mjs';
import {programTextReference} from './program-text-artifacts.mjs';
import {buildProgramTextRawAnchorProviderLink} from './program-text-source-raw-anchor.mjs';
const owner='d955a846-cee1-4c01-932e-e3cb7215f3fb';
const index='https://www.nsf.gov/policies/document/graduate-research-fellowship-program-grfp-administrative';
const pdf='https://nsf-gov-resources.nsf.gov/files/nsf25033.pdf';
function fixture({href=pdf,html,source={}}={}){
 html??='<html><head><title>NSF current policy</title></head><body><main><p>Current agency information: NSF 25-033. 🧭</p><a href="'+href+'">Download the publication (PDF, 1.02 MB)</a></main></body></html>';
 const text='Graduate Research Fellowship Program Administrative Guide. Current agency information. Publication number NSF 25-033.';
 const capture=buildProgramTextCapture({source:{id:'89681230-d6b4-46ba-8649-a8c19633c7aa',shared_award_id:owner,url:index,title:'GRFP Administrative Guide',page_type:'other',...source},
 acquisition:'http_html',raw_bytes:Buffer.from(html),content_type:'text/html; charset=UTF-8',text,
 blocks:[{id:'policy',text,start_utf16:0,end_utf16:text.length}],extractor:{name:'fixture',version:'1'},captured_at:'2026-10-27T16:00:00.000Z'});
 const proposal={cohort_key:'nsf_grfp',expected_canonical_shared_award_id:owner,source:{url:pdf,shared_award_id:owner,expected_member_kind:'canonical',page_type:'pdf'},
 authority_ref:programTextReference(capture),link_proof:{kind:'retained_raw_html_anchor.v1',anchor_start_utf16:html.indexOf('<a '),target_page_url:pdf}};
 return{capture,proposal};
}
test('the exact index identity can prove its exact official PDF body link without fabricated text blocks',()=>{
 const f=fixture(),link=buildProgramTextRawAnchorProviderLink(f.proposal,f.capture);
 assert.equal(link.resolved_url,pdf);assert.equal(link.anchor.literal_href,pdf);
 assert.equal(link.source_id,'89681230-d6b4-46ba-8649-a8c19633c7aa');
 assert.ok(link.anchor.start_byte>link.anchor.start_utf16);assert.equal(link.anchor.label,'Download the publication (PDF, 1.02 MB)');
 assert.equal(f.capture.blocks.some(b=>b.kind==='source_link'),false);
 assert.deepEqual(Buffer.from(link.raw_base64,'base64'),f.capture.raw_source.bytes);
});
test('PDF permission cannot be borrowed by another authority, owner or page type',()=>{
 for(const source of [{id:'c49e85e3-3b19-4052-891f-c2bc67e8b8f6'},{url:index+'/'},{shared_award_id:'10000000-0000-4000-8000-000000000001'},{page_type:'homepage'}]){
  const f=fixture({source});assert.throws(()=>buildProgramTextRawAnchorProviderLink(f.proposal,f.capture));
 }
 for(const mutate of [p=>p.source.page_type='other',p=>p.source.expected_member_kind='alias',p=>p.cohort_key='other',p=>p.source.shared_award_id='10000000-0000-4000-8000-000000000001']){
  const f=fixture();mutate(f.proposal);assert.throws(()=>buildProgramTextRawAnchorProviderLink(f.proposal,f.capture));
 }
});
test('one known PDF grants no different year, document, host, alias, query or fragment',()=>{
 for(const href of [pdf.replace('25033','24090'),pdf.replace('nsf.gov','nsf.gov.evil.test'),pdf+'?download=1',pdf+'#page=2',pdf.replace('https:','http:'),'/files/nsf25033.pdf','https://www.nsf.gov/files/nsf25033.pdf',pdf.replace('/files/','/files/../files/')]){
  const f=fixture({href});assert.throws(()=>buildProgramTextRawAnchorProviderLink(f.proposal,f.capture));
  f.proposal.source.url=href;f.proposal.link_proof.target_page_url=href;
  assert.throws(()=>buildProgramTextRawAnchorProviderLink(f.proposal,f.capture));
 }
});
test('PDF raw link retains actual DOM, byte, encoding and locator checks',()=>{
 const anchor='<a href="'+pdf+'">Download</a>';
 for(const html of ['<html><head><base href="/"></head><body>'+anchor+'</body></html>',
  '<html><head></head><body><template>'+anchor+'</template></body></html>',
  '<html><head></head><body><script>const a='+JSON.stringify(anchor)+'</script></body></html>',
  '<html><head></head><body><nav>'+anchor+'</nav></body></html>',
  '<html><head></head><body>'+anchor.replace('href=','href="/other" href=')+'</body></html>',
  '<html><head></head><body>'+anchor.replace('nsf25033','nsf250&#51;3')+'</body></html>']){
  const f=fixture({html});assert.throws(()=>buildProgramTextRawAnchorProviderLink(f.proposal,f.capture));
 }
 for(const mutate of [f=>f.proposal.link_proof.anchor_start_utf16++,f=>f.capture.raw_source.bytes[2]^=1,f=>f.capture.text+='unverified',f=>f.proposal.authority_ref.capture_id='f'.repeat(64)]){
  const f=fixture();mutate(f);assert.throws(()=>buildProgramTextRawAnchorProviderLink(f.proposal,f.capture));
 }
});
