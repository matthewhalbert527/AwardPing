import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildScraplingReviewDiff, parseScraplingReviewText } from "./scrapling-review-diff.mjs";
import { scraplingReviewText } from "./scrapling-worker.mjs";
import { normalizeVisibleText } from "./capture-stability.mjs";
import { buildVisualReviewPromptPayload, buildVisualReviewPromptText } from "./visual-review-queue.mjs";

const source = { id: "10000000-0000-0000-0000-000000000001", shared_award_id: "20000000-0000-0000-0000-000000000001",
  url: "https://example.edu/award", title: "Scholarship eligibility", page_type: "eligibility", shared_awards: { name: "Example Scholarship" } };
const hash = value => createHash("sha256").update(normalizeVisibleText(value)).digest("hex");
const rawHash = value => createHash("sha256").update(value).digest("hex");
const block = value => ({ kind: "p", text: value, heading_path: [], list_path: [], table_row: [] });
const sentence = "U.S. applicants must submit the application before October 31, 2026. International applicants have a different deadline.";
function document() {
  return { schema: "awardping.scrapling-html-document.v1", title: "Example Scholarship", text: sentence,
    blocks: [block(sentence)], links: [{ text: "Application form", raw_href: "/apply.pdf?track=alpha",
      source_url: source.url, base_hrefs: [], heading_path: [], list_path: [] }], base_hrefs: [] };
}
function metadata(text, capturedAt) {
  return { source: { id: source.id, shared_award_id: source.shared_award_id, url: source.url },
    capture_profile: "scrapling-evidence-v1", final_url: source.url, captured_at: capturedAt,
    text_hash: hash(text), text };
}
function inputs(a = document(), b = structuredClone(a)) {
  const oldText = scraplingReviewText(a), newText = scraplingReviewText(b);
  const baseline = { ...metadata(oldText, "2026-10-15T12:00:00.000Z"), page_title: a.title,
    scrapling: { visible_title: a.title, visible_text: a.text, visible_text_sha256: rawHash(a.text), visible_text_scope: "whole-visible-main-document",
      screenshot: { semantics_bracketed: true } } };
  const capture = { ...metadata(newText, "2026-10-16T12:00:00.000Z"), page_title: b.title,
    scrapling: { visible_title: b.title, visible_text: b.text, visible_text_sha256: rawHash(b.text), visible_text_scope: "whole-visible-main-document",
      screenshot: { semantics_bracketed: true } } };
  return { source, baseline, previous: { text: `${oldText}\n`, meta: structuredClone(baseline) }, capture };
}
function proseChange(a = document()) {
  const b = structuredClone(a);
  b.text = b.text.replace("October 31", "November 15");
  b.blocks[0].text = b.blocks[0].text.replace("October 31", "November 15");
  return b;
}
function reseal(input, side) {
  if (side === "before") input.baseline.text_hash = hash(input.previous.text);
  else input.capture.text_hash = hash(input.capture.text);
}
function setVisible(input, previous, current) {
  for (const [meta, value] of [[input.previous.meta, previous], [input.capture, current]]) {
    meta.scrapling.visible_text = value;
    meta.scrapling.visible_text_sha256 = rawHash(value);
  }
  return input;
}
function contextualPair() {
  const a = document();
  a.text = `Hidden menu and unused submenu. Eligibility ${sentence}`;
  a.blocks = [block("Hidden menu and unused submenu."),
    { ...block("Eligibility"), kind: "heading", heading_path: [{ level: 2, text: "Eligibility" }] },
    { ...block(sentence), heading_path: [{ level: 2, text: "Eligibility" }] }];
  const b = structuredClone(a); b.text = b.text.replace("October 31", "November 15");
  b.blocks[2].text = b.blocks[2].text.replace("October 31", "November 15");
  return { a, b, input: setVisible(inputs(a, b), `Eligibility ${a.blocks[2].text}`, `Eligibility ${b.blocks[2].text}`) };
}

describe("complete retained Scrapling evidence", () => {
  it.each([null, "Question", [], [null], [4], Array(101).fill("Question")])("rejects malformed FAQ review context %j", path => {
    for (const field of ["blocks", "links"]) {
      const doc = document();
      doc[field][0].details_path = path;
      expect(buildScraplingReviewDiff(inputs(doc))).toMatchObject({ status: "unavailable", publishable: false,
        baseline_advance_allowed: false, reason: field === "blocks" ? "invalid_block" : "invalid_link_context" });
    }
  });

  it("retains FAQ context through review serialization and holds a legacy-to-enriched context transition", () => {
    const before = document(), after = structuredClone(before);
    after.blocks[0].details_path = ["U.S. applicants"];
    after.links[0].details_path = ["U.S. applicants"];
    expect(parseScraplingReviewText(scraplingReviewText(after), { finalUrl: source.url }).context.blocks[0].details_path)
      .toEqual(["U.S. applicants"]);
    expect(buildScraplingReviewDiff(inputs(before, after))).toMatchObject({ status: "manual_review_required",
      reason: "structural_only_change", publishable: false, baseline_advance_allowed: false });
  });

  it("accepts same semantics with the retained trailing newline and never authorizes publication", () => {
    const result = buildScraplingReviewDiff(inputs());
    expect(result).toMatchObject({ status: "unchanged", reason: "complete_semantics_equal", publishable: false,
      baseline_advance_allowed: false, visibility_verified: false, screenshot_alignment: "not_verified" });
  });
  it("does not require the previous evidence object itself to repeat baseline profile metadata", () => {
    const input = inputs(); delete input.previous.meta;
    expect(buildScraplingReviewDiff(input).status).toBe("unchanged");
  });
  it("parses full unescaped context without normalizing raw URL whitespace", () => {
    const a = document(); a.links[0].raw_href = "/apply?track=arts  science";
    const parsed = parseScraplingReviewText(scraplingReviewText(a), { finalUrl: source.url });
    expect(parsed.context.links[0].raw_href).toBe("/apply?track=arts  science");
  });
  it("queues complete bounded prose with both audience qualifiers and all contexts", () => {
    const a = document(), b = proseChange(a), result = buildScraplingReviewDiff(inputs(a, b));
    expect(result).toMatchObject({ status: "changed_needs_review", publishable: false, baseline_advance_allowed: false });
    expect(result.diff.added_text).toEqual([b.text]);
    expect(result.diff.removed_text).toEqual([a.text]);
    expect(result.diff.scrapling_semantics.previous_source_prose).toBe(`${a.title}\n\n${a.text}`);
    expect(result.diff.added_text[0]).toContain("International applicants have a different deadline.");
    expect(result.diff.scrapling_semantics.previous_context.blocks).toEqual(a.blocks);
    expect(result.diff.scrapling_semantics.current_context.blocks).toEqual(b.blocks);
  });
  it("passes complete exact evidence to the existing queue without depending on clipped page excerpts", () => {
    const input = inputs(document(), proseChange()), result = buildScraplingReviewDiff(input);
    const payload = buildVisualReviewPromptPayload({ ...input, diff: result.diff, deterministic: result.deterministic, promptChars: 5 });
    // The existing queue flattens whitespace in its convenience text_evidence,
    // while the authoritative deterministic_diff remains complete and exact.
    expect(payload.text_evidence.added_text).toEqual(result.diff.added_text.map(value => value.replace(/\s+/g, " ")));
    expect(payload.deterministic_diff.added_text).toEqual(result.diff.added_text);
    expect(payload.deterministic_diff.scrapling_semantics.complete).toBe(true);
    expect(buildVisualReviewPromptText(payload)).toContain("International applicants have a different deadline.");
    expect(result.diff.added_text[0]).not.toContain("raw_href");
  });
  it("handles an empty title without guessing title/body boundaries", () => {
    const a = document(); a.title = "";
    const result = buildScraplingReviewDiff(inputs(a, proseChange(a)));
    expect(result.status).toBe("changed_needs_review");
    expect(result.diff.removed_text).toEqual([a.text]);
  });
  it("does not discard prose beyond the legacy 620-character sentence limit", () => {
    const a = document(); a.text = `Applicants must satisfy all of the following conditions ${"Additional application instructions. ".repeat(22)}Citizenship is optional.`;
    a.blocks = [block(a.text)]; const b = structuredClone(a); b.text = b.text.replace("Citizenship is optional.", "Citizenship is required."); b.blocks[0].text = b.text;
    const result = buildScraplingReviewDiff(inputs(a, b));
    expect(result.status).toBe("changed_needs_review");
    expect(result.diff.added_text[0]).toContain("Citizenship is required.");
  });
});

