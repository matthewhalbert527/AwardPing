import { createHash } from "node:crypto";
import { isR2CaptureGeometryReady } from "./r2-capture-artifact-bindings.mjs";
import {
  assertStage1EvidenceSchemaUpgradeR2BindingReceipt,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";
import {
  sha256VisualSemanticValue,
  verifyVisualTextGeometryBinding,
  visualTextGeometryLayoutFingerprint,
} from "./visual-event-localization.mjs";

export const STAGE1_PRE_1FC005C_LEGACY_GEOMETRY_BRIDGE_SCHEMA =
  "awardping.stage1.exact-six-pre-1fc005c-legacy-geometry-bridge.v1";

const contentType = "application/json; charset=utf-8";
const producerBoundaryCommit = "1fc005c9bc99b52bcbd5b99fe699386fef361692";
const exactR2Roles = Object.freeze(["layout", "meta", "page", "text", "thumb"]);
const r2RoleFiles = Object.freeze({
  layout: "layout.json",
  meta: "meta.json",
  page: "page.jpg",
  text: "text.txt",
  thumb: "thumb.jpg",
});

const exactCaptureTuples = deepFreeze([
  {
    sourceId: "c30778fe-43d7-57be-842a-e046d84baaee",
    reviewedSource: "Beinecke Scholarship — About",
    reviewedFinalUrl:
      "https://beineckescholarship.org/about/about-beinecke-scholarship",
    observedFinalUrl:
      "https://beineckescholarship.org/about/about-beinecke-scholarship/",
    capturedAt: "2026-08-03T18:37:29.113Z",
    captureDirectory: "2026-08-03T18-37-29-113Z",
    generation: "4e5177099a379e812c86c70374f284a1",
    receiptSha256:
      "371e3e0277be563cdf436da79c4d802671b73f4c2bee293586e1b1f6c3fec3e7",
    pointerSha256:
      "59bc18f7988d0f7cdcbfba3fe56afe4e7fe25b1af33b51e770e515bddb87d9c2",
    layoutBodySha256:
      "b26c82d4a2aec3fbf9075c1f647eeaf0d09dbc5a0f2885daa0089b06ebf21613",
    layoutByteLength: 69011,
    geometrySha256:
      "9e4fe523b5358dbf44b076a5c7bbf4d012ebb9c739f64b851b994ff583c21d51",
    imageSha256:
      "f7f0f55c74049b93aa1bda105bd049761161a920f1ce32dfbcd4bb8cdf615d22",
    storedProofSha256:
      "eda0c3c655260f9e0872fe840fe6059f8ebb82c5a29a4e4eb27c283246281404",
    currentFingerprintSha256:
      "988da7718d198e25bb23af2751838c874f25aeff6380ceeab4d048836b02e880",
    reconstructedNodesSha256:
      "15cc33d73975c0d4d4f2307757c1f426602d5077850958143a7d61a7ffcd6c7f",
    rectCount: 201,
    changedRightCount: 44,
    changedBottomCount: 0,
    nodeCount: 13,
    runCount: 179,
    document: { width: 1365, height: 3727 },
    viewport: { width: 1365, height: 1600 },
  },
  {
    sourceId: "af1367b5-0cb0-5b21-8e78-7dc195dd996f",
    reviewedSource: "Beinecke Scholarship — Submission Materials",
    reviewedFinalUrl:
      "https://beineckescholarship.org/beinecke-scholarship/submission-materials",
    observedFinalUrl:
      "https://beineckescholarship.org/beinecke-scholarship/submission-materials/",
    capturedAt: "2026-08-03T18:38:42.518Z",
    captureDirectory: "2026-08-03T18-38-42-518Z",
    generation: "6e19393aa4606b78e67e8bcb53678e8d",
    receiptSha256:
      "27d02546096258474775961835a7b8cffdc85d30bf0ad6bb5c31feb5a654203a",
    pointerSha256:
      "133ef459d95e7eaa87b8b4c6b26bc28d52991410c68685e3427aa61b72971793",
    layoutBodySha256:
      "eb9fe9475bac43b7a2deed14a4b00e163a04083aabe6e47cb413ebe8f28c5401",
    layoutByteLength: 20689,
    geometrySha256:
      "721e69b94798a3e9c36ff74e6079371279f01365271070054444fe6d6f32a514",
    imageSha256:
      "4ef59e4caba60afe85f971814ff72c2ac8be6a16d75dfe56789bbaac223a2ba4",
    storedProofSha256:
      "ad8e428c53f027a6224d310ca63e4df8e15ee7587578747144666d36490dacd7",
    currentFingerprintSha256:
      "82287eff84c28e0b3326fa825f573ed5a3110306e9ee5c129291357b380e990f",
    reconstructedNodesSha256:
      "cf853e1c9e02857ad148a7f3be0d0ac6f7fd4c498ca499ca840f0d62771637af",
    rectCount: 55,
    changedRightCount: 14,
    changedBottomCount: 0,
    nodeCount: 8,
    runCount: 46,
    document: { width: 1365, height: 1600 },
    viewport: { width: 1365, height: 1600 },
  },
  {
    sourceId: "5ec9a453-fd62-53e5-b885-726b21ce7247",
    reviewedSource: "Fannie and John Hertz Foundation",
    reviewedFinalUrl: "https://www.hertzfoundation.org/hertz-fellowship",
    observedFinalUrl: "https://www.hertzfoundation.org/hertz-fellowship/",
    capturedAt: "2026-08-03T18:50:08.220Z",
    captureDirectory: "2026-08-03T18-50-08-220Z",
    generation: "5f5343251530f3662707a98d2e9ae4d3",
    receiptSha256:
      "13732924ecfb830b29c650a3f5080ea455941826358d1c81e5385607b5c19e45",
    pointerSha256:
      "c0ca2630a0b5f7fa9355b2c3690a206359bbd13b96e643d93d93f833b6e3cb0d",
    layoutBodySha256:
      "c94b60ad87d47efaa30e30255c93f2aff99122e7797ac9a1229c28bd558c1494",
    layoutByteLength: 220679,
    geometrySha256:
      "15827850c266d7c77d8d1717e936fafa31c6a7178f72cb992d6f953720cfcd15",
    imageSha256:
      "aad77f909e8ad56fc5f4507446f99161c16c7fd43c759a8af06ec27e2ca236e9",
    storedProofSha256:
      "c64e0200424a630da4852ddd9671c844986ef3f1dcc258f4f27c1b92277ba1dc",
    currentFingerprintSha256:
      "9566afef98c56d5f58bbbaa182359d62aba595336f3793234e31db2151469fb3",
    reconstructedNodesSha256:
      "80ffc48c60b5190a64db10980a018ae7f0b5ac63ecb3df903e5003fee6e74f2b",
    rectCount: 651,
    changedRightCount: 131,
    changedBottomCount: 0,
    nodeCount: 50,
    runCount: 562,
    document: { width: 1365, height: 7141 },
    viewport: { width: 1365, height: 1600 },
  },
  {
    sourceId: "fa4088a7-706e-4ad3-ae12-3653751dd5e1",
    reviewedSource: "National Defense Science and Engineering Graduate Fellowship",
    reviewedFinalUrl: "https://ndseg.org/",
    observedFinalUrl: "https://ndseg.org/",
    capturedAt: "2026-08-03T18:50:42.281Z",
    captureDirectory: "2026-08-03T18-50-42-281Z",
    generation: "5d67bad4e40a98003fd8776d9d21e49b",
    receiptSha256:
      "71a5a98ec5738cd6b1e08f928b9c739030ba057828a3e527c5c3e4396ba6db02",
    pointerSha256:
      "57b1357ef0a23b3e2dce8695efe19fbc4f43bb9cfe0079966a47dacf97aeb44e",
    layoutBodySha256:
      "4d25dd1bb3bb04e60225e382129aa57f6af53c44c7f6613b597eaa3151a594ee",
    layoutByteLength: 58024,
    geometrySha256:
      "42970c801f5df3e5db031286d0b559049f84004254ca7c0e2e6aa6a8b3917a64",
    imageSha256:
      "ebb8ad795ddadb5f464e5aa0f8645b5bed1b8fa7ae4922c27934de4ef9bfd4e8",
    storedProofSha256:
      "217811dc6bc82a76ce1efb7f528e052caacf89d726c85c07bf7261a15ab2bedc",
    currentFingerprintSha256:
      "7a5fef9ccb7a7ff6be3cb4e5672edc70442509cc293763d827d8ac376d08a1ee",
    reconstructedNodesSha256:
      "715f318cbedffefcfa2fb6e6488e5fda1891abddd0884cccad0d6dfa3dde90e1",
    rectCount: 167,
    changedRightCount: 44,
    changedBottomCount: 0,
    nodeCount: 18,
    runCount: 141,
    document: { width: 1365, height: 3256 },
    viewport: { width: 1365, height: 1600 },
  },
  {
    sourceId: "664d38ba-c717-5d51-b7ce-9e3a27f41fec",
    reviewedSource: "Samvid Scholars",
    reviewedFinalUrl: "https://samvidscholars.org/",
    observedFinalUrl: "https://samvidscholars.org/",
    capturedAt: "2026-08-03T18:51:38.842Z",
    captureDirectory: "2026-08-03T18-51-38-842Z",
    generation: "ce26f96c6e6066a600aa80633475405f",
    receiptSha256:
      "fe74a1aac4033e576fb44bb400709d1803b70095ca10e672b64a47fedb59380f",
    pointerSha256:
      "0ceef5de9e7c90d882be01cda3a4689a3b5ab99b46a3b9c251b0715e90028779",
    layoutBodySha256:
      "29b49c8757529d6ea73efd79d58addc8eabb01956f10bf06148d3d27e0b8c5f5",
    layoutByteLength: 8147,
    geometrySha256:
      "a95fbad005fb2569a1f5d6239b52a4097a03b43bfff9dba818f66fa377eb37d7",
    imageSha256:
      "64ef7d1d2652205bc650ea48c7eb74930773eecd921925b7157b93d50cd86ae8",
    storedProofSha256:
      "0334696923ad02b0af9e3debdcb81cfb828dcef5c4ce29a32390f72217eead1f",
    currentFingerprintSha256:
      "06b16b7f8f69e1a46a7c55e5e4042b680283d9fc67faf38aa3a983bf37e0d833",
    reconstructedNodesSha256:
      "553b853df9cded84f3c395e572697e71af53ddf1ec17bb936b3afd76b5a208c5",
    rectCount: 19,
    changedRightCount: 4,
    changedBottomCount: 0,
    nodeCount: 7,
    runCount: 12,
    document: { width: 1365, height: 1600 },
    viewport: { width: 1365, height: 1600 },
  },
  {
    sourceId: "c28878c0-6a8b-5fa8-b99b-ec826b86d8f2",
    reviewedSource: "Yenching Academy — Frequently Asked Questions",
    reviewedFinalUrl:
      "https://yenchingacademy.pku.edu.cn/ADMISSIONS/Frequently_Asked_Questions.htm",
    observedFinalUrl:
      "https://yenchingacademy.pku.edu.cn/ADMISSIONS/Frequently_Asked_Questions.htm",
    capturedAt: "2026-08-03T18:52:22.287Z",
    captureDirectory: "2026-08-03T18-52-22-287Z",
    generation: "5113a102940512068c7e51ccbc5cb371",
    receiptSha256:
      "a310dc5457857a4a65733871fce121a4396cb862676546144a266ac11d396650",
    pointerSha256:
      "7a2e90f751604215b6f2b9650972a7c30cee204a5afe542fa247d10ca5350eff",
    layoutBodySha256:
      "0f3baae288701eeea43b1d3c9347d2afa406fb9a3ca750535f7392da114fe17e",
    layoutByteLength: 811409,
    geometrySha256:
      "703ca4bf17524dd8af0234aaa228f83dcdf122e1180ec3566f0d6974acd23063",
    imageSha256:
      "5bc841a62c782f26453133f335cc8de4a845d07c2f29f076e6faf366f3164d21",
    storedProofSha256:
      "21900ac89daa87a7a747bfbbb68e255e5679afc6feccbaca934da892ffce1d6c",
    currentFingerprintSha256:
      "148f84e6b95732bc7c3c63c66e4a4e233ee731049c9dc1243c5e9267ac086518",
    reconstructedNodesSha256:
      "89cd0960011475d27a32592b89ea8f896c7d0b07a59bb05e44f2186742f33caf",
    rectCount: 2465,
    changedRightCount: 543,
    changedBottomCount: 0,
    nodeCount: 126,
    runCount: 2285,
    document: { width: 1365, height: 5692 },
    viewport: { width: 1365, height: 1600 },
  },
]);

const exactCaptureBySourceId = new Map(
  exactCaptureTuples.map((entry) => [entry.sourceId, entry]),
);

export const STAGE1_PRE_1FC005C_LEGACY_GEOMETRY_SOURCE_IDS = Object.freeze(
  exactCaptureTuples.map((entry) => entry.sourceId),
);

/**
 * Pure, geometry-only compatibility decision for six immutable webpage layout
 * artifacts produced before 1fc005c. The current verifier must run and reject
 * first. This bridge grants no semantic, acquisition, promotion, or mutation
 * authority and performs no I/O.
 */
export function evaluateStage1Pre1fc005cLegacyGeometryBridge(input = {}) {
  const candidate = objectValue(input);
  const exactInputSourceId = Object.hasOwn(candidate, "exactSourceId")
    ? candidate.exactSourceId
    : candidate.sourceId;
  const entry = exactCaptureBySourceId.get(exactInputSourceId);
  if (!entry) {
    return {
      applies: false,
      accepted: false,
      reason: "source_not_allowlisted",
      evidence: null,
    };
  }

  try {
    assertCoreIdentity(candidate, entry);
    assertR2Authority(candidate.authoritativeR2Binding, entry);
    const layout = assertRoleIdentity(candidate, entry);
    assertCurrentVerifierRejected(candidate, layout, entry);
    const recovered = recoverLegacyFingerprintPreimage(layout);
    assert(recovered.valid, recovered.reason || "legacy_rect_preimage_invalid");
    assert(
      recovered.rect_count === entry.rectCount
        && recovered.changed_right_count === entry.changedRightCount
        && recovered.changed_bottom_count === entry.changedBottomCount
        && recovered.nodes_sha256 === entry.reconstructedNodesSha256
        && recovered.fingerprint_sha256 === entry.storedProofSha256,
      "legacy_rect_preimage_not_allowlisted",
    );

    return {
      applies: true,
      accepted: true,
      reason: "exact_source_generation_layout_pre_1fc005c_geometry_verified",
      evidence: {
        schema: STAGE1_PRE_1FC005C_LEGACY_GEOMETRY_BRIDGE_SCHEMA,
        source_id: entry.sourceId,
        reviewed_source: entry.reviewedSource,
        reviewed_final_url: entry.reviewedFinalUrl,
        producer_boundary_commit: producerBoundaryCommit,
        fingerprint_semantics: "pre_1fc005c_raw_rect_endpoint_fingerprint",
        artifact_role: "layout",
        role_capture_timestamp: entry.capturedAt,
        immutable_generation: entry.generation,
        r2_binding_receipt_sha256: entry.receiptSha256,
        r2_pointer_sha256: entry.pointerSha256,
        r2_layout_object_key: r2ObjectKey(entry, "layout"),
        r2_layout_remote_body_verified: true,
        exact_verified_r2_roles: [...exactR2Roles],
        zero_expansion_states_verified: true,
        layout_body_sha256: entry.layoutBodySha256,
        layout_body_byte_length: entry.layoutByteLength,
        geometry_sha256: entry.geometrySha256,
        image_sha256: entry.imageSha256,
        stored_before_after_fingerprint_sha256: entry.storedProofSha256,
        current_canonical_fingerprint_sha256: entry.currentFingerprintSha256,
        reconstructed_preimage_nodes_sha256: recovered.nodes_sha256,
        reconstructed_preimage_grid: "chromium_css_pixels_1_64",
        reconstructed_rect_count: recovered.rect_count,
        reconstructed_unique_preimage_rect_count: recovered.rect_count,
        reconstructed_changed_right_count: recovered.changed_right_count,
        reconstructed_changed_bottom_count: recovered.changed_bottom_count,
        generic_geometry_verifier: {
          ran_first: true,
          layout_ready: false,
          capture_ready: false,
        },
        semantic_or_acquisition_equivalence_authority: false,
        promotion_authority: false,
        mutation_authority: false,
        limitations: [
          "compatibility_bridge_scoped_to_six_exact_source_generation_layout_tuples",
          "pre_1fc005c_fingerprint_reconstructed_only_from_unique_chromium_1_64_pixel_preimages",
          "zero_expansion_states_only",
          "semantic_and_acquisition_equivalence_are_not_evaluated_or_waived",
          "compatibility_evidence_is_not_generic_geometry_or_promotion_authority",
        ],
      },
    };
  } catch (error) {
    return {
      applies: true,
      accepted: false,
      reason: cleanText(error?.message) || "legacy_geometry_bridge_invalid",
      evidence: null,
    };
  }
}

function assertCoreIdentity(input, entry) {
  const existing = objectValue(input.existingCaptureIdentity);
  const files = objectValue(existing.files);
  assert(input.sourceId === entry.sourceId, "source_not_allowlisted");
  if (Object.hasOwn(input, "exactSourceId")) {
    assert(input.exactSourceId === entry.sourceId, "exact_source_not_allowlisted");
  }
  assert(input.kind === "webpage", "kind_not_allowlisted");
  assert(input.reviewedFinalUrl === entry.reviewedFinalUrl, "reviewed_final_url_not_allowlisted");
  assert(input.existingCapturedAt === entry.capturedAt, "capture_timestamp_not_allowlisted");
  assert(existing.kind === "webpage", "capture_kind_not_allowlisted");
  assert(existing.source?.id === entry.sourceId, "capture_source_not_allowlisted");
  assert(existing.captured_at === entry.capturedAt, "capture_identity_timestamp_not_allowlisted");
  assert(existing.final_url === entry.observedFinalUrl, "capture_final_url_not_allowlisted");
  assert(existing.layout_hash === entry.geometrySha256, "capture_layout_hash_not_allowlisted");
  assert(existing.image_hash === entry.imageSha256, "capture_image_hash_not_allowlisted");
  assert(exactLocalArtifactPath(existing.layout_path, entry), "hydrated_layout_path_not_allowlisted");
  assert(files.layout === localLayoutPath(entry), "capture_layout_path_not_allowlisted");
  assertZeroExpansionStates(existing, files);
}

function assertZeroExpansionStates(existing, files) {
  assert(existing.expansion_state_candidates === 0, "expansion_state_candidates_not_zero");
  assert(existing.expansion_state_attempted === 0, "expansion_state_attempted_not_zero");
  assert(existing.expansion_state_capture_complete === true, "expansion_state_capture_incomplete");
  assert(existing.expansion_state_truncated === false, "expansion_state_truncated");
  assert(existing.expansion_state_truncated_count === 0, "expansion_state_truncated_count_not_zero");
  assert(
    Array.isArray(existing.expansion_state_screenshots)
      && existing.expansion_state_screenshots.length === 0,
    "expansion_state_screenshots_not_zero",
  );
  assert(
    Array.isArray(existing.expansion_state_failures)
      && existing.expansion_state_failures.length === 0,
    "expansion_state_failures_not_zero",
  );
  assert(existing.expansion_state_error === null, "expansion_state_error_present");
  assert(
    Array.isArray(files.expansion_states) && files.expansion_states.length === 0,
    "expansion_state_files_not_zero",
  );
}

function assertR2Authority(receiptValue, entry) {
  try {
    assertStage1EvidenceSchemaUpgradeR2BindingReceipt(receiptValue);
  } catch {
    throw new Error("r2_binding_receipt_invalid");
  }
  const receipt = objectValue(receiptValue);
  const pointer = objectValue(receipt.pointer_identity);
  const verification = objectValue(receipt.artifact_binding_verification);
  const roles = Array.isArray(receipt.verified_roles) ? receipt.verified_roles : [];
  const roleNames = roles.map((role) => role?.role).sort();
  const pointerRoles = Object.keys(objectValue(pointer.latest_object_keys)).sort();
  const layoutRole = roles.find((role) => role?.role === "layout");

  assert(receipt.receipt_sha256 === entry.receiptSha256, "r2_receipt_not_allowlisted");
  assert(
    receipt.source_id === entry.sourceId && receipt.kind === "webpage",
    "r2_receipt_source_not_allowlisted",
  );
  assert(receipt.captured_at === entry.capturedAt, "r2_receipt_timestamp_not_allowlisted");
  assert(pointer.shared_award_source_id === entry.sourceId, "r2_pointer_source_not_allowlisted");
  assert(pointer.kind === "webpage", "r2_pointer_kind_not_allowlisted");
  assert(pointer.bucket === "awardping-snapshots", "r2_pointer_bucket_not_allowlisted");
  assert(
    pointer.latest_captured_at === r2CapturedAt(entry),
    "r2_pointer_timestamp_not_allowlisted",
  );
  assert(pointer.immutable_generation === entry.generation, "r2_generation_not_allowlisted");
  assert(pointer.pointer_sha256 === entry.pointerSha256, "r2_pointer_not_allowlisted");
  assert(pointer.latest_hashes?.layout_hash === entry.geometrySha256, "r2_geometry_hash_not_allowlisted");
  assert(pointer.latest_hashes?.image_hash === entry.imageSha256, "r2_image_hash_not_allowlisted");
  assert(sameJson(roleNames, exactR2Roles), "r2_role_set_not_allowlisted");
  assert(sameJson(pointerRoles, exactR2Roles), "r2_pointer_role_set_not_allowlisted");
  for (const role of exactR2Roles) {
    assert(
      pointer.latest_object_keys?.[role] === r2ObjectKey(entry, role),
      "r2_object_key_not_allowlisted",
    );
  }
  assert(
    verification.status === "derived_from_exact_local_and_remote_bytes"
      && verification.pointer_claim_present === false
      && verification.derived_binding_count === exactR2Roles.length,
    "r2_artifact_binding_verification_not_allowlisted",
  );
  assert(
    roles.length === exactR2Roles.length
      && roles.every((role) => role?.remote_body_verified === true),
    "r2_remote_body_not_verified",
  );
  assert(
    layoutRole?.key === r2ObjectKey(entry, "layout")
      && layoutRole?.sha256 === entry.layoutBodySha256
      && layoutRole?.byte_length === entry.layoutByteLength
      && layoutRole?.content_type === contentType
      && layoutRole?.remote_body_verified === true,
    "r2_layout_role_not_allowlisted",
  );
}

function assertRoleIdentity(input, entry) {
  const artifact = objectValue(input.artifact);
  const binding = objectValue(artifact.binding);
  const layout = objectValue(input.layout);
  const captureGeometry = objectValue(input.captureGeometry);
  const metadataGeometry = objectValue(input.metadataGeometry);
  const expectedMetadataGeometry = metadataGeometryProjection(entry);

  assert(input.artifactSlot === "layout", "role_not_allowlisted");
  assert(artifact.name === "layout", "artifact_role_not_allowlisted");
  assert(artifact.fileName === "layout.json", "artifact_filename_not_allowlisted");
  assert(exactLocalArtifactPath(artifact.path, entry), "artifact_path_not_allowlisted");
  assert(artifact.contentType === contentType, "artifact_content_type_not_allowlisted");
  assert(Buffer.isBuffer(artifact.body), "artifact_body_missing");
  assert(artifact.body.length === entry.layoutByteLength, "layout_body_length_not_allowlisted");
  assert(sha256(artifact.body) === entry.layoutBodySha256, "layout_body_hash_not_allowlisted");
  assert(
    binding.sha256 === entry.layoutBodySha256
      && binding.byte_length === entry.layoutByteLength
      && binding.content_type === contentType
      && binding.hash_mode === "raw_sha256",
    "layout_artifact_binding_not_allowlisted",
  );

  const bodyLayout = parseJsonObject(artifact.body);
  assert(sameJson(layout, bodyLayout), "layout_not_identical_to_artifact_body");
  assert(sameJson(captureGeometry, bodyLayout), "capture_geometry_not_identical_to_layout_bytes");
  assert(
    sameJson(input.existingCaptureIdentity?.text_geometry, bodyLayout),
    "capture_identity_geometry_not_identical_to_layout_bytes",
  );
  assert(sameJson(metadataGeometry, expectedMetadataGeometry), "metadata_geometry_not_allowlisted");
  assert(input.expectedLayoutHash === entry.geometrySha256, "expected_layout_hash_not_allowlisted");
  assert(input.metadataLayoutHash === entry.geometrySha256, "metadata_layout_hash_not_allowlisted");
  assert(input.expectedImageHash === entry.imageSha256, "expected_image_hash_not_allowlisted");
  assertLayoutEnvelope(bodyLayout, entry);
  return bodyLayout;
}

function assertLayoutEnvelope(layout, entry) {
  const proof = objectValue(layout.capture_verification);
  assert(layout.version === 3, "layout_version_not_allowlisted");
  assert(layout.state_id === "main", "layout_state_not_allowlisted");
  assert(layout.captured_at === entry.capturedAt, "layout_timestamp_not_allowlisted");
  assert(layout.coordinate_space === "document-css-pixels", "layout_coordinate_space_not_allowlisted");
  assert(sameJson(layout.document, entry.document), "layout_document_dimensions_not_allowlisted");
  assert(sameJson(layout.viewport, entry.viewport), "layout_viewport_dimensions_not_allowlisted");
  assert(sameJson(layout.scroll, { x: 0, y: 0 }), "layout_scroll_not_allowlisted");
  assert(layout.device_pixel_ratio === 1, "layout_dpr_not_allowlisted");
  assert(layout.node_count === entry.nodeCount, "layout_node_count_not_allowlisted");
  assert(layout.run_count === entry.runCount, "layout_run_count_not_allowlisted");
  assert(Array.isArray(layout.nodes) && layout.nodes.length === entry.nodeCount, "layout_nodes_not_allowlisted");
  assert(
    layout.nodes.reduce(
      (count, node) => count + (Array.isArray(node?.runs) ? node.runs.length : 0),
      0,
    ) === entry.runCount,
    "layout_runs_not_allowlisted",
  );
  assert(layout.paint_stack?.contract === "browser-paint-stack-v1", "layout_paint_contract_not_allowlisted");
  assert(layout.paint_stack?.status === "verified", "layout_paint_status_not_allowlisted");
  assert(sameJson(layout.screenshot, screenshotProjection(entry)), "layout_screenshot_not_allowlisted");
  assert(layout.geometry_hash === entry.geometrySha256, "layout_geometry_hash_not_allowlisted");
  assert(
    proof.contract === "visual-screenshot-layout-binding-v1"
      && proof.status === "verified"
      && proof.state_id === "main"
      && proof.before_fingerprint === entry.storedProofSha256
      && proof.after_fingerprint === entry.storedProofSha256
      && proof.screenshot_alignment === "verified"
      && Object.keys(proof).length === 6,
    "stored_before_after_proof_not_allowlisted",
  );
  assert(
    verifyVisualTextGeometryBinding(layout, entry.imageSha256).valid,
    "geometry_image_binding_invalid",
  );
  const currentFingerprint = visualTextGeometryLayoutFingerprint({
    ...layout,
    version: 1,
  });
  assert(
    currentFingerprint === entry.currentFingerprintSha256,
    "current_layout_fingerprint_not_allowlisted",
  );
  assert(currentFingerprint !== entry.storedProofSha256, "current_and_legacy_fingerprints_not_distinct");
}

function assertCurrentVerifierRejected(input, layout, entry) {
  const verification = objectValue(input.currentGeometryVerification);
  const layoutReady = isR2CaptureGeometryReady({
    kind: "webpage",
    image_hash: entry.imageSha256,
    text_geometry: layout,
  });
  const captureReady = isR2CaptureGeometryReady({
    kind: "webpage",
    image_hash: entry.imageSha256,
    text_geometry: input.captureGeometry,
  });
  assert(
    verification.ran_first === true
      && verification.layout_ready === false
      && verification.capture_ready === false,
    "current_geometry_verifier_not_run_first",
  );
  assert(layoutReady === false && captureReady === false, "current_geometry_verifier_did_not_reject");
}

function metadataGeometryProjection(entry) {
  return {
    version: 3,
    status: "ready",
    unavailable_reason: null,
    geometry_hash: entry.geometrySha256,
    coordinate_space: "document-css-pixels",
    node_count: entry.nodeCount,
    run_count: entry.runCount,
    document: entry.document,
    viewport: entry.viewport,
    screenshot: screenshotProjection(entry),
    file: localLayoutPath(entry),
  };
}

function screenshotProjection(entry) {
  return {
    image_hash: entry.imageSha256,
    image_ref: localPagePath(entry),
    css_width: entry.document.width,
    css_height: entry.document.height,
    pixel_width: entry.document.width,
    pixel_height: entry.document.height,
    expected_device_pixel_ratio: 1,
    scale_x: 1,
    scale_y: 1,
    alignment_status: "verified",
  };
}

function recoverLegacyFingerprintPreimage(layout) {
  let rectCount = 0;
  let changedRightCount = 0;
  let changedBottomCount = 0;
  try {
    const recoverRect = (value) => {
      const rect = objectValue(value);
      const horizontal = uniqueChromiumRectAxisPreimage(rect.x, rect.width);
      const vertical = uniqueChromiumRectAxisPreimage(rect.y, rect.height);
      if (horizontal.length !== 1 || vertical.length !== 1) {
        throw new Error("legacy_rect_preimage_not_unique");
      }
      const right = roundHundredth(horizontal[0].end);
      const bottom = roundHundredth(vertical[0].end);
      rectCount += 1;
      if (right !== rect.right) changedRightCount += 1;
      if (bottom !== rect.bottom) changedBottomCount += 1;
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right,
        bottom,
      };
    };
    const nodes = layout.nodes.map((node) => ({
      ...node,
      rects: node.rects.map(recoverRect),
      runs: node.runs.map((run) => ({
        ...run,
        rects: run.rects.map(recoverRect),
      })),
    }));
    const fingerprint = sha256VisualSemanticValue({
      version: 1,
      state_id: layout.state_id || null,
      coordinate_space: cleanText(layout.coordinate_space) || "document-css-pixels",
      document: objectValue(layout.document),
      viewport: objectValue(layout.viewport),
      scroll: objectValue(layout.scroll),
      device_pixel_ratio: positiveNumber(layout.device_pixel_ratio) || 1,
      paint_stack: objectValue(layout.paint_stack),
      nodes,
    });
    return {
      valid: true,
      reason: "unique_chromium_1_64_pixel_preimage_verified",
      rect_count: rectCount,
      changed_right_count: changedRightCount,
      changed_bottom_count: changedBottomCount,
      nodes_sha256: sha256VisualSemanticValue(nodes),
      fingerprint_sha256: fingerprint,
    };
  } catch (error) {
    return {
      valid: false,
      reason: cleanText(error?.message) || "legacy_rect_preimage_invalid",
      rect_count: rectCount,
      changed_right_count: changedRightCount,
      changed_bottom_count: changedBottomCount,
      nodes_sha256: null,
      fingerprint_sha256: null,
    };
  }
}

