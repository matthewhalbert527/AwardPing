import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { stage1EvidenceSchemaUpgradeExpectedManifest } from "./stage1-evidence-schema-upgrade.mjs";
import {
  sealStage1EvidenceSchemaUpgradeMutationAccounting,
  zeroStage1EvidenceSchemaUpgradeMutationCounts,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";
import {
  advanceStage1EvidenceSchemaUpgradeJournal,
  buildStage1EvidenceSchemaUpgradeJournal,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import {
  runStage1EvidenceSchemaUpgradeCommit,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_ARCHIVE_ACCOUNTING_SCHEMA,
} from "./stage1-evidence-schema-upgrade-commit.mjs";
import { visualSnapshotPointerIdentity } from "./visual-snapshot-latest-only-reconciliation.mjs";
import {
  buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs,
  prepareStage1EvidenceSchemaUpgradeQuarantineValidation,
  stage1EvidenceSchemaUpgradeQuarantineSafeAction,
  stage1EvidenceSchemaUpgradeQuarantineReceipt,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_EVIDENCE_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_ID,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_SHA256,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_RECEIPT_SCHEMA,
} from "./stage1-evidence-schema-upgrade-quarantine.mjs";

const sourceId = "c30778fe-43d7-57be-842a-e046d84baaee";
const acquisitionId = "11111111-1111-4111-8111-111111111111";
const requestId = "62a291a2-e64d-5788-a876-f2dca551a021";
const quarantineId = "22222222-2222-4222-8222-222222222222";
const guardSha256 = "a".repeat(64);
const dispositionItemSha256 = "b".repeat(64);
const finalizationReceiptSha256 = "c".repeat(64);

describe("Stage 1 evidence-schema-upgrade quarantine RPC contract", () => {
  it("builds a fully sealed zero-charge reviewed-nine failure envelope", () => {
    const input = fixture();
    const before = structuredClone(input);
    const args = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(input);

    expect(input).toEqual(before);
    expect(args).toMatchObject({
      p_source_id: sourceId,
      p_acquisition_id: acquisitionId,
      p_request_id: requestId,
      p_reason_code: "web_intake_not_stable",
      p_evidence: {
        schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_EVIDENCE_SCHEMA,
        source_binding: {
          source_id: sourceId,
          source_acquisition_id: acquisitionId,
          source_page_request_id: requestId,
          manifest_item: 1,
          guard_sha256: guardSha256,
          disposition_item_sha256: dispositionItemSha256,
          finalization_receipt_sha256: finalizationReceiptSha256,
        },
        manifest_sha256: STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SHA256,
        policy: {
          policy_id: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_ID,
          creates_api_charge: false,
          public_fact_authority: false,
        },
        policy_sha256: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_POLICY_SHA256,
        failure_stage: "capture_validation",
        reason_code: "web_intake_not_stable",
        creates_api_charge: false,
        public_fact_authority: false,
        public_award_update_created: false,
        evidence_availability: {
          validation: {
            status: "sealed_present",
            at_failure_stage: "capture_validation",
            unavailable_reason: null,
          },
          r2_binding: {
            status: "not_observed",
            unavailable_reason: "r2_binding_not_observed_before_failure",
          },
          commit_recovery: {
            status: "not_observed",
            unavailable_reason: "durable_upgrade_journal_not_observed_before_failure",
          },
          candidate_artifacts: {
            status: "not_observed",
            unavailable_reason: "candidate_plan_not_observed_before_failure",
          },
        },
      },
    });
    expect(args.p_evidence.validation_sha256).toBe(
      hashJson(args.p_evidence.validation),
    );
    expect(args.p_evidence.evidence_sha256).toBe(
      hashJson(withoutKey(args.p_evidence, "evidence_sha256")),
    );
    expect(args.p_evidence.r2_binding_sha256).toBeNull();
    expect(args.p_evidence.commit_recovery_sha256).toBeNull();
    expect(args.p_evidence.candidate_artifacts_sha256).toBeNull();
  });

  it.each([
    ["Churchill", "c5961d93-9f1f-504e-8dd4-c4ec06a833a2"],
    ["unreviewed source", "99999999-9999-4999-8999-999999999999"],
  ])("refuses %s before constructing RPC authority", (_label, deniedId) => {
    const input = fixture();
    input.source.id = deniedId;
    input.source.source_activation_finalization.shared_award_source_id = deniedId;
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(input)).toThrow(
      "exact reviewed nine",
    );
  });

  it("refuses altered manifest, acquisition, guard, and finalization bindings", () => {
    const manifest = fixture();
    manifest.manifest.source_count = 8;
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(manifest)).toThrow(
      "exact reviewed-nine manifest",
    );

    const acquisition = fixture();
    acquisition.acquisition.origin_source_page_request_id = null;
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(acquisition)).toThrow(
      "source page request id",
    );

    const guard = fixture();
    guard.acquisition.review_seal.human_source_disposition.guard_sha256 = "short";
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(guard)).toThrow(
      "activation guard SHA-256",
    );

    const finalization = fixture();
    delete finalization.source.source_activation_finalization.finalization_receipt_sha256;
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(finalization)).toThrow(
      "finalization receipt SHA-256",
    );
  });

  it("refuses paid, contradictory, cross-source, and non-JSON validation evidence", () => {
    const charged = fixture();
    charged.validation.creates_api_charge = true;
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(charged)).toThrow(
      "complete zero-charge",
    );

    const contradictory = fixture();
    contradictory.validation.outcome.would_commit = true;
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(contradictory)).toThrow(
      "complete zero-charge",
    );

    const swapped = fixture();
    swapped.validation.evidence.source_id =
      "99999999-9999-4999-8999-999999999999";
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(swapped)).toThrow(
      "another source",
    );

    const nonCanonicalSource = fixture();
    nonCanonicalSource.validation.evidence.source_id = sourceId.toUpperCase();
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      nonCanonicalSource,
    )).toThrow("another source");

    const nonJson = fixture();
    nonJson.validation.evidence.invalid = Number.POSITIVE_INFINITY;
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(nonJson)).toThrow(
      "safe integers",
    );
  });

  it("represents pre-journal mutation failures without fabricating unavailable proof", () => {
    for (const failureStage of [
      "candidate_artifact_upload",
      "journal_recovery",
    ]) {
      const input = fixture();
      input.failureStage = failureStage;
      const args = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(input);
      expect(args.p_evidence.evidence_availability).toMatchObject({
        r2_binding: { status: "not_observed" },
        commit_recovery: { status: "not_observed" },
        candidate_artifacts: { status: "not_observed" },
      });
      expect(args.p_evidence.commit_recovery_sha256).toBeNull();
    }

    const omittedMutation = fixture();
    omittedMutation.failureStage = "pointer_commit";
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      omittedMutation,
    )).toThrow("require exactly one sealed mutation failure");

    const pointerFailure = fixture();
    pointerFailure.failureStage = "pointer_commit";
    pointerFailure.validation = fixture().validation;
    pointerFailure.validation.decision = "eligible_unchanged_upgrade";
    pointerFailure.validation.outcome = {
      would_commit: true,
      would_queue_visual_candidate: false,
      would_quarantine: false,
      creates_api_charge: false,
    };
    pointerFailure.validation =
      prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
        validation: pointerFailure.validation,
        mutationFailure: mutationFailure("pointer_commit", {
          unknownWriteCategories: ["database_writes", "r2_writes"],
        }),
      });
    pointerFailure.safeAction = stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      pointerFailure.validation,
      pointerFailure.safeAction,
    );
    const pointerArgs = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      pointerFailure,
    );
    expect(pointerArgs.p_evidence.evidence_availability).toMatchObject({
      commit_recovery: { status: "not_observed" },
      candidate_artifacts: { status: "not_observed" },
    });

    const observedWithoutProof = structuredClone(pointerFailure);
    observedWithoutProof.journalObserved = true;
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      observedWithoutProof,
    )).toThrow("requires its exact sealed evidence");

    const malformedR2 = fixture();
    malformedR2.r2Binding = {
      schema: "awardping.stage1.evidence-schema-upgrade-r2-binding.v1",
      status: "verified",
      source_id: sourceId,
      creates_api_charge: false,
      mutation_performed: false,
      receipt_sha256: "d".repeat(64),
    };
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(malformedR2)).toThrow(
      /missing or has been altered/u,
    );
  });

  it("seals a successful fresh absence observation without calling it unobserved", () => {
    const input = fixture();
    input.failureStage = "pointer_commit";
    input.validation.decision = "eligible_unchanged_upgrade";
    input.validation.outcome = {
      would_commit: true,
      would_queue_visual_candidate: false,
      would_quarantine: false,
      creates_api_charge: false,
    };
    const observation = { status: "absent", journal: null, error: null };
    input.validation = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: input.validation,
      mutationFailure: mutationFailure("pointer_commit"),
      journalReadAbsent: observation,
    });
    input.safeAction = stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      input.validation,
      input.safeAction,
    );
    const args = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(input);
    expect(args.p_evidence.evidence_availability.commit_recovery).toEqual({
      status: "verified_absent",
      at_failure_stage: "pointer_commit",
      unavailable_reason: null,
    });
    expect(
      args.p_evidence.validation.evidence.pointer_commit_journal_binding,
    ).toMatchObject({
      status: "fresh_absence_only",
      prior_receipt_journal_sha256: null,
      fresh_journal_sha256: null,
      fresh_journal_read_status: "absent",
    });
    expect(args.p_evidence.safe_action).toContain(
      "retry only if the commit is proven incomplete",
    );

    const nonPointer = fixture();
    nonPointer.validation = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: nonPointer.validation,
      journalReadAbsent: observation,
    });
    const nonPointerArgs = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      nonPointer,
    );
    expect(nonPointerArgs.p_evidence.evidence_availability.commit_recovery.status)
      .toBe("verified_absent");
    expect(nonPointerArgs.p_evidence.validation.evidence)
      .not.toHaveProperty("pointer_commit_journal_binding");
  });

  it("accepts only an exactly sealed active-journal recovery envelope", () => {
    const input = fixture();
    input.failureStage = "pointer_commit";
    const candidate = candidateEvidence();
    const journal = recoveryJournal(candidate, "stage1-probe");
    candidate.journal_sha256 = journal.journal_sha256;
    const recovery = recoveryEvidence(journal);
    input.candidateArtifacts = candidate;
    input.validation = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: input.validation,
      candidateArtifacts: candidate,
      commitRecovery: recovery,
      mutationFailure: mutationFailure("pointer_commit", {
        lowerBoundCounts: { local_baseline_writes: 1 },
        unknownWriteCategories: ["database_writes"],
      }),
    });
    input.commitRecovery = recovery;
    input.safeAction = stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      input.validation,
      input.safeAction,
    );
    const args = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(input);
    expect(args.p_evidence.evidence_availability.commit_recovery.status).toBe(
      "sealed_present",
    );
    expect(args.p_evidence.commit_recovery_sha256).toBe(
      hashJson(input.commitRecovery),
    );

    const tampered = structuredClone(input);
    tampered.commitRecovery.journal.phase = "completed";
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(tampered)).toThrow(
      "invalid nested journal seal",
    );

    const extraJournal = structuredClone(journal);
    extraJournal.unexpected = true;
    delete extraJournal.journal_sha256;
    extraJournal.journal_sha256 = hashJson(extraJournal);
    const candidateForExtraJournal = structuredClone(candidate);
    candidateForExtraJournal.journal_sha256 = extraJournal.journal_sha256;
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: fixture().validation,
      candidateArtifacts: candidateForExtraJournal,
      commitRecovery: recoveryEvidence(extraJournal),
      mutationFailure: mutationFailure("pointer_commit"),
    })).toThrow("active journal must contain only the exact sealed journal fields");

    const unavailableContradiction = structuredClone(input);
    unavailableContradiction.validation.evidence.journal_read_unavailable = {
      status: "unavailable",
      error: {
        name: "FilesystemError",
        code: "EACCES",
        message: "A fresh journal read was reported unavailable.",
      },
    };
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      unavailableContradiction,
    )).toThrow("contradicts unavailable or absent journal-read evidence");
  });

  it.each([
    "prepared",
    "local_candidate_written",
    "pointer_cas_attempted",
    "pointer_candidate_committed",
    "completed",
    "recovery_required",
  ])("accepts an exactly sealed fresh %s journal at the quarantine boundary", (phase) => {
    const input = fixture();
    input.failureStage = "pointer_commit";
    input.validation.decision = "eligible_unchanged_upgrade";
    input.validation.outcome = {
      would_commit: true,
      would_queue_visual_candidate: false,
      would_quarantine: false,
      creates_api_charge: false,
    };
    const candidate = candidateEvidence();
    const journal = journalAtPhase(candidate, phase);
    candidate.journal_sha256 = journal.journal_sha256;
    const recovery = recoveryEvidence(journal);
    input.validation = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: input.validation,
      candidateArtifacts: candidate,
      commitRecovery: recovery,
      mutationFailure: mutationFailure("pointer_commit"),
    });
    input.candidateArtifacts = candidate;
    input.candidatePlanObserved = true;
    input.commitRecovery = recovery;
    input.journalObserved = true;
    input.safeAction = stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      input.validation,
      input.safeAction,
    );

    const args = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(input);
    expect(args.p_evidence.commit_recovery.journal.phase).toBe(phase);
    expect(
      args.p_evidence.validation.evidence.pointer_commit_journal_binding.status,
    ).toBe("fresh_observation_only");
  });

  it("binds candidate artifacts to canonical pointer topology, bucket, generation, and metadata", () => {
    const input = fixture();
    input.failureStage = "candidate_artifact_upload";
    input.candidateArtifacts = candidateEvidence();
    const args = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(input);
    expect(args.p_evidence.candidate_artifacts).toMatchObject({
      source_id: sourceId,
      kind: "webpage",
      bucket: "awardping-evidence",
      version: "1".repeat(32),
      journal_sha256: null,
    });
    expect(args.p_evidence.candidate_artifacts.artifacts.map(
      (artifact) => artifact.role,
    )).toEqual(["layout", "meta", "page", "text", "thumb"]);

    for (const mutate of [
      (candidate) => {
        candidate.artifacts[0].object_key = candidate.artifacts[0].object_key
          .replace("/captures/" + "1".repeat(32), "/captures/" + "2".repeat(32));
      },
      (candidate) => { candidate.artifacts[0].bucket = "other-bucket"; },
      (candidate) => { candidate.artifacts[0].hash_mode = "etag"; },
      (candidate) => {
        candidate.candidate_pointer_identity.projection.latest_metadata
          .artifact_bindings.page.sha256 = "f".repeat(64);
      },
      (candidate) => {
        candidate.candidate_pointer_identity.projection.shared_award_source_id =
          "99999999-9999-4999-8999-999999999999";
      },
    ]) {
      const denied = fixture();
      denied.candidateArtifacts = candidateEvidence();
      mutate(denied.candidateArtifacts);
      expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(denied)).toThrow();
    }

    const future = fixture();
    future.candidateArtifacts = candidateEvidence({
      capturedAt: new Date(Date.now() + (10 * 60 * 1000)).toISOString(),
    });
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(future)).toThrow(
      "Candidate artifact evidence is incomplete or belongs to another source.",
    );

    const noncanonicalPointerTime = fixture();
    noncanonicalPointerTime.candidateArtifacts = candidateEvidence();
    noncanonicalPointerTime.candidateArtifacts.candidate_pointer_identity
      .projection.updated_at = "2026-08-14T16:00:01.000-05:00";
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      noncanonicalPointerTime,
    )).toThrow(
      "Candidate pointer metadata is not exactly source, kind, bucket, capture, and artifact bound.",
    );
  });

  it("accepts explicit main-layout-unavailable metadata while retaining exact expansion pairs", () => {
    const input = fixture();
    input.candidateArtifacts = candidateEvidence({
      layoutRetained: false,
      expansionCount: 1,
    });
    input.validation.evidence.capture.layout_hash = null;
    const args = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(input);
    expect(args.p_evidence.candidate_artifacts.artifacts.map(
      (artifact) => artifact.role,
    )).toEqual([
      "expansion_state_01",
      "expansion_state_01_layout",
      "meta",
      "page",
      "text",
      "thumb",
    ]);

    const contradicted = fixture();
    contradicted.candidateArtifacts = structuredClone(input.candidateArtifacts);
    contradicted.candidateArtifacts.candidate_pointer_identity.projection
      .latest_metadata.retained_artifact_projection.authoritative.layout_retained = true;
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      contradicted,
    )).toThrow("pointer identity");
  });

  it("rejects a same-source candidate from a different validated capture generation", () => {
    const wrongTimestamp = fixture();
    wrongTimestamp.candidateArtifacts = candidateEvidence();
    wrongTimestamp.validation.evidence.capture.captured_at =
      "2026-08-14T21:00:02.000Z";
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      wrongTimestamp,
    )).toThrow("exact validated capture generation");

    const wrongHash = fixture();
    wrongHash.candidateArtifacts = candidateEvidence();
    wrongHash.validation.evidence.capture.image_hash = "f".repeat(64);
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      wrongHash,
    )).toThrow("image_hash");

    const missingHash = fixture();
    missingHash.candidateArtifacts = candidateEvidence();
    delete missingHash.validation.evidence.capture.image_hash;
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      missingHash,
    )).toThrow("image_hash");
  });

  it("restricts the cross-language hash domain to ASCII keys and safe integers", () => {
    const unicodeKey = fixture();
    unicodeKey.validation.evidence["évidence"] = true;
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(unicodeKey)).toThrow(
      "printable ASCII",
    );

    const fractional = fixture();
    fractional.validation.evidence.score = 0.5;
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(fractional)).toThrow(
      "safe integers",
    );

    const unicodeString = fixture();
    unicodeString.detail = "Évidence retained exactly.";
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      unicodeString,
    )).not.toThrow();
  });

  it("accepts only exact legacy-four or sealed current-six pointer accounting", () => {
    const accepted = [
      { label: "legacy", accountingShape: "legacy" },
      { label: "current-not-started", accountingShape: "current" },
      {
        label: "current-verified",
        accountingShape: "current",
        journalPersistence: {
          state: "verified",
          local_journal_writes_lower_bound: 2,
          response_loss_possible: false,
        },
      },
    ];
    for (const options of accepted) {
      const candidate = candidateEvidence();
      const journal = recoveryJournal(
        candidate,
        `stage1-${options.label}-accounting`,
      );
      candidate.journal_sha256 = journal.journal_sha256;
      const failure = pointerCommitFailure(options);
      const receipt = pointerCommitReceipt({
        journal,
        mutationFailure: failure,
        candidate,
      });
      const validation = fixture().validation;
      validation.evidence = {
        source_id: sourceId,
        pointer_commit_receipt: receipt,
      };
      expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
        validation,
        candidateArtifacts: candidate,
        commitRecovery: recoveryEvidence(journal, "ambiguous_authority"),
        pointerCommitReceipt: receipt,
        mutationFailure: failure,
      })).not.toThrow();
    }
  });

  it("rejects extra keys and invalid nested journal accounting after outer resealing", () => {
    const candidate = candidateEvidence();
    const journal = recoveryJournal(candidate, "stage1-nested-accounting");
    candidate.journal_sha256 = journal.journal_sha256;
    const validation = fixture().validation;
    validation.evidence = { source_id: sourceId };
    const cases = [
      pointerCommitFailure({ accountingEvidenceExtra: { future: true } }),
      pointerCommitFailure({
        journalPersistence: {
          state: "not_started",
          local_journal_writes_lower_bound: 0,
          response_loss_possible: false,
          future: true,
        },
      }),
      pointerCommitFailure({
        journalPersistence: {
          state: "write_in_flight",
          local_journal_writes_lower_bound: 0,
          response_loss_possible: true,
        },
      }),
      pointerCommitFailure({
        journalPersistence: {
          state: "write_acknowledged_readback_unverified",
          local_journal_writes_lower_bound: 1,
          response_loss_possible: false,
        },
      }),
      pointerCommitFailure({
        journalArchive: journalArchiveAccounting({ future: true }),
      }),
      pointerCommitFailure({
        journalArchive: {
          ...journalArchiveAccounting(),
          state: "archive_write_response_unknown",
          response_loss_possible: true,
        },
      }),
      pointerCommitFailure({
        journalArchive: journalArchiveAccounting({
          state: "verified",
          local_journal_archive_writes_lower_bound: 1,
          archive_receipt_acknowledged: true,
          archived_readback_verified: true,
          active_absence_verified: true,
        }),
      }),
    ];
    for (const failure of cases) {
      const receipt = pointerCommitReceipt({
        journal,
        mutationFailure: failure,
        candidate,
      });
      expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
        validation,
        candidateArtifacts: candidate,
        commitRecovery: recoveryEvidence(journal, "ambiguous_authority"),
        pointerCommitReceipt: receipt,
        mutationFailure: failure,
      })).toThrow(/accounting|journal|recovery-required/iu);
    }
  });

  it("preserves an actual current commit recovery receipt through prepare and RPC shape", async () => {
    const candidate = candidateEvidence();
    const journal = recoveryJournalWithOldAuthority(candidate);
    candidate.journal_sha256 = journal.journal_sha256;
    const result = await runStage1EvidenceSchemaUpgradeCommit({
      sourceId,
      transactionId: journal.transaction_id,
      expectedActiveJournalSha256: journal.journal_sha256,
      operationBinding: null,
      interfaces: {
        async loadActiveJournal() {
          return structuredClone(journal);
        },
        async persistActiveJournalAtomically() {
          throw new Error("an already recovery-required journal must not be rewritten");
        },
        async archiveCompletedJournalAtomically() {
          throw new Error("a recovery-required journal must not be archived");
        },
        async readArchivedJournal() {
          throw new Error("a recovery-required journal must not read the archive");
        },
        async readBaselineBytes() {
          throw new Error("authoritative baseline unavailable");
        },
        async writeBaselineBytesAtomically() {
          throw new Error("ambiguous authority must not rewrite the baseline");
        },
        async readLatestPointer() {
          throw new Error("authoritative pointer unavailable");
        },
      },
      now: () => "2026-08-14T21:10:00.000Z",
    });
    expect(result.status).toBe("recovery_required");
    expect(Object.keys(result.mutation_accounting.evidence).sort()).toEqual([
      "boundary",
      "cas",
      "journal_archive",
      "journal_persistence",
      "journal_phase",
      "response_loss_possible",
    ]);

    const failure = {
      operation: "pointer_commit",
      error: Object.assign(new Error("pointer commit needs recovery"), {
        code: "pointer_commit_recovery_required",
      }),
      mutation_accounting: result.mutation_accounting,
    };
    const validation = fixture().validation;
    validation.reason = "active_upgrade_journal_authority_ambiguous";
    validation.reasons = [{
      code: validation.reason,
      detail: "The exact active journal still needs reconciliation.",
    }];
    validation.evidence = {
      source_id: sourceId,
      pointer_commit_receipt: result.receipt,
    };
    const prepared = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      candidateArtifacts: candidate,
      commitRecovery: recoveryEvidence(journal, "ambiguous_authority"),
      pointerCommitReceipt: result.receipt,
      mutationFailure: failure,
    });
    expect(prepared.evidence.mutation_failure.mutation_accounting)
      .toEqual(result.mutation_accounting);
    expect(prepared.evidence.pointer_commit_receipt.mutation_accounting)
      .toEqual(result.mutation_accounting);

    const rpcInput = fixture();
    rpcInput.failureStage = "pointer_commit";
    rpcInput.reasonCode = validation.reason;
    rpcInput.validation = prepared;
    rpcInput.candidateArtifacts = candidate;
    rpcInput.candidatePlanObserved = true;
    rpcInput.commitRecovery = recoveryEvidence(journal, "ambiguous_authority");
    rpcInput.journalObserved = true;
    rpcInput.safeAction = stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      prepared,
      rpcInput.safeAction,
    );
    const args = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(rpcInput);
    expect(args.p_evidence.validation.evidence.pointer_commit_receipt
      .mutation_accounting).toEqual(result.mutation_accounting);
  });

  it("prepares a detached recovery-required validation from the sealed candidate pointer", () => {
    const candidate = candidateEvidence();
    const journal = recoveryJournal(
      candidate,
      "stage1-validation-preparation",
    );
    candidate.journal_sha256 = journal.journal_sha256;
    const failure = pointerCommitFailure({
      lowerBoundCounts: { local_baseline_writes: 1 },
      unknownWriteCategories: ["database_writes"],
      cas: thrownCasReceipt(),
      boundary: "pointer_cas_response_pending",
    });
    const receipt = pointerCommitReceipt({
      journal,
      mutationFailure: failure,
      candidate,
    });
    const recovery = recoveryEvidence(
      journal,
      "ambiguous_authority",
    );
    const input = fixture().validation;
    input.reason = "active_upgrade_journal_authority_ambiguous";
    input.reasons = [{
      code: input.reason,
      detail: "The exact active journal still needs reconciliation.",
    }];
    input.evidence = {
      source_id: sourceId,
      pointer_commit_receipt: receipt,
    };
    const beforeValidation = structuredClone(input);
    const beforeCandidate = structuredClone(candidate);

    const prepared = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: input,
      candidateArtifacts: candidate,
      commitRecovery: recovery,
      pointerCommitReceipt: receipt,
      mutationFailure: failure,
    });

    expect(input).toEqual(beforeValidation);
    expect(candidate).toEqual(beforeCandidate);
    expect(prepared.evidence).toMatchObject({
      source_id: sourceId,
      kind: "webpage",
      capture: {
        source_id: sourceId,
        captured_at: candidate.captured_at,
        text_hash: "2".repeat(64),
        image_hash: "1".repeat(64),
        file_hash: null,
        layout_hash: "9".repeat(64),
      },
      pointer_commit_journal_binding: {
        status: "same_journal",
        prior_receipt_journal_sha256: journal.journal_sha256,
        fresh_journal_sha256: journal.journal_sha256,
      },
    });
    expect(Object.isFrozen(prepared.evidence.capture)).toBe(true);

    const rpcInput = fixture();
    rpcInput.failureStage = "pointer_commit";
    rpcInput.reasonCode = input.reason;
    rpcInput.validation = prepared;
    rpcInput.candidateArtifacts = candidate;
    rpcInput.candidatePlanObserved = true;
    rpcInput.commitRecovery = recovery;
    rpcInput.journalObserved = true;
    rpcInput.safeAction = stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      prepared,
      rpcInput.safeAction,
    );
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(rpcInput))
      .not.toThrow();
  });

  it("retains a prior J1 receipt while separately binding a different fresh J2 generation", () => {
    const priorCandidate = candidateEvidence();
    const priorJournal = recoveryJournal(priorCandidate, "stage1-prior-j1");
    priorCandidate.journal_sha256 = priorJournal.journal_sha256;
    const failure = pointerCommitFailure();
    const receipt = pointerCommitReceipt({
      journal: priorJournal,
      mutationFailure: failure,
      candidate: priorCandidate,
    });

    const freshCandidate = candidateEvidence({
      version: "2".repeat(32),
      capturedAt: "2026-08-14T21:05:00.000Z",
      imageHash: "4".repeat(64),
      textHash: "5".repeat(64),
      layoutHash: "6".repeat(64),
    });
    const freshJournal = recoveryJournal(freshCandidate, "stage1-fresh-j2");
    freshCandidate.journal_sha256 = freshJournal.journal_sha256;
    const recovery = recoveryEvidence(
      freshJournal,
      "fresh_active_upgrade_journal_requires_reconciliation",
    );
    const validation = fixture().validation;
    validation.reason = "active_upgrade_journal_authority_ambiguous";
    validation.reasons = [{
      code: validation.reason,
      detail: "The prior result and fresh journal differ.",
    }];
    validation.evidence = {
      source_id: sourceId,
      pointer_commit_receipt: receipt,
    };

    const prepared = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      candidateArtifacts: freshCandidate,
      commitRecovery: recovery,
      pointerCommitReceipt: receipt,
      mutationFailure: failure,
    });
    expect(prepared.evidence.kind).toBeUndefined();
    expect(prepared.evidence.capture).toBeUndefined();
    expect(prepared.evidence.pointer_commit_journal_binding).toMatchObject({
      status: "changed_since_failure",
      prior_receipt_journal_sha256: priorJournal.journal_sha256,
      fresh_journal_sha256: freshJournal.journal_sha256,
      observed_candidate_identity: {
        version: "2".repeat(32),
        captured_at: freshCandidate.captured_at,
        candidate_pointer_sha256:
          freshCandidate.candidate_pointer_identity.canonical_sha256,
        journal_sha256: freshJournal.journal_sha256,
      },
    });

    const rpcInput = fixture();
    rpcInput.failureStage = "pointer_commit";
    rpcInput.reasonCode = validation.reason;
    rpcInput.validation = prepared;
    rpcInput.commitRecovery = recovery;
    rpcInput.candidateArtifacts = freshCandidate;
    rpcInput.journalObserved = true;
    rpcInput.candidatePlanObserved = true;
    rpcInput.safeAction = stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      prepared,
      rpcInput.safeAction,
    );
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(rpcInput))
      .not.toThrow();

    const genericAction = structuredClone(rpcInput);
    genericAction.safeAction = "Reconcile an active journal before retrying.";
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      genericAction,
    )).toThrow("must exactly match the derived");

    const changedIdentity = structuredClone(rpcInput);
    changedIdentity.validation.evidence.pointer_commit_journal_binding
      .observed_candidate_identity.version = "3".repeat(32);
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(
      changedIdentity,
    )).toThrow("contradicts the exact prior and fresh journal observations");
  });

  it("separates a fresh journal generation when a pointer exception returned no receipt", () => {
    const freshCandidate = candidateEvidence({
      version: "7".repeat(32),
      capturedAt: "2026-08-14T21:07:00.000Z",
      imageHash: "7".repeat(64),
      textHash: "8".repeat(64),
      layoutHash: "a".repeat(64),
    });
    const freshJournal = recoveryJournal(
      freshCandidate,
      "stage1-no-receipt-fresh-journal",
    );
    freshCandidate.journal_sha256 = freshJournal.journal_sha256;
    const recovery = recoveryEvidence(freshJournal);
    const validation = fixture().validation;
    validation.decision = "eligible_unchanged_upgrade";
    validation.outcome = {
      would_commit: true,
      would_queue_visual_candidate: false,
      would_quarantine: false,
      creates_api_charge: false,
    };
    const originalCapture = structuredClone(validation.evidence.capture);
    const failure = mutationFailure("pointer_commit", {
      unknownWriteCategories: ["database_writes"],
    });
    const prepared = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      candidateArtifacts: freshCandidate,
      commitRecovery: recovery,
      mutationFailure: failure,
    });
    expect(prepared.evidence.capture).toEqual(originalCapture);
    expect(prepared.evidence.pointer_commit_receipt).toBeUndefined();
    expect(prepared.evidence.pointer_commit_journal_binding).toMatchObject({
      status: "fresh_observation_only",
      prior_receipt_journal_sha256: null,
      fresh_journal_sha256: freshJournal.journal_sha256,
      observed_candidate_identity: {
        version: "7".repeat(32),
        journal_sha256: freshJournal.journal_sha256,
      },
    });

    const rpcInput = fixture();
    rpcInput.failureStage = "pointer_commit";
    rpcInput.validation = prepared;
    rpcInput.candidateArtifacts = freshCandidate;
    rpcInput.commitRecovery = recovery;
    rpcInput.journalObserved = true;
    rpcInput.candidatePlanObserved = true;
    rpcInput.safeAction = stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      prepared,
      rpcInput.safeAction,
    );
    expect(() => buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(rpcInput))
      .not.toThrow();
  });

  it("combines journal and candidate-signature hazards into one operator action", () => {
    const signature = "f".repeat(64);
    const counts = zeroStage1EvidenceSchemaUpgradeMutationCounts();
    const accounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "candidate_enqueue",
      lowerBoundCounts: counts,
      unknownWriteCategories: ["candidate_writes", "database_writes"],
      evidence: {
        boundary: "candidate_insert_response_pending",
        candidate_signature: signature,
        response_loss_possible: true,
      },
    });
    const validation = fixture().validation;
    validation.decision = "material_difference_candidate";
    validation.outcome = {
      would_commit: false,
      would_queue_visual_candidate: true,
      would_quarantine: false,
      creates_api_charge: false,
    };
    const candidate = candidateEvidence({
      version: "8".repeat(32),
      capturedAt: "2026-08-14T21:08:00.000Z",
    });
    const journal = recoveryJournal(candidate, "stage1-candidate-race-journal");
    candidate.journal_sha256 = journal.journal_sha256;
    const prepared = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      candidateArtifacts: candidate,
      commitRecovery: recoveryEvidence(journal),
      mutationFailure: {
        operation: "candidate_enqueue",
        error: new Error("candidate insert response lost"),
        mutation_accounting: accounting,
      },
    });
    const action = stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      prepared,
      "fallback",
    );
    expect(action).toContain("separately observed fresh journal");
    expect(action).toContain(signature);
    expect(action).toContain("do not enqueue a duplicate");

    const unreadable = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      mutationFailure: {
        operation: "candidate_enqueue",
        error: new Error("candidate insert response lost"),
        mutation_accounting: accounting,
      },
      journalReadUnavailable: {
        status: "unavailable",
        error: { name: "Error", code: "EIO", message: "journal read failed" },
      },
    });
    const unreadableAction = stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      unreadable,
      "fallback",
    );
    expect(unreadableAction).toContain("Repair access to the durable upgrade journal");
    expect(unreadableAction).toContain(signature);
  });

  it("distinguishes unreadable and verified-missing fresh journals without accepting an unbound candidate", () => {
    const priorCandidate = candidateEvidence();
    const priorJournal = recoveryJournal(priorCandidate, "stage1-prior-read");
    priorCandidate.journal_sha256 = priorJournal.journal_sha256;
    const failure = pointerCommitFailure();
    const receipt = pointerCommitReceipt({
      journal: priorJournal,
      mutationFailure: failure,
      candidate: priorCandidate,
    });
    const validation = fixture().validation;
    validation.evidence = {
      source_id: sourceId,
      pointer_commit_receipt: receipt,
    };
    const unavailable = {
      status: "unavailable",
      error: {
        name: "FilesystemError",
        code: "EACCES",
        message: "The fresh journal could not be read.",
      },
    };
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      pointerCommitReceipt: receipt,
      mutationFailure: failure,
    })).toThrow(
      "A prior pointer-commit receipt requires an explicit fresh journal observation",
    );
    const unreadable = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      pointerCommitReceipt: receipt,
      mutationFailure: failure,
      journalReadUnavailable: unavailable,
    });
    expect(unreadable.evidence.pointer_commit_journal_binding).toMatchObject({
      status: "prior_observation_only",
      fresh_journal_read_status: "unavailable",
      fresh_journal_sha256: null,
      observed_candidate_identity: null,
    });

    const missing = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      pointerCommitReceipt: receipt,
      mutationFailure: failure,
      journalReadAbsent: {
        status: "absent",
        journal: null,
        error: null,
      },
    });
    expect(missing.evidence.pointer_commit_journal_binding).toMatchObject({
      status: "missing_since_failure",
      fresh_journal_read_status: "absent",
      fresh_journal_sha256: null,
      observed_candidate_identity: null,
    });
    expect(stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      missing,
      "fallback",
    )).toContain("restore or reconstruct");

    const validationBoundToPrior = structuredClone(validation);
    validationBoundToPrior.evidence.kind = "webpage";
    validationBoundToPrior.evidence.capture = {
      source_id: sourceId,
      captured_at: priorCandidate.captured_at,
      text_hash: "2".repeat(64),
      image_hash: "1".repeat(64),
      file_hash: null,
      layout_hash: "9".repeat(64),
    };
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: validationBoundToPrior,
      candidateArtifacts: candidateEvidence({
        version: "2".repeat(32),
        capturedAt: "2026-08-14T21:05:00.000Z",
        imageHash: "4".repeat(64),
      }),
      pointerCommitReceipt: receipt,
      mutationFailure: failure,
      journalReadUnavailable: unavailable,
    })).toThrow(/capture captured_at contradicts sealed quarantine evidence/u);
  });

  it("accepts only the exact authority-changed source-health receipt and nested commit proof", () => {
    const candidate = candidateEvidence();
    const journal = recoveryJournal(candidate, "stage1-source-health");
    candidate.journal_sha256 = journal.journal_sha256;
    const failure = pointerCommitFailure({
      lowerBoundCounts: { database_writes: 1, source_state_writes: 1 },
    });
    const sourceHealth = {
      status: "succeeded",
      mutation_counts: {
        database_writes: 1,
        r2_writes: 0,
        local_baseline_writes: 0,
        candidate_writes: 0,
        quarantine_writes: 0,
        source_state_writes: 1,
      },
    };
    const receipt = pointerCommitReceipt({
      journal,
      mutationFailure: failure,
      candidate,
      outcome: "authority_changed_after_source_health",
      pointerState: "unknown",
      baselineState: "other",
      sourceHealth,
    });
    const validation = fixture().validation;
    validation.evidence = { source_id: sourceId };
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      pointerCommitReceipt: receipt,
      mutationFailure: failure,
      journalReadUnavailable: {
        status: "unavailable",
        error: { name: "Error", code: null, message: "read failed" },
      },
    })).not.toThrow();

    const wrongSourceHealth = structuredClone(receipt);
    wrongSourceHealth.source_health.mutation_counts.source_state_writes = 0;
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      pointerCommitReceipt: wrongSourceHealth,
      mutationFailure: failure,
    })).toThrow("source-health receipt is invalid");

    const wrongCas = structuredClone(receipt);
    wrongCas.cas = {
      ...wrongCas.cas,
      confirmed_database_pointer_writes: 1,
    };
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      pointerCommitReceipt: wrongCas,
      mutationFailure: failure,
    })).toThrow(/CAS receipt|accounting evidence/u);

    const wrongCleanup = structuredClone(receipt);
    wrongCleanup.cleanup_debt.item_count += 1;
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      pointerCommitReceipt: wrongCleanup,
      mutationFailure: failure,
    })).toThrow("cleanup debt");

    const inflatedCounts = zeroStage1EvidenceSchemaUpgradeMutationCounts();
    inflatedCounts.database_writes = 2;
    inflatedCounts.source_state_writes = 1;
    const inflatedFailure = pointerCommitFailure({
      lowerBoundCounts: inflatedCounts,
    });
    const inflatedReceipt = pointerCommitReceipt({
      journal,
      mutationFailure: inflatedFailure,
      candidate,
      outcome: "authority_changed_after_source_health",
      pointerState: "unknown",
      baselineState: "other",
      sourceHealth,
    });
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      pointerCommitReceipt: inflatedReceipt,
      mutationFailure: inflatedFailure,
    })).toThrow(/confirmed writes/u);

    const unboundSourceStateFailure = pointerCommitFailure({
      lowerBoundCounts: { database_writes: 1, source_state_writes: 1 },
    });
    const unboundSourceStateReceipt = pointerCommitReceipt({
      journal,
      mutationFailure: unboundSourceStateFailure,
      candidate,
    });
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      pointerCommitReceipt: unboundSourceStateReceipt,
      mutationFailure: unboundSourceStateFailure,
    })).toThrow(/confirmed writes/u);
  });

  it("binds exact candidate and uncertain commit accounting to immutable error identity", () => {
    const candidateCounts = zeroStage1EvidenceSchemaUpgradeMutationCounts();
    candidateCounts.database_writes = 1;
    candidateCounts.candidate_writes = 1;
    const candidateAccounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "candidate_enqueue",
      lowerBoundCounts: candidateCounts,
      unknownWriteCategories: [],
      evidence: {
        boundary: "candidate_observation_committed",
        candidate_signature: "d".repeat(64),
        response_loss_possible: false,
      },
    });
    const candidateError = Object.assign(new Error("candidate observation failed"), {
      code: "candidate_observation_failed",
    });
    const candidateValidation = fixture().validation;
    candidateValidation.decision = "material_difference_candidate";
    candidateValidation.outcome = {
      would_commit: false,
      would_queue_visual_candidate: true,
      would_quarantine: false,
      creates_api_charge: false,
    };
    const candidatePrepared = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: candidateValidation,
      candidateArtifacts: candidateEvidence(),
      mutationFailure: {
        operation: "candidate_enqueue",
        error: candidateError,
        mutation_accounting: candidateAccounting,
      },
    });
    expect(candidatePrepared.evidence.mutation_failure).toEqual({
      operation: "candidate_enqueue",
      error: {
        name: "Error",
        code: "candidate_observation_failed",
        message: "candidate observation failed",
      },
      mutation_accounting: candidateAccounting,
    });
    expect(candidatePrepared.evidence.mutation_failure.mutation_accounting.exact)
      .toBe(true);

    const commitCounts = zeroStage1EvidenceSchemaUpgradeMutationCounts();
    commitCounts.database_writes = 1;
    commitCounts.local_baseline_writes = 1;
    const commitAccounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "pointer_commit",
      lowerBoundCounts: commitCounts,
      unknownWriteCategories: ["database_writes", "r2_writes"],
      evidence: { boundary: "pointer_cas_response_pending" },
    });
    const commitPrepared = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: fixture().validation,
      mutationFailure: {
        operation: "pointer_commit",
        error: Object.assign(new Error("pointer outcome unknown"), {
          code: "pointer_response_lost",
        }),
        mutation_accounting: commitAccounting,
      },
    });
    expect(commitPrepared.evidence.mutation_failure).toMatchObject({
      operation: "pointer_commit",
      error: { code: "pointer_response_lost", message: "pointer outcome unknown" },
      mutation_accounting: {
        exact: false,
        lower_bound_counts: { database_writes: 1, local_baseline_writes: 1 },
        unknown_write_categories: ["database_writes", "r2_writes"],
      },
    });

    const outOfScopeCandidateCounts = zeroStage1EvidenceSchemaUpgradeMutationCounts();
    outOfScopeCandidateCounts.r2_writes = 1;
    const outOfScopeCandidate = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "candidate_enqueue",
      lowerBoundCounts: outOfScopeCandidateCounts,
      unknownWriteCategories: [],
      evidence: {
        boundary: "candidate_test_boundary",
        candidate_signature: "d".repeat(64),
        response_loss_possible: false,
      },
    });
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: candidateValidation,
      mutationFailure: {
        operation: "candidate_enqueue",
        error: candidateError,
        mutation_accounting: outOfScopeCandidate,
      },
    })).toThrow(/out-of-scope writes or categories/u);

    const outOfScopePointerCounts = zeroStage1EvidenceSchemaUpgradeMutationCounts();
    outOfScopePointerCounts.database_writes = 1;
    outOfScopePointerCounts.candidate_writes = 1;
    const outOfScopePointer = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "pointer_commit",
      lowerBoundCounts: outOfScopePointerCounts,
      unknownWriteCategories: ["quarantine_writes"],
      evidence: { boundary: "pointer_test_boundary" },
    });
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: fixture().validation,
      mutationFailure: {
        operation: "pointer_commit",
        error: new Error("pointer failed"),
        mutation_accounting: outOfScopePointer,
      },
    })).toThrow(/out-of-scope candidate or quarantine writes/u);
  });

  it("preserves thrown recovery evidence and distinguishes an unavailable fresh journal read", () => {
    const counts = zeroStage1EvidenceSchemaUpgradeMutationCounts();
    counts.local_baseline_writes = 1;
    const accounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "pointer_commit",
      lowerBoundCounts: counts,
      unknownWriteCategories: ["database_writes"],
      evidence: { boundary: "active_journal_recovery_throw" },
    });
    const validation = fixture().validation;
    validation.reason = "active_upgrade_journal_recovery_failed";
    validation.reasons = [{
      code: validation.reason,
      detail: "The active journal could not be read safely.",
    }];
    validation.evidence = {
      source_id: sourceId,
      error: {
        name: "Error",
        code: "active_journal_pointer_unavailable",
        message: "R2 pointer response was unavailable",
      },
      mutation_accounting: accounting,
    };
    const mutationError = Object.assign(
      new Error("R2 pointer response was unavailable"),
      { code: "active_journal_pointer_unavailable" },
    );
    const observation = {
      status: "unavailable",
      journal: null,
      error: {
        name: "FilesystemError",
        code: "EACCES",
        message: "The active journal could not be opened",
      },
    };
    const prepared = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      mutationFailure: {
        operation: "pointer_commit",
        error: mutationError,
        mutation_accounting: accounting,
      },
      journalReadUnavailable: observation,
    });
    expect(prepared.evidence).toMatchObject({
      error: { code: "active_journal_pointer_unavailable" },
      mutation_accounting: accounting,
      mutation_failure: {
        operation: "pointer_commit",
        error: { code: "active_journal_pointer_unavailable" },
        mutation_accounting: accounting,
      },
      journal_read_unavailable: {
        status: "unavailable",
        error: {
          name: "FilesystemError",
          code: "EACCES",
          message: "The active journal could not be opened",
        },
      },
    });

    const rpcInput = fixture();
    rpcInput.failureStage = "pointer_commit";
    rpcInput.reasonCode = validation.reason;
    rpcInput.validation = prepared;
    rpcInput.safeAction = stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      prepared,
      rpcInput.safeAction,
    );
    const args = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(rpcInput);
    expect(args.p_evidence.evidence_availability.commit_recovery).toEqual({
      status: "unavailable",
      at_failure_stage: "pointer_commit",
      unavailable_reason: "durable_upgrade_journal_read_unavailable",
    });
  });

  it("rejects candidate, mutation-accounting, and observation contradictions", () => {
    for (const mutate of [
      (validation) => { validation.evidence.kind = "pdf"; },
      (validation) => { validation.evidence.capture.source_id = requestId; },
      (validation) => {
        validation.evidence.capture.captured_at = "2026-08-14T21:00:02.000Z";
      },
      (validation) => { validation.evidence.capture.image_hash = "f".repeat(64); },
    ]) {
      const validation = fixture().validation;
      mutate(validation);
      expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
        validation,
        candidateArtifacts: candidateEvidence(),
      })).toThrow(/belongs|contradict|exact validated capture/u);
    }

    const accounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "pointer_commit",
      lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
      unknownWriteCategories: [],
      evidence: {
        boundary: "candidate_test_boundary",
        candidate_signature: "e".repeat(64),
        response_loss_possible: false,
      },
    });
    const tampered = structuredClone(accounting);
    tampered.lower_bound_counts.r2_writes = 1;
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: fixture().validation,
      mutationFailure: {
        operation: "pointer_commit",
        error: new Error("commit failed"),
        mutation_accounting: tampered,
      },
    })).toThrow(/seal or content is invalid/u);

    const candidateAccounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "candidate_enqueue",
      lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
      unknownWriteCategories: [],
      evidence: {
        boundary: "candidate_test_boundary",
        candidate_signature: "e".repeat(64),
        response_loss_possible: false,
      },
    });
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: fixture().validation,
      mutationFailure: {
        operation: "candidate_enqueue",
        error: new Error("unreachable candidate failure"),
        mutation_accounting: candidateAccounting,
      },
    })).toThrow(/contradicts the validation decision/u);

    const materialValidation = fixture().validation;
    materialValidation.decision = "material_difference_candidate";
    materialValidation.outcome = {
      would_commit: false,
      would_queue_visual_candidate: true,
      would_quarantine: false,
      creates_api_charge: false,
    };
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation: materialValidation,
      mutationFailure: {
        operation: "pointer_commit",
        error: new Error("unreachable pointer failure"),
        mutation_accounting: accounting,
      },
    })).toThrow(/contradicts the validation decision/u);

    const validation = fixture().validation;
    validation.evidence.journal_read_unavailable = {
      status: "unavailable",
      error: { name: "Error", code: null, message: "first observation" },
    };
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      journalReadUnavailable: {
        status: "unavailable",
        error: { name: "Error", code: null, message: "different observation" },
      },
    })).toThrow(/contradicts sealed quarantine evidence/u);
  });

  it("permits a null candidate signature only at an exact sealed pre-enqueue zero-write boundary", () => {
    const validation = fixture().validation;
    validation.decision = "material_difference_candidate";
    validation.outcome = {
      would_commit: false,
      would_queue_visual_candidate: true,
      would_quarantine: false,
      creates_api_charge: false,
    };
    const exactPreWrite = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "candidate_enqueue",
      lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
      unknownWriteCategories: [],
      evidence: {
        boundary: "before_candidate_enqueue",
        candidate_signature: null,
        response_loss_possible: false,
      },
    });
    const prepared = prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      mutationFailure: {
        operation: "candidate_enqueue",
        error: new Error("Prompt preparation failed before enqueue."),
        mutation_accounting: exactPreWrite,
      },
    });
    expect(stage1EvidenceSchemaUpgradeQuarantineSafeAction(
      prepared,
      "unused fallback",
    )).toContain("exact accounting proves no candidate or database write was attempted");

    const unknownWithoutSignature = sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation: "candidate_enqueue",
      lowerBoundCounts: zeroStage1EvidenceSchemaUpgradeMutationCounts(),
      unknownWriteCategories: ["candidate_writes", "database_writes"],
      evidence: {
        boundary: "candidate_upsert_response_pending",
        candidate_signature: null,
        response_loss_possible: true,
      },
    });
    expect(() => prepareStage1EvidenceSchemaUpgradeQuarantineValidation({
      validation,
      mutationFailure: {
        operation: "candidate_enqueue",
        error: new Error("Candidate write response was unavailable."),
        mutation_accounting: unknownWithoutSignature,
      },
    })).toThrow(/exact candidate signature once writes may occur/u);
  });

  it("accepts only an exact content-sealed server receipt bound to its RPC args", () => {
    const args = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(fixture());
    const receipt = serverReceipt(args);
    const accepted = stage1EvidenceSchemaUpgradeQuarantineReceipt(receipt, args);

    expect(accepted).toMatchObject({
      allowed: true,
      reason: "stage1_evidence_schema_upgrade_failure_quarantined",
      quarantine_id: quarantineId,
      failure_sha256: "d".repeat(64),
      evidence_sha256: args.p_evidence.evidence_sha256,
      mutation_counts: {
        database_writes: 5,
        failure_audit_writes: 1,
        quarantine_writes: 3,
        source_state_writes: 1,
      },
    });
    expect(stage1EvidenceSchemaUpgradeQuarantineReceipt([receipt], args).allowed).toBe(true);
  });

  it.each([
    ["extra key", (receipt) => { receipt.extra = true; }],
    ["charge", (receipt) => { receipt.creates_api_charge = true; }],
    ["source swap", (receipt) => {
      receipt.shared_award_source_id = "99999999-9999-4999-8999-999999999999";
    }],
    ["evidence swap", (receipt) => { receipt.evidence_sha256 = "e".repeat(64); }],
    ["bad timestamp", (receipt) => { receipt.recorded_at = "not-a-time"; }],
    ["altered seal", (receipt) => { receipt.receipt_sha256 = "f".repeat(64); }],
  ])("rejects a receipt with %s", (_label, mutate) => {
    const args = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(fixture());
    const receipt = serverReceipt(args);
    mutate(receipt);
    expect(stage1EvidenceSchemaUpgradeQuarantineReceipt(receipt, args)).toMatchObject({
      allowed: false,
      reason: "stage1_evidence_schema_upgrade_quarantine_receipt_invalid",
    });
  });

  it("rejects partial, empty-array, and multi-row RPC responses", () => {
    const args = buildStage1EvidenceSchemaUpgradeQuarantineRpcArgs(fixture());
    expect(stage1EvidenceSchemaUpgradeQuarantineReceipt(null, args).allowed).toBe(false);
    expect(stage1EvidenceSchemaUpgradeQuarantineReceipt([], args).allowed).toBe(false);
    expect(stage1EvidenceSchemaUpgradeQuarantineReceipt([
      serverReceipt(args),
      serverReceipt(args),
    ], args).allowed).toBe(false);
  });
});

