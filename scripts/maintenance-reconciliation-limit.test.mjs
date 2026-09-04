import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// run-awardping-maintenance.mjs and reconcile-impacted-award-pages.mjs are
// operational entrypoints, so this suite reads their source text only.
//
// The maintenance runner forwards --limit to the reconciliation consumer and
// records the same value in run metadata. The consumer accepts only a
// positive integer and falls back to 250, so the runner must normalize to a
// positive integer as well: an explicit --reconcile-limit wins, a positive
// numeric --aggregate-limit may still be inherited for compatibility, and
// anything absent, invalid, nonpositive, or "all" becomes 250.

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n?/g, "\n");
}

// A top-level function from its declaration to its column-zero closing brace.
function functionText(text, name) {
  const start = text.indexOf(`function ${name}(`);
  expect(start, `function ${name}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}\n", start);
  expect(end, `end of function ${name}`).toBeGreaterThan(start);
  return text.slice(start, end + 2);
}

const maintenance = source("./run-awardping-maintenance.mjs");
const consumer = source("./reconcile-impacted-award-pages.mjs");

const RECONCILE_LIMIT_DECLARATION = [
  "const reconcileLimit = positiveInt(",
  '  args["reconcile-limit"] || args["aggregate-limit"],',
  "  250,",
  ");",
].join("\n");

describe("maintenance reconciliation limit contract", () => {
  it("normalizes reconcileLimit with positiveInt and never with stringArg or \"all\"", () => {
    expect(maintenance).toContain(RECONCILE_LIMIT_DECLARATION);
    expect(maintenance).not.toMatch(/const reconcileLimit = stringArg\(/);
    expect(maintenance).not.toMatch(/reconcileLimit[^\n]*"all"/);
    // The aggregate contract is separate and unchanged.
    expect(maintenance).toContain('const aggregateLimit = stringArg(args["aggregate-limit"], "all");');
  });

  it("gives an explicit reconcile limit precedence, inherits a numeric aggregate limit, and falls back to 250", () => {
    const declaration = maintenance.match(/const reconcileLimit = (positiveInt\([\s\S]*?\));\n/);
    expect(declaration, "positiveInt-based reconcileLimit declaration").not.toBeNull();
    const positiveInt = functionText(maintenance, "positiveInt");
    const normalize = new Function("args", `${positiveInt}\nreturn ${declaration[1]};`);

    expect(normalize({ "reconcile-limit": "40", "aggregate-limit": "9" })).toBe(40);
    expect(normalize({ "aggregate-limit": "9" })).toBe(9);
    expect(normalize({ "reconcile-limit": "all", "aggregate-limit": "9" })).toBe(250);
    expect(normalize({ "aggregate-limit": "all" })).toBe(250);
    expect(normalize({ "reconcile-limit": "0" })).toBe(250);
    expect(normalize({ "reconcile-limit": "-3" })).toBe(250);
    expect(normalize({ "reconcile-limit": "abc" })).toBe(250);
    expect(normalize({})).toBe(250);
  });

  it("forwards the one normalized value to the consumer and records it in metadata", () => {
    const runReconcileAwards = functionText(maintenance, "runReconcileAwards");
    expect(runReconcileAwards).toContain('"scripts/reconcile-impacted-award-pages.mjs"');
    expect(runReconcileAwards).toContain("`--limit=${reconcileLimit}`");
    expect(maintenance).toMatch(/reconciliation_options: \{\n\s*limit: reconcileLimit,/);
  });

  it("matches the consumer, which accepts only a positive integer and defaults to 250", () => {
    expect(consumer).toContain("const limit = positiveInt(args.limit, 250);");
    expect(consumer).toContain("  --limit=250");
    const positiveInt = new Function(`${functionText(consumer, "positiveInt")}\nreturn positiveInt;`)();
    expect(positiveInt("all", 250)).toBe(250);
    expect(positiveInt("0", 250)).toBe(250);
    expect(positiveInt("12", 250)).toBe(12);
  });

  it("exposes --reconcile-limit in the useful options without advertising the aggregate fallback", () => {
    const usefulOptions = maintenance.slice(maintenance.indexOf("Useful options:"));
    expect(usefulOptions).toContain("  --reconcile-limit=250");
    expect(usefulOptions).not.toContain("aggregate-limit");
  });
});
