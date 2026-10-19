import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as queue from "./lib/visual-review-queue.mjs";
import { sourceQualityDecision } from "./lib/source-quality.mjs";
import { buildLegacyReviewCompleteness, legacyReviewCompletenessDecision } from "./lib/legacy-review-completeness.mjs";
import {
  paidVisualReviewLaneForCandidate,
  runPaidVisualProviderCreateBoundary,
} from "./lib/paid-visual-review-policy.mjs";

// Execute actual worker functions, never the credential-loading entrypoint.
// The real rebuild/source-quality checks run; transport and atomic RPC outcomes
// are in-memory doubles. SQL lock/fingerprint tests remain in the migration suite.
const workerPath = new URL("./process-visual-review-batch.mjs", import.meta.url);
const worker = readFileSync(workerPath, "utf8");
const ast = ts.createSourceFile(workerPath.pathname, worker, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declarations = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name.text, node.getText(ast)]));
const names = ["requeueRetryableFailures", "paidRetryRequestPreflight", "paidRetryCanonicalJson",
  "loadSourcesById", "preSubmissionRejectReason", "persistPendingCandidateForCurrentPolicy",
  "chunks", "unique", "cleanText", "cleanNullable", "objectValue"];
const code = names.map((name) => { if (!declarations.has(name)) throw new Error(name); return declarations.get(name); }).join("\n");
const changedLane = "changed_page_review", initialLane = "new_page_review";

function fixture(scope = "content_change") {
  const source = {
    id: "33333333-3333-4333-8333-333333333333", shared_award_id: "22222222-2222-4222-8222-222222222222",
    url: "https://example.edu/scholarships/example-award/apply", title: "Example Award Application",
    page_type: "application", admin_review_status: "open", shared_awards: { name: "Example Award" },
    page_metadata_generated_at: "2026-10-18T00:00:00.000Z", page_metadata_model: "offline-fixture",
    page_metadata: { baseline_facts: { award_relevance: "primary", cycle_relevance: "current_or_upcoming",
      display_title: "Example Award Application", quality_flags: [], important_dates: [{ date: "March 15, 2027", label: "Deadline" }] } },
  };
  const candidate = {
    id: "11111111-1111-4111-8111-111111111111", shared_award_source_id: source.id, shared_award_id: source.shared_award_id,
    status: "failed", updated_at: "2026-10-18T12:00:00.000Z", candidate_scope: scope,
    source_url: source.url, source_title: source.title, source_page_type: source.page_type,
    previous_text_hash: "a".repeat(64), new_text_hash: "b".repeat(64),
    deterministic_diff: { added_text: ["Deadline: March 15, 2027"], removed_text: ["Deadline: March 1, 2027"] },
    prompt_payload: { include_images: false, new_text_excerpt: "Deadline: March 15, 2027",
      previous_text_excerpt: "Deadline: March 1, 2027" },
    gemini_batch_name: "batches/previous-failed-attempt", model: "gemini-2.5-flash-lite",
    submitted_at: "2026-10-17T12:00:00.000Z", completed_at: "2026-10-18T12:00:00.000Z",
    ai_result: { original_error: { code: 5, message: "Requested entity was not found." } },
    actual_usage: { retained_original: true }, rejection_reason: "Requested entity was not found.",
    worker_metadata: { failure_retry_count: 0, original_provider_receipt: "preserve-me" },
  };
  // A newly authored synthetic retry fixture, not certification of an old
  // provider packet. Preserve its complete text and exact producer binding.
  const sha = text => createHash("sha256").update(text).digest("hex");
  candidate.previous_text_hash = sha(candidate.prompt_payload.previous_text_excerpt);
  candidate.new_text_hash = sha(candidate.prompt_payload.new_text_excerpt);
  candidate.deterministic_diff.legacy_review_completeness = buildLegacyReviewCompleteness({ source,
    previousText: candidate.prompt_payload.previous_text_excerpt, currentText: candidate.prompt_payload.new_text_excerpt,
    diff: candidate.deterministic_diff, excludedChangedUnits: 0 });
  Object.assign(candidate.prompt_payload, { deterministic_diff: candidate.deterministic_diff,
    hashes: { previous_text_hash: candidate.previous_text_hash, new_text_hash: candidate.new_text_hash },
    text_evidence: { added_text: candidate.deterministic_diff.added_text, removed_text: candidate.deterministic_diff.removed_text,
      date_changes: [], amount_changes: [] } });
  const rebuilt = queue.rebuildVisualReviewCandidateForCurrentPolicy(candidate, { source });
  Object.assign(candidate, { candidate_signature: rebuilt.candidate_signature,
    gemini_batch_request_key: rebuilt.candidate_signature, prompt_payload: structuredClone(rebuilt.prompt_payload), prompt_context: rebuilt.prompt_context });
  const approval = {
    id: "44444444-4444-4444-8444-444444444444", candidate_id: candidate.id,
    candidate_updated_at: candidate.updated_at, status: "approved", lane_key: paidVisualReviewLaneForCandidate(candidate),
    approved_at: "2026-10-18T13:00:00.000Z", expires_at: "2099-10-19T13:00:00.000Z",
  };
  return { source, candidate, approval };
}

