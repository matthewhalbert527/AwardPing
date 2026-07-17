import { NextResponse, type NextRequest } from "next/server";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import type { Json } from "@/lib/database.types";
import { errorMessage, finishJobRun, startJobRun } from "@/lib/job-runs";
import { runPublicUpdateDigestDeliveries } from "@/lib/public-updates";

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
    runId = await startJobRun("send-digests");
    const publicResult = await runPublicUpdateDigestDeliveries();
    const processedCount = publicResult.sent + publicResult.failed;
    const publicDigestMetadata = JSON.parse(JSON.stringify(publicResult)) as Json;
    await finishJobRun(runId, {
      status: publicResult.failed > 0 ? "failed" : "succeeded",
      processedCount,
      error:
        publicResult.failed > 0
          ? `${publicResult.failed} public digest delivery attempt(s) became terminal.`
          : null,
      metadata: {
        legacyOfficeTextDigestsDisabled: true,
        publicDigest: publicDigestMetadata,
      },
    });

    return NextResponse.json({
      ok: publicResult.failed === 0,
      runId,
      delivered: processedCount,
      publicResult,
    }, { status: publicResult.failed > 0 ? 500 : 200 });
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
