export type SourceIntakeOperatorAction =
  | "retry"
  | "retry_reconciliation"
  | "reject"
  | "attach_to_award"
  | "approve_as_new_award"
  | "rerun_capture"
  | "rerun_ai_review";

export const FREE_RECONCILIATION_FAILURE_REASON =
  "matching_failed_closed_operator_retry_required";
export const FREE_RECONCILIATION_PREFLIGHT_FAILURE_REASON =
  "reconciliation_retry_preflight_failed_no_charge";
export const FREE_RECONCILIATION_RETRY_REASON =
  "manual_reconciliation_retry_requested";
export const POST_RETENTION_CAPTURE_PERSISTENCE_UNVERIFIED_REASON =
  "source_intake_post_retention_persistence_unverified_manual_only";

export type SourceIntakeOperatorActionContext = {
  statusReason?: string | null;
  aiReview?: unknown;
  captureMetadata?: unknown;
  requestId?: string | null;
  acquisitionKind?: string | null;
  notificationMode?: string | null;
  onboardingBatchId?: string | null;
};

export type SourceIntakeReconciliationRetryEligibility = {
  allowed: boolean;
  reason:
    | "eligible_zero_charge_retry"
    | "request_not_reconciliation_failure"
    | "provider_submission_state_ambiguous"
    | "accepted_ai_result_missing"
    | "retained_capture_artifact_missing_or_invalid";
  explanation: string;
};

export type SourceIntakeProtectedRecoveryMode =
  | "ordinary"
  | "retry_capture_may_charge"
  | "resume_staged_capture_may_charge"
  | "rerun_ai_review_may_charge"
  | "replay_retained_result_no_charge"
  | "manual_only";

export type SourceIntakeProtectedRecovery = {
  protected: boolean;
  mode: SourceIntakeProtectedRecoveryMode;
  explanation: string;
  apiCharge: "none" | "may_charge" | "not_applicable";
  refetchesPage: boolean;
  runsAiReview: boolean;
};

const SAFE_IDLE_STATUSES = ["pending", "queued", "failed", "needs_manual_review"] as const;
const RECOVERY_STATUSES = ["failed", "needs_manual_review"] as const;
const EXTERNAL_BATCH_RECOVERY_REASONS = new Set([
  "gemini_batch_submission_in_progress_fail_closed",
  "manual_recovery_required_possible_external_batch_created",
  "manual_recovery_required_external_batch_created_after_claim_loss",
  "stale_gemini_batch_operator_recovery_required",
  "stale_submitted_missing_gemini_batch_operator_recovery_required",
]);
const RETAINED_BYTES_MANUAL_ONLY_REASONS = new Set([
  "intake_pdf_bytes_unavailable",
  "intake_pdf_hash_mismatch",
  "intake_pdf_length_mismatch",
  "intake_local_conflict",
  "intake_local_unsafe_path",
]);

export function sourceIntakeAllowedStatuses(action: SourceIntakeOperatorAction): string[] {
  if (action === "retry_reconciliation") return [...RECOVERY_STATUSES];
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
  context: SourceIntakeOperatorActionContext = {},
): boolean {
  const aiReview = objectValue(context.aiReview);
  const ambiguousProviderState = providerSubmissionStateAmbiguous(aiReview);
  if (
    ambiguousProviderState ||
    EXTERNAL_BATCH_RECOVERY_REASONS.has(context.statusReason || "")
  ) {
    return action === "reject";
  }

  const protectedRecovery = sourceIntakeProtectedRecovery(status, context);
  if (protectedRecovery.protected) {
    if (action === "reject") return true;
    if (protectedRecovery.mode === "retry_capture_may_charge") return action === "retry";
    if (protectedRecovery.mode === "resume_staged_capture_may_charge") return action === "retry";
    if (protectedRecovery.mode === "rerun_ai_review_may_charge") return action === "rerun_ai_review";
    if (protectedRecovery.mode === "replay_retained_result_no_charge") {
      return action === "retry_reconciliation";
    }
    return false;
  }

  if (isSourceIntakeReconciliationRetryFailure(context.statusReason)) {
    if (action === "reject") return true;
    const freeReplayAllowed = sourceIntakeReconciliationRetryEligibility(status, context).allowed;
    if (freeReplayAllowed) return action === "retry_reconciliation";
    if (context.statusReason === FREE_RECONCILIATION_FAILURE_REASON) return action === "retry";
    return false;
  }

  if (action === "retry_reconciliation") return false;
  return sourceIntakeAllowedStatuses(action).includes(status);
}