function harness(f = fixture(), { lane = changedLane, beforeConsume = null, consumeOutcome = null, rebuild = queue.rebuildVisualReviewCandidateForCurrentPolicy } = {}) {
  const tables = { gemini_paid_retry_approvals: [f.approval], shared_award_visual_review_candidates: [f.candidate], shared_award_sources: [f.source] };
  const reads = [], writes = [], rpcCalls = [];
  const supabase = { from(table) {
    const filters = [], clauses = []; const query = {
      select(columns) { clauses.push(["select", columns]); return query; },
      eq(key, value) { clauses.push(["eq", key, value]); filters.push((row) => row[key] === value); return query; },
      gt(key, value) { clauses.push(["gt", key, value]); filters.push((row) => Date.parse(row[key]) > Date.parse(value)); return query; },
      in(key, values) { clauses.push(["in", key, values]); filters.push((row) => values.includes(row[key])); return query; },
      order() { return query; }, limit() { return query; },
      update() { throw new Error("Preflight must never update a row"); },
      then(yes, no) {
        reads.push({ table, clauses: structuredClone(clauses) });
        return Promise.resolve({ data: structuredClone(tables[table].filter((row) => filters.every((filter) => filter(row)))), error: null }).then(yes, no);
      },
    }; return query;
  }, rpc: vi.fn(async (name, args) => {
    rpcCalls.push({ name, args: structuredClone(args) });
    if (name === "invalidate_visual_review_paid_retry_for_request_drift") return { data: { invalidated: true }, error: null };
    if (name !== "consume_visual_review_paid_retry_approval") throw new Error(`Unexpected RPC: ${name}`);
    if (beforeConsume) beforeConsume(tables);
    if (consumeOutcome) return { data: consumeOutcome, error: null };
    // Deliberately a transport double, not a replacement/claim of SQL coverage.
    const row = tables.shared_award_visual_review_candidates.find((item) => item.id === args.p_candidate_id);
    const approval = tables.gemini_paid_retry_approvals.find((item) => item.candidate_id === args.p_candidate_id && item.status === "approved");
    if (!row || !approval || row.status !== "failed" || row.updated_at !== args.p_expected_candidate_updated_at) {
      return { data: { requeued: false, reason: "candidate_failure_changed" }, error: null };
    }
    row.status = "pending"; approval.status = "consumed";
    row.worker_metadata = { ...row.worker_metadata, failure_retry_count: row.worker_metadata.failure_retry_count + 1,
      paid_retry_approval_id: approval.id, paid_retry_approved_request_fingerprint: "c".repeat(64) };
    writes.push({ candidate_id: row.id, approval_id: approval.id });
    return { data: { requeued: true }, error: null };
  }) };
  const report = { retried_failed_candidates: 0, paid_retry_approvals_required: 0, paid_retry_preflight_held: 0,
    paid_retry_preflight_holds: [], paid_retry_request_drift_invalidated: 0, superseded: 0 };
  const actual = runInNewContext(`${code}\n({${names.join(",")}})`, { ...queue, sourceQualityDecision,
    legacyReviewCompletenessDecision,
    rebuildVisualReviewCandidateForCurrentPolicy: rebuild,
    paidReviewLaneForCandidate: paidVisualReviewLaneForCandidate, paidLane: lane, limit: 10, supabase, report,
    monitoringPolicy: queue.currentVisualReviewPolicyIdentity(), monitoringPolicyBundle: queue.currentMonitoringPolicyAuditIdentity(),
    markCandidate: () => { throw new Error("Unexpected candidate mutation"); },
  });
  return { ...f, actual, tables, report, reads, writes, rpcCalls, supabase };
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
}

