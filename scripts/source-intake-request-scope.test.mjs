import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  SOURCE_INTAKE_SCOPE_LIMIT, sourceIntakeRequestScope, scopedSourceIntakeClient,
  sourceIntakeMembershipDecision, sourceIntakeScopeBindings,
} from "./lib/source-intake-request-scope.mjs";
import {
  extractGeminiBatchInlineResponses, geminiBatchInlineResponseKey,
  geminiBatchInlineResponseMap, geminiInlineError, geminiInlineResponsePayload,
  geminiBatchExactMappingComplete, geminiBatchUsageAccounting,
} from "./lib/gemini-batch-support.mjs";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const batch = "batches/exact-test";
const workerPath = resolve(import.meta.dirname, "process-source-intake-requests.mjs");
const worker = readFileSync(workerPath, "utf8");
const ast = ts.createSourceFile(workerPath, worker, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declarations = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name.text, node.getText(ast)]));
const row = (id, status = "pending", review = {}) => ({
  id, status, ai_review: review, updated_at: "2020-01-01T00:00:00Z", worker_run_id: null,
});

// In-memory PostgREST-shaped fixture: no worker entrypoint, credentials, network,
// provider, files or real Supabase. Execute actual worker function declarations.
function memoryClient(requests = [], reservations = []) {
  const tables = { source_page_requests: structuredClone(requests), gemini_spend_reservations: structuredClone(reservations) };
  const calls = [];
  const value = (item, field) => field.startsWith("ai_review->>") ? item.ai_review?.[field.slice(12)] : item[field];
  const client = {
    tables, calls, rpc: vi.fn(),
    from(table) {
      const filters = [];
      let patch = null, cap = Infinity, single = false, options = {};
      const query = {
        select(_fields, opts = {}) { options = opts; return query; },
        update(next) { patch = next; return query; },
        eq(field, expected) { filters.push((item) => value(item, field) === expected); return query; },
        is(field, expected) { return query.eq(field, expected); },
        in(field, expected) { filters.push((item) => expected.includes(value(item, field))); return query; },
        lt(field, expected) { filters.push((item) => value(item, field) < expected); return query; },
        contains(field, expected) { filters.push((item) => Object.entries(expected).every(([key, val]) => item[field]?.[key] === val)); return query; },
        filter(field, operator, expected) { return query[operator](field, expected); },
        order() { return query; },
        limit(next) { cap = next; return query; },
        maybeSingle() { single = true; return query; },
        then(yes, no) {
          const matching = (tables[table] || []).filter((item) => filters.every((filter) => filter(item)));
          const selected = matching.slice(0, cap);
          calls.push({ table, mutation: Boolean(patch), ids: selected.map((item) => item.id), count: matching.length });
          if (patch) selected.forEach((item) => Object.assign(item, structuredClone(patch)));
          const data = options.head ? null : structuredClone(single ? selected[0] || null : selected);
          return Promise.resolve({ data, count: matching.length, error: null }).then(yes, no);
        },
      };
      return query;
    },
  };
  return client;
}

