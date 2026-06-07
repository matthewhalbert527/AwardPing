import { NextResponse, type NextRequest } from "next/server";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import { errorMessage, finishJobRun, startJobRun } from "@/lib/job-runs";
import { runDueMonitorChecks } from "@/lib/monitor-runner";

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

  let runId: string | null = null;
  try {
    runId = await startJobRun("check-monitors");
    const results = await runDueMonitorChecks();
    await finishJobRun(runId, {
      status: "succeeded",
      processedCount: results.length,
      metadata: { resultCount: results.length },
    });

    return NextResponse.json({ ok: true, runId, checked: results.length, results });
  } catch (error) {
    const message = errorMessage(error);
    if (runId) {
      await finishJobRun(runId, {
        status: "failed",
        processedCount: 0,
        error: message,
      }).catch(() => undefined);
    }

    return NextResponse.json({ ok: false, runId, error: message }, { status: 500 });
  }
}
