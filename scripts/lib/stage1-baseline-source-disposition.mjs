import { createHash } from "node:crypto";

export const STAGE1_BASELINE_SOURCE_DISPOSITION_SCHEMA =
  "awardping.stage1.baseline-source-disposition-plan.v1";
export const STAGE1_BASELINE_SOURCE_DISPOSITION_POLICY =
  "stage1-baseline-source-disposition-v1";
export const STAGE1_BASELINE_HUMAN_DISPOSITION_SCHEMA =
  "awardping.stage1.baseline-source-human-disposition.v1";
export const STAGE1_BASELINE_MONITORING_APPROVAL_SCHEMA =
  "awardping.stage1.baseline-monitoring-approval.v1";
export const STAGE1_BASELINE_EVIDENCE_PACKET_SHA256 =
  "8a1c1d9aa8ccbdf1dcdbb7b2f4b83ac19c99dd9557a8949dff5f63dd22d1026f";
export const STAGE1_BASELINE_STATE_FINGERPRINT_SHA256 =
  "5773e66daa7726642f6c4442f5ad1db581ed598aaf2584d5ac5db141d141915a";
export const STAGE1_REVIEWED_SOURCE_ONBOARDING_PLAN_SHA256 =
  "302bbdd44cd2366bcf811ad0c7ea75b8a2b901c5e235ef6925b08bdfcd8ea1c9";
export const STAGE1_BASELINE_APPROVAL_STATEMENT =
  "Approve baseline-only for items 1–6 and 8–11. Keep item 7, Luce funding, quarantined. The other task is finished.";
export const STAGE1_BASELINE_APPROVAL_REVIEWED_AT = "2026-08-03T17:17:45.549Z";
export const STAGE1_BASELINE_SOURCE_DISPOSITION_MODE = "local_preview";

export const STAGE1_BASELINE_REQUEST_IDS = Object.freeze([
  "62a291a2-e64d-5788-a876-f2dca551a021",
  "cc190ad2-8240-5b8c-b5ac-a73180094d24",
  "2bd3018c-d1b6-5d39-85ed-ea278e9d3702",
  "e01d9d33-47de-5ba9-b83c-d6e7c69a4c7f",
  "27ad713b-0332-59e6-b28b-44b9ff631bc1",
  "fd02cb92-8ab6-553f-8e31-752802ac4641",
  "b7dd586b-ac5e-5da7-abe7-8478a353b865",
  "a97507bf-295a-5a81-99e5-4516f96c9612",
  "2cd2f427-753f-5de7-ab0b-616502b287b7",
  "cf731f52-f02d-581e-bf52-c698f53d87d8",
  "4952d327-4fa5-53a0-8247-dd029f7f2c2c",
]);

const exactRequestContracts = Object.freeze([
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
].map(([awardId, statusReason, roles, cycle, pageType, spans, existingSourceId], index) =>
  Object.freeze({
    item_number: index + 1,
    request_id: STAGE1_BASELINE_REQUEST_IDS[index],
    award_id: awardId,
    status_reason: statusReason,
    reviewed_roles: Object.freeze(roles),
    cycle_relevance: cycle,
    page_type: pageType,
    spans: Object.freeze(spans.map((span) => Object.freeze(span))),
    expected_existing_source_id: existingSourceId,
  })));

const exactPacketEvidenceHashes = Object.freeze([
  ["00c37464146de6bfc18378ed8d772eebaaf60a25d98a0492ac78fe77c7311f87", "3de355be157fec2f2efee9b6ce2b234999321a6b1b056743e1b20a8b5f32d68f", "746c4213537b6c3bcef648618ea9311dc89dc445fb63192aeacc3e4e38eb5622", "f097b9fac152367239e7cb3aefa95900fc6e79725e7ababaee825577d53cf2a1"],
  ["6ee5b5322ed5f5563063d919e552839d434bf08456d8176fbfda9404e015e7e2", "4cbc91149287266cd6c0a1a4156d05a1c74bc393be29ca73369aa613b6f49c27", "20cd1159b40045dd34fdd7cc674c34e617ab2b2dd878e25755270e2611ad98aa", "6f3f44c7b1ae6351bf9fb8f3df7cb11f7f3e0900f6133c9bfe30e22367ba3f7c"],
  ["820abfa159de84af70a842f42cc5a798135dd79af6f5927df4adb026d6e00369", "e76c960b8897d29d7a89b243f8a0c763d098f267e2f08dbcf754d0b30fd09764", "4cc27a1c4c25a7e7a0e268a65dcc97cc09748752aae5c3a238563e796c520855", "3fd0438ca5b73433ec6045c536ac37edb957a06441f126c49a40390b5478c468"],
  ["72322508b9631aefa3cb9703a2472169ab8226481146bcfd1bfead149a285740", "884ae5d7325d864739de6b3c7df40ff922cf2b6559736a689d51d25ad9129162", "e594cea13035e0cfd8d359cf7aebf4cbdf5e8c3fe4e0643a5c828f9a152334cb", "6635480731e87e31cabecb2ea6e826f71fcd0451e6f1cc0779bf09589ae9abba"],
  ["e2e5a7a1713d85dec1766b2cd91a429cd8816b190d9d367cff551a2ded3b1a7f", "2d0cfa8d1fbc506b01c48682e55cbfb20bf0ea3c22a31c5921d3f26a30e2d409", "1d3b0847ce95ec6bcb86bd97365fbff29f79f75f22c1ee53d6608d75f2636c3c", "8cb9e879492a80db08160de995197cbbaf870a06a1a015802a3df75c36404271"],
  ["abadec1d8e6ae09e39d5b6cf8cc9dcfd9dff1881f69e0f1377732b3fa0833489", "1845b180a749277991475b093727d19056bf3748ecca8fef02f1be15179de36e", "addc061841821ae1031a4d624ac4bb8c74ce8e7ca5627d2dcd075ef1c4eb589b", "4ff58228ec79b0ff0d932babec4766110630c21f83c07fc225b8694b9ccbb14c"],
  ["c1de68feedabba27c3c831f678425ce5eeb841bd89c9dfa95c09491c275a29d6", "ffb1813c92c55ce1ca6ecf2199b138985fcc13408dfd79472b46c8b1090f2aef", "48ded8d27b2c04eeac17c40a00339d0f060e5651c7d1519fb86da01db33e894d", "0468bd2e4083c1b1fea7f9942860da9eca3fd336ad7f153362fc67d1a81ef410"],
  ["6aaea5fc1614c8fb235dde333e360b39caf336edf5be1f1a2d5ab7c3dc8acbdd", "d6d39f2d4e7df73b129ee50b779870b048fa7a04874e1f9da4f4eeede8caced1", "8bf3f0339d80099a99fff733567ccec74ab6b4803429c3130830d36d08c9a74a", "8cba505c901f1df26b744676d5df392e219e0c329e67ca0fe04d61f5921a46ba"],
  ["a22338c989776633fbc926977231ebd55a580878b8ad0811e0699231d08788b9", "cc3f11f8b812fb95f8c354ab899a768ef440d9c107eada7abc3823624102e1a4", "feaed1b118d17874472fed1fdd5f3f5590126b5a6bacd9099e2eade803119b39", "979924b291b4d2590f55a169137219ead62f3b5fbb7f8437ad95b3cfaa10cf44"],
  ["fac3353cf079c7acfe7eaa7d8da685eba8275181d500373a149f2fdeff429263", "9b50d2748660349bd5d4148453a0f2753cb668ebdf6a3e72d7aed43f43f53aaa", "726c9b2f3e864c31e36443d42549563558e56e9f5987e044b9b6ef389c0446ac", "160fd0dbe7ddb9f0c3e4e6cb3929e8d14c106329c4ce98becfb2ee52d7f9dccb"],
  ["ab5130cf35d3824312beec7d7013b32d9b96afd4e5cfa1b2786f2dfb2c02d44e", "b6e3e5a13e333b70d0de68a3d9d764204cb958b4404bceebb712109b59cc7eb1", "2e8219507e09336f004d289c0d98b771a25d19dd5c53a023028f75bf7e95d2c8", "0cec105e37f158a5fbdc779a14e3f43bf31c1fb37093fed6f58dd015ecfc3023"],
].map(([capture, text, objectHash, provider]) => Object.freeze({
  capture_file_sha256: capture,
  normalized_text_sha256: text,
  retained_text_object_sha256: objectHash,
  provider_result_sha256: provider,
})));

