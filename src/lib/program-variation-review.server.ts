import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createR2Client, getR2Bucket } from '@/lib/r2';
import type { Json } from '@/lib/database.types';
import type { VariationAdminPage, VariationCoverageGap, VariationInventory, VariationQuery, PublishedVariationContext, VariationScope, VariationUnit } from './program-variation-review-types';
import { emptyProgramFactReview, PROGRAM_FACT_FIELDS, validateProgramFactReview } from '../../scripts/lib/program-text-facts.mjs';
import { validateVariationScope, validateVariationSupport, validateVariationUnit, variationContextRoles, variationScopeKey } from '../../scripts/lib/program-text-variations.mjs';
import { loadProgramTextCapture } from '../../scripts/lib/program-text-artifacts.mjs';
import monitoring from '../../config/program-text-monitoring.json';
import { attachProgramTextSourceApprovals } from '../../scripts/lib/program-text-source-access.mjs';

// New service-only RPCs deliberately stay separate from the preserved v1 APIs.
const db = () => createSupabaseAdminClient() as unknown as SupabaseClient;
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const cohortKey = (x: unknown): x is string => typeof x === 'string' && /^[a-z0-9_-]{1,80}$/.test(x);
const json = (x: unknown): Json => JSON.parse(JSON.stringify(x)) as Json;
// Manual private curation only. These references are never fetched or treated as
// source approval. Keep the same conservative syntax in the database guard.
export function validProgramVariationCoverageGaps(value: unknown): value is VariationCoverageGap[] {
  if (!Array.isArray(value) || value.length > 50) return false;
  const names = new Set<string>();
  return value.every(gap => {
    if (!object(gap) || Object.keys(gap).length !== 3 || !['key', 'label', 'source_url'].every(k => Object.hasOwn(gap, k)) ||
      typeof gap.key !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(gap.key) || names.has(gap.key) ||
      typeof gap.label !== 'string' || !gap.label.trim() || gap.label !== gap.label.trim() || gap.label.length > 500 || /[\u0000-\u001f\u007f]/.test(gap.label)) return false;
    names.add(gap.key);
    if (gap.source_url === null) return true;
    if (typeof gap.source_url !== 'string' || gap.source_url.length > 2048 ||
      !/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}(?::443)?(?:\/[^\s#\\]*)?$/.test(gap.source_url) ||
      /[\u0000-\u001f\u007f]/.test(gap.source_url)) return false;
    try {
      const url = new URL(gap.source_url);
      return url.hostname.length <= 253 && !url.username && !url.password && !url.hash && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(url.hostname);
    } catch { return false; }
  });
}
function publishedBindings(ids: unknown[], bindings: unknown, selected: boolean) {
  if (!object(bindings) || Object.keys(bindings).length !== ids.length || new Set(ids).size !== ids.length) return false;
  return ids.every(id => {
    if (!uuid(id) || !object(bindings[id])) return false;
    const binding = bindings[id];
    if (Object.keys(binding).length !== (selected ? 4 : 2) || !uuid(binding.shared_award_id) || typeof binding.url !== 'string') return false;
    try { const url = new URL(binding.url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false; } catch { return false; }
    return !selected || ['title', 'page_type'].every(key => binding[key] === null || typeof binding[key] === 'string' && (binding[key] as string).length <= 10000);
  });
}
type Source = { id: string; shared_award_id: string; url: string; title: string | null; admin_review_status: string; text_monitoring_state: { latest_ref?: unknown } | null };
type Role = { source_role: string; revision: string; source_ids: string[]; manifest_status: string; evidence: Json };
type UnitRow = { id: string; inventory_id: string; scope_key: string; content_hash: string; unit: VariationUnit;
  validation: { review: { fields: unknown[]; capture_refs: unknown[] }; blockers: string[] }; shared_review_id: string | null; shared_hash: string | null };
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const result = await db().rpc(name, args);
  if (result.error) throw new Error('Variation evidence, authorization or version checks failed.');
  return result.data as unknown;
}
function cursor(value?: string) {
  if (value === undefined) return null;
  const match = /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}):([a-z0-9][a-z0-9_-]{0,127})$/.exec(value);
  if (!match) throw new Error('Invalid versioned cursor.');
  return { revision: match[1], scope: match[2] };
}
async function sourceRows(ids: string[]) {
  if (!ids.length || ids.some(id => !uuid(id)) || new Set(ids).size !== ids.length) throw new Error('Incomplete source identities.');
  const rows: Source[] = [];
  // Bound transport requests, not the complete inventory. Individual evidence
  // units still have the unchanged 500-source/32MiB review ceiling.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const part = ids.slice(offset, offset + 100);
    const result = await db().from('shared_award_sources').select('id,shared_award_id,url,title,page_type,admin_review_status,text_monitoring_state').in('id', part).order('id').limit(101);
    if (result.error || result.data?.length !== part.length) throw new Error('Current source identities unavailable.');
    rows.push(...result.data as Source[]);
  }
  if (new Set(rows.map(row => row.id)).size !== ids.length) throw new Error('Duplicate source identity.');
  return attachProgramTextSourceApprovals(db(), rows, { epoch: monitoring.epoch }) as Promise<Source[]>;
}
async function identity(cohort: string) {
  const client = db();
  const [registry, members] = await Promise.all([
    client.from('stage1_award_registry').select('cohort_key,canonical_shared_award_id').eq('cohort_key', cohort).single(),
    client.from('stage1_award_members').select('shared_award_id').eq('cohort_key', cohort).order('shared_award_id').limit(100),
  ]);
  if (registry.error || !registry.data || members.error || !members.data?.length || members.data.length === 100) throw new Error('Award identity unavailable.');
  return { registry: registry.data as { cohort_key: string; canonical_shared_award_id: string },
    memberIds: (members.data as { shared_award_id: string }[]).map(row => row.shared_award_id) };
}
function originalLoader() {
  const client = createR2Client(), bucket = getR2Bucket();
  return (ref: unknown) => loadProgramTextCapture(ref as Parameters<typeof loadProgramTextCapture>[0], { client, bucket });
}
async function unitContext(inventoryId: string, scopeKey: string, sharedId?: string | null) {
  const client = db();
  const inventoryResult = await client.from('program_variation_inventories').select('*').eq('id', inventoryId).single();
  if (inventoryResult.error || !inventoryResult.data) throw new Error('Inventory unavailable.');
  const inventory = inventoryResult.data as VariationInventory;
  const scopesResult = await client.from('program_variation_scopes').select('*').eq('inventory_id', inventoryId).in('scope_key', [...new Set(['common', scopeKey])]).order('scope_key').limit(3);
  if (scopesResult.error || !scopesResult.data?.length || scopesResult.data.length === 3) throw new Error('Bounded scope unavailable.');
  const scopes = scopesResult.data as VariationScope[], roles = variationContextRoles(scopes, scopeKey) as Role[];
  const ids = [...new Set(roles.flatMap(role => role.source_ids))];
  if (ids.length > 500) throw new Error('Scope exceeds bounded evidence review.');
  const [who, sources] = await Promise.all([identity(inventory.cohort_key), sourceRows(ids)]);
  let shared: UnitRow | null = null;
  if (scopeKey !== 'common') {
    const query = client.from('program_variation_unit_reviews').select('*').eq('inventory_id', inventoryId).eq('scope_key', 'common');
    const result = sharedId ? await query.eq('id', sharedId).single() : await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
    if (result.error) throw new Error('Shared review unavailable.');
    shared = result.data as UnitRow | null;
  }
  return { inventory, scopes, shared, ...who, sources, epoch: monitoring.epoch, loadCapture: originalLoader() };
}

