import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLegacyReviewCompleteness } from "./legacy-review-completeness.mjs";
import { buildVisualReviewPromptPayload, classifyVisualReviewCandidate, validateVisualBatchReview } from "./visual-review-queue.mjs";
import { buildScraplingReviewDiff } from "./scrapling-review-diff.mjs";
import { captureScraplingWorkerSource, scraplingReviewText } from "./scrapling-worker.mjs";
import { SOURCE_HTML_PROFILE } from "./source-html-evidence.mjs";
import { normalizeVisibleText } from "./capture-stability.mjs";

const retained = JSON.parse(readFileSync(new URL("../fixtures/scrapling-accuracy/yenching-homepage-notice-pair-20261022.json", import.meta.url)));
const hash = value => createHash("sha256").update(value).digest("hex");
// Approval metadata below is synthetic test input, NOT a new approval for the
// historical source. Only the separate fixture's full public texts are retained.
const source = (name = "Yenching Academy") => ({
  id: "synthetic-primary-homepage", shared_award_id: "synthetic-award", url: "https://example.edu/",
  title: name, page_type: "homepage", shared_awards: { name }, admin_review_status: "open",
  page_metadata_generated_at: "2026-10-22T00:00:00Z", page_metadata_model: "offline-regression-fixture",
  page_metadata: { baseline_facts: { award_relevance: "primary", cycle_relevance: "current_or_upcoming", quality_flags: [] } },
});
const diffFor = (added, removed) => ({ added_text: added, removed_text: removed, date_changes: [], amount_changes: [] });
function packet(diff = retained.diff, src = source(), context = {}) {
  const previousText = context.previousText ?? diff.removed_text.join("\n\n");
  const currentText = context.currentText ?? diff.added_text.join("\n\n");
  return { source: src, diff: { ...structuredClone(diff), legacy_review_completeness: buildLegacyReviewCompleteness({
    source: src, previousText, currentText, diff, excludedChangedUnits: 0 }) },
  previous: { text: previousText }, capture: { text: currentText, text_hash: hash(currentText) },
  baseline: { text_hash: hash(context.previousCaptureText ?? previousText) }, deterministic: { candidate_change: true } };
}
function retainedPacket() {
  return packet(retained.diff, source(), { previousText: retained.before.raw_text,
    currentText: retained.after.raw_text.slice(0, -1), previousCaptureText: retained.before.raw_text.slice(0, -1) });
}
const mixedDiff = (name = "Yenching Academy") => diffFor([
  `${name} application deadline: March 15, 2027.`,
  `${name} eligibility requires a minimum GPA of 3.5.`,
  "Global Health Degree Program application deadline: May 15, 2027.",
], [
  `${name} application deadline: March 1, 2027.`,
  `${name} eligibility requires a minimum GPA of 3.0.`,
  "Global Health Degree Program application deadline: May 1, 2027.",
]);
function candidateFor(input) {
  return { shared_award_source_id: input.source.id, shared_award_id: input.source.shared_award_id,
    source_url: input.source.url, previous_text_hash: input.baseline.text_hash, new_text_hash: input.capture.text_hash,
    deterministic_diff: input.diff, prompt_payload: buildVisualReviewPromptPayload({ ...input, promptChars: 3 }) };
}
function resultFor(diff, indices = [0, 1]) {
  return { is_true_change: true, is_alert_worthy: true, confidence: "high", source_relevance: "primary",
    change_type: "eligibility", section: "Application requirements", noise_flags: [], policy_flags: [],
    reader_summary: "Application deadline and minimum GPA changed.",
    changed_facts: indices.map(i => ({ fact: i === 1 ? "Minimum GPA" : "Application deadline",
      before: diff.removed_text[i], after: diff.added_text[i], removed_text: null, added_text: null, visual_evidence: null })) };
}
const validate = (input, result) => validateVisualBatchReview({ candidate: candidateFor(input), source: input.source, result });

beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected_network_or_provider_call"); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("complete mixed-content primary homepages receive review, not source rejection or fact approval", () => {
  it("pins both full retained texts, original metadata hashes, and the exact two substitutions", () => {
    expect(retained.before.raw_sha256).toBe("21d8d175ebeb0f95d36f40a1bb6957f9ba6b4d769dfd3d906bff687ea823698e");
    expect(retained.after.raw_sha256).toBe("f96da1b142c957fd0e1ba69e07135d67b867683f636337f3e5773d2bc340b80b");
    expect(retained.before.meta_sha256).toBe("3f0cc73cb96eb9db882cbe08becf3f5a110236adbf41c893ef51aaa6ddfbc9c5");
    expect(retained.after.meta_sha256).toBe("f18f9ff72dccf1357b64b3922138c336f6bced290054fe9213c8cf9e28ee2c0e");
    for (const side of [retained.before, retained.after]) expect(hash(side.raw_text)).toBe(side.raw_sha256);
    let changed = retained.before.raw_text;
    for (const [before, after] of [
      ["Yenching Scholars Forum | China in Transition: Modernity, Sustainability & Humanity", "Hello, Cohort 2026!"],
      ["【Open for Applications】YCA Alumni Enrichment Program (2026 Fall)", "Many Paths to Yenching Academy: Join Our October Information Sessions"],
    ]) {
      expect(changed.split(before)).toHaveLength(2);
      changed = changed.replace(before, after);
    }
    expect(changed).toBe(retained.after.raw_text);
  });

  it("routes the exact retained pair to review and preserves all context and evidence", () => {
    const input = retainedPacket(), before = structuredClone(input);
    expect(classifyVisualReviewCandidate(input)).toMatchObject({ allowed: true,
      candidate_kind: "text_only", reason: "mixed_primary_source_content_requires_review" });
    const payload = buildVisualReviewPromptPayload({ ...input, promptChars: 3 });
    expect(payload.previous_text_excerpt).toBe(retained.before.raw_text);
    expect(payload.new_text_excerpt).toBe(retained.after.raw_text.slice(0, -1));
    for (const key of ["added_text", "removed_text", "date_changes", "amount_changes"]) {
      expect(payload.text_evidence[key]).toEqual(retained.diff[key]);
      expect(payload.deterministic_diff[key]).toEqual(retained.diff[key]);
    }
    expect(input).toEqual(before);
  });

  it.each(["Meridian Scholars Academy", "Northern Research Fellows", "Meridian Research Fellowship"])("does not depend on a source ID or headline allowlist: %s", name => {
    expect(classifyVisualReviewCandidate(packet(mixedDiff(name), source(name))))
      .toMatchObject({ allowed: true, reason: "mixed_primary_source_content_requires_review" });
  });

  it("keeps simultaneous primary deadline and eligibility facts reviewable", () => {
    const input = packet(mixedDiff()), result = resultFor(input.diff), before = structuredClone({ input, result });
    expect(classifyVisualReviewCandidate(input).allowed).toBe(true);
    expect(validate(input, result)).toEqual({ allowed: true, reason: "approved" });
    expect({ input, result }).toEqual(before);
  });

  it.each([
    ["Notices Many Paths to Yenching Academys:", "substring suffix"],
    ["Notices Many Paths to xYenching Academy:", "substring prefix"],
    ["Yenching Academy: Global Health Degree Program application deadline changed.", "primary-name camouflage"],
    ["Many Paths to Meridian Scholars Academy:", "another source's name"],
  ])("does not qualify an ambiguous clean-primary entry (%s / %s)", (entry) => {
    const diff = structuredClone(retained.diff); diff.added_text[0] = entry;
    expect(classifyVisualReviewCandidate(packet(diff))).toMatchObject({ allowed: false, reason: "sibling_program_or_cross_award" });
  });

  it("rejects a foreign program without separate named-primary evidence", () => {
    const diff = mixedDiff(); diff.added_text = diff.added_text.slice(2); diff.removed_text = diff.removed_text.slice(2);
    expect(classifyVisualReviewCandidate(packet(diff))).toMatchObject({ allowed: false, reason: "sibling_program_or_cross_award" });
  });

  it.each(["supporting", "unrelated", "unclear"])("does not broaden %s source acceptance", relevance => {
    const src = source(); src.page_metadata.baseline_facts.award_relevance = relevance;
    expect(classifyVisualReviewCandidate(packet(retained.diff, src)).allowed).toBe(false);
  });

  it.each([
    src => { src.page_type = "faq"; },
    src => { delete src.shared_awards; },
    src => { src.shared_awards.name = "Academy"; },
    src => { delete src.page_metadata_generated_at; delete src.page_metadata_model; },
    src => { src.title = "Global Health Degree Program"; },
    src => { src.url = "https://example.edu/payment/"; },
    src => { src.title = "Access Denied"; },
  ])("does not bypass source identity, review or access checks (%#)", mutate => {
    const src = source(); mutate(src);
    expect(classifyVisualReviewCandidate(packet(retained.diff, src)).allowed).toBe(false);
  });

  it.each([
    input => { delete input.diff.legacy_review_completeness; },
    input => { input.diff.legacy_review_completeness.excluded_changed_units = 1; },
    input => { input.previous.text = input.previous.text.slice(20); },
    input => { input.diff.legacy_review_completeness.current_text_sha256 = "0".repeat(64); },
    input => { input.diff.legacy_review_completeness.source_id = "another-source"; },
    input => { input.diff.candidate_scope = "scrapling_html_source"; },
  ])("requires its own complete legacy context, not a missing or delegated contract (%#)", mutate => {
    const input = retainedPacket(); mutate(input);
    expect(classifyVisualReviewCandidate(input).allowed).toBe(false);
  });

  it("preserves an independent deterministic rejection", () => {
    const input = retainedPacket(); input.deterministic = { candidate_change: false, reason: "recipient_news_rotation" };
    expect(classifyVisualReviewCandidate(input)).toMatchObject({ allowed: false, reason: "recipient_news_rotation" });
  });

  it("does not convert an information-session announcement or no-change result into an alert", () => {
    const input = retainedPacket();
    expect(validate(input, { is_true_change: false, is_alert_worthy: false, rejection_reason: "no_applicant_fact_change", changed_facts: [] }))
      .toEqual({ allowed: false, reason: "no_applicant_fact_change" });
    expect(validate(input, { ...resultFor(input.diff, [0]), policy_flags: ["recipient_news_change"] }).allowed).toBe(false);
  });
});

