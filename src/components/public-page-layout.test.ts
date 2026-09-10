import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";
import { SiteFooter } from "./site-footer";
import { getSeoPage } from "../lib/seo-pages";

const css = postcss.parse(readFileSync(new URL("../app/globals.css", import.meta.url), "utf8"));

function declarationsFor(selector: string) {
  const rules = css.nodes.filter((node): node is Rule => node.type === "rule" && node.selector === selector);
  expect(rules, `one unconditional rule for ${selector}`).toHaveLength(1);
  return Object.fromEntries(rules[0].nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value]));
}

// CSS contract tests complement, rather than replace, real 320px browser QA.
describe("shared public page layout", () => {
  it("describes the checker as a text-readability check, not a monitoring enrollment", () => {
    const page = getSeoPage("award-page-change-checker");
    expect(page?.h1).toBe("Check an award page");
    expect(page?.intro).toBe("Paste a page URL to check whether AwardPing can read its text.");
    expect(page?.description).toBe(page?.intro);
  });
  it("fills the available flex-column width without a min-content overflow", () => {
    expect(declarationsFor(".public-page-main")).toMatchObject({
      width: "100%",
      "min-width": "0",
      "max-width": "72rem",
      margin: "0 auto",
      "overflow-wrap": "anywhere",
    });
  });

  it("retains a readable width limit for narrow pages", () => {
    expect(declarationsFor(".public-page-main-narrow")).toMatchObject({ "max-width": "48rem" });
  });

  it("keeps compact 32px headings and allows long words to wrap", () => {
    expect(declarationsFor(".public-page-heading h1")).toMatchObject({
      "font-size": "2rem",
      "line-height": "1.2",
      "overflow-wrap": "anywhere",
    });
  });

  it("lets primary actions wrap and keeps their 44px touch targets", () => {
    expect(declarationsFor(".public-page-actions")).toMatchObject({ display: "flex", "flex-wrap": "wrap" });
    expect(declarationsFor(".public-page-actions > a")).toMatchObject({ "min-height": "44px" });
  });
});

describe("concise public footer", () => {
  it("provides exactly the six useful destinations in one labelled navigation", () => {
    const $ = load(renderToStaticMarkup(createElement(SiteFooter)));
    expect($("footer.site-footer")).toHaveLength(1);
    expect($("footer p").text()).toBe("AwardPing");
    const navigation = $('footer nav[aria-label="Footer navigation"]');
    expect(navigation).toHaveLength(1);
    expect(navigation.find("a").map((_, node) => ({ href: $(node).attr("href"), label: $(node).text() })).get()).toEqual([
      { href: "/updates", label: "Live updates" },
      { href: "/award-directory", label: "Find awards" },
      { href: "/award-page-change-checker", label: "Award page checker" },
      { href: "/contact", label: "Contact" },
      { href: "/security", label: "Security" },
      { href: "/privacy", label: "Privacy" },
    ]);
    expect($("footer a")).toHaveLength(6);
    expect($("footer h1, footer h2, footer h3, footer button, footer form")).toHaveLength(0);
  });

  it("wraps footer links instead of forcing a desktop-width row on phones", () => {
    expect(declarationsFor(".site-footer-shell")).toMatchObject({
      display: "flex", "flex-wrap": "wrap", "max-width": "72rem",
    });
    expect(declarationsFor(".site-footer-links")).toMatchObject({ display: "flex", "flex-wrap": "wrap" });
  });

  it("keeps footer destinations easy to tap", () => {
    expect(declarationsFor(".site-footer-links a")).toMatchObject({
      display: "inline-flex", "align-items": "center", "min-height": "44px",
    });
  });
});
