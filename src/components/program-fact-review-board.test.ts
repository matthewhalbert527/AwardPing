import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgramFactBatchItem, ProgramFactPublication } from "@/lib/program-fact-review-types";

// These exercise actual bound callbacks with state/ref doubles. They do not
// claim browser keyboard, hydration, layout or focus coverage.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0 }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }]; },
    useRef: (initial: unknown) => { const index = hooks.refCursor++; hooks.refs[index] ??= { current: initial }; return hooks.refs[index]; },
  };
});
import { ProgramFactReviewBoard } from "@/components/program-fact-review-board";

type Props = { children?: ReactNode; disabled?: boolean; checked?: boolean; id?: string; value?: string; "aria-label"?: string; "aria-labelledby"?: string;
  onClick?: () => void | Promise<void>; onChange?: (event: { target: { value: string; checked: boolean } }) => void };
function elements(node: ReactNode): ReactElement<Props>[] { return Array.isArray(node) ? node.flatMap(elements) : isValidElement<Props>(node) ? [node, ...elements(node.props.children)] : []; }
function text(node: ReactNode): string { return typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : isValidElement<Props>(node) ? text(node.props.children) : ""; }
function button(tree: ReactNode, label: string) { const node = elements(tree).find(element => element.type === "button" && text(element.props.children) === label); expect(node, label).toBeTruthy(); return node!; }
function row(tree: ReactNode, index = 0) { return elements(tree).find(element => element.type === "article" && element.props["aria-labelledby"] === `award-fact-cohort_${index}`)!; }
function checkbox(tree: ReactNode, startsWith: string) { const label = elements(tree).find(element => element.type === "label" && text(element.props.children).startsWith(startsWith)); expect(label).toBeTruthy(); return elements(label).find(element => element.type === "input")!; }
function change(node: ReactElement<Props>, value = "", checked = false) { node.props.onChange!({ target: { value, checked } }); }
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const fields = ["overview", "opening_date", "deadline", "cycle_status", "important_dates", "eligibility", "citizenship", "academic_levels", "disciplines", "award_amounts", "stipend", "tuition", "travel_research_allowance", "tenure", "requirements", "application_materials", "how_to_apply", "documents", "selection", "application_url", "contacts"];
function award(index: number): ProgramFactBatchItem { return {
  cohort_key: `cohort_${index}`, award_id: id(index + 1), name: `Synthetic Award ${index}`, slug: `award-${index}`,
  sources: [{ id: id(index + 500), url: `https://example.org/award-${index}`, title: `Official source ${index}`, ready: true, state: "baseline_ready" }],
  review: { id: id(index + 100), content_hash: String(index % 10).repeat(64), status: "draft", reviewed_at: null, current: false, cycle: "2027 application", blockers: [], fields: fields.map(field => ({ field, status: "verified", note: "", items: [{ value: `Synthetic ${field} value`, track: null }] })) },
}; }
let awards: ProgramFactBatchItem[], publication: ProgramFactPublication, send: ReturnType<typeof vi.fn>;
function render() { hooks.cursor = 0; hooks.refCursor = 0; return ProgramFactReviewBoard({ initialAwards: awards, initialPublication: publication }); }
function saved(index = 0) { return { id: awards[index].review!.id, content_hash: awards[index].review!.content_hash,
  review: { schema: "awardping.program-fact-review.v1", cohort_key: awards[index].cohort_key, award_id: awards[index].award_id, reviewed_all_sources: true, fields: awards[index].review!.fields },
  sources: awards[index].sources.map(source => ({ ...source, text: "Official retained <script>alert('no execution')</script> program text", blocks: [{ id: "block-1", start_utf16: 0, end_utf16: 8, text: "Official" }] })) }; }
