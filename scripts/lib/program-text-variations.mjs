import { createHash } from 'node:crypto';
import { PROGRAM_FACT_FIELDS, PROGRAM_FACT_REVIEW_SCHEMA, validateProgramFactReview } from './program-text-facts.mjs';
import { hasProgramTextSourceAccess } from './program-text-source-access.mjs';

export const VARIATION_UNIT_SCHEMA = 'awardping.program-variation-unit.v1';
export const VARIATION_VALIDATION_SCHEMA = 'awardping.program-variation-validation.v1';
export const VARIATION_SCOPE_KEYS = ['country', 'course', 'track', 'applicant_group'];
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const text = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max && !x.includes('\0') && Buffer.from(x).toString('utf8') === x;
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(x);
const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const fail = reason => { throw new Error(`Program variations: ${reason}`); };
const canonical = x => Array.isArray(x) ? x.map(canonical) : object(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
export const variationContentHash = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
export const variationScopeKey = x => typeof x === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(x) && x !== 'legacy_common';

/** A finite, provider-indexed scope. It confers collection authority, never facts. */
export function validateVariationScope(scope, { sources, memberIds, cohort, epoch }) {
  if (!exact(scope, ['scope_key', 'label', 'attributes', 'source_roles', 'provider_support', 'retired']) ||
      !variationScopeKey(scope.scope_key) || !text(scope.label, 200) || !exact(scope.attributes, VARIATION_SCOPE_KEYS) ||
      VARIATION_SCOPE_KEYS.some(key => scope.attributes[key] !== null && !text(scope.attributes[key], 200)) ||
      typeof scope.retired !== 'boolean' || scope.scope_key === 'common' && (scope.retired || VARIATION_SCOPE_KEYS.some(key => scope.attributes[key] !== null)) ||
      !Array.isArray(scope.source_roles) || !scope.source_roles.length || scope.source_roles.length > 50 ||
      new Set(scope.source_roles.map(role => role.source_role)).size !== scope.source_roles.length ||
      !Array.isArray(scope.provider_support) || scope.provider_support.length < 1 || scope.provider_support.length > 12) fail('invalid_scope');
  const ids = new Set();
  for (const role of scope.source_roles) {
    if (!exact(role, ['source_role', 'revision', 'source_ids', 'manifest_status', 'evidence']) || !text(role.source_role, 80) ||
        !/^[a-z][a-z0-9_]*$/.test(role.source_role) || !uuid(role.revision) || role.manifest_status !== 'reviewed_text' ||
        !Array.isArray(role.source_ids) || role.source_ids.length < 1 || role.source_ids.length > 50 || role.source_ids.some(id => !uuid(id)) ||
        new Set(role.source_ids).size !== role.source_ids.length || !exact(role.evidence, ['schema', 'source_bindings']) ||
        role.evidence.schema !== 'awardping.program-text-source-role.v1' || !object(role.evidence.source_bindings) ||
        Object.keys(role.evidence.source_bindings).length !== role.source_ids.length) fail('invalid_scope_role');
    for (const id of role.source_ids) {
      ids.add(id); const source = sources.find(source => source.id === id), binding = role.evidence.source_bindings[id];
      if (!source || !hasProgramTextSourceAccess(source, { cohort, epoch }) || !memberIds.includes(source.shared_award_id) ||
          !exact(binding, ['source_url', 'shared_award_id', 'authority_url', 'review_note']) ||
          binding.source_url !== source.url || binding.shared_award_id !== source.shared_award_id ||
          !text(binding.authority_url, 4000) || !/^https:\/\/[^\s]+$/.test(binding.authority_url) || !text(binding.review_note, 2000) ||
          binding.review_note.trim().length < 20) fail('source_owner_or_binding_changed');
    }
  }
  if (ids.size > 500) fail('scope_source_limit');
  return scope;
}

export function validateVariationSupport(quote, captures) {
  if (!exact(quote, ['source_id', 'capture_id', 'block_id', 'start_utf16', 'end_utf16', 'text']) ||
      !uuid(quote.source_id) || !sha(quote.capture_id) || !text(quote.block_id, 160) || !text(quote.text, 1600) ||
      !Number.isSafeInteger(quote.start_utf16) || !Number.isSafeInteger(quote.end_utf16)) fail('invalid_applicability_support');
  const capture = captures.get(quote.source_id), block = capture?.blocks.find(block => block.id === quote.block_id);
  if (block?.kind === "publisher_data" || block?.context?.representation === "publisher_data") fail('publisher_data_is_not_source_quotation');
  if (!capture || capture.capture_id !== quote.capture_id || !block || quote.start_utf16 < block.start_utf16 ||
      quote.end_utf16 > block.end_utf16 || quote.end_utf16 - quote.start_utf16 !== quote.text.length ||
      capture.text.slice(quote.start_utf16, quote.end_utf16) !== quote.text) fail('applicability_quote_not_in_original');
}

/** Prefix authority roles by scope; never conflate two revisions of the same role. */
export function variationContextRoles(scopes, scopeKey) {
  const common = scopes.find(scope => scope.scope_key === 'common' && !scope.retired);
  const selected = scopes.find(scope => scope.scope_key === scopeKey && !scope.retired);
  if (!common || !selected) fail('missing_or_retired_scope');
  return (scopeKey === 'common' ? [common] : [common, selected]).flatMap(scope => scope.source_roles.map(role => ({
    ...role, source_role: `${scope.scope_key}/${role.source_role}`,
  })));
}

/** Resolve explicit replacement/inheritance before applying the unchanged v1 contract. */
export async function validateVariationUnit(unit, context) {
  const { inventory, scopes, shared, registry, sources, memberIds, epoch, loadCapture } = context;
  if (!exact(unit, ['schema', 'inventory_id', 'scope_key', 'shared_review_id', 'shared_hash', 'reviewed_all_sources', 'capture_refs', 'decisions']) ||
      unit.schema !== VARIATION_UNIT_SCHEMA || unit.inventory_id !== inventory.id || inventory.status !== 'sealed' ||
      !variationScopeKey(unit.scope_key) || typeof unit.reviewed_all_sources !== 'boolean' || !Array.isArray(unit.capture_refs) || !Array.isArray(unit.decisions) ||
      unit.decisions.length !== 21 || new Set(unit.decisions.map(d => d.field)).size !== 21 ||
      unit.decisions.some(d => !PROGRAM_FACT_FIELDS.includes(d.field)) || Buffer.byteLength(JSON.stringify(unit)) > 4 * 1024 * 1024) fail('invalid_unit');
  if (unit.scope_key === 'common') {
    if (unit.shared_review_id !== null || unit.shared_hash !== null || unit.decisions.some(d => d.mode !== 'replace')) fail('common_cannot_inherit');
  } else if (!shared || !uuid(unit.shared_review_id) || !sha(unit.shared_hash) || shared.id !== unit.shared_review_id ||
      shared.content_hash !== unit.shared_hash || shared.inventory_id !== inventory.id || shared.scope_key !== 'common') fail('shared_review_changed');
  const roles = variationContextRoles(scopes, unit.scope_key);
  const ids = [...new Set(roles.flatMap(role => role.source_ids))];
  if (ids.length > 500 || sources.length !== ids.length || sources.some(source => !ids.includes(source.id))) fail('incomplete_bounded_context');
  const captures = new Map();
  const load = async ref => {
    if (!captures.has(ref.source.id)) captures.set(ref.source.id, await loadCapture(ref));
    return captures.get(ref.source.id);
  };
  const fields = unit.decisions.map(decision => {
    if (decision.mode === 'replace') {
      if (!exact(decision, ['field', 'mode', 'decision']) || decision.decision?.field !== decision.field) fail('invalid_replacement');
      return decision.decision;
    }
    if (decision.mode !== 'inherit' || !exact(decision, ['field', 'mode', 'support']) || !Array.isArray(decision.support) ||
        decision.support.length < 1 || decision.support.length > 12) fail('explicit_decision_required');
    const field = shared.validation.review.fields.find(field => field.field === decision.field);
    if (!field || field.status === 'unresolved') fail('unresolved_shared_field_cannot_inherit');
    return field;
  });
  const review = { schema: PROGRAM_FACT_REVIEW_SCHEMA, cohort_key: registry.cohort_key, award_id: registry.canonical_shared_award_id,
    epoch, cycle: inventory.cycle, reviewed_all_sources: unit.reviewed_all_sources,
    roster: roles.map(({ source_role, revision, source_ids }) => ({ source_role, revision, source_ids })),
    capture_refs: unit.capture_refs, fields };
  const validation = await validateProgramFactReview(review, { registry, roles, sources, memberIds, epoch, loadCapture: load });
  for (const decision of unit.decisions.filter(d => d.mode === 'inherit')) for (const quote of decision.support) validateVariationSupport(quote, captures);
  return { schema: VARIATION_VALIDATION_SCHEMA, unit, validation };
}

/** Pure completeness check, mirrored transactionally in the award approval RPC. */
export function validateVariationManifest(inventory, scopes, shared, children) {
  if (inventory.status !== 'sealed' || !uuid(inventory.revision) || !sha(inventory.content_hash) ||
      !shared || shared.scope_key !== 'common' || shared.inventory_id !== inventory.id || !sha(shared.content_hash)) fail('invalid_manifest');
  const variants = scopes.filter(scope => scope.scope_key !== 'common' && !scope.retired).map(scope => scope.scope_key).sort();
  if (variants.length !== inventory.expected_variants || children.length !== variants.length ||
      new Set(children.map(child => child.scope_key)).size !== children.length ||
      children.some(child => child.inventory_id !== inventory.id || !variants.includes(child.scope_key) || !sha(child.content_hash) ||
        child.shared_review_id !== shared.id || child.shared_hash !== shared.content_hash || child.blockers?.length)) fail('incomplete_or_stale_variants');
  if (!variants.length && shared.blockers?.length) fail('unresolved_common_scope');
  return { inventory_id: inventory.id, inventory_revision: inventory.revision, inventory_hash: inventory.content_hash,
    shared: { id: shared.id, content_hash: shared.content_hash }, variants: children.map(child => ({
      scope_key: child.scope_key, id: child.id, content_hash: child.content_hash,
    })).sort((a, b) => a.scope_key.localeCompare(b.scope_key)) };
}
