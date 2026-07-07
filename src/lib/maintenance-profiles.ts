export const MAINTENANCE_PROFILE_IDS = [
  "catchup",
  "daily",
  "baseline",
  "cleanup",
  "snapshots",
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
    detail: "Runs source cleanup, missing screenshots, Gemini Batch facts, aggregation, and snapshot pruning.",
    phases: ["health", "source-quality", "visual-missing", "baseline-facts", "aggregate-facts", "prune-history"],
    primary: true,
  },
  daily: {
    id: "daily",
    label: "Daily Maintenance",
    detail: "Runs the normal full pass for screenshots, page facts, public facts, cleanup, and pruning.",
    phases: ["health", "visual", "baseline-facts", "aggregate-facts", "source-quality", "prune-history"],
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
    detail: "Runs source hygiene, public fact aggregation, and snapshot pruning without screenshot capture.",
    phases: ["health", "source-quality", "aggregate-facts", "prune-history"],
  },
  snapshots: {
    id: "snapshots",
    label: "Screenshots",
    detail: "Refreshes visual snapshots across open active source pages.",
    phases: ["health", "visual"],
  },
};
