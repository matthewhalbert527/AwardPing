import { describe, expect, it } from "vitest";
import {
  atomicTasks,
  maintenanceProfiles,
  scheduledWorkers,
  workerLanes,
} from "./awardping-worker-catalog.mjs";

const downstreamLaneWorkers = scheduledWorkers.filter((worker) => worker.laneKey);

describe("AwardPing worker catalog automation", () => {
  it("exposes three downstream schedules and preserves all three daily collectors", () => {
    expect(scheduledWorkers.map((worker) => worker.id)).toEqual([
      "changed-page-review-lane",
      "page-audit-lane",
      "nightly-report-lane",
      "visual-shard-1",
      "visual-shard-2",
      "visual-shard-3",
    ]);

    expect(downstreamLaneWorkers.map((worker) => [worker.laneKey, worker.taskName])).toEqual([
      ["changed_page_review", "AwardPing Changed Page Review Lane"],
      ["page_audit", "AwardPing Page Audit Lane"],
      ["nightly_report", "AwardPing Coverage Report"],
    ]);
  });

  it("maps only current work to schedules and leaves historical tools unscheduled", () => {
    const mappings = {
      "visual-review-batch": "changed-page-review-lane",
      "page-audit-batch": "page-audit-lane",
      "nightly-report": "nightly-report-lane",
    };

    for (const [taskId, workerId] of Object.entries(mappings)) {
      expect(atomicTasks.find((task) => task.id === taskId)?.scheduledWorkerIds).toEqual([
        workerId,
      ]);
    }

    for (const taskId of ["source-intake", "verified-feedback-promotions", "change-event-noise", "reconcile-awards", "manual-quarantine-registry"]) {
      expect(atomicTasks.find((task) => task.id === taskId)?.scheduledWorkerIds).toEqual([]);
    }

    for (const taskId of [
      "one-time-catchup",
      "source-quality",
      "visual-missing",
      "ai-review-completion",
      "baseline-facts",
      "aggregate-facts",
      "award-details",
      "localization-repair",
    ]) {
      expect(atomicTasks.find((task) => task.id === taskId), taskId).toBeUndefined();
    }
  });

  it("keeps changed-page review as the only paid schedule at the existing $5/day cap", () => {
    const paid = scheduledWorkers.filter(
      (worker) => !String(worker.cost).startsWith("$0"),
    );

    expect(paid.map((worker) => worker.id)).toEqual([
      "changed-page-review-lane",
    ]);
    for (const worker of paid) expect(worker.cost).toContain("$5/day hard cap");
    for (const worker of scheduledWorkers.filter((worker) => !paid.includes(worker))) {
      expect(worker.cost).toMatch(/^\$0/);
    }
  });

  it("keeps the permanent page audit deterministic and free of Gemini submission", () => {
    const auditTask = atomicTasks.find((task) => task.id === "page-audit-batch");
    const auditWorker = scheduledWorkers.find((worker) => worker.id === "page-audit-lane");

    expect(auditTask?.run).toEqual({
      kind: "script",
      args: [
        "scripts/evaluate-public-page-audit-canaries.mjs",
        "--all=true",
        "--fail-on-critical=false",
      ],
      applyArg: true,
    });
    expect(auditTask?.cost).toBe("$0 direct AI/API cost.");
    expect(auditTask?.detail).toContain("never submits a page to Gemini");
    expect(auditWorker?.detail).toContain("never submits pages to Gemini");
  });

  it("preserves the historical feedback tool without a recurring promotion job", () => {
    const promotion = atomicTasks.find(
      (task) => task.id === "verified-feedback-promotions",
    );

    expect(promotion?.scheduledWorkerIds).toEqual([]);
    expect(promotion?.run).toMatchObject({
      kind: "script",
      args: [
        "scripts/process-monitoring-feedback-promotions.mjs",
        "--env=.env.worker.local",
        "--apply=true",
      ],
    });
    expect(promotion?.cost).toContain("$0 extra");
  });

  it("preserves the manual quarantine tool without scheduling its mutation", () => {
    const quarantine = atomicTasks.find(
      (task) => task.id === "manual-quarantine-registry",
    );

    expect(quarantine?.run).toMatchObject({
      kind: "script",
      args: [
        "scripts/sync-manual-quarantine-registry.mjs",
        "--apply=true",
      ],
    });
    expect(quarantine?.scheduledWorkerIds).toEqual([]);
  });

  it("makes the combined report use the current full-roster coverage worker", () => {
    const report = atomicTasks.find((task) => task.id === "nightly-report");
    expect(report?.label).toBe("Coverage Report");
    expect(report?.run.args).toEqual([
      "scripts/program-text-worker.mjs", "--env=.env.worker.local", "--mode=report", "--apply=true",
    ]);
    expect(scheduledWorkers.find((worker) => worker.laneKey === "nightly_report")?.cost).toMatch(/^\$0/);
  });

  it("references only real scheduled workers from tasks and lane groups", () => {
    const scheduledIds = new Set(scheduledWorkers.map((worker) => worker.id));
    for (const task of atomicTasks) {
      for (const workerId of task.scheduledWorkerIds || []) {
        expect(scheduledIds.has(workerId), `${task.id} -> ${workerId}`).toBe(true);
      }
    }
    for (const lane of workerLanes) {
      for (const workerId of lane.workerIds || []) {
        expect(scheduledIds.has(workerId), `${lane.id} -> ${workerId}`).toBe(true);
      }
    }
  });

  it("does not expose retired monolithic or repair workflows", () => {
    expect(Object.keys(maintenanceProfiles)).not.toEqual(
      expect.arrayContaining(["catchup", "daily", "baseline", "cleanup"]),
    );
    expect(workerLanes.map((lane) => lane.id)).not.toContain("repair-recovery");
  });
});
