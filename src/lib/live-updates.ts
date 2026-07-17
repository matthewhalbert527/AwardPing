import { displayChangeSummary } from "@/lib/change-summary";
import type { AwardPageType } from "@/lib/award-discovery-types";
import { isFirstObservedOfficialDocument } from "@/lib/change-details";
import type { Json } from "@/lib/database.types";
import { readableSourceTitle } from "@/lib/display-text";
import { loadEligiblePublicChangeEvents } from "@/lib/public-change-events";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadStage1PublicationIndex } from "@/lib/stage1-publication";
import { formatCentralDate } from "@/lib/time-zone";

export type LiveUpdateItem = {
  id: string;
  awardId: string;
  awardName: string;
  awardSlug: string | null;
  sourceId: string | null;
  sourceTitle: string;
  sourceUrl: string;
  sourcePageType: AwardPageType | null;
  summary: string;
  changeDetails: Json;
  detectedAt: string;
  detectedLabel: string;
  changeTypeLabel: string;
};

export async function getLiveUpdateItems(limit = 30): Promise<LiveUpdateItem[]> {
  const admin = createSupabaseAdminClient();
  const publicationIndex = await loadStage1PublicationIndex();
  if (!publicationIndex.available || publicationIndex.verifiedMemberAwardIds.length === 0) {
    return [];
  }
  const eligibleEvents = await loadEligiblePublicChangeEvents({
    admin,
    publicationIndex,
    limit,
  });

  return eligibleEvents.map(({ event: change, publication }) => {
      const sourceTitle = readableSourceTitle(change.source_title, change.source_url);
      return {
        id: change.id,
        awardId: publication?.canonicalAwardId || change.shared_award_id,
        awardName: publication?.registry.canonical_name || "Tracked award",
        awardSlug: publication?.registry.canonical_slug || null,
        sourceId: change.shared_award_source_id,
        sourceTitle,
        sourceUrl: change.source_url,
        sourcePageType: change.source_page_type,
        summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
        changeDetails: change.change_details,
        detectedAt: change.detected_at,
        detectedLabel: relativeTimeLabel(change.detected_at),
        changeTypeLabel: changeTypeLabel(change.change_details),
      };
    });
}

export function relativeTimeLabel(value: string) {
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  const diffHours = Math.max(0, Math.round(diffMs / (60 * 60 * 1000)));
  if (diffHours < 1) return "Just now";
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays <= 14) return `${diffDays}d ago`;
  return formatCentralDate(date, { month: "short", day: "numeric" });
}

function changeTypeLabel(value: unknown) {
  if (isFirstObservedOfficialDocument(value)) return "New official document";
  const object = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const type = typeof object.change_type === "string" ? object.change_type : "";
  if (/deadline|date/i.test(type)) return "Deadline";
  if (/eligib/i.test(type)) return "Eligibility";
  if (/funding|amount/i.test(type)) return "Funding";
  if (/document|pdf/i.test(type)) return "PDF";
  if (/application|material/i.test(type)) return "Application";
  return "Update";
}
