import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";

// Match the strictest existing publication/prompt bounds. These are complete
// packet limits, never permission to keep a prefix or to increase paid budgets.
export const legacyReviewCompletenessSchema = "awardping.legacy-eligible-text-completeness.v1";
export const legacyReviewCompletenessLimits = Object.freeze({ evidenceItems: 8, resultFacts: 12, contextChars: 12_000, packetBytes: 128_000 });
export const legacyParagraphReviewSchema = "awardping.legacy-paired-paragraph-completeness.v2";
export const legacyParagraphReviewLimits = Object.freeze({ blocks: 8, contextChars: 16_000, packetBytes: 128_000 });
const fields = ["added_text", "removed_text", "date_changes", "amount_changes"];
const hash = value => createHash("sha256").update(value).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const contrastText = value => value.replace(/\s+/g, " ").trim().toLowerCase();
const values = diff => Object.fromEntries(fields.map(field => [field, diff?.[field] ?? []]));
const validValues = diff => fields.every(field => Array.isArray(diff?.[field] ?? []) && (diff?.[field] ?? []).every(value => typeof value === "string" && value.trim()));
const hold = reason => ({ allowed: false, manual_review_required: true, reason, retain_both_captures: true, baseline_advance_allowed: false, creates_api_charge: false,
  solution: "Preserve the saved captures and any completed response. Rebuild and verify the complete legacy evidence from its original bound artifacts; do not retry AI or advance the baseline automatically." });
const delegate = reason => ({ applicable: false, allowed: false, requires_existing_contract: true, reason });

export function isLegacyParagraphReviewCandidate(candidate) {
  return (candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff)?.legacy_review_completeness?.schema === legacyParagraphReviewSchema;
}

// Keep exact offsets, separators and duplicate occurrences. This is deliberately
// a replacement-only text contract, not HTML/DOM, extraction or screenshot proof.
function paragraphRows(text) {
  const rows = [];
  let cursor = 0;
  for (const match of text.matchAll(/\r?\n(?:[ \t]*\r?\n)+/g)) {
    rows.push({ start: cursor, end: match.index, text: text.slice(cursor, match.index), separator: match[0] });
    cursor = match.index + match[0].length;
  }
  rows.push({ start: cursor, end: text.length, text: text.slice(cursor), separator: "" });
  return rows;
}

export function buildLegacyParagraphReviewDiff({ source, previousText, currentText, diff = {} } = {}) {
  if (typeof source?.id !== "string" || !source.id || typeof source?.url !== "string" || !source.url ||
      typeof previousText !== "string" || typeof currentText !== "string") return null;
  // A possible writer LF is recorded, NEVER silently normalized. The consumer
  // must prove this exact one-byte frame against the original baseline SHA.
  const writerFrame = previousText.endsWith("\n") && !currentText.endsWith("\n");
  const old = writerFrame ? previousText.slice(0, -1) : previousText;
  if (!old || !currentText || old.length > legacyParagraphReviewLimits.contextChars || currentText.length > legacyParagraphReviewLimits.contextChars) return null;
  const before = paragraphRows(old), after = paragraphRows(currentText);
  if (before.length !== after.length || before.some((row, i) => row.separator !== after[i].separator)) return null;
  const oldValues = new Set(before.map(row => row.text)), newValues = new Set(after.map(row => row.text));
  const changed = before.map((row, i) => ({ before: row, after: after[i], paragraph_index: i })).filter(pair => pair.before.text !== pair.after.text);
  if (!changed.length || changed.length > legacyParagraphReviewLimits.blocks || changed.some(pair =>
    !pair.before.text.trim() || !pair.after.text.trim() || newValues.has(pair.before.text) || oldValues.has(pair.after.text))) return null;
  let reconstructed = old;
  for (const pair of [...changed].reverse()) reconstructed = reconstructed.slice(0, pair.before.start) + pair.after.text + reconstructed.slice(pair.before.end);
  if (reconstructed !== currentText) return null;
  const evidence = { added_text: changed.map(pair => pair.after.text), removed_text: changed.map(pair => pair.before.text), date_changes: [], amount_changes: [] };
  const blocks = changed.map((pair, block_index) => ({ block_index, paragraph_index: pair.paragraph_index,
    previous_start: pair.before.start, previous_end: pair.before.end, current_start: pair.after.start, current_end: pair.after.end,
    previous_sha256: hash(pair.before.text), current_sha256: hash(pair.after.text) }));
  const proof = { schema: legacyParagraphReviewSchema, representation: "legacy_complete_paired_paragraphs",
    source_id: source.id, source_url: source.url, award_id: source.shared_award_id ?? null,
    previous_text_sha256: hash(previousText), current_text_sha256: hash(currentText),
    previous_text_length: previousText.length, current_text_length: currentText.length,
    previous_writer_frame: writerFrame, previous_capture_text_sha256: hash(old), paragraph_count: before.length,
    directional_counts: Object.fromEntries(fields.map(field => [field, evidence[field].length])), directional_sha256: hash(JSON.stringify(evidence)),
    changed_blocks: blocks, changed_blocks_sha256: hash(JSON.stringify(blocks)) };
  if (Buffer.byteLength(JSON.stringify({ previous: previousText, current: currentText, evidence, proof }), "utf8") > legacyParagraphReviewLimits.packetBytes) return null;
  return { ...diff, ...evidence, legacy_review_completeness: proof };
}

