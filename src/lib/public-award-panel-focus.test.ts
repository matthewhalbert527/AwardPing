import { describe, expect, it } from "vitest";
import {
  PUBLIC_AWARD_COMPACT_LAYOUT_QUERY,
  PUBLIC_AWARD_PANEL_HEADING_ID,
  PUBLIC_AWARD_PANEL_ID,
  PUBLIC_AWARD_REDUCED_MOTION_QUERY,
  activatePanelSelection,
  readPanelRevealEnvironment,
  revealSelectedPanel,
  revealAwardTargetWithoutFocus,
  shouldRevealPanel,
  type PanelActivationState,
} from "@/lib/public-award-panel-focus";

function fakeTarget() {
  const calls: Array<{ method: "focus" | "scrollIntoView"; options: unknown }> = [];
  return {
    calls,
    target: {
      focus: (options?: { preventScroll?: boolean }) => {
        calls.push({ method: "focus", options });
      },
      scrollIntoView: (options?: { behavior?: "auto" | "smooth"; block?: "start" }) => {
        calls.push({ method: "scrollIntoView", options });
      },
    },
  };
}

describe("revealAwardTargetWithoutFocus", () => {
  it.each([false, true])("reveals an offscreen ninth update without focus stealing (reduced motion: %s)", (reducedMotion) => {
    const calls: unknown[] = [];
    const target = {
      getBoundingClientRect: () => ({ top: 2600, height: 400 }),
      focus: () => { throw new Error("Selected update scrolling must not move focus"); },
    };
    expect(revealAwardTargetWithoutFocus(target, { viewportHeight: 900, topInset: 96, reducedMotion }, (options) => calls.push(options))).toBe(true);
    expect(calls).toEqual([{ top: 2504, behavior: reducedMotion ? "auto" : "smooth" }]);
  });

  it("leaves an already-visible update or long card's visible start untouched", () => {
    for (const height of [60, 2000]) {
      const target = { getBoundingClientRect: () => ({ top: 100, height }) };
      expect(revealAwardTargetWithoutFocus(target, { viewportHeight: 900, topInset: 96, reducedMotion: false }, () => { throw new Error("Must not scroll"); })).toBe(false);
    }
  });

  it("clears the sticky header when an anchor's heading is above the visible content", () => {
    const calls: unknown[] = [];
    const target = { getBoundingClientRect: () => ({ top: 40, height: 600 }) };
    expect(revealAwardTargetWithoutFocus(target, { viewportHeight: 844, topInset: 96, reducedMotion: true }, (options) => calls.push(options))).toBe(true);
    expect(calls).toEqual([{ top: -56, behavior: "auto" }]);
  });

  it("does nothing for a missing, hidden or invalid target", () => {
    for (const target of [null, undefined, { getBoundingClientRect: () => ({ top: 1000, height: 0 }) }, { getBoundingClientRect: () => ({ top: NaN, height: 200 }) }]) {
      expect(revealAwardTargetWithoutFocus(target, { viewportHeight: 844, topInset: 96, reducedMotion: false }, () => { throw new Error("Must not scroll"); })).toBe(false);
    }
  });
});

describe("revealSelectedPanel", () => {
  it("focuses the panel and scrolls it into view smoothly on the one-column layout", () => {
    const { calls, target } = fakeTarget();

    const outcome = revealSelectedPanel(target, { compactLayout: true, reducedMotion: false });

    expect(outcome).toEqual({ focused: true, scrolled: true, behavior: "smooth" });
    expect(calls).toEqual([
      { method: "focus", options: { preventScroll: true } },
      { method: "scrollIntoView", options: { block: "start", behavior: "smooth" } },
    ]);
  });

  it("scrolls without animation when the visitor prefers reduced motion", () => {
    const { calls, target } = fakeTarget();

    const outcome = revealSelectedPanel(target, { compactLayout: true, reducedMotion: true });

    expect(outcome).toEqual({ focused: true, scrolled: true, behavior: "auto" });
    expect(calls[1]).toEqual({ method: "scrollIntoView", options: { block: "start", behavior: "auto" } });
  });

  it("leaves focus on the outline button on wide layouts: no focus move and no scroll", () => {
    for (const reducedMotion of [false, true]) {
      const { calls, target } = fakeTarget();

      const outcome = revealSelectedPanel(target, { compactLayout: false, reducedMotion });

      expect(outcome, `reducedMotion=${reducedMotion}`).toEqual({ focused: false, scrolled: false });
      expect(calls, `reducedMotion=${reducedMotion}`).toEqual([]);
    }
  });

  it("focuses before it scrolls on the one-column layout", () => {
    const { calls, target } = fakeTarget();

    revealSelectedPanel(target, { compactLayout: true, reducedMotion: false });

    expect(calls.map((call) => call.method)).toEqual(["focus", "scrollIntoView"]);
  });

  it("restores focus after a source-list or back control unmounts on desktop", () => {
    for (const reducedMotion of [false, true]) {
      const { calls, target } = fakeTarget();
      revealSelectedPanel(target, { compactLayout: false, reducedMotion }, "panel");
      expect(calls).toEqual([
        { method: "focus", options: { preventScroll: true } },
        { method: "scrollIntoView", options: { block: "start", behavior: reducedMotion ? "auto" : "smooth" } },
      ]);
    }
  });

  it("does nothing without a mounted panel", () => {
    expect(revealSelectedPanel(null, { compactLayout: true, reducedMotion: false })).toEqual({
      focused: false,
      scrolled: false,
    });
    expect(revealSelectedPanel(undefined, { compactLayout: false, reducedMotion: false })).toEqual({
      focused: false,
      scrolled: false,
    });
  });
});

