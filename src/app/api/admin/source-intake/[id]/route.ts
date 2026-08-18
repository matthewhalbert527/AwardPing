import { NextResponse } from "next/server";
import { z } from "zod";
import { validateSameOriginAdminMutation } from "@/lib/admin-request-security";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import {
  FREE_RECONCILIATION_FAILURE_REASON,
  SOURCE_BACKFILL_APPROVAL_PREFLIGHT_FAILURE_REASON,
  SourceIntakeOperatorValidationError,
  isApprovedBackfillSourceActivationRetry,
  sourceIntakeAiReviewRetryPatch,
  sourceIntakeBackfillApprovalPatch,
  sourceIntakeBackfillActivationRetryPatch,
  sourceIntakeActionAllowedWithContext,
  sourceIntakeProtectedRecovery,
  sourceIntakeReconciliationRetryEligibility,
  sourceIntakeReconciliationRetryPatch,
  type SourceIntakeOperatorActionContext,
} from "@/lib/source-intake-operator-actions";
import {
  SourceIntakeProviderBindingValidationError,
  verifySourceIntakeProviderBindingForAdminApproval,
} from "@/lib/source-intake-provider-binding.server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const actionSchema = z.object({
  action: z.enum([
    "retry",
    "retry_reconciliation",
    "reject",
    "attach_to_award",
    "approve_backfill_source",
    "approve_as_new_award",
    "rerun_capture",
    "rerun_ai_review",
  ]),
  sharedAwardId: z.string().uuid().optional(),
  reason: z.string().trim().max(1000).optional(),
});

type RouteContext = {
  params: Promise<{ id: string }>;
};

type SourcePageRequestUpdate = Database["public"]["Tables"]["source_page_requests"]["Update"];

export async function PATCH(request: Request, context: RouteContext) {
  const originError = validateSameOriginAdminMutation(request);
  if (originError) return originError;

  const access = await validateAdminRequest();
  if (!access.ok) return access.response;

  const { id } = await context.params;
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Choose a valid source-intake action." }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const now = new Date().toISOString();

  const { data: current, error: currentError } = await admin
    .from("source_page_requests")
    .select("id,award_name,homepage_url,notes,intake_type,submitted_url,normalized_url,status,status_reason,ai_review,deterministic_review,capture_metadata,acquisition_kind,notification_mode,onboarding_batch_id,matched_shared_award_id,updated_at")
    .eq("id", id)
    .maybeSingle();
  if (currentError) {
    reportPrivateSourceIntakeError("load", currentError);
    return NextResponse.json(
      { ok: false, error: "The source-intake request could not be loaded." },
      { status: 500 },
    );
  }
  if (!current) {
    return NextResponse.json({ ok: false, error: "Source intake request not found." }, { status: 404 });
  }
  const actionContext = {
    statusReason: current.status_reason,
    aiReview: current.ai_review,
    captureMetadata: current.capture_metadata,
    requestId: current.id,
    acquisitionKind: current.acquisition_kind,
    notificationMode: current.notification_mode,
    onboardingBatchId: current.onboarding_batch_id,
    matchedSharedAwardId: current.matched_shared_award_id,
  };
  const protectedRecovery = sourceIntakeProtectedRecovery(current.status, actionContext);
  if (
    !sourceIntakeActionAllowedWithContext(parsed.data.action, current.status, actionContext)
  ) {
    const retryEligibility = parsed.data.action === "retry_reconciliation"
      ? sourceIntakeReconciliationRetryEligibility(current.status, actionContext)
      : null;
    return NextResponse.json(
      {
        ok: false,
        error: (protectedRecovery.protected ? protectedRecovery.explanation : retryEligibility?.explanation)
          || `This request is ${current.status}. Active or ambiguous Gemini submissions must finish or be resolved before that action.`,
      },
      { status: 409 },
    );
  }

  if (parsed.data.action === "approve_backfill_source") {
    try {
      verifySourceIntakeProviderBindingForAdminApproval({
        request: current,
        deterministicReview: current.deterministic_review,
        captureMetadata: current.capture_metadata,
        aiReview: current.ai_review,
        requireBackfillEvidence: true,
      });
    } catch (bindingError) {
      if (bindingError instanceof SourceIntakeProviderBindingValidationError) {
        return NextResponse.json(
          { ok: false, error: bindingError.message },
          { status: bindingError.status },
        );
      }
      reportPrivateSourceIntakeError("provider_binding_verification", bindingError);
      return NextResponse.json(
        { ok: false, error: "The source-intake evidence binding could not be verified." },
        { status: 500 },
      );
    }
  }

  const reason = parsed.data.reason || manualReason(parsed.data.action);
  let patch: ReturnType<typeof patchForAction>;
  try {
    patch = patchForAction(
      parsed.data,
      reason,
      now,
      current.status,
      actionContext,
      String(access.user.email || "").trim().toLowerCase(),
    );
  } catch (error) {
    if (error instanceof SourceIntakeOperatorValidationError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: error.status },
      );
    }
    reportPrivateSourceIntakeError("build_action_patch", error);
    return NextResponse.json(
      { ok: false, error: "The source-intake action could not be applied." },
      { status: 500 },
    );
  }
  if (!patch.ok) {
    return NextResponse.json({ ok: false, error: patch.error }, { status: 400 });
  }

  const { data, error } = await admin
    .from("source_page_requests")
    .update(patch.value)
    .eq("id", id)
    .eq("status", current.status)
    .eq("updated_at", current.updated_at)
    .select("*")
    .maybeSingle();

  if (error) {
    reportPrivateSourceIntakeError("update", error);
    return NextResponse.json(
      { ok: false, error: "The source-intake request could not be updated." },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json(
      { ok: false, error: "This request changed while the action was being applied. Refresh and try again." },
      { status: 409 },
    );
  }

  const disclosure = protectedActionDisclosure(
    parsed.data.action,
    protectedRecovery,
    current.status_reason,
  );
  return NextResponse.json({
    ok: true,
    request: data,
    message: disclosure.message,
    retry: disclosure.retry,
  });
}

