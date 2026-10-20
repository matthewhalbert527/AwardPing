import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  IntakeArtifactRetentionError,
  canonicalJsonBytes,
  canonicalTimestampOrNull,
  cleanText,
  jsonSafeClone,
  namespace,
  objectValue,
  parseLoadedArtifact,
  refuse,
  requireAbsoluteHttpUrl,
  requireSha256,
  requireUuid,
  retainedDocumentContentType,
  sameHash,
  sha256,
  validateRetainedIntakeArtifactManifest,
} from "./intake-artifact-contract.mjs";
import { hasTerminalFailedSourceIntakeResponse } from "./source-intake-terminal-response.mjs";

export { IntakeArtifactRetentionError } from "./intake-artifact-contract.mjs";

/**
 * Read-only verification for an explicit saved-HTML recovery action. The caller
 * supplies the original completed manifest; a matching newer body hash is not
 * authority to invent that manifest or its first-observation timestamp.
 * This does not restore a request, approve a source, or start an AI review.
 * @param {{
 *   request?: Record<string, unknown>,
 *   captureMetadata?: Record<string, unknown>,
 *   bucket?: string | null,
 *   config?: {bucket?: string, endpoint?: string, storeId?: string, accessKeyId?: string, secretAccessKey?: string} | null,
 *   client?: {send: (command: import("@aws-sdk/client-s3").GetObjectCommand, options?: {abortSignal: AbortSignal}) => Promise<unknown>, destroy?: () => void} | null,
 *   sendCommand?: ((command: import("@aws-sdk/client-s3").GetObjectCommand, options?: {abortSignal: AbortSignal}) => Promise<unknown>) | null
 * }} [options]
 */
