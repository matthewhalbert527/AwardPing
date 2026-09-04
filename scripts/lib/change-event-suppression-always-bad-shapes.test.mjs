import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changeEventSuppressionDecision as scriptsChangeEventSuppressionDecision } from "./change-event-suppression.mjs";
import { changeEventSuppressionDecision as appChangeEventSuppressionDecision } from "../../src/lib/change-event-suppression.ts";

// Contract tests for the always-bad source-shape class after the whitespace
// terminator fix. The pattern matches sourceText, which joins source_url to
// title/page_type with spaces, so a URL that ends exactly at a bad path
// segment is followed by a space: the "$" branch alone could never suppress
// it, and whether a bad URL suppressed depended on the arbitrary presence of
// a trailing "/", "?", or "#". conditionalSourceShapePattern already carries
// the whitespace terminator; this suite pins the same contract for the
// unconditional class.
//
// Unlike the conditional shapes there is NO applicant-signal override here: a
// matching shape suppresses even a real deadline change with deterministic
// evidence. That larger blast radius is pinned explicitly below, and every
// path-only segment carries a near-miss negative so the whitespace terminator
// cannot quietly widen the class.

const baseSource = {
  id: "source-1",
  url: "https://example.edu/scholarships/example-award",
  title: "Example Award",
  page_type: "application",
  admin_review_status: "open",
  page_metadata_generated_at: "2026-07-14T00:00:00.000Z",
  page_metadata_model: "gemini-test",
  page_metadata: {
    baseline_facts: {
      award_relevance: "primary",
      cycle_relevance: "current_or_upcoming",
      quality_flags: [],
    },
  },
};

function sourceWith(overrides = {}) {
  return { ...baseSource, ...overrides };
}

function event(summary, changeDetails = {}, sourceOverride = baseSource) {
  return {
    id: `event-${summary.slice(0, 20)}`,
    shared_award_source_id: sourceOverride.id,
    source_url: sourceOverride.url,
    source_title: sourceOverride.title,
    source_page_type: sourceOverride.page_type,
    summary,
    change_details: changeDetails,
  };
}

// A capture that never got bound to a shared source row: the quality gate is
// skipped, so alwaysBadSourcePattern is the only source-shape guard.
function sourcelessEvent(summary, changeDetails, { url, title, pageType }) {
  return {
    id: `event-${url}`,
    shared_award_source_id: null,
    source_url: url,
    source_title: title,
    source_page_type: pageType,
    summary,
    change_details: changeDetails,
  };
}

const listingChurn = "Three upcoming listings rotated overnight.";
const deadlineSummary = "The application deadline changed from March 1, 2027 to March 15, 2027.";
const deadlineEvidence = {
  is_alert_worthy: true,
  generation_status: "generated",
  structured_diff: {
    added_text: ["Application deadline: March 15, 2027"],
    removed_text: ["Application deadline: March 1, 2027"],
  },
};

// Path-only always-bad segments: as bare words they are too common for the
// word-form branch, so only the "/segment" alternation can catch them. Each
// URL ends exactly at the segment with no trailing "/", "?", or "#".
const pathOnlyUrlFinal = [
  "https://awards.example.edu/search",
  "https://example.edu/admissions/results",
  "https://example.edu/scholarships/list",
  "https://example.edu/opportunities/listing",
  "https://example.edu/faculty/directory",
  "https://example.edu/funding/database",
];

