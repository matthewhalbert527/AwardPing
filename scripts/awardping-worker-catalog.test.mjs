import { describe, expect, it } from "vitest";
import { atomicTasks, scheduledWorkers } from "./awardping-worker-catalog.mjs";

describe("AwardPing worker catalog automation", () => {
  it("exposes exactly the four permanent Windows tasks", () => {
    expect(scheduledWorkers.map((worker) => worker.id)).toEqual([
      "downstream-queues",
      "visual-shard-1",
      "visual-shard-2",
      "visual-shard-3",
    ]);
  });

  it("wires visual review and award reconciliation to the hourly downstream pipeline", () => {
    const pipeline = scheduledWorkers.find((worker) => worker.id === "downstream-queues");
    const visualReview = atomicTasks.find((task) => task.id === "visual-review-batch");
    const reconciliation = atomicTasks.find((task) => task.id === "reconcile-awards");

    expect(pipeline?.taskName).toBe("AwardPing Downstream Queue Pipeline");
    expect(visualReview?.scheduledWorkerIds).toContain("downstream-queues");
    expect(reconciliation?.scheduledWorkerIds).toContain("downstream-queues");
  });

  it("maps every permanent hourly stage to the downstream task and keeps catch-up work operator-only", () => {
    for (const taskId of [
      "source-intake",
      "visual-review-batch",
      "change-event-noise",
      "reconcile-awards",
      "page-audit-batch",
    ]) {
      expect(atomicTasks.find((task) => task.id === taskId)?.scheduledWorkerIds).toContain(
        "downstream-queues",
      );
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

  it("references only real scheduled workers from atomic tasks", () => {
    const scheduledIds = new Set(scheduledWorkers.map((worker) => worker.id));
    for (const task of atomicTasks) {
      for (const workerId of task.scheduledWorkerIds || []) {
        expect(scheduledIds.has(workerId), `${task.id} -> ${workerId}`).toBe(true);
      }
    }
  });

  it("does not mislabel the health check as a downstream queue task", () => {
    const health = atomicTasks.find((task) => task.id === "health");

    expect(health?.scheduledWorkerIds).not.toContain("downstream-queues");
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
