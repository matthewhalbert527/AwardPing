import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildVisualReviewPromptText, changeDetailsFromVisualBatchResult as actualChangeDetails,
  normalizeVisualBatchResult, validateVisualBatchReview as actualValidate, visualReviewResponseSchema,
} from "./lib/visual-review-queue.mjs";
import { buildLegacyReviewCompleteness } from "./lib/legacy-review-completeness.mjs";
import { temporalContextAmbiguityDecision } from "./lib/visual-review-temporal-context.mjs";

const frozen = JSON.parse(readFileSync(new URL("./fixtures/visual-review-accuracy-20261018.json", import.meta.url), "utf8"));
const corrected = JSON.parse(readFileSync(new URL("./fixtures/visual-review-accuracy-corrected-20261018.json", import.meta.url), "utf8"));
const source = {
  id: "test-source", shared_award_id: "test-award", url: "https://example.edu/award/apply",
  title: "Test Award", page_type: "application", admin_review_status: "open",
  page_metadata_generated_at: "2026-07-08T00:00:00.000Z", page_metadata_model: "gemini-test",
  page_metadata: { baseline_facts: { award_relevance: "primary", cycle_relevance: "current_or_upcoming", quality_flags: [] } },
};
const oldText = "Application deadline: March 1, 2027";
const newText = "Application deadline: March 15, 2027";
const candidate = (diff = { removed_text: [oldText], added_text: [newText] }, images = false, synthetic = true) => ({
  synthetic_complete_packet: synthetic, deterministic_diff: diff, prompt_payload: { include_images: images },
});
// Only newly constructed synthetic cases receive producer proof. Retained
// historical packets below remain unchanged and cannot be retro-certified.
function completeSynthetic(c) {
  if (!c.synthetic_complete_packet || c.candidate_scope === "initial_official_document" || c.deterministic_diff?.candidate_scope === "scrapling_html_source") return c;
  const diff = { ...c.deterministic_diff };
  const fields = ["added_text", "removed_text", "date_changes", "amount_changes"];
  const previous = c.prompt_payload?.previous_text_excerpt ?? (diff.removed_text || []).join("\n");
  const current = c.prompt_payload?.new_text_excerpt ?? (diff.added_text || []).join("\n");
  const sha = value => crypto.createHash("sha256").update(value).digest("hex");
  diff.legacy_review_completeness = buildLegacyReviewCompleteness({ source, previousText: previous, currentText: current, diff, excludedChangedUnits: 0 });
  return { ...c, shared_award_source_id: source.id, source_url: source.url,
    previous_text_hash: sha(previous), new_text_hash: sha(current), deterministic_diff: diff,
    prompt_payload: { ...c.prompt_payload, deterministic_diff: diff, previous_text_excerpt: previous, new_text_excerpt: current,
      hashes: { previous_text_hash: sha(previous), new_text_hash: sha(current) },
      text_evidence: Object.fromEntries(fields.map(field => [field, diff[field] || []])) } };
}
const validateVisualBatchReview = args => actualValidate({ ...args, candidate: completeSynthetic(args.candidate) });
const changeDetailsFromVisualBatchResult = args => actualChangeDetails({ ...args, candidate: completeSynthetic(args.candidate) });
const result = (overrides = {}) => normalizeVisualBatchResult({
  is_true_change: true, is_alert_worthy: true, source_relevance: "primary", confidence: "high", noise_flags: [],
  changed_facts: [{ fact: "Application deadline", before: oldText, after: newText }],
  exact_before: oldText, exact_after: newText, ...overrides,
});
const check = (c, r) => validateVisualBatchReview({ candidate: c, source, result: r });
const details = (c, r) => changeDetailsFromVisualBatchResult({ candidate: c, source, result: r, model: "offline-regression" });

