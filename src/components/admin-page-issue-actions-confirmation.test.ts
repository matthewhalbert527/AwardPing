import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Effect = { phase: "layout" | "passive"; dependencies: unknown[]; callback: () => void | (() => void); cleanup?: () => void };
type HookStore = { values: unknown[]; refs: { current: unknown }[]; effects: Effect[];
  cursor: number; refCursor: number; effectCursor: number; pendingEffects: { phase: Effect["phase"]; run: () => void }[] };
const hooks = vi.hoisted(() => ({ stores: {} as Record<string, HookStore>, active: "wrapper", refresh: vi.fn() }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  function effect(phase: Effect["phase"], callback: Effect["callback"], dependencies: unknown[]) {
    const store = hooks.stores[hooks.active], index = store.effectCursor++, previous = store.effects[index];
    const next = { phase, dependencies, callback, cleanup: previous?.cleanup };
    store.effects[index] = next;
    if (!previous || dependencies.length !== previous.dependencies.length ||
      dependencies.some((value, position) => !Object.is(value, previous.dependencies[position]))) {
      store.pendingEffects.push({ phase, run: () => {
        previous?.cleanup?.();
        const cleanup = callback();
        next.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      } });
    }
  }
  return { ...actual,
    useState: (initial: unknown) => {
      const store = hooks.stores[hooks.active], index = store.cursor++;
      if (!(index in store.values)) store.values[index] = typeof initial === "function" ? initial() : initial;
      return [store.values[index], (next: unknown) => {
        store.values[index] = typeof next === "function" ? next(store.values[index]) : next;
      }];
    },
    useRef: (initial: unknown) => {
      const store = hooks.stores[hooks.active], index = store.refCursor++;
      return store.refs[index] ??= { current: initial };
    },
    useId: () => `restore-${hooks.active}`,
    useEffect: (callback: Effect["callback"], dependencies: unknown[]) => effect("passive", callback, dependencies),
    useLayoutEffect: (callback: Effect["callback"], dependencies: unknown[]) => effect("layout", callback, dependencies),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: hooks.refresh }) }));

import { AdminPageIssueActions } from "@/components/admin-page-issue-actions";

type Context = { sourceId: string | null; sourceTitle: string; mode: "active" | "review" };
type NodeProps = { children?: ReactNode; role?: string; disabled?: boolean; autoFocus?: boolean;
  onClick?: () => void | Promise<void>;
  onKeyDown?: (event: { key: string; preventDefault: () => void }) => void };
type ControlsProps = Context & { sourceId: string; inFlightRef: { current: boolean };
  busyAction: "review_later" | "restore" | "delete" | null;
  updateBusyAction: (action: "review_later" | "restore" | "delete" | null) => void };
const source: Context = { sourceId: "20226663-08b9-4215-a76c-cf45bd794d67",
  sourceTitle: "Frequently Asked Questions - Synthetic Scholars", mode: "review" };
