import {
  namespace,
  schemaVersion,
  artifactFiles,
  IntakeArtifactRetentionError,
  intakeArtifactFailureSolution,
  validateRetainedIntakeArtifactManifest,
  parseLoadedArtifact,
  validateR2TargetBinding,
  artifactPrefix,
  canonicalJsonBytes,
  canonicalJson,
  jsonSafeClone,
  parseJson,
  objectValue,
  sha256,
  sameHash,
  requireUuid,
  requireAbsoluteHttpUrl,
  canonicalTimestamp,
  canonicalTimestampOrNull,
  cleanText,
  retainedDocumentContentType,
  retainedDocumentKind,
  refuse,
} from "./intake-artifact-contract.mjs";
import { getAndVerify, createR2Client, normalizedR2StoreId, sendR2 } from "./intake-artifact-r2-verification.mjs";

export { IntakeArtifactRetentionError, intakeArtifactFailureSolution, validateRetainedIntakeArtifactManifest } from "./intake-artifact-contract.mjs";
export { verifySavedFirstObservationHtmlCapture } from "./intake-artifact-r2-verification.mjs";

import { randomUUID } from "node:crypto";
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
import { PutObjectCommand } from "@aws-sdk/client-s3";
export const acquisitionDerivedCaptureMetadataSchema =
  "awardping.acquisition-derived-capture-metadata.v1";
export const acquisitionDerivedCaptureMetadataFilename = "capture-meta.json";

export const POST_RETENTION_CAPTURE_FAILURE_REASON =
  "source_intake_post_retention_processing_failed";
export const POST_RETENTION_CAPTURE_PERSISTENCE_UNVERIFIED_REASON =
  "source_intake_post_retention_persistence_unverified_manual_only";

export function requiresFirstObservationArtifactRetention(request, capture) {
  // Every response that can proceed to a paid new-page review must be retained.
  // This predicate is evaluated only after deterministic intake accepts the
  // capture and paid review is enabled, so broadening it here does not retain
  // deterministic rejects or create provider work by itself.
  return Boolean(
    cleanText(request?.id)
    && cleanText(capture?.capture_file_hash)
    && cleanText(capture?.content_type)
    && cleanText(capture?.canonical_url || capture?.final_url),
  );
}

