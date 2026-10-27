import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'libpg-query';
import {describe,it} from 'vitest';
import {
 makeProofDocument,proofDocumentModel,refreshProofDocumentBlocks,
 sourceProofDocumentCases,sourceProofDocumentRollbackSQL,
} from './lib/program-text-source-proof-document-fixtures.mjs';

const migrationURL=new URL('../supabase/migrations/20261027020231_program_text_source_proof_document_fast_path.sql',import.meta.url);
const migration=readFileSync(migrationURL,'utf8');
const cases=sourceProofDocumentCases();

describe('exact source proof document fast path',()=>{
 for(const fixture of cases)it(fixture.id,()=>{
  assert.equal(proofDocumentModel(fixture.document),fixture.expected);
  if(fixture.tightening){
   assert.notEqual(proofDocumentModel(fixture.document,{legacy:true}),false);
   if(fixture.id.startsWith('split_'))assert.equal(fixture.document.text.includes('😀'),true);
   assert.equal(fixture.document.reference.text_length,fixture.document.text.length);
  }else assert.equal(proofDocumentModel(fixture.document,{legacy:true}),fixture.expected);
 });
 it('accepts optional defaults or explicit valid metadata without changing original blocks JSON',()=>{
  const document=makeProofDocument('abc');
  for(const key of ['heading','page','kind','context'])delete document.blocks[0][key];
  refreshProofDocumentBlocks(document);assert.equal(proofDocumentModel(document),true);
  Object.assign(document.blocks[0],{heading:'Heading',page:1.5,kind:'paragraph',context:{programme:'synthetic'}});
  refreshProofDocumentBlocks(document);assert.equal(proofDocumentModel(document),true);
 });
 it('rejects missing required block keys rather than guessing source offsets',()=>{
  for(const key of ['id','text','start_utf16','end_utf16']){
   const document=makeProofDocument('abc');delete document.blocks[0][key];refreshProofDocumentBlocks(document);
   assert.equal(proofDocumentModel(document),false,key);
  }
 });
 it('covers every original character on a 3434-block BMP page of 135239 UTF16 units',()=>{
  const blocks=[];let text='';
  for(let i=0;i<3434;i++){
   if(i)text+='\n';
   const content=(i%3===0?'中é':'Programme').padEnd(i===3433?44:38,'x');
   const start=text.length;text+=content;blocks.push({id:`block-${i}`,text:content,start_utf16:start,end_utf16:text.length});
  }
  // A final longer paragraph makes the synthetic shape exactly the saved
  // Luce text length, without shipping a private full original in the repo.
  const remaining=135239-text.length;assert.ok(remaining>=0);text+='x'.repeat(remaining);
  blocks.at(-1).text+='x'.repeat(remaining);blocks.at(-1).end_utf16=text.length;
  const document=makeProofDocument(text,blocks);
  assert.equal(text.length,135239);assert.equal(blocks.length,3434);
  assert.equal(proofDocumentModel(document),true);
  document.blocks[1700].text='z'+document.blocks[1700].text.slice(1);refreshProofDocumentBlocks(document);
  assert.equal(proofDocumentModel(document),false,'rehashed altered blocks still require full-original slices');
 });
 it('validates a long sparse-astral original and detects a later uncovered hole',()=>{
  const blocks=[];let text='';
  for(let i=0;i<536;i++){
   if(i)text+='\n';const content=`Programme ${i} `+'x'.repeat(240)+(i===5||i===530?'😀':'');
   const start=text.length;text+=content;blocks.push({id:`block-${i}`,text:content,start_utf16:start,end_utf16:text.length});
  }
  const document=makeProofDocument(text,blocks);assert.equal(proofDocumentModel(document),true);
  document.blocks.splice(510,1);refreshProofDocumentBlocks(document);assert.equal(proofDocumentModel(document),false);
 });
 it('checks dense astrals, supplementary endpoints, combining text and a BMP block in an astral original',()=>{
  for(const text of ['😀'.repeat(4000),'𐀀'+String.fromCodePoint(0x10ffff),'e\u0301😀中'])assert.equal(proofDocumentModel(makeProofDocument(text)),true);
  const text='😀\nABC';const document=makeProofDocument(text,[{id:'emoji',text:'😀',start_utf16:0,end_utf16:2},{id:'bmp',text:'ABC',start_utf16:3,end_utf16:6}]);
  assert.equal(proofDocumentModel(document),true);
  document.blocks[1].start_utf16=2;refreshProofDocumentBlocks(document);assert.equal(proofDocumentModel(document),false);
 });
 it('does not accept null or array documents or caller-supplied authority fields',()=>{
  for(const value of [null,[],{},'text',3])assert.equal(proofDocumentModel(value),false);
  const document=makeProofDocument();document.approved=true;assert.equal(proofDocumentModel(document),false);
 });
});