export const STAGE1_BASELINE_SOURCE_DISPOSITION_SELECT_COLUMNS = Object.freeze({
  source_page_requests:
    "id,user_id,status,status_reason,updated_at,award_name,notes,homepage_url,submitted_url,normalized_url,intake_type,matched_shared_award_id,created_shared_award_id,created_source_ids,acquisition_kind,notification_mode,onboarding_batch_id,worker_run_id,capture_metadata,deterministic_review,ai_review",
  shared_award_sources:
    "id,shared_award_id,url,title,display_title,page_description,page_type,confidence,reason,source,submitted_by_user_id,admin_review_status,page_metadata,page_metadata_generated_at,page_metadata_model,last_error,consecutive_failures,updated_at",
  shared_award_source_acquisitions:
    "id,shared_award_source_id,acquisition_kind,notification_mode,origin_source_page_request_id,onboarding_batch_id,review_seal,metadata,created_at",
});

const shaPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const approvedDecision = "approve_baseline_only";
const quarantinedDecision = "keep_quarantined";
const queryFreshnessMs = 5 * 60 * 1_000;
const applyWindowMs = 24 * 60 * 60 * 1_000;

/**
 * Builds a read-only, SQL-friendly disposition preview. All mutable state is
 * supplied by the caller; this module performs no I/O and grants no authority.
 */
export function buildStage1BaselineSourceDispositionPlan({
  packetBytes = null,
  packetSha256 = null,
  stateFingerprintSha256,
  onboardingPlanSha256,
  operatorStatement,
  reviewedAt,
  rowsObservedAt,
  builtAt = new Date().toISOString(),
  decisions,
  freshRows,
  retainedEvidence,
  sourceBindings,
  acquisitionBindings,
  _testEvidenceHashes = null,
} = {}) {
  const built = timestamp(builtAt, "built_at");
  const reviewed = timestamp(reviewedAt, "reviewed_at");
  const observed = timestamp(rowsObservedAt, "rows_observed_at");
  if (operatorStatement !== STAGE1_BASELINE_APPROVAL_STATEMENT) {
    fail("The exact 11-item operator approval statement is required.");
  }
  if (reviewed !== STAGE1_BASELINE_APPROVAL_REVIEWED_AT) {
    fail("The exact operator approval timestamp is required.");
  }
  if (Date.parse(observed) > Date.parse(built) + queryFreshnessMs
      || Date.parse(built) - Date.parse(observed) > queryFreshnessMs) {
    fail("Fresh source state must be observed within five minutes of plan construction.");
  }
  if (Date.parse(reviewed) > Date.parse(built) + queryFreshnessMs) {
    fail("The operator review timestamp is too far in the future.");
  }

  const packetHash = packetBytes == null
    ? requiredSha(packetSha256, "packet SHA-256")
    : sha256(asBytes(packetBytes));
  if (packetSha256 && requiredSha(packetSha256, "packet SHA-256") !== packetHash) {
    fail("The supplied packet bytes do not match the supplied packet SHA-256.");
  }
  if (packetHash !== STAGE1_BASELINE_EVIDENCE_PACKET_SHA256) {
    fail("The evidence packet is not the exact reviewed 11-source packet.");
  }
  if (requiredSha(stateFingerprintSha256, "state fingerprint")
      !== STAGE1_BASELINE_STATE_FINGERPRINT_SHA256) {
    fail("The production-state fingerprint differs from the reviewed packet.");
  }
  const onboardingHash = requiredSha(onboardingPlanSha256, "onboarding plan SHA-256");
  if (onboardingHash !== STAGE1_REVIEWED_SOURCE_ONBOARDING_PLAN_SHA256) {
    fail("The onboarding plan is not the exact applied Stage 1 reviewed-source plan.");
  }

  const decisionInputs = exactByRequest(decisions, "decisions");
  const rows = exactByRequest(freshRows, "fresh rows", "id");
  const evidence = exactByRequest(retainedEvidence, "retained evidence");
  const sources = exactByRequest(sourceBindings, "source bindings");
  const acquisitions = exactByRequest(acquisitionBindings, "acquisition bindings");
  if (_testEvidenceHashes && process.env.NODE_ENV !== "test") {
    fail("Evidence-hash contract overrides are test-only.");
  }
  const evidenceHashContract = _testEvidenceHashes
    ? exactByRequest(_testEvidenceHashes, "test evidence hash contract")
    : new Map(STAGE1_BASELINE_REQUEST_IDS.map(
      (requestId, index) => [requestId, exactPacketEvidenceHashes[index]],
    ));

  const planned = STAGE1_BASELINE_REQUEST_IDS.map((requestId, index) => buildDecision({
    itemNumber: index + 1,
    requestId,
    input: decisionInputs.get(requestId),
    row: rows.get(requestId),
    evidence: evidence.get(requestId),
    sourceBinding: sources.get(requestId),
    acquisitionBinding: acquisitions.get(requestId),
    expectedEvidenceHashes: evidenceHashContract.get(requestId),
    packetHash,
    builtAt: built,
  }));

  const confirmationPayload = {
    evidence_packet_sha256: packetHash,
    state_fingerprint_sha256: STAGE1_BASELINE_STATE_FINGERPRINT_SHA256,
    operator_review: {
      statement: operatorStatement,
      statement_sha256: sha256(operatorStatement),
      reviewed_at: reviewed,
    },
    rows_observed_at: observed,
    onboarding_plan_sha256: onboardingHash,
    safety_contract: {
      exact_request_count: 11,
      approve_baseline_only_count: 10,
      keep_quarantined_count: 1,
      paid_api_calls: 0,
      database_writes_during_preview: 0,
      public_fact_writes: 0,
      fact_candidates: 0,
      reconciliation_requests: 0,
      first_observation_notifications: 0,
      source_activation_before_visual_baseline: 0,
    },
    decisions: planned,
  };
  const planSha256 = sha256(canonicalJson(confirmationPayload));
  const plan = {
    schema_version: STAGE1_BASELINE_SOURCE_DISPOSITION_SCHEMA,
    policy_version: STAGE1_BASELINE_SOURCE_DISPOSITION_POLICY,
    mode: STAGE1_BASELINE_SOURCE_DISPOSITION_MODE,
    built_at: built,
    apply_not_after: new Date(Date.parse(reviewed) + applyWindowMs).toISOString(),
    confirmation_payload: confirmationPayload,
    confirmation: {
      plan_sha256: planSha256,
      exact_confirmation_phrase: stage1BaselineSourceDispositionConfirmationPhrase(planSha256),
    },
  };
  return verifyStage1BaselineSourceDispositionPlan(plan, {
    _testAllowSyntheticEvidenceHashes: Boolean(_testEvidenceHashes),
  });
}