function uniqueChromiumRectAxisPreimage(roundedStart, roundedSize) {
  if (!Number.isFinite(roundedStart) || !Number.isFinite(roundedSize) || roundedSize <= 0) {
    return [];
  }
  // This historical producer captured Chromium DOMRect endpoints on its 1/64
  // CSS-pixel lattice, rounded start, size, and end independently to hundredths,
  // then the old binder recomputed the retained end from rounded start + size.
  // Ambiguous lattice preimages are refused rather than guessed.
  const starts = chromiumLatticeValuesRoundingTo(roundedStart);
  const approximateEnd = roundedStart + roundedSize;
  const minimumEndUnit = Math.floor((approximateEnd - 0.05) * 64);
  const maximumEndUnit = Math.ceil((approximateEnd + 0.05) * 64);
  const candidates = [];
  for (const start of starts) {
    for (let unit = minimumEndUnit; unit <= maximumEndUnit; unit += 1) {
      const end = unit / 64;
      if (end > start && roundHundredth(end - start) === roundedSize) {
        candidates.push({ start, end });
      }
    }
  }
  return candidates;
}

function chromiumLatticeValuesRoundingTo(value) {
  const minimumUnit = Math.floor((value - 0.03) * 64);
  const maximumUnit = Math.ceil((value + 0.03) * 64);
  const values = [];
  for (let unit = minimumUnit; unit <= maximumUnit; unit += 1) {
    const candidate = unit / 64;
    if (roundHundredth(candidate) === value) values.push(candidate);
  }
  return values;
}

