import crypto from "node:crypto";
import {
  isDeterministicVisualArtifactError,
  VISUAL_EVENT_EVIDENCE_SCHEMA_VERSION,
} from "./visual-event-evidence.mjs";
import { requiredChangeEventLocalizationSides } from "./snapshot-localization.mjs";
import { verifyVisualEventSemanticBindings } from "./visual-event-localization.mjs";
import { visualHashFromCandidate } from "./visual-review-queue.mjs";

export const LEGACY_VISUAL_EVIDENCE_CANDIDATE_CUTOFF = "2026-07-15T20:15:00.000Z";

export function requiresLegacyVisualEvidenceBackfill(candidate = {}) {
  const createdAt = Date.parse(cleanText(candidate.created_at));
  if (
    cleanText(candidate.status) !== "published" ||
    !Number.isFinite(createdAt) ||
    createdAt >= Date.parse(LEGACY_VISUAL_EVIDENCE_CANDIDATE_CUTOFF)
  ) {
    return false;
  }
  const previous = objectValue(candidate.previous_snapshot_ref);
  const current = objectValue(candidate.new_snapshot_ref);
  const prompt = objectValue(candidate.prompt_payload);
  const promptPrevious = objectValue(prompt.previous_snapshot_ref);
  const promptCurrent = objectValue(prompt.new_snapshot_ref);
  const hashes = objectValue(prompt.hashes);
  return [
    previous.artifact_manifest,
    current.artifact_manifest,
    promptPrevious.artifact_manifest,
    promptCurrent.artifact_manifest,
  ].every((manifest) => !Object.keys(objectValue(manifest)).length) &&
    !cleanText(previous.artifact_manifest_digest) &&
    !cleanText(current.artifact_manifest_digest) &&
    !cleanText(promptPrevious.artifact_manifest_digest) &&
    !cleanText(promptCurrent.artifact_manifest_digest) &&
    !cleanText(hashes.previous_artifact_manifest_digest) &&
    !cleanText(hashes.new_artifact_manifest_digest);
}

export function isSnapshottedLegacyVisualEvidenceBackfill({
  event = {},
  candidate = {},
  resolutionMethods = [],
  eligibility = null,
} = {}) {
  const methods = new Set(Array.isArray(resolutionMethods) ? resolutionMethods : []);
  return requiresLegacyVisualEvidenceBackfill(candidate) &&
    methods.has("candidate_signature") &&
    methods.has("reverse_worker_metadata") &&
    cleanText(eligibility?.change_event_id) === cleanText(event.id) &&
    cleanText(eligibility?.visual_review_candidate_id) === cleanText(candidate.id) &&
    cleanText(eligibility?.candidate_signature) === cleanText(candidate.candidate_signature);
}

export function candidateSignatureFromEvent(event = {}) {
  return cleanText(objectValue(event.change_details).candidate_signature) || null;
}

export function parseHistoricalTerminalLossConfirmations(value) {
  if (!Array.isArray(value)) {
    throw new Error("Terminal-loss confirmations must be a JSON array.");
  }
  const confirmations = new Map();
  for (const [index, raw] of value.entries()) {
    const entry = objectValue(raw);
    const confirmation = {
      event_id: cleanText(entry.event_id),
      resolution_reason_code: cleanText(entry.resolution_reason_code),
      reason: cleanText(entry.reason),
      actor: cleanText(entry.actor),
      confirmed_at: cleanText(entry.confirmed_at),
    };
    if (
      !confirmation.event_id ||
      !confirmation.resolution_reason_code ||
      !confirmation.reason ||
      !confirmation.actor ||
      !confirmation.confirmed_at ||
      !Number.isFinite(Date.parse(confirmation.confirmed_at))
    ) {
      throw new Error(
        `Terminal-loss confirmation ${index + 1} requires event_id, resolution_reason_code, reason, actor, and an ISO confirmed_at timestamp.`,
      );
    }
    if (confirmations.has(confirmation.event_id)) {
      throw new Error(`Terminal-loss confirmations contain duplicate event_id ${confirmation.event_id}.`);
    }
    confirmations.set(confirmation.event_id, confirmation);
  }
  return confirmations;
}

