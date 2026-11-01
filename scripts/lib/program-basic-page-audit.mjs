import { basicAwardFactPublicValues, BASIC_AWARD_FACT_FIELDS, quotedApplicationDestination } from "./basic-award-facts.mjs";
import { PROGRAM_FACT_FIELDS, PROGRAM_FACT_REVIEW_SCHEMA } from "./program-text-facts.mjs";
import { currentBasicEqual as equal, currentBasicHash as hash, CURRENT_BASIC_RECEIPT_SCHEMA } from "./current-basic-source-proof.mjs";
import { BASIC_AWARD_FACT_SCHEMA } from "./basic-award-facts.mjs";
import { programTextReference, validateProgramTextReference } from "./program-text-artifacts.mjs";
import { validateProgramTextCapture } from "./program-text-capture-contract.mjs";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameSet = (left, right) => Array.isArray(left) && Array.isArray(right) && new Set(left).size === left.length &&
  new Set(right).size === right.length && equal([...left].sort(), [...right].sort());
const check = (condition, code) => { if (!condition) throw Error(code); };

export function requireProgramBasicPageAuditContext(context) {
  check(context?.schema === "awardping.program-basic-page-audit-context.v1" && /^[a-f0-9]{64}$/.test(context.revision || "") &&
    Number.isFinite(Date.parse(context.selected_at)) && context.basis?.schema === "awardping.program-basic-page-audit-basis.v1" &&
    uuid(context.basis.award?.id) && typeof context.basis.cohort_key === "string" &&
    Array.isArray(context.basis.published), "invalid_basic_page_audit_context");
  return context.basis;
}

/** Observation only. Replays the stored formatter selection and cold retained
 * originals; currentness comes from the exact getter used by the live website.
 * It does not re-review prose, fetch websites, decide alerts or publish details.
 */
