import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import sharp from "sharp";
import {
  localizeVisualEventSide,
  verifyVisualTextGeometryBinding,
} from "./visual-event-localization.mjs";
import { visualSnapshotArtifactManifest } from "./visual-review-queue.mjs";

export const PUBLISHED_VISUAL_EVIDENCE_PREFIX = "visual-snapshots/published";
export const VISUAL_EVENT_EVIDENCE_SCHEMA_VERSION = "visual-event-evidence-v1";

export class DeterministicVisualArtifactError extends Error {
  constructor(message, code = "deterministic_visual_artifact_unavailable") {
    super(message);
    this.name = "DeterministicVisualArtifactError";
    this.code = code;
  }
}

export function isDeterministicVisualArtifactError(error) {
  return error instanceof DeterministicVisualArtifactError;
}

export async function preparePublishedVisualEventEvidence({
  candidate,
  source,
  changeDetails,
  archiveRoot,
  config,
  artifactStore = null,
  now = new Date().toISOString(),
  historical = false,
} = {}) {
  assertCandidateIdentity(candidate, source);
  const ownsStore = !artifactStore;
  const store = artifactStore || createPublishedVisualArtifactStore(config);
  try {
    const prepare = async (side) => {
      try {
        return await prepareSide({
          side,
          candidate,
          changeDetails,
          archiveRoot,
          store,
          historical,
        });
      } catch (error) {
        if (!historical || !isDeterministicVisualArtifactError(error)) throw error;
        return unavailableHistoricalSide(
          side,
          "unavailable_image_missing",
          `The retained historical ${side} artifacts could not be verified: ${errorMessage(error)}`,
        );
      }
    };
    const previous = await prepare("previous");
    const current = await prepare("current");
    const requiredSides = [previous, current].filter((side) => side.localization.required);
    const verifiedRequired = requiredSides.filter((side) => side.localization.status === "verified");
    const allPdf = previous.localization.status === "not_applicable_pdf" &&
      current.localization.status === "not_applicable_pdf";
    const evidenceStatus = allPdf
      ? "not_applicable_pdf"
      : requiredSides.length && verifiedRequired.length === requiredSides.length
        ? "verified"
        : aggregateUnavailableStatus(requiredSides);
    const direction = previous.localization.required && current.localization.required
      ? "mixed"
      : previous.localization.required
        ? "removed"
        : current.localization.required
          ? "added"
          : "changed";

    return {
      change_event_id: null,
      shared_award_id: candidate.shared_award_id,
      shared_award_source_id: candidate.shared_award_source_id,
      visual_review_candidate_id: candidate.id,
      candidate_signature: candidate.candidate_signature,
      bucket: store.bucket,
      evidence_status: evidenceStatus,
      previous_capture: previous.capture,
      current_capture: current.capture,
      localization: {
        direction,
        sides: {
          previous: previous.localization,
          current: current.localization,
        },
      },
      evidence_schema_version: VISUAL_EVENT_EVIDENCE_SCHEMA_VERSION,
      created_at: now,
      verified_at: evidenceStatus === "verified" ? now : null,
      backfilled_at: historical ? now : null,
    };
  } finally {
    if (ownsStore) store.destroy?.();
  }
}

export function createPublishedVisualArtifactStore(config = {}) {
  if (!config?.bucket || !config?.endpoint || !config?.accessKeyId || !config?.secretAccessKey) {
    throw new Error("Permanent visual evidence requires complete R2 configuration.");
  }
  const client = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return {
    bucket: config.bucket,
    async put({ key, body, contentType, sha256 }) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        Metadata: { sha256 },
      }));
    },
    async head({ key }) {
      const result = await client.send(new HeadObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }));
      return {
        byte_length: Number(result.ContentLength || 0),
        content_type: cleanText(result.ContentType) || null,
        sha256: cleanText(result.Metadata?.sha256) || null,
      };
    },
    destroy() {
      client.destroy();
    },
  };
}

export function candidateVisualSnapshotRef(candidate, side) {
  const key = side === "previous" ? "previous_snapshot_ref" : "new_snapshot_ref";
  const direct = objectValue(candidate?.[key]);
  if (Object.keys(direct).length) return direct;
  const prompt = objectValue(objectValue(candidate?.prompt_payload)[key]);
  return Object.keys(prompt).length ? prompt : null;
}

