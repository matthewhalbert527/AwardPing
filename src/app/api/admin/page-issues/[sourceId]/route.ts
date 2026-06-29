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
    .select("id, shared_award_id, url")
    .eq("id", sourceId)
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }

  if (!source) {
    return NextResponse.json({ error: "Source page was not found." }, { status: 404 });
  }

  const errors: string[] = [];
  await deleteById(admin, "shared_award_change_events", source.id, errors);
  await deleteByAwardAndUrl(admin, "shared_award_change_events", source.shared_award_id, source.url, errors);
  await deleteById(admin, "shared_award_source_snapshots", source.id, errors);
  await deleteByAwardAndUrl(admin, "shared_award_source_snapshots", source.shared_award_id, source.url, errors);
  await deleteById(admin, "shared_award_source_visual_snapshots", source.id, errors, "shared_award_source_id");
  await deleteById(admin, "monitors", source.id, errors);
  await deleteById(admin, "award_sources", source.id, errors);

  const { error: homepageError } = await admin
    .from("shared_awards")
    .update({ official_homepage: null, updated_at: new Date().toISOString() })
    .eq("id", source.shared_award_id)
    .eq("official_homepage", source.url);
  if (homepageError) errors.push(homepageError.message);

  const { error: sourceError } = await admin
    .from("shared_award_sources")
    .delete()
    .eq("id", source.id);
  if (sourceError) errors.push(sourceError.message);

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(" ") }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
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

async function deleteById(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  table:
    | "shared_award_change_events"
    | "shared_award_source_snapshots"
    | "shared_award_source_visual_snapshots"
    | "monitors"
    | "award_sources",
  sourceId: string,
  errors: string[],
  column = "shared_award_source_id",
) {
  const { error } = await admin.from(table).delete().eq(column, sourceId);
  if (error) errors.push(error.message);
}

async function deleteByAwardAndUrl(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  table: "shared_award_change_events" | "shared_award_source_snapshots",
  sharedAwardId: string,
  sourceUrl: string,
  errors: string[],
) {
  const { error } = await admin
    .from(table)
    .delete()
    .eq("shared_award_id", sharedAwardId)
    .eq("source_url", sourceUrl);
  if (error) errors.push(error.message);
}