export function sourceIntakeReconciliationRetryEligibility(
  status: string,
  context: SourceIntakeOperatorActionContext,
): SourceIntakeReconciliationRetryEligibility {
  const protectedRecovery = sourceIntakeProtectedRecovery(status, context);
  if (
    !RECOVERY_STATUSES.includes(status as (typeof RECOVERY_STATUSES)[number]) ||
    (!isSourceIntakeReconciliationRetryFailure(context.statusReason) &&
      protectedRecovery.mode !== "replay_retained_result_no_charge")
  ) {
    return {
      allowed: false,
      reason: "request_not_reconciliation_failure",
      explanation: "This free replay is limited to a protected live first-capture failure or a failed reconciliation of an already accepted review.",
    };
  }

  const aiReview = objectValue(context.aiReview);
  if (providerSubmissionStateAmbiguous(aiReview)) {
    return {
      allowed: false,
      reason: "provider_submission_state_ambiguous",
      explanation: "The provider submission state is ambiguous, so no retry can start until that state is resolved.",
    };
  }

  if (!hasStoredAcceptedAiResult(aiReview, context.requestId)) {
    return {
      allowed: false,
      reason: "accepted_ai_result_missing",
      explanation: "The completed accepted AI result is missing or is not bound to this request.",
    };
  }

  if (!hasBoundRetainedCaptureArtifact(context.captureMetadata, context.requestId)) {
    return {
      allowed: false,
      reason: "retained_capture_artifact_missing_or_invalid",
      explanation: "The exact retained capture cannot be verified against this request, URL, and file hash.",
    };
  }

  return {
    allowed: true,
    reason: "eligible_zero_charge_retry",
    explanation: "This retry is free. It reuses the stored accepted AI result and exact retained capture; it does not refetch the page or rerun AI.",
  };
}

export function isSourceIntakeReconciliationRetryFailure(
  statusReason: string | null | undefined,
): boolean {
  return statusReason === FREE_RECONCILIATION_FAILURE_REASON
    || statusReason === FREE_RECONCILIATION_PREFLIGHT_FAILURE_REASON;
}

export function isProtectedLiveFirstCaptureRequest(
  status: string,
  context: SourceIntakeOperatorActionContext,
): boolean {
  return (
    RECOVERY_STATUSES.includes(status as (typeof RECOVERY_STATUSES)[number]) &&
    cleanText(context.acquisitionKind) === "live_discovery" &&
    cleanText(context.notificationMode) === "first_capture_candidate" &&
    !cleanText(context.onboardingBatchId)
  );
}

export function isSourceIntakeReconciliationOnlyRecovery(
  status: string,
  context: SourceIntakeOperatorActionContext,
): boolean {
  return isSourceIntakeReconciliationRetryFailure(context.statusReason)
    || isProtectedLiveFirstCaptureRequest(status, context);
}

