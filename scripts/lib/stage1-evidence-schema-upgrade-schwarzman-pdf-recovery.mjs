import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  normalizeStage1BaselineEvidenceWords,
  stage1BaselineActivationTextSha256,
} from "./stage1-baseline-activation-guard.mjs";
import {
  assertStage1EvidenceSchemaUpgradeR2BindingReceipt,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";

export const STAGE1_SCHWARZMAN_PDF_RECOVERY_SCHEMA =
  "awardping.stage1.schwarzman-pdf-sealed-text-recovery.v1";

export const STAGE1_SCHWARZMAN_PDF_RECOVERY_SOURCE_ID =
  "719ffd9e-f97c-5c6d-8a5a-71b617cadf49";

const sourceId = STAGE1_SCHWARZMAN_PDF_RECOVERY_SOURCE_ID;
const acquisitionId = "05a81494-e659-5185-a08f-913119967f4b";
const requestId = "cf731f52-f02d-581e-bf52-c698f53d87d8";
const finalUrl =
  "https://www.schwarzmanscholars.org/wp-content/uploads/2026/04/2026-Application-Instructions.pdf";
const fileHash = "fac3353cf079c7acfe7eaa7d8da685eba8275181d500373a149f2fdeff429263";
const legacyCaptureTimestamp = "2026-08-03T18:52:07.825Z";
const legacyLocalGeneration = "2026-08-03T18-52-07-825Z";
const legacyR2Generation = "b50b827daa5e6a0e7b44d3c7fb9e8502";
const localCapturePrefix = `sources/${sourceId}/captures/${legacyLocalGeneration}/`;
const r2CapturePrefix =
  `visual-snapshots/sources/${sourceId}/captures/${legacyR2Generation}/`;

// The omitted passage is fixed by the byte-pinned sealed-intake and legacy
// texts; this list is its TOKENIZATION under the live
// normalizeStage1BaselineEvidenceWords, which since bc30cba splits case-fused
// tokens at lowercase-to-uppercase transitions ("YouTube" -> "you", "tube").
// Re-derive these tokens (and both normalized word counts) if that normalizer
// version changes again; the underlying pinned text bytes never change.
const omittedWords = Object.freeze([
  "or",
  "that",
  "we",
  "are",
  "no",
  "longer",
  "accepting",
  "videos",
  "shared",
  "via",
  "google",
  "drive",
  "save",
  "your",
  "video",
  "on",
  "you",
  "tube",
  "or",
]);

const exactContract = deepFreeze({
  source_id: sourceId,
  acquisition_id: acquisitionId,
  request_id: requestId,
  final_url: finalUrl,
  acquisition_kind: "historical_import",
  notification_mode: "baseline_only",
  onboarding_batch_id: "stage1-national-25-reviewed-sources-v1",
  acquisition_seal_sha256:
    "56a60c7a9f8060af0c9320a1039c1201e109d6a0763d210d9271afd30d6aeec2",
  activation_guard_sha256:
    "2cea30f2e49bbdeb75d1d4581126e8658b55af52f0630a00f3fef18eb5a4f434",
  finalization_receipt_sha256:
    "5577bfb230eba67f0aa5b7e61a68dc2e5cf9dd973a68886aeeb37a66500272df",
  file_sha256: fileHash,
  file_bytes: 148631,
  reviewed_page_type: "pdf",
  reviewed_roles: ["current_documents"],
  reviewed_quotes: [
    "The U.S./Global Application Deadline is September 9, 2026, at 3:00 PM, Eastern Daylight Time (EDT).",
    "To be eligible for the current application cycle, applicants must complete all requirements and have an undergraduate degree conferred by August 1, 2027.",
  ],
  sealed_intake: {
    local_prefix:
      `intake-artifacts/requests/${requestId}/sha256/${fileHash}/`,
    capture_metadata_sha256:
      "9ef36a28fe99fb92e38f1a715bfe47e095fdd1840e3c80cf182dda297d664e7d",
    capture_metadata_bytes: 1036,
    text_object_sha256:
      "726c9b2f3e864c31e36443d42549563558e56e9f5987e044b9b6ef389c0446ac",
    text_object_bytes: 22398,
    semantic_text_sha256:
      "9b50d2748660349bd5d4148453a0f2753cb668ebdf6a3e72d7aed43f43f53aaa",
    semantic_text_length: 22281,
    normalized_text_sha256:
      "9b50d2748660349bd5d4148453a0f2753cb668ebdf6a3e72d7aed43f43f53aaa",
    normalized_word_count: 3491,
  },
  // The source's baseline.json is a LIVE pointer file: the nightly
  // baseline-refresh lane legitimately rewrites it on unchanged-content
  // refreshes, so whole-file byte identity is not a stable property of that
  // file. The stable-subfield contract below pins everything the retired
  // byte-pin materially protected while allowing the pointer to advance to a
  // newer capture generation of the same unchanged content.
  baseline_pointer: {
    minimum_captured_at: legacyCaptureTimestamp,
    stage1_baseline_activation_canonical_sha256:
      "cadc02e99b7003c7b1517745f90b5c4ca85b59c51bc98016f469a3e4221928d8",
  },
  legacy: {
    captured_at: legacyCaptureTimestamp,
    local_generation: legacyLocalGeneration,
    local_prefix: localCapturePrefix,
    metadata_sha256:
      "28df8d2d771e27ee035e661ef8f3f224835eb239a630d94cfd5bf99eb4f4ae0a",
    metadata_bytes: 4520,
    text_object_sha256:
      "a0d5939e0ea4b7bb4e79b69cd7ff76ef62262e870a6609193fadb132809d7717",
    text_object_bytes: 22301,
    semantic_text_sha256:
      "052b7416552971dee28c1b61d89dbb32aedae2b8ea9d711df0e8084f4d348314",
    semantic_text_length: 22184,
    normalized_text_sha256:
      "0061de3cda4d1f8bba01263f15d7f46e1a347c32a97801305b225fdc5f1239ea",
    normalized_word_count: 3472,
    r2_generation: legacyR2Generation,
    r2_prefix: r2CapturePrefix,
    r2_binding_receipt_sha256:
      "4185b53bc54c7a1c1968c1ea35a0117d0e7ceb03318fc167f3c4385444bfef40",
    r2_pointer_sha256:
      "5d7a63e87a526b27c55fede160a80d7d6a3811d9ec13140f9686782392300f80",
    r2_metadata_sha256:
      "2c7c873b9b56e90361e8a964ad7e2cddc9552b0603ca898cd56f98ea0350f403",
  },
  omission: {
    omitted_words: omittedWords,
    omitted_words_sha256:
      "e38bbb90be36023d3d61be49a1a1138e65411003dd154ef1cc42dedf5ad53b20",
  },
});

/**
 * Reads only the exact sealed intake cache generation used by the one-source
 * recovery contract. Real-path containment prevents a junction or symlink
 * from redirecting the read outside the configured archive root.
 */
export function loadStage1SchwarzmanPdfSealedIntakeArtifacts({ archiveRoot } = {}) {
  const root = requiredText(archiveRoot, "archive root");
  const bodies = {};
  const paths = {};
  for (const [role, fileName] of Object.entries({
    capture_metadata: "capture.json",
    pdf: "document.pdf",
    text: "text.txt",
  })) {
    const loaded = readContainedFile(
      root,
      `${exactContract.sealed_intake.local_prefix}${fileName}`,
    );
    bodies[role] = loaded.body;
    paths[role] = loaded.path;
  }
  return { bodies, paths };
}

/**
 * Commits the two recovered candidate artifacts as one fail-closed local
 * mutation. Both replacements are staged before either target changes. A
 * durable in-generation fence exists for the complete mutation window, and
 * any caught failure restores and byte-verifies both exact preimages.
 */
export function commitStage1SchwarzmanPdfRecoveryCandidateFiles(input = {}) {
  return commitStage1PdfRecoveryCandidateFiles(input, {
    source_id: sourceId,
    forbidden_captured_at: legacyCaptureTimestamp,
    recovered_text_object_sha256: exactContract.sealed_intake.text_object_sha256,
    recovered_text_object_bytes: exactContract.sealed_intake.text_object_bytes,
  });
}

export function loadStage1SchwarzmanPdfRecoveryCandidatePreimages(input = {}) {
  const source = requiredText(input.sourceId, "candidate preimage source id");
  if (source !== sourceId) {
    throw candidateMutationError(
      "pdf_text_recovery_candidate_source_not_allowlisted",
      "The candidate preimage source is not the exact recovery source.",
    );
  }
  const capturedAt = requiredIsoTimestamp(
    input.capturedAt,
    "pdf_text_recovery_candidate_timestamp_invalid",
  );
  if (capturedAt === legacyCaptureTimestamp) {
    throw candidateMutationError(
      "pdf_text_recovery_candidate_generation_not_new",
      "The recovery may not read or mutate the legacy authoritative capture generation.",
    );
  }
  const context = buildCandidateMutationContext({
    archiveRoot: input.archiveRoot,
    sourceId: source,
    capturedAt,
    candidateDir: input.candidateDir,
    textPath: input.textPath,
    metadataPath: input.metadataPath,
  });
  assertCandidateMutationBoundary(context);
  const textBytes = readFileSync(context.textPath);
  const metadataBytes = readFileSync(context.metadataPath);
  assertCandidateMutationBoundary(context);
  return {
    text_bytes: textBytes,
    metadata_bytes: metadataBytes,
    text_identity: bufferIdentity(textBytes),
    metadata_identity: bufferIdentity(metadataBytes),
  };
}

export function assertStage1SchwarzmanPdfRecoveryCandidateNotFenced(input = {}) {
  if (input.sourceId !== sourceId) return { applies: false, fenced: false };
  const capturedAt = requiredIsoTimestamp(
    input.capturedAt,
    "pdf_text_recovery_candidate_timestamp_invalid",
  );
  const context = buildCandidateMutationContext({
    archiveRoot: input.archiveRoot,
    sourceId,
    capturedAt,
    candidateDir: input.candidateDir,
    textPath: input.textPath,
    metadataPath: input.metadataPath,
  });
  const markerPath = candidateMutationMarkerPath(context.candidateDir);
  if (existsSync(markerPath)) {
    assertCandidateMutationBoundary(context, [markerPath]);
    throw candidateMutationError(
      "pdf_text_recovery_candidate_generation_fenced",
      "The candidate generation contains an incomplete recovery fence and cannot be consumed.",
      { marker_path: markerPath },
    );
  }
  return { applies: true, fenced: false };
}

/**
 * Test seam for the filesystem transaction. Production must call the exact
 * Schwarzman wrapper above so this mechanism cannot become a generic repair
 * or arbitrary archive writer.
 */
export function commitStage1PdfRecoveryCandidateFiles(input = {}, contract = {}) {
  const source = requiredText(input.sourceId, "candidate mutation source id");
  if (source !== contract.source_id) {
    throw candidateMutationError(
      "pdf_text_recovery_candidate_source_not_allowlisted",
      "The candidate mutation source is not the exact recovery source.",
    );
  }
  const capturedAt = requiredIsoTimestamp(
    input.capturedAt,
    "pdf_text_recovery_candidate_timestamp_invalid",
  );
  if (capturedAt === contract.forbidden_captured_at) {
    throw candidateMutationError(
      "pdf_text_recovery_candidate_generation_not_new",
      "The recovery may not mutate the legacy authoritative capture generation.",
    );
  }

  const nextTextBytes = Buffer.from(input.nextTextBytes || []);
  const nextMetadataBytes = Buffer.from(input.nextMetadataBytes || []);
  assertExactMutationBytes(
    nextTextBytes,
    contract.recovered_text_object_sha256,
    contract.recovered_text_object_bytes,
    "recovered text",
  );
  if (!nextMetadataBytes.byteLength) {
    throw candidateMutationError(
      "pdf_text_recovery_candidate_metadata_empty",
      "The staged recovered metadata is empty.",
    );
  }

  const context = buildCandidateMutationContext({
    archiveRoot: input.archiveRoot,
    sourceId: source,
    capturedAt,
    candidateDir: input.candidateDir,
    textPath: input.textPath,
    metadataPath: input.metadataPath,
  });
  const expectedPreimages = {
    text: mutationIdentity(
      input.expectedTextPreimageSha256,
      input.expectedTextPreimageBytes,
      "text preimage",
    ),
    meta: mutationIdentity(
      input.expectedMetadataPreimageSha256,
      input.expectedMetadataPreimageBytes,
      "metadata preimage",
    ),
  };
  const nextIdentities = {
    text: bufferIdentity(nextTextBytes),
    meta: bufferIdentity(nextMetadataBytes),
  };
  const markerPath = candidateMutationMarkerPath(context.candidateDir);
  if (existsSync(markerPath)) {
    assertCandidateMutationBoundary(context, [markerPath]);
    throw candidateMutationError(
      "pdf_text_recovery_candidate_generation_fenced",
      "The candidate generation already contains an incomplete recovery fence.",
      { marker_path: markerPath },
    );
  }

  assertCandidateMutationBoundary(context);
  const preimages = {
    text: readFileSync(context.textPath),
    meta: readFileSync(context.metadataPath),
  };
  assertExactMutationBytes(
    preimages.text,
    expectedPreimages.text.sha256,
    expectedPreimages.text.byte_length,
    "text preimage",
  );
  assertExactMutationBytes(
    preimages.meta,
    expectedPreimages.meta.sha256,
    expectedPreimages.meta.byte_length,
    "metadata preimage",
  );

  const transactionId = randomUUID();
  const stagePaths = {
    text: join(
      context.candidateDir,
      `.stage1-schwarzman-pdf-recovery.${transactionId}.text.stage`,
    ),
    meta: join(
      context.candidateDir,
      `.stage1-schwarzman-pdf-recovery.${transactionId}.meta.stage`,
    ),
  };
  let markerCreated = false;
  try {
    stageCandidateMutationFile(context, stagePaths.text, nextTextBytes);
    stageCandidateMutationFile(context, stagePaths.meta, nextMetadataBytes);
    assertCandidateMutationBoundary(context, Object.values(stagePaths));
    assertFileBytes(stagePaths.text, nextTextBytes, "staged recovered text");
    assertFileBytes(stagePaths.meta, nextMetadataBytes, "staged recovered metadata");

    const markerBytes = Buffer.from(`${JSON.stringify({
      schema_version:
        "awardping.stage1.schwarzman-pdf-recovery-candidate-mutation.v1",
      status: "mutation_in_progress",
      source_id: source,
      captured_at: capturedAt,
      transaction_id: transactionId,
      candidate_directory: relative(
        context.archiveRoot,
        context.candidateDir,
      ).replace(/\\/g, "/"),
      preimages: expectedPreimages,
      replacements: nextIdentities,
      targets: { text: "text.txt", meta: "meta.json" },
      authoritative: false,
    }, null, 2)}\n`, "utf8");
    stageCandidateMutationFile(context, markerPath, markerBytes);
    markerCreated = true;
    assertCandidateMutationBoundary(context, [
      markerPath,
      ...Object.values(stagePaths),
    ]);

    invokeCandidateMutationFault(input.faultInjector, "before_text_replace");
    assertCandidateMutationState(context, {
      text: preimages.text,
      meta: preimages.meta,
    });
    replaceStagedCandidateFile({
      context,
      stagePath: stagePaths.text,
      targetPath: context.textPath,
      expectedTargetBytes: preimages.text,
      expectedBytes: nextTextBytes,
      markerPath,
    });
    invokeCandidateMutationFault(input.faultInjector, "after_text_replace");
    invokeCandidateMutationFault(input.faultInjector, "before_metadata_replace");
    assertCandidateMutationState(context, {
      text: nextTextBytes,
      meta: preimages.meta,
    });
    replaceStagedCandidateFile({
      context,
      stagePath: stagePaths.meta,
      targetPath: context.metadataPath,
      expectedTargetBytes: preimages.meta,
      expectedBytes: nextMetadataBytes,
      markerPath,
    });
    invokeCandidateMutationFault(input.faultInjector, "after_metadata_replace");
    assertCandidateMutationBoundary(context, [markerPath]);
    assertFileBytes(context.textPath, nextTextBytes, "committed recovered text");
    assertFileBytes(context.metadataPath, nextMetadataBytes, "committed recovered metadata");
    removeCandidateTransactionFile(context, markerPath);
    try {
      cleanupCandidateTransactionFiles(context, Object.values(stagePaths));
    } catch {
      // Both staged replacements were consumed by successful renames. Any
      // non-target cleanup residue is diagnostic only after the fence is gone.
    }
    return {
      status: "committed",
      source_id: source,
      captured_at: capturedAt,
      transaction_id: transactionId,
      replacements: nextIdentities,
      rollback_performed: false,
      fence_removed: true,
      authoritative: false,
    };
  } catch (error) {
    if (!markerCreated) {
      cleanupCandidateTransactionFiles(context, Object.values(stagePaths));
      throw error;
    }
    const rollback = rollbackCandidateMutation({
      context,
      markerPath,
      stagePaths,
      preimages,
      replacements: {
        text: nextTextBytes,
        meta: nextMetadataBytes,
      },
      faultInjector: input.faultInjector,
    });
    if (rollback.verified) {
      const failure = candidateMutationError(
        "pdf_text_recovery_candidate_transaction_failed_rolled_back",
        `The recovered candidate transaction failed and both exact preimages were restored: ${errorMessage(error)}`,
        {
          transaction_id: transactionId,
          rollback_verified: true,
          original_error: errorMessage(error),
        },
        error,
      );
      throw failure;
    }
    throw candidateMutationError(
      "pdf_text_recovery_candidate_rollback_unverified",
      "The recovered candidate transaction failed and exact rollback could not be proven; the non-authoritative generation remains fenced.",
      {
        transaction_id: transactionId,
        rollback_verified: false,
        marker_path: markerPath,
        original_error: errorMessage(error),
        rollback_errors: rollback.errors,
      },
      error,
    );
  }
}

/**
 * Pure, source-specific repair gate. It does not write the candidate capture.
 * The caller may apply recovered_text_bytes only to a newly captured,
 * non-authoritative generation after this exact gate accepts it.
 */
export function evaluateStage1SchwarzmanPdfRecovery(input = {}) {
  return evaluateStage1PdfParserOmissionRecovery(input, exactContract);
}

/**
 * Testable contract engine. Production must call the exact Schwarzman wrapper
 * above; accepting an arbitrary contract at the worker boundary would turn a
 * one-source repair into a general waiver.
 */
export function evaluateStage1PdfParserOmissionRecovery(input = {}, contract = {}) {
  const exactInputSourceId = Object.hasOwn(input, "exactSourceId")
    ? input.exactSourceId
    : input.sourceId;
  if (exactInputSourceId !== contract.source_id) {
    return rejected(false, "source_not_allowlisted");
  }

  try {
    const acquisition = input.immutableAcquisition?.acquisition
      ? objectValue(input.immutableAcquisition.acquisition)
      : objectValue(input.immutableAcquisition);
    const disposition = objectValue(
      acquisition.review_seal?.human_source_disposition,
    );
    const guard = objectValue(disposition.activation_guard);
    const review = objectValue(disposition.effective_source_review);
    const finalization = objectValue(input.sourceActivationFinalization);
    const baseline = objectValue(input.existingBaseline);
    const activation = objectValue(
      baseline.summary_metadata?.stage1_baseline_activation,
    );
    const existing = objectValue(input.existingCapture);
    const prospective = objectValue(input.prospectiveCapture);
    const sealedBodies = artifactBodies(input.sealedIntakeArtifacts, [
      "capture_metadata",
      "pdf",
      "text",
    ]);
    const existingArtifacts = artifactBodies(input.existingPreparedArtifacts, [
      "meta",
      "pdf",
      "text",
    ]);
    const prospectiveArtifacts = artifactBodies(input.prospectivePreparedArtifacts, [
      "meta",
      "pdf",
      "text",
    ]);

    assert(input.sourceKind === "pdf", "source_kind_not_allowlisted");
    assert(input.reviewedFinalUrl === contract.final_url, "reviewed_final_url_not_allowlisted");
    assertAcquisition({ acquisition, disposition, guard, review, finalization, contract });
    assertLegacyBaseline({
      baseline,
      baselineBytes: input.existingBaselineBytes,
      activation,
      existing,
      artifacts: existingArtifacts,
      contract,
    });
    assertR2Authority(input.authoritativeExistingR2Binding, contract);
    const sealed = assertSealedIntake(sealedBodies, contract);
    assertProspectiveCapture({
      prospective,
      artifacts: prospectiveArtifacts,
      contract,
    });

    const omission = analyzeStage1PdfParserOmission({
      sealedText: sealed.semanticText,
      legacyText: existing.text,
    });
    assert(omission.legacy_is_exact_subsequence, "legacy_text_not_exact_subsequence");
    assert(omission.sealed_word_count === contract.sealed_intake.normalized_word_count, "sealed_word_count_not_allowlisted");
    assert(omission.legacy_word_count === contract.legacy.normalized_word_count, "legacy_word_count_not_allowlisted");
    assert(sameJson(omission.omitted_words, contract.omission.omitted_words), "omitted_words_not_allowlisted");
    assert(sha256Json(omission.omitted_words) === contract.omission.omitted_words_sha256, "omitted_words_digest_not_allowlisted");
    assert(omission.omitted_word_count === 19, "omitted_word_count_not_allowlisted");
    assertQuotes(existing.text, review.evidence_quotes, "legacy");
    assertQuotes(sealed.semanticText, review.evidence_quotes, "sealed");

    const prospectiveTextIdentity = semanticTextIdentity(prospective.text);
    assert(
      sameJson(prospectiveTextIdentity, {
        sha256: contract.legacy.semantic_text_sha256,
        length: contract.legacy.semantic_text_length,
        normalized_sha256: contract.legacy.normalized_text_sha256,
      })
        || sameJson(prospectiveTextIdentity, {
          sha256: contract.sealed_intake.semantic_text_sha256,
          length: contract.sealed_intake.semantic_text_length,
          normalized_sha256: contract.sealed_intake.normalized_text_sha256,
        }),
      "prospective_parser_text_not_allowlisted",
    );

    const evidence = {
      schema_version: STAGE1_SCHWARZMAN_PDF_RECOVERY_SCHEMA,
      status: "accepted",
      source_id: contract.source_id,
      source_acquisition_id: contract.acquisition_id,
      source_page_request_id: contract.request_id,
      final_url: contract.final_url,
      activation_guard_sha256: contract.activation_guard_sha256,
      finalization_receipt_sha256: contract.finalization_receipt_sha256,
      legacy_authority: {
        captured_at: contract.legacy.captured_at,
        local_generation: contract.legacy.local_generation,
        r2_generation: contract.legacy.r2_generation,
        r2_binding_receipt_sha256: contract.legacy.r2_binding_receipt_sha256,
        r2_pointer_sha256: contract.legacy.r2_pointer_sha256,
        pdf_sha256: contract.file_sha256,
        text_sha256: contract.legacy.semantic_text_sha256,
        normalized_text_sha256: contract.legacy.normalized_text_sha256,
        text_length: contract.legacy.semantic_text_length,
      },
      prospective_observation: {
        captured_at: prospective.captured_at,
        pdf_sha256: prospective.file_hash,
        pdf_bytes: prospective.file_bytes,
        parser_text_sha256: prospectiveTextIdentity.sha256,
        parser_normalized_text_sha256: prospectiveTextIdentity.normalized_sha256,
        parser_text_length: prospectiveTextIdentity.length,
        parser_text_object_sha256: sha256(prospectiveArtifacts.text),
        parser_text_object_bytes: prospectiveArtifacts.text.byteLength,
        parser_metadata_object_sha256: sha256(prospectiveArtifacts.meta),
        parser_metadata_object_bytes: prospectiveArtifacts.meta.byteLength,
      },
      sealed_intake_authority: {
        pdf_sha256: contract.file_sha256,
        pdf_bytes: contract.file_bytes,
        text_object_sha256: contract.sealed_intake.text_object_sha256,
        text_object_bytes: contract.sealed_intake.text_object_bytes,
        semantic_text_sha256: contract.sealed_intake.semantic_text_sha256,
        normalized_text_sha256: contract.sealed_intake.normalized_text_sha256,
        semantic_text_length: contract.sealed_intake.semantic_text_length,
      },
      parser_omission: {
        legacy_is_exact_subsequence: true,
        sealed_word_count: omission.sealed_word_count,
        legacy_word_count: omission.legacy_word_count,
        omitted_word_count: omission.omitted_word_count,
        omitted_words: omission.omitted_words,
        omitted_words_sha256: contract.omission.omitted_words_sha256,
      },
      recovery: {
        mode: "replace_new_generation_parser_text_with_exact_sealed_intake_text",
        same_pdf_bytes_verified: true,
        legacy_and_recovered_text_equal: false,
        recovered_text_sha256: contract.sealed_intake.semantic_text_sha256,
        recovered_text_length: contract.sealed_intake.semantic_text_length,
        recovered_text_object_sha256: contract.sealed_intake.text_object_sha256,
        recovered_text_object_bytes: contract.sealed_intake.text_object_bytes,
      },
      limitations: [
        "legacy_pdf_parser_omitted_19_sealed_intake_word_tokens",
        "legacy_and_recovered_semantic_text_are_not_treated_as_equal",
        "repair_authority_is_limited_to_the_exact_sealed_intake_text_and_same_pdf_bytes",
      ],
      authorized_local_candidate_mutation: {
        scope: "new_uncommitted_capture_generation_only",
        captured_at: prospective.captured_at,
        roles: ["text", "meta"],
        authoritative: false,
      },
      creates_api_charge: false,
      database_writes: 0,
      r2_writes: 0,
      local_baseline_writes: 0,
      public_fact_authority: false,
    };
    evidence.receipt_sha256 = receiptSha256(evidence);
    return {
      applies: true,
      accepted: true,
      reason: "exact_schwarzman_sealed_intake_text_recovery_verified",
      evidence,
      recovered_text: sealed.semanticText,
      recovered_text_bytes: Buffer.from(`${sealed.semanticText}\n`, "utf8"),
      immutable_acquisition_identity: {
        file_hash: contract.file_sha256,
        text_hash: contract.sealed_intake.semantic_text_sha256,
      },
    };
  } catch (error) {
    return rejected(true, errorMessage(error));
  }
}

/**
 * Revalidates the compact receipt at the independent capture decision gate.
 * Artifact bodies are verified by the producer and by the ordinary retained-
 * artifact validators; this function binds the receipt to the exact old and
 * prospective capture identities without treating their text hashes as equal.
 */
export function evaluateStage1SchwarzmanPdfRecoveryReceipt(input = {}) {
  const exactInputSourceId = Object.hasOwn(input, "exactSourceId")
    ? input.exactSourceId
    : input.sourceId;
  if (exactInputSourceId !== sourceId) {
    return rejected(false, "source_not_allowlisted");
  }
  try {
    const receipt = objectValue(input.receipt);
    const sealed = objectValue(input.sealedAcquisition);
    const existing = objectValue(input.existingCapture);
    const prospective = objectValue(input.prospectiveCapture);
    const activation = objectValue(input.existingBaselineActivation);
    const legacyAuthority = objectValue(receipt.legacy_authority);
    const observation = objectValue(receipt.prospective_observation);
    const sealedAuthority = objectValue(receipt.sealed_intake_authority);
    const omissionReceipt = objectValue(receipt.parser_omission);
    const recoveryReceipt = objectValue(receipt.recovery);
    const authorizedMutation = objectValue(
      receipt.authorized_local_candidate_mutation,
    );
    assert(receipt.schema_version === STAGE1_SCHWARZMAN_PDF_RECOVERY_SCHEMA, "recovery_receipt_schema_invalid");
    assert(receipt.status === "accepted", "recovery_receipt_not_accepted");
    assert(receipt.receipt_sha256 === receiptSha256(receipt), "recovery_receipt_sha256_invalid");
    assert(receipt.source_id === sourceId, "recovery_receipt_source_not_allowlisted");
    assert(receipt.source_acquisition_id === acquisitionId, "recovery_receipt_acquisition_not_allowlisted");
    assert(receipt.source_page_request_id === requestId, "recovery_receipt_request_not_allowlisted");
    assert(receipt.final_url === finalUrl, "recovery_receipt_url_not_allowlisted");
    assert(receipt.activation_guard_sha256 === exactContract.activation_guard_sha256, "recovery_receipt_guard_not_allowlisted");
    assert(receipt.finalization_receipt_sha256 === exactContract.finalization_receipt_sha256, "recovery_receipt_finalization_not_allowlisted");
    assert(sameJson(legacyAuthority, {
      captured_at: legacyCaptureTimestamp,
      local_generation: legacyLocalGeneration,
      r2_generation: legacyR2Generation,
      r2_binding_receipt_sha256: exactContract.legacy.r2_binding_receipt_sha256,
      r2_pointer_sha256: exactContract.legacy.r2_pointer_sha256,
      pdf_sha256: fileHash,
      text_sha256: exactContract.legacy.semantic_text_sha256,
      normalized_text_sha256: exactContract.legacy.normalized_text_sha256,
      text_length: exactContract.legacy.semantic_text_length,
    }), "recovery_receipt_legacy_authority_not_allowlisted");
    assert(sameJson(sealedAuthority, {
      pdf_sha256: fileHash,
      pdf_bytes: exactContract.file_bytes,
      text_object_sha256: exactContract.sealed_intake.text_object_sha256,
      text_object_bytes: exactContract.sealed_intake.text_object_bytes,
      semantic_text_sha256: exactContract.sealed_intake.semantic_text_sha256,
      normalized_text_sha256: exactContract.sealed_intake.normalized_text_sha256,
      semantic_text_length: exactContract.sealed_intake.semantic_text_length,
    }), "recovery_receipt_sealed_authority_not_allowlisted");
    assert(omissionReceipt.legacy_is_exact_subsequence === true, "recovery_receipt_subsequence_proof_missing");
    assert(omissionReceipt.sealed_word_count === exactContract.sealed_intake.normalized_word_count, "recovery_receipt_sealed_word_count_not_allowlisted");
    assert(omissionReceipt.legacy_word_count === exactContract.legacy.normalized_word_count, "recovery_receipt_legacy_word_count_not_allowlisted");
    assert(omissionReceipt.omitted_word_count === 19, "recovery_receipt_omission_count_not_allowlisted");
    assert(sameJson(omissionReceipt.omitted_words, omittedWords), "recovery_receipt_omitted_words_not_allowlisted");
    assert(omissionReceipt.omitted_words_sha256 === exactContract.omission.omitted_words_sha256, "recovery_receipt_omitted_words_digest_not_allowlisted");
    assert(sameJson(recoveryReceipt, {
      mode: "replace_new_generation_parser_text_with_exact_sealed_intake_text",
      same_pdf_bytes_verified: true,
      legacy_and_recovered_text_equal: false,
      recovered_text_sha256: exactContract.sealed_intake.semantic_text_sha256,
      recovered_text_length: exactContract.sealed_intake.semantic_text_length,
      recovered_text_object_sha256: exactContract.sealed_intake.text_object_sha256,
      recovered_text_object_bytes: exactContract.sealed_intake.text_object_bytes,
    }), "recovery_receipt_recovered_identity_not_allowlisted");
    assert(sameJson(receipt.limitations, [
      "legacy_pdf_parser_omitted_19_sealed_intake_word_tokens",
      "legacy_and_recovered_semantic_text_are_not_treated_as_equal",
      "repair_authority_is_limited_to_the_exact_sealed_intake_text_and_same_pdf_bytes",
    ]), "recovery_receipt_limitations_not_allowlisted");
    assert(sameJson(authorizedMutation, {
      scope: "new_uncommitted_capture_generation_only",
      captured_at: prospective.captured_at,
      roles: ["text", "meta"],
      authoritative: false,
    }), "recovery_receipt_candidate_mutation_scope_not_allowlisted");
    assert(receipt.creates_api_charge === false, "recovery_receipt_charge_claim_invalid");
    assert(receipt.database_writes === 0 && receipt.r2_writes === 0 && receipt.local_baseline_writes === 0, "recovery_receipt_mutation_claim_invalid");
    assert(receipt.public_fact_authority === false, "recovery_receipt_public_authority_invalid");

    assert(input.kind === "pdf", "recovery_kind_not_allowlisted");
    assert(input.reviewedFinalUrl === finalUrl, "recovery_reviewed_url_not_allowlisted");
    assert(input.activationGuardSha256 === exactContract.activation_guard_sha256, "recovery_guard_not_allowlisted");
    assert(sealed.file_hash_exact === fileHash, "recovery_sealed_pdf_not_allowlisted");
    assert(sealed.normalized_text_hash_exact === exactContract.sealed_intake.normalized_text_sha256, "recovery_sealed_text_not_allowlisted");
    assert(sealed.text_hash === exactContract.sealed_intake.semantic_text_sha256, "recovery_sealed_semantic_hash_not_allowlisted");
    assert(sealed.source_acquisition_id_exact === acquisitionId, "recovery_sealed_acquisition_not_allowlisted");
    assert(sealed.request_id_exact === requestId, "recovery_sealed_request_not_allowlisted");
    assert(sealed.final_url_exact === finalUrl, "recovery_sealed_url_not_allowlisted");
    assert(sealed.page_type_exact === "pdf", "recovery_sealed_page_type_not_allowlisted");
    assert(sameJson(sealed.reviewed_roles_exact, ["current_documents"]), "recovery_sealed_roles_not_allowlisted");

    assert(existing.kind === "pdf" && existing.source?.id === sourceId, "recovery_legacy_source_not_allowlisted");
    // The existing record at this gate is derived from the live baseline
    // pointer, which the nightly refresh lane advances across
    // unchanged-content generations. Its content identity stays fully pinned
    // below (URL, exact PDF bytes, exact legacy semantic and normalized
    // text), so only the generation timestamp may move forward from the
    // legacy authority - never back, and never inexactly.
    const existingCapturedAtMs = Date.parse(String(existing.captured_at ?? ""));
    assert(
      Number.isFinite(existingCapturedAtMs)
        && new Date(existingCapturedAtMs).toISOString() === existing.captured_at,
      "recovery_legacy_timestamp_invalid",
    );
    assert(
      existingCapturedAtMs >= Date.parse(legacyCaptureTimestamp),
      "recovery_legacy_timestamp_regressed",
    );
    assert(existing.final_url === finalUrl, "recovery_legacy_url_not_allowlisted");
    assert(existing.file_hash === fileHash && existing.file_bytes === exactContract.file_bytes, "recovery_legacy_pdf_not_allowlisted");
    assert(existing.text_hash === exactContract.legacy.semantic_text_sha256, "recovery_legacy_text_not_allowlisted");
    assert(existing.text_length === exactContract.legacy.semantic_text_length, "recovery_legacy_text_length_not_allowlisted");
    assert(stage1BaselineActivationTextSha256(existing.text) === exactContract.legacy.normalized_text_sha256, "recovery_legacy_normalized_text_not_allowlisted");

    assert(prospective.kind === "pdf" && prospective.source?.id === sourceId, "recovery_prospective_source_not_allowlisted");
    assert(Number.isFinite(Date.parse(prospective.captured_at)), "recovery_prospective_timestamp_invalid");
    assert(prospective.final_url === finalUrl, "recovery_prospective_url_not_allowlisted");
    assert(prospective.file_hash === fileHash && prospective.file_bytes === exactContract.file_bytes, "recovery_prospective_pdf_not_allowlisted");
    assert(prospective.text_hash === exactContract.sealed_intake.semantic_text_sha256, "recovery_prospective_text_not_allowlisted");
    assert(prospective.text_length === exactContract.sealed_intake.semantic_text_length, "recovery_prospective_text_length_not_allowlisted");
    assert(stage1BaselineActivationTextSha256(prospective.text) === exactContract.sealed_intake.normalized_text_sha256, "recovery_prospective_normalized_text_not_allowlisted");
    assert(sameJson(observation, {
      captured_at: prospective.captured_at,
      pdf_sha256: fileHash,
      pdf_bytes: exactContract.file_bytes,
      parser_text_sha256: observation.parser_text_sha256,
      parser_normalized_text_sha256: observation.parser_normalized_text_sha256,
      parser_text_length: observation.parser_text_length,
      parser_text_object_sha256: observation.parser_text_object_sha256,
      parser_text_object_bytes: observation.parser_text_object_bytes,
      parser_metadata_object_sha256: observation.parser_metadata_object_sha256,
      parser_metadata_object_bytes: observation.parser_metadata_object_bytes,
    }), "recovery_receipt_prospective_observation_shape_invalid");
    const allowedParserObservation = [
      {
        parser_text_sha256: exactContract.legacy.semantic_text_sha256,
        parser_normalized_text_sha256: exactContract.legacy.normalized_text_sha256,
        parser_text_length: exactContract.legacy.semantic_text_length,
        parser_text_object_sha256: exactContract.legacy.text_object_sha256,
        parser_text_object_bytes: exactContract.legacy.text_object_bytes,
      },
      {
        parser_text_sha256: exactContract.sealed_intake.semantic_text_sha256,
        parser_normalized_text_sha256: exactContract.sealed_intake.normalized_text_sha256,
        parser_text_length: exactContract.sealed_intake.semantic_text_length,
        parser_text_object_sha256: exactContract.sealed_intake.text_object_sha256,
        parser_text_object_bytes: exactContract.sealed_intake.text_object_bytes,
      },
    ].some((identity) => (
      observation.parser_text_sha256 === identity.parser_text_sha256
      && observation.parser_normalized_text_sha256
        === identity.parser_normalized_text_sha256
      && observation.parser_text_length === identity.parser_text_length
      && observation.parser_text_object_sha256
        === identity.parser_text_object_sha256
      && observation.parser_text_object_bytes === identity.parser_text_object_bytes
    ));
    assert(allowedParserObservation, "recovery_receipt_parser_observation_not_allowlisted");
    assert(/^[a-f0-9]{64}$/u.test(observation.parser_metadata_object_sha256), "recovery_receipt_parser_metadata_hash_invalid");
    assert(Number.isSafeInteger(observation.parser_metadata_object_bytes) && observation.parser_metadata_object_bytes > 0, "recovery_receipt_parser_metadata_bytes_invalid");

    const omission = analyzeStage1PdfParserOmission({
      sealedText: prospective.text,
      legacyText: existing.text,
    });
    assert(omission.legacy_is_exact_subsequence, "recovery_current_text_not_exact_subsequence");
    assert(omission.sealed_word_count === exactContract.sealed_intake.normalized_word_count, "recovery_current_sealed_word_count_not_allowlisted");
    assert(omission.legacy_word_count === exactContract.legacy.normalized_word_count, "recovery_current_legacy_word_count_not_allowlisted");
    assert(sameJson(omission.omitted_words, omittedWords), "recovery_current_omitted_words_not_allowlisted");
    assertQuotes(existing.text, exactContract.reviewed_quotes, "recovery_legacy");
    assertQuotes(prospective.text, exactContract.reviewed_quotes, "recovery_prospective");

    assert(activation.shared_award_source_id === sourceId, "recovery_activation_source_not_allowlisted");
    assert(activation.source_acquisition_id === acquisitionId, "recovery_activation_acquisition_not_allowlisted");
    assert(activation.source_page_request_id === requestId, "recovery_activation_request_not_allowlisted");
    assert(activation.guard_sha256 === exactContract.activation_guard_sha256, "recovery_activation_guard_not_allowlisted");
    assert(activation.expected_normalized_text_sha256 === exactContract.sealed_intake.normalized_text_sha256, "recovery_activation_expected_text_not_allowlisted");
    assert(activation.observed_normalized_text_sha256 === exactContract.sealed_intake.normalized_text_sha256, "recovery_activation_observed_text_not_allowlisted");
    assertR2Authority(input.authoritativeR2Binding, exactContract);
    return {
      applies: true,
      accepted: true,
      reason: "exact_schwarzman_sealed_intake_text_recovery_receipt_verified",
      evidence: receipt,
    };
  } catch (error) {
    return rejected(true, errorMessage(error));
  }
}

export function analyzeStage1PdfParserOmission({ sealedText, legacyText } = {}) {
  const sealedWords = normalizedWords(sealedText);
  const legacyWords = normalizedWords(legacyText);
  const missing = [];
  let legacyIndex = 0;
  for (const word of sealedWords) {
    if (legacyIndex < legacyWords.length && word === legacyWords[legacyIndex]) {
      legacyIndex += 1;
    } else {
      missing.push(word);
    }
  }
  return {
    sealed_word_count: sealedWords.length,
    legacy_word_count: legacyWords.length,
    matched_legacy_word_count: legacyIndex,
    legacy_is_exact_subsequence: legacyIndex === legacyWords.length,
    omitted_word_count: missing.length,
    omitted_words: missing,
  };
}

function assertAcquisition({ acquisition, disposition, guard, review, finalization, contract }) {
  assert(acquisition.id === contract.acquisition_id, "acquisition_id_not_allowlisted");
  assert(acquisition.shared_award_source_id === contract.source_id, "acquisition_source_not_allowlisted");
  assert(acquisition.origin_source_page_request_id === contract.request_id, "acquisition_request_not_allowlisted");
  assert(acquisition.acquisition_kind === contract.acquisition_kind, "acquisition_kind_not_allowlisted");
  assert(acquisition.notification_mode === contract.notification_mode, "acquisition_notification_mode_not_allowlisted");
  assert(acquisition.onboarding_batch_id === contract.onboarding_batch_id, "acquisition_batch_not_allowlisted");
  assert(acquisition.review_seal?.seal_sha256 === contract.acquisition_seal_sha256, "acquisition_seal_not_allowlisted");
  assert(acquisition.review_seal?.capture_file_hash === contract.file_sha256, "acquisition_file_not_allowlisted");
  assert(acquisition.review_seal?.capture_final_url === contract.final_url, "acquisition_url_not_allowlisted");
  assert(disposition.guard_sha256 === contract.activation_guard_sha256, "activation_guard_not_allowlisted");
  assert(guard.shared_award_source_id === contract.source_id, "guard_source_not_allowlisted");
  assert(guard.shared_award_source_acquisition_id === contract.acquisition_id, "guard_acquisition_not_allowlisted");
  assert(guard.source_page_request_id === contract.request_id, "guard_request_not_allowlisted");
  assert(guard.capture_file_sha256 === contract.file_sha256, "guard_file_not_allowlisted");
  assert(guard.final_url === contract.final_url, "guard_url_not_allowlisted");
  assert(guard.normalized_retained_text_sha256 === contract.sealed_intake.normalized_text_sha256, "guard_text_not_allowlisted");
  assert(guard.retained_text_artifact?.key === `source-intake-first-observation/v1/requests/${contract.request_id}/sha256/${contract.file_sha256}/text.txt`, "guard_text_key_not_allowlisted");
  assert(guard.retained_text_artifact?.sha256 === contract.sealed_intake.text_object_sha256, "guard_text_object_not_allowlisted");
  assert(guard.retained_text_artifact?.bytes === contract.sealed_intake.text_object_bytes, "guard_text_bytes_not_allowlisted");
  assert(review.page_type === contract.reviewed_page_type, "reviewed_page_type_not_allowlisted");
  assert(sameJson(review.reviewed_roles, contract.reviewed_roles), "reviewed_roles_not_allowlisted");
  assert(sameJson(review.evidence_quotes, contract.reviewed_quotes), "reviewed_quotes_not_allowlisted");
  assert(finalization.source_acquisition_id === contract.acquisition_id, "finalization_acquisition_not_allowlisted");
  assert(finalization.shared_award_source_id === contract.source_id, "finalization_source_not_allowlisted");
  assert(finalization.source_page_request_id === contract.request_id, "finalization_request_not_allowlisted");
  assert(finalization.guard_sha256 === contract.activation_guard_sha256, "finalization_guard_not_allowlisted");
  assert(finalization.observed_normalized_text_sha256 === contract.sealed_intake.normalized_text_sha256, "finalization_text_not_allowlisted");
  assert(finalization.finalization_receipt_sha256 === contract.finalization_receipt_sha256, "finalization_receipt_not_allowlisted");
}

function assertLegacyBaseline({ baseline, baselineBytes, activation, existing, artifacts, contract }) {
  assertLiveBaselinePointer({ baseline, baselineBytes, activation, contract });
  assert(existing.kind === "pdf" && existing.source?.id === contract.source_id, "legacy_capture_source_not_allowlisted");
  assert(existing.captured_at === contract.legacy.captured_at, "legacy_capture_timestamp_not_allowlisted");
  assert(existing.final_url === contract.final_url, "legacy_capture_url_not_allowlisted");
  assert(existing.file_hash === contract.file_sha256 && existing.file_bytes === contract.file_bytes, "legacy_capture_pdf_not_allowlisted");
  assert(existing.text_hash === contract.legacy.semantic_text_sha256, "legacy_capture_text_not_allowlisted");
  assert(existing.text_length === contract.legacy.semantic_text_length, "legacy_capture_text_length_not_allowlisted");
  assert(stage1BaselineActivationTextSha256(existing.text) === contract.legacy.normalized_text_sha256, "legacy_capture_normalized_text_not_allowlisted");
  assert(activation.shared_award_source_id === contract.source_id, "legacy_activation_source_not_allowlisted");
  assert(activation.source_acquisition_id === contract.acquisition_id, "legacy_activation_acquisition_not_allowlisted");
  assert(activation.source_page_request_id === contract.request_id, "legacy_activation_request_not_allowlisted");
  assert(activation.guard_sha256 === contract.activation_guard_sha256, "legacy_activation_guard_not_allowlisted");
  assert(activation.expected_normalized_text_sha256 === contract.sealed_intake.normalized_text_sha256, "legacy_activation_expected_text_not_allowlisted");
  assert(activation.observed_normalized_text_sha256 === contract.sealed_intake.normalized_text_sha256, "legacy_activation_observed_text_not_allowlisted");
  assertBufferIdentity(artifacts.pdf, contract.file_sha256, contract.file_bytes, "legacy_pdf");
  assertBufferIdentity(artifacts.text, contract.legacy.text_object_sha256, contract.legacy.text_object_bytes, "legacy_text");
  assertBufferIdentity(artifacts.meta, contract.legacy.metadata_sha256, contract.legacy.metadata_bytes, "legacy_meta");
  assertWriterText(artifacts.text, existing.text, "legacy_text");
}

/**
 * baseline.json is a LIVE pointer file the nightly baseline-refresh lane
 * legitimately rewrites on unchanged-content refreshes, so this deliberately
 * does not pin whole-file bytes. It instead binds the exact bytes the caller
 * read to the record being asserted, then pins every stable subfield the
 * retired byte-pin materially protected: source identity, final URL, exact
 * PDF and semantic-text identities, and the complete unchanged
 * stage1_baseline_activation block (field-by-field for clear reasons, plus a
 * canonical whole-block digest so no activation field can drift silently).
 * The one tolerance is pointer advancement: captured_at may move forward and
 * the capture paths may follow it, but only to a generation directory of this
 * exact source that is self-consistent with the pointer's own captured_at.
 */
function assertLiveBaselinePointer({ baseline, baselineBytes, activation, contract }) {
  const body = Buffer.from(baselineBytes || []);
  assert(body.byteLength > 0, "baseline_json_bytes_missing");
  let parsed = null;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    parsed = null;
  }
  assert(parsed && typeof parsed === "object" && !Array.isArray(parsed), "baseline_json_bytes_invalid");
  assert(sameJson(parsed, baseline), "baseline_json_bytes_record_mismatch");
  assert(baseline.kind === "pdf", "baseline_pointer_kind_not_allowlisted");
  assert(baseline.source?.id === contract.source_id, "baseline_pointer_source_not_allowlisted");
  const capturedAt = typeof baseline.captured_at === "string" ? baseline.captured_at : "";
  const capturedAtMs = Date.parse(capturedAt);
  assert(
    Number.isFinite(capturedAtMs)
      && new Date(capturedAtMs).toISOString() === capturedAt,
    "baseline_pointer_timestamp_invalid",
  );
  assert(
    capturedAtMs >= Date.parse(contract.baseline_pointer.minimum_captured_at),
    "baseline_pointer_timestamp_regressed",
  );
  assert(baseline.final_url === contract.final_url, "baseline_pointer_url_not_allowlisted");
  assert(baseline.file_hash === contract.file_sha256 && baseline.file_bytes === contract.file_bytes, "baseline_pointer_pdf_not_allowlisted");
  assert(baseline.text_hash === contract.legacy.semantic_text_sha256, "baseline_pointer_text_not_allowlisted");
  assert(baseline.text_length === contract.legacy.semantic_text_length, "baseline_pointer_text_length_not_allowlisted");
  const pointerPrefix =
    `sources/${contract.source_id}/captures/${captureTimestampDirectory(capturedAt)}/`;
  assert(baseline.capture?.dir === pointerPrefix.slice(0, -1), "baseline_pointer_capture_dir_not_allowlisted");
  assert(baseline.capture?.pdf === `${pointerPrefix}document.pdf`, "baseline_pointer_pdf_path_not_allowlisted");
  assert(baseline.capture?.text === `${pointerPrefix}text.txt`, "baseline_pointer_text_path_not_allowlisted");
  assert(baseline.capture?.meta === `${pointerPrefix}meta.json`, "baseline_pointer_meta_path_not_allowlisted");
  assert(activation.shared_award_source_id === contract.source_id, "legacy_activation_source_not_allowlisted");
  assert(activation.source_acquisition_id === contract.acquisition_id, "legacy_activation_acquisition_not_allowlisted");
  assert(activation.source_page_request_id === contract.request_id, "legacy_activation_request_not_allowlisted");
  assert(activation.guard_sha256 === contract.activation_guard_sha256, "legacy_activation_guard_not_allowlisted");
  assert(activation.expected_normalized_text_sha256 === contract.sealed_intake.normalized_text_sha256, "legacy_activation_expected_text_not_allowlisted");
  assert(activation.observed_normalized_text_sha256 === contract.sealed_intake.normalized_text_sha256, "legacy_activation_observed_text_not_allowlisted");
  assert(activation.capture_file_sha256 === contract.file_sha256, "legacy_activation_file_not_allowlisted");
  assert(activation.retained_text_artifact?.key === `source-intake-first-observation/v1/requests/${contract.request_id}/sha256/${contract.file_sha256}/text.txt`, "legacy_activation_text_key_not_allowlisted");
  assert(activation.retained_text_artifact?.sha256 === contract.sealed_intake.text_object_sha256, "legacy_activation_text_object_not_allowlisted");
  assert(activation.retained_text_artifact?.bytes === contract.sealed_intake.text_object_bytes, "legacy_activation_text_bytes_not_allowlisted");
  assert(
    sha256(Buffer.from(canonicalJson(activation), "utf8"))
      === contract.baseline_pointer.stage1_baseline_activation_canonical_sha256,
    "legacy_activation_block_not_allowlisted",
  );
}