function fixture() {
  return {
    source: {
      id: sourceId,
      source_activation_finalization: {
        shared_award_source_id: sourceId,
        source_acquisition_id: acquisitionId,
        source_page_request_id: requestId,
        disposition_item_sha256: dispositionItemSha256,
        finalization_receipt_sha256: finalizationReceiptSha256,
      },
    },
    acquisition: {
      id: acquisitionId,
      origin_source_page_request_id: requestId,
      review_seal: {
        human_source_disposition: {
          guard_sha256: guardSha256,
          activation_guard: { decision_item_sha256: dispositionItemSha256 },
        },
      },
    },
    manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
    failureStage: "capture_validation",
    reasonCode: "web_intake_not_stable",
    detail: "The pre/post intake observations did not agree.",
    safeAction: "Retry the zero-charge capture after the source is stable.",
    validation: {
      schema_version: "awardping.stage1.evidence-schema-upgrade-validation.v1",
      decision: "evidence_failure_quarantine",
      creates_api_charge: false,
      reason: "web_intake_not_stable",
      reasons: [{
        code: "web_intake_not_stable",
        detail: "The pre/post intake observations did not agree.",
      }],
      evidence: {
        source_id: sourceId,
        kind: "webpage",
        stable: false,
        capture: {
          source_id: sourceId,
          captured_at: "2026-08-14T21:00:00.000Z",
          text_hash: "2".repeat(64),
          image_hash: "1".repeat(64),
          file_hash: null,
          layout_hash: "9".repeat(64),
        },
      },
      outcome: {
        would_commit: false,
        would_queue_visual_candidate: false,
        would_quarantine: true,
        creates_api_charge: false,
      },
    },
    r2Binding: null,
    commitRecovery: null,
    candidateArtifacts: null,
  };
}

