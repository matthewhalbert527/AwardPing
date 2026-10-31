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
import {
  comparePublicChangeEventsNewestFirst,
  loadEligiblePublicChangeEvents,
  type EligiblePublicChangeEvent,
} from "@/lib/public-change-events";
import {
  isPublicAwardSource,
} from "@/lib/source-quality";
import {
  isTrackableOfficialSourceUrl,
} from "@/lib/source-url-policy";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  isStage1SourceIdentityExcluded,
  loadStage1PublicationIndex,
  type Stage1PublicationEntry,
  type Stage1PublicationIndex,
} from "@/lib/stage1-publication";
import { unreadSharedChangeIdsForUser } from "@/lib/update-read-state";
import { attachPublicAlertGroups, loadPublicAlertGroups } from "@/lib/public-alert-groups.server";
import type { PublicAlertGroup } from "@/lib/public-alert-groups";
import { loadPublishedVariationContext } from "@/lib/program-variation-review.server";
import type { PublishedVariationContext } from "@/lib/program-variation-review-types";
import { isProgramExpansionPublication } from "@/lib/program-expansion-tracking.server";
import { loadProgramExpansionPublicSources } from "@/lib/program-expansion-public-sources.server";

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
  /** Pinned published-facts review, not newest source check or AI generation. */
  factsReviewedAt?: string | null;
  factsNeedReview?: boolean;
  variations?: PublishedVariationContext & { cohort_key: string };
  /** One server clock value shared by SSR and hydration for date status. */
  presentationAsOf?: string;
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
    group?: PublicAlertGroup;
  }>;
};

export type PublicAwardPageOptions = {
  userId?: string | null;
  variantId?: string | null;
  /**
   * A deep-linked change id (already validated by the page). When it names
   * an eligible update of this award that is older than the recent list, the
   * update is loaded through the same gates and merged into `changes`.
   */
  changeId?: string | null;
};

export type PublicAwardPageResolution =
  | { kind: "published"; data: PublicAwardPageData }
  | { kind: "under_verification" }
  | { kind: "unavailable" }
  | { kind: "missing" };

type PublicAwardIdentityResolution =
  | {
      kind: "published";
      award: SharedAwardRow;
      publication: Stage1PublicationEntry;
      publicationIndex: Stage1PublicationIndex;
      canonicalPath: string;
      redirectPath: string | null;
    }
  | Exclude<PublicAwardPageResolution, { kind: "published" }>;

export type PublicAwardMetadataResolution =
  | { kind: "published"; data: { awardName: string; canonicalPath: string; metaDescription: string } }
  | Exclude<PublicAwardPageResolution, { kind: "published" }>;

export async function getPublicAwardPageBySlug(
  slug: string,
  options: PublicAwardPageOptions = {},
): Promise<PublicAwardPageData | null> {
  const resolution = await getPublicAwardPageResolutionBySlug(slug, options);
  return resolution.kind === "published" ? resolution.data : null;
}

export async function getPublicAwardPageResolutionBySlug(
  slug: string,
  options: PublicAwardPageOptions = {},
): Promise<PublicAwardPageResolution> {
  const identity = await resolvePublicAwardIdentityBySlug(slug);
  if (identity.kind !== "published") return identity;
  const data = await loadPublicAwardPageData(
    identity.award,
    identity.publication,
    identity.publicationIndex,
    identity.redirectPath,
    options,
  );
  return data ? { kind: "published", data } : { kind: "under_verification" };
}

/** Metadata uses the current publication identity and approved shared facts.
 * It does not need source cards, change history, unread state or route details.
 * The page body independently repeats its full current publication checks.
 */
export async function getPublicAwardMetadataResolutionBySlug(slug: string): Promise<PublicAwardMetadataResolution> {
  const identity = await resolvePublicAwardIdentityBySlug(slug);
  if (identity.kind !== "published") return identity;
  const facts = publicAwardFactsFromAward({ publicFacts: identity.publication.publishedFacts, completeSnapshot: true });
  return { kind: "published", data: { awardName: identity.award.name, canonicalPath: identity.canonicalPath,
    metaDescription: publicAwardMetaDescription(identity.award.name, facts) } };
}

