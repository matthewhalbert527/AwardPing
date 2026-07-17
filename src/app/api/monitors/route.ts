import { NextResponse } from "next/server";
import { z } from "zod";
import { awardPageTypes } from "@/lib/award-discovery-types";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { canManageOffice, requireOfficeContext } from "@/lib/offices";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";
import { assertPublicHttpUrl } from "@/lib/url-safety";
import { nextCheckDate } from "@/lib/plans";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const createMonitorSchema = z.object({
  label: z.string().trim().min(1).max(80),
  url: z.string().url(),
  contentType: z.enum(["auto", "html", "pdf"]).default("auto"),
  cadence: z.literal("daily").default("daily"),
  awardId: z.string().uuid().optional(),
  pageType: z.enum(awardPageTypes).optional(),
  sourceLabel: z.string().trim().max(120).optional(),
});

export async function POST(request: Request) {
  if (!isSameOriginMutationRequest(request)) {
    return NextResponse.json({ error: "This request is not allowed." }, { status: 403 });
  }

  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }
  if (!hasSupabaseAdminConfig()) {
    return NextResponse.json({ error: "Monitor management is not configured." }, { status: 503 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const officeContext = await requireOfficeContext(user);
  if (!canManageOffice(officeContext.current.role)) {
    return NextResponse.json(
      { error: "Only office owners and admins can add tracked award pages." },
      { status: 403 },
    );
  }

  const parsed = createMonitorSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the award page details." }, { status: 400 });
  }

  let safeUrl: URL;
  try {
    safeUrl = await assertPublicHttpUrl(parsed.data.url);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Award page URL is not monitorable." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();

  if (parsed.data.awardId) {
    const { data: award } = await admin
      .from("awards")
      .select("id")
      .eq("id", parsed.data.awardId)
      .eq("office_id", officeContext.current.officeId)
      .maybeSingle();

    if (!award) {
      return NextResponse.json({ error: "Award card was not found." }, { status: 404 });
    }
  }

  const { data, error } = await admin
    .from("monitors")
    .insert({
      office_id: officeContext.current.officeId,
      user_id: user.id,
      award_id: parsed.data.awardId || null,
      label: parsed.data.label,
      url: safeUrl.toString(),
      content_type: parsed.data.contentType,
      cadence: parsed.data.cadence,
      page_type: parsed.data.pageType || null,
      source_label: parsed.data.sourceLabel || null,
      next_check_at: nextCheckDate(parsed.data.cadence, new Date(Date.now() - 86_400_000)),
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, monitor: data });
}