function assertR2Authority(receipt, contract) {
  try {
    assertStage1EvidenceSchemaUpgradeR2BindingReceipt(receipt);
  } catch {
    throw new Error("r2_binding_receipt_invalid");
  }
  const pointer = objectValue(receipt.pointer_identity);
  const roles = new Map(
    (Array.isArray(receipt.verified_roles) ? receipt.verified_roles : [])
      .map((role) => [role?.role, role]),
  );
  assert(receipt.receipt_sha256 === contract.legacy.r2_binding_receipt_sha256, "r2_binding_receipt_not_allowlisted");
  assert(receipt.source_id === contract.source_id && receipt.kind === "pdf", "r2_source_not_allowlisted");
  assert(receipt.captured_at === contract.legacy.captured_at, "r2_timestamp_not_allowlisted");
  assert(pointer.shared_award_source_id === contract.source_id, "r2_pointer_source_not_allowlisted");
  assert(pointer.kind === "pdf", "r2_pointer_kind_not_allowlisted");
  assert(pointer.bucket === "awardping-snapshots", "r2_pointer_bucket_not_allowlisted");
  assert(pointer.immutable_generation === contract.legacy.r2_generation, "r2_generation_not_allowlisted");
  assert(pointer.pointer_sha256 === contract.legacy.r2_pointer_sha256, "r2_pointer_not_allowlisted");
  assert(pointer.latest_metadata_sha256 === contract.legacy.r2_metadata_sha256, "r2_metadata_not_allowlisted");
  assert(pointer.latest_hashes?.file_hash === contract.file_sha256, "r2_pdf_hash_not_allowlisted");
  assert(pointer.latest_hashes?.text_hash === contract.legacy.semantic_text_sha256, "r2_text_hash_not_allowlisted");
  for (const [role, expected] of Object.entries({
    pdf: [contract.file_sha256, contract.file_bytes, "document.pdf"],
    text: [contract.legacy.text_object_sha256, contract.legacy.text_object_bytes, "text.txt"],
    meta: [contract.legacy.metadata_sha256, contract.legacy.metadata_bytes, "meta.json"],
  })) {
    const value = objectValue(roles.get(role));
    assert(value.key === `${contract.legacy.r2_prefix}${expected[2]}`, `r2_${role}_key_not_allowlisted`);
    assert(value.sha256 === expected[0] && value.byte_length === expected[1], `r2_${role}_identity_not_allowlisted`);
    assert(value.remote_body_verified === true, `r2_${role}_not_verified`);
  }
  assert(receipt.semantic_text?.sha256 === contract.legacy.semantic_text_sha256, "r2_semantic_text_not_allowlisted");
  assert(receipt.semantic_text?.character_length === contract.legacy.semantic_text_length, "r2_semantic_length_not_allowlisted");
  assert(receipt.semantic_text?.object_byte_length === contract.legacy.text_object_bytes, "r2_text_object_length_not_allowlisted");
  assert(receipt.semantic_text?.writer_framing === "lf", "r2_text_framing_not_allowlisted");
}

