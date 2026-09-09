import { describe, expect, it } from "vitest";

import { sourceIntakeReviewExplanation } from "@/lib/source-intake-operator-actions";

/** The two stored statuses that hold a request for a person. */
const HELD_STATUSES = ["needs_manual_review", "failed"] as const;

/** Every other value the stored status column holds today. */
const OTHER_STATUSES = [
  "pending",
  "queued",
  "validating",
  "capturing",
  "ai_review_pending",
  "ai_review_submitted",
  "ai_review_succeeded",
  "matching",
  "added",
  "rejected",
] as const;

/** [stored reason code, exact operator-facing description] */
const EXPLAINED: ReadonlyArray<readonly [string, string]> = [
  [
    "invalid_fact_type_facts",
    "The AI review returned award details in an unsupported format. Check the proposed details against the official source before deciding.",
  ],
  [
    "invalid_fact_type_description",
    "The AI review returned the description in an unsupported format. Check that detail against the official source before deciding.",
  ],
  [
    "invalid_fact_type_deadline",
    "The AI review returned the deadline in an unsupported format. Check that detail against the official source before deciding.",
  ],
  [
    "invalid_fact_type_amount",
    "The AI review returned the award amount in an unsupported format. Check that detail against the official source before deciding.",
  ],
  [
    "invalid_fact_type_award_amount",
    "The AI review returned the award amount in an unsupported format. Check that detail against the official source before deciding.",
  ],
  [
    "source_relevance_unclear",
    "The AI review could not confirm that this page is relevant to the award. Check the page against the award before deciding.",
  ],
  [
    "cycle_relevance_unclear",
    "The AI review could not confirm which award cycle this page applies to. Check the cycle on the official source before deciding.",
  ],
  [
    "officialness_unclear",
    "The AI review could not confirm that this is an official source. Check who publishes the page before deciding.",
  ],
  [
    "confidence_low",
    "The AI review did not provide enough confidence for automatic intake. Check the proposed details against the official source before deciding.",
  ],
];

const COVERED_REASONS = EXPLAINED.map(([reason]) => reason);

describe.each(HELD_STATUSES)("held status %s", (status) => {
  it.each(EXPLAINED)("describes %s", (reason, text) => {
    expect(sourceIntakeReviewExplanation(status, reason)).toBe(text);
  });
});

describe("statuses that are not held for review", () => {
  it.each(OTHER_STATUSES)("returns null for %s", (status) => {
    for (const reason of COVERED_REASONS) {
      expect(sourceIntakeReviewExplanation(status, reason), reason).toBeNull();
    }
  });

  /** [description, status] */
  it.each([
    ["a status the worker no longer writes", "needs_review"],
    ["a status that never existed", "manual_review"],
    ["upper case", "NEEDS_MANUAL_REVIEW"],
    ["title case", "Failed"],
    ["a leading space", " failed"],
    ["a trailing space", "failed "],
    ["a trailing space on the held status", "needs_manual_review "],
    ["an empty string", ""],
    ["a longer code containing the status", "request_failed_closed"],
  ])("returns null for %s", (_label, status) => {
    for (const reason of COVERED_REASONS) {
      expect(sourceIntakeReviewExplanation(status, reason), reason).toBeNull();
    }
  });
});

describe("reason codes this copy does not cover", () => {
  /** [description, reason] */
  it.each([
    ["an empty string", ""],
    ["an unrelated code", "matching_failed_closed_operator_retry_required"],
    ["a truncated prefix", "invalid_fact_type"],
    ["a fact field with no copy", "invalid_fact_type_eligibility"],
    ["a leading space", " confidence_low"],
    ["a trailing space", "confidence_low "],
    ["upper case", "CONFIDENCE_LOW"],
    ["a covered code embedded in a longer one", "prefix_confidence_low_suffix"],
    ["a substring of a covered code", "confidence"],
  ])("returns null for %s", (_label, reason) => {
    for (const status of HELD_STATUSES) {
      expect(sourceIntakeReviewExplanation(status, reason), status).toBeNull();
    }
  });

  // A plain object lookup would answer these from its prototype and hand the
  // caller a function or an object where copy was expected.
  it.each([
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
  ])("returns null for the prototype key %s", (reason) => {
    for (const status of HELD_STATUSES) {
      // A plain-object lookup would return Object.prototype for "__proto__"
      // and a function for the rest, so null is the assertion that bites.
      expect(sourceIntakeReviewExplanation(status, reason), status).toBeNull();
    }
  });
});

describe("malformed inputs", () => {
  /** [description, value] */
  const MALFORMED: ReadonlyArray<readonly [string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 7],
    ["zero", 0],
    ["true", true],
    ["false", false],
    ["an array", ["needs_manual_review"]],
    ["an object", { status: "needs_manual_review", statusReason: "confidence_low" }],
    ["a boxed string", Object("needs_manual_review")],
    ["a date", new Date(0)],
    ["an empty object", {}],
  ];

  it.each(MALFORMED)("returns null when the status is %s", (_label, status) => {
    for (const reason of COVERED_REASONS) {
      expect(sourceIntakeReviewExplanation(status, reason), reason).toBeNull();
    }
  });

  it.each(MALFORMED)("returns null when the reason is %s", (_label, reason) => {
    for (const status of HELD_STATUSES) {
      expect(sourceIntakeReviewExplanation(status, reason), status).toBeNull();
    }
  });

  it.each(MALFORMED)("returns null when both arguments are %s", (_label, value) => {
    expect(sourceIntakeReviewExplanation(value, value)).toBeNull();
  });
});

describe("copy contract", () => {
  it("never prescribes an operator action or claims anything was verified", () => {
    for (const reason of COVERED_REASONS) {
      const text = sourceIntakeReviewExplanation("needs_manual_review", reason);
      expect(text, reason).not.toBeNull();
      // No action advice: the request has not been examined by anyone yet.
      expect(text, reason).not.toMatch(/\bretry\b|\battach\b|\bapprove|\breject/i);
      // No claim that the source or its facts are settled.
      expect(text, reason).not.toMatch(/\bverified\b|\bpublished\b|\bconfirmed\b/i);
    }
  });

  it("asks for a comparison and leaves the decision open", () => {
    for (const reason of COVERED_REASONS) {
      const text = sourceIntakeReviewExplanation("failed", reason);
      expect(text, reason).toContain("The AI review");
      expect(text, reason).toContain("Check ");
      expect(text, reason).toMatch(/ before deciding\.$/);
    }
  });

  it("gives both held statuses the identical text, so the two surfaces agree", () => {
    for (const reason of COVERED_REASONS) {
      expect(sourceIntakeReviewExplanation("needs_manual_review", reason), reason)
        .toBe(sourceIntakeReviewExplanation("failed", reason));
    }
  });

  it("uses one award-amount wording for the canonical field and its legacy alias", () => {
    expect(sourceIntakeReviewExplanation("failed", "invalid_fact_type_amount"))
      .toBe(sourceIntakeReviewExplanation("failed", "invalid_fact_type_award_amount"));
  });

  it("returns only a string or null", () => {
    const values: unknown[] = [...COVERED_REASONS, "", "unknown", "__proto__", 7, null, undefined, {}];
    for (const status of [...HELD_STATUSES, ...OTHER_STATUSES, "", 7, null]) {
      for (const reason of values) {
        const result = sourceIntakeReviewExplanation(status, reason);
        expect(result === null || typeof result === "string").toBe(true);
      }
    }
  });
});
