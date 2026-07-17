export type EventVisualEvidenceObject = {
  key: string;
  url: string;
  content_type: string | null;
  width: number | null;
  height: number | null;
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
};

export type EventVisualEvidenceSide = {
  captured_at: string | null;
  exact_overlap: boolean;
  kind: "image" | "pdf";
  localization_reason: string;
  localization_status: string;
  objects: Record<string, EventVisualEvidenceObject>;
  state_id: string | null;
};

export type EventVisualCaptureManifest = {
  captured_at?: unknown;
  crop?: unknown;
  full?: unknown;
  metadata?: unknown;
  state_id?: unknown;
};

export type EventVisualLocalizationSide = {
  exact_overlap?: unknown;
  reason?: unknown;
  state_id?: unknown;
  status?: unknown;
};

export async function buildEventVisualEvidenceSide({
  captureValue,
  localizationValue,
  signObjectKey,
  exactCropAllowed = false,
  fallbackReason = null,
}: {
  captureValue: unknown;
  localizationValue: unknown;
  signObjectKey: (key: string) => Promise<string>;
  exactCropAllowed?: boolean;
  fallbackReason?: string | null;
}): Promise<EventVisualEvidenceSide> {
  const capture = jsonObject(captureValue) as EventVisualCaptureManifest;
  const localization = jsonObject(localizationValue) as EventVisualLocalizationSide;
  const full = evidenceObject(capture.full);
  const crop = evidenceObject(capture.crop);
  const localizationStatus = cleanText(localization.status) || "unavailable_geometry_missing";
  const cropPassesExactGate = Boolean(
    exactCropAllowed &&
      localizationStatus === "verified" &&
      crop?.exact_overlap === true &&
      localization.exact_overlap === true &&
      crop.source_image_object_key === full?.object_key &&
      crop.source_image_sha256 === full?.sha256 &&
      crop.source_image_byte_length === full?.byte_length,
  );
  const objects: Record<string, EventVisualEvidenceObject> = {};

  if (full && isPublishedVisualEvidenceObjectKey(full.object_key)) {
    objects.full = await signedObject(full, signObjectKey);
  }
  // Metadata remains hash-bound in the immutable server-side manifest but is
  // intentionally not signed into this public response. It contains capture
  // and worker diagnostics that the screenshot UI does not need.
  // An unverified crop is intentionally not signed. This makes the API, rather
  // than presentation code, the trust boundary for exact-overlap evidence.
  if (cropPassesExactGate && crop && isPublishedVisualEvidenceObjectKey(crop.object_key)) {
    objects.crop = await signedObject(crop, signObjectKey);
  }

  const exactOverlap = Boolean(objects.crop);
  const localizationNotApplicable = [
    "not_applicable_pdf",
    "not_applicable_new_document",
    "not_applicable_first_observation",
  ].includes(localizationStatus);
  const forceFullScreenshotFallback = !localizationNotApplicable && (
    !exactCropAllowed || localizationStatus === "verified" && !exactOverlap
  );
  const exposedLocalizationStatus = forceFullScreenshotFallback
    ? "full_screenshot_fallback"
    : localizationStatus;
  const suppliedReason = forceFullScreenshotFallback && !exactCropAllowed
    ? cleanText(fallbackReason)
    : localizationStatus === "verified" && !exactOverlap
      ? ""
    : cleanText(localization.reason);

  const kind = cleanText(full?.content_type).toLowerCase().includes("pdf")
    ? "pdf"
    : "image";

  return {
    captured_at: cleanText(capture.captured_at) || null,
    exact_overlap: exactOverlap,
    kind,
    localization_reason: localizationReason({
      exactOverlap,
      hasFull: Boolean(objects.full),
      reason: suppliedReason,
      status: exposedLocalizationStatus,
    }),
    localization_status: exposedLocalizationStatus,
    objects,
    state_id: cleanText(capture.state_id) || cleanText(localization.state_id) || null,
  };
}

export function isPublishedVisualEvidenceObjectKey(value: unknown) {
  if (typeof value !== "string" || value !== value.trim()) return false;
  const key = value;
  if (!key.startsWith("visual-snapshots/published/")) return false;
  if (key.length === "visual-snapshots/published/".length) return false;
  if (key.includes("\\") || /[\u0000-\u001f\u007f]/.test(key)) return false;
  return !key.split("/").some((segment) => segment === ".." || segment === ".");
}

function evidenceObject(value: unknown) {
  const object = jsonObject(value);
  const objectKey = typeof object.object_key === "string" ? object.object_key : "";
  if (!objectKey) return null;
  const clipValue = jsonObject(object.clip);
  const clip = numberValue(clipValue.width) !== null && numberValue(clipValue.height) !== null
    ? {
        x: numberValue(clipValue.x) || 0,
        y: numberValue(clipValue.y) || 0,
        width: numberValue(clipValue.width) || 0,
        height: numberValue(clipValue.height) || 0,
      }
    : null;
  return {
    object_key: objectKey,
    sha256: cleanText(object.sha256) || null,
    byte_length: numberValue(object.byte_length),
    content_type: cleanText(object.content_type) || null,
    width: numberValue(object.width),
    height: numberValue(object.height),
    clip,
    exact_overlap: object.exact_overlap === true,
    source_image_object_key: cleanText(object.source_image_object_key) || null,
    source_image_sha256: cleanText(object.source_image_sha256) || null,
    source_image_byte_length: numberValue(object.source_image_byte_length),
  };
}

async function signedObject(
  object: NonNullable<ReturnType<typeof evidenceObject>>,
  signObjectKey: (key: string) => Promise<string>,
): Promise<EventVisualEvidenceObject> {
  return {
    key: object.object_key,
    url: await signObjectKey(object.object_key),
    content_type: object.content_type,
    width: object.width,
    height: object.height,
    clip: object.clip,
  };
}

function localizationReason({
  exactOverlap,
  hasFull,
  reason,
  status,
}: {
  exactOverlap: boolean;
  hasFull: boolean;
  reason: string;
  status: string;
}) {
  if (exactOverlap) return reason || "The stored crop has verified exact overlap with this change.";
  if (!hasFull) {
    return reason || "The event-specific full screenshot was not retained for this update.";
  }
  if (reason) return reason;
  switch (status) {
    case "unavailable_exact_text_missing":
      return "No exact change text was available for screenshot localization.";
    case "unavailable_geometry_missing":
      return "The event screenshot has no verified location geometry.";
    case "unavailable_image_missing":
      return "The event screenshot image was not retained.";
    case "unavailable_ambiguous":
      return "The change location was ambiguous, so the full event screenshot is shown.";
    case "historical_artifact_unrecoverable":
      return "This historical update predates recoverable visual evidence.";
    case "not_applicable_pdf":
      return "Screenshot localization does not apply to this PDF evidence.";
    case "not_applicable_new_document":
      return "This PDF is AwardPing's first retained observation; no prior publisher version is asserted.";
    default:
      return "No verified exact crop is available; the full event screenshot is shown.";
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
