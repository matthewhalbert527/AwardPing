import { describe, expect, it } from "vitest";
import { buildProgramTextCapture } from "./program-text-capture.mjs";
import { PROGRAM_DETAIL_FIELDS, parseProgramTextChangeDetails } from "./program-change-contract.mjs";
import { buildProgramTextComparison, buildProgramTextReviewPackets, validateProgramTextReviewResult,
  buildProgramTextChangeDetails, programTextReviewResponseSchema } from "./program-text-review.mjs";

const source = { id: "10000000-0000-0000-0000-000000000001", shared_award_id: "20000000-0000-0000-0000-000000000001",
  url: "https://example.edu/award", title: "Example Scholarship", page_type: "application" };
const context = { epoch: "text-monitoring-1", cycle_id: "2027" };
function capture(values, day = 1, overrides = {}) {
  const entries = values.map(value => typeof value === "string" ? { text: value } : value);
  let text = "";
  const blocks = entries.map((entry, index) => {
    if (index) text += "\n\n";
    const start = text.length; text += entry.text;
    return { id: `block-${index}`, start_utf16: start, end_utf16: text.length, ...entry };
  });
  return buildProgramTextCapture({ source, final_url: source.url, captured_at: `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`,
    acquisition: "http_html", extractor: { name: "test-extractor", version: "1" }, raw_bytes: Buffer.from(`<main>${text}</main>`),
    content_type: "text/html", text, blocks, ...overrides });
}
function fixture(before = ["Application deadline: October 1, 2027, 5:00 p.m. Central Time."], after = ["Application deadline: October 15, 2027, 5:00 p.m. Central Time."], options) {
  const previous = capture(before), current = capture(after, 2);
  const comparison = buildProgramTextComparison(previous, current, context), plan = buildProgramTextReviewPackets(comparison, options);
  return { previous, current, comparison, plan };
}
function responsesFor(plan, disposition = "program_change") {
  return plan.packets.map(packet => ({ schema: "awardping.program-text-review.v1", comparison_id: packet.comparison_id,
    packet_id: packet.packet_id, ...packet.context, blocks: packet.blocks.map(row => ({ id: row.id, disposition,
      reason: disposition === "program_change" ? "The application deadline changed for this award and cycle." : "Only news or page wording changed.",
      changes: disposition === "program_change" ? [{ field: "deadline", operation: row.previous && row.current ? "replace" : row.previous ? "remove" : "add",
        summary: "The application deadline changed.", previous_quote: row.previous ? { block_id: row.previous.id, text: row.previous.text } : null,
        current_quote: row.current ? { block_id: row.current.id, text: row.current.text } : null, applicant_impact: true }] : [] })) }));
}
const validate = ({ comparison, plan }, results = responsesFor(plan)) => validateProgramTextReviewResult(comparison, plan, results);

describe("literal application destination attributes", () => {
  it("supports relative application href changes without inventing absolute source wording", () => {
    const href = text => ({ text, heading: "Application portal", kind: "source_link", context: { source_attribute: "href", link_text: "Apply" } });
    const f = fixture([href("/apply/current")], [href("/apply/new-cycle")]);
    const responses = responsesFor(f.plan);
    responses[0].blocks[0].changes[0].field = "application_url";
    responses[0].blocks[0].changes[0].summary = "The application portal link changed.";
    const result = validate(f, responses);
    expect(result.status).toBe("accepted");
    expect(result.details.program_changes[0].current_quote.text).toBe("/apply/new-cycle");
  });
  it("does not treat an arbitrary relative string as a verified link attribute", () => {
    const f = fixture([{ text: "/apply/current", heading: "Application portal" }], [{ text: "/apply/new-cycle", heading: "Application portal" }]);
    const responses = responsesFor(f.plan); responses[0].blocks[0].changes[0].field = "application_url";
    expect(validate(f, responses).status).toBe("held");
  });
});

