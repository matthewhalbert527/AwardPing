import {
  assertStage1EvidenceSchemaUpgradeR2BindingReceipt,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";

export const STAGE1_LEGACY_EMPTY_EXPANSION_LENGTH_BRIDGE_SCHEMA =
  "awardping.stage1.legacy-empty-expansion-length-bridge.v1";

const emptyTextSha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const sha256Pattern = /^[a-f0-9]{64}$/u;
const r2RoleContract = Object.freeze({
  layout: Object.freeze({ fileName: "layout.json", contentType: "application/json; charset=utf-8" }),
  meta: Object.freeze({ fileName: "meta.json", contentType: "application/json; charset=utf-8" }),
  page: Object.freeze({ fileName: "page.jpg", contentType: "image/jpeg" }),
  text: Object.freeze({ fileName: "text.txt", contentType: "text/plain; charset=utf-8" }),
  thumb: Object.freeze({ fileName: "thumb.jpg", contentType: "image/jpeg" }),
});
const exactComparableSemanticFields = Object.freeze([
  Object.freeze(["text_hash", "text_length"]),
  Object.freeze(["body_text_hash", "body_text_length"]),
  Object.freeze(["main_content_hash", "main_content_text_length"]),
  Object.freeze(["nav_header_footer_hash", "nav_header_footer_text_length"]),
]);

// These are the seven exact reviewed Aug-3 source/acquisition/generation tuples
// whose legacy baseline serializer converted a truthful numeric zero to null.
// No other source or generation can enter this compatibility path.
const reviewedSourceGenerations = Object.freeze({
  "c30778fe-43d7-57be-842a-e046d84baaee": reviewedIdentity({
    sourceId: "c30778fe-43d7-57be-842a-e046d84baaee",
    capturedAt: "2026-08-03T18:37:29.113Z",
    observedFinalUrl: "https://beineckescholarship.org/about/about-beinecke-scholarship/",
    reviewedFinalUrl: "https://beineckescholarship.org/about/about-beinecke-scholarship",
    acquisitionId: "e255168b-2cd5-5029-b308-aeb8bfbff640",
    requestId: "62a291a2-e64d-5788-a876-f2dca551a021",
    acquisitionFileSha256:
      "00c37464146de6bfc18378ed8d772eebaaf60a25d98a0492ac78fe77c7311f87",
    acquisitionNormalizedTextSha256:
      "3de355be157fec2f2efee9b6ce2b234999321a6b1b056743e1b20a8b5f32d68f",
    immutableGeneration: "4e5177099a379e812c86c70374f284a1",
  }),
  "af1367b5-0cb0-5b21-8e78-7dc195dd996f": reviewedIdentity({
    sourceId: "af1367b5-0cb0-5b21-8e78-7dc195dd996f",
    capturedAt: "2026-08-03T18:38:42.518Z",
    observedFinalUrl: "https://beineckescholarship.org/beinecke-scholarship/submission-materials/",
    reviewedFinalUrl: "https://beineckescholarship.org/beinecke-scholarship/submission-materials",
    acquisitionId: "2db19d37-a300-5892-ba43-34e6d0499d16",
    requestId: "2bd3018c-d1b6-5d39-85ed-ea278e9d3702",
    acquisitionFileSha256:
      "820abfa159de84af70a842f42cc5a798135dd79af6f5927df4adb026d6e00369",
    acquisitionNormalizedTextSha256:
      "e76c960b8897d29d7a89b243f8a0c763d098f267e2f08dbcf754d0b30fd09764",
    immutableGeneration: "6e19393aa4606b78e67e8bcb53678e8d",
  }),
  "b9407ce4-71f8-5c97-8f98-8466d640d4de": reviewedIdentity({
    sourceId: "b9407ce4-71f8-5c97-8f98-8466d640d4de",
    capturedAt: "2026-08-03T18:49:32.800Z",
    observedFinalUrl: "https://us.fulbrightonline.org/about/competition-selection",
    reviewedFinalUrl: "https://us.fulbrightonline.org/about/competition-selection",
    acquisitionId: "81af9955-db30-588e-beb5-f4521af210fd",
    requestId: "27ad713b-0332-59e6-b28b-44b9ff631bc1",
    acquisitionFileSha256:
      "e2e5a7a1713d85dec1766b2cd91a429cd8816b190d9d367cff551a2ded3b1a7f",
    acquisitionNormalizedTextSha256:
      "2d0cfa8d1fbc506b01c48682e55cbfb20bf0ea3c22a31c5921d3f26a30e2d409",
    immutableGeneration: "4de055bf05e2a3297611b6dae0c766f8",
  }),
  "5ec9a453-fd62-53e5-b885-726b21ce7247": reviewedIdentity({
    sourceId: "5ec9a453-fd62-53e5-b885-726b21ce7247",
    capturedAt: "2026-08-03T18:50:08.220Z",
    observedFinalUrl: "https://www.hertzfoundation.org/hertz-fellowship/",
    reviewedFinalUrl: "https://www.hertzfoundation.org/hertz-fellowship",
    acquisitionId: "e4bc069b-2d06-52e6-86ba-9ce31a794eb1",
    requestId: "fd02cb92-8ab6-553f-8e31-752802ac4641",
    acquisitionFileSha256:
      "abadec1d8e6ae09e39d5b6cf8cc9dcfd9dff1881f69e0f1377732b3fa0833489",
    acquisitionNormalizedTextSha256:
      "1845b180a749277991475b093727d19056bf3748ecca8fef02f1be15179de36e",
    immutableGeneration: "5f5343251530f3662707a98d2e9ae4d3",
  }),
  "fa4088a7-706e-4ad3-ae12-3653751dd5e1": reviewedIdentity({
    sourceId: "fa4088a7-706e-4ad3-ae12-3653751dd5e1",
    capturedAt: "2026-08-03T18:50:42.281Z",
    observedFinalUrl: "https://ndseg.org/",
    reviewedFinalUrl: "https://ndseg.org/",
    acquisitionId: "aa987edb-9983-50b9-ac7b-43fb7b5c78e3",
    requestId: "a97507bf-295a-5a81-99e5-4516f96c9612",
    acquisitionFileSha256:
      "6aaea5fc1614c8fb235dde333e360b39caf336edf5be1f1a2d5ab7c3dc8acbdd",
    acquisitionNormalizedTextSha256:
      "d6d39f2d4e7df73b129ee50b779870b048fa7a04874e1f9da4f4eeede8caced1",
    immutableGeneration: "5d67bad4e40a98003fd8776d9d21e49b",
  }),
  "664d38ba-c717-5d51-b7ce-9e3a27f41fec": reviewedIdentity({
    sourceId: "664d38ba-c717-5d51-b7ce-9e3a27f41fec",
    capturedAt: "2026-08-03T18:51:38.842Z",
    observedFinalUrl: "https://samvidscholars.org/",
    reviewedFinalUrl: "https://samvidscholars.org/",
    acquisitionId: "269420c2-d49c-5812-a3ec-6726598703af",
    requestId: "2cd2f427-753f-5de7-ab0b-616502b287b7",
    acquisitionFileSha256:
      "a22338c989776633fbc926977231ebd55a580878b8ad0811e0699231d08788b9",
    acquisitionNormalizedTextSha256:
      "cc3f11f8b812fb95f8c354ab899a768ef440d9c107eada7abc3823624102e1a4",
    immutableGeneration: "ce26f96c6e6066a600aa80633475405f",
  }),
  "c28878c0-6a8b-5fa8-b99b-ec826b86d8f2": reviewedIdentity({
    sourceId: "c28878c0-6a8b-5fa8-b99b-ec826b86d8f2",
    capturedAt: "2026-08-03T18:52:22.287Z",
    observedFinalUrl:
      "https://yenchingacademy.pku.edu.cn/ADMISSIONS/Frequently_Asked_Questions.htm",
    reviewedFinalUrl:
      "https://yenchingacademy.pku.edu.cn/ADMISSIONS/Frequently_Asked_Questions.htm",
    acquisitionId: "ea995f9c-3f67-5853-a3e8-8c4694ee321d",
    requestId: "4952d327-4fa5-53a0-8247-dd029f7f2c2c",
    acquisitionFileSha256:
      "ab5130cf35d3824312beec7d7013b32d9b96afd4e5cfa1b2786f2dfb2c02d44e",
    acquisitionNormalizedTextSha256:
      "b6e3e5a13e333b70d0de68a3d9d764204cb958b4404bceebb712109b59cc7eb1",
    immutableGeneration: "5113a102940512068c7e51ccbc5cb371",
  }),
});

export const STAGE1_LEGACY_EMPTY_EXPANSION_LENGTH_SOURCE_IDS = Object.freeze(
  Object.keys(reviewedSourceGenerations),
);

/**
 * Exact compatibility proof for a single legacy serializer defect: JavaScript
 * `value || null` converted an authoritative numeric zero to null in the local
 * baseline. This is not semantic equivalence authority. All other semantic
 * fields, the empty expansion hash, the sealed acquisition, and the exact
 * local/R2 generation must already agree.
 */
export function evaluateStage1LegacyEmptyExpansionLengthBridge(input = {}) {
  const exactInputSourceId = Object.hasOwn(input, "exactSourceId")
    ? input.exactSourceId
    : input.sourceId;
  const identity = reviewedSourceGenerations[exactInputSourceId];
  if (!identity) {
    return {
      applies: false,
      accepted: false,
      reason: "source_generation_not_allowlisted",
      evidence: null,
    };
  }

  try {
    const baseline = objectValue(input.existingBaseline);
    const capture = objectValue(input.existingCaptureIdentity);
    const activation = objectValue(baseline.summary_metadata?.stage1_baseline_activation);
    const sealed = objectValue(input.sealedAcquisition);

    assert(input.sourceId === identity.sourceId, "source_not_allowlisted");
    assert(exactInputSourceId === identity.sourceId, "exact_source_not_allowlisted");
    assert(input.kind === "webpage", "kind_not_allowlisted");
    assert(input.reviewedFinalUrl === identity.reviewedFinalUrl, "reviewed_final_url_not_allowlisted");
    assertExactCaptureEnvelope({ baseline, capture, identity });
    assertExactAcquisitionEnvelope({
      activation,
      activationGuardSha256: input.activationGuardSha256,
      sealed,
      identity,
    });
    assertLegacyEmptyExpansionShape({ baseline, capture });
    assertR2Authority(input.authoritativeR2Binding, identity, capture);

    const receipt = input.authoritativeR2Binding;
    return {
      applies: true,
      accepted: true,
      reason: "exact_source_bound_legacy_empty_expansion_length_verified",
      evidence: {
        schema: STAGE1_LEGACY_EMPTY_EXPANSION_LENGTH_BRIDGE_SCHEMA,
        source_id: identity.sourceId,
        kind: "webpage",
        reviewed_final_url: identity.reviewedFinalUrl,
        observed_final_url: identity.observedFinalUrl,
        legacy_capture_timestamp: identity.capturedAt,
        source_acquisition_id: identity.acquisitionId,
        source_page_request_id: identity.requestId,
        immutable_generation: identity.immutableGeneration,
        r2_binding_receipt_sha256: receipt.receipt_sha256,
        r2_pointer_sha256: receipt.pointer_identity.pointer_sha256,
        repaired_field: "expansion_text_length",
        legacy_baseline_value: null,
        authoritative_retained_value: 0,
        expansion_text_sha256: emptyTextSha256,
        expansion_state_count: 0,
        producer_defect: "javascript_falsy_zero_serialized_as_null",
        exact_other_semantic_fields_verified: true,
        limitations: [
          "compatibility_bridge_scoped_to_seven_reviewed_source_acquisition_generation_tuples",
          "only_null_to_zero_empty_expansion_length_representation_is_repaired",
          "nonempty_unknown_or_unbound_expansion_evidence_remains_a_hard_failure",
          "compatibility_evidence_is_not_acquisition_semantic_scope_or_promotion_authority",
        ],
      },
    };
  } catch (error) {
    return {
      applies: true,
      accepted: false,
      reason: cleanText(error?.message) || "legacy_empty_expansion_length_bridge_invalid",
      evidence: null,
    };
  }
}

function assertExactCaptureEnvelope({ baseline, capture, identity }) {
  const capturePrefix =
    `sources/${identity.sourceId}/captures/${captureTimestampDirectory(identity.capturedAt)}/`;
  assert(baseline.kind === "webpage" && capture.kind === "webpage", "capture_kind_not_allowlisted");
  assert(baseline.source?.id === identity.sourceId, "baseline_source_not_allowlisted");
  assert(capture.source?.id === identity.sourceId, "capture_source_not_allowlisted");
  assert(baseline.captured_at === identity.capturedAt, "baseline_timestamp_not_allowlisted");
  assert(capture.captured_at === identity.capturedAt, "capture_timestamp_not_allowlisted");
  assert(baseline.final_url === identity.observedFinalUrl, "baseline_final_url_not_allowlisted");
  assert(capture.final_url === identity.observedFinalUrl, "capture_final_url_not_allowlisted");
  assert(
    normalizedPath(baseline.capture?.meta) === `${capturePrefix}meta.json`,
    "baseline_meta_generation_not_allowlisted",
  );
  assert(
    normalizedPath(baseline.capture?.text) === `${capturePrefix}text.txt`,
    "baseline_text_generation_not_allowlisted",
  );
  assert(
    normalizedPath(capture.meta_path).endsWith(`/${capturePrefix}meta.json`),
    "capture_meta_generation_not_allowlisted",
  );
  assert(
    normalizedPath(capture.text_path).endsWith(`/${capturePrefix}text.txt`),
    "capture_text_generation_not_allowlisted",
  );
}

function assertExactAcquisitionEnvelope({
  activation,
  activationGuardSha256,
  sealed,
  identity,
}) {
  assert(sealed.final_url_exact === identity.reviewedFinalUrl, "sealed_final_url_not_allowlisted");
  assert(sealed.source_acquisition_id_exact === identity.acquisitionId, "acquisition_id_not_allowlisted");
  assert(sealed.request_id_exact === identity.requestId, "request_id_not_allowlisted");
  assert(sealed.file_hash_exact === identity.acquisitionFileSha256, "acquisition_file_hash_not_allowlisted");
  assert(
    sealed.normalized_text_hash_exact === identity.acquisitionNormalizedTextSha256,
    "acquisition_normalized_text_hash_not_allowlisted",
  );
  assert(sha256Pattern.test(activationGuardSha256), "activation_guard_hash_invalid");
  assert(activation.status === "server_prepare_recorded", "activation_status_not_allowlisted");
  assert(activation.shared_award_source_id === identity.sourceId, "activation_source_not_allowlisted");
  assert(activation.source_acquisition_id === identity.acquisitionId, "activation_acquisition_not_allowlisted");
  assert(activation.source_page_request_id === identity.requestId, "activation_request_not_allowlisted");
  assert(activation.capture_file_sha256 === identity.acquisitionFileSha256, "activation_file_hash_not_allowlisted");
  assert(
    activation.expected_normalized_text_sha256 === identity.acquisitionNormalizedTextSha256
      && activation.observed_normalized_text_sha256 === identity.acquisitionNormalizedTextSha256,
    "activation_normalized_text_hash_not_allowlisted",
  );
  assert(activation.guard_sha256 === activationGuardSha256, "activation_guard_hash_mismatch");
  assert(activation.reviewed_final_url === identity.reviewedFinalUrl, "activation_reviewed_url_not_allowlisted");
  assert(activation.observed_final_url === identity.observedFinalUrl, "activation_observed_url_not_allowlisted");
  assert(activation.visual_evidence_quotes_verified === true, "activation_visual_quotes_not_verified");
  assert(activation.retained_evidence_quotes_verified === true, "activation_retained_quotes_not_verified");
}

function assertLegacyEmptyExpansionShape({ baseline, capture }) {
  for (const [hashField, lengthField] of exactComparableSemanticFields) {
    assert(Object.hasOwn(baseline, hashField), `baseline_${hashField}_missing`);
    assert(Object.hasOwn(capture, hashField), `capture_${hashField}_missing`);
    assert(sha256Pattern.test(baseline[hashField]), `baseline_${hashField}_invalid`);
    assert(baseline[hashField] === capture[hashField], `${hashField}_mismatch`);
    assert(Object.hasOwn(baseline, lengthField), `baseline_${lengthField}_missing`);
    assert(Object.hasOwn(capture, lengthField), `capture_${lengthField}_missing`);
    assert(nonNegativeInteger(baseline[lengthField]), `baseline_${lengthField}_invalid`);
    assert(baseline[lengthField] === capture[lengthField], `${lengthField}_mismatch`);
  }
  assert(Object.hasOwn(baseline, "expansion_hash"), "baseline_expansion_hash_missing");
  assert(Object.hasOwn(capture, "expansion_hash"), "capture_expansion_hash_missing");
  assert(baseline.expansion_hash === emptyTextSha256, "baseline_expansion_not_empty");
  assert(capture.expansion_hash === emptyTextSha256, "capture_expansion_not_empty");
  assert(Object.hasOwn(baseline, "expandable_sections_hash"), "baseline_sections_hash_missing");
  assert(Object.hasOwn(capture, "expandable_sections_hash"), "capture_sections_hash_missing");
  assert(baseline.expandable_sections_hash === emptyTextSha256, "baseline_sections_not_empty");
  assert(capture.expandable_sections_hash === emptyTextSha256, "capture_sections_not_empty");
  assert(Object.hasOwn(baseline, "expansion_text_length"), "baseline_expansion_length_missing");
  assert(Object.hasOwn(capture, "expansion_text_length"), "capture_expansion_length_missing");
  assert(baseline.expansion_text_length === null, "baseline_expansion_length_not_legacy_null");
  assert(capture.expansion_text_length === 0, "capture_expansion_length_not_authoritative_zero");
  assert(baseline.capture?.expansion_text === null, "baseline_expansion_text_artifact_present");
  assert(capture.expansion_text_path == null, "capture_expansion_text_artifact_present");
  assert(
    Array.isArray(baseline.capture?.expansion_states)
      && baseline.capture.expansion_states.length === 0,
    "baseline_expansion_states_present",
  );
  assert(
    Array.isArray(capture.expansion_state_screenshots)
      && capture.expansion_state_screenshots.length === 0,
    "capture_expansion_states_present",
  );
}

function assertR2Authority(receipt, identity, capture) {
  try {
    assertStage1EvidenceSchemaUpgradeR2BindingReceipt(receipt);
  } catch {
    throw new Error("r2_binding_receipt_invalid");
  }
  const pointer = objectValue(receipt.pointer_identity);
  const roles = Array.isArray(receipt.verified_roles) ? receipt.verified_roles : [];
  const expectedRoles = Object.keys(r2RoleContract).sort();
  const suppliedRoles = roles.map((role) => role?.role).sort();
  const objectKeys = objectValue(pointer.latest_object_keys);
  const latestHashes = objectValue(pointer.latest_hashes);
  const prefix =
    `visual-snapshots/sources/${identity.sourceId}/captures/${identity.immutableGeneration}/`;

  assert(receipt.source_id === identity.sourceId, "r2_receipt_source_not_allowlisted");
  assert(receipt.kind === "webpage", "r2_receipt_kind_not_allowlisted");
  assert(receipt.captured_at === identity.capturedAt, "r2_receipt_timestamp_not_allowlisted");
  assert(pointer.shared_award_source_id === identity.sourceId, "r2_pointer_source_not_allowlisted");
  assert(pointer.kind === "webpage", "r2_pointer_kind_not_allowlisted");
  assert(pointer.bucket === "awardping-snapshots", "r2_pointer_bucket_not_allowlisted");
  assert(timestampIso(pointer.latest_captured_at) === identity.capturedAt, "r2_pointer_timestamp_not_allowlisted");
  assert(pointer.immutable_generation === identity.immutableGeneration, "r2_generation_not_allowlisted");
  assert(sameStrings(suppliedRoles, expectedRoles), "r2_role_set_not_allowlisted");
  assert(sameStrings(Object.keys(objectKeys).sort(), expectedRoles), "r2_object_key_set_not_allowlisted");
  assert(
    receipt.artifact_binding_verification?.status
      === "derived_from_exact_local_and_remote_bytes"
      && receipt.artifact_binding_verification?.pointer_claim_present === false
      && receipt.artifact_binding_verification?.derived_binding_count === expectedRoles.length,
    "r2_artifact_binding_verification_not_allowlisted",
  );
  for (const roleName of expectedRoles) {
    const role = roles.find((item) => item?.role === roleName);
    const contract = r2RoleContract[roleName];
    assert(objectKeys[roleName] === `${prefix}${contract.fileName}`, `r2_${roleName}_key_not_allowlisted`);
    assert(role?.key === objectKeys[roleName], `r2_${roleName}_role_key_mismatch`);
    assert(sha256Pattern.test(role?.sha256), `r2_${roleName}_role_hash_invalid`);
    assert(Number.isSafeInteger(role?.byte_length) && role.byte_length > 0, `r2_${roleName}_role_length_invalid`);
    assert(role?.content_type === contract.contentType, `r2_${roleName}_content_type_not_allowlisted`);
    assert(role?.remote_body_verified === true, `r2_${roleName}_remote_body_not_verified`);
  }
  for (const hashField of [
    "body_text_hash",
    "expansion_hash",
    "image_hash",
    "layout_hash",
    "main_content_hash",
    "nav_header_footer_hash",
    "text_hash",
  ]) {
    assert(latestHashes[hashField] === capture[hashField], `r2_${hashField}_mismatch`);
  }
  assert(Object.hasOwn(latestHashes, "file_hash") && latestHashes.file_hash === null, "r2_file_hash_invalid");
  assert(receipt.semantic_text?.sha256 === capture.text_hash, "r2_semantic_text_hash_mismatch");
  assert(
    receipt.semantic_text?.character_length === capture.text_length,
    "r2_semantic_text_length_mismatch",
  );
  assert(receipt.semantic_text?.writer_framing === "lf", "r2_semantic_text_framing_invalid");
}

function reviewedIdentity(value) {
  return Object.freeze(value);
}

function captureTimestampDirectory(value) {
  return new Date(value).toISOString().replace(/[:.]/gu, "-");
}

function timestampIso(value) {
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizedPath(value) {
  return cleanText(value).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function assert(condition, reason) {
  if (!condition) throw new Error(reason);
}
