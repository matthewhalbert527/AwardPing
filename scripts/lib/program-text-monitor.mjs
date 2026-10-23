import { captureProgramTextSource, validateProgramTextCapture } from "./program-text-capture.mjs";
import { programTextReference, validateProgramTextReference } from "./program-text-storage.mjs";
import { buildProgramTextComparison, buildProgramTextReviewPackets, validateProgramTextReviewResult } from "./program-text-review.mjs";

export const PROGRAM_TEXT_STATE_SCHEMA = "awardping.program-text-state.v1";
export const PROGRAM_TEXT_REVIEW_WORK_SCHEMA = "awardping.program-text-review-work.v1";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
const identity = (a, b) => a?.id === b?.id && a?.shared_award_id === b?.shared_award_id && a?.url === b?.url;
const held = (reason, extra = {}) => ({ status: "held", reason, ...extra });
const errorCode = (error, fallback) => /^[a-z][a-z0-9_]{0,100}$/.test(error?.code || "") ? error.code : fallback;
function requireCallbacks(callbacks, names) {
  if (!object(callbacks) || names.some(name => typeof callbacks[name] !== "function")) throw new TypeError(`Program text monitor requires callbacks: ${names.join(", ")}`);
}
function optionsValid(source, epoch, cycle) {
  return identity(source, source) && uuid(source?.id) && uuid(source?.shared_award_id) && typeof source.url === "string" &&
    uuid(epoch) && (cycle === null || typeof cycle === "string" && cycle.trim().length > 0 && cycle.length <= 200);
}
function checkRef(ref, source) {
  validateProgramTextReference(ref);
  if (!identity(ref.source, source)) throw new Error("Source-bound text reference required");
  return ref;
}
function checkState(state, source, epoch) {
  if (!object(state)) throw new Error("Invalid text source state");
  if (!Object.keys(state).length) return state;
  if (state.schema !== PROGRAM_TEXT_STATE_SCHEMA || state.epoch !== epoch ||
      !["baseline_ready", "monitoring", "awaiting_review", "held", "error"].includes(state.status) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(state.last_checked_at || "") ||
      !Number.isFinite(Date.parse(state.last_checked_at)) || new Date(state.last_checked_at).toISOString() !== state.last_checked_at ||
      !Number.isSafeInteger(state.successful_checks) || state.successful_checks < 1 || state.successful_checks > 2147483647 ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(state.first_captured_at || "") ||
      !Number.isFinite(Date.parse(state.first_captured_at)) || new Date(state.first_captured_at).toISOString() !== state.first_captured_at) throw new Error("Invalid text source state");
  const before = checkRef(state.baseline_ref, source), latest = checkRef(state.latest_ref, source);
  if (before.final_url !== latest.final_url || before.acquisition !== latest.acquisition || !equal(before.extractor, latest.extractor) ||
      Date.parse(state.first_captured_at) > Date.parse(before.captured_at) || Date.parse(before.captured_at) > Date.parse(latest.captured_at) || Date.parse(latest.captured_at) > Date.parse(state.last_checked_at)) throw new Error("Incompatible text source state");
  return state;
}
async function readState(callbacks, source, epoch) {
  const state = await callbacks.readState(source.id);
  return checkState(state ?? {}, source, epoch);
}
async function restored(callbacks, ref, source) {
  const capture = await callbacks.loadCapture(ref);
  validateProgramTextCapture(capture, { source });
  if (!equal(programTextReference(capture), ref)) throw new Error("Restored text capture differs from immutable reference");
  return capture;
}
async function cas(callbacks, source, expected, next) {
  const result = await callbacks.compareAndSetState({ source_id: source.id, expected_state: expected, next_state: next });
  return result === true || result?.applied === true || equal(result, next);
}
function sameConfiguration(ref, current) {
  return ref.final_url === current.final_url && ref.acquisition === current.acquisition && equal(ref.extractor, current.extractor);
}

/** One source check. Callbacks own persistence/claims; this module never opens a
 * database, invokes a model, retries a write, or publishes initial coverage. */
