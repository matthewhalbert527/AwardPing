import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalSourceUrlKey as policyCanonicalSourceUrlKey,
  filterTrackableOfficialSources,
} from "../src/lib/source-url-policy.ts";

// Four canonicalizers, each with its own ignored-parameter policy, must all
// serialize query tuples injectively: URLSearchParams entries arrive decoded,
// so a raw key=value join lets one parameter whose value contains "&" or "="
// collide with separate parameters, and sorting on that ambiguous text lets
// the same multiset in another order produce a different key. The three
// operational scripts are never imported; only their pure canonicalizer
// functions are extracted from source text and evaluated here.

const ENCODED_DELIMITER = "https://example.edu/award?a=x%26b%3Dy";
const SEPARATE_PARAMS = "https://example.edu/award?a=x&b=y";
const REORDERED_PARAMS = "https://example.edu/award?b=y&a=x";
const DELIMITER_TUPLES = "https://example.edu/award?a=x%3Db&a%3Dx=b";
const DELIMITER_TUPLES_REVERSED = "https://example.edu/award?a%3Dx=b&a=x%3Db";

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

// Evaluates the named pure functions of one script together, so helpers can
// call each other, and returns them by name.
function pureFunctions(relative, names) {
  const text = source(relative);
  const body = names.map((name) => functionText(text, name)).join("\n");
  return new Function(`${body}\nreturn { ${names.join(", ")} };`)();
}

const audit = pureFunctions("./audit-shared-source-coverage.mjs", [
  "findDuplicateSources",
  "preferenceScore",
  "canonicalUrlKey",
  "canonicalSearchParams",
]);
const backfill = pureFunctions("./backfill-low-coverage-award-sources.mjs", [
  "canonicalUrlKey",
  "canonicalSearchParams",
]);
const importer = pureFunctions("./import-fellowship-directories.mjs", ["canonicalSourceUrlKey"]);

describe.each([
  ["audit-shared-source-coverage", audit.canonicalUrlKey],
  ["backfill-low-coverage-award-sources", backfill.canonicalUrlKey],
  ["import-fellowship-directories", importer.canonicalSourceUrlKey],
  ["source-url-policy", policyCanonicalSourceUrlKey],
])("%s canonical URL keys", (_label, key) => {
  it("keeps an encoded delimiter value distinct from separate parameters", () => {
    expect(key(ENCODED_DELIMITER)).not.toBe(key(SEPARATE_PARAMS));
  });

  it("canonicalizes ordinary parameter reordering equally", () => {
    expect(key(REORDERED_PARAMS)).toBe(key(SEPARATE_PARAMS));
  });

  it("sorts encoded pairs so delimiter-bearing tuples reorder equally", () => {
    expect(key(DELIMITER_TUPLES)).toBe(key(DELIMITER_TUPLES_REVERSED));
  });
});

describe("canonical key consumers keep the distinct pair apart", () => {
  it("audit duplicate grouping produces no loser for the distinct pair", () => {
    const row = (id, url, confidence) => ({
      id,
      shared_award_id: "award-1",
      url,
      page_type: "application",
      confidence,
    });
    expect(
      audit.findDuplicateSources([row("encoded", ENCODED_DELIMITER, 0.9), row("separate", SEPARATE_PARAMS, 0.3)]),
    ).toEqual([]);
    // A legitimate duplicate is still grouped and its loser still identified.
    const legitimate = audit.findDuplicateSources([
      row("keep", "https://www.example.edu/award/", 0.9),
      row("remove", "http://example.edu/award", 0.3),
    ]);
    expect(legitimate.map((pair) => [pair.keep.id, pair.remove.id])).toEqual([["keep", "remove"]]);
  });

  it("filterTrackableOfficialSources retains both distinct rows", () => {
    expect(filterTrackableOfficialSources([{ url: ENCODED_DELIMITER }, { url: SEPARATE_PARAMS }])).toHaveLength(2);
    // Reordered parameters still collapse to one tracked source.
    expect(filterTrackableOfficialSources([{ url: SEPARATE_PARAMS }, { url: REORDERED_PARAMS }])).toHaveLength(1);
  });

  it("backfill and directory-import keys map the distinct pair to two entries", () => {
    expect(new Set([backfill.canonicalUrlKey(ENCODED_DELIMITER), backfill.canonicalUrlKey(SEPARATE_PARAMS)]).size).toBe(2);
    expect(
      new Set([importer.canonicalSourceUrlKey(ENCODED_DELIMITER), importer.canonicalSourceUrlKey(SEPARATE_PARAMS)]).size,
    ).toBe(2);
  });
});