export function matchHistoricalTerminalLossConfirmation({ confirmation, currentReasonCode } = {}) {
  if (!confirmation) return { accepted: false, confirmation: null };
  const reasonCode = cleanText(currentReasonCode);
  if (confirmation.resolution_reason_code !== reasonCode) {
    return {
      accepted: false,
      confirmation: null,
      reason_code: "terminal_loss_confirmation_reason_mismatch",
      reason:
        `The terminal-loss confirmation expected ${confirmation.resolution_reason_code}, ` +
        `but the current backfill classification reports ${reasonCode || "unknown"}; ` +
        "re-review before confirming loss.",
    };
  }
  return { accepted: true, confirmation };
}

export function historicalBackfillRepairPlan(reasonCode) {
  const code = cleanText(reasonCode).toLowerCase();
  if (!code) {
    return {
      category: "operator_review",
      solution: "Inspect the retained event evidence and record an explicit operator decision before retrying the idempotent backfill.",
    };
  }
  if (code.includes("dependency") || code.includes("rpc") || code.includes("r2")) {
    return {
      category: "dependency_repair_idempotent_retry",
      solution: "Repair the reported database or R2 dependency, then resume the same idempotent backfill from its last successful event.",
    };
  }
  if (code === "terminal_loss_confirmation_reason_mismatch") {
    return {
      category: "stale_terminal_loss_confirmation",
      solution: "Rerun the dry-run, investigate the current reason code, and replace the confirmation only after a named operator verifies terminal loss for that exact event.",
    };
  }
  if (
    code.includes("hash_mismatch") ||
    code.includes("identity_mismatch") ||
    code.startsWith("contradictory_") ||
    code === "candidate_visual_identity_missing"
  ) {
    return {
      category: "quarantine_identity_conflict",
      solution: "Quarantine this event/candidate pair for operator review; do not relink it automatically or substitute a different retained artifact.",
    };
  }
  if (
    code.includes("ambiguous") ||
    code === "missing_candidate_binding" ||
    code === "missing_direct_candidate" ||
    code === "missing_candidate_signature"
  ) {
    return {
      category: "explicit_operator_linkage",
      solution: "Require an explicit operator linkage using a direct candidate ID, exact unique signature, or reverse event binding; do not infer a candidate from ordering or current pointers.",
    };
  }
  if (code.includes("geometry")) {
    return {
      category: "preserve_full_mark_geometry_unavailable",
      solution: "Preserve the immutable full evidence and mark crop geometry unavailable; do not manufacture replacement rectangles.",
    };
  }
  if (
    code.includes("artifact") ||
    code.includes("image_missing") ||
    code.includes("side_artifact_missing")
  ) {
    return {
      category: "preserve_survivors_mark_unavailable",
      solution: "Preserve every independently verified immutable survivor, mark missing sides unavailable, and do not reconstruct or combine unverified historical artifacts.",
    };
  }
  return {
    category: "operator_review",
    solution: "Inspect the exact event, candidate, and immutable artifact identities; record a safe operator decision before retrying the idempotent backfill.",
  };
}

export async function executeHistoricalBackfillStep({
  createEvidence,
  recoverDeterministicFailure,
  publishEvidence = null,
  advance,
} = {}) {
  let result;
  try {
    result = await createEvidence();
  } catch (error) {
    if (!isDeterministicVisualArtifactError(error)) throw error;
    result = await recoverDeterministicFailure(error);
  }
  if (result?.retryable === true || result?.publishable === false) {
    return {
      ...result,
      evidence: null,
      publication: null,
      advanced: false,
    };
  }
  if (!result?.evidence) {
    throw new Error("Historical backfill step did not produce an evidence payload.");
  }
  const publication = publishEvidence ? await publishEvidence(result.evidence) : null;
  await advance();
  return { ...result, publication, advanced: true };
}

