import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { buildProgramTextCapture } from "../../scripts/lib/program-text-capture.mjs";
import { programTextReference, validateProgramTextReference } from "../../scripts/lib/program-text-storage.mjs";
import { hasPublishableProgramTextEvidence } from "@/lib/program-text-event-evidence";
import { hasPublishableEventEvidence, isPublicChangeEvent, type PublicChangeEventVisualEvidence } from "@/lib/public-change-event";
import { changeDetailsLabel, changeDetailsSearchText, changeDetailsToSummary, isMeaningfulChangeDetails } from "@/lib/change-details";
import { changeSummaryPresentation, dedupeChangeSummaries, displayChangeSummary, isUsefulChangeForAward, isUsefulChangeSummary } from "@/lib/change-summary";
import { buildPublicDigestChanges } from "@/lib/public-updates-core";
import { isMonitorableAwardSource, isPublicAwardSource, isUsableAwardFactSource } from "@/lib/source-quality";
import type { Stage1PublicationEntry } from "@/lib/stage1-publication";
import type { Json } from "@/lib/database.types";

const awardId = "20000000-0000-0000-0000-000000000001", sourceId = "10000000-0000-0000-0000-000000000001";
const source = { id: sourceId, shared_award_id: awardId, url: "https://example.edu/award/deadline", title: "Application deadline", page_type: "deadline" as const };
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value));
function fixture(url = source.url) {
  const captureSource = { ...source, url };
  const capture = (text: string, day: number) => Reflect.apply(buildProgramTextCapture, undefined, [{ source: captureSource, captured_at: `2026-10-${day}T12:00:00.000Z`,
    acquisition: "http_html", extractor: { name: "scrapling", version: "text-1" }, raw_bytes: Buffer.from(`<main>${text}</main>`),
    content_type: "text/html", text, blocks: [{ id: "deadline", text, start_utf16: 0, end_utf16: text.length }] }]) as ReturnType<typeof buildProgramTextCapture>;
  const previous = capture("Application deadline: October 1, 2027 at 5 p.m. Central Time.", 10);
  const current = capture("Application deadline: October 15, 2027 at 5 p.m. Central Time.", 11);
  const details = { schema: "awardping.program-change.v1", event_kind: "program_details_changed", summary: "Deadline extended.", program_changes: [{
    field: "deadline", operation: "replace", summary: "The deadline moved to October 15, 2027.",
    previous_quote: { block_id: "deadline", start_utf16: 0, end_utf16: previous.text.length, text: previous.text },
    current_quote: { block_id: "deadline", start_utf16: 0, end_utf16: current.text.length, text: current.text },
  }] };
  const event = { id: "30000000-0000-0000-0000-000000000001", shared_award_id: awardId, shared_award_source_id: sourceId,
    source_url: captureSource.url, source_title: source.title, source_page_type: source.page_type,
    summary: details.summary, change_details: details, visual_review_candidate_id: "40000000-0000-0000-0000-000000000001" };
  const evidence: PublicChangeEventVisualEvidence = { id: "50000000-0000-0000-0000-000000000001", change_event_id: event.id,
    shared_award_id: awardId, shared_award_source_id: sourceId, visual_review_candidate_id: event.visual_review_candidate_id,
    candidate_signature: "a".repeat(64), bucket: "awardping-private", evidence_schema_version: "program-text-event-evidence-v1", evidence_status: "verified_text",
    previous_capture: json(programTextReference(previous)), current_capture: json(programTextReference(current)),
    localization: json({ schema: "awardping.program-text-publication.v1", epoch: "60000000-0000-0000-0000-000000000001", comparison_id: "a".repeat(64),
      program_changes: details.program_changes, supporting_blocks: { previous: previous.blocks, current: current.blocks } }),
    created_at: "2026-10-11T12:05:00.000Z", verified_at: "2026-10-11T12:05:00.000Z", backfilled_at: null };
  const publication = { canonicalAwardId: awardId, memberAwardIds: [awardId], allowedSourceIds: [sourceId], allowedSourceIdSet: new Set([sourceId]),
    publishedFacts: {}, sourceIdentityRules: [], effectivelyVerified: true } as unknown as Stage1PublicationEntry;
  return { event, evidence, publication, award: { id: awardId, name: "Example Scholarship", status: "active" },
    source: { ...captureSource, admin_review_status: "open", source: "admin", page_metadata_generated_at: "2026-10-10T12:00:00.000Z", page_metadata_model: "test-review",
      page_metadata: { baseline_facts: { award_relevance: "primary", cycle_relevance: "current-or-upcoming", confidence: "high" } } } };
}
const record = (value: Json) => value as Record<string, Json>;