describe("complete countdown-only changes are retained on manual hold", () => {
  function pair(oldText, newText) {
    const a = document(); a.text = oldText; a.blocks = [block(oldText)];
    const b = structuredClone(a); b.text = newText; b.blocks[0].text = newText;
    return inputs(a, b);
  }
  it.each([
    ["Applications close in 20 days and 10 minutes.", "Applications close in 20 days and 9 minutes."],
    ["Application closes in 1 day, 0 hours, 0 minutes and 01 seconds.", "Application closes in 1 day, 0 hours, 0 minutes and 00 seconds."],
    ["Applications close in 1 day, 0 hours, 0 minutes and 00 seconds.", "Applications close in 0 day, 23 hours, 59 minutes and 59 seconds."],
    ["Application Closes in: Days 50 Hours 01 Minutes 09 Seconds 54", "Application Closes in: Days 50 Hours 01 Minutes 04 Seconds 07"],
    ["Applications close in 120 minutes.", "Applications close in 119 minutes."],
  ])("holds only the complete unchanged countdown wording: %s", (before, after) => {
    const result = buildScraplingReviewDiff(pair(before, after));
    expect(result).toMatchObject({ status: "manual_review_required",
      reason: "countdown_only_change_requires_manual_review",
      publishable: false, baseline_advance_allowed: false, retain_both_captures: true });
    expect(result.diff).toBeNull();
    expect(result.evidence.previous_visible_text_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.evidence.current_visible_text_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    ["Applications close in 20 days and 9 minutes.", "Applications close in 20 days and 10 minutes."],
    ["Application closes in 1 minute and 1 second.", "Application closes in 1 minute and 0 seconds."],
    ["Applications close in 20 days and 10 minutes.", "Applications close in 20 days and 10 seconds."],
    ["Applications close in 20 days and 10 minutes.", "APPLICATIONS CLOSE IN 20 DAYS AND 9 MINUTES."],
    ["Applications close in 20 days.", "Applications close in 19 days."],
    ["Applications close in 2027.", "Applications close in 2026."],
    ["Applications close on October 31, 2027.", "Applications close on October 30, 2027."],
    ["Applicants receive $20,000 for 10 months.", "Applicants receive $19,000 for 9 months."],
    ["Applicants must enroll within 20 days and 10 minutes.", "Applicants must enroll within 20 days and 9 minutes."],
    ["Applications close in 20 days and 70 minutes.", "Applications close in 20 days and 69 minutes."],
    ["Applications close in 20 minutes and 10 days.", "Applications close in 20 minutes and 9 days."],
    ["Applications close in 20 minutes and 10 minutes.", "Applications close in 20 minutes and 9 minutes."],
    ["Applications close in 20 days and 10 minutes. Deadline: October 31, 2027.", "Applications close in 20 days and 9 minutes. Deadline: October 30, 2027."],
    ["Applications close in 20 days and 10 minutes. Funding: $25,000.", "Applications close in 20 days and 9 minutes. Funding: $20,000."],
    ["Applications close in 20 days and 10 minutes. For U.S. applicants.", "Applications close in 20 days and 9 minutes. For international applicants."],
    ["Applications close in 20 days and 10 minutes. Cycle: 2027.", "Applications close in 20 days and 9 minutes. Cycle: 2028."],
  ])("does not call another numeric or wording change a timer tick: %s", (before, after) => {
    const result = buildScraplingReviewDiff(pair(before, after));
    expect(result).toMatchObject({ status: "changed_needs_review", reason: "complete_bounded_prose_change" });
    expect(result.diff.removed_text).toEqual([before]);
    expect(result.diff.added_text).toEqual([after]);
  });
  it("keeps a separate deadline change and timer together in the complete review evidence", () => {
    const a = document(); a.blocks.push(block("Applications close in 20 days and 10 minutes."));
    a.text = a.blocks.map(b => b.text).join(" ");
    const b = proseChange(a); b.blocks[1].text = "Applications close in 20 days and 9 minutes.";
    b.text = b.blocks.map(b => b.text).join(" ");
    const result = buildScraplingReviewDiff(inputs(a, b));
    expect(result.status).toBe("changed_needs_review");
    expect(result.diff.added_text).toEqual(b.blocks.map(b => b.text));
    expect(result.diff.removed_text).toEqual(a.blocks.map(b => b.text));
  });
  it("does not bypass source, visibility or screenshot safeguards for a timer", () => {
    const input = pair("Applications close in 20 days and 10 minutes.", "Applications close in 20 days and 9 minutes.");
    setVisible(input, "Read the official instructions.", "Read the official instructions.");
    expect(buildScraplingReviewDiff(input).reason).toBe("changed_block_not_uniquely_visible");
    input.capture.scrapling.screenshot.semantics_bracketed = false;
    expect(buildScraplingReviewDiff(input).reason).toBe("supplementary_screenshot_semantics_changed");
    input.capture.text_hash = "0".repeat(64);
    expect(buildScraplingReviewDiff(input).reason).toBe("text_integrity_mismatch");
  });
});

describe("same-capture visible prose is required before automatic review", () => {
  it.each(["previous", "current", "both"])("holds a disclosed %s supplementary screenshot mismatch", side => {
    const input = inputs(document(), proseChange());
    if (side !== "current") input.previous.meta.scrapling.screenshot.semantics_bracketed = false;
    if (side !== "previous") input.capture.scrapling.screenshot.semantics_bracketed = false;
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required",
      reason: "supplementary_screenshot_semantics_changed", diff: null, publishable: false,
      baseline_advance_allowed: false, retain_both_captures: true });
  });
  it.each(["previous", "current"])("requires affirmative %s screenshot pairing without borrowing the other side", side => {
    const input = inputs(document(), proseChange());
    const meta = side === "previous" ? input.previous.meta : input.capture;
    delete meta.scrapling.screenshot;
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required",
      reason: "supplementary_screenshot_pairing_unverified", diff: null });
  });
  it.each([undefined, null, "true", 1, {}])("rejects non-boolean affirmative pairing %s", value => {
    const input = inputs(document(), proseChange());
    input.capture.scrapling.screenshot.semantics_bracketed = value;
    expect(buildScraplingReviewDiff(input).reason).toBe("supplementary_screenshot_pairing_unverified");
  });
  it("accepts the earlier true-pairing shape without inventing later mismatch details or geometry", () => {
    const input = inputs(document(), proseChange());
    expect(input.previous.meta.scrapling.screenshot).toEqual({ semantics_bracketed: true });
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "changed_needs_review",
      screenshot_alignment: "not_verified", publishable: false, baseline_advance_allowed: false });
  });
  it("keeps semantically unchanged HTML unchanged even when a supplementary screenshot moved", () => {
    const input = inputs(); input.capture.scrapling.screenshot.semantics_bracketed = false;
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "unchanged",
      publishable: false, baseline_advance_allowed: false });
  });
  it("holds a hidden-only deadline substitution despite complete exact HTML evidence", () => {
    const input = inputs(document(), proseChange());
    const visible = "The award application opens annually. See the official application portal.";
    for (const meta of [input.previous.meta, input.capture]) {
      meta.scrapling = { ...meta.scrapling, visible_text: visible, visible_text_sha256: rawHash(visible) };
    }
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required",
      reason: "changed_block_not_uniquely_visible", diff: null, publishable: false,
      baseline_advance_allowed: false, retain_both_captures: true });
  });
  it.each(["previous", "current"])("requires %s same-capture metadata and raw visible text integrity", side => {
    const input = inputs(document(), proseChange());
    const meta = side === "previous" ? input.previous.meta : input.capture;
    meta.scrapling.visible_text_sha256 = "f".repeat(64);
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required",
      reason: `${side}_visible_text_integrity_unverified`, diff: null });
  });
  it.each(["previous", "current"])("holds %s missing visibility evidence, without borrowing another capture", side => {
    const input = inputs(document(), proseChange());
    if (side === "previous") delete input.previous.meta;
    else delete input.capture.scrapling;
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required",
      reason: `${side}_visible_prose_evidence_unavailable`, diff: null });
  });
  it.each([
    ["missing title", meta => { delete meta.visible_title; }],
    ["partial scope", meta => { meta.visible_text_scope = "selected-fragment"; }],
    ["empty visible text", meta => { meta.visible_text = ""; meta.visible_text_sha256 = rawHash(""); }],
    ["non-string visible text", meta => { meta.visible_text = ["Deadline"]; }],
  ])("holds %s instead of substituting full-HTML metadata", (_, mutate) => {
    const input = inputs(document(), proseChange()); mutate(input.capture.scrapling);
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required",
      reason: "current_visible_prose_evidence_unavailable", diff: null });
  });
  it("holds an HTML/native title mismatch", () => {
    const input = inputs(document(), proseChange()); input.capture.scrapling.visible_title = "Other award";
    expect(buildScraplingReviewDiff(input).reason).toBe("title_change_requires_manual_review");
  });
  it("does not normalize whitespace before verifying the visible-text raw hash", () => {
    const input = inputs(document(), proseChange()); input.capture.scrapling.visible_text += " ";
    expect(buildScraplingReviewDiff(input).reason).toBe("current_visible_text_integrity_unverified");
  });
  it.each([
    ["CSS capitalization", value => value.toUpperCase()],
    ["duplicate text", value => `${value}\n${value}`],
    ["missing audience qualifier", value => value.replace("International applicants have a different deadline.", "")],
    ["extra hidden text", value => `${value}\nThis section is not currently rendered.`],
  ])("does not use lossy matching for %s", (_, change) => {
    const input = inputs(document(), proseChange());
    const visible = change(input.capture.scrapling.visible_text);
    input.capture.scrapling = { ...input.capture.scrapling, visible_text: visible, visible_text_sha256: rawHash(visible) };
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required", diff: null });
  });
  it("normalizes only the existing whitespace rules after checking exact retained bytes", () => {
    const input = inputs(document(), proseChange());
    const visible = input.capture.scrapling.visible_text.replaceAll(" ", "  ");
    input.capture.scrapling = { ...input.capture.scrapling, visible_text: visible, visible_text_sha256: rawHash(visible) };
    const result = buildScraplingReviewDiff(input);
    expect(result).toMatchObject({ status: "changed_needs_review", visible_prose_corroborated: true,
      visibility_verified: false, screenshot_alignment: "not_verified", publishable: false });
    expect(result.diff.scrapling_semantics.visible_prose_rule).toBe("unique_complete_changed_blocks_with_ordered_visible_context");
    expect(result.evidence.current_visible_text_sha256).toBe(rawHash(visible));
  });
});

