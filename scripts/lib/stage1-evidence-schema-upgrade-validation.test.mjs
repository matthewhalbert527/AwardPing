import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  conservativeExpansionStateCaptureCoverage,
  expansionStateCaptureCoverage,
} from "./expansion-state-descriptor-canonicalization.mjs";
import {
  STAGE1_BASELINE_ACTIVATION_BATCH_ID,
  normalizeStage1BaselineEvidenceWords,
  stage1BaselineActivationGuardSha256,
  stage1BaselineActivationTextSha256,
} from "./stage1-baseline-activation-guard.mjs";
import {
  prepareR2CaptureArtifacts,
  retainedCaptureArtifactProjectionSchema,
} from "./r2-capture-artifact-bindings.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS,
  evaluateStage1EvidenceSchemaUpgradeCapture,
} from "./stage1-evidence-schema-upgrade-validation.mjs";
import {
  bindVisualTextGeometry,
  visualTextGeometryLayoutFingerprint,
} from "./visual-event-localization.mjs";
import {
  beineckeFaqLegacyFixtureBody,
  beineckeFaqLegacyFixtureJson,
} from "./fixtures/beinecke-faq-legacy-geometry-fixture.mjs";
import {
  STAGE1_PRE_1FC005C_LEGACY_GEOMETRY_SOURCE_IDS,
} from "./stage1-evidence-schema-upgrade-pre-1fc005c-legacy-geometry.mjs";

const sourceId = "11111111-1111-4111-8111-111111111111";
const acquisitionId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const finalUrl = "https://example.org/award/eligibility";
const reviewedQuote = "Applicants must be enrolled full time.";
const reviewedText = `Award eligibility\n${reviewedQuote}`;
const existingAt = "2026-08-14T18:00:00.000Z";
const captureAt = "2026-08-14T18:05:00.000Z";
const exactSixArchiveRoot = "D:/AwardPingVisualSnapshots";
const exactSixReportPath = new URL(
  "../../reports/visual-snapshot-run-2026-08-15T05-35-20-918Z-shard-1-e72368f4.json",
  import.meta.url,
);
const exactSixRetainedDefinitions = Object.freeze([
  Object.freeze({
    sourceId: "c30778fe-43d7-57be-842a-e046d84baaee",
    captureDirectory: "2026-08-03T18-37-29-113Z",
  }),
  Object.freeze({
    sourceId: "af1367b5-0cb0-5b21-8e78-7dc195dd996f",
    captureDirectory: "2026-08-03T18-38-42-518Z",
  }),
  Object.freeze({
    sourceId: "5ec9a453-fd62-53e5-b885-726b21ce7247",
    captureDirectory: "2026-08-03T18-50-08-220Z",
  }),
  Object.freeze({
    sourceId: "fa4088a7-706e-4ad3-ae12-3653751dd5e1",
    captureDirectory: "2026-08-03T18-50-42-281Z",
  }),
  Object.freeze({
    sourceId: "664d38ba-c717-5d51-b7ce-9e3a27f41fec",
    captureDirectory: "2026-08-03T18-51-38-842Z",
  }),
  Object.freeze({
    sourceId: "c28878c0-6a8b-5fa8-b99b-ec826b86d8f2",
    captureDirectory: "2026-08-03T18-52-22-287Z",
  }),
]);
const exactSixRetainedFixtureAvailable = existsSync(exactSixReportPath)
  && exactSixRetainedDefinitions.every(exactSixFixtureExists);
const exactSixReport = exactSixRetainedFixtureAvailable
  ? JSON.parse(readFileSync(exactSixReportPath, "utf8"))
  : null;