function syntheticSmartPublisherEvent() {
  const url = "https://www.smartscholarship.org/smart", f = fixture(url);
  const owner = "d7d4d117-f312-456f-a75c-3dbd5d372c99", id = "58aefec0-0d42-4b7b-9887-60d25940b3d0";
  Object.assign(f.event, { shared_award_id: owner, shared_award_source_id: id });
  Object.assign(f.evidence, { shared_award_id: owner, shared_award_source_id: id });
  for (const capture of [f.evidence.previous_capture, f.evidence.current_capture]) {
    const ref = record(capture), identity = record(ref.source), artifacts = record(ref.artifacts);
    Object.assign(identity, { id, shared_award_id: owner, url, page_type: "homepage" });
    ref.acquisition = "publisher_json"; ref.extractor = { name: "smart-publisher-json", version: "smart-publisher-json-v1" };
    for (const [role, artifact] of Object.entries(artifacts)) {
      const value = record(artifact);
      value.object_key = `program-text/sources/${id}/${ref.capture_id}/${role === "raw" ? "original.json" : role === "text" ? "text.txt" : "metadata.json"}`;
      if (role === "raw") value.content_type = "application/json";
    }
  }
  return f;
}

describe("publisher JSON public text boundary", () => {
  it("allows bound programme prose from the finite reviewed publisher profile", () => {
    const f = syntheticSmartPublisherEvent();
    expect(hasPublishableProgramTextEvidence(f.event, f.evidence)).toBe(true);
    record(f.evidence.current_capture).extractor = { name: "smart-publisher-json", version: "unreviewed" };
    expect(hasPublishableProgramTextEvidence(f.event, f.evidence)).toBe(false);
  });
  it.each(["kind", "representation"])("does not present generated publisher data as a source quotation (%s)", mode => {
    const f = syntheticSmartPublisherEvent(), proof = record(f.evidence.localization), supporting = record(proof.supporting_blocks);
    const block = record((supporting.current as Json[])[0]);
    if (mode === "kind") block.kind = "publisher_data";
    else block.context = { representation: "publisher_data", verbatim: false };
    expect(hasPublishableProgramTextEvidence(f.event, f.evidence)).toBe(false);
  });
});

