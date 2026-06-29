import { NextResponse } from "next/server";
import { displayAwardSummary } from "@/lib/award-summary";
import { getCurrentUser } from "@/lib/auth";
import {
  dedupeChangeSummaries,
  displayChangeSummary,
  isUsefulChangeForAward,
} from "@/lib/change-summary";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { getOfficeContext } from "@/lib/offices";
import {
  displayHomepageForAward,
  filterTrackableOfficialSources,
  isMonitorableOfficialSource,
} from "@/lib/source-url-policy";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Props = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Props) {
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  if (!hasSupabaseAdminConfig()) {
    return NextResponse.json(
      { error: "Shared award directory is not configured." },
      { status: 503 },
    );
  }

  const { id } = await params;
  const user = await getCurrentUser();
  const officeContext = user ? await getOfficeContext(user) : null;
  const admin = createSupabaseAdminClient();

  const [
    { data: sharedAward, error: awardError },
    { data: sharedSources, error: sourcesError },
    { data: sharedChanges, error: changesError },
    { data: officeAwards, error: officeAwardsError },
    { data: officeSources, error: officeSourcesError },
  ] = await Promise.all([
    admin
      .from("shared_awards")
      .select("id, name, official_homepage, summary")
      .eq("id", id)
      .eq("status", "active")
      .maybeSingle(),
    admin
      .from("shared_award_sources")
      .select("id, shared_award_id, url, title, page_type, last_checked_at, last_error, created_at")
      .eq("shared_award_id", id)
      .eq("admin_review_status", "open")
      .order("created_at", { ascending: true }),
    admin
      .from("shared_award_change_events")
      .select(
        "id, shared_award_id, shared_award_source_id, source_title, source_url, source_page_type, summary, change_details, detected_at",
      )
      .eq("shared_award_id", id)
      .order("detected_at", { ascending: false })
      .limit(50),
    officeContext
      ? admin
          .from("awards")
          .select("id, shared_award_id")
          .eq("office_id", officeContext.current.officeId)
          .eq("shared_award_id", id)
          .eq("status", "active")
      : Promise.resolve({ data: [], error: null }),
    officeContext
      ? admin
          .from("award_sources")
          .select("shared_award_source_id")
          .eq("office_id", officeContext.current.officeId)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const error =
    awardError || sourcesError || changesError || officeAwardsError || officeSourcesError;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!sharedAward) {
    return NextResponse.json({ error: "Shared award was not found." }, { status: 404 });
  }

  const trackedSourceIds = new Set(
    (officeSources || [])
      .map((source) => source.shared_award_source_id)
      .filter((sourceId): sourceId is string => Boolean(sourceId)),
  );
  const sources = filterTrackableOfficialSources(sharedSources || []);
  const changes = dedupeChangeSummaries(
    (sharedChanges || []).filter((change) =>
      isMonitorableOfficialSource({ url: change.source_url, page_type: change.source_page_type }) &&
      isUsefulChangeForAward({
        awardName: sharedAward.name,
        sourceTitle: change.source_title,
        sourceUrl: change.source_url,
        summary: change.summary,
        change_details: change.change_details,
      }),
    ),
  );
  return NextResponse.json({
    award: {
      id: sharedAward.id,
      name: sharedAward.name,
      officialHomepage: displayHomepageForAward(sharedAward.official_homepage, sources),
      summary: displayAwardSummary(sharedAward.summary),
      sourceCount: sources.length,
      changeCount: changes.length,
      tracked: Boolean(officeAwards?.length),
      detailsLoaded: true,
      sources: sources.map((source) => ({
        id: source.id,
        url: source.url,
        title: source.title,
        pageType: source.page_type,
        tracked: trackedSourceIds.has(source.id),
        lastCheckedAt: source.last_checked_at,
        lastError: source.last_error,
        latestChanges: latestChangesForSource(source, changes).slice(0, 2).map((change) => ({
          id: change.id,
          sourceTitle: change.source_title,
          sourceUrl: change.source_url,
          sourcePageType: change.source_page_type,
          summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
          changeDetails: change.change_details,
          detectedAt: change.detected_at,
        })),
      })),
      changes: changes.map((change) => ({
        id: change.id,
        sourceTitle: change.source_title,
        sourceUrl: change.source_url,
        sourcePageType: change.source_page_type,
        summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
        changeDetails: change.change_details,
        detectedAt: change.detected_at,
      })),
    },
  });
}

function latestChangesForSource<
  Source extends { id: string; url: string },
  Change extends { shared_award_source_id?: string | null; source_url: string },
>(source: Source, changes: Change[]) {
  const sourceUrlKey = normalizeUrlKey(source.url);
  return changes.filter((change) => {
    if (change.shared_award_source_id && change.shared_award_source_id === source.id) {
      return true;
    }

    return normalizeUrlKey(change.source_url) === sourceUrlKey;
  });
}

function normalizeUrlKey(value: string | null | undefined) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/g, "").toLowerCase();
  } catch {
    return String(value || "").trim().replace(/[?#].*$/, "").replace(/\/+$/g, "").toLowerCase();
  }
}
