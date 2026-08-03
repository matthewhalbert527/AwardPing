import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260803183600_fix_stage1_activation_visual_text_identity.sql",
  ),
  "utf8",
);

describe("Stage 1 baseline activation persistence contract repair", () => {
  it("separates raw artifact identity from normalized reviewed-text identity", () => {
    expect(migration).toContain(
      "awardping.stage1.baseline-activation-persistence-evidence.v3",
    );
    expect(migration).toContain("'normalized_text_sha256'");
    expect(migration).toContain(
      "coalesce(v_local ->> 'normalized_text_sha256', '') !~ '^[0-9a-f]{64}$'",
    );
    expect(migration).toContain(
      "v_r2 #>> array['latest_hashes', 'text_hash'] is distinct from\n      v_local ->> 'text_hash'",
    );
    expect(migration).not.toContain(
      "v_local ->> 'text_hash' is distinct from\n      p_observed_normalized_text_sha256",
    );
    expect(migration).not.toContain(
      "v_local ->> 'normalized_text_sha256' is distinct from\n      p_observed_normalized_text_sha256",
    );
  });

  it("keeps the validator private and strict about exact evidence keys", () => {
    expect(migration).toContain("private.stage1_jsonb_has_exact_keys(v_local");
    expect(migration).toContain("private.stage1_jsonb_has_exact_keys(v_r2");
    expect(migration).toContain(
      "revoke all on function private.stage1_activation_persistence_evidence_valid(",
    );
    expect(migration).toContain("from public, anon, authenticated, service_role");
  });
});
