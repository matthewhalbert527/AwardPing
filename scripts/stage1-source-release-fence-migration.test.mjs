import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260716223000_stage1_source_release_fence.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Stage 1 reviewed-source release fence migration", () => {
  it("takes the national advisory lock before source rows are selected", () => {
    const statementFence = migration.slice(
      migration.indexOf(
        "create or replace function public.stage1_source_release_fence_before_statement()",
      ),
      migration.indexOf(
        "revoke all on function public.stage1_source_release_fence_before_statement()",
      ),
    );
    expect(statementFence).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(statementFence).toContain("stage1-national-25-release");
    expect(migration).toContain("for each statement");
    expect(migration).toContain("before update of");
    expect(migration).toContain("before delete on public.shared_award_sources");
  });

  it("invalidates only cohorts whose reviewed manifest contains the source", () => {
    expect(migration).toContain(
      "where v_source_id = any(manifest.source_ids)",
    );
    expect(migration).toContain(
      "publication_state = 'revalidation_pending'",
    );
    expect(migration).toContain(
      "perform public.invalidate_stage1_cohort_release(",
    );
    expect(migration).toContain(
      "insert into public.stage1_award_publication_events",
    );
  });

  it("covers every source field consumed by the public event predicate", () => {
    for (const column of [
      "shared_award_id",
      "url",
      "admin_review_status",
      "title",
      "display_title",
      "page_metadata",
      "page_metadata_generated_at",
      "page_metadata_model",
      "page_type",
      "source",
      "reason",
      "submitted_by_user_id",
    ]) {
      expect(migration).toContain(column);
      expect(migration).toContain(`old.${column} is distinct from new.${column}`);
    }
  });

  it("does not expose trigger functions to browser or service roles", () => {
    expect(migration).toContain(
      "from public, anon, authenticated, service_role;",
    );
    expect(migration).not.toMatch(/grant execute/i);
  });
});
