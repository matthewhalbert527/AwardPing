import { createHash } from "node:crypto";

export const INITIAL_OFFICIAL_DOCUMENT_SCOPE = "initial_official_document";

const acceptedAwardRelevance = new Set(["primary", "supporting"]);
const acceptedCycleRelevance = new Set(["current_or_upcoming", "evergreen"]);
const acceptedConfidence = new Set(["medium", "high"]);
const sha256Pattern = /^[a-f0-9]{64}$/;
const applicantFacingEvidencePattern =
  /\b(?:application deadline|deadline|due date|opening date|closing date|applications? (?:open|close|are open|are due|will be accepted)|competition (?:opens|closes)|apply by|submit by|eligib(?:ility|le)|requirements?|required documents?|application materials?|how to apply|application instructions?|application portal|letters? of recommendation|recommendation letters?|nomination|funding|stipend|tuition|award amount|grant amount|citizenship|gpa|transcript|essay|interview|(?:applicants?|candidates?|nominees?) (?:must|may|should|need|are required|are eligible|will be required)|(?:must|required to) (?:apply|submit|provide|include|upload|complete))\b/i;

/**
 * Builds a no-additional-API-review, one-sided candidate only from a sealed
 * acquisition review and bytes already captured by AwardPing. The caller
 * remains responsible for storing the returned attestation and candidate
 * atomically/idempotently.
 */
