import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../supabase/migrations/20260903233000_stage1_explicit_review_not_quarantine.sql", import.meta.url),
  "utf8",
);
const lane = readFileSync(new URL("./reconcile-impacted-award-pages.mjs", import.meta.url), "utf8");

// The quarantine sync keys terminal public-page quarantines on the latest
// reconciliation row per award being 'failed'. Stage 1 "explicit review
// required" outcomes are the lane declining to auto-reconcile a human-reviewed
// cohort; they must neither open nor hold a quarantine.
describe("stage1 explicit-review outcomes are not quarantines", () => {
  const exclusion = "coalesce(reconciliation.error, '') not like 'stage1_explicit_review_required:%'";

  it("excludes the prefix from the requires-action predicate and the resolution predicate", () => {
    expect(migration.split(exclusion).length - 1).toBe(2);
    expect(migration).toContain(
      "and reconciliation.status = 'failed'\n        -- 2026-09-03:",
    );
    expect(migration).toContain(`${exclusion} as reconciliation_requires_action`);
  });

  it("replaces the live function rather than editing the base migration", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.sync_manual_quarantine_registry()");
    expect(migration).not.toMatch(/insert into public\.manual_quarantine_registry\s*\(\s*quarantine_key/i);
  });

  it("keeps the worker's prefix so the exclusion and the lane agree", () => {
    expect(lane).toContain("`stage1_explicit_review_required:${stage1Scope.cohortKey}`");
    // The lane now finishes the Stage 1 canonical row 'skipped'; the RPC treats
    // 'skipped' and 'failed' alike for release invalidation, and the sync keys
    // only on 'failed', so future rows never quarantine even before the sync
    // exclusion is relied upon.
    const branch = lane.slice(
      lane.indexOf("if (stage1Scope.cohortKey) {"),
      lane.indexOf("const award = await loadAwardById(stage1Scope.canonicalAwardId);"),
    );
    expect(branch).toContain('"skipped",');
    expect(branch).not.toContain('"failed",');
  });
});
