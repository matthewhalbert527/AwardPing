import { isKnownProgramTextFooterOnlyPdfReference, validateProgramTextCapture } from "./program-text-capture-contract.mjs";
import { reviewedVisiblePdfProfile, reviewedVisiblePdfReferenceMatches } from "./program-text-reviewed-pdf.mjs";
import { programTextReference, validateProgramTextReference } from "./program-text-artifacts.mjs";

export const REVIEWED_PDF_INITIAL_POLICY = "awardping.reviewed-visible-pdf-initial-coverage.v1";
export const REVIEWED_PDF_INITIAL_REASON = "First reviewed visible-text coverage of this exact original replaces only its verified historical footer-only extraction. Preserve the original state and failures, require an independent repeat, and create no update or fact approval.";
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** An extraction repair is first coverage, never a website-change comparison.
 * The database separately verifies current authority, the admitted review and
 * the absence of any source comparison before its one journalled state CAS. */
export function reviewedPdfInitialCoverageState({ source, epoch, expected_state: state, current_ref: ref } = {}) {
  try {
    const profile = reviewedVisiblePdfProfile(source);
    if (!profile || !state || state.schema !== "awardping.program-text-state.v1" || state.epoch !== epoch ||
        state.status !== "baseline_ready" || !same(state.baseline_ref, state.latest_ref)) return null;
    validateProgramTextReference(state.baseline_ref); validateProgramTextReference(ref);
    const old = state.baseline_ref;
    if (!isKnownProgramTextFooterOnlyPdfReference(old) || !same(old.source, profile.source) ||
        old.final_url !== source.url || old.artifacts.raw.sha256 !== profile.raw.sha256 ||
        old.artifacts.raw.byte_length !== profile.raw.byte_length || !reviewedVisiblePdfReferenceMatches(ref) ||
        !Number.isFinite(Date.parse(state.last_checked_at)) || Date.parse(ref.captured_at) <= Date.parse(state.last_checked_at)) return null;
    return { schema: "awardping.program-text-state.v1", epoch, status: "baseline_ready", baseline_ref: ref, latest_ref: ref,
      last_checked_at: ref.captured_at, first_captured_at: ref.captured_at, successful_checks: 1 };
  } catch { return null; }
}

/** Cold replay happens before this document is passed to the service-only RPC. */
export function reviewedPdfInitialCoverageDocument(capture, { source_id, expected_state, next_state, current_ref } = {}) {
  validateProgramTextCapture(capture);
  const next = reviewedPdfInitialCoverageState({ source: capture.source, epoch: expected_state?.epoch, expected_state, current_ref });
  if (capture.source.id !== source_id || !next || !same(next, next_state) || !same(programTextReference(capture), current_ref)) {
    throw new Error("Reviewed PDF first coverage original or state changed");
  }
  return { reference: current_ref, text: capture.text, blocks: capture.blocks, blocks_json: JSON.stringify(canonical(capture.blocks)),
    reviewed_pdf: capture.reviewed_pdf };
}