export function resolveHistoricalEventCandidate({
  event = {},
  directCandidates = [],
  signatureCandidates = [],
  reverseCandidates = [],
} = {}) {
  const bindings = [];
  const directId = cleanText(event.visual_review_candidate_id);
  const eventSignature = candidateSignatureFromEvent(event);

  if (directId) {
    const matches = uniqueCandidates(directCandidates.filter((candidate) => candidate?.id === directId));
    if (matches.length !== 1) {
      return unresolved(
        matches.length ? "ambiguous_direct_candidate" : "missing_direct_candidate",
        "The event's direct visual-review candidate binding is missing or ambiguous.",
      );
    }
    bindings.push({ method: "direct_fk", candidate: matches[0] });
  }

  if (eventSignature) {
    const matches = uniqueCandidates(signatureCandidates.filter(
      (candidate) => candidate?.candidate_signature === eventSignature,
    ));
    if (matches.length !== 1) {
      return unresolved(
        matches.length ? "ambiguous_candidate_signature" : "missing_candidate_signature",
        "The event's exact candidate signature does not resolve uniquely.",
      );
    }
    bindings.push({ method: "candidate_signature", candidate: matches[0] });
  }

  const reverseMatches = uniqueCandidates(reverseCandidates.filter(
    (candidate) => cleanText(objectValue(candidate?.worker_metadata).change_event_id) === event.id,
  ));
  if (reverseMatches.length > 1) {
    return unresolved(
      "ambiguous_reverse_event_binding",
      "More than one visual-review candidate claims this event ID.",
    );
  }
  if (reverseMatches.length === 1) {
    bindings.push({ method: "reverse_worker_metadata", candidate: reverseMatches[0] });
  }

  if (!bindings.length) {
    return unresolved(
      "missing_candidate_binding",
      "No direct candidate, exact candidate signature, or reverse event binding survives.",
    );
  }

  const candidates = uniqueCandidates(bindings.map((binding) => binding.candidate));
  if (candidates.length !== 1) {
    return unresolved(
      "contradictory_candidate_bindings",
      "The surviving candidate bindings point to different candidates.",
    );
  }

  const candidate = candidates[0];
  const reverseEventId = cleanText(objectValue(candidate.worker_metadata).change_event_id);
  if (reverseEventId && reverseEventId !== event.id) {
    return unresolved(
      "contradictory_reverse_event_binding",
      "The candidate is already bound to a different change event.",
    );
  }
  if (directId && candidate.id !== directId) {
    return unresolved("contradictory_direct_candidate", "The direct candidate ID conflicts with another binding.");
  }
  if (eventSignature && candidate.candidate_signature !== eventSignature) {
    return unresolved(
      "contradictory_candidate_signature",
      "The event candidate signature conflicts with the resolved candidate.",
    );
  }
  if (candidate.shared_award_id !== event.shared_award_id) {
    return unresolved("award_identity_mismatch", "The candidate and event award identities do not match.");
  }
  if (
    !cleanText(event.shared_award_source_id) ||
    candidate.shared_award_source_id !== event.shared_award_source_id
  ) {
    return unresolved("source_identity_mismatch", "The candidate and event source identities do not match.");
  }

  const previousHash = visualHashFromCandidate(candidate, "previous");
  const newHash = visualHashFromCandidate(candidate, "new");
  if (!previousHash || !newHash) {
    return unresolved(
      "candidate_visual_identity_missing",
      "The candidate does not retain both visual identities required by the event.",
    );
  }
  if (previousHash !== cleanText(event.previous_hash) || newHash !== cleanText(event.new_hash)) {
    return unresolved(
      "event_visual_identity_mismatch",
      "The candidate's previous/current visual identities do not match the event.",
    );
  }

  return {
    resolved: true,
    candidate,
    methods: [...new Set(bindings.map((binding) => binding.method))],
    previous_hash: previousHash,
    new_hash: newHash,
  };
}

