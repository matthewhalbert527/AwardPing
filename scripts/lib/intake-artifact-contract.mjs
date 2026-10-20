import { createHash } from "node:crypto";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab0-9a-f][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sha256Pattern = /^[0-9a-f]{64}$/i;

export const namespace = "source-intake-first-observation";

export const schemaVersion = 1;

// Schema v1 named the primary retained object `pdf`. Keep that role and file
// name stable for existing acquisitions; document_kind/content type describe
// non-PDF intake responses without invalidating old manifests.
export const artifactFiles = {
  pdf: { name: "document.pdf", contentType: "application/pdf" },
  text: { name: "text.txt", contentType: "text/plain; charset=utf-8" },
  capture_metadata: { name: "capture.json", contentType: "application/json" },
};

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
  return "Keep this item in manual quarantine, verify the request-bound R2 document/text/metadata and their hashes, then retry the same zero-charge materialization. Do not substitute the response currently served by the URL.";
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
  const actualResponseFinalUrl = requireAbsoluteHttpUrl(
    manifest.response_final_url || actualFinalUrl,
    "artifact response_final_url",
  );
  const actualCanonicalUrl = requireAbsoluteHttpUrl(
    manifest.canonical_url || actualFinalUrl,
    "artifact canonical_url",
  );
  if (actualCanonicalUrl !== actualFinalUrl) {
    refuse("intake_artifact_canonical_url_binding_mismatch", "The retained canonical URL differs from its source binding URL.");
  }
  if (requestId && actualRequestId !== cleanText(requestId)) {
    refuse("intake_artifact_request_binding_mismatch", "The retained artifact belongs to another source-intake request.");
  }
  if (fileHash && !sameHash(actualFileHash, fileHash)) {
    refuse("intake_artifact_file_binding_mismatch", "The retained document hash differs from the sealed acquisition.");
  }
  if (finalUrl && actualFinalUrl !== requireAbsoluteHttpUrl(finalUrl, "sealed final_url")) {
    refuse("intake_artifact_url_binding_mismatch", "The retained artifact final URL differs from the sealed acquisition.");
  }
  const expectedPrefix = artifactPrefix(actualRequestId, actualFileHash);
  if (cleanText(manifest.prefix) !== expectedPrefix) {
    refuse("intake_artifact_prefix_invalid", "The retained artifact prefix is not request/hash bound.");
  }
  const artifacts = objectValue(manifest.artifacts);
  const documentContentType = manifest.document_content_type
    ? retainedDocumentContentType(manifest.document_content_type)
    : "application/pdf";
  const documentKind = manifest.document_kind
    ? retainedDocumentKindValue(manifest.document_kind)
    : manifest.document_content_type
      ? retainedDocumentKind(documentContentType, actualFinalUrl)
      : "pdf";
  if (documentKind !== retainedDocumentKind(documentContentType, actualFinalUrl)) {
    refuse("intake_artifact_document_kind_invalid", "The retained document kind does not match its content type and URL.");
  }
  const manifestArtifactFiles = {
    ...artifactFiles,
    pdf: { ...artifactFiles.pdf, contentType: documentContentType },
  };
  for (const [role, definition] of Object.entries(manifestArtifactFiles)) {
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
    refuse(
      documentKind === "pdf" ? "intake_artifact_pdf_hash_invalid" : "intake_artifact_document_hash_invalid",
      `The retained ${documentKind === "pdf" ? "PDF" : "document"} object hash does not equal the sealed capture hash.`,
    );
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
    refuse(
      documentKind === "pdf" ? "intake_artifact_pdf_length_invalid" : "intake_artifact_document_length_invalid",
      `The retained ${documentKind === "pdf" ? "PDF" : "document"} length binding is invalid.`,
    );
  }
  if (!Number.isSafeInteger(textLength) || textLength < 0) {
    refuse("intake_artifact_text_length_invalid", "The retained text length binding is invalid.");
  }
  return {
    ...manifest,
    request_id: actualRequestId,
    file_hash: actualFileHash,
    final_url: actualFinalUrl,
    response_final_url: actualResponseFinalUrl,
    canonical_url: actualCanonicalUrl,
    captured_at: capturedAt,
    file_bytes: fileBytes,
    text_length: textLength,
    text_hash: requireSha256(manifest.text_hash, "artifact text_hash"),
    document_kind: documentKind,
    document_content_type: documentContentType,
    r2_bucket: manifestBucket,
    r2_store_id: manifestStoreId,
    artifacts,
  };
}

