import { createHash } from "node:crypto";

// Match the strictest existing publication/prompt bounds. These are complete
// packet limits, never permission to keep a prefix or to increase paid budgets.
export const legacyReviewCompletenessSchema = "awardping.legacy-eligible-text-completeness.v1";
export const legacyReviewCompletenessLimits = Object.freeze({ evidenceItems: 8, resultFacts: 12, contextChars: 12_000, packetBytes: 128_000 });
const fields = ["added_text", "removed_text", "date_changes", "amount_changes"];
const hash = value => createHash("sha256").update(value).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const values = diff => Object.fromEntries(fields.map(field => [field, diff?.[field] ?? []]));
const validValues = diff => fields.every(field => Array.isArray(diff?.[field] ?? []) && (diff?.[field] ?? []).every(value => typeof value === "string" && value.trim()));
const hold = reason => ({ allowed: false, manual_review_required: true, reason, retain_both_captures: true, baseline_advance_allowed: false, creates_api_charge: false,
  solution: "Preserve the saved captures and any completed response. Rebuild and verify the complete legacy evidence from its original bound artifacts; do not retry AI or advance the baseline automatically." });
const delegate = reason => ({ applicable: false, allowed: false, requires_existing_contract: true, reason });

export function buildLegacyReviewCompleteness({ source, previousText, currentText, diff, excludedChangedUnits }) {
  if (typeof previousText !== "string" || typeof currentText !== "string" || !validValues(diff)) return null;
  return {
    schema: legacyReviewCompletenessSchema,
    source_id: source?.id ?? null, source_url: source?.url ?? null,
    previous_text_sha256: hash(previousText), current_text_sha256: hash(currentText),
    previous_text_length: previousText.length, current_text_length: currentText.length,
    directional_counts: Object.fromEntries(fields.map(field => [field, values(diff)[field].length])),
    directional_sha256: hash(JSON.stringify(values(diff))), excluded_changed_units: excludedChangedUnits,
    // This is not proof of complete page/DOM extraction or exhaustive AI reporting.
    representation: "legacy_eligible_directional_text",
  };
}

export function visualReviewResultCompletenessDecision(result) {
  if (!result) return { allowed: true, reason: "no_response_yet" };
  const raw = object(result.raw_result) ? result.raw_result : result;
  const facts = Object.hasOwn(raw, "changed_facts") ? raw.changed_facts : raw.changed_award_facts;
  if (facts !== undefined && !Array.isArray(facts)) return hold("review_result_facts_not_an_array");
  if ((facts?.length || 0) > legacyReviewCompletenessLimits.resultFacts ||
      (Array.isArray(result.changed_facts) && result.changed_facts.length > legacyReviewCompletenessLimits.resultFacts)) return hold("review_result_facts_exceed_complete_bound");
  if (Array.isArray(facts) && Array.isArray(result.changed_facts) && facts.length !== result.changed_facts.length) return hold("review_result_facts_were_discarded");
  if (object(raw.structured_diff)) {
    for (const field of fields) {
      const entries = raw.structured_diff[field];
      if (entries !== undefined && (!Array.isArray(entries) || entries.some(value => typeof value !== "string") || entries.length > legacyReviewCompletenessLimits.evidenceItems)) return hold("review_result_evidence_exceeds_complete_bound");
    }
  }
  return { allowed: true, reason: "complete_bounded_response" };
}