export async function monitorProgramTextSource({ source, epoch, cycle_id = null, captureOptions = {}, packetLimits,
  callbacks } = {}) {
  requireCallbacks(callbacks, ["retain", "verifyRetention", "readState", "loadCapture", "compareAndSetState", "enqueueReview"]);
  if (!optionsValid(source, epoch, cycle_id)) return held("invalid_monitoring_identity");
  let state;
  try { state = await readState(callbacks, source, epoch); } catch { return held("source_state_invalid_or_epoch_changed"); }
  // Preserve the exact review pair. A fresh same-text observation must not make
  // an in-flight paid result stale or cause a duplicate automatic submission.
  if (["awaiting_review", "held", "error"].includes(state.status) && !equal(state.baseline_ref, state.latest_ref)) {
    return { status: state.status === "awaiting_review" ? "awaiting_review" : "held", reason: "existing_review_pair_preserved", baseline_ref: state.baseline_ref, current_ref: state.latest_ref };
  }
  let capture;
  try {
    capture = await (callbacks.capture || captureProgramTextSource)({ ...captureOptions, source });
    validateProgramTextCapture(capture, { source });
  } catch (error) { return held(errorCode(error, "capture_failed")); }
  if (capture.completeness.status !== "complete") {
    if (typeof callbacks.retainIncomplete === "function") {
      try { await callbacks.retainIncomplete(capture); } catch { return held("incomplete_capture_retention_failed", { capture_id: capture.capture_id }); }
    }
    return held("incomplete_capture", { capture_id: capture.capture_id, reasons: [...capture.completeness.reasons] });
  }
  let currentRef;
  try {
    const saved = await callbacks.retain(capture);
    currentRef = checkRef(saved?.reference || saved, source);
    if (!equal(currentRef, programTextReference(capture))) return held("retained_reference_mismatch");
    const verified = await callbacks.verifyRetention(currentRef, capture);
    validateProgramTextCapture(verified, { source });
    if (!equal(programTextReference(verified), currentRef)) return held("durable_readback_mismatch");
  } catch { return held("durable_retention_failed", { capture_id: capture.capture_id }); }
  if (!Object.keys(state).length) {
    const next = { schema: PROGRAM_TEXT_STATE_SCHEMA, epoch, status: "baseline_ready", baseline_ref: currentRef,
      latest_ref: currentRef, last_checked_at: currentRef.captured_at, first_captured_at: currentRef.captured_at, successful_checks: 1 };
    try {
      if (!await cas(callbacks, source, state, next)) return held("state_changed_before_baseline", { current_ref: currentRef });
      return { status: "baseline_ready", initial_coverage: true, creates_update: false, state: next };
    } catch { return held("baseline_state_write_failed", { current_ref: currentRef }); }
  }
  if (!sameConfiguration(state.baseline_ref, currentRef)) return held("extraction_configuration_changed", { current_ref: currentRef });
  if (Date.parse(currentRef.captured_at) <= Date.parse(state.latest_ref.captured_at) || Date.parse(currentRef.captured_at) < Date.parse(state.last_checked_at)) {
    return held("capture_order_invalid", { current_ref: currentRef });
  }
  let previous;
  try { previous = await restored(callbacks, state.baseline_ref, source); } catch { return held("baseline_original_unavailable", { current_ref: currentRef }); }
  const comparison = buildProgramTextComparison(previous, capture, { epoch, cycle_id });
  if (comparison.status === "held") return held("comparison_requires_review", { reasons: comparison.reasons, current_ref: currentRef });
  // Equal text hashes can advance without a model. Different text—even locally
  // classified reorder/noise—needs its persisted no-program-change validation.
  if (state.baseline_ref.text_sha256 === currentRef.text_sha256) {
    // Native/OCR text cannot rule out an image-only change in a new PDF. Even
    // metadata-only binary edits are held conservatively, not called an update.
    if (currentRef.acquisition.startsWith("pdf_") && state.baseline_ref.artifacts.raw.sha256 !== currentRef.artifacts.raw.sha256) {
      return held("pdf_original_changed_without_text_change", { current_ref: currentRef, creates_update: false, paid_review_required: false });
    }
    const next = { ...state, status: "baseline_ready", baseline_ref: currentRef, latest_ref: currentRef, last_checked_at: currentRef.captured_at,
      successful_checks: state.successful_checks + 1 };
    try {
      if (!await cas(callbacks, source, state, next)) return held("state_changed_before_unchanged_advance", { current_ref: currentRef });
      return { status: "unchanged", creates_update: false, state: next, comparison_id: comparison.comparison_id };
    } catch { return held("unchanged_state_write_failed", { current_ref: currentRef }); }
  }
  const packetPlan = buildProgramTextReviewPackets(comparison, packetLimits);
  if (!["ready", "unchanged"].includes(packetPlan.status)) return held("packet_plan_requires_review", { reasons: packetPlan.reasons, current_ref: currentRef });
  const work = { schema: PROGRAM_TEXT_REVIEW_WORK_SCHEMA, source: { ...capture.source }, epoch, cycle_id,
    previous_ref: state.baseline_ref, current_ref: currentRef, comparison, packet_plan: packetPlan };
  let candidate;
  try { candidate = await callbacks.enqueueReview(work); } catch { return held("review_enqueue_failed", { work }); }
  if (!uuid(candidate?.id || candidate?.candidate_id)) return held("review_enqueue_unconfirmed", { work });
  const next = { ...state, status: "awaiting_review", latest_ref: currentRef, last_checked_at: currentRef.captured_at,
    successful_checks: state.successful_checks + 1 };
  try {
    if (!await cas(callbacks, source, state, next)) return held("state_changed_after_enqueue", { candidate_id: candidate.id || candidate.candidate_id, work });
  } catch { return held("awaiting_review_state_write_failed", { candidate_id: candidate.id || candidate.candidate_id, work }); }
  return { status: "review_required", candidate_id: candidate.id || candidate.candidate_id, work, state: next,
    creates_update: false, paid_review_required: packetPlan.packets.length > 0 };
}

