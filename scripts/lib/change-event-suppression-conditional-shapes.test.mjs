import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changeEventSuppressionDecision as scriptsChangeEventSuppressionDecision } from "./change-event-suppression.mjs";
import { changeEventSuppressionDecision as appChangeEventSuppressionDecision } from "../../src/lib/change-event-suppression.ts";

// Contract tests for the conditional source-shape extension (c644cb1):
// event-registration portals - "information session(s)" / "webinar(s)" title
// word forms and register|registration|information-session(s)|admission-events|
// webinar(s) URL path segments. Knight-Hennessy and Schwarzman registration
// pages rotate listings nightly; routine churn on a matching shape suppresses
// as source_shape_noise, while deterministic applicant evidence (deadline,
// eligibility) in the structured diff still surfaces the event.

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

describe.each([
  ["scripts/lib matcher", scriptsChangeEventSuppressionDecision],
  ["src/lib matcher", appChangeEventSuppressionDecision],
])("conditional event-registration source shapes (%s)", (_label, decide) => {
  describe("new title word forms suppress routine listing churn", () => {
    it.each([
      "Knight-Hennessy Information Session",
      "Upcoming Information Sessions",
      "GRADUATE INFORMATION SESSIONS",
      "Admissions Webinar",
      "Scholarship Webinars",
      "FALL WEBINARS",
    ])("title: %s", (title) => {
      const source = sourceWith({ title });
      expect(
        decide(event(listingChurn, { is_alert_worthy: true }, source), source),
      ).toEqual({ suppressed: true, reason: "source_shape_noise" });
    });
  });

  describe("new URL path segments suppress routine listing churn", () => {
    it.each([
      // The Knight-Hennessy / Schwarzman register/?id= shape named in c644cb1.
      "https://apply.knight-hennessy.stanford.edu/register/?id=f8a3c2",
      "https://apply.schwarzmanscholars.org/portal/admission-events?year=2026",
      "https://gradadmissions.example.edu/registration/",
      "https://example.edu/apply/information-session/",
      "https://example.edu/apply/information-sessions?term=fall",
      "https://example.edu/outreach/webinar/",
      "https://example.edu/outreach/webinars#upcoming",
    ])("url: %s", (url) => {
      const source = sourceWith({ url });
      expect(
        decide(event(listingChurn, { is_alert_worthy: true }, source), source),
      ).toEqual({ suppressed: true, reason: "source_shape_noise" });
    });
  });

  describe("near misses stay live", () => {
    // A deadline summary with NO structured evidence: if the shape matched,
    // the missing deterministic applicant signal would force
    // source_shape_noise, so a clean pass proves the shape did not match.
    const liveDetails = { is_alert_worthy: true, generation_status: "generated" };

    it.each([
      "https://example.edu/registrar",
      "https://example.edu/registrar/academic-deadlines",
      "https://example.edu/apply/register-now",
      "https://example.edu/apply/preregistration",
    ])("url does not qualify: %s", (url) => {
      const source = sourceWith({ url });
      expect(
        decide(event(deadlineSummary, liveDetails, source), source),
      ).toEqual({ suppressed: false, reason: null });
    });

    it.each([
      // "sessions" without "information" in front is not a word-form match.
      "General Sessions Overview",
      "Session Recordings for Applicants",
      // "register" is a URL path segment only, never a title word form.
      "Register for the Mailing List",
    ])("title does not qualify: %s", (title) => {
      const source = sourceWith({ title });
      expect(
        decide(event(deadlineSummary, liveDetails, source), source),
      ).toEqual({ suppressed: false, reason: null });
    });

    it("a webinars mention inside the summary cannot qualify the page shape", () => {
      expect(
        decide(
          event(
            "The webinar section now lists the application deadline as March 15, 2027.",
            liveDetails,
            baseSource,
          ),
          baseSource,
        ),
      ).toEqual({ suppressed: false, reason: null });
    });
  });

  describe("applicant-signal override on matching shapes", () => {
    it("surfaces a deadline change on a register/?id= portal page", () => {
      const source = sourceWith({
        url: "https://apply.knight-hennessy.stanford.edu/register/?id=f8a3c2",
        title: "Knight-Hennessy Scholars Information Sessions",
      });
      expect(
        decide(event(deadlineSummary, deadlineEvidence, source), source),
      ).toEqual({ suppressed: false, reason: null });
    });

    it("surfaces an eligibility change on an admission-events page", () => {
      const source = sourceWith({
        url: "https://apply.schwarzmanscholars.org/portal/admission-events?year=2026",
        title: "Schwarzman Scholars Admission Events",
      });
      expect(
        decide(
          event("Eligibility requirements changed for the upcoming cycle.", {
            is_alert_worthy: true,
            generation_status: "generated",
            structured_diff: {
              added_text: ["Eligibility: applicants must hold citizenship of an eligible country."],
              removed_text: ["Eligibility: open to applicants from all countries."],
            },
          }, source),
          source,
        ),
      ).toEqual({ suppressed: false, reason: null });
    });

    it("surfaces a deadline change on a webinars-titled page", () => {
      const source = sourceWith({ title: "Scholarship Webinars" });
      expect(
        decide(event(deadlineSummary, deadlineEvidence, source), source),
      ).toEqual({ suppressed: false, reason: null });
    });
  });

  it("suppresses nightly rotation churn on a registration portal even when the summary names it", () => {
    const source = sourceWith({
      url: "https://apply.knight-hennessy.stanford.edu/register/?id=f8a3c2",
    });
    expect(
      decide(
        event(
          "The list of upcoming information sessions rotated; three timeslots were replaced.",
          { is_alert_worthy: true },
          source,
        ),
        source,
      ),
    ).toEqual({ suppressed: true, reason: "source_shape_noise" });
  });

  describe("url_not_monitorable quality gate on an /events registration listing", () => {
    const source = sourceWith({
      url: "https://connect.schwarzmanscholars.org/events/admission-events?year=2026",
      title: "Schwarzman Scholars Admission Events",
      page_type: "event",
    });

    it("suppresses plain churn at the quality gate, not the shape gate", () => {
      expect(
        decide(event(listingChurn, { is_alert_worthy: true }, source), source),
      ).toEqual({ suppressed: true, reason: "source_quality_url_not_monitorable" });
    });

    it("lets deterministic deadline evidence escape the quality gate and surface", () => {
      expect(
        decide(event(deadlineSummary, deadlineEvidence, source), source),
      ).toEqual({ suppressed: false, reason: null });
    });
  });
});

