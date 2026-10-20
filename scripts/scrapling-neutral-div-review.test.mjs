import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnSync } from "./test-support/bounded-test-process.mjs";
import { validateHtmlDocument } from "./analyze-scrapling-html.mjs";
import { accuracyReviewInput } from "./lib/scrapling-accuracy-fixtures.mjs";
import { buildScraplingReviewDiff } from "./lib/scrapling-review-diff.mjs";

// Fabricated HTML only. These are offline parser/review probes, NOT browser
// captures, actual website changes, provider responses or publication authority.
const sourceUrl = "https://example.org/neutral-div-fixture";
const parser = fileURLToPath(new URL("./scrapling/html_document.py", import.meta.url));
const explicitPython = process.env.AWARDPING_SCRAPLING_TEST_PYTHON;
const python = explicitPython || fileURLToPath(new URL("../tmp/scrapling-runtime/Scripts/python.exe", import.meta.url));
const v2 = "scrapling-evidence-v2", cache = new Map();

function extract(body, profile = v2) {
  const key = JSON.stringify([body, profile]);
  if (!cache.has(key)) {
    const env = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "COMSPEC", "PATHEXT"]
      .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
    env.PYTHONUTF8 = "1";
    const result = spawnSync(python, ["-B", parser], { env, shell: false, timeout: 15000,
      input: JSON.stringify({ html: `<!doctype html><html><head><title>Fictional Award</title></head><body>${body}</body></html>`,
        url: sourceUrl, ...(profile === v2 ? { capture_profile: v2 } : {}) }) });
    expect(result.error, "bounded offline Python extraction").toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    cache.set(key, validateHtmlDocument(JSON.parse(result.stdout), { sourceUrl }));
  }
  return structuredClone(cache.get(key));
}

function review(beforeBody, afterBody, options = {}) {
  const profile = options.profile || v2;
  const before = extract(beforeBody, profile), after = extract(afterBody, profile);
  const input = accuracyReviewInput(before, after, { sourceIdentity: {
    id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222", url: sourceUrl,
  }, previousProfile: profile, currentProfile: profile, ...options });
  const result = buildScraplingReviewDiff(input);
  expect(result).toMatchObject({ publishable: false, baseline_advance_allowed: false, screenshot_alignment: "not_verified" });
  if (result.status !== "unchanged") expect(result.retain_both_captures).toBe(true);
  return { before, after, input, result };
}

describe.skipIf(!explicitPython && !existsSync(python))("opt-in neutral DIV parser to complete review (synthetic offline HTML)", () => {
  it("keeps v1's bare-DIV hold and makes the same complete edit reviewable only in v2", () => {
    const before = "<h1>Eligibility</h1><p>Applicants must be juniors.</p><div>Deadline October 1, 2027.</div>";
    const after = before.replace("October 1", "November 1");
    expect(review(before, after, { profile: "scrapling-evidence-v1" }).result)
      .toMatchObject({ status: "manual_review_required", reason: "prose_change_has_no_complete_changed_block" });
    const { result } = review(before, after);
    expect(result).toMatchObject({ status: "changed_needs_review", reason: "complete_bounded_prose_change" });
    expect(result.diff.removed_text).toEqual(["Deadline October 1, 2027."]);
    expect(result.diff.added_text).toEqual(["Deadline November 1, 2027."]);
  }, 60000);

  it("retains the whole inline/BR answer once with its existing source heading", () => {
    const before = "<h2>U.S. applicants</h2><div>Apply by <strong>October 1, 2027.</strong><br>References are required.</div>";
    const { after, result } = review(before, before.replace("October 1", "November 1"));
    expect(after.blocks.filter(block => block.kind === "div")).toEqual([{ kind: "div",
      text: "Apply by November 1, 2027. References are required.", heading_path: [{ level: 2, text: "U.S. applicants" }], list_path: [], table_row: [] }]);
    expect(result.status).toBe("changed_needs_review");
  });

  it("keeps hidden answer changes on hold without visibility inference", () => {
    const before = "<h2>Eligibility</h2><p>Applications are welcome.</p><div hidden>Apply by October 1, 2027.</div>";
    const { after, result } = review(before, before.replace("October 1", "November 1"), {
      previousVisible: "Eligibility Applications are welcome.", currentVisible: "Eligibility Applications are welcome.",
    });
    expect(after.text).toContain("November 1, 2027");
    expect(result).toMatchObject({ status: "manual_review_required", reason: "changed_block_not_uniquely_visible" });
  });

  it("keeps duplicate answers ambiguous", () => {
    const before = "<h2>Eligibility</h2><div>Apply by October 1, 2027.</div><div>Apply by October 1, 2027.</div>";
    const { result } = review(before, before.replaceAll("October 1", "November 1"));
    expect(result).toMatchObject({ status: "manual_review_required", reason: "changed_block_source_occurrence_ambiguous" });
  });

  it("holds an answer moved outside its actual details context", () => {
    const before = "<details><summary>U.S. applicants</summary><div>Apply by October 1.</div></details>";
    const { before: oldDoc, after, result } = review(before,
      "<details><summary>U.S. applicants</summary></details><div>Apply by October 1.</div>");
    expect(oldDoc.text).toBe(after.text);
    expect(oldDoc.blocks.find(block => block.kind === "div").details_path).toEqual(["U.S. applicants"]);
    expect(after.blocks.find(block => block.kind === "div")).not.toHaveProperty("details_path");
    expect(result).toMatchObject({ status: "manual_review_required", reason: "structural_only_change" });
  });

  it("does not omit an unexplained sibling text change", () => {
    const before = "<h2>Eligibility</h2><div>Apply by October 1.</div><section>Original unstructured wording.</section>";
    const { result } = review(before, before.replace("October 1", "November 1").replace("Original unstructured", "Different unstructured"));
    expect(result).toMatchObject({ status: "manual_review_required", reason: "unexplained_full_source_prose_change" });
  });

  it("retains bounded complete answer requirements rather than truncating oversized changes", () => {
    const before = `<h2>Eligibility</h2><div>Apply by October 1. ${"Required context. ".repeat(600)}</div>`;
    const { result } = review(before, before.replace("October 1", "November 1"));
    expect(result).toMatchObject({ status: "manual_review_required", reason: "complete_changed_prose_exceeds_review_bound" });
  });

  it("keeps a v2 source edit on hold when screenshot semantics were not paired", () => {
    const before = "<h2>Eligibility</h2><div>Apply by October 1.</div>";
    expect(review(before, before.replace("October 1", "November 1"), { currentScreenshot: false }).result)
      .toMatchObject({ status: "manual_review_required", reason: "supplementary_screenshot_semantics_changed" });
  });

  it("still holds mixed profile pairs before producing a review", () => {
    const before = "<h2>Eligibility</h2><div>Apply by October 1.</div>";
    expect(review(before, before.replace("October 1", "November 1"), { previousProfile: "scrapling-evidence-v1" }).result)
      .toMatchObject({ status: "unavailable", reason: "capture_profile_mismatch" });
  });
});
