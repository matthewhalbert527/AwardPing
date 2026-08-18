import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STAGE1_BASELINE_ACTIVATION_BATCH_ID,
  stage1BaselineActivationGuardSha256,
  stage1BaselineActivationTextSha256,
} from "./stage1-baseline-activation-guard.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
} from "./stage1-evidence-schema-upgrade-commit.mjs";
import {
  r2CaptureArtifactBindingsSchema,
} from "./r2-capture-artifact-bindings.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA,
  stage1EvidenceSchemaUpgradeR2BindingReceiptSha256,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMPLETED_AUTHORITY_AUDIT_INSPECTION_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_COMPLETION_AUTHORITY_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RESULT_IDENTITY_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority,
  stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs";
import {
  stage1EvidenceSchemaUpgradeReviewedApplyTransactionId,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-execution.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
} from "./stage1-evidence-schema-upgrade.mjs";
import {
  advanceStage1EvidenceSchemaUpgradeJournal,
  buildStage1EvidenceSchemaUpgradeJournal,
  buildStage1EvidenceSchemaUpgradePrecommitSourceAuthority,
  buildStage1EvidenceSchemaUpgradeReviewedOperationBinding,
  proveStage1EvidenceSchemaUpgradeArchivedCompletion,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMPLETED_AUTHORITY_PROVENANCE_SCHEMA,
  assertStage1EvidenceSchemaUpgradeCompletedAuthorityReceipt,
  evaluateStage1EvidenceSchemaUpgradeCompletedAuthority,
} from "./stage1-evidence-schema-upgrade-completed-authority.mjs";

const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const awardId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const acquisitionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const reportAttemptId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const executionNonce = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const recoveryTransactionId = "99999999-9999-4999-8999-999999999999";
const finalUrl = "https://example.test/award/details";
const capturedAt = "2026-08-15T10:00:10.000Z";
const recordedAt = "2026-08-15T10:00:30.000Z";
const auditStartedAt = "2026-08-15T10:00:00.000Z";
const auditFinishedAt = "2026-08-15T10:01:00.000Z";
const finalizedAt = "2026-08-15T09:00:00.000000Z";
const planFileSha256 = sha256("reviewed plan file");
const planSha256 = sha256("reviewed plan self");
const manifestSha256 = sha256("stage1 manifest");
const retainedText =
  "Applicants must submit the reviewed scholarship materials before the official deadline.";