export function parseLoadedArtifact(local, manifest) {
  const metadata = parseJson(local.values.capture_metadata.body, "intake_capture_metadata_invalid");
  const metadataContentType = retainedDocumentContentType(
    metadata.content_type,
    manifest.document_kind === "pdf" ? "application/pdf" : "application/octet-stream",
  );
  const metadataDocumentKind = metadata.document_kind
    ? retainedDocumentKindValue(metadata.document_kind)
    : "pdf";
  if (
    metadata.namespace !== namespace ||
    metadata.request_id !== manifest.request_id ||
    metadata.captured_at !== manifest.captured_at ||
    metadata.final_url !== manifest.final_url ||
    requireAbsoluteHttpUrl(metadata.response_final_url || metadata.final_url, "capture response_final_url") !== manifest.response_final_url ||
    requireAbsoluteHttpUrl(metadata.canonical_url || metadata.final_url, "capture canonical_url") !== manifest.canonical_url ||
    metadataContentType !== manifest.document_content_type ||
    metadataDocumentKind !== manifest.document_kind ||
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

export function validateR2TargetBinding(manifest, { bucket, storeId }) {
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

export function artifactPrefix(requestId, fileHash) {
  return `${namespace}/v${schemaVersion}/requests/${requestId}/sha256/${fileHash}`;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(JSON.stringify(sortJson(value), null, 2), "utf8");
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

export function jsonSafeClone(value) {
  return JSON.parse(JSON.stringify(value, (_key, candidate) =>
    typeof candidate === "bigint" ? String(candidate) : candidate));
}

export function parseJson(body, code) {
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    refuse(code, `Retained capture metadata is invalid JSON: ${cleanText(error?.message || error)}`);
  }
}

export function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sameHash(left, right) {
  const a = cleanText(left).toLowerCase();
  const b = cleanText(right).toLowerCase();
  return Boolean(a && b && a === b);
}

export function requireSha256(value, label) {
  const hash = cleanText(value).toLowerCase();
  if (!sha256Pattern.test(hash)) refuse("intake_artifact_hash_invalid", `${label} is not a SHA-256 hash.`);
  return hash;
}

export function requireUuid(value, label) {
  const id = cleanText(value).toLowerCase();
  if (!uuidPattern.test(id)) refuse("intake_artifact_uuid_invalid", `${label} is not a UUID.`);
  return id;
}

export function requireAbsoluteHttpUrl(value, label) {
  const text = cleanText(value);
  try {
    const url = new URL(text);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) throw new Error("unsafe URL");
    return url.toString();
  } catch {
    refuse("intake_artifact_url_invalid", `${label} is not a safe absolute HTTP(S) URL.`);
  }
}

export function canonicalTimestamp(value, label) {
  const parsed = Date.parse(cleanText(value));
  if (!Number.isFinite(parsed)) refuse("intake_artifact_timestamp_invalid", `${label} is not a timestamp.`);
  return new Date(parsed).toISOString();
}

export function canonicalTimestampOrNull(value) {
  const parsed = Date.parse(cleanText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function cleanText(value) {
  return String(value ?? "").trim();
}

export function retainedDocumentContentType(value, fallback = "application/octet-stream") {
  const text = cleanText(value) || fallback;
  const mediaType = text.split(";", 1)[0].trim();
  if (
    text.length > 255
    || /[\r\n]/.test(text)
    || /[^\x20-\x7e]/.test(text)
    || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(mediaType)
  ) {
    refuse("intake_artifact_content_type_invalid", "The retained document content type is invalid.");
  }
  return text.toLowerCase();
}

export function retainedDocumentKind(contentType, finalUrl) {
  const type = cleanText(contentType).toLowerCase();
  if (type.includes("pdf") || /\.pdf(?:$|[?#])/i.test(cleanText(finalUrl))) return "pdf";
  if (type === "text/html" || type.startsWith("text/html;") || type === "application/xhtml+xml") return "html";
  if (type.startsWith("text/")) return "text";
  return "binary";
}

export function retainedDocumentKindValue(value) {
  const kind = cleanText(value).toLowerCase();
  if (!new Set(["pdf", "html", "text", "binary"]).has(kind)) {
    refuse("intake_artifact_document_kind_invalid", "The retained document kind is invalid.");
  }
  return kind;
}

export function refuse(code, message) {
  throw new IntakeArtifactRetentionError(code, message);
}
