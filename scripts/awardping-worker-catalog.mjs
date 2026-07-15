export const workerLanes = [
  {
    id: "orchestration",
    label: "Monitoring System",
    detail:
      "Operator-run catch-up plus the permanent 6 PM capture and hourly downstream schedule.",
    profileIds: ["catchup", "daily"],
    taskIds: ["health", "one-time-catchup"],
    workerIds: ["downstream-queues"],
  },
  {
    id: "source-quality",
    label: "Source Quality",
    detail:
      "Operator-run source cleanup tools plus the suppression policy enforced by the hourly downstream pipeline.",
    profileIds: ["cleanup"],
    taskIds: ["source-quality", "change-event-noise", "prune-history"],
    workerIds: [],
  },
  {
    id: "visual-capture",
    label: "Visual Capture",
    detail:
      "Runs stable capture plus cheap expandable-section text extraction for already-approved monitorable sources and enqueues review candidates without discovering new sources.",
    profileIds: ["snapshots"],
    taskIds: ["visual-snapshots", "visual-review-batch"],
    workerIds: ["visual-shard-1", "visual-shard-2", "visual-shard-3"],
  },
  {
    id: "source-discovery",
    label: "Source Intake & Discovery",
    detail:
      "Processes pasted source-intake requests, then runs explicit discovery separately from daily capture with strict quality gates.",
    profileIds: ["source-intake", "discovery"],
    taskIds: ["source-intake", "source-discovery"],
    workerIds: [],
  },
  {
    id: "facts-cycle",
    label: "Facts & Cycle Intelligence",
    detail:
      "Runs Gemini Batch source extraction, award-level fact reconciliation, and page audits used by public award pages.",
    profileIds: ["baseline"],
    taskIds: ["ai-review-completion", "baseline-facts", "reconcile-awards", "page-audit-batch", "aggregate-facts", "award-details"],
    workerIds: [],
  },
  {
    id: "repair-recovery",
    label: "Repair & Recovery",
    detail:
      "Specialized repair lanes for missing visual baselines and localized capture sync problems.",
    profileIds: [],
    taskIds: ["visual-missing", "localization-repair"],
    workerIds: [],
  },
];

