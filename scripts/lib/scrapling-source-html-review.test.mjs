import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureScraplingWorkerSource } from "./scrapling-worker.mjs";
import { buildScraplingReviewDiff } from "./scrapling-review-diff.mjs";
import { SOURCE_HTML_PROFILE } from "./source-html-evidence.mjs";
import { buildVisualReviewPromptPayload, buildVisualReviewPromptText, normalizeVisualBatchResult,
  validateVisualBatchReview } from "./visual-review-queue.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const source = { id: "10000000-0000-0000-0000-000000000001", shared_award_id: "20000000-0000-0000-0000-000000000001",
  url: "https://example.edu/award", title: "Example Scholarship eligibility", page_type: "eligibility",
  admin_review_status: "open", shared_awards: { name: "Example Scholarship" } };
source.page_metadata_generated_at = "2026-10-17T00:00:00.000Z";
source.page_metadata_model = "offline-test";
source.page_metadata = { baseline_facts: { award_relevance: "primary", cycle_relevance: "current_or_upcoming", quality_flags: [] } };
const oldText = "Applications close October 23, 2026. Only U.S. citizens may apply. International applicants use a separate program. " +
  "Applicants must provide the complete graduate transcript and three letters from academic referees before the stated deadline.";
const newText = oldText.replace("October 23", "October 30");
function record(text, at) {
  const html = `<html><head><title>Example Scholarship</title></head><body><main><p>${text}</p></main></body></html>`;
  const document = { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document",
    source_url: source.url, title: "Example Scholarship", text, publishable: false, visibility_verified: false,
    blocks: [{ kind: "p", text, heading_path: [], list_path: [], table_row: [] }],
    links: [], base_hrefs: [], limitations: ["Source is not browser-visible evidence."] };
  return { schema: "awardping.scrapling-capture.v1", capture_profile: SOURCE_HTML_PROFILE, source_id: source.id,
    url: source.url, final_url: source.url, captured_at: at, status_code: 200, content_type: "text/html; charset=utf-8",
    html, html_document: document, source_main_document: { ...structuredClone(document), title: "", scope: "html-source-main-element" },
    source_http: { schema: "awardping.scrapling-source-http.v1", method: "GET", response_complete: true, redirect_count: 0,
      body_encoding: "utf-8", content_encoding: "identity", body_byte_length: Buffer.byteLength(html), body_sha256: hash(html),
      acquisition: "ordinary_anonymous_http", visibility_verified: false, screenshot_available: false },
    warnings: ["source_html_only_not_browser_visible_or_screenshot_evidence", "linked_documents_forms_and_client_loaded_content_not_fetched"],
    engine: { scrapling: "0.4.15", client: "Fetcher", adaptive: false, stealth: false, impersonation: false } };
}
const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
async function inputs({ unchanged = false, mutate } = {}) {
  const root = mkdtempSync(join(tmpdir(), "awardping-source-review-")); directories.push(root);
  const a = record(oldText, "2026-10-18T18:00:00.000Z");
  const b = record(unchanged ? oldText : newText, "2026-10-18T19:00:00.000Z");
  if (mutate) mutate(b);
  const keep = value => captureScraplingWorkerSource(source, { archiveRoot: root, captureProfile: SOURCE_HTML_PROFILE,
    capture: async () => value });
  const before = await keep(a), capture = await keep(b);
  return { root, source, baseline: before, previous: { ...before, meta: before }, capture };
}
function payload(input, diff) {
  return buildVisualReviewPromptPayload({ ...input, diff, archiveRelative: value => relative(input.root, value).replaceAll("\\", "/") });
}
describe("source-only review remains distinct from browser evidence", () => {
  it("validates complete source artifacts for unchanged captures", async () => {
    const input = await inputs({ unchanged: true });
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "unchanged", publishable: false, baseline_advance_allowed: false });
    input.previous.html += "corruption";
    expect(buildScraplingReviewDiff(input).status).toBe("unavailable");
  });
  it("queues exact paired source changes without inventing visible or image proof", async () => {
    const input = await inputs(), result = buildScraplingReviewDiff(input);
    expect(result).toMatchObject({ status: "changed_needs_review", visible_prose_corroborated: false, source_main_prose_corroborated: true });
    expect(result.diff.removed_text).toEqual([oldText]);
    expect(result.diff.added_text).toEqual([newText]);
    expect(result.evidence).not.toHaveProperty("previous_visible_text_sha256");
    const prompt = payload(input, result.diff);
    expect(prompt.include_images).toBe(false);
    expect(prompt.previous_snapshot_ref.visual_states).toEqual([]);
    expect(prompt.new_snapshot_ref.artifact_manifest.artifacts.map(a => a.role)).toEqual(["meta", "text"]);
    expect(buildVisualReviewPromptText(prompt)).toContain("No screenshot was collected.");
    expect(buildVisualReviewPromptText(prompt)).toContain("International applicants use a separate program.");
  });
  it.each(["previous", "capture"])("requires raw HTML and unmodified sealed metadata on %s", async side => {
    const input = await inputs(); delete input[side].html;
    expect(buildScraplingReviewDiff(input).status).toBe("unavailable");
  });
  it("holds changed text outside the selected main element", async () => {
    const input = await inputs({ mutate: b => { b.source_main_document.text = oldText; b.source_main_document.blocks[0].text = oldText; } });
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required", reason: "changed_block_not_uniquely_source_main" });
  });
  it("holds main-element structural changes despite matching full-body block relationships", async () => {
    const input = await inputs({ mutate: b => { b.source_main_document.blocks[0].details_path = ["Different audience"]; } });
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "manual_review_required", reason: "source_main_relationship_changed" });
  });
  it("does not let source-only metadata enter the browser profile", async () => {
    const input = await inputs(); input.capture.capture_profile = "scrapling-evidence-v1";
    expect(buildScraplingReviewDiff(input).reason).toBe("capture_profile_mismatch");
  });
  it("requires exact source-only pairing proof in reviewed results", async () => {
    const input = await inputs(), result = buildScraplingReviewDiff(input);
    const candidate = { deterministic_diff: result.diff, prompt_payload: payload(input, result.diff),
      source_url: source.url, source_page_type: source.page_type, source_title: source.title };
    const normalized = normalizeVisualBatchResult({ is_true_change: true, is_alert_worthy: true, source_relevance: "primary",
      source_relevance_reason: "This is the official named award application deadline.", change_type: "deadline", confidence: "high",
      changed_facts: [{ fact: "Application deadline", before: "October 23, 2026", after: "October 30, 2026",
        removed_text: "October 23, 2026", added_text: "October 30, 2026", visual_evidence: null }],
      exact_before: "October 23, 2026", exact_after: "October 30, 2026", reader_summary: "The application deadline moved from October 23 to October 30, 2026.",
      advisor_impact: "Applicants have a later submission date.", noise_flags: [] }, { candidate, source });
    const check = () => validateVisualBatchReview({ candidate, source, result: normalized });
    expect(check()).toEqual(expect.objectContaining({ allowed: true }));
    for (const field of ["previous_html_sha256", "current_html_sha256", "previous_source_main_sha256", "current_source_main_sha256"]) {
      const original = candidate.deterministic_diff.scrapling_semantics.evidence[field];
      candidate.deterministic_diff.scrapling_semantics.evidence[field] = "f".repeat(64);
      expect(check()).toMatchObject({ allowed: false, reason: "changed_facts_directional_pairing_unverified" });
      candidate.deterministic_diff.scrapling_semantics.evidence[field] = original;
    }
    delete candidate.deterministic_diff.scrapling_semantics.evidence.previous_html_sha256;
    expect(check()).toMatchObject({ allowed: false, reason: "changed_facts_directional_pairing_unverified" });
  });
});