let currentKey: string | null, currentStore: string | null, sequence: number;
let passivePhase: (() => void)[];
function store(): HookStore {
  return { values: [], refs: [], effects: [], cursor: 0, refCursor: 0, effectCursor: 0, pendingEffects: [] };
}
function inStore<T>(key: string, callback: () => T) {
  hooks.active = key; hooks.stores[key] ??= store();
  Object.assign(hooks.stores[key], { cursor: 0, refCursor: 0, effectCursor: 0 });
  return callback();
}
function cleanupChild() {
  if (currentStore) cleanupEffects(hooks.stores[currentStore]);
  currentKey = null; currentStore = null;
}
function cleanupEffects(store: HookStore) {
  store.effects.forEach(effect => {
    if (effect.phase === "layout") effect.cleanup?.();
    else passivePhase.push(() => effect.cleanup?.());
  });
}
function commitEffects(store: HookStore) {
  store.pendingEffects.splice(0).forEach(effect => {
    if (effect.phase === "layout") effect.run();
    else passivePhase.push(effect.run);
  });
}
function flushPassivePhase() { passivePhase.splice(0).forEach(callback => callback()); }
function unmount({ deferPassive = false } = {}) {
  cleanupChild(); if (hooks.stores.wrapper) cleanupEffects(hooks.stores.wrapper);
  if (!deferPassive) flushPassivePhase();
}
function elements(node: ReactNode): ReactElement<NodeProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return isValidElement<NodeProps>(node) ? [node, ...elements(node.props.children)] : [];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<NodeProps>(node) ? text(node.props.children) : "";
}
function render(context = source, { deferPassive = false } = {}) {
  const root = inStore("wrapper", () => AdminPageIssueActions(context)) as ReactElement<ControlsProps> | null;
  if (!root) {
    cleanupChild(); commitEffects(hooks.stores.wrapper);
    if (!deferPassive) flushPassivePhase(); return null;
  }
  if (currentKey !== root.key) {
    cleanupChild(); currentKey = root.key; currentStore = `child-${++sequence}`;
  }
  if (typeof root.type !== "function") throw new Error("Expected the actual keyed controls component");
  const controls = root.type as (props: ControlsProps) => ReactNode;
  const tree = inStore(currentStore!, () => controls(root.props));
  // Model layout teardown/setup in the commit separately from later passive
  // cleanup/focus. This remains an ordered hook double, not a React renderer or
  // browser focus, keyboard-delivery, hydration or real-unmount proof.
  trigger.disabled = Boolean(elements(tree).find(element => element.type === "button")?.props.disabled);
  commitEffects(hooks.stores.wrapper); commitEffects(hooks.stores[currentStore!]);
  if (!deferPassive) flushPassivePhase();
  return tree;
}
function button(tree: ReactNode, label: string) {
  const match = elements(tree).find(element => element.type === "button" && text(element.props.children) === label);
  expect(match, label).toBeTruthy(); return match!;
}
const open = (tree: ReactNode) => button(tree, "Verify & restore monitoring").props.onClick!;
const confirm = (tree: ReactNode) => button(tree, "Confirm restore").props.onClick!;
const cancel = (tree: ReactNode) => button(tree, "Cancel").props.onClick!;
class FakeElement {
  focus = vi.fn(); isConnected = true; disabled = false; disabledByAncestor = false;
  matches = (selector: string) => selector === ":disabled" && (this.disabled || this.disabledByAncestor);
}
let trigger: FakeElement;
let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  hooks.stores = {}; hooks.refresh.mockReset(); currentKey = null; currentStore = null; sequence = 0;
  passivePhase = [];
  trigger = new FakeElement(); vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("document", { activeElement: trigger });
  vi.stubGlobal("window", { confirm: vi.fn(() => false), prompt: vi.fn(() => null) });
  send = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    message: "Monitoring restored.", monitoring: { allowed: true }, publicFactsApproved: false, publicUpdatesApproved: false,
  }) });
  vi.stubGlobal("fetch", send);
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe("explicit inline monitoring-only restoration", () => {
  it("shows the exact source and existing free warning without a request or native dialog", async () => {
    await open(render())(); expect(send).not.toHaveBeenCalled(); expect(window.confirm).not.toHaveBeenCalled();
    const tree = render(), region = elements(tree).find(element => element.props.role === "region")!;
    const html = renderToStaticMarkup(region);
    expect(html).toContain("aria-labelledby="); expect(html).toContain("aria-describedby=");
    expect(html).toContain(source.sourceTitle); expect(html).toContain(source.sourceId!);
    expect(html).toContain("The action itself is free.");
    expect(html).toContain("public facts and updates remain unapproved");
    expect(html).toContain("any later detected change still follows the separately capped review lane.");
    expect(button(tree, "Cancel").props.autoFocus).toBe(true);
    expect(button(tree, "Verify & restore monitoring").props.disabled).toBe(true);
    expect(button(tree, "Retire source").props.disabled).toBe(true);
  });

  it("cancels with zero requests and returns focus only after the trigger is enabled", async () => {
    await open(render())(); const staleConfirm = confirm(render()); await cancel(render())(); await staleConfirm();
    expect(send).not.toHaveBeenCalled(); expect(trigger.disabled).toBe(true); expect(trigger.focus).not.toHaveBeenCalled();
    expect(elements(render()).some(element => element.props.role === "region")).toBe(false);
    expect(trigger.disabled).toBe(false); expect(trigger.focus).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain("Cancelled. No request was sent.");
    render(); expect(trigger.focus).toHaveBeenCalledTimes(1);
  });

  it("uses Escape for the same cancellation, ignoring other keys", async () => {
    await open(render())(); const region = elements(render()).find(element => element.props.role === "region")!;
    const preventDefault = vi.fn(); region.props.onKeyDown!({ key: "Enter", preventDefault });
    expect(preventDefault).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    region.props.onKeyDown!({ key: "Escape", preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
    render(); expect(trigger.focus).toHaveBeenCalledOnce();
  });

  it("sends exactly the unchanged authenticated API request only after Confirm", async () => {
    await open(render())(); await confirm(render())();
    expect(send).toHaveBeenCalledExactlyOnceWith(`/api/admin/page-issues/${source.sourceId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "restore" }),
    });
    expect(hooks.refresh).toHaveBeenCalledOnce(); expect(trigger.focus).not.toHaveBeenCalled();
    expect(text(render())).toContain("Monitoring restored."); expect(trigger.focus).toHaveBeenCalledOnce();
  });

  it("consumes confirmation once before rendering and prevents duplicate requests during flight", async () => {
    let finish!: (value: unknown) => void;
    send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const originalOpen = open(render()); await originalOpen(); const approve = confirm(render());
    const first = approve(), duplicate = approve(); await originalOpen();
    expect(send).toHaveBeenCalledOnce();
    expect(button(render(), "Verifying restoration").props.disabled).toBe(true);
    finish({ ok: true, json: async () => ({ monitoring: { allowed: true } }) });
    await Promise.all([first, duplicate]); await approve(); expect(send).toHaveBeenCalledOnce();
  });

  it("does not let an old Cancel or Confirm consume a later confirmation", async () => {
    const reopen = open(render()); await reopen(); const oldCancel = cancel(render()), oldConfirm = confirm(render());
    await oldCancel(); await reopen(); await oldCancel(); await oldConfirm();
    expect(send).not.toHaveBeenCalled(); await confirm(render())(); expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    ["ID", { sourceId: "33333333-3333-4333-8333-333333333333" }],
    ["title", { sourceTitle: "A different source title" }],
    ["mode", { mode: "active" as const }],
    ["removed source", { sourceId: null }],
  ])("refuses old handlers after the source %s context changes", async (_label, changed) => {
    const oldOpen = open(render()); await oldOpen(); const approve = confirm(render()), abort = cancel(render());
    render({ ...source, ...changed }); await approve(); await abort(); await oldOpen();
    expect(send).not.toHaveBeenCalled(); expect(hooks.refresh).not.toHaveBeenCalled(); expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("does not resurrect a discarded confirmation when props later return to their original values", async () => {
    await open(render())(); const approve = confirm(render());
    render({ ...source, sourceTitle: "Refreshed title" }); render(); await approve();
    expect(send).not.toHaveBeenCalled(); expect(elements(render()).some(element => element.props.role === "region")).toBe(false);
  });

  it.each([
    ["ID", { sourceId: "33333333-3333-4333-8333-333333333333" }],
    ["title", { sourceTitle: "Changed source title" }],
    ["mode", { mode: "active" as const }],
  ])("refuses stale %s-context controls during committed remount BEFORE passive cleanup", async (_label, changed) => {
    const oldOpen = open(render()); await oldOpen(); const tree = render();
    const oldConfirm = confirm(tree), oldCancel = cancel(tree);
    expect(hooks.stores.wrapper.effects.map(effect => effect.phase)).toEqual(["layout"]);
    expect(hooks.stores[currentStore!].effects.map(effect => effect.phase)).toEqual(["layout", "passive"]);
    const refreshed = { ...source, ...changed }, committed = render(refreshed, { deferPassive: true });
    expect(passivePhase.length).toBeGreaterThan(0);
    await oldConfirm(); await oldCancel(); await oldOpen();
    expect(send).not.toHaveBeenCalled(); expect(hooks.refresh).not.toHaveBeenCalled(); expect(trigger.focus).not.toHaveBeenCalled();
    expect(elements(committed).some(element => element.props.role === "region")).toBe(false);
    flushPassivePhase(); expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("refuses pre-confirmation handlers after unmount", async () => {
    const oldOpen = open(render()); await oldOpen(); const approve = confirm(render()); unmount();
    await approve(); await oldOpen(); expect(send).not.toHaveBeenCalled(); expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("retains the flight guard across a keyed prop refresh and ignores the old response", async () => {
    let finish!: (value: unknown) => void;
    send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await open(render())(); const pending = confirm(render())();
    const refreshed = { ...source, sourceTitle: "Refreshed source title" };
    const busyTree = render(refreshed);
    expect(button(busyTree, "Verifying restoration").props.disabled).toBe(true);
    expect(button(busyTree, "Retire source").props.disabled).toBe(true);
    await button(busyTree, "Verifying restoration").props.onClick!(); expect(send).toHaveBeenCalledOnce();
    expect(elements(render(refreshed)).some(element => element.props.role === "region")).toBe(false);
    finish({ ok: true, json: async () => ({ monitoring: { allowed: true }, message: "Old response" }) }); await pending;
    expect(hooks.refresh).not.toHaveBeenCalled(); expect(text(render(refreshed))).not.toContain("Old response");
    expect(button(render(refreshed), "Verify & restore monitoring").props.disabled).toBe(false);
    await open(render(refreshed))(); await confirm(render(refreshed))(); expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["ID", { sourceId: "33333333-3333-4333-8333-333333333333" }],
    ["title", { sourceTitle: "New title while the request runs" }],
    ["mode", { mode: "active" as const }],
  ])("keeps %s-remounted controls visibly busy and re-enables them when the old request settles", async (_label, changed) => {
    let finish!: (value: unknown) => void;
    send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await open(render())(); const pending = confirm(render())();
    const refreshed = { ...source, ...changed }, busyTree = render(refreshed);
    expect(elements(busyTree).filter(element => element.type === "button").every(element => element.props.disabled)).toBe(true);
    finish({ ok: true, json: async () => ({ monitoring: { allowed: true }, message: "Stale message" }) }); await pending;
    const settledTree = render(refreshed);
    expect(elements(settledTree).filter(element => element.type === "button").every(element => element.props.disabled === false)).toBe(true);
    expect(text(settledTree)).not.toContain("Stale message"); expect(hooks.refresh).not.toHaveBeenCalled();
    expect(trigger.focus).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledOnce();
  });

  it("does not update or refresh an unmounted control after an already-sent request", async () => {
    let finish!: (value: unknown) => void;
    send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await open(render())(); const pending = confirm(render())();
    expect(hooks.stores.wrapper.values[0]).toBe("restore"); unmount();
    finish({ ok: true, json: async () => ({ monitoring: { allowed: true } }) }); await pending;
    expect(send).toHaveBeenCalledOnce(); expect(hooks.refresh).not.toHaveBeenCalled(); expect(trigger.focus).not.toHaveBeenCalled();
    expect(hooks.stores.wrapper.values[0]).toBe("restore");
  });

  it("rejects an old response BEFORE remount passive cleanup while releasing shared busy state", async () => {
    let finish!: (value: unknown) => void;
    send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await open(render())(); const discardedStore = currentStore!, pending = confirm(render())();
    const refreshed = { ...source, sourceTitle: "Committed new title" };
    expect(button(render(refreshed, { deferPassive: true }), "Retire source").props.disabled).toBe(true);
    expect(passivePhase.length).toBeGreaterThan(0);
    finish({ ok: true, json: async () => ({ monitoring: { allowed: true }, message: "Discarded response" }) }); await pending;
    expect(hooks.stores[discardedStore].values[0]).toBe(""); expect(hooks.refresh).not.toHaveBeenCalled();
    const settled = render(refreshed, { deferPassive: true });
    expect(button(settled, "Retire source").props.disabled).toBe(false);
    expect(text(settled)).not.toContain("Discarded response"); expect(trigger.focus).not.toHaveBeenCalled();
    flushPassivePhase(); expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("refuses wrapper setters and old responses after full unmount BEFORE passive cleanup", async () => {
    let finish!: (value: unknown) => void;
    send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await open(render())(); const discardedStore = currentStore!, pending = confirm(render())();
    unmount({ deferPassive: true }); expect(passivePhase.length).toBeGreaterThan(0);
    finish({ ok: true, json: async () => ({ monitoring: { allowed: true }, message: "Unmounted response" }) }); await pending;
    expect(hooks.stores.wrapper.values[0]).toBe("restore"); expect(hooks.stores[discardedStore].values[0]).toBe("");
    expect(hooks.refresh).not.toHaveBeenCalled(); expect(trigger.focus).not.toHaveBeenCalled();
    flushPassivePhase(); expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("releases remounted busy controls after a failed old request without copying its error", async () => {
    let fail!: (reason: Error) => void;
    send.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    await open(render())(); const pending = confirm(render())();
    const refreshed = { ...source, sourceTitle: "Refreshed context" };
    expect(button(render(refreshed), "Retire source").props.disabled).toBe(true);
    fail(new Error("Error from the discarded context")); await pending;
    expect(button(render(refreshed), "Retire source").props.disabled).toBe(false);
    expect(text(render(refreshed))).not.toContain("Error from the discarded context");
    expect(hooks.refresh).not.toHaveBeenCalled(); expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("keeps shared busy state when the source disappears and returns during the request", async () => {
    let finish!: (value: unknown) => void;
    send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await open(render())(); const pending = confirm(render())();
    expect(render({ ...source, sourceId: null })).toBe(null);
    expect(button(render(), "Retire source").props.disabled).toBe(true);
    finish({ ok: true, json: async () => ({ monitoring: { allowed: true } }) }); await pending;
    expect(button(render(), "Retire source").props.disabled).toBe(false);
    expect(hooks.refresh).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    ["server error", { ok: false, json: async () => ({ error: "Source changed. Refresh first." }) }, "Source changed. Refresh first."],
    ["unconfirmed restoration", { ok: true, json: async () => ({ monitoring: { allowed: false } }) }, "AwardPing did not confirm that monitoring resumed."],
    ["invalid response", { ok: true, json: async () => { throw new Error("invalid JSON"); } }, "AwardPing did not confirm that monitoring resumed."],
  ])("retains %s without retrying or reopening confirmation", async (_label, response, expected) => {
    send.mockResolvedValue(response); await open(render())(); await confirm(render())();
    expect(send).toHaveBeenCalledOnce(); expect(hooks.refresh).not.toHaveBeenCalled();
    expect(text(render())).toContain(expected); expect(trigger.focus).toHaveBeenCalledOnce();
    expect(elements(render()).some(element => element.props.role === "region")).toBe(false);
  });

  it("retains a transport failure without automatic retry", async () => {
    send.mockRejectedValue(new Error("Synthetic offline failure")); await open(render())(); await confirm(render())();
    expect(send).toHaveBeenCalledOnce(); expect(text(render())).toContain("Synthetic offline failure");
    expect(hooks.refresh).not.toHaveBeenCalled(); expect(trigger.focus).toHaveBeenCalledOnce();
  });

  it.each(["disconnected", "disabled"])("does not focus a %s trigger or retry focus later", async reason => {
    await open(render())(); await cancel(render())();
    if (reason === "disconnected") trigger.isConnected = false; else trigger.disabledByAncestor = true;
    render(); expect(trigger.focus).not.toHaveBeenCalled();
    trigger.isConnected = true; trigger.disabledByAncestor = false; render(); expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("does not steal focus from a newly opened confirmation before commit", async () => {
    const reopen = open(render()); await reopen(); await cancel(render())(); await reopen();
    expect(elements(render()).some(element => element.props.role === "region")).toBe(true);
    expect(trigger.focus).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it("supports a StrictMode-style mount effect cleanup/setup without a request", async () => {
    render(); const effects = [...hooks.stores.wrapper.effects, ...hooks.stores[currentStore!].effects];
    effects.forEach(effect => effect.cleanup?.());
    effects.forEach(effect => { const cleanup = effect.callback(); effect.cleanup = typeof cleanup === "function" ? cleanup : undefined; });
    await open(render())(); expect(send).not.toHaveBeenCalled(); await confirm(render())(); expect(send).toHaveBeenCalledOnce();
  });

  it("keeps the existing Review later prompt and PATCH unchanged", async () => {
    const context = { ...source, mode: "active" as const };
    vi.mocked(window.prompt).mockReturnValue("Synthetic operator note");
    await button(render(context), "Review later").props.onClick!();
    expect(window.prompt).toHaveBeenCalledExactlyOnceWith("Optional note explaining why this source should leave monitoring:", "");
    expect(send).toHaveBeenCalledExactlyOnceWith(`/api/admin/page-issues/${source.sourceId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "review_later", note: "Synthetic operator note" }),
    });
  });

  it("keeps Retire's native confirmation and DELETE unchanged", async () => {
    vi.mocked(window.confirm).mockReturnValue(true); await button(render(), "Retire source").props.onClick!();
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith(
      `Retire this source from AwardPing?\n\n${source.sourceTitle}\n\nThis removes it from active monitoring and linked watchlists. Published updates and immutable visual evidence are preserved.`,
    );
    expect(send).toHaveBeenCalledExactlyOnceWith(`/api/admin/page-issues/${source.sourceId}`, {
      method: "DELETE", headers: undefined, body: undefined,
    });
  });
});
