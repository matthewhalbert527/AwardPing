import { describe, expect, it, vi } from "vitest";
import { buildProgramTextCapture } from "./program-text-capture-contract.mjs";
import { programTextReference } from "./program-text-artifacts.mjs";
import { monitorProgramTextSource } from "./program-text-monitor.mjs";
import { createProgramTextRepository } from "./program-text-repository.mjs";
import { programTextCoverage, loadProgramTextSources } from "../program-text-worker.mjs";
import { rosterPageFixture } from "../fixtures/program-text-roster-pages.mjs";
import { buildProgramTextCollectionFailure, validateProgramTextCollectionQuality, hasUnclearedProgramTextCollectionFailure,
  validateProgramTextCollectionFailureReceipt, PROGRAM_TEXT_COLLECTION_FAILURE_RECEIPT, PROGRAM_TEXT_COLLECTION_QUALITY_SCHEMA } from "./program-text-collection-quality.mjs";

const source = { id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222", url: "https://example.org/rules", page_type: "other", admin_review_status: "open", text_collection_quality: null };
const epoch = "33333333-3333-4333-8333-333333333333", attempt = "44444444-4444-4444-8444-444444444444", candidate = "55555555-5555-4555-8555-555555555555";
const prose = "The application deadline is October 29, 2026. Eligible applicants submit three references.";
const observed = "2026-10-27T20:02:30.000123Z";
function capture(minute, extra = {}) {
  return buildProgramTextCapture({ source, acquisition: "http_html", captured_at: `2026-10-27T20:${String(minute).padStart(2, "0")}:00.000Z`,
    raw_bytes: Buffer.from(`<html><body>${prose}</body></html>`), content_type: "text/html", text: prose,
    blocks: [{ id: "one", text: prose, start_utf16: 0, end_utf16: prose.length }], extractor: { name: "offline-fixture", version: "1" }, ...extra });
}
function established() {
  const first = capture(0), latest = capture(1), ref = programTextReference(latest);
  return { schema: "awardping.program-text-state.v1", epoch, status: "baseline_ready", baseline_ref: ref, latest_ref: ref,
    first_captured_at: first.captured_at, last_checked_at: latest.captured_at, successful_checks: 2 };
}
function receipt(request, time = observed) {
  return { schema: PROGRAM_TEXT_COLLECTION_FAILURE_RECEIPT, recorded: true, failure: { schema: PROGRAM_TEXT_COLLECTION_QUALITY_SCHEMA,
    id: request.attempt_id, source_id: request.source_id, shared_award_id: request.shared_award_id, source_url: request.source_url,
    epoch: request.epoch, observed_at: time, reason_codes: request.reason_codes,
    expected_latest_capture_id: request.expected_state.latest_ref?.capture_id ?? null, capture_summary: request.capture_summary } };
}
const request = (state = established(), extra = {}) => buildProgramTextCollectionFailure({ attempt_id: attempt, source, epoch, expected_state: state, reason_codes: ["capture_failed"], ...extra });
function harness(current = capture(2), prior = established()) {
  let state = structuredClone(prior), stored = new Map([[capture(1).capture_id, capture(1)]]), failures = [], work;
  const callbacks = {
    capture: vi.fn(async () => current), readState: vi.fn(async () => state), loadCapture: vi.fn(async ref => stored.get(ref.capture_id)),
    retain: vi.fn(async c => { stored.set(c.capture_id, c); return programTextReference(c); }),
    verifyRetention: vi.fn(async ref => stored.get(ref.capture_id)), retainIncomplete: vi.fn(async c => { stored.set(c.capture_id, c); }),
    compareAndSetState: vi.fn(async ({ expected_state, next_state }) => { if (JSON.stringify(expected_state) !== JSON.stringify(state)) return false; state = next_state; return true; }),
    enqueueReview: vi.fn(async value => { work = value; return { id: candidate }; }),
    recordCollectionFailure: vi.fn(async value => { if (JSON.stringify(value.expected_state) !== JSON.stringify(state)) throw Error("state raced"); failures.push(value); return receipt(value); }),
  };
  return { callbacks, failures, stored, get state() { return state; }, set state(value) { state = value; }, get work() { return work; } };
}
const monitor = h => monitorProgramTextSource({ source, epoch, callbacks: h.callbacks });
const role = { cohort_key: "example", source_role: "current_documents", source_ids: [source.id], revision: epoch, manifest_status: "reviewed_text",
  evidence: { schema: "awardping.program-text-source-role.v1", source_bindings: { [source.id]: { source_url: source.url, shared_award_id: source.shared_award_id } } } };
const coverage = (state, quality) => programTextCoverage({ manifest: [role], sources: [{ ...source, manifest_bound: true, text_monitoring_state: state, text_collection_quality: quality }] }, epoch)[0];

describe("durable collection-quality attempts", () => {
  it("records a real capture exception with source/owner/URL/epoch and exact old state, preserving the baseline", async () => {
    const h = harness(), before = structuredClone(h.state); h.callbacks.capture.mockRejectedValue(Object.assign(Error("private network detail"), { code: "capture_transport_failed" }));
    const result = await monitor(h); expect(result.reason).toBe("capture_transport_failed"); expect(result.collection_failure_recorded).toBe(true);
    expect(h.failures).toHaveLength(1); expect(h.failures[0]).toMatchObject({ source_id: source.id, shared_award_id: source.shared_award_id, source_url: source.url, epoch, expected_state: before, reason_codes: ["capture_failed"], capture_summary: null });
    expect(JSON.stringify(h.failures[0])).not.toContain("private network detail"); expect(h.state).toEqual(before); expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
    expect(coverage(h.state, result.collection_failure.failure).collection_complete).toBe(false);
  });
  it("retains an incomplete body separately, records only an honest raw summary and never advances baseline", async () => {
    const c = capture(2, { completeness: { status: "incomplete", reasons: ["page_22_sparse_text"] } }), h = harness(c), old = structuredClone(h.state);
    const result = await monitor(h); expect(result.reason).toBe("incomplete_capture"); expect(result.collection_failure_recorded).toBe(true);
    expect(h.callbacks.retainIncomplete).toHaveBeenCalledWith(c); expect(h.failures[0].capture_summary).toMatchObject({ capture_id: c.capture_id, raw_sha256: c.raw_source.sha256, retained_locally: true, incomplete_reason_codes: ["page_22_sparse_text"] });
    expect(h.state).toEqual(old); expect(h.callbacks.enqueueReview).not.toHaveBeenCalled(); expect(coverage(h.state, result.collection_failure.failure).repeated_text_sources).toBe(0);
  });
  it("does not claim an incomplete original was retained when retention failed", async () => {
    const h = harness(capture(2, { completeness: { status: "incomplete", reasons: ["missing_page"] } })); h.callbacks.retainIncomplete.mockRejectedValue(Error("disk failure"));
    const result = await monitor(h); expect(result.reason).toBe("incomplete_capture_retention_failed"); expect(result.collection_failure.failure.capture_summary.retained_locally).toBe(false); expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
  });
  it("does not manufacture a raw/capture reference from malformed capture output", async () => {
    const h = harness({ invalid: true }), result = await monitor(h); expect(result.collection_failure_recorded).toBe(true); expect(h.failures[0].capture_summary).toBeNull(); expect(h.callbacks.retain).not.toHaveBeenCalled();
  });
  it("journals durable retention failure and preserves a formerly ready state", async () => {
    const h = harness(), old = structuredClone(h.state); h.callbacks.verifyRetention.mockRejectedValue(Error("unavailable"));
    const result = await monitor(h); expect(result.collection_failure_recorded).toBe(true); expect(result.reason).toBe("durable_retention_failed"); expect(h.state).toEqual(old); expect(coverage(h.state, result.collection_failure.failure).collection_complete).toBe(false);
  });
  it("fails closed when a journal write races or is unavailable, without retrying or pretending durability", async () => {
    const h = harness(); h.callbacks.capture.mockRejectedValue(Error("capture failed")); h.callbacks.recordCollectionFailure.mockRejectedValue(Error("40001"));
    const result = await monitor(h); expect(result.collection_failure_recorded).toBe(false); expect(result.collection_failure_journal_reason).toBe("collection_failure_journal_unconfirmed"); expect(h.callbacks.recordCollectionFailure).toHaveBeenCalledTimes(1); expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
    expect(coverage(h.state, undefined).collection_complete).toBe(false);
  });
  it("does not journal an existing preserved comparison as a failed capture", async () => {
    const old = capture(0), latest = capture(1, { text: prose + " Changed.", blocks: [{ id: "one", text: prose + " Changed.", start_utf16: 0, end_utf16: prose.length + 9 }] });
    const h = harness(); h.state = { ...established(), status: "awaiting_review", baseline_ref: programTextReference(old), latest_ref: programTextReference(latest) };
    const result = await monitor(h); expect(result.reason).toBe("existing_review_pair_preserved"); expect(h.callbacks.capture).not.toHaveBeenCalled(); expect(h.callbacks.recordCollectionFailure).not.toHaveBeenCalled();
  });
  it("does not journal invalid pre-capture epoch state", async () => {
    const h = harness(); h.state.epoch = attempt; const result = await monitor(h); expect(result.reason).toBe("source_state_invalid_or_epoch_changed"); expect(h.callbacks.capture).not.toHaveBeenCalled(); expect(h.callbacks.recordCollectionFailure).not.toHaveBeenCalled();
  });
  it("one later ordinary unchanged capture clears an established source's derived hold without deleting history", async () => {
    const h = harness(capture(3)), failure = receipt(request()).failure; expect(coverage(h.state, failure).collection_complete).toBe(false);
    const result = await monitor(h); expect(result.status).toBe("unchanged"); expect(h.state.successful_checks).toBe(3); expect(coverage(h.state, failure).collection_complete).toBe(true);
    expect(failure.expected_latest_capture_id).toBe(established().latest_ref.capture_id); expect(h.callbacks.recordCollectionFailure).not.toHaveBeenCalled(); expect(h.callbacks.enqueueReview).not.toHaveBeenCalled();
  });
  it("initial coverage still needs its original two independent successful captures after a failure", async () => {
    const failure = receipt(request({})).failure, h = harness(capture(3), {}), first = await monitor(h); expect(first.status).toBe("baseline_ready"); expect(h.state.successful_checks).toBe(1); expect(coverage(h.state, failure).collection_complete).toBe(false);
    h.callbacks.capture.mockResolvedValue(capture(4)); const second = await monitor(h); expect(second.status).toBe("unchanged"); expect(h.state.successful_checks).toBe(2); expect(coverage(h.state, failure).collection_complete).toBe(true);
  });
  it("a later substantive change still requires ordinary review/reconciliation", async () => {
    const text = prose.replace("October 29", "October 30"), h = harness(capture(3, { text, raw_bytes: Buffer.from(`<html><body>${text}</body></html>`), blocks: [{ id: "one", text, start_utf16: 0, end_utf16: text.length }] }));
    const failure = receipt(request()).failure, result = await monitor(h); expect(result.status).toBe("review_required"); expect(h.state.status).toBe("awaiting_review"); expect(coverage(h.state, failure).collection_complete).toBe(false); expect(h.callbacks.recordCollectionFailure).not.toHaveBeenCalled();
  });
});

describe("source-bound quality DTO and clearance", () => {
  it("treats missing, malformed, foreign or unknown new API quality values as held", () => {
    const state = established(); for (const quality of [undefined, {}, "clear", { ...receipt(request()).failure, source_url: "https://other.example/rules" }, { ...receipt(request()).failure, observed_at: "bad" }]) expect(hasUnclearedProgramTextCollectionFailure({ ...source, text_monitoring_state: state, text_collection_quality: quality }, epoch)).toBe(true);
    expect(hasUnclearedProgramTextCollectionFailure({ ...source, text_monitoring_state: state, text_collection_quality: null }, epoch)).toBe(false);
  });
  it("does not clear the same old capture merely because its client clock is ahead of server failure time", () => {
    const latest = programTextReference(capture(4)), state = { ...established(), baseline_ref: latest, latest_ref: latest, last_checked_at: latest.captured_at }, failure = receipt(request(state)).failure;
    expect(hasUnclearedProgramTextCollectionFailure({ ...source, text_monitoring_state: state, text_collection_quality: failure }, epoch)).toBe(true);
  });
  it("does not clear with an older/equal capture or with a reference that is not complete", () => {
    const failure = receipt(request()).failure, state = established(); expect(hasUnclearedProgramTextCollectionFailure({ ...source, text_monitoring_state: state, text_collection_quality: failure }, epoch)).toBe(true);
    const latest = { ...programTextReference(capture(3)), completeness: { status: "incomplete", reasons: ["missing"] } }; expect(hasUnclearedProgramTextCollectionFailure({ ...source, text_monitoring_state: { ...state, latest_ref: latest, last_checked_at: latest.captured_at }, text_collection_quality: failure }, epoch)).toBe(true);
  });
  it("preserves old-epoch failure history without applying it to a genuinely different current epoch", () => {
    const failure = { ...receipt(request()).failure, epoch: attempt }; expect(hasUnclearedProgramTextCollectionFailure({ ...source, text_monitoring_state: established(), text_collection_quality: failure }, epoch)).toBe(false);
  });
  it("does not store arbitrary diagnostic messages or accept complete captures as incomplete summaries", () => {
    expect(() => request(established(), { reason_codes: ["send_secret_to_someone"] })).toThrow(); expect(() => request(established(), { capture: capture(2) })).toThrow();
    const r = request(established(), { reason_codes: ["incomplete_capture"], capture: capture(2, { completeness: { status: "incomplete", reasons: ["Contact person@example.org for help"] } }) }); expect(r.capture_summary.incomplete_reason_codes).toEqual(["unclassified_incomplete_capture"]); expect(JSON.stringify(r)).not.toContain("person@example.org");
  });
  it("rejects a fake acknowledgement or wrong request identity", () => {
    const r = request(); expect(() => validateProgramTextCollectionFailureReceipt({ recorded: true }, r)).toThrow(); expect(() => validateProgramTextCollectionFailureReceipt(receipt({ ...r, attempt_id: candidate }), r)).toThrow();
  });
  it("requires explicit quality data from the paged API and does not weaken its cursor/seal checks", async () => {
    const fixture = rosterPageFixture([role], [source]); const db = { rpc: async (_name, params) => { const response = fixture(params); if (params.p_kind === "sources") delete response.data.entries[0].text_collection_quality; return response; } };
    await expect(loadProgramTextSources(db, { epoch })).rejects.toThrow("quality data"); expect(() => validateProgramTextCollectionQuality(undefined, source)).toThrow();
  });
  it("uses the existing repository only for the bounded failure RPC, never a source/queue update", async () => {
    const rpc = vi.fn(async (_name, { p_request }) => ({ data: receipt(p_request), error: null })), db = { rpc, from: vi.fn(() => { throw Error("no table write"); }) };
    const repository = createProgramTextRepository(db, { loadCapture: async () => {}, bucket: "offline" }), r = request(); await repository.recordCollectionFailure(r);
    expect(rpc).toHaveBeenCalledWith("record_program_text_collection_failure", { p_request: r }); expect(db.from).not.toHaveBeenCalled();
  });
});


describe("durable PDF binary-only currentness", () => {
  const reason = "pdf_original_changed_without_text_change";
  function pdf(acquisition, minute, raw = "original", text = prose) {
    return capture(minute, { acquisition, content_type: "application/pdf", raw_bytes: Buffer.from("%PDF-1.7\n% " + raw + "\n%%EOF"),
      text, blocks: [{ id: "one", text, start_utf16: 0, end_utf16: text.length }] });
  }
  function pdfHarness(acquisition, current) {
    const first = pdf(acquisition, 0), old = pdf(acquisition, 1), ref = programTextReference(old);
    const h = harness(current, { schema: "awardping.program-text-state.v1", epoch, status: "baseline_ready", baseline_ref: ref,
      latest_ref: ref, first_captured_at: first.captured_at, last_checked_at: old.captured_at, successful_checks: 2 });
    h.stored.set(old.capture_id, old);
    return h;
  }
  it.each(["pdf_text", "pdf_ocr"])("%s retains changed original but records truthful hold without baseline/review/provider side effects", async acquisition => {
    const current = pdf(acquisition, 2, "changed image or metadata"), h = pdfHarness(acquisition, current), before = structuredClone(h.state);
    expect(coverage(h.state, null).collection_complete).toBe(true);
    const result = await monitor(h);
    expect(result).toMatchObject({ status: "held", reason, creates_update: false, paid_review_required: false, collection_failure_recorded: true });
    expect(result.current_ref).toEqual(programTextReference(current));
    expect(h.callbacks.retain).toHaveBeenCalledWith(current); expect(h.callbacks.verifyRetention).toHaveBeenCalledOnce();
    expect(h.failures).toHaveLength(1); expect(h.failures[0]).toMatchObject({ expected_state: before, reason_codes: [reason], capture_summary: null });
    expect(h.state).toEqual(before); expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled(); expect(h.callbacks.enqueueReview).not.toHaveBeenCalled();
    expect(coverage(h.state, result.collection_failure.failure).collection_complete).toBe(false);
    expect(coverage(h.state, result.collection_failure.failure).repeated_text_sources).toBe(0);
  });
  it.each(["pdf_text", "pdf_ocr"])("%s exact same original still advances normally with no journal", async acquisition => {
    const h = pdfHarness(acquisition, pdf(acquisition, 2)), result = await monitor(h);
    expect(result.status).toBe("unchanged"); expect(h.state.successful_checks).toBe(3); expect(h.callbacks.recordCollectionFailure).not.toHaveBeenCalled();
    expect(coverage(h.state, null).collection_complete).toBe(true);
  });
  it.each(["pdf_text", "pdf_ocr"])("%s still sends genuine extracted text changes to ordinary comparison", async acquisition => {
    const h = pdfHarness(acquisition, pdf(acquisition, 2, "new text", prose.replace("October 29", "October 30"))), result = await monitor(h);
    expect(result.status).toBe("review_required"); expect(h.callbacks.enqueueReview).toHaveBeenCalledOnce();
    expect(h.callbacks.recordCollectionFailure).not.toHaveBeenCalled(); expect(h.state.status).toBe("awaiting_review");
  });
  it("later exact original clears only with normal successful capture; another changed binary stays held", async () => {
    const h = pdfHarness("pdf_text", pdf("pdf_text", 2, "new graphic")), first = await monitor(h), failure = first.collection_failure.failure;
    h.callbacks.capture.mockResolvedValue(pdf("pdf_text", 3, "new graphic"));
    const repeatedChange = await monitor(h); expect(repeatedChange.status).toBe("held"); expect(h.state.successful_checks).toBe(2);
    expect(coverage(h.state, repeatedChange.collection_failure.failure).collection_complete).toBe(false);
    h.callbacks.capture.mockResolvedValue(pdf("pdf_text", 4));
    const restoredOriginal = await monitor(h); expect(restoredOriginal.status).toBe("unchanged");
    expect(coverage(h.state, failure).collection_complete).toBe(true); expect(h.failures).toHaveLength(2);
  });
  it("does not claim durability or retry when binary-only journal CAS fails", async () => {
    const h = pdfHarness("pdf_text", pdf("pdf_text", 2, "new graphic")), before = structuredClone(h.state);
    h.callbacks.recordCollectionFailure.mockRejectedValue(Error("40001")); const result = await monitor(h);
    expect(result.collection_failure_recorded).toBe(false); expect(result.collection_failure_journal_reason).toBe("collection_failure_journal_unconfirmed");
    expect(h.callbacks.recordCollectionFailure).toHaveBeenCalledOnce(); expect(h.state).toEqual(before); expect(coverage(h.state, undefined).collection_complete).toBe(false);
  });
  it("retains existing non-PDF raw-only no-change behavior", async () => {
    const h = harness(capture(2, { raw_bytes: Buffer.from("<html><body>" + prose + "</body><!-- metadata --></html>") })), result = await monitor(h);
    expect(result.status).toBe("unchanged"); expect(h.callbacks.recordCollectionFailure).not.toHaveBeenCalled();
  });
});
