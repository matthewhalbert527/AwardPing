import { describe, expect, it, vi } from "vitest";
import {
  executeStage1EvidenceSchemaUpgradeReviewedRecovery,
  inspectStage1EvidenceSchemaUpgradeReviewedRecovery,
  sealStage1EvidenceSchemaUpgradeReviewedRecoveryPlan,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-worker.mjs";
import {
  fixtureState,
  sourceId,
} from "./stage1-evidence-schema-upgrade-reviewed-recovery-plan.test.mjs";

describe("reviewed recovery worker split", () => {
  it("generates canonical reviewed plan bytes under a read-only exact-source lock", async () => {
    const fixture = await fixtureState();
    const readRecoveryEvidence = vi.fn(async (request) => {
      expect(request).toMatchObject({
        source_id: sourceId,
        read_only: true,
        creates_api_charge: false,
      });
      return {
        auditInspection: fixture.audit,
        journals: fixture.journals,
        currentAuthoritySnapshot: fixture.current,
      };
    });
    const withSourceLock = vi.fn(async (request) => {
      expect(request).toMatchObject({
        source_id: sourceId,
        read_only: true,
        creates_api_charge: false,
      });
      return request.execute();
    });
    const inspected = await inspectStage1EvidenceSchemaUpgradeReviewedRecovery({
      ...historical(fixture),
      interfaces: { readRecoveryEvidence, withSourceLock },
      now: "2026-08-20T11:30:00.000Z",
    });
    expect(Buffer.isBuffer(inspected.inspection_bytes)).toBe(true);
    expect(inspected.inspection.proposed_plan.expected_disposition)
      .toBe("finish_failed_audit_started_before_journal");
    expect(inspected.inspection.proposed_plan.current_authority.mutation_performed)
      .toBe(false);
    const result = sealStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
      inspectionBytes: inspected.inspection_bytes,
      expectedInspectionFileSha256: inspected.inspection_file_sha256,
      ...historical(fixture),
      reviewer: {
        reviewer_id: "operator@example.test",
        reviewed_at: "2026-08-20T11:35:00.000Z",
        expires_at: "2026-08-20T13:00:00.000Z",
      },
      now: "2026-08-20T11:36:00.000Z",
    });
    expect(result.plan.inspection).toMatchObject({
      inspection_file_sha256: inspected.inspection_file_sha256,
      inspection_sha256: inspected.inspection.inspection_sha256,
      proposed_plan_sha256: inspected.inspection.proposed_plan.draft_sha256,
    });
    expect(readRecoveryEvidence).toHaveBeenCalledOnce();
    expect(withSourceLock).toHaveBeenCalledOnce();
  });

  it("rejects mutation or capture authority in read-only inspection", async () => {
    const fixture = await fixtureState();
    await expect(inspectStage1EvidenceSchemaUpgradeReviewedRecovery({
      ...historical(fixture),
      interfaces: {
        readRecoveryEvidence: vi.fn(),
        withSourceLock: vi.fn(),
        captureDryRun: vi.fn(),
      },
      now: "2026-08-20T11:30:00.000Z",
    })).rejects.toThrow(/unexpected|missing fields/i);
  });

  it("discards plan bytes when lock completion is not acknowledged", async () => {
    const fixture = await fixtureState();
    await expect(inspectStage1EvidenceSchemaUpgradeReviewedRecovery({
      ...historical(fixture),
      interfaces: {
        readRecoveryEvidence: async () => ({
          auditInspection: fixture.audit,
          journals: fixture.journals,
          currentAuthoritySnapshot: fixture.current,
        }),
        withSourceLock: async (request) => {
          await request.execute();
          throw new Error("lock response lost");
        },
      },
      now: "2026-08-20T11:30:00.000Z",
    })).rejects.toMatchObject({
      code: "reviewed_recovery_inspection_lock_response_lost",
    });
  });

  it("requires the separately reviewed visible self SHA before execution", async () => {
    const fixture = await fixtureState();
    const inspected = await inspectStage1EvidenceSchemaUpgradeReviewedRecovery({
      ...historical(fixture),
      interfaces: {
        readRecoveryEvidence: async () => ({
          auditInspection: fixture.audit,
          journals: fixture.journals,
          currentAuthoritySnapshot: fixture.current,
        }),
        withSourceLock: async (request) => request.execute(),
      },
      now: "2026-08-20T11:30:00.000Z",
    });
    const plan = sealStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
      inspectionBytes: inspected.inspection_bytes,
      expectedInspectionFileSha256: inspected.inspection_file_sha256,
      ...historical(fixture),
      reviewer: {
        reviewer_id: "operator@example.test",
        reviewed_at: "2026-08-20T11:35:00.000Z",
        expires_at: "2026-08-20T13:00:00.000Z",
      },
      now: "2026-08-20T11:36:00.000Z",
    });
    await expect(executeStage1EvidenceSchemaUpgradeReviewedRecovery({
      recoveryPlanBytes: plan.plan_bytes,
      expectedRecoveryPlanFileSha256: plan.plan_file_sha256,
      expectedRecoveryPlanSha256: "0".repeat(64),
      inspectionBytes: inspected.inspection_bytes,
      expectedInspectionFileSha256: inspected.inspection_file_sha256,
      ...historical(fixture),
      interfaces: {},
      now: "2026-08-20T11:30:00.000Z",
    })).rejects.toThrow(/self SHA-256 differs/i);
  });

  it("separates an advancing evidence clock from later reviewer sealing", async () => {
    const fixture = await fixtureState();
    const inspected = await inspectStage1EvidenceSchemaUpgradeReviewedRecovery({
      ...historical(fixture),
      interfaces: {
        readRecoveryEvidence: async () => ({
          auditInspection: fixture.audit,
          journals: fixture.journals,
          currentAuthoritySnapshot: fixture.current,
        }),
        withSourceLock: async (request) => request.execute(),
      },
      now: () => "2026-08-20T11:07:13.321Z",
    });
    expect(inspected.inspection.evidence_observed_at)
      .toBe("2026-08-20T11:07:13.321Z");
    const sealed = sealStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
      inspectionBytes: inspected.inspection_bytes,
      expectedInspectionFileSha256: inspected.inspection_file_sha256,
      ...historical(fixture),
      reviewer: {
        reviewer_id: "operator@example.test",
        reviewed_at: "2026-08-20T11:12:00.000Z",
        expires_at: "2026-08-20T13:00:00.000Z",
      },
      now: () => "2026-08-20T11:13:00.000Z",
    });
    expect(sealed.plan.reviewer.reviewed_at).toBe("2026-08-20T11:12:00.000Z");
  });

  it("discards inspection evidence when the clock rolls back during its read", async () => {
    const fixture = await fixtureState();
    const times = [
      "2026-08-20T11:30:00.000Z",
      "2026-08-20T11:29:00.000Z",
    ];
    const readRecoveryEvidence = vi.fn(async () => ({
      auditInspection: fixture.audit,
      journals: fixture.journals,
      currentAuthoritySnapshot: fixture.current,
    }));
    await expect(inspectStage1EvidenceSchemaUpgradeReviewedRecovery({
      ...historical(fixture),
      interfaces: {
        readRecoveryEvidence,
        withSourceLock: async (request) => request.execute(),
      },
      now: () => times.shift() || "2026-08-20T11:29:00.000Z",
    })).rejects.toMatchObject({
      code: "reviewed_recovery_inspection_lock_response_lost",
      cause: expect.objectContaining({ message: expect.stringMatching(/clock moved backward/i) }),
    });
    expect(readRecoveryEvidence).toHaveBeenCalledOnce();
  });
});

function historical(fixture) {
  return {
    applyPlanBytes: fixture.applyPlanBytes,
    expectedApplyPlanFileSha256: fixture.expectedApplyPlanFileSha256,
    reviewedDryRunReportBytes: fixture.reviewedDryRunReportBytes,
    manifest: fixture.manifest,
  };
}
