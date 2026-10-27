import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0 }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }]; },
  useRef: (initial: unknown) => { const index = hooks.refCursor++; hooks.refs[index] ??= { current: initial }; return hooks.refs[index]; },
}));
import { ProgramTextSourceReviewPanel } from "./program-text-source-review-panel";
type Props = { children?: ReactNode; disabled?: boolean; checked?: boolean; type?: string; onClick?: () => unknown;
  onChange?: (event: { target: { value: string; checked: boolean } }) => void };
function nodes(node: ReactNode): ReactElement<Props>[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Props>(node) ? [node, ...nodes(node.props.children)] : []; }
function text(node: ReactNode): string { return typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : isValidElement<Props>(node) ? text(node.props.children) : ""; }
function button(tree: ReactNode, label: string) { const result = nodes(tree).find(node => node.type === "button" && text(node.props.children) === label); expect(result, label).toBeTruthy(); return result!; }
function render() { hooks.cursor = 0; hooks.refCursor = 0; return ProgramTextSourceReviewPanel(); }
const id = "11111111-1111-4111-8111-111111111111";
let send: ReturnType<typeof vi.fn>;
const response = (value: unknown) => ({ ok: true, json: async () => value });
beforeEach(() => { hooks.values = []; hooks.refs = []; hooks.cursor = 0; hooks.refCursor = 0;
  send = vi.fn(); vi.stubGlobal("fetch", send); });
afterEach(() => { vi.unstubAllGlobals(); });
async function load(approved = false, current = false) {
  const input = nodes(render()).find(node => node.type === "input" && node.props.type !== "checkbox")!;
  input.props.onChange!({ target: { value: id, checked: false } });
  send.mockResolvedValueOnce(response({ id, content_hash: "a".repeat(64), source: { id, url: "https://provider.example/rules", title: "Rules" },
    proof: { capture_id: id }, target_text: "Complete saved rules", proposal: {}, provider_link: {}, approved, current }));
  await button(render(), "Load retained source proof").props.onClick!();
}
describe("text source approval status", () => {
  it("does no collection or mutation on render", () => { render(); expect(send).not.toHaveBeenCalled(); });
  it("never offers to reactivate an already recorded historical approval", async () => {
    await load(true, false);
    expect(text(render())).toContain("Historical approval · collection authority needs review");
    expect(button(render(), "Approve text collection only").props.disabled).toBe(true);
    await button(render(), "Approve text collection only").props.onClick!();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])("reports a confirmed approval's current authority accurately (%s)", async current => {
    await load();
    nodes(render()).find(node => node.type === "input" && node.props.type === "checkbox")!.props.onChange!({ target: { value: "", checked: true } });
    send.mockResolvedValueOnce(response({ ok: true, result: { approved: true, current, already_approved: false } }));
    await button(render(), "Approve text collection only").props.onClick!();
    expect(text(render())).toContain(current ? "Source approval is current." : "No source was reactivated.");
    expect(button(render(), "Approve text collection only").props.disabled).toBe(true);
    expect(JSON.parse(send.mock.calls[1][1].body)).toEqual({ action: "approve", id, expected_hash: "a".repeat(64) });
  });
  it("does not claim success for an incomplete server receipt", async () => {
    await load();
    nodes(render()).find(node => node.type === "input" && node.props.type === "checkbox")!.props.onChange!({ target: { value: "", checked: true } });
    send.mockResolvedValueOnce(response({ ok: true, result: { approved: true } }));
    await button(render(), "Approve text collection only").props.onClick!();
    expect(text(render())).toContain("Reload its stored status");
    expect(text(render())).not.toContain("Source approval is current.");
  });
});