function protectedActionDisclosure(
  action: z.infer<typeof actionSchema>["action"],
  recovery: ReturnType<typeof sourceIntakeProtectedRecovery>,
  statusReason: string | null,
) {
  if (recovery.protected) {
    const messages = {
      retry_capture_may_charge:
        "Capture retry queued. AwardPing will fetch the page again; its first AI review may create a charge.",
      resume_staged_capture_may_charge:
        "Saved-capture resume queued. AwardPing will resume the exact staged capture without refetching the page; its first AI review may create a charge.",
      rerun_ai_review_may_charge:
        "AI review queued for the verified saved capture. AwardPing will not refetch the page; this review may create a charge.",
      replay_retained_result_no_charge:
        "Free retained-result replay queued. AwardPing will reuse the verified capture and accepted AI result; it will not refetch the page or rerun AI.",
      manual_only: "Request updated.",
      ordinary: "Request updated.",
    } as const;
    return {
      message: action === "reject" ? "Request rejected." : messages[recovery.mode],
      retry: action === "reject" ? undefined : {
        api_charge: recovery.apiCharge,
        creates_api_charge: recovery.apiCharge === "may_charge",
        refetches_page: recovery.refetchesPage,
        runs_ai_review: recovery.runsAiReview,
      },
    };
  }
  if (action === "retry_reconciliation") {
    if (statusReason === SOURCE_BACKFILL_APPROVAL_PREFLIGHT_FAILURE_REASON) {
      return {
        message: "Approved baseline-only activation replay queued. AwardPing will reuse the exact R2 capture and stored review; it will not fetch the page, rerun AI, or create a charge.",
        retry: { api_charge: "none", creates_api_charge: false, refetches_page: false, runs_ai_review: false },
      };
    }
    return {
      message: "Free reconciliation retry queued. AwardPing will reuse the stored accepted AI result and retained capture; it will not refetch the page or rerun AI.",
      retry: { api_charge: "none", creates_api_charge: false, refetches_page: false, runs_ai_review: false },
    };
  }
  if (action === "approve_backfill_source") {
    return {
      message: "Source activation approved. AwardPing will reuse the completed review, add the source as baseline-only, and will not fetch the page, rerun AI, publish a first-observation update, or change the award homepage.",
      retry: { api_charge: "none", creates_api_charge: false, refetches_page: false, runs_ai_review: false },
    };
  }
  if (action === "retry" && statusReason === FREE_RECONCILIATION_FAILURE_REASON) {
    return {
      message: "Page-and-review retry queued for this ordinary source. AwardPing may fetch the page again and the AI review may create a charge.",
      retry: { api_charge: "may_charge", creates_api_charge: true, refetches_page: true, runs_ai_review: true },
    };
  }
  return { message: "Request updated.", retry: undefined };
}

