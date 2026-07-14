import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import {
  awardMonitoringPolicyIdentity,
  isAlertBlockingMonitoringPolicyFlag,
  monitoringPolicyFlagIdForAlias,
} from "@/lib/award-monitoring-policy";
import { validateSameOriginAdminMutation } from "@/lib/admin-request-security";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const promotionSchema = z
  .object({
    requestId: z.string().uuid(),
    feedbackId: z.string().uuid(),
    policyRuleId: z.string().trim().min(1).max(160),
    note: z.string().trim().max(1000).optional(),
  })
  .superRefine((value, context) => {
    if (!isAlertBlockingMonitoringPolicyFlag(value.policyRuleId)) {
      context.addIssue({
        code: "custom",
        message: "Choose a rule that is active and alert-blocking in the current policy.",
        path: ["policyRuleId"],
      });
    }
  });

export async function POST(request: Request) {
  const originError = validateSameOriginAdminMutation(request);
  if (originError) return originError;

  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return NextResponse.json(
      { ok: false, error: "Admin monitoring feedback is not configured." },
      { status: 503 },
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Log in first." },
      { status: 401 },
    );
  }

  if (!isSiteAdminEmail(user.email)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Only AwardPing site admins can resolve monitoring feedback.",
      },
      { status: 403 },
    );
  }

  const parsed = promotionSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error:
          parsed.error.issues[0]?.message ||
          "Choose the active rule that resolves this feedback.",
      },
      { status: 400 },
    );
  }

  const canonicalPolicyRuleId = monitoringPolicyFlagIdForAlias(
    parsed.data.policyRuleId,
  );
  if (!canonicalPolicyRuleId) {
    return NextResponse.json(
      { ok: false, error: "Choose a rule that is active and alert-blocking in the current policy." },
      { status: 400 },
    );
  }
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("record_monitoring_feedback_promotion", {
    p_request_id: parsed.data.requestId,
    p_feedback_id: parsed.data.feedbackId,
    p_actor_user_id: user.id,
    p_actor_email: user.email || "",
    p_policy_rule_id: canonicalPolicyRuleId,
    p_policy_identity: awardMonitoringPolicyIdentity.id,
    p_policy_version: awardMonitoringPolicyIdentity.version,
    p_policy_hash: awardMonitoringPolicyIdentity.hash,
    p_policy_config_version: awardMonitoringPolicyIdentity.policyVersion,
    p_decision_memory_version:
      awardMonitoringPolicyIdentity.decisionMemoryVersion,
    p_note: parsed.data.note || null,
  });

  if (error) {
    const message = error.message || "Monitoring feedback could not be resolved.";
    if (error.code === "P0002") {
      return NextResponse.json(
        { ok: false, error: "That monitoring feedback no longer exists." },
        { status: 404 },
      );
    }
    if (error.code === "P0001" || error.code === "23505") {
      return NextResponse.json(
        { ok: false, error: "That feedback has already been resolved." },
        { status: 409 },
      );
    }
    if (error.code === "22004" || error.code === "22023" || error.code === "23514") {
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }
    if (/record_monitoring_feedback_promotion|schema cache|PGRST202/i.test(message)) {
      return NextResponse.json(
        {
          ok: false,
          error: "Monitoring feedback promotion is not migrated yet.",
        },
        { status: 503 },
      );
    }
    console.error("Monitoring feedback promotion failed", {
      code: error.code,
      message,
    });
    return NextResponse.json(
      { ok: false, error: "Monitoring feedback could not be resolved." },
      { status: 500 },
    );
  }

  const result = data?.[0];
  if (!result) {
    return NextResponse.json(
      { ok: false, error: "The promotion transaction returned no result." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    promotionId: result.promotion_id,
    feedbackId: result.promoted_feedback_id,
    policyRuleId: result.active_policy_rule_id,
    promotedAt: result.promoted_at,
  });
}
