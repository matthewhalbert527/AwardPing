import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnSync } from "./test-support/bounded-test-process.mjs";
import { compareHtmlDocuments, validateHtmlDocument } from "./analyze-scrapling-html.mjs";
import { accuracyReviewInput } from "./lib/scrapling-accuracy-fixtures.mjs";
import { buildScraplingReviewDiff } from "./lib/scrapling-review-diff.mjs";

// Real Python extraction + real JS validation/formatting/review routing. All HTML
// and visible-text assertions here are fabricated fixtures, NOT browser captures
// or real award facts. No collector, credentials, provider, queue or DB is used.
const sourceUrl = "https://example.org/synthetic-award";
const parser = fileURLToPath(new URL("./scrapling/html_document.py", import.meta.url));
const explicitPython = process.env.AWARDPING_SCRAPLING_TEST_PYTHON;
const python = explicitPython || fileURLToPath(new URL("../tmp/scrapling-runtime/Scripts/python.exe", import.meta.url));
const cache = new Map();

function extract(body) {
  if (!cache.has(body)) {
    const env = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "COMSPEC", "PATHEXT"]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    env.PYTHONUTF8 = "1";
    const result = spawnSync(python, ["-B", parser], {
      env, shell: false, timeout: 15000,
      input: JSON.stringify({ url: sourceUrl, html: `<!doctype html><html><head><title>Fictional Test Award</title></head><body>${body}</body></html>` }),
    });
    expect(result.error, "Python parser must complete within the test deadline").toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    cache.set(body, validateHtmlDocument(JSON.parse(result.stdout), { sourceUrl }));
  }
  return structuredClone(cache.get(body));
}

function review(beforeHtml, afterHtml, options) {
  const before = extract(beforeHtml), after = extract(afterHtml);
  const comparison = compareHtmlDocuments(before, after);
  const result = buildScraplingReviewDiff(accuracyReviewInput(before, after, options));
  expect(result.publishable).toBe(false);
  expect(result.baseline_advance_allowed).toBe(false);
  expect(result.screenshot_alignment).toBe("not_verified");
  if (result.status !== "unchanged") expect(result.retain_both_captures).toBe(true);
  return { before, after, comparison, result };
}

