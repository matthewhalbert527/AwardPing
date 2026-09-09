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
  it("renders only a last-update stamp, without eligibility details or extra controls", () => {
    const html = render({
      academicLevels: ["Sophomore", "Junior"],
      citizenship: ["U.S. citizen, U.S. national, or permanent resident of the United States."],
      changeCount: 0,
      firstPublishedCaptureAt: "2026-09-01T12:00:00Z",
    });
    expect(html).toContain('aria-label="Award last update"');
    expect([...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((match) => match[1]))
      .toEqual(["Last update"]);
    expect(html).not.toMatch(/Sophomore|Junior|citizen|data-field="(?:level|citizenship)"/);
    const date = load(html)('dd[data-field="updates"] time');
    expect(date.attr("datetime")).toBe("2026-09-01T12:00:00.000Z");
    expect(date.text()).toBe("September 1, 2026");
    expect(html).not.toMatch(/source pages|<button|<a\s|tabindex|role="button"/);
  });

  it("keeps eligibility off the card even when several levels and countries are listed", () => {
    const html = render({
      academicLevels: ["High school senior", "Undergraduate", "Master's", "Doctoral"],
      citizenship: ["United States", "Australia", "Canada", "New Zealand", "United Kingdom"],
      changeCount: 1,
      latestUpdateAt: "2026-09-08T03:00:00Z",
    });
    expect(html).not.toMatch(/High school|Undergraduate|Doctoral|Australia|Canada|New Zealand/);
    const date = load(html)('dd[data-field="updates"] time');
    expect(date.attr("datetime")).toBe("2026-09-08T03:00:00.000Z");
    expect(date.text()).toBe("September 7, 2026");
  });

  it("does not leak complex eligibility into the stamp or its tooltip", () => {
    const rule = "U.S. citizenship is not required for applicants attending a U.S. institution if eligible to work in the U.S. for 10–12 months.";
    const html = render({ academicLevels: [], citizenship: [rule], changeCount: null });
    expect(html).not.toContain(rule);
    expect(html).not.toContain("See full criteria");
    expect(html).not.toContain("Not listed");
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