describe("Stage 1 completed-authority proof", () => {
  it("falls through only when every retained provenance location is absent", () => {
    const result = evaluateStage1EvidenceSchemaUpgradeCompletedAuthority({
      activeJournal: { deliberately: "ignored_without_a_provenance_hint" },
    });

    expect(result).toEqual({
      applies: false,
      accepted: false,
      reason: "completed_authority_provenance_absent",
      creates_api_charge: false,
      capture_permitted: false,
      capture_performed: false,
      mutation_permitted: false,
      mutation_performed: false,
      public_fact_authority: false,
      outcome: {
        would_commit: false,
        would_queue_visual_candidate: false,
        would_quarantine: false,
      },
      evidence: null,
      receipt: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("accepts one generic main-content authority without recapturing or mutating", () => {
    const fixture = completedFixture({ semanticScope: "main_content_only" });
    const result = evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input);

    expect(result).toMatchObject({
      applies: true,
      accepted: true,
      reason: "already_upgraded_completed_authority_verified",
      creates_api_charge: false,
      capture_permitted: false,
      capture_performed: false,
      mutation_permitted: false,
      mutation_performed: false,
      public_fact_authority: false,
      outcome: {
        would_commit: false,
        would_queue_visual_candidate: false,
        would_quarantine: false,
      },
      evidence: {
        source_id: sourceId,
        transaction_id: fixture.transactionId,
        kind: "webpage",
        semantic_scope: "main_content_only",
        completed_authority_verified: true,
      },
      receipt: {
        status: "verified",
        semantic_scope: "main_content_only",
        authority: {
          validation_only: true,
          capture: false,
          mutation: false,
        },
      },
    });
    expect(assertStage1EvidenceSchemaUpgradeCompletedAuthorityReceipt(result.receipt))
      .toEqual(result.receipt);
    expect(Object.isFrozen(result.receipt)).toBe(true);
  });

  it("accepts generic full-normalized webpage and production-shaped exact PDF authority", () => {
    const full = evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(
      completedFixture({ semanticScope: "full_normalized_text" }).input,
    );
    const pdfFixture = completedFixture({ kind: "pdf" });
    const pdf = evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(pdfFixture.input);

    expect(full).toMatchObject({
      accepted: true,
      receipt: { semantic_scope: "full_normalized_text", kind: "webpage" },
    });
    expect(pdf).toMatchObject({
      accepted: true,
      receipt: {
        semantic_scope: "pdf_exact_file_and_sealed_text",
        kind: "pdf",
      },
    });
    const pdfFileHash = pdfFixture.input.currentCapture.file_hash;
    expect(pdfFixture.input.currentCapture.image_hash).toBe(pdfFileHash);
    expect(pdfFixture.input.currentBaseline.image_hash).toBe(pdfFileHash);
    expect(pdfFixture.input.currentR2Pointer.latest_hashes.image_hash).toBe(pdfFileHash);
    expect(JSON.parse(
      pdfFixture.input.currentPreparedArtifacts.artifacts
        .find((artifact) => artifact.name === "meta").body.toString("utf8"),
    ).image_hash).toBe(pdfFileHash);
    expect(
      pdfFixture.input.currentBaseline.summary_metadata.stage1_evidence_schema_upgrade
        .validation.evidence.capture.image_hash,
    ).toBeNull();
  });

  it.each([
    ["the current PDF file-hash alias", (validation) => {
      validation.evidence.capture.image_hash = validation.evidence.capture.file_hash;
    }],
    ["an unrelated hash", (validation) => {
      validation.evidence.capture.image_hash = sha256("wrong historical PDF image hash");
    }],
  ])("rejects a PDF historical capture summary with non-null image_hash: %s", (_label, mutate) => {
    const fixture = completedFixture({ kind: "pdf", validationMutator: mutate });

    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_prior_capture_identity_mismatch",
      });
  });

  it("keeps the PDF historical capture summary file_hash exact", () => {
    const fixture = completedFixture({
      kind: "pdf",
      validationMutator(validation) {
        validation.evidence.capture.file_hash = sha256("wrong historical PDF file hash");
      },
    });

    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_prior_capture_identity_mismatch",
      });
  });

  it("rejects a coherently drifted current PDF image_hash alias", () => {
    const fixture = completedFixture({
      kind: "pdf",
      currentPdfImageHash: sha256("wrong current PDF image alias"),
    });

    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_current_baseline_capture_mismatch",
      });
  });

  it("accepts reviewed-recovery completion and derives its transaction from authority", () => {
    const fixture = completedFixture({ completionMode: "reviewed_recovery" });
    const result = evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input);

    expect(fixture.transactionId).toBe(recoveryTransactionId);
    expect(result).toMatchObject({
      accepted: true,
      evidence: { transaction_id: recoveryTransactionId },
      receipt: { transaction_id: recoveryTransactionId },
    });
  });

  it("requires exact candidate-health even when the commit reported already_current", () => {
    const exact = evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(
      completedFixture({ sourceHealthStatus: "already_current" }).input,
    );
    expect(exact).toMatchObject({ accepted: true });

    const stale = evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(
      completedFixture({
        sourceHealthStatus: "already_current",
        currentSourceHealth: false,
      }).input,
    );
    expect(stale).toMatchObject({
      accepted: false,
      reason: "completed_authority_source_health_not_exact_terminal_authority",
    });
  });

  it("fails closed on any provenance hint, active journal, or provenance parity/seal defect", () => {
    const hintOnly = evaluateStage1EvidenceSchemaUpgradeCompletedAuthority({
      currentBaseline: {
        summary_metadata: { stage1_evidence_schema_upgrade: {} },
      },
    });
    expect(hintOnly).toMatchObject({ applies: true, accepted: false });

    const active = completedFixture();
    active.input.activeJournal = { phase: "prepared" };
    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(active.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_active_journal_present",
      });

    const parity = completedFixture();
    parity.input.currentCapture.stage1_evidence_schema_upgrade.recorded_at =
      "2026-08-15T10:00:31.000Z";
    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(parity.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_capture_provenance_mismatch",
      });

    const invalidSeal = completedFixture({
      provenanceMutator(provenance) {
        provenance.validation.evidence.reviewed_final_url =
          "https://example.test/coherently-retained-but-unsealed";
      },
    });
    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(invalidSeal.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_validation_sha256_mismatch",
      });
  });

  it("rejects a coherently resealed current R2 role drift", () => {
    const fixture = completedFixture();
    const receipt = clone(fixture.input.verifiedR2BindingReceipt);
    receipt.verified_roles[0].sha256 = sha256("different remote bytes");
    receipt.receipt_sha256 = stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(receipt);
    fixture.input.verifiedR2BindingReceipt = receipt;

    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_current_r2_verified_role_binding_mismatch",
      });
  });

  it("accepts the exact writer-framed capture text returned by retained-baseline reads", () => {
    const fixture = completedFixture();
    fixture.input.currentCapture.text += "\n";

    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: true,
        reason: "already_upgraded_completed_authority_verified",
      });
  });

  it("rejects a current R2 receipt that counts writer framing as semantic text", () => {
    const fixture = completedFixture();
    fixture.input.currentCapture.text += "\n";
    const receipt = clone(fixture.input.verifiedR2BindingReceipt);
    receipt.semantic_text.character_length = fixture.input.currentCapture.text.length;
    receipt.receipt_sha256 = stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(receipt);
    fixture.input.verifiedR2BindingReceipt = receipt;

    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_current_r2_semantic_text_mismatch",
      });
  });

  it("rejects capture text that is neither exact semantic nor exact writer-framed text", () => {
    const fixture = completedFixture();
    fixture.input.currentCapture.text += "\n\n";

    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_current_r2_semantic_text_mismatch",
      });
  });

  it("rejects a resealed current R2 receipt with a drifted decoded semantic SHA", () => {
    const fixture = completedFixture();
    const receipt = clone(fixture.input.verifiedR2BindingReceipt);
    receipt.semantic_text.sha256 = sha256("drifted decoded semantic text");
    receipt.receipt_sha256 = stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(receipt);
    fixture.input.verifiedR2BindingReceipt = receipt;

    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_current_r2_semantic_text_mismatch",
      });
  });

  it("rejects coherently resealed and body-bound current R2 text without writer framing", () => {
    const fixture = completedFixture();
    replaceCurrentPreparedArtifactBody(
      fixture,
      "text",
      Buffer.from(fixture.input.currentCapture.text, "utf8"),
    );
    fixture.input.verifiedR2BindingReceipt.semantic_text.object_byte_length =
      Buffer.byteLength(fixture.input.currentCapture.text, "utf8");
    fixture.input.verifiedR2BindingReceipt.semantic_text.writer_framing = "none";
    resealCurrentR2Receipt(fixture);

    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_current_r2_semantic_text_framing_invalid",
      });
  });

  it("rejects coherently resealed and body-bound current R2 text with double framing", () => {
    const fixture = completedFixture();
    const body = Buffer.from(`${fixture.input.currentCapture.text}\n\n`, "utf8");
    replaceCurrentPreparedArtifactBody(fixture, "text", body);
    fixture.input.verifiedR2BindingReceipt.semantic_text.object_byte_length = body.byteLength;
    resealCurrentR2Receipt(fixture);

    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_current_r2_semantic_text_framing_invalid",
      });
  });

  it("rejects coherently drifted candidate and receipt semantic-length claims", () => {
    const fixture = completedFixture();
    const driftedLength = fixture.input.currentCapture.text_length + 1;
    const provenance = fixture.input.currentBaseline.summary_metadata
      .stage1_evidence_schema_upgrade;
    const textComparison = provenance.validation.evidence.comparison.semantic_fields.text_hash;
    textComparison.previous_length = driftedLength;
    textComparison.current_length = driftedLength;
    provenance.validation_sha256 = sha256Json(provenance.validation);

    fixture.input.currentCapture.text_length = driftedLength;
    fixture.input.currentCapture.stage1_evidence_schema_upgrade = clone(provenance);
    fixture.input.currentBaseline.text_length = driftedLength;
    fixture.input.currentBaselineBytes = Buffer.from(
      `${JSON.stringify(fixture.input.currentBaseline, null, 2)}\n`,
      "utf8",
    );
    fixture.input.currentR2Pointer.latest_metadata.text_length = driftedLength;
    fixture.input.currentR2Pointer.latest_metadata.stage1_evidence_schema_upgrade =
      clone(provenance);

    const metadata = JSON.parse(
      fixture.input.currentPreparedArtifacts.artifacts
        .find((artifact) => artifact.name === "meta").body.toString("utf8"),
    );
    metadata.text_length = driftedLength;
    metadata.stage1_evidence_schema_upgrade = clone(provenance);
    replaceCurrentPreparedArtifactBody(
      fixture,
      "meta",
      Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    );
    fixture.input.verifiedR2BindingReceipt.semantic_text.character_length = driftedLength;
    resealCurrentR2Receipt(fixture);

    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_current_r2_semantic_text_mismatch",
      });
  });

  it("rejects a validly resealed audit that no longer matches the journal operation", () => {
    const fixture = completedFixture();
    const audit = clone(fixture.input.terminalAuditInspection);
    audit.execution_nonce = "12121212-1212-4121-8121-121212121212";
    fixture.input.terminalAuditInspection = reseal(audit, "inspection_sha256");

    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_audit_operation_binding_mismatch",
      });
  });

  it("rejects a self-consistent audit terminal journal identity that is not the archive", () => {
    const fixture = completedFixture();
    const audit = clone(fixture.input.terminalAuditInspection);
    const wrongJournalSha256 = sha256("another completed journal");
    audit.terminal_result_identity.commit_journal_sha256 = wrongJournalSha256;
    audit.terminal_result_identity = reseal(
      audit.terminal_result_identity,
      "identity_sha256",
    );
    audit.terminal_identity_sha256 = audit.terminal_result_identity.identity_sha256;
    audit.terminal_commit_journal_sha256 = wrongJournalSha256;
    fixture.input.terminalAuditInspection = reseal(audit, "inspection_sha256");

    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_journal_terminal_identity_mismatch",
      });
  });

  it("derives a fresh transaction instead of accepting a caller-selected journal ID", () => {
    const fixture = completedFixture({ transactionOverride: recoveryTransactionId });
    expect(fixture.transactionId).toBe(recoveryTransactionId);
    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(fixture.input))
      .toMatchObject({
        applies: true,
        accepted: false,
        reason: "completed_authority_journal_terminal_identity_mismatch",
      });
  });

  it("requires the exact archived proof, live acquisition, and source-health transition", () => {
    const proof = completedFixture();
    proof.input.completedJournalArchiveProof.proof_sha256 = sha256("wrong proof");
    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(proof.input))
      .toMatchObject({
        accepted: false,
        reason: "completed_authority_archive_proof_mismatch",
      });

    const acquisition = completedFixture();
    acquisition.input.source.source_acquisition.review_seal.capture_final_url =
      "https://example.test/other";
    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(acquisition.input))
      .toMatchObject({
        accepted: false,
        reason: "completed_authority_live_acquisition_guard_invalid",
      });

    const health = completedFixture();
    health.input.sourceHealth.last_hash = "visual:unexpected";
    health.input.source.last_hash = "visual:unexpected";
    expect(evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(health.input))
      .toMatchObject({
        accepted: false,
        reason: "completed_authority_source_health_not_exact_terminal_authority",
      });
  });

  it("rejects receipt tampering and authority expansion", () => {
    const result = evaluateStage1EvidenceSchemaUpgradeCompletedAuthority(
      completedFixture().input,
    );
    const tampered = clone(result.receipt);
    tampered.authority.capture = true;
    tampered.receipt_sha256 = reseal(tampered, "receipt_sha256").receipt_sha256;

    expect(() => assertStage1EvidenceSchemaUpgradeCompletedAuthorityReceipt(tampered))
      .toThrow(/safety contract/iu);
  });
});

