import { canonicalAwardPath, normalizeAwardSlug, withUniqueAwardSourceSlugs } from "@/lib/award-slugs";
import {
  latestCheckedAt,
  publicAwardFactsFromAward,
  publicAwardMetaDescription,
} from "@/lib/public-award-facts";
import {
  dedupeChangeSummaries,
  displayChangeSummary,
  isUsefulChangeForAward,
} from "@/lib/change-summary";
import type { AwardPageType } from "@/lib/award-discovery-types";
import type { Database, Json } from "@/lib/database.types";
import { readableSourceTitle } from "@/lib/display-text";
import {
  displayHomepageForAward,
  filterTrackableOfficialSources,
  isMonitorableOfficialSource,
} from "@/lib/source-url-policy";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type SharedAwardRow = Pick<
  Database["public"]["Tables"]["shared_awards"]["Row"],
  | "id"
  | "name"
  | "slug"
  | "official_homepage"
  | "summary"
  | "public_facts"
  | "public_facts_generated_at"
  | "updated_at"
>;

type SharedSourceRow = Pick<
  Database["public"]["Tables"]["shared_award_sources"]["Row"],
  | "id"
  | "shared_award_id"
  | "url"
  | "title"
  | "display_title"
  | "page_description"
  | "page_metadata"
  | "page_type"
  | "last_checked_at"
>;

type SharedChangeRow = Pick<
  Database["public"]["Tables"]["shared_award_change_events"]["Row"],
  | "id"
  | "shared_award_id"
  | "shared_award_source_id"
  | "source_title"
  | "source_url"
  | "source_page_type"
  | "summary"
  | "change_details"
  | "detected_at"
>;

export type PublicAwardPageData = {
  award: SharedAwardRow;
  canonicalPath: string;
  redirectPath: string | null;
  facts: ReturnType<typeof publicAwardFactsFromAward>;
  metaDescription: string;
  officialHomepage: string | null;
  lastCheckedAt: string | null;
  sources: Array<{
    id: string;
    sourceSlug: string;
    publicPath: string;
    title: string;
    description: string | null;
    url: string;
    pageType: AwardPageType;
    lastCheckedAt: string | null;
    facts: ReturnType<typeof publicAwardFactsFromAward>;
  }>;
  changes: Array<{
    id: string;
    sourceId: string | null;
    sourceTitle: string;
    sourceUrl: string;
    sourcePageType: AwardPageType | null;
    summary: string;
    changeDetails: Json;
    detectedAt: string;
  }>;
};

export type PublicAwardSourcePageData = PublicAwardPageData & {
  source: PublicAwardPageData["sources"][number];
  sourceChanges: PublicAwardPageData["changes"];
};

export async function getPublicAwardPageBySlug(slug: string): Promise<PublicAwardPageData | null> {
  const normalizedSlug = normalizeAwardSlug(slug);
  if (!normalizedSlug) return null;

  const admin = createSupabaseAdminClient();
  const direct = await admin
    .from("shared_awards")
    .select("id, name, slug, official_homepage, summary, public_facts, public_facts_generated_at, updated_at")
    .eq("slug", normalizedSlug)
    .eq("status", "active")
    .maybeSingle();

  if (direct.error) throw direct.error;
  if (direct.data) {
    return loadPublicAwardPageData(direct.data as SharedAwardRow, null);
  }

  const alias = await admin
    .from("shared_award_slug_aliases")
    .select("slug, shared_awards!inner(id, name, slug, official_homepage, summary, public_facts, public_facts_generated_at, updated_at, status)")
    .eq("slug", normalizedSlug)
    .eq("shared_awards.status", "active")
    .maybeSingle();

  if (alias.error) throw alias.error;
  const embeddedAward = embeddedSharedAward(alias.data?.shared_awards);
  if (!embeddedAward) return null;

  return loadPublicAwardPageData(
    embeddedAward,
    canonicalAwardPath(embeddedAward.slug, embeddedAward.name, embeddedAward.id),
  );
}

export async function getPublicAwardSourcePageBySlugs(
  awardSlug: string,
  sourceSlug: string,
): Promise<PublicAwardSourcePageData | null> {
  const awardPage = await getPublicAwardPageBySlug(awardSlug);
  if (!awardPage) return null;

  const normalizedSourceSlug = normalizeAwardSlug(sourceSlug);
  const source = awardPage.sources.find((candidate) => candidate.sourceSlug === normalizedSourceSlug);
  if (!source) return null;

  const canonicalSourcePath = `${awardPage.canonicalPath}/${source.sourceSlug}`;
  const awardRedirectPath = awardPage.redirectPath ? `${awardPage.redirectPath}/${source.sourceSlug}` : null;
  const sourceRedirectPath = normalizedSourceSlug === source.sourceSlug ? null : canonicalSourcePath;

  return {
    ...awardPage,
    redirectPath: awardRedirectPath || sourceRedirectPath,
    source,
    sourceChanges: awardPage.changes.filter(
      (change) =>
        change.sourceId === source.id ||
        normalizeUrl(change.sourceUrl) === normalizeUrl(source.url),
    ),
  };
}

export async function getPublicAwardSitemapRows(limit = 50000) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("shared_awards")
    .select("id, name, slug, updated_at")
    .eq("status", "active")
    .not("slug", "is", null)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data || []).map((award) => ({
    urlPath: canonicalAwardPath(award.slug, award.name, award.id),
    updatedAt: award.updated_at,
  }));
}

