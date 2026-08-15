import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_CHURCHILL_SOURCE_ID,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_LUCE_SOURCE_ID,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS,
  assertExactStage1EvidenceSchemaUpgradeSourceIds,
  assertStage1EvidenceSchemaUpgradeCliContract,
  createStage1EvidenceSchemaUpgradeReport,
  evaluateStage1EvidenceSchemaUpgradeEligibility,
  runStage1EvidenceSchemaUpgradeSource,
  stage1EvidenceSchemaUpgradeExpectedManifest,
  validateStage1EvidenceSchemaUpgradeManifest,
} from "./stage1-evidence-schema-upgrade.mjs";
import {
  STAGE1_BASELINE_ACTIVATION_BATCH_ID,
  stage1BaselineActivationGuardSha256,
  stage1BaselineActivationTextSha256,
} from "./stage1-baseline-activation-guard.mjs";
import { STAGE1_BASELINE_EVIDENCE_PACKET_SHA256 } from "./stage1-baseline-source-disposition.mjs";
import {
  sealStage1EvidenceSchemaUpgradeMutationAccounting,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";
import {
  visualReviewEnqueueContexts,
  visualReviewEnqueuePolicy,
} from "./visual-review-queue.mjs";

const sourceId = STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS[0];
const acquisitionId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const finalUrl = "https://example.org/beinecke/about";
const retainedText = "The Beinecke Scholarship supports graduate study.";
const finalizedAt = "2026-08-14T18:00:00.000Z";

function enqueuePolicy() {
  return visualReviewEnqueuePolicy({
    context: visualReviewEnqueueContexts.stage1EvidenceSchemaUpgrade,
    bypassRejectionLedger: true,
    queueReconciliation: false,
  });
}

function validAcquisition() {
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
      page_type: "other",
      evidence_quotes: [retainedText],
      exact_evidence_verified: true,
      facts: {
        description: null,
        deadline: null,
        amount: null,
        eligibility: [],
        application_materials: [],
        important_dates: [],
      },
      reviewed_roles: ["funding"],
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
      normalized_retained_text_sha256: stage1BaselineActivationTextSha256(retainedText),
      retained_text_artifact: {
        store_id: "awardping-r2-production",
        bucket: "awardping-snapshots",
        key: `source-intake-first-observation/v1/requests/${requestId}/sha256/${"a".repeat(64)}/text.txt`,
        sha256: "b".repeat(64),
        bytes: Buffer.byteLength(`${retainedText}\n`, "utf8"),
        r2_verified_at: "2026-08-03T16:00:00.000Z",
      },
      capture_file_sha256: "a".repeat(64),
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
  };
  disposition.guard_sha256 = stage1BaselineActivationGuardSha256(disposition);
  return {
    id: acquisitionId,
    shared_award_source_id: sourceId,
    origin_source_page_request_id: requestId,
    acquisition_kind: "historical_import",
    notification_mode: "baseline_only",
    onboarding_batch_id: STAGE1_BASELINE_ACTIVATION_BATCH_ID,
    review_seal: {
      source_page_request_id: requestId,
      capture_file_hash: "a".repeat(64),
      capture_final_url: finalUrl,
      human_source_disposition: disposition,
    },
  };
}

function validFinalizedSource() {
  const acquisition = validAcquisition();
  const persistenceEvidence = {
    schema_version: "awardping.stage1.baseline-activation-persistence-evidence.v3",
    source_id: sourceId,
    acquisition_id: acquisitionId,
  };
  const receipt = {
    schema_version: "awardping.stage1.baseline-activation-finalization-receipt.v1",
    status: "finalized_open",
    shared_award_source_id: sourceId,
    source_acquisition_id: acquisitionId,
    source_page_request_id: requestId,
    decision_item_sha256: acquisition.review_seal.human_source_disposition.activation_guard
      .decision_item_sha256,
    guard_sha256: acquisition.review_seal.human_source_disposition.guard_sha256,
    observed_normalized_text_sha256: stage1BaselineActivationTextSha256(retainedText),
    prepare_receipt_sha256: "e".repeat(64),
    persistence_evidence_sha256: sha256(canonicalJson(persistenceEvidence)),
    finalized_at: finalizedAt,
    public_fact_authority: false,
    creates_api_charge: false,
  };
  return {
    id: sourceId,
    url: finalUrl,
    admin_review_status: "open",
    admin_review_note: "exact_first_visual_baseline_verified",
    admin_reviewed_by: "stage1-baseline-activation-receipt",
    admin_reviewed_at: finalizedAt,
    shared_awards: { name: "Beinecke Scholarship", status: "active" },
    source_acquisition: acquisition,
    source_activation_finalization: {
      source_acquisition_id: acquisitionId,
      shared_award_source_id: sourceId,
      source_page_request_id: requestId,
      disposition_item_sha256: receipt.decision_item_sha256,
      prepare_receipt_sha256: receipt.prepare_receipt_sha256,
      guard_sha256: receipt.guard_sha256,
      observed_normalized_text_sha256: receipt.observed_normalized_text_sha256,
      persistence_evidence: persistenceEvidence,
      finalization_receipt_sha256: sha256(canonicalJson(receipt)),
      receipt,
      finalized_at: finalizedAt,
    },
  };
}

function captureDecision(decision) {
  return {
    decision,
    reason: `${decision}_test`,
    creates_api_charge: false,
    outcome: {
      would_commit: decision === "eligible_unchanged_upgrade",
      would_queue_visual_candidate: decision === "material_difference_candidate",
      would_quarantine: decision === "evidence_failure_quarantine",
    },
    evidence: { exact_test_evidence: true },
  };
}

function mutationResult(operation, status, counts = {}) {
  const mutationCounts = {
    database_writes: 0,
    r2_writes: 0,
    local_baseline_writes: 0,
    candidate_writes: 0,
    quarantine_writes: 0,
    source_state_writes: 0,
    ...counts,
  };
  return {
    status,
    source_id: sourceId,
    context: "stage1_evidence_schema_upgrade",
    creates_api_charge: false,
    mutation_counts: mutationCounts,
    receipt: {
      source_id: sourceId,
      context: "stage1_evidence_schema_upgrade",
      operation,
      status,
      creates_api_charge: false,
      mutation_counts: structuredClone(mutationCounts),
    },
  };
}