const core = ["deferSourceIntakeScope", "sourceIntakeScopeAllowsWork", "objectValue", "cleanNullable", "withObservedUpdatedAt"];
function harness({ ids = [A], requests = [], reservations = [], functions = [], overrides = {} } = {}) {
  const raw = memoryClient(requests, reservations);
  const report = new Proxy({
    warnings: [], errors: [], requests: [], batches: [],
    stage_counts: Object.fromEntries(["capture", "submit", "poll", "reconcile"].map((key) => [key, { loaded: 0, eligible: 0, attempted: 0, completed: 0 }])),
  }, { get(target, key) { return key in target ? target[key] : 0; } });
  const context = {
    requestIds: ids, requestId: ids.length === 1 ? ids[0] : null,
    supabase: scopedSourceIntakeClient(raw, ids), unscopedSupabase: raw, report,
    SOURCE_INTAKE_SCOPE_LIMIT, sourceIntakeMembershipDecision, sourceIntakeScopeBindings,
    extractGeminiBatchInlineResponses, geminiBatchInlineResponseKey, geminiBatchInlineResponseMap,
    geminiBatchExactMappingComplete, geminiBatchUsageAccounting, geminiInlineError, geminiInlineResponsePayload,
    apply: true, limit: 100, statuses: ["pending"], maxRequestsPerBatch: 100,
    staleInFlightMs: 1000, maxBatchAgeMs: 1000, workerRunId: "fixture-worker",
    SOURCE_BACKFILL_APPROVAL_REQUEST_REASON: "fixture-approval-request",
    SOURCE_BACKFILL_APPROVAL_CLAIM_REASON: "fixture-approval-claim",
    hasTimeBudget: () => true, writeReport: vi.fn(),
    isApprovedLowCoverageSourceActivation: () => false,
    isProtectedLiveFirstCaptureRow: () => false,
    errorMessage: (error) => error.message,
    unique: (items) => [...new Set(items.filter(Boolean))],
    chunks: (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size)),
    ...overrides,
  };
  const names = [...new Set([...core, ...functions])];
  const code = names.map((name) => { if (!declarations.has(name)) throw new Error(`Missing actual function ${name}`); return declarations.get(name); }).join("\n");
  const actual = runInNewContext(`${code}\n({${names.join(",")}})`, context);
  return { raw, report, actual, context };
}