describe("structural changes never become sentence-noise or invented source quotations", () => {
  it("holds a link-only change inside a context longer than 620 characters", () => {
    const a = document(); a.blocks = Array.from({ length: 8 }, () => block(sentence));
    const b = structuredClone(a); b.links[0].raw_href = "/apply.pdf?track=beta";
    expect(JSON.stringify(a.blocks).length).toBeGreaterThan(620);
    expect(buildScraplingReviewDiff(inputs(a, b))).toMatchObject({ status: "manual_review_required",
      reason: "structural_only_change", fields: ["links"], diff: null, retain_both_captures: true });
  });
  it.each([
    ["raw URL spaces", a => { a.links[0].raw_href = "/apply.pdf?track=arts  science"; }],
    ["raw URL case", a => { a.links[0].raw_href = "/apply.pdf?track=ALPHA"; }],
    ["query punctuation", a => { a.links[0].raw_href = "/apply.pdf?track=alpha&x=1"; }],
    ["base URL", a => { a.base_hrefs = ["https://example.edu/forms/"]; a.links[0].base_hrefs = [...a.base_hrefs]; }],
    ["duplicate link", a => { a.links.push(structuredClone(a.links[0])); }],
    ["duplicate block", a => { a.blocks.push(structuredClone(a.blocks[0])); }],
    ["heading qualifier", a => { a.blocks[0].heading_path = [{ level: 2, text: "International applicants" }]; }],
    ["list ancestry", a => { a.blocks[0].list_path = ["U.S. citizens only"]; }],
    ["table row", a => { a.blocks[0].table_row = ["U.S.", "October 31"]; }],
    ["table span", a => { a.blocks[0].table_cell = { colspan: 2, rowspan: 1, scope: "col" }; }],
  ])("preserves %s changes for manual review", (_, mutate) => {
    const a = document(), b = structuredClone(a); mutate(b);
    expect(buildScraplingReviewDiff(inputs(a, b))).toMatchObject({ status: "manual_review_required", publishable: false,
      baseline_advance_allowed: false, diff: null });
  });
  it("preserves link ordering", () => {
    const a = document(); a.links.push({ ...a.links[0], text: "Instructions", raw_href: "/instructions.pdf" });
    const b = structuredClone(a); b.links.reverse();
    expect(buildScraplingReviewDiff(inputs(a, b)).status).toBe("manual_review_required");
  });
  it("holds block reordering even if it also changes the visible prose sequence", () => {
    const a = document(); a.blocks = [block("U.S. applicants have an early deadline."), block("Other applicants have a later deadline.")];
    a.text = a.blocks.map(b => b.text).join(" "); const b = structuredClone(a); b.blocks.reverse(); b.text = b.blocks.map(x => x.text).join(" ");
    expect(buildScraplingReviewDiff(inputs(a, b))).toMatchObject({ status: "manual_review_required", reason: "block_order_or_multiplicity_changed" });
  });
  it("holds duplicates in prose and blocks without set-deduplicating", () => {
    const a = document(), b = proseChange(a); b.blocks.push(structuredClone(b.blocks[0])); b.text += ` ${b.text}`;
    expect(buildScraplingReviewDiff(inputs(a, b)).reason).toBe("block_order_or_multiplicity_changed");
  });
  it("does not hide a link change behind a simultaneous prose change", () => {
    const a = document(), b = proseChange(a); b.links[0].raw_href = "/new-form.pdf";
    expect(buildScraplingReviewDiff(inputs(a, b)).reason).toBe("link_or_base_context_changed");
  });
  it("holds table/heading relationship changes accompanying prose changes", () => {
    const a = document(), b = proseChange(a); b.blocks[0].heading_path = [{ level: 2, text: "New audience" }];
    expect(buildScraplingReviewDiff(inputs(a, b)).reason).toBe("structural_relationship_changed");
  });
});