describe("mixed-content result guard keeps foreign and ambiguous facts out", () => {
  it.each([false, true])("rejects a foreign-program fact even with its program name stripped: %s", stripName => {
    const input = packet(mixedDiff()), result = resultFor(input.diff, [2]);
    if (stripName) for (const side of ["before", "after"]) result.changed_facts[0][side] = result.changed_facts[0][side].replace("Global Health Degree Program ", "");
    expect(validate(input, result)).toEqual({ allowed: false, reason: "mixed_primary_source_fact_context_unverified" });
  });

  it("rejects an extra foreign fact rather than silently dropping it beside a valid primary fact", () => {
    const input = packet(mixedDiff());
    expect(validate(input, resultFor(input.diff, [0, 2])))
      .toEqual({ allowed: false, reason: "mixed_primary_source_fact_context_unverified" });
  });

  it("rejects a name-stripped quote shared between primary and foreign entries", () => {
    const diff = mixedDiff();
    for (const side of ["added_text", "removed_text"]) diff[side][2] = diff[side][0].replace("Yenching Academy", "Global Health Degree Program");
    const input = packet(diff), result = resultFor(input.diff, [0]);
    for (const side of ["before", "after"]) result.changed_facts[0][side] = result.changed_facts[0][side].replace("Yenching Academy ", "");
    expect(validate(input, result)).toEqual({ allowed: false, reason: "mixed_primary_source_fact_context_unverified" });
  });

  it("does not accept a primary-name prefix hiding another program in the quoted entry", () => {
    const diff = mixedDiff();
    diff.added_text.push("Yenching Academy: Global Health Degree Program eligibility requires one year of study.");
    diff.removed_text.push("Yenching Academy: Global Health Degree Program eligibility requires two years of study.");
    const input = packet(diff), result = resultFor(input.diff, [3]);
    for (const side of ["before", "after"]) result.changed_facts[0][side] = result.changed_facts[0][side].replace("Yenching Academy: Global Health Degree Program ", "");
    expect(validate(input, result)).toEqual({ allowed: false, reason: "mixed_primary_source_fact_context_unverified" });
  });

  it.each(["before", "exact_before", "after", "exact_after"])("also checks the top-level %s quote", field => {
    const input = packet(mixedDiff()), result = resultFor(input.diff, [0]);
    result[field] = input.diff[field.includes("before") ? "removed_text" : "added_text"][2];
    expect(validate(input, result)).toEqual({ allowed: false, reason: "mixed_primary_source_fact_context_unverified" });
  });

  it("does not allow unnamed directional facts solely because a primary headline is elsewhere", () => {
    const diff = mixedDiff();
    diff.added_text.push("Application deadline: June 15, 2027.");
    diff.removed_text.push("Application deadline: June 1, 2027.");
    const input = packet(diff);
    expect(validate(input, resultFor(input.diff, [3])))
      .toEqual({ allowed: false, reason: "mixed_primary_source_fact_context_unverified" });
  });

  it("retains existing missing direction and unsupported-quote holds", () => {
    const input = packet(mixedDiff()), result = resultFor(input.diff, [0]);
    result.changed_facts[0].before = null;
    expect(validate(input, result)).toEqual({ allowed: false, reason: "changed_facts_incomplete_directional_evidence" });
    result.changed_facts[0].before = "Invented application deadline: July 1, 2027.";
    expect(validate(input, result)).toEqual({ allowed: false, reason: "changed_facts_not_supported_by_evidence" });
  });
});


