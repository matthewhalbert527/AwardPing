import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as queue from "./lib/visual-review-queue.mjs";
import * as policy from "./lib/gemini-worker-policy.mjs";
import { batchInputModeForRequests } from "./lib/gemini-batch-support.mjs";
import { estimateGeminiMaximumBatchRequestsCostUsd } from "./lib/gemini-spend-ledger.mjs";
import { buildLegacyReviewCompleteness, legacyReviewCompletenessDecision, isLegacyParagraphReviewCandidate } from "./lib/legacy-review-completeness.mjs";
import { sourceQualityDecision } from "./lib/source-quality.mjs";
import { paidVisualReviewLaneForCandidate, paidVisualReviewWorkKindForLane, paidVisualProviderRequestFingerprint,
  paidVisualRetryAuthorizationPrecheck, runPaidVisualProviderCreateBoundary } from "./lib/paid-visual-review-policy.mjs";
import { NATIVE_PDF_REVIEW_PROFILE, nativePdfCandidate, validateNativePdfReviewResult } from "./lib/native-pdf-review.mjs";

// Only public repository source is read. Never import the worker entrypoint.
// CAS/storage/provider boundaries below are in-memory doubles, NOT SQL/FS/PDF
// parser coverage. The actual leaf preparation/identity/manifest code runs with
// Map-backed artifact reads and a separately labelled synthetic parser boundary.
const workerSource = readFileSync(new URL("./process-visual-review-batch.mjs", import.meta.url), "utf8");
const leafSource = readFileSync(new URL("./lib/native-pdf-review.mjs", import.meta.url), "utf8");
function parsed(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(node => [node.name.text, node]));
  return { ast, functions, declaration(name) {
    const node = functions.get(name); assert.ok(node, `actual named function ${name}`);
    return node.getText(ast).replace(/^export\s+/, "");
  } };
}
const worker = parsed(workerSource, "process-visual-review-batch.mjs"), leaf = parsed(leafSource, "native-pdf-review.mjs");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const lane = "changed_page_review", strong = "gemini-3.8-flash";
const archiveRoot = resolve("tmp/native-pdf-wiring-in-memory-no-files");

