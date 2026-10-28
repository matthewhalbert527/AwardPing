import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { buildProgramTextCapture } from "./program-text-capture.mjs";
import { programTextReference } from "./program-text-storage.mjs";
import { buildProgramTextComparison, buildProgramTextReviewPackets } from "./program-text-review.mjs";
import { programTextDeterministicNoChange, PROGRAM_TEXT_UNPAID_NULL_FIELDS } from "./program-text-deterministic-no-change.mjs";
import { createProgramTextRepository, programTextCandidateWork, programTextEqual } from "./program-text-repository.mjs";
import { review } from "../program-text-worker.mjs";

const source = { id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222",
  url: "https://example.org/award", title: "Example Award", page_type: "application" };
const epoch = "33333333-3333-4333-8333-333333333333", id = "44444444-4444-4444-8444-444444444444";
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const email = (text, heading = "Contact", extra = {}) => ({ text, kind: "source_link", heading,
  context: { source_attribute: "href", link_text: "Contact us", heading_path: [{ text: heading, level: 2 }] }, ...extra });
const newsletter = label => ({ text: `${label} This field is for validation purposes and should be left unchanged.`, kind: "li",
  heading: "Donors & Supporters > Stay Connected", context: { list_path: [], table_row: [],
    heading_path: [{ text: "Donors & Supporters", level: 1 }, { text: "Stay Connected", level: 3 }] } });
// Exact five reviewed changed-block values, with small surrounding fixture text.
const noise = [
  [newsletter("Company"), newsletter("Phone")],
  [email("/cdn-cgi/l/email-protection#4b383e3b3b24393f0b38262a3b3b2732652224"), email("/cdn-cgi/l/email-protection#c5b6b0b5b5aab7b185b6a8a4b5b5a9bcebacaa")],
  [email("/cdn-cgi/l/email-protection#e4b4a0b78b968b97a49480978b968b97ca8b9683"), email("/cdn-cgi/l/email-protection#114155427e637e62516175627e637e623f7e6376")],
  [email("/cdn-cgi/l/email-protection#b0d9ded6dff0c0d4c3dfc2dfc39edfc2d7"), email("/cdn-cgi/l/email-protection#157c7b737a556571667a677a663b7a6772")],
  [email("/cdn-cgi/l/email-protection#a3f3e7f0ccd1ccd0e3d3c7d0ccd1ccd08dccd1c4"), email("/cdn-cgi/l/email-protection#87d7c3d4e8f5e8f4c7f7e3f4e8f5e8f4a9e8f5e0")],
];
function capture(entries, day) {
  let text = "";
  const blocks = entries.map((entry, index) => {
    if (index) text += "\n\n";
    const start = text.length; text += entry.text;
    return { id: `block-${index}`, start_utf16: start, end_utf16: text.length, ...entry };
  });
  return buildProgramTextCapture({ source, final_url: source.url, captured_at: `2026-10-${day}T12:00:00.000Z`, acquisition: "http_html",
    extractor: { name: "fixture", version: "1" }, raw_bytes: Buffer.from(`<html><body>${text}</body></html>`), content_type: "text/html", text, blocks });
}
function fixture(pair = noise[0], extras = []) {
  const anchor = { text: "Application deadline: October 29, 2026. Full-time graduate students may apply.", kind: "p", heading: "Program" };
  const previous = capture([anchor, pair[0], ...extras.map(pair => pair[0])], 23), current = capture([anchor, pair[1], ...extras.map(pair => pair[1])], 24);
  const comparison = buildProgramTextComparison(previous, current, { epoch, cycle_id: "2027" }), packet_plan = buildProgramTextReviewPackets(comparison);
  const row = { id, candidate_scope: "program_text_change", candidate_signature: comparison.comparison_id, shared_award_id: source.shared_award_id,
    shared_award_source_id: source.id, source_url: source.url, source_title: source.title, previous_snapshot_ref: programTextReference(previous), new_snapshot_ref: programTextReference(current),
    previous_image_hash: null, new_image_hash: null, previous_file_hash: null, new_file_hash: null,
    ...Object.fromEntries(PROGRAM_TEXT_UNPAID_NULL_FIELDS.map(key => [key, null])), status: "pending", actual_usage: {},
    updated_at: "2026-10-24T12:00:01.000Z", worker_metadata: { monitoring_contract: "program-text-v1", epoch, evidence_signature: comparison.comparison_id, bucket: "private-bucket" },
    prompt_payload: { program_identity: { award_id: source.shared_award_id, award_name: "Example Award", source_url: source.url, source_title: source.title }, comparison, packet_plan } };
  const state = { schema: "awardping.program-text-state.v1", epoch, status: "awaiting_review", baseline_ref: row.previous_snapshot_ref, latest_ref: row.new_snapshot_ref,
    first_captured_at: previous.captured_at, last_checked_at: current.captured_at, successful_checks: 2 };
  return { previous, current, row, state };
}
function reseal(row) {
  const comparison = row.prompt_payload.comparison, { comparison_id, ...body } = comparison;
  comparison.comparison_id = createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex");
  row.candidate_signature = comparison.comparison_id; row.worker_metadata.evidence_signature = comparison.comparison_id;
  row.prompt_payload.packet_plan = buildProgramTextReviewPackets(comparison);
}
function encoded(address, key = 19) { return "/cdn-cgi/l/email-protection#" + Buffer.from([key, ...[...Buffer.from(address)].map(byte => byte ^ key)]).toString("hex"); }
const shareLink = (payload, key) => email(encoded(payload, key), "Award > Share this page", {
  context: { source_attribute: "href", link_text: "Email this Page", list_path: ["Email this Page"],
    heading_path: [{ text: "Award", level: 1 }, { text: "Share this page", level: 2 }] },
});