function patchForAction(
  data: z.infer<typeof actionSchema>,
  reason: string,
  now: string,
  currentStatus: string,
  actionContext: SourceIntakeOperatorActionContext,
  approvedBy: string,
):
  | { ok: true; value: SourcePageRequestUpdate }
  | { ok: false; error: string } {
  if (data.action === "reject") {
    return {
      ok: true,
      value: {
        status: "rejected",
        status_reason: reason,
        error: null,
        failed_at: null,
        processed_at: now,
        updated_at: now,
      },
    };
  }

  if (data.action === "retry_reconciliation") {
    return {
      ok: true,
      value: isApprovedBackfillSourceActivationRetry(currentStatus, actionContext)
        ? sourceIntakeBackfillActivationRetryPatch(now)
        : sourceIntakeReconciliationRetryPatch(now),
    };
  }

  if (data.action === "attach_to_award") {
    if (!data.sharedAwardId) {
      return { ok: false, error: "Choose the award to attach this request to." };
    }
    return {
      ok: true,
      value: {
        status: "pending",
        status_reason: reason,
        matched_shared_award_id: data.sharedAwardId,
        error: null,
        failed_at: null,
        processed_at: null,
        updated_at: now,
      },
    };
  }

  if (data.action === "approve_backfill_source") {
    if (!data.sharedAwardId) {
      return { ok: false, error: "Choose the award that should receive this source." };
    }
    return {
      ok: true,
      value: sourceIntakeBackfillApprovalPatch({
        status: currentStatus,
        context: actionContext,
        sharedAwardId: data.sharedAwardId,
        reason,
        approvedBy,
        updatedAt: now,
      }),
    };
  }

  if (data.action === "approve_as_new_award") {
    return {
      ok: true,
      value: {
        status: "pending",
        status_reason: reason,
        matched_shared_award_id: null,
        error: null,
        failed_at: null,
        processed_at: null,
        updated_at: now,
        ai_review: {
          manual_approval: {
            action: "approve_as_new_award",
            reason,
            at: now,
          },
        },
      },
    };
  }

  if (data.action === "rerun_capture") {
    return {
      ok: true,
      value: {
        status: "pending",
        status_reason: reason,
        deterministic_review: {},
        capture_metadata: {},
        discovered_links: {},
        error: null,
        failed_at: null,
        processed_at: null,
        updated_at: now,
      },
    };
  }

  if (data.action === "rerun_ai_review") {
    return {
      ok: true,
      value: sourceIntakeAiReviewRetryPatch(currentStatus, actionContext, now, reason),
    };
  }

  return {
    ok: true,
    value: {
      status: "pending",
      status_reason: reason,
      error: null,
      failed_at: null,
      processed_at: null,
      updated_at: now,
    },
  };
}

function manualReason(action: string) {
  if (action === "retry") return "manual_retry_requested";
  if (action === "retry_reconciliation") return "manual_reconciliation_retry_requested";
  if (action === "reject") return "manual_reject_requested";
  if (action === "attach_to_award") return "manual_attach_to_existing_award_requested";
  if (action === "approve_backfill_source") return "manual_backfill_source_approved";
  if (action === "approve_as_new_award") return "manual_approve_as_new_award_requested";
  if (action === "rerun_capture") return "manual_rerun_capture_requested";
  if (action === "rerun_ai_review") return "manual_rerun_ai_review_requested";
  return "manual_source_intake_action";
}

async function validateAdminRequest() {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return {
      ok: false as const,
      response: NextResponse.json({ ok: false, error: "Admin source intake is not configured." }, { status: 503 }),
    };
  }

  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false as const,
      response: NextResponse.json({ ok: false, error: "Log in first." }, { status: 401 }),
    };
  }

  if (!isSiteAdminEmail(user.email)) {
    return {
      ok: false as const,
      response: NextResponse.json({ ok: false, error: "Only site admins can update source intake." }, { status: 403 }),
    };
  }

  return { ok: true as const, user };
}

function reportPrivateSourceIntakeError(stage: string, error: unknown) {
  console.error("[source-intake-admin] action failed", {
    stage,
    message: error instanceof Error ? error.message : String(error),
  });
}
