import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { AwardDateValue } from "@/components/award-date-value";

describe("AwardDateValue", () => {
  it("keeps timezone typography with the value, not the directory label", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.award-row-deadline > span\s*\{/);
    expect(css).not.toMatch(/\.award-row-deadline\s+span\s*\{/);
    const zoneRule = css.match(/\.award-date-zone\s*\{([^}]*)\}/)?.[1];
    expect(zoneRule?.trim()).toBe("white-space: nowrap;");
  });

  it.each([
    ["March 27, 2026 at 5:00 p.m. (UTC-05:00)", "(UTC-05:00)"],
    ["Notification: March 27, 2026 at 5:00 p.m. (UTC+05:30)", "(UTC+05:30)"],
    ["March 27, 2026 at 5:00 p.m. (UTC): Interviews at 9:00 a.m.", "(UTC)"],
    [" \tMarch 27, 2026 at 5:00 p.m. (UTC-05:00)\n ", null],
    ["Notification:  March 27, 2026 at 5:00 p.m. (UTC)", null],
    ["March 27, 2026 at 5:00 p.m. (UTC-05:00) (tentative)", null],
    ["March 27, 2026 at 5:00 p.m. (applicant's time zone)", null],
    ["Application outcome: <confirm> & ask the office", null],
  ])("preserves copied and accessible text exactly: %s", (value, zone) => {
    const html = renderToStaticMarkup(createElement("div", { id: "value" }, createElement(AwardDateValue, { value })));
    const $ = load(html);
    const element = $("#value");
    expect(element.text()).toBe(value);
    expect(element.find(".award-date-zone")).toHaveLength(zone ? 1 : 0);
    if (zone) expect(element.find(".award-date-zone").text()).toBe(zone);
    expect(element.find("[aria-hidden], [aria-label], [role]")).toHaveLength(0);
  });
});