function completedFixture({
  kind = "webpage",
  semanticScope = "main_content_only",
  completionMode = "fresh_reviewed_apply",
  transactionOverride = null,
  provenanceMutator = null,
  validationMutator = null,
  currentPdfImageHash = undefined,
  sourceHealthStatus = "succeeded",
  currentSourceHealth = true,
} = {}) {
  const isPdf = kind === "pdf";
  const browserText = isPdf || semanticScope === "full_normalized_text"
    ? retainedText
    : `Navigation chrome ${retainedText} Expanded help Footer`;
  const normalizedTextSha256 = stage1BaselineActivationTextSha256(retainedText);
  const textHash = sha256(browserText);
  const pdfBody = Buffer.from("reviewed official PDF bytes", "utf8");
  const pageBody = Buffer.from("stable primary screenshot", "utf8");
  const captureFileSha256 = isPdf ? sha256(pdfBody) : sha256("intake capture file");
  const acquisition = acquisitionFixture({
    normalizedTextSha256,
    captureFileSha256,
  });
  const activation = activationFixture({
    acquisition,
    normalizedTextSha256,
    captureFileSha256,
  });
  const finalization = finalizationFixture({ acquisition, normalizedTextSha256 });
  const capture = captureFixture({
    kind,
    browserText,
    textHash,
    normalizedTextSha256,
    captureFileSha256,
    pageBody,
    activation,
    currentPdfImageHash,
  });
  const historicalReceipt = historicalR2Receipt({
    kind,
    textHash,
    captureFileSha256,
  });
  const validation = validationFixture({
    kind,
    semanticScope,
    capture,
    acquisition,
    normalizedTextSha256,
    historicalReceipt,
  });
  if (typeof validationMutator === "function") validationMutator(validation);
  const auditRunId = stage1EvidenceSchemaUpgradeReviewedApplyAuditRunId(
    planFileSha256,
  );
  const provenance = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMPLETED_AUTHORITY_PROVENANCE_SCHEMA,
    source_id: sourceId,
    recorded_at: recordedAt,
    worker_run_id: auditRunId,
    manifest_sha256: manifestSha256,
    validation_sha256: sha256Json(validation),
    validation,
    existing_r2_binding_receipt: historicalReceipt,
    prior_recovery_receipt: null,
    creates_api_charge: false,
    public_fact_authority: false,
  };
  if (typeof provenanceMutator === "function") provenanceMutator(provenance);
  capture.stage1_evidence_schema_upgrade = clone(provenance);

  const meta = metaFixture({ capture, activation, provenance });
  const prepared = preparedFixture({ kind, capture, meta, pdfBody, pageBody });
  const pointer = pointerFixture({ capture, activation, provenance, prepared });
  const currentR2Receipt = currentR2ReceiptFixture({ capture, pointer, prepared });
  const baseline = baselineFixture({ capture, activation, provenance });
  const baselineBytes = Buffer.from(`${JSON.stringify(baseline, null, 2)}\n`, "utf8");

  const precommitHealth = sourceHealthProjection({
    capture,
    current: false,
    finalization,
  });
  const currentHealth = sourceHealthProjection({
    capture,
    current: currentSourceHealth,
    finalization,
  });
  const completionAuthority = completionMode === "reviewed_recovery"
    ? recoveryCompletionAuthority()
    : stage1EvidenceSchemaUpgradeReviewedApplyAuditFreshCompletionAuthority();
  const derivedTransactionId = completionMode === "reviewed_recovery"
    ? recoveryTransactionId
    : stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({ sourceId, planSha256 });
  const transactionId = transactionOverride || derivedTransactionId;
  const operationBinding = buildStage1EvidenceSchemaUpgradeReviewedOperationBinding({
    sourceId,
    transactionId,
    reviewedApplyPlanFileSha256: planFileSha256,
    reviewedApplyPlanSha256: planSha256,
    auditRunId,
    executionNonce,
    reviewedReportAttemptId: reportAttemptId,
    freshCaptureSha256: sha256("fresh capture evidence"),
    freshCaptureResultSha256: sha256("fresh capture result"),
    freshCaptureValidationSha256: sha256("fresh capture validation"),
    freshValidationProjectionSha256: sha256("fresh validation projection"),
    precommitAuthorityReceiptSha256: sha256("precommit authority receipt"),
    precommitSourceAuthority: buildStage1EvidenceSchemaUpgradePrecommitSourceAuthority({
      sourceId,
      sourceProjection: precommitHealth,
    }),
  });
  let journal = buildStage1EvidenceSchemaUpgradeJournal({
    transactionId,
    sourceId,
    oldBaselineBytes: null,
    oldPointer: null,
    candidateBaselineBytes: baselineBytes,
    candidatePointer: pointer,
    operationBinding,
    createdAt: "2026-08-15T10:00:40.000Z",
  });
  for (const [nextPhase, at] of [
    ["local_candidate_written", "2026-08-15T10:00:41.000Z"],
    ["pointer_cas_attempted", "2026-08-15T10:00:42.000Z"],
    ["pointer_candidate_committed", "2026-08-15T10:00:43.000Z"],
  ]) {
    journal = advanceStage1EvidenceSchemaUpgradeJournal(journal, {
      expectedPhase: journal.phase,
      nextPhase,
      at,
    });
  }
  journal = advanceStage1EvidenceSchemaUpgradeJournal(journal, {
    expectedPhase: journal.phase,
    nextPhase: "completed",
    at: "2026-08-15T10:00:44.000Z",
    detail: {
      outcome: "committed_candidate",
      authoritative_pointer_sha256: journal.candidate_pointer_identity.canonical_sha256,
      authoritative_baseline_sha256: journal.candidate_baseline.sha256,
      source_health_status: sourceHealthStatus,
      cleanup_debt_delete_performed: false,
    },
  });
  const archiveProof = proveStage1EvidenceSchemaUpgradeArchivedCompletion({
    journal,
    expectedJournalSha256: journal.journal_sha256,
    expectedTransactionId: transactionId,
    expectedOperationBinding: operationBinding,
    currentBaselineBytes: baselineBytes,
    currentPointer: pointer,
  });
  const auditInspection = auditInspectionFixture({
    operationBinding,
    journal,
    completionAuthority,
  });
  const source = {
    ...clone(currentHealth),
    source_acquisition: acquisition,
    source_activation_finalization: finalization,
  };
  return {
    transactionId,
    input: {
      sourceId,
      expectedManifestSha256: manifestSha256,
      source,
      currentBaselineBytes: baselineBytes,
      currentBaseline: clone(baseline),
      currentCapture: clone(capture),
      currentPreparedArtifacts: prepared,
      currentR2Pointer: clone(pointer),
      verifiedR2BindingReceipt: currentR2Receipt,
      terminalAuditInspection: auditInspection,
      completedJournal: journal,
      completedJournalArchiveProof: clone(archiveProof),
      sourceHealth: clone(currentHealth),
      activeJournal: null,
    },
  };
}

