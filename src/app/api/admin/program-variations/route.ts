import { NextResponse } from 'next/server';
import { getCurrentUser, isSiteAdminEmail } from '@/lib/auth';
import { validateSameOriginAdminMutation } from '@/lib/admin-request-security';
import { loadProgramVariationBatch, loadProgramVariationPage, loadProgramVariationUnit, createProgramVariationInventory,
  appendProgramVariationScopes, sealProgramVariationInventory, saveProgramVariationUnit, approveProgramVariationAward,
  publishProgramVariationBatch, reviseProgramVariationExpectedCount, setProgramVariationInventoryGaps, validProgramVariationCoverageGaps } from '@/lib/program-variation-review.server';
import type { VariationUnit } from '@/lib/program-variation-review-types';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const keys = (x: Record<string, unknown>, names: string[]) => Object.keys(x).length === names.length && names.every(k => Object.hasOwn(x, k));
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const hash = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const cohort = (x: unknown): x is string => typeof x === 'string' && /^[a-z0-9_-]{1,80}$/.test(x);
const scope = (x: unknown): x is string => typeof x === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(x) && x !== 'legacy_common';
async function authorize() {
  const user = await getCurrentUser();
  return !user ? { response: reply({ ok: false, error: 'Sign in to review awards.' }, 401), actor: null }
    : !isSiteAdminEmail(user.email) ? { response: reply({ ok: false, error: 'Administrator access required.' }, 403), actor: null }
      : { response: null, actor: user.id };
}
async function body(request: Request) {
  const limit = 4 * 1024 * 1024;
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('json');
  if (Number(request.headers.get('content-length')) > limit) throw new Error('size');
  const reader = request.body?.getReader(); if (!reader) throw new Error('json');
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('size'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function GET(request: Request) {
  const auth = await authorize(); if (auth.response) return auth.response;
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(k => !['cohort', 'inventory', 'scope', 'review', 'cursor'].includes(k) || params.getAll(k).length !== 1)) return reply({ ok: false, error: 'Invalid review selection.' }, 400);
  const c = params.get('cohort'), i = params.get('inventory'), s = params.get('scope'), r = params.get('review'), cursor = params.get('cursor');
  if (params.size && !cohort(c) || i !== null && !uuid(i) || s !== null && (!scope(s) || !uuid(i)) ||
      r !== null && (!uuid(r) || !s) || cursor !== null && (cursor.length > 256 || !/^[a-zA-Z0-9:_-]+$/.test(cursor)) || s !== null && cursor !== null) return reply({ ok: false, error: 'Choose a bounded award or variation.' }, 400);
  try { return reply(!c ? await loadProgramVariationBatch() : s && i ? await loadProgramVariationUnit(c, i, s, r || undefined)
    : await loadProgramVariationPage(c, i || undefined, cursor || undefined)); }
  catch { return reply({ ok: false, error: 'Current inventory, saved text or review version is unavailable.' }, 409); }
}
export async function POST(request: Request) {
  const originError = validateSameOriginAdminMutation(request);
  if (originError) { Object.entries(headers).forEach(([k, v]) => originError.headers.set(k, v)); return originError; }
  const auth = await authorize(); if (auth.response) return auth.response;
  let input: unknown;
  try { input = await body(request); } catch (error) { return reply({ ok: false, error: 'Submit bounded JSON.' }, error instanceof Error && error.message === 'size' ? 413 : 400); }
  if (!object(input)) return reply({ ok: false, error: 'Choose an explicit review action.' }, 400);
  try {
    let result: unknown;
    if (input.action === 'create_inventory' && keys(input, ['action', 'cohort', 'cycle', 'expected_variants', 'previous_revision']) && cohort(input.cohort) &&
      typeof input.cycle === 'string' && input.cycle.trim().length > 0 && input.cycle.length <= 120 && Number.isSafeInteger(input.expected_variants) &&
      (input.expected_variants as number) >= 0 && (input.expected_variants as number) <= 2147483647 && (input.previous_revision === null || uuid(input.previous_revision))) {
      result = await createProgramVariationInventory(input, auth.actor!);
    } else if (input.action === 'append_scopes' && keys(input, ['action', 'inventory_id', 'expected_revision', 'scopes']) && uuid(input.inventory_id) && uuid(input.expected_revision) &&
      Array.isArray(input.scopes) && input.scopes.length >= 1 && input.scopes.length <= 25 && input.scopes.every(s => object(s) && Array.isArray(s.source_roles) && s.source_roles.length >= 1 && s.source_roles.length <= 50 &&
        s.source_roles.every(r => object(r) && Array.isArray(r.source_ids) && r.source_ids.length >= 1 && r.source_ids.length <= 50 && r.source_ids.every(uuid)))) {
      result = await appendProgramVariationScopes(input, auth.actor!);
    } else if (input.action === 'seal_inventory' && keys(input, ['action', 'inventory_id', 'expected_revision', 'expected_hash', 'complete_provider_inventory_reviewed']) &&
      uuid(input.inventory_id) && uuid(input.expected_revision) && hash(input.expected_hash) && input.complete_provider_inventory_reviewed === true) {
      result = await sealProgramVariationInventory(input, auth.actor!);
    } else if (input.action === 'revise_expected_variants' && keys(input, ['action','inventory_id','expected_revision','expected_hash','expected_variants','reason']) &&
      uuid(input.inventory_id) && uuid(input.expected_revision) && hash(input.expected_hash) && Number.isSafeInteger(input.expected_variants) &&
      (input.expected_variants as number) >= 0 && (input.expected_variants as number) <= 2147483647 && typeof input.reason === 'string' && input.reason.trim().length >= 20 && input.reason.length <= 2000) {
      result = await reviseProgramVariationExpectedCount(input, auth.actor!);
    } else if (input.action === 'set_inventory_gaps' && keys(input, ['action','inventory_id','expected_revision','expected_hash','coverage_gaps','reason']) &&
      uuid(input.inventory_id) && uuid(input.expected_revision) && hash(input.expected_hash) && validProgramVariationCoverageGaps(input.coverage_gaps) &&
      typeof input.reason === 'string' && input.reason.trim().length >= 20 && input.reason.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(input.reason)) {
      result = await setProgramVariationInventoryGaps(input, auth.actor!);
    } else if (input.action === 'save_unit' && keys(input, ['action', 'unit']) && object(input.unit) && uuid(input.unit.inventory_id) && scope(input.unit.scope_key) &&
      Array.isArray(input.unit.capture_refs) && input.unit.capture_refs.length >= 1 && input.unit.capture_refs.length <= 500 && Array.isArray(input.unit.decisions) && input.unit.decisions.length === 21) {
      result = await saveProgramVariationUnit(input.unit as unknown as VariationUnit, auth.actor!);
    } else if (input.action === 'approve_award' && keys(input, ['action', 'inventory_id', 'expected_inventory_hash', 'shared_review_id', 'shared_hash', 'child_reviews']) &&
      uuid(input.inventory_id) && hash(input.expected_inventory_hash) && uuid(input.shared_review_id) && hash(input.shared_hash) && object(input.child_reviews) &&
      Object.entries(input.child_reviews).every(([k, v]) => scope(k) && k !== 'common' && object(v) && keys(v, ['id', 'content_hash']) && uuid(v.id) && hash(v.content_hash))) {
      result = await approveProgramVariationAward(input, auth.actor!);
    } else if (input.action === 'publish' && keys(input, ['action', 'expected_revision', 'approval_ids']) && uuid(input.expected_revision) && object(input.approval_ids) &&
      Object.keys(input.approval_ids).length === 25 && new Set(Object.values(input.approval_ids)).size === 25 && Object.entries(input.approval_ids).every(([k, v]) => cohort(k) && uuid(v))) {
      result = await publishProgramVariationBatch(input, auth.actor!);
    } else return reply({ ok: false, error: 'Invalid or incomplete variation action.' }, 400);
    return reply({ ok: true, result });
  } catch { return reply({ ok: false, error: 'Source evidence, inventory coverage or review versions failed validation. Nothing was approved or published by a failed action.' }, 409); }
}