function mutationFailure(operation, {
  lowerBoundCounts = {},
  unknownWriteCategories = [],
} = {}) {
  const counts = zeroStage1EvidenceSchemaUpgradeMutationCounts();
  Object.assign(counts, lowerBoundCounts);
  return {
    operation,
    error: Object.assign(new Error(`${operation} failed`), {
      code: `${operation}_failed`,
    }),
    mutation_accounting: sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation,
      lowerBoundCounts: counts,
      unknownWriteCategories,
      evidence: { boundary: `${operation}_test_boundary` },
    }),
  };
}

function pointerCommitFailure({
  lowerBoundCounts = {},
  unknownWriteCategories = [],
  cas = recoveredCasReceipt(),
  boundary = "result_built",
  accountingShape = "current",
  journalPersistence = {
    state: "not_started",
    local_journal_writes_lower_bound: 0,
    response_loss_possible: false,
  },
  journalArchive = journalArchiveAccounting(),
  accountingEvidenceExtra = {},
} = {}) {
  const counts = zeroStage1EvidenceSchemaUpgradeMutationCounts();
  Object.assign(counts, lowerBoundCounts);
  const accounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: counts,
    unknownWriteCategories,
    evidence: {
      boundary,
      journal_phase: "recovery_required",
      response_loss_possible: unknownWriteCategories.length > 0
        || (accountingShape === "current" && (
          journalPersistence.response_loss_possible === true
          || journalArchive.response_loss_possible === true
        )),
      ...(accountingShape === "current"
        ? {
            journal_persistence: journalPersistence,
            journal_archive: journalArchive,
          }
        : {}),
      cas,
      ...accountingEvidenceExtra,
    },
  });
  return {
    operation: "pointer_commit",
    error: Object.assign(new Error("pointer_commit failed"), {
      code: "pointer_commit_failed",
    }),
    mutation_accounting: accounting,
  };
}