export function verifyStage1BaselineSourceDispositionPlan(plan, {
  now = null,
  _testAllowSyntheticEvidenceHashes = false,
} = {}) {
  if (_testAllowSyntheticEvidenceHashes && process.env.NODE_ENV !== "test") {
    fail("Synthetic evidence-hash verification is test-only.");
  }
  const value = exactObject(plan, [
    "schema_version", "policy_version", "mode", "built_at", "apply_not_after",
    "confirmation_payload", "confirmation",
  ], "plan");
  if (value.schema_version !== STAGE1_BASELINE_SOURCE_DISPOSITION_SCHEMA
      || value.policy_version !== STAGE1_BASELINE_SOURCE_DISPOSITION_POLICY
      || value.mode !== STAGE1_BASELINE_SOURCE_DISPOSITION_MODE) {
    fail("The Stage 1 baseline-source disposition contract is unsupported.");
  }
  const builtAt = timestamp(value.built_at, "built_at");
  const expires = timestamp(value.apply_not_after, "apply_not_after");
  const payload = exactObject(value.confirmation_payload, [
    "evidence_packet_sha256", "state_fingerprint_sha256", "operator_review",
    "rows_observed_at", "onboarding_plan_sha256", "safety_contract", "decisions",
  ], "confirmation_payload");
  const confirmation = exactObject(value.confirmation, [
    "plan_sha256", "exact_confirmation_phrase",
  ], "confirmation");
  const actualHash = sha256(canonicalJson(payload));
  if (requiredSha(confirmation.plan_sha256, "plan SHA-256") !== actualHash
      || confirmation.exact_confirmation_phrase
        !== stage1BaselineSourceDispositionConfirmationPhrase(actualHash)) {
    fail("The plan confirmation does not match its canonical confirmation payload.");
  }
  if (payload.evidence_packet_sha256 !== STAGE1_BASELINE_EVIDENCE_PACKET_SHA256
      || payload.state_fingerprint_sha256 !== STAGE1_BASELINE_STATE_FINGERPRINT_SHA256) {
    fail("The plan is not bound to the reviewed packet and production fingerprint.");
  }
  const review = exactObject(payload.operator_review,
    ["statement", "statement_sha256", "reviewed_at"], "operator_review");
  if (review.statement !== STAGE1_BASELINE_APPROVAL_STATEMENT
      || review.statement_sha256 !== sha256(review.statement)
      || review.reviewed_at !== STAGE1_BASELINE_APPROVAL_REVIEWED_AT) {
    fail("The operator review statement binding is invalid.");
  }
  if (Date.parse(expires) !== Date.parse(timestamp(review.reviewed_at, "reviewed_at")) + applyWindowMs) {
    fail("The disposition plan must retain the exact 24-hour application window.");
  }
  const decisions = array(payload.decisions, "decisions");
  if (decisions.length !== 11) fail("The plan must contain exactly 11 decisions.");
  const ids = new Set();
  let approved = 0;
  let quarantined = 0;
  decisions.forEach((decision, index) => {
    exactObject(decision, [
      "item_number", "request_id", "decision", "decision_item_sha256",
      "expected_request_binding", "reviewed_role_binding", "provider_binding",
      "retained_evidence", "exact_quotes", "effective_source_classification",
      "source_binding", "source_payload", "acquisition_binding", "acquisition_payload",
      "request_patch",
    ], `decision ${index + 1}`);
    if (decision.item_number !== index + 1
        || decision.request_id !== STAGE1_BASELINE_REQUEST_IDS[index]
        || ids.has(decision.request_id)) fail("Decision order, identity, or uniqueness is invalid.");
    ids.add(decision.request_id);
    const contract = exactRequestContracts[index];
    const packetHashes = exactPacketEvidenceHashes[index];
    if (decision.expected_request_binding?.matched_shared_award_id !== contract.award_id
        || decision.expected_request_binding?.status_reason !== contract.status_reason
        || canonicalJson(decision.reviewed_role_binding?.reviewed_roles)
          !== canonicalJson(contract.reviewed_roles)
        || decision.effective_source_classification?.cycle_relevance !== contract.cycle_relevance
        || decision.effective_source_classification?.page_type !== contract.page_type
        || (!_testAllowSyntheticEvidenceHashes && (
          decision.expected_request_binding?.capture_file_sha256
            !== packetHashes.capture_file_sha256
          || decision.expected_request_binding?.capture_text_sha256
            !== packetHashes.normalized_text_sha256
          || decision.retained_evidence?.text_artifact?.sha256
            !== packetHashes.retained_text_object_sha256
          || decision.provider_binding?.provider_result_sha256
            !== packetHashes.provider_result_sha256
        ))) {
      fail(`Decision ${index + 1} does not match the reviewed packet bindings.`);
    }
    const {
      decision_item_sha256: itemHash,
      source_payload: ignoredSource,
      acquisition_payload: ignoredAcquisition,
      request_patch: ignoredPatch,
      ...itemBasis
    } = decision;
    void ignoredSource;
    void ignoredAcquisition;
    void ignoredPatch;
    if (requiredSha(itemHash, "decision item hash") !== sha256(canonicalJson(itemBasis))) {
      fail(`Decision ${index + 1} has an invalid canonical item hash.`);
    }
    assertCommonSqlShape(decision);
    if (decision.decision === approvedDecision) {
      approved += 1;
      assertApprovedSqlShape(decision);
      assertRequestPatchShape(decision);
      verifyStage1BaselineSourceHumanDisposition(
        decision.acquisition_payload?.review_seal?.human_source_disposition,
      );
    } else if (decision.decision === quarantinedDecision) {
      quarantined += 1;
      assertRequestPatchShape(decision);
      if (canonicalJson(decision.source_payload) !== "{}"
          || canonicalJson(decision.acquisition_payload) !== "{}") {
        fail("The quarantined decision may not carry source or acquisition payloads.");
      }
    }
    else fail("A disposition decision is unsupported.");
  });
  if (approved !== 10 || quarantined !== 1
      || decisions[6].decision !== quarantinedDecision) {
    fail("The plan must approve exactly items 1–6 and 8–11 and quarantine item 7.");
  }
  const safety = payload.safety_contract || {};
  if (safety.exact_request_count !== 11 || safety.approve_baseline_only_count !== 10
      || safety.keep_quarantined_count !== 1
      || ["paid_api_calls", "database_writes_during_preview", "public_fact_writes",
        "fact_candidates", "reconciliation_requests", "first_observation_notifications",
        "source_activation_before_visual_baseline"].some((key) => (
          safety[key] !== 0
        ))) {
    fail("The plan safety contract is invalid.");
  }
  if (now) {
    const current = timestamp(now instanceof Date ? now.toISOString() : now, "now");
    if (Date.parse(current) > Date.parse(expires)) {
      fail(`The disposition plan expired at ${expires}.`);
    }
    if (Math.abs(Date.parse(current) - Date.parse(builtAt)) > queryFreshnessMs) {
      fail("The disposition preview is stale; rebuild it from fresh production rows.");
    }
  }
  return value;
}

