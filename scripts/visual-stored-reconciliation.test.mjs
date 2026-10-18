import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { findBlockingPriorVisualPublication } from "./lib/visual-publication-order.mjs";

const worker = readFileSync(new URL("./process-visual-review-batch.mjs", import.meta.url), "utf8");
function declaration(name, nextName) {
  const start = worker.indexOf(`async function ${name}(`);
  const end = worker.indexOf(`async function ${nextName}(`, start + 1);
  if (start < 0 || end <= start) throw new Error("worker_function_boundary_missing");
  return worker.slice(start, end);
}
const pollCode = declaration("pollExistingBatches", "recoverRejectedInitialOfficialDocumentCandidates");
const retryCode = declaration("reconcileStoredSucceededCandidates", "submitPendingCandidates");
const scheduleStart = worker.indexOf("  if (poll && !submitOnly) {");
const scheduleEnd = worker.indexOf("  await refreshStatusCounts();", scheduleStart);
if (scheduleStart < 0 || scheduleEnd <= scheduleStart) throw new Error("worker_schedule_boundary_missing");
const scheduleCode = worker.slice(scheduleStart, scheduleEnd);
const INITIAL = "initial_official_document";
const CHANGED = "changed_page_review";

function candidate(id, overrides = {}) {
  return {
    id, shared_award_source_id: "source-1", candidate_scope: "page",
    status: "succeeded", ai_result: { meaningful: true }, actual_usage: {},
    created_at: `2026-10-18T00:0${id === "older" ? "0" : "1"}:00Z`,
    new_snapshot_ref: { capture_dir: { archive_relative: `sources/source-1/captures/${id}` } },
    ...overrides,
  };
}

// Execute the actual scheduling block and two declarations, never the entry point.
// All I/O boundaries are in-memory fakes; no credentials, DB, or provider calls.
function harness({ rows = [], apply = true, lane = CHANGED, recoverIds = [], publisher, claim,
  poll = true, submit = true, pollOnly = false, submitOnly = false, limit = 100,
  allowProvider = false, clock = { now: Date.parse("2026-10-18T17:00:00Z") } } = {}) {
  const queries = [];
  const events = [];
  const limits = [];
  const report = { batches: [], errors: [], published: 0, publish_duplicates: 0,
    publication_claim_conflicts: 0, publication_claims_acquired: 0,
    recovered_stale_publication_claims: 0, baseline_promotion_pending: 0,
    succeeded: 0, stored_publication_retry_errors: 0, processing_jobs: 0 };
  function query() {
    const filters = [];
    let start = 0;
    let count = Infinity;
    const q = {
      select: () => q,
      eq: (key, value) => { filters.push(row => row[key] === value); return q; },
      neq: (key, value) => { filters.push(row => row[key] !== value); return q; },
      in: (key, values) => { filters.push(row => values.includes(row[key])); return q; },
      not: (key, op, value) => { expect(op).toBe("is"); filters.push(row => row[key] != value); return q; },
      or: value => { expect(value).toContain("publication_claim_token.is.null"); return q; },
      order: () => q,
      limit: value => { count = value; limits.push(value); return q; },
      range: (from, to) => { start = from; count = to - from + 1; return q; },
      then: (resolve, reject) => Promise.resolve({ data: rows.filter(row => filters.every(f => f(row))).slice(start, start + count), error: null }).then(resolve, reject),
    };
    queries.push(q);
    return q;
  }
  const recover = vi.fn(async () => { events.push("initial-recovery"); return recoverIds; });
  const publish = vi.fn(async args => {
    events.push("stored-retry");
    if (publisher) return publisher(args);
    args.candidate.status = "published";
    return { status: "published" };
  });
  const claimPublication = vi.fn(claim || (async row => ({ acquired: true, recovered: false, candidate: row, claim_token: "fake-claim" })));
  const provider = vi.fn(async () => {
    if (!allowProvider) throw new Error("unexpected_provider_request");
    events.push("provider-poll");
    return { state: "BATCH_STATE_RUNNING" };
  });
  const submitPending = vi.fn(async () => { events.push("submit-pending"); });
  class ClockDate extends Date { static now() { return clock.now; } }
  const deps = {
    apply, paidLane: lane, GEMINI_PAID_LANES: { CHANGED_PAGE_REVIEW: CHANGED },
    poll, submit, pollOnly, submitOnly, Date: ClockDate,
    submitPendingCandidates: submitPending,
    recoverRejectedInitialOfficialDocumentCandidates: recover,
    recoverMissingBatchResponses: true,
    supabase: { from: table => { expect(table).toBe("shared_award_visual_review_candidates"); return query(); } },
    applyPaidLaneCandidateScopeFilter: q => lane === CHANGED ? q.neq("candidate_scope", INITIAL) : q.eq("candidate_scope", INITIAL),
    unique: values => [...new Set(values)], fetchGeminiJson: provider, report,
    geminiBatchState: job => job.state, isGeminiBatchDone: () => false,
    markBatchRowsProcessing: async () => {},
    publicationClaimStaleMinutes: 10, limit,
    objectValue: value => value && typeof value === "object" ? value : {},
    loadSourcesById: async ids => new Map(ids.map(id => [id, { id }])),
    INITIAL_OFFICIAL_DOCUMENT_SCOPE: INITIAL, normalizeGeminiUsage: value => value,
    claimCompletedCandidatePublication: claimPublication, publishCandidateResult: publish,
    errorMessage: error => error.message, truncate: text => text,
  };
  const run = new Function(...Object.keys(deps), `${pollCode}\n${retryCode}\nreturn async function runSchedulingBlock() {\n${scheduleCode}\n};`)(...Object.values(deps));
  return { run, report, recover, publish, provider, claimPublication, queries, submitPending, events, limits };
}