function localCapturePrefix(entry) {
  return `sources/${entry.sourceId}/captures/${entry.captureDirectory}/`;
}

function localLayoutPath(entry) {
  return `${localCapturePrefix(entry)}layout.json`;
}

function localPagePath(entry) {
  return `${localCapturePrefix(entry)}page.jpg`;
}

function r2ObjectKey(entry, role) {
  return `visual-snapshots/sources/${entry.sourceId}/captures/${entry.generation}/${r2RoleFiles[role]}`;
}

function r2CapturedAt(entry) {
  return entry.capturedAt
    .replace(/(\.\d*?[1-9])0+Z$/u, "$1+00:00")
    .replace(/Z$/u, "+00:00");
}

function exactLocalArtifactPath(value, entry) {
  const path = normalizedPath(value);
  const expected = localLayoutPath(entry);
  if (
    !path
    || /[\u0000-\u001f]/u.test(path)
    || path.split("/").includes("..")
  ) return false;
  return path === expected || path.endsWith(`/${expected}`);
}

function parseJsonObject(body) {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    assert(objectValue(value) === value, "layout_body_not_json_object");
    return value;
  } catch {
    throw new Error("layout_body_not_json_object");
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assert(condition, reason) {
  if (!condition) throw new Error(reason);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameJson(left, right) {
  return sha256VisualSemanticValue(left) === sha256VisualSemanticValue(right);
}

function normalizedPath(value) {
  return cleanText(value).replace(/\\/gu, "/");
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function roundHundredth(value) {
  return Math.round(Number(value) * 100) / 100;
}
