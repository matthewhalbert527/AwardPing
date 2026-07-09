import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

const productionFiles = [
  "src/lib/award-fact-reconciliation.ts",
  "scripts/lib/award-fact-reconciliation.mjs",
  "src/lib/source-quality.ts",
  "scripts/lib/source-quality.mjs",
  "src/lib/source-ai-review-status.ts",
  "scripts/lib/source-ai-review-status.mjs",
].map((path) => resolve(root, path));

const forbiddenProductionStrings = [
  "afrl-summer-scholars-program",
  "luce-acls-dissertation-fellowships-in-american-art",
  "scholarsprofessionals",
  "Open Access Book Prize",
  "Arcadia Open Access Publishing Award",
];

describe("production hardcoded canary guard", () => {
  it("keeps known problematic award names and slugs out of production modules", () => {
    const violations = [];
    for (const file of productionFiles) {
      const body = readFileSync(file, "utf8");
      for (const forbidden of forbiddenProductionStrings) {
        if (body.includes(forbidden)) {
          violations.push(`${file}: ${forbidden}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
