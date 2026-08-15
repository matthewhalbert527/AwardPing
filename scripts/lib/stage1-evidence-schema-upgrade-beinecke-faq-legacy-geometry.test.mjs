import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  beineckeFaqLegacyFixtureBody,
  beineckeFaqLegacyFixtureJson,
} from "./fixtures/beinecke-faq-legacy-geometry-fixture.mjs";
import { isR2CaptureGeometryReady } from "./r2-capture-artifact-bindings.mjs";
import {
  STAGE1_BEINECKE_FAQ_LEGACY_GEOMETRY_BRIDGE_SCHEMA,
  STAGE1_BEINECKE_FAQ_LEGACY_MAIN_CONTENT_BRIDGE_SCHEMA,
  evaluateStage1BeineckeFaqLegacyGeometryBridge,
  evaluateStage1BeineckeFaqLegacyMainContentBridge,
} from "./stage1-evidence-schema-upgrade-beinecke-faq-legacy-geometry.mjs";

const sourceId = "2ea41875-5c88-5794-81b3-afa8ddaf31c1";
const capturedAt = "2026-08-03T18:44:41.262Z";
const mainContentHash = "4cbc91149287266cd6c0a1a4156d05a1c74bc393be29ca73369aa613b6f49c27";
const contentType = "application/json; charset=utf-8";
const roleDefinitions = Object.freeze({
  layout: { fileName: "layout.json", metadataIndex: null, rectCount: 416 },
  expansion_state_01_layout: {
    fileName: "expansion-state-01-layout.json",
    metadataIndex: 0,
    rectCount: 173,
  },
  expansion_state_02_layout: {
    fileName: "expansion-state-02-layout.json",
    metadataIndex: 1,
    rectCount: 196,
  },
  expansion_state_03_layout: {
    fileName: "expansion-state-03-layout.json",
    metadataIndex: 2,
    rectCount: 180,
  },
  expansion_state_04_layout: {
    fileName: "expansion-state-04-layout.json",
    metadataIndex: 3,
    rectCount: 194,
  },
});