/** Apply a completed review only against its current immutable source pair.
 * Persist validation first so SQL can authorize a no-change baseline advance.
 * Accepted changes go solely to the transaction that publishes and advances. */
export async function finalizeProgramTextReview({ source, epoch, candidate, responses, callbacks } = {}) {
  requireCallbacks(callbacks, ["readState", "loadCapture", "recordReviewResult", "compareAndSetState", "publishProgramChange"]);
  if (!candidate || !uuid(candidate.id) || candidate.schema !== PROGRAM_TEXT_REVIEW_WORK_SCHEMA ||
      !identity(candidate.source, source) || candidate.epoch !== epoch || !optionsValid(source, epoch, candidate.cycle_id)) return held("review_identity_invalid");
  let state, previous, current;
  try {
    state = await readState(callbacks, source, epoch);
    checkRef(candidate.previous_ref, source); checkRef(candidate.current_ref, source);
    if (!equal(state.baseline_ref, candidate.previous_ref) || !equal(state.latest_ref, candidate.current_ref)) return held("review_pair_no_longer_current");
    previous = await restored(callbacks, candidate.previous_ref, source);
    current = await restored(callbacks, candidate.current_ref, source);
  } catch { return held("review_originals_or_state_invalid"); }
  const comparison = buildProgramTextComparison(previous, current, { epoch, cycle_id: candidate.cycle_id });
  if (!equal(comparison, candidate.comparison)) return held("review_comparison_changed");
  const plan = buildProgramTextReviewPackets(comparison, candidate.packet_plan?.limits);
  if (!equal(plan, candidate.packet_plan)) return held("review_packet_plan_changed");
  const validation = validateProgramTextReviewResult(comparison, plan, responses);
  let persisted;
  try { persisted = await callbacks.recordReviewResult({ candidate, validation, responses }); } catch { return held("review_result_persistence_failed"); }
  if (persisted !== true && persisted?.persisted !== true) return held("review_result_persistence_unconfirmed");
  if (validation.status === "held") return { ...held("review_result_held", { reasons: validation.reasons }), validation };
  if (validation.status === "no_program_change") {
    const next = { ...state, status: "baseline_ready", baseline_ref: candidate.current_ref, latest_ref: candidate.current_ref,
      last_checked_at: state.last_checked_at };
    try {
      if (!await cas(callbacks, source, state, next)) return held("state_changed_after_no_change_review", { validation });
    } catch { return held("no_change_state_write_failed", { validation }); }
    return { status: "no_program_change", creates_update: false, validation, state: next };
  }
  if (validation.status !== "accepted") return held("unexpected_review_validation");
  try {
    const publication = await callbacks.publishProgramChange({ source, epoch, candidate, validation, expected_state: state });
    if (publication?.published !== true || !uuid(publication.event_id)) return held("publication_unconfirmed", { validation });
    return { status: "published", event_id: publication.event_id, validation, publication };
  } catch { return held("publication_failed", { validation }); }
}