describe("Stage 1 evidence-schema-upgrade reviewed-nine boundary", () => {
  it("accepts only the exact immutable manifest and exact nine-source set", () => {
    const manifest = stage1EvidenceSchemaUpgradeExpectedManifest();
    expect(manifest.evidence_packet_sha256).toBe(
      STAGE1_BASELINE_EVIDENCE_PACKET_SHA256,
    );
    expect(validateStage1EvidenceSchemaUpgradeManifest(JSON.stringify(manifest)))
      .toEqual(manifest);
    expect(assertExactStage1EvidenceSchemaUpgradeSourceIds(
      [...STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS].reverse(),
    )).toEqual(STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS);

    const drifted = structuredClone(manifest);
    drifted.safety.changed_content_must_not_be_absorbed = false;
    expect(() => validateStage1EvidenceSchemaUpgradeManifest(drifted))
      .toThrow(/exact reviewed-nine manifest/i);
  });

  it("hard-denies Churchill and the deterministic Luce source identity", () => {
    for (const [id, message] of [
      [STAGE1_EVIDENCE_SCHEMA_UPGRADE_CHURCHILL_SOURCE_ID, /Churchill must remain quarantined/i],
      [STAGE1_EVIDENCE_SCHEMA_UPGRADE_LUCE_SOURCE_ID, /deterministic Luce funding source identity/i],
    ]) {
      const ids = [...STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS];
      ids[0] = id;
      expect(() => assertExactStage1EvidenceSchemaUpgradeSourceIds(ids)).toThrow(message);
    }
    expect(STAGE1_EVIDENCE_SCHEMA_UPGRADE_LUCE_SOURCE_ID)
      .toBe("dad82055-869a-5e78-ac4c-530dad48cae0");
  });

  it("requires the indivisible manifest selector and rejects broad or paid modes", () => {
    const manifest = stage1EvidenceSchemaUpgradeExpectedManifest();
    const base = {
      "source-ids-file": "reviewed-nine.json",
      "gemini-api-max-calls": "0",
      "stage1-evidence-schema-upgrade-dry-run": "true",
      all: true,
      "visual-review-mode": "none",
      "r2-snapshot-sync": true,
      promote: false,
      "keep-unchanged": false,
      "keep-rejected": false,
      "keep-rejected-evidence": false,
      "capture-profile": "baseline-rich",
      "section-extraction-profile": "baseline-rich",
      "max-expansion-state-screenshots": 24,
      "web-concurrency": 1,
      "source-quality-mode": "deterministic",
      "pdf-only": false,
      "web-only": false,
    };
    expect(assertStage1EvidenceSchemaUpgradeCliContract({
      args: base,
      manifest,
      sourceIds: manifest.source_ids,
    })).toMatchObject({ exact_source_count: 9, dry_run: true });
    expect(() => assertStage1EvidenceSchemaUpgradeCliContract({
      args: { ...base, "source-id": sourceId }, manifest, sourceIds: manifest.source_ids,
    })).toThrow(/forbids --source-id/i);
    expect(() => assertStage1EvidenceSchemaUpgradeCliContract({
      args: { ...base, limit: "8" }, manifest, sourceIds: manifest.source_ids,
    })).toThrow(/must equal exactly 9/i);
    expect(() => assertStage1EvidenceSchemaUpgradeCliContract({
      args: { ...base, "gemini-api-max-calls": "1" }, manifest, sourceIds: manifest.source_ids,
    })).toThrow(/gemini-api-max-calls.*exactly 0|zero paid API calls/i);
    expect(() => assertStage1EvidenceSchemaUpgradeCliContract({
      args: { ...base, "visual-review-mode": "batch" }, manifest, sourceIds: manifest.source_ids,
    })).toThrow(/visual-review-mode.*none/i);
    expect(() => assertStage1EvidenceSchemaUpgradeCliContract({
      args: { ...base, "source-quality-mode": "ai" }, manifest, sourceIds: manifest.source_ids,
    })).toThrow(/source-quality-mode.*deterministic|deterministic source quality/i);
    expect(() => assertStage1EvidenceSchemaUpgradeCliContract({
      args: { ...base, "max-expansion-state-screenshots": 8 }, manifest, sourceIds: manifest.source_ids,
    })).toThrow(/max-expansion-state-screenshots.*24|exactly 24 expansion screenshots/i);

    expect(() => assertStage1EvidenceSchemaUpgradeCliContract({
      args: { ...base, all: undefined, "include-not-due": true },
      effectiveArgs: { ...base, all: true },
      manifest,
      sourceIds: manifest.source_ids,
    })).toThrow(/literal operator selector --all=true|raw --all must be the literal true or false/i);
    for (const key of ["promote", "extract-baseline-info", "backfill-baseline-info"]) {
      expect(() => assertStage1EvidenceSchemaUpgradeCliContract({
        args: { ...base, [key]: true },
        effectiveArgs: { ...base, [key]: false },
        manifest,
        sourceIds: manifest.source_ids,
      })).toThrow(/unsafe raw CLI options/i);
    }
    expect(() => assertStage1EvidenceSchemaUpgradeCliContract({
      args: { ...base, "web-concurrency": "not-a-number" },
      effectiveArgs: { ...base, "web-concurrency": 1 },
      manifest,
      sourceIds: manifest.source_ids,
    })).toThrow(/raw --web-concurrency must equal exactly 1/i);
    for (const [key, value] of [
      ["promote", "maybe"],
      ["continuous", "banana"],
      ["stage1-evidence-schema-upgrade-dry-run", "yes"],
      ["r2-snapshot-sync", "1"],
      ["all", "TRUE"],
    ]) {
      expect(() => assertStage1EvidenceSchemaUpgradeCliContract({
        args: { ...base, [key]: value },
        effectiveArgs: { ...base, [key]: false },
        manifest,
        sourceIds: manifest.source_ids,
      })).toThrow(new RegExp(`raw --${key} must be the literal true or false`, "i"));
    }
    for (const key of ["r2-snapshot-sync", "stage1-evidence-schema-upgrade"]) {
      expect(() => assertStage1EvidenceSchemaUpgradeCliContract({
        args: { ...base, [key]: "false" },
        effectiveArgs: { ...base, [key]: true },
        manifest,
        sourceIds: manifest.source_ids,
      })).toThrow(new RegExp(`raw --${key} must equal literal true`, "i"));
    }
    expect(assertStage1EvidenceSchemaUpgradeCliContract({
      args: { ...base, "stage1-evidence-schema-upgrade-dry-run": "false" },
      manifest,
      sourceIds: manifest.source_ids,
    }).dry_run).toBe(false);
  });
});