describe("complete changed-block corroboration with local audience context", () => {
  it("queues a uniquely visible complete paragraph despite unchanged hidden navigation", () => {
    const { a, b, input } = contextualPair();
    const result = buildScraplingReviewDiff(input);
    expect(result).toMatchObject({ status: "changed_needs_review", visible_prose_corroborated: true, publishable: false });
    expect(result.diff.added_text).toEqual([b.blocks[2].text]);
    expect(result.diff.removed_text).toEqual([a.blocks[2].text]);
    expect(result.diff.scrapling_semantics.previous_source_prose).toContain("Hidden menu and unused submenu.");
    expect(result.diff.scrapling_semantics.changed_block_indices).toEqual([2]);
    expect(result.diff.added_text[0]).not.toContain("Hidden menu");
  });
  it("retains multiple changed blocks in source order with all prose changes explained", () => {
    const a = document(); a.blocks.push(block("Applicants must submit two recommendations.")); a.text += ` ${a.blocks[1].text}`;
    const b = proseChange(a); b.blocks[1].text = "Applicants must submit three recommendations.";
    b.text = b.text.replace("two recommendations", "three recommendations");
    const result = buildScraplingReviewDiff(inputs(a, b));
    expect(result.status).toBe("changed_needs_review");
    expect(result.diff.added_text).toEqual(b.blocks.map(item => item.text));
  });
  it("holds a hidden duplicate, including identical text in a visible nonsemantic div", () => {
    const { a, b } = contextualPair();
    const old = a.blocks[2].text, current = b.blocks[2].text;
    // The duplicate div is in full source text but not the semantic blocks array.
    a.text += ` International applicants ${old}`; b.text += ` International applicants ${current}`;
    const input = setVisible(inputs(a, b), `Eligibility International applicants ${old}`, `Eligibility International applicants ${current}`);
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required",
      reason: "changed_block_source_occurrence_ambiguous", diff: null });
  });
  it("holds stale paragraph text matched under another visible audience, not just a label elsewhere", () => {
    const { input } = contextualPair();
    setVisible(input, `Eligibility International applicants ${sentence}`,
      `Eligibility International applicants ${proseChange().text}`);
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required",
      reason: "changed_block_context_not_uniquely_visible" });
  });
  it("holds both dates already present on both visible sides", () => {
    const a = document(), b = proseChange(a);
    // Nonsemantic sibling text remains outside the block list; neither date is new.
    a.text += ` ${b.blocks[0].text}`; b.text += ` ${a.blocks[0].text}`;
    const input = inputs(a, b);
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required",
      reason: "changed_block_already_present_on_opposite_side" });
  });
  it("holds nested semantic duplicate blocks even when full source prose occurs once", () => {
    const a = document(), b = proseChange(a);
    a.blocks.push({ ...a.blocks[0], kind: "li" }); b.blocks.push({ ...b.blocks[0], kind: "li" });
    expect(buildScraplingReviewDiff(inputs(a, b)).reason).toBe("changed_block_source_occurrence_ambiguous");
  });
  it.each([
    ["missing heading", (old, current) => [old.replace("Eligibility ", ""), current.replace("Eligibility ", "")]],
    ["duplicate heading", (old, current) => [`Eligibility ${old}`, `Eligibility ${current}`]],
    ["wrong heading order", (old, current) => [`${old.replace("Eligibility ", "")} Eligibility`, `${current.replace("Eligibility ", "")} Eligibility`]],
    ["hidden intervening qualifier", (old, current) => [old.replace("Eligibility ", "Eligibility International applicants only "), current.replace("Eligibility ", "Eligibility International applicants only ")]],
  ])("holds incomplete or ambiguous context: %s", (_, mutate) => {
    const { input } = contextualPair();
    const values = mutate(input.previous.meta.scrapling.visible_text, input.capture.scrapling.visible_text);
    setVisible(input, ...values);
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required",
      reason: "changed_block_context_not_uniquely_visible" });
  });
  it.each([
    ["uppercase", value => value.toUpperCase()],
    ["partial excerpt", () => "October 31, 2026"],
    ["larger token suffix", value => `${value}suffix`],
  ])("does not infer complete block evidence from %s", (_, mutate) => {
    const input = inputs(document(), proseChange());
    setVisible(input, mutate(input.previous.meta.scrapling.visible_text), mutate(input.capture.scrapling.visible_text));
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required",
      reason: "changed_block_not_uniquely_visible" });
  });
  it("holds an unrelated title change even alongside a valid paragraph substitution", () => {
    const a = document(), b = proseChange(a); b.title = "Other Scholarship";
    expect(buildScraplingReviewDiff(inputs(a, b)).reason).toBe("title_change_requires_manual_review");
  });
  it("holds a title-only change, never inventing changed prose blocks", () => {
    const a = document(), b = structuredClone(a); b.title = "Other Scholarship";
    expect(buildScraplingReviewDiff(inputs(a, b)).reason).toBe("title_change_requires_manual_review");
  });
  it("holds source prose edits that cannot be explained by the complete changed blocks", () => {
    const a = document(), b = proseChange(a); a.text += " Other source wording."; b.text += " Unexplained source wording.";
    const input = inputs(a, b);
    expect(buildScraplingReviewDiff(input).reason).toBe("unexplained_full_source_prose_change");
  });
  it("holds unrelated native visible text changes absent from the full source blocks", () => {
    const input = inputs(document(), proseChange());
    setVisible(input, `${input.previous.meta.scrapling.visible_text} Old visible qualifier.`, `${input.capture.scrapling.visible_text} New visible qualifier.`);
    expect(buildScraplingReviewDiff(input).reason).toBe("unexplained_visible_prose_change");
  });
  it("holds a prose edit not represented by any changed complete block", () => {
    const a = document(), b = structuredClone(a); b.text = b.text.replace("October 31", "November 15");
    expect(buildScraplingReviewDiff(inputs(a, b)).reason).toBe("prose_change_has_no_complete_changed_block");
  });
  it("never truncates a change set beyond the downstream publication eight-block bound", () => {
    const a = document(); a.blocks = Array.from({ length: 9 }, (_, index) => block(`Applicant group ${index} deadline: March 1, 2027.`));
    a.text = a.blocks.map(item => item.text).join(" ");
    const b = structuredClone(a); b.blocks.forEach(item => { item.text = item.text.replace("March 1", "March 15"); });
    b.text = b.blocks.map(item => item.text).join(" ");
    expect(buildScraplingReviewDiff(inputs(a, b)).reason).toBe("complete_changed_blocks_exceed_review_bound");
  });
  it("retains all eight admissible changed blocks without clipping or deduplication", () => {
    const a = document(); a.blocks = Array.from({ length: 8 }, (_, index) => block(`Applicant group ${index} deadline: March 1, 2027.`));
    a.text = a.blocks.map(item => item.text).join(" ");
    const b = structuredClone(a); b.blocks.forEach(item => { item.text = item.text.replace("March 1", "March 15"); });
    b.text = b.blocks.map(item => item.text).join(" ");
    const result = buildScraplingReviewDiff(inputs(a, b));
    expect(result.status).toBe("changed_needs_review");
    expect(result.diff.added_text).toEqual(b.blocks.map(item => item.text));
    expect(result.diff.removed_text).toEqual(a.blocks.map(item => item.text));
  });
});

