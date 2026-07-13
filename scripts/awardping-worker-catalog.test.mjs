import { describe, expect, it } from "vitest";
import { atomicTasks, scheduledWorkers } from "./awardping-worker-catalog.mjs";

describe("AwardPing worker catalog automation", () => {
  it("wires visual review and award reconciliation to the hourly downstream pipeline", () => {
    const pipeline = scheduledWorkers.find((worker) => worker.id === "downstream-queues");
    const visualReview = atomicTasks.find((task) => task.id === "visual-review-batch");
    const reconciliation = atomicTasks.find((task) => task.id === "reconcile-awards");

    expect(pipeline?.taskName).toBe("AwardPing Downstream Queue Pipeline");
    expect(visualReview?.scheduledWorkerIds).toContain("downstream-queues");
    expect(reconciliation?.scheduledWorkerIds).toContain("downstream-queues");
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