describe("strict directional change evidence", () => {
  it("requests one compact canonical fact array with explicit nullable evidence", () => {
    expect(visualReviewResponseSchema.properties).not.toHaveProperty("changed_award_facts");
    expect(visualReviewResponseSchema.properties.changed_facts.items.required).toEqual([
      "fact", "before", "after", "added_text", "removed_text", "visual_evidence",
    ]);
    const prompt = buildVisualReviewPromptText({});
    expect(prompt).toContain("never a second changed_award_facts array");
    expect(prompt).toContain("SAME changed block");
    expect(prompt).toContain("without ellipses");
  });

  it("never repairs a canonical fact-only/empty array from a richer legacy alias", () => {
    for (const canonical of [[], [{ fact: "Deadline changed", visual_evidence: null }]]) {
      const r = result({ changed_facts: canonical, changed_award_facts: [{ fact: "Deadline", before: oldText, after: newText }] });
      expect(r.changed_facts).toEqual(r.changed_award_facts);
      expect(check(candidate(), r).allowed).toBe(false);
      expect(details(candidate(), r).changed_facts).toEqual([]);
    }
    const legacy = result({ changed_facts: undefined });
    expect(legacy.changed_facts).toEqual([]);
    const absentCanonical = normalizeVisualBatchResult({ ...result(), changed_award_facts: [{ fact: "Deadline", before: oldText, after: newText }], changed_facts: null });
    expect(absentCanonical.changed_facts).toEqual([]);
    const raw = { is_true_change: true, is_alert_worthy: true, source_relevance: "primary", confidence: "high", changed_award_facts: [{ fact: "Deadline", before: oldText, after: newText }] };
    expect(check(candidate(), normalizeVisualBatchResult(raw)).allowed).toBe(true);
  });

  it.each([
    { before: oldText, after: newText, added_text: "An invented $50,000 funding offer" },
    { before: `Invented eligibility ... ${oldText}`, after: newText },
    { before: oldText, after: `Invented eligibility ... ${newText}` },
    { before: oldText, after: newText, removed_text: "Another unsupported claim" },
    { removed_text: oldText, visual_evidence: newText },
  ])("rejects every unsupported populated directional field and invented enclosing quote: %j", (fact) => {
    const r = result({ changed_facts: [{ fact: "Changed fact", ...fact }] });
    expect(check(candidate(), r)).toMatchObject({ allowed: false, reason: "changed_facts_not_supported_by_evidence" });
    expect(details(candidate(), r).changed_facts).toEqual([]);
    expect(details(candidate(), r).reader_summary).toBe("Change details require review.");
  });

  it.each([{ removed_text: oldText }, { added_text: newText }])("does not describe a replacement as a one-sided change: %j", (fact) => {
    const r = result({ changed_facts: [{ fact: "Deadline", ...fact }] });
    expect(check(candidate(), r)).toMatchObject({ allowed: false, reason: "changed_facts_incomplete_directional_evidence" });
    expect(details(candidate(), r).reader_summary).not.toMatch(/now includes|no longer includes/);
  });

  it("rejects an unchanged excerpt even when it occurs in both changed chunks", () => {
    const r = result({ changed_facts: [{ fact: "Deadline", before: "Application deadline", after: "APPLICATION DEADLINE" }] });
    expect(check(candidate(), r).allowed).toBe(false);
  });

  it("preserves genuine addition, removal, initial-document and screenshot-only paths", () => {
    const added = candidate({ added_text: [newText], removed_text: [] });
    const addResult = result({ changed_facts: [{ fact: "Deadline added", added_text: newText }], exact_before: null });
    expect(check(added, addResult).allowed).toBe(true);
    expect(details(added, addResult).reader_summary).toContain("now includes");
    const removed = candidate({ removed_text: [oldText], added_text: [] });
    const removeResult = result({ changed_facts: [{ fact: "Deadline removed", removed_text: oldText }], exact_after: null });
    expect(check(removed, removeResult).allowed).toBe(true);
    expect(details(removed, removeResult).reader_summary).toContain("no longer includes");
    // Initial-document evidence has the same true one-sided directional shape;
    // the separate document-scope/provenance validator remains unchanged.
    expect(details(added, addResult).changed_facts[0].before).toBeNull();
    const visual = candidate({ added_text: [], removed_text: [] }, true);
    const visualResult = result({ exact_before: null, exact_after: null, changed_facts: [{ fact: "Application deadline", visual_evidence: "Deadline row changed in the supplied images." }] });
    expect(check(visual, visualResult).allowed).toBe(true);
    expect(details(visual, visualResult).changed_facts[0].visual_evidence).toBeTruthy();
    expect(check(candidate({ added_text: [], removed_text: [] }), visualResult).allowed).toBe(false);
  });

  it("preserves legacy multi-chunk pairs but requires each populated side to be exact", () => {
    const before = ["2026 Eligibility Requirements", "2025-2026 academic year", "between December 2026 and August 2027."];
    const after = ["2027 Eligibility Requirements", "2026-2027 academic year", "between December 2027 and August 2028."];
    const c = candidate({ removed_text: before, added_text: after });
    const r = result({ exact_before: before[0], exact_after: after[0], changed_facts: before.map((text, index) => ({ fact: "Eligibility cycle", removed_text: text, added_text: after[index] })) });
    expect(check(c, r).allowed).toBe(true);
    const publicResult = details(c, r);
    for (const value of after) expect(publicResult.reader_summary).toContain(value);
    expect(publicResult.reader_summary).not.toContain("no longer includes");
  });

  it("enforces the same corroborated Scrapling block instead of cross-associating two changes", () => {
    const diff = { candidate_scope: "scrapling_html_source", removed_text: [oldText, "Award amount: $1,000"], added_text: [newText, "Award amount: $2,000"],
      scrapling_semantics: { version: 2, complete: true, visible_prose_corroborated: true, changed_block_indices: [1, 4],
        previous_source_prose: `${oldText}. Award amount: $1,000`, current_source_prose: `${newText}. Award amount: $2,000` } };
    const good = result({ changed_facts: [{ fact: "Deadline", before: oldText, after: newText }, { fact: "Funding", before: "Award amount: $1,000", after: "Award amount: $2,000" }] });
    expect(check(candidate(diff), good).allowed).toBe(true);
    const cross = result({ changed_facts: [{ fact: "Change", before: oldText, after: "Award amount: $2,000" }] });
    expect(check(candidate(diff), cross)).toMatchObject({ allowed: false, reason: "changed_facts_directional_pair_mismatch" });
    for (const indices of [undefined, [1, 1], [-1, 4], [1]]) {
      const broken = { ...diff, scrapling_semantics: { ...diff.scrapling_semantics, changed_block_indices: indices } };
      expect(check(candidate(broken), good)).toMatchObject({ allowed: false, reason: "changed_facts_directional_pairing_unverified" });
    }
  });

  it("does not mistake expanded eligibility for expanded UI while retaining UI-noise rejection", () => {
    expect(check(candidate(), result({ reader_summary: "Eligibility expanded and the deadline changed." })).allowed).toBe(true);
    for (const summary of ["The expanded menu changed.", "The accordion was expanded.", "The panel collapsed.", "The layout changed."]) {
      expect(check(candidate(), result({ reader_summary: summary }))).toMatchObject({ allowed: false, reason: "known_noise_pattern" });
    }
  });
});

