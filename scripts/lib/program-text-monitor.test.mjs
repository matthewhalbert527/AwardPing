import { describe, expect, it, vi } from "vitest";
import { buildProgramTextCapture } from "./program-text-capture.mjs";
import { programTextReference } from "./program-text-storage.mjs";
import { monitorProgramTextSource, finalizeProgramTextReview, PROGRAM_TEXT_STATE_SCHEMA } from "./program-text-monitor.mjs";

const source = { id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222", url: "https://example.org/award" };
const epoch = "33333333-3333-4333-8333-333333333333", candidateId = "44444444-4444-4444-8444-444444444444", eventId = "55555555-5555-4555-8555-555555555555";
const beforeText = "The application deadline is March 15, 2027. Applicants must be enrolled full time.";
const afterText = "The application deadline is March 20, 2027. Applicants must be enrolled full time.";
function capture(text = beforeText, minute = 0, extra = {}) {
  return buildProgramTextCapture({ source, acquisition: "http_html", raw_bytes: Buffer.from(`<html><body>${text}</body></html>`), content_type: "text/html",
    text, blocks: [{ id: "paragraph", text, start_utf16: 0, end_utf16: text.length, heading: "Application deadline" }],
    captured_at: `2026-10-23T01:${String(minute).padStart(2, "0")}:00.000Z`, extractor: { name: "fixture", version: "1" }, ...extra });
}
function stateFor(old, latest = old, status = "baseline_ready") {
  return { schema: PROGRAM_TEXT_STATE_SCHEMA, epoch, status, baseline_ref: programTextReference(old), latest_ref: programTextReference(latest),
    last_checked_at: latest.captured_at, first_captured_at: old.captured_at, successful_checks: old.capture_id === latest.capture_id ? 1 : 2 };
}
function harness(old = null, current = capture(beforeText, 1)) {
  const captures = new Map(); if (old) captures.set(old.capture_id, old); captures.set(current.capture_id, current);
  let state = old ? stateFor(old) : {}, work = null;
  const order = [];
  const callbacks = {
    capture: vi.fn(async () => current),
    retain: vi.fn(async value => { order.push("retain"); captures.set(value.capture_id, value); return programTextReference(value); }),
    verifyRetention: vi.fn(async ref => { order.push("verify"); return captures.get(ref.capture_id); }),
    retainIncomplete: vi.fn(async () => { order.push("retain_incomplete"); }),
    readState: vi.fn(async () => state),
    loadCapture: vi.fn(async ref => captures.get(ref.capture_id)),
    compareAndSetState: vi.fn(async ({ expected_state, next_state }) => {
      order.push("cas"); if (JSON.stringify(expected_state) !== JSON.stringify(state)) return false; state = next_state; return next_state;
    }),
    enqueueReview: vi.fn(async value => { order.push("enqueue"); work = { ...value, id: candidateId }; return { id: candidateId }; }),
    recordReviewResult: vi.fn(async () => { order.push("persist_result"); return { persisted: true }; }),
    publishProgramChange: vi.fn(async () => { order.push("publish"); return { published: true, event_id: eventId }; }),
  };
  return { callbacks, order, captures, get state() { return state; }, set state(value) { state = value; }, get work() { return work; } };
}
const run = h => monitorProgramTextSource({ source, epoch, cycle_id: "2027", callbacks: h.callbacks });
function responses(work, disposition = "no_program_change") {
  return work.packet_plan.packets.map(packet => ({ schema: "awardping.program-text-review.v1", comparison_id: work.comparison.comparison_id,
    packet_id: packet.packet_id, ...work.comparison.context,
    blocks: packet.blocks.map(block => ({ id: block.id, disposition, reason: "Compared both complete blocks.", changes: disposition === "program_change" ? [{
      field: "deadline", operation: "replace", summary: "The application deadline moved from March 15 to March 20, 2027.",
      previous_quote: { block_id: block.previous.id, text: "March 15, 2027" }, current_quote: { block_id: block.current.id, text: "March 20, 2027" }, applicant_impact: true,
    }] : [] })) }));
}

describe("program text source monitoring", () => {
  it("initializes only after durable readback and never emits first-coverage updates", async () => {
    const h = harness(), result = await run(h);
    expect(result.status).toBe("baseline_ready"); expect(result.initial_coverage).toBe(true); expect(result.creates_update).toBe(false);
    expect(h.order).toEqual(["retain", "verify", "cas"]);
    expect(h.state.baseline_ref).toEqual(h.state.latest_ref); expect(h.callbacks.enqueueReview).not.toHaveBeenCalled();
    expect(h.state.first_captured_at).toBe(capture(beforeText, 1).captured_at); expect(h.state.successful_checks).toBe(1);
    expect(h.callbacks.publishProgramChange).not.toHaveBeenCalled();
  });
  it("refuses operation before required persistence callbacks are wired", async () => {
    await expect(monitorProgramTextSource({ source, epoch, callbacks: {} })).rejects.toThrow("requires callbacks");
  });
  it("retains an incomplete original separately and leaves the baseline alone", async () => {
    const h = harness(null, capture(beforeText, 1, { completeness: { status: "incomplete", reasons: ["missing_page"] } }));
    const result = await run(h);
    expect(result.reason).toBe("incomplete_capture"); expect(h.order).toEqual(["retain_incomplete"]);
    expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
  });
  it.each(["retain", "verifyRetention"])("does not initialize when %s fails", async name => {
    const h = harness(); h.callbacks[name].mockRejectedValue(new Error("failure"));
    expect((await run(h)).reason).toBe("durable_retention_failed"); expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
  });
  it("rejects a readback of different complete bytes", async () => {
    const h = harness(); h.callbacks.verifyRetention.mockResolvedValue(capture(afterText, 1));
    expect((await run(h)).reason).toBe("durable_readback_mismatch"); expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
  });
  it("refuses an epoch reset before capture", async () => {
    const h = harness(capture()); h.state = { ...h.state, epoch: candidateId };
    expect((await run(h)).reason).toBe("source_state_invalid_or_epoch_changed"); expect(h.callbacks.capture).not.toHaveBeenCalled();
  });
  it("does not accept an otherwise valid capture from a different award", async () => {
    const h = harness(null, capture(beforeText, 1, { source: { ...source, shared_award_id: candidateId } }));
    expect((await run(h)).reason).toBe("program_text_source_identity_mismatch"); expect(h.callbacks.retain).not.toHaveBeenCalled();
  });
  it("advances a newer equal-text reference with expected-state CAS and no review", async () => {
    const h = harness(capture()), result = await run(h);
    expect(result.status).toBe("unchanged"); expect(h.state.baseline_ref.capture_id).toBe(capture(beforeText, 1).capture_id);
    expect(h.state.first_captured_at).toBe(capture().captured_at); expect(h.state.successful_checks).toBe(2);
    expect(h.callbacks.enqueueReview).not.toHaveBeenCalled(); expect(h.order).toEqual(["retain", "verify", "cas"]);
  });
  it.each(["pdf_text", "pdf_ocr"])("advances %s only when unchanged extracted text also has the exact same PDF original", async acquisition => {
    const extra = { acquisition, raw_bytes: Buffer.from("%PDF-1.7\n% unchanged original\n%%EOF"), content_type: "application/pdf" };
    const old = capture(beforeText, 0, extra), current = capture(beforeText, 1, extra), h = harness(old, current);
    const result = await run(h);
    expect(result.status).toBe("unchanged"); expect(result.creates_update).toBe(false);
    expect(h.state.baseline_ref).toEqual(programTextReference(current)); expect(h.state.successful_checks).toBe(2);
    expect(h.order).toEqual(["retain", "verify", "cas"]);
    expect(h.callbacks.enqueueReview).not.toHaveBeenCalled(); expect(h.callbacks.publishProgramChange).not.toHaveBeenCalled();
  });
  it.each([
    ["pdf_text", "image payload"], ["pdf_ocr", "image payload"],
    ["pdf_text", "document metadata"], ["pdf_ocr", "document metadata"],
  ])("holds %s %s binary changes with equal text without asserting a program change", async (acquisition, changedPart) => {
    const extra = { acquisition, content_type: "application/pdf" };
    const old = capture(beforeText, 0, { ...extra, raw_bytes: Buffer.from(`%PDF-1.7\n% ${changedPart} before\n%%EOF`) });
    const current = capture(beforeText, 1, { ...extra, raw_bytes: Buffer.from(`%PDF-1.7\n% ${changedPart} after\n%%EOF`) });
    const h = harness(old, current), initialState = structuredClone(h.state), result = await run(h);
    expect(result).toEqual({ status: "held", reason: "pdf_original_changed_without_text_change", current_ref: programTextReference(current),
      creates_update: false, paid_review_required: false });
    expect(h.order).toEqual(["retain", "verify"]); expect(h.callbacks.retain).toHaveBeenCalledWith(current);
    expect(h.state).toEqual(initialState); expect(h.state.successful_checks).toBe(1);
    expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled(); expect(h.callbacks.enqueueReview).not.toHaveBeenCalled();
    expect(h.callbacks.publishProgramChange).not.toHaveBeenCalled(); expect(h.callbacks.recordReviewResult).not.toHaveBeenCalled();
  });
  it.each([
    ["capture_order_invalid", capture(beforeText, 0)],
    ["extraction_configuration_changed", capture(beforeText, 1, { extractor: { name: "fixture", version: "2" } })],
    ["extraction_configuration_changed", capture(beforeText, 1, { final_url: "https://example.org/new" })],
  ])("holds %s without review or baseline changes", async (reason, current) => {
    const h = harness(capture(), current);
    expect((await run(h)).reason).toBe(reason); expect(h.callbacks.enqueueReview).not.toHaveBeenCalled();
    expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
  });
  it("holds when the previous original cannot be restored", async () => {
    const h = harness(capture()); h.callbacks.loadCapture.mockResolvedValue(null);
    expect((await run(h)).reason).toBe("baseline_original_unavailable"); expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
  });
  it("saves a complete immutable review before recording awaiting-review state", async () => {
    const h = harness(capture(), capture(afterText, 1)), result = await run(h);
    expect(result.status).toBe("review_required"); expect(result.paid_review_required).toBe(true);
    expect(h.order).toEqual(["retain", "verify", "enqueue", "cas"]);
    expect(h.state.baseline_ref.capture_id).toBe(capture().capture_id); expect(h.state.latest_ref.capture_id).toBe(capture(afterText, 1).capture_id);
    expect(h.state.successful_checks).toBe(2); expect(h.state.first_captured_at).toBe(capture().captured_at);
    expect(h.work.comparison.previous_text).toBe(beforeText); expect(h.work.comparison.current_text).toBe(afterText);
  });
  it.each(["awaiting_review", "held", "error"])("preserves %s review pairs without an automatic capture or duplicate paid review", async status => {
    const old = capture(), current = capture(afterText, 1), h = harness(old, capture(afterText, 2));
    h.state = stateFor(old, current, status);
    expect((await run(h)).reason).toBe("existing_review_pair_preserved"); expect(h.callbacks.capture).not.toHaveBeenCalled();
    expect(h.state.successful_checks).toBe(2);
    expect(h.callbacks.enqueueReview).not.toHaveBeenCalled(); expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
  });
  it("does not record awaiting-review when enqueueing is unconfirmed", async () => {
    const h = harness(capture(), capture(afterText, 1)); h.callbacks.enqueueReview.mockResolvedValue(null);
    expect((await run(h)).reason).toBe("review_enqueue_unconfirmed"); expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
  });
  it("does not retry a state conflict after successfully queueing the immutable work", async () => {
    const h = harness(capture(), capture(afterText, 1)); h.callbacks.compareAndSetState.mockResolvedValue(false);
    const result = await run(h);
    expect(result.reason).toBe("state_changed_after_enqueue"); expect(result.candidate_id).toBe(candidateId);
    expect(h.callbacks.enqueueReview).toHaveBeenCalledTimes(1); expect(h.callbacks.compareAndSetState).toHaveBeenCalledTimes(1);
  });
});

describe("program text review finalization", () => {
  async function pending() { const h = harness(capture(), capture(afterText, 1)); await run(h); h.order.length = 0; h.callbacks.compareAndSetState.mockClear(); return h; }
  const finalize = (h, rows = responses(h.work)) => finalizeProgramTextReview({ source, epoch, candidate: h.work, responses: rows, callbacks: h.callbacks });
  it("persists completed no-change validation before baseline CAS, without publication", async () => {
    const h = await pending(), result = await finalize(h);
    expect(result.status).toBe("no_program_change"); expect(h.order).toEqual(["persist_result", "cas"]);
    expect(h.state.baseline_ref.capture_id).toBe(capture(afterText, 1).capture_id); expect(h.callbacks.publishProgramChange).not.toHaveBeenCalled();
    expect(h.state.successful_checks).toBe(2); expect(h.state.first_captured_at).toBe(capture().captured_at);
  });
  it("routes accepted facts only to the atomic publisher, never separate baseline CAS", async () => {
    const h = await pending(), result = await finalize(h, responses(h.work, "program_change"));
    expect(result.status).toBe("published"); expect(result.event_id).toBe(eventId);
    expect(h.order).toEqual(["persist_result", "publish"]); expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
    expect(h.callbacks.publishProgramChange.mock.calls[0][0].expected_state).toEqual(h.state);
    expect(h.callbacks.recordReviewResult.mock.calls[0][0].responses).toEqual(responses(h.work, "program_change"));
  });
  it("keeps invalid or incomplete AI output held and records that result", async () => {
    const h = await pending(), result = await finalize(h, []);
    expect(result.reason).toBe("review_result_held"); expect(h.order).toEqual(["persist_result"]);
    expect(h.callbacks.publishProgramChange).not.toHaveBeenCalled(); expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
  });
  it("will not finalize an obsolete source pair", async () => {
    const h = await pending(); h.state = stateFor(capture(), capture(afterText, 2), "awaiting_review");
    expect((await finalize(h)).reason).toBe("review_pair_no_longer_current"); expect(h.order).toEqual([]);
  });
  it("rejects modified comparison text and packet plans", async () => {
    for (const field of ["comparison", "packet_plan"]) {
      const h = await pending(); h.work[field] = { ...h.work[field], altered: true };
      expect((await finalize(h)).reason).toBe(field === "comparison" ? "review_comparison_changed" : "review_packet_plan_changed");
      expect(h.callbacks.recordReviewResult).not.toHaveBeenCalled();
    }
  });
  it("does not advance when result persistence or state CAS fails", async () => {
    const h = await pending(); h.callbacks.recordReviewResult.mockResolvedValue(false);
    expect((await finalize(h)).reason).toBe("review_result_persistence_unconfirmed"); expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
    h.callbacks.recordReviewResult.mockResolvedValue(true); h.callbacks.compareAndSetState.mockResolvedValue(false);
    expect((await finalize(h)).reason).toBe("state_changed_after_no_change_review"); expect(h.callbacks.publishProgramChange).not.toHaveBeenCalled();
  });
  it("never claims publication from an unconfirmed publisher return", async () => {
    const h = await pending(); h.callbacks.publishProgramChange.mockResolvedValue({ published: false });
    expect((await finalize(h, responses(h.work, "program_change"))).reason).toBe("publication_unconfirmed");
    expect(h.callbacks.compareAndSetState).not.toHaveBeenCalled();
  });
});
