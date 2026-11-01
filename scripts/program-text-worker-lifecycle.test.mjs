import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";

const state = vi.hoisted(() => ({ db: null, config: null, captures: [], fail: false, trigger: null, closeFailure: false }));
vi.mock("node:fs", async original => {
  const fs = await original();
  return { ...fs, existsSync: p => /(?:\.env\.worker\.local|\.awardping-scrapling-runtime\.json)$/.test(String(p)) ? false : fs.existsSync(p),
    readFileSync: (p, ...args) => String(p).endsWith("program-text-monitoring.json") ? JSON.stringify(state.config) : fs.readFileSync(p, ...args) };
});
vi.mock("@aws-sdk/client-s3", () => ({ S3Client: class { destroy() {} } }));
vi.mock("./supabase-service-client.mjs", () => ({ createSupabaseServiceClient: () => state.db, closeSupabaseServiceTransport: async () => {} }));
vi.mock("./lib/program-text-repository.mjs", () => ({ createProgramTextRepository: () => ({}), programTextCandidateWork: () => { throw Error("forbidden"); } }));
vi.mock("./lib/program-text-monitor.mjs", () => ({ monitorProgramTextSource: async ({ source }) => {
  state.captures.push(source.id); return state.fail ? { status: "held", reason: "fixture_failure" } : { status: "baseline_ready" };
}, finalizeProgramTextReview: () => { throw Error("forbidden"); } }));
vi.mock("./lib/program-text-host-pacing.mjs", () => ({ createProgramTextHostPacer: () => ({ run: async (_urls, action) => action() }) }));
vi.mock("./lib/scrapling-capture.mjs", () => ({ createScraplingBrowserSessionPool: () => ({ close: async () => { if (state.closeFailure) throw Error("fixture_close_failure"); } }) }));
vi.mock("./lib/program-text-cycle-runner.mjs", async original => ({ ...await original(), requestInstalledCoverageReport: () => state.trigger() }));
import { runProgramTextWorker } from "./program-text-worker.mjs";
import { rosterPageFixture } from "./fixtures/program-text-roster-pages.mjs";

let directory;
const epoch = "33333333-3333-4333-8333-333333333333", owner = "22222222-2222-4222-8222-222222222222";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "awardping-lifecycle-test-"));
  state.config = { schema: "awardping.program-text-monitoring.v1", epoch, enabled: true, sources: {} };
  state.captures = []; state.fail = false; state.closeFailure = false; state.trigger = vi.fn(async () => ({ requested: true }));
  const sources = [1, 2, 3].map(n => ({ id: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`, shared_award_id: owner,
    url: `https://example.org/${n}`, page_type: "application", admin_review_status: "open", text_monitoring_state: {}, text_collection_quality: null }));
  const roles = sources.map((source, i) => ({ cohort_key: "example", source_role: `application_${i}`, source_ids: [source.id],
    manifest_status: "reviewed_text", revision: epoch, evidence: { schema: "awardping.program-text-source-role.v1",
      source_bindings: { [source.id]: { source_url: source.url, shared_award_id: owner } } } }));
  state.db = { rpc: async (name, params) => {
    if (name === "get_program_text_worker_roster_page") return rosterPageFixture(roles, sources)(params);
    if (name === "get_program_award_monitoring_basics") return { data: { schema: "awardping.program-award-monitoring-basics.v1",
      awards: [{ cohort_key: "example", award_id: owner, snapshot_id: null, basic_details_current: false }] } };
    throw Error("forbidden_rpc");
  } };
  const current = new Date();
  for (const [key, value] of Object.entries({ NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "fixture",
    R2_BUCKET: "private", R2_ENDPOINT: "https://fixture.invalid", R2_ACCESS_KEY_ID: "fixture", R2_SECRET_ACCESS_KEY: "fixture",
    AWARDPING_WORKER_DATA_ROOT: directory, AWARDPING_WORKER_REVISION: "a".repeat(40),
    AWARDPING_COLLECTION_ANCHOR_MINUTE_UTC: String(current.getUTCHours() * 60 + current.getUTCMinutes()) })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("forbidden_network"); }));
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  expect(dirname(realpathSync(directory))).toBe(realpathSync(tmpdir()));
  expect(basename(directory)).toMatch(/^awardping-lifecycle-test-/);
  rmSync(directory, { recursive: true });
});
const collect = index => runProgramTextWorker(["--mode=collect", "--apply=true", "--run-trigger=scheduled", "--shard-count=3", `--shard-index=${index}`, "--domain-delay-ms=0"]);
const report = trigger => runProgramTextWorker(["--mode=report", "--apply=true", `--run-trigger=${trigger}`]);
describe("collection completion drives coverage reports", () => {
  it("waits for all three shards, requests the report once and prevents duplicate scheduled reports", async () => {
    expect((await report("scheduled")).report_state).toBe("waiting_or_already_reported");
    expect((await collect(0)).collection_cycle.complete).toBe(false);
    await collect(1); expect(state.trigger).not.toHaveBeenCalled();
    expect((await collect(2)).collection_cycle.complete).toBe(true);
    expect(state.trigger).toHaveBeenCalledTimes(1);
    const finished = await report("scheduled");
    expect(finished.collection_cycle.complete).toBe(true); expect(finished.coverage).toHaveLength(1);
    expect((await report("scheduled")).report_state).toBe("waiting_or_already_reported");
    expect((await report("manual")).coverage).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports failed collection honestly after the remaining shards finish", async () => {
    state.fail = true; await collect(0); state.fail = false;
    await collect(1); await collect(2);
    const result = await report("scheduled");
    expect(result.collection_cycle.complete).toBe(false);
    expect(result.collection_cycle.shards.map(s => s.status)).toEqual(["failed", "succeeded", "succeeded"]);
    expect(state.trigger).toHaveBeenCalledTimes(1);
  });
  it("records a browser cleanup failure as a failed shard, retaining reporting recovery", async () => {
    state.closeFailure = true; await expect(collect(0)).rejects.toThrow("fixture_close_failure"); state.closeFailure = false;
    await collect(1); await collect(2);
    expect((await report("scheduled")).collection_cycle.shards[0].status).toBe("failed");
    expect(state.trigger).toHaveBeenCalledTimes(1);
  });
});
