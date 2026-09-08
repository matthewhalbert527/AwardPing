import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AwardDiscoveryWorkspace, type SharedAwardCard } from "./award-discovery-workspace";

// This exercises the actual handlers and rerenders their state transitions.
// It is not a mounted React or browser test: ref focus/scroll methods are
// synchronous test doubles, and native disabled/keyboard behavior is not run.
const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  refCursor: 0,
  refs: [] as Array<{ current: { focus: ReturnType<typeof vi.fn>; scrollIntoView: ReturnType<typeof vi.fn> } }>,
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
    useRef: () => {
      const index = state.refCursor++;
      state.refs[index] ??= { current: { focus: vi.fn(), scrollIntoView: vi.fn() } };
      return state.refs[index];
    },
  };
});
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children),
}));

const defaults = ["", false, true, "A", 30, 0, "all", "all", "all", "all", "all"];
function award(letter: string, index = 1, overrides: Partial<SharedAwardCard> = {}): SharedAwardCard {
  const number = String(index).padStart(3, "0");
  return {
    id: `fictional-${letter}-${number}`, name: `${letter} Fictional Award ${number}`, slug: null,
    publicPath: `/fictional-${letter.toLowerCase()}-${number}`, officialHomepage: null, summary: null,
    deadline: "October 1, 2026", academicLevels: ["Undergraduate"], disciplines: ["STEM"],
    citizenship: ["U.S. citizens"], lastCheckedAt: null, recentlyUpdated: true,
    sourceCount: null, sourceIssueCount: null, changeCount: 1, tracked: false,
    latestUpdateAt: null, firstPublishedCaptureAt: null, sources: [], changes: [], ...overrides,
  };
}
function many(letter: string, count: number) {
  return Array.from({ length: count }, (_, index) => award(letter, index + 1));
}
type ElementProps = {
  children?: ReactNode; onClick?: () => void; disabled?: boolean; title?: string;
  "aria-label"?: string; "aria-pressed"?: boolean; tabIndex?: number;
  ref?: { current: { focus: ReturnType<typeof vi.fn>; scrollIntoView: ReturnType<typeof vi.fn> } };
};
function elements(node: ReactNode): Array<React.ReactElement<ElementProps>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<ElementProps>(node) ? text(node.props.children) : "";
}
function render(rows: SharedAwardCard[]) {
  state.cursor = 0;
  state.refCursor = 0;
  const tree = AwardDiscoveryWorkspace({ sharedAwards: rows, canManage: false, isAuthenticated: false });
  const html = renderToStaticMarkup(tree);
  return { tree, html, $: load(html) };
}
function nextLetterButton(tree: ReactNode) {
  const buttons = elements(tree).filter(element => element.type === "button" && /^Next letter(?:: [A-Z])?$/.test(text(element.props.children)));
  expect(buttons, "exactly one footer letter-navigation button").toHaveLength(1);
  return buttons[0];
}
function previousLetterButton(tree: ReactNode) {
  const buttons = elements(tree).filter(element => element.type === "button" && /^Previous letter(?:: [A-Z])?$/.test(text(element.props.children)));
  expect(buttons, "exactly one footer previous-letter button").toHaveLength(1);
  return buttons[0];
}
function pageButton(tree: ReactNode, label: "Next" | "Previous") {
  return elements(tree).find(element => element.type === "button" && text(element.props.children) === label);
}
function hrefs(html: string) {
  const $ = load(html);
  return $(".award-row-summary").map((_index, row) => $(row).attr("href")).get();
}
function activeLetter(html: string) {
  return load(html)(".award-alpha-letter-active").text();
}
beforeEach(() => {
  state.values = [...defaults];
  state.cursor = 0;
  state.refCursor = 0;
  state.refs = [];
});