function journalArchiveAccounting(overrides = {}) {
  const content = {
    schema_version:
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_ARCHIVE_ACCOUNTING_SCHEMA,
    state: "not_started",
    local_journal_archive_writes_lower_bound: 0,
    archive_receipt_acknowledged: false,
    archived_readback_verified: false,
    active_absence_verified: false,
    response_loss_possible: false,
    ...overrides,
  };
  return {
    ...content,
    evidence_sha256: hashJson(content),
  };
}

function pointerCommitReceipt({
  journal,
  mutationFailure: failure,
  candidate,
  outcome = "ambiguous_authority",
  pointerState = "unknown",
  baselineState = "unknown",
  sourceHealth = null,
} = {}) {
  const accounting = failure.mutation_accounting;
  const classified = new Set(["candidate", "old"]).has(pointerState);
  return {
    schema_version: "awardping.stage1.evidence-schema-upgrade-commit-receipt.v1",
    source_id: sourceId,
    context: "stage1_evidence_schema_upgrade",
    operation: "pointer_commit",
    status: "recovery_required",
    creates_api_charge: false,
    transaction_id: journal.transaction_id,
    outcome,
    journal_phase: "recovery_required",
    journal_sha256: journal.journal_sha256,
    journal_archived: false,
    authoritative_pointer_state: pointerState,
    authoritative_baseline_state: baselineState,
    authoritative_pointer_sha256: classified
      ? candidate.candidate_pointer_identity.canonical_sha256
      : null,
    authoritative_baseline_sha256: classified
      ? journal.candidate_baseline.sha256
      : null,
    cas: accounting.evidence.cas,
    cleanup_debt: cleanupDebt(candidate),
    cleanup_delete_performed: false,
    source_health: sourceHealth,
    mutation_count_scope: "confirmed_io_receipts_in_this_invocation",
    mutation_counts: accounting.lower_bound_counts,
    mutation_accounting: accounting,
  };
}

