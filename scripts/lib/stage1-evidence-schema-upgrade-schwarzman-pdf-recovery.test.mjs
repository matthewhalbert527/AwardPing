import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareR2CaptureArtifacts } from "./r2-capture-artifact-bindings.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS,
  evaluateStage1EvidenceSchemaUpgradeCapture,
} from "./stage1-evidence-schema-upgrade-validation.mjs";
import {
  STAGE1_SCHWARZMAN_PDF_RECOVERY_SCHEMA,
  STAGE1_SCHWARZMAN_PDF_RECOVERY_SOURCE_ID,
  analyzeStage1PdfParserOmission,
  assertStage1SchwarzmanPdfRecoveryCandidateNotFenced,
  commitStage1PdfRecoveryCandidateFiles,
  evaluateStage1SchwarzmanPdfRecovery,
  evaluateStage1SchwarzmanPdfRecoveryReceipt,
  loadStage1SchwarzmanPdfRecoveryCandidatePreimages,
  loadStage1SchwarzmanPdfSealedIntakeArtifacts,
  stage1SchwarzmanPdfRecoveryExpectedContract,
} from "./stage1-evidence-schema-upgrade-schwarzman-pdf-recovery.mjs";

const archiveRoot = "D:/AwardPingVisualSnapshots";
const sourceId = STAGE1_SCHWARZMAN_PDF_RECOVERY_SOURCE_ID;
const sourceRoot = `${archiveRoot}/sources/${sourceId}`;
const baselineGeneration = `${sourceRoot}/captures/2026-08-03T18-52-07-825Z`;
const retainedCanaryGeneration = `${sourceRoot}/captures/2026-08-15T04-22-34-967Z`;
const localFixtureAvailable = [
  `${sourceRoot}/baseline.json`,
  `${baselineGeneration}/document.pdf`,
  `${baselineGeneration}/text.txt`,
  `${baselineGeneration}/meta.json`,
  `${retainedCanaryGeneration}/document.pdf`,
  `${retainedCanaryGeneration}/text.txt`,
  `${retainedCanaryGeneration}/meta.json`,
  `${archiveRoot}/intake-artifacts/requests/cf731f52-f02d-581e-bf52-c698f53d87d8/sha256/fac3353cf079c7acfe7eaa7d8da685eba8275181d500373a149f2fdeff429263/capture.json`,
].every(existsSync);

