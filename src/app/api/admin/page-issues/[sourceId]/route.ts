import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Props = {
  params: Promise<{ sourceId: string }>;
};

const patchSchema = z.object({
  action: z.enum(["review_later", "restore"]),
  note: z.string().trim().max(500).optional(),
});

export async function PATCH(request: Request, { params }: Props) {
  const setupError = await validateAdminRequest();
  if (setupError.response) return setupError.response;

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid page issue action." }, { status: 400 });
  }

  const { sourceId } = await params;
  const admin = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const update =
    parsed.data.action === "review_later"
      ? {
          admin_review_status: "review_later" as const,
          admin_review_note: parsed.data.note || null,
          admin_reviewed_at: now,
          admin_reviewed_by: setupError.user?.email || null,
          updated_at: now,
        }
      : {
          admin_review_status: "open" as const,
          admin_review_note: null,
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