export function verifyStage1BaselineSourceHumanDisposition(value) {
  const disposition = exactObject(value, [
    "schema_version", "policy_version", "decision", "effective_source_review",
    "activation_guard", "authority", "guard_sha256",
  ], "human_source_disposition");
  if (disposition.schema_version !== STAGE1_BASELINE_HUMAN_DISPOSITION_SCHEMA
      || disposition.policy_version !== STAGE1_BASELINE_SOURCE_DISPOSITION_POLICY
      || disposition.decision !== approvedDecision) fail("The human source disposition is invalid.");
  const authority = exactObject(disposition.authority, [
    "monitoring", "public_facts", "fact_candidates", "reconciliation", "publication",
    "first_observation_notification",
  ], "human disposition authority");
  if (authority.monitoring !== true || [
    "public_facts", "fact_candidates", "reconciliation", "publication",
    "first_observation_notification",
  ].some((key) => authority[key] !== false)) {
    fail("The human source disposition grants forbidden authority.");
  }
  const guard = exactObject(disposition.activation_guard, [
    "mode", "onboarding_batch_id", "shared_award_source_id", "source_page_request_id",
    "shared_award_source_acquisition_id", "evidence_packet_sha256",
    "decision_item_sha256", "normalized_retained_text_sha256", "retained_text_artifact",
    "capture_file_sha256", "final_url", "notification_mode",
  ], "activation_guard");
  if (guard.mode !== "first_visual_baseline_exact_normalized_retained_text") {
    fail("The activation guard mode is invalid.");
  }
  requiredUuid(guard.shared_award_source_id, "guard source id");
  requiredUuid(guard.source_page_request_id, "guard request id");
  requiredUuid(guard.shared_award_source_acquisition_id, "guard acquisition id");
  requiredSha(guard.evidence_packet_sha256, "guard packet hash");
  requiredSha(guard.decision_item_sha256, "guard item hash");
  requiredSha(guard.normalized_retained_text_sha256, "guard normalized text hash");
  requiredSha(guard.capture_file_sha256, "guard capture hash");
  absoluteUrl(guard.final_url, "guard final URL");
  if (guard.notification_mode !== "baseline_only") fail("The activation guard must be baseline-only.");
  const artifact = exactObject(guard.retained_text_artifact,
    ["store_id", "bucket", "key", "sha256", "bytes", "r2_verified_at"],
    "retained text artifact");
  requiredText(artifact.store_id, "retained store id");
  requiredText(artifact.bucket, "retained bucket");
  requiredText(artifact.key, "retained object key");
  requiredSha(artifact.sha256, "retained object hash");
  nonNegativeInteger(artifact.bytes, "retained object bytes");
  timestamp(artifact.r2_verified_at, "retained R2 verification time");
  const review = exactObject(disposition.effective_source_review, [
    "status", "source_relevance", "cycle_relevance", "officialness", "confidence",
    "page_type", "evidence_quotes", "exact_evidence_verified", "reviewed_roles", "facts",
  ], "effective source review");
  if (review.status !== "accepted"
      || !["primary", "supporting"].includes(review.source_relevance)
      || !["evergreen", "current_or_upcoming"].includes(review.cycle_relevance)
      || !["official", "likely_official"].includes(review.officialness)
      || !["medium", "high"].includes(review.confidence)
      || review.exact_evidence_verified !== true
      || !Array.isArray(review.reviewed_roles) || !review.reviewed_roles.length
      || !Array.isArray(review.evidence_quotes) || !review.evidence_quotes.length) {
    fail("The effective source review is not a narrow accepted monitoring classification.");
  }
  const facts = exactObject(review.facts, [
    "amount", "application_materials", "deadline", "description", "eligibility", "important_dates",
  ], "effective source facts");
  if (facts.amount !== null || facts.deadline !== null || facts.description !== null
      || !Array.isArray(facts.application_materials) || facts.application_materials.length
      || !Array.isArray(facts.eligibility) || facts.eligibility.length
      || !Array.isArray(facts.important_dates) || facts.important_dates.length) {
    fail("The effective source disposition must carry no fact authority or values.");
  }
  const { guard_sha256: ignored, ...basis } = disposition;
  void ignored;
  if (requiredSha(disposition.guard_sha256, "human disposition guard hash")
      !== sha256(canonicalJson(basis))) fail("The human source disposition guard hash is invalid.");
  return disposition;
}

export function assertStage1BaselineSourceDispositionConfirmation(plan, phrase, options = {}) {
  const verified = verifyStage1BaselineSourceDispositionPlan(plan, options);
  if (phrase !== verified.confirmation.exact_confirmation_phrase) {
    fail(`Apply requires the exact phrase: ${verified.confirmation.exact_confirmation_phrase}`);
  }
  return verified;
}

export function stage1BaselineSourceDispositionConfirmationPhrase(planSha256) {
  return `Apply Stage 1 baseline-source disposition plan ${requiredSha(planSha256, "plan SHA-256")}`;
}

export function canonicalStage1DispositionJson(value) {
  return canonicalJson(value);
}

export function normalizedRetainedTextIdentity(value) {
  const bytes = asBytes(value);
  const rawText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const text = rawText.replace(/\u0000/g, "").trim();
  const normalizedText = text.replace(/\s+/gu, " ").trim();
  return {
    text,
    text_length: text.length,
    sha256: sha256(normalizedText),
    activation_normalized_sha256: sha256(normalizedText),
    retained_semantic_sha256: sha256(text),
    object_sha256: sha256(bytes),
    object_bytes: bytes.byteLength,
  };
}

