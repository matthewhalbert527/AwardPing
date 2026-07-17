import { NextResponse } from "next/server";
import { z } from "zod";
import { awardPageTypes } from "@/lib/award-discovery-types";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { canManageOffice, requireOfficeContext } from "@/lib/offices";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";
import { upsertSharedAward } from "@/lib/shared-awards";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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
  if (!isSameOriginMutationRequest(request)) {
    return NextResponse.json({ error: "This request is not allowed." }, { status: 403 });
  }

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
            : "Shared award directory could not be updated.",
      },
      { status: 500 },
    );
  }

  const { data: sharedSources, error: sharedSourcesError } = await admin
    .from("shared_award_sources")
    .select("id, url")
    .eq("shared_award_id", sharedAward.id)
    .in("url", safeSources.map((source) => source.url));

  if (sharedSourcesError) {
    return NextResponse.json(
      { error: sharedSourcesError.message },
      { status: 500 },
    );
  }

  const sharedSourceIdByUrl = new Map(
    (sharedSources || []).map((source) => [source.url, source.id]),
  );
  const sharedSourceIds = safeSources
    .map((source) => sharedSourceIdByUrl.get(source.url))
    .filter((sourceId): sourceId is string => Boolean(sourceId));
  if (sharedSourceIds.length !== safeSources.length) {
    return NextResponse.json(
      { error: "The shared source catalog changed during source intake. Try again." },
      { status: 409 },
    );
  }

  const { data: tracking, error: trackingError } = await admin.rpc(
    "create_office_award_tracking_from_intake",
    {
      p_actor_user_id: user.id,
      p_office_id: officeContext.current.officeId,
      p_shared_award_id: sharedAward.id,
      p_shared_award_source_ids: sharedSourceIds,
      p_cadence: parsed.data.cadence,
    },
  );
  if (
    trackingError ||
    !isJsonObject(tracking) ||
    !isJsonObject(tracking.award) ||
    !Array.isArray(tracking.sources) ||
    !Array.isArray(tracking.monitors)
  ) {
    const status = trackingError?.code === "42501"
      ? 403
      : trackingError?.code === "40001"
        ? 409
        : 500;
    return NextResponse.json(
      { error: trackingError?.message || "Award tracking could not be created." },
      { status },
    );
  }

  return NextResponse.json({
    ok: true,
    award: tracking.award,
    sharedAward,
    sources: tracking.sources,
    monitors: tracking.monitors,
  });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