describe("award directory footer letter navigation", () => {
  it("advances from B to F, skipping empty letters, and requests focus then scroll on the stable top alphabet", () => {
    const rows = [award("B"), award("F"), award("Z")];
    const { tree, html } = render(rows);
    expect(activeLetter(html)).toBe("B");
    const button = nextLetterButton(tree);
    expect(text(button.props.children)).toBe("Next letter: F");
    expect(button.props.disabled).toBe(false);
    const group = elements(tree).find(element => element.props["aria-label"] === "Alphabetical award pages")!;
    expect(group.props.tabIndex).toBe(-1);
    expect(group.props.ref).toBeDefined();
    const destination = group.props.ref!.current;

    button.props.onClick!();

    expect(state.values[3]).toBe("F");
    expect(destination.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(destination.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "instant" });
    expect(destination.focus.mock.invocationCallOrder[0]).toBeLessThan(destination.scrollIntoView.mock.invocationCallOrder[0]);
    const next = render(rows);
    expect(activeLetter(next.html)).toBe("F");
    expect(next.$('[aria-label="Alphabetical award pages"]').attr("aria-describedby")).toBe("award-letter-page-status");
    expect(next.$('#award-letter-page-status[role="status"]').text()).toBe("Showing 1-1 of 1 awards under F.");
    expect(hrefs(next.html)).toEqual([rows[1].publicPath]);
    expect(text(nextLetterButton(next.tree).props.children)).toBe("Next letter: Z");
    expect(elements(next.tree).find(element => element.props["aria-label"] === "Alphabetical award pages")?.props.ref).toBe(group.props.ref);
  });

  it.each([
    { filter: "level", slot: 6, value: "Undergraduate", excluded: { academicLevels: ["Graduate"] } },
    { filter: "discipline", slot: 7, value: "STEM", excluded: { disciplines: ["Arts"] } },
    { filter: "citizenship", slot: 8, value: "U.S. citizens", excluded: { citizenship: ["Other"] } },
    { filter: "deadline", slot: 9, value: "listed", excluded: { deadline: null } },
    { filter: "recorded updates", slot: 10, value: "recent", excluded: { recentlyUpdated: false, changeCount: 0 } },
  ])("skips a populated C letter excluded by the $filter filter", ({ slot, value, excluded }) => {
    const rows = [award("B"), award("C", 1, excluded), award("F")];
    state.values[slot] = value;
    const first = render(rows);
    expect(first.html).toContain("2 of 3 monitored awards match.");
    expect(first.$('.award-alpha-letter').filter((_index, node) => first.$(node).text() === "C").is(":disabled")).toBe(true);
    const button = nextLetterButton(first.tree);
    expect(text(button.props.children)).toBe("Next letter: F");
    button.props.onClick!();
    expect(state.values[slot]).toBe(value);
    expect(hrefs(render(rows).html)).toEqual([rows[2].publicPath]);
  });

  it("derives the next letter from the active fallback, not a stale unavailable selected letter", () => {
    state.values[3] = "Z";
    const { tree, html } = render([award("B"), award("F")]);
    expect(activeLetter(html)).toBe("B");
    expect(text(nextLetterButton(tree).props.children)).toBe("Next letter: F");
  });

  it("resets page two to page one of the next letter while preserving query, page size, and all five filters", () => {
    const rows = [...many("B", 31), ...many("F", 31)];
    state.values = ["Fictional", false, true, "B", 30, 1, "Undergraduate", "STEM", "U.S. citizens", "listed", "recent"];
    const first = render(rows);
    expect(hrefs(first.html)).toEqual(["/fictional-b-031"]);
    nextLetterButton(first.tree).props.onClick!();
    expect(state.values).toEqual(["Fictional", false, true, "F", 30, 0, "Undergraduate", "STEM", "U.S. citizens", "listed", "recent"]);
    const second = render(rows);
    expect(hrefs(second.html)).toEqual(many("F", 30).map(row => row.publicPath));
    expect(second.html).toContain("Showing 1-30 of 31 awards under F.");
    expect(pageButton(second.tree, "Previous")?.props.disabled).toBe(true);
    expect(pageButton(second.tree, "Next")?.props.disabled).toBe(false);
  });

  it("closes the search-open flag when advancing with a blank query", () => {
    // A blank query leaves browse visible even when the input's onFocus has
    // set searchOpen. This reaches the real footer without a hidden control.
    state.values[1] = true;
    const rows = [award("B"), award("F")];
    nextLetterButton(render(rows).tree).props.onClick!();
    expect(state.values[0]).toBe("");
    expect(state.values[1]).toBe(false);
    expect(activeLetter(render(rows).html)).toBe("F");
  });

  it("keeps the final Next letter button disabled and does not wrap or move focus", () => {
    const rows = [award("B"), award("F")];
    state.values[3] = "F";
    const { tree } = render(rows);
    const button = nextLetterButton(tree);
    expect(text(button.props.children)).toBe("Next letter");
    expect(button.props.disabled).toBe(true);
    const before = [...state.values];
    // Call the closure directly to verify its guard as well as disabled markup.
    button.props.onClick!();
    expect(state.values).toEqual(before);
    expect(state.refs.every(ref => ref.current.focus.mock.calls.length === 0 && ref.current.scrollIntoView.mock.calls.length === 0)).toBe(true);
  });

  it("retains within-letter pagination for many awards and keeps it separate from letter navigation", () => {
    const rows = [...many("B", 31), award("F")];
    const first = render(rows);
    expect(pageButton(first.tree, "Previous")?.props.disabled).toBe(true);
    const nextPage = pageButton(first.tree, "Next");
    expect(nextPage).toBeDefined();
    expect(nextPage!.props.disabled).toBe(false);
    nextPage!.props.onClick!();
    const second = render(rows);
    expect(activeLetter(second.html)).toBe("B");
    expect(hrefs(second.html)).toEqual(["/fictional-b-031"]);
    expect(pageButton(second.tree, "Previous")?.props.disabled).toBe(false);
    expect(pageButton(second.tree, "Next")?.props.disabled).toBe(true);
    expect(text(nextLetterButton(second.tree).props.children)).toBe("Next letter: F");
    pageButton(second.tree, "Previous")!.props.onClick!();
    expect(hrefs(render(rows).html)).toEqual(many("B", 30).map(row => row.publicPath));
  });

  it("hides useless Previous/Next page buttons for one page while retaining page-size and letter controls", () => {
    const { tree, html } = render([award("B"), award("F")]);
    expect(pageButton(tree, "Previous")).toBeUndefined();
    expect(pageButton(tree, "Next")).toBeUndefined();
    expect(html).toContain("Awards per page");
    expect(text(nextLetterButton(tree).props.children)).toBe("Next letter: F");
  });

  it.each(["unfiltered", "filtered"])("renders no letter or pagination controls for an empty %s result", (kind) => {
    if (kind === "filtered") state.values[6] = "Graduate";
    const { tree, html } = render(kind === "filtered" ? [award("B")] : []);
    expect(html).not.toContain("Alphabetical award pages");
    expect(html).not.toContain("Awards per page");
    expect(html).not.toContain("Next letter");
    expect(html).not.toContain("under #");
    expect(pageButton(tree, "Previous")).toBeUndefined();
    expect(pageButton(tree, "Next")).toBeUndefined();
  });
});

