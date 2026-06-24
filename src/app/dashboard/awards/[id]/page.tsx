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
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { canManageOffice, requireOfficeContext } from "@/lib/offices";
import {
  displayHomepageForAward,
  filterTrackableOfficialSources,
  isMonitorableOfficialSource,
} from "@/lib/source-url-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { unreadSharedChangeIdsForUser } from "@/lib/update-read-state";

type Params = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ source?: string; change?: string }>;
};

export default async function SharedAwardDetailPage({ params, searchParams }: Params) {
  if (!hasSupabaseConfig()) return <SetupNotice />;

  const user = await requireUser();
  const officeContext = await requireOfficeContext(user);
  const { id } = await params;
  const query = await searchParams;
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
        .eq("admin_review_status", "open")
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
  const unreadChangeIds = hasSupabaseAdminConfig()
    ? await unreadSharedChangeIdsForUser(user.id, officialChanges).catch(() => new Set<string>())
    : new Set<string>();
  const displayHomepage = displayHomepageForAward(award.official_homepage, officialSources);
  const awardSummary = displayAwardSummary(award.summary);
  const awardSummaryParts = awardBaselineSummaryParts(award.summary);
  const sourceTreeSources = officialSources.map((source) => ({
    id: source.id,
    title: source.title,
    displayTitle: source.display_title,
    pageDescription: source.page_description,
    pageMetadata: source.page_metadata,
    pageMetadataGeneratedAt: source.page_metadata_generated_at,
    pageMetadataModel: source.page_metadata_model,
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
      unread: unreadChangeIds.has(change.id),
    })),
  }));
  const recentOfficialChanges = officialChanges.slice(0, 10);

  return (
    <div className="award-detail-page">
      <div className="award-detail-command-row">
        <Link className="award-detail-back-link" href="/dashboard/awards">
          <ArrowLeft size={16} aria-hidden="true" />
          Back to find awards
        </Link>
        <TrackSharedAwardButton
          sharedAwardId={award.id}
          tracked={tracked}
          canManage={canManageOffice(officeContext.current.role)}
        />
      </div>

      <header className="award-detail-header">
        <div className="award-detail-meta-line">
          <span>{officialSources.length} source pages</span>
          <span>{officialChanges.length} recorded updates</span>
          {tracked && <span>On watchlist</span>}
        </div>

        <h1 className="award-detail-title">{award.name}</h1>

        {awardSummaryParts && awardSummaryParts.facts.length > 0 ? (
          <AwardBaselineDetails parts={awardSummaryParts} />
        ) : awardSummary ? (
          <p className="award-detail-summary-copy">{awardSummary}</p>
        ) : null}

        {displayHomepage && (
          <a
            className="award-detail-homepage"
            href={displayHomepage}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink size={15} aria-hidden="true" />
            <span className="truncate">{displayHomepage}</span>
          </a>
        )}
      </header>

      <main className="award-detail-record">
        <section className="award-detail-section">
          <div className="award-detail-section-heading">
            <h2>Page outline</h2>
            <p>
              Official source pages grouped into a readable outline. Expand a page to see
              extracted sections, facts, updates, and snapshots.
            </p>
          </div>
          <SourcePageTree
            groupByHost={false}
            initialSelectedSourceId={query.source || undefined}
            layout="split"
            selectedChangeId={query.change || undefined}
            sources={sourceTreeSources}
          />
        </section>

        <details className="award-detail-section award-detail-history">
          <summary>
            <span>Recent updates</span>
            <span>{officialChanges.length}</span>
          </summary>
          <div className="award-detail-update-list">
            {recentOfficialChanges.map((change) => (
              <article className="award-detail-update" key={change.id}>
                <div className="award-detail-update-heading">
                  <p>{change.source_title || "Shared source page"}</p>
                  <span>{formatDate(change.detected_at)}</span>
                </div>
                <a
                  className="award-detail-update-link"
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
                  sourceId={change.shared_award_source_id}
                  sourceUrl={change.source_url}
                  sourceTitle={change.source_title}
                  sourcePageTypeLabel={change.source_page_type ? pageTypeLabel(change.source_page_type) : null}
                  summary={displayChangeSummary(change.summary, change.source_url, change.change_details)}
                  changeDetails={change.change_details}
                  detectedAt={change.detected_at}
                />
              </article>
            ))}
            {officialChanges.length > recentOfficialChanges.length && (
              <p className="award-detail-history-note">
                Showing the {recentOfficialChanges.length} most recent updates.
              </p>
            )}
            {officialChanges.length === 0 && (
              <p className="text-[var(--muted)]">No updates have been recorded yet.</p>
            )}
          </div>
        </details>
      </main>
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
  const visibleFacts = parts.facts.filter(
    (fact) => fact.label.toLowerCase() !== "baseline detail confidence",
  );

  return (
    <div className="award-detail-facts">
      {parts.overview && <p className="award-detail-summary-copy">{parts.overview}</p>}
      {visibleFacts.length > 0 && (
        <dl className={`award-detail-fact-grid ${parts.overview ? "award-detail-fact-grid-spaced" : ""}`}>
          {visibleFacts.map((fact) => (
            <div className="award-detail-fact" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
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
