import {createHash} from 'node:crypto';
import {buildProgramTextCapture} from './program-text-capture-contract.mjs';
import {programTextReference,validateProgramTextReference} from './program-text-artifacts.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const source={id:'d1000000-0000-4000-8000-000000000001',shared_award_id:'d1000000-0000-4000-8000-000000000002',url:'https://example.org/program',title:'Synthetic programme',page_type:'other'};
export function refreshProofDocumentBlocks(doc){doc.blocks_json=JSON.stringify(canonical(doc.blocks));doc.reference.blocks_sha256=sha(doc.blocks_json);return doc;}
export function makeProofDocument(text='Deadline: October 30, 2027.',blocks=[{id:'block-000001',text,start_utf16:0,end_utf16:text.length}]){
 const capture=buildProgramTextCapture({source,captured_at:'2026-10-27T01:00:00.000Z',final_url:source.url,acquisition:'http_html',extractor:{name:'fixture',version:'1'},
  raw_bytes:Buffer.from('<main>'+text+'</main>'),content_type:'text/html',text,blocks});
 return{reference:programTextReference(capture),text:capture.text,blocks:capture.blocks,blocks_json:JSON.stringify(canonical(capture.blocks))};
}
const split=(text,start,end)=>{if(start<0||end<=start||end>text.length)return null;const half=at=>at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1])&&/[\uDC00-\uDFFF]/.test(text[at]);return half(start)||half(end)?null:text.slice(start,end);};
function blockResult(raw,text){
 const b={heading:null,page:null,kind:null,context:null,...raw};
 if(!exact(b,['id','text','start_utf16','end_utf16','heading','page','kind','context'])||typeof b.id!=='string'||b.id.replace(/^ +| +$/g,'').length<1||b.id.replace(/^ +| +$/g,'').length>200||
  typeof b.text!=='string'||b.text.replace(/^ +| +$/g,'').length===0||!Number.isInteger(b.start_utf16)||b.start_utf16<0||b.start_utf16>1000000||
  !Number.isInteger(b.end_utf16)||b.end_utf16<1||b.end_utf16>1000000||b.heading!==null&&typeof b.heading!=='string'||b.kind!==null&&typeof b.kind!=='string'||
  b.page!==null&&typeof b.page!=='number'||b.context!==null&&!object(b.context))return false;
 if(b.end_utf16<=b.start_utf16||b.text.length!==b.end_utf16-b.start_utf16)return false;
 const slice=split(text,b.start_utf16,b.end_utf16);return slice===null?null:slice===b.text;
}
/** Local structural model only. Actual PG parity fixtures remain authoritative
 * for POSIX Unicode whitespace and PostgreSQL JSONB/numeric/null semantics. */
