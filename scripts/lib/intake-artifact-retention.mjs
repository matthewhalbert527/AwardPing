import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab0-9a-f][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const namespace = "source-intake-first-observation";
const schemaVersion = 1;
const artifactFiles = {
  pdf: { name: "document.pdf", contentType: "application/pdf" },
  text: { name: "text.txt", contentType: "text/plain; charset=utf-8" },
  capture_metadata: { name: "capture.json", contentType: "application/json" },
};

export const POST_RETENTION_CAPTURE_FAILURE_REASON =
  "source_intake_post_retention_processing_failed";
export const POST_RETENTION_CAPTURE_PERSISTENCE_UNVERIFIED_REASON =
  "source_intake_post_retention_persistence_unverified_manual_only";

export class IntakeArtifactRetentionError extends Error {
  constructor(code, message, solution = null) {
    super(message);
    this.name = "IntakeArtifactRetentionError";
    this.code = code;
    this.solution = solution || intakeArtifactFailureSolution(code);
  }
}

export function intakeArtifactFailureSolution(code) {
  if (/r2_(configuration|upload|read|verification)/.test(String(code || ""))) {
    return "Verify the configured R2 credentials and immutable intake-artifact bucket, then retry this same new-page request. Do not accept or baseline a fresh download in its place.";
  }
  if (/local_(conflict|unsafe)/.test(String(code || ""))) {
    return "Preserve the conflicting local path for audit, compare it with the sealed R2 object, then relocate only the invalid cache entry and retry. Never overwrite sealed evidence in place.";
  }
  return "Keep this item in manual quarantine, verify the request-bound R2 PDF/text/metadata and their hashes, then retry the same zero-charge materialization. Do not substitute the document currently served by the URL.";
}

export function requiresFirstObservationArtifactRetention(request, capture) {
  if (cleanText(request?.acquisition_kind) !== "live_discovery") return false;
  if (cleanText(request?.notification_mode) !== "first_capture_candidate") return false;
  if (cleanText(request?.onboarding_batch_id)) return false;
  const contentType = cleanText(capture?.content_type);
  const finalUrl = cleanText(capture?.canonical_url || capture?.final_url);
  return /pdf/i.test(contentType) || /\.pdf(?:$|[?#])/i.test(finalUrl);
}

/**
 * Builds the request metadata that binds a reviewed capture to its immutable
 * retained artifact without serializing the PDF bytes into Postgres.
 */
export function serializableRetainedCaptureMetadata(capture, retainedArtifact) {
  const source = objectValue(capture);
  const captureFields = { ...source };
  delete captureFields.artifact_bytes;
  delete captureFields.links;
  delete captureFields.pdf_links;
  delete captureFields.retained_artifact;
  delete captureFields.retained_artifact_staged;
  return jsonSafeClone({
    ...captureFields,
    retained_artifact: retainedArtifact,
    text_excerpt: String(source.text || "").slice(0, 20_000),
    text_length: String(source.text || "").length,
  });
}

/**
 * Persists a completed retained-artifact identity if processing fails after
 * retention. Callers receive an explicit proof result and must fail closed
 * when the write cannot be confirmed.
 */
export async function persistPostRetentionCaptureFailure({
  persist,
  captureMetadata,
  discoveredLinks = null,
  processingError,
  statusReason = POST_RETENTION_CAPTURE_FAILURE_REASON,
  solution = "use the verified saved capture for review; do not fetch the source URL again",
  now = new Date().toISOString(),
} = {}) {
  if (typeof persist !== "function") throw new TypeError("persist must be a function");
  const metadata = objectValue(captureMetadata);
  const hasCaptureMetadata = Object.keys(metadata).length > 0;
  const patch = {
    status: "needs_manual_review",
    status_reason: cleanText(statusReason) || POST_RETENTION_CAPTURE_FAILURE_REASON,
    worker_run_id: null,
    failed_at: now,
    error: (
      `${errorText(processingError)} Safe action: ${cleanText(solution) ||
        "inspect immutable capture storage and do not fetch the source URL again"}.`
    ).slice(0, 1000),
    ...(hasCaptureMetadata ? { capture_metadata: jsonSafeClone(metadata) } : {}),
    ...(discoveredLinks ? { discovered_links: jsonSafeClone(discoveredLinks) } : {}),
  };
  try {
    const row = await persist(patch);
    return { persisted: Boolean(row), row: row || null, patch, persistenceError: null };
  } catch (persistenceError) {
    return { persisted: false, row: null, patch, persistenceError };
  }
}

/**
 * Retains the exact bytes reviewed by new-page intake. The returned object is
 * safe to serialize: it contains only immutable keys, hashes, and lengths.
 */
export async function retainFirstObservationIntakePdfArtifact({
  request,
  capture,
  archiveRoot,
  bucket: bucketValue = null,
  config = null,
  client = null,
  sendCommand = null,
} = {}) {
  if (!requiresFirstObservationArtifactRetention(request, capture)) return null;
  const requestId = requireUuid(request?.id, "request_id");
  const bytes = capture?.artifact_bytes;
  if (!Buffer.isBuffer(bytes)) {
    refuse(
      "intake_pdf_bytes_unavailable",
      "The source-intake capture did not expose its exact PDF bytes for retention.",
    );
  }
  const fileHash = sha256(bytes);
  const capturedHash = cleanText(capture?.capture_file_hash).toLowerCase();
  if (!sameHash(fileHash, capturedHash)) {
    refuse(
      "intake_pdf_hash_mismatch",
      "The exposed PDF bytes do not match the source-intake capture hash.",
    );
  }
  if (Number(capture?.byte_length) !== bytes.length) {
    refuse(
      "intake_pdf_length_mismatch",
      "The exposed PDF bytes do not match the source-intake capture length.",
    );
  }
  const capturedAt = canonicalTimestamp(capture?.captured_at, "captured_at");
  const finalUrl = requireAbsoluteHttpUrl(capture?.canonical_url || capture?.final_url, "final_url");
  const text = canonicalCapturedText(capture?.text);
  const textBytes = Buffer.from(`${text}\n`, "utf8");
  const textHash = sha256(Buffer.from(text, "utf8"));
  const prefix = artifactPrefix(requestId, fileHash);
  const captureMetadata = {
    schema_version: schemaVersion,
    namespace,
    request_id: requestId,
    captured_at: capturedAt,
    final_url: finalUrl,
    content_type: cleanText(capture?.content_type) || "application/pdf",
    status_code: positiveInteger(capture?.status_code) || null,
    page_title: cleanNullable(capture?.title),
    page_count: positiveInteger(capture?.page_count) || null,
    pdf_text_error: cleanNullable(capture?.pdf_text_error),
    file_hash: fileHash,
    file_bytes: bytes.length,
    text_hash: textHash,
    text_length: text.length,
    files: {
      pdf: artifactFiles.pdf.name,
      text: artifactFiles.text.name,
      capture_metadata: artifactFiles.capture_metadata.name,
    },
  };
  const metadataBytes = canonicalJsonBytes(captureMetadata);
  const payloads = {
    pdf: bytes,
    text: textBytes,
    capture_metadata: metadataBytes,
  };
  const artifacts = Object.fromEntries(
    Object.entries(payloads).map(([role, body]) => [
      role,
      {
        key: `${prefix}/${artifactFiles[role].name}`,
        sha256: sha256(body),
        byte_length: body.length,
        content_type: artifactFiles[role].contentType,
      },
    ]),
  );

  const bucket = cleanText(bucketValue || config?.bucket);
  const storeId = normalizedR2StoreId(config);
  const root = requireArchiveRoot(archiveRoot);
  const localDir = intakeCacheDirectory(root, requestId, fileHash);
  const stagedManifest = {
    schema_version: schemaVersion,
    namespace,
    request_id: requestId,
    captured_at: capturedAt,
    final_url: finalUrl,
    prefix,
    file_hash: fileHash,
    file_bytes: bytes.length,
    text_hash: textHash,
    text_length: text.length,
    artifacts,
    r2_bucket: bucket || null,
    r2_store_id: storeId || null,
    r2_verified_at: null,
    local_cache: {
      directory: archiveRelative(root, localDir),
      pdf: archiveRelative(root, join(localDir, artifactFiles.pdf.name)),
      text: archiveRelative(root, join(localDir, artifactFiles.text.name)),
      capture_metadata: archiveRelative(root, join(localDir, artifactFiles.capture_metadata.name)),
    },
  };
  for (const [role, body] of Object.entries(payloads)) {
    writeImmutableVerified(join(localDir, artifactFiles[role].name), body, {
      code: "intake_local_conflict",
      label: `local intake ${role}`,
      archiveRoot: root,
    });
  }

  const r2Client = client || createR2Client(config);
  if (!bucket || !storeId || !r2Client) {
    const error = new IntakeArtifactRetentionError(
      "intake_r2_configuration_missing",
      "R2 is required before a live first-capture PDF can proceed to paid review.",
    );
    error.details = {
      staged_manifest: stagedManifest,
      local_cache_verified: true,
    };
    throw error;
  }
  let ownedClient = null;
  if (!client) ownedClient = r2Client;
  try {
    for (const [role, artifact] of Object.entries(artifacts)) {
      await putImmutableAndVerify({
        client: r2Client,
        sendCommand,
        bucket,
        artifact,
        body: payloads[role],
        metadata: {
          sha256: artifact.sha256,
          request_id: requestId,
          file_sha256: fileHash,
          artifact_role: role,
          namespace,
        },
      });
    }
  } catch (error) {
    if (error && typeof error === "object") {
      error.details = {
        ...(objectValue(error.details)),
        staged_manifest: stagedManifest,
        local_cache_verified: true,
      };
    }
    throw error;
  } finally {
    try {
      ownedClient?.destroy?.();
    } catch {
      // Retention integrity is independent of client cleanup.
    }
  }

  return {
    ...stagedManifest,
    r2_verified_at: new Date().toISOString(),
  };
}

/** Completes a failed R2 upload from the already hash-verified local cache. */
export async function resumeFirstObservationIntakeArtifactRetention({
  stagedManifest,
  archiveRoot,
  bucket: bucketValue = null,
  config = null,
  client = null,
  sendCommand = null,
} = {}) {
  let manifest = validateRetainedIntakeArtifactManifest(stagedManifest, {
    allowUnboundR2Target: true,
  });
  const bucket = cleanText(bucketValue || config?.bucket);
  const storeId = normalizedR2StoreId(config);
  if (!bucket || !storeId) {
    refuse("intake_r2_configuration_missing", "R2 is required to finish staged intake artifact retention.");
  }
  if (
    canonicalTimestampOrNull(manifest.r2_verified_at) &&
    (!manifest.r2_bucket || !manifest.r2_store_id)
  ) {
    refuse(
      "intake_artifact_r2_target_mismatch",
      "A purportedly verified manifest cannot bind an R2 target during recovery.",
    );
  }
  if (manifest.r2_bucket && manifest.r2_bucket !== bucket) {
    refuse("intake_artifact_r2_target_mismatch", "The staged R2 bucket differs from the configured recovery target.");
  }
  if (manifest.r2_store_id && manifest.r2_store_id !== storeId) {
    refuse("intake_artifact_r2_target_mismatch", "The staged R2 store differs from the configured recovery target.");
  }
  // An upload that never started may truthfully have no store identity. Bind
  // that staged manifest once, before any PUT; completed manifests can never
  // be rebound because validation below requires the verified target.
  manifest = {
    ...manifest,
    r2_bucket: manifest.r2_bucket || bucket,
    r2_store_id: manifest.r2_store_id || storeId,
  };
  validateR2TargetBinding(manifest, { bucket, storeId });
  const root = requireArchiveRoot(archiveRoot);
  const localDir = intakeCacheDirectory(root, manifest.request_id, manifest.file_hash);
  const local = inspectLocalArtifacts(localDir, manifest);
  if (!local.complete || local.conflicts.length) {
    refuse(
      "intake_local_conflict",
      "The staged intake artifact cannot be resumed because its exact local cache is missing or conflicting.",
    );
  }
  // Parsing verifies semantic text/capture metadata bindings before upload.
  parseLoadedArtifact(local, manifest);
  const r2Client = client || createR2Client(config);
  if (!bucket || !storeId || !r2Client) {
    refuse("intake_r2_configuration_missing", "R2 is required to finish staged intake artifact retention.");
  }
  let ownedClient = null;
  if (!client) ownedClient = r2Client;
  try {
    for (const [role, artifact] of Object.entries(manifest.artifacts)) {
      await putImmutableAndVerify({
        client: r2Client,
        sendCommand,
        bucket,
        artifact,
        body: local.values[role].body,
        metadata: {
          sha256: artifact.sha256,
          request_id: manifest.request_id,
          file_sha256: manifest.file_hash,
          artifact_role: role,
          namespace,
        },
      });
    }
  } catch (error) {
    if (error && typeof error === "object") {
      error.details = {
        ...(objectValue(error.details)),
        staged_manifest: manifest,
        local_cache_verified: true,
      };
    }
    throw error;
  } finally {
    try {
      ownedClient?.destroy?.();
    } catch {
      // Retention integrity is independent of client cleanup.
    }
  }
  return { ...manifest, r2_verified_at: new Date().toISOString() };
}

/**
 * Turns the sealed intake artifact into the ordinary PDF capture consumed by
 * baseline/candidate code. It never fetches the live source URL.
 */
export async function materializeFirstObservationCaptureFromAcquisition({
  archiveRoot,
  source,
  acquisition,
  bucket: bucketValue = null,
  config = null,
  client = null,
  sendCommand = null,
} = {}) {
  const identity = validateAcquisitionArtifactBinding({ source, acquisition });
  const root = requireArchiveRoot(archiveRoot);
  const cache = await loadVerifiedIntakeArtifact({
    archiveRoot: root,
    manifest: identity.manifest,
    bucket: bucketValue,
    config,
    client,
    sendCommand,
  });
  const captureStamp = timestampForPath(identity.manifest.captured_at);
  const captureDir = join(root, "sources", identity.sourceId, "captures", captureStamp);
  const pdfPath = join(captureDir, artifactFiles.pdf.name);
  const textPath = join(captureDir, artifactFiles.text.name);
  const metaPath = join(captureDir, "meta.json");
  const relativeFiles = {
    pdf: archiveRelative(root, pdfPath),
    text: archiveRelative(root, textPath),
    meta: archiveRelative(root, metaPath),
  };
  const retainedMetadata = cache.captureMetadata;
  const meta = {
    version: 1,
    kind: "pdf",
    artifact_origin: "sealed_source_intake",
    source: {
      id: identity.sourceId,
      shared_award_id: identity.awardId,
      source_acquisition_id: identity.acquisitionId,
      source_page_request_id: identity.requestId,
      url: identity.finalUrl,
      page_type: "pdf",
    },
    captured_at: identity.manifest.captured_at,
    final_url: identity.finalUrl,
    status_code: retainedMetadata.status_code,
    status_text: null,
    content_type: retainedMetadata.content_type,
    file_hash: identity.manifest.file_hash,
    image_hash: identity.manifest.file_hash,
    text_hash: identity.manifest.text_hash,
    text_length: identity.manifest.text_length,
    file_bytes: identity.manifest.file_bytes,
    page_title: retainedMetadata.page_title,
    page_count: retainedMetadata.page_count,
    pdf_text_error: retainedMetadata.pdf_text_error,
    retained_intake_artifact: {
      schema_version: schemaVersion,
      namespace,
      request_id: identity.requestId,
      acquisition_id: identity.acquisitionId,
      prefix: identity.manifest.prefix,
      capture_metadata_sha256: identity.manifest.artifacts.capture_metadata.sha256,
    },
    files: relativeFiles,
  };
  const metaBytes = canonicalJsonBytes(meta);
  writeImmutableVerified(pdfPath, cache.pdfBytes, {
    code: "intake_materialization_local_conflict",
    label: "materialized intake PDF",
    archiveRoot: root,
  });
  writeImmutableVerified(textPath, cache.textBytes, {
    code: "intake_materialization_local_conflict",
    label: "materialized intake text",
    archiveRoot: root,
  });
  writeImmutableVerified(metaPath, metaBytes, {
    code: "intake_materialization_local_conflict",
    label: "materialized intake metadata",
    archiveRoot: root,
  });

  return {
    ...meta,
    dir: captureDir,
    pdf_path: pdfPath,
    text_path: textPath,
    meta_path: metaPath,
    text: cache.text,
    intake_artifact_local_cache_rehydrated: cache.localCacheRehydrated,
    retained_intake_artifact: identity.manifest,
  };
}

/**
 * Recreates the exact candidate-local PDF/text/meta paths from acquisition R2
 * when the rotating visual-snapshot pointer no longer retains generation A.
 */
export async function restoreInitialOfficialDocumentCandidateArtifactsFromAcquisition({
  archiveRoot,
  source,
  acquisition,
  candidate,
  bucket = null,
  config = null,
  client = null,
  sendCommand = null,
} = {}) {
  try {
    if (cleanText(candidate?.candidate_scope) !== "initial_official_document") {
      refuse("candidate_acquisition_restore_scope_invalid", "Only an initial-document candidate can use intake-artifact recovery.");
    }
    if (cleanText(candidate?.source_acquisition_id) !== cleanText(acquisition?.id)) {
      refuse("candidate_acquisition_restore_binding_mismatch", "The candidate is not bound to this immutable acquisition.");
    }
    const capture = await materializeFirstObservationCaptureFromAcquisition({
      archiveRoot,
      source,
      acquisition,
      bucket,
      config,
      client,
      sendCommand,
    });
    validateCaptureAgainstCandidate(capture, candidate, archiveRoot);
    return {
      restored: true,
      reason: "exact_acquisition_intake_artifact_restored",
      artifact_count: 3,
      restored_roles: ["pdf", "text", "meta"],
      source_acquisition_id: acquisition.id,
      request_id: acquisition.origin_source_page_request_id,
    };
  } catch (error) {
    return {
      restored: false,
      reason: error?.code || "candidate_acquisition_restore_failed",
      detail: cleanText(error?.message || error),
      solution: error?.solution || intakeArtifactFailureSolution(error?.code),
    };
  }
}

export function validateRetainedIntakeArtifactManifest(value, {
  requestId = null,
  fileHash = null,
  finalUrl = null,
  requireR2Verified = false,
  r2Bucket = null,
  r2StoreId = null,
  allowUnboundR2Target = false,
} = {}) {
  const manifest = objectValue(value);
  if (Number(manifest.schema_version) !== schemaVersion || manifest.namespace !== namespace) {
    refuse("intake_artifact_manifest_schema_invalid", "The retained intake artifact schema or namespace is invalid.");
  }
  const actualRequestId = requireUuid(manifest.request_id, "artifact request_id");
  const actualFileHash = requireSha256(manifest.file_hash, "artifact file_hash");
  const actualFinalUrl = requireAbsoluteHttpUrl(manifest.final_url, "artifact final_url");
  if (requestId && actualRequestId !== cleanText(requestId)) {
    refuse("intake_artifact_request_binding_mismatch", "The retained artifact belongs to another source-intake request.");
  }
  if (fileHash && !sameHash(actualFileHash, fileHash)) {
    refuse("intake_artifact_file_binding_mismatch", "The retained artifact PDF hash differs from the sealed acquisition.");
  }
  if (finalUrl && actualFinalUrl !== requireAbsoluteHttpUrl(finalUrl, "sealed final_url")) {
    refuse("intake_artifact_url_binding_mismatch", "The retained artifact final URL differs from the sealed acquisition.");
  }
  const expectedPrefix = artifactPrefix(actualRequestId, actualFileHash);
  if (cleanText(manifest.prefix) !== expectedPrefix) {
    refuse("intake_artifact_prefix_invalid", "The retained artifact prefix is not request/hash bound.");
  }
  const artifacts = objectValue(manifest.artifacts);
  for (const [role, definition] of Object.entries(artifactFiles)) {
    const artifact = objectValue(artifacts[role]);
    const expectedKey = `${expectedPrefix}/${definition.name}`;
    if (cleanText(artifact.key) !== expectedKey) {
      refuse("intake_artifact_key_invalid", `The retained ${role} key is outside the immutable request namespace.`);
    }
    requireSha256(artifact.sha256, `${role} sha256`);
    if (!Number.isSafeInteger(Number(artifact.byte_length)) || Number(artifact.byte_length) < 0) {
      refuse("intake_artifact_length_invalid", `The retained ${role} length is invalid.`);
    }
    if (cleanText(artifact.content_type) !== definition.contentType) {
      refuse("intake_artifact_content_type_invalid", `The retained ${role} content type is invalid.`);
    }
  }
  if (!sameHash(artifacts.pdf.sha256, actualFileHash)) {
    refuse("intake_artifact_pdf_hash_invalid", "The retained PDF object hash does not equal the sealed capture hash.");
  }
  if (requireR2Verified && !canonicalTimestampOrNull(manifest.r2_verified_at)) {
    refuse("intake_artifact_r2_verification_missing", "The retained artifact has no completed R2 verification timestamp.");
  }
  const manifestBucket = cleanText(manifest.r2_bucket);
  const manifestStoreId = cleanText(manifest.r2_store_id).toLowerCase();
  if ((!manifestBucket && !allowUnboundR2Target) || (manifestBucket && (
    manifestBucket.length > 255 || !/^[a-z0-9][a-z0-9._-]*$/i.test(manifestBucket)
  ))) {
    refuse("intake_artifact_r2_bucket_invalid", "The retained artifact R2 bucket binding is invalid.");
  }
  if ((!manifestStoreId && !allowUnboundR2Target) || (manifestStoreId && (
    manifestStoreId.length > 255 || !/^[a-z0-9][a-z0-9.:-]*$/i.test(manifestStoreId)
  ))) {
    refuse("intake_artifact_r2_store_invalid", "The retained artifact R2 store identity is invalid.");
  }
  if (r2Bucket || r2StoreId) {
    validateR2TargetBinding(
      { ...manifest, r2_bucket: manifestBucket, r2_store_id: manifestStoreId },
      { bucket: cleanText(r2Bucket), storeId: cleanText(r2StoreId).toLowerCase() },
    );
  }
  const capturedAt = canonicalTimestamp(manifest.captured_at, "artifact captured_at");
  const fileBytes = Number(manifest.file_bytes);
  const textLength = Number(manifest.text_length);
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 1 || fileBytes !== Number(artifacts.pdf.byte_length)) {
    refuse("intake_artifact_pdf_length_invalid", "The retained PDF length binding is invalid.");
  }
  if (!Number.isSafeInteger(textLength) || textLength < 0) {
    refuse("intake_artifact_text_length_invalid", "The retained text length binding is invalid.");
  }
  return {
    ...manifest,
    request_id: actualRequestId,
    file_hash: actualFileHash,
    final_url: actualFinalUrl,
    captured_at: capturedAt,
    file_bytes: fileBytes,
    text_length: textLength,
    text_hash: requireSha256(manifest.text_hash, "artifact text_hash"),
    r2_bucket: manifestBucket,
    r2_store_id: manifestStoreId,
    artifacts,
  };
}

function validateAcquisitionArtifactBinding({ source, acquisition }) {
  const sourceId = requireUuid(source?.id, "source id");
  const awardId = requireUuid(source?.shared_award_id, "award id");
  const acquisitionId = requireUuid(acquisition?.id, "acquisition id");
  if (cleanText(acquisition?.shared_award_source_id) !== sourceId) {
    refuse("intake_artifact_source_binding_mismatch", "The acquisition belongs to another source.");
  }
  if (cleanText(acquisition?.notification_mode) !== "first_capture_candidate") {
    refuse("intake_artifact_acquisition_mode_invalid", "The acquisition is not eligible for first-capture materialization.");
  }
  const requestId = requireUuid(acquisition?.origin_source_page_request_id, "acquisition request id");
  const reviewSeal = objectValue(acquisition?.review_seal);
  const metadata = objectValue(acquisition?.metadata);
  const sealManifest = validateRetainedIntakeArtifactManifest(reviewSeal.retained_artifact, {
    requestId,
    fileHash: reviewSeal.capture_file_hash,
    finalUrl: reviewSeal.capture_final_url,
    requireR2Verified: true,
  });
  const metadataManifest = validateRetainedIntakeArtifactManifest(metadata.retained_artifact, {
    requestId,
    fileHash: reviewSeal.capture_file_hash,
    finalUrl: reviewSeal.capture_final_url,
    requireR2Verified: true,
  });
  if (canonicalJson(sealManifest) !== canonicalJson(metadataManifest)) {
    refuse("intake_artifact_acquisition_manifest_mismatch", "The acquisition seal and metadata retain different artifacts.");
  }
  const sourceUrl = requireAbsoluteHttpUrl(source?.url, "source url");
  if (sourceUrl !== sealManifest.final_url) {
    refuse("intake_artifact_source_url_mismatch", "The source URL differs from the exact URL sealed with the retained artifact.");
  }
  const serverBinding = objectValue(metadata.server_artifact_binding);
  if (
    cleanText(serverBinding.source_id) !== sourceId ||
    cleanText(serverBinding.acquisition_id) !== acquisitionId ||
    cleanText(serverBinding.request_id) !== requestId ||
    !sameHash(serverBinding.file_hash, sealManifest.file_hash) ||
    cleanText(serverBinding.final_url) !== sourceUrl ||
    cleanText(serverBinding.artifact_prefix) !== sealManifest.prefix
  ) {
    refuse(
      "intake_artifact_server_binding_mismatch",
      "The server-sealed source/acquisition/request binding does not match the retained artifact.",
    );
  }
  return {
    sourceId,
    awardId,
    acquisitionId,
    requestId,
    finalUrl: sourceUrl,
    manifest: sealManifest,
  };
}

async function loadVerifiedIntakeArtifact({
  archiveRoot,
  manifest: rawManifest,
  bucket: bucketValue,
  config,
  client,
  sendCommand,
}) {
  const bucket = cleanText(bucketValue || config?.bucket);
  const storeId = normalizedR2StoreId(config);
  const manifest = validateRetainedIntakeArtifactManifest(rawManifest, {
    r2Bucket: bucket,
    r2StoreId: storeId,
  });
  const localDir = intakeCacheDirectory(archiveRoot, manifest.request_id, manifest.file_hash);
  const local = inspectLocalArtifacts(localDir, manifest);
  if (local.complete) return { ...parseLoadedArtifact(local, manifest), localCacheRehydrated: false };
  if (local.conflicts.length) {
    refuse(
      "intake_local_conflict",
      `The immutable local intake cache conflicts with the sealed manifest (${local.conflicts.join(", ")}).`,
    );
  }

  const r2Client = client || createR2Client(config);
  if (!bucket || !storeId || !r2Client) {
    refuse("intake_r2_configuration_missing", "R2 is required to rehydrate the missing intake artifact cache.");
  }
  let ownedClient = null;
  if (!client) ownedClient = r2Client;
  try {
    for (const [role, artifact] of Object.entries(manifest.artifacts)) {
      const body = await getAndVerify({
        client: r2Client,
        sendCommand,
        bucket,
        artifact,
        requestId: manifest.request_id,
        fileHash: manifest.file_hash,
        role,
      });
      writeImmutableVerified(join(localDir, artifactFiles[role].name), body, {
        code: "intake_local_conflict",
        label: `rehydrated intake ${role}`,
        archiveRoot,
      });
    }
  } finally {
    try {
      ownedClient?.destroy?.();
    } catch {
      // The verified local result is independent of client cleanup.
    }
  }
  const restored = inspectLocalArtifacts(localDir, manifest);
  if (!restored.complete || restored.conflicts.length) {
    refuse("intake_r2_verification_failed", "R2 rehydration did not produce the exact sealed intake artifact.");
  }
  return { ...parseLoadedArtifact(restored, manifest), localCacheRehydrated: true };
}

function inspectLocalArtifacts(localDir, manifest) {
  const values = {};
  const missing = [];
  const conflicts = [];
  for (const [role, artifact] of Object.entries(manifest.artifacts)) {
    const path = join(localDir, artifactFiles[role].name);
    if (!existsSync(path)) {
      missing.push(role);
      continue;
    }
    if (lstatSync(path).isSymbolicLink()) {
      conflicts.push(role);
      continue;
    }
    const body = readFileSync(path);
    if (body.length !== Number(artifact.byte_length) || !sameHash(sha256(body), artifact.sha256)) {
      conflicts.push(role);
      continue;
    }
    values[role] = { path, body };
  }
  return { complete: !missing.length && !conflicts.length, missing, conflicts, values };
}

function parseLoadedArtifact(local, manifest) {
  const metadata = parseJson(local.values.capture_metadata.body, "intake_capture_metadata_invalid");
  if (
    metadata.namespace !== namespace ||
    metadata.request_id !== manifest.request_id ||
    metadata.captured_at !== manifest.captured_at ||
    metadata.final_url !== manifest.final_url ||
    !sameHash(metadata.file_hash, manifest.file_hash) ||
    Number(metadata.file_bytes) !== manifest.file_bytes ||
    !sameHash(metadata.text_hash, manifest.text_hash) ||
    Number(metadata.text_length) !== manifest.text_length
  ) {
    refuse("intake_capture_metadata_binding_mismatch", "The retained capture metadata does not match the acquisition manifest.");
  }
  const textFile = local.values.text.body.toString("utf8");
  const text = textFile.endsWith("\n") ? textFile.slice(0, -1) : textFile;
  if (text.length !== manifest.text_length || !sameHash(sha256(Buffer.from(text, "utf8")), manifest.text_hash)) {
    refuse("intake_text_semantic_hash_mismatch", "The retained text does not match its sealed semantic hash.");
  }
  return {
    pdfBytes: local.values.pdf.body,
    textBytes: local.values.text.body,
    metadataBytes: local.values.capture_metadata.body,
    captureMetadata: metadata,
    text,
  };
}

function validateCaptureAgainstCandidate(capture, candidate, archiveRoot) {
  if (!sameHash(candidate?.new_file_hash, capture.file_hash) || !sameHash(candidate?.new_text_hash, capture.text_hash)) {
    refuse("candidate_acquisition_restore_hash_mismatch", "The retained acquisition artifact differs from candidate semantic hashes.");
  }
  const ref = objectValue(candidate?.new_snapshot_ref);
  const paths = objectValue(ref.local_paths);
  const expected = {
    pdf: capture.pdf_path,
    text: capture.text_path,
    meta: capture.meta_path,
  };
  for (const [role, path] of Object.entries(expected)) {
    const pathRef = objectValue(paths[role]);
    const relativePath = archiveRelative(requireArchiveRoot(archiveRoot), path);
    if (cleanText(pathRef.archive_relative) !== relativePath) {
      refuse("candidate_acquisition_restore_path_mismatch", `The candidate ${role} path differs from deterministic materialization.`);
    }
    const body = readFileSync(path);
    if (body.length !== Number(pathRef.byte_length) || !sameHash(sha256(body), pathRef.sha256)) {
      refuse("candidate_acquisition_restore_artifact_mismatch", `The materialized ${role} bytes differ from the immutable candidate manifest.`);
    }
  }
}

async function putImmutableAndVerify({ client, sendCommand, bucket, artifact, body, metadata }) {
  try {
    await sendR2(
      client,
      sendCommand,
      new PutObjectCommand({
        Bucket: bucket,
        Key: artifact.key,
        Body: body,
        ContentType: artifact.content_type,
        ContentLength: body.length,
        IfNoneMatch: "*",
        Metadata: metadata,
      }),
    );
  } catch (error) {
    if (!isPreconditionFailure(error)) {
      refuse("intake_r2_upload_failed", `Immutable R2 upload failed for ${artifact.key}: ${cleanText(error?.message || error)}`);
    }
  }
  await getAndVerify({
    client,
    sendCommand,
    bucket,
    artifact,
    requestId: metadata.request_id,
    fileHash: metadata.file_sha256,
    role: metadata.artifact_role,
  });
}

async function getAndVerify({ client, sendCommand, bucket, artifact, requestId, fileHash, role }) {
  let response;
  try {
    response = await sendR2(
      client,
      sendCommand,
      new GetObjectCommand({ Bucket: bucket, Key: artifact.key }),
    );
  } catch (error) {
    refuse("intake_r2_read_failed", `R2 read failed for ${artifact.key}: ${cleanText(error?.message || error)}`);
  }
  const body = await responseBodyToBuffer(response?.Body);
  const remoteMetadata = objectValue(response?.Metadata);
  if (
    body.length !== Number(artifact.byte_length) ||
    !sameHash(sha256(body), artifact.sha256) ||
    (response?.ContentLength !== undefined && Number(response.ContentLength) !== body.length) ||
    cleanText(response?.ContentType) !== cleanText(artifact.content_type) ||
    !sameHash(remoteMetadata.sha256, artifact.sha256) ||
    cleanText(remoteMetadata.request_id) !== requestId ||
    !sameHash(remoteMetadata.file_sha256, fileHash) ||
    cleanText(remoteMetadata.artifact_role) !== role ||
    cleanText(remoteMetadata.namespace) !== namespace
  ) {
    refuse("intake_r2_verification_failed", `R2 object ${artifact.key} failed immutable hash, length, or provenance verification.`);
  }
  return body;
}

function createR2Client(config) {
  const endpoint = cleanText(config?.endpoint);
  const accessKeyId = cleanText(config?.accessKeyId);
  const secretAccessKey = cleanText(config?.secretAccessKey);
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  return new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function normalizedR2StoreId(config) {
  const explicit = cleanText(config?.storeId).toLowerCase();
  if (explicit) return explicit;
  const endpoint = cleanText(config?.endpoint);
  if (!endpoint) return "";
  try {
    const url = new URL(endpoint);
    return url.host.toLowerCase();
  } catch {
    return "";
  }
}

function validateR2TargetBinding(manifest, { bucket, storeId }) {
  if (
    !bucket ||
    !storeId ||
    cleanText(manifest?.r2_bucket) !== bucket ||
    cleanText(manifest?.r2_store_id).toLowerCase() !== storeId.toLowerCase()
  ) {
    refuse(
      "intake_artifact_r2_target_mismatch",
      "The configured R2 bucket/store does not match the immutable intake artifact binding.",
    );
  }
}

async function sendR2(client, sendCommand, command) {
  return typeof sendCommand === "function" ? sendCommand(command) : client.send(command);
}

async function responseBodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  refuse("intake_r2_read_failed", "R2 returned an unsupported response body.");
}

function writeImmutableVerified(path, body, { code, label, archiveRoot }) {
  const expected = Buffer.isBuffer(body) ? body : Buffer.from(body);
  assertSafeLocalArtifactPath(path, archiveRoot);
  mkdirSync(dirname(path), { recursive: true });
  assertSafeLocalArtifactPath(path, archiveRoot);
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) {
      refuse("intake_local_unsafe_path", `The ${label} path is a symbolic link or junction.`);
    }
    const current = readFileSync(path);
    if (current.length !== expected.length || !sameHash(sha256(current), sha256(expected))) {
      refuse(code, `The ${label} path already contains different bytes.`);
    }
    return;
  }
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staged, expected, { flag: "wx" });
    try {
      linkSync(staged, path);
    } catch (error) {
      if (!existsSync(path)) throw error;
    }
    const current = readFileSync(path);
    if (current.length !== expected.length || !sameHash(sha256(current), sha256(expected))) {
      refuse(code, `The ${label} could not be published immutably.`);
    }
  } finally {
    rmSync(staged, { force: true });
  }
}

