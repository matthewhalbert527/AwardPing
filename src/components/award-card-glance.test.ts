import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
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
      firstPublishedCaptureAt: "2026-09-01T12:00:00Z",
    });
    expect(html).toContain('aria-label="Award at a glance"');
    expect([...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((match) => match[1]))
      .toEqual(["Level", "Citizenship", "Last update"]);
    expect(html).toContain("Sophomores; Juniors</dd>");
    expect(html).toContain("U.S. citizens, nationals or permanent residents</dd>");
    const date = load(html)('dd[data-field="updates"] time');
    expect(date.attr("datetime")).toBe("2026-09-01T12:00:00.000Z");
    expect(date.text()).toBe("September 1, 2026");
    expect(html).not.toMatch(/source pages|<button|<a\s|tabindex|role="button"/);
  });

  it("never hides later array entries or infers broader citizenship", () => {
    const html = render({
      academicLevels: ["High school senior", "Undergraduate", "Master's", "Doctoral"],
      citizenship: ["United States", "Australia", "Canada", "New Zealand", "United Kingdom"],
      changeCount: 1,
      latestUpdateAt: "2026-09-08T03:00:00Z",
    });
    expect(html).toContain("High school senior; Undergraduate; Master&#x27;s; Doctoral</dd>");
    expect(html).toContain("U.S.; Australia; Canada; New Zealand; U.K.</dd>");
    const date = load(html)('dd[data-field="updates"] time');
    expect(date.attr("datetime")).toBe("2026-09-08T03:00:00.000Z");
    expect(date.text()).toBe("September 7, 2026");
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

  it.each([
    [1, "Last recorded update:", "September 7, 2026", "2026-09-08T03:00:00.000Z"],
    [0, "First available information capture:", "December 31, 2025", "2026-01-01T05:30:00.000Z"],
  ] as const)("shows only a clean date for count %i, with full provenance in tooltip and accessible name", (changeCount, provenance, date, dateTime) => {
    const $ = load(render({
      academicLevels: [], citizenship: [], changeCount,
      latestUpdateAt: "2026-09-08T03:00:00Z", firstPublishedCaptureAt: "2026-01-01T05:30:00Z",
    }));
    const field = $('dd[data-field="updates"]');
    expect(field).toHaveLength(1);
    expect(field.parent().find("dt").text()).toBe("Last update");
    expect(field.text()).toBe(date);
    expect(field.attr("title")).toMatch(new RegExp(`^${provenance}`));
    expect(field.find("time")).toHaveLength(1);
    expect(field.find("time").attr("datetime")).toBe(dateTime);
    expect(field.find("time").attr("aria-label")).toBe(field.attr("title"));
    expect(field.attr("class")).not.toContain("highlight");
  });

  it.each([0, 1, null])("does not render a time element or imply recency without the required timestamp for count %s", (changeCount) => {
    const $ = load(render({ academicLevels: [], citizenship: [], changeCount }));
    const field = $('dd[data-field="updates"]');
    expect(field.text()).toBe("Not available");
    expect(field.find("time")).toHaveLength(0);
    expect(field.attr("title")).toBeUndefined();
    expect(field.attr("class")).not.toContain("highlight");
  });
});
