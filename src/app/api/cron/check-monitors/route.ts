import { NextResponse, type NextRequest } from "next/server";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import { finishJobRun, startJobRun } from "@/lib/job-runs";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization") || "";
  const secret = request.headers.get("x-cron-secret") || "";

  if (!appConfig.cronSecret || (auth !== `Bearer ${appConfig.cronSecret}` && secret !== appConfig.cronSecret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (!hasSupabaseAdminConfig()) {
    return NextResponse.json(
      { error: "Supabase service role is not configured." },
      { status: 503 },
    );
  }

  const runId = await startJobRun("check-monitors");
  await finishJobRun(runId, {
    status: "succeeded",
    processedCount: 0,
    metadata: {
      disabled: true,
      reason: "Legacy text monitor checks have been retired in favor of the local screenshot worker.",
    },
  });

  return NextResponse.json({
    ok: true,
    runId,
    checked: 0,
    disabled: true,
    reason: "Legacy text monitor checks have been retired in favor of the local screenshot worker.",
  });
}
