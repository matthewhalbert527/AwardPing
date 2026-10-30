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
  it("separates verified details from changes without eligibility details or extra controls", () => {
    const html = render({
      academicLevels: ["Sophomore", "Junior"],
      citizenship: ["U.S. citizen, U.S. national, or permanent resident of the United States."],
      changeCount: 0,
      firstPublishedCaptureAt: "2026-09-01T12:00:00Z",
      detailsCheckedAt: "2026-10-29T12:00:00Z",
    });
    const $ = load(html);
    expect($('dl[aria-label="Award information dates"]')).toHaveLength(1);
    expect($("dt").map((_index, element) => $(element).text()).get()).toEqual(["Details checked", "Last reported change"]);
    expect($('dd[data-field="details"] time').attr("datetime")).toBe("2026-10-29T12:00:00.000Z");
    expect($('dd[data-field="details"]').text()).toBe("October 29, 2026");
    expect($('dd[data-field="updates"]').text()).toBe("No changes reported");
    expect($('dd[data-field="updates"] time')).toHaveLength(0);
    expect(html).not.toMatch(/September 1|Sophomore|Junior|citizen|data-field="(?:level|citizenship)"/);
    expect(html).not.toMatch(/source pages|<button|<a\s|tabindex|role="button"/);
  });

  it("shows an older reported change alongside a newer details check with distinct accessible provenance", () => {
    const $ = load(render({ academicLevels: [], citizenship: [], changeCount: 1,
      latestUpdateAt: "2026-09-08T03:00:00Z", detailsCheckedAt: "2026-10-29T12:00:00Z" }));
    for (const [key, label, date, dateTime] of [
      ["details", "Details checked", "October 29, 2026", "2026-10-29T12:00:00.000Z"],
      ["updates", "Last reported change", "September 7, 2026", "2026-09-08T03:00:00.000Z"],
    ]) {
      const field = $(`dd[data-field="${key}"]`);
      expect(field.siblings("dt").text()).toBe(label);
      expect(field.text()).toBe(date);
      expect(field.attr("title")).toMatch(new RegExp(`^${label}:`));
      expect(field.find("time").attr("datetime")).toBe(dateTime);
      expect(field.find("time").attr("aria-label")).toBe(field.attr("title"));
    }
  });

  it.each([null, NaN, -1, 0.5])("keeps unknown/invalid change count %s unavailable even when details are verified", (changeCount) => {
    const $ = load(render({ academicLevels: [], citizenship: [], changeCount, detailsCheckedAt: "2026-10-29T12:00:00Z" }));
    expect($('dd[data-field="updates"]').text()).toBe("Not available");
    expect($('dd[data-field="updates"] time')).toHaveLength(0);
    expect($('dd[data-field="details"] time')).toHaveLength(1);
  });

  it.each([0, 1, null])("does not substitute collection or change dates for missing details verification (count %s)", (changeCount) => {
    const $ = load(render({ academicLevels: [], citizenship: [], changeCount,
      latestUpdateAt: "2026-09-08T03:00:00Z", firstPublishedCaptureAt: "2026-07-01T12:00:00Z" }));
    expect($('dd[data-field="details"]').text()).toBe("Not available");
    expect($('dd[data-field="details"] time')).toHaveLength(0);
  });
});
