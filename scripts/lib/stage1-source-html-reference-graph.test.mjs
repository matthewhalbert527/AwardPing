import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { measureStage1R2RecoveryDrill, stableJson } from "./stage1-release-evidence-producers.mjs";
import { SOURCE_HTML_PROFILE, sourceHtmlArtifactProjection } from "./source-html-evidence.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
const candidate = "22222222-2222-4222-8222-222222222222", event = "55555555-5555-4555-8555-555555555555";
const target = { schema_version: "awardping.stage1.production-target.v1", configured: true, release_key: "stage1-national-25", config_version: 7,
  target_config_hash: "a".repeat(64), app_origin: "https://awardping.com", supabase_origin: "https://abcdefghijklmnopqrst.supabase.co",
  supabase_project_ref: "abcdefghijklmnopqrst", deployment_provider: "vercel", deployment_project_id: "prj_awardping_production",
  deployment_team_slug: "awardping-team", r2_account_id: "b".repeat(32), r2_bucket: "awardping-snapshots" };
function bind(manifest) {
  const objects = manifest.objects, refs = objects.flatMap(o => o.references.map(reference => ({ bucket: o.bucket, object_key: o.object_key, reference })));
  Object.assign(manifest, { visual_object_count: objects.length, visual_reference_count: refs.length,
    published_event_object_count: objects.filter(o => o.scope === "published_event").length,
    published_event_reference_count: refs.filter(r => r.reference.scope === "published_event").length,
    manifest_source_object_count: objects.filter(o => o.scope === "manifest_source").length,
    manifest_source_reference_count: refs.filter(r => r.reference.scope === "manifest_source").length,
    alias_reference_count: refs.length - objects.length, aliased_object_count: objects.filter(o => o.references.length > 1).length,
    visual_object_set_hash_input: JSON.stringify(objects), visual_object_set_hash: sha(JSON.stringify(objects)),
    reference_set_hash_input: JSON.stringify(refs), reference_set_hash: sha(JSON.stringify(refs)) });
  return manifest;
}
function fixture() {
  const bodies = new Map(), objects = [];
  for (const side of ["previous", "current"]) for (const [role, logicalRole, ext, contentType] of [
    ["source-html", "full", "txt", "text/plain; charset=utf-8"], ["metadata", "metadata", "json", "application/json; charset=utf-8"],
    ["text", "text", "txt", "text/plain; charset=utf-8"]]) {
    const body = Buffer.from(`${side} retained ${role} bytes`), hash = sha(body), key = `visual-snapshots/published/${candidate}/${side}/${role}/${hash}.${ext}`;
    bodies.set(key, { body, contentType });
    const reference = { scope: "published_event", change_event_id: event, source_id: null, candidate_id: candidate, side,
      role: logicalRole, logical_path: `$.${logicalRole}.object_key`, state_id: null, state_kind: null, suppressed: false };
    objects.push({ bucket: target.r2_bucket, scope: "published_event", source_id: null, candidate_id: candidate, storage_role: role, side,
      object_key: key, sha256: hash, hash_mode: "raw_sha256", byte_length: body.length, semantic_length: null, content_type: contentType,
      reference_count: 1, references: [reference] });
  }
  const manifest = bind({ schema_version: "awardping.stage1.r2-verification-manifest.v4", artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
    reference_schema: "awardping.r2.canonical-object-references.v1", target, unexpected_bucket_count: 0, malformed_object_count: 0,
    manifest_binding_error_count: 0, reference_binding_error_count: 0, inconsistent_alias_count: 0, unclassified_reference_count: 0, duplicate_object_key_count: 0, objects });
  const calls = [];
  const r2Client = { send: async command => { calls.push(command.input.Key); const row = bodies.get(command.input.Key);
    if (!row) throw Error("unknown mock object"); return { Body: { transformToByteArray: async () => row.body }, ContentType: row.contentType }; } };
  const run = () => measureStage1R2RecoveryDrill({ target, manifest, r2Client, appRevision: "fixture-revision",
    measuredAt: "2026-10-18T20:00:00.000Z", measurementId: "12345678-1234-4234-9234-123456789abc" });
  return { manifest, bodies, calls, run };
}
describe("published source HTML exact recovery reference graph", () => {
  it("verifies the complete pair of source/text/meta objects once each without visual state refs", async () => {
    const f = fixture(), result = await f.run(); expect(result.status).toBe("passed"); expect(f.calls).toHaveLength(6);
    expect(result.evidence).toMatchObject({ visual_objects_checked: 6, visual_references_checked: 6, alias_references_checked: 0 });
  });
  it.each(["previous", "current"])("rejects missing %s side before cloud GET", async side => {
    const f = fixture(); f.manifest.objects = f.manifest.objects.filter(o => o.side !== side); bind(f.manifest);
    await expect(f.run()).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
  it.each(["full", "metadata", "text"])("rejects missing %s reference before cloud GET", async role => {
    const f = fixture(); f.manifest.objects = f.manifest.objects.filter(o => !(o.side === "current" && o.references[0].role === role)); bind(f.manifest);
    await expect(f.run()).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
  it.each(["htmlmime", "extension", "imageclaim", "cropalias", "partialside", "hashkey", "fakeevent", "graphhash"])
  ("rejects inconsistent %s graph before storage access", async kind => {
    const f = fixture(), object = f.manifest.objects[0], reference = object.references[0];
    if (kind === "htmlmime") object.content_type = "text/html";
    if (kind === "extension") object.object_key = object.object_key.replace(/\.txt$/, ".html");
    if (kind === "imageclaim") { reference.state_id = "main"; reference.state_kind = "main"; }
    if (kind === "cropalias") { object.references.push({ ...reference, role: "crop.source_image", logical_path: "$.crop.source_image_object_key", state_id: "main", state_kind: "main" }); object.references.sort((a, b) => stableJson(a).localeCompare(stableJson(b))); object.reference_count++; }
    if (kind === "partialside") reference.side = "current";
    if (kind === "hashkey") object.object_key = object.object_key.replace(object.sha256, "0".repeat(64));
    if (kind === "fakeevent") reference.change_event_id = "66666666-6666-4666-8666-666666666666";
    bind(f.manifest); if (kind === "graphhash") f.manifest.reference_set_hash = "0".repeat(64);
    await expect(f.run()).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
  it("detects a tampered raw HTML body without granting recovery proof", async () => {
    const f = fixture(); f.bodies.get(f.manifest.objects[0].object_key).body = Buffer.from("different source body");
    const result = await f.run(); expect(result.status).toBe("failed"); expect(result.evidence.hash_verified).toBe(false);
  });
});

function sourceFixture() {
  const f = fixture(), source = "33333333-3333-4333-8333-333333333333";
  f.manifest.objects = f.manifest.objects.filter(o => o.side === "current");
  for (const o of f.manifest.objects) {
    const oldKey = o.object_key, role = { "source-html": "html", metadata: "meta", text: "text" }[o.storage_role];
    const filename = { html: "page.html.txt", meta: "meta.json", text: "text.txt" }[role];
    Object.assign(o, { scope: "manifest_source", source_id: source, candidate_id: null, storage_role: role,
      object_key: `visual-snapshots/sources/${source}/captures/${"a".repeat(32)}/${filename}`,
      capture_profile: SOURCE_HTML_PROFILE, retained_artifact_projection: sourceHtmlArtifactProjection() });
    o.references = [{ scope: "manifest_source", change_event_id: null, source_id: source, candidate_id: null,
      side: "current", role, logical_path: `$.object_keys.${role}`, state_id: null, state_kind: null, suppressed: null }];
    f.bodies.set(o.object_key, f.bodies.get(oldKey));
  }
  bind(f.manifest);
  return f;
}

describe("manifest source HTML exact recovery graph", () => {
  it("requires the hashed source-only projection on the exact three source generation objects", async () => {
    const f = sourceFixture(), result = await f.run(); expect(result.status).toBe("passed"); expect(f.calls).toHaveLength(3);
    expect(result.evidence.manifest_source_objects_checked).toBe(3);
  });
  it.each(["profile", "projection", "visible", "imageclaim", "missinghtml", "missingtext", "generation", "htmlmime", "htmlpath"])
  ("rejects source-only %s inconsistency before GET", async kind => {
    const f = sourceFixture(), object = f.manifest.objects[0];
    if (kind === "profile") delete object.capture_profile;
    if (kind === "projection") delete object.retained_artifact_projection;
    if (kind === "visible") object.retained_artifact_projection.visibility_verified = true;
    if (kind === "imageclaim") object.retained_artifact_projection.authoritative.layout_retained = true;
    if (kind === "missinghtml") f.manifest.objects = f.manifest.objects.filter(o => o.storage_role !== "html");
    if (kind === "missingtext") f.manifest.objects = f.manifest.objects.filter(o => o.storage_role !== "text");
    if (kind === "generation") object.object_key = object.object_key.replace("a".repeat(32), "b".repeat(32));
    if (kind === "htmlmime") object.content_type = "text/html";
    if (kind === "htmlpath") object.object_key = object.object_key.replace("page.html.txt", "page.html");
    bind(f.manifest); await expect(f.run()).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
});
