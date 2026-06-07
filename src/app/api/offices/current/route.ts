import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { officeCookieName, getMembershipForOffice, requireOfficeContext } from "@/lib/offices";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const switchOfficeSchema = z.object({
  officeId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120).optional(),
});

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const parsed = switchOfficeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid office update." }, { status: 400 });
  }

  const officeId = parsed.data.officeId || (await requireOfficeContext(user)).current.officeId;
  const membership = await getMembershipForOffice(user.id, officeId);
  if (!membership) {
    return NextResponse.json({ error: "Office was not found." }, { status: 404 });
  }

  if (parsed.data.name) {
    if (!["owner", "admin"].includes(membership.role)) {
      return NextResponse.json({ error: "Only owners and admins can rename an office." }, { status: 403 });
    }

    const admin = createSupabaseAdminClient();
    const { error } = await admin
      .from("offices")
      .update({ name: parsed.data.name, updated_at: new Date().toISOString() })
      .eq("id", officeId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  const cookieStore = await cookies();
  cookieStore.set(officeCookieName, officeId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  return NextResponse.json({ ok: true });
}