function assertSealedIntake(artifacts, contract) {
  assertBufferIdentity(artifacts.capture_metadata, contract.sealed_intake.capture_metadata_sha256, contract.sealed_intake.capture_metadata_bytes, "sealed_capture_metadata");
  assertBufferIdentity(artifacts.pdf, contract.file_sha256, contract.file_bytes, "sealed_pdf");
  assertBufferIdentity(artifacts.text, contract.sealed_intake.text_object_sha256, contract.sealed_intake.text_object_bytes, "sealed_text");
  const metadata = parseJson(artifacts.capture_metadata, "sealed_capture_metadata");
  assert(metadata.schema_version === 1 && metadata.namespace === "source-intake-first-observation", "sealed_capture_schema_not_allowlisted");
  assert(metadata.request_id === contract.request_id, "sealed_capture_request_not_allowlisted");
  assert(metadata.document_kind === "pdf", "sealed_capture_kind_not_allowlisted");
  assert(metadata.file_hash === contract.file_sha256 && metadata.file_bytes === contract.file_bytes, "sealed_capture_pdf_not_allowlisted");
  assert(metadata.final_url === contract.final_url && metadata.canonical_url === contract.final_url, "sealed_capture_url_not_allowlisted");
  assert(metadata.text_hash === contract.sealed_intake.semantic_text_sha256, "sealed_capture_text_not_allowlisted");
  assert(metadata.text_length === contract.sealed_intake.semantic_text_length, "sealed_capture_text_length_not_allowlisted");
  assert(metadata.page_count === 7 && metadata.pdf_text_error === null, "sealed_capture_parser_status_not_allowlisted");
  assert(sameJson(metadata.files, { capture_metadata: "capture.json", pdf: "document.pdf", text: "text.txt" }), "sealed_capture_files_not_allowlisted");
  const semanticText = decodeWriterText(artifacts.text, "sealed_text");
  const identity = semanticTextIdentity(semanticText);
  assert(identity.sha256 === contract.sealed_intake.semantic_text_sha256, "sealed_semantic_text_not_allowlisted");
  assert(identity.length === contract.sealed_intake.semantic_text_length, "sealed_semantic_length_not_allowlisted");
  assert(identity.normalized_sha256 === contract.sealed_intake.normalized_text_sha256, "sealed_normalized_text_not_allowlisted");
  return { metadata, semanticText };
}