export function normalizePreparedHistoricalEvidence({ event = {}, candidate, evidence } = {}) {
  const value = objectValue(evidence);
  const pdfSides = ["previous", "current"].filter((side) => {
    const capture = objectValue(value[`${side}_capture`]);
    const full = objectValue(capture.full);
    return cleanText(capture.kind) === "pdf" ||
      cleanText(full.content_type).toLowerCase().includes("pdf");
  });
  if (pdfSides.length) {
    const retainedPdfSides = ["previous", "current"].filter(
      (side) => validHistoricalPdfCapture(value[`${side}_capture`]),
    );
    if (!retainedPdfSides.length) {
      const reason = "Neither historical PDF side retains an immutable document, matching metadata, and candidate-bound file-hash identity.";
      return {
        recoverable: false,
        reason_code: "historical_pdf_artifact_incomplete",
        reason,
        evidence: null,
        terminal_evidence_input: { event, candidate, reason },
      };
    }
    if (retainedPdfSides.length === 1) {
      const retainedSide = retainedPdfSides[0];
      const missingSide = retainedSide === "previous" ? "current" : "previous";
      const reason = `The ${missingSide} historical PDF document or its matching metadata/file-hash identity is unavailable; the ${retainedSide} document remains immutable.`;
      return partialHistoricalEvidence({
        event,
        candidate,
        evidence: value,
        retainedSide,
        missingSide,
        reason,
        reasonCode: "historical_pdf_side_artifact_missing",
      });
    }
  }

  const retainedSides = ["previous", "current"].filter((side) => {
    const capture = objectValue(value[`${side}_capture`]);
    return validArtifact(objectValue(capture.full)) && validArtifact(objectValue(capture.metadata));
  });
  if (!retainedSides.length) {
    const reason = "Neither historical side retains a verifiable full artifact with its matching metadata.";
    return {
      recoverable: false,
      reason_code: "historical_artifacts_unrecoverable",
      reason,
      evidence: null,
      terminal_evidence_input: { event, candidate, reason },
    };
  }

  const localization = objectValue(value.localization);
  const sides = objectValue(localization.sides);
  if (retainedSides.length === 1) {
    const retainedSide = retainedSides[0];
    const missingSide = retainedSide === "previous" ? "current" : "previous";
    const reason = `The ${missingSide} historical full artifact or its matching metadata is unavailable; the ${retainedSide} side remains immutable.`;
    return partialHistoricalEvidence({
      event,
      candidate,
      evidence: value,
      retainedSide,
      missingSide,
      reason,
      reasonCode: "historical_side_artifact_missing",
    });
  }

  let geometryMissing = false;
  const normalizedSides = {};
  for (const side of ["previous", "current"]) {
    const localized = objectValue(sides[side]);
    const status = cleanText(localized.status);
    const missingGeometry = status.includes("geometry") || status.includes("image_state");
    geometryMissing ||= missingGeometry;
    normalizedSides[side] = missingGeometry
      ? {
          ...localized,
          status: "unavailable_geometry_missing",
          exact_overlap: false,
          reason: "The immutable historical full screenshot survives, but its bound legacy geometry does not.",
        }
      : localized;
  }

  const normalized = {
    ...value,
    change_event_id: event.id,
    shared_award_id: event.shared_award_id,
    shared_award_source_id: event.shared_award_source_id,
    visual_review_candidate_id: candidate.id,
    candidate_signature: candidate.candidate_signature,
    evidence_status: geometryMissing && value.evidence_status !== "verified"
      ? "unavailable_geometry_missing"
      : value.evidence_status,
    localization: {
      ...localization,
      sides: normalizedSides,
    },
    evidence_schema_version: cleanText(value.evidence_schema_version) ||
      VISUAL_EVENT_EVIDENCE_SCHEMA_VERSION,
  };
  if (normalized.evidence_status !== "verified") normalized.verified_at = null;
  const legacyVerifiedCrop = normalized.evidence_status === "verified" &&
    normalized.evidence_schema_version !== VISUAL_EVENT_EVIDENCE_SCHEMA_VERSION;
  if (normalized.evidence_status === "verified" && (
    legacyVerifiedCrop || !completeVerifiedHistoricalEvidence(normalized, event)
  )) {
    normalized.evidence_status = "full_screenshot_fallback";
    normalized.verified_at = null;
    const normalizedLocalization = objectValue(normalized.localization);
    const normalizedLocalizationSides = objectValue(normalizedLocalization.sides);
    for (const side of ["previous", "current"]) {
      normalized[`${side}_capture`] = {
        ...objectValue(normalized[`${side}_capture`]),
        crop: null,
      };
      const localized = objectValue(normalizedLocalizationSides[side]);
      if (localized.status === "verified") {
        normalizedLocalizationSides[side] = {
          ...localized,
          status: "full_screenshot_fallback",
          exact_overlap: false,
          reason: legacyVerifiedCrop
            ? "The full screenshot survives, but this v1 crop predates event-semantic exact-wording verification."
            : "The full screenshot survives, but the retained capture lacks complete v2 semantic/state/hash identity for a verified crop.",
        };
      }
    }
    normalized.localization = {
      ...normalizedLocalization,
      sides: normalizedLocalizationSides,
    };
  }

  return { recoverable: true, evidence: normalized };
}

