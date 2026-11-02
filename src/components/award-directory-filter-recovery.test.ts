import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AwardDiscoveryWorkspace, type SharedAwardCard } from "./award-discovery-workspace";
import { AwardFilterDropdown } from "./award-filter-dropdown";

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
const NOW_MS = Date.parse("2026-09-08T18:00:00.000Z");
const defaults = ["", false, "A", 30, 0, [], [], [], "all", 0];

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
function chooseFilter(tree: ReactNode, label: string, value: string | string[]) {
  const dropdown = elements(tree).find(element => element.type === AwardFilterDropdown &&
    (element.props as { label?: string }).label === label);
  if (dropdown) {
    // Exercise the actual controlled value callback. Native checkbox, popover
    // and focus behavior belongs to the separate browser verification.
    const props = dropdown.props as unknown as { onChange: (values: string[]) => void };
    expect(props.onChange).toBeTypeOf("function");
    props.onChange(Array.isArray(value) ? value : [value]);
    return;
  }
  const labels = elements(tree).filter(element => element.type === "label" &&
    elements(element.props.children).some(child => child.type === "span" && child.props.children === label));
  expect(labels).toHaveLength(1);
  const select = elements(labels[0]).find(element => element.type === "select");
  expect(select?.props.onChange).toBeTypeOf("function");
  if (typeof value !== "string") throw new Error("Updates keeps a single time window");
  select!.props.onChange!({ target: { value } });
}
function recoveryActionNames(html: string) {
  const $ = load(html);
  return $("button").filter((_index, button) =>
    $(button).hasClass("award-search-clear") || $(button).text().trim() === "Reset filters",
  ).map((_index, button) => $(button).text().trim()).get();
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
function expectAllFilterDefaults(html: string) {
  const $ = load(html);
  expect($(".award-directory-filter-grid .award-filter-label").map((_index, label) => $(label).text()).get()).toEqual([
    "Academic level", "Discipline", "Citizenship", "Updates",
  ]);
  const triggers = $(".award-directory-filter-grid .award-filter-control > button[popovertarget]");
  expect(triggers).toHaveLength(3);
  triggers.each((_index, trigger) => expect($(trigger).text().trim()).toBe("All"));
  expect($(".award-directory-filter-grid input[type='checkbox'][checked]")).toHaveLength(0);
  const selects = $(".award-directory-filter-grid select");
  expect(selects).toHaveLength(1);
  selects.each((_index, node) => {
    const select = $(node);
    expect(select.attr("class")).toBe("input");
    const selected = select.children("option[selected]");
    expect(selected).toHaveLength(1);
    expect(selected.get(0)).toBe(select.children("option").get(0));
    expect(selected.attr("value")).toBe("all");
    expect(selected.text()).toBe("All");
  });
}

beforeEach(() => {
  vi.setSystemTime(NOW_MS);
  state.values = [...defaults];
  state.cursor = 0;
  state.focus.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("award directory filter recovery", () => {
  it("explains a known search match excluded by active filters and retains the existing recovery controls", () => {
    const rows = [award, {
      ...award, id: "other-award", name: "Other Award", publicPath: "/other-award", academicLevels: ["Graduate"],
    }];
    state.values[0] = "Fictional";
    state.values[1] = true;
    const unfiltered = load(render(rows).html);
    expect(unfiltered(".award-search-option").attr("href")).toBe("/fictional-award");

    state.values[5] = ["Graduate"];
    const $ = load(render(rows).html);
    expect($(".award-search-empty").text()).toBe("No awards match this search with these filters.");
    expect($("#award-directory-search").attr("value")).toBe("Fictional");
    expect($("#award-filter-level").text().trim()).toBe("Graduate");
    expect($(".award-search-option")).toHaveLength(0);
    expect($(".award-search-panel [role='status']").text()).toBe("No matches");
    expect(recoveryActionNames($.html())).toEqual(["Clear", "Reset filters"]);
  });

  it.each([
    { catalog: "populated", rows: [award] },
    { catalog: "empty", rows: [] },
  ])("describes a query-only miss in a $catalog catalog without blaming filters", ({ rows }) => {
    state.values[0] = "Unmatched search";
    state.values[1] = true;
    const $ = load(render(rows).html);
    expect($(".award-search-empty").text()).toBe("No awards match this search.");
    expect($("#award-directory-search").attr("value")).toBe("Unmatched search");
    expect($(".award-search-option")).toHaveLength(0);
    expect($(".award-search-panel [role='status']").text()).toBe("No matches");
    expect(recoveryActionNames($.html())).toEqual(["Clear"]);
  });

  it("explains a filtered empty result without a phantom letter or useless pagination", () => {
    state.values[5] = ["Graduate"];
    const { tree, html } = render();
    expect(html).toContain("No awards match these filters.");
    expect(html).toContain("Reset the filters to browse the full directory.");
    expect(html).not.toContain("under #");
    expect(html).not.toContain("Alphabetical award pages");
    expect(html).not.toContain("Awards per page");
    resetButton(tree);
  });

  it("offers reset for each of the four dropdown filters independently", () => {
    for (const [index, value] of [[5, "Undergraduate"], [6, "STEM"], [7, "U.S. citizens"], [8, "week"]] as const) {
      state.values = [...defaults];
      state.values[index] = index < 8 ? [value] : value;
      if (index === 8) state.values[9] = NOW_MS;
      resetButton(render().tree);
    }
  });

  it.each([
    { label: "Academic level", slot: 5, value: "Undergraduate", excluded: { academicLevels: ["Graduate"] } },
    { label: "Discipline", slot: 6, value: "STEM", excluded: { disciplines: ["Arts"] } },
    { label: "Citizenship", slot: 7, value: "U.S. citizens", excluded: { citizenship: ["Other"] } },
    { label: "Updates", slot: 8, value: "week", excluded: { latestUpdateAt: "2026-08-25T18:00:00.000Z", recentlyUpdated: true } },
  ])("keeps $label filtering functional and resets all four controls to All", ({ label, slot, value, excluded }) => {
    const matching = { ...award, deadline: "October 1, 2026", recentlyUpdated: false, changeCount: 1, latestUpdateAt: "2026-09-07T18:00:00.000Z" };
    const other = { ...matching, id: "fictional-other", name: "Fictional Other", publicPath: "/fictional-other", ...excluded };
    const rows = [matching, other];
    const before = structuredClone(rows);
    state.values[3] = 50;
    state.values[4] = 2;
    const first = render(rows);
    expectAllFilterDefaults(first.html);
    expect(first.html).toContain("2 awards");
    chooseFilter(first.tree, label, value);

    expect(state.values[slot]).toEqual(slot < 8 ? [value] : value);
    expect(state.values[9]).toBe(slot === 8 ? NOW_MS : 0);
    expect(state.values[4]).toBe(0);
    const filtered = render(rows);
    const $ = load(filtered.html);
    expect(filtered.html).toContain("1 of 2 awards");
    expect($(".award-row-summary").map((_index, link) => $(link).attr("href")).get()).toEqual([matching.publicPath]);
    if (slot < 8) expect($(".award-directory-filter-grid input[type='checkbox'][checked]").attr("value")).toBe(value);
    else expect($(".award-directory-filter-grid select").children("option[selected]").attr("value")).toBe(value);
    const input = elements(filtered.tree).find(element => element.props.id === "award-directory-search")!;
    state.focus.mockImplementation(() => input.props.onFocus!());

    resetButton(filtered.tree).props.onClick!();

    expect(state.focus).toHaveBeenCalledOnce();
    expect(state.values.slice(0, 10)).toEqual(["", false, "A", 50, 0, [], [], [], "all", slot === 8 ? NOW_MS : 0]);
    const reset = render(rows);
    expectAllFilterDefaults(reset.html);
    expect(reset.html).toContain("2 awards");
    const resetHtml = load(reset.html);
    expect(resetHtml(".award-row-summary").map((_index, link) => resetHtml(link).attr("href")).get()).toEqual([matching.publicPath, other.publicPath]);
    expect(reset.html).not.toContain("Reset filters");
    expect(rows).toEqual(before);
  });

  it("resets all dropdowns and pagination, preserves the query, and restores its matching award", () => {
    state.values = ["Fictional", true, "F", 100, 3, ["Graduate"], ["Arts"], ["Other"], "week", NOW_MS];
    const { tree, html } = render();
    expect(html).toContain("No matches");
    const input = elements(tree).find((element) => element.props.id === "award-directory-search")!;
    state.focus.mockImplementation(() => {
      // Focus happens before reset, and invokes the real input handler.
      expect(state.values[5]).toEqual(["Graduate"]);
      input.props.onFocus!();
    });
    resetButton(tree).props.onClick!();
    expect(state.focus).toHaveBeenCalledOnce();
    expect(state.values.slice(0, 10)).toEqual(["Fictional", true, "F", 100, 0, [], [], [], "all", NOW_MS]);
    const recovered = render().html;
    expect(recovered).toContain("1 matching award");
    expect(recovered).toContain('href="/fictional-award"');
    expect(recovered).not.toContain("Reset filters");
  });

  it("intersects reviewed categories through real filter handlers and resets without losing the query or page-size preference", () => {
    const rows = [
      { ...award, academicLevels: ["Junior"], disciplines: ["Engineering"], citizenship: ["US citizen"] },
      { ...award, id: "graduate", name: "Fictional Graduate", publicPath: "/fictional-graduate", academicLevels: ["Postgraduate"] },
      { ...award, id: "arts", name: "Fictional Arts", publicPath: "/fictional-arts", disciplines: ["Humanities"] },
      { ...award, id: "conditional", name: "Fictional Country Criteria", publicPath: "/fictional-country-criteria", citizenship: ["United States"] },
    ];
    const before = structuredClone(rows);
    state.values = ["Fictional", false, "F", 50, 2, [], [], [], "all", 0];
    for (const [label, value, count] of [["Academic level", "Undergraduate", 3], ["Discipline", "STEM", 2], ["Citizenship", "U.S. citizens", 1]] as const) {
      const current = render(rows);
      chooseFilter(current.tree, label, value);
      const filtered = render(rows);
      expect(filtered.html).toContain(`${count} of 4 awards`);
      expect(state.values[4]).toBe(0);
    }
    const filtered = render(rows);
    const $ = load(filtered.html);
    expect($(".award-row-summary").map((_index, link) => $(link).attr("href")).get()).toEqual([award.publicPath]);
    expect(state.values.slice(0, 10)).toEqual(["Fictional", false, "F", 50, 0, ["Undergraduate"], ["STEM"], ["U.S. citizens"], "all", 0]);
    const input = elements(filtered.tree).find(element => element.props.id === "award-directory-search")!;
    state.focus.mockImplementation(() => input.props.onFocus!());
    resetButton(filtered.tree).props.onClick!();
    expect(state.focus).toHaveBeenCalledOnce();
    expect(state.values.slice(0, 10)).toEqual(["Fictional", true, "F", 50, 0, [], [], [], "all", 0]);
    const reset = render(rows);
    expectAllFilterDefaults(reset.html);
    expect(reset.html).toContain("4 matching awards");
    expect(load(reset.html)(".award-search-option")).toHaveLength(4);
    expect(rows).toEqual(before);
  });

  it("retains several values from the real dropdown callback until reset, preserving the search", () => {
    const rows = [award, { ...award, id: "graduate", name: "Fictional Graduate", publicPath: "/fictional-graduate", academicLevels: ["Graduate"] }];
    state.values[0] = "Fictional";
    const first = render(rows);
    chooseFilter(first.tree, "Academic level", ["Undergraduate", "Graduate"]);
    const selected = render(rows);
    expect(state.values[5]).toEqual(["Undergraduate", "Graduate"]);
    expect(selected.html).toContain("2 of 2 awards");
    expect(load(selected.html)(".award-directory-filter-grid input[type='checkbox'][checked]")).toHaveLength(2);
    const input = elements(selected.tree).find(element => element.props.id === "award-directory-search")!;
    state.focus.mockImplementation(() => input.props.onFocus!());
    resetButton(selected.tree).props.onClick!();
    expect(state.values.slice(0, 10)).toEqual(["Fictional", true, "A", 30, 0, [], [], [], "all", 0]);
    const recovered = render(rows);
    expect(recovered.html).toContain("2 matching awards");
    expectAllFilterDefaults(recovered.html);
  });

  it("captures the selection-time clock for age ranges, retains it across renders, and resets without losing search or navigation state", () => {
    const rows = [0.5, 10, 200].map((age, index) => ({
      ...award, id: `age-${index}`, name: `Fictional Age ${index}`, publicPath: `/fictional-age-${index}`,
      changeCount: 1, recentlyUpdated: false, latestUpdateAt: new Date(NOW_MS - age * 86_400_000).toISOString(),
    }));
    const before = structuredClone(rows);
    state.values = ["Fictional", false, "F", 50, 2, [], [], [], "all", 0];
    const choose = (value: string) => {
      const current = render(rows);
      const labels = elements(current.tree).filter(element => element.type === "label" &&
        elements(element.props.children).some(child => child.type === "span" && child.props.children === "Updates"));
      expect(labels).toHaveLength(1);
      elements(labels[0]).find(element => element.type === "select")!.props.onChange!({ target: { value } });
    };
    choose("day");
    expect(state.values.slice(0, 10)).toEqual(["Fictional", false, "F", 50, 0, [], [], [], "day", NOW_MS]);
    expect(render(rows).html).toContain("1 of 3 awards");
    vi.setSystemTime(NOW_MS + 86_400_000);
    // A rerender alone does not move the chosen window's captured clock.
    expect(render(rows).html).toContain("1 of 3 awards");
    expect(state.values[9]).toBe(NOW_MS);
    choose("month");
    expect(state.values[9]).toBe(NOW_MS + 86_400_000);
    expect(render(rows).html).toContain("2 of 3 awards");
    choose("year");
    const filtered = render(rows);
    expect(filtered.html).toContain("3 of 3 awards");
    const input = elements(filtered.tree).find(element => element.props.id === "award-directory-search")!;
    state.focus.mockImplementation(() => input.props.onFocus!());
    resetButton(filtered.tree).props.onClick!();
    expect(state.values.slice(0, 10)).toEqual(["Fictional", true, "F", 50, 0, [], [], [], "all", NOW_MS + 86_400_000]);
    expectAllFilterDefaults(render(rows).html);
    expect(render(rows).html).toContain("3 matching awards");
    expect(rows).toEqual(before);
  });

  it("restores browse results for a blank query without changing the page-size preference", () => {
    state.values = ["", false, "F", 50, 2, ["Graduate"], [], [], "all", 0];
    resetButton(render().tree).props.onClick!();
    expect(state.values.slice(0, 10)).toEqual(["", false, "F", 50, 0, [], [], [], "all", 0]);
    const { html } = render();
    expect(html).toContain("F · 1 award");
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
    state.values = [query, true, "F", 50, 0, ["Undergraduate"], ["STEM"], ["U.S. citizens"], "all", 0];
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
    expect(state.values.slice(0, 10)).toEqual(["", false, "F", 50, 0, ["Undergraduate"], ["STEM"], ["U.S. citizens"], "all", 0]);
    expectAutomaticBrowse(render().html);
  });

  it.each(["outside focus", "no related target"])("keeps contained search focus open, then restores automatic browsing on %s without clearing the query", (kind) => {
    state.values = ["", false, "F", 50, 0, ["Undergraduate"], ["STEM"], ["U.S. citizens"], "all", 0];
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

    expect(state.values.slice(0, 10)).toEqual(["Fictional", false, "F", 50, 0, ["Undergraduate"], ["STEM"], ["U.S. citizens"], "all", 0]);
    expectAutomaticBrowse(render().html);
    expect(state.focus).not.toHaveBeenCalled();
  });

  it("restores automatic browsing when the input change handler receives an empty search", () => {
    state.values = ["Fictional", true, "F", 30, 0, [], [], [], "all", 0];
    const first = render();
    expect(load(first.html)(".award-search-option")).toHaveLength(1);
    const input = elements(first.tree).find(element => element.props.id === "award-directory-search")!;

    input.props.onChange!({ target: { value: "" } });

    expect(state.values.slice(0, 10)).toEqual(["", false, "F", 30, 0, [], [], [], "all", 0]);
    expectAutomaticBrowse(render().html);
    expect(state.focus).not.toHaveBeenCalled();
  });
});
