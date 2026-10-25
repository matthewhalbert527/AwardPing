import { PROGRAM_DETAIL_FIELDS } from "./program-change-contract.mjs";
import { validateProgramTextCapture } from "./program-text-capture-contract.mjs";
import { validateProgramTextReference, programTextReference } from "./program-text-artifacts.mjs";

export const PROGRAM_FACT_REVIEW_SCHEMA = "awardping.program-fact-review.v1";
export const PROGRAM_FACT_FIELDS = Object.freeze(["overview", ...PROGRAM_DETAIL_FIELDS]);
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const nonempty = (x, max) => typeof x === "string" && x.trim().length > 0 && x.length <= max && !x.includes("\0") && Buffer.from(x).toString("utf8") === x;
const canonical = x => Array.isArray(x) ? x.map(canonical) : object(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sorted = values => [...values].sort();
const sameSet = (a, b) => a.length === new Set(a).size && b.length === new Set(b).size && equal(sorted(a), sorted(b));
const fail = reason => { throw new Error(`Program fact review: ${reason}`); };

/** Drafts are suggestions, never inferred approval of the existing public facts. */
export function emptyProgramFactReview({ registry, roles, sources, epoch, cycle }) {
  return {
    schema: PROGRAM_FACT_REVIEW_SCHEMA, cohort_key: registry.cohort_key,
    award_id: registry.canonical_shared_award_id, epoch, cycle, reviewed_all_sources: false,
    roster: roles.map(role => ({ source_role: role.source_role, revision: role.revision, source_ids: role.source_ids })),
    capture_refs: sources.flatMap(source => source.text_monitoring_state?.latest_ref ? [source.text_monitoring_state.latest_ref] : []),
    fields: PROGRAM_FACT_FIELDS.map(field => ({ field, status: "unresolved", items: [], note: "Current official details have not yet been reviewed." })),
  };
}

function checkSource(source, ref, epoch) {
  validateProgramTextReference(ref);
  const state = source?.text_monitoring_state;
  if (!source || source.admin_review_status !== "open" || !state || state.schema !== "awardping.program-text-state.v1" ||
      state.epoch !== epoch || state.status !== "baseline_ready" || !Number.isInteger(state.successful_checks) || state.successful_checks < 2 ||
      !equal(state.baseline_ref, state.latest_ref) || state.latest_ref.text_sha256 !== ref.text_sha256 ||
      state.latest_ref.final_url !== ref.final_url || state.latest_ref.acquisition !== ref.acquisition ||
      !equal(state.latest_ref.extractor, ref.extractor) || Date.parse(ref.captured_at) > Date.parse(state.last_checked_at) ||
      ref.source.id !== source.id || ref.source.shared_award_id !== source.shared_award_id || ref.source.url !== source.url) fail("source_not_current_and_repeated");
  validateProgramTextReference(state.latest_ref);
  if (state.latest_ref.source.id !== source.id || state.latest_ref.source.shared_award_id !== source.shared_award_id ||
      state.latest_ref.source.url !== source.url || !(Date.parse(state.first_captured_at) < Date.parse(state.latest_ref.captured_at))) fail("source_observation_identity_changed");
}

/** Cold-load every original. No model, provider, database or publication calls. */
export async function validateProgramFactReview(review, { registry, roles, sources, memberIds, epoch, loadCapture, forApproval = false }) {
  if (!exact(review, ["schema", "cohort_key", "award_id", "epoch", "cycle", "reviewed_all_sources", "roster", "capture_refs", "fields"]) ||
      review.schema !== PROGRAM_FACT_REVIEW_SCHEMA || review.cohort_key !== registry.cohort_key || review.award_id !== registry.canonical_shared_award_id ||
      review.epoch !== epoch || !nonempty(review.cycle, 120) || typeof review.reviewed_all_sources !== "boolean" ||
      !Array.isArray(review.roster) || !Array.isArray(review.capture_refs) || !Array.isArray(review.fields) ||
      Buffer.byteLength(JSON.stringify(review)) > 4 * 1024 * 1024) fail("invalid_or_wrong_award_review");
  const expectedRoles = roles.map(role => ({ source_role: role.source_role, revision: role.revision, source_ids: role.source_ids }));
  if (!review.roster.length || review.roster.some(role => !exact(role, ["source_role", "revision", "source_ids"])) ||
      !equal([...review.roster].sort((a, b) => a.source_role.localeCompare(b.source_role)), [...expectedRoles].sort((a, b) => a.source_role.localeCompare(b.source_role)))) fail("roster_changed");
  const requiredIds = [...new Set(roles.flatMap(role => role.source_ids))];
  if (!requiredIds.length || requiredIds.length > 500 || !sameSet(review.capture_refs.map(ref => ref?.source?.id), requiredIds) ||
      !sameSet(sources.map(source => source.id), requiredIds)) fail("incomplete_source_set");
  const restored = new Map(); let totalBytes = 0;
  for (const ref of review.capture_refs) {
    const source = sources.find(source => source.id === ref.source.id);
    if (!memberIds.includes(source.shared_award_id) || roles.filter(role => role.source_ids.includes(source.id)).some(role =>
      role.evidence?.schema !== "awardping.program-text-source-role.v1" || role.manifest_status !== "reviewed_text" ||
      role.evidence.source_bindings?.[source.id]?.source_url !== source.url ||
      role.evidence.source_bindings?.[source.id]?.shared_award_id !== source.shared_award_id)) fail("source_not_approved_for_program");
    checkSource(source, ref, epoch);
    const capture = await loadCapture(ref);
    validateProgramTextCapture(capture, { source });
    if (!equal(programTextReference(capture), ref)) fail("original_reference_changed");
    totalBytes += Buffer.byteLength(capture.text) + Buffer.byteLength(JSON.stringify(capture.blocks));
    if (totalBytes > 32 * 1024 * 1024) fail("complete_context_exceeds_review_limit");
    restored.set(source.id, capture);
  }
  if (!sameSet(review.fields.map(field => field?.field), PROGRAM_FACT_FIELDS)) fail("incomplete_field_review");
  const blockers = [];
  for (const field of review.fields) {
    if (!exact(field, ["field", "status", "items", "note"]) || !["verified", "not_published", "unresolved"].includes(field.status) ||
        !Array.isArray(field.items) || field.items.length > 64 || typeof field.note !== "string" || field.note.length > 2000 ||
        field.status !== "verified" && (field.items.length !== 0 || !nonempty(field.note, 2000) || field.note.trim().length < 20) ||
        field.status === "verified" && field.items.length === 0) fail("invalid_field_decision");
    if (field.status === "unresolved") blockers.push(field.field);
    const itemIdentities = new Set();
    for (const item of field.items) {
      if (!exact(item, ["value", "track", "support"]) || !nonempty(item.value, 2400) ||
          !(item.track === null || nonempty(item.track, 200)) || !Array.isArray(item.support) || item.support.length < 1 || item.support.length > 12) fail("unsupported_field_value");
      const identity = JSON.stringify([item.track, item.value]);
      if (itemIdentities.has(identity)) fail("duplicate_field_value");
      itemIdentities.add(identity);
      if (field.field === "application_url") {
        let url; try { url = new URL(item.value); } catch { fail("invalid_application_destination"); }
        if (url.protocol !== "https:" || url.username || url.password) fail("invalid_application_destination");
      }
      for (const quote of item.support) {
        if (!exact(quote, ["source_id", "capture_id", "block_id", "start_utf16", "end_utf16", "text"]) ||
            !nonempty(quote.text, 1600) || !Number.isSafeInteger(quote.start_utf16) || !Number.isSafeInteger(quote.end_utf16)) fail("invalid_support_quote");
        const capture = restored.get(quote.source_id), block = capture?.blocks.find(block => block.id === quote.block_id);
        if (!capture || capture.capture_id !== quote.capture_id || !block || quote.start_utf16 < block.start_utf16 ||
            quote.end_utf16 > block.end_utf16 || quote.end_utf16 - quote.start_utf16 !== quote.text.length ||
            capture.text.slice(quote.start_utf16, quote.end_utf16) !== quote.text) fail("quote_not_in_bound_original");
      }
      if (["deadline", "opening_date"].includes(field.field)) {
        const supportedYears = new Set(item.support.flatMap(quote => quote.text.match(/\b(?:19|20)\d{2}\b/g) || []));
        if (supportedYears.size && (item.value.match(/\b(?:19|20)\d{2}\b/g) || []).some(year => !supportedYears.has(year))) fail("date_year_not_supported_by_quote");
      }
    }
    if (["deadline", "opening_date", "cycle_status"].includes(field.field) && field.items.length > 1 &&
        (field.items.some(item => !item.track) || new Set(field.items.map(item => item.track)).size !== field.items.length)) fail("conflicting_unscoped_dates_or_status");
  }
  if (!review.reviewed_all_sources) blockers.push("complete_source_context_not_reviewed");
  const overview = review.fields.find(field => field.field === "overview");
  if (overview.status !== "verified" || overview.items.length !== 1 || overview.items[0].track !== null) blockers.push("verified_program_overview_required");
  if (forApproval && blockers.length) fail("unresolved_review_cannot_be_approved");
  const validation = { schema: "awardping.program-fact-validation.v1", review, blockers,
    source_text: review.capture_refs.map(ref => { const capture = restored.get(ref.source.id); return { reference: ref, text: capture.text,
      blocks: capture.blocks, blocks_json: JSON.stringify(canonical(capture.blocks)) }; }),
    public_facts: programFactPublicValues(review),
  };
  if (Buffer.byteLength(JSON.stringify(validation)) > 32 * 1024 * 1024) fail("complete_context_exceeds_review_limit");
  return validation;
}

/** One normalized snapshot for every public consumer. Track-specific dates stay labeled. */
export function programFactPublicValues(review) {
  const facts = {}, fields = new Map(review.fields.map(field => [field.field, field]));
  const values = name => fields.get(name)?.status === "verified" ? fields.get(name).items.map(item => item.track ? `${item.track}: ${item.value}` : item.value) : [];
  for (const name of PROGRAM_FACT_FIELDS) {
    const list = values(name);
    facts[name] = ["overview", "deadline", "opening_date", "cycle_status", "application_url"].includes(name) ? list.length === 1 ? list[0] : null : list;
  }
  for (const name of ["deadline", "opening_date"]) if (values(name).length > 1) facts.important_dates.push(...values(name).map(value => `${name === "deadline" ? "Application deadline" : "Opens"} — ${value}`));
  facts.award_amounts.push(...["stipend", "tuition", "travel_research_allowance"].flatMap(name => values(name).map(value => `${name === "stipend" ? "Stipend" : name === "tuition" ? "Tuition" : "Travel/research"}: ${value}`)));
  facts.reviewed_cycle = review.cycle;
  facts.application_urls = values("application_url");
  facts.not_published_fields = review.fields.filter(field => field.status === "not_published").map(field => field.field);
  return facts;
}
