import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getMaintenanceRunnerState,
  maintenanceCommandForDisplay,
  maintenanceRunnerArgs,
  readLatestMaintenanceReport,
} from "@/lib/admin-maintenance";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import {
  DEFAULT_BASELINE_COST_CAP_USD,
  MAINTENANCE_PROFILE_IDS,
} from "@/lib/maintenance-profiles";

export const runtime = "nodejs";

const postSchema = z.object({
  profile: z.enum(MAINTENANCE_PROFILE_IDS),
  apply: z.boolean().default(true),
  baselineCostCapUsd: z.coerce.number().min(0).max(100).default(DEFAULT_BASELINE_COST_CAP_USD),
});

export async function GET() {
  const setupError = await validateAdminRequest();
  if (setupError.response) return setupError.response;

  const state = getMaintenanceRunnerState();
  return NextResponse.json({
    ok: true,
    controlAvailable: state.controlAvailable,
    unavailableReason: state.unavailableReason,
    runnerExists: state.runnerExists,
    hostedRuntime: state.hostedRuntime,
    workerAppDir: state.workerAppDir,
    latestReport: readLatestMaintenanceReport(state),
  });
}

export async function POST(request: Request) {
  const setupError = await validateAdminRequest();
  if (setupError.response) return setupError.response;

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid maintenance run request." }, { status: 400 });
  }

  const state = getMaintenanceRunnerState();
  const command = maintenanceCommandForDisplay(parsed.data.profile, parsed.data, state);
  if (!state.controlAvailable) {
    return NextResponse.json(
      {
        ok: false,
        error: state.unavailableReason,
        command,
      },
      { status: 503 },
    );
  }

  try {
    const args = maintenanceRunnerArgs(parsed.data.profile, parsed.data, state);
    const child = spawn(process.execPath, args, {
      cwd: state.workerAppDir,
      detached: true,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    return NextResponse.json({
      ok: true,
      pid: child.pid,
      profile: parsed.data.profile,
      command,
      latestReport: readLatestMaintenanceReport(state),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Maintenance run could not be started.",
        command,
      },
      { status: 500 },
    );
  }
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
        { error: "Only AwardPing site admins can start maintenance runs." },
        { status: 403 },
      ),
      user,
    };
  }

  return { response: null, user };
}