export function resolveCandidateVisualEvidenceSide({
  candidate,
  side,
  archiveRoot,
} = {}) {
  const ref = candidateVisualSnapshotRef(candidate, side);
  if (!ref) return { ref: null, kind: null, states: [], files: {}, meta: null };
  const localPaths = objectValue(ref.local_paths);
  const fileRefs = Object.fromEntries(
    ["page", "thumb", "pdf", "text", "layout", "meta"].map((role) => [
      role,
      resolveArtifactPathRef(localPaths[role], archiveRoot),
    ]),
  );
  const metaPath = fileRefs.meta.path;
  const meta = readJson(metaPath);
  const kind = cleanText(ref.kind || meta?.kind) || (fileRefs.pdf.path ? "pdf" : "webpage");
  const expectedMainHash = cleanText(
    side === "previous"
      ? candidate?.previous_image_hash || ref.image_hash || candidate?.prompt_payload?.hashes?.previous_image_hash
      : candidate?.new_image_hash || ref.image_hash || candidate?.prompt_payload?.hashes?.new_image_hash,
  ) || null;
  const expectedFileHash = cleanText(
    side === "previous"
      ? candidate?.previous_file_hash || ref.file_hash || candidate?.prompt_payload?.hashes?.previous_file_hash
      : candidate?.new_file_hash || ref.file_hash || candidate?.prompt_payload?.hashes?.new_file_hash,
  ) || null;
  const stateRefs = Array.isArray(ref.visual_states) ? ref.visual_states : [];
  let states = stateRefs.map((state, index) => resolveState({
    state,
    index,
    archiveRoot,
    defaultCapturedAt: ref.captured_at,
  })).filter(Boolean);
  const resolvedStateReferenceCount = states.length;
  const duplicateStateIds = duplicateValues(states.map((state) => state.state_id));
  const mainPath = fileRefs.page.path;
  if (kind === "webpage" && !states.some((state) => state.kind === "main") && mainPath) {
    const layoutPath = fileRefs.layout.path;
    states.unshift({
      state_id: "main",
      kind: "main",
      label: null,
      captured_at: ref.captured_at || meta?.captured_at || null,
      image_path: mainPath,
      image_ref: fileRefs.page,
      image_hash: expectedMainHash,
      geometry_path: layoutPath,
      geometry_ref: fileRefs.layout,
      geometry: readJson(layoutPath),
      geometry_hash: cleanText(ref.layout_hash) || null,
    });
  }
  states = uniqueStates(states);
  const files = {
    page: mainPath,
    thumb: fileRefs.thumb.path,
    pdf: fileRefs.pdf.path,
    text: fileRefs.text.path,
    meta: metaPath,
  };
  return {
    ref,
    kind,
    states,
    files,
    file_refs: fileRefs,
    meta,
    expected_main_hash: expectedMainHash,
    expected_file_hash: expectedFileHash,
    referenced_state_count: stateRefs.length,
    resolved_state_reference_count: resolvedStateReferenceCount,
    duplicate_state_ids: duplicateStateIds,
    artifact_manifest: visualSnapshotArtifactManifest(ref),
  };
}

export function publishedVisualEvidenceObjectKey({
  candidateId,
  side,
  role,
  sha256,
  extension,
} = {}) {
  const candidateSegment = safeKeySegment(candidateId, "candidate");
  const sideSegment = side === "previous" ? "previous" : "current";
  const roleSegment = safeKeySegment(role, "artifact");
  const digest = cleanText(sha256).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Published evidence key requires a SHA-256 digest.");
  const suffix = safeExtension(extension);
  return `${PUBLISHED_VISUAL_EVIDENCE_PREFIX}/${candidateSegment}/${sideSegment}/${roleSegment}/${digest}.${suffix}`;
}

