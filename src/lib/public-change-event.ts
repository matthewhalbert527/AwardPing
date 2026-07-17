import { isChangeEventSuppressed } from "@/lib/change-event-suppression";
import { isUsefulChangeForAward } from "@/lib/change-summary";
import { isMonitorableAwardSource, isPublicAwardSource } from "@/lib/source-quality";
import {
  isStage1SourceIdentityExcluded,
  type Stage1PublicationEntry,
} from "@/lib/stage1-publication";
import type { Database, Json } from "@/lib/database.types";
import { verifyVisualEventSemanticBindings } from "../../scripts/lib/visual-event-localization.mjs";

export type PublicChangeEventVisualEvidence =
  Database["public"]["Tables"]["shared_award_change_event_visual_evidence"]["Row"];

type PublicChangeEventInput = {
  event: {
    id: string;
    shared_award_id: string;
    shared_award_source_id?: string | null;
    source_title?: string | null;
    source_url: string;
    source_page_type?: string | null;
    summary: string;
    change_details?: unknown;
    suppressed_at?: string | null;
    suppression_reason?: string | null;
    suppression_source?: string | null;
    visual_review_candidate_id?: string | null;
  };
  award: {
    id: string;
    name: string;
    status: string;
  } | null;
  source: {
    id: string;
    shared_award_id: string;
    admin_review_status: string;
    url: string;
    title?: string | null;
    display_title?: string | null;
    page_metadata?: unknown;
    page_metadata_generated_at?: string | null;
    page_metadata_model?: string | null;
    page_type?: string | null;
    source?: string | null;
    reason?: string | null;
    submitted_by_user_id?: string | null;
  } | null;
  publication: Stage1PublicationEntry;
  evidence: PublicChangeEventVisualEvidence | null;
};

export function isPublicChangeEvent({
  event,
  award,
  source,
  publication,
  evidence,
}: PublicChangeEventInput) {
  if (!publication.effectivelyVerified || !award || award.status !== "active") {
    return false;
  }
  if (!source || source.admin_review_status !== "open") return false;
  if (award.id !== publication.canonicalAwardId) return false;
  if (!publication.memberAwardIds.includes(event.shared_award_id)) return false;
  if (source.shared_award_id !== event.shared_award_id) return false;
  if (!event.shared_award_source_id || source.id !== event.shared_award_source_id) {
    return false;
  }
  // The event must describe the exact reviewed source row. Source IDs alone are
  // insufficient because a stale or malformed event URL is rendered publicly.
  if (event.source_url !== source.url) return false;
  if (!publication.allowedSourceIdSet.has(source.id)) return false;
  if (!hasPublishableEventVisualEvidence(event, evidence)) return false;
  if (
    isStage1SourceIdentityExcluded(publication, source) ||
    isStage1SourceIdentityExcluded(publication, {
      url: event.source_url,
      title: event.source_title,
    })
  ) {
    return false;
  }
  if (isChangeEventSuppressed(event)) return false;
  if (!isPublicAwardSource(source) || !isMonitorableAwardSource(source)) return false;

  return isUsefulChangeForAward({
    awardName: award.name,
    sourceTitle: event.source_title,
    sourceUrl: event.source_url,
    summary: event.summary,
    change_details: event.change_details,
  });
}

