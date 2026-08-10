import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const previousMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260810194427_complete_published_event_r2_reference_graph.sql",
    import.meta.url,
  ),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260810214212_materialize_stage1_publication_evidence_snapshots.sql",
    import.meta.url,
  ),
  "utf8",
);

function functionBody(sql) {
  const signature =
    "create or replace function public.list_stage1_effective_publication()";
  const start = sql.indexOf(signature);
  const end = sql.indexOf(
    "revoke all on function public.list_stage1_effective_publication()",
    start,
  );
  if (start < 0 || end <= start) return "";
  return sql.slice(start, end);
}

function compact(value) {
  return value.replace(/\s+/g, " ").trim();
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}

const previousFunction = functionBody(previousMigration);
const effectivePublication = functionBody(migration);

describe("Stage 1 publication snapshot performance migration", () => {
  it("changes only CTE evaluation strategy in the publication decision", () => {
    expect(previousFunction).not.toBe("");
    expect(effectivePublication).not.toBe("");
    expect(
      compact(effectivePublication).replace(/\bas materialized\b/g, "as"),
    ).toBe(compact(previousFunction));
  });

  it("materializes only the crop snapshot that the planner duplicated", () => {
    expect(effectivePublication).toMatch(
      /\bcoverage\s+as\s+materialized\s*\(/,
    );
    expect(occurrences(effectivePublication, "as materialized")).toBe(1);

    expect(
      occurrences(
        effectivePublication,
        "public.stage1_effective_pub_pre_r2_graph_20260810184524()",
      ),
    ).toBe(1);
    expect(
      occurrences(
        effectivePublication,
        "private.stage1_visual_r2_object_set_snapshot()",
      ),
    ).toBe(1);
    expect(
      occurrences(
        effectivePublication,
        "private.stage1_visual_crop_coverage_snapshot()",
      ),
    ).toBe(1);
  });

  it("preserves the fail-closed evidence and artifact bindings", () => {
    for (const contract of [
      "artifact.producer_kind = 'database_derived'",
      "artifact.app_revision = runtime.app_revision",
      "private.stage1_r2_recovery_evidence_matches_snapshot(",
      "artifact.evidence ->> 'eligible_events' =",
      "artifact.evidence ->> 'verified_events' =",
      "artifact.evidence ->> 'unverified_publishable_events' =",
      "artifact.evidence ->> 'terminal_failures' =",
      "artifact.evidence ->> 'pdf_evidence_failures' =",
      "artifact.evidence ->> 'coverage_set_hash' =",
      "artifact.evidence ->> 'reference_schema' =",
      "artifact.evidence ->> 'visual_object_set_hash' =",
      "private.stage1_visual_crop_derivation_contract_hash()",
      "artifact.evidence ->> 'r2_hashes_verified' = 'true'",
      "artifact.evidence ->> 'r2_artifact_id' = r2.id::text",
      "base.effectively_verified",
      "and r2_release_proof.current",
      "and crop_release_proof.current",
      "signed_r2_recovery_artifact_not_current",
      "database_derived_crop_artifact_not_current",
    ]) {
      expect(effectivePublication, contract).toContain(contract);
    }

    expect(effectivePublication).toContain("stable");
    expect(effectivePublication).toContain("security definer");
    expect(effectivePublication).toContain("set search_path = ''");
    expect(migration).not.toMatch(/statement_timeout/i);
  });

  it("keeps the RPC private to the service role and makes no data changes", () => {
    expect(migration).toMatch(
      /revoke all on function public\.list_stage1_effective_publication\(\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.list_stage1_effective_publication\(\)\s+to service_role;/,
    );
    expect(migration).not.toMatch(
      /grant\s+execute[\s\S]*?\bto\s+(?:public|anon|authenticated)\b/i,
    );
    expect(migration).not.toMatch(
      /^\s*(?:insert|update|delete|create|alter|drop)\s+table\b/im,
    );
    expect(migration).not.toContain(
      "create or replace function public.get_stage1_publication_snapshot()",
    );
  });
});