describe("conservative temporal-context ambiguity, not a deadline-conflict determination", () => {
  const hash = text => crypto.createHash("sha256").update(text).digest("hex");
  const old = "Prose deadline: 12:00am UK time";
  const next = "Prose deadline: 11:59pm UK time";
  const previous = `Table deadline: 11:59pm UK time. ${old}`;
  const current = `Table deadline: 11:59pm UK time. ${next}`;
  const fact = { fact: "Deadline", before: old, after: next, removed_text: old, added_text: next };
  const temporalResult = result({ changed_facts: [fact], exact_before: old, exact_after: next });
  const legacy = () => ({ ...candidate({ removed_text: [old], added_text: [next] }), prompt_payload: {
    include_images: false, previous_text_excerpt: previous, new_text_excerpt: current,
  } });
  const scrapling = version => {
    const c = legacy();
    c.prompt_payload.previous_text_excerpt = ""; c.prompt_payload.new_text_excerpt = "";
    c.deterministic_diff.candidate_scope = "scrapling_html_source";
    const start = current.indexOf(next);
    c.deterministic_diff.scrapling_semantics = {
      version, complete: true, visible_prose_corroborated: true, changed_block_indices: [1],
      current_source_prose: current, ...(version === 2 ? { previous_source_prose: previous } : {
        source_context_complete: true, previous_source_prose_reconstructable: true,
        context_table_reconstruction_verified: true,
        previous_prose_replacement_offsets: "utf16_code_units_into_current_source_prose",
        current_source_prose_sha256: hash(current), previous_source_prose_sha256: hash(previous),
        previous_prose_replacements: [{ change_index: 0, current_start: start, current_end: start + next.length, previous_text: old }],
      }),
    };
    return c;
  };

  it("holds a time already present in unchanged legacy source text, without inventing which statement prevails", () => {
    expect(check(legacy(), temporalResult)).toMatchObject({ allowed: false, reason: "temporal_value_already_in_unchanged_context" });
    expect(details(legacy(), temporalResult).changed_facts).toEqual([]);
    expect(details(legacy(), temporalResult).reader_summary).toBe("Change details require review.");
  });

  it.each([2, 3, 4])("checks complete Scrapling v%i prose with the same conservative result", version => {
    expect(check(scrapling(version), temporalResult)).toMatchObject({ allowed: false, reason: "temporal_value_already_in_unchanged_context" });
  });

  it("does not accept corrupt or incomplete reconstruction as a clean-context result", () => {
    for (const mutate of [s => { s.current_source_prose_sha256 = "0".repeat(64); }, s => { s.previous_source_prose_sha256 = "0".repeat(64); },
      s => { s.previous_prose_replacements[0].current_end++; }, s => { s.previous_prose_replacements[0].previous_text = "invented"; },
      s => { s.previous_prose_replacements.push(s.previous_prose_replacements[0]); }]) {
      const c = scrapling(4); mutate(c.deterministic_diff.scrapling_semantics);
      expect(check(c, temporalResult)).toMatchObject({ allowed: false, reason: "temporal_context_not_verifiable" });
    }
  });

  it("allows a genuinely new date or time and does not match just numbers, years, month substrings or another timezone", () => {
    const c = candidate();
    c.prompt_payload.previous_text_excerpt = `The 2027 cycle has 15 awards. Marching 15 troops. ${oldText}`;
    c.prompt_payload.new_text_excerpt = `The 2027 cycle has 15 awards. Marching 15 troops. ${newText}`;
    expect(check(c, result()).allowed).toBe(true);
    const clockCandidate = legacy();
    clockCandidate.prompt_payload.previous_text_excerpt = `Other round: 11:59pm PT. ${old}`;
    clockCandidate.prompt_payload.new_text_excerpt = `Other round: 11:59pm PT. ${next}`;
    expect(check(clockCandidate, temporalResult).allowed).toBe(true);
    expect(temporalContextAmbiguityDecision({ candidate: legacy(), facts: [{ before: "2026", after: "2027" }] }).allowed).toBe(true);
  });

  it("requires occurrences outside accounted changes on both sides, not an occurrence in another changed block", () => {
    const c = legacy();
    c.deterministic_diff.removed_text.push("Table deadline: 11:59pm UK time");
    c.deterministic_diff.added_text.push("Table deadline: 10:00pm UK time");
    c.prompt_payload.new_text_excerpt = `Table deadline: 10:00pm UK time. ${next}`;
    expect(check(c, temporalResult).allowed).toBe(true);
    // Separate rounds with identical retained values are intentionally held when
    // this packet cannot establish audience scope; the guard makes no conflict claim.
    const uncertain = legacy();
    uncertain.prompt_payload.previous_text_excerpt = `Another round: 11:59pm UK time. ${old}`;
    uncertain.prompt_payload.new_text_excerpt = `Another round: 11:59pm UK time. ${next}`;
    expect(check(uncertain, temporalResult).reason).toBe("temporal_value_already_in_unchanged_context");
  });

  it("covers full calendar dates but not bare year reuse", () => {
    const c = candidate();
    c.prompt_payload.previous_text_excerpt = `Award reference date: March 15, 2027. ${oldText}`;
    c.prompt_payload.new_text_excerpt = `Award reference date: March 15, 2027. ${newText}`;
    expect(check(c, result()).reason).toBe("temporal_value_already_in_unchanged_context");
  });
});

