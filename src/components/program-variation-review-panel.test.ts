import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VariationAdminPage } from "@/lib/program-variation-review-types";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0 }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }]; },
  useRef: (initial: unknown) => { const index = hooks.refCursor++; hooks.refs[index] ??= { current: initial }; return hooks.refs[index]; },
}));
import { ProgramVariationReleasePanel, ProgramVariationReviewPanel } from "./program-variation-review-panel";
type Props = { children?: ReactNode; disabled?: boolean; checked?: boolean; type?: string; id?: string; onClick?: () => unknown;
  onChange?: (event: { target: { value: string; checked: boolean } }) => void };
function nodes(node: ReactNode): ReactElement<Props>[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Props>(node) ? [node, ...nodes(node.props.children)] : []; }
function text(node: ReactNode): string { return typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : isValidElement<Props>(node) ? text(node.props.children) : ""; }
function button(tree: ReactNode, label: string) { const result = nodes(tree).find(node => node.type === "button" && text(node.props.children) === label); expect(result, label).toBeTruthy(); return result!; }
function checkbox(tree: ReactNode) { return nodes(tree).find(node => node.type === "input" && node.props.type === "checkbox")!; }
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const hash = "a".repeat(64);
let send: ReturnType<typeof vi.fn>;
function render(release = false) { hooks.cursor = 0; hooks.refCursor = 0; return release ? ProgramVariationReleasePanel() : ProgramVariationReviewPanel({ cohort: "example", awardName: "Example" }); }
function fixture(status: "draft" | "sealed" = "sealed"): VariationAdminPage {
  const review = (n: number, scope_key: string) => ({ id: id(n), scope_key, content_hash: hash, shared_review_id: null, shared_hash: null, blockers: [], fields: [], created_at: "2026-10-26T12:00:00Z", current: true });
  return { inventory: { id: id(1), cohort_key: "example", cycle: "2027", revision: id(2), content_hash: status === "sealed" ? hash : null,
    draft_hash: hash, status, expected_variants: 1, previous_revision: null, scope_count: 2, coverage_gaps: [], inventory_hash_version: 2 }, scopes: ["common", "us"].map((scope_key, index) => ({
      scope_key, label: scope_key, attributes: { country: null, course: null, track: null, applicant_group: null }, source_roles: [], provider_support: [], retired: false, review: review(index + 3, scope_key) })),
    total: 2, next_cursor: null, approval: null };
}
beforeEach(() => { hooks.values = []; hooks.refs = []; hooks.cursor = 0; hooks.refCursor = 0;
  send = vi.fn(); vi.stubGlobal("fetch", send); });
afterEach(() => { vi.unstubAllGlobals(); });
const response = (value: unknown) => ({ ok: true, json: async () => value });