function buildDecision({ itemNumber, requestId, input, row, evidence, sourceBinding,
  acquisitionBinding, expectedEvidenceHashes, packetHash, builtAt }) {
  exactObject(input, [
    "request_id", "decision", "reviewed_roles", "exact_quotes",
    "effective_source_classification", "source_title",
  ], `decision input ${itemNumber}`);
  if (input.request_id !== requestId) fail(`Decision item ${itemNumber} has the wrong request id.`);
  const contract = exactRequestContracts[itemNumber - 1];
  const expectedDecision = itemNumber === 7 ? quarantinedDecision : approvedDecision;
  if (input.decision !== expectedDecision) fail(`Decision item ${itemNumber} has the wrong disposition.`);
  const roles = sortedUniqueText(input.reviewed_roles, `reviewed roles for item ${itemNumber}`);
  const request = normalizeFreshRow(row, requestId);
  if (request.matched_shared_award_id !== contract.award_id
      || request.status_reason !== contract.status_reason
      || canonicalJson(roles) !== canonicalJson(contract.reviewed_roles)) {
    fail(`Request, award, reason, or reviewed roles changed for item ${itemNumber}.`);
  }
  const retained = validateRetainedEvidence(evidence, request, requestId);
  if (expectedDecision === approvedDecision && retained.final_url !== request.normalized_url) {
    fail(`Approved source and immutable final URL differ for item ${itemNumber}.`);
  }
  const inputQuotes = array(input.exact_quotes, `quotes for ${requestId}`);
  if (canonicalJson(inputQuotes.map((quote) => [quote?.start, quote?.end]))
      !== canonicalJson(contract.spans)) {
    fail(`Exact packet quote offsets changed for item ${itemNumber}.`);
  }
  const quoteBindings = validateQuotes(inputQuotes, retained.text, requestId);
  const quotes = quoteBindings.map((quote) => quote.text);
  const provider = validateProviderBinding(request, requestId);
  const packetHashes = object(expectedEvidenceHashes, `packet evidence hashes ${requestId}`);
  if (retained.capture_file_sha256 !== packetHashes.capture_file_sha256
      || retained.normalized_retained_text_sha256 !== packetHashes.normalized_text_sha256
      || retained.retained_text_object_sha256 !== packetHashes.retained_text_object_sha256
      || provider.provider_result_sha256 !== packetHashes.provider_result_sha256) {
    fail(`Fresh evidence hashes no longer match reviewed packet item ${itemNumber}.`);
  }
  const source = normalizeSourceBinding(sourceBinding, request, expectedDecision);
  const acquisition = normalizeAcquisitionBinding(
    acquisitionBinding, requestId, expectedDecision,
  );
  const effective = normalizeEffectiveClassification(
    input.effective_source_classification, quotes, roles, expectedDecision,
  );
  if (effective.cycle_relevance !== contract.cycle_relevance
      || effective.page_type !== contract.page_type) {
    fail(`Effective cycle or page type changed for item ${itemNumber}.`);
  }
  if (source.expected_existing_source_id !== contract.expected_existing_source_id) {
    fail(`Expected existing source identity changed for item ${itemNumber}.`);
  }
  const expectedRequestBinding = {
    status: request.status,
    status_reason: request.status_reason,
    updated_at: request.updated_at,
    matched_shared_award_id: request.matched_shared_award_id,
    normalized_url: request.normalized_url,
    acquisition_kind: request.acquisition_kind,
    notification_mode: request.notification_mode,
    onboarding_batch_id: request.onboarding_batch_id,
    capture_file_sha256: retained.capture_file_sha256,
    capture_text_sha256: retained.normalized_retained_text_sha256,
  };
  const onboardingEvidence = object(
    request.ai_review.reviewed_source_onboarding_evidence,
    `reviewed onboarding evidence ${requestId}`,
  );
  const boundRoles = sortedUniqueText(onboardingEvidence.reviewed_roles,
    `onboarding reviewed roles for ${requestId}`);
  if (canonicalJson(boundRoles) !== canonicalJson(roles)) {
    fail(`Reviewed roles changed for ${requestId}.`);
  }
  const reviewedRoleBinding = {
    reviewed_roles: roles,
    monitor_only_roles: sortedOptionalText(onboardingEvidence.monitor_only_roles),
    onboarding_evidence_sha256: requiredSha(
      onboardingEvidence.evidence_sha256,
      `onboarding evidence hash ${requestId}`,
    ),
  };
  const itemBasis = {
    item_number: itemNumber,
    request_id: requestId,
    decision: expectedDecision,
    expected_request_binding: expectedRequestBinding,
    reviewed_role_binding: reviewedRoleBinding,
    provider_binding: provider,
    retained_evidence: retainedPlanEvidence(retained),
    exact_quotes: quotes,
    effective_source_classification: effective,
    source_binding: publicSourceBinding(source),
    acquisition_binding: acquisition,
  };
  const decisionItemSha256 = sha256(canonicalJson(itemBasis));
  let sourcePayload = {};
  let acquisitionPayload = {};
  let requestPatch;
  if (expectedDecision === approvedDecision) {
    const humanDisposition = buildHumanDisposition({
      request, retained, source, acquisition, packetHash, decisionItemSha256,
      effective,
    });
    const monitoringApproval = {
      schema_version: STAGE1_BASELINE_MONITORING_APPROVAL_SCHEMA,
      policy_version: STAGE1_BASELINE_SOURCE_DISPOSITION_POLICY,
      decision: "monitoring_only",
      shared_award_source_id: source.source_id,
      source_page_request_id: requestId,
      evidence_packet_sha256: packetHash,
      decision_item_sha256: decisionItemSha256,
      reviewed_roles: roles,
      exact_evidence_verified: true,
      notification_mode: "baseline_only",
      public_fact_authority: false,
      fact_candidate_authority: false,
    };
    sourcePayload = buildSourcePayload({
      request,
      source,
      effective,
      sourceTitle: requiredText(input.source_title, `source title ${requestId}`),
      monitoringApproval,
      builtAt,
    });
    const reviewSealBasis = {
      source_page_request_id: requestId,
      capture_file_hash: retained.capture_file_sha256,
      capture_final_url: retained.final_url,
      human_source_disposition: humanDisposition,
    };
    acquisitionPayload = {
      id: acquisition.source_acquisition_id,
      shared_award_source_id: source.source_id,
      acquisition_kind: "historical_import",
      notification_mode: "baseline_only",
      origin_source_page_request_id: requestId,
      origin_worker_run_id: null,
      parent_shared_award_source_id: null,
      onboarding_batch_id: request.onboarding_batch_id,
      review_seal: {
        ...reviewSealBasis,
        seal_sha256: sha256(canonicalJson(reviewSealBasis)),
      },
      metadata: {
        stage1_baseline_activation_required: true,
        decision_item_sha256: decisionItemSha256,
        evidence_packet_sha256: packetHash,
      },
    };
    requestPatch = {
      status: "added",
      status_reason: "stage1_baseline_source_added_pending_exact_visual_activation",
      worker_run_id: null,
      created_shared_award_id: null,
      created_source_ids: [source.source_id],
      ai_review_patch: {
        ...effective,
        human_source_disposition: humanDisposition,
      },
      preserve_provider_raw: true,
      preserve_provider_input_binding: true,
      preserve_provider_result_binding: true,
    };
  } else {
    requestPatch = {
      status: "needs_manual_review",
      status_reason: "stage1_human_source_quarantined_role_mismatch",
      worker_run_id: null,
      created_shared_award_id: null,
      created_source_ids: null,
      ai_review_patch: {
        human_quarantine: {
          policy_version: STAGE1_BASELINE_SOURCE_DISPOSITION_POLICY,
          decision: quarantinedDecision,
          reviewed_roles: roles,
          evidence_packet_sha256: packetHash,
          decision_item_sha256: decisionItemSha256,
        },
      },
      preserve_provider_raw: true,
      preserve_provider_input_binding: true,
      preserve_provider_result_binding: true,
    };
  }
  return {
    ...itemBasis,
    decision_item_sha256: decisionItemSha256,
    source_payload: sourcePayload,
    acquisition_payload: acquisitionPayload,
    request_patch: requestPatch,
  };
}

function buildHumanDisposition({ request, retained, source, acquisition, packetHash,
  decisionItemSha256, effective }) {
  const basis = {
    schema_version: STAGE1_BASELINE_HUMAN_DISPOSITION_SCHEMA,
    policy_version: STAGE1_BASELINE_SOURCE_DISPOSITION_POLICY,
    decision: approvedDecision,
    effective_source_review: effective,
    activation_guard: {
      mode: "first_visual_baseline_exact_normalized_retained_text",
      onboarding_batch_id: request.onboarding_batch_id,
      shared_award_source_id: source.source_id,
      source_page_request_id: request.id,
      shared_award_source_acquisition_id: acquisition.source_acquisition_id,
      evidence_packet_sha256: packetHash,
      decision_item_sha256: decisionItemSha256,
      normalized_retained_text_sha256: retained.activation_normalized_text_sha256,
      retained_text_artifact: retained.r2_text_artifact,
      capture_file_sha256: retained.capture_file_sha256,
      final_url: retained.final_url,
      notification_mode: "baseline_only",
    },
    authority: {
      monitoring: true,
      public_facts: false,
      fact_candidates: false,
      reconciliation: false,
      publication: false,
      first_observation_notification: false,
    },
  };
  const value = { ...basis, guard_sha256: sha256(canonicalJson(basis)) };
  verifyStage1BaselineSourceHumanDisposition(value);
  return value;
}

