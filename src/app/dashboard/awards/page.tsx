import { AwardDiscoveryWorkspace } from "@/components/award-discovery-workspace";
import { DashboardSectionCard } from "@/components/dashboard-section-card";
import { SetupNotice } from "@/components/setup-notice";
import { SourceRequestForm } from "@/components/source-request-form";
import {
  WatchlistAwardGroups,
  type WatchlistAwardGroup,
  type WatchlistSource,
} from "@/components/watchlist-award-groups";
import { requireUser } from "@/lib/auth";
import { displayAwardSummary } from "@/lib/award-summary";
import { hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { canManageOffice, requireOfficeContext } from "@/lib/offices";
import {
  displayHomepageForAward,
  filterTrackableOfficialSources,
} from "@/lib/source-url-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { upsertWatchlistSource } from "@/lib/watchlist-source-merge";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ view?: string }>;
};

type AwardWorkspaceView = "database" | "watchlist" | "request";

type OfficeAwardRow = Database["public"]["Tables"]["awards"]["Row"];
type OfficeAwardSourceRow = Database["public"]["Tables"]["award_sources"]["Row"];
type MonitorRow = Database["public"]["Tables"]["monitors"]["Row"];
type SharedAwardRow = Database["public"]["Tables"]["shared_awards"]["Row"];
type SharedSourceRow = Database["public"]["Tables"]["shared_award_sources"]["Row"];
type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;
type SharedAwardDirectoryRow = Pick<SharedAwardRow, "id" | "name" | "official_homepage" | "summary">;
type TrackedOfficeAwardRow = Pick<OfficeAwardRow, "id" | "shared_award_id">;
type SharedSourceDirectoryRow = Pick<
  SharedSourceRow,
  "id" | "shared_award_id" | "url" | "title" | "page_type" | "last_checked_at" | "last_error"
>;

export default async function DashboardAwardsPage({ searchParams }: Props) {
  if (!hasSupabaseConfig()) return <SetupNotice />;

  const view = readAwardWorkspaceView((await searchParams).view);
  const user = await requireUser();
  const officeContext = await requireOfficeContext(user);
  const supabase = await createSupabaseServerClient();
  const canManage = canManageOffice(officeContext.current.role);
  const section = view === "watchlist" ? "watchlist" : "database";
  const sharedCatalog = view === "database"
    ? await loadSharedAwardIndex(supabase, officeContext.current.officeId)
    : [];
  const watchlistGroups = view === "watchlist"
    ? await loadWatchlistGroups(supabase, officeContext.current.officeId)
    : [];
  const [databaseCount, watchlistCount] = await Promise.all([
    view === "database" ? Promise.resolve(sharedCatalog.length) : fetchSharedAwardCount(supabase),
    view === "watchlist"
      ? Promise.resolve(watchlistGroups.length)
      : fetchWatchlistAwardCount(supabase, officeContext.current.officeId),
  ]);

  return (
    <div className={`dashboard-page dashboard-page-${section}`}>
      <DashboardSectionCard
        section={section}
        activeView={view === "request" ? "request" : "awards"}
        databaseCount={databaseCount}
        watchlistCount={watchlistCount}
      />

      {view === "database" && (
        <AwardDiscoveryWorkspace
          sharedAwards={sharedCatalog}
          canManage={canManage}
          isAuthenticated
        />
      )}

      {view === "watchlist" && (
        <div className="grid gap-4">
          <WatchlistAwardGroups groups={watchlistGroups} canManage={canManage} />
        </div>
      )}

      {view === "request" && <SourceRequestForm />}
    </div>
  );
}

function readAwardWorkspaceView(view: string | undefined): AwardWorkspaceView {
  if (view === "watchlist" || view === "request") return view;
  return "database";
}

async function fetchAllSharedAwards(supabase: SupabaseServerClient) {
  return fetchAllPages<SharedAwardDirectoryRow>((from, to) =>
    supabase
      .from("shared_awards")
      .select("id, name, official_homepage, summary")
      .eq("status", "active")
      .order("name", { ascending: true })
      .range(from, to),
  );
}

