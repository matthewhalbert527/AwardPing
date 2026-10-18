import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { captureScraplingWorkerSource } from "../lib/scrapling-worker.mjs";
import { buildScraplingReviewDiff } from "../lib/scrapling-review-diff.mjs";
import { buildVisualReviewPromptPayload } from "../lib/visual-review-queue.mjs";
import { preparePublishedVisualEventEvidence } from "../lib/visual-event-evidence.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const profile = "scrapling-source-html-v1";
export const sourceHtmlFixtureSource = Object.freeze({ id: "10000000-0000-0000-0000-000000000001",
  shared_award_id: "20000000-0000-0000-0000-000000000001", url: "https://example.edu/award",
  title: "Example Scholarship eligibility", page_type: "eligibility", admin_review_status: "open" });
export const sourceHtmlFixtureCandidateId = "30000000-0000-0000-0000-000000000001";
export const sourceHtmlFixtureDetails = Object.freeze({ exact_before: "October 23, 2026", exact_after: "October 30, 2026",
  changed_facts: [{ fact: "Application deadline", removed_text: "October 23, 2026", added_text: "October 30, 2026" }],
  reader_summary: "The application deadline moved from October 23 to October 30, 2026.",
  candidate_signature: "a".repeat(64), evidence_kind: "source_html", capture_profile: profile });
export const sourceHtmlFixtureEvent = Object.freeze({ id: "40000000-0000-0000-0000-000000000001",
  shared_award_id: sourceHtmlFixtureSource.shared_award_id, shared_award_source_id: sourceHtmlFixtureSource.id,
  source_url: sourceHtmlFixtureSource.url, summary: sourceHtmlFixtureDetails.reader_summary,
  visual_review_candidate_id: sourceHtmlFixtureCandidateId, change_details: sourceHtmlFixtureDetails });

function record(source, text, at) {
  const html = `<html><head><title>Example Scholarship</title></head><body><main><p>${text}</p></main></body></html>`;
  const document = { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document", source_url: source.url,
    title: "Example Scholarship", text, publishable: false, visibility_verified: false,
    blocks: [{ kind: "p", text, heading_path: [], list_path: [], table_row: [] }], links: [], base_hrefs: [],
    limitations: ["Source is not browser-visible evidence."] };
  return { schema: "awardping.scrapling-capture.v1", capture_profile: profile, source_id: source.id, url: source.url,
    final_url: source.url, captured_at: at, status_code: 200, content_type: "text/html; charset=utf-8", html,
    html_document: document, source_main_document: { ...structuredClone(document), title: "", scope: "html-source-main-element" },
    source_http: { schema: "awardping.scrapling-source-http.v1", method: "GET", response_complete: true, redirect_count: 0,
      body_encoding: "utf-8", content_encoding: "identity", body_byte_length: Buffer.byteLength(html), body_sha256: hash(html),
      acquisition: "ordinary_anonymous_http", visibility_verified: false, screenshot_available: false },
    warnings: ["source_html_only_not_browser_visible_or_screenshot_evidence", "linked_documents_forms_and_client_loaded_content_not_fetched"],
    engine: { scrapling: "0.4.15", client: "Fetcher", adaptive: false, stealth: false, impersonation: false } };
}

/** Offline synthetic source only. Uses actual retention/comparison/publication
 * implementations, an in-memory object store, and a caller-owned temporary
 * directory. Never calls a browser, provider, network, database or live archive.
 */
export async function createSourceHtmlPublicationFixture() {
  const root = mkdtempSync(join(tmpdir(), "awardping-source-publication-fixture-"));
  const source = structuredClone(sourceHtmlFixtureSource), changeDetails = structuredClone(sourceHtmlFixtureDetails);
  const oldText = "Applications close October 23, 2026. Only U.S. citizens may apply. International applicants use a separate program. " +
    "Applicants must provide the complete graduate transcript and three letters from academic referees before the stated deadline.";
  const keep = value => captureScraplingWorkerSource(source, { archiveRoot: root, captureProfile: profile, capture: async () => value });
  const before = await keep(record(source, oldText, "2026-10-18T18:00:00.000Z"));
  const capture = await keep(record(source, oldText.replace("October 23", "October 30"), "2026-10-18T19:00:00.000Z"));
  const input = { source, baseline: before, previous: { ...before, meta: before }, capture };
  const checked = buildScraplingReviewDiff(input);
  if (checked.status !== "changed_needs_review") throw new Error("Fixture did not produce a reviewable source change");
  const prompt = buildVisualReviewPromptPayload({ ...input, diff: checked.diff,
    archiveRelative: value => relative(root, value).replaceAll("\\", "/") });
  const candidate = { id: sourceHtmlFixtureCandidateId, candidate_signature: changeDetails.candidate_signature,
    shared_award_id: source.shared_award_id, shared_award_source_id: source.id, source_url: source.url,
    candidate_scope: "content_change", deterministic_diff: checked.diff, prompt_payload: prompt,
    previous_text_hash: before.text_hash, new_text_hash: capture.text_hash,
    previous_snapshot_ref: structuredClone(prompt.previous_snapshot_ref), new_snapshot_ref: structuredClone(prompt.new_snapshot_ref) };
  const objects = new Map();
  const artifactStore = { bucket: "test-bucket",
    async put(value) {
      const existing = objects.get(value.key);
      if (existing && !existing.body.equals(value.body)) throw new Error("Fixture immutable object overwrite");
      objects.set(value.key, { ...value, body: Buffer.from(value.body) });
    },
    async head({ key }) { const value = objects.get(key);
      return { byte_length: value.body.length, sha256: hash(value.body), content_type: value.contentType }; } };
  const published = await preparePublishedVisualEventEvidence({ candidate, source, changeDetails, archiveRoot: root, artifactStore });
  const event = structuredClone(sourceHtmlFixtureEvent);
  const evidence = { ...published, change_event_id: event.id, id: "50000000-0000-0000-0000-000000000001" };
  return { root, archiveRoot: root, source, before, capture, candidate, prompt, checked, changeDetails, event, evidence, objects };
}
