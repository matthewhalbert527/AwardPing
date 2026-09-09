import {
  isValidElement,
  type ComponentProps,
  type DependencyList,
  type Dispatch,
  type EffectCallback,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceSnapshotViewerButton } from "@/components/source-snapshot-viewer";

const hookBridge = vi.hoisted(() => ({ current: null as HookFrame | null }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => hookBridge.current
      ? hookBridge.current.state(initial) : actual.useState(initial),
    useMemo: <T,>(factory: () => T, deps: DependencyList) => hookBridge.current
      ? hookBridge.current.memo(factory, deps) : actual.useMemo(factory, deps),
    useCallback: <T extends (...args: never[]) => unknown>(callback: T, deps: DependencyList) => hookBridge.current
      ? hookBridge.current.memo(() => callback, deps) : actual.useCallback(callback, deps),
    useRef: <T,>(initial: T) => hookBridge.current
      ? hookBridge.current.ref(initial) : actual.useRef(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) => hookBridge.current
      ? hookBridge.current.effect(effect, deps) : actual.useEffect(effect, deps),
  };
});

type Props = ComponentProps<typeof SourceSnapshotViewerButton>;
type EffectSlot = { deps?: DependencyList; cleanup?: () => void; pending?: EffectCallback };
type ElementProps = {
  children?: ReactNode;
  className?: string;
  role?: string;
  ref?: RefObject<unknown>;
  onClick?: () => unknown;
  onMouseDown?: (event: { stopPropagation: () => void; preventDefault: () => void }) => void;
};

function sameDeps(left?: DependencyList, right?: DependencyList) {
  return Boolean(left && right && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index])));
}

// Drive only the public root and transparent keyed session boundaries. Nested
// snapshot bodies render through real React SSR, without replacing their code.
class HookFrame {
  private states: Array<{ value: unknown; set: Dispatch<SetStateAction<unknown>> }> = [];
  private memos: Array<{ deps: DependencyList; value: unknown }> = [];
  private refs: Array<RefObject<unknown>> = [];
  private effects: EffectSlot[] = [];
  private stateIndex = 0;
  private memoIndex = 0;
  private refIndex = 0;
  private effectIndex = 0;

  constructor(private readonly onWrite: () => void) {}

  state<T>(initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
    const index = this.stateIndex++;
    if (!this.states[index]) {
      this.states[index] = {
        value: typeof initial === "function" ? (initial as () => T)() : initial,
        set: (next) => {
          this.onWrite();
          this.states[index].value = typeof next === "function"
            ? (next as (value: unknown) => unknown)(this.states[index].value) : next;
        },
      };
    }
    return [this.states[index].value as T, this.states[index].set as Dispatch<SetStateAction<T>>];
  }

  memo<T>(factory: () => T, deps: DependencyList): T {
    const index = this.memoIndex++;
    if (!sameDeps(this.memos[index]?.deps, deps)) this.memos[index] = { deps, value: factory() };
    return this.memos[index].value as T;
  }

  ref<T>(initial: T): RefObject<T> {
    const index = this.refIndex++;
    if (!this.refs[index]) this.refs[index] = { current: initial };
    return this.refs[index] as RefObject<T>;
  }

  ownsRef(ref: RefObject<unknown>) { return this.refs.includes(ref); }

  effect(callback: EffectCallback, deps?: DependencyList) {
    const index = this.effectIndex++;
    if (!sameDeps(this.effects[index]?.deps, deps)) {
      this.effects[index] = { ...this.effects[index], deps, pending: callback };
    }
  }

  run(render: () => ReactNode) {
    this.stateIndex = this.memoIndex = this.refIndex = this.effectIndex = 0;
    hookBridge.current = this;
    try { return render(); } finally { hookBridge.current = null; }
  }

  commit() {
    for (const slot of this.effects) {
      if (!slot.pending) continue;
      slot.cleanup?.();
      const cleanup = slot.pending();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      slot.pending = undefined;
    }
  }

  cleanup() {
    for (const slot of this.effects) {
      slot.cleanup?.();
      slot.cleanup = undefined;
      slot.pending = undefined;
    }
  }
}

