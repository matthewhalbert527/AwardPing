// Separate retained proof purpose. Never manufactures byte equality, a queue
// result, provider provenance, an owner decision, or a new source observation.
import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {validateProgramTextCapture} from './program-text-capture-contract.mjs';
import {programTextReference} from './program-text-artifacts.mjs';
import {buildProgramTextComparison,buildProgramTextReviewPackets,validateProgramTextReviewResult} from './program-text-review.mjs';
import {validatedProgramTextDeterministicProvenance} from './program-text-deterministic-no-change.mjs';
import {assertCurrentBasicSource,CURRENT_BASIC_FIELDS} from './current-basic-source-proof.mjs';

export const REVIEWED_BASIC_REPEAT_KIND='reviewed_no_program_change';
export const REVIEWED_BASIC_REPEAT_SCHEMA='awardping.current-basic-reviewed-repeat-validation.v1';
export const REVIEWED_BASIC_REPEAT_INSPECTION_SCHEMA='awardping.current-basic-reviewed-repeat-inspection.v1';
export const REVIEWED_BASIC_CANDIDATE_KEYS=Object.freeze(['id','shared_award_id','shared_award_source_id','source_url','candidate_scope','status','rejection_reason','candidate_signature','previous_snapshot_ref','new_snapshot_ref','worker_metadata','prompt_payload','ai_result','model','gemini_batch_name','submitted_at','completed_at','published_at','actual_usage']);
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const reviewedBasicHash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
export const reviewedBasicEqual=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const sha=x=>createHash('sha256').update(x).digest('hex');
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x)&&!/^0{8}(?:-0{4}){3}-0{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const check=(ok,why)=>{if(!ok)throw Error('Reviewed basic repeat: '+why);};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const semantic=b=>{const{id,start_utf16,end_utf16,...rest}=b;return rest;};
const document=c=>({reference:programTextReference(c),text:c.text,blocks:c.blocks,blocks_json:JSON.stringify(canonical(c.blocks))});
const raw=c=>({artifact:programTextReference(c).artifacts.raw,raw_base64:c.raw_source.bytes.toString('base64')});

export function reviewedBasicCandidateSnapshot(candidate){
 check(candidate&&REVIEWED_BASIC_CANDIDATE_KEYS.every(k=>Object.hasOwn(candidate,k)),'complete_candidate_snapshot_required');
 return Object.fromEntries(REVIEWED_BASIC_CANDIDATE_KEYS.map(k=>[k,structuredClone(candidate[k])]));
}

function decodedProtectedDestination(text,block,source){
 const match=/^\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]{6,8194})$/.exec(text);
 if(!match||match[1].length%2)return null;
 const encoded=Buffer.from(match[1],'hex'),bytes=Buffer.from([...encoded.subarray(1)].map(b=>b^encoded[0]));
 if(!bytes.length||!bytes.every(b=>b>=33&&b<=126))return null;
 const address=bytes.toString('ascii'),local=address.split('@')[0];
 if(bytes.length<=254&&local.length<=64&&!local.startsWith('.')&&!local.endsWith('.')&&!local.includes('..')&&/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(address))return bytes;
 // These observed campus-directory payloads retain literal encoded spaces.
 // The original decoded bytes remain the equality target; none are trimmed.
 if(source?.id==='7f3621f2-1422-40e5-b2da-8f1f15b51c04'&&source.shared_award_id==='cb8740aa-4585-4e1c-a939-35fc854cb12b'&&source.url==='https://pattillmanfoundation.org/apply/'&&block.context?.link_text===''&&block.context?.heading_path?.at(-1)?.text==='Tillman Scholars Study at These Universities'&&(/^(?:%20)+/.test(address)||/(?:%20)+$/.test(address))){
  const mailbox=/^(?:%20)*([^%]+?)(?:%20)*$/.exec(address)?.[1];
  if(mailbox&&mailbox.length<=254&&/^[A-Za-z0-9.!#$&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(mailbox))return bytes;
 }
 if(block.context?.link_text!=='Email this Page'||block.context?.heading_path?.at(-1)?.text!=='Share this page')return null;
 const share=/^\?subject=([^&]+)(?:&|&#0*38;|&#[xX]0*26;)body=(.+)$/.exec(address);
 if(!share||/%(?![A-Fa-f0-9]{2})/.test(address))return null;
 try{const subject=decodeURIComponent(share[1]),body=decodeURIComponent(share[2]);return subject.length&&body.length&&!/\p{Cc}/u.test(subject+body)?bytes:null;}catch{return null;}
}

const HONEYPOT_SOURCE='f322a07c-f78c-47fd-aafb-ab6422a4248f';
const HONEYPOT_OWNER='dd23afbb-299e-489f-8a0b-e4d7506848de';
const HONEYPOT_URL='https://www.schwarzmanscholars.org/admissions/application-instructions/';
// The same publisher's form5 rotates its anti-spam prompt independently of the
// page. Bind its observed vocabulary to the exact hidden field rather than to
// whichever two labels happened to appear in one pair of captures. Unknown
// labels remain held; visible fields and every other form/body byte still have
// to pass the existing raw-marker and complete residual comparison.
const HONEYPOT_LABELS=Object.freeze(['Company','Facebook','Instagram','LinkedIn','URL','X/Twitter']);
// Each source retains its exact owner, URL and form action. No other
// GravityForms source, form or field is admitted.
const HONEYPOT_PROFILES=Object.freeze([
 {source_id:HONEYPOT_SOURCE,owner:HONEYPOT_OWNER,url:HONEYPOT_URL,action:'/admissions/application-instructions/#gf_5'},
 {source_id:'434c57c2-4f87-4c5e-bc88-24cb59f4b1e7',owner:'19135163-d9dd-4fc2-b2ae-7d0bb8449735',url:'https://www.schwarzmanscholars.org/admissions/',action:'/admissions/#gf_5'},
 {source_id:'db04bc7a-d0fd-40a5-8922-30921b02a7e2',owner:HONEYPOT_OWNER,url:'https://www.schwarzmanscholars.org/admissions/',action:'/admissions/#gf_5'},
 {source_id:'5bf1f780-ffc1-49e1-88d7-7da3ebd943cf',owner:'19135163-d9dd-4fc2-b2ae-7d0bb8449735',url:'https://www.schwarzmanscholars.org/',action:'/#gf_5'},
]);
const VALIDATION_SENTENCE='This field is for validation purposes and should be left unchanged.';
const WIDGET_PROFILES=Object.freeze([
 {source_id:'0f217532-3638-4cc4-8548-7ae9f4eec489',owner:'592d1ab0-7eff-402a-82ba-90d19559aa7f',url:'https://www.jamesmadison.gov/fellowship-information/fellowship-eligibility',profile:'james_madison_sidebar_testimonials.v1',selector:'div#block-views-block-testimonial-block-block-1.views-element-container',card_selector:'.jmf1-sidebar-testimonial',card_count:3,heading:null},
 ...[['bd79bc43-dd42-4f0b-8323-7c981587b261','https://pdsoros.org/pd-soros-recommendations-a-guide-for-applicants/'],['c2affec3-e89a-4ada-b1eb-955ad72e7646','https://pdsoros.org/guidance-for-recommenders/'],['47c05c1b-05bd-4a39-821f-2d6c1420c197','https://pdsoros.org/fellowship-financial-support/'],['4e4cfa3e-fb2a-4ea7-a792-6da5df9ee6b4','https://pdsoros.org/musicians-applying-for-the-pd-soros-fellowship/']].map(([source_id,url])=>({source_id,owner:'3cf7c610-0246-4dfb-b26c-289254e40ce6',url,profile:'soros_featured_fellows.v1',selector:'div.wp-block-acf-featured-fellows',card_selector:'ul.fellow-list.fellow-list--stacked > li > article.p-person-card.is-fellow',card_count:2,heading:'Featured Fellows'})),
 ...[['56aa30ee-164e-489a-ae5c-f2902dbb0db5','https://www.daad.org/en/find-funding/scholarship-database/?type=a&q=&status=0&subject=0&onlydaad=1&detail_to_show=0&target=44&origin=44&pg=1&detail_to_show=50026200'],['8d654c9d-e572-4488-94a3-e4238e7b1155','https://www.daad.org/en/find-funding/country-specific-information-for-us-applicants/'],['88906939-65e7-492d-a671-da56678dfecd','https://www.daad.org/en/find-funding/scholarship-database/?origin=44&status=3&type=a&q=&onlydaad=1&language=en&detail_to_show=50026200&tab=']].map(([source_id,url])=>({source_id,owner:'440d6985-ece9-48c4-ac30-65a739f60d65',url,profile:'daad_sponsored_university_carousel.v1',selector:'div.bg-lightgrey.u-p-medium.js-ad-slider.is-relative[role="region"][aria-roledescription="Karussell"]',card_selector:'.js-ad-slider-track > div.u-position-relative',card_count:null,heading:'Advertisements by German Universities'})),
].map(Object.freeze));
const flow=s=>s.replace(/\s+/g,' ').trim();
function rawTextVariants(node){const values=[];const walk=n=>{if(n.type==='text')values.push(n.data);else if(!['script','style','template','noscript'].includes(n.name))for(const child of n.children||[])walk(child);};walk(node);return[flow(values.join(' ')),flow(values.join(''))];}

// A rotating advertisement inventory is not a programme rule. Admit only the
// actual publisher's sponsored-card envelope, with a bounded number of cards;
// callers still bind the exact source/owner/URL and conserve all other text.
export function reviewedDaadSponsoredCards(dom,widget,heading){
 const track=widget.find('div.js-ad-slider-track'),cards=track.children('div.u-position-relative');
 check(track.length===1&&cards.length>=1&&cards.length<=32&&track.children().length===cards.length&&track.parents('script,style,template,noscript,iframe,svg,math').length===0,'bounded_sponsored_card_inventory_required');
 check(cards.toArray().every(node=>{
  const card=dom(node),parts=card.children(),info=parts.last(),children=info.children(),label=info.children('p.u-dateline'),title=info.children('h3.u-size-large'),teaser=info.children('p.u-size-teaser'),link=info.children('a.o-more-link.o-more-link--stretched');
  return parts.length===2&&parts.first().is('div.u-mb-medium')&&info.is('div')&&children.length===4&&children.map((i,n)=>n.name).get().join(',')==='p,h3,p,a'
   &&label.length===1&&flow(label.text())===heading&&title.length===1&&flow(title.text()).length>0&&teaser.length===1&&flow(teaser.text()).length>0
   &&link.length===1&&card.find('a[href]').length===1&&/^https:\/\/www\.daad\.org\/en\/university-ad\/[a-z0-9-]+\/$/.test(link.attr('href')||'')
   &&parts.first().find('p,h1,h2,h3,h4,h5,h6,li,a').length===0
   &&card.find('form,input,select,textarea,iframe').length===0;
 }),'sponsored_university_card_structure_changed');
 const counter=widget.find('span.js-slide-count').parent('span.u-size-copy.u-weight-semibold'),current=counter.children('span.js-slide-count');
 check(counter.length===1&&current.length===1&&counter.children().length===1&&current.text()==='1'&&flow(counter.text())==='1/'+cards.length&&counter.parents('script,style,template,noscript,iframe,svg,math').length===0,'sponsored_inventory_counter_changed');
 const groups=widget.children(),header=groups.first(),content=groups.last(),cardText=rawTextVariants({name:'div',children:cards.toArray()}),contentText=rawTextVariants(content[0]),headerRest=header.clone();
 headerRest.find('h2,span.u-size-copy.u-weight-semibold').remove();
 check(groups.length===2&&header.is('div.u-flex-space-between')&&content.is('div.u-mb-medium')&&header.find('h2').length===1&&flow(header.find('h2').text())===heading&&flow(headerRest.text())===''&&header.find('form,input,select,textarea,iframe').length===0&&cardText.every((text,i)=>text===contentText[i]),'unmarked_content_in_sponsored_widget');
 return{cards,scope_nodes:[counter[0],...cards.toArray()]};
}
function widgetMarker(capture){
 const profile=WIDGET_PROFILES.find(p=>p.source_id===capture.source.id);check(profile&&capture.source.shared_award_id===profile.owner&&capture.source.url===profile.url&&capture.final_url===profile.url,'ancillary_widget_profile_not_reviewed');
 const bytes=capture.raw_source.bytes,html=bytes.toString('utf8');check(Buffer.from(html,'utf8').equals(bytes)&&!html.includes('\0')&&!html.startsWith('\ufeff'),'raw_widget_encoding');
 const dom=load(html,{sourceCodeLocationInfo:true}),nodes=dom(profile.selector);check(nodes.length===1&&!dom('base').length,'unique_actual_widget_required');
 const node=nodes[0],widget=dom(node),loc=node.sourceCodeLocation;
 check(node.namespace==='http://www.w3.org/1999/xhtml'&&loc?.startTag&&loc?.endTag&&widget.parents('body').length===1&&!widget.parents('script,style,template,noscript,iframe,svg,math').length,'actual_body_widget_required');
 const daad=profile.profile==='daad_sponsored_university_carousel.v1',sponsored=daad?reviewedDaadSponsoredCards(dom,widget,profile.heading):null,cards=daad?sponsored.cards:widget.find(profile.card_selector);
 check(daad||cards.length===profile.card_count,'reviewed_widget_card_count_changed');
 if(profile.profile==='james_madison_sidebar_testimonials.v1')check(widget.find('footer,#jmf1-social-links-container').length===0&&cards.toArray().every(c=>dom(c).find('.jmf-identity').length===1&&dom(c).find('.testimonial-headshot').length===1&&dom(c).find('h4').length===1&&dom(c).find('h5').length===1),'testimonial_widget_structure_changed');
 if(profile.profile==='soros_featured_fellows.v1'){
  const headings=dom('h2').filter((i,h)=>flow(dom(h).text())===profile.heading);check(headings.length===1,'featured_fellows_heading_missing');
  const common=widget.parents().toArray().find(p=>dom(p).find('h2').toArray().includes(headings[0]));check(common&&!['body','html','main'].includes(common.name),'featured_fellows_group_not_unique');
  check(cards.toArray().every(c=>{const a=dom(c).children('a.p-person-card__inner');return a.length===1&&/^https:\/\/pdsoros\.org\/fellows\/[a-z0-9-]+\/$/.test(a.attr('href')||'');}),'featured_fellow_card_destination_changed');
 }
 if(profile.profile==='daad_sponsored_university_carousel.v1'){
  const headingId=widget.attr('aria-labelledby');check(/^headline-[a-f0-9]{8,32}$/.test(headingId||'')&&widget.find('h2[id]').filter((i,h)=>dom(h).attr('id')===headingId&&flow(dom(h).text())===profile.heading).length===1,'carousel_heading_reference_changed');
 }
 const widgetText=daad?rawTextVariants({name:'div',children:sponsored.scope_nodes}):rawTextVariants(node),hrefs=(daad?cards.find('a[href]'):widget.find('a[href]')).map((i,a)=>dom(a).attr('href')).get(),outer=dom('body').clone();outer.find(profile.selector).remove();
 const outsideText=rawTextVariants(outer[0]),outsideHrefs=outer.find('a[href]').map((i,a)=>dom(a).attr('href')).get();
 const belongs=(block,unique)=>{
  if(profile.source_id==='4e4cfa3e-fb2a-4ea7-a792-6da5df9ee6b4'&&block.kind==='source_link'&&block.context?.source_attribute==='href'){
   const label=flow(block.context.link_text||''),matches=(i,a)=>dom(a).attr('href')===block.text&&rawTextVariants(a).includes(label);
   return label.length>0&&widget.find('a[href]').filter(matches).length===1&&(!unique||outer.find('a[href]').filter(matches).length===0);
  }
  if(block.kind==='source_link'&&block.context?.source_attribute==='href')return hrefs.includes(block.text)&&(!unique||!outsideHrefs.includes(block.text));
  const value=flow(block.text),staticAdvertLabel=profile.profile==='daad_sponsored_university_carousel.v1'&&value===profile.heading&&block.context?.heading_path?.some(h=>h.text===profile.heading)&&widget.find('p.u-dateline').filter((i,p)=>flow(dom(p).text())===value).length===cards.length;
  return value.length>0&&widgetText.some(t=>t.includes(value))&&(!unique||staticAdvertLabel||!outsideText.some(t=>t.includes(value)));
 };
 const containerAttributes={...node.attribs};if(profile.profile==='daad_sponsored_university_carousel.v1')delete containerAttributes['aria-labelledby'];
 const snippet=html.slice(loc.startOffset,loc.endOffset),marker={profile:profile.profile,selector:profile.selector,start_utf16:loc.startOffset,end_utf16:loc.endOffset,html:snippet,html_sha256:sha(Buffer.from(snippet)),container_attributes:containerAttributes,raw_container_attributes:node.attribs,card_count:cards.length,heading:profile.heading,excluded_support_block_ids:capture.blocks.filter(b=>belongs(b,false)).map(b=>b.id)};
 return{marker,belongs};
}
function honeypotMarker(capture,block){
 const profile=HONEYPOT_PROFILES.find(p=>p.source_id===capture.source.id);
 check(profile&&capture.source.shared_award_id===profile.owner&&capture.source.url===profile.url&&capture.final_url===profile.url,'honeypot_profile_not_reviewed');
 const bytes=capture.raw_source.bytes,html=bytes.toString('utf8');
 check(Buffer.from(html,'utf8').equals(bytes)&&!html.startsWith('\ufeff')&&!html.includes('\0'),'raw_html_encoding');
 const dom=load(html,{sourceCodeLocationInfo:true}),nodes=dom('li#field_5_10.gfield--type-honeypot.gform_validation_container');
 check(nodes.length===1&&!dom('base').length,'unique_actual_honeypot_required');
 const node=nodes[0],li=dom(node),location=node.sourceCodeLocation;
 check(node.namespace==='http://www.w3.org/1999/xhtml'&&location?.startTag&&location?.endTag&&li.parents('body').length===1&&!li.parents('script,style,template,noscript,iframe,svg,math').length,'active_html_honeypot_structure');
 const wrapper=li.parents('#gform_wrapper_5'),form=li.parents('form#gform_5');
 check(wrapper.length===1&&form.length===1&&/^\s*display\s*:\s*none\s*;?\s*$/i.test(wrapper.attr('style')||'')&&li.parent('ul#gform_fields_5').length===1&&form.attr('method')==='post'&&form.attr('data-formid')==='5'&&form.attr('action')===profile.action&&form.attr('target')==='gform_ajax_frame_5','exact_hidden_newsletter_form_required');
 const label=li.children('label#gfield_label_5_10[for="input_5_10"]'),labelSpan=label.children('span.gform-field-label__text'),input=li.find('input'),description=li.children('div#gfield_description_5_10.gfield_description');
 check(label.length===1&&labelSpan.length===1&&label.children().length===1&&HONEYPOT_LABELS.includes(labelSpan.text())&&input.length===1&&input.attr('name')==='input_10'&&input.attr('id')==='input_5_10'&&input.attr('type')==='text'&&input.attr('value')===''&&input.attr('autocomplete')==='new-password'&&description.length===1&&description.text()===VALIDATION_SENTENCE&&[labelSpan.text(),description.text()].join(' ')===block.text&&li.text().replace(/\s+/g,'')===block.text.replace(/\s+/g,''),'exact_honeypot_label_only');
 // A matching visible list item must never borrow the hidden field's witness.
 const outside=dom('body').clone();outside.find('li#field_5_10.gfield--type-honeypot.gform_validation_container').remove();
 check(capture.blocks.filter(b=>b.kind==='li'&&b.text===block.text).length===1&&!rawTextVariants(outside[0]).some(t=>t.includes(flow(block.text))),'honeypot_block_not_unique_to_hidden_field');
 const wrapperLocation=wrapper[0].sourceCodeLocation?.startTag,formLocation=form[0].sourceCodeLocation?.startTag;
 check(wrapperLocation&&formLocation,'actual_form_and_wrapper_locators_required');
 const snippet=html.slice(location.startOffset,location.endOffset);
 return{start_utf16:location.startOffset,end_utf16:location.endOffset,html:snippet,html_sha256:sha(Buffer.from(snippet)),wrapper_start_utf16:wrapperLocation.startOffset,wrapper_start_tag:html.slice(wrapperLocation.startOffset,wrapperLocation.endOffset),form_start_utf16:formLocation.startOffset,form_start_tag:html.slice(formLocation.startOffset,formLocation.endOffset),label:labelSpan.text()};
}

// One conserved, raw-bound footer paragraph whose extraction inherits the last
// rotating testimonial headings. It stays outside widget runs and public-support
// exclusions; neither its literal text nor any programme context is discarded.
function jamesMadisonStaticAlignment(previous,current,comparison,previousWidget,currentWidget){
 const source='0f217532-3638-4cc4-8548-7ae9f4eec489',profile='james_madison_conserved_follow_us.v1',selector='footer.flex-grow-0.bg-blue-dark.border-blue.border-top-3.text-center.text-lg-left #jmf1-social-links-container > p';
 check(previous.source.id===source&&current.source.id===source&&previousWidget.marker.profile==='james_madison_sidebar_testimonials.v1'&&currentWidget.marker.profile==='james_madison_sidebar_testimonials.v1','static_alignment_profile_not_reviewed');
 const marker=(capture,widget)=>{
  const html=capture.raw_source.bytes.toString('utf8'),dom=load(html,{sourceCodeLocationInfo:true}),nodes=dom(selector),blocks=capture.blocks.filter(b=>b.kind==='p'&&(b.page===undefined||b.page===null)&&b.text==='Follow Us');
  check(nodes.length===1&&blocks.length===1&&dom('#jmf1-social-links-container').length===1&&dom('p').filter((i,p)=>flow(dom(p).text())==='Follow Us').length===1,'unique_static_footer_required');
  const p=nodes[0],block=blocks[0],loc=p.sourceCodeLocation,last=dom('div#block-views-block-testimonial-block-block-1.views-element-container .jmf1-sidebar-testimonial').last(),headings=[last.find('h4'),last.find('h5')],path=block.context?.heading_path;
  check(p.namespace==='http://www.w3.org/1999/xhtml'&&dom(p).parents('body').length===1&&!dom(p).parents('script,style,template,noscript,iframe,svg,math').length&&loc?.startTag&&loc?.endTag&&html.slice(loc.startOffset,loc.endOffset)==='<p>Follow Us</p>'&&block.heading===path?.map(h=>h.text).join(' > ')&&Array.isArray(path)&&path.length>=2&&!widget.marker.excluded_support_block_ids.includes(block.id),'literal_static_footer_scope_required');
  const inherited_headings=headings.map((heading,i)=>{check(heading.length===1,'unique_last_testimonial_headings_required');const node=heading[0],at=node.sourceCodeLocation,text=flow(heading.text());check(at?.startTag&&at?.endTag&&at.startOffset>=widget.marker.start_utf16&&at.endOffset<=widget.marker.end_utf16&&reviewedBasicEqual(path[path.length-2+i],{level:4+i,text}),'static_scope_not_inherited_from_actual_last_widget');const snippet=html.slice(at.startOffset,at.endOffset);return{level:4+i,text,start_utf16:at.startOffset,end_utf16:at.endOffset,html:snippet,html_sha256:sha(Buffer.from(snippet))};});
  return{profile,selector,block_id:block.id,start_utf16:loc.startOffset,end_utf16:loc.endOffset,html:'<p>Follow Us</p>',html_sha256:sha(Buffer.from('<p>Follow Us</p>')),inherited_headings,heading_prefix:path.slice(0,-2)};
 };
 const before=marker(previous,previousWidget),after=marker(current,currentWidget),oldBlock=previous.blocks.find(b=>b.id===before.block_id),newBlock=current.blocks.find(b=>b.id===after.block_id),withoutScope=b=>{const{id,start_utf16,end_utf16,heading,context,...rest}=b;const{heading_path,...other}=context;return{...rest,context:other};};
 check(reviewedBasicEqual(before.heading_prefix,after.heading_prefix)&&reviewedBasicEqual(withoutScope(oldBlock),withoutScope(newBlock)),'static_footer_has_other_semantic_changes');
 const coupled=comparison.changed_blocks.filter(c=>c.previous?.id===before.block_id||c.current?.id===after.block_id);
 check(coupled.length===2&&coupled.filter(c=>c.previous?.id===before.block_id).length===1&&coupled.filter(c=>c.current?.id===after.block_id).length===1&&coupled.every(c=>(!c.previous||c.previous.id===before.block_id||previousWidget.belongs(c.previous,true))&&(!c.current||c.current.id===after.block_id||currentWidget.belongs(c.current,true))),'exact_coupled_static_alignment_required');
 return{profile,previous_marker:before,current_marker:after,change_ids:coupled.map(c=>c.id).sort()};
}

/** Entire extracted text must be reconstructed by these exact changed slices.
 * No whitespace normalization, ignored programme blocks, or model equivalence. */
export function reviewedBasicDeterministicRules(previous,current,comparison){
 check(comparison.status==='review_required'&&Array.isArray(comparison.changed_blocks)&&comparison.changed_blocks.length>0&&comparison.changed_blocks.length<=256,'bounded_changed_comparison_required');
 const rules=[],previousEdits=[],currentEdits=[];let previousWidget,currentWidget,staticAlignment;
 for(const changed of comparison.changed_blocks){
  const before=changed.previous,after=changed.current;
  check(before||after,'changed_block_scope_or_structure');
  check((!before||previous.text.slice(before.start_utf16,before.end_utf16)===before.text)&&(!after||current.text.slice(after.start_utf16,after.end_utf16)===after.text),'changed_slice_not_literal');
  const sameScope=before&&after&&before.kind===after.kind&&before.heading===after.heading&&reviewedBasicEqual(before.context,after.context)&&before.page===after.page;
  if(sameScope&&before.kind==='source_link'&&before.context?.source_attribute==='href'&&/^\/cdn-cgi\/l\/email-protection#/.test(before.text)){
   const a=decodedProtectedDestination(before.text,before,previous.source),b=decodedProtectedDestination(after.text,after,current.source);
   check(a&&b&&a.equals(b),'changed_protected_destination_or_unreviewed_href');
   rules.push({change_id:changed.id,kind:'identical_protected_email_destination',decoded_hex:a.toString('hex')});
   previousEdits.push({start:before.start_utf16,end:before.end_utf16,marker:['identical_protected_email_destination',a.toString('hex')]});currentEdits.push({start:after.start_utf16,end:after.end_utf16,marker:['identical_protected_email_destination',b.toString('hex')]});
  }else if(sameScope&&before.kind==='li'&&before.text.endsWith(' '+VALIDATION_SENTENCE)&&after.text.endsWith(' '+VALIDATION_SENTENCE)){
   const a=honeypotMarker(previous,before),b=honeypotMarker(current,after);
   check(a.label!==b.label&&new Set([a.label,b.label]).size===2&&a.html.replace('>'+a.label+'</span>','>'+b.label+'</span>')===b.html,'more_than_hidden_label_changed');
   rules.push({change_id:changed.id,kind:'hidden_gravityforms_honeypot_label',previous_marker:a,current_marker:b});
   previousEdits.push({start:before.start_utf16,end:before.end_utf16,marker:['hidden_gravityforms_honeypot_label',previous.source.id]});currentEdits.push({start:after.start_utf16,end:after.end_utf16,marker:['hidden_gravityforms_honeypot_label',current.source.id]});
  }else{
   previousWidget??=widgetMarker(previous);currentWidget??=widgetMarker(current);
   check(reviewedBasicEqual(previousWidget.marker.container_attributes,currentWidget.marker.container_attributes)&&previousWidget.marker.profile===currentWidget.marker.profile,'changed_widget_container_scope');
   if((!before||previousWidget.belongs(before,true))&&(!after||currentWidget.belongs(after,true)))rules.push({change_id:changed.id,kind:'raw_marked_ancillary_widget',profile:currentWidget.marker.profile});
   else{
    check(previous.source.id==='0f217532-3638-4cc4-8548-7ae9f4eec489','changed_block_not_uniquely_within_reviewed_ancillary_widget:'+changed.id);
    staticAlignment??=jamesMadisonStaticAlignment(previous,current,comparison,previousWidget,currentWidget);
    check(staticAlignment.change_ids.includes(changed.id),'changed_block_outside_conserved_static_alignment');
    rules.push({change_id:changed.id,kind:'raw_bound_static_alignment',...staticAlignment});
   }
  }
 }
 const widgetRuns=(capture,widget)=>{if(!widget)return[];const ids=new Set(widget.marker.excluded_support_block_ids),runs=[];let run=null;for(const block of capture.blocks){if(ids.has(block.id)){if(run&&/^\s*$/.test(capture.text.slice(run.end,block.start_utf16)))run.end=block.end_utf16;else{run={start:block.start_utf16,end:block.end_utf16,marker:['raw_marked_ancillary_widget',widget.marker.profile]};runs.push(run);}}else run=null;}return runs;};
 const residual=(capture,technical,widget)=>{const widgetEdits=widgetRuns(capture,widget),edits=[...technical.filter(t=>!widgetEdits.some(w=>t.start>=w.start&&t.end<=w.end)),...widgetEdits].sort((a,b)=>a.start-b.start),parts=[];let at=0;for(const edit of edits){check(edit.start>=at,'overlapping_changed_slices');parts.push(capture.text.slice(at,edit.start),edit.marker);at=edit.end;}parts.push(capture.text.slice(at));return parts;};
 check(reviewedBasicEqual(residual(previous,previousEdits,previousWidget),residual(current,currentEdits,currentWidget)),'changed_text_outside_reviewed_technical_rules');
 return{rules,widget_proofs:previousWidget?[{profile:previousWidget.marker.profile,previous_marker:previousWidget.marker,current_marker:currentWidget.marker}]:[]};
}

function ordinaryReview(candidate,paid,previous,current,epoch){
 check(exact(candidate,REVIEWED_BASIC_CANDIDATE_KEYS)&&uuid(candidate.id)&&candidate.candidate_scope==='program_text_change'&&candidate.status==='rejected'&&candidate.rejection_reason==='no_program_change'&&candidate.published_at===null&&typeof candidate.completed_at==='string'&&Number.isFinite(Date.parse(candidate.completed_at))&&Date.parse(candidate.completed_at)>=Date.parse(current.captured_at)&&candidate.shared_award_id===current.source.shared_award_id&&candidate.shared_award_source_id===current.source.id&&candidate.source_url===current.source.url&&candidate.worker_metadata?.monitoring_contract==='program-text-v1'&&candidate.worker_metadata.epoch===epoch&&candidate.worker_metadata.evidence_signature===candidate.candidate_signature&&reviewedBasicEqual(candidate.previous_snapshot_ref,programTextReference(previous))&&reviewedBasicEqual(candidate.new_snapshot_ref,programTextReference(current)),'terminal_normal_no_change_candidate_required');
 const comparison=buildProgramTextComparison(previous,current,{epoch,cycle_id:candidate.prompt_payload?.comparison?.context?.cycle_id}),plan=buildProgramTextReviewPackets(comparison,candidate.prompt_payload?.packet_plan?.limits);
 check(comparison.comparison_id===candidate.candidate_signature&&reviewedBasicEqual(comparison,candidate.prompt_payload?.comparison)&&plan.status==='ready'&&reviewedBasicEqual(plan,candidate.prompt_payload?.packet_plan),'ordinary_comparison_or_packet_plan_changed');
 check(exact(candidate.ai_result,candidate.ai_result?.program_text_review_provenance?['responses','program_text_validation','program_text_review_provenance']:['responses','program_text_validation']),'normal_validation_envelope_changed');
 const responses=candidate.ai_result.responses,validation=validateProgramTextReviewResult(comparison,plan,responses);
 check(reviewedBasicEqual(validation,{status:'no_program_change',comparison_id:comparison.comparison_id,reasons:[],changes:[]})&&reviewedBasicEqual(validation,candidate.ai_result?.program_text_validation),'saved_normal_response_validation_changed');
 const provenance=candidate.ai_result?.program_text_review_provenance;
 if(provenance){
  const work={schema:'awardping.program-text-review-work.v1',source:current.source,epoch,comparison,packet_plan:plan};
  check(validatedProgramTextDeterministicProvenance(work,validation,responses,provenance)&&paid===null&&candidate.model===null&&candidate.gemini_batch_name===null&&candidate.submitted_at===null&&!candidate.worker_metadata.gemini_spend_reservation_id&&!candidate.worker_metadata.gemini_spend_attempt_token,'deterministic_provenance_or_no_spend_binding_changed');
 }else{
  const keys=candidate.worker_metadata.provider_request_keys;
  check(paid&&paid.status==='settled'&&uuid(paid.id)&&paid.id===candidate.worker_metadata.gemini_spend_reservation_id&&paid.attempt_token===candidate.worker_metadata.gemini_spend_attempt_token&&paid.model===candidate.model&&paid.provider_batch_name===candidate.gemini_batch_name&&paid.lane_key==='changed_page_review'&&paid.worker_source==='program-text-review'&&paid.metadata?.candidate_id===candidate.id&&paid.metadata.monitoring_contract==='program-text-v1'&&paid.work_fingerprint===`program-text:${candidate.candidate_signature}:${candidate.model}`&&Array.isArray(keys)&&new Set(keys).size===keys.length&&paid.request_count===keys.length&&reviewedBasicEqual([...keys].sort(),plan.packets.map(p=>p.packet_id).sort())&&typeof paid.settled_at==='string'&&Number.isFinite(Date.parse(paid.settled_at))&&typeof paid.spent_source==='string'&&paid.spent_source.length>0,'settled_normal_provider_attempt_required');
 }
 return reviewedBasicDeterministicRules(previous,current,comparison);
}

/** Preserve the complete containing block, including every qualifier and all
 * structural context. Only observation-local IDs and positions may move. */
export function reviewedBasicSupportProjection(review,sourceId,current,repeat,widgets=[]){
 const result=[];
 for(const field of review.fields||[]){
  if(field.status!=='verified')continue;
  check(CURRENT_BASIC_FIELDS.includes(field.field),'non_core_verified_field');
  for(const[itemIndex,item]of field.items.entries())for(const[supportIndex,quote]of item.support.entries()){
   if(quote.source_id!==sourceId)continue;
   const block=current.blocks.find(b=>b.id===quote.block_id);
   check(!widgets.some(r=>r.current_marker.excluded_support_block_ids.includes(quote.block_id)),'ancillary_widget_cannot_support_public_facts');
   check(exact(quote,['source_id','capture_id','block_id','start_utf16','end_utf16','text'])&&quote.capture_id===current.capture_id&&block&&Number.isSafeInteger(quote.start_utf16)&&Number.isSafeInteger(quote.end_utf16)&&quote.start_utf16>=block.start_utf16&&quote.end_utf16<=block.end_utf16&&quote.end_utf16-quote.start_utf16===quote.text.length&&quote.text.length>0&&quote.text.length<=1600&&current.text.slice(quote.start_utf16,quote.end_utf16)===quote.text,'published_current_quote_not_literal');
   const matches=repeat.blocks.filter(b=>reviewedBasicEqual(semantic(b),semantic(block))),before=matches.find(b=>b.id===block.id)||(matches.length===1?matches[0]:null);
   check(before,'published_support_full_semantic_block_changed_or_ambiguous');
   check(!widgets.some(r=>r.previous_marker.excluded_support_block_ids.includes(before.id)),'ancillary_widget_cannot_support_public_facts');
   const repeatQuote={...quote,capture_id:repeat.capture_id,block_id:before.id,start_utf16:before.start_utf16+quote.start_utf16-block.start_utf16,end_utf16:before.start_utf16+quote.end_utf16-block.start_utf16};
   check(repeat.text.slice(repeatQuote.start_utf16,repeatQuote.end_utf16)===quote.text,'published_repeat_quote_not_literal');
   result.push({field:field.field,item_index:itemIndex,support_index:supportIndex,value:item.value,track:item.track,current_quote:quote,repeat_quote:repeatQuote,semantic_block:semantic(block)});
  }
 }
 return result.sort((a,b)=>(a.field<b.field?-1:a.field>b.field?1:0)||a.item_index-b.item_index||a.support_index-b.support_index);
}

export function validateCurrentBasicReviewedRepeatEvidence(row,{current,repeat}){
 for(const capture of[current,repeat]){validateProgramTextCapture(capture);check(capture.completeness.status==='complete'&&capture.completeness.reasons.length===0&&capture.acquisition==='http_html','complete_http_originals_required');}
 check(reviewedBasicEqual(programTextReference(current),row.current_ref)&&reviewedBasicEqual(programTextReference(repeat),row.repeat_ref)&&reviewedBasicEqual(current.source,repeat.source)&&current.source.id===row.source_id&&row.kind===REVIEWED_BASIC_REPEAT_KIND&&current.final_url===repeat.final_url&&current.acquisition===repeat.acquisition&&reviewedBasicEqual(current.extractor,repeat.extractor)&&current.capture_id!==repeat.capture_id&&current.captured_at!==repeat.captured_at&&row.current_ref.artifacts.metadata.object_key!==row.repeat_ref.artifacts.metadata.object_key&&Date.parse(repeat.captured_at)<Date.parse(current.captured_at),'independent_exact_same_source_pair_required');
 check(hex(row.candidate_hash)&&reviewedBasicHash(row.candidate)===row.candidate_hash&&row.candidate_id===row.candidate.id,'candidate_snapshot_hash_changed');
 const proof=ordinaryReview(row.candidate,row.paid_reservation,repeat,current,row.epoch);
 check(reviewedBasicEqual(proof.rules,row.rules)&&reviewedBasicEqual(proof.widget_proofs,row.widget_proofs),'deterministic_technical_rule_proof_changed');return proof;
}

export async function prepareCurrentBasicReviewedRepeat({inspection,review,verified_at},context){
 check(inspection?.schema===REVIEWED_BASIC_REPEAT_INSPECTION_SCHEMA&&inspection.packet?.schema==='awardping.current-basic-award-context.v1'&&uuid(inspection.packet.head_id)&&reviewedBasicEqual(Object.fromEntries(Object.keys(inspection.packet.context).map(k=>[k,context[k]])),inspection.packet.context)&&typeof context.loadCapture==='function','fresh_exact_inspection_and_cold_reader_required');
 const candidate=reviewedBasicCandidateSnapshot(inspection.candidate),currentRef=candidate.new_snapshot_ref,repeatRef=candidate.previous_snapshot_ref,source=context.sources.find(s=>s.id===currentRef?.source?.id);
 check(assertCurrentBasicSource(source,currentRef,context)===null&&source.text_monitoring_state.status==='baseline_ready','normal_no_change_source_must_be_settled');
 check(review.cohort_key===context.registry.cohort_key&&review.award_id===context.registry.canonical_shared_award_id&&review.epoch===context.epoch&&reviewedBasicEqual(review.capture_refs.find(r=>r.source.id===source.id),currentRef),'review_or_source_scope_changed');
 check(typeof verified_at==='string'&&Number.isFinite(Date.parse(verified_at))&&new Date(verified_at).toISOString()===verified_at&&Date.parse(verified_at)<=Date.now()&&Date.now()-Date.parse(verified_at)<=15*60*1000,'fresh_verification_clock_required');
 const[current,repeat]=await Promise.all([context.loadCapture(currentRef),context.loadCapture(repeatRef)]);
 const technical=ordinaryReview(candidate,inspection.paid_reservation,repeat,current,context.epoch);
 const row={kind:REVIEWED_BASIC_REPEAT_KIND,source_id:source.id,epoch:context.epoch,current_ref:currentRef,repeat_ref:repeatRef,candidate,candidate_id:candidate.id,candidate_hash:inspection.candidate_hash,paid_reservation:inspection.paid_reservation,...technical};
 validateCurrentBasicReviewedRepeatEvidence(row,{current,repeat});
 check(Date.parse(verified_at)>=Math.max(Date.parse(current.captured_at),Date.parse(repeat.captured_at)),'verification_precedes_capture');
 const support=reviewedBasicSupportProjection(review,source.id,current,repeat,row.widget_proofs);
 const validation={schema:REVIEWED_BASIC_REPEAT_SCHEMA,kind:row.kind,cohort_key:context.registry.cohort_key,source_id:source.id,epoch:context.epoch,expected_head:inspection.packet.head_id,candidate_id:candidate.id,candidate_hash:row.candidate_hash,candidate,paid_reservation:row.paid_reservation,current_document:document(current),repeat_document:document(repeat),current_raw:raw(current),repeat_raw:raw(repeat),rules:row.rules,widget_proofs:row.widget_proofs,support_projection:support,support_hash:reviewedBasicHash(support),verified_at};
 check(Buffer.byteLength(JSON.stringify(validation))<=32*1024*1024,'bounded_complete_reviewed_repeat_required');return{p_validation:validation};
}

/** Ledger kind remains visible in receipts. A different-content repeat can
 * never be interpreted as an old byte-identity observation. */
export function currentReviewedBasicSourceProof(source,ref,context,selected){
 const rows=context.reviewed_repeat_observations?.filter(r=>r.id===selected.id)||[];check(rows.length===1,'reviewed_repeat_ledger_missing');const row=rows[0];
 check(row.kind===REVIEWED_BASIC_REPEAT_KIND&&row.cohort_key===context.registry.cohort_key&&row.source_id===source.id&&row.epoch===context.epoch&&reviewedBasicEqual(row.current_ref,ref)&&row.expected_head===context.basic_fact_head_id&&hex(row.content_hash)&&hex(row.support_hash)&&hex(row.candidate_hash)&&Number.isFinite(Date.parse(row.verified_at))&&Date.parse(row.verified_at)>=Math.max(Date.parse(row.current_ref.captured_at),Date.parse(row.repeat_ref.captured_at)),'reviewed_repeat_does_not_bind_current_source_and_parent_head');
 return{source_id:source.id,repeat_observation_id:null,pending_alert_review_id:null,pending_alert_review_hash:null,kind:REVIEWED_BASIC_REPEAT_KIND,reviewed_repeat_observation_id:row.id,reviewed_repeat_hash:row.content_hash};
}

export function currentBasicProofSelection(proof){return proof.kind===REVIEWED_BASIC_REPEAT_KIND?{source_id:proof.source_id,id:proof.reviewed_repeat_observation_id,kind:proof.kind}:{source_id:proof.source_id,id:proof.repeat_observation_id};}