function acquisitionFixture({ normalizedTextSha256, captureFileSha256 }) {
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
      page_type: "overview",
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
      reviewed_roles: ["eligibility"],
    },
    activation_guard: {
      mode: "first_visual_baseline_exact_normalized_retained_text",
      onboarding_batch_id: STAGE1_BASELINE_ACTIVATION_BATCH_ID,
      notification_mode: "baseline_only",
      source_page_request_id: requestId,
      shared_award_source_id: sourceId,
      shared_award_source_acquisition_id: acquisitionId,
      evidence_packet_sha256: sha256("evidence packet"),
      decision_item_sha256: sha256("decision item"),
      normalized_retained_text_sha256: normalizedTextSha256,
      retained_text_artifact: {
        store_id: "awardping-r2-production",
        bucket: "awardping-snapshots",
        key:
          `source-intake-first-observation/v1/requests/${requestId}/sha256/` +
          `${captureFileSha256}/text.txt`,
        sha256: sha256(`${retainedText}\n`),
        bytes: Buffer.byteLength(`${retainedText}\n`, "utf8"),
        r2_verified_at: "2026-08-14T09:00:00.000Z",
      },
      capture_file_sha256: captureFileSha256,
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
      capture_file_hash: captureFileSha256,
      capture_final_url: finalUrl,
      human_source_disposition: disposition,
    },
  };
}

function activationFixture({ acquisition, normalizedTextSha256, captureFileSha256 }) {
  const disposition = acquisition.review_seal.human_source_disposition;
  const guard = disposition.activation_guard;
  return {
    schema_version: "awardping.stage1.first-visual-baseline-activation-verification.v1",
    status: "server_prepare_recorded",
    verified_at: "2026-08-14T09:00:00.000Z",
    mode: guard.mode,
    text_normalization: "source-intake-collapsed-whitespace-v1",
    onboarding_batch_id: STAGE1_BASELINE_ACTIVATION_BATCH_ID,
    shared_award_source_id: sourceId,
    source_acquisition_id: acquisitionId,
    source_page_request_id: requestId,
    disposition_schema_version: disposition.schema_version,
    disposition_decision: disposition.decision,
    expected_normalized_text_sha256: normalizedTextSha256,
    observed_normalized_text_sha256: normalizedTextSha256,
    comparison_capture_method: "fetch_html",
    evidence_packet_sha256: guard.evidence_packet_sha256,
    decision_item_sha256: guard.decision_item_sha256,
    retained_text_artifact: clone(guard.retained_text_artifact),
    capture_file_sha256: captureFileSha256,
    reviewed_final_url: finalUrl,
    observed_final_url: `${finalUrl}/`,
    comparison_final_url: finalUrl,
    visual_evidence_quote_count: 1,
    visual_evidence_quotes_verified: true,
    retained_evidence_quotes_verified: true,
    guard_sha256: disposition.guard_sha256,
    authority: clone(disposition.authority),
    server_prepare_receipt: {
      allowed: true,
      prepare_receipt_sha256: sha256("prepare receipt"),
    },
  };
}

