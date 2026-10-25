import { describe, it, expect, vi } from "vitest";
import { PROGRAM_FACT_FIELDS, emptyProgramFactReview, validateProgramFactReview, programFactPublicValues } from "./program-text-facts.mjs";
import { buildProgramTextCapture } from "./program-text-capture.mjs";
import { programTextReference } from "./program-text-storage.mjs";

const epoch = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const source = { id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222",
    url: "https://example.org/award", title: "Example Award", page_type: "application", admin_review_status: "open" };
  const text = "🎓 Example Award supports graduate study. The application deadline is January 31, 2027.";
  const capture = buildProgramTextCapture({ source, acquisition: "http_html", raw_bytes: Buffer.from(`<html><body>${text}</body></html>`), content_type: "text/html", text,
    blocks: [{ id: "body", text, start_utf16: 0, end_utf16: text.length }], extractor: { name: "fixture", version: "1" }, captured_at: "2026-10-24T01:00:00.000Z" });
  const ref = programTextReference(capture);
  const current = { ...source, text_monitoring_state: { schema: "awardping.program-text-state.v1", epoch, status: "baseline_ready", baseline_ref: ref, latest_ref: ref,
    successful_checks: 2, first_captured_at: "2026-10-23T01:00:00.000Z", last_checked_at: ref.captured_at } };
  const role = { source_role: "application", revision: epoch, source_ids: [source.id], manifest_status: "reviewed_text",
    evidence: { schema: "awardping.program-text-source-role.v1", source_bindings: { [source.id]: { source_url: source.url, shared_award_id: source.shared_award_id } } } };
  const context = { registry: { cohort_key: "example", canonical_shared_award_id: source.shared_award_id }, roles: [role], sources: [current], memberIds: [source.shared_award_id], epoch,
    loadCapture: vi.fn(async () => capture), forApproval: true };
  const review = emptyProgramFactReview({ ...context, cycle: "2027" });
  review.reviewed_all_sources = true;
  for (const field of review.fields) { field.status = "not_published"; field.note = "The complete official source set was reviewed; this detail is not published."; }
  const quote = value => ({ source_id: source.id, capture_id: capture.capture_id, block_id: "body", start_utf16: text.indexOf(value), end_utf16: text.indexOf(value) + value.length, text: value });
  const overview = review.fields.find(field => field.field === "overview"); overview.status = "verified";
  overview.items = [{ value: "Example Award supports graduate study.", track: null, support: [quote("Example Award supports graduate study.")] }];
  const deadline = review.fields.find(field => field.field === "deadline"); deadline.status = "verified";
  deadline.items = [{ value: "January 31, 2027", track: null, support: [quote("The application deadline is January 31, 2027.")] }];
  return { context, review, capture, quote };
}

describe("current program details require their own review", () => {
  it("creates only unresolved suggestions, never legacy fact approval", () => {
    const { context } = fixture(); const draft = emptyProgramFactReview({ ...context, cycle: "2027" });
    expect(draft.reviewed_all_sources).toBe(false); expect(draft.fields.map(field => field.field)).toEqual(PROGRAM_FACT_FIELDS);
    expect(draft.fields.every(field => field.status === "unresolved" && !field.items.length)).toBe(true);
  });
  it("cold-restores the complete source set and binds UTF16 quotes without model or database calls", async () => {
    const { context, review } = fixture(); const result = await validateProgramFactReview(review, context);
    expect(result.blockers).toEqual([]); expect(result.public_facts.deadline).toBe("January 31, 2027");
    expect(result.source_text[0].text.startsWith("🎓")).toBe(true);
    expect(context.loadCapture).toHaveBeenCalledExactlyOnceWith(review.capture_refs[0]);
  });
  it.each([
    r => { r.award_id = epoch; }, r => { r.epoch = r.award_id; }, r => { r.cohort_key = "sibling"; },
    r => { r.roster[0].revision = r.award_id; }, r => { r.capture_refs = []; },
    r => { r.capture_refs.push(r.capture_refs[0]); }, r => { r.fields.pop(); },
    r => { r.fields.push(r.fields[0]); }, r => { r.fields[0].surprise = true; },
    r => { r.fields[0].items[0].support[0].text += " fabricated"; },
    r => { r.fields[0].items[0].support[0].capture_id = "a".repeat(64); },
    r => { r.fields[0].items[0].support[0].source_id = epoch; },
    r => { r.fields[0].items[0].support[0].start_utf16++; },
    r => { r.fields.find(f => f.field === "deadline").items[0].value = "January 31, 2028"; },
  ])("rejects wrong identity, stale versions, omissions or invented evidence %#", async mutate => {
    const { context, review } = fixture(); mutate(review);
    await expect(validateProgramFactReview(review, context)).rejects.toThrow("Program fact review:");
  });
  it.each([
    c => { c.sources[0].admin_review_status = "closed"; }, c => { c.sources[0].text_monitoring_state.status = "awaiting_review"; },
    c => { c.sources[0].text_monitoring_state.successful_checks = 1; }, c => { c.memberIds = [epoch]; },
    c => { c.roles[0].evidence.source_bindings[c.sources[0].id].shared_award_id = epoch; },
    c => { c.roles[0].evidence.schema = "legacy-visual"; },
  ])("cannot approve incomplete collection or another program's source %#", async mutate => {
    const { context, review } = fixture(); mutate(context);
    await expect(validateProgramFactReview(review, context)).rejects.toThrow();
  });
  it("holds unavailable or modified retained originals", async () => {
    const { context, review, capture } = fixture();
    context.loadCapture = async () => ({ ...capture, text: capture.text + " changed" });
    await expect(validateProgramFactReview(review, context)).rejects.toThrow();
    context.loadCapture = async () => { throw new Error("Original unavailable"); };
    await expect(validateProgramFactReview(review, context)).rejects.toThrow("Original unavailable");
  });
  it("allows unresolved drafts but never approves them or an unchecked full-source attestation", async () => {
    const { context, review } = fixture(); review.fields[1].status = "unresolved"; review.reviewed_all_sources = false;
    expect((await validateProgramFactReview(review, { ...context, forApproval: false })).blockers).toEqual([review.fields[1].field, "complete_source_context_not_reviewed"]);
    await expect(validateProgramFactReview(review, context)).rejects.toThrow("unresolved_review_cannot_be_approved");
  });
  it("requires distinct named application tracks for multiple deadlines", async () => {
    const { context, review } = fixture(); const field = review.fields.find(f => f.field === "deadline");
    field.items.push({ ...field.items[0], value: "January 31, 2027 at 11:59 PM" });
    await expect(validateProgramFactReview(review, context)).rejects.toThrow("conflicting_unscoped_dates_or_status");
    field.items[0].track = "US applicants"; field.items[1].track = "Other applicants";
    const result = await validateProgramFactReview(review, context);
    expect(result.public_facts.deadline).toBeNull();
    expect(result.public_facts.important_dates).toEqual(["Application deadline — US applicants: January 31, 2027", "Application deadline — Other applicants: January 31, 2027 at 11:59 PM"]);
  });
  it("never reintroduces legacy values for reviewed absent fields", () => {
    const { review } = fixture(); const output = programFactPublicValues(review);
    expect(output.eligibility).toEqual([]); expect(output.not_published_fields).toContain("eligibility"); expect(output.reviewed_cycle).toBe("2027");
  });
});
