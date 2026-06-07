import { redirect } from "next/navigation";
import { DashboardSectionCard } from "@/components/dashboard-section-card";
import { SetupNotice } from "@/components/setup-notice";
import { UpdateFeedWorkspace, type UpdateFeedRow } from "@/components/update-feed-workspace";
import { requireUser } from "@/lib/auth";
import {
  dedupeChangeSummaries,
  displayChangeSummary,
  isUsefulChangeForAward,
  isUsefulChangeSummary,
} from "@/lib/change-summary";
import { hasSupabaseConfig } from "@/lib/config";
import type { AwardPageType } from "@/lib/award-discovery-types";
import type { Json } from "@/lib/database.types";
import { getOnboardingStatus } from "@/lib/onboarding";
import { isMonitorableOfficialSource } from "@/lib/source-url-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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
  previous_snapshot_id: string | null;
  new_snapshot_id: string | null;
  summary: string;
  change_details: Json;
  detected_at: string;
};

type LocalChange = {
  id: string;
  monitor_id: string;
  previous_snapshot_id: string | null;
  new_snapshot_id: string | null;
  summary: string;
  change_details: Json;
  detected_at: string;
};

type MonitorSummary = {
  id: string;
  label: string;
  url: string;
  page_type: AwardPageType | null;
};

type SnapshotSample = {
  id: string;
  text_sample: string;
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

  const [{ data: officeAwards }, { data: sharedChanges }, { data: localChanges }] =
    await Promise.all([
      supabase
        .from("awards")
        .select("id, name, shared_award_id")
        .eq("office_id", officeContext.current.officeId)
        .eq("status", "active"),
      supabase
        .from("shared_award_change_events")
        .select(
          "id, shared_award_id, shared_award_source_id, source_title, source_url, source_page_type, previous_snapshot_id, new_snapshot_id, summary, change_details, detected_at",
        )
        .order("detected_at", { ascending: false })
        .limit(350),
      supabase
        .from("change_events")
        .select("id, monitor_id, previous_snapshot_id, new_snapshot_id, summary, change_details, detected_at")
        .eq("office_id", officeContext.current.officeId)
        .order("detected_at", { ascending: false })
        .limit(100),
    ]);

  const officeAwardRows = (officeAwards || []) as OfficeAward[];
  const sharedChangeRows = (sharedChanges || []) as SharedChange[];
  const localChangeRows = (localChanges || []) as LocalChange[];
  const sharedAwardIds = [...new Set(sharedChangeRows.map((change) => change.shared_award_id))];
  const monitorIds = [...new Set(localChangeRows.map((change) => change.monitor_id))];
  const sharedSnapshotIds = snapshotIdsForChanges(sharedChangeRows);
  const localSnapshotIds = snapshotIdsForChanges(localChangeRows);

  const [
    { data: sharedAwards },
    { data: monitors },
    { data: sharedSnapshots },
    { data: localSnapshots },
  ] =
    await Promise.all([
      sharedAwardIds.length
        ? supabase.from("shared_awards").select("id, name").in("id", sharedAwardIds)
        : Promise.resolve({ data: [] }),
      monitorIds.length
        ? supabase
            .from("monitors")
            .select("id, label, url, page_type")
            .in("id", monitorIds)
        : Promise.resolve({ data: [] }),
      sharedSnapshotIds.length
        ? supabase
            .from("shared_award_source_snapshots")
            .select("id, text_sample")
            .in("id", sharedSnapshotIds)
        : Promise.resolve({ data: [] }),
      localSnapshotIds.length
        ? supabase
            .from("monitor_snapshots")
            .select("id, text_sample")
            .in("id", localSnapshotIds)
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
    ((sharedAwards || []) as Array<{ id: string; name: string }>).map((award) => [
      award.id,
      award.name,
    ]),
  );
  const monitorById = new Map(
    ((monitors || []) as MonitorSummary[]).map((monitor) => [monitor.id, monitor]),
  );
  const sharedSnapshotById = snapshotSampleMap((sharedSnapshots || []) as SnapshotSample[]);
  const localSnapshotById = snapshotSampleMap((localSnapshots || []) as SnapshotSample[]);

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
      changeKind: "shared",
      awardId: change.shared_award_id,
      title,
      sourceTitle: change.source_title || "Shared source page",
      sourceUrl: change.source_url,
      sourcePageType: change.source_page_type,
      summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
      changeDetails: change.change_details,
      detectedAt: change.detected_at,
      kind: "shared",
      inWatchlist: officeSharedAwardIds.has(change.shared_award_id),
      previousTextSample: change.previous_snapshot_id
        ? sharedSnapshotById.get(change.previous_snapshot_id) || null
        : null,
      newTextSample: change.new_snapshot_id
        ? sharedSnapshotById.get(change.new_snapshot_id) || null
        : null,
    };
  });

  const localRows: UpdateFeedRow[] = localChangeRows
    .filter((change) => isUsefulChangeSummary(change.summary, change.change_details))
    .map((change) => {
      const monitor = monitorById.get(change.monitor_id);
      return {
        id: `office-${change.id}`,
        changeId: change.id,
        changeKind: "office",
        awardId: null,
        title: monitor?.label || "Tracked award page",
        sourceTitle: "Office watchlist page",
        sourceUrl: monitor?.url || null,
        sourcePageType: monitor?.page_type || null,
        summary: displayChangeSummary(change.summary, monitor?.url || null, change.change_details),
        changeDetails: change.change_details,
        detectedAt: change.detected_at,
        kind: "office",
        inWatchlist: true,
        previousTextSample: change.previous_snapshot_id
          ? localSnapshotById.get(change.previous_snapshot_id) || null
          : null,
        newTextSample: change.new_snapshot_id
          ? localSnapshotById.get(change.new_snapshot_id) || null
          : null,
      };
    });

  const rows = [...sharedRows, ...localRows].sort(
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

function snapshotIdsForChanges(
  changes: Array<{
    previous_snapshot_id: string | null;
    new_snapshot_id: string | null;
  }>,
) {
  return [
    ...new Set(
      changes
        .flatMap((change) => [change.previous_snapshot_id, change.new_snapshot_id])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}

function snapshotSampleMap(snapshots: SnapshotSample[]) {
  return new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.text_sample]));
}
