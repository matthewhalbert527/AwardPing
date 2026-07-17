import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { appConfig } from "@/lib/config";
import { sendOfficeInviteEmail } from "@/lib/email";
import { requireOfficeContext, requireOfficeRole } from "@/lib/offices";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";

export const runtime = "nodejs";

const inviteSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(["admin", "member"]).default("member"),
});

export async function POST(request: Request) {
  if (!isSameOriginMutationRequest(request)) {
    return NextResponse.json({ error: "This request is not allowed." }, { status: 403 });
  }
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const parsed = inviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid invitation email and role." }, { status: 400 });
  }

  const context = await requireOfficeContext(user);
  await requireOfficeRole(user.id, context.current.officeId, ["owner", "admin"]);

  const admin = createSupabaseAdminClient();
  const inviteToken = crypto.randomBytes(24).toString("base64url");
  const tokenHash = hashToken(inviteToken);
  const inviteCode = crypto.randomBytes(16).toString("hex").toUpperCase();
  const email = parsed.data.email.toLowerCase();

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
    console.error("Office invitation creation failed", error);
    return NextResponse.json(
      { error: "Invitation could not be created." },
      { status: 500 },
    );
  }

  const inviteUrl = `${appConfig.url}/join/${inviteToken}`;
  let deliveryStatus: "sent" | "not_configured" | "failed" = "not_configured";
  try {
    const delivery = await sendOfficeInviteEmail({
      to: email,
      officeName: context.current.officeName,
      inviteUrl,
    });
    deliveryStatus =
      "skipped" in delivery && delivery.skipped
        ? "not_configured"
        : "error" in delivery && delivery.error
          ? "failed"
          : "sent";
  } catch (deliveryError) {
    console.error("Office invitation email failed", deliveryError);
    deliveryStatus = "failed";
  }

  return NextResponse.json({
    ok: true,
    inviteUrl,
    inviteCode: invite.invite_code,
    deliveryStatus,
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
