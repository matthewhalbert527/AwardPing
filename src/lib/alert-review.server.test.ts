import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), loadCapture: vi.fn(), verifyCandidate: vi.fn(), realRepository: false }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/lib/r2", () => ({ createR2Client: () => ({}), getR2Bucket: () => "private-test-evidence" }));
vi.mock("../../scripts/lib/program-text-artifacts.mjs", async importOriginal => ({
  ...await importOriginal<typeof import("../../scripts/lib/program-text-artifacts.mjs")>(), loadProgramTextCapture: mocks.loadCapture,
}));
vi.mock("../../scripts/lib/program-text-repository.mjs", async importOriginal => {
  const actual = await importOriginal<typeof import("../../scripts/lib/program-text-repository.mjs")>();
  return { ...actual,
  createProgramTextRepository: (db: unknown, options: { loadCapture: (ref: unknown) => Promise<unknown>; bucket: string }) => mocks.realRepository ? actual.createProgramTextRepository(db, options) : ({
    verifyCandidate: async (row: { previous_snapshot_ref: unknown; new_snapshot_ref: unknown }) => {
      await mocks.verifyCandidate(row); await options.loadCapture(row.previous_snapshot_ref); await options.loadCapture(row.new_snapshot_ref);
    },
  }),
}; });
import { quoteIdRecoveryFixture } from "../../scripts/fixtures/program-text-quote-id-recovery.mjs";
import { prepareProgramTextQuoteIdRecovery } from "../../scripts/lib/program-text-quote-id-recovery.mjs";
import { decideAlertReview, loadAlertReviews } from "./alert-review.server";
import { programChangeContext } from "./program-change-presentation";

