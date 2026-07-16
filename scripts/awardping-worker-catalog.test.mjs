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
      "verified-feedback-promotions",
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

  it("makes verified feedback promotion a zero-extra-charge hourly stage", () => {
    const promotion = atomicTasks.find(
      (task) => task.id === "verified-feedback-promotions",
    );

    expect(promotion?.scheduledWorkerIds).toEqual(["downstream-queues"]);
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

  it("describes the permanent hourly stages in their executable order", () => {
    const downstream = scheduledWorkers.find(
      (worker) => worker.id === "downstream-queues",
    );
    const detail = downstream?.detail || "";

    expect(detail.indexOf("source intake")).toBeLessThan(
      detail.indexOf("visual review"),
    );
    expect(detail.indexOf("visual review")).toBeLessThan(
      detail.indexOf("verified feedback promotions"),
    );
    expect(detail.indexOf("verified feedback promotions")).toBeLessThan(
      detail.indexOf("general suppression"),
    );
    expect(downstream?.cost).toContain("source-intake");
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