describe("Stage 1 evidence-schema-upgrade finalized eligibility", () => {
  it("accepts only the exact finalized source, acquisition guard, and receipt", () => {
    expect(evaluateStage1EvidenceSchemaUpgradeEligibility({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
    })).toMatchObject({
      eligible: true,
      source_id: sourceId,
      finalization_binding: { present: true },
      semantic_difference_checked: false,
      evidence_completeness_checked: false,
    });
  });

  it("rejects the old pending state and arbitrary open sources", () => {
    const pending = validFinalizedSource();
    pending.admin_review_status = "review_later";
    pending.admin_review_note = "approved_pending_exact_first_visual_baseline";
    pending.admin_reviewed_by = "stage1-baseline-source-disposition";
    expect(evaluateStage1EvidenceSchemaUpgradeEligibility({
      source: pending,
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
    }).reason_codes).toContain("source_not_exact_finalized_stage1_activation");

    const arbitraryOpen = validFinalizedSource();
    arbitraryOpen.admin_review_note = null;
    arbitraryOpen.admin_reviewed_by = "operator";
    expect(evaluateStage1EvidenceSchemaUpgradeEligibility({
      source: arbitraryOpen,
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
    }).eligible).toBe(false);
  });

  it("rejects missing or tampered finalization proof", () => {
    const missing = validFinalizedSource();
    delete missing.source_activation_finalization;
    expect(evaluateStage1EvidenceSchemaUpgradeEligibility({
      source: missing,
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
    }).reason_codes).toContain("stage1_activation_finalization_missing");

    const tampered = validFinalizedSource();
    tampered.source_activation_finalization.receipt.public_fact_authority = true;
    expect(evaluateStage1EvidenceSchemaUpgradeEligibility({
      source: tampered,
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
    }).reason_codes).toContain("stage1_activation_finalization_receipt_binding_invalid");
  });
});