describe("lossless shared context for bounded long-page changes", () => {
  function longPair() {
    const a = document();
    a.blocks = [block("Unchanged explanatory background. ".repeat(250)), block(sentence),
      block("All requirements on this page apply only to U.S. applicants for the 2027 cycle, unless explicitly stated otherwise.")];
    a.text = a.blocks.map(item => item.text).join(" ");
    const b = structuredClone(a); b.blocks[1].text = b.blocks[1].text.replace("October 31", "November 15");
    b.text = b.blocks.map(item => item.text).join(" ");
    return { a, b };
  }
  function restore(diff) {
    const semantics = diff.scrapling_semantics;
    let cursor = 0, prose = "";
    for (const replacement of semantics.previous_prose_replacements) {
      expect(replacement.current_start).toBeGreaterThanOrEqual(cursor);
      expect(semantics.current_source_prose.slice(replacement.current_start, replacement.current_end))
        .toBe(normalizeVisibleText(diff.added_text[replacement.change_index]));
      prose += semantics.current_source_prose.slice(cursor, replacement.current_start) + replacement.previous_text;
      cursor = replacement.current_end;
    }
    prose += semantics.current_source_prose.slice(cursor);
    const context = structuredClone(semantics.current_context);
    semantics.changed_block_indices.forEach((index, change) => { context.blocks[index].text = diff.removed_text[change]; });
    expect(rawHash(prose)).toBe(semantics.previous_source_prose_sha256);
    expect(rawHash(JSON.stringify(context))).toBe(semantics.previous_context_sha256);
    return { prose, context };
  }
  it("keeps the existing complete short-page representation unchanged", () => {
    const a = document(), b = proseChange(a), result = buildScraplingReviewDiff(inputs(a, b));
    expect(result.diff.scrapling_semantics.version).toBe(2);
    expect(result.diff.scrapling_semantics).not.toHaveProperty("representation");
    expect(result.diff.scrapling_semantics.previous_source_prose).toBe(`${a.title}\n\n${a.text}`);
  });
  it("retains full remote/global qualifications once per current prose/context and reconstructs the entire previous page", () => {
    const { a, b } = longPair(), result = buildScraplingReviewDiff(inputs(a, b));
    expect(a.text.length).toBeGreaterThan(8000);
    expect(result).toMatchObject({ status: "changed_needs_review", publishable: false, baseline_advance_allowed: false });
    const semantics = result.diff.scrapling_semantics;
    expect(semantics).toMatchObject({ version: 3, representation: "lossless_shared_context",
      source_context_complete: true, change_accounting_complete: true,
      previous_source_prose_included: false, previous_source_prose_reconstructable: true });
    expect(semantics).not.toHaveProperty("previous_source_prose");
    expect(semantics).not.toHaveProperty("previous_context");
    expect(semantics.current_source_prose).toBe(normalizeVisibleText(`${b.title}\n\n${b.text}`));
    expect(semantics.current_source_prose).toContain(a.blocks[2].text);
    expect(semantics.current_context.blocks).toEqual(b.blocks);
    expect(semantics.current_context.links).toEqual(b.links);
    const restored = restore(result.diff);
    expect(restored.prose).toBe(normalizeVisibleText(`${a.title}\n\n${a.text}`));
    expect(restored.context).toEqual({ blocks: a.blocks, links: a.links, base_hrefs: a.base_hrefs });
    expect(Buffer.byteLength(JSON.stringify(result.diff))).toBeLessThanOrEqual(24000);
  });
  it("retains a previous-only qualification within the complete changed block", () => {
    const { a, b } = longPair();
    a.blocks[1].text = "Applicants must apply by October 31, 2027, but only seniors in the U.S. are eligible.";
    b.blocks[1].text = "Applicants must apply by November 15, 2027; juniors and seniors in the U.S. are eligible.";
    a.text = a.blocks.map(item => item.text).join(" "); b.text = b.blocks.map(item => item.text).join(" ");
    const result = buildScraplingReviewDiff(inputs(a, b));
    expect(result.status).toBe("changed_needs_review");
    expect(result.diff.removed_text).toEqual([a.blocks[1].text]);
    expect(result.diff.scrapling_semantics.previous_prose_replacements[0].previous_text).toContain("only seniors in the U.S.");
    expect(restore(result.diff).prose).toContain(a.blocks[1].text);
  });
  it("preserves separated edits in order and never interprets offsets as UTF-8 bytes", () => {
    const { a, b } = longPair();
    a.blocks[0].text = `🎓 ${a.blocks[0].text}`; b.blocks[0].text = a.blocks[0].text;
    a.blocks.push(block("The annual stipend is $25,000.")); b.blocks.push(block("The annual stipend is $30,000."));
    a.text = a.blocks.map(item => item.text).join(" "); b.text = b.blocks.map(item => item.text).join(" ");
    const result = buildScraplingReviewDiff(inputs(a, b));
    expect(result.status).toBe("changed_needs_review");
    expect(result.diff.scrapling_semantics.changed_block_indices).toEqual([1, 3]);
    expect(result.diff.scrapling_semantics.previous_prose_replacement_offsets).toBe("utf16_code_units_into_current_source_prose");
    expect(result.diff.removed_text).toEqual([a.blocks[1].text, a.blocks[3].text]);
    expect(restore(result.diff).prose).toBe(normalizeVisibleText(`${a.title}\n\n${a.text}`));
  });
  it("does not silently lose formatting or unchanged block metadata outside the exact replacements", () => {
    const { a, b } = longPair();
    a.text = a.text.replace("All requirements", "\n\nAll requirements");
    expect(buildScraplingReviewDiff(inputs(a, b))).toMatchObject({ status: "manual_review_required",
      reason: "lossless_shared_context_reconstruction_failed", diff: null });
    const other = longPair(); other.a.blocks[2].text = other.a.blocks[2].text.replace("All requirements", "All  requirements");
    expect(buildScraplingReviewDiff(inputs(other.a, other.b)).reason).toBe("lossless_shared_context_reconstruction_failed");
  });
  it.each([
    ["unexplained source qualification", (a, b) => { b.text += " International applicants are excluded."; }, "unexplained_full_source_prose_change"],
    ["changed hyperlink", (a, b) => { b.links[0].raw_href = "/different-program.pdf"; }, "link_or_base_context_changed"],
    ["changed FAQ ancestry", (a, b) => { a.blocks[1].details_path = ["U.S. applicants"]; b.blocks[1].details_path = ["International applicants"]; }, "structural_relationship_changed"],
    ["changed table relationship", (a, b) => { b.blocks[1].table_cell = { colspan: 2 }; }, "structural_relationship_changed"],
  ])("keeps %s on hold even when the lossless format would fit", (_, mutate, reason) => {
    const { a, b } = longPair(); mutate(a, b);
    expect(buildScraplingReviewDiff(inputs(a, b))).toMatchObject({ status: "manual_review_required", reason, diff: null });
  });
  it("keeps hidden edits and screenshot mismatches held before packing", () => {
    const { a, b } = longPair(), input = inputs(a, b);
    setVisible(input, "Read the official instructions.", "Read the official instructions.");
    expect(buildScraplingReviewDiff(input).reason).toBe("changed_block_not_uniquely_visible");
    input.capture.scrapling.screenshot.semantics_bracketed = false;
    expect(buildScraplingReviewDiff(input).reason).toBe("supplementary_screenshot_semantics_changed");
  });
  it("preserves the countdown-only hold on a long page", () => {
    const { a, b } = longPair(); a.blocks[1].text = "Applications close in 20 days and 10 minutes.";
    b.blocks[1].text = "Applications close in 20 days and 9 minutes.";
    a.text = a.blocks.map(item => item.text).join(" "); b.text = b.blocks.map(item => item.text).join(" ");
    expect(buildScraplingReviewDiff(inputs(a, b)).reason).toBe("countdown_only_change_requires_manual_review");
  });
  it("keeps all source prose/context rather than clipping an oversized packed payload", () => {
    const { a, b } = longPair();
    const result = buildScraplingReviewDiff(inputs(a, b), { maxDiffBytes: 15000 });
    expect(result).toMatchObject({ status: "manual_review_required", reason: "complete_diff_exceeds_review_bound", diff: null });
  });
  it("bounds the combined complete changed text even across multiple blocks", () => {
    const a = document(); a.blocks = Array.from({ length: 2 }, (_, i) => block(`Applicant group ${i}: ${"Unchanged words. ".repeat(260)} deadline October 31, 2027.`));
    const b = structuredClone(a); b.blocks.forEach(item => { item.text = item.text.replace("October 31", "November 15"); });
    a.text = a.blocks.map(item => item.text).join(" "); b.text = b.blocks.map(item => item.text).join(" ");
    expect(buildScraplingReviewDiff(inputs(a, b))).toMatchObject({ status: "manual_review_required",
      reason: "complete_changed_prose_exceeds_review_bound", diff: null });
  });
  it("passes every complete edit and source context through the existing prompt payload unchanged", () => {
    const { a, b } = longPair(), input = inputs(a, b), result = buildScraplingReviewDiff(input);
    const payload = buildVisualReviewPromptPayload({ ...input, diff: result.diff, deterministic: result.deterministic });
    expect(payload.deterministic_diff).toEqual(result.diff);
    expect(buildVisualReviewPromptText(payload)).toContain(a.blocks[2].text);
    expect(buildVisualReviewPromptText(payload)).toContain(a.blocks[1].text);
    expect(buildVisualReviewPromptText(payload)).toContain(b.blocks[1].text);
  });
});