export function legacyParagraphReviewResponseSchema(base) {
  return { ...base, properties: { ...base.properties,
    changed_facts: { ...base.properties.changed_facts, items: { ...base.properties.changed_facts.items,
      properties: { ...base.properties.changed_facts.items.properties, block_index: { type: "integer" } },
      required: [...base.properties.changed_facts.items.required, "block_index"] } },
    block_reviews: { type: "array", items: { type: "object", properties: {
      block_index: { type: "integer" }, disposition: { type: "string", enum: ["applicant_change", "wording_only", "noise", "uncertain"] },
      reason: { type: "string" } }, required: ["block_index", "disposition", "reason"] } } },
    required: [...base.required, "block_reviews"] };
}

function paragraphResultDecision(result, diff) {
  if (!result) return { allowed: true, reason: "no_response_yet" };
  if (result.finish_reason !== "STOP" || result.provider_candidate_count !== 1) return hold("legacy_paragraph_review_incomplete_provider_response");
  if (!object(result.raw_result)) return hold("legacy_paragraph_review_raw_result_unavailable");
  const raw = result.raw_result;
  const blocks = diff.legacy_review_completeness.changed_blocks;
  const reviews = raw.block_reviews, facts = raw.changed_facts;
  if (!Array.isArray(reviews) || reviews.length !== blocks.length || !Array.isArray(facts) ||
      (result.block_reviews !== undefined && !equal(result.block_reviews, reviews)) ||
      result.is_true_change !== raw.is_true_change || result.is_alert_worthy !== raw.is_alert_worthy ||
      !Array.isArray(result.changed_facts) || result.changed_facts.length !== facts.length ||
      result.changed_facts.some((fact, i) => fact?.block_index !== facts[i]?.block_index)) return hold("legacy_paragraph_review_coverage_missing");
  // The compact response need not copy the input packet. Omission/null uses
  // the existing normalizer's complete deterministic fallback. Any content
  // actually supplied must agree; an empty/prefix array is not repaired.
  if ((raw.structured_diff != null && !object(raw.structured_diff)) ||
      (object(raw.structured_diff) && fields.some(field => Object.hasOwn(raw.structured_diff, field) && !equal(raw.structured_diff[field], diff[field]))) ||
      !object(result.structured_diff) || fields.some(field => !equal(result.structured_diff[field], diff[field]))) return hold("legacy_paragraph_review_result_evidence_mismatch");
  const seen = new Set();
  for (const review of reviews) {
    if (!object(review) || Object.keys(review).sort().join(",") !== "block_index,disposition,reason" ||
        !Number.isSafeInteger(review.block_index) || review.block_index < 0 || review.block_index >= blocks.length || seen.has(review.block_index) ||
        !["applicant_change", "wording_only", "noise"].includes(review.disposition) ||
        typeof review.reason !== "string" || !review.reason.trim() || review.reason.length > 320) return hold("legacy_paragraph_review_coverage_invalid_or_uncertain");
    seen.add(review.block_index);
  }
  const factCounts = new Map();
  for (const fact of facts) {
    const index = fact?.block_index;
    if (!object(fact) || Object.keys(fact).sort().join(",") !== "added_text,after,before,block_index,fact,removed_text,visual_evidence" ||
        typeof fact.fact !== "string" || !fact.fact.trim() || !Number.isSafeInteger(index) || index < 0 || index >= blocks.length ||
        reviews.find(review => review.block_index === index)?.disposition !== "applicant_change" || fact.visual_evidence !== null) return hold("legacy_paragraph_review_fact_reference_invalid");
    const previous = [fact.before, fact.removed_text].filter(value => value != null);
    const current = [fact.after, fact.added_text].filter(value => value != null);
    if (!previous.length || !current.length || previous.some(value => typeof value !== "string" || !value.trim() || !diff.removed_text[index].includes(value)) ||
        current.some(value => typeof value !== "string" || !value.trim() || !diff.added_text[index].includes(value))) return hold("legacy_paragraph_review_fact_pair_mismatch");
    // Membership in a changed paragraph is not directional change evidence.
    // Check only this paired block; repeated wording elsewhere stays distinct.
    if (previous.some(value => contrastText(diff.added_text[index]).includes(contrastText(value))) ||
        current.some(value => contrastText(diff.removed_text[index]).includes(contrastText(value)))) return hold("legacy_paragraph_review_fact_contrast_unverified");
    factCounts.set(index, (factCounts.get(index) || 0) + 1);
  }
  for (const fact of result.changed_facts) {
    const index = fact.block_index;
    const before = [fact.before, fact.removed_text].filter(value => value != null), after = [fact.after, fact.added_text].filter(value => value != null);
    if (!before.length || !after.length || before.some(value => typeof value !== "string" || !value.trim() || !diff.removed_text[index].includes(value)) ||
        after.some(value => typeof value !== "string" || !value.trim() || !diff.added_text[index].includes(value))) return hold("legacy_paragraph_review_normalized_fact_pair_mismatch");
    if (before.some(value => contrastText(diff.added_text[index]).includes(contrastText(value))) ||
        after.some(value => contrastText(diff.removed_text[index]).includes(contrastText(value)))) return hold("legacy_paragraph_review_normalized_fact_contrast_unverified");
  }
  if (reviews.some(review => review.disposition === "applicant_change" && !factCounts.has(review.block_index)) ||
      (facts.length > 0 && (raw.is_true_change !== true || raw.is_alert_worthy !== true)) ||
      (!facts.length && (raw.is_true_change !== false || raw.is_alert_worthy !== false))) return hold("legacy_paragraph_review_disposition_fact_mismatch");
  return { allowed: true, reason: "complete_paired_paragraph_dispositions", exhaustive_ai_accuracy_verified: false };
}