const actor = "10000000-0000-4000-8000-000000000001";
let candidate: Record<string, unknown>, review: Record<string, unknown>, award: Record<string, unknown>;
let tables: Record<string, Array<Record<string, unknown>>>;
let calls: Array<{ table: string; kind: string; value?: unknown }>;
class Query {
  filters: Array<[string, unknown]> = [];
  constructor(readonly table: string) { calls.push({ table, kind: "from" }); }
  select(value: string) { calls.push({ table: this.table, kind: "select", value }); return this; }
  eq(key: string, value: unknown) { this.filters.push([key, value]); return this; }
  in(key: string, value: unknown[]) { calls.push({ table: this.table, kind: "in", value }); this.filters.push([key, value]); return this; }
  order() { return this; }
  matches() { return tables[this.table].filter(row => this.filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value)); }
  async limit(value: number) { calls.push({ table: this.table, kind: "limit", value }); return { data: this.matches().slice(0, value), error: null }; }
  async single() { const found = this.matches(); return { data: found.length === 1 ? found[0] : null, error: found.length === 1 ? null : { code: "missing" } }; }
}
beforeEach(async () => {
  vi.resetAllMocks(); calls = []; mocks.realRepository = false;
  const fixture = quoteIdRecoveryFixture(), prepared = await prepareProgramTextQuoteIdRecovery(fixture.row, { loadCapture: fixture.loadCapture });
  if (!("details" in prepared.validation) || prepared.validation.status !== "accepted") throw Error("Expected accepted test comparison.");
  candidate = { ...fixture.row, status: "succeeded", published_at: null, created_at: "2026-10-26T23:01:00.000Z",
    ai_result: { responses: prepared.projected_responses, program_text_validation: prepared.validation } };
  review = { id: candidate.id, content_hash: "a".repeat(64), status: "pending", details: prepared.validation.details, created_at: "2026-10-26T23:02:00.000Z" };
  award = { id: candidate.shared_award_id, name: "NSF Graduate Research Fellowship Program" };
  tables = { program_text_alert_reviews: [review], shared_award_visual_review_candidates: [candidate], shared_awards: [award] };
  mocks.from.mockImplementation(table => new Query(table)); mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
  mocks.loadCapture.mockImplementation(fixture.loadCapture); mocks.verifyCandidate.mockResolvedValue(undefined);
});
function input(action: "approve" | "dismiss" = "approve") { return { id: candidate.id as string, expected_hash: "a".repeat(64), action }; }
describe("bounded private alert list and independently verified decision", () => {
  it("loads a bounded source and award projection without fetching evidence or provider responses", async () => {
    const before = structuredClone(review);
    const value = await loadAlertReviews(); expect(value).toHaveLength(1);
    expect(value[0]).toMatchObject({ id: candidate.id, contentHash: review.content_hash, awardName: award.name,
      sourceUrl: candidate.source_url, detectedAt: candidate.created_at, status: "pending",
      details: [{ category: "Application cycle", previous: expect.stringContaining("2027 NSF GRFP"), current: expect.stringContaining("applications are closed") }] });
    expect(value[0].context).toBe(programChangeContext(review.details));
    expect(value[0].context).toBeTruthy();
    expect(value[0].summary).toBe((review.details as { summary: string }).summary);
    expect(review).toEqual(before);
    expect(value[0]).not.toHaveProperty("ai_result"); expect(value[0]).not.toHaveProperty("previous_snapshot_ref");
    expect(mocks.loadCapture).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
    expect(calls.filter(call => call.kind === "limit").every(call => call.value === 100)).toBe(true);
    expect(calls.find(call => call.table === "shared_award_visual_review_candidates" && call.kind === "select")?.value).not.toContain("*");
  });
  it("explains a removed guide reference without claiming a site investigation or changing stored evidence", async () => {
    const title = "Information for Candidates - USA";
    const summary = `The page no longer lists “${title}”.`;
    review.details = { schema: "awardping.program-change.v1", event_kind: "program_details_changed", summary,
      program_changes: [{ field: "documents", operation: "remove", summary,
        previous_quote: { block_id: "guide", start_utf16: 0, end_utf16: title.length, text: title }, current_quote: null }] };
    const before = structuredClone(review);
    const [value] = await loadAlertReviews();
    expect(value.summary).toBe(summary);
    expect(value.context).toBe(programChangeContext(review.details));
    expect(value.context).toMatch(/does not|doesn't/i);
    expect(value.context).not.toMatch(/HTTP|500|reorganized|confirmed|now located/i);
    expect(review).toEqual(before);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.loadCapture).not.toHaveBeenCalled();
  });
  it("returns an empty confirmed list without unrelated table queries", async () => {
    expect(await loadAlertReviews("approved")).toEqual([]); expect(mocks.from).toHaveBeenCalledTimes(1);
  });
  it("fails closed when a referenced award or valid official source is missing", async () => {
    tables.shared_awards = []; await expect(loadAlertReviews()).rejects.toThrow("Invalid alert details");
    tables.shared_awards = [award]; candidate.source_url = "https://user:secret@official.example/";
    await expect(loadAlertReviews()).rejects.toThrow("official source");
  });
  it.each(["approve", "dismiss"] as const)("cold verifies both originals and saved response before %s CAS", async action => {
    expect(await decideAlertReview(input(action), actor)).toEqual({ ok: true });
    expect(mocks.verifyCandidate).toHaveBeenCalledExactlyOnceWith(candidate); expect(mocks.loadCapture).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("decide_program_text_alert", {
      p_id: candidate.id, p_expected_hash: review.content_hash, p_action: action, p_actor: actor,
    });
    expect(mocks.verifyCandidate.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0]);
  });
  it("rejects stale hashes and completed reviews before cold loading or RPC", async () => {
    await expect(decideAlertReview({ ...input(), expected_hash: "b".repeat(64) }, actor)).rejects.toThrow("changed");
    review.status = "approved"; await expect(decideAlertReview(input(), actor)).rejects.toThrow("changed");
    expect(mocks.loadCapture).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects unsupported actor/input before using the service client", async () => {
    await expect(decideAlertReview(input(), "forged")).rejects.toThrow("Invalid alert decision"); expect(mocks.from).not.toHaveBeenCalled();
  });
  it.each(["source authority changed", "original unavailable"])("does not decide when %s", async reason => {
    if (reason === "source authority changed") mocks.verifyCandidate.mockRejectedValue(Error(reason)); else mocks.loadCapture.mockRejectedValue(Error(reason));
    await expect(decideAlertReview(input(), actor)).rejects.toThrow(reason); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("regenerates the actual validator result instead of trusting saved accepted status", async () => {
    const ai = candidate.ai_result as Record<string, unknown>; ai.responses = [];
    await expect(decideAlertReview(input(), actor)).rejects.toThrow("saved alert"); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects altered alert wording or saved validation despite complete originals", async () => {
    review.details = { ...(review.details as Record<string, unknown>), summary: "A different proposed description." };
    await expect(decideAlertReview(input(), actor)).rejects.toThrow("saved alert"); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("requires the complete saved validation to equal independent revalidation", async () => {
    const ai = candidate.ai_result as Record<string, unknown>;
    ai.program_text_validation = { ...(ai.program_text_validation as Record<string, unknown>), comparison_id: "b".repeat(64) };
    await expect(decideAlertReview(input(), actor)).rejects.toThrow("saved alert"); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not report an unconfirmed RPC transition as approved", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false }, error: null });
    await expect(decideAlertReview(input(), actor)).rejects.toThrow("No alert decision was confirmed");
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: { code: "40001" } });
    await expect(decideAlertReview(input(), actor)).rejects.toThrow("No alert decision was confirmed");
  });
});

describe("alert server with the actual source-and-originals repository", () => {
  beforeEach(() => {
    mocks.realRepository = true;
    const payload = candidate.prompt_payload as Record<string, unknown>, identity = payload.program_identity as Record<string, unknown>;
    const metadata = candidate.worker_metadata as Record<string, unknown>;
    metadata.bucket = "private-test-evidence";
    award.status = "active";
    tables.shared_award_sources = [{ id: candidate.shared_award_source_id, shared_award_id: candidate.shared_award_id,
      url: candidate.source_url, title: identity.source_title, admin_review_status: "open", text_monitoring_state: {
        epoch: metadata.epoch, baseline_ref: candidate.previous_snapshot_ref, latest_ref: candidate.new_snapshot_ref,
      } }];
    mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "program_text_source_is_approved" ? true : name === "decide_program_text_alert" ? { ok: true } : null, error: null }));
  });
  it("cold rebuilds the complete comparison and packets under current source/award authority before deciding", async () => {
    expect(await decideAlertReview(input(), actor)).toEqual({ ok: true });
    expect(mocks.loadCapture).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "program_text_source_is_approved", { p_source_id: candidate.shared_award_source_id });
    expect(mocks.rpc).toHaveBeenLastCalledWith("decide_program_text_alert", expect.objectContaining({ p_id: candidate.id }));
    expect(mocks.verifyCandidate).not.toHaveBeenCalled();
  });
  it.each(["owner", "url", "previous capture", "current capture", "program title"])("rejects a changed %s boundary without a publication call", async boundary => {
    const source = tables.shared_award_sources[0];
    if (boundary === "owner") source.shared_award_id = actor;
    else if (boundary === "url") source.url = "https://www.nsfgrfp.org/different-page";
    else if (boundary === "program title") source.title = "A changed source identity";
    else (source.text_monitoring_state as Record<string, unknown>)[boundary === "previous capture" ? "baseline_ref" : "latest_ref"] = {};
    await expect(decideAlertReview(input(), actor)).rejects.toThrow();
    expect(mocks.rpc.mock.calls.some(call => call[0] === "decide_program_text_alert")).toBe(false);
    expect(mocks.loadCapture).not.toHaveBeenCalled();
  });
  it("rejects revoked source approval before loading private originals", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    await expect(decideAlertReview(input(), actor)).rejects.toThrow("no longer approved");
    expect(mocks.loadCapture).not.toHaveBeenCalled(); expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("rejects inactive award identity before loading originals", async () => {
    award.status = "inactive";
    await expect(decideAlertReview(input(), actor)).rejects.toThrow("award identity");
    expect(mocks.loadCapture).not.toHaveBeenCalled(); expect(mocks.rpc.mock.calls.some(call => call[0] === "decide_program_text_alert")).toBe(false);
  });
  it("rejects incomplete cold originals without deciding or obtaining a new model response", async () => {
    mocks.loadCapture.mockResolvedValue({}); await expect(decideAlertReview(input(), actor)).rejects.toThrow();
    expect(mocks.rpc.mock.calls.some(call => call[0] === "decide_program_text_alert")).toBe(false);
  });
});
