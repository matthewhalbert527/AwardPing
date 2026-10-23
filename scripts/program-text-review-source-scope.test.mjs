import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({ sources: [], roles: [], config: null, db: null, repository: null,
  captures: [], submissions: [], polls: [], destroyed: 0, closed: 0 }));
vi.mock("node:fs", async original => {
  const actual = await original();
  return { ...actual,
    existsSync: path => /(?:\.env\.worker\.local|\.awardping-scrapling-runtime\.json)$/.test(String(path)) ? false : actual.existsSync(path),
    readFileSync: (path, ...args) => String(path).endsWith("program-text-monitoring.json") ? JSON.stringify(shared.config) : actual.readFileSync(path, ...args) };
});
vi.mock("@aws-sdk/client-s3", async original => ({ ...await original(), S3Client: class {
  send() { throw new Error("No storage transport is allowed in this source-scope fixture"); }
  destroy() { shared.destroyed++; }
} }));
vi.mock("./supabase-service-client.mjs", () => ({ createSupabaseServiceClient: () => shared.db,
  closeSupabaseServiceTransport: async () => { shared.closed++; } }));
vi.mock("./lib/program-text-repository.mjs", () => ({ createProgramTextRepository: () => shared.repository,
  programTextCandidateWork: () => { throw new Error("Unexpected candidate work in empty-queue fixture"); } }));
vi.mock("./lib/program-text-provider.mjs", () => ({
  submitProgramTextBatch: async row => { shared.submissions.push(row); throw new Error("No paid submission is allowed"); },
  pollProgramTextBatch: async row => { shared.polls.push(row); throw new Error("No provider poll is allowed"); } }));
vi.mock("./lib/program-text-monitor.mjs", () => ({
  monitorProgramTextSource: async ({ source }) => { shared.captures.push(source.id); return { status: "baseline_ready", initial_coverage: true }; },
  finalizeProgramTextReview: async () => { throw new Error("Unexpected review finalization in empty-queue fixture"); } }));

import { runProgramTextWorker } from "./program-text-worker.mjs";

const epoch = "33333333-3333-4333-8333-333333333333";
const owner = "22222222-2222-4222-8222-222222222222";
function fixtureSource(index) {
  return { id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, shared_award_id: owner,
    url: `https://example.org/source-${index + 1}`, title: `Source ${index + 1}`, page_type: "application",
    admin_review_status: "open", text_monitoring_state: {} };
}
function readonlyDatabase() {
  const calls = [];
  return { calls, from(table) {
    if (!["stage1_award_source_manifest", "shared_award_sources"].includes(table)) throw new Error("Unexpected database table");
    const call = { table, ids: null }; calls.push(call);
    const query = { select() { return query; }, order() { return query; }, limit() { return query; },
      in(key, values) { if (key !== "id") throw new Error("Unexpected database filter"); call.ids = values; return query; },
      then(yes, no) { const rows = table === "stage1_award_source_manifest" ? shared.roles : shared.sources;
        return Promise.resolve({ data: call.ids ? rows.filter(row => call.ids.includes(row.id)) : rows }).then(yes, no); } };
    return query;
  } };
}
beforeEach(() => {
  shared.sources = Array.from({ length: 124 }, (_, index) => fixtureSource(index));
  shared.roles = shared.sources.map((source, index) => ({ cohort_key: index < 100 ? "core" : "tail", source_role: "application_materials",
    source_ids: [source.id], manifest_status: "present", evidence: { source_bindings: { [source.id]: { source_url: source.url } } } }));
  shared.config = { schema: "awardping.program-text-monitoring.v1", epoch, enabled: true, sources: {} };
  shared.db = readonlyDatabase(); shared.repository = { listCandidates: vi.fn(async () => []) };
  shared.captures = []; shared.submissions = []; shared.polls = []; shared.destroyed = 0; shared.closed = 0;
  for (const [key, value] of Object.entries({ NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "fake-never-sent",
    R2_BUCKET: "private-bucket", R2_ENDPOINT: "https://fixture.invalid", R2_ACCESS_KEY_ID: "fake-never-sent",
    R2_SECRET_ACCESS_KEY: "fake-never-sent", GEMINI_API_KEY: "fake-never-sent" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No network request is allowed in this fixture"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("review candidate limit is not a required-source limit", () => {
  it.each([1, 100, 50000])("reviews the complete124-source scope while capping candidates for --limit=%i", async limit => {
    const report = await runProgramTextWorker(["--mode=review", "--apply=true", `--limit=${limit}`]);
    expect(shared.repository.listCandidates).toHaveBeenCalledExactlyOnceWith(["pending", "submitted", "succeeded"], Math.min(limit, 100),
      { source_ids: shared.sources.map(source => source.id), epoch });
    expect(report.selected_sources).toBe(124); expect(report.results).toEqual([]);
    expect(shared.repository.listCandidates.mock.calls[0][2].source_ids).toContain(shared.sources[123].id);
    expect(shared.captures).toEqual([]); expect(shared.submissions).toEqual([]); expect(shared.polls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled(); expect(shared.destroyed).toBe(1); expect(shared.closed).toBe(1);
    expect(shared.db.calls.map(call => call.table)).toEqual(["stage1_award_source_manifest", "shared_award_sources"]);
  });
  it("preserves cohort and global shard filters without capping their tail sources", async () => {
    const expected = shared.sources.filter((source, index) => index >= 100 && index % 3 === 0).map(source => source.id);
    const report = await runProgramTextWorker(["--mode=review", "--apply=true", "--cohort=tail", "--shard-count=3", "--shard-index=0", "--limit=1"]);
    expect(expected).toHaveLength(8); expect(expected).toContain(shared.sources[123].id);
    expect(shared.repository.listCandidates).toHaveBeenCalledExactlyOnceWith(["pending", "submitted", "succeeded"], 1, { source_ids: expected, epoch });
    expect(report.selected_sources).toBe(8); expect(shared.captures).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps an explicit tail-source review restricted to that source", async () => {
    const tail = shared.sources[123];
    const report = await runProgramTextWorker(["--mode=review", "--apply=true", `--source-id=${tail.id}`, "--limit=1"]);
    expect(shared.repository.listCandidates).toHaveBeenCalledExactlyOnceWith(["pending", "submitted", "succeeded"], 1, { source_ids: [tail.id], epoch });
    expect(report.selected_sources).toBe(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("excludes currently unapproved and unbound sources even beyond the first100", async () => {
    shared.sources[120].admin_review_status = "review_later";
    shared.roles[121].manifest_status = "missing";
    const expected = shared.sources.filter((source, index) => index !== 120 && index !== 121).map(source => source.id);
    await runProgramTextWorker(["--mode=review", "--apply=true", "--limit=100"]);
    expect(shared.repository.listCandidates).toHaveBeenCalledExactlyOnceWith(["pending", "submitted", "succeeded"], 100, { source_ids: expected, epoch });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("still applies --limit to collection sources, never to candidate work", async () => {
    const report = await runProgramTextWorker(["--mode=collect", "--apply=true", "--limit=100", "--domain-delay-ms=0"]);
    expect(shared.captures).toEqual(shared.sources.slice(0, 100).map(source => source.id));
    expect(report.selected_sources).toBe(100); expect(report.results).toHaveLength(100);
    expect(shared.repository.listCandidates).not.toHaveBeenCalled(); expect(shared.submissions).toEqual([]); expect(shared.polls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled(); expect(shared.destroyed).toBe(1); expect(shared.closed).toBe(1);
  });
});