describe("matcher twin parity", () => {
  function conditionalShapeLiteral(fileUrl) {
    const text = readFileSync(fileUrl, "utf8").replace(/\r\n?/g, "\n");
    const start = text.indexOf("const conditionalSourceShapePattern =");
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

  const scriptsLiteral = conditionalShapeLiteral(
    new URL("./change-event-suppression.mjs", import.meta.url),
  );
  const appLiteral = conditionalShapeLiteral(
    new URL("../../src/lib/change-event-suppression.ts", import.meta.url),
  );

  it("keeps the conditional source-shape pattern identical across the .mjs and .ts twins", () => {
    expect(scriptsLiteral).toBe(appLiteral);
  });

  it("carries every c644cb1 alternative in both twins", () => {
    expect(scriptsLiteral).toContain("information sessions?|webinars?");
    expect(scriptsLiteral).toContain(
      "register|registration|information-sessions?|admission-events|webinars?",
    );
  });
});

describe("terminal path segment contract (c644cb1 intent)", () => {
  // LOUD FLAG - EXPECTED TO FAIL IF THE CODE HAS THE GAP, DO NOT "FIX" THE
  // TEST: c644cb1 names admission-events pages as a conditional churn shape,
  // and the path alternation deliberately allows a URL-final segment via the
  // "$" branch of (?:[/?#]|$). But changeEventSuppressionDecision matches the
  // pattern against sourceText, which joins the URL with title/page_type using
  // spaces - so a URL that ENDS at the matching segment is followed by a space,
  // the "$" branch can never fire, and nightly rotation churn on a bare
  // ".../admission-events" page still surfaces. If this test fails, the "$"
  // alternative is dead code in the decision path and the observed Schwarzman
  // shape is only covered when the URL carries a trailing "/", "?", or "#".
  it("suppresses rotation churn on a URL that ends at the admission-events segment", () => {
    const source = sourceWith({
      url: "https://connect.schwarzmanscholars.org/admission-events",
      title: "Admission Events",
      page_type: "event",
    });
    expect(
      scriptsChangeEventSuppressionDecision(
        event(listingChurn, { is_alert_worthy: true }, source),
        source,
      ),
    ).toEqual({ suppressed: true, reason: "source_shape_noise" });
  });
});
