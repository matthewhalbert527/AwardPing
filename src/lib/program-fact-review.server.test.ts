import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), r2: vi.fn(), bucket: vi.fn(), load: vi.fn(), validate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/lib/r2", () => ({ createR2Client: mocks.r2, getR2Bucket: mocks.bucket }));
vi.mock("../../scripts/lib/program-text-artifacts.mjs", () => ({ loadProgramTextCapture: mocks.load }));
// Pure source/quote/track validation is exhaustively tested in its contract suite.
// Here an injected validator exercises the adapter's actual cold-load closure
// and proves the privileged RPC cannot run before that boundary completes.
vi.mock("../../scripts/lib/program-text-facts.mjs", async original => {
  const actual = await original<typeof import("../../scripts/lib/program-text-facts.mjs")>();
  return { ...actual, validateProgramFactReview: mocks.validate };
});
import { loadProgramFactBatch, loadProgramFactProposal, saveProgramFactProposal, prepareProgramFactProposal,
  approveProgramFactProposal, publishProgramFactBatch } from "@/lib/program-fact-review.server";

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const HASH = "a".repeat(64), ACTOR = id(999), COHORT = "synthetic-award";
const reference = { schema: "synthetic-test-reference", source: { id: id(3), shared_award_id: id(2), url: "https://example.org/program" }, capture_id: id(4) };
type QueryResult = { data: unknown; error: unknown };
type ValidationContext = { loadCapture: (ref: unknown) => Promise<unknown>; forApproval?: boolean };
let results: Record<string, QueryResult>, rpcResults: Record<string, QueryResult>, events: string[], proposal: Record<string, unknown>;
let rpc: ReturnType<typeof vi.fn>, from: ReturnType<typeof vi.fn>;
let queries: Record<string, ReturnType<typeof query>>;
function query(table: string) {
  const builder = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(),
    then(resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) {
      events.push(`read:${table}`); return Promise.resolve(results[table] ?? { data: null, error: new Error("unexpected_query") }).then(resolve, reject);
    } };
  return builder;
}
function validBatch() { return Array.from({ length: 25 }, (_, index) => ({ cohort_key: `cohort_${index}`, award_id: id(index + 20),
  name: `Synthetic award ${index}`, slug: `synthetic-${index}`, sources: [], review: null })); }
function publication() { return { schema: "awardping.program-fact-publication.v1", revision: id(100), active: false, cohorts: [] }; }
beforeEach(() => {
  vi.resetAllMocks(); events = []; queries = {};
  proposal = { schema: "awardping.program-fact-review.v1", cohort_key: COHORT, award_id: id(2), fields: [] };
  results = {
    stage1_award_registry: { data: { cohort_key: COHORT, canonical_shared_award_id: id(2) }, error: null },
    program_text_source_roster: { data: [{ source_role: "eligibility", revision: id(9), source_ids: [id(3)] }], error: null },
    stage1_award_members: { data: [{ shared_award_id: id(2) }], error: null },
    shared_award_sources: { data: [{ id: id(3), shared_award_id: id(2), url: reference.source.url, title: "Official source", admin_review_status: "open", text_monitoring_state: { latest_ref: reference } }], error: null },
    program_text_fact_reviews: { data: { id: id(1), cohort_key: COHORT, validation: { review: proposal }, content_hash: HASH, status: "draft" }, error: null },
  };
  rpcResults = { get_program_text_fact_review_batch: { data: validBatch(), error: null },
    get_program_text_fact_publication: { data: publication(), error: null },
    save_program_text_fact_review: { data: { id: id(1) }, error: null },
    approve_program_text_fact_review: { data: { id: id(1), status: "approved" }, error: null },
    publish_program_text_fact_batch: { data: { revision: id(101) }, error: null } };
  rpc = vi.fn(async (name: string) => { events.push(`rpc:${name}`); return rpcResults[name] ?? { data: null, error: new Error("unexpected_rpc") }; });
  from = vi.fn((table: string) => { queries[table] ??= query(table); return queries[table]; });
  mocks.admin.mockReturnValue({ from, rpc }); mocks.r2.mockReturnValue({ privateClient: true }); mocks.bucket.mockReturnValue("private-test-bucket");
  mocks.load.mockImplementation(async () => { events.push("cold_restore"); return { text: "Original official program text" }; });
  mocks.validate.mockImplementation(async (review: unknown, context: ValidationContext) => {
    events.push("validate:start"); await context.loadCapture(reference); events.push("validate:complete");
    return { schema: "awardping.program-fact-validation.v1", review, blockers: [], source_text: [{ reference,
      text: "Original official program text", blocks: [{ id: "block-1", text: "Original official program text" }] }], public_facts: {} };
  });
});

