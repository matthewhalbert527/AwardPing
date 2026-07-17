import { AwardDiscoveryWorkspace } from "@/components/award-discovery-workspace";
import { SetupNotice } from "@/components/setup-notice";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { compactAwardDirectorySummary } from "@/lib/award-summary";
import { canonicalAwardPath } from "@/lib/award-slugs";
import { dedupeChangeSummaries } from "@/lib/change-summary";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { canManageOffice, getOfficeContext } from "@/lib/offices";
import { publicAwardFactsFromAward } from "@/lib/public-award-facts";
import { loadEligiblePublicChangeEvents } from "@/lib/public-change-events";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadStage1PublicationIndex } from "@/lib/stage1-publication";

export const dynamic = "force-dynamic";

type AwardRow = Database["public"]["Tables"]["awards"]["Row"];
type SharedAwardRow = Database["public"]["Tables"]["shared_awards"]["Row"];
type SharedChangeRow = Database["public"]["Tables"]["shared_award_change_events"]["Row"];
type OfficeAwardTrackingRow = Pick<AwardRow, "shared_award_id">;
type SharedAwardDirectoryRow = Pick<
  SharedAwardRow,
  "id" | "name" | "slug" | "official_homepage" | "summary" | "public_facts" | "public_facts_generated_at"
>;
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
export default async function AwardDirectoryPage() {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return (
      <div className="page-shell">
        <SiteHeader />
        <main className="mx-auto max-w-6xl px-5 py-14">
          <SetupNotice />
        </main>
        <SiteFooter />
      </div>
    );
  }

  const user = await getCurrentUser();
  const [officeContext, sharedCatalogBase] = await Promise.all([
    user ? getOfficeContext(user) : Promise.resolve(null),
    getSharedCatalog(),
  ]);
  const admin = createSupabaseAdminClient();
  const { data: awards } = officeContext
    ? await admin
        .from("awards")
        .select("shared_award_id")
        .eq("office_id", officeContext.current.officeId)
        .eq("status", "active")
    : { data: [] as OfficeAwardTrackingRow[] };
  const sharedCatalog = withTrackedSharedAwards(
    sharedCatalogBase.awards,
    awards || [],
    sharedCatalogBase.canonicalAwardIdByMember,
  );

  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-5 py-10 lg:py-12">
        <div className="mb-5 max-w-3xl">
          <h1 className="text-4xl font-black md:text-5xl">Explore the award directory</h1>
          <p className="mt-3 text-base leading-7 text-[var(--muted)] md:text-lg md:leading-8">
            Search the awards AwardPing already checks. Expand any award to see
            its official source tree and recent update history.
          </p>
        </div>

        <AwardDiscoveryWorkspace
          sharedAwards={sharedCatalog}
          canManage={officeContext ? canManageOffice(officeContext.current.role) : false}
          isAuthenticated={Boolean(user)}
        />
      </main>
      <SiteFooter />
    </div>
  );
}

async function getSharedCatalog() {
  const admin = createSupabaseAdminClient();
  const publicationIndex = await loadStage1PublicationIndex();
  const canonicalAwardIdByMember = new Map(
    [...publicationIndex.entryByMemberAwardId.entries()].map(
      ([memberAwardId, entry]) => [memberAwardId, entry.canonicalAwardId],
    ),
  );
  if (!publicationIndex.available || publicationIndex.verifiedEntries.length === 0) {
    return { awards: [], canonicalAwardIdByMember };
  }

  const sharedAwards: SharedAwardDirectoryRow[] = publicationIndex.verifiedEntries.map(
    (publication) => ({
      id: publication.canonicalAwardId,
      name: publication.registry.canonical_name,
      slug: publication.registry.canonical_slug,
      official_homepage: publication.registry.official_homepage,
      summary: null,
      public_facts: publication.publishedFacts,
      public_facts_generated_at: publication.registry.last_verified_at,
    }),
  );
  const eligibleEvents = await loadEligiblePublicChangeEvents({
    admin,
    publicationIndex,
    limit: null,
  });
  const canonicalChanges = eligibleEvents.map(({ event, publication }) => ({
    ...event,
    shared_award_id: publication.canonicalAwardId,
  }));

  return {
    awards: mapSharedAwards(
      sharedAwards,
      groupBySharedAwardId(canonicalChanges),
      new Set<string>(),
    ),
    canonicalAwardIdByMember,
  };
}

function mapSharedAwards(
  sharedAwards: SharedAwardDirectoryRow[],
  sharedChangesByAwardId: Map<string, SharedChangeDirectoryRow[]>,
  trackedSharedIds: Set<string>,
) {
  return sharedAwards.map((award) => {
    const facts = publicAwardFactsFromAward({
      summary: award.summary,
      publicFacts: award.public_facts,
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
      academicLevels: facts.academicLevels,
      disciplines: facts.disciplines,
      citizenship: facts.citizenship,
      lastCheckedAt: null,
      recentlyUpdated: changes.length > 0,
      sourceCount: null,
      sourceIssueCount: null,
      changeCount: changes.length,
      tracked: trackedSharedIds.has(award.id),
      detailsLoaded: false,
      sources: [],
      changes: [],
    };
  });
}

function withTrackedSharedAwards(
  sharedAwards: ReturnType<typeof mapSharedAwards>,
  officeAwards: OfficeAwardTrackingRow[],
  canonicalAwardIdByMember: Map<string, string>,
) {
  const trackedSharedIds = new Set(
    officeAwards
      .map((award) => award.shared_award_id)
      .filter((id): id is string => Boolean(id))
      .map((id) => canonicalAwardIdByMember.get(id) || id),
  );

  if (trackedSharedIds.size === 0) return sharedAwards;
  return sharedAwards.map((award) =>
    trackedSharedIds.has(award.id) ? { ...award, tracked: true } : award,
  );
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