describe("corrected replay frozen outputs, reevaluated offline without a new provider request", () => {
  it("preserves hashes and holds actual corrected Gates while keeping both synthetic v4 answers useful", () => {
    expect(corrected.plan_sha256).toBe("01dbb5e36e96e45718056295aaecf554d442e96f1a3be2139fb5751a2d1d2fce");
    for (const c of corrected.cases) for (const role of ["fleet", "strong"]) {
      const answer = c[role];
      expect(crypto.createHash("sha256").update(answer.output).digest("hex")).toBe(answer.sha256);
      expect(answer.finish).toBe("STOP");
      const input = candidate(c.diff, false, c.id.includes("synthetic"));
      input.prompt_payload.previous_text_excerpt = c.previous_text;
      input.prompt_payload.new_text_excerpt = c.current_text;
      const reviewed = normalizeVisualBatchResult(answer.output);
      const validation = check(input, reviewed);
      if (c.id.includes("synthetic")) {
        expect(validation.allowed).toBe(true);
        const publicResult = details(input, reviewed);
        expect(publicResult.reader_summary).toContain("November 15, 2027");
        expect(publicResult.reader_summary).toContain("Juniors and seniors");
      } else {
        expect(validation.allowed).toBe(false);
        expect(details(input, reviewed).changed_facts).toEqual([]);
      }
      if (c.id.includes("gates") && role === "strong") {
        expect(validation.reason).toBe("legacy_review_completeness_missing");
        // Separately labelled synthetic reconstruction exercises temporal
        // grounding; it does not certify the historical producer packet.
        const synthetic = candidate(structuredClone(c.diff));
        synthetic.prompt_payload.previous_text_excerpt = c.previous_text;
        synthetic.prompt_payload.new_text_excerpt = c.current_text;
        expect(check(synthetic, reviewed).reason).toBe("temporal_value_already_in_unchanged_context");
      }
    }
  });
});

