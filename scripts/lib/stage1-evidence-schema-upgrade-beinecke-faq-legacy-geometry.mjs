import { createHash } from "node:crypto";
import {
  assertStage1EvidenceSchemaUpgradeR2BindingReceipt,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";
import {
  sha256VisualSemanticValue,
  verifyVisualTextGeometryBinding,
} from "./visual-event-localization.mjs";

export const STAGE1_BEINECKE_FAQ_LEGACY_GEOMETRY_BRIDGE_SCHEMA =
  "awardping.stage1.beinecke-faq-legacy-geometry-bridge.v1";
export const STAGE1_BEINECKE_FAQ_LEGACY_MAIN_CONTENT_BRIDGE_SCHEMA =
  "awardping.stage1.beinecke-faq-legacy-main-content-bridge.v1";

const sourceId = "2ea41875-5c88-5794-81b3-afa8ddaf31c1";
const captureTimestamp = "2026-08-03T18:44:41.262Z";
const captureGeneration = "f9e4d3ca743b366c1e4d2897a4822c45";
const mainContentHash = "4cbc91149287266cd6c0a1a4156d05a1c74bc393be29ca73369aa613b6f49c27";
const reviewedFinalUrl = "https://beineckescholarship.org/beinecke-scholarship/scholar-faqs";
const acquisitionId = "42e72340-c3b8-5ca2-8913-aed7f7c56be5";
const requestId = "cc190ad2-8240-5b8c-b5ac-a73180094d24";
const acquisitionFileHash = "6ee5b5322ed5f5563063d919e552839d434bf08456d8176fbfda9404e015e7e2";
const acquisitionGuardHash = "6f0d052effa393a460bd5b91d5051a8d23dfbb7272073c150ad0903f5e66eadb";
const legacyFullBrowserNormalizedTextHash =
  "cc400ba8cb0b7e5b96a148d119d549a1d2a0b71dea4cc9a0a852419e9374e9ce";
const localCapturePrefix = `sources/${sourceId}/captures/2026-08-03T18-44-41-262Z/`;
const r2CapturePrefix = `visual-snapshots/sources/${sourceId}/captures/${captureGeneration}/`;

const immutableCaptureIdentity = Object.freeze({
  source_id: sourceId,
  kind: "webpage",
  captured_at: captureTimestamp,
  immutable_generation: captureGeneration,
  r2_binding_receipt_sha256:
    "31ec0a7081d7db8822e11ea1384e42dddbef1e834db633dcaedebc40a50e8d1b",
  r2_pointer_sha256:
    "5ea2ec78cf4b82878e6c74a67dfcf21ab775ec09c9b4d3644257f4e4ecca2c2e",
  main_content_hash: mainContentHash,
  text_hash: "334c6ac6e56b611e6bf021a53ba1a339639ff3c221253d6aa78a1161143a24d4",
  body_text_hash: "62753e4c86d848ed9b394337f6f17777171fe3ef78d734944696982095bce936",
  nav_header_footer_hash:
    "05c1a5128b0b539512ec1de5e7b5079964d72a3829b3d2daad047fab48bf04de",
  expansion_hash: "59b1a04cf0430a8a3b20ed185c50db62cd0759ad025397707f6317ae3293e042",
});

const verifiedPaint = (sampledRectCount) => Object.freeze({
  contract: "browser-paint-stack-v1",
  status: "verified",
  sample_points_per_rect: 3,
  sampled_rect_count: sampledRectCount,
  rejected_rect_count: 0,
  original_scroll: Object.freeze({ x: 0, y: 0 }),
  restored_scroll: Object.freeze({ x: 0, y: 0 }),
});

const roleAllowlist = Object.freeze({
  layout: legacyRole({
    artifactSlot: "layout",
    fileName: "layout.json",
    stateId: "main",
    capturedAt: captureTimestamp,
    bodySha256: "b521391a3b211a6ce91fa91db27c05d0e249e89bf3313e714aa1d056ab064375",
    byteLength: 141646,
    geometrySha256: "d30eda33e1e958f8cdea54e80942276fd9963577ceae41f658c85a61101f5c8b",
    imageSha256: "70c8ca6cfaeefa8113481a0054a1fa57845dec7a8426795be6aac0ac97df524f",
    proofSha256: "8c4239ca15e393ef7a17d0c68c0085a1231aeeffe69eb4368c693c0202f50eb0",
    preimageNodesSha256:
      "7813fa5d3abdf0c17f2bf0727ed865193158d795a0755909d44ff2f9289f307a",
    document: { width: 1365, height: 1922 },
    viewport: { width: 1365, height: 1600 },
    nodeCount: 24,
    runCount: 381,
    sampledRectCount: 382,
    recoveredRectCount: 416,
    recoveredRightCount: 109,
    recoveredBottomCount: 0,
  }),
  expansion_state_01_layout: legacyRole({
    artifactSlot: "expansion_state_01_layout",
    fileName: "expansion-state-01-layout.json",
    stateId: "expansion-state-01",
    capturedAt: "2026-08-03T18:45:47.844Z",
    bodySha256: "a9cda56819ffe117c1e539da5b774663ee91823c6204a3eaafa534b75998aeb8",
    byteLength: 60904,
    geometrySha256: "9add9cc3137b6a03014a4de9581f783defb90606f3ec7d9614ca9e48b819018c",
    imageSha256: "fcad2c0ab755d734db32a73990d4bd8d27138baa03da700d81901c183b5e3e22",
    proofSha256: "afed68522b695826a037b912914ddcd2be0eeffaed779669c2f4c0d2fc7aaae9",
    preimageNodesSha256:
      "99e98c3d1a0e06711f02d3bd52f1b4a8fe9ce945da9842a79fa484fb73a8f196",
    document: { width: 1365, height: 1600 },
    viewport: { width: 1365, height: 1600 },
    nodeCount: 15,
    runCount: 157,
    sampledRectCount: 157,
    recoveredRectCount: 173,
    recoveredRightCount: 44,
    recoveredBottomCount: 0,
  }),
  expansion_state_02_layout: legacyRole({
    artifactSlot: "expansion_state_02_layout",
    fileName: "expansion-state-02-layout.json",
    stateId: "expansion-state-02",
    capturedAt: "2026-08-03T18:46:31.959Z",
    bodySha256: "f786e2e8332086a3d0d928255fe7525cf9bf6d2e080560674e8ad6a0d67c6fd4",
    byteLength: 68281,
    geometrySha256: "3c6a86fbcdbf41f6b6515eab67a9191ccb700e680d403095552711cb97f7d156",
    imageSha256: "639cd0eda7a34e78c130ba695d0bd7efd4b546e0475cae237054a528f5a782c7",
    proofSha256: "614153bbdbb9b883ca381ce49ab7220a26378a9f42c1cba13166b9d0a00354e4",
    preimageNodesSha256:
      "f3d0f563fcae060d1fd3b1f50a3bc8e3c0385c2bceaa226cb6d3e165074a48e9",
    document: { width: 1365, height: 1600 },
    viewport: { width: 1365, height: 1600 },
    nodeCount: 15,
    runCount: 178,
    sampledRectCount: 178,
    recoveredRectCount: 196,
    recoveredRightCount: 55,
    recoveredBottomCount: 0,
  }),
  expansion_state_03_layout: legacyRole({
    artifactSlot: "expansion_state_03_layout",
    fileName: "expansion-state-03-layout.json",
    stateId: "expansion-state-03",
    capturedAt: "2026-08-03T18:47:16.127Z",
    bodySha256: "667e0cb1263bc4fd2b3a06aad35fae61045f592241d8350e585e4199b180a2ea",
    byteLength: 63037,
    geometrySha256: "e222dc4822adb9cc02c6612a6277b0011a24f3feb4f8ec5c9c1626490423b840",
    imageSha256: "1b0ca507360826e22530e051162844edd20d2ba7816a7a7305007b3ea459400d",
    proofSha256: "2546355cccfadd458ac208f956fc4a272ce3fcd5a9be2353c80edd8f3c490b56",
    preimageNodesSha256:
      "a3b02de409bc6917df2f35093de4f4638026bae6f8697fe9c187ebe830714b8f",
    document: { width: 1365, height: 1600 },
    viewport: { width: 1365, height: 1600 },
    nodeCount: 15,
    runCount: 163,
    sampledRectCount: 163,
    recoveredRectCount: 180,
    recoveredRightCount: 47,
    recoveredBottomCount: 0,
  }),
  expansion_state_04_layout: legacyRole({
    artifactSlot: "expansion_state_04_layout",
    fileName: "expansion-state-04-layout.json",
    stateId: "expansion-state-04",
    capturedAt: "2026-08-03T18:48:00.223Z",
    bodySha256: "ac7650ee1f7425931cd0f001892d0f7cf9bca4b9109dcd806a6cde5c1e8364a6",
    byteLength: 68150,
    geometrySha256: "f299beaa1004a23390cec1d6a1969284fe2d86a87c07de19f056dc63258a53cd",
    imageSha256: "50de0f171ec738e8b4ddb9a8c494d0c6594b4e01c3bbb13712fb7fad945ecd64",
    proofSha256: "130b96f09f09d1283cef303d93ae61afd7bc893e43dea3e86c20e385a70708ec",
    preimageNodesSha256:
      "c4e20381bdedfa9eb62501e930327a2fb91a42798e6836d1affec158904f149c",
    document: { width: 1365, height: 1600 },
    viewport: { width: 1365, height: 1600 },
    nodeCount: 18,
    runCount: 174,
    sampledRectCount: 174,
    recoveredRectCount: 194,
    recoveredRightCount: 52,
    recoveredBottomCount: 0,
  }),
});

function legacyRole(value) {
  return Object.freeze({
    ...value,
    contentType: "application/json; charset=utf-8",
    coordinateSpace: "document-css-pixels",
    scroll: Object.freeze({ x: 0, y: 0 }),
    devicePixelRatio: 1,
    paintStack: verifiedPaint(value.sampledRectCount),
    screenshot: Object.freeze({
      image_hash: value.imageSha256,
      image_ref: `${localCapturePrefix}${value.fileName === "layout.json" ? "page.jpg" : value.fileName.replace("-layout.json", ".jpg")}`,
      css_width: value.document.width,
      css_height: value.document.height,
      pixel_width: value.document.width,
      pixel_height: value.document.height,
      expected_device_pixel_ratio: 1,
      scale_x: 1,
      scale_y: 1,
      alignment_status: "verified",
    }),
  });
}

/**
 * One-source compatibility decision for geometry produced before 1fc005c.
 * The normal/current readiness verifier remains authoritative and must have
 * run first. This bridge only explains one immutable reviewed capture; it is
 * not a general legacy fingerprint verifier or promotion rule.
 */
export function evaluateStage1BeineckeFaqLegacyGeometryBridge(input = {}) {
  const exactInputSourceId = Object.hasOwn(input, "exactSourceId")
    ? input.exactSourceId
    : input.sourceId;
  if (exactInputSourceId !== sourceId) {
    return {
      applies: false,
      accepted: false,
      reason: "source_not_allowlisted",
      evidence: null,
    };
  }

  try {
    const entry = roleAllowlist[input.artifactSlot];
    assert(entry, "role_not_allowlisted");
    assertCoreIdentity(input);
    assertR2Authority(input.authoritativeR2Binding);
    const verification = objectValue(input.currentGeometryVerification);
    assert(
      verification.ran_first === true
        && verification.layout_ready === false
        && verification.capture_ready === false,
      "current_geometry_verifier_not_run_first",
    );
    assertRoleIdentity(input, entry);
    const recovered = recoverLegacyFingerprintPreimage(input.layout);
    assert(recovered.valid, recovered.reason || "legacy_rect_preimage_invalid");
    assert(
      recovered.rect_count === entry.recoveredRectCount
        && recovered.changed_right_count === entry.recoveredRightCount
        && recovered.changed_bottom_count === entry.recoveredBottomCount
        && recovered.nodes_sha256 === entry.preimageNodesSha256
        && recovered.fingerprint_sha256 === entry.proofSha256,
      "legacy_rect_preimage_not_allowlisted",
    );

    return {
      applies: true,
      accepted: true,
      reason: "exact_source_bound_pre_1fc005c_geometry_verified",
      evidence: {
        schema: STAGE1_BEINECKE_FAQ_LEGACY_GEOMETRY_BRIDGE_SCHEMA,
        source_id: sourceId,
        producer_boundary_commit: "1fc005c9bc99b52bcbd5b99fe699386fef361692",
        fingerprint_semantics: "pre_1fc005c_raw_rect_endpoint_fingerprint",
        artifact_role: entry.artifactSlot,
        reviewed_source_page_type: "faq",
        reviewed_source_roles: ["faq"],
        reviewed_final_url: reviewedFinalUrl,
        immutable_generation: captureGeneration,
        legacy_capture_timestamp: captureTimestamp,
        role_capture_timestamp: entry.capturedAt,
        layout_body_sha256: entry.bodySha256,
        geometry_sha256: entry.geometrySha256,
        image_sha256: entry.imageSha256,
        stored_before_after_fingerprint_sha256: entry.proofSha256,
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
        acquisition_semantics: {
          scope: "main_content_only",
          immutable_guard_sha256: mainContentHash,
          legacy_main_content_sha256: mainContentHash,
          prospective_main_content_sha256: mainContentHash,
          legacy_full_browser_text_sha256: immutableCaptureIdentity.text_hash,
          full_browser_text_includes: ["navigation_chrome", "expanded_section_states"],
        },
        limitations: [
          "compatibility_bridge_scoped_to_one_reviewed_source_generation_and_role_tuple",
          "pre_1fc005c_fingerprint_reconstructed_only_from_unique_chromium_1_64_pixel_preimages",
          "acquisition_semantics_bound_to_main_content_hash_not_full_browser_text_hash",
          "full_browser_text_includes_navigation_chrome_and_expanded_section_states",
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

/**
 * Exact semantic-scope compatibility decision for the same reviewed capture.
 * Generic full-text equality remains the first rule in the caller. This
 * decision only permits acquisition comparison against the capture's sealed
 * main-content partition because the reviewed intake, retained Aug-3 capture,
 * and prospective capture all carry the same immutable main-content hash.
 */
export function evaluateStage1BeineckeFaqLegacyMainContentBridge(input = {}) {
  const exactInputSourceId = Object.hasOwn(input, "exactSourceId")
    ? input.exactSourceId
    : input.sourceId;
  if (exactInputSourceId !== sourceId) {
    return {
      applies: false,
      accepted: false,
      reason: "source_not_allowlisted",
      evidence: null,
    };
  }

  try {
    const sealed = objectValue(input.sealedAcquisition);
    const existing = objectValue(input.existingCaptureIdentity);
    const activation = objectValue(input.existingBaselineActivation);
    const legacyGeometryBridges = Array.isArray(input.legacyGeometryBridges)
      ? input.legacyGeometryBridges
      : [];
    const currentGeometryVerifiedRoles = Array.isArray(input.currentGeometryVerifiedRoles)
      ? input.currentGeometryVerifiedRoles
      : [];
    const existingArtifactLimitations = Array.isArray(input.existingArtifactLimitations)
      ? input.existingArtifactLimitations
      : [];

    assert(input.kind === "webpage", "kind_not_allowlisted");
    assert(input.reviewedFinalUrl === reviewedFinalUrl, "reviewed_final_url_not_allowlisted");
    assert(sealed.final_url_exact === reviewedFinalUrl, "sealed_final_url_not_allowlisted");
    assert(sealed.page_type_exact === "faq", "reviewed_page_type_not_allowlisted");
    assert(
      Array.isArray(sealed.reviewed_roles_exact)
        && sealed.reviewed_roles_exact.length === 1
        && sealed.reviewed_roles_exact[0] === "faq",
      "reviewed_source_roles_not_allowlisted",
    );
    assert(sealed.file_hash_exact === acquisitionFileHash, "sealed_acquisition_file_hash_not_allowlisted");
    assert(sealed.normalized_text_hash_exact === mainContentHash, "sealed_acquisition_text_hash_not_allowlisted");
    assert(sealed.source_acquisition_id_exact === acquisitionId, "sealed_acquisition_id_not_allowlisted");
    assert(sealed.request_id_exact === requestId, "sealed_request_id_not_allowlisted");
    assert(input.activationGuardSha256 === acquisitionGuardHash, "activation_guard_hash_not_allowlisted");

    assert(existing.captured_at === captureTimestamp, "capture_timestamp_not_allowlisted");
    assert(existing.kind === "webpage", "legacy_capture_kind_not_allowlisted");
    assert(existing.source?.id === sourceId, "legacy_capture_source_not_allowlisted");
    assert(existing.final_url === `${reviewedFinalUrl}/`, "legacy_capture_final_url_not_allowlisted");
    assert(existing.text_hash === immutableCaptureIdentity.text_hash, "legacy_full_text_hash_not_allowlisted");
    assert(existing.text_length === 6646, "legacy_full_text_length_not_allowlisted");
    assert(existing.body_text_hash === immutableCaptureIdentity.body_text_hash, "legacy_body_text_hash_not_allowlisted");
    assert(existing.body_text_length === 2378, "legacy_body_text_length_not_allowlisted");
    assert(existing.main_content_hash === mainContentHash, "legacy_main_content_hash_not_allowlisted");
    assert(existing.main_content_text_length === 2224, "legacy_main_content_length_not_allowlisted");
    assert(
      existing.nav_header_footer_hash === immutableCaptureIdentity.nav_header_footer_hash,
      "legacy_chrome_hash_not_allowlisted",
    );
    assert(existing.nav_header_footer_text_length === 163, "legacy_chrome_length_not_allowlisted");
    assert(existing.expansion_hash === immutableCaptureIdentity.expansion_hash, "legacy_expansion_hash_not_allowlisted");
    assert(existing.expansion_text_length === 4266, "legacy_expansion_length_not_allowlisted");
    assert(
      existing.expandable_sections_hash
        === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "legacy_expandable_sections_hash_not_allowlisted",
    );
    assert(
      input.existingNormalizedTextHash === legacyFullBrowserNormalizedTextHash,
      "legacy_full_normalized_text_hash_not_allowlisted",
    );
    assert(
      input.existingNormalizedTextHash !== mainContentHash,
      "full_text_and_main_content_scope_not_distinct",
    );

    assert(input.prospectiveMainContentHash === mainContentHash, "prospective_main_content_hash_not_allowlisted");
    assert(input.prospectiveMainContentTextLength === 2224, "prospective_main_content_length_not_allowlisted");
    assert(input.prospectiveSourceId === sourceId, "prospective_source_not_allowlisted");
    assert(input.prospectiveFinalUrl === `${reviewedFinalUrl}/`, "prospective_final_url_not_allowlisted");
    assertR2Authority(input.authoritativeR2Binding);
    assertExactSemanticBridgeGeometryAuthority({
      legacyGeometryBridges,
      currentGeometryVerifiedRoles,
      existingArtifactLimitations,
    });

    assert(activation.shared_award_source_id === sourceId, "activation_source_not_allowlisted");
    assert(activation.source_acquisition_id === acquisitionId, "activation_acquisition_not_allowlisted");
    assert(activation.source_page_request_id === requestId, "activation_request_not_allowlisted");
    assert(activation.expected_normalized_text_sha256 === mainContentHash, "activation_expected_hash_not_allowlisted");
    assert(activation.observed_normalized_text_sha256 === mainContentHash, "activation_observed_hash_not_allowlisted");
    assert(activation.guard_sha256 === acquisitionGuardHash, "activation_guard_not_allowlisted");
    assert(activation.reviewed_final_url === reviewedFinalUrl, "activation_reviewed_url_not_allowlisted");
    assert(
      activation.observed_final_url === `${reviewedFinalUrl}/`,
      "activation_observed_url_not_allowlisted",
    );
    assert(activation.visual_evidence_quotes_verified === true, "activation_visual_quotes_not_verified");
    assert(activation.retained_evidence_quotes_verified === true, "activation_retained_quotes_not_verified");

    return {
      applies: true,
      accepted: true,
      reason: "exact_source_bound_main_content_acquisition_scope_verified",
      evidence: {
        schema: STAGE1_BEINECKE_FAQ_LEGACY_MAIN_CONTENT_BRIDGE_SCHEMA,
        source_id: sourceId,
        kind: "webpage",
        reviewed_source_page_type: "faq",
        reviewed_source_roles: ["faq"],
        reviewed_final_url: reviewedFinalUrl,
        immutable_generation: captureGeneration,
        legacy_capture_timestamp: captureTimestamp,
        source_acquisition_id: acquisitionId,
        source_page_request_id: requestId,
        sealed_acquisition_file_sha256: acquisitionFileHash,
        sealed_acquisition_guard_sha256: acquisitionGuardHash,
        comparison_scope: "main_content_only",
        immutable_acquisition_normalized_text_sha256: mainContentHash,
        legacy_main_content_sha256: mainContentHash,
        prospective_main_content_sha256: mainContentHash,
        legacy_full_browser_text_sha256: immutableCaptureIdentity.text_hash,
        legacy_full_browser_normalized_text_sha256: legacyFullBrowserNormalizedTextHash,
        geometry_authority: legacyGeometryBridges.length
          ? "exact_source_bound_pre_1fc005c_geometry_bridges"
          : "generic_current_geometry_verifier",
        legacy_geometry_bridge_roles: legacyGeometryBridges
          .map((bridge) => bridge.artifact_role)
          .sort(),
        current_geometry_verified_roles: [...currentGeometryVerifiedRoles].sort(),
        limitations: [
          "compatibility_bridge_scoped_to_one_reviewed_source_generation_and_acquisition_tuple",
          "acquisition_semantics_bound_to_main_content_hash_not_full_browser_text_hash",
          "full_browser_text_includes_navigation_chrome_and_expanded_section_states",
          "full_browser_text_mismatch_is_preserved_and_explicit_not_treated_as_equality",
          "compatibility_evidence_is_not_generic_semantic_geometry_or_promotion_authority",
        ],
      },
    };
  } catch (error) {
    return {
      applies: true,
      accepted: false,
      reason: cleanText(error?.message) || "legacy_main_content_bridge_invalid",
      evidence: null,
    };
  }
}

function assertExactSemanticBridgeGeometryAuthority({
  legacyGeometryBridges,
  currentGeometryVerifiedRoles,
  existingArtifactLimitations,
}) {
  const exactRoles = [
    "expansion_state_01_layout",
    "expansion_state_02_layout",
    "expansion_state_03_layout",
    "expansion_state_04_layout",
    "layout",
  ];
  if (legacyGeometryBridges.length) {
    assert(legacyGeometryBridges.length === exactRoles.length, "legacy_geometry_bridge_set_incomplete");
    assert(currentGeometryVerifiedRoles.length === 0, "legacy_geometry_authority_mixed");
    const roles = legacyGeometryBridges.map((bridge) => bridge?.artifact_role).sort();
    assert(sameJson(roles, exactRoles), "legacy_geometry_bridge_roles_not_allowlisted");
    assert(
      legacyGeometryBridges.every((bridge) => (
        bridge?.schema === STAGE1_BEINECKE_FAQ_LEGACY_GEOMETRY_BRIDGE_SCHEMA
        && bridge?.source_id === sourceId
        && bridge?.immutable_generation === captureGeneration
        && bridge?.legacy_capture_timestamp === captureTimestamp
      )),
      "legacy_geometry_bridge_identity_not_allowlisted",
    );
    return;
  }
  assert(
    sameJson([...currentGeometryVerifiedRoles].sort(), exactRoles),
    "current_geometry_verified_role_set_incomplete",
  );
  assert(
    !existingArtifactLimitations.some((limitation) => (
      typeof limitation === "string"
      && (
        limitation.includes("layout_explicitly_unavailable")
        || limitation.includes("layout_not_retained")
      )
    )),
    "generic_geometry_authority_unavailable",
  );
}

function assertCoreIdentity(input) {
  const existing = objectValue(input.existingCaptureIdentity);
  assert(input.kind === immutableCaptureIdentity.kind, "kind_not_allowlisted");
  assert(input.reviewedFinalUrl === reviewedFinalUrl, "reviewed_final_url_not_allowlisted");
  assert(input.reviewedSourcePageType === "faq", "reviewed_page_type_not_allowlisted");
  assert(
    Array.isArray(input.reviewedSourceRoles)
      && input.reviewedSourceRoles.length === 1
      && input.reviewedSourceRoles[0] === "faq",
    "reviewed_source_roles_not_allowlisted",
  );
  assert(input.existingCapturedAt === captureTimestamp, "capture_timestamp_not_allowlisted");
  assert(input.immutableGuardMainContentHash === mainContentHash, "immutable_guard_hash_not_allowlisted");
  assert(existing.main_content_hash === mainContentHash, "legacy_main_content_hash_not_allowlisted");
  assert(input.prospectiveMainContentHash === mainContentHash, "prospective_main_content_hash_not_allowlisted");
  assert(existing.text_hash === immutableCaptureIdentity.text_hash, "legacy_full_text_hash_not_allowlisted");
  assert(existing.body_text_hash === immutableCaptureIdentity.body_text_hash, "legacy_body_text_hash_not_allowlisted");
  assert(
    existing.nav_header_footer_hash === immutableCaptureIdentity.nav_header_footer_hash,
    "legacy_chrome_hash_not_allowlisted",
  );
  assert(existing.expansion_hash === immutableCaptureIdentity.expansion_hash, "legacy_expansion_hash_not_allowlisted");
  assert(existing.text_hash !== mainContentHash, "full_text_and_main_content_scope_not_distinct");
}

function assertR2Authority(receipt) {
  try {
    assertStage1EvidenceSchemaUpgradeR2BindingReceipt(receipt);
  } catch {
    throw new Error("r2_binding_receipt_invalid");
  }
  const pointer = objectValue(receipt.pointer_identity);
  const roles = Array.isArray(receipt.verified_roles) ? receipt.verified_roles : [];
  const layoutRole = roles.find((role) => role?.role === "layout");
  assert(receipt.receipt_sha256 === immutableCaptureIdentity.r2_binding_receipt_sha256, "r2_receipt_not_allowlisted");
  assert(receipt.source_id === sourceId && receipt.kind === "webpage", "r2_receipt_source_not_allowlisted");
  assert(receipt.captured_at === captureTimestamp, "r2_receipt_timestamp_not_allowlisted");
  assert(pointer.shared_award_source_id === sourceId, "r2_pointer_source_not_allowlisted");
  assert(pointer.kind === "webpage", "r2_pointer_kind_not_allowlisted");
  assert(pointer.bucket === "awardping-snapshots", "r2_pointer_bucket_not_allowlisted");
  assert(pointer.latest_captured_at === "2026-08-03T18:44:41.262+00:00", "r2_pointer_timestamp_not_allowlisted");
  assert(pointer.immutable_generation === captureGeneration, "r2_generation_not_allowlisted");
  assert(pointer.pointer_sha256 === immutableCaptureIdentity.r2_pointer_sha256, "r2_pointer_not_allowlisted");
  assert(pointer.latest_hashes?.main_content_hash === mainContentHash, "r2_main_content_hash_not_allowlisted");
  assert(pointer.latest_hashes?.layout_hash === roleAllowlist.layout.geometrySha256, "r2_geometry_hash_not_allowlisted");
  assert(pointer.latest_hashes?.image_hash === roleAllowlist.layout.imageSha256, "r2_image_hash_not_allowlisted");
  assert(pointer.latest_object_keys?.layout === `${r2CapturePrefix}layout.json`, "r2_layout_key_not_allowlisted");
  assert(
    layoutRole?.key === `${r2CapturePrefix}layout.json`
      && layoutRole?.sha256 === roleAllowlist.layout.bodySha256
      && layoutRole?.byte_length === roleAllowlist.layout.byteLength
      && layoutRole?.content_type === roleAllowlist.layout.contentType
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
  const proof = objectValue(layout.capture_verification);

  assert(artifact.name === entry.artifactSlot, "artifact_role_not_allowlisted");
  assert(artifact.fileName === entry.fileName, "artifact_filename_not_allowlisted");
  assert(normalizedPath(artifact.path).endsWith(`/${localCapturePrefix}${entry.fileName}`), "artifact_path_not_allowlisted");
  assert(artifact.contentType === entry.contentType, "artifact_content_type_not_allowlisted");
  assert(Buffer.isBuffer(artifact.body), "artifact_body_missing");
  assert(sha256(artifact.body) === entry.bodySha256, "layout_body_hash_not_allowlisted");
  assert(
    binding.sha256 === entry.bodySha256
      && binding.byte_length === entry.byteLength
      && binding.content_type === entry.contentType
      && binding.hash_mode === "raw_sha256",
    "layout_artifact_binding_not_allowlisted",
  );
  assert(layout.version === 3, "layout_version_not_allowlisted");
  assert(layout.state_id === entry.stateId, "layout_state_not_allowlisted");
  assert(layout.captured_at === entry.capturedAt, "layout_timestamp_not_allowlisted");
  assert(layout.coordinate_space === entry.coordinateSpace, "layout_coordinate_space_not_allowlisted");
  assert(sameJson(layout.document, entry.document), "layout_document_dimensions_not_allowlisted");
  assert(sameJson(layout.viewport, entry.viewport), "layout_viewport_dimensions_not_allowlisted");
  assert(sameJson(layout.scroll, entry.scroll), "layout_scroll_not_allowlisted");
  assert(layout.device_pixel_ratio === entry.devicePixelRatio, "layout_dpr_not_allowlisted");
  assert(layout.node_count === entry.nodeCount, "layout_node_count_not_allowlisted");
  assert(layout.run_count === entry.runCount, "layout_run_count_not_allowlisted");
  assert(Array.isArray(layout.nodes) && layout.nodes.length === entry.nodeCount, "layout_nodes_not_allowlisted");
  assert(
    layout.nodes.reduce((count, node) => count + (Array.isArray(node?.runs) ? node.runs.length : 0), 0)
      === entry.runCount,
    "layout_runs_not_allowlisted",
  );
  assert(sameJson(layout.paint_stack, entry.paintStack), "layout_paint_proof_not_allowlisted");
  assert(sameJson(layout.screenshot, entry.screenshot), "layout_screenshot_alignment_not_allowlisted");
  assert(layout.geometry_hash === entry.geometrySha256, "layout_geometry_hash_not_allowlisted");
  assert(input.expectedLayoutHash === entry.geometrySha256, "capture_layout_hash_not_allowlisted");
  assert(input.metadataLayoutHash === entry.geometrySha256, "metadata_layout_hash_not_allowlisted");
  assert(input.expectedImageHash === entry.imageSha256, "capture_image_hash_not_allowlisted");
  assert(
    proof.contract === "visual-screenshot-layout-binding-v1"
      && proof.status === "verified"
      && proof.state_id === entry.stateId
      && proof.before_fingerprint === entry.proofSha256
      && proof.after_fingerprint === entry.proofSha256
      && proof.screenshot_alignment === "verified"
      && Object.keys(proof).length === 6,
    "stored_before_after_proof_not_allowlisted",
  );
  assert(verifyVisualTextGeometryBinding(layout, entry.imageSha256).valid, "geometry_image_binding_invalid");
  assert(sameJson(captureGeometry, layout), "capture_geometry_not_identical_to_layout_bytes");
  assert(
    sameJson(metadataGeometry, metadataGeometryProjection(entry)),
    "metadata_geometry_projection_not_allowlisted",
  );
}

function metadataGeometryProjection(entry) {
  return {
    version: 3,
    status: "ready",
    unavailable_reason: null,
    geometry_hash: entry.geometrySha256,
    coordinate_space: entry.coordinateSpace,
    node_count: entry.nodeCount,
    run_count: entry.runCount,
    document: entry.document,
    viewport: entry.viewport,
    screenshot: entry.screenshot,
    file: `${localCapturePrefix}${entry.fileName}`,
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
  // This producer captured Chromium DOMRect endpoints on its 1/64 CSS-pixel
  // lattice, rounded start, size, and end independently to hundredths, then
  // the old binder recomputed the retained end from rounded start + size. The
  // bridge restores the independently rounded endpoint only when the lattice
  // has exactly one possible start/end pair; ambiguity is a hard refusal.
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

function roundHundredth(value) {
  return Math.round(Number(value) * 100) / 100;
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
