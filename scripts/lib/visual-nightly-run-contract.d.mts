export type ScheduledNightlyVisualRunReason =
  | "scheduled_live_recurring_discovery"
  | "not_scheduled"
  | "outside_legacy_six_pm_window"
  | "repair_run"
  | "targeted_run"
  | "partial_scan"
  | "historical_onboarding"
  | "unsupported_discovery_intent"
  | "pdf_discovery_disabled"
  | "html_discovery_not_canonical"
  | "visual_review_not_canonical"
  | "visual_review_disabled"
  | "immutable_evidence_sync_disabled";

export type ScheduledNightlyVisualRunInput = {
  startedAt?: unknown;
  runIdentity?: unknown;
  options?: unknown;
};

export type ScheduledNightlyVisualRunClassification = {
  eligible: boolean;
  reason: ScheduledNightlyVisualRunReason;
  option: string | null;
};

export declare const NIGHTLY_VISUAL_DISCOVERY_INTENT: "live_recurring";
export declare const NIGHTLY_VISUAL_REVIEW_MODE: "batch";

export type VisualDiscoveryConfiguration = {
  requestedIntent: string;
  requestedOnboardingBatchId: string;
  discoveryIntent: "live_recurring" | "historical_onboarding";
};

export declare function resolveVisualDiscoveryConfiguration(input?: {
  args?: Record<string, unknown>;
  env?: Record<string, unknown>;
}): VisualDiscoveryConfiguration;

export declare function classifyScheduledNightlyVisualRun(
  input?: ScheduledNightlyVisualRunInput,
): ScheduledNightlyVisualRunClassification;

export declare function isScheduledNightlyVisualRun(
  input?: ScheduledNightlyVisualRunInput,
): boolean;