describe("program text comparison", () => {
  it("retains original line breaks and UTF-16 offsets instead of matching a normalized prompt", () => {
    const f = fixture(["🎓 Eligibility\nStudents must receive a bachelor's degree\nbetween December 2026 and August 2027."],
      ["🎓 Eligibility\nStudents must receive a bachelor's degree\nbetween December 2027 and August 2028."]);
    const responses = responsesFor(f.plan);
    responses[0].blocks[0].changes[0].field = "eligibility";
    const result = validate(f, responses), details = buildProgramTextChangeDetails(result);
    expect(result.status).toBe("accepted");
    const quote = details.program_changes[0].current_quote;
    expect(f.current.text.slice(quote.start_utf16, quote.end_utf16)).toBe(quote.text);
    expect(quote.text).toContain("degree\nbetween");
    expect(quote.end_utf16).toBe(f.current.text.length);
    responses[0].blocks[0].changes[0].current_quote.text = quote.text.replaceAll("\n", " ");
    expect(validate(f, responses)).toMatchObject({ status: "held", reasons: ["quote_missing_or_ambiguous"] });
  });

  it("ignores whitespace-only differences while leaving both originals unchanged", () => {
    const f = fixture(["Application deadline:\nOctober 1, 2027."], ["Application deadline: October 1, 2027."]);
    expect(f.comparison.status).toBe("unchanged");
    expect(f.comparison.previous_text).toContain("\n");
    expect(f.plan).toMatchObject({ status: "unchanged", packets: [] });
    expect(validate(f, [])).toMatchObject({ status: "no_program_change" });
  });

  it("does not mistake an unchanged page with reordered sections for an award update", () => {
    const f = fixture(["Deadline: October 1", "Eligibility: U.S. citizens", "Funding: $5,000"], ["Funding: $5,000", "Deadline: October 1", "Eligibility: U.S. citizens"]);
    expect(f.comparison.status).toBe("unchanged");
  });

  it("detects changed heading qualifications even when a date value stays the same", () => {
    const f = fixture([{ text: "October 1, 2027", heading: "U.S. applicants" }], [{ text: "October 1, 2027", heading: "International applicants" }]);
    expect(f.comparison.status).toBe("review_required");
    expect(f.plan.packets[0].blocks[0]).toMatchObject({ previous: { heading: "U.S. applicants" }, current: { heading: "International applicants" } });
    // Identical dates alone cannot prove how the applicant scope changed.
    expect(validate(f).status).toBe("held");
  });

  it("ignores only a proven copyright year substitution", () => {
    expect(fixture(["© 2026 Foundation. All rights reserved."], ["© 2027 Foundation. All rights reserved."]).comparison.status).toBe("unchanged");
    expect(fixture(["Application cycle 2026"], ["Application cycle 2027"]).comparison.status).toBe("review_required");
  });

  it("rejects missing epoch or application-cycle context", () => {
    const { previous, current } = fixture();
    expect(buildProgramTextComparison(previous, current)).toMatchObject({ status: "held" });
    expect(buildProgramTextComparison(previous, current, { epoch: "text-monitoring-1" })).toMatchObject({ status: "held" });
    expect(buildProgramTextComparison(previous, current, { epoch: "text-monitoring-1", cycle_id: null }).status).toBe("review_required");
  });

  it.each([
    ["wrong award", f => { f.current.source.shared_award_id = "30000000-0000-0000-0000-000000000001"; }],
    ["changed extraction version", f => { f.current.extractor.version = "2"; }],
    ["uncovered text", f => { f.current.blocks[0].end_utf16--; f.current.blocks[0].text = f.current.blocks[0].text.slice(0, -1); }],
    ["duplicate block id", f => { f.current.blocks.push({ ...f.current.blocks[0] }); }],
    ["incomplete capture", f => { f.current.completeness = { status: "incomplete", reasons: ["ocr_uncertain"] }; }],
    ["raw tampering", f => { f.current.raw_source.bytes[0] ^= 1; }],
    ["text tampering", f => { f.current.text += "extra"; }],
    ["capture metadata tampering", f => { f.current.captured_at = "2026-10-03T12:00:00.000Z"; }],
  ])("holds %s", (_, mutate) => {
    const f = fixture(); mutate(f);
    expect(buildProgramTextComparison(f.previous, f.current, context).status).toBe("held");
  });

  it("requires newer observations and keeps established source URLs intact", () => {
    const { previous } = fixture();
    expect(buildProgramTextComparison(previous, previous, context)).toMatchObject({ status: "held", reasons: ["capture_order_invalid"] });
    const current = capture(["New deadline: October 15, 2027"], 2, { final_url: "https://example.edu/award-new" });
    expect(buildProgramTextComparison(previous, current, context)).toMatchObject({ status: "held", reasons: ["capture_identity_changed"] });
  });
});