describe("Stage 1 evidence-schema upgrade validation", () => {
  it("allows a zero-charge unchanged webpage upgrade from explicit legacy limitations", () => {
    const fixture = validWebFixture({ candidateExpansionCount: 1 });
    const decision = evaluateStage1EvidenceSchemaUpgradeCapture(fixture);

    expect(decision).toMatchObject({
      decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.ELIGIBLE_UNCHANGED_UPGRADE,
      creates_api_charge: false,
      outcome: {
        would_commit: true,
        would_queue_visual_candidate: false,
        would_quarantine: false,
        creates_api_charge: false,
      },
    });
    expect(decision.evidence.existing.legacy_limitations).toEqual(expect.arrayContaining([
      "raw_expansion_state_count_missing",
      "raw_metadata_retained_projection_missing",
      "baseline_retained_projection_missing",
      "expansion_coverage_incomplete_discovery",
    ]));
    expect(decision.evidence.capture).toMatchObject({
      expansion_coverage_status: "verified_complete",
      retained_expansion_state_count: 1,
      raw_metadata_verified: true,
      legacy_limitations: [],
    });
    expect(decision.evidence.comparison.primary_visual_identity).toMatchObject({
      matches: true,
      equivalence_basis: "exact_hash",
    });
  });

  it("allows explicitly unavailable Fulbright-style legacy geometry as a repair limitation", () => {
    const fixture = validWebFixture({ existingLayoutUnavailable: true });
    const unavailableProjection = {
      schema: retainedCaptureArtifactProjectionSchema,
      kind: "webpage",
      localization_status: "evidence_only_geometry_unavailable",
      authoritative: {
        layout_retained: false,
        layout_hash: null,
        expansion_state_count: 0,
      },
    };
    fixture.existingCapture.retained_artifact_projection = unavailableProjection;
    fixture.existingBaseline.summary_metadata.retained_artifact_projection = unavailableProjection;
    fixture.existingPreparedArtifacts = mutatePreparedArtifact(
      fixture.existingPreparedArtifacts,
      "meta",
      (body) => {
        const metadata = JSON.parse(body.toString("utf8"));
        metadata.retained_artifact_projection = unavailableProjection;
        return Buffer.from(JSON.stringify(metadata));
      },
    );
    const decision = evaluateStage1EvidenceSchemaUpgradeCapture(fixture);

    expect(decision.decision).toBe(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.ELIGIBLE_UNCHANGED_UPGRADE,
    );
    expect(decision.evidence.existing.legacy_limitations).toContain(
      "main_layout_explicitly_unavailable",
    );
    expect(decision.evidence.capture.legacy_limitations).toEqual([]);
  });

  it("treats stable current wording and reviewed-quote removal as material", () => {
    const changedText = "Award eligibility\nApplicants must be enrolled part time.";
    const fixture = validWebFixture({
      candidateText: changedText,
      candidatePage: Buffer.from("changed page image"),
      intakeText: changedText,
    });
    const decision = evaluateStage1EvidenceSchemaUpgradeCapture(fixture);

    expect(decision.decision).toBe(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.MATERIAL_DIFFERENCE_CANDIDATE,
    );
    expect(decision.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      "material_text_hash_changed",
      "material_primary_image_changed",
      "material_intake_text_changed_from_acquisition",
      "material_reviewed_quotes_removed",
    ]));
    expect(decision.outcome).toMatchObject({
      would_commit: false,
      would_queue_visual_candidate: true,
      would_quarantine: false,
      creates_api_charge: false,
    });
    expect(decision.evidence.intake).toMatchObject({
      matches_immutable_acquisition: false,
      capture_matches_stable_intake: true,
      evidence_quotes_verified: false,
    });
  });

  it("never absorbs an unexplained visual-only webpage change", () => {
    const fixture = validWebFixture({ candidatePage: Buffer.from("visual-only change") });
    const decision = evaluateStage1EvidenceSchemaUpgradeCapture(fixture);

    expect(decision.decision).toBe(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.MATERIAL_DIFFERENCE_CANDIDATE,
    );
    expect(decision.reasons.map((reason) => reason.code)).toContain(
      "material_primary_image_changed",
    );
  });

  it("quarantines unstable pre/post intake instead of claiming a change", () => {
    const fixture = validWebFixture();
    fixture.postIntake = intake("Award eligibility changed during capture");
    const decision = evaluateStage1EvidenceSchemaUpgradeCapture(fixture);

    expect(decision).toMatchObject({
      decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
      reason: "web_intake_not_stable",
      creates_api_charge: false,
      outcome: { would_quarantine: true, would_queue_visual_candidate: false },
    });
  });

  it("quarantines stable changed intake when the prospective visual capture still shows old text", () => {
    const fixture = validWebFixture({
      candidateText: reviewedText,
      intakeText: [
        "Award eligibility revised",
        reviewedQuote,
        "Additional current guidance.",
      ].join("\n"),
    });
    const decision = evaluateStage1EvidenceSchemaUpgradeCapture(fixture);

    expect(decision).toMatchObject({
      decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
      reason: "web_intake_capture_text_mismatch",
      creates_api_charge: false,
      outcome: { would_quarantine: true, would_queue_visual_candidate: false },
    });
  });

  it("accepts the exact Beinecke FAQ main-content bridge through the public evaluator", () => {
    const fixture = validBeineckeFaqSemanticBridgeFixture();
    const decision = evaluateStage1EvidenceSchemaUpgradeCapture(fixture);

    expect(decision).toMatchObject({
      decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.ELIGIBLE_UNCHANGED_UPGRADE,
      creates_api_charge: false,
      evidence: {
        intake: {
          pre_normalized_text_hash:
            "4cbc91149287266cd6c0a1a4156d05a1c74bc393be29ca73369aa613b6f49c27",
          post_normalized_text_hash:
            "4cbc91149287266cd6c0a1a4156d05a1c74bc393be29ca73369aa613b6f49c27",
          capture_matches_stable_intake: false,
          capture_matches_stable_intake_basis:
            "exact_source_bound_main_content_hash_bridge",
          capture_main_content_matches_stable_intake: true,
          evidence_quotes_verified: true,
          semantic_scope_bridge: {
            schema: "awardping.stage1.beinecke-faq-legacy-main-content-bridge.v1",
            source_id: "2ea41875-5c88-5794-81b3-afa8ddaf31c1",
            immutable_generation: "f9e4d3ca743b366c1e4d2897a4822c45",
            comparison_scope: "main_content_only",
            geometry_authority: "generic_current_geometry_verifier",
            current_geometry_verified_roles: [
              "expansion_state_01_layout",
              "expansion_state_02_layout",
              "expansion_state_03_layout",
              "expansion_state_04_layout",
              "layout",
            ],
          },
        },
        comparison: {
          semantic_fields: {
            main_content_hash: { matches: true },
          },
          primary_visual_identity: {
            matches: true,
            equivalence_basis: "exact_hash",
          },
        },
      },
      outcome: {
        would_commit: true,
        would_queue_visual_candidate: false,
        would_quarantine: false,
      },
    });
    expect(decision.evidence.intake.capture_normalized_text_hash)
      .not.toBe(decision.evidence.intake.pre_normalized_text_hash);
    expect(decision.evidence.intake.limitations).toContain(
      "full_browser_text_mismatch_is_preserved_and_explicit_not_treated_as_equality",
    );
  });

  it("quarantines stable drifted intake even when the prospective Beinecke main hash is old", () => {
    const fixture = validBeineckeFaqSemanticBridgeFixture();
    const changedIntake = `${beineckeReviewedIntakeText()}\nUnexpected changed intake wording.`;
    fixture.preIntake = beineckeIntake(changedIntake);
    fixture.postIntake = beineckeIntake(changedIntake);

    expect(evaluateStage1EvidenceSchemaUpgradeCapture(fixture)).toMatchObject({
      decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
      reason: "web_intake_capture_text_mismatch",
      outcome: {
        would_commit: false,
        would_queue_visual_candidate: false,
        would_quarantine: true,
      },
    });
  });

  it("quarantines incomplete prospective expansion discovery", () => {
    const fixture = validWebFixture({ candidateCoverageComplete: false });
    const decision = evaluateStage1EvidenceSchemaUpgradeCapture(fixture);

    expect(decision.decision).toBe(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
    );
    expect(decision.reason).toBe("capture_expansion_coverage_incomplete");
  });

  it("quarantines stale geometry, URL drift, and sibling generation paths", () => {
    const geometry = validWebFixture();
    geometry.capturePreparedArtifacts = mutatePreparedArtifact(
      geometry.capturePreparedArtifacts,
      "layout",
      (body) => {
        const value = JSON.parse(body.toString("utf8"));
        value.nodes[0].text = "tampered without recomputing geometry";
        return Buffer.from(JSON.stringify(value));
      },
    );
    expect(evaluateStage1EvidenceSchemaUpgradeCapture(geometry)).toMatchObject({
      decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
      reason: "capture_retained_artifact_identity_invalid",
    });

    const urlDrift = validWebFixture();
    urlDrift.postIntake = { ...urlDrift.postIntake, canonical_url: "https://example.org/sibling" };
    expect(evaluateStage1EvidenceSchemaUpgradeCapture(urlDrift)).toMatchObject({
      decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
      reason: "post_intake_url_drift",
    });

    const sibling = validWebFixture();
    sibling.capture = {
      ...sibling.capture,
      page_path: sibling.capture.page_path.replace(
        generation(captureAt),
        generation("2026-08-14T18:06:00.000Z"),
      ),
    };
    expect(evaluateStage1EvidenceSchemaUpgradeCapture(sibling)).toMatchObject({
      decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
      reason: "capture_page_path_binding_invalid",
    });
  });

  it("rejects locally tampered text even if baseline, metadata, and hashes were resealed", () => {
    const fixture = validWebFixture();
    const tampered = webCapture({
      capturedAt: existingAt,
      text: "Award eligibility\nApplicants must be enrolled part time.",
      page: Buffer.from("stable page image"),
      layoutX: 1,
      modern: false,
      expansionCount: 0,
    });
    fixture.existingCapture = { ...tampered.capture, text: `${tampered.capture.text}\n` };
    fixture.existingPreparedArtifacts = tampered.prepared;
    fixture.existingBaseline = baselineFor(tampered.capture, fixture.immutableAcquisition.acquisition);

    const decision = evaluateStage1EvidenceSchemaUpgradeCapture(fixture);
    expect(decision).toMatchObject({
      decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
      reason: "existing_baseline_normalized_text_disagrees_with_acquisition",
    });
  });

  it("does not waive a current-fingerprint mismatch for a sibling source", () => {
    const fixture = validWebFixture();
    const staleGeometry = structuredClone(fixture.existingCapture.text_geometry);
    staleGeometry.capture_verification.before_fingerprint = "0".repeat(64);
    staleGeometry.capture_verification.after_fingerprint = "0".repeat(64);
    fixture.existingCapture.text_geometry = staleGeometry;
    fixture.existingPreparedArtifacts = mutatePreparedArtifact(
      fixture.existingPreparedArtifacts,
      "layout",
      () => Buffer.from(JSON.stringify(staleGeometry)),
    );

    expect(evaluateStage1EvidenceSchemaUpgradeCapture(fixture)).toMatchObject({
      decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
      reason: "existing_legacy_geometry_binding_invalid",
    });
  });

  it("requires exact PDF acquisition hashes and classifies a new PDF as material", () => {
    const unchanged = validPdfFixture();
    expect(evaluateStage1EvidenceSchemaUpgradeCapture(unchanged)).toMatchObject({
      decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.ELIGIBLE_UNCHANGED_UPGRADE,
      creates_api_charge: false,
      outcome: { would_commit: true },
    });

    const changed = validPdfFixture({ candidatePdf: Buffer.from("new official PDF bytes") });
    const changedDecision = evaluateStage1EvidenceSchemaUpgradeCapture(changed);
    expect(changedDecision.decision).toBe(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.MATERIAL_DIFFERENCE_CANDIDATE,
    );
    expect(changedDecision.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      "material_pdf_identity_changed_from_acquisition",
      "material_pdf_file_changed",
    ]));

    const missingTextIdentity = validPdfFixture();
    delete missingTextIdentity.immutableAcquisition.identity.text_hash;
    expect(evaluateStage1EvidenceSchemaUpgradeCapture(missingTextIdentity)).toMatchObject({
      decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
      reason: "immutable_acquisition_pdf_text_hash_missing",
    });
  });
});

