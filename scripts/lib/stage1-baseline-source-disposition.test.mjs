import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  STAGE1_BASELINE_APPROVAL_STATEMENT,
  STAGE1_BASELINE_APPROVAL_REVIEWED_AT,
  STAGE1_BASELINE_EVIDENCE_PACKET_SHA256,
  STAGE1_BASELINE_REQUEST_IDS,
  STAGE1_BASELINE_STATE_FINGERPRINT_SHA256,
  STAGE1_REVIEWED_SOURCE_ONBOARDING_PLAN_SHA256,
  assertStage1BaselineSourceDispositionConfirmation,
  buildStage1BaselineSourceDispositionPlan,
  canonicalStage1DispositionJson,
  normalizedRetainedTextIdentity,
  stage1BaselinePlannedAcquisitionId,
  stage1BaselinePlannedSourceId,
  verifyStage1BaselineSourceDispositionPlan,
  verifyStage1BaselineSourceHumanDisposition,
} from "./stage1-baseline-source-disposition.mjs";

const reviewedAt = "2026-08-03T17:17:45.549Z";
const observedAt = "2026-08-03T17:18:00.000Z";
const builtAt = "2026-08-03T17:18:30.000Z";
const onboardingPlanSha256 = STAGE1_REVIEWED_SOURCE_ONBOARDING_PLAN_SHA256;
const emptyFacts = Object.freeze({
  description: null,
  deadline: null,
  amount: null,
  eligibility: [],
  application_materials: [],
  important_dates: [],
});
const productionContracts = [
  ["26b5b55f-57e9-42a7-ae4c-37d389c5e70c", "cycle_relevance_unclear", ["funding"], "evergreen", "other", [[316, 449], [2736, 2892]], null],
  ["26b5b55f-57e9-42a7-ae4c-37d389c5e70c", "cycle_relevance_unclear", ["faq"], "evergreen", "faq", [[152, 395], [1673, 1811]], null],
  ["26b5b55f-57e9-42a7-ae4c-37d389c5e70c", "cycle_relevance_unclear", ["application_materials"], "evergreen", "application", [[80, 171], [288, 463]], null],
  ["0695c116-1151-4b68-997e-93df400734dd", "missing_evidence_quotes", ["application_materials", "current_documents", "dates_cycle", "eligibility", "faq", "funding", "selection_interviews"], "current_or_upcoming", "eligibility", [[700, 878], [14404, 14880], [17075, 17152]], null],
  ["5dd1afc1-a560-495a-9bee-1f26f835475b", "missing_evidence_quotes", ["selection_interviews"], "current_or_upcoming", "application", [[3752, 3860], [7449, 7583]], null],
  ["4d2f6a7f-024e-4194-be31-1b9f63e497bc", "cycle_relevance_unclear", ["identity_home"], "evergreen", "homepage", [[62, 135], [240, 445]], null],
  ["a643d94e-216b-4449-bf2f-99d8503793d7", "missing_evidence_quotes", ["funding"], "evergreen", "other", [[85, 262], [546, 711], [1380, 1429]], null],
  ["e776ca2f-4b2c-431e-a3f9-248ad78c30e8", "cycle_relevance_unclear", ["identity_home"], "evergreen", "homepage", [[1508, 1800]], "fa4088a7-706e-4ad3-ae12-3653751dd5e1"],
  ["406c12bc-49f3-4d4c-b90d-9ba7e4e0f70e", "missing_evidence_quotes", ["funding", "identity_home"], "current_or_upcoming", "homepage", [[83, 147], [671, 822]], null],
  ["dd23afbb-299e-489f-8a0b-e4d7506848de", "missing_evidence_quotes", ["current_documents"], "current_or_upcoming", "pdf", [[106, 205], [8089, 8242]], null],
  ["2da1b35d-fe8b-46cd-bc4b-b099e0fd1363", "cycle_relevance_unclear", ["faq", "funding", "selection_interviews"], "evergreen", "faq", [[2025, 2179], [6388, 6469]], null],
].map(([awardId, reason, roles, cycle, pageType, spans, existingSourceId]) => ({
  awardId, reason, roles, cycle, pageType, spans, existingSourceId,
}));

