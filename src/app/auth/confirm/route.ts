import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasSupabaseConfig } from "@/lib/config";
import { safeNextPath } from "@/lib/safe-next-path";

const allowedEmailOtpTypes = new Set<EmailOtpType>([
  "email",
  "email_change",
  "invite",
  "magiclink",
  "recovery",
  "signup",
]);

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const tokenHash = requestUrl.searchParams.get("token_hash");
  const type = emailOtpType(requestUrl.searchParams.get("type"));
  const next = safeNextPath(requestUrl.searchParams.get("next")) ||
    "/dashboard/onboarding";

  if (!hasSupabaseConfig() || !tokenHash || !type) {
    return invalidConfirmationRedirect(requestUrl);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({
    type,
    token_hash: tokenHash,
  });
  if (error) return invalidConfirmationRedirect(requestUrl);

  return NextResponse.redirect(new URL(next, requestUrl.origin));
}

function emailOtpType(value: string | null): EmailOtpType | null {
  return value && allowedEmailOtpTypes.has(value as EmailOtpType)
    ? (value as EmailOtpType)
    : null;
}

function invalidConfirmationRedirect(requestUrl: URL) {
  return NextResponse.redirect(
    new URL("/login?confirmation=invalid", requestUrl.origin),
  );
}
