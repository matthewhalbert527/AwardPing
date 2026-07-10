export const MAINTENANCE_PROFILE_IDS = [
  "catchup",
  "daily",
  "baseline",
  "cleanup",
  "snapshots",
  "discovery",
  "source-intake",
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
      "Runs the complete hardened catch-up pass: missing captures, open-source AI review completion, source cleanup, Gemini Batch visual review, award reconciliation, page audit, localization repair, and retention pruning.",
    phases: [
      "health",
      "source-intake",
      "visual-missing",
      "ai-review-completion",
      "source-quality",
      "visual-review-batch",
      "reconcile-awards",
      "page-audit-batch",
      "change-event-noise",
      "localization-repair",
      "prune-history",
    ],
    primary: true,
  },
  daily: {
    id: "daily",
    label: "Daily Maintenance",
    detail:
      "Runs limited source intake, source-quality cleanup, stable daily capture with separate expandable-section text comparison, queues Gemini Batch review, refreshes source facts, reconciles impacted awards, audits public pages, and prunes old snapshots.",
    phases: ["health", "source-intake", "source-quality", "visual", "visual-review-batch", "baseline-facts", "reconcile-awards", "page-audit-batch", "change-event-noise", "prune-history"],
  },
  baseline: {
    id: "baseline",
    label: "Baseline Facts",
    detail: "Runs Gemini Batch source fact extraction, then reconciles and audits public award pages from evidence-backed facts.",
    phases: ["health", "baseline-facts", "reconcile-awards", "page-audit-batch"],
  },
  cleanup: {
    id: "cleanup",
    label: "Source Cleanup",
    detail:
      "Runs the source-quality gate cleanup, noisy change-event suppression cleanup, award reconciliation, and snapshot pruning without screenshot capture.",
    phases: ["health", "source-quality", "change-event-noise", "reconcile-awards", "prune-history"],
  },
  snapshots: {
    id: "snapshots",
    label: "Screenshots",
    detail:
      "Runs stable capture and cheap expandable-section text extraction for already-approved monitorable sources, then enqueues visual review candidates without discovering new sources.",
    phases: ["health", "visual"],
  },
  discovery: {
    id: "discovery",
    label: "Source Discovery",
    detail:
      "Runs the separate limited discovery workflow, quality-gates candidates, refreshes source facts, and reconciles affected awards.",
    phases: ["health", "source-intake", "source-discovery", "source-quality", "baseline-facts", "reconcile-awards", "page-audit-batch"],
  },
  "source-intake": {
    id: "source-intake",
    label: "Source Intake",
    detail:
      "Processes pasted source URLs through capture, deterministic source-quality review, Gemini Batch classification, award match/create, source insertion, and reconciliation.",
    phases: ["health", "source-intake", "reconcile-awards", "page-audit-batch"],
  },
  "visual-review": {
    id: "visual-review",
    label: "Visual Review Batch",
    detail:
      "Polls/submits durable Gemini Batch visual-review jobs, including compact changed-section diffs, and publishes only validated applicant-facing changes.",
    phases: ["health", "visual-review-batch"],
  },
};
