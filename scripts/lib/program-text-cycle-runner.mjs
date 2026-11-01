import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { createCollectionCycleStore } from "./program-text-collection-cycle.mjs";

export function scheduledCollectionCycleStore({ env, args, root, epoch, rosterSeal, scopedSourceCount }) {
  if (!args.apply || args["run-trigger"] !== "scheduled" || !["collect", "report"].includes(args.mode) ||
      env.AWARDPING_COLLECTION_ANCHOR_MINUTE_UTC === undefined) return null;
  if (args["source-id"] || args.cohort || args.mode === "collect" && (args.shardCount !== 3 || args.limit < scopedSourceCount)) {
    throw new Error("Scheduled collection must cover its complete installed shard");
  }
  const anchor = env.AWARDPING_COLLECTION_ANCHOR_MINUTE_UTC;
  if (!/^(?:0|[1-9][0-9]{0,3})$/.test(anchor)) throw new Error("Invalid installed collection anchor");
  return createCollectionCycleStore({ directory: resolve(env.AWARDPING_WORKER_DATA_ROOT || resolve(root, "..", "data"), "collection-cycles"),
    epoch, revision: env.AWARDPING_WORKER_REVISION, rosterSeal, anchorMinuteUtc: Number(anchor), shardCount: 3 });
}

/** Invoke only the installed, existing coverage task. Its scheduled command must
 * acquire a completed cycle before it can produce a report. The daily fallback
 * retains recovery if Task Scheduler cannot accept this immediate request.
 */
export async function requestInstalledCoverageReport({ platform = process.platform, run = execFile } = {}) {
  if (platform !== "win32") return { requested: false, reason: "windows_task_scheduler_unavailable" };
  return new Promise(done => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    'Start-ScheduledTask -TaskName "AwardPing Coverage Report" -ErrorAction Stop'],
  { windowsHide: true, timeout: 15000, maxBuffer: 65536 }, error => done(error
    ? { requested: false, reason: "coverage_task_start_failed" } : { requested: true })));
}
