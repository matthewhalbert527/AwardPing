import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const actionSchema = z.object({
  action: z.enum([
    "retry",
    "reject",
    "attach_to_award",
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
  const setup = await validateAdminRequest();
  if (setup) return setup;

  const { id } = await context.params;
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Choose a valid source-intake action." }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const reason = parsed.data.reason || manualReason(parsed.data.action);
  const now = new Date().toISOString();
  const patch = patchForAction(parsed.data, reason, now);
  if (!patch.ok) {
    return NextResponse.json({ ok: false, error: patch.error }, { status: 400 });
  }

  const { data, error } = await admin
    .from("source_page_requests")
    .update(patch.value)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "Source intake request not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, request: data });
}

function patchForAction(
  data: z.infer<typeof actionSchema>,
  reason: string,
  now: string,
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
      value: {
        status: "ai_review_pending",
        status_reason: reason,
        ai_review: {},
        error: null,
        failed_at: null,
        processed_at: null,
        updated_at: now,
      },
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
  if (action === "reject") return "manual_reject_requested";
  if (action === "attach_to_award") return "manual_attach_to_existing_award_requested";
  if (action === "approve_as_new_award") return "manual_approve_as_new_award_requested";
  if (action === "rerun_capture") return "manual_rerun_capture_requested";
  if (action === "rerun_ai_review") return "manual_rerun_ai_review_requested";
  return "manual_source_intake_action";
}

async function validateAdminRequest() {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return NextResponse.json({ ok: false, error: "Admin source intake is not configured." }, { status: 503 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Log in first." }, { status: 401 });
  }

  if (!isSiteAdminEmail(user.email)) {
    return NextResponse.json({ ok: false, error: "Only site admins can update source intake." }, { status: 403 });
  }

  return null;
}
