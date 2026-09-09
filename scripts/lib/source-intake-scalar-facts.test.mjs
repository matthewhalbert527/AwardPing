import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { readSourceIntakeScalarFactIssue } from "./source-intake-scalar-facts.mjs";

/** Values a scalar fact field is allowed to hold. */
const ALLOWED = [
  ["absent", undefined],
  ["null", null],
  ["an empty string", ""],
  ["whitespace only", "   "],
  ["ordinary text", "March 1, 2027"],
  // Out of scope by design: this checker reports declared types, not content.
  ["the word null", "null"],
  ["a unitless numeric string", "5000"],
];

/** Values that are not text, falsy ones included. */
const REJECTED = [
  ["a number", 5000],
  ["zero", 0],
  ["true", true],
  ["false", false],
  ["an empty array", []],
  ["an array of strings", ["March 1", "March 15"]],
  ["an object", { text: "March 1" }],
  ["an empty object", {}],
];

const review = (facts) => ({ status: "accepted", confidence: "high", facts });
const expected = (field) => ({ field, reason: `invalid_fact_type_${field}` });

describe.each(["description", "deadline"])("scalar fact field %s", (field) => {
  it.each(ALLOWED)("allows %s", (_label, value) => {
    expect(readSourceIntakeScalarFactIssue(review({ [field]: value }))).toBeNull();
  });

  it.each(REJECTED)("reports %s", (_label, value) => {
    expect(readSourceIntakeScalarFactIssue(review({ [field]: value }))).toEqual(expected(field));
  });
});

describe("canonical amount", () => {
  it.each(ALLOWED)("allows %s", (_label, value) => {
    expect(readSourceIntakeScalarFactIssue(review({ amount: value }))).toBeNull();
  });

  it.each(REJECTED)("reports %s, falsy wrong types included", (_label, value) => {
    expect(readSourceIntakeScalarFactIssue(review({ amount: value }))).toEqual(expected("amount"));
  });
});

describe("legacy award_amount alias", () => {
  /** [description, amount, award_amount, issue field or null] */
  const ALIAS_CASES = [
    ["an absent amount consults the alias", undefined, {}, "award_amount"],
    ["a null amount consults the alias", null, {}, "award_amount"],
    ["an empty amount consults the alias", "", {}, "award_amount"],
    ["a whitespace amount wins, so the alias is ignored", "   ", {}, null],
    ["a text amount wins, so the alias is ignored", "$1,000", {}, null],
    ["a text amount outranks valid alias text", "$1,000", "$9,000", null],
    ["a valid alias is reached when the amount is absent", undefined, "$9,000", null],
    ["neither field present is allowed", undefined, undefined, null],
    ["a null alias is allowed", undefined, null, null],
    ["a falsy wrong-typed amount outranks the alias", 0, "$9,000", "amount"],
    ["an empty-array amount outranks the alias", [], "$9,000", "amount"],
  ];

  it.each(ALIAS_CASES)("%s", (_label, amount, award_amount, field) => {
    const result = readSourceIntakeScalarFactIssue(review({ amount, award_amount }));
    expect(result).toEqual(field === null ? null : expected(field));
  });
});

describe("facts container", () => {
  /** [description, review, issue field or null] */
  const CONTAINER_CASES = [
    ["a missing container states no facts", { status: "accepted" }, null],
    ["an explicitly undefined container", { facts: undefined }, null],
    ["a null container", { facts: null }, null],
    ["a string container", { facts: "March 1" }, "facts"],
    ["a number container", { facts: 5000 }, "facts"],
    ["a boolean container", { facts: true }, "facts"],
    ["an empty array container", { facts: [] }, "facts"],
    ["an array of fact objects", { facts: [{ deadline: "March 1" }] }, "facts"],
  ];

  it.each(CONTAINER_CASES)("%s", (_label, input, field) => {
    expect(readSourceIntakeScalarFactIssue(input)).toEqual(field === null ? null : expected(field));
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 7],
    ["a string", "text"],
    ["true", true],
    ["an array", []],
    ["an empty object", {}],
  ])("returns null for a review that is %s, rather than throwing", (_label, value) => {
    expect(readSourceIntakeScalarFactIssue(value)).toBeNull();
  });
});

