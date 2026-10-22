import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as queue from "./lib/visual-review-queue.mjs";
import * as policy from "./lib/gemini-worker-policy.mjs";
import { sourceBaselineFacts, sourceQualityDecision } from "./lib/source-quality.mjs";
import { buildLegacyReviewCompleteness, legacyReviewCompletenessDecision, isLegacyParagraphReviewCandidate, legacyParagraphReviewLimits } from "./lib/legacy-review-completeness.mjs";
import { paidVisualRetryAuthorizationPrecheck, paidVisualProviderRequestFingerprint, paidVisualReviewLaneForCandidate } from "./lib/paid-visual-review-policy.mjs";
import { NATIVE_PDF_REVIEW_PROFILE, nativePdfCandidate } from "./lib/native-pdf-review.mjs";

// Source/contract regression only: no entrypoint imports, SQL execution, actual
// approval, parser, PDF files, filesystem fixtures, provider or service calls.
// The supplied RPC double below deliberately models NULL-first binding so these
// tests cannot incorrectly depend on an already-bound provider hash for safety.
const workerText = readFileSync(new URL("./process-visual-review-batch.mjs", import.meta.url), "utf8");
const queueText = readFileSync(new URL("./lib/visual-review-queue.mjs", import.meta.url), "utf8");
const sql = readFileSync(new URL("../supabase/migrations/20260717010000_paid_review_retry_approval.sql", import.meta.url), "utf8");
function declaration(source, name) {
  const ast = ts.createSourceFile("actual-repository-source.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(nodes.length, 1, `one actual declaration ${name}`);
  return nodes[0].getText(ast).replace(/^export\s+/, "");
}
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const lane = "changed_page_review", strong = "gemini-3.8-flash", requestFingerprint = hash("synthetic already-approved stored request");

function fixture({ pdf = true, versioned = false, retry = true } = {}) {
  const source = { id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222",
    url: `https://example.edu/award${pdf ? ".pdf" : "/"}`, title: "Synthetic Fellowship application", page_type: pdf ? "pdf" : "deadline",
    admin_review_status: "open", shared_awards: { name: "Synthetic Fellowship" },
    page_metadata_generated_at: "2026-10-20T00:00:00.000Z", page_metadata_model: "synthetic-test",
    page_metadata: { baseline_facts: { award_name: "Synthetic Fellowship", display_title: "Synthetic Fellowship application",
      award_relevance: "primary", cycle_relevance: "current_or_upcoming", quality_flags: [] } } };
  const previous = "The application deadline is March 1, 2027.", current = "The application deadline is March 2, 2027.";
  const diff = { added_text: [current], removed_text: [previous], date_changes: [], amount_changes: [] };
  diff.legacy_review_completeness = buildLegacyReviewCompleteness({ source, previousText: previous, currentText: current, diff, excludedChangedUnits: 0 });
  const refs = ["previous", "current"].map((side, i) => ({ kind: pdf ? "pdf" : "webpage", captured_at: `2026-01-0${i + 1}T00:00:00.000Z`,
    final_url: source.url, file_hash: pdf ? hash(`PDF ${side}`) : null, text_hash: hash(i ? current : previous),
    image_hash: hash(`image ${side}`), local_paths: {}, visual_states: [] }));
  const candidate = { id: "33333333-3333-4333-8333-333333333333", shared_award_source_id: source.id, shared_award_id: source.shared_award_id,
    source_url: source.url, source_title: source.title, source_page_type: source.page_type, candidate_scope: "content_change",
    status: "failed", updated_at: "2026-10-20T00:00:00.000Z", rejection_reason: "invalid_ai_json", model: strong,
    previous_snapshot_ref: refs[0], new_snapshot_ref: refs[1], previous_file_hash: refs[0].file_hash, new_file_hash: refs[1].file_hash,
    previous_image_hash: refs[0].image_hash, new_image_hash: refs[1].image_hash, previous_text_hash: refs[0].text_hash, new_text_hash: refs[1].text_hash,
    deterministic_diff: diff, deterministic_classification: "candidate_change", worker_metadata: {
      ...(pdf ? { native_pdf_review_profile: NATIVE_PDF_REVIEW_PROFILE } : {}), review_model: strong,
      ...(retry ? { paid_retry_approval_id: "44444444-4444-4444-8444-444444444444", failure_retry_count: 1,
        paid_retry_approved_request_fingerprint: requestFingerprint } : {}) },
    prompt_payload: { version: 1, source: queue.visualReviewSourcePromptContext(source),
      previous_snapshot_ref: clone(refs[0]), new_snapshot_ref: clone(refs[1]),
      hashes: { previous_text_hash: refs[0].text_hash, new_text_hash: refs[1].text_hash,
        previous_file_hash: refs[0].file_hash, new_file_hash: refs[1].file_hash, previous_image_hash: refs[0].image_hash, new_image_hash: refs[1].image_hash },
      deterministic_diff: clone(diff), deterministic_classification: { classification: "candidate_change" },
      previous_text_excerpt: previous, new_text_excerpt: current, include_images: false,
      text_evidence: { added_text: diff.added_text, removed_text: diff.removed_text, date_changes: [], amount_changes: [] },
      ...(versioned ? { native_pdf_review_profile: NATIVE_PDF_REVIEW_PROFILE } : {}) } };
  const rebuilt = queue.rebuildVisualReviewCandidateForCurrentPolicy(candidate, { source });
  Object.assign(candidate, { candidate_signature: rebuilt.candidate_signature, gemini_batch_request_key: rebuilt.candidate_signature,
    prompt_payload: clone(rebuilt.prompt_payload), prompt_context: rebuilt.prompt_context });
  const approval = { id: "44444444-4444-4444-8444-444444444444", candidate_id: candidate.id, candidate_updated_at: candidate.updated_at,
    status: "approved", lane_key: lane, expires_at: "2099-01-01T00:00:00.000Z", authorized_provider_request_fingerprint: null };
  const input = { instructions: "SYNTHETIC prepared boundary, not PDF/parser proof", parts: [
    { text: "PREVIOUS ORIGINAL PDF" }, { inlineData: { mimeType: "application/pdf", data: Buffer.from("%PDF-synthetic previous").toString("base64") } },
    { text: "CURRENT ORIGINAL PDF" }, { inlineData: { mimeType: "application/pdf", data: Buffer.from("%PDF-synthetic current").toString("base64") } } ] };
  return { source, candidate, approval, input };
}

function harness() {
  const calls = [], approval = { authorized_provider_request_fingerprint: null };
  const names = ["preSubmissionRejectReason", "paidRetryRequestPreflight", "paidRetryCanonicalJson", "authorizePaidRetryCandidatesForSubmission",
    "geminiBatchRequestForCandidate", "cleanText", "cleanNullable", "objectValue"];
  const api = runInNewContext(`${names.map(name => declaration(workerText, name)).join("\n")}\n({${names.join(",")}})`, {
    ...queue, ...policy, Buffer, NATIVE_PDF_REVIEW_PROFILE, nativePdfCandidate,
    INITIAL_OFFICIAL_DOCUMENT_SCOPE: "initial_official_document", sourceQualityDecision,
    legacyReviewCompletenessDecision, isLegacyParagraphReviewCandidate, legacyParagraphReviewLimits,
    paidVisualRetryAuthorizationPrecheck, paidReviewLaneForCandidate: paidVisualReviewLaneForCandidate, paidLane: null,
    monitoringPolicy: queue.currentVisualReviewPolicyIdentity(),
    fileToVerifiedInlineGeminiPart() { throw new Error("No thumbnail or external file read is permitted by this test"); },
    supabase: { async rpc(name, args) {
      calls.push({ name, args: clone(args) });
      assert.equal(name, "authorize_visual_review_paid_retry_submission");
      if (approval.authorized_provider_request_fingerprint === null) approval.authorized_provider_request_fingerprint = args.p_expected_provider_request_fingerprint;
      return { data: { authorized: approval.authorized_provider_request_fingerprint === args.p_expected_provider_request_fingerprint }, error: null };
    } },
  });
  return { api, calls, approval };
}

test("actual SQL permits NULL provider-hash first binding; safety must precede that RPC", () => {
  const start = sql.indexOf("create or replace function public.authorize_visual_review_paid_retry_submission(");
  const end = sql.indexOf("\n$$;", start); assert.ok(start >= 0 && end > start);
  const body = sql.slice(start, end);
  assert.match(body, /if v_approval\.authorized_provider_request_fingerprint is null then\s+update public\.gemini_paid_retry_approvals approval\s+set\s+authorized_provider_request_fingerprint =\s+p_expected_provider_request_fingerprint/);
  assert.match(body, /and approval\.authorized_provider_request_fingerprint is null;/);
  assert.match(body, /elsif v_approval\.authorized_provider_request_fingerprint\s+is distinct from p_expected_provider_request_fingerprint then/);
  assert.doesNotMatch(body, /native_pdf_review_profile/);
  // Source-order proof only, NOT execution or recertification of this SQL.
  assert.ok(body.indexOf("paid_retry_approval_request_drift") < body.indexOf("if v_approval.authorized_provider_request_fingerprint is null then"));
});

test("new capture packets version both-PDF transport before any future approval; HTML stays unmarked", () => {
  const names = ["buildVisualReviewPromptPayload", "stringArray", "normalizeText", "objectValue"];
  const actual = runInNewContext(`${names.map(name => declaration(queueText, name)).join("\n")}\nbuildVisualReviewPromptPayload`, {
    ...queue, sourceBaselineFacts, legacyReviewCompletenessDecision, NATIVE_PDF_REVIEW_PROFILE,
    // Explicit snapshot boundary: no actual archive/files or approved artifacts.
    snapshotRef: value => clone(value.synthetic_ref), shouldIncludeImagesForCandidate: () => false,
  });
  for (const pdf of [true, false]) {
    const f = fixture({ pdf });
    const payload = actual({ source: f.source, baseline: {}, previous: { synthetic_ref: f.candidate.previous_snapshot_ref, text: "before" },
      capture: { synthetic_ref: f.candidate.new_snapshot_ref, text: "after" }, diff: {}, deterministic: {} });
    assert.equal(payload.native_pdf_review_profile, pdf ? NATIVE_PDF_REVIEW_PROFILE : undefined);
    assert.equal(f.approval.authorized_provider_request_fingerprint, null);
  }
});

test("policy rebuild never silently adds the version to an older approved PDF payload", () => {
  const f = fixture(); const original = clone(f.candidate.prompt_payload);
  assert.equal(original.native_pdf_review_profile, undefined);
  const rebuilt = queue.rebuildVisualReviewCandidateForCurrentPolicy(f.candidate, { source: f.source });
  assert.equal(rebuilt.prompt_payload.native_pdf_review_profile, undefined);
  assert.deepEqual(f.candidate.prompt_payload, original);
});

test("actual pre-consumption preflight holds old native-PDF approval before any rebuild or consume", () => {
  const h = harness(), f = fixture(), prior = clone(f);
  assert.equal(paidVisualRetryAuthorizationPrecheck(f.candidate, lane).required, true);
  assert.equal(h.api.preSubmissionRejectReason(f.candidate, f.source), null, "ordinary eligible native-text gates remain separate");
  const result = h.api.paidRetryRequestPreflight(f.candidate, f.source, f.approval);
  assert.equal(result.allowed, false); assert.equal(result.reason, "paid_retry_native_pdf_contract_not_approved");
  const requeue = declaration(workerText, "requeueRetryableFailures");
  assert.ok(requeue.indexOf("paidRetryRequestPreflight(") < requeue.indexOf('"consume_visual_review_paid_retry_approval"'));
  assert.match(requeue, /if \(!preflight\.allowed\)\s*\{[\s\S]*?continue;\s*\}/);
  assert.deepEqual(f, prior); assert.equal(h.calls.length, 0);
});

for (const stage of ["before_spend_reservation", "provider_create_boundary"]) {
  test(`actual post-claim authorization holds old PDF at ${stage} with NULL-first-bind still untouched`, async () => {
    const h = harness(), f = fixture(); f.candidate.status = "processing";
    const result = await h.api.authorizePaidRetryCandidatesForSubmission({ candidates: [f.candidate], claimToken: "synthetic-claim",
      laneKey: lane, stage, providerRequestFingerprints: new Map([[f.candidate.id, hash("expanded PDF provider body")]]) });
    assert.equal(result.failures.length, 1); assert.equal(result.failures[0].reason, "paid_retry_native_pdf_contract_not_approved");
    assert.equal(result.failures[0].stage, stage); assert.equal(h.calls.length, 0);
    assert.equal(h.approval.authorized_provider_request_fingerprint, null);
  });
}

test("independent request-builder guard refuses old approval even after a valid native profile was stamped on the claim", () => {
  const h = harness(), f = fixture(); f.candidate.status = "processing";
  assert.equal(f.candidate.worker_metadata.native_pdf_review_profile, NATIVE_PDF_REVIEW_PROFILE);
  assert.equal(f.candidate.prompt_payload.native_pdf_review_profile, undefined);
  assert.throws(() => h.api.geminiBatchRequestForCandidate(f.candidate, f.input), error => error.code === "native_pdf_review_paid_contract_not_approved");
  assert.equal(h.calls.length, 0); assert.equal(h.approval.authorized_provider_request_fingerprint, null);
});

test("versioned PDF approval only reaches existing atomic reauthorization, including its NULL-first-bind behavior", async () => {
  const h = harness(), f = fixture({ versioned: true });
  const preflight = h.api.paidRetryRequestPreflight(f.candidate, f.source, f.approval);
  assert.equal(preflight.allowed, true); assert.equal(preflight.reason, "current_request_atomic_approval_check_required");
  f.candidate.status = "processing";
  const request = h.api.geminiBatchRequestForCandidate(f.candidate, f.input);
  const fingerprint = paidVisualProviderRequestFingerprint({ laneKey: lane, model: strong, batchRequest: request });
  assert.equal(request.request.contents[0].parts.filter(part => part.inlineData).length, 2);
  for (const stage of ["before_spend_reservation", "provider_create_boundary"]) {
    const result = await h.api.authorizePaidRetryCandidatesForSubmission({ candidates: [f.candidate], claimToken: "synthetic-claim", laneKey: lane,
      stage, providerRequestFingerprints: new Map([[f.candidate.id, fingerprint]]) });
    assert.equal(result.failures.length, 0);
  }
  assert.equal(h.calls.length, 2); assert.equal(h.approval.authorized_provider_request_fingerprint, fingerprint);
  assert.equal(h.calls[0].args.p_expected_request_fingerprint, requestFingerprint);
  assert.equal(h.calls[0].args.p_expected_provider_request_fingerprint, fingerprint);
  assert.equal(h.calls[0].args.p_submission_claim_token, "synthetic-claim");
});

test("version marker is not an approval: missing approved fingerprint still stops existing authorization", async () => {
  const h = harness(), f = fixture({ versioned: true }); delete f.candidate.worker_metadata.paid_retry_approved_request_fingerprint;
  const result = await h.api.authorizePaidRetryCandidatesForSubmission({ candidates: [f.candidate], claimToken: "synthetic-claim", laneKey: lane,
    stage: "before_spend_reservation", providerRequestFingerprints: new Map([[f.candidate.id, hash("PDF request")]]) });
  assert.equal(result.failures[0].reason, "paid_retry_approval_missing"); assert.equal(h.calls.length, 0);
});

test("first-attempt native PDFs are not mislabelled as already-paid retries", async () => {
  const h = harness(), f = fixture({ retry: false });
  assert.equal(paidVisualRetryAuthorizationPrecheck(f.candidate, lane).required, false);
  const request = h.api.geminiBatchRequestForCandidate(f.candidate, f.input);
  assert.equal(request.request.generationConfig.mediaResolution, "MEDIA_RESOLUTION_HIGH");
  const result = await h.api.authorizePaidRetryCandidatesForSubmission({ candidates: [f.candidate], claimToken: "synthetic-claim", laneKey: lane,
    stage: "before_spend_reservation", providerRequestFingerprints: new Map() });
  assert.equal(result.failures.length, 0); assert.equal(h.calls.length, 0);
});

test("ordinary HTML retry transport and five synthetic held rows remain unchanged", async () => {
  const h = harness(), f = fixture({ pdf: false });
  assert.equal(nativePdfCandidate(f.candidate), false); assert.equal(f.candidate.prompt_payload.native_pdf_review_profile, undefined);
  assert.equal(h.api.paidRetryRequestPreflight(f.candidate, f.source, f.approval).allowed, true);
  const request = h.api.geminiBatchRequestForCandidate(f.candidate);
  assert.equal(request.request.contents[0].parts.length, 1); assert.equal(request.request.generationConfig.mediaResolution, undefined);
  for (let i = 0; i < 5; i++) {
    const held = clone(f.candidate); held.rejection_reason = "manual_review_required:saved_evidence_requires_operator_review";
    held.worker_metadata.review_completeness_hold = { reason: "saved_evidence_requires_operator_review", automatic_retry_allowed: false };
    const before = clone(held);
    assert.equal(h.api.preSubmissionRejectReason(held, f.source), held.rejection_reason);
    assert.equal(h.api.paidRetryRequestPreflight(held, f.source, f.approval).allowed, false);
    assert.deepEqual(held, before);
  }
  assert.equal(h.calls.length, 0);
});
