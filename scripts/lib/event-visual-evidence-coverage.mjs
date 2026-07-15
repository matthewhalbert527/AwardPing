import {
  classifyChangeEventVisualEvidence,
  summarizeChangeEventVisualEvidence,
} from "./snapshot-localization.mjs";

const publishedPrefix = "visual-snapshots/published/";

export async function verifyChangeEventManifestArtifacts({ evidence, headObject } = {}) {
  const checks = {
    previous: { full: false, crop: false },
    current: { full: false, crop: false },
  };
  const details = { previous: {}, current: {} };
  const artifacts = [];
  const bucket = cleanText(evidence?.bucket);
  const intentionallyUnrecoverable = evidence?.evidence_status === "historical_artifact_unrecoverable";

  for (const side of ["previous", "current"]) {
    const capture = objectValue(evidence?.[`${side}_capture`]);
    const localizationSide = objectValue(objectValue(evidence?.localization).sides)[side];
    const sideStatus = cleanText(localizationSide?.status);
    const intentionallyUnavailableSide = intentionallyUnrecoverable || [
      "historical_artifact_unrecoverable",
      "unavailable_image_missing",
    ].includes(sideStatus);
    const directReferences = [
      {
        role: "full",
        manifest: capture.full,
        required: !intentionallyUnavailableSide,
        classifierRole: "full",
      },
      { role: "crop", manifest: capture.crop, required: false, classifierRole: "crop" },
      {
        role: "metadata",
        manifest: capture.metadata,
        required: Boolean(Object.keys(objectValue(capture.full)).length),
      },
      { role: "main_full", manifest: capture.main_full },
      { role: "thumbnail", manifest: capture.thumbnail },
      { role: "text", manifest: capture.text },
      { role: "layout", manifest: capture.layout },
    ];
    const directResults = {};
    for (const reference of directReferences) {
      if (
        !reference.required &&
        !reference.classifierRole &&
        !Object.keys(objectValue(reference.manifest)).length
      ) {
        continue;
      }
      const result = await verifyArtifact({
        bucket,
        manifest: objectValue(reference.manifest),
        headObject,
        required: reference.required,
      });
      directResults[reference.role] = result;
      if (reference.classifierRole && reference.classifierRole !== "crop") {
        checks[side][reference.classifierRole] = result.verified;
      }
      details[side][reference.role] = result;
      artifacts.push({ side, role: reference.role, ...result });
    }

    const stateDetails = [];
    for (const [index, rawState] of arrayValue(capture.states).entries()) {
      const state = objectValue(rawState);
      const stateId = cleanText(state.state_id) || `state-${index + 1}`;
      for (const reference of [
        { role: "state.image", manifest: state.image, required: true },
        { role: "state.geometry", manifest: state.geometry, required: false },
      ]) {
        if (!reference.required && !Object.keys(objectValue(reference.manifest)).length) continue;
        const result = await verifyArtifact({
          bucket,
          manifest: objectValue(reference.manifest),
          headObject,
          required: reference.required,
        });
        const detail = { state_id: stateId, role: reference.role, ...result };
        stateDetails.push(detail);
        artifacts.push({ side, ...detail });
      }
    }
    if (stateDetails.length) details[side].states = stateDetails;

    const cropPresent = Object.keys(objectValue(capture.crop)).length > 0;
    if (cropPresent) {
      const localizationSide = objectValue(objectValue(evidence?.localization).sides)[side];
      const selectedStateId = cleanText(
        capture.state_id || objectValue(capture.crop).state_id || localizationSide?.state_id,
      );
      const selectedImage = stateDetails.find(
        (item) => item.state_id === selectedStateId && item.role === "state.image",
      );
      const selectedGeometry = stateDetails.find(
        (item) => item.state_id === selectedStateId && item.role === "state.geometry",
      );
      const cropManifest = objectValue(capture.crop);
      const fullManifest = objectValue(capture.full);
      const cropSourceImageBound = Boolean(
        cleanText(cropManifest.source_image_object_key) === cleanText(fullManifest.object_key) &&
        cleanText(cropManifest.source_image_sha256).toLowerCase() ===
          cleanText(fullManifest.sha256).toLowerCase() &&
        positiveNumber(cropManifest.source_image_byte_length) ===
          positiveNumber(fullManifest.byte_length)
      );
      const cropChain = {
        verified: Boolean(
          directResults.crop?.verified &&
          directResults.full?.verified &&
          directResults.layout?.verified &&
          selectedImage?.verified &&
          selectedGeometry?.verified &&
          cropSourceImageBound
        ),
        crop_verified: directResults.crop?.verified === true,
        full_verified: directResults.full?.verified === true,
        layout_verified: directResults.layout?.verified === true,
        selected_state_id: selectedStateId || null,
        selected_state_image_verified: selectedImage?.verified === true,
        selected_state_geometry_verified: selectedGeometry?.verified === true,
        crop_source_image_bound: cropSourceImageBound,
      };
      if (!cropChain.verified) {
        cropChain.solution =
          "Exclude this crop from verified coverage until its exact crop names the same source image key/hash/bytes and its selected full image, selected state image, and bound geometry artifacts all pass immutable HEAD verification.";
      }
      details[side].verified_crop_chain = cropChain;
      checks[side].crop = cropChain.verified;
    }
  }

  return { checks, details, artifacts };
}

