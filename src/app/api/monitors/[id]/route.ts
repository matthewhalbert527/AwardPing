import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseConfig } from "@/lib/config";
import { canManageOffice, getMembershipForOffice } from "@/lib/offices";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

const patchSchema = z.object({
  status: z.enum(["active", "paused"]).optional(),
  label: z.string().trim().min(1).max(80).optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid update." }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { data: monitor, error: lookupError } = await admin
    .from("monitors")
    .select("office_id")
    .eq("id", id)
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }

  if (!monitor?.office_id) {
    return NextResponse.json({ error: "Tracked award page was not found." }, { status: 404 });
  }

  const membership = await getMembershipForOffice(user.id, monitor.office_id);
  if (!membership || !canManageOffice(membership.role)) {
    return NextResponse.json({ error: "Only office owners and admins can update monitors." }, { status: 403 });
  }

  const { error } = await admin
    .from("monitors")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: Params) {
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const { id } = await params;
  const admin = createSupabaseAdminClient();
  const { data: monitor, error: lookupError } = await admin
    .from("monitors")
    .select("office_id")
    .eq("id", id)
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }

  if (!monitor?.office_id) {
    return NextResponse.json({ error: "Tracked award page was not found." }, { status: 404 });
  }

  const membership = await getMembershipForOffice(user.id, monitor.office_id);
  if (!membership || !canManageOffice(membership.role)) {
    return NextResponse.json({ error: "Only office owners and admins can delete monitors." }, { status: 403 });
  }

  const { error } = await admin
    .from("monitors")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