export async function getPublicAwardSourceSitemapRows(limit = 50000) {
  const admin = createSupabaseAdminClient();
  const { data: awards, error: awardError } = await admin
    .from("shared_awards")
    .select("id, name, slug, updated_at")
    .eq("status", "active")
    .not("slug", "is", null)
    .limit(limit);

  if (awardError) return [];

  const activeAwardById = new Map((awards || []).map((award) => [award.id, award]));
  const sourceRows = await loadOpenSourceRowsForSitemap(limit);
  const sourcesByAwardId = new Map<string, SharedSourceRow[]>();

  for (const source of sourceRows) {
    if (!activeAwardById.has(source.shared_award_id)) continue;
    const sources = sourcesByAwardId.get(source.shared_award_id) || [];
    sources.push(source);
    sourcesByAwardId.set(source.shared_award_id, sources);
  }

  const rows: Array<{ urlPath: string; updatedAt: string | null }> = [];
  for (const [awardId, sources] of sourcesByAwardId.entries()) {
    const award = activeAwardById.get(awardId);
    if (!award) continue;
    const awardPath = canonicalAwardPath(award.slug, award.name, award.id);
    for (const source of withUniqueAwardSourceSlugs(filterTrackableOfficialSources(sources))) {
      rows.push({
        urlPath: `${awardPath}/${source.sourceSlug}`,
        updatedAt: source.last_checked_at || award.updated_at,
      });
      if (rows.length >= limit) return rows;
    }
  }

  return rows;
}

async function loadPublicAwardPageData(
  award: SharedAwardRow,
  redirectPath: string | null,
): Promise<PublicAwardPageData> {
  const admin = createSupabaseAdminClient();
  const [{ data: sources }, { data: changes }] = await Promise.all([
    admin
      .from("shared_award_sources")
      .select("id, shared_award_id, url, title, display_title, page_description, page_metadata, page_type, last_checked_at")
      .eq("shared_award_id", award.id)
      .eq("admin_review_status", "open")
      .order("page_type", { ascending: true })
      .order("created_at", { ascending: true }),
    admin
      .from("shared_award_change_events")
      .select("id, shared_award_id, shared_award_source_id, source_title, source_url, source_page_type, summary, change_details, detected_at")
      .eq("shared_award_id", award.id)
      .order("detected_at", { ascending: false })
      .limit(20),
  ]);

  const officialSources = filterTrackableOfficialSources((sources || []) as SharedSourceRow[]);
  const officialChanges = dedupeChangeSummaries(
    ((changes || []) as SharedChangeRow[]).filter((change) =>
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
  const facts = publicAwardFactsFromAward({
    summary: award.summary,
    publicFacts: award.public_facts,
    sources: officialSources,
  });
  const canonicalPath = canonicalAwardPath(award.slug, award.name, award.id);
  const publicSources = withUniqueAwardSourceSlugs(officialSources).map((source) => ({
    id: source.id,
    sourceSlug: source.sourceSlug,
    publicPath: `${canonicalPath}/${source.sourceSlug}`,
    title: readableSourceTitle(source.display_title || source.title, source.url),
    description: source.page_description,
    url: source.url,
    pageType: source.page_type,
    lastCheckedAt: source.last_checked_at,
    facts: publicAwardFactsFromAward({
      sources: [source],
    }),
  }));

  return {
    award,
    canonicalPath,
    redirectPath,
    facts,
    metaDescription: publicAwardMetaDescription(award.name, facts),
    officialHomepage: displayHomepageForAward(award.official_homepage, officialSources),
    lastCheckedAt: latestCheckedAt(officialSources),
    sources: publicSources,
    changes: officialChanges.slice(0, 8).map((change) => ({
      id: change.id,
      sourceId: change.shared_award_source_id,
      sourceTitle: readableSourceTitle(change.source_title, change.source_url),
      sourceUrl: change.source_url,
      sourcePageType: change.source_page_type,
      summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
      changeDetails: change.change_details,
      detectedAt: change.detected_at,
    })),
  };
}

async function loadOpenSourceRowsForSitemap(limit: number) {
  const admin = createSupabaseAdminClient();
  const rows: SharedSourceRow[] = [];
  for (let from = 0; rows.length < limit; from += 1000) {
    const { data, error } = await admin
      .from("shared_award_sources")
      .select("id, shared_award_id, url, title, display_title, page_description, page_metadata, page_type, last_checked_at")
      .eq("admin_review_status", "open")
      .order("shared_award_id", { ascending: true })
      .order("page_type", { ascending: true })
      .order("created_at", { ascending: true })
      .range(from, from + 999);
    if (error) return rows;
    rows.push(...((data || []) as SharedSourceRow[]));
    if (!data || data.length < 1000) break;
  }
  return rows.slice(0, limit);
}

function normalizeUrl(value: string | null | undefined) {
  try {
    const url = new URL(value || "");
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString().toLowerCase();
  } catch {
    return String(value || "").trim().toLowerCase();
  }
}

function embeddedSharedAward(value: unknown): SharedAwardRow | null {
  if (Array.isArray(value)) return embeddedSharedAward(value[0]);
  return value && typeof value === "object" ? (value as SharedAwardRow) : null;
}