function finalizationFixture({ acquisition, normalizedTextSha256 }) {
  const guard = acquisition.review_seal.human_source_disposition.activation_guard;
  const disposition = acquisition.review_seal.human_source_disposition;
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
    decision_item_sha256: guard.decision_item_sha256,
    prepare_receipt_sha256: sha256("prepare receipt"),
    guard_sha256: disposition.guard_sha256,
    observed_normalized_text_sha256: normalizedTextSha256,
    persistence_evidence_sha256: sha256Json(persistenceEvidence),
    finalized_at: finalizedAt,
    public_fact_authority: false,
    creates_api_charge: false,
  };
  return {
    source_acquisition_id: acquisitionId,
    shared_award_source_id: sourceId,
    source_page_request_id: requestId,
    disposition_item_sha256: guard.decision_item_sha256,
    prepare_receipt_sha256: receipt.prepare_receipt_sha256,
    guard_sha256: disposition.guard_sha256,
    observed_normalized_text_sha256: normalizedTextSha256,
    persistence_evidence: persistenceEvidence,
    finalization_receipt_sha256: sha256Json(receipt),
    receipt,
    finalized_at: finalizedAt,
  };
}

function captureFixture({
  kind,
  browserText,
  textHash,
  normalizedTextSha256,
  captureFileSha256,
  pageBody,
  activation,
  currentPdfImageHash,
}) {
  const isPdf = kind === "pdf";
  return {
    version: 2,
    kind,
    source: { id: sourceId, shared_award_id: awardId },
    captured_at: capturedAt,
    final_url: `${finalUrl}/`,
    text: browserText,
    text_hash: textHash,
    text_length: browserText.length,
    body_text_hash: isPdf ? null : sha256("body semantic"),
    body_text_length: isPdf ? 0 : 20,
    main_content_hash: isPdf ? null : normalizedTextSha256,
    main_content_text_length: isPdf ? 0 : retainedText.length,
    nav_header_footer_hash: isPdf ? null : sha256("navigation semantic"),
    nav_header_footer_text_length: isPdf ? 0 : 18,
    expansion_hash: isPdf ? null : sha256("expansion semantic"),
    expansion_text_length: 0,
    expandable_sections_hash: isPdf ? null : sha256("empty sections"),
    image_hash: isPdf
      ? currentPdfImageHash === undefined
        ? captureFileSha256
        : currentPdfImageHash
      : sha256(pageBody),
    layout_hash: null,
    file_hash: isPdf ? captureFileSha256 : null,
    file_bytes: isPdf ? Buffer.byteLength("reviewed official PDF bytes") : null,
    stage1_baseline_activation: clone(activation),
  };
}

function validationFixture({
  kind,
  semanticScope,
  capture,
  acquisition,
  normalizedTextSha256,
  historicalReceipt,
}) {
  const isPdf = kind === "pdf";
  const artifactSlots = isPdf ? ["meta", "pdf", "text"] : ["meta", "page", "text", "thumb"];
  const existing = {
    captured_at: "2026-08-14T10:00:00.000Z",
    final_url: finalUrl,
    text_hash: capture.text_hash,
    image_hash: isPdf ? null : capture.image_hash,
    file_hash: capture.file_hash,
    layout_hash: capture.layout_hash,
    retained_expansion_state_count: 0,
    expansion_coverage_status: isPdf ? null : "verified_complete",
    artifact_slots: artifactSlots,
    raw_metadata_verified: true,
    legacy_limitations: [],
    legacy_geometry_bridges: [],
    legacy_semantic_identity_bridges: [],
  };
  const captureSummary = {
    ...clone(existing),
    captured_at: capture.captured_at,
    final_url: capture.final_url,
  };
  const semanticFields = Object.fromEntries(
    (isPdf
      ? [["text_hash", "text_length"]]
      : [
          ["text_hash", "text_length"],
          ["body_text_hash", "body_text_length"],
          ["main_content_hash", "main_content_text_length"],
          ["nav_header_footer_hash", "nav_header_footer_text_length"],
          ["expansion_hash", "expansion_text_length"],
          ["expandable_sections_hash", null],
        ]).map(([hashField, lengthField]) => [hashField, {
      previous: capture[hashField],
      current: capture[hashField],
      matches: true,
      ...(lengthField
        ? {
            previous_length: capture[lengthField],
            current_length: capture[lengthField],
          }
        : {}),
    }]),
  );
  const intake = isPdf
    ? {
        status: "not_applicable_pdf",
        capture_visual_quotes: {
          ok: true,
          quote_count: 1,
          missing_count: 0,
          missing_indexes: [],
        },
      }
    : webIntakeFixture({ semanticScope, capture, acquisition, normalizedTextSha256 });
  return {
    decision: "eligible_unchanged_upgrade",
    reason: "exact_semantic_and_primary_visual_identity_verified",
    reasons: [],
    evidence: {
      source_id: sourceId,
      kind,
      reviewed_final_url: finalUrl,
      immutable_acquisition: {
        file_hash:
          acquisition.review_seal.human_source_disposition.activation_guard.capture_file_sha256,
        text_hash: isPdf ? capture.text_hash : null,
        normalized_text_hash: normalizedTextSha256,
        evidence_quote_count: 1,
        guard_sha256:
          acquisition.review_seal.human_source_disposition.guard_sha256,
      },
      existing,
      capture: captureSummary,
      intake,
      comparison: {
        semantic_fields: semanticFields,
        primary_visual_identity: {
          field: isPdf ? "file_hash" : "image_hash",
          previous: isPdf ? capture.file_hash : capture.image_hash,
          current: isPdf ? capture.file_hash : capture.image_hash,
          matches: true,
          equivalence_basis: "exact_hash",
        },
      },
      pdf_text_recovery: null,
      local_baseline_identity: {
        sha256: sha256("historical local baseline"),
        byte_length: 100,
      },
      existing_pointer_identity: {
        schema_version: "awardping.visual-snapshot.pointer-identity.v1",
        exists: true,
        canonical_sha256: sha256("historical pointer"),
      },
      authoritative_existing_r2_binding: clone(historicalReceipt),
      prior_recovery: null,
    },
  };
}