describe.each([
  ["scripts/lib matcher", scriptsChangeEventSuppressionDecision],
  ["src/lib matcher", appChangeEventSuppressionDecision],
])("always-bad source shapes (%s)", (_label, decide) => {
  describe("URL-final path segments suppress routine churn on a bound source", () => {
    // These pass the monitoring source-quality gate, so only the whitespace
    // terminator can suppress them.
    it.each(pathOnlyUrlFinal)("url: %s", (url) => {
      const source = sourceWith({ url });
      expect(
        decide(event(listingChurn, { is_alert_worthy: true }, source), source),
      ).toEqual({ suppressed: true, reason: "source_shape_noise" });
    });
  });

  describe("URL-final segments suppress source-less captures", () => {
    // With no bound source the quality gate never runs, so the shape pattern
    // must catch the segments the gate would otherwise reject.
    it.each([
      ["https://apply.example.edu/signin", "Applicant Portal"],
      ["https://example.edu/account/sign-in", "Account Access"],
      ["https://billing.example.edu/payments", "Student Billing"],
    ])("url: %s", (url, title) => {
      expect(
        decide(
          sourcelessEvent(listingChurn, { is_alert_worthy: true }, {
            url,
            title,
            pageType: "application",
          }),
          null,
        ),
      ).toEqual({ suppressed: true, reason: "source_shape_noise" });
    });
  });

  describe("URL-final segments suppress retro sweeps", () => {
    // Retro sweeps skip the quality gate and read only the event-side
    // source_url/title/page_type, so the URL is again followed by a space.
    it.each([
      ...pathOnlyUrlFinal,
      "https://billing.example.edu/payments",
      "https://apply.example.edu/signin",
    ])("url: %s", (url) => {
      const source = sourceWith({ url });
      expect(
        decide(event(listingChurn, { is_alert_worthy: true }, source), source, {
          mode: "retro_sweep",
        }),
      ).toEqual({ suppressed: true, reason: "source_shape_noise" });
    });
  });

  describe("near misses stay live", () => {
    const liveDetails = { is_alert_worthy: true, generation_status: "generated" };

    // One near miss per path-only segment: the whitespace terminator may not
    // loosen the slash anchor or the segment spelling. The first six pass the
    // monitoring quality gate; the payments/signin/sign-in near misses are
    // rejected by that gate on a bound source, so only the gate-skipping retro
    // sweep can prove the shape matcher itself leaves them alone.
    const gatePassingNearMisses = [
      "https://example.edu/funding/search-tips",
      "https://example.edu/admissions/results-archive",
      "https://example.edu/awards/listings",
      "https://example.edu/apply/checklist",
      "https://example.edu/graduate-directory",
      "https://example.edu/scholarship-database",
    ];
    const gateRejectedNearMisses = [
      "https://example.edu/billing/payments-faq",
      "https://example.edu/help/signin-help",
      "https://example.edu/help/sign-in-guide",
    ];

    it.each(gatePassingNearMisses)("url does not qualify: %s", (url) => {
      const source = sourceWith({ url });
      expect(
        decide(event(deadlineSummary, liveDetails, source), source),
      ).toEqual({ suppressed: false, reason: null });
    });

    it.each([
      ...gatePassingNearMisses,
      ...gateRejectedNearMisses,
    ])("url does not qualify in a retro sweep: %s", (url) => {
      const source = sourceWith({ url });
      expect(
        decide(event(deadlineSummary, liveDetails, source), source, {
          mode: "retro_sweep",
        }),
      ).toEqual({ suppressed: false, reason: null });
    });

    it.each(gateRejectedNearMisses)("url is rejected by the quality gate, not the shape gate: %s", (url) => {
      const source = sourceWith({ url });
      expect(
        decide(event(deadlineSummary, liveDetails, source), source),
      ).toEqual({ suppressed: true, reason: "source_quality_url_not_monitorable" });
    });

    it.each([
      // The path-only segments are path-only by design: as bare title words
      // they never qualify.
      "Search the Awards Database",
      "Directory of External Funding",
    ])("title does not qualify: %s", (title) => {
      const source = sourceWith({ title });
      expect(
        decide(event(deadlineSummary, liveDetails, source), source),
      ).toEqual({ suppressed: false, reason: null });
    });

    it("a search-results mention inside the summary cannot qualify the page shape", () => {
      expect(
        decide(
          event(
            "The search results section now lists the application deadline as March 15, 2027.",
            liveDetails,
            baseSource,
          ),
          baseSource,
        ),
      ).toEqual({ suppressed: false, reason: null });
    });
  });

  describe("no applicant-signal override on the always-bad class", () => {
    // Deterministic applicant evidence defuses the conditional-shape branch,
    // so these suppressions can only come from alwaysBadSourcePattern - and
    // they document the unconditional blast radius: a real deadline change on
    // an always-bad shape still suppresses.
    it("suppresses a deadline change with evidence on a URL-final /search page", () => {
      const source = sourceWith({ url: "https://awards.example.edu/search" });
      expect(
        decide(event(deadlineSummary, deadlineEvidence, source), source),
      ).toEqual({ suppressed: true, reason: "source_shape_noise" });
    });

    it("suppresses a deadline change with evidence on a careers-titled page", () => {
      const source = sourceWith({ title: "Careers and Student Employment" });
      expect(
        decide(event(deadlineSummary, deadlineEvidence, source), source),
      ).toEqual({ suppressed: true, reason: "source_shape_noise" });
    });
  });

  describe("guard ordering around the quality gate", () => {
    it("rejects a URL-final /jobs page at the quality gate, not the shape gate", () => {
      const source = sourceWith({ url: "https://example.edu/about/jobs" });
      expect(
        decide(event(listingChurn, { is_alert_worthy: true }, source), source),
      ).toEqual({ suppressed: true, reason: "source_quality_url_not_monitorable" });
    });

    it("suppresses the same URL-final /jobs page in a retro sweep, where the gate is skipped", () => {
      const source = sourceWith({ url: "https://example.edu/about/jobs" });
      expect(
        decide(event(listingChurn, { is_alert_worthy: true }, source), source, {
          mode: "retro_sweep",
        }),
      ).toEqual({ suppressed: true, reason: "source_shape_noise" });
    });
  });
});