describe("contract", () => {
  it("reports the container first, then description, deadline, amount, alias", () => {
    const allBad = { description: {}, deadline: {}, amount: {}, award_amount: {} };
    expect(readSourceIntakeScalarFactIssue({ facts: "not an object" })).toEqual(expected("facts"));
    expect(readSourceIntakeScalarFactIssue(review(allBad))).toEqual(expected("description"));
    expect(readSourceIntakeScalarFactIssue(review({ ...allBad, description: "ok" })))
      .toEqual(expected("deadline"));
    expect(readSourceIntakeScalarFactIssue(review({ ...allBad, description: "ok", deadline: "ok" })))
      .toEqual(expected("amount"));
    expect(readSourceIntakeScalarFactIssue(
      review({ ...allBad, description: "ok", deadline: "ok", amount: null }),
    )).toEqual(expected("award_amount"));
  });

  it("pairs every reason with its own field and returns nothing else", () => {
    const issues = [
      readSourceIntakeScalarFactIssue({ facts: 1 }),
      readSourceIntakeScalarFactIssue(review({ description: 1 })),
      readSourceIntakeScalarFactIssue(review({ deadline: 1 })),
      readSourceIntakeScalarFactIssue(review({ amount: 1 })),
      readSourceIntakeScalarFactIssue(review({ award_amount: 1 })),
    ];
    expect(issues.map((entry) => entry.field))
      .toEqual(["facts", "description", "deadline", "amount", "award_amount"]);
    for (const entry of issues) {
      expect(Object.keys(entry)).toEqual(["field", "reason"]);
      expect(entry.reason).toBe(`invalid_fact_type_${entry.field}`);
    }
  });

  it("reads the original result, never a raw property or a model-supplied flag", () => {
    // A normalized result's `raw` must not be consulted in either direction.
    expect(readSourceIntakeScalarFactIssue({
      facts: { deadline: "March 1, 2027" },
      raw: { facts: { deadline: { on: "March 1" } } },
    })).toBeNull();
    expect(readSourceIntakeScalarFactIssue({
      facts: { deadline: { on: "March 1" } },
      raw: { facts: { deadline: "March 1, 2027" } },
    })).toEqual(expected("deadline"));

    // The model's own verdict on its output carries no weight either way.
    expect(readSourceIntakeScalarFactIssue({
      facts: { deadline: { on: "March 1" } },
      facts_valid: true,
      issues: [],
      validation: { ok: true },
    })).toEqual(expected("deadline"));
    expect(readSourceIntakeScalarFactIssue({
      facts: { deadline: "March 1, 2027" },
      issues: ["deadline_unparseable"],
    })).toBeNull();
  });

  it("treats an inherited fact as absent rather than reading the prototype", () => {
    expect(readSourceIntakeScalarFactIssue({
      facts: Object.create({ deadline: { on: "March 1" } }),
    })).toBeNull();
  });

  it("returns a fresh result, mutates nothing, and leaks no input value", () => {
    const input = review({ description: "An example award.", deadline: { on: "March 1" }, amount: 0 });
    const before = structuredClone(input);

    const first = readSourceIntakeScalarFactIssue(input);
    const second = readSourceIntakeScalarFactIssue(input);
    expect(input).toEqual(before);
    expect(first).toEqual(expected("deadline"));
    expect(first).toEqual(second);
    // Distinct objects, so editing one result cannot change a later one.
    expect(first).not.toBe(second);
    first.field = "mutated";
    expect(readSourceIntakeScalarFactIssue(input)).toEqual(expected("deadline"));
    expect(JSON.stringify(readSourceIntakeScalarFactIssue(input))).not.toContain("March 1");
  });

  it("stays pure: no imports, no I/O, no hashing, no callbacks", () => {
    const text = readFileSync(new URL("./source-intake-scalar-facts.mjs", import.meta.url), "utf8");
    expect(text).not.toMatch(/^import\s/m);
    expect(text).not.toMatch(/require\(|createHash|fetch\(|process\.env|eval\(|new Function|readFile|writeFile/);
  });
});