function webIntakeFixture({ semanticScope, capture, acquisition, normalizedTextSha256 }) {
  const full = semanticScope === "full_normalized_text";
  const quoteStatus = {
    ok: true,
    quote_count: 1,
    missing_count: 0,
    missing_indexes: [],
  };
  const disposition = acquisition.review_seal.human_source_disposition;
  const guard = disposition.activation_guard;
  return {
    pre_normalized_text_hash: normalizedTextSha256,
    post_normalized_text_hash: normalizedTextSha256,
    capture_normalized_text_hash: stage1BaselineActivationTextSha256(capture.text),
    capture_matches_stable_intake: full,
    capture_matches_stable_intake_basis: full
      ? "exact_full_normalized_text_hash"
      : "exact_source_bound_main_content_hash_bridge",
    capture_main_content_matches_stable_intake: full ? null : true,
    semantic_scope_bridge: full
      ? null
      : {
          schema: "example.generic.reviewed-main-content-bridge.v1",
          source_id: sourceId,
          kind: "webpage",
          reviewed_source_page_type: "overview",
          reviewed_source_roles: ["eligibility"],
          reviewed_final_url: finalUrl,
          immutable_generation: "1".repeat(32),
          legacy_capture_timestamp: "2026-08-14T10:00:00.000Z",
          source_acquisition_id: acquisitionId,
          source_page_request_id: requestId,
          sealed_acquisition_file_sha256: guard.capture_file_sha256,
          sealed_acquisition_guard_sha256: disposition.guard_sha256,
          comparison_scope: "main_content_only",
          immutable_acquisition_normalized_text_sha256: normalizedTextSha256,
          legacy_main_content_sha256: normalizedTextSha256,
          prospective_main_content_sha256: normalizedTextSha256,
          legacy_full_browser_text_sha256: capture.text_hash,
          legacy_full_browser_normalized_text_sha256:
            stage1BaselineActivationTextSha256(capture.text),
          geometry_authority: "generic_fixture",
          legacy_geometry_bridge_roles: [],
          current_geometry_verified_roles: [],
          limitations: [
            "full_browser_text_mismatch_is_preserved_and_explicit_not_treated_as_equality",
          ],
        },
    limitations: full
      ? []
      : [
          "full_browser_text_mismatch_is_preserved_and_explicit_not_treated_as_equality",
        ],
    immutable_normalized_text_hash: normalizedTextSha256,
    matches_immutable_acquisition: true,
    final_url: finalUrl,
    evidence_quotes_verified: true,
    pre_intake_quotes: clone(quoteStatus),
    post_intake_quotes: clone(quoteStatus),
    capture_visual_quotes: clone(quoteStatus),
  };
}

function historicalR2Receipt({ kind, textHash, captureFileSha256 }) {
  const captured = "2026-08-14T10:00:00.000Z";
  const pointerContent = {
    shared_award_source_id: sourceId,
    kind,
    bucket: "awardping-snapshots",
    latest_captured_at: captured,
    latest_object_keys: { text: "historical/text.txt" },
    latest_hashes: {
      text_hash: textHash,
      file_hash: kind === "pdf" ? captureFileSha256 : null,
    },
    latest_metadata_sha256: sha256("historical metadata"),
    immutable_generation: "0".repeat(32),
  };
  const previousContent = {
    verification_scope: "report_only_not_validated",
    preserved: true,
    previous_captured_at: null,
    previous_object_keys: {},
    previous_hashes: {},
    previous_metadata: {},
  };
  const receipt = {
    schema: STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA,
    status: "verified",
    source_id: sourceId,
    kind,
    captured_at: captured,
    creates_api_charge: false,
    mutation_performed: false,
    pointer_identity: {
      ...pointerContent,
      pointer_sha256: sha256Json(pointerContent),
    },
    previous_pointer: {
      ...previousContent,
      projection_sha256: sha256Json(previousContent),
    },
    artifact_binding_verification: {
      status: "derived_from_exact_local_and_remote_bytes",
      pointer_claim_present: false,
      derived_binding_count: 1,
    },
    verified_roles: [],
    semantic_text: {
      sha256: textHash,
      character_length: retainedText.length,
      object_byte_length: Buffer.byteLength(`${retainedText}\n`),
      writer_framing: "lf",
    },
    limitations: ["historical_fixture"],
  };
  return {
    ...receipt,
    receipt_sha256: stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(receipt),
  };
}

function metaFixture({ capture, activation, provenance }) {
  return {
    version: 2,
    kind: capture.kind,
    source: clone(capture.source),
    captured_at: capture.captured_at,
    final_url: capture.final_url,
    text_hash: capture.text_hash,
    body_text_hash: capture.body_text_hash,
    main_content_hash: capture.main_content_hash,
    nav_header_footer_hash: capture.nav_header_footer_hash,
    expansion_hash: capture.expansion_hash,
    expandable_sections_hash: capture.expandable_sections_hash,
    image_hash: capture.image_hash,
    layout_hash: capture.layout_hash,
    file_hash: capture.file_hash,
    file_bytes: capture.file_bytes,
    text_length: capture.text_length,
    body_text_length: capture.body_text_length,
    main_content_text_length: capture.main_content_text_length,
    nav_header_footer_text_length: capture.nav_header_footer_text_length,
    expansion_text_length: capture.expansion_text_length,
    stage1_baseline_activation: clone(activation),
    stage1_evidence_schema_upgrade: clone(provenance),
  };
}

