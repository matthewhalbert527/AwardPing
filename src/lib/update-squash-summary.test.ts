import { describe, expect, it } from "vitest";
import {
  buildConciseReadableSummary,
  stripRawChangeLead,
} from "../../scripts/lib/update-squash-summary.mjs";

describe("update squasher summary normalization", () => {
  it("rewrites long raw page-lead summaries into concise reader text", () => {
    const summary =
      "The PACE Science and Applications Team page has removed past dates and related notices. The specific text removed was: 'Any individual comfortable doing so is encouraged to contact the panel/solicitation program official directly.' Additionally, the past dates for Release, NOIs Due, Proposals Due, and Selection have been removed.";

    expect(stripRawChangeLead(summary)).toMatch(/^Removed past dates and related notices\./);

    const concise = buildConciseReadableSummary(summary);
    expect(concise).toBe(
      "Removed past dates and related notices. The past dates for Release, NOIs Due, Proposals Due, and Selection have been removed.",
    );
    expect(concise.length).toBeLessThanOrEqual(360);
  });

  it("does not auto-normalize low-value raw page-lead noise", () => {
    const summary =
      "The Example Awards page has changed footer navigation and social media wording. The specific text changed was: 'Follow us on Instagram and YouTube for updates.'";

    expect(buildConciseReadableSummary(summary)).toBe("");
  });

  it("does not split readable summaries at Ph.D. or i.e. abbreviations", () => {
    const summary =
      "The Research Proposal page has added new wording: Information for Postdoc Applicants The Berlin Program funds recent postdocs, i.e. applicants whose Ph.D. was conferred in the last two calendar years or will be conferred before the fellowship would begin. Advisors should review this eligibility language.";

    const concise = buildConciseReadableSummary(summary);

    expect(concise).toContain("i.e. applicants whose Ph.D. was conferred");
    expect(concise).not.toMatch(/whose Ph\.D\.$/);
  });

  it("keeps combined M.D./Ph.D. degree labels intact", () => {
    const summary =
      "The page for Individual Predoctoral NRSA for M. D./Ph.D. Fellowships (F 30) now includes a note directing users to the \"Individual Fellowships\" section for general guidance, policy, and program information relevant to individual fellowships.";

    const concise = buildConciseReadableSummary(summary);

    expect(concise).toContain("M.D./Ph.D. Fellowships");
    expect(concise).not.toContain("M. /Ph.D.");
  });
});
