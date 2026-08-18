import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  stage1EvidenceSchemaUpgradeR2BindingReceiptSha256,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";
import {
  STAGE1_LEGACY_EMPTY_EXPANSION_LENGTH_BRIDGE_SCHEMA,
  STAGE1_LEGACY_EMPTY_EXPANSION_LENGTH_SOURCE_IDS,
  evaluateStage1LegacyEmptyExpansionLengthBridge,
} from "./stage1-evidence-schema-upgrade-legacy-empty-expansion.mjs";

const emptyTextSha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const reviewedIdentities = Object.freeze([
  identity({
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
  identity({
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
  identity({
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
  identity({
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
  identity({
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
  identity({
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
  identity({
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
]);

describe("Stage 1 reviewed-source legacy empty-expansion bridge", () => {
  it("accepts all seven exact source, acquisition, and generation tuples", () => {
    expect(STAGE1_LEGACY_EMPTY_EXPANSION_LENGTH_SOURCE_IDS).toEqual(
      reviewedIdentities.map((value) => value.sourceId),
    );
    for (const identityValue of reviewedIdentities) {
      expect(evaluateStage1LegacyEmptyExpansionLengthBridge(
        validBridgeInput(identityValue),
      )).toMatchObject({
        applies: true,
        accepted: true,
        reason: "exact_source_bound_legacy_empty_expansion_length_verified",
        evidence: {
          schema: STAGE1_LEGACY_EMPTY_EXPANSION_LENGTH_BRIDGE_SCHEMA,
          source_id: identityValue.sourceId,
          legacy_capture_timestamp: identityValue.capturedAt,
          source_acquisition_id: identityValue.acquisitionId,
          source_page_request_id: identityValue.requestId,
          immutable_generation: identityValue.immutableGeneration,
          repaired_field: "expansion_text_length",
          legacy_baseline_value: null,
          authoritative_retained_value: 0,
          expansion_text_sha256: emptyTextSha256,
          expansion_state_count: 0,
          exact_other_semantic_fields_verified: true,
        },
      });
    }
  });

  it("does not apply to another source or a whitespace-fuzzy source ID", () => {
    const another = validBridgeInput(reviewedIdentities[0]);
    another.sourceId = "11111111-1111-4111-8111-111111111111";
    another.exactSourceId = another.sourceId;
    expect(evaluateStage1LegacyEmptyExpansionLengthBridge(another)).toEqual({
      applies: false,
      accepted: false,
      reason: "source_generation_not_allowlisted",
      evidence: null,
    });

    const whitespace = validBridgeInput(reviewedIdentities[0]);
    whitespace.exactSourceId = ` ${whitespace.sourceId}`;
    expect(evaluateStage1LegacyEmptyExpansionLengthBridge(whitespace)).toEqual({
      applies: false,
      accepted: false,
      reason: "source_generation_not_allowlisted",
      evidence: null,
    });
  });

  const adversarialCases = [
    ["missing legacy length", (input) => { delete input.existingBaseline.expansion_text_length; }],
    ["non-null legacy length", (input) => { input.existingBaseline.expansion_text_length = 0; }],
    ["unknown retained length", (input) => { input.existingCaptureIdentity.expansion_text_length = null; }],
    ["nonempty retained length", (input) => { input.existingCaptureIdentity.expansion_text_length = 1; }],
    ["nonempty expansion hash", (input) => {
      const nonemptyHash = "9".repeat(64);
      input.existingBaseline.expansion_hash = nonemptyHash;
      input.existingCaptureIdentity.expansion_hash = nonemptyHash;
      input.authoritativeR2Binding.pointer_identity.latest_hashes.expansion_hash = nonemptyHash;
      resealReceipt(input.authoritativeR2Binding);
    }],
    ["unknown expansion hash", (input) => {
      input.existingBaseline.expansion_hash = null;
      input.existingCaptureIdentity.expansion_hash = null;
      input.authoritativeR2Binding.pointer_identity.latest_hashes.expansion_hash = null;
      resealReceipt(input.authoritativeR2Binding);
    }],
    ["nonempty expandable-section hash", (input) => {
      input.existingBaseline.expandable_sections_hash = "8".repeat(64);
      input.existingCaptureIdentity.expandable_sections_hash = "8".repeat(64);
    }],
    ["baseline expansion state", (input) => {
      input.existingBaseline.capture.expansion_states.push({ state_id: "expansion-state-01" });
    }],
    ["capture expansion state", (input) => {
      input.existingCaptureIdentity.expansion_state_screenshots.push({
        state_id: "expansion-state-01",
      });
    }],
    ["baseline expansion artifact", (input) => {
      input.existingBaseline.capture.expansion_text = "sources/unexpected/expansion.txt";
    }],
    ["capture expansion artifact", (input) => {
      input.existingCaptureIdentity.expansion_text_path = "C:/unexpected/expansion.txt";
    }],
    ["another semantic field", (input) => {
      input.existingCaptureIdentity.main_content_hash = "7".repeat(64);
    }],
    ["acquisition ID", (input) => {
      input.sealedAcquisition.source_acquisition_id_exact =
        "11111111-1111-4111-8111-111111111111";
    }],
    ["acquisition normalized hash", (input) => {
      input.sealedAcquisition.normalized_text_hash_exact = "6".repeat(64);
    }],
    ["capture timestamp", (input) => {
      input.existingCaptureIdentity.captured_at = "2026-08-03T18:37:29.114Z";
    }],
    ["immutable R2 generation", (input) => {
      input.authoritativeR2Binding.pointer_identity.immutable_generation = "0".repeat(32);
      resealReceipt(input.authoritativeR2Binding);
    }],
    ["R2 remote verification", (input) => {
      input.authoritativeR2Binding.verified_roles[0].remote_body_verified = false;
      resealReceipt(input.authoritativeR2Binding);
    }],
    ["sealed R2 receipt", (input) => {
      input.authoritativeR2Binding.receipt_sha256 = "0".repeat(64);
    }],
  ];

  it.each(adversarialCases)("fails closed for %s", (_label, mutate) => {
    const input = validBridgeInput(reviewedIdentities[0]);
    mutate(input);
    expect(evaluateStage1LegacyEmptyExpansionLengthBridge(input)).toMatchObject({
      applies: true,
      accepted: false,
    });
  });

  it("wires only the exact bridge and preserves numeric zero in both baseline serializers", () => {
    const validation = readFileSync(
      new URL("./stage1-evidence-schema-upgrade-validation.mjs", import.meta.url),
      "utf8",
    );
    const captureWorker = readFileSync(
      new URL("../capture-visual-snapshots.mjs", import.meta.url),
      "utf8",
    );
    const promotion = readFileSync(
      new URL("./visual-baseline-promotion.mjs", import.meta.url),
      "utf8",
    );
    expect(validation).toContain("evaluateStage1LegacyEmptyExpansionLengthBridge");
    expect(validation).toContain("legacy_semantic_identity_bridges");
    expect(captureWorker).toContain(
      "expansion_text_length: capture.expansion_text_length ?? null",
    );
    expect(captureWorker).not.toContain(
      "expansion_text_length: capture.expansion_text_length || null",
    );
    expect(promotion).toContain(
      "expansion_text_length: expansionTextLength",
    );
    expect(promotion).not.toContain(
      "expansion_text_length: capture.expansion_text_length || null",
    );
  });
});

function validBridgeInput(identityValue) {
  const activationGuardSha256 = "f".repeat(64);
  const directory = captureTimestampDirectory(identityValue.capturedAt);
  const capturePrefix = `sources/${identityValue.sourceId}/captures/${directory}/`;
  const semantic = {
    text_hash: "1".repeat(64),
    text_length: 100,
    body_text_hash: "2".repeat(64),
    body_text_length: 90,
    main_content_hash: "3".repeat(64),
    main_content_text_length: 80,
    nav_header_footer_hash: "4".repeat(64),
    nav_header_footer_text_length: 10,
    expansion_hash: emptyTextSha256,
    expandable_sections_hash: emptyTextSha256,
    image_hash: "5".repeat(64),
    layout_hash: "6".repeat(64),
  };
  const activation = {
    status: "server_prepare_recorded",
    shared_award_source_id: identityValue.sourceId,
    source_acquisition_id: identityValue.acquisitionId,
    source_page_request_id: identityValue.requestId,
    capture_file_sha256: identityValue.acquisitionFileSha256,
    expected_normalized_text_sha256: identityValue.acquisitionNormalizedTextSha256,
    observed_normalized_text_sha256: identityValue.acquisitionNormalizedTextSha256,
    guard_sha256: activationGuardSha256,
    reviewed_final_url: identityValue.reviewedFinalUrl,
    observed_final_url: identityValue.observedFinalUrl,
    visual_evidence_quotes_verified: true,
    retained_evidence_quotes_verified: true,
  };
  const existingBaseline = {
    version: 1,
    kind: "webpage",
    source: { id: identityValue.sourceId },
    captured_at: identityValue.capturedAt,
    final_url: identityValue.observedFinalUrl,
    ...semantic,
    expansion_text_length: null,
    capture: {
      meta: `${capturePrefix}meta.json`,
      text: `${capturePrefix}text.txt`,
      expansion_text: null,
      expansion_states: [],
    },
    summary_metadata: { stage1_baseline_activation: activation },
  };
  const existingCaptureIdentity = {
    version: 1,
    kind: "webpage",
    source: { id: identityValue.sourceId },
    captured_at: identityValue.capturedAt,
    final_url: identityValue.observedFinalUrl,
    ...semantic,
    expansion_text_length: 0,
    meta_path: `C:/archive/${capturePrefix}meta.json`,
    text_path: `C:/archive/${capturePrefix}text.txt`,
    expansion_text_path: null,
    expansion_state_screenshots: [],
  };
  return {
    sourceId: identityValue.sourceId,
    exactSourceId: identityValue.sourceId,
    kind: "webpage",
    reviewedFinalUrl: identityValue.reviewedFinalUrl,
    sealedAcquisition: {
      final_url_exact: identityValue.reviewedFinalUrl,
      source_acquisition_id_exact: identityValue.acquisitionId,
      request_id_exact: identityValue.requestId,
      file_hash_exact: identityValue.acquisitionFileSha256,
      normalized_text_hash_exact: identityValue.acquisitionNormalizedTextSha256,
    },
    activationGuardSha256,
    existingBaseline,
    existingCaptureIdentity,
    authoritativeR2Binding: r2Receipt(identityValue, existingCaptureIdentity),
  };
}

function r2Receipt(identityValue, capture) {
  const prefix =
    `visual-snapshots/sources/${identityValue.sourceId}/captures/` +
    `${identityValue.immutableGeneration}/`;
  const contracts = {
    layout: ["layout.json", "application/json; charset=utf-8"],
    meta: ["meta.json", "application/json; charset=utf-8"],
    page: ["page.jpg", "image/jpeg"],
    text: ["text.txt", "text/plain; charset=utf-8"],
    thumb: ["thumb.jpg", "image/jpeg"],
  };
  const latestObjectKeys = Object.fromEntries(
    Object.entries(contracts).map(([role, [fileName]]) => [role, `${prefix}${fileName}`]),
  );
  const pointerProjection = {
    shared_award_source_id: identityValue.sourceId,
    kind: "webpage",
    bucket: "awardping-snapshots",
    latest_captured_at: identityValue.capturedAt.replace(/Z$/u, "+00:00"),
    latest_object_keys: latestObjectKeys,
    latest_hashes: {
      body_text_hash: capture.body_text_hash,
      expansion_hash: capture.expansion_hash,
      file_hash: null,
      image_hash: capture.image_hash,
      layout_hash: capture.layout_hash,
      main_content_hash: capture.main_content_hash,
      nav_header_footer_hash: capture.nav_header_footer_hash,
      text_hash: capture.text_hash,
    },
    latest_metadata_sha256: "7".repeat(64),
    immutable_generation: identityValue.immutableGeneration,
  };
  const previousProjection = {
    verification_scope: "report_only_not_validated",
    preserved: true,
    previous_captured_at: null,
    previous_object_keys: {},
    previous_hashes: {},
    previous_metadata: {},
  };
  previousProjection.projection_sha256 = sha256(stableJson(previousProjection));
  const content = {
    schema: "awardping.stage1.evidence-schema-upgrade-r2-binding.v1",
    status: "verified",
    source_id: identityValue.sourceId,
    kind: "webpage",
    captured_at: identityValue.capturedAt,
    creates_api_charge: false,
    mutation_performed: false,
    pointer_identity: {
      ...pointerProjection,
      pointer_sha256: sha256(stableJson(pointerProjection)),
    },
    previous_pointer: previousProjection,
    artifact_binding_verification: {
      status: "derived_from_exact_local_and_remote_bytes",
      pointer_claim_present: false,
      derived_binding_count: 5,
    },
    verified_roles: Object.entries(contracts).map(([role, [, contentType]], index) => ({
      role,
      key: latestObjectKeys[role],
      sha256: String(index + 1).repeat(64),
      byte_length: index + 10,
      content_type: contentType,
      remote_body_verified: true,
    })),
    semantic_text: {
      sha256: capture.text_hash,
      character_length: capture.text_length,
      object_byte_length: capture.text_length + 1,
      writer_framing: "lf",
    },
    limitations: [],
  };
  return {
    ...content,
    receipt_sha256: stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(content),
  };
}

function resealReceipt(receipt) {
  const pointer = { ...receipt.pointer_identity };
  delete pointer.pointer_sha256;
  receipt.pointer_identity.pointer_sha256 = sha256(stableJson(pointer));
  receipt.receipt_sha256 = stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(receipt);
}

function captureTimestampDirectory(value) {
  return new Date(value).toISOString().replace(/[:.]/gu, "-");
}

function identity(value) {
  return Object.freeze(value);
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