describe("lossless labeled context tables for repeated long-page context", () => {
  const qualification = "For the 2027 award cycle, these requirements apply only to U.S. citizens enrolled full time; " +
    "international applicants must use their separate application route, and institutional nomination dates may be earlier.";
  function tablePair() {
    // Synthetic storage regression, not an observed award change or AI result.
    const a = document();
    const heading = [{ text: qualification, level: 2 }];
    a.blocks = [{ ...block(qualification), kind: "heading", heading_path: structuredClone(heading) },
      { ...block(sentence), heading_path: structuredClone(heading) },
      ...Array.from({ length: 65 }, (_, i) => ({ ...block(`Supporting condition ${i} remains unchanged for all applicants.`),
        heading_path: structuredClone(heading) }))];
    a.links = Array.from({ length: 40 }, (_, i) => ({ ...structuredClone(a.links[0]),
      text: `Application guide ${i % 5}`, raw_href: `/apply.pdf?track=${i % 7}&literal=%20%20`, heading_path: structuredClone(heading) }));
    a.text = a.blocks.map(item => item.text).join(" ");
    const b = structuredClone(a); b.blocks[1].text = b.blocks[1].text.replace("October 31", "November 15");
    b.text = b.blocks.map(item => item.text).join(" ");
    return { a, b };
  }
  function decode(tables) {
    const at = (values, index) => {
      expect(Number.isInteger(index) && index >= 0 && index < values.length).toBe(true);
      return values[index];
    };
    const list = index => at(tables.string_lists, index).map(i => at(tables.strings, i));
    const rows = table => table.rows.map(row => Object.fromEntries(at(table.field_orders, row[0]).map((field, i) => {
      const value = row[i + 1];
      if (["kind", "table_cell"].includes(field)) return [field, value];
      if (field === "heading_path") return [field, at(tables.heading_paths, value).map(heading => Object.fromEntries(
        Object.entries(heading).map(([key, v]) => [key, key === "text" ? at(tables.strings, v) : v])))];
      if (["list_path", "table_row", "details_path", "base_hrefs"].includes(field)) return [field, list(value)];
      return [field, at(tables.strings, value)];
    })));
    return Object.fromEntries(tables.context_fields.map(field => [field, field === "base_hrefs" ? list(tables.base_hrefs) : rows(tables[field])]));
  }
  function expectRoundTrip(a, b, diff) {
    const semantics = JSON.parse(JSON.stringify(diff)).scrapling_semantics;
    const current = decode(semantics.current_context_tables);
    const expected = parseScraplingReviewText(scraplingReviewText(b), { finalUrl: source.url }).context;
    expect(JSON.stringify(current)).toBe(JSON.stringify(expected));
    expect(rawHash(JSON.stringify(current))).toBe(semantics.current_context_sha256);
    semantics.changed_block_indices.forEach((index, i) => { current.blocks[index].text = diff.removed_text[i]; });
    const old = parseScraplingReviewText(scraplingReviewText(a), { finalUrl: source.url }).context;
    expect(JSON.stringify(current)).toBe(JSON.stringify(old));
    expect(rawHash(JSON.stringify(current))).toBe(semantics.previous_context_sha256);
    let previousProse = semantics.current_source_prose;
    for (const change of [...semantics.previous_prose_replacements].reverse()) {
      previousProse = previousProse.slice(0, change.current_start) + change.previous_text + previousProse.slice(change.current_end);
    }
    expect(previousProse).toBe(normalizeVisibleText(`${a.title}\n\n${a.text}`));
    expect(rawHash(previousProse)).toBe(semantics.previous_source_prose_sha256);
  }
  it("uses v4 only after the complete shared-context packet does not fit, preserving all text and exact context", () => {
    const { a, b } = tablePair(), result = buildScraplingReviewDiff(inputs(a, b));
    const unpackedFloor = Buffer.byteLength(JSON.stringify({ current_source_prose: b.text,
      current_context: { blocks: b.blocks, links: b.links, base_hrefs: b.base_hrefs } }));
    expect(unpackedFloor).toBeGreaterThan(24000);
    expect(result).toMatchObject({ status: "changed_needs_review", publishable: false, baseline_advance_allowed: false });
    expect(result.diff.scrapling_semantics).toMatchObject({ version: 4, representation: "lossless_context_tables",
      context_table_reconstruction_verified: true, source_context_complete: true, change_accounting_complete: true });
    expect(result.diff.scrapling_semantics).not.toHaveProperty("current_context");
    expect(result.diff.scrapling_semantics.current_source_prose).toContain(qualification);
    expect(result.diff.added_text).toEqual([b.blocks[1].text]);
    expect(result.diff.removed_text).toEqual([a.blocks[1].text]);
    expect(Buffer.byteLength(JSON.stringify(result.diff), "utf8")).toBeLessThanOrEqual(24000);
    expectRoundTrip(a, b, result.diff);
  });
  it("preserves duplicate rows, exact URL whitespace, optional FAQ/table fields and unusual property order", () => {
    const { a, b } = tablePair();
    for (const doc of [a, b]) {
      doc.links[0].raw_href = "/apply?literal=  quoted\"&emoji=🎓&line=\n";
      doc.links[1] = structuredClone(doc.links[0]);
      doc.links[0].details_path = ["Who may apply?", ""]; // Empty unlabeled ancestor remains explicit.
      doc.blocks[3].table_cell = { raw_colspan: "01", colspan: 1, headers: "U.S.  applicants", scope: "row", rowspan: 0 };
      doc.blocks[4].details_path = ["Who may apply?"];
      doc.blocks[5] = Object.fromEntries(Object.entries(doc.blocks[5]).reverse());
      doc.blocks.push(structuredClone(doc.blocks[6]));
      doc.text = doc.blocks.map(item => item.text).join(" ");
    }
    const result = buildScraplingReviewDiff(inputs(a, b));
    expect(result.status).toBe("changed_needs_review");
    expectRoundTrip(a, b, result.diff);
    const context = decode(result.diff.scrapling_semantics.current_context_tables);
    expect(context.blocks[2]).not.toHaveProperty("details_path");
    expect(context.blocks[4].details_path).toEqual(["Who may apply?"]);
    expect(context.links).toHaveLength(b.links.length);
    expect(context.blocks).toHaveLength(b.blocks.length);
    expect(context.blocks[6]).toEqual(context.blocks.at(-1));
  });
  it("keeps previous-only conditions and separated emoji edits complete", () => {
    const { a, b } = tablePair();
    a.blocks[1].text += " Only seniors may apply; financial need is required. 🎓";
    b.blocks[1].text += " Juniors and seniors may apply; financial need is optional. 🎓";
    a.blocks.push(block("The stipend is $25,000 for the U.S. route."));
    b.blocks.push(block("The stipend is $30,000 for the U.S. route."));
    a.text = a.blocks.map(item => item.text).join(" "); b.text = b.blocks.map(item => item.text).join(" ");
    const result = buildScraplingReviewDiff(inputs(a, b));
    expect(result.status).toBe("changed_needs_review");
    expect(result.diff.removed_text[0]).toContain("Only seniors may apply; financial need is required. 🎓");
    expect(result.diff.scrapling_semantics.changed_block_indices).toEqual([1, a.blocks.length - 1]);
    expectRoundTrip(a, b, result.diff);
  });
  it("uses actual serialized UTF-8 bytes, not characters, and keeps an oversized table packet held", () => {
    const { a, b } = tablePair();
    for (const doc of [a, b]) {
      doc.blocks.push(block("🎓漢字".repeat(1250)));
      doc.text = doc.blocks.map(item => item.text).join(" ");
    }
    const result = buildScraplingReviewDiff(inputs(a, b));
    expect(Buffer.byteLength(b.text, "utf8")).toBeGreaterThan(b.text.length);
    expect(result).toMatchObject({ status: "manual_review_required", reason: "complete_diff_exceeds_review_bound", diff: null });
  });
  it("checks the exact final byte boundary including its legend and JSON escaping", () => {
    const { a, b } = tablePair();
    for (const doc of [a, b]) doc.links[0].raw_href = "/quotes?x=\"\\🎓";
    const input = inputs(a, b), result = buildScraplingReviewDiff(input);
    expect(result.status).toBe("changed_needs_review");
    const bytes = Buffer.byteLength(JSON.stringify(result.diff), "utf8");
    expect(buildScraplingReviewDiff(input, { maxDiffBytes: bytes }).status).toBe("changed_needs_review");
    expect(buildScraplingReviewDiff(input, { maxDiffBytes: bytes - 1 })).toMatchObject({ status: "manual_review_required",
      reason: "complete_diff_exceeds_review_bound", diff: null });
  });
  it.each([-1, 1, 1000000, 1.5, NaN, "0"])("fails closed on generated reference %j instead of guessing a string", invalidIndex => {
    const { a, b } = tablePair(), get = Map.prototype.get;
    const invalid = vi.spyOn(Map.prototype, "get").mockImplementation(function (key) {
      return key === JSON.stringify(qualification) ? invalidIndex : get.call(this, key);
    });
    try {
      expect(buildScraplingReviewDiff(inputs(a, b))).toMatchObject({ status: "manual_review_required",
        reason: "lossless_context_table_reconstruction_failed", diff: null });
    } finally { invalid.mockRestore(); }
  });
  it("bounds the number of table entries even when the original artifact byte limit permits more", () => {
    const { a, b } = tablePair();
    for (const doc of [a, b]) {
      for (let i = 0; i < 51; i++) doc.blocks[i + 2].list_path = Array.from({ length: 1000 }, (_, j) => `label-${i}-${j}`);
    }
    const input = inputs(a, b);
    expect(Buffer.byteLength(input.capture.text, "utf8")).toBeLessThan(6 * 1024 * 1024);
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required",
      reason: "lossless_context_table_reconstruction_failed", diff: null, retain_both_captures: true });
  });
  it("does not turn malformed optional values, structural changes or unpaired screenshots into eligible packets", () => {
    const { a, b } = tablePair();
    b.blocks[2].details_path = null;
    expect(buildScraplingReviewDiff(inputs(a, b)).reason).toBe("invalid_block");
    delete b.blocks[2].details_path; b.links[0].raw_href = "/wrong-award.pdf";
    expect(buildScraplingReviewDiff(inputs(a, b)).reason).toBe("link_or_base_context_changed");
    const unchanged = tablePair(), input = inputs(unchanged.a, unchanged.b);
    input.capture.scrapling.screenshot.semantics_bracketed = false;
    expect(buildScraplingReviewDiff(input).reason).toBe("supplementary_screenshot_semantics_changed");
  });
});

