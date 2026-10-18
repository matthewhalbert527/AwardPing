import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureScraplingWorkerSource } from "./scrapling-worker.mjs";
import { buildScraplingReviewDiff } from "./scrapling-review-diff.mjs";
import { SOURCE_HTML_PROFILE } from "./source-html-evidence.mjs";
import { buildVisualReviewPromptPayload } from "./visual-review-queue.mjs";
import { preflightPublishedSourceHtmlEventEvidence, preparePublishedVisualEventEvidence } from "./visual-event-evidence.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const source = { id: "10000000-0000-0000-0000-000000000001", shared_award_id: "20000000-0000-0000-0000-000000000001",
  url: "https://example.edu/award", title: "Example Scholarship eligibility", page_type: "eligibility", admin_review_status: "open" };
const oldText = "Applications close October 23, 2026. Only U.S. citizens may apply. International applicants use a separate program. " +
  "Applicants must provide the complete graduate transcript and three letters from academic referees before the stated deadline.";
const newText = oldText.replace("October 23", "October 30");
const changeDetails = { exact_before: "October 23, 2026", exact_after: "October 30, 2026",
  changed_facts: [{ fact: "Application deadline", removed_text: "October 23, 2026", added_text: "October 30, 2026" }],
  reader_summary: "The application deadline moved from October 23 to October 30, 2026." };
function record(text, at) {
  const html = `<html><head><title>Example Scholarship</title></head><body><main><p>${text}</p></main></body></html>`;
  const document = { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document", source_url: source.url,
    title: "Example Scholarship", text, publishable: false, visibility_verified: false,
    blocks: [{ kind: "p", text, heading_path: [], list_path: [], table_row: [] }], links: [], base_hrefs: [],
    limitations: ["Source is not browser-visible evidence."] };
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
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "awardping-source-event-")); directories.push(root);
  const keep = value => captureScraplingWorkerSource(source, { archiveRoot: root, captureProfile: SOURCE_HTML_PROFILE, capture: async () => value });
  const before = await keep(record(oldText, "2026-10-18T18:00:00.000Z"));
  const capture = await keep(record(newText, "2026-10-18T19:00:00.000Z"));
  const input = { source, baseline: before, previous: { ...before, meta: before }, capture };
  const checkedDiff = buildScraplingReviewDiff(input);
  expect(checkedDiff.status).toBe("changed_needs_review");
  const prompt = buildVisualReviewPromptPayload({ ...input, diff: checkedDiff.diff,
    archiveRelative: value => relative(root, value).replaceAll("\\", "/") });
  const candidate = { id: "30000000-0000-0000-0000-000000000001", candidate_signature: "a".repeat(64),
    shared_award_id: source.shared_award_id, shared_award_source_id: source.id, source_url: source.url,
    candidate_scope: "content_change", deterministic_diff: structuredClone(checkedDiff.diff), prompt_payload: prompt,
    previous_text_hash: before.text_hash, new_text_hash: capture.text_hash,
    previous_snapshot_ref: structuredClone(prompt.previous_snapshot_ref), new_snapshot_ref: structuredClone(prompt.new_snapshot_ref) };
  return { root, before, capture, candidate, source, changeDetails: structuredClone(changeDetails), archiveRoot: root };
}
function memoryStore(onPut) {
  const objects = new Map(), calls = [];
  return { bucket: "test-bucket", calls, objects,
    async put(value) {
      const existing = objects.get(value.key);
      if (existing && !existing.body.equals(value.body)) throw new Error("immutable object overwrite");
      objects.set(value.key, { ...value, body: Buffer.from(value.body) }); calls.push(value);
      await onPut?.(value);
    },
    async head({ key }) { const value = objects.get(key); return { byte_length: value.body.length, sha256: hash(value.body), content_type: value.contentType }; } };
}

