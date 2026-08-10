import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260810200944_bind_r2_manifest_hash_inputs.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Stage 1 R2 manifest hash-input migration", () => {
  it("tightens PDF captures without rewriting applied compatibility aliases", () => {
    expect(migration).toContain("p_capture -> 'thumbnail'");
    expect(migration).toContain("stage1_published_capture_reference_graph_valid(jsonb)");
    expect(migration).toContain("pg_catalog.pg_get_functiondef(");
    expect(migration).toContain("The published-capture PDF contract could not be tightened safely.");
  });

  it("exports and self-checks exact PostgreSQL hash inputs", () => {
    for (const contract of [
      "private.stage1_r2_reference_set_hash_input(",
      "reference_set_hash_input",
      "visual_object_set_hash_input",
      "v_reference_hash_input::jsonb",
      "v_object_hash_input::jsonb",
      "The canonical R2 hash inputs do not match the live object graph.",
    ]) expect(migration).toContain(contract);
  });

  it("keeps the manifest service-only and all helpers private", () => {
    expect(migration).toMatch(
      /revoke all on function private\.stage1_r2_reference_set_hash_input\(jsonb\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.get_stage1_release_r2_verification_manifest\(\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.get_stage1_release_r2_verification_manifest\(\)\s+to service_role;/,
    );
  });
});