function partialHistoricalEvidence({
  event,
  candidate,
  evidence,
  retainedSide,
  missingSide,
  reason,
  reasonCode,
}) {
  const value = objectValue(evidence);
  const localization = objectValue(value.localization);
  const sides = objectValue(localization.sides);
  return {
    recoverable: true,
    partial: true,
    reason_code: reasonCode,
    reason,
    retained_side: retainedSide,
    evidence: {
      ...value,
      change_event_id: event.id,
      shared_award_id: event.shared_award_id,
      shared_award_source_id: event.shared_award_source_id,
      visual_review_candidate_id: candidate.id,
      candidate_signature: candidate.candidate_signature,
      evidence_status: "unavailable_image_missing",
      [`${missingSide}_capture`]: {},
      localization: {
        ...localization,
        sides: {
          ...sides,
          [missingSide]: {
            ...objectValue(sides[missingSide]),
            status: "unavailable_image_missing",
            exact_overlap: false,
            reason,
          },
        },
      },
      evidence_schema_version: cleanText(value.evidence_schema_version) ||
        VISUAL_EVENT_EVIDENCE_SCHEMA_VERSION,
      verified_at: null,
    },
  };
}

function validHistoricalPdfCapture(value) {
  const capture = objectValue(value);
  const full = objectValue(capture.full);
  const metadata = objectValue(capture.metadata);
  const fileHash = cleanText(objectValue(capture.capture_hashes).file_hash);
  return cleanText(capture.kind) === "pdf" &&
    validArtifact(full) &&
    validArtifact(metadata) &&
    cleanText(full.content_type).toLowerCase().startsWith("application/pdf") &&
    cleanText(metadata.content_type).toLowerCase().startsWith("application/json") &&
    /^[a-f0-9]{64}$/.test(fileHash) &&
    cleanText(full.sha256) === fileHash;
}

export function historicalArtifactUnrecoverableEvidence({
  event = {},
  candidate = null,
  reason,
  terminalArtifactLossConfirmed = false,
  terminalArtifactLossConfirmation = null,
} = {}) {
  if (terminalArtifactLossConfirmed !== true) {
    throw new Error(
      "Unrecoverable evidence requires an explicit terminal artifact-loss confirmation.",
    );
  }
  const safeReason = cleanText(reason) ||
    "No candidate-bound immutable visual artifact can be recovered for this historical event.";
  const requiredSides = requiredChangeEventLocalizationSides(event);
  const direction = requiredSides.length === 2
    ? "mixed"
    : requiredSides[0] === "previous"
      ? "removed"
      : requiredSides[0] === "current"
        ? "added"
        : "changed";
  const side = (name) => ({
    status: "historical_artifact_unrecoverable",
    required: requiredSides.includes(name),
    exact_text: null,
    matched_rects: [],
    crop_rect: null,
    exact_overlap: false,
    reason: safeReason,
    algorithm_version: null,
    state_id: null,
  });

  return {
    change_event_id: event.id || null,
    shared_award_id: event.shared_award_id || null,
    shared_award_source_id: event.shared_award_source_id || null,
    visual_review_candidate_id: candidate?.id || null,
    candidate_signature: candidate?.candidate_signature || null,
    bucket: null,
    evidence_status: "historical_artifact_unrecoverable",
    previous_capture: {},
    current_capture: {},
    localization: {
      direction,
      terminal_artifact_loss_confirmed: true,
      terminal_artifact_loss_reason: safeReason,
      terminal_artifact_loss_actor:
        cleanText(terminalArtifactLossConfirmation?.actor) || null,
      terminal_artifact_loss_confirmed_at:
        cleanText(terminalArtifactLossConfirmation?.confirmed_at) || null,
      terminal_artifact_loss_resolution_reason_code:
        cleanText(terminalArtifactLossConfirmation?.resolution_reason_code) || null,
      sides: {
        previous: side("previous"),
        current: side("current"),
      },
    },
    evidence_schema_version: VISUAL_EVENT_EVIDENCE_SCHEMA_VERSION,
  };
}

export function backfillEvidenceRpcPayload(evidence = {}) {
  const value = objectValue(evidence);
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !["created_at", "verified_at", "backfilled_at"].includes(key),
  ));
}

