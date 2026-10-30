import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { displayChangeSummary } from "@/lib/change-summary";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { getOfficeContext } from "@/lib/offices";
import { loadEligiblePublicChangeEvents } from "@/lib/public-change-events";
import { publicAwardFactsFromAward } from "@/lib/public-award-facts";
import { loadVariationPublicSources } from "@/lib/public-award-pages";
import { loadPublishedVariationContext } from "@/lib/program-variation-review.server";
import type { PublishedVariationContext } from "@/lib/program-variation-review-types";
import { isProgramExpansionPublication } from "@/lib/program-expansion-tracking.server";
import { loadProgramExpansionPublicSources } from "@/lib/program-expansion-public-sources.server";
import { isPublicAwardSource } from "@/lib/source-quality";
import {
  isTrackableOfficialSourceUrl,
} from "@/lib/source-url-policy";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  isStage1SourceIdentityExcluded,
  loadStage1PublicationIndex,
} from "@/lib/stage1-publication";

export const runtime = "nodejs";

type Props = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Props) {
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  if (!hasSupabaseAdminConfig()) {
    return NextResponse.json(
      { error: "Shared award directory is not configured." },
      { status: 503 },
    );
  }

  const { id } = await params;
  const publicationIndex = await loadStage1PublicationIndex();
  if (!publicationIndex.available) {
    return NextResponse.json(
      { error: "Shared award directory is unavailable right now." },
      { status: 503 },
    );
  }
  const publication = publicationIndex.entryByMemberAwardId.get(id) || null;
  if (!publication?.effectivelyVerified) {
    return NextResponse.json({ error: "Shared award was not found." }, { status: 404 });
  }
  let variations: PublishedVariationContext | null = null;
  if (!publication.basicFactSnapshot && !publication.basicFactsUnavailable && publication.textFactReview?.variationInventoryId) {
    try {
      variations = await loadPublishedVariationContext(publication.registry.cohort_key);
      if (!variations || variations.inventory_id !== publication.textFactReview.variationInventoryId ||
          variations.revision !== publication.textFactReview.variationInventoryRevision || variations.selected_scope_key !== "common" ||
          variations.source_ids.some(sourceId => !publication.allowedSourceIdSet.has(sourceId) ||
            variations?.source_bindings[sourceId]?.url !== publication.approvedTextSourceBindings?.[sourceId]?.url ||
            variations?.source_bindings[sourceId]?.shared_award_id !== publication.approvedTextSourceBindings?.[sourceId]?.shared_award_id)) {
        return NextResponse.json({ error: "Shared award details are unavailable right now." }, { status: 503 });
      }
    } catch {
      return NextResponse.json({ error: "Shared award details are unavailable right now." }, { status: 503 });
    }
  }
  const memberAwardIds = publication.memberAwardIds;
  const expansion = isProgramExpansionPublication(publication);
  const user = await getCurrentUser();
  const officeContext = user ? await getOfficeContext(user) : null;
  const admin = createSupabaseAdminClient();

  const [
    { data: sharedSources, error: sourcesError },
    eligibleEvents,
    { data: officeAwards, error: officeAwardsError },
    { data: officeSources, error: officeSourcesError },
  ] = await Promise.all([
    expansion ? loadProgramExpansionPublicSources(admin, publication).catch(() => ({
      data: null, error: { message: "Approved expansion source identities are unavailable." },
    })) : variations ? loadVariationPublicSources(admin, publication, variations).then(result => ({
      data: result.data.map(source => ({ ...source, last_error: null })), error: null,
    })).catch(() => ({ data: null, error: { message: "Approved source identities are unavailable." } })) : admin
      .from("shared_award_sources")
      .select("id, shared_award_id, url, title, display_title, page_description, page_metadata, page_metadata_generated_at, page_metadata_model, page_type, source, reason, submitted_by_user_id, admin_review_status, last_checked_at, last_error, created_at")
      .in("shared_award_id", memberAwardIds)
      .eq("admin_review_status", "open")
      .order("created_at", { ascending: true }),
    loadEligiblePublicChangeEvents({
      admin,
      publicationIndex,
      memberAwardIds,
      limit: null,
    }),
    officeContext
      ? admin
          .from("awards")
          .select("id, shared_award_id")
          .eq("office_id", officeContext.current.officeId)
          .in("shared_award_id", memberAwardIds)
          .eq("status", "active")
      : Promise.resolve({ data: [], error: null }),
    officeContext
      ? admin
          .from("award_sources")
          .select("award_id, shared_award_source_id, selected")
          .eq("office_id", officeContext.current.officeId)
      : Promise.resolve({ data: [], error: null }),
  ]);

  // Failure precedence is unchanged, but the caller only ever sees one stable
  // message: driver text carries schema, query and connection detail that must
  // not reach a public response.
  const error = sourcesError || officeAwardsError || officeSourcesError;
  if (error) {
    return NextResponse.json(
      { error: "Shared award details are unavailable right now." },
      { status: 500 },
    );
  }

  const activeOfficeAwardIds = new Set(
    (officeAwards || []).map((award) => award.id),
  );
  const trackedSourceIds = new Set(
    (officeSources || [])
      .filter(
        (source) => source.selected && activeOfficeAwardIds.has(source.award_id),
      )
      .map((source) => source.shared_award_source_id)
      .filter((sourceId): sourceId is string => Boolean(sourceId)),
  );
  // Kept by source ID, never collapsed by a loose canonical URL: two allowed
  // rows can share one URL or differ only by a trailing slash, and discarding
  // one of them hid its own updates, which attach by source ID below. The
  // Legacy rows require their original public review. Variation rows have
  // already passed the published unit's exact immutable URL/owner bindings.
  const sources = (sharedSources || [])
    // Exact admitted expansion links passed current text authority in their
    // loader, including programme-specific database URLs. The legacy listing
    // heuristic and legacy AI approval remain mandatory for original entries.
    .filter((source) => expansion || isTrackableOfficialSourceUrl(source.url))
    .filter((source) => publication.allowedSourceIdSet.has(source.id))
    .filter((source) => !isStage1SourceIdentityExcluded(publication, source))
    .filter(source => expansion || Boolean(variations) || isPublicAwardSource(source));
  const reviewedHomepageSource = sources.find((source) =>
    source.id === publication.officialHomepageSourceId &&
    source.url === publication.registry.official_homepage &&
    publication.officialHomepageUrl === publication.registry.official_homepage
  );
  if (!reviewedHomepageSource) {
    return NextResponse.json({ error: "Shared award was not found." }, { status: 404 });
  }
  const changes = eligibleEvents.map((entry) => entry.event);
  const facts = publicAwardFactsFromAward({ publicFacts: variations?.public_facts || publication.publishedFacts, completeSnapshot: Boolean(publication.basicFactSnapshot || publication.basicFactsUnavailable || publication.textFactReview) });
  return NextResponse.json({
    award: {
      id: publication.canonicalAwardId,
      name: publication.registry.canonical_name,
      officialHomepage: publication.registry.official_homepage,
      summary: facts.overview,
      sourceCount: sources.length,
      changeCount: changes.length,
      tracked: Boolean(officeAwards?.length),
      detailsLoaded: true,
      hasApplicationRoutes: !publication.basicFactSnapshot && !publication.basicFactsUnavailable && Boolean(publication.textFactReview?.variationCount),
      sources: sources.map((source) => ({
        id: source.id,
        url: source.url,
        title: variations && !variations.source_bindings[source.id] ? publication.registry.canonical_name : source.title,
        pageType: variations && !variations.source_bindings[source.id] ? "homepage" : source.page_type,
        tracked: trackedSourceIds.has(source.id),
        lastCheckedAt: source.last_checked_at,
        lastError: source.last_error,
        latestChanges: latestChangesForSource(source, changes).slice(0, 2).map((change) => ({
          id: change.id,
          sourceTitle: change.source_title,
          sourceUrl: change.source_url,
          sourcePageType: change.source_page_type,
          summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
          changeDetails: change.change_details,
          suppressedAt: change.suppressed_at,
          suppressionReason: change.suppression_reason,
          suppressionSource: change.suppression_source,
          detectedAt: change.detected_at,
        })),
      })),
      changes: changes.map((change) => ({
        id: change.id,
        sourceTitle: change.source_title,
        sourceUrl: change.source_url,
        sourcePageType: change.source_page_type,
        summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
        changeDetails: change.change_details,
        suppressedAt: change.suppressed_at,
        suppressionReason: change.suppression_reason,
        suppressionSource: change.suppression_source,
        detectedAt: change.detected_at,
      })),
    },
  });
}

