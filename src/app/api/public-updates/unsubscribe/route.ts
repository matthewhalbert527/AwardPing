import { NextResponse } from "next/server";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import { unsubscribePublicUpdateSubscriber } from "@/lib/public-updates";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!token || !hasSupabaseAdminConfig()) {
    return redirectToUpdates("unsubscribed=invalid");
  }

  const result = await unsubscribePublicUpdateSubscriber(token);
  if (result === "retry_active_send") {
    return redirectToUpdates("unsubscribed=retry");
  }
  return redirectToUpdates(
    result === "unsubscribed" ? "unsubscribed=1" : "unsubscribed=invalid",
  );
}

function redirectToUpdates(query: string) {
  return NextResponse.redirect(new URL(`/updates?${query}`, appConfig.url));
}