describe.runIf(exactSixRetainedFixtureAvailable)(
  "exact-six historical geometry bridge through the Stage 1 evaluator",
  () => {
    it("waives only the exact historical layout fingerprint mismatch for all six tuples", () => {
      expect(exactSixRetainedDefinitions.map((definition) => definition.sourceId)).toEqual(
        STAGE1_PRE_1FC005C_LEGACY_GEOMETRY_SOURCE_IDS,
      );
      for (const definition of exactSixRetainedDefinitions) {
        const fixture = exactSixRetainedValidationFixture(definition);
        const decision = evaluateStage1EvidenceSchemaUpgradeCapture(fixture);
        expect(decision).toMatchObject({
          decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
          // These historical tuples' texts differ only by extraction-path
          // case-fusion whitespace, which the evidence-word normalizer now
          // treats as equal (2026-08-31 case-fused-token split), so the
          // deeper capture-identity check fires instead. Either reason ends
          // in the same fail-closed quarantine.
          reason: "existing_baseline_capture_identity_mismatch",
          outcome: {
            would_commit: false,
            would_queue_visual_candidate: false,
            would_quarantine: true,
          },
        });
        expect(decision.reason).not.toBe("existing_legacy_geometry_binding_invalid");
      }
    });

    it("refuses non-historical geometry drift inside an otherwise exact tuple", () => {
      const fixture = exactSixRetainedValidationFixture(exactSixRetainedDefinitions[0]);
      fixture.existingPreparedArtifacts = mutatePreparedArtifact(
        fixture.existingPreparedArtifacts,
        "layout",
        (body) => {
          const layout = JSON.parse(body.toString("utf8"));
          layout.capture_verification.after_fingerprint = "0".repeat(64);
          return Buffer.from(JSON.stringify(layout));
        },
      );

      expect(evaluateStage1EvidenceSchemaUpgradeCapture(fixture)).toMatchObject({
        decision: STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
        reason: "existing_legacy_geometry_bridge_invalid",
      });
    });
  },
);

function exactSixFixtureExists(definition) {
  try {
    const paths = exactSixFixturePaths(definition);
    if (!Object.values(paths).every(existsSync)) return false;
    const baseline = JSON.parse(readFileSync(paths.baseline, "utf8"));
    return existsSync(exactSixIntakeTextPath(
      baseline.summary_metadata.stage1_baseline_activation,
    ));
  } catch {
    return false;
  }
}

function exactSixRetainedValidationFixture(definition) {
  const paths = exactSixFixturePaths(definition);
  const baseline = JSON.parse(readFileSync(paths.baseline, "utf8"));
  const metadataBody = readFileSync(paths.meta);
  const metadata = JSON.parse(metadataBody.toString("utf8"));
  const layoutBody = readFileSync(paths.layout);
  const layout = JSON.parse(layoutBody.toString("utf8"));
  const textBody = readFileSync(paths.text);
  const browserText = withoutWriterNewline(textBody.toString("utf8"));
  const intakeText = withoutWriterNewline(readFileSync(
    exactSixIntakeTextPath(baseline.summary_metadata.stage1_baseline_activation),
    "utf8",
  ));
  const reviewed = exactSixReviewedAcquisition({
    baseline,
    metadata,
    intakeText,
    browserText,
  });
  const captureRoot = exactSixCaptureRoot(definition);
  const existingCapture = {
    ...metadata,
    text: browserText,
    dir: captureRoot,
    page_path: paths.page,
    thumb_path: paths.thumb,
    text_path: paths.text,
    expansion_text_path: null,
    sections_text_path: null,
    sections_json_path: `${captureRoot}/sections.json`,
    layout_path: paths.layout,
    text_geometry: layout,
    meta_path: paths.meta,
  };
  const reportResult = exactSixReport.stage1_evidence_schema_upgrade.results
    .find((result) => result.source_id === definition.sourceId);
  return {
    sourceId: definition.sourceId,
    sourceKind: "webpage",
    reviewedFinalUrl: reviewed.finalUrl,
    reviewedEvidenceQuotes: [reviewed.evidenceQuote],
    immutableAcquisition: {
      acquisition: reviewed.acquisition,
      identity: { file_hash: reviewed.fileHash },
    },
    existingBaseline: baseline,
    existingCapture,
    existingPreparedArtifacts: prepareFromDefinitions({
      layout: ["layout.json", "application/json; charset=utf-8", layoutBody, paths.layout],
      meta: ["meta.json", "application/json; charset=utf-8", metadataBody, paths.meta],
      page: ["page.jpg", "image/jpeg", readFileSync(paths.page), paths.page],
      text: ["text.txt", "text/plain; charset=utf-8", textBody, paths.text],
      thumb: ["thumb.jpg", "image/jpeg", readFileSync(paths.thumb), paths.thumb],
    }),
    authoritativeExistingR2Binding: structuredClone(
      reportResult.capture_validation.evidence.authoritative_existing_r2_binding,
    ),
    capture: { main_content_hash: null },
    capturePreparedArtifacts: null,
  };
}

