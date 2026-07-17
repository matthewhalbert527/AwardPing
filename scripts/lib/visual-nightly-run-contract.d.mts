export type ScheduledNightlyVisualRunReason =
  | "scheduled_live_recurring_discovery"
  | "not_scheduled"
  | "outside_legacy_six_pm_window"
  | "repair_run"
  | "targeted_run"
  | "partial_scan"
  | "historical_onboarding"
  | "unsupported_discovery_intent";

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

export declare function classifyScheduledNightlyVisualRun(
  input?: ScheduledNightlyVisualRunInput,
): ScheduledNightlyVisualRunClassification;

export declare function isScheduledNightlyVisualRun(
  input?: ScheduledNightlyVisualRunInput,
): boolean;
