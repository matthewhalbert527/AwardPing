import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it, vi } from "vitest";
import { DashboardNav } from "./dashboard-nav";

const route = vi.hoisted(() => ({ pathname: null as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));

describe("dashboard navigation", () => {
  it.each([
    ["/updates", "/updates"],
    ["/updates/subscribe", "/updates"],
    ["/award-directory", "/award-directory"],
    ["/award-directory/example", "/award-directory"],
    ["/dashboard/office", null],
    ["/dashboard/onboarding", null],
    ["/dashboard/admin/issues", null],
    ["/dashboard/ops", null],
    ["/updates-archive", null],
    ["/award-directory-old", null],
    [null, null],
  ])("only marks the actual destination current at %s", (pathname, active) => {
    route.pathname = pathname;
    const $ = load(renderToStaticMarkup(createElement(DashboardNav)));
    const links = $('nav[aria-label="Dashboard navigation"] a');
    expect(links.map((_, el) => $(el).text()).get()).toEqual(["Updates", "Award Directory"]);
    expect(links.map((_, el) => $(el).attr("href")).get()).toEqual(["/updates", "/award-directory"]);
    expect(links.filter('[aria-current="page"]')).toHaveLength(active ? 1 : 0);
    expect(links.filter(".dashboard-nav-link-active")).toHaveLength(active ? 1 : 0);
    if (active) expect(links.filter('[aria-current="page"]').attr("href")).toBe(active);
    expect(links.find('svg[aria-hidden="true"]')).toHaveLength(2);
  });

  it("does not flash a false current Updates state while navigation loads", () => {
    const layout = readFileSync(new URL("../app/dashboard/layout.tsx", import.meta.url), "utf8");
    const fallback = layout.slice(layout.indexOf("function DashboardNavFallback"));
    expect(fallback).toContain('href="/updates"');
    expect(fallback).toContain('href="/award-directory"');
    expect(fallback).not.toContain("dashboard-nav-link-active");
  });
});
