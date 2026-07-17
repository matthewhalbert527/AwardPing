import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { personalDataLookupHash } from "@/lib/personal-data";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const deleteSchema = z.object({
  confirm: z.literal("DELETE"),
});

export async function POST(request: Request) {
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
    return NextResponse.json(
      { error: requestError?.message || "Deletion request could not be started." },
      { status: 500 },
    );
  }

  const errors = await deleteAppDataForUser(user.id, user.email || null, emailHash);
  if (errors.length) {
    await admin
      .from("privacy_requests")
      .update({
        status: "failed",
        details: { errors },
        completed_at: new Date().toISOString(),
      })
      .eq("id", requestRow.id);

    return NextResponse.json({ error: errors[0] }, { status: 500 });
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
  if (deleteError) {
    await admin
      .from("privacy_requests")
      .update({
        status: "failed",
        details: { errors: [deleteError.message] },
        completed_at: new Date().toISOString(),
      })
      .eq("id", requestRow.id);

    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  await admin
    .from("privacy_requests")
    .update({
      user_id: null,
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", requestRow.id);

  return NextResponse.json({ ok: true });
}

async function deleteAppDataForUser(
  userId: string,
  email: string | null,
  emailHash: string | null,
) {
  const admin = createSupabaseAdminClient();
  const results = await Promise.all([
    admin.from("source_page_requests").delete().eq("user_id", userId),
    admin.from("discovery_requests").delete().eq("user_id", userId),
    admin.from("alert_deliveries").delete().eq("user_id", userId),
    admin.from("shared_awards").update({ submitted_by_user_id: null }).eq("submitted_by_user_id", userId),
    admin
      .from("shared_award_sources")
      .update({ submitted_by_user_id: null })
      .eq("submitted_by_user_id", userId),
  ]);
  const errors = results
    .map((result) => result.error?.message)
    .filter((message): message is string => Boolean(message));

  if (emailHash || email) {
    const result = await admin.rpc("erase_public_update_subscriber", {
      p_email_hash: emailHash,
      p_legacy_email: email,
    });
    if (result.error) errors.push(result.error.message);
  }

  return errors;
}
