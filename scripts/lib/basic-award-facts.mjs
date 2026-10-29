import { createHash } from "node:crypto";
import { PROGRAM_FACT_FIELDS, programFactPublicValues, validateProgramFactReview } from "./program-text-facts.mjs";
import { programTextReference } from "./program-text-artifacts.mjs";
import { validateProgramTextCapture } from "./program-text-capture-contract.mjs";
import { hasUnclearedProgramTextCollectionFailure } from "./program-text-collection-quality.mjs";

export const BASIC_AWARD_FACT_SCHEMA = "awardping.basic-award-fact-review.v1";
export const BASIC_AWARD_FACT_FIELDS = Object.freeze(["overview", "opening_date", "deadline", "cycle_status", "important_dates",
  "eligibility", "citizenship", "academic_levels", "disciplines", "award_amounts", "stipend", "tuition", "travel_research_allowance", "tenure", "application_url"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const fail = reason => { throw Error(`Basic award facts: ${reason}`); };

/** Produce a complete formatter snapshot without making a complete-program review claim.
 * Omitted/unknown fields remain null/empty; never revive legacy fallback facts or
 * turn an unresolved field into a "Not published" assertion. Track labels survive.
 */
export function basicAwardFactPublicValues(review, selectedFields) {
  const selected = new Set(selectedFields);
  return programFactPublicValues({ ...review, fields: PROGRAM_FACT_FIELDS.map(field => selected.has(field)
    ? review.fields.find(row => row.field === field)
    : { field, status: "unresolved", items: [], note: "Outside this selected basic-information snapshot." }) });
}

function quotedApplicationDestination(item, documents) {
  let destination;
  try { destination = new URL(item.value); } catch { return false; }
  if (destination.protocol !== "https:" || destination.username || destination.password || destination.href !== item.value) return false;
  return item.support.some(quote => {
    const doc = documents.find(row => row.reference.source.id === quote.source_id && row.reference.capture_id === quote.capture_id);
    const block = doc?.blocks.find(row => row.id === quote.block_id);
    if (!block) return false;
    if (block.kind === "source_link") {
      if (block.context?.source_attribute !== "href" || quote.start_utf16 !== block.start_utf16 || quote.end_utf16 !== block.end_utf16) return false;
      const bases = block.context.base_hrefs;
      if (bases !== undefined && (!Array.isArray(bases) || bases.length > 1 || bases.some(base => typeof base !== "string"))) return false;
      try {
        const base = bases?.length ? new URL(bases[0], doc.reference.final_url) : new URL(doc.reference.final_url);
        return new URL(block.text, base).href === destination.href;
      } catch { return false; }
    }
    // A prose quotation must contain the complete literal destination as a URL,
    // not a convenient prefix of a longer link or a generic "Apply here" claim.
    if (quote.text !== item.value) return false;
    const before = doc.text.slice(Math.max(0, quote.start_utf16 - 1), quote.start_utf16);
    const after = doc.text.slice(quote.end_utf16, quote.end_utf16 + 1);
    return (!before || /[\s("'<]/.test(before)) && (!after || /[\s)"'>]/.test(after));
  });
}

/** Private preparation only: no database writes, approval, publication, model or
 * source-fetch calls. A server must load this exact saved draft itself and commit
 * the resulting receipt through a service-only CAS transaction that checks its
 * review ID/hash, source identities/roles/current refs and the authenticated actor.
 * This deliberately reuses the full existing cold validator with forApproval:false;
 * unresolved unrelated fields and incomplete provider inventories are not approval
 * requirements. A stale draft still needs a proper rebase before it can be reused.
 */
export async function prepareBasicAwardFactReview(draft, { selected_fields, reviewed_at }, context) {
  if (!exact(draft, ["id", "content_hash", "validation"]) || !uuid(draft.id) || !sha(draft.content_hash) ||
      !object(draft.validation) || !Array.isArray(selected_fields) || selected_fields.length < 1 ||
      selected_fields.length > BASIC_AWARD_FACT_FIELDS.length || new Set(selected_fields).size !== selected_fields.length ||
      selected_fields.some(field => !BASIC_AWARD_FACT_FIELDS.includes(field)) || !selected_fields.includes("overview") ||
      typeof reviewed_at !== "string" || !Number.isFinite(Date.parse(reviewed_at)) || new Date(reviewed_at).toISOString() !== reviewed_at) fail("invalid_selection_or_draft_identity");
  const coldCaptures = new Map();
  const loadCapture = ref => {
    const key = JSON.stringify(canonical(ref));
    if (!coldCaptures.has(key)) coldCaptures.set(key, Promise.resolve().then(() => context.loadCapture(ref)));
    return coldCaptures.get(key);
  };
  const validated = await validateProgramFactReview(draft.validation.review, { ...context, loadCapture, forApproval: false });
  if (!equal(validated, draft.validation)) fail("saved_draft_validation_changed");
  const review = validated.review;
  const fields = review.fields.filter(field => selected_fields.includes(field.field));
  if (fields.length !== selected_fields.length || fields.some(field => field.status !== "verified")) fail("selected_field_is_unresolved_or_unpublished");
  const overview = fields.find(field => field.field === "overview");
  if (overview.items.length !== 1 || overview.items[0].track !== null) fail("one_unscoped_supported_overview_required");
  for (const field of fields) for (const item of field.items) {
    if (["deadline", "opening_date"].includes(field.field)) {
      const years = new Set(item.support.flatMap(quote => quote.text.match(/\b(?:19|20)\d{2}\b/g) || []));
      if ((item.value.match(/\b(?:19|20)\d{2}\b/g) || []).some(year => !years.has(year))) fail("date_year_is_not_quoted");
    }
    if (field.field === "application_url" && !quotedApplicationDestination(item, validated.source_text)) fail("application_destination_is_not_quoted");
  }
  const currentRefs = [];
  let evidenceBytes = validated.source_text.reduce((sum, doc) => sum + Buffer.byteLength(doc.text) + Buffer.byteLength(JSON.stringify(doc.blocks)), 0);
  for (const ref of review.capture_refs) {
    const source = context.sources.find(row => row.id === ref.source.id), latest = source.text_monitoring_state.latest_ref;
    if (hasUnclearedProgramTextCollectionFailure(source, context.epoch)) fail("source_collection_quality_is_unresolved");
    if (ref.blocks_sha256 !== latest.blocks_sha256) fail("source_block_context_changed");
    if (!equal(latest, ref)) {
      const capture = await loadCapture(latest);
      validateProgramTextCapture(capture, { source });
      if (capture.completeness.status !== "complete" || !equal(programTextReference(capture), latest)) fail("current_original_is_incomplete_or_changed");
      evidenceBytes += Buffer.byteLength(capture.text) + Buffer.byteLength(JSON.stringify(capture.blocks));
      if (evidenceBytes > 32 * 1024 * 1024) fail("bounded_evidence_limit_exceeded");
    }
    currentRefs.push(latest);
  }
  // The retained draft validator verifies all raw bindings; insist on complete
  // originals explicitly too, including when there is no later observation.
  for (const doc of validated.source_text) {
    const capture = await loadCapture(doc.reference);
    validateProgramTextCapture(capture);
    if (capture.completeness.status !== "complete" || !equal(programTextReference(capture), doc.reference)) fail("supporting_original_is_incomplete_or_changed");
  }
  const receipt = { schema: BASIC_AWARD_FACT_SCHEMA, cohort_key: review.cohort_key, award_id: review.award_id,
    epoch: review.epoch, cycle: review.cycle, input_review_id: draft.id, input_review_hash: draft.content_hash,
    selected_fields: BASIC_AWARD_FACT_FIELDS.filter(field => selected_fields.includes(field)), reviewed_at,
    roster: review.roster, supporting_capture_refs: review.capture_refs, current_capture_refs: currentRefs,
    public_facts: basicAwardFactPublicValues(review, selected_fields) };
  return { receipt, content_hash: createHash("sha256").update(JSON.stringify(canonical(receipt))).digest("hex") };
}
