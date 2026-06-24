import {
  dedupeChangeSummaries,
  displayChangeSummary,
  isUsefulChangeForAward,
} from "@/lib/change-summary";
import type { AwardPageType } from "@/lib/award-discovery-types";
import type { Database, Json } from "@/lib/database.types";
import { isMonitorableOfficialSource } from "@/lib/source-url-policy";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

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

type SharedAwardLookupRow = Pick<
  Database["public"]["Tables"]["shared_awards"]["Row"],
  "id" | "name" | "slug"
>;

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
  const { data: changes } = await admin
    .from("shared_award_change_events")
    .select("id, shared_award_id, shared_award_source_id, source_title, source_url, source_page_type, summary, change_details, detected_at")
    .order("detected_at", { ascending: false })
    .limit(Math.max(limit * 4, 80));

  if (!changes?.length) return [];

  const changeRows = changes as SharedChangeRow[];
  const awardIds = [...new Set(changeRows.map((change) => change.shared_award_id))];
  const { data: awards } = awardIds.length
    ? await admin.from("shared_awards").select("id, name, slug").in("id", awardIds).eq("status", "active")
    : { data: [] as SharedAwardLookupRow[] };
  const awardById = new Map((awards || []).map((award) => [award.id, award]));

  return dedupeChangeSummaries(
    changeRows.filter((change) => {
      const award = awardById.get(change.shared_award_id);
      return (
        Boolean(award) &&
        isMonitorableOfficialSource({ url: change.source_url, page_type: change.source_page_type }) &&
        isUsefulChangeForAward({
          awardName: award?.name,
          sourceTitle: change.source_title,
          sourceUrl: change.source_url,
          summary: change.summary,
          change_details: change.change_details,
        })
      );
    }),
  )
    .slice(0, limit)
    .map((change) => {
      const award = awardById.get(change.shared_award_id);
      return {
        id: change.id,
        awardId: change.shared_award_id,
        awardName: award?.name || "Tracked award",
        awardSlug: award?.slug || null,
        sourceId: change.shared_award_source_id,
        sourceTitle: change.source_title || "Source page",
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
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}

function changeTypeLabel(value: unknown) {
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