function recoveredCasReceipt() {
  return {
    attempted: true,
    returned: null,
    threw: false,
    recovered: true,
    error_code: null,
    error_message: null,
    confirmed_database_pointer_writes: 0,
    write_attribution: "prior_invocation_not_counted",
  };
}

function thrownCasReceipt() {
  return {
    attempted: true,
    returned: null,
    threw: true,
    recovered: false,
    error_code: "pointer_cas_threw",
    error_message: "Latest-pointer CAS response was unavailable.",
    confirmed_database_pointer_writes: 0,
    write_attribution: "unattributed_after_exception",
  };
}

function cleanupDebt(candidate) {
  const candidateKeys = Object.values(
    candidate.candidate_pointer_identity.projection.latest_object_keys,
  ).sort();
  return {
    schema_version: "awardping.visual-snapshot.latest-only-cleanup-debt.v1",
    reason: "authoritative_pointer_unreadable",
    delete_performed: false,
    requires_authoritative_recheck: true,
    requires_published_reference_graph_check: false,
    candidate_keys: candidateKeys,
    protected_keys: [],
    eligible_keys: [],
    deferred_keys: candidateKeys,
    item_count: candidateKeys.length,
    eligible_count: 0,
  };
}

function recoveryEvidence(
  journal,
  reason = "fresh_active_upgrade_journal_requires_reconciliation",
  safeAction =
    "Keep the source quarantined and reconcile this exact freshly verified journal before retrying.",
) {
  return {
    schema_version: "awardping.stage1.evidence-schema-upgrade-recovery-evidence.v1",
    source_id: sourceId,
    context: "stage1_evidence_schema_upgrade",
    status: "recovery_required",
    creates_api_charge: false,
    journal_sha256: journal.journal_sha256,
    journal,
    reason,
    safe_action: safeAction,
  };
}