export function buildInitialOfficialDocumentCandidate(input = {}) {
  const acquisition = objectValue(input.acquisition);
  const review = objectValue(input.review);
  const source = objectValue(input.source);
  const capture = objectValue(input.capture);
  const reject = (reason) => ({
    eligible: false,
    reason,
    candidate_scope: INITIAL_OFFICIAL_DOCUMENT_SCOPE,
  });

  if (cleanKey(acquisition.notification_mode) !== "first_capture_candidate") {
    return reject("notification_mode_not_first_capture_candidate");
  }
  if (review.sealed !== true) return reject("review_not_sealed");
  if (cleanKey(review.status) !== "accepted") return reject("review_status_not_accepted");

  const relevance = consistentReviewValue(review, "award_relevance", "source_relevance");
  if (relevance.conflict) return reject("review_award_relevance_conflict");
  if (!acceptedAwardRelevance.has(relevance.value)) {
    return reject(relevance.value ? `award_relevance_not_accepted_${relevance.value}` : "award_relevance_missing");
  }

  const cycleRelevance = cleanKey(review.cycle_relevance);
  if (!acceptedCycleRelevance.has(cycleRelevance)) {
    return reject(
      cycleRelevance ? `cycle_relevance_not_accepted_${cycleRelevance}` : "cycle_relevance_missing",
    );
  }

  const confidence = cleanKey(review.confidence);
  if (!acceptedConfidence.has(confidence)) {
    return reject(confidence ? `confidence_not_accepted_${confidence}` : "confidence_missing");
  }

  const sourceId = cleanText(source.id);
  const awardId = cleanText(source.shared_award_id);
  const sourceUrl = validHttpUrl(source.url);
  if (!sourceId) return reject("source_id_missing");
  if (!awardId) return reject("shared_award_id_missing");
  if (!sourceUrl) return reject("source_url_invalid");
  const reviewedSourceUrl = validHttpUrl(review.capture_final_url);
  if (!reviewedSourceUrl) return reject("sealed_review_capture_final_url_invalid");
  if (reviewedSourceUrl !== sourceUrl) return reject("sealed_review_capture_final_url_mismatch");

  if (cleanKey(capture.kind) !== "pdf") return reject("initial_document_requires_pdf_capture");
  const capturedFinalUrl = validHttpUrl(capture.final_url);
  if (!capturedFinalUrl) return reject("capture_final_url_invalid");
  if (capturedFinalUrl !== reviewedSourceUrl) {
    return reject("capture_final_url_not_bound_to_sealed_review");
  }
  const capturedAt = canonicalTimestamp(capture.captured_at);
  if (!capturedAt) return reject("capture_timestamp_invalid");

  const pdfFileSha256 = cleanText(capture.file_hash).toLowerCase();
  if (!sha256Pattern.test(pdfFileSha256)) return reject("pdf_file_hash_invalid");
  const directReviewCaptureSha256 = cleanText(review.capture_file_hash).toLowerCase();
  const sealedReviewCaptureSha256 = cleanText(
    objectValue(acquisition.review_seal).capture_file_hash,
  ).toLowerCase();
  if (
    (directReviewCaptureSha256 && !sha256Pattern.test(directReviewCaptureSha256)) ||
    (sealedReviewCaptureSha256 && !sha256Pattern.test(sealedReviewCaptureSha256))
  ) {
    return reject("sealed_review_capture_file_hash_invalid");
  }
  if (
    directReviewCaptureSha256 &&
    sealedReviewCaptureSha256 &&
    directReviewCaptureSha256 !== sealedReviewCaptureSha256
  ) {
    return reject("sealed_review_capture_file_hash_conflict");
  }
  const reviewedCaptureFileSha256 = directReviewCaptureSha256 || sealedReviewCaptureSha256 || null;
  if (reviewedCaptureFileSha256 && reviewedCaptureFileSha256 !== pdfFileSha256) {
    return reject("sealed_review_capture_file_hash_mismatch");
  }
  if (cleanText(capture.pdf_text_error)) return reject("pdf_text_extraction_failed");

  const normalizedPdfText = normalizeInitialDocumentText(capture.text);
  if (!normalizedPdfText) return reject("pdf_text_missing");

  const evidenceQuotes = uniqueStrings(review.evidence_quotes).map(normalizeInitialDocumentText).filter(Boolean);
  if (!evidenceQuotes.length) return reject("evidence_quotes_missing");
  const applicantFacingQuotes = evidenceQuotes.filter((quote) => applicantFacingEvidencePattern.test(quote));
  if (!applicantFacingQuotes.length) return reject("applicant_facing_evidence_quote_missing");
  const evidenceQuote = applicantFacingQuotes.find((quote) => normalizedPdfText.includes(quote));
  if (!evidenceQuote) return reject("applicant_facing_evidence_quote_not_found_in_pdf_text");

  const suppliedSealSha256 = cleanText(review.seal_sha256).toLowerCase();
  if (suppliedSealSha256 && !sha256Pattern.test(suppliedSealSha256)) {
    return reject("review_seal_sha256_invalid");
  }

  const section = sectionForEvidence(evidenceQuote);
  const decisionBasis = {
    status: "accepted",
    sealed: true,
    award_relevance: relevance.value,
    cycle_relevance: cycleRelevance,
    confidence,
    evidence_quotes: evidenceQuotes,
    capture_file_sha256: reviewedCaptureFileSha256,
  };
  const decisionBasisSha256 = sha256(canonicalJson(decisionBasis));
  const normalizedTextSha256 = sha256(normalizedPdfText);
  const attestationBody = {
    schema_version: "awardping.first_observation.v1",
    kind: "first_observation",
    candidate_scope: INITIAL_OFFICIAL_DOCUMENT_SCOPE,
    statement:
      "This records AwardPing's first retained observation for this source; it does not assert when the publisher created or posted the document.",
    prior_evidence_state: "no_prior_baseline_supplied",
    source: {
      id: sourceId,
      shared_award_id: awardId,
      url: sourceUrl,
    },
    capture: {
      kind: "pdf",
      captured_at: capturedAt,
      final_url: capturedFinalUrl,
      file_sha256: pdfFileSha256,
      normalized_text_sha256: normalizedTextSha256,
    },
    acquisition: {
      id: cleanText(acquisition.id) || null,
      notification_mode: "first_capture_candidate",
    },
    sealed_review: {
      id: cleanText(review.id) || null,
      status: "accepted",
      seal_sha256: suppliedSealSha256 || null,
      decision_basis_sha256: decisionBasisSha256,
      capture_file_sha256: reviewedCaptureFileSha256,
      capture_final_url: reviewedSourceUrl,
    },
    applicant_evidence_quote: evidenceQuote,
  };
  const attestationJson = canonicalJson(attestationBody);
  const attestationSha256 = sha256(attestationJson);

  const deterministicDiff = {
    candidate_scope: INITIAL_OFFICIAL_DOCUMENT_SCOPE,
    candidate_change: true,
    reason: "new_official_document_first_observed",
    first_observation: true,
    added_text: [evidenceQuote],
    removed_text: [],
    date_changes: [],
    amount_changes: [],
    noise_flags: [],
    likely_section: section,
    page_type: "pdf",
    exact_before: null,
    exact_after: evidenceQuote,
    reviewed_capture_file_sha256: reviewedCaptureFileSha256,
  };
  const changedFact = {
    fact: "Applicant-facing guidance in an official document first observed by AwardPing",
    before: null,
    after: evidenceQuote,
    added_text: evidenceQuote,
    removed_text: null,
    visual_evidence: evidenceQuote,
  };
  const result = {
    candidate_scope: INITIAL_OFFICIAL_DOCUMENT_SCOPE,
    observation_kind: "first_observation",
    is_true_change: true,
    is_alert_worthy: true,
    source_relevance: relevance.value,
    source_relevance_reason: "A sealed accepted acquisition review classified this official PDF.",
    changed_facts: [changedFact],
    changed_award_facts: [changedFact],
    exact_before: null,
    exact_after: evidenceQuote,
    evidence_location: section,
    before: null,
    after: evidenceQuote,
    section,
    change_type: "new_official_document",
    confidence,
    noise_flags: [],
    rejection_reason: null,
    reader_summary: `AwardPing first observed this official document for the award. The document includes: "${evidenceQuote}"`,
    advisor_impact: "Review this first-observed official guidance before advising applicants.",
    structured_diff: deterministicDiff,
  };

  return {
    eligible: true,
    reason: "eligible_new_official_document_first_observed",
    candidate_scope: INITIAL_OFFICIAL_DOCUMENT_SCOPE,
    evidence_quote: evidenceQuote,
    reviewed_capture_file_sha256: reviewedCaptureFileSha256,
    deterministic_diff: deterministicDiff,
    result,
    first_observation_attestation: {
      kind: "first_observation",
      content_type: "application/json",
      body: attestationBody,
      canonical_json: attestationJson,
      sha256: attestationSha256,
      byte_length: Buffer.byteLength(attestationJson, "utf8"),
    },
    review_execution: {
      mode: "deterministic_from_sealed_acquisition_review",
      api_review_required: false,
      creates_api_charge: false,
    },
  };
}