export function createDryRunPublishedArtifactStore(bucket = "awardping-snapshots") {
  const artifacts = new Map();
  return {
    bucket,
    writes: artifacts,
    async put({ key, body, contentType, sha256 }) {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const actual = crypto.createHash("sha256").update(bytes).digest("hex");
      if (actual !== sha256) throw new Error(`Dry-run artifact SHA mismatch for ${key}.`);
      artifacts.set(key, {
        byte_length: bytes.length,
        content_type: contentType,
        sha256,
      });
    },
    async head({ key }) {
      const value = artifacts.get(key);
      if (!value) throw new Error(`Dry-run artifact was not prepared: ${key}.`);
      return value;
    },
    destroy() {},
  };
}

export function createImmutablePublishedArtifactStore(baseStore) {
  return {
    bucket: baseStore.bucket,
    async put(args) {
      try {
        const existing = await baseStore.head({ key: args.key });
        const byteLength = Buffer.isBuffer(args.body)
          ? args.body.length
          : Buffer.byteLength(args.body);
        if (
          Number(existing?.byte_length) === byteLength &&
          cleanText(existing?.sha256).toLowerCase() === cleanText(args.sha256).toLowerCase()
        ) {
          return;
        }
        throw new Error(`Immutable published artifact conflict for ${args.key}.`);
      } catch (error) {
        if (!isMissingObjectError(error)) throw error;
      }
      await baseStore.put(args);
    },
    head: (args) => baseStore.head(args),
    destroy: () => baseStore.destroy?.(),
  };
}

export function isMissingObjectError(error) {
  const status = Number(error?.$metadata?.httpStatusCode || 0);
  const name = cleanText(error?.name || error?.Code || error?.code);
  return status === 404 || ["NotFound", "NoSuchKey", "NoSuchObject"].includes(name);
}

function unresolved(reasonCode, reason) {
  return { resolved: false, reason_code: reasonCode, reason };
}

function uniqueCandidates(values) {
  return [...new Map(values.filter((value) => value?.id).map((value) => [value.id, value])).values()];
}

function validArtifact(value) {
  const objectKey = cleanText(value.object_key);
  const sha256 = cleanText(value.sha256);
  return Boolean(
    objectKey.startsWith("visual-snapshots/published/") &&
    /^[a-f0-9]{64}$/.test(sha256) &&
    positiveInteger(value.byte_length) &&
    cleanText(value.content_type),
  );
}

