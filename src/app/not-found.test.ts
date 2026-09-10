import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("@/components/site-footer", () => ({ SiteFooter: () => null }));

import NotFound from "@/app/not-found";

describe("public not-found page", () => {
  it("uses the shared compact shell and direct award/update recovery paths", () => {
    const $ = load(renderToStaticMarkup(NotFound()));
    expect($("main.public-page-main.public-page-main-narrow")).toHaveLength(1);
    expect($("h1")).toHaveLength(1);
    expect($(".public-page-heading h1").text()).toBe("Page not found");
    expect($('main a[href="/award-directory"]').text()).toBe("Browse awards");
    expect($('main a[href="/updates"]').text()).toBe("View updates");
    expect($("main").text()).not.toContain("Under verification");
    expect($("main form, main .display-title")).toHaveLength(0);
  });
});
