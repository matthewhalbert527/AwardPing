// Finite SMART programme-body source_link proof. No acquisition or authority grant.
import { load } from 'cheerio';
import { SMART_GUIDE_KB_SOURCE_PROFILES, SMART_GUIDE_AUTHORITY_PROFILES } from './program-text-smart-guide-profiles.mjs';
import { validateProgramTextCapture } from './program-text-capture-contract.mjs';
import { programTextReference } from './program-text-artifacts.mjs';
const OWNER = 'd7d4d117-f312-456f-a75c-3dbd5d372c99', BASE = 'https://www.smartscholarship.org/smart';
const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])) : x;
const identity = (a,b) => ['id','shared_award_id','url','title','page_type'].every(k=>a?.[k]===b?.[k]);
const fail = code => { throw new Error('Text source SMART body link: '+code); };
export function programTextSmartBodyTarget(proposal) {
  if (proposal?.cohort_key !== 'smart' || proposal.expected_canonical_shared_award_id !== OWNER ||
      proposal.source?.expected_member_kind !== 'canonical') return null;
  return SMART_GUIDE_KB_SOURCE_PROFILES.find(p=>identity(proposal.source,p)) ?? null;
}
export function buildProgramTextSmartBodyProviderLink(proposal,capture) {
  const target=programTextSmartBodyTarget(proposal),authority=SMART_GUIDE_AUTHORITY_PROFILES.find(p=>identity(capture?.source,p));
  if (!target || !authority || capture.acquisition !== 'publisher_json' || capture.final_url !== authority.url ||
      capture.extractor?.name !== 'smart-publisher-json' || capture.extractor.version !== authority.version) fail('finite_identity');
  validateProgramTextCapture(capture);
  if (!same(programTextReference(capture),proposal.authority_ref) || capture.completeness.status !== 'complete' || capture.completeness.reasons.length) fail('full_current_original');
  const block=capture.blocks.find(b=>b.id===proposal.link_block_id),c=block?.context;
  const witness=target.authority_witnesses.find(w=>w.source_id===authority.id && w.pointer===c?.pointer && w.literal_href===block?.text);
  if (!witness || block.kind!=='source_link' || capture.text.slice(block.start_utf16,block.end_utf16)!==block.text ||
      c.schema!=='awardping.smart-publisher-json-projection.v1' || c.representation!=='publisher_attribute' || c.verbatim!==false ||
      c.source_attribute!=='href' || c.source_representation!=='publisher_json' || !same(c.base_hrefs,['/smart']) ||
      c.base_url!==BASE || c.navigation_source_url!==authority.url || c.resolved_url!==target.url || !Array.isArray(c.sources)) fail('programme_attribute');
  // Existing eligibility projection has sources:[] for this reviewed literal
  // programme-template anchor. Do not manufacture source spans or a new block.
  const document=JSON.parse(capture.raw_source.bytes.toString('utf8'));
  const html=witness.pointer.split('/').slice(1).reduce((v,k)=>v?.[k.replaceAll('~1','/').replaceAll('~0','~')],document);
  if (typeof html!=='string') fail('programme_pointer');
  const $=load(html,{sourceCodeLocationInfo:true},false);
  const literal=$('a[href]').toArray().filter(el=>el.attribs.href===witness.literal_href &&
    !$(el).parents('script,style,template,noscript,iframe,object,embed,svg,math,header,nav,footer').length);
  if (!literal.length) fail('literal_programme_anchor');
  const url=new URL(block.text,BASE);
  if (url.href!==target.url || url.protocol!=='https:' || url.username || url.password || url.port || url.hash) fail('literal_resolution');
  return {source_id:authority.id,capture_id:capture.capture_id,block_id:block.id,start_utf16:block.start_utf16,end_utf16:block.end_utf16,text:block.text,resolved_url:url.href};
}