function assertProspectiveCapture({ prospective, artifacts, contract }) {
  assert(prospective.kind === "pdf", "prospective_kind_not_allowlisted");
  assert(prospective.source?.id === contract.source_id, "prospective_source_not_allowlisted");
  assert(Number.isFinite(Date.parse(prospective.captured_at)), "prospective_timestamp_invalid");
  assert(prospective.final_url === contract.final_url, "prospective_url_not_allowlisted");
  assert(prospective.file_hash === contract.file_sha256 && prospective.file_bytes === contract.file_bytes, "prospective_pdf_not_allowlisted");
  assert(prospective.page_count === 7 && prospective.pdf_text_error === null, "prospective_parser_status_not_allowlisted");
  assertBufferIdentity(artifacts.pdf, contract.file_sha256, contract.file_bytes, "prospective_pdf");
  assertWriterText(artifacts.text, prospective.text, "prospective_text");
  const metadata = parseJson(artifacts.meta, "prospective_meta");
  assert(metadata.kind === "pdf" && metadata.source?.id === contract.source_id, "prospective_meta_source_not_allowlisted");
  assert(metadata.captured_at === prospective.captured_at, "prospective_meta_timestamp_not_allowlisted");
  assert(metadata.final_url === contract.final_url, "prospective_meta_url_not_allowlisted");
  assert(metadata.file_hash === contract.file_sha256 && metadata.file_bytes === contract.file_bytes, "prospective_meta_pdf_not_allowlisted");
  assert(metadata.text_hash === prospective.text_hash && metadata.text_length === prospective.text_length, "prospective_meta_text_not_allowlisted");
}

