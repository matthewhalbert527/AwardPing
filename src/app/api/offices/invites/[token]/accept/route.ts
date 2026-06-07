import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { officeCookieName } from "@/lib/offices";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ token: string }>;
};

export async function POST(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user?.email) {
    return NextResponse.json({ error: "Log in or create an account first." }, { status: 401 });
  }

  const { token } = await params;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const admin = createSupabaseAdminClient();

  const { data: inviteByToken, error } = await admin
    .from("office_invites")
    .select("*")
    .eq("token_hash", tokenHash)
    .is("accepted_at", null)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: inviteByCode, error: codeError } = inviteByToken
    ? { data: null, error: null }
    : await admin
        .from("office_invites")
        .select("*")
        .eq("invite_code", token.toUpperCase())
        .is("accepted_at", null)
        .maybeSingle();

  if (codeError) {
    return NextResponse.json({ error: codeError.message }, { status: 500 });
  }

  const invite = inviteByToken || inviteByCode;

  if (!invite || new Date(invite.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: "This invitation is no longer valid." }, { status: 404 });
  }

  if (invite.email && invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return NextResponse.json(
      { error: "Log in with the email address this invitation was sent to." },
      { status: 403 },
    );
  }

  const { error: memberError } = await admin
    .from("office_members")
    .upsert(
      {
        office_id: invite.office_id,
        user_id: user.id,
        email: user.email,
        role: invite.role,
        notification_preference: "immediate",
        status: "active",
        joined_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "office_id,user_id" },
    );

  if (memberError) {
    return NextResponse.json({ error: memberError.message }, { status: 500 });
  }

  const { error: inviteError } = await admin
    .from("office_invites")
    .update({
      accepted_by: user.id,
      accepted_at: new Date().toISOString(),
    })
    .eq("id", invite.id);

  if (inviteError) {
    return NextResponse.json({ error: inviteError.message }, { status: 500 });
  }

  const response = NextResponse.json({ ok: true, officeId: invite.office_id });
  response.cookies.set(officeCookieName, invite.office_id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
