import { describe, expect, it, vi } from "vitest";
import { buildProgramTextCapture } from "./program-text-capture.mjs";
import { programTextReference } from "./program-text-storage.mjs";
import { buildProgramTextComparison, buildProgramTextReviewPackets } from "./program-text-review.mjs";
import { createProgramTextRepository, programTextCandidateWork } from "./program-text-repository.mjs";

const source = { id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222", url: "https://example.org/award", title: "Example Award", page_type: "application" };
const epoch = "33333333-3333-4333-8333-333333333333", id = "44444444-4444-4444-8444-444444444444", token = "55555555-5555-4555-8555-555555555555";
function capture(day, date) {
  const text = `Application deadline is March ${day}, 2027. Applicants must enroll full time.`;
  return buildProgramTextCapture({ source, acquisition: "http_html", raw_bytes: Buffer.from(`<html><body>${text}</body></html>`), content_type: "text/html", text,
    blocks: [{ id: "deadline", text, start_utf16: 0, end_utf16: text.length, heading: "Deadline" }], extractor: { name: "fixture", version: "1" }, captured_at: date });
}
function fixture() {
  const before = capture(15, "2026-10-23T01:00:00.000Z"), after = capture(20, "2026-10-23T01:01:00.000Z"), comparison = buildProgramTextComparison(before, after, { epoch, cycle_id: "2027" });
  const work = { schema: "awardping.program-text-review-work.v1", id, source, epoch, cycle_id: "2027", previous_ref: programTextReference(before), current_ref: programTextReference(after), comparison, packet_plan: buildProgramTextReviewPackets(comparison) };
  const row = { id, candidate_scope: "program_text_change", candidate_signature: comparison.comparison_id, shared_award_source_id: source.id,
    shared_award_id: source.shared_award_id, source_url: source.url, previous_snapshot_ref: work.previous_ref, new_snapshot_ref: work.current_ref,
    previous_image_hash: null, new_image_hash: null, previous_file_hash: null, new_file_hash: null,
    worker_metadata: { monitoring_contract: "program-text-v1", epoch, evidence_signature: comparison.comparison_id, bucket: "private-bucket" },
    prompt_payload: { program_identity: { award_id: source.shared_award_id, award_name: "Example Award", source_url: source.url, source_title: source.title }, comparison, packet_plan: work.packet_plan }, status: "pending" };
  const state = { schema: "awardping.program-text-state.v1", epoch, status: "awaiting_review", baseline_ref: work.previous_ref, latest_ref: work.current_ref,
    last_checked_at: after.captured_at, first_captured_at: before.captured_at, successful_checks: 2 };
  return { before, after, work, row, state, sourceRow: { ...source, admin_review_status: "open", text_monitoring_state: state } };
}
function fake(outcomes = []) {
  const calls = [], database = { calls, rpc(name, params) { calls.push({ rpc: name, params }); return Promise.resolve(outcomes.shift()); }, from(table) {
    const call = { table, operation: "select", filters: [] }; calls.push(call);
    const query = {
      select(columns) { call.select = columns; return query; }, eq(...args) { call.filters.push(["eq", ...args]); return query; },
      in(...args) { call.filters.push(["in", ...args]); return query; }, order(value) { call.order = value; return query; }, limit(value) { call.limit = value; return query; },
      insert(payload) { call.operation = "insert"; call.payload = payload; return query; }, update(payload) { call.operation = "update"; call.payload = payload; return query; },
      single() { call.single = true; return query; }, then(yes, no) { if (!outcomes.length) return Promise.reject(new Error("Missing fake database response")).then(yes, no); return Promise.resolve(outcomes.shift()).then(yes, no); },
    }; return query;
  } }; return database;
}
const repo = (db, f = fixture(), options = {}) => createProgramTextRepository(db, { bucket: "private-bucket", sourceIsApproved: async () => true,
  loadAward: async id => ({ id, name: "Example Award", status: "active" }), loadCapture: vi.fn(async ref => ref.capture_id === f.before.capture_id ? f.before : f.after), ...options });

describe("program text repository state and queue", () => {
  it("passes exact expected and next eight-field source state to the CAS RPC", async () => {
    const f = fixture(), db = fake([{ data: f.state }]);
    expect(await repo(db, f).compareAndSetState({ source_id: source.id, expected_state: {}, next_state: f.state })).toEqual(f.state);
    expect(db.calls).toEqual([{ rpc: "set_program_text_source_state", params: { p_source_id: source.id, p_expected_state: {}, p_next_state: f.state } }]);
    expect(Object.keys(f.state)).toHaveLength(8);
  });
  it("preserves SQL CAS failures without retrying or resetting", async () => {
    const db = fake([{ error: { code: "40001", message: "private details" } }]);
    await expect(repo(db).compareAndSetState({ source_id: source.id, expected_state: {}, next_state: fixture().state })).rejects.toThrow("40001");
    expect(db.calls).toHaveLength(1);
  });
  it("stores immutable old/new references, packets, epoch and null visual claims", async () => {
    const f = fixture(), db = fake([{ data: { id } }]);
    expect(await repo(db, f).enqueueReview(f.work)).toEqual({ id });
    const row = db.calls[0].payload;
    expect(row).toMatchObject({ candidate_scope: "program_text_change", candidate_signature: f.work.comparison.comparison_id, status: "pending",
      previous_snapshot_ref: f.work.previous_ref, new_snapshot_ref: f.work.current_ref, previous_image_hash: null, new_image_hash: null, previous_file_hash: null, new_file_hash: null });
    expect(row.prompt_payload).toEqual({ program_identity: { award_id: source.shared_award_id, award_name: "Example Award", source_url: source.url, source_title: source.title }, comparison: f.work.comparison, packet_plan: f.work.packet_plan });
    expect(row.worker_metadata).toMatchObject({ monitoring_contract: "program-text-v1", epoch, bucket: "private-bucket" });
  });
  it("returns an identical unique-race candidate without rewriting or retrying it", async () => {
    const f = fixture(), db = fake([{ error: { code: "23505" } }, { data: { ...f.row, status: "failed" } }]);
    expect(await repo(db, f).enqueueReview(f.work)).toEqual({ id });
    expect(db.calls.map(call => call.operation)).toEqual(["insert", "select"]);
  });
  it.each([
    row => { row.shared_award_source_id = token; }, row => { row.shared_award_id = token; }, row => { row.source_url = "https://example.org/wrong"; },
    row => { row.worker_metadata = { ...row.worker_metadata, epoch: token }; },
    row => { row.worker_metadata = { ...row.worker_metadata, bucket: "other-bucket" }; },
    row => { row.prompt_payload = { ...row.prompt_payload, packet_plan: {} }; },
  ])("rejects an inconsistent unique-race row %#", async mutate => {
    const f = fixture(); mutate(f.row);
    const db = fake([{ error: { code: "23505" } }, { data: f.row }]);
    await expect(repo(db, f).enqueueReview(f.work)).rejects.toThrow("identity conflict");
  });
  it("lists only explicitly scoped source IDs and the current configuration epoch", async () => {
    const db = fake([{ data: [] }]);
    await repo(db).listCandidates(["pending", "submitted"], 10, { source_ids: [source.id], epoch });
    expect(db.calls[0].filters).toContainEqual(["in", "shared_award_source_id", [source.id]]);
    expect(db.calls[0].filters).toContainEqual(["eq", "worker_metadata->>epoch", epoch]);
    expect(db.calls[0].filters).toContainEqual(["eq", "candidate_scope", "program_text_change"]);
  });
  it("never scans the global queue for an empty or omitted scope", async () => {
    const db = fake(); expect(await repo(db).listCandidates(["pending"])).toEqual([]);
    expect(await repo(db).listCandidates(["pending"], 10, { source_ids: [], epoch })).toEqual([]); expect(db.calls).toEqual([]);
  });
});

describe("saved-pair preflight and claims", () => {
  it("rechecks the current source policy through the service RPC before reading source or retained captures", async () => {
    const f = fixture(), db = fake([{ data: true }, { data: f.sourceRow }]);
    const loadCapture = vi.fn(async ref => ref.capture_id === f.before.capture_id ? f.before : f.after);
    expect(await repo(db, f, { sourceIsApproved: undefined, loadCapture }).verifyCandidate(f.row)).toBe(true);
    expect(db.calls[0]).toEqual({ rpc: "program_text_source_is_approved", params: { p_source_id: source.id } });
    expect(db.calls[1].table).toBe("shared_award_sources");
    expect(loadCapture).toHaveBeenCalledTimes(2);
  });
  it.each([false, null, "true"])("holds a no-longer-approved source before any source or raw capture read (%s)", async approved => {
    const f = fixture(), db = fake([{ data: approved }]), loadCapture = vi.fn();
    await expect(repo(db, f, { sourceIsApproved: undefined, loadCapture }).verifyCandidate(f.row)).rejects.toThrow("no longer approved");
    expect(db.calls).toEqual([{ rpc: "program_text_source_is_approved", params: { p_source_id: source.id } }]);
    expect(loadCapture).not.toHaveBeenCalled();
  });
  it("fails closed on approval RPC errors without exposing database details or reading captures", async () => {
    const f = fixture(), db = fake([{ error: { code: "42501", message: "private database details" } }]), loadCapture = vi.fn();
    await expect(repo(db, f, { sourceIsApproved: undefined, loadCapture }).verifyCandidate(f.row)).rejects.toThrow("verify source approval failed (42501)");
    expect(db.calls).toHaveLength(1); expect(loadCapture).not.toHaveBeenCalled();
  });
  it("re-verifies the live source, exact state pair, retained raw captures and complete saved plan", async () => {
    const f = fixture(), db = fake([{ data: f.sourceRow }]); expect(await repo(db, f).verifyCandidate(f.row)).toBe(true);
  });
  it.each([
    f => { f.sourceRow.admin_review_status = "review_later"; }, f => { f.sourceRow.url = "https://example.org/moved"; },
    f => { f.sourceRow.shared_award_id = token; }, f => { f.sourceRow.text_monitoring_state = {}; },
    f => { f.row.worker_metadata = { ...f.row.worker_metadata, evidence_signature: "0".repeat(64) }; },
    f => { f.row.worker_metadata = { ...f.row.worker_metadata, bucket: "other-bucket" }; },
    f => { f.row.new_image_hash = "0".repeat(64); },
    f => { f.row.prompt_payload = { ...f.row.prompt_payload, packet_plan: {} }; },
  ])("holds changed or malformed source/candidate identity before provider use %#", async mutate => {
    const f = fixture(); mutate(f); const db = fake([{ data: f.sourceRow }]);
    await expect(repo(db, f).verifyCandidate(f.row)).rejects.toThrow();
  });
  it("claims only pending text candidates and records an owned claim token", async () => {
    const f = fixture(), db = fake([{ data: [{ ...f.row, status: "processing" }] }]);
    await repo(db, f).claim(f.row, token, "gemini-3.8-flash");
    expect(db.calls[0].payload.worker_metadata.program_text_claim_token).toBe(token);
    expect(db.calls[0].filters).toContainEqual(["eq", "status", "pending"]);
    expect(db.calls[0].filters).toContainEqual(["eq", "candidate_scope", "program_text_change"]);
  });
  it("does not infer a successful claim from an empty CAS result", async () => {
    const f = fixture(), db = fake([{ data: [] }]); expect(await repo(db, f).claim(f.row, token, "gemini-3.8-flash")).toBeNull();
  });
  it("saves provider journal state only under the same active claim token", async () => {
    const f = fixture(), db = fake([{ data: [{ id }] }]);
    await repo(db, f).save(f.row, token, { status: "submitted", gemini_batch_name: "batches/abc" });
    expect(db.calls[0].filters).toContainEqual(["eq", "worker_metadata->>program_text_claim_token", token]);
    expect(db.calls[0].filters).toContainEqual(["in", "status", ["processing", "submitted"]]);
    expect(db.calls[0].payload.gemini_batch_name).toBe("batches/abc");
  });
  it("holds a lost claim and never retries the write", async () => {
    const f = fixture(), db = fake([{ data: [] }]); await expect(repo(db, f).save(f.row, token, { status: "failed" })).rejects.toThrow("claim lost");
    expect(db.calls).toHaveLength(1);
  });
});

describe("validated result and atomic publication adapters", () => {
  it("preserves all validated response packets, including no-change results", async () => {
    const f = fixture(), db = fake([{ data: [{ id }] }]), validation = { status: "no_program_change", comparison_id: f.row.candidate_signature, changes: [] }, responses = [{ packet_id: "one", blocks: [] }];
    expect(await repo(db, f).recordReviewResult({ candidate: f.work, validation, responses })).toEqual({ persisted: true });
    expect(db.calls[0].payload.ai_result).toEqual({ responses, program_text_validation: validation });
    expect(db.calls[0].filters).toContainEqual(["eq", "candidate_signature", f.row.candidate_signature]);
    expect(db.calls[0].filters).toContainEqual(["eq", "shared_award_source_id", source.id]);
    expect(db.calls[0].filters).toContainEqual(["eq", "worker_metadata->>epoch", epoch]);
  });
  it("builds one transaction request with deduplicated exact supporting blocks and no image data", async () => {
    const f = fixture(), db = fake([{ data: { published: true, event_id: token } }]), details = { schema: "awardping.program-change.v1", summary: "Deadline changed.", program_changes: [] };
    const work = { ...f.work, comparison: { ...f.work.comparison, changed_blocks: [...f.work.comparison.changed_blocks, ...f.work.comparison.changed_blocks] } };
    await repo(db, f).publishProgramChange({ candidate: work, validation: { status: "accepted", details } });
    expect(db.calls).toHaveLength(1); expect(db.calls[0].rpc).toBe("publish_program_text_event");
    expect(db.calls[0].params.p_localization.supporting_blocks.previous).toHaveLength(1);
    expect(db.calls[0].params.p_localization.supporting_blocks.current).toHaveLength(1);
    expect(db.calls[0].params.p_details).toEqual(details); expect(JSON.stringify(db.calls)).not.toMatch(/page\.jpg|crop|thumbnail/);
  });
  it("maps persisted work back to the same source, epoch and complete packet plan", () => {
    const f = fixture(); expect(programTextCandidateWork(f.row)).toEqual(f.work);
  });
});
