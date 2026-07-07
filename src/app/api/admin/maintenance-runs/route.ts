import { NextResponse } from "next/server";
import {
  getMaintenanceRunnerState,
  readLatestMaintenanceReport,
} from "@/lib/admin-maintenance";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";

export const runtime = "nodejs";

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
