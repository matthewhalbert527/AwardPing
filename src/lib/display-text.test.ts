import { describe, expect, it } from "vitest";
import { readableSourceTitle } from "@/lib/display-text";

describe("display text helpers", () => {
  it("uses readable source labels for URLs, root paths, and raw route titles", () => {
    expect(readableSourceTitle("https://agbell.org/financial-aid/", "https://agbell.org/financial-aid/")).toBe(
      "Financial Aid",
    );
    expect(readableSourceTitle("/", "https://agbell.org/")).toBe("Homepage");
    expect(
      readableSourceTitle(
        "/resources/view/asa-rise-applications-open-for-cohort-6-fellows",
        "https://example.org/resources/view/asa-rise-applications-open-for-cohort-6-fellows",
      ),
    ).toBe("Asa Rise Applications Open For Cohort 6 Fellows");
    expect(
      readableSourceTitle(
        "learn more",
        "https://www.airforce.com/frequently-asked-questions/education-training",
      ),
    ).toBe("Education Training");
    expect(readableSourceTitle("Apply", "https://www.aaas.org/fellowships/mass-media/apply")).toBe(
      "Mass Media Application",
    );
    expect(readableSourceTitle("APPLY", "http://www.aaas.org/page/apply")).toBe(
      "Application Page",
    );
    expect(
      readableSourceTitle(
        "Apply",
        "https://www.aaas.org/programs/diverse-voices-science-journalism-internship/apply",
      ),
    ).toBe("Diverse Voices Science Journalism Internship Application");
    expect(
      readableSourceTitle(
        "tips here.",
        "https://www.aaas.org/page/application-tips-mass-media-science-engineering-fellowship",
      ),
    ).toBe("Mass Media Science Engineering Fellowship Application Tips");
  });
});
