import { canonicalSourceUrlKey } from "@/lib/source-url-policy";

export type OpenSourceReference = {
  id?: string | null;
  url?: string | null;
};

export type ChangeSourceReference = {
  shared_award_source_id?: string | null;
  source_url?: string | null;
};

export function activeChangeSourceFilter(sources: OpenSourceReference[]) {
  const openSourceIds = new Set(
    sources.map((source) => source.id).filter((id): id is string => Boolean(id)),
  );
  const openSourceUrlKeys = new Set(
    sources
      .map((source) => canonicalSourceUrlKey(String(source.url || "")))
      .filter(Boolean),
  );

  return (change: ChangeSourceReference) => changeBelongsToOpenSource(change, {
    openSourceIds,
    openSourceUrlKeys,
  });
}

export function changeBelongsToOpenSource(
  change: ChangeSourceReference,
  activeSources: {
    openSourceIds: Set<string>;
    openSourceUrlKeys: Set<string>;
  },
) {
  if (change.shared_award_source_id) {
    return activeSources.openSourceIds.has(change.shared_award_source_id);
  }

  if (!change.source_url) return false;
  return activeSources.openSourceUrlKeys.has(canonicalSourceUrlKey(change.source_url));
}
