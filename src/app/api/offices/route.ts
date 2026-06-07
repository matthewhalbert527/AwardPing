import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { officeCookieName } from "@/lib/offices";
import { normalizedLookupName, normalizeOrganizationName } from "@/lib/organizations";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const createOfficeSchema = z.object({
  name: z.string().trim().min(2).max(140),
  organizationId: z.string().uuid().optional(),
  organizationName: z.string().trim().min(2).max(160).optional(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const parsed = createOfficeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter an office name." }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  let organizationId = parsed.data.organizationId || null;

  if (!organizationId && parsed.data.organizationName) {
    const organizationName = normalizeOrganizationName(parsed.data.organizationName);
    const normalizedName = normalizedLookupName(organizationName);
    const { data: existingOrganization, error: lookupError } = await admin
      .from("organizations")
      .select("id")
      .eq("normalized_name", normalizedName)
      .maybeSingle();

    if (lookupError) {
      return NextResponse.json({ error: lookupError.message }, { status: 500 });
    }

    if (existingOrganization) {
      organizationId = existingOrganization.id;
    } else {
      const { data: organization, error: organizationError } = await admin
        .from("organizations")
        .insert({
          name: organizationName,
          normalized_name: normalizedName,
          source: "user",
          created_by: user.id,
          updated_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (organizationError || !organization) {
        return NextResponse.json(
          { error: organizationError?.message || "Organization could not be saved." },
          { status: 500 },
        );
      }

      organizationId = organization.id;
    }
  }

  const { data: office, error: officeError } = await admin
    .from("offices")
    .insert({
      name: parsed.data.name,
      organization_id: organizationId,
      created_by: user.id,
    })
    .select("*")
    .single();

  if (officeError || !office) {
    return NextResponse.json(
      { error: officeError?.message || "Office could not be created." },
      { status: 500 },
    );
  }

  const { error: memberError } = await admin.from("office_members").insert({
    office_id: office.id,
    user_id: user.id,
    email: user.email || null,
    role: "owner",
    notification_preference: "immediate",
    status: "active",
  });

  if (memberError) {
    await admin.from("offices").delete().eq("id", office.id);
    return NextResponse.json({ error: memberError.message }, { status: 500 });
  }

  const { error: seedError } = await admin.rpc("seed_default_awards_for_office", {
    target_office_id: office.id,
    target_user_id: user.id,
  });

  if (seedError) {
    await admin.from("offices").delete().eq("id", office.id);
    return NextResponse.json({ error: seedError.message }, { status: 500 });
  }

  const response = NextResponse.json({ ok: true, office });
  response.cookies.set(officeCookieName, office.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