export async function verifySavedFirstObservationHtmlCapture({
  request,
  captureMetadata,
  bucket: bucketValue = null,
  config = null,
  client = null,
  sendCommand = null,
} = {}) {
  const stop = (code) => refuse(
    `saved_capture_restore_${code}`,
    "The saved HTML capture could not be verified. Keep this request held and preserve its original evidence.",
  );
  let ownedClient = null;
  try {
    const original = objectValue(captureMetadata);
    const current = objectValue(request?.capture_metadata);
    const ai = objectValue(request?.ai_review);
    const present = (value) => value !== null && value !== undefined && value !== "";
    const absentManifest = (value) => value === null || value === undefined || (
      typeof value === "object" && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === 0
    );
    const terminalFailed = hasTerminalFailedSourceIntakeResponse(ai, request?.id, current.capture_file_hash);
    if (!request || !["failed", "needs_manual_review"].includes(request.status)
        || request.status_reason !== "intake_local_conflict" || request.worker_run_id !== null
        || present(request.publication_claim_token) || present(request.submission_claim_token)
        || (present(request.ai_review) && (typeof request.ai_review !== "object" || Array.isArray(request.ai_review)))
        || !["", "accepted", "rejected", "needs_review", "failed"].includes(cleanText(ai.status))
        || present(ai.publication_claim_token) || present(ai.submission_claim_failed_closed_at)
        || (!terminalFailed && (["submission_claim_token", "possible_external_batch_name"].some((key) => present(ai[key]))
          || (["gemini_batch_name", "submitted_at", "batch_create_started_at"].some((key) => present(ai[key]))
            && !canonicalTimestampOrNull(ai.completed_at))))) stop("request_not_idle");
    if (original.capture_method !== "fetch_html" || current.capture_method !== "fetch_html"
        || !absentManifest(original.retained_artifact_staged) || !absentManifest(current.retained_artifact_staged)
        || !absentManifest(current.retained_artifact) || !Object.keys(objectValue(original.retained_artifact)).length) {
      stop("original_manifest_required");
    }
    const bucket = cleanText(bucketValue || config?.bucket);
    const storeId = normalizedR2StoreId(config);
    if (!bucket || !storeId) stop("target_missing");
    const manifest = validateRetainedIntakeArtifactManifest(original.retained_artifact, {
      requestId: requireUuid(request.id, "request_id"),
      fileHash: requireSha256(current.capture_file_hash, "current capture_file_hash"),
      finalUrl: requireAbsoluteHttpUrl(current.canonical_url, "current canonical_url"),
      requireR2Verified: true,
      r2Bucket: bucket,
      r2StoreId: storeId,
    });
    if (manifest.document_kind !== "html" || !/^text\/html(?:;|$)/.test(manifest.document_content_type)
        || manifest.response_final_url !== requireAbsoluteHttpUrl(current.final_url, "current final_url")) {
      stop("html_identity_mismatch");
    }
    const limits = { pdf: 20 * 1024 * 1024, text: 2 * 1024 * 1024, capture_metadata: 256 * 1024 };
    if (Object.keys(manifest.artifacts).length !== 3 || Object.entries(limits).some(([role, limit]) =>
      Number(manifest.artifacts[role]?.byte_length) < 1 || Number(manifest.artifacts[role]?.byte_length) > limit)) {
      stop("size_limit");
    }
    const r2Client = client || createR2Client(config, 1);
    if (!r2Client) stop("target_missing");
    if (!client) ownedClient = r2Client;
    const signal = AbortSignal.timeout(30_000);
    const values = {};
    for (const role of ["pdf", "text", "capture_metadata"]) {
      values[role] = { body: await getAndVerify({
        client: r2Client, sendCommand, bucket, artifact: manifest.artifacts[role],
        requestId: manifest.request_id, fileHash: manifest.file_hash, role,
        maxBytes: Number(manifest.artifacts[role].byte_length), signal,
      }) };
    }
    new TextDecoder("utf-8", { fatal: true }).decode(values.text.body);
    new TextDecoder("utf-8", { fatal: true }).decode(values.capture_metadata.body);
    const loaded = parseLoadedArtifact({ values }, manifest);
    const sealed = loaded.captureMetadata;
    if (original.ok !== true || !Number.isInteger(sealed.status_code)
        || sealed.status_code < 200 || sealed.status_code > 299
        || original.status_code !== sealed.status_code || original.title !== sealed.page_title
        || (sealed.page_title !== null && typeof sealed.page_title !== "string")
        || original.captured_at !== manifest.captured_at || original.text !== loaded.text
        || original.text_length !== loaded.text.length || original.text_excerpt !== loaded.text.slice(0, 20_000)
        || original.byte_length !== manifest.file_bytes || !sameHash(original.capture_file_hash, manifest.file_hash)
        || retainedDocumentContentType(original.content_type) !== sealed.content_type
        || original.canonical_url !== manifest.canonical_url || original.final_url !== manifest.response_final_url
        || sealed.page_count !== null || sealed.pdf_text_error !== null
        || original.page_count !== null || original.pdf_text_error !== null) stop("original_core_mismatch");
    const capture = {
      ok: true,
      status_code: sealed.status_code,
      title: sealed.page_title,
      text: loaded.text,
      page_description: null,
      content_type: sealed.content_type,
      byte_length: manifest.file_bytes,
      captured_at: manifest.captured_at,
      capture_file_hash: manifest.file_hash,
      canonical_url: manifest.canonical_url,
      final_url: manifest.response_final_url,
      page_count: null,
      pdf_text_error: null,
      links: [],
      pdf_links: [],
      retained_artifact: jsonSafeClone(original.retained_artifact),
      text_excerpt: loaded.text.slice(0, 20_000),
      text_length: loaded.text.length,
    };
    return {
      capture,
      evidence: {
        schema: "awardping.saved-first-observation-html-verification.v1",
        request_id: manifest.request_id,
        original_capture_metadata_sha256: sha256(canonicalJsonBytes(original)),
        original_manifest_sha256: sha256(canonicalJsonBytes(original.retained_artifact)),
        verified_artifacts: Object.fromEntries(Object.entries(limits).map(([role]) => [role, {
          sha256: sha256(values[role].body), byte_length: values[role].body.length,
        }])),
        original_captured_at: manifest.captured_at,
        original_metadata_reproduced: false,
        projection: "sealed_core_only",
        creates_api_charge: false,
        refetches_page: false,
        mutates_storage: false,
        queues_review: false,
        source_approval: false,
        publishable: false,
      },
    };
  } catch (error) {
    if (error instanceof IntakeArtifactRetentionError && error.code.startsWith("saved_capture_restore_")) throw error;
    stop(error?.code === "intake_r2_verification_failed" ? "object_mismatch"
      : error?.code === "intake_r2_read_failed" ? "read_failed" : "binding_invalid");
  } finally {
    try { ownedClient?.destroy?.(); } catch { /* Read-only verification does not depend on client cleanup. */ }
  }
}

