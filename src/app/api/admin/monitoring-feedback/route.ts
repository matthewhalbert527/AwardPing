import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import {
  awardMonitoringPolicyIdentity,
  isAlertBlockingMonitoringPolicyFlag,
  monitoringPolicyFlagIdForAlias,
} from "@/lib/award-monitoring-policy";
import { awardDirectorySharedCatalogCacheTag } from "@/lib/cache-tags";
import { validateSameOriginAdminMutation } from "@/lib/admin-request-security";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import {
  monitoringFeedbackReasonCodes,
  monitoringFeedbackRequiresNote,
  monitoringFeedbackScopes,
} from "@/lib/monitoring-feedback";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const monitoringFeedbackSchema = z
  .object({
    requestId: z.string().uuid(),
    eventId: z.string().uuid(),
    reasonCode: z.enum(monitoringFeedbackReasonCodes),
    note: z.string().trim().max(1000).optional(),
    requestedScope: z.enum(monitoringFeedbackScopes).default("event"),
    policyRuleId: z.string().trim().max(160).optional(),
  })
  .superRefine((value, context) => {
    if (
      monitoringFeedbackRequiresNote(value.reasonCode, value.requestedScope) &&
      !value.note
    ) {
      context.addIssue({
        code: "custom",
        message: "Add a note describing the reusable pattern for this scope.",
        path: ["note"],
      });
    }

    if (
      value.policyRuleId &&
      !isAlertBlockingMonitoringPolicyFlag(value.policyRuleId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Choose an active alert-blocking monitoring rule.",
        path: ["policyRuleId"],
      });
    }
  });

export async function POST(request: Request) {
  const originError = validateSameOriginAdminMutation(request);
  if (originError) return originError;

  const setup = await validateAdminRequest();
  if (setup.response) return setup.response;

  const parsed = monitoringFeedbackSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error:
          parsed.error.issues[0]?.message ||
          "Choose a reason and requested review scope.",
      },
      { status: 400 },
    );
  }

  const canonicalPolicyRuleId = parsed.data.policyRuleId
    ? monitoringPolicyFlagIdForAlias(parsed.data.policyRuleId)
    : null;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("record_monitoring_false_positive", {
    p_request_id: parsed.data.requestId,
    p_event_id: parsed.data.eventId,
    p_actor_user_id: setup.user.id,
    p_actor_email: setup.user.email || "",
    p_reason_code: parsed.data.reasonCode,
    p_policy_identity: awardMonitoringPolicyIdentity.id,
    p_policy_version: awardMonitoringPolicyIdentity.version,
    p_policy_hash: awardMonitoringPolicyIdentity.hash,
    p_policy_config_version: awardMonitoringPolicyIdentity.policyVersion,
    p_decision_memory_version:
      awardMonitoringPolicyIdentity.decisionMemoryVersion,
    p_note: parsed.data.note || null,
    p_requested_scope: parsed.data.requestedScope,
    p_policy_rule_id: canonicalPolicyRuleId,
  });

  if (error) {
    return monitoringFeedbackErrorResponse(error);
  }

  const result = data?.[0];
  if (!result) {
    return NextResponse.json(
      { ok: false, error: "The feedback transaction returned no result." },
      { status: 500 },
    );
  }

  revalidateTag(awardDirectorySharedCatalogCacheTag, { expire: 0 });

  return NextResponse.json({
    ok: true,
    feedbackId: result.feedback_id,
    eventId: result.suppressed_event_id,
    suppressedAt: result.suppressed_at,
    reasonCode: result.recorded_reason_code,
    note: result.recorded_note,
    requestedScope: result.recorded_requested_scope,
    policyRuleId: result.recorded_policy_rule_id,
    promotionStatus: result.promotion_status,
    eventSummary: result.recorded_event_summary,
    eventSourceUrl: result.recorded_event_source_url,
    eventSourceTitle: result.recorded_event_source_title,
    eventSourcePageType: result.recorded_event_source_page_type,
    eventDetectedAt: result.recorded_event_detected_at,
    eventEvidence: result.recorded_event_evidence,
  });
}

async function validateAdminRequest() {
  if (!hasSupabaseConfig()) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Supabase is not configured." },
        { status: 503 },
      ),
      user: null,
    } as const;
  }

  if (!hasSupabaseAdminConfig()) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          error: "Supabase service-role access is not configured.",
        },
        { status: 503 },
      ),
      user: null,
    } as const;
  }

  const user = await getCurrentUser();
  if (!user) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Log in first." },
        { status: 401 },
      ),
      user: null,
    } as const;
  }

  if (!isSiteAdminEmail(user.email)) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          error: "Only AwardPing site admins can classify monitoring updates.",
        },
        { status: 403 },
      ),
      user,
    } as const;
  }

  return { response: null, user } as const;
}

function monitoringFeedbackErrorResponse(error: {
  code?: string;
  message?: string;
}) {
  const message = error.message || "Monitoring feedback could not be saved.";

  if (error.code === "P0002") {
    return NextResponse.json(
      { ok: false, error: "That monitoring event no longer exists." },
      { status: 404 },
    );
  }

  if (error.code === "P0001" && /already suppressed/i.test(message)) {
    return NextResponse.json(
      { ok: false, error: "That event has already been suppressed." },
      { status: 409 },
    );
  }

  if (error.code === "22004" || error.code === "22023" || error.code === "23514") {
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }

  if (/record_monitoring_false_positive|schema cache|PGRST202/i.test(message)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Monitoring feedback is not migrated for this deployment yet.",
      },
      { status: 503 },
    );
  }

  console.error("Monitoring feedback transaction failed", {
    code: error.code,
    message,
  });
  return NextResponse.json(
    { ok: false, error: "Monitoring feedback could not be saved." },
    { status: 500 },
  );
}