describe("reviewed Beinecke FAQ pre-1fc005c geometry bridge", () => {
  it("runs after the unchanged current verifier and accepts only all five exact immutable roles", () => {
    for (const [role, definition] of Object.entries(roleDefinitions)) {
      const input = validBridgeInput(role);
      expect(isR2CaptureGeometryReady({
        kind: "webpage",
        image_hash: input.expectedImageHash,
        text_geometry: input.layout,
      })).toBe(false);

      const decision = evaluateStage1BeineckeFaqLegacyGeometryBridge(input);
      expect(decision).toMatchObject({
        applies: true,
        accepted: true,
        reason: "exact_source_bound_pre_1fc005c_geometry_verified",
        evidence: {
          schema: STAGE1_BEINECKE_FAQ_LEGACY_GEOMETRY_BRIDGE_SCHEMA,
          source_id: sourceId,
          artifact_role: role,
          reconstructed_preimage_grid: "chromium_css_pixels_1_64",
          reconstructed_rect_count: definition.rectCount,
          reconstructed_unique_preimage_rect_count: definition.rectCount,
          generic_geometry_verifier: {
            ran_first: true,
            layout_ready: false,
            capture_ready: false,
          },
        },
      });
      expect(decision.evidence.limitations).toEqual(expect.arrayContaining([
        "compatibility_bridge_scoped_to_one_reviewed_source_generation_and_role_tuple",
        "pre_1fc005c_fingerprint_reconstructed_only_from_unique_chromium_1_64_pixel_preimages",
        "acquisition_semantics_bound_to_main_content_hash_not_full_browser_text_hash",
        "full_browser_text_includes_navigation_chrome_and_expanded_section_states",
        "compatibility_evidence_is_not_generic_geometry_or_promotion_authority",
      ]));
      expect(decision.evidence.acquisition_semantics).toMatchObject({
        scope: "main_content_only",
        immutable_guard_sha256: mainContentHash,
        legacy_main_content_sha256: mainContentHash,
        prospective_main_content_sha256: mainContentHash,
      });
      expect(decision.evidence.acquisition_semantics.legacy_full_browser_text_sha256)
        .not.toBe(mainContentHash);
    }
  });

  it("does not apply to another source or promote a generic compatibility rule", () => {
    const input = validBridgeInput("layout");
    input.sourceId = "11111111-1111-4111-8111-111111111111";
    expect(evaluateStage1BeineckeFaqLegacyGeometryBridge(input)).toEqual({
      applies: false,
      accepted: false,
      reason: "source_not_allowlisted",
      evidence: null,
    });
  });

  const adversarialCases = [
    ["source whitespace is not fuzzy-matched", (input) => { input.sourceId = ` ${sourceId}`; }],
    ["role whitespace is not fuzzy-matched", (input) => { input.artifactSlot = "layout "; }],
    ["unsupported role", (input) => { input.artifactSlot = "expansion_state_05_layout"; }],
    ["reviewed final URL", (input) => { input.reviewedFinalUrl += "/other"; }],
    ["reviewed page type", (input) => { input.reviewedSourcePageType = "eligibility"; }],
    ["reviewed source role", (input) => { input.reviewedSourceRoles = ["eligibility"]; }],
    ["legacy capture timestamp", (input) => { input.existingCapturedAt = "2026-08-03T18:44:41.263Z"; }],
    ["immutable guard hash", (input) => { input.immutableGuardMainContentHash = "0".repeat(64); }],
    ["legacy main-content hash", (input) => { input.existingCaptureIdentity.main_content_hash = "0".repeat(64); }],
    ["prospective main-content hash", (input) => { input.prospectiveMainContentHash = "0".repeat(64); }],
    ["full browser text hash", (input) => { input.existingCaptureIdentity.text_hash = "0".repeat(64); }],
    ["browser chrome hash", (input) => { input.existingCaptureIdentity.nav_header_footer_hash = "0".repeat(64); }],
    ["expansion text hash", (input) => { input.existingCaptureIdentity.expansion_hash = "0".repeat(64); }],
    ["sealed R2 receipt", (input) => { input.authoritativeR2Binding.receipt_sha256 = "0".repeat(64); }],
    ["immutable R2 generation", (input) => {
      input.authoritativeR2Binding.pointer_identity.immutable_generation = "0".repeat(32);
    }],
    ["R2 layout role", (input) => {
      input.authoritativeR2Binding.verified_roles.find((role) => role.role === "layout").role = "layout2";
    }],
    ["current verifier ordering", (input) => { input.currentGeometryVerification.ran_first = false; }],
    ["current verifier result", (input) => { input.currentGeometryVerification.layout_ready = true; }],
    ["artifact role", (input) => { input.artifact.name = "meta"; }],
    ["artifact generation path", (input) => {
      input.artifact.path = input.artifact.path.replace("2026-08-03T18-44-41-262Z", "other");
    }],
    ["layout body bytes", (input) => {
      input.artifact.body = Buffer.concat([input.artifact.body, Buffer.from("\n")]);
    }],
    ["layout body binding", (input) => { input.artifact.binding.sha256 = "0".repeat(64); }],
    ["geometry hash", (input) => { input.layout.geometry_hash = "0".repeat(64); }],
    ["capture geometry hash", (input) => { input.captureGeometry.geometry_hash = "0".repeat(64); }],
    ["metadata geometry hash", (input) => { input.metadataGeometry.geometry_hash = "0".repeat(64); }],
    ["image hash", (input) => { input.expectedImageHash = "0".repeat(64); }],
    ["stored before proof", (input) => {
      input.layout.capture_verification.before_fingerprint = "0".repeat(64);
    }],
    ["stored after proof", (input) => {
      input.layout.capture_verification.after_fingerprint = "0".repeat(64);
    }],
    ["before/after proof equality", (input) => {
      input.layout.capture_verification.after_fingerprint = "1".repeat(64);
    }],
    ["screenshot alignment", (input) => { input.layout.screenshot.alignment_status = "claimed"; }],
    ["screenshot dimensions", (input) => { input.layout.screenshot.pixel_width += 1; }],
    ["document dimensions", (input) => { input.layout.document.height += 1; }],
    ["paint verification", (input) => { input.layout.paint_stack.status = "claimed"; }],
    ["paint sampled counts", (input) => { input.layout.paint_stack.sampled_rect_count += 1; }],
    ["node count", (input) => { input.layout.node_count += 1; }],
    ["run count", (input) => { input.layout.run_count += 1; }],
    ["rect preimage", (input) => { input.layout.nodes[0].runs[0].rects[0].width += 0.01; }],
    ["metadata projection", (input) => { input.metadataGeometry.status = "verified"; }],
  ];

  it.each(adversarialCases)("fails closed for any %s mismatch", (_label, mutate) => {
    const input = validBridgeInput("layout");
    mutate(input);
    expect(evaluateStage1BeineckeFaqLegacyGeometryBridge(input)).toMatchObject({
      accepted: false,
    });
  });

  it("wires the sealed R2 receipt into only the Stage 1 canary validator", () => {
    const captureScript = readFileSync(
      new URL("../capture-visual-snapshots.mjs", import.meta.url),
      "utf8",
    );
    const validationModule = readFileSync(
      new URL("./stage1-evidence-schema-upgrade-validation.mjs", import.meta.url),
      "utf8",
    );
    expect(captureScript).toContain(
      "authoritativeExistingR2Binding: state.r2BindingReceipt",
    );
    expect(validationModule).toContain(
      "evaluateStage1BeineckeFaqLegacyGeometryBridge",
    );
    expect(validationModule).toContain(
      "authoritativeR2Binding: authoritativeExistingR2Binding",
    );
    expect(validationModule).toContain("ran_first: true");
  });
});