function elements(node: ReactNode): Array<ReactElement<ElementProps>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}

let documentDouble: { activeElement: FocusNode | null };
let keyListeners: Set<(event: TestKeyEvent) => void>;

class FocusNode {
  hidden = false;
  disabled = false;
  tabIndex = 0;
  isConnected = true;
  ariaHidden: string | null = null;
  focusables: FocusNode[] = [];
  focus = vi.fn(() => { documentDouble.activeElement = this; });
  getAttribute(name: string) { return name === "aria-hidden" ? this.ariaHidden : null; }
  contains(node: unknown) { return node === this || this.focusables.includes(node as FocusNode); }
  querySelectorAll() { return this.focusables.filter((node) => !node.disabled); }
}

type TestKeyEvent = { key: string; shiftKey: boolean; preventDefault: ReturnType<typeof vi.fn> };
function key(key: string, shiftKey = false) {
  const event: TestKeyEvent = { key, shiftKey, preventDefault: vi.fn() };
  for (const listener of [...keyListeners]) listener(event);
  return event;
}

class ModalHarness {
  private root = new HookFrame(() => { this.writes += 1; });
  private children: Array<{ type: unknown; key: string | null; frame: HookFrame }> = [];
  private hostRefs = new Map<RefObject<unknown>, FocusNode>();
  private tree: ReactNode = null;
  props: Props;
  writes = 0;

  constructor(props: Props = eventProps) { this.props = props; }

  render(props: Props = this.props) {
    this.props = props;
    let tree = this.root.run(() => SourceSnapshotViewerButton(props));
    let depth = 0;
    while (isValidElement<Record<string, unknown>>(tree) && typeof tree.type === "function") {
      const element = tree;
      let child = this.children[depth];
      if (!child || child.type !== element.type || child.key !== element.key) {
        if (child) { this.detachFrame(child.frame); child.frame.cleanup(); }
        child = { type: element.type, key: element.key, frame: new HookFrame(() => { this.writes += 1; }) };
        this.children[depth] = child;
      }
      const component = element.type as (props: Record<string, unknown>) => ReactNode;
      tree = child.frame.run(() => component(element.props));
      depth += 1;
    }
    for (const removed of this.children.splice(depth)) {
      this.detachFrame(removed.frame);
      removed.frame.cleanup();
    }
    this.tree = tree;
    const mountedRefs = new Set<RefObject<unknown>>();
    for (const element of elements(tree)) {
      if (typeof element.type !== "string" || !element.props.ref) continue;
      const ref = element.props.ref;
      let node = this.hostRefs.get(ref);
      if (!node) { node = new FocusNode(); this.hostRefs.set(ref, node); }
      node.isConnected = true;
      ref.current = node;
      mountedRefs.add(ref);
    }
    for (const [ref, node] of this.hostRefs) {
      if (!mountedRefs.has(ref)) { ref.current = null; node.isConnected = false; }
    }
    return renderToStaticMarkup(tree);
  }

  commit() { this.root.commit(); for (const child of this.children) child.frame.commit(); }

  private detachFrame(frame: HookFrame) {
    // React removes keyed-out host nodes before their passive cleanup runs.
    for (const [ref, node] of this.hostRefs) {
      if (frame.ownsRef(ref)) { ref.current = null; node.isConnected = false; }
    }
  }

  element(className: string) {
    const element = elements(this.tree).find((item) => item.props.className?.split(" ").includes(className));
    expect(element, `Rendered ${className} must exist`).toBeDefined();
    return element!;
  }

  node(className: string) {
    const node = this.element(className).props.ref?.current;
    expect(node).toBeInstanceOf(FocusNode);
    return node as FocusNode;
  }

  open() {
    this.render();
    this.node("source-snapshot-trigger").focus();
    void this.element("source-snapshot-trigger").props.onClick?.();
    const html = this.render();
    this.commit();
    return html;
  }

  close(method: "button" | "backdrop" | "Escape", commit = true) {
    if (method === "button") this.element("source-snapshot-close").props.onClick?.();
    if (method === "backdrop") this.element("source-snapshot-backdrop").props.onMouseDown?.({
      stopPropagation: vi.fn(), preventDefault: vi.fn(),
    });
    if (method === "Escape") key("Escape");
    if (commit) { this.render(); this.commit(); }
  }