describe("immutable October 18 provider regressions, not a new model evaluation", () => {
  it("keeps original outputs hash-bound and preserves requested/returned strong identity mismatch", () => {
    expect(frozen.plan_sha256).toBe("1b21b5adbba1f87290c8a604ec3c45728f19cb30df8acc0227531d5958b9db61");
    for (const c of frozen.cases) {
      for (const answer of [c.fleet, c.strong]) if (answer.output !== null) {
        expect(crypto.createHash("sha256").update(answer.output).digest("hex")).toBe(answer.output_sha256);
      }
      expect(c.strong.requested_model).toBe("gemini-3.7-flash");
      expect(c.strong.returned_model).toBe("gemini-3.8-flash");
    }
    expect(frozen.cases[2].fleet.finish_reason).toBe("MAX_TOKENS");
    expect(frozen.cases[2].fleet.output).toBeNull();
  });

  it("holds the unchanged/ambiguous Gates and incomplete/overquoted Beinecke outputs without repairing them", () => {
    for (const c of frozen.cases.slice(0, 2)) for (const answer of [c.fleet, c.strong]) {
      const r = normalizeVisualBatchResult(answer.output);
      const historical = candidate(c.diff, false, false);
      expect(check(historical, r)).toMatchObject({ allowed: false, manual_review_required: true, reason: "legacy_review_completeness_missing" });
      expect(details(historical, r).reader_summary).not.toContain("no longer includes");
    }
  });

  it("accepts the exact supplied synthetic v4 directional evidence and preserves both new facts in public claims", () => {
    const c = frozen.cases[2];
    expect(c.diff.scrapling_semantics.version).toBe(4);
    expect(c.diff.scrapling_semantics.context_table_reconstruction_verified).toBe(true);
    const r = normalizeVisualBatchResult(c.strong.output);
    expect(check(candidate(c.diff), r)).toMatchObject({ allowed: true, reason: "approved" });
    const publishedShape = details(candidate(c.diff), r);
    expect(publishedShape.reader_summary).toContain("November 15, 2027");
    expect(publishedShape.reader_summary).toContain("Juniors and seniors");
    expect(publishedShape.reader_summary).toContain("U.S. applicants");
    expect(publishedShape.reader_summary).not.toContain("no longer includes");
    expect(publishedShape.public_claims_provenance.model_narrative_published).toBe(false);
    // This checks the returned 3.8 text against local code, not a new successful
    // 3.7 replay, actual capture, billing request or publication authorization.
  });
});
