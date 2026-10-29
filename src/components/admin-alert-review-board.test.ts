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
type Props = { children?: ReactNode; disabled?: boolean; href?: string; onClick?: () => unknown; role?: string };
function nodes(node: ReactNode): ReactElement<Props>[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Props>(node) ? [node, ...nodes(node.props.children)] : []; }
function text(node: ReactNode): string { return typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : isValidElement<Props>(node) ? text(node.props.children) : ""; }
function button(tree: ReactNode, label: string) { const found = nodes(tree).find(node => node.type === "button" && text(node.props.children) === label); expect(found, label).toBeTruthy(); return found!; }
function fixture(status: AlertReviewStatus = "pending"): AlertReview { return { id: "11111111-1111-4111-8111-111111111111", contentHash: "a".repeat(64), awardName: "Example Scholarship", summary: "The application deadline moved to November 5.", sourceUrl: "https://example.org/award", detectedAt: "2026-10-29T12:00:00Z", status, details: [{ category: "Deadline", summary: "The closing date changed.", previous: "November 1", current: "November 5" }] }; }
let send: ReturnType<typeof vi.fn>;
function render(alerts: AlertReview[] = [fixture()], status: AlertReviewStatus = "pending") { hooks.cursor = 0; hooks.refCursor = 0; return AdminAlertReviewBoard({ initialAlerts: alerts, initialStatus: status }); }
const response = (value: unknown, ok = true) => ({ ok, json: async () => value });
beforeEach(() => { hooks.values = []; hooks.refs = []; hooks.effects = []; hooks.cursor = 0; hooks.refCursor = 0; send = vi.fn(); vi.stubGlobal("fetch", send); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("simple outgoing alert review", () => {
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
