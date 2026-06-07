import type { AwardPageType } from "@/lib/award-discovery-types";
import { canonicalSourceUrlKey } from "@/lib/source-url-policy";

export type MergeableWatchlistSource = {
  id: string;
  sharedAwardSourceId: string | null;
  monitorId: string | null;
  monitorSharedAwardSourceId?: string | null;
  title: string;
  url: string;
  pageType: AwardPageType | null;
  status: "active" | "paused" | "error" | "untracked";
  cadence: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
};

export function upsertWatchlistSource<T extends MergeableWatchlistSource>(
  sourcesByKey: Map<string, T>,
  source: T,
) {
  const key = watchlistSourceKey(source.url);
  const existing = sourcesByKey.get(key);
  sourcesByKey.set(key, existing ? mergeWatchlistSources(existing, source) : source);
}

export function watchlistSourceKey(url: string) {
  return canonicalSourceUrlKey(url);
}

function mergeWatchlistSources<T extends MergeableWatchlistSource>(
  existing: T,
  next: T,
): T {
  const tracked = next.monitorId ? next : existing.monitorId ? existing : null;
  const shared = existing.sharedAwardSourceId ? existing : next.sharedAwardSourceId ? next : null;
  const freshest = freshestCheckedSource(existing, next);

  return {
    ...existing,
    id: shared?.sharedAwardSourceId || tracked?.id || existing.id,
    sharedAwardSourceId: existing.sharedAwardSourceId || next.sharedAwardSourceId,
    monitorId: tracked?.monitorId || null,
    monitorSharedAwardSourceId:
      tracked?.monitorSharedAwardSourceId ??
      existing.monitorSharedAwardSourceId ??
      next.monitorSharedAwardSourceId ??
      null,
    title: bestTitle(existing.title, next.title),
    url: preferredUrl(existing.url, next.url),
    pageType: bestPageType(existing.pageType, next.pageType),
    status: tracked?.status || existing.status || next.status,
    cadence: tracked?.cadence || existing.cadence || next.cadence,
    lastCheckedAt: freshest?.lastCheckedAt || null,
    lastError: freshest?.lastError || tracked?.lastError || existing.lastError || next.lastError,
  };
}

function freshestCheckedSource<T extends MergeableWatchlistSource>(left: T, right: T) {
  if (!left.lastCheckedAt) return right.lastCheckedAt ? right : null;
  if (!right.lastCheckedAt) return left;
  return new Date(right.lastCheckedAt).getTime() > new Date(left.lastCheckedAt).getTime()
    ? right
    : left;
}

function bestTitle(left: string, right: string) {
  const leftClean = cleanTitle(left);
  const rightClean = cleanTitle(right);
  if (!leftClean) return rightClean || "Source page";
  if (!rightClean) return leftClean;
  if (isGenericTitle(leftClean) && !isGenericTitle(rightClean)) return rightClean;
  if (isGenericTitle(rightClean) && !isGenericTitle(leftClean)) return leftClean;
  return leftClean.length >= rightClean.length ? leftClean : rightClean;
}

function cleanTitle(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function isGenericTitle(value: string) {
  return /^(source page|homepage|pdf guide|other source)$/i.test(value);
}

function preferredUrl(left: string, right: string) {
  const leftScore = urlPreferenceScore(left);
  const rightScore = urlPreferenceScore(right);
  return rightScore > leftScore ? right : left;
}

function urlPreferenceScore(value: string) {
  try {
    const url = new URL(value);
    let score = url.protocol === "https:" ? 10 : 0;
    if (!url.search) score += 5;
    if (!url.hostname.startsWith("www.")) score += 1;
    return score;
  } catch {
    return 0;
  }
}

function bestPageType(left: AwardPageType | null, right: AwardPageType | null) {
  if (!left) return right;
  if (!right) return left;
  if (left === right) return left;
  if (left === "other") return right;
  if (right === "other") return left;
  if (left === "homepage") return left;
  if (right === "homepage") return right;
  return left;
}
