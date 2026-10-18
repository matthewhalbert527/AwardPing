import { createHash } from "node:crypto";
import { normalizeVisibleText } from "./capture-stability.mjs";
import { scraplingReviewText } from "./scrapling-worker.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const block = text => ({ kind: "p", text, heading_path: [], list_path: [], table_row: [] });
const source = { id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222",
  url: "https://example.org/synthetic-award", title: "Synthetic benchmark only", shared_awards: { name: "Fictional Test Award" } };

/** Fixtures are fabricated evidence contracts, never historical captures or award facts. */
export function accuracyReviewInput(before, after, {
  sourceIdentity = source, previousVisible = before.text, currentVisible = after.text,
  previousProfile = "scrapling-evidence-v1", currentProfile = "scrapling-evidence-v1",
  previousScreenshot = true, currentScreenshot = true,
  previousTitle = before.title, currentTitle = after.title,
  previousAt = "2026-10-15T12:00:00.000Z", currentAt = "2026-10-16T12:00:00.000Z",
} = {}) {
  const metadata = (doc, visible, title, profile, paired, capturedAt) => {
    const text = scraplingReviewText(doc);
    return { source: { id: sourceIdentity.id, shared_award_id: sourceIdentity.shared_award_id, url: sourceIdentity.url },
      capture_profile: profile, final_url: doc.source_url, captured_at: capturedAt, page_title: doc.title,
      text, text_hash: hash(normalizeVisibleText(text)),
      scrapling: { visible_text: visible, visible_text_sha256: hash(visible), visible_title: title,
        visible_text_scope: "whole-visible-main-document", screenshot: { semantics_bracketed: paired } } };
  };
  const baseline = metadata(before, previousVisible, previousTitle, previousProfile, previousScreenshot, previousAt);
  const capture = metadata(after, currentVisible, currentTitle, currentProfile, currentScreenshot, currentAt);
  return { source: sourceIdentity, baseline, previous: { text: baseline.text, meta: structuredClone(baseline) }, capture };
}

function document(text) {
  return { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document", source_url: source.url,
    title: "Fictional Test Award", text, blocks: [block(text)], links: [], base_hrefs: [], limitations: [],
    publishable: false, visibility_verified: false };
}

export const controlledCaseDefinitions = [
  ["deadline", "award_change", "Applicants must apply by October 31, 2027 at 5 p.m. Eastern Time.", "Applicants must apply by November 15, 2027 at 5 p.m. Eastern Time."],
  ["eligibility", "award_change", "Applicants must be college juniors.", "Applicants must be college seniors."],
  ["funding", "award_change", "The annual stipend is $25,000 for eligible students.", "The annual stipend is $30,000 for eligible students."],
  ["audience", "award_change", "U.S. citizens may apply; international applicants are not eligible.", "U.S. citizens and international applicants may apply."],
  ["cycle", "award_change", "This application is for the 2027 award cycle.", "This application is for the 2028 award cycle."],
  ["deadline-qualifiers", "award_change", "U.S. applicants must apply by October 31, 2027; international applicants must apply by September 1, 2027.", "U.S. applicants must apply by November 15, 2027; international applicants must apply by September 1, 2027."],
  ["casing", "award_change", "Applicants must submit Form A.", "Applicants must submit form A."],
  ["visible-countdown-noise", "non_award_noise", "Applications close in 20 days and 10 minutes.", "Applications close in 20 days and 9 minutes."],
  ["countdown-with-deadline", "award_change", "Applications close in 20 days and 10 minutes. Deadline: October 31, 2027.", "Applications close in 20 days and 9 minutes. Deadline: November 15, 2027."],
  ["countdown-with-funding", "award_change", "Applications close in 20 days and 10 minutes. The stipend is $25,000.", "Applications close in 20 days and 9 minutes. The stipend is $30,000."],
  ["countdown-with-audience", "award_change", "Applications close in 20 days and 10 minutes. U.S. citizens may apply.", "Applications close in 20 days and 9 minutes. International applicants may apply."],
  ["countdown-with-cycle", "award_change", "Applications close in 20 days and 10 minutes. For the 2027 cycle.", "Applications close in 20 days and 9 minutes. For the 2028 cycle."],
  ["hidden-deadline", "award_change_hidden", "Applications close on October 31, 2027.", "Applications close on November 15, 2027."],
  ["hidden-duplicate", "ambiguous_evidence", "Applications close on October 31, 2027.", "Applications close on November 15, 2027."],
  ["old-and-new-already-visible", "ambiguous_evidence", "Applications close on October 31, 2027.", "Applications close on November 15, 2027."],
  ["audience-context", "award_change", "Applicants must apply by October 31, 2027.", "Applicants must apply by November 15, 2027."],
  ["missing-context", "ambiguous_evidence", "Applicants must apply by October 31, 2027.", "Applicants must apply by November 15, 2027."],
  ["link-only", "award_change", "Read the application instructions.", "Read the application instructions."],
  ["table-attribute", "award_change", "Students receive $25,000 annually.", "Students receive $25,000 annually."],
  ["block-order", "award_change", "U.S. applicants may apply.", "U.S. applicants may apply."],
  ["block-duplicate", "award_change", "U.S. applicants may apply.", "U.S. applicants may apply."],
  ["metadata-noise", "non_award_noise", "Applicants must be enrolled full time.", "Applicants must be enrolled full time."],
  ["whitespace-noise", "non_award_noise", "Applicants must be enrolled full time.", "Applicants  must be enrolled full time."],
  ["oversized-prose", "award_change", "Applications close on October 31, 2027.", "Applications close on November 15, 2027."],
  ["screenshot-mismatch", "award_change", "Applications close on October 31, 2027.", "Applications close on November 15, 2027."],
  ["screenshot-absent", "award_change", "Applications close on October 31, 2027.", "Applications close on November 15, 2027."],
  ["broken-text-hash", "invalid_evidence", "Applications close on October 31, 2027.", "Applications close on November 15, 2027."],
  ["malformed-document", "invalid_evidence", "Applications close on October 31, 2027.", "Applications close on November 15, 2027."],
  ["profile-transition", "invalid_evidence", "Applications close on October 31, 2027.", "Applications close on November 15, 2027."],
];

