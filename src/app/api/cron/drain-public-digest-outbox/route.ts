import { NextResponse, type NextRequest } from "next/server";
import {
  appConfig,
  hasPublicUpdateTokenConfig,
  hasSupabaseAdminConfig,
} from "@/lib/config";
import type { Json } from "@/lib/database.types";
import { errorMessage, finishJobRun, startJobRun } from "@/lib/job-runs";
import {
  drainPublicDigestOutbox,
  drainPublicUpdateConfirmationOutbox,
} from "@/lib/public-updates";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authorization = request.headers.get("authorization") || "";
  const secret = request.headers.get("x-cron-secret") || "";
  if (
    !hasPublicUpdateTokenConfig() ||
    (
      authorization !== `Bearer ${appConfig.cronSecret}` &&
      secret !== appConfig.cronSecret
    )
  ) {
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
    runId = await startJobRun("send-digests", {
      mode: "durable-public-outbox-drain",
    });
    const confirmation = await drainPublicUpdateConfirmationOutbox();
    const digest = await drainPublicDigestOutbox();
    const terminalFailed =
      confirmation.terminalFailed + digest.terminalFailed;
    await finishJobRun(runId, {
      status: terminalFailed > 0 ? "failed" : "succeeded",
      processedCount: confirmation.claimed + digest.claimed,
      error:
        terminalFailed > 0
          ? `${terminalFailed} public email delivery attempt(s) became terminal.`
          : null,
      metadata: {
        mode: "durable-public-outbox-drain",
        result: JSON.parse(JSON.stringify(digest)) as Json,
        confirmation: JSON.parse(JSON.stringify(confirmation)) as Json,
      },
    });
    return NextResponse.json({
      ok: true,
      runId,
      result: digest,
      confirmation,
    });
  } catch (error) {
    const message = errorMessage(error);
    if (runId) {
      await finishJobRun(runId, {
        status: "failed",
        processedCount: 0,
        error: message,
        metadata: { mode: "durable-public-outbox-drain" },
      }).catch(() => undefined);
    }
    return NextResponse.json({ ok: false, runId, error: message }, { status: 500 });
  }
}
