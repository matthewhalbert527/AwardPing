export const workerLanes = [
  {
    id: "orchestration",
    label: "Monitoring System",
    detail:
      "Operator-run catch-up plus independent permanent lanes for promotion, quarantine accounting, and the nightly report.",
    profileIds: ["catchup", "daily"],
    taskIds: [
      "health",
      "verified-feedback-promotions",
      "manual-quarantine-registry",
      "nightly-report",
      "one-time-catchup",
    ],
    workerIds: [
      "feedback-promotion-lane",
      "manual-quarantine-lane",
      "nightly-report-lane",
    ],
  },
  {
    id: "source-quality",
    label: "Source Quality",
    detail:
      "Operator-run source cleanup tools plus an independent recurring suppression-policy lane.",
    profileIds: ["cleanup"],
    taskIds: ["source-quality", "change-event-noise", "prune-history"],
    workerIds: ["suppression-lane"],
  },
  {
    id: "visual-capture",
    label: "Visual Capture",
    detail:
      "Runs stable capture plus expandable-section extraction for approved sources, and the 6 PM shards safely seed then discover newly linked official PDFs.",
    profileIds: ["snapshots"],
    taskIds: ["visual-snapshots", "visual-review-batch"],
    workerIds: [
      "changed-page-review-lane",
      "visual-shard-1",
      "visual-shard-2",
      "visual-shard-3",
    ],
  },
  {
    id: "source-discovery",
    label: "Source Intake & Discovery",
    detail:
      "Reviews pasted and 6 PM-discovered source requests; operator bulk discovery remains a separate baseline-only onboarding tool.",
    profileIds: ["source-intake", "discovery"],
    taskIds: ["source-intake", "source-discovery"],
    workerIds: ["new-page-review-lane"],
  },
  {
    id: "facts-cycle",
    label: "Facts & Cycle Intelligence",
    detail:
      "Runs operator-only fact extraction plus independent reconciliation and deterministic public-page audit lanes.",
    profileIds: ["baseline"],
    taskIds: ["ai-review-completion", "baseline-facts", "reconcile-awards", "page-audit-batch", "aggregate-facts", "award-details"],
    workerIds: ["reconciliation-lane", "page-audit-lane"],
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
      "Completes a temporary backlog and returns the system to its three 6 PM shards and eight independent downstream lanes.",
    cost: "Operator-only catch-up; permanent paid work remains limited to the two database-capped $5/day review lanes.",
  },
  daily: {
    laneId: "orchestration",
    label: "Daily Monitoring",
    detail:
      "Checks approved pages, compares meaningful content, and publishes only verified changes.",
    cost: "New-page and changed-page review are each hard-capped at $5/day; every other permanent lane is $0 direct AI/API cost.",
  },
  baseline: {
    laneId: "facts-cycle",
    label: "Baseline Facts",
    detail:
      "Runs Gemini Batch source fact extraction, reconciles public award facts, and audits pages when facts or cycle relevance are behind.",
    cost: "Operator-only Gemini Batch work; no permanent baseline lane is installed.",
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
    cost: "Gemini Batch API for plausible submitted pages, hard-capped at $5/day.",
  },
  "visual-review": {
    laneId: "visual-capture",
    label: "Visual Review Batch",
    detail:
      "Submits/polls durable Gemini Batch visual-review candidates, using compact section diffs and changed-section crop evidence when needed, then publishes only validated applicant-facing changes.",
    cost: "Gemini Batch API only, hard-capped at $5/day.",
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
      "Forecasts and drains source review, missing baselines, reconciliation, page and visual review, and current snapshot localization, then exits so only the permanent 6 PM shards and independent lanes remain.",
    cost: "Gemini Batch only with gemini-2.5-flash-lite; forecasts live time and cost before applying.",
    run: {
      kind: "script",
      args: ["scripts/run-one-time-catchup.mjs"],
      applyArg: true,
    },
    scheduledWorkerIds: [],
  },
  {
    id: "verified-feedback-promotions",
    laneId: "orchestration",
    label: "Verified Feedback Promotions",
    detail:
      "Advances clustered false-update feedback through complete shadow history, retained regression fixtures, exact app/worker/matcher identity, the regular three-shard 6 PM canary, and a bounded resumable retroactive sweep.",
    cost: "$0 extra direct AI/API cost; it observes the regular 6 PM cohort and never launches a paid canary.",
    run: {
      kind: "script",
      args: [
        "scripts/process-monitoring-feedback-promotions.mjs",
        "--env=.env.worker.local",
        "--apply=true",
      ],
    },
    scheduledWorkerIds: ["feedback-promotion-lane"],
  },
  {
    id: "manual-quarantine-registry",
    laneId: "orchestration",
    label: "Manual Quarantine Registry",
    detail:
      "Refreshes durable operator cases and reports automated work, quarantine, historical limitations, and terminal failures separately.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "script",
      args: ["scripts/sync-manual-quarantine-registry.mjs"],
    },
    scheduledWorkerIds: ["manual-quarantine-lane"],
  },
  {
    id: "nightly-report",
    laneId: "orchestration",
    label: "6 PM Capture Report",
    detail:
      "Finalizes the due three-shard capture report independently of all review and repair queues.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "script",
      args: ["scripts/report-visual-nightly.mjs", "--write=true"],
    },
    scheduledWorkerIds: ["nightly-report-lane"],
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
    scheduledWorkerIds: ["suppression-lane"],
  },
  {
    id: "visual-snapshots",
    laneId: "visual-capture",
    label: "Visual Snapshots",
    detail:
      "Captures stable screenshots and expandable-section text across the 6 PM shards, seeds existing PDF links baseline-only, and queues later newly linked PDFs for review.",
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
    cost: "Gemini Batch API only, hard-capped at $5/day.",
    run: {
      kind: "maintenance",
      phases: ["visual-review-batch"],
    },
    scheduledWorkerIds: ["changed-page-review-lane"],
  },
  {
    id: "source-intake",
    laneId: "source-discovery",
    label: "Source Intake",
    detail:
      "Processes queued pasted URLs, rejects obvious bad pages, submits plausible pages to Gemini Batch, and hands accepted sources to award reconciliation.",
    cost: "Gemini Batch API for plausible submitted pages, hard-capped at $5/day.",
    run: {
      kind: "maintenance",
      phases: ["source-intake"],
    },
    scheduledWorkerIds: ["new-page-review-lane"],
  },
  {
    id: "source-discovery",
    laneId: "source-discovery",
    label: "Source Discovery",
    detail:
      "Runs operator discovery with deterministic gates; it defaults to historical onboarding so bulk results cannot become public first-observation alerts.",
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
    cost: "Operator-only Gemini Batch work; no permanent baseline lane is installed.",
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
    scheduledWorkerIds: ["reconciliation-lane"],
  },
  {
    id: "page-audit-batch",
    laneId: "facts-cycle",
    label: "Deterministic Page Audit",
    detail:
      "Evaluates public pages with deterministic reconciliation canaries and routes failures for action; it never submits a page to Gemini.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "script",
      args: [
        "scripts/evaluate-public-page-audit-canaries.mjs",
        "--all=true",
        "--fail-on-critical=false",
      ],
      applyArg: true,
    },
    scheduledWorkerIds: ["page-audit-lane"],
  },
  {
    id: "award-details",
    laneId: "facts-cycle",
    label: "Award Detail Extraction (disabled)",
    detail:
      "Disabled by policy because it used the local Gemini CLI. New-page review handles source information; changed-page review handles changed wording; reconciliation and page audit stay deterministic.",
    cost: "$0 while disabled; only the two review lanes may create paid Gemini Batch work.",
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
    id: "new-page-review-lane",
    laneKey: "new_page_review",
    laneId: "source-discovery",
    taskName: "AwardPing New Page Review Lane",
    label: "New Page Review",
    detail:
      "Every 15 minutes: reviews submitted pages and newly linked PDFs queued by the 6 PM scan, independently from changed-page review.",
    cost: "Gemini Batch API with a $5/day hard cap.",
  },
  {
    id: "changed-page-review-lane",
    laneKey: "changed_page_review",
    laneId: "visual-capture",
    taskName: "AwardPing Changed Page Review Lane",
    label: "Changed Page Review",
    detail:
      "Every 15 minutes: processes queued visual-change candidates independently from new-page intake and all zero-cost lanes.",
    cost: "Gemini Batch API with a $5/day hard cap.",
  },
  {
    id: "feedback-promotion-lane",
    laneKey: "feedback_promotion",
    laneId: "orchestration",
    taskName: "AwardPing Feedback Promotion Lane",
    label: "Feedback Promotion",
    detail:
      "Every 15 minutes: advances verified promotion, canary, sweep, and rollback state under its own lease and timeout.",
    cost: "$0 direct AI/API cost.",
  },
  {
    id: "suppression-lane",
    laneKey: "suppression",
    laneId: "source-quality",
    taskName: "AwardPing Suppression Lane",
    label: "Suppression",
    detail:
      "Every 15 minutes: applies current suppression policy and bounded retroactive sweep work independently.",
    cost: "$0 direct AI/API cost.",
  },
  {
    id: "reconciliation-lane",
    laneKey: "reconciliation",
    laneId: "facts-cycle",
    taskName: "AwardPing Reconciliation Lane",
    label: "Award Reconciliation",
    detail:
      "Every 15 minutes: reconciles pending public award facts without waiting for a review lane to finish.",
    cost: "$0 direct AI/API cost.",
  },
  {
    id: "page-audit-lane",
    laneKey: "page_audit",
    laneId: "facts-cycle",
    taskName: "AwardPing Page Audit Lane",
    label: "Deterministic Page Audit",
    detail:
      "Every 15 minutes: runs deterministic public-page checks and never submits pages to Gemini.",
    cost: "$0 direct AI/API cost.",
  },
  {
    id: "manual-quarantine-lane",
    laneKey: "manual_quarantine",
    laneId: "orchestration",
    taskName: "AwardPing Manual Quarantine Lane",
    label: "Manual Quarantine",
    detail:
      "Every 15 minutes: refreshes the durable operator registry independently from producers and reviewers.",
    cost: "$0 direct AI/API cost.",
  },
  {
    id: "nightly-report-lane",
    laneKey: "nightly_report",
    laneId: "orchestration",
    taskName: "AwardPing Nightly Report Lane",
    label: "6 PM Capture Report",
    detail:
      "Every 15 minutes: safely finalizes the due three-shard report when its reporting window is ready.",
    cost: "$0 direct AI/API cost.",
  },
  {
    id: "visual-shard-1",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 1",
    label: "Visual Snapshot Shard 1",
    detail:
      "Captures the first source shard and safely records newly linked official PDFs for the new-page review lane.",
    cost: "$0 direct AI/API cost during capture.",
  },
  {
    id: "visual-shard-2",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 2",
    label: "Visual Snapshot Shard 2",
    detail:
      "Captures the second source shard and safely records newly linked official PDFs for the new-page review lane.",
    cost: "$0 direct AI/API cost during capture.",
  },
  {
    id: "visual-shard-3",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 3",
    label: "Visual Snapshot Shard 3",
    detail:
      "Captures the third source shard and safely records newly linked official PDFs for the new-page review lane.",
    cost: "$0 direct AI/API cost during capture.",
  },
];

export const workerProcessPatterns = [
  "Run-AwardPing",
  "Run-AwardPingDownstreamLane",
  "run-downstream-lane",
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
  "process-monitoring-feedback-promotions",
  "process-visual-review-batch",
  "reconcile-impacted-award-pages",
];