function exactSixReviewedAcquisition({ baseline, metadata, intakeText, browserText }) {
  const activation = baseline.summary_metadata.stage1_baseline_activation;
  const evidenceQuote = exactCommonEvidenceQuote(intakeText, browserText);
  const guard = {
    mode: "first_visual_baseline_exact_normalized_retained_text",
    onboarding_batch_id: STAGE1_BASELINE_ACTIVATION_BATCH_ID,
    notification_mode: "baseline_only",
    source_page_request_id: activation.source_page_request_id,
    shared_award_source_id: activation.shared_award_source_id,
    shared_award_source_acquisition_id: activation.source_acquisition_id,
    evidence_packet_sha256: activation.evidence_packet_sha256,
    decision_item_sha256: activation.decision_item_sha256,
    normalized_retained_text_sha256: activation.expected_normalized_text_sha256,
    retained_text_artifact: structuredClone(activation.retained_text_artifact),
    capture_file_sha256: activation.capture_file_sha256,
    final_url: activation.reviewed_final_url,
  };
  const disposition = {
    schema_version: "awardping.stage1.baseline-source-human-disposition.v1",
    policy_version: "stage1-baseline-source-disposition-v1",
    decision: "approve_baseline_only",
    effective_source_review: {
      status: "accepted",
      source_relevance: "primary",
      cycle_relevance: "evergreen",
      officialness: "official",
      confidence: "high",
      page_type: metadata.source?.page_type || "other",
      evidence_quotes: [evidenceQuote],
      exact_evidence_verified: true,
      reviewed_roles: ["identity_home"],
      facts: {
        description: null,
        deadline: null,
        amount: null,
        eligibility: [],
        application_materials: [],
        important_dates: [],
      },
    },
    activation_guard: guard,
    authority: {
      monitoring: true,
      public_facts: false,
      fact_candidates: false,
      reconciliation: false,
      publication: false,
      first_observation_notification: false,
    },
    guard_sha256: null,
  };
  disposition.guard_sha256 = stage1BaselineActivationGuardSha256(disposition);
  Object.assign(activation, {
    status: "server_prepare_recorded",
    shared_award_source_id: guard.shared_award_source_id,
    source_acquisition_id: guard.shared_award_source_acquisition_id,
    source_page_request_id: guard.source_page_request_id,
    capture_file_sha256: guard.capture_file_sha256,
    expected_normalized_text_sha256: guard.normalized_retained_text_sha256,
    observed_normalized_text_sha256: guard.normalized_retained_text_sha256,
    guard_sha256: disposition.guard_sha256,
    reviewed_final_url: guard.final_url,
    observed_final_url: metadata.final_url,
    visual_evidence_quotes_verified: true,
    retained_evidence_quotes_verified: true,
  });
  return {
    acquisition: {
      id: guard.shared_award_source_acquisition_id,
      shared_award_source_id: guard.shared_award_source_id,
      origin_source_page_request_id: guard.source_page_request_id,
      acquisition_kind: "historical_import",
      notification_mode: "baseline_only",
      onboarding_batch_id: STAGE1_BASELINE_ACTIVATION_BATCH_ID,
      review_seal: {
        source_page_request_id: guard.source_page_request_id,
        capture_file_hash: guard.capture_file_sha256,
        capture_final_url: guard.final_url,
        human_source_disposition: disposition,
      },
    },
    evidenceQuote,
    fileHash: guard.capture_file_sha256,
    finalUrl: guard.final_url,
  };
}

function exactCommonEvidenceQuote(intakeText, browserText) {
  const intakeWords = normalizeStage1BaselineEvidenceWords(intakeText).split(" ");
  const browserWords = ` ${normalizeStage1BaselineEvidenceWords(browserText)} `;
  for (let length = 20; length >= 8; length -= 1) {
    for (let index = 0; index + length <= intakeWords.length; index += 1) {
      const candidate = intakeWords.slice(index, index + length).join(" ");
      if (browserWords.includes(` ${candidate} `)) return candidate;
    }
  }
  throw new Error("The retained intake and browser fixture have no shared evidence quote.");
}

function exactSixFixturePaths(definition) {
  const captureRoot = exactSixCaptureRoot(definition);
  return {
    baseline: `${exactSixArchiveRoot}/sources/${definition.sourceId}/baseline.json`,
    layout: `${captureRoot}/layout.json`,
    meta: `${captureRoot}/meta.json`,
    page: `${captureRoot}/page.jpg`,
    text: `${captureRoot}/text.txt`,
    thumb: `${captureRoot}/thumb.jpg`,
  };
}

function exactSixCaptureRoot(definition) {
  return `${exactSixArchiveRoot}/sources/${definition.sourceId}/captures/${definition.captureDirectory}`;
}

function exactSixIntakeTextPath(activation) {
  const match = /^source-intake-first-observation\/v1\/requests\/([^/]+)\/sha256\/([a-f0-9]{64})\/text\.txt$/u
    .exec(String(activation?.retained_text_artifact?.key || ""));
  if (!match) throw new Error("The retained activation has no exact intake text path.");
  return `${exactSixArchiveRoot}/intake-artifacts/requests/${match[1]}/sha256/${match[2]}/text.txt`;
}

function validWebFixture({
  candidateText = reviewedText,
  candidatePage = Buffer.from("stable page image"),
  intakeText = candidateText,
  candidateExpansionCount = 0,
  candidateCoverageComplete = true,
  existingLayoutUnavailable = false,
} = {}) {
  const existing = webCapture({
    capturedAt: existingAt,
    text: reviewedText,
    page: Buffer.from("stable page image"),
    layoutX: 1,
    modern: false,
    expansionCount: 0,
    layoutUnavailable: existingLayoutUnavailable,
  });
  const candidate = webCapture({
    capturedAt: captureAt,
    text: candidateText,
    page: candidatePage,
    layoutX: 2,
    modern: true,
    expansionCount: candidateExpansionCount,
    coverageComplete: candidateCoverageComplete,
  });
  const acquisition = validAcquisition({ fileHash: "a".repeat(64), text: reviewedText });
  return {
    sourceId,
    sourceKind: "webpage",
    reviewedFinalUrl: finalUrl,
    reviewedEvidenceQuotes: [reviewedQuote],
    immutableAcquisition: {
      acquisition,
      identity: { file_hash: "a".repeat(64) },
    },
    existingBaseline: baselineFor(existing.capture, acquisition),
    existingCapture: { ...existing.capture, text: `${existing.capture.text}\n` },
    existingPreparedArtifacts: existing.prepared,
    capture: candidate.capture,
    capturePreparedArtifacts: candidate.prepared,
    preIntake: intake(intakeText),
    postIntake: intake(intakeText),
  };
}

