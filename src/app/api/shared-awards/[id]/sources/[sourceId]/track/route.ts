import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { canManageOffice, requireOfficeContext } from "@/lib/offices";
import { trackSharedAwardForOffice } from "@/lib/shared-awards";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Props = {
  params: Promise<{ id: string; sourceId: string }>;
};

export async function POST(_request: Request, { params }: Props) {
  const setupError = validateSetup();
  if (setupError) return setupError;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const officeContext = await requireOfficeContext(user);
  if (!canManageOffice(officeContext.current.role)) {
    return NextResponse.json(
      { error: "Only office owners and admins can track award source pages." },
      { status: 403 },
    );
  }

  const { id, sourceId } = await params;
  const supabase = createSupabaseAdminClient();
  const [{ data: sharedAward }, { data: sharedSource }] = await Promise.all([
    supabase
      .from("shared_awards")
      .select("*")
      .eq("id", id)
      .eq("status", "active")
      .maybeSingle(),
    supabase
      .from("shared_award_sources")
      .select("*")
      .eq("id", sourceId)
      .eq("shared_award_id", id)
      .eq("admin_review_status", "open")
      .maybeSingle(),
  ]);

  if (!sharedAward || !sharedSource) {
    return NextResponse.json({ error: "Award source page was not found." }, { status: 404 });
  }

  try {
    const result = await trackSharedAwardForOffice({
      supabase,
      sharedAward,
      sharedSources: [sharedSource],
      user,
      officeId: officeContext.current.officeId,
      cadence: "daily",
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Award source page could not be tracked.",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: Props) {
  const setupError = validateSetup();
  if (setupError) return setupError;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const officeContext = await requireOfficeContext(user);
  if (!canManageOffice(officeContext.current.role)) {
    return NextResponse.json(
      { error: "Only office owners and admins can untrack award source pages." },
      { status: 403 },
    );
  }

  const { id, sourceId } = await params;
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
    return NextResponse.json({ ok: true, tracked: false });
  }

  const { error: monitorError } = await supabase
    .from("monitors")
    .delete()
    .eq("office_id", officeContext.current.officeId)
    .eq("award_id", officeAward.id)
    .eq("shared_award_source_id", sourceId);

  if (monitorError) {
    return NextResponse.json({ error: monitorError.message }, { status: 500 });
  }

  const { error: sourceError } = await supabase
    .from("award_sources")
    .delete()
    .eq("office_id", officeContext.current.officeId)
    .eq("award_id", officeAward.id)
    .eq("shared_award_source_id", sourceId);

  if (sourceError) {
    return NextResponse.json({ error: sourceError.message }, { status: 500 });
  }

  const { count, error: countError } = await supabase
    .from("monitors")
    .select("id", { count: "exact", head: true })
    .eq("office_id", officeContext.current.officeId)
    .eq("award_id", officeAward.id);

  if (countError) {
    return NextResponse.json({ error: countError.message }, { status: 500 });
  }

  if ((count || 0) === 0) {
    const { error: awardError } = await supabase
      .from("awards")
      .delete()
      .eq("office_id", officeContext.current.officeId)
      .eq("id", officeAward.id);

    if (awardError) {
      return NextResponse.json({ error: awardError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, tracked: false });
}

function validateSetup() {
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  if (!hasSupabaseAdminConfig()) {
    return NextResponse.json(
      { error: "Shared award database is not configured." },
      { status: 503 },
    );
  }

  return null;
}
