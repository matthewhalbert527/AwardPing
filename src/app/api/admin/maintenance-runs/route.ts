import { NextResponse } from "next/server";
import {
  getMaintenanceRunnerState,
  readLatestMaintenanceReport,
} from "@/lib/admin-maintenance";
import {
  buildAdminRunReportFeed,
  latestCompletedDailyRun,
  type WorkerRun,
} from "@/lib/admin-run-report";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const workerRunColumns = "id, worker_name, status, ai_provider, checked_count, changed_count, unchanged_count, initial_count, discovered_count, failed_count, error, metadata, started_at, finished_at";

export async function GET() {
  const setupError = await validateAdminRequest();
  if (setupError.response) return setupError.response;

  const state = getMaintenanceRunnerState();
  const { runs, warning } = await loadWorkerReportRows();
  return NextResponse.json(
    {
      ok: true,
      controlAvailable: state.controlAvailable,
      unavailableReason: state.unavailableReason,
      runnerExists: state.runnerExists,
      hostedRuntime: state.hostedRuntime,
      workerAppDir: state.workerAppDir,
      latestReport: readLatestMaintenanceReport(state),
      runFeed: buildAdminRunReportFeed(runs),
      runFeedWarning: warning,
    },
    {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
      },
    },
  );
}

export async function POST() {
  const setupError = await validateAdminRequest();
  if (setupError.response) return setupError.response;

  return NextResponse.json(
    {
      ok: false,
      error:
        "Worker control is local-only. Run `npm run command:center -- start --profile=catchup` on the AwardPing PC.",
    },
    { status: 405 },
  );
}

async function validateAdminRequest() {
  if (!hasSupabaseConfig()) {
    return {
      response: NextResponse.json({ error: "Supabase is not configured." }, { status: 503 }),
      user: null,
    };
  }

  if (!hasSupabaseAdminConfig()) {
    return {
      response: NextResponse.json(
        { error: "Supabase service-role access is not configured." },
        { status: 503 },
      ),
      user: null,
    };
  }

  const user = await getCurrentUser();
  if (!user) {
    return {
      response: NextResponse.json({ error: "Log in first." }, { status: 401 }),
      user: null,
    };
  }

  if (!isSiteAdminEmail(user.email)) {
    return {
      response: NextResponse.json(
        { error: "Only AwardPing site admins can read maintenance status." },
        { status: 403 },
      ),
      user,
    };
  }

  return { response: null, user };
}

async function loadWorkerReportRows() {
  const admin = createSupabaseAdminClient();
  const [activeResult, maintenanceResult, visualResult] = await Promise.all([
    admin
      .from("local_worker_runs")
      .select(workerRunColumns)
      .eq("status", "running")
      .order("started_at", { ascending: false })
      .limit(30),
    admin
      .from("local_worker_runs")
      .select(workerRunColumns)
      .eq("worker_name", "local-maintenance-runner")
      .neq("status", "running")
      .order("started_at", { ascending: false })
      .limit(12),
    admin
      .from("local_worker_runs")
      .select(workerRunColumns)
      .like("worker_name", "%visual-snapshot-worker-shard%")
      .neq("status", "running")
      .order("started_at", { ascending: false })
      .limit(18),
  ]);

  const warningParts = [
    activeResult.error?.message,
    maintenanceResult.error?.message,
    visualResult.error?.message,
  ].filter((message): message is string => Boolean(message));
  let rows = [
    ...((activeResult.data || []) as WorkerRun[]),
    ...((maintenanceResult.data || []) as WorkerRun[]),
    ...((visualResult.data || []) as WorkerRun[]),
  ];

  const dailyParent = latestCompletedDailyRun((maintenanceResult.data || []) as WorkerRun[]);
  if (dailyParent?.finished_at) {
    const childResult = await admin
      .from("local_worker_runs")
      .select(workerRunColumns)
      .gte("started_at", dailyParent.started_at)
      .lte("started_at", dailyParent.finished_at)
      .order("started_at", { ascending: true })
      .limit(100);
    if (childResult.error) warningParts.push(childResult.error.message);
    rows = [...rows, ...((childResult.data || []) as WorkerRun[])];
  }

  return {
    runs: [...new Map(rows.map((run) => [run.id, run])).values()],
    warning: warningParts.length
      ? "Some worker details could not be refreshed; the available totals are shown."
      : null,
  };
}