async function prepareSide({
  side,
  candidate,
  changeDetails,
  archiveRoot,
  store,
  historical,
}) {
  const resolved = resolveCandidateVisualEvidenceSide({ candidate, side, archiveRoot });
  if (!resolved.ref) {
    if (!historical) throw new Error(`Candidate ${candidate.id} has no ${side} snapshot reference.`);
    return unavailableHistoricalSide(side, "unavailable_image_missing", "The historical candidate has no retained snapshot reference.");
  }
  validateCandidateArtifactManifest({ candidate, side, resolved, historical });
  preflightCandidateArtifactBytes({ candidate, side, resolved, historical });
  if (resolved.kind === "pdf") {
    if (
      historical &&
      (!resolved.expected_file_hash || !resolved.files.pdf || !existsSync(resolved.files.pdf) ||
        !resolved.files.meta || !existsSync(resolved.files.meta))
    ) {
      return unavailableHistoricalSide(
        side,
        "historical_artifact_unrecoverable",
        "The historical PDF document, metadata, or candidate-bound file hash was not retained.",
      );
    }
    if (!resolved.expected_file_hash) {
      throw new Error(`Candidate ${candidate.id} ${side} PDF file hash is missing.`);
    }
    assertSemanticArtifactRef({
      candidateId: candidate.id,
      side,
      role: "PDF",
      semanticSha256: resolved.expected_file_hash,
      artifactRef: resolved.file_refs.pdf,
      required: !historical,
    });
    if (resolved.files.pdf && existsSync(resolved.files.pdf)) {
      const actualFileHash = sha256Buffer(readFileSync(resolved.files.pdf));
      if (actualFileHash !== resolved.expected_file_hash) {
        if (historical) {
          return unavailableHistoricalSide(
            side,
            "historical_artifact_unrecoverable",
            "The retained historical PDF bytes do not match the candidate-bound file hash.",
          );
        }
        throw new Error(`Candidate ${candidate.id} ${side} PDF hash mismatch.`);
      }
    }
    const pdf = await uploadPathArtifact({
      store,
      candidateId: candidate.id,
      side,
      role: "document",
      path: resolved.files.pdf,
      contentType: "application/pdf",
      expectedSha256: resolved.expected_file_hash,
      expectedByteLength: resolved.file_refs.pdf.byte_length,
      requireExpectedManifest: !historical,
      required: true,
    });
    const metadata = await uploadPathArtifact({
      store,
      candidateId: candidate.id,
      side,
      role: "metadata",
      path: resolved.files.meta,
      contentType: "application/json; charset=utf-8",
      expectedSha256: resolved.file_refs.meta.sha256,
      expectedByteLength: resolved.file_refs.meta.byte_length,
      requireExpectedManifest: !historical,
      required: true,
    });
    return {
      capture: captureManifest({ resolved, full: pdf, metadata, stateId: "document" }),
      localization: localizationManifest({
        side,
        status: "not_applicable_pdf",
        reason: "PDF evidence is retained but does not use webpage crop localization.",
        required: false,
      }),
    };
  }

  const main = resolved.states.find((state) => state.kind === "main") || null;
  if (resolved.duplicate_state_ids.length) {
    throw new DeterministicVisualArtifactError(
      `Candidate ${candidate.id} ${side} has duplicate visual state IDs: ${resolved.duplicate_state_ids.join(", ")}.`,
      "visual_state_id_ambiguous",
    );
  }
  if (!historical && resolved.resolved_state_reference_count !== resolved.referenced_state_count) {
    throw new Error(`Candidate ${candidate.id} ${side} references an incomplete visual state.`);
  }
  if (!historical) validateNewWebpageStateReferences({ candidate, side, resolved });
  if (!main?.image_path || !existsSync(main.image_path)) {
    if (!historical) throw new Error(`Candidate ${candidate.id} ${side} full screenshot is missing.`);
    return unavailableHistoricalSide(side, "unavailable_image_missing", "The historical full screenshot was not retained.");
  }
  const mainImage = await uploadImageState({
    store,
    candidateId: candidate.id,
    side,
    state: main,
    role: "main-full",
    expectedSha256: resolved.expected_main_hash,
    expectedByteLength: main.image_ref?.byte_length,
    requireExpectedManifest: !historical,
    historical,
  });
  const mainFull = mainImage.artifact;
  const retainedStates = [];
  const retainedStateImages = new Map();
  for (const state of resolved.states) {
    if (!state.image_path || !existsSync(state.image_path)) {
      if (historical) continue;
      throw new Error(`Candidate ${candidate.id} ${side} visual state ${state.state_id} is missing.`);
    }
    const uploadedImage = state.state_id === main.state_id
      ? mainImage
      : await uploadImageState({
          store,
          candidateId: candidate.id,
          side,
          state,
          role: `state-${state.state_id}`,
          expectedSha256: state.image_hash,
          expectedByteLength: state.image_ref?.byte_length,
          requireExpectedManifest: !historical,
          historical,
        });
    const image = uploadedImage.artifact;
    retainedStateImages.set(state.state_id, uploadedImage);
    const geometry = await uploadPathArtifact({
      store,
      candidateId: candidate.id,
      side,
      role: `geometry-${state.state_id}`,
      path: state.geometry_path,
      contentType: "application/json; charset=utf-8",
      expectedSha256: state.geometry_ref?.sha256,
      expectedByteLength: state.geometry_ref?.byte_length,
      requireExpectedManifest: !historical && Boolean(state.geometry_path),
      required: !historical && Boolean(state.geometry_path),
    });
    const verifiedGeometryHash = verifiedStateGeometryHash(state.geometry, image.sha256);
    retainedStates.push({
      state_id: state.state_id,
      kind: state.kind,
      label: state.label,
      image,
      geometry,
      geometry_hash: verifiedGeometryHash,
    });
  }
  const localizeStates = resolved.states.flatMap((state) => {
    const retained = retainedStates.find((item) => item.state_id === state.state_id);
    const eligible = state.image_path && existsSync(state.image_path) &&
      Object.keys(objectValue(state.geometry)).length &&
      visualStateGeometryMatchesImage(state.geometry, retained?.image);
    return eligible ? [{ ...state, image_hash: retained.image.sha256 }] : [];
  });
  const localization = localizeVisualEventSide({
    side,
    states: localizeStates,
    changeDetails,
    deterministicDiff: candidate.deterministic_diff || candidate.prompt_payload?.deterministic_diff,
  });
  const required = !String(localization.status).startsWith("unavailable_not_required_") &&
    localization.status !== "unavailable_exact_text";
  const selectedState = localization.status === "verified"
    ? resolved.states.find((state) => state.state_id === localization.state_id) || main
    : main;
  const selectedFull = selectedState.state_id === main.state_id
    ? mainFull
    : retainedStates.find((state) => state.state_id === selectedState.state_id)?.image || mainFull;
  const selectedStateManifest = retainedStates.find(
    (state) => state.state_id === selectedState.state_id,
  );
  const selectedStateImage = retainedStateImages.get(selectedState.state_id);
  const selectedLayout = selectedStateManifest?.geometry
    ? {
        ...selectedStateManifest.geometry,
        state_id: selectedState.state_id,
        geometry_hash: selectedStateManifest.geometry_hash,
      }
    : null;
  let crop = null;
  if (localization.status === "verified") {
    crop = await createAndUploadVerifiedCrop({
      store,
      candidateId: candidate.id,
      side,
      state: selectedState,
      imageBody: selectedStateImage?.body,
      sourceImage: selectedStateImage?.artifact,
      localization,
    });
  }
  const thumbnail = await uploadPathArtifact({
    store,
    candidateId: candidate.id,
    side,
    role: "thumbnail",
    path: resolved.files.thumb,
    contentType: "image/jpeg",
    expectedSha256: resolved.file_refs.thumb.sha256,
    expectedByteLength: resolved.file_refs.thumb.byte_length,
    requireExpectedManifest: !historical && Boolean(resolved.files.thumb),
    required: !historical && Boolean(resolved.files.thumb),
  });
  const metadata = await uploadPathArtifact({
    store,
    candidateId: candidate.id,
    side,
    role: "metadata",
    path: resolved.files.meta,
    contentType: "application/json; charset=utf-8",
    expectedSha256: resolved.file_refs.meta.sha256,
    expectedByteLength: resolved.file_refs.meta.byte_length,
    requireExpectedManifest: !historical,
    required: !historical,
  });
  const text = await uploadPathArtifact({
    store,
    candidateId: candidate.id,
    side,
    role: "text",
    path: resolved.files.text,
    contentType: "text/plain; charset=utf-8",
    expectedSha256: resolved.file_refs.text.sha256,
    expectedByteLength: resolved.file_refs.text.byte_length,
    requireExpectedManifest: !historical && Boolean(resolved.files.text),
    required: !historical && Boolean(resolved.files.text),
  });
  return {
    capture: {
      ...captureManifest({
        resolved,
        full: selectedFull,
        metadata,
        stateId: selectedState.state_id,
      }),
      main_full: mainFull,
      thumbnail,
      text,
      layout: selectedLayout,
      crop,
      states: retainedStates,
    },
    localization: localizationManifest({ ...localization, required }),
  };
}