// Synthetic contracts, not real captures or source approvals. The source-only
// adapter writes test-owned evidence; browser metadata uses the existing pure
// scrapling-review-diff fixture shape. No native browser or provider is invoked.
const mixedFixtureParent = fileURLToPath(new URL("../../tmp/", import.meta.url));
const mixedFixtureDirectories = [];
const scraplingProfiles = [SOURCE_HTML_PROFILE, "scrapling-evidence-v1", "scrapling-evidence-v2"];
async function scraplingMixedPacket(profile, { ambiguous = false } = {}) {
  const src = { ...source(), id: "10000000-0000-0000-0000-000000000001",
    shared_award_id: "20000000-0000-0000-0000-000000000001" };
  const changes = mixedDiff();
  if (ambiguous) for (const direction of ["added_text", "removed_text"]) {
    changes[direction][2] = changes[direction][0].replace("Yenching Academy", "Global Health Degree Program");
  }
  const documents = ["removed_text", "added_text"].map(direction => {
    const texts = [...changes[direction],
      "Applicants should read all eligibility conditions and provide complete transcripts, supporting references, and accurate contact information."];
    return { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document",
      source_url: src.url, title: src.title, text: texts.join(" "), publishable: false, visibility_verified: false,
      blocks: texts.map(text => ({ kind: "p", text, heading_path: [], list_path: [], table_row: [] })),
      links: [], base_hrefs: [], limitations: ["Synthetic source content is not a current award fact."] };
  });
  const timestamps = ["2026-10-21T00:00:00.000Z", "2026-10-22T00:00:00.000Z"];
  let root, before, current;
  if (profile === SOURCE_HTML_PROFILE) {
    mkdirSync(mixedFixtureParent, { recursive: true });
    root = mkdtempSync(join(mixedFixtureParent, "mixed-primary-review-"));
    mixedFixtureDirectories.push(root);
    const records = documents.map((doc, index) => {
      const html = "<html><head><title>" + src.title + "</title></head><body><main>" +
        doc.blocks.map(block => "<p>" + block.text + "</p>").join("") + "</main></body></html>";
      return { schema: "awardping.scrapling-capture.v1", capture_profile: profile, source_id: src.id,
        url: src.url, final_url: src.url, captured_at: timestamps[index], status_code: 200,
        content_type: "text/html; charset=utf-8", html, html_document: doc,
        source_main_document: { ...structuredClone(doc), title: "", scope: "html-source-main-element" },
        source_http: { schema: "awardping.scrapling-source-http.v1", method: "GET", response_complete: true,
          redirect_count: 0, body_encoding: "utf-8", content_encoding: "identity",
          body_byte_length: Buffer.byteLength(html), body_sha256: hash(html), acquisition: "ordinary_anonymous_http",
          visibility_verified: false, screenshot_available: false },
        warnings: ["source_html_only_not_browser_visible_or_screenshot_evidence",
          "linked_documents_forms_and_client_loaded_content_not_fetched"],
        engine: { scrapling: "0.4.15", client: "Fetcher", adaptive: false, stealth: false, impersonation: false } };
    });
    const adapter = vi.fn(async () => records[adapter.mock.calls.length - 1]);
    before = await captureScraplingWorkerSource(src, { archiveRoot: root, captureProfile: profile, capture: adapter });
    current = await captureScraplingWorkerSource(src, { archiveRoot: root, captureProfile: profile, capture: adapter });
    expect(adapter).toHaveBeenCalledTimes(2);
  } else {
    [before, current] = documents.map((doc, index) => {
      const text = scraplingReviewText(doc);
      return { source: { id: src.id, shared_award_id: src.shared_award_id, url: src.url },
        capture_profile: profile, final_url: src.url, captured_at: timestamps[index], page_title: doc.title,
        text_hash: hash(normalizeVisibleText(text)), text,
        scrapling: { visible_title: doc.title, visible_text: doc.text, visible_text_sha256: hash(doc.text),
          visible_text_scope: "whole-visible-main-document", screenshot: { semantics_bracketed: true } } };
    });
  }
  const input = { source: src, baseline: before, previous: { ...before, meta: structuredClone(before) }, capture: current };
  const comparison = buildScraplingReviewDiff(input);
  expect(comparison).toMatchObject({ status: "changed_needs_review", reason: "complete_bounded_prose_change",
    publishable: false, baseline_advance_allowed: false });
  expect(comparison.diff.added_text).toEqual(changes.added_text);
  expect(comparison.diff.removed_text).toEqual(changes.removed_text);
  return { ...input, diff: structuredClone(comparison.diff), deterministic: comparison.deterministic, fixtureRoot: root };
}
function scraplingMixedCandidate(input) {
  return { shared_award_source_id: input.source.id, shared_award_id: input.source.shared_award_id,
    source_url: input.source.url, previous_text_hash: input.baseline.text_hash, new_text_hash: input.capture.text_hash,
    deterministic_diff: input.diff, prompt_payload: buildVisualReviewPromptPayload({ ...input,
      ...(input.fixtureRoot ? { archiveRelative: value => relative(input.fixtureRoot, value).replaceAll("\\", "/") } : {}) }) };
}