export const maintenanceProfiles = {
  catchup: {
    laneId: "orchestration",
    label: "Initial Setup & Repair",
    detail:
      "Completes a temporary backlog and returns the system to its permanent 6 PM capture and hourly downstream schedule.",
    cost: "Gemini API cap: up to $15/day.",
  },
  daily: {
    laneId: "orchestration",
    label: "Daily Monitoring",
    detail:
      "Checks approved pages, compares meaningful content, and publishes only verified changes.",
    cost: "Gemini API cap: up to $15/day for batch fact/review work; capture itself does not use synchronous Gemini.",
  },
  baseline: {
    laneId: "facts-cycle",
    label: "Baseline Facts",
    detail:
      "Runs Gemini Batch source fact extraction, reconciles public award facts, and audits pages when facts or cycle relevance are behind.",
    cost: "Gemini API cap: up to $15/day.",
  },
  cleanup: {
    laneId: "source-quality",
    label: "Source Cleanup",
    detail:
      "Runs the source-quality gate, suppressed/noisy change-event cleanup, award reconciliation, and snapshot pruning without refreshing screenshots.",
    cost: "$0 direct AI/API cost.",
  },
  snapshots: {
    laneId: "visual-capture",
    label: "Screenshots",
    detail:
      "Refreshes stable visual snapshots, extracts expandable section text separately from the main hash, and enqueues batch review candidates when changes need AI.",
    cost: "$0 direct AI/API cost during capture; visual review is processed by the batch task.",
  },
  discovery: {
    laneId: "source-discovery",
    label: "Source Discovery",
    detail:
      "Runs the explicit discovery workflow with strict source-quality gates and per-award/domain/source caps.",
    cost: "$0 direct AI/API cost unless paired with later baseline-fact extraction.",
  },
  "source-intake": {
    laneId: "source-discovery",
    label: "Source Intake",
    detail:
      "Processes pasted official source URLs: capture, deterministic gate, Gemini Batch classification, award match/create, source insertion, and reconciliation queueing.",
    cost: "Gemini Batch API for plausible submitted pages.",
  },
  "visual-review": {
    laneId: "visual-capture",
    label: "Visual Review Batch",
    detail:
      "Submits/polls durable Gemini Batch visual-review candidates, using compact section diffs and changed-section crop evidence when needed, then publishes only validated applicant-facing changes.",
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
    id: "one-time-catchup",
    laneId: "orchestration",
    label: "One-Time Catch-Up",
    detail:
      "Forecasts and drains source review, missing baselines, reconciliation, page and visual review, and current snapshot localization, then exits so only the permanent 6 PM and hourly schedule remains.",
    cost: "Gemini Batch only with gemini-2.5-flash-lite; forecasts live time and cost before applying.",
    run: {
      kind: "script",
      args: ["scripts/run-one-time-catchup.mjs"],
      applyArg: true,
    },
    scheduledWorkerIds: [],
  },
  {
    id: "source-quality",
    laneId: "source-quality",
    label: "Source Quality Cleanup (operator-only)",
    detail:
      "Finds source-quality gate failures and moves ineligible open sources to review_later.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "maintenance",
      phases: ["source-quality"],
    },
    scheduledWorkerIds: [],
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
    scheduledWorkerIds: ["downstream-queues"],
  },
  {
    id: "visual-snapshots",
    laneId: "visual-capture",
    label: "Visual Snapshots",
    detail:
      "Captures stable screenshots, visible text, and separate expandable-section text for monitor-eligible sources across the visual shards; normal runs do not discover sources.",
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
    scheduledWorkerIds: ["downstream-queues"],
  },
  {
    id: "source-intake",
    laneId: "source-discovery",
    label: "Source Intake",
    detail:
      "Processes queued pasted URLs, rejects obvious bad pages, submits plausible pages to Gemini Batch, and hands accepted sources to award reconciliation.",
    cost: "Gemini Batch API for plausible submitted pages.",
    run: {
      kind: "maintenance",
      phases: ["source-intake"],
    },
    scheduledWorkerIds: ["downstream-queues"],
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
      "Backfills missing screenshot/text baselines with baseline-rich expandable-section extraction and no visual interpretation.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "maintenance",
      phases: ["visual-missing"],
    },
    scheduledWorkerIds: [],
  },
  {
    id: "ai-review-completion",
    laneId: "facts-cycle",
    label: "AI Review Completion",
    detail:
      "Closes the open-source review gap with Gemini Batch, moves clear rejects to review_later, and queues affected awards for reconciliation.",
    cost: "Gemini Batch API with the configured daily cap.",
    run: {
      kind: "maintenance",
      phases: ["ai-review-completion"],
    },
    scheduledWorkerIds: [],
  },
  {
    id: "baseline-facts",
    laneId: "facts-cycle",
    label: "Baseline Fact Extraction",
    detail:
      "Runs Gemini Batch page-fact extraction for source pages so cycle relevance and application facts can be computed.",
    cost: "Gemini API cap: up to $15/day.",
    run: {
      kind: "maintenance",
      phases: ["baseline-facts"],
    },
    scheduledWorkerIds: [],
  },
  {
    id: "aggregate-facts",
    laneId: "facts-cycle",
    label: "Legacy Public Fact Aggregation",
    detail:
      "Legacy fallback that rebuilds public award facts from extracted source-page baseline facts. Prefer award reconciliation.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "maintenance",
      phases: ["aggregate-facts"],
    },
    scheduledWorkerIds: [],
  },
  {
    id: "reconcile-awards",
    laneId: "facts-cycle",
    label: "Reconciled Public Facts",
    detail:
      "Selects evidence-backed award-level facts from approved source candidates, rejects sibling-program contamination, and preserves last-known-good pages when audits fail.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "maintenance",
      phases: ["reconcile-awards"],
    },
    scheduledWorkerIds: ["downstream-queues"],
  },
  {
    id: "page-audit-batch",
    laneId: "facts-cycle",
    label: "Gemini Page Audit Batch",
    detail:
      "Submits only deterministic audit warnings/conflicts to Gemini Batch for a second review; Gemini suggestions must cite exact evidence.",
    cost: "Gemini Batch API only for flagged award pages.",
    run: {
      kind: "maintenance",
      phases: ["page-audit-batch"],
    },
    scheduledWorkerIds: ["downstream-queues"],
  },
  {
    id: "award-details",
    laneId: "facts-cycle",
    label: "Award Detail Extraction (disabled)",
    detail:
      "Disabled by policy because it used the local Gemini CLI. Use Gemini Batch reconciliation and page-audit workers instead.",
    cost: "$0 while disabled; Gemini work must use Batch API with gemini-2.5-flash-lite.",
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
      "Operator-only targeted localization repair; changed pages return to normal capture/review instead of being absorbed.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "script",
      args: [
        "scripts/run-localization-repair.mjs",
        "--limit=100000",
        "--web-concurrency=1",
      ],
    },
    scheduledWorkerIds: [],
  },
];

export const scheduledWorkers = [
  {
    id: "downstream-queues",
    laneId: "orchestration",
    taskName: "AwardPing Downstream Queue Pipeline",
    label: "Hourly Queue Pipeline",
    detail:
      "Hourly: finalizes the 6 PM report, processes bounded source intake, handles visual review and suppression, reconciles award facts, and processes flagged page audits.",
    cost: "Gemini Batch API for queued change candidates and flagged page audits; reconciliation has no direct AI cost.",
  },
  {
    id: "visual-shard-1",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 1",
    label: "Visual Snapshot Shard 1",
    detail:
      "Captures stable screenshots, visible text, and separate expandable-section text for the first shard of monitor-eligible source pages.",
    cost: "$0 direct AI/API cost during capture.",
  },
  {
    id: "visual-shard-2",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 2",
    label: "Visual Snapshot Shard 2",
    detail:
      "Captures stable screenshots, visible text, and separate expandable-section text for the second shard of monitor-eligible source pages.",
    cost: "$0 direct AI/API cost during capture.",
  },
  {
    id: "visual-shard-3",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 3",
    label: "Visual Snapshot Shard 3",
    detail:
      "Captures stable screenshots, visible text, and separate expandable-section text for the third shard of monitor-eligible source pages.",
    cost: "$0 direct AI/API cost during capture.",
  },
];

export const workerProcessPatterns = [
  "Run-AwardPing",
  "Run-AwardPingDownstreamQueues",
  "run-awardping-maintenance",
  "capture-visual-snapshots",
  "baseline-facts",
  "backfill-baseline",
  "backfill-open-source-ai-determinations",
  "aggregate-award",
  "source-quality",
  "run-localization-repair",
  "run-overnight-source-quality",
  "process-source-intake-requests",
  "process-visual-review-batch",
  "reconcile-impacted-award-pages",
];
