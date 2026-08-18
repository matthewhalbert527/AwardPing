import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_SOURCE_PREIMAGE_COLUMNS,
  assertStage1EvidenceSchemaUpgradeReviewedRecoverySourceHealthRequest,
  createStage1EvidenceSchemaUpgradeReviewedRecoveryRuntime,
  guardStage1EvidenceSchemaUpgradeReviewedRecoverySourcePreimage,
  inspectStage1EvidenceSchemaUpgradeReviewedRecoveryLocalR2Roles,
  inspectStage1EvidenceSchemaUpgradeReviewedRecoveryRetainedR2Binding,
  inspectStage1EvidenceSchemaUpgradeReviewedRecoveryRuntimePath,
  stage1EvidenceSchemaUpgradeReviewedRecoveryR2AuthorityBaselineBytes,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-runtime.mjs";
import {
  executeStage1EvidenceSchemaUpgradeReviewedRecovery,
  inspectStage1EvidenceSchemaUpgradeReviewedRecovery,
  sealStage1EvidenceSchemaUpgradeReviewedRecoveryPlan,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-worker.mjs";
import {
  candidateBaseline,
  currentSnapshot,
  fixtureState,
  journalAtPhase,
  liveSourceHealthSucceeded,
  oldBaseline,
  recoveryRuntimeFinalizationReceiptFixture,
  recoveryRuntimeGenerationFixture,
  sourceId,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-plan.test.mjs";
import {
  buildStage1EvidenceSchemaUpgradeReviewedRecoveryArchivedSucceededTerminal,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-execution.mjs";
import {
  stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs";
import {
  sealStage1EvidenceSchemaUpgradeMutationAccounting,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";
import {
  stage1EvidenceSchemaUpgradeReviewedApplyTransactionId,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-execution.mjs";
import {
  normalizeStage1EvidenceSchemaUpgradeReviewedRecoveryCurrentR2Receipt,
  stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-plan.mjs";
import {
  stage1EvidenceSchemaUpgradeBaselineBytes,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import {
  beineckeFaqLegacyFixtureBody,
  beineckeFaqLegacyFixtureJson,
} from "./fixtures/beinecke-faq-legacy-geometry-fixture.mjs";
import {
  runStage1EvidenceSchemaUpgradeReviewedRecoveryCli,
} from "../stage1-evidence-schema-upgrade-reviewed-recovery.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reviewed recovery operational runtime capability surface", () => {
  it("exposes only read-only inspection and the four exact execution callbacks", async () => {
    const fixture = await fixtureState();
    const runtime = runtimeFixture(fixture);
    expect(Object.keys(runtime.inspectionInterfaces).sort()).toEqual([
      "readRecoveryEvidence",
      "withSourceLock",
    ]);
    expect(Object.keys(runtime.executionInterfaces).sort()).toEqual([
      "finishOriginalAudit",
      "readRecoveryEvidence",
      "recoverActiveJournal",
      "withSourceLock",
    ]);
    for (const forbidden of [
      "captureDryRun",
      "compareAndSwapLatestPointer",
      "enqueueCandidate",
      "persistQuarantine",
      "uploadImmutableCandidateArtifact",
    ]) {
      expect(runtime.executionInterfaces[forbidden]).toBeUndefined();
      expect(runtime.inspectionInterfaces[forbidden]).toBeUndefined();
    }
  });

  it("rejects expanded evidence and mutation requests before any database or R2 call", async () => {
    const fixture = await fixtureState();
    const db = { from: vi.fn(), rpc: vi.fn() };
    const readR2Object = vi.fn();
    const runtime = runtimeFixture(fixture, { db, readR2Object });
    await expect(runtime.inspectionInterfaces.readRecoveryEvidence({
      source_id: sourceId,
      transaction_id: "wrong",
      reviewed_apply_plan_file_sha256: fixture.apply.plan_file_sha256,
      reviewed_apply_plan_sha256: fixture.apply.plan_sha256,
      read_only: true,
      creates_api_charge: false,
      capture: true,
    })).rejects.toThrow(/unexpected|missing fields/i);
    expect(() => runtime.executionInterfaces.recoverActiveJournal({
      source_id: sourceId,
      transaction_id: "wrong",
      creates_api_charge: false,
    })).toThrow(/active source lock session/i);
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
    expect(readR2Object).not.toHaveBeenCalled();
  });

  it.each(["baseline", "journal_archive"])(
    "rejects an external junction at the %s mutation boundary without touching its sentinel",
    async (kind) => {
      const root = temporaryDirectory("awardping-recovery-root-");
      const external = temporaryDirectory("awardping-recovery-external-");
      const sentinel = join(external, "sentinel.txt");
      writeFileSync(sentinel, "untouched", "utf8");
      const sourceRoot = join(root, "sources", sourceId);
      mkdirSync(sourceRoot, { recursive: true });
      let target;
      if (kind === "baseline") {
        const redirectedSource = join(root, "sources", `${sourceId}-redirected`);
        symlinkSync(external, redirectedSource, process.platform === "win32" ? "junction" : "dir");
        target = join(redirectedSource, "baseline.json");
      } else {
        const journalRoot = join(sourceRoot, "stage1-evidence-schema-upgrade-journals");
        symlinkSync(external, journalRoot, process.platform === "win32" ? "junction" : "dir");
        target = join(journalRoot, "completed", "transaction.json");
      }
      expect(() => inspectStage1EvidenceSchemaUpgradeReviewedRecoveryRuntimePath({
        archiveRoot: root,
        targetPath: target,
        mutationBoundary: true,
      })).toThrow(/reparse point/i);
      expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    },
  );

  it("rejects a junctioned exact source directory before acquiring the source lock", async () => {
    const fixture = await fixtureState();
    const root = temporaryDirectory("awardping-recovery-lock-root-");
    const external = temporaryDirectory("awardping-recovery-lock-external-");
    const sentinel = join(external, "sentinel.txt");
    writeFileSync(sentinel, "untouched", "utf8");
    mkdirSync(join(root, "sources"), { recursive: true });
    symlinkSync(
      external,
      join(root, "sources", sourceId),
      process.platform === "win32" ? "junction" : "dir",
    );
    const execute = vi.fn();
    const runtime = runtimeFixture(fixture, { archiveRoot: root });
    await expect(runtime.inspectionInterfaces.withSourceLock({
      source_id: sourceId,
      transaction_id: "11111111-1111-4111-8111-111111111112",
      read_only: true,
      creates_api_charge: false,
      execute,
    })).rejects.toThrow(/reparse point/i);
    expect(execute).not.toHaveBeenCalled();
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
  });

  it.each(["local_candidate_written", "pointer_cas_attempted"])(
    "verifies the old R2 generation from journal bytes when %s has a candidate local baseline",
    async (phase) => {
      const fixture = await fixtureState();
      const journal = journalAtPhase(fixture, phase);
      const selected = stage1EvidenceSchemaUpgradeReviewedRecoveryR2AuthorityBaselineBytes({
        currentBaselineBytes: candidateBaseline,
        currentPointer: journal.old_pointer_identity.projection,
        journals: { active: journal, archived: null },
      });
      expect(selected).toEqual(stage1EvidenceSchemaUpgradeBaselineBytes(journal.old_baseline));
      expect(selected).toEqual(oldBaseline);
    },
  );

  it("accepts the exact nine-field source-health request for an active candidate phase", async () => {
    const fixture = await fixtureState();
    const journal = journalAtPhase(fixture, "pointer_candidate_committed");
    const request = {
      source_id: sourceId,
      transaction_id: journal.transaction_id,
      context: "stage1_evidence_schema_upgrade",
      authoritative_pointer: journal.candidate_pointer_identity.projection,
      candidate_baseline_sha256: journal.candidate_baseline.sha256,
      precommit_source_authority:
        journal.operation_binding.precommit_source_authority,
      preserve_reviewed_url: true,
      preserve_reviewed_metadata: true,
      creates_api_charge: false,
    };
    expect(assertStage1EvidenceSchemaUpgradeReviewedRecoverySourceHealthRequest({
      request,
      sourceId,
      transactionId: journal.transaction_id,
      initialJournal: journal,
    })).toEqual(request);
    const missing = { ...request };
    delete missing.preserve_reviewed_metadata;
    expect(() => assertStage1EvidenceSchemaUpgradeReviewedRecoverySourceHealthRequest({
      request: missing,
      sourceId,
      transactionId: journal.transaction_id,
      initialJournal: journal,
    })).toThrow(/unexpected|missing fields/i);
  });

  it("uses only scalar null-safe source preimage filters when page_metadata is JSON", () => {
    const calls = [];
    const query = {
      eq(column, value) { calls.push(["eq", column, value]); return this; },
      is(column, value) { calls.push(["is", column, value]); return this; },
    };
    const source = Object.fromEntries(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_SOURCE_PREIMAGE_COLUMNS
        .map((column) => [column, `${column}-value`]),
    );
    source.page_metadata = { reviewed: true };
    source.reason = null;
    expect(guardStage1EvidenceSchemaUpgradeReviewedRecoverySourcePreimage(query, source))
      .toBe(query);
    expect(calls.map(([, column]) => column)).toEqual(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECOVERY_SOURCE_PREIMAGE_COLUMNS,
    );
    expect(calls.some(([, column]) => column === "page_metadata")).toBe(false);
    expect(calls.find(([, column]) => column === "reason")).toEqual([
      "is",
      "reason",
      null,
    ]);
  });

  it("reconstructs all four legacy local-only expansion image/layout role pairs", () => {
    const root = temporaryDirectory("awardping-recovery-expansion-root-");
    const captureRoot = join(root, "captures", "faq-proof");
    mkdirSync(captureRoot, { recursive: true });
    for (const name of ["page.jpg", "thumb.jpg", "text.txt", "layout.json"]) {
      writeFileSync(join(captureRoot, name), name.endsWith(".json") ? "{}" : name);
    }
    const expansionStates = [];
    const metadataStates = [];
    for (let index = 1; index <= 4; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const page = `expansion-state-${suffix}.jpg`;
      const layout = `expansion-state-${suffix}-layout.json`;
      writeFileSync(join(captureRoot, page), page);
      writeFileSync(join(captureRoot, layout), "{}");
      expansionStates.push({
        state_id: `expansion-state-${suffix}`,
        index: index - 1,
        page: `captures/faq-proof/${page}`,
        layout: `captures/faq-proof/${layout}`,
      });
      metadataStates.push({ state_id: `expansion-state-${suffix}`, index: index - 1 });
    }
    writeFileSync(join(captureRoot, "meta.json"), JSON.stringify({
      kind: "webpage",
      expansion_state_screenshots: metadataStates,
    }));
    const baseline = Buffer.from(JSON.stringify({
      kind: "webpage",
      capture: {
        dir: "captures/faq-proof",
        page: "captures/faq-proof/page.jpg",
        thumb: "captures/faq-proof/thumb.jpg",
        text: "captures/faq-proof/text.txt",
        layout: "captures/faq-proof/layout.json",
        meta: "captures/faq-proof/meta.json",
        expansion_states: expansionStates,
      },
    }));
    const pointer = {
      latest_object_keys: {
        layout: "layout-key",
        meta: "meta-key",
        page: "page-key",
        text: "text-key",
        thumb: "thumb-key",
      },
    };
    const inspected = inspectStage1EvidenceSchemaUpgradeReviewedRecoveryLocalR2Roles({
      archiveRoot: root,
      sourceId,
      baselineBytes: baseline,
      pointer,
    });
    expect(inspected.expansion_state_count).toBe(4);
    expect(inspected.roles.filter((role) => role.startsWith("expansion_state_")))
      .toHaveLength(8);
  });

  it("reproduces the exact retained FAQ pointer and R2 binding receipt hermetically", async () => {
    const root = temporaryDirectory("awardping-recovery-retained-faq-");
    const fixtureRoot = join(
      import.meta.dirname,
      "fixtures",
      "beinecke-faq-retained-r2",
    );
    const baselineBytes = readFileSync(join(fixtureRoot, "baseline.json"));
    const baseline = JSON.parse(baselineBytes.toString("utf8"));
    const captureDirectory = join(
      root,
      ...baseline.capture.dir.split("/"),
    );
    mkdirSync(captureDirectory, { recursive: true });
    const exactBodies = {
      "layout.json": beineckeFaqLegacyFixtureBody("layout"),
      "meta.json": beineckeFaqLegacyFixtureBody("meta"),
      "text.txt": beineckeFaqLegacyFixtureBody("legacy_full_text"),
      "expansion-state-01-layout.json":
        beineckeFaqLegacyFixtureBody("expansion_state_01_layout"),
      "expansion-state-02-layout.json":
        beineckeFaqLegacyFixtureBody("expansion_state_02_layout"),
      "expansion-state-03-layout.json":
        beineckeFaqLegacyFixtureBody("expansion_state_03_layout"),
      "expansion-state-04-layout.json":
        beineckeFaqLegacyFixtureBody("expansion_state_04_layout"),
    };
    for (const name of [
      "page.jpg",
      "thumb.jpg",
      "expansion-state-01.jpg",
      "expansion-state-02.jpg",
      "expansion-state-03.jpg",
      "expansion-state-04.jpg",
      "expansion-text.txt",
      "sections.json",
    ]) exactBodies[name] = readFileSync(join(fixtureRoot, name));
    for (const [name, body] of Object.entries(exactBodies)) {
      writeFileSync(join(captureDirectory, name), body);
    }
    const storedReceipt = beineckeFaqLegacyFixtureJson("r2_binding_receipt");
    const meta = beineckeFaqLegacyFixtureJson("meta");
    const latestMetadata = beineckeFaqLegacyLatestMetadata({
      baseline,
      meta,
      textObjectBytes: exactBodies["text.txt"].byteLength,
    });
    expect(sha256(canonicalJson(latestMetadata)))
      .toBe("4494e5eeac796c909c92b3bbd3684b941ab600fd2ae1d4927aae3966c7395960");
    expect(Object.hasOwn(latestMetadata, "retained_artifact_projection")).toBe(false);
    expect(Object.hasOwn(latestMetadata, "expansion_state_capture_coverage")).toBe(false);
    const pointerIdentity = storedReceipt.pointer_identity;
    const pointer = {
      shared_award_source_id: pointerIdentity.shared_award_source_id,
      kind: pointerIdentity.kind,
      bucket: pointerIdentity.bucket,
      latest_captured_at: pointerIdentity.latest_captured_at,
      latest_object_keys: structuredClone(pointerIdentity.latest_object_keys),
      latest_hashes: structuredClone(pointerIdentity.latest_hashes),
      latest_metadata: latestMetadata,
      previous_captured_at: storedReceipt.previous_pointer.previous_captured_at,
      previous_object_keys: structuredClone(
        storedReceipt.previous_pointer.previous_object_keys,
      ),
      previous_hashes: structuredClone(storedReceipt.previous_pointer.previous_hashes),
      previous_metadata: structuredClone(
        storedReceipt.previous_pointer.previous_metadata,
      ),
    };
    const receipt = await
    inspectStage1EvidenceSchemaUpgradeReviewedRecoveryRetainedR2Binding({
      archiveRoot: root,
      sourceId,
      baselineBytes,
      pointer,
      remoteBodiesByRole: {
        layout: exactBodies["layout.json"],
        meta: exactBodies["meta.json"],
        page: exactBodies["page.jpg"],
        text: exactBodies["text.txt"],
        thumb: exactBodies["thumb.jpg"],
      },
    });
    expect(receipt.pointer_identity.pointer_sha256)
      .toBe("5ea2ec78cf4b82878e6c74a67dfcf21ab775ec09c9b4d3644257f4e4ecca2c2e");
    expect(receipt.receipt_sha256)
      .toBe("31ec0a7081d7db8822e11ea1384e42dddbef1e834db633dcaedebc40a50e8d1b");
    expect(receipt).toEqual(storedReceipt);
    expect(normalizeStage1EvidenceSchemaUpgradeReviewedRecoveryCurrentR2Receipt({
      receipt,
      sourceId,
      currentPointer: pointer,
    })).toEqual(storedReceipt);
  });

  it("accepts precise offset-equivalent live finalization timestamps and projects canonical milliseconds", async () => {
    const harness = await productionRuntimeHarness();
    harness.finalization.finalized_at = "2026-08-15T04:30:00.000050-05:00";
    harness.dbState.source.admin_reviewed_at =
      "2026-08-15T10:30:00.00005+01:00";
    const evidence = await readInspectionEvidence(harness);
    expect(
      evidence.currentAuthoritySnapshot.finalizationProjection.finalized_at,
    ).toBe("2026-08-15T09:30:00.000Z");
    expect(harness.finalization.receipt.finalized_at)
      .toBe("2026-08-15T09:30:00.00005+00:00");
    expect(harness.finalization.finalization_receipt_sha256)
      .toBe(harness.fixture.apply.plan.selected.finalization.receipt_sha256);
    expect(harness.dbState.auditUpdates).toBe(0);
  });

  it.each([
    ["adjacent millisecond", (row) => {
      row.finalized_at = "2026-08-15T09:30:00.00105Z";
    }],
    ["invalid timestamp", (row) => { row.finalized_at = "not-a-timestamp"; }],
    ["null timestamp", (row) => { row.finalized_at = null; }],
    ["one-microsecond row drift", (row) => {
      row.finalized_at = "2026-08-15T09:30:00.000051Z";
    }],
    ["one-microsecond receipt drift", (row) => {
      row.receipt.finalized_at = "2026-08-15T09:30:00.000051Z";
      row.finalization_receipt_sha256 = sha256(
        Buffer.from(canonicalJson(row.receipt)),
      );
    }],
    ["one-microsecond admin drift", (_row, _fixture, state) => {
      state.source.admin_reviewed_at = "2026-08-15T09:30:00.000051Z";
    }],
  ])("rejects %s on the finalization authority reread", async (_label, mutate) => {
    const harness = await productionRuntimeHarness();
    mutate(harness.finalization, harness.fixture, harness.dbState);
    await expectInspectionEvidenceRejection(
      harness,
      /finalization authority changed/i,
    );
  });

  it.each([
    ["source acquisition ID", (row) => {
      row.source_acquisition_id = "11111111-1111-4111-8111-111111111111";
    }],
    ["activation guard SHA-256", (row) => { row.guard_sha256 = "0".repeat(64); }],
    ["stored receipt SHA-256", (row) => {
      row.finalization_receipt_sha256 = "0".repeat(64);
    }],
    ["sealed receipt payload", (row) => { row.receipt.status = "tampered"; }],
  ])("keeps the live %s exact while normalizing timestamps", async (_label, mutate) => {
    const harness = await productionRuntimeHarness();
    mutate(harness.finalization, harness.fixture, harness.dbState);
    await expectInspectionEvidenceRejection(harness, /authority changed/i);
  });

  it("executes an exact no-journal failed finish through the production runtime", async () => {
    const harness = await productionRuntimeHarness();
    const report = await executeStage1EvidenceSchemaUpgradeReviewedRecovery(
      harness.executionArguments,
    );
    expect(report).toMatchObject({
      status: "failed",
      disposition: "audit_failed_finished",
      creates_api_charge: false,
    });
    expect(harness.dbState.auditUpdates).toBe(1);
    expect(harness.fixture.auditStore.updateRun).toHaveBeenCalledOnce();
  });

  it("executes through the standalone CLI default composition and real runtime", async () => {
    const harness = await productionRuntimeHarness();
    const files = {
      apply: join(harness.archiveRoot, "reviewed-apply-plan.json"),
      report: join(harness.archiveRoot, "reviewed-dry-run-report.json"),
      manifest: join(harness.archiveRoot, "stage1-manifest.json"),
      inspection: join(harness.archiveRoot, "reviewed-recovery-inspection.json"),
      plan: join(harness.archiveRoot, "reviewed-recovery-plan.json"),
      output: join(harness.archiveRoot, "reviewed-recovery-report.json"),
    };
    writeFileSync(files.apply, harness.fixture.applyPlanBytes);
    writeFileSync(files.report, harness.fixture.reviewedDryRunReportBytes);
    writeFileSync(files.manifest, `${JSON.stringify(harness.fixture.manifest)}\n`);
    writeFileSync(files.inspection, harness.inspected.inspection_bytes);
    writeFileSync(files.plan, harness.sealed.plan_bytes);
    const result = await runStage1EvidenceSchemaUpgradeReviewedRecoveryCli({
      argv: [
        "--mode=execute",
        `--apply-plan-file=${files.apply}`,
        `--apply-plan-sha256=${harness.fixture.expectedApplyPlanFileSha256}`,
        `--reviewed-dry-run-report-file=${files.report}`,
        `--manifest-file=${files.manifest}`,
        `--archive-root=${harness.archiveRoot}`,
        `--recovery-inspection-file=${files.inspection}`,
        `--recovery-inspection-file-sha256=${harness.inspected.inspection_file_sha256}`,
        `--recovery-plan-file=${files.plan}`,
        `--recovery-plan-file-sha256=${harness.sealed.plan_file_sha256}`,
        `--recovery-plan-sha256=${harness.sealed.plan.plan_sha256}`,
        `--recovery-report-output-file=${files.output}`,
      ],
      processEnvironment: {
        NEXT_PUBLIC_SUPABASE_URL: "https://hermetic.supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "hermetic-service-role-key",
        R2_ENDPOINT: "https://hermetic.r2.test",
        R2_ACCESS_KEY_ID: "hermetic-access-key",
        R2_SECRET_ACCESS_KEY: "hermetic-secret-key",
        R2_BUCKET: harness.fixture.apply.plan.selected.r2.bucket,
      },
      dependencies: {
        defaultRuntimeAdapters: harness.defaultRuntimeAdapters,
        now: () => "2026-08-20T11:30:00.000Z",
      },
    });
    expect(result).toMatchObject({
      exitCode: 0,
      status: "failed",
      disposition: "audit_failed_finished",
      mutation_performed: true,
    });
    expect(harness.defaultRuntimeAdapters.createSupabaseClient).toHaveBeenCalledOnce();
    expect(harness.defaultRuntimeAdapters.createR2Client).toHaveBeenCalledOnce();
    expect(harness.defaultR2Destroy).toHaveBeenCalledOnce();
    expect(harness.dbState.auditUpdates).toBe(1);
    expect(JSON.parse(readFileSync(files.output, "utf8")).report_sha256)
      .toBe(result.report_sha256);
  });

  it("rejects coherent old-authority drift before the audit update", async () => {
    const harness = await productionRuntimeHarness();
    harness.useCandidateAuthority({ source: harness.fixture.current.currentSource });
    await expect(executeStage1EvidenceSchemaUpgradeReviewedRecovery(
      harness.executionArguments,
    )).rejects.toThrow(/changed|differs|authority|evidence/i);
    expect(harness.dbState.auditUpdates).toBe(0);
    expect(harness.fixture.auditStore.updateRun).not.toHaveBeenCalled();
  });

  it("rejects forged plan self seals and cross-parent runtime authority before I/O", async () => {
    const harness = await productionRuntimeHarness();
    harness.resetIoSpies();
    const forged = JSON.parse(harness.sealed.plan_bytes.toString("utf8"));
    forged.expected_disposition = "inspect_active_ambiguous_leave_running";
    const forgedBytes = Buffer.from(JSON.stringify(forged), "utf8");
    expect(() => createStage1EvidenceSchemaUpgradeReviewedRecoveryRuntime({
      ...harness.runtimeOptions,
      reviewedRecoveryAuthority: {
        ...harness.reviewedRecoveryAuthority,
        recoveryPlanBytes: forgedBytes,
        expectedRecoveryPlanFileSha256: sha256(forgedBytes),
      },
    })).toThrow(/self seal|canonical bytes/i);
    expect(() => createStage1EvidenceSchemaUpgradeReviewedRecoveryRuntime({
      ...harness.runtimeOptions,
      reviewedApplyPlan: {
        ...harness.fixture.apply,
        selected_source_id: "11111111-1111-4111-8111-111111111111",
      },
      reviewedRecoveryAuthority: harness.reviewedRecoveryAuthority,
    })).toThrow(/parent.*apply authority/i);
    expect(harness.db.from).not.toHaveBeenCalled();
    expect(harness.db.rpc).not.toHaveBeenCalled();
    expect(harness.readR2Object).not.toHaveBeenCalled();
  });

  it("rejects direct, inspection-lock, and overlapping mutation capabilities before I/O", async () => {
    const harness = await productionRuntimeHarness();
    harness.resetIoSpies();
    const request = forbiddenActiveRequest(harness);
    expect(() => harness.runtime.executionInterfaces.recoverActiveJournal(request))
      .toThrow(/active source lock session/i);
    await expect(harness.runtime.inspectionInterfaces.withSourceLock({
      source_id: sourceId,
      transaction_id: harness.transactionId,
      read_only: true,
      creates_api_charge: false,
      execute: async () => harness.runtime.executionInterfaces.recoverActiveJournal(request),
    })).rejects.toThrow(/active source lock session/i);
    await harness.runtime.executionInterfaces.withSourceLock({
      source_id: sourceId,
      transaction_id: harness.transactionId,
      creates_api_charge: false,
      execute: async () => {
        const first = harness.runtime.executionInterfaces.recoverActiveJournal(request);
        expect(() => harness.runtime.executionInterfaces.recoverActiveJournal(request))
          .toThrow(/only one top-level mutation/i);
        expect(() => harness.runtime.executionInterfaces.finishOriginalAudit({}))
          .toThrow(/only one top-level mutation/i);
        await expect(first).rejects.toThrow(/does not authorize active journal mutation/i);
      },
    });
    expect(harness.db.from).not.toHaveBeenCalled();
    expect(harness.db.rpc).not.toHaveBeenCalled();
    expect(harness.readR2Object).not.toHaveBeenCalled();
  });

  it("drains a detached recovery mutation before releasing the source lock", async () => {
    const harness = await productionRuntimeHarness({
      configureFixture: configureActiveCompletedCandidate,
    });
    let signalStarted;
    let releaseRead;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const release = new Promise((resolve) => { releaseRead = resolve; });
    harness.dbState.onR2Read = async () => {
      signalStarted();
      await release;
    };
    const locked = harness.runtime.executionInterfaces.withSourceLock({
      source_id: sourceId,
      transaction_id: harness.transactionId,
      creates_api_charge: false,
      execute: () => {
        harness.runtime.executionInterfaces.recoverActiveJournal(
          activeRecoveryRequest(harness),
        );
        return "detached_callback_returned";
      },
    });
    await started;
    let settled = false;
    void locked.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseRead();
    await expect(locked).resolves.toBe("detached_callback_returned");
    expect(harness.fixture.audit.row_kind).toBe("running");
  });

  it("propagates a detached unobserved recovery rejection before lock release", async () => {
    const harness = await productionRuntimeHarness({
      configureFixture: configureActiveCompletedCandidate,
    });
    await expect(harness.runtime.executionInterfaces.withSourceLock({
      source_id: sourceId,
      transaction_id: harness.transactionId,
      creates_api_charge: false,
      execute: () => {
        harness.runtime.executionInterfaces.recoverActiveJournal({
          ...activeRecoveryRequest(harness),
          expected_active_journal_sha256: "0".repeat(64),
        });
        return "detached_rejection";
      },
    })).rejects.toThrow(/detached reviewed recovery mutation failed/i);
    expect(harness.dbState.auditUpdates).toBe(0);
  });

  it.each([
    ["success-only then", (promise) => promise.then(() => undefined)],
    ["finally", (promise) => promise.finally(() => undefined)],
  ])("does not treat detached %s as a rejection observer", async (_label, detach) => {
    const harness = await productionRuntimeHarness({
      configureFixture: configureActiveCompletedCandidate,
    });
    await expect(harness.runtime.executionInterfaces.withSourceLock({
      source_id: sourceId,
      transaction_id: harness.transactionId,
      creates_api_charge: false,
      execute: () => {
        detach(harness.runtime.executionInterfaces.recoverActiveJournal({
          ...activeRecoveryRequest(harness),
          expected_active_journal_sha256: "0".repeat(64),
        }));
        return "detached_rejection_with_nonhandler";
      },
    })).rejects.toThrow(/detached reviewed recovery mutation failed/i);
    expect(harness.dbState.auditUpdates).toBe(0);
  });

  it("allows exact sequential recover then finish in one writable lock", async () => {
    const harness = await productionRuntimeHarness({
      configureFixture: configureActiveCompletedCandidate,
    });
    const outcome = await harness.runtime.executionInterfaces.withSourceLock({
      source_id: sourceId,
      transaction_id: harness.transactionId,
      creates_api_charge: false,
      execute: async () => {
        const result = await harness.runtime.executionInterfaces.recoverActiveJournal(
          activeRecoveryRequest(harness),
        );
        expect(result.status).toBe("upgraded");
        const evidence = await harness.runtime.executionInterfaces.readRecoveryEvidence(
          executionEvidenceRequest(harness),
        );
        const terminal = selectedTerminalFromCommit({
          audit: evidence.auditInspection,
          result,
          evaluatedAt: "2026-08-20T11:30:00.000Z",
        });
        const finishReceipt = await harness.runtime.executionInterfaces.finishOriginalAudit(
          finishAuditRequest(harness, evidence, terminal),
        );
        return { result, finishReceipt };
      },
    });
    expect(outcome.finishReceipt).toMatchObject({
      action: "finish",
      disposition: "finished",
      terminal_status: "succeeded",
      terminal_completion_authority_mode: "reviewed_recovery",
    });
    expect(harness.dbState.auditUpdates).toBe(1);
  });

  it("preserves the reviewed pre-completed start phase through recover then finish", async () => {
    const harness = await productionRuntimeHarness({
      configureFixture: configureActivePointerCandidateCommitted,
    });
    const outcome = await harness.runtime.executionInterfaces.withSourceLock({
      source_id: sourceId,
      transaction_id: harness.transactionId,
      creates_api_charge: false,
      execute: async () => {
        const result = await harness.runtime.executionInterfaces.recoverActiveJournal(
          activeRecoveryRequest(harness),
        );
        expect(result).toMatchObject({
          status: "upgraded",
          receipt: { outcome: "committed_candidate" },
        });
        const evidence = await harness.runtime.executionInterfaces.readRecoveryEvidence(
          executionEvidenceRequest(harness),
        );
        const terminal = selectedTerminalFromCommit({
          audit: evidence.auditInspection,
          result,
          evaluatedAt: "2026-08-20T11:30:00.000Z",
        });
        const finishReceipt = await harness.runtime.executionInterfaces.finishOriginalAudit(
          finishAuditRequest(harness, evidence, terminal),
        );
        return { result, finishReceipt };
      },
    });
    expect(outcome.finishReceipt).toMatchObject({
      disposition: "finished",
      terminal_status: "succeeded",
    });
    expect(harness.dbState.auditUpdates).toBe(1);
    expect((await harness.fixture.auditStore.readRun({
      run_id: harness.fixture.audit.run_id,
    })).status).toBe("succeeded");
  });

  it("rejects a forged internally consistent archived success without a runtime recovery result", async () => {
    const harness = await productionRuntimeHarness({
      configureFixture: configureArchivedCompletedCandidate,
    });
    const journal = harness.fixture.journals.archived;
    const exact = buildStage1EvidenceSchemaUpgradeReviewedRecoveryArchivedSucceededTerminal({
      sourceId,
      transactionId: harness.transactionId,
      journal,
      auditInspection: harness.fixture.audit,
      evaluatedAt: "2026-08-20T11:30:00.000Z",
    });
    const forged = forgeCurrentInvocationTerminal(exact);
    await expect(harness.runtime.executionInterfaces.withSourceLock({
      source_id: sourceId,
      transaction_id: harness.transactionId,
      creates_api_charge: false,
      execute: async () => {
        const evidence = await harness.runtime.executionInterfaces.readRecoveryEvidence(
          executionEvidenceRequest(harness),
        );
        return harness.runtime.executionInterfaces.finishOriginalAudit(
          finishAuditRequest(harness, evidence, forged),
        );
      },
    })).rejects.toThrow(/archived replay terminal is not exact|runtime invocation/i);
    expect(harness.dbState.auditUpdates).toBe(0);
  });

  it.each([
    ["expiry", "2026-08-20T13:00:00.000Z"],
    ["clock rollback", "2026-08-20T11:29:00.000Z"],
  ])("fails closed when %s is reached during the first R2 evidence read", async (
    _label,
    changedTime,
  ) => {
    let currentTime = "2026-08-20T11:30:00.000Z";
    const harness = await productionRuntimeHarness({
      runtimeNow: () => currentTime,
    });
    harness.dbState.onR2Read = () => { currentTime = changedTime; };
    const invocation = executeStage1EvidenceSchemaUpgradeReviewedRecovery(
      harness.executionArguments,
    );
    await expect(invocation).rejects.toThrow(
      _label === "expiry" ? /bounded review window/i : /clock moved backward/i,
    );
    expect(harness.dbState.auditUpdates).toBe(0);
    expect(harness.fixture.audit.row_kind).toBe("running");
  });
});

function runtimeFixture(fixture, {
  db = { from: vi.fn(), rpc: vi.fn() },
  readR2Object = vi.fn(),
  archiveRoot = temporaryDirectory("awardping-reviewed-recovery-runtime-"),
} = {}) {
  return createStage1EvidenceSchemaUpgradeReviewedRecoveryRuntime({
    supabase: db,
    archiveRoot,
    readR2Object,
    r2Bucket: fixture.apply.plan.selected.r2.bucket,
    reviewedApplyPlan: fixture.apply,
    sourceId,
    transactionId: "11111111-1111-4111-8111-111111111112",
    now: () => "2026-08-20T11:30:00.000Z",
  });
}

async function productionRuntimeHarness({
  configureFixture = null,
  runtimeNow = () => "2026-08-20T11:30:00.000Z",
} = {}) {
  const fixture = await fixtureState();
  if (configureFixture) await configureFixture(fixture);
  const archiveRoot = temporaryDirectory("awardping-reviewed-recovery-production-");
  const transactionId = stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
    sourceId,
    planSha256: fixture.apply.plan_sha256,
  });
  const oldGeneration = recoveryRuntimeGenerationFixture({
    label: "old",
    capturedAt: "2026-08-14T18:00:00.000Z",
    generation: "a".repeat(32),
  });
  const candidateGeneration = recoveryRuntimeGenerationFixture({
    label: "candidate",
    capturedAt: "2026-08-20T10:00:00.000Z",
    generation: "b".repeat(32),
  });
  materializeGeneration(archiveRoot, oldGeneration);
  materializeGeneration(archiveRoot, candidateGeneration);
  const baselinePath = join(archiveRoot, "sources", sourceId, "baseline.json");
  mkdirSync(join(archiveRoot, "sources", sourceId), { recursive: true });
  writeFileSync(baselinePath, fixture.current.currentBaselineBytes);
  const journalRoot = join(
    archiveRoot,
    "sources",
    sourceId,
    "stage1-evidence-schema-upgrade-journals",
  );
  if (fixture.journals.active) {
    mkdirSync(journalRoot, { recursive: true });
    writeFileSync(
      join(journalRoot, "active.json"),
      `${JSON.stringify(fixture.journals.active, null, 2)}\n`,
    );
  }
  if (fixture.journals.archived) {
    const completed = join(journalRoot, "completed");
    mkdirSync(completed, { recursive: true });
    writeFileSync(
      join(completed, `${transactionId}.json`),
      `${JSON.stringify(fixture.journals.archived, null, 2)}\n`,
    );
  }

  const dbState = {
    source: structuredClone(fixture.current.currentSource),
    pointer: structuredClone(fixture.current.currentPointer),
    auditUpdates: 0,
    onR2Read: null,
  };
  const acquisition = acquisitionRow(fixture);
  const finalization = finalizationRow(fixture);
  const db = fakeRecoveryDatabase({ fixture, dbState, acquisition, finalization });
  const remote = new Map();
  for (const generation of [oldGeneration, candidateGeneration]) {
    for (const artifact of generation.prepared.artifacts) {
      remote.set(generation.objectKeys[artifact.name], artifact);
    }
  }
  const readR2Object = vi.fn(async (request) => {
    await dbState.onR2Read?.(request);
    const artifact = remote.get(request.key);
    if (!artifact) throw new Error(`Missing test R2 object ${request.key}.`);
    return {
      bucket: request.bucket,
      key: request.key,
      body: Buffer.from(artifact.body),
      expected_byte_length: request.expected_byte_length,
      content_type: artifact.contentType,
      byte_length: artifact.body.byteLength,
      mutation_performed: false,
      creates_api_charge: false,
    };
  });
  const defaultR2Destroy = vi.fn();
  const defaultR2Send = vi.fn(async (command) => {
    const request = command?.input || {};
    await dbState.onR2Read?.({ bucket: request.Bucket, key: request.Key });
    const artifact = remote.get(request.Key);
    if (!artifact) throw new Error(`Missing default-runtime test R2 object ${request.Key}.`);
    return {
      Body: Buffer.from(artifact.body),
      ContentLength: artifact.body.byteLength,
      ContentType: artifact.contentType,
    };
  });
  const defaultRuntimeAdapters = {
    createSupabaseClient: vi.fn(() => db),
    createR2Client: vi.fn(() => ({ send: defaultR2Send, destroy: defaultR2Destroy })),
    closeSupabaseTransport: vi.fn(async () => {}),
  };
  const runtimeOptions = {
    supabase: db,
    archiveRoot,
    readR2Object,
    defaultRuntimeAdapters,
    defaultR2Destroy,
    defaultR2Send,
    r2Bucket: fixture.apply.plan.selected.r2.bucket,
    reviewedApplyPlan: fixture.apply,
    sourceId,
    transactionId,
    now: runtimeNow,
  };
  const inspectionRuntime = createStage1EvidenceSchemaUpgradeReviewedRecoveryRuntime(
    runtimeOptions,
  );
  const parent = {
    applyPlanBytes: fixture.applyPlanBytes,
    expectedApplyPlanFileSha256: fixture.expectedApplyPlanFileSha256,
    reviewedDryRunReportBytes: fixture.reviewedDryRunReportBytes,
    manifest: fixture.manifest,
  };
  const inspected = await inspectStage1EvidenceSchemaUpgradeReviewedRecovery({
    ...parent,
    interfaces: inspectionRuntime.inspectionInterfaces,
    now: () => "2026-08-20T11:00:00.000Z",
  });
  const sealed = sealStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
    inspectionBytes: inspected.inspection_bytes,
    expectedInspectionFileSha256: inspected.inspection_file_sha256,
    ...parent,
    reviewer: {
      reviewer_id: "operator@example.test",
      reviewed_at: "2026-08-20T11:05:00.000Z",
      expires_at: "2026-08-20T13:00:00.000Z",
    },
    now: () => "2026-08-20T11:06:00.000Z",
  });
  const reviewedRecoveryAuthority = {
    recoveryPlanBytes: sealed.plan_bytes,
    expectedRecoveryPlanFileSha256: sealed.plan_file_sha256,
    expectedRecoveryPlanSha256: sealed.plan.plan_sha256,
    inspectionBytes: inspected.inspection_bytes,
    expectedInspectionFileSha256: inspected.inspection_file_sha256,
    ...parent,
  };
  const runtime = createStage1EvidenceSchemaUpgradeReviewedRecoveryRuntime({
    ...runtimeOptions,
    reviewedRecoveryAuthority,
  });
  const executionArguments = {
    recoveryPlanBytes: sealed.plan_bytes,
    expectedRecoveryPlanFileSha256: sealed.plan_file_sha256,
    expectedRecoveryPlanSha256: sealed.plan.plan_sha256,
    inspectionBytes: inspected.inspection_bytes,
    expectedInspectionFileSha256: inspected.inspection_file_sha256,
    ...parent,
    interfaces: runtime.executionInterfaces,
    now: runtimeNow,
  };
  const harness = {
    fixture,
    archiveRoot,
    transactionId,
    oldGeneration,
    candidateGeneration,
    dbState,
    db,
    finalization,
    readR2Object,
    defaultRuntimeAdapters,
    defaultR2Destroy,
    defaultR2Send,
    runtimeOptions,
    inspected,
    sealed,
    reviewedRecoveryAuthority,
    runtime,
    executionArguments,
    useCandidateAuthority({ source = liveSourceHealthSucceeded() } = {}) {
      const journal = journalAtPhase(fixture, "completed");
      dbState.source = structuredClone(source);
      dbState.pointer = structuredClone(journal.candidate_pointer_identity.projection);
      writeFileSync(baselinePath, candidateBaseline);
    },
    resetIoSpies() {
      db.from.mockClear();
      db.rpc.mockClear();
      readR2Object.mockClear();
      fixture.auditStore.updateRun.mockClear();
    },
  };
  harness.resetIoSpies();
  return harness;
}

function materializeGeneration(root, generation) {
  for (const artifact of generation.prepared.artifacts) {
    const path = join(root, artifact.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, artifact.body);
  }
}

function acquisitionRow(fixture) {
  const selected = fixture.apply.plan.selected.acquisition;
  return {
    id: selected.source_acquisition_id,
    shared_award_source_id: sourceId,
    review_seal: {
      retained_artifact: {
        file_hash: selected.file_sha256,
        text_hash: selected.text_sha256,
      },
      human_source_disposition: {
        activation_guard: {
          capture_file_sha256: selected.file_sha256,
          normalized_retained_text_sha256: selected.normalized_text_sha256,
        },
        effective_source_review: {
          evidence_quotes: Array.from(
            { length: selected.evidence_quote_count },
            (_, index) => ({ quote: `reviewed quote ${index}` }),
          ),
        },
      },
    },
  };
}

function finalizationRow(fixture) {
  const selected = fixture.apply.plan.selected;
  const receipt = recoveryRuntimeFinalizationReceiptFixture({
    reviewedSourceId: sourceId,
    guardSha256: selected.activation.guard_sha256,
  });
  return {
    disposition_item_sha256: "1".repeat(64),
    finalization_receipt_sha256: selected.finalization.receipt_sha256,
    finalized_at: receipt.finalized_at,
    guard_sha256: selected.activation.guard_sha256,
    observed_normalized_text_sha256: selected.acquisition.normalized_text_sha256,
    persistence_evidence: {},
    prepare_receipt_sha256: "2".repeat(64),
    receipt,
    shared_award_source_id: sourceId,
    source_acquisition_id: selected.acquisition.source_acquisition_id,
    source_page_request_id: null,
  };
}

function fakeRecoveryDatabase({ fixture, dbState, acquisition, finalization }) {
  const from = vi.fn((table) => fakeRecoveryQuery({
    table,
    fixture,
    dbState,
    acquisition,
  }));
  const rpc = vi.fn(async (name) => {
    if (name !== "get_stage1_source_activation_finalizations") {
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    }
    return { data: [structuredClone(finalization)], error: null };
  });
  return { from, rpc };
}

function fakeRecoveryQuery({ table, fixture, dbState, acquisition }) {
  let patch = null;
  const query = {
    select() { return query; },
    eq() { return query; },
    is() { return query; },
    contains() { return query; },
    update(value) { patch = structuredClone(value); return query; },
    async maybeSingle() {
      if (patch && table === "local_worker_runs") {
        dbState.auditUpdates += 1;
        const row = await fixture.auditStore.readRun({ run_id: fixture.audit.run_id });
        const updated = await fixture.auditStore.updateRun({
          guard: {
            id: row.id,
            status: row.status,
            running_metadata_sha256: row.metadata.metadata_sha256,
          },
          patch,
        });
        return { data: updated, error: null };
      }
      if (table === "shared_award_sources") {
        return { data: structuredClone(dbState.source), error: null };
      }
      if (table === "shared_award_source_acquisitions") {
        return { data: structuredClone(acquisition), error: null };
      }
      if (table === "shared_award_source_visual_snapshots") {
        return { data: structuredClone(dbState.pointer), error: null };
      }
      if (table === "local_worker_runs") {
        return {
          data: await fixture.auditStore.readRun({ run_id: fixture.audit.run_id }),
          error: null,
        };
      }
      return { data: null, error: { message: `unexpected table ${table}` } };
    },
  };
  return query;
}

function forbiddenActiveRequest(harness) {
  return {
    source_id: sourceId,
    transaction_id: harness.transactionId,
    expected_active_journal_sha256: "0".repeat(64),
    operation_binding: null,
    recovery_plan_file_sha256: harness.sealed.plan_file_sha256,
    recovery_plan_sha256: harness.sealed.plan.plan_sha256,
    recovery_plan_expires_at: harness.sealed.plan.reviewer.expires_at,
    expected_recovery_evidence_sha256: "1".repeat(64),
    expected_audit_inspection_sha256: harness.fixture.audit.inspection_sha256,
    creates_api_charge: false,
  };
}

function configureActiveCompletedCandidate(fixture) {
  const completed = journalAtPhase(fixture, "completed");
  fixture.journals = { active: completed, archived: null };
  fixture.current = currentSnapshot(fixture, {
    baselineBytes: candidateBaseline,
    pointer: completed.candidate_pointer_identity.projection,
    source: liveSourceHealthSucceeded(),
  });
}

function configureActivePointerCandidateCommitted(fixture) {
  const active = journalAtPhase(fixture, "pointer_candidate_committed");
  fixture.journals = { active, archived: null };
  fixture.current = currentSnapshot(fixture, {
    baselineBytes: candidateBaseline,
    pointer: active.candidate_pointer_identity.projection,
    source: liveSourceHealthSucceeded(),
  });
}

function configureArchivedCompletedCandidate(fixture) {
  const completed = journalAtPhase(fixture, "completed");
  fixture.journals = { active: null, archived: completed };
  fixture.current = currentSnapshot(fixture, {
    baselineBytes: candidateBaseline,
    pointer: completed.candidate_pointer_identity.projection,
    source: liveSourceHealthSucceeded(),
  });
}

function activeRecoveryRequest(harness) {
  const active = harness.fixture.journals.active;
  return {
    source_id: sourceId,
    transaction_id: harness.transactionId,
    expected_active_journal_sha256: active.journal_sha256,
    operation_binding: structuredClone(active.operation_binding),
    recovery_plan_file_sha256: harness.sealed.plan_file_sha256,
    recovery_plan_sha256: harness.sealed.plan.plan_sha256,
    recovery_plan_expires_at: harness.sealed.plan.reviewer.expires_at,
    expected_recovery_evidence_sha256:
      harness.inspected.inspection.evidence_sha256,
    expected_audit_inspection_sha256: harness.fixture.audit.inspection_sha256,
    creates_api_charge: false,
  };
}

function executionEvidenceRequest(harness) {
  return {
    source_id: sourceId,
    transaction_id: harness.transactionId,
    reviewed_apply_plan_file_sha256: harness.fixture.apply.plan_file_sha256,
    reviewed_apply_plan_sha256: harness.fixture.apply.plan_sha256,
    creates_api_charge: false,
  };
}

async function expectInspectionEvidenceRejection(harness, errorPattern) {
  await expect(harness.runtime.inspectionInterfaces.withSourceLock({
    source_id: sourceId,
    transaction_id: harness.transactionId,
    read_only: true,
    creates_api_charge: false,
    execute: async () => {
      await expect(harness.runtime.inspectionInterfaces.readRecoveryEvidence({
        ...executionEvidenceRequest(harness),
        read_only: true,
      })).rejects.toThrow(errorPattern);
    },
  })).resolves.toBeUndefined();
}

async function readInspectionEvidence(harness) {
  let evidence;
  await harness.runtime.inspectionInterfaces.withSourceLock({
    source_id: sourceId,
    transaction_id: harness.transactionId,
    read_only: true,
    creates_api_charge: false,
    execute: async () => {
      evidence = await harness.runtime.inspectionInterfaces.readRecoveryEvidence({
        ...executionEvidenceRequest(harness),
        read_only: true,
      });
    },
  });
  return evidence;
}

function finishAuditRequest(harness, evidence, terminal) {
  return {
    source_id: sourceId,
    transaction_id: harness.transactionId,
    reviewed_apply_plan_file_sha256: harness.fixture.apply.plan_file_sha256,
    reviewed_apply_plan_sha256: harness.fixture.apply.plan_sha256,
    recovery_plan_file_sha256: harness.sealed.plan_file_sha256,
    recovery_plan_sha256: harness.sealed.plan.plan_sha256,
    recovery_plan_expires_at: harness.sealed.plan.reviewer.expires_at,
    completion_authority:
      stage1EvidenceSchemaUpgradeReviewedApplyAuditRecoveryCompletionAuthority({
        recoveryPlan: harness.sealed.plan,
        expectedRecoveryPlanFileSha256: harness.sealed.plan_file_sha256,
        expectedRecoveryPlanSha256: harness.sealed.plan.plan_sha256,
        sourceId,
        transactionId: harness.transactionId,
      }),
    expected_recovery_evidence_sha256:
      stage1EvidenceSchemaUpgradeReviewedRecoveryEvidenceSha256(evidence),
    execution_nonce: evidence.auditInspection.execution_nonce,
    expected_audit_inspection_sha256: evidence.auditInspection.inspection_sha256,
    finished_at: "2026-08-20T11:30:00.000Z",
    terminal,
    creates_api_charge: false,
  };
}

function selectedTerminalFromCommit({ audit, result, evaluatedAt }) {
  const selected = structuredClone(audit.fresh_capture.capture_result);
  selected.evaluated_at = evaluatedAt;
  selected.mode = "apply";
  selected.status = "upgraded";
  selected.pointer_journal = {
    status: "upgraded",
    receipt: structuredClone(result.receipt),
  };
  selected.visual_review_candidate = { status: "not_planned", receipt: null };
  selected.quarantine = { status: "not_requested" };
  selected.mutation_counts = structuredClone(result.mutation_counts);
  selected.mutation_count_certainty = structuredClone(result.mutation_count_certainty);
  for (const key of [
    "candidate_writes",
    "database_writes",
    "local_baseline_writes",
    "quarantine_writes",
    "r2_writes",
    "source_state_writes",
  ]) delete selected.safety?.[key];
  return {
    status: "succeeded",
    selected_result: selected,
    commit_receipt: structuredClone(result.receipt),
  };
}

function forgeCurrentInvocationTerminal(value) {
  const terminal = structuredClone(value);
  const counts = {
    ...terminal.commit_receipt.mutation_counts,
    database_writes: 1,
    source_state_writes: 1,
  };
  const archiveContent = {
    schema_version:
      "awardping.stage1.evidence-schema-upgrade-journal-archive-accounting.v1",
    state: "verified",
    local_journal_archive_writes_lower_bound: 1,
    archive_receipt_acknowledged: true,
    archived_readback_verified: true,
    active_absence_verified: true,
    response_loss_possible: false,
  };
  const journalArchive = {
    ...archiveContent,
    evidence_sha256: sha256(canonicalJson(archiveContent)),
  };
  const accounting = sealStage1EvidenceSchemaUpgradeMutationAccounting({
    operation: "pointer_commit",
    lowerBoundCounts: counts,
    unknownWriteCategories: [],
    evidence: {
      boundary: "completed_journal_archive",
      journal_phase: "completed",
      response_loss_possible: false,
      journal_persistence: {
        state: "not_started",
        local_journal_writes_lower_bound: 0,
        response_loss_possible: false,
      },
      journal_archive: journalArchive,
    },
  });
  Object.assign(terminal.commit_receipt, {
    mutation_counts: counts,
    mutation_accounting: accounting,
    source_health: { status: "succeeded", mutation_counts: counts },
  });
  terminal.selected_result.mutation_counts = structuredClone(counts);
  terminal.selected_result.mutation_count_certainty = {
    exact: true,
    count_semantics: "exact",
    unknown_write_categories: [],
  };
  terminal.selected_result.pointer_journal.receipt = structuredClone(
    terminal.commit_receipt,
  );
  return terminal;
}

function beineckeFaqLegacyLatestMetadata({ baseline, meta, textObjectBytes }) {
  const capture = {
    ...meta,
    capture_profile: baseline.capture_profile || meta.capture_profile || null,
    final_url: baseline.final_url || meta.final_url || null,
    page_title: baseline.page_title || meta.page_title || null,
    text_length: baseline.text_length || meta.text_length || 0,
    body_text_length: baseline.body_text_length || meta.body_text_length || 0,
    main_content_text_length:
      baseline.main_content_text_length || meta.main_content_text_length || 0,
    nav_header_footer_text_length:
      baseline.nav_header_footer_text_length || meta.nav_header_footer_text_length || 0,
    expansion_text_length:
      baseline.expansion_text_length || meta.expansion_text_length || 0,
    file_bytes: baseline.file_bytes || meta.file_bytes || null,
    page_bytes: baseline.page_bytes || meta.page_bytes || null,
    thumb_bytes: baseline.thumb_bytes || meta.thumb_bytes || null,
    dimensions: baseline.dimensions || meta.dimensions || null,
    layout_hash: baseline.layout_hash || meta.layout_hash || null,
    baseline_facts:
      baseline.summary_metadata?.baseline_facts || meta.baseline_facts || null,
    baseline_facts_metadata:
      baseline.summary_metadata?.baseline_facts_metadata
      || meta.baseline_facts_metadata
      || null,
  };
  return {
    capture_profile: capture.capture_profile || null,
    final_url: capture.final_url || null,
    page_title: capture.page_title || null,
    status_code: capture.status_code || null,
    status_text: capture.status_text || null,
    content_type: capture.content_type || null,
    stage1_baseline_activation: capture.stage1_baseline_activation || null,
    text_length: capture.text_length || 0,
    text_object_bytes: textObjectBytes,
    body_text_length: capture.body_text_length || 0,
    main_content_text_length: capture.main_content_text_length || 0,
    nav_header_footer_text_length: capture.nav_header_footer_text_length || 0,
    expansion_text_length: capture.expansion_text_length || 0,
    file_bytes: capture.file_bytes || null,
    page_bytes: capture.page_bytes || null,
    thumb_bytes: capture.thumb_bytes || null,
    dimensions: capture.dimensions || null,
    layout_hash: capture.layout_hash || capture.text_geometry?.geometry_hash || null,
    text_geometry: capture.text_geometry || null,
    page_count: capture.page_count || null,
    expansion_state_count: capture.expansion_state_screenshots?.length || 0,
    expansion_state_screenshots:
      capture.expansion_state_screenshots?.map((state) => ({
        state_id: state.state_id || null,
        label: state.label,
        image_hash: state.image_hash,
        layout_hash: state.layout_hash || state.text_geometry?.geometry_hash || null,
        text_geometry: state.text_geometry || null,
        text_hash: state.text_hash,
        text_length: state.text_length,
        page_bytes: state.page_bytes,
        isolation: state.isolation || null,
      })) || [],
    pdf_text_error: capture.pdf_text_error || null,
    baseline_facts: capture.baseline_facts || null,
    baseline_facts_metadata: capture.baseline_facts_metadata || null,
    monitoring_disposition: capture.monitoring_disposition || null,
    localization: capture.localization,
  };
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function temporaryDirectory(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