describe("exact source-intake request scope", () => {
  it("defaults to the original global client without added queries or wrappers", async () => {
    const client = memoryClient([row(A), row(B)]);
    expect(sourceIntakeRequestScope([])).toEqual([]);
    expect(scopedSourceIntakeClient(client, [])).toBe(client);
    const h = harness({ ids: [], requests: [row(A), row(B)], functions: ["loadTargetRows"] });
    expect((await h.actual.loadTargetRows()).map((item) => item.id)).toEqual([A, B]);
    expect(await h.actual.sourceIntakeScopeAllowsWork([row(C)])).toBe(true);
    expect(h.raw.calls).toHaveLength(1);
  });

  it("parses repeated exact UUIDs, normalizes and deduplicates", () => {
    expect(sourceIntakeRequestScope(["--request-id", B, `--request-id=${A}`, "--request-id", B.toUpperCase()])).toEqual([A, B]);
    for (const argv of [["--request-id"], ["--request-id="], ["--request-id", `${A},${B}`], ["--request-id", "all"], ["--request-ids", A]]) {
      expect(() => sourceIntakeRequestScope(argv)).toThrow();
    }
    expect(() => sourceIntakeRequestScope(Array(201).fill(`--request-id=${A}`))).toThrow(/Too many/);
  });

  it("constrains both reads and writes and delegates other tables and RPCs", async () => {
    const raw = memoryClient([row(A), row(B)]);
    const client = scopedSourceIntakeClient(raw, [A]);
    expect((await client.from("source_page_requests").select("*")).data.map((item) => item.id)).toEqual([A]);
    await client.from("source_page_requests").update({ status: "capturing" }).select("id");
    expect(raw.tables.source_page_requests.map((item) => item.status)).toEqual(["capturing", "pending"]);
    expect(client.from("source_page_requests").insert).toBeUndefined();
    await client.from("gemini_spend_reservations").select("id");
    client.rpc("fixture", { id: A });
    expect(raw.rpc).toHaveBeenCalledWith("fixture", { id: A });
  });

  it("fails closed on incomplete, invalid or outside membership and unknown reservation ownership", () => {
    for (const input of [
      { rows: [{ id: A }], count: 2 }, { rows: [], count: null }, { rows: [{ id: "bad" }], count: 1 },
      { rows: [{ id: B }], count: 1 },
      { rows: [{ request_count: 1, metadata: {} }], count: 1, reservation: true },
      { rows: [{ request_count: 2, metadata: { request_ids: [A, A] } }], count: 1, reservation: true },
      { rows: [{ request_count: 2, metadata: { request_ids: [A, B] } }], count: 1, reservation: true },
    ]) expect(sourceIntakeMembershipDecision([A], input).allowed).toBe(false);
    expect(sourceIntakeMembershipDecision([A], { rows: [{ request_count: 1, metadata: { request_ids: [A] } }], count: 1, reservation: true }).allowed).toBe(true);
  });

  it("binds both journaled/official batch names and all reservation/claim aliases", () => {
    const bindings = sourceIntakeScopeBindings([row(A, "pending", {
      gemini_batch_name: batch, possible_external_batch_name: "batches/journal",
      gemini_spend_reservation_id: "reservation", active_work_reservation_id: "active",
      gemini_spend_reservation_key: "key", submission_claim_token: "claim", gemini_spend_attempt_token: "attempt",
    })], batch);
    expect(bindings.requests).toContainEqual({ field: "possible_external_batch_name", value: batch, required: false });
    expect(bindings.requests).toContainEqual({ field: "gemini_spend_attempt_token", value: "claim", required: false });
    expect(bindings.reservations).toContainEqual({ field: "id", value: "active", required: true });
    expect(bindings.reservations).toContainEqual({ field: "reservation_key", value: "key", required: true });
    expect(bindings.reservations.filter((item) => item.field === "provider_batch_name" && item.value === batch)).toHaveLength(1);
  });

  it("actual capture and submission selection include only repeated selected IDs", async () => {
    for (const stage of ["capture", "submit"]) {
      const completed = [];
      const h = harness({ ids: [A, B], requests: [row(A, stage === "capture" ? "pending" : "ai_review_pending"), row(B, stage === "capture" ? "pending" : "ai_review_pending"), row(C, stage === "capture" ? "pending" : "ai_review_pending")],
        functions: stage === "capture" ? ["loadTargetRows", "capturePendingRequests"] : ["submitPendingAiRequests"],
        overrides: { processCaptureStage: async (item) => { completed.push(item.id); return true; }, submitAiReviewChunk: async (items) => { completed.push(...items.map((item) => item.id)); return items.length; } },
      });
      await h.actual[stage === "capture" ? "capturePendingRequests" : "submitPendingAiRequests"]();
      expect(completed).toEqual([A, B]);
    }
  });

  it("actual stale recovery requeues only a selected request", async () => {
    const h = harness({ requests: [row(A, "validating"), row(B, "validating")], functions: ["recoverStaleInFlightRequests"] });
    await h.actual.recoverStaleInFlightRequests();
    expect(h.raw.tables.source_page_requests.map((item) => item.status)).toEqual(["pending", "validating"]);
    expect(h.raw.calls.filter((call) => call.mutation).flatMap((call) => call.ids)).toEqual([A]);
  });

  it("actual stale-claim recovery defers a shared token before touching its spend reservation", async () => {
    const rows = [A, B].map((id) => ({ ...row(id, "needs_manual_review", { submission_claim_token: "shared" }), status_reason: "gemini_batch_submission_in_progress_fail_closed" }));
    const ledger = vi.fn(() => { throw new Error("Must not access reservation recovery"); });
    const h = harness({ requests: rows, functions: ["recoverStaleInFlightRequests"], overrides: { loadSourceIntakeSpendReservation: ledger } });
    await h.actual.recoverStaleInFlightRequests();
    expect(ledger).not.toHaveBeenCalled();
    expect(h.raw.calls.some((call) => call.mutation)).toBe(false);
    expect(h.report.scope_deferred_work).toBe(1);
  });

  it("actual stored-result reconciliation only claims and replays the selected request", async () => {
    const rows = [A, B].map((id) => ({ ...row(id, "ai_review_succeeded", { status: "accepted", raw: { safe: true } }), status_reason: "manual_reconciliation_retry_requested" }));
    const finalize = vi.fn();
    const capture = { retained_artifact: { r2_verified_at: "2026-10-18T00:00:00Z" } };
    const h = harness({ requests: rows, functions: ["processRequestedReconciliationRetries"], overrides: {
      captureFromRow: () => capture, validateSourceIntakeProviderReplayBinding: () => ({ capture }), finalizeReviewedRequest: finalize,
    } });
    await h.actual.processRequestedReconciliationRetries();
    expect(h.report.errors).toEqual([]);
    expect(finalize.mock.calls.map((args) => args[0].id)).toEqual([A]);
    expect(h.raw.tables.source_page_requests[1]).toEqual(rows[1]);
  });

  it("defers stored-result reconciliation for a mixed historical batch before claiming", async () => {
    const rows = [A, B].map((id) => ({ ...row(id, "ai_review_succeeded", { status: "accepted", gemini_batch_name: batch }), status_reason: "manual_reconciliation_retry_requested" }));
    const finalize = vi.fn();
    const h = harness({ requests: rows, functions: ["processRequestedReconciliationRetries"], overrides: { finalizeReviewedRequest: finalize } });
    await h.actual.processRequestedReconciliationRetries();
    expect(finalize).not.toHaveBeenCalled();
    expect(h.raw.calls.some((call) => call.mutation)).toBe(false);
    expect(h.report.scope_deferred_work).toBe(1);
  });
});