function paragraphCompletenessDecision({ candidate, source, diff, baseline, previous, capture, result }) {
  // Existing section candidates can promote their enclosing whole page. Do not
  // use them as chunks or mistake a complete section for complete page coverage.
  if (diff.candidate_scope && diff.candidate_scope !== "whole_page") return hold("legacy_paragraph_review_requires_whole_page_scope");
  const payload = candidate?.prompt_payload;
  const oldText = previous?.text ?? payload?.previous_text_excerpt, newText = capture?.text ?? payload?.new_text_excerpt;
  const previousHash = baseline?.text_hash || candidate?.previous_text_hash || payload?.hashes?.previous_text_hash;
  const currentHash = capture?.text_hash || candidate?.new_text_hash || payload?.hashes?.new_text_hash;
  const identity = { id: source?.id || candidate?.shared_award_source_id, url: source?.url || candidate?.source_url || payload?.source?.url,
    shared_award_id: source?.shared_award_id || candidate?.shared_award_id || payload?.source?.shared_award_id || null };
  const rebuilt = buildLegacyParagraphReviewDiff({ source: identity, previousText: oldText, currentText: newText });
  const proof = diff.legacy_review_completeness;
  if (!rebuilt || !equal(proof, rebuilt.legacy_review_completeness) ||
      fields.some(field => !equal(diff[field], rebuilt[field])) || !sha(previousHash) || !sha(currentHash) ||
      previousHash !== proof.previous_capture_text_sha256 || currentHash !== proof.current_text_sha256) return hold("legacy_paragraph_review_source_reconstruction_mismatch");
  if (candidate && (!object(payload?.text_evidence) || !equal(payload.deterministic_diff?.legacy_review_completeness, proof) ||
      candidate.shared_award_source_id !== identity.id || candidate.source_url !== identity.url || candidate.shared_award_id !== identity.shared_award_id ||
      candidate.previous_text_hash !== previousHash || candidate.new_text_hash !== currentHash ||
      payload.hashes?.previous_text_hash !== previousHash || payload.hashes?.new_text_hash !== currentHash ||
      fields.some(field => !equal(payload.deterministic_diff?.[field], diff[field]) || !equal(payload.text_evidence[field], diff[field])))) return hold("legacy_paragraph_review_prompt_binding_mismatch");
  if (payload && Buffer.byteLength(JSON.stringify(payload), "utf8") > legacyParagraphReviewLimits.packetBytes) return hold("legacy_paragraph_review_complete_prompt_exceeds_bound");
  const verdict = paragraphResultDecision(result, diff);
  return verdict.allowed ? { ...verdict, reason: result ? verdict.reason : "complete_bounded_paired_paragraph_input", exhaustive_ai_accuracy_verified: false } : verdict;
}

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
  if (diff.legacy_review_completeness?.schema === legacyParagraphReviewSchema) return paragraphCompletenessDecision({ candidate, source, diff, baseline, previous, capture, result });
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