describe("immutable source-only event evidence", () => {
  it("uses actual retained writer/prompt contracts and never manufactures image proof", async () => {
    const f = await fixture(), store = memoryStore();
    expect(preflightPublishedSourceHtmlEventEvidence(f).applicable).toBe(true);
    const evidence = await preparePublishedVisualEventEvidence({ ...f, artifactStore: store, now: "2026-10-18T20:00:00.000Z" });
    expect(evidence).toMatchObject({ evidence_status: "not_applicable_source_html", evidence_schema_version: "source-html-event-evidence-v1",
      verified_at: null, backfilled_at: null, localization: { direction: "mixed", change_semantics_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(store.calls).toHaveLength(6);
    for (const [side, capture] of [["previous", f.before], ["current", f.capture]]) {
      const published = evidence[`${side}_capture`];
      expect(published).toMatchObject({ kind: "source_html", capture_profile: SOURCE_HTML_PROFILE, acquisition: "ordinary_anonymous_http",
        visibility_verified: false, screenshot_available: false, state_id: null, source_id: source.id, source_url: source.url,
        full: { content_type: "text/plain; charset=utf-8" }, capture_hashes: { image_hash: null, file_hash: null, layout_hash: null } });
      expect(published.full.object_key).toContain(`/${f.candidate.id}/${side}/source-html/${hash(readFileSync(capture.html_path))}.txt`);
      for (const [role, slot] of [["full", "html"], ["metadata", "meta"], ["text", "text"]]) {
        expect(store.objects.get(published[role].object_key).body).toEqual(readFileSync(capture[`${slot}_path`]));
      }
      for (const field of ["crop", "layout", "states", "thumbnail", "main_full"]) expect(published).not.toHaveProperty(field);
      expect(evidence.localization.sides[side]).toMatchObject({ status: "not_applicable_source_html", required: false,
        exact_overlap: false, semantic_verified: false });
    }
    expect(JSON.stringify(evidence)).not.toContain("image/jpeg");
  });
  it("reuses exact content-addressed bytes on retry", async () => {
    const f = await fixture(), store = memoryStore(), args = { ...f, artifactStore: store, now: "2026-10-18T20:00:00.000Z" };
    const first = await preparePublishedVisualEventEvidence(args), second = await preparePublishedVisualEventEvidence(args);
    expect(second).toEqual(first); expect(store.objects.size).toBe(6);
  });
  it("prevalidates both sides before uploading and uploads the same buffers after a local change", async () => {
    const f = await fixture(); let changed = false;
    const original = readFileSync(f.capture.html_path);
    const store = memoryStore(() => { if (!changed) { changed = true; writeFileSync(f.capture.html_path, "later local replacement"); } });
    const evidence = await preparePublishedVisualEventEvidence({ ...f, artifactStore: store });
    expect(store.objects.get(evidence.current_capture.full.object_key).body).toEqual(original);
  });
  it.each(["previous", "current"])("rejects corrupt %s artifacts before any permanent upload", async side => {
    for (const slot of ["html", "meta", "text"]) {
      const f = await fixture(), store = memoryStore(), capture = side === "previous" ? f.before : f.capture;
      writeFileSync(capture[`${slot}_path`], "corruption");
      await expect(preparePublishedVisualEventEvidence({ ...f, artifactStore: store })).rejects.toThrow();
      expect(store.calls).toHaveLength(0);
    }
  });
  it.each(["mixed-profile", "direct-prompt", "html-proof", "main-proof", "source", "award", "missing-source", "missing-award", "timestamp", "final-url", "text-hash",
    "image", "candidate-image", "prompt-image", "geometry", "visual-states", "extra-slot", "unsafe-path", "candidate-signature", "event-wording", "empty-wording", "missing-raw-ref"])
  ("rejects %s without fallback or writes", async mutation => {
    const f = await fixture(), store = memoryStore(), ref = f.candidate.new_snapshot_ref;
    if (mutation === "mixed-profile") ref.capture_profile = "scrapling-evidence-v1";
    if (mutation === "direct-prompt") ref.page_title = "mismatch";
    if (mutation === "html-proof") f.candidate.deterministic_diff.scrapling_semantics.evidence.current_html_sha256 = "f".repeat(64);
    if (mutation === "main-proof") f.candidate.deterministic_diff.scrapling_semantics.evidence.current_source_main_sha256 = "f".repeat(64);
    if (mutation === "source") f.source = { ...source, id: "40000000-0000-0000-0000-000000000001" };
    if (mutation === "award") f.source = { ...source, shared_award_id: "40000000-0000-0000-0000-000000000001" };
    if (mutation === "missing-source") { f.source = { ...source }; delete f.source.id; }
    if (mutation === "missing-award") { f.source = { ...source }; delete f.source.shared_award_id; }
    if (mutation === "timestamp") ref.captured_at = "2026-10-18T17:00:00.000Z";
    if (mutation === "final-url") ref.final_url = "https://example.edu/other";
    if (mutation === "text-hash") f.candidate.new_text_hash = "f".repeat(64);
    if (mutation === "image") ref.image_hash = "f".repeat(64);
    if (mutation === "candidate-image") f.candidate.previous_image_hash = "f".repeat(64);
    if (mutation === "prompt-image") f.candidate.prompt_payload.hashes.new_image_hash = "f".repeat(64);
    if (mutation === "geometry") ref.metadata.text_geometry = { status: "verified" };
    if (mutation === "visual-states") ref.visual_states.push({ kind: "main" });
    if (mutation === "extra-slot") ref.local_paths.page = ref.local_paths.html;
    if (mutation === "unsafe-path") ref.local_paths.html.archive_relative = "../outside.txt";
    if (mutation === "candidate-signature") f.candidate.candidate_signature = "not-a-digest";
    if (mutation === "event-wording") f.changeDetails.exact_after = "November 30, 2026";
    if (mutation === "empty-wording") f.changeDetails = {};
    if (mutation === "missing-raw-ref") delete ref.local_paths.html;
    await expect(preparePublishedVisualEventEvidence({ ...f, artifactStore: store })).rejects.toThrow();
    expect(store.calls).toHaveLength(0);
  });
  it.each(["historical", "legacyFallback"])("never accepts %s image fallback for a source document", async option => {
    const f = await fixture(), store = memoryStore();
    await expect(preparePublishedVisualEventEvidence({ ...f, [option]: true, artifactStore: store })).rejects.toThrow(/fallback/);
    expect(store.calls).toHaveLength(0);
  });
  it("rejects a consistently substituted main proof even if direct/prompt and diff agree", async () => {
    const f = await fixture(), store = memoryStore(), forged = "f".repeat(64);
    f.candidate.new_snapshot_ref.metadata.source_html.source_main_sha256 = forged;
    f.candidate.prompt_payload.new_snapshot_ref.metadata.source_html.source_main_sha256 = forged;
    f.candidate.deterministic_diff.scrapling_semantics.evidence.current_source_main_sha256 = forged;
    f.candidate.prompt_payload.deterministic_diff.scrapling_semantics.evidence.current_source_main_sha256 = forged;
    await expect(preparePublishedVisualEventEvidence({ ...f, artifactStore: store })).rejects.toThrow(/immutable identity/);
    expect(store.calls).toHaveLength(0);
  });
  it.each(["document_sha256", "main_document_sha256"])("binds %s to the actual sealed source capsule", async field => {
    const f = await fixture(), store = memoryStore();
    f.candidate.new_snapshot_ref.metadata.source_html[field] = "f".repeat(64);
    f.candidate.prompt_payload.new_snapshot_ref = structuredClone(f.candidate.new_snapshot_ref);
    await expect(preparePublishedVisualEventEvidence({ ...f, artifactStore: store })).rejects.toThrow(/immutable identity/);
    expect(store.calls).toHaveLength(0);
  });
  it("requires raw HTML binding even though the closed candidate manifest lists only meta/text", async () => {
    const f = await fixture(), store = memoryStore(), ref = f.candidate.new_snapshot_ref;
    expect(ref.artifact_manifest.artifacts.map(value => value.role)).toEqual(["meta", "text"]);
    ref.local_paths.html.sha256 = "f".repeat(64);
    ref.metadata.source_html.html_sha256 = "f".repeat(64);
    f.candidate.prompt_payload.new_snapshot_ref = structuredClone(ref);
    f.candidate.deterministic_diff.scrapling_semantics.evidence.current_html_sha256 = "f".repeat(64);
    f.candidate.prompt_payload.deterministic_diff = structuredClone(f.candidate.deterministic_diff);
    await expect(preparePublishedVisualEventEvidence({ ...f, artifactStore: store })).rejects.toThrow(/hash mismatch/);
    expect(store.calls).toHaveLength(0);
  });
  it("does not reinterpret unrelated browser/PDF candidates as source-only", () => {
    expect(preflightPublishedSourceHtmlEventEvidence({ candidate: { previous_snapshot_ref: { kind: "webpage" }, new_snapshot_ref: { kind: "pdf" } } })).toEqual({ applicable: false });
  });
  it("fails permanent-object readback mismatch", async () => {
    const f = await fixture(), store = memoryStore(); store.head = async () => ({ byte_length: 1, sha256: "f".repeat(64), content_type: "image/jpeg" });
    await expect(preparePublishedVisualEventEvidence({ ...f, artifactStore: store })).rejects.toThrow(/verification failed/);
  });
});

// Execute only the actual publication declaration, not the CLI entry point.
// Provider/DB/baseline writes are replaced with in-memory boundaries, while the
// source evidence preflight below is the real imported implementation.
const worker = readFileSync(new URL("../process-visual-review-batch.mjs", import.meta.url), "utf8");
const publisherStart = worker.indexOf("async function publishCandidateResultUnlocked(");
const publisherEnd = worker.indexOf("async function publishInitialOfficialDocumentCandidate(", publisherStart);
if (publisherStart < 0 || publisherEnd <= publisherStart) throw new Error("publication_function_boundary_missing");
const publisherDeclaration = worker.slice(publisherStart, publisherEnd);
function processorHarness(f) {
  const calls = [], marks = [];
  const report = { event_evidence_preflight_failed: 0, event_evidence_failures: [], errors: [] };
  const deps = {
    // Completion/policy correctness is covered by their existing dedicated
    // suites; this test starts with the already accepted review boundary.
    assertVisualReviewCompletedResult: () => {},
    markPublicationCandidate: async (candidate, claim, value) => { calls.push("mark"); marks.push({ candidate, claim, value }); },
    INITIAL_OFFICIAL_DOCUMENT_SCOPE: "initial_official_document",
    visualReviewSourceIdentityFreshness: () => ({ allowed: true }),
    findPriorNonterminalPublication: async () => null,
    rebuildVisualReviewCandidateForCurrentPolicy: candidate => candidate,
    changeDetailsFromVisualBatchResult: () => f.changeDetails,
    latestVisualReviewPolicyDecision: () => ({ allowed: true }),
    preflightPublishedSourceHtmlEventEvidence: args => { calls.push("preflight"); return preflightPublishedSourceHtmlEventEvidence(args); },
    promoteApprovedBaselineForCandidate: async () => { calls.push("promote"); return { local: { promoted: true }, r2: { promoted: true } }; },
    visualBaselinePublicationDecision: () => ({ action: "retry", reason: "test_stop_after_verified_promotion_boundary" }),
    workerMetadataForCandidate: (_candidate, extra) => extra,
    errorMessage: error => error.message,
    archiveRoot: f.archiveRoot, r2SnapshotSync: true, report,
  };
  const publish = new Function(...Object.keys(deps), `${publisherDeclaration}\nreturn publishCandidateResultUnlocked;`)(...Object.values(deps));
  return { calls, marks, report, run: () => publish({ candidate: f.candidate, source: f.source,
    result: { stored_completed: true }, usage: { prompt_tokens: 50 }, publicationClaimToken: "offline-test-claim" }) };
}
describe("source-only processor preflight wiring", () => {
  it.each(["html", "meta", "text"])("holds broken %s before baseline promotion and preserves the saved answer", async slot => {
    const f = await fixture(); writeFileSync(f.capture[`${slot}_path`], "corruption");
    const h = processorHarness(f), result = await h.run();
    expect(result).toEqual({ status: "retry_pending", reason: "source_html_evidence_preflight_failed" });
    expect(h.calls).toEqual(["preflight", "mark"]);
    expect(h.marks[0].value).toMatchObject({ status: "succeeded", ai_result: { stored_completed: true },
      actual_usage: { prompt_tokens: 50 }, rejection_reason: "publish_retry_pending:source_html_evidence_preflight_failed",
      worker_metadata: { baseline_advanced: false, reuse_completed_batch_response: true, creates_api_charge: false } });
    expect(h.report.event_evidence_preflight_failed).toBe(1);
    expect(h.report.event_evidence_failures[0].stage).toBe("source_html_preflight_before_baseline");
  });
  it("validates the genuine retained pair before reaching promotion", async () => {
    const h = processorHarness(await fixture()); await h.run();
    expect(h.calls).toEqual(["preflight", "promote", "mark"]);
    expect(h.report.event_evidence_preflight_failed).toBe(0);
  });
  it.each(["webpage", "pdf"])("leaves the existing %s publication path eligible", async kind => {
    const f = { source, archiveRoot: "unused-browser-archive", changeDetails,
      candidate: { id: "existing", candidate_signature: "same", shared_award_id: source.shared_award_id,
        shared_award_source_id: source.id, source_url: source.url, previous_snapshot_ref: { kind }, new_snapshot_ref: { kind } } };
    const h = processorHarness(f); await h.run();
    expect(h.calls).toEqual(["preflight", "promote", "mark"]);
    expect(h.report.event_evidence_preflight_failed).toBe(0);
  });
});
