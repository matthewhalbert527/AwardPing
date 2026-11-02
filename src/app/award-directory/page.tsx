import type { ReactNode } from "react";
import { AwardDiscoveryWorkspace } from "@/components/award-discovery-workspace";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { compactAwardDirectorySummary } from "@/lib/award-summary";
import { canonicalAwardPath } from "@/lib/award-slugs";
import { dedupeChangeSummaries } from "@/lib/change-summary";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { publicAwardFactsFromAward } from "@/lib/public-award-facts";
import { assertStage1PublicationReleaseCurrent, loadEligiblePublicChangeEvents } from "@/lib/public-change-events";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadPublicRenderDirectoryPublicationIndex, loadPublicRenderPublicationIndex } from "@/lib/public-render-publication";

export const dynamic = "force-dynamic";

type SharedAwardRow = Database["public"]["Tables"]["shared_awards"]["Row"];
type SharedChangeRow = Database["public"]["Tables"]["shared_award_change_events"]["Row"];
type SharedAwardDirectoryRow = Pick<
  SharedAwardRow,
  "id" | "name" | "slug" | "official_homepage" | "summary" | "public_facts" | "public_facts_generated_at"
> & { completeSnapshot?: boolean; hasApplicationRoutes?: boolean; detailsCheckedAt: string | null; factsNeedReview?: boolean };
type SharedChangeDirectoryRow = Pick<
  SharedChangeRow,
  | "id"
  | "shared_award_id"
  | "shared_award_source_id"
  | "source_title"
  | "source_url"
  | "source_page_type"
  | "summary"
  | "change_details"
  | "suppressed_at"
  | "suppression_reason"
  | "suppression_source"
  | "visual_review_candidate_id"
  | "detected_at"
>;
// The directory is shown in one of three truthful states: awards loaded, none
// published right now, or unavailable (not configured, publication gates
// closed, or the catalog failed to load). Unavailable never shows a zero count
// or a search box as if an empty catalog had loaded.
type DirectoryCatalog =
  | {
      status: "ready";
      awards: ReturnType<typeof mapSharedAwards>;
    }
  | { status: "empty" }
  | { status: "unavailable" };

const DIRECTORY_EMPTY_NOTICE = "No awards are published right now.";
const DIRECTORY_UNAVAILABLE_NOTICE =
  "The award directory is unavailable right now. Please check back soon.";

export default async function AwardDirectoryPage() {
  // Missing configuration uses the same frame and unavailable notice without
  // attempting to load the catalog.
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return (
      <DirectoryFrame>
        <DirectoryNotice status="unavailable" />
      </DirectoryFrame>
    );
  }

  // Browse results are identical for every visitor. The shared header handles
  // authentication; the directory does not need office membership or follows.
  const catalog = await loadDirectoryCatalog();
  if (catalog.status !== "ready") {
    return (
      <DirectoryFrame>
        <DirectoryNotice status={catalog.status} />
      </DirectoryFrame>
    );
  }

  return (
    <DirectoryFrame>
      <AwardDiscoveryWorkspace
        sharedAwards={catalog.awards}
        presentationAsOf={new Date().toISOString()}
        canManage={false}
        isAuthenticated={false}
      />
    </DirectoryFrame>
  );
}

// Heading, intro, header and footer are the same in every state.
function DirectoryFrame({ children }: { children: ReactNode }) {
  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="public-directory-main">
        <div className="public-directory-heading">
          <div>
            <h1 className="display-title">Award directory</h1>
            <p>Find an award, check its deadline, and see what changed.</p>
          </div>
        </div>

        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

function DirectoryNotice({ status }: { status: "empty" | "unavailable" }) {
  return (
    <p className="card rounded-3xl p-6 text-sm font-semibold text-[var(--text-secondary)]">
      {status === "empty" ? DIRECTORY_EMPTY_NOTICE : DIRECTORY_UNAVAILABLE_NOTICE}
    </p>
  );
}

// Only the catalog load is caught; a failure becomes the unavailable notice.
async function loadDirectoryCatalog(): Promise<DirectoryCatalog> {
  try {
    return await getSharedCatalog();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "The award directory could not be loaded.");
    return { status: "unavailable" };
  }
}

