import { describe, expect, it } from "vitest";
import {
  isUsefulBackfilledSummary,
  summaryNeedsBackfill,
} from "@/lib/summary-backfill";

describe("summary backfill rules", () => {
  it("targets missing, placeholder, and very short summaries", () => {
    expect(summaryNeedsBackfill(null)).toBe(true);
    expect(summaryNeedsBackfill("Official pages for the award.")).toBe(true);
    expect(summaryNeedsBackfill("Scholarship")).toBe(true);
    expect(
      summaryNeedsBackfill("AAUW Select Professions Fellowship provides $20,000."),
    ).toBe(true);
  });

  it("keeps useful existing award summaries", () => {
    expect(
      summaryNeedsBackfill(
        "The Truman Scholarship supports college juniors preparing for public service leadership through graduate funding, professional development, and a national network of civic-minded scholars.",
      ),
    ).toBe(false);
  });

  it("rejects generated summaries that talk about the page instead of the award", () => {
    expect(
      isUsefulBackfilledSummary(
        "The website provides official source pages for students to learn more about this award.",
      ),
    ).toBe(false);
    expect(
      isUsefulBackfilledSummary(
        "The fellowship funds graduate study for students preparing for public service careers, with selection focused on leadership, academic preparation, and sustained civic commitment.",
      ),
    ).toBe(true);
  });

  it("targets summaries copied from update blurbs, pages, and navigation", () => {
    expect(
      summaryNeedsBackfill(
        "The Application page added the following wording: candidates should submit transcripts after completing the online form.",
      ),
    ).toBe(true);
    expect(
      summaryNeedsBackfill(
        "Skip to main content Toggle Menu Apply Learn More Privacy Policy Cookie Policy Contact Us.",
      ),
    ).toBe(true);
    expect(
      summaryNeedsBackfill(
        "The FAQ page provides information, resources, and guidance for applicants interested in this scholarship.",
      ),
    ).toBe(true);
  });

  it("rejects generated summaries that describe information instead of support", () => {
    expect(
      isUsefulBackfilledSummary(
        "The program page provides information and resources about eligibility, application requirements, deadlines, and frequently asked questions for applicants.",
      ),
    ).toBe(false);
    expect(
      isUsefulBackfilledSummary(
        "The Marshall Scholarship funds graduate study in the United Kingdom for high-achieving U.S. students with strong academic records and leadership potential.",
      ),
    ).toBe(true);
    expect(
      isUsefulBackfilledSummary(
        "AAUW International Fellowships support non-U.S. women pursuing graduate STEM studies in the U.S. to apply their expertise in their home countries.",
      ),
    ).toBe(true);
  });
});
