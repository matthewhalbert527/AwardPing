import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260810183240_bind_published_event_r2_evidence_roles.sql",
    import.meta.url,
  ),
  "utf8",
);
const writer = readFileSync(
  new URL("lib/visual-event-evidence.mjs", import.meta.url),
  "utf8",
);

function functionBody(signature, revokeSignature) {
  const start = migration.indexOf(`create or replace function ${signature}`);
  const end = migration.indexOf(`revoke all on function ${revokeSignature}`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

const eventBinding = functionBody(
  "private.stage1_published_event_r2_object_binding_valid(",
  "private.stage1_published_event_r2_object_binding_valid(",
);
const objectSet = functionBody(
  "private.stage1_visual_r2_object_set_snapshot()",
  "private.stage1_visual_r2_object_set_snapshot()",
);

describe("published-event R2 role-binding migration", () => {
  it("binds every event object to its exact database candidate, side, and raw digest", () => {
    for (const contract of [
      "p_candidate_id is not null",
      "coalesce(p_side_name, '') in ('previous', 'current')",
      "p_candidate_id::text || '/'",
      "coalesce(p_side_name, '') ||",
      "coalesce(p_sha256, '') ||",
      "coalesce(p_object_key, '') !~* '(^|/)latest(/|$)'",
      "coalesce(p_sha256, '') ~ '^[0-9a-f]{64}$'",
      "coalesce(p_byte_length, '') ~ '^[1-9][0-9]*$'",
      "coalesce(p_hash_mode, '') = 'raw_sha256'",
      "p_semantic_length is null",
    ]) {
      expect(eventBinding).toContain(contract);
    }
    expect(objectSet).toContain(
      "event.visual_review_candidate_id as published_candidate_id",
    );
    expect(objectSet).toContain("event.published_candidate_id as candidate_id");
    expect(objectSet).toContain("'candidate_id', object_row.candidate_id");
    expect(objectSet).toMatch(
      /stage1_published_event_r2_object_binding_valid\(\s*object_row\.source_id,\s*object_row\.candidate_id,/,
    );
  });

  it("matches the canonical full, crop, layout, and metadata writer roles", () => {
    const writerRoles = [
      'role: "document"',
      'role: "main-full"',
      'role: `state-${state.state_id}`',
      'role: "changed-section-crop"',
      'role: `geometry-${state.state_id}`',
      'role: "metadata"',
      'role: "recovery-metadata"',
      'role: "first-observation-attestation"',
    ];
    for (const role of writerRoles) expect(writer).toContain(role);

    for (const contract of [
      "coalesce(p_artifact_name, '') = 'full'",
      "coalesce(p_content_type, '') = 'application/pdf'",
      "'/document/'",
      "coalesce(p_sha256, '') || '[.]pdf$'",
      "coalesce(p_content_type, '') = 'image/jpeg'",
      "'/(main-full|state-[A-Za-z0-9._-]+)/'",
      "coalesce(p_sha256, '') || '[.]jpg$'",
      "coalesce(p_artifact_name, '') = 'crop'",
      "'/changed-section-crop/'",
      "coalesce(p_artifact_name, '') = 'layout'",
      "'/geometry-[A-Za-z0-9._-]+/'",
      "coalesce(p_artifact_name, '') = 'metadata'",
      "'/(metadata|recovery-metadata)/'",
      "coalesce(p_side_name, '') = 'previous'",
      "'/previous/first-observation-attestation/'",
      "'application/json; charset=utf-8'",
      "coalesce(p_sha256, '') || '[.]json$'",
    ]) {
      expect(eventBinding).toContain(contract);
    }
    expect(eventBinding).not.toContain("~ '^image/'");
    expect(eventBinding).not.toContain("~ '^application/json'");
  });

  it("preserves the separate immutable manifest-source PDF contract", () => {
    expect(objectSet).toContain("when 'manifest_source' then");
    expect(objectSet).toContain("object_row.candidate_id is not null");
    expect(objectSet).toContain("when object_row.artifact_name = 'pdf' then");
    expect(objectSet).toContain("object_row.object_key !~ '/document[.]pdf$'");
    expect(objectSet).toContain("object_row.content_type <> 'application/pdf'");
  });

  it("retains present malformed slots but omits absent and JSON-null roles", () => {
    expect(objectSet).toContain("where artifact.value is not null");
    expect(objectSet).toContain(
      "pg_catalog.jsonb_typeof(artifact.value) is distinct from 'null'",
    );
    expect(objectSet).not.toContain(
      "nullif(pg_catalog.btrim(artifact.value ->> 'object_key'), '') is not null",
    );
    expect(eventBinding).toMatch(/select coalesce\([\s\S]*?false\s*\n\s*\);/);
  });

  it("counts duplicate key reuse as malformed instead of deduplicating it", () => {
    for (const contract of [
      "union all",
      "), duplicate_object_keys as (",
      "group by object_row.bucket, object_row.object_key",
      "having pg_catalog.count(*) > 1",
      "'duplicate_object_key_count'",
      "object_key_quality.duplicate_object_key_count",
    ]) {
      expect(objectSet).toContain(contract);
    }
    expect(objectSet).not.toMatch(/event_object_rows as \(\s*select distinct/);
    expect(migration).toMatch(
      /create or replace function public\.get_stage1_release_r2_verification_manifest\(\)[\s\S]*?'duplicate_object_key_count',\s*v_manifest -> 'duplicate_object_key_count'/,
    );
  });

  it("is a forward-only function replacement with no data or privilege expansion", () => {
    expect(migration).not.toMatch(/^\s*(?:create|alter|drop)\s+table\b/im);
    expect(migration).not.toMatch(/^\s*(?:insert|update|delete)\s+/im);
    expect(migration).toMatch(
      /revoke all on function private\.stage1_published_event_r2_object_binding_valid\([\s\S]*?\) from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /revoke all on function private\.stage1_visual_r2_object_set_snapshot\(\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).not.toMatch(/grant\s+execute/i);
    expect(eventBinding).toContain("immutable\nset search_path = ''");
    expect(objectSet).toContain("stable\nsecurity definer\nset search_path = ''");
  });
});
