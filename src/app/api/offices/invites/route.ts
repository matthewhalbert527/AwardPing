import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { appConfig } from "@/lib/config";
import { sendOfficeInviteEmail } from "@/lib/email";
import { requireOfficeContext, requireOfficeRole } from "@/lib/offices";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const inviteSchema = z.object({
  email: z.string().trim().email().optional().or(z.literal("")),
  role: z.enum(["admin", "member"]).default("member"),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const parsed = inviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Choose an invitation role." }, { status: 400 });
  }

  const context = await requireOfficeContext(user);
  await requireOfficeRole(user.id, context.current.officeId, ["owner", "admin"]);

  const admin = createSupabaseAdminClient();
  const inviteToken = crypto.randomBytes(24).toString("base64url");
  const tokenHash = hashToken(inviteToken);
  const inviteCode = crypto.randomBytes(5).toString("hex").toUpperCase();
  const email = parsed.data.email ? parsed.data.email.toLowerCase() : null;

  const { data: invite, error } = await admin
    .from("office_invites")
    .insert({
      office_id: context.current.officeId,
      email,
      role: parsed.data.role,
      token_hash: tokenHash,
      invite_code: inviteCode,
      invited_by: user.id,
    })
    .select("*")
    .single();

  if (error || !invite) {
    return NextResponse.json(
      { error: error?.message || "Invitation could not be created." },
      { status: 500 },
    );
  }

  const inviteUrl = `${appConfig.url}/join/${invite.invite_code}`;
  if (email) {
    await sendOfficeInviteEmail({
      to: email,
      officeName: context.current.officeName,
      inviteUrl,
    });
  }

  return NextResponse.json({
    ok: true,
    inviteUrl,
    inviteCode: invite.invite_code,
    invite: {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      invite_code: invite.invite_code,
      expires_at: invite.expires_at,
    },
  });
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
