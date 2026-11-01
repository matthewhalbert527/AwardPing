import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0, effects: [] as Array<() => void> }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }]; },
  useRef: (initial: unknown) => { const index = hooks.refCursor++; hooks.refs[index] ??= { current: initial }; return hooks.refs[index]; },
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
}));
import { AdminAlertReviewBoard, type AlertReview, type AlertReviewStatus } from "./admin-alert-review-board";
import type { AlertReviewLeaf, MergeOption, MergePreview } from "@/lib/alert-group-review";
type Props = { children?: ReactNode; disabled?: boolean; href?: string; onClick?: () => unknown; role?: string;
  onChange?: (event: { target: { value: string } }) => unknown; id?: string; htmlFor?: string; "aria-expanded"?: boolean; "aria-controls"?: string };
function nodes(node: ReactNode): ReactElement<Props>[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Props>(node) ? [node, ...nodes(node.props.children)] : []; }
function text(node: ReactNode): string { return typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : isValidElement<Props>(node) ? text(node.props.children) : ""; }
function button(tree: ReactNode, label: string) { const found = nodes(tree).find(node => node.type === "button" && text(node.props.children) === label); expect(found, label).toBeTruthy(); return found!; }
function fixture(status: AlertReviewStatus = "pending"): AlertReview { return { id: "11111111-1111-4111-8111-111111111111", contentHash: "a".repeat(64), awardName: "Example Scholarship", summary: "The application deadline moved to November 5.", sourceUrl: "https://example.org/award", detectedAt: "2026-10-29T12:00:00Z", status, details: [{ category: "Deadline", summary: "The closing date changed.", previous: "November 1", current: "November 5" }] }; }
let send: ReturnType<typeof vi.fn>;
let renderedProps: { initialAlerts: AlertReview[]; initialStatus: AlertReviewStatus; initialMergeOptions?: MergeOption[] } | null;
function render(alerts?: AlertReview[], status: AlertReviewStatus = "pending", options?: MergeOption[]) {
  if (alerts !== undefined || !renderedProps) renderedProps = { initialAlerts: alerts || [fixture()], initialStatus: status, initialMergeOptions: options };
  hooks.cursor = 0; hooks.refCursor = 0; return AdminAlertReviewBoard(renderedProps);
}
const response = (value: unknown, ok = true) => ({ ok, json: async () => value });
beforeEach(() => { hooks.values = []; hooks.refs = []; hooks.effects = []; hooks.cursor = 0; hooks.refCursor = 0; renderedProps = null; send = vi.fn(); vi.stubGlobal("fetch", send); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("simple outgoing alert review", () => {
  it("hides Check guidance while retaining the original proposal and approval identity", async () => {
    const alert = { ...fixture(), context: "Check the closing date and time for your application route before planning your submission." };
    const before = structuredClone(alert);
    const tree = render([alert]);
    expect(text(tree)).toContain(alert.summary);
    expect(text(tree)).not.toContain(alert.context);
    send.mockResolvedValueOnce(response({ ok: true })).mockResolvedValueOnce(response({ alerts: [] }));
    await button(tree, "Approve alert").props.onClick!();
    expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({ id: alert.id, expected_hash: alert.contentHash, action: "approve" });
    expect(alert).toEqual(before);
  });
  it.each([null, "", "x".repeat(601), { text: "Unconfirmed explanation" }])("rejects an invalid context value in a refreshed list", async context => {
    send.mockResolvedValue(response({ alerts: [{ ...fixture(), context }] }));
    await button(render(), "Refresh").props.onClick!();
    expect(text(render())).toContain("The alert list could not be confirmed");
    expect(text(render())).not.toContain("No alerts waiting for review.");
  });
  it("omits refreshed Check guidance and retains compatibility with older alerts", async () => {
    const context = "Check the current guide on the official site before relying on a saved copy.";
    send.mockResolvedValueOnce(response({ alerts: [{ ...fixture(), context }] }));
    await button(render(), "Refresh").props.onClick!();
    expect(text(render())).not.toContain(context);
    send.mockResolvedValueOnce(response({ alerts: [fixture()] }));
    await button(render(), "Refresh").props.onClick!();
    expect(text(render())).toContain(fixture().summary);
    expect(text(render())).not.toContain(context);
  });
  it.each([
    [" \t\ncHeCk the current submission instructions.", false],
    ["Checks remain distinct from application deadlines.", true],
    ["These changes are grouped for review; each retains its original source and supporting details.", true],
  ] as const)("filters only the whole leading Check word in context %j", (context, visible) => {
    const alert = { ...fixture(), context };
    const original = structuredClone(alert);
    const displayed = text(render([alert]));
    expect(displayed.includes(context)).toBe(visible);
    expect(displayed).toContain(alert.summary);
    expect(alert).toEqual(original);
    expect(send).not.toHaveBeenCalled();
  });
  it("retains Check-prefixed summaries and source quotations while omitting only context", () => {
    const alert = { ...fixture(), summary: "Check the institutional portal before submitting the application.",
      context: "Check all current instructions before you apply.", details: [{ category: "Application", summary: "Portal instructions changed.",
        previous: "Check the original portal.", current: "Check the revised institutional portal." }] };
    const original = structuredClone(alert);
    const displayed = text(render([alert]));
    expect(displayed).toContain(alert.summary);
    expect(displayed).toContain(alert.details[0].previous);
    expect(displayed).toContain(alert.details[0].current);
    expect(displayed).not.toContain(alert.context);
    expect(alert).toEqual(original);
  });
  it("shows the proposed summary and optional text support without exposing technical workflows", () => {
    const tree = render(); expect(text(tree)).toContain("Example Scholarship"); expect(text(tree)).toContain("November 5");
    expect(nodes(tree).find(node => node.type === "a")?.props.href).toBe("https://example.org/award");
    expect(nodes(tree).some(node => node.type === "img" || node.type === "iframe" || node.type === "textarea")).toBe(false);
    expect(text(tree)).not.toMatch(/inventory|application route|JSON|release gate/i); expect(send).not.toHaveBeenCalled();
  });
  it("loads the selected history view and does not offer approval controls for approved rows", async () => {
    send.mockResolvedValue(response({ alerts: [fixture("approved")] }));
    await button(render(), "Approved").props.onClick!(); const tree = render();
    expect(send).toHaveBeenCalledExactlyOnceWith("/api/admin/alert-reviews?status=approved", { cache: "no-store", credentials: "same-origin" });
    expect(nodes(tree).some(node => node.type === "button" && text(node) === "Approve alert")).toBe(false);
  });
  it("binds approval to the exact displayed content hash and refetches the pending queue", async () => {
    send.mockResolvedValueOnce(response({ ok: true })).mockResolvedValueOnce(response({ alerts: [] }));
    await button(render(), "Approve alert").props.onClick!();
    expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({ id: fixture().id, expected_hash: fixture().contentHash, action: "approve" });
    expect(send.mock.calls[0][1].credentials).toBe("same-origin"); expect(send.mock.calls[1][0]).toBe("/api/admin/alert-reviews?status=pending");
    expect(text(render())).toContain("Alert approved."); expect(text(render())).toContain("No alerts waiting for review.");
  });
  it("sends at most one decision while a request is in flight", async () => {
    let finish!: (value: unknown) => void;
    send.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(response({ alerts: [] }));
    const click = button(render(), "Approve alert").props.onClick!; const pending = click(); await click();
    expect(send).toHaveBeenCalledTimes(1); expect(button(render(), "Dismiss").props.disabled).toBe(true);
    finish(response({ ok: true })); await pending; expect(send.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  });
  it("retains the proposal and displays server rejection without announcing success", async () => {
    send.mockResolvedValue(response({ error: "This alert changed; refresh before deciding." }, false));
    await button(render(), "Dismiss").props.onClick!(); const tree = render();
    expect(text(tree)).toContain("This alert changed"); expect(text(tree)).toContain(fixture().summary); expect(text(tree)).not.toContain("Alert dismissed."); expect(send).toHaveBeenCalledTimes(1);
  });
  it("distinguishes a confirmed decision from a failed list refresh", async () => {
    send.mockResolvedValueOnce(response({ ok: true })).mockRejectedValueOnce(new Error("network unavailable"));
    await button(render(), "Dismiss").props.onClick!(); const tree = render();
    expect(text(tree)).toContain("Alert dismissed."); expect(text(tree)).toContain("Your decision was saved, but the list could not refresh");
    expect(text(tree)).not.toContain("No alerts waiting for review."); expect(nodes(tree).some(node => node.type === "button" && text(node) === "Approve alert")).toBe(false);
  });
  it("rejects malformed or unsafe list responses without showing an empty all-clear", async () => {
    const unsafe = fixture(); unsafe.sourceUrl = "javascript:alert(1)"; send.mockResolvedValue(response({ alerts: [unsafe] }));
    await button(render(), "Refresh").props.onClick!(); const tree = render();
    expect(text(tree)).toContain("The alert list could not be confirmed"); expect(text(tree)).not.toContain("No alerts waiting for review."); expect(nodes(tree).some(node => node.type === "a")).toBe(false);
  });
  it("rejects a success-shaped HTTP response that does not confirm the decision", async () => {
    send.mockResolvedValue(response({})); await button(render(), "Approve alert").props.onClick!();
    expect(text(render())).toContain("The decision was not confirmed"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("requires a successful refresh before another decision after an uncertain request", async () => {
    send.mockRejectedValueOnce(new Error("Connection lost; refresh before deciding again."));
    const click = button(render(), "Approve alert").props.onClick!; await click(); await click();
    expect(send).toHaveBeenCalledTimes(1); expect(button(render(), "Approve alert").props.disabled).toBe(true);
    send.mockResolvedValueOnce(response({ alerts: [fixture()] })); await button(render(), "Refresh").props.onClick!();
    expect(button(render(), "Approve alert").props.disabled).toBe(false);
  });
});

const AWARD = "99999999-9999-4999-8999-999999999999";
const GROUP = "33333333-3333-4333-8333-333333333333";
function source(status: "pending" | "approved" = "pending"): AlertReviewLeaf { return { ...fixture(status), awardId: AWARD }; }
function other(status: "pending" | "approved" = "pending"): AlertReviewLeaf {
  return { ...source(status), id: "22222222-2222-4222-8222-222222222222", contentHash: "b".repeat(64), summary: "Applicants now submit two references.",
    sourceUrl: "https://example.org/award/references", details: [{ category: "Application materials", summary: "Two references are now required.", previous: "One reference", current: "Two references" }] };
}
function mergeOption(member = other()): MergeOption {
  return { id: member.id, contentHash: member.contentHash, awardId: member.awardId!, awardName: member.awardName, summary: member.summary,
    detectedAt: member.detectedAt, status: member.status as "pending" | "approved", relatedReason: "The same award and application topic.", relatedToIds: [source().id] };
}
function preview(members = [source(), other()]): MergePreview {
  return { groupId: null, expectedHash: null, members, memberRefs: members.map(member => ({ id: member.id, content_hash: member.contentHash })),
    awardName: "Example Scholarship", summary: "The deadline and reference requirements changed.", context: "Check both application changes before submitting.",
    publishedMemberIds: members.filter(member => member.status === "approved").map(member => member.id), message: "Saving creates a draft; a separate approval publishes it." };
}
function combined(members = [source(), other()]): AlertReview {
  return { ...source(), id: GROUP, contentHash: "c".repeat(64), summary: "The deadline and reference requirements changed.", details: [],
    group: { id: GROUP, revisionHash: "c".repeat(64), members, publishedMemberIds: members.filter(member => member.status === "approved").map(member => member.id) } };
}
function select(tree: ReactNode) { const found = nodes(tree).find(node => node.type === "select"); expect(found).toBeTruthy(); return found!; }
function flushLatestEffect() { const effects = hooks.effects.splice(0); effects.at(-1)?.(); }

describe("manual grouping of related alerts", () => {
  it.each(["pending", "approved"] as const)("previews a pending alert with a %s update, retaining both source passages without deciding", async targetStatus => {
    const first = source(), second = other(targetStatus), initial = [first], options = [mergeOption(second)];
    const before = structuredClone([first, second]);
    let tree = render(initial, "pending", options);
    const disclosure = button(tree, "Combine with another update");
    expect(disclosure.props["aria-expanded"]).toBe(false);
    await disclosure.props.onClick!(); tree = render(initial, "pending", options);
    expect(button(tree, "Combine with another update").props["aria-expanded"]).toBe(true);
    expect(nodes(tree).find(node => node.type === "label")?.props.htmlFor).toBe(select(tree).props.id);
    expect(text(tree)).toContain(targetStatus === "approved" ? "Recently approved" : "Needs review");
    const value = preview([first, second]), originalPreview = structuredClone(value);
    send.mockResolvedValue(response({ ok: true, preview: value }));
    await select(tree).props.onChange!({ target: { value: second.id } }); tree = render(initial, "pending", options);
    expect(send).toHaveBeenCalledExactlyOnceWith(`/api/admin/alert-groups?source=${first.id}&target=${second.id}`, { cache: "no-store", credentials: "same-origin" });
    expect(text(tree)).toContain("Combined draft preview"); expect(text(tree)).toContain(first.summary); expect(text(tree)).toContain(second.summary);
    expect(text(tree)).toContain("One reference"); expect(text(tree)).toContain("Two references");
    expect(text(tree)).not.toContain(value.context!); expect(text(tree)).toContain(value.message);
    expect(nodes(tree).filter(node => node.type === "a").map(node => node.props.href)).toContain(second.sourceUrl);
    expect(text(tree)).not.toMatch(/Iran|because|caused by/);
    expect(send.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(0);
    expect([first, second]).toEqual(before);
    expect(value).toEqual(originalPreview);
    if (targetStatus === "approved") expect(text(tree)).toContain("Previously approved updates stay live while you review this draft");
  });

  it("retains a non-Check combined preview context and its publication notice", async () => {
    const first = source(), second = other("approved"), options = [mergeOption(second)];
    const value = { ...preview([first, second]), context: "Related changes are presented together. Their original evidence remains separate; this does not establish a common cause." };
    const original = structuredClone(value);
    await button(render([first], "pending", options), "Combine with another update").props.onClick!();
    send.mockResolvedValue(response({ ok: true, preview: value }));
    await select(render([first], "pending", options)).props.onChange!({ target: { value: second.id } });
    const displayed = text(render([first], "pending", options));
    expect(displayed).toContain(value.context);
    expect(displayed).toContain(value.message);
    expect(displayed).toContain("Previously approved updates stay live while you review this draft");
    expect(value).toEqual(original);
    expect(send.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(0);
  });

  it.each(["pending", "approved"] as const)("saves a %s-source combination as a draft only, then opens Needs review", async sourceStatus => {
    const first = source(sourceStatus), second = other("approved"), initial = [first], options = [mergeOption(second)], value = preview([first, second]);
    await button(render(initial, sourceStatus, options), "Combine with another update").props.onClick!();
    send.mockResolvedValueOnce(response({ ok: true, preview: value }));
    await select(render(initial, sourceStatus, options)).props.onChange!({ target: { value: second.id } });
    send.mockResolvedValueOnce(response({ ok: true })).mockResolvedValueOnce(response({ alerts: [combined([first, second])], mergeOptions: [] }));
    await button(render(initial, sourceStatus, options), "Save combined draft").props.onClick!();
    const posts = send.mock.calls.filter(([, init]) => init.method === "POST");
    expect(posts).toHaveLength(1); expect(posts[0][0]).toBe("/api/admin/alert-groups");
    expect(JSON.parse(posts[0][1].body)).toEqual({ action: "save", group_id: null, expected_hash: null, members: value.memberRefs });
    expect(send.mock.calls.at(-1)?.[0]).toBe("/api/admin/alert-reviews?status=pending");
    const tree = render(initial, sourceStatus, options);
    expect(text(tree)).toContain("Combined draft saved. Review it before publishing.");
    expect(button(tree, "Approve combined update")).toBeTruthy(); expect(button(tree, "Undo merge")).toBeTruthy();
    expect(posts.some(([, init]) => JSON.parse(init.body).action === "approve")).toBe(false);
  });

  it.each(["approve", "undo"] as const)("sends %s only for the exact displayed group revision", async action => {
    const alert = combined([source(), other("approved")]);
    send.mockResolvedValueOnce(response({ ok: true })).mockResolvedValueOnce(response({ alerts: [] }));
    await button(render([alert]), action === "approve" ? "Approve combined update" : "Undo merge").props.onClick!();
    expect(send.mock.calls[0][0]).toBe("/api/admin/alert-groups");
    expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({ action, id: alert.id, expected_hash: alert.contentHash });
    expect(text(render())).toContain(action === "approve" ? "Combined update approved." : "The original updates are preserved.");
  });

  it("offers no undo or new approval controls for an approved group", () => {
    const alert = { ...combined([source("approved"), other("approved")]), status: "approved" as const };
    const tree = render([alert], "approved");
    expect(text(tree)).toContain("Combined update");
    expect(nodes(tree).some(node => node.type === "button" && ["Approve combined update", "Undo merge", "Dismiss"].includes(text(node)))).toBe(false);
  });
  it("directs an approved group with a newer draft to Needs review instead of offering a stale merge", () => {
    const alert = { ...combined([source("approved"), other("approved")]), status: "approved" as const };
    alert.group!.hasPendingDraft = true;
    const tree = render([alert], "approved", [{ ...mergeOption(other()), id: "44444444-4444-4444-8444-444444444444" }]);
    expect(text(tree)).toContain("A newer combined draft is waiting in Needs review.");
    expect(nodes(tree).some(node => node.type === "button" && text(node) === "Combine with another update")).toBe(false);
  });

  it("rejects a changed member version before offering Save combined draft", async () => {
    const first = source(), second = other(), options = [mergeOption(second)];
    await button(render([first], "pending", options), "Combine with another update").props.onClick!();
    const value = preview([first, { ...second, contentHash: "d".repeat(64) }]);
    send.mockResolvedValue(response({ ok: true, preview: value }));
    await select(render([first], "pending", options)).props.onChange!({ target: { value: second.id } });
    const tree = render([first], "pending", options);
    expect(text(tree)).toContain("The selected updates changed");
    expect(nodes(tree).some(node => node.type === "button" && text(node) === "Save combined draft")).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("blocks automatic retries after an uncertain save and requires a fresh list", async () => {
    const first = source(), second = other(), options = [mergeOption(second)], initial = [first];
    await button(render(initial, "pending", options), "Combine with another update").props.onClick!();
    send.mockResolvedValueOnce(response({ ok: true, preview: preview([first, second]) }));
    await select(render(initial, "pending", options)).props.onChange!({ target: { value: second.id } });
    send.mockRejectedValueOnce(new Error("Connection lost; refresh before trying again."));
    const click = button(render(initial, "pending", options), "Save combined draft").props.onClick!;
    await click(); await click();
    expect(send.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    expect(button(render(initial, "pending", options), "Save combined draft").props.disabled).toBe(true);
    expect(text(render(initial, "pending", options))).not.toContain("Combined draft saved.");
    send.mockResolvedValueOnce(response({ alerts: initial, mergeOptions: options }));
    await button(render(initial, "pending", options), "Refresh").props.onClick!();
    expect(button(render(initial, "pending", options), "Approve alert").props.disabled).toBe(false);
  });

  it("reports a saved draft separately from a failed list refresh", async () => {
    const first = source(), second = other(), options = [mergeOption(second)], initial = [first];
    await button(render(initial, "pending", options), "Combine with another update").props.onClick!();
    send.mockResolvedValueOnce(response({ ok: true, preview: preview([first, second]) }));
    await select(render(initial, "pending", options)).props.onChange!({ target: { value: second.id } });
    send.mockResolvedValueOnce(response({ ok: true })).mockRejectedValueOnce(new Error("List unavailable"));
    await button(render(initial, "pending", options), "Save combined draft").props.onClick!();
    const tree = render(initial, "pending", options);
    expect(text(tree)).toContain("Combined draft saved. Review it before publishing.");
    expect(text(tree)).toContain("The combined draft was saved, but the list could not refresh");
    expect(text(tree)).not.toContain("No alerts waiting for review");
  });

  it("only labels suggestions related to the selected source, leaving other manual choices neutral", async () => {
    const first = source(), second = other(), options = [{ ...mergeOption(second), relatedToIds: [GROUP], relatedReason: "An unrelated pair-specific suggestion." }];
    await button(render([first], "pending", options), "Combine with another update").props.onClick!();
    const tree = render([first], "pending", options);
    expect(text(tree)).not.toContain("Possibly related"); expect(text(tree)).not.toContain("unrelated pair-specific");
    expect(text(tree)).toContain(second.summary);
  });

  it("applies refreshed server wording even when the evidence hash has not changed", () => {
    const original = [source()], updated = [{ ...source(), summary: "The official page no longer lists the previous application link.", context: "Check the current portal instructions." }];
    render(original); flushLatestEffect();
    render(updated); flushLatestEffect();
    const tree = render(updated);
    expect(text(tree)).toContain(updated[0].summary); expect(text(tree)).not.toContain(updated[0].context);
    expect(updated[0].contentHash).toBe(original[0].contentHash);
    expect(text(tree)).not.toContain(original[0].summary); expect(send).not.toHaveBeenCalled();
  });

  it("does not overwrite an in-flight decision with incoming server props or revive them after its confirmed refresh", async () => {
    const original = [source()], updated = [{ ...source(), summary: "Incoming wording while a decision is pending." }];
    let finish!: (value: unknown) => void;
    send.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(response({ alerts: [], mergeOptions: [] }));
    const tree = render(original); flushLatestEffect();
    const pending = button(tree, "Approve alert").props.onClick!();
    render(updated); flushLatestEffect();
    expect(text(render(updated))).toContain(original[0].summary);
    expect(button(render(updated), "Dismiss").props.disabled).toBe(true);
    finish(response({ ok: true })); await pending;
    render(updated); flushLatestEffect();
    expect(text(render(updated))).toContain("No alerts waiting for review.");
    expect(text(render(updated))).not.toContain(updated[0].summary);
    expect(send.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });
});
