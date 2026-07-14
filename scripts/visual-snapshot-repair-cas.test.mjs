import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./repair-visual-snapshot-previous-object-keys.mjs", import.meta.url),
  "utf8",
);

describe("visual snapshot previous-key repair concurrency", () => {
  it("guards each manual repair with the exact row version", () => {
    expect(source).toContain(
      '.select("shared_award_source_id,previous_captured_at,previous_object_keys,updated_at")',
    );
    expect(source).toContain('.order("shared_award_source_id", { ascending: true })');
    expect(source).toContain('update.eq("updated_at", row.updated_at)');
    expect(source).toContain('update.is("updated_at", null)');
    expect(source).toContain('if (!updated) {\n      conflicts += 1;');
  });
});
