import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const runbook = readFileSync(new URL("../docs/private-beta-launch.md", import.meta.url), "utf8");
const codeBlocks = (text) => [...text.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/g)]
  .map((match) => match[1]).join("\n");

// These narrow regression checks protect against restoring the obsolete quick
// start/launch recipes. They do not certify every operational instruction.
describe("operator setup instructions preserve verified bootstrap limits", () => {
  it("links both entry points to the actual fixture-assisted validation and its limits", () => {
    expect(readme).toContain("(docs/stage1-fixture-migration-smoke.md)");
    expect(runbook).toContain("(stage1-fixture-migration-smoke.md)");
    expect(readme).toContain("Fresh database bootstrap remains unresolved");
    expect(runbook).toContain("Historical reference, not a current production execution checklist");
  });

  it("does not offer ordinary database startup or blanket push as executable setup", () => {
    for (const document of [readme, runbook]) {
      expect(codeBlocks(document)).not.toMatch(/\bsupabase(?:@\S+)?\s+(?:start|db\s+(?:start|reset|push)|migration\s+repair)\b/i);
      expect(document).not.toMatch(/(?:Apply every migration|run \*\*every\*\* `\.sql` file)/i);
    }
  });

  it("removes the legacy seed recipe and separates UI development from production", () => {
    expect(readme).not.toContain("npm run seed:shared-awards");
    expect(readme).toContain("For UI-only development without starting a database or worker");
    expect(readme).toContain("exactly 25 national award cohorts");
    expect(readme).toContain("must never be applied to a live database");
    expect(runbook).toContain("must never be applied to a live database");
  });
});