function intakeCacheDirectory(archiveRoot, requestId, fileHash) {
  const directory = resolve(
    archiveRoot,
    "intake-artifacts",
    "requests",
    requestId,
    "sha256",
    fileHash,
  );
  if (!isPathInside(directory, archiveRoot)) refuse("intake_local_unsafe_path", "The intake cache path escapes the archive root.");
  assertSafeLocalArtifactPath(directory, archiveRoot);
  return directory;
}

function requireArchiveRoot(value) {
  const root = resolve(cleanText(value));
  if (!cleanText(value)) refuse("intake_local_unsafe_path", "An archive root is required for retained intake artifacts.");
  mkdirSync(root, { recursive: true });
  const entry = lstatSync(root);
  if (entry.isSymbolicLink() || !statSync(root).isDirectory()) {
    refuse("intake_local_unsafe_path", "The retained-artifact archive root must be a real directory, not a link or junction.");
  }
  return root;
}

function assertSafeLocalArtifactPath(path, archiveRoot) {
  const root = resolve(cleanText(archiveRoot));
  const target = resolve(path);
  if (!isPathInside(target, root)) {
    refuse("intake_local_unsafe_path", "The retained-artifact path escapes the archive root.");
  }
  const rootReal = realpathSync(root);
  const rel = relative(root, target);
  let cursor = root;
  for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) break;
    const entry = lstatSync(cursor);
    if (entry.isSymbolicLink()) {
      refuse("intake_local_unsafe_path", "A retained-artifact path ancestor is a symbolic link or junction.");
    }
    const resolvedExisting = realpathSync(cursor);
    if (!isPathInside(resolvedExisting, rootReal)) {
      refuse("intake_local_unsafe_path", "A retained-artifact path resolves outside the archive root.");
    }
  }
}