describe("stored succeeded reconciliation orchestration", () => {
  it("retries a changed-page answer without any active provider batch, once only", async () => {
    const row = candidate("changed", { rejection_reason: "publish_retry_pending:event_evidence_not_durable" });
    const h = harness({ rows: [row, candidate("initial", { candidate_scope: INITIAL })] });
    await h.run();
    await h.run();
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0][0].candidate.id).toBe("changed");
    expect(h.report.published).toBe(1);
    expect(h.provider).not.toHaveBeenCalled();
  });

  it("retains a source-order hold and retries its stored answer after the predecessor settles", async () => {
    const older = candidate("older", { status: "pending" });
    const newer = candidate("newer", { rejection_reason: "source_publication_order_pending:older" });
    const h = harness({ rows: [older, newer], publisher: async ({ candidate: row }) => {
      const blocker = findBlockingPriorVisualPublication(row, [older]);
      if (blocker) return { status: "retry_pending" };
      row.status = "published";
      return { status: "published" };
    } });
    await h.run();
    expect(newer.status).toBe("succeeded");
    expect(h.report.baseline_promotion_pending).toBe(1);
    older.status = "published";
    await h.run();
    expect(h.report.published).toBe(1);
    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.provider).not.toHaveBeenCalled();
  });

  it("respects the publication claim and does not attempt duplicate publication", async () => {
    const h = harness({ rows: [candidate("claimed")], claim: async () => ({ acquired: false }) });
    await h.run();
    expect(h.report.publication_claim_conflicts).toBe(1);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.provider).not.toHaveBeenCalled();
  });

  it("counts an existing immutable event as duplicate without counting a new publication", async () => {
    const h = harness({ rows: [candidate("duplicate")], publisher: async ({ candidate: row }) => {
      row.status = "published";
      return { status: "duplicate" };
    } });
    await h.run();
    await h.run();
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.report.published).toBe(0);
    expect(h.report.publish_duplicates).toBe(1);
    expect(h.provider).not.toHaveBeenCalled();
  });

  it("keeps initial-document recovery confined to the new-page lane", async () => {
    const h = harness({ lane: "new_page_review", rows: [candidate("changed"), candidate("initial", { candidate_scope: INITIAL })], recoverIds: ["initial"] });
    await h.run();
    expect(h.recover).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0][0].candidate.id).toBe("initial");
    expect(h.provider).not.toHaveBeenCalled();
  });

  it("does not reconcile or recover when apply is false", async () => {
    const h = harness({ apply: false, rows: [candidate("changed")] });
    await h.run();
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.claimPublication).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.provider).not.toHaveBeenCalled();
  });

  it("polls accepted batches and submits pending work before changed-page stored recovery", async () => {
    const h = harness({ allowProvider: true, rows: [candidate("stored"), candidate("batch", {
      status: "submitted", gemini_batch_name: "batches/fake",
    })] });
    await h.run();
    expect(h.events).toEqual(["provider-poll", "submit-pending", "stored-retry"]);
    expect(h.report.processing_jobs).toBe(1);
  });

  it("retains initial-document recovery before provider polling and submission", async () => {
    const h = harness({ lane: "new_page_review", allowProvider: true,
      rows: [candidate("initial", { candidate_scope: INITIAL }), candidate("batch", {
        candidate_scope: INITIAL, status: "submitted", gemini_batch_name: "batches/fake",
      })] });
    await h.run();
    expect(h.events).toEqual(["initial-recovery", "stored-retry", "provider-poll", "submit-pending"]);
    expect(h.limits).toContain(500);
  });

  it.each([7, 100, 250])("caps changed-page stored rows at min(limit=%i,100)", async limit => {
    const rows = Array.from({ length: 101 }, (_, i) => candidate(`row-${i}`));
    const h = harness({ rows, limit });
    await h.run();
    expect(h.publish).toHaveBeenCalledTimes(Math.min(limit, 100));
    expect(h.limits).toEqual([Math.min(limit, 100)]);
    expect(rows.filter(row => row.status === "succeeded")).toHaveLength(101 - Math.min(limit, 100));
  });

  it("finishes an in-flight publication and leaves later rows unclaimed after the60-second budget", async () => {
    const clock = { now: Date.parse("2026-10-18T17:00:00Z") };
    const first = candidate("first"), next = candidate("next");
    const h = harness({ rows: [first, next], clock, publisher: async ({ candidate: row }) => {
      clock.now += 60_001;
      row.status = "published";
      return { status: "published" };
    } });
    await h.run();
    expect(h.claimPublication).toHaveBeenCalledTimes(1);
    expect(first.status).toBe("published");
    expect(next.status).toBe("succeeded");
    expect(next.publication_claim_token).toBeUndefined();
    await h.run();
    expect(h.claimPublication).toHaveBeenCalledTimes(2);
    expect(next.status).toBe("published");
  });

  it("recovers in poll-only mode without submitting new work", async () => {
    const h = harness({ pollOnly: true, rows: [candidate("stored")] });
    await h.run();
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.submitPending).not.toHaveBeenCalled();
  });

  it.each([{ submitOnly: true }, { poll: false }, { apply: false }])("does not recover in disabled mode %j", async flags => {
    const h = harness({ ...flags, rows: [candidate("stored")] });
    await h.run();
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.claimPublication).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });
});