describe("reviewed Beinecke FAQ main-content acquisition-scope bridge", () => {
  it("accepts the exact sealed source, generation, acquisition, and semantic tuple", () => {
    const decision = evaluateStage1BeineckeFaqLegacyMainContentBridge(
      validMainContentBridgeInput(),
    );

    expect(decision).toMatchObject({
      applies: true,
      accepted: true,
      reason: "exact_source_bound_main_content_acquisition_scope_verified",
      evidence: {
        schema: STAGE1_BEINECKE_FAQ_LEGACY_MAIN_CONTENT_BRIDGE_SCHEMA,
        source_id: sourceId,
        immutable_generation: "f9e4d3ca743b366c1e4d2897a4822c45",
        comparison_scope: "main_content_only",
        immutable_acquisition_normalized_text_sha256: mainContentHash,
        legacy_main_content_sha256: mainContentHash,
        prospective_main_content_sha256: mainContentHash,
        geometry_authority: "generic_current_geometry_verifier",
      },
    });
    expect(decision.evidence.legacy_full_browser_normalized_text_sha256)
      .not.toBe(mainContentHash);
    expect(decision.evidence.limitations).toEqual(expect.arrayContaining([
      "acquisition_semantics_bound_to_main_content_hash_not_full_browser_text_hash",
      "full_browser_text_includes_navigation_chrome_and_expanded_section_states",
      "full_browser_text_mismatch_is_preserved_and_explicit_not_treated_as_equality",
      "compatibility_evidence_is_not_generic_semantic_geometry_or_promotion_authority",
    ]));
  });

  it("accepts only a complete exact set when pre-1fc005c geometry evidence is present", () => {
    const input = validMainContentBridgeInput();
    input.legacyGeometryBridges = Object.keys(roleDefinitions).map((role) => {
      const decision = evaluateStage1BeineckeFaqLegacyGeometryBridge(validBridgeInput(role));
      expect(decision.accepted).toBe(true);
      return decision.evidence;
    });
    input.currentGeometryVerifiedRoles = [];
    expect(evaluateStage1BeineckeFaqLegacyMainContentBridge(input)).toMatchObject({
      accepted: true,
      evidence: {
        geometry_authority: "exact_source_bound_pre_1fc005c_geometry_bridges",
        legacy_geometry_bridge_roles: Object.keys(roleDefinitions).sort(),
      },
    });

    input.legacyGeometryBridges.pop();
    expect(evaluateStage1BeineckeFaqLegacyMainContentBridge(input)).toMatchObject({
      accepted: false,
      reason: "legacy_geometry_bridge_set_incomplete",
    });
  });

  const semanticMismatchCases = [
    ["source whitespace", (input) => { input.sourceId = ` ${sourceId}`; }],
    ["exact source whitespace", (input) => { input.exactSourceId = ` ${sourceId}`; }],
    ["kind", (input) => { input.kind = "pdf"; }],
    ["reviewed final URL", (input) => { input.reviewedFinalUrl += "/other"; }],
    ["sealed final URL", (input) => { input.sealedAcquisition.final_url_exact += "/other"; }],
    ["page type", (input) => { input.sealedAcquisition.page_type_exact = "eligibility"; }],
    ["page type whitespace", (input) => { input.sealedAcquisition.page_type_exact = " faq "; }],
    ["reviewed role", (input) => { input.sealedAcquisition.reviewed_roles_exact = ["eligibility"]; }],
    ["reviewed role whitespace", (input) => { input.sealedAcquisition.reviewed_roles_exact = [" faq "]; }],
    ["acquisition file hash", (input) => { input.sealedAcquisition.file_hash_exact = "0".repeat(64); }],
    ["acquisition text hash", (input) => { input.sealedAcquisition.normalized_text_hash_exact = "0".repeat(64); }],
    ["acquisition id", (input) => { input.sealedAcquisition.source_acquisition_id_exact = "0".repeat(36); }],
    ["request id", (input) => { input.sealedAcquisition.request_id_exact = "0".repeat(36); }],
    ["guard hash", (input) => { input.activationGuardSha256 = "0".repeat(64); }],
    ["legacy timestamp", (input) => { input.existingCaptureIdentity.captured_at = "2026-08-03T18:44:41.263Z"; }],
    ["legacy source", (input) => { input.existingCaptureIdentity.source.id = "0".repeat(36); }],
    ["legacy final URL", (input) => { input.existingCaptureIdentity.final_url += "other"; }],
    ["legacy full text hash", (input) => { input.existingCaptureIdentity.text_hash = "0".repeat(64); }],
    ["legacy full text length", (input) => { input.existingCaptureIdentity.text_length += 1; }],
    ["legacy main hash", (input) => { input.existingCaptureIdentity.main_content_hash = "0".repeat(64); }],
    ["legacy chrome hash", (input) => { input.existingCaptureIdentity.nav_header_footer_hash = "0".repeat(64); }],
    ["legacy expansion hash", (input) => { input.existingCaptureIdentity.expansion_hash = "0".repeat(64); }],
    ["legacy normalized full text", (input) => { input.existingNormalizedTextHash = "0".repeat(64); }],
    ["prospective main hash", (input) => { input.prospectiveMainContentHash = "0".repeat(64); }],
    ["prospective main length", (input) => { input.prospectiveMainContentTextLength += 1; }],
    ["prospective source", (input) => { input.prospectiveSourceId = ` ${sourceId}`; }],
    ["prospective final URL", (input) => { input.prospectiveFinalUrl += "other"; }],
    ["R2 receipt", (input) => { input.authoritativeR2Binding.receipt_sha256 = "0".repeat(64); }],
    ["R2 generation", (input) => {
      input.authoritativeR2Binding.pointer_identity.immutable_generation = "0".repeat(32);
    }],
    ["activation source", (input) => { input.existingBaselineActivation.shared_award_source_id = "0".repeat(36); }],
    ["activation acquisition", (input) => { input.existingBaselineActivation.source_acquisition_id = "0".repeat(36); }],
    ["activation request", (input) => { input.existingBaselineActivation.source_page_request_id = "0".repeat(36); }],
    ["activation expected hash", (input) => {
      input.existingBaselineActivation.expected_normalized_text_sha256 = "0".repeat(64);
    }],
    ["activation quote proof", (input) => {
      input.existingBaselineActivation.visual_evidence_quotes_verified = false;
    }],
    ["unavailable generic geometry", (input) => {
      input.existingArtifactLimitations = ["main_layout_explicitly_unavailable"];
    }],
    ["incomplete generic geometry role set", (input) => {
      input.currentGeometryVerifiedRoles.pop();
    }],
  ];

  it.each(semanticMismatchCases)("fails closed for any %s mismatch", (_label, mutate) => {
    const input = validMainContentBridgeInput();
    mutate(input);
    expect(evaluateStage1BeineckeFaqLegacyMainContentBridge(input)).toMatchObject({
      accepted: false,
    });
  });

  it("does not apply to another source", () => {
    const input = validMainContentBridgeInput();
    input.sourceId = "11111111-1111-4111-8111-111111111111";
    expect(evaluateStage1BeineckeFaqLegacyMainContentBridge(input)).toEqual({
      applies: false,
      accepted: false,
      reason: "source_not_allowlisted",
      evidence: null,
    });
  });
});