afterEach(() => { vi.unstubAllGlobals(); });
describe("fresh unpaid complete deterministic no-change proofs", () => {
  it.each(["&", "&#038;", "&#x26;"])("locally proves identical email-share payloads using %s without changing the comparison or captures", separator => {
    const payload = `?subject=Award%20guidance${separator}body=Award%20details&mdash;%20https%3A%2F%2Fexample.org%2Faward`;
    const f = fixture([shareLink(payload, 0x37), shareLink(payload, 0x4a)], [noise[1]]), before = JSON.stringify(f);
    expect(f.row.prompt_payload.comparison.status).toBe("review_required");
    expect(programTextDeterministicNoChange(f.row)).toMatchObject({ status: "ready", validation: { status: "no_program_change", changes: [] },
      provenance: { generated_by_gemini: false, new_provider_calls: 0, spend_mutations: 0 } });
    expect(JSON.stringify(f)).toBe(before);
  });
  it("does not close real subject, body or recipient changes", () => {
    const payload = "?subject=Award&body=Current%20requirements";
    for (const changed of ["?subject=New%20award&body=Current%20requirements", "?subject=Award&body=New%20requirements",
      "new@example.org?subject=Award&body=Current%20requirements"]) {
      expect(programTextDeterministicNoChange(fixture([shareLink(payload, 0x37), shareLink(changed, 0x4a)]).row)).toBeNull();
    }
  });
  it("requires the exact share action, heading, attribute and lowercase path", () => {
    const payload = "?subject=Award&body=Current%20requirements";
    for (const change of [block => { block.context.link_text = "Apply"; }, block => { block.context.heading_path.at(-1).text = "Application"; },
      block => { block.context.source_attribute = "action"; }, block => { block.text = block.text.replace("/cdn-cgi/", "/CDN-CGI/"); }]) {
      const pair = [shareLink(payload, 0x37), shareLink(payload, 0x4a)]; change(pair[1]);
      expect(programTextDeterministicNoChange(fixture(pair).row)).toBeNull();
    }
    const pair = [shareLink(payload, 0x37), shareLink(payload, 0x4a)];
    pair.forEach(block => { block.context.link_text = "Apply"; });
    expect(programTextDeterministicNoChange(fixture(pair).row)).toBeNull();
  });
  it("holds malformed or oversized share payloads and genuine adjacent rule changes", () => {
    for (const payload of ["?subject=Award&body=", "?subject=%ZZ&body=Award", "?subject=%C3%28&body=Award",
      "?subject=%00&body=Award", "?subject=Award&body=Line%0ABreak",
      "?subject=Award&body=Line\nBreak", "?subject=Award&body=" + "x".repeat(4096)]) {
      expect(programTextDeterministicNoChange(fixture([shareLink(payload, 0x37), shareLink(payload, 0x4a)]).row)).toBeNull();
    }
    const payload = "?subject=Award&body=Current%20requirements";
    expect(programTextDeterministicNoChange(fixture([shareLink(payload, 0x37), shareLink(payload, 0x4a)],
      [[{ text: "Deadline: October 1, 2027", kind: "p" }, { text: "Deadline: October 2, 2027", kind: "p" }]]).row)).toBeNull();
  });
  it("never uses the share rule for an already submitted comparison", () => {
    const payload = "?subject=Award&body=Current%20requirements", f = fixture([shareLink(payload, 0x37), shareLink(payload, 0x4a)]);
    f.row.status = "submitted"; f.row.submitted_at = "2026-10-24T12:00:02.000Z";
    expect(programTextDeterministicNoChange(f.row)).toBeNull();
  });
  it.each(noise.map((pair, index) => [index + 1, pair]))("accepts exact real noise block %i without changing inputs", (_, pair) => {
    const { row } = fixture(pair), before = structuredClone(row), result = programTextDeterministicNoChange(row);
    expect(result).toMatchObject({ status: "ready", validation: { status: "no_program_change", changes: [] },
      provenance: { generated_by_gemini: false, new_provider_calls: 0, spend_mutations: 0, creates_update: false } });
    expect(row).toEqual(before);
  });
  it("requires every changed block and reconstructs the entire current text", () => {
    const f = fixture(noise[0], noise.slice(1));
    expect(programTextDeterministicNoChange(f.row)?.provenance.rules).toHaveLength(5);
  });
  it.each(["processing", "submitted", "succeeded", "failed", "rejected", "published"])("never closes %s work locally", status => {
    const f = fixture(); f.row.status = status; expect(programTextDeterministicNoChange(f.row)).toBeNull();
  });
  it.each(PROGRAM_TEXT_UNPAID_NULL_FIELDS)("excludes existing paid/submitted/claimed top-level field %s", key => {
    const f = fixture(); f.row[key] = "already-present"; expect(programTextDeterministicNoChange(f.row)).toBeNull();
  });
  it.each(["program_text_claim_token", "claim_started_at", "gemini_spend_reservation_id", "gemini_spend_attempt_token", "provider_request_keys",
    "batch_create_started_at", "paid_retry_approval_id", "manual_program_text_adjudication_history"])("excludes metadata marker %s", key => {
    const f = fixture(); f.row.worker_metadata[key] = "present"; expect(programTextDeterministicNoChange(f.row)).toBeNull();
  });
  it("excludes existing usage, missing update time, wrong scope or changed signature", () => {
    for (const edit of [row => { row.actual_usage = { total: 1 }; }, row => { delete row.updated_at; }, row => { row.candidate_scope = "page_change"; },
      row => { row.candidate_signature = "f".repeat(64); }]) { const f = fixture(); edit(f.row); expect(programTextDeterministicNoChange(f.row)).toBeNull(); }
  });
  it("holds modified packet plans and invalid comparison seals", () => {
    const f = fixture(noise[1]); f.row.prompt_payload.packet_plan.packets[0].blocks = []; expect(programTextDeterministicNoChange(f.row)).toBeNull();
    const other = fixture(); other.row.prompt_payload.comparison.current_text += "altered"; expect(programTextDeterministicNoChange(other.row)).toBeNull();
  });
  it("falls back for real email destination changes, absolute links and malformed/non-ASCII addresses", () => {
    for (const pair of [[email(encoded("one@example.org")), email(encoded("two@example.org"))],
      [email("https://example.org" + noise[1][0].text), noise[1][1]], [email("/cdn-cgi/l/email-protection#123"), noise[1][1]],
      [email(encoded("é@example.org", 13)), email(encoded("é@example.org", 27))],
      [email(encoded("not-an-email", 13)), email(encoded("not-an-email", 27))],
      [email(encoded("a..b@example.org", 13)), email(encoded("a..b@example.org", 27))],
      [email(encoded(".name@example.org", 13)), email(encoded(".name@example.org", 27))],
      [noise[1][0], email(noise[1][1].text.replace("/cdn-cgi/", "/CDN-CGI/"))]]) expect(programTextDeterministicNoChange(fixture(pair).row)).toBeNull();
  });
  it("falls back for changed heading/context/kind/href attribute even when decoded email is identical", () => {
    for (const edit of [block => { block.heading = "Application contact"; }, block => { block.context.link_text = "Apply"; },
      block => { block.kind = "p"; }, block => { block.context.source_attribute = "data-email"; }]) {
      const pair = structuredClone(noise[1]); edit(pair[1]); expect(programTextDeterministicNoChange(fixture(pair).row)).toBeNull();
    }
  });
  it("falls back for application phone rules or unreviewed newsletter labels", () => {
    for (const pair of [[newsletter("Company"), { ...newsletter("Phone"), text: "Phone number is required for the application." }],
      [newsletter("Company"), newsletter("Name")], [newsletter("Company"), { ...newsletter("Phone"), heading: "Application" }]])
      expect(programTextDeterministicNoChange(fixture(pair).row)).toBeNull();
  });
  it("falls back for added/removed blocks and mixed real changes", () => {
    for (const pair of [[noise[0][0], { text: "A new application document is required." }], [{ text: "Old requirement" }, noise[0][1]]])
      expect(programTextDeterministicNoChange(fixture(pair).row)).toBeNull();
    const real = [{ text: "Deadline: October 29, 2026." }, { text: "Deadline: October 30, 2026." }];
    expect(programTextDeterministicNoChange(fixture(noise[0], [real]).row)).toBeNull();
    const added = fixture(); added.row.prompt_payload.comparison.changed_blocks[0].previous = null; reseal(added.row);
    expect(programTextDeterministicNoChange(added.row)).toBeNull();
    const removed = fixture(); removed.row.prompt_payload.comparison.changed_blocks[0].current = null; reseal(removed.row);
    expect(programTextDeterministicNoChange(removed.row)).toBeNull();
  });
  it("rejects a resealed but incomplete whole-page change and ambiguous repeated old strings", () => {
    const f = fixture(); f.row.prompt_payload.comparison.current_text += " A hidden deadline changed."; reseal(f.row);
    expect(programTextDeterministicNoChange(f.row)).toBeNull();
    const repeated = fixture(); repeated.row.prompt_payload.comparison.previous_text += " " + noise[0][0].text; reseal(repeated.row);
    expect(programTextDeterministicNoChange(repeated.row)).toBeNull();
  });
});

