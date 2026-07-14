import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationsUrl = new URL("../supabase/migrations/", import.meta.url);
const migrationName = readdirSync(migrationsUrl).find((name) =>
  name.endsWith("_harden_worker_discovered_source_limit.sql"),
);
const migration = migrationName
  ? readFileSync(new URL(migrationName, migrationsUrl), "utf8")
  : "";
const captureScript = readFileSync(
  new URL("capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);
const discoveredSourceWriter = captureScript.slice(
  captureScript.indexOf("function discoveredSourceRow("),
  captureScript.indexOf("function reserveDiscoveryCap("),
);

describe("worker-discovered source limit forward migration", () => {
  it("recreates the hardened function and trigger before revoking browser execution", () => {
    const definition = migration.indexOf(
      "create or replace function public.awardping_limit_worker_discovered_sources()",
    );
    const trigger = migration.indexOf(
      "create trigger awardping_limit_worker_discovered_sources_trigger",
    );
    const revoke = migration.indexOf(
      "revoke execute on function public.awardping_limit_worker_discovered_sources()",
    );

    expect(migrationName).toBeTruthy();
    expect(definition).toBeGreaterThanOrEqual(0);
    expect(trigger).toBeGreaterThan(definition);
    expect(revoke).toBeGreaterThan(trigger);
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain("from public.shared_award_sources existing");
    expect(migration).toContain("from public, anon, authenticated;");
  });

  it("uses the live source discriminator and serializes the per-award cap", () => {
    expect(discoveredSourceWriter).toContain('source: "admin"');
    expect(discoveredSourceWriter).toContain('kind: "source_discovery_candidate"');
    expect(discoveredSourceWriter).not.toContain('source: "discovery"');

    expect(migration).toContain("new.source = 'admin'");
    expect(migration).toContain(
      "coalesce(new.page_metadata ->> 'kind', '') = 'source_discovery_candidate'",
    );
    expect(migration).toContain("from public.shared_awards award");
    expect(migration).toContain("for update;");
    expect(migration).not.toContain("new.reason like 'Local worker discovered%'");
  });
});