export function buildChangeEventVisualEvidenceCoverageReport({
  events = [],
  evidenceByEvent = new Map(),
  artifactChecksByEvent = new Map(),
} = {}) {
  const rows = events.map((event) => {
    const evidence = mapValue(evidenceByEvent, event.id) || null;
    const artifactChecks = mapValue(artifactChecksByEvent, event.id) || {};
    return {
      ...classifyChangeEventVisualEvidence({ event, evidence, artifactChecks }),
      suppressed: Boolean(event.suppressed_at),
    };
  });
  const publicRows = rows.filter((row) => !row.suppressed);
  const suppressedRows = rows.filter((row) => row.suppressed);

  return {
    event_count: rows.length,
    public_unsuppressed_event_count: publicRows.length,
    suppressed_retained_event_count: suppressedRows.length,
    retention: summarizeChangeEventVisualEvidence(rows),
    public_unsuppressed: summarizeChangeEventVisualEvidence(publicRows),
    suppressed_retention: summarizeChangeEventVisualEvidence(suppressedRows),
    rows,
  };
}

async function verifyArtifact({ bucket, manifest, headObject, required = false }) {
  const key = cleanText(manifest.object_key);
  const sha256 = cleanText(manifest.sha256).toLowerCase();
  const byteLength = positiveNumber(manifest.byte_length);
  if (!key && !sha256 && !byteLength) {
    return required
      ? {
          verified: false,
          status: "missing_required_manifest",
          solution: "Do not count this event side as retained; recover the exact immutable artifact or mark only that side unavailable.",
        }
      : { verified: false, status: "not_present" };
  }
  if (
    !bucket ||
    !key.startsWith(publishedPrefix) ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !byteLength
  ) {
    return {
      verified: false,
      status: "invalid_manifest",
      solution: "Quarantine this reference from verified coverage and recover a permanent content-addressed manifest; never substitute the moving source pointer.",
    };
  }

  try {
    const head = objectValue(await headObject({ bucket, key }));
    const storedSha256 = cleanText(head.sha256).toLowerCase();
    const storedByteLength = positiveNumber(head.byte_length);
    const expectedContentType = cleanText(manifest.content_type).toLowerCase();
    const storedContentType = cleanText(head.content_type).toLowerCase();
    const shaMatches = storedSha256 === sha256;
    const byteLengthMatches = storedByteLength === byteLength;
    const contentTypeMatches = !expectedContentType || storedContentType === expectedContentType;
    return {
      verified: shaMatches && byteLengthMatches && contentTypeMatches,
      status: shaMatches && byteLengthMatches && contentTypeMatches ? "verified" : "head_mismatch",
      sha256_matches: shaMatches,
      byte_length_matches: byteLengthMatches,
      content_type_matches: contentTypeMatches,
      manifest_byte_length: byteLength,
      stored_byte_length: storedByteLength,
      ...(shaMatches && byteLengthMatches && contentTypeMatches
        ? {}
        : {
            solution: "Exclude this artifact from verified coverage and restore the exact archived bytes and content type at its content-addressed key; never use current-pointer data.",
          }),
    };
  } catch (error) {
    return {
      verified: false,
      status: "head_error",
      error: safeErrorCode(error),
      solution: "Exclude this artifact from verified coverage and restore or re-authorize access to the exact content-addressed object from the retained archive.",
    };
  }
}

function safeErrorCode(error) {
  const status = Number(error?.$metadata?.httpStatusCode || 0);
  if (status) return `http_${status}`;
  const name = cleanText(error?.name || error?.code);
  return name || "unknown_head_error";
}

function mapValue(map, key) {
  return map instanceof Map ? map.get(key) : objectValue(map)[key];
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}
