export const MAINTENANCE_PROFILE_IDS = [
  "catchup",
  "daily",
  "baseline",
  "cleanup",
  "snapshots",
  "discovery",
  "visual-review",
] as const;

export type MaintenanceProfileId = (typeof MAINTENANCE_PROFILE_IDS)[number];

export type MaintenanceProfile = {
  id: MaintenanceProfileId;
  label: string;
  detail: string;
  phases: string[];
  primary?: boolean;
};

export const DEFAULT_BASELINE_COST_CAP_USD = 10;
export const GEMINI_BATCH_COST_PER_SOURCE_USD = 0.000215;

export const MAINTENANCE_PROFILES: Record<MaintenanceProfileId, MaintenanceProfile> = {
  catchup: {
    id: "catchup",
    label: "Catch Up Site",
    detail:
      "Runs the hardened catch-up pass: source-quality cleanup, missing stable captures, Gemini Batch facts, public aggregation, and retention pruning.",
    phases: ["health", "source-quality", "change-event-noise", "visual-missing", "baseline-facts", "aggregate-facts", "prune-history"],
    primary: true,
  },
  daily: {
    id: "daily",
    label: "Daily Maintenance",
    detail:
      "Runs stable daily capture, queues visual review candidates for Gemini Batch, processes batch results, refreshes facts, applies source-quality cleanup, and prunes old snapshots.",
    phases: ["health", "visual", "visual-review-batch", "baseline-facts", "aggregate-facts", "source-quality", "change-event-noise", "prune-history"],
  },
  baseline: {
    id: "baseline",
    label: "Baseline Facts",
    detail: "Runs Gemini Batch fact extraction and then rebuilds public program facts.",
    phases: ["health", "baseline-facts", "aggregate-facts"],
  },
  cleanup: {
    id: "cleanup",
    label: "Source Cleanup",
    detail:
      "Runs the source-quality gate cleanup, noisy change-event suppression cleanup, public fact aggregation, and snapshot pruning without screenshot capture.",
    phases: ["health", "source-quality", "change-event-noise", "aggregate-facts", "prune-history"],
  },
  snapshots: {
    id: "snapshots",
    label: "Screenshots",
    detail:
      "Runs stable capture for already-approved monitorable sources and enqueues visual review candidates without discovering new sources.",
    phases: ["health", "visual"],
  },
  discovery: {
    id: "discovery",
    label: "Source Discovery",
    detail:
      "Runs the separate limited discovery workflow, quality-gates candidates, and queues most new sources for review instead of immediately opening them.",
    phases: ["health", "source-discovery", "source-quality", "aggregate-facts"],
  },
  "visual-review": {
    id: "visual-review",
    label: "Visual Review Batch",
    detail:
      "Polls/submits durable Gemini Batch visual-review jobs and publishes only validated true applicant-facing changes.",
    phases: ["health", "visual-review-batch"],
  },
};