async function loadSharedAwardIndex(
  supabase: SupabaseServerClient,
  officeId: string,
) {
  const [{ data: trackedAwards }, sharedAwards] = await Promise.all([
    supabase
      .from("awards")
      .select("id, shared_award_id")
      .eq("office_id", officeId)
      .eq("status", "active")
      .not("shared_award_id", "is", null),
    fetchAllSharedAwards(supabase),
  ]);

  return mapSharedAwardIndex(
    sharedAwards || [],
    (trackedAwards || []) as TrackedOfficeAwardRow[],
  );
}

async function loadWatchlistGroups(
  supabase: SupabaseServerClient,
  officeId: string,
) {
  const [{ data: officeAwards }, { data: officeAwardSources }, { data: monitors }] =
    await Promise.all([
      supabase
        .from("awards")
        .select("*")
        .eq("office_id", officeId)
        .eq("status", "active")
        .order("created_at", { ascending: false }),
      supabase
        .from("award_sources")
        .select("*")
        .eq("office_id", officeId)
        .order("created_at", { ascending: true }),
      supabase
        .from("monitors")
        .select("*")
        .eq("office_id", officeId)
        .order("created_at", { ascending: false }),
    ]);

  const awards = (officeAwards || []) as OfficeAwardRow[];
  const sharedSources = await fetchSharedSourcesForAwards(
    supabase,
    awards
      .map((award) => award.shared_award_id)
      .filter((id): id is string => Boolean(id)),
  );

  return buildWatchlistGroups(
    awards,
    (monitors || []) as MonitorRow[],
    (officeAwardSources || []) as OfficeAwardSourceRow[],
    sharedSources,
  );
}

async function fetchSharedSourcesForAwards(
  supabase: SupabaseServerClient,
  sharedAwardIds: string[],
) {
  const ids = [...new Set(sharedAwardIds)];
  if (ids.length === 0) return [];

  const { data } = await supabase
    .from("shared_award_sources")
    .select("id, shared_award_id, url, title, page_type, last_checked_at, last_error")
    .in("shared_award_id", ids)
    .order("created_at", { ascending: true });

  return (data || []) as SharedSourceDirectoryRow[];
}

async function fetchSharedAwardCount(supabase: SupabaseServerClient) {
  const { count } = await supabase
    .from("shared_awards")
    .select("id", { count: "exact", head: true })
    .eq("status", "active");

  return count || 0;
}

async function fetchWatchlistAwardCount(
  supabase: SupabaseServerClient,
  officeId: string,
) {
  const { count } = await supabase
    .from("awards")
    .select("id", { count: "exact", head: true })
    .eq("office_id", officeId)
    .eq("status", "active");

  return count || 0;
}

async function fetchAllPages<Row>(
  queryPage: (from: number, to: number) => PromiseLike<{
    data: Row[] | null;
    error: unknown;
  }>,
) {
  const pageSize = 1000;
  const rows: Row[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await queryPage(from, from + pageSize - 1);
    if (error || !data?.length) break;

    rows.push(...data);
    if (data.length < pageSize) break;
  }

  return rows;
}

function mapSharedAwardIndex(
  sharedAwards: SharedAwardDirectoryRow[],
  officeAwards: TrackedOfficeAwardRow[],
) {
  const trackedSharedIds = new Set(
    officeAwards
      .map((award) => award.shared_award_id)
      .filter((id): id is string => Boolean(id)),
  );

  return sharedAwards.map((award) => {
    return {
      id: award.id,
      name: award.name,
      officialHomepage: award.official_homepage,
      summary: displayAwardSummary(award.summary),
      sourceCount: null,
      sourceIssueCount: null,
      changeCount: null,
      tracked: trackedSharedIds.has(award.id),
      detailsLoaded: false,
      sources: [],
      changes: [],
    };
  });
}