const driftCases = [
  ["prompt instruction", (f) => { f.candidate.prompt_context = f.candidate.prompt_context.replace(/^Use only the canonical changed_facts.*\n/m, ""); }, "prompt_context"],
  ["audit policy only", (f) => { f.candidate.prompt_payload.monitoring_policy_bundle.hash = "fnv1a32x2-utf16:ea1844b640c3ccfa"; }, "prompt_payload"],
  ["scoped policy", (f) => { f.candidate.prompt_payload.monitoring_policy.hash = "fnv1a32x2-utf16:0000000000000000"; }, "prompt_payload"],
  ["signature", (f) => { f.candidate.candidate_signature = "d".repeat(64); }, "candidate_signature"],
  ["batch key", (f) => { f.candidate.gemini_batch_request_key = "d".repeat(64); }, "gemini_batch_request_key"],
  ["source title", (f) => { f.source.title = "Updated Example Award Application"; }, "source_title"],
  ["source page type", (f) => { f.source.page_type = "eligibility"; }, "source_page_type"],
  ["current baseline fact", (f) => { f.source.page_metadata.baseline_facts.important_dates[0].date = "March 16, 2027"; }, "prompt_payload"],
  ["current award name", (f) => { f.source.shared_awards.name = "Renamed Example Award"; }, "prompt_payload"],
  ["payload scalar type", (f) => { f.candidate.prompt_payload.source.baseline_facts.quality_flags = ""; }, "prompt_payload"],
];

