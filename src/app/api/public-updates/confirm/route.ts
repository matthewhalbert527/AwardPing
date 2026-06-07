import { NextResponse } from "next/server";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import { confirmPublicUpdateSubscription } from "@/lib/public-updates";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!token || !hasSupabaseAdminConfig()) {
    return redirectToUpdates("confirmed=invalid");
  }

  const confirmed = await confirmPublicUpdateSubscription(token);
  return redirectToUpdates(confirmed ? "confirmed=1" : "confirmed=invalid");
}

function redirectToUpdates(query: string) {
  return NextResponse.redirect(new URL(`/updates?${query}`, appConfig.url));
}