function validBridgeInput(role) {
  const definition = roleDefinitions[role];
  const body = beineckeFaqLegacyFixtureBody(role);
  const layout = beineckeFaqLegacyFixtureJson(role);
  const metadata = beineckeFaqLegacyFixtureJson("meta");
  const metadataGeometry = definition.metadataIndex === null
    ? metadata.text_geometry
    : metadata.expansion_state_screenshots[definition.metadataIndex].text_geometry;
  return {
    sourceId,
    kind: "webpage",
    reviewedFinalUrl: "https://beineckescholarship.org/beinecke-scholarship/scholar-faqs",
    reviewedSourcePageType: "faq",
    reviewedSourceRoles: ["faq"],
    existingCapturedAt: capturedAt,
    immutableGuardMainContentHash: mainContentHash,
    prospectiveMainContentHash: mainContentHash,
    existingCaptureIdentity: metadata,
    authoritativeR2Binding: beineckeFaqLegacyFixtureJson("r2_binding_receipt"),
    artifactSlot: role,
    artifact: {
      name: role,
      fileName: definition.fileName,
      path:
        `D:/AwardPingVisualSnapshots/sources/${sourceId}/captures/` +
        `2026-08-03T18-44-41-262Z/${definition.fileName}`,
      contentType,
      body,
      binding: {
        sha256: sha256(body),
        byte_length: body.length,
        content_type: contentType,
        hash_mode: "raw_sha256",
      },
    },
    layout,
    captureGeometry: structuredClone(layout),
    metadataGeometry: structuredClone(metadataGeometry),
    expectedImageHash: layout.screenshot.image_hash,
    expectedLayoutHash: layout.geometry_hash,
    metadataLayoutHash: metadataGeometry.geometry_hash,
    currentGeometryVerification: {
      ran_first: true,
      layout_ready: false,
      capture_ready: false,
    },
  };
}

