import { createHash } from "node:crypto";
import { mkdirSync, lstatSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { validateProgramTextCapture } from "./program-text-capture.mjs";

export const PROGRAM_TEXT_REFERENCE_SCHEMA = "awardping.program-text-reference.v1";
const sha = value => createHash("sha256").update(value).digest("hex");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = reason => { throw new Error(`Program text storage: ${reason}`); };
const json = value => Buffer.from(JSON.stringify(value) + "\n");
const maxArtifactBytes = 32 * 1024 * 1024;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
const keys = (value, expected) => plain(value) && Object.keys(value).sort().join() === [...expected].sort().join();
const sourceKeys = new Set(["id", "shared_award_id", "url", "title", "page_type"]);
const isoDate = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function httpUrl(value) {
  try {
    const url = new URL(value);
    return typeof value === "string" && value.length <= 10_000 && url.href === value &&
      ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.port && !url.hash;
  } catch { return false; }
}

function artifactMap(capture) {
  validateProgramTextCapture(capture);
  const { bytes, ...source } = capture.raw_source;
  const metadata = { ...capture, raw_source: source };
  const rawName = capture.acquisition.startsWith("pdf_") ? "original.pdf" : "original.html";
  const prefix = `program-text/sources/${capture.source.id}/${capture.capture_id}/`;
  return [
    ["raw", rawName, bytes, capture.raw_source.content_type],
    ["text", "text.txt", Buffer.from(capture.text), "text/plain; charset=utf-8"],
    ["metadata", "metadata.json", json(metadata), "application/json"],
  ].map(([role, name, body, type]) => ({ role, name, body,
    binding: { object_key: prefix + name, sha256: sha(body), byte_length: body.length, content_type: type } }));
}

export function programTextReference(capture) {
  const artifacts = artifactMap(capture);
  return { schema: PROGRAM_TEXT_REFERENCE_SCHEMA, kind: "program_text", capture_id: capture.capture_id,
    source: capture.source, final_url: capture.final_url, captured_at: capture.captured_at,
    acquisition: capture.acquisition, extractor: capture.extractor, text_sha256: capture.text_sha256,
    text_length: capture.text.length, blocks_sha256: sha(JSON.stringify(canonical(capture.blocks))), completeness: capture.completeness,
    artifacts: Object.fromEntries(artifacts.map(a => [a.role, a.binding])) };
}

export function validateProgramTextReference(ref) {
  if (!keys(ref, ["schema", "kind", "capture_id", "source", "final_url", "captured_at", "acquisition", "extractor", "text_sha256", "text_length", "blocks_sha256", "completeness", "artifacts"]) ||
      ref.schema !== PROGRAM_TEXT_REFERENCE_SCHEMA || ref.kind !== "program_text" || !hex(ref.capture_id) ||
      !hex(ref.text_sha256) || !hex(ref.blocks_sha256) || !plain(ref.source) || !uuid(ref.source.id) || !uuid(ref.source.shared_award_id) ||
      Object.keys(ref.source).some(key => !sourceKeys.has(key)) || !httpUrl(ref.source.url) || !httpUrl(ref.final_url) ||
      ["title", "page_type"].some(key => ref.source[key] !== undefined && (typeof ref.source[key] !== "string" || ref.source[key].length > 10_000)) ||
      !keys(ref.extractor, ["name", "version"]) || ["name", "version"].some(key => typeof ref.extractor[key] !== "string" || !ref.extractor[key] || ref.extractor[key].length > 160) ||
      !["http_html", "rendered_html", "pdf_text", "pdf_ocr"].includes(ref.acquisition) ||
      !Number.isSafeInteger(ref.text_length) || ref.text_length < 1 || ref.text_length > 1_000_000 ||
      !isoDate(ref.captured_at) || !keys(ref.completeness, ["status", "reasons"]) || ref.completeness.status !== "complete" ||
      !Array.isArray(ref.completeness.reasons) || ref.completeness.reasons.length ||
      !keys(ref.artifacts, ["metadata", "raw", "text"])) fail("invalid_reference");
  const prefix = `program-text/sources/${ref.source.id}/${ref.capture_id}/`;
  for (const [role, a] of Object.entries(ref.artifacts)) {
    const name = role === "metadata" ? "metadata.json" : role === "text" ? "text.txt" : ref.acquisition.startsWith("pdf_") ? "original.pdf" : "original.html";
    const typeValid = role === "metadata" ? a?.content_type === "application/json" : role === "text" ? a?.content_type === "text/plain; charset=utf-8"
      : typeof a?.content_type === "string" && a.content_type.length <= 200 &&
        (ref.acquisition.startsWith("pdf_") ? /^application\/pdf(?:;|$)/i : /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i).test(a.content_type);
    const limit = role === "raw" ? (ref.acquisition.startsWith("pdf_") ? 20 : 5) * 1024 * 1024 : role === "text" ? 8 * 1024 * 1024 : maxArtifactBytes;
    if (!keys(a, ["byte_length", "content_type", "object_key", "sha256"]) ||
        a.object_key !== prefix + name || !hex(a.sha256) || !Number.isSafeInteger(a.byte_length) ||
        a.byte_length < 1 || a.byte_length > limit || !typeValid) fail("invalid_artifact_binding");
  }
  if (ref.artifacts.text.sha256 !== ref.text_sha256) fail("text_hash_mismatch");
  return ref;
}

function contained(root, target) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || resolve(root, rel) !== target) fail("archive_scope");
  for (let p = target; p !== root; p = dirname(p)) {
    try { const st = lstatSync(p); if (st.isSymbolicLink()) fail("archive_reparse"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

/** Create-only private local retention. Callers supply the installer-owned archive. */
export function retainProgramTextCapture(capture, archiveRoot) {
  const root = realpathSync.native(resolve(archiveRoot)), artifacts = artifactMap(capture);
  const directory = resolve(root, "program-text", "sources", capture.source.id, capture.capture_id);
  contained(root, directory); mkdirSync(directory, { recursive: true, mode: 0o700 }); contained(root, directory);
  for (const a of artifacts) {
    const path = join(directory, a.name);
    try { writeFileSync(path, a.body, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size !== a.body.length || sha(readFileSync(path)) !== a.binding.sha256) fail("local_retention_mismatch");
  }
  return { reference: programTextReference(capture), directory };
}

async function bodyBytes(body, limit) {
  const chunks = []; let length = 0;
  for await (const chunk of body) {
    const b = Buffer.from(chunk); length += b.length;
    if (length > limit) { body.destroy?.(); fail("remote_artifact_limit"); }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

async function readArtifact(client, bucket, binding) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: binding.object_key }), { abortSignal: AbortSignal.timeout(30_000) });
  if (result.ContentLength != null && result.ContentLength !== binding.byte_length) fail("remote_artifact_length");
  const body = await bodyBytes(result.Body, binding.byte_length);
  if (body.length !== binding.byte_length || sha(body) !== binding.sha256) fail("remote_artifact_hash");
  return body;
}

/** Content-addressed immutable keys; each upload is followed by a raw readback. */
export async function uploadProgramTextCapture(capture, { client, bucket }) {
  const ref = validateProgramTextReference(programTextReference(capture));
  for (const a of artifactMap(capture)) {
    try { await readArtifact(client, bucket, a.binding); }
    catch (error) {
      if (!["NoSuchKey", "NotFound"].includes(error.name) && error.$metadata?.httpStatusCode !== 404) throw error;
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: a.binding.object_key, Body: a.body,
          ContentType: a.binding.content_type, CacheControl: "private, max-age=31536000, immutable", IfNoneMatch: "*" }), { abortSignal: AbortSignal.timeout(30_000) });
      } catch (putError) { if (putError.$metadata?.httpStatusCode !== 412) throw putError; }
      await readArtifact(client, bucket, a.binding);
    }
  }
  return ref;
}

/** Every review restores and verifies the originals, never a mutable current page. */
export async function loadProgramTextCapture(ref, { client, bucket }) {
  validateProgramTextReference(ref);
  const [raw, text, metadata] = await Promise.all(["raw", "text", "metadata"].map(role => readArtifact(client, bucket, ref.artifacts[role])));
  const capture = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata));
  capture.raw_source = { bytes: raw, ...capture.raw_source };
  validateProgramTextCapture(capture);
  if (Buffer.from(capture.text).compare(text) || !equal(programTextReference(capture), ref)) fail("restored_capture_mismatch");
  return capture;
}
