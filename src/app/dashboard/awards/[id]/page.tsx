import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { ChangeEvidencePanel } from "@/components/change-evidence-panel";
import { ChangeSummaryDisplay } from "@/components/change-summary-display";
import { SourcePageTree } from "@/components/source-page-tree";
import { SetupNotice } from "@/components/setup-notice";
import { TrackSharedAwardButton } from "@/components/track-shared-award-button";
import { pageTypeLabel } from "@/lib/award-discovery-types";
import { requireUser } from "@/lib/auth";
import { awardBaselineSummaryParts, displayAwardSummary } from "@/lib/award-summary";
import {
  dedupeChangeSummaries,
  displayChangeSummary,
  isUsefulChangeForAward,
} from "@/lib/change-summary";
import { hasSupabaseConfig } from "@/lib/config";
import { canManageOffice, requireOfficeContext } from "@/lib/offices";
import {
  displayHomepageForAward,
  filterTrackableOfficialSources,
  isMonitorableOfficialSource,
} from "@/lib/source-url-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Params = {
  params: Promise<{ id: string }>;
};

export default async function SharedAwardDetailPage({ params }: Params) {
  if (!hasSupabaseConfig()) return <SetupNotice />;

  const user = await requireUser();
  const officeContext = await requireOfficeContext(user);
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const [{ data: award }, { data: sources }, { data: changes }, { data: officeAward }] =
    await Promise.all([
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
        .order("page_type", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("shared_award_change_events")
        .select("*")
        .eq("shared_award_id", id)
        .order("detected_at", { ascending: false })
        .limit(50),
      supabase
        .from("awards")
        .select("id")
        .eq("office_id", officeContext.current.officeId)
        .eq("shared_award_id", id)
        .eq("status", "active")
        .maybeSingle(),
    ]);

  if (!award) {
    return (
      <div>
        <Link className="button-secondary" href="/dashboard/awards">
          <ArrowLeft size={16} aria-hidden="true" />
          Back to find awards
        </Link>
        <div className="card mt-6 rounded-3xl p-6 text-[var(--muted)]">
          Award was not found in the shared database.
        </div>
      </div>
    );
  }

  const tracked = Boolean(officeAward);
  const officialSources = filterTrackableOfficialSources(sources || []);
  const officialChanges = dedupeChangeSummaries(
    (changes || []).filter((change) =>
      isMonitorableOfficialSource({ url: change.source_url, page_type: change.source_page_type }) &&
        isUsefulChangeForAward({
          awardName: award.name,
          sourceTitle: change.source_title,
          sourceUrl: change.source_url,
          summary: change.summary,
          change_details: change.change_details,
      }),
    ),
  );
  const snapshotById = await fetchSnapshotSamples(
    supabase,
    snapshotIdsForChanges(officialChanges),
  );
  const displayHomepage = displayHomepageForAward(award.official_homepage, officialSources);
  const awardSummary = displayAwardSummary(award.summary);
  const awardSummaryParts = awardBaselineSummaryParts(award.summary);

  return (
    <div>
      <Link className="button-secondary" href="/dashboard/awards">
        <ArrowLeft size={16} aria-hidden="true" />
        Back to find awards
      </Link>

      <div className="mt-8 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div className="flex flex-wrap gap-2">
            <span className="badge">{officialSources.length} source pages</span>
            <span className="badge">{officialChanges.length} recorded updates</span>
            {tracked && <span className="badge">On watchlist</span>}
          </div>
          <h1 className="dashboard-page-title mt-4">{award.name}</h1>
          {awardSummaryParts && awardSummaryParts.facts.length > 0 ? (
            <AwardBaselineDetails parts={awardSummaryParts} />
          ) : awardSummary && (
            <p className="mt-3 max-w-3xl leading-7 text-[var(--muted)]">{awardSummary}</p>
          )}
          {displayHomepage && (
            <a
              className="mt-3 inline-flex max-w-full items-center gap-2 truncate text-sm font-bold text-[var(--brand)] underline"
              href={displayHomepage}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink size={15} aria-hidden="true" />
              <span className="truncate">{displayHomepage}</span>
            </a>
          )}
        </div>
        <div className="dashboard-panel dashboard-panel-pad">
          <h2 className="dashboard-panel-title">Watchlist</h2>
          <p className="dashboard-panel-copy">
            You can view this history without adding it. Add it when your office
            wants the award on its own watchlist.
          </p>
          <div className="mt-4">
            <TrackSharedAwardButton
              sharedAwardId={award.id}
              tracked={tracked}
              canManage={canManageOffice(officeContext.current.role)}
            />
          </div>
        </div>
      </div>

      <section className="mt-8 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="dashboard-panel dashboard-panel-pad min-w-0">
          <h2 className="dashboard-panel-title">Sites checked</h2>
          <p className="dashboard-panel-copy">
            Official source pages are grouped by site so you can review the source structure
            without a long flat list.
          </p>
          <div className="dashboard-list">
            <SourcePageTree
              sources={officialSources.map((source) => ({
                id: source.id,
                title: source.title,
                url: source.url,
                pageType: source.page_type,
                lastCheckedAt: source.last_checked_at,
                lastError: source.last_error,
                latestChanges: latestChangesForSource(source, officialChanges).slice(0, 3).map((change) => ({
                  id: change.id,
                  sourceTitle: change.source_title,
                  sourceUrl: change.source_url,
                  sourcePageType: change.source_page_type,
                  summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
                  changeDetails: change.change_details,
                  detectedAt: change.detected_at,
                  previousTextSample: change.previous_snapshot_id
                    ? snapshotById.get(change.previous_snapshot_id) || null
                    : null,
                  newTextSample: change.new_snapshot_id
                    ? snapshotById.get(change.new_snapshot_id) || null
                    : null,
                })),
              }))}
            />
          </div>
        </div>

        <div className="dashboard-panel dashboard-panel-pad min-w-0">
          <h2 className="dashboard-panel-title">Update history</h2>
          <p className="dashboard-panel-copy">
            This history stays with the shared award, including updates found
            before your office added it to the watchlist.
          </p>
          <div className="dashboard-list">
            {officialChanges.map((change) => (
              <article className="dashboard-list-item min-w-0" key={change.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-black">{change.source_title || "Shared source page"}</p>
                  <span className="badge">{formatDate(change.detected_at)}</span>
                </div>
                <a
                  className="mt-1 block truncate text-sm font-semibold text-[var(--brand)] underline"
                  href={change.source_url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {change.source_url}
                </a>
                <ChangeSummaryDisplay
                  summary={displayChangeSummary(change.summary, change.source_url, change.change_details)}
                  sourceUrl={change.source_url}
                  sourceTitle={change.source_title}
                  changeDetails={change.change_details}
                />
                <ChangeEvidencePanel
                  changeId={change.id}
                  changeKind="shared"
                  sourceUrl={change.source_url}
                  sourceTitle={change.source_title}
                  sourcePageTypeLabel={change.source_page_type ? pageTypeLabel(change.source_page_type) : null}
                  summary={displayChangeSummary(change.summary, change.source_url, change.change_details)}
                  changeDetails={change.change_details}
                  detectedAt={change.detected_at}
                  previousTextSample={change.previous_snapshot_id
                    ? snapshotById.get(change.previous_snapshot_id) || null
                    : null}
                  newTextSample={change.new_snapshot_id
                    ? snapshotById.get(change.new_snapshot_id) || null
                    : null}
                />
              </article>
            ))}
            {officialChanges.length === 0 && (
              <p className="text-[var(--muted)]">No updates have been recorded yet.</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function AwardBaselineDetails({
  parts,
}: {
  parts: {
    overview: string | null;
    facts: Array<{ label: string; value: string }>;
  };
}) {
  return (
    <div className="mt-4 max-w-4xl rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4">
      {parts.overview && <p className="leading-7 text-[var(--muted)]">{parts.overview}</p>}
      <dl className={`${parts.overview ? "mt-4" : ""} grid gap-3 md:grid-cols-2`}>
        {parts.facts.map((fact) => (
          <div className="rounded-xl border border-[var(--line)] bg-white p-3" key={fact.label}>
            <dt className="text-xs font-black uppercase text-[var(--muted)]">{fact.label}</dt>
            <dd className="mt-1 text-sm font-semibold leading-6 text-[var(--foreground)]">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

async function fetchSnapshotSamples(
  supabase: SupabaseServerClient,
  snapshotIds: string[],
) {
  if (snapshotIds.length === 0) return new Map<string, string>();

  const { data } = await supabase
    .from("shared_award_source_snapshots")
    .select("id, text_sample")
    .in("id", snapshotIds);

  return new Map((data || []).map((snapshot) => [snapshot.id, snapshot.text_sample]));
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