async function createAndUploadVerifiedCrop({
  store,
  candidateId,
  side,
  state,
  imageBody,
  sourceImage,
  localization,
}) {
  const clip = integerClip(localization.crop_rect_pixels);
  if (!clip || localization.exact_overlap !== true) {
    throw new Error(`Verified ${side} localization is missing an overlapping pixel crop.`);
  }
  if (!Buffer.isBuffer(imageBody) || !imageBody.length) {
    throw new Error(`Verified ${side} localization is missing its immutable source image bytes.`);
  }
  const sourceImageSha256 = sha256Buffer(imageBody);
  if (
    sourceImageSha256 !== cleanText(sourceImage?.sha256).toLowerCase() ||
    imageBody.length !== Number(sourceImage?.byte_length)
  ) {
    throw new Error(`Verified ${side} crop source does not match the permanent full image manifest.`);
  }
  const pipeline = sharp(imageBody);
  const image = await pipeline.metadata();
  if (
    clip.x < 0 || clip.y < 0 || clip.width <= 0 || clip.height <= 0 ||
    clip.x + clip.width > Number(image.width || 0) ||
    clip.y + clip.height > Number(image.height || 0)
  ) {
    throw new Error(`Verified ${side} crop is outside the bound screenshot.`);
  }
  const body = await sharp(imageBody).extract({
    left: clip.x,
    top: clip.y,
    width: clip.width,
    height: clip.height,
  }).jpeg({ quality: 92 }).toBuffer();
  const artifact = await uploadBufferArtifact({
    store,
    candidateId,
    side,
    role: "changed-section-crop",
    body,
    contentType: "image/jpeg",
    extension: "jpg",
  });
  return {
    ...artifact,
    width: clip.width,
    height: clip.height,
    clip,
    css_clip: localization.crop_rect,
    exact_overlap: true,
    state_id: state.state_id,
    source_image_object_key: sourceImage.object_key,
    source_image_sha256: sourceImageSha256,
    source_image_byte_length: imageBody.length,
  };
}

async function uploadImageState({
  store,
  candidateId,
  side,
  state,
  role,
  expectedSha256,
  expectedByteLength = null,
  requireExpectedManifest = false,
  historical = false,
}) {
  const body = readVerifiedPathArtifact({
    path: state.image_path,
    expectedSha256,
    expectedByteLength,
    requireExpectedManifest,
    required: true,
  });
  let metadata;
  try {
    metadata = await sharp(body).metadata();
  } catch (error) {
    if (historical) {
      throw new DeterministicVisualArtifactError(
        `Historical screenshot is unreadable: ${state.image_path}.`,
        "historical_image_unreadable",
      );
    }
    throw error;
  }
  const artifact = await uploadBufferArtifact({
    store,
    candidateId,
    side,
    role,
    body,
    contentType: "image/jpeg",
    extension: extensionFor(state.image_path, "image/jpeg"),
  });
  return {
    artifact: {
      ...artifact,
      width: Number(metadata.width || 0),
      height: Number(metadata.height || 0),
    },
    body,
  };
}

async function uploadPathArtifact({
  path,
  expectedSha256 = null,
  expectedByteLength = null,
  requireExpectedManifest = false,
  required = false,
  ...args
}) {
  const body = readVerifiedPathArtifact({
    path,
    expectedSha256,
    expectedByteLength,
    requireExpectedManifest,
    required,
  });
  if (!body) return null;
  return uploadBufferArtifact({
    ...args,
    body,
    extension: extensionFor(path, args.contentType),
  });
}