  unmount() {
    for (const [ref, node] of this.hostRefs) { ref.current = null; node.isConnected = false; }
    this.root.cleanup();
    for (const child of this.children) child.frame.cleanup();
  }
}

const eventProps: Props = {
  changeEventId: "event/A", sourceId: "source/A", sourceTitle: "Current award source",
  sourceUrl: "https://example.edu/current",
};
const sourceProps: Props = { ...eventProps, changeEventId: null };
const loading = "Loading snapshot...";
const unavailable = "This screenshot evidence is not available.";
const loadError = "Screenshot evidence could not be loaded right now.";
const diagnostic = "PRIVATE storage account diagnostic";

function emptySnapshot() {
  return {
    source_url: eventProps.sourceUrl, source_title: eventProps.sourceTitle, source_page_type: null,
    expires_in_seconds: 300, evidence_scope: "change_event", evidence_status: "available",
    localization_direction: "current", latest: { captured_at: null, objects: {} },
    previous: { captured_at: null, objects: {} },
  };
}
function asset(name: string, contentType = "image/jpeg") {
  return { key: `published/${name}`, url: `https://signed.test/${name}`, content_type: contentType };
}
function imageSnapshot(name = "current.jpg") {
  return { ...emptySnapshot(), latest: { captured_at: null, objects: { full: asset(name) } } };
}
function response(status: number, body: unknown = { error: diagnostic }): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let count = 0; count < 12; count += 1) await Promise.resolve(); }
function mockFetch(result: Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>(() => result);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const harnesses: ModalHarness[] = [];
function mount(props: Props = eventProps) {
  const harness = new ModalHarness(props);
  harnesses.push(harness);
  const html = harness.render();
  expect(html).not.toContain('role="dialog"');
  harness.commit();
  return harness;
}
async function loaded(body: unknown, props: Props = eventProps) {
  const fetchMock = mockFetch(Promise.resolve(response(200, body)));
  const harness = mount(props);
  expect(harness.open()).toContain(loading);
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return harness.render();
}

beforeEach(() => {
  documentDouble = { activeElement: null };
  keyListeners = new Set();
  vi.stubGlobal("HTMLElement", FocusNode);
  vi.stubGlobal("document", documentDouble);
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: (event: TestKeyEvent) => void) => {
      if (type === "keydown") keyListeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: TestKeyEvent) => void) => {
      if (type === "keydown") keyListeners.delete(listener);
    },
  });
});
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.unmount();
  hookBridge.current = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([["event", eventProps], ["source-only", sourceProps]] as const)(
  "expanded screenshot %s response handling", (_name, props) => {
    it.each([401, 403, 404])("makes HTTP %i privacy-neutral without server diagnostics", async (status) => {
      const fetchMock = mockFetch(Promise.resolve(response(status)));
      const harness = mount(props);
      harness.open();
      await flush();
      const html = harness.render();
      expect(html).toContain(unavailable);
      expect(html).not.toMatch(/PRIVATE|not captured|retained artifacts/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([400, 408, 429, 500, 502, 503])("reports HTTP %i as a temporary loading failure", async (status) => {
      const fetchMock = mockFetch(Promise.resolve(response(status)));
      const harness = mount(props);
      harness.open();
      await flush();
      expect(harness.render()).toContain(loadError);
      expect(harness.render()).not.toContain(diagnostic);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(["network", "JSON"])("handles a %s rejection without raw diagnostics", async (kind) => {
      const fetchMock = mockFetch(kind === "network" ? Promise.reject(new Error(diagnostic)) : Promise.resolve({
        ok: true, status: 200, json: async (): Promise<unknown> => { throw new Error(diagnostic); },
      } as Response));
      const harness = mount(props);
      harness.open();
      await flush();
      expect(harness.render()).toContain(loadError);
      expect(harness.render()).not.toContain(diagnostic);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("preserves the modal's valid empty response wording", async () => {
      expect(await loaded(emptySnapshot(), props)).toContain("No visual snapshot is available yet.");
    });
  },
);

describe("expanded screenshot shape validation and compatibility", () => {
  it.each([
    ["null", null], ["primitive", "bad"], ["array", []], ["missing sides", {}],
    ["missing previous objects", { ...imageSnapshot(), previous: {} }],
    ["null previous", { ...imageSnapshot(), previous: null }],
    ["missing current objects", { ...emptySnapshot(), latest: {} }],
    ["array objects", { ...emptySnapshot(), latest: { captured_at: null, objects: [] } }],
    ["null asset", { ...emptySnapshot(), latest: { captured_at: null, objects: { full: null } } }],
    ["missing asset URL", { ...emptySnapshot(), latest: { captured_at: null, objects: { full: { key: "x" } } } }],
    ["invalid asset URL", { ...emptySnapshot(), latest: { captured_at: null, objects: { full: { ...asset("x"), url: "/relative" } } } }],
    ["invalid title", { ...imageSnapshot(), source_title: {} }],
    ["invalid capture date", { ...imageSnapshot(), latest: { ...imageSnapshot().latest, captured_at: {} } }],
  ] as Array<[string, unknown]>)("rejects %s without a render crash or archive-absence claim", async (_name, body) => {
    const html = await loaded(body);
    expect(html).toContain(loadError);
    expect(html).not.toMatch(/PRIVATE|No visual snapshot|<img/);
  });

  it("renders an image and current-event controls", async () => {
    const html = await loaded(imageSnapshot());
    expect(html).toContain('src="https://signed.test/current.jpg"');
    expect(html).toContain("Open image");
    expect(html).toMatch(/role="tab"[^>]*>Current<\/button>/);
  });

  it("shows one description and one capture timestamp without repeat quotes or metadata", async () => {
    const summary = "Applications now close on April 15 instead of April 1.";
    const capturedAt = "2026-09-09T14:10:00.000Z";
    const body = {
      ...imageSnapshot(),
      latest: {
        ...imageSnapshot().latest, captured_at: capturedAt,
        localization_reason: "PRIVATE crop localization diagnostic",
      },
      previous: { captured_at: "2026-09-08T14:10:00.000Z", objects: { full: asset("previous.jpg") } },
    };
    const props: Props = {
      ...eventProps,
      sourcePageTypeLabel: "Application requirements",
      changeDetectedAt: "2026-09-09T14:25:00.000Z",
      changeSummary: summary,
      changeDetails: {
        reader_summary: summary, change_type: "deadline", confidence: "high",
        before: "Applications close April 1.", after: "Applications close April 15.",
        exact_before: "Applications close April 1.", exact_after: "Applications close April 15.",
        section: "Deadline", advisor_impact: "Update advising calendars.",
        is_alert_worthy: true, source: {}, quality_flags: [],
        structured_diff: {
          removed_text: ["Applications close April 1."], added_text: ["Applications close April 15."],
          date_changes: [], amount_changes: [], noise_flags: [],
        },
      },
    };
    const before = structuredClone({ body, props });
    const $ = load(await loaded(body, props));

    expect($(".source-snapshot-evidence p")).toHaveLength(1);
    expect($(".source-snapshot-evidence").text().trim()).toBe(summary);
    expect($(".source-snapshot-evidence").attr("tabindex")).toBe("0");
    expect($("[role='dialog']").text().split(summary)).toHaveLength(2);
    expect($(".source-snapshot-evidence-grid, .source-snapshot-evidence-badges, .source-snapshot-header .badge")).toHaveLength(0);
    expect($(".source-snapshot-header h2").text()).toBe(eventProps.sourceTitle);
    expect($(".source-snapshot-source-link").attr("href")).toBe(eventProps.sourceUrl);
    expect($("time")).toHaveLength(1);
    expect($("time").attr("datetime")).toBe(capturedAt);
    expect($("time").text()).toMatch(/^Captured /);
    expect($(".source-snapshot-version-control > span").text()).toBe("Saved page");
    expect($(".source-snapshot-localization-note").text()).toBe("Highlight unavailable for this saved page.");
    expect($("[role='tab']").map((_index, tab) => $(tab).text()).get()).toEqual(["Current", "Previous"]);
    expect($("img").attr("src")).toBe("https://signed.test/current.jpg");
    expect($("[role='dialog']").text()).not.toMatch(/Applications close April|Application requirements|High confidence|Update advising calendars|PRIVATE|Detected/);
    expect({ body, props }).toEqual(before);
  });

  it("renders a PDF link rather than an image", async () => {
    const html = await loaded({ ...emptySnapshot(), latest: {
      captured_at: null, kind: "pdf", objects: { full: asset("document.pdf", "application/pdf") },
    } });
    expect(html).toContain('href="https://signed.test/document.pdf"');
    expect(html).toContain("Open PDF");
    expect(html).toContain("Saved PDF");
    expect(html).toContain("Open the saved PDF to view this document.");
    expect(html).not.toContain("<img");
  });

  it.each([true, false])("uses a crop only when exact_overlap=%s", async (exact) => {
    const html = await loaded({ ...emptySnapshot(), latest: {
      captured_at: null, exact_overlap: exact, objects: { full: asset("full.jpg"), crop: asset("crop.jpg") },
    } });
    expect(html).toContain(`src="https://signed.test/${exact ? "crop" : "full"}.jpg"`);
    expect(html).not.toContain(`src="https://signed.test/${exact ? "full" : "crop"}.jpg"`);
  });

  it.each(["removed", "previous", "empty current"])("opens retained previous evidence for %s", async (reason) => {
    const html = await loaded({ ...(reason === "empty current" ? emptySnapshot() : imageSnapshot()),
      localization_direction: reason === "empty current" ? "current" : reason,
      previous: { captured_at: null, objects: { full: asset("previous.jpg") } },
    });
    expect(html).toContain('src="https://signed.test/previous.jpg"');
    expect(html).toMatch(/aria-selected="true"[^>]*role="tab"[^>]*>Previous<\/button>/);
  });

  it("preserves historical artifact wording", async () => {
    expect(await loaded({ ...emptySnapshot(), evidence_status: "historical_artifact_unrecoverable" }))
      .toContain("Historical visual evidence unavailable - retained artifacts could not be recovered for this update.");
  });

  it("accepts source-only signed metadata and nullable asset properties", async () => {
    const html = await loaded({ source_url: eventProps.sourceUrl, source_title: null, source_page_type: null,
      expires_in_seconds: 300,
      latest: { captured_at: null, kind: "webpage", objects: {
        page: { ...asset("page.jpg"), content_type: null, width: null, height: null, clip: null },
        thumb: asset("thumb.jpg"), meta: asset("meta.json", "application/json"),
      } },
      previous: { captured_at: null, objects: {} },
    }, sourceProps);
    expect(html).toContain('src="https://signed.test/page.jpg"');
    expect(html).toMatch(/role="tab"[^>]*>Latest<\/button>/);
    expect(html).not.toMatch(/thumb\.jpg|meta\.json|could not be loaded/);
  });

  it("accepts nullable content type, dimensions, and clip on an event full image", async () => {
    const html = await loaded({ ...emptySnapshot(), latest: { captured_at: null, objects: {
      full: { ...asset("event.jpg"), content_type: null, width: null, height: null, clip: null },
    } } });
    expect(html).toContain('src="https://signed.test/event.jpg"');
    expect(html).toMatch(/role="tab"[^>]*>Current<\/button>/);
  });

  it("keeps first-observed PDF wording and omits the previous-version control", async () => {
    const wording = "Candidates must submit two letters of recommendation.";
    const html = await loaded({ ...emptySnapshot(), latest: {
      captured_at: null, kind: "pdf", objects: { full: asset("document.pdf", "application/pdf") },
      localization_reason: "PDF evidence is retained but does not use webpage crop localization.",
    } }, { ...eventProps, changeDetails: {
      event_kind: "new_official_document", change_type: "new_official_document",
      reader_summary: "AwardPing first observed this official document.",
      after: wording, exact_after: wording, before: null, exact_before: null,
      section: "Application requirements", advisor_impact: "Review the guidance.",
      is_alert_worthy: true, confidence: "high", source: {}, quality_flags: [],
      structured_diff: { added_text: [wording], removed_text: [], likely_section: "Application requirements",
        page_type: "pdf", date_changes: [], amount_changes: [], noise_flags: [] },
      first_observed_at: "2026-06-21T14:00:00.000Z",
    } });
    expect(html).toContain("Open the saved PDF to view this document.");
    expect(html).toContain("Saved PDF");
    expect(html).toContain("AwardPing first recorded this official document. This does not establish when it was published.");
    expect(html).not.toContain(wording);
    expect(html).toContain('href="https://signed.test/document.pdf"');
    expect(html).not.toMatch(/Immutable|crop localization/);
    expect(html).toMatch(/role="tab"[^>]*>First observed<\/button>/);
    expect(html).not.toMatch(/role="tab"[^>]*>Previous<\/button>/);
    const $ = load(html);
    expect($(".source-snapshot-evidence p")).toHaveLength(1);
    expect($(".source-snapshot-evidence").text().trim()).toBe(
      "AwardPing first recorded this official document. This does not establish when it was published.",
    );
    expect($(".source-snapshot-evidence-grid, .source-snapshot-evidence-badges")).toHaveLength(0);
  });
});

describe("expanded screenshot request ownership", () => {
  const outcomes = ["success", "HTTP failure", "JSON success", "JSON rejection", "network rejection"] as const;
  type LateOutcome = typeof outcomes[number];
  function lateRequest() {
    const fetchResult = deferred<Response>();
    const jsonResult = deferred<unknown>();
    return {
      promise: fetchResult.promise,
      async begin(outcome: LateOutcome) {
        if (outcome === "JSON success" || outcome === "JSON rejection") {
          fetchResult.resolve({ ok: true, status: 200, json: () => jsonResult.promise } as Response);
          await flush();
        }
      },
      settle(outcome: LateOutcome) {
        if (outcome === "success") fetchResult.resolve(response(200, imageSnapshot("stale.jpg")));
        if (outcome === "HTTP failure") fetchResult.resolve(response(503));
        if (outcome === "JSON success") jsonResult.resolve(imageSnapshot("stale.jpg"));
        if (outcome === "JSON rejection") jsonResult.reject(new Error(diagnostic));
        if (outcome === "network rejection") fetchResult.reject(new Error(diagnostic));
      },
    };
  }

  it("requests only the encoded event endpoint on click and never falls back after failure", async () => {
    const fetchMock = mockFetch(Promise.resolve(response(404)));
    const harness = mount();
    expect(fetchMock).not.toHaveBeenCalled();
    harness.open();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/change-events/event%2FA/visual-evidence");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    expect(harness.render()).toContain(unavailable);
  });

  it("requests the source endpoint only without an event ID", async () => {
    const fetchMock = mockFetch(Promise.resolve(response(200, emptySnapshot())));
    mount(sourceProps).open();
    await flush();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/source-snapshots/source%2FA");
  });

  it("renders no trigger and makes no request without either identifier", () => {
    const fetchMock = mockFetch(Promise.resolve(response(200, emptySnapshot())));
    const harness = mount({ ...eventProps, sourceId: null, changeEventId: null });
    expect(harness.render()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(outcomes)("a late %s cannot clobber a ready same-URL reopen", async (outcome) => {
    const old = lateRequest();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(response(200, imageSnapshot("fresh.jpg")));
    vi.stubGlobal("fetch", fetchMock);
    const harness = mount();
    harness.open();
    await old.begin(outcome);
    harness.close("button");
    harness.open();
    await flush();
    expect(harness.render()).toContain('src="https://signed.test/fresh.jpg"');
    const writes = harness.writes;
    old.settle(outcome);
    await flush();
    expect(harness.writes).toBe(writes);
    expect(harness.render()).toContain('src="https://signed.test/fresh.jpg"');
    expect(harness.render()).not.toMatch(/stale\.jpg|PRIVATE|could not be loaded/);
    expect(fetchMock.mock.calls[0][0]).toBe(fetchMock.mock.calls[1][0]);
  });

  it.each(outcomes)("a late %s cannot clear the new request's loading state", async (outcome) => {
    const old = lateRequest();
    const current = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise));
    const harness = mount();
    harness.open();
    await old.begin(outcome);
    harness.close("button");
    expect(harness.open()).toContain(loading);
    const writes = harness.writes;
    old.settle(outcome);
    await flush();
    expect(harness.writes).toBe(writes);
    expect(harness.render()).toContain(loading);
    expect(harness.render()).not.toMatch(/stale\.jpg|PRIVATE/);
    current.resolve(response(200, imageSnapshot("fresh.jpg")));
    await flush();
    expect(harness.render()).toContain('src="https://signed.test/fresh.jpg"');
  });

  it.each(["button", "backdrop", "Escape", "unmount"] as const)(
    "%s invalidates pending work before any later completion can write", async (method) => {
      for (const outcome of outcomes) {
        const old = lateRequest();
        mockFetch(old.promise);
        const harness = mount();
        harness.open();
        await old.begin(outcome);
        if (method === "unmount") harness.unmount();
        else harness.close(method, false); // Before a rerender/effect cleanup.
        const writes = harness.writes;
        old.settle(outcome);
        await flush();
        expect(harness.writes, `${method}: late ${outcome}`).toBe(writes);
        if (method !== "unmount") {
          expect(harness.render()).not.toContain('role="dialog"');
          harness.commit();
        }
      }
    },
  );

  it("clears previous snapshot title, URL, timestamp, and image while reopening", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(response(200, {
      ...imageSnapshot("old.jpg"), source_title: "OLD retained title", source_url: "https://old.test/retained",
      latest: { captured_at: "2001-01-01T12:00:00Z", objects: { full: asset("old.jpg") } },
    })).mockReturnValueOnce(pending.promise));
    const harness = mount();
    harness.open();
    await flush();
    expect(harness.render()).toContain("OLD retained title");
    expect(harness.render()).toContain("source-snapshot-captured");
    harness.close("button");
    const html = harness.open();
    expect(html).toContain(loading);
    expect(html).toContain(eventProps.sourceTitle);
    expect(html).toContain(eventProps.sourceUrl);
    expect(html).not.toMatch(/OLD retained title|old\.test|source-snapshot-captured|old\.jpg/);
  });

  it("does not show an open A snapshot with B's current evidence props", async () => {
    mockFetch(Promise.resolve(response(200, imageSnapshot("A.jpg"))));
    const harness = mount();
    harness.open();
    await flush();
    expect(harness.render()).toContain('src="https://signed.test/A.jpg"');
    const html = harness.render({ ...eventProps, changeEventId: "event/B", sourceId: "source/B",
      sourceTitle: "B title", sourceUrl: "https://example.edu/B", changeSummary: "B evidence only.",
    });
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toMatch(/A\.jpg|B evidence only/);
    harness.commit();
    expect(harness.render(eventProps)).not.toContain('role="dialog"');
  });

  it("A to B to A creates a fresh closed session and ignores the first A response", async () => {
    const old = lateRequest();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(response(200, imageSnapshot("fresh-A.jpg")));
    vi.stubGlobal("fetch", fetchMock);
    const harness = mount();
    harness.open();
    expect(harness.render({ ...eventProps, changeEventId: "event/B" })).not.toContain('role="dialog"');
    harness.commit();
    expect(harness.render(eventProps)).not.toContain('role="dialog"');
    harness.commit();
    harness.open();
    await flush();
    const writes = harness.writes;
    old.settle("success");
    await flush();
    expect(harness.writes).toBe(writes);
    expect(harness.render()).toContain('src="https://signed.test/fresh-A.jpg"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("expanded screenshot executed focus and close behavior", () => {
  it("prevents the backdrop's native mousedown default from stealing restored trigger focus", () => {
    mockFetch(deferred<Response>().promise);
    const harness = mount();
    const trigger = harness.node("source-snapshot-trigger");
    harness.open();
    const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
    harness.element("source-snapshot-backdrop").props.onMouseDown?.(event);
    // The real browser performs its focus-changing default after this handler;
    // this component test pins cancellation, not browser default simulation.
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.render()).not.toContain('role="dialog"');
    harness.commit();
    expect(documentDouble.activeElement).toBe(trigger);
    expect(keyListeners.size).toBe(0);
  });

  it("preserves open/loading state and focus on a same-request-path rerender", async () => {
    const pending = deferred<Response>();
    const fetchMock = mockFetch(pending.promise);
    const harness = mount();
    harness.open();
    const closeButton = harness.node("source-snapshot-close");
    const trigger = harness.node("source-snapshot-trigger");
    const html = harness.render({ ...eventProps, sourceTitle: "Revised display label" });
    harness.commit();
    expect(html).toContain('role="dialog"');
    expect(html).toContain(loading);
    expect(documentDouble.activeElement).toBe(closeButton);
    expect(closeButton.focus).toHaveBeenCalledOnce();
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(keyListeners.size).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    pending.resolve(response(200, imageSnapshot()));
    await flush();
    expect(harness.render()).toContain('src="https://signed.test/current.jpg"');
  });

  it("does not restore focus to a return target removed while the modal was open", () => {
    mockFetch(deferred<Response>().promise);
    const harness = mount();
    const origin = new FocusNode();
    origin.focus();
    void harness.element("source-snapshot-trigger").props.onClick?.();
    harness.render();
    harness.commit();
    expect(documentDouble.activeElement).toBe(harness.node("source-snapshot-close"));
    origin.isConnected = false;
    origin.focus.mockClear();
    harness.close("button");
    expect(origin.focus).not.toHaveBeenCalled();
    expect(keyListeners.size).toBe(0);
  });

  it.each(["button", "backdrop", "Escape"] as const)("%s closes, removes the listener, and restores focus", (method) => {
    mockFetch(deferred<Response>().promise);
    const harness = mount();
    const trigger = harness.node("source-snapshot-trigger");
    harness.open();
    expect(documentDouble.activeElement).toBe(harness.node("source-snapshot-close"));
    expect(keyListeners.size).toBe(1);
    harness.close(method);
    expect(harness.render()).not.toContain('role="dialog"');
    expect(keyListeners.size).toBe(0);
    expect(documentDouble.activeElement).toBe(trigger);
  });

  it("traps Tab and Shift-Tab at each boundary and when focus is outside", () => {
    mockFetch(deferred<Response>().promise);
    const harness = mount();
    harness.open();
    const first = new FocusNode();
    const middle = new FocusNode();
    const last = new FocusNode();
    harness.node("source-snapshot-dialog").focusables = [first, middle, last];
    for (const [from, shift, expected] of [
      [last, false, first], [first, true, last],
      [new FocusNode(), false, first], [new FocusNode(), true, last],
    ] as const) {
      documentDouble.activeElement = from;
      expect(key("Tab", shift).preventDefault).toHaveBeenCalledOnce();
      expect(documentDouble.activeElement).toBe(expected);
    }
    documentDouble.activeElement = middle;
    expect(key("Tab").preventDefault).not.toHaveBeenCalled();
    expect(key("ArrowDown").preventDefault).not.toHaveBeenCalled();
  });

  it("focuses the dialog if no usable controls remain", () => {
    mockFetch(deferred<Response>().promise);
    const harness = mount();
    harness.open();
    const dialog = harness.node("source-snapshot-dialog");
    const hidden = new FocusNode(); hidden.hidden = true;
    const ariaHidden = new FocusNode(); ariaHidden.ariaHidden = "true";
    const negativeTab = new FocusNode(); negativeTab.tabIndex = -1;
    const disabled = new FocusNode(); disabled.disabled = true;
    dialog.focusables = [hidden, ariaHidden, negativeTab, disabled];
    expect(key("Tab").preventDefault).toHaveBeenCalledOnce();
    expect(documentDouble.activeElement).toBe(dialog);
  });

  it("does not close for a mouse-down within the dialog", () => {
    mockFetch(deferred<Response>().promise);
    const harness = mount();
    harness.open();
    const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
    harness.element("source-snapshot-dialog").props.onMouseDown?.(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(harness.render()).toContain('role="dialog"');
  });

  it("removes its keyboard listener on unmount", () => {
    mockFetch(deferred<Response>().promise);
    const harness = mount();
    harness.open();
    expect(keyListeners.size).toBe(1);
    harness.unmount();
    expect(keyListeners.size).toBe(0);
    const writes = harness.writes;
    key("Escape");
    expect(harness.writes).toBe(writes);
  });
});