// Synthetic immutable references, using the actual scoped NSF closure wording.
// Keep the exact public canonical name: spelling out Science Foundation would
// accidentally match Sciences in the summary and conceal the plural-word bug.
function nsfCycleStatusFixture(wording = {
  summary: "Applications for Chemistry; Geosciences; Mathematical Sciences; Physics and Astronomy are now closed.",
  previous: "October 23, 2026 by 8:00 p.m. Eastern time Chemistry; Geosciences; Mathematical Sciences; Physics and Astronomy",
  current: "October 23, 2026 by 8:00 p.m. Eastern time Chemistry; Geosciences; Mathematical Sciences; Physics and Astronomy applications are closed",
}) {
  const nsfSource = { id: "d4509d97-da9b-4e12-bbe9-45129e6ce1c1", shared_award_id: "d955a846-cee1-4c01-932e-e3cb7215f3fb",
    url: "https://www.nsfgrfp.org/", title: "NSF Graduate Research Fellowship Program", page_type: "homepage" };
  const make = (text: string, day: number) => Reflect.apply(buildProgramTextCapture, undefined, [{ source: nsfSource,
    final_url: "https://www.nsf.gov/funding/initiatives/grfp", captured_at: `2026-10-${day}T12:00:00.000Z`,
    acquisition: "http_html", extractor: { name: "scrapling-full-body-html", version: "program-text-v1/html-document-v2" },
    raw_bytes: Buffer.from(`<main><p>${text}</p></main>`), content_type: "text/html; charset=UTF-8", text,
    blocks: [{ id: "block-000012", text, start_utf16: 0, end_utf16: text.length }] }]) as ReturnType<typeof buildProgramTextCapture>;
  const previous = make(wording.previous, 10), current = make(wording.current, 11);
  const details = { schema: "awardping.program-change.v1", event_kind: "program_details_changed", summary: wording.summary,
    program_changes: [{ field: "cycle_status", operation: "replace", summary: wording.summary,
      previous_quote: { block_id: "block-000012", start_utf16: 0, end_utf16: previous.text.length, text: previous.text },
      current_quote: { block_id: "block-000012", start_utf16: 0, end_utf16: current.text.length, text: current.text } }] };
  const event = { id: "755e336b-cb87-4861-84a8-062e6c71a65e", shared_award_id: nsfSource.shared_award_id,
    shared_award_source_id: nsfSource.id, source_url: nsfSource.url, source_title: nsfSource.title, source_page_type: nsfSource.page_type,
    summary: wording.summary, change_details: details, visual_review_candidate_id: "8d40add5-89ea-4f96-9c31-f1f68c1fa472" };
  const evidence: PublicChangeEventVisualEvidence = { id: "10513e49-6647-4ae2-9e2c-3dfbee4dda90", change_event_id: event.id,
    shared_award_id: nsfSource.shared_award_id, shared_award_source_id: nsfSource.id, visual_review_candidate_id: event.visual_review_candidate_id,
    candidate_signature: "a".repeat(64), bucket: "synthetic-immutable-test-only", evidence_schema_version: "program-text-event-evidence-v1", evidence_status: "verified_text",
    previous_capture: json(programTextReference(previous)), current_capture: json(programTextReference(current)),
    localization: json({ schema: "awardping.program-text-publication.v1", epoch: "ec349339-ff62-4d2e-a610-8c361b4044ec", comparison_id: "a".repeat(64),
      program_changes: details.program_changes, supporting_blocks: { previous: previous.blocks, current: current.blocks } }),
    created_at: "2026-10-11T12:05:00.000Z", verified_at: "2026-10-11T12:05:00.000Z", backfilled_at: null };
  const publication = { canonicalAwardId: nsfSource.shared_award_id, memberAwardIds: [nsfSource.shared_award_id], allowedSourceIds: [nsfSource.id],
    allowedSourceIdSet: new Set([nsfSource.id]), publishedFacts: {}, sourceIdentityRules: [], effectivelyVerified: true } as unknown as Stage1PublicationEntry;
  return { event, evidence, publication, source: { ...nsfSource, admin_review_status: "open" },
    award: { id: nsfSource.shared_award_id, name: nsfSource.title, status: "active" } };
}