/** Explicit transformations; no synthetic capture is assigned an official URL. */
export function buildControlledAccuracyCases() {
  return controlledCaseDefinitions.map(([id, label, oldText, newText]) => {
    const before = document(oldText), after = document(newText), options = {};
    let expectedComparison = oldText === newText ? "unchanged" : "changed_needs_review";
    let expectedReview = "changed_needs_review", expectedReason = "complete_bounded_prose_change";
    const hold = reason => { expectedReview = "manual_review_required"; expectedReason = reason; };
    if (id === "visible-countdown-noise") {
      hold("countdown_only_change_requires_manual_review");
    } else if (id === "hidden-deadline") {
      options.previousVisible = options.currentVisible = "Applications are welcome. Read the official application instructions.";
      hold("changed_block_not_uniquely_visible");
    } else if (id === "hidden-duplicate") {
      before.text += ` ${oldText}`; after.text += ` ${oldText}`;
      before.blocks.push(block(oldText)); after.blocks.push(block(oldText));
      options.previousVisible = oldText; options.currentVisible = oldText;
      hold("block_order_or_multiplicity_changed");
    } else if (id === "old-and-new-already-visible") {
      options.previousVisible = options.currentVisible = `${oldText} ${newText}`;
      hold("changed_block_already_present_on_opposite_side");
    } else if (["audience-context", "missing-context"].includes(id)) {
      for (const doc of [before, after]) {
        doc.blocks[0].heading_path = [{ level: 2, text: "U.S. applicants" }];
        doc.text = `U.S. applicants ${doc.text}`;
      }
      if (id === "missing-context") {
        options.previousVisible = `International applicants ${oldText}`;
        options.currentVisible = `International applicants ${newText}`;
        hold("changed_block_context_not_uniquely_visible");
      }
    } else if (id === "link-only") {
      before.links = [{ text: oldText, raw_href: "/apply-2027.pdf", source_url: source.url, base_hrefs: [], heading_path: [], list_path: [] }];
      after.links = structuredClone(before.links); after.links[0].raw_href = "/apply-2028.pdf";
      expectedComparison = "changed_needs_review"; hold("structural_only_change");
    } else if (id === "table-attribute") {
      before.blocks[0].table_cell = { colspan: 1, rowspan: 1 }; after.blocks[0].table_cell = { colspan: 2, rowspan: 1 };
      expectedComparison = "changed_needs_review"; hold("structural_only_change");
    } else if (id === "block-order") {
      before.blocks.push(block("International applicants may not apply.")); after.blocks = [...before.blocks].reverse();
      before.text = before.blocks.map(b => b.text).join(" "); after.text = after.blocks.map(b => b.text).join(" ");
      expectedComparison = "changed_needs_review"; hold("block_order_or_multiplicity_changed");
    } else if (id === "block-duplicate") {
      after.blocks.push(block(newText)); after.text += ` ${newText}`;
      expectedComparison = "changed_needs_review"; hold("block_order_or_multiplicity_changed");
    } else if (id === "metadata-noise") {
      after.limitations = ["A diagnostic collection warning changed."]; after.counts = { irrelevant: 9 };
      expectedReview = "unchanged"; expectedReason = "complete_semantics_equal";
    } else if (id === "whitespace-noise") {
      // Prose normalizes, but complete block evidence preserves its whitespace.
      hold("structural_only_change");
    } else if (id === "oversized-prose") {
      const large = "Unchanged explanatory context. ".repeat(280);
      before.text += ` ${large}`; after.text += ` ${large}`;
      // Lossless shared context fits the unchanged byte cap; this is not excerpting.
    } else if (id === "screenshot-mismatch") {
      options.currentScreenshot = false; hold("supplementary_screenshot_semantics_changed");
    } else if (id === "screenshot-absent") {
      options.currentScreenshot = null; hold("supplementary_screenshot_pairing_unverified");
    } else if (id === "profile-transition") {
      options.previousProfile = "stable-daily"; expectedReview = "unavailable"; expectedReason = "capture_profile_mismatch";
    }
    const input = accuracyReviewInput(before, after, options);
    if (id === "broken-text-hash") {
      input.capture.text_hash = "0".repeat(64); expectedReview = "unavailable"; expectedReason = "text_integrity_mismatch";
    } else if (id === "malformed-document") {
      after.blocks = null; input.capture.text = "Malformed retained text without a context marker";
      expectedComparison = "unavailable"; expectedReview = "unavailable"; expectedReason = "missing_context_marker";
    }
    return { id, label, provenance: "controlled_synthetic", observed_change: false, before, after, input,
      expected: { comparison: expectedComparison, review: expectedReview, reason: expectedReason } };
  });
}
