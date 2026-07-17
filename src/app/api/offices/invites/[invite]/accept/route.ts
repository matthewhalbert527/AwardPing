import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { officeCookieName } from "@/lib/offices";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ invite: string }>;
};

export async function POST(request: Request, { params }: Params) {
  if (!isSameOriginMutationRequest(request)) {
    return NextResponse.json({ error: "This request is not allowed." }, { status: 403 });
  }
  const user = await getCurrentUser();
  if (!user?.email) {
    return NextResponse.json({ error: "Log in or create an account first." }, { status: 401 });
  }

  const { invite } = await params;
  const cleanToken = invite.trim();
  if (
    cleanToken.length < 8 ||
    cleanToken.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(cleanToken)
  ) {
    return unavailableInvite();
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("accept_office_invite_for_user", {
    p_invite_secret: cleanToken,
    p_normalized_email: user.email.trim().toLowerCase(),
    p_user_id: user.id,
  });

  if (error || !data?.[0]) {
    if (error) {
      console.error("[office-invite] atomic acceptance failed", {
        code: error.code,
        message: error.message,
      });
    }
    return unavailableInvite();
  }

  const response = NextResponse.json({ ok: true, officeId: data[0].office_id });
  response.cookies.set(officeCookieName, data[0].office_id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}

function unavailableInvite() {
  return NextResponse.json(
    { error: "This invitation is unavailable." },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}
