// OFFLINE AST/text invariants only. No DB clients or runtime execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const release = new URL('../', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
function body(file, name) {
  const sql = readFileSync(new URL('supabase/migrations/' + file, release), 'utf8').replaceAll('\r\n', '\n');
  const start = sql.toLowerCase().indexOf('function ' + name.toLowerCase() + '('); assert.ok(start >= 0, name);
  const tail = sql.slice(start), marker = /\bas\s+(\$[a-z0-9_]*\$)/i.exec(tail); assert.ok(marker);
  const at = marker.index + marker[0].length, end = tail.indexOf(marker[1], at); assert.ok(end > at);
  return tail.slice(at, end);
}
const core = '20261023180338_program_text_monitoring.sql', variations = '20261026231036_program_variation_reviews.sql';
const quoteGuard = name => `${name}->>'kind'='publisher_data' or ${name}#>>'{context,representation}'='publisher_data'`;
export function patches() {
  const items = [];
  function add(schema, name, file, sourceName, edits) {
    const original = body(file, sourceName || schema + '.' + name); let next = original;
    for (const [before, after] of edits) { assert.equal(next.split(before).length, 2, name + ': unique exact insertion point'); next = next.replace(before, after); }
    assert.notEqual(next, original); items.push({ schema, name, original, next, preimage_sha256: sha(original), edits: edits.map(([needle, replacement]) => ({ needle, replacement })) });
  }
  add('private', 'awardping_program_text_reference_valid', '20261026231050_program_text_public_drive_pdf.sql', null, [
    [' v_pdf boolean; v_limit integer;', ' v_pdf boolean; v_json boolean; v_limit integer;'],
    ["begin\n if p_ref#>>'{extractor,version}'=", "begin\n if (p_ref->>'acquisition'='publisher_json' or p_ref#>>'{extractor,name}'='smart-publisher-json' or p_ref#>>'{extractor,version}'='smart-publisher-json-v1')\n  and not private.awardping_smart_publisher_json_reference_metadata_valid(p_ref) then return false;end if;\n if p_ref#>>'{extractor,version}'="],
    ["in ('http_html','rendered_html','pdf_text','pdf_ocr')", "in ('http_html','rendered_html','pdf_text','pdf_ocr','publisher_json')"],
    [" v_pdf:=p_ref->>'acquisition' in ('pdf_text','pdf_ocr');", " v_pdf:=p_ref->>'acquisition' in ('pdf_text','pdf_ocr');\n v_json:=p_ref->>'acquisition'='publisher_json';"],
    ["when v_pdf then 'original.pdf' else 'original.html' end;", "when v_pdf then 'original.pdf' when v_json then 'original.json' else 'original.html' end;"],
    ["v_limit:=case when v_role='raw' and v_pdf", "v_limit:=case when v_role='raw' and v_json then 524288 when v_role='raw' and v_pdf"],
    ["coalesce(case when v_pdf then (v_artifact", "coalesce(case when v_json then v_artifact->>'content_type'='application/json' when v_pdf then (v_artifact"],
  ]);
  const vStart = "    v_start:=(v_quote->>'start_utf16')::integer; v_end:=(v_quote->>'end_utf16')::integer;";
  for (const [name, file] of [['awardping_program_fact_validation_valid', '20261025175832_program_text_footer_only_pdf_hold.sql'], ['awardping_variation_fact_validation_valid', variations]])
    add('private', name, file, null, [[vStart, `    if ${quoteGuard('v_block')} then return false;end if;\n${vStart}`]]);
  const aStart = " a:=(p_quote->>'start_utf16')::integer; z:=(p_quote->>'end_utf16')::integer;";
  add('private', 'awardping_variation_quote_valid', variations, null, [[aStart, ` if ${quoteGuard('b')} then return false;end if;\n${aStart}`]]);
  const publicStart = "     v_start:=(v_quote->>'start_utf16')::integer-(v_block->>'start_utf16')::integer;";
  add('public', 'awardping_validate_program_text_evidence', core, null, [
    [publicStart, `     if ${quoteGuard('v_block')} then raise exception 'Publisher data labels are not source quotations.' using errcode='23514';end if;\n${publicStart}`],
    [" v_comparison_id:=v_comparison->>'comparison_id';", " if private.awardping_program_changed_publisher_data(v_comparison) then raise exception 'Changed publisher data requires separate reconciliation, not publication.' using errcode='23514';end if;\n v_comparison_id:=v_comparison->>'comparison_id';"],
  ]);
  const noChange = "and c.ai_result#>>'{program_text_validation,status}'='no_program_change'";
  add('private', 'awardping_set_program_text_source_state_base', core, 'public.set_program_text_source_state', [[noChange,
    noChange + "\n             and not private.awardping_program_changed_publisher_data(c.prompt_payload#>'{comparison}')"]]);
  return items;
}
const q = value => "'" + value.replaceAll("'", "''") + "'";
export function patchSQL() {
  return patches().map((entry, index) => `-- Exact ${entry.schema}.${entry.name} preimage, UTF-8 LF body. No guard is removed.\n` +
`do $guard_${index}$\ndeclare function_oid oid; prior_body text; definition text; next_body text; edit jsonb;\nbegin\n` +
` perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));\n` +
` select proc.oid,proc.prosrc,pg_catalog.pg_get_functiondef(proc.oid) into strict function_oid,prior_body,definition\n` +
` from pg_catalog.pg_proc proc join pg_catalog.pg_namespace ns on ns.oid=proc.pronamespace\n where ns.nspname=${q(entry.schema)} and proc.proname=${q(entry.name)};\n` +
` if encode(extensions.digest(convert_to(prior_body,'UTF8'),'sha256'),'hex') is distinct from ${q(entry.preimage_sha256)}\n then raise exception 'Reviewed function body changed; re-review the exact live preimage.' using errcode='40001';end if;\n` +
` next_body:=prior_body;\n for edit in select value from jsonb_array_elements(${q(JSON.stringify(entry.edits))}::jsonb) loop\n` +
`  if edit->>'needle'='' or (length(next_body)-length(replace(next_body,edit->>'needle','')))/length(edit->>'needle')<>1\n  then raise exception 'Expected unique exact body insertion point is unavailable.' using errcode='40001';end if;\n` +
`  next_body:=replace(next_body,edit->>'needle',edit->>'replacement');\n end loop;\n` +
` if next_body=prior_body or (length(definition)-length(replace(definition,prior_body,'')))/length(prior_body)<>1\n then raise exception 'Exact function body cannot be replaced safely.' using errcode='40001';end if;\n` +
` execute replace(definition,prior_body,next_body);\nend $guard_${index}$;\n`).join('\n');
}
const require = createRequire(new URL('../package.json', import.meta.url));
const { parse } = require('libpg-query');
const sql = readFileSync(new URL('../supabase/migrations/20261027050254_program_text_smart_publisher_json.sql', import.meta.url), 'utf8');
const changes = patches();
test('whole migration parses offline with explicit private/service ACLs', async () => {
  const ast = await parse(sql); assert.ok(ast.stmts.length >= 17);
  assert.match(sql, /enable row level security/); assert.match(sql, /revoke all on public\.program_text_smart_initial_coverage_journal from public,anon,authenticated,service_role/);
  assert.match(sql, /grant select on public\.program_text_smart_initial_coverage_journal to service_role/);
  assert.doesNotMatch(sql, /grant[^;]+to (?:anon|authenticated|public)\b/i);
});
test('both new pure SQL predicates parse as SQL expressions independently of dollar-quoted outer DDL', async () => {
  for (const name of ['awardping_smart_publisher_json_reference_metadata_valid', 'awardping_program_changed_publisher_data']) {
    const tail = sql.slice(sql.indexOf('function private.' + name + '('));
    const body = tail.split('as $$')[1].split('$$;')[0];
    const ast = await parse(body); assert.equal(ast.stmts.length, 1);
  }
});
test('all six existing function replacements are exactly derived and guarded; none drops old logic', () => {
  assert.equal(changes.length, 6); assert.ok(sql.includes(patchSQL()));
  for (const change of changes) {
    assert.match(change.preimage_sha256, /^[a-f0-9]{64}$/); assert.ok(sql.includes(change.preimage_sha256));
    let reversed = change.next;
    for (const edit of [...change.edits].reverse()) { assert.equal(reversed.split(edit.replacement).length, 2); reversed = reversed.replace(edit.replacement, edit.needle); }
    assert.equal(reversed, change.original);
  }
});
test('reference branch preserves actual JSON path/MIME and finite source+owner+URL+extractor identity', () => {
  const ref = changes.find(c => c.name === 'awardping_program_text_reference_valid').next;
  for (const value of ["'publisher_json'", "'smart-publisher-json'", "'smart-publisher-json-v1'", "'original.json'", "v_json then 524288", "v_json then v_artifact->>'content_type'='application/json'"]) assert.ok(ref.includes(value), value);
  for (const id of ['58aefec0-0d42-4b7b-9887-60d25940b3d0', 'c33cc2f4-2cbd-458c-b630-537eb3d50f72', 'd7d4d117-f312-456f-a75c-3dbd5d372c99']) assert.ok(sql.includes(id));
  assert.ok(sql.includes("p_ref->>'final_url'=p_ref#>>'{source,url}'"));
  assert.ok(ref.includes("private.awardping_program_public_drive_pdf_metadata_valid(p_ref)"));
});
test('all four quote sinks reject generated publisher data, while literal attributes remain eligible', () => {
  for (const name of ['awardping_program_fact_validation_valid', 'awardping_variation_fact_validation_valid', 'awardping_variation_quote_valid', 'awardping_validate_program_text_evidence']) {
    const body = changes.find(c => c.name === name).next;
    assert.match(body, /->>'kind'='publisher_data' or [a-z_]+#>>'\{context,representation\}'='publisher_data'/);
    assert.doesNotMatch(body, /verbatim[^\n]+false/);
  }
});
test('no-program-change baseline authorization and publication both reject changed publisher data independently of a forged model disposition', () => {
  assert.ok(changes.find(c => c.name === 'awardping_set_program_text_source_state_base').next.includes("and not private.awardping_program_changed_publisher_data(c.prompt_payload#>'{comparison}')"));
  assert.ok(changes.find(c => c.name === 'awardping_validate_program_text_evidence').next.includes('private.awardping_program_changed_publisher_data(v_comparison)'));
  assert.match(sql, /case when jsonb_typeof\(p_comparison->'changed_blocks'\)='array'/);
  assert.match(sql, /else true end/);
});
test('initial-coverage RPC uses common lock before reads, exact source CAS and unchanged scoped approval', () => {
  const rpc = sql.slice(sql.indexOf('create function public.transition_known_smart_html_shell'));
  assert.ok(rpc.indexOf('pg_advisory_xact_lock') < rpc.indexOf('select epoch'));
  assert.match(rpc, /for update/); assert.match(rpc, /s\.text_monitoring_state is distinct from p_expected_state/);
  assert.match(rpc, /awardping_program_source_allowed\(s.id\)/); assert.match(rpc, /awardping_program_text_source_access\(s.id,'smart',policy_epoch\)/);
  assert.match(rpc, /awardping_program_source_approval_document_valid\(p_document\) is distinct from true/);
});
test('only exact original known shell and equal old pair can transition; there is no reset on migration application', () => {
  const rpc = sql.slice(sql.indexOf('create function public.transition_known_smart_html_shell'));
  assert.match(rpc, /awardping_program_fact_known_html_shell\(old_ref\) is distinct from true/);
  assert.match(rpc, /old_ref is distinct from p_expected_state->'latest_ref'/); assert.match(rpc, /p_expected_state->>'status' is distinct from 'baseline_ready'/);
  assert.match(rpc, /p_expected_state->>'epoch' is distinct from policy_epoch::text/);
  const astPrefix = sql.slice(0, sql.indexOf('create function public.transition_known_smart_html_shell'));
  assert.doesNotMatch(astPrefix, /update public\.shared_award_sources/);
  assert.equal((rpc.match(/update public\.shared_award_sources/g) || []).length, 1);
});
test('meaningful first state has exact eight fields and count one, guaranteeing repeat requirement', () => {
  assert.match(sql, /'successful_checks',1/); assert.match(sql, /'first_captured_at',r->>'captured_at'/);
  assert.match(sql, /p_next_state is distinct from expected_next/);
  assert.match(sql, /observed_at<=greatest\(\(old_ref->>'captured_at'\)/);
  assert.match(sql, /observed_at>clock_timestamp\(\)\+interval '5 minutes'/);
  assert.match(sql, /'initial_coverage',true,'creates_update',false/);
});
test('every unresolved/failed legacy or current review blocks; closed records are preserved', () => {
  assert.match(sql, /candidate\.status not in \('superseded','rejected','published'\)/);
  const guard = sql.slice(sql.indexOf('if exists(select 1 from public.shared_award_visual_review_candidates'));
  assert.doesNotMatch(guard.split('then raise exception')[0], /candidate_scope|epoch/);
  assert.doesNotMatch(sql, /(?:delete from|truncate (?:public\.)?shared_award|update public\.shared_award_visual_review_candidates|insert into public\.shared_award_change_events)/i);
});
test('journal is immutable and atomic with source CAS; exact idempotence cannot reset later state', () => {
  assert.match(sql, /unique\(source_id,epoch\)/); assert.match(sql, /before update or delete/); assert.match(sql, /before truncate/);
  assert.match(sql, /prior\.previous_state is distinct from p_expected_state/); assert.match(sql, /prior\.document is distinct from p_document/);
  assert.match(sql, /s\.text_monitoring_state is distinct from prior\.next_state/);
  assert.match(sql, /get diagnostics changed=row_count/); assert.match(sql, /changed<>1 then raise exception/);
  assert.match(sql, /previous_state,next_state,document,document_hash/);
});
test('new helper has no scheduler/provider/factual publication operation or permissive empty reason', () => {
  assert.doesNotMatch(sql, /pg_cron|http_post|net\.http|publish_program_variation_batch\s*\(/i);
  assert.match(sql, /length\(btrim\(coalesce\(p_reason,''\)\)\) not between 20 and 2000/);
  assert.match(sql, /p_policy is distinct from 'awardping.smart-publisher-initial-coverage.v1'/);
});