export function proofDocumentModel(doc,{legacy=false}={}){
 try{
  if(!exact(doc,['reference','text','blocks','blocks_json']))return false;
  validateProgramTextReference(doc.reference);
  if(doc.reference.acquisition==='http_html'&&doc.reference.text_length===76&&doc.reference.text_sha256==='0690da223815dc8171e2ec5e6699cf455373bb41644063cd276de152a1ac197c'||
   ['pdf_text','pdf_ocr'].includes(doc.reference.acquisition)&&doc.reference.text_length===648&&doc.reference.text_sha256==='91fdc1dca7fa1478500430f80f57ecea04328cb891e2839fae24d3e4f503cd71')return false;
  if(typeof doc.text!=='string'||doc.text.length!==doc.reference.text_length||sha(doc.text)!==doc.reference.text_sha256||!Array.isArray(doc.blocks)||doc.blocks.length<1||doc.blocks.length>20000||
   typeof doc.blocks_json!=='string'||JSON.stringify(canonical(JSON.parse(doc.blocks_json)))!==JSON.stringify(canonical(doc.blocks))||sha(doc.blocks_json)!==doc.reference.blocks_sha256||new Set(doc.blocks.map(b=>b.id)).size!==doc.blocks.length)return false;
  let cursor=0;for(const b of doc.blocks){const valid=blockResult(b,doc.text);if(legacy?valid===false:valid!==true)return false;
   if(b.start_utf16<cursor)return false;
   if(b.start_utf16>cursor){const gap=split(doc.text,cursor,b.start_utf16);if(gap!==null&&/[^\t\n\v\f\r ]/.test(gap))return false;}
   cursor=b.end_utf16;
  }
  if(cursor===doc.reference.text_length)return true;const tail=split(doc.text,cursor,doc.reference.text_length);return tail===null?null:!(/[^\t\n\v\f\r ]/.test(tail));
 }catch{return false;}
}
export function sourceProofDocumentCases(){
 const cases=[],add=(id,document,expected=true,tightening=false)=>cases.push({id,document,expected,tightening});
 add('ascii',makeProofDocument());add('omitted_optional_keys',makeProofDocument('abc'));
 add('multilingual_BMP_combining',makeProofDocument('中é e\u0301\nالعربية'));
 add('astral_complete',makeProofDocument('A😀B𐀀Z'));
 add('whitespace_gap_tail',makeProofDocument('a \t\nb\r\n',[{id:'a',text:'a',start_utf16:0,end_utf16:1},{id:'b',text:'b',start_utf16:4,end_utf16:5}]));
 add('adjacent',makeProofDocument('abcd',[{id:'a',text:'ab',start_utf16:0,end_utf16:2},{id:'b',text:'cd',start_utf16:2,end_utf16:4}]));
 add('astral_ordered',makeProofDocument('😀\n中\n𐀀',[{id:'a',text:'😀',start_utf16:0,end_utf16:2},{id:'b',text:'中',start_utf16:3,end_utf16:4},{id:'c',text:'𐀀',start_utf16:5,end_utf16:7}]));
 const mutate=(id,fn,refresh=false,base=makeProofDocument())=>{const doc=structuredClone(base);fn(doc);if(refresh)refreshProofDocumentBlocks(doc);add(id,doc,false);};
 for(const[key,value]of Object.entries({extra:'x',id:1,text:null,start_utf16:-1,end_utf16:0,heading:[],kind:7,page:'1',context:[]}))mutate('block_'+key,d=>{d.blocks[0][key]=value;},true);
 mutate('id_too_long',d=>{d.blocks[0].id='x'.repeat(201);},true);mutate('whitespace_id',d=>{d.blocks[0].id=' ';},true);
 mutate('fractional_start',d=>{d.blocks[0].start_utf16=0.5;},true);mutate('numeric_string_end',d=>{d.blocks[0].end_utf16=String(d.blocks[0].end_utf16);},true);
 mutate('range_over_1M',d=>{d.blocks[0].end_utf16=1000001;},true);mutate('out_of_text_range',d=>{d.blocks[0].end_utf16++;d.blocks[0].text+='x';},true);
 cases.find(fixture=>fixture.id==='out_of_text_range').tightening=true;
 mutate('text_mismatch_even_rehashed_blocks',d=>{d.blocks[0].text=d.blocks[0].text.replace('Deadline','Xeadline');},true);
 mutate('empty_block',d=>{d.blocks[0].text='';d.blocks[0].end_utf16=0;},true);
 for(const[id,fn]of [['duplicate_ids',d=>{d.blocks[1].id=d.blocks[0].id;}],['overlap',d=>{d.blocks[1].start_utf16=1;d.blocks[1].text='bcd';}],['unsorted',d=>{d.blocks.reverse();}],['gap_with_text',d=>{d.blocks.splice(0,1);}],['tail_with_text',d=>{d.blocks.splice(1,1);}]] )mutate(id,fn,true,makeProofDocument('abcd',[{id:'a',text:'ab',start_utf16:0,end_utf16:2},{id:'b',text:'cd',start_utf16:2,end_utf16:4}]));
 for(const[id,fn]of [['document_extra',d=>{d.extra=1;}],['text_hash',d=>{d.text+='x';}],['blocks_hash',d=>{d.reference.blocks_sha256='0'.repeat(64);}],['blocks_json_mismatch',d=>{d.blocks_json='[]';}],['blocks_json_invalid',d=>{d.blocks_json='{';}],['duplicate_reference_key',d=>{d.reference.extra=1;}],['incomplete',d=>{d.reference.completeness={status:'incomplete',reasons:['missing']};}],['null_text',d=>{d.text=null;}],['empty_blocks',d=>{d.blocks=[];}]])mutate(id,fn);
 for(const [id,text,blocks]of [
  ['split_surrogate_both','😀',[{id:'a',text:'X',start_utf16:0,end_utf16:1},{id:'b',text:'Y',start_utf16:1,end_utf16:2}]],
  ['split_surrogate_end_then_valid','😀Z',[{id:'a',text:'X',start_utf16:0,end_utf16:1},{id:'b',text:'YZ',start_utf16:1,end_utf16:3}]],
  ['astral_uncovered_gap','😀Z',[{id:'z',text:'Z',start_utf16:2,end_utf16:3}]],
 ]){const doc=makeProofDocument(text);doc.blocks=blocks;refreshProofDocumentBlocks(doc);add(id,doc,false,id.startsWith('split_'));}
 return cases;
}
const literal=x=>"'"+JSON.stringify(x).replaceAll("'","''")+"'::jsonb";
/** Operator-only generator. Executes nothing. Actual originals stay private;
 * callers may supply full cold-verified documents for post-migration tests. */