export function hasPublishableEventVisualEvidence(
  event: PublicChangeEventInput["event"],
  evidence: PublicChangeEventVisualEvidence | null,
) {
  if (
    !evidence ||
    evidence.change_event_id !== event.id ||
    evidence.shared_award_id !== event.shared_award_id ||
    evidence.shared_award_source_id !== event.shared_award_source_id ||
    !["visual-event-evidence-v1", "visual-event-evidence-v2"].includes(
      evidence.evidence_schema_version,
    )
  ) {
    return false;
  }

  if (evidence.evidence_status === "historical_artifact_unrecoverable") {
    const localization = jsonObject(evidence.localization);
    const sides = jsonObject(localization.sides);
    return (
      !event.visual_review_candidate_id &&
      !evidence.visual_review_candidate_id &&
      Boolean(evidence.backfilled_at) &&
      localization.terminal_artifact_loss_confirmed === true &&
      terminalUnavailableSide(sides.previous) &&
      terminalUnavailableSide(sides.current)
    );
  }

  if (evidence.evidence_status === "not_applicable_new_document") {
    const details = jsonObject(event.change_details);
    const localization = jsonObject(evidence.localization);
    const sides = jsonObject(localization.sides);
    const previousSide = jsonObject(sides.previous);
    const currentSide = jsonObject(sides.current);
    return Boolean(
      event.visual_review_candidate_id &&
      evidence.visual_review_candidate_id === event.visual_review_candidate_id &&
      evidence.candidate_signature &&
      evidence.bucket &&
      !evidence.verified_at &&
      !evidence.backfilled_at &&
      details.event_kind === "new_official_document" &&
      details.candidate_scope === "initial_official_document" &&
      details.observation_kind === "first_observation" &&
      details.first_observation === true &&
      details.candidate_signature === evidence.candidate_signature &&
      captureHasFirstObservationAttestation(evidence.previous_capture) &&
      captureHasImmutableCurrentDocument(evidence.current_capture) &&
      localization.direction === "added" &&
      previousSide.status === "not_applicable_first_observation" &&
      previousSide.required === false &&
      typeof previousSide.reason === "string" &&
      Boolean(previousSide.reason.trim()) &&
      currentSide.status === "not_applicable_pdf" &&
      typeof currentSide.reason === "string" &&
      Boolean(currentSide.reason.trim())
    );
  }

  if (
    !event.visual_review_candidate_id ||
    evidence.visual_review_candidate_id !== event.visual_review_candidate_id ||
    !evidence.candidate_signature ||
    !evidence.bucket ||
    !captureHasImmutableFullAndMetadata(evidence.previous_capture) ||
    !captureHasImmutableFullAndMetadata(evidence.current_capture)
  ) {
    return false;
  }

  if (evidence.evidence_status === "verified") {
    if (!evidence.verified_at) return false;
    const localization = jsonObject(evidence.localization);
    const sides = jsonObject(localization.sides);
    const direction = localization.direction;
    const semantic = evidence.evidence_schema_version === "visual-event-evidence-v2"
      ? verifyVisualEventSemanticBindings({
          changeDetails: event.change_details,
          localization: evidence.localization,
          previousCapture: evidence.previous_capture,
          currentCapture: evidence.current_capture,
        })
      : { valid: false };
    // v1 crops predate an event-semantic wording binding. Keep the event and
    // its exact immutable full images usable, but never present that crop as a
    // verified "Changed section." The same fail-safe applies to a malformed
    // v2 mixed event: either every required side verifies or both full images
    // become the honest fallback.
    if (!semantic.valid) {
      return capturesSupportHonestFullScreenshotFallback(evidence);
    }
    return verifiedDirectionalCrops(evidence, direction, sides) ||
      capturesSupportHonestFullScreenshotFallback(evidence);
  }

  if (evidence.evidence_status === "full_screenshot_fallback") {
    const localization = jsonObject(evidence.localization);
    const sides = jsonObject(localization.sides);
    return capturesSupportHonestFullScreenshotFallback(evidence) && (
      !evidence.verified_at &&
      honestFallbackSide(sides.previous) &&
      honestFallbackSide(sides.current)
    );
  }

  if ([
    "unavailable_exact_text_missing",
    "unavailable_geometry_missing",
    "unavailable_ambiguous",
  ].includes(evidence.evidence_status)) {
    const sides = jsonObject(jsonObject(evidence.localization).sides);
    return capturesSupportHonestFullScreenshotFallback(evidence) &&
      honestFallbackSide(sides.previous) && honestFallbackSide(sides.current);
  }

  return false;
}

function captureHasImmutableFullAndMetadata(value: Json) {
  const capture = jsonObject(value);
  return immutableArtifact(capture.full) && immutableArtifact(capture.metadata) &&
    typeof capture.captured_at === "string" && Number.isFinite(Date.parse(capture.captured_at));
}

function captureHasFirstObservationAttestation(value: Json) {
  const capture = jsonObject(value);
  const metadata = jsonObject(capture.metadata);
  const hashes = jsonObject(capture.capture_hashes);
  return capture.kind === "first_observation_attestation" &&
    capture.state_id === "first-observation" &&
    (capture.full === null || capture.full === undefined) &&
    immutableArtifact(metadata) &&
    hashes.attestation_hash === metadata.sha256 &&
    typeof capture.captured_at === "string" &&
    Number.isFinite(Date.parse(capture.captured_at));
}

function captureHasImmutableCurrentDocument(value: Json) {
  const capture = jsonObject(value);
  const full = jsonObject(capture.full);
  const metadata = jsonObject(capture.metadata);
  return capture.kind === "pdf" &&
    capture.state_id === "document" &&
    immutableArtifact(full) &&
    immutableArtifact(metadata) &&
    typeof full.content_type === "string" &&
    full.content_type.startsWith("application/pdf") &&
    typeof metadata.content_type === "string" &&
    metadata.content_type.startsWith("application/json") &&
    typeof capture.captured_at === "string" &&
    Number.isFinite(Date.parse(capture.captured_at));
}

