import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { personalDataLookupHash } from "@/lib/personal-data";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const deleteSchema = z.object({
  confirm: z.literal("DELETE"),
});

const APP_ERASURE_MARKER_SCHEMA = "privacy-app-data-erasure-v1";

type AppErasureMarker = {
  schema_version: typeof APP_ERASURE_MARKER_SCHEMA;
  state: "completed";
  privacy_request_id: string;
  user_id: string;
  email_hash: string | null;
  completed_at: string;
  evidence_hash: string;
};

type AppErasureOutcome =
  | { state: "completed"; marker: AppErasureMarker }
  | { state: "failed"; conflict: boolean; diagnostic: string }
  | { state: "unknown"; diagnostic: string };

type AuthDeletionOutcome =
  | { state: "deleted" }
  | { state: "present"; diagnostic: string }
  | { state: "unknown"; diagnostic: string };

export async function POST(request: Request) {
  if (!isSameOriginMutationRequest(request)) {
    return NextResponse.json(
      { error: "This request is not allowed." },
      { status: 403 },
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Type DELETE to confirm account deletion." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const emailHash = user.email ? personalDataLookupHash(user.email) : null;
  const { data: requestRow, error: requestError } = await admin
    .from("privacy_requests")
    .insert({
      user_id: user.id,
      email_hash: emailHash,
      request_type: "delete",
      status: "pending",
    })
    .select("id")
    .single();

  if (requestError || !requestRow) {
    reportPrivatePrivacyDeleteError(
      "create_request",
      requestError?.message || "Privacy request insert returned no row.",
    );
    return NextResponse.json(
      { error: "Deletion request could not be started." },
      { status: 500 },
    );
  }

  const appErasure = await deleteAppDataForUser(
    admin,
    user.id,
    user.email || null,
    emailHash,
    requestRow.id,
  );
  if (appErasure.state !== "completed") {
    reportPrivatePrivacyDeleteError("erase_application_data", appErasure.diagnostic);
    const reconciliationRequired = appErasure.state === "unknown";
    const recorded = await recordPrivacyRequestFailure(admin, requestRow.id, {
      failureCode: reconciliationRequired
        ? "app_data_erasure_outcome_unknown"
        : appErasure.conflict
          ? "app_data_erasure_conflict"
          : "app_data_erasure_failed",
      appErasureState: appErasure.state === "unknown" ? "unknown" : "rolled_back",
      authDeletionState: "not_started",
      reconciliationRequired,
    });
    if (reconciliationRequired) {
      return NextResponse.json(
        {
          ok: false,
          deletionStatus: "reconciliation_required",
          auditStatus: recorded ? "failure_recorded" : "recording_failed",
          warning:
            "AwardPing could not confirm whether application-data erasure completed. Auth deletion was not started, and an operator must reconcile the request.",
        },
        { status: 202 },
      );
    }
    return NextResponse.json(
      {
        error: appErasure.conflict
          ? "Account deletion is temporarily blocked while retained privacy evidence or an active delivery is reconciled."
          : "Account deletion could not be completed.",
        ...(appErasure.conflict ? { code: "privacy_erasure_conflict" } : {}),
      },
      { status: appErasure.conflict ? 409 : 500 },
    );
  }

  const authDeletion = await deleteAuthUserAndReconcile(admin, user.id);
  if (authDeletion.state !== "deleted") {
    reportPrivatePrivacyDeleteError("delete_auth_user", authDeletion.diagnostic);
    const reconciliationRequired = authDeletion.state === "unknown";
    const recorded = await recordPrivacyRequestFailure(admin, requestRow.id, {
      failureCode: reconciliationRequired
        ? "auth_deletion_outcome_unknown"
        : "auth_deletion_failed_user_present",
      appErasureState: "completed",
      authDeletionState: authDeletion.state,
      reconciliationRequired,
      appErasureMarker: appErasure.marker,
    });
    if (reconciliationRequired) {
      return NextResponse.json(
        {
          ok: false,
          deletionStatus: "reconciliation_required",
          auditStatus: recorded ? "failure_recorded" : "recording_failed",
          warning:
            "Application data was erased, but AwardPing could not confirm the Auth deletion outcome. An operator must reconcile the request.",
        },
        { status: 202 },
      );
    }
    return NextResponse.json(
      { error: "Application data was erased, but the account could not be deleted." },
      { status: 500 },
    );
  }

  let completionError: string | null = null;
  try {
    const completion = await admin
      .from("privacy_requests")
      .update({
        user_id: null,
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", requestRow.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    completionError = completion.error?.message ||
      (completion.data ? null : "Privacy completion CAS did not update its pending request.");
  } catch (error) {
    completionError = errorMessage(error);
  }

  if (completionError) {
    const reconciledRequest = await readPrivacyRequestState(admin, requestRow.id);
    if (reconciledRequest.state === "read" && reconciledRequest.status === "completed") {
      return NextResponse.json({
        ok: true,
        deletionCompleted: true,
        auditStatus: "completion_confirmed_after_ambiguous_response",
      });
    }
    reportPrivatePrivacyDeleteError("complete_request", completionError);
    const driftRecorded = await recordPrivacyRequestFailure(admin, requestRow.id, {
      failureCode: "audit_completion_failed_after_auth_deletion",
      appErasureState: "completed",
      authDeletionState: "deleted",
      reconciliationRequired: true,
      appErasureMarker: appErasure.marker,
    });
    return NextResponse.json(
      {
        ok: true,
        deletionCompleted: true,
        auditStatus: driftRecorded
          ? "completion_failed_recorded"
          : "completion_unrecorded",
        warning:
          "The account was deleted, but the privacy audit completion record needs operator reconciliation.",
      },
      { status: 202 },
    );
  }

  return NextResponse.json({ ok: true });
}

async function deleteAppDataForUser(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
  email: string | null,
  emailHash: string | null,
  privacyRequestId: string,
): Promise<AppErasureOutcome> {
  let diagnostic = "Application-data erasure returned no completion marker.";
  let definiteFailure = false;
  let conflict = false;
  try {
    const result = await admin.rpc("erase_personal_data_for_privacy_request", {
      p_user_id: userId,
      p_email_hash: emailHash,
      p_legacy_email: email,
      p_privacy_request_id: privacyRequestId,
    });
    if (!result.error) {
      const marker = parseAppErasureMarker(
        objectValue(result.data).app_data_erasure_marker,
        privacyRequestId,
        userId,
        emailHash,
      );
      if (marker) return { state: "completed", marker };
    } else {
      diagnostic = result.error.message;
      definiteFailure = Boolean(result.error.code);
      conflict = isPrivacyErasureConflict(result.error.code, result.error.message);
    }
  } catch (error) {
    diagnostic = errorMessage(error);
  }

  const persisted = await readPrivacyRequestState(admin, privacyRequestId);
  if (persisted.state === "read") {
    const marker = parseAppErasureMarker(
      objectValue(persisted.details).app_data_erasure,
      privacyRequestId,
      userId,
      emailHash,
    );
    if (marker) return { state: "completed", marker };
  }
  if (definiteFailure) {
    return { state: "failed", conflict, diagnostic };
  }
  return { state: "unknown", diagnostic };
}

async function recordPrivacyRequestFailure(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  requestId: string,
  {
    failureCode,
    appErasureState,
    authDeletionState,
    reconciliationRequired,
    appErasureMarker,
  }: {
    failureCode: string;
    appErasureState: "rolled_back" | "completed" | "unknown";
    authDeletionState: "not_started" | "present" | "deleted" | "unknown";
    reconciliationRequired: boolean;
    appErasureMarker?: AppErasureMarker;
  },
) {
  try {
    const result = await admin
      .from("privacy_requests")
      .update({
        ...(authDeletionState === "deleted" ? { user_id: null } : {}),
        status: "failed",
        details: {
          failure_code: failureCode,
          app_data_erasure_state: appErasureState,
          auth_deletion_state: authDeletionState,
          audit_reconciliation_required: reconciliationRequired,
          ...(appErasureMarker
            ? { app_data_erasure: appErasureMarker }
            : {}),
        },
        completed_at: new Date().toISOString(),
      })
      .eq("id", requestId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (result.error || !result.data) {
      reportPrivatePrivacyDeleteError(
        "record_request_failure",
        result.error?.message || "Privacy failure audit CAS returned no row.",
      );
      return false;
    }
    return true;
  } catch (error) {
    reportPrivatePrivacyDeleteError("record_request_failure", error);
    return false;
  }
}

async function readPrivacyRequestState(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  requestId: string,
): Promise<
  | { state: "read"; status: string; details: unknown }
  | { state: "unavailable" }
> {
  try {
    const result = await admin
      .from("privacy_requests")
      .select("status,details")
      .eq("id", requestId)
      .maybeSingle();
    if (result.error || !result.data) {
      reportPrivatePrivacyDeleteError(
        "read_request_state",
        result.error?.message || "Privacy request state read returned no row.",
      );
      return { state: "unavailable" };
    }
    return {
      state: "read",
      status: result.data.status,
      details: result.data.details,
    };
  } catch (error) {
    reportPrivatePrivacyDeleteError("read_request_state", error);
    return { state: "unavailable" };
  }
}

async function deleteAuthUserAndReconcile(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
): Promise<AuthDeletionOutcome> {
  let diagnostic = "Auth deletion returned an error.";
  try {
    const result = await admin.auth.admin.deleteUser(userId);
    if (!result.error) return { state: "deleted" };
    diagnostic = result.error.message;
  } catch (error) {
    diagnostic = errorMessage(error);
  }

  try {
    const reconciliation = await admin.auth.admin.getUserById(userId);
    if (reconciliation.error) {
      if (isAuthUserNotFound(reconciliation.error)) return { state: "deleted" };
      return {
        state: "unknown",
        diagnostic: `${diagnostic}; Auth reconciliation failed: ${reconciliation.error.message}`,
      };
    }
    return reconciliation.data?.user
      ? { state: "present", diagnostic }
      : { state: "deleted" };
  } catch (error) {
    return {
      state: "unknown",
      diagnostic: `${diagnostic}; Auth reconciliation failed: ${errorMessage(error)}`,
    };
  }
}

function parseAppErasureMarker(
  value: unknown,
  privacyRequestId: string,
  userId: string,
  emailHash: string | null,
): AppErasureMarker | null {
  const marker = objectValue(value);
  if (
    marker.schema_version !== APP_ERASURE_MARKER_SCHEMA ||
    marker.state !== "completed" ||
    marker.privacy_request_id !== privacyRequestId ||
    marker.user_id !== userId ||
    marker.email_hash !== emailHash ||
    (marker.email_hash !== null && typeof marker.email_hash !== "string") ||
    typeof marker.completed_at !== "string" ||
    !Number.isFinite(Date.parse(marker.completed_at)) ||
    typeof marker.evidence_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(marker.evidence_hash) ||
    marker.evidence_hash !== appErasureMarkerEvidenceHash({
      schemaVersion: marker.schema_version,
      state: marker.state,
      privacyRequestId: marker.privacy_request_id,
      userId: marker.user_id,
      emailHash: marker.email_hash,
      completedAt: marker.completed_at,
    })
  ) {
    return null;
  }
  return marker as AppErasureMarker;
}

function appErasureMarkerEvidenceHash({
  schemaVersion,
  state,
  privacyRequestId,
  userId,
  emailHash,
  completedAt,
}: {
  schemaVersion: string;
  state: string;
  privacyRequestId: string;
  userId: string;
  emailHash: string | null;
  completedAt: string;
}) {
  const basis = [
    schemaVersion,
    state,
    privacyRequestId,
    userId,
    emailHash ?? "<null>",
    completedAt,
  ].join("|");
  return createHash("sha256").update(basis, "utf8").digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "An unexpected deletion error occurred.";
}

function isPrivacyErasureConflict(code: string | undefined, message: string) {
  return code === "40001"
    || code === "55000"
    || message.startsWith("legacy_contact_identity_unavailable")
    || message.startsWith("legacy_contact_erasure_incomplete");
}

function isAuthUserNotFound(error: { message: string; status?: number; code?: string }) {
  return error.status === 404 || error.code === "user_not_found" ||
    /user\s+not\s+found/i.test(error.message);
}

function reportPrivatePrivacyDeleteError(stage: string, error: unknown) {
  console.error("[privacy-delete] operation failed", {
    stage,
    message: errorMessage(error),
  });
}
