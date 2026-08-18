import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { explainSourceAiReviewStatus } from "@/lib/source-ai-review-status";
import {
  sourceMonitoringRestoreDecisionReason,
  sourceMonitoringRestoreMarker,
  sourceQualityDecision,
} from "@/lib/source-quality";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Props = {
  params: Promise<{ sourceId: string }>;
};

const patchSchema = z.object({
  action: z.enum(["review_later", "restore"]),
  note: z.string().trim().max(500).optional(),
});

type SharedSource = Database["public"]["Tables"]["shared_award_sources"]["Row"];

const sourceQualitySelect =
  "id,shared_award_id,url,title,display_title,page_description,page_metadata,page_metadata_generated_at,page_metadata_model,page_type,source,reason,submitted_by_user_id,admin_review_status,admin_review_note,admin_reviewed_at,admin_reviewed_by,last_checked_at,last_error,created_at,updated_at";

export async function PATCH(request: Request, { params }: Props) {
  const setupError = await validateAdminRequest();
  if (setupError.response) return setupError.response;

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid page issue action." }, { status: 400 });
  }

  const { sourceId } = await params;
  const admin = createSupabaseAdminClient();
  if (parsed.data.action === "restore") {
    return restoreMonitoringOnlySource(
      admin,
      sourceId,
      setupError.user?.email || "",
    );
  }

  const now = new Date().toISOString();
  const update = {
    admin_review_status: "review_later" as const,
    admin_review_note: parsed.data.note || null,
    admin_reviewed_at: now,
    admin_reviewed_by: setupError.user?.email || null,
    updated_at: now,
  };

  const { data, error } = await admin
    .from("shared_award_sources")
    .update(update)
    .eq("id", sourceId)
    .select("id")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "Source page was not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

async function restoreMonitoringOnlySource(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  sourceId: string,
  actor: string,
) {
  const { data: sourceData, error: lookupError } = await admin
    .from("shared_award_sources")
    .select(sourceQualitySelect)
    .eq("id", sourceId)
    .maybeSingle();
  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }
  if (!sourceData) {
    return NextResponse.json({ error: "Source page was not found." }, { status: 404 });
  }

  const source = sourceData as SharedSource;
  const aiReview = explainSourceAiReviewStatus(source);
  if (
    source.admin_review_status !== "review_later" ||
    aiReview.status !== "reviewed_unclear_needs_manual_review"
  ) {
    const monitoring = sourceQualityDecision(
      { ...source, admin_review_status: "open" },
      { purpose: "monitoring" },
    );
    return monitoringRestoreConflict(aiReview.status, monitoring.reason);
  }

  const now = new Date().toISOString();
  const note = `${sourceMonitoringRestoreMarker}: Explicitly restored by a site admin for monitoring only; public facts and updates remain unapproved.`;
  const update = {
    admin_review_status: "open" as const,
    admin_review_note: note,
    admin_reviewed_at: now,
    admin_reviewed_by: actor,
    updated_at: now,
  };
  const prospectiveDecision = sourceQualityDecision(
    { ...source, ...update },
    { purpose: "monitoring" },
  );
  if (
    !prospectiveDecision.allowed ||
    prospectiveDecision.reason !== sourceMonitoringRestoreDecisionReason
  ) {
    return monitoringRestoreConflict(aiReview.status, prospectiveDecision.reason);
  }

  let mutation = admin
    .from("shared_award_sources")
    .update(update)
    .eq("id", sourceId)
    .eq("admin_review_status", "review_later")
    .eq("updated_at", source.updated_at);
  mutation = source.admin_reviewed_at === null
    ? mutation.is("admin_reviewed_at", null)
    : mutation.eq("admin_reviewed_at", source.admin_reviewed_at);
  mutation = source.admin_review_note === null
    ? mutation.is("admin_review_note", null)
    : mutation.eq("admin_review_note", source.admin_review_note);
  mutation = source.admin_reviewed_by === null
    ? mutation.is("admin_reviewed_by", null)
    : mutation.eq("admin_reviewed_by", source.admin_reviewed_by);

  const { data: restoredData, error: restoreError } = await mutation
    .select(sourceQualitySelect)
    .maybeSingle();
  if (restoreError) {
    return NextResponse.json({ error: restoreError.message }, { status: 500 });
  }
  if (!restoredData) {
    return NextResponse.json(
      {
        error:
          "Monitoring was not restored because this source changed after the page loaded. Refresh and review its latest evidence.",
      },
      { status: 409 },
    );
  }

  const monitoring = sourceQualityDecision(restoredData as SharedSource, {
    purpose: "monitoring",
  });
  if (!monitoring.allowed || monitoring.reason !== sourceMonitoringRestoreDecisionReason) {
    return NextResponse.json(
      {
        error:
          "The source was updated, but its latest evidence still does not permit monitoring. Keep it under operator review.",
        monitoring: { allowed: monitoring.allowed, reason: monitoring.reason },
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    action: "restore",
    message:
      "Monitoring restored. Capture checks can resume; public facts and public updates remain unapproved.",
    monitoring: { allowed: true, reason: monitoring.reason },
    publicFactsApproved: false,
    publicUpdatesApproved: false,
    reviewedAt: restoredData.admin_reviewed_at,
  });
}

function monitoringRestoreConflict(aiReviewStatus: string, reason: string) {
  return NextResponse.json(
    {
      error:
        "Monitoring was not restored. This action is limited to an official source whose latest AI review is unclear and requires operator judgment.",
      aiReviewStatus,
      monitoring: { allowed: false, reason },
    },
    { status: 409 },
  );
}

export async function DELETE(_request: Request, { params }: Props) {
  const setupError = await validateAdminRequest();
  if (setupError.response) return setupError.response;

  const { sourceId } = await params;
  const admin = createSupabaseAdminClient();
  const { data: source, error: lookupError } = await admin
    .from("shared_award_sources")
    .select("id")
    .eq("id", sourceId)
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }

  if (!source) {
    return NextResponse.json({ error: "Source page was not found." }, { status: 404 });
  }

  const { data, error } = await admin.rpc("retire_shared_award_source_preserving_visual_history", {
    p_source_id: source.id,
    p_reason: "Retired from the Action Inbox; immutable update and visual history were preserved.",
    p_actor: setupError.user?.email || "awardping-admin-page-issues",
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const retirement = Array.isArray(data) ? data[0] : data;
  if (!retirement?.source_id) {
    return NextResponse.json({ error: "Source retirement did not return a durable result." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, retired: true, retirement });
}

async function validateAdminRequest() {
  if (!hasSupabaseConfig()) {
    return {
      response: NextResponse.json({ error: "Supabase is not configured." }, { status: 503 }),
      user: null,
    };
  }

  if (!hasSupabaseAdminConfig()) {
    return {
      response: NextResponse.json({ error: "Supabase service-role access is not configured." }, { status: 503 }),
      user: null,
    };
  }

  const user = await getCurrentUser();
  if (!user) {
    return {
      response: NextResponse.json({ error: "Log in first." }, { status: 401 }),
      user: null,
    };
  }

  if (!isSiteAdminEmail(user.email)) {
    return {
      response: NextResponse.json({ error: "Only AwardPing site admins can change page issues." }, { status: 403 }),
      user,
    };
  }

  return { response: null, user };
}
