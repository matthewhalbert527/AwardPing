import type { EligiblePublicChangeEvent } from "@/lib/public-change-events";
import type { Stage1PublicationEntry } from "@/lib/stage1-publication";

// Public identities and accepted wording from the real approved KHS group.
// No review decision, source evidence, or model response is created by this fixture.
export const KHS_CANONICAL = "141944a8-fd04-4433-b0e4-8990fae56764";
export const KHS_ALIAS = "d395d355-1e27-4127-b24c-cfa486a32a37";
export const KHS_SOURCE = "d3b7b734-e218-4402-acfd-446967853cbe";
export const KHS_SOURCE_URL = "https://knight-hennessy.stanford.edu/admission/planning-apply/eligibility";
export const KHS_OLD_EVENT = "f1dfbdf0-e781-41e4-ad1c-0273faaa5c5b";
export const KHS_NEW_EVENT = "80c068e0-f019-43cf-a47d-7df10108cd57";
export function khsPublishedGroup() {
  return { group_id: "2bb7d921-1ea7-45fa-9e8a-9f8b867653ef", revision_id: "f86afd44-00fe-4e86-8edf-6e80ed3e2edb",
    content_hash: "146fcf82988879e889a58365d706cb0e206d4ae37d051434d7a347b74963e785", shared_award_id: KHS_ALIAS,
    event_ids: [KHS_OLD_EVENT, KHS_NEW_EVENT], created_at: "2026-10-31T20:07:03.329499-05:00",
    member_refs: [
      { id: "0889a817-f70d-418b-aa11-053e30e5624a", content_hash: "9e01fedb1ce6435b3a784e87d58deb188165a212c21d469bafa39ade1c7ee505" },
      { id: "42a9ec06-fea6-44f1-9126-71ec16b4c09b", content_hash: "a587b5245b6aa93c408edeb2380cabcbc8fd9e59975be34fe20f3dc682112b08" },
    ], event_refs: [
      { event_id: KHS_OLD_EVENT, review_id: "0889a817-f70d-418b-aa11-053e30e5624a", content_hash: "9e01fedb1ce6435b3a784e87d58deb188165a212c21d469bafa39ade1c7ee505" },
      { event_id: KHS_NEW_EVENT, review_id: "42a9ec06-fea6-44f1-9126-71ec16b4c09b", content_hash: "a587b5245b6aa93c408edeb2380cabcbc8fd9e59975be34fe20f3dc682112b08" },
    ] };
}
export function khsPublishedEvents(publication: Stage1PublicationEntry): EligiblePublicChangeEvent[] {
  const current = "Stanford is currently unable to file or process applications, accept application fees or tuition payments, or provide certain educational services to individuals who are currently located in Iran or are outside Iran but ordinarily live in Iran.";
  const previous = "We encourage citizens and residents of all countries to apply.";
  const records = [
    { id: KHS_NEW_EVENT, review: "42a9ec06-fea6-44f1-9126-71ec16b4c09b", detected_at: "2026-11-01T01:07:03.119976+00:00", field: "citizenship", operation: "remove",
      summary: "Removed statement encouraging citizens and residents of all countries to apply.", previous_quote: { block_id: "block-000023", start_utf16: 1613, end_utf16: 1613 + previous.length, text: previous }, current_quote: null },
    { id: KHS_OLD_EVENT, review: "0889a817-f70d-418b-aa11-053e30e5624a", detected_at: "2026-10-31T20:12:28.444072+00:00", field: "eligibility", operation: "add",
      summary: "Stanford cannot process applications from individuals currently located in Iran or living in Iran.", previous_quote: null, current_quote: { block_id: "block-000047", start_utf16: 4837, end_utf16: 4837 + current.length, text: current } },
  ];
  return records.map(record => ({ event: { id: record.id, shared_award_id: KHS_ALIAS, shared_award_source_id: KHS_SOURCE,
    source_title: "eligible to apply", source_url: KHS_SOURCE_URL, source_page_type: "eligibility", detected_at: record.detected_at,
    visual_review_candidate_id: record.review, summary: record.summary, change_details: { schema: "awardping.program-change.v1",
      event_kind: "program_details_changed", summary: record.summary, program_changes: [{ field: record.field, operation: record.operation,
        summary: record.summary, previous_quote: record.previous_quote, current_quote: record.current_quote }] },
    suppressed_at: null, suppression_reason: null, suppression_source: null }, publication,
    // The raw eligibility loader is the mock boundary in these projection
    // tests; its independent source/evidence predicates are tested separately.
    source: { id: KHS_SOURCE, shared_award_id: KHS_ALIAS, url: KHS_SOURCE_URL }, evidence: {} })) as unknown as EligiblePublicChangeEvent[];
}
