import { type NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasSupabaseConfig } from "@/lib/config";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const tokenHash = requestUrl.searchParams.get("token_hash");
  const type = requestUrl.searchParams.get("type");
  const next = requestUrl.searchParams.get("next") || "/dashboard/onboarding";

  if (!hasSupabaseConfig() || !tokenHash || !type) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const supabase = await createSupabaseServerClient();
  await supabase.auth.verifyOtp({
    type: type as Parameters<typeof supabase.auth.verifyOtp>[0]["type"],
    token_hash: tokenHash,
  });

  return NextResponse.redirect(new URL(next, request.url));
}
