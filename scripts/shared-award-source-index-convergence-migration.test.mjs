import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationsUrl = new URL("../supabase/migrations/", import.meta.url);
const migrationName = readdirSync(migrationsUrl).find((name) =>
  name.endsWith("_converge_shared_award_source_cleanup_indexes.sql"),
);
const migration = migrationName
  ? readFileSync(new URL(migrationName, migrationsUrl), "utf8")
  : "";
const runbook = readFileSync(
  new URL("../docs/supabase-migration-history.md", import.meta.url),
  "utf8",
);

const obsoleteIndexes = [
  "shared_awards_status_slug_idx",
  "shared_award_sources_award_review_created_idx",
  "shared_award_sources_review_id_idx",
  "shared_award_sources_review_award_idx",
];

describe("shared-award source index convergence migration", () => {
  it("keeps the live active-award keyset index and removes obsolete indexes", () => {
    expect(migrationName).toBeTruthy();
    expect(migration).toMatch(
      /create index if not exists shared_awards_status_id_idx\s+on public\.shared_awards \(status, id\);/,
    );

    for (const indexName of obsoleteIndexes) {
      expect(migration).toContain(`drop index if exists public.${indexName};`);
      expect(migration).not.toContain(`create index if not exists ${indexName}`);
    }
  });

  it("records the required history repair before forward application", () => {
    expect(runbook).toContain(
      "supabase migration repair 20260703093000 --status applied --linked",
    );
    expect(runbook).toContain(
      "Do not execute `20260703093000_shared_award_source_cleanup_indexes.sql`",
    );
    expect(runbook).toContain(
      "supabase db push --include-all --linked --dry-run",
    );
    expect(runbook).toContain("supabase db push --include-all --linked");
    expect(runbook.indexOf("migration repair 20260703093000")).toBeLessThan(
      runbook.indexOf("supabase db push --include-all --linked --dry-run"),
    );
    expect(
      runbook.indexOf("supabase db push --include-all --linked --dry-run"),
    ).toBeLessThan(
      runbook.lastIndexOf("supabase db push --include-all --linked"),
    );
  });
});
