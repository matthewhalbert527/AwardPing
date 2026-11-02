import{describe,it,expect}from'vitest';
import{readFileSync}from'node:fs';
import{createHash}from'node:crypto';
import{parse}from'libpg-query';
const sql=readFileSync(new URL('../supabase/migrations/20261102150453_current_basic_noise_profiles.sql',import.meta.url),'utf8');
const functions=[...sql.matchAll(/EXECUTE \$approved_\d\$([\s\S]*?)\$approved_\d\$/g)].map(m=>m[1]);
const digest=s=>createHash('sha256').update(s).digest('hex');
describe('independent database checks for sponsored ads and hidden anti-spam fields',()=>{
 it('contains exactly three guarded private function updates and no data or permission changes',async()=>{
  const ast=await parse(sql);expect(ast.stmts.map(x=>Object.keys(x.stmt)[0])).toEqual(['DoStmt','DoStmt','DoStmt']);expect(functions).toHaveLength(3);
  expect(sql.replace(/^--.*$/gm,'')).not.toMatch(/\b(?:grant|revoke|insert\s+into|update\s+public\.|delete\s+from|truncate|alter\s+table|create\s+table|security\s+definer)\b/i);
  expect(sql.match(/proacl::text IS DISTINCT FROM old_acl/g)).toHaveLength(3);expect(sql.match(/proowner IS DISTINCT FROM old_owner/g)).toHaveLength(3);expect(sql.match(/proconfig IS DISTINCT FROM old_config OR prosecdef/g)).toHaveLength(3);
 });
 it('parses each actual executed postimage independently, including SQL dollar-plus-quote regex literals',async()=>{
  for(const f of functions){const ast=await parse(f);expect(ast.stmts).toHaveLength(1);expect(ast.stmts[0].stmt.CreateFunctionStmt).toBeDefined();expect(f.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);expect(f).toContain('IMMUTABLE');expect(f).toContain("SET search_path TO ''");}
  expect(functions.map(digest)).toEqual(['08ca989552a6666a01a792bec28ee8883a187720655d72a374b7728a0a6a6b51','bd18bb0e6db7951306c679869196c80d33a9c30dcbf1e86ef256232986f18a5d','2980befa0a657127bee5f54d0130c7a38dcd54ef0670ee56760911d3740df3d8']);
 });
 it('pins all actual previous definitions and checks actual resulting bytes before returning',()=>{
  for(const h of ['d5b7f5719483208d8a7838af73cdfdb058dc0f1b3a00a05e960f738b6f6eb8da','03660e953e7f9c5dcbc81c7c4809da73ada613661f1eec10c1b2fa0cb336a4a6','928a4eb026a137ff1aa1a0162394e5a68acb4a4a75ae8adb16b13ff200019a07'])expect(sql).toContain(h);
  expect(sql.match(/pg_get_functiondef\(p\)/g)).toHaveLength(6);expect(sql.match(/RAISE EXCEPTION/g)).toHaveLength(6);
 });
 it('keeps non-advertisement counts exact and requires an actual bounded integer for DAAD',()=>{
  for(const f of functions.slice(1)){expect(f).toContain("jsonb_typeof(m->'card_count')='number'");expect(f).toContain("~ '^([1-9]|[12][0-9]|3[0-2])$'");expect(f).toContain("else m->'card_count'=to_jsonb(expected_count) end");expect(f).toContain("raw_container_attributes,aria-labelledby");expect(f).toContain("private.awardping_program_utf16_slice");expect(f).toContain("excluded_support_block_ids");}
  expect(functions[1]).toContain('expected_count:=3');expect(functions[1]).toContain('expected_count:=2');expect(functions[1]).toContain("'88906939-65e7-492d-a671-da56678dfecd'");
 });
 it('binds observed label rotations to the exact four sources and unique hidden-field blocks',()=>{
  const f=functions[0];expect(f).toContain("('Company','Facebook','Instagram','LinkedIn','URL','X/Twitter')");expect(f).toContain("old_m->>'label'=new_m->>'label'");expect(f).toContain("b->>'kind'='li' and b->>'text'=before_b->>'text')<>1");expect(f).toContain("b->>'kind'='li' and b->>'text'=after_b->>'text')<>1");
  expect(f).toContain("gfield--type-honeypot");expect(f).toContain("This field is for validation purposes and should be left unchanged.");expect(f).toContain("html_sha256");
 });
});
