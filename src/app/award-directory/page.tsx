import { AwardDiscoveryWorkspace } from "@/components/award-discovery-workspace";
import { SetupNotice } from "@/components/setup-notice";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { compactAwardDirectorySummary } from "@/lib/award-summary";
import { canonicalAwardPath } from "@/lib/award-slugs";
import { dedupeChangeSummaries, isUsefulChangeForAward } from "@/lib/change-summary";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { canManageOffice, getOfficeContext } from "@/lib/offices";
import { publicAwardFactsFromAward } from "@/lib/public-award-facts";
import { isMonitorableOfficialSource } from "@/lib/source-url-policy";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type AwardRow = Database["public"]["Tables"]["awards"]["Row"];
type SharedAwardRow = Database["public"]["Tables"]["shared_awards"]["Row"];
type SharedChangeRow = Database["public"]["Tables"]["shared_award_change_events"]["Row"];
type SharedAwardDirectoryRow = Pick<
  SharedAwardRow,
  "id" | "name" | "slug" | "official_homepage" | "summary" | "public_facts" | "public_facts_generated_at"
>;
type SharedChangeDirectoryRow = Pick<
  SharedChangeRow,
  "shared_award_id" | "source_url" | "source_page_type" | "summary" | "change_details"
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
  const officeContext = user ? await getOfficeContext(user) : null;
  const admin = createSupabaseAdminClient();
  const [sharedAwards, { data: sharedChanges }, { data: awards }] =
    await Promise.all([
      fetchAllSharedAwards(admin),
      admin
        .from("shared_award_change_events")
        .select("shared_award_id, source_url, source_page_type, summary, change_details")
        .order("detected_at", { ascending: false })
        .limit(1000),
      officeContext
        ? admin
            .from("awards")
            .select("*")
            .eq("office_id", officeContext.current.officeId)
            .eq("status", "active")
        : Promise.resolve({ data: [] as AwardRow[] }),
    ]);

  const sharedCatalog = mapSharedAwards(
    sharedAwards,
    groupBySharedAwardId(sharedChanges || []),
    awards || [],
  );

  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-5 py-10 lg:py-12">
        <div className="mb-5 max-w-3xl">
          <h1 className="text-4xl font-black md:text-5xl">Explore the award database</h1>
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

type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;

async function fetchAllSharedAwards(supabase: SupabaseAdminClient) {
  return fetchAllPages<SharedAwardDirectoryRow>((from, to) =>
    supabase
      .from("shared_awards")
      .select("id, name, slug, official_homepage, summary, public_facts, public_facts_generated_at")
      .eq("status", "active")
      .order("name", { ascending: true })
      .range(from, to),
  );
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

function mapSharedAwards(
  sharedAwards: SharedAwardDirectoryRow[],
  sharedChangesByAwardId: Map<string, SharedChangeDirectoryRow[]>,
  officeAwards: AwardRow[],
) {
  const trackedSharedIds = new Set(
    officeAwards
      .map((award) => award.shared_award_id)
      .filter((id): id is string => Boolean(id)),
  );

  return sharedAwards.map((award) => {
    const facts = publicAwardFactsFromAward({
      summary: award.summary,
      publicFacts: award.public_facts,
    });
    const changes = dedupeChangeSummaries(
      (sharedChangesByAwardId.get(award.id) || []).filter((change) =>
        isMonitorableOfficialSource({ url: change.source_url, page_type: change.source_page_type }) &&
        isUsefulChangeForAward({
          awardName: award.name,
          sourceUrl: change.source_url,
          summary: change.summary,
          change_details: change.change_details,
        }),
      ),
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