describe("explicit text-backed publication evidence", () => {
  it("accepts complete immutable text references and exact quotations without image slots", () => {
    const f = fixture();
    expect(() => validateProgramTextReference(f.evidence.previous_capture)).not.toThrow();
    expect(hasPublishableProgramTextEvidence(f.event, f.evidence)).toBe(true);
    expect(hasPublishableEventEvidence(f.event, f.evidence)).toBe(true);
    expect(isPublicChangeEvent(f)).toBe(true);
  });

  it("keeps the exact NSF Applications closure in public eligibility and digest without rewriting it", () => {
    const f = nsfCycleStatusFixture(), original = JSON.stringify({ event: f.event, evidence: f.evidence });
    expect(f.award.name).toBe("NSF Graduate Research Fellowship Program");
    expect(hasPublishableProgramTextEvidence(f.event, f.evidence)).toBe(true);
    expect(isUsefulChangeSummary(f.event.summary, f.event.change_details)).toBe(true);
    expect(isUsefulChangeForAward({ awardName: f.award.name, sourceTitle: f.source.title, sourceUrl: f.source.url,
      summary: f.event.summary, change_details: f.event.change_details })).toBe(true);
    expect(isPublicChangeEvent(f)).toBe(true);
    const digest = buildPublicDigestChanges([{ ...f.event, detected_at: f.evidence.verified_at! }], new Map([[f.award.id, f.award.name]]));
    expect(digest).toHaveLength(1); expect(digest[0].summary).toBe(f.event.summary);
    expect(JSON.stringify({ event: f.event, evidence: f.evidence })).toBe(original);
    f.publication.allowedSourceIdSet.clear(); expect(isPublicChangeEvent(f)).toBe(false);
  });

  it("still rejects irrelevant root-homepage wording despite structurally bound text evidence", () => {
    const f = nsfCycleStatusFixture({ summary: "The site header changed its decorative background colour.",
      previous: "The site header has a blue decorative background.", current: "The site header has a green decorative background." });
    expect(hasPublishableProgramTextEvidence(f.event, f.evidence)).toBe(true);
    expect(isUsefulChangeSummary(f.event.summary, f.event.change_details)).toBe(true);
    expect(isUsefulChangeForAward({ awardName: f.award.name, sourceTitle: f.source.title, sourceUrl: f.source.url,
      summary: f.event.summary, change_details: f.event.change_details })).toBe(false);
    expect(isPublicChangeEvent(f)).toBe(false);
  });

  it("does not let legacy baseline or visual-review holds hide a new accepted text comparison", () => {
    const f = fixture();
    f.source.page_metadata = { baseline_facts: { award_relevance: "unclear", cycle_relevance: "unclear", confidence: "low" } };
    expect(isPublicAwardSource(f.source)).toBe(false);
    expect(isMonitorableAwardSource(f.source)).toBe(false);
    expect(isUsableAwardFactSource(f.source)).toBe(false);
    expect(hasPublishableProgramTextEvidence(f.event, f.evidence)).toBe(true);
    expect(isPublicChangeEvent(f)).toBe(true);
  });

  it("admits an independently approved text source without opening its legacy intake status", () => {
    const f = fixture(); f.source.admin_review_status = "review_later";
    expect(isPublicChangeEvent(f)).toBe(false);
    f.publication.textFactReview = { id: "approved", reviewedAt: "2026-10-11T12:05:00Z", current: true, releaseRevision: "release",
      variationInventoryId: "approved-inventory", variationInventoryRevision: "inventory-revision" };
    f.publication.approvedTextSourceBindings = { [sourceId]: { url: source.url, shared_award_id: awardId } };
    expect(isPublicChangeEvent(f)).toBe(true);
    expect(f.source.admin_review_status).toBe("review_later");
    f.publication.allowedSourceIdSet.clear(); expect(isPublicChangeEvent(f)).toBe(false);
  });

  it("accepts newly reviewed text without promoting missing legacy metadata to fact authority", () => {
    const f = fixture(), unreviewed = { ...f.source, page_metadata: null, page_metadata_generated_at: null, page_metadata_model: null };
    expect(isPublicAwardSource(unreviewed)).toBe(false);
    expect(isUsableAwardFactSource(unreviewed)).toBe(false);
    expect(isPublicChangeEvent({ ...f, source: unreviewed })).toBe(true);
  });

  it("preserves explicit event suppression for otherwise accepted text proof", () => {
    const f = fixture();
    expect(isPublicChangeEvent({ ...f, event: { ...f.event, suppressed_at: "2026-10-11T12:06:00.000Z" } })).toBe(false);
  });

  it.each([
    ["source owner", f => { f.source.shared_award_id = "another-award"; }],
    ["source identity", f => { f.source.id = "another-source"; }],
    ["closed source", f => { f.source.admin_review_status = "closed"; }],
    ["unapproved source", f => { f.publication.allowedSourceIdSet.clear(); }],
    ["inactive award", f => { f.award.status = "inactive"; }],
    ["unverified publication", f => { f.publication.effectivelyVerified = false; }],
    ["identity exclusion", f => { f.publication.sourceIdentityRules = [{ title_pattern: "Application deadline", url_pattern: null }] as Stage1PublicationEntry["sourceIdentityRules"]; }],
  ] as [string, (f: ReturnType<typeof fixture>) => void][])("preserves the %s gate for text events", (_, mutate) => {
    const f = fixture(); mutate(f);
    expect(isPublicChangeEvent(f)).toBe(false);
  });

  it.each([
    "https://example.edu/login/",
    "https://example.edu/news/award-announcement/",
    "https://example.edu/wp-content/uploads/2026/10/casino.html",
    "https://example.edu/award/%E0%A4%A",
    "https://example.edu/award/%zz",
  ])("rejects an excluded URL even with valid text proof: %s", url => {
    const f = fixture(url);
    expect(hasPublishableProgramTextEvidence(f.event, f.evidence)).toBe(true);
    expect(isPublicChangeEvent(f)).toBe(false);
  });

  it("preserves title-only spam-upload rejection without relying on old AI metadata readiness", () => {
    const f = fixture("https://example.edu/wp-content/uploads/2026/10/application.html");
    f.source.title = "Casino application";
    expect(hasPublishableProgramTextEvidence(f.event, f.evidence)).toBe(true);
    expect(isPublicChangeEvent(f)).toBe(false);
  });

  it("checks the actual captured destination as well as the approved requested URL", () => {
    const f = fixture();
    for (const ref of [f.evidence.previous_capture, f.evidence.current_capture]) record(ref).final_url = "https://example.edu/login/";
    expect(hasPublishableProgramTextEvidence(f.event, f.evidence)).toBe(true);
    expect(isPublicChangeEvent(f)).toBe(false);
  });

  it.each(["http://localhost/award", "https://10.0.0.1/award", "https://example.internal/award", "https://[fc00::1]/award", "https://169.254.169.254/award"])("rejects a private text reference URL: %s", url => {
    const f = fixture(); f.event.source_url = url; f.source.url = url;
    for (const ref of [f.evidence.previous_capture, f.evidence.current_capture]) {
      record(record(ref).source).url = url; record(ref).final_url = url;
    }
    expect(hasPublishableProgramTextEvidence(f.event, f.evidence)).toBe(true);
    expect(isPublicChangeEvent(f)).toBe(false);
  });

  it.each([
    ["wrong event", f => { f.evidence.change_event_id = "another-event"; }],
    ["wrong candidate", f => { f.evidence.visual_review_candidate_id = "40000000-0000-0000-0000-000000000002"; }],
    ["wrong award", f => { f.evidence.shared_award_id = "other-award"; }],
    ["wrong source", f => { f.evidence.shared_award_source_id = "other-source"; }],
    ["wrong signature", f => { f.evidence.candidate_signature = "unchecked"; }],
    ["unverified", f => { f.evidence.verified_at = null; }],
    ["backfilled status", f => { f.evidence.backfilled_at = "2026-10-11T12:05:00.000Z"; }],
    ["fallback status", f => { f.evidence.evidence_status = "full_screenshot_fallback"; }],
    ["legacy schema", f => { f.evidence.evidence_schema_version = "visual-event-evidence-v2"; }],
    ["wrong epoch", f => { record(f.evidence.localization).epoch = "missing"; }],
    ["wrong comparison", f => { record(f.evidence.localization).comparison_id = "missing"; }],
    ["unexpected visual property", f => { record(f.evidence.localization).crop = {}; }],
    ["summary mismatch", f => { f.event.summary = "A different unsupported explanation."; }],
    ["quoted text changed", f => { f.event.change_details.program_changes[0].current_quote.text = "A different deadline."; }],
    ["quote source offset changed", f => { f.event.change_details.program_changes[0].current_quote.start_utf16++; }],
    ["unknown program field", f => { f.event.change_details.program_changes[0].field = "recipient_profiles"; }],
  ] as [string, (f: ReturnType<typeof fixture>) => void][]) ("rejects %s", (_, mutate) => {
    const f = fixture(); mutate(f);
    expect(hasPublishableEventEvidence(f.event, f.evidence)).toBe(false);
    expect(isPublicChangeEvent(f)).toBe(false);
  });

  it.each([
    ["requested URL", ref => { record(ref.source).url = "https://example.edu/sibling"; }],
    ["source owner", ref => { record(ref.source).shared_award_id = "70000000-0000-0000-0000-000000000001"; }],
    ["text content hash", ref => { record(ref.artifacts).text = { ...record(record(ref.artifacts).text), sha256: "c".repeat(64) }; }],
    ["unversioned key", ref => { record(record(ref.artifacts).text).object_key = "program-text/current.txt"; }],
    ["screenshot slot", ref => { record(ref.artifacts).screenshot = {}; }],
    ["incomplete extraction", ref => { ref.completeness = { status: "incomplete", reasons: ["ocr_uncertain"] }; }],
    ["noncanonical time", ref => { ref.captured_at = "October 11, 2026"; }],
    ["missing raw original", ref => { delete record(ref.artifacts).raw; }],
  ] as [string, (ref: Record<string, Json>) => void][]) ("rejects reference %s", (_, mutate) => {
    const f = fixture(); mutate(record(f.evidence.current_capture)); expect(hasPublishableEventEvidence(f.event, f.evidence)).toBe(false);
  });

  it("does not allow new-style details through the old full-image fallback", () => {
    const f = fixture(); f.evidence.evidence_status = "full_screenshot_fallback"; f.evidence.evidence_schema_version = "visual-event-evidence-v1";
    const old = { full: { object_key: "visual-snapshots/published/one/full.png", sha256: "d".repeat(64) },
      metadata: { object_key: "visual-snapshots/published/one/meta.json", sha256: "e".repeat(64) }, captured_at: "2026-10-11T12:00:00.000Z" };
    f.evidence.previous_capture = old; f.evidence.current_capture = old;
    expect(hasPublishableEventEvidence(f.event, f.evidence)).toBe(false);
  });

  it("survives JSONB key reordering but requires the exact ordered program-change list", () => {
    const f = fixture();
    const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reverse((value as Record<string, unknown>)[key])])) : value;
    f.evidence.localization = json(reverse(f.evidence.localization));
    f.evidence.current_capture = json(reverse(f.evidence.current_capture));
    expect(hasPublishableEventEvidence(f.event, f.evidence)).toBe(true);
    record(f.evidence.localization).program_changes = [];
    expect(hasPublishableEventEvidence(f.event, f.evidence)).toBe(false);
  });

  it.each(["2026-10-11T12:05:00+00:00", "2026-10-11T12:05:00.123456+00:00", "2026-10-11T12:05:00.123456Z"])("accepts a real UTC database timestamp %s", verifiedAt => {
    const f = fixture(); f.evidence.verified_at = verifiedAt;
    expect(hasPublishableEventEvidence(f.event, f.evidence)).toBe(true);
  });

  it.each(["2026-10-11T12:05:00+01:00", "2026-02-31T12:05:00+00:00", "2026-10-10T12:05:00+00:00", "2999-10-11T12:05:00+00:00"])("rejects invalid, non-UTC, premature or future verification time %s", verifiedAt => {
    const f = fixture(); f.evidence.verified_at = verifiedAt;
    expect(hasPublishableEventEvidence(f.event, f.evidence)).toBe(false);
  });

  it("requires the comparison seal and candidate signature to be the same identity", () => {
    const f = fixture(); record(f.evidence.localization).comparison_id = "b".repeat(64);
    expect(hasPublishableEventEvidence(f.event, f.evidence)).toBe(false);
  });

  it("checks UTF-16 quotations against supporting blocks and rejects duplicate block identities", () => {
    const f = fixture(), proof = record(f.evidence.localization), supporting = record(proof.supporting_blocks);
    const blocks = supporting.current as Json[];
    record(blocks[0]).text = `🎓 ${record(blocks[0]).text}`;
    record(blocks[0]).end_utf16 = Number(record(blocks[0]).end_utf16) + 3;
    expect(hasPublishableEventEvidence(f.event, f.evidence)).toBe(false);
    const other = fixture(), support = record(record(other.evidence.localization).supporting_blocks);
    (support.current as Json[]).push((support.current as Json[])[0]);
    expect(hasPublishableEventEvidence(other.event, other.evidence)).toBe(false);
  });
});

