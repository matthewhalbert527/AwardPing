import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildStableTextBlocks } from "./lib/capture-stability.mjs";
import { buildLegacyReviewCompleteness, buildLegacyParagraphReviewDiff, legacyReviewCompletenessLimits } from "./lib/legacy-review-completeness.mjs";

// Exercise actual worker declarations, never its CLI/main, network, archive,
// providers, queues or database. The fixture is public retained text only.
const code = readFileSync(new URL("./capture-visual-snapshots.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("capture.mjs", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ["buildDiffSummary", "excludedLegacyChangedUnits", "normalizeVisibleText", "isVolatileLine",
  "isVolatileOrBoilerplateFragment", "hasAwardRelevantTerms", "isProtectedAwardPageType", "sentenceCandidates",
  "splitChangeSentences", "protectSentenceAbbreviations", "restoreSentenceAbbreviations", "sentenceKey",
  "isUsefulChangedSentence", "contextualDatePhrases", "datePhrases", "isAwardDateContext", "contextualMoneyPhrases",
  "contextAroundMatch", "hasFundingAmountContext", "inferSection", "looksLikeRecipientNewsOrPressText",
  "looksLikeSourceAccessError", "normalizeText", "truncate", "dedupeText", "unique"];
const declarations = names.map(name => {
  const matches = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (matches.length !== 1) throw new Error(`Expected one actual declaration: ${name}`);
  return matches[0].getText(ast);
}).join("\n");
const context = vm.createContext({ Buffer, sentenceDotPlaceholder: "__AP_SENTENCE_DOT__",
  buildLegacyReviewCompleteness, buildLegacyParagraphReviewDiff, legacyReviewCompletenessLimits });
vm.runInContext(`${declarations}\nthis.api={${names.join(",")}}`, context);
const producer = context.api;
const fixture = JSON.parse(readFileSync(new URL("./fixtures/udall-date-context-20261022.json", import.meta.url), "utf8"));
const hash = value => createHash("sha256").update(value).digest("hex");
const source = { id: "offline-source", shared_award_id: "offline-award", url: "https://example.edu/award/apply",
  title: "Application requirements", page_type: "application", shared_awards: { name: "Example Award" } };
const diff = (before, after) => JSON.parse(JSON.stringify(producer.buildDiffSummary(before, after, source)));
const hints = (before, after) => diff(before, after).date_changes;
const evidence = result => [...result.added_text, ...result.removed_text].join("\n");

describe("retained date evidence, not factual approval", () => {
  it("pins both exact retained texts without inventing an original completeness proof", () => {
    expect(hash(fixture.previous_text)).toBe("418a3b08fb0af0c6e22c23b69391e22a567276f58c7549b97ffe62ec0ad2451e");
    expect(hash(fixture.current_text)).toBe("e5438729c3e8583b680e2844c96260bfe5e8b6eee21b63e9c64995b7f8d4ac9b");
    expect(fixture.provenance.candidate_id).toBe("ea2c913e-da9f-4c92-84a2-3d8153f1a3c3");
    expect(fixture).not.toHaveProperty("legacy_review_completeness");
  });

  it.each([false, true])("keeps period-only changes as text evidence, with no invented date hint (inverse=%s)", inverse => {
    const before = inverse ? fixture.current_text : fixture.previous_text;
    const after = inverse ? fixture.previous_text : fixture.current_text;
    const result = diff(before, after);
    expect(result.date_changes).toEqual([]);
    expect(result.added_text.length).toBeGreaterThan(0);
    expect(result.removed_text.length).toBeGreaterThan(0);
    expect(evidence(result)).toContain("May 12");
    expect(result.legacy_review_completeness.previous_text_sha256).toBe(hash(before));
    expect(result.legacy_review_completeness.current_text_sha256).toBe(hash(after));
  });

  it.each([false, true])("retains a real standalone date replacement with simultaneous periods=%s", punctuation => {
    const before = fixture.previous_text;
    const after = (punctuation ? fixture.current_text : before).replace("March 4, 2027", "March 5, 2027");
    const result = diff(before, after);
    expect(result.date_changes).toEqual(["Added March 5, 2027", "Removed March 4, 2027"]);
    expect(result.added_text.join("\n")).toContain("March 5, 2027");
    expect(result.removed_text.join("\n")).toContain("March 4, 2027");
    expect(result.legacy_review_completeness.previous_text_sha256).toBe(hash(before));
    expect(result.legacy_review_completeness.current_text_sha256).toBe(hash(after));
  });

  it("does not alter default capture normalization or repair already-lost input", () => {
    const text = "March 4, 2027\nApplications must be submitted by this date.";
    expect(producer.normalizeVisibleText(text)).toBe("Applications must be submitted by this date.");
    expect(producer.normalizeVisibleText(text, { preserveAbsoluteDates: true })).toBe(text);
    const lost = producer.normalizeVisibleText(text);
    expect(hints(lost, lost)).toEqual([]);
    // Ordinary HTML capture uses this separate existing normalizer, which does
    // retain the timeline date before it reaches the actual diff producer.
    const captured = buildStableTextBlocks({ rawText: text, mainText: text, expansionStates: [], profile: "stable-daily" });
    expect(captured.primary_text).toContain("March 4, 2027");
    expect(hints(captured.primary_text, captured.primary_text.replace("March 4", "March 5")))
      .toEqual(["Added March 5, 2027", "Removed March 4, 2027"]);
    // Only the two diff inputs opt in; PDF and all other capture/hash callers
    // retain their previous contract, including the documented PDF limitation.
    expect(code.match(/normalizeVisibleText\([^\n]+preserveAbsoluteDates: true/g)).toHaveLength(2);
  });
});

describe("date context stays local to every occurrence", () => {
  it.each([
    ["Application deadline March 1\nResults released May 12", "Application deadline March 1.\nResults released May 12."],
    ["Application deadline March 1 Results released May 12", "Application deadline March 1. Results released May 12."],
    ["Application deadline March 1 Results released May 12", "Application deadline March 2. Results released May 12."],
  ])("does not invent a May12 change from changed sentence membership", (before, after) => {
    const result = hints(before, after);
    expect(result.some(value => value.includes("May 12"))).toBe(false);
    if (after.includes("March 2")) expect(result).toEqual(["Added March 2", "Removed March 1"]);
    else expect(result).toEqual([]);
  });

  it.each([
    ["Application deadline May 12. Applicants must submit an essay.", "Applications are closed. Applicants must submit an essay."],
    ["Application deadline May 12. Campus picnic May 12 attracts visitors.", "Applications are closed. Campus picnic May 12 attracts visitors."],
    ["Application deadline May 12 is confirmed for all candidates.", "Campus celebration May 12 is confirmed for all visitors."],
  ])("preserves a genuine applicant-context removal, even if that date remains elsewhere", (before, after) => {
    expect(hints(before, after)).toEqual(["Removed May 12"]);
  });

  it("preserves a replacement when the old date survives in unrelated news", () => {
    expect(hints("Application deadline May 12. Campus picnic May 12 attracts visitors.",
      "Application deadline June 1. Campus picnic May 12 attracts visitors."))
      .toEqual(["Added June 1", "Removed May 12"]);
  });

  it("does not equate exchanged roles or independently match left and right context", () => {
    const result = diff("Application deadline May 12. Campus celebration June 1 attracts visitors.",
      "Campus celebration May 12 attracts visitors. Application deadline June 1.");
    expect(result.date_changes).toEqual(["Added June 1", "Removed May 12"]);
    expect(result.added_text.join("\n")).toContain("Application deadline June 1.");
  });

  it("retains duplicate occurrence evidence and the existing completeness hold", () => {
    const result = diff("Application deadline May 12. Application deadline May 12.", "Application deadline May 12.");
    expect(result.legacy_review_completeness.excluded_changed_units).toBeGreaterThan(0);
    const dates = "March 4, 2027\nApplication deadline for first round.\nMarch 4, 2027\nApplication deadline for second round.";
    expect(producer.normalizeVisibleText(dates, { preserveAbsoluteDates: true }).match(/March 4, 2027/g)).toHaveLength(2);
    expect(diff("March 4, 2027", "March 5, 2027").legacy_review_completeness.excluded_changed_units).toBeGreaterThan(0);
  });

  it("does not promote news dates or last-updated header dates to award hints", () => {
    expect(hints("News: Campus celebration May 12 attracts visitors.", "News: Campus celebration May 13 attracts visitors.")).toEqual([]);
    const body = "\nApplications require two recommendation letters.";
    expect(hints("Last updated: March 4, 2027" + body, "Last updated: March 5, 2027" + body)).toEqual([]);
  });

  it.each(["Last updated:", "Last updated", "UPDATED", "Last modified:", "Modified", "Retrieved:", "Retrieved",
    "Retrieved on", "Accessed", "Accessed on:", "Retrieval date", "Retrieval timestamp:", "Timestamp", "Current as of:", "As of", "Current date", "Local time:"])
    ("does not lend a multiline %s stamp to the following applicant sentence", label => {
      const before = `${label}\nMarch 4, 2027\nApplications must include an essay and recommendation.`;
      const after = before.replace("March 4", "March 5");
      const result = diff(before, after);
      expect(result.date_changes).toEqual([]);
      expect(result.added_text).toEqual([]);
      expect(result.removed_text).toEqual([]);
      expect(result.legacy_review_completeness.previous_text_sha256).toBe(hash(before));
      expect(result.legacy_review_completeness.current_text_sha256).toBe(hash(after));
    });

  it.each(["March 4, 2027 at 09:30 UTC", "March 4, 2027, 9:30 a.m. CDT", "2027-03-04T09:30:00Z", "2027-03-04T09:30:00-05:00", "03/04/2027", "09:30 UTC"])
    ("keeps an explicitly labelled timestamp out of applicant evidence: %s", value => {
      const before = `Retrieved:\n\n${value}\nApplications require two essays and a recommendation.`;
      const after = before.replace("09:30", "10:30").replace("9:30", "10:30").replace("March 4", "March 5").replace("03-04", "03-05").replace("03/04", "03/05");
      const result = diff(before, after);
      expect(result.date_changes).toEqual([]);
      expect(result.added_text).toEqual([]);
      expect(result.removed_text).toEqual([]);
      expect(result.legacy_review_completeness.previous_text_sha256).toBe(hash(before));
      expect(result.legacy_review_completeness.current_text_sha256).toBe(hash(after));
    });

  it.each(["Last updated", "Retrieved:", "Timestamp"])("does not hide a simultaneous real timeline change under %s", label => {
    const before = `${label}\nMarch 4, 2027\n\nApplications must include an essay and recommendation.\n\nApril 1, 2027\nApplications must be submitted by this date.`;
    const after = before.replace("March 4", "March 5").replace("April 1", "April 2");
    const result = diff(before, after);
    expect(result.date_changes).toEqual(["Added April 2, 2027", "Removed April 1, 2027"]);
    expect(result.added_text.join("\n")).toContain("April 2, 2027");
    expect(result.removed_text.join("\n")).toContain("April 1, 2027");
    expect(evidence(result)).not.toMatch(/March [45]/);
    expect(result.legacy_review_completeness.previous_text_sha256).toBe(hash(before));
    expect(result.legacy_review_completeness.current_text_sha256).toBe(hash(after));
  });

  it.each([
    "Last updated\nApplication deadline March 4, 2027 is confirmed for candidates.",
    "Application deadline last updated:\nMarch 4, 2027\nApplications must be submitted by this date.",
    "Last updated:\nMarch 1, 2027\nMarch 4, 2027\nApplications must be submitted by this date.",
    "March 4, 2027\nApplications must be submitted by this date.\nLast updated:\nMarch 1, 2027",
  ])("preserves inline facts, applicant-specific headings and dates beyond the one stamp value", before => {
    const after = before.replace("March 4", "March 5");
    const result = diff(before, after);
    expect(result.date_changes).toEqual(["Added March 5, 2027", "Removed March 4, 2027"]);
    expect(result.added_text.join("\n")).toContain("March 5, 2027");
    expect(result.removed_text.join("\n")).toContain("March 4, 2027");
  });

  it.each(["Last updated:", "Last updated", "Updated:", "Last modified:", "Modified", "Retrieved:", "Retrieved on", "Accessed", "Accessed on:",
    "Retrieval date", "Retrieval timestamp:", "Timestamp", "Current as of:", "As of", "Current date", "Local time:"])
    ("excludes only the inline %s stamp date from hints, not applicant text", label => {
      const before = `${label} March 4, 2027 Applications must include an essay and recommendation.`;
      const after = before.replace("March 4", "March 5");
      const result = diff(before, after);
      expect(result.date_changes).toEqual([]);
      expect(result.added_text.join("\n")).toContain("March 5, 2027 Applications must include an essay and recommendation.");
      expect(result.removed_text.join("\n")).toContain("March 4, 2027 Applications must include an essay and recommendation.");
      expect(result.legacy_review_completeness.previous_text_sha256).toBe(hash(before));
      expect(result.legacy_review_completeness.current_text_sha256).toBe(hash(after));
    });

  it.each(["2027-03-04", "03/04/2027", "Mar. 4, 2027"])("excludes an inline metadata %s occurrence without global value suppression", stamp => {
    const before = `Retrieved: ${stamp} Applications must include two essays. Application deadline ${stamp} is confirmed.`;
    const next = stamp.replace("03-04", "03-05").replace("03/04", "03/05").replace("4, 2027", "5, 2027");
    const stampOnly = before.replace(stamp, next);
    expect(hints(before, stampOnly)).toEqual([]);
    const actualDeadline = before.replace(`deadline ${stamp}`, `deadline ${next}`);
    expect(hints(before, actualDeadline)).toEqual([`Added ${next}`, `Removed ${stamp}`]);
  });

  it.each([" ", "\n"])("keeps real deadline replacements and reversals alongside metadata separator %j", separator => {
    const before = `Last updated:${separator}March 4, 2027${separator}Applications require an essay. Application deadline April 1, 2027 is confirmed.`;
    const after = before.replace("March 4", "March 5").replace("April 1", "April 2");
    expect(hints(before, after)).toEqual(["Added April 2, 2027", "Removed April 1, 2027"]);
    expect(hints(after, before)).toEqual(["Added April 1, 2027", "Removed April 2, 2027"]);
    const removed = before.replace("Application deadline April 1, 2027 is confirmed.", "The next application date is not yet announced.");
    expect(hints(before, removed)).toEqual(["Removed April 1, 2027"]);
    expect(hints(removed, before)).toEqual(["Added April 1, 2027"]);
  });

  it.each(["Application deadline last updated:", "Applicants must use documents last updated:"])
    ("does not mask a date under applicant-specific inline context %s", label => {
      const before = `${label} March 4, 2027 Applications require an essay and recommendation.`;
      const after = before.replace("March 4", "March 5");
      expect(hints(before, after)).toEqual(["Added March 5, 2027", "Removed March 4, 2027"]);
    });

  it("preserves real requirements and GPA changes following an inline stamp", () => {
    const before = "Last updated: March 4, 2027 Applications require a 3.5 GPA and two essays.";
    const after = "Last updated: March 5, 2027 Applications require a 3.7 GPA and three essays.";
    const result = diff(before, after);
    expect(result.date_changes).toEqual([]);
    expect(result.added_text.join("\n")).toContain("Applications require a 3.7 GPA and three essays.");
    expect(result.removed_text.join("\n")).toContain("Applications require a 3.5 GPA and two essays.");
  });
});

describe("date spelling, time and qualifier accuracy boundaries", () => {
  it.each(["Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec"])
    ("keeps %s abbreviation punctuation out of date hints, not out of text evidence", month => {
      const before = `Application deadline ${month}. 12, 2027 is confirmed for all candidates.`;
      const after = `Application deadline ${month} 12, 2027 is confirmed for all candidates.`;
      expect(hints(before, after)).toEqual([]);
      const result = diff(before, after.replace("12, 2027", "13, 2027"));
      expect(result.date_changes).toEqual([`Added ${month} 13, 2027`, `Removed ${month}. 12, 2027`]);
      expect(result.legacy_review_completeness.previous_text_sha256).toBe(hash(before));
    });

  it.each([
    ["Application deadline May 12, 2027 is confirmed.", "Application deadline May 12, 2028 is confirmed.", ["Added May 12, 2028", "Removed May 12, 2027"]],
    ["Application deadline 2027-05-12 is confirmed.", "Application deadline 2027-05-13 is confirmed.", ["Added 2027-05-13", "Removed 2027-05-12"]],
    ["Application deadline 05/12/2027 is confirmed.", "Application deadline 05/13/2027 is confirmed.", ["Added 05/13/2027", "Removed 05/12/2027"]],
  ])("preserves actual date values and years", (before, after, expected) => expect(hints(before, after)).toEqual(expected));

  it.each([
    ["Applications close May 12 at 11:59pm PT for all candidates.", "Applications close May 12 at 5:00pm PT for all candidates."],
    ["Applications close May 12 at 11:59pm PT for all candidates.", "Applications close May 12 at 11:59pm ET for all candidates."],
    ["Applications close May 12 only for returning applicants.", "Applications close May 12 for returning applicants."],
    ["Application deadline May 12 requires a 3.5 GPA.", "Application deadline May 12 requires a 3.7 GPA."],
  ])("never discards real time, timezone, qualifier or decimal edits when the date is unchanged", (before, after) => {
    const result = diff(before, after);
    expect(result.date_changes).toEqual([]);
    expect(result.added_text).toContain(after);
    expect(result.removed_text).toContain(before);
    expect(result.legacy_review_completeness.previous_text_sha256).toBe(hash(before));
    expect(result.legacy_review_completeness.current_text_sha256).toBe(hash(after));
  });
});