describe("Stage 1 baseline-source disposition plan", () => {
  it("builds the exact 10-approve/one-quarantine packet-bound preview", () => {
    const plan = build();

    expect(plan).toMatchObject({
      mode: "local_preview",
      confirmation_payload: {
        evidence_packet_sha256: STAGE1_BASELINE_EVIDENCE_PACKET_SHA256,
        state_fingerprint_sha256: STAGE1_BASELINE_STATE_FINGERPRINT_SHA256,
        safety_contract: {
          exact_request_count: 11,
          approve_baseline_only_count: 10,
          keep_quarantined_count: 1,
          paid_api_calls: 0,
          public_fact_writes: 0,
          fact_candidates: 0,
          reconciliation_requests: 0,
          first_observation_notifications: 0,
        },
      },
    });
    expect(plan.confirmation_payload.decisions).toHaveLength(11);
    expect(plan.confirmation_payload.decisions[6]).toMatchObject({
      item_number: 7,
      decision: "keep_quarantined",
      source_payload: {},
      acquisition_payload: {},
      request_patch: {
        status: "needs_manual_review",
        status_reason: "stage1_human_source_quarantined_role_mismatch",
      },
    });
    expect(plan.confirmation_payload.decisions.filter(
      (item) => item.decision === "approve_baseline_only",
    )).toHaveLength(10);
    expect(plan.confirmation.exact_confirmation_phrase).toBe(
      `Apply Stage 1 baseline-source disposition plan ${plan.confirmation.plan_sha256}`,
    );
    expect(STAGE1_BASELINE_APPROVAL_REVIEWED_AT).toBe(reviewedAt);
    expect(() => verifyTestPlan(plan)).not.toThrow();
    expect(() => verifyTestPlan(JSON.parse(JSON.stringify(plan)))).not.toThrow();
  });

  it("emits monitoring-only sources held in review_later until activation", () => {
    const decision = build().confirmation_payload.decisions[0];
    expect(decision.source_payload).not.toHaveProperty("admin_review_status");
    expect(decision.source_payload.page_metadata.stage1_baseline_monitoring_approval).toEqual({
      schema_version: "awardping.stage1.baseline-monitoring-approval.v1",
      policy_version: "stage1-baseline-source-disposition-v1",
      decision: "monitoring_only",
      shared_award_source_id: decision.source_binding.source_id,
      source_page_request_id: decision.request_id,
      evidence_packet_sha256: STAGE1_BASELINE_EVIDENCE_PACKET_SHA256,
      decision_item_sha256: decision.decision_item_sha256,
      reviewed_roles: ["funding"],
      exact_evidence_verified: true,
      notification_mode: "baseline_only",
      public_fact_authority: false,
      fact_candidate_authority: false,
    });
  });

  it("creates the exact nested seven-key human disposition and R2 guard", () => {
    const decision = build().confirmation_payload.decisions[0];
    const disposition = decision.acquisition_payload.review_seal.human_source_disposition;
    expect(Object.keys(disposition).sort()).toEqual([
      "activation_guard", "authority", "decision", "effective_source_review",
      "guard_sha256", "policy_version", "schema_version",
    ]);
    expect(disposition.authority).toEqual({
      monitoring: true,
      public_facts: false,
      fact_candidates: false,
      reconciliation: false,
      publication: false,
      first_observation_notification: false,
    });
    expect(disposition.effective_source_review.facts).toEqual(emptyFacts);
    expect(disposition.activation_guard).toMatchObject({
      mode: "first_visual_baseline_exact_normalized_retained_text",
      shared_award_source_id: decision.source_binding.source_id,
      shared_award_source_acquisition_id: decision.acquisition_binding.source_acquisition_id,
      source_page_request_id: decision.request_id,
      decision_item_sha256: decision.decision_item_sha256,
      evidence_packet_sha256: STAGE1_BASELINE_EVIDENCE_PACKET_SHA256,
      notification_mode: "baseline_only",
      retained_text_artifact: {
        store_id: "account.r2.local",
        bucket: "awardping-artifacts",
        r2_verified_at: "2026-08-03T17:10:00.000Z",
      },
    });
    expect(() => verifyStage1BaselineSourceHumanDisposition(disposition)).not.toThrow();
  });

  it("matches the atomic SQL plan contract at every exact-key boundary", () => {
    const decision = build().confirmation_payload.decisions[0];
    expect(Object.keys(decision).sort()).toEqual([
      "acquisition_binding", "acquisition_payload", "decision", "decision_item_sha256",
      "effective_source_classification", "exact_quotes", "expected_request_binding",
      "item_number", "provider_binding", "request_id", "request_patch", "retained_evidence",
      "reviewed_role_binding", "source_binding", "source_payload",
    ]);
    expect(Object.keys(decision.expected_request_binding).sort()).toEqual([
      "acquisition_kind", "capture_file_sha256", "capture_text_sha256",
      "matched_shared_award_id", "normalized_url", "notification_mode", "onboarding_batch_id",
      "status", "status_reason", "updated_at",
    ]);
    expect(Object.keys(decision.provider_binding).sort()).toEqual([
      "input_digest_sha256", "model", "provider_batch_name", "provider_batch_request_key",
      "provider_result_sha256", "result_digest_sha256",
    ]);
    expect(Object.keys(decision.retained_evidence).sort()).toEqual([
      "capture_file_sha256", "captured_at", "final_url", "normalized_text_sha256", "text_artifact",
    ]);
    expect(Object.keys(decision.source_binding).sort()).toEqual([
      "expected_existing_admin_review_status", "expected_existing_source_id",
      "expected_existing_updated_at", "normalized_collision_count", "normalized_url", "source_id",
    ]);
    expect(Object.keys(decision.acquisition_binding).sort()).toEqual([
      "expected_existing_acquisition_count", "expected_existing_acquisition_id",
      "source_acquisition_id",
    ]);
    expect(Object.keys(decision.source_payload).sort()).toEqual([
      "confidence", "consecutive_failures", "display_title", "id", "last_error",
      "page_description", "page_metadata", "page_metadata_generated_at", "page_metadata_model",
      "page_type", "reason", "shared_award_id", "source", "submitted_by_user_id", "title", "url",
    ]);
    expect(Object.keys(decision.acquisition_payload).sort()).toEqual([
      "acquisition_kind", "id", "metadata", "notification_mode", "onboarding_batch_id",
      "origin_source_page_request_id", "origin_worker_run_id", "parent_shared_award_source_id",
      "review_seal", "shared_award_source_id",
    ]);
    expect(Object.keys(decision.request_patch).sort()).toEqual([
      "ai_review_patch", "created_shared_award_id", "created_source_ids",
      "preserve_provider_input_binding", "preserve_provider_raw",
      "preserve_provider_result_binding", "status", "status_reason", "worker_run_id",
    ]);
    expect(decision.request_patch).toMatchObject({
      status: "added",
      status_reason: "stage1_baseline_source_added_pending_exact_visual_activation",
      created_shared_award_id: null,
      created_source_ids: [decision.source_binding.source_id],
    });
  });

  it("removes stale NDSEG fact metadata while preserving non-fact source metadata", () => {
    const ndseg = build().confirmation_payload.decisions[7];
    expect(ndseg.source_binding.expected_existing_source_id)
      .toBe("fa4088a7-706e-4ad3-ae12-3653751dd5e1");
    expect(ndseg.source_payload).toMatchObject({
      title: "Existing title 8",
      confidence: 0.77,
      source: "seed",
      page_metadata: { retained_non_fact_metadata: true },
    });
    expect(ndseg.source_payload.page_metadata).not.toHaveProperty("baseline_facts");
    expect(ndseg.source_payload.page_metadata).not.toHaveProperty("baseline_facts_metadata");
  });

  it("distinguishes raw object, retained semantic, and activation normalization hashes", () => {
    const identity = normalizedRetainedTextIdentity("Alpha\n\tBeta\n");
    expect(identity.object_sha256).not.toBe(identity.retained_semantic_sha256);
    expect(identity.activation_normalized_sha256).toBe(sha256("Alpha Beta"));
    expect(identity.retained_semantic_sha256).toBe(sha256("Alpha\n\tBeta"));

    const uncollapsed = fixture();
    const first = uncollapsed.retainedEvidence[0].bytes.toString("utf8").trim();
    replaceEvidenceText(uncollapsed, 0, `${first.slice(0, 10)}\n${first.slice(10)}`);
    expect(() => buildStage1BaselineSourceDispositionPlan(uncollapsed))
      .toThrow("immutable manifest");
  });

  it("preserves provider raw/input/result identities in expected bindings and patches", () => {
    const decision = build().confirmation_payload.decisions[0];
    expect(decision.provider_binding.provider_result_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(decision.request_patch).toMatchObject({
      preserve_provider_raw: true,
      preserve_provider_input_binding: true,
      preserve_provider_result_binding: true,
    });
    expect(decision.request_patch.ai_review_patch.facts).toEqual(emptyFacts);
  });

  it("is canonical and deterministic for identical reviewed inputs", () => {
    const first = build();
    const second = build();
    expect(first).toEqual(second);
    const reordered = { z: 1, a: { d: 2, c: 3 } };
    expect(canonicalStage1DispositionJson(reordered)).toBe('{"a":{"c":3,"d":2},"z":1}');
  });

  it("requires the exact confirmation phrase and rejects an expired plan", () => {
    const plan = build();
    expect(assertStage1BaselineSourceDispositionConfirmation(
      plan,
      plan.confirmation.exact_confirmation_phrase,
      {
        now: "2026-08-03T17:23:30.000Z",
        _testAllowSyntheticEvidenceHashes: true,
      },
    )).toBe(plan);
    expect(() => assertStage1BaselineSourceDispositionConfirmation(plan, "approve", {
      _testAllowSyntheticEvidenceHashes: true,
    }))
      .toThrow("exact phrase");
    expect(() => assertStage1BaselineSourceDispositionConfirmation(
      plan,
      plan.confirmation.exact_confirmation_phrase,
      {
        now: "2026-08-04T17:17:45.550Z",
        _testAllowSyntheticEvidenceHashes: true,
      },
    )).toThrow("expired");
    expect(() => assertStage1BaselineSourceDispositionConfirmation(
      plan,
      plan.confirmation.exact_confirmation_phrase,
      {
        now: "2026-08-03T17:23:30.001Z",
        _testAllowSyntheticEvidenceHashes: true,
      },
    )).toThrow("preview is stale");
  });

  it.each([
    ["packet", (input) => { input.packetSha256 = "f".repeat(64); }, "exact reviewed"],
    ["state", (input) => { input.stateFingerprintSha256 = "f".repeat(64); }, "fingerprint"],
    ["statement", (input) => { input.operatorStatement += " "; }, "exact 11-item"],
    ["review timestamp", (input) => { input.reviewedAt = "2026-08-03T17:17:45.550Z"; }, "exact operator approval timestamp"],
    ["stale rows", (input) => { input.rowsObservedAt = "2026-08-03T17:00:00.000Z"; }, "five minutes"],
    ["missing row", (input) => { input.freshRows.pop(); }, "exactly 11"],
    ["duplicate row", (input) => { input.freshRows[10] = input.freshRows[0]; }, "duplicate"],
  ])("fails closed on %s mismatch", (_label, mutate, message) => {
    const input = fixture();
    mutate(input);
    expect(() => buildStage1BaselineSourceDispositionPlan(input)).toThrow(message);
  });

  it("fails closed when a request changed state or intake mode", () => {
    const changed = fixture();
    changed.freshRows[0].status = "added";
    expect(() => buildStage1BaselineSourceDispositionPlan(changed)).toThrow("no longer");

    const live = fixture();
    live.freshRows[0].notification_mode = "first_capture_candidate";
    expect(() => buildStage1BaselineSourceDispositionPlan(live)).toThrow("historical baseline-only");
  });

  it("fails closed on provider raw/result or retained text drift", () => {
    const provider = fixture();
    provider.freshRows[0].ai_review.raw.changed = true;
    expect(() => buildStage1BaselineSourceDispositionPlan(provider)).toThrow("Provider raw/result");

    const retained = fixture();
    retained.retainedEvidence[0].bytes = Buffer.from("changed\n");
    expect(() => buildStage1BaselineSourceDispositionPlan(retained)).toThrow("does not match");
  });

  it("fails closed on quote offset, uniqueness, or effective facts", () => {
    const offset = fixture();
    offset.decisions[0].exact_quotes[0].start += 1;
    expect(() => buildStage1BaselineSourceDispositionPlan(offset)).toThrow("offsets changed");

    const duplicate = fixture();
    const original = duplicate.retainedEvidence[0].bytes.toString("utf8").trim();
    const repeated = duplicate.decisions[0].exact_quotes[0].text;
    replaceEvidenceText(duplicate, 0, `${repeated}${original.slice(repeated.length)}`);
    expect(() => buildStage1BaselineSourceDispositionPlan(duplicate)).toThrow("non-unique");

    const facts = fixture();
    facts.decisions[0].effective_source_classification.facts.deadline = "tomorrow";
    expect(() => buildStage1BaselineSourceDispositionPlan(facts)).toThrow("every effective fact empty");
  });

  it("rejects cycle-unclear approvals and non-empty quarantined bindings", () => {
    const unclear = fixture();
    unclear.decisions[0].effective_source_classification.cycle_relevance = "unclear";
    expect(() => buildStage1BaselineSourceDispositionPlan(unclear)).toThrow("evergreen or current");

    const luce = fixture();
    luce.sourceBindings[6] = {
      request_id: STAGE1_BASELINE_REQUEST_IDS[6],
      source_id: stage1BaselinePlannedSourceId(STAGE1_BASELINE_REQUEST_IDS[6]),
      normalized_url: luce.freshRows[6].normalized_url,
      normalized_collision_count: 0,
      expected_existing_source_id: null,
      expected_existing_admin_review_status: null,
      expected_existing_updated_at: null,
      existing_source: null,
    };
    expect(() => buildStage1BaselineSourceDispositionPlan(luce)).toThrow("must be empty");
  });

  it("detects plan, guard, and forbidden-authority tampering", () => {
    const plan = build();
    plan.confirmation_payload.decisions[0].request_patch.status = "rejected";
    expect(() => verifyStage1BaselineSourceDispositionPlan(plan)).toThrow("confirmation");

    const guard = structuredClone(
      build().confirmation_payload.decisions[0]
        .acquisition_payload.review_seal.human_source_disposition,
    );
    guard.authority.publication = true;
    expect(() => verifyStage1BaselineSourceHumanDisposition(guard)).toThrow("forbidden authority");
    guard.authority.publication = false;
    guard.guard_sha256 = "f".repeat(64);
    expect(() => verifyStage1BaselineSourceHumanDisposition(guard)).toThrow("guard hash");
  });

  it("derives stable, distinct planned source and acquisition UUIDs", () => {
    const id = STAGE1_BASELINE_REQUEST_IDS[0];
    expect(stage1BaselinePlannedSourceId(id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(stage1BaselinePlannedAcquisitionId(id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(stage1BaselinePlannedSourceId(id)).not.toBe(stage1BaselinePlannedAcquisitionId(id));
    expect(stage1BaselinePlannedSourceId(id)).toBe(stage1BaselinePlannedSourceId(id));
  });
});

function build() {
  return buildStage1BaselineSourceDispositionPlan(fixture());
}

function verifyTestPlan(plan, options = {}) {
  return verifyStage1BaselineSourceDispositionPlan(plan, {
    ...options,
    _testAllowSyntheticEvidenceHashes: true,
  });
}

function fixture() {
  const decisions = [];
  const freshRows = [];
  const retainedEvidence = [];
  const sourceBindings = [];
  const acquisitionBindings = [];
  const evidenceHashes = [];
  STAGE1_BASELINE_REQUEST_IDS.forEach((requestId, index) => {
    const item = index + 1;
    const contract = productionContracts[index];
    const builtText = textForSpans(contract.spans, item);
    const text = builtText.text;
    const textBytes = Buffer.from(`${text}\n`, "utf8");
    const captureHash = sha256(`capture-${item}`);
    const inputDigest = sha256(`input-${item}`);
    const raw = { status: "needs_review", request_id: requestId, item };
    const rawHash = sha256(canonical(raw));
    const finalUrl = `https://example.org/source-${item}`;
    const prefix = `source-intake-first-observation/v1/requests/${requestId}/sha256/${captureHash}`;
    decisions.push({
      request_id: requestId,
      decision: item === 7 ? "keep_quarantined" : "approve_baseline_only",
      reviewed_roles: contract.roles,
      exact_quotes: builtText.quotes,
      source_title: `Award ${item} source`,
      effective_source_classification: {
        status: item === 7 ? "needs_review" : "accepted",
        source_relevance: "primary",
        cycle_relevance: contract.cycle,
        officialness: "official",
        confidence: "high",
        page_type: contract.pageType,
        facts: structuredClone(emptyFacts),
      },
    });
    freshRows.push({
      id: requestId,
      status: "needs_manual_review",
      status_reason: contract.reason,
      updated_at: "2026-08-03T17:15:00.000Z",
      award_name: `Award ${item}`,
      notes: "Reviewed Stage 1 source",
      homepage_url: finalUrl,
      submitted_url: finalUrl,
      normalized_url: finalUrl,
      intake_type: "official_source",
      matched_shared_award_id: contract.awardId,
      created_shared_award_id: null,
      created_source_ids: null,
      acquisition_kind: "historical_import",
      notification_mode: "baseline_only",
      onboarding_batch_id: "stage1-national-25-reviewed-sources-v1",
      worker_run_id: null,
      deterministic_review: { status: "reviewed", item },
      capture_metadata: {
        capture_file_hash: captureHash,
        canonical_url: finalUrl,
        final_url: finalUrl,
        captured_at: "2026-08-03T17:00:00.000Z",
        retained_artifact: {
          request_id: requestId,
          file_hash: captureHash,
          final_url: finalUrl,
          captured_at: "2026-08-03T17:00:00.000Z",
          text_hash: sha256(text),
          text_length: text.length,
          r2_store_id: "account.r2.local",
          r2_bucket: "awardping-artifacts",
          r2_verified_at: "2026-08-03T17:10:00.000Z",
          artifacts: {
            text: {
              key: `${prefix}/text.txt`,
              sha256: sha256(textBytes),
              byte_length: textBytes.length,
            },
          },
        },
      },
      ai_review: {
        raw,
        reviewed_source_onboarding_evidence: {
          reviewed_roles: contract.roles,
          monitor_only_roles: [],
          evidence_sha256: sha256(`onboarding-${item}`),
        },
        provider_input_binding: {
          request_id: requestId,
          digest_sha256: inputDigest,
          model: "gemini-test",
        },
        provider_result_binding: {
          request_id: requestId,
          input_digest_sha256: inputDigest,
          provider_batch_name: "batches/stage1-test",
          provider_batch_request_key: requestId,
          model: "gemini-test",
          provider_result_sha256: rawHash,
          digest_sha256: sha256(`result-${item}`),
        },
      },
    });
    retainedEvidence.push({ request_id: requestId, bytes: textBytes });
    evidenceHashes.push({
      request_id: requestId,
      capture_file_sha256: captureHash,
      normalized_text_sha256: sha256(text),
      retained_text_object_sha256: sha256(textBytes),
      provider_result_sha256: rawHash,
    });
    const quarantined = item === 7;
    const existing = contract.existingSourceId ? existingSourceRow({
      id: contract.existingSourceId,
      awardId: contract.awardId,
      url: `${finalUrl}/`,
      item,
    }) : null;
    sourceBindings.push(quarantined ? emptySourceBinding(requestId, finalUrl) : {
      request_id: requestId,
      source_id: existing?.id || stage1BaselinePlannedSourceId(requestId),
      normalized_url: finalUrl,
      normalized_collision_count: existing ? 1 : 0,
      expected_existing_source_id: existing?.id || null,
      expected_existing_admin_review_status: existing?.admin_review_status || null,
      expected_existing_updated_at: existing?.updated_at || null,
      existing_source: existing,
    });
    acquisitionBindings.push({
      request_id: requestId,
      source_acquisition_id: quarantined ? null : stage1BaselinePlannedAcquisitionId(requestId),
      expected_existing_acquisition_count: 0,
      expected_existing_acquisition_id: null,
    });
  });
  return {
    packetSha256: STAGE1_BASELINE_EVIDENCE_PACKET_SHA256,
    stateFingerprintSha256: STAGE1_BASELINE_STATE_FINGERPRINT_SHA256,
    onboardingPlanSha256,
    operatorStatement: STAGE1_BASELINE_APPROVAL_STATEMENT,
    reviewedAt,
    rowsObservedAt: observedAt,
    builtAt,
    decisions,
    freshRows,
    retainedEvidence,
    sourceBindings,
    acquisitionBindings,
    _testEvidenceHashes: evidenceHashes,
  };
}

function replaceEvidenceText(input, index, text) {
  const row = input.freshRows[index];
  const bytes = Buffer.from(`${text}\n`, "utf8");
  row.capture_metadata.retained_artifact.text_hash = sha256(text);
  row.capture_metadata.retained_artifact.text_length = text.length;
  row.capture_metadata.retained_artifact.artifacts.text.sha256 = sha256(bytes);
  row.capture_metadata.retained_artifact.artifacts.text.byte_length = bytes.length;
  input.retainedEvidence[index].bytes = bytes;
  input._testEvidenceHashes[index].normalized_text_sha256 = sha256(text);
  input._testEvidenceHashes[index].retained_text_object_sha256 = sha256(bytes);
}

function emptySourceBinding(requestId, normalizedUrl) {
  return {
    request_id: requestId,
    source_id: null,
    normalized_url: normalizedUrl,
    normalized_collision_count: 0,
    expected_existing_source_id: null,
    expected_existing_admin_review_status: null,
    expected_existing_updated_at: null,
    existing_source: null,
  };
}

function textForSpans(spans, item) {
  const length = Math.max(...spans.map((span) => span[1])) + 20;
  const characters = Array.from({ length }, () => "x");
  const quotes = spans.map(([start, end], quoteIndex) => {
    const prefix = `Q${item}_${quoteIndex}_`;
    const text = `${prefix}${String.fromCharCode(65 + quoteIndex).repeat(end - start - prefix.length)}`;
    characters.splice(start, text.length, ...text);
    return { start, end, text };
  });
  return { text: characters.join(""), quotes };
}

function existingSourceRow({ id, awardId, url, item }) {
  return {
    id,
    shared_award_id: awardId,
    url,
    title: `Existing title ${item}`,
    display_title: `Existing display ${item}`,
    page_description: `Existing description ${item}`,
    page_type: "homepage",
    confidence: 0.77,
    reason: "Existing reviewed reason",
    source: "seed",
    submitted_by_user_id: null,
    admin_review_status: "review_later",
    page_metadata: {
      retained_non_fact_metadata: true,
      baseline_facts: { deadline: "stale" },
      baseline_facts_metadata: { generated_at: "stale" },
    },
    page_metadata_generated_at: "2026-07-10T20:54:59.485Z",
    page_metadata_model: "legacy",
    last_error: null,
    consecutive_failures: 0,
    updated_at: "2026-07-10T20:54:59.485Z",
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