function recoveryJournal(candidate, transactionId = "stage1-recovery-test") {
  const prepared = buildStage1EvidenceSchemaUpgradeJournal({
    transactionId,
    sourceId,
    oldBaselineBytes: null,
    oldPointer: null,
    candidateBaselineBytes: Buffer.from('{"kind":"webpage"}\n', "utf8"),
    candidatePointer: candidate.candidate_pointer_identity.projection,
    createdAt: candidate.captured_at,
  });
  return advanceStage1EvidenceSchemaUpgradeJournal(prepared, {
    expectedPhase: "prepared",
    nextPhase: "recovery_required",
    at: candidate.captured_at,
    detail: { outcome: "ambiguous_authority" },
  });
}

function recoveryJournalWithOldAuthority(candidate) {
  const oldCandidate = candidateEvidence({
    version: "0".repeat(32),
    capturedAt: "2026-08-14T20:00:00.000Z",
    imageHash: "7".repeat(64),
    textHash: "8".repeat(64),
    layoutHash: "a".repeat(64),
  });
  const oldPointer = structuredClone(
    oldCandidate.candidate_pointer_identity.projection,
  );
  oldPointer.updated_at = "2026-08-14T20:00:01.000Z";
  const prepared = buildStage1EvidenceSchemaUpgradeJournal({
    transactionId: "stage1-actual-current-accounting",
    sourceId,
    oldBaselineBytes: Buffer.from('{"kind":"old"}\n', "utf8"),
    oldPointer,
    candidateBaselineBytes: Buffer.from('{"kind":"webpage"}\n', "utf8"),
    candidatePointer: candidate.candidate_pointer_identity.projection,
    createdAt: candidate.captured_at,
  });
  return advanceStage1EvidenceSchemaUpgradeJournal(prepared, {
    expectedPhase: "prepared",
    nextPhase: "recovery_required",
    at: candidate.captured_at,
    detail: { outcome: "ambiguous_authority" },
  });
}

