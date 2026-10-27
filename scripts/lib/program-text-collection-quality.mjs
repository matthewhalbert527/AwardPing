import { validateProgramTextCapture } from "./program-text-capture-contract.mjs";
import { validateProgramTextReference } from "./program-text-artifacts.mjs";

export const PROGRAM_TEXT_COLLECTION_QUALITY_SCHEMA = "awardping.program-text-collection-quality.v1";
export const PROGRAM_TEXT_COLLECTION_FAILURE_REQUEST = "awardping.program-text-collection-failure-request.v1";
export const PROGRAM_TEXT_COLLECTION_FAILURE_RECEIPT = "awardping.program-text-collection-failure-receipt.v1";
export const PROGRAM_TEXT_COLLECTION_FAILURE_REASONS = Object.freeze(["capture_failed", "incomplete_capture",
  "incomplete_capture_retention_failed", "durable_retention_failed", "retained_reference_mismatch", "durable_readback_mismatch", "pdf_original_changed_without_text_change"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const fail = reason => { throw new Error(`Program text collection quality: ${reason}`); };
const identity = source => {
  if (!uuid(source?.id) || !uuid(source?.shared_award_id) || typeof source.url !== "string" || source.url.length > 10000) return false;
  try { const url = new URL(source.url); return url.href === source.url && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.port && !url.hash; } catch { return false; }
};
const reasonList = reasons => Array.isArray(reasons) && reasons.length > 0 && reasons.length <= 16 &&
  new Set(reasons).size === reasons.length && reasons.every(reason => PROGRAM_TEXT_COLLECTION_FAILURE_REASONS.includes(reason));
function summaryValid(summary) {
  return summary === null || exact(summary, ["capture_id", "captured_at", "raw_sha256", "raw_byte_length", "retained_locally", "incomplete_reason_codes"]) &&
    hex(summary.capture_id) && iso(summary.captured_at) && hex(summary.raw_sha256) && Number.isSafeInteger(summary.raw_byte_length) &&
    summary.raw_byte_length > 0 && summary.raw_byte_length <= 20 * 1024 * 1024 && typeof summary.retained_locally === "boolean" &&
    Array.isArray(summary.incomplete_reason_codes) && summary.incomplete_reason_codes.length > 0 && summary.incomplete_reason_codes.length <= 16 &&
    new Set(summary.incomplete_reason_codes).size === summary.incomplete_reason_codes.length &&
    summary.incomplete_reason_codes.every(reason => typeof reason === "string" && /^[a-z][a-z0-9_]{0,100}$/.test(reason));
}

/** An incomplete capture is an observed attempt, never a complete reference. */
export function buildProgramTextCollectionFailure({ attempt_id, source, epoch, expected_state, reason_codes, capture = null, retained_locally = false }) {
  let capture_summary = null;
  if (capture !== null) {
    validateProgramTextCapture(capture, { source });
    if (capture.completeness.status !== "incomplete") fail("summary_must_describe_incomplete_capture");
    const reasons = [...new Set(capture.completeness.reasons.filter(reason => /^[a-z][a-z0-9_]{0,100}$/.test(reason)))].slice(0, 16);
    capture_summary = { capture_id: capture.capture_id, captured_at: capture.captured_at, raw_sha256: capture.raw_source.sha256,
      raw_byte_length: capture.raw_source.byte_length, retained_locally, incomplete_reason_codes: reasons.length ? reasons : ["unclassified_incomplete_capture"] };
  }
  const request = { schema: PROGRAM_TEXT_COLLECTION_FAILURE_REQUEST, attempt_id, source_id: source.id, shared_award_id: source.shared_award_id,
    source_url: source.url, epoch, expected_state: structuredClone(expected_state), reason_codes: [...reason_codes], capture_summary };
  return validateProgramTextCollectionFailureRequest(request);
}
export function validateProgramTextCollectionFailureRequest(value) {
  if (!exact(value, ["schema", "attempt_id", "source_id", "shared_award_id", "source_url", "epoch", "expected_state", "reason_codes", "capture_summary"]) ||
      value.schema !== PROGRAM_TEXT_COLLECTION_FAILURE_REQUEST || !uuid(value.attempt_id) || !uuid(value.epoch) ||
      !identity({ id: value.source_id, shared_award_id: value.shared_award_id, url: value.source_url }) || !object(value.expected_state) ||
      Buffer.byteLength(JSON.stringify(value.expected_state)) > 128 * 1024 || !reasonList(value.reason_codes) || !summaryValid(value.capture_summary)) fail("invalid_failure_request");
  const state = value.expected_state;
  if (Object.keys(state).length && (state.schema !== "awardping.program-text-state.v1" || state.epoch !== value.epoch ||
      ["awaiting_review", "held", "error"].includes(state.status) && !equal(state.baseline_ref, state.latest_ref))) fail("existing_state_or_comparison_changed");
  return value;
}
export function validateProgramTextCollectionQuality(value, source) {
  if (!identity(source)) fail("source_identity_changed");
  if (value === null) return null;
  if (!exact(value, ["schema", "id", "source_id", "shared_award_id", "source_url", "epoch", "observed_at", "reason_codes", "expected_latest_capture_id", "capture_summary"]) ||
      value.schema !== PROGRAM_TEXT_COLLECTION_QUALITY_SCHEMA || !uuid(value.id) || value.source_id !== source.id ||
      value.shared_award_id !== source.shared_award_id || value.source_url !== source.url || !uuid(value.epoch) || !iso(value.observed_at) ||
      !reasonList(value.reason_codes) || !(value.expected_latest_capture_id === null || hex(value.expected_latest_capture_id)) ||
      !summaryValid(value.capture_summary)) fail("quality_data_missing_or_changed");
  return value;
}

/** Missing/malformed new API data fails closed. A later complete observation can
 * clear this derived hold; immutable failures and old baselines stay untouched. */
export function hasUnclearedProgramTextCollectionFailure(source, epoch) {
  if (!uuid(epoch) || !Object.hasOwn(source || {}, "text_collection_quality")) return true;
  let failure;
  try { failure = validateProgramTextCollectionQuality(source.text_collection_quality, source); } catch { return true; }
  if (failure === null || failure.epoch !== epoch) return false;
  const state = source.text_monitoring_state, latest = state?.latest_ref;
  try { validateProgramTextReference(latest); } catch { return true; }
  return state.epoch !== epoch || latest.source.id !== source.id || latest.source.shared_award_id !== source.shared_award_id || latest.source.url !== source.url ||
    latest.capture_id === failure.expected_latest_capture_id || Date.parse(latest.captured_at) <= Date.parse(failure.observed_at) ||
    !iso(state.last_checked_at) || Date.parse(state.last_checked_at) < Date.parse(latest.captured_at);
}
export function validateProgramTextCollectionFailureReceipt(value, request) {
  if (!exact(value, ["schema", "recorded", "failure"]) || value.schema !== PROGRAM_TEXT_COLLECTION_FAILURE_RECEIPT || value.recorded !== true) fail("failure_not_recorded");
  const failure = validateProgramTextCollectionQuality(value.failure, { id: request.source_id, shared_award_id: request.shared_award_id, url: request.source_url });
  if (!failure || failure.id !== request.attempt_id || failure.epoch !== request.epoch || !equal(failure.reason_codes, request.reason_codes) ||
      !equal(failure.capture_summary, request.capture_summary) || failure.expected_latest_capture_id !== (request.expected_state.latest_ref?.capture_id ?? null)) fail("failure_receipt_changed");
  return value;
}