function assertApprovedSqlShape(decision) {
  assertCommonSqlShape(decision);
  exactObject(decision.source_payload, [
    "confidence", "consecutive_failures", "display_title", "id", "last_error",
    "page_description", "page_metadata", "page_metadata_generated_at", "page_metadata_model",
    "page_type", "reason", "shared_award_id", "source", "submitted_by_user_id", "title", "url",
  ], "source payload");
  const acquisition = exactObject(decision.acquisition_payload, [
    "acquisition_kind", "id", "metadata", "notification_mode", "onboarding_batch_id",
    "origin_source_page_request_id", "origin_worker_run_id", "parent_shared_award_source_id",
    "review_seal", "shared_award_source_id",
  ], "acquisition payload");
  const seal = exactObject(acquisition.review_seal, [
    "capture_file_hash", "capture_final_url", "human_source_disposition",
    "seal_sha256", "source_page_request_id",
  ], "acquisition review seal");
  const { seal_sha256: sealHash, ...sealBasis } = seal;
  if (requiredSha(sealHash, "review seal hash") !== sha256(canonicalJson(sealBasis))) {
    fail("The acquisition review seal hash is invalid.");
  }
  const human = seal.human_source_disposition;
  const guard = human?.activation_guard;
  if (canonicalJson(human?.effective_source_review)
      !== canonicalJson(decision.effective_source_classification)
      || guard?.source_page_request_id !== decision.request_id
      || guard?.shared_award_source_id !== decision.source_binding.source_id
      || guard?.shared_award_source_acquisition_id
        !== decision.acquisition_binding.source_acquisition_id
      || guard?.decision_item_sha256 !== decision.decision_item_sha256
      || guard?.evidence_packet_sha256 !== STAGE1_BASELINE_EVIDENCE_PACKET_SHA256
      || guard?.capture_file_sha256 !== decision.retained_evidence.capture_file_sha256
      || guard?.final_url !== decision.retained_evidence.final_url
      || decision.source_payload.url !== decision.retained_evidence.final_url
      || guard?.normalized_retained_text_sha256
        !== decision.retained_evidence.normalized_text_sha256
      || canonicalJson(guard?.retained_text_artifact)
        !== canonicalJson(decision.retained_evidence.text_artifact)) {
    fail("The approved acquisition guard does not match its plan item bindings.");
  }
  const approval = exactObject(
    decision.source_payload.page_metadata?.stage1_baseline_monitoring_approval,
    [
      "schema_version", "policy_version", "decision", "shared_award_source_id",
      "source_page_request_id", "evidence_packet_sha256", "decision_item_sha256",
      "reviewed_roles", "exact_evidence_verified", "notification_mode",
      "public_fact_authority", "fact_candidate_authority",
    ],
    "source monitoring approval",
  );
  if (approval?.shared_award_source_id !== decision.source_binding.source_id
      || approval?.source_page_request_id !== decision.request_id
      || approval?.decision_item_sha256 !== decision.decision_item_sha256
      || approval?.evidence_packet_sha256 !== STAGE1_BASELINE_EVIDENCE_PACKET_SHA256
      || canonicalJson(approval?.reviewed_roles)
        !== canonicalJson(decision.reviewed_role_binding.reviewed_roles)
      || approval?.public_fact_authority !== false
      || approval?.fact_candidate_authority !== false) {
    fail("The source monitoring approval does not match its plan item bindings.");
  }
}

function assertCommonSqlShape(decision) {
  exactObject(decision.expected_request_binding, [
    "acquisition_kind", "capture_file_sha256", "capture_text_sha256",
    "matched_shared_award_id", "normalized_url", "notification_mode",
    "onboarding_batch_id", "status", "status_reason", "updated_at",
  ], "expected request binding");
  exactObject(decision.reviewed_role_binding,
    ["monitor_only_roles", "onboarding_evidence_sha256", "reviewed_roles"],
    "reviewed role binding");
  exactObject(decision.provider_binding, [
    "input_digest_sha256", "model", "provider_batch_name", "provider_batch_request_key",
    "provider_result_sha256", "result_digest_sha256",
  ], "provider binding");
  const retained = exactObject(decision.retained_evidence,
    ["capture_file_sha256", "captured_at", "final_url", "normalized_text_sha256", "text_artifact"],
    "retained evidence");
  exactObject(retained.text_artifact,
    ["bucket", "bytes", "key", "r2_verified_at", "sha256", "store_id"],
    "retained text artifact");
  if (!Array.isArray(decision.exact_quotes)
      || !decision.exact_quotes.length
      || decision.exact_quotes.some((quote) => typeof quote !== "string" || !quote.trim())) {
    fail("Exact decision quotes must be non-empty strings.");
  }
  exactObject(decision.effective_source_classification, [
    "confidence", "cycle_relevance", "evidence_quotes", "exact_evidence_verified", "facts",
    "officialness", "page_type", "reviewed_roles", "source_relevance", "status",
  ], "effective source classification");
  exactObject(decision.source_binding, [
    "expected_existing_admin_review_status", "expected_existing_source_id",
    "expected_existing_updated_at", "normalized_collision_count", "normalized_url", "source_id",
  ], "source binding");
  exactObject(decision.acquisition_binding, [
    "expected_existing_acquisition_count", "expected_existing_acquisition_id",
    "source_acquisition_id",
  ], "acquisition binding");
}

function assertRequestPatchShape(decision) {
  const patch = exactObject(decision.request_patch, [
    "status", "status_reason", "worker_run_id", "created_shared_award_id",
    "created_source_ids", "ai_review_patch", "preserve_provider_raw",
    "preserve_provider_input_binding", "preserve_provider_result_binding",
  ], "request patch");
  if (patch.worker_run_id !== null || patch.created_shared_award_id !== null
      || patch.preserve_provider_raw !== true
      || patch.preserve_provider_input_binding !== true
      || patch.preserve_provider_result_binding !== true) {
    fail("The request patch does not preserve provider evidence or terminal ownership.");
  }
  if (decision.decision === approvedDecision) {
    if (patch.status !== "added"
        || patch.status_reason !== "stage1_baseline_source_added_pending_exact_visual_activation"
        || canonicalJson(patch.created_source_ids) !== canonicalJson([decision.source_binding.source_id])
        || canonicalJson(patch.ai_review_patch?.human_source_disposition)
          !== canonicalJson(decision.acquisition_payload.review_seal.human_source_disposition)) {
      fail("The approved request patch is not terminal or source-bound.");
    }
  } else if (patch.status !== "needs_manual_review"
      || patch.status_reason !== "stage1_human_source_quarantined_role_mismatch"
      || patch.created_source_ids !== null
      || canonicalJson(Object.keys(patch.ai_review_patch || {}).sort())
        !== canonicalJson(["human_quarantine"])
      || canonicalJson(Object.keys(patch.ai_review_patch?.human_quarantine || {}).sort())
        !== canonicalJson([
          "decision", "decision_item_sha256", "evidence_packet_sha256",
          "policy_version", "reviewed_roles",
        ].sort())
      || patch.ai_review_patch?.human_quarantine?.decision !== quarantinedDecision
      || patch.ai_review_patch?.human_quarantine?.decision_item_sha256
        !== decision.decision_item_sha256
      || patch.ai_review_patch?.human_quarantine?.evidence_packet_sha256
        !== STAGE1_BASELINE_EVIDENCE_PACKET_SHA256
      || patch.ai_review_patch?.human_quarantine?.policy_version
        !== STAGE1_BASELINE_SOURCE_DISPOSITION_POLICY
      || canonicalJson(patch.ai_review_patch?.human_quarantine?.reviewed_roles)
        !== canonicalJson(decision.reviewed_role_binding.reviewed_roles)) {
    fail("The quarantined request patch is malformed.");
  }
}

