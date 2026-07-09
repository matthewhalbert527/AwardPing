import { canonicalSourceUrlKey } from "@/lib/source-url-policy";
import { isMonitorableAwardSource } from "@/lib/source-quality";
import { isChangeEventSuppressed } from "@/lib/change-event-suppression";

export type OpenSourceReference = {
  id?: string | null;
  url?: string | null;
  title?: string | null;
  display_title?: string | null;
  page_metadata?: unknown;
  page_metadata_generated_at?: string | null;
  page_type?: string | null;
  source?: string | null;
  reason?: string | null;
  submitted_by_user_id?: string | null;
};

export type ChangeSourceReference = {
  shared_award_source_id?: string | null;
  source_url?: string | null;
  change_details?: unknown;
  suppressed_at?: string | null;
  suppression_reason?: string | null;
  suppression_source?: string | null;
};

export function activeChangeSourceFilter(sources: OpenSourceReference[]) {
  const activeSources = sources.filter((source) =>
    sourceHasQualityContext(source) ? isMonitorableAwardSource(source) : true,
  );
  const openSourceIds = new Set(
    activeSources.map((source) => source.id).filter((id): id is string => Boolean(id)),
  );
  const openSourceUrlKeys = new Set(
    activeSources
      .map((source) => canonicalSourceUrlKey(String(source.url || "")))
      .filter(Boolean),
  );

  return (change: ChangeSourceReference) => changeBelongsToOpenSource(change, {
    openSourceIds,
    openSourceUrlKeys,
  });
}

function sourceHasQualityContext(source: OpenSourceReference) {
  return (
    source.page_metadata !== undefined ||
    source.page_metadata_generated_at !== undefined ||
    source.page_type !== undefined ||
    source.source !== undefined ||
    source.reason !== undefined ||
    source.submitted_by_user_id !== undefined
  );
}

export function changeBelongsToOpenSource(
  change: ChangeSourceReference,
  activeSources: {
    openSourceIds: Set<string>;
    openSourceUrlKeys: Set<string>;
  },
) {
  if (isChangeEventSuppressed(change)) return false;

  if (change.shared_award_source_id) {
    return activeSources.openSourceIds.has(change.shared_award_source_id);
  }

  if (!change.source_url) return false;
  return activeSources.openSourceUrlKeys.has(canonicalSourceUrlKey(change.source_url));
}
