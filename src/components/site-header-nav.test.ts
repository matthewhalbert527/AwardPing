import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import postcss, { type AtRule, type Rule } from "postcss";
import { describe, expect, it, vi } from "vitest";
import { SiteHeaderNav } from "./site-header-nav";

const route = vi.hoisted(() => ({ pathname: "/" as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));

// Real Next Link and React SSR: these checks cover markup, not mounted
// navigation, browser geometry, or mobile-menu interaction.
describe("public site header navigation", () => {
  it.each([
    { pathname: "/", active: null },
    { pathname: null, active: null },
    { pathname: "/updates", active: "/updates" },
    { pathname: "/updates/example", active: "/updates" },
    { pathname: "/award-directory", active: "/award-directory" },
    { pathname: "/award-directory/example", active: "/award-directory" },
    { pathname: "/updates-archive", active: null },
    { pathname: "/award-directory-old", active: null },
  ])("keeps the same two anchors and icons at $pathname", ({ pathname, active }) => {
    route.pathname = pathname;
    const $ = load(renderToStaticMarkup(createElement(SiteHeaderNav)));
    const nav = $('nav[aria-label="Primary navigation"]');
    expect(nav).toHaveLength(1);
    expect(nav.attr("class")).toBe("dashboard-nav site-header-nav");
    expect($("a")).toHaveLength(2);

    const expected = [
      { href: "/updates", label: "Updates", section: "updates", icon: "lucide-inbox" },
      { href: "/award-directory", label: "Award Directory", section: "database", icon: "lucide-search-check" },
    ];
    nav.children("a").each((index, node) => {
      const link = $(node);
      const item = expected[index];
      expect(link.attr("href")).toBe(item.href);
      expect(link.text()).toBe(item.label);
      expect(link.attr("role")).toBeUndefined();
      expect(link.attr("style")).toBeUndefined();
      expect(link.attr("aria-current")).toBe(active === item.href ? "page" : undefined);
      expect(link.attr("class")?.trim().split(/\s+/)).toEqual([
        "dashboard-nav-link", `dashboard-nav-link-${item.section}`,
        ...(active === item.href ? ["dashboard-nav-link-active"] : []),
      ]);
      const icon = link.children("svg");
      expect(icon).toHaveLength(1);
      expect(icon.hasClass(item.icon)).toBe(true);
      expect(icon.attr("width")).toBe("16");
      expect(icon.attr("height")).toBe("16");
      expect(icon.attr("aria-hidden")).toBe("true");
    });
    expect(nav.children("a")).toHaveLength(2);
    expect(nav.find('[aria-current="page"]')).toHaveLength(active ? 1 : 0);
    expect($("#site-header-menu")).toHaveLength(0);
    const toggle = $('button[aria-controls="site-header-menu"]');
    expect(toggle).toHaveLength(1);
    expect(toggle.attr("type")).toBe("button");
    expect(toggle.attr("aria-expanded")).toBe("false");
    expect(toggle.attr("aria-label")).toBe("Open navigation menu");
  });
});

const css = postcss.parse(readFileSync(new URL("../app/globals.css", import.meta.url), "utf8"));

function topLevelRule(selector: string): Rule {
  const rules = css.nodes.filter((node): node is Rule => node.type === "rule" && node.selector === selector);
  expect(rules, `one unconditional public-nav rule for ${selector}`).toHaveLength(1);
  return rules[0];
}

function declarations(rule: Rule) {
  return Object.fromEntries(rule.nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value]));
}

