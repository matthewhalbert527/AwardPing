import type { ComponentProps, DependencyList, Dispatch, EffectCallback, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceSnapshotInlinePreview } from "@/components/source-snapshot-viewer";

const hookBridge = vi.hoisted(() => ({ current: null as InlineHarness | null }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => hookBridge.current
      ? hookBridge.current.state(initial)
      : actual.useState(initial),
    useMemo: <T,>(factory: () => T, deps: DependencyList) => hookBridge.current
      ? hookBridge.current.memo(factory, deps)
      : actual.useMemo(factory, deps),
    useEffect: (effect: EffectCallback, deps?: DependencyList) => hookBridge.current
      ? hookBridge.current.effect(effect, deps)
      : actual.useEffect(effect, deps),
  };
});

type Props = ComponentProps<typeof SourceSnapshotInlinePreview>;
type EffectSlot = { deps?: DependencyList; cleanup?: () => void; pending?: EffectCallback };

function sameDeps(left?: DependencyList, right?: DependencyList) {
  return Boolean(left && right && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index])));
}

// Only the inline root's hooks are driven here. Its returned TSX and nested
// image/PDF body render through real React; no component source is substituted.
class InlineHarness {
  private states: unknown[] = [];
  private memos: Array<{ deps: DependencyList; value: unknown }> = [];
  private effects: EffectSlot[] = [];
  private stateIndex = 0;
  private memoIndex = 0;
  private effectIndex = 0;
  writes = 0;

  state<T>(initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
    const index = this.stateIndex++;
    if (!(index in this.states)) {
      this.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    }
    return [this.states[index] as T, (next) => {
      this.writes += 1;
      this.states[index] = typeof next === "function"
        ? (next as (previous: T) => T)(this.states[index] as T)
        : next;
    }];
  }

  memo<T>(factory: () => T, deps: DependencyList): T {
    const index = this.memoIndex++;
    if (!sameDeps(this.memos[index]?.deps, deps)) {
      this.memos[index] = { deps, value: factory() };
    }
    return this.memos[index].value as T;
  }

  effect(callback: EffectCallback, deps?: DependencyList) {
    const index = this.effectIndex++;
    if (!sameDeps(this.effects[index]?.deps, deps)) {
      this.effects[index] = { ...this.effects[index], deps, pending: callback };
    }
  }

  render(props: Props = eventProps) {
    this.stateIndex = this.memoIndex = this.effectIndex = 0;
    hookBridge.current = this;
    let element: ReturnType<typeof SourceSnapshotInlinePreview>;
    try {
      element = SourceSnapshotInlinePreview(props);
    } finally {
      hookBridge.current = null;
    }
    return renderToStaticMarkup(element);
  }

  commitEffects() {
    for (const slot of this.effects) {
      if (!slot.pending) continue;
      slot.cleanup?.();
      const cleanup = slot.pending();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      slot.pending = undefined;
    }
  }

  unmount() {
    for (const slot of this.effects) {
      slot.cleanup?.();
      slot.cleanup = undefined;
      slot.pending = undefined;
    }
  }
}

const eventProps: Props = {
  changeEventId: "event/A",
  sourceId: "source/A",
  sourceTitle: "Award deadline",
  sourceUrl: "https://example.edu/award",
};
const sourceProps: Props = { ...eventProps, changeEventId: null };
const unavailable = "This screenshot evidence is not available.";
const loadError = "Screenshot evidence could not be loaded right now.";
const eventAbsent = "Exact visual evidence is unavailable for this update.";
const sourceAbsent = "Screenshot preview not captured yet.";
const loading = "Loading screenshot preview...";
const diagnostic = "PRIVATE server diagnostic must not appear";

