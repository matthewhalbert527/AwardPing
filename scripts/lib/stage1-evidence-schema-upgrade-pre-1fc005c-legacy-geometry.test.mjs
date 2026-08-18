import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isR2CaptureGeometryReady } from "./r2-capture-artifact-bindings.mjs";
import * as legacyBridge from "./stage1-evidence-schema-upgrade-pre-1fc005c-legacy-geometry.mjs";

const {
  STAGE1_PRE_1FC005C_LEGACY_GEOMETRY_BRIDGE_SCHEMA,
  STAGE1_PRE_1FC005C_LEGACY_GEOMETRY_SOURCE_IDS,
  evaluateStage1Pre1fc005cLegacyGeometryBridge,
} = legacyBridge;

const reportPath = new URL(
  "../../reports/visual-snapshot-run-2026-08-15T05-35-20-918Z-shard-1-e72368f4.json",
  import.meta.url,
);
const archiveRoot = "D:/AwardPingVisualSnapshots";
const contentType = "application/json; charset=utf-8";
const exactR2Roles = ["layout", "meta", "page", "text", "thumb"];
const fixtureDefinitions = Object.freeze([
  Object.freeze({
    sourceId: "c30778fe-43d7-57be-842a-e046d84baaee",
    captureDirectory: "2026-08-03T18-37-29-113Z",
    reviewedFinalUrl:
      "https://beineckescholarship.org/about/about-beinecke-scholarship",
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
  }),
  Object.freeze({
    sourceId: "af1367b5-0cb0-5b21-8e78-7dc195dd996f",
    captureDirectory: "2026-08-03T18-38-42-518Z",
    reviewedFinalUrl:
      "https://beineckescholarship.org/beinecke-scholarship/submission-materials",
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
  }),
  Object.freeze({
    sourceId: "5ec9a453-fd62-53e5-b885-726b21ce7247",
    captureDirectory: "2026-08-03T18-50-08-220Z",
    reviewedFinalUrl: "https://www.hertzfoundation.org/hertz-fellowship",
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
  }),
  Object.freeze({
    sourceId: "fa4088a7-706e-4ad3-ae12-3653751dd5e1",
    captureDirectory: "2026-08-03T18-50-42-281Z",
    reviewedFinalUrl: "https://ndseg.org/",
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
  }),
  Object.freeze({
    sourceId: "664d38ba-c717-5d51-b7ce-9e3a27f41fec",
    captureDirectory: "2026-08-03T18-51-38-842Z",
    reviewedFinalUrl: "https://samvidscholars.org/",
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
  }),
  Object.freeze({
    sourceId: "c28878c0-6a8b-5fa8-b99b-ec826b86d8f2",
    captureDirectory: "2026-08-03T18-52-22-287Z",
    reviewedFinalUrl:
      "https://yenchingacademy.pku.edu.cn/ADMISSIONS/Frequently_Asked_Questions.htm",
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
  }),
]);

const retainedFixtureAvailable = existsSync(reportPath)
  && fixtureDefinitions.every((definition) => {
    const root = fixtureRoot(definition);
    return existsSync(`${root}/layout.json`) && existsSync(`${root}/meta.json`);
  });
const report = retainedFixtureAvailable
  ? JSON.parse(readFileSync(reportPath, "utf8"))
  : null;