describe("paid retry current-request preflight (actual worker / no external operations)", () => {
  it.each(driftCases)("holds %s before consumption, preserving all failed-request and approval bytes", async (_name, change, field) => {
    const f = fixture(); change(f); const h = harness(f), before = structuredClone(h.tables);
    await h.actual.requeueRetryableFailures();
    expect(h.report.paid_retry_preflight_held).toBe(1);
    expect(h.report.paid_retry_preflight_holds[0]).toMatchObject({ reason: "paid_retry_current_request_drift", changed_fields: expect.arrayContaining([field]) });
    expect(h.report.retried_failed_candidates).toBe(0); expect(h.report.paid_retry_approvals_required).toBe(0);
    expect(h.tables).toEqual(before); expect(h.writes).toEqual([]); expect(h.supabase.rpc).not.toHaveBeenCalled();
  });
  it("allows canonical JSON key order differences, then consumes only once through the existing RPC", async () => {
    const f = fixture(); f.candidate.prompt_payload = reverseKeys(f.candidate.prompt_payload);
    f.source.page_metadata = reverseKeys(f.source.page_metadata);
    const h = harness(f);
    await h.actual.requeueRetryableFailures(); await h.actual.requeueRetryableFailures();
    expect(h.report.paid_retry_preflight_held).toBe(0); expect(h.report.retried_failed_candidates).toBe(1);
    expect(h.supabase.rpc).toHaveBeenCalledExactlyOnceWith("consume_visual_review_paid_retry_approval", {
      p_candidate_id: f.candidate.id, p_expected_candidate_updated_at: f.approval.candidate_updated_at,
    });
    expect(h.writes).toHaveLength(1); expect(f.candidate.worker_metadata.failure_retry_count).toBe(1);
  });
  it("returns immediately when no approved retries exist, without candidate/source reads", async () => {
    const h = harness(); h.tables.gemini_paid_retry_approvals = [];
    await h.actual.requeueRetryableFailures();
    expect(h.reads.map((read) => read.table)).toEqual(["gemini_paid_retry_approvals"]);
    expect(h.supabase.rpc).not.toHaveBeenCalled();
  });
  it("excludes already-expired approvals before candidate/source reads without changing their status", async () => {
    const h = harness(); h.approval.expires_at = "2000-01-01T00:00:00.000Z";
    const before = structuredClone(h.tables);
    await h.actual.requeueRetryableFailures();
    expect(h.reads.map((read) => read.table)).toEqual(["gemini_paid_retry_approvals"]);
    expect(h.tables).toEqual(before); expect(h.supabase.rpc).not.toHaveBeenCalled();
  });
  it.each(["2000-01-01T00:00:00Z", null, "invalid"])("holds expired/invalid expiry %s without a write", (expiresAt) => {
    const h = harness(); h.approval.expires_at = expiresAt;
    expect(h.actual.paidRetryRequestPreflight(h.candidate, h.source, h.approval).reason).toBe("paid_retry_approval_expired_or_invalid");
    expect(h.supabase.rpc).not.toHaveBeenCalled();
  });
  it("fails closed on a rebuild exception while preserving the original failure and approval", async () => {
    const h = harness(fixture(), { rebuild: () => { throw new Error("private input must not reach the report"); } });
    const before = structuredClone(h.tables);
    await h.actual.requeueRetryableFailures();
    expect(h.report.paid_retry_preflight_holds[0]).toMatchObject({ reason: "paid_retry_current_request_rebuild_failed", changed_fields: [] });
    expect(JSON.stringify(h.report)).not.toContain("private input");
    expect(h.tables).toEqual(before); expect(h.supabase.rpc).not.toHaveBeenCalled();
  });
  it("holds an exact candidate-ID mismatch before rebuilding or consuming", () => {
    const h = harness();
    expect(h.actual.paidRetryRequestPreflight({ ...h.candidate, id: "another-candidate" }, h.source, h.approval).reason)
      .toBe("paid_retry_candidate_version_unavailable");
  });
  it("loads only approved candidate IDs and uses actual current source metadata", async () => {
    const h = harness(); h.tables.shared_award_visual_review_candidates.push({ ...h.candidate, id: "unapproved" });
    await h.actual.requeueRetryableFailures();
    const candidateRead = h.reads.find((read) => read.table === "shared_award_visual_review_candidates");
    expect(candidateRead.clauses).toContainEqual(["in", "id", [h.candidate.id]]);
    expect(candidateRead.clauses).toContainEqual(["eq", "status", "failed"]);
    const sourceRead = h.reads.find((read) => read.table === "shared_award_sources");
    expect(sourceRead.clauses[0][1]).toContain("page_metadata");
    expect(sourceRead.clauses[0][1]).toContain("shared_awards(name)");
    expect(h.writes).toHaveLength(1);
  });
  it.each([
    ["missing candidate", (h) => { h.tables.shared_award_visual_review_candidates = []; }, "paid_retry_candidate_version_unavailable"],
    ["no longer failed", (h) => { h.candidate.status = "succeeded"; }, "paid_retry_candidate_version_unavailable"],
    ["new failed version", (h) => { h.candidate.updated_at = "2026-10-18T12:00:01.000Z"; }, "paid_retry_candidate_version_unavailable"],
    ["missing source", (h) => { h.tables.shared_award_sources = []; }, "paid_retry_source_unavailable"],
    ["source missing URL", (h) => { h.source.url = null; }, "paid_retry_source_unavailable"],
    ["source moved to another award", (h) => { h.source.shared_award_id = "different-award"; }, "paid_retry_source_binding_changed"],
    ["changed source URL", (h) => { h.source.url = "https://example.edu/another-award"; }, "source_url_changed_since_capture"],
    ["missing captured URL", (h) => { h.candidate.source_url = null; h.candidate.prompt_payload.source.url = null; }, "paid_retry_source_identity_unavailable"],
    ["source review closed", (h) => { h.source.admin_review_status = "review_later"; }, "source_not_open_review_later"],
    ["source quality changed", (h) => { h.source.page_metadata.baseline_facts.award_relevance = "unrelated"; }, /^source_quality_/],
    ["wrong paid lane", (h) => { h.candidate.candidate_scope = "initial_official_document"; }, "paid_retry_lane_mismatch"],
    ["missing prompt", (h) => { h.candidate.prompt_payload = null; }, "missing_prompt_payload"],
  ])("holds %s read-only", async (_name, change, reason) => {
    const h = harness(); change(h); const before = structuredClone(h.tables);
    await h.actual.requeueRetryableFailures();
    expect(h.report.paid_retry_preflight_held).toBe(1);
    if (reason instanceof RegExp) expect(h.report.paid_retry_preflight_holds[0].reason).toMatch(reason);
    else expect(h.report.paid_retry_preflight_holds[0].reason).toBe(reason);
    expect(h.tables).toEqual(before); expect(h.supabase.rpc).not.toHaveBeenCalled();
  });
  it("applies the same pre-consumption request check to initial-document paid retries", async () => {
    const f = fixture("initial_official_document"), h = harness(f, { lane: initialLane });
    expect(h.actual.paidRetryRequestPreflight(f.candidate, f.source, f.approval).allowed).toBe(true);
    f.candidate.prompt_context += "\nobsolete instruction";
    await h.actual.requeueRetryableFailures();
    expect(h.report.paid_retry_preflight_held).toBe(1); expect(h.supabase.rpc).not.toHaveBeenCalled();
  });
  it("treats array order as request material, not canonical key ordering", () => {
    const h = harness();
    expect(h.actual.paidRetryCanonicalJson({ values: [1, 2] })).not.toBe(h.actual.paidRetryCanonicalJson({ values: [2, 1] }));
    expect(h.actual.paidRetryCanonicalJson({ a: 1, b: { x: true, y: null } }))
      .toBe(h.actual.paidRetryCanonicalJson({ b: { y: null, x: true }, a: 1 }));
  });
  it.each(["candidate_failure_changed", "paid_retry_approval_required"])("does not retry or bypass atomic rejection %s after the read", async (reason) => {
    const h = harness(fixture(), { consumeOutcome: { requeued: false, reason } });
    await h.actual.requeueRetryableFailures();
    expect(h.supabase.rpc).toHaveBeenCalledTimes(1); expect(h.writes).toEqual([]);
    expect(h.report.retried_failed_candidates).toBe(0); expect(h.report.paid_retry_approvals_required).toBe(1);
  });
  it("keeps the exact observed version at the RPC boundary when a row changes after preflight", async () => {
    const h = harness(fixture(), { beforeConsume: (tables) => { tables.shared_award_visual_review_candidates[0].updated_at = "2026-10-18T14:00:00.000Z"; } });
    await h.actual.requeueRetryableFailures();
    expect(h.rpcCalls[0].args.p_expected_candidate_updated_at).toBe("2026-10-18T12:00:00.000Z");
    expect(h.writes).toEqual([]); expect(h.approval.status).toBe("approved");
  });
  it("retains post-consumption source drift invalidation before a candidate can be submitted", async () => {
    const h = harness(); await h.actual.requeueRetryableFailures();
    h.source.title = "Changed after the preflight read";
    expect(await h.actual.persistPendingCandidateForCurrentPolicy(h.candidate, h.source)).toBeNull();
    expect(h.rpcCalls.map((call) => call.name)).toEqual([
      "consume_visual_review_paid_retry_approval", "invalidate_visual_review_paid_retry_for_request_drift",
    ]);
    expect(h.report.paid_retry_request_drift_invalidated).toBe(1);
  });
  it("retains the final provider authorization boundary even after a successful preflight", async () => {
    const h = harness(); await h.actual.requeueRetryableFailures();
    const providerCreate = vi.fn();
    await expect(runPaidVisualProviderCreateBoundary({ journalCreateStart: async () => {},
      authorizeAtProviderBoundary: async () => ({ failures: [{ reason: "paid_retry_provider_request_drift" }] }),
      providerCreate })).rejects.toMatchObject({ paidRetryAuthorizationFailures: [{ reason: "paid_retry_provider_request_drift" }] });
    expect(providerCreate).not.toHaveBeenCalled();
  });
});