export function sourceProofDocumentRollbackSQL({migration,actualDocuments=[]}){
 if(typeof migration!=='string'||!migration.includes('create or replace function private.awardping_program_source_approval_document_valid')||/\b(?:commit|rollback)\s*;/i.test(migration))throw Error('Expected the exact additive validator migration.');
 const fixtures=sourceProofDocumentCases();
 return `BEGIN;
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='3s';
CREATE TEMP TABLE source_proof_document_parity(id text,document jsonb,expected boolean,tightening boolean,old_result boolean) ON COMMIT DROP;
INSERT INTO source_proof_document_parity(id,document,expected,tightening)
 SELECT x->>'id',x->'document',(x->>'expected')::boolean,(x->>'tightening')::boolean FROM jsonb_array_elements(${literal(fixtures)}) x;
-- Compare the old validator only on bounded synthetic documents. The actual
-- old long-page timeout is already observed and is intentionally not repeated.
UPDATE source_proof_document_parity SET old_result=private.awardping_program_source_approval_document_valid(document);
${migration}
DO $proof_parity$
DECLARE fixture_row record;new_result boolean;tests integer:=0;tightened integer:=0;at_start timestamptz;
 actual_item jsonb;actual_doc jsonb;actual_count integer:=0;actual_ms numeric:=0;mutated jsonb;
BEGIN
 FOR fixture_row IN SELECT * FROM source_proof_document_parity ORDER BY id LOOP
  new_result:=private.awardping_program_source_approval_document_valid(fixture_row.document);
  IF new_result IS DISTINCT FROM fixture_row.expected THEN RAISE EXCEPTION 'Unexpected validator result for %',fixture_row.id;END IF;
  IF NOT fixture_row.tightening AND new_result IS DISTINCT FROM fixture_row.old_result THEN RAISE EXCEPTION 'Old/new parity changed for %',fixture_row.id;END IF;
  IF fixture_row.tightening THEN
   IF fixture_row.old_result IS FALSE OR new_result IS DISTINCT FROM FALSE THEN RAISE EXCEPTION 'Invalid-boundary tightening fixture ineffective';END IF;tightened:=tightened+1;
  END IF;tests:=tests+1;
 END LOOP;
 FOR actual_item IN SELECT value FROM jsonb_array_elements(${literal(actualDocuments)}) LOOP
  actual_doc:=actual_item->'document';at_start:=clock_timestamp();
  IF private.awardping_program_source_approval_document_valid(actual_doc) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Complete original rejected: %',actual_item->>'id';END IF;
  actual_ms:=actual_ms+extract(epoch FROM(clock_timestamp()-at_start))*1000;actual_count:=actual_count+1;tests:=tests+1;
  -- An altered block cannot retain the original canonical blocks/hash proof.
  mutated:=jsonb_set(actual_doc,'{blocks,0,text}',to_jsonb('X'||substr(actual_doc#>>'{blocks,0,text}',2)));
  -- Full canonical blocks JSON is supplied by the operator in the original;
  -- this test deliberately leaves its hash unchanged and must be rejected.
  IF private.awardping_program_source_approval_document_valid(mutated) IS DISTINCT FROM FALSE THEN RAISE EXCEPTION 'Tampered original accepted';END IF;tests:=tests+1;
 END LOOP;
 IF has_function_privilege('anon','private.awardping_program_source_approval_document_valid(jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','private.awardping_program_source_approval_document_valid(jsonb)','EXECUTE')
  OR NOT has_function_privilege('service_role','private.awardping_program_source_approval_document_valid(jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'Source proof validator privileges changed';END IF;tests:=tests+1;
 PERFORM set_config('awardping.source_proof_document_fixture',jsonb_build_object('assertions',tests,'synthetic_cases',(SELECT count(*) FROM source_proof_document_parity),
  'intentional_invalid_NULL_tightenings',tightened,'actual_documents',actual_count,'actual_validation_ms',actual_ms,'paid_calls',0,'persistent_writes',0)::text,true);
END $proof_parity$;
SELECT current_setting('awardping.source_proof_document_fixture') AS source_proof_document_rollback_only_acceptance;
ROLLBACK;
`;
}
