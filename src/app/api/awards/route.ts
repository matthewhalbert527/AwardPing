import { NextResponse } from "next/server";
import { z } from "zod";
import {
  awardPageTypes,
  contentTypeForPage,
  pageTypeLabel,
} from "@/lib/award-discovery-types";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { canManageOffice, requireOfficeContext } from "@/lib/offices";
import { nextCheckDate } from "@/lib/plans";
import { upsertSharedAward } from "@/lib/shared-awards";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { assertPublicHttpUrl } from "@/lib/url-safety";

export const runtime = "nodejs";

const selectedSourceSchema = z.object({
  url: z.string().url(),
  title: z.string().trim().min(1).max(220),
  pageType: z.enum(awardPageTypes),
  confidence: z.number().min(0).max(1).default(0),
  reason: z.string().trim().max(360).optional(),
});

const createAwardSchema = z.object({
  name: z.string().trim().min(1).max(140),
  officialHomepage: z.string().url().nullable().optional(),
  summary: z.string().trim().max(500).optional(),
  confidence: z.number().min(0).max(1).default(0),
  cadence: z.literal("daily").default("daily"),
  selectedSources: z.array(selectedSourceSchema).min(1).max(12),
});

export async function POST(request: Request) {
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  if (!hasSupabaseAdminConfig()) {
    return NextResponse.json(
      { error: "Shared award database is not configured." },
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
      { error: "Only office owners and admins can save award sources." },
      { status: 403 },
    );
  }

  const parsed = createAwardSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose at least one exact award source to track." },
      { status: 400 },
    );
  }

  const safeSources = [];
  const seen = new Set<string>();

  for (const source of parsed.data.selectedSources) {
    try {
      const safeUrl = await assertPublicHttpUrl(source.url);
      safeUrl.hash = "";
      const url = safeUrl.toString();
      if (seen.has(url)) continue;

      seen.add(url);
      safeSources.push({ ...source, url });
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? `${source.title}: ${error.message}`
              : "One selected source is not monitorable.",
        },
        { status: 400 },
      );
    }
  }

  if (safeSources.length === 0) {
    return NextResponse.json(
      { error: "Choose at least one unique source to track." },
      { status: 400 },
    );
  }

  let officialHomepage = parsed.data.officialHomepage || null;
  if (officialHomepage) {
    try {
      officialHomepage = (await assertPublicHttpUrl(officialHomepage)).toString();
    } catch {
      officialHomepage = null;
    }
  }

  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  let sharedAward;
  try {
    sharedAward = await upsertSharedAward(admin, {
      name: parsed.data.name,
      officialHomepage,
      summary: parsed.data.summary || null,
      confidence: parsed.data.confidence,
      source: "user",
      submittedByUserId: user.id,
      sources: safeSources.map((source) => ({
        url: source.url,
        title: source.title,
        pageType: source.pageType,
        confidence: source.confidence,
        reason: source.reason || null,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Shared award database could not be updated.",
      },
      { status: 500 },
    );
  }

  const { data: award, error: awardError } = await supabase
    .from("awards")
    .insert({
      office_id: officeContext.current.officeId,
      user_id: user.id,
      shared_award_id: sharedAward.id,
      name: parsed.data.name,
      official_homepage: officialHomepage,
      summary: parsed.data.summary || null,
      confidence: parsed.data.confidence,
      status: "active",
    })
    .select("*")
    .single();

  if (awardError || !award) {
    return NextResponse.json(
      { error: awardError?.message || "Award card could not be created." },
      { status: 500 },
    );
  }

  const sourceRows = safeSources.map((source) => ({
    award_id: award.id,
    office_id: officeContext.current.officeId,
    user_id: user.id,
    url: source.url,
    title: source.title,
    page_type: source.pageType,
    confidence: source.confidence,
    reason: source.reason || null,
    selected: true,
  }));

  const { data: sources, error: sourcesError } = await supabase
    .from("award_sources")
    .insert(sourceRows)
    .select("*");

  if (sourcesError) {
    await supabase.from("awards").delete().eq("id", award.id).eq("user_id", user.id);
    return NextResponse.json({ error: sourcesError.message }, { status: 500 });
  }

  const monitorRows = safeSources.map((source) => ({
    office_id: officeContext.current.officeId,
    user_id: user.id,
    award_id: award.id,
    label: `${parsed.data.name} - ${pageTypeLabel(source.pageType)}`,
    url: source.url,
    content_type: contentTypeForPage(source.pageType, source.url),
    cadence: parsed.data.cadence,
    page_type: source.pageType,
    source_label: source.title,
    next_check_at: nextCheckDate(
      parsed.data.cadence,
      new Date(Date.now() - 86_400_000),
    ),
  }));

  const { data: monitors, error: monitorsError } = await supabase
    .from("monitors")
    .insert(monitorRows)
    .select("*");

  if (monitorsError) {
    await supabase.from("awards").delete().eq("id", award.id).eq("user_id", user.id);
    return NextResponse.json({ error: monitorsError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    award,
    sharedAward,
    sources: sources || [],
    monitors: monitors || [],
  });
}