describe("matcher twin parity", () => {
  function alwaysBadShapeLiteral(fileUrl) {
    const text = readFileSync(fileUrl, "utf8").replace(/\r\n?/g, "\n");
    const start = text.indexOf("const alwaysBadSourcePattern =");
    expect(start).toBeGreaterThanOrEqual(0);
    const literal = text
      .slice(start)
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .find((line) => line.startsWith("/") && !line.startsWith("//"));
    expect(literal).toBeTruthy();
    return literal;
  }

  const scriptsLiteral = alwaysBadShapeLiteral(
    new URL("./change-event-suppression.mjs", import.meta.url),
  );
  const appLiteral = alwaysBadShapeLiteral(
    new URL("../../src/lib/change-event-suppression.ts", import.meta.url),
  );

  // The whole literal, structurally: a word-form alternation, then a
  // "/segment" alternation closed by the shared terminator group.
  const LITERAL_SHAPE =
    /^\/\\b\(\?:(?<words>[^()]*)\)\\b\|\\\/\(\?:(?<paths>[^()]*)\)\(\?:\[\/\?#\]\|\\s\|\$\)\/i;$/;
  const WORD_FORMS =
    "jobs?|careers?|employment|search results?|payment|bursar|1098t|security question|access denied|login|sign in";
  const PATH_SEGMENTS =
    "jobs?|careers?|employment|search|results|listing|list|directory|database|payment|payments|bursar|1098t|login|signin|sign-in";

  it("keeps the always-bad source pattern identical across the .mjs and .ts twins", () => {
    expect(scriptsLiteral).toBe(appLiteral);
  });

  it("terminates the path alternation on whitespace as well as [/?#] and end-of-string", () => {
    expect(scriptsLiteral).toContain("(?:[/?#]|\\s|$)");
    expect(scriptsLiteral).toMatch(LITERAL_SHAPE);
  });

  it("carries exactly the existing always-bad word forms and path segments", () => {
    const groups = scriptsLiteral.match(LITERAL_SHAPE)?.groups;
    expect(groups).toBeTruthy();
    expect(groups.words).toBe(WORD_FORMS);
    expect(groups.paths).toBe(PATH_SEGMENTS);
  });
});
