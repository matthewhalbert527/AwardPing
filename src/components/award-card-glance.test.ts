import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AwardCardGlance } from "@/components/award-card-glance";
import { type AwardCardGlanceInput } from "@/lib/award-card-glance";

function render(input: AwardCardGlanceInput) {
  return renderToStaticMarkup(createElement(AwardCardGlance, input));
}

describe("AwardCardGlance", () => {
  it("renders exactly three labeled, ordered facts with concise Goldwater eligibility", () => {
    const html = render({
      academicLevels: ["Sophomore", "Junior"],
      citizenship: ["U.S. citizen, U.S. national, or permanent resident of the United States."],
      changeCount: 0,
    });
    expect(html).toContain('aria-label="Award at a glance"');
    expect([...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((match) => match[1]))
      .toEqual(["Level", "Citizenship", "Updates"]);
    expect(html).toContain("Sophomores; Juniors</dd>");
    expect(html).toContain("U.S. citizens, nationals or permanent residents</dd>");
    expect(html).toContain("None recorded</dd>");
    expect(html).not.toMatch(/source pages|<button|<a\s|tabindex|role="button"/);
  });

  it("never hides later array entries or infers broader citizenship", () => {
    const html = render({
      academicLevels: ["High school senior", "Undergraduate", "Master's", "Doctoral"],
      citizenship: ["United States", "Australia", "Canada", "New Zealand", "United Kingdom"],
      changeCount: 1,
    });
    expect(html).toContain("High school senior; Undergraduate; Master&#x27;s; Doctoral</dd>");
    expect(html).toContain("U.S.; Australia; Canada; New Zealand; U.K.</dd>");
    expect(html).toContain("1 recorded</dd>");
  });

  it("defers the entire complex field to the award page and preserves the original detail", () => {
    const rule = "U.S. citizenship is not required for applicants attending a U.S. institution if eligible to work in the U.S. for 10–12 months.";
    const html = render({ academicLevels: [], citizenship: [rule], changeCount: null });
    expect(html).toContain("Not listed</dd>");
    expect(html).toContain(`title="${rule}"`);
    expect(html).toContain("See full criteria</dd>");
    expect(html).toContain("Not available</dd>");
    expect(html).not.toContain("International</dd>");
    expect(html).not.toContain("None recorded</dd>");
  });
});