function readVerifiedPathArtifact({
  path,
  expectedSha256 = null,
  expectedByteLength = null,
  requireExpectedManifest = false,
  required = false,
}) {
  if (!path || !existsSync(path)) {
    if (required) throw new Error(`Required visual evidence artifact is missing: ${path || "unknown path"}.`);
    return null;
  }
  const body = readFileSync(path);
  const actualSha256 = sha256Buffer(body);
  const expectedHash = cleanText(expectedSha256).toLowerCase();
  const expectedBytes = nonNegativeSafeInteger(expectedByteLength);
  if (requireExpectedManifest && (!/^[a-f0-9]{64}$/.test(expectedHash) || expectedBytes === null)) {
    throw new DeterministicVisualArtifactError(
      `Visual evidence artifact manifest is incomplete for ${path}.`,
      "visual_artifact_manifest_incomplete",
    );
  }
  if (expectedHash && expectedHash !== actualSha256) {
    throw new DeterministicVisualArtifactError(
      `Visual evidence artifact hash mismatch for ${path}.`,
      "visual_artifact_hash_mismatch",
    );
  }
  if (expectedBytes !== null && expectedBytes !== body.length) {
    throw new DeterministicVisualArtifactError(
      `Visual evidence artifact byte-length mismatch for ${path}.`,
      "visual_artifact_byte_length_mismatch",
    );
  }
  return body;
}

async function uploadBufferArtifact({
  store,
  candidateId,
  side,
  role,
  body,
  contentType,
  extension,
}) {
  const sha256 = sha256Buffer(body);
  const key = publishedVisualEvidenceObjectKey({
    candidateId,
    side,
    role,
    sha256,
    extension,
  });
  await store.put({ key, body, contentType, sha256 });
  const head = await store.head({ key });
  if (
    Number(head?.byte_length) !== body.length ||
    cleanText(head?.sha256).toLowerCase() !== sha256 ||
    cleanText(head?.content_type).toLowerCase() !== cleanText(contentType).toLowerCase()
  ) {
    throw new Error(`Permanent visual evidence verification failed for ${key}.`);
  }
  return {
    object_key: key,
    sha256,
    byte_length: body.length,
    content_type: contentType,
  };
}

function captureManifest({ resolved, full, metadata, stateId }) {
  return {
    full: full || null,
    metadata: metadata || null,
    crop: null,
    captured_at: resolved.ref?.captured_at || resolved.meta?.captured_at || null,
    capture_hashes: {
      image_hash: resolved.ref?.image_hash || resolved.expected_main_hash || null,
      text_hash: resolved.ref?.text_hash || null,
      file_hash: resolved.expected_file_hash || resolved.ref?.file_hash || null,
      layout_hash: resolved.ref?.layout_hash || null,
    },
    state_id: stateId || null,
    kind: resolved.kind || null,
  };
}

function localizationManifest(value) {
  return {
    status: value.status,
    required: value.required === true,
    exact_text: value.exact_text || null,
    matched_rects: Array.isArray(value.matched_rects) ? value.matched_rects : [],
    crop_rect: value.crop_rect || null,
    crop_rect_pixels: value.crop_rect_pixels || null,
    exact_overlap: value.exact_overlap === true,
    reason: value.reason || null,
    algorithm_version: value.algorithm_version || null,
    state_id: value.state_id || null,
  };
}

function unavailableHistoricalSide(side, status, reason) {
  return {
    capture: {
      full: null,
      metadata: null,
      crop: null,
      captured_at: null,
      capture_hashes: {},
      state_id: null,
      kind: null,
    },
    localization: localizationManifest({ side, status, reason, required: true }),
  };
}

function aggregateUnavailableStatus(requiredSides) {
  if (!requiredSides.length) return "full_screenshot_fallback";
  const statuses = requiredSides.map((side) => cleanText(side.localization.status));
  if (statuses.some((status) => status.includes("ambiguous"))) return "unavailable_ambiguous";
  if (requiredSides.some(
    (side) => cleanText(side.localization.status).includes("image") && !side.capture?.full,
  )) {
    return "unavailable_image_missing";
  }
  // New publication already requires and byte-verifies both full images. An
  // image-state localization miss with a retained full image therefore means
  // state geometry is missing, not that the event screenshot is absent.
  if (statuses.some((status) => status.includes("image"))) return "unavailable_geometry_missing";
  if (statuses.some((status) => status.includes("geometry"))) return "unavailable_geometry_missing";
  if (statuses.some((status) => status.includes("exact_text"))) return "unavailable_exact_text_missing";
  return "full_screenshot_fallback";
}