describe("award directory footer previous-letter navigation", () => {
  it("returns from F to B, skipping empty letters, and focuses then scrolls the stable top alphabet", () => {
    const rows = [award("B"), award("F"), award("Z")];
    state.values[3] = "F";
    const first = render(rows);
    expect(activeLetter(first.html)).toBe("F");
    const button = previousLetterButton(first.tree);
    expect(text(button.props.children)).toBe("Previous letter: B");
    expect(button.props.disabled).toBe(false);
    expect(button.props.title).toBeUndefined();
    const group = elements(first.tree).find(element => element.props["aria-label"] === "Alphabetical award pages")!;
    expect(group.props.tabIndex).toBe(-1);
    expect(group.props.ref).toBeDefined();
    const destination = group.props.ref!.current;

    button.props.onClick!();

    expect(state.values[3]).toBe("B");
    expect(destination.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(destination.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "instant" });
    expect(destination.focus.mock.invocationCallOrder[0]).toBeLessThan(destination.scrollIntoView.mock.invocationCallOrder[0]);
    const second = render(rows);
    expect(activeLetter(second.html)).toBe("B");
    expect(hrefs(second.html)).toEqual([rows[0].publicPath]);
    expect(second.$('#award-letter-page-status[role="status"]').text()).toBe("Showing 1-1 of 1 awards under B.");
    expect(elements(second.tree).find(element => element.props["aria-label"] === "Alphabetical award pages")?.props.ref).toBe(group.props.ref);
    expect(previousLetterButton(second.tree).props.disabled).toBe(true);
    expect(text(nextLetterButton(second.tree).props.children)).toBe("Next letter: F");
  });

  it("chooses the nearest previous available letter rather than the first letter in the catalog", () => {
    const rows = [award("B"), award("F"), award("Z")];
    state.values[3] = "Z";
    const button = previousLetterButton(render(rows).tree);
    expect(text(button.props.children)).toBe("Previous letter: F");
    button.props.onClick!();
    expect(activeLetter(render(rows).html)).toBe("F");
    expect(hrefs(render(rows).html)).toEqual([rows[1].publicPath]);
  });

  it.each([
    { filter: "level", slot: 6, value: "Undergraduate", excluded: { academicLevels: ["Graduate"] } },
    { filter: "discipline", slot: 7, value: "STEM", excluded: { disciplines: ["Arts"] } },
    { filter: "citizenship", slot: 8, value: "U.S. citizens", excluded: { citizenship: ["Other"] } },
    { filter: "deadline", slot: 9, value: "listed", excluded: { deadline: null } },
    { filter: "recorded updates", slot: 10, value: "recent", excluded: { recentlyUpdated: false, changeCount: 0 } },
  ])("skips a preceding populated C letter excluded by the $filter filter", ({ slot, value, excluded }) => {
    const rows = [award("B"), award("C", 1, excluded), award("F")];
    state.values[3] = "F";
    state.values[slot] = value;
    const first = render(rows);
    expect(first.html).toContain("2 of 3 monitored awards match.");
    expect(first.$('.award-alpha-letter').filter((_index, node) => first.$(node).text() === "C").is(":disabled")).toBe(true);
    const button = previousLetterButton(first.tree);
    expect(text(button.props.children)).toBe("Previous letter: B");
    button.props.onClick!();
    expect(state.values[slot]).toBe(value);
    expect(hrefs(render(rows).html)).toEqual([rows[0].publicPath]);
  });

  it("derives the previous boundary from the active fallback rather than a stale unavailable selected letter", () => {
    state.values[3] = "Z";
    const first = render([award("B"), award("F")]);
    expect(activeLetter(first.html)).toBe("B");
    const button = previousLetterButton(first.tree);
    expect(text(button.props.children)).toBe("Previous letter");
    expect(button.props.disabled).toBe(true);
    expect(button.props.title).toBe("You are at the first available letter.");
  });

  it("resets page two to page one of the previous letter while preserving query, page size, and all five filters", () => {
    const rows = [...many("B", 31), ...many("F", 31)];
    state.values = ["Fictional", false, true, "F", 30, 1, "Undergraduate", "STEM", "U.S. citizens", "listed", "recent"];
    const first = render(rows);
    expect(hrefs(first.html)).toEqual(["/fictional-f-031"]);
    previousLetterButton(first.tree).props.onClick!();
    expect(state.values).toEqual(["Fictional", false, true, "B", 30, 0, "Undergraduate", "STEM", "U.S. citizens", "listed", "recent"]);
    const second = render(rows);
    expect(hrefs(second.html)).toEqual(many("B", 30).map(row => row.publicPath));
    expect(second.html).toContain("Showing 1-30 of 31 awards under B.");
    expect(pageButton(second.tree, "Previous")?.props.disabled).toBe(true);
    expect(pageButton(second.tree, "Next")?.props.disabled).toBe(false);
  });

  it("closes the search-open flag when returning with a blank query", () => {
    // As with Next, a focused blank search leaves the real browse footer visible.
    state.values[1] = true;
    state.values[3] = "F";
    const rows = [award("B"), award("F")];
    previousLetterButton(render(rows).tree).props.onClick!();
    expect(state.values[0]).toBe("");
    expect(state.values[1]).toBe(false);
    expect(activeLetter(render(rows).html)).toBe("B");
  });

  it.each(["unfiltered", "filtered"])("disables the first available Previous letter with a tooltip and no wrap or focus movement (%s)", (kind) => {
    const rows = [award("B", 1, { academicLevels: ["Graduate"] }), award("F"), award("Z")];
    if (kind === "filtered") state.values[6] = "Undergraduate";
    const first = render(rows);
    expect(activeLetter(first.html)).toBe(kind === "filtered" ? "F" : "B");
    const button = previousLetterButton(first.tree);
    expect(text(button.props.children)).toBe("Previous letter");
    expect(button.props.disabled).toBe(true);
    expect(button.props.title).toBe("You are at the first available letter.");
    const before = [...state.values];
    // The native disabled state and the closure guard are separate contracts.
    button.props.onClick!();
    expect(state.values).toEqual(before);
    expect(state.refs.every(ref => ref.current.focus.mock.calls.length === 0 && ref.current.scrollIntoView.mock.calls.length === 0)).toBe(true);
  });

  it.each(["unfiltered", "filtered"])("renders neither footer letter button for an empty %s result", (kind) => {
    if (kind === "filtered") state.values[6] = "Graduate";
    const { tree, html } = render(kind === "filtered" ? [award("B")] : []);
    expect(html).not.toContain("Previous letter");
    expect(html).not.toContain("Next letter");
    expect(elements(tree).filter(element => element.type === "button" && /^(Previous|Next) letter(?:: [A-Z])?$/.test(text(element.props.children)))).toHaveLength(0);
  });
});