function latestChangesForSource<
  Source extends { id: string; url: string },
  Change extends { shared_award_source_id?: string | null; source_url: string },
>(source: Source, changes: Change[]) {
  return changes.filter((change) => isChangeForSource(change, source));
}

// The same attribution policy the public award workspace applies, so both
// surfaces agree on which official document an update belongs to.
function isChangeForSource(
  change: { shared_award_source_id?: string | null; source_url: string },
  source: { id: string; url: string },
) {
  // A retained source ID is authoritative: a change recorded against another
  // source must never be re-attached through its URL. The fallback below is
  // only for legacy changes that carry no ID at all.
  if (change.shared_award_source_id) {
    return change.shared_award_source_id === source.id;
  }
  return sourceUrlsMatch(change.source_url, source.url);
}

function sourceUrlsMatch(left: string | null | undefined, right: string | null | undefined) {
  const leftKey = sourceDocumentUrlKey(left);
  return leftKey !== null && leftKey === sourceDocumentUrlKey(right);
}

function sourceDocumentUrlKey(value: string | null | undefined) {
  try {
    const url = new URL(value || "");
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // Unlike source-discovery deduplication, attribution must preserve the
    // document address: paths, query names/values, and query order may matter.
    // A fragment points within the same document, so it alone is ignored.
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