describe("complete provider review controls", () => {
  it("does no collection, model work or mutation on initial render", () => {
    const tree = render(); expect(text(tree)).toContain("Earlier drafts remain available"); expect(send).not.toHaveBeenCalled();
    expect(nodes(tree).some(node => node.type === "iframe" || node.type === "img")).toBe(false);
  });
  it("requires explicit complete-inventory attestation and uses the draft fingerprint", async () => {
    const data = fixture("draft"); send.mockResolvedValue(response(data));
    await button(render(), "Load provider coverage").props.onClick!();
    expect(button(render(), "Confirm complete inventory").props.disabled).toBe(true);
    checkbox(render()).props.onChange!({ target: { value: "", checked: true } });
    await button(render(), "Confirm complete inventory").props.onClick!();
    const mutations = send.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(mutations).toHaveLength(1);
    expect(JSON.parse(mutations[0][1].body)).toMatchObject({ action: "seal_inventory", expected_hash: hash, expected_revision: id(2), complete_provider_inventory_reviewed: true });
  });
  it("does not send an approval when a child route remains unresolved", async () => {
    const data = fixture(); data.scopes[1].review!.blockers = ["deadline"];
    send.mockResolvedValue(response(data)); await button(render(), "Load provider coverage").props.onClick!();
    checkbox(render()).props.onChange!({ target: { value: "", checked: true } });
    await button(render(), "Approve this award separately").props.onClick!();
    expect(text(render())).toContain("Every provider route needs a current complete review");
    expect(send.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  });
  it("blocks inventory sealing while provider guidance is missing, including direct handler invocation", async () => {
    const data = fixture("draft"); data.inventory!.coverage_gaps = [{ key: "annual_guide", label: "Current annual guide is missing", source_url: "https://example.org/guide" }];
    send.mockResolvedValue(response(data)); await button(render(), "Load provider coverage").props.onClick!();
    const checks = nodes(render()).filter(node => node.type === "input" && node.props.type === "checkbox");
    checks[checks.length - 1].props.onChange!({ target: { value: "", checked: true } });
    expect(button(render(), "Confirm complete inventory").props.disabled).toBe(true);
    await button(render(), "Confirm complete inventory").props.onClick!();
    expect(text(render())).toContain("Current annual guide is missing");
    expect(send.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  });
  it("binds gap revisions to the loaded draft and records a reason without approving facts", async () => {
    const data = fixture("draft"); send.mockResolvedValue(response(data));
    await button(render(), "Load provider coverage").props.onClick!();
    const proposed = [{ key: "funding", label: "Funding guidance needs collection", source_url: null }];
    nodes(render()).find(node => node.props.id === "gaps-example")!.props.onChange!({ target: { value: JSON.stringify(proposed), checked: false } });
    const reasonInput = nodes(render()).find(node => node.type === "label" && text(node).startsWith("Reason for this coverage revision"))!;
    nodes(reasonInput).find(node => node.type === "input")!.props.onChange!({ target: { value: "Official funding guidance has not yet been reviewed.", checked: false } });
    await button(render(), "Save coverage gaps privately").props.onClick!();
    const mutations = send.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(mutations).toHaveLength(1);
    expect(JSON.parse(mutations[0][1].body)).toEqual({ action: "set_inventory_gaps", inventory_id: id(1), expected_revision: id(2), expected_hash: hash,
      coverage_gaps: proposed, reason: "Official funding guidance has not yet been reviewed." });
  });
  it("requires a separate resolution attestation before removing a recorded gap", async () => {
    const data = fixture("draft"); data.inventory!.coverage_gaps = [{ key: "guide", label: "Guide missing", source_url: null }];
    send.mockResolvedValue(response(data)); await button(render(), "Load provider coverage").props.onClick!();
    nodes(render()).find(node => node.props.id === "gaps-example")!.props.onChange!({ target: { value: "[]", checked: false } });
    const reasonInput = nodes(render()).find(node => node.type === "label" && text(node).startsWith("Reason for this coverage revision"))!;
    nodes(reasonInput).find(node => node.type === "input")!.props.onChange!({ target: { value: "The complete current official guide was reviewed.", checked: false } });
    await button(render(), "Save coverage gaps privately").props.onClick!();
    expect(text(render())).toContain("Confirm that the removed gaps were resolved");
    expect(send.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
    checkbox(render()).props.onChange!({ target: { value: "", checked: true } });
    await button(render(), "Save coverage gaps privately").props.onClick!();
    expect(send.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });
  it("reports stale gap writes and retains the recorded unresolved list", async () => {
    const data = fixture("draft"); data.inventory!.coverage_gaps = [{ key: "guide", label: "Guide still missing", source_url: null }];
    send.mockResolvedValueOnce(response(data)); await button(render(), "Load provider coverage").props.onClick!();
    const reasonInput = nodes(render()).find(node => node.type === "label" && text(node).startsWith("Reason for this coverage revision"))!;
    nodes(reasonInput).find(node => node.type === "input")!.props.onChange!({ target: { value: "Current official sources require further review.", checked: false } });
    send.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Inventory revision changed; reload coverage." }) });
    await button(render(), "Save coverage gaps privately").props.onClick!();
    expect(text(render())).toContain("Inventory revision changed"); expect(text(render())).toContain("Guide still missing");
    expect(button(render(), "Confirm complete inventory").props.disabled).toBe(true);
  });
  it("keeps sealed coverage history read-only and rejects unsafe reference links", async () => {
    const data = fixture(); data.inventory!.coverage_gaps = [{ key: "history", label: "Historical coverage note", source_url: null }];
    send.mockResolvedValueOnce(response(data)); await button(render(), "Load provider coverage").props.onClick!();
    expect(text(render())).toContain("Historical coverage note");
    expect(nodes(render()).some(node => node.props.id === "gaps-example")).toBe(false);
    const invalid = structuredClone(data); invalid.inventory!.coverage_gaps[0].source_url = "javascript:alert(1)"; send.mockResolvedValueOnce(response(invalid));
    await button(render(), "Refresh coverage").props.onClick!();
    expect(text(render())).toContain("inventory identities could not be confirmed");
    expect(nodes(render()).some(node => node.type === "a" && (node.props as { href?: string }).href?.startsWith("javascript:"))).toBe(false);
  });
  it("rejects a changed inventory during complete-route approval enumeration", async () => {
    const data = fixture(); send.mockResolvedValueOnce(response(data));
    await button(render(), "Load provider coverage").props.onClick!(); checkbox(render()).props.onChange!({ target: { value: "", checked: true } });
    send.mockResolvedValueOnce(response({ ...data, inventory: { ...data.inventory, revision: id(99) } }));
    await button(render(), "Approve this award separately").props.onClick!();
    expect(text(render())).toContain("provider inventory changed"); expect(send.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  });
  it("does not treat partial award approvals as a publishable 25-award release", async () => {
    const awards = Array.from({ length: 25 }, (_, index) => ({ cohort_key: `award_${index}`, approval_id: index === 24 ? null : id(index + 10), current: index !== 24, blockers: index === 24 ? ["missing_inventory"] : [] }));
    send.mockResolvedValue(response({ schema: "awardping.program-variation-admin-batch.v1", revision: id(8), active: false, approval_ids: {}, awards }));
    await button(render(true), "Check all award approvals").props.onClick!();
    expect(text(render(true))).toContain("24/25 current complete award approvals");
    expect(button(render(true), "Publish complete approved release").props.disabled).toBe(true);
    expect(send.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  });
});
