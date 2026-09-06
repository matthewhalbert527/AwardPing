// Focus handoff for the public award workspace's selected panel. The panel is
// one stable, focusable region. On the one-column layout, where the panel
// sits below the outline, a visitor's activation moves focus there and
// scrolls it into view; on wide layouts the panel is already beside the
// outline, so focus stays on the button. Nothing here runs on the initial
// render.

export const PUBLIC_AWARD_PANEL_ID = "public-award-panel";
export const PUBLIC_AWARD_PANEL_HEADING_ID = "public-award-panel-heading";
/** The one-column layout breakpoint; keep in step with the stylesheet. */
export const PUBLIC_AWARD_COMPACT_LAYOUT_QUERY = "(max-width: 720px)";
export const PUBLIC_AWARD_REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export type PanelRevealTarget = {
  focus: (options?: { preventScroll?: boolean }) => void;
  scrollIntoView: (options?: { behavior?: "auto" | "smooth"; block?: "start" }) => void;
};

export type PanelRevealEnvironment = {
  compactLayout: boolean;
  reducedMotion: boolean;
};

export type PanelRevealOutcome =
  | { focused: false; scrolled: false }
  | { focused: true; scrolled: true; behavior: "auto" | "smooth" };

type MediaMatcher = (query: string) => { matches: boolean };

export type PanelActivationState<Panel> = {
  selected: Panel;
  /** Visitor activations so far; zero until the first. */
  revealSequence: number;
};

// The pure activation transition the workspace applies to its state: a known
// panel becomes the selection and the sequence advances, also when the panel
// already shown is activated again, so the reveal effect re-runs each time;
// an unknown panel leaves the state untouched. Zero means no activation
// yet, so the initial render and deep links never reveal.
export function activatePanelSelection<Panel>(
  state: PanelActivationState<Panel>,
  next: Panel,
  isKnownPanel: (panel: Panel) => boolean,
): PanelActivationState<Panel> {
  if (!isKnownPanel(next)) return state;
  return { selected: next, revealSequence: state.revealSequence + 1 };
}

export function shouldRevealPanel(sequence: number) {
  return sequence > 0;
}

export function revealSelectedPanel(
  target: PanelRevealTarget | null | undefined,
  environment: PanelRevealEnvironment,
): PanelRevealOutcome {
  // Wide layouts keep focus on the outline button the visitor pressed.
  if (!target || !environment.compactLayout) return { focused: false, scrolled: false };
  // Focus without the browser's own scrolling, then scroll deliberately so
  // the panel's CSS scroll-margin keeps it clear of the sticky site header.
  target.focus({ preventScroll: true });
  const behavior = environment.reducedMotion ? "auto" : "smooth";
  target.scrollIntoView({ block: "start", behavior });
  return { focused: true, scrolled: true, behavior };
}

export function readPanelRevealEnvironment(
  matchMedia: MediaMatcher | undefined = defaultMediaMatcher(),
): PanelRevealEnvironment {
  // Without media queries (no window, or a browser without matchMedia) treat
  // the layout as wide, so the handoff does nothing.
  if (!matchMedia) return { compactLayout: false, reducedMotion: true };
  return {
    compactLayout: matchMedia(PUBLIC_AWARD_COMPACT_LAYOUT_QUERY).matches,
    reducedMotion: matchMedia(PUBLIC_AWARD_REDUCED_MOTION_QUERY).matches,
  };
}

function defaultMediaMatcher(): MediaMatcher | undefined {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
  return (query) => window.matchMedia(query);
}
