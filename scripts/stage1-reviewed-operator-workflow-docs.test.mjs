import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const guide = readFileSync(
  resolve(root, "docs", "stage1-reviewed-source-and-candidate-workflow.md"),
  "utf8",
);
const manifestGuide = readFileSync(
  resolve(root, "docs", "stage1-manifest-draft.md"),
  "utf8",
);

describe("Stage 1 reviewed operator workflow documentation", () => {
  it("exposes both preview/confirm operator commands through package scripts", () => {
    expect(packageJson.scripts["stage1:source-plan"]).toBe(
      "node scripts/build-stage1-reviewed-source-onboarding-plan.mjs",
    );
    expect(packageJson.scripts["stage1:import-reviewed"]).toBe(
      "node scripts/import-reviewed-stage1-candidates.mjs",
    );
    expect(guide).toContain("npm run stage1:source-plan");
    expect(guide).toContain("--confirm=<exact-preview-plan-sha256>");
    expect(guide).toContain("npm run stage1:import-reviewed");
    expect(guide).toContain("CONFIRM STAGE1 CANDIDATE IMPORT <bundle-sha256>");
  });

  it("states the exact cohort and both no-charge boundaries", () => {
    expect(guide).toContain("exactly 25 awards");
    expect(guide).toContain("200 award-role slots");
    expect(guide).toContain("`historical_import` plus `baseline_only`");
    expect(guide).toContain("`new_page_review` lane");
    expect(guide).toContain("daily cap is $5");
    expect(guide).toContain("confirmed candidate import makes no paid API calls");
    expect(guide).toMatch(
      /does not\s+change sources, releases, reconciliation, publication state/,
    );
  });

  it("keeps canonical identity separate from delegated contractor authority", () => {
    expect(guide).toContain("Hertz has a reviewed canonical identity migration");
    expect(guide).toContain("NDSEG remains canonically rooted at `https://ndseg.org/`");
    expect(guide).toContain("`https://ndseg.org/apply-link`");
    expect(guide).toContain("`official_contractor_host`");
    expect(guide).toContain("does not replace the canonical NDSEG identity");
  });

  it("requires a separate PII-free, write-once candidate receipt", () => {
    expect(guide).toContain("separate, new receipt path");
    expect(guide).toContain("The apply receipt is write-once");
    expect(guide).toContain("no reviewer identity");
    expect(guide).toContain("An exact replay is allowed");
    expect(manifestGuide).toContain("stage1-reviewed-source-and-candidate-workflow.md");
  });
});