/** Shared identity/alias resolution stays fresh for each independent caller. */
async function resolvePublicAwardIdentityBySlug(slug: string): Promise<PublicAwardIdentityResolution> {
  const normalizedSlug = normalizeAwardSlug(slug);
  if (!normalizedSlug) return { kind: "missing" };

  const publicationIndex = await loadStage1PublicationIndex();
  if (!publicationIndex.available) return { kind: "unavailable" };

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

  return { kind: "published", award: canonicalAward, publication, publicationIndex,
    canonicalPath, redirectPath: shouldRedirect ? canonicalPath : null };
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
  options: PublicAwardPageOptions = {},
): Promise<PublicAwardPageData | null> {
  const admin = createSupabaseAdminClient();
  const expansion = isProgramExpansionPublication(publication);
  const variations = !publication.basicFactSnapshot && !publication.basicFactsUnavailable && publication.textFactReview?.variationInventoryId
    ? await loadPublishedVariationContext(publication.registry.cohort_key, { scopeKey: options.variantId || undefined }) : null;
  if (!publication.basicFactSnapshot && !publication.basicFactsUnavailable && publication.textFactReview?.variationInventoryId && (!variations ||
      variations.inventory_id !== publication.textFactReview.variationInventoryId || variations.revision !== publication.textFactReview.variationInventoryRevision ||
      variations.source_ids.some(id => !publication.allowedSourceIdSet.has(id) ||
        variations.source_bindings[id]?.url !== publication.approvedTextSourceBindings?.[id]?.url ||
        variations.source_bindings[id]?.shared_award_id !== publication.approvedTextSourceBindings?.[id]?.shared_award_id) ||
      options.variantId && variations.selected_scope_key !== options.variantId)) throw new Error("The approved application route could not be confirmed.");
  if (options.variantId && !variations) throw new Error("This award has no approved application route with that identity.");
  const requestedChangeId = options.changeId || null;
  // A deep-linked update older than the recent list is fetched by id through
  // the same publication, release, source, evidence and suppression gates,
  // restricted to this award's member awards: a stale, suppressed,
  // unverified, out-of-cohort or wrong-award id yields nothing and the page
  // simply shows its recent updates.
  const requestedEventsPromise: Promise<EligiblePublicChangeEvent[]> = requestedChangeId
    ? loadEligiblePublicChangeEvents({
        admin,
        publicationIndex,
        memberAwardIds: publication.memberAwardIds,
        limit: 1,
        eventIds: [requestedChangeId],
      })
    : Promise.resolve([]);
  const [sourcesResult, recentEvents, requestedEvents] = await Promise.all([
    expansion ? loadProgramExpansionPublicSources(admin, publication) : variations ? loadVariationPublicSources(admin, publication, variations) : admin
      .from("shared_award_sources")
      .select("id, shared_award_id, url, title, display_title, page_description, page_metadata, page_metadata_generated_at, page_metadata_model, page_type, source, reason, submitted_by_user_id, admin_review_status, last_checked_at")
      .in("shared_award_id", publication.memberAwardIds)
      // Not filtered to admin_review_status 'open' here: the pinned reviewed
      // homepage must be found even when the nightly worker auto-holds it
      // (review_later after a capture failure or a stale stored verdict),
      // otherwise the page falls back to "Under verification". The listed
      // sources below are still restricted to open rows.
      .order("page_type", { ascending: true })
      .order("created_at", { ascending: true }),
    loadEligiblePublicChangeEvents({
      admin,
      publicationIndex,
      memberAwardIds: publication.memberAwardIds,
      limit: 8,
    }),
    requestedEventsPromise,
  ]);
  if (sourcesResult.error) {
    throw new Error(`Public award source query failed: ${sourcesResult.error.message}`);
  }
  const related = await loadPublicAlertGroups({ admin, publicationIndex,
    events: mergeRequestedPublicChangeEvents(recentEvents, requestedEvents) });
  const eligibleEvents = related.events;
  const sources = sourcesResult.data || [];

  // Reviewed sources are kept by source ID, never collapsed by a loose
  // canonical URL. Alias members can carry duplicate rows for one URL,
  // and rows can differ only by a trailing slash or a dropped query parameter;
  // discarding one of them hid its own updates, which attach by source ID.
  // Trackability is still applied to every row individually.
  const officialSources = ((sources || []) as SharedSourceRow[])
    .filter((source) => expansion || isTrackableOfficialSourceUrl(source.url))
    .filter((source) => expansion || Boolean(variations) || source.admin_review_status === "open")
    .filter((source) => publication.allowedSourceIdSet.has(source.id))
    .filter((source) => !isStage1SourceIdentityExcluded(publication, source))
    .filter(source => expansion || Boolean(variations) || isPublicAwardSource(source));
  // The reviewed homepage is looked up over the rows again, still under the
  // allowlist and identity-exclusion gates but WITHOUT the open-status,
  // trackability and public-quality gates: it stays pinned even when the
  // nightly worker auto-holds it (review_later, so not open) or the AI
  // public-authority gate rejects it, each of which keeps it out of the listed
  // sources above, and neither of which may turn the award into a placeholder.
  // The pinned homepage id IS the explicit human review (the cohort's identity
  // home, bound by the reviewed chain with panel-verified facts), so the AI
  // public-authority gate is not re-applied to it: several reviewed homepages
  // carry an immutable monitoring-only baseline activation that the gate
  // rejects, which rendered verified cohorts as placeholders after launch.
  // Validating the page here never adds that row to the listed sources, and
  // every listed source still passes isPublicAwardSource above.
  const reviewedHomepageSource = ((sources || []) as SharedSourceRow[])
    .filter((source) => publication.allowedSourceIdSet.has(source.id))
    .filter((source) => !isStage1SourceIdentityExcluded(publication, source))
    .find((source) =>
      source.id === publication.officialHomepageSourceId &&
      source.url === publication.registry.official_homepage &&
      publication.officialHomepageUrl === publication.registry.official_homepage
    );
  if (!reviewedHomepageSource) return null;
  const officialChanges = eligibleEvents.map((entry) => entry.event);
  const facts = publicAwardFactsFromAward({
    summary: award.summary,
    publicFacts: variations?.public_facts || award.public_facts,
    sources: officialSources,
    completeSnapshot: Boolean(publication.basicFactSnapshot || publication.basicFactsUnavailable || publication.textFactReview),
  });
  const canonicalPath = canonicalAwardPath(award.slug, award.name, award.id);
  const publicSources = withUniqueAwardSourceSlugs(officialSources).map((source) => ({
    id: source.id,
    sourceSlug: source.sourceSlug,
    publicPath: canonicalPath,
    title: readableSourceTitle(source.display_title || source.title, source.url),
    description: publication.basicFactSnapshot || publication.basicFactsUnavailable ? null : compactSourceDescription(source.page_description),
    url: source.url,
    pageType: source.page_type,
    lastCheckedAt: source.last_checked_at,
    facts: publicAwardFactsFromAward(variations || publication.basicFactSnapshot || publication.basicFactsUnavailable
      ? { publicFacts: {}, completeSnapshot: true } : { sources: [source] }),
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
    factsReviewedAt: publication.basicFactSnapshot?.current === true ? publication.basicFactSnapshot.verifiedAt : undefined,
    factsNeedReview: publication.basicFactsUnavailable ? true : publication.basicFactSnapshot ? !publication.basicFactSnapshot.current : variations ? !variations.current : publication.textFactReview ? !publication.textFactReview.current : undefined,
    ...(variations ? { variations: { ...variations, cohort_key: publication.registry.cohort_key } } : {}),
    presentationAsOf: new Date().toISOString(),
    lastCheckedAt: latestCheckedAt(officialSources),
    sources: publicSources,
    changes: attachPublicAlertGroups(limitedChanges.map((change) => ({
      id: change.id,
      sourceId: change.shared_award_source_id,
      sourceTitle: readableSourceTitle(change.source_title, change.source_url),
      sourceUrl: change.source_url,
      sourcePageType: change.source_page_type,
      summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
      changeDetails: change.change_details,
      detectedAt: change.detected_at,
      unread: unreadChangeIds ? unreadChangeIds.has(change.id) : true,
    })), related.groups),
  };
}

/** A selected approved unit stays bounded even when the full provider inventory is large. */
export async function loadVariationPublicSources(admin: ReturnType<typeof createSupabaseAdminClient>, publication: Stage1PublicationEntry, unit: PublishedVariationContext) {
  const unitIds = unit.source_ids;
  const ids = [...new Set([...unitIds, ...(publication.officialHomepageSourceId ? [publication.officialHomepageSourceId] : [])])];
  if (!ids.length || ids.length > 501 || ids.some(id => !publication.allowedSourceIdSet.has(id))) throw new Error("Incomplete approved source set.");
  const data: SharedSourceRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const part = ids.slice(offset, offset + 100);
    const result = await admin.from("shared_award_sources")
      .select("id,shared_award_id,url,title,display_title,page_description,page_metadata,page_metadata_generated_at,page_metadata_model,page_type,source,reason,submitted_by_user_id,admin_review_status,last_checked_at")
      .in("id", part).order("id").limit(101);
    if (result.error || result.data?.length !== part.length || new Set(result.data.map(source => source.id)).size !== part.length ||
        result.data.some(source => !part.includes(source.id) || !publication.memberAwardIds.includes(source.shared_award_id))) throw new Error("Approved source identities changed.");
    for (const source of result.data) {
      const binding = unit.source_bindings[source.id];
      if (!binding) {
        if (source.id !== publication.officialHomepageSourceId || source.url !== publication.officialHomepageUrl) throw new Error("Unbound public source identity.");
        data.push(source); continue;
      }
      if (source.url !== binding.url || source.shared_award_id !== binding.shared_award_id) throw new Error("Approved source URL or owner changed.");
      data.push({ ...source, title: readableSourceTitle(binding.title, binding.url), display_title: null,
        page_type: (binding.page_type || "other") as SharedSourceRow["page_type"], page_description: null,
        page_metadata: null, page_metadata_generated_at: null, page_metadata_model: null });
    }
  }
  return { data, error: null };
}

// Adds deep-linked events that the gates returned to the recent list without
// duplicating an event already there. The recent list keeps the gate's
// proven newest-first order untouched; each new entry is inserted before the
// first older entry using the gate's exact microsecond-and-UUID comparison,
// so an older update lands after the recent ones and adjacent microseconds
// are never reordered by id. Both inputs already passed every gate.
export function mergeRequestedPublicChangeEvents(
  recent: EligiblePublicChangeEvent[],
  requested: EligiblePublicChangeEvent[],
) {
  const merged = [...recent];
  for (const entry of requested) {
    if (merged.some((existing) => existing.event.id === entry.event.id)) continue;
    const olderIndex = merged.findIndex(
      (existing) => comparePublicChangeEventsNewestFirst(entry.event, existing.event) < 0,
    );
    if (olderIndex === -1) {
      merged.push(entry);
    } else {
      merged.splice(olderIndex, 0, entry);
    }
  }
  return merged;
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
    public_facts_generated_at: publication.basicFactSnapshot?.verifiedAt || (publication.basicFactsUnavailable ? null : publication.textFactReview?.reviewedAt || publication.registry.last_verified_at),
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