describe("program facts private server adapter", () => {
  it("loads the batch and public receipt only through the two read RPCs", async () => {
    const value = await loadProgramFactBatch(); expect(value.awards).toHaveLength(25); expect(value.publication).toEqual(publication());
    expect(rpc.mock.calls.map(call => call[0])).toEqual(["get_program_text_fact_review_batch", "get_program_text_fact_publication"]);
    expect(from).not.toHaveBeenCalled(); expect(mocks.r2).not.toHaveBeenCalled(); expect(mocks.validate).not.toHaveBeenCalled();
  });
  it.each(["get_program_text_fact_review_batch", "get_program_text_fact_publication"])("fails closed when %s is missing or errors", async name => {
    rpcResults[name] = { data: null, error: { code: "PGRST202", message: "private internal details" } };
    await expect(loadProgramFactBatch()).rejects.toThrow("current 25-award review batch is unavailable");
    expect(mocks.validate).not.toHaveBeenCalled();
  });
  it.each(["short", "duplicates", "missing_award", "missing_sources"])("rejects an incomplete batch (%s) without approving anything", async kind => {
    const batch = validBatch();
    if (kind === "short") batch.pop();
    if (kind === "duplicates") batch[24].cohort_key = batch[0].cohort_key;
    if (kind === "missing_award") batch[0].award_id = "wrong";
    if (kind === "missing_sources") (batch[0] as unknown as { sources: unknown }).sources = null;
    rpcResults.get_program_text_fact_review_batch.data = batch;
    await expect(loadProgramFactBatch()).rejects.toThrow();
    expect(rpc.mock.calls.some(call => call[0] === "approve_program_text_fact_review")).toBe(false);
  });
  it("rejects an unbound proposal before accessing private data", async () => {
    await expect(saveProgramFactProposal({ cohort_key: "../../other" }, ACTOR)).rejects.toThrow("Choose one reviewed award");
    expect(from).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it("saves a private draft only after complete context and cold original validation", async () => {
    await expect(saveProgramFactProposal(proposal, ACTOR)).resolves.toEqual({ id: id(1) });
    const context = mocks.validate.mock.calls[0][1]; expect(context.registry.canonical_shared_award_id).toBe(id(2));
    expect(context.memberIds).toEqual([id(2)]); expect(context.forApproval).toBeUndefined();
    expect(queries.program_text_source_roster.limit).toHaveBeenCalledExactlyOnceWith(100);
    expect(queries.shared_award_sources.in).toHaveBeenCalledExactlyOnceWith("id", [id(3)]);
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(reference, { client: { privateClient: true }, bucket: "private-test-bucket" });
    expect(events.indexOf("validate:complete")).toBeLessThan(events.indexOf("rpc:save_program_text_fact_review"));
    expect(rpc.mock.calls.map(call => call[0])).toEqual(["save_program_text_fact_review"]);
    const args = rpc.mock.calls[0][1]; expect(args.p_actor).toBe(ACTOR); expect(args.p_validation.review).toEqual(proposal);
  });
  it.each(["program_text_source_roster", "stage1_award_members", "shared_award_sources"])("withholds mutation when required %s context is missing", async table => {
    results[table] = { data: [], error: null };
    await expect(saveProgramFactProposal(proposal, ACTOR)).rejects.toThrow();
    expect(mocks.validate).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled();
  });
  it("withholds the save RPC when an original capture is unavailable", async () => {
    mocks.load.mockRejectedValue(new Error("missing_original"));
    await expect(saveProgramFactProposal(proposal, ACTOR)).rejects.toThrow("missing_original"); expect(rpc).not.toHaveBeenCalled();
  });
  it("prepares an empty unresolved current-source draft, never verified legacy facts", async () => {
    await prepareProgramFactProposal(COHORT, "2027 application", ACTOR);
    const review = mocks.validate.mock.calls[0][0];
    expect(review.schema).toBe("awardping.program-fact-review.v1"); expect(review.cycle).toBe("2027 application");
    expect(review.reviewed_all_sources).toBe(false); expect(review.fields).toHaveLength(21);
    expect(review.fields.every((field: { status: string; items: unknown[] }) => field.status === "unresolved" && field.items.length === 0)).toBe(true);
    expect(review.capture_refs).toEqual([reference]); expect(rpc.mock.calls.map(call => call[0])).toEqual(["save_program_text_fact_review"]);
  });
  it("rejects a stale expected hash before restoring or approving", async () => {
    await expect(approveProgramFactProposal(id(1), "b".repeat(64), ACTOR)).rejects.toThrow("proposal changed");
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.validate).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
    expect(from.mock.calls.map(call => call[0])).toEqual(["program_text_fact_reviews"]);
  });
  it("validates and cold-restores again for approval, then sends exact expected hash and actor", async () => {
    await approveProgramFactProposal(id(1), HASH, ACTOR);
    expect(mocks.validate.mock.calls[0][1].forApproval).toBe(true); expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(events.indexOf("validate:complete")).toBeLessThan(events.indexOf("rpc:approve_program_text_fact_review"));
    expect(rpc).toHaveBeenCalledExactlyOnceWith("approve_program_text_fact_review", { p_id: id(1), p_expected_hash: HASH, p_actor: ACTOR });
  });
  it("never calls approval if quote, context, or source validation fails", async () => {
    mocks.validate.mockRejectedValue(new Error("quote_or_source_validation_failed"));
    await expect(approveProgramFactProposal(id(1), HASH, ACTOR)).rejects.toThrow("quote_or_source_validation_failed");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("returns single-review private text, not raw storage credentials, signed URLs, or the whole proof", async () => {
    const value = await loadProgramFactProposal(id(1));
    expect(value).toEqual({ id: id(1), content_hash: HASH, status: "draft", review: proposal, sources: [{ id: id(3), url: reference.source.url,
      title: "Official source", capture_id: id(4), text: "Original official program text", blocks: [{ id: "block-1", text: "Original official program text" }] }] });
    expect(JSON.stringify(value)).not.toMatch(/private-test-bucket|privateClient|public_facts|source_text|signed/);
    expect(rpc).not.toHaveBeenCalled(); expect(mocks.load).toHaveBeenCalledTimes(1);
  });
  it("does not substitute a new fetch when saved original restoration fails", async () => {
    mocks.load.mockRejectedValue(new Error("corrupt_original"));
    await expect(loadProgramFactProposal(id(1))).rejects.toThrow("corrupt_original"); expect(rpc).not.toHaveBeenCalled();
  });
  it("publishes only through the atomic expected-version RPC, without writes to legacy facts", async () => {
    const ids = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`cohort_${index}`, id(index + 20)]));
    await publishProgramFactBatch(id(100), ids, ACTOR);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("publish_program_text_fact_batch", { p_expected_revision: id(100), p_review_ids: ids, p_actor: ACTOR });
    expect(from).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.validate).not.toHaveBeenCalled();
  });
  it.each(["save_program_text_fact_review", "approve_program_text_fact_review", "publish_program_text_fact_batch"])("surfaces %s failure without a fallback mutation", async name => {
    rpcResults[name] = { data: null, error: { message: "private database failure" } };
    const task = name.startsWith("save") ? saveProgramFactProposal(proposal, ACTOR) : name.startsWith("approve") ? approveProgramFactProposal(id(1), HASH, ACTOR) : publishProgramFactBatch(id(100), {}, ACTOR);
    await expect(task).rejects.toThrow(); expect(rpc.mock.calls.map(call => call[0])).toEqual([name]);
  });
});
