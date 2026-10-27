import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {parse} from 'libpg-query';
const sql=readFileSync(new URL('../supabase/migrations/20261027172946_program_text_nsf_admin_pdf_link.sql',import.meta.url),'utf8');
const ast=await parse(sql);
describe('finite NSF indexed-PDF validator migration',()=>{
 it('parses one validator replacement and its ACL without any data or roster statements',()=>{
  expect(ast.stmts.map(row=>Object.keys(row.stmt)[0])).toEqual(['DoStmt','CreateFunctionStmt','GrantStmt','GrantStmt']);
  const fn=ast.stmts[1].stmt.CreateFunctionStmt;
  expect(fn.replace).toBe(true);
  expect(fn.funcname.map(part=>part.String.sval)).toEqual(['private','awardping_program_raw_anchor_provider_link_valid']);
  expect(sql).not.toMatch(/\b(?:insert\s+into|update\s+public\.|delete\s+from|truncate|drop\s+)/i);
 });
 it('pins the reviewed previous body before replacing it and preserves service-only access',()=>{
  expect(sql).toContain('3b5c025211b1235b7473719ea92d247adeae2a23a9a9a173f30b07c253cee64b');
  expect(sql).toContain('from public,anon,authenticated;');
  expect(sql).toContain('to service_role;');
  expect(sql).toContain("SET search_path TO ''");
 });
});