async function loadAndCheck(index = 0) { await button(row(render(), index), "Load saved text and proposal").props.onClick!(); const input = checkbox(row(render(), index), "I checked the complete saved source set"); expect(input.props.disabled).toBe(false); change(input, "", true); }
beforeEach(() => {
  hooks.values = []; hooks.refs = []; hooks.cursor = 0; hooks.refCursor = 0;
  awards = Array.from({ length: 25 }, (_, index) => award(index));
  publication = { schema: "awardping.program-fact-publication.v1", revision: id(900), active: false, cohorts: [] };
  send = vi.fn(async (url: string, options?: { method?: string; body?: string }) => {
    if (options?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
    const reviewId = new URL(url, "https://awardping.com").searchParams.get("review");
    return { ok: true, json: async () => reviewId ? saved(awards.findIndex(item => item.review?.id === reviewId)) : { awards, publication } };
  });
  vi.stubGlobal("fetch", send);
});
afterEach(() => vi.unstubAllGlobals());

describe("25-award text-only review board", () => {
  it("renders all awards with honest private statuses and no network or automatic approval", () => {
    awards[0].review = null; awards[1].sources[0].ready = false; awards[1].sources[0].state = "held";
    const tree = render(), html = renderToStaticMarkup(tree);
    expect(elements(tree).filter(element => element.type === "article")).toHaveLength(25);
    expect(html).toContain("24 prepared · 0 approved · 0 in public release");
    expect(html).toContain("No current-details proposal prepared"); expect(html).toContain("Held: held");
    expect(html).not.toMatch(/<img|<iframe|screenshot|crop localization/); expect(send).not.toHaveBeenCalled();
    expect(button(tree, "Approve checked (0)").props.disabled).toBe(true);
    expect(button(tree, "Publish approved 25-award batch").props.disabled).toBe(true);
  });
  it("requires full saved text and explicit exact-version attestation before approval", async () => {
    let tree = render(); const input = checkbox(row(tree), "I checked the complete saved source set");
    expect(input.props.disabled).toBe(true); change(input, "", true);
    await button(render(), "Approve checked (0)").props.onClick!(); expect(send).not.toHaveBeenCalled();
    await loadAndCheck(); tree = render(); expect(button(tree, "Approve checked (1)").props.disabled).toBe(false);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Official retained &lt;script&gt;"); expect(html).not.toContain("<script>");
    expect(html).toContain("UTF-16 text offsets"); expect(html).toContain("block-1");
    expect(send).toHaveBeenCalledExactlyOnceWith(`${"/api/admin/program-facts"}?review=${awards[0].review!.id}`, { cache: "no-store", credentials: "same-origin" });
  });
  it("rejects a wrong saved source, even if the proposal name matches", async () => {
    const value = saved(); value.sources[0].url = "https://example.org/a-different-page";
    send.mockResolvedValueOnce({ ok: true, json: async () => value });
    await button(row(render()), "Load saved text and proposal").props.onClick!();
    expect(text(render())).toContain("Saved source identities could not be confirmed");
    expect(checkbox(row(render()), "I checked the complete saved source set").props.disabled).toBe(true);
  });
  it.each(["id", "content_hash"] as const)("rejects changed saved proposal %s before enabling an attestation", async key => {
    const value = saved(); value[key] = key === "id" ? id(999) : "f".repeat(64);
    send.mockResolvedValueOnce({ ok: true, json: async () => value });
    await button(row(render()), "Load saved text and proposal").props.onClick!();
    expect(text(render())).toContain("Saved source identities could not be confirmed");
    expect(checkbox(row(render()), "I checked the complete saved source set").props.disabled).toBe(true);
    expect(send.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  });
  it("does not attest or approve a held or unresolved award", async () => {
    awards[0].review!.blockers = ["deadline unresolved"]; awards[0].review!.fields[2].status = "unresolved";
    await button(row(render()), "Load saved text and proposal").props.onClick!();
    const tree = render(); expect(checkbox(row(tree), "I checked the complete saved source set").props.disabled).toBe(true);
    expect(text(row(tree))).toContain("deadline unresolved");
    expect(button(tree, "Approve checked (0)").props.disabled).toBe(true);
  });
  it("records separate approval results and never automatically retries a failed award", async () => {
    await loadAndCheck(0); await loadAndCheck(1);
    send.mockImplementation(async (url: string, options?: { body?: string }) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      if (body?.action === "approve" && body.id === awards[0].review!.id) return { ok: false, json: async () => ({ error: "Source changed; approval withheld." }) };
      if (body?.action === "approve") { awards[1].review!.status = "approved"; awards[1].review!.current = true; return { ok: true, json: async () => ({ ok: true }) }; }
      return { ok: true, json: async () => ({ awards, publication }) };
    });
    await button(render(), "Approve checked (2)").props.onClick!();
    const posts = send.mock.calls.filter(([, options]) => options?.method === "POST"); expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[0][1].body)).toEqual({ action: "approve", id: awards[0].review!.id, expected_hash: awards[0].review!.content_hash });
    expect(text(row(render(), 0))).toContain("Source changed; approval withheld.");
    expect(text(row(render(), 1))).toContain("Approval recorded. Not yet published.");
    expect(button(render(), "Approve checked (0)").props.disabled).toBe(true);
    expect(posts.some(([, options]) => JSON.parse(options.body).action === "publish")).toBe(false);
  });
  it("prevents duplicate submissions from repeated stale callbacks", async () => {
    await loadAndCheck(); let complete!: (value: unknown) => void;
    send.mockImplementation((url: string, options?: { method?: string }) => options?.method === "POST" ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ ok: true, json: async () => ({ awards, publication }) }));
    const approve = button(render(), "Approve checked (1)").props.onClick!;
    const first = approve(), second = approve();
    expect(send.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    complete({ ok: true, json: async () => ({ ok: true }) }); await Promise.all([first, second]); await approve();
    expect(send.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });
  it("editing a private draft revokes attestation and save does not approve", async () => {
    await loadAndCheck(); const tree = render();
    const editor = elements(row(tree)).find(element => element.type === "textarea")!;
    const proposal = JSON.parse(editor.props.value!); proposal.fields[0].items[0].value = "Reviewed proposed overview";
    change(editor, JSON.stringify(proposal, null, 2));
    expect(button(render(), "Approve checked (0)").props.disabled).toBe(true);
    await button(row(render()), "Save private draft").props.onClick!();
    const posts = send.mock.calls.filter(([, options]) => options?.method === "POST"); expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual({ action: "save", review: proposal });
    expect(text(render())).toContain("has not been approved or published");
  });
  it.each(["not JSON", JSON.stringify({ cohort_key: "other", award_id: "wrong" })])("rejects invalid or cross-award private edits locally: %s", async editor => {
    await button(row(render()), "Load saved text and proposal").props.onClick!();
    change(elements(row(render())).find(element => element.type === "textarea")!, editor);
    await button(row(render()), "Save private draft").props.onClick!();
    expect(send.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
    expect(text(render())).toContain("Nothing was saved");
  });
  it("prepares only an explicitly selected cycle as an empty draft", async () => {
    awards[0].review = null; let tree = render(); expect(button(row(tree), "Prepare empty draft").props.disabled).toBe(true);
    change(elements(row(tree)).find(element => element.type === "input" && element.props.id === "cycle-cohort_0")!, "2027 doctoral track");
    await button(row(render()), "Prepare empty draft").props.onClick!();
    const post = send.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(JSON.parse(post[1].body)).toEqual({ action: "prepare", cohort: "cohort_0", cycle: "2027 doctoral track" });
    tree = render(); expect(text(tree)).toContain("No program details were inferred or approved");
  });
  it("does not prepare a draft while required capture coverage is held", () => {
    awards[0].review = null; awards[0].sources[0].ready = false;
    change(elements(row(render())).find(element => element.type === "input" && element.props.id === "cycle-cohort_0")!, "2027");
    expect(button(row(render()), "Prepare empty draft").props.disabled).toBe(true);
  });
  it("can prepare a fresh unresolved proposal to reconcile an old approval without changing it", async () => {
    awards[0].review!.status = "approved"; awards[0].review!.current = false;
    const originalId = awards[0].review!.id;
    change(elements(row(render())).find(element => element.type === "input" && element.props.id === "replacement-cycle-cohort_0")!, "2028 application");
    await button(row(render()), "Prepare replacement draft").props.onClick!();
    const posts = send.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts).toHaveLength(1); expect(JSON.parse(posts[0][1].body)).toEqual({ action: "prepare", cohort: "cohort_0", cycle: "2028 application" });
    expect(awards[0].review!.id).toBe(originalId); expect(awards[0].review!.status).toBe("approved");
    expect(text(render())).toContain("No program details were inferred or approved");
  });
  it("requires all 25 separate current approvals and explicit publication confirmation", async () => {
    awards.forEach(item => { item.review!.status = "approved"; item.review!.current = true; });
    let tree = render(); expect(button(tree, "Publish approved 25-award batch").props.disabled).toBe(true);
    change(checkbox(tree, "I reviewed the separate approval results"), "", true);
    tree = render(); expect(button(tree, "Publish approved 25-award batch").props.disabled).toBe(false);
    await button(tree, "Publish approved 25-award batch").props.onClick!();
    const post = send.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(JSON.parse(post[1].body)).toEqual({ action: "publish", expected_revision: publication.revision,
      review_ids: Object.fromEntries(awards.map(item => [item.cohort_key, item.review!.id])) });
    expect(Object.keys(JSON.parse(post[1].body).review_ids)).toHaveLength(25);
  });
  it("cannot publish a first batch with a stale award approval", () => {
    awards.forEach(item => { item.review!.status = "approved"; item.review!.current = true; }); awards[24].review!.current = false;
    expect(checkbox(render(), "I reviewed the separate approval results").props.disabled).toBe(true);
    expect(button(render(), "Publish approved 25-award batch").props.disabled).toBe(true);
  });
  it("does not turn unsafe source URLs into clickable links", () => {
    awards[0].sources[0].url = "javascript:alert(1)";
    const html = renderToStaticMarkup(render()); expect(html).not.toContain('href="javascript:');
    expect(html).toContain("Official source 0");
  });
  it("rejects an incomplete refresh rather than showing a partial successful batch", async () => {
    send.mockResolvedValueOnce({ ok: true, json: async () => ({ awards: awards.slice(0, 24), publication }) });
    await button(render(), "Refresh status").props.onClick!();
    expect(text(render())).toContain("complete 25-award batch could not be confirmed");
    expect(elements(render()).filter(element => element.type === "article")).toHaveLength(25);
  });
});