export async function getAndVerify({ client, sendCommand, bucket, artifact, requestId, fileHash, role, maxBytes = null, signal = null }) {
  let response;
  try {
    const read = () => sendR2(
      client,
      sendCommand,
      new GetObjectCommand({ Bucket: bucket, Key: artifact.key }),
      signal ? { abortSignal: signal } : undefined,
    );
    response = signal ? await boundedRead(read, signal) : await read();
  } catch (error) {
    refuse("intake_r2_read_failed", `R2 read failed for ${artifact.key}: ${cleanText(error?.message || error)}`);
  }
  if (maxBytes !== null && response?.ContentLength !== undefined && Number(response.ContentLength) !== maxBytes) {
    refuse("intake_r2_verification_failed", "R2 returned an unexpected bounded object length.");
  }
  const body = await responseBodyToBuffer(response?.Body, maxBytes, signal);
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

export function createR2Client(config, maxAttempts = null) {
  const endpoint = cleanText(config?.endpoint);
  const accessKeyId = cleanText(config?.accessKeyId);
  const secretAccessKey = cleanText(config?.secretAccessKey);
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  return new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    ...(maxAttempts === null ? {} : { maxAttempts }),
  });
}

export function normalizedR2StoreId(config) {
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

export async function sendR2(client, sendCommand, command, options = undefined) {
  if (options) return typeof sendCommand === "function" ? sendCommand(command, options) : client.send(command, options);
  return typeof sendCommand === "function" ? sendCommand(command) : client.send(command);
}

export async function responseBodyToBuffer(body, maxBytes = null, signal = null) {
  if (maxBytes !== null) return boundedResponseBodyToBuffer(body, maxBytes, signal);
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

export function boundedRead(read, signal) {
  return new Promise((resolveRead, rejectRead) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      rejectRead(new IntakeArtifactRetentionError("intake_r2_read_failed", "The bounded R2 read expired."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    Promise.resolve().then(read).then(resolveRead, rejectRead)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function boundedResponseBodyToBuffer(body, maxBytes, signal) {
  const check = (size) => {
    if (signal?.aborted || size > maxBytes) {
      refuse("intake_r2_verification_failed", "R2 returned an oversized or expired bounded object.");
    }
  };
  check(0);
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) { check(body.length); return body; }
  if (body instanceof Uint8Array) { check(body.byteLength); return Buffer.from(body); }
  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    const iterator = body[Symbol.asyncIterator]();
    let complete = false;
    try {
      while (true) {
        const next = signal ? await boundedRead(() => iterator.next(), signal) : await iterator.next();
        if (next.done) { complete = true; break; }
        const chunk = next.value;
        size += chunk.byteLength ?? Buffer.byteLength(chunk);
        check(size);
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      if (!complete) {
        body.destroy?.();
        // Never await a stalled iterator's return after the verification deadline.
        try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* No storage mutation. */ }
      }
    }
    return Buffer.concat(chunks);
  }
  refuse("intake_r2_read_failed", "R2 returned an unsupported response body.");
}