function archiveRelative(root, path) {
  const result = relative(root, resolve(path)).replace(/\\/g, "/");
  if (!result || result.startsWith("../") || isAbsolute(result)) {
    refuse("intake_local_unsafe_path", "The retained-artifact path is outside the archive root.");
  }
  return result;
}

function isPathInside(candidate, parent) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function artifactPrefix(requestId, fileHash) {
  return `${namespace}/v${schemaVersion}/requests/${requestId}/sha256/${fileHash}`;
}

function timestampForPath(value) {
  return canonicalTimestamp(value, "captured_at").replace(/[:.]/g, "-");
}

function canonicalCapturedText(value) {
  return String(value || "").replace(/\u0000/g, "").trim();
}

function canonicalJsonBytes(value) {
  return Buffer.from(JSON.stringify(sortJson(value), null, 2), "utf8");
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function jsonSafeClone(value) {
  return JSON.parse(JSON.stringify(value, (_key, candidate) =>
    typeof candidate === "bigint" ? String(candidate) : candidate));
}

function parseJson(body, code) {
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    refuse(code, `Retained capture metadata is invalid JSON: ${cleanText(error?.message || error)}`);
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameHash(left, right) {
  const a = cleanText(left).toLowerCase();
  const b = cleanText(right).toLowerCase();
  return Boolean(a && b && a === b);
}

function requireSha256(value, label) {
  const hash = cleanText(value).toLowerCase();
  if (!sha256Pattern.test(hash)) refuse("intake_artifact_hash_invalid", `${label} is not a SHA-256 hash.`);
  return hash;
}

function requireUuid(value, label) {
  const id = cleanText(value).toLowerCase();
  if (!uuidPattern.test(id)) refuse("intake_artifact_uuid_invalid", `${label} is not a UUID.`);
  return id;
}

function requireAbsoluteHttpUrl(value, label) {
  const text = cleanText(value);
  try {
    const url = new URL(text);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) throw new Error("unsafe URL");
    return url.toString();
  } catch {
    refuse("intake_artifact_url_invalid", `${label} is not a safe absolute HTTP(S) URL.`);
  }
}

function canonicalTimestamp(value, label) {
  const parsed = Date.parse(cleanText(value));
  if (!Number.isFinite(parsed)) refuse("intake_artifact_timestamp_invalid", `${label} is not a timestamp.`);
  return new Date(parsed).toISOString();
}

function canonicalTimestampOrNull(value) {
  const parsed = Date.parse(cleanText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function cleanNullable(value) {
  const text = cleanText(value);
  return text || null;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function errorText(error) {
  return error instanceof Error ? error.message : cleanText(error) || "Source intake processing failed.";
}

function isPreconditionFailure(error) {
  return error?.$metadata?.httpStatusCode === 412 ||
    error?.name === "PreconditionFailed" ||
    error?.Code === "PreconditionFailed";
}

function refuse(code, message) {
  throw new IntakeArtifactRetentionError(code, message);
}