function fixture({ currentByte = "B" } = {}) {
  const source = { id: "33333333-3333-4333-8333-333333333333", shared_award_id: "22222222-2222-4222-8222-222222222222",
    url: "https://example.edu/fellowship/guide.pdf", title: "Example Fellowship guide", page_type: "pdf", admin_review_status: "open",
    shared_awards: { name: "Example Fellowship" }, page_metadata_generated_at: "2026-10-20T00:00:00.000Z", page_metadata_model: "synthetic",
    page_metadata: { baseline_facts: { award_relevance: "primary", cycle_relevance: "current_or_upcoming", quality_flags: [],
      display_title: "Example Fellowship guide", important_dates: [{ date: "March 2, 2027", label: "Deadline" }] } } };
  const candidate = { id: "11111111-1111-4111-8111-111111111111", shared_award_source_id: source.id, shared_award_id: source.shared_award_id,
    source_url: source.url, source_title: source.title, source_page_type: "pdf", candidate_scope: "content_change",
    candidate_signature: "a".repeat(64), gemini_batch_request_key: "a".repeat(64), status: "pending", gemini_batch_name: null,
    updated_at: "2026-10-20T00:00:00.000Z", worker_metadata: {}, prompt_payload: { include_images: true,
      source: { id: source.id, shared_award_id: source.shared_award_id, url: source.url, title: source.title,
        page_type: source.page_type, award_name: "Example Fellowship", baseline_facts: source.page_metadata.baseline_facts }, hashes: {} } };
  const files = new Map(), parsedByHash = new Map();
  for (const [side, prefix, date, pageTexts, marker] of [
    ["previous", "previous", "2026-10-18T00:00:00.000Z", ["Deadline: March 1, 2027.", "Eligibility: graduating students."], "A"],
    ["current", "new", "2026-10-19T00:00:00.000Z", ["Deadline: March 2, 2027.", "Eligibility: graduating students.", "Application instructions remain available."], currentByte],
  ]) {
    const pdf = Buffer.from(`%PDF-1.7\nsynthetic-${marker}\n%%EOF`), native = pageTexts.join(" ");
    const meta = { kind: "pdf", source: { id: source.id, shared_award_id: source.shared_award_id, url: source.url },
      status_code: 200, content_type: "application/pdf", captured_at: date, final_url: source.url,
      file_hash: sha(pdf), file_bytes: pdf.length, image_hash: sha(pdf), text_hash: sha(native), text_length: native.length,
      page_count: pageTexts.length, pdf_text_error: null, pdf_text_coverage: { status: "native_text_present", synthetic_parser_boundary: true } };
    const bodies = { pdf, text: Buffer.from(`${native}\n`), meta: Buffer.from(JSON.stringify(meta)) }, local_paths = {};
    for (const [role, body] of Object.entries(bodies)) {
      const path = resolve(archiveRoot, side, role); files.set(path, Buffer.from(body));
      local_paths[role] = { path, exists: true, sha256: sha(body), byte_length: body.length, bytes: body.length };
    }
    const ref = { kind: "pdf", captured_at: date, final_url: source.url, file_hash: meta.file_hash,
      image_hash: meta.file_hash, text_hash: meta.text_hash, visual_states: [], local_paths,
      metadata: { status_code: 200, content_type: "application/pdf", page_count: meta.page_count } };
    ref.artifact_manifest = queue.visualSnapshotArtifactManifest(ref); ref.artifact_manifest_digest = ref.artifact_manifest.digest;
    const refKey = side === "previous" ? "previous_snapshot_ref" : "new_snapshot_ref";
    candidate[refKey] = ref; candidate.prompt_payload[refKey] = clone(ref);
    for (const key of ["file_hash", "image_hash", "text_hash", "artifact_manifest_digest"]) candidate.prompt_payload.hashes[`${prefix}_${key}`] = ref[key];
    for (const key of ["file_hash", "image_hash", "text_hash"]) candidate[`${prefix}_${key}`] = ref[key];
    candidate.prompt_payload[side === "previous" ? "previous_text_excerpt" : "new_text_excerpt"] = native;
    parsedByHash.set(meta.file_hash, { text: native, pages: pageTexts.map((text, i) => ({ page: i + 1, text })) });
  }
  candidate.deterministic_diff = { added_text: ["Deadline: March 2, 2027."], removed_text: ["Deadline: March 1, 2027."], date_changes: [], amount_changes: [] };
  candidate.deterministic_diff.legacy_review_completeness = buildLegacyReviewCompleteness({ source,
    previousText: candidate.prompt_payload.previous_text_excerpt, currentText: candidate.prompt_payload.new_text_excerpt,
    diff: candidate.deterministic_diff, excludedChangedUnits: 0 });
  Object.assign(candidate.prompt_payload, { deterministic_diff: clone(candidate.deterministic_diff), text_evidence: {
    added_text: candidate.deterministic_diff.added_text, removed_text: candidate.deterministic_diff.removed_text, date_changes: [], amount_changes: [] } });
  const rebuilt = queue.rebuildVisualReviewCandidateForCurrentPolicy(candidate, { source });
  Object.assign(candidate, { candidate_signature: rebuilt.candidate_signature, gemini_batch_request_key: rebuilt.candidate_signature,
    prompt_payload: clone(rebuilt.prompt_payload), prompt_context: rebuilt.prompt_context });
  return { source, candidate, files, parsedByHash };
}