function artifactBodies(value, requiredRoles) {
  const source = objectValue(value?.bodies) || objectValue(value);
  let entries;
  if (Array.isArray(value?.artifacts)) {
    entries = value.artifacts.map((artifact) => [artifact?.name, artifact?.body]);
  } else {
    entries = Object.entries(source);
  }
  const bodies = Object.fromEntries(entries.map(([role, body]) => [role, Buffer.from(body || [])]));
  assert(sameJson(Object.keys(bodies).sort(), [...requiredRoles].sort()), "artifact_role_set_not_allowlisted");
  return bodies;
}

function assertWriterText(body, semanticText, label) {
  const raw = Buffer.from(body);
  const semantic = String(semanticText ?? "");
  assert(
    raw.equals(Buffer.from(`${semantic}\n`, "utf8"))
      || (
        semantic.endsWith("\n")
        && !semantic.endsWith("\n\n")
        && raw.equals(Buffer.from(semantic, "utf8"))
      ),
    `${label}_writer_framing_invalid`,
  );
}

function decodeWriterText(body, label) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  assert(text.endsWith("\n") && !text.endsWith("\n\n") && !text.endsWith("\r\n"), `${label}_writer_framing_invalid`);
  return text.slice(0, -1);
}

function assertQuotes(text, quotes, label) {
  const haystack = normalizeStage1BaselineEvidenceWords(text);
  for (const quote of quotes || []) {
    assert(haystack.includes(normalizeStage1BaselineEvidenceWords(quote)), `${label}_reviewed_quote_missing`);
  }
}