describe("Stage 1 evidence-schema-upgrade orchestration", () => {
  it("does not claim an arbitrary review_later state is a worker-owned durable quarantine", async () => {
    const held = validFinalizedSource();
    held.admin_review_status = "review_later";
    const captureAndValidate = vi.fn();
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: held,
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: { captureAndValidate },
    });
    expect(captureAndValidate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "ineligible",
      source_eligible: false,
      quarantine: { status: "not_requested" },
    });

    const rows = STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS.map((id, index) => (
      index === 0
        ? result
        : {
            source_id: id,
            source_eligible: true,
            status: "upgraded",
            mutation_counts: mutationResult("pointer_commit", "upgraded").mutation_counts,
          }
    ));
    expect(createStage1EvidenceSchemaUpgradeReport({
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      results: rows,
      generatedAt: finalizedAt,
    })).toMatchObject({
      status: "blocked",
      quarantined_source_count: 0,
      terminal_failure_source_count: 1,
      quarantined_work_remaining: 0,
      automated_work_clear: false,
    });
  });

  it.each([
    ["eligible_unchanged_upgrade", "would_commit", "not_planned"],
    ["material_difference_candidate", "not_planned", "would_queue"],
    ["evidence_failure_quarantine", "not_planned", "not_planned"],
  ])("runs full dry-run validation for %s without invoking mutations", async (
    decision,
    pointerStatus,
    candidateStatus,
  ) => {
    const captureAndValidate = vi.fn(async () => captureDecision(decision));
    const upgradeEvidenceSchema = vi.fn();
    const enqueueVisualReviewCandidate = vi.fn();
    const quarantineEvidenceFailure = vi.fn();
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: true,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate,
        upgradeEvidenceSchema,
        enqueueVisualReviewCandidate,
        quarantineEvidenceFailure,
      },
      now: finalizedAt,
    });

    expect(captureAndValidate).toHaveBeenCalledOnce();
    expect(captureAndValidate.mock.calls[0][0].dry_run).toBe(true);
    expect(upgradeEvidenceSchema).not.toHaveBeenCalled();
    expect(enqueueVisualReviewCandidate).not.toHaveBeenCalled();
    expect(quarantineEvidenceFailure).not.toHaveBeenCalled();
    expect(result.pointer_journal.status).toBe(pointerStatus);
    expect(result.visual_review_candidate.status).toBe(candidateStatus);
    expect(result.safety).toMatchObject({ database_writes: 0, r2_writes: 0 });
    expect(result.mutation_counts).toEqual({
      database_writes: 0,
      r2_writes: 0,
      local_baseline_writes: 0,
      candidate_writes: 0,
      quarantine_writes: 0,
      source_state_writes: 0,
    });
  });

  it("does not mislabel source eligibility as a completed dry run", async () => {
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: true,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {},
    });
    expect(result).toMatchObject({
      source_eligible: true,
      status: "implementation_blocked",
      reason_code: "missing_interfaces:captureAndValidate",
    });
  });

  it("applies only through exact zero-charge, source-bound mutation receipts", async () => {
    const enqueue = vi.fn(async () => mutationResult(
      "candidate_enqueue",
      "queued",
      { database_writes: 1, candidate_writes: 1 },
    ));
    const quarantine = vi.fn(async () => mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
    ));
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureDecision("material_difference_candidate"),
        enqueueVisualReviewCandidate: enqueue,
        quarantineEvidenceFailure: quarantine,
      },
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      context: "stage1_evidence_schema_upgrade",
      enqueue_policy: {
        context: "stage1_evidence_schema_upgrade",
        bypassRejectionLedger: true,
        queueReconciliation: false,
      },
    }));
    expect(result).toMatchObject({
      status: "candidate_queued",
      mutation_counts: { database_writes: 1, candidate_writes: 1 },
      safety: { creates_api_charge: false, public_fact_writes: 0 },
    });
    expect(result.safety).not.toHaveProperty("database_writes");
    expect(result.safety).not.toHaveProperty("r2_writes");
    expect(quarantine).not.toHaveBeenCalled();
  });

  it("reports a clean old-authority abandonment as retry-required without quarantining", async () => {
    const abandoned = mutationResult(
      "pointer_commit",
      "abandoned_old_authority",
      { r2_writes: 1, local_baseline_writes: 2 },
    );
    abandoned.receipt.journal_archived = true;
    abandoned.receipt.outcome = "abandoned_old_authority";
    const quarantine = vi.fn();
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureDecision("eligible_unchanged_upgrade"),
        upgradeEvidenceSchema: async () => abandoned,
        quarantineEvidenceFailure: quarantine,
      },
    });

    expect(quarantine).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "pointer_commit_retry_required",
      reason_code: "authoritative_snapshot_changed_retry_required",
      pointer_journal: {
        status: "abandoned_old_authority",
        receipt: {
          journal_archived: true,
          outcome: "abandoned_old_authority",
        },
      },
      visual_review_candidate: { status: "not_planned" },
      quarantine: { status: "not_requested" },
      mutation_counts: {
        r2_writes: 1,
        local_baseline_writes: 2,
      },
    });
  });

  it("rejects missing charge proof and quarantines mismatched mutation identity", async () => {
    await expect(runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: true,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => ({
          ...captureDecision("eligible_unchanged_upgrade"),
          creates_api_charge: undefined,
        }),
      },
    })).rejects.toThrow(/explicitly prove creates_api_charge=false/i);

    const captureValidation = captureDecision("material_difference_candidate");
    const wrongIdentity = mutationResult(
      "candidate_enqueue",
      "queued",
      { database_writes: 1, candidate_writes: 1 },
    );
    wrongIdentity.source_id = STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS[1];
    const quarantine = vi.fn(async () => mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
    ));
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureValidation,
        enqueueVisualReviewCandidate: async () => wrongIdentity,
        quarantineEvidenceFailure: quarantine,
      },
    });
    expect(result).toMatchObject({
      status: "evidence_failure_quarantined",
      reason_code: "candidate_enqueue_mutation_failed",
      mutation_failure: {
        operation: "candidate_enqueue",
        message: expect.stringMatching(/mutation identity/i),
      },
    });
    expect(quarantine).toHaveBeenCalledOnce();
    expect(quarantine.mock.calls[0][0].capture_validation).toBe(captureValidation);
    expect(quarantine.mock.calls[0][0].mutation_failure.error)
      .toBeInstanceOf(Error);
  });

  it.each([
    ["eligible_unchanged_upgrade", "pointer_commit", "upgradeEvidenceSchema"],
    ["material_difference_candidate", "candidate_enqueue", "enqueueVisualReviewCandidate"],
  ])("routes an exact thrown %s mutation error and prior validation to quarantine", async (
    decision,
    operation,
    interfaceName,
  ) => {
    const captureValidation = captureDecision(decision);
    const exactError = Object.assign(new Error(`${operation} exploded exactly`), {
      code: `${operation}_exact_test_failure`,
    });
    const quarantine = vi.fn(async () => mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
    ));
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureValidation,
        [interfaceName]: async () => { throw exactError; },
        quarantineEvidenceFailure: quarantine,
      },
    });

    expect(result).toMatchObject({
      status: "evidence_failure_quarantined",
      reason_code: `${operation}_mutation_failed`,
      mutation_failure: {
        operation,
        code: `${operation}_exact_test_failure`,
        message: `${operation} exploded exactly`,
      },
      mutation_counts: { database_writes: 2, quarantine_writes: 1 },
    });
    expect(quarantine).toHaveBeenCalledOnce();
    expect(quarantine.mock.calls[0][0].capture_validation).toBe(captureValidation);
    expect(quarantine.mock.calls[0][0].mutation_failure).toMatchObject({
      operation,
      error: exactError,
      mutation_accounting: {
        operation,
        exact: false,
        count_semantics: "confirmed_lower_bounds",
      },
    });
    expect(quarantine.mock.calls[0][0].mutation_failure.error).toBe(exactError);
  });

  it("rejects a combined commit-and-candidate outcome before either mutation adapter", async () => {
    const captureValidation = captureDecision("eligible_unchanged_upgrade");
    captureValidation.outcome.would_queue_visual_candidate = true;
    const upgradeEvidenceSchema = vi.fn();
    const enqueueVisualReviewCandidate = vi.fn();
    const quarantineEvidenceFailure = vi.fn();

    await expect(runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureValidation,
        upgradeEvidenceSchema,
        enqueueVisualReviewCandidate,
        quarantineEvidenceFailure,
      },
    })).rejects.toThrow(/decision and planned outcome disagree/i);
    expect(upgradeEvidenceSchema).not.toHaveBeenCalled();
    expect(enqueueVisualReviewCandidate).not.toHaveBeenCalled();
    expect(quarantineEvidenceFailure).not.toHaveBeenCalled();
  });

  it("preserves confirmed candidate writes and response-loss uncertainty across quarantine", async () => {
    const captureValidation = captureDecision("material_difference_candidate");
    const lowerBoundCounts = mutationResult(
      "candidate_enqueue",
      "queued",
      { database_writes: 1, candidate_writes: 1 },
    ).mutation_counts;
    const accounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "candidate_enqueue",
      lowerBoundCounts,
      unknownWriteCategories: ["database_writes"],
      evidence: {
        boundary: "candidate_observation_response_pending",
        candidate_signature: "candidate-signature-1",
        response_loss_possible: true,
      },
    });
    const exactError = Object.assign(new Error("observation response lost"), {
      code: "candidate_observation_response_lost",
      stage1_mutation_accounting: accounting,
    });
    const quarantine = vi.fn(async () => mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
    ));
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureValidation,
        enqueueVisualReviewCandidate: async () => { throw exactError; },
        quarantineEvidenceFailure: quarantine,
      },
    });

    expect(result).toMatchObject({
      status: "evidence_failure_quarantined",
      mutation_counts: {
        database_writes: 3,
        candidate_writes: 1,
        quarantine_writes: 1,
        source_state_writes: 1,
      },
      mutation_count_certainty: {
        exact: false,
        count_semantics: "confirmed_lower_bounds_with_unknown_writes",
        unknown_write_categories: ["database_writes"],
      },
    });
    expect(quarantine.mock.calls[0][0].mutation_failure.mutation_accounting)
      .toEqual(accounting);

    const rows = STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS.map((id, index) => (
      index === 0
        ? result
        : {
            source_id: id,
            source_eligible: true,
            status: "upgraded",
            mutation_counts: mutationResult("pointer_commit", "upgraded").mutation_counts,
          }
    ));
    expect(createStage1EvidenceSchemaUpgradeReport({
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      results: rows,
      generatedAt: finalizedAt,
    })).toMatchObject({
      mutation_counts_are_exact: false,
      mutation_count_semantics: "confirmed_lower_bounds_with_unknown_writes",
      mutation_count_uncertain_source_count: 1,
      unknown_write_categories: ["database_writes"],
      mutation_counts: {
        database_writes: 3,
        candidate_writes: 1,
        quarantine_writes: 1,
      },
    });
  });

  it("preserves an ambiguous quarantine attempt after its retry succeeds", async () => {
    const candidateAccounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "candidate_enqueue",
      lowerBoundCounts: mutationResult(
        "candidate_enqueue",
        "queued",
        { database_writes: 1, candidate_writes: 1 },
      ).mutation_counts,
      unknownWriteCategories: [],
      evidence: {
        boundary: "candidate_observation_committed",
        candidate_signature: "candidate-signature-ambiguous-quarantine",
        response_loss_possible: false,
      },
    });
    const candidateError = Object.assign(new Error("candidate observation failed"), {
      code: "candidate_observation_failed",
      stage1_mutation_accounting: candidateAccounting,
    });
    const quarantineResult = mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
    );
    const quarantineAccounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "quarantine",
      lowerBoundCounts: quarantineResult.mutation_counts,
      unknownWriteCategories: ["database_writes", "quarantine_writes", "source_state_writes"],
      evidence: {
        boundary: "quarantine_rpc_response_lost_then_retry_succeeded",
        response_loss_possible: true,
      },
    });
    quarantineResult.mutation_accounting = quarantineAccounting;
    quarantineResult.receipt.mutation_accounting = structuredClone(quarantineAccounting);

    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureDecision("material_difference_candidate"),
        enqueueVisualReviewCandidate: async () => { throw candidateError; },
        quarantineEvidenceFailure: async () => quarantineResult,
      },
    });

    expect(result).toMatchObject({
      status: "evidence_failure_quarantined",
      mutation_counts: {
        database_writes: 3,
        candidate_writes: 1,
        quarantine_writes: 1,
        source_state_writes: 1,
      },
      mutation_count_certainty: {
        exact: false,
        count_semantics: "confirmed_lower_bounds_with_unknown_writes",
        unknown_write_categories: [
          "database_writes",
          "quarantine_writes",
          "source_state_writes",
        ],
        prior_operation_accounting_sha256: candidateAccounting.accounting_sha256,
        quarantine_accounting_sha256: quarantineAccounting.accounting_sha256,
        quarantine_counts_exact: false,
      },
    });
    expect(result.mutation_accounting).toEqual(candidateAccounting);
    expect(result.quarantine_mutation_accounting).toEqual(quarantineAccounting);
  });

  it("returns a blocked terminal failure with direct quarantine response-loss accounting", async () => {
    const quarantineAccounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "quarantine",
      lowerBoundCounts: mutationResult(
        "quarantine",
        "quarantined",
        { database_writes: 1, quarantine_writes: 1 },
      ).mutation_counts,
      unknownWriteCategories: ["database_writes", "source_state_writes"],
      evidence: {
        boundary: "quarantine_source_hold_response_pending",
        response_loss_possible: true,
      },
    });
    const quarantineError = Object.assign(new Error("quarantine response lost"), {
      code: "quarantine_response_lost",
      stage1_mutation_accounting: quarantineAccounting,
    });
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureDecision("evidence_failure_quarantine"),
        quarantineEvidenceFailure: async () => { throw quarantineError; },
      },
    });

    expect(result).toMatchObject({
      status: "quarantine_failed",
      reason_code: "quarantine_mutation_failed",
      quarantine_trigger_reason_code: "evidence_failure_quarantine_test",
      quarantine: { status: "failed", receipt: null },
      mutation_failure: {
        operation: "quarantine",
        code: "quarantine_response_lost",
      },
      quarantine_failure: {
        operation: "quarantine",
        message: "quarantine response lost",
      },
      mutation_counts: {
        database_writes: 1,
        quarantine_writes: 1,
        source_state_writes: 0,
      },
      mutation_count_certainty: {
        exact: false,
        count_semantics: "confirmed_lower_bounds_with_unknown_writes",
        unknown_write_categories: ["database_writes", "source_state_writes"],
        quarantine_accounting_sha256: quarantineAccounting.accounting_sha256,
      },
    });
    expect(result.quarantine_mutation_accounting).toEqual(quarantineAccounting);

    const rows = STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS.map((id, index) => (
      index === 0
        ? result
        : {
            source_id: id,
            source_eligible: true,
            status: "upgraded",
            mutation_counts: mutationResult("pointer_commit", "upgraded").mutation_counts,
          }
    ));
    expect(createStage1EvidenceSchemaUpgradeReport({
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      results: rows,
      generatedAt: finalizedAt,
    })).toMatchObject({
      status: "blocked",
      quarantined_source_count: 0,
      terminal_failure_source_count: 1,
      quarantined_work_remaining: 0,
      mutation_counts_are_exact: false,
      unknown_write_categories: ["database_writes", "source_state_writes"],
    });
  });

  it("combines prior candidate and nested quarantine response-loss accounting", async () => {
    const candidateAccounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "candidate_enqueue",
      lowerBoundCounts: mutationResult(
        "candidate_enqueue",
        "queued",
        { database_writes: 1, candidate_writes: 1 },
      ).mutation_counts,
      unknownWriteCategories: ["database_writes"],
      evidence: {
        boundary: "candidate_observation_response_pending",
        response_loss_possible: true,
      },
    });
    const candidateError = Object.assign(new Error("candidate response lost"), {
      code: "candidate_response_lost",
      stage1_mutation_accounting: candidateAccounting,
    });
    const quarantineAccounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "quarantine",
      lowerBoundCounts: mutationResult(
        "quarantine",
        "quarantined",
        { database_writes: 1, quarantine_writes: 1 },
      ).mutation_counts,
      unknownWriteCategories: ["source_state_writes"],
      evidence: {
        boundary: "quarantine_source_hold_response_pending",
        response_loss_possible: true,
      },
    });
    const quarantineError = Object.assign(new Error("quarantine hold response lost"), {
      code: "quarantine_hold_response_lost",
      stage1_mutation_accounting: quarantineAccounting,
    });

    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureDecision("material_difference_candidate"),
        enqueueVisualReviewCandidate: async () => { throw candidateError; },
        quarantineEvidenceFailure: async () => { throw quarantineError; },
      },
    });

    expect(result).toMatchObject({
      status: "quarantine_failed",
      reason_code: "quarantine_mutation_failed",
      quarantine_trigger_reason_code: "candidate_enqueue_mutation_failed",
      visual_review_candidate: { status: "mutation_failed" },
      quarantine: { status: "failed" },
      mutation_failure: {
        operation: "candidate_enqueue",
        code: "candidate_response_lost",
      },
      quarantine_failure: {
        operation: "quarantine",
        code: "quarantine_hold_response_lost",
      },
      mutation_counts: {
        database_writes: 2,
        candidate_writes: 1,
        quarantine_writes: 1,
        source_state_writes: 0,
      },
      mutation_count_certainty: {
        exact: false,
        unknown_write_categories: ["database_writes", "source_state_writes"],
        prior_operation_accounting_sha256: candidateAccounting.accounting_sha256,
        quarantine_accounting_sha256: quarantineAccounting.accounting_sha256,
      },
    });
    expect(result.mutation_accounting).toEqual(candidateAccounting);
    expect(result.quarantine_mutation_accounting).toEqual(quarantineAccounting);
  });

  it("recovers a held source's active mutation journal before eligibility without a new capture", async () => {
    const heldSource = validFinalizedSource();
    let activeJournal = false;
    const quarantine = vi.fn(async () => {
      activeJournal = true;
      heldSource.admin_review_status = "review_later";
      heldSource.admin_review_note =
        "stage1_evidence_schema_upgrade_failed:pointer_commit_mutation_failed";
      heldSource.admin_reviewed_by = "stage1-evidence-schema-upgrade-quarantine";
      return mutationResult(
        "quarantine",
        "quarantined",
        { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
      );
    });
    const firstCapture = captureDecision("eligible_unchanged_upgrade");
    const failed = await runStage1EvidenceSchemaUpgradeSource({
      source: heldSource,
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => firstCapture,
        upgradeEvidenceSchema: async () => {
          throw Object.assign(new Error("pointer commit failed after journal persistence"), {
            code: "pointer_commit_after_journal",
          });
        },
        quarantineEvidenceFailure: quarantine,
      },
    });
    expect(failed.status).toBe("evidence_failure_quarantined");
    expect(activeJournal).toBe(true);
    expect(heldSource.admin_review_status).toBe("review_later");

    const captureAfterFailure = vi.fn();
    const preflight = vi.fn(async () => {
      expect(activeJournal).toBe(true);
      activeJournal = false;
      const result = mutationResult(
        "pointer_commit",
        "upgraded",
        { database_writes: 1, local_baseline_writes: 1, source_state_writes: 1 },
      );
      result.receipt.journal_archived = true;
      result.receipt.outcome = "candidate_authority_recovered";
      return result;
    });
    const recovered = await runStage1EvidenceSchemaUpgradeSource({
      source: heldSource,
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        preflightActiveJournal: preflight,
        captureAndValidate: captureAfterFailure,
      },
    });

    expect(preflight).toHaveBeenCalledOnce();
    expect(captureAfterFailure).not.toHaveBeenCalled();
    expect(activeJournal).toBe(false);
    expect(recovered).toMatchObject({
      source_eligible: false,
      status: "journal_recovered_quarantine_remaining",
      reason_code: "active_upgrade_journal_recovered_existing_quarantine_preserved",
      pointer_journal: {
        status: "upgraded",
        receipt: { journal_archived: true },
      },
      quarantine: { status: "existing_hold" },
      mutation_counts: {
        database_writes: 1,
        local_baseline_writes: 1,
        source_state_writes: 1,
      },
    });

    const rows = STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS.map((id, index) => (
      index === 0
        ? recovered
        : {
            source_id: id,
            source_eligible: true,
            status: "upgraded",
            mutation_counts: mutationResult("pointer_commit", "upgraded").mutation_counts,
          }
    ));
    expect(createStage1EvidenceSchemaUpgradeReport({
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      results: rows,
      generatedAt: finalizedAt,
    })).toMatchObject({
      status: "quarantined_work_remaining",
      upgraded_source_count: 8,
      quarantined_source_count: 1,
      completed_source_count: 8,
      automated_work_clear: false,
      quarantined_work_remaining: 1,
    });

    const recurrenceQuarantine = vi.fn(async ({ mutation_failure: mutationFailure }) => {
      expect(mutationFailure).toMatchObject({
        operation: "pointer_commit",
        error: { code: "active_upgrade_journal_authority_ambiguous" },
      });
      return mutationResult(
        "quarantine",
        "quarantined",
        { database_writes: 1, quarantine_writes: 1 },
      );
    });
    const ambiguous = await runStage1EvidenceSchemaUpgradeSource({
      source: heldSource,
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        preflightActiveJournal: async () => mutationResult(
          "pointer_commit",
          "recovery_required",
        ),
        captureAndValidate: captureAfterFailure,
        quarantineEvidenceFailure: recurrenceQuarantine,
      },
    });
    expect(recurrenceQuarantine).toHaveBeenCalledOnce();
    expect(ambiguous.quarantine).toMatchObject({ status: "quarantined" });
    const ambiguousRows = rows.map((row, index) => index === 0 ? ambiguous : row);
    expect(createStage1EvidenceSchemaUpgradeReport({
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      results: ambiguousRows,
      generatedAt: finalizedAt,
    })).toMatchObject({
      status: "blocked",
      quarantined_source_count: 1,
      terminal_failure_source_count: 1,
      automated_work_clear: false,
      quarantined_work_remaining: 1,
    });
  });

  it("reports an active journal read-only in dry-run and skips capture", async () => {
    const captureAndValidate = vi.fn();
    const preflightResult = mutationResult(
      "pointer_commit",
      "dry_run_recovery_required",
    );
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: true,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        preflightActiveJournal: async () => preflightResult,
        captureAndValidate,
      },
    });
    expect(captureAndValidate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "dry_run_recovery_required",
      reason_code: "active_upgrade_journal_requires_apply_recovery",
      pointer_journal: { status: "dry_run_recovery_required" },
      mutation_counts: {
        database_writes: 0,
        r2_writes: 0,
        local_baseline_writes: 0,
      },
    });
  });

  it("durably quarantines an ambiguous active journal when the source is still open", async () => {
    const captureAndValidate = vi.fn();
    const preflightResult = mutationResult(
      "pointer_commit",
      "recovery_required",
      { local_baseline_writes: 1 },
    );
    preflightResult.receipt.outcome = "ambiguous_authority";
    preflightResult.receipt.journal_sha256 = "a".repeat(64);
    const quarantine = vi.fn(async () => mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
    ));
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        preflightActiveJournal: async () => preflightResult,
        captureAndValidate,
        quarantineEvidenceFailure: quarantine,
      },
    });
    expect(captureAndValidate).not.toHaveBeenCalled();
    expect(quarantine).toHaveBeenCalledOnce();
    expect(quarantine.mock.calls[0][0].capture_validation).toMatchObject({
      decision: "evidence_failure_quarantine",
      reason: "active_upgrade_journal_authority_ambiguous",
      evidence: {
        pointer_commit_receipt: {
          journal_sha256: "a".repeat(64),
          outcome: "ambiguous_authority",
        },
      },
      outcome: { would_quarantine: true, creates_api_charge: false },
    });
    expect(result).toMatchObject({
      status: "journal_recovery_required",
      quarantine: { status: "quarantined" },
      mutation_counts: {
        database_writes: 2,
        local_baseline_writes: 1,
        quarantine_writes: 1,
        source_state_writes: 1,
      },
    });
  });

  it("reports active-journal quarantine response loss without losing recovered writes", async () => {
    const captureAndValidate = vi.fn();
    const preflightResult = mutationResult(
      "pointer_commit",
      "recovery_required",
      { local_baseline_writes: 1 },
    );
    const quarantineAccounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "quarantine",
      lowerBoundCounts: mutationResult(
        "quarantine",
        "quarantined",
        { database_writes: 1, quarantine_writes: 1 },
      ).mutation_counts,
      unknownWriteCategories: ["source_state_writes"],
      evidence: {
        boundary: "quarantine_source_hold_response_pending",
        response_loss_possible: true,
      },
    });
    const quarantineError = Object.assign(new Error("journal quarantine response lost"), {
      code: "journal_quarantine_response_lost",
      stage1_mutation_accounting: quarantineAccounting,
    });

    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        preflightActiveJournal: async () => preflightResult,
        captureAndValidate,
        quarantineEvidenceFailure: async () => { throw quarantineError; },
      },
    });

    expect(captureAndValidate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "quarantine_failed",
      quarantine_trigger_reason_code: "active_upgrade_journal_authority_ambiguous",
      pointer_journal: { status: "recovery_required" },
      quarantine: { status: "failed" },
      mutation_counts: {
        database_writes: 1,
        local_baseline_writes: 1,
        quarantine_writes: 1,
        source_state_writes: 0,
      },
      mutation_count_certainty: {
        exact: false,
        unknown_write_categories: ["source_state_writes"],
        quarantine_accounting_sha256: quarantineAccounting.accounting_sha256,
      },
      quarantine_failure: {
        operation: "quarantine",
        code: "journal_quarantine_response_lost",
      },
    });
    expect(result.mutation_accounting).toMatchObject({
      operation: "pointer_commit",
      exact: true,
      lower_bound_counts: { local_baseline_writes: 1 },
    });
  });

  it("does not treat an arbitrary review_later state as ownership when recovery is ambiguous", async () => {
    const held = validFinalizedSource();
    held.admin_review_status = "review_later";
    held.admin_review_note = "operator_hold_for_another_reason";
    held.admin_reviewed_by = "operator";
    const captureAndValidate = vi.fn();
    const quarantine = vi.fn(async () => mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
    ));
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: held,
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        preflightActiveJournal: async () => mutationResult(
          "pointer_commit",
          "recovery_required",
        ),
        captureAndValidate,
        quarantineEvidenceFailure: quarantine,
      },
    });

    expect(captureAndValidate).not.toHaveBeenCalled();
    expect(quarantine).toHaveBeenCalledOnce();
    expect(quarantine.mock.calls[0][0]).toMatchObject({
      capture_validation: {
        decision: "evidence_failure_quarantine",
        reason: "active_upgrade_journal_authority_ambiguous",
      },
      mutation_failure: {
        operation: "pointer_commit",
        error: {
          code: "active_upgrade_journal_authority_ambiguous",
        },
        mutation_accounting: {
          operation: "pointer_commit",
          exact: true,
          lower_bound_counts: mutationResult(
            "pointer_commit",
            "recovery_required",
          ).mutation_counts,
          unknown_write_categories: [],
        },
      },
    });
    expect(result).toMatchObject({
      status: "journal_recovery_required",
      quarantine: { status: "quarantined" },
      mutation_counts: {
        database_writes: 2,
        quarantine_writes: 1,
        source_state_writes: 1,
      },
    });
  });

  it("durably quarantines an open source when active-journal recovery throws", async () => {
    const captureAndValidate = vi.fn();
    const accounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "pointer_commit",
      lowerBoundCounts: mutationResult(
        "pointer_commit",
        "recovery_required",
        { local_baseline_writes: 1 },
      ).mutation_counts,
      unknownWriteCategories: ["database_writes"],
      evidence: {
        boundary: "pointer_cas_response_pending",
        journal_phase: "pointer_cas_attempted",
        response_loss_possible: true,
      },
    });
    const recoveryError = Object.assign(new Error("R2 pointer response was unavailable"), {
      code: "active_journal_pointer_unavailable",
      stage1_mutation_accounting: accounting,
    });
    const quarantine = vi.fn(async () => mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
    ));
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        preflightActiveJournal: async () => { throw recoveryError; },
        captureAndValidate,
        quarantineEvidenceFailure: quarantine,
      },
    });

    expect(captureAndValidate).not.toHaveBeenCalled();
    expect(quarantine).toHaveBeenCalledOnce();
    expect(quarantine.mock.calls[0][0]).toMatchObject({
      capture_validation: {
        decision: "evidence_failure_quarantine",
        reason: "active_upgrade_journal_recovery_failed",
        evidence: {
          source_id: sourceId,
          error: { code: "active_journal_pointer_unavailable" },
          mutation_accounting: accounting,
        },
      },
      mutation_failure: {
        operation: "pointer_commit",
        error: recoveryError,
        mutation_accounting: accounting,
      },
    });
    expect(result).toMatchObject({
      status: "evidence_failure_quarantined",
      mutation_counts: {
        database_writes: 2,
        local_baseline_writes: 1,
        quarantine_writes: 1,
        source_state_writes: 1,
      },
      mutation_count_certainty: {
        exact: false,
        unknown_write_categories: ["database_writes"],
      },
    });
  });

  it("durably quarantines an unsafe active-journal recovery result", async () => {
    const captureAndValidate = vi.fn();
    const unsafeResult = mutationResult(
      "pointer_commit",
      "upgraded",
      { database_writes: 1 },
    );
    unsafeResult.receipt.source_id = "00000000-0000-4000-8000-000000000099";
    const quarantine = vi.fn(async () => mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
    ));

    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        preflightActiveJournal: async () => unsafeResult,
        captureAndValidate,
        quarantineEvidenceFailure: quarantine,
      },
    });

    expect(captureAndValidate).not.toHaveBeenCalled();
    expect(quarantine).toHaveBeenCalledOnce();
    expect(quarantine.mock.calls[0][0]).toMatchObject({
      capture_validation: {
        decision: "evidence_failure_quarantine",
        reason: "active_upgrade_journal_recovery_failed",
        evidence: {
          source_id: sourceId,
          error: {
            message: "Stage 1 pointer_commit mutation receipt identity is invalid.",
          },
        },
      },
      mutation_failure: {
        operation: "pointer_commit",
      },
    });
    expect(result).toMatchObject({
      status: "evidence_failure_quarantined",
      reason_code: "pointer_commit_mutation_failed",
      quarantine: { status: "quarantined" },
      mutation_count_certainty: {
        exact: false,
        unknown_write_categories: [
          "database_writes",
          "local_baseline_writes",
          "r2_writes",
          "source_state_writes",
        ],
      },
    });
  });

  it.each([
    {
      label: "active-journal preflight",
      decision: "eligible_unchanged_upgrade",
      interfaceName: "preflightActiveJournal",
      operation: "pointer_commit",
      status: "upgraded",
      counts: { database_writes: 1, local_baseline_writes: 1 },
    },
    {
      label: "pointer commit",
      decision: "eligible_unchanged_upgrade",
      interfaceName: "upgradeEvidenceSchema",
      operation: "pointer_commit",
      status: "upgraded",
      counts: { database_writes: 1, local_baseline_writes: 1 },
    },
    {
      label: "candidate enqueue",
      decision: "material_difference_candidate",
      interfaceName: "enqueueVisualReviewCandidate",
      operation: "candidate_enqueue",
      status: "queued",
      counts: { database_writes: 1, candidate_writes: 1 },
    },
  ])("preserves sealed writes from a malformed $label response", async ({
    decision,
    interfaceName,
    operation,
    status,
    counts,
  }) => {
    const unsafeResult = mutationResult(operation, status, counts);
    const accounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation,
      lowerBoundCounts: unsafeResult.mutation_counts,
      unknownWriteCategories: [],
      evidence: { boundary: `${interfaceName}_response_received` },
    });
    unsafeResult.mutation_accounting = accounting;
    unsafeResult.receipt.mutation_accounting = structuredClone(accounting);
    unsafeResult.receipt.source_id = "00000000-0000-4000-8000-000000000099";

    const captureAndValidate = vi.fn(async () => captureDecision(decision));
    const quarantine = vi.fn(async () => mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
    ));
    const result = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate,
        [interfaceName]: async () => unsafeResult,
        quarantineEvidenceFailure: quarantine,
      },
    });

    if (interfaceName === "preflightActiveJournal") {
      expect(captureAndValidate).not.toHaveBeenCalled();
    } else {
      expect(captureAndValidate).toHaveBeenCalledOnce();
    }
    expect(quarantine).toHaveBeenCalledOnce();
    expect(quarantine.mock.calls[0][0].mutation_failure.mutation_accounting)
      .toEqual(accounting);
    expect(result).toMatchObject({
      status: "evidence_failure_quarantined",
      mutation_accounting: accounting,
      mutation_counts: {
        database_writes: 3,
        local_baseline_writes: counts.local_baseline_writes || 0,
        candidate_writes: counts.candidate_writes || 0,
        quarantine_writes: 1,
        source_state_writes: 1,
      },
      mutation_count_certainty: {
        exact: true,
        unknown_write_categories: [],
      },
    });
  });

  it("requires sealed matching counts and operation-specific mutation profiles", async () => {
    const mismatchedCounts = mutationResult(
      "candidate_enqueue",
      "queued",
      { database_writes: 1, candidate_writes: 1 },
    );
    mismatchedCounts.receipt.mutation_counts.database_writes = 2;
    const mismatchedQuarantine = vi.fn(async () => mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
    ));
    expect((await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureDecision("material_difference_candidate"),
        enqueueVisualReviewCandidate: async () => mismatchedCounts,
        quarantineEvidenceFailure: mismatchedQuarantine,
      },
    })).mutation_failure.message).toMatch(/outer and receipt mutation counts do not match/i);

    const candidateBaselineWrite = mutationResult(
      "candidate_enqueue",
      "queued",
      { database_writes: 1, candidate_writes: 1, local_baseline_writes: 1 },
    );
    const candidateProfileQuarantine = vi.fn(async () => mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
    ));
    expect((await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureDecision("material_difference_candidate"),
        enqueueVisualReviewCandidate: async () => candidateBaselineWrite,
        quarantineEvidenceFailure: candidateProfileQuarantine,
      },
    })).mutation_failure.message).toMatch(/candidate_enqueue contains out-of-scope mutations/i);

    const pointerQueueWrite = mutationResult(
      "pointer_commit",
      "upgraded",
      { database_writes: 1, candidate_writes: 1 },
    );
    const pointerProfileQuarantine = vi.fn(async () => mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 2, quarantine_writes: 1, source_state_writes: 1 },
    ));
    expect((await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureDecision("eligible_unchanged_upgrade"),
        upgradeEvidenceSchema: async () => pointerQueueWrite,
        quarantineEvidenceFailure: pointerProfileQuarantine,
      },
    })).mutation_failure.message).toMatch(/pointer_commit contains out-of-scope/i);

    const emptyQuarantine = mutationResult(
      "quarantine",
      "quarantined",
      { database_writes: 0, quarantine_writes: 0 },
    );
    const failedQuarantine = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: false,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureDecision("evidence_failure_quarantine"),
        quarantineEvidenceFailure: async () => emptyQuarantine,
      },
    });
    expect(failedQuarantine).toMatchObject({
      status: "quarantine_failed",
      reason_code: "quarantine_mutation_failed",
      quarantine: { status: "failed" },
      quarantine_failure: {
        operation: "quarantine",
        message: expect.stringMatching(/quarantine contains out-of-scope mutations/i),
      },
      mutation_count_certainty: {
        exact: false,
        unknown_write_categories: [
          "database_writes",
          "quarantine_writes",
          "source_state_writes",
        ],
      },
    });
  });

  it("uses the validator's exact reason and rejects conflicting legacy reason_code", async () => {
    const exactReason = await runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: true,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => captureDecision("eligible_unchanged_upgrade"),
      },
    });
    expect(exactReason.reason_code).toBe("eligible_unchanged_upgrade_test");
    expect(exactReason.capture_validation.reason).toBe("eligible_unchanged_upgrade_test");

    await expect(runStage1EvidenceSchemaUpgradeSource({
      source: validFinalizedSource(),
      manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
      dryRun: true,
      enqueuePolicy: enqueuePolicy(),
      interfaces: {
        captureAndValidate: async () => ({
          ...captureDecision("eligible_unchanged_upgrade"),
          reason_code: "different_reason",
        }),
      },
    })).rejects.toThrow(/reason and reason_code disagree/i);
  });

  it("summarizes exactly nine result identities and never labels partial work complete", () => {
    const manifest = stage1EvidenceSchemaUpgradeExpectedManifest();
    const rows = manifest.source_ids.map((id) => ({
      source_id: id,
      source_eligible: true,
      status: "dry_run_ready",
    }));
    expect(createStage1EvidenceSchemaUpgradeReport({
      manifest,
      dryRun: true,
      results: rows,
      generatedAt: finalizedAt,
    })).toMatchObject({
      status: "dry_run_complete",
      exact_source_count: 9,
      evaluated_source_count: 9,
      eligible_source_count: 9,
      blocked_source_count: 0,
      mutation_counts: { database_writes: 0, r2_writes: 0 },
    });
    expect(() => createStage1EvidenceSchemaUpgradeReport({
      manifest,
      dryRun: true,
      results: rows.slice(0, 8),
      generatedAt: finalizedAt,
    })).toThrow(/must equal the reviewed-nine set/i);

    const quarantinedRows = manifest.source_ids.map((id) => ({
      source_id: id,
      source_eligible: true,
      status: "evidence_failure_quarantined",
      mutation_counts: mutationResult(
        "quarantine",
        "quarantined",
        { database_writes: 1, quarantine_writes: 1 },
      ).mutation_counts,
    }));
    expect(createStage1EvidenceSchemaUpgradeReport({
      manifest,
      dryRun: false,
      results: quarantinedRows,
      generatedAt: finalizedAt,
    })).toMatchObject({
      status: "quarantined_work_remaining",
      upgraded_source_count: 0,
      candidate_source_count: 0,
      quarantined_source_count: 9,
      completed_source_count: 0,
      blocked_source_count: 0,
      terminal_failure_source_count: 0,
      automated_work_clear: false,
      quarantined_work_remaining: 9,
    });
  });
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}
