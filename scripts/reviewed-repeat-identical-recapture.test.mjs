import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parse} from 'libpg-query';

const migration=readFileSync(new URL('../supabase/migrations/20261102024528_reviewed_repeat_identical_recapture_currentness.sql',import.meta.url),'utf8');
const accepted=readFileSync(new URL('../supabase/migrations/20261101003439_current_basic_sealed_read_fastpaths.sql',import.meta.url),'utf8');
const previous=accepted.split('after_def:=$reviewed_read_after$')[1].split('$reviewed_read_after$;')[0];
const beforeHash='8358f9e50fd8c3d9aac24c07be93a8178d50c8ee6ca8f3f4dd55aac626d5d73e';
const afterHash='34f076d87c55822b16337b8d83f3e83ef86adc9a58e2c9c73e89d7c7f1ee9f4d';
const sha=value=>createHash('sha256').update(value).digest('hex');
const functionAst=ast=>ast.stmts.find(row=>row.stmt.CreateFunctionStmt)?.stmt.CreateFunctionStmt;
const body=f=>f.options.find(row=>row.DefElem.defname==='as').DefElem.arg.List.items[0].String.sval;
const noLocations=value=>Array.isArray(value)?value.map(noLocations):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['location','stmt_location','stmt_len'].includes(key)).map(([key,child])=>[key,noLocations(child)])):value;
const options=f=>noLocations(f.options.filter(row=>row.DefElem.defname!=='as'));
const oldLiveGuard="  and s.text_monitoring_state->>'status'='baseline_ready' and s.text_monitoring_state->'latest_ref'=o.current_ref\n  and private.awardping_current_basic_source_ready(s.id,o.cohort_key,o.epoch,o.current_ref)\n";
const newLiveGuard="  and s.text_monitoring_state->>'status'='baseline_ready'\n  and private.awardping_current_basic_source_ready(s.id,o.cohort_key,o.epoch,latest)\n  and (latest=o.current_ref or (\n   private.awardping_basic_content_identity(latest)=private.awardping_basic_content_identity(o.current_ref)\n   and latest#>>'{artifacts,raw,sha256}'=o.current_ref#>>'{artifacts,raw,sha256}'\n   and latest#>'{artifacts,raw,byte_length}'=o.current_ref#>'{artifacts,raw,byte_length}'\n   and (latest->>'captured_at')::timestamptz>=(o.current_ref->>'captured_at')::timestamptz))\n";

describe('reviewed-repeat currentness after a byte-identical recapture',()=>{
 it('changes exactly the one existing private read function with unchanged signature and execution attributes',async()=>{
  const ast=await parse(migration),before=functionAst(await parse(previous)),after=functionAst(ast);
  expect(ast.stmts.map(row=>Object.keys(row.stmt)[0])).toEqual(['DoStmt','CreateFunctionStmt','DoStmt']);
  expect(after.replace).toBe(true);
  expect(noLocations(after.funcname)).toEqual(noLocations(before.funcname));
  expect(noLocations(after.parameters)).toEqual(noLocations(before.parameters));
  expect(options(after)).toEqual(options(before));
  expect(migration).not.toMatch(/\b(?:grant|revoke|insert|update|delete|truncate|alter\s+table|create\s+table|create\s+index|security\s+definer)\b/i);
 });

 it('pins the exact accepted preimage, independently calculated new function bytes and unchanged private privileges',()=>{
  expect(sha(previous)).toBe(beforeHash);
  const start=migration.indexOf('CREATE OR REPLACE FUNCTION private.awardping_reviewed_repeat_row_current(');
  // pg_get_functiondef omits the command's semicolon and adds one final LF,
  // exactly as the accepted preimage above demonstrates.
  const end=migration.indexOf('end;$function$;',start)+'end;$function$'.length;
  expect(sha(migration.slice(start,end)+'\n')).toBe(afterHash);
  expect(migration).toContain(`IS DISTINCT FROM '${beforeHash}'`);
  expect(migration).toContain(`IS DISTINCT FROM '${afterHash}'`);
  expect(migration.match(/actual\.prosecdef IS DISTINCT FROM false/g)).toHaveLength(2);
  expect(migration.match(/actual\.proacl::text IS DISTINCT FROM '\{postgres=X\/postgres\}'/g)).toHaveLength(2);
  expect(migration.match(/actual\.owner_name IS DISTINCT FROM 'postgres'/g)).toHaveLength(2);
  expect(migration.match(/actual\.provolatile::text IS DISTINCT FROM 's'/g)).toHaveLength(2);
  expect(migration.match(/actual\.proconfig IS DISTINCT FROM ARRAY\['search_path=""'\]/g)).toHaveLength(2);
 });

 it('preserves every seal, policy, candidate, paid row and immutable observation binding byte for byte',async()=>{
  const before=body(functionAst(await parse(previous))),after=body(functionAst(await parse(migration)));
  const expected=before.replace('sealed_text text;v jsonb;','sealed_text text;v jsonb;latest jsonb;')
   .replace(' select * into strict s from public.shared_award_sources where id=o.source_id;\n'," select * into strict s from public.shared_award_sources where id=o.source_id;\n latest:=s.text_monitoring_state->'latest_ref';\n")
   .replace(oldLiveGuard,newLiveGuard);
  expect(before.split(oldLiveGuard)).toHaveLength(2);
  expect(after).toBe(expected);
  expect(after).toContain('o.content_hash is distinct from encode(extensions.digest(convert_to(sealed_text');
  expect(after).toContain('private.awardping_reviewed_repeat_read_policy_current() is distinct from true');
  expect(after).toContain("v->'candidate'=private.awardping_reviewed_repeat_candidate(o.candidate_id)");
  expect(after).toContain("v->'paid_reservation'=private.awardping_reviewed_repeat_paid(v->'candidate')");
  expect(after).toContain('exception when others then return false;');
 });

 it('validates actual latest readiness before the exact-reference or strict byte-identity alternatives',async()=>{
  const after=body(functionAst(await parse(migration)));
  expect(after).toContain(newLiveGuard);
  expect(after.indexOf('private.awardping_current_basic_source_ready(s.id,o.cohort_key,o.epoch,latest)')).toBeLessThan(after.indexOf('(latest=o.current_ref or ('));
  const unchanged=after.slice(after.indexOf('(latest=o.current_ref or ('));
  expect(unchanged).toContain('private.awardping_basic_content_identity(latest)=private.awardping_basic_content_identity(o.current_ref)');
  expect(unchanged).toContain("latest#>>'{artifacts,raw,sha256}'=o.current_ref#>>'{artifacts,raw,sha256}'");
  expect(unchanged).toContain("latest#>'{artifacts,raw,byte_length}'=o.current_ref#>'{artifacts,raw,byte_length}'");
  expect(unchanged).toContain("(latest->>'captured_at')::timestamptz>=(o.current_ref->>'captured_at')::timestamptz");
 });
});
