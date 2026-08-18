import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finishStage1EvidenceSchemaUpgradeReviewedApplyAudit,
  inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery,
} from "./lib/stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs";
import {
  runStage1EvidenceSchemaUpgradeReviewedRecoveryCli,
  stage1EvidenceSchemaUpgradeReviewedRecoveryR2ResponseBody,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery.mjs";
import {
  fixtureState,
} from "./lib/stage1-evidence-schema-upgrade-reviewed-recovery-plan.test.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reviewed recovery standalone CLI", () => {
  it("keeps inspect generation read-only and emits exact canonical plan bytes", async () => {
    const fixture = await fixtureState();
    const files = fixtureFiles(fixture);
    const readRecoveryEvidence = vi.fn(async () => evidence(fixture));
    const createRuntime = vi.fn(async () => ({
      runtime: {
        inspectionInterfaces: {
          readRecoveryEvidence,
          withSourceLock: async (request) => request.execute(),
        },
        executionInterfaces: forbiddenExecutionInterfaces(),
      },
    }));
    const result = await runStage1EvidenceSchemaUpgradeReviewedRecoveryCli({
      argv: [
        "--mode=inspect",
        `--apply-plan-file=${files.apply}`,
        `--apply-plan-sha256=${fixture.expectedApplyPlanFileSha256}`,
        `--reviewed-dry-run-report-file=${files.report}`,
        `--manifest-file=${files.manifest}`,
        `--recovery-inspection-output-file=${files.recoveryInspection}`,
      ],
      processEnvironment: {},
      dependencies: {
        createRuntime,
        now: () => "2026-08-20T11:30:00.000Z",
      },
    });
    expect(result).toMatchObject({
      exitCode: 0,
      mode: "inspect",
      mutation_performed: false,
      creates_api_charge: false,
    });
    const bytes = readFileSync(files.recoveryInspection);
    expect(JSON.parse(bytes.toString("utf8")).inspection_sha256)
      .toBe(result.inspection_sha256);
    expect(readRecoveryEvidence).toHaveBeenCalledOnce();
    expect(createRuntime).toHaveBeenCalledOnce();
  });

  it("executes only a separately reviewed file+self hash and writes its sealed report", async () => {
    const fixture = await fixtureState();
    const files = fixtureFiles(fixture);
    const createRuntime = vi.fn(async () => ({
      runtime: runtimeForFixture(fixture),
    }));
    const inspected = await runStage1EvidenceSchemaUpgradeReviewedRecoveryCli({
      argv: inspectArgs(files, fixture),
      processEnvironment: {},
      dependencies: {
        createRuntime,
        now: () => "2026-08-20T11:30:00.000Z",
      },
    });
    const sealed = await runStage1EvidenceSchemaUpgradeReviewedRecoveryCli({
      argv: sealArgs(files, fixture, inspected),
      processEnvironment: {},
      dependencies: {
        createRuntime: vi.fn(() => {
          throw new Error("seal mode must not create a runtime");
        }),
        now: () => "2026-08-20T11:36:00.000Z",
      },
    });
    const executed = await runStage1EvidenceSchemaUpgradeReviewedRecoveryCli({
      argv: [
        "--mode=execute",
        `--apply-plan-file=${files.apply}`,
        `--apply-plan-sha256=${fixture.expectedApplyPlanFileSha256}`,
        `--reviewed-dry-run-report-file=${files.report}`,
        `--manifest-file=${files.manifest}`,
        `--recovery-plan-file=${files.recoveryPlan}`,
        `--recovery-plan-file-sha256=${sealed.plan_file_sha256}`,
        `--recovery-plan-sha256=${sealed.plan_sha256}`,
        `--recovery-inspection-file=${files.recoveryInspection}`,
        `--recovery-inspection-file-sha256=${inspected.inspection_file_sha256}`,
        `--recovery-report-output-file=${files.recoveryReport}`,
      ],
      processEnvironment: {},
      dependencies: {
        createRuntime,
        now: () => "2026-08-20T11:40:00.000Z",
      },
    });
    expect(executed).toMatchObject({
      exitCode: 0,
      mode: "execute",
      status: "failed",
      mutation_performed: true,
      creates_api_charge: false,
    });
    const report = JSON.parse(readFileSync(files.recoveryReport, "utf8"));
    expect(report.report_sha256).toBe(executed.report_sha256);
    expect(report.audit_terminal.status).toBe("failed");
    expect(fixture.audit.row_kind).toBe("terminal_failed");
    const executeRuntimeArguments = createRuntime.mock.calls.at(-1)[0];
    expect(Object.keys(executeRuntimeArguments.reviewedRecoveryAuthority).sort())
      .toEqual([
        "applyPlanBytes",
        "expectedApplyPlanFileSha256",
        "expectedInspectionFileSha256",
        "expectedRecoveryPlanFileSha256",
        "expectedRecoveryPlanSha256",
        "inspectionBytes",
        "manifest",
        "recoveryPlanBytes",
        "reviewedDryRunReportBytes",
      ].sort());
    expect(executeRuntimeArguments.reviewedRecoveryAuthority).toEqual({
      recoveryPlanBytes: readFileSync(files.recoveryPlan),
      expectedRecoveryPlanFileSha256: sealed.plan_file_sha256,
      expectedRecoveryPlanSha256: sealed.plan_sha256,
      inspectionBytes: readFileSync(files.recoveryInspection),
      expectedInspectionFileSha256: inspected.inspection_file_sha256,
      applyPlanBytes: fixture.applyPlanBytes,
      expectedApplyPlanFileSha256: fixture.expectedApplyPlanFileSha256,
      reviewedDryRunReportBytes: fixture.reviewedDryRunReportBytes,
      manifest: fixture.manifest,
    });
  });

  it("composes the standalone default runtime with the exact reviewed authority", async () => {
    const fixture = await fixtureState();
    const files = fixtureFiles(fixture);
    const createSupabaseClient = vi.fn(() => ({ kind: "hermetic-supabase" }));
    const destroy = vi.fn();
    const createR2Client = vi.fn(() => ({
      send: vi.fn(async () => { throw new Error("unexpected hermetic R2 read"); }),
      destroy,
    }));
    const createRecoveryRuntime = vi.fn(() => runtimeForFixture(fixture));
    const closeSupabaseTransport = vi.fn(async () => {});
    const defaultRuntimeAdapters = {
      createSupabaseClient,
      createR2Client,
      createRecoveryRuntime,
      closeSupabaseTransport,
    };
    const processEnvironment = {
      NEXT_PUBLIC_SUPABASE_URL: "https://hermetic.supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "hermetic-service-role-key",
      R2_ENDPOINT: "https://hermetic.r2.test",
      R2_ACCESS_KEY_ID: "hermetic-access-key",
      R2_SECRET_ACCESS_KEY: "hermetic-secret-key",
      R2_BUCKET: "hermetic-reviewed-recovery",
    };
    const inspected = await runStage1EvidenceSchemaUpgradeReviewedRecoveryCli({
      argv: inspectArgs(files, fixture),
      processEnvironment,
      dependencies: {
        defaultRuntimeAdapters,
        now: () => "2026-08-20T11:30:00.000Z",
      },
    });
    const sealed = await runStage1EvidenceSchemaUpgradeReviewedRecoveryCli({
      argv: sealArgs(files, fixture, inspected),
      processEnvironment,
      dependencies: { now: () => "2026-08-20T11:36:00.000Z" },
    });
    const executed = await runStage1EvidenceSchemaUpgradeReviewedRecoveryCli({
      argv: [
        "--mode=execute",
        `--apply-plan-file=${files.apply}`,
        `--apply-plan-sha256=${fixture.expectedApplyPlanFileSha256}`,
        `--reviewed-dry-run-report-file=${files.report}`,
        `--manifest-file=${files.manifest}`,
        `--recovery-plan-file=${files.recoveryPlan}`,
        `--recovery-plan-file-sha256=${sealed.plan_file_sha256}`,
        `--recovery-plan-sha256=${sealed.plan_sha256}`,
        `--recovery-inspection-file=${files.recoveryInspection}`,
        `--recovery-inspection-file-sha256=${inspected.inspection_file_sha256}`,
        `--recovery-report-output-file=${files.recoveryReport}`,
      ],
      processEnvironment,
      dependencies: {
        defaultRuntimeAdapters,
        now: () => "2026-08-20T11:40:00.000Z",
      },
    });
    expect(executed).toMatchObject({ status: "failed", exitCode: 0 });
    const runtimeOptions = createRecoveryRuntime.mock.calls.at(-1)[0];
    expect(runtimeOptions.supabase).toEqual({ kind: "hermetic-supabase" });
    expect(runtimeOptions.r2Bucket).toBe("hermetic-reviewed-recovery");
    expect(runtimeOptions.reviewedRecoveryAuthority).toEqual({
      recoveryPlanBytes: readFileSync(files.recoveryPlan),
      expectedRecoveryPlanFileSha256: sealed.plan_file_sha256,
      expectedRecoveryPlanSha256: sealed.plan_sha256,
      inspectionBytes: readFileSync(files.recoveryInspection),
      expectedInspectionFileSha256: inspected.inspection_file_sha256,
      applyPlanBytes: fixture.applyPlanBytes,
      expectedApplyPlanFileSha256: fixture.expectedApplyPlanFileSha256,
      reviewedDryRunReportBytes: fixture.reviewedDryRunReportBytes,
      manifest: fixture.manifest,
    });
    expect(createSupabaseClient).toHaveBeenCalledWith(
      "https://hermetic.supabase.test",
      "hermetic-service-role-key",
    );
    expect(createR2Client).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(closeSupabaseTransport).toHaveBeenCalledTimes(2);
  });

  it("rejects mixed inspect/execute and capture authority before runtime creation", async () => {
    const fixture = await fixtureState();
    const files = fixtureFiles(fixture);
    const createRuntime = vi.fn();
    await expect(runStage1EvidenceSchemaUpgradeReviewedRecoveryCli({
      argv: [
        ...inspectArgs(files, fixture),
        `--recovery-plan-file=${files.recoveryPlan}`,
        "--browser=true",
      ],
      processEnvironment: {},
      dependencies: { createRuntime },
    })).rejects.toThrow(/forbids arguments/i);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("consumes an async R2 response body exactly once", async () => {
    let iterations = 0;
    const body = {
      async *[Symbol.asyncIterator]() {
        iterations += 1;
        if (iterations > 1) throw new Error("body was consumed twice");
        yield Buffer.from("first");
        yield Buffer.from("-second");
      },
    };
    await expect(stage1EvidenceSchemaUpgradeReviewedRecoveryR2ResponseBody(body, {
      expectedByteLength: Buffer.byteLength("first-second"),
    }))
      .resolves.toEqual(Buffer.from("first-second"));
    expect(iterations).toBe(1);
  });

  it("aborts an R2 stream before buffering beyond its sealed byte length", async () => {
    const destroy = vi.fn();
    const body = {
      destroy,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("1234");
        yield Buffer.from("56");
      },
    };
    await expect(stage1EvidenceSchemaUpgradeReviewedRecoveryR2ResponseBody(body, {
      expectedByteLength: 5,
    })).rejects.toThrow(/exceeded its sealed byte length/i);
    expect(destroy).toHaveBeenCalledOnce();
  });
});

function fixtureFiles(fixture) {
  const root = mkdtempSync(join(tmpdir(), "awardping-reviewed-recovery-"));
  temporaryRoots.push(root);
  const paths = {
    apply: join(root, "apply-plan.json"),
    report: join(root, "reviewed-report.json"),
    manifest: join(root, "manifest.json"),
    recoveryPlan: join(root, "recovery-plan.json"),
    recoveryInspection: join(root, "recovery-inspection.json"),
    recoveryReport: join(root, "recovery-report.json"),
  };
  writeFileSync(paths.apply, fixture.applyPlanBytes);
  writeFileSync(paths.report, fixture.reviewedDryRunReportBytes);
  writeFileSync(paths.manifest, `${JSON.stringify(fixture.manifest)}\n`, "utf8");
  return paths;
}

function inspectArgs(files, fixture) {
  return [
    "--mode=inspect",
    `--apply-plan-file=${files.apply}`,
    `--apply-plan-sha256=${fixture.expectedApplyPlanFileSha256}`,
    `--reviewed-dry-run-report-file=${files.report}`,
    `--manifest-file=${files.manifest}`,
    `--recovery-inspection-output-file=${files.recoveryInspection}`,
  ];
}

function sealArgs(files, fixture, inspected) {
  return [
    "--mode=seal",
    `--apply-plan-file=${files.apply}`,
    `--apply-plan-sha256=${fixture.expectedApplyPlanFileSha256}`,
    `--reviewed-dry-run-report-file=${files.report}`,
    `--manifest-file=${files.manifest}`,
    `--recovery-inspection-file=${files.recoveryInspection}`,
    `--recovery-inspection-file-sha256=${inspected.inspection_file_sha256}`,
    "--reviewer-id=operator@example.test",
    "--reviewed-at=2026-08-20T11:35:00.000Z",
    "--expires-at=2026-08-20T13:00:00.000Z",
    `--recovery-plan-output-file=${files.recoveryPlan}`,
  ];
}

function runtimeForFixture(fixture) {
  const readRecoveryEvidence = async () => evidence(fixture);
  return {
    inspectionInterfaces: {
      readRecoveryEvidence,
      withSourceLock: async (request) => request.execute(),
    },
    executionInterfaces: {
      readRecoveryEvidence,
      withSourceLock: async (request) => request.execute(),
      recoverActiveJournal: async () => {
        throw new Error("No-journal recovery must not invoke active commit.");
      },
      finishOriginalAudit: async (request) => {
        const receipt = await finishStage1EvidenceSchemaUpgradeReviewedApplyAudit({
          reviewedApplyPlan: fixture.apply,
          executionNonce: request.execution_nonce,
          finishedAt: request.finished_at,
          terminal: request.terminal,
          completionAuthority: request.completion_authority,
          interfaces: fixture.auditStore,
        });
        fixture.audit = await inspectStage1EvidenceSchemaUpgradeReviewedApplyAuditRecovery({
          reviewedApplyPlan: fixture.apply,
          interfaces: { readRun: fixture.auditStore.readRun },
        });
        return receipt;
      },
    },
  };
}

function forbiddenExecutionInterfaces() {
  return {
    readRecoveryEvidence: async () => { throw new Error("unexpected execution"); },
    withSourceLock: async () => { throw new Error("unexpected execution"); },
    recoverActiveJournal: async () => { throw new Error("unexpected execution"); },
    finishOriginalAudit: async () => { throw new Error("unexpected execution"); },
  };
}

function evidence(fixture) {
  return {
    auditInspection: fixture.audit,
    journals: fixture.journals,
    currentAuthoritySnapshot: fixture.current,
  };
}
