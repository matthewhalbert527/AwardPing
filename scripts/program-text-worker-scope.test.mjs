import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({ db: null, config: null, captures: new Map(), provider: [], captureCalls: [], destroyed: 0 }));
vi.mock("node:fs", async original => {
  const actual = await original();
  return { ...actual, existsSync: path => String(path).includes(".env.worker.local") || String(path).includes(".awardping-scrapling-runtime.json") ? false : actual.existsSync(path),
    readFileSync: (path, ...args) => String(path).endsWith("program-text-monitoring.json") ? JSON.stringify(shared.config) : actual.readFileSync(path, ...args) };
});
vi.mock("@aws-sdk/client-s3", async original => ({ ...await original(), S3Client: class { destroy() { shared.destroyed++; } } }));
vi.mock("./supabase-service-client.mjs", () => ({ createSupabaseServiceClient: () => shared.db, closeSupabaseServiceTransport: async () => {} }));
vi.mock("./lib/program-text-storage.mjs", async original => ({ ...await original(),
  loadProgramTextCapture: async ref => shared.captures.get(ref.capture_id) }));
vi.mock("./lib/program-text-provider.mjs", () => ({ submitProgramTextBatch: async row => { shared.provider.push(row.id); return { status: "submitted" }; },
  pollProgramTextBatch: async () => { throw new Error("Unexpected provider poll in source scope fixture"); } }));
vi.mock("./lib/program-text-monitor.mjs", async original => ({ ...await original(), monitorProgramTextSource: async args => {
  shared.captureCalls.push(args.source.id); return { status: "baseline_ready", initial_coverage: true, creates_update: false };
} }));

import { runProgramTextWorker } from "./program-text-worker.mjs";
import { buildProgramTextCapture } from "./lib/program-text-capture.mjs";
import { programTextReference } from "./lib/program-text-storage.mjs";
import { buildProgramTextComparison, buildProgramTextReviewPackets } from "./lib/program-text-review.mjs";

const epoch = "33333333-3333-4333-8333-333333333333", oldEpoch = "99999999-9999-4999-8999-999999999999";
function rowSet(index, candidateEpoch = epoch) {
  const source = { id: `${index}`.repeat(8) + `-${index}`.repeat(0), shared_award_id: "22222222-2222-4222-8222-222222222222", url: `https://example.org/award-${index}`, admin_review_status: "open" };
  source.id = `${String(index).repeat(8)}-${String(index).repeat(4)}-4${String(index).repeat(3)}-8${String(index).repeat(3)}-${String(index).repeat(12)}`;
  const capture = (day, minute) => {
    const text = `The application deadline is March ${day}, 2027. All applicants must be enrolled.`;
    return buildProgramTextCapture({ source, acquisition: "http_html", raw_bytes: Buffer.from(`<html><body>${text}</body></html>`), content_type: "text/html", text,
      blocks: [{ id: "date", text, start_utf16: 0, end_utf16: text.length, heading: "Application deadline" }], extractor: { name: "fixture", version: "1" }, captured_at: `2026-10-23T01:0${minute}:00.000Z` });
  };
  const previous = capture(15, 0), current = capture(20, 1), before = programTextReference(previous), after = programTextReference(current);
  shared.captures.set(previous.capture_id, previous); shared.captures.set(current.capture_id, current);
  const comparison = buildProgramTextComparison(previous, current, { epoch: candidateEpoch, cycle_id: "2027" });
  const state = { schema: "awardping.program-text-state.v1", epoch: candidateEpoch, status: "awaiting_review", baseline_ref: before, latest_ref: after,
    last_checked_at: current.captured_at, first_captured_at: previous.captured_at, successful_checks: 2 };
  return { source: { ...source, text_monitoring_state: state }, role: { cohort_key: `award_${index}`, source_role: "application", source_ids: [source.id], manifest_status: "reviewed_text", revision: epoch,
    evidence: { schema: "awardping.program-text-source-role.v1", source_bindings: { [source.id]: { source_url: source.url, shared_award_id: source.shared_award_id } } } },
    candidate: { id: `${String(index + 4).repeat(8)}-${String(index + 4).repeat(4)}-4${String(index + 4).repeat(3)}-8${String(index + 4).repeat(3)}-${String(index + 4).repeat(12)}`,
      candidate_scope: "program_text_change", candidate_signature: comparison.comparison_id, shared_award_id: source.shared_award_id, shared_award_source_id: source.id,
      source_url: source.url, previous_snapshot_ref: before, new_snapshot_ref: after, previous_image_hash: null, new_image_hash: null, previous_file_hash: null, new_file_hash: null,
      worker_metadata: { monitoring_contract: "program-text-v1", epoch: candidateEpoch, evidence_signature: comparison.comparison_id, bucket: "private-bucket" },
      prompt_payload: { program_identity: { award_id: source.shared_award_id, award_name: "Example Award", source_url: source.url, source_title: null }, comparison, packet_plan: buildProgramTextReviewPackets(comparison) }, status: "pending" } };
}
function database(sets, { approved = true } = {}) {
  const calls = [];
  return { calls, rpc(name, params) {
    calls.push({ rpc: name, params });
    if (name === "get_program_text_fact_review_batch") return Promise.resolve({ data: [] });
    if (name !== "program_text_source_is_approved") throw new Error("Unexpected source-scope RPC");
    return Promise.resolve({ data: approved && sets.some(set => set.source.id === params.p_source_id) });
  }, from(table) {
    const call = { table, filters: [] }; calls.push(call);
    const query = { select(columns) { call.select = columns; return query; }, order() { return query; }, limit() { return query; }, single() { call.single = true; return query; },
      eq(key, value) { call.filters.push(["eq", key, value]); return query; }, in(key, value) { call.filters.push(["in", key, value]); return query; },
      then(yes, no) {
        let values = table === "program_text_source_roster" ? sets.map(set => set.role)
          : table === "shared_award_sources" ? sets.map(set => set.source)
            : table === "shared_awards" ? sets.map(set => ({ id: set.source.shared_award_id, name: "Example Award", status: "active" })) : sets.map(set => set.candidate);
        for (const [method, key, value] of call.filters) values = values.filter(row => {
          const actual = key === "worker_metadata->>epoch" ? row.worker_metadata?.epoch : row[key];
          return method === "in" ? value.includes(actual) : actual === value;
        });
        return Promise.resolve({ data: call.single ? values[0] : values }).then(yes, no);
      } }; return query;
  } };
}

