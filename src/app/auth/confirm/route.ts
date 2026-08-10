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
  const next = confirmationDestination(
    type,
    requestUrl.searchParams.get("next"),
  );

  if (!hasSupabaseConfig() || !tokenHash || !type) {
    return invalidConfirmationRedirect(requestUrl, type);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({
    type,
    token_hash: tokenHash,
  });
  if (error) return invalidConfirmationRedirect(requestUrl, type);

  return noStoreRedirect(new URL(next, requestUrl.origin));
}

function emailOtpType(value: string | null): EmailOtpType | null {
  return value && allowedEmailOtpTypes.has(value as EmailOtpType)
    ? (value as EmailOtpType)
    : null;
}

function confirmationDestination(
  type: EmailOtpType | null,
  value: string | null,
) {
  if (type !== "recovery") {
    return safeNextPath(value) || "/dashboard/onboarding";
  }

  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /\\|[\u0000-\u001f\u007f]/.test(value)
  ) {
    return "/reset-password";
  }

  const base = new URL("https://awardping.local");
  let parsed: URL;
  try {
    parsed = new URL(value, base);
  } catch {
    return "/reset-password";
  }
  if (
    parsed.origin !== base.origin ||
    parsed.pathname !== "/reset-password"
  ) {
    return "/reset-password";
  }

  const nestedNext = safeNextPath(parsed.searchParams.get("next"));
  if (!nestedNext) return "/reset-password";

  const resetPage = new URL("/reset-password", "https://awardping.local");
  resetPage.searchParams.set("next", nestedNext);
  return `${resetPage.pathname}${resetPage.search}`;
}

function invalidConfirmationRedirect(
  requestUrl: URL,
  type: EmailOtpType | null,
) {
  const path = type === "recovery"
    ? "/login?recovery=invalid"
    : "/login?confirmation=invalid";
  return noStoreRedirect(new URL(path, requestUrl.origin));
}

function noStoreRedirect(destination: URL) {
  const response = NextResponse.redirect(destination);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