function prepareHarness(f, events, options) {
  const names = ["nativePdfCandidate", "candidateIdentity", "utf8", "readSide", "readNativePair", "prepareNativePdfReview"];
  const constants = leaf.ast.statements.filter(ts.isVariableStatement).map(node => node.getText(leaf.ast).replace(/^export\s+/, "")).join("\n");
  const readArtifact = (descriptor, _root, cap) => {
    events.push("artifact_read");
    const body = f.files.get(descriptor?.path);
    if (!body || body.length > cap || body.length !== descriptor.byte_length || sha(body) !== descriptor.sha256) throw new Error("synthetic artifact binding failed");
    return { body: Buffer.from(body), descriptor, path: descriptor.path };
  };
  const actual = runInNewContext(`${constants}\n${names.map(name => leaf.declaration(name)).join("\n")}\nprepareNativePdfReview`, {
    Buffer, TextDecoder, createHash: crypto.createHash, equal: isDeepStrictEqual, isAbsolute, resolve,
    regularPath: path => path, readArtifact, parseNative: async doc => {
      events.push("synthetic_parser");
      const parsed = clone(f.parsedByHash.get(doc.meta.file_hash));
      assert.ok(parsed && parsed.pages.length === doc.meta.page_count);
      assert.equal(parsed.text, doc.native);
      if (options.raceArtifact && events.filter(value => value === "synthetic_parser").length === 2) {
        f.files.set(f.candidate.previous_snapshot_ref.local_paths.pdf.path, Buffer.from("corrupt-after-parse"));
      }
      return parsed;
    },
  });
  return async input => { events.push("prepare"); if (options.evidenceFailure) throw new Error("synthetic missing original"); return actual(input); };
}

const workerFunctions = ["submitCandidateChunk", "geminiBatchRequestForCandidate", "createGeminiBatchJob", "persistSubmittedClaim",
  "markSubmissionClaimsCreateStarted", "journalVisualProviderBatchName", "failVisualProviderRequestEvidence", "loadSourcesById",
  "authorizePaidRetryCandidatesForSubmission", "verifyNativePdfSubmissionSources", "preSubmissionRejectReason", "retainIncompleteReviewHold", "workerMetadataForCandidate", "timestampForPath",
  "roundUsd", "objectValue", "cleanText", "cleanNullable", "errorMessage", "truncate", "chunks", "unique"];