export function sourceIntakeProtectedRecovery(
  status: string,
  context: SourceIntakeOperatorActionContext,
): SourceIntakeProtectedRecovery {
  if (!isProtectedLiveFirstCaptureRequest(status, context)) {
    return {
      protected: false,
      mode: "ordinary",
      explanation: "This request uses the ordinary source-intake recovery controls.",
      apiCharge: "not_applicable",
      refetchesPage: false,
      runsAiReview: false,
    };
  }

  const aiReview = objectValue(context.aiReview);
  const captureMetadata = objectValue(context.captureMetadata);
  const completedValue = objectValue(captureMetadata.retained_artifact);
  const stagedValue = objectValue(captureMetadata.retained_artifact_staged);
  const completedPresent = hasValue(captureMetadata.retained_artifact);
  const stagedPresent = hasValue(captureMetadata.retained_artifact_staged);
  const completedValid = completedPresent && hasBoundCaptureArtifact(
    captureMetadata,
    completedValue,
    context.requestId,
    true,
  );
  const stagedValid = stagedPresent && hasBoundCaptureArtifact(
    captureMetadata,
    stagedValue,
    context.requestId,
    false,
  );
  const accepted = hasStoredAcceptedAiResult(aiReview, context.requestId);
  const claimsAccepted = cleanText(aiReview.status) === "accepted"
    || cleanText(objectValue(aiReview.raw).status) === "accepted";
  const providerAmbiguous = providerSubmissionStateAmbiguous(aiReview)
    || EXTERNAL_BATCH_RECOVERY_REASONS.has(context.statusReason || "")
    || providerWorkWithoutResult(aiReview);
  const inconsistentEvidence =
    (completedPresent && !completedValid) ||
    (stagedPresent && !stagedValid) ||
    (completedPresent && stagedPresent) ||
    (claimsAccepted && !accepted);

  const retainedBytesNeedManualRepair = RETAINED_BYTES_MANUAL_ONLY_REASONS.has(
    context.statusReason || "",
  );
  const retainedIdentityPersistenceUnverified =
    context.statusReason === POST_RETENTION_CAPTURE_PERSISTENCE_UNVERIFIED_REASON;
  if (
    providerAmbiguous ||
    inconsistentEvidence ||
    retainedBytesNeedManualRepair ||
    retainedIdentityPersistenceUnverified
  ) {
    return protectedManualOnly(
      providerAmbiguous
        ? "Provider review state is ambiguous. Reject or resolve it manually; AwardPing will not fetch, submit, or replay this request."
        : retainedIdentityPersistenceUnverified
          ? "Capture retention may have completed, but its database identity was not proven. Inspect immutable storage and bind the exact capture manually; AwardPing will not fetch the URL again."
        : retainedBytesNeedManualRepair
          ? "The exact saved capture has a byte, hash, length, or local-path integrity problem. Repair it manually; AwardPing will not replace it with bytes fetched from the current URL."
        : "The retained capture or accepted result is inconsistent. Repair it manually; AwardPing will not fetch, submit, or replay this request.",
    );
  }

  if (accepted) {
    if (completedValid) {
      return {
        protected: true,
        mode: "replay_retained_result_no_charge",
        explanation: "Free replay available: reuse the verified retained capture and accepted AI result. No page fetch or AI charge.",
        apiCharge: "none",
        refetchesPage: false,
        runsAiReview: false,
      };
    }
    return protectedManualOnly(
      "An accepted AI result exists without a completed verified capture. Repair the evidence manually; no automated retry is safe.",
    );
  }

  if (completedValid) {
    return {
      protected: true,
      mode: "rerun_ai_review_may_charge",
      explanation: "Review the verified saved capture with AI. The page will not be fetched again, but the AI review may create a charge.",
      apiCharge: "may_charge",
      refetchesPage: false,
      runsAiReview: true,
    };
  }

  if (hasProviderResult(aiReview)) {
    return protectedManualOnly(
      "A provider result exists without a completed verified capture. Resolve the evidence manually; no recapture or new AI review is safe.",
    );
  }

  if (stagedValid) {
    return {
      protected: true,
      mode: "resume_staged_capture_may_charge",
      explanation: "Resume the exact saved capture before review. The page will not be fetched again; the first AI review may create a charge.",
      apiCharge: "may_charge",
      refetchesPage: false,
      runsAiReview: true,
    };
  }

  return {
    protected: true,
    mode: "retry_capture_may_charge",
    explanation: "Retry the initial capture. The page will be fetched again and its first AI review may create a charge.",
    apiCharge: "may_charge",
    refetchesPage: true,
    runsAiReview: true,
  };
}

function protectedManualOnly(explanation: string): SourceIntakeProtectedRecovery {
  return {
    protected: true,
    mode: "manual_only",
    explanation,
    apiCharge: "not_applicable",
    refetchesPage: false,
    runsAiReview: false,
  };
}

export function sourceIntakeReconciliationRetryPatch(updatedAt: string) {
  return {
    status: "ai_review_succeeded" as const,
    status_reason: FREE_RECONCILIATION_RETRY_REASON,
    worker_run_id: null,
    failed_at: null,
    error: null,
    processed_at: null,
    updated_at: updatedAt,
  };
}

function providerSubmissionStateAmbiguous(aiReview: Record<string, unknown>): boolean {
  const claimToken = cleanText(aiReview.submission_claim_token);
  const batchName = cleanText(aiReview.gemini_batch_name);
  const possibleBatchName = cleanText(aiReview.possible_external_batch_name);
  return (
    (Boolean(claimToken) && !batchName) ||
    Boolean(cleanText(aiReview.submission_claim_failed_closed_at)) ||
    (Boolean(possibleBatchName) && possibleBatchName !== batchName)
  );
}

function hasProviderResult(aiReview: Record<string, unknown>): boolean {
  const raw = objectValue(aiReview.raw);
  const status = cleanText(aiReview.status);
  return (
    Object.keys(raw).length > 0 ||
    ["accepted", "needs_review", "rejected"].includes(status) ||
    Boolean(cleanText(aiReview.completed_at)) ||
    hasValue(aiReview.gemini_item_error) ||
    hasValue(aiReview.parse_error)
  );
}

function providerWorkWithoutResult(aiReview: Record<string, unknown>): boolean {
  const hasProviderWork = [
    aiReview.submission_claim_token,
    aiReview.gemini_batch_name,
    aiReview.possible_external_batch_name,
    aiReview.submitted_at,
    aiReview.batch_create_started_at,
  ].some(hasValue);
  return hasProviderWork && !hasProviderResult(aiReview);
}