export async function auditProgramBasicPage(context, { loadCapture }) {
  const basis = requireProgramBasicPageAuditContext(context), { snapshot, draft, published, award, cohort_key } = basis;
  const findings = []; let fieldCount = 0, valueCount = 0, captureCount = 0;
  const finding = code => { if (!findings.some(row => row.code === code)) findings.push({ code }); };
  if (!snapshot) finding("basic_details_missing");
  else {
    const current = published.length === 1 ? published[0] : null;
    if (current?.current !== true) finding("basic_details_stale_or_unavailable");
    if (!current || current.award_id !== award.id || current.cohort_key !== cohort_key || current.snapshot_id !== snapshot.id ||
        current.kind !== snapshot.kind || current.verified_at !== snapshot.receipt?.reviewed_at ||
        (current.current === true ? !equal(current.public_facts, snapshot.public_facts) : current.public_facts !== null)) finding("live_basic_getter_mismatch");
    try {
      const receipt = snapshot.receipt, review = draft?.review;
      check(uuid(snapshot.id) && snapshot.award_id === award.id && snapshot.cohort_key === cohort_key &&
        snapshot.kind === "automated_source_verified_basics", "basic_snapshot_identity_mismatch");
      check(object(receipt) && [BASIC_AWARD_FACT_SCHEMA, CURRENT_BASIC_RECEIPT_SCHEMA].includes(receipt.schema) &&
        receipt.award_id === award.id && receipt.cohort_key === cohort_key && hash(receipt) === snapshot.content_hash &&
        receipt.input_review_id === snapshot.input_review_id && receipt.input_review_hash === snapshot.input_review_hash &&
        draft?.id === snapshot.input_review_id && draft?.content_hash === snapshot.input_review_hash &&
        draft?.content_hash_valid === true, "basic_snapshot_or_saved_review_changed");
      check(review?.schema === PROGRAM_FACT_REVIEW_SCHEMA && review.award_id === award.id && review.cohort_key === cohort_key &&
        review.epoch === receipt.epoch && review.cycle === receipt.cycle && equal(review.roster, receipt.roster) &&
        sameSet(review.fields?.map(field => field?.field), PROGRAM_FACT_FIELDS), "basic_review_identity_mismatch");
      const selected = receipt.selected_fields;
      check(Array.isArray(selected) && selected.length > 0 && selected.length <= BASIC_AWARD_FACT_FIELDS.length &&
        new Set(selected).size === selected.length && selected.includes("overview") && selected.every(field => BASIC_AWARD_FACT_FIELDS.includes(field)),
      "basic_selection_invalid");
      for (const name of selected) {
        const field = review.fields.find(row => row.field === name);
        check(field?.status === "verified" && Array.isArray(field.items) && field.items.length > 0 && field.items.length <= 64,
          "published_field_is_not_verified");
        for (const item of field.items) check(typeof item.value === "string" && item.value.trim().length > 0 && item.value.length <= 2400 &&
          (item.track === null || typeof item.track === "string" && item.track.length > 0 && item.track.length <= 200) &&
          Array.isArray(item.support) && item.support.length > 0 && item.support.length <= 12, "published_value_is_unsupported");
      }
      const overview = review.fields.find(row => row.field === "overview");
      check(overview.items.length === 1 && overview.items[0].track === null, "basic_overview_is_not_shared");
      check(equal(basicAwardFactPublicValues(review, selected), snapshot.public_facts) &&
        equal(receipt.public_facts, snapshot.public_facts), "published_projection_mismatch");
      check(equal(review.capture_refs, receipt.supporting_capture_refs) && Array.isArray(receipt.current_capture_refs) &&
        sameSet(review.capture_refs.map(ref => ref.source?.id), receipt.current_capture_refs.map(ref => ref.source?.id)) &&
        review.capture_refs.length > 0 && review.capture_refs.length <= 500, "basic_retained_source_set_mismatch");
      const documents = new Map(), restored = new Map(); let evidenceBytes = 0;
      check(typeof loadCapture === "function", "retained_evidence_reader_unavailable");
      for (const ref of [...review.capture_refs, ...receipt.current_capture_refs]) {
        validateProgramTextReference(ref);
        const key = `${ref.source.id}:${ref.capture_id}`;
        if (restored.has(key)) { check(equal(programTextReference(restored.get(key)), ref), "retained_reference_conflict"); continue; }
        const capture = await loadCapture(ref);
        validateProgramTextCapture(capture);
        check(capture.completeness.status === "complete" && equal(programTextReference(capture), ref), "retained_original_changed");
        evidenceBytes += capture.raw_source.bytes.length + Buffer.byteLength(capture.text) + Buffer.byteLength(JSON.stringify(capture.blocks));
        check(evidenceBytes <= 64 * 1024 * 1024, "retained_evidence_limit_exceeded");
        restored.set(key, capture); captureCount += 1;
      }
      for (const ref of review.capture_refs) documents.set(ref.source.id, restored.get(`${ref.source.id}:${ref.capture_id}`));
      const sourceIds = [...new Set(review.roster.flatMap(role => role.source_ids || []))];
      check(sameSet(sourceIds, [...documents.keys()]), "basic_roster_source_set_mismatch");
      for (const name of selected) {
        const field = review.fields.find(row => row.field === name);
        for (const item of field.items) {
          for (const quote of item.support) {
            const capture = documents.get(quote.source_id), block = capture?.blocks.find(row => row.id === quote.block_id);
            check(capture?.capture_id === quote.capture_id && block && block.kind !== "publisher_data" &&
              block.context?.representation !== "publisher_data" && Number.isSafeInteger(quote.start_utf16) &&
              Number.isSafeInteger(quote.end_utf16) && quote.start_utf16 >= block.start_utf16 && quote.end_utf16 <= block.end_utf16 &&
              typeof quote.text === "string" && quote.text.length > 0 && quote.text.length <= 1600 &&
              quote.end_utf16 - quote.start_utf16 === quote.text.length && capture.text.slice(quote.start_utf16, quote.end_utf16) === quote.text,
            "published_quote_not_in_retained_original");
          }
          if (["deadline", "opening_date"].includes(name)) {
            const years = new Set(item.support.flatMap(quote => quote.text.match(/\b(?:19|20)\d{2}\b/g) || []));
            check(!(item.value.match(/\b(?:19|20)\d{2}\b/g) || []).some(year => !years.has(year)), "published_date_year_not_quoted");
          }
          if (name === "application_url") check(quotedApplicationDestination(item, [...documents.values()].map(capture => ({
            reference: programTextReference(capture), text: capture.text, blocks: capture.blocks,
          }))), "published_application_destination_not_quoted");
          valueCount += 1;
        }
        fieldCount += 1;
      }
    } catch (error) {
      // Stored/read failures are actionable audit failures; the retained reader
      // may contain provider messages, so expose only our bounded reason codes.
      const code = error instanceof Error && /^[a-z][a-z0-9_]{1,100}$/.test(error.message) ? error.message : "retained_evidence_validation_failed";
      finding(code);
    }
  }
  return {
    schema: "awardping.program-basic-page-audit-result.v1", award_id: award.id, cohort_key,
    snapshot_id: snapshot?.id || null, evaluation_revision: context.revision, evaluated_at: context.selected_at,
    audit_status: findings.length ? "failed" : "passed", severity: findings.length ? "error" : "none", findings,
    field_count: fieldCount, value_count: valueCount, capture_count: captureCount,
    applied_to_public: false, observation_only: true,
  };
}