function journalAtPhase(candidate, targetPhase) {
  let journal = buildStage1EvidenceSchemaUpgradeJournal({
    transactionId: `stage1-${targetPhase}-test`,
    sourceId,
    oldBaselineBytes: null,
    oldPointer: null,
    candidateBaselineBytes: Buffer.from('{"kind":"webpage"}\n', "utf8"),
    candidatePointer: candidate.candidate_pointer_identity.projection,
    createdAt: candidate.captured_at,
  });
  const path = [
    "local_candidate_written",
    "pointer_cas_attempted",
    "pointer_candidate_committed",
    "completed",
  ];
  if (targetPhase === "recovery_required") {
    return advanceStage1EvidenceSchemaUpgradeJournal(journal, {
      expectedPhase: "prepared",
      nextPhase: "recovery_required",
      at: candidate.captured_at,
      detail: { outcome: "phase_probe" },
    });
  }
  for (const nextPhase of path) {
    if (journal.phase === targetPhase) break;
    journal = advanceStage1EvidenceSchemaUpgradeJournal(journal, {
      expectedPhase: journal.phase,
      nextPhase,
      at: candidate.captured_at,
      detail: { outcome: "phase_probe" },
    });
  }
  return journal;
}

function candidateEvidence({
  layoutRetained = true,
  expansionCount = 0,
  version = "1".repeat(32),
  capturedAt = "2026-08-14T21:00:00.000Z",
  imageHash = "1".repeat(64),
  textHash = "2".repeat(64),
  layoutHash: suppliedLayoutHash = "9".repeat(64),
} = {}) {
  const roles = ["page", "thumb", "text", "meta"];
  if (layoutRetained) roles.push("layout");
  for (let index = 1; index <= expansionCount; index += 1) {
    const suffix = String(index).padStart(2, "0");
    roles.push(`expansion_state_${suffix}`, `expansion_state_${suffix}_layout`);
  }
  const layoutHash = layoutRetained ? suppliedLayoutHash : null;
  const bindings = Object.fromEntries(roles.map((role, index) => [
    role,
    {
      sha256: String((index % 8) + 1).repeat(64),
      byte_length: index + 10,
      content_type: artifactContentType(role),
      hash_mode: "raw_sha256",
    },
  ]));
  const objectKeys = Object.fromEntries(roles.map((role) => [
    role,
    `visual-snapshots/sources/${sourceId}/captures/${version}/${artifactFileName(role)}`,
  ]));
  const pointer = {
    shared_award_source_id: sourceId,
    shared_award_id: "33333333-3333-4333-8333-333333333333",
    source_url: "https://example.test/eligibility",
    source_title: "Eligibility",
    source_page_type: "eligibility",
    kind: "webpage",
    bucket: "awardping-evidence",
    latest_captured_at: capturedAt,
    latest_object_keys: objectKeys,
    latest_hashes: {
      image_hash: imageHash,
      text_hash: textHash,
      body_text_hash: null,
      main_content_hash: null,
      nav_header_footer_hash: null,
      expansion_hash: null,
      layout_hash: layoutHash,
      file_hash: null,
    },
    latest_metadata: {
      artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
      artifact_bindings: bindings,
      retained_artifact_projection: {
        schema: "awardping.capture-retained-artifact-projection.v1",
        kind: "webpage",
        localization_status: layoutRetained
          ? "exact_geometry_available"
          : "evidence_only_geometry_unavailable",
        authoritative: {
          layout_retained: layoutRetained,
          layout_hash: layoutHash,
          expansion_state_count: expansionCount,
        },
      },
    },
    previous_captured_at: null,
    previous_object_keys: {},
    previous_hashes: {},
    previous_metadata: {},
    updated_at: "2026-08-14T21:00:01.000Z",
  };
  return {
    schema_version: "awardping.stage1.evidence-schema-upgrade-candidate-artifacts.v1",
    source_id: sourceId,
    kind: "webpage",
    bucket: "awardping-evidence",
    version,
    captured_at: pointer.latest_captured_at,
    candidate_pointer_identity: visualSnapshotPointerIdentity(pointer),
    journal_sha256: null,
    artifacts: roles.reverse().map((role) => ({
      role,
      bucket: pointer.bucket,
      version,
      object_key: objectKeys[role],
      ...bindings[role],
    })),
    creates_api_charge: false,
    public_fact_authority: false,
  };
}

