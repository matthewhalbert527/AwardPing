import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { canManageOffice, requireOfficeContext } from "@/lib/offices";
import { trackSharedAwardForOffice } from "@/lib/shared-awards";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const trackSchema = z.object({
  cadence: z.literal("daily").default("daily"),
});

type Props = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: Props) {
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  if (!hasSupabaseAdminConfig()) {
    return NextResponse.json(
      { error: "Shared award directory is not configured." },
      { status: 503 },
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const officeContext = await requireOfficeContext(user);
  if (!canManageOffice(officeContext.current.role)) {
    return NextResponse.json(
      { error: "Only office owners and admins can track shared awards." },
      { status: 403 },
    );
  }

  const { id } = await params;
  const parsed = trackSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the tracking cadence." }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const [{ data: sharedAward }, { data: sharedSources }] = await Promise.all([
    supabase
      .from("shared_awards")
      .select("*")
      .eq("id", id)
      .eq("status", "active")
      .maybeSingle(),
    supabase
      .from("shared_award_sources")
      .select("*")
      .eq("shared_award_id", id)
      .eq("admin_review_status", "open")
      .order("created_at", { ascending: true }),
  ]);

  if (!sharedAward) {
    return NextResponse.json({ error: "Shared award was not found." }, { status: 404 });
  }

  if (!sharedSources || sharedSources.length === 0) {
    return NextResponse.json(
      { error: "This shared award does not have trackable source pages yet." },
      { status: 400 },
    );
  }

  try {
    const result = await trackSharedAwardForOffice({
      supabase,
      sharedAward,
      sharedSources,
      user,
      officeId: officeContext.current.officeId,
      cadence: parsed.data.cadence,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Shared award could not be tracked.",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: Props) {
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  if (!hasSupabaseAdminConfig()) {
    return NextResponse.json(
      { error: "Shared award directory is not configured." },
      { status: 503 },
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const officeContext = await requireOfficeContext(user);
  if (!canManageOffice(officeContext.current.role)) {
    return NextResponse.json(
      { error: "Only office owners and admins can untrack shared awards." },
      { status: 403 },
    );
  }

  const { id } = await params;
  const supabase = createSupabaseAdminClient();
  const { data: officeAward, error: lookupError } = await supabase
    .from("awards")
    .select("id")
    .eq("office_id", officeContext.current.officeId)
    .eq("shared_award_id", id)
    .eq("status", "active")
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }

  if (!officeAward) {
    return NextResponse.json({ ok: true, alreadyTracked: false });
  }

  const { error: monitorError } = await supabase
    .from("monitors")
    .delete()
    .eq("office_id", officeContext.current.officeId)
    .eq("award_id", officeAward.id);

  if (monitorError) {
    return NextResponse.json({ error: monitorError.message }, { status: 500 });
  }

  const { error: awardError } = await supabase
    .from("awards")
    .delete()
    .eq("office_id", officeContext.current.officeId)
    .eq("id", officeAward.id);

  if (awardError) {
    return NextResponse.json({ error: awardError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, alreadyTracked: false });
}