beforeEach(() => {
  shared.captures = new Map(); shared.provider = []; shared.captureCalls = []; shared.destroyed = 0;
  shared.config = { schema: "awardping.program-text-monitoring.v1", epoch, enabled: false, sources: {} };
  for (const [key, value] of Object.entries({ NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "fake-never-sent",
    R2_BUCKET: "private-bucket", R2_ENDPOINT: "https://fixture.invalid", R2_ACCESS_KEY_ID: "fake-never-sent", R2_SECRET_ACCESS_KEY: "fake-never-sent", GEMINI_API_KEY: "fake-never-sent" })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

describe("CLI source scope before any provider submission", () => {
  it("a one-source pilot cannot review another source or an older epoch", async () => {
    const current = rowSet(1), other = rowSet(2), stale = rowSet(3, oldEpoch); shared.db = database([current, other, stale]);
    const report = await runProgramTextWorker(["--mode=review", "--apply=true", "--pilot=true", `--source-id=${current.source.id}`]);
    expect(shared.provider).toEqual([current.candidate.id]); expect(report.results.map(row => row.candidate_id)).toEqual([current.candidate.id]);
    const queue = shared.db.calls.find(call => call.table === "shared_award_visual_review_candidates");
    expect(queue.filters).toContainEqual(["in", "shared_award_source_id", [current.source.id]]);
    expect(queue.filters).toContainEqual(["eq", "worker_metadata->>epoch", epoch]); expect(shared.destroyed).toBe(1);
  });
  it("a cohort scope also limits paid work to that cohort", async () => {
    shared.config.enabled = true;
    const first = rowSet(1), second = rowSet(2); shared.db = database([first, second]);
    await runProgramTextWorker(["--mode=review", "--apply=true", "--cohort=award_2"]);
    expect(shared.provider).toEqual([second.candidate.id]);
  });
  it("does not submit a selected candidate after current policy approval is revoked", async () => {
    const current = rowSet(1); shared.db = database([current], { approved: false });
    const report = await runProgramTextWorker(["--mode=review", "--apply=true", "--pilot=true", `--source-id=${current.source.id}`]);
    expect(shared.provider).toEqual([]);
    expect(report.results).toEqual([{ candidate_id: current.candidate.id, status: "held", reason: "review_state_or_transport_failed" }]);
    expect(shared.db.calls.filter(call => call.rpc)).toEqual([{ rpc: "get_program_text_fact_review_batch", params: undefined }, { rpc: "program_text_source_is_approved", params: { p_source_id: current.source.id } }]);
  });
  it("an empty cohort never scans the global review queue", async () => {
    shared.config.enabled = true; shared.db = database([rowSet(1)]);
    const report = await runProgramTextWorker(["--mode=review", "--apply=true", "--cohort=absent"]);
    expect(report.results).toEqual([]); expect(shared.provider).toEqual([]);
    expect(shared.db.calls.some(call => call.table === "shared_award_visual_review_candidates")).toBe(false);
  });
  it("new-page compatibility dispatch remains a report with no legacy intake/model work", async () => {
    shared.config.enabled = true; shared.db = database([rowSet(1)]);
    const report = await runProgramTextWorker(["--mode=new_page_review", "--apply=true"]);
    expect(report.results).toEqual([]); expect(shared.provider).toEqual([]); expect(shared.captureCalls).toEqual([]); expect(shared.destroyed).toBe(0);
  });
  it("collection reports first coverage without invoking review/publication", async () => {
    const current = rowSet(1); current.source.text_monitoring_state = {}; shared.db = database([current]);
    const report = await runProgramTextWorker(["--mode=collect", "--apply=true", "--pilot=true", `--source-id=${current.source.id}`, "--domain-delay-ms=0"]);
    expect(shared.captureCalls).toEqual([current.source.id]); expect(shared.provider).toEqual([]);
    expect(report.results[0]).toMatchObject({ status: "baseline_ready", initial_coverage: true });
  });
});
