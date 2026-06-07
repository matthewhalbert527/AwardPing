import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import type { Database } from "@/lib/database.types";
import { getMembershipForOffice, requireOfficeRole } from "@/lib/offices";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

const memberUpdateSchema = z.object({
  role: z.enum(["admin", "member"]).optional(),
  notificationPreference: z.enum(["immediate", "daily_digest", "both", "none"]).optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const parsed = memberUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid member update." }, { status: 400 });
  }

  const { id } = await params;
  const admin = createSupabaseAdminClient();
  const { data: targetMember, error } = await admin
    .from("office_members")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!targetMember) {
    return NextResponse.json({ error: "Member was not found." }, { status: 404 });
  }

  const currentMember = await getMembershipForOffice(user.id, targetMember.office_id);
  if (!currentMember) {
    return NextResponse.json({ error: "Office was not found." }, { status: 404 });
  }

  const update: Database["public"]["Tables"]["office_members"]["Update"] = {
    updated_at: new Date().toISOString(),
  };

  if (parsed.data.notificationPreference) {
    if (targetMember.user_id !== user.id && !["owner", "admin"].includes(currentMember.role)) {
      return NextResponse.json({ error: "You cannot edit this notification setting." }, { status: 403 });
    }
    update.notification_preference = parsed.data.notificationPreference;
  }

  if (parsed.data.role) {
    await requireOfficeRole(user.id, targetMember.office_id, ["owner", "admin"]);
    if (targetMember.role === "owner") {
      return NextResponse.json({ error: "The office owner role cannot be changed here." }, { status: 403 });
    }
    update.role = parsed.data.role;
  }

  const { error: updateError } = await admin
    .from("office_members")
    .update(update)
    .eq("id", id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