function harness(options = {}) {
  const f = fixture(options), events = [], writes = [], rpc = [], requests = [], fingerprints = [], estimates = [], reservations = [];
  const rows = [clone(f.candidate)], report = new Proxy({ errors: [], batches: [], estimated_batch_cost_usd: 0 }, {
    get(target, key) { return Reflect.has(target, key) ? target[key] : 0; }, set(target, key, value) { target[key] = value; return true; } });
  let sourceReads = 0;
  const supabase = { from(table) {
    assert.ok(["shared_award_sources", "shared_award_visual_review_candidates"].includes(table));
    const predicates = [], clauses = []; let patch;
    const query = { select(value) { clauses.push(["select", value]); return query; }, update(value) { patch = clone(value); return query; },
      eq(key, value) { clauses.push(["eq", key, value]); predicates.push(row => row[key] === value); return query; },
      is(key, value) { clauses.push(["is", key, value]); predicates.push(row => (row[key] ?? null) === value); return query; },
      in(key, value) { clauses.push(["in", key, clone(value)]); predicates.push(row => value.includes(row[key])); return query; },
      contains(key, value) { clauses.push(["contains", key, clone(value)]); predicates.push(row => Object.entries(value).every(([k, v]) => row[key]?.[k] === v)); return query; },
      maybeSingle: async () => { const result = execute(); return { data: result.data[0] || null, error: null }; },
      then(yes, no) { return Promise.resolve(execute()).then(yes, no); },
    };
    function execute() {
      if (table === "shared_award_sources") {
        sourceReads++; events.push("fresh_source_read");
        if (options.sourceReadFailure) return { data: null, error: { message: "synthetic unavailable source query" } };
        const current = clone(f.source);
        if (options.sourceDrift || options.boundarySourceDrift && sourceReads > 1) current.url = "https://example.edu/other.pdf";
        if (options.sourceClosed) current.admin_review_status = "review_later";
        return { data: [current].filter(row => predicates.every(fn => fn(row))), error: null };
      }
      const stage = patch?.status === "processing" ? "claim" : patch?.status === "submitted" ? "persist" : patch?.status === "failed" ? "evidence_failure"
        : patch?.worker_metadata?.possible_external_batch_name ? "batch_journal" : patch?.worker_metadata?.batch_create_started_at ? "create_journal" : "other_write";
      if (options.lostClaim === stage) return { data: [], error: null };
      if (stage === "claim" && options.versionRace) rows[0].updated_at = "2026-10-20T00:00:01.000Z";
      const matched = rows.filter(row => predicates.every(fn => fn(row)));
      if (patch) for (const row of matched) {
        Object.assign(row, clone(patch));
        if (stage === "claim" && options.dropClaimProfile) delete row.worker_metadata.native_pdf_review_profile;
        if (stage === "claim" && options.mismatchedClaimProfile) row.new_snapshot_ref.kind = "webpage";
        writes.push({ stage, clauses: clone(clauses), patch: clone(patch) }); events.push(stage);
      }
      return { data: clone(matched), error: null };
    }
    return query;
  }, async rpc(name) { rpc.push(name); throw new Error(`Unexpected service RPC ${name}`); } };
  const prepare = prepareHarness(f, events, options);
  const unexpected = name => () => { throw new Error(`Unexpected external or failure boundary ${name}`); };
  const context = { ...queue, ...policy, Buffer, crypto, console: { log() {} }, supabase, report, archiveRoot,
    NATIVE_PDF_REVIEW_PROFILE, nativePdfCandidate, validateNativePdfReviewResult,
    legacyReviewCompletenessDecision, isLegacyParagraphReviewCandidate, sourceQualityDecision,
    paidReviewLaneForCandidate: paidVisualReviewLaneForCandidate, paidReviewWorkKindForLane: paidVisualReviewWorkKindForLane,
    paidVisualRetryAuthorizationPrecheck, runPaidVisualProviderCreateBoundary, batchInputModeForRequests, inlineThreshold: 100,
    monitoringPolicy: queue.currentVisualReviewPolicyIdentity(), monitoringPolicyBundle: queue.currentMonitoringPolicyAuditIdentity(),
    prepareNativePdfReview: prepare,
    paidVisualProviderRequestFingerprint: input => { events.push("fingerprint"); const fingerprint = paidVisualProviderRequestFingerprint(input); fingerprints.push({ fingerprint, input: clone(input) }); return fingerprint; },
    estimateGeminiMaximumBatchRequestsCostUsd: (...args) => { events.push("estimate"); estimates.push(args); if (options.budgetFailure) throw new Error("synthetic verified PDF budget refusal"); return estimateGeminiMaximumBatchRequestsCostUsd(...args); },
    paidReviewWorkFingerprint: (...args) => sha(JSON.stringify(args)),
    reserveGeminiSpend: async value => { events.push("reserve"); reservations.push(value); return { reservation_id: "synthetic-reservation" }; },
    markGeminiSpendCreateStarted: async () => { events.push("spend_create_journal"); },
    submitGeminiSpendReservation: async () => { events.push("spend_submitted"); },
    fetchGeminiJson: async (_url, input) => { events.push("provider_create"); requests.push(JSON.parse(input.body)); return { name: "batches/synthetic-only" }; },
    geminiBatchUrl: () => "https://synthetic.invalid/never-fetched", geminiBatchJobName: value => value.name,
    uploadGeminiJsonlRequests: unexpected("file upload"), sleep: unexpected("sleep"),
    fileToVerifiedInlineGeminiPart: unexpected("thumbnail read"),
    failSubmissionClaimsClosed: async () => { events.push("ambiguous_hold"); },
    releaseGeminiSpendReservation: async () => { events.push("release_reservation"); },
    releaseSubmissionClaims: async () => { events.push("release_claim"); },
    failPaidRetrySubmissionAuthorizations: unexpected("retry authorization failure"),
  };
  const actual = runInNewContext(`${workerFunctions.map(name => worker.declaration(name)).join("\n")}\n({${workerFunctions.join(",")}})`, context);
  return { ...f, actual, context, events, writes, rows, requests, fingerprints, estimates, reservations, rpc, report,
    run: (model = policy.modelForCandidate(f.candidate, { available: true, sourceIds: new Set() })) => actual.submitCandidateChunk(model, [f.candidate], lane) };
}