export async function loadProgramVariationBatch() { return rpc('get_program_variation_admin_batch'); }
export async function loadProgramVariationPage(cohort: string, inventoryId?: string, after?: string): Promise<VariationAdminPage> {
  const parsed = cursor(after);
  const value = await rpc('get_program_variation_admin_page', { p_cohort: cohort, p_inventory: inventoryId || null, p_after: parsed?.scope || null, p_limit: 25 });
  if (!object(value) || !Array.isArray(value.scopes) || !Object.hasOwn(value, 'inventory')) throw new Error('Invalid variation page.');
  if (value.inventory !== null && (!object(value.inventory) || !validProgramVariationCoverageGaps(value.inventory.coverage_gaps))) throw new Error('Invalid private inventory gaps.');
  if (parsed && (!object(value.inventory) || value.inventory.revision !== parsed.revision)) throw new Error('Inventory changed during pagination.');
  return value as unknown as VariationAdminPage;
}
export async function loadProgramVariationUnit(cohort: string, inventoryId: string, scopeKey: string, reviewId?: string) {
  const client = db();
  const query = client.from('program_variation_unit_reviews').select('*').eq('inventory_id', inventoryId).eq('scope_key', scopeKey);
  const result = reviewId ? await query.eq('id', reviewId).single() : await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
  if (result.error) throw new Error('Saved unit unavailable.');
  const row = result.data as UnitRow | null, context = await unitContext(inventoryId, scopeKey, row?.shared_review_id);
  if (context.inventory.cohort_key !== cohort) throw new Error('Wrong award inventory.');
  const unit = row?.unit || { schema: 'awardping.program-variation-unit.v1' as const, inventory_id: inventoryId, scope_key: scopeKey,
    shared_review_id: context.shared?.id || null, shared_hash: context.shared?.content_hash || null, reviewed_all_sources: false,
    capture_refs: context.sources.map(source => context.shared?.validation.review.capture_refs.find((ref: unknown) => object(ref) && object(ref.source) && ref.source.id === source.id) || source.text_monitoring_state?.latest_ref),
    decisions: PROGRAM_FACT_FIELDS.map((field: string) => ({ field, mode: 'replace', decision: { field, status: 'unresolved', items: [], note: 'This provider variation has not been reviewed.' } })) };
  // A missing shared review cannot silently become inheritance. The empty child
  // template is viewable, but saving it requires the explicit common version.
  const roles = variationContextRoles(context.scopes, scopeKey);
  const empty = emptyProgramFactReview({ ...context, roles, cycle: context.inventory.cycle });
  empty.capture_refs = unit.capture_refs;
  // The existing validator restores originals sequentially and enforces its
  // complete-context ceiling. Do not launch hundreds of parallel R2 reads.
  const validation = row ? (await validateVariationUnit(unit, context)).validation
    : await validateProgramFactReview(empty, { ...context, roles });
  const captures = validation.source_text.map((doc: { reference: { source: { id: string; url: string }; capture_id: string }; text: string; blocks: unknown[] }) => ({
    id: doc.reference.source.id, url: doc.reference.source.url, title: context.sources.find(source => source.id === doc.reference.source.id)?.title || null,
    text: doc.text, blocks: doc.blocks, capture_id: doc.reference.capture_id,
  }));
  return { inventory: context.inventory, scope: context.scopes.find(scope => scope.scope_key === scopeKey),
    shared: context.shared ? { id: context.shared.id, content_hash: context.shared.content_hash } : null,
    unit, review: row ? { id: row.id, content_hash: row.content_hash, blockers: row.validation.blockers } : null, sources: captures };
}
export async function createProgramVariationInventory(input: Record<string, unknown>, actor: string) {
  return rpc('create_program_variation_inventory', { p_cohort: input.cohort, p_cycle: input.cycle,
    p_expected_variants: input.expected_variants, p_previous_revision: input.previous_revision, p_actor: actor });
}
export async function appendProgramVariationScopes(input: Record<string, unknown>, actor: string) {
  const scopes = input.scopes as VariationScope[];
  const inventory = await db().from('program_variation_inventories').select('cohort_key').eq('id', input.inventory_id).single();
  if (inventory.error || !inventory.data || !cohortKey(inventory.data.cohort_key)) throw new Error('Inventory unavailable.');
  const who = await identity(inventory.data.cohort_key);
  // Bootstrap a deep provider index from individually authorized normal repeat
  // captures. It need not be squeezed into an award's old common source roster.
  const ids = [...new Set(scopes.flatMap(scope => scope.provider_support.map(quote => object(quote) ? quote.source_id : null)))];
  if (!ids.length || ids.length > 500 || ids.some(id => !uuid(id))) throw new Error('Provider-index review must remain bounded.');
  const sources = await sourceRows(ids as string[]), loadCapture = originalLoader();
  const roles: Role[] = [];
  for (let offset = 0; offset < sources.length; offset += 50) {
    const group = sources.slice(offset, offset + 50);
    roles.push({ source_role: `provider_index_${offset / 50}`, revision: monitoring.epoch, source_ids: group.map(source => source.id), manifest_status: 'reviewed_text',
      evidence: json({ schema: 'awardping.program-text-source-role.v1', source_bindings: Object.fromEntries(group.map(source => [source.id, {
        source_url: source.url, shared_award_id: source.shared_award_id, authority_url: source.url,
        review_note: 'Server-bound individually authorized provider index; this grants no source or factual approval.',
      }])) }) });
  }
  const context = { ...who, roles, sources, epoch: monitoring.epoch, loadCapture };
  const review = emptyProgramFactReview({ ...context, cycle: 'Provider variation inventory evidence only' });
  const validation = await validateProgramFactReview(review, context);
  const proof = { schema: 'awardping.program-variation-provider-proof.v1', cohort_key: who.registry.cohort_key, epoch: monitoring.epoch, source_text: validation.source_text };
  const captures = new Map(validation.source_text.map((doc: { reference: { source: { id: string }; capture_id: string }; text: string; blocks: unknown[] }) =>
    [doc.reference.source.id, { ...doc, capture_id: doc.reference.capture_id }]));
  const scopeIds = [...new Set(scopes.flatMap(scope => scope.source_roles.flatMap(role => (role as unknown as Role).source_ids)))];
  const scopeSources = await sourceRows(scopeIds);
  for (const scope of scopes) { validateVariationScope(scope, { sources: scopeSources, memberIds: who.memberIds, cohort: who.registry.cohort_key, epoch: monitoring.epoch });
    for (const support of scope.provider_support) validateVariationSupport(support, captures); }
  return rpc('append_program_variation_scopes', { p_inventory: input.inventory_id, p_expected_revision: input.expected_revision,
    p_scopes: scopes, p_provider_validation: proof, p_actor: actor });
}
export async function sealProgramVariationInventory(input: Record<string, unknown>, actor: string) {
  return rpc('seal_program_variation_inventory', { p_inventory: input.inventory_id, p_expected_revision: input.expected_revision,
    p_expected_hash: input.expected_hash, p_complete_provider_inventory_reviewed: input.complete_provider_inventory_reviewed, p_actor: actor });
}
export async function reviseProgramVariationExpectedCount(input: Record<string, unknown>, actor: string) {
  return rpc('revise_program_variation_expected_count', { p_inventory: input.inventory_id, p_expected_revision: input.expected_revision,
    p_expected_hash: input.expected_hash, p_expected_variants: input.expected_variants, p_reason: input.reason, p_actor: actor });
}
export async function setProgramVariationInventoryGaps(input: Record<string, unknown>, actor: string) {
  if (!uuid(input.inventory_id) || !uuid(input.expected_revision) || typeof input.expected_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_hash) ||
    !validProgramVariationCoverageGaps(input.coverage_gaps) || typeof input.reason !== 'string' || input.reason.trim().length < 20 || input.reason.length > 2000 ||
    /[\u0000-\u001f\u007f]/.test(input.reason) || typeof actor !== 'string' || !actor.trim() || actor.length > 320) throw new Error('Invalid private inventory gaps.');
  return rpc('set_program_variation_inventory_gaps', { p_inventory: input.inventory_id, p_expected_revision: input.expected_revision,
    p_expected_hash: input.expected_hash, p_coverage_gaps: input.coverage_gaps, p_reason: input.reason, p_actor: actor });
}
export async function saveProgramVariationUnit(unit: VariationUnit, actor: string) {
  const context = await unitContext(unit.inventory_id, unit.scope_key, unit.shared_review_id);
  const envelope = await validateVariationUnit(unit, context);
  return rpc('save_program_variation_unit', { p_envelope: json(envelope), p_actor: actor });
}
export async function approveProgramVariationAward(input: Record<string, unknown>, actor: string) {
  return rpc('approve_program_variation_award', { p_inventory: input.inventory_id, p_expected_inventory_hash: input.expected_inventory_hash,
    p_shared_review: input.shared_review_id, p_shared_hash: input.shared_hash, p_child_reviews: input.child_reviews, p_actor: actor });
}
export async function publishProgramVariationBatch(input: Record<string, unknown>, actor: string) {
  return rpc('publish_program_variation_batch', { p_expected_revision: input.expected_revision, p_approval_ids: input.approval_ids, p_actor: actor });
}
export async function loadPublishedVariationBatch() {
  const value = await rpc('get_program_variation_publication');
  if (!object(value) || value.schema !== 'awardping.program-variation-publication.v1' || typeof value.active !== 'boolean' || !Array.isArray(value.cohorts)) throw new Error('Invalid variation publication.');
  if (!value.active) { if (value.cohorts.length) throw new Error('Inactive variation publication contains awards.'); return null; }
  if (value.cohorts.length !== 25 || value.cohorts.some(row => !object(row) || !Array.isArray(row.source_ids) || !publishedBindings(row.source_ids, row.source_bindings, false))) throw new Error('Incomplete variation publication.');
  return value;
}
export async function loadPublishedVariationContext(cohort: string, query: VariationQuery = {}): Promise<PublishedVariationContext | null> {
  if (!cohortKey(cohort) || query.scopeKey !== undefined && !variationScopeKey(query.scopeKey) ||
      [query.country, query.course, query.track].some(value => value !== undefined && (!value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value)))) throw new Error('Invalid variation selection.');
  const parsed = cursor(query.cursor);
  const value = await rpc('get_program_variation_public_context', { p_cohort: cohort, p_scope: query.scopeKey ?? null,
    p_after: parsed?.scope || null, p_country: query.country ?? null, p_course: query.course ?? null, p_track: query.track ?? null });
  if (value === null) return null;
  if (!object(value) || !uuid(value.inventory_id) || !uuid(value.revision) || !Array.isArray(value.options) || value.options.length > 25 ||
      !Array.isArray(value.source_ids) || value.source_ids.length < 1 || value.source_ids.length > 500 || value.source_ids.some(id => !uuid(id)) ||
      !publishedBindings(value.source_ids, value.source_bindings, true) || !object(value.selected_option) || value.selected_option.scope_key !== value.selected_scope_key ||
      typeof value.selected_option.label !== 'string' || !value.selected_option.label.trim() || value.selected_option.label.length > 200 ||
      !object(value.selected_option.attributes) || Object.keys(value.selected_option.attributes).length !== 4 ||
      ['country','course','track','applicant_group'].some(key => !object(value.selected_option) || !object(value.selected_option.attributes) ||
        value.selected_option.attributes[key] !== null && (typeof value.selected_option.attributes[key] !== 'string' || (value.selected_option.attributes[key] as string).length > 200)) ||
      typeof value.current !== 'boolean' || value.selected_scope_key !== (query.scopeKey ?? 'common') || parsed && value.revision !== parsed.revision) throw new Error('Variation publication changed or is incomplete.');
  return value as unknown as PublishedVariationContext;
}
