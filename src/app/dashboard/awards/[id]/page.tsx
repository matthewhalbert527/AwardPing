import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { SourcePageTree } from "@/components/source-page-tree";
import { SetupNotice } from "@/components/setup-notice";
import { TrackSharedAwardButton } from "@/components/track-shared-award-button";
import { requireUser } from "@/lib/auth";
import { canonicalAwardPath, dashboardAwardPath, normalizeAwardSlug } from "@/lib/award-slugs";
import { awardBaselineSummaryParts, displayAwardSummary } from "@/lib/award-summary";
import {
  dedupeChangeSummaries,
  displayChangeSummary,
  isUsefulChangeForAward,
} from "@/lib/change-summary";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { readableSourceTitle } from "@/lib/display-text";
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

type SharedAwardRow = Database["public"]["Tables"]["shared_awards"]["Row"];

export default async function SharedAwardDetailPage({ params, searchParams }: Params) {
  if (!hasSupabaseConfig()) return <SetupNotice />;

  const user = await requireUser();
  const officeContext = await requireOfficeContext(user);
  const { id } = await params;
  const query = await searchParams;
  const supabase = await createSupabaseServerClient();
  const resolvedAward = await resolveSharedAwardForDashboard(supabase, id);

  if (resolvedAward.award && resolvedAward.shouldRedirect) {
    redirect(`${dashboardAwardPath(resolvedAward.award.slug, resolvedAward.award.name, resolvedAward.award.id)}${queryString(query)}`);
  }

  const awardId = resolvedAward.award?.id || id;

  const [{ data: sources }, { data: changes }, { data: officeAward }] =
    await Promise.all([
      supabase
        .from("shared_award_sources")
        .select("*")
        .eq("shared_award_id", awardId)
        .eq("admin_review_status", "open")
        .order("page_type", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("shared_award_change_events")
        .select("*")
        .eq("shared_award_id", awardId)
        .order("detected_at", { ascending: false })
        .limit(50),
      supabase
        .from("awards")
        .select("id")
        .eq("office_id", officeContext.current.officeId)
        .eq("shared_award_id", awardId)
        .eq("status", "active")
        .maybeSingle(),
    ]);
  const award = resolvedAward.award;

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
      sourceTitle: readableSourceTitle(change.source_title, change.source_url),
      sourceUrl: change.source_url,
      sourcePageType: change.source_page_type,
      summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
      changeDetails: change.change_details,
      detectedAt: change.detected_at,
      unread: unreadChangeIds.has(change.id),
    })),
  }));

  return (
    <div className="award-detail-page">
      <div className="award-detail-command-row">
        <Link className="award-detail-back-link" href="/dashboard/awards">
          <ArrowLeft size={16} aria-hidden="true" />
          Back to find awards
        </Link>
        <Link className="button-secondary" href={canonicalAwardPath(award.slug, award.name, award.id)}>
          Public page
          <ExternalLink size={16} aria-hidden="true" />
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
            <span>Official homepage</span>
          </a>
        )}
      </header>

      <main className="award-detail-record award-detail-record-console">
        <SourcePageTree
          groupByHost={false}
          initialSelectedSourceId={query.source || undefined}
          layout="split"
          selectedChangeId={query.change || undefined}
          sources={sourceTreeSources}
        />
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
  const compactFacts = visibleFacts.slice(0, 6);

  return (
    <div className="award-detail-facts">
      {parts.overview && <p className="award-detail-summary-copy">{parts.overview}</p>}
      {compactFacts.length > 0 && (
        <dl className={`award-detail-fact-grid ${parts.overview ? "award-detail-fact-grid-spaced" : ""}`}>
          {compactFacts.map((fact) => (
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

async function resolveSharedAwardForDashboard(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  identifier: string,
): Promise<{ award: SharedAwardRow | null; shouldRedirect: boolean }> {
  const normalized = normalizeAwardSlug(identifier);

  if (isUuid(identifier)) {
    const { data } = await supabase
      .from("shared_awards")
      .select("*")
      .eq("id", identifier)
      .eq("status", "active")
      .maybeSingle();

    return {
      award: data,
      shouldRedirect: Boolean(data?.slug),
    };
  }

  const { data: direct } = await supabase
    .from("shared_awards")
    .select("*")
    .eq("slug", normalized)
    .eq("status", "active")
    .maybeSingle();

  if (direct) {
    return {
      award: direct,
      shouldRedirect: identifier !== normalized || direct.slug !== normalized,
    };
  }

  const { data: alias } = await supabase
    .from("shared_award_slug_aliases")
    .select("slug, shared_awards!inner(*)")
    .eq("slug", normalized)
    .eq("shared_awards.status", "active")
    .maybeSingle();

  return {
    award: embeddedSharedAward(alias?.shared_awards),
    shouldRedirect: Boolean(alias),
  };
}

function embeddedSharedAward(value: unknown) {
  if (Array.isArray(value)) return embeddedSharedAward(value[0]);
  return value && typeof value === "object" ? value as SharedAwardRow : null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function queryString(query: { source?: string; change?: string }) {
  const params = new URLSearchParams();
  if (query.source) params.set("source", query.source);
  if (query.change) params.set("change", query.change);
  const value = params.toString();
  return value ? `?${value}` : "";
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