describe("Stage 1 Schwarzman PDF sealed-text recovery", () => {
  it("keeps the production compatibility surface to one exact immutable source", () => {
    const contract = stage1SchwarzmanPdfRecoveryExpectedContract();
    expect(contract).toMatchObject({
      source_id: sourceId,
      acquisition_id: "05a81494-e659-5185-a08f-913119967f4b",
      request_id: "cf731f52-f02d-581e-bf52-c698f53d87d8",
      activation_guard_sha256:
        "2cea30f2e49bbdeb75d1d4581126e8658b55af52f0630a00f3fef18eb5a4f434",
      finalization_receipt_sha256:
        "5577bfb230eba67f0aa5b7e61a68dc2e5cf9dd973a68886aeeb37a66500272df",
      file_sha256:
        "fac3353cf079c7acfe7eaa7d8da685eba8275181d500373a149f2fdeff429263",
      legacy: {
        captured_at: "2026-08-03T18:52:07.825Z",
        r2_generation: "b50b827daa5e6a0e7b44d3c7fb9e8502",
        semantic_text_sha256:
          "052b7416552971dee28c1b61d89dbb32aedae2b8ea9d711df0e8084f4d348314",
      },
      sealed_intake: {
        semantic_text_sha256:
          "9b50d2748660349bd5d4148453a0f2753cb668ebdf6a3e72d7aed43f43f53aaa",
      },
    });
    expect(contract.legacy.semantic_text_sha256)
      .not.toBe(contract.sealed_intake.semantic_text_sha256);
    expect(contract.omission.omitted_words).toHaveLength(18);
  });

  it("proves only strict ordered omissions and rejects substitutions or reordering", () => {
    const omitted = [
      "that", "we", "are", "no", "longer", "accepting", "videos", "shared",
      "via", "google", "drive", "save", "your", "video", "on", "youtube", "or",
    ];
    const sealed = ["start", "or", "o", "middle", ...omitted, "vimeo", "end"].join(" ");
    const legacy = ["start", "o", "middle", "vimeo", "end"].join(" ");
    expect(analyzeStage1PdfParserOmission({ sealedText: sealed, legacyText: legacy }))
      .toEqual({
        sealed_word_count: 23,
        legacy_word_count: 5,
        matched_legacy_word_count: 5,
        legacy_is_exact_subsequence: true,
        omitted_word_count: 18,
        omitted_words: ["or", ...omitted],
      });

    expect(analyzeStage1PdfParserOmission({
      sealedText: sealed,
      legacyText: "start o substituted vimeo end",
    })).toMatchObject({ legacy_is_exact_subsequence: false });
    expect(analyzeStage1PdfParserOmission({
      sealedText: sealed,
      legacyText: "start middle o vimeo end",
    })).toMatchObject({ legacy_is_exact_subsequence: false });
  });

  it("returns before inspecting evidence for every sibling source", () => {
    const inaccessible = new Proxy({}, {
      get() {
        throw new Error("must not inspect sibling evidence");
      },
    });
    expect(evaluateStage1SchwarzmanPdfRecovery({
      sourceId: "11111111-1111-4111-8111-111111111111",
      immutableAcquisition: inaccessible,
    })).toEqual({
      applies: false,
      accepted: false,
      reason: "source_not_allowlisted",
      evidence: null,
    });
  });

  it("wires the worker through canonical preimage loading and one transactional commit", () => {
    const worker = readFileSync(
      new URL("../capture-visual-snapshots.mjs", import.meta.url),
      "utf8",
    );
    const body = worker.match(
      // \r?\n so the anchor survives checkouts that materialize CRLF.
      /function applyStage1SchwarzmanPdfRecoveryToCandidate[\s\S]+?\r?\n\}\r?\n\r?\nfunction r2CaptureHashes/u,
    )?.[0] || "";
    expect(body).toContain("loadStage1SchwarzmanPdfRecoveryCandidatePreimages");
    expect(body).toContain("commitStage1SchwarzmanPdfRecoveryCandidateFiles");
    expect(body).not.toContain("atomicWriteBytes(");
    expect(body).not.toContain("atomicWriteJson(");
    expect(worker).toContain(
      "assertStage1SchwarzmanPdfRecoveryCandidateNotFenced({",
    );
  });
});