function resolveState({ state, index, archiveRoot, defaultCapturedAt }) {
  const value = objectValue(state);
  const paths = objectValue(value.local_paths);
  const imageRef = resolveArtifactPathRef(paths.image || value.image_path, archiveRoot);
  const geometryRef = resolveArtifactPathRef(paths.layout || value.geometry_path, archiveRoot);
  const imagePath = imageRef.path;
  const geometryPath = geometryRef.path;
  const geometry = objectValue(value.geometry || value.text_geometry);
  const loadedGeometry = Object.keys(geometry).length ? geometry : readJson(geometryPath);
  if (!imagePath && !Object.keys(objectValue(loadedGeometry)).length) return null;
  return {
    state_id: cleanText(value.state_id || value.id) || `state-${index + 1}`,
    kind: cleanText(value.kind) === "main" ? "main" : "expansion_state",
    label: cleanText(value.label) || null,
    captured_at: value.metadata?.captured_at || defaultCapturedAt || null,
    image_path: imagePath,
    image_ref: imageRef,
    image_hash: cleanText(value.image_hash || value.metadata?.screenshot?.image_hash) || null,
    geometry_path: geometryPath,
    geometry_ref: geometryRef,
    geometry: loadedGeometry,
    geometry_hash: cleanText(value.geometry_hash || loadedGeometry?.geometry_hash) || null,
  };
}

function uniqueStates(states) {
  const seen = new Set();
  return states.filter((state) => {
    if (seen.has(state.state_id)) return false;
    seen.add(state.state_id);
    return true;
  });
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  }
  return [...duplicates];
}

function validateCandidateArtifactManifest({ candidate, side, resolved, historical }) {
  const computed = objectValue(resolved.artifact_manifest);
  const stored = objectValue(resolved.ref?.artifact_manifest);
  const refDigest = cleanText(resolved.ref?.artifact_manifest_digest).toLowerCase();
  const storedDigest = cleanText(stored.digest).toLowerCase();
  const hashKey = side === "previous"
    ? "previous_artifact_manifest_digest"
    : "new_artifact_manifest_digest";
  const promptDigest = cleanText(candidate?.prompt_payload?.hashes?.[hashKey]).toLowerCase();
  const computedDigest = cleanText(computed.digest).toLowerCase();
  const storedPayloadDigest = digestStoredArtifactManifest(stored);
  const hasStoredBinding = Boolean(refDigest || storedDigest || promptDigest);

  if (!historical && (
    computed.complete !== true ||
    stored.complete !== true ||
    !/^[a-f0-9]{64}$/.test(computedDigest) ||
    !/^[a-f0-9]{64}$/.test(refDigest) ||
    !/^[a-f0-9]{64}$/.test(storedDigest) ||
    !/^[a-f0-9]{64}$/.test(promptDigest)
  )) {
    throw new DeterministicVisualArtifactError(
      `Candidate ${candidate.id} ${side} artifact manifest is incomplete.`,
      "visual_artifact_manifest_incomplete",
    );
  }
  if (historical && !hasStoredBinding) return;
  if (
    !computedDigest ||
    refDigest !== computedDigest ||
    storedDigest !== computedDigest ||
    storedPayloadDigest !== computedDigest ||
    (promptDigest && promptDigest !== computedDigest)
  ) {
    throw new DeterministicVisualArtifactError(
      `Candidate ${candidate.id} ${side} artifact manifest digest mismatch.`,
      "visual_artifact_manifest_digest_mismatch",
    );
  }
}

function preflightCandidateArtifactBytes({ candidate, side, resolved, historical }) {
  if (!historical) {
    const requiredFileRoles = resolved.kind === "pdf" ? ["pdf", "meta"] : ["page", "meta"];
    for (const role of requiredFileRoles) {
      assertArtifactRefManifest({
        candidateId: candidate.id,
        side,
        role,
        artifactRef: resolved.file_refs[role],
      });
      if (!cleanText(resolved.file_refs[role]?.path)) {
        throw new DeterministicVisualArtifactError(
          `Candidate ${candidate.id} ${side} ${role} path is missing.`,
          "visual_artifact_path_missing",
        );
      }
    }
  }
  const references = [
    ...Object.entries(objectValue(resolved.file_refs)).map(([role, ref]) => ({ role, ref })),
    ...resolved.states.flatMap((state) => [
      { role: `visual state ${state.state_id} image`, ref: state.image_ref },
      { role: `visual state ${state.state_id} geometry`, ref: state.geometry_ref },
    ]),
  ];
  for (const { role, ref } of references) {
    const value = objectValue(ref);
    const path = cleanText(value.path);
    if (!path) continue;
    const expectedSha256 = cleanText(value.sha256).toLowerCase();
    const expectedByteLength = nonNegativeSafeInteger(value.byte_length);
    const hasManifest = /^[a-f0-9]{64}$/.test(expectedSha256) && expectedByteLength !== null;
    if (!hasManifest) {
      if (historical) continue;
      throw new DeterministicVisualArtifactError(
        `Candidate ${candidate.id} ${side} ${role} manifest is incomplete.`,
        "visual_artifact_manifest_incomplete",
      );
    }
    if (!existsSync(path)) {
      throw new DeterministicVisualArtifactError(
        `Candidate ${candidate.id} ${side} ${role} is missing at publication.`,
        "visual_artifact_missing",
      );
    }
    const body = readFileSync(path);
    if (body.length !== expectedByteLength) {
      throw new DeterministicVisualArtifactError(
        `Candidate ${candidate.id} ${side} ${role} byte length changed after review.`,
        "visual_artifact_byte_length_mismatch",
      );
    }
    if (sha256Buffer(body) !== expectedSha256) {
      throw new DeterministicVisualArtifactError(
        `Candidate ${candidate.id} ${side} ${role} bytes changed after review.`,
        "visual_artifact_hash_mismatch",
      );
    }
  }
  if (!historical && !Object.keys(objectValue(resolved.meta)).length) {
    throw new DeterministicVisualArtifactError(
      `Candidate ${candidate.id} ${side} metadata is not readable JSON.`,
      "visual_metadata_invalid",
    );
  }
}