function semanticTextIdentity(value) {
  const text = String(value ?? "");
  return {
    sha256: sha256(Buffer.from(text, "utf8")),
    length: text.length,
    normalized_sha256: stage1BaselineActivationTextSha256(text),
  };
}

function normalizedWords(value) {
  const normalized = normalizeStage1BaselineEvidenceWords(value);
  return normalized ? normalized.split(" ") : [];
}

function assertBufferIdentity(value, expectedHash, expectedBytes, label) {
  const body = Buffer.from(value || []);
  assert(body.byteLength === expectedBytes, `${label}_byte_length_not_allowlisted`);
  assert(sha256(body) === expectedHash, `${label}_sha256_not_allowlisted`);
}

function buildCandidateMutationContext({
  archiveRoot,
  sourceId,
  capturedAt,
  candidateDir,
  textPath,
  metadataPath,
}) {
  const archiveRootPath = resolve(requiredText(archiveRoot, "archive root"));
  const generation = captureTimestampDirectory(capturedAt);
  const paths = {
    archiveRoot: archiveRootPath,
    sourcesDir: join(archiveRootPath, "sources"),
    sourceDir: join(archiveRootPath, "sources", sourceId),
    capturesDir: join(archiveRootPath, "sources", sourceId, "captures"),
    candidateDir: join(
      archiveRootPath,
      "sources",
      sourceId,
      "captures",
      generation,
    ),
  };
  paths.textPath = join(paths.candidateDir, "text.txt");
  paths.metadataPath = join(paths.candidateDir, "meta.json");
  if (
    !sameFilesystemPath(resolve(candidateDir || ""), paths.candidateDir)
    || !sameFilesystemPath(resolve(textPath || ""), paths.textPath)
    || !sameFilesystemPath(resolve(metadataPath || ""), paths.metadataPath)
  ) {
    throw candidateMutationError(
      "pdf_text_recovery_candidate_path_invalid",
      "The recovery target paths do not identify the exact source capture generation.",
    );
  }
  assertCandidateMutationBoundary(paths);
  return paths;
}