test("actual CAS → full preparation → request/fingerprint → verified budget → journal/create/persist", async () => {
  const h = harness(); await h.run();
  const positions = ["claim", "fresh_source_read", "prepare", "synthetic_parser", "fingerprint", "estimate", "reserve", "create_journal", "spend_create_journal", "provider_create", "batch_journal", "spend_submitted", "persist"].map(value => h.events.indexOf(value));
  assert.ok(positions.every((value, i) => value >= 0 && (i === 0 || value > positions[i - 1])), JSON.stringify(h.events));
  assert.equal(h.events.filter(value => value === "artifact_read").length, 12, "all six raw artifacts read before and after parsing");
  const request = h.requests[0].batch.inputConfig.requests.requests[0];
  assert.deepEqual(request, h.fingerprints[0].input.batchRequest);
  assert.equal(h.rows[0].status, "submitted"); assert.equal(h.rows[0].model, strong);
  assert.equal(h.rows[0].worker_metadata.native_pdf_review_profile, NATIVE_PDF_REVIEW_PROFILE);
  for (const stage of ["claim", "create_journal", "batch_journal", "persist"]) {
    const write = h.writes.find(value => value.stage === stage);
    assert.ok(write.clauses.some(clause => clause[0] === "eq" && clause[1] === "status" && clause[2] === (stage === "claim" ? "pending" : "processing")));
    assert.ok(write.clauses.some(clause => clause[0] === "is" && clause[1] === "gemini_batch_name" && clause[2] === null));
    if (stage !== "claim") assert.ok(write.clauses.some(clause => clause[0] === "contains" && clause[1] === "worker_metadata" && clause[2].submission_claim_token));
  }
  assert.equal(h.rpc.length, 0, "first attempt does not pretend to consume paid-retry approval");
});

test("full originals, not JPEG/thumbs, reach a strong/HIGH/schema-bound request without internal budget metadata", async () => {
  const h = harness(); await h.run(); const request = h.fingerprints[0].input.batchRequest;
  const parts = request.request.contents[0].parts, media = parts.filter(part => part.inlineData);
  assert.equal(media.length, 2);
  for (const [index, part] of media.entries()) {
    assert.deepEqual(Object.keys(part), ["inlineData"]); assert.deepEqual(Object.keys(part.inlineData).sort(), ["data", "mimeType"]);
    assert.equal(part.inlineData.mimeType, "application/pdf");
    const expected = index === 0 ? h.candidate.previous_file_hash : h.candidate.new_file_hash;
    assert.equal(sha(Buffer.from(part.inlineData.data, "base64")), expected);
  }
  assert.equal(request.request.generationConfig.mediaResolution, "MEDIA_RESOLUTION_HIGH");
  assert.ok(request.request.generationConfig.responseSchema.required.includes("pdf_review"));
  assert.ok(parts.some(part => part.text?.startsWith("PREVIOUS ORIGINAL PDF")));
  assert.ok(parts.some(part => part.text?.startsWith("CURRENT ORIGINAL PDF")));
  assert.doesNotMatch(JSON.stringify(request), /verifiedPdfInputs|synthetic_parser_boundary|"native_text"|image\/jpeg/);
  assert.deepEqual(Object.keys(request.metadata).sort(), ["candidate_signature", "key", "monitoring_policy_hash", "monitoring_policy_id", "monitoring_policy_version"]);
});