type TestPanel = { kind: "overview" } | { kind: "changes" } | { kind: "source"; sourceId: string };

describe("activatePanelSelection", () => {
  const known = (panel: TestPanel) => panel.kind !== "source" || panel.sourceId === "source-apply";

  it("advances the reveal sequence on consecutive activations of the same panel", () => {
    const initial: PanelActivationState<TestPanel> = { selected: { kind: "overview" }, revealSequence: 0 };

    const first = activatePanelSelection(initial, { kind: "changes" }, known);
    const second = activatePanelSelection(first, { kind: "changes" }, known);

    expect(first).toEqual({ selected: { kind: "changes" }, revealSequence: 1 });
    expect(second).toEqual({ selected: { kind: "changes" }, revealSequence: 2 });
    expect(shouldRevealPanel(initial.revealSequence)).toBe(false);
    expect([first, second].map((state) => shouldRevealPanel(state.revealSequence))).toEqual([true, true]);

    // Re-activating the panel that is already selected advances too.
    const again = activatePanelSelection(initial, { kind: "overview" }, known);
    expect(again).toEqual({ selected: { kind: "overview" }, revealSequence: 1 });
    expect(activatePanelSelection(again, { kind: "overview" }, known)).toEqual({
      selected: { kind: "overview" },
      revealSequence: 2,
    });
  });

  it("switches panels and keeps counting across them", () => {
    let state: PanelActivationState<TestPanel> = { selected: { kind: "overview" }, revealSequence: 0 };
    const steps: TestPanel[] = [{ kind: "source", sourceId: "source-apply" }, { kind: "changes" }, { kind: "overview" }];

    for (const [index, next] of steps.entries()) {
      state = activatePanelSelection(state, next, known);
      expect(state).toEqual({ selected: next, revealSequence: index + 1 });
    }
  });

  it("ignores an unknown source without advancing or changing the selection", () => {
    const state: PanelActivationState<TestPanel> = { selected: { kind: "changes" }, revealSequence: 3 };

    expect(activatePanelSelection(state, { kind: "source", sourceId: "source-gone" }, known)).toBe(state);
    expect(activatePanelSelection(state, { kind: "source", sourceId: "source-apply" }, known)).toEqual({
      selected: { kind: "source", sourceId: "source-apply" },
      revealSequence: 4,
    });
  });
});

describe("readPanelRevealEnvironment", () => {
  it("reads the compact-layout and reduced-motion media queries", () => {
    const asked: string[] = [];
    const matchMedia = (query: string) => {
      asked.push(query);
      return { matches: query === PUBLIC_AWARD_COMPACT_LAYOUT_QUERY };
    };

    expect(readPanelRevealEnvironment(matchMedia)).toEqual({ compactLayout: true, reducedMotion: false });
    expect(asked).toEqual([PUBLIC_AWARD_COMPACT_LAYOUT_QUERY, PUBLIC_AWARD_REDUCED_MOTION_QUERY]);
    expect(
      readPanelRevealEnvironment((query) => ({ matches: query === PUBLIC_AWARD_REDUCED_MOTION_QUERY })),
    ).toEqual({ compactLayout: false, reducedMotion: true });
  });

  it("stays conservative without media queries, as on the server", () => {
    expect(readPanelRevealEnvironment(undefined)).toEqual({ compactLayout: false, reducedMotion: true });
    expect(typeof window).toBe("undefined");
    expect(readPanelRevealEnvironment()).toEqual({ compactLayout: false, reducedMotion: true });
  });

  it("uses the stylesheet breakpoint and stable ids", () => {
    expect(PUBLIC_AWARD_COMPACT_LAYOUT_QUERY).toBe("(max-width: 720px)");
    expect(PUBLIC_AWARD_PANEL_ID).toBe("public-award-panel");
    expect(PUBLIC_AWARD_PANEL_HEADING_ID).toBe("public-award-panel-heading");
  });
});
