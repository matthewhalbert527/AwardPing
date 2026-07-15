export type SourceIntakeOperatorAction =
  | "retry"
  | "reject"
  | "attach_to_award"
  | "approve_as_new_award"
  | "rerun_capture"
  | "rerun_ai_review";

const SAFE_IDLE_STATUSES = ["pending", "queued", "failed", "needs_manual_review"] as const;
const RECOVERY_STATUSES = ["failed", "needs_manual_review"] as const;
const EXTERNAL_BATCH_RECOVERY_REASONS = new Set([
  "gemini_batch_submission_in_progress_fail_closed",
  "manual_recovery_required_possible_external_batch_created",
  "manual_recovery_required_external_batch_created_after_claim_loss",
  "stale_gemini_batch_operator_recovery_required",
  "stale_submitted_missing_gemini_batch_operator_recovery_required",
]);

export function sourceIntakeAllowedStatuses(action: SourceIntakeOperatorAction): string[] {
  if (action === "rerun_capture" || action === "rerun_ai_review") {
    return [...RECOVERY_STATUSES];
  }
  return [...SAFE_IDLE_STATUSES];
}

export function sourceIntakeActionAllowed(action: SourceIntakeOperatorAction, status: string): boolean {
  return sourceIntakeActionAllowedWithContext(action, status);
}

export function sourceIntakeActionAllowedWithContext(
  action: SourceIntakeOperatorAction,
  status: string,
  context: { statusReason?: string | null; aiReview?: unknown } = {},
): boolean {
  const aiReview = objectValue(context.aiReview);
  const activeSubmissionClaim =
    Boolean(cleanText(aiReview.submission_claim_token)) &&
    !cleanText(aiReview.gemini_batch_name) &&
    !cleanText(aiReview.submission_claim_failed_closed_at);
  const ambiguousSubmissionClaim =
    Boolean(cleanText(aiReview.submission_claim_token)) &&
    !cleanText(aiReview.gemini_batch_name) &&
    Boolean(cleanText(aiReview.submission_claim_failed_closed_at));
  if (
    activeSubmissionClaim ||
    ambiguousSubmissionClaim ||
    EXTERNAL_BATCH_RECOVERY_REASONS.has(context.statusReason || "")
  ) {
    return action === "reject";
  }
  return sourceIntakeAllowedStatuses(action).includes(status);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