function buildSourcePayload({ request, source, effective, sourceTitle, monitoringApproval, builtAt }) {
  const existing = source.existing_source;
  const pageType = [
    "homepage", "deadline", "application", "eligibility", "requirements", "pdf", "faq", "other",
  ].includes(effective.page_type) ? effective.page_type : "other";
  const confidence = effective.confidence === "high" ? 0.9 : 0.65;
  const existingMetadata = existing ? object(existing.page_metadata || {}, "existing source metadata") : {};
  const {
    baseline_facts: ignoredBaselineFacts,
    baseline_facts_metadata: ignoredBaselineFactsMetadata,
    ...safeExistingMetadata
  } = existingMetadata;
  void ignoredBaselineFacts;
  void ignoredBaselineFactsMetadata;
  return {
    id: source.source_id,
    shared_award_id: request.matched_shared_award_id,
    url: request.normalized_url,
    title: existing?.title || sourceTitle,
    display_title: existing?.display_title ?? sourceTitle,
    page_description: existing?.page_description ?? null,
    page_type: existing?.page_type || pageType,
    confidence: existing?.confidence ?? confidence,
    reason: existing?.reason
      ?? "Approved for Stage 1 monitoring only; no public fact authority.",
    source: existing?.source || "admin",
    submitted_by_user_id: request.user_id || null,
    page_metadata: {
      ...jsonClone(safeExistingMetadata),
      stage1_baseline_monitoring_approval: monitoringApproval,
    },
    page_metadata_generated_at: builtAt,
    page_metadata_model: "stage1-baseline-source-disposition-v1",
    last_error: null,
    consecutive_failures: 0,
  };
}

function normalizeFreshRow(value, requestId) {
  const row = object(value, `fresh row ${requestId}`);
  if (row.id !== requestId || row.status !== "needs_manual_review") {
    fail(`Fresh request ${requestId} is no longer in manual review.`);
  }
  timestamp(row.updated_at, `updated_at for ${requestId}`);
  requiredUuid(row.matched_shared_award_id, `matched award for ${requestId}`);
  if (row.acquisition_kind !== "historical_import" || row.notification_mode !== "baseline_only") {
    fail(`Request ${requestId} is not historical baseline-only intake.`);
  }
  requiredText(row.onboarding_batch_id, `onboarding batch for ${requestId}`);
  if (row.created_shared_award_id || (Array.isArray(row.created_source_ids) && row.created_source_ids.length)) {
    fail(`Request ${requestId} already records created production entities.`);
  }
  object(row.capture_metadata, `capture metadata for ${requestId}`);
  object(row.deterministic_review, `deterministic review for ${requestId}`);
  object(row.ai_review, `AI review for ${requestId}`);
  return jsonClone(row);
}

function validateRetainedEvidence(value, row, requestId) {
  const evidence = object(value, `retained evidence ${requestId}`);
  if (evidence.request_id !== requestId) fail(`Retained evidence belongs to another request.`);
  const identity = normalizedRetainedTextIdentity(evidence.bytes ?? evidence.text);
  const capture = object(row.capture_metadata, `capture metadata ${requestId}`);
  const manifest = object(capture.retained_artifact, `retained artifact ${requestId}`);
  const textArtifact = object(manifest.artifacts?.text, `retained text artifact ${requestId}`);
  const manifestTextHash = requiredSha(manifest.text_hash, "manifest text hash");
  if (identity.retained_semantic_sha256 !== manifestTextHash
      || identity.activation_normalized_sha256 !== manifestTextHash
      || identity.text_length !== Number(manifest.text_length)
      || identity.object_sha256 !== requiredSha(textArtifact.sha256, "text object hash")
      || identity.object_bytes !== Number(textArtifact.byte_length)) {
    fail(`Local retained text for ${requestId} does not match its immutable manifest.`);
  }
  const captureHash = requiredSha(capture.capture_file_hash, `capture hash ${requestId}`);
  if (captureHash !== requiredSha(manifest.file_hash, `manifest file hash ${requestId}`)) {
    fail(`Capture and retained manifest hashes differ for ${requestId}.`);
  }
  const finalUrl = absoluteUrl(capture.canonical_url || capture.final_url || manifest.final_url,
    `final URL ${requestId}`);
  const r2TextArtifact = {
    store_id: requiredText(manifest.r2_store_id, "R2 store id"),
    bucket: requiredText(manifest.r2_bucket, "R2 bucket"),
    key: requiredText(textArtifact.key, "R2 text key"),
    sha256: identity.object_sha256,
    bytes: identity.object_bytes,
    r2_verified_at: timestamp(manifest.r2_verified_at, "R2 verified_at"),
  };
  return {
    request_id: requestId,
    text: identity.text,
    normalized_retained_text_sha256: identity.retained_semantic_sha256,
    activation_normalized_text_sha256: identity.activation_normalized_sha256,
    normalized_retained_text_length: identity.text_length,
    retained_text_object_sha256: identity.object_sha256,
    retained_text_object_bytes: identity.object_bytes,
    r2_text_artifact: r2TextArtifact,
    capture_file_sha256: captureHash,
    final_url: finalUrl,
    captured_at: timestamp(capture.captured_at || manifest.captured_at, "captured_at"),
    exact_local_bytes_verified: true,
  };
}

function validateProviderBinding(row, requestId) {
  const review = object(row.ai_review, `AI review ${requestId}`);
  const raw = object(review.raw, `provider raw result ${requestId}`);
  const input = object(review.provider_input_binding, `provider input binding ${requestId}`);
  const result = object(review.provider_result_binding, `provider result binding ${requestId}`);
  if (input.request_id !== requestId || result.request_id !== requestId
      || result.provider_batch_request_key !== requestId
      || result.input_digest_sha256 !== input.digest_sha256
      || result.model !== input.model
      || result.provider_result_sha256 !== sha256(canonicalJson(raw))) {
    fail(`Provider raw/result binding is invalid for ${requestId}.`);
  }
  return {
    input_digest_sha256: requiredSha(input.digest_sha256, "provider input digest"),
    result_digest_sha256: requiredSha(result.digest_sha256, "provider result digest"),
    provider_result_sha256: requiredSha(result.provider_result_sha256, "provider result hash"),
    model: requiredText(result.model, "provider model"),
    provider_batch_name: requiredText(result.provider_batch_name, "provider batch name"),
    provider_batch_request_key: result.provider_batch_request_key,
  };
}

function validateQuotes(values, text, requestId) {
  const quotes = array(values, `quotes for ${requestId}`).map((value) => {
    const quote = exactObject(value, ["start", "end", "text"], `quote for ${requestId}`);
    const start = nonNegativeInteger(quote.start, "quote start");
    const end = nonNegativeInteger(quote.end, "quote end");
    const quoteText = requiredText(quote.text, "quote text");
    if (end <= start || text.slice(start, end) !== quoteText
        || text.indexOf(quoteText) !== start || text.lastIndexOf(quoteText) !== start) {
      fail(`An exact quote is absent, non-unique, or offset-mismatched for ${requestId}.`);
    }
    return { start, end, text: quoteText, sha256: sha256(quoteText) };
  });
  if (!quotes.length) fail(`At least one exact quote is required for ${requestId}.`);
  return quotes;
}

function normalizeEffectiveClassification(value, quotes, roles, decision) {
  const review = object(value, "effective source classification");
  const facts = object(review.facts, "effective facts");
  const emptyFacts = {
    description: null,
    deadline: null,
    amount: null,
    eligibility: [],
    application_materials: [],
    important_dates: [],
  };
  if (canonicalJson(facts) !== canonicalJson(emptyFacts)) {
    fail("A source-only disposition must keep every effective fact empty.");
  }
  if (decision === approvedDecision && review.status !== "accepted") {
    fail("An approved source needs an effective accepted source classification.");
  }
  if (decision === approvedDecision
      && !["evergreen", "current_or_upcoming"].includes(review.cycle_relevance)) {
    fail("An approved source needs evergreen or current/upcoming cycle relevance.");
  }
  return {
    status: requiredText(review.status, "effective status"),
    source_relevance: requiredText(review.source_relevance, "effective source relevance"),
    cycle_relevance: requiredText(review.cycle_relevance, "effective cycle relevance"),
    officialness: requiredText(review.officialness, "effective officialness"),
    confidence: requiredText(review.confidence, "effective confidence"),
    page_type: requiredText(review.page_type, "effective page type"),
    evidence_quotes: [...quotes],
    exact_evidence_verified: true,
    reviewed_roles: roles,
    facts: emptyFacts,
  };
}