describe("complete bounded review packets", () => {
  it("includes late long-page changes, with no clipped prefix and full ordered coverage", () => {
    const before = Array.from({ length: 140 }, (_, index) => `Requirement ${index}: provide exactly two references. ${"Supporting program instructions. ".repeat(8)}`);
    const after = before.map(line => line.replace("two", "three"));
    after[139] += " Final application deadline: October 15, 2027.";
    const f = fixture(before, after, { max_packet_bytes: 7000, max_blocks_per_packet: 3 });
    expect(f.plan.status).toBe("ready");
    expect(f.plan.packets.length).toBeGreaterThan(40);
    const rows = f.plan.packets.flatMap(packet => packet.blocks);
    expect(rows).toEqual(f.comparison.changed_blocks);
    expect(rows.at(-1).current.text).toContain("Final application deadline: October 15, 2027.");
    expect(f.plan.packets.every(packet => Buffer.byteLength(JSON.stringify(packet)) <= 7000)).toBe(true);
    expect(JSON.stringify(f.plan)).not.toContain('"raw_source"');
    expect(JSON.stringify(f.plan)).not.toContain('"previous_text"');
    const responses = responsesFor(f.plan, "no_program_change");
    expect(validate(f, responses).status).toBe("no_program_change");
    responses.at(-1).blocks.at(-1).disposition = "needs_review";
    expect(validate(f, responses)).toMatchObject({ status: "held", reasons: ["unresolved_changed_block"] });
  });

  it("holds an oversized complete block rather than returning a usable prefix", () => {
    const f = fixture([`Requirements: ${"Old text ".repeat(1500)}`], [`Requirements: ${"New text ".repeat(1500)}`], { max_packet_bytes: 7000 });
    expect(f.plan).toEqual({ status: "held", reasons: ["complete_block_exceeds_packet_limit"] });
    expect(f.plan.packets).toBeUndefined();
  });

  it("holds excessive total packets, never returning the first few", () => {
    const f = fixture(Array.from({ length: 10 }, (_, n) => `Old requirement ${n}`), Array.from({ length: 10 }, (_, n) => `New requirement ${n}`), { max_blocks_per_packet: 1, max_packets: 2 });
    expect(f.plan).toEqual({ status: "held", reasons: ["complete_comparison_exceeds_packet_limit"] });
  });

  it("requires the same complete packet plan and unchanged comparison", () => {
    const f = fixture(), responses = responsesFor(f.plan);
    const tampered = structuredClone(f.plan); tampered.packets[0].blocks[0].current.text = "Fabricated";
    expect(validateProgramTextReviewResult(f.comparison, tampered, responses).status).toBe("held");
    f.comparison.current_text += "Fabricated";
    expect(validate(f, responses)).toMatchObject({ status: "held", reasons: ["invalid_comparison_integrity"] });
  });

  it("survives JSONB object-key reordering without changing arrays, source text, or identifiers", () => {
    const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reorder(value[key])])) : value;
    const f = fixture(), results = responsesFor(f.plan);
    const comparison = reorder(JSON.parse(JSON.stringify(f.comparison))), plan = reorder(JSON.parse(JSON.stringify(f.plan)));
    expect(validateProgramTextReviewResult(comparison, plan, reorder(results))).toEqual(validate(f, results));
    expect(buildProgramTextReviewPackets(comparison).packets.map(packet => packet.packet_id)).toEqual(f.plan.packets.map(packet => packet.packet_id));
    expect(comparison.previous_text).toBe(f.previous.text);
  });
});