describe("Stage 1 recovered candidate filesystem transaction", () => {
  it("restores both exact preimages after a second-write fault and succeeds on retry", () => {
    const fixture = mutationFixture();
    try {
      let injected = false;
      let failure = null;
      try {
        commitStage1PdfRecoveryCandidateFiles({
          ...fixture.input,
          faultInjector({ phase }) {
            if (!injected && phase === "before_metadata_replace") {
              injected = true;
              throw new Error("injected second-write failure");
            }
          },
        }, fixture.contract);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "pdf_text_recovery_candidate_transaction_failed_rolled_back",
        stage1_candidate_mutation_evidence: {
          rollback_verified: true,
          original_error: "injected second-write failure",
        },
      });
      expect(readFileSync(fixture.textPath)).toEqual(fixture.oldText);
      expect(readFileSync(fixture.metadataPath)).toEqual(fixture.oldMetadata);
      expect(transactionResidue(fixture.candidateDir)).toEqual([]);

      expect(commitStage1PdfRecoveryCandidateFiles(
        fixture.input,
        fixture.contract,
      )).toMatchObject({
        status: "committed",
        rollback_performed: false,
        fence_removed: true,
        authoritative: false,
      });
      expect(readFileSync(fixture.textPath)).toEqual(fixture.nextText);
      expect(readFileSync(fixture.metadataPath)).toEqual(fixture.nextMetadata);
      expect(transactionResidue(fixture.candidateDir)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("leaves an exact fence when rollback cannot be proven", () => {
    const fixture = mutationFixture();
    try {
      let failure = null;
      try {
        commitStage1PdfRecoveryCandidateFiles({
          ...fixture.input,
          faultInjector({ phase }) {
            if (phase === "before_metadata_replace") {
              throw new Error("injected metadata failure");
            }
            if (phase === "before_text_rollback") {
              throw new Error("injected rollback failure");
            }
          },
        }, fixture.contract);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "pdf_text_recovery_candidate_rollback_unverified",
        stage1_candidate_mutation_evidence: {
          rollback_verified: false,
        },
      });
      expect(transactionResidue(fixture.candidateDir)).toContain(
        ".stage1-schwarzman-pdf-recovery.pending.json",
      );
      expect(() => assertStage1SchwarzmanPdfRecoveryCandidateNotFenced({
        archiveRoot: fixture.archiveRoot,
        sourceId,
        capturedAt: fixture.input.capturedAt,
        candidateDir: fixture.candidateDir,
        textPath: fixture.textPath,
        metadataPath: fixture.metadataPath,
      })).toThrowError(expect.objectContaining({
        code: "pdf_text_recovery_candidate_generation_fenced",
      }));
      expect(() => commitStage1PdfRecoveryCandidateFiles(
        fixture.input,
        fixture.contract,
      )).toThrowError(expect.objectContaining({
        code: "pdf_text_recovery_candidate_generation_fenced",
      }));
    } finally {
      fixture.cleanup();
    }
  });

  it("does not overwrite a concurrent target mutation at a write boundary", () => {
    const fixture = mutationFixture();
    const concurrentMetadata = Buffer.from(
      "{\"status\":\"concurrent-writer\"}\n",
      "utf8",
    );
    try {
      let failure = null;
      try {
        commitStage1PdfRecoveryCandidateFiles({
          ...fixture.input,
          faultInjector({ phase }) {
            if (phase === "before_text_replace") {
              writeFileSync(fixture.metadataPath, concurrentMetadata);
            }
          },
        }, fixture.contract);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "pdf_text_recovery_candidate_rollback_unverified",
        stage1_candidate_mutation_evidence: {
          rollback_verified: false,
        },
      });
      expect(readFileSync(fixture.textPath)).toEqual(fixture.oldText);
      expect(readFileSync(fixture.metadataPath)).toEqual(concurrentMetadata);
      expect(transactionResidue(fixture.candidateDir)).toContain(
        ".stage1-schwarzman-pdf-recovery.pending.json",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("does not overwrite a concurrent target mutation at a rollback boundary", () => {
    const fixture = mutationFixture();
    const concurrentText = Buffer.from("concurrent rollback writer\n", "utf8");
    try {
      let failure = null;
      try {
        commitStage1PdfRecoveryCandidateFiles({
          ...fixture.input,
          faultInjector({ phase }) {
            if (phase === "before_metadata_replace") {
              throw new Error("injected metadata failure");
            }
            if (phase === "before_text_rollback") {
              writeFileSync(fixture.textPath, concurrentText);
            }
          },
        }, fixture.contract);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "pdf_text_recovery_candidate_rollback_unverified",
        stage1_candidate_mutation_evidence: {
          rollback_verified: false,
        },
      });
      expect(readFileSync(fixture.textPath)).toEqual(concurrentText);
      expect(readFileSync(fixture.metadataPath)).toEqual(fixture.oldMetadata);
      expect(transactionResidue(fixture.candidateDir)).toContain(
        ".stage1-schwarzman-pdf-recovery.pending.json",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects an intermediate source junction without touching external sentinels", () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-recovery-root-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "awardping-recovery-external-"));
    const capturedAt = "2026-08-15T04:22:34.967Z";
    const generation = capturedAt.replace(/[:.]/g, "-");
    const sourcesDir = join(archiveRoot, "sources");
    const externalSourceDir = join(externalRoot, "source");
    const candidateDir = join(
      externalSourceDir,
      "captures",
      generation,
    );
    const lexicalSourceDir = join(sourcesDir, sourceId);
    const lexicalCandidateDir = join(
      lexicalSourceDir,
      "captures",
      generation,
    );
    const externalText = Buffer.from("external text sentinel\n", "utf8");
    const externalMetadata = Buffer.from("{\"external\":\"metadata sentinel\"}\n", "utf8");
    const sentinelPath = join(externalRoot, "do-not-touch.sentinel");
    mkdirSync(sourcesDir, { recursive: true });
    mkdirSync(candidateDir, { recursive: true });
    writeFileSync(join(candidateDir, "text.txt"), externalText);
    writeFileSync(join(candidateDir, "meta.json"), externalMetadata);
    writeFileSync(sentinelPath, "external sentinel", "utf8");
    let junctionCreated = false;
    try {
      symlinkSync(
        externalSourceDir,
        lexicalSourceDir,
        process.platform === "win32" ? "junction" : "dir",
      );
      junctionCreated = true;
      const nextText = Buffer.from("replacement text\n", "utf8");
      const nextMetadata = Buffer.from("{\"replacement\":true}\n", "utf8");
      expect(() => loadStage1SchwarzmanPdfRecoveryCandidatePreimages({
        archiveRoot,
        sourceId,
        capturedAt,
        candidateDir: lexicalCandidateDir,
        textPath: join(lexicalCandidateDir, "text.txt"),
        metadataPath: join(lexicalCandidateDir, "meta.json"),
      })).toThrowError(expect.objectContaining({
        code: "pdf_text_recovery_candidate_path_invalid",
      }));
      expect(() => commitStage1PdfRecoveryCandidateFiles({
        archiveRoot,
        sourceId,
        capturedAt,
        candidateDir: lexicalCandidateDir,
        textPath: join(lexicalCandidateDir, "text.txt"),
        metadataPath: join(lexicalCandidateDir, "meta.json"),
        nextTextBytes: nextText,
        nextMetadataBytes: nextMetadata,
        expectedTextPreimageSha256: testSha256(externalText),
        expectedTextPreimageBytes: externalText.byteLength,
        expectedMetadataPreimageSha256: testSha256(externalMetadata),
        expectedMetadataPreimageBytes: externalMetadata.byteLength,
      }, mutationContract(nextText))).toThrowError(expect.objectContaining({
        code: "pdf_text_recovery_candidate_path_invalid",
      }));
      expect(readFileSync(join(candidateDir, "text.txt"))).toEqual(externalText);
      expect(readFileSync(join(candidateDir, "meta.json"))).toEqual(externalMetadata);
      expect(readFileSync(sentinelPath, "utf8")).toBe("external sentinel");
      expect(transactionResidue(candidateDir)).toEqual([]);
    } finally {
      if (junctionCreated && existsSync(lexicalSourceDir)) {
        unlinkSync(lexicalSourceDir);
      }
      rmSync(archiveRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});

describe.runIf(localFixtureAvailable)("retained Schwarzman recovery evidence", () => {
  it("accepts the exact retained generations without writing them", () => {
    const fixture = retainedFixture();
    const result = evaluateStage1SchwarzmanPdfRecovery(fixture);
    expect(result).toMatchObject({
      applies: true,
      accepted: true,
      reason: "exact_schwarzman_sealed_intake_text_recovery_verified",
      evidence: {
        schema_version: STAGE1_SCHWARZMAN_PDF_RECOVERY_SCHEMA,
        status: "accepted",
        parser_omission: {
          legacy_is_exact_subsequence: true,
          sealed_word_count: 3487,
          legacy_word_count: 3469,
          omitted_word_count: 18,
        },
        recovery: {
          same_pdf_bytes_verified: true,
          legacy_and_recovered_text_equal: false,
        },
        creates_api_charge: false,
        database_writes: 0,
        r2_writes: 0,
        local_baseline_writes: 0,
        public_fact_authority: false,
      },
      immutable_acquisition_identity: {
        file_hash:
          "fac3353cf079c7acfe7eaa7d8da685eba8275181d500373a149f2fdeff429263",
        text_hash:
          "9b50d2748660349bd5d4148453a0f2753cb668ebdf6a3e72d7aed43f43f53aaa",
      },
    });
    expect(result.evidence.parser_omission.omitted_words).toEqual([
      "or", "that", "we", "are", "no", "longer", "accepting", "videos",
      "shared", "via", "google", "drive", "save", "your", "video", "on",
      "youtube", "or",
    ]);
    expect(result.recovered_text_bytes.byteLength).toBe(22398);
  });

  it.each([
    ["sibling acquisition", (fixture) => {
      fixture.immutableAcquisition.id = "11111111-1111-4111-8111-111111111111";
    }, "acquisition_id_not_allowlisted"],
    ["altered activation guard", (fixture) => {
      fixture.immutableAcquisition.review_seal.human_source_disposition.guard_sha256 = "0".repeat(64);
    }, "activation_guard_not_allowlisted"],
    ["altered finalization", (fixture) => {
      fixture.sourceActivationFinalization.finalization_receipt_sha256 = "0".repeat(64);
    }, "finalization_receipt_not_allowlisted"],
    ["altered baseline bytes", (fixture) => {
      fixture.existingBaselineBytes[0] ^= 1;
    }, "baseline_json_sha256_not_allowlisted"],
    ["sibling R2 generation", (fixture) => {
      fixture.authoritativeExistingR2Binding.pointer_identity.immutable_generation = "0".repeat(32);
    }, "r2_binding_receipt_invalid"],
    ["tampered sealed text", (fixture) => {
      fixture.sealedIntakeArtifacts.bodies.text[0] ^= 1;
    }, "sealed_text_sha256_not_allowlisted"],
    ["different prospective PDF", (fixture) => {
      fixture.prospectivePreparedArtifacts.bodies.pdf[0] ^= 1;
    }, "prospective_pdf_sha256_not_allowlisted"],
    ["sibling prospective metadata", (fixture) => {
      const metadata = JSON.parse(fixture.prospectivePreparedArtifacts.bodies.meta);
      metadata.source.id = "11111111-1111-4111-8111-111111111111";
      fixture.prospectivePreparedArtifacts.bodies.meta = Buffer.from(JSON.stringify(metadata));
    }, "prospective_meta_source_not_allowlisted"],
    ["unexpected prospective parser text", (fixture) => {
      const text = "unexpected parser output";
      fixture.prospectiveCapture.text = text;
      fixture.prospectiveCapture.text_hash = "0".repeat(64);
      fixture.prospectiveCapture.text_length = text.length;
      fixture.prospectivePreparedArtifacts.bodies.text = Buffer.from(`${text}\n`);
      const metadata = JSON.parse(fixture.prospectivePreparedArtifacts.bodies.meta);
      metadata.text_hash = fixture.prospectiveCapture.text_hash;
      metadata.text_length = text.length;
      fixture.prospectivePreparedArtifacts.bodies.meta = Buffer.from(JSON.stringify(metadata));
    }, "prospective_parser_text_not_allowlisted"],
  ])("fails closed for %s", (_label, mutate, reason) => {
    const fixture = retainedFixture();
    mutate(fixture);
    expect(evaluateStage1SchwarzmanPdfRecovery(fixture)).toMatchObject({
      applies: true,
      accepted: false,
      reason,
      evidence: null,
    });
  });

  it("binds the independent receipt check to unequal old/new text and exact R2 authority", () => {
    const fixture = retainedFixture();
    const prepared = evaluateStage1SchwarzmanPdfRecovery(fixture);
    expect(prepared.accepted).toBe(true);
    const contract = stage1SchwarzmanPdfRecoveryExpectedContract();
    const prospective = {
      ...fixture.prospectiveCapture,
      text: prepared.recovered_text,
      text_hash: contract.sealed_intake.semantic_text_sha256,
      text_length: contract.sealed_intake.semantic_text_length,
    };
    const sealed = {
      file_hash_exact: contract.file_sha256,
      normalized_text_hash_exact: contract.sealed_intake.normalized_text_sha256,
      text_hash: contract.sealed_intake.semantic_text_sha256,
      source_acquisition_id_exact: contract.acquisition_id,
      request_id_exact: contract.request_id,
      final_url_exact: contract.final_url,
      page_type_exact: "pdf",
      reviewed_roles_exact: ["current_documents"],
    };
    const activation = fixture.existingBaseline.summary_metadata.stage1_baseline_activation;
    const check = evaluateStage1SchwarzmanPdfRecoveryReceipt({
      sourceId,
      exactSourceId: sourceId,
      kind: "pdf",
      reviewedFinalUrl: contract.final_url,
      activationGuardSha256: contract.activation_guard_sha256,
      sealedAcquisition: sealed,
      existingBaselineActivation: activation,
      existingCapture: fixture.existingCapture,
      prospectiveCapture: prospective,
      authoritativeR2Binding: fixture.authoritativeExistingR2Binding,
      receipt: prepared.evidence,
    });
    expect(check).toMatchObject({
      applies: true,
      accepted: true,
      reason: "exact_schwarzman_sealed_intake_text_recovery_receipt_verified",
    });

    const tampered = structuredClone(prepared.evidence);
    tampered.parser_omission.omitted_words[0] = "altered";
    expect(evaluateStage1SchwarzmanPdfRecoveryReceipt({
      sourceId,
      exactSourceId: sourceId,
      kind: "pdf",
      reviewedFinalUrl: contract.final_url,
      activationGuardSha256: contract.activation_guard_sha256,
      sealedAcquisition: sealed,
      existingBaselineActivation: activation,
      existingCapture: fixture.existingCapture,
      prospectiveCapture: prospective,
      authoritativeR2Binding: fixture.authoritativeExistingR2Binding,
      receipt: tampered,
    })).toMatchObject({
      applies: true,
      accepted: false,
      reason: "recovery_receipt_sha256_invalid",
    });
  });

  it.each([
    ["prospective generation", (receipt) => {
      receipt.prospective_observation.captured_at = "2026-08-15T04:22:35.000Z";
    }, "recovery_receipt_prospective_observation_shape_invalid"],
    ["recovered text identity", (receipt) => {
      receipt.recovery.recovered_text_sha256 = "0".repeat(64);
    }, "recovery_receipt_recovered_identity_not_allowlisted"],
    ["sealed text object", (receipt) => {
      receipt.sealed_intake_authority.text_object_sha256 = "0".repeat(64);
    }, "recovery_receipt_sealed_authority_not_allowlisted"],
    ["parser text object", (receipt) => {
      receipt.prospective_observation.parser_text_object_sha256 = "0".repeat(64);
    }, "recovery_receipt_parser_observation_not_allowlisted"],
    ["omission digest", (receipt) => {
      receipt.parser_omission.omitted_words_sha256 = "0".repeat(64);
    }, "recovery_receipt_omitted_words_digest_not_allowlisted"],
    ["explicit limitations", (receipt) => {
      receipt.limitations = [];
    }, "recovery_receipt_limitations_not_allowlisted"],
    ["candidate mutation authority", (receipt) => {
      receipt.authorized_local_candidate_mutation.authoritative = true;
    }, "recovery_receipt_candidate_mutation_scope_not_allowlisted"],
  ])("rejects a checksum-resealed %s claim", (_label, mutate, reason) => {
    const input = verifiedReceiptInput();
    const tampered = structuredClone(input.receipt);
    mutate(tampered);
    resealRecoveryReceipt(tampered);
    expect(evaluateStage1SchwarzmanPdfRecoveryReceipt({
      ...input,
      receipt: tampered,
    })).toMatchObject({
      applies: true,
      accepted: false,
      reason,
    });
  });

  it("admits only the recovered new generation through the ordinary validator", () => {
    const fixture = retainedFixture();
    const recovery = evaluateStage1SchwarzmanPdfRecovery(fixture);
    expect(recovery.accepted).toBe(true);
    const contract = stage1SchwarzmanPdfRecoveryExpectedContract();
    const prospectiveMeta = {
      ...readJson(`${retainedCanaryGeneration}/meta.json`),
      text_hash: contract.sealed_intake.semantic_text_sha256,
      text_length: contract.sealed_intake.semantic_text_length,
      stage1_pdf_text_recovery: recovery.evidence,
    };
    const prospectiveCapture = captureRecord({
      directory: retainedCanaryGeneration,
      metadata: prospectiveMeta,
      text: recovery.recovered_text,
    });
    const input = {
      sourceId,
      sourceKind: "pdf",
      immutableAcquisition: {
        acquisition: fixture.immutableAcquisition,
        identity: recovery.immutable_acquisition_identity,
      },
      existingBaseline: fixture.existingBaseline,
      existingCapture: captureRecord({
        directory: baselineGeneration,
        metadata: readJson(`${baselineGeneration}/meta.json`),
        text: readFileSync(`${baselineGeneration}/text.txt`, "utf8"),
        baseline: fixture.existingBaseline,
      }),
      existingPreparedArtifacts: preparedPdfArtifacts(baselineGeneration),
      authoritativeExistingR2Binding: fixture.authoritativeExistingR2Binding,
      capture: prospectiveCapture,
      capturePreparedArtifacts: preparedPdfArtifacts(retainedCanaryGeneration, {
        meta: Buffer.from(`${JSON.stringify(prospectiveMeta, null, 2)}\n`, "utf8"),
        text: recovery.recovered_text_bytes,
      }),
      pdfTextRecoveryReceipt: recovery.evidence,
    };

    const accepted = evaluateStage1EvidenceSchemaUpgradeCapture(input);
    expect(accepted).toMatchObject({
      decision:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.ELIGIBLE_UNCHANGED_UPGRADE,
      reason: "exact_pdf_bytes_and_sealed_intake_text_recovery_verified",
      evidence: {
        comparison: {
          semantic_fields: {
            text_hash: {
              matches: false,
              accepted_recovery: true,
              equivalence_basis: null,
            },
          },
          primary_visual_identity: {
            matches: true,
            equivalence_basis: "exact_hash",
          },
        },
        pdf_text_recovery: {
          recovery: {
            legacy_and_recovered_text_equal: false,
            same_pdf_bytes_verified: true,
          },
        },
      },
      outcome: {
        would_commit: true,
        would_queue_visual_candidate: false,
        would_quarantine: false,
      },
    });

    const missingReceipt = evaluateStage1EvidenceSchemaUpgradeCapture({
      ...input,
      pdfTextRecoveryReceipt: null,
    });
    expect(missingReceipt).toMatchObject({
      decision:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
      reason: "pdf_text_recovery_recovery_receipt_schema_invalid",
    });

    const siblingProspective = structuredClone(prospectiveCapture);
    siblingProspective.source.id = "11111111-1111-4111-8111-111111111111";
    expect(evaluateStage1EvidenceSchemaUpgradeCapture({
      ...input,
      capture: siblingProspective,
    })).toMatchObject({
      decision:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_DECISIONS.EVIDENCE_FAILURE_QUARANTINE,
      reason: "pdf_text_recovery_recovery_prospective_source_not_allowlisted",
    });
  });
});

function retainedFixture() {
  const baselineBytes = readFileSync(`${sourceRoot}/baseline.json`);
  const baseline = JSON.parse(baselineBytes);
  const acquisition = readAcquisition();
  const existingMeta = readJson(`${baselineGeneration}/meta.json`);
  const prospectiveMeta = readJson(`${retainedCanaryGeneration}/meta.json`);
  return {
    sourceId,
    exactSourceId: sourceId,
    sourceKind: "pdf",
    reviewedFinalUrl: baseline.final_url,
    immutableAcquisition: acquisition,
    sourceActivationFinalization: {
      source_acquisition_id: acquisition.id,
      shared_award_source_id: sourceId,
      source_page_request_id: acquisition.origin_source_page_request_id,
      guard_sha256:
        "2cea30f2e49bbdeb75d1d4581126e8658b55af52f0630a00f3fef18eb5a4f434",
      observed_normalized_text_sha256:
        "9b50d2748660349bd5d4148453a0f2753cb668ebdf6a3e72d7aed43f43f53aaa",
      finalization_receipt_sha256:
        "5577bfb230eba67f0aa5b7e61a68dc2e5cf9dd973a68886aeeb37a66500272df",
    },
    existingBaseline: baseline,
    existingBaselineBytes: baselineBytes,
    existingCapture: {
      ...existingMeta,
      text: readFileSync(`${baselineGeneration}/text.txt`, "utf8"),
    },
    existingPreparedArtifacts: preparedBodies(baselineGeneration),
    authoritativeExistingR2Binding: readR2Receipt(),
    prospectiveCapture: {
      ...prospectiveMeta,
      text: withoutWriterNewline(
        readFileSync(`${retainedCanaryGeneration}/text.txt`, "utf8"),
      ),
    },
    prospectivePreparedArtifacts: preparedBodies(retainedCanaryGeneration),
    sealedIntakeArtifacts:
      loadStage1SchwarzmanPdfSealedIntakeArtifacts({ archiveRoot }),
  };
}

function readAcquisition() {
  const report = readJson(
    "reports/stage1-baseline-source-disposition-preview-2026-08-03T18-18-26-939Z.json",
  );
  return report.confirmation_payload.decisions
    .find((decision) =>
      decision.acquisition_payload?.shared_award_source_id === sourceId)
    .acquisition_payload;
}

function readR2Receipt() {
  const report = readJson(
    "reports/visual-snapshot-run-2026-08-15T04-16-04-313Z-shard-1-ded87320.json",
  );
  return report.stage1_evidence_schema_upgrade.results
    .find((result) => result.source_id === sourceId)
    .capture_validation.evidence.authoritative_existing_r2_binding;
}

function preparedBodies(directory) {
  return {
    bodies: {
      meta: readFileSync(`${directory}/meta.json`),
      pdf: readFileSync(`${directory}/document.pdf`),
      text: readFileSync(`${directory}/text.txt`),
    },
  };
}

function preparedPdfArtifacts(directory, replacements = {}) {
  const files = [
    ["meta", "meta.json", "application/json; charset=utf-8"],
    ["pdf", "document.pdf", "application/pdf"],
    ["text", "text.txt", "text/plain; charset=utf-8"],
  ].map(([name, fileName, contentType]) => ({
    name,
    fileName,
    path: `${directory}/${fileName}`,
    contentType,
  }));
  return prepareR2CaptureArtifacts(files, {
    readFile(path) {
      const role = files.find((file) => file.path === path)?.name;
      return replacements[role] || readFileSync(path);
    },
  });
}

function captureRecord({ directory, metadata, text, baseline = null }) {
  return {
    ...metadata,
    dir: directory,
    pdf_path: `${directory}/document.pdf`,
    text_path: `${directory}/text.txt`,
    meta_path: `${directory}/meta.json`,
    text,
    expansion_state_screenshots: metadata.expansion_state_screenshots || [],
    retained_artifact_projection:
      metadata.retained_artifact_projection
      || baseline?.summary_metadata?.retained_artifact_projection
      || null,
  };
}

function verifiedReceiptInput() {
  const fixture = retainedFixture();
  const recovery = evaluateStage1SchwarzmanPdfRecovery(fixture);
  const contract = stage1SchwarzmanPdfRecoveryExpectedContract();
  return {
    sourceId,
    exactSourceId: sourceId,
    kind: "pdf",
    reviewedFinalUrl: contract.final_url,
    activationGuardSha256: contract.activation_guard_sha256,
    sealedAcquisition: {
      file_hash_exact: contract.file_sha256,
      normalized_text_hash_exact: contract.sealed_intake.normalized_text_sha256,
      text_hash: contract.sealed_intake.semantic_text_sha256,
      source_acquisition_id_exact: contract.acquisition_id,
      request_id_exact: contract.request_id,
      final_url_exact: contract.final_url,
      page_type_exact: "pdf",
      reviewed_roles_exact: ["current_documents"],
    },
    existingBaselineActivation:
      fixture.existingBaseline.summary_metadata.stage1_baseline_activation,
    existingCapture: fixture.existingCapture,
    prospectiveCapture: {
      ...fixture.prospectiveCapture,
      text: recovery.recovered_text,
      text_hash: contract.sealed_intake.semantic_text_sha256,
      text_length: contract.sealed_intake.semantic_text_length,
    },
    authoritativeR2Binding: fixture.authoritativeExistingR2Binding,
    receipt: recovery.evidence,
  };
}

function resealRecoveryReceipt(receipt) {
  const { receipt_sha256: ignored, ...basis } = receipt;
  void ignored;
  receipt.receipt_sha256 = createHash("sha256")
    .update(canonicalJson(basis))
    .digest("hex");
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

function mutationFixture() {
  const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-recovery-transaction-"));
  const capturedAt = "2026-08-15T04:22:34.967Z";
  const generation = capturedAt.replace(/[:.]/g, "-");
  const candidateDir = join(
    archiveRoot,
    "sources",
    sourceId,
    "captures",
    generation,
  );
  const textPath = join(candidateDir, "text.txt");
  const metadataPath = join(candidateDir, "meta.json");
  const oldText = Buffer.from("parser output before recovery\n", "utf8");
  const oldMetadata = Buffer.from("{\"status\":\"parser-output\"}\n", "utf8");
  const nextText = Buffer.from("exact sealed intake text\n", "utf8");
  const nextMetadata = Buffer.from("{\"status\":\"recovered\"}\n", "utf8");
  mkdirSync(candidateDir, { recursive: true });
  writeFileSync(textPath, oldText);
  writeFileSync(metadataPath, oldMetadata);
  return {
    archiveRoot,
    candidateDir,
    textPath,
    metadataPath,
    oldText,
    oldMetadata,
    nextText,
    nextMetadata,
    contract: mutationContract(nextText),
    input: {
      archiveRoot,
      sourceId,
      capturedAt,
      candidateDir,
      textPath,
      metadataPath,
      nextTextBytes: nextText,
      nextMetadataBytes: nextMetadata,
      expectedTextPreimageSha256: testSha256(oldText),
      expectedTextPreimageBytes: oldText.byteLength,
      expectedMetadataPreimageSha256: testSha256(oldMetadata),
      expectedMetadataPreimageBytes: oldMetadata.byteLength,
    },
    cleanup() {
      rmSync(archiveRoot, { recursive: true, force: true });
    },
  };
}

function mutationContract(nextText) {
  return {
    source_id: sourceId,
    forbidden_captured_at: "2026-08-03T18:52:07.825Z",
    recovered_text_object_sha256: testSha256(nextText),
    recovered_text_object_bytes: nextText.byteLength,
  };
}

function transactionResidue(candidateDir) {
  return readdirSync(candidateDir)
    .filter((name) => name.startsWith(".stage1-schwarzman-pdf-recovery"))
    .sort();
}

function testSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function withoutWriterNewline(value) {
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}
