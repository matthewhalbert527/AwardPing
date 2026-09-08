import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AwardDiscoveryWorkspace, type SharedAwardCard } from "./award-discovery-workspace";

// Exercise the real event handler and rerender with its state changes. This
// hook harness is not a DOM/browser test; focus is a synchronous test double.
const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  focus: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!(index in state.values)) state.values[index] = initial;
      return [state.values[index], (value: unknown) => {
        state.values[index] = typeof value === "function" ? value(state.values[index]) : value;
      }];
    },
    useMemo: (calculate: () => unknown) => calculate(),
    useRef: () => ({ current: { focus: state.focus } }),
  };
});
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children),
}));

const award: SharedAwardCard = {
  id: "fictional-award", name: "Fictional Award", slug: null,
  publicPath: "/fictional-award", officialHomepage: null, summary: null,
  deadline: null, academicLevels: ["Undergraduate"], disciplines: ["STEM"],
  citizenship: ["U.S. citizens"], lastCheckedAt: null, recentlyUpdated: false,
  sourceCount: null, sourceIssueCount: null, changeCount: 0, tracked: false,
  sources: [], changes: [],
};
const defaults = ["", false, "A", 30, 0, "all", "all", "all", "all", "all"];

type ElementProps = {
  children?: ReactNode; onClick?: () => void; onFocus?: () => void; id?: string;
  className?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onBlur?: (event: { relatedTarget: object | null; currentTarget: { contains: (target: object) => boolean } }) => void;
};
function elements(node: ReactNode): Array<React.ReactElement<ElementProps>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function render(rows = [award]) {
  state.cursor = 0;
  const tree = AwardDiscoveryWorkspace({ sharedAwards: rows, canManage: false, isAuthenticated: false });
  return { tree, html: renderToStaticMarkup(tree) };
}
function resetButton(tree: ReactNode) {
  const button = elements(tree).find((element) =>
    element.type === "button" && element.props.children === "Reset filters",
  );
  expect(button, "one-click filter recovery must be available").toBeDefined();
  return button!;
}
function expectAutomaticBrowse(html: string) {
  const $ = load(html);
  expect($('section[aria-label="Browse all awards"]')).toHaveLength(1);
  expect($('.award-alpha-letter')).toHaveLength(26);
  expect($('.award-alpha-letter-active').text()).toBe("F");
  expect($('.award-row-summary').map((_index, link) => $(link).attr("href")).get()).toEqual(["/fictional-award"]);
  expect($('.award-search-panel')).toHaveLength(0);
  const buttonNames = $("button").map((_index, button) => $(button).text().trim()).get();
  expect(buttonNames).not.toContain("Hide browse");
  expect(buttonNames).not.toContain("Browse all");
  expect(buttonNames).not.toContain("Browse all awards");
}

beforeEach(() => {
  state.values = [...defaults];
  state.cursor = 0;
  state.focus.mockReset();
});

