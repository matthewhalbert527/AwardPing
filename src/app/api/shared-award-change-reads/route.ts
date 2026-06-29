import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { markSharedChangesRead } from "@/lib/update-read-state";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication is required." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { changeIds?: unknown } | null;
  const changeIds = Array.isArray(body?.changeIds)
    ? body.changeIds.filter((id): id is string => typeof id === "string" && Boolean(id)).slice(0, 50)
    : [];

  if (changeIds.length === 0) {
    return NextResponse.json({ ok: true, read: 0 });
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("shared_award_change_events")
    .select("id, shared_award_id, shared_award_source_id, detected_at")
    .in("id", [...new Set(changeIds)]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await markSharedChangesRead(user.id, data || []);
  return NextResponse.json({ ok: true, read: data?.length || 0 });
}