function candidateMutationMarkerPath(candidateDir) {
  return join(
    candidateDir,
    ".stage1-schwarzman-pdf-recovery.pending.json",
  );
}

function assertCandidateMutationBoundary(context, extraFiles = []) {
  try {
    const canonicalRoot = assertCanonicalDirectory(
      context.archiveRoot,
      null,
      "archive root",
    );
    for (const [path, label] of [
      [context.sourcesDir, "sources directory"],
      [context.sourceDir, "source directory"],
      [context.capturesDir, "captures directory"],
      [context.candidateDir, "candidate directory"],
    ]) {
      const canonical = assertCanonicalDirectory(path, canonicalRoot, label);
      if (!sameFilesystemPath(canonical, path)) {
        throw new Error(`${label} resolves through a reparse point`);
      }
    }
    assertCanonicalRegularFile(
      context.textPath,
      context.candidateDir,
      "candidate text",
    );
    assertCanonicalRegularFile(
      context.metadataPath,
      context.candidateDir,
      "candidate metadata",
    );
    for (const [index, path] of extraFiles.entries()) {
      assertCanonicalRegularFile(
        path,
        context.candidateDir,
        `candidate transaction file ${index + 1}`,
      );
    }
  } catch (error) {
    if (error?.stage1_candidate_mutation) throw error;
    throw candidateMutationError(
      "pdf_text_recovery_candidate_path_invalid",
      `The recovery target failed canonical containment verification: ${errorMessage(error)}`,
      null,
      error,
    );
  }
}