function harness(f, beforeLocalPersist) {
  let saved = structuredClone(f.row), state = structuredClone(f.state); const calls = [], captures = new Map([[f.previous.capture_id, f.previous], [f.current.capture_id, f.current]]);
  const value = (row, key) => key.replaceAll("->>", ".").replaceAll("->", ".").split(".").reduce((v, key) => v?.[key], row);
  const db = { from(table) { const filters = []; let patch, selected, single = false;
    const q = { select(columns) { selected = columns; return q; }, eq(k, v) { filters.push(["eq", k, v]); return q; }, is(k, v) { filters.push(["is", k, v]); return q; },
      in(k, v) { filters.push(["in", k, v]); return q; }, single() { single = true; return q; }, update(v) { patch = v; return q; },
      then(yes, no) { return Promise.resolve().then(() => {
        if (!patch) { if (table !== "shared_award_sources" || !single) throw Error("Unexpected read"); calls.push("verify_source"); return { data: { ...source, admin_review_status: "open", text_monitoring_state: structuredClone(state) } }; }
        calls.push({ patch, filters }); if (patch.ai_result?.program_text_review_provenance) beforeLocalPersist?.(saved);
        const matches = filters.every(([op, key, expected]) => { const actual = value(saved, key);
          if (op === "is") return actual == null && expected === null;
          if (op === "in") return expected.includes(actual);
          if (["worker_metadata", "actual_usage"].includes(key)) return programTextEqual(actual, JSON.parse(expected));
          return actual === expected;
        });
        if (!matches) return { data: [] }; saved = { ...saved, ...structuredClone(patch) }; return { data: [selected === "*" ? structuredClone(saved) : { id: saved.id }] };
      }).then(yes, no); } }; return q;
  }, async rpc(name, args) {
    if (name !== "set_program_text_source_state" || saved.status !== "succeeded" || saved.ai_result?.program_text_validation?.status !== "no_program_change" ||
        !programTextEqual(state, args.p_expected_state)) throw Error("Existing no-change state guard not satisfied");
    calls.push("cas"); state = structuredClone(args.p_next_state); return { data: state };
  } };
  const repository = createProgramTextRepository(db, { bucket: "private-bucket", sourceIsApproved: async () => true,
    loadAward: async awardId => ({ id: awardId, name: "Example Award", status: "active" }), loadCapture: async ref => captures.get(ref.capture_id) });
  repository.listCandidates = vi.fn(async () => [structuredClone(saved)]);
  const publish = vi.fn(async () => { throw Error("No publication allowed"); }), reserve = vi.fn(async () => { throw Error("No paid reservation allowed in this offline test"); });
  const callbacks = { ...repository, loadCapture: async ref => captures.get(ref.capture_id), publishProgramChange: publish };
  return { db, repository, callbacks, calls, publish, reserve, get saved() { return saved; }, get state() { return state; } };
}
describe("existing review/repository/monitor integration", () => {
  it("cold-verifies and locally closes new unpaid noise using existing guarded state flow without spend/events/counter changes", async () => {
    const f = fixture(noise[0], noise.slice(1)); f.state.last_program_update_at = "2026-10-23T15:00:00.000Z";
    const h = harness(f), fetcher = vi.fn(async () => { throw Error("Network forbidden"); }); vi.stubGlobal("fetch", fetcher);
    const result = await review(h.repository, { supabase: h.db, apiKey: "fixture-never-sent", fetcher, ledger: { reserve: h.reserve } }, h.callbacks, 20, { source_ids: [source.id], epoch });
    expect(result).toEqual([{ candidate_id: id, status: "no_program_change", reason: null }]);
    expect(h.saved.status).toBe("rejected"); expect(h.saved.rejection_reason).toBe("no_program_change");
    expect(h.saved.ai_result.program_text_review_provenance).toMatchObject({ generated_by_gemini: false, new_provider_calls: 0, spend_mutations: 0 });
    expect(h.saved.worker_metadata).toEqual(f.row.worker_metadata); expect(h.saved.model).toBeNull(); expect(h.saved.gemini_batch_name).toBeNull();
    expect(h.state.baseline_ref).toEqual(f.row.new_snapshot_ref); expect(h.state.latest_ref).toEqual(f.row.new_snapshot_ref);
    for (const key of ["successful_checks", "first_captured_at", "last_checked_at", "last_program_update_at"]) expect(h.state[key]).toEqual(f.state[key]);
    expect(h.reserve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(h.publish).not.toHaveBeenCalled();
    const update = h.calls.find(call => call.patch?.ai_result);
    expect(update.filters).toContainEqual(["eq", "status", "pending"]); expect(update.filters).toContainEqual(["eq", "updated_at", f.row.updated_at]);
    expect(update.filters).toContainEqual(["eq", "worker_metadata", JSON.stringify(f.row.worker_metadata)]);
    for (const field of PROGRAM_TEXT_UNPAID_NULL_FIELDS) expect(update.filters).toContainEqual(["is", field, null]);
  });
  it("takes the existing paid-review path for a mixed real detail change", async () => {
    const f = fixture(noise[0], [[{ text: "Deadline: October 29, 2026." }, { text: "Deadline: October 30, 2026." }]]), h = harness(f);
    await review(h.repository, { supabase: h.db, apiKey: "fixture-never-sent", ledger: { reserve: h.reserve } }, h.callbacks, 20, { source_ids: [source.id], epoch });
    expect(h.reserve).toHaveBeenCalledTimes(1); expect(h.calls.some(call => call.patch?.ai_result?.program_text_review_provenance)).toBe(false);
    expect(h.state).toEqual(f.state); expect(h.publish).not.toHaveBeenCalled();
  });
  it("does not overwrite a concurrently claimed or submitted paid row", async () => {
    for (const status of ["processing", "submitted"]) {
      const f = fixture(), h = harness(f, saved => { saved.status = status; saved.model = "gemini-fixture"; saved.worker_metadata = { ...saved.worker_metadata, gemini_spend_reservation_id: "existing-reservation" }; });
      const result = await review(h.repository, { supabase: h.db, apiKey: "fixture-never-sent", ledger: { reserve: h.reserve } }, h.callbacks, 20, { source_ids: [source.id], epoch });
      expect(result[0].status).toBe("held"); expect(h.state).toEqual(f.state); expect(h.saved.status).toBe(status); expect(h.saved.ai_result).toBeNull();
      expect(h.reserve).not.toHaveBeenCalled(); expect(h.publish).not.toHaveBeenCalled();
    }
  });
  it("holds before local persistence when cold-original verification fails", async () => {
    const f = fixture(), h = harness(f); h.repository.verifyCandidate = vi.fn(async () => { throw Error("Original invalid"); });
    const result = await review(h.repository, {}, h.callbacks, 20, { source_ids: [source.id], epoch });
    expect(result[0].status).toBe("held"); expect(h.calls.filter(call => call.patch)).toEqual([]); expect(h.reserve).not.toHaveBeenCalled();
  });
  it("holds a reservation-metadata race even while status and model are still fresh", async () => {
    const f = fixture(), h = harness(f, saved => { saved.worker_metadata = { ...saved.worker_metadata, gemini_spend_reservation_id: "concurrent-reservation" }; });
    const result = await review(h.repository, {}, h.callbacks, 20, { source_ids: [source.id], epoch });
    expect(result[0].status).toBe("held"); expect(h.saved.status).toBe("pending"); expect(h.saved.ai_result).toBeNull();
    expect(h.saved.worker_metadata.gemini_spend_reservation_id).toBe("concurrent-reservation"); expect(h.state).toEqual(f.state);
  });
  it("holds a changed row-version even if it remains pending and unpaid", async () => {
    const f = fixture(), h = harness(f, saved => { saved.updated_at = "2026-10-24T12:00:02.000Z"; });
    const result = await review(h.repository, {}, h.callbacks, 20, { source_ids: [source.id], epoch });
    expect(result[0].status).toBe("held"); expect(h.saved.ai_result).toBeNull(); expect(h.state).toEqual(f.state);
  });
  it("rejects a caller-supplied deterministic override with invented no-change responses", async () => {
    const f = fixture(), h = harness(f), local = programTextDeterministicNoChange(f.row); local.responses[0].blocks[0].reason = "invented override";
    await expect(h.repository.recordReviewResult({ candidate: programTextCandidateWork(f.row), validation: local.validation,
      responses: local.responses, deterministicCandidate: f.row })).rejects.toThrow("Invalid deterministic");
    expect(h.calls.filter(call => call.patch)).toEqual([]);
  });
  it("preserves strict deterministic provenance when succeeded work resumes after interruption", async () => {
    const f = fixture(), local = programTextDeterministicNoChange(f.row);
    f.row = { ...f.row, status: "succeeded", completed_at: "2026-10-24T12:00:02.000Z",
      ai_result: { responses: local.responses, program_text_validation: local.validation, program_text_review_provenance: local.provenance } };
    const h = harness(f);
    expect(programTextDeterministicNoChange(f.row)).toBeNull(); // This is ordinary resume, never a fresh local fast path.
    const result = await review(h.repository, { supabase: h.db, apiKey: "fixture-never-sent", ledger: { reserve: h.reserve } }, h.callbacks, 20, { source_ids: [source.id], epoch });
    expect(result[0].status).toBe("no_program_change"); expect(h.saved.status).toBe("rejected");
    expect(h.saved.ai_result.program_text_review_provenance).toEqual(local.provenance); expect(h.reserve).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled(); expect(h.state.successful_checks).toBe(f.state.successful_checks);
  });
  it("rejects a forged stored receipt rather than attributing provider work to deterministic rules", async () => {
    const f = fixture(), h = harness(f), local = programTextDeterministicNoChange(f.row);
    await expect(h.repository.recordReviewResult({ candidate: programTextCandidateWork(f.row), validation: local.validation,
      responses: local.responses, deterministicProvenance: { ...local.provenance, new_provider_calls: 1 } })).rejects.toThrow("Invalid stored deterministic provenance");
    expect(h.calls.filter(call => call.patch)).toEqual([]);
  });
  it("keeps the ordinary failed-result exclusion even for a valid deterministic receipt", async () => {
    const f = fixture(), local = programTextDeterministicNoChange(f.row); f.row.status = "failed"; const h = harness(f);
    const result = await h.repository.recordReviewResult({ candidate: programTextCandidateWork(f.row), validation: local.validation,
      responses: local.responses, deterministicProvenance: local.provenance });
    expect(result.persisted).toBe(false); expect(h.saved.status).toBe("failed"); expect(h.saved.ai_result).toBeNull();
    expect(h.state).toEqual(f.state);
  });
});