describe("mixed-primary admission replays the actual bounded Scrapling producer", () => {
  afterEach(() => {
    for (const directory of mixedFixtureDirectories.splice(0)) {
      // Remove only directories this test created inside the canonical tmp root.
      const target = resolve(directory), parent = resolve(mixedFixtureParent);
      if (!target.startsWith(parent + "\\mixed-primary-review-") && !target.startsWith(parent + "/mixed-primary-review-")) {
        throw new Error("unexpected_mixed_fixture_cleanup_path");
      }
      rmSync(target, { recursive: true, force: true });
    }
  });

  describe.each(scraplingProfiles)("%s", profile => {
    it("admits complete producer-backed mixed evidence without mutating or dropping foreign context", async () => {
      const input = await scraplingMixedPacket(profile), original = structuredClone(input);
      expect(classifyVisualReviewCandidate(input)).toMatchObject({ allowed: true,
        candidate_kind: "text_only", reason: "mixed_primary_source_content_requires_review" });
      const candidate = scraplingMixedCandidate(input);
      expect(candidate.deterministic_diff).toEqual(input.diff);
      expect(candidate.prompt_payload.deterministic_diff).toEqual(input.diff);
      expect(candidate.deterministic_diff.added_text[2]).toContain("Global Health Degree Program");
      expect(input).toEqual(original);
      expect(validateVisualBatchReview({ candidate, source: input.source, result: resultFor(input.diff) }))
        .toEqual({ allowed: true, reason: "approved" });
      if (profile === SOURCE_HTML_PROFILE) {
        expect(candidate.prompt_payload.include_images).toBe(false);
        expect(candidate.prompt_payload.previous_snapshot_ref.metadata.source_html.schema)
          .toBe("awardping.source-html-review-proof.v1");
      }
    });

    it.each([
      ["full context", input => { input.diff.scrapling_semantics.current_context.blocks[3].text += " Invented qualification."; }],
      ["directional text", input => { input.diff.added_text[0] += " Invented requirement."; }],
      ["source identity", input => { input.diff.source_context.source_url = "https://example.edu/another/"; }],
      ["pairing evidence", input => { input.diff.scrapling_semantics.evidence.current_text_hash = "f".repeat(64); }],
      ["reordered blocks", input => { input.diff.added_text.reverse(); input.diff.removed_text.reverse(); }],
    ])("rejects altered %s even when scope/complete flags and raw captures remain valid", async (_, mutate) => {
      const input = await scraplingMixedPacket(profile);
      mutate(input);
      expect(buildScraplingReviewDiff(input).status).toBe("changed_needs_review");
      expect(input.diff.candidate_scope).toBe("scrapling_html_source");
      expect(input.diff.scrapling_semantics.complete).toBe(true);
      expect(classifyVisualReviewCandidate(input)).toMatchObject({ allowed: false,
        label: "manual_review_required", reason: "mixed_primary_source_completeness_unverified" });
    });

    it("holds per-entry mixed content when the aggregate noise matcher misses it", async () => {
      const input = await scraplingMixedPacket(profile);
      // The primary deadline and GPA precede the foreign program. The aggregate
      // sibling-name match includes primary tokens, unlike the per-entry check.
      // A failed pair must not fall through to the strong deadline/GPA signal.
      expect(input.diff.added_text).toEqual(mixedDiff().added_text);
      expect(classifyVisualReviewCandidate(input).reason).toBe("mixed_primary_source_content_requires_review");
      delete input.previous;
      expect(classifyVisualReviewCandidate(input)).toMatchObject({ allowed: false,
        label: "manual_review_required", reason: "mixed_primary_source_completeness_unverified" });
    });

    it.each([
      ["missing previous text", input => { delete input.previous.text; }],
      ["changed current text", input => { input.capture.text += " Corruption"; }],
      ["wrong source", input => { input.capture.source.id = "another-source"; }],
      ["same capture time", input => { input.capture.captured_at = input.baseline.captured_at; }],
    ])("retains the original %s evidence hold despite a previously valid diff", async (_, mutate) => {
      const input = await scraplingMixedPacket(profile);
      mutate(input);
      expect(buildScraplingReviewDiff(input).status).not.toBe("changed_needs_review");
      expect(classifyVisualReviewCandidate(input).allowed).toBe(false);
    });

    it("does not treat scope and completeness assertions alone as capture authority", async () => {
      const input = await scraplingMixedPacket(profile);
      delete input.baseline; delete input.previous; delete input.capture;
      expect(classifyVisualReviewCandidate(input).allowed).toBe(false);
    });

    it.each([false, true])("rejects a correctly paired foreign fact, including a stripped name: %s", async stripName => {
      const input = await scraplingMixedPacket(profile), candidate = scraplingMixedCandidate(input);
      const result = resultFor(input.diff, [2]);
      if (stripName) for (const direction of ["before", "after"]) {
        result.changed_facts[0][direction] = result.changed_facts[0][direction].replace("Global Health Degree Program ", "");
      }
      expect(validateVisualBatchReview({ candidate, source: input.source, result }))
        .toEqual({ allowed: false, reason: "mixed_primary_source_fact_context_unverified" });
    });

    it("rejects a shared stripped quote even though each before/after pair is valid", async () => {
      const input = await scraplingMixedPacket(profile, { ambiguous: true }), candidate = scraplingMixedCandidate(input);
      const result = resultFor(input.diff, [0]);
      for (const direction of ["before", "after"]) {
        result.changed_facts[0][direction] = result.changed_facts[0][direction].replace("Yenching Academy ", "");
      }
      expect(validateVisualBatchReview({ candidate, source: input.source, result }))
        .toEqual({ allowed: false, reason: "mixed_primary_source_fact_context_unverified" });
    });

    it("rejects an extra foreign fact and foreign top-level quotation beside valid primary facts", async () => {
      const input = await scraplingMixedPacket(profile), candidate = scraplingMixedCandidate(input);
      for (const result of [resultFor(input.diff, [0, 2]),
        { ...resultFor(input.diff), exact_before: input.diff.removed_text[2], exact_after: input.diff.added_text[2] }]) {
        expect(validateVisualBatchReview({ candidate, source: input.source, result }))
          .toEqual({ allowed: false, reason: "mixed_primary_source_fact_context_unverified" });
      }
    });

    it("keeps directional pairing checks ahead of mixed-primary fact validation", async () => {
      const input = await scraplingMixedPacket(profile), candidate = scraplingMixedCandidate(input);
      const result = resultFor(input.diff, [0]);
      result.changed_facts[0].after = input.diff.added_text[2];
      expect(validateVisualBatchReview({ candidate, source: input.source, result }))
        .toEqual({ allowed: false, reason: "changed_facts_directional_pair_mismatch" });
    });

    it("keeps independent deterministic rejection and no-change review decisions", async () => {
      const input = await scraplingMixedPacket(profile);
      expect(classifyVisualReviewCandidate({ ...input, deterministic: { candidate_change: false, reason: "independent_hold" } }))
        .toMatchObject({ allowed: false, reason: "independent_hold" });
      expect(validateVisualBatchReview({ candidate: scraplingMixedCandidate(input), source: input.source,
        result: { is_true_change: false, is_alert_worthy: false, rejection_reason: "no_applicant_fact_change", changed_facts: [] } }))
        .toEqual({ allowed: false, reason: "no_applicant_fact_change" });
    });
  });

  it.each(["previous", "capture"])("requires the source-only %s raw response, not just sealed flags", async side => {
    for (const corrupt of [false, true]) {
      const input = await scraplingMixedPacket(SOURCE_HTML_PROFILE);
      if (corrupt) input[side].html += "<p>Not the retained response</p>";
      else delete input[side].html;
      expect(buildScraplingReviewDiff(input).status).toBe("unavailable");
      expect(classifyVisualReviewCandidate(input).allowed).toBe(false);
    }
  });

  it("rejects a source-only capsule with changed main context instead of borrowing the full-body context", async () => {
    const input = await scraplingMixedPacket(SOURCE_HTML_PROFILE);
    input.capture.source_html.capture.source_main_document.blocks[0].heading_path = [{ level: 2, text: "Another audience" }];
    expect(buildScraplingReviewDiff(input).status).not.toBe("changed_needs_review");
    expect(classifyVisualReviewCandidate(input).allowed).toBe(false);
  });

  it.each(["scrapling-evidence-v1", "scrapling-evidence-v2"])("retains %s visible-text and screenshot-pairing holds", async profile => {
    for (const mutate of [
      input => { input.capture.scrapling.visible_text += " Unverified visible text."; },
      input => { delete input.previous.meta.scrapling.visible_text; },
      input => { input.capture.scrapling.screenshot.semantics_bracketed = false; },
    ]) {
      const input = await scraplingMixedPacket(profile);
      mutate(input);
      expect(buildScraplingReviewDiff(input).status).not.toBe("changed_needs_review");
      expect(classifyVisualReviewCandidate(input).allowed).toBe(false);
    }
  });

  it("does not turn a source-only pairing mismatch into mixed-primary approval", async () => {
    const input = await scraplingMixedPacket(SOURCE_HTML_PROFILE), candidate = scraplingMixedCandidate(input);
    candidate.prompt_payload.previous_snapshot_ref.metadata.source_html.html_sha256 = "f".repeat(64);
    expect(validateVisualBatchReview({ candidate, source: input.source, result: resultFor(input.diff) }))
      .toEqual({ allowed: false, reason: "changed_facts_directional_pairing_unverified" });
  });
});