function captureHasVerifiedCrop(value: Json, sideValue: unknown) {
  const capture = jsonObject(value);
  const crop = jsonObject(capture.crop);
  const full = jsonObject(capture.full);
  const layout = jsonObject(capture.layout);
  const side = jsonObject(sideValue);
  const cropClip = jsonObject(crop.clip);
  const cropRectPixels = jsonObject(side.crop_rect_pixels);
  const stateId = typeof capture.state_id === "string" ? capture.state_id : "";
  return immutableArtifact(crop) && crop.exact_overlap === true &&
    crop.source_image_object_key === full.object_key &&
    crop.source_image_sha256 === full.sha256 &&
    immutableArtifact(layout) &&
    stateId.length > 0 &&
    crop.state_id === stateId &&
    layout.state_id === stateId &&
    side.status === "verified" &&
    typeof side.exact_text === "string" && Boolean(side.exact_text.trim()) &&
    Array.isArray(side.matched_rects) && side.matched_rects.length > 0 &&
    Object.keys(jsonObject(side.crop_rect)).length > 0 &&
    Object.keys(cropRectPixels).length > 0 &&
    side.exact_overlap === true &&
    String(side.algorithm_version) === "3" &&
    side.state_id === stateId &&
    rectangleEqual(jsonObject(crop.css_clip), jsonObject(side.crop_rect)) &&
    rectangleEqual(cropClip, cropRectPixels);
}

function capturesSupportHonestFullScreenshotFallback(
  evidence: PublicChangeEventVisualEvidence,
) {
  return captureHasImmutableFullAndMetadata(evidence.previous_capture) &&
    captureHasImmutableFullAndMetadata(evidence.current_capture);
}

export function eventVisualEvidencePresentation(
  event: PublicChangeEventInput["event"],
  evidence: PublicChangeEventVisualEvidence,
) {
  if (evidence.evidence_status === "not_applicable_new_document") {
    return {
      evidenceStatus: "not_applicable_new_document",
      exactCropAllowed: false,
      fallbackReason: null,
    } as const;
  }
  if (evidence.evidence_status === "verified" &&
    evidence.evidence_schema_version === "visual-event-evidence-v2") {
    const semantic = verifyVisualEventSemanticBindings({
      changeDetails: event.change_details,
      localization: evidence.localization,
      previousCapture: evidence.previous_capture,
      currentCapture: evidence.current_capture,
    });
    const localization = jsonObject(evidence.localization);
    if (semantic.valid && verifiedDirectionalCrops(
      evidence,
      localization.direction,
      jsonObject(localization.sides),
    )) {
      return {
        evidenceStatus: "verified",
        exactCropAllowed: true,
        fallbackReason: null,
      } as const;
    }
  }
  if (capturesSupportHonestFullScreenshotFallback(evidence)) {
    const legacy = evidence.evidence_schema_version === "visual-event-evidence-v1";
    return {
      evidenceStatus: "full_screenshot_fallback",
      exactCropAllowed: false,
      fallbackReason: legacy
        ? "Exact location unavailable: this retained crop predates event-semantic wording verification, so the event-specific full screenshot is shown."
        : "Exact location unavailable: the exact changed wording could not be verified on every required side, so the event-specific full screenshot is shown.",
    } as const;
  }
  return {
    evidenceStatus: evidence.evidence_status,
    exactCropAllowed: false,
    fallbackReason: "Exact location unavailable: no verified event-specific crop can be shown.",
  } as const;
}

function verifiedDirectionalCrops(
  evidence: PublicChangeEventVisualEvidence,
  direction: unknown,
  sides: Record<string, unknown>,
) {
  if (direction === "added" || direction === "current") {
    return captureHasVerifiedCrop(evidence.current_capture, sides.current);
  }
  if (direction === "removed" || direction === "previous") {
    return captureHasVerifiedCrop(evidence.previous_capture, sides.previous);
  }
  if (direction === "changed" || direction === "mixed" || direction === "both") {
    return captureHasVerifiedCrop(evidence.previous_capture, sides.previous) &&
      captureHasVerifiedCrop(evidence.current_capture, sides.current);
  }
  return false;
}

function immutableArtifact(value: unknown) {
  const artifact = jsonObject(value);
  return typeof artifact.object_key === "string" &&
    artifact.object_key.startsWith("visual-snapshots/published/") &&
    typeof artifact.sha256 === "string" && /^[0-9a-f]{64}$/.test(artifact.sha256);
}

function terminalUnavailableSide(value: unknown) {
  const side = jsonObject(value);
  return side.status === "historical_artifact_unrecoverable" &&
    typeof side.reason === "string" && Boolean(side.reason.trim());
}

function honestFullScreenshotSide(value: unknown) {
  const side = jsonObject(value);
  return side.status === "full_screenshot_fallback" &&
    side.exact_overlap === false &&
    typeof side.reason === "string" && Boolean(side.reason.trim());
}

function honestFallbackSide(value: unknown) {
  const side = jsonObject(value);
  return honestFullScreenshotSide(side) || (
    typeof side.status === "string" &&
    side.status !== "verified" &&
    side.exact_overlap !== true &&
    typeof side.reason === "string" && Boolean(side.reason.trim())
  );
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rectangleEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return ["x", "y", "width", "height"].every(
    (key) => Number.isFinite(Number(left[key])) && Number(left[key]) === Number(right[key]),
  );
}