async function getSharedCatalog(): Promise<DirectoryCatalog> {
  const admin = createSupabaseAdminClient();
  const authority = await loadPublicRenderPublicationIndex();
  if (!authority.available) return { status: "unavailable" };
  if (authority.verifiedEntries.length === 0) return { status: "empty" };

  // Both lanes use the same render-local identity/source authority. Facts do
  // not grant event permission; the event reader retains every evidence gate.
  const [publicationIndex, eligibleEvents] = await Promise.all([
    loadPublicRenderDirectoryPublicationIndex(),
    loadEligiblePublicChangeEvents({ admin, publicationIndex: authority, limit: null }),
  ]);
  if (!publicationIndex.available) return { status: "unavailable" };
  if (publicationIndex.verifiedEntries.length === 0) return { status: "empty" };
  // The event lane can finish first. Recheck after the slower lane too, so a
  // release suspended during fact hydration never reaches the directory.
  await assertStage1PublicationReleaseCurrent(admin, authority);

  const sharedAwards: SharedAwardDirectoryRow[] = publicationIndex.verifiedEntries.map(
    (publication) => ({
      id: publication.canonicalAwardId,
      name: publication.registry.canonical_name,
      slug: publication.registry.canonical_slug,
      official_homepage: publication.registry.official_homepage,
      summary: null,
      public_facts: publication.publishedFacts,
      public_facts_generated_at: publication.basicFactSnapshot?.verifiedAt || (publication.basicFactsUnavailable ? null : publication.textFactReview?.reviewedAt || publication.registry.last_verified_at),
      detailsCheckedAt: publication.basicFactSnapshot?.current === true ? publication.basicFactSnapshot.verifiedAt : null,
      factsNeedReview: Boolean(publication.basicFactsUnavailable || (publication.basicFactSnapshot && !publication.basicFactSnapshot.current)),
      completeSnapshot: Boolean(publication.basicFactSnapshot || publication.basicFactsUnavailable || publication.textFactReview),
      hasApplicationRoutes: !publication.basicFactSnapshot && !publication.basicFactsUnavailable && (publication.textFactReview?.variationCount || 0) > 0,
    }),
  );
  const canonicalChanges = eligibleEvents.map(({ event, publication }) => ({
    ...event,
    shared_award_id: publication.canonicalAwardId,
  }));

  return {
    status: "ready",
    awards: mapSharedAwards(
      sharedAwards,
      groupBySharedAwardId(canonicalChanges),
    ),
  };
}

function mapSharedAwards(
  sharedAwards: SharedAwardDirectoryRow[],
  sharedChangesByAwardId: Map<string, SharedChangeDirectoryRow[]>,
) {
  return sharedAwards.map((award) => {
    const facts = publicAwardFactsFromAward({
      summary: award.summary,
      publicFacts: award.public_facts,
      completeSnapshot: award.completeSnapshot,
    });
    const changes = dedupeChangeSummaries(
      sharedChangesByAwardId.get(award.id) || [],
    );

    return {
      id: award.id,
      name: award.name,
      slug: award.slug,
      publicPath: canonicalAwardPath(award.slug, award.name, award.id),
      officialHomepage: award.official_homepage,
      summary: compactAwardDirectorySummary(facts.overview || award.summary, award.name),
      deadline: facts.deadline,
      cycleStatus: facts.cycleStatus,
      openingDate: facts.openingDate,
      hasApplicationRoutes: award.hasApplicationRoutes,
      factsNeedReview: award.factsNeedReview,
      importantDates: facts.importantDates,
      academicLevels: facts.academicLevels,
      disciplines: facts.disciplines,
      citizenship: facts.citizenship,
      lastCheckedAt: null,
      recentlyUpdated: changes.length > 0,
      sourceCount: null,
      sourceIssueCount: null,
      changeCount: changes.length,
      // Eligible public events are loaded newest-first before canonical deduplication.
      latestUpdateAt: changes[0]?.detected_at ?? null,
      detailsCheckedAt: award.detailsCheckedAt,
      tracked: false,
      detailsLoaded: false,
      sources: [],
      changes: [],
    };
  });
}

function groupBySharedAwardId<Row extends { shared_award_id: string }>(rows: Row[]) {
  const grouped = new Map<string, Row[]>();

  for (const row of rows) {
    const existing = grouped.get(row.shared_award_id);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.shared_award_id, [row]);
    }
  }

  return grouped;
}
