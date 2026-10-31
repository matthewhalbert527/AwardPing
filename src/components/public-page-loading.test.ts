import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it, vi } from "vitest";
import Loading from "@/app/loading";
import AwardLoading from "@/app/[slug]/loading";
import UpdatesLoading from "@/app/updates/loading";

vi.mock("@/lib/auth", () => ({ getCurrentUser() { throw Error("Loading UI must not query a session."); } }));
vi.mock("@/lib/stage1-publication", () => ({ loadStage1PublicationIndex() { throw Error("Loading UI must not query publication."); } }));

describe("immediate public loading shells", () => {
  it.each([
    [Loading, "AwardPing", "Loading…"],
    [AwardLoading, "Award details", "Loading award details…"],
    [UpdatesLoading, "Award updates", "Loading updates…"],
  ] as const)("renders a bounded, neutral loading frame for %s", (Component, title, status) => {
    const html = renderToStaticMarkup(createElement(Component));
    const $ = load(html);
    expect($("main")).toHaveLength(1);
    expect($("main").attr("aria-busy")).toBe("true");
    expect($("h1").text()).toBe(title);
    expect($("[role='status']").text()).toBe(status);
    expect($(".award-directory-loading-grid").attr("aria-hidden")).toBe("true");
    expect($(".award-directory-loading-grid").text()).toBe("");
    expect($("button, input, select, time, iframe, object")).toHaveLength(0);
    expect(html).not.toMatch(/No changes|No awards|Deadline|Last reported|Details checked|Log in|Profile|0 awards|under verification/i);
  });
});
