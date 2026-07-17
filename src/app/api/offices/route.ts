import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Stage 1 is invite-only. Office membership is created only by the atomic
 * invitation-completion flow; an existing orphan Auth account must not be
 * able to bootstrap itself through a service-role route.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  return NextResponse.json(
    {
      error: "Self-service office creation is disabled during the invite-only beta.",
    },
    { status: 403 },
  );
}
