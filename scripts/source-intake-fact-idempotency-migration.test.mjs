import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260716152833_source_intake_fact_candidate_idempotency.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("source-intake fact candidate replay migration", () => {
  it("binds request, field, and value to one immutable candidate identity", () => {
    expect(migration).toContain("add column if not exists source_page_request_id uuid");
    expect(migration).toContain("add column if not exists intake_value_sha256 text");
    expect(migration).toContain("row_number() over");
    expect(migration).toContain("ranked.identity_rank = 1");
    expect(migration).toContain("metadata ->> 'source_page_request_id' = source_page_request_id::text");
    expect(migration).toContain(
      "intake_value_sha256 = public.awardping_sha256_text(normalized_value #>> '{}')",
    );
    expect(migration).toContain(
      "revoke all on function public.awardping_sha256_text(text)\n  from public, anon, authenticated, service_role",
    );
    expect(migration).toContain(
      "grant execute on function public.awardping_sha256_text(text) to service_role",
    );
    expect(migration).toMatch(/shared_award_fact_candidates_intake_identity_check[\s\S]*?\) is true\)/);
    expect(migration).toContain(
      "create unique index if not exists shared_award_fact_candidates_intake_identity_idx",
    );
    expect(migration).toContain(
      "source_page_request_id,\n    field_name,\n    intake_value_sha256",
    );
    expect(migration).toContain(
      "A source-intake fact candidate request/field/value identity is immutable.",
    );
  });
});