describe("public header navigation geometry CSS", () => {
  it("protects the public pill inset from the later generic dashboard padding reset", () => {
    expect(declarations(topLevelRule(".dashboard-nav.site-header-nav"))).toMatchObject({ padding: "0.25rem" });
  });

  it("keeps both public links intrinsic-width and rounded at every viewport", () => {
    expect(declarations(topLevelRule(".site-header-nav .dashboard-nav-link"))).toMatchObject({
      width: "auto", flex: "0 0 auto", "border-radius": "999px",
    });
  });

  it("uses the same explicit base font weight for selected and unselected links", () => {
    expect(declarations(topLevelRule(".site-header-nav a"))["font-weight"]).toBe("550");
  });

  it("limits selected public-link changes to paint rather than geometry or typography", () => {
    const activeRules: Rule[] = [];
    css.walkRules((rule) => {
      if (rule.selectors.includes('.site-header-nav a[aria-current="page"]')) activeRules.push(rule);
    });
    expect(activeRules).toHaveLength(1);
    expect(activeRules[0].parent).toBe(css);
    expect(declarations(activeRules[0])).toEqual({
      background: "var(--surface-sunken)", color: "var(--text)",
    });
  });
});

const NAV_SELECTOR = ".site-header-nav";
const MENU_BUTTON_SELECTOR = ".site-header-menu-button";

describe("compact public header actions", () => {
  it("keeps short action labels on one line", () => {
    const rules: Rule[] = [];
    css.walkRules((rule) => {
      if (rule.parent === css && rule.selectors.includes(".app-header-actions .button-secondary")) rules.push(rule);
    });
    expect(rules).toHaveLength(1);
    expect(declarations(rules[0])["white-space"]).toBe("nowrap");
  });

  it("removes the extra nested horizontal padding on phones", () => {
    const rules: Rule[] = [];
    css.walkAtRules("media", (query) => {
      if (query.params !== "(max-width: 760px)") return;
      query.walkRules(".app-header-shell", (rule) => { rules.push(rule); });
    });
    expect(rules).toHaveLength(1);
    expect(declarations(rules[0])["padding-inline"]).toBe("0");
  });
});

/** The single width bound of a plain media query, or a failure if it is not one. */
function widthQueryBounds(params: string) {
  const conditions = params.split(",").map((part) => part.trim());
  expect(conditions, `one media condition for ${params}`).toHaveLength(1);
  const match = /^\((min|max)-width:\s*(\d+)px\)$/.exec(conditions[0]);
  expect(match, `only a plain width query may gate the header nav: ${params}`).not.toBeNull();
  return { kind: match![1] as "min" | "max", px: Number(match![2]) };
}

/**
 * The `display` the cascade settles on at one viewport width. Both selectors
 * are single classes, so equal specificity makes source order decisive, which
 * is what a plain last-write-wins walk reproduces.
 */
function displayAt(selector: string, width: number) {
  let display = "none";
  css.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    const parent = rule.parent;
    if (parent?.type === "atrule") {
      const query = parent as AtRule;
      expect(query.name, "header nav rules belong to media queries only").toBe("media");
      const bounds = widthQueryBounds(query.params);
      if (bounds.kind === "min" && width < bounds.px) return;
      if (bounds.kind === "max" && width > bounds.px) return;
    }
    const value = declarations(rule).display;
    if (value) display = value;
  });
  return display;
}

// A visitor needs one way to reach the other pages at every width. The pill
// and the compact menu button are declared in separate blocks, so nothing but
// their breakpoints keeps them from both vanishing, which is what happened
// between 760px and 960px.
describe("public header navigation affordance across viewports", () => {
  it.each([320, 390, 759, 760, 960, 961, 1024, 1440])(
    "shows exactly one navigation affordance at %ipx",
    (width) => {
      expect({
        width,
        pill: displayAt(NAV_SELECTOR, width) !== "none",
        menuButton: displayAt(MENU_BUTTON_SELECTOR, width) !== "none",
      }).toEqual({ width, pill: width > 960, menuButton: width <= 960 });
    },
  );

  it("hands off at one shared compact bound, so the two rules cannot drift apart", () => {
    const compactBounds: number[] = [];
    css.walkAtRules("media", (query) => {
      query.walkRules((rule) => {
        if (!rule.selectors.includes(NAV_SELECTOR) && !rule.selectors.includes(MENU_BUTTON_SELECTOR)) return;
        const bounds = widthQueryBounds(query.params);
        if (bounds.kind === "max") compactBounds.push(bounds.px);
      });
    });
    // One bound hides the pill, one reveals the button; both must be the same.
    expect(compactBounds.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(compactBounds)]).toEqual([960]);
  });
});