function assertCanonicalDirectory(path, canonicalRoot, label) {
  const lexical = resolve(path);
  const stats = lstatSync(lexical);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} is not a direct regular directory`);
  }
  const canonical = realpathSync(lexical);
  if (!sameFilesystemPath(canonical, lexical)) {
    throw new Error(`${label} is redirected by a junction, symlink, or alias`);
  }
  if (canonicalRoot && !filesystemPathContained(canonical, canonicalRoot)) {
    throw new Error(`${label} resolves outside the canonical archive root`);
  }
  return canonical;
}

function assertCanonicalRegularFile(path, canonicalCandidateDir, label) {
  const lexical = resolve(path);
  if (!filesystemPathContained(lexical, canonicalCandidateDir)) {
    throw new Error(`${label} is outside the candidate directory`);
  }
  const stats = lstatSync(lexical);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} is not a direct regular file`);
  }
  const canonical = realpathSync(lexical);
  if (
    !sameFilesystemPath(canonical, lexical)
    || !filesystemPathContained(canonical, canonicalCandidateDir)
  ) {
    throw new Error(`${label} resolves through a reparse point or outside the candidate directory`);
  }
  return canonical;
}

function filesystemPathContained(candidate, parent) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function sameFilesystemPath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function stageCandidateMutationFile(context, path, bytes) {
  assertCandidateMutationBoundary(context);
  const candidatePath = resolve(path);
  if (
    !filesystemPathContained(candidatePath, context.candidateDir)
    || existsSync(candidatePath)
  ) {
    throw candidateMutationError(
      "pdf_text_recovery_candidate_staging_path_invalid",
      "A candidate transaction staging path is outside the generation or already exists.",
    );
  }
  let descriptor;
  try {
    descriptor = openSync(candidatePath, "wx");
    writeFileSync(descriptor, Buffer.from(bytes));
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertCandidateMutationBoundary(context, [candidatePath]);
  assertFileBytes(candidatePath, bytes, "candidate transaction staging file");
}

function replaceStagedCandidateFile({
  context,
  stagePath,
  targetPath,
  expectedTargetBytes,
  expectedBytes,
  markerPath,
}) {
  // This is deliberately adjacent to renameSync: every directory and both
  // leaves are canonicalized again at the mutation boundary.
  assertCandidateMutationBoundary(context, [markerPath, stagePath]);
  assertFileBytes(stagePath, expectedBytes, "candidate staged replacement");
  assertFileBytes(
    targetPath,
    expectedTargetBytes,
    "candidate replacement target preimage",
  );
  renameSync(stagePath, targetPath);
  assertCandidateMutationBoundary(context, [markerPath]);
  assertFileBytes(targetPath, expectedBytes, "candidate replacement");
}

function rollbackCandidateMutation({
  context,
  markerPath,
  stagePaths,
  preimages,
  replacements,
  faultInjector,
}) {
  const errors = [];
  for (const [role, targetPath, preimage, replacement] of [
    ["text", context.textPath, preimages.text, replacements.text],
    ["metadata", context.metadataPath, preimages.meta, replacements.meta],
  ]) {
    try {
      assertCandidateMutationBoundary(context, [markerPath]);
      const current = readFileSync(targetPath);
      if (current.equals(preimage)) continue;
      if (!current.equals(replacement)) {
        errors.push({
          role,
          message:
            "target changed to bytes outside both the verified preimage and this transaction",
        });
        continue;
      }
      invokeCandidateMutationFault(faultInjector, `before_${role}_rollback`);
      const rollbackPath = join(
        context.candidateDir,
        `.stage1-schwarzman-pdf-recovery.${randomUUID()}.${role}.rollback`,
      );
      stageCandidateMutationFile(context, rollbackPath, preimage);
      replaceStagedCandidateFile({
        context,
        stagePath: rollbackPath,
        targetPath,
        expectedTargetBytes: replacement,
        expectedBytes: preimage,
        markerPath,
      });
      invokeCandidateMutationFault(faultInjector, `after_${role}_rollback`);
    } catch (error) {
      errors.push({ role, message: errorMessage(error) });
    }
  }
  try {
    assertCandidateMutationBoundary(context, [markerPath]);
    assertFileBytes(context.textPath, preimages.text, "rolled-back candidate text");
    assertFileBytes(context.metadataPath, preimages.meta, "rolled-back candidate metadata");
  } catch (error) {
    errors.push({ role: "verification", message: errorMessage(error) });
  }
  if (errors.length) {
    return { verified: false, errors };
  }
  try {
    removeCandidateTransactionFile(context, markerPath);
  } catch (error) {
    // Exact preimages are restored, but the marker intentionally remains if
    // cleanup cannot be proven so the generation is still fail-closed.
    return {
      verified: false,
      errors: [{ role: "fence_cleanup", message: errorMessage(error) }],
    };
  }
  try {
    cleanupCandidateTransactionFiles(context, Object.values(stagePaths));
  } catch (error) {
    errors.push({ role: "staging_cleanup", message: errorMessage(error) });
  }
  return { verified: true, errors };
}

function removeCandidateTransactionFile(context, path) {
  if (!existsSync(path)) return;
  assertCandidateMutationBoundary(context, [path]);
  unlinkSync(path);
  if (existsSync(path)) {
    throw new Error("Candidate transaction file removal was not durable.");
  }
}

function cleanupCandidateTransactionFiles(context, paths) {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    removeCandidateTransactionFile(context, path);
  }
}

function assertFileBytes(path, expectedBytes, label) {
  const expected = Buffer.from(expectedBytes);
  const actual = readFileSync(path);
  if (!actual.equals(expected)) {
    throw new Error(`${label} bytes changed`);
  }
}

function assertCandidateMutationState(context, { text, meta }) {
  // Kept directly beside each rename call by the transaction engine so a
  // concurrent target mutation cannot be silently overwritten.
  assertCandidateMutationBoundary(context);
  assertFileBytes(context.textPath, text, "candidate transaction text state");
  assertFileBytes(context.metadataPath, meta, "candidate transaction metadata state");
}

function assertExactMutationBytes(value, expectedHash, expectedBytes, label) {
  const body = Buffer.from(value || []);
  const identity = mutationIdentity(expectedHash, expectedBytes, label);
  if (
    body.byteLength !== identity.byte_length
    || sha256(body) !== identity.sha256
  ) {
    throw candidateMutationError(
      "pdf_text_recovery_candidate_bytes_invalid",
      `The ${label} does not match its exact staged identity.`,
    );
  }
}

function mutationIdentity(hash, byteLength, label) {
  const normalizedHash = String(hash || "").trim().toLowerCase();
  const normalizedLength = Number(byteLength);
  if (
    !/^[a-f0-9]{64}$/u.test(normalizedHash)
    || !Number.isSafeInteger(normalizedLength)
    || normalizedLength < 1
  ) {
    throw candidateMutationError(
      "pdf_text_recovery_candidate_identity_invalid",
      `The ${label} identity is invalid.`,
    );
  }
  return { sha256: normalizedHash, byte_length: normalizedLength };
}

function bufferIdentity(value) {
  const body = Buffer.from(value);
  return { sha256: sha256(body), byte_length: body.byteLength };
}

function invokeCandidateMutationFault(faultInjector, phase) {
  if (typeof faultInjector === "function") faultInjector({ phase });
}

function requiredIsoTimestamp(value, code) {
  const text = String(value || "").trim();
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw candidateMutationError(code, "The candidate timestamp is not exact ISO-8601 UTC.");
  }
  return text;
}

function captureTimestampDirectory(value) {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

function candidateMutationError(code, message, evidence = null, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.stage1_candidate_mutation = true;
  if (evidence) error.stage1_candidate_mutation_evidence = evidence;
  return error;
}

function readContainedFile(rootValue, archiveRelativePath) {
  const root = realpathSync(resolve(rootValue));
  const candidate = resolve(root, ...archiveRelativePath.split("/"));
  assert(candidate === root || candidate.startsWith(`${root}${sep}`), "sealed_intake_path_escape");
  const path = realpathSync(candidate);
  assert(path === root || path.startsWith(`${root}${sep}`), "sealed_intake_real_path_escape");
  assert(lstatSync(path).isFile(), "sealed_intake_path_not_file");
  const relativePath = relative(root, path).replace(/\\/g, "/");
  assert(relativePath === archiveRelativePath, "sealed_intake_path_alias_not_allowlisted");
  return { path, body: readFileSync(path) };
}

function parseJson(body, label) {
  try {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
    assert(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${label}_json_invalid`);
    return parsed;
  } catch (error) {
    throw new Error(`${label}_json_invalid:${errorMessage(error)}`);
  }
}

function receiptSha256(value) {
  const { receipt_sha256: ignored, ...basis } = objectValue(value);
  void ignored;
  return sha256(Buffer.from(canonicalJson(basis), "utf8"));
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label.replace(/\s+/g, "_")}_missing`);
  return text;
}

function rejected(applies, reason) {
  return {
    applies,
    accepted: false,
    reason: String(reason || "schwarzman_pdf_recovery_invalid")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 160) || "schwarzman_pdf_recovery_invalid",
    evidence: null,
  };
}

function assert(condition, reason) {
  if (!condition) throw new Error(reason);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "unknown_error");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function stage1SchwarzmanPdfRecoveryExpectedContract() {
  return structuredClone(exactContract);
}