function completeVerifiedHistoricalEvidence(evidence, event) {
  const localization = objectValue(evidence.localization);
  const sides = objectValue(localization.sides);
  for (const side of ["previous", "current"]) {
    const capture = objectValue(evidence[`${side}_capture`]);
    const full = objectValue(capture.full);
    const metadata = objectValue(capture.metadata);
    const hashes = objectValue(capture.capture_hashes);
    if (
      !validArtifact(full) ||
      !validArtifact(metadata) ||
      !cleanText(capture.captured_at) ||
      !cleanText(capture.state_id) ||
      !/^[a-f0-9]{64}$/.test(cleanText(hashes.image_hash)) ||
      !/^[a-f0-9]{64}$/.test(cleanText(hashes.text_hash)) ||
      !positiveInteger(full.width) ||
      !positiveInteger(full.height) ||
      !cleanText(full.content_type).toLowerCase().startsWith("image/") ||
      !cleanText(metadata.content_type).toLowerCase().startsWith("application/json")
    ) {
      return false;
    }
  }

  const exactSide = (side) => {
    const capture = objectValue(evidence[`${side}_capture`]);
    const full = objectValue(capture.full);
    const crop = objectValue(capture.crop);
    const clip = objectValue(crop.clip);
    const layout = objectValue(capture.layout);
    const localized = objectValue(sides[side]);
    const cropRect = objectValue(localized.crop_rect);
    const cropRectPixels = objectValue(localized.crop_rect_pixels);
    const matchedRects = arrayValue(localized.matched_rects);
    const stateId = cleanText(capture.state_id);
    const selectedState = arrayValue(capture.states).find((rawState) => {
      const state = objectValue(rawState);
      const image = objectValue(state.image);
      const geometry = objectValue(state.geometry);
      return cleanText(state.state_id) === stateId &&
        validArtifact(image) &&
        validArtifact(geometry) &&
        cleanText(image.content_type).toLowerCase().startsWith("image/") &&
        cleanText(geometry.content_type).toLowerCase().startsWith("application/json") &&
        cleanText(image.object_key) === cleanText(full.object_key) &&
        cleanText(image.sha256) === cleanText(full.sha256) &&
        Number(image.byte_length) === Number(full.byte_length) &&
        cleanText(geometry.object_key) === cleanText(layout.object_key) &&
        cleanText(state.geometry_hash) === cleanText(layout.geometry_hash);
    });
    return validArtifact(crop) &&
      validArtifact(layout) &&
      cleanText(crop.content_type).toLowerCase().startsWith("image/") &&
      cleanText(layout.content_type).toLowerCase().startsWith("application/json") &&
      crop.exact_overlap === true &&
      positiveInteger(crop.width) &&
      positiveInteger(crop.height) &&
      nonNegativeInteger(clip.x) &&
      nonNegativeInteger(clip.y) &&
      Number(clip.width) === Number(crop.width) &&
      Number(clip.height) === Number(crop.height) &&
      Number(clip.x) + Number(clip.width) <= Number(full.width) &&
      Number(clip.y) + Number(clip.height) <= Number(full.height) &&
      sameRect(clip, cropRectPixels) &&
      sameRect(objectValue(crop.css_clip), cropRect) &&
      cleanText(crop.state_id) === stateId &&
      cleanText(crop.source_image_object_key) === cleanText(full.object_key) &&
      cleanText(crop.source_image_sha256) === cleanText(full.sha256) &&
      Number(crop.source_image_byte_length) === Number(full.byte_length) &&
      cleanText(layout.state_id) === stateId &&
      /^[a-f0-9]{64}$/.test(cleanText(layout.geometry_hash)) &&
      Boolean(selectedState) &&
      localized.status === "verified" &&
      localized.exact_overlap === true &&
      cleanText(localized.exact_text) &&
      matchedRects.length > 0 &&
      matchedRects.every((rect) => rectanglesOverlap(rect, cropRect)) &&
      Object.keys(cropRect).length > 0 &&
      Object.keys(cropRectPixels).length > 0 &&
      cleanText(localized.algorithm_version) === "3" &&
      cleanText(localized.state_id) === stateId;
  };
  const exact = {
    previous: exactSide("previous"),
    current: exactSide("current"),
  };
  if (["previous", "current"].some(
    (side) => objectValue(sides[side]).status === "verified" && !exact[side],
  )) {
    return false;
  }
  const directionValid = localization.direction === "added"
    ? Boolean(exact.current)
    : localization.direction === "removed"
      ? Boolean(exact.previous)
      : localization.direction === "changed" || localization.direction === "mixed"
        ? Boolean(exact.previous && exact.current)
        : false;
  if (!directionValid || evidence.evidence_schema_version !== VISUAL_EVENT_EVIDENCE_SCHEMA_VERSION) {
    return false;
  }
  return verifyVisualEventSemanticBindings({
    changeDetails: event?.change_details,
    localization,
    previousCapture: evidence.previous_capture,
    currentCapture: evidence.current_capture,
  }).valid;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0;
}

function sameRect(leftValue, rightValue) {
  const left = objectValue(leftValue);
  const right = objectValue(rightValue);
  const keys = ["x", "y", "width", "height"];
  return Object.keys(left).length === keys.length &&
    Object.keys(right).length === keys.length &&
    keys.every((key) => Number.isFinite(Number(left[key])) && left[key] === right[key]);
}

function rectanglesOverlap(rectValue, cropValue) {
  const rect = objectValue(rectValue);
  const crop = objectValue(cropValue);
  const rectX = Number(rect.x);
  const rectY = Number(rect.y);
  const rectWidth = Number(rect.width);
  const rectHeight = Number(rect.height);
  const cropX = Number(crop.x);
  const cropY = Number(crop.y);
  const cropWidth = Number(crop.width);
  const cropHeight = Number(crop.height);
  if (![rectX, rectY, rectWidth, rectHeight, cropX, cropY, cropWidth, cropHeight].every(Number.isFinite)) {
    return false;
  }
  return rectWidth > 0 &&
    rectHeight > 0 &&
    cropWidth > 0 &&
    cropHeight > 0 &&
    rectX < cropX + cropWidth &&
    rectX + rectWidth > cropX &&
    rectY < cropY + cropHeight &&
    rectY + rectHeight > cropY;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}