describe("exact-six pre-1fc005c legacy geometry bridge contract", () => {
  it("exports only the geometry-only bridge surface and six frozen source IDs", () => {
    expect(Object.keys(legacyBridge).sort()).toEqual([
      "STAGE1_PRE_1FC005C_LEGACY_GEOMETRY_BRIDGE_SCHEMA",
      "STAGE1_PRE_1FC005C_LEGACY_GEOMETRY_SOURCE_IDS",
      "evaluateStage1Pre1fc005cLegacyGeometryBridge",
    ]);
    expect(STAGE1_PRE_1FC005C_LEGACY_GEOMETRY_SOURCE_IDS).toEqual(
      fixtureDefinitions.map((definition) => definition.sourceId),
    );
    expect(Object.isFrozen(STAGE1_PRE_1FC005C_LEGACY_GEOMETRY_SOURCE_IDS)).toBe(true);
  });

  it("returns before inspecting non-source evidence for a sibling source", () => {
    const sibling = new Proxy(
      { sourceId: "11111111-1111-4111-8111-111111111111" },
      {
        get(target, property, receiver) {
          if (property === "sourceId") return Reflect.get(target, property, receiver);
          throw new Error(`unexpected evidence access: ${String(property)}`);
        },
      },
    );
    expect(evaluateStage1Pre1fc005cLegacyGeometryBridge(sibling)).toEqual({
      applies: false,
      accepted: false,
      reason: "source_not_allowlisted",
      evidence: null,
    });
  });

  it("does not fuzzy-match a source identifier", () => {
    expect(evaluateStage1Pre1fc005cLegacyGeometryBridge({
      sourceId: ` ${fixtureDefinitions[0].sourceId}`,
    })).toEqual({
      applies: false,
      accepted: false,
      reason: "source_not_allowlisted",
      evidence: null,
    });
  });
});