function digestStoredArtifactManifest(value) {
  const manifest = objectValue(value);
  const artifacts = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.map((entry) => {
        const artifact = objectValue(entry);
        return {
          role: cleanText(artifact.role),
          sha256: cleanText(artifact.sha256).toLowerCase(),
          byte_length: nonNegativeSafeInteger(artifact.byte_length),
        };
      }).filter((artifact) =>
        artifact.role && /^[a-f0-9]{64}$/.test(artifact.sha256) && artifact.byte_length !== null
      )
    : [];
  if (artifacts.length !== (Array.isArray(manifest.artifacts) ? manifest.artifacts.length : 0)) return null;
  artifacts.sort((left, right) =>
    left.role.localeCompare(right.role) ||
    left.sha256.localeCompare(right.sha256) ||
    left.byte_length - right.byte_length,
  );
  return crypto.createHash("sha256").update(stableManifestJson({ version: 1, artifacts })).digest("hex");
}

function stableManifestJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableManifestJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableManifestJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateNewWebpageStateReferences({ candidate, side, resolved }) {
  if (!/^[a-f0-9]{64}$/.test(cleanText(resolved.expected_main_hash).toLowerCase())) {
    throw new DeterministicVisualArtifactError(
      `Candidate ${candidate.id} ${side} main image hash is missing.`,
      "visual_state_image_hash_missing",
    );
  }
  if (!resolved.referenced_state_count) {
    throw new DeterministicVisualArtifactError(
      `Candidate ${candidate.id} ${side} has no explicit visual state references.`,
      "visual_state_reference_missing",
    );
  }
  const mainStates = resolved.states.filter((state) => state.kind === "main");
  if (mainStates.length !== 1) {
    throw new DeterministicVisualArtifactError(
      `Candidate ${candidate.id} ${side} must have exactly one main visual state.`,
      "visual_main_state_invalid",
    );
  }

  for (const state of resolved.states) {
    assertSemanticArtifactRef({
      candidateId: candidate.id,
      side,
      role: `visual state ${state.state_id} image`,
      semanticSha256: state.image_hash,
      artifactRef: state.image_ref,
      required: true,
    });
    if (!state.geometry_path) {
      throw new DeterministicVisualArtifactError(
        `Candidate ${candidate.id} ${side} visual state ${state.state_id} has no geometry artifact.`,
        "visual_state_geometry_missing",
      );
    }
    assertArtifactRefManifest({
      candidateId: candidate.id,
      side,
      role: `visual state ${state.state_id} geometry`,
      artifactRef: state.geometry_ref,
    });
    const loadedGeometryHash = cleanText(state.geometry?.geometry_hash).toLowerCase();
    const referencedGeometryHash = cleanText(state.geometry_hash).toLowerCase();
    if (
      !/^[a-f0-9]{64}$/.test(loadedGeometryHash) ||
      !/^[a-f0-9]{64}$/.test(referencedGeometryHash) ||
      loadedGeometryHash !== referencedGeometryHash
    ) {
      throw new DeterministicVisualArtifactError(
        `Candidate ${candidate.id} ${side} visual state ${state.state_id} geometry hash mismatch.`,
        "visual_state_geometry_hash_mismatch",
      );
    }
    const binding = verifyVisualTextGeometryBinding(state.geometry, state.image_hash);
    if (!binding.valid) {
      throw new DeterministicVisualArtifactError(
        `Candidate ${candidate.id} ${side} visual state ${state.state_id} geometry is not bound to its image.`,
        "visual_state_geometry_binding_invalid",
      );
    }
  }

  const main = mainStates[0];
  if (cleanText(main.image_hash).toLowerCase() !== cleanText(resolved.expected_main_hash).toLowerCase()) {
    throw new DeterministicVisualArtifactError(
      `Candidate ${candidate.id} ${side} main state hash disagrees with the candidate image hash.`,
      "visual_main_state_hash_mismatch",
    );
  }
  assertSameArtifactRef({
    candidateId: candidate.id,
    side,
    role: "main state image/page",
    left: main.image_ref,
    right: resolved.file_refs.page,
  });
  assertSameArtifactRef({
    candidateId: candidate.id,
    side,
    role: "main state geometry/layout",
    left: main.geometry_ref,
    right: resolved.file_refs.layout,
  });
}