describe("strict program-only result validation", () => {
  it("publishes an exact deadline replacement with traceable original offsets", () => {
    const f = fixture(), result = validate(f);
    expect(result.status).toBe("accepted");
    const details = buildProgramTextChangeDetails(result);
    expect(details).toEqual({ schema: "awardping.program-change.v1", event_kind: "program_details_changed", summary: "The application deadline changed.", program_changes: [{
      field: "deadline", operation: "replace", summary: "The application deadline changed.",
      previous_quote: { block_id: "block-0", start_utf16: 0, end_utf16: f.previous.text.length, text: f.previous.text },
      current_quote: { block_id: "block-0", start_utf16: 0, end_utf16: f.current.text.length, text: f.current.text },
    }] });
    expect(parseProgramTextChangeDetails(details)).toEqual(details);
  });

  it.each([
    ["award", response => { response.award_id = "other-award"; }],
    ["source", response => { response.source_id = "other-source"; }],
    ["cycle", response => { response.cycle_id = "2026"; }],
    ["epoch", response => { response.epoch = "legacy"; }],
    ["packet", response => { response.packet_id = "wrong"; }],
    ["comparison", response => { response.comparison_id = "wrong"; }],
    ["missing row", response => { response.blocks = []; }],
    ["duplicated row", response => { response.blocks.push(response.blocks[0]); }],
    ["invented row", response => { response.blocks[0].id = "invented"; }],
    ["visual fallback", response => { response.image = "https://example.edu/evidence.jpg"; }],
  ])("rejects %s mismatch", (_, mutate) => {
    const f = fixture(), results = responsesFor(f.plan); mutate(results[0]); expect(validate(f, results).status).toBe("held");
  });

  it.each([
    ["overview", change => { change.field = "overview"; }],
    ["file metadata", change => { change.field = "file_hash"; }],
    ["news", change => { change.field = "news"; }],
    ["no applicant impact", change => { change.applicant_impact = false; }],
    ["invented exact wording", change => { change.current_quote.text = "The application is due tomorrow."; }],
    ["wrong block", change => { change.current_quote.block_id = "context-block"; }],
    ["invented summary number", change => { change.summary = "The award now provides $90,000."; }],
    ["model supplied offsets", change => { change.current_quote.start_utf16 = 1; }],
    ["missing required quote", change => { change.current_quote = null; }],
    ["incorrect addition", change => { change.operation = "add"; }],
  ])("holds %s", (_, mutate) => {
    const f = fixture(), results = responsesFor(f.plan); mutate(results[0].blocks[0].changes[0]); expect(validate(f, results).status).toBe("held");
  });

  it("accepts a new requirement and a removed requirement using the correct null side", () => {
    for (const f of [fixture(["Eligibility"], ["Eligibility", "Applicants must submit two references."]), fixture(["Eligibility", "Applicants must submit two references."], ["Eligibility"])]) {
      const responses = responsesFor(f.plan); responses[0].blocks[0].changes[0].field = "application_materials";
      const result = validate(f, responses); expect(result.status).toBe("accepted");
      expect(result.details.program_changes[0].operation).toBe(f.current.text.length > f.previous.text.length ? "add" : "remove");
    }
  });

  it("does not claim that an unchanged sentence elsewhere was added or removed", () => {
    const f = fixture(["Applicants must submit two references.", "Applications open soon."], ["Applicants must submit two references.", "Applicants must submit two references."]);
    const results = responsesFor(f.plan); results[0].blocks[0].changes[0].operation = "add"; results[0].blocks[0].changes[0].previous_quote = null;
    results[0].blocks[0].changes[0].field = "application_materials";
    expect(validate(f, results)).toMatchObject({ status: "held", reasons: ["change_operation_not_supported"] });
  });

  it("requires a unique quotation within the changed block", () => {
    const f = fixture(["Deadline October 1. Deadline October 1."], ["Deadline October 15. Deadline October 15."]);
    const results = responsesFor(f.plan); results[0].blocks[0].changes[0].current_quote.text = "October 15";
    expect(validate(f, results)).toMatchObject({ status: "held", reasons: ["quote_missing_or_ambiguous"] });
  });

  it("accepts a verified no-program-change disposition for recipient/news changes", () => {
    const f = fixture(["Meet the 2026 recipients and their accomplishments."], ["Meet the 2027 recipients and their accomplishments."]);
    const result = validate(f, responsesFor(f.plan, "no_program_change"));
    expect(result.status).toBe("no_program_change");
    expect(buildProgramTextChangeDetails(result)).toBeNull();
  });

  it("rejects obvious news relabeled as a program date without supporting field evidence", () => {
    const f = fixture(["Meet the 2026 recipients and their accomplishments."], ["Meet the 2027 recipients and their accomplishments."]);
    expect(validate(f)).toMatchObject({ status: "held", reasons: ["unsupported_program_field_evidence"] });
  });

  it("holds all changes when another changed block remains unresolved", () => {
    const f = fixture(["Deadline October 1", "Eligibility uncertain old text"], ["Deadline October 15", "Eligibility uncertain new text"]);
    const results = responsesFor(f.plan); results[0].blocks[1] = { id: results[0].blocks[1].id, disposition: "needs_review", reason: "The applicant track is unclear.", changes: [] };
    expect(validate(f, results)).toMatchObject({ status: "held", reasons: ["unresolved_changed_block"] });
  });

  it("does not accept omitted, reversed or duplicate packet responses", () => {
    const f = fixture(["Deadline October 1", "Eligibility U.S. citizens"], ["Deadline October 15", "Eligibility all citizens"], { max_blocks_per_packet: 1 });
    const results = responsesFor(f.plan);
    expect(validate(f, results.slice(0, 1)).status).toBe("held");
    expect(validate(f, [...results].reverse()).status).toBe("held");
    expect(validate(f, [results[0], results[0]]).status).toBe("held");
  });

  it("rejects a duplicate field-and-quotation change", () => {
    const f = fixture(), results = responsesFor(f.plan); results[0].blocks[0].changes.push(structuredClone(results[0].blocks[0].changes[0]));
    expect(validate(f, results)).toMatchObject({ status: "held", reasons: ["duplicate_program_change"] });
  });

  it("exposes only canonical applicant-relevant fields through a strict response schema", () => {
    const change = programTextReviewResponseSchema.properties.blocks.items.properties.changes.items;
    expect(change.properties.field.enum).toEqual(PROGRAM_DETAIL_FIELDS);
    expect(PROGRAM_DETAIL_FIELDS).not.toContain("overview");
    expect(PROGRAM_DETAIL_FIELDS).not.toContain("source_titles");
    expect(programTextReviewResponseSchema.additionalProperties).toBe(false);
    expect(change.additionalProperties).toBe(false);
  });

  it("keeps invalid or legacy objects outside the new public contract", () => {
    const details = buildProgramTextChangeDetails(validate(fixture()));
    expect(parseProgramTextChangeDetails({ ...details, screenshot: "saved.jpg" })).toBeNull();
    expect(parseProgramTextChangeDetails({ ...details, schema: "legacy" })).toBeNull();
    const bad = structuredClone(details); bad.program_changes[0].current_quote.end_utf16--;
    expect(parseProgramTextChangeDetails(bad)).toBeNull();
    const field = structuredClone(details); field.program_changes[0].field = "overview";
    expect(parseProgramTextChangeDetails(field)).toBeNull();
  });
});
