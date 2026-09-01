import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260901140000_serve_stale_publication_snapshot_while_refreshing.sql",
    import.meta.url,
  ),
  "utf8",
);

function compact(value) {
  return value.replace(/\s+/g, " ").trim();
}

const compacted = compact(migration);

describe("serve-stale publication snapshot migration", () => {
  it("replaces only the page-serving snapshot read", () => {
    expect(compacted).toContain(
      "create or replace function public.get_stage1_publication_snapshot()",
    );
    // The gate reads through list_stage1_effective_publication; its exact
    // high-water match must survive this migration untouched.
    expect(compacted).not.toContain(
      "create or replace function public.list_stage1_effective_publication",
    );
    expect(compacted).not.toContain(
      "create or replace function private.stage1_publication_snapshot_refresh",
    );
  });

  it("serves any existing cache row without comparing the high-water", () => {
    const cacheRead = compacted.indexOf(
      "from private.stage1_publication_snapshot_cache cache",
    );
    const serveBranch = compacted.indexOf("if found then", cacheRead);
    const staleReturn = compacted.indexOf("return v_cache.snapshot;", serveBranch);
    expect(cacheRead).toBeGreaterThan(-1);
    expect(serveBranch).toBeGreaterThan(cacheRead);
    expect(staleReturn).toBeGreaterThan(serveBranch);
    // The old inline-recompute condition compared the stored high-water; the
    // serving branch must no longer gate on it.
    const servedRegion = compacted.slice(serveBranch, staleReturn);
    expect(servedRegion).not.toContain("registry_high_water");
  });

  it("keeps the inline compute only for the empty-cache first boot", () => {
    const staleReturn = compacted.indexOf("return v_cache.snapshot;");
    const inlineCompute = compacted.indexOf(
      "private.stage1_publication_snapshot_compute()",
    );
    expect(inlineCompute).toBeGreaterThan(staleReturn);
    expect(compacted).toContain(
      "insert into private.stage1_publication_snapshot_cache",
    );
    expect(compacted).toContain("on conflict (id) do update");
  });

  it("still computes the registry high-water for first-boot cache writes", () => {
    expect(compacted).toContain(
      "select coalesce(max(registry.updated_at), '-infinity'::timestamptz)",
    );
    expect(compacted).toContain("security definer");
    expect(compacted).toContain("set search_path to ''");
  });
});
