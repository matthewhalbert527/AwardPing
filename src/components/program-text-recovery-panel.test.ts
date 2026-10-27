import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0 }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }]; },
  useRef: (initial: unknown) => { const index = hooks.refCursor++; hooks.refs[index] ??= { current: initial }; return hooks.refs[index]; },
}));
import { ProgramTextRecoveryPanel } from "./program-text-recovery-panel";
type Props = { children?: ReactNode; disabled?: boolean; type?: string; onClick?: () => unknown;
  onChange?: (event: { target: { value: string; checked: boolean } }) => void };
function nodes(node: ReactNode): ReactElement<Props>[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Props>(node) ? [node, ...nodes(node.props.children)] : []; }
function text(node: ReactNode): string { return typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : isValidElement<Props>(node) ? text(node.props.children) : ""; }
function button(label: string) { const result = nodes(render()).find(node => node.type === "button" && text(node.props.children) === label); expect(result, label).toBeTruthy(); return result!; }
function render() { hooks.cursor = 0; hooks.refCursor = 0; return ProgramTextRecoveryPanel(); }
const candidate = "8d40add5-89ea-4f96-9c31-f1f68c1fa472", journal = "11111111-1111-4111-8111-111111111111";
let send: ReturnType<typeof vi.fn>;
const response = (value: unknown, ok = true) => ({ ok, json: async () => value });
const data = () => ({ schema: "awardping.program-text-quote-id-recovery-preview.v1", candidate_id: candidate, already_applied: false,
  preimage_hash: "a".repeat(64), projection_hash: "b".repeat(64), summary: "Applications for the named field groups are closed.",
  source: { id: journal, url: "https://www.nsf.gov/funding/initiatives/grfp", final_url: "https://www.nsf.gov/funding/initiatives/grfp", title: "NSF GRFP" },
  changed_text: { previous: "Named field groups", current: "Named field groups: applications are closed" }, validation: { status: "accepted" }, warning: "Normal processing may publish.",
  changes: ["previous", "current"].map(side => ({ path: `/0/blocks/0/changes/0/${side}_quote/block_id`, side, old_block_id: "change-00001", new_block_id: "block-000012", quote: "Named field groups" })) });
beforeEach(() => { hooks.values = []; hooks.refs = []; hooks.cursor = 0; hooks.refCursor = 0; send = vi.fn(); vi.stubGlobal("fetch", send); });
afterEach(() => { vi.unstubAllGlobals(); });
async function load() { send.mockResolvedValueOnce(response(data())); await button("Load saved NSF comparison").props.onClick!(); }
function attest() {
  nodes(render()).find(node => node.type === "textarea")!.props.onChange!({ target: { value: "Checked both unchanged quotations and the two source-block references.", checked: false } });
  nodes(render()).find(node => node.type === "input" && node.props.type === "checkbox")!.props.onChange!({ target: { value: "", checked: true } });
}
describe("finite saved-review correction controls", () => {
  it("does no work on render and warns about resumed publication", () => {
    expect(text(render())).toContain("Approval resumes normal processing and may publish"); expect(send).not.toHaveBeenCalled();
  });
  it("requires both a reason and explicit review before resuming", async () => {
    await load(); expect(button("Approve correction and resume review").props.disabled).toBe(true);
    await button("Approve correction and resume review").props.onClick!(); expect(send).toHaveBeenCalledTimes(1);
    attest(); expect(button("Approve correction and resume review").props.disabled).toBe(false);
    send.mockResolvedValueOnce(response({ ok: true, result: { journal_id: journal, candidate_id: candidate, status: "succeeded" } }));
    await button("Approve correction and resume review").props.onClick!();
    expect(JSON.parse(send.mock.calls[1][1].body)).toEqual({ candidate_id: candidate, preimage_hash: "a".repeat(64), projection_hash: "b".repeat(64), reason: "Checked both unchanged quotations and the two source-block references." });
    expect(text(render())).toContain("existing worker may now publish the scoped update"); expect(text(render())).toContain("Award facts still need their separate approval");
  });
  it("rejects a missing commit receipt instead of claiming a correction", async () => {
    await load(); attest(); send.mockResolvedValueOnce(response({ ok: true, result: {} }));
    await button("Approve correction and resume review").props.onClick!();
    expect(text(render())).toContain("Reload its status before another action"); expect(text(render())).not.toContain("correction and original failure are recorded");
    expect(button("Approve correction and resume review").props.disabled).toBe(true);
  });
  it("never restarts an already applied historical correction", async () => {
    send.mockResolvedValueOnce(response({ candidate_id: candidate, already_applied: true, receipt: { journal_id: journal } }));
    await button("Load saved NSF comparison").props.onClick!();
    expect(text(render())).toContain("recorded correction is historical"); expect(nodes(render()).some(node => text(node.props.children) === "Approve correction and resume review")).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("removes stale approval controls when current evidence fails to reload", async () => {
    await load(); attest(); send.mockResolvedValueOnce(response({ error: "Current source pair changed." }, false));
    await button("Load saved NSF comparison").props.onClick!(); expect(text(render())).toContain("Current source pair changed");
    expect(nodes(render()).some(node => node.type === "textarea")).toBe(false); expect(send.mock.calls.filter(([,options]) => options?.method === "POST")).toHaveLength(0);
  });
});
