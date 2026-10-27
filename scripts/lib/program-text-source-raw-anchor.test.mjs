import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProgramTextCapture } from './program-text-capture-contract.mjs';
import { programTextReference } from './program-text-artifacts.mjs';
import { programTextRawAnchorLinkDisplay } from './program-text-source-raw-anchor.mjs';
import { validateProgramTextSourcePending, validateProgramTextSourceApproval, prepareProgramTextSourceOperation,
  approveProgramTextSourceOperation } from './program-text-source-approval.mjs';
const owner = 'd955a846-cee1-4c01-932e-e3cb7215f3fb', authorityId = 'c49e85e3-3b19-4052-891f-c2bc67e8b8f6';
const targetId = '10000000-0000-4000-8000-000000000001', id = '30000000-0000-4000-8000-000000000001', actor = '40000000-0000-4000-8000-000000000001';
const epoch = 'ec349339-ff62-4d2e-a610-8c361b4044ec', other = '50000000-0000-4000-8000-000000000001';
const authorityURL = 'https://www.nsf.gov/funding/opportunities/grfp-nsf-graduate-research-fellowship-program/nsf26-526/solicitation';
const destinations = ['https://www.nsf.gov/policies/document/graduate-research-fellowship-program-grfp-administrative', 'https://www.nsf.gov/policies/pappg'];
const paragraph = 'This synthetic complete programme text supports fixture-only applicant guidance and funding conditions.';
function fixture({ destination = destinations[1], html, v1 = false } = {}) {
  const href = destination === destinations[0] ? destination : '/policies/pappg';
  html ??= '<!doctype html><html><head><title>NSF</title></head><body><main><p>Incorporated programme policy</p><a href="' + href + '">Current guide</a></main></body></html>';
  const providerSource = { id: authorityId, shared_award_id: owner, url: authorityURL, title: 'NSF GRFP — NSF 26-526 Solicitation', page_type: 'other' };
  const source = { id: targetId, shared_award_id: owner, url: destination, title: 'NSF governing guide fixture', page_type: 'other' };
  const make = (s, text, raw, blocks) => buildProgramTextCapture({ source: s, acquisition: 'http_html', raw_bytes: Buffer.from(raw), content_type: 'text/html; charset=UTF-8',
    text, blocks, extractor: { name: 'fixture', version: '1' }, captured_at: '2026-10-27T05:00:00.000Z' });
  const providerText = v1 ? paragraph + '\n\n' + href : paragraph;
  const providerBlocks = [{ id: 'programme', text: paragraph, start_utf16: 0, end_utf16: paragraph.length }];
  if (v1) providerBlocks.push({ id: 'literal-link', kind: 'source_link', text: href, start_utf16: paragraph.length + 2, end_utf16: providerText.length,
    context: { source_attribute: 'href', link_text: 'Current guide', base_hrefs: [], heading_path: [], list_path: [] } });
  const provider = make(providerSource, providerText, html, providerBlocks), target = make(source, paragraph, '<html><body>' + paragraph + '</body></html>', [{ id: 'target', text: paragraph, start_utf16: 0, end_utf16: paragraph.length }]);
  const captures = new Map([[provider.capture_id, provider], [target.capture_id, target]]), reads = [];
  const pending = { schema: 'awardping.program-text-source-pending-request.' + (v1 ? 'v1' : 'v2'), id, cohort_key: 'nsf_grfp', epoch,
    expected_canonical_shared_award_id: owner, registration_scope: { kind: 'legacy_roles' },
    source: { ...source, create: false, expected_member_kind: 'canonical', expected_admin_review_status: 'review_later', expected_text_monitoring_state: {} },
    authority_ref: programTextReference(provider), ...(v1 ? { link_block_id: 'literal-link' } : { link_proof: { kind: 'retained_raw_html_anchor.v1', anchor_start_utf16: html.indexOf('<a '), target_page_url: destination } }),
    roles: [{ source_role: 'current_documents', expected_revision: epoch, expected_source_ids: [authorityId], next_source_ids: [authorityId, targetId] }] };
  const request = { ...pending, schema: 'awardping.program-text-source-approval-request.' + (v1 ? 'v1' : 'v2'), target_ref: programTextReference(target) };
  return { pending, request, provider, target, reads, context: { epoch, loadCapture: async ref => { reads.push(ref); return captures.get(ref.capture_id); } } };
}
for (const destination of destinations) test('v2 cold-replays actual whole raw source for finite target ' + destination, async () => {
  const f = fixture({ destination }), proof = await validateProgramTextSourcePending(f.pending, f.context);
  assert.equal(proof.schema, 'awardping.program-text-source-pending-proof.v2'); assert.equal(proof.source_text.length, 1);
  assert.deepEqual(f.reads, [f.pending.authority_ref]); assert.equal(proof.provider_link.kind, 'retained_raw_html_anchor.v1');
  assert.equal(proof.provider_link.resolved_url, destination); assert.deepEqual(proof.source_text[0].blocks, f.provider.blocks);
  assert.ok(!proof.source_text[0].blocks.some(b => b.kind === 'source_link')); assert.ok(!Object.hasOwn(proof.provider_link.anchor, 'block_id'));
  assert.deepEqual(Buffer.from(proof.provider_link.raw_base64, 'base64'), f.provider.raw_source.bytes);
});
test('v1 source_link request and response shape stay unchanged', async () => {
  const f = fixture({ v1: true }), p = await validateProgramTextSourcePending(f.pending, f.context);
  assert.equal(p.schema, 'awardping.program-text-source-pending-proof.v1');
  assert.deepEqual(Object.keys(p.provider_link).sort(), ['source_id', 'capture_id', 'block_id', 'start_utf16', 'end_utf16', 'text', 'resolved_url'].sort());
  assert.equal(p.provider_link.block_id, 'literal-link'); assert.equal((await validateProgramTextSourceApproval(f.request, f.context)).schema, 'awardping.program-text-source-approval-proof.v1');
});
test('admin previews omit the whole raw byte payload, preserving v1 preview behavior', async () => {
  const f = fixture(), raw = (await validateProgramTextSourcePending(f.pending, f.context)).provider_link;
  const displayed = programTextRawAnchorLinkDisplay(raw); assert.ok(!Object.hasOwn(displayed, 'raw_base64'));
  assert.equal(displayed.raw_bytes_retained_privately, true); assert.deepEqual(displayed.raw_artifact, raw.raw_artifact);
  assert.deepEqual(displayed.anchor, raw.anchor); assert.ok(raw.raw_base64.length > 0);
  const old = { source_id: authorityId, block_id: 'literal-link', text: '/policies/pappg' };
  assert.equal(programTextRawAnchorLinkDisplay(old), old);
});
test('v2 final validation restores both full original captures', async () => {
  const f = fixture(), p = await validateProgramTextSourceApproval(f.request, f.context);
  assert.deepEqual(f.reads, [f.request.authority_ref, f.request.target_ref]); assert.equal(p.schema, 'awardping.program-text-source-approval-proof.v2');
  assert.equal(p.source_text[1].reference.source.id, targetId);
});
test('server prepares through the existing scoped RPC only after cold replay', async () => {
  const f = fixture(), before = structuredClone(f.pending), calls = [];
  await prepareProgramTextSourceOperation({ rpc: async (name, params) => { calls.push({ name, params }); return { data: { id } }; } }, f.pending, actor, f.context);
  assert.deepEqual(calls.map(x => x.name), ['prepare_program_text_source']); assert.deepEqual(f.pending, before);
  assert.equal(calls[0].params.p_validation.provider_link.raw_artifact.sha256, f.pending.authority_ref.artifacts.raw.sha256);
});
test('no client receipt, arbitrary proof kind, v1 link ID or unknown schema can bypass replay', async () => {
  for (const mutate of [f => f.pending.provider_link = {}, f => f.pending.link_proof.kind = 'client_claim',
    f => f.pending.link_block_id = 'invented', f => f.pending.schema = 'awardping.program-text-source-pending-request.v3']) {
    const f = fixture(); mutate(f); await assert.rejects(validateProgramTextSourcePending(f.pending, f.context));
  }
});
test('wrong owner, cohort, alias member, target and acquisition remain rejected', async () => {
  for (const mutate of [f => f.pending.cohort_key = 'another_cohort', f => f.pending.source.shared_award_id = other,
    f => f.pending.source.expected_member_kind = 'alias', f => f.pending.link_proof.target_page_url += '#x',
    f => f.pending.source.url = 'https://www.nsf.gov/policies/another']) {
    const f = fixture(); mutate(f); await assert.rejects(validateProgramTextSourcePending(f.pending, f.context));
  }
});
test('original raw, text, metadata and full reference mutations fail', async () => {
  for (const mutate of [f => f.provider.raw_source.bytes[1] ^= 1, f => f.provider.text += 'forged',
    f => f.provider.source.title = 'changed', f => f.pending.authority_ref.text_length++]) {
    const f = fixture(); mutate(f); await assert.rejects(validateProgramTextSourcePending(f.pending, f.context));
  }
});
test('literal body anchors do not accept script/template/head/base/duplicate/encoded URL claims', async () => {
  const a = '<a href="/policies/pappg">Guide</a>';
  for (const html of [
    '<html><head></head><body><script>const fake=' + JSON.stringify(a) + ';</script></body></html>',
    '<html><head></head><body><template>' + a + '</template></body></html>',
    '<html><head>' + a + '</head><body></body></html>',
    '<html><head><base href="/"></head><body>' + a + '</body></html>',
    '<html><head></head><body>' + a.replace('href=', 'href="/evil" href=') + '</body></html>',
    '<html><head></head><body>' + a.replace('/policies/pappg', '/policies/pa&#112;pg') + '</body></html>',
    '<html><head></head><body>' + a.replace('/policies/pappg', '/untrusted//../policies/pappg') + '</body></html>',
  ]) { const f = fixture({ html }); await assert.rejects(validateProgramTextSourcePending(f.pending, f.context)); }
});
test('v2 supports the existing draft-inventory scope with empty legacy roles', async () => {
  const f = fixture(); f.pending.registration_scope = { kind: 'variation_inventory', inventory_id: other, revision: epoch }; f.pending.roles = [];
  assert.equal((await validateProgramTextSourcePending(f.pending, f.context)).schema, 'awardping.program-text-source-pending-proof.v2');
});
test('the normal final operation recomputes and compares stored raw proof before the one approval RPC', async () => {
  const f = fixture(), p = await validateProgramTextSourcePending(f.pending, f.context), v = await validateProgramTextSourceApproval(f.request, f.context);
  const hash = 'a'.repeat(64), calls = []; let committed = null;
  const descriptor = { schema: 'awardping.program-text-source-pending-capture.v1', id, epoch, content_hash: hash,
    source: { admin_review_status: 'review_later', text_monitoring_state: {} }, proof: { reference: f.request.target_ref, content_hash: 'b'.repeat(64) } };
  const db = { from: table => { const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: committed }),
    single: async () => ({ data: table === 'program_text_source_pending_requests' ? { validation: p, content_hash: hash } : { document: v.source_text[1], content_hash: 'b'.repeat(64) } }) }; return query; },
    rpc: async (name, params) => { calls.push({ name, params });
      if (name === 'get_program_text_source_pending_capture') return { data: descriptor };
      if (name === 'approve_program_text_source') { committed = { id, source_id: targetId, cohort_key: 'nsf_grfp', epoch, content_hash: 'c'.repeat(64), validation: params.p_validation, role_receipts: [] }; return { data: { id, content_hash: committed.content_hash } }; }
      if (name === 'get_program_text_source_approvals') return { data: { schema: 'awardping.program-text-source-approval-page.v1', epoch, source_ids: [targetId], approvals: [{ schema: 'awardping.program-text-source-approval.v1', id, source_id: targetId, shared_award_id: owner, source_url: f.pending.source.url, cohort_key: 'nsf_grfp', epoch, content_hash: committed.content_hash, current: true }] } };
      if (name === 'program_text_source_is_approved') return { data: true }; throw Error(name);
    } };
  const result = await approveProgramTextSourceOperation(db, id, hash, actor, f.context);
  assert.equal(result.approved, true); assert.deepEqual(calls.map(c => c.name), ['get_program_text_source_pending_capture', 'approve_program_text_source', 'get_program_text_source_approvals', 'program_text_source_is_approved']);
  assert.equal(calls[1].params.p_proposal.schema, 'awardping.program-text-source-approval-request.v2');
  assert.deepEqual(calls[1].params.p_validation.provider_link, p.provider_link);
  committed = null; calls.length = 0; p.provider_link.anchor.literal_href = '/fabricated';
  await assert.rejects(approveProgramTextSourceOperation(db, id, hash, actor, f.context), /saved_original_or_link_changed/);
  assert.deepEqual(calls.map(c => c.name), ['get_program_text_source_pending_capture']);
});