function validMainContentBridgeInput() {
  return {
    sourceId,
    kind: "webpage",
    reviewedFinalUrl: "https://beineckescholarship.org/beinecke-scholarship/scholar-faqs",
    sealedAcquisition: {
      file_hash: "6ee5b5322ed5f5563063d919e552839d434bf08456d8176fbfda9404e015e7e2",
      file_hash_exact: "6ee5b5322ed5f5563063d919e552839d434bf08456d8176fbfda9404e015e7e2",
      normalized_text_hash: mainContentHash,
      normalized_text_hash_exact: mainContentHash,
      final_url: "https://beineckescholarship.org/beinecke-scholarship/scholar-faqs",
      final_url_exact: "https://beineckescholarship.org/beinecke-scholarship/scholar-faqs",
      page_type_exact: "faq",
      reviewed_roles_exact: ["faq"],
      source_acquisition_id: "42e72340-c3b8-5ca2-8913-aed7f7c56be5",
      source_acquisition_id_exact: "42e72340-c3b8-5ca2-8913-aed7f7c56be5",
      request_id: "cc190ad2-8240-5b8c-b5ac-a73180094d24",
      request_id_exact: "cc190ad2-8240-5b8c-b5ac-a73180094d24",
    },
    activationGuardSha256:
      "6f0d052effa393a460bd5b91d5051a8d23dfbb7272073c150ad0903f5e66eadb",
    existingBaselineActivation: {
      shared_award_source_id: sourceId,
      source_acquisition_id: "42e72340-c3b8-5ca2-8913-aed7f7c56be5",
      source_page_request_id: "cc190ad2-8240-5b8c-b5ac-a73180094d24",
      expected_normalized_text_sha256: mainContentHash,
      observed_normalized_text_sha256: mainContentHash,
      guard_sha256: "6f0d052effa393a460bd5b91d5051a8d23dfbb7272073c150ad0903f5e66eadb",
      reviewed_final_url: "https://beineckescholarship.org/beinecke-scholarship/scholar-faqs",
      observed_final_url: "https://beineckescholarship.org/beinecke-scholarship/scholar-faqs/",
      visual_evidence_quotes_verified: true,
      retained_evidence_quotes_verified: true,
    },
    existingCaptureIdentity: beineckeFaqLegacyFixtureJson("meta"),
    existingNormalizedTextHash:
      "cc400ba8cb0b7e5b96a148d119d549a1d2a0b71dea4cc9a0a852419e9374e9ce",
    prospectiveMainContentHash: mainContentHash,
    prospectiveMainContentTextLength: 2224,
    prospectiveSourceId: sourceId,
    prospectiveFinalUrl:
      "https://beineckescholarship.org/beinecke-scholarship/scholar-faqs/",
    authoritativeR2Binding: beineckeFaqLegacyFixtureJson("r2_binding_receipt"),
    legacyGeometryBridges: [],
    currentGeometryVerifiedRoles: Object.keys(roleDefinitions).sort(),
    existingArtifactLimitations: [],
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
