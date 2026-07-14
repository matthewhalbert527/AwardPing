import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);

describe("duplicate visual candidate handling", () => {
  it("returns an explicit existing outcome without deleting referenced evidence", () => {
    expect(source).toContain("existing: true");
    expect(source).toContain("duplicate: true");
    expect(source).toContain("EXISTING visual_review_candidate");
    expect(source).toContain("EXISTING text_only_visual_candidate");
    expect(source).toContain("EXISTING visual_review_candidate_pdf");
    expect(source).toContain('if (queueResult?.existing) return "existing"');
    expect(source).toContain("if (existing === 0 && !keepUnchanged)");
  });
});