function artifactFileName(role) {
  const fixed = {
    page: "page.jpg",
    thumb: "thumb.jpg",
    text: "text.txt",
    layout: "layout.json",
    meta: "meta.json",
    pdf: "document.pdf",
  };
  if (fixed[role]) return fixed[role];
  const layout = /^expansion_state_([0-9]+)_layout$/u.exec(role);
  if (layout) return `expansion-state-${layout[1]}-layout.json`;
  const page = /^expansion_state_([0-9]+)$/u.exec(role);
  if (page) return `expansion-state-${page[1]}.jpg`;
  throw new Error(`Unknown artifact role: ${role}`);
}

function artifactContentType(role) {
  if (new Set(["page", "thumb"]).has(role) || /^expansion_state_[0-9]+$/u.test(role)) {
    return "image/jpeg";
  }
  if (role === "text") return "text/plain; charset=utf-8";
  if (role === "pdf") return "application/pdf";
  return "application/json; charset=utf-8";
}

function serverReceipt(args) {
  const receipt = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_RECEIPT_SCHEMA,
    status: "quarantined",
    quarantine_id: quarantineId,
    failure_sha256: "d".repeat(64),
    evidence_sha256: args.p_evidence.evidence_sha256,
    shared_award_source_id: args.p_source_id,
    source_acquisition_id: args.p_acquisition_id,
    source_page_request_id: args.p_request_id,
    reason_code: args.p_reason_code,
    failure_stage: args.p_evidence.failure_stage,
    mutation_count_scope: "quarantine_rpc_only",
    mutation_counts: {
      database_writes: 5,
      failure_audit_writes: 1,
      r2_writes: 0,
      local_baseline_writes: 0,
      candidate_writes: 0,
      quarantine_writes: 3,
      publication_safety_writes: 0,
      source_state_writes: 1,
    },
    release_safety: {
      manual_quarantine_event_writes: 1,
      manual_quarantine_backlog_state_writes: 1,
      stage1_award_registry_writes: 0,
      stage1_award_publication_event_writes: 0,
      stage1_publication_invalidated: false,
      stage1_release_registry_writes: 0,
      stage1_release_state_writes: 0,
      stage1_release_event_writes: 0,
      stage1_release_invalidated: false,
    },
    source_reheld: true,
    audit_inserted: true,
    creates_api_charge: false,
    public_fact_authority: false,
    public_award_update_created: false,
    recorded_at: "2026-08-14T21:30:00.000Z",
    observed_at: "2026-08-14T21:30:01.000Z",
  };
  receipt.receipt_sha256 = hashJson(receipt);
  return receipt;
}

function withoutKey(value, key) {
  const clone = structuredClone(value);
  delete clone[key];
  return clone;
}

function hashJson(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
