import { describe, expect, it } from "vitest";
import { scheduledCollectionCycleStore, requestInstalledCoverageReport } from "./program-text-cycle-runner.mjs";
const scope = { env: { AWARDPING_WORKER_REVISION: "a".repeat(40), AWARDPING_COLLECTION_ANCHOR_MINUTE_UTC: "1380" },
  args: { apply: true, mode: "collect", "run-trigger": "scheduled", shardCount: 3, limit: 100 },
  root: "fixture", epoch: "ec349339-ff62-4d2e-a610-8c361b4044ec", rosterSeal: "b".repeat(64), scopedSourceCount: 100 };
describe("installed collection completion integration", () => {
  it("enables cycle evidence only for configured complete scheduled collection/report", () => {
    expect(scheduledCollectionCycleStore(scope)).toHaveProperty("begin");
    for (const args of [{ ...scope.args, apply: false }, { ...scope.args, "run-trigger": "manual" }, { ...scope.args, mode: "review" }]) {
      expect(scheduledCollectionCycleStore({ ...scope, args })).toBe(null);
    }
    expect(scheduledCollectionCycleStore({ ...scope, env: {} })).toBe(null);
  });
  it.each([{ "source-id": "one" }, { cohort: "one" }, { shardCount: 1 }, { limit: 99 }])("rejects a partial scheduled collection %j", patch => {
    expect(() => scheduledCollectionCycleStore({ ...scope, args: { ...scope.args, ...patch } })).toThrow("complete installed shard");
  });
  it.each(["1380x", "-1", "1440", "", "1.5"])("rejects malformed installed clock %j", anchor => {
    expect(() => scheduledCollectionCycleStore({ ...scope, env: { ...scope.env, AWARDPING_COLLECTION_ANCHOR_MINUTE_UTC: anchor } })).toThrow();
  });
  it("requests only the fixed existing Windows task with a hidden, bounded process", async () => {
    let observed;
    expect(await requestInstalledCoverageReport({ platform: "win32", run: (...args) => { observed = args; args.at(-1)(null); } })).toEqual({ requested: true });
    expect(observed[0]).toBe("powershell.exe");
    expect(observed[1].at(-1)).toBe('Start-ScheduledTask -TaskName "AwardPing Coverage Report" -ErrorAction Stop');
    expect(observed[2]).toMatchObject({ windowsHide: true, timeout: 15000 });
    expect(await requestInstalledCoverageReport({ platform: "win32", run: (...args) => args.at(-1)(new Error("unavailable")) })).toEqual({ requested: false, reason: "coverage_task_start_failed" });
    expect(await requestInstalledCoverageReport({ platform: "linux", run: () => { throw Error("forbidden"); } })).toEqual({ requested: false, reason: "windows_task_scheduler_unavailable" });
  });
});
