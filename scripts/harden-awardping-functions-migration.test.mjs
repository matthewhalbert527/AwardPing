import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260714185608_harden_awardping_functions.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("AwardPing function hardening migration", () => {
  it("defines the production source-cap trigger before hardening it", () => {
    const definition = migration.indexOf(
      "create or replace function public.awardping_limit_worker_discovered_sources()",
    );
    const trigger = migration.indexOf(
      "create trigger awardping_limit_worker_discovered_sources_trigger",
    );
    const revoke = migration.indexOf(
      "revoke execute on function public.awardping_limit_worker_discovered_sources()",
    );

    expect(definition).toBeGreaterThanOrEqual(0);
    expect(trigger).toBeGreaterThan(definition);
    expect(revoke).toBeGreaterThan(trigger);
    expect(migration).toContain("from public.shared_award_sources existing");
    expect(migration).toContain("set search_path = ''");
  });
});
