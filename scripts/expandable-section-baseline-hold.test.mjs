import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalizeExpandableSections } from "./lib/expandable-section-identity.mjs";

const worker = readFileSync(new URL("./capture-visual-snapshots.mjs", import.meta.url), "utf8").replaceAll("\r\n", "\n");
function actualFunction(start, end) {
  const from = worker.indexOf(start), to = worker.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error("Actual worker function missing");
  return worker.slice(from, to);
}
const comparison = actualFunction("async function processExpandableSectionComparison(", "async function processOneSectionChange(");
const save = actualFunction("function saveReviewRecord(", "function saveRejectedRecord(");
const copy = actualFunction("function copyEvidenceFiles(", "function writeBaseline(");
const prune = actualFunction("function pruneTransientExpansionStateScreenshots(", "function isPathInside(");

// Execute the actual worker comparison and normal review writer using only an
// in-memory filesystem. Never import/run the worker entry point or real I/O.
function fixture({ promote = false, enabled = true, kind = "webpage", currentSections,
  previousSections = [], omitPreviousSections = false, failRecord = false,
  failHealth = false, writeResult = true } = {}) {
  const source = { id: "synthetic-section-source", url: "https://example.edu/award", shared_award_id: "synthetic-award" };
  const section = { section_key: "label-requirements", label: "Requirements", section_path: ["Applicants", "Requirements"],
    text: "Complete retained answer including an important final condition. ".repeat(70), text_hash: "c".repeat(64) };
  const baseline = { capture: { dir: "sources/synthetic-section-source/captures/old" }, text_hash: "a".repeat(64),
    image_hash: "b".repeat(64), main_content_hash: "a".repeat(64),
    summary_metadata: { baseline_facts: { existing: "preserve" }, baseline_facts_metadata: { provenance: "existing" } },
    ...(omitPreviousSections ? {} : { expandable_sections: previousSections }) };
  const previous = { text: "Complete old body. ".repeat(120), textPath: "old/text.txt", pagePath: "old/page.jpg",
    thumbPath: "old/thumb.jpg", htmlPath: "old/page.html.txt", sectionsTextPath: "old/sections.txt",
    sectionsJsonPath: "old/sections.json", metaPath: "old/meta.json" };
  const capture = { kind, dir: "sources/synthetic-section-source/captures/new", text: "Complete fresh body. ".repeat(120),
    text_hash: "d".repeat(64), image_hash: "e".repeat(64), main_content_hash: "d".repeat(64),
    expandable_sections: currentSections === undefined ? [section] : currentSections,
    text_path: "new/text.txt", page_path: "new/page.jpg", thumb_path: "new/thumb.jpg", html_path: "new/page.html.txt",
    sections_text_path: "new/sections.txt", sections_json_path: "new/sections.json", meta_path: "new/meta.json",
    expansion_state_screenshots: [{ page_path: "new/expansion-state-01.jpg", layout_path: "new/expansion-state-01-layout.json" }] };
  const report = { review: 0, review_paths: [], unchanged: 0, section_baseline_created: 0,
    expandable_section_identity_migrations: 0, expansion_screenshots_pruned: 0 };
  const files = new Map([
    [previous.textPath, previous.text], [previous.pagePath, "original page"], [previous.thumbPath, "original thumbnail"],
    [previous.htmlPath, "<main>Complete original HTML</main>"], [previous.sectionsTextPath, ""],
    [previous.sectionsJsonPath, JSON.stringify({ sections: previousSections })], [previous.metaPath, JSON.stringify(baseline)],
    [capture.text_path, capture.text], [capture.page_path, "fresh page"], [capture.thumb_path, "fresh thumbnail"],
    [capture.html_path, "<main>Complete fresh HTML and all closed answers</main>"],
    [capture.sections_text_path, (capture.expandable_sections || []).map(item => item.text).join("\n\n")],
    [capture.sections_json_path, JSON.stringify({ sections: capture.expandable_sections })],
    [capture.meta_path, JSON.stringify(capture)],
    ["new/expansion-state-01.jpg", "retained expansion screenshot"], ["new/expansion-state-01-layout.json", "retained expansion layout"],
  ].map(([path, value]) => [path, Buffer.from(value)]));
  const originals = new Map([...files].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const originalBaseline = structuredClone(baseline), originalPrevious = structuredClone(previous);
  const effects = Object.fromEntries(["writeBaseline", "requireR2SnapshotForBaseline", "markSharedSourceVisualCheckSucceeded",
    "enqueueVisualReviewCandidate", "gateVisualReviewCandidateForAi", "processOneSectionChange", "holdIncompleteLegacyReview",
    "finishSafeDeterministicNoise", "removeGeneratedCaptureDir", "rmSync", "mkdirSync"]
    .map(name => [name, vi.fn()]));
  effects.writeBaseline.mockReturnValue(writeResult);
  if (failHealth) effects.markSharedSourceVisualCheckSucceeded.mockRejectedValue(new Error("synthetic health failure"));
  const reviewDir = "reviews/synthetic-section-source/new", reviewPath = join(reviewDir, "review.json");
  const buildDiffSummary = vi.fn((before, after) => ({ removed_text: [before], added_text: [after], date_changes: [], amount_changes: [] }));
  const deps = { ...effects, promote, extractExpandableSections: enabled, canonicalizeExpandableSections,
    buildDiffSummary, toArchiveRelative: value => value.replaceAll("\\", "/"),
    sourceLabel: () => "Synthetic source", sourceMetadata: value => value,
    reviewDirForCapture: () => reviewDir, join, aiProvider: null, aiModel: null,
    existsSync: path => files.has(path),
    copyFileSync: vi.fn((from, to) => { files.set(to, Buffer.from(files.get(from))); }),
    writeFileSync: vi.fn((path, value) => {
      if (failRecord) throw new Error("synthetic review write failure");
      files.set(path, Buffer.from(value));
    }),
    console: { log: vi.fn() },
  };
  const funcs = new Function(...Object.keys(deps), `${save}\n${copy}\n${prune}\n${comparison}\nreturn { compare: processExpandableSectionComparison, prune: pruneTransientExpansionStateScreenshots };`)(...Object.values(deps));
  return { source, baseline, previous, capture, report, files, originals, originalBaseline, originalPrevious,
    effects, deps, reviewPath, buildDiffSummary,
    run: options => funcs.compare(source, baseline, previous, capture, report, options),
    prune: () => funcs.prune(capture, report) };
}

function expectNoBaselineOrAi(f) {
  for (const name of ["writeBaseline", "requireR2SnapshotForBaseline", "enqueueVisualReviewCandidate",
    "gateVisualReviewCandidateForAi", "processOneSectionChange", "holdIncompleteLegacyReview",
    "finishSafeDeterministicNoise", "removeGeneratedCaptureDir", "rmSync"])
    expect(f.effects[name], name).not.toHaveBeenCalled();
  expect(f.report).toMatchObject({ unchanged: 0, section_baseline_created: 0 });
  expect(f.baseline).toEqual(f.originalBaseline);
  expect(f.previous).toEqual(f.originalPrevious);
  for (const [path, bytes] of f.originals) expect(f.files.get(path), path).toEqual(bytes);
}

describe("actual first expandable-section baseline respects promotion control", () => {
  it.each([false, true])("retains a manual hold with missing previous sections=%s", async omitPreviousSections => {
    const f = fixture({ omitPreviousSections });
    expect(await f.run()).toEqual({ handled: true, reason: "section_baseline_requires_review" });
    expect(f.capture.persist_expansion_state_screenshots).toBe(true);
    expect(f.prune()).toBe(0);
    expectNoBaselineOrAi(f);
    expect(f.report).toMatchObject({ review: 1, review_paths: [f.reviewPath.replaceAll("\\", "/")] });
    expect(f.effects.markSharedSourceVisualCheckSucceeded).toHaveBeenCalledExactlyOnceWith(f.source, f.capture, f.report);
    expect(f.buildDiffSummary).toHaveBeenCalledExactlyOnceWith(f.previous.text, f.capture.text, f.source);
    const record = JSON.parse(f.files.get(f.reviewPath));
    expect(record).toMatchObject({ reason: "section_baseline_requires_review", ai_provider: "none", ai_result: null,
      previous_hashes: { text_hash: f.baseline.text_hash, image_hash: f.baseline.image_hash },
      new_hashes: { text_hash: f.capture.text_hash, image_hash: f.capture.image_hash },
      deterministic_classification: { classification: "manual_review_required", previous_section_baseline_available: false,
        comparison_complete: false, baseline_advance_allowed: false, retain_both_captures: true },
      deterministic_diff: { candidate_scope: "expandable_section_baseline", current_section_count: 1,
        removed_text: [f.previous.text], added_text: [f.capture.text] } });
    for (const [slot, original] of Object.entries({ previous_page: f.previous.pagePath, new_page: f.capture.page_path,
      previous_thumb: f.previous.thumbPath, new_thumb: f.capture.thumb_path, previous_text: f.previous.textPath, new_text: f.capture.text_path,
      previous_html: f.previous.htmlPath, new_html: f.capture.html_path, previous_sections_text: f.previous.sectionsTextPath,
      new_sections_text: f.capture.sections_text_path, previous_sections_json: f.previous.sectionsJsonPath,
      new_sections_json: f.capture.sections_json_path, previous_meta: f.previous.metaPath, new_meta: f.capture.meta_path })) {
      const copied = [...f.files.keys()].find(path => path.replaceAll("\\", "/") === record.files[slot]);
      expect(f.files.get(copied), slot).toEqual(f.originals.get(original));
    }
    expect(JSON.parse(f.files.get(f.capture.sections_json_path)).sections[0].text.length).toBeGreaterThan(4000);
  });

  it("leaves the explicit promote=true baseline creation and R2 path unchanged", async () => {
    const f = fixture({ promote: true });
    expect(await f.run()).toEqual({ handled: true, reason: "section_baseline_created" });
    expect(f.effects.writeBaseline).toHaveBeenCalledExactlyOnceWith(f.source, f.capture, {
      reason: "section_baseline_created", previous_baseline: f.baseline,
      baseline_facts: f.baseline.summary_metadata.baseline_facts,
      baseline_facts_metadata: f.baseline.summary_metadata.baseline_facts_metadata,
    });
    expect(f.effects.requireR2SnapshotForBaseline).toHaveBeenCalledExactlyOnceWith({ source: f.source, capture: f.capture,
      report: f.report, previousBaseline: f.baseline, reason: "section_baseline_created", unchanged: true });
    expect(f.report).toMatchObject({ section_baseline_created: 1, unchanged: 1, review: 0, review_paths: [] });
    expect(f.deps.writeFileSync).not.toHaveBeenCalled();
    expect(f.capture.persist_expansion_state_screenshots).toBeUndefined();
  });

  it.each([true, false])("preserves allowFirstBaseline=false continuation with promote=%s", async promote => {
    const f = fixture({ promote });
    expect(await f.run({ allowFirstBaseline: false })).toEqual({ handled: false, reason: "missing_section_baseline_visible_change_pending" });
    expectNoBaselineOrAi(f);
    expect(f.report.review).toBe(0);
    expect(f.deps.writeFileSync).not.toHaveBeenCalled();
    expect(f.effects.markSharedSourceVisualCheckSucceeded).not.toHaveBeenCalled();
  });

  it.each([{ enabled: false }, { kind: "pdf" }, { currentSections: [] }, { currentSections: null }])(
    "leaves disabled or missing-current-section paths unchanged: %j", async options => {
      const f = fixture(options);
      expect(await f.run()).toEqual({ handled: false, reason: options.enabled === false || options.kind === "pdf" ? "disabled" : "no_sections" });
      expectNoBaselineOrAi(f);
      expect(f.report.review).toBe(0);
      expect(f.deps.writeFileSync).not.toHaveBeenCalled();
      expect(f.effects.markSharedSourceVisualCheckSucceeded).not.toHaveBeenCalled();
    });

  it("does not intercept an existing unchanged section comparison", async () => {
    const f = fixture();
    f.baseline.expandable_sections = structuredClone(f.capture.expandable_sections);
    f.originalBaseline = structuredClone(f.baseline);
    expect(await f.run()).toEqual({ handled: false, reason: "sections_unchanged" });
    expectNoBaselineOrAi(f);
    expect(f.report.review).toBe(0);
    expect(f.deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("preserves the fresh capture and screenshots if normal review persistence fails", async () => {
    const f = fixture({ failRecord: true });
    await expect(f.run()).rejects.toThrow("synthetic review write failure");
    expect(f.capture.persist_expansion_state_screenshots).toBe(true);
    expect(f.prune()).toBe(0);
    expectNoBaselineOrAi(f);
    expect(f.report).toMatchObject({ review: 0, review_paths: [] });
    expect(f.effects.markSharedSourceVisualCheckSucceeded).not.toHaveBeenCalled();
  });

  it("retains the completed review and evidence if the later health update fails", async () => {
    const f = fixture({ failHealth: true });
    await expect(f.run()).rejects.toThrow("synthetic health failure");
    expect(f.capture.persist_expansion_state_screenshots).toBe(true);
    expect(f.prune()).toBe(0);
    expectNoBaselineOrAi(f);
    expect(f.report.review).toBe(1);
    expect(f.files.has(f.reviewPath)).toBe(true);
  });

  it("preserves the existing promote=true failure before R2 when a baseline cannot be written", async () => {
    const f = fixture({ promote: true, writeResult: false });
    await expect(f.run()).rejects.toThrow("The section baseline was older than the retained baseline.");
    expect(f.effects.requireR2SnapshotForBaseline).not.toHaveBeenCalled();
    expect(f.deps.writeFileSync).not.toHaveBeenCalled();
    expect(f.report).toMatchObject({ review: 0, unchanged: 0, section_baseline_created: 0 });
  });
});