describe.runIf(retainedFixtureAvailable)("retained exact-six pre-1fc005c geometry evidence", () => {
  it("accepts all six exact tuples only after the current verifier rejects them", () => {
    for (const definition of fixtureDefinitions) {
      const input = validInput(definition);
      expect(isR2CaptureGeometryReady({
        kind: "webpage",
        image_hash: input.expectedImageHash,
        text_geometry: input.layout,
      })).toBe(false);
      expect(isR2CaptureGeometryReady({
        kind: "webpage",
        image_hash: input.expectedImageHash,
        text_geometry: input.captureGeometry,
      })).toBe(false);

      const decision = evaluateStage1Pre1fc005cLegacyGeometryBridge(input);
      expect(decision).toMatchObject({
        applies: true,
        accepted: true,
        reason: "exact_source_generation_layout_pre_1fc005c_geometry_verified",
        evidence: {
          schema: STAGE1_PRE_1FC005C_LEGACY_GEOMETRY_BRIDGE_SCHEMA,
          source_id: definition.sourceId,
          artifact_role: "layout",
          immutable_generation: definition.generation,
          r2_binding_receipt_sha256: definition.receiptSha256,
          r2_pointer_sha256: definition.pointerSha256,
          r2_layout_remote_body_verified: true,
          exact_verified_r2_roles: exactR2Roles,
          zero_expansion_states_verified: true,
          layout_body_sha256: definition.layoutBodySha256,
          layout_body_byte_length: definition.layoutByteLength,
          geometry_sha256: definition.geometrySha256,
          image_sha256: definition.imageSha256,
          stored_before_after_fingerprint_sha256: definition.storedProofSha256,
          current_canonical_fingerprint_sha256: definition.currentFingerprintSha256,
          reconstructed_preimage_nodes_sha256: definition.reconstructedNodesSha256,
          reconstructed_preimage_grid: "chromium_css_pixels_1_64",
          reconstructed_rect_count: definition.rectCount,
          reconstructed_unique_preimage_rect_count: definition.rectCount,
          reconstructed_changed_right_count: definition.changedRightCount,
          reconstructed_changed_bottom_count: 0,
          semantic_or_acquisition_equivalence_authority: false,
          promotion_authority: false,
          mutation_authority: false,
        },
      });
      expect(decision.evidence).not.toHaveProperty("acquisition_semantics");
      expect(decision.evidence.limitations).toEqual(expect.arrayContaining([
        "compatibility_bridge_scoped_to_six_exact_source_generation_layout_tuples",
        "zero_expansion_states_only",
        "semantic_and_acquisition_equivalence_are_not_evaluated_or_waived",
        "compatibility_evidence_is_not_generic_geometry_or_promotion_authority",
      ]));
    }
  });

  it("rejects every cross-source receipt or layout swap", () => {
    for (const [index, definition] of fixtureDefinitions.entries()) {
      const other = fixtureDefinitions[(index + 1) % fixtureDefinitions.length];
      const receiptSwap = validInput(definition);
      receiptSwap.authoritativeR2Binding = validInput(other).authoritativeR2Binding;
      expect(evaluateStage1Pre1fc005cLegacyGeometryBridge(receiptSwap)).toMatchObject({
        applies: true,
        accepted: false,
      });

      const bodySwap = validInput(definition);
      const otherInput = validInput(other);
      bodySwap.artifact.body = otherInput.artifact.body;
      bodySwap.layout = otherInput.layout;
      bodySwap.captureGeometry = otherInput.captureGeometry;
      expect(evaluateStage1Pre1fc005cLegacyGeometryBridge(bodySwap)).toMatchObject({
        applies: true,
        accepted: false,
      });
    }
  });

  const adversarialCases = [
    ["source identity", (input) => { input.sourceId = ` ${input.sourceId}`; }],
    ["exact source identity", (input) => { input.exactSourceId = ` ${input.exactSourceId}`; }],
    ["kind", (input) => { input.kind = "pdf"; }],
    ["reviewed final URL", (input) => { input.reviewedFinalUrl += "/other"; }],
    ["capture timestamp", (input) => { input.existingCapturedAt = "2026-08-03T18:37:29.114Z"; }],
    ["capture source", (input) => { input.existingCaptureIdentity.source.id = "0".repeat(36); }],
    ["capture final URL", (input) => { input.existingCaptureIdentity.final_url += "other"; }],
    ["capture layout hash", (input) => { input.existingCaptureIdentity.layout_hash = "0".repeat(64); }],
    ["capture image hash", (input) => { input.existingCaptureIdentity.image_hash = "0".repeat(64); }],
    ["capture layout path", (input) => { input.existingCaptureIdentity.files.layout += ".other"; }],
    ["hydrated capture layout path", (input) => {
      input.existingCaptureIdentity.layout_path += ".other";
    }],
    ["expansion screenshot injection", (input) => {
      input.existingCaptureIdentity.expansion_state_screenshots.push({ state_id: "expansion-state-01" });
    }],
    ["expansion file injection", (input) => {
      input.existingCaptureIdentity.files.expansion_states.push({ state_id: "expansion-state-01" });
    }],
    ["expansion attempt", (input) => { input.existingCaptureIdentity.expansion_state_attempted = 1; }],
    ["expansion incomplete", (input) => {
      input.existingCaptureIdentity.expansion_state_capture_complete = false;
    }],
    ["sealed R2 receipt", (input) => { input.authoritativeR2Binding.receipt_sha256 = "0".repeat(64); }],
    ["R2 pointer", (input) => {
      input.authoritativeR2Binding.pointer_identity.pointer_sha256 = "0".repeat(64);
    }],
    ["R2 generation", (input) => {
      input.authoritativeR2Binding.pointer_identity.immutable_generation = "0".repeat(32);
    }],
    ["R2 layout key", (input) => {
      input.authoritativeR2Binding.pointer_identity.latest_object_keys.layout += ".other";
    }],
    ["R2 expansion role", (input) => {
      input.authoritativeR2Binding.verified_roles.push({
        role: "expansion_state_01_layout",
        key: "unexpected",
        sha256: "0".repeat(64),
        byte_length: 1,
        content_type: contentType,
        remote_body_verified: true,
      });
    }],
    ["R2 remote body verification", (input) => {
      input.authoritativeR2Binding.verified_roles
        .find((role) => role.role === "layout").remote_body_verified = false;
    }],
    ["R2 artifact binding verification", (input) => {
      input.authoritativeR2Binding.artifact_binding_verification.status = "claimed";
    }],
    ["role", (input) => { input.artifactSlot = "expansion_state_01_layout"; }],
    ["artifact role", (input) => { input.artifact.name = "meta"; }],
    ["artifact filename", (input) => { input.artifact.fileName = "other.json"; }],
    ["artifact generation path", (input) => { input.artifact.path += ".other"; }],
    ["artifact traversal path", (input) => {
      input.artifact.path = `D:/outside/../${input.existingCaptureIdentity.files.layout}`;
    }],
    ["artifact content type", (input) => { input.artifact.contentType = "application/json"; }],
    ["artifact bytes", (input) => {
      input.artifact.body = Buffer.concat([input.artifact.body, Buffer.from("\n")]);
    }],
    ["artifact binding hash", (input) => { input.artifact.binding.sha256 = "0".repeat(64); }],
    ["artifact binding length", (input) => { input.artifact.binding.byte_length += 1; }],
    ["artifact binding mode", (input) => { input.artifact.binding.hash_mode = "semantic"; }],
    ["parsed layout identity", (input) => { input.layout.state_id = "other"; }],
    ["capture geometry identity", (input) => { input.captureGeometry.state_id = "other"; }],
    ["metadata geometry projection", (input) => { input.metadataGeometry.status = "claimed"; }],
    ["capture metadata projection", (input) => {
      input.existingCaptureIdentity.text_geometry.status = "claimed";
    }],
    ["expected layout hash", (input) => { input.expectedLayoutHash = "0".repeat(64); }],
    ["metadata layout hash", (input) => { input.metadataLayoutHash = "0".repeat(64); }],
    ["expected image hash", (input) => { input.expectedImageHash = "0".repeat(64); }],
    ["stored before proof", (input) => {
      input.layout.capture_verification.before_fingerprint = "0".repeat(64);
    }],
    ["stored after proof", (input) => {
      input.layout.capture_verification.after_fingerprint = "0".repeat(64);
    }],
    ["current verifier ordering", (input) => { input.currentGeometryVerification.ran_first = false; }],
    ["current verifier layout result", (input) => {
      input.currentGeometryVerification.layout_ready = true;
    }],
    ["current verifier capture result", (input) => {
      input.currentGeometryVerification.capture_ready = true;
    }],
  ];

  it.each(adversarialCases)("fails closed for any %s drift", (_label, mutate) => {
    const input = validInput(fixtureDefinitions[0]);
    mutate(input);
    expect(evaluateStage1Pre1fc005cLegacyGeometryBridge(input)).toMatchObject({
      accepted: false,
    });
  });
});

