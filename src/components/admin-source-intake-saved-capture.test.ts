import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Actual component callbacks with synchronous hook doubles, never a browser,
// live request, storage verifier or claim that server authorization succeeded.
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
  normalized_url: "https://example.org/exact-source", intake_type: "official_source", status: "needs_manual_review",
  status_reason: "intake_local_conflict", detected_award_name: null, detected_sponsor: null,
  matched_shared_award_id: "22222222-2222-4222-8222-222222222222", created_shared_award_id: null,
  created_source_ids: null, ai_review: { preserved: "prior result" }, capture_metadata: { status: "failed", captured_at: "2026-10-19T10:00:00.000Z" },
  acquisition_kind: "admin_intake", notification_mode: "baseline_only", onboarding_batch_id: null,
  deterministic_review: {}, error: "Synthetic saved identity collision", worker_run_id: null,
  created_at: "2026-10-18T00:00:00.000Z", updated_at: "2026-10-19T18:15:16.360Z", processed_at: null,
};
const originalMetadata = { status: "completed", captured_at: "2026-10-18T10:00:00.000Z", intake_artifact: { manifest: "synthetic-original-only" } };
const initialRows = [request];
type Props = {
  children?: ReactNode; role?: string; disabled?: boolean; autoFocus?: boolean; readOnly?: boolean; value?: string; maxLength?: number;
  onClick?: () => void | Promise<void>; onChange?: (event: { target: { value: string } }) => void;
  onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
  onAction?: (id: string, action: SourceIntakeOperatorAction, sharedAwardId?: string) => Promise<void>;
  onRestoreSavedCapture?: (id: string) => void;
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
class FakeElement {
  focus = vi.fn(); isConnected = true; disabled = false;
  matches = (selector: string) => selector === ":disabled" && this.disabled;
}
let trigger: FakeElement;
let send: ReturnType<typeof vi.fn>;
function render(rows = initialRows) {
  hooks.cursor = 0; hooks.refCursor = 0; hooks.effectCursor = 0;
  const tree = AdminSourceIntakePanel({ initialRequests: rows, awardOptions: [] });
  trigger.disabled = Boolean(row(tree)?.props.actionBusy);
  hooks.pendingEffects.splice(0).forEach(effect => effect());
  return tree;
}
function row(tree: ReactNode) { return elements(tree).find(element => element.props.request?.id === request.id); }
function button(tree: ReactNode, label: string) {
  const found = elements(tree).find(element => element.type === "button" && text(element.props.children) === label);
  expect(found, label).toBeTruthy(); return found!;
}
function editor(tree: ReactNode) {
  const found = elements(tree).find(element => element.type === "textarea" && element.props.maxLength === 128 * 1024);
  expect(found).toBeTruthy(); return found!;
}
function open(tree = render()) { expect(row(tree)?.props.onRestoreSavedCapture).toBeTypeOf("function"); row(tree)!.props.onRestoreSavedCapture!(request.id); }
function paste(value: string, tree = render()) { editor(tree).props.onChange!({ target: { value } }); }
function preview(rows = initialRows) { button(render(rows), "Review saved capture restore").props.onClick!(); }
function confirm(tree = render()) { return button(tree, "Confirm restore — keep held").props.onClick!; }
function ready() { open(); paste(JSON.stringify(originalMetadata)); preview(); return render(); }
function renderedRow(rows = initialRows) {
  const element = row(render(rows))!;
  // Isolate the row's existing selection state from panel hook slots.
  hooks.cursor = 100;
  return (element.type as (props: Props) => ReactNode)(element.props);
}

beforeEach(() => {
  hooks.values = []; hooks.refs = []; hooks.cursor = 0; hooks.refCursor = 0;
  hooks.effects = []; hooks.effectCursor = 0; hooks.pendingEffects = [];
  trigger = new FakeElement();
  vi.stubGlobal("HTMLElement", FakeElement); vi.stubGlobal("document", { activeElement: trigger });
  vi.stubGlobal("window", { confirm: vi.fn(() => { throw new Error("native_dialog_forbidden"); }) });
  send = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ request: { ...request, capture_metadata: originalMetadata,
    status_reason: "saved_original_capture_restored_manual_review", updated_at: "2026-10-20T00:00:00.000Z" } }) });
  vi.stubGlobal("fetch", send);
});
afterEach(() => { expect(window.confirm).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("advanced saved-capture restoration is separate from paid review", () => {
  it.each(["failed", "needs_manual_review"] as const)("offers the advanced action only for an idle %s conflict", status => {
    const tree = renderedRow([{ ...request, status }]);
    const details = elements(tree).find(element => element.type === "details")!;
    expect(text(details)).toContain("Advanced recovery");
    expect(button(details, "Restore saved capture — no AI charge").props.disabled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { status: "queued" }, { status: "captured" }, { status: "ai_review_submitted" }, { status: "added" }, { status: "rejected" },
    { status_reason: "invalid_fact_type_facts" }, { status_reason: null }, { worker_run_id: "active-worker" },
  ] as Partial<SourceIntakeRequestView>[])("does not offer or open recovery for an ineligible row %j", change => {
    const rows = [{ ...request, ...change }];
    expect(elements(renderedRow(rows)).some(element => element.type === "details")).toBe(false);
    open(render(rows));
    expect(elements(render(rows)).some(element => element.props.role === "region")).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("treats missing client claim data only as a candidate; server verification remains explicit", () => {
    const withoutClaim = { ...request };
    delete withoutClaim.worker_run_id;
    open(render([withoutClaim]));
    const tree = render([withoutClaim]), region = elements(tree).find(element => element.props.role === "region")!;
    expect(renderToStaticMarkup(region)).toContain("The server verifies the saved objects");
    expect(send).not.toHaveBeenCalled();
  });

  it("opens an accessible exact-request form and requires parsing plus explicit confirmation", () => {
    open();
    let tree = render();
    const region = elements(tree).find(element => element.props.role === "region")!;
    const html = renderToStaticMarkup(region);
    expect(html).toContain('aria-labelledby="saved-capture-heading"');
    expect(html).toContain('aria-describedby="saved-capture-warning"');
    expect(html).toContain(request.id); expect(html).toContain(request.normalized_url);
    expect(html).toContain("ORIGINAL completed capture_metadata"); expect(html).toContain("newer failed capture");
    expect(html).toContain("no live page fetch"); expect(html).toContain("source approval or publication");
    expect(html).toContain("separate action and confirmation");
    expect(button(tree, "Cancel").props.autoFocus).toBe(true);
    expect(elements(tree).some(element => element.type === "button" && text(element.props.children) === "Confirm restore — keep held")).toBe(false);
    paste(JSON.stringify(originalMetadata)); preview(); tree = render();
    expect(editor(tree).props.readOnly).toBe(true); expect(send).not.toHaveBeenCalled();
    expect(button(tree, "Queue intake").props.disabled).toBe(true);
    expect(row(tree)?.props.actionBusy).toBe(true);
  });

  it.each(["", "{secret-invalid", "null", "[]", "1", "true", '"page body"'])("rejects invalid/nonobject JSON locally: %j", value => {
    open(); paste(value); preview();
    expect(send).not.toHaveBeenCalled();
    expect(elements(render()).some(element => element.type === "button" && text(element.props.children) === "Confirm restore — keep held")).toBe(false);
    expect(text(render())).not.toContain("secret-invalid");
  });

  it("accepts exactly128KiB but rejects larger ASCII and UTF8 pastes without retaining them", () => {
    open(); const exact = JSON.stringify({ pad: "a".repeat(128 * 1024 - 10) });
    expect(new TextEncoder().encode(exact).byteLength).toBe(128 * 1024);
    paste(exact + " "); expect(editor(render()).props.value).toBe("");
    const multibyte = JSON.stringify({ pad: "é".repeat(70_000) });
    expect(multibyte.length).toBeLessThan(128 * 1024);
    paste(multibyte); expect(editor(render()).props.value).toBe("");
    expect(text(render())).toContain("no larger than 128 KiB");
    paste(exact); preview(); expect(editor(render()).props.readOnly).toBe(true); expect(send).not.toHaveBeenCalled();
  });

  it("uses homepage URL only when the exact normalized URL is absent", () => {
    const rows = [{ ...request, normalized_url: null }]; open(render(rows));
    expect(renderToStaticMarkup(elements(render(rows)).find(element => element.props.role === "region")!)).toContain(request.homepage_url);
  });

  it("sends the original object and exact observed version only after confirmation, then stays held", async () => {
    const tree = ready(); await confirm(tree)();
    expect(send).toHaveBeenCalledExactlyOnceWith(`/api/admin/source-intake/${request.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restore_saved_capture", savedCaptureMetadata: originalMetadata, expectedUpdatedAt: request.updated_at }),
    });
    const refreshed = row(render())!.props.request!;
    expect(refreshed.status).toBe("needs_manual_review");
    expect(refreshed.capture_metadata).toEqual(originalMetadata); expect(refreshed.ai_review).toEqual(request.ai_review);
    expect(text(render())).toContain("The request stays held; AI review is a separate action.");
    expect(elements(render()).some(element => element.props.role === "region")).toBe(false);
    expect(trigger.focus).toHaveBeenCalledTimes(1);
  });

  it.each(["Cancel", "Escape"])("%s sends nothing and consumes stale confirmation", async method => {
    const tree = ready(), stale = confirm(tree);
    if (method === "Cancel") button(tree, "Cancel").props.onClick!();
    else { const preventDefault = vi.fn(); elements(tree).find(element => element.props.role === "region")!.props.onKeyDown!({ key: "Escape", preventDefault }); expect(preventDefault).toHaveBeenCalledOnce(); }
    await stale(); render();
    expect(send).not.toHaveBeenCalled(); expect(trigger.focus).toHaveBeenCalledOnce();
  });

  it("does not allow old edit/preview/cancel controls to change a new recovery session", () => {
    open(); const old = render(), oldEdit = editor(old).props.onChange!, oldPreview = button(old, "Review saved capture restore").props.onClick!, oldCancel = button(old, "Cancel").props.onClick!;
    oldCancel(); open(render());
    oldEdit({ target: { value: JSON.stringify(originalMetadata) } }); oldPreview(); oldCancel();
    expect(editor(render()).props.value).toBe(""); expect(elements(render()).some(element => element.props.role === "region")).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("locks paid/free/intake actions and consumes confirmation synchronously during a restoration", async () => {
    let complete!: (value: unknown) => void; send.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const tree = ready(), restore = confirm(tree), first = restore(), second = restore();
    const next = render();
    row(next)!.props.onRestoreSavedCapture!(request.id);
    await row(next)!.props.onAction!(request.id, "rerun_ai_review"); await row(next)!.props.onAction!(request.id, "reject");
    await button(next, "Queue intake").props.onClick!();
    expect(send).toHaveBeenCalledTimes(1); expect(row(next)?.props.actionBusy).toBe(true);
    complete({ ok: true, json: async () => ({ request: { ...request, status_reason: "saved_original_capture_restored_manual_review" } }) });
    await Promise.all([first, second]); await restore();
    expect(send).toHaveBeenCalledTimes(1); expect(row(render())?.props.actionBusy).toBe(false);
  });

  it("does not allow paid/free actions while the restoration form is open", async () => {
    open(); const tree = render();
    await row(tree)!.props.onAction!(request.id, "retry"); await row(tree)!.props.onAction!(request.id, "reject");
    await button(tree, "Dry-run validate").props.onClick!();
    expect(send).not.toHaveBeenCalled();
    expect(elements(render()).filter(element => element.props.role === "region")).toHaveLength(1);
  });

  it.each([
    { updated_at: "2026-10-20T00:00:00.000Z" }, { normalized_url: "https://example.org/other" },
    { status: "captured" }, { capture_metadata: { changed: true } }, { worker_run_id: "new-claim" },
  ] as Partial<SourceIntakeRequestView>[])("refuses a changed local request before confirmation %j", async change => {
    ready(); hooks.values[4] = [{ ...request, ...change }]; await confirm(render())();
    expect(send).not.toHaveBeenCalled(); expect(text(render())).toContain("This request changed.");
  });

  it("refuses changed or removed server props and refuses refreshed props before opening", async () => {
    ready(); await confirm(render([]))(); expect(send).not.toHaveBeenCalled();
    open(render([{ ...request, updated_at: "2026-10-20T00:00:00.000Z" }]));
    expect(elements(render()).some(element => element.props.role === "region")).toBe(false);
    expect(text(render())).toContain("This request was refreshed.");
  });

  it("displays an escaped server rejection without a second request or metadata logging", async () => {
    send.mockResolvedValue({ ok: false, json: async () => ({ error: "Saved original mismatch <script>not-run</script>" }) });
    await confirm(ready())();
    expect(send).toHaveBeenCalledTimes(1); expect(text(render())).toContain("Saved original mismatch");
    const status = elements(render()).find(element => element.props.role === "status")!;
    expect(renderToStaticMarkup(status)).toContain("&lt;script&gt;not-run&lt;/script&gt;");
    expect(row(render())?.props.request?.capture_metadata).toEqual(request.capture_metadata);
    expect(row(render())?.props.actionBusy).toBe(false);
  });

  it("shows a generic transport failure without exposing pasted content or retrying", async () => {
    send.mockRejectedValue(new Error("sensitive transport content")); await confirm(ready())();
    expect(send).toHaveBeenCalledTimes(1); expect(text(render())).toContain("could not be restored");
    expect(text(render())).not.toContain("sensitive transport content");
    expect(text(render())).not.toContain("synthetic-original-only");
  });
});
