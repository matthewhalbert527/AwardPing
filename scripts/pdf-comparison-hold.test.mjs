import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { pdfTextComparisonHoldReason, assessPdfTextCoverage } from "./lib/pdf-text-coverage.mjs";
import { buildLegacyReviewCompleteness, legacyReviewCompletenessDecision } from "./lib/legacy-review-completeness.mjs";

const worker = readFileSync(new URL("./capture-visual-snapshots.mjs", import.meta.url), "utf8");
const start = worker.indexOf("async function processPdfComparison(");
const end = worker.indexOf("async function processInitialOfficialDocumentMaterializationOnly(", start);
const body = worker.slice(start, end);
const holdBody = worker.slice(worker.indexOf("async function holdIncompleteLegacyReview("), worker.indexOf("function classifyDeterministicChange("));
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const oldHash = "a".repeat(64), newHash = "b".repeat(64);
function coverage(hash, sparse = false) {
  return assessPdfTextCoverage({ total: 1, pages: [{ num: 1, text: sparse ? "page 1" : "Applicant requirements. ".repeat(10) }] }, hash);
}
function fixture({ textChanged = false, sameFile = false, oldCoverage = true, sparse = false, interpret = true, promote = true } = {}) {
  const sha = text => createHash("sha256").update(text).digest("hex");
  const before = "Applicants must submit the original essay materials for this award.";
  const after = textChanged ? "Applicants must submit the revised essay materials for this award." : before;
  const source = { id: "synthetic-pdf-source", url: "https://example.edu/award.pdf" };
  const baseline = { file_hash: oldHash, text_hash: sha(before) };
  const previous = { text: before, meta: { file_hash: oldHash, page_count: 1,
    ...(oldCoverage ? { pdf_text_coverage: coverage(oldHash) } : {}) } };
  const capture = { file_hash: sameFile ? oldHash : newHash, text_hash: sha(after),
    text: after, dir: "synthetic-dir", page_count: 1, pdf_text_coverage: coverage(newHash, sparse) };
  const report = { candidate_changes: 0, pdf_changed: 0, review: 0, review_paths: [], unchanged: 0, pdf_unchanged: 0 };
  const mocks = Object.fromEntries(["saveReviewRecord", "markSharedSourceVisualCheckSucceeded", "writeBaseline",
    "removeGeneratedCaptureDir", "enqueueVisualReviewCandidate", "maybeRepairMissingR2Snapshot", "gateVisualReviewCandidateForAi"]
    .map(name => [name, vi.fn()]));
  mocks.saveReviewRecord.mockReturnValue("synthetic-review.json");
  mocks.gateVisualReviewCandidateForAi.mockReturnValue({ allowed: true, deterministic: {} });
  const deps = { ...mocks, pdfTextComparisonHoldReason, jsonObjectOrEmpty: value => value || {}, legacyReviewCompletenessDecision,
    buildDiffSummary: (oldText, newText) => {
      const diff = { added_text: oldText === newText ? [] : [newText], removed_text: oldText === newText ? [] : [oldText], date_changes: [], amount_changes: [] };
      diff.legacy_review_completeness = buildLegacyReviewCompleteness({ source, previousText: oldText, currentText: newText, diff, excludedChangedUnits: 0 });
      return diff;
    }, toArchiveRelative: value => value,
    sourceLabel: () => "Synthetic PDF", console: { log: vi.fn() }, interpretVisualChanges: interpret,
    visualReviewMode: "batch", promote, keepUnchanged: false };
  const run = new AsyncFunction(...Object.keys(deps), "source", "baseline", "previous", "capture", "report",
    `${holdBody}\n${body}\nreturn processPdfComparison(source, baseline, previous, capture, report);`);
  return { mocks, report, run: () => run(...Object.values(deps), source, baseline, previous, capture, report) };
}

describe("actual PDF worker function with mocked effects, never importing the worker", () => {
  it.each([{ interpret: true, promote: true }, { interpret: false, promote: true }, { interpret: true, promote: false }])(
    "retains equal-text changed files on manual hold regardless of flags %j", async flags => {
      const f = fixture(flags); await f.run();
      expect(f.report).toMatchObject({ review: 1, pdf_changed: 1, review_paths: ["synthetic-review.json"] });
      expect(f.mocks.saveReviewRecord.mock.calls[0][0]).toMatchObject({ reason: "pdf_changed_bytes_same_text_requires_visual_review",
        deterministic: { baseline_advance_allowed: false } });
      for (const name of ["writeBaseline", "removeGeneratedCaptureDir", "enqueueVisualReviewCandidate", "gateVisualReviewCandidateForAi"])
        expect(f.mocks[name]).not.toHaveBeenCalled();
    });
  it.each([{ sparse: true }, { oldCoverage: false }])("holds uncertain page coverage %j", async flags => {
    const f = fixture({ ...flags, textChanged: true }); await f.run();
    expect(f.report.review).toBe(1);
    expect(f.mocks.enqueueVisualReviewCandidate).not.toHaveBeenCalled();
    expect(f.mocks.writeBaseline).not.toHaveBeenCalled();
    expect(f.mocks.removeGeneratedCaptureDir).not.toHaveBeenCalled();
  });
  it("leaves identical-file behavior unchanged", async () => {
    const f = fixture({ sameFile: true, oldCoverage: false }); await f.run();
    expect(f.report.pdf_unchanged).toBe(1);
    expect(f.mocks.saveReviewRecord).not.toHaveBeenCalled();
  });
  it("keeps valid text changes subject to the existing review gate", async () => {
    const f = fixture({ textChanged: true }); await f.run();
    expect(f.mocks.gateVisualReviewCandidateForAi).toHaveBeenCalledOnce();
    expect(f.mocks.enqueueVisualReviewCandidate).toHaveBeenCalledOnce();
    expect(f.mocks.writeBaseline).not.toHaveBeenCalled();
  });
  it("captures diagnostic metadata from the actual per-page parser result", () => {
    const extraction = worker.slice(worker.indexOf("async function extractPdfText("), worker.indexOf("async function captureSource("));
    expect(extraction).toContain("coverage: assessPdfTextCoverage(result, hashBuffer(buffer))");
    expect(worker).toContain("pdf_text_coverage: extracted.coverage");
  });
});
