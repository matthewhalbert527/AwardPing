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
      "Keeps the official source set clean with the hardened source-quality gate and suppresses historical noisy change events.",
    profileIds: ["cleanup"],
    taskIds: ["source-quality", "change-event-noise", "prune-history"],
    workerIds: ["source-quality"],
  },
  {
    id: "visual-capture",
    label: "Visual Capture",
    detail:
      "Runs stable capture for already-approved monitorable sources and enqueues review candidates without discovering new sources.",
    profileIds: ["snapshots"],
    taskIds: ["visual-snapshots", "visual-review-batch"],
    workerIds: ["visual-shard-1", "visual-shard-2", "visual-shard-3"],
  },
  {
    id: "source-discovery",
    label: "Source Discovery",
    detail:
      "Separates discovery from daily capture, caps candidates, and quality-gates new source rows before they can become public.",
    profileIds: ["discovery"],
    taskIds: ["source-discovery"],
    workerIds: [],
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
      "Runs stable visual capture, enqueues Gemini Batch visual reviews, refreshes facts, applies source-quality/suppression cleanup, and prunes old snapshots.",
    cost: "Gemini API cap: up to $10/day for batch fact/review work; capture itself does not use synchronous Gemini.",
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
      "Runs the source-quality gate, suppressed/noisy change-event cleanup, public fact aggregation, and snapshot pruning without refreshing screenshots.",
    cost: "$0 direct AI/API cost.",
  },
  snapshots: {
    laneId: "visual-capture",
    label: "Screenshots",
    detail:
      "Refreshes stable visual snapshots for monitor-eligible source pages and enqueues batch review candidates when changes need AI.",
    cost: "$0 direct AI/API cost during capture; visual review is processed by the batch task.",
  },
  discovery: {
    laneId: "source-discovery",
    label: "Source Discovery",
    detail:
      "Runs the explicit discovery workflow with strict source-quality gates and per-award/domain/source caps.",
    cost: "$0 direct AI/API cost unless paired with later baseline-fact extraction.",
  },
  "visual-review": {
    laneId: "visual-capture",
    label: "Visual Review Batch",
    detail:
      "Submits/polls durable Gemini Batch visual-review candidates and publishes only validated applicant-facing changes.",
    cost: "Gemini Batch API only.",
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
      "Finds source-quality gate failures and moves ineligible open sources to review_later.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "maintenance",
      phases: ["source-quality"],
    },
    scheduledWorkerIds: ["source-quality"],
  },
  {
    id: "change-event-noise",
    laneId: "source-quality",
    label: "Change Event Noise Suppression",
    detail:
      "Suppresses historical false/noisy change events while keeping the audit trail in the database.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "maintenance",
      phases: ["change-event-noise"],
    },
    scheduledWorkerIds: ["source-quality"],
  },
  {
    id: "visual-snapshots",
    laneId: "visual-capture",
    label: "Visual Snapshots",
    detail:
      "Captures stable screenshots and visible text for monitor-eligible sources across the visual shards; normal runs do not discover sources.",
    cost: "$0 direct AI/API cost during capture.",
    run: {
      kind: "maintenance",
      phases: ["visual"],
    },
    scheduledWorkerIds: ["visual-shard-1", "visual-shard-2", "visual-shard-3"],
  },
  {
    id: "visual-review-batch",
    laneId: "visual-capture",
    label: "Gemini Visual Review Batch",
    detail:
      "Processes the durable visual-review candidate queue with Gemini Batch and publishes only validated changes.",
    cost: "Gemini Batch API only.",
    run: {
      kind: "maintenance",
      phases: ["visual-review-batch"],
    },
    scheduledWorkerIds: [],
  },
  {
    id: "source-discovery",
    laneId: "source-discovery",
    label: "Source Discovery",
    detail:
      "Runs discovery mode with deterministic identity and source-quality gates before inserting source candidates.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "maintenance",
      phases: ["source-discovery"],
    },
    scheduledWorkerIds: [],
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
      "Captures stable screenshots and visible text for the first shard of monitor-eligible source pages.",
    cost: "$0 direct AI/API cost during capture.",
  },
  {
    id: "visual-shard-2",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 2",
    label: "Visual Snapshot Shard 2",
    detail:
      "Captures stable screenshots and visible text for the second shard of monitor-eligible source pages.",
    cost: "$0 direct AI/API cost during capture.",
  },
  {
    id: "visual-shard-3",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 3",
    label: "Visual Snapshot Shard 3",
    detail:
      "Captures stable screenshots and visible text for the third shard of monitor-eligible source pages.",
    cost: "$0 direct AI/API cost during capture.",
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
