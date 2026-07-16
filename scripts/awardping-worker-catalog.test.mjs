import { describe, expect, it } from "vitest";
import {
  atomicTasks,
  scheduledWorkers,
  workerLanes,
} from "./awardping-worker-catalog.mjs";

const downstreamLaneWorkers = scheduledWorkers.filter((worker) => worker.laneKey);

describe("AwardPing worker catalog automation", () => {
  it("exposes eight independent downstream lanes and preserves the three 6 PM shards", () => {
    expect(scheduledWorkers.map((worker) => worker.id)).toEqual([
      "new-page-review-lane",
      "changed-page-review-lane",
      "feedback-promotion-lane",
      "suppression-lane",
      "reconciliation-lane",
      "page-audit-lane",
      "manual-quarantine-lane",
      "nightly-report-lane",
      "visual-shard-1",
      "visual-shard-2",
      "visual-shard-3",
    ]);

    expect(downstreamLaneWorkers.map((worker) => [worker.laneKey, worker.taskName])).toEqual([
      ["new_page_review", "AwardPing New Page Review Lane"],
      ["changed_page_review", "AwardPing Changed Page Review Lane"],
      ["feedback_promotion", "AwardPing Feedback Promotion Lane"],
      ["suppression", "AwardPing Suppression Lane"],
      ["reconciliation", "AwardPing Reconciliation Lane"],
      ["page_audit", "AwardPing Page Audit Lane"],
      ["manual_quarantine", "AwardPing Manual Quarantine Lane"],
      ["nightly_report", "AwardPing Nightly Report Lane"],
    ]);
  });

  it("maps every permanent stage to only its own scheduled lane", () => {
    const mappings = {
      "source-intake": "new-page-review-lane",
      "visual-review-batch": "changed-page-review-lane",
      "verified-feedback-promotions": "feedback-promotion-lane",
      "change-event-noise": "suppression-lane",
      "reconcile-awards": "reconciliation-lane",
      "page-audit-batch": "page-audit-lane",
      "manual-quarantine-registry": "manual-quarantine-lane",
      "nightly-report": "nightly-report-lane",
    };

    for (const [taskId, workerId] of Object.entries(mappings)) {
      expect(atomicTasks.find((task) => task.id === taskId)?.scheduledWorkerIds).toEqual([
        workerId,
      ]);
    }

    for (const taskId of [
      "source-quality",
      "visual-missing",
      "baseline-facts",
      "localization-repair",
    ]) {
      expect(atomicTasks.find((task) => task.id === taskId)?.scheduledWorkerIds).toEqual([]);
    }
  });

  it("has exactly two paid permanent lanes, each fixed at $5/day", () => {
    const paid = scheduledWorkers.filter(
      (worker) => !String(worker.cost).startsWith("$0"),
    );

    expect(paid.map((worker) => worker.id)).toEqual([
      "new-page-review-lane",
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

  it("makes verified feedback promotion a zero-charge independent stage", () => {
    const promotion = atomicTasks.find(
      (task) => task.id === "verified-feedback-promotions",
    );

    expect(promotion?.scheduledWorkerIds).toEqual(["feedback-promotion-lane"]);
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

  it("exposes the one-time catch-up as an operator-run batch-only task", () => {
    const catchup = atomicTasks.find((task) => task.id === "one-time-catchup");

    expect(catchup?.run).toMatchObject({
      kind: "script",
      args: ["scripts/run-one-time-catchup.mjs"],
      applyArg: true,
    });
    expect(catchup?.scheduledWorkerIds).toEqual([]);
    expect(catchup?.cost).toContain("gemini-2.5-flash-lite");
  });
});
