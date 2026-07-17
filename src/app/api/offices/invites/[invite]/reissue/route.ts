import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { appConfig } from "@/lib/config";
import { sendOfficeInviteEmail } from "@/lib/email";
import { requireOfficeContext, requireOfficeRole } from "@/lib/offices";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Props = {
  params: Promise<{ invite: string }>;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: Props) {
  if (!isSameOriginMutationRequest(request)) {
    return NextResponse.json({ error: "This request is not allowed." }, { status: 403 });
  }

  const { invite: inviteId } = await params;
  if (!uuidPattern.test(inviteId)) {
    return NextResponse.json({ error: "Invitation was not found." }, { status: 404 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const context = await requireOfficeContext(user);
  await requireOfficeRole(user.id, context.current.officeId, ["owner", "admin"]);

  const inviteToken = crypto.randomBytes(24).toString("base64url");
  const inviteCode = crypto.randomBytes(16).toString("hex").toUpperCase();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("prepare_office_invite_security_reissue", {
    p_invite_id: inviteId,
    p_office_id: context.current.officeId,
    p_token_hash: hashToken(inviteToken),
    p_invite_code: inviteCode,
    p_expires_at: expiresAt,
    p_reissued_by: user.id,
  });
  const prepared = data?.[0];

  if (error || !prepared) {
    console.error("Office invitation security reissue preparation failed", error);
    return NextResponse.json({ error: "Invitation was not found or no longer needs reissue." }, { status: 404 });
  }

  const inviteUrl = `${appConfig.url}/join/${inviteToken}`;
  let deliveryStatus: "sent" | "not_configured" | "failed" = "not_configured";
  let deliveryError: string | null = null;
  try {
    const delivery = await sendOfficeInviteEmail({
      to: prepared.invite_email,
      officeName: prepared.office_name,
      inviteUrl,
    });
    deliveryStatus =
      "skipped" in delivery && delivery.skipped
        ? "not_configured"
        : "error" in delivery && delivery.error
          ? "failed"
          : "sent";
    deliveryError = "error" in delivery && delivery.error
      ? "Invitation email provider returned a failure."
      : null;
  } catch (errorValue) {
    console.error("Office invitation security reissue email failed", errorValue);
    deliveryStatus = "failed";
    deliveryError = "Invitation email delivery failed.";
  }

  const deliveryRecord = await admin.rpc(
    "record_office_invite_security_reissue_delivery",
    {
      p_invite_id: inviteId,
      p_reissued_by: user.id,
      p_delivery_status: deliveryStatus,
      p_error: deliveryError,
    },
  );
  if (deliveryRecord.error || !deliveryRecord.data) {
    console.error(
      "Office invitation security reissue delivery status was not recorded",
      deliveryRecord.error,
    );
  }

  return NextResponse.json({
    ok: true,
    inviteUrl,
    inviteCode,
    expiresAt,
    deliveryStatus,
    registryUpdated: Boolean(deliveryRecord.data && !deliveryRecord.error),
  });
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
