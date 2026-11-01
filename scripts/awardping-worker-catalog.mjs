export const workerLanes = [
  {
    id: "orchestration",
    label: "Monitoring System",
    detail:
      "A single coverage report tracks source readiness and published core details; historical promotion and quarantine workflows remain unscheduled.",
    profileIds: [],
    taskIds: [
      "health",
      "verified-feedback-promotions",
      "manual-quarantine-registry",
      "nightly-report",
    ],
    workerIds: [
      "nightly-report-lane",
    ],
  },
  {
    id: "source-quality",
    label: "Suppression & Retention",
    detail:
      "Operator tools for historical suppression and retention; no recurring suppression schedule is installed.",
    profileIds: [],
    taskIds: ["change-event-noise", "prune-history"],
    workerIds: [],
  },
  {
    id: "visual-capture",
    label: "Visual Capture",
    detail:
      "Three daily collectors capture approved source text; changed-page review processes comparisons separately.",
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
      "Operator source intake and discovery tools; discovery has no recurring review schedule.",
    profileIds: ["source-intake", "discovery"],
    taskIds: ["source-intake", "source-discovery"],
    workerIds: [],
  },
  {
    id: "facts-cycle",
    label: "Facts & Cycle Intelligence",
    detail:
      "Runs deterministic public-page audits; historical reconciliation remains an operator tool.",
    profileIds: [],
    taskIds: ["reconcile-awards", "page-audit-batch"],
    workerIds: ["page-audit-lane"],
  },
];

export const maintenanceProfiles = {
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
    scheduledWorkerIds: [],
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
      args: ["scripts/sync-manual-quarantine-registry.mjs", "--apply=true"],
    },
    scheduledWorkerIds: [],
  },
  {
    id: "nightly-report",
    laneId: "orchestration",
    label: "Coverage Report",
    detail:
      "Reports approved-source coverage and current core details without processing discovery or historical mutation queues.",
    cost: "$0 direct AI/API cost.",
    run: {
      kind: "script",
      args: ["scripts/program-text-worker.mjs", "--env=.env.worker.local", "--mode=report", "--apply=true"],
    },
    scheduledWorkerIds: ["nightly-report-lane"],
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
    scheduledWorkerIds: [],
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
    scheduledWorkerIds: [],
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
    scheduledWorkerIds: [],
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
];

export const scheduledWorkers = [

  {
    id: "changed-page-review-lane",
    laneKey: "changed_page_review",
    laneId: "visual-capture",
    taskName: "AwardPing Changed Page Review Lane",
    label: "Changed Page Review",
    detail:
      "Every 15 minutes: reviews changed source text under its own lease and timeout.",
    cost: "Gemini Batch API with a $5/day hard cap.",
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
    id: "nightly-report-lane",
    laneKey: "nightly_report",
    laneId: "orchestration",
    taskName: "AwardPing Coverage Report",
    label: "Coverage Report",
    detail:
      "Every 15 minutes: reports approved-source coverage and current core details without capture, AI review or historical queue mutations.",
    cost: "$0 direct AI/API cost.",
  },
  {
    id: "visual-shard-1",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 1",
    label: "Visual Snapshot Shard 1",
    detail:
      "Captures approved source text for the first daily collection shard.",
    cost: "$0 direct AI/API cost during capture.",
  },
  {
    id: "visual-shard-2",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 2",
    label: "Visual Snapshot Shard 2",
    detail:
      "Captures approved source text for the second daily collection shard.",
    cost: "$0 direct AI/API cost during capture.",
  },
  {
    id: "visual-shard-3",
    laneId: "visual-capture",
    taskName: "AwardPing Visual Snapshot Worker Shard 3",
    label: "Visual Snapshot Shard 3",
    detail:
      "Captures approved source text for the third daily collection shard.",
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