describe("award directory filter recovery", () => {
  it("explains a filtered empty result without a phantom letter or useless pagination", () => {
    state.values[5] = "Graduate";
    const { tree, html } = render();
    expect(html).toContain("No awards match these filters.");
    expect(html).toContain("Reset the filters to browse the full directory.");
    expect(html).not.toContain("under #");
    expect(html).not.toContain("Alphabetical award pages");
    expect(html).not.toContain("Awards per page");
    resetButton(tree);
  });

  it("offers reset for each of the five dropdown filters independently", () => {
    for (const [index, value] of [[5, "Undergraduate"], [6, "STEM"], [7, "U.S. citizens"], [8, "missing"], [9, "recent"]] as const) {
      state.values = [...defaults];
      state.values[index] = value;
      resetButton(render().tree);
    }
  });

  it("resets all dropdowns and pagination, preserves the query, and restores its matching award", () => {
    state.values = ["Fictional", true, "F", 100, 3, "Graduate", "Arts", "Other", "listed", "recent"];
    const { tree, html } = render();
    expect(html).toContain("No matches");
    const input = elements(tree).find((element) => element.props.id === "award-directory-search")!;
    state.focus.mockImplementation(() => {
      // Focus happens before reset, and invokes the real input handler.
      expect(state.values[5]).toBe("Graduate");
      input.props.onFocus!();
    });
    resetButton(tree).props.onClick!();
    expect(state.focus).toHaveBeenCalledOnce();
    expect(state.values).toEqual(["Fictional", true, "F", 100, 0, "all", "all", "all", "all", "all"]);
    const recovered = render().html;
    expect(recovered).toContain("1 matching award");
    expect(recovered).toContain('href="/fictional-award"');
    expect(recovered).not.toContain("Reset filters");
  });

  it("restores browse results for a blank query without changing the page-size preference", () => {
    state.values = ["", false, "F", 50, 2, "Graduate", "all", "all", "all", "all"];
    resetButton(render().tree).props.onClick!();
    expect(state.values).toEqual(["", false, "F", 50, 0, "all", "all", "all", "all", "all"]);
    const { html } = render();
    expect(html).toContain("Showing 1-1 of 1 awards under F.");
    expect(html).toContain('href="/fictional-award"');
    expect(html).not.toContain("No awards match");
  });

  it("does not show a reset action when no dropdown filters are active", () => {
    expect(render().html).not.toContain("Reset filters");
    state.values[0] = "Unmatched search";
    state.values[1] = true;
    expect(render().html).not.toContain("Reset filters");
  });

  it("does not blame filters for an empty unfiltered catalog", () => {
    const { html } = render([]);
    expect(html).toContain("No awards are listed here right now.");
    expect(html).not.toContain("No awards match these filters");
    expect(html).not.toContain("Reset filters");
    expect(html).not.toContain("under #");
  });

  it.each(["Fictional", "Unmatched search"])("Clear restores automatic browsing from open search %s, retaining filters and page size", (query) => {
    state.values = [query, true, "F", 50, 0, "Undergraduate", "STEM", "U.S. citizens", "missing", "all"];
    const first = render();
    const $ = load(first.html);
    expect($(".award-search-panel")).toHaveLength(1);
    expect($(".award-search-option")).toHaveLength(query === "Fictional" ? 1 : 0);
    expect($('section[aria-label="Browse all awards"]')).toHaveLength(0);
    const input = elements(first.tree).find(element => element.props.id === "award-directory-search")!;
    const clear = elements(first.tree).find(element => element.type === "button" && element.props.className === "award-search-clear");
    expect(clear?.props.onClick).toBeDefined();
    state.focus.mockImplementation(() => {
      expect(state.values[0]).toBe(query);
      input.props.onFocus!();
    });

    clear!.props.onClick!();

    expect(state.focus).toHaveBeenCalledOnce();
    expect(state.values).toEqual(["", false, "F", 50, 0, "Undergraduate", "STEM", "U.S. citizens", "missing", "all"]);
    expectAutomaticBrowse(render().html);
  });

  it.each(["outside focus", "no related target"])("keeps contained search focus open, then restores automatic browsing on %s without clearing the query", (kind) => {
    state.values = ["", false, "F", 50, 0, "Undergraduate", "STEM", "U.S. citizens", "missing", "all"];
    const first = render();
    expectAutomaticBrowse(first.html);
    const input = elements(first.tree).find(element => element.props.id === "award-directory-search")!;
    input.props.onChange!({ target: { value: "Fictional" } });
    const open = render();
    const $ = load(open.html);
    expect($(".award-search-option")).toHaveLength(1);
    expect($('section[aria-label="Browse all awards"]')).toHaveLength(0);
    const blurOwners = elements(open.tree).filter(element => typeof element.props.onBlur === "function");
    expect(blurOwners).toHaveLength(1);
    const containedTarget = {};
    const contains = vi.fn((target: object) => target === containedTarget);
    const onBlur = blurOwners[0].props.onBlur!;

    onBlur({ relatedTarget: containedTarget, currentTarget: { contains } });
    expect(state.values[1]).toBe(true);
    expect(load(render().html)(".award-search-option")).toHaveLength(1);
    onBlur({ relatedTarget: kind === "outside focus" ? {} : null, currentTarget: { contains } });

    expect(state.values).toEqual(["Fictional", false, "F", 50, 0, "Undergraduate", "STEM", "U.S. citizens", "missing", "all"]);
    expectAutomaticBrowse(render().html);
    expect(state.focus).not.toHaveBeenCalled();
  });

  it("restores automatic browsing when the input change handler receives an empty search", () => {
    state.values = ["Fictional", true, "F", 30, 0, "all", "all", "all", "all", "all"];
    const first = render();
    expect(load(first.html)(".award-search-option")).toHaveLength(1);
    const input = elements(first.tree).find(element => element.props.id === "award-directory-search")!;

    input.props.onChange!({ target: { value: "" } });

    expect(state.values).toEqual(["", false, "F", 30, 0, "all", "all", "all", "all", "all"]);
    expectAutomaticBrowse(render().html);
    expect(state.focus).not.toHaveBeenCalled();
  });
});
