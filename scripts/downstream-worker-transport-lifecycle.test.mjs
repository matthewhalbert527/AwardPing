import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function source(path) {
  return readFileSync(resolve(root, path), "utf8");
}

describe("scheduled downstream worker transport lifecycle", () => {
  it.each([
    "scripts/process-visual-review-batch.mjs",
    "scripts/reconcile-impacted-award-pages.mjs",
    "scripts/evaluate-public-page-audit-canaries.mjs",
    "scripts/process-monitoring-feedback-promotions.mjs",
  ])("closes Supabase transport at the terminal boundary in %s", (path) => {
    const script = source(path);
    expect(script).toContain("closeSupabaseServiceTransport");
    expect(script).toContain("await closeSupabaseServiceTransport();");
  });

  it("destroys active transport before the source-intake hard-deadline exit", () => {
    const script = source("scripts/process-source-intake-requests.mjs");
    const destroy = script.lastIndexOf("await destroySupabaseServiceTransport(");
    const hardExit = script.lastIndexOf("process.exit(workerStatus");
    expect(destroy).toBeGreaterThan(0);
    expect(hardExit).toBeGreaterThan(destroy);
    expect(script).toContain("await closeSupabaseServiceTransport();");
  });
});