const pollFunctions = ["pollSubmittedBatch", "geminiBatchState", "isGeminiBatchDone", "isGeminiBatchSucceeded", "geminiBatchErrorMessage", "geminiBatchResponseMap", "settleSourceIntakeBatchSpend", "extractGeminiText", "claimSubmittedResponse"];
describe("actual mixed-batch defer boundary", () => {
  it.each(["ai_review_submitted", "accepted", "failed"])("includes outside %s members, and does not poll or mutate anything", async (status) => {
    const rows = [row(A, "ai_review_submitted", { gemini_batch_name: batch }), row(B, status, { gemini_batch_name: batch })];
    const provider = vi.fn();
    const h = harness({ requests: rows, functions: pollFunctions, overrides: { fetchGeminiJson: provider } });
    await h.actual.pollSubmittedBatch(batch, [rows[0]]);
    expect(provider).not.toHaveBeenCalled();
    expect(h.raw.calls.some((call) => call.mutation)).toBe(false);
    expect(h.raw.tables.source_page_requests).toEqual(rows);
    expect(h.report.warnings[0].reason).toBe("scope_shared_work_outside_selection");
  });

  it("defers outside reservation members even when no outside request row is returned", async () => {
    const selected = row(A, "ai_review_submitted", { gemini_batch_name: batch, gemini_spend_reservation_id: "reservation" });
    const reservation = { id: "reservation", provider_batch_name: batch, request_count: 2, metadata: { request_ids: [A, B] } };
    const provider = vi.fn();
    const h = harness({ requests: [selected], reservations: [reservation], functions: pollFunctions, overrides: { fetchGeminiJson: provider } });
    await h.actual.pollSubmittedBatch(batch, [selected]);
    expect(provider).not.toHaveBeenCalled();
    expect(h.raw.calls.some((call) => call.mutation)).toBe(false);
    expect(h.raw.tables.gemini_spend_reservations).toEqual([reservation]);
  });

  it("defers missing required reservation and truncated membership before provider access", async () => {
    const selected = row(A, "ai_review_submitted", { gemini_batch_name: batch, gemini_spend_reservation_id: "absent" });
    const h = harness({ requests: [selected], functions: pollFunctions, overrides: { fetchGeminiJson: vi.fn() } });
    await h.actual.pollSubmittedBatch(batch, [selected]);
    expect(h.context.fetchGeminiJson).not.toHaveBeenCalled();
    expect(h.report.warnings[0].reason).toBe("scope_reservation_membership_unproven");
    const crowded = Array.from({ length: 202 }, () => row(A, "accepted", { gemini_batch_name: batch }));
    const incomplete = harness({ requests: crowded });
    expect(await incomplete.actual.sourceIntakeScopeAllowsWork([crowded[0]], { batchName: batch })).toBe(false);
    expect(incomplete.report.warnings[0].reason).toBe("scope_membership_incomplete");
  });

  it("does not ingest an unexpected returned provider key or settle shared usage", async () => {
    const selected = row(A, "ai_review_submitted", { gemini_batch_name: batch });
    const provider = vi.fn(async () => ({ state: "JOB_STATE_SUCCEEDED", response: { inlinedResponses: [{ key: B }] } }));
    const h = harness({ requests: [selected], functions: pollFunctions, overrides: { fetchGeminiJson: provider } });
    await h.actual.pollSubmittedBatch(batch, [selected]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(h.raw.calls.some((call) => call.mutation)).toBe(false);
    expect(h.report.warnings[0].stage).toBe("scoped_batch_response_membership");
  });

  it.each(["request", "reservation"])("rechecks %s membership after provider GET before any result mutation", async (kind) => {
    const selected = row(A, "ai_review_submitted", { gemini_batch_name: batch });
    const h = harness({ requests: [selected], functions: pollFunctions });
    const provider = vi.fn(async () => {
      if (kind === "request") h.raw.tables.source_page_requests.push(row(B, "accepted", { gemini_batch_name: batch }));
      else h.raw.tables.gemini_spend_reservations.push({ id: "late", provider_batch_name: batch, request_count: 2, metadata: { request_ids: [A, B] } });
      return { state: "JOB_STATE_SUCCEEDED", response: { inlinedResponses: [{ key: A }] } };
    });
    // The VM holds the same context object: inject only the offline GET fixture.
    h.context.fetchGeminiJson = provider;
    await h.actual.pollSubmittedBatch(batch, [selected]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(h.raw.calls.some((call) => call.mutation)).toBe(false);
    expect(h.report.warnings[0].stage).toBe("scoped_batch_readback");
  });

  it.each(["error", "null_count"])("defers a %s membership read before provider or ledger access", async (kind) => {
    const selected = row(A, "ai_review_submitted", { gemini_batch_name: batch });
    const provider = vi.fn();
    const h = harness({ requests: [selected], functions: pollFunctions, overrides: { fetchGeminiJson: provider } });
    h.context.unscopedSupabase = { from: () => ({ select: () => ({ filter: () => ({ limit: async () => ({ data: [{ id: A }], count: null, error: kind === "error" ? { message: "offline failure" } : null }) }) }) }) };
    await h.actual.pollSubmittedBatch(batch, [selected]);
    expect(provider).not.toHaveBeenCalled();
    expect(h.raw.calls.some((call) => call.mutation)).toBe(false);
    expect(h.report.scope_deferred_work).toBe(1);
  });

  it("allows a complete selected-only historical batch to reconcile without another paid call", async () => {
    const rows = [A, B].map((id) => row(id, "ai_review_submitted", { gemini_batch_name: batch }));
    const provider = vi.fn(async () => ({ state: "JOB_STATE_SUCCEEDED", response: { inlinedResponses: rows.map((item) => ({ key: item.id, response: { candidates: [{ content: { parts: [{ text: '{"status":"accepted"}' }] } }] } })) } }));
    const finalize = vi.fn();
    const h = harness({ ids: [A, B], requests: [...rows, row(C)], functions: pollFunctions, overrides: {
      fetchGeminiJson: provider, captureFromRow: () => ({}), parseJsonObject: JSON.parse, finalizeReviewedRequest: finalize,
    } });
    await h.actual.pollSubmittedBatch(batch, rows);
    expect(h.report.errors).toEqual([]);
    expect(finalize.mock.calls.map((args) => args[0].id)).toEqual([A, B]);
    expect(provider.mock.calls.every((args) => args[1].method === "GET")).toBe(true);
    expect(h.raw.tables.source_page_requests[2]).toEqual(row(C));
  });

  it("guards expiry, rotation, failure, malformed recovery and settlement independently", async () => {
    const selected = row(A, "ai_review_submitted", { possible_external_batch_name: batch });
    const outside = row(B, "accepted", { gemini_batch_name: batch });
    const names = ["touchSubmittedBatchRows", "failExpiredSubmittedBatch", "markBatchRowsFailed", "failMalformedExpiredSubmittedRows", "settleSourceIntakeBatchSpend"];
    const h = harness({ requests: [selected, outside], functions: names });
    await h.actual.touchSubmittedBatchRows(batch);
    await h.actual.failExpiredSubmittedBatch(batch, [selected], "fixture");
    await h.actual.markBatchRowsFailed(batch, "fixture");
    await h.actual.failMalformedExpiredSubmittedRows([selected]);
    expect(await h.actual.settleSourceIntakeBatchSpend(batch, [selected])).toEqual({ scope_deferred: true });
    expect(h.raw.calls.some((call) => call.mutation)).toBe(false);
    expect(h.report.scope_deferred_work).toBe(5);
  });

  it("does not recover an equivalent shared active reservation into a selected request", async () => {
    const selected = row(A, "needs_manual_review", { submission_claim_token: "newclaim" });
    const reservation = { id: "existing", status: "submitted", provider_batch_name: batch, request_count: 2, metadata: { request_ids: [A, B] } };
    const h = harness({ requests: [selected], reservations: [reservation], functions: ["deferSourceIntakeClaimsForActiveWork"], overrides: { loadGeminiSpendReservation: async () => reservation } });
    const result = await h.actual.deferSourceIntakeClaimsForActiveWork([selected], "newclaim", { reservationId: "existing" });
    expect(result.scope_deferred).toBe(true);
    expect(h.raw.calls.some((call) => call.mutation)).toBe(false);
  });

  it("allows settlement only for a fully selected reservation", async () => {
    const selected = row(A, "ai_review_submitted", { gemini_batch_name: batch, gemini_spend_reservation_id: "selected-reservation", model: "test-model" });
    const reservation = { id: "selected-reservation", status: "submitted", model: "test-model", provider_batch_name: batch, request_count: 1, metadata: { request_ids: [A] } };
    const settle = vi.fn(async () => true);
    const h = harness({ requests: [selected], reservations: [reservation], functions: ["settleSourceIntakeBatchSpend"], overrides: {
      loadGeminiSpendReservation: async () => reservation,
      terminalGeminiSettlement: () => ({ spentCostUsd: 0.01, spentSource: "fixture", coverage: {} }),
      settleGeminiSpendReservation: settle,
    } });
    expect(await h.actual.settleSourceIntakeBatchSpend(batch, [selected], { terminalState: "JOB_STATE_SUCCEEDED" })).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0].reservationId).toBe("selected-reservation");
  });
});

describe("real command wiring", () => {
  it("validates repeated exact IDs before env/provider/database setup", () => {
    expect(worker.indexOf("const requestIds = sourceIntakeRequestScope")).toBeLessThan(worker.indexOf("loadEnvFile(envPath)"));
    expect(worker).toContain("const supabase = scopedSourceIntakeClient(unscopedSupabase, requestIds)");
    const help = spawnSync(process.execPath, [workerPath, "--help", "--request-id", A, `--request-id=${B}`], { encoding: "utf8" });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("Repeat for an exact allowlist covering every phase");
    const bad = spawnSync(process.execPath, [workerPath, "--help", "--request-id=all"], { encoding: "utf8" });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("one exact UUID");
  });

  it("keeps unscoped access confined to read-only membership proof", () => {
    const references = [...worker.matchAll(/unscopedSupabase/g)];
    expect(references).toHaveLength(4); // definition, adapter, two read-only membership tables
    const guard = declarations.get("sourceIntakeScopeAllowsWork");
    expect(guard.match(/\.select\(/g)).toHaveLength(2);
    expect(guard).not.toMatch(/\.(?:update|insert|upsert|delete|rpc)\(/);
  });
});
