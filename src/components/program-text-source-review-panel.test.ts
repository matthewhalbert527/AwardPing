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
async function load(approved = false, current = false, extra:Record<string,unknown> = {}) {
  const input = nodes(render()).find(node => node.type === "input" && node.props.type !== "checkbox")!;
  input.props.onChange!({ target: { value: id, checked: false } });
  send.mockResolvedValueOnce(response({ id, content_hash: "a".repeat(64), source: { id, url: "https://provider.example/rules", title: "Rules" },
    proof: { capture_id: id }, target_text: "Complete saved rules", proposal: {}, provider_link: {}, approved, current, ...extra }));
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

describe("finite PAPPG catalogue workflow",()=>{
  const disposition={schema:"awardping.program-text-pappg-canonical-disposition.v1",context_hash:"b".repeat(64),
    context:{preserved_records:[{id:"19204933-2b56-42ac-96ee-b54213a2785a",owner_id:"c9b26239-8177-445b-ab39-473bc0c14d8f",history:"retained"}]},
    reason:"Explicitly reviewed finite PAPPG catalogue disposition with preserved ownership and history."};
  it("inspects preserved records only after an explicit click, using a private read",async()=>{
    const tree=render();expect(send).not.toHaveBeenCalled();expect(text(tree)).toContain("no handoff or alias permission");
    send.mockResolvedValueOnce(response({schema:"awardping.program-text-pappg-canonical-inspection.v1",context:disposition.context}));
    await button(tree,"Inspect preserved records").props.onClick!();
    expect(send).toHaveBeenCalledExactlyOnceWith("/api/admin/program-text-sources?inspection=pappg",{cache:"no-store",credentials:"same-origin"});
    expect(text(render())).toContain("c9b26239-8177-445b-ab39-473bc0c14d8f");
    expect(send.mock.calls.every(call=>call[1]?.method!=="POST")).toBe(true);
  });
  it("uses the finite prepare action only for the exact two-part JSON envelope",async()=>{
    const proposal={id,source:{id:"de868fe8-54ba-4fa0-8210-b27c8f182112",url:"https://www.nsf.gov/policies/pappg"}};
    const editor=nodes(render()).find(node=>node.type==="textarea")!;
    editor.props.onChange!({target:{value:JSON.stringify({proposal,catalogue_disposition:disposition}),checked:false}});
    send.mockResolvedValueOnce(response({ok:true,result:{id}}));await button(render(),"Prepare pending text source").props.onClick!();
    expect(send).toHaveBeenCalledTimes(1);expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({action:"prepare_pappg_canonical",proposal,catalogue_disposition:disposition});
    expect(send.mock.calls[0][1].credentials).toBe("same-origin");expect(JSON.parse(send.mock.calls[0][1].body)).not.toHaveProperty("actor");
    expect(text(render())).toContain("guarded PC capture must finish");
  });
  it("keeps ordinary JSON proposals on the existing preparation action",async()=>{
    const proposal={id,source:{id,url:"https://provider.example/rules"}};
    nodes(render()).find(node=>node.type==="textarea")!.props.onChange!({target:{value:JSON.stringify(proposal),checked:false}});
    send.mockResolvedValueOnce(response({ok:true,result:{id}}));await button(render(),"Prepare pending text source").props.onClick!();
    expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({action:"prepare",proposal});
  });
  it("labels preserved foreign ownership/history separately and never approves on load or render",async()=>{
    await load(false,false,{url_alias_boundary:[],catalogue_disposition:disposition});const tree=render(),visible=text(tree);
    expect(visible).toContain("Separate PAPPG catalogue disposition and currentness");expect(visible).toContain("original owners and histories");
    expect(visible).toContain("never reopens an older record");expect(visible).toContain("c9b26239-8177-445b-ab39-473bc0c14d8f");
    expect(visible).not.toContain("9 related records");expect(button(tree,"Approve text collection only").props.disabled).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);render();expect(send).toHaveBeenCalledTimes(1);
  });
});
