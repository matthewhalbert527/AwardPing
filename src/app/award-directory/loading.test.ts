import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import AwardDirectoryLoading from "./loading";

describe("award directory loading frame", () => {
  it("keeps the compact directory title and announces loading without invented counts or dates", () => {
    const html = renderToStaticMarkup(createElement(AwardDirectoryLoading));
    const $ = load(html);

    expect($("main").attr("aria-busy")).toBe("true");
    expect($("h1")).toHaveLength(1);
    expect($("h1").text()).toBe("Award directory");
    expect($("[role='status']")).toHaveLength(1);
    expect($("[role='status']").text()).toBe("Loading awards…");
    expect($(".award-directory-loading-grid").attr("aria-hidden")).toBe("true");
    expect($(".award-directory-loading-grid").text()).toBe("");
    expect(html).not.toContain("Every monitored award, in one place");
    expect(html).not.toContain("0 awards");
    expect(html).not.toContain("Last update");
    expect($(".award-row-summary, #award-letter-page-status, select, time")).toHaveLength(0);
  });
});