describe("program update summary, labels, search and digest parity", () => {
  it("uses the concise accepted explanation verbatim even when it is short", () => {
    const { event } = fixture();
    expect(isUsefulChangeSummary("Unrelated legacy fallback", event.change_details)).toBe(true);
    expect(isMeaningfulChangeDetails(event.change_details)).toBe(true);
    expect(displayChangeSummary("Unrelated legacy fallback", event.source_url, event.change_details)).toBe("Deadline extended.");
    expect(changeDetailsToSummary(event.change_details, "Unrelated fallback")).toBe("Deadline extended.");
    expect(changeDetailsLabel(event.change_details)).toBe("Deadline");
    expect(changeSummaryPresentation(event.summary, event.source_url, event.source_title, event.change_details)).toMatchObject({
      label: "Deadline", title: "Deadline changed", text: "Deadline extended.", paragraphs: ["Deadline extended."], condensed: false,
    });
    expect(changeDetailsSearchText(event.change_details)).toContain("5 p.m. Central Time.");
  });

  it("never repairs invalid new details using a legacy summary or recovered quote", () => {
    const { event } = fixture(); event.change_details.program_changes = [];
    expect(isMeaningfulChangeDetails(event.change_details)).toBe(false);
    expect(isUsefulChangeSummary("The application deadline changed from October 1 to 15.", event.change_details)).toBe(false);
    expect(displayChangeSummary("An arbitrary recovered quotation", event.source_url, event.change_details)).toBe("");
  });

  it("keeps distinct changes with identical prose and dedupes an exact repeated change", () => {
    const { event } = fixture(), second = structuredClone(event);
    second.change_details.program_changes[0].current_quote.text = second.change_details.program_changes[0].current_quote.text.replace("15", "20");
    expect(dedupeChangeSummaries([event, second, structuredClone(event)])).toHaveLength(2);
  });

  it("uses the same concise explanation in public digest candidates", () => {
    const { event } = fixture();
    const digest = buildPublicDigestChanges([{ ...event, detected_at: "2026-10-11T12:05:00.000Z" }], new Map([[awardId, "Example Scholarship"]]));
    expect(digest).toHaveLength(1);
    expect(digest[0].summary).toBe(event.change_details.summary);
    expect(digest[0].summary).not.toContain("Current wording");
  });
});