/**
 * Builds the request metadata that binds a reviewed capture to its immutable
 * retained artifact without serializing the response bytes into Postgres.
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
export async function retainFirstObservationIntakeArtifact({
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
  const pdfDocument = isPdfRetainedCapture(capture);
  const integrityError = (suffix) => pdfDocument ? `intake_pdf_${suffix}` : `intake_artifact_${suffix}`;
  const artifactLabel = pdfDocument ? "PDF" : "source response";
  const bytes = capture?.artifact_bytes;
  if (!Buffer.isBuffer(bytes)) {
    refuse(
      integrityError("bytes_unavailable"),
      `The source-intake capture did not expose its exact ${artifactLabel} bytes for retention.`,
    );
  }
  const fileHash = sha256(bytes);
  const capturedHash = cleanText(capture?.capture_file_hash).toLowerCase();
  if (!sameHash(fileHash, capturedHash)) {
    refuse(
      integrityError("hash_mismatch"),
      `The exposed ${artifactLabel} bytes do not match the source-intake capture hash.`,
    );
  }
  if (Number(capture?.byte_length) !== bytes.length) {
    refuse(
      integrityError("length_mismatch"),
      `The exposed ${artifactLabel} bytes do not match the source-intake capture length.`,
    );
  }
  const capturedAt = canonicalTimestamp(capture?.captured_at, "captured_at");
  const responseFinalUrl = requireAbsoluteHttpUrl(
    capture?.final_url || capture?.canonical_url,
    "response final_url",
  );
  // Keep final_url as the historical canonical/source binding while also
  // preserving the exact response URL for HTML pages that declare a canonical.
  const finalUrl = requireAbsoluteHttpUrl(capture?.canonical_url || responseFinalUrl, "canonical final_url");
  const text = canonicalCapturedText(capture?.text);
  const textBytes = Buffer.from(`${text}\n`, "utf8");
  const textHash = sha256(Buffer.from(text, "utf8"));
  const documentContentType = retainedDocumentContentType(
    capture?.content_type,
    pdfDocument ? "application/pdf" : "application/octet-stream",
  );
  const documentKind = retainedDocumentKind(documentContentType, finalUrl);
  const manifestArtifactFiles = {
    ...artifactFiles,
    pdf: { ...artifactFiles.pdf, contentType: documentContentType },
  };
  const prefix = artifactPrefix(requestId, fileHash);
  const captureMetadata = {
    schema_version: schemaVersion,
    namespace,
    request_id: requestId,
    captured_at: capturedAt,
    final_url: finalUrl,
    response_final_url: responseFinalUrl,
    canonical_url: finalUrl,
    content_type: documentContentType,
    document_kind: documentKind,
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
        key: `${prefix}/${manifestArtifactFiles[role].name}`,
        sha256: sha256(body),
        byte_length: body.length,
        content_type: manifestArtifactFiles[role].contentType,
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
    response_final_url: responseFinalUrl,
    canonical_url: finalUrl,
    prefix,
    file_hash: fileHash,
    file_bytes: bytes.length,
    document_kind: documentKind,
    document_content_type: documentContentType,
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
      `R2 is required before this retained ${artifactLabel} can proceed to paid review.`,
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

/** Backward-compatible entry point for existing PDF acquisition callers. */
export async function retainFirstObservationIntakePdfArtifact(options = {}) {
  return retainFirstObservationIntakeArtifact(options);
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
 * Gives the ordinary visual baseline/candidate pipeline a mutable metadata
 * artifact without ever repurposing the acquisition-derived immutable
 * `meta.json`. Repeated materialization reuses the same derived file only
 * after proving that its immutable source/hash/timestamp bindings still match.
 */
export function prepareAcquisitionCaptureMetadataForProjection({
  archiveRoot,
  source,
  acquisition,
  capture,
  publishDerivedMetadata = publishDerivedCaptureMetadataAtomic,
} = {}) {
  const identity = validateAcquisitionArtifactBinding({ source, acquisition });
  const root = requireArchiveRoot(archiveRoot);
  const captureDir = resolve(cleanText(capture?.dir));
  const expectedCaptureDir = resolve(
    root,
    "sources",
    identity.sourceId,
    "captures",
    timestampForPath(identity.manifest.captured_at),
  );
  if (!cleanText(capture?.dir) || captureDir !== expectedCaptureDir) {
    refuse(
      "intake_derived_capture_metadata_path_mismatch",
      "The acquisition capture directory is not the deterministic source/timestamp path.",
    );
  }

  const immutableMetaPath = join(captureDir, "meta.json");
  const derivedMetaPath = join(captureDir, acquisitionDerivedCaptureMetadataFilename);
  assertSafeLocalArtifactPath(immutableMetaPath, root);
  assertSafeLocalArtifactPath(derivedMetaPath, root);
  if (!existsSync(immutableMetaPath) || lstatSync(immutableMetaPath).isSymbolicLink()) {
    refuse(
      "intake_derived_capture_metadata_source_missing",
      "The immutable acquisition-derived capture metadata is missing or unsafe.",
    );
  }

  const immutableMetaBytes = readFileSync(immutableMetaPath);
  const immutableMetadata = parseJson(
    immutableMetaBytes,
    "intake_derived_capture_metadata_source_invalid",
  );
  assertAcquisitionDerivedCaptureIdentity({
    metadata: immutableMetadata,
    capture,
    identity,
    root,
    immutableMetaPath,
    derivedMetaPath,
    requireDerivedBinding: false,
  });

  const immutableMetaRelative = archiveRelative(root, immutableMetaPath);
  const derivedMetaRelative = archiveRelative(root, derivedMetaPath);
  const immutableMetaSha256 = sha256(immutableMetaBytes);
  const seedMetadata = {
    ...immutableMetadata,
    acquisition_derived_capture_metadata: {
      schema: acquisitionDerivedCaptureMetadataSchema,
      immutable_meta: immutableMetaRelative,
      immutable_meta_sha256: immutableMetaSha256,
    },
    files: {
      ...objectValue(immutableMetadata.files),
      meta: derivedMetaRelative,
    },
  };

  const derivedExisted = existsSync(derivedMetaPath);
  if (!derivedExisted) {
    try {
      publishDerivedMetadata({
        path: derivedMetaPath,
        body: canonicalJsonBytes(seedMetadata),
        archiveRoot: root,
      });
    } catch (error) {
      // The production publisher exposes the destination only after the full
      // temporary file is durable, so an error cannot expose partial bytes.
      // Do not delete the destination here: another source-locked process may
      // have won the same deterministic publication race.
      const failure = new IntakeArtifactRetentionError(
        "intake_derived_capture_metadata_write_failed",
        `Derived capture metadata could not be published atomically: ${cleanText(error?.message || error)}`,
      );
      failure.cause = error;
      throw failure;
    }
  }

  let derivedMetadata;
  try {
    if (lstatSync(derivedMetaPath).isSymbolicLink()) {
      refuse(
        "intake_local_unsafe_path",
        "The derived capture metadata path is a symbolic link or junction.",
      );
    }
    derivedMetadata = parseJson(
      readFileSync(derivedMetaPath),
      "intake_derived_capture_metadata_invalid",
    );
  } catch (error) {
    if (error instanceof IntakeArtifactRetentionError) throw error;
    refuse(
      "intake_derived_capture_metadata_invalid",
      `Derived capture metadata could not be read: ${cleanText(error?.message || error)}`,
    );
  }
  assertAcquisitionDerivedCaptureIdentity({
    metadata: derivedMetadata,
    capture,
    identity,
    root,
    immutableMetaPath,
    derivedMetaPath,
    immutableMetaSha256,
    requireDerivedBinding: true,
  });

  // Do not redirect callers until the complete derived artifact has been
  // published, read back, and identity-checked.
  capture.immutable_intake_meta_path = immutableMetaPath;
  capture.meta_path = derivedMetaPath;
  capture.files = {
    ...objectValue(capture.files),
    meta: derivedMetaRelative,
  };
  return capture;
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
    const candidateMetaPath = cleanText(
      objectValue(objectValue(candidate?.new_snapshot_ref).local_paths).meta?.archive_relative,
    ).replace(/\\/g, "/");
    const derivedMetaPath = archiveRelative(
      requireArchiveRoot(archiveRoot),
      join(capture.dir, acquisitionDerivedCaptureMetadataFilename),
    );
    if (candidateMetaPath === derivedMetaPath) {
      prepareAcquisitionCaptureMetadataForProjection({
        archiveRoot,
        source,
        acquisition,
        capture,
      });
    }
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

function publishDerivedCaptureMetadataAtomic({ path, body, archiveRoot }) {
  const expected = Buffer.isBuffer(body) ? body : Buffer.from(body);
  assertSafeLocalArtifactPath(path, archiveRoot);
  mkdirSync(dirname(path), { recursive: true });
  assertSafeLocalArtifactPath(path, archiveRoot);
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staged, expected, { flag: "wx" });
    try {
      linkSync(staged, path);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // A concurrent writer won the deterministic name. The caller reads and
      // validates that complete artifact against the immutable binding.
      return;
    }
    const current = readFileSync(path);
    if (current.length !== expected.length || !sameHash(sha256(current), sha256(expected))) {
      throw new Error("the published bytes did not match the complete staged metadata");
    }
  } finally {
    rmSync(staged, { force: true });
  }
}