function validInput(definition) {
  const root = fixtureRoot(definition);
  const body = readFileSync(`${root}/layout.json`);
  const layout = JSON.parse(body.toString("utf8"));
  const metadata = JSON.parse(readFileSync(`${root}/meta.json`, "utf8"));
  const reportResult = report.stage1_evidence_schema_upgrade.results
    .find((result) => result.source_id === definition.sourceId);
  const receipt = reportResult.capture_validation.evidence.authoritative_existing_r2_binding;
  const hydratedCapture = structuredClone(metadata);
  hydratedCapture.text_geometry = structuredClone(layout);
  hydratedCapture.layout_path = `${root}/layout.json`;
  return {
    sourceId: definition.sourceId,
    exactSourceId: definition.sourceId,
    kind: "webpage",
    reviewedFinalUrl: definition.reviewedFinalUrl,
    existingCapturedAt: metadata.captured_at,
    existingCaptureIdentity: hydratedCapture,
    authoritativeR2Binding: structuredClone(receipt),
    artifactSlot: "layout",
    artifact: {
      name: "layout",
      fileName: "layout.json",
      path: `${root}/layout.json`,
      contentType,
      body,
      binding: {
        sha256: sha256(body),
        byte_length: body.length,
        content_type: contentType,
        hash_mode: "raw_sha256",
      },
    },
    layout: structuredClone(layout),
    captureGeometry: structuredClone(layout),
    metadataGeometry: structuredClone(metadata.text_geometry),
    expectedImageHash: metadata.image_hash,
    expectedLayoutHash: metadata.layout_hash,
    metadataLayoutHash: metadata.text_geometry.geometry_hash,
    currentGeometryVerification: {
      ran_first: true,
      layout_ready: false,
      capture_ready: false,
    },
  };
}

function fixtureRoot(definition) {
  return `${archiveRoot}/sources/${definition.sourceId}/captures/${definition.captureDirectory}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