function normalizeSourceBinding(value, request, decision) {
  const binding = object(value, `source binding ${request.id}`);
  assertOnlyKeys(binding, [
    "request_id", "source_id", "normalized_url", "normalized_collision_count",
    "expected_existing_source_id", "expected_existing_admin_review_status",
    "expected_existing_updated_at", "existing_source",
  ], `source binding ${request.id}`);
  if (binding.request_id !== request.id || binding.normalized_url !== request.normalized_url) {
    fail("Source binding belongs to another request or URL.");
  }
  const collisions = nonNegativeInteger(binding.normalized_collision_count, "source collision count");
  if (decision === quarantinedDecision) {
    if (collisions !== 0 || binding.source_id !== null
        || binding.expected_existing_source_id !== null
        || binding.expected_existing_admin_review_status !== null
        || binding.expected_existing_updated_at !== null
        || binding.existing_source != null) fail("Quarantined source binding must be empty.");
    return {
      source_id: null,
      normalized_url: request.normalized_url,
      normalized_collision_count: 0,
      expected_existing_source_id: null,
      expected_existing_admin_review_status: null,
      expected_existing_updated_at: null,
      existing_source: null,
    };
  }
  const sourceId = requiredUuid(binding.source_id, "source id");
  if (binding.expected_existing_source_id == null) {
    if (collisions !== 0 || sourceId !== stage1BaselinePlannedSourceId(request.id)
        || binding.expected_existing_admin_review_status !== null
        || binding.expected_existing_updated_at !== null || binding.existing_source != null) {
      fail("A new source must carry its deterministic no-collision binding.");
    }
    return {
      source_id: sourceId,
      normalized_url: request.normalized_url,
      normalized_collision_count: 0,
      expected_existing_source_id: null,
      expected_existing_admin_review_status: null,
      expected_existing_updated_at: null,
      existing_source: null,
    };
  }
  const existingId = requiredUuid(binding.expected_existing_source_id, "existing source id");
  const existing = object(binding.existing_source, "existing source row");
  if (collisions !== 1 || sourceId !== existingId || existing.id !== existingId
      || existing.shared_award_id !== request.matched_shared_award_id
      || normalizedUrlKey(existing.url) !== normalizedUrlKey(request.normalized_url)
      || binding.expected_existing_admin_review_status !== existing.admin_review_status
      || binding.expected_existing_updated_at !== existing.updated_at) {
    fail("The exact existing source binding changed.");
  }
  timestamp(binding.expected_existing_updated_at, "existing source updated_at");
  return {
    source_id: sourceId,
    normalized_url: request.normalized_url,
    normalized_collision_count: 1,
    expected_existing_source_id: existingId,
    expected_existing_admin_review_status: binding.expected_existing_admin_review_status,
    expected_existing_updated_at: binding.expected_existing_updated_at,
    existing_source: jsonClone(existing),
  };
}

function normalizeAcquisitionBinding(value, requestId, decision) {
  const binding = exactObject(value, [
    "request_id", "source_acquisition_id", "expected_existing_acquisition_count",
    "expected_existing_acquisition_id",
  ], `acquisition binding ${requestId}`);
  if (binding.request_id !== requestId
      || nonNegativeInteger(binding.expected_existing_acquisition_count,
        "existing acquisition count") !== 0
      || binding.expected_existing_acquisition_id !== null) {
    fail("Every reviewed source must begin without an acquisition.");
  }
  const id = decision === quarantinedDecision
    ? binding.source_acquisition_id
    : requiredUuid(binding.source_acquisition_id, "source acquisition id");
  if (decision === quarantinedDecision ? id !== null
    : id !== stage1BaselinePlannedAcquisitionId(requestId)) {
    fail("The acquisition binding is not the exact deterministic identity.");
  }
  return {
    source_acquisition_id: id,
    expected_existing_acquisition_count: 0,
    expected_existing_acquisition_id: null,
  };
}

function retainedPlanEvidence(value) {
  return {
    capture_file_sha256: value.capture_file_sha256,
    normalized_text_sha256: value.normalized_retained_text_sha256,
    final_url: value.final_url,
    captured_at: value.captured_at,
    text_artifact: value.r2_text_artifact,
  };
}

function publicSourceBinding(value) {
  const { existing_source: ignored, ...binding } = value;
  void ignored;
  return binding;
}

function exactByRequest(values, label, key = "request_id") {
  const list = array(values, label);
  if (list.length !== 11) fail(`${label} must contain exactly 11 rows.`);
  const map = new Map();
  for (const value of list) {
    const id = requiredUuid(value?.[key], `${label} request id`);
    if (map.has(id)) fail(`${label} contains duplicate request ${id}.`);
    map.set(id, value);
  }
  if (STAGE1_BASELINE_REQUEST_IDS.some((id) => !map.has(id))) {
    fail(`${label} does not match the exact reviewed request set.`);
  }
  return map;
}

function sortedUniqueText(value, label) {
  const values = array(value, label).map((item) => requiredText(item, label)).sort();
  if (!values.length || new Set(values).size !== values.length) fail(`${label} must be non-empty and unique.`);
  return values;
}

function sortedOptionalText(value) {
  if (value == null) return [];
  const values = array(value, "optional reviewed roles")
    .map((item) => requiredText(item, "optional reviewed role"))
    .sort();
  if (new Set(values).size !== values.length) fail("Optional reviewed roles must be unique.");
  return values;
}

function assertOnlyKeys(value, allowedKeys, label) {
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length) fail(`${label} contains unsupported keys: ${unexpected.join(", ")}.`);
}

function deterministicUuid(value) {
  const bytes = Buffer.from(sha256(value), "hex").subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function stage1BaselinePlannedSourceId(requestId) {
  return deterministicUuid(`stage1-baseline-source-disposition:source:${requiredUuid(requestId, "request id")}`);
}

export function stage1BaselinePlannedAcquisitionId(requestId) {
  return deterministicUuid(`stage1-baseline-source-disposition:acquisition:${requiredUuid(requestId, "request id")}`);
}

function exactObject(value, keys, label) {
  const result = object(value, label);
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${label} must contain exactly: ${keys.join(", ")}.`);
  }
  return result;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value;
}

function requiredText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) fail(`${label} is required.`);
  return text;
}

function requiredUuid(value, label) {
  const text = requiredText(value, label).toLowerCase();
  if (!uuidPattern.test(text)) fail(`${label} must be a UUID.`);
  return text;
}

function requiredSha(value, label) {
  const text = requiredText(value, label).toLowerCase();
  if (!shaPattern.test(text)) fail(`${label} must be a SHA-256.`);
  return text;
}

function timestamp(value, label) {
  const text = requiredText(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    fail(`${label} must be a canonical ISO timestamp.`);
  }
  return text;
}

function absoluteUrl(value, label) {
  const text = requiredText(value, label);
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol) || !url.host || url.username || url.password) {
      throw new Error("invalid");
    }
  } catch {
    fail(`${label} must be an absolute public HTTP(S) URL.`);
  }
  return text;
}

function normalizedUrlKey(value) {
  const text = absoluteUrl(value, "source URL");
  const url = new URL(text);
  url.hash = "";
  return url.toString().replace(/\/$/, "").toLowerCase();
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail(`${label} must be a non-negative integer.`);
  return number;
}

function asBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  fail("Retained evidence must provide UTF-8 bytes or text.");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message) {
  throw new Error(message);
}
