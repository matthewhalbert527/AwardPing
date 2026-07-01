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
import { unreadSharedChangeIdsForUser } from "@/lib/update-read-state";

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
  award: Pick<SharedAwardRow, "id" | "name" | "slug" | "official_homepage" | "updated_at">;
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
    unread?: boolean;
  }>;
};

export async function getPublicAwardPageBySlug(
  slug: string,
  options: { userId?: string | null } = {},
): Promise<PublicAwardPageData | null> {
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
    return loadPublicAwardPageData(direct.data as SharedAwardRow, null, options);
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
    options,
  );
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

async function loadPublicAwardPageData(
  award: SharedAwardRow,
  redirectPath: string | null,
  options: { userId?: string | null } = {},
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
  const officialSourceIds = new Set(officialSources.map((source) => source.id));
  const officialChanges = dedupeChangeSummaries(
    ((changes || []) as SharedChangeRow[]).filter((change) =>
      (!change.shared_award_source_id || officialSourceIds.has(change.shared_award_source_id)) &&
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
    publicPath: canonicalPath,
    title: readableSourceTitle(source.display_title || source.title, source.url),
    description: compactSourceDescription(source.page_description),
    url: source.url,
    pageType: source.page_type,
    lastCheckedAt: source.last_checked_at,
    facts: publicAwardFactsFromAward({
      sources: [source],
    }),
  }));
  const limitedChanges = officialChanges.slice(0, 8);
  const unreadChangeIds = options.userId
    ? await unreadSharedChangeIdsForUser(options.userId, limitedChanges).catch(() => null)
    : null;

  return {
    award: {
      id: award.id,
      name: award.name,
      slug: award.slug,
      official_homepage: award.official_homepage,
      updated_at: award.updated_at,
    },
    canonicalPath,
    redirectPath,
    facts,
    metaDescription: publicAwardMetaDescription(award.name, facts),
    officialHomepage: displayHomepageForAward(award.official_homepage, officialSources),
    lastCheckedAt: latestCheckedAt(officialSources),
    sources: publicSources,
    changes: limitedChanges.map((change) => ({
      id: change.id,
      sourceId: change.shared_award_source_id,
      sourceTitle: readableSourceTitle(change.source_title, change.source_url),
      sourceUrl: change.source_url,
      sourcePageType: change.source_page_type,
      summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
      changeDetails: change.change_details,
      detectedAt: change.detected_at,
      unread: unreadChangeIds ? unreadChangeIds.has(change.id) : true,
    })),
  };
}

function embeddedSharedAward(value: unknown): SharedAwardRow | null {
  if (Array.isArray(value)) return embeddedSharedAward(value[0]);
  return value && typeof value === "object" ? (value as SharedAwardRow) : null;
}

const generatedFactDescriptionLabelPattern =
  /\b(?:Deadline|Opening date|Award amount|Eligibility|Requirements|Application materials|How to apply|Important dates|Documents|Contacts|Notes|Baseline detail confidence):/i;

function compactSourceDescription(value: string | null) {
  const clean = value?.replace(/\s+/g, " ").trim() || "";
  if (!clean) return null;

  const factStart = clean.search(generatedFactDescriptionLabelPattern);
  if (factStart <= 0) return clean;

  return clean
    .slice(0, factStart)
    .replace(/\s+[.:;,-]*$/g, "")
    .trim() || null;
}