describe('source proof migration and rollback-only rehearsal',()=>{
 it('parses PostgreSQL syntax and replaces only the internal document validator',async()=>{
  const ast=await parse(migration);assert.equal(ast.error,undefined);
  const statements=ast.stmts.map(x=>x.stmt);const creates=statements.filter(x=>x.CreateFunctionStmt).map(x=>x.CreateFunctionStmt);
  assert.equal(creates.length,1);
  assert.equal(creates[0].funcname.map(x=>x.String.sval).join('.'),'private.awardping_program_source_approval_document_valid');
  assert.equal(creates[0].replace,true);
  assert.doesNotMatch(migration,/\b(?:insert|update|delete|truncate|drop|alter\s+table)\s/i);
  assert.doesNotMatch(migration,/statement_timeout|set_config|create\s+table|security\s+definer/i);
 });
 it('checks exact applied helper preimages and retains private service-only invoker authority',()=>{
  for(const digest of ['1da33e8b8cc41b7cad2fed01a83ed70d84cb8435f2b3fc547faceb6a5e00895c','fba5fe463c44d0c610b773e170a610dc5087dd0a15c8a71ae53e2a14d5b4ecd8','6f72c37f8ad03bc33f0612cad323f6f698115ddffc6b1c04c12de1481645a068','1248f163352f96c5cd1cb4ebb7da8cb7a77c170dded9ad4bfe404f126dad7c93'])assert.ok(migration.includes(digest));
  assert.match(migration,/pg_advisory_xact_lock/);assert.match(migration,/into strict actual/);assert.match(migration,/errcode='40001'/);
  assert.match(migration,/immutable security invoker set search_path=''/);
  assert.match(migration,/revoke all[^;]+from public,anon,authenticated/);
  assert.match(migration,/grant execute[^;]+to service_role/);
 });
 it('retains original reference/hash/size/type/order/whitespace guards and proves BMP globally once',()=>{
  for(const guard of ['awardping_program_exact_object(p_doc','awardping_program_text_reference_valid(r)','awardping_program_fact_known_html_shell(r)','awardping_program_fact_known_footer_only_pdf(r)',"between 1 and 20000","blocks_json::jsonb<>blocks","count(distinct x->>'id')","b:='"] )assert.ok(migration.includes(guard),guard);
  assert.equal((migration.match(/awardping_program_utf16_length\(full_text\)/g)||[]).length,1);
  assert.match(migration,/bmp_only:=text_units=char_length\(full_text\)/);
  assert.match(migration,/end_at<=next_at or end_at>text_units/);
  assert.match(migration,/substr\(full_text,next_at\+1,end_at-next_at\) is distinct from b->>'text'/);
  assert.match(migration,/char_length\(b->>'text'\)<>end_at-next_at/);
  assert.match(migration,/next_at<cursor_at/);assert.match(migration,/\[\^\[:space:\]\]/);
  // The ordinary SQL parser treats the function body as a string. PL/pgSQL
  // additionally needs these CASE expressions parenthesized before regex use.
  assert.match(migration,/if next_at>cursor_at and \(case when bmp_only[\s\S]+?end\) ~ '\[\^\[:space:\]\]'/);
  assert.match(migration,/return cursor_at=text_units or \(case when bmp_only[\s\S]+?end\) !~ '\[\^\[:space:\]\]'/);
  assert.match(migration,/awardping_program_block_valid\(b,full_text\) is distinct from true/);
  assert.match(migration,/exception when others then return false/);
 });
 it('generates a bounded old/new parity transaction with strict-invalid cases separated and no commit',async()=>{
  const sql=sourceProofDocumentRollbackSQL({migration,actualDocuments:[{id:'synthetic',document:makeProofDocument()}]});
  const ast=await parse(sql);assert.equal(ast.error,undefined);
  assert.match(sql,/^BEGIN;/);assert.match(sql,/ROLLBACK;\s*$/);assert.doesNotMatch(sql,/\bCOMMIT\s*;/i);
  assert.match(sql,/SET LOCAL statement_timeout='8s'/);assert.match(sql,/old_result=private/);
  assert.ok(sql.indexOf('old_result=private')<sql.indexOf('create or replace function'));
  assert.match(sql,/NOT fixture_row.tightening AND new_result IS DISTINCT FROM fixture_row.old_result/);
  assert.match(sql,/intentional_invalid_NULL_tightenings/);assert.match(sql,/actual_validation_ms/);
  assert.doesNotMatch(sql,/record_program_text_source_probe|approve_program|fetch\(/);
 });
 it('rejects transaction control or a different migration in the generator',()=>{
  assert.throws(()=>sourceProofDocumentRollbackSQL({migration:migration+'\nCOMMIT;'}));
  assert.throws(()=>sourceProofDocumentRollbackSQL({migration:'select 1;'}));
 });
});
