import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { encryptedProfileFields } from "@/lib/personal-data";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const profileSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  organization: z.string().trim().min(2).max(160),
});

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const parsed = profileSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter your name and organization." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const { data: profile, error } = await admin
    .from("profiles")
    .upsert(
      {
        id: user.id,
        email: user.email || null,
        ...encryptedProfileFields({
          email: user.email,
          fullName: parsed.data.fullName,
          organization: parsed.data.organization,
        }),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    )
    .select("*")
    .single();

  if (error || !profile) {
    return NextResponse.json(
      { error: error?.message || "Profile could not be saved." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, profile });
}
