import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buildProgramTextCapture } from "./program-text-capture.mjs";
import { programTextReference, validateProgramTextReference, retainProgramTextCapture,
  uploadProgramTextCapture, loadProgramTextCapture } from "./program-text-storage.mjs";

function capture() {
  const text = "The scholarship application deadline is January 20, 2027.\nAwards provide full tuition.";
  return buildProgramTextCapture({ source: { id: "11111111-1111-4111-8111-111111111111",
    shared_award_id: "22222222-2222-4222-8222-222222222222", url: "https://example.org/award", title: "Award", page_type: "program" },
    captured_at: "2026-10-23T18:00:00.000Z", acquisition: "http_html", extractor: { name: "fixture", version: "1" },
    raw_bytes: Buffer.from(`<html><body>${text}</body></html>`), content_type: "text/html; charset=utf-8", text,
    blocks: [{ id: "block-1", start_utf16: 0, end_utf16: text.length, text }] });
}
function remote() {
  const objects = new Map(), calls = [];
  return { objects, calls, client: { async send(command) {
    const { Key, Body, IfNoneMatch, ContentType } = command.input; calls.push(command.constructor.name);
    if (command.constructor.name === "PutObjectCommand") {
      assert.equal(IfNoneMatch, "*");
      if (objects.has(Key)) throw Object.assign(new Error("exists"), { $metadata: { httpStatusCode: 412 } });
      objects.set(Key, { body: Buffer.from(Body), ContentType }); return {};
    }
    const object = objects.get(Key);
    if (!object) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    return { Body: Readable.from([object.body]), ContentLength: object.body.length, ContentType: object.ContentType };
  } } };
}
const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])])) : value;

test("reference has exactly three text/raw artifacts and no visual slots", () => {
  const ref = validateProgramTextReference(programTextReference(capture()));
  assert.deepEqual(Object.keys(ref.artifacts), ["raw", "text", "metadata"]);
  assert.ok(ref.artifacts.raw.object_key.endsWith("/original.html"));
  assert.ok(!JSON.stringify(ref).includes(".png"));
});
test("create-only local retention is idempotent and rejects mismatched existing bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "awardping-text-storage-test-"));
  try {
    const first = retainProgramTextCapture(capture(), root);
    assert.equal(retainProgramTextCapture(capture(), root).directory, first.directory);
    assert.equal(readFileSync(join(first.directory, "text.txt"), "utf8"), capture().text);
    writeFileSync(join(first.directory, "text.txt"), "tampered");
    assert.throws(() => retainProgramTextCapture(capture(), root), /local_retention_mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("cloud retention reads back every artifact, restores exact text, and survives JSONB key reordering", async () => {
  const r = remote(), options = { client: r.client, bucket: "private" };
  const ref = await uploadProgramTextCapture(capture(), options);
  assert.equal(r.calls.filter(c => c === "PutObjectCommand").length, 3);
  const restored = await loadProgramTextCapture(reverseKeys(JSON.parse(JSON.stringify(ref))), options);
  assert.equal(restored.capture_id, capture().capture_id);
  assert.deepEqual(restored.raw_source.bytes, capture().raw_source.bytes);
  await uploadProgramTextCapture(capture(), options);
  assert.equal(r.calls.filter(c => c === "PutObjectCommand").length, 3);
});
test("existing wrong cloud bytes are never overwritten", async () => {
  const r = remote(), ref = programTextReference(capture());
  r.objects.set(ref.artifacts.raw.object_key, { body: Buffer.alloc(ref.artifacts.raw.byte_length, 65), ContentType: "text/html" });
  await assert.rejects(uploadProgramTextCapture(capture(), { client: r.client, bucket: "private" }), /remote_artifact_hash/);
  assert.ok(!r.calls.includes("PutObjectCommand"));
});
test("cloud corruption or incomplete capture cannot establish a reference", async () => {
  const r = remote(), options = { client: r.client, bucket: "private" };
  const ref = await uploadProgramTextCapture(capture(), options);
  const obj = r.objects.get(ref.artifacts.text.object_key); obj.body[0] ^= 1;
  await assert.rejects(loadProgramTextCapture(ref, options), /remote_artifact_hash/);
  const c = capture(); c.completeness = { status: "incomplete", reasons: ["missing_page"] };
  assert.throws(() => programTextReference(c), /capture_identity_mismatch/);
});
for (const [name, mutate] of Object.entries({
  "extra visual slot": ref => { ref.screenshot = {}; },
  "source path traversal": ref => { ref.source.id = "../escape"; },
  "wrong raw filename": ref => { ref.artifacts.raw.object_key = ref.artifacts.raw.object_key.replace("original.html", "original.png"); },
  "wrong metadata type": ref => { ref.artifacts.metadata.content_type = "image/png"; },
  "wrong text hash": ref => { ref.artifacts.text.sha256 = "a".repeat(64); },
  "uncanonical timestamp": ref => { ref.captured_at = "2026-10-23"; },
  "incomplete": ref => { ref.completeness = { status: "incomplete", reasons: ["missing"] }; },
  "empty reasons must be array": ref => { ref.completeness.reasons = {}; },
  "missing required source": ref => { delete ref.source.url; },
  "unknown artifact": ref => { ref.artifacts.image = ref.artifacts.raw; },
})) test(`rejects ${name}`, () => {
  const ref = structuredClone(programTextReference(capture())); mutate(ref);
  assert.throws(() => validateProgramTextReference(ref), /Program text storage:/);
});