function validPdfFixture({ candidatePdf = Buffer.from("reviewed official PDF bytes") } = {}) {
  const reviewedPdf = Buffer.from("reviewed official PDF bytes");
  const existing = pdfCapture({ capturedAt: existingAt, pdf: reviewedPdf, modern: false });
  const candidate = pdfCapture({ capturedAt: captureAt, pdf: candidatePdf, modern: true });
  const acquisition = validAcquisition({ fileHash: sha256(reviewedPdf), text: reviewedText });
  return {
    sourceId,
    sourceKind: "pdf",
    reviewedFinalUrl: finalUrl,
    reviewedEvidenceQuotes: [reviewedQuote],
    immutableAcquisition: {
      acquisition,
      identity: {
        file_hash: sha256(reviewedPdf),
        text_hash: sha256(Buffer.from(reviewedText)),
      },
    },
    existingBaseline: baselineFor(existing.capture, acquisition),
    existingCapture: { ...existing.capture, text: `${existing.capture.text}\n` },
    existingPreparedArtifacts: existing.prepared,
    capture: candidate.capture,
    capturePreparedArtifacts: candidate.prepared,
  };
}

function validBeineckeFaqSemanticBridgeFixture() {
  const boundSourceId = "2ea41875-5c88-5794-81b3-afa8ddaf31c1";
  const boundFinalUrl =
    "https://beineckescholarship.org/beinecke-scholarship/scholar-faqs";
  const fullText = beineckeLegacyFullText();
  const intakeText = beineckeReviewedIntakeText();
  const semantic = {
    body_text_hash: "62753e4c86d848ed9b394337f6f17777171fe3ef78d734944696982095bce936",
    body_text_length: 2378,
    main_content_hash: "4cbc91149287266cd6c0a1a4156d05a1c74bc393be29ca73369aa613b6f49c27",
    main_content_text_length: 2224,
    nav_header_footer_hash:
      "05c1a5128b0b539512ec1de5e7b5079964d72a3829b3d2daad047fab48bf04de",
    nav_header_footer_text_length: 163,
    expansion_hash: "59b1a04cf0430a8a3b20ed185c50db62cd0759ad025397707f6317ae3293e042",
    expansion_text_length: 4266,
    expandable_sections_hash:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
  const page = Buffer.from("stable Beinecke FAQ primary screenshot fixture");
  const existing = webCapture({
    capturedAt: "2026-08-03T18:44:41.262Z",
    text: fullText,
    page,
    layoutX: 1,
    modern: false,
    expansionCount: 4,
    captureSourceId: boundSourceId,
    captureFinalUrl: `${boundFinalUrl}/`,
    semantic,
  });
  const candidate = webCapture({
    capturedAt: "2026-08-15T01:53:39.593Z",
    text: fullText,
    page,
    layoutX: 2,
    modern: true,
    expansionCount: 4,
    captureSourceId: boundSourceId,
    captureFinalUrl: `${boundFinalUrl}/`,
    semantic,
  });
  const acquisition = beineckeAcquisition();
  return {
    sourceId: boundSourceId,
    sourceKind: "webpage",
    reviewedFinalUrl: boundFinalUrl,
    reviewedEvidenceQuotes:
      acquisition.review_seal.human_source_disposition.effective_source_review.evidence_quotes,
    immutableAcquisition: {
      acquisition,
      identity: {
        file_hash: "6ee5b5322ed5f5563063d919e552839d434bf08456d8176fbfda9404e015e7e2",
      },
    },
    existingBaseline: baselineFor(existing.capture, acquisition),
    existingCapture: { ...existing.capture, text: `${existing.capture.text}\n` },
    existingPreparedArtifacts: existing.prepared,
    authoritativeExistingR2Binding:
      beineckeFaqLegacyFixtureJson("r2_binding_receipt"),
    capture: candidate.capture,
    capturePreparedArtifacts: candidate.prepared,
    preIntake: beineckeIntake(intakeText),
    postIntake: beineckeIntake(intakeText),
  };
}

function beineckeAcquisition() {
  const boundSourceId = "2ea41875-5c88-5794-81b3-afa8ddaf31c1";
  const boundAcquisitionId = "42e72340-c3b8-5ca2-8913-aed7f7c56be5";
  const boundRequestId = "cc190ad2-8240-5b8c-b5ac-a73180094d24";
  const boundFinalUrl =
    "https://beineckescholarship.org/beinecke-scholarship/scholar-faqs";
  return {
    id: boundAcquisitionId,
    shared_award_source_id: boundSourceId,
    origin_source_page_request_id: boundRequestId,
    acquisition_kind: "historical_import",
    notification_mode: "baseline_only",
    onboarding_batch_id: STAGE1_BASELINE_ACTIVATION_BATCH_ID,
    review_seal: {
      source_page_request_id: boundRequestId,
      capture_file_hash:
        "6ee5b5322ed5f5563063d919e552839d434bf08456d8176fbfda9404e015e7e2",
      capture_final_url: boundFinalUrl,
      human_source_disposition: {
        schema_version: "awardping.stage1.baseline-source-human-disposition.v1",
        policy_version: "stage1-baseline-source-disposition-v1",
        decision: "approve_baseline_only",
        effective_source_review: {
          status: "accepted",
          source_relevance: "primary",
          cycle_relevance: "evergreen",
          officialness: "official",
          confidence: "high",
          page_type: "faq",
          evidence_quotes: [
            "Scholars are eligible to begin receiving their Beinecke Scholarship funds only after they have completed their undergraduate degree and accepted an offer to pursue graduate study as a full-time student in an accredited degree-granting program.",
            "Yes, the most that Scholars can receive from the Beinecke Scholarship in a fiscal year is $15,000, exclusive of the $5,000 start-up funds.",
          ],
          exact_evidence_verified: true,
          reviewed_roles: ["faq"],
          facts: {
            description: null,
            deadline: null,
            amount: null,
            eligibility: [],
            application_materials: [],
            important_dates: [],
          },
        },
        activation_guard: {
          mode: "first_visual_baseline_exact_normalized_retained_text",
          onboarding_batch_id: STAGE1_BASELINE_ACTIVATION_BATCH_ID,
          shared_award_source_id: boundSourceId,
          source_page_request_id: boundRequestId,
          shared_award_source_acquisition_id: boundAcquisitionId,
          evidence_packet_sha256:
            "8a1c1d9aa8ccbdf1dcdbb7b2f4b83ac19c99dd9557a8949dff5f63dd22d1026f",
          decision_item_sha256:
            "03afd34c72a611776473793f5b7c5a3cfdf48848c6de687a6354046a48e10b87",
          normalized_retained_text_sha256:
            "4cbc91149287266cd6c0a1a4156d05a1c74bc393be29ca73369aa613b6f49c27",
          retained_text_artifact: {
            store_id: "46963c344e088c9dbf4913651a8d2c6c.r2.cloudflarestorage.com",
            bucket: "awardping-snapshots",
            key:
              "source-intake-first-observation/v1/requests/" +
              `${boundRequestId}/sha256/` +
              "6ee5b5322ed5f5563063d919e552839d434bf08456d8176fbfda9404e015e7e2/text.txt",
            sha256: "20cd1159b40045dd34fdd7cc674c34e617ab2b2dd878e25755270e2611ad98aa",
            bytes: 2225,
            r2_verified_at: "2026-07-27T22:21:15.422Z",
          },
          capture_file_sha256:
            "6ee5b5322ed5f5563063d919e552839d434bf08456d8176fbfda9404e015e7e2",
          final_url: boundFinalUrl,
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
        guard_sha256:
          "6f0d052effa393a460bd5b91d5051a8d23dfbb7272073c150ad0903f5e66eadb",
      },
    },
  };
}

function beineckeLegacyFullText() {
  return withoutWriterNewline(beineckeFaqLegacyFixtureBody("legacy_full_text").toString("utf8"));
}

function beineckeReviewedIntakeText() {
  return withoutWriterNewline(
    beineckeFaqLegacyFixtureBody("reviewed_intake_text").toString("utf8"),
  );
}

function beineckeIntake(text) {
  const url = "https://beineckescholarship.org/beinecke-scholarship/scholar-faqs";
  return {
    ok: true,
    text,
    final_url: `${url}/`,
    canonical_url: url,
    capture_method: "fetch_html",
  };
}

function withoutWriterNewline(value) {
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}

function webCapture({
  capturedAt,
  text,
  page,
  layoutX,
  modern,
  expansionCount,
  coverageComplete = true,
  layoutUnavailable = false,
  captureSourceId = sourceId,
  captureFinalUrl = finalUrl,
  semantic = null,
}) {
  const directory = captureDirectory(capturedAt, captureSourceId);
  const prefix = archivePrefix(capturedAt, captureSourceId);
  const thumb = Buffer.from("thumbnail");
  const imageHash = sha256(page);
  const textHash = sha256(Buffer.from(text));
  const geometry = readyGeometry(
    imageHash,
    "main",
    capturedAt,
    layoutX,
    layoutUnavailable,
  );
  const expansionStates = Array.from({ length: expansionCount }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    const statePage = Buffer.from(`expanded state ${suffix}`);
    const stateImageHash = sha256(statePage);
    const stateText = reviewedQuote;
    const stateGeometry = readyGeometry(
      stateImageHash,
      `expansion-state-${suffix}`,
      capturedAt,
      10 + index,
    );
    return {
      state_id: `expansion-state-${suffix}`,
      index,
      label: `Panel ${suffix}`,
      captured_at: capturedAt,
      image_hash: stateImageHash,
      layout_hash: stateGeometry.geometry_hash,
      text_geometry: stateGeometry,
      text_hash: sha256(Buffer.from(stateText)),
      text_length: stateText.length,
      page_bytes: statePage.length,
      page_path: `${directory}/expansion-state-${suffix}.jpg`,
      layout_path: `${directory}/expansion-state-${suffix}-layout.json`,
      page_body: statePage,
    };
  });
  const coverage = modern
    ? coverageComplete
      ? completeCoverage(expansionCount)
      : conservativeExpansionStateCaptureCoverage({
          retainedStateCount: expansionCount,
          captureLimit: Math.max(1, expansionCount),
        })
    : conservativeExpansionStateCaptureCoverage({
        retainedStateCount: expansionCount,
        captureLimit: 24,
      });
  const projection = modern
    ? retainedProjection("webpage", geometry.geometry_hash, expansionCount)
    : null;
  const semanticIdentity = semantic || semanticFields(text);
  const capture = {
    version: 1,
    kind: "webpage",
    source: { id: captureSourceId },
    captured_at: capturedAt,
    final_url: captureFinalUrl,
    text,
    text_hash: textHash,
    text_length: text.length,
    ...semanticIdentity,
    image_hash: imageHash,
    page_bytes: page.length,
    thumb_bytes: thumb.length,
    layout_hash: geometry.geometry_hash,
    text_geometry: geometry,
    localization: layoutUnavailable
      ? unavailableLocalization(geometry.geometry_hash, imageHash)
      : {
          status: "geometry_ready",
          geometry_hash: geometry.geometry_hash,
          bound_image_hash: imageHash,
        },
    retained_artifact_projection: projection,
    expansion_state_capture_coverage: coverage,
    expansion_state_screenshots: expansionStates,
    dir: directory,
    page_path: `${directory}/page.jpg`,
    thumb_path: `${directory}/thumb.jpg`,
    text_path: `${directory}/text.txt`,
    layout_path: `${directory}/layout.json`,
    meta_path: `${directory}/meta.json`,
  };
  const metadata = {
    version: 1,
    kind: "webpage",
    source: { id: captureSourceId },
    captured_at: capturedAt,
    final_url: captureFinalUrl,
    text_hash: textHash,
    text_length: text.length,
    ...semanticIdentity,
    image_hash: imageHash,
    page_bytes: page.length,
    thumb_bytes: thumb.length,
    layout_hash: geometry.geometry_hash,
    text_geometry: { ...geometry, file: `${prefix}layout.json` },
    localization: layoutUnavailable
      ? unavailableLocalization(geometry.geometry_hash, imageHash)
      : {
          status: "geometry_ready",
          geometry_hash: geometry.geometry_hash,
          bound_image_hash: imageHash,
        },
    retained_artifact_projection: projection,
    ...(modern
      ? {
          expansion_state_count: expansionCount,
          expansion_state_capture_coverage: coverage,
        }
      : legacyCoverageScalars(expansionCount)),
    expansion_state_screenshots: expansionStates.map((state, index) => {
      const suffix = String(index + 1).padStart(2, "0");
      return {
        state_id: state.state_id,
        index,
        label: state.label,
        captured_at: capturedAt,
        image_hash: state.image_hash,
        layout_hash: state.layout_hash,
        text_geometry: {
          ...state.text_geometry,
          file: `${prefix}expansion-state-${suffix}-layout.json`,
        },
        text_hash: state.text_hash,
        text_length: state.text_length,
        page_bytes: state.page_bytes,
        page: `${prefix}expansion-state-${suffix}.jpg`,
        layout: `${prefix}expansion-state-${suffix}-layout.json`,
      };
    }),
    files: {
      page: `${prefix}page.jpg`,
      thumb: `${prefix}thumb.jpg`,
      text: `${prefix}text.txt`,
      layout: `${prefix}layout.json`,
      meta: `${prefix}meta.json`,
      expansion_states: expansionStates.map((state, index) => {
        const suffix = String(index + 1).padStart(2, "0");
        return {
          state_id: state.state_id,
          page: `${prefix}expansion-state-${suffix}.jpg`,
          layout: `${prefix}expansion-state-${suffix}-layout.json`,
        };
      }),
    },
  };
  const definitions = {
    page: ["page.jpg", "image/jpeg", page, capture.page_path],
    thumb: ["thumb.jpg", "image/jpeg", thumb, capture.thumb_path],
    text: ["text.txt", "text/plain; charset=utf-8", Buffer.from(`${text}\n`), capture.text_path],
    layout: [
      "layout.json",
      "application/json; charset=utf-8",
      Buffer.from(JSON.stringify(geometry)),
      capture.layout_path,
    ],
    meta: [
      "meta.json",
      "application/json; charset=utf-8",
      Buffer.from(JSON.stringify(metadata)),
      capture.meta_path,
    ],
  };
  for (const [index, state] of expansionStates.entries()) {
    const suffix = String(index + 1).padStart(2, "0");
    definitions[`expansion_state_${suffix}`] = [
      `expansion-state-${suffix}.jpg`,
      "image/jpeg",
      state.page_body,
      state.page_path,
    ];
    definitions[`expansion_state_${suffix}_layout`] = [
      `expansion-state-${suffix}-layout.json`,
      "application/json; charset=utf-8",
      Buffer.from(JSON.stringify(state.text_geometry)),
      state.layout_path,
    ];
  }
  return { capture, prepared: prepareFromDefinitions(definitions) };
}

function pdfCapture({ capturedAt, pdf, modern }) {
  const directory = captureDirectory(capturedAt);
  const prefix = archivePrefix(capturedAt);
  const fileHash = sha256(pdf);
  const textHash = sha256(Buffer.from(reviewedText));
  const projection = modern ? retainedProjection("pdf", null, 0) : null;
  const capture = {
    version: 1,
    kind: "pdf",
    source: { id: sourceId },
    captured_at: capturedAt,
    final_url: finalUrl,
    text: reviewedText,
    text_hash: textHash,
    text_length: reviewedText.length,
    file_hash: fileHash,
    image_hash: fileHash,
    file_bytes: pdf.length,
    retained_artifact_projection: projection,
    expansion_state_capture_coverage: null,
    expansion_state_screenshots: [],
    localization: { status: "not_applicable_pdf" },
    dir: directory,
    pdf_path: `${directory}/document.pdf`,
    text_path: `${directory}/text.txt`,
    meta_path: `${directory}/meta.json`,
  };
  const metadata = {
    version: 1,
    kind: "pdf",
    source: { id: sourceId },
    captured_at: capturedAt,
    final_url: finalUrl,
    text_hash: textHash,
    text_length: reviewedText.length,
    file_hash: fileHash,
    image_hash: fileHash,
    file_bytes: pdf.length,
    retained_artifact_projection: projection,
    expansion_state_capture_coverage: null,
    expansion_state_count: 0,
    expansion_state_screenshots: [],
    localization: { status: "not_applicable_pdf" },
    files: {
      pdf: `${prefix}document.pdf`,
      text: `${prefix}text.txt`,
      meta: `${prefix}meta.json`,
      expansion_states: [],
    },
  };
  const prepared = prepareFromDefinitions({
    pdf: ["document.pdf", "application/pdf", pdf, capture.pdf_path],
    text: [
      "text.txt",
      "text/plain; charset=utf-8",
      Buffer.from(`${reviewedText}\n`),
      capture.text_path,
    ],
    meta: [
      "meta.json",
      "application/json; charset=utf-8",
      Buffer.from(JSON.stringify(metadata)),
      capture.meta_path,
    ],
  });
  return { capture, prepared };
}

function baselineFor(capture, acquisition) {
  const guard = acquisition.review_seal.human_source_disposition.activation_guard;
  const boundSourceId = capture.source.id;
  const boundAcquisitionId = acquisition.id;
  const boundRequestId = acquisition.origin_source_page_request_id;
  const boundFinalUrl = guard.final_url;
  const activation = {
    status: "server_prepare_recorded",
    shared_award_source_id: boundSourceId,
    source_acquisition_id: boundAcquisitionId,
    source_page_request_id: boundRequestId,
    expected_normalized_text_sha256: guard.normalized_retained_text_sha256,
    observed_normalized_text_sha256: guard.normalized_retained_text_sha256,
    guard_sha256: acquisition.review_seal.human_source_disposition.guard_sha256,
    reviewed_final_url: boundFinalUrl,
    observed_final_url: capture.final_url,
    visual_evidence_quotes_verified: true,
    retained_evidence_quotes_verified: true,
  };
  return {
    version: 1,
    kind: capture.kind,
    source: { id: boundSourceId },
    captured_at: capture.captured_at,
    final_url: capture.final_url,
    text_hash: capture.text_hash,
    text_length: capture.text_length,
    body_text_hash: capture.body_text_hash || null,
    body_text_length: capture.body_text_length ?? null,
    main_content_hash: capture.main_content_hash || null,
    main_content_text_length: capture.main_content_text_length ?? null,
    nav_header_footer_hash: capture.nav_header_footer_hash || null,
    nav_header_footer_text_length: capture.nav_header_footer_text_length ?? null,
    expansion_hash: capture.expansion_hash || null,
    expansion_text_length: capture.expansion_text_length ?? null,
    expandable_sections_hash: capture.expandable_sections_hash ?? null,
    image_hash: capture.image_hash,
    layout_hash: capture.layout_hash || null,
    file_hash: capture.file_hash || null,
    file_bytes: capture.file_bytes || null,
    capture: {
      meta: `${archivePrefix(capture.captured_at, boundSourceId)}meta.json`,
      expansion_states: capture.expansion_state_screenshots.map((state) => ({
        state_id: state.state_id,
        image_hash: state.image_hash,
        layout_hash: state.layout_hash,
        page: state.page_path,
        layout: state.layout_path,
      })),
    },
    summary_metadata: {
      stage1_baseline_activation: activation,
      retained_artifact_projection: capture.retained_artifact_projection,
      expansion_state_capture_coverage: capture.expansion_state_capture_coverage,
    },
  };
}

function validAcquisition({ fileHash, text }) {
  const normalizedHash = stage1BaselineActivationTextSha256(text);
  const acquisition = {
    id: acquisitionId,
    shared_award_source_id: sourceId,
    origin_source_page_request_id: requestId,
    acquisition_kind: "historical_import",
    notification_mode: "baseline_only",
    onboarding_batch_id: STAGE1_BASELINE_ACTIVATION_BATCH_ID,
    review_seal: {
      source_page_request_id: requestId,
      capture_file_hash: fileHash,
      capture_final_url: finalUrl,
      human_source_disposition: {
        schema_version: "awardping.stage1.baseline-source-human-disposition.v1",
        policy_version: "stage1-baseline-source-disposition-v1",
        decision: "approve_baseline_only",
        effective_source_review: {
          status: "accepted",
          source_relevance: "primary",
          cycle_relevance: "evergreen",
          officialness: "official",
          confidence: "high",
          page_type: "eligibility",
          evidence_quotes: [reviewedQuote],
          exact_evidence_verified: true,
          facts: {
            description: null,
            deadline: null,
            amount: null,
            eligibility: [],
            application_materials: [],
            important_dates: [],
          },
          reviewed_roles: ["eligibility"],
        },
        activation_guard: {
          mode: "first_visual_baseline_exact_normalized_retained_text",
          onboarding_batch_id: STAGE1_BASELINE_ACTIVATION_BATCH_ID,
          notification_mode: "baseline_only",
          source_page_request_id: requestId,
          shared_award_source_id: sourceId,
          shared_award_source_acquisition_id: acquisitionId,
          evidence_packet_sha256: "c".repeat(64),
          decision_item_sha256: "d".repeat(64),
          normalized_retained_text_sha256: normalizedHash,
          retained_text_artifact: {
            store_id: "awardping-r2-production",
            bucket: "awardping-snapshots",
            key:
              `source-intake-first-observation/v1/requests/${requestId}/sha256/` +
              `${fileHash}/text.txt`,
            sha256: "b".repeat(64),
            bytes: Buffer.byteLength(`${text}\n`, "utf8"),
            r2_verified_at: "2026-08-03T16:00:00.000Z",
          },
          capture_file_sha256: fileHash,
          final_url: finalUrl,
        },
        authority: {
          monitoring: true,
          public_facts: false,
          fact_candidates: false,
          reconciliation: false,
          publication: false,
          first_observation_notification: false,
        },
        guard_sha256: null,
      },
    },
  };
  const disposition = acquisition.review_seal.human_source_disposition;
  disposition.guard_sha256 = stage1BaselineActivationGuardSha256(disposition);
  return acquisition;
}

function readyGeometry(imageHash, stateId, capturedAt, x, unavailable = false) {
  const source = {
    version: 1,
    state_id: stateId,
    captured_at: capturedAt,
    coordinate_space: "document-css-pixels",
    document: { width: 100, height: 100 },
    viewport: { width: 100, height: 100 },
    scroll: { x: 0, y: 0 },
    device_pixel_ratio: 1,
    paint_stack: { contract: "browser-paint-stack-v1", status: "verified" },
    ...(unavailable
      ? {
          availability_status: "unavailable_layout_changed_during_screenshot",
          unavailable_reason: "The page moved while the screenshot was taken.",
        }
      : {}),
    nodes: [{
      order: 0,
      path: null,
      flow_path: null,
      text: "Text",
      separator_before: " ",
      rects: [{ x, y: 1, width: 20, height: 10, right: x + 20, bottom: 11 }],
      runs: [{
        start: 0,
        end: 4,
        text: "Text",
        rects: [{ x, y: 1, width: 20, height: 10, right: x + 20, bottom: 11 }],
      }],
    }],
  };
  const fingerprint = visualTextGeometryLayoutFingerprint(source);
  source.capture_verification = {
    contract: "visual-screenshot-layout-binding-v1",
    status: "verified",
    before_fingerprint: fingerprint,
    after_fingerprint: fingerprint,
  };
  return bindVisualTextGeometry(source, {
    capturedAt,
    imageHash,
    screenshot: { pixel_width: 100, pixel_height: 100 },
  });
}

function unavailableLocalization(geometryHash, imageHash) {
  return {
    status: "evidence_only_geometry_unavailable",
    exact: false,
    accounted_for: true,
    geometry_ready: false,
    unavailable_reason: "The page moved while the screenshot was taken.",
    geometry_hash: geometryHash,
    bound_image_hash: imageHash,
  };
}

function completeCoverage(retainedStateCount) {
  return expansionStateCaptureCoverage({
    raw_candidates: retainedStateCount,
    raw_candidate_count_exact: true,
    candidates: retainedStateCount,
    candidate_count_exact: true,
    attempted: retainedStateCount,
    capture_limit: 24,
    capture_complete: true,
    capture_status: "verified_complete",
    truncated: false,
    truncated_count: 0,
    truncated_count_exact: true,
    failures: [],
  }, { retainedStateCount });
}

function legacyCoverageScalars(expansionCount = 0) {
  return {
    expansion_state_attempted: expansionCount,
    expansion_state_candidates: expansionCount,
    expansion_state_capture_limit: 24,
    expansion_state_capture_complete: true,
    expansion_state_truncated: false,
    expansion_state_truncated_count: 0,
    expansion_state_failures: [],
  };
}

function retainedProjection(kind, layoutHash, expansionStateCount) {
  return {
    schema: retainedCaptureArtifactProjectionSchema,
    kind,
    localization_status: kind === "pdf"
      ? "not_applicable_pdf"
      : "exact_geometry_available",
    authoritative: {
      layout_retained: kind === "webpage",
      layout_hash: kind === "webpage" ? layoutHash : null,
      expansion_state_count: expansionStateCount,
    },
  };
}

function semanticFields(text) {
  return {
    body_text_hash: sha256(Buffer.from(`body:${text}`)),
    body_text_length: text.length,
    main_content_hash: sha256(Buffer.from(`main:${text}`)),
    main_content_text_length: text.length,
    nav_header_footer_hash: sha256(Buffer.from(`chrome:${text}`)),
    nav_header_footer_text_length: 0,
    expansion_hash: sha256(Buffer.from(`expansion:${text}`)),
    expansion_text_length: reviewedQuote.length,
    expandable_sections_hash: null,
  };
}

function intake(text) {
  return {
    ok: true,
    text,
    final_url: finalUrl,
    canonical_url: finalUrl,
    capture_method: "fetch_html",
  };
}

function prepareFromDefinitions(definitions) {
  const bodies = new Map();
  const files = Object.entries(definitions).map(([name, [fileName, contentType, body, path]]) => {
    bodies.set(path, body);
    return { name, fileName, path, contentType };
  });
  const prepared = prepareR2CaptureArtifacts(files, { readFile: (path) => bodies.get(path) });
  return {
    ...prepared,
    artifacts: prepared.artifacts.map((artifact) => ({
      ...artifact,
      path: definitions[artifact.name][3],
    })),
  };
}

function mutatePreparedArtifact(prepared, name, mutate) {
  const definitions = {};
  for (const artifact of prepared.artifacts) {
    definitions[artifact.name] = [
      artifact.fileName,
      artifact.contentType,
      artifact.name === name ? mutate(artifact.body) : artifact.body,
      artifact.path,
    ];
  }
  return prepareFromDefinitions(definitions);
}

function captureDirectory(capturedAt, captureSourceId = sourceId) {
  return `C:/archive/sources/${captureSourceId}/captures/${generation(capturedAt)}`;
}

function archivePrefix(capturedAt, captureSourceId = sourceId) {
  return `sources/${captureSourceId}/captures/${generation(capturedAt)}/`;
}

function generation(capturedAt) {
  return new Date(capturedAt).toISOString().replace(/[:.]/gu, "-");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
