import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("snapshot dialog evidence layout", () => {
  it("bounds and scrolls long explanations so saved-page controls remain reachable", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    const rule = css.match(/\.source-snapshot-dialog\s*>\s*\.source-snapshot-evidence\s*\{([^}]+)\}/)?.[1];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/max-height:\s*min\(32vh,\s*20rem\)/);
    expect(rule).toMatch(/min-height:\s*0/);
    expect(rule).toMatch(/flex-shrink:\s*0/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });
});