describe("identity, integrity and bounded fail-closed behavior", () => {
  it.each([
    ["old profile", i => { i.baseline.capture_profile = "stable-daily"; }, "capture_profile_mismatch"],
    ["new profile", i => { i.capture.capture_profile = "scrapling-evidence-v2"; }, "capture_profile_mismatch"],
    ["source URL move", i => { i.baseline.source.url = "https://example.edu/old"; }, "source_identity_mismatch"],
    ["award mismatch", i => { i.capture.source.shared_award_id = "other"; }, "source_identity_mismatch"],
    ["source mismatch", i => { i.capture.source.id = "other"; }, "source_identity_mismatch"],
    ["redirect change", i => { i.capture.final_url = "https://example.edu/new"; }, "final_url_changed_requires_baseline_review"],
    ["same time", i => { i.capture.captured_at = i.baseline.captured_at; }, "capture_order_invalid"],
    ["older capture", i => { i.capture.captured_at = "2026-10-01T00:00:00Z"; }, "capture_order_invalid"],
    ["bad time", i => { i.capture.captured_at = "unknown"; }, "capture_order_invalid"],
    ["missing hash", i => { delete i.baseline.text_hash; delete i.previous.meta.text_hash; }, "missing_text_integrity"],
    ["tampered text", i => { i.capture.text += " tampered"; }, "malformed_context_json"],
    ["wrong hash", i => { i.capture.text_hash = "a".repeat(64); }, "text_integrity_mismatch"],
    ["missing old text", i => { delete i.previous.text; }, "artifact_size_limit"],
    ["truncated JSON", i => { i.capture.text = i.capture.text.slice(0, -2); reseal(i, "after"); }, "malformed_context_json"],
    ["missing marker", i => { i.capture.text = "Truncated award text"; reseal(i, "after"); }, "missing_context_marker"],
  ])("rejects %s instead of declaring unchanged", (_, mutate, reason) => {
    const input = inputs(); mutate(input);
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "unavailable", reason, publishable: false, baseline_advance_allowed: false, diff: null });
  });
  it("checks optional previous metadata against the retained baseline", () => {
    const input = inputs(); input.previous.meta = structuredClone(input.baseline); input.previous.meta.captured_at = "2026-10-14T12:00:00Z";
    expect(buildScraplingReviewDiff(input).reason).toBe("previous_metadata_mismatch");
  });
  it.each([
    ["missing blocks", a => { a.blocks = []; }],
    ["null table", a => { a.blocks[0].table_cell = null; }],
    ["negative span", a => { a.blocks[0].table_cell = { rowspan: -1 }; }],
    ["bad heading", a => { a.blocks[0].heading_path = [{ level: 8, text: "Wrong" }]; }],
    ["empty heading", a => { a.blocks[0].heading_path = [{ level: 2, text: " " }]; }],
    ["cross-source link", a => { a.links[0].source_url = "https://example.edu/wrong"; }],
    ["inconsistent base", a => { a.links[0].base_hrefs = ["/wrong/"]; }],
    ["unknown semantics", a => { a.blocks[0].future_condition = "not captured"; }],
  ])("rejects malformed %s even when both sides match", (_, mutate) => {
    const a = document(); mutate(a);
    expect(buildScraplingReviewDiff(inputs(a)).status).toBe("unavailable");
  });
  it("rejects an old unescaped context representation", () => {
    const input = inputs(); input.capture.text = input.capture.text.replaceAll("\\u0020", " "); reseal(input, "after");
    expect(buildScraplingReviewDiff(input).reason).toBe("noncanonical_context_encoding");
  });
  it("retains oversized complete changed prose for manual review rather than clipping it", () => {
    const result = buildScraplingReviewDiff(inputs(document(), proseChange()), { maxProseChars: 30 });
    expect(result).toMatchObject({ status: "manual_review_required", reason: "complete_changed_prose_exceeds_review_bound", diff: null });
  });
  it("applies byte bounds to the entire complete diff, not just selected excerpts", () => {
    const result = buildScraplingReviewDiff(inputs(document(), proseChange()), { maxDiffBytes: 128 });
    expect(result.reason).toBe("complete_diff_exceeds_review_bound");
  });
  it("rejects an oversized retained artifact", () => {
    expect(buildScraplingReviewDiff(inputs(), { maxArtifactBytes: 10 }).reason).toBe("artifact_size_limit");
  });
  it.each([{ maxDiffBytes: 25000 }, { maxDiffBytes: NaN }, { maxProseChars: 0 }, { maxArtifactBytes: 7 * 1024 * 1024 }])("rejects expanded/invalid limits %j", options => {
    expect(buildScraplingReviewDiff(inputs(), options).reason).toBe("invalid_limits");
  });
});
