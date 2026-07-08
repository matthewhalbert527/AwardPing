export const workerLanes = [
  {
    id: "orchestration",
    label: "Full Maintenance",
    detail:
      "Coordinated multi-step runs for catching the site up or doing the normal daily pass.",
    profileIds: ["catchup", "daily"],
    taskIds: ["health"],
    workerIds: [],
  },
  {
    id: "source-quality",
    label: "Source Quality",
    detail:
      "Keeps the official source set clean by removing low-quality, duplicate, stale, or noisy pages.",
    profileIds: ["cleanup"],
    taskIds: ["source-quality", "prune-history"],
    workerIds: ["source-quality"],
  },
  {
    id: "visual-capture",
    label: "Visual Capture",
    detail:
      "Captures screenshots and visible text for official source pages so page changes can be detected.",
    profileIds: ["snapshots"],
    taskIds: ["visual-snapshots"],
    workerIds: ["visual-shard-1", "visual-shard-2", "visual-shard-3"],
  },
  {
    id: "facts-cycle",
    label: "Facts & Cycle Intelligence",
    detail:
      "Runs Gemini Batch extraction and rebuilds the public program facts used by award pages.",
    profileIds: ["baseline"],
    taskIds: ["baseline-facts", "aggregate-facts", "award-details"],
    workerIds: ["baseline-facts"],
  },
  {
    id: "repair-recovery",
    label: "Repair & Recovery",
    detail:
      "Specialized repair lanes for missing visual baselines and localized capture sync problems.",
    profileIds: [],
    taskIds: ["visual-missing", "localization-repair"],
    workerIds: ["baseline-completion", "localization-repair"],
  },
];

export const maintenanceProfiles = {
  catchup: {
    laneId: "orchestration",
    label: "Catch Up Site",
    detail:
      "Runs source cleanup, missing screenshots, Gemini Batch facts, public fact aggregation, and snapshot retention after downtime or a large backlog.",
    cost: "Gemini API cap: up to $10/day.",
  },
  daily: {
    laneId: "orchestration",
    label: "Daily Maintenance",
    detail:
      "Runs the normal daily pass for screenshots, page facts, public facts, cleanup, and pruning.",
    cost: "Gemini API cap: up to $10/day, plus variable Gemini CLI review use for visual changes.",
  },
  baseline: {
    laneId: "facts-cycle",
    label: "Baseline Facts",
    detail:
      "Runs Gemini Batch fact extraction and rebuilds public program facts when facts or cycle relevance are behind.",
    cost: "Gemini API cap: up to $10/day.",
  },
  cleanup: {
    laneId: "source-quality",
    label: "Source Cleanup",
    detail:
      "Runs source hygiene, public fact aggregation, and snapshot pruning without refreshing screenshots.",
    cost: "$0 direct AI/API cost.",
  },
  snapshots: {
    laneId: "visual-capture",
    label: "Screenshots",
    detail:
      "Refreshes visual snapshots across open active source pages when screenshot coverage is behind.",
    cost: "Variable Gemini CLI review use if page changes need AI review; no dollar cap is enforced here.",
  },
};

