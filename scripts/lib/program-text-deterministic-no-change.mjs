import { buildProgramTextReviewPackets, validateProgramTextReviewResult } from "./program-text-review.mjs";

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const metadataKeys = new Set(["monitoring_contract", "epoch", "evidence_signature", "bucket"]);
export const PROGRAM_TEXT_UNPAID_NULL_FIELDS = Object.freeze(["model", "gemini_batch_name", "gemini_batch_request_key", "submitted_at",
  "completed_at", "published_at", "ai_result", "estimated_cost_usd", "publication_claim_token", "publication_claimed_at", "source_acquisition_id", "rejection_reason"]);

function sameProtectedEmail(previous, current) {
  if (previous.kind !== "source_link" || current.kind !== "source_link" || previous.context?.source_attribute !== "href") return false;
  const decode = text => {
    const match = /^\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]{6,512})$/u.exec(text);
    if (!match || match[1].length % 2) return null;
    const encoded = Buffer.from(match[1], "hex"), bytes = Buffer.from([...encoded.subarray(1)].map(byte => byte ^ encoded[0]));
    const address = bytes.toString("ascii"), local = address.split("@")[0];
    // Byte checks precede ASCII conversion, which otherwise discards high bits.
    return bytes.length <= 254 && local.length <= 64 && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..") &&
      bytes.every(byte => byte >= 33 && byte <= 126) &&
      /^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u.test(address) ? bytes : null;
  };
  const before = decode(previous.text), after = decode(current.text);
  return before !== null && after !== null && before.equals(after);
}
function newsletterValidation(previous, current) {
  const heading = "Donors & Supporters > Stay Connected", labels = new Set(["Company", "Phone"]);
  const label = text => /^(Company|Phone) This field is for validation purposes and should be left unchanged\.$/u.exec(text)?.[1];
  return previous.kind === "li" && current.kind === "li" && previous.heading === heading &&
    previous.context?.heading_path?.map(item => item.text).join(" > ") === heading &&
    labels.has(label(previous.text)) && labels.has(label(current.text)) && label(previous.text) !== label(current.text);
}

/** Pure rule proof, never authority to skip original/current-source verification.
 * Call only after repository.verifyCandidate; finalization cold-checks again.
 * Anything outside these complete exact patterns falls back to normal review. */
export function programTextDeterministicNoChange(row) {
  try {
    const metadata = row?.worker_metadata, comparison = row?.prompt_payload?.comparison, plan = row?.prompt_payload?.packet_plan;
    if (row?.status !== "pending" || row.candidate_scope !== "program_text_change" || !metadata ||
        Object.keys(metadata).some(key => !metadataKeys.has(key)) || PROGRAM_TEXT_UNPAID_NULL_FIELDS.some(key => row[key] != null) ||
        typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at)) || row.actual_usage != null && (!equal(row.actual_usage, {})) ||
        metadata.monitoring_contract !== "program-text-v1" || metadata.evidence_signature !== row.candidate_signature ||
        row.candidate_signature !== comparison?.comparison_id || metadata.epoch !== comparison?.context?.epoch ||
        row.shared_award_id !== comparison?.context?.award_id || row.shared_award_source_id !== comparison?.context?.source_id ||
        row.previous_snapshot_ref?.capture_id !== comparison?.previous_ref?.capture_id || row.new_snapshot_ref?.capture_id !== comparison?.current_ref?.capture_id ||
        comparison?.status !== "review_required" || !Array.isArray(comparison.changed_blocks) || !comparison.changed_blocks.length) return null;
    return proof(comparison, plan);
  } catch { return null; }
}

function proof(comparison, plan) {
  try {
    const rebuilt = buildProgramTextReviewPackets(comparison, plan?.limits);
    if (rebuilt.status !== "ready" || !equal(rebuilt, plan)) return null; // Includes comparison seal and complete packet coverage.
    const rules = [], reasons = new Map(); let text = comparison.previous_text;
    for (const block of comparison.changed_blocks) {
      const previous = block.previous, current = block.current;
      if (!previous || !current || previous.kind !== current.kind || previous.heading !== current.heading || !equal(previous.context, current.context) ||
          typeof previous.text !== "string" || !previous.text || typeof current.text !== "string" || !current.text ||
          previous.text === current.text || text.split(previous.text).length !== 2) return null;
      let rule, reason;
      if (sameProtectedEmail(previous, current)) {
        rule = "identical_protected_email_destination"; reason = "Only protected-email encoding changed; the complete decoded destination is byte-identical.";
      } else if (newsletterValidation(previous, current)) {
        rule = "newsletter_validation_label"; reason = "Only the unchanged mailing-list validation field label changed between the reviewed Company and Phone labels.";
      } else return null;
      rules.push({ block_id: block.id, rule }); reasons.set(block.id, reason); text = text.replace(previous.text, current.text);
    }
    if (text !== comparison.current_text) return null;
    const responses = plan.packets.map(packet => ({ schema: "awardping.program-text-review.v1", comparison_id: comparison.comparison_id,
      packet_id: packet.packet_id, ...comparison.context, blocks: packet.blocks.map(block => ({ id: block.id,
        disposition: "no_program_change", reason: reasons.get(block.id), changes: [] })) }));
    const validation = validateProgramTextReviewResult(comparison, plan, responses);
    if (!equal(validation, { status: "no_program_change", comparison_id: comparison.comparison_id, reasons: [], changes: [] })) return null;
    return { status: "ready", responses, validation, provenance: { schema: "awardping.deterministic-program-text-no-change.v1",
      comparison_id: comparison.comparison_id, source_id: comparison.context.source_id, epoch: comparison.context.epoch, rules,
      generated_by_gemini: false, new_provider_calls: 0, spend_mutations: 0, creates_update: false } };
  } catch { return null; }
}

/** Validate a previously stored receipt during ordinary succeeded-work resume.
 * This labels the existing result only; it never grants initial local review,
 * bypasses cold verification, or widens repository status permissions. */
export function validatedProgramTextDeterministicProvenance(candidate, validation, responses, provenance) {
  const local = proof(candidate?.comparison, candidate?.packet_plan);
  return local && candidate?.schema === "awardping.program-text-review-work.v1" &&
    candidate.source?.id === local.provenance.source_id && candidate.epoch === local.provenance.epoch &&
    candidate.source?.shared_award_id === candidate.comparison.context.award_id &&
    equal(local.validation, validation) && equal(local.responses, responses) && equal(local.provenance, provenance) ? local.provenance : null;
}