export function normalizeInitialDocumentText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u0000/g, "")
    .replace(/\u00ad/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A first-observation event is detected when AwardPing recognizes the retained
 * document as a publishable update, not when the older baseline bytes happened
 * to be captured. Keep both timestamps so historical recovery remains visible
 * to current digests without misrepresenting the document's evidence age.
 */
export function initialOfficialDocumentEventTimes({ candidate = {} } = {}) {
  const prompt = objectValue(candidate.prompt_payload);
  const attestedCaptureAt = cleanText(
    prompt.first_observation_attestation?.body?.capture?.captured_at,
  );
  const canonicalAttestedCaptureAt = canonicalTimestamp(attestedCaptureAt);
  if (!canonicalAttestedCaptureAt) {
    throw new Error("Initial official document first-observation timestamp is invalid.");
  }
  const snapshotCaptureTimes = [
    candidate.new_snapshot_ref?.captured_at,
    prompt.new_snapshot_ref?.captured_at,
  ].filter((value) => cleanText(value)).map(canonicalTimestamp);
  if (
    snapshotCaptureTimes.some((value) => !value) ||
    snapshotCaptureTimes.some((value) => value !== canonicalAttestedCaptureAt)
  ) {
    throw new Error("Initial official document first-observation timestamp binding is invalid.");
  }
  const recognizedAt = cleanText(candidate.created_at);
  if (!canonicalTimestamp(recognizedAt)) {
    throw new Error("Initial official document recognition timestamp is invalid.");
  }
  return {
    detected_at: recognizedAt,
    recognized_at: recognizedAt,
    generated_at: recognizedAt,
    first_observed_at: attestedCaptureAt,
  };
}

export function initialOfficialDocumentSourceIdentityDecision({ candidate, source } = {}) {
  const storedCandidate = objectValue(candidate);
  const storedSource = objectValue(source);
  const prompt = objectValue(storedCandidate.prompt_payload);
  const attestation = objectValue(prompt.first_observation_attestation);
  const reject = (reason) => ({ allowed: false, reason });
  const attestationBytes = cleanText(attestation.canonical_json);
  let attestationBody;
  try {
    attestationBody = objectValue(JSON.parse(attestationBytes));
  } catch {
    return reject("first_observation_attestation_json_invalid");
  }
  if (
    !attestationBytes ||
    canonicalJson(attestationBody) !== attestationBytes ||
    canonicalJson(objectValue(attestation.body)) !== attestationBytes
  ) {
    return reject("first_observation_attestation_body_mismatch");
  }
  const attestedSource = objectValue(attestationBody.source);
  const attestedAcquisition = objectValue(attestationBody.acquisition);
  const attestedCapture = objectValue(attestationBody.capture);
  const attestedReview = objectValue(attestationBody.sealed_review);

  const candidateSourceId = cleanText(storedCandidate.shared_award_source_id);
  const candidateAwardId = cleanText(storedCandidate.shared_award_id);
  const candidateAcquisitionId = cleanText(storedCandidate.source_acquisition_id);
  if (
    !candidateSourceId ||
    candidateSourceId !== cleanText(storedSource.id) ||
    !candidateAwardId ||
    candidateAwardId !== cleanText(storedSource.shared_award_id) ||
    !candidateAcquisitionId
  ) {
    return reject("candidate_source_identity_mismatch");
  }

  const candidateSourceUrl = validHttpUrl(storedCandidate.source_url);
  const currentSourceUrl = validHttpUrl(storedSource.url);
  const attestedSourceUrl = validHttpUrl(attestedSource.url);
  const attestedCaptureFinalUrl = validHttpUrl(attestedCapture.final_url);
  const attestedReviewFinalUrl = validHttpUrl(attestedReview.capture_final_url);
  if (!candidateSourceUrl || !currentSourceUrl) return reject("candidate_source_url_invalid");
  if (
    cleanText(attestedSource.id) !== candidateSourceId ||
    cleanText(attestedSource.shared_award_id) !== candidateAwardId ||
    cleanText(attestedAcquisition.id) !== candidateAcquisitionId ||
    attestedSourceUrl !== candidateSourceUrl ||
    attestedCaptureFinalUrl !== candidateSourceUrl ||
    attestedReviewFinalUrl !== candidateSourceUrl
  ) {
    return reject("attested_source_acquisition_identity_mismatch");
  }

  if (currentSourceUrl === candidateSourceUrl) {
    return {
      allowed: true,
      reason: "source_url_identity_current",
      captured_source_url: candidateSourceUrl,
      current_source_url: currentSourceUrl,
      sealed_final_url: attestedCaptureFinalUrl,
      event_source_url: cleanText(storedSource.url),
    };
  }

  return {
    allowed: false,
    reason: "source_url_drift_not_acquisition_sealed",
    captured_source_url: candidateSourceUrl,
    current_source_url: currentSourceUrl,
    sealed_final_url: attestedReviewFinalUrl,
  };
}

export function initialOfficialDocumentPublicationDecision({ candidate, source, result } = {}) {
  const storedCandidate = objectValue(candidate);
  const storedSource = objectValue(source);
  const storedResult = objectValue(result);
  const prompt = objectValue(storedCandidate.prompt_payload);
  const promptAttestation = objectValue(prompt.first_observation_attestation);
  const diff = objectValue(storedCandidate.deterministic_diff);
  const execution = objectValue(storedResult.review_execution);
  const reject = (reason) => ({ allowed: false, reason });

  if (cleanKey(storedCandidate.candidate_scope) !== INITIAL_OFFICIAL_DOCUMENT_SCOPE) {
    return reject("candidate_scope_not_initial_official_document");
  }
  if (!cleanText(storedCandidate.source_acquisition_id)) {
    return reject("source_acquisition_id_missing");
  }
  const sourceIdentity = initialOfficialDocumentSourceIdentityDecision({
    candidate: storedCandidate,
    source: storedSource,
  });
  if (!sourceIdentity.allowed) return reject(sourceIdentity.reason);
  if (cleanKey(storedResult.candidate_scope) !== INITIAL_OFFICIAL_DOCUMENT_SCOPE) {
    return reject("result_scope_mismatch");
  }
  if (cleanKey(storedResult.observation_kind) !== "first_observation") {
    return reject("result_observation_kind_mismatch");
  }
  if (storedResult.is_true_change !== true || storedResult.is_alert_worthy !== true) {
    return reject("result_not_alert_worthy");
  }
  if (execution.api_review_required !== false || execution.creates_api_charge !== false) {
    return reject("zero_charge_execution_attestation_missing");
  }
  if (storedCandidate.model || storedCandidate.gemini_batch_name) {
    return reject("provider_identity_present_on_deterministic_candidate");
  }
  if (Object.keys(objectValue(storedCandidate.actual_usage)).length) {
    return reject("provider_usage_present_on_deterministic_candidate");
  }

  const fileSha256 = cleanText(storedCandidate.new_file_hash).toLowerCase();
  const attestationSha256 = cleanText(promptAttestation.sha256).toLowerCase();
  const promptHash = cleanText(objectValue(prompt.hashes).first_observation_attestation_sha256).toLowerCase();
  if (!sha256Pattern.test(fileSha256)) return reject("current_pdf_hash_invalid");
  if (!sha256Pattern.test(attestationSha256) || promptHash !== attestationSha256) {
    return reject("first_observation_attestation_hash_binding_invalid");
  }
  if (cleanText(promptAttestation.canonical_json).length === 0) {
    return reject("first_observation_attestation_bytes_missing");
  }
  if (sha256(promptAttestation.canonical_json) !== attestationSha256) {
    return reject("first_observation_attestation_hash_mismatch");
  }
  if (Number(promptAttestation.byte_length) !== Buffer.byteLength(promptAttestation.canonical_json, "utf8")) {
    return reject("first_observation_attestation_byte_length_mismatch");
  }

  const exactAfter = normalizeInitialDocumentText(storedResult.exact_after ?? storedResult.after);
  const addedText = uniqueStrings(diff.added_text).map(normalizeInitialDocumentText).filter(Boolean);
  if (!exactAfter || !addedText.includes(exactAfter)) {
    return reject("exact_added_wording_not_bound_to_deterministic_diff");
  }
  if (cleanText(storedResult.exact_before ?? storedResult.before)) {
    return reject("first_observation_must_not_claim_previous_wording");
  }

  const readerSummary = cleanText(storedResult.reader_summary);
  if (!readerSummary || !/\bfirst observed\b/i.test(readerSummary)) {
    return reject("reader_summary_missing_first_observation_language");
  }

  return {
    allowed: true,
    reason: "approved_initial_official_document",
    source_identity: sourceIdentity,
    previous_hash: attestationSha256,
    new_hash: fileSha256,
    change_details: {
      event_kind: "new_official_document",
      candidate_scope: INITIAL_OFFICIAL_DOCUMENT_SCOPE,
      observation_kind: "first_observation",
      first_observation: true,
      reader_summary: readerSummary,
      before: null,
      after: exactAfter,
      exact_before: null,
      exact_after: exactAfter,
      section: cleanText(storedResult.section) || null,
      change_type: "new_official_document",
      advisor_impact: cleanText(storedResult.advisor_impact) ||
        "Review this first-observed official guidance before advising applicants.",
      is_alert_worthy: true,
      confidence: cleanKey(storedResult.confidence) || "medium",
      structured_diff: diff,
      changed_award_facts: Array.isArray(storedResult.changed_award_facts)
        ? storedResult.changed_award_facts
        : Array.isArray(storedResult.changed_facts)
          ? storedResult.changed_facts
          : [],
      changed_facts: Array.isArray(storedResult.changed_facts)
        ? storedResult.changed_facts
        : Array.isArray(storedResult.changed_award_facts)
          ? storedResult.changed_award_facts
          : [],
      source_relevance: cleanKey(storedResult.source_relevance) || null,
      source_relevance_reason: cleanText(storedResult.source_relevance_reason) || null,
      evidence_location: cleanText(storedResult.evidence_location || storedResult.section) || null,
      source: {
        award_name: storedSource.shared_awards?.name || prompt.source?.award_name || null,
        source_title: storedSource.title || storedCandidate.source_title || null,
        source_url: sourceIdentity.event_source_url || storedSource.url || storedCandidate.source_url || null,
        page_type: storedSource.page_type || storedCandidate.source_page_type || null,
      },
      quality_flags: [
        "sealed_source_acquisition_review",
        "exact_pdf_quote_verified",
        "first_observation_not_publisher_change_date",
      ],
      candidate_signature: storedCandidate.candidate_signature || null,
      source_acquisition_id: storedCandidate.source_acquisition_id,
      monitoring_policy: prompt.monitoring_policy || null,
      monitoring_policy_bundle: prompt.monitoring_policy_bundle || null,
      generated_at: storedCandidate.new_snapshot_ref?.captured_at || storedCandidate.created_at || null,
      generation_provider: "deterministic_sealed_acquisition_review",
      generation_status: "generated",
      generation_model: null,
      public_claims_provenance: {
        source: "sealed_source_acquisition_review_and_exact_pdf_quote",
        model_narrative_published: false,
      },
    },
  };
}

function consistentReviewValue(review, primaryKey, aliasKey) {
  const primary = cleanKey(review[primaryKey]);
  const alias = cleanKey(review[aliasKey]);
  return {
    conflict: Boolean(primary && alias && primary !== alias),
    value: primary || alias,
  };
}

function sectionForEvidence(quote) {
  if (/\b(?:deadline|due date|opening date|closing date|apply by|submit by|applications? (?:open|close|are due))\b/i.test(quote)) {
    return "Deadlines and dates";
  }
  if (/\b(?:funding|stipend|tuition|award amount|grant amount)\b/i.test(quote)) return "Funding";
  if (/\b(?:eligib(?:ility|le)|citizenship|gpa)\b/i.test(quote)) return "Eligibility";
  if (/\b(?:recommendation|nomination)\b/i.test(quote)) return "Recommendations and nominations";
  if (/\b(?:requirements?|required documents?|application materials?|transcript|essay)\b/i.test(quote)) {
    return "Application requirements";
  }
  return "How to apply";
}

function uniqueStrings(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const seen = new Set();
  const result = [];
  for (const item of values) {
    const text = cleanText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function validHttpUrl(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return raw;
  } catch {
    return null;
  }
}

function canonicalTimestamp(value) {
  const parsed = Date.parse(cleanText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]+/g, "")
    .replace(/^_+|_+$/g, "");
}

function cleanText(value) {
  return String(value || "").trim();
}