export const atomicTasks = [
  {
    id: "health",
    laneId: "orchestration",
    label: "Health Check",
    detail:
      "Checks Supabase and required local worker configuration before heavier tasks run.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "maintenance",
      phases: ["health"],
    },
    scheduledWorkerIds: [],
  },
  {
    id: "source-quality",
    laneId: "source-quality",
    label: "Source Quality Cleanup",
    detail:
      "Finds low-quality, duplicate, noisy, stale, or misleading source pages and applies safe cleanup.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "maintenance",
      phases: ["source-quality"],
    },
    scheduledWorkerIds: ["source-quality"],
  },
  {
    id: "visual-snapshots",
    laneId: "visual-capture",
    label: "Visual Snapshots",
    detail:
      "Captures current screenshots and visible text for active web source pages across the visual shards.",
    cost: "Variable Gemini CLI review use if page changes need AI review; no dollar cap is enforced here.",
    run: {
      kind: "maintenance",
      phases: ["visual"],
    },
    scheduledWorkerIds: ["visual-shard-1", "visual-shard-2", "visual-shard-3"],
  },
  {
    id: "visual-missing",
    laneId: "repair-recovery",
    label: "Complete Missing Visual Baselines",
    detail:
      "Backfills missing screenshot/text baselines without interpreting visual changes.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "maintenance",
      phases: ["visual-missing"],
    },
    scheduledWorkerIds: ["baseline-completion"],
  },
  {
    id: "baseline-facts",
    laneId: "facts-cycle",
    label: "Baseline Fact Extraction",
    detail:
      "Runs Gemini Batch page-fact extraction for source pages so cycle relevance and application facts can be computed.",
    cost: "Gemini API cap: up to $10/day.",
    run: {
      kind: "maintenance",
      phases: ["baseline-facts"],
    },
    scheduledWorkerIds: ["baseline-facts"],
  },
  {
    id: "aggregate-facts",
    laneId: "facts-cycle",
    label: "Public Fact Aggregation",
    detail:
      "Rebuilds public award facts from extracted source-page baseline facts.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "maintenance",
      phases: ["aggregate-facts"],
    },
    scheduledWorkerIds: [],
  },
  {
    id: "award-details",
    laneId: "facts-cycle",
    label: "Award Detail Extraction",
    detail:
      "Uses the local Gemini CLI workflow to extract richer award-level details from source baselines.",
    cost: "Variable Gemini CLI usage; no dollar cap is enforced here.",
    run: {
      kind: "script",
      args: [
        "scripts/backfill-award-baseline-details.mjs",
        "--skip-existing=true",
      ],
      applyArg: true,
    },
    scheduledWorkerIds: [],
  },
  {
    id: "prune-history",
    laneId: "source-quality",
    label: "Snapshot History Prune",
    detail:
      "Removes older snapshot history while preserving recent baselines and change-event evidence.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "maintenance",
      phases: ["prune-history"],
    },
    scheduledWorkerIds: [],
  },
  {
    id: "localization-repair",
    laneId: "repair-recovery",
    label: "Localization Repair",
    detail:
      "Re-syncs localized web captures only when the current page still matches the existing baseline.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "script",
      args: [
        "scripts/run-localization-repair.mjs",
        "--limit=100000",
        "--web-concurrency=1",
      ],
    },
    scheduledWorkerIds: ["localization-repair"],
  },
];

export const scheduledWorkers = [
  {
    id: "baseline-completion",
    laneId: "repair-recovery",
    taskName: "AwardPing Baseline Completion Watchdog",
    label: "Baseline Completion Watchdog",
    detail:
      "Completes missing screenshot/text baselines until visual coverage is caught up.",
    cost: "$0 direct AI/API cost.",
  },
  {
    id: "baseline-facts",
    laneId: "facts-cycle",
    taskName: "AwardPing Baseline Facts Watchdog",
    label: "Baseline Facts Watchdog",
    detail:
      "Keeps Gemini Batch page-fact extraction moving until source-page facts are caught up.",
    cost: "Gemini API cap: up to $10/day.",
  },
  {
    id: "localization-repair",
    laneId: "repair-recovery",
    taskName: "AwardPing Localization Repair Watchdog",
    label: "Localization Repair Watchdog",
    detail:
      "Re-syncs localized web captures when the page still matches the known baseline; skips changed pages, PDFs, and missing baselines.",
    cost: "$0 direct AI/API cost.",
  },
  {
    id: "source-quality",
    laneId: "source-quality",
    taskName: "AwardPing Overnight Source Quality Pass",
    label: "Overnight Source Quality",
    detail:
      "Runs the longer source hygiene pass that cleans low-quality, duplicate, or noisy source pages.",
    cost: "$0 direct AI/API cost.",
  },
  {
    id: "visual-shard-1",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 1",
    label: "Visual Snapshot Shard 1",
    detail:
      "Captures screenshots and visible text for the first shard of official source pages.",
    cost: "Variable Gemini CLI review use if page changes need AI review; no dollar cap is enforced here.",
  },
  {
    id: "visual-shard-2",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 2",
    label: "Visual Snapshot Shard 2",
    detail:
      "Captures screenshots and visible text for the second shard of official source pages.",
    cost: "Variable Gemini CLI review use if page changes need AI review; no dollar cap is enforced here.",
  },
  {
    id: "visual-shard-3",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 3",
    label: "Visual Snapshot Shard 3",
    detail:
      "Captures screenshots and visible text for the third shard of official source pages.",
    cost: "Variable Gemini CLI review use if page changes need AI review; no dollar cap is enforced here.",
  },
];

export const workerProcessPatterns = [
  "Run-AwardPing",
  "run-awardping-maintenance",
  "capture-visual-snapshots",
  "baseline-facts",
  "backfill-baseline",
  "aggregate-award",
  "source-quality",
  "run-localization-repair",
  "run-overnight-source-quality",
];