function assertAcquisitionDerivedCaptureIdentity({
  metadata,
  capture,
  identity,
  root,
  immutableMetaPath,
  derivedMetaPath,
  immutableMetaSha256 = null,
  requireDerivedBinding,
}) {
  const sourceMetadata = objectValue(metadata.source);
  const retained = objectValue(metadata.retained_intake_artifact);
  const files = objectValue(metadata.files);
  const expectedMetaPath = requireDerivedBinding ? derivedMetaPath : immutableMetaPath;
  const expectedMetaRelative = archiveRelative(root, expectedMetaPath);
  const expectedPdfRelative = archiveRelative(root, capture?.pdf_path);
  const expectedTextRelative = archiveRelative(root, capture?.text_path);
  if (
    sourceMetadata.id !== identity.sourceId
    || sourceMetadata.shared_award_id !== identity.awardId
    || sourceMetadata.source_acquisition_id !== identity.acquisitionId
    || sourceMetadata.source_page_request_id !== identity.requestId
    || sourceMetadata.url !== identity.finalUrl
    || metadata.captured_at !== identity.manifest.captured_at
    || metadata.final_url !== identity.finalUrl
    || !sameHash(metadata.file_hash, identity.manifest.file_hash)
    || !sameHash(metadata.image_hash, identity.manifest.file_hash)
    || !sameHash(metadata.text_hash, identity.manifest.text_hash)
    || Number(metadata.file_bytes) !== identity.manifest.file_bytes
    || Number(metadata.text_length) !== identity.manifest.text_length
    || retained.schema_version !== schemaVersion
    || retained.namespace !== namespace
    || retained.request_id !== identity.requestId
    || retained.acquisition_id !== identity.acquisitionId
    || retained.prefix !== identity.manifest.prefix
    || !sameHash(
      retained.capture_metadata_sha256,
      identity.manifest.artifacts.capture_metadata.sha256,
    )
    || files.pdf !== expectedPdfRelative
    || files.text !== expectedTextRelative
    || files.meta !== expectedMetaRelative
    || capture?.captured_at !== identity.manifest.captured_at
    || capture?.final_url !== identity.finalUrl
    || !sameHash(capture?.file_hash, identity.manifest.file_hash)
    || !sameHash(capture?.image_hash, identity.manifest.file_hash)
    || !sameHash(capture?.text_hash, identity.manifest.text_hash)
    || Number(capture?.file_bytes) !== identity.manifest.file_bytes
    || Number(capture?.text_length) !== identity.manifest.text_length
  ) {
    refuse(
      "intake_derived_capture_metadata_binding_mismatch",
      "Derived capture metadata does not preserve the sealed source, hash, path, and timestamp bindings.",
    );
  }

  if (!requireDerivedBinding) return;
  const binding = objectValue(metadata.acquisition_derived_capture_metadata);
  if (
    binding.schema !== acquisitionDerivedCaptureMetadataSchema
    || binding.immutable_meta !== archiveRelative(root, immutableMetaPath)
    || !sameHash(binding.immutable_meta_sha256, immutableMetaSha256)
  ) {
    refuse(
      "intake_derived_capture_metadata_provenance_mismatch",
      "Derived capture metadata is not bound to the exact immutable acquisition metadata bytes.",
    );
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

function timestampForPath(value) {
  return canonicalTimestamp(value, "captured_at").replace(/[:.]/g, "-");
}

function canonicalCapturedText(value) {
  return String(value || "").replace(/\u0000/g, "").trim();
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function cleanNullable(value) {
  const text = cleanText(value);
  return text || null;
}

function isPdfRetainedCapture(capture) {
  return retainedDocumentKind(
    cleanText(capture?.content_type) || "application/octet-stream",
    capture?.canonical_url || capture?.final_url,
  ) === "pdf";
}

function errorText(error) {
  return error instanceof Error ? error.message : cleanText(error) || "Source intake processing failed.";
}

function isPreconditionFailure(error) {
  return error?.$metadata?.httpStatusCode === 412 ||
    error?.name === "PreconditionFailed" ||
    error?.Code === "PreconditionFailed";
}