function assertSemanticArtifactRef({
  candidateId,
  side,
  role,
  semanticSha256,
  artifactRef,
  required,
}) {
  const semantic = cleanText(semanticSha256).toLowerCase();
  const ref = objectValue(artifactRef);
  const artifactSha = cleanText(ref.sha256).toLowerCase();
  const artifactBytes = nonNegativeSafeInteger(ref.byte_length);
  if (required && (!/^[a-f0-9]{64}$/.test(semantic) || !/^[a-f0-9]{64}$/.test(artifactSha) || artifactBytes === null)) {
    throw new DeterministicVisualArtifactError(
      `Candidate ${candidateId} ${side} ${role} manifest is incomplete.`,
      "visual_artifact_manifest_incomplete",
    );
  }
  if (semantic && artifactSha && semantic !== artifactSha) {
    throw new DeterministicVisualArtifactError(
      `Candidate ${candidateId} ${side} ${role} semantic hash mismatch.`,
      "visual_artifact_semantic_hash_mismatch",
    );
  }
}

function assertArtifactRefManifest({ candidateId, side, role, artifactRef }) {
  const ref = objectValue(artifactRef);
  if (
    !/^[a-f0-9]{64}$/.test(cleanText(ref.sha256).toLowerCase()) ||
    nonNegativeSafeInteger(ref.byte_length) === null
  ) {
    throw new DeterministicVisualArtifactError(
      `Candidate ${candidateId} ${side} ${role} manifest is incomplete.`,
      "visual_artifact_manifest_incomplete",
    );
  }
}

function assertSameArtifactRef({ candidateId, side, role, left, right }) {
  const leftValue = objectValue(left);
  const rightValue = objectValue(right);
  if (
    cleanText(leftValue.sha256).toLowerCase() !== cleanText(rightValue.sha256).toLowerCase() ||
    nonNegativeSafeInteger(leftValue.byte_length) !== nonNegativeSafeInteger(rightValue.byte_length)
  ) {
    throw new DeterministicVisualArtifactError(
      `Candidate ${candidateId} ${side} ${role} references different artifact bytes.`,
      "visual_artifact_role_binding_mismatch",
    );
  }
}

function verifiedStateGeometryHash(geometry, imageHash) {
  const value = objectValue(geometry);
  const binding = verifyVisualTextGeometryBinding(value, imageHash);
  return binding.valid ? cleanText(value.geometry_hash).toLowerCase() || null : null;
}

function resolvePathRef(value, archiveRoot) {
  if (!value) return null;
  if (typeof value === "string") {
    return isAbsolute(value) ? value : resolve(archiveRoot, value);
  }
  const ref = objectValue(value);
  const direct = cleanText(ref.path);
  if (direct && isAbsolute(direct) && existsSync(direct)) return direct;
  const archiveRelative = cleanText(ref.archive_relative);
  if (archiveRelative) return resolve(archiveRoot, archiveRelative);
  if (direct && isAbsolute(direct)) return direct;
  return direct ? resolve(archiveRoot, direct) : null;
}

function resolveArtifactPathRef(value, archiveRoot) {
  const ref = objectValue(value);
  return {
    path: resolvePathRef(value, archiveRoot),
    sha256: cleanText(ref.sha256).toLowerCase() || null,
    byte_length: nonNegativeSafeInteger(ref.byte_length ?? ref.bytes),
  };
}

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function assertCandidateIdentity(candidate, source) {
  if (!cleanText(candidate?.id)) throw new Error("Visual evidence publication requires a candidate ID.");
  if (!cleanText(candidate?.candidate_signature)) throw new Error("Visual evidence publication requires a candidate signature.");
  if (!cleanText(candidate?.shared_award_id)) throw new Error("Visual evidence publication requires an award ID.");
  if (!cleanText(candidate?.shared_award_source_id)) throw new Error("Visual evidence publication requires a source ID.");
  if (source?.id && source.id !== candidate.shared_award_source_id) {
    throw new Error("Visual evidence candidate/source identity mismatch.");
  }
  if (source?.shared_award_id && source.shared_award_id !== candidate.shared_award_id) {
    throw new Error("Visual evidence candidate/award identity mismatch.");
  }
}

function integerClip(value) {
  const rect = objectValue(value);
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  };
}

export function visualStateGeometryMatchesImage(geometryValue, imageValue) {
  const screenshot = objectValue(objectValue(geometryValue).screenshot);
  const image = objectValue(imageValue);
  const expectedWidth = Number(screenshot.pixel_width);
  const expectedHeight = Number(screenshot.pixel_height);
  const actualWidth = Number(image.width);
  const actualHeight = Number(image.height);
  const actualSha256 = cleanText(image.sha256);
  const binding = verifyVisualTextGeometryBinding(geometryValue, actualSha256 || null);
  return binding.valid && [expectedWidth, expectedHeight, actualWidth, actualHeight].every(
    (value) => Number.isFinite(value) && value > 0,
  ) && expectedWidth === actualWidth && expectedHeight === actualHeight;
}

function extensionFor(path, contentType) {
  const extension = extname(path || "").replace(/^\./, "");
  if (extension) return extension;
  if (contentType?.startsWith("image/")) return contentType.slice(6).replace("jpeg", "jpg");
  if (contentType === "application/pdf") return "pdf";
  if (contentType?.startsWith("application/json")) return "json";
  return "txt";
}

function safeExtension(value) {
  const extension = cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  return extension || "bin";
}

function safeKeySegment(value, fallback) {
  const segment = cleanText(value).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return segment || fallback;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nonNegativeSafeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown historical artifact error");
}
