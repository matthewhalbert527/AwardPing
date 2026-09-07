import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
const defaults = ["", false, true, "A", 30, 0, "all", "all", "all", "all", "all"];

type ElementProps = { children?: ReactNode; onClick?: () => void; onFocus?: () => void; id?: string };
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

beforeEach(() => {
  state.values = [...defaults];
  state.cursor = 0;
  state.focus.mockReset();
});

describe("award directory filter recovery", () => {
  it("explains a filtered empty result without a phantom letter or useless pagination", () => {
    state.values[6] = "Graduate";
    const { tree, html } = render();
    expect(html).toContain("No awards match these filters.");
    expect(html).toContain("Reset the filters to browse the full directory.");
    expect(html).not.toContain("under #");
    expect(html).not.toContain("Alphabetical award pages");
    expect(html).not.toContain("Awards per page");
    resetButton(tree);
  });

  it("offers reset for each of the five dropdown filters independently", () => {
    for (const [index, value] of [[6, "Undergraduate"], [7, "STEM"], [8, "U.S. citizens"], [9, "missing"], [10, "recent"]] as const) {
      state.values = [...defaults];
      state.values[index] = value;
      resetButton(render().tree);
    }
  });

  it("resets all dropdowns and pagination, preserves the query, and restores its matching award", () => {
    state.values = ["Fictional", true, true, "F", 100, 3, "Graduate", "Arts", "Other", "listed", "recent"];
    const { tree, html } = render();
    expect(html).toContain("No matches");
    const input = elements(tree).find((element) => element.props.id === "award-directory-search")!;
    state.focus.mockImplementation(() => {
      // Focus happens before reset, and invokes the real input handler.
      expect(state.values[6]).toBe("Graduate");
      input.props.onFocus!();
    });
    resetButton(tree).props.onClick!();
    expect(state.focus).toHaveBeenCalledOnce();
    expect(state.values).toEqual(["Fictional", true, true, "F", 100, 0, "all", "all", "all", "all", "all"]);
    const recovered = render().html;
    expect(recovered).toContain("1 matching award");
    expect(recovered).toContain('href="/fictional-award"');
    expect(recovered).not.toContain("Reset filters");
  });

  it("restores browse results for a blank query without changing the page-size preference", () => {
    state.values = ["", false, true, "F", 50, 2, "Graduate", "all", "all", "all", "all"];
    resetButton(render().tree).props.onClick!();
    expect(state.values).toEqual(["", false, true, "F", 50, 0, "all", "all", "all", "all", "all"]);
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
});