export function legacyReviewCompletenessDecision({ candidate = null, source = null, diff = null, baseline = null, previous = null, capture = null, result = null, requireResult = false } = {}) {
  const response = visualReviewResultCompletenessDecision(result);
  if (!response.allowed) return response;
  if (requireResult && !result) return hold("legacy_review_completed_result_required");
  const payload = candidate?.prompt_payload;
  diff ||= candidate?.deterministic_diff || payload?.deterministic_diff || {};
  if (candidate?.candidate_scope === "initial_official_document") return delegate("requires_existing_sealed_first_document_contract");
  if (diff.candidate_scope === "scrapling_html_source") {
    // A scope/version/complete tag is NOT raw-artifact or pairing authority.
    // Callers must continue the existing concrete Scrapling/HTML validators.
    return delegate("requires_existing_scrapling_contract");
  }
  const previousHash = baseline?.text_hash || candidate?.previous_text_hash || payload?.hashes?.previous_text_hash;
  const currentHash = capture?.text_hash || candidate?.new_text_hash || payload?.hashes?.new_text_hash;
  if (sha(previousHash) && previousHash === currentHash && validValues(diff) && fields.every(field => values(diff)[field].length === 0)) return delegate("requires_existing_unchanged_text_visual_contract");
  const proof = diff.legacy_review_completeness;
  if (!object(proof) || proof.schema !== legacyReviewCompletenessSchema) return hold("legacy_review_completeness_missing");
  if (!validValues(diff)) return hold("legacy_review_evidence_invalid");
  const evidence = values(diff);
  if (!object(proof.directional_counts) || fields.some(field => proof.directional_counts[field] !== evidence[field].length) ||
      proof.directional_sha256 !== hash(JSON.stringify(evidence)) || proof.representation !== "legacy_eligible_directional_text") return hold("legacy_review_evidence_binding_mismatch");
  if (fields.some(field => evidence[field].length > legacyReviewCompletenessLimits.evidenceItems)) return hold("legacy_review_evidence_exceeds_complete_bound");
  if (!Number.isSafeInteger(proof.excluded_changed_units) || proof.excluded_changed_units !== 0) return hold("legacy_review_excluded_changed_units");
  const oldText = previous?.text ?? payload?.previous_text_excerpt;
  const newText = capture?.text ?? payload?.new_text_excerpt;
  // readBaselineEvidence reads the writer's exact `${capture.text}\n` file.
  // Retain that raw context; accept one framing LF ONLY when the immutable
  // baseline text hash proves it. No trim/whitespace normalization is allowed.
  const previousWriterFrame = typeof oldText === "string" && oldText.endsWith("\n") && sha(previousHash) && hash(oldText.slice(0, -1)) === previousHash;
  if (typeof oldText !== "string" || typeof newText !== "string" || oldText.length !== proof.previous_text_length || newText.length !== proof.current_text_length ||
      !sha(proof.previous_text_sha256) || !sha(proof.current_text_sha256) || hash(oldText) !== proof.previous_text_sha256 || hash(newText) !== proof.current_text_sha256 ||
      !sha(previousHash) || !sha(currentHash) || (previousHash !== proof.previous_text_sha256 && !previousWriterFrame) || currentHash !== proof.current_text_sha256) return hold("legacy_review_complete_context_unavailable");
  const sourceId = source?.id || candidate?.shared_award_source_id;
  const sourceUrl = source?.url || candidate?.source_url || payload?.source?.url;
  if (proof.source_id !== sourceId || proof.source_url !== sourceUrl) return hold("legacy_review_source_binding_mismatch");
  if (oldText.length - Number(previousWriterFrame) > legacyReviewCompletenessLimits.contextChars || newText.length > legacyReviewCompletenessLimits.contextChars ||
      Buffer.byteLength(JSON.stringify({ previous: oldText, current: newText, evidence, proof }), "utf8") > legacyReviewCompletenessLimits.packetBytes) return hold("legacy_review_complete_context_exceeds_bound");
  if (candidate) {
    const promptDiff = payload?.deterministic_diff;
    const promptProof = promptDiff?.legacy_review_completeness;
    const proofFields = ["schema", "source_id", "source_url", "previous_text_sha256", "current_text_sha256",
      "previous_text_length", "current_text_length", "directional_sha256", "excluded_changed_units", "representation"];
    if (!object(payload?.text_evidence) || !object(promptProof) ||
        proofFields.some(field => promptProof[field] !== proof[field]) ||
        fields.some(field => promptProof.directional_counts?.[field] !== proof.directional_counts[field] ||
          JSON.stringify(promptDiff[field] ?? []) !== JSON.stringify(evidence[field])) ||
        payload?.hashes?.previous_text_hash !== previousHash || payload?.hashes?.new_text_hash !== currentHash) return hold("legacy_review_prompt_evidence_mismatch");
  }
  if (payload?.text_evidence && fields.some(field => JSON.stringify(payload.text_evidence[field] ?? []) !== JSON.stringify(evidence[field]))) return hold("legacy_review_prompt_evidence_mismatch");
  return { allowed: true, reason: "complete_bounded_legacy_eligible_text", exhaustive_ai_reporting_verified: false };
}