function hasStoredAcceptedAiResult(
  aiReview: Record<string, unknown>,
  requestId: string | null | undefined,
): boolean {
  const raw = objectValue(aiReview.raw);
  const completedAt = cleanText(aiReview.completed_at);
  const requestKey = cleanText(aiReview.gemini_batch_request_key);
  return (
    cleanText(aiReview.status) === "accepted" &&
    cleanText(raw.status) === "accepted" &&
    Object.keys(raw).length > 0 &&
    Boolean(cleanText(aiReview.gemini_batch_name)) &&
    Boolean(completedAt) &&
    Number.isFinite(Date.parse(completedAt)) &&
    Boolean(cleanText(requestId)) &&
    requestKey === cleanText(requestId) &&
    !hasValue(aiReview.gemini_item_error) &&
    !hasValue(aiReview.parse_error)
  );
}

function hasBoundRetainedCaptureArtifact(
  captureMetadataValue: unknown,
  requestId: string | null | undefined,
): boolean {
  const captureMetadata = objectValue(captureMetadataValue);
  return hasBoundCaptureArtifact(
    captureMetadata,
    objectValue(captureMetadata.retained_artifact),
    requestId,
    true,
  );
}

function hasBoundCaptureArtifact(
  captureMetadata: Record<string, unknown>,
  artifact: Record<string, unknown>,
  requestId: string | null | undefined,
  requireR2Verified: boolean,
): boolean {
  const artifacts = objectValue(artifact.artifacts);
  const pdf = objectValue(artifacts.pdf);
  const text = objectValue(artifacts.text);
  const captureMetadataArtifact = objectValue(artifacts.capture_metadata);
  const request = cleanText(requestId);
  const fileHash = cleanText(captureMetadata.capture_file_hash).toLowerCase();
  const finalUrl = cleanText(captureMetadata.canonical_url) || cleanText(captureMetadata.final_url);
  const prefix = cleanText(artifact.prefix);
  const verifiedAt = cleanText(artifact.r2_verified_at);
  const fileBytes = scalarText(artifact.file_bytes);
  const textLength = scalarText(artifact.text_length);
  const capturedAt = cleanText(artifact.captured_at);
  const r2Bucket = cleanText(artifact.r2_bucket);
  const r2StoreId = cleanText(artifact.r2_store_id);
  const r2BucketValid = /^[a-z0-9][a-z0-9._-]{0,254}$/i.test(r2Bucket);
  const r2StoreValid = /^[a-z0-9][a-z0-9.:-]{0,254}$/i.test(r2StoreId);
  const r2VerifiedAtValid = /^\d{4}-\d{2}-\d{2}T.+Z$/.test(verifiedAt)
    && Number.isFinite(Date.parse(verifiedAt));
  const r2BindingValid = requireR2Verified
    ? r2BucketValid && r2StoreValid && r2VerifiedAtValid
    : (!r2Bucket || r2BucketValid)
      && (!r2StoreId || r2StoreValid)
      && (!verifiedAt || r2VerifiedAtValid)
      && (!verifiedAt || (r2BucketValid && r2StoreValid));

  return (
    Boolean(request) &&
    scalarText(artifact.schema_version) === "1" &&
    cleanText(artifact.namespace) === "source-intake-first-observation" &&
    cleanText(artifact.request_id) === request &&
    Boolean(capturedAt) &&
    Number.isFinite(Date.parse(capturedAt)) &&
    /^[0-9a-f]{64}$/.test(fileHash) &&
    cleanText(artifact.file_hash).toLowerCase() === fileHash &&
    Boolean(finalUrl) &&
    isAbsoluteHttpUrl(finalUrl) &&
    cleanText(artifact.final_url) === finalUrl &&
    prefix === `source-intake-first-observation/v1/requests/${request}/sha256/${fileHash}` &&
    r2BindingValid &&
    /^[1-9][0-9]*$/.test(fileBytes) &&
    /^[0-9]+$/.test(textLength) &&
    /^[0-9a-f]{64}$/.test(cleanText(artifact.text_hash).toLowerCase()) &&
    cleanText(pdf.key) === `${prefix}/document.pdf` &&
    cleanText(pdf.sha256).toLowerCase() === fileHash &&
    scalarText(pdf.byte_length) === fileBytes &&
    cleanText(pdf.content_type) === "application/pdf" &&
    validArtifactRole(text, `${prefix}/text.txt`, "text/plain; charset=utf-8") &&
    validArtifactRole(captureMetadataArtifact, `${prefix}/capture.json`, "application/json")
  );
}

function validArtifactRole(
  artifact: Record<string, unknown>,
  expectedKey: string,
  expectedContentType: string,
): boolean {
  const byteLength = Number(artifact.byte_length);
  return (
    cleanText(artifact.key) === expectedKey &&
    /^[0-9a-f]{64}$/.test(cleanText(artifact.sha256).toLowerCase()) &&
    Number.isSafeInteger(byteLength) &&
    byteLength >= 0 &&
    cleanText(artifact.content_type) === expectedContentType
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function scalarText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return cleanText(value);
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.host);
  } catch {
    return false;
  }
}
