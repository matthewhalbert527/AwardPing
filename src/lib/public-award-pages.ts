import { canonicalAwardPath, normalizeAwardSlug, withUniqueAwardSourceSlugs } from "@/lib/award-slugs";
import {
  latestCheckedAt,
  publicAwardFactsFromAward,
  publicAwardMetaDescription,
} from "@/lib/public-award-facts";
import { displayChangeSummary } from "@/lib/change-summary";
import type { AwardPageType } from "@/lib/award-discovery-types";
import type { Database, Json } from "@/lib/database.types";
import { readableSourceTitle } from "@/lib/display-text";
import { loadEligiblePublicChangeEvents } from "@/lib/public-change-events";
import {
  isPublicAwardSource,
} from "@/lib/source-quality";
import {
  filterTrackableOfficialSources,
} from "@/lib/source-url-policy";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  isStage1SourceIdentityExcluded,
  loadStage1PublicationIndex,
  type Stage1PublicationEntry,
  type Stage1PublicationIndex,
} from "@/lib/stage1-publication";
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
  | "page_metadata_generated_at"
  | "page_metadata_model"
  | "page_type"
  | "source"
  | "reason"
  | "submitted_by_user_id"
  | "admin_review_status"
  | "last_checked_at"
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

export type PublicAwardPageResolution =
  | { kind: "published"; data: PublicAwardPageData }
  | { kind: "under_verification" }
  | { kind: "missing" };

export async function getPublicAwardPageBySlug(
  slug: string,
  options: { userId?: string | null } = {},
): Promise<PublicAwardPageData | null> {
  const resolution = await getPublicAwardPageResolutionBySlug(slug, options);
  return resolution.kind === "published" ? resolution.data : null;
}

export async function getPublicAwardPageResolutionBySlug(
  slug: string,
  options: { userId?: string | null } = {},
): Promise<PublicAwardPageResolution> {
  const normalizedSlug = normalizeAwardSlug(slug);
  if (!normalizedSlug) return { kind: "missing" };

  const publicationIndex = await loadStage1PublicationIndex();
  if (!publicationIndex.available) return { kind: "missing" };

  const admin = createSupabaseAdminClient();
  let publication = publicationIndex.entries.find(
    (entry) => entry.registry.canonical_slug === normalizedSlug,
  );
  let requestedAward = publication
    ? canonicalAwardFromPublication(publication)
    : null;
  let wasSlugAlias = false;
  if (!requestedAward) {
    const direct = await admin
      .from("shared_awards")
      .select("id, name, slug, official_homepage, summary, public_facts, public_facts_generated_at, updated_at")
      .eq("slug", normalizedSlug)
      .eq("status", "active")
      .maybeSingle();

    if (direct.error) throw direct.error;
    requestedAward = direct.data as SharedAwardRow | null;
    if (!requestedAward) {
      const alias = await admin
        .from("shared_award_slug_aliases")
        .select("slug, shared_awards!inner(id, name, slug, official_homepage, summary, public_facts, public_facts_generated_at, updated_at, status)")
        .eq("slug", normalizedSlug)
        .eq("shared_awards.status", "active")
        .maybeSingle();

      if (alias.error) throw alias.error;
      requestedAward = embeddedSharedAward(alias.data?.shared_awards);
      wasSlugAlias = Boolean(requestedAward);
    }
    publication = requestedAward
      ? publicationIndex.entryByMemberAwardId.get(requestedAward.id)
      : undefined;
  }

  if (!requestedAward || !publication) return { kind: "missing" };
  if (!publication.effectivelyVerified) return { kind: "under_verification" };

  const canonicalAward = canonicalAwardFromPublication(publication);

  const canonicalPath = canonicalAwardPath(
    canonicalAward.slug,
    canonicalAward.name,
    canonicalAward.id,
  );
  const shouldRedirect =
    wasSlugAlias || requestedAward.id !== publication.canonicalAwardId;

  const data = await loadPublicAwardPageData(
    canonicalAward,
    publication,
    publicationIndex,
    shouldRedirect ? canonicalPath : null,
    options,
  );
  return data ? { kind: "published", data } : { kind: "under_verification" };
}

export async function getPublicAwardSitemapRows(limit = 50000) {
  const publicationIndex = await loadStage1PublicationIndex();
  if (!publicationIndex.available || publicationIndex.verifiedCanonicalAwardIds.length === 0) {
    return [];
  }
  return publicationIndex.verifiedEntries.slice(0, limit).map((publication) => ({
    urlPath: canonicalAwardPath(
      publication.registry.canonical_slug,
      publication.registry.canonical_name,
      publication.canonicalAwardId,
    ),
    updatedAt:
      publication.registry.last_verified_at || publication.registry.updated_at,
  }));
}

async function loadPublicAwardPageData(
  award: SharedAwardRow,
  publication: Stage1PublicationEntry,
  publicationIndex: Stage1PublicationIndex,
  redirectPath: string | null,
  options: { userId?: string | null } = {},
): Promise<PublicAwardPageData | null> {
  const admin = createSupabaseAdminClient();
  const [sourcesResult, eligibleEvents] = await Promise.all([
    admin
      .from("shared_award_sources")
      .select("id, shared_award_id, url, title, display_title, page_description, page_metadata, page_metadata_generated_at, page_metadata_model, page_type, source, reason, submitted_by_user_id, admin_review_status, last_checked_at")
      .in("shared_award_id", publication.memberAwardIds)
      .eq("admin_review_status", "open")
      .order("page_type", { ascending: true })
      .order("created_at", { ascending: true }),
    loadEligiblePublicChangeEvents({
      admin,
      publicationIndex,
      memberAwardIds: publication.memberAwardIds,
      limit: 8,
    }),
  ]);
  if (sourcesResult.error) {
    throw new Error(`Public award source query failed: ${sourcesResult.error.message}`);
  }
  const sources = sourcesResult.data || [];

  const officialSources = filterTrackableOfficialSources((sources || []) as SharedSourceRow[])
    .filter((source) => publication.allowedSourceIdSet.has(source.id))
    .filter((source) => !isStage1SourceIdentityExcluded(publication, source))
    .filter(isPublicAwardSource);
  const reviewedHomepageSource = officialSources.find((source) =>
    source.id === publication.officialHomepageSourceId &&
    source.url === publication.registry.official_homepage &&
    publication.officialHomepageUrl === publication.registry.official_homepage
  );
  if (!reviewedHomepageSource) return null;
  const officialChanges = eligibleEvents.map((entry) => entry.event);
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
  const limitedChanges = officialChanges;
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
    officialHomepage: publication.registry.official_homepage,
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

function canonicalAwardFromPublication(
  publication: Stage1PublicationEntry,
): SharedAwardRow {
  return {
    id: publication.canonicalAwardId,
    name: publication.registry.canonical_name,
    slug: publication.registry.canonical_slug,
    official_homepage: publication.registry.official_homepage,
    summary: null,
    public_facts: publication.publishedFacts,
    public_facts_generated_at: publication.registry.last_verified_at,
    updated_at:
      publication.registry.last_verified_at || publication.registry.updated_at,
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