test("actual verified-PDF page/text budget is used before reservation and is not sent as request hints", async () => {
  const h = harness(); await h.run();
  const [model, requests, options] = h.estimates[0]; assert.equal(model, strong);
  assert.deepEqual(clone(options.verifiedPdfInputsByRequest[0].map(value => value.page_count)), [2, 3]);
  for (const value of options.verifiedPdfInputsByRequest[0]) assert.deepEqual(Object.keys(value).sort(), ["byte_length", "native_text", "page_count", "sha256"]);
  assert.equal(h.reservations[0].estimatedCostUsd, estimateGeminiMaximumBatchRequestsCostUsd(model, requests, options));
  assert.equal(h.reservations[0].metadata.reservation_basis, "verified_native_pdf_high_pages_and_native_utf8_2x_standard_rates_max_output");
  assert.equal(h.reservations[0].model, strong); assert.ok(h.reservations[0].estimatedCostUsd > 0);
});

test("real provider request fingerprint covers a one-byte PDF-body change", async () => {
  const a = harness(), b = harness({ currentByte: "C" }); await a.run(); await b.run();
  assert.notEqual(a.fingerprints[0].fingerprint, b.fingerprints[0].fingerprint);
  const request = clone(a.fingerprints[0].input.batchRequest), media = request.request.contents[0].parts.filter(part => part.inlineData);
  const body = Buffer.from(media[1].inlineData.data, "base64"); body[body.length - 1] ^= 1; media[1].inlineData.data = body.toString("base64");
  assert.notEqual(paidVisualProviderRequestFingerprint({ laneKey: lane, model: strong, batchRequest: request }), a.fingerprints[0].fingerprint);
});

for (const [label, options] of [["missing original", { evidenceFailure: true }], ["raw artifact races after parse", { raceArtifact: true }],
  ["current source URL differs", { sourceDrift: true }], ["source moved to review later", { sourceClosed: true }]]) {
  test(`${label}: no request fingerprint, budget reservation or provider create`, async () => {
    const h = harness(options); await h.run();
    assert.equal(h.fingerprints.length, 0); assert.equal(h.estimates.length, 0); assert.equal(h.reservations.length, 0); assert.equal(h.requests.length, 0);
    assert.equal(h.rows[0].status, "failed");
    assert.equal(h.rows[0].worker_metadata.review_completeness_hold.automatic_retry_allowed, false);
    assert.equal(h.rows[0].worker_metadata.review_completeness_hold.creates_api_charge, false);
  });
}

test("lost initial real CAS cannot read evidence or fingerprint/reserve/create", async () => {
  const h = harness({ lostClaim: "claim" }); await h.run();
  assert.deepEqual(h.events, []); assert.equal(h.report.submission_claim_conflicts, 1);
  assert.equal(h.fingerprints.length + h.reservations.length + h.requests.length, 0);
});

test("a real updated_at version race loses the initial CAS without reading any PDF", async () => {
  const h = harness({ versionRace: true }); await h.run();
  assert.deepEqual(h.events, []); assert.equal(h.report.submission_claim_conflicts, 1);
  assert.equal(h.rows[0].status, "pending"); assert.equal(h.fingerprints.length + h.reservations.length + h.requests.length, 0);
});

for (const [label, options] of [["pair loses its profile", { dropClaimProfile: true }], ["profile loses its PDF pair", { mismatchedClaimProfile: true }]]) {
  test(`post-CAS ${label} cannot fall back to thumbnail request`, async () => {
    const h = harness(options); await h.run();
    assert.equal(h.fingerprints.length + h.estimates.length + h.reservations.length + h.requests.length, 0);
    assert.equal(h.rows[0].status, "failed"); assert.ok(!h.events.includes("prepare"));
  });
}

test("source database failure after claim releases only owned claims and never reserves", async () => {
  const h = harness({ sourceReadFailure: true }); await assert.rejects(h.run(), /synthetic unavailable source query/);
  assert.ok(h.events.includes("release_claim")); assert.ok(!h.events.includes("prepare"));
  assert.equal(h.fingerprints.length + h.estimates.length + h.reservations.length + h.requests.length, 0);
});

