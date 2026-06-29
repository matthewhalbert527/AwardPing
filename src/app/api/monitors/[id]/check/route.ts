import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canManageOffice, getMembershipForOffice } from "@/lib/offices";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const { id } = await params;
  const admin = createSupabaseAdminClient();
  const { data: monitor, error } = await admin
    .from("monitors")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!monitor?.office_id) {
    return NextResponse.json({ error: "Tracked award page was not found." }, { status: 404 });
  }

  const membership = await getMembershipForOffice(user.id, monitor.office_id);
  if (!membership || !canManageOffice(membership.role)) {
    return NextResponse.json({ error: "Only office owners and admins can run checks." }, { status: 403 });
  }

  return NextResponse.json(
    {
      ok: false,
      error:
        "Manual text checks have been retired. This source will be checked by the daily screenshot worker.",
    },
    { status: 410 },
  );
}
