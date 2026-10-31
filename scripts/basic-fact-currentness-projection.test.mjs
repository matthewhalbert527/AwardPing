import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {parse} from 'libpg-query';

const migration=readFileSync(new URL('../supabase/migrations/20261031225125_materialize_basic_fact_currentness.sql',import.meta.url),'utf8');
const previous=readFileSync(new URL('../supabase/migrations/20261029162139_program_basic_fact_publication.sql',import.meta.url),'utf8');
const before=previous.slice(previous.indexOf('create function public.get_program_basic_facts('),previous.indexOf("revoke all on function private.awardping_basic_href"));
const nodes=(root,key)=>{const out=[];const walk=value=>{if(!value||typeof value!=='object')return;if(Object.hasOwn(value,key))out.push(value[key]);for(const child of Object.values(value))if(Array.isArray(child))child.forEach(walk);else walk(child);};walk(root);return out;};
const fn=tree=>tree.stmts.find(row=>row.stmt.CreateFunctionStmt)?.stmt.CreateFunctionStmt;
const body=definition=>definition.options.find(row=>row.DefElem.defname==='as').DefElem.arg.List.items[0].String.sval;
const noLocations=value=>Array.isArray(value)?value.map(noLocations):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['location','stmt_location','stmt_len'].includes(key)).map(([key,child])=>[key,noLocations(child)])):value;
const options=definition=>noLocations(definition.options.filter(row=>row.DefElem.defname!=='as'));

function explainRoots(value){
 if(Array.isArray(value))return value.flatMap(explainRoots);
 if(!value||typeof value!=='object')return[];
 if(value.Plan&&typeof value.Plan==='object')return[value.Plan];
 return Object.values(value).flatMap(explainRoots);
}
function planNodes(plan){return[plan,...(plan.Plans||[]).flatMap(planNodes)];}
function materializedEvaluation(explain,expectedRows){
 const roots=explainRoots(explain);expect(roots).toHaveLength(1);
 const all=planNodes(roots[0]),producers=all.filter(row=>row['Subplan Name']==='CTE scoped_current');
 expect(producers).toHaveLength(1);
 const producer=producers[0];expect(producer['Actual Rows']).toBe(expectedRows);expect(producer['Actual Loops']).toBe(1);
 const expressions=planNodes(producer).flatMap(row=>row.Output||[]),helper=expressions.filter(text=>text.includes('awardping_basic_fact_current('));
 expect(helper).toHaveLength(1);
 const outside=all.filter(row=>!planNodes(producer).includes(row)).flatMap(row=>row.Output||[]);
 expect(outside.some(text=>text.includes('awardping_basic_fact_current('))).toBe(false);
 const scans=all.filter(row=>row['Node Type']==='CTE Scan'&&row['CTE Name']==='scoped_current');
 expect(scans).toHaveLength(1);expect(scans[0]['Actual Rows']).toBe(expectedRows);expect(scans[0]['Actual Loops']).toBe(1);
 return expectedRows;
}

describe('basic-fact projection keeps currentness fresh with one evaluation per selected head',()=>{
 it('changes only the existing RPC body and retains its exact security options and input guard',async()=>{
  const ast=await parse(migration),old=fn(await parse(before)),next=fn(ast);
  expect(ast.stmts.map(row=>Object.keys(row.stmt)[0])).toEqual(['DoStmt','CreateFunctionStmt','DoStmt']);
  expect(next.replace).toBe(true);expect(noLocations(next.funcname)).toEqual(noLocations(old.funcname));
  expect(noLocations(next.parameters)).toEqual(noLocations(old.parameters));expect(options(next)).toEqual(options(old));
  expect(body(next).split('return coalesce')[0]).toBe(body(old).split('return coalesce')[0]);
  expect(migration).not.toMatch(/\b(?:insert|update|delete|truncate|grant|revoke|alter\s+table|create\s+table|statement_timeout)\b/i);
 });
 it('pins the actual original RPC and all unchanged currentness/authority helpers',()=>{
  for(const hash of ['c76fed1fe86c2e5aae992d0f876fdb21aeae2bf0c1a163eed86a376f040e75b7','14cb00619fd34612ceb6d0b5b79dff8ae0979ccae6693903030c3d7582881871','d130ce8def118e6297b13b578cbf048641a290e579a68f22caf17c28888c053d','d22a3d6a24d6a1d991dd3dc459163f7555625db4e446fcc6a34e1a25fded1360','283f9e68cf4ebe0e5518765ecb9df9be0b4dde00d7ac70a44e9f5377d5aac1b2'])expect(migration).toContain(hash);
  expect(migration).toContain("proacl::text='{postgres=X/postgres,service_role=X/postgres}'");
  expect(migration).not.toMatch(/create\s+(?:or\s+replace\s+)?function\s+private\./i);
 });
 it('uses a real SQL materialization barrier after award scoping and retains the unchanged helper',async()=>{
  const definition=fn(await parse(migration)),text=body(definition),expression=text.slice(text.indexOf('return ')+7,text.lastIndexOf(';\nend;'));
  const tree=await parse('select '+expression),ctes=nodes(tree,'CommonTableExpr');
  expect(ctes).toHaveLength(1);expect(ctes[0].ctename).toBe('scoped_current');expect(ctes[0].ctematerialized).toBe('CTEMaterializeAlways');
  const calls=nodes(tree,'FuncCall').filter(call=>call.funcname.map(v=>v.String.sval).join('.')==='private.awardping_basic_fact_current');
  expect(calls).toHaveLength(1);
  expect(nodes(ctes[0].ctequery,'A_Expr').some(expr=>expr.kind==='AEXPR_OP_ANY')).toBe(true);
  expect(nodes(ctes[0].ctequery,'RangeVar').map(row=>row.relname).sort()).toEqual(['program_basic_fact_heads','program_basic_fact_snapshots']);
 });
 it('actual read-only EXPLAIN proves exactly35 guard evaluations in one materialized producer',()=>{
  const measured=JSON.parse(readFileSync(new URL('./fixtures/basic-fact-currentness-readonly-plan.json',import.meta.url),'utf8'));
  expect(measured.schema).toBe('awardping.basic-currentness-readonly-plan.v1');
  expect(measured.database_mutations).toBe(0);expect(measured.selected_awards).toBe(35);
  expect(materializedEvaluation(measured.explain,35)).toBe(35);
 });
 it('the measured-plan check rejects folding, rescans and duplicated helper computation',()=>{
  const measured=JSON.parse(readFileSync(new URL('./fixtures/basic-fact-currentness-readonly-plan.json',import.meta.url),'utf8'));
  for(const change of [root=>planNodes(explainRoots(root)[0]).find(row=>row['Subplan Name']==='CTE scoped_current')['Subplan Name']='folded',root=>planNodes(explainRoots(root)[0]).find(row=>row['Subplan Name']==='CTE scoped_current')['Actual Loops']=2,root=>planNodes(explainRoots(root)[0]).find(row=>row['Subplan Name']==='CTE scoped_current').Output.push('private.awardping_basic_fact_current(s.id)')]){
   const bad=structuredClone(measured.explain);change(bad);expect(()=>materializedEvaluation(bad,35)).toThrow();
  }
 });
});