test("verified PDF budget refusal holds evidence before any reservation or provider call", async () => {
  const h = harness({ budgetFailure: true }); await h.run();
  assert.equal(h.fingerprints.length, 1); assert.equal(h.estimates.length, 1);
  assert.equal(h.reservations.length + h.requests.length, 0); assert.equal(h.rows[0].status, "failed");
  assert.equal(h.rows[0].worker_metadata.review_completeness_hold.automatic_retry_allowed, false);
});

test("wrong model fails closed before fingerprint/reservation/provider", async () => {
  const h = harness(); await h.run("gemini-2.5-flash-lite");
  assert.equal(h.fingerprints.length + h.reservations.length + h.requests.length, 0); assert.equal(h.rows[0].status, "failed");
});

test("lost create-start CAS never reaches provider even after reservation", async () => {
  const h = harness({ lostClaim: "create_journal" });
  await assert.rejects(h.run(), /claim.*lost before Gemini create POST/i);
  assert.equal(h.requests.length, 0); assert.equal(h.reservations.length, 1);
  assert.ok(h.events.includes("release_reservation")); assert.ok(h.events.includes("release_claim"));
});

test("fresh source drift at the actual provider boundary holds the journaled version without creating or auto retry", async () => {
  const h = harness({ boundarySourceDrift: true }); await h.run();
  assert.equal(h.fingerprints.length, 1); assert.equal(h.reservations.length, 1); assert.equal(h.requests.length, 0);
  assert.ok(h.events.includes("create_journal")); assert.ok(h.events.includes("release_reservation"));
  assert.equal(h.rows[0].status, "failed"); assert.equal(h.rows[0].worker_metadata.review_completeness_hold.automatic_retry_allowed, false);
  const held = h.writes.find(write => write.stage === "evidence_failure"), journal = h.writes.find(write => write.stage === "create_journal");
  assert.equal(held.clauses.find(clause => clause[0] === "eq" && clause[1] === "updated_at")[2], journal.patch.updated_at);
});

test("existing manual/completeness holds and failed-row no-auto-retry are unchanged", () => {
  const h = harness(), held = clone(h.candidate);
  held.status = "failed"; held.rejection_reason = "manual_review_required:legacy_review_completeness_missing";
  held.worker_metadata.review_completeness_hold = { automatic_retry_allowed: false, baseline_advance_allowed: false };
  assert.equal(h.actual.preSubmissionRejectReason(held, h.source), held.rejection_reason);
  const missing = clone(h.candidate); delete missing.deterministic_diff.legacy_review_completeness;
  delete missing.prompt_payload.deterministic_diff.legacy_review_completeness;
  assert.equal(h.actual.preSubmissionRejectReason(missing, h.source), "manual_review_required:legacy_review_completeness_missing");
  assert.equal(queue.visualReviewFailureRetryDecision(held).retry, false);
  assert.equal(policy.visualReviewInvalidJsonEscalationDecision(held).escalate, false);
  const unknown = clone(h.candidate); unknown.worker_metadata.native_pdf_review_profile = "unreviewed-pdf-profile";
  assert.equal(h.actual.preSubmissionRejectReason(unknown, h.source), "manual_review_required:native_pdf_review_profile_unrecognized");
  assert.deepEqual(h.events, []);
});

test("independent request builder refuses a PDF pair without the claimed profile marker", () => {
  const h = harness(), candidate = clone(h.candidate); candidate.worker_metadata.review_model = strong;
  assert.throws(() => h.actual.geminiBatchRequestForCandidate(candidate), /A claimed PDF pair cannot fall back to a text-only or thumbnail request\./);
  assert.equal(h.fingerprints.length + h.reservations.length + h.requests.length, 0);
});