function buildWatchlistGroups(
  awards: OfficeAwardRow[],
  monitors: MonitorRow[],
  awardSources: OfficeAwardSourceRow[],
  sharedSources: SharedSourceDirectoryRow[],
): WatchlistAwardGroup[] {
  const monitorsByAward = groupBy(monitors, (monitor) => monitor.award_id || "standalone");
  const awardSourcesByAward = groupBy(awardSources, (source) => source.award_id);
  const sharedSourcesByAward = groupBy(sharedSources, (source) => source.shared_award_id);
  const groups = awards.map((award) => {
    const monitorRows = monitorsByAward.get(award.id) || [];
    const officeSources = awardSourcesByAward.get(award.id) || [];
    const sharedRows = award.shared_award_id
      ? filterTrackableOfficialSources(sharedSourcesByAward.get(award.shared_award_id) || [])
      : [];
    const sourcesByKey = new Map<string, WatchlistSource>();

    for (const source of sharedRows) {
      upsertWatchlistSource(sourcesByKey, {
        id: source.id,
        sharedAwardSourceId: source.id,
        monitorId: null,
        monitorSharedAwardSourceId: null,
        title: source.title,
        url: source.url,
        pageType: source.page_type,
        status: "untracked",
        cadence: null,
        lastCheckedAt: source.last_checked_at,
        lastError: source.last_error,
      });
    }

    for (const source of officeSources) {
      upsertWatchlistSource(sourcesByKey, {
        id: source.shared_award_source_id || source.id,
        sharedAwardSourceId: source.shared_award_source_id,
        monitorId: null,
        monitorSharedAwardSourceId: null,
        title: source.title,
        url: source.url,
        pageType: source.page_type,
        status: "untracked",
        cadence: null,
        lastCheckedAt: null,
        lastError: null,
      });
    }

    for (const monitor of monitorRows) {
      upsertWatchlistSource(sourcesByKey, {
        id: monitor.shared_award_source_id || monitor.id,
        sharedAwardSourceId: monitor.shared_award_source_id,
        monitorId: monitor.id,
        monitorSharedAwardSourceId: monitor.shared_award_source_id,
        title: monitor.source_label || monitor.label,
        url: monitor.url,
        pageType: monitor.page_type,
        status: monitor.status,
        cadence: monitor.cadence,
        lastCheckedAt: monitor.last_checked_at,
        lastError: monitor.last_error,
      });
    }

    return {
      id: award.id,
      sharedAwardId: award.shared_award_id,
      name: award.name,
      summary: displayAwardSummary(award.summary),
      officialHomepage: displayHomepageForAward(award.official_homepage, sharedRows),
      sources: [...sourcesByKey.values()].sort((a, b) => sortSource(a).localeCompare(sortSource(b))),
    };
  });

  const awardedIds = new Set(awards.map((award) => award.id));
  const standaloneMonitorGroups = monitors
    .filter((monitor) => !monitor.award_id || !awardedIds.has(monitor.award_id))
    .map((monitor) => ({
      id: `monitor:${monitor.id}`,
      sharedAwardId: null,
      name: monitor.label,
      summary: null,
      officialHomepage: monitor.url,
      sources: [
        {
          id: monitor.id,
          sharedAwardSourceId: monitor.shared_award_source_id,
          monitorId: monitor.id,
          monitorSharedAwardSourceId: monitor.shared_award_source_id,
          title: monitor.source_label || monitor.label,
          url: monitor.url,
          pageType: monitor.page_type,
          status: monitor.status,
          cadence: monitor.cadence,
          lastCheckedAt: monitor.last_checked_at,
          lastError: monitor.last_error,
        },
      ],
    }));

  return [...groups, ...standaloneMonitorGroups];
}

function groupBy<T>(values: T[], keyFor: (value: T) => string) {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    groups.set(key, [...(groups.get(key) || []), value]);
  }
  return groups;
}

function sortSource(source: WatchlistSource) {
  if (source.pageType === "homepage") return `0:${source.title}`;
  if (source.monitorId) return `1:${source.title}`;
  return `2:${source.title}`;
}