// A missing optional local runtime skips this entire integration group visibly.
// An explicitly requested missing/broken interpreter fails, never silently skips.
describe.skipIf(!explicitPython && !existsSync(python))("real Scrapling parser to review contract (synthetic offline HTML)", () => {
  it("keeps a complete visible deadline edit eligible for review, not publication", () => {
    const { result } = review("<h1>Eligibility</h1><p>Apply by October 1, 2027.</p>",
      "<h1>Eligibility</h1><p>Apply by November 1, 2027.</p>");
    expect(result.status).toBe("changed_needs_review");
    expect(result.diff.removed_text).toEqual(["Apply by October 1, 2027."]);
    expect(result.diff.added_text).toEqual(["Apply by November 1, 2027."]);
  });

  it("keeps distinct applicant-group context on a deadline edit", () => {
    const before = "<h2>U.S. applicants</h2><p>Apply by October 1, 2027.</p><h2>International applicants</h2><p>Apply by December 1, 2027.</p>";
    const { result, after } = review(before, before.replace("October 1", "November 1"));
    expect(result.status).toBe("changed_needs_review");
    expect(after.blocks.find(block => block.text === "Apply by November 1, 2027.").heading_path)
      .toEqual([{ level: 2, text: "U.S. applicants" }]);
  });

  it("holds a changed hidden rule even when its wording is fully extracted", () => {
    const before = "<p>Applications are welcome.</p><section hidden><p>Apply by October 1, 2027.</p></section>";
    const { after, result } = review(before, before.replace("October 1", "November 1"), {
      previousVisible: "Applications are welcome.", currentVisible: "Applications are welcome.",
    });
    expect(after.text).toContain("Apply by November 1, 2027.");
    expect(result).toMatchObject({ status: "manual_review_required", reason: "changed_block_not_uniquely_visible", diff: null });
  });

  it("does not silently ignore prose outside semantic blocks", () => {
    const before = "<p>Applicants must be juniors.</p><div>Deadline October 1, 2027.</div>";
    const { result } = review(before, before.replace("October 1", "November 1"));
    expect(result).toMatchObject({ status: "manual_review_required", reason: "prose_change_has_no_complete_changed_block" });
  });

  it("holds changed links even when the displayed wording did not change", () => {
    const before = '<p><a href="/apply-2027.pdf">Read application rules.</a></p>';
    const { result, comparison } = review(before, before.replace("2027.pdf", "2028.pdf"));
    expect(comparison.status).toBe("changed_needs_review");
    expect(result).toMatchObject({ status: "manual_review_required", reason: "structural_only_change" });
  });

  it("preserves a table's audience and holds context-bearing cell changes", () => {
    const before = "<table><tr><th>U.S. applicants</th><td>October 1, 2027</td></tr></table>";
    const { after, result } = review(before, before.replace("October 1", "November 1"));
    expect(after.blocks.find(block => block.kind === "td").table_row).toEqual(["U.S. applicants", "November 1, 2027"]);
    expect(result.status).toBe("manual_review_required");
  });

  it("detects identical answer text moved outside its FAQ question", () => {
    const { before, after, result, comparison } = review(
      "<details><summary>U.S. applicants</summary><p>The deadline is October 1.</p></details>",
      "<details><summary>U.S. applicants</summary></details><p>The deadline is October 1.</p>");
    expect(before.text).toBe(after.text);
    expect(before.blocks.find(block => block.kind === "p").details_path).toEqual(["U.S. applicants"]);
    expect(after.blocks.find(block => block.kind === "p")).not.toHaveProperty("details_path");
    expect(comparison.status).toBe("changed_needs_review");
    expect(result).toMatchObject({ status: "manual_review_required", reason: "structural_only_change" });
  });

  it("detects an identical application link moved outside its FAQ question", () => {
    const { before, after, result } = review(
      '<details><summary>U.S. applicants</summary><a href="/apply">Application form</a></details>',
      '<details><summary>U.S. applicants</summary></details><a href="/apply">Application form</a>');
    expect(before.text).toBe(after.text);
    expect(before.links[0].details_path).toEqual(["U.S. applicants"]);
    expect(after.links[0]).not.toHaveProperty("details_path");
    expect(result.status).toBe("manual_review_required");
  });

  it("does not mistake opening the same FAQ for an award change", () => {
    const before = "<details><summary>U.S. applicants</summary><p>Apply by October 1, 2027.</p></details>";
    const { result, comparison } = review(before, before.replace("<details>", "<details open>"));
    expect(comparison.status).toBe("unchanged");
    expect(result.status).toBe("unchanged");
  });

  it("requires the same FAQ question to corroborate a visible answer edit", () => {
    const before = "<details><summary>U.S. applicants</summary><p>Apply by October 1, 2027.</p></details>";
    const { result } = review(before, before.replace("October 1", "November 1"), {
      previousVisible: "International applicants Apply by October 1, 2027.",
      currentVisible: "International applicants Apply by November 1, 2027.",
    });
    expect(result).toMatchObject({ status: "manual_review_required", reason: "changed_block_context_not_uniquely_visible" });
  });

  it("retains the matching FAQ question when a complete answer edit is review-eligible", () => {
    const before = "<details><summary>U.S. applicants</summary><p>Apply by October 1, 2027.</p></details>";
    const { result } = review(before, before.replace("October 1", "November 1"));
    expect(result.status).toBe("changed_needs_review");
    expect(result.diff.scrapling_semantics.current_context.blocks.find(block => block.kind === "p").details_path)
      .toEqual(["U.S. applicants"]);
  });

  it("holds an unlabeled-details answer instead of inventing an audience", () => {
    const before = "<details><p>Apply by October 1, 2027.</p></details>";
    const { after, result } = review(before, before.replace("October 1", "November 1"));
    expect(after.blocks[0].details_path).toEqual([""]);
    expect(result).toMatchObject({ status: "manual_review_required", reason: "changed_block_context_not_uniquely_visible" });
  });

  it("ignores non-content scripts while retaining source-context integrity", () => {
    const before = "<p>Apply by October 1, 2027.</p><script>var updated = 1;</script>";
    const { result } = review(before, before.replace("updated = 1", "updated = 2"));
    expect(result.status).toBe("unchanged");
  });
});