function preparedFixture({ kind, capture, meta, pdfBody, pageBody }) {
  const textBody = Buffer.from(`${capture.text}\n`, "utf8");
  const metaBody = Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, "utf8");
  const specs = kind === "pdf"
    ? [
        ["pdf", "document.pdf", "application/pdf", pdfBody],
        ["text", "text.txt", "text/plain; charset=utf-8", textBody],
        ["meta", "meta.json", "application/json; charset=utf-8", metaBody],
      ]
    : [
        ["page", "page.jpg", "image/jpeg", pageBody],
        ["thumb", "thumb.jpg", "image/jpeg", Buffer.from("stable thumbnail")],
        ["text", "text.txt", "text/plain; charset=utf-8", textBody],
        ["meta", "meta.json", "application/json; charset=utf-8", metaBody],
      ];
  const artifacts = specs.map(([name, fileName, contentType, body]) => {
    const binding = rawBinding(body, contentType);
    return {
      name,
      fileName,
      path: `C:/fixture/${capturedAt}/${fileName}`,
      contentType,
      body: Buffer.from(body),
      binding,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  return {
    artifacts,
    artifactBindings: Object.fromEntries(
      artifacts.map((artifact) => [artifact.name, clone(artifact.binding)]),
    ),
  };
}

function pointerFixture({ capture, activation, provenance, prepared }) {
  const generation = "1".repeat(32);
  const objectKeys = Object.fromEntries(prepared.artifacts.map((artifact) => [
    artifact.name,
    `visual-snapshots/sources/${sourceId}/captures/${generation}/${artifact.fileName}`,
  ]));
  return {
    shared_award_source_id: sourceId,
    shared_award_id: awardId,
    source_url: finalUrl,
    source_title: "Example Award",
    source_page_type: "overview",
    kind: capture.kind,
    bucket: "awardping-snapshots",
    latest_captured_at: capture.captured_at,
    latest_object_keys: objectKeys,
    latest_hashes: {
      image_hash: capture.image_hash,
      text_hash: capture.text_hash,
      body_text_hash: capture.body_text_hash,
      main_content_hash: capture.main_content_hash,
      nav_header_footer_hash: capture.nav_header_footer_hash,
      expansion_hash: capture.expansion_hash,
      layout_hash: capture.layout_hash,
      file_hash: capture.file_hash,
    },
    latest_metadata: {
      artifact_bindings_schema: r2CaptureArtifactBindingsSchema,
      artifact_bindings: clone(prepared.artifactBindings),
      retained_artifact_projection: {
        schema_version: "awardping.visual-snapshot.retained-artifact-projection.v1",
        kind: capture.kind,
      },
      final_url: capture.final_url,
      stage1_baseline_activation: clone(activation),
      stage1_evidence_schema_upgrade: clone(provenance),
      text_length: capture.text_length,
      body_text_length: capture.body_text_length,
      main_content_text_length: capture.main_content_text_length,
      nav_header_footer_text_length: capture.nav_header_footer_text_length,
      expansion_text_length: capture.expansion_text_length,
      file_bytes: capture.file_bytes,
    },
    previous_captured_at: null,
    previous_object_keys: {},
    previous_hashes: {},
    previous_metadata: {},
    updated_at: "2026-08-15T10:00:35.000Z",
  };
}

function currentR2ReceiptFixture({ capture, pointer, prepared }) {
  const pointerContent = {
    shared_award_source_id: sourceId,
    kind: capture.kind,
    bucket: pointer.bucket,
    latest_captured_at: pointer.latest_captured_at,
    latest_object_keys: clone(pointer.latest_object_keys),
    latest_hashes: clone(pointer.latest_hashes),
    latest_metadata_sha256: sha256Json(pointer.latest_metadata),
    immutable_generation: "1".repeat(32),
  };
  const previousContent = {
    verification_scope: "report_only_not_validated",
    preserved: true,
    previous_captured_at: pointer.previous_captured_at,
    previous_object_keys: clone(pointer.previous_object_keys),
    previous_hashes: clone(pointer.previous_hashes),
    previous_metadata: clone(pointer.previous_metadata),
  };
  const textArtifact = prepared.artifacts.find((artifact) => artifact.name === "text");
  const receipt = {
    schema: STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA,
    status: "verified",
    source_id: sourceId,
    kind: capture.kind,
    captured_at: capture.captured_at,
    creates_api_charge: false,
    mutation_performed: false,
    pointer_identity: {
      ...pointerContent,
      pointer_sha256: sha256Json(pointerContent),
    },
    previous_pointer: {
      ...previousContent,
      projection_sha256: sha256Json(previousContent),
    },
    artifact_binding_verification: {
      status: "pointer_v1_bindings_verified",
      pointer_claim_present: true,
      derived_binding_count: 0,
    },
    verified_roles: prepared.artifacts.map((artifact) => ({
      role: artifact.name,
      key: pointer.latest_object_keys[artifact.name],
      sha256: artifact.binding.sha256,
      byte_length: artifact.binding.byte_length,
      content_type: artifact.binding.content_type,
      remote_body_verified: true,
    })),
    semantic_text: {
      sha256: capture.text_hash,
      character_length: capture.text.length,
      object_byte_length: textArtifact.body.byteLength,
      writer_framing: "lf",
    },
    limitations: [],
  };
  return {
    ...receipt,
    receipt_sha256: stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(receipt),
  };
}

function replaceCurrentPreparedArtifactBody(fixture, role, body) {
  const prepared = fixture.input.currentPreparedArtifacts;
  const artifact = prepared.artifacts.find((entry) => entry.name === role);
  const replacement = Buffer.from(body);
  const binding = rawBinding(replacement, artifact.contentType);
  artifact.body = replacement;
  artifact.binding = clone(binding);
  prepared.artifactBindings[role] = clone(binding);
  fixture.input.currentR2Pointer.latest_metadata.artifact_bindings[role] =
    clone(binding);

  const verifiedRole = fixture.input.verifiedR2BindingReceipt.verified_roles
    .find((entry) => entry.role === role);
  verifiedRole.sha256 = binding.sha256;
  verifiedRole.byte_length = binding.byte_length;
  verifiedRole.content_type = binding.content_type;
}

function resealCurrentR2Receipt(fixture) {
  const receipt = fixture.input.verifiedR2BindingReceipt;
  receipt.pointer_identity.latest_metadata_sha256 = sha256Json(
    fixture.input.currentR2Pointer.latest_metadata,
  );
  const pointerContent = clone(receipt.pointer_identity);
  delete pointerContent.pointer_sha256;
  receipt.pointer_identity.pointer_sha256 = sha256Json(pointerContent);
  receipt.receipt_sha256 = stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(receipt);
}

function baselineFixture({ capture, activation, provenance }) {
  return {
    version: 2,
    kind: capture.kind,
    source: clone(capture.source),
    captured_at: capture.captured_at,
    final_url: capture.final_url,
    text_hash: capture.text_hash,
    body_text_hash: capture.body_text_hash,
    main_content_hash: capture.main_content_hash,
    nav_header_footer_hash: capture.nav_header_footer_hash,
    expansion_hash: capture.expansion_hash,
    expandable_sections_hash: capture.expandable_sections_hash,
    image_hash: capture.image_hash,
    layout_hash: capture.layout_hash,
    file_hash: capture.file_hash,
    file_bytes: capture.file_bytes,
    text_length: capture.text_length,
    body_text_length: capture.body_text_length,
    main_content_text_length: capture.main_content_text_length,
    nav_header_footer_text_length: capture.nav_header_footer_text_length,
    expansion_text_length: capture.expansion_text_length,
    capture: capture.kind === "pdf"
      ? { pdf: "sources/current/document.pdf", text: "sources/current/text.txt", meta: "sources/current/meta.json" }
      : { page: "sources/current/page.jpg", thumb: "sources/current/thumb.jpg", text: "sources/current/text.txt", meta: "sources/current/meta.json" },
    summary_metadata: {
      stage1_baseline_activation: clone(activation),
      stage1_evidence_schema_upgrade: clone(provenance),
    },
  };
}

function sourceHealthProjection({ capture, current, finalization }) {
  const checkedAt = current ? "2026-08-15T10:00:20.000Z" : "2026-08-14T10:00:00.000Z";
  const visualHash = capture.file_hash || capture.main_content_hash || capture.image_hash || capture.text_hash;
  return {
    admin_review_note: "exact_first_visual_baseline_verified",
    admin_review_status: "open",
    admin_reviewed_at: finalization.finalized_at,
    admin_reviewed_by: "stage1-baseline-activation-receipt",
    consecutive_failures: 0,
    created_at: "2026-08-14T08:00:00.000Z",
    display_title: "Example Award details",
    id: sourceId,
    last_checked_at: checkedAt,
    last_error: null,
    last_hash: current ? `visual:${visualHash}` : "visual:historical",
    next_check_at: current
      ? "2026-08-16T10:00:20.000Z"
      : "2026-08-15T09:00:00.000Z",
    page_description: null,
    page_metadata: { reviewed: true },
    page_metadata_generated_at: "2026-08-14T08:00:00.000Z",
    page_metadata_model: "reviewed-v1",
    page_type: "overview",
    reason: "reviewed monitoring only",
    shared_award_id: awardId,
    shared_awards: {
      id: awardId,
      name: "Example Award",
      official_homepage: "https://example.test/award",
      status: "active",
    },
    source: "admin",
    submitted_by_user_id: null,
    title: "Example Award details",
    updated_at: checkedAt,
    url: finalUrl,
  };
}

function recoveryCompletionAuthority() {
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_COMPLETION_AUTHORITY_SCHEMA,
    mode: "reviewed_recovery",
    recovery: {
      recovery_plan_file_sha256: sha256("recovery plan file"),
      recovery_plan_sha256: sha256("recovery plan"),
      inspection_file_sha256: sha256("recovery inspection file"),
      inspection_sha256: sha256("recovery inspection"),
      proposed_plan_sha256: sha256("recovery proposed plan"),
      reviewer_id: "reviewer@example.test",
      reviewed_at: "2026-08-15T10:00:15.000Z",
      expires_at: "2026-08-15T12:00:00.000Z",
      expected_disposition: "candidate_archived_recovery_completed",
      source_id: sourceId,
      transaction_id: recoveryTransactionId,
    },
  };
  return {
    ...content,
    completion_authority_sha256: sha256Json(content),
  };
}

function auditInspectionFixture({ operationBinding, journal, completionAuthority }) {
  const resultIdentityContent = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_RESULT_IDENTITY_SCHEMA,
    source_id: sourceId,
    selected_result_schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
    selected_result_status: "upgraded",
    selected_result_sha256: sha256("selected result"),
    commit_receipt_schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
    commit_receipt_status: "upgraded",
    commit_receipt_sha256: sha256("commit receipt"),
    commit_journal_sha256: journal.journal_sha256,
    commit_mutation_accounting_sha256: sha256("commit mutation accounting"),
  };
  const resultIdentity = {
    ...resultIdentityContent,
    identity_sha256: sha256Json(resultIdentityContent),
  };
  const content = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMPLETED_AUTHORITY_AUDIT_INSPECTION_SCHEMA,
    disposition: "terminal_succeeded",
    run_id: operationBinding.audit_run_id,
    worker_name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_AUDIT_WORKER_NAME,
    status: "succeeded",
    selected_source_id: sourceId,
    execution_nonce: operationBinding.execution_nonce,
    started_at: auditStartedAt,
    finished_at: auditFinishedAt,
    plan_file_sha256: operationBinding.reviewed_apply_plan_file_sha256,
    plan_sha256: operationBinding.reviewed_apply_plan_sha256,
    manifest_sha256: manifestSha256,
    reviewed_report_attempt_id: operationBinding.reviewed_report_attempt_id,
    authority_receipt_sha256: operationBinding.precommit_authority_receipt_sha256,
    fresh_capture_sha256: operationBinding.fresh_capture_sha256,
    fresh_capture_result_sha256: operationBinding.fresh_capture_result_sha256,
    fresh_capture_validation_sha256: operationBinding.fresh_capture_validation_sha256,
    fresh_validation_projection_sha256:
      operationBinding.fresh_validation_projection_sha256,
    terminal_identity_sha256: resultIdentity.identity_sha256,
    terminal_result_identity: resultIdentity,
    terminal_commit_receipt_sha256: resultIdentity.commit_receipt_sha256,
    terminal_commit_journal_sha256: journal.journal_sha256,
    terminal_mutation_accounting_sha256:
      resultIdentity.commit_mutation_accounting_sha256,
    terminal_completion_authority: clone(completionAuthority),
    observed_row_sha256: sha256("observed audit row"),
    business_execution_authorized: false,
    mutation_permitted: false,
    mutation_performed: false,
    creates_api_charge: false,
  };
  return {
    ...content,
    inspection_sha256: sha256Json(content),
  };
}

function rawBinding(body, contentType) {
  return {
    sha256: sha256(body),
    byte_length: body.byteLength,
    content_type: contentType,
    hash_mode: "raw_sha256",
  };
}

function reseal(value, field) {
  const copy = clone(value);
  delete copy[field];
  return { ...copy, [field]: sha256Json(copy) };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value) {
  return sha256(canonicalJson(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  return structuredClone(value);
}