function emptySnapshot() {
  return {
    source_url: eventProps.sourceUrl,
    source_title: eventProps.sourceTitle,
    source_page_type: "deadline",
    expires_in_seconds: 300,
    evidence_scope: "change_event",
    evidence_status: "available",
    localization_direction: "current",
    latest: { captured_at: null, objects: {} },
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

async function flush() {
  // Drain the fetch -> JSON -> state/catch promise chain without timers or IO.
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

const harnesses: InlineHarness[] = [];
function mount(props: Props = eventProps) {
  const harness = new InlineHarness();
  harnesses.push(harness);
  expect(harness.render(props)).toContain(loading);
  harness.commitEffects();
  return harness;
}

function mockFetch(result: Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>(() => result);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function loaded(body: unknown, props: Props = eventProps) {
  mockFetch(Promise.resolve(response(200, body)));
  const harness = mount(props);
  await flush();
  return harness.render(props);
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.unmount();
  hookBridge.current = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([ ["event", eventProps], ["source-only", sourceProps] ] as const)(
  "inline screenshot %s request outcomes", (_name, props) => {
    it.each([401, 403, 404])("keeps HTTP %i unavailable and privacy-neutral", async (status) => {
      const fetchMock = mockFetch(Promise.resolve(response(status)));
      const harness = mount(props);
      await flush();
      const html = harness.render(props);
      expect(html).toContain(unavailable);
      expect(html).not.toMatch(/not captured|Exact visual|PRIVATE|retained artifacts/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([400, 408, 429, 500, 502, 503])("reports HTTP %i as a loading failure", async (status) => {
      mockFetch(Promise.resolve(response(status)));
      const harness = mount(props);
      await flush();
      expect(harness.render(props)).toContain(loadError);
      expect(harness.render(props)).not.toContain(diagnostic);
    });

    it("reports network rejection without claiming the archive is empty", async () => {
      mockFetch(Promise.reject(new Error(diagnostic)));
      const harness = mount(props);
      await flush();
      expect(harness.render(props)).toContain(loadError);
      expect(harness.render(props)).not.toContain(diagnostic);
    });

    it("reports rejected JSON as a loading failure", async () => {
      mockFetch(Promise.resolve({ ok: true, status: 200, json: async (): Promise<unknown> => {
        throw new Error(diagnostic);
      } } as Response));
      const harness = mount(props);
      await flush();
      expect(harness.render(props)).toContain(loadError);
      expect(harness.render(props)).not.toContain(diagnostic);
    });

    it("preserves a valid empty response's endpoint-specific absence wording", async () => {
      expect(await loaded(emptySnapshot(), props)).toContain(props.changeEventId ? eventAbsent : sourceAbsent);
    });
  },
);

describe("inline screenshot response validation and existing rendering", () => {
  const malformed: Array<[string, unknown]> = [
    ["null", null], ["array", []], ["primitive", "bad"],
    ["missing sides", { source_url: eventProps.sourceUrl }],
    ["null latest", { ...emptySnapshot(), latest: null }],
    ["missing objects", { ...emptySnapshot(), latest: {} }],
    ["array objects", { ...emptySnapshot(), latest: { captured_at: null, objects: [] } }],
    ["null asset", { ...emptySnapshot(), latest: { captured_at: null, objects: { full: null } } }],
    ["missing asset URL", { ...emptySnapshot(), latest: { captured_at: null, objects: { full: { key: "x" } } } }],
    ["relative asset URL", { ...imageSnapshot(), latest: { captured_at: null, objects: { full: { ...asset("x"), url: "/x" } } } }],
    ["non-HTTP asset URL", { ...imageSnapshot(), latest: { captured_at: null, objects: { full: { ...asset("x"), url: "javascript:alert(1)" } } } }],
    ["empty asset key", { ...imageSnapshot(), latest: { captured_at: null, objects: { full: { ...asset("x"), key: "" } } } }],
    ["invalid content type", { ...imageSnapshot(), latest: { captured_at: null, objects: { full: { ...asset("x"), content_type: {} } } } }],
    ["invalid capture date type", { ...emptySnapshot(), latest: { captured_at: {}, objects: {} } }],
    ["invalid source title", { ...imageSnapshot(), source_title: {} }],
    ["invalid source page type", { ...imageSnapshot(), source_page_type: [] }],
    ["invalid localization prose", { ...imageSnapshot(), latest: { ...imageSnapshot().latest, localization_reason: {} } }],
  ];

  it.each(malformed)("rejects %s without crashing or claiming absence", async (_name, body) => {
    const html = await loaded(body);
    expect(html).toContain(loadError);
    expect(html).not.toMatch(/not captured|Exact visual|PRIVATE|<img/);
  });

  it("preserves truthful historical artifact wording for a valid response", async () => {
    expect(await loaded({ ...emptySnapshot(), evidence_status: "historical_artifact_unrecoverable" }))
      .toContain("Historical visual evidence unavailable - retained artifacts could not be recovered for this update.");
  });

  it("renders the actual current image and immutable-event label", async () => {
    const html = await loaded(imageSnapshot());
    expect(html).toContain('src="https://signed.test/current.jpg"');
    expect(html).toContain('alt="Award deadline latest snapshot"');
    expect(html).toContain("Open image");
    expect(html).toContain("Current");
  });

  it("accepts a source-only payload without event fields and with signed metadata", async () => {
    const html = await loaded({
      source_url: eventProps.sourceUrl,
      source_title: null,
      source_page_type: null,
      expires_in_seconds: 300,
      latest: {
        captured_at: null,
        kind: "webpage",
        focus_ratio: 0.4,
        localization_status: "localized",
        localization_reason: "Exact change text matched this screenshot's layout metadata.",
        objects: {
          page: { key: "retained/page.jpg", url: "https://signed.test/page.jpg?signature=example" },
          thumb: { key: "retained/thumb.jpg", url: "https://signed.test/thumb.jpg?signature=example" },
          meta: { key: "retained/meta.json", url: "https://signed.test/meta.json?signature=example" },
        },
      },
      previous: { captured_at: null, objects: {} },
    }, sourceProps);
    expect(html).toContain('src="https://signed.test/page.jpg?signature=example"');
    expect(html).toContain('alt="Award deadline latest snapshot"');
    expect(html).toContain("Latest");
    expect(html).toContain("Approximate text match");
    expect(html).not.toMatch(/thumb\.jpg|meta\.json|full event screenshot|could not be loaded/);
  });

  it("accepts an event image with nullable content type, dimensions, and clip", async () => {
    const html = await loaded({ ...emptySnapshot(), latest: {
      captured_at: null,
      exact_overlap: false,
      objects: { full: {
        ...asset("nullable.jpg"), content_type: null, width: null, height: null, clip: null,
      } },
    } });
    expect(html).toContain('src="https://signed.test/nullable.jpg"');
    expect(html).toContain("Open image");
    expect(html).toContain("Current");
    expect(html).not.toContain(loadError);
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

  it("keeps a first-observed PDF current-only without implying a previous version", async () => {
    const wording = "Candidates must submit two letters of recommendation.";
    const html = await loaded({ ...emptySnapshot(), latest: {
      captured_at: null, kind: "pdf", objects: { full: asset("document.pdf", "application/pdf") },
      localization_reason: "PDF evidence is retained but does not use webpage crop localization.",
    } }, { ...eventProps, changeDetails: {
      event_kind: "new_official_document",
      change_type: "new_official_document",
      reader_summary: "AwardPing first observed this official document.",
      after: wording,
      exact_after: wording,
      before: null,
      exact_before: null,
      section: "Application requirements",
      advisor_impact: "Review the guidance before advising applicants.",
      is_alert_worthy: true,
      confidence: "high",
      structured_diff: {
        added_text: [wording], removed_text: [], likely_section: "Application requirements",
        page_type: "pdf", date_changes: [], amount_changes: [], noise_flags: [],
      },
      source: {}, quality_flags: [], first_observed_at: "2026-06-21T14:00:00.000Z",
    } });
    expect(html).toContain("First observed");
    expect(html).toContain("Saved PDF");
    expect(html).toContain('href="https://signed.test/document.pdf"');
    expect(html).toContain("Saved PDF");
    expect(html).toContain("Open the saved PDF to view this document.");
    expect(html).not.toMatch(/Previous|<img|Immutable|crop localization/);
  });

  it.each([true, false])("uses the crop only for exact_overlap=%s", async (exact) => {
    const html = await loaded({ ...emptySnapshot(), latest: {
      captured_at: null, exact_overlap: exact,
      objects: { full: asset("full.jpg"), crop: asset("crop.jpg") },
    } });
    expect(html).toContain(`src="https://signed.test/${exact ? "crop" : "full"}.jpg"`);
    expect(html).not.toContain(`src="https://signed.test/${exact ? "full" : "crop"}.jpg"`);
  });

  it.each(["removed", "previous"])("starts on previous evidence for %s", async (direction) => {
    const html = await loaded({ ...imageSnapshot(), localization_direction: direction,
      previous: { captured_at: null, objects: { full: asset("previous.jpg") } },
    });
    expect(html).toContain('src="https://signed.test/previous.jpg"');
    expect(html).toContain('alt="Award deadline previous snapshot"');
  });

  it("falls back to a retained previous image when current is empty", async () => {
    expect(await loaded({ ...emptySnapshot(), previous: {
      captured_at: null, objects: { full: asset("previous.jpg") },
    } })).toContain('src="https://signed.test/previous.jpg"');
  });
});

describe("inline screenshot request ownership", () => {
  it("does not request or render anything without either identifier", () => {
    const fetchMock = mockFetch(Promise.resolve(response(200, emptySnapshot())));
    const harness = new InlineHarness();
    harnesses.push(harness);
    expect(harness.render({ ...eventProps, sourceId: null, changeEventId: null })).toBe("");
    harness.commitEffects();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers the event endpoint, encodes the ID, and never falls back after failure", async () => {
    const fetchMock = mockFetch(Promise.resolve(response(503)));
    const harness = mount();
    await flush();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/change-events/event%2FA/visual-evidence", {
      cache: "no-store", signal: expect.any(AbortSignal),
    });
    expect(harness.render()).toContain(loadError);
    harness.commitEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the source endpoint only when there is no event ID", async () => {
    const fetchMock = mockFetch(Promise.resolve(response(200, emptySnapshot())));
    mount(sourceProps);
    await flush();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/source-snapshots/source%2FA");
  });

  it.each(["success", "non-OK", "JSON success", "JSON rejection", "network rejection"] as const)(
    "ignores late %s from an aborted request after B is ready", async (outcome) => {
      const oldFetch = deferred<Response>();
      const oldJson = deferred<unknown>();
      const fetchMock = vi.fn<typeof fetch>()
        .mockReturnValueOnce(oldFetch.promise)
        .mockResolvedValueOnce(response(200, imageSnapshot("B.jpg")));
      vi.stubGlobal("fetch", fetchMock);
      const harness = mount();
      if (outcome === "JSON success" || outcome === "JSON rejection") {
        oldFetch.resolve({ ok: true, status: 200, json: () => oldJson.promise } as Response);
        await flush();
      }
      const propsB = { ...eventProps, changeEventId: "event/B" };
      expect(harness.render(propsB)).toContain(loading);
      harness.commitEffects();
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
      await flush();
      expect(harness.render(propsB)).toContain('src="https://signed.test/B.jpg"');
      const writes = harness.writes;
      if (outcome === "success") oldFetch.resolve(response(200, imageSnapshot("stale-A.jpg")));
      if (outcome === "non-OK") oldFetch.resolve(response(503));
      if (outcome === "JSON success") oldJson.resolve(imageSnapshot("stale-A.jpg"));
      if (outcome === "JSON rejection") oldJson.reject(new Error(diagnostic));
      if (outcome === "network rejection") oldFetch.reject(new Error(diagnostic));
      await flush();
      expect(harness.writes).toBe(writes);
      expect(harness.render(propsB)).toContain('src="https://signed.test/B.jpg"');
    },
  );

  it("does not reuse completed A state during A to B to a new A request", async () => {
    const pendingB = deferred<Response>();
    const newA = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, imageSnapshot("old-A.jpg")))
      .mockReturnValueOnce(pendingB.promise)
      .mockReturnValueOnce(newA.promise);
    vi.stubGlobal("fetch", fetchMock);
    const harness = mount();
    await flush();
    expect(harness.render()).toContain('src="https://signed.test/old-A.jpg"');
    harness.render({ ...eventProps, changeEventId: "event/B" });
    harness.commitEffects();
    expect(harness.render()).toContain(loading);
    harness.commitEffects();
    newA.resolve(response(200, imageSnapshot("new-A.jpg")));
    await flush();
    expect(harness.render()).toContain('src="https://signed.test/new-A.jpg"');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not let a first A instance overwrite a newer A with the same URL", async () => {
    const oldA = deferred<Response>();
    const pendingB = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>()
      .mockReturnValueOnce(oldA.promise)
      .mockReturnValueOnce(pendingB.promise)
      .mockResolvedValueOnce(response(200, imageSnapshot("new-A.jpg")));
    vi.stubGlobal("fetch", fetchMock);
    const harness = mount();
    harness.render({ ...eventProps, changeEventId: "event/B" });
    harness.commitEffects();
    expect(harness.render()).toContain(loading);
    harness.commitEffects();
    await flush();
    const writes = harness.writes;
    oldA.resolve(response(200, imageSnapshot("stale-A.jpg")));
    await flush();
    expect(harness.writes).toBe(writes);
    expect(harness.render()).toContain('src="https://signed.test/new-A.jpg"');
  });

  it.each(["success", "non-OK", "JSON success", "JSON rejection", "network rejection"] as const)(
    "commits nothing after cleanup followed by %s", async (outcome) => {
      const pending = deferred<Response>();
      const pendingJson = deferred<unknown>();
      const fetchMock = mockFetch(pending.promise);
      const harness = mount();
      if (outcome === "JSON success" || outcome === "JSON rejection") {
        pending.resolve({ ok: true, status: 200, json: () => pendingJson.promise } as Response);
        await flush();
      }
      harness.unmount();
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
      const writes = harness.writes;
      if (outcome === "success") pending.resolve(response(200, imageSnapshot()));
      if (outcome === "non-OK") pending.resolve(response(500));
      if (outcome === "JSON success") pendingJson.resolve(imageSnapshot());
      if (outcome === "JSON rejection") pendingJson.reject(new Error(diagnostic));
      if (outcome === "network rejection") pending.reject(new Error(diagnostic));
      await flush();
      expect(harness.writes).toBe(writes);
    },
  );
});