function completedResult(h) {
  const raw = { is_true_change: false, is_alert_worthy: false, changed_facts: [], pdf_review: {
    profile: NATIVE_PDF_REVIEW_PROFILE, previous_sha256: h.candidate.previous_file_hash, current_sha256: h.candidate.new_file_hash,
    previous_pages: [1, 2], current_pages: [1, 2, 3], uncertain_pages: [], page_evidence: [] } };
  return { ...clone(raw), raw_result: raw, finish_reason: "STOP", provider_candidate_count: 1 };
}

function publisher(h, { mutateResult, driftSource = false, prepareFailure = false } = {}) {
  const candidate = clone(h.candidate); candidate.model = strong;
  Object.assign(candidate.worker_metadata, { native_pdf_review_profile: NATIVE_PDF_REVIEW_PROFILE, review_model: strong });
  const source = clone(h.source); if (driftSource) source.url += "?different";
  const result = completedResult(h); mutateResult?.(result);
  const holds = [], effects = [], prepare = prepareHarness(h, effects, { evidenceFailure: prepareFailure });
  const api = runInNewContext(`${worker.declaration("publishCandidateResult")}\n${worker.declaration("publishCandidateResultUnlocked")}\n({publishCandidateResult,publishCandidateResultUnlocked})`, {
    NATIVE_PDF_REVIEW_PROFILE, archiveRoot, INITIAL_OFFICIAL_DOCUMENT_SCOPE: "initial_official_document",
    legacyReviewCompletenessDecision, assertVisualReviewCompletedResult: policy.assertVisualReviewCompletedResult,
    prepareNativePdfReview: async input => { assert.equal(input.requireSubmissionClaim, false); assert.ok(effects.includes("lock")); return prepare(input); },
    validateNativePdfReviewResult, errorMessage: error => error.message,
    retainIncompleteReviewHold: async input => { holds.push(input); return { status: "manual_review_required", reason: input.decision.reason }; },
    withVisualBaselineLockAsync: async input => { effects.push("lock"); assert.equal(input.sourceId, source.id); try { return await input.operation(); } finally { effects.push("unlock"); } },
    supabase: { rpc() { effects.push("RPC"); throw new Error("publication RPC must not be reached"); } },
    markPublicationCandidate: async () => { effects.push("mark"); },
    visualReviewSourceIdentityFreshness: queue.visualReviewSourceIdentityFreshness,
    findPriorNonterminalPublication: async () => { effects.push("after_native_guard"); throw new Error("intentional downstream boundary"); },
  });
  return { candidate, source, result, holds, effects, run: () => api.publishCandidateResult({ candidate, source, result, usage: {}, publicationClaimToken: "synthetic-token" }) };
}

for (const [label, options] of [["missing page acknowledgement", { mutateResult: result => { result.raw_result.pdf_review.current_pages = [1, 2]; } }],
  ["uncertain page", { mutateResult: result => { result.raw_result.pdf_review.uncertain_pages = [{ side: "current", page: 2, reason: "uncertain" }]; } }],
  ["current source mismatch", { driftSource: true }], ["original evidence unavailable", { prepareFailure: true }]]) {
  test(`actual locked publisher holds ${label} before baseline/event/RPC paths`, async () => {
    const p = publisher(harness(), options), result = await p.run();
    assert.equal(result.status, "manual_review_required"); assert.equal(p.holds.length, 1);
    assert.deepEqual(p.effects.filter(value => ["lock", "unlock", "RPC", "mark", "after_native_guard"].includes(value)), options.driftSource ? [] : ["lock", "unlock"]);
    if (options.driftSource) {
      assert.deepEqual(p.effects, []);
      assert.equal(result.reason, "legacy_review_source_binding_mismatch");
    }
    assert.equal(p.holds[0].decision.baseline_advance_allowed, false);
  });
}

test("valid extra PDF corroboration only reaches existing downstream gates, not publication authority", async () => {
  const p = publisher(harness()); await assert.rejects(p.run(), /intentional downstream boundary/);
  assert.equal(p.holds.length, 0); assert.ok(p.effects.includes("after_native_guard")); assert.equal(p.effects.at(-1), "unlock");
});
