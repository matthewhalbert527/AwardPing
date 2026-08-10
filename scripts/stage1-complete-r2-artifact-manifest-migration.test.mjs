import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260810162124_complete_stage1_r2_artifact_manifest.sql",
    import.meta.url,
  ),
  "utf8",
);

function functionBody(signature, revokeSignature) {
  const start = migration.indexOf(`create or replace function ${signature}`);
  const end = migration.indexOf(`revoke all on function ${revokeSignature}`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

const bindingFunction = functionBody(
  "private.stage1_manifest_source_capture_binding_valid(",
  "private.stage1_manifest_source_capture_binding_valid(",
);
const objectSetFunction = functionBody(
  "private.stage1_visual_r2_object_set_snapshot()",
  "private.stage1_visual_r2_object_set_snapshot()",
);
const manifestFunction = functionBody(
  "public.get_stage1_release_r2_verification_manifest()",
  "public.get_stage1_release_r2_verification_manifest()",
);
const manifestObjectRows = objectSetFunction.slice(
  objectSetFunction.indexOf("), manifest_object_rows as ("),
  objectSetFunction.indexOf("), object_rows as ("),
);

describe("complete Stage 1 R2 artifact manifest migration", () => {
  it("requires an exact raw-byte artifact binding for every pointer slot", () => {
    for (const contract of [
      "'awardping.r2.capture-artifact-bindings.v1'",
      "p_metadata -> 'artifact_bindings'",
      "where not ((p_metadata -> 'artifact_bindings') ? object_slot.slot_name)",
      "where not (p_object_keys ? binding_slot.slot_name)",
      "'sha256', 'byte_length', 'content_type', 'hash_mode'",
      ") <> 4",
      "is distinct from 'raw_sha256'",
      "is distinct from 'number'",
      "!~ '^[1-9][0-9]*$'",
      "!~ '^[0-9a-f]{64}$'",
    ]) {
      expect(bindingFunction).toContain(contract);
    }
  });

  it("enforces kind-aware immutable filenames and exact content types", () => {
    for (const contract of [
      "'/captures/[0-9a-f]{32}/page[.]jpg$'",
      "'/captures/[0-9a-f]{32}/document[.]pdf$'",
      "array['page', 'thumb', 'text', 'meta']",
      "array['pdf', 'text', 'meta']",
      "v_generation_prefix || 'page.jpg'",
      "v_generation_prefix || 'thumb.jpg'",
      "v_generation_prefix || 'document.pdf'",
      "v_generation_prefix || 'text.txt'",
      "v_generation_prefix || 'layout.json'",
      "v_generation_prefix || 'meta.json'",
      "'text/plain; charset=utf-8'",
      "'application/json; charset=utf-8'",
      "'application/pdf'",
      "'image/jpeg'",
      "'(^|/)(latest|previous)(/|$)'",
      "count(distinct object_entry.value)",
    ]) {
      expect(bindingFunction).toContain(contract);
    }
  });

  it("retains core page, PDF, text, and byte-length identity checks", () => {
    for (const contract of [
      "'{artifact_bindings,page,sha256}'",
      "p_hashes ->> 'image_hash'",
      "'{artifact_bindings,page,byte_length}'",
      "p_metadata ->> 'page_bytes'",
      "'{artifact_bindings,thumb,byte_length}'",
      "p_metadata ->> 'thumb_bytes'",
      "'{artifact_bindings,pdf,sha256}'",
      "p_hashes ->> 'file_hash'",
      "'{artifact_bindings,pdf,byte_length}'",
      "p_metadata ->> 'file_bytes'",
      "'{artifact_bindings,text,byte_length}'",
      "p_metadata ->> 'text_object_bytes'",
      "p_hashes ->> 'text_hash'",
      "p_metadata ->> 'text_length'",
    ]) {
      expect(bindingFunction).toContain(contract);
    }
  });

  it("requires complete contiguous expansion pairs and honest layout state", () => {
    for (const contract of [
      "'^expansion_state_[0-9]{2}$'",
      "'^expansion_state_[0-9]{2}_layout$'",
      "v_expansion_page_count <> v_expansion_layout_count",
      "p_object_keys ? (slot.slot_name || '_layout')",
      "> v_expansion_page_count",
      "p_metadata -> 'expansion_state_screenshots'",
      "'expansion-state-' || expected.suffix",
      "'expansion_state_' || expected.suffix",
      "'{text_geometry,geometry_hash}'",
      "'{text_geometry,screenshot,image_hash}'",
      "'{localization,status}' is distinct from 'geometry_ready'",
      "'visual-exact-text-binding-v2'",
      "'capture_layout_unavailable'",
      "'evidence_only_geometry_unavailable'",
      "'{text_geometry,status}' = 'unavailable'",
      "'{text_geometry,status}' ~ '^unavailable_'",
      "'{localization,unavailable_reason}'",
      "'{localization,geometry_ready}' is distinct from\n        'false'::jsonb",
      "'{localization,accounted_for}' is distinct from\n        'true'::jsonb",
    ]) {
      expect(bindingFunction).toContain(contract);
    }
  });

  it("signs every latest object-key slot from the exact reviewed metadata map", () => {
    for (const contract of [
      "'source_bindings', source_id::text, 'source_url'",
      "'source_bindings', source_id::text, 'captured_at'",
      "'source_bindings', source_id::text, 'object_keys'",
      "'source_bindings', source_id::text, 'hashes'",
      "'source_bindings', source_id::text, 'metadata'",
      "'source_bindings', source_id::text, 'r2_hashes'",
      "cross join lateral pg_catalog.jsonb_each_text(source.object_keys)",
      "'artifact_bindings', artifact.artifact_name, 'sha256'",
      "'artifact_bindings', artifact.artifact_name, 'hash_mode'",
      "'artifact_bindings', artifact.artifact_name, 'byte_length'",
      "'artifact_bindings', artifact.artifact_name, 'content_type'",
    ]) {
      expect(objectSetFunction).toContain(contract);
    }
    expect(manifestObjectRows).toContain("null::text as semantic_length");
    expect(manifestObjectRows).not.toContain("utf8_text_single_trailing_newline_v1");
    expect(objectSetFunction).toContain(
      "object_row.hash_mode is distinct from 'raw_sha256'",
    );
    expect(objectSetFunction).toContain(
      "'/captures/[0-9a-f]{32}/[^/]+$'",
    );
    expect(objectSetFunction).toContain(
      "when object_row.artifact_name = 'text' then",
    );
    expect(objectSetFunction).toContain(
      "or object_row.semantic_length is not null",
    );
  });

  it("publishes only a service-role v3 manifest and preserves fail-closed counts", () => {
    for (const contract of [
      "'awardping.stage1.r2-verification-manifest.v3'",
      "'artifact_bindings_schema'",
      "'awardping.r2.capture-artifact-bindings.v1'",
      "'unexpected_bucket_count'",
      "'malformed_object_count'",
      "'manifest_binding_error_count'",
      "'manifest_source_object_count'",
      "'objects'",
    ]) {
      expect(manifestFunction).toContain(contract);
    }
    expect(migration).toMatch(
      /revoke all on function public\.get_stage1_release_r2_verification_manifest\(\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.get_stage1_release_r2_verification_manifest\(\)\s+to service_role;/,
    );
    expect(migration).not.toMatch(
      /grant execute on function private\.stage1_/i,
    );
  });

  it("is a bounded function-only replacement with hardened search paths", () => {
    expect(bindingFunction).toContain("immutable\nset search_path = ''");
    expect(objectSetFunction).toContain(
      "stable\nsecurity definer\nset search_path = ''",
    );
    expect(manifestFunction).toContain(
      "stable\nsecurity definer\nset search_path = ''",
    );
    expect(migration).not.toMatch(/^\s*(?:create|alter|drop)\s+table\b/im);
    expect(migration).not.toMatch(/^\s*(?:insert|update|delete)\s+/im);
  });
});
