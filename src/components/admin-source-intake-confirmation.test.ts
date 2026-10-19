import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the actual callbacks bound by the component, with synchronous hook
// state/ref doubles. This is not a browser focus, hydration or keyboard test.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0,
  effects: [] as { dependencies: unknown[]; callback: () => void }[], effectCursor: 0, pendingEffects: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (next: unknown) => {
        hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
      }];
    },
    useMemo: (calculate: () => unknown) => calculate(),
    useRef: (initial: unknown) => { const index = hooks.refCursor++; hooks.refs[index] ??= { current: initial }; return hooks.refs[index]; },
    useEffect: (callback: () => void, dependencies: unknown[]) => {
      const index = hooks.effectCursor++, previous = hooks.effects[index];
      if (!previous || dependencies.some((value, position) => !Object.is(value, previous.dependencies[position]))) hooks.pendingEffects.push(callback);
      hooks.effects[index] = { dependencies, callback };
    },
  };
});

import { AdminSourceIntakePanel, type SourceIntakeRequestView } from "@/components/admin-source-intake-panel";
import type { SourceIntakeOperatorAction } from "@/lib/source-intake-operator-actions";

const request: SourceIntakeRequestView = {
  id: "11111111-1111-4111-8111-111111111111", award_name: "Synthetic award", homepage_url: "https://example.org/award",
  normalized_url: "https://example.org/award", intake_type: "official_source", status: "needs_manual_review",
  status_reason: "missing_evidence_quotes", detected_award_name: null, detected_sponsor: null,
  matched_shared_award_id: "22222222-2222-4222-8222-222222222222", created_shared_award_id: null,
  created_source_ids: null, ai_review: {}, capture_metadata: {}, acquisition_kind: "admin_intake",
  notification_mode: "baseline_only", onboarding_batch_id: null, deterministic_review: {}, error: null,
  created_at: "2026-10-18T00:00:00.000Z", updated_at: "2026-10-19T18:15:16.360Z", processed_at: null,
};
type Props = {
  children?: ReactNode; role?: string; disabled?: boolean; autoFocus?: boolean;
  onClick?: () => void | Promise<void>;
  onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
  onAction?: (id: string, action: SourceIntakeOperatorAction, sharedAwardId?: string) => Promise<void>;
  request?: SourceIntakeRequestView; actionBusy?: boolean;
};
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return isValidElement<Props>(node) ? [node, ...elements(node.props.children)] : [];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<Props>(node) ? text(node.props.children) : "";
}
const initialRows = [request];
function render(rows = initialRows) {
  hooks.cursor = 0; hooks.refCursor = 0; hooks.effectCursor = 0;
  const tree = AdminSourceIntakePanel({ initialRequests: rows, awardOptions: [{ id: request.matched_shared_award_id!, name: "Bound award", slug: null }] });
  // Simulate DOM commit before running passive effects. Native DOM/focus itself
  // is deliberately not claimed: these are only recording, ordered doubles.
  trigger.disabled = Boolean(elements(tree).find(element => element.props.request?.id === request.id)?.props.actionBusy);
  const pending = hooks.pendingEffects.splice(0); pending.forEach(effect => effect());
  return tree;
}
function rowAction(tree: ReactNode) {
  const row = elements(tree).find(element => element.props.request?.id === request.id);
  expect(row?.props.onAction).toBeTypeOf("function");
  return row!.props.onAction!;
}
function button(tree: ReactNode, label: string) {
  const found = elements(tree).find(element => element.type === "button" && text(element.props.children) === label);
  expect(found, label).toBeTruthy(); return found!;
}
const confirm = (tree: ReactNode) => button(tree, "Confirm this paid retry").props.onClick!;
const cancel = (tree: ReactNode) => button(tree, "Cancel").props.onClick!;
class FakeElement {
  focus = vi.fn(); isConnected = true; disabled = false; disabledByAncestor = false;
  matches = (selector: string) => selector === ":disabled" && (this.disabled || this.disabledByAncestor);
}
let trigger: FakeElement;
let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hooks.values = []; hooks.refs = []; hooks.cursor = 0; hooks.refCursor = 0;
  hooks.effects = []; hooks.effectCursor = 0; hooks.pendingEffects = [];
  trigger = new FakeElement();
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("document", { activeElement: trigger });
  vi.stubGlobal("window", { confirm: vi.fn(() => { throw new Error("native_dialog_forbidden"); }) });
  send = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ request: { ...request, status: "queued" }, message: "Queued once." }) });
  vi.stubGlobal("fetch", send);
});
afterEach(() => { expect(window.confirm).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("paid source retry requires an exact in-page confirmation", () => {
  it.each(["retry", "rerun_capture", "rerun_ai_review"] as const)("does not send %s before explicit confirmation", async action => {
    await rowAction(render())(request.id, action);
    expect(send).not.toHaveBeenCalled();
    const tree = render(), region = elements(tree).find(element => element.props.role === "region")!;
    const html = renderToStaticMarkup(region);
    expect(html).toContain('aria-labelledby="paid-retry-heading"');
    expect(html).toContain('aria-describedby="paid-retry-warning"');
    expect(html).toContain("This retry may create a Gemini charge in the $5/day new-page review lane. Continue with exactly this request?");
    expect(html).toContain(request.id); expect(html).toContain(request.normalized_url);
    expect(html).toContain(`Bound award (${request.matched_shared_award_id})`);
    expect(html).toContain(action.replace(/_/g, " ").replace(/\b\w/g, value => value.toUpperCase()));
    expect(button(tree, "Cancel").props.autoFocus).toBe(true);
    expect(elements(tree).find(element => element.props.request?.id === request.id)?.props.actionBusy).toBe(true);
    expect(button(tree, "Queue intake").props.disabled).toBe(true);
  });

  it("cancels without a request and restores the initiating control focus", async () => {
    await rowAction(render())(request.id, "rerun_ai_review");
    const staleConfirm = confirm(render());
    await cancel(render())();
    await staleConfirm();
    expect(send).not.toHaveBeenCalled(); expect(trigger.disabled).toBe(true); expect(trigger.focus).not.toHaveBeenCalled();
    expect(elements(render()).some(element => element.props.role === "region")).toBe(false);
    expect(trigger.disabled).toBe(false); expect(trigger.focus).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain("Cancelled. No request was sent.");
    render(); expect(trigger.focus).toHaveBeenCalledTimes(1);
  });

  it("binds Escape to the same no-request cancellation", async () => {
    await rowAction(render())(request.id, "retry");
    const region = elements(render()).find(element => element.props.role === "region")!;
    const preventDefault = vi.fn(); region.props.onKeyDown!({ key: "Escape", preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
    expect(trigger.focus).not.toHaveBeenCalled(); render();
    expect(trigger.focus).toHaveBeenCalledTimes(1);
  });

  it("confirms exactly the displayed request, action and supplied award once", async () => {
    await rowAction(render())(request.id, "rerun_ai_review", request.matched_shared_award_id!);
    await confirm(render())();
    expect(trigger.focus).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith(`/api/admin/source-intake/${request.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rerun_ai_review", sharedAwardId: request.matched_shared_award_id }),
    });
    expect(text(render())).toContain("Queued once."); expect(trigger.focus).toHaveBeenCalledTimes(1);
  });

  it("consumes confirmation synchronously and locks all actions during the request", async () => {
    let complete!: (value: unknown) => void;
    send.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const action = rowAction(render());
    await action(request.id, "retry");
    const approve = confirm(render()), first = approve(), second = approve();
    await action(request.id, "rerun_ai_review"); await action(request.id, "reject");
    expect(send).toHaveBeenCalledTimes(1);
    expect(elements(render()).find(element => element.props.request?.id === request.id)?.props.actionBusy).toBe(true);
    complete({ ok: true, json: async () => ({ request: { ...request, status: "queued" } }) });
    await Promise.all([first, second]); expect(send).toHaveBeenCalledTimes(1);
    await approve(); expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not replace an outstanding approval with a different request or action", async () => {
    const action = rowAction(render());
    await action(request.id, "retry");
    await action("33333333-3333-4333-8333-333333333333", "rerun_ai_review");
    await action(request.id, "reject");
    expect(send).not.toHaveBeenCalled(); await confirm(render())();
    expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({ action: "retry" });
    expect(send.mock.calls[0][0]).toBe(`/api/admin/source-intake/${request.id}`);
  });

  it.each([
    ["status", { status: "ai_review_submitted" }],
    ["updated version", { updated_at: "2026-10-19T19:00:00.000Z" }],
    ["source", { normalized_url: "https://example.org/other" }],
    ["award", { matched_shared_award_id: null }],
    ["retained capture", { capture_metadata: { capture_file_hash: "changed" } }],
  ] as const)("holds when the current local %s changes before confirmation", async (_label, change) => {
    await rowAction(render())(request.id, "retry");
    hooks.values[4] = [{ ...request, ...change }];
    await confirm(render())();
    expect(send).not.toHaveBeenCalled(); expect(text(render())).toContain("This request changed.");
  });

  it("holds when refreshed props change the request or remove it", async () => {
    await rowAction(render())(request.id, "retry");
    await confirm(render([]))(); expect(send).not.toHaveBeenCalled();
    expect(text(render())).toContain("This request changed.");
  });

  it("holds when the current server-provided version changes without replacing local state", async () => {
    await rowAction(render())(request.id, "retry");
    await confirm(render([{ ...request, updated_at: "2026-10-19T20:00:00.000Z", status: "queued" }]))();
    expect(send).not.toHaveBeenCalled(); expect(text(render())).toContain("This request changed.");
  });

  it.each([
    ["version", { updated_at: "2026-10-19T20:00:00.000Z" }],
    ["source", { normalized_url: "https://example.org/other" }],
    ["award", { matched_shared_award_id: null }],
    ["capture", { capture_metadata: { capture_file_hash: "changed" } }],
  ] as const)("holds refreshed %s props BEFORE opening even when status is unchanged", async (_label, change) => {
    render();
    const refreshed = [{ ...request, ...change }], tree = render(refreshed);
    await rowAction(tree)(request.id, "retry");
    expect(send).not.toHaveBeenCalled();
    expect(text(render(refreshed))).toContain("This request was refreshed.");
    expect(elements(render(refreshed)).some(element => element.props.role === "region")).toBe(false);
  });

  it.each([
    ["source", { normalized_url: "https://example.org/other" }],
    ["award", { matched_shared_award_id: null }],
    ["capture", { capture_metadata: { capture_file_hash: "changed" } }],
  ] as const)("holds same-status refreshed %s props AFTER opening", async (_label, change) => {
    await rowAction(render())(request.id, "retry");
    await confirm(render([{ ...request, ...change }]))();
    expect(send).not.toHaveBeenCalled(); expect(text(render())).toContain("This request changed.");
  });

  it("allows another explicit paid approval after an acknowledged local PATCH with unchanged original props", async () => {
    const newer = { ...request, updated_at: "2026-10-19T20:00:00.000Z", error: "New local response" };
    send.mockResolvedValue({ ok: true, json: async () => ({ request: newer }) });
    await rowAction(render())(request.id, "retry"); await confirm(render())();
    expect(send).toHaveBeenCalledTimes(1);
    await rowAction(render())(request.id, "rerun_ai_review");
    expect(send).toHaveBeenCalledTimes(1);
    const tree = render(); expect(elements(tree).some(element => element.props.role === "region")).toBe(true);
    await confirm(tree)(); expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[1][1].body)).toEqual({ action: "rerun_ai_review" });
  });

  it("revalidates the current operator-status guard before offering a paid retry", async () => {
    const active: SourceIntakeRequestView = { ...request, status: "ai_review_submitted" };
    await rowAction(render([active]))(request.id, "rerun_ai_review");
    expect(send).not.toHaveBeenCalled();
    expect(text(render([active]))).toContain("This request can no longer be retried.");
    expect(elements(render([active])).some(element => element.props.role === "region")).toBe(false);
  });

  it("keeps a server rejection visible without retrying or reopening approval", async () => {
    send.mockResolvedValue({ ok: false, json: async () => ({ error: "Current request already submitted." }) });
    await rowAction(render())(request.id, "retry"); await confirm(render())();
    expect(trigger.focus).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1); expect(text(render())).toContain("Current request already submitted.");
    expect(trigger.focus).toHaveBeenCalledTimes(1); render(); expect(trigger.focus).toHaveBeenCalledTimes(1);
    expect(elements(render()).some(element => element.props.role === "region")).toBe(false);
  });

  it.each(["disconnected", "disabled"])("does not restore focus to a %s trigger or retry focus later", async reason => {
    await rowAction(render())(request.id, "retry"); await cancel(render())();
    if (reason === "disconnected") trigger.isConnected = false; else trigger.disabledByAncestor = true;
    render(); expect(trigger.focus).not.toHaveBeenCalled();
    trigger.isConnected = true; trigger.disabledByAncestor = false; render(); expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("does not steal focus after unrelated refreshed props", async () => {
    const action = rowAction(render()); await action(request.id, "retry"); await cancel(render())();
    render([...initialRows]); expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("does not let an old close effect steal focus from a new confirmation", async () => {
    const action = rowAction(render()); await action(request.id, "retry"); await cancel(render())();
    // No commit between closing the old approval and opening the new one.
    await action(request.id, "rerun_ai_review");
    const tree = render(); expect(trigger.focus).not.toHaveBeenCalled();
    expect(elements(tree).some(element => element.props.role === "region")).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps free reject actions uncharged and outside the paid confirmation", async () => {
    await rowAction(render())(request.id, "reject");
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({ action: "reject" });
    expect(elements(render()).some(element => element.props.role === "region")).toBe(false);
  });
});
