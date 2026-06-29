import { redirect } from "next/navigation";
import { DashboardSectionCard } from "@/components/dashboard-section-card";
import { SetupNotice } from "@/components/setup-notice";
import { UpdateFeedWorkspace, type UpdateFeedRow } from "@/components/update-feed-workspace";
import { requireUser } from "@/lib/auth";
import {
  dedupeChangeSummaries,
  displayChangeSummary,
  isUsefulChangeForAward,
} from "@/lib/change-summary";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { AwardPageType } from "@/lib/award-discovery-types";
import type { Json } from "@/lib/database.types";
import { getOnboardingStatus } from "@/lib/onboarding";
import { isMonitorableOfficialSource } from "@/lib/source-url-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { unreadSharedChangeIdsForUser } from "@/lib/update-read-state";

type OfficeAward = {
  id: string;
  name: string;
  shared_award_id: string | null;
};

type SharedChange = {
  id: string;
  shared_award_id: string;
  shared_award_source_id: string | null;
  source_title: string | null;
  source_url: string;
  source_page_type: AwardPageType | null;
  summary: string;
  change_details: Json;
  detected_at: string;
};

type Props = {
  searchParams: Promise<{ scope?: string; view?: string }>;
};

export default async function DashboardPage({ searchParams }: Props) {
  if (!hasSupabaseConfig()) return <SetupNotice />;

  const params = await searchParams;
  if (params.view === "subscribe") {
    redirect("/dashboard");
  }

  const section = params.scope === "all" ? "database" : "watchlist";

  const user = await requireUser();
  const onboardingStatus = await getOnboardingStatus(user);
  if (!onboardingStatus.isComplete || !onboardingStatus.officeContext) {
    redirect("/dashboard/onboarding");
  }

  const officeContext = onboardingStatus.officeContext;
  const supabase = await createSupabaseServerClient();

  const [{ data: officeAwards }, { data: sharedChanges }] =
    await Promise.all([
      supabase
        .from("awards")
        .select("id, name, shared_award_id")
        .eq("office_id", officeContext.current.officeId)
        .eq("status", "active"),
      supabase
        .from("shared_award_change_events")
        .select(
          "id, shared_award_id, shared_award_source_id, source_title, source_url, source_page_type, summary, change_details, detected_at",
        )
        .order("detected_at", { ascending: false })
        .limit(350),
    ]);

  const officeAwardRows = (officeAwards || []) as OfficeAward[];
  const sharedChangeRows = (sharedChanges || []) as SharedChange[];
  const sharedAwardIds = [...new Set(sharedChangeRows.map((change) => change.shared_award_id))];
  const unreadChangeIds = hasSupabaseAdminConfig()
    ? await unreadSharedChangeIdsForUser(user.id, sharedChangeRows).catch(() => new Set<string>())
    : new Set<string>();

  const [{ data: sharedAwards }] =
    await Promise.all([
      sharedAwardIds.length
        ? supabase.from("shared_awards").select("id, name, slug").in("id", sharedAwardIds)
        : Promise.resolve({ data: [] }),
    ]);

  const officeSharedAwardIds = new Set(
    officeAwardRows
      .map((award) => award.shared_award_id)
      .filter((id): id is string => Boolean(id)),
  );
  const officeAwardNameBySharedId = new Map(
    officeAwardRows
      .filter((award) => award.shared_award_id)
      .map((award) => [award.shared_award_id as string, award.name]),
  );
  const sharedAwardNameById = new Map(
    ((sharedAwards || []) as Array<{ id: string; name: string; slug: string | null }>).map((award) => [
      award.id,
      award.name,
    ]),
  );
  const sharedAwardSlugById = new Map(
    ((sharedAwards || []) as Array<{ id: string; name: string; slug: string | null }>).map((award) => [
      award.id,
      award.slug,
    ]),
  );
  const sharedRows: UpdateFeedRow[] = dedupeChangeSummaries(
    sharedChangeRows.filter((change) => {
      const awardName =
        officeAwardNameBySharedId.get(change.shared_award_id) ||
        sharedAwardNameById.get(change.shared_award_id);

      return (
        isMonitorableOfficialSource({ url: change.source_url, page_type: change.source_page_type }) &&
        isUsefulChangeForAward({
          awardName,
          sourceTitle: change.source_title,
          sourceUrl: change.source_url,
          summary: change.summary,
          change_details: change.change_details,
        })
      );
    }),
  ).map((change) => {
    const title =
      officeAwardNameBySharedId.get(change.shared_award_id) ||
      sharedAwardNameById.get(change.shared_award_id) ||
      "Shared award";

    return {
      id: `shared-${change.id}`,
      changeId: change.id,
      awardId: change.shared_award_id,
      awardSlug: sharedAwardSlugById.get(change.shared_award_id) || null,
      sourceId: change.shared_award_source_id,
      title,
      sourceTitle: change.source_title || "Shared source page",
      sourceUrl: change.source_url,
      sourcePageType: change.source_page_type,
      summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
      changeDetails: change.change_details,
      detectedAt: change.detected_at,
      kind: "shared",
      inWatchlist: officeSharedAwardIds.has(change.shared_award_id),
      unread: unreadChangeIds.has(change.id),
    };
  });

  const rows = [...sharedRows].sort(
    (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime(),
  );

  return (
    <div className={`dashboard-page dashboard-page-${section}`}>
      <DashboardSectionCard
        section={section}
        activeView="updates"
        databaseCount={rows.length}
        watchlistCount={rows.filter((row) => row.inWatchlist).length}
      />

      <UpdateFeedWorkspace rows={rows} scope={section === "database" ? "all" : "watchlist"} />
    </div>
  );
}