export async function loadProgramBasicPageAuditAwards(supabase, { limit = 25, slugs = null } = {}) {
  const { data, error } = await supabase.rpc("list_program_basic_page_audit_awards", { p_limit: limit, p_slugs: slugs });
  if (error || data?.schema !== "awardping.program-basic-page-audit-roster.v1" || !Array.isArray(data.awards) ||
      data.awards.length > Math.min(limit, 250) || !Array.isArray(data.registered_award_ids) ||
      new Set(data.registered_award_ids).size !== data.registered_award_ids.length || !data.registered_award_ids.every(uuid)) {
    throw Error("Current basic page audit roster unavailable.");
  }
  const seen = new Set();
  for (const row of data.awards) {
    check(uuid(row?.award_id) && typeof row.cohort_key === "string" && typeof row.name === "string" && typeof row.slug === "string" &&
      data.registered_award_ids.includes(row.award_id) && !seen.has(row.award_id), "basic_audit_roster_identity_mismatch");
    seen.add(row.award_id);
  }
  return data;
}

/** Modern programs keep their own cursor. Include enough extra legacy-selector
 * rows to get past those unchanged modern cursors before applying our own bound.
 * Preserve the service selector's ordering, explicit scope and retry/backoff.
 */
export async function loadLegacyPageAuditAwards(supabase, { limit = 25, slugs = null, includeDeferred = false, registeredAwardIds = [] } = {}) {
  check(Number.isSafeInteger(limit) && limit > 0 && Array.isArray(registeredAwardIds) && registeredAwardIds.every(uuid) &&
    new Set(registeredAwardIds).size === registeredAwardIds.length && typeof includeDeferred === "boolean", "invalid_legacy_audit_scope");
  const requested = Math.min(limit, 250), excluded = new Set(registeredAwardIds);
  const overfetch = Math.min(250, requested + excluded.size);
  const { data, error } = await supabase.rpc("list_shared_awards_for_regression_audit", {
    p_limit: overfetch, p_slugs: slugs, p_include_deferred: includeDeferred,
  });
  if (error) throw new Error(`Load awards failed: ${error.message}`);
  if (!Array.isArray(data) || data.length > overfetch || data.some(row => !uuid(row?.id)) ||
      new Set(data.map(row => row.id)).size !== data.length) throw new Error("Load awards failed: selector returned an invalid bounded award array.");
  return data.filter(award => !excluded.has(award.id)).slice(0, requested);
}

/** Inspect one selected identity at a time so neither SQL nor the worker holds
 * an entire batch of expensive currentness/evidence payloads in memory. */
export async function inspectProgramBasicPageAudit(supabase, target) {
  const { data, error } = await supabase.rpc("inspect_program_basic_page_audit", { p_award_id: target.award_id });
  if (error) throw Error("Current basic page audit context unavailable.");
  const basis = requireProgramBasicPageAuditContext(data);
  check(basis.award.id === target.award_id && basis.cohort_key === target.cohort_key, "basic_audit_selected_identity_changed");
  return data;
}

export async function persistProgramBasicPageAudit(supabase, context, result) {
  requireProgramBasicPageAuditContext(context);
  const { data, error } = await supabase.rpc("record_program_basic_page_audit", {
    p_award_id: context.basis.award.id, p_expected_revision: context.revision, p_result: result,
  });
  if (error || !uuid(data?.audit_id) || typeof data.inserted !== "boolean" || data.observation_only !== true) {
    throw Error("Current basic page audit persistence was not confirmed.");
  }
  return data;
}
